import {
  BoxGeometry, CylinderGeometry, Group, Mesh, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { boxHit } from './colliders.js';
import { TURRET_SPEC } from './spec.js';
import { STEEL, STEEL_DARK } from './hull.js';

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

const HOUSE_Z = -1.0; // where the gunhouse sits on the roller path (mounts.js)
const WALL = 0.18; // liner thickness

// The gunhouse is an extruded profile with a sloped face and a lower rear, so
// the box you can fit inside it is a good deal smaller than its bounding box:
// the roof only runs from `-l/2 + 1.0` to `l/2 - 2.6`, and a liner sized off the
// nominal length pokes out through the face as a black slab you can see from the
// forecastle. These numbers are cut to the *profile*, not to the dimensions.
export const HOUSE = {
  // the room, inside the liner
  halfW: S.gunhouseW / 2 - 0.7, // 4.3
  fwd: HOUSE_Z + S.gunhouseL / 2 - 3.0, // inside where the face starts to slope
  aft: HOUSE_Z - S.gunhouseL / 2 + 1.3, // and inside where the rear drops away
  floor: 0.2,
  ceiling: S.gunhouseH - 0.45, // 2.55 m of headroom, and the deckhead slab still
  // under the roof plating rather than through it

  // The door, one each side. It is a hole through the extruded gunhouse profile,
  // so it comes out as a doorway to port and one to starboard for free — which
  // is what a turret has, and which means the ladder can stand on whichever side
  // of her you happen to be walking down.
  // Sized to walk through rather than to duck through: 2.33 m of clear height
  // and 1.6 m of width, against a man 1.78 m tall and 0.68 m across.
  door: {
    z: -3.2, // well aft of the breeches, in the working space
    halfLen: 0.8,
    sill: 0.12,
    head: 2.45,
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

// A hole in the *profile* the gunhouse is extruded from. The extrusion runs
// across the beam, so one hole in the 2D shape is a doorway through both sides.
// mounts.js asks for this when it lofts the house.
export function doorHole(shapeClass) {
  const d = HOUSE.door;
  const z0 = d.z - HOUSE.houseZ - d.halfLen; // the profile is in the house's own z
  const z1 = d.z - HOUSE.houseZ + d.halfLen;
  const hole = new shapeClass();
  hole.moveTo(z0, d.sill);
  hole.lineTo(z1, d.sill);
  hole.lineTo(z1, d.head);
  hole.lineTo(z0, d.head);
  hole.closePath();
  return hole;
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
  add('house.floor', [0, H.floor - WALL, midZ], [H.halfW + WALL, WALL, halfL + WALL],
    { color: STEEL_DARK, rough: 0.7, metal: 0.5 });
  add('house.head', [0, H.ceiling + WALL, midZ], [H.halfW + WALL, WALL, halfL + WALL],
    { color: STEEL_DARK, rough: 0.6, metal: 0.6 });

  // fore and aft bulkheads
  add('house.fore', [0, midY, H.fwd + WALL], [H.halfW, halfH, WALL],
    { color: STEEL, rough: 0.5, metal: 0.7 });
  add('house.aft', [0, midY, H.aft - WALL], [H.halfW, halfH, WALL],
    { color: STEEL, rough: 0.5, metal: 0.7 });

  // the two sides, in three pieces each so the doorway is a hole rather than a
  // thing to be subtracted
  for (const side of [-1, 1]) {
    const x = side * (H.halfW + WALL);
    const aftSeg = (d.z - d.halfLen + H.aft) / 2;
    const aftHalf = (d.z - d.halfLen - H.aft) / 2;
    const fwdSeg = (H.fwd + d.z + d.halfLen) / 2;
    const fwdHalf = (H.fwd - d.z - d.halfLen) / 2;
    add('house.side', [x, midY, aftSeg], [WALL, halfH, aftHalf],
      { color: STEEL, rough: 0.5, metal: 0.7 });
    add('house.side', [x, midY, fwdSeg], [WALL, halfH, fwdHalf],
      { color: STEEL, rough: 0.5, metal: 0.7 });
    // the lintel over the door, and the sill under it
    add('house.side', [x, (d.head + H.ceiling) / 2, d.z], [WALL, (H.ceiling - d.head) / 2, d.halfLen],
      { color: STEEL, rough: 0.5, metal: 0.7 });
    if (d.sill > H.floor) {
      add('house.side', [x, (H.floor + d.sill) / 2, d.z], [WALL, (d.sill - H.floor) / 2, d.halfLen],
        { color: STEEL, rough: 0.5, metal: 0.7 });
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

  // the layer's pedestal — waist height, so it is a thing you walk up to rather
  // than a thing that blocks you
  add('house.station', [HOUSE.station.x, H.floor + 0.55, HOUSE.station.z], [0.55, 0.55, 0.45],
    { color: STEEL_DARK, rough: 0.4, metal: 0.8 });

  return out;
}

// The doorway from inside, as a volume against each side of the room. Walk into
// one of these and you are on your way out.
export function insideDoorVolumes() {
  const d = HOUSE.door;
  return [-1, 1].map((side) => ({
    side,
    c: new Vector3(side * (HOUSE.halfW - 0.2), (d.sill + d.head) / 2, d.z),
    h: new Vector3(0.7, (d.head - d.sill) / 2, d.halfLen),
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

// How tall the way through a bandstand is.
export const BANDSTAND_DOOR_H = 2.6;

// A hole in the bandstand's profile, the same trick as the gunhouse: the block
// is extruded across the beam, so one hole gives a passage in at either side.
export function bandstandDoorHole(shapeClass, height, facing) {
  const d = HOUSE.door;
  const z = facing * d.z;
  const hole = new shapeClass();
  hole.moveTo(z - d.halfLen, -height / 2 + 0.1);
  hole.lineTo(z + d.halfLen, -height / 2 + 0.1);
  hole.lineTo(z + d.halfLen, -height / 2 + BANDSTAND_DOOR_H);
  hole.lineTo(z - d.halfLen, -height / 2 + BANDSTAND_DOOR_H);
  hole.closePath();
  return hole;
}

// --- what you can see --------------------------------------------------------

export function buildTurretInterior({ materials, id }) {
  const slot = materials.slotOf(id);
  const M = materials.body;
  const group = new Group();
  group.name = `${id}.interior`;

  // `inside: 1` is the ship's own treatment for a liner: the same program, shaded
  // as unpainted framed steel in a dark space rather than as her side.
  const mk = (g, look) => paint(g, {
    color: look.color, roughness: look.rough, metal: look.metal, slot, inside: 1,
  });

  for (const s of slabs()) {
    const g = s.look.cylinder
      ? new CylinderGeometry(s.h[0], s.h[0], s.h[2] * 2, 16)
      : new BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2);
    if (s.look.cylinder) g.rotateX(Math.PI / 2);
    const m = new Mesh(mk(g, s.look), M);
    m.position.set(s.c[0], s.c[1], s.c[2]);
    group.add(m);
  }

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
