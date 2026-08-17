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
// A piece goes through up to five states:
//
//   hinge   Still attached along the far edge of its own tear. This is what
//           makes a mast *fall over* instead of dropping: it is an inverted
//           pendulum about the plating that has not let go yet, so it starts
//           slowly, accelerates, and leaves the ship travelling sideways.
//   free    A rigid body: gravity, air drag, a real inertia tensor, and penalty
//           contacts against the ship's own analytic surfaces. Contact above a
//           threshold speed is a hit on whatever it landed on — and a long
//           piece coming down across her hits more than one thing.
//   sleep   At rest on her. Held in the ship's frame so it rides with her
//           without being re-simulated, and woken again if she heels far enough
//           to shift it.
//   float   On the surface. Only for the few things with air sealed inside
//           them — see BUOYANCY in spec.js, which is a list of what is *inside*
//           each piece, because that and nothing else is what decides this. It
//           rides the same fitted sea plane the hull does, lies over onto its
//           flattest face, and swamps: slowly at first, then all at once.
//   sunk    Under. Nothing bounces off the sea; it goes in, throws water, and
//           keeps going down until the ocean — which draws last and writes
//           depth — has covered it.
//
// Nothing fades out. An opaque mesh cannot fade without a material of its own,
// and this ship is built around not having one per part.
//
// Every piece contacts the ship, including a bay of guardrail. That used to be
// skipped on the grounds that a small piece should be clearing her anyway,
// which was wrong twice over: most of them do not clear her, and a rail that
// falls through the deck it landed on is the one thing here that reads as a bug
// rather than as physics. What a small piece gets instead is a coarser set of
// contact points, which is the part that actually costs anything.

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
const MAX_SPIN = 25; // rad/s — a backstop on the contact solve

const HINGE_RELEASE = 0.5; // rad — about 29 degrees
const SLEEP_V = 0.4;
const SLEEP_W = 0.5;
const SLEEP_TIME = 1.1;

// What counts as arriving on something rather than settling against it, and how
// often one body is allowed to report it. A piece sliding down a deckhouse into
// the scuppers is one event, not forty.
const IMPACT_V = 3.2;
const IMPACT_COOL = 0.35;
const IMPACT_APART = 8; // m — far enough along her to be a second thing hit

// Under this and a piece is chaff, thrown away first when the pool is full.
// Guardrail is 60 kg, an aerial wire 30, a yardarm 700, a piece of torn plating
// 240 — all things there are a great many of and none of them worth keeping a
// slot for. Above it are the things you would notice going: a rangefinder, a
// spotting top, an AA tub at eleven tonnes, a funnel at a hundred and thirty.
const CHAFF = 1200;

// Floating. The spring is deliberately soft: omega = 3 rad/s is a four-second
// bob, which is what a big hollow thing lying in a swell actually does, and it
// is nowhere near the stability limit of an explicit step at 20 Hz.
const FLOAT_K = 9.0;
const FLOAT_C = 4.5;
const FLOAT_DRAG = 2.2; // horizontal; wreckage does not go anywhere on its own
const FLOAT_LEVEL = 1.1; // rad/s toward lying on its flattest face

const FLAT = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };
const seaY = (sea, x, z) => sea.height + sea.slopeX * (x - sea.originX) + sea.slopeZ * (z - sea.originZ);

const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _v2 = new Vector3();
const _r = new Vector3();
const _n = new Vector3();
const _p = new Vector3();
const _c = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _box = new Box3();
const _hit = { normal: new Vector3(), id: null };

// Contact scratch. The solve runs twice per body per frame and used to allocate
// a record per contact point each time, which is a few thousand short-lived
// objects a second for a deck with wreckage on it. It is the same handful of
// records every time now.
const MAX_CONTACTS = 20;
const contactPool = [];
for (let i = 0; i < MAX_CONTACTS; i++) {
  contactPool.push({ world: new Vector3(), normal: new Vector3(), depth: 0, id: null });
}

// The points on a body that are allowed to touch the ship. Box corners plus
// face centres: fourteen is enough to keep a long thin thing from pivoting
// through a deck, and few enough that the whole contact solve is free.
//
// `coarse` keeps the eight corners and nothing else. That is what a bay of
// guardrail gets: it is a thin bar, its corners *are* its ends, and there is no
// interior of it to pivot through anything. Halving the point count on the
// pieces there are most of is most of what this costs.
function samplePoints(object, coarse = false) {
  // The box has to be in the object's *own* frame, because that is the frame
  // the contact points are stored in. `setFromObject` reports world space, so
  // the object is unhooked and flattened for the measurement and put back.
  const parent = object.parent;
  const px = object.position.clone();
  const pq = object.quaternion.clone();
  if (parent) parent.remove(object);
  object.position.set(0, 0, 0);
  object.quaternion.identity();
  object.updateMatrixWorld(true);
  _box.setFromObject(object, true);
  object.position.copy(px);
  object.quaternion.copy(pq);
  if (parent) parent.add(object);
  object.updateMatrixWorld(true);
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
  if (!coarse) {
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

// Which of the body's own axes is its flattest — the face it will end up lying
// on once it is in the water, because that is the one with the most waterplane
// under the least freeboard.
function flattestAxis(h) {
  if (h.x <= h.y && h.x <= h.z) return 'x';
  return h.y <= h.z ? 'y' : 'z';
}

// What a unit impulse at `r` along `dir` actually does to that point of the
// body: the mass it behaves as if it had there, once its rotation about the
// contact is counted. A long thin piece struck near its end has an effective
// mass of a few kilograms however many tonnes it weighs, which is the whole
// reason the contact solve has to be written in these terms and not in the
// body's own mass.
const _rn = new Vector3();
function effMass(b, r, dir) {
  _rn.crossVectors(r, dir);
  const a = (_rn.x * _rn.x) / b.inertia.x
    + (_rn.y * _rn.y) / b.inertia.y
    + (_rn.z * _rn.z) / b.inertia.z;
  return 1 / (1 / b.mass + a);
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
  // Room for a good deal more than there used to be. A piece that lands on her
  // now stays there instead of falling through her into the sea, and there are
  // far more pieces: sixty-odd bays of guardrail on the pagoda alone, plus the
  // chunks blown out of her plating. All of it is meant to still be lying there
  // later — one day somebody has to walk round it — and a sleeping piece costs
  // a transform a frame, not a contact solve.
  material, max = 64, colliders: colliders0 = null, onSplash = null, onImpact = null,
}) {
  // The colliders are built from the mounts, and the mounts are built after
  // this is, so they are wired in afterwards rather than passed in.
  let colliders = colliders0;
  const group = new Group();
  group.name = 'ship.wreck';
  group.frustumCulled = false;

  const bodies = [];
  // where the ship is this frame, so contacts can be done in her frame
  const ship = { position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), heel: 0 };
  const shipInv = new Quaternion();

  // --- wreckage that other wreckage can land on --------------------------------
  //
  // A body that has gone to sleep is held in the ship's frame, which is the frame
  // the colliders are written in, so it can simply be handed to them as another
  // box. That is what stops the second thing to come down that hatchway going
  // through the first, and it is the beginning of being able to walk round any of
  // it.
  //
  // Not everything qualifies. A set of aerial wires is four hair-thin rods inside
  // a fifteen-metre box; registering that box would put an invisible wall across
  // the deck. So the test is density — mass against the volume of the box it
  // claims — which separates a bay of guardrail (about 10 kg/m^3 of box) from a
  // span of wire (a hundredth of that) without anything having to be labelled.
  const MIN_DENSITY = 2.0; // kg/m^3 of bounding box
  let keySeq = 0;
  const _bmin = new Vector3();
  const _bmax = new Vector3();

  function makeSolid(b) {
    if (!colliders || !b.key) return;
    const vol = 8 * Math.max(b.half.x, 0.05) * Math.max(b.half.y, 0.05) * Math.max(b.half.z, 0.05);
    if (b.mass / vol < MIN_DENSITY) return;
    _bmin.set(Infinity, Infinity, Infinity);
    _bmax.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < b.pts.length; i++) {
      _v.copy(b.pts[i]).applyQuaternion(b.shipQuat).add(b.shipPos);
      _bmin.min(_v);
      _bmax.max(_v);
    }
    _v.addVectors(_bmin, _bmax).multiplyScalar(0.5);
    _v2.subVectors(_bmax, _bmin).multiplyScalar(0.5);
    colliders.addBody(b.key, _v, _v2);
  }

  function unsolid(b) {
    if (colliders && b.key) colliders.removeBody(b.key);
  }

  function retire(i) {
    const b = bodies[i];
    unsolid(b);
    group.remove(b.object);
    if (b.onRetire) b.onRetire(b);
    bodies.splice(i, 1);
  }

  // Room for one more. Retiring the oldest outright is how a funnel disappears
  // off the quarterdeck in the middle of a battle, so the question asked is
  // which piece can be taken away without anyone seeing it go.
  //
  // Four bands, and age only ever decides between pieces in the same band.
  //
  //   under the water   Behind the ocean surface. Nobody can see it at all.
  //   chaff             A bay of guardrail. One shell along the deck edge
  //                     detaches a dozen of them, and not one is worth a
  //                     funnel — so these go before anything that matters,
  //                     however new they are. Scoring size against age instead
  //                     does not work: a bay that has just been thrown off is
  //                     always the youngest thing here, so it always wins the
  //                     comparison and something worth keeping goes instead.
  //   floating          Drifting astern and out of the picture, but still in
  //                     plain sight.
  //   on her            The funnel lying across the quarterdeck. The last
  //                     thing to go, because it is the thing being looked at.
  function goneUnnoticed(b) {
    if (b.state === 'sunk') return 3e9 + b.age;
    if (b.mass < CHAFF) return 2e9 + b.age;
    if (b.state === 'float') return 1e9 + b.age;
    return b.age;
  }

  function makeRoom() {
    let pick = 0;
    let best = -Infinity;
    for (let i = 0; i < bodies.length; i++) {
      const s = goneUnnoticed(bodies[i]);
      if (s > best) { best = s; pick = i; }
    }
    retire(pick);
  }

  function make(object, {
    mass = 500, light = false, componentId = null, bounds = null, buoyancy = 0,
  }) {
    // A severed piece's own bounding box is the box of the *whole* unit it was
    // cloned from — the geometry is all still there, it is the shader that is
    // throwing half of it away — so the caller has to say which half survived
    // or the centre of mass ends up in mid-air.
    const s = bounds ? boundsPoints(bounds) : samplePoints(object, light);
    const centre = s.centre;
    const half = s.half;
    // The sphere the broadphase tests, about the piece's own centre. Measuring
    // it from the object's origin instead would be safe but useless: a severed
    // superstructure unit keeps the whole ship's frame as its origin, so its
    // radius would be its height above the keel and it would never reject.
    let r2 = 0;
    for (const p of s.pts) r2 = Math.max(r2, p.distanceToSquared(centre));
    return {
      object,
      mass,
      light, // guardrail and the like: corners only, and it cannot hurt her
      componentId,
      com: centre,
      half,
      pts: s.pts,
      radius: Math.sqrt(r2),
      flat: flattestAxis(half),
      inertia: boxInertia(mass, half),
      vel: new Vector3(),
      angVel: new Vector3(),
      hinge: null,
      state: 'free',
      age: 0,
      sunk: -1,
      still: 0,
      // Seconds it will stay on the surface, and how far through swamping it
      // is. See BUOYANCY in spec.js for where the number comes from.
      buoyancy,
      swamp: 0,
      floatQuat: new Quaternion(),
      // What it has already been counted as landing on. A funnel coming down
      // the length of her should hurt the tub it clips *and* the deck it ends
      // up on, and neither of those twice.
      hitIds: new Set(),
      hitAt: new Vector3(),
      impactCool: 0,
      // its handle in the collider set, once it is lying still enough to be
      // something other pieces land on
      key: `w${++keySeq}`,
      shipPos: new Vector3(),
      shipQuat: new Quaternion(),
    };
  }

  // --- the simple case: a small piece thrown clear ---------------------------
  // What the guardrail has always used. It is still the simple case — its own
  // trajectory is most of the story — but it lands on her now like anything
  // else does, on the eight corners of it.
  function spawn(geometry, position, quaternion, velocity, spin, opts = {}) {
    if (bodies.length >= max) makeRoom();
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.quaternion.copy(quaternion);
    // Scale is read by the contact sampling below, so a piece of plate blown
    // off at three metres across is contacted at three metres across.
    if (opts.scale) mesh.scale.setScalar(opts.scale);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    const b = make(mesh, {
      mass: opts.mass ?? 60,
      light: opts.light ?? true,
      buoyancy: opts.buoyancy ?? 0,
    });
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
    onRetire = null, bounds = null, buoyancy = 0,
  }) {
    if (bodies.length >= max) makeRoom();
    object.frustumCulled = false;
    group.add(object);
    const b = make(object, { mass, light: false, componentId, bounds, buoyancy });
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

  // Penalty contacts against the ship's own surfaces.
  //
  // The broadphase is one sphere against the box round the whole ship, in her
  // frame — which is the only test a piece that has gone over the side ever
  // pays, for its entire fall. What survives that goes point by point, and each
  // point is rejected against the box round each shape before any real maths.
  function contacts(b, h) {
    if (!colliders) return 0;
    _c.copy(b.com).applyQuaternion(b.object.quaternion).add(b.object.position)
      .sub(ship.position).applyQuaternion(shipInv);
    if (!colliders.nearBounds(_c.x, _c.y, _c.z, b.radius)) { b.contacting = false; return 0; }

    let n = 0;
    let deepest = 0;
    let deep = null;
    // two passes so the per-point force can be shared out: a body resting on
    // eight points should not be pushed up eight times as hard as one resting
    // on one
    for (let i = 0; i < b.pts.length && n < MAX_CONTACTS; i++) {
      _p.copy(b.pts[i]).applyQuaternion(b.object.quaternion).add(b.object.position);
      // world -> ship
      _v.copy(_p).sub(ship.position).applyQuaternion(shipInv);
      const depth = colliders.query(_v, _hit, b.key);
      if (depth <= 0) continue;
      const c = contactPool[n++];
      c.world.copy(_p);
      c.normal.copy(_hit.normal).applyQuaternion(ship.quaternion);
      c.depth = Math.min(depth, MAX_PEN);
      c.id = _hit.id;
      if (depth > deepest) { deepest = depth; deep = c; }
    }
    if (n === 0) { b.contacting = false; return 0; }

    // --- the contact impulses ---------------------------------------------------
    //
    // The force is a spring out of the penetration and a damper against the
    // approach, as it always was, but what it is allowed to *do* is now bounded
    // by the effective mass at the contact — what a unit impulse there actually
    // does to that point once the body's rotation about it is counted.
    //
    // Without the bound a contact is not passive. The force scales with the
    // body's mass, and the response scales with the effective mass, which for a
    // thin piece struck near its end is a small fraction of it; the point comes
    // away faster than it arrived, the extra goes almost entirely into spin, the
    // spin makes the *next* point arrive faster still, and it runs away in about
    // a tenth of a second. A bay of guardrail dropped on the deck came off it at
    // thirty-seven metres a second turning at two hundred and fifty radians, and
    // a piece of mast reached four kilometres up. A contact may stop what is
    // arriving and lift it out of the plating; it may not do more than that.
    const share = 1 / n;
    for (let i = 0; i < n; i++) {
      const c = contactPool[i];
      _r.copy(c.world).sub(b.object.position);
      // velocity of this point of the body, relative to the ship's surface
      _v.copy(b.angVel).cross(_r).add(b.vel).sub(ship.velocity);
      const vn = _v.dot(c.normal);

      const effN = effMass(b, _r, c.normal);
      let j = Math.max(0, (CONTACT_K * c.depth - CONTACT_C * vn) * b.mass * share) * h;
      const jCap = Math.max(0, -vn) * effN + CONTACT_K * c.depth * effN * h;
      if (j > jCap) j = jCap;
      _v2.copy(c.normal).multiplyScalar(j);

      // Friction along whatever is left of the slide: inside the Coulomb cone,
      // and never more than arrests it.
      _v.addScaledVector(c.normal, -vn);
      const vt = _v.length();
      if (vt > 1e-3) {
        _v.divideScalar(vt);
        const jt = Math.min(FRICTION * j, vt * effMass(b, _r, _v));
        _v2.addScaledVector(_v, -jt);
      }

      b.vel.addScaledVector(_v2, 1 / b.mass);
      _r.cross(_v2);
      b.angVel.x += _r.x / b.inertia.x;
      b.angVel.y += _r.y / b.inertia.y;
      b.angVel.z += _r.z / b.inertia.z;
    }
    // A backstop, because a solver that has got away from you once will do it
    // again on geometry nobody thought of. Nothing that comes off a ship turns
    // faster than this.
    const spin2 = b.angVel.lengthSq();
    if (spin2 > MAX_SPIN * MAX_SPIN) b.angVel.multiplyScalar(MAX_SPIN / Math.sqrt(spin2));

    // Arriving on something is a hit on it. The energy is real: a 130 t funnel
    // at 20 m/s carries 26 MJ, which is an order of magnitude more than a
    // shell — and a 60 kg bay of guardrail carries 12 kJ, which is why the
    // threshold at the other end of this does nothing with it.
    //
    // Not only the first contact. A mast comes down across her at an angle: it
    // catches a tub, pivots off it, and lands on the deck twenty metres further
    // aft, and both of those happened. What is guarded against is the same
    // arrival being counted over and over as the piece settles — a new
    // component, or somewhere else along her, and never within a third of a
    // second of the last one.
    if (deep && b.impactCool <= 0 && onImpact) {
      const speed = _v.copy(b.vel).sub(ship.velocity).length();
      if (speed > IMPACT_V
        && (!b.hitIds.has(deep.id) || b.hitAt.distanceTo(deep.world) > IMPACT_APART)) {
        b.hitIds.add(deep.id);
        b.hitAt.copy(deep.world);
        b.impactCool = IMPACT_COOL;
        onImpact({
          point: deep.world,
          energy: 0.5 * b.mass * speed * speed,
          componentId: deep.id,
          body: b,
        });
      }
    }
    b.contacting = true;
    return n;
  }

  // Push a body clear of whatever it has come to rest in.
  //
  // A penalty solver settles at whatever depth balances gravity — a couple of
  // centimetres if it is lying flat on one thing, a good deal more if it has
  // wedged between two — and then the body is frozen there for the rest of the
  // battle. A couple of centimetres nobody sees; twenty is a yardarm sunk into
  // a deck. So at the instant it goes to sleep, and only then, it is projected
  // out of contact properly: find the deepest point, translate along that
  // surface's normal, and do it again, because pushing it off one thing can put
  // it into another. Six passes is far more than it ever needs.
  // How far the worst of a body's contact points is inside the ship, with the
  // surface it is inside written into `_n` (in her frame).
  function deepestPen(b) {
    let deepest = 0;
    for (let i = 0; i < b.pts.length; i++) {
      _p.copy(b.pts[i]).applyQuaternion(b.object.quaternion).add(b.object.position);
      _v.copy(_p).sub(ship.position).applyQuaternion(shipInv);
      const d = colliders.query(_v, _hit, b.key);
      if (d > deepest) { deepest = d; _n.copy(_hit.normal); }
    }
    return deepest;
  }

  // Returns how deep it still is when it gives up — 0 if it got it out.
  function settle(b) {
    // Out along the surface it is inside. This is enough for almost everything:
    // a body that has come to rest on a deck is a couple of centimetres into it
    // and one pass clears it.
    for (let iter = 0; iter < 6; iter++) {
      const d = deepestPen(b);
      if (d <= 0.005) return 0;
      _n.applyQuaternion(ship.quaternion);
      b.object.position.addScaledVector(_n, Math.min(d, 0.4) + 0.003);
    }
    // What is left is wedged: driven into a corner where two of her own shapes
    // overlap — a deckhouse standing on a deck — so that leaving one puts it
    // into the other and it pushes back and forth for ever. There is exactly
    // one direction that always works on a ship, which is up out of her, so
    // walk it up in short steps and stop at the first height that is clear of
    // everything. Only ever runs on the frame a body falls asleep, and only for
    // the few that get themselves stuck.
    _v2.copy(UP).applyQuaternion(ship.quaternion);
    for (let k = 0; k < 45; k++) {
      b.object.position.addScaledVector(_v2, 0.1);
      if (deepestPen(b) <= 0.005) return 0;
    }
    return deepestPen(b);
  }

  // How far into her a piece may be left sticking before it is thrown away
  // instead of shown. A couple of centimetres is the contact solve at rest and
  // nobody will ever see it; half a metre is a chunk of plating buried in the
  // quarterdeck, and there is no good answer for that one — it got in there by
  // being driven through a corner faster than the contacts could stop it, and
  // it cannot be got out again without pushing it through something else. Since
  // it is chaff, and since there are five more of it lying about, the honest
  // thing is to not have it. Anything worth keeping is exempt and is left where
  // it is: a funnel very slightly into a deck beats a funnel that vanished.
  const WEDGED = 0.15;

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
        // At rest on her. Lift it clear of anything it has settled into first —
        // this is the last chance, because from here it is carried, not
        // simulated, which is what stops a hundred tonnes of dead funnel
        // shivering on the quarterdeck for the rest of the battle.
        shipInv.copy(ship.quaternion).invert();
        if (colliders && settle(b) > WEDGED && b.mass < CHAFF) b.wedged = true;
        b.shipPos.copy(b.object.position).sub(ship.position).applyQuaternion(shipInv);
        b.shipQuat.copy(shipInv).multiply(b.object.quaternion);
        b.state = 'sleep';
        b.vel.set(0, 0, 0);
        b.angVel.set(0, 0, 0);
        makeSolid(b);
      }
    } else {
      b.still = 0;
    }
  }

  // --- the water ---------------------------------------------------------------

  // The lowest point of the body, in world y. Not its centre: a mast falling
  // flat goes in along its whole length at once, and a mast falling end-on
  // does not.
  function lowestY(b) {
    let low = Infinity;
    for (let k = 0; k < b.pts.length; k++) {
      _v.copy(b.pts[k]).applyQuaternion(b.object.quaternion);
      if (_v.y < low) low = _v.y;
    }
    return low + b.object.position.y;
  }

  // It has touched the surface. Whether that is the end of it depends entirely
  // on what is sealed inside it, which is the one thing this cannot work out
  // for itself — so the caller says, in seconds.
  function enterWater(b, wy, low) {
    unsolid(b);
    if (onSplash) onSplash(b.object.position, Math.abs(b.vel.y), b.mass);
    if (b.buoyancy > 0) {
      b.state = 'float';
      b.swamp = 0;
      // It does not stop dead at the surface. It plunges on what it arrived
      // with, loses most of that to the water, and comes back up — which is the
      // whole reason this is a spring and not a height.
      b.vel.multiplyScalar(0.35);
      b.angVel.multiplyScalar(0.3);
      // Where it will end up lying: flattest face down, keeping the heading it
      // came in on. Computed once here rather than chased every frame.
      _v.set(0, 0, 0);
      _v[b.flat] = 1;
      _v.applyQuaternion(b.object.quaternion);
      if (_v.y < 0) _v.negate(); // whichever way up it already is
      b.floatQuat.setFromUnitVectors(_v, UP).multiply(b.object.quaternion);
      return;
    }
    b.object.position.y += wy - low;
    b.state = 'sunk';
    b.sunk = 0;
    b.vel.set(b.vel.x * 0.2, -0.9 - Math.random() * 0.7, b.vel.z * 0.2);
  }

  // On the surface. No contacts and no tumble — a soft spring on the centre of
  // mass, a slerp onto its flattest face, and a swamping term that starts slow
  // and runs away with itself, because that is how a compartment full of air
  // gives up: it holds, it holds, and then the last of it goes at once.
  function stepFloat(b, dt, sea, tilt) {
    b.swamp += (dt * (0.3 + 1.5 * b.swamp)) / b.buoyancy;
    if (b.swamp >= 1) {
      b.state = 'sunk';
      b.sunk = 0;
      b.vel.set(b.vel.x * 0.3, -0.7 - Math.random() * 0.5, b.vel.z * 0.3);
      return;
    }

    const pos = b.object.position;
    const wy = seaY(sea, pos.x, pos.z);
    // The waterline it wants, measured against its own centre: riding on its
    // flattest face to begin with, and settling through itself as it fills.
    const draft = b.half[b.flat];
    _c.copy(b.com).applyQuaternion(b.object.quaternion);
    const comY = pos.y + _c.y;
    const target = wy + draft * (0.35 - 2.2 * b.swamp);
    b.vel.y += ((target - comY) * FLOAT_K - b.vel.y * FLOAT_C) * dt;
    const drag = 1 / (1 + FLOAT_DRAG * dt);
    b.vel.x *= drag;
    b.vel.z *= drag;
    pos.addScaledVector(b.vel, dt);

    // Lie over, and ride the slope of the fitted plane while doing it — which
    // is what puts it on the swell rather than on a table.
    _q.copy(tilt).multiply(b.floatQuat);
    b.object.quaternion.slerp(_q, Math.min(1, FLOAT_LEVEL * dt));

    // She is still steaming, and a piece alongside must not end up inside her.
    // One query, and only for the handful of things that are floating.
    if (colliders) {
      _v.copy(pos).sub(ship.position).applyQuaternion(shipInv);
      if (colliders.insideHull(_v.x, _v.y, _v.z)) {
        _v2.copy(pos).sub(ship.position);
        _v2.y = 0;
        if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
        pos.addScaledVector(_v2.normalize(), 6 * dt);
      }
    }
  }

  // --- update -----------------------------------------------------------------

  const _tilt = new Quaternion();
  const _seaN = new Vector3();

  function update(dt, sea = FLAT, frame = null) {
    if (frame) {
      ship.position.copy(frame.position);
      ship.quaternion.copy(frame.quaternion);
      if (frame.velocity) ship.velocity.copy(frame.velocity);
      ship.heel = frame.heel ?? 0;
    }
    shipInv.copy(ship.quaternion).invert();

    const h = Math.min(dt, 0.05) / SUBSTEPS;
    // The way up out of the sea this frame, from the same fitted plane the hull
    // floats on. One of these for every floating piece, not one each.
    _seaN.set(-sea.slopeX, 1, -sea.slopeZ).normalize();
    _tilt.setFromUnitVectors(UP, _seaN);

    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      // it could not be put anywhere sane; see WEDGED
      if (b.wedged) { retire(i); continue; }
      b.age += dt;
      if (b.impactCool > 0) b.impactCool -= dt;

      if (b.state === 'float') {
        stepFloat(b, dt, sea, _tilt);
        continue;
      }

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
          unsolid(b);
          b.state = 'free';
          b.still = 0;
          b.hitIds.clear();
          b.impactCool = 0;
          b.vel.copy(ship.velocity);
          b.angVel.set(0, 0, 0);
        }
      } else {
        // A fast piece needs finer steps or it goes through her between them.
        // Her plating catches a body over a metre or so of penetration; at
        // thirty metres a second a 120 Hz step carries it a quarter of a metre,
        // so there are only a handful of steps in which to stop it and a light
        // one is through the deck and into the machinery spaces before the
        // contacts have taken its way off. Only the fast ones pay for this, and
        // they are the few that are still in the air.
        const sub = b.vel.lengthSq() > 250 ? SUBSTEPS * 4 : SUBSTEPS;
        const hh = Math.min(dt, 0.05) / sub;
        for (let s = 0; s < sub; s++) {
          if (b.state === 'hinge') stepHinge(b, hh);
          else stepFree(b, hh);
        }
      }

      // The sea takes it, one way or the other.
      const low = lowestY(b);
      const wy = seaY(sea, b.object.position.x, b.object.position.z);
      if (low <= wy) {
        enterWater(b, wy, low);
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
      unsolid(b);
      b.state = 'free';
      b.still = 0;
      // It is falling again, so wherever it comes down is a new arrival.
      b.hitIds.clear();
      b.impactCool = 0;
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
    setColliders(c) { colliders = c; },
    ship,
    bodies,
    get count() { return bodies.length; },
  };
}
