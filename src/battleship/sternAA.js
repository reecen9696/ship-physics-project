import {
  Object3D, Mesh, BoxGeometry, CylinderGeometry, TorusGeometry, Group,
  MeshBasicNodeMaterial, AdditiveBlending, Color,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { STERN_AA, TURRETS, TURRET_SPEC, SUPER } from './spec.js';
import { makeMount, makeBarrel } from './mounts.js';
import { STEEL, STEEL_DARK, deckY, zOf } from './hull.js';

// The gun on her quarterdeck.
//
// Y turret used to stand here. What stands here now is a quadruple heavy AA
// mounting on the same barbette, and the reason it gets a file of its own rather
// than a fourth `create...` in mounts.js is that almost nothing about it is a
// turret with smaller numbers. See the note over STERN_AA in spec.js for the
// difference in full; the three parts of it that are *code* rather than tuning
// are all here:
//
//   the cut-out cam   — a mount that trains all the way round can be trained
//                       onto its own ship, so its depression stop is a profile
//                       against bearing rather than a number. It is measured off
//                       the ship below rather than drawn by hand.
//   the shield        — on the *mounting* and not round it. A tub protects the
//                       crew from every bearing the enemy is not on and walls in
//                       a gun that has to be got at from all of them; a shield
//                       that trains with the guns is always between the layer
//                       and what he is shooting at. See STERN_AA in spec.js.
//   the platform      — three risers of 300 mm rather than one of 900, so
//                       getting onto the gun is walking rather than climbing.
//                       One description in `daisTiers`, and the mesh, the ship's
//                       colliders and the deck props are all built off it.
//   four barrels, one cradle — they elevate together and recoil separately,
//                       which is what a quadruple automatic is.
//
// Nothing here fires. What the trigger does is in player/aaStation.js, and what
// leaves the muzzle is in ballistics.js.

const DEG = Math.PI / 180;

// --- the platform ------------------------------------------------------------
//
// Y turret's barbette, with two courses of plating skirted round it so that the
// climb onto it is three risers of 300 mm rather than one of 900. Each riser is
// well under `PLAYER.stepUp`, so walking on is simply walking: the floor probe
// finds the next tread and there is no ladder, no doorway and nothing to jump.
//
// Returned as a list of tiers because there are three descriptions of the same
// three cylinders and they must not drift: the mesh below is built from it, the
// ship's colliders are built from it (colliders.js), and the deck props are kept
// off it by it (deckProps.js). It is the only place the shape is written down.
export function daisTiers() {
  const S = STERN_AA;
  const out = [];
  for (let i = S.steps; i >= 1; i--) {
    out.push({
      r: S.ringR + i * S.stepTread,
      y0: 0,
      y1: (S.steps + 1 - i) * S.stepRise,
    });
  }
  // and the barbette itself on top of them
  out.push({ r: S.ringR, y0: 0, y1: S.ringH });
  return out;
}

// How far the whole thing reaches across the deck, which is what everything else
// wants to know about it.
export const daisRadius = () => STERN_AA.ringR + STERN_AA.steps * STERN_AA.stepTread;

// --- the cut-out cam ----------------------------------------------------------
//
// The one fitting on this mounting that has no equivalent anywhere else on the
// ship, and the reason it exists is the thing that makes an all-round mount
// dangerous: at any bearing forward of the beam, a gun on the quarterdeck laid
// flat is laid straight down the length of her own ship.
//
// Real mountings solve this mechanically. A rail — a cam — runs round the
// training path at a height cut to the silhouette of everything standing in
// front of the gun, and a roller on the elevating gear follows it, so the
// barrels are physically lifted as the mount trains across her superstructure
// and cannot come down again until they are past it. There is no interlock to
// forget and no drill to get wrong: the shape of the ship is milled into the
// machine.
//
// So it is milled into this one too, and — this is the part worth insisting on —
// it is *measured* rather than drawn. The profile below is computed from the
// stations and heights in spec.js, which means that raising the after deckhouse
// or moving the mainmast re-cuts the cam without anybody remembering to. A
// hand-drawn table would be a second description of the ship and would be wrong
// within a month.
//
// It is cut generously on purpose. `camClear` puts the barrels two metres over
// the top of whatever they are passing, the nearest face of an obstruction is
// used for the whole of the bearing it covers rather than its true profile, and
// `camMargin` is another degree and a half on top. A safety rail that shaves
// past the mainmast is not a safety rail.

// The pagoda has no single height in spec.js — it is built as a column with
// things hung off it, and what matters here is only the top of the solid part of
// it. Taken high rather than low: over-cutting the cam costs a few degrees of a
// bearing the gun can barely use anyway, and under-cutting it puts a burst
// through her own fire control.
const PAGODA_TOP = 34; // m above the deck at her station

// Everything of her own the gun can be trained into, in plan, with the height
// that has to be cleared. Boxes rather than the true shapes: a box round a thing
// is the conservative answer, which is the one a safety cam wants.
function obstructions() {
  const out = [];
  const X = TURRETS.find((t) => t.id === 'turret.X');
  if (X) {
    // The gunhouse trains, so what has to be cleared is the circle it sweeps,
    // not the box it happens to be sitting in at rest.
    const R = Math.hypot(TURRET_SPEC.gunhouseW / 2, TURRET_SPEC.gunhouseL / 2);
    out.push({
      name: X.id,
      x0: -R, x1: R, z0: zOf(X.z) - R, z1: zOf(X.z) + R,
      top: deckY(X.z) + X.deckRise + TURRET_SPEC.gunhouseH,
    });
  }
  const A = SUPER.aftSuper;
  out.push({
    name: 'aftSuper',
    x0: -A.w / 2, x1: A.w / 2, z0: zOf(A.z) - A.l / 2, z1: zOf(A.z) + A.l / 2,
    top: deckY(A.z) + A.h,
  });
  // The mainmast, and it is included deliberately even though it is a lattice
  // you could very nearly shoot through. It is six metres across at the foot and
  // thirty metres tall, it carries her spotting top, and the notch it cuts is
  // four degrees wide — a narrow bar the cross will not come down through, dead
  // ahead, which is exactly what the layer of a real after mounting had.
  const M = SUPER.mainmast;
  out.push({
    name: 'mainmast',
    x0: -M.spread / 2, x1: M.spread / 2,
    z0: zOf(M.z) - M.spread / 2, z1: zOf(M.z) + M.spread / 2,
    top: deckY(A.z) + A.h + M.h,
  });
  const D = SUPER.funnelDeck;
  out.push({
    name: 'funnelDeck',
    x0: -D.w / 2, x1: D.w / 2, z0: zOf(D.z) - D.l / 2, z1: zOf(D.z) + D.l / 2,
    top: deckY(D.z) + D.h,
  });
  const F = SUPER.funnel;
  out.push({
    name: 'funnel',
    x0: -F.rx, x1: F.rx, z0: zOf(F.z) - F.rz, z1: zOf(F.z) + F.rz,
    top: deckY(D.z) + D.h + F.h,
  });
  out.push({
    name: 'bridge',
    x0: -8.5, x1: 8.5,
    z0: zOf(SUPER.bridge.z) - 11.5, z1: zOf(SUPER.bridge.z) + 9.5,
    top: deckY(SUPER.bridge.z) + PAGODA_TOP,
  });
  return out;
}

const CAM_BINS = 360; // one degree of bearing per bin

// Built once, on the first question anybody asks, exactly as the firing table
// in ballistics.js is. `floor[i]` is the lowest elevation the gun may be laid to
// on bearing `i` degrees.
let CAM = null;

function buildCam() {
  if (CAM) return CAM;
  const S = STERN_AA;
  const mz = zOf(S.z);
  // Where the trunnions are, above the water. Everything the cam clears is
  // measured against this and not against the deck: a gun whose axis is four
  // metres up needs less lift to clear a deckhouse than one on the deck does.
  const trunnion = deckY(S.z) + S.ringH + S.trunnionY;
  const floor = new Float32Array(CAM_BINS).fill(S.elevMin);
  const covers = [];

  for (const b of obstructions()) {
    // The bearings of its four corners. Nothing on this ship is astern of the
    // aftermost mounting, so none of these intervals wraps through 180 — which
    // is asserted rather than assumed, because a wrapped interval filled the
    // wrong way round would cut out the whole horizon and read as a broken gun.
    const bs = [];
    for (const x of [b.x0, b.x1]) {
      for (const z of [b.z0, b.z1]) {
        bs.push(Math.atan2(-x, z - mz) / DEG);
      }
    }
    let lo = Math.min(...bs);
    let hi = Math.max(...bs);
    if (hi - lo > 180) continue; // it is all round us: not something to cut for
    // The nearest point of it, in plan. Using the near face over the whole of
    // the bearing it covers is the conservative reading — the cam lifts a little
    // early at the edges, which is what you want of it.
    const nx = Math.max(b.x0, Math.min(0, b.x1));
    const nz = Math.max(b.z0, Math.min(mz, b.z1));
    const d = Math.max(Math.hypot(nx - 0, nz - mz), 2);
    const lift = Math.atan2((b.top + S.camClear) - trunnion, d) / DEG + S.camMargin;
    if (lift <= S.elevMin) continue;
    covers.push({ name: b.name, from: lo, to: hi, lift });
    lo = Math.floor(lo);
    hi = Math.ceil(hi);
    for (let a = lo; a <= hi; a++) {
      const i = ((a % CAM_BINS) + CAM_BINS) % CAM_BINS;
      if (lift > floor[i]) floor[i] = lift;
    }
  }
  CAM = { floor, covers };
  return CAM;
}

// The cam, read. Linear between the one-degree bins, because a stepped floor is
// a gun that judders as it trains.
export function cutoutFloorAt(yawDeg) {
  const { floor } = buildCam();
  const a = (((yawDeg % 360) + 360) % 360);
  const i = Math.floor(a);
  const f = a - i;
  const j = (i + 1) % CAM_BINS;
  return floor[i % CAM_BINS] * (1 - f) + floor[j] * f;
}

// What the cam is cut to, for anybody who wants to say so out loud. Reported on
// the debug object rather than being invisible: a gun that will not come down on
// a bearing should be able to tell you what it is refusing to shoot.
export const cutoutProfile = () => buildCam().covers;

// --- where the layer sits -----------------------------------------------------
//
// On the mounting, on the port side of the cradle, a little behind the
// trunnions. This is in the mount's own frame — it trains with the gun, which is
// the whole difference between this station and a turret's: a turret layer sits
// in a room looking down a gyro-stabilised telescope, and this one is sitting on
// the machine with the sea and the sky going round him.
export const SEAT = {
  // Well outboard: the seats hang off the sides of the mounting rather than
  // sitting on it, which is both what a quadruple automatic actually looks like
  // and the only place a man can sit and still see past the shield.
  x: 1.80, // port; starboard is -x
  y: 1.55, // above the tub floor, seated — level with the breeches
  z: -0.30, // just abaft the trunnions
  foot: 0.95, // the footplate he braces on, which is the height the crew stand at
};

// The ring sight, on its standard in front of him: a hoop of steel with a bead
// on a post half a metre beyond it, which is the whole instrument.
//
// It is modelled rather than only drawn, and the eye goes *on its axis* — you
// are looking through the actual ring, not at a ring painted on the glass. What
// the sight in player/gunsight.js then draws is the rest of the graticule: the
// inner ring, the posts, and the pip that says where the guns have got to.
//
// The two cannot disagree about size, because the drawn ring is told what angle
// the steel one subtends. That is `SIGHT_RING` below, and it is why the eye's
// setback is a named number rather than a literal buried in a function.
const SIGHT = { x: SEAT.x, y: 2.34, z: 0.62, ring: 0.115 };
const EYE_BACK = 0.55; // m the eye sits behind the ring

// The half-angle the steel ring subtends from the eye, in degrees. Everything
// that draws a ring sight is sized off this.
export const SIGHT_RING = (Math.atan(SIGHT.ring / EYE_BACK) * 180) / Math.PI;

// --- the mount ----------------------------------------------------------------

export function createSternAA({ materials }) {
  const S = STERN_AA;
  const slot = materials.slotOf(S.id);
  const damage = materials.handleFor(S.id);
  const mk = (g, color, roughness = 0.45) => paint(g, { color, roughness, slot });
  const M = materials.body;

  const root = new Group();
  const fixed = []; // everything that does not train, merged into one mesh

  // The barbette and the two courses of plating skirted round it. Drawn as
  // twenty-four-sided prisms, which at this radius is a circle, and collided as
  // the cylinders they are — see `sternAADais` in colliders.js, which is built
  // off the same `daisTiers`.
  for (const t of daisTiers()) {
    fixed.push(mk(
      place(new CylinderGeometry(t.r, t.r * 1.02, t.y1 - t.y0, 24), 0, (t.y0 + t.y1) / 2, 0),
      STEEL,
    ));
  }
  // A darker tread plate on each step, so the courses read as steps to walk up
  // rather than as a cake stand.
  for (const t of daisTiers()) {
    if (t.y1 >= S.ringH - 1e-6) continue;
    fixed.push(mk(
      place(new CylinderGeometry(t.r * 1.005, t.r * 1.005, 0.04, 24), 0, t.y1 - 0.02, 0),
      STEEL_DARK, 0.6,
    ));
  }

  // Ready-use ammunition, on the platform round the mounting. It used to be in
  // lockers against the inside of the tub; with the tub gone it stands on the
  // deck plating instead, out on the after quarters where the loaders work and
  // clear of the arc the shield sweeps through.
  for (const bearing of [140, 180, 220]) {
    const a = bearing * DEG;
    const g = new BoxGeometry(1.4, 0.66, 0.55);
    g.rotateY(-a);
    g.translate(-3.3 * Math.sin(a), S.ringH + 0.33, 3.3 * Math.cos(a));
    fixed.push(mk(g, STEEL_DARK, 0.5));
  }

  // The training base the whole mounting turns on, which does *not* turn.
  fixed.push(mk(
    place(new CylinderGeometry(1.95, 2.15, 0.30, 16), 0, S.ringH + 0.15, 0),
    STEEL_DARK, 0.4,
  ));
  root.add(new Mesh(merge(fixed), M));

  // --- and everything that trains ---------------------------------------------
  const yawPivot = new Object3D();
  yawPivot.position.y = S.ringH;
  root.add(yawPivot);
  const carriage = [];

  // the roller path and the body of the mounting standing on it
  carriage.push(mk(new CylinderGeometry(1.80, 1.80, 0.34, 16).translate(0, 0.17, 0), STEEL_DARK, 0.4));
  carriage.push(mk(box(2.70, 1.30, 2.00, 0, 0.99, -0.10), STEEL));
  // the two trunnion standards the cradle swings between
  for (const side of [-1, 1]) {
    carriage.push(mk(box(0.34, 0.95, 0.80, side * 1.42, S.trunnionY - 0.40, S.trunnionZ), STEEL));
  }
  // The gun shield: a plate across the front of the mounting at the layer's
  // shoulder. Not armour — it is there to keep the blast of the barrels off the
  // men standing behind them, which is what a shield on an automatic is for.
  //
  // It stops short of the seats, and that is the whole of why it is 2.7 m wide
  // and not 3.6: the two men sit *outboard* of it and look past its edges. A
  // shield drawn across the full breadth of the mounting is a plate directly in
  // front of the layer's face, which is a gun you cannot see out of — and it is
  // exactly what real mountings avoid by cutting sighting ports through it.
  //
  // A single sloped plate across the front of the mounting, from just above the
  // platform up to just under the trunnions, leaning back over the crew. Its
  // pitch is worked out from the four numbers in spec.js rather than eyeballed,
  // so moving the trunnions moves the shield with them.
  //
  // It stops short of the seats on either side, and that is deliberate: the two
  // men sit *outboard* of it and look past its edges. A plate drawn across the
  // full breadth of the mounting is a plate directly in front of the layer's
  // face, which is a gun you cannot see out of — and it is exactly what real
  // mountings avoid by cutting sighting ports through it.
  {
    const dz = S.shieldFoot - S.shieldHead;
    const dy = S.shieldHigh - S.shieldLow;
    const len = Math.hypot(dz, dy);
    const face = new BoxGeometry(S.shieldHalfW * 2, len, S.shieldPlate);
    // lean it back: the top edge is aft of the bottom one
    face.rotateX(-Math.atan2(dz, dy));
    face.translate(0, (S.shieldLow + S.shieldHigh) / 2, (S.shieldFoot + S.shieldHead) / 2);
    carriage.push(mk(face, STEEL));
    // The wings. A flat plate protects the man behind it and nobody beside him,
    // so it is wrapped back down each side — angled outward, which is both what
    // makes it read as a shield rather than as a signboard and what keeps a
    // fragment coming in on the bow from going straight down the inside of it.
    for (const side of [-1, 1]) {
      const wing = new BoxGeometry(S.shieldPlate, dy * 0.86, S.shieldWing);
      wing.rotateY(side * 0.22);
      wing.translate(
        side * (S.shieldHalfW - 0.06),
        S.shieldLow + dy * 0.47,
        (S.shieldFoot + S.shieldHead) / 2 - S.shieldWing * 0.45,
      );
      carriage.push(mk(wing, STEEL));
    }
    // a rolled top edge, so the plate does not read as a piece of card
    const cap = new BoxGeometry(S.shieldHalfW * 2, 0.10, 0.20);
    cap.translate(0, S.shieldHigh, S.shieldHead);
    carriage.push(mk(cap, STEEL_DARK, 0.4));
  }

  // The two men on the mounting: a seat each side, the layer to port with the
  // sight, the trainer to starboard with the handwheels. Both are modelled
  // because the player walks past them to get to the gear, and an empty machine
  // with no seats on it does not read as something a person works.
  for (const side of [-1, 1]) {
    const x = side * SEAT.x;
    carriage.push(mk(box(0.46, 0.09, 0.44, x, SEAT.y, SEAT.z), STEEL_DARK, 0.6));
    carriage.push(mk(box(0.46, 0.52, 0.08, x, SEAT.y + 0.31, SEAT.z - 0.22), STEEL_DARK, 0.6));
    carriage.push(mk(box(0.16, 0.58, 0.16, x, SEAT.y - 0.32, SEAT.z), STEEL_DARK, 0.5));
    // a footplate to brace against, which is the whole of how a man stays on a
    // mounting that trains at forty-six degrees a second
    carriage.push(mk(box(0.62, 0.07, 0.58, x, SEAT.foot, SEAT.z + 0.50), STEEL_DARK, 0.6));
    carriage.push(mk(box(0.20, SEAT.y - SEAT.foot, 0.20, x, (SEAT.y + SEAT.foot) / 2, SEAT.z + 0.50), STEEL_DARK, 0.5));
    // the handwheel, on its shaft
    const wheel = new TorusGeometry(0.20, 0.030, 6, 14);
    wheel.rotateY(Math.PI / 2);
    wheel.translate(x - side * 0.32, SEAT.y + 0.44, SEAT.z + 0.36);
    carriage.push(mk(wheel, STEEL_DARK, 0.45));
  }

  // The ring sight on its standard, in front of the layer.
  {
    carriage.push(mk(box(0.09, 0.70, 0.09, SIGHT.x, SIGHT.y - 0.35, SIGHT.z), STEEL_DARK, 0.4));
    const ring = new TorusGeometry(SIGHT.ring, 0.014, 6, 18);
    ring.translate(SIGHT.x, SIGHT.y, SIGHT.z);
    carriage.push(mk(ring, STEEL_DARK, 0.4));
    // the bead, half a metre out in front of the ring: the two together are the
    // sight, and the lead you take is the target sitting on the ring rather than
    // on the bead
    carriage.push(mk(box(0.022, 0.16, 0.022, SIGHT.x, SIGHT.y - 0.09, SIGHT.z + 0.52), STEEL_DARK, 0.4));
    carriage.push(mk(box(0.030, 0.030, 0.030, SIGHT.x, SIGHT.y, SIGHT.z + 0.52), [0.75, 0.66, 0.22], 0.5));
  }
  yawPivot.add(new Mesh(merge(carriage), M));

  // --- how hot the barrels are --------------------------------------------------
  //
  // The heat gauge on the layer's plate is a number, and a number is a poor way
  // to say "this gun is about to stop". So it is also *on the gun*: an additive
  // sleeve over the breech end of each barrel, black until the racks have been
  // worked hard and then a dull red that anybody standing on the quarterdeck can
  // see. It is one material shared by all four, because all four are fired in
  // turn and are therefore always at the same temperature.
  //
  // Additive and unlit, so it adds light to the barrel rather than painting it —
  // hot steel emits, it does not reflect — and squared, so the first half of the
  // gauge shows almost nothing and the last quarter is unmistakable.
  const heatMat = new MeshBasicNodeMaterial();
  heatMat.vertexColors = true;
  heatMat.transparent = true;
  heatMat.depthWrite = false;
  heatMat.blending = AdditiveBlending;
  heatMat.toneMapped = false;
  heatMat.opacity = 0;

  // The sleeve itself: a metre and a half over the chamber end and no further,
  // graded from red at the breech to nothing before it reaches the middle of the
  // barrel. A gun does not heat evenly — what gets hot is the chamber and the
  // first few calibres of rifling, which is where the powder actually burns —
  // and a barrel glowing all the way to the muzzle reads as a lightsabre.
  const HEAT_LEN = 1.5;
  function heatSleeve() {
    const g = new CylinderGeometry(S.barrelR * 2.5, S.barrelR * 1.7, HEAT_LEN, 10, 1, true)
      .rotateX(Math.PI / 2)
      .translate(0, 0, 0.20 + HEAT_LEN / 2);
    const pos = g.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const f = 1 - Math.min(1, Math.max(0, (pos.getZ(i) - 0.20) / HEAT_LEN));
      // red at the chamber, dying off along the barrel, and never white: steel
      // this hot is a dull cherry and nothing brighter
      col[i * 3] = 1.0 * f; col[i * 3 + 1] = 0.20 * f * f; col[i * 3 + 2] = 0.04 * f * f;
    }
    g.setAttribute('color', new (pos.constructor)(col, 3));
    return g;
  }

  // --- the guns ---------------------------------------------------------------
  //
  // Four barrels abreast on one cradle. Every elevation pivot is at the *same*
  // place — on the training axis, at the trunnions — and the barrels are offset
  // inside them, which is what makes four guns swing on one trunnion line
  // instead of four parallel ones. The cradle itself hangs off the first of
  // them, so it elevates with the guns and stays put when they recoil.
  const guns = [];
  const half = ((S.barrels - 1) * S.barrelSpacing) / 2;
  for (let i = 0; i < S.barrels; i++) {
    const pivot = new Object3D();
    pivot.position.set(0, S.trunnionY, S.trunnionZ);
    yawPivot.add(pivot);
    const barrel = makeBarrel(S.barrelLength, S.barrelR, mk, M);
    barrel.position.x = -half + i * S.barrelSpacing;
    pivot.add(barrel);
    // The water jacket over the breech end. It recoils with the gun, because it
    // is part of the gun — which is why it hangs off the barrel and not off the
    // cradle beside it.
    const jacket = new Mesh(mk(
      new CylinderGeometry(S.barrelR * 2.3, S.barrelR * 2.3, 1.15, 10)
        .rotateX(Math.PI / 2).translate(0, 0, 0.62),
      STEEL_DARK, 0.4,
    ), M);
    barrel.add(jacket);
    // The flash hider on the muzzle.
    //
    // Not decoration and not only a silhouette: a cone of steel round the muzzle
    // is what an automatic carries because its own flash, nine times a second,
    // blinds the layer sitting a metre and a half behind it. It is the fitting
    // that exists *because* the gun fires fast, which is why it is on this gun
    // and not on the sixteen-inch ones.
    barrel.add(new Mesh(mk(
      new CylinderGeometry(S.barrelR * 2.4, S.barrelR * 1.5, 0.34, 8, 1, true)
        .rotateX(Math.PI / 2).translate(0, 0, S.barrelLength - 0.15),
      STEEL_DARK, 0.45,
    ), M));
    // ...and the heat. See `heatMaterial` below: an additive sleeve over the
    // breech end of the barrel, invisible until the gun has been fired hard.
    const glow = new Mesh(heatSleeve(), heatMat);
    glow.frustumCulled = false;
    glow.renderOrder = 20;
    barrel.add(glow);
    guns.push({ pivot, barrel, length: S.barrelLength });
  }
  // the cradle, on the first pivot: it elevates, it does not recoil
  guns[0].pivot.add(new Mesh(merge([
    mk(box(half * 2 + 0.9, 0.42, 1.25, 0, -0.02, 0.10), STEEL),
    mk(box(half * 2 + 0.6, 0.30, 0.40, 0, -0.26, -0.55), STEEL_DARK, 0.4),
  ]), M));

  // The four clips standing up behind the breeches — their own object, because
  // they *move*.
  //
  // This is the whole of the ammunition state made visible, and it costs one
  // translation a frame. A quadruple automatic is loaded by hand from the top:
  // the loaders stand behind it pushing four-round clips down into the hoppers,
  // and what you see from twenty metres away is a stack of brass that sinks as
  // the racks empty and jumps back up when they are refilled. A rounds counter
  // on a plate tells the layer; this tells everybody else on the deck.
  const clips = new Mesh(merge(
    Array.from({ length: S.barrels }, (_, i) => mk(
      box(0.22, 0.62, 0.20, -half + i * S.barrelSpacing, 0.46, -0.42),
      [0.52, 0.40, 0.16], 0.35, // brass, not steel: these are the rounds
    )),
  ), M);
  clips.frustumCulled = false;
  guns[0].pivot.add(clips);

  // --- no lights ------------------------------------------------------------
  //
  // Every other manned space on this ship carries a pair of red battle lamps and
  // a white one over its door, and this one carries neither, because it is not a
  // space: it is a machine standing on an open platform. There is no door to
  // light the way to and no room for a lamp to be inside of, and a red glow
  // hanging over the quarterdeck from a gun that is simply *there* reads as a
  // fitting somebody forgot to take off. What lights this mounting at night is
  // its own muzzle flash — see the flash rig in shipMaterial.js — and nothing
  // else, which is the honest answer and much the more dramatic one.
  const lamps = [];

  root.traverse((o) => { o.castShadow = true; o.frustumCulled = false; });

  const mount = makeMount({
    id: S.id,
    kind: 'aa',
    root,
    yawPivot,
    guns,
    spec: { traverseRate: S.traverseRate, elevateRate: S.elevateRate },
    arcCenter: S.arcCenter,
    arc: S.arc,
    elevMin: S.elevMin,
    elevMax: S.elevMax,
    damage,
    barrelR: S.barrelR,
    elevFloor: cutoutFloorAt,
  });
  mount.lamps = lamps;
  // What the gun's own state looks like from outside it. Both are driven by the
  // station once a frame — see player/aaStation.js — so the machine on the deck
  // and the plate in the sight are reading the same two numbers.
  mount.setHeat = (h) => { heatMat.opacity = Math.min(1, h * h * 0.7); };
  mount.setLoad = (f) => {
    clips.position.y = (Math.min(1, Math.max(0, f)) - 1) * 0.52;
    clips.visible = f > 0.02;
  };
  mount.station = { z: S.z, id: S.id };
  // Everything the trigger needs to know about the machine, in one place, so the
  // station in player/aaStation.js is about *laying* and not about the gun.
  mount.automatic = {
    cyclic: S.cyclic,
    clip: S.clip,
    reload: S.reload,
    heatPerRound: S.heatPerRound,
    cool: S.cool,
    resume: S.resume,
    spread: S.spread,
    // everything one round does to the machine and to the air round it
    recoilScale: S.recoilScale,
    recoilIn: S.recoilIn,
    recoilOut: S.recoilOut,
    flashLife: S.flashLife,
    lightLife: S.lightLife,
    discScale: S.discScale,
    ballScale: S.ballScale,
    smokeScale: S.smokeScale,
    smokePuff: S.smokePuff,
    shudderRise: S.shudderRise,
    shudderSwing: S.shudderSwing,
    caseSpeed: S.caseSpeed,
    // Where the empties land. Quoted here rather than worked out by whoever
    // fires the gun, because it is a fact about this mounting and not about
    // firing: the tub floor is what is under the breeches.
    caseFloor: deckY(S.z) + S.ringH + 0.05,
  };
  return mount;
}

// two small helpers, so the geometry above reads as a list of parts
function place(g, x, y, z) { g.translate(x, y, z); return g; }
function box(w, h, d, x, y, z) { return place(new BoxGeometry(w, h, d), x, y, z); }

// --- what the player walks into ------------------------------------------------
//
// Only the machine. The platform under it is three plain cylinders and belongs
// in colliders.js with everything else that is simply solid — see
// `sternAADais` — because with the tub gone there is no longer a *room* here to
// be inside of, and that was the whole reason the old arrangement needed a
// second, door-shaped description of itself for the player.
//
// What is left is the part that turns, and it has to be in the mount's own frame
// for the same reason a gunhouse does: standing where the guns are coming round
// should shove you out of the way, and on a mounting doing forty-six degrees a
// second it very much should.
export function sternAASolids() {
  const S = STERN_AA;
  const y0 = deckY(S.z) + S.ringH; // the platform they all stand on
  const cz = zOf(S.z);
  const halfBarrels = ((S.barrels - 1) * S.barrelSpacing) / 2;
  return [
    // The body of the mounting: the pedestal, the cradle and the two seats
    // hanging off its sides. Wide enough to take the seats, which stand a good
    // way outboard of the machine and were the thing you used to be able to walk
    // through.
    {
      id: `${S.id}.body`,
      mount: S.id,
      pivotZ: cz,
      c: [0, y0 + 1.20, cz - 0.10],
      h: [2.10, 1.20, 1.10],
    },
    // The shield, out in front of it and sloped. Boxed upright rather than
    // leaned, because the difference over 0.8 m of run is smaller than the
    // player's own radius and a tilted collider buys nothing but arithmetic.
    {
      id: `${S.id}.shield`,
      mount: S.id,
      pivotZ: cz,
      c: [0, y0 + (S.shieldLow + S.shieldHigh) / 2, cz + (S.shieldHead + S.shieldFoot) / 2],
      h: [
        S.shieldHalfW + 0.05,
        (S.shieldHigh - S.shieldLow) / 2 + 0.08,
        (S.shieldFoot - S.shieldHead) / 2 + S.shieldWing * 0.5,
      ],
    },
    // The barrels, reaching out over the shield. Set high enough that a man can
    // walk under them out towards the muzzles, which he can and should.
    {
      id: `${S.id}.guns`,
      mount: S.id,
      pivotZ: cz,
      c: [0, y0 + S.trunnionY, cz + S.trunnionZ + S.barrelLength / 2],
      h: [halfBarrels + S.barrelR * 3, S.barrelR * 4, S.barrelLength / 2],
    },
  ];
}

// The patch of deck the mounting stands on, as a footprint for anything that has
// to keep off it — deck props, mostly. The steps are part of it: a crate at the
// foot of them is a gun you have to jump onto.
export function sternAAFootprint() {
  const S = STERN_AA;
  const r = daisRadius() + 0.9;
  return {
    x: 0,
    z: zOf(S.z),
    r,
    y0: deckY(S.z),
    y1: deckY(S.z) + S.ringH + S.trunnionY,
  };
}

// Where the layer's gear is, in the ship's own frame, and where to stand to take
// hold of it. Both are quoted at the mount's resting bearing, which is where it
// is when you climb in — the seat swings with the machine, and walking up to a
// mounting trained hard round means walking to where it has got to.
export function sternAAStation() {
  const S = STERN_AA;
  return {
    // dead centre of the mounting, at the height of the seat: you take the gear
    // by climbing onto the mounting, whichever way it happens to be pointing
    station: { x: 0, y: deckY(S.z) + S.ringH + SEAT.y, z: zOf(S.z) },
    // A pace and a half aft of the mounting: clear of the body of it — which is
    // four metres across and turning — and inside arm's reach of the gear. Any
    // nearer and you arrive inside the machine.
    approach: {
      x: 0,
      y: deckY(S.z) + S.ringH,
      z: zOf(S.z) - 3.0,
    },
  };
}

// The eye, in the mount's own frame: on the ring's axis, half a metre behind it.
export const sternAASight = () => ({ x: SIGHT.x, y: SIGHT.y, z: SIGHT.z - EYE_BACK });
