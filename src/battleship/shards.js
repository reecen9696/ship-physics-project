import {
  BufferGeometry, BufferAttribute, InstancedMesh, MeshBasicNodeMaterial,
  InstancedBufferAttribute, DynamicDrawUsage, Matrix4, Quaternion, Vector3, Object3D,
} from 'three/webgpu';
import {
  Fn, vec3, vec4, float, normalize, dot, saturate, max, mix, pow,
  cameraPosition, positionWorld, normalWorld, instancedBufferAttribute,
} from 'three/tsl';
import { skyColor } from '../ocean/sky.js';

// The plating that used to be where the hole is.
//
// A crater that simply appears reads as a decal. What sells it as *removal* is
// that the metal goes somewhere: a burst throws a few dozen pieces of torn
// plate out along the blast, still glowing at the edges, tumbling flat-side-on
// because that is what a thin plate does in air, and they go into the sea.
//
// One instanced draw call for the lot, on a small program of its own. It cannot
// share the ship's material — that one looks up a per-object matrix to find its
// place in the damage field, which is exactly the thing a per-instance transform
// makes meaningless — and the shading a 40 cm piece of steel needs at fifty
// metres is four lines anyway.

const GRAVITY = 9.81;
const _m = new Matrix4();
const _pos = new Vector3();
const _q = new Quaternion();
const _dq = new Quaternion();
const _scale = new Vector3(1, 1, 1);
const _axis = new Vector3();
const _dummy = new Object3D();

// A torn chunk of plate: flat, irregular, and with a bit of curl in it. Three
// of these at different aspect ratios would be nicer; one, randomly scaled per
// instance, is indistinguishable at the size these are seen at.
function shardGeometry() {
  const pts = [
    [-0.5, 0, -0.42], [0.55, 0, -0.3], [0.42, 0.06, 0.5], [-0.46, 0.03, 0.38],
    [-0.5, -0.05, -0.42], [0.55, -0.05, -0.3], [0.42, -0.02, 0.5], [-0.46, -0.04, 0.38],
  ];
  const idx = [
    0, 1, 2, 0, 2, 3, // face
    6, 5, 4, 7, 6, 4, // back
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts.flat()), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createShards({ shading, count = 320 }) {
  const geometry = shardGeometry();

  // per-instance: how hot the piece still is
  const heatAttr = new InstancedBufferAttribute(new Float32Array(count), 1);
  heatAttr.setUsage(DynamicDrawUsage);
  const heat = instancedBufferAttribute(heatAttr);

  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const N = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(positionWorld));
    const ndl = saturate(dot(N, shading.sunDir));
    // torn steel: dark, rough, no paint on it anywhere
    const base = vec3(0.20, 0.198, 0.192);
    const sky = skyColor(normalize(vec3(N.x, max(N.y, -0.2), N.z)), shading, float(1));
    const amb = mix(shading.horizon, sky, 0.4).mul(0.5);
    const lit = base.mul(shading.sunColor.mul(ndl).add(amb)).toVar();
    // a plate edge stays visibly hot for a second or two after it leaves
    const fres = pow(float(1).sub(saturate(dot(N, V))), 3);
    lit.addAssign(vec3(1.4, 0.36, 0.06).mul(heat.mul(heat)).mul(fres.mul(0.6).add(0.4)));
    return vec4(lit, 1);
  })();

  const mesh = new InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.name = 'ship.shards';
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);

  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const spin = new Float32Array(count * 3);
  const quat = new Float32Array(count * 4);
  const size = new Float32Array(count);
  const life = new Float32Array(count);
  // 1 once the piece is under the surface. It does not stop existing there —
  // it goes in, slows to nothing, and drifts down out of sight behind the
  // ocean, which draws last and writes depth. Cutting it at the waterline
  // instead is a row of forty pieces of steel blinking out along a line, which
  // is the one thing the eye does catch.
  const wet = new Uint8Array(count);
  let cursor = 0;
  let alive = 0;

  // park them all outside the world to start
  for (let i = 0; i < count; i++) {
    _dummy.position.set(0, -1e5, 0);
    _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
    quat[i * 4 + 3] = 1;
  }
  mesh.instanceMatrix.needsUpdate = true;

  // `dir` is the way the blast went; pieces come off in a cone about it plus a
  // good deal of scatter, because a plate does not tear tidily.
  function burst(origin, dir, n, { speed = 22, spread = 0.8, scale = 1, hot = 1 } = {}) {
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % count;
      if (life[i] <= 0) alive++;
      const j = i * 3;
      pos[j] = origin.x; pos[j + 1] = origin.y; pos[j + 2] = origin.z;
      const sp = speed * (0.35 + Math.random() * 1.1);
      vel[j] = (dir.x + (Math.random() - 0.5) * spread * 2) * sp;
      vel[j + 1] = (dir.y + (Math.random() - 0.5) * spread * 2 + 0.55) * sp;
      vel[j + 2] = (dir.z + (Math.random() - 0.5) * spread * 2) * sp;
      spin[j] = (Math.random() - 0.5) * 16;
      spin[j + 1] = (Math.random() - 0.5) * 16;
      spin[j + 2] = (Math.random() - 0.5) * 16;
      const q = i * 4;
      quat[q] = 0; quat[q + 1] = 0; quat[q + 2] = 0; quat[q + 3] = 1;
      size[i] = scale * (0.5 + Math.random() * 1.4);
      life[i] = 3.5 + Math.random() * 3.0;
      wet[i] = 0;
      heatAttr.array[i] = hot * (0.5 + Math.random() * 0.5);
    }
  }

  function update(dt, seaHeight = 0) {
    if (alive === 0) return;
    alive = 0;
    for (let i = 0; i < count; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        _dummy.position.set(0, -1e5, 0);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        continue;
      }
      alive++;
      const j = i * 3;
      // Torn plate in water: it keeps almost nothing of what it arrived with.
      // Above the surface a thin plate still has a lot of drag for its mass,
      // which is why shrapnel does not travel like a cannonball.
      const sank = wet[i] === 1;
      vel[j + 1] -= (sank ? 1.1 : GRAVITY) * dt;
      const d = 1 / (1 + (sank ? 5.0 : 1.15) * dt);
      vel[j] *= d; vel[j + 1] *= d; vel[j + 2] *= d;
      pos[j] += vel[j] * dt;
      pos[j + 1] += vel[j + 1] * dt;
      pos[j + 2] += vel[j + 2] * dt;

      const q = i * 4;
      _q.set(quat[q], quat[q + 1], quat[q + 2], quat[q + 3]);
      _axis.set(spin[j] * dt * 0.5, spin[j + 1] * dt * 0.5, spin[j + 2] * dt * 0.5);
      _dq.set(_axis.x, _axis.y, _axis.z, 1).normalize();
      _q.premultiply(_dq);
      quat[q] = _q.x; quat[q + 1] = _q.y; quat[q + 2] = _q.z; quat[q + 3] = _q.w;

      heatAttr.array[i] *= 1 / (1 + (sank ? 40 : 1.4) * dt);

      if (!sank && pos[j + 1] < seaHeight) {
        wet[i] = 1;
        // it goes in, and the water has it
        spin[j] *= 0.2; spin[j + 1] *= 0.2; spin[j + 2] *= 0.2;
        if (life[i] > 1.2) life[i] = 1.2;
      }

      _pos.set(pos[j], pos[j + 1], pos[j + 2]);
      _scale.setScalar(size[i]);
      _m.compose(_pos, _q, _scale);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    heatAttr.needsUpdate = true;
  }

  function clear() {
    life.fill(0);
    wet.fill(0);
    heatAttr.array.fill(0);
    for (let i = 0; i < count; i++) {
      _dummy.position.set(0, -1e5, 0);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    heatAttr.needsUpdate = true;
    alive = 0;
  }

  return { mesh, burst, update, clear, get aliveCount() { return alive; } };
}
