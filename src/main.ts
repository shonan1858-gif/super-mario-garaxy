import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const PLANET_RADIUS = 100;
const GRAVITY = 28;
const BASE_SPEED = 10.5;
const DASH_MULTIPLIER = 1.75;
const BASE_ACCEL_GROUND = 34;
const BASE_ACCEL_AIR = 13;
const BASE_DRAG_GROUND = 7.2;
const BASE_DRAG_AIR = 0.9;

const JUMP_IMPULSES = [7.0, 8.5, 10.0] as const;
const JUMP_COMBO_WINDOW = 0.7;
const GROUND_RAY_LEN = 2.3;

const BOOMERANG_COOLDOWN = 2.0;
const BOOMERANG_MAX_DIST = 16;
const BOOMERANG_SPEED = 24;
const BOOMERANG_HIT_RADIUS = 1.8;

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

scene.add(new THREE.HemisphereLight(0xaec7ff, 0x203044, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.25);
sun.position.set(40, 70, 20);
scene.add(sun);

const planetMesh = new THREE.Mesh(
  new THREE.SphereGeometry(PLANET_RADIUS, 64, 64),
  new THREE.MeshStandardMaterial({ color: '#2f6c42', roughness: 1 })
);
scene.add(planetMesh);

const goalPos = new THREE.Vector3(0, PLANET_RADIUS + 1, -36).normalize().multiplyScalar(PLANET_RADIUS + 1.4);
const goalMesh = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.55, 16, 56), new THREE.MeshStandardMaterial({ color: '#ffd764' }));
goalMesh.position.copy(goalPos);
goalMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), goalPos.clone().normalize());
scene.add(goalMesh);

const enemyUp = new THREE.Vector3(0.45, 0.75, -0.48).normalize();
const enemyAnchor = enemyUp.clone().multiplyScalar(PLANET_RADIUS + 1.6);
const enemyMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.9, 1.7, 4, 12),
  new THREE.MeshStandardMaterial({ color: '#6a2ecf', roughness: 0.45 })
);
enemyMesh.position.copy(enemyAnchor);
enemyMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), enemyUp);
scene.add(enemyMesh);

const boomerangMesh = new THREE.Mesh(
  new THREE.TorusGeometry(1.2, 0.18, 10, 28, Math.PI * 1.45),
  new THREE.MeshStandardMaterial({ color: '#ff9c45', emissive: '#5a2f07', emissiveIntensity: 0.65 })
);
boomerangMesh.visible = false;
scene.add(boomerangMesh);

const input = new Set<string>();
let jumpRequested = false;
addEventListener('keydown', (e) => {
  input.add(e.code);
  if (e.code === 'Space') jumpRequested = true;
  if (e.code === 'KeyR') resetPlayer();
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
world.createCollider(RAPIER.ColliderDesc.ball(PLANET_RADIUS), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));

const playerRb = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic().setTranslation(0, PLANET_RADIUS + 3.2, 0).setCanSleep(false).lockRotations()
);
world.createCollider(RAPIER.ColliderDesc.capsule(0.9, 0.6).setFriction(0.1), playerRb);

const playerMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.6, 1.8, 6, 14),
  new THREE.MeshStandardMaterial({ color: '#d64f4f' })
);
scene.add(playerMesh);

let grounded = false;
let wasGrounded = false;
let jumpComboIndex = 0;
let comboTimer = Number.POSITIVE_INFINITY;
let isClear = false;
let hitFlash = 0;
let smoothedInputX = 0;
let smoothedInputZ = 0;

let boomerangActive = false;
let boomerangOutward = true;
let boomerangDistance = 0;
let boomerangCooldown = 1.1;

const fixedDt = 1 / 60;
let prev = performance.now() / 1000;
let acc = 0;

function surfaceUpFromLatLng(lat: number, lng: number): THREE.Vector3 {
  return new THREE.Vector3(
    Math.cos(lat) * Math.sin(lng),
    Math.sin(lat),
    Math.cos(lat) * Math.cos(lng)
  ).normalize();
}

function spawnSurfaceProps() {
  const propSpecs = [
    { type: 'rock', lat: 0.16, lng: -1.5, s: 2.0 },
    { type: 'rock', lat: -0.3, lng: 2.2, s: 2.4 },
    { type: 'rock', lat: 0.62, lng: 0.6, s: 1.8 },
    { type: 'rock', lat: -0.52, lng: -2.2, s: 2.1 },
    { type: 'pillar', lat: 0.72, lng: 1.45, h: 8.2, r: 1.0 },
    { type: 'pillar', lat: -0.36, lng: -0.35, h: 6.8, r: 1.2 },
    { type: 'pillar', lat: 0.25, lng: 2.72, h: 7.6, r: 0.95 },
    // Buildings: clearly separated and rideable flat tops
    { type: 'building', lat: 0.02, lng: 0.9, h: 9.8, w: 4.8, d: 4.8, c: '#8ea4bf' },
    { type: 'building', lat: -0.14, lng: 0.36, h: 8.9, w: 4.2, d: 4.6, c: '#9fb6d1' },
    { type: 'building', lat: 0.21, lng: 1.36, h: 10.8, w: 4.6, d: 4.2, c: '#8398b3' },
    { type: 'building', lat: -0.6, lng: -1.05, h: 7.4, w: 3.5, d: 3.2, c: '#7f95af' }
  ] as const;

  for (const prop of propSpecs) {
    const up = surfaceUpFromLatLng(prop.lat, prop.lng);
    const alignToNormal = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

    if (prop.type === 'rock') {
      const radius = prop.s * 0.5;
      const mesh = new THREE.Mesh(
        new THREE.DodecahedronGeometry(radius, 0),
        new THREE.MeshStandardMaterial({ color: '#7f7f7f', roughness: 1 })
      );
      mesh.position.copy(up.clone().multiplyScalar(PLANET_RADIUS + radius * 0.92));
      mesh.quaternion.copy(alignToNormal);
      scene.add(mesh);

      const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(mesh.position.x, mesh.position.y, mesh.position.z));
      world.createCollider(RAPIER.ColliderDesc.ball(radius * 0.92), rb);
      continue;
    }

    if (prop.type === 'pillar') {
      const halfHeight = prop.h * 0.5;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(prop.r, prop.r * 1.12, prop.h, 10),
        new THREE.MeshStandardMaterial({ color: '#9d8f77', roughness: 0.95 })
      );
      mesh.position.copy(up.clone().multiplyScalar(PLANET_RADIUS + halfHeight));
      mesh.quaternion.copy(alignToNormal);
      scene.add(mesh);

      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
          .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w })
      );
      world.createCollider(RAPIER.ColliderDesc.cuboid(prop.r * 1.02, halfHeight, prop.r * 1.02), rb);
      continue;
    }

    const halfHeight = prop.h * 0.5;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(prop.w, prop.h, prop.d),
      new THREE.MeshStandardMaterial({ color: prop.c, roughness: 0.88 })
    );
    mesh.position.copy(up.clone().multiplyScalar(PLANET_RADIUS + halfHeight));
    mesh.quaternion.copy(alignToNormal);
    scene.add(mesh);

    const rb = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
        .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w })
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(prop.w * 0.5, halfHeight, prop.d * 0.5), rb);
  }
}

spawnSurfaceProps();

function resetPlayer() {
  isClear = false;
  clearMsg.textContent = '';
  jumpRequested = false;
  jumpComboIndex = 0;
  comboTimer = Number.POSITIVE_INFINITY;
  smoothedInputX = 0;
  smoothedInputZ = 0;
  playerRb.setTranslation({ x: 0, y: PLANET_RADIUS + 3.2, z: 0 }, true);
  playerRb.setLinvel({ x: 0, y: 0, z: 0 }, true);
}

function projectOnPlane(v: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 {
  return v.clone().sub(n.clone().multiplyScalar(v.dot(n)));
}

function updateEnemyAndBoomerang(dt: number, playerPos: THREE.Vector3, upAtPlayer: THREE.Vector3) {
  boomerangCooldown -= dt;

  const enemyToPlayer = playerPos.clone().sub(enemyAnchor);
  const tangentForward = projectOnPlane(enemyToPlayer, enemyUp);
  if (tangentForward.lengthSq() > 0.0001) {
    tangentForward.normalize();
    const tangentRight = new THREE.Vector3().crossVectors(tangentForward, enemyUp).normalize();
    enemyMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangentRight, enemyUp, tangentForward));
  }

  if (!boomerangActive && boomerangCooldown <= 0) {
    boomerangActive = true;
    boomerangOutward = true;
    boomerangDistance = 0;
    boomerangCooldown = BOOMERANG_COOLDOWN;
    boomerangMesh.visible = true;
  }

  if (!boomerangActive) return;

  const throwDir = tangentForward.lengthSq() > 0.0001 ? tangentForward : new THREE.Vector3(0, 0, 1);
  boomerangDistance += (boomerangOutward ? 1 : -1) * BOOMERANG_SPEED * dt;
  boomerangDistance = THREE.MathUtils.clamp(boomerangDistance, 0, BOOMERANG_MAX_DIST);

  if (boomerangDistance >= BOOMERANG_MAX_DIST) boomerangOutward = false;
  if (boomerangDistance <= 0) {
    boomerangActive = false;
    boomerangMesh.visible = false;
    return;
  }

  const boomerangPos = enemyAnchor.clone().add(throwDir.multiplyScalar(boomerangDistance));
  boomerangMesh.position.copy(boomerangPos);
  boomerangMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), enemyUp);
  boomerangMesh.rotateOnAxis(enemyUp, performance.now() * 0.03);

  if (boomerangPos.distanceTo(playerPos) < BOOMERANG_HIT_RADIUS) {
    hitFlash = 0.12;
    const push = projectOnPlane(playerPos.clone().sub(boomerangPos), upAtPlayer).normalize().multiplyScalar(8.5);
    const linvel = playerRb.linvel();
    playerRb.setLinvel({ x: linvel.x + push.x, y: linvel.y + push.y, z: linvel.z + push.z }, true);
  }
}

function physicsStep(dt: number) {
  const p = playerRb.translation();
  const pos = new THREE.Vector3(p.x, p.y, p.z);
  const up = pos.clone().normalize();
  const down = up.clone().multiplyScalar(-1);

  const ray = new RAPIER.Ray(p, { x: down.x, y: down.y, z: down.z });
  grounded = !!world.castRay(ray, GROUND_RAY_LEN, true);

  if (grounded && !wasGrounded) comboTimer = 0;
  if (grounded) comboTimer += dt;
  if (comboTimer > JUMP_COMBO_WINDOW) jumpComboIndex = 0;

  const lv = playerRb.linvel();
  const velocity = new THREE.Vector3(lv.x, lv.y, lv.z);
  velocity.addScaledVector(down, GRAVITY * dt);

  if (!isClear) {
    const targetInputX = (input.has('KeyD') ? 1 : 0) - (input.has('KeyA') ? 1 : 0);
    const targetInputZ = (input.has('KeyW') ? 1 : 0) - (input.has('KeyS') ? 1 : 0);
    const smooth = 1 - Math.exp(-10 * dt);
    smoothedInputX = THREE.MathUtils.lerp(smoothedInputX, targetInputX, smooth);
    smoothedInputZ = THREE.MathUtils.lerp(smoothedInputZ, targetInputZ, smooth);
    const dashing = input.has('ShiftLeft') || input.has('ShiftRight');

    const camForward = projectOnPlane(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), up).normalize();
    const camRight = new THREE.Vector3().crossVectors(camForward, up).normalize();
    const wishDir = camForward.multiplyScalar(smoothedInputZ).add(camRight.multiplyScalar(smoothedInputX));
    if (wishDir.lengthSq() > 0) wishDir.normalize();

    const speedCap = BASE_SPEED * (dashing ? DASH_MULTIPLIER : 1);
    const accelGround = BASE_ACCEL_GROUND * (dashing ? 1.22 : 1);
    const accelAir = BASE_ACCEL_AIR * (dashing ? 1.08 : 1);
    const dragGround = BASE_DRAG_GROUND * (dashing ? 0.82 : 1);

    const tangentialVel = projectOnPlane(velocity, up);
    const normalVel = velocity.clone().sub(tangentialVel);
    const targetVel = wishDir.multiplyScalar(speedCap);
    const deltaVel = targetVel.sub(tangentialVel);
    const maxDelta = (grounded ? accelGround : accelAir) * dt;
    if (deltaVel.length() > maxDelta) deltaVel.setLength(maxDelta);

    const drag = grounded ? dragGround : BASE_DRAG_AIR;
    const tangentialNew = tangentialVel.add(deltaVel).multiplyScalar(Math.max(0, 1 - drag * dt));
    velocity.copy(tangentialNew.add(normalVel));

    playerRb.setLinvel(velocity, true);

    if (grounded && jumpRequested) {
      if (comboTimer > JUMP_COMBO_WINDOW) jumpComboIndex = 0;
      const jumpImpulse = JUMP_IMPULSES[jumpComboIndex];
      playerRb.applyImpulse({ x: up.x * jumpImpulse, y: up.y * jumpImpulse, z: up.z * jumpImpulse }, true);
      grounded = false;
      comboTimer = Number.POSITIVE_INFINITY;
      jumpComboIndex = jumpComboIndex >= JUMP_IMPULSES.length - 1 ? 0 : jumpComboIndex + 1;
    }
    // ジャンプ後、着地まで入力無効
    if (jumpRequested && !grounded) {
      jumpRequested = false;
    }
  } else {
    playerRb.setLinvel(velocity, true);
  }

  world.step();
  wasGrounded = grounded;

  const nowPos = playerRb.translation();
  const playerNow = new THREE.Vector3(nowPos.x, nowPos.y, nowPos.z);

  if (playerNow.length() > PLANET_RADIUS + 60) resetPlayer();
  updateEnemyAndBoomerang(dt, playerNow, playerNow.clone().normalize());

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
  const playerUpQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  playerMesh.quaternion.slerp(playerUpQ, 0.2);

  if (hitFlash > 0) {
    hitFlash -= fixedDt;
    (playerMesh.material as THREE.MeshStandardMaterial).emissive.set('#8a2626');
  } else {
    (playerMesh.material as THREE.MeshStandardMaterial).emissive.set('#000000');
  }

  const cameraForward = projectOnPlane(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), up).normalize();
  const cameraRight = new THREE.Vector3().crossVectors(cameraForward, up).normalize();
  const camDir = cameraForward.clone().applyAxisAngle(cameraRight, pitch).normalize();
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
