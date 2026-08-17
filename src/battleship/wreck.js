import {
  Box3, Group, Mesh, Quaternion, Vector3,
} from 'three/webgpu';

// Wreckage: the pieces that physically leave the ship, and what they do to her
// on the way down.
//
// `damage.js` is the state half of destruction and `damageField.js` the look of
// it. This is the mechanical half, and it exists because "the funnel falls over
// and crushes the AA tub it lands on" should not be a scripted event. It is
// two independent things — a body under gravity, and a ship made of surfaces —
// meeting, and everything interesting about it (which way it goes, what it
// takes with it, whether it stays aboard or slides over the side) falls out of
// that meeting rather than being decided in advance.
//
// A piece goes through up to four states:
//
//   hinge   Still attached along the far edge of its own tear. This is what
//           makes a mast *fall over* instead of dropping: it is an inverted
//           pendulum about the plating that has not let go yet, so it starts
//           slowly, accelerates, and leaves the ship travelling sideways.
//   free    A rigid body: gravity, air drag, a real inertia tensor, and penalty
//           contacts against the ship's own analytic surfaces. First contact
//           above a threshold speed is a hit on whatever it landed on.
//   sleep   At rest on her. Held in the ship's frame so it rides with her
//           without being re-simulated, and woken again if she heels far enough
//           to shift it.
//   sunk    In the water. Nothing bounces off the sea; it goes in, throws
//           water, and keeps going down until the ocean — which draws last —
//           has covered it.
//
// Nothing fades out. An opaque mesh cannot fade without a material of its own,
// and this ship is built around not having one per part.

const GRAVITY = 9.81;
const AIR_DRAG = 0.11;
const SINK_SECONDS = 4.5;
const MAX_AGE = 90;
const SUBSTEPS = 2;

// Contact stiffness, per kilogram, so a 130 t funnel and a 40 kg length of
// guardrail are equally stable. omega = sqrt(k) = 20 rad/s, which at the 120 Hz
// inner step is well inside where an explicit integrator stays put, and leaves
// about 2.5 cm of penetration under gravity.
const CONTACT_K = 400;
const CONTACT_C = 34;
const FRICTION = 0.55;
const MAX_PEN = 0.6; // never push back harder than this much penetration

const HINGE_RELEASE = 0.5; // rad — about 29 degrees
const SLEEP_V = 0.4;
const SLEEP_W = 0.5;
const SLEEP_TIME = 1.1;

const FLAT = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };
const seaY = (sea, x, z) => sea.height + sea.slopeX * (x - sea.originX) + sea.slopeZ * (z - sea.originZ);

const _v = new Vector3();
const _v2 = new Vector3();
const _r = new Vector3();
const _n = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _box = new Box3();
const _hit = { normal: new Vector3(), id: null };

// The points on a body that are allowed to touch the ship. Box corners plus
// face centres: fourteen is enough to keep a long thin thing from pivoting
// through a deck, and few enough that the whole contact solve is free.
function samplePoints(object) {
  _box.setFromObject(object, true);
  const c = _box.getCenter(new Vector3());
  const h = _box.getSize(new Vector3()).multiplyScalar(0.5);
  const pts = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pts.push(new Vector3(c.x + sx * h.x, c.y + sy * h.y, c.z + sz * h.z));
      }
    }
  }
  for (const [ax, s] of [['x', -1], ['x', 1], ['y', -1], ['y', 1], ['z', -1], ['z', 1]]) {
    const p = c.clone();
    p[ax] += s * h[ax];
    pts.push(p);
  }
  // A long piece needs points along its length or it can straddle a deckhouse
  // resting on nothing.
  const longest = h.x > h.y ? (h.x > h.z ? 'x' : 'z') : (h.y > h.z ? 'y' : 'z');
  for (const f of [-0.6, -0.25, 0.25, 0.6]) {
    const p = c.clone();
    p[longest] += f * 2 * h[longest];
    pts.push(p);
  }
  return { pts, centre: c, half: h };
}

// The same, from an explicit box rather than from the geometry.
function boundsPoints({ centre, half }) {
  const c = centre.clone();
  const h = half.clone();
  const pts = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) pts.push(new Vector3(c.x + sx * h.x, c.y + sy * h.y, c.z + sz * h.z));
    }
  }
  const longest = h.x > h.y ? (h.x > h.z ? 'x' : 'z') : (h.y > h.z ? 'y' : 'z');
  for (const f of [-0.75, -0.4, 0, 0.4, 0.75]) {
    const p = c.clone();
    p[longest] += f * 2 * h[longest];
    pts.push(p);
  }
  return { pts, centre: c, half: h };
}

// Diagonal inertia of a uniform box, which is what every piece of this ship is
// close enough to. Real principal axes would need the mesh's mass distribution
// and would not change how any of this looks.
function boxInertia(mass, h) {
  const a = (2 * h.x) ** 2;
  const b = (2 * h.y) ** 2;
  const c = (2 * h.z) ** 2;
  return new Vector3(
    (mass * (b + c)) / 12,
    (mass * (a + c)) / 12,
    (mass * (a + b)) / 12,
  );
}

export function createWreck({
  material, max = 26, colliders = null, onSplash = null, onImpact = null,
}) {
  const group = new Group();
  group.name = 'ship.wreck';
  group.frustumCulled = false;

  const bodies = [];
  // where the ship is this frame, so contacts can be done in her frame
  const ship = { position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), heel: 0 };
  const shipInv = new Quaternion();

  function retire(i) {
    const b = bodies[i];
    group.remove(b.object);
    if (b.onRetire) b.onRetire(b);
    bodies.splice(i, 1);
  }

  function make(object, { mass = 500, light = false, componentId = null, bounds = null }) {
    // A severed piece's own bounding box is the box of the *whole* unit it was
    // cloned from — the geometry is all still there, it is the shader that is
    // throwing half of it away — so the caller has to say which half survived
    // or the centre of mass ends up in mid-air.
    const s = bounds ? boundsPoints(bounds) : samplePoints(object);
    const centre = s.centre;
    const half = s.half;
    return {
      object,
      mass,
      light, // guardrail and the like: no contacts, it should be clearing her
      componentId,
      com: centre,
      half,
      pts: s.pts,
      inertia: boxInertia(mass, half),
      vel: new Vector3(),
      angVel: new Vector3(),
      hinge: null,
      state: 'free',
      age: 0,
      sunk: -1,
      still: 0,
      landed: false,
      shipPos: new Vector3(),
      shipQuat: new Quaternion(),
    };
  }

  // --- the simple case: a small piece thrown clear ---------------------------
  // Identical to what the guardrail has always done. Kept because it is right
  // for anything whose own trajectory is the whole story.
  function spawn(geometry, position, quaternion, velocity, spin, opts = {}) {
    if (bodies.length >= max) retire(0);
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.quaternion.copy(quaternion);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    const b = make(mesh, { mass: opts.mass ?? 60, light: opts.light ?? true });
    b.vel.copy(velocity);
    b.angVel.copy(spin);
    bodies.push(b);
    return b;
  }

  // --- the interesting case: a piece of her that has been broken off ---------
  //
  // `restPos` / `restQuat` are where the piece sits in the *ship's* frame at the
  // instant it lets go, and `hinge` is the line it is still held along. The
  // whole point of the hinge is that a thirty-metre mast takes four seconds to
  // come down and arrives travelling sideways at thirty metres a second, which
  // is a consequence of its length and nothing else — there is no fall-speed
  // number anywhere in this file.
  function spawnPiece(object, {
    mass, restPos, restQuat, hinge = null, kick = null, spin = null, componentId = null,
    onRetire = null, bounds = null,
  }) {
    if (bodies.length >= max) retire(0);
    object.frustumCulled = false;
    group.add(object);
    const b = make(object, { mass, light: false, componentId, bounds });
    b.onRetire = onRetire;
    b.shipPos.copy(restPos);
    b.shipQuat.copy(restQuat);
    if (hinge) {
      b.state = 'hinge';
      b.hinge = {
        pivot: hinge.pivot.clone(),
        axis: hinge.axis.clone().normalize(),
        theta: 0,
        omega: hinge.omega ?? 0,
        restPos: restPos.clone(),
        restQuat: restQuat.clone(),
      };
    } else {
      b.state = 'free';
      // ship frame -> world
      b.object.position.copy(restPos).applyQuaternion(ship.quaternion).add(ship.position);
      b.object.quaternion.copy(ship.quaternion).multiply(restQuat);
      if (kick) b.vel.copy(kick).add(ship.velocity);
      if (spin) b.angVel.copy(spin);
    }
    bodies.push(b);
    return b;
  }

  // --- integration ------------------------------------------------------------

  function stepHinge(b, h) {
    const H = b.hinge;
    // where the centre of mass has got to, in the ship's frame
    _q.setFromAxisAngle(H.axis, H.theta);
    _p.copy(H.restPos).sub(H.pivot).applyQuaternion(_q).add(H.pivot);
    _qi.copy(_q).multiply(H.restQuat);
    _r.copy(b.com).applyQuaternion(_qi).add(_p).sub(H.pivot);

    // gravity, written in the ship's frame — which is why she can be heeled
    // right over and a piece still falls the way down actually is
    _v.set(0, -GRAVITY, 0).applyQuaternion(shipInv);
    // torque about the hinge line, and the moment of inertia about it. The 4/3
    // takes a point mass at the centre of a uniform rod back to the rod.
    const perp = _v2.copy(_r).addScaledVector(H.axis, -_r.dot(H.axis));
    const rp2 = Math.max(perp.lengthSq(), 0.25);
    const torque = _v2.copy(_r).cross(_v).dot(H.axis) * b.mass;
    H.omega += (torque / (b.mass * rp2 * 1.33)) * h;
    H.theta += H.omega * h;

    _q.setFromAxisAngle(H.axis, H.theta);
    b.shipPos.copy(H.restPos).sub(H.pivot).applyQuaternion(_q).add(H.pivot);
    b.shipQuat.copy(_q).multiply(H.restQuat);
    placeFromShip(b);

    if (Math.abs(H.theta) > HINGE_RELEASE) {
      // The plating finally tears through. It leaves with exactly the velocity
      // the hinge had given it, which is what carries a falling mast clear of
      // its own step instead of dropping it straight back down.
      b.state = 'free';
      b.angVel.copy(H.axis).multiplyScalar(H.omega).applyQuaternion(ship.quaternion);
      _r.copy(b.shipPos).sub(H.pivot);
      b.vel.copy(H.axis).cross(_r).multiplyScalar(H.omega)
        .applyQuaternion(ship.quaternion).add(ship.velocity);
      b.hinge = null;
    }
  }

  function placeFromShip(b) {
    b.object.position.copy(b.shipPos).applyQuaternion(ship.quaternion).add(ship.position);
    b.object.quaternion.copy(ship.quaternion).multiply(b.shipQuat);
  }

  // Penalty contacts against the ship's own surfaces. No broadphase: the shape
  // list is short and the number of awake bodies is capped.
  function contacts(b, h) {
    if (b.light || !colliders) return 0;
    shipInv.copy(ship.quaternion).invert();
    let n = 0;
    let deepest = 0;
    let deepPoint = null;
    let deepId = null;
    // two passes so the per-point force can be shared out: a body resting on
    // eight points should not be pushed up eight times as hard as one resting
    // on one
    const found = [];
    for (let i = 0; i < b.pts.length; i++) {
      _p.copy(b.pts[i]).applyQuaternion(b.object.quaternion).add(b.object.position);
      // world -> ship
      _v.copy(_p).sub(ship.position).applyQuaternion(shipInv);
      const depth = colliders.query(_v, _hit);
      if (depth <= 0) continue;
      found.push({
        world: _p.clone(),
        normal: _hit.normal.clone().applyQuaternion(ship.quaternion),
        depth: Math.min(depth, MAX_PEN),
        id: _hit.id,
      });
      if (depth > deepest) { deepest = depth; deepPoint = found[found.length - 1]; deepId = _hit.id; }
      n++;
    }
    if (n === 0) { b.contacting = false; return 0; }

    const share = 1 / n;
    for (const c of found) {
      _r.copy(c.world).sub(b.object.position);
      // velocity of this point of the body, relative to the ship's surface
      _v.copy(b.angVel).cross(_r).add(b.vel).sub(ship.velocity);
      const vn = _v.dot(c.normal);
      const fn = Math.max(0, (CONTACT_K * c.depth - CONTACT_C * vn) * b.mass * share);
      // normal impulse
      _v2.copy(c.normal).multiplyScalar(fn * h);
      // friction, opposing whatever is left of the sliding velocity
      _v.addScaledVector(c.normal, -vn);
      const vt = _v.length();
      if (vt > 1e-3) _v2.addScaledVector(_v, (-Math.min(FRICTION * fn, (vt * b.mass) / h) * h) / vt);
      b.vel.addScaledVector(_v2, 1 / b.mass);
      _r.cross(_v2);
      b.angVel.x += _r.x / b.inertia.x;
      b.angVel.y += _r.y / b.inertia.y;
      b.angVel.z += _r.z / b.inertia.z;
    }

    // The first solid contact of a fall is a hit on whatever it landed on. The
    // energy is real: a 130 t funnel arriving at 20 m/s carries 26 MJ, which is
    // an order of magnitude more than a shell.
    if (!b.landed) {
      const speed = _v.copy(b.vel).sub(ship.velocity).length();
      if (speed > 3.2 && deepPoint) {
        b.landed = true;
        if (onImpact) {
          onImpact({
            point: deepPoint.world,
            energy: 0.5 * b.mass * speed * speed,
            componentId: deepId,
            body: b,
          });
        }
      }
    }
    b.contacting = true;
    return n;
  }

  function stepFree(b, h) {
    b.vel.y -= GRAVITY * h;
    b.vel.multiplyScalar(1 / (1 + AIR_DRAG * h));
    b.object.position.addScaledVector(b.vel, h);
    _q.set(b.angVel.x * h * 0.5, b.angVel.y * h * 0.5, b.angVel.z * h * 0.5, 1).normalize();
    b.object.quaternion.premultiply(_q);
    const n = contacts(b, h);
    if (n > 0) {
      b.angVel.multiplyScalar(1 / (1 + 1.6 * h));
      const rel = _v.copy(b.vel).sub(ship.velocity).length();
      if (rel < SLEEP_V && b.angVel.length() < SLEEP_W) b.still += h;
      else b.still = 0;
      if (b.still > SLEEP_TIME) {
        // At rest on her. Freeze it into her frame; from here it is carried, not
        // simulated, which is what stops a hundred tonnes of dead funnel
        // shivering on the quarterdeck for the rest of the battle.
        shipInv.copy(ship.quaternion).invert();
        b.shipPos.copy(b.object.position).sub(ship.position).applyQuaternion(shipInv);
        b.shipQuat.copy(shipInv).multiply(b.object.quaternion);
        b.state = 'sleep';
        b.vel.set(0, 0, 0);
        b.angVel.set(0, 0, 0);
      }
    } else {
      b.still = 0;
    }
  }

  // --- update -----------------------------------------------------------------

  function update(dt, sea = FLAT, frame = null) {
    if (frame) {
      ship.position.copy(frame.position);
      ship.quaternion.copy(frame.quaternion);
      if (frame.velocity) ship.velocity.copy(frame.velocity);
      ship.heel = frame.heel ?? 0;
    }
    shipInv.copy(ship.quaternion).invert();

    const h = Math.min(dt, 0.05) / SUBSTEPS;

    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      b.age += dt;

      if (b.state === 'sunk') {
        b.sunk += dt;
        b.object.position.addScaledVector(b.vel, dt);
        b.vel.multiplyScalar(1 / (1 + 1.8 * dt));
        b.vel.y = Math.max(b.vel.y - 0.9 * dt, -2.4);
        b.angVel.multiplyScalar(1 / (1 + 2.2 * dt));
        _q.set(b.angVel.x * dt * 0.5, b.angVel.y * dt * 0.5, b.angVel.z * dt * 0.5, 1).normalize();
        b.object.quaternion.premultiply(_q);
        if (b.sunk > SINK_SECONDS) retire(i);
        continue;
      }

      if (b.state === 'sleep') {
        placeFromShip(b);
        // She rolls far enough and it goes over the side, which is exactly what
        // happens to loose wreckage on a listing ship.
        if (Math.abs(ship.heel) > 21) {
          b.state = 'free';
          b.still = 0;
          b.vel.copy(ship.velocity);
          b.angVel.set(0, 0, 0);
        }
      } else {
        for (let s = 0; s < SUBSTEPS; s++) {
          if (b.state === 'hinge') stepHinge(b, h);
          else stepFree(b, h);
        }
      }

      // the sea ends everything
      const wy = seaY(sea, b.object.position.x, b.object.position.z);
      const low = b.object.position.y + b.com.y - b.half.y;
      if (low <= wy) {
        b.object.position.y += wy - low;
        if (onSplash) onSplash(b.object.position, Math.abs(b.vel.y), b.mass);
        b.state = 'sunk';
        b.sunk = 0;
        b.vel.set(b.vel.x * 0.2, -0.9 - Math.random() * 0.7, b.vel.z * 0.2);
      } else if (b.age > MAX_AGE && b.state !== 'sleep') {
        retire(i);
      }
    }
  }

  function clear() {
    for (let i = bodies.length - 1; i >= 0; i--) retire(i);
  }

  // Something exploded near a resting piece: shake it loose.
  function disturb(worldPoint, radius) {
    for (const b of bodies) {
      if (b.state !== 'sleep') continue;
      if (b.object.position.distanceTo(worldPoint) > radius) continue;
      b.state = 'free';
      b.still = 0;
      _v.copy(b.object.position).sub(worldPoint).normalize();
      b.vel.copy(_v).multiplyScalar(3).add(ship.velocity);
      b.angVel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    }
  }

  return {
    group,
    spawn,
    spawnPiece,
    update,
    clear,
    disturb,
    ship,
    bodies,
    get count() { return bodies.length; },
  };
}
