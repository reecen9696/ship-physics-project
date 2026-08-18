import {
  CylinderGeometry, InstancedMesh, MeshBasicNodeMaterial,
  DynamicDrawUsage, Matrix4, Quaternion, Vector3, Object3D,
} from 'three/webgpu';
import {
  Fn, vec3, vec4, float, normalize, dot, saturate, max, mix, pow,
  cameraPosition, positionWorld, normalWorld,
} from 'three/tsl';
import { skyColor } from '../ocean/sky.js';

// The brass on the deck.
//
// An automatic gun throws away most of its own weight in cartridge cases while
// it fires, and this is the single cheapest thing that separates one from a
// rifle that happens to fire quickly. A 16-inch gun's case is handled by four
// men and struck below; a 40 mm's is flung out of the breech at head height, at
// eight or nine a second, and it bounces off the plating with a noise the whole
// ship can hear. You do not need to be told the gun is firing quickly if there
// is a fountain of brass coming out of the side of it.
//
// --- why these are in the ship's frame, and the shards are not ---------------
//
// `shards.js` is the same machine — an instanced pool, ballistic, tumbling — and
// it works in world space, because a piece of plating blown off a battleship
// stops being part of her the instant it leaves.
//
// A cartridge case does not. It leaves the breech, it goes up two metres, and it
// lands on the deck it was fired from — and that deck is making twenty knots.
// In world space every case would be left hanging in the air astern the moment
// she was under way, which is what actually happens if you try it. So the mesh
// is a child of the hull and every case is integrated in her frame: gravity
// straight down her own y, a floor at the height of the tub, and they land where
// they were thrown.
//
// It is a small lie — her frame is accelerating, so a case in the air is not
// really following a parabola in it — and it is the right one at this scale.
// Three seconds of flight against a hull that rolls in twelve gets you a few
// centimetres, and against that the alternative is brass raining into the sea a
// hundred metres astern.

const GRAVITY = 9.81;
const _m = new Matrix4();
const _pos = new Vector3();
const _q = new Quaternion();
const _dq = new Quaternion();
const _axis = new Vector3();
const _scale = new Vector3(1, 1, 1);
const _dummy = new Object3D();

// A cartridge case: a straight-walled brass tube, closed at one end, about a
// third of a metre long and five centimetres across. Eight sides rather than
// sixteen — at the size these are seen at, the extra ring of triangles buys
// nothing and there are ninety-odd of them on the screen.
function caseGeometry() {
  const g = new CylinderGeometry(0.026, 0.023, 0.30, 8, 1, false);
  g.rotateX(Math.PI / 2); // lying along its own +z, which is how it is thrown
  return g;
}

export function createSpentCases({ shading, count = 96 }) {
  const geometry = caseGeometry();

  // Brass, and it has to read as brass rather than as small grey rubbish: a
  // warm yellow base, a hard specular off the shoulder because a drawn case is
  // polished, and enough sky in the shadow side that one tumbling against a
  // dark sea still catches the eye.
  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const N = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(positionWorld));
    const ndl = saturate(dot(N, shading.sunDir));
    const base = vec3(0.62, 0.46, 0.16);
    const sky = skyColor(normalize(vec3(N.x, max(N.y, -0.2), N.z)), shading, float(1));
    const amb = mix(shading.horizon, sky, 0.45).mul(0.55);
    const lit = base.mul(shading.sunColor.mul(ndl).add(amb)).toVar();
    // the highlight that says "turned metal" — tight, and it is what makes a
    // case tumbling in the air flicker rather than fade
    const spec = pow(saturate(dot(N, shading.sunDir)), float(22)).mul(0.85);
    lit.addAssign(shading.sunColor.mul(spec));
    return vec4(lit, 1);
  })();

  const mesh = new InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.name = 'ship.cases';
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);

  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const spin = new Float32Array(count * 3);
  const quat = new Float32Array(count * 4);
  const floor = new Float32Array(count);
  const life = new Float32Array(count);
  const rest = new Uint8Array(count); // has it stopped moving?
  let cursor = 0;
  let alive = 0;

  const LIFE = 4.2; // seconds before it is tidied away
  const FADE = 0.7; // and how long it takes to go

  for (let i = 0; i < count; i++) {
    _dummy.position.set(0, -1e5, 0);
    _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
    quat[i * 4 + 3] = 1;
  }
  mesh.instanceMatrix.needsUpdate = true;

  // Throw one. `p` is where the breech is and `v` the way it goes, both in the
  // ship's own frame; `deck` is the height it will land on. A case comes out
  // sideways and a little up, and it comes out *fast* — which is why the spin
  // is generous: it leaves end-over-end and never stops turning until it hits.
  function eject(p, v, deck = p.y - 2) {
    const i = cursor;
    cursor = (cursor + 1) % count;
    if (life[i] <= 0) alive++;
    const j = i * 3;
    pos[j] = p.x; pos[j + 1] = p.y; pos[j + 2] = p.z;
    vel[j] = v.x; vel[j + 1] = v.y; vel[j + 2] = v.z;
    spin[j] = (Math.random() - 0.5) * 34;
    spin[j + 1] = (Math.random() - 0.5) * 22;
    spin[j + 2] = (Math.random() - 0.5) * 34;
    const q = i * 4;
    quat[q] = 0; quat[q + 1] = 0; quat[q + 2] = 0; quat[q + 3] = 1;
    floor[i] = deck;
    life[i] = LIFE;
    rest[i] = 0;
  }

  function update(dt) {
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
      const q = i * 4;

      if (!rest[i]) {
        vel[j + 1] -= GRAVITY * dt;
        // a hollow brass tube has a fair amount of drag for what it weighs
        const d = 1 / (1 + 0.9 * dt);
        vel[j] *= d; vel[j + 1] *= d; vel[j + 2] *= d;
        pos[j] += vel[j] * dt;
        pos[j + 1] += vel[j + 1] * dt;
        pos[j + 2] += vel[j + 2] * dt;

        // The deck. Brass on steel keeps very little of what it arrives with
        // and skitters sideways, so most of the speed goes into the bounce
        // being small and the slide being long — which is what a deck full of
        // empties actually looks like after a burst.
        if (pos[j + 1] <= floor[i] + 0.03) {
          pos[j + 1] = floor[i] + 0.03;
          if (vel[j + 1] < -0.4) {
            vel[j + 1] = -vel[j + 1] * 0.30;
            vel[j] *= 0.55; vel[j + 2] *= 0.55;
            spin[j] *= 0.4; spin[j + 1] *= 0.4; spin[j + 2] *= 0.4;
          } else {
            // done bouncing: it lies down and rolls to a stop
            vel[j + 1] = 0;
            vel[j] *= 0.90; vel[j + 2] *= 0.90;
            spin[j] = 0; spin[j + 2] = 0;
            spin[j + 1] *= 0.85;
            if (Math.abs(vel[j]) + Math.abs(vel[j + 2]) < 0.05) {
              rest[i] = 1;
              // lay it flat where it stopped, which is the one pose a case on a
              // deck is ever in
              _q.set(quat[q], quat[q + 1], quat[q + 2], quat[q + 3]);
              _axis.set(0, 1, 0);
              _q.setFromAxisAngle(_axis, Math.atan2(vel[j], vel[j + 2]));
              quat[q] = _q.x; quat[q + 1] = _q.y; quat[q + 2] = _q.z; quat[q + 3] = _q.w;
            }
          }
        }

        _q.set(quat[q], quat[q + 1], quat[q + 2], quat[q + 3]);
        _axis.set(spin[j] * dt * 0.5, spin[j + 1] * dt * 0.5, spin[j + 2] * dt * 0.5);
        _dq.set(_axis.x, _axis.y, _axis.z, 1).normalize();
        _q.premultiply(_dq);
        quat[q] = _q.x; quat[q + 1] = _q.y; quat[q + 2] = _q.z; quat[q + 3] = _q.w;
      } else {
        _q.set(quat[q], quat[q + 1], quat[q + 2], quat[q + 3]);
      }

      // They are picked up rather than deleted: shrinking one away over the
      // last two thirds of a second is invisible, and a case that blinks out is
      // the one thing the eye does catch.
      const k = life[i] < FADE ? life[i] / FADE : 1;
      _pos.set(pos[j], pos[j + 1], pos[j + 2]);
      _scale.setScalar(k);
      _m.compose(_pos, _q, _scale);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function clear() {
    life.fill(0);
    rest.fill(0);
    for (let i = 0; i < count; i++) {
      _dummy.position.set(0, -1e5, 0);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    alive = 0;
  }

  return { mesh, eject, update, clear, get aliveCount() { return alive; } };
}
