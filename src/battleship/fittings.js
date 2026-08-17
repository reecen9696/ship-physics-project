import { Box3, Group, Vector3 } from 'three/webgpu';

// The things bolted onto a tower, as opposed to the tower.
//
// structure.js answers "where does this break", and it is the right model for
// anything that is a *structure*: a funnel is thirteen metres of plate with a
// strength along its length, and where it goes is wherever it was shot. It is
// the wrong model for a pagoda foremast. That column carries the conning
// position, the armoured tube, the director and the whole weight of the bridge;
// it does not fall over, and having it topple off its feet as one 1150-tonne
// object was the least believable thing the ship did.
//
// What actually comes off a tower under fire is everything hung on it: the
// signal yard, the topmast, the radar arrays, the aerial wires, the searchlights
// and the guardrail round every platform. Those are thin, they are exposed, and
// a single shell takes them away — one at a time, in whatever order the enemy
// happens to hit them. That is what this file is for.
//
// A fitting is registered with the object it owns, and from then on it is a
// sphere with a strength. A wound near it eats that strength, and at zero the
// object is handed to the wreck integrator as a body of its own — so a yardarm
// shot off the foretop falls, hits the platform under it, and ends up on the
// deck or in the sea like anything else that leaves her.
//
// --- why the objects get re-origined -----------------------------------------
// Everything in superstructure.js is built with its coordinates baked in the
// ship's frame: a mesh at the masthead has its position set to the masthead,
// and a merged rig has the whole lattice baked into one buffer at full ship
// coordinates. That is right for building and wrong for falling — a body
// tumbles about its object origin, and an object whose origin is the ship's
// keel forty metres below it does not tumble, it swings on a forty-metre arm.
// So on registration each fitting is given an origin at its own centre, by
// putting its contents under an inner group offset the other way. Nothing moves
// on screen and no world matrix changes, which matters: the damage field is
// looked up through a per-mesh matrix baked from exactly those world matrices,
// and a fitting has to carry the holes shot in it.

const _box = new Box3();
const _size = new Vector3();

// How hard a wound bites. Fittings are rod and light plate — the question is
// only whether the burst reached them, not how much of the ship's hit points it
// happened to take, so severity is a modest term on top of a flat one.
const BITE = 0.35;
const SEVERITY_BITE = 2.5;

export function createFittings({ onDetach = null } = {}) {
  const list = [];
  const byId = new Map();

  // Give `object` an origin at the centre of what it contains, without moving
  // any of it. Must be called with the ship at the world origin, which is where
  // she is built.
  function reOrigin(object) {
    object.updateWorldMatrix(true, true);
    _box.setFromObject(object, true);
    const centre = _box.getCenter(new Vector3());
    const half = _box.getSize(_size).multiplyScalar(0.5).clone();
    const inner = new Group();
    inner.name = 'fitting.contents';
    while (object.children.length) inner.add(object.children[0]);
    inner.position.copy(centre).negate();
    object.add(inner);
    object.position.add(centre);
    object.updateWorldMatrix(true, true);
    return { centre, half };
  }

  // `strength` is in the same units the wound deals: 1.0 is about one good
  // shell, and most of what is up there is a good deal less than that.
  function add({
    id, object, parent, mass = 300, strength = 0.5, hpCost = 0,
    // Light enough that the blast which destroyed the parent takes it too. Set
    // false on anything you should have to aim at.
    topHamper = true, buoyancy = 0,
    // What holds this thing up. Shoot the lattice topmast off a mainmast and the
    // air-search array that was standing on its head has nothing under it any
    // more, so it goes too — which is the difference between a mast coming apart
    // and a seven-metre radar hanging in the sky where the mast used to be.
    // Any one of them going is enough, which is also right for a span of aerial
    // wire: it parts when either end of it does.
    supportedBy = null,
  }) {
    const { centre, half } = reOrigin(object);
    const f = {
      id,
      object,
      parent,
      home: object.parent,
      restPos: object.position.clone(),
      restQuat: object.quaternion.clone(),
      centre, // in the ship's frame, and it does not move while it is attached
      half, // and its own extent, which is what a burst is tested against
      radius: Math.max(half.x, half.y, half.z),
      mass,
      strength,
      strength0: strength,
      hpCost, // what losing it costs the component it was bolted to
      topHamper, // comes down with the parent when the parent is destroyed
      buoyancy,
      supportedBy: supportedBy ? [].concat(supportedBy) : null,
      gone: false,
    };
    list.push(f);
    byId.set(id, f);
    return f;
  }

  function detach(f, from = null) {
    if (f.gone) return null;
    f.gone = true;
    const ev = {
      fitting: f,
      object: f.object,
      mass: f.mass,
      centre: f.centre,
      parent: f.parent,
      hpCost: f.hpCost,
      buoyancy: f.buoyancy,
      from,
    };
    if (onDetach) onDetach(ev);
    // Whatever was standing on it has nothing under it now. Done after the
    // event, so the support is on its way down before the things it carried
    // follow it — and recursively, so shooting the spotting top out from under
    // a mainmast brings the lattice, the yard, the wires and the array with it
    // without any of that being written down anywhere as a list.
    for (const o of list) {
      if (o.gone || !o.supportedBy) continue;
      if (o.supportedBy.includes(f.id)) detach(o, from || f.centre);
    }
    return ev;
  }

  // A crater in the ship's frame. What the burst actually reached loses
  // strength, and whatever runs out goes.
  //
  // "Reached" is the distance from the burst to the fitting's own *box*, not to
  // its centre less its radius. The difference matters more than it sounds: a
  // signal yard is fifteen metres across, so the bounding sphere reading put a
  // shell anywhere within ten metres of the mast inside it, and one hit on the
  // foretop took away half the tower's gear. Against the box, a shell has to
  // land on the yard to take the yard.
  function wound({ x, y, z, r, severity = 0.5, only = null }) {
    const events = [];
    for (const f of list) {
      if (f.gone) continue;
      if (only && f.parent !== only) continue;
      const dx = Math.max(0, Math.abs(x - f.centre.x) - f.half.x);
      const dy = Math.max(0, Math.abs(y - f.centre.y) - f.half.y);
      const dz = Math.max(0, Math.abs(z - f.centre.z) - f.half.z);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) continue; // the burst did not get to it
      const d = Math.sqrt(d2);
      // How far into it the burst went, as a fraction of the burst's own size.
      // A direct hit is 1; something clipped at the edge of the blast is nearly
      // nothing and needs several more before it lets go.
      const bite = Math.min(1, (r - d) / Math.max(r * 0.55, 0.7));
      f.strength -= bite * (BITE + SEVERITY_BITE * severity);
      if (f.strength <= 0) {
        const ev = detach(f, { x, y, z });
        if (ev) events.push(ev);
      }
    }
    return events;
  }

  // The component underneath has been destroyed. The tower stays — that is the
  // whole point of this file — and so does anything substantial bolted to it:
  // a wrecked foremast still has its rangefinder and its radar on it, bent and
  // burnt and not working. What goes is the light exposed gear, the rail and
  // the wires and the yards, which is what the blast that finished the tower
  // would have taken with it. Everything else has to be shot off one at a time,
  // which is the entire point of the exercise.
  function collapse(parent, from = null) {
    const events = [];
    for (const f of list) {
      if (f.gone || f.parent !== parent || !f.topHamper) continue;
      const ev = detach(f, from);
      if (ev) events.push(ev);
    }
    return events;
  }

  // Put it all back where it was bolted.
  function repair() {
    for (const f of list) {
      f.strength = f.strength0;
      if (!f.gone) continue;
      f.gone = false;
      f.object.position.copy(f.restPos);
      f.object.quaternion.copy(f.restQuat);
      f.object.scale.set(1, 1, 1);
      f.home.add(f.object);
    }
  }

  return {
    add,
    wound,
    collapse,
    detach,
    repair,
    list,
    get(id) { return byId.get(id); },
    gone(id) { const f = byId.get(id); return !f || f.gone; },
    get count() { return list.filter((f) => !f.gone).length; },
  };
}

// Convenience for the builders: collect meshes into a group that will become
// one fitting, without every call site having to make and name a Group.
export function fittingGroup(parent, name) {
  const g = new Group();
  g.name = name;
  parent.add(g);
  return g;
}
