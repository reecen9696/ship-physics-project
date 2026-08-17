import { Quaternion, Vector3 } from 'three/webgpu';
import { hullSpheres } from './hullShape.js';

// Hull against hull.
//
// Two ships in the same water have to be able to hit each other, and the hit has
// to cost something. This is a small impulse solver over the sphere chains in
// hullShape.js: one contact per pair per frame, taken at the deepest overlap,
// resolved as an impulse along the contact normal plus a positional correction
// split by mass — and then handed to each hull as an event in that hull's own
// frame, which is what lets the battleship work out which compartment was stove
// in rather than just losing hit points somewhere.
//
// One contact rather than a manifold is a real simplification and it shows up as
// a hull rolling along another instead of coming to rest against it. With two
// bodies in the scene, one of which outweighs the other eight hundred to one,
// that is not the behaviour anyone is looking at.
//
// Angular response is optional: a body that does not expose `angVel` gets the
// linear part and no spin, which is the right answer for a hull whose yaw is
// stated by a handling model rather than integrated.

const _n = new Vector3();
const _p = new Vector3();
const _ra = new Vector3();
const _rb = new Vector3();
const _va = new Vector3();
const _vb = new Vector3();
const _rel = new Vector3();
const _tan = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _spin = new Vector3();
const _qi = new Quaternion();

export function createHullCollision({
  // Steel on steel: hulls do not bounce, they crumple and stop.
  restitution = 0.10,
  impactSpeed = 1.0, // m/s of closing before it counts as a blow rather than a nudge
  cooldown = 0.35, // s between blows on the same pair, so one collision is one event
  scrapeSpeed = 1.5, // m/s of sliding before grinding along a hull costs anything
  scrapeShare = 0.15, // fraction of the sliding energy that goes into the plating
  slop = 0.03, // m of overlap left alone, so a resting contact does not buzz
} = {}) {
  const bodies = [];

  // `body` is anything with { position, velocity, quaternion } — a hull from
  // createBoat — plus `angVel` if it wants to be spun.
  function add(body, {
    hull, mass, stations = 9, onImpact = null, name = '',
  }) {
    const L = hull.length;
    const B = 2 * hull.halfBeam;
    const D = hull.depth;
    // Body-frame inertia of the equivalent box (x pitch, y yaw, z roll) — the
    // same estimate Boat.js floats on, so a hull spun by a collision behaves
    // like the hull the solver already believes in.
    const b = {
      body,
      hull,
      name,
      onImpact,
      mass,
      invMass: 1 / mass,
      invInertia: new Vector3(
        12 / (mass * (L * L + D * D)),
        12 / (mass * (L * L + B * B)),
        12 / (mass * (B * B + D * D)),
      ),
      spheres: hullSpheres(hull, stations),
      world: [], // this frame's sphere centres, in world space
      radius: L * 0.5 + hull.halfBeam, // broadphase
      cool: 0,
    };
    for (let i = 0; i < b.spheres.length; i++) b.world.push(new Vector3());
    bodies.push(b);
    return b;
  }

  // The event handed to both sides of a contact. Reused between calls: a
  // handler that wants to keep any of it has to copy it.
  const ev = {
    kind: 'impact', // or 'scrape'
    point: new Vector3(), // world
    local: new Vector3(), // in the receiving hull's own frame
    normal: new Vector3(), // world, pointing into the receiving hull
    energy: 0, // joules that went into the plating
    speed: 0, // closing speed along the normal, m/s
    slide: 0, // tangential speed, m/s
    other: '',
  };

  function pointVelocity(b, r, out) {
    out.copy(b.body.velocity);
    if (b.body.angVel) out.add(_t1.copy(b.body.angVel).cross(r));
    return out;
  }

  // ((I^-1 (r x n)) x r) . n — how much the contact is softened by the body
  // being free to rotate about it.
  function angularTerm(b, r) {
    if (!b.body.angVel) return 0;
    _t1.copy(r).cross(_n);
    _t1.applyQuaternion(_qi.copy(b.body.quaternion).invert());
    _t1.multiply(b.invInertia);
    _t1.applyQuaternion(b.body.quaternion);
    return _t2.copy(_t1).cross(r).dot(_n);
  }

  function applySpin(b, r, impulse) {
    if (!b.body.angVel) return;
    _spin.copy(_n).multiplyScalar(impulse);
    _t2.copy(r).cross(_spin);
    _t2.applyQuaternion(_qi.copy(b.body.quaternion).invert());
    _t2.multiply(b.invInertia);
    _t2.applyQuaternion(b.body.quaternion);
    b.body.angVel.add(_t2);
  }

  function emit(self, other, kind, energy, closing, slide, sign) {
    if (!self.onImpact || energy <= 0) return;
    ev.kind = kind;
    ev.point.copy(_p);
    ev.local.copy(_p).sub(self.body.position)
      .applyQuaternion(_qi.copy(self.body.quaternion).invert());
    ev.normal.copy(_n).multiplyScalar(sign);
    ev.energy = energy;
    ev.speed = closing;
    ev.slide = slide;
    ev.other = other.name;
    self.onImpact(ev);
  }

  function solve(A, B, dt) {
    const reach = A.radius + B.radius;
    if (A.body.position.distanceToSquared(B.body.position) > reach * reach) return;

    // deepest overlapping pair of spheres
    let pen = 0;
    let ai = -1;
    let bj = -1;
    for (let i = 0; i < A.world.length; i++) {
      for (let j = 0; j < B.world.length; j++) {
        const d = A.world[i].distanceTo(B.world[j]);
        const p = A.spheres[i].r + B.spheres[j].r - d;
        if (p > pen) { pen = p; ai = i; bj = j; }
      }
    }
    if (pen <= 0) return;

    // normal points from A into B
    _n.subVectors(B.world[bj], A.world[ai]);
    if (_n.lengthSq() < 1e-8) _n.subVectors(B.body.position, A.body.position);
    if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1);
    _n.normalize();
    // the contact, halfway into the overlap along the line of centres
    _p.copy(A.world[ai]).addScaledVector(_n, A.spheres[ai].r - pen * 0.5);

    _ra.subVectors(_p, A.body.position);
    _rb.subVectors(_p, B.body.position);
    pointVelocity(A, _ra, _va);
    pointVelocity(B, _rb, _vb);
    _rel.subVectors(_vb, _va);
    const vn = _rel.dot(_n); // negative while they are closing
    _tan.copy(_rel).addScaledVector(_n, -vn);
    const slide = _tan.length();

    // Push them apart by mass share. On a 800:1 ratio this is the launch being
    // shouldered aside and the battleship not noticing, which is correct.
    const sum = A.invMass + B.invMass;
    const push = Math.max(pen - slop, 0);
    A.body.position.addScaledVector(_n, -push * (A.invMass / sum));
    B.body.position.addScaledVector(_n, push * (B.invMass / sum));

    if (vn < 0) {
      const k = sum + angularTerm(A, _ra) + angularTerm(B, _rb);
      const j = -(1 + restitution) * vn / k;
      A.body.velocity.addScaledVector(_n, -j * A.invMass);
      B.body.velocity.addScaledVector(_n, j * B.invMass);
      applySpin(A, _ra, -j);
      applySpin(B, _rb, j);
    }

    // What it cost. The energy that has to go somewhere is the kinetic energy of
    // the closing motion at the reduced mass — the part the collision removed —
    // and it is split between the two hulls by whatever each one's damage model
    // makes of it.
    const closing = Math.max(-vn, 0);
    const mu = 1 / sum;
    const blow = closing >= impactSpeed && A.cool <= 0 && B.cool <= 0;
    if (blow) {
      const energy = 0.5 * mu * closing * closing;
      A.cool = cooldown;
      B.cool = cooldown;
      emit(A, B, 'impact', energy, closing, slide, 1);
      emit(B, A, 'impact', energy, closing, slide, -1);
      return;
    }
    // Grinding along another hull is not an event, it is a rate: a fraction of
    // the sliding energy per second, for as long as the two stay in contact.
    if (slide > scrapeSpeed) {
      const excess = slide - scrapeSpeed;
      const energy = 0.5 * mu * excess * excess * scrapeShare * dt;
      emit(A, B, 'scrape', energy, closing, slide, 1);
      emit(B, A, 'scrape', energy, closing, slide, -1);
    }
  }

  function update(dt) {
    for (const b of bodies) {
      b.cool = Math.max(0, b.cool - dt);
      for (let i = 0; i < b.spheres.length; i++) {
        const sp = b.spheres[i];
        b.world[i].set(0, sp.y, sp.z).applyQuaternion(b.body.quaternion).add(b.body.position);
      }
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) solve(bodies[i], bodies[j], dt);
    }
  }

  return { add, update, bodies };
}
