import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const PLANET_RADIUS = 50;
const GRAVITY = 25;
const V_MAX = 9;
const A_GROUND = 45;
const A_AIR = 18;
const DRAG_GROUND = 10;
const DRAG_AIR = 1.5;
const JUMP_SPEED = 10.5;

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
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 500);
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

const goalPos = new THREE.Vector3(0, PLANET_RADIUS + 1, -18).normalize().multiplyScalar(PLANET_RADIUS + 0.8);
const goalMesh = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.45, 16, 48), new THREE.MeshStandardMaterial({ color: '#ffd764' }));
goalMesh.position.copy(goalPos);
goalMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), goalPos.clone().normalize());
scene.add(goalMesh);

const input = new Set<string>();
addEventListener('keydown', (e) => {
  input.add(e.code);
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
const planetRb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const planetCol = world.createCollider(RAPIER.ColliderDesc.ball(PLANET_RADIUS), planetRb);

const playerRb = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic().setTranslation(0, PLANET_RADIUS + 2.5, 0).setCanSleep(false).lockRotations()
);
world.createCollider(RAPIER.ColliderDesc.capsule(0.9, 0.6).setFriction(0.1), playerRb);

const playerMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.8, 6, 14), new THREE.MeshStandardMaterial({ color: '#d64f4f' }));
scene.add(playerMesh);

let grounded = false;
let jumpLock = 0;
let isClear = false;
const fixedDt = 1 / 60;
let prev = performance.now() / 1000;
let acc = 0;

function resetPlayer() {
  isClear = false;
  clearMsg.textContent = '';
  playerRb.setTranslation({ x: 0, y: PLANET_RADIUS + 2.5, z: 0 }, true);
  playerRb.setLinvel({ x: 0, y: 0, z: 0 }, true);
}

function projectOnPlane(v: THREE.Vector3, n: THREE.Vector3) {
  return v.clone().sub(n.clone().multiplyScalar(v.dot(n)));
}

function physicsStep(dt: number) {
  const p = playerRb.translation();
  const pos = new THREE.Vector3(p.x, p.y, p.z);
  const up = pos.clone().normalize();
  const down = up.clone().multiplyScalar(-1);

  const hit = world.castRay(new RAPIER.Ray(p, { x: down.x, y: down.y, z: down.z }), 1.7, true, undefined, undefined, planetCol, undefined);
  grounded = !!hit;

  const vel = playerRb.linvel();
  const v = new THREE.Vector3(vel.x, vel.y, vel.z);
  v.addScaledVector(down, GRAVITY * dt);

  if (!isClear) {
    const moveX = (input.has('KeyD') ? 1 : 0) - (input.has('KeyA') ? 1 : 0);
    const moveZ = (input.has('KeyW') ? 1 : 0) - (input.has('KeyS') ? 1 : 0);

    const camForwardRaw = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const forward = projectOnPlane(camForwardRaw, up).normalize();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const wish = forward.multiplyScalar(moveZ).add(right.multiplyScalar(moveX));
    if (wish.lengthSq() > 0) wish.normalize();

    const vTan = projectOnPlane(v, up);
    const vNorm = v.clone().sub(vTan);
    const vTarget = wish.multiplyScalar(V_MAX);
    const dv = vTarget.sub(vTan);
    const maxDelta = (grounded ? A_GROUND : A_AIR) * dt;
    if (dv.length() > maxDelta) dv.setLength(maxDelta);

    const drag = grounded ? DRAG_GROUND : DRAG_AIR;
    const vTanNew = vTan.add(dv).multiplyScalar(Math.max(0, 1 - drag * dt));
    v.copy(vTanNew.add(vNorm));

    if (jumpLock > 0) jumpLock -= dt;
    if (grounded && jumpLock <= 0 && input.has('Space')) {
      v.addScaledVector(up, JUMP_SPEED);
      jumpLock = 0.1;
      grounded = false;
    }
  }

  playerRb.setLinvel(v, true);
  world.step();

  const pNow = playerRb.translation();
  const dist = Math.hypot(pNow.x, pNow.y, pNow.z);
  if (dist > PLANET_RADIUS + 30) resetPlayer();

  const playerNow = new THREE.Vector3(pNow.x, pNow.y, pNow.z);
  if (!isClear && playerNow.distanceTo(goalPos) < 3.2) {
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

  const forward = projectOnPlane(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), up).normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const camDir = forward.clone().applyAxisAngle(right, pitch).normalize();
  camera.position.copy(pos).add(up.clone().multiplyScalar(2.5)).add(camDir.multiplyScalar(-11));
  camera.up.copy(up);
  camera.lookAt(pos.clone().add(up.clone().multiplyScalar(1.1)));

  const speed = projectOnPlane(new THREE.Vector3(playerRb.linvel().x, playerRb.linvel().y, playerRb.linvel().z), up).length();
  hud.innerHTML = `Speed: ${speed.toFixed(2)} m/s<br/>Grounded: ${grounded}`;
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
