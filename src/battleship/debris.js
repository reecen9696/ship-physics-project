import { Group, Mesh, Quaternion, Vector3 } from 'three/webgpu';

// Wreckage: the pieces that physically leave the ship.
//
// `damage.js` is the state half of destruction — hit points, capabilities, what
// she can no longer do. This is the other half, and it is deliberately much
// dumber: a detached piece is a rigid body with no contacts and no collisions,
// because everything it could hit is either the ship it just left (it should be
// clearing her, not bouncing down her side) or the sea (which ends it). So the
// whole model is gravity, a little air drag, a free tumble, and the surface.
//
// Pieces do not fade out. An opaque mesh cannot fade without its own material,
// and the ship is built around *not* having a material per part — so a piece
// that has hit the water keeps going down instead, and the ocean, which draws
// last and writes depth, hides it. That is also what actually happens to a
// length of steel guardrail.

const GRAVITY = 9.81;
const AIR_DRAG = 0.15; // steel: shape barely matters over the second it is up
const SINK_SECONDS = 3.0; // how long a piece keeps sinking before it is retired
const MAX_AGE = 45;

// Height of the local water plane at a world point. Same fitted plane the
// buoyancy solver hands the hull spray — fair near the ship, which is where
// anything falling off her is.
const FLAT = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };
const seaY = (sea, x, z) => sea.height + sea.slopeX * (x - sea.originX) + sea.slopeZ * (z - sea.originZ);

export function createDebris({ material, max = 140, onSplash = null }) {
  const group = new Group();
  group.name = 'ship.debris';
  group.frustumCulled = false;

  const pieces = [];
  const _q = new Quaternion();

  function retire(i) {
    group.remove(pieces[i].mesh);
    pieces.splice(i, 1);
  }

  // `geometry` is centred on its own origin and owned by the caller — a piece
  // that gets blown off, restored and blown off again reuses the same buffer,
  // so nothing here disposes it.
  function spawn(geometry, position, quaternion, velocity, spin) {
    if (pieces.length >= max) retire(0); // the oldest piece goes
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.quaternion.copy(quaternion);
    mesh.castShadow = true;
    group.add(mesh);
    pieces.push({ mesh, vel: velocity.clone(), spin: spin.clone(), age: 0, sunk: -1 });
    return mesh;
  }

  function update(dt, sea = FLAT) {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      const pos = p.mesh.position;
      p.age += dt;

      if (p.sunk >= 0) {
        // under the surface: still moving, but the water has hold of it
        p.sunk += dt;
        pos.addScaledVector(p.vel, dt);
        p.vel.multiplyScalar(1 / (1 + 1.8 * dt));
        p.vel.y = Math.max(p.vel.y - 0.9 * dt, -2.4);
        p.spin.multiplyScalar(1 / (1 + 2.2 * dt));
        _q.set(p.spin.x * dt * 0.5, p.spin.y * dt * 0.5, p.spin.z * dt * 0.5, 1).normalize();
        p.mesh.quaternion.premultiply(_q);
        if (p.sunk > SINK_SECONDS) retire(i);
        continue;
      }

      p.vel.y -= GRAVITY * dt;
      p.vel.multiplyScalar(1 / (1 + AIR_DRAG * dt));
      pos.addScaledVector(p.vel, dt);
      // Free tumble, integrated as a small-angle quaternion each step. A piece
      // of railing is not a symmetric body and nothing here computes an inertia
      // tensor for it, so the spin it left with is the spin it keeps.
      _q.set(p.spin.x * dt * 0.5, p.spin.y * dt * 0.5, p.spin.z * dt * 0.5, 1).normalize();
      p.mesh.quaternion.premultiply(_q);

      const wy = seaY(sea, pos.x, pos.z);
      if (pos.y <= wy) {
        pos.y = wy;
        if (onSplash) onSplash(pos, Math.abs(p.vel.y));
        p.sunk = 0;
        p.vel.set(p.vel.x * 0.25, -1.1 - Math.random() * 0.6, p.vel.z * 0.25);
      } else if (p.age > MAX_AGE) {
        retire(i);
      }
    }
  }

  function clear() {
    for (const p of pieces) group.remove(p.mesh);
    pieces.length = 0;
  }

  return { group, spawn, update, clear, get count() { return pieces.length; } };
}
