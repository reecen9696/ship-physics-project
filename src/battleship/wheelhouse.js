import {
  BoxGeometry, CylinderGeometry, TorusGeometry, SphereGeometry, PlaneGeometry,
  Group, Mesh, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { carveBox } from './carve.js';
import { SUPER } from './spec.js';
import { deckY, zOf, STEEL, STEEL_DARK } from './hull.js';

// The wheelhouse: the room she is conned from.
//
// It is the pagoda's second windowed level — the navigating bridge, the one with
// the gallery round it — and it was a solid box with a painted window band on it,
// like every other level of the tower. It is now a room, on the same terms the
// gunhouses are rooms (see turretHouse.js): one description of the plating, used
// as the thing you can see, the thing you walk against, and the thing the windows
// are cut in. There is no liner, because a carved solid does not need one — every
// piece here is a closed box, so the inside of the wheelhouse is the outward
// faces of the plating around it, and the wall you bump into is the wall you can
// see because there is only one of them.
//
// Three things about it are different from every other space on the ship.
//
// The first is the glass. Every other window on her is opaque — a reflection with
// a suggestion of a lit room behind it, which is the right and cheap answer at
// the range you see a ship from. These ones are the windows you stand *behind*,
// so they are genuinely transparent, in both directions, and they run the whole
// way round: fore, aft and both sides, broken only by the corner posts, the
// mullions and the two doors. Standing at the wheel you can turn on the spot and
// see the whole horizon, which is the one thing a navigating bridge is for. See
// glazing.js.
//
// The second is the hatch. You do not walk into this room from outside — you come
// up into the middle of it, off a ladder in the conning tube, through a hatch in
// the deck with a coaming and a rail round three sides of it. That is what a
// pagoda's bridge levels are reached by and it is the only arrangement that
// leaves the whole of the window band walkable: a door in a side is a door you
// have to leave a lane to, and the lane runs across the view. The two side doors
// are still there, at the after end, but they are the way *out* onto the
// air-defence platform rather than the way in. See CONN below, and the trunk that
// answers it in bridgeAccess.js.
//
// The third is that the lamplight in here goes through the paint rather than over
// it. Every other lamp on the ship lays its spill on flat — see the note on
// `roomLit` in shipMaterial.js — which is right on her outside and is what made
// this room, at night, a single flat yellow with the deck, the deckhead, the
// brass and the teak all exactly the same colour. Everything in here is marked
// `roomLit`, so what you see at night is the room's own materials lit, not a
// lantern-coloured cast over the shape of them.
//
// Frame: everything below is local to the level — the origin is the centre of the
// deck it stands on, +z forward, +y up, +x to port — and `origin()` puts it on
// the ship.

// The level, exactly as superstructure.js draws it. Quoted here rather than
// derived because the tower's rhythm is hand-authored and these three numbers are
// the level's identity: change them there and this asserts rather than drifting.
export const WHEEL = {
  w: 9.0, // the house, across
  l: 8.5, // and fore-and-aft
  dz: 1.4, // forward of the pagoda's centre

  // It stands ON the air-defence platform, and that is worth stating as the reason
  // rather than as a number: the level used to start at 12.6 m, which is 0.85 m
  // above the platform's deck, so the house floated with a gap under it — visible
  // from outside, and something a man on the platform could walk *into*, ending up
  // standing on the platform with his head inside the wheelhouse and the deck of it
  // at his chest. The house now starts at the platform's own surface and is that
  // much taller, so its top, its gallery and everything above it are exactly where
  // they were: the room grew downward into the gap.
  y: 11.75, // = platformTop(), the air-defence platform's deck
  h: 4.25, // 16.0 above the deck, as before

  plate: 0.22, // the plating the windows and the doors are cut in
  floor: 0.25, // the deck you stand on: one step over the coaming from outside
  // The underside of the deckhead: 2.80 m of headroom, and the metre of height
  // above it is structure rather than room. The level is 4.25 m tall now and a room
  // that used all of it would feel like a hall — what is over your head on a bridge
  // is the gallery deck and the beams under it, which is exactly what that metre is.
  ceiling: 3.05,

  // The window band. A sill at 1.40 m above the level's base — a pace over a metre
  // above the deck — is the height a wheelhouse sill actually is: high enough to
  // lean on, low enough to see the water alongside from the wheel. The plating
  // above the head is not waste either: it is where the clock, the barometer and
  // the rest of what hangs on a bulkhead go.
  sill: 1.40,
  head: 2.50,

  // A door each side, at the after end of the room, opening onto the platform.
  // Both, rather than one, because the platform is a ring and you walk out of
  // whichever side the weather is not on. They are right aft so that neither the
  // conning position nor the chart table has a doorway across it.
  door: { z: -2.45, halfLen: 0.5 },

  // The wheel, forward of amidships and a pace short of the forward windows.
  helm: { z: 2.55 },

  // How far apart the mullions stand. Drawn, not structural: a band of glass with
  // nothing dividing it reads as a missing wall.
  mullion: 1.55,
};

// The way up into her: a ladder trunk on the conning tube's axis, coming up
// through the middle of the deck.
//
// The numbers are stated here rather than in bridgeAccess.js, which builds the
// trunk, because the *hatch* is a feature of this room — the deck has to be
// carved round it and the coaming and the rail have to stand on it — and a hole
// in a floor and the shaft under it that disagreed by a centimetre would be a
// gap you could see daylight through, eleven metres up.
//
// `dz` is measured from the pagoda's centre and is not free: it is the
// air-defence platform's own centre, so that the hole the trunk needs through
// that platform is *concentric* with it and can be drawn as a plain annulus
// instead of a disc with a square bite out of one side. See `platform` in
// superstructure.js. It lands the hatch 0.2 m aft of the middle of this room,
// which is as near the middle as makes no difference and is where you would put
// it anyway — behind the wheel, clear of the chart table, with the whole of the
// forward half of the room in front of you as you come up.
export const CONN = {
  dz: 1.2, // from the pagoda's centre — the air-defence platform's own dz
  half: 0.95, // the trunk, outside the plating
  wall: 0.22,
  coaming: 0.24, // how far the hatch's rim stands above the deck
};

// How far the deck slab reaches below the level's base.
//
// That is not structure, it is the floor probe: it reads the surface normal a
// hand's breadth *inside* whatever it is standing on, and in a slab only 250 mm
// thick that point is nearer the underside than the top — so the probe answers
// "this is a ceiling", the slope gate rejects it, and the man standing on the
// wheelhouse deck is not standing on anything. Every deck a person walks on has to
// be thicker than that probe reaches.
const DEEP = 0.9;

// The underside of that slab, above the pagoda's base deck. The conning trunk's
// plating stops exactly here and the deck's own carved pieces carry the shaft the
// rest of the way up: two walls that overlap would be two coplanar faces fighting
// for the same pixels down the whole mouth of the hatch.
export const deckUnder = () => WHEEL.y + WHEEL.floor - DEEP;

// The clear opening, half-width — the hatch, and the inside of the shaft under it.
export const conn = () => ({
  half: CONN.half - CONN.wall,
  // in this level's own frame
  z: CONN.dz - WHEEL.dz,
});

// Where the level sits on the ship.
export const origin = () => new Vector3(
  0, deckY(SUPER.bridge.z) + WHEEL.y, zOf(SUPER.bridge.z) + WHEEL.dz,
);

// The top of her deck, above the pagoda's own base deck: where the ladder in the
// conning tube stops, and the one number the trunk and this room have to agree on.
export const deckTop = () => WHEEL.y + WHEEL.floor;

// The room, inside the plating.
export const inner = () => ({
  hx: WHEEL.w / 2 - WHEEL.plate,
  hz: WHEEL.l / 2 - WHEEL.plate,
});

// The room is *lined*, not painted one colour, and that is most of the difference
// between a room and a grey box. A ship's wheelhouse has half a dozen surfaces and
// they are half a dozen different things: a dark composition deck with a red-brown
// border laid round the edge of it, grey bulkheads with the frames of the plating
// showing on them, a near-white deckhead, brass, teak and painted instrument
// faces. None of it reads at night unless the lamps go through the colour rather
// than over it, which is what `roomLit` below is for.
//
// The linings are drawn *inside* the plating rather than instead of it, so none of
// this changes what she looks like from the sea: the same boxes are still her side.
const LINER = [0.44, 0.465, 0.48]; // bulkhead grey: lighter than her outside paint
const DECK_FIELD = [0.175, 0.165, 0.150]; // dark composition, the colour of a bridge deck
const DECK_BORDER = [0.255, 0.135, 0.100]; // the red-brown border round it, as laid
const DECKHEAD = [0.70, 0.705, 0.69]; // near-white: it is what lights the room
const RIB = [0.355, 0.375, 0.39]; // frames and stiffeners standing off the bulkhead
const FRAME = [0.40, 0.43, 0.45]; // window frames and mullions
const BRASS = [0.56, 0.42, 0.16];
const TEAK = [0.315, 0.215, 0.125];
const PANEL = [0.09, 0.34, 0.36]; // instrument faces
const BLACK = [0.055, 0.055, 0.062];
const GLASSY = [0.74, 0.75, 0.72];

// Everything in this room is a surface of this room, so everything in it is
// marked. One constant rather than the flag written out forty times, because the
// day one of them is left off is the day one object in here is the old flat
// yellow and nobody can work out why.
const ROOM = { roomLit: 1 };

// Where the four deckhead fittings hang, in the level's own frame. One list, read
// by the thing that draws them and by the thing that lights the room with them.
const LIGHTS = [[-2.25, 2.15], [2.25, 2.15], [-2.25, -1.95], [2.25, -1.95]];

// --- the plating -------------------------------------------------------------
//
// One list, in the level's own frame. `look.gear` marks the helmsman's station,
// which is solid as a box and drawn as a console; everything else is a box and is
// both.
//
// A wall with an opening in it is stated as the pieces left over rather than as a
// wall and a hole, for the reason at the head of carve.js: pieces are closed
// boxes and a hole is not, and only one of the two can be walked into and looked
// at with the same geometry. The deck is the same argument one floor down — it
// has a hatch through the middle of it, so it is four pieces of deck rather than
// one piece with a hole, and `carveBox` is what works out which four.
export function panels() {
  const W = WHEEL;
  const { hx, hz } = inner();
  const C = conn();
  const out = [];
  const add = (id, c, h, look = {}) => out.push({ id, c, h, look });

  const midWall = (y0, y1) => [(y0 + y1) / 2, (y1 - y0) / 2];

  // The deck and the deckhead, both the full footprint — so they are the outside
  // of the level as well as its floor and its ceiling. The deck reaches well below
  // the level's own base, down into the platform it stands on; see DEEP above for
  // why it has to.
  for (const p of carveBox({
    min: [-W.w / 2, W.floor - DEEP, -W.l / 2],
    max: [W.w / 2, W.floor, W.l / 2],
  }, [{
    // the hatch, all the way through: a void that spans the slab's whole height
    // leaves four pieces of deck and no lip across the opening.
    min: [-C.half, W.floor - DEEP - 1, C.z - C.half],
    max: [C.half, W.floor + 1, C.z + C.half],
  }])) {
    add('wheelhouse.deck', p.c, p.h, { color: LINER, rough: 0.6 });
  }
  add('wheelhouse.head', [0, (W.ceiling + W.h) / 2, 0],
    [W.w / 2, (W.h - W.ceiling) / 2, W.l / 2], { color: LINER, rough: 0.55 });

  // The four walls. Each is a strip under the window band and a strip over it;
  // the sides run the full length so the corners are closed by them, and the fore
  // and aft walls finish inside them.
  const [loY, loH] = midWall(W.floor, W.sill);
  const [hiY, hiH] = midWall(W.head, W.ceiling);
  const t = W.plate / 2;

  // port and starboard, cut by their doors
  for (const side of [-1, 1]) {
    const x = side * (W.w / 2 - t);
    const d = W.door;
    for (const [z0, z1] of [[-W.l / 2, d.z - d.halfLen], [d.z + d.halfLen, W.l / 2]]) {
      add('wheelhouse.side', [x, loY, (z0 + z1) / 2], [t, loH, (z1 - z0) / 2],
        { color: LINER, rough: 0.5 });
    }
    add('wheelhouse.side', [x, hiY, 0], [t, hiH, W.l / 2], { color: LINER, rough: 0.5 });
    // and the piece over the doorway, between its head and the deckhead
    add('wheelhouse.side', [x, hiY, d.z], [t, hiH, d.halfLen], { color: LINER, rough: 0.5 });
  }

  // fore and aft, between the side walls
  for (const end of [-1, 1]) {
    const z = end * (W.l / 2 - t);
    add('wheelhouse.end', [0, loY, z], [hx, loH, t], { color: LINER, rough: 0.5 });
    add('wheelhouse.end', [0, hiY, z], [hx, hiH, t], { color: LINER, rough: 0.5 });
  }

  // The corner posts. Without them the band's four openings meet at the corners
  // and the level has no corners — which is both structurally silly and the one
  // thing that makes a glazed box read as a greenhouse.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add('wheelhouse.post',
        [sx * (W.w / 2 - t), (W.sill + W.head) / 2, sz * (W.l / 2 - t)],
        [t, (W.head - W.sill) / 2, t], { color: FRAME, rough: 0.45 });
    }
  }

  // The hatch coaming: a rim four fingers high round the opening, which is what
  // stops a bucket of water going down the trunk and — the part that matters here
  // — what stops the hole reading as a rectangle painted on the deck. It is under
  // `stepUp`, so the floor probe walks over it rather than the player having to.
  const cm = 0.09;
  for (const sx of [-1, 1]) {
    add('wheelhouse.coaming', [sx * (C.half + cm), W.floor + CONN.coaming / 2, C.z],
      [cm, CONN.coaming / 2, C.half + cm * 2], { color: RIB, rough: 0.45 });
    add('wheelhouse.coaming', [0, W.floor + CONN.coaming / 2, C.z + sx * (C.half + cm)],
      [C.half, CONN.coaming / 2, cm], { color: RIB, rough: 0.45 });
  }

  // The rail round three sides of the hatch. Open forward, which is the side you
  // step off onto — a hoop closed all the way round is a thing to climb over at
  // the top of a twelve-metre ladder.
  //
  // Two rails, at 1.00 m and 0.55 m, and the heights are not decoration. The wall
  // solver samples the body at three heights — `stepUp` + 0.1, mid-chest and the
  // crown, which on this man are 0.55, 1.00 and 1.44 — and a bar that falls
  // between two of them is a bar he walks straight through. One rail at each of
  // the lower two is a guardrail that is actually a guard, and it happens to be
  // where a ship puts them anyway. See `wallHeights` in player/character.js.
  const rr = 0.055;
  const outer = C.half + 0.20;
  const stanchion = (x, z) => add('wheelhouse.hatchrail',
    [x, W.floor + 0.53, z], [0.045, 0.53, 0.045], { color: STEEL_DARK, rough: 0.4 });
  for (const sx of [-1, 1]) {
    stanchion(sx * outer, C.z - outer);
    stanchion(sx * outer, C.z + outer);
    for (const RH of [1.00, 0.55]) {
      // the rails down each side...
      add('wheelhouse.hatchrail', [sx * outer, W.floor + RH, C.z],
        [rr, rr, outer], { color: STEEL_DARK, rough: 0.4 });
    }
  }
  // ...and across the after end
  for (const RH of [1.00, 0.55]) {
    add('wheelhouse.hatchrail', [0, W.floor + RH, C.z - outer],
      [outer, rr, rr], { color: STEEL_DARK, rough: 0.4 });
  }

  // The helmsman's station: the wheel, the telegraph and the binnacle, as one
  // waist-high block you walk up to rather than through.
  add('wheelhouse.helm', [0, W.floor + 0.52, W.helm.z], [1.30, 0.52, 0.48],
    { gear: true });

  // The chart table, to port, and the settee and lockers to starboard. Both are
  // solid, because a room you can walk through the furniture of is a room with
  // nothing in it.
  add('wheelhouse.chart', [3.20, W.floor + 0.44, 0.55], [0.92, 0.44, 1.05],
    { table: true });
  add('wheelhouse.locker', [-3.55, W.floor + 0.44, -0.10], [0.62, 0.44, 1.65],
    { locker: true });

  return out;
}

// The same list, in the ship's frame — what the colliders carry.
export function wheelhouseSolids() {
  const o = origin();
  return panels().map((p) => ({
    id: p.id,
    c: [p.c[0] + o.x, p.c[1] + o.y, p.c[2] + o.z],
    h: [...p.h],
  }));
}

// Where the helmsman stands, and where his hands go, both in the ship's frame.
// The station is the wheel; the approach is a pace behind it, facing the bow —
// which is where a helmsman stands and which way he looks.
export function helmStationPoint() {
  const o = origin();
  return {
    station: new Vector3(0, o.y + WHEEL.floor, o.z + WHEEL.helm.z),
    approach: new Vector3(0, o.y + WHEEL.floor + 0.02, o.z + WHEEL.helm.z - 1.25),
    approachHeading: 0, // 0 faces the bow
  };
}

// The threshold outside each door: from the air-defence platform up to the
// wheelhouse's own deck, which is one step over a coaming now that the house stands
// on the platform. Player-only, so it is handed to deckAccess.js rather than to the
// ship's own colliders — see the note at the head of that file.
//
// Each piece runs a good half-metre *under the doorway*, overlapping the room's deck
// inside it. That overlap is the whole reason this is not a list of neat treads
// butted up to the plating: two pieces of deck that merely share a face have a seam,
// and a foot within a few centimetres of that seam is nearest to the *side* of one of
// them — so the floor probe reads a wall where the floor is, and the body drops
// through it. It is the same lap the treads of every ladder aboard have.
export function wheelhouseStoop({ platformTop }) {
  const o = origin();
  const top = o.y + WHEEL.floor;
  const rise = top - platformTop;
  const out = [];
  if (rise < 0.03) return out;
  const RUN = 0.6;
  const LAP = 0.6; // how far each piece reaches in under the door
  const treads = Math.max(1, Math.ceil(rise / 0.42));
  for (const side of [-1, 1]) {
    for (let i = 1; i <= treads; i++) {
      const y = platformTop + (rise * i) / treads;
      // the outer edge of this tread, and the inner one — the topmost reaches in
      // under the doorway, the ones below it stack outboard of that
      const inner = WHEEL.w / 2 - (i === treads ? LAP : -RUN * (treads - i));
      const outer = WHEEL.w / 2 + RUN * (treads - i + 1);
      out.push({
        id: 'wheelhouse.stoop',
        c: new Vector3(
          side * (inner + outer) / 2, (platformTop - 1 + y) / 2, o.z + WHEEL.door.z,
        ),
        h: new Vector3(
          (outer - inner) / 2, (y - platformTop + 1) / 2, WHEEL.door.halfLen + 0.3,
        ),
      });
    }
  }
  return out;
}

// --- what you can see --------------------------------------------------------

// The wheel, the telegraph, the binnacle and the rudder repeat.
//
// It matters that these read as things you work rather than as a grey block: this
// is the only object in the room the player is meant to *do* anything with, and
// the prompt to take the helm has to arrive from something that looks like it
// takes a pair of hands. The wheel and the telegraph both move — see `setHelm`
// and `setTelegraph` — so what the ship is being told is legible from inside the
// room and not only in the corner of the screen.
function buildHelmGear({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const mk = (geo, color, rough = 0.45, metal = 0.8) => paint(geo, {
    color, roughness: rough, metal, slot, ...ROOM,
  });
  const put = (geo, color, rough, metal, x, y, z) => {
    const m = new Mesh(mk(geo, color, rough, metal), M);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  // --- the wheel -------------------------------------------------------------
  //
  // On a pedestal on the centreline, its axis fore-and-aft, with the helmsman
  // standing aft of it. Turned to starboard is clockwise from where he stands,
  // which is +y in his own frame and therefore +z about the wheel's axis: see
  // `setHelm`.
  put(new BoxGeometry(0.44, 0.86, 0.44), STEEL_DARK, 0.5, 0.8, 0, 0.43, 0);
  put(new BoxGeometry(0.60, 0.10, 0.60), BLACK, 0.6, 0.5, 0, 0.05, 0);
  const wheel = new Group();
  wheel.position.set(0, 1.12, -0.12);
  const R = 0.5;
  wheel.add(new Mesh(mk(new TorusGeometry(R, 0.038, 8, 28), BRASS, 0.32, 0.9), M));
  for (let i = 0; i < 5; i++) {
    const spoke = new Mesh(mk(new BoxGeometry(0.032, R * 2 - 0.02, 0.032), TEAK, 0.6, 0.2), M);
    spoke.rotation.z = (i / 5) * Math.PI;
    wheel.add(spoke);
    // and the handle on the end of it, which is what a ship's wheel is gripped by
    const grip = new Mesh(mk(new CylinderGeometry(0.028, 0.022, 0.2, 8), TEAK, 0.7, 0.1), M);
    const a = (i / 5) * Math.PI;
    grip.position.set(Math.cos(a) * (R + 0.11), Math.sin(a) * (R + 0.11), 0);
    grip.rotation.z = a + Math.PI / 2;
    wheel.add(grip);
    const grip2 = grip.clone();
    grip2.position.set(-Math.cos(a) * (R + 0.11), -Math.sin(a) * (R + 0.11), 0);
    wheel.add(grip2);
  }
  wheel.add(new Mesh(mk(new CylinderGeometry(0.075, 0.075, 0.16, 12), BRASS, 0.3, 0.9), M)
    .rotateX(Math.PI / 2));
  g.add(wheel);

  // the rudder indicator over the wheel: what the rudder is actually doing, as
  // against what the wheel is asking for
  const dial = new Group();
  dial.position.set(0, 1.62, -0.02);
  dial.add(new Mesh(mk(new BoxGeometry(0.62, 0.18, 0.09), STEEL_DARK, 0.4, 0.85), M));
  dial.add(new Mesh(mk(new BoxGeometry(0.54, 0.11, 0.02), PANEL, 0.2, 0.1), M)
    .translateZ(-0.05));
  const needle = new Mesh(mk(new BoxGeometry(0.03, 0.11, 0.02), [0.72, 0.24, 0.12], 0.35, 0.2), M);
  needle.position.z = -0.062;
  dial.add(needle);
  g.add(dial);
  put(new CylinderGeometry(0.035, 0.035, 0.5, 8), STEEL, 0.4, 0.9, 0, 1.36, 0.02);

  // --- the engine-room telegraph ---------------------------------------------
  // A pedestal to starboard with a face and a lever. The lever stands where the
  // last order was rung down.
  const tele = new Group();
  tele.position.set(-0.98, 0, 0.04);
  tele.add(new Mesh(mk(new CylinderGeometry(0.17, 0.22, 0.92, 12), STEEL_DARK, 0.5, 0.85), M)
    .translateY(0.46));
  tele.add(new Mesh(mk(new CylinderGeometry(0.30, 0.30, 0.1, 20), BRASS, 0.3, 0.9), M)
    .translateY(0.97));
  const face = new Mesh(mk(new CylinderGeometry(0.26, 0.26, 0.03, 20), PANEL, 0.15, 0.1), M);
  face.position.y = 1.03;
  tele.add(face);
  const lever = new Group();
  lever.position.set(0, 1.03, 0);
  const arm = new Mesh(mk(new BoxGeometry(0.05, 0.05, 0.3), BRASS, 0.3, 0.9), M);
  arm.position.z = 0.15;
  lever.add(arm);
  const knob = new Mesh(mk(new SphereGeometry(0.055, 10, 8), TEAK, 0.6, 0.15), M);
  knob.position.z = 0.32;
  lever.add(knob);
  tele.add(lever);
  g.add(tele);

  // --- the binnacle ----------------------------------------------------------
  // To port, on the centreline of the helmsman's eye: the compass he actually
  // steers by, with its hood over it and the two soft-iron spheres either side.
  const bin = new Group();
  bin.position.set(0.98, 0, 0.04);
  bin.add(new Mesh(mk(new CylinderGeometry(0.20, 0.26, 1.0, 14), TEAK, 0.6, 0.2), M)
    .translateY(0.50));
  bin.add(new Mesh(mk(new SphereGeometry(0.24, 14, 10), BRASS, 0.25, 0.9), M).translateY(1.04));
  bin.add(new Mesh(mk(new CylinderGeometry(0.19, 0.19, 0.04, 18), GLASSY, 0.4, 0.1), M)
    .translateY(1.10));
  for (const s of [-1, 1]) {
    bin.add(new Mesh(mk(new SphereGeometry(0.10, 10, 8), BLACK, 0.5, 0.3), M)
      .translateX(s * 0.30).translateY(0.86));
    bin.add(new Mesh(mk(new BoxGeometry(0.06, 0.10, 0.06), STEEL_DARK, 0.5, 0.85), M)
      .translateX(s * 0.30).translateY(0.76));
  }
  g.add(bin);

  g.traverse((o) => { o.frustumCulled = false; });
  return { group: g, wheel, lever, needle };
}

// The chart table, on the port side under the window.
//
// A table and not the shelf that used to hang here, and that is the room getting
// its space back rather than a change of taste. The shelf was hung on the
// bulkhead because the conning tube used to come up through the after half of the
// level and there was nowhere on the deck to put anything; the tube is out of this
// level's height now and there are three clear metres of deck to port of the
// wheel. So it is what a navigating bridge actually has: a table you can get a
// full chart on, drawers under it, a fiddle round the edge so the chart stays on
// it in a sea, and a shaded lamp over it.
function buildChartTable({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const mk = (geo, color, rough, metal) => paint(geo, {
    color, roughness: rough, metal, slot, ...ROOM,
  });
  const put = (geo, color, rough, metal, x, y, z) => {
    const m = new Mesh(mk(geo, color, rough, metal), M);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const W = 1.80; // across, athwartships is the short way
  const L = 2.05; // fore-and-aft
  const H = 0.88;

  put(new BoxGeometry(W, 0.07, L), TEAK, 0.55, 0.1, 0, H, 0);
  // the chart on it, and the parallel rule and the dividers lying across it
  put(new BoxGeometry(W - 0.24, 0.012, L - 0.26), [0.56, 0.545, 0.485], 0.85, 0, 0, H + 0.042, 0);
  put(new BoxGeometry(0.55, 0.014, 0.10), [0.62, 0.60, 0.53], 0.7, 0, -0.18, H + 0.055, 0.35)
    .rotateY(0.5);
  put(new BoxGeometry(0.05, 0.02, 0.30), BRASS, 0.3, 0.9, 0.35, H + 0.055, -0.42)
    .rotateY(-0.7);
  // the fiddle round three sides of it
  for (const s of [-1, 1]) {
    put(new BoxGeometry(0.05, 0.09, L), TEAK, 0.5, 0.1, s * (W / 2 - 0.025), H + 0.075, 0);
    put(new BoxGeometry(W, 0.09, 0.05), TEAK, 0.5, 0.1, 0, H + 0.075, s * (L / 2 - 0.025));
  }
  // the drawer front under it, and the plinth it stands on
  // The body is well inside the top, so the table reads as a table rather than as
  // a chest with a lid: an overhang you could get your knees under is most of what
  // says "you work at this" about a piece of furniture.
  put(new BoxGeometry(W - 0.42, 0.60, L - 0.42), [0.295, 0.31, 0.32], 0.6, 0.5, 0, H - 0.37, 0);
  for (const s of [-1, 1]) {
    put(new BoxGeometry(W - 0.60, 0.02, 0.03), BRASS, 0.3, 0.9,
      0, H - 0.22 + s * 0.24, -(L - 0.42) / 2 - 0.01);
  }
  put(new BoxGeometry(W - 0.55, 0.14, L - 0.55), BLACK, 0.7, 0.3, 0, 0.07, 0);

  // a chart lamp on a bracket over the after end of it
  const lampY = H + 0.95;
  put(new CylinderGeometry(0.025, 0.025, 0.85, 8), STEEL_DARK, 0.5, 0.85, 0, H + 0.5, -L / 2 + 0.15);
  put(new CylinderGeometry(0.13, 0.05, 0.14, 12, 1, true), [0.34, 0.35, 0.34], 0.5, 0.5,
    0, lampY, -L / 2 + 0.42);
  put(new SphereGeometry(0.055, 10, 8), [0.92, 0.86, 0.70], 0.35, 0, 0, lampY - 0.05, -L / 2 + 0.42);
  put(new BoxGeometry(0.03, 0.03, 0.30), STEEL_DARK, 0.5, 0.85, 0, lampY + 0.04, -L / 2 + 0.28);

  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

// The starboard side: a settee over a run of flag lockers, which is where
// everybody who is not steering actually is.
function buildLockers({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const mk = (geo, color, rough, metal) => paint(geo, {
    color, roughness: rough, metal, slot, ...ROOM,
  });
  const put = (geo, color, rough, metal, x, y, z) => {
    const m = new Mesh(mk(geo, color, rough, metal), M);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const D = 1.20; // across
  const L = 3.30; // fore-and-aft
  const H = 0.88;

  put(new BoxGeometry(D, H - 0.08, L), [0.315, 0.33, 0.34], 0.6, 0.5, 0, (H - 0.08) / 2, 0);
  put(new BoxGeometry(D + 0.06, 0.08, L + 0.06), TEAK, 0.5, 0.1, 0, H - 0.04, 0);
  // the locker fronts: five doors with a brass ring pull on each, which is what
  // turns one long box into a run of lockers
  for (let i = 0; i < 5; i++) {
    const z = -L / 2 + L * ((i + 0.5) / 5);
    put(new BoxGeometry(0.03, H - 0.26, L / 5 - 0.09), [0.275, 0.29, 0.30], 0.6, 0.5,
      D / 2 + 0.005, (H - 0.08) / 2, z);
    put(new TorusGeometry(0.045, 0.012, 6, 12), BRASS, 0.3, 0.9, D / 2 + 0.03, H / 2, z)
      .rotateY(Math.PI / 2);
  }
  // a cushion along the top of it
  put(new BoxGeometry(D - 0.14, 0.10, L - 0.16), [0.13, 0.16, 0.20], 0.9, 0, 0, H + 0.045, 0);

  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

// The after bulkhead, fitted out.
//
// The armoured conning tube used to come up through the middle of this room, which
// is what a real pagoda has and which made the room a horseshoe to walk round. It
// has been taken out of the room's height — see the column in superstructure.js,
// which is now drawn in two pieces with this level's clear between them — so the
// wheelhouse is one open space with a bulkhead across the after end of it, and this
// is what is on that bulkhead: the voicepipes the bridge talks to the ship through,
// a bracket clock and a barometer, and the switchboard.
function buildAfterBulkhead({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const mk = (geo, color, rough, metal) => paint(geo, {
    color, roughness: rough, metal, slot, ...ROOM,
  });
  const put = (geo, color, rough, metal, x, y, z) => {
    const m = new Mesh(mk(geo, color, rough, metal), M);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const zw = -(WHEEL.l / 2 - WHEEL.plate); // the inner face of the after bulkhead

  // --- voicepipes -------------------------------------------------------------
  // The wheelhouse talks to the engine room, the director and the tower through
  // these, and they are the one fitting in here that is unmistakably a ship's.
  for (const i of [0, 1, 2]) {
    const x = 1.20 + i * 0.36;
    const h = 1.42 + (i % 2) * 0.14;
    const pipe = put(new CylinderGeometry(0.055, 0.055, h, 10), BRASS, 0.35, 0.9,
      x, WHEEL.floor + h / 2, zw + 0.22 + (i % 2) * 0.05);
    const bell = new Mesh(mk(new CylinderGeometry(0.13, 0.055, 0.2, 12, 1, true), BRASS, 0.3, 0.9), M);
    bell.position.set(pipe.position.x, WHEEL.floor + h + 0.06, pipe.position.z);
    bell.rotation.x = 0.45; // turned toward the man at the wheel, who is forward
    g.add(bell);
    // the bracket that holds it off the bulkhead
    put(new BoxGeometry(0.09, 0.09, 0.2), RIB, 0.5, 0.85, x, WHEEL.floor + h * 0.75, zw + 0.11);
  }

  // --- the switchboard ---------------------------------------------------------
  // A grey box with a black face and a row of brass switches on it, on the
  // starboard half of the bulkhead: where the lighting in here is turned on and
  // off, and the one thing on this wall that is neither brass nor a dial.
  {
    const x = -1.75;
    const y = WHEEL.floor + 1.30;
    put(new BoxGeometry(1.30, 0.80, 0.16), [0.335, 0.35, 0.355], 0.55, 0.6, x, y, zw + 0.08);
    put(new BoxGeometry(1.12, 0.62, 0.03), BLACK, 0.4, 0.3, x, y, zw + 0.17);
    for (let i = 0; i < 6; i++) {
      put(new CylinderGeometry(0.022, 0.022, 0.09, 8), BRASS, 0.3, 0.9,
        x - 0.45 + i * 0.18, y - 0.16, zw + 0.20).rotateX(Math.PI / 2 + 0.5);
    }
    for (let i = 0; i < 3; i++) {
      put(new CylinderGeometry(0.05, 0.05, 0.03, 12), i === 0 ? [0.66, 0.20, 0.10] : PANEL,
        0.25, 0.1, x - 0.36 + i * 0.36, y + 0.16, zw + 0.19).rotateX(Math.PI / 2);
    }
  }

  // --- a clock, and the barometer beside it ------------------------------------
  // Two discs on a grey bulkhead, and they do a great deal of work: they are the
  // only things in the room that are neither structure nor a control, so they are
  // what tells you this is a room somebody works in. They go on the plating *above*
  // the window band — hung in the band they would be two dials floating in the sea.
  // Measured from the level's base like the band is, not from the deck: everything
  // else in this room stands on the deck and takes `floor`, and a dial hung on a
  // bulkhead does not.
  const dialY = (WHEEL.head + WHEEL.ceiling) / 2;
  const clock = put(new CylinderGeometry(0.20, 0.20, 0.07, 18), [0.86, 0.85, 0.80], 0.4, 0.1,
    -1.5, dialY, zw + 0.05);
  clock.rotation.x = Math.PI / 2;
  put(new TorusGeometry(0.21, 0.025, 6, 18), BRASS, 0.3, 0.9, -1.5, dialY, zw + 0.07);
  for (const [len, w, a] of [[0.15, 0.014, 1.1], [0.11, 0.02, 4.0]]) {
    const hand = put(new BoxGeometry(w, len, 0.02), BLACK, 0.5, 0.2,
      -1.5 + Math.sin(a) * len * 0.5, dialY + Math.cos(a) * len * 0.5, zw + 0.10);
    hand.rotation.z = -a;
  }
  const baro = put(new CylinderGeometry(0.14, 0.14, 0.06, 16), [0.82, 0.81, 0.76], 0.4, 0.1,
    -2.25, dialY, zw + 0.05);
  baro.rotation.x = Math.PI / 2;
  put(new TorusGeometry(0.15, 0.02, 6, 16), BRASS, 0.3, 0.9, -2.25, dialY, zw + 0.07);

  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

// What makes the inside of the room read as the inside of a steel room.
//
// The plating is drawn once and is both her side and this room's walls, so it can
// only be one colour — and a grey box with grey windows in it looks like a grey box.
// These are the linings: the deck, a pale deckhead panel under the deckhead,
// transverse deckhead beams, the light fittings on them, and the frames of her own
// structure standing off the bulkheads. All of it is a few centimetres inside the
// plating, so none of it exists as far as her outside is concerned.
//
// The deck is the part that was doing the least work and is now doing the most. It
// was one flat slab of the darkest colour in the room, 8.5 m by 9, with nothing on
// it — which from standing height is a single unbroken field filling the bottom
// half of the view, and no amount of fitting out the walls rescues a room whose
// floor is a void. It is laid the way a deck is actually laid: a field of dark
// composition, a red-brown border round the edge of it, and a brass strip along
// every joint between the two — so there is a line to read the size of the room
// against wherever you look down.
function buildLining({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const { hx, hz } = inner();
  const C = conn();
  const add = (geo, color, rough, metal = 0.6) => {
    g.add(new Mesh(paint(geo, {
      color, roughness: rough, metal, slot, ...ROOM,
    }), M));
  };
  const slab = (w, h, l, x, y, z, color, rough, metal) => {
    const geo = new BoxGeometry(w, h, l);
    geo.translate(x, y, z);
    add(geo, color, rough, metal);
  };

  // --- the deck ---------------------------------------------------------------
  const D = WHEEL.floor + 0.02; // the top of the composition
  const BORDER = 0.62; // how wide the border runs round the edge
  const fx = hx - BORDER;
  const fz = hz - BORDER;

  // the border, as four strips rather than a slab under the field: two flat
  // colours meeting on a line is what a laid deck looks like, and one on top of
  // the other is what a rug looks like
  for (const sx of [-1, 1]) {
    slab(BORDER, 0.04, hz * 2, sx * (hx - BORDER / 2), D, 0, DECK_BORDER, 0.8, 0.05);
    slab(fx * 2, 0.04, BORDER, 0, D, sx * (hz - BORDER / 2), DECK_BORDER, 0.8, 0.05);
  }
  // the field, in four panels round the hatch, with the hatch's own opening left out
  for (const [x0, x1, z0, z1] of [
    [-fx, fx, C.z + C.half + 0.10, fz],
    [-fx, fx, -fz, C.z - C.half - 0.10],
    [-fx, -(C.half + 0.10), C.z - C.half - 0.10, C.z + C.half + 0.10],
    [C.half + 0.10, fx, C.z - C.half - 0.10, C.z + C.half + 0.10],
  ]) {
    slab(x1 - x0, 0.04, z1 - z0, (x0 + x1) / 2, D, (z0 + z1) / 2, DECK_FIELD, 0.85, 0.05);
  }
  // the brass strip along every joint: round the field, and round the hatch
  const STRIP = 0.05;
  for (const sx of [-1, 1]) {
    slab(STRIP, 0.05, fz * 2, sx * fx, D + 0.005, 0, BRASS, 0.32, 0.9);
    slab(fx * 2 + STRIP, 0.05, STRIP, 0, D + 0.005, sx * fz, BRASS, 0.32, 0.9);
    slab(STRIP, 0.05, (C.half + 0.10) * 2, sx * (C.half + 0.10), D + 0.005, C.z, BRASS, 0.32, 0.9);
    slab((C.half + 0.10) * 2 + STRIP, 0.05, STRIP, 0, D + 0.005, C.z + sx * (C.half + 0.10),
      BRASS, 0.32, 0.9);
  }
  // and a teak grating where the helmsman stands, which is the one place on any
  // bridge that is not composition: it is what keeps his feet dry and out of the
  // cold, and the slats of it are the finest thing in the room to read scale off.
  {
    const gx = 1.45;
    const gz = 0.50;
    const z0 = WHEEL.helm.z - 1.05;
    slab(gx * 2 + 0.1, 0.05, gz * 2 + 0.1, 0, D + 0.025, z0, [0.20, 0.15, 0.10], 0.7, 0.1);
    const n = 13;
    for (let i = 0; i < n; i++) {
      slab(gx * 2, 0.06, (gz * 2) / n - 0.035, 0, D + 0.06, z0 - gz + ((i + 0.5) * gz * 2) / n,
        TEAK, 0.6, 0.05);
    }
  }

  // --- the deckhead -----------------------------------------------------------
  slab(hx * 2, 0.05, hz * 2, 0, WHEEL.ceiling - 0.025, 0, DECKHEAD, 0.7, 0.1);

  // Deckhead beams, athwartships. They are what gives the ceiling a scale, and at
  // night they are the thing the light off the deckhead breaks against.
  for (let i = -2; i <= 2; i++) {
    slab(hx * 2, 0.14, 0.13, 0, WHEEL.ceiling - 0.12, i * (hz / 2.6), RIB, 0.5, 0.8);
  }

  // The lights themselves, hung between the beams: four shallow dished fittings
  // with a bulb under each. They are where the light in here actually comes from
  // at night — see `lamps` at the foot of buildWheelhouse, which puts the emitters
  // at these four positions — and a lit room with no visible fitting in it is the
  // sort of thing you cannot name and can always see.
  for (const [x, z] of LIGHTS) {
    const shade = new BoxGeometry(0.46, 0.07, 0.46);
    shade.translate(x, WHEEL.ceiling - 0.10, z);
    add(shade, [0.36, 0.375, 0.38], 0.5, 0.6);
    const glass = new SphereGeometry(0.115, 12, 8);
    glass.translate(x, WHEEL.ceiling - 0.19, z);
    add(glass, [0.95, 0.90, 0.76], 0.3, 0.0);
    const guard = new TorusGeometry(0.135, 0.014, 6, 14);
    guard.rotateX(Math.PI / 2);
    guard.translate(x, WHEEL.ceiling - 0.20, z);
    add(guard, STEEL_DARK, 0.45, 0.85);
  }

  // Frames on the bulkheads: verticals under the sill and over the head, which is
  // where her structure would show. Not on the glass — a mullion is a different
  // thing and is drawn with the windows.
  const rib = 0.1;
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      const z = i * (hz / 2.6);
      if (Math.abs(z - WHEEL.door.z) < WHEEL.door.halfLen + 0.2) continue; // not in a doorway
      slab(rib, WHEEL.sill - WHEEL.floor - 0.02, rib * 1.2,
        side * (hx - rib / 2), (WHEEL.floor + WHEEL.sill) / 2, z, RIB, 0.5, 0.8);
      slab(rib, WHEEL.ceiling - WHEEL.head - 0.02, rib * 1.2,
        side * (hx - rib / 2), (WHEEL.head + WHEEL.ceiling) / 2, z, RIB, 0.5, 0.8);
    }
  }
  for (const end of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      slab(rib * 1.2, WHEEL.sill - WHEEL.floor - 0.02, rib,
        i * (hx / 2.6), (WHEEL.floor + WHEEL.sill) / 2, end * (hz - rib / 2), RIB, 0.5, 0.8);
    }
  }
  // and a rubbing strake round the room at sill height, which is what everybody
  // aboard actually holds on to
  for (const side of [-1, 1]) {
    slab(0.07, 0.09, hz * 2 - 0.1, side * (hx - 0.05), WHEEL.sill - 0.14, 0, RIB, 0.45, 0.85);
  }
  for (const end of [-1, 1]) {
    slab(hx * 2 - 0.1, 0.09, 0.07, 0, WHEEL.sill - 0.14, end * (hz - 0.05), RIB, 0.45, 0.85);
  }

  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

export function buildWheelhouse({ materials, slot }) {
  const W = WHEEL;
  const o = origin();
  const { hx: hxRoom, hz: hzRoom } = inner();
  const group = new Group();
  group.name = 'wheelhouse';
  group.position.copy(o);
  const M = materials.body;

  // the plating, from the one list the collision comes from
  let gear = null;
  for (const p of panels()) {
    if (p.look.gear) {
      gear = buildHelmGear({ materials, slot });
      gear.group.position.set(p.c[0], W.floor, p.c[2]);
      group.add(gear.group);
      continue;
    }
    if (p.look.table || p.look.locker) {
      const f = p.look.table
        ? buildChartTable({ materials, slot })
        : buildLockers({ materials, slot });
      f.position.set(p.c[0], W.floor, p.c[2]);
      group.add(f);
      continue;
    }
    const m = new Mesh(paint(new BoxGeometry(p.h[0] * 2, p.h[1] * 2, p.h[2] * 2), {
      color: p.look.color, roughness: p.look.rough, metal: 0.7, slot, ...ROOM,
    }), M);
    m.position.set(p.c[0], p.c[1], p.c[2]);
    group.add(m);
  }

  // the after bulkhead's fittings, and the linings that make the room a room
  group.add(buildAfterBulkhead({ materials, slot }));
  group.add(buildLining({ materials, slot }));

  // --- the glass -------------------------------------------------------------
  //
  // One pane per run of band, at the middle of the plating so it sits in its
  // opening rather than on the face of it, on the transparent program. Panes cast
  // no shadow: a sheet of glass has no thickness to cast one with, and a shadow
  // caster that writes no depth is a black rectangle laid across the platform
  // below.
  const bandY = (W.sill + W.head) / 2;
  const bandH = W.head - W.sill;
  const t = W.plate / 2;
  const pane = (geo, x, y, z, ry) => {
    const m = new Mesh(geo, materials.clearGlass);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = false;
    m.userData.noShadow = true;
    m.frustumCulled = false;
    group.add(m);
  };
  // fore and aft, out to the middle of the side plating so the corners meet
  for (const end of [-1, 1]) {
    pane(new PlaneGeometry((W.w / 2 - t) * 2, bandH), 0, bandY, end * (W.l / 2 - t), 0);
  }
  // and the two sides, in the segments their doors leave
  for (const side of [-1, 1]) {
    const d = W.door;
    for (const [z0, z1] of [[-(W.l / 2 - t), d.z - d.halfLen], [d.z + d.halfLen, W.l / 2 - t]]) {
      pane(new PlaneGeometry(z1 - z0, bandH), side * (W.w / 2 - t), bandY, (z0 + z1) / 2,
        side * Math.PI / 2);
    }
  }

  // --- the frames ------------------------------------------------------------
  // Mullions in the band and a sill and a head rail round the whole of it. Steel,
  // so they are on the body program with everything else, and they are what give
  // the glass its scale.
  const frames = [];
  const bar = (w, h, l, x, y, z) => {
    const geo = new BoxGeometry(w, h, l);
    geo.translate(x, y, z);
    frames.push(paint(geo, {
      color: FRAME, roughness: 0.45, metal: 0.8, slot, ...ROOM,
    }));
  };
  const count = (span) => Math.max(1, Math.round(span / W.mullion) - 1);
  // fore and aft
  for (const end of [-1, 1]) {
    const span = (W.w / 2 - t) * 2;
    const n = count(span);
    for (let i = 1; i <= n; i++) {
      bar(0.09, bandH, W.plate, -span / 2 + (span * i) / (n + 1), bandY, end * (W.l / 2 - t));
    }
    for (const y of [W.sill, W.head]) bar(span, 0.07, W.plate * 1.1, 0, y, end * (W.l / 2 - t));
  }
  // and the sides, per segment
  for (const side of [-1, 1]) {
    const d = W.door;
    for (const [z0, z1] of [[-(W.l / 2 - t), d.z - d.halfLen], [d.z + d.halfLen, W.l / 2 - t]]) {
      const span = z1 - z0;
      const n = count(span);
      for (let i = 1; i <= n; i++) {
        bar(W.plate, bandH, 0.09, side * (W.w / 2 - t), bandY, z0 + (span * i) / (n + 1));
      }
      for (const y of [W.sill, W.head]) {
        bar(W.plate * 1.1, 0.07, span, side * (W.w / 2 - t), y, (z0 + z1) / 2);
      }
    }
  }
  for (const geo of frames) group.add(new Mesh(geo, M));

  group.traverse((obj) => { obj.frustumCulled = false; });

  // --- what the room is lit by ------------------------------------------------
  //
  // Two different jobs, and they used to be done by one emitter which is why the
  // room came out the colour of a street lamp.
  //
  // The first job is what she looks like from the sea: a wide band of lit glass
  // that throws a warm wash down the tower and onto the gallery under it. That is
  // one emitter in the middle of the band, and it is deliberately weak now — it
  // is lighting *paint at a distance*, and the room behind it no longer depends
  // on it for anything.
  //
  // The second is the room itself, and it is four emitters at the four deckhead
  // fittings rather than one in the middle of the air. Four, because a single
  // point at head height in the centre of a room gives every surface the same
  // distance and the same angle and therefore no shading at all, which is the
  // other half of why this room looked like a clay model of itself. The reach is
  // short — nine metres, which is barely past the plating — so what leaks out
  // through her side is nothing.
  const lamps = [
    {
      x: o.x, y: o.y + bandY, z: o.z, ext: [W.w / 2, bandH / 2, W.l / 2],
      reach: 22, soft: 3.4, color: [0.52, 0.36, 0.17], level: 0.62,
    },
    // and the room's own lights, shut inside the room.
    //
    // `room` is what seals them, and it is why they are where they are rather than
    // up at the fittings: the box the shader tests is centred on the *lamp's* own
    // y and z (see `setLamps` in shipMaterial.js), so a lamp that is to be sealed
    // into a compartment has to sit at that compartment's centre in both. It is
    // free to be anywhere across her, which is the axis that matters here — two
    // emitters four and a half metres apart light a nine-metre room with a
    // direction to it, and one in the middle of it lights every surface from the
    // same angle and at the same distance, which is no lighting at all.
    //
    // The box is the room's own inside, so not a candela of this reaches her
    // outside, the platform under her or the gallery over her. That matters more
    // here than it does in a turret: this room's lights are on whenever she is
    // dark, and a bridge that glowed through its own deck would be visible from
    // the horizon.
    ...[-2.4, 2.4].map((x) => ({
      x: o.x + x,
      y: o.y + 2.0,
      z: o.z,
      reach: 12,
      soft: 2.2,
      // A filament in a deckhead fitting, not a hurricane lamp: warm, but near
      // enough white that the paint, the brass and the teak under it are still
      // three different colours.
      color: [0.56, 0.515, 0.44],
      level: 0.33,
      room: [hxRoom, 2.0, hzRoom],
    })),
  ];

  return {
    group,
    lamps,
    // the plating and the console, as boxes in the ship's frame: what the player
    // walks against, off the same list that was just drawn
    solids: wheelhouseSolids(),
    ...helmStationPoint(),
    // Turn the wheel and stand the telegraph lever where the order was rung down.
    // Both are driven from what the ship is actually doing rather than from the
    // keys pressed, so the gear reads right whoever is driving her.
    setHelm(rudderDeg, maxRudder) {
      if (!gear) return;
      const frac = rudderDeg / Math.max(maxRudder, 1);
      // A full turn each way, hard over to hard over. A steering engine takes
      // several, but the point of turning it at all is that the helmsman can see
      // what the rudder is doing, and half a revolution of a spoked wheel is
      // legible where a tenth of one is not.
      gear.wheel.rotation.z = frac * Math.PI;
      // and the repeat over it, which is the same number said plainly
      gear.needle.position.x = -frac * 0.24;
    },
    setTelegraph(frac) {
      if (!gear) return;
      // -1 (full astern) through +1 (flank ahead), swung through 140 degrees.
      gear.lever.rotation.x = -frac * (70 * Math.PI) / 180;
    },
  };
}
