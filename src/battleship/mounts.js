import {
  Object3D, Mesh, Shape, ExtrudeGeometry, BoxGeometry, CylinderGeometry, Group,
  LatheGeometry, Vector2,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { TURRET_SPEC, AA_SPEC, CASEMATES } from './spec.js';
import {
  doorHole, bandstandDoorHole, buildTurretInterior, buildChamber, roomRect, chamberRoomRect, PLATE, HOUSE, chamber, BANDSTAND_DOOR_H,
} from './turretHouse.js';
import { bulkheadLight, doorLight, BATTLE_LAMP, DOOR_LAMP } from './bulkheadLight.js';
import { STEEL, STEEL_DARK, deckY, zOf } from './hull.js';

// Every gun mount on the ship is the same machine: a fixed root on the hull, a
// yaw pivot that trains, and one or more elevation pivots that carry barrels.
// They differ in size, in how fast they move and in how far they may train.
//
// Angles are degrees in the hull's frame: yaw 0 is dead ahead and positive is
// to starboard; elevation 0 is level. Each mount slews toward its target at a
// finite rate and stops at its arc limits — a fore turret asked to point astern
// goes as far round as it can and waits there. Nothing here fires or takes
// damage; it just gives the mechanics something real to drive.

const DEG = Math.PI / 180;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const approach = (cur, target, maxStep) => cur + clamp(target - cur, -maxStep, maxStep);

// A gunhouse: side profile extruded across the beam, with a sloped face and a
// slightly lower rear, so it reads as an armoured box and not a shipping crate.
//
// `hollow` is the difference between a turret and a turret you can stand in, and
// it is not the obvious change.
//
// The obvious change is to punch the door through the profile: the extrusion
// runs across the beam, so one hole gives a doorway to port and one to starboard
// for free. What that actually produces is a *tunnel* bored through ten metres
// of solid block — and its four walls, the floor and roof and both jambs, run
// the whole way through. Eight and a half of those ten metres are inside the
// room. They are drawn, they have no collision, and they are the walls you keep
// walking through.
//
// So the house is built hollow instead: the section is extruded as a ring with
// the room punched out of it, which leaves it open at either side, and the two
// sides are closed with plates that carry the door and the window. A hole in a
// plate two hundred millimetres thick is a doorway. A hole in a ten-metre block
// is a corridor.
//
// Returns a list, because an extrusion is not indexed and there is nothing to be
// gained by merging three of them.
function rectShape(r) {
  const s = new Shape();
  s.moveTo(r.z0, r.y0);
  s.lineTo(r.z1, r.y0);
  s.lineTo(r.z1, r.y1);
  s.lineTo(r.z0, r.y1);
  s.closePath();
  return s;
}

// shape x -> ship z, shape z -> ship -x
const place = (g, from) => {
  g.translate(0, 0, from);
  g.rotateY(-Math.PI / 2);
  return g;
};
const extrude = (shape, depth) => new ExtrudeGeometry(shape, { depth, bevelEnabled: false });

function gunhouseGeometry(w, l, h, hollow = false) {
  const p = new Shape();
  p.moveTo(-l / 2, 0);
  p.lineTo(l / 2, 0);
  p.lineTo(l / 2 - 1.6, h * 0.55);
  p.lineTo(l / 2 - 2.6, h);
  p.lineTo(-l / 2 + 1.0, h);
  p.lineTo(-l / 2, h * 0.8);
  p.closePath();
  if (!hollow) return [place(extrude(p, w), -w / 2)];

  const room = roomRect();
  p.holes.push(rectShape(room)); // the ring: house minus room
  const out = [place(extrude(p, w), -w / 2)];

  // and the sides, which are the only place a hole becomes a doorway
  const plate = rectShape(room);
  plate.holes.push(...doorHole(Shape));
  out.push(place(extrude(plate, PLATE), -w / 2));
  out.push(place(extrude(plate, PLATE), w / 2 - PLATE));
  return out;
}

// The blocky raised deck a superfiring turret stands on, with the working
// chamber hollowed out of it and a passage in at deck level.
//
// Built exactly the way the gunhouse is, and for exactly the same reason: a hole
// bored through eleven metres of solid block is not a doorway, it is a corridor,
// and its floor and roof and both jambs stand across the middle of the room. So
// the section is extruded as a ring with the chamber punched out, and the two
// sides are closed with plates that carry the passage.
function bandstandGeometry(w, l, h, facing, turret) {
  const p = new Shape();
  p.moveTo(-l / 2, -h / 2);
  p.lineTo(l / 2, -h / 2);
  p.lineTo(l / 2, h / 2);
  p.lineTo(-l / 2, h / 2);
  p.closePath();

  const room = chamberRoomRect(turret, h);
  p.holes.push(rectShape(room));
  const out = [place(extrude(p, w), -w / 2)];

  const plate = rectShape(room);
  plate.holes.push(bandstandDoorHole(Shape, h, facing, turret));
  out.push(place(extrude(plate, PLATE), -w / 2));
  out.push(place(extrude(plate, PLATE), w / 2 - PLATE));
  return out;
}

// A gun barrel along +z with its breech at the origin.
//
// Not a cone. A naval rifle is heaviest at the breech, where it has to contain
// the chamber pressure, steps down at the end of the reinforce, tapers along the
// chase, and swells very slightly again at the muzzle. Lathing that profile
// costs nothing and is most of what makes a gun look like a gun rather than a
// length of pipe — a plain taper reads as a drainpipe at any distance.
// Profile is [fraction of length, radius as a multiple of `r`].
const BARREL_PROFILE = [
  [0.000, 2.15], // breech face — heaviest, it contains the chamber
  [0.070, 2.10],
  [0.180, 2.03], // reinforce, barely tapering
  [0.300, 1.97],
  [0.315, 1.66], // step down off the reinforce — the ring you see on a real gun
  [0.600, 1.46], // chase, tapering gently
  [0.900, 1.30],
  [0.950, 1.26],
  [0.965, 1.42], // muzzle swell
  [1.000, 1.36],
];

// A gun is a *bored* tube, and the bore is most of what identifies it.
//
// The profile above, lathed as-is, is an open strip of surface: no breech face,
// no muzzle face, nothing across either end. A one-sided strip of surface has
// no inside, so looking anywhere near the muzzle looks straight down the barrel
// and out through the back of it — the guns read as hollow paper cones and the
// whole turret looks broken. It is also the one thing you cannot fix by nudging
// the profile, because the hole is not a shading problem: the geometry simply
// is not closed.
//
// So the lathe profile is a closed loop instead. It starts on the axis at the
// breech (which caps it), runs out and up the outside, turns in across the
// muzzle face to the bore radius, and comes back down the inside of the gun to
// a floor a few calibres in. The bore is its own geometry so it can be painted
// black and rough: what you want at the muzzle is a dark hole, and dark is a
// colour, not an absence of triangles.
const BORE = 0.6; // bore radius as a fraction of the muzzle's outer radius
const BORE_DEPTH = 9; // how far down the bore is modelled, in bore radii
const BORE_BLACK = [0.02, 0.02, 0.025];

const muzzleR = (r) => BARREL_PROFILE[BARREL_PROFILE.length - 1][1] * r;

function barrelShellGeometry(length, r) {
  const bore = muzzleR(r) * BORE;
  const pts = [new Vector2(0, 0)]; // on the axis: this is the breech face
  for (const [f, k] of BARREL_PROFILE) pts.push(new Vector2(k * r, f * length));
  pts.push(new Vector2(bore, length)); // in across the muzzle face to the bore
  const g = new LatheGeometry(pts, 16);
  g.rotateX(Math.PI / 2); // lathe axis +y -> the gun's +z
  return g;
}

function barrelBoreGeometry(length, r) {
  const bore = muzzleR(r) * BORE;
  const floor = length - bore * BORE_DEPTH;
  const g = new LatheGeometry([
    new Vector2(bore, length), // the muzzle rim, shared with the shell above
    new Vector2(bore, floor), // down the inside of the gun
    new Vector2(0, floor), // and closed off, deep enough to stay in shadow
  ], 16);
  g.rotateX(Math.PI / 2);
  return g;
}

// shell and bore in one buffer: two colours, one draw call, one mesh to elevate
export function makeBarrel(length, r, mk, material) {
  return new Mesh(merge([
    mk(barrelShellGeometry(length, r), STEEL_DARK, 0.4),
    mk(barrelBoreGeometry(length, r), BORE_BLACK, 0.95),
  ]), material);
}

// shared traverse/elevation behaviour
//
// `elevFloor(yaw)` is the one thing here that is not the same for every mount.
// Most guns on this ship have a single depression stop and it is a number; a
// mount that trains all the way round has a *cut-out cam* instead — a floor that
// varies with bearing, cut so the barrels cannot come down onto anything of her
// own. Passing it as a function rather than as a table keeps this file ignorant
// of what is standing on her deck, which is the whole point: see sternAA.js.
// --- what a gun going off does to the mounting it is bolted to ----------------
//
// The barrel coming back is drawn on the barrel (muzzleBlast.js) and it is only
// half of what you see. The other half is that the *mount* answers: thirty
// tonnes of it on a roller path takes the reaction of every round through its
// trunnions and its training rack, and what that looks like is a nod and a
// waggle that never quite settle while the gun is firing.
//
// A decaying sine per round is the obvious way to write it and it is the wrong
// one, because rounds arrive faster than any such curve rings down and the
// overlaps are what the effect *is*. So it is a spring: the mounting has a rest
// position, a stiffness and some damping, and firing a round gives it a shove.
// Fire once and it nods and settles; fire nine a second and it never gets back
// to rest, which is exactly the judder an automatic has and is impossible to
// fake with a per-round animation.
//
// `freq` is the mounting's own frequency in Hz, `damp` its damping ratio.
const SHUDDER = {
  freq: 7.0,
  damp: 0.42,
  // Hard stops, so a runaway or a very long burst cannot walk the guns off the
  // target. At these figures a sustained burst holds about half a degree of
  // muzzle rise, which is a real number for a mounting this size and small
  // enough that the layer can hold through it.
  maxRise: 1.1, // degrees
  maxSwing: 0.7,
};

export function makeMount({
  id, kind, root, yawPivot, guns, spec, arcCenter, arc, elevMin, elevMax, damage,
  barrelR = 0.34, elevFloor = null,
}) {
  // The mounting's displacement from rest, in degrees, and its rate. Two
  // independent springs: one in elevation (the muzzles climbing) and one in
  // train (the whole mounting slewing a hair against its rack).
  const shudder = {
    rise: 0, riseVel: 0, swing: 0, swingVel: 0,
  };
  const W = 2 * Math.PI * SHUDDER.freq;
  const K = W * W;
  const C = 2 * SHUDDER.damp * W;

  const m = {
    id,
    kind,
    root,
    yawPivot,
    guns, // [{ pivot, barrel }]
    spec,
    // The profile radius the barrels were lathed from. Everything about firing
    // this mount scales off it — see muzzleBlast.js — so it is carried on the
    // mount rather than looked up from a spec table by whoever pulls the trigger.
    barrelR,
    arcCenter, // rest heading, deg
    arc, // half-width of traverse either side of arcCenter, deg (180 = all round)
    elevMin,
    elevMax,
    yaw: arcCenter,
    elev: 0,
    targetYaw: arcCenter,
    targetElev: 0,
    damage, // uniform 0..1, drives the scorched look
    destroyed: false,
    setTarget(yaw, elev) {
      m.targetYaw = yaw;
      m.targetElev = elev;
    },
    // The floor at a given bearing: the depression stop, or the cut-out cam if
    // this mount has one. Asked by the mount below and by the layer's sight, so
    // the two cannot disagree about where the gun may point.
    floorAt(yaw) {
      return elevFloor ? Math.max(m.elevMin, elevFloor(yaw)) : m.elevMin;
    },
    // A round leaving. `rise` is the shove up the elevation spring and `swing`
    // the shove across the training one, both in degrees per second — a rate,
    // not a displacement, because what a round delivers is an impulse and what
    // decides how far the mounting actually moves is how stiff it is.
    //
    // Whoever pulls the trigger says how hard, because it is a property of the
    // round and not of the mounting: see `automatic.shudder` in sternAA.js.
    shove(rise, swing = 0) {
      shudder.riseVel += rise;
      shudder.swingVel += swing;
    },
    get shudder() { return shudder; },
    // train and elevate toward the target at the mount's own rates, inside its arc
    update(dt) {
      m.settle(dt);
      if (m.destroyed) return;
      const relTarget = clamp(wrap180(m.targetYaw - m.arcCenter), -m.arc, m.arc);
      const relNow = wrap180(m.yaw - m.arcCenter);
      const rel = approach(relNow, relTarget, spec.traverseRate * dt);
      m.yaw = m.arcCenter + rel;
      // Against the floor at the bearing she has *arrived* at, not the one she
      // left: a mount training across the cut-out has to lift as it goes, which
      // is exactly what the cam does to it on a real mounting.
      const floor = m.floorAt(m.yaw);
      m.elev = approach(m.elev, clamp(m.targetElev, floor, m.elevMax), spec.elevateRate * dt);
      m.apply();
    },
    // One step of the two springs. Substepped, because a stiff spring integrated
    // at a long frame is a spring that gains energy — and this one is shoved
    // nine times a second, so it would find that energy and diverge into a gun
    // waving about the sky.
    settle(dt) {
      let left = Math.min(dt, 0.25);
      while (left > 1e-6) {
        const h = Math.min(left, 1 / 240);
        shudder.riseVel += (-K * shudder.rise - C * shudder.riseVel) * h;
        shudder.rise += shudder.riseVel * h;
        shudder.swingVel += (-K * shudder.swing - C * shudder.swingVel) * h;
        shudder.swing += shudder.swingVel * h;
        left -= h;
      }
      shudder.rise = clamp(shudder.rise, -SHUDDER.maxRise, SHUDDER.maxRise);
      shudder.swing = clamp(shudder.swing, -SHUDDER.maxSwing, SHUDDER.maxSwing);
    },
    apply() {
      // +yaw is to starboard, which is -x: a rotation about +y turns +z toward +x
      //
      // The shudder is added here rather than to `yaw` and `elev` themselves,
      // which is the whole point of it being a separate pair of numbers: where
      // the gun is *laid* is what the sight, the cut-out cam and the readout all
      // ask about, and that must not wobble. What wobbles is where the barrels
      // happen to be pointing this frame — which is also where the shells go,
      // and so is a real part of the gun's dispersion.
      yawPivot.rotation.y = -(m.yaw + shudder.swing) * DEG;
      const e = m.elev + shudder.rise;
      for (const g of guns) g.pivot.rotation.x = -(e + (g.droop || 0)) * DEG;
    },
    // Killed: paint scorched, guns drooped at random, and no more motion. This
    // is the visual half of a kill; the game decides when to call it.
    kill() {
      m.destroyed = true;
      m.damage.value = 1;
      m.guns.forEach((g, i) => { g.droop = 3 + i * 4 + Math.random() * 6; });
      m.apply();
    },
    restore() {
      m.destroyed = false;
      m.damage.value = 0;
      m.guns.forEach((g) => { g.droop = 0; });
      m.apply();
    },
    // where a shell would leave, in the mount's own frame — the mechanics will
    // want this in world space, which is a matrixWorld away
    muzzles() {
      return guns.map((g) => g.barrel.localToWorld(g.barrel.position.clone().set(0, 0, g.length)));
    },
  };
  m.apply();
  return m;
}

// --- main battery twin turret ------------------------------------------------
export function createMainTurret({
  id, materials, arcCenter, arc, barbetteHeight, bandstand = 0, turret = null,
}) {
  const S = TURRET_SPEC;
  const slot = materials.slotOf(id);
  const damage = materials.handleFor(id);
  const mk = (g, color, roughness = 0.45) => paint(g, { color, roughness, slot });
  const M = materials.body;

  const root = new Group(); // sits on the deck at the turret's station
  // A superfiring turret stands on a bandstand — a blocky raised deck built up
  // from the main deck — with only a short barbette on top of it. Giving it the
  // whole rise as one tall drum instead makes the gunhouse look perched on a
  // pole, which is the thing that reads as wrong from any distance.
  const drum = barbetteHeight - bandstand;
  const facing = Math.abs(arcCenter) > 90 ? -1 : 1;
  if (bandstand > 0) {
    const w = S.barbetteR * 2.5;
    // Not a box any more: an extruded profile with a passage cut through it at
    // deck level, which is the way into this turret. See turretHouse.js — a
    // superfiring gunhouse is four metres up and a door in its side would open
    // onto nothing.
    for (const g of bandstandGeometry(w, w * 1.15, bandstand, facing, turret)) {
      const piece = new Mesh(mk(g, STEEL), M);
      piece.position.y = bandstand / 2;
      root.add(piece);
    }
    // A chamfered shoulder so the block does not meet the deck as a hard slab.
    // Kept under `PLAYER.stepUp` so it is a threshold to walk over on the way in
    // at the passage rather than a step to be climbed.
    const skirt = new Mesh(mk(new BoxGeometry(w * 1.12, 0.3, w * 1.26), STEEL), M);
    skirt.position.y = 0.15;
    root.add(skirt);
  }
  // barbette: the armoured drum the turret rides on
  const barbette = new Mesh(mk(new CylinderGeometry(S.barbetteR, S.barbetteR * 1.03, drum, 32), STEEL), M);
  barbette.position.y = bandstand + drum / 2;
  root.add(barbette);

  const yawPivot = new Object3D();
  yawPivot.position.y = barbetteHeight;
  root.add(yawPivot);

  const houseZ = -1.0; // the gunhouse sits back on the roller path, its face over the barbette edge
  // A turret on a bandstand keeps its gunhouse shut: its crew space is the
  // working chamber below, at deck level, where you can actually walk into it.
  // Only a turret sitting on the deck gets a door in the side of the house.
  const hasHouseDoor = bandstand === 0;
  for (const g of gunhouseGeometry(S.gunhouseW, S.gunhouseL, S.gunhouseH, hasHouseDoor)) {
    const piece = new Mesh(mk(g, STEEL), M);
    piece.position.z = houseZ;
    yawPivot.add(piece);
  }
  // --- the battle lights -------------------------------------------------------
  //
  // A pair inside every turret's crew space, one on each side wall, burning red.
  // See bulkheadLight.js for why red and not white.
  //
  // Which space that is depends on the turret, and the two are not the same
  // room: a turret on the deck has its gunhouse open and you walk into the house
  // itself, and a turret on a bandstand keeps the house shut and its crew space
  // is the working chamber underneath. Both get lights, because both are rooms
  // with people in them.
  const lamps = [];
  function litRoom({ parent, halfW, y, z, shipY, shipZ, room }) {
    const lit = [];
    for (const side of [-1, 1]) {
      for (const part of bulkheadLight(slot, side)) {
        // turned to face inboard: it is bolted to the inside of the wall
        part.rotateY(Math.PI);
        part.translate(side * halfW, y, z);
        lit.push(part);
      }
    }
    parent.add(new Mesh(merge(lit), M));
    // An emitter at each fitting, and not one between them.
    //
    // It was one, on the turret's own axis, on the grounds that this room turns
    // and the lamp rig it feeds is written in the ship's frame — a lamp off the
    // axis swings as she trains while the fitting it belongs to swings with the
    // house, and the two come apart. That is true and it was still the wrong
    // trade: what you actually see standing in here is a room washed evenly in
    // red from nowhere, with two lamps on the walls that are plainly not lighting
    // it. A light has to come out of the light. So there are two, one at each
    // holder, and they are right whenever the turret is anywhere near its resting
    // bearing — which is where it spends its time, and the error at full train is
    // a metre in a room nine metres across.
    for (const side of [-1, 1]) {
      lamps.push({
        x: side * halfW, y: shipY, z: shipZ,
        ext: [0.06, 0.06, 0.10], // the glass itself, near enough
        room,
        reach: BATTLE_LAMP.reach,
        soft: BATTLE_LAMP.soft,
        color: BATTLE_LAMP.color,
        level: BATTLE_LAMP.level,
      });
    }
  }

  // A light over each door, on the outside. Same arrangement as the battle
  // lights inside — one fitting a side, one emitter between them with a box
  // extent that reaches both, so the nearest point on it from anywhere to port
  // is the port lamp. These are not confined: they are out in the weather, and
  // the shadow volume stops them like every other open-deck light.
  function litDoors({ parent, halfW, y, z, shipY, shipZ }) {
    const lit = [];
    for (const side of [-1, 1]) {
      for (const part of doorLight(slot, side)) {
        part.translate(side * halfW, y, z);
        lit.push(part);
      }
    }
    parent.add(new Mesh(merge(lit), M));
    // One emitter per fitting, and *not* one box spanning the pair.
    //
    // The box trick is right for a light inside a room — the nearest point on it
    // from anywhere in there is the lamp on the near wall — and exactly wrong
    // for a light on the outside of a solid one. An extent reaching from the
    // port fitting to the starboard fitting has its surface running straight
    // through eleven metres of turret, so a fragment on the gunhouse face found
    // the "nearest point on the light" a few centimetres in front of it and lit
    // up as though a lamp were buried in the plating. Which is what it looked
    // like: a yellow blot on the front of the turret and the barrels glowing.
    for (const side of [-1, 1]) {
      lamps.push({
        x: side * (halfW + 0.2), y: shipY, z: shipZ,
        ext: [0.05, 0.05, 0.08], // the lens, near enough
        reach: DOOR_LAMP.reach,
        soft: DOOR_LAMP.soft,
        color: DOOR_LAMP.color,
        level: DOOR_LAMP.level,
      });
    }
  }

  if (hasHouseDoor) {
    // The room behind the door. It rides on the yaw pivot, which is what makes
    // this turret its own coordinate space rather than a moving part of the
    // ship's — see player/mountSpace.js.
    yawPivot.add(buildTurretInterior({ materials, id }));
    litRoom({
      parent: yawPivot,
      halfW: HOUSE.halfW - 0.06,
      y: HOUSE.floor + 2.15,
      z: houseZ,
      // ship frame: the pivot rides `barbetteHeight` above the turret's own
      // origin, which the caller has already put on the deck at its station
      shipY: deckY(turret.z) + barbetteHeight + HOUSE.floor + 1.85,
      shipZ: zOf(turret.z),
      // the gunhouse, generously: its own walls, and enough height to hold the
      // room whichever way the lamp sits in it
      // Height matters as much as width: the bound is centred on the lamp, and
      // 2.4 put its top out through the roof, which showed as a thin red band
      // along the gunhouse's top edge. 1.6 keeps it under the plating.
      room: [HOUSE.halfW + 0.15, 1.6, (HOUSE.fwd - HOUSE.aft) / 2 + 0.6],
    });
    // over the gunhouse doors, just clear of the head of the opening
    litDoors({
      parent: yawPivot,
      halfW: S.gunhouseW / 2,
      y: HOUSE.door.head + 0.30,
      z: HOUSE.door.z,
      shipY: deckY(turret.z) + barbetteHeight + HOUSE.door.head + 0.30,
      shipZ: zOf(turret.z) + HOUSE.door.z,
    });
  } else if (turret) {
    // The working chamber, which does not train and so belongs to the ship.
    root.add(buildChamber({ materials, id, turret }));
    const c = chamber(turret);
    litRoom({
      parent: root,
      halfW: c.halfX - 0.06,
      y: c.floor + 2.15,
      z: 0,
      shipY: deckY(turret.z) + c.floor + 1.85,
      shipZ: zOf(turret.z),
      room: [c.halfX + 0.15, 1.6, c.halfZ + 0.4],
    });
    // and over the passage into the working chamber
    litDoors({
      parent: root,
      halfW: c.outerX,
      y: c.floor + BANDSTAND_DOOR_H + 0.30,
      z: c.doorZ,
      shipY: deckY(turret.z) + c.floor + BANDSTAND_DOOR_H + 0.30,
      shipZ: zOf(turret.z) + c.doorZ,
    });
  }
  // rangefinder hood across the rear of the roof, and the officer's cupola
  const hood = new Mesh(mk(new BoxGeometry(S.gunhouseW * 1.15, 0.9, 1.4), STEEL_DARK, 0.4), M);
  hood.position.set(0, S.gunhouseH + 0.45, -S.gunhouseL / 2 + 1.6);
  yawPivot.add(hood);
  const cupola = new Mesh(mk(new CylinderGeometry(0.7, 0.8, 0.6, 12), STEEL_DARK, 0.4), M);
  cupola.position.set(-2.8, S.gunhouseH + 0.3, -1.5);
  yawPivot.add(cupola);

  const guns = [];
  const gunY = S.gunhouseH * 0.42;
  // Where the sloped face stands at the guns' own height, in the pivot's frame.
  // The blast bag has to be pinned to *that* z: hung off the nominal face at
  // z = gunhouseL/2 it floats a metre out along the barrel and reads as a ring
  // slid down the gun rather than the mouth of the embrasure.
  const faceZ = S.gunhouseL / 2
    - 1.6 * Math.min(1, gunY / (S.gunhouseH * 0.55))
    + houseZ - S.trunnionZ;
  for (const side of [-1, 1]) {
    const pivot = new Object3D();
    pivot.position.set(side * S.barrelSpacing / 2, gunY, S.trunnionZ);
    yawPivot.add(pivot);
    const barrel = makeBarrel(S.barrelLength, S.barrelR, mk, M);
    pivot.add(barrel);
    // canvas blast bag where the barrel leaves the gunhouse face: fattest against
    // the face and drawn in towards the gun, with its rear end buried so no gap
    // opens behind it as the guns elevate
    const bagL = 1.5;
    const bag = new Mesh(mk(new CylinderGeometry(S.barrelR * 2.15, S.barrelR * 2.95, bagL, 14), [0.44, 0.43, 0.40], 0.9), M);
    bag.rotation.x = Math.PI / 2;
    bag.position.z = faceZ + bagL / 2 - 0.4;
    pivot.add(bag);
    guns.push({ pivot, barrel, length: S.barrelLength });
  }

  root.traverse((o) => { o.castShadow = true; o.frustumCulled = false; });
  const mount = makeMount({
    id, kind: 'turret', root, yawPivot, guns, spec: S, arcCenter, arc,
    elevMin: S.elevMin, elevMax: S.elevMax, damage, barrelR: S.barrelR,
  });
  // The red battle lights in her crew space, reported for the ship-wide lamp rig
  // the same way the superstructure reports its window bands. See
  // bulkheadLight.js, and `setLamps` in shipMaterial.js.
  mount.lamps = lamps;
  return mount;
}

// --- twin AA mount in a tub --------------------------------------------------
export function createAAMount({ id, materials }) {
  const S = AA_SPEC;
  const slot = materials.slotOf(id);
  const damage = materials.handleFor(id);
  const mk = (g, color, roughness = 0.45) => paint(g, { color, roughness, slot });
  const M = materials.body;

  const root = new Group();
  const tub = new Mesh(mk(new CylinderGeometry(S.tubR, S.tubR, 1.1, 20, 1, true), STEEL), M);
  tub.position.y = 0.55;
  root.add(tub);
  const floor = new Mesh(mk(new CylinderGeometry(S.tubR, S.tubR, 0.15, 20), STEEL_DARK, 0.4), M);
  floor.position.y = 0.05;
  root.add(floor);

  const yawPivot = new Object3D();
  yawPivot.position.y = 0.15;
  root.add(yawPivot);
  const pedestal = new Mesh(mk(new CylinderGeometry(0.4, 0.55, 1.0, 12), STEEL_DARK, 0.4), M);
  pedestal.position.y = 0.5;
  yawPivot.add(pedestal);
  const cradle = new Mesh(mk(new BoxGeometry(1.4, 0.5, 1.2), STEEL), M);
  cradle.position.set(0, 1.15, -0.1);
  yawPivot.add(cradle);
  const shield = new Mesh(mk(new BoxGeometry(1.8, 1.0, 0.1), STEEL), M);
  shield.position.set(0, 1.5, 0.5);
  yawPivot.add(shield);

  const guns = [];
  for (const side of [-1, 1]) {
    const pivot = new Object3D();
    pivot.position.set(side * 0.35, 1.3, 0.2);
    yawPivot.add(pivot);
    const barrel = makeBarrel(S.barrelLength, S.barrelR, mk, M);
    pivot.add(barrel);
    guns.push({ pivot, barrel, length: S.barrelLength });
  }
  root.traverse((o) => { o.castShadow = true; o.frustumCulled = false; });
  return makeMount({
    id, kind: 'aa', root, yawPivot, guns, spec: S, arcCenter: 0, arc: 180,
    elevMin: S.elevMin, elevMax: S.elevMax, damage, barrelR: S.barrelR,
  });
}

// --- casemate gun in the hull side -------------------------------------------
// `side` is +1 for starboard, -1 for port. The mount rests pointing abeam and
// trains a limited way either side of that inside its embrasure.
export function createCasemate({ id, side, materials }) {
  const S = CASEMATES;
  const slot = materials.slotOf(id);
  const damage = materials.handleFor(id);
  const mk = (g, color, roughness = 0.45) => paint(g, { color, roughness, slot });
  const M = materials.body;

  const root = new Group();
  // The gun is in the hull, not bolted to the outside of it. Only the embrasure
  // and a shallow armoured surround stand proud of the plating; the rest of the
  // box is buried, or the ship grows a row of packing crates down each side.
  const surround = new Mesh(mk(new BoxGeometry(0.5, 2.2, 2.8), STEEL_DARK, 0.5), M);
  surround.position.x = -side * 0.15;
  root.add(surround);
  const port = new Mesh(mk(new BoxGeometry(0.22, 1.15, 1.5), [0.05, 0.05, 0.055], 0.9), M);
  port.position.x = -side * 0.42;
  root.add(port);

  const yawPivot = new Object3D();
  root.add(yawPivot);
  const pivot = new Object3D();
  yawPivot.add(pivot);
  const barrel = makeBarrel(S.barrelLength, S.barrelR, mk, M);
  barrel.position.z = -1.2; // breech well inside the casemate
  pivot.add(barrel);
  const guns = [{ pivot, barrel, length: S.barrelLength - 1.2 }];

  root.traverse((o) => { o.castShadow = true; o.frustumCulled = false; });
  return makeMount({
    id, kind: 'casemate', root, yawPivot, guns,
    spec: { traverseRate: S.rate, elevateRate: S.rate },
    // starboard is -x, i.e. yaw +90; port is +x, yaw -90
    arcCenter: side > 0 ? 90 : -90, arc: S.train,
    elevMin: -5, elevMax: S.elevMax, damage, barrelR: S.barrelR,
  });
}
