import {
  BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry, Group, Mesh, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { carveBox } from './carve.js';
import { SUPER } from './spec.js';
import { deckY, zOf, STEEL, STEEL_DARK } from './hull.js';
import { CONN, conn, deckTop, deckUnder } from './wheelhouse.js';

// The way up to the bridge.
//
// A wheelhouse you cannot walk to is scenery, and until now the pagoda was solid:
// four blockhouses, a column and a stack of galleries, none of which had a way in
// or a way between. This is the way in, and it is one route with three parts.
//
//   the door      — in the port side of the base blockhouse, on the weather deck
//   the hallway   — straight through the blockhouse, port side to starboard
//   the trunk     — a plated ladder trunk on her starboard side, from the deck to
//                   the air-defence platform in one climb
//
// From the head of the trunk a short gangway crosses onto the platform, and from
// there it is a walk round the conning tube and three treads into the wheelhouse.
//
// That is the way onto the *platform*, and it is not the way to the wheel any
// more. The way to the wheel is a second trunk — the conning trunk, below — which
// runs up the inside of the armoured column on its own axis, from a passage off
// the middle of the hallway to a hatch in the middle of the wheelhouse deck. It
// is there because a ladder up the outside of a tower that lets you out on a
// windswept disc, to walk round a drum and up three steps through a door in a
// side, is four transitions to reach one room; and because the inside of the
// conning tube is where a ship this shape actually puts that ladder. Twelve
// metres in one climb, and you come up through the deck into the middle of the
// room with the wheel in front of you.
//
// Two things decided where all of this goes, and both are worth writing down
// because they look arbitrary and are not.
//
// The hallway is at the *forward* end of the blockhouse because the shelter deck
// round the funnel overlaps its after two thirds — those two boxes interpenetrate,
// so anything cut through the after part of the blockhouse would open into the
// middle of another solid. Forward of the shelter deck's face there is 10 m of
// blockhouse with nothing but sky outboard of it, and that is where the door is.
//
// The trunk is *outboard* of the blockhouse rather than inside it because the
// tower has no vertical channel through it. Every level above the base — the upper
// blockhouse, the chart house, its gallery, the air-defence platform, the
// wheelhouse — is wider than the last for the whole of the tower's height, and the
// platform is a 15 m disc. Outboard of the platform's rim there is a clear run
// from the deck to its level, and the trunk stands in it. That is also where a
// real ship puts hers, and for the same reason.
//
// Everything here is a carved solid, not a shell: see carve.js. One list of boxes
// is the plating you can see, the walls you bump into, and the passage you walk
// down, so none of the three can disagree with the other two.

// The pagoda's base blockhouse, as buildBridge draws it. Restated here because
// this file is what carves it, and a carve has to know the thing it is cutting.
const BASE = { w: 17, h: 4.0, l: 21, dz: -1.0 };

export const TRUNK = {
  // The hallway: through the blockhouse at the forward end, where its sides are
  // clear of the shelter deck.
  hall: { z: 6.1, halfLen: 0.6, head: 2.3 },
  // The trunk, standing on the weather deck against the blockhouse's starboard
  // side. Starboard is -x — see spec.js — so it stands at negative x.
  x: [-10.5, -8.5],
  z: [4.3, 7.3],
  wall: 0.2,
  // Where you come out: the air-defence platform's own level, so the gangway
  // across to it is flat. Wide enough that a man standing anywhere in the shaft is
  // in front of it — arriving at the head of a ladder and having to shuffle
  // sideways to find the door is exactly the sort of thing that reads as the game
  // being broken.
  exit: { halfLen: 1.0, head: 2.05 },
  top: 14.2, // the trunk's own roof, above the deck at the pagoda's station
};

// The air-defence platform, as buildBridge draws it: `platform(7.4, 11.6, 1.2)`.
// Its top is the height the trunk lets you out at.
export const PLATFORM = { r: 7.4, y: 11.6, dz: 1.2, thick: 0.3 };

// --- the conning trunk --------------------------------------------------------
//
// A plated shaft up the middle of the tower, from the weather deck to the
// wheelhouse deck, with the ladder to the bridge in it.
//
// Where it goes is not a free choice in any of the three axes, and all three
// constraints happen to agree, which is the only reason this is a shaft and not a
// staircase folded round something:
//
//   across    — on the centreline, because the hatch it comes up through has to be
//               in the middle of the wheelhouse and the wheelhouse is symmetrical.
//   fore-aft  — on the air-defence platform's own axis (CONN.dz, quoted from
//               wheelhouse.js), so the hole it needs through that platform is
//               concentric with it and is an annulus rather than a disc with a
//               bite out of it.
//   width     — small enough to stand inside the armoured column all the way up.
//               The column is 6.4 m across at the foot of the climb and 6.2 at the
//               head, and its axis is 1.7 m abaft this one, so the far corner of a
//               1.9 m shaft clears its plating by 400 mm. That clearance is the
//               whole reason the trunk is invisible from outside: from the deck up
//               to the platform there is not one metre of its height that is not
//               inside something else already.
//
// Everything it passes through is carved or cut for it where that is visible and
// left alone where it is not: see `shaft` in superstructure.js for the blockhouse
// and the chart house, `hole` on the platform, and the note on the column, which
// simply loses its end caps.
const trunkX = () => 0;
const trunkZ = () => zOf(SUPER.bridge.z) + CONN.dz;

// The shaft's clear inside, in the ship's frame: the void the plating is carved
// round, and the hole every deck it passes through has to have in it.
// `pad` widens it. The plating's own void takes none — that is what makes the
// shaft the size it is — and everything the plating merely passes *through* takes
// a little, so that the hole cut in a deck sits just outside the tube standing in
// it. Cut both to the same line and the two inner faces are coplanar for the
// whole height they share, which is a strip of z-fighting down the shaft.
export function connShaft(pad = 0) {
  const y0 = deckY(SUPER.bridge.z);
  const h = conn().half + pad;
  return {
    min: [trunkX() - h, y0 - 1, trunkZ() - h],
    max: [trunkX() + h, y0 + deckTop() + 1, trunkZ() + h],
  };
}

// How far two pieces of deck overlap where they meet. Never zero: see the landing
// at the head of the trunk for what butting them exactly does to somebody standing
// on the join.
const LAP = 0.6;
export const platformTop = () => deckY(SUPER.bridge.z) + PLATFORM.y + PLATFORM.thick / 2;

const trunkMidZ = () => (TRUNK.z[0] + TRUNK.z[1]) / 2;

// How far out the platform reaches at the gangway's station: the disc is round, so
// the further aft or forward of its centre you land the shorter the gangway has to
// be to reach it.
function platformReachAt(z) {
  const dz = z - PLATFORM.dz;
  return Math.sqrt(Math.max(PLATFORM.r * PLATFORM.r - dz * dz, 1));
}

// Where the gangway crosses the platform's rail, as a bearing round it — so the
// bay of rail it crosses can be left out rather than drawn across the way in. See
// `railRing` in superstructure.js.
export function gangwayBearing(railR) {
  const dz = trunkMidZ() - PLATFORM.dz;
  const x = -Math.sqrt(Math.max(railR * railR - dz * dz, 0.01));
  return Math.atan2(dz, x);
}

// The hallway void, in the ship's frame. It runs the whole width of the
// blockhouse and a little beyond it, so the same void punches the door in the port
// side, the passage through the middle, and the doorway in the trunk's inboard
// wall — one opening, stated once, cut out of both structures.
function hallVoid() {
  const y0 = deckY(SUPER.bridge.z);
  const z0 = zOf(SUPER.bridge.z);
  const h = TRUNK.hall;
  return {
    // Starboard is -x: that end goes a little past the blockhouse's own side, so
    // the same void punches the doorway in the trunk's inboard wall...
    min: [-BASE.w / 2 - 0.3, y0, z0 + h.z - h.halfLen],
    // ...and the port end goes well past hers, which is the door onto the deck.
    max: [BASE.w / 2 + 1.0, y0 + h.head, z0 + h.z + h.halfLen],
  };
}

// The passage aft off the middle of the hallway to the foot of the conning trunk.
//
// On the centreline and inside the blockhouse for the whole of its run, which is
// what lets it exist at all: the shelter deck round the funnel overlaps the after
// two thirds of this blockhouse, so anything cut through the *side* of it back
// here would open into the middle of another solid — but nothing overlaps its
// centre, and a passage that never reaches a side face never meets the problem.
// It runs a little past the shaft in both directions so the two voids overlap
// rather than butt, for the reason at the head of `gangway`.
function connPassageVoid() {
  const y0 = deckY(SUPER.bridge.z);
  const z0 = zOf(SUPER.bridge.z);
  const h = TRUNK.hall;
  const w = conn().half;
  return {
    min: [-w, y0, trunkZ() - w],
    max: [w, y0 + h.head, z0 + h.z + h.halfLen],
  };
}

// The two z faces of the hallway, in the ship's frame, with a little margin. Read by
// interior.js, which has to leave a gap in the blockhouse's liner where the passage
// goes through it — a liner across the hallway is a wall in the middle of it.
export function bridgeHallGap(margin = 0.25) {
  const z0 = zOf(SUPER.bridge.z);
  const h = TRUNK.hall;
  return [z0 + h.z - h.halfLen - margin, z0 + h.z + h.halfLen + margin];
}

// The footprint the way to the bridge needs kept clear, as trigger-shaped volumes
// in the same form the turret doorways use: the hallway through the blockhouse and
// the trunk at the end of it. Nothing may be left standing in either — see the note
// on deck props in player/deckAccess.js.
export function bridgeDoorways() {
  const y0 = deckY(SUPER.bridge.z);
  const z0 = zOf(SUPER.bridge.z);
  const h = TRUNK.hall;
  return [
    {
      c: new Vector3(0, y0 + h.head / 2, z0 + h.z),
      h: new Vector3(BASE.w / 2 + 1.6, h.head / 2, h.halfLen),
    },
    {
      c: new Vector3((TRUNK.x[0] + TRUNK.x[1]) / 2, y0 + h.head / 2, z0 + trunkMidZ()),
      h: new Vector3(
        (TRUNK.x[1] - TRUNK.x[0]) / 2, h.head / 2, (TRUNK.z[1] - TRUNK.z[0]) / 2,
      ),
    },
    {
      c: new Vector3(0, y0 + h.head / 2, (trunkZ() + z0 + h.z + h.halfLen) / 2),
      h: new Vector3(conn().half, h.head / 2, (z0 + h.z + h.halfLen - trunkZ()) / 2),
    },
  ];
}

// The base blockhouse, minus the hallway.
export function baseSolids() {
  const y0 = deckY(SUPER.bridge.z);
  const z0 = zOf(SUPER.bridge.z);
  return carveBox({
    min: [-BASE.w / 2, y0, z0 + BASE.dz - BASE.l / 2],
    max: [BASE.w / 2, y0 + BASE.h, z0 + BASE.dz + BASE.l / 2],
  }, [hallVoid(), connPassageVoid(), connShaft()]);
}

// The head of the ladder: a landing across the whole of the shaft, and the gangway
// from it onto the air-defence platform. Both decks are flush with the platform's,
// so the walk from the top rung to the wheelhouse door has no step in it anywhere.
//
// The landing is the piece that was missing, and its absence was invisible until
// somebody climbed the ladder. Without it the only deck at the head was the gangway,
// which began at the shaft's inboard face — so a man stepping off the rungs arrived
// standing on its outermost sixty millimetres, and at that distance from an edge the
// collision field answers "wall" rather than "floor" (the nearest face of a box is
// the side of it, not the top). He was put down on the lip and fell down the trunk.
// A climber has to arrive on a *floor*, with the edge of it a stride away.
//
// How far inboard the gangway has to run is measured at whichever of its two corners
// the round platform reaches least far, so the whole width of it lands on the disc
// rather than one corner hanging over the sea eleven metres up.
export function gangway() {
  const z0 = zOf(SUPER.bridge.z);
  const zMid = trunkMidZ();
  const top = platformTop();
  const t = TRUNK.wall;
  const reach = Math.min(
    platformReachAt(zMid - TRUNK.exit.halfLen), platformReachAt(zMid + TRUNK.exit.halfLen),
  );
  const inboard = -(reach - 0.6);
  const head = TRUNK.x[1] - t;
  return [
    // the landing, filling the shaft. The rungs pass through it — which is what a
    // hatch in a trunk head is — and the climb stops on top of it, because the
    // ladder's own top is this deck.
    //
    // It runs a good half-metre *past* the shaft, under the gangway, and the overlap
    // is the point: two boxes that merely butt up share a face, and a foot within a
    // few centimetres of that face is nearest to the *side* of one of them, so the
    // floor probe reads a wall and the body falls between two pieces of deck. It is
    // the same reason the treads of every ladder on this ship overlap — see `flight`
    // in player/deckAccess.js.
    {
      c: [(TRUNK.x[0] + t + head + LAP) / 2, top - PLATFORM.thick / 2, z0 + zMid],
      h: [(head + LAP - TRUNK.x[0] - t) / 2, PLATFORM.thick / 2,
        (TRUNK.z[1] - TRUNK.z[0]) / 2 - t],
    },
    // and the gangway across to the platform
    {
      c: [(head + inboard) / 2, top - PLATFORM.thick / 2, z0 + zMid],
      h: [(inboard - head) / 2, PLATFORM.thick / 2, TRUNK.exit.halfLen],
    },
  ];
}

// The trunk: a hollow plated box with a doorway at the bottom and another at the
// top, plus the gangway off it. Same carve, so the inside of the shaft is the
// inward faces of its own plating and there is nothing to line.
export function trunkSolids() {
  const y0 = deckY(SUPER.bridge.z);
  const z0 = zOf(SUPER.bridge.z);
  const t = TRUNK.wall;
  const top = platformTop();
  const shaft = {
    min: [TRUNK.x[0] + t, y0, z0 + TRUNK.z[0] + t],
    max: [TRUNK.x[1] - t, y0 + TRUNK.top - t, z0 + TRUNK.z[1] - t],
  };
  const zMid = trunkMidZ();
  const out = carveBox({
    min: [TRUNK.x[0], y0, z0 + TRUNK.z[0]],
    max: [TRUNK.x[1], y0 + TRUNK.top, z0 + TRUNK.z[1]],
  }, [
    shaft,
    hallVoid(),
    // The way out at the head of the ladder, through the inboard wall.
    //
    // Cut from the *underside* of the landing rather than from its surface, so the
    // threshold of the doorway is the landing's own plate. Cut from the surface
    // instead, the plating is still solid for the 300 mm the deck is thick — and a
    // foot on that threshold reads as standing against a wall rather than on a
    // floor, because the nearest face of the plating it is inside is a vertical one.
    // The player was put down on the sill and dropped eleven metres down the trunk.
    {
      min: [TRUNK.x[1] - t - 0.1, top - PLATFORM.thick, z0 + zMid - TRUNK.exit.halfLen],
      max: [TRUNK.x[1] + 0.1, top + TRUNK.exit.head, z0 + zMid + TRUNK.exit.halfLen],
    },
  ]);
  out.push(...gangway());
  return out;
}

// The conning trunk's own plating: the shaft, from the top of the base blockhouse
// to the wheelhouse deck.
//
// Below that it needs none — the blockhouse is carved round the same void, so the
// walls of the shaft down there are the blockhouse's own pieces, which is the
// whole economy of carving. Above it the shaft runs through four different things
// at four different heights, three of which are carved for it as well; this is
// what closes the two gaps that are not (the 230 mm of open air between the chart
// house's gallery and the air-defence platform, and the platform's own thickness)
// and what makes the tube continuous rather than four tubes that happen to line
// up. Every piece is a closed box, so what you see climbing it is the inward faces
// of its own plating.
export function connTrunkSolids() {
  const y0 = deckY(SUPER.bridge.z);
  const h = CONN.half;
  // It runs from the blockhouse's roof to the underside of the wheelhouse's deck
  // slab, and stops dead at both — the blockhouse carries the shaft below and the
  // deck slab carries it above, so there is nowhere the two descriptions of the
  // same wall overlap. Two coplanar faces would be a strip of z-fighting down the
  // whole mouth of the hatch, which is the one place in this ship a player is
  // guaranteed to be looking closely at.
  return carveBox({
    min: [trunkX() - h, y0 + BASE.h, trunkZ() - h],
    max: [trunkX() + h, y0 + deckUnder(), trunkZ() + h],
  }, [connShaft()]);
}

// The ladder itself, as something to climb rather than something to walk on.
//
// Every other way up this ship is a flight of invisible treads — see the note at
// the head of deckAccess.js, which is a very cheap and completely reliable trick
// and is why there is no stair-stepping code anywhere in the project. It cannot
// do this one. A flight of treads is a 35-degree ramp, so eleven metres of climb
// wants sixteen metres of run, and the pagoda has neither the length for that nor
// the headroom for the switchbacks that would fold it up. A ladder is what a ship
// actually uses over that height, and a ladder is vertical.
//
// So the volume below is a *mode*: inside it, forward and back are up and down.
// See `ladderAt` in player/character.js. `exit` is which way you get off at the
// top, so arriving at the head does not leave you standing on a hole.
export function ladderVolumes() {
  const y0 = deckY(SUPER.bridge.z);
  const z0 = zOf(SUPER.bridge.z);
  const t = TRUNK.wall;
  const top = platformTop();
  const x0 = TRUNK.x[0] + t;
  const x1 = TRUNK.x[1] - t;
  const zA = z0 + TRUNK.z[0] + t;
  const zB = z0 + TRUNK.z[1] - t;
  return [{
    id: 'ladder.bridge',
    c: new Vector3((x0 + x1) / 2, (y0 + top) / 2, (zA + zB) / 2),
    h: new Vector3((x1 - x0) / 2, (top - y0) / 2, (zB - zA) / 2),
    bottom: y0,
    top,
    // inboard, onto the gangway
    exit: new Vector3(1, 0, 0),
  }, connLadder()];
}

// The climb to the wheel: twelve metres up the middle of the tower, from the
// passage off the hallway to the hatch in the wheelhouse deck.
//
// It stops level with the deck it comes up through, so the last thing the climb
// does is put the body's feet on the surface it is going to walk on; `exit` is
// forward, which is off the hatch and into the room with the wheel ahead of you.
// Aft would be as short a step and is the wrong one — it puts a man's back to the
// bridge as he arrives.
function connLadder() {
  const y0 = deckY(SUPER.bridge.z);
  const h = conn().half;
  const top = y0 + deckTop();
  return {
    id: 'ladder.conn',
    c: new Vector3(trunkX(), (y0 + top) / 2, trunkZ()),
    h: new Vector3(h, (top - y0) / 2, h),
    bottom: y0,
    top,
    exit: new Vector3(0, 0, 1),
  };
}

// --- what you can see --------------------------------------------------------

export function buildBridgeAccess({ materials, slot }) {
  const group = new Group();
  group.name = 'bridge.access';
  const y0 = deckY(SUPER.bridge.z);
  const z0 = zOf(SUPER.bridge.z);
  const geoms = [];
  const add = (geo, color, rough = 0.45) => geoms.push(paint(geo, {
    color, roughness: rough, metal: 0.7, slot,
  }));
  const box = (p, color, rough) => {
    const g = new BoxGeometry(p.h[0] * 2, p.h[1] * 2, p.h[2] * 2);
    g.translate(p.c[0], p.c[1], p.c[2]);
    add(g, color, rough);
  };

  const solids = [...baseSolids(), ...trunkSolids(), ...connTrunkSolids()];
  for (const p of solids) box(p, STEEL, 0.45);

  // The rungs. They are drawn and nothing more — what you actually climb is the
  // volume above — but a shaft with no ladder in it is a shaft you would never
  // think to climb, and that is the whole of what they are for.
  {
    const t = TRUNK.wall;
    const x = (TRUNK.x[0] + TRUNK.x[1]) / 2;
    const zAft = z0 + TRUNK.z[0] + t + 0.08;
    const top = platformTop();
    for (const dx of [-0.24, 0.24]) {
      const stringer = new CylinderGeometry(0.035, 0.035, top - y0, 6);
      stringer.translate(x + dx, (y0 + top) / 2, zAft);
      add(stringer, STEEL_DARK, 0.5);
    }
    const RUNG = 0.32; // m between rungs, which is what a ship's ladder is
    for (let y = y0 + RUNG; y < top - 0.1; y += RUNG) {
      const rung = new CylinderGeometry(0.022, 0.022, 0.48, 6);
      rung.rotateZ(Math.PI / 2);
      rung.translate(x, y, zAft);
      add(rung, STEEL_DARK, 0.5);
    }
  }

  // The conning trunk: rungs the whole way up its after wall, and a landing light
  // every few metres so the climb is not twelve metres of black.
  //
  // Marked `roomLit` like the wheelhouse is — this is the inside of a room, and a
  // lamp in it has to go through the paint rather than over it or the shaft comes
  // out as one flat colour with a ladder-shaped silhouette in it. See the note on
  // `roomLit` in shipMaterial.js.
  const connLamps = [];
  {
    const h = conn().half;
    const top = y0 + deckTop();
    const zAft = trunkZ() - h + 0.09;
    const room = (geo, color, rough = 0.45, metal = 0.7) => geoms.push(paint(geo, {
      color, roughness: rough, metal, slot, roomLit: 1,
    }));
    for (const dx of [-0.26, 0.26]) {
      const stringer = new CylinderGeometry(0.035, 0.035, top - y0, 6);
      stringer.translate(trunkX() + dx, (y0 + top) / 2, zAft);
      room(stringer, STEEL_DARK, 0.5, 0.85);
    }
    const RUNG = 0.32;
    for (let y = y0 + RUNG; y < top - 0.1; y += RUNG) {
      const rung = new CylinderGeometry(0.024, 0.024, 0.52, 6);
      rung.rotateZ(Math.PI / 2);
      rung.translate(trunkX(), y, zAft);
      room(rung, STEEL_DARK, 0.5, 0.85);
    }
    // A bulb in a wire guard on the forward wall, four of them up the climb. They
    // are the only thing that gives the shaft a height while you are in it:
    // without them the rungs go by and nothing else changes.
    const zFwd = trunkZ() + h - 0.10;
    for (let i = 0; i < 4; i++) {
      const y = y0 + 1.7 + i * ((top - y0 - 2.4) / 3);
      const bulb = new SphereGeometry(0.075, 10, 8);
      bulb.translate(trunkX(), y, zFwd);
      room(bulb, [0.95, 0.88, 0.70], 0.3, 0);
      const guard = new TorusGeometry(0.11, 0.012, 6, 12);
      guard.translate(trunkX(), y, zFwd - 0.01);
      room(guard, STEEL_DARK, 0.45, 0.85);
      const back = new BoxGeometry(0.16, 0.16, 0.06);
      back.translate(trunkX(), y, zFwd + 0.05);
      room(back, [0.33, 0.35, 0.35], 0.5, 0.6);
    }
    // Four fittings, two emitters, and the shaft cut in half between them.
    //
    // Four lamps in the rig would be four boxes for the shader to test on every
    // fragment of the ship, to light a space nobody is in for all but a few
    // seconds of the game; two do the same job because the falloff of one covers
    // six metres of a twelve-metre climb. Each is sealed into its own half of the
    // trunk — the box a lamp is shut in is centred on that lamp's own height (see
    // `setLamps` in shipMaterial.js), so half a shaft is exactly the shape one
    // emitter can be given — and the seal is what stops a light in the middle of
    // the tower coming out on the chart house's paint.
    for (const f of [0.25, 0.75]) {
      const y = y0 + (top - y0) * f;
      connLamps.push({
        x: trunkX(),
        y,
        z: trunkZ(),
        reach: 9,
        soft: 1.8,
        color: [0.58, 0.51, 0.38],
        level: 0.60,
        room: [h + CONN.wall, (top - y0) / 4, h + CONN.wall],
      });
    }
  }

  // And the passage that leads to its foot: two fittings on the deckhead and one
  // emitter between them, sealed into the passage the same way.
  //
  // Without them the last five metres before the ladder are unlit, which reads as
  // a dead end rather than as the way on — and the way on is the whole reason this
  // passage exists. The hallway it comes off is open to the weather at the port
  // end and needs nothing.
  {
    const h = TRUNK.hall;
    const zA = trunkZ();
    const zB = z0 + h.z + h.halfLen;
    const w = conn().half;
    const room = (geo, color, rough = 0.45, metal = 0.7) => geoms.push(paint(geo, {
      color, roughness: rough, metal, slot, roomLit: 1,
    }));
    for (const f of [0.3, 0.7]) {
      const z = zA + (zB - zA) * f;
      const bulb = new SphereGeometry(0.075, 10, 8);
      bulb.translate(0, y0 + h.head - 0.16, z);
      room(bulb, [0.95, 0.88, 0.70], 0.3, 0);
      const guard = new TorusGeometry(0.11, 0.012, 6, 12);
      guard.rotateX(Math.PI / 2);
      guard.translate(0, y0 + h.head - 0.17, z);
      room(guard, STEEL_DARK, 0.45, 0.85);
      const back = new BoxGeometry(0.18, 0.05, 0.18);
      back.translate(0, y0 + h.head - 0.06, z);
      room(back, [0.33, 0.35, 0.35], 0.5, 0.6);
    }
    connLamps.push({
      x: 0,
      y: y0 + h.head / 2,
      z: (zA + zB) / 2,
      reach: 7,
      soft: 1.8,
      color: [0.58, 0.51, 0.38],
      level: 0.5,
      room: [w + CONN.wall, h.head / 2, (zB - zA) / 2 + 0.2],
    });
  }

  {
    const h = conn().half;
    const top = y0 + deckUnder();
    const room = (geo, color, rough = 0.45, metal = 0.7) => geoms.push(paint(geo, {
      color, roughness: rough, metal, slot, roomLit: 1,
    }));
    // The coaming round the hatch at the head of it is the wheelhouse's own — see
    // wheelhouse.js — but the trunk's mouth wants a lip on the *inside* so the
    // last rung has something over it rather than a bare edge of deck.
    for (const sx of [-1, 1]) {
      const a = new BoxGeometry(0.07, 0.5, h * 2);
      a.translate(trunkX() + sx * (h - 0.035), top - 0.25, trunkZ());
      room(a, STEEL_DARK, 0.5, 0.85);
      const b = new BoxGeometry(h * 2, 0.5, 0.07);
      b.translate(trunkX(), top - 0.25, trunkZ() + sx * (h - 0.035));
      room(b, STEEL_DARK, 0.5, 0.85);
    }
  }

  // Brackets under the gangway, so it does not read as glued to the platform, and a
  // kerb each side: a walkway eleven metres up wants an edge to it.
  {
    const gw = gangway()[1]; // the gangway proper, not the landing behind it
    const top = platformTop();
    for (const dz of [-gw.h[2] + 0.15, gw.h[2] - 0.15]) {
      const b = new BoxGeometry(1.6, 0.09, 0.09);
      b.rotateZ(0.5);
      b.translate(TRUNK.x[1] + 0.7, top - 0.7, gw.c[2] + dz);
      add(b, STEEL_DARK, 0.5);
    }
    for (const dz of [-gw.h[2], gw.h[2]]) {
      const k = new BoxGeometry(gw.h[0] * 2, 0.5, 0.06);
      k.translate(gw.c[0], top + 0.25, gw.c[2] + dz);
      add(k, STEEL_DARK, 0.5);
    }
  }

  // A coaming round the door on the weather deck. Without it the way in is a
  // rectangular absence in a grey wall, which reads as a modelling mistake rather
  // than as a door — and this is the one opening on the ship a player has to
  // notice from the deck.
  {
    const h = TRUNK.hall;
    const x = BASE.w / 2; // port side
    const zc = z0 + h.z;
    const frame = (w, hh, l, dy, dz) => {
      const g = new BoxGeometry(w, hh, l);
      g.translate(x + 0.06, y0 + dy, zc + dz);
      add(g, STEEL_DARK, 0.5);
    };
    frame(0.12, h.head + 0.2, 0.16, (h.head + 0.2) / 2, -h.halfLen - 0.08);
    frame(0.12, h.head + 0.2, 0.16, (h.head + 0.2) / 2, h.halfLen + 0.08);
    frame(0.12, 0.16, h.halfLen * 2 + 0.32, h.head + 0.12, 0);
    // and the knee-knocker you step over on the way in
    frame(0.14, 0.18, h.halfLen * 2, 0.09, 0);
  }

  group.add(new Mesh(merge(geoms), materials.body));
  group.traverse((o) => { o.frustumCulled = false; });
  return {
    group, solids, ladders: ladderVolumes(), lamps: connLamps,
  };
}
