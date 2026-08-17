import {
  BoxGeometry, CylinderGeometry, TorusGeometry, SphereGeometry, PlaneGeometry,
  Group, Mesh, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
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
// Two things about it are different from every other space on the ship.
//
// The first is the glass. Every other window on her is opaque — a reflection with
// a suggestion of a lit room behind it, which is the right and cheap answer at
// the range you see a ship from. These ones are the windows you stand *behind*,
// so they are genuinely transparent, in both directions, and they run the whole
// way round: fore, aft and both sides, broken only by the corner posts, the
// mullions and the two doors. See glazing.js.
//
// The second is the conning tube. The armoured column runs up through the after
// half of this level — it is drawn from the level below and it is already solid,
// so nothing here has to place it — which makes the room a horseshoe: the wheel
// and the windows forward of the tube, a passage each side of it, and a door at
// the after end of each passage onto the air-defence platform. That is not a
// compromise made to fit the geometry; it is what the inside of a pagoda mast is.
//
// Frame: everything below is local to the level — the origin is the centre of the
// deck it stands on, +z forward, +y up — and `origin()` puts it on the ship.

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

  // The window band. A sill at 1.15 m above the deck is the height a wheelhouse
  // sill actually is — high enough to lean on, low enough to see the water
  // alongside from the wheel. The plating above the head is not waste either: it is
  // where the clock, the barometer and the rest of what hangs on a bulkhead go.
  sill: 1.40,
  head: 2.50,

  // A door each side, at the after end of the room, opening onto the platform.
  // Both, rather than one, because the platform is a ring and you come up onto it
  // wherever the trunk lets you out.
  door: { z: 2.0, halfLen: 0.5 },

  // The wheel, a pace short of the forward windows.
  helm: { z: 3.30 },

  // How far apart the mullions stand. Drawn, not structural: a band of glass with
  // nothing dividing it reads as a missing wall.
  mullion: 1.55,
};

// Where the level sits on the ship.
export const origin = () => new Vector3(
  0, deckY(SUPER.bridge.z) + WHEEL.y, zOf(SUPER.bridge.z) + WHEEL.dz,
);

// The room, inside the plating.
export const inner = () => ({
  hx: WHEEL.w / 2 - WHEEL.plate,
  hz: WHEEL.l / 2 - WHEEL.plate,
});

// The room is *lined*, not painted one colour, and that is most of the difference
// between a room and a grey box. A ship's wheelhouse has three surfaces and they
// are three different things: a dark composition deck you stand on, grey bulkheads
// with the frames of the plating showing on them, and a near-white deckhead —
// because at night the only light in here is what comes off the deckhead.
//
// The linings are drawn *inside* the plating rather than instead of it, so none of
// this changes what she looks like from the sea: the same boxes are still her side.
const LINER = [0.46, 0.49, 0.51]; // bulkhead grey: lighter than her outside paint
const DECK = [0.145, 0.135, 0.125]; // dark composition, the colour of a bridge deck
const DECKHEAD = [0.68, 0.69, 0.68]; // near-white: it is what lights the room
const RIB = [0.38, 0.41, 0.43]; // frames and stiffeners standing off the bulkhead
const FRAME = [0.40, 0.43, 0.45]; // window frames and mullions
const BRASS = [0.52, 0.40, 0.16];
const PANEL = [0.10, 0.42, 0.44];

// --- the plating -------------------------------------------------------------
//
// One list, in the level's own frame. `look.gear` marks the helmsman's station,
// which is solid as a box and drawn as a console; everything else is a box and is
// both.
//
// A wall with an opening in it is stated as the pieces left over rather than as a
// wall and a hole, for the reason at the head of carve.js: pieces are closed
// boxes and a hole is not, and only one of the two can be walked into and looked
// at with the same geometry.
export function panels() {
  const W = WHEEL;
  const { hx, hz } = inner();
  const out = [];
  const add = (id, c, h, look = {}) => out.push({ id, c, h, look });

  const midWall = (y0, y1) => [(y0 + y1) / 2, (y1 - y0) / 2];

  // The deck and the deckhead, both the full footprint — so they are the outside
  // of the level as well as its floor and its ceiling.
  //
  // The deck reaches well below the level's own base, down into the platform it
  // stands on. That is not structure, it is the floor probe: it reads the surface
  // normal a hand's breadth *inside* whatever it is standing on, and in a slab only
  // 250 mm thick that point is nearer the underside than the top — so the probe
  // answers "this is a ceiling", the slope gate rejects it, and the man standing on
  // the wheelhouse deck is not standing on anything. Every deck a person walks on has
  // to be thicker than that probe reaches.
  const DEEP = 0.9;
  add('wheelhouse.deck', [0, (W.floor - DEEP) / 2, 0],
    [W.w / 2, (W.floor + DEEP) / 2, W.l / 2], { color: LINER, rough: 0.6 });
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

  // The helmsman's station: the wheel, the telegraph and the binnacle, as one
  // waist-high block you walk up to rather than through.
  add('wheelhouse.helm', [0, W.floor + 0.55, W.helm.z], [1.15, 0.55, 0.45],
    { gear: true });

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
    approach: new Vector3(0, o.y + WHEEL.floor + 0.02, o.z + WHEEL.helm.z - 1.15),
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

// The wheel, the telegraph, the binnacle and the chart table.
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
    color, roughness: rough, metal, slot, inside: 0.35,
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
  put(new BoxGeometry(0.56, 0.08, 0.56), STEEL_DARK, 0.6, 0.75, 0, 0.04, 0);
  const wheel = new Group();
  wheel.position.set(0, 1.12, -0.12);
  const R = 0.5;
  wheel.add(new Mesh(mk(new TorusGeometry(R, 0.038, 8, 28), BRASS, 0.32, 0.9), M));
  for (let i = 0; i < 5; i++) {
    const spoke = new Mesh(mk(new BoxGeometry(0.032, R * 2 - 0.02, 0.032), [0.30, 0.22, 0.14], 0.6, 0.2), M);
    spoke.rotation.z = (i / 5) * Math.PI;
    wheel.add(spoke);
    // and the handle on the end of it, which is what a ship's wheel is gripped by
    const grip = new Mesh(mk(new CylinderGeometry(0.028, 0.022, 0.2, 8), [0.28, 0.20, 0.13], 0.7, 0.1), M);
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
  dial.add(new Mesh(mk(new BoxGeometry(0.6, 0.16, 0.08), STEEL_DARK, 0.4, 0.85), M));
  const needle = new Mesh(mk(new BoxGeometry(0.03, 0.11, 0.02), [0.72, 0.24, 0.12], 0.35, 0.2), M);
  needle.position.z = -0.05;
  dial.add(needle);
  g.add(dial);
  put(new CylinderGeometry(0.035, 0.035, 0.5, 8), STEEL, 0.4, 0.9, 0, 1.36, 0.02);

  // --- the engine-room telegraph ---------------------------------------------
  // A pedestal to starboard with a face and a lever. Eight notches, and the lever
  // stands where the last order was rung down.
  const tele = new Group();
  tele.position.set(-0.88, 0, 0.04);
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
  const knob = new Mesh(mk(new SphereGeometry(0.055, 10, 8), [0.28, 0.20, 0.13], 0.6, 0.15), M);
  knob.position.z = 0.32;
  lever.add(knob);
  tele.add(lever);
  g.add(tele);

  // --- the binnacle ----------------------------------------------------------
  // To port, on the centreline of the helmsman's eye: the compass he actually
  // steers by.
  const bin = new Group();
  bin.position.set(0.88, 0, 0.04);
  bin.add(new Mesh(mk(new CylinderGeometry(0.20, 0.26, 1.0, 14), [0.30, 0.22, 0.14], 0.6, 0.2), M)
    .translateY(0.50));
  bin.add(new Mesh(mk(new SphereGeometry(0.24, 14, 10), BRASS, 0.25, 0.9), M).translateY(1.04));
  bin.add(new Mesh(mk(new CylinderGeometry(0.19, 0.19, 0.04, 18), [0.72, 0.70, 0.64], 0.4, 0.1), M)
    .translateY(1.10));
  g.add(bin);

  g.traverse((o) => { o.frustumCulled = false; });
  return { group: g, wheel, lever, needle };
}

// A chart shelf under the forward windows: the one piece of furniture in here that
// is not a control, and the thing that makes this a navigating bridge rather than a
// glass box with a wheel in it.
//
// A shelf and not a table, and that is a decision the room made rather than a
// preference. The conning tube takes the after half of the space, so what is left
// is 2.8 m between the tube and the forward windows with the wheel in the middle of
// it: a chart table put anywhere in that would be a thing to walk into, and put in
// one of the side passages it would close the passage. Hung on the bulkhead under
// the sill it is out of the way, and it is where a chart actually lives on a bridge
// this size.
function buildChartShelf({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const mk = (geo, color, rough, metal) => paint(geo, {
    color, roughness: rough, metal, slot, inside: 0.35,
  });
  const top = new Mesh(mk(new BoxGeometry(1.6, 0.06, 0.5), [0.34, 0.26, 0.17], 0.7, 0.1), M);
  g.add(top);
  const chart = new Mesh(mk(new BoxGeometry(1.32, 0.012, 0.38), [0.68, 0.66, 0.58], 0.85, 0), M);
  chart.position.y = 0.036;
  g.add(chart);
  // a lip so the chart stays on it in a sea, and two brackets under it
  const lip = new Mesh(mk(new BoxGeometry(1.6, 0.09, 0.05), [0.30, 0.23, 0.15], 0.7, 0.1), M);
  lip.position.set(0, 0.04, -0.23);
  g.add(lip);
  for (const sx of [-1, 1]) {
    const bracket = new Mesh(mk(new BoxGeometry(0.06, 0.34, 0.34), STEEL_DARK, 0.5, 0.85), M);
    bracket.position.set(sx * 0.62, -0.2, 0.08);
    g.add(bracket);
  }
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
// a bracket clock, and the watertight door aft.
function buildAfterBulkhead({ materials, slot }) {
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
  const zw = -(WHEEL.l / 2 - WHEEL.plate); // the inner face of the after bulkhead

  // --- voicepipes -------------------------------------------------------------
  // The wheelhouse talks to the engine room, the director and the tower through
  // these, and they are the one fitting in here that is unmistakably a ship's.
  for (const i of [0, 1, 2]) {
    const x = 1.15 + i * 0.36;
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
  const rim = put(new TorusGeometry(0.21, 0.025, 6, 18), BRASS, 0.3, 0.9,
    -1.5, dialY, zw + 0.07);
  rim.rotation.z = 0;
  for (const [len, w, a] of [[0.15, 0.014, 1.1], [0.11, 0.02, 4.0]]) {
    const hand = put(new BoxGeometry(w, len, 0.02), [0.1, 0.1, 0.1], 0.5, 0.2,
      -1.5 + Math.sin(a) * len * 0.5, dialY + Math.cos(a) * len * 0.5, zw + 0.10);
    hand.rotation.z = -a;
  }
  const baro = put(new CylinderGeometry(0.14, 0.14, 0.06, 16), [0.82, 0.81, 0.76], 0.4, 0.1,
    -2.25, dialY, zw + 0.05);
  baro.rotation.x = Math.PI / 2;
  const baroRim = put(new TorusGeometry(0.15, 0.02, 6, 16), BRASS, 0.3, 0.9,
    -2.25, dialY, zw + 0.07);
  baroRim.rotation.z = 0;

  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

// What makes the inside of the room read as the inside of a steel room.
//
// The plating is drawn once and is both her side and this room's walls, so it can
// only be one colour — and a grey box with grey windows in it looks like a grey box.
// These are the linings: a dark composition deck laid on the deck plating, a pale
// deckhead panel under the deckhead, transverse deckhead beams, and the frames of
// her own structure standing off the bulkheads. All of it is a few centimetres
// inside the plating, so none of it exists as far as her outside is concerned.
function buildLining({ materials, slot }) {
  const M = materials.body;
  const g = new Group();
  const { hx, hz } = inner();
  const add = (geo, color, rough, metal = 0.6) => {
    g.add(new Mesh(paint(geo, {
      color, roughness: rough, metal, slot, inside: 0.35,
    }), M));
  };
  const slab = (w, h, l, x, y, z, color, rough, metal) => {
    const geo = new BoxGeometry(w, h, l);
    geo.translate(x, y, z);
    add(geo, color, rough, metal);
  };

  // the deck, and the deckhead over it
  slab(hx * 2, 0.04, hz * 2, 0, WHEEL.floor + 0.02, 0, DECK, 0.85, 0.05);
  slab(hx * 2, 0.05, hz * 2, 0, WHEEL.ceiling - 0.025, 0, DECKHEAD, 0.7, 0.1);

  // Deckhead beams, athwartships. They are what gives the ceiling a scale, and at
  // night they are the thing the light off the deckhead breaks against.
  for (let i = -2; i <= 2; i++) {
    slab(hx * 2, 0.14, 0.13, 0, WHEEL.ceiling - 0.12, i * (hz / 2.6), RIB, 0.5, 0.8);
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
  const group = new Group();
  group.name = 'wheelhouse';
  group.position.copy(o);
  const M = materials.body;

  // the plating, from the one list the collision comes from
  let gear = null;
  for (const p of panels()) {
    if (p.look.gear) {
      gear = buildHelmGear({ materials, slot });
      gear.group.position.set(0, W.floor, W.helm.z);
      group.add(gear.group);
      continue;
    }
    const m = new Mesh(paint(new BoxGeometry(p.h[0] * 2, p.h[1] * 2, p.h[2] * 2), {
      color: p.look.color, roughness: p.look.rough, metal: 0.7, slot,
    }), M);
    m.position.set(p.c[0], p.c[1], p.c[2]);
    group.add(m);
  }

  // the chart shelf, on the port half of the forward bulkhead just under the sill
  const shelf = buildChartShelf({ materials, slot });
  shelf.position.set(2.4, W.sill - 0.28, W.l / 2 - W.plate - 0.26);
  group.add(shelf);

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
    frames.push(paint(geo, { color: FRAME, roughness: 0.45, metal: 0.8, slot }));
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

  // What the room is lit by at night, in the ship's frame: the band itself, which
  // is a wide opening with the chart-room lights behind it. One emitter for the
  // whole of it — see the note on MAX_LAMPS in shipMaterial.js.
  const lamps = [{
    x: o.x, y: o.y + bandY, z: o.z,
    ext: [W.w / 2, bandH / 2, W.l / 2],
  }];

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
