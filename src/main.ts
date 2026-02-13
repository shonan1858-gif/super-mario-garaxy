import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const PLANET_RADIUS = 100;
const GRAVITY = 28;
const BASE_V_MAX = 10.5;
const DASH_MULTIPLIER = 1.7;
const BASE_A_GROUND = 42;
const BASE_A_AIR = 16;
const BASE_DRAG_GROUND = 8.5;
const BASE_DRAG_AIR = 1.2;
const JUMP_IMPULSES = [7.0, 8.5, 10.0] as const;
const JUMP_BUFFER_TIME = 0.15;
const JUMP_COMBO_WINDOW = 0.7;
const GROUND_RAY_LEN = 1.95;

const app = document.querySelector<HTMLDivElement>('#app')!;
const hud = document.createElement('div');
hud.className = 'hud';
const cross = document.createElement('div');
cross.className = 'crosshair';
const clearMsg = document.createElement('div');
clearMsg.className = 'center-msg';
app.append(hud, cross, clearMsg);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a1727');
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 900);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xaec7ff, 0x203044, 1.25));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(40, 70, 20);
scene.add(dir);

const planetMesh = new THREE.Mesh(
  new THREE.SphereGeometry(PLANET_RADIUS, 64, 64),
  new THREE.MeshStandardMaterial({ color: '#2f6c42', roughness: 1 })
);
scene.add(planetMesh);

// Building props (3)
const buildingLatLng = [
  { lat: 0.35, lng: 0.8 },
  { lat: -0.15, lng: -1.5 },
  { lat: 0.55, lng: 2.2 }
];
for (const [i, ll] of buildingLatLng.entries()) {
  const up = new THREE.Vector3(
    Math.cos(ll.lat) * Math.sin(ll.lng),
    Math.sin(ll.lat),
    Math.cos(ll.lat) * Math.cos(ll.lng)
  ).normalize();
  const h = 7 + i * 1.8;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(3.5, h, 3.5),
    new THREE.MeshStandardMaterial({ color: i === 1 ? '#6f8199' : '#8ea4bf', roughness: 0.9 })
  );
  mesh.position.copy(up.clone().multiplyScalar(PLANET_RADIUS + h * 0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  scene.add(mesh);
}

const goalPos = new THREE.Vector3(0, PLANET_RADIUS + 1, -36).normalize().multiplyScalar(PLANET_RADIUS + 1.4);
const goalMesh = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.55, 16, 56), new THREE.MeshStandardMaterial({ color: '#ffd764' }));
goalMesh.position.copy(goalPos);
goalMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), goalPos.clone().normalize());
scene.add(goalMesh);

// Enemy + boomerang
const enemyUp = new THREE.Vector3(0.42, 0.82, -0.38).normalize();
const enemyAnchor = enemyUp.clone().multiplyScalar(PLANET_RADIUS + 1.8);
const enemyMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(1.0, 1.6, 4, 10),
  new THREE.MeshStandardMaterial({ color: '#6b2fa2' })
);
enemyMesh.position.copy(enemyAnchor);
enemyMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), enemyUp);
scene.add(enemyMesh);

const boomerangMesh = new THREE.Mesh(
  new THREE.TorusGeometry(1.2, 0.18, 8, 20, Math.PI * 1.45),
  new THREE.MeshStandardMaterial({ color: '#ff9234', emissive: '#5b2a00', emissiveIntensity: 0.7 })
);
boomerangMesh.visible = false;
scene.add(boomerangMesh);

let boomerangActive = false;
let boomerangOutward = true;
let boomerangDist = 0;
let boomerangCooldown = 1.6;
let boomerangHitFlash = 0;

const input = new Set<string>();
let jumpBufferTimer = 0;
addEventListener('keydown', (e) => {
  input.add(e.code);
  if (e.code === 'Space') {
    jumpBufferTimer = JUMP_BUFFER_TIME;
  }
  if (e.code === 'KeyR') {
    resetPlayer();
  }
});
addEventListener('keyup', (e) => input.delete(e.code));
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());

let yaw = 0;
let pitch = 0.2;
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0025;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0025, -1.2, 1.2);
});

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
const planetRb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const planetCol = world.createCollider(RAPIER.ColliderDesc.ball(PLANET_RADIUS), planetRb);

const playerRb = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic().setTranslation(0, PLANET_RADIUS + 3.2, 0).setCanSleep(false).lockRotations()
);
world.createCollider(RAPIER.ColliderDesc.capsule(0.9, 0.6).setFriction(0.1), playerRb);

const playerMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.8, 6, 14), new THREE.MeshStandardMaterial({ color: '#d64f4f' }));
scene.add(playerMesh);

let grounded = false;
let wasGrounded = false;
let jumpComboIndex = 0;
let comboTimer = Number.POSITIVE_INFINITY;
let isClear = false;
const fixedDt = 1 / 60;
let prev = performance.now() / 1000;
let acc = 0;

function resetPlayer() {
  isClear = false;
  clearMsg.textContent = '';
  jumpBufferTimer = 0;
  jumpComboIndex = 0;
  comboTimer = Number.POSITIVE_INFINITY;
  playerRb.setTranslation({ x: 0, y: PLANET_RADIUS + 3.2, z: 0 }, true);
  playerRb.setLinvel({ x: 0, y: 0, z: 0 }, true);
}

function projectOnPlane(v: THREE.Vector3, n: THREE.Vector3) {
  return v.clone().sub(n.clone().multiplyScalar(v.dot(n)));
}

function updateBoomerang(dt: number, playerPos: THREE.Vector3, upAtPlayer: THREE.Vector3) {
  boomerangCooldown -= dt;

  const enemyToPlayer = playerPos.clone().sub(enemyAnchor);
  const enemyForward = projectOnPlane(enemyToPlayer, enemyUp).normalize();
  const enemyRight = new THREE.Vector3().crossVectors(enemyForward, enemyUp).normalize();
  enemyMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(enemyRight, enemyUp, enemyForward));

  if (!boomerangActive && boomerangCooldown <= 0) {
    boomerangActive = true;
    boomerangOutward = true;
    boomerangDist = 0;
    boomerangMesh.visible = true;
    boomerangCooldown = 2.5;
  }

  if (!boomerangActive) {
    return;
  }

  const throwDir = enemyForward.lengthSq() > 0.001 ? enemyForward : new THREE.Vector3(0, 0, 1);
  const travelSpeed = 26;
  boomerangDist += (boomerangOutward ? 1 : -1) * travelSpeed * dt;
  boomerangDist = THREE.MathUtils.clamp(boomerangDist, 0, 14);
  if (boomerangDist >= 14) boomerangOutward = false;
  if (boomerangDist <= 0) {
    boomerangActive = false;
    boomerangMesh.visible = false;
    return;
  }

  const boomerangPos = enemyAnchor.clone().add(throwDir.multiplyScalar(boomerangDist));
  boomerangMesh.position.copy(boomerangPos);
  boomerangMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), enemyUp);
  boomerangMesh.rotateOnAxis(enemyUp, performance.now() * 0.025);

  const distToPlayer = boomerangPos.distanceTo(playerPos);
  if (distToPlayer < 1.7) {
    boomerangHitFlash = 0.15;
    const push = projectOnPlane(playerPos.clone().sub(boomerangPos), upAtPlayer).normalize().multiplyScalar(8);
    const current = playerRb.linvel();
    playerRb.setLinvel({ x: current.x + push.x, y: current.y + push.y, z: current.z + push.z }, true);
  }
}

function physicsStep(dt: number) {
  const p = playerRb.translation();
  const pos = new THREE.Vector3(p.x, p.y, p.z);
  const up = pos.clone().normalize();
  const down = up.clone().multiplyScalar(-1);

  const hit = world.castRay(new RAPIER.Ray(p, { x: down.x, y: down.y, z: down.z }), GROUND_RAY_LEN, true, undefined, undefined, planetCol, undefined);
  grounded = !!hit;

  if (grounded && !wasGrounded) {
    comboTimer = 0;
  }
  if (grounded) {
    comboTimer += dt;
  }
  if (comboTimer > JUMP_COMBO_WINDOW) {
    jumpComboIndex = 0;
  }
  if (jumpBufferTimer > 0) {
    jumpBufferTimer -= dt;
  }

  const vel = playerRb.linvel();
  const v = new THREE.Vector3(vel.x, vel.y, vel.z);
  v.addScaledVector(down, GRAVITY * dt);

  if (!isClear) {
    const moveX = (input.has('KeyD') ? 1 : 0) - (input.has('KeyA') ? 1 : 0);
    const moveZ = (input.has('KeyW') ? 1 : 0) - (input.has('KeyS') ? 1 : 0);
    const dashing = input.has('ShiftLeft') || input.has('ShiftRight');

    const camForwardRaw = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const forward = projectOnPlane(camForwardRaw, up).normalize();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const wish = forward.multiplyScalar(moveZ).add(right.multiplyScalar(moveX));
    if (wish.lengthSq() > 0) wish.normalize();

    const vMax = BASE_V_MAX * (dashing ? DASH_MULTIPLIER : 1);
    const aGround = BASE_A_GROUND * (dashing ? 1.2 : 1);
    const aAir = BASE_A_AIR * (dashing ? 1.1 : 1);
    const dragGround = BASE_DRAG_GROUND * (dashing ? 0.8 : 1);
    const dragAir = BASE_DRAG_AIR;

    const vTan = projectOnPlane(v, up);
    const vNorm = v.clone().sub(vTan);
    const vTarget = wish.multiplyScalar(vMax);
    const dv = vTarget.sub(vTan);
    const maxDelta = (grounded ? aGround : aAir) * dt;
    if (dv.length() > maxDelta) dv.setLength(maxDelta);

    const drag = grounded ? dragGround : dragAir;
    const vTanNew = vTan.add(dv).multiplyScalar(Math.max(0, 1 - drag * dt));
    v.copy(vTanNew.add(vNorm));

    playerRb.setLinvel(v, true);
    if (grounded && jumpBufferTimer > 0) {
      if (comboTimer > JUMP_COMBO_WINDOW) {
        jumpComboIndex = 0;
      }

      const impulse = JUMP_IMPULSES[jumpComboIndex];
      playerRb.applyImpulse({ x: up.x * impulse, y: up.y * impulse, z: up.z * impulse }, true);
      grounded = false;
      jumpBufferTimer = 0;
      comboTimer = Number.POSITIVE_INFINITY;
      jumpComboIndex = jumpComboIndex >= JUMP_IMPULSES.length - 1 ? 0 : jumpComboIndex + 1;
    }
  } else {
    playerRb.setLinvel(v, true);
  }

  world.step();
  wasGrounded = grounded;

  const pNow = playerRb.translation();
  const dist = Math.hypot(pNow.x, pNow.y, pNow.z);
  if (dist > PLANET_RADIUS + 60) resetPlayer();

  const playerNow = new THREE.Vector3(pNow.x, pNow.y, pNow.z);
  updateBoomerang(dt, playerNow, playerNow.clone().normalize());

  if (!isClear && playerNow.distanceTo(goalPos) < 4.2) {
    isClear = true;
    clearMsg.textContent = 'CLEAR! Press R to Restart';
  }
}

function render() {
  const p = playerRb.translation();
  const pos = new THREE.Vector3(p.x, p.y, p.z);
  const up = pos.clone().normalize();

  playerMesh.position.copy(pos);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  playerMesh.quaternion.slerp(q, 0.2);

  if (boomerangHitFlash > 0) {
    boomerangHitFlash -= fixedDt;
    (playerMesh.material as THREE.MeshStandardMaterial).emissive.set('#772222');
  } else {
    (playerMesh.material as THREE.MeshStandardMaterial).emissive.set('#000000');
  }

  const forward = projectOnPlane(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), up).normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const camDir = forward.clone().applyAxisAngle(right, pitch).normalize();
  camera.position.copy(pos).add(up.clone().multiplyScalar(3.8)).add(camDir.multiplyScalar(-18));
  camera.up.copy(up);
  camera.lookAt(pos.clone().add(up.clone().multiplyScalar(1.6)));

  const speed = projectOnPlane(new THREE.Vector3(playerRb.linvel().x, playerRb.linvel().y, playerRb.linvel().z), up).length();
  const dashing = input.has('ShiftLeft') || input.has('ShiftRight');
  hud.innerHTML = `Speed: ${speed.toFixed(2)} m/s<br/>Grounded: ${grounded}<br/>JumpCombo: ${jumpComboIndex + 1}<br/>Dash: ${dashing ? 'ON' : 'OFF'}`;
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function loop() {
  const now = performance.now() / 1000;
  const dt = Math.min(0.05, now - prev);
  prev = now;
  acc += dt;
  while (acc >= fixedDt) {
    physicsStep(fixedDt);
    acc -= fixedDt;
  }
  render();
  requestAnimationFrame(loop);
}

loop();
