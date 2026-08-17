import { Quaternion, Vector3, Vector4 } from 'three/webgpu';

// Where the ship breaks.
//
// The rule this file exists to enforce is: **nothing is pre-cut**. There is no
// list of pieces a funnel can come apart into. There is thirteen metres of
// plate with a strength along its length, and where it breaks is wherever the
// strength ran out — which is wherever it was shot. Hit the same funnel at the
// base and it goes over whole; hit it two-thirds of the way up and the top
// third comes off and the stump keeps standing and keeps making smoke.
//
// Two failure modes, and a thing can suffer either:
//
//   * A **spine** fails. Anything tall and thin — the funnel, the pagoda
//     column, the tripod mainmast — is modelled as a run of sections along its
//     axis, each with a thickness. A crater near the axis eats the sections it
//     overlaps. The first one to go to zero is the break.
//   * A **joint** fails. Every unit is bolted to the deck over a footprint; a
//     crater inside that footprint eats the joint, and when the joint goes the
//     whole thing comes off its feet.
//
// Either way what falls is not a new mesh. It is a *clone* of the same meshes,
// sharing every buffer, with a plane written into its `userData` that the
// shader discards against — and the complementary plane written into the
// original. The two tears use the same noise field with opposite signs, so they
// interlock: what one half throws away is exactly what the other half keeps.
// There is no triangle splitting anywhere in this project, and there does not
// need to be.
//
// `attach` gives the whole thing a tree. A shelter deck blown open drops the AA
// tubs standing on it, and nothing had to say so — they were attached to it.

const _v = new Vector3();
const _v2 = new Vector3();
const _dir = new Vector3();
const _rad = new Vector3();
const _axis = new Vector3();

// three's Object3D.copy runs userData through JSON, which turns the Matrix4
// every mesh carries for its damage-field lookup into a plain object and makes
// the shader read garbage. Clone, then walk both trees in the same order and
// put the real references back.
export function cloneUnit(src) {
  const dst = src.clone(true);
  const a = [];
  const b = [];
  src.traverse((o) => a.push(o));
  dst.traverse((o) => b.push(o));
  for (let i = 0; i < a.length && i < b.length; i++) b[i].userData = { ...a[i].userData };
  return dst;
}

// Write a tear plane onto every mesh of a subtree. `side` +1 keeps the half the
// normal points away from (the stump); -1 keeps the other half.
function setCut(object, normal, d, side) {
  const p = new Vector4(normal.x * side, normal.y * side, normal.z * side, d * side);
  object.traverse((o) => {
    if (o.isMesh) o.userData.cutPlane = p;
  });
}

export function createStructure({
  units, colliders = null, onSever = null, onCollapse = null,
}) {
  // unit: { id, object, mass, foot: {x,y,z,r,strength}, spine: {...}|null,
  //         attach: componentId|null, noTopple }
  const list = [];
  const byId = new Map();

  for (const u of units) {
    const rec = {
      ...u,
      joint: u.foot ? u.foot.strength ?? 1.0 : Infinity,
      sections: u.spine ? new Float32Array(u.spine.sections).fill(u.spine.strength) : null,
      gone: false, // the whole thing has left her
      cutAt: null, // how far up it has been broken, in metres along the spine
    };
    list.push(rec);
    byId.set(u.id, rec);
  }

  // --- taking a wound ---------------------------------------------------------
  //
  // `severity` is what got through, as a fraction of what it would take to
  // destroy this thing outright, so armour and shell type are already in it.
  function wound({ x, y, z, r, severity, only = null }) {
    const events = [];
    for (const u of list) {
      if (u.gone) continue;
      if (only && u.id !== only && u.attach !== only) continue;

      // --- the joint ---
      if (u.foot) {
        const dxz = Math.hypot(x - u.foot.x, z - u.foot.z);
        const dy = Math.abs(y - u.foot.y);
        const reach = u.foot.r + r;
        if (dxz < reach && dy < r + 2.5) {
          const bite = Math.min(1, (reach - dxz) / (2 * u.foot.r))
            * Math.max(0, 1 - dy / (r + 2.5));
          u.joint -= bite * severity * 0.5;
        }
      }

      // --- the spine ---
      if (u.spine && u.sections) {
        const S = u.spine;
        const n = u.sections.length;
        const step = S.length / n;
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) * step;
          if (u.cutAt !== null && t > u.cutAt) continue; // that part is gone already
          _v.copy(S.base).addScaledVector(S.dir, t);
          const d = Math.hypot(x - _v.x, y - _v.y, z - _v.z);
          const reach = r + S.radius;
          if (d >= reach) continue;
          // How far the crater bites into this station's cross-section. A wound
          // whose radius is a fair share of the structure's own is most of the
          // way through it in one go; a small one nibbles.
          const bite = Math.min(1, (reach - d) / (2 * S.radius));
          u.sections[i] -= bite * severity * 0.6;
        }
      }

      // --- has it let go? ---
      const ev = check(u, { x, y, z });
      if (ev) events.push(ev);
    }
    return events;
  }

  function check(u, from) {
    if (u.gone) return null;
    if (u.joint <= 0 && !u.noTopple) return topple(u, from);
    if (u.sections) {
      const S = u.spine;
      const step = S.length / u.sections.length;
      for (let i = 0; i < u.sections.length; i++) {
        if (u.sections[i] > 0) continue;
        const t = (i + 0.5) * step;
        if (u.cutAt !== null && t >= u.cutAt) continue;
        // Broken so near the deck that there is no stump worth keeping: it goes
        // over as a whole unit instead, hinging on its own footing.
        if (t < S.length * 0.14 && !u.noTopple) return topple(u, from);
        return sever(u, t, from);
      }
    }
    return null;
  }

  // --- breaking a spine -------------------------------------------------------
  function sever(u, t, from) {
    const S = u.spine;
    const cutPoint = _v.copy(S.base).addScaledVector(S.dir, t).clone();

    // Which way the blast came from, across the axis. That is the side the
    // plating has already gone from, so the far side is what is still holding —
    // and a column hinged at its far edge with its weight overhanging topples
    // *toward* the damage, which is what actually happens.
    _rad.set(from.x - cutPoint.x, from.y - cutPoint.y, from.z - cutPoint.z);
    _rad.addScaledVector(S.dir, -_rad.dot(S.dir));
    if (_rad.lengthSq() < 1e-4) _rad.set(1, 0, 0);
    _rad.normalize();

    const pivot = cutPoint.clone().addScaledVector(_rad, -S.radius * 0.85);
    // positive rotation about this axis carries the top toward the blast
    _axis.copy(S.dir).cross(_rad).normalize();

    const remaining = S.length - t;
    const mass = Math.max(u.mass * (remaining / S.length), 500);

    // the clone keeps everything above the cut; the original keeps everything
    // below it
    const piece = cloneUnit(u.object);
    setCut(piece, S.dir, S.dir.dot(cutPoint), -1);
    setCut(u.object, S.dir, S.dir.dot(cutPoint), +1);

    u.cutAt = t;
    u.spine = { ...S, length: t };
    if (colliders) colliders.setStump(u.id, t);

    // the box the falling half actually occupies, for its inertia and contacts
    const top = cutPoint.clone().addScaledVector(S.dir, remaining);
    const centre = cutPoint.clone().add(top).multiplyScalar(0.5);
    const half = new Vector3(
      Math.abs(top.x - cutPoint.x) / 2 + S.radius,
      Math.abs(top.y - cutPoint.y) / 2 + S.radius,
      Math.abs(top.z - cutPoint.z) / 2 + S.radius,
    );

    const ev = {
      kind: 'sever',
      unit: u,
      object: piece,
      mass,
      cutPoint,
      hinge: { pivot, axis: _axis.clone(), omega: 0.10 + Math.min(0.5, 4 / Math.sqrt(mass)) },
      bounds: { centre, half },
    };
    if (onSever) onSever(ev);
    return ev;
  }

  // --- losing the whole thing off its feet -----------------------------------
  function topple(u, from) {
    const foot = u.foot;
    const base = new Vector3(foot.x, foot.y, foot.z);
    _dir.copy(u.spine ? u.spine.dir : new Vector3(0, 1, 0));
    _rad.set(from.x - base.x, 0, from.z - base.z);
    if (_rad.lengthSq() < 1e-4) _rad.set(1, 0, 0);
    _rad.normalize();
    const pivot = base.clone().addScaledVector(_rad, -foot.r * 0.9);
    _axis.copy(_dir).cross(_rad).normalize();

    const piece = cloneUnit(u.object);
    // the whole thing goes; nothing is left to cut
    u.gone = true;
    u.object.visible = false;
    if (colliders) colliders.setStump(u.id, 0);

    const ev = {
      kind: 'topple',
      unit: u,
      object: piece,
      mass: u.mass,
      cutPoint: base,
      hinge: { pivot, axis: _axis.clone(), omega: 0.12 },
      bounds: null,
    };
    if (onSever) onSever(ev);
    return ev;
  }

  // Everything standing on a thing that has just been destroyed goes with it.
  // This is the only place the attachment tree is read, and it is what makes a
  // shelter deck blown open drop the mounts that were on it.
  function collapse(attachId, from = { x: 0, y: 0, z: 0 }) {
    const events = [];
    for (const u of list) {
      if (u.gone || u.attach !== attachId) continue;
      const ev = topple(u, from);
      if (ev) events.push(ev);
    }
    if (onCollapse) onCollapse(attachId, events);
    return events;
  }

  // A component whose hit points have run out is not automatically on the deck
  // — where it breaks is still the structure's business — but it *is* a good
  // deal weaker than it was. This takes the same bite out of everything at
  // once, so whichever section was already thinnest is the one that goes, which
  // is the section that was shot the most. That is still emergent; it is only
  // the trigger that is not.
  function weaken(id, amount, from = null) {
    const u = byId.get(id);
    if (!u || u.gone) return null;
    u.joint -= amount;
    if (u.sections) for (let i = 0; i < u.sections.length; i++) u.sections[i] -= amount;
    const at = from || (u.spine
      ? { x: u.spine.base.x + 3, y: u.spine.base.y + u.spine.length * 0.4, z: u.spine.base.z }
      : { x: u.foot.x + 3, y: u.foot.y, z: u.foot.z });
    return check(u, at);
  }

  // Force one, from the panel or a key.
  function breakAt(id, frac, from = null) {
    const u = byId.get(id);
    if (!u || u.gone) return null;
    if (!u.spine) return topple(u, from || { x: u.foot.x + 4, y: u.foot.y, z: u.foot.z });
    const t = Math.max(0.05, Math.min(0.95, frac)) * u.spine.length;
    const at = from || {
      x: u.spine.base.x + 4,
      y: u.spine.base.y + u.spine.dir.y * t,
      z: u.spine.base.z + u.spine.dir.z * t,
    };
    if (t < u.spine.length * 0.14) return topple(u, at);
    return sever(u, t, at);
  }

  function repair() {
    for (const u of list) {
      u.gone = false;
      u.cutAt = null;
      u.object.visible = true;
      u.joint = u.foot ? u.foot.strength ?? 1.0 : Infinity;
      if (u.spine0) u.spine = { ...u.spine0 };
      if (u.sections) u.sections.fill(u.spine.strength);
      u.object.traverse((o) => { if (o.isMesh) delete o.userData.cutPlane; });
    }
    if (colliders) colliders.clearStumps();
  }

  // remember the spines as built, so `repair` can put the lengths back
  for (const u of list) if (u.spine) u.spine0 = { ...u.spine };

  return {
    wound, collapse, breakAt, weaken, repair, byId, units: list,
    state(id) { return byId.get(id); },
  };
}
