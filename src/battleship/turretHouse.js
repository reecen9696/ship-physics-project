import {
  BoxGeometry, CylinderGeometry, Group, Mesh, SphereGeometry, TorusGeometry, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { boxHit } from './colliders.js';
import { TURRET_SPEC } from './spec.js';
import { STEEL, STEEL_DARK, PAINT, deckY, zOf } from './hull.js';

// Inside a gunhouse.
//
// One description, used three times: as the collision the player walks against,
// as the plating they can see, and as the doorway the space transition tests.
// Writing it once is the point — a liner that disagrees with its collision is a
// wall you can see through or a floor you fall out of, and there is no way to
// notice either until you are standing in it.
//
// Everything here is in the turret's own frame: the origin is the centre of the
// roller path, y = 0 is the gunhouse floor line, +z is the way the guns point,
// and the whole lot turns with `yawPivot`. That frame is a *space* — see
// player/mountSpace.js — for exactly the reason the ship is one. A gunhouse
// trains at ten degrees a second, and ten degrees a second under the feet of
// somebody standing eight metres off the axis is a metre and a half a second of
// deck moving sideways. Collide against it and you are back to the problem the
// whole architecture exists to avoid; step inside it and it is a room that never
// moves.
//
// It is a small room, and deliberately: two 16-inch breeches come through the
// front of it and take the middle, so the working space is the U around them
// and the width of a corridor down each side.

const S = TURRET_SPEC;

// Deck grey and bulkhead grey, a good deal lighter than her outside plating,
// because everything in here is seen at a tenth of the light and a colour that
// works in the sun is black in a gunhouse.
const LINER = [0.50, 0.53, 0.55];
const LINER_DECK = [0.34, 0.36, 0.38];

const HOUSE_Z = -1.0; // where the gunhouse sits on the roller path (mounts.js)
const WALL = 0.18; // liner thickness
export const PLATE = 0.2; // the side plating the door and the window are cut in

// The gunhouse is an extruded profile with a sloped face and a lower rear, so
// the box you can fit inside it is a good deal smaller than its bounding box:
// the roof only runs from `-l/2 + 1.0` to `l/2 - 2.6`, and a liner sized off the
// nominal length pokes out through the face as a black slab you can see from the
// forecastle. These numbers are cut to the *profile*, not to the dimensions.
export const HOUSE = {
  // the room, inside the liner
  // The room reaches the side plating, because the plating *is* the wall — see
  // `roomRect` and the note on hollowness below.
  halfW: S.gunhouseW / 2 - PLATE,
  fwd: HOUSE_Z + S.gunhouseL / 2 - 3.0, // inside where the face starts to slope
  aft: HOUSE_Z - S.gunhouseL / 2 + 1.3, // and inside where the rear drops away
  floor: 0.2,
  ceiling: S.gunhouseH - 0.45, // 2.95 m of headroom, and the deckhead slab still
  // under the roof plating rather than through it

  // The door, one each side. It is a hole through the extruded gunhouse profile,
  // so it comes out as a doorway to port and one to starboard for free — which
  // is what a turret has, and which means the ladder can stand on whichever side
  // of her you happen to be walking down.
  // Sized to walk through rather than to duck through: 2.70 m of clear height
  // and 1.8 m of width, against a man 1.78 m tall and 0.68 m across. The
  // gunhouse was raised to 3.6 m to carry it.
  door: {
    z: -3.2, // well aft of the breeches, in the working space
    halfLen: 0.9,
    sill: 0.2, // flush with the deck: no coaming to trip over on the way in
    head: 2.80,
  },

  // Vision slits, one each side at head height.
  //
  // A turret with no way to see out of it is a metal room, and the whole reason
  // to stand in one is to look at what you are shooting at. Real gunhouses have
  // sighting ports in the side plating for exactly this; these are the same hole
  // through the same extruded profile the door is, just smaller and higher, so
  // they open to port and starboard together and cost nothing to cut.
  window: {
    z: 0.6, // between the breeches and the front, where a man would stand
    halfLen: 1.2,
    sill: 1.45,
    head: 2.15,
  },

  // Where the guns' breeches sit inside — the reason the middle of the room is
  // not walkable.
  breech: { x: S.barrelSpacing / 2, y: S.gunhouseH * 0.42, r: 0.62, fwd: 1.9, aft: -1.7 },

  // The layer's station: a pedestal with the training and elevating gear on it,
  // standing outboard of the starboard breech and facing forward.
  station: { x: -3.05, z: -1.3, y: 0 },

  // And the sighting hood, which is where the eye goes when you take the gun.
  // Outside the roof and offset to starboard, because that is where a turret's
  // sighting hoods are and because from anywhere inside the house you would be
  // looking at your own barrels.
  sight: { x: -3.5, y: S.gunhouseH + 0.55, z: 0.8 },

  houseZ: HOUSE_Z,
  wall: WALL,
};

// --- the working chamber, for a turret that stands on a bandstand -------------
//
// B and X sit four metres up. A door in the side of a gunhouse that high is a
// door with nothing under it, and the only honest way to reach one is the trunk
// inside the barbette — which turns with the guns, so nothing fixed can meet it.
// So they do not get a room in the gunhouse at all. They get one in the
// *bandstand*, which is where a real ship puts the working chamber, and which is
// at deck level, and which does not turn.
//
// The consequence is worth stating plainly, because it is the whole reason the
// two are different: A and Y are rooms in the *turret's* space, and roll round
// under the sea's horizon as the guns train. B and X are rooms in the *ship's*,
// and do not. Neither is a compromise; they are different structures and the
// architecture just says so.
export function chamber(turret) {
  const w = S.barbetteR * 2.5; // the bandstand, as mounts.js builds it
  const outerX = w / 2;
  const outerZ = (w * 1.15) / 2;
  const facing = Math.abs(turret.arcCenter) > 90 ? -1 : 1;
  const floor = 0.15;
  return {
    facing,
    halfX: outerX - PLATE, // the side plating is the wall — see `chamberRoomRect`
    halfZ: outerZ - 0.8,
    outerX,
    outerZ,
    floor,
    // Headroom, capped: a four-metre bandstand would otherwise give a room with
    // a ceiling nobody can see the point of.
    ceiling: Math.min(turret.bandstand - 0.4, floor + 3.15),
    top: turret.bandstand,
    // The barbette trunk comes down through the middle of it, which is what
    // makes this a room to walk round rather than across.
    trunkR: 2.55,
    doorZ: facing * HOUSE.door.z,
    station: { x: -3.75, z: facing * -0.8 },
    origin: [0, deckY(turret.z), zOf(turret.z)],
  };
}

// Thick for collision, thin for the eye. The panels fill all the way out to the
// bandstand's skin so there is no half-metre of nothing between the room and the
// outside, but they are *drawn* as linings against the inner face, because two
// coincident surfaces at the skin is a z-fight you can see from the bridge.
export function chamberPanels(turret) {
  const c = chamber(turret);
  const d = HOUSE.door;
  const out = [];
  const midY = (c.floor + c.ceiling) / 2;
  const halfH = (c.ceiling - c.floor) / 2;
  const LIN = 0.09; // how thick a lining is drawn
  // `c`/`h` are the solid the player walks against, filling out to the
  // bandstand's own skin; `mesh` is the lining drawn against its inner face.
  const add = (id, box, mesh, look) => out.push({
    id, c: box[0], h: box[1], mesh: { c: mesh[0], h: mesh[1] }, look,
  });

  add('chamber.floor',
    [[0, c.floor / 2 - 0.6, 0], [c.outerX, c.floor / 2 + 0.6, c.outerZ]],
    [[0, c.floor - LIN, 0], [c.halfX, LIN, c.halfZ]],
    { shell: true });
  add('chamber.head',
    [[0, (c.ceiling + c.top) / 2, 0], [c.outerX, (c.top - c.ceiling) / 2, c.outerZ]],
    [[0, c.ceiling + LIN, 0], [c.halfX, LIN, c.halfZ]],
    { shell: true });

  for (const sign of [-1, 1]) {
    add('chamber.end',
      [[0, midY, sign * (c.halfZ + c.outerZ) / 2], [c.outerX, halfH, (c.outerZ - c.halfZ) / 2]],
      [[0, midY, sign * (c.halfZ - LIN)], [c.halfX, halfH, LIN]],
      { shell: true });
  }

  // The two sides, in pieces, so the passage through the bandstand is a passage
  // and not a wall with a hole painted on it.
  for (const side of [-1, 1]) {
    const x = side * (c.halfX + c.outerX) / 2;
    const t = (c.outerX - c.halfX) / 2;
    // The lining is drawn against the inner face; the solid behind it already
    // fills out to the bandstand skin, so the passage is a reveal rather than a
    // hallway with a loose wall in it.
    const lx = side * (c.halfX - LIN);
    // Overlapping, because two boxes that share a face z-fight along it, and a
    // door jamb is exactly where you stand looking at one.
    const LAP = 0.03;
    const seg = (z0, z1) => add('chamber.side',
      [[x, midY, (z0 + z1) / 2], [t, halfH, (z1 - z0) / 2]],
      [[lx, midY, (z0 + z1) / 2], [LIN, halfH, (z1 - z0) / 2]],
      { shell: true });
    seg(-c.halfZ, c.doorZ - d.halfLen + LAP);
    seg(c.doorZ + d.halfLen - LAP, c.halfZ);
    add('chamber.side',
      [[x, (d.head + c.ceiling) / 2, c.doorZ], [t, (c.ceiling - d.head) / 2 + LAP, d.halfLen]],
      [[lx, (d.head + c.ceiling) / 2, c.doorZ], [LIN, (c.ceiling - d.head) / 2 + LAP, d.halfLen]],
      { shell: true });
  }

  // the barbette trunk, down the middle
  add('chamber.trunk',
    [[0, midY, 0], [c.trunkR, halfH, c.trunkR]],
    [[0, midY, 0], [c.trunkR, halfH, c.trunkR]],
    { color: STEEL_DARK, rough: 0.4, metal: 0.85, cylinder: true });

  // and the gear
  add('chamber.station',
    [[c.station.x, c.floor + 0.5, c.station.z], [0.62, 0.5, 0.45]],
    [[c.station.x, c.floor, c.station.z], [0, 0, 0]],
    { terminal: true });

  return out;
}

// The same panels, in the SHIP's frame, which is where the player's collision
// against them happens: the bandstand does not train, so its room is part of the
// ship exactly as the deck is.
export function chamberSolids(turret) {
  const [ox, oy, oz] = chamber(turret).origin;
  return chamberPanels(turret).map((p) => ({
    id: `${turret.id}.${p.id}`,
    c: new Vector3(p.c[0] + ox, p.c[1] + oy, p.c[2] + oz),
    h: new Vector3(p.h[0], p.h[1], p.h[2]),
  }));
}

// Where the layer stands, in the ship's frame — what the "take the gun" prompt
// measures its distance to.
export function chamberStation(turret) {
  const c = chamber(turret);
  return new Vector3(c.station.x + c.origin[0], c.floor + c.origin[1], c.station.z + c.origin[2]);
}

// The room, as a rectangle in the profile's own coordinates.
//
// This is the shape that gets punched out of the gunhouse's section to make the
// house hollow, and it is the same rectangle the side plates fill. One number
// for both, because a room whose walls disagree with its ceiling is a room with
// a seam you can see through.
export function roomRect() {
  return {
    z0: HOUSE.aft - HOUSE_Z,
    z1: HOUSE.fwd - HOUSE_Z,
    y0: HOUSE.floor,
    y1: HOUSE.ceiling,
  };
}

// A hole in the *profile* the gunhouse is extruded from. The extrusion runs
// across the beam, so one hole in the 2D shape is a doorway through both sides.
// mounts.js asks for this when it lofts the house — and only for a turret whose
// room is up there, which is to say only for one that is not on a bandstand.
export function doorHole(shapeClass) {
  return [HOUSE.door, HOUSE.window].map((o) => {
    const z0 = o.z - HOUSE.houseZ - o.halfLen; // the profile is in the house's own z
    const z1 = o.z - HOUSE.houseZ + o.halfLen;
    const hole = new shapeClass();
    hole.moveTo(z0, o.sill);
    hole.lineTo(z1, o.sill);
    hole.lineTo(z1, o.head);
    hole.lineTo(z0, o.head);
    hole.closePath();
    return hole;
  });
}

// A flat wall with rectangular holes in it, as a list of boxes.
//
// Openings are `{ z, halfLen, sill, head }` and must not overlap along the wall.
// The pieces lap over each other by a few centimetres, because two boxes that
// share a face z-fight along it and a door jamb is exactly where you stand
// looking at one.
const LAP = 0.03;
function wallPieces(zMin, zMax, yMin, yMax, openings) {
  const holes = [...openings].sort((a, b) => a.z - b.z);
  const out = [];
  const full = (z0, z1) => {
    if (z1 - z0 < 0.02) return;
    out.push({ z: (z0 + z1) / 2, hz: (z1 - z0) / 2, y: (yMin + yMax) / 2, hy: (yMax - yMin) / 2 });
  };
  let z = zMin;
  for (const o of holes) {
    full(z, o.z - o.halfLen + LAP);
    // over the opening, and under it
    if (yMax - o.head > 0.02) {
      out.push({
        z: o.z, hz: o.halfLen, y: (o.head + yMax) / 2, hy: (yMax - o.head) / 2 + LAP,
      });
    }
    if (o.sill - yMin > 0.02) {
      out.push({
        z: o.z, hz: o.halfLen, y: (yMin + o.sill) / 2, hy: (o.sill - yMin) / 2 + LAP,
      });
    }
    z = o.z + o.halfLen - LAP;
  }
  full(z, zMax);
  return out;
}

// --- the boxes ---------------------------------------------------------------
//
// `slabs()` is the list both the liner and the collision are built from. Each is
// { id, c: [x,y,z], h: [x,y,z], look } — `look` is only read by the mesh builder.

export function slabs() {
  const H = HOUSE;
  const d = H.door;
  const midZ = (H.fwd + H.aft) / 2;
  const halfL = (H.fwd - H.aft) / 2;
  const midY = (H.floor + H.ceiling) / 2;
  const halfH = (H.ceiling - H.floor) / 2;
  const out = [];
  const add = (id, c, h, look) => out.push({ id, c, h, look });

  // deck and deckhead
  // The deck, the deckhead, the bulkheads and the sides are all *drawn* by the
  // gunhouse itself now that it is hollow — its own inner surfaces are the room.
  // They stay in this list because the room still has to be solid to walk in;
  // `shell` marks them as collision-only so nothing is drawn twice.
  add('house.floor', [0, H.floor - WALL, midZ], [H.halfW + WALL, WALL, halfL + WALL],
    { shell: true });
  add('house.head', [0, H.ceiling + WALL, midZ], [H.halfW + WALL, WALL, halfL + WALL],
    { shell: true });

  // fore and aft bulkheads
  add('house.fore', [0, midY, H.fwd + WALL], [H.halfW, halfH, WALL], { shell: true });
  add('house.aft', [0, midY, H.aft - WALL], [H.halfW, halfH, WALL], { shell: true });

  // The two sides, in pieces, so the openings in them are holes rather than
  // things to be subtracted.
  //
  // They run all the way out to the gunhouse skin rather than standing a lining's
  // thickness inside it. A thin lining leaves a third of a metre of unclaimed
  // space between it and the plating, and because that space is inside the hole
  // cut through the skin it is a little hallway with a wall in it you can walk
  // straight through. Filling it makes each opening a *reveal*: room, jamb,
  // outside, with nothing loose in between.
  const skin = S.gunhouseW / 2 - 0.02; // just inside the plating, to keep off it
  const sideMid = (H.halfW + skin) / 2;
  const sideHalf = (skin - H.halfW) / 2;
  for (const side of [-1, 1]) {
    for (const b of wallPieces(H.aft, H.fwd, H.floor, H.ceiling, [d, H.window])) {
      add('house.side', [side * sideMid, b.y, b.z], [sideHalf, b.hy, b.hz], { shell: true });
    }
  }

  // the breeches, as blocks: they are what makes the middle of the room a thing
  // to walk round rather than across
  const b = HOUSE.breech;
  for (const side of [-1, 1]) {
    add('house.breech', [side * b.x, b.y - 0.1, (b.fwd + b.aft) / 2],
      [b.r, b.r + 0.35, (b.fwd - b.aft) / 2],
      { color: STEEL_DARK, rough: 0.35, metal: 0.9, cylinder: true });
  }

  // the layer's gear — waist height, so it is a thing you walk up to rather than
  // a thing that blocks you
  add('house.station', [HOUSE.station.x, H.floor + 0.5, HOUSE.station.z], [0.62, 0.5, 0.5],
    { terminal: true });

  return out;
}

// The doorway from inside, as a volume against each side of the room. Walk into
// one of these and you are on your way out.
// Tested against a pair of *feet*, not against the opening.
//
// Stated as the doorway itself, its y range runs from the sill — which is the
// deck — and a strict inside-the-box test then misses a man standing on that
// deck by exactly nothing at all. He walks out of the door and falls eight
// metres to the forecastle, and there is no way to see why. Feet on the deck
// have to be comfortably inside it.
export function insideDoorVolumes() {
  const d = HOUSE.door;
  return [-1, 1].map((side) => ({
    side,
    c: new Vector3(side * (HOUSE.halfW - 0.15), HOUSE.floor + 0.4, d.z),
    h: new Vector3(0.9, 1.0, d.halfLen + 0.15),
  }));
}

// Where you stand when you have just come in — inside the door, facing across
// the room at the layer's station.
export function landing(side) {
  const d = HOUSE.door;
  return {
    // Well clear of the volume that takes you back out — the landing and the
    // way out have to be different places or you bounce straight back through.
    position: new Vector3(side * (HOUSE.halfW - 1.7), HOUSE.floor + 0.02, d.z),
    heading: side < 0 ? Math.PI / 2 : -Math.PI / 2,
  };
}

// --- getting in --------------------------------------------------------------
//
// The way in is at deck level, and on a superfiring turret that is not the
// gunhouse: B and X stand on a bandstand four metres up, and a door in the side
// of the house would be a door with nothing under it. So the door goes in the
// bandstand instead, where the working chamber is on a real ship, and the
// passage from there up into the gunhouse is the barbette trunk — which is the
// one place in all of this that a portal earns its keep, because the trunk turns
// with the guns and a ladder standing in a fixed structure cannot reach it at
// more than one bearing. On A and Y, whose houses sit less than a metre off the
// deck, the door is where you would expect it and three treads reach it.
//
// Returned in the SHIP's frame, at the turret's rest bearing, because the
// bandstand does not train and neither does the deck the player is standing on.
// These are triggers rather than geometry, so they are stated around where a
// pair of *feet* will be rather than around the opening: a doorway tested
// against the sole of a boot is a doorway you walk past.
export function entryVolumes(turret, deckAt, zAt) {
  const facing = Math.abs(turret.arcCenter) > 90 ? -1 : 1; // aft-facing turrets are mirrored
  const y0 = deckAt(turret.z);
  const z = zAt(turret.z) + facing * HOUSE.door.z;
  const d = HOUSE.door;

  if (turret.bandstand > 0) {
    // through the bandstand, at deck level
    const half = S.barbetteR * 2.5 / 2;
    return [-1, 1].map((side) => ({
      side: side * facing,
      inBandstand: true,
      c: new Vector3(side * (half - 0.4), y0 + 0.4, z),
      h: new Vector3(1.3, 0.8, d.halfLen + 0.15),
      sill: y0,
    }));
  }
  // straight into the house, a metre up
  const sill = y0 + turret.deckRise + d.sill;
  return [-1, 1].map((side) => ({
    side: side * facing,
    inBandstand: false,
    c: new Vector3(side * (HOUSE.halfW + WALL + 0.45), sill + 0.4, z),
    h: new Vector3(0.7, 0.8, d.halfLen + 0.1),
    sill,
  }));
}

// How tall the way through a bandstand is, above its deck.
export const BANDSTAND_DOOR_H = 2.6;

// The chamber, as a rectangle in the bandstand's profile coordinates — which are
// centred on the block, so the deck is at -h/2.
//
// Same job as `roomRect` does for the gunhouse, and for the same reason: it is
// the hole punched through the section to make the block hollow, *and* the shape
// the side plates fill. A bandstand with a passage bored through ten metres of
// solid has that passage's four walls standing across the middle of the room,
// and they are drawn, and they have no collision. It looked like a corridor.
export function chamberRoomRect(turret, height) {
  const c = chamber(turret);
  return {
    z0: -c.halfZ,
    z1: c.halfZ,
    y0: c.floor - height / 2,
    y1: c.ceiling - height / 2,
  };
}

// A hole in the bandstand's profile, the same trick as the gunhouse: the block
// is extruded across the beam, so one hole gives a passage in at either side.
export function bandstandDoorHole(shapeClass, height, facing, turret) {
  const d = HOUSE.door;
  const c = chamber(turret);
  const z = facing * d.z;
  // Flush with the chamber's own deck, so the opening sits inside the rectangle
  // the plate fills rather than being clipped by its bottom edge.
  const y0 = c.floor - height / 2;
  const y1 = y0 + BANDSTAND_DOOR_H;
  const hole = new shapeClass();
  hole.moveTo(z - d.halfLen, y0);
  hole.lineTo(z + d.halfLen, y0);
  hole.lineTo(z + d.halfLen, y1);
  hole.lineTo(z - d.halfLen, y1);
  hole.closePath();
  return hole;
}

// --- the gear ----------------------------------------------------------------
//
// The thing you walk up to and put your hands on. It matters that it looks like
// a thing you can operate rather than a grey box: this is the only object in
// either room the player is meant to *do* something with, and if it does not
// read as a console then the prompt to take the gun arrives out of nowhere.
//
// Built with the layer standing at -z and looking at it, so everything he
// touches is on the -z face: the desk, the dials, the lamps, the eyepieces, and
// the two handwheels flanking it. Getting that backwards puts the wheels behind
// the console where nobody can see them, which is where they were.
const PANEL = [0.10, 0.42, 0.44]; // the lit face of a dial, near enough
const BRASS = [0.52, 0.40, 0.16];

export function buildTerminal({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const mk = (geo, color, rough, metal) => paint(geo, {
    color, roughness: rough, metal, slot, inside: 0.35,
  });
  const put = (geo, color, rough, metal, x, y, z) => {
    const m = new Mesh(mk(geo, color, rough, metal), M);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const TILT = -0.55; // the desk, and everything lying on it

  // --- the pedestal and the desk ---------------------------------------------
  put(new BoxGeometry(1.5, 0.86, 0.66), STEEL_DARK, 0.5, 0.75, 0, 0.43, 0);
  // a plinth under it so it does not meet the deck as a slab
  put(new BoxGeometry(1.62, 0.09, 0.78), STEEL_DARK, 0.6, 0.7, 0, 0.045, 0);
  const desk = put(new BoxGeometry(1.5, 0.11, 0.7), STEEL_DARK, 0.42, 0.85, 0, 0.94, -0.08);
  desk.rotation.x = TILT;
  // the lit face of it
  const face = put(new BoxGeometry(1.36, 0.02, 0.56), PANEL, 0.16, 0.12, 0, 1.0, -0.055);
  face.rotation.x = TILT;

  // --- the dials --------------------------------------------------------------
  //
  // Two follow-the-pointer dials, which is the instrument this whole station is
  // built around: one needle is where the guns are, the other is where they have
  // been asked to go, and the layer's job is to keep them together. It is the
  // same thing the pip in the sight does, and it should exist in the room too.
  const dial = (x, label) => {
    const d = new Group();
    d.add(new Mesh(mk(new CylinderGeometry(0.17, 0.17, 0.035, 20), BRASS, 0.3, 0.9), M));
    const glass = new Mesh(mk(new CylinderGeometry(0.145, 0.145, 0.045, 20), PANEL, 0.1, 0.1), M);
    d.add(glass);
    // the two needles, at a plausible disagreement
    for (const [len, w, col, a] of [
      [0.12, 0.012, [0.85, 0.84, 0.80], 0.6], [0.10, 0.016, [0.72, 0.24, 0.12], 1.5],
    ]) {
      const n = new Mesh(mk(new BoxGeometry(w, 0.05, len), col, 0.3, 0.2), M);
      n.position.set(Math.sin(a) * len * 0.5, 0.03, Math.cos(a) * len * 0.5);
      n.rotation.y = a;
      d.add(n);
    }
    // graduations round the rim
    for (let i = 0; i < 12; i++) {
      const t = new Mesh(mk(new BoxGeometry(0.012, 0.04, 0.03), [0.1, 0.1, 0.1], 0.5, 0.2), M);
      t.position.set(Math.sin(i / 12 * Math.PI * 2) * 0.125, 0.025, Math.cos(i / 12 * Math.PI * 2) * 0.125);
      t.rotation.y = i / 12 * Math.PI * 2;
      d.add(t);
    }
    d.position.set(x, 1.02, -0.06);
    d.rotation.x = TILT + Math.PI / 2;
    g.add(d);
    void label;
    return d;
  };
  dial(-0.42, 'train');
  dial(0.42, 'elevate');

  // --- the handwheels ---------------------------------------------------------
  //
  // One either side of the console, out where they belong: training to port,
  // elevating to starboard, both standing clear of the desk on their own columns
  // so a man can get both hands on either without reaching across the other.
  // Big, because they are worked against fifteen hundred tonnes.
  for (const side of [-1, 1]) {
    const x = side * 1.06;
    // the column and its gearbox, up off the deck
    put(new BoxGeometry(0.34, 0.7, 0.4), STEEL_DARK, 0.5, 0.8, x, 0.35, 0.02);
    put(new BoxGeometry(0.42, 0.26, 0.5), STEEL_DARK, 0.4, 0.85, x, 0.82, 0.02);

    const hub = new Group();
    hub.position.set(x, 0.92, -0.26); // on the layer's side of it
    hub.rotation.y = -side * 0.22; // canted in, the way a pair of wheels are
    hub.add(new Mesh(mk(new TorusGeometry(0.30, 0.034, 8, 24), BRASS, 0.33, 0.9), M));
    for (let i = 0; i < 4; i++) {
      const sp = new Mesh(mk(new BoxGeometry(0.028, 0.028, 0.58), STEEL, 0.4, 0.9), M);
      sp.rotation.z = (i / 4) * Math.PI;
      sp.rotation.y = Math.PI / 2;
      hub.add(sp);
    }
    hub.add(new Mesh(mk(new CylinderGeometry(0.075, 0.075, 0.14, 12), STEEL_DARK, 0.4, 0.9), M)
      .rotateX(Math.PI / 2));
    // the handle it is spun by, out on the rim
    const grip = new Mesh(mk(new CylinderGeometry(0.03, 0.03, 0.15, 10), [0.16, 0.13, 0.11], 0.7, 0.1), M);
    grip.position.set(0.235, 0.185, -0.08);
    grip.rotation.x = Math.PI / 2;
    hub.add(grip);
    g.add(hub);

    // the shaft from the wheel into the gearbox
    const shaft = new Mesh(mk(new CylinderGeometry(0.05, 0.05, 0.3, 10), STEEL, 0.4, 0.9), M);
    shaft.position.set(x, 0.92, -0.12);
    shaft.rotation.x = Math.PI / 2;
    g.add(shaft);

    // and a small repeat dial on top of the gearbox, one per axis
    const rep = new Mesh(mk(new CylinderGeometry(0.09, 0.09, 0.03, 14), BRASS, 0.3, 0.9), M);
    rep.position.set(x, 0.96, 0.02);
    g.add(rep);
    const glass = new Mesh(mk(new CylinderGeometry(0.075, 0.075, 0.04, 14), PANEL, 0.12, 0.1), M);
    glass.position.set(x, 0.965, 0.02);
    g.add(glass);
  }

  // --- the sight column -------------------------------------------------------
  // What the layer actually has his eye against, standing up off the desk with
  // the eyepiece over the dials.
  {
    const col = new Group();
    col.position.set(0, 1.06, 0.1);
    col.add(new Mesh(mk(new CylinderGeometry(0.075, 0.095, 0.52, 12), STEEL_DARK, 0.35, 0.9), M)
      .translateY(0.26));
    const head = new Mesh(mk(new BoxGeometry(0.34, 0.16, 0.22), STEEL_DARK, 0.3, 0.9), M);
    head.position.y = 0.58;
    col.add(head);
    // the two eyecups, which is the same shape the sight overlay draws
    for (const side of [-1, 1]) {
      const cup = new Mesh(mk(new CylinderGeometry(0.055, 0.07, 0.1, 12), [0.09, 0.09, 0.10], 0.85, 0.05), M);
      cup.position.set(side * 0.075, 0.58, -0.15);
      cup.rotation.x = Math.PI / 2;
      col.add(cup);
    }
    g.add(col);
  }

  // --- the range drum, the firing key and the lamps ---------------------------
  const drum = put(new CylinderGeometry(0.11, 0.11, 0.5, 20), BRASS, 0.28, 0.9, -0.02, 1.35, -0.04);
  drum.rotation.z = Math.PI / 2;
  // a banded ring on it, so it reads as something graduated rather than a pipe
  for (let i = -2; i <= 2; i++) {
    const band = put(new CylinderGeometry(0.113, 0.113, 0.012, 20), [0.1, 0.09, 0.07], 0.5, 0.3,
      -0.02 + i * 0.09, 1.35, -0.04);
    band.rotation.z = Math.PI / 2;
  }
  // the firing key: a lever with a red grip, on the right where a hand falls
  {
    const key = new Group();
    key.position.set(0.58, 1.02, -0.02);
    key.rotation.x = TILT;
    key.add(new Mesh(mk(new CylinderGeometry(0.02, 0.02, 0.2, 8), STEEL, 0.4, 0.9), M)
      .translateY(0.1));
    key.add(new Mesh(mk(new SphereGeometry(0.045, 10, 8), [0.55, 0.10, 0.08], 0.35, 0.2), M)
      .translateY(0.21));
    g.add(key);
  }
  // ready lamps
  for (const [i, col] of [[-1, [0.55, 0.12, 0.08]], [0, [0.55, 0.42, 0.10]], [1, [0.16, 0.48, 0.20]]]) {
    const lamp = put(new CylinderGeometry(0.028, 0.028, 0.03, 10), col, 0.2, 0.1,
      i * 0.09, 1.115, -0.30);
    lamp.rotation.x = TILT + Math.PI / 2;
  }

  // --- and the man's chair ----------------------------------------------------
  {
    const seat = new Group();
    seat.position.set(0, 0, -1.0);
    seat.add(new Mesh(mk(new CylinderGeometry(0.055, 0.07, 0.5, 10), STEEL_DARK, 0.5, 0.85), M)
      .translateY(0.25));
    seat.add(new Mesh(mk(new CylinderGeometry(0.22, 0.22, 0.07, 14), [0.16, 0.13, 0.11], 0.8, 0.1), M)
      .translateY(0.53));
    const back = new Mesh(mk(new BoxGeometry(0.36, 0.28, 0.05), [0.16, 0.13, 0.11], 0.8, 0.1), M);
    back.position.set(0, 0.72, -0.2);
    seat.add(back);
    g.add(seat);
  }

  // --- a telephone on a bracket ------------------------------------------------
  {
    const tel = new Group();
    tel.position.set(-0.82, 1.14, -0.1);
    tel.add(new Mesh(mk(new BoxGeometry(0.16, 0.24, 0.1), [0.12, 0.12, 0.13], 0.6, 0.4), M));
    const horn = new Mesh(mk(new CylinderGeometry(0.035, 0.035, 0.2, 8), [0.09, 0.09, 0.10], 0.7, 0.1), M);
    horn.position.set(0, 0.02, -0.09);
    horn.rotation.x = Math.PI / 2;
    tel.add(horn);
    g.add(tel);
  }

  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

// The gunhouse as the *player* collides with it, in the turret's own frame.
//
// Not the same list as what is drawn, and the difference matters. The house
// draws itself now that it is hollow; this is the shell as something to walk
// against — skin-width walls with the door and the window cut out of them, a
// deck, and a roof at the real roof line so you can stand on top of her.
//
// It exists because the ship's own colliders answer a different question. To
// them a turret is one solid block, which is the right answer for a falling mast
// and the wrong one for a man walking up to a door: it makes the doorway you can
// plainly see into a wall. See player/deckAccess.js, which puts this in the
// ship's frame and takes the solid block out for the player.
export function houseShellSolids() {
  const H = HOUSE;
  const skin = S.gunhouseW / 2;
  const roof = S.gunhouseH;
  const fore = H.fwd + WALL;
  const aft = H.aft - WALL;
  const out = [];
  const add = (c, h) => out.push({ id: 'house.shell', c, h });

  add([0, H.floor / 2 - 0.5, (fore + aft) / 2], [skin, H.floor / 2 + 0.5, (fore - aft) / 2]);
  add([0, (H.ceiling + roof) / 2, (fore + aft) / 2], [skin, (roof - H.ceiling) / 2, (fore - aft) / 2]);
  add([0, (H.floor + H.ceiling) / 2, fore + WALL], [skin, (H.ceiling - H.floor) / 2, WALL * 2]);
  add([0, (H.floor + H.ceiling) / 2, aft - WALL], [skin, (H.ceiling - H.floor) / 2, WALL * 2]);
  for (const side of [-1, 1]) {
    for (const b of wallPieces(aft, fore, H.floor, H.ceiling, [H.door, H.window])) {
      add([side * (H.halfW + skin) / 2, b.y, b.z], [(skin - H.halfW) / 2, b.hy, b.hz]);
    }
  }
  return out;
}

// --- marking the way in ------------------------------------------------------
//
// A painted surround on every opening a person can walk through, in her own
// boot-topping black — the band she wears at the waterline. Nothing on this ship
// is signposted, which is right for a warship and wrong for one you have to find
// your way about: a doorway in grey plating seen from thirty metres of grey deck
// is a slightly darker rectangle and nothing else. A hand's breadth of black
// round it and you can see it from the far end of the forecastle.
//
// It is deliberately narrow, and it sits *outside* the opening rather than
// overlapping it, so it marks the door without making it any smaller. Only doors
// get it — the sighting slits are not a way in and should not look like one.
const FRAME_W = 0.13; // how wide the painted band is
const FRAME_OUT = 0.02; // how far it stands off the plating, to keep off it

function doorFrame({ materials, slot, opening, faces, z, sill, head }) {
  const M = materials.body;
  const g = new Group();
  const half = opening.halfLen;
  const mk = (w, h, d, x, y, zz) => {
    const m = new Mesh(paint(new BoxGeometry(w, h, d), {
      color: PAINT.boot, roughness: 0.55, metal: 0.3, slot,
    }), M);
    m.position.set(x, y, zz);
    g.add(m);
  };
  for (const { x, dir } of faces) {
    const px = x + dir * FRAME_OUT;
    const t = FRAME_OUT * 2;
    mk(t, FRAME_W, half * 2 + FRAME_W * 2, px, head + FRAME_W / 2, z);
    mk(t, FRAME_W, half * 2 + FRAME_W * 2, px, sill - FRAME_W / 2, z);
    for (const side of [-1, 1]) {
      mk(t, head - sill, FRAME_W, px, (sill + head) / 2, z + side * (half + FRAME_W / 2));
    }
  }
  return g;
}

// --- what you can see --------------------------------------------------------

export function buildTurretInterior({ materials, id }) {
  const slot = materials.slotOf(id);
  const M = materials.body;
  const group = new Group();
  group.name = `${id}.interior`;

  // `inside` is the ship's own treatment for a liner: the same program, shading
  // it as unpainted framed steel in an unlit space rather than as her side. At
  // 1.0 it takes a tenth of the sun and two thirds of the sky, which for a
  // gunhouse full of dark steel comes out as a black void with a couple of hard
  // edges in it — you cannot tell a wall from a doorway. Held at 0.55 it is
  // plainly an interior and you can still see what is in it.
  const mk = (g, look) => paint(g, {
    color: look.color, roughness: look.rough, metal: look.metal, slot, inside: 0.55,
  });

  for (const s of slabs()) {
    if (s.look.shell) continue; // the hollow house draws these itself
    if (s.look.terminal) {
      const t = buildTerminal({ materials, slot });
      t.position.set(HOUSE.station.x, HOUSE.floor, HOUSE.station.z - 0.45);
      group.add(t); // facing forward, along the guns, which is where he looks
      continue;
    }
    const g = s.look.cylinder
      ? new CylinderGeometry(s.h[0], s.h[0], s.h[2] * 2, 16)
      : new BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2);
    if (s.look.cylinder) g.rotateX(Math.PI / 2);
    const m = new Mesh(mk(g, s.look), M);
    m.position.set(s.c[0], s.c[1], s.c[2]);
    group.add(m);
  }

  // the painted surround on the way in, inside and out
  const skinX = S.gunhouseW / 2;
  group.add(doorFrame({
    materials,
    slot,
    opening: HOUSE.door,
    z: HOUSE.door.z,
    sill: HOUSE.door.sill,
    head: HOUSE.door.head,
    faces: [-1, 1].flatMap((side) => [
      { x: side * skinX, dir: side }, // outboard
      { x: side * (skinX - PLATE), dir: -side }, // and inboard
    ]),
  }));

  // A sighting hood on the roof, so the thing you look through exists from
  // outside as well as in.
  const hood = new Mesh(
    paint(new BoxGeometry(1.0, 0.7, 1.2), {
      color: STEEL_DARK, roughness: 0.4, metal: 0.8, slot,
    }),
    M,
  );
  hood.position.set(HOUSE.sight.x, S.gunhouseH + 0.35, HOUSE.sight.z);
  group.add(hood);

  group.traverse((o) => { o.frustumCulled = false; });
  return group;
}

// The working chamber inside a bandstand: the same idea, drawn as linings rather
// than as the thick slabs the collision uses, plus the trunk and the gear.
export function buildChamber({ materials, id, turret }) {
  const slot = materials.slotOf(id);
  const M = materials.body;
  const group = new Group();
  group.name = `${id}.chamber`;
  const c = chamber(turret);

  group.add(doorFrame({
    materials,
    slot,
    opening: HOUSE.door,
    z: c.doorZ,
    sill: c.floor,
    head: c.floor + BANDSTAND_DOOR_H,
    faces: [-1, 1].flatMap((side) => [
      { x: side * c.outerX, dir: side },
      { x: side * (c.outerX - PLATE), dir: -side },
    ]),
  }));

  for (const p of chamberPanels(turret)) {
    if (p.look.shell) continue; // the hollow bandstand draws these itself
    if (p.look.terminal) {
      const t = buildTerminal({ materials, slot });
      t.position.set(p.mesh.c[0], p.mesh.c[1], p.mesh.c[2]);
      // Facing the way the layer stands, which is what `approach` in
      // turretStation.js assumes: he comes at it from -z on a forward turret and
      // from +z on an after one. Rotated any other way, the wheels end up beside
      // him instead of under his hands.
      t.rotation.y = c.facing > 0 ? 0 : Math.PI;
      group.add(t);
      continue;
    }
    const h = p.mesh.h;
    const geo = p.look.cylinder
      ? new CylinderGeometry(h[0], h[0], h[1] * 2, 20)
      : new BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2);
    const m = new Mesh(paint(geo, {
      color: p.look.color, roughness: p.look.rough, metal: p.look.metal, slot, inside: 0.55,
    }), M);
    m.position.set(p.mesh.c[0], p.mesh.c[1], p.mesh.c[2]);
    group.add(m);
  }
  group.traverse((o) => { o.frustumCulled = false; });
  return group;
}

// --- what the player walks against -------------------------------------------
//
// The same slabs, as a collision query with the same contract as
// battleship/colliders.js — penetration depth, outward normal, and what was hit.
// The room is closed except for the two doorways, and those are portals rather
// than holes: walk into one and the space transition hands you to the ship.
export function createHouseColliders() {
  const boxes = slabs().map((s) => ({
    id: s.id,
    c: new Vector3(s.c[0], s.c[1], s.c[2]),
    h: new Vector3(s.h[0], s.h[1], s.h[2]),
    min: new Vector3(s.c[0] - s.h[0], s.c[1] - s.h[1], s.c[2] - s.h[2]),
    max: new Vector3(s.c[0] + s.h[0], s.c[1] + s.h[1], s.c[2] + s.h[2]),
  }));

  const bounds = {
    min: new Vector3(Infinity, Infinity, Infinity),
    max: new Vector3(-Infinity, -Infinity, -Infinity),
  };
  for (const b of boxes) { bounds.min.min(b.min); bounds.max.max(b.max); }

  const _n = new Vector3();
  function query(p, out) {
    let best = 0;
    let bestId = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (p.x < b.min.x || p.x > b.max.x) continue;
      if (p.y < b.min.y || p.y > b.max.y) continue;
      if (p.z < b.min.z || p.z > b.max.z) continue;
      const d = boxHit(p, b.c, b.h, _n);
      if (d > best) { best = d; bestId = b.id; out.normal.copy(_n); }
    }
    out.id = bestId;
    return best;
  }

  return { query, bounds, boxes };
}
