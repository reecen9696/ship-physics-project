import {
  Object3D, Mesh, Shape, ExtrudeGeometry, BoxGeometry, CylinderGeometry, Group,
  LatheGeometry, Vector2,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { TURRET_SPEC, AA_SPEC, CASEMATES } from './spec.js';
import { doorHole, bandstandDoorHole, buildTurretInterior } from './turretHouse.js';
import { STEEL, STEEL_DARK } from './hull.js';

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
// `door` punches a hole through the profile. The extrusion runs across the beam,
// so one hole in the two-dimensional shape comes out as a doorway to port *and*
// one to starboard, complete with a lined jamb, which is both what a turret has
// and rather less work than cutting two. See turretHouse.js.
function gunhouseGeometry(w, l, h, door = false) {
  const p = new Shape();
  p.moveTo(-l / 2, 0);
  p.lineTo(l / 2, 0);
  p.lineTo(l / 2 - 1.6, h * 0.55);
  p.lineTo(l / 2 - 2.6, h);
  p.lineTo(-l / 2 + 1.0, h);
  p.lineTo(-l / 2, h * 0.8);
  p.closePath();
  if (door) p.holes.push(doorHole(Shape));
  const g = new ExtrudeGeometry(p, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(-Math.PI / 2); // profile x -> ship z, extrusion z -> ship x
  return g;
}

// The blocky raised deck a superfiring turret stands on, with a passage cut
// through it at deck level. Same trick as the gunhouse: the profile is in the
// (z, y) plane and the extrusion runs across the beam, so one hole gives a way
// in from port and one from starboard.
function bandstandGeometry(w, l, h, facing) {
  const p = new Shape();
  p.moveTo(-l / 2, -h / 2);
  p.lineTo(l / 2, -h / 2);
  p.lineTo(l / 2, h / 2);
  p.lineTo(-l / 2, h / 2);
  p.closePath();
  p.holes.push(bandstandDoorHole(Shape, h, facing));
  const g = new ExtrudeGeometry(p, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(-Math.PI / 2);
  return g;
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
function makeBarrel(length, r, mk, material) {
  return new Mesh(merge([
    mk(barrelShellGeometry(length, r), STEEL_DARK, 0.4),
    mk(barrelBoreGeometry(length, r), BORE_BLACK, 0.95),
  ]), material);
}

// shared traverse/elevation behaviour
function makeMount({ id, kind, root, yawPivot, guns, spec, arcCenter, arc, elevMin, elevMax, damage }) {
  const m = {
    id,
    kind,
    root,
    yawPivot,
    guns, // [{ pivot, barrel }]
    spec,
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
    // train and elevate toward the target at the mount's own rates, inside its arc
    update(dt) {
      if (m.destroyed) return;
      const relTarget = clamp(wrap180(m.targetYaw - m.arcCenter), -m.arc, m.arc);
      const relNow = wrap180(m.yaw - m.arcCenter);
      const rel = approach(relNow, relTarget, spec.traverseRate * dt);
      m.yaw = m.arcCenter + rel;
      m.elev = approach(m.elev, clamp(m.targetElev, m.elevMin, m.elevMax), spec.elevateRate * dt);
      m.apply();
    },
    apply() {
      // +yaw is to starboard, which is -x: a rotation about +y turns +z toward +x
      yawPivot.rotation.y = -m.yaw * DEG;
      for (const g of guns) g.pivot.rotation.x = -(m.elev + (g.droop || 0)) * DEG;
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
  id, materials, arcCenter, arc, barbetteHeight, bandstand = 0,
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
    const stand = new Mesh(mk(bandstandGeometry(w, w * 1.15, bandstand, facing), STEEL), M);
    stand.position.y = bandstand / 2;
    root.add(stand);
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
  const house = new Mesh(mk(gunhouseGeometry(S.gunhouseW, S.gunhouseL, S.gunhouseH, true), STEEL), M);
  house.position.z = houseZ;
  yawPivot.add(house);
  // The room behind the door. It rides on the yaw pivot, which is what makes the
  // turret its own coordinate space rather than a moving part of the ship's.
  yawPivot.add(buildTurretInterior({ materials, id }));
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
  return makeMount({
    id, kind: 'turret', root, yawPivot, guns, spec: S, arcCenter, arc,
    elevMin: S.elevMin, elevMax: S.elevMax, damage,
  });
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
    elevMin: S.elevMin, elevMax: S.elevMax, damage,
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
    elevMin: -5, elevMax: S.elevMax, damage,
  });
}
