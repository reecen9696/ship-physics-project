// Battleship — the single source of truth for her dimensions and layout.
//
// Everything is quoted as a fraction of hull length `L` (fore-and-aft), of the
// half-beam (athwartships) or in metres above the local deck, so the whole ship
// survives a rescale. Station `s` runs 0 at the stern to 1 at the bow;
// z = (s - 0.5) * L. Body frame matches the physics: +z forward, +y up,
// starboard = fwd x up = -x.
//
// Proportions are taken off the reference model (a WWII Japanese-style
// battleship: pagoda foremast, single funnel, tripod mainmast, four twin turrets
// in superfiring pairs, casemate secondaries down each side): L/B ~= 6.1,
// draft ~= 0.29 B, foretop ~= 0.23 L above the waterline.

export const SHIP = {
  length: 180, // m
  halfBeam: 14.75, // m (B = 29.5, L/B = 6.1)
  keel: 8.5, // draft at the deepest station, m
  deck: 6.0, // freeboard amidships, m (main deck above the design waterline)
  get depth() { return this.keel + this.deck; },
};

// Her pennant number, painted on the bow either side. Any string of digits
// works; see hullNumber.js for how it is drawn and where it lands.
export const HULL_NUMBER = '724';

// --- watertight subdivision --------------------------------------------------
// Five hull sections along the length. Each is its own mesh (so it can take
// damage on its own) and its own flooding compartment (so damage there has a
// physical consequence: trim, list, and eventually sinking). Boundaries are
// picked to put the important things in their own box.
export const COMPARTMENTS = [
  { id: 'hull.stern', s: [0.00, 0.16], name: 'Stern', holds: ['steering gear', 'screws'] },
  { id: 'hull.aft', s: [0.16, 0.38], name: 'Aft magazines', holds: ['X/Y magazines', 'aft engine room'] },
  { id: 'hull.mid', s: [0.38, 0.60], name: 'Machinery', holds: ['boilers', 'engine rooms', 'citadel'] },
  { id: 'hull.fore', s: [0.60, 0.82], name: 'Fore magazines', holds: ['A/B magazines'] },
  { id: 'hull.bow', s: [0.82, 1.00], name: 'Bow', holds: ['cable locker', 'stores'] },
];

// --- main battery ------------------------------------------------------------
// Twin turrets in two superfiring pairs. `arcCenter` is the direction the
// turret rests pointing (0 = ahead, 180 = astern) and `arc` the half-width of
// its traverse either side of that; the 60 degrees left over is its blind zone.
// The fore pair is blind astern and the aft pair blind ahead — hull heading
// therefore decides which turrets bear, which is what gives the helm a job in a
// fight (see battleship-crew-stations.md).
// A superfiring turret sits on a raised *bandstand* — a blocky structure built
// up off the deck — not on a tall exposed drum. `bandstand` is how much of the
// rise is that structure; the barbette proper stands the rest, so the gunhouse
// reads as sitting low on a raised deck rather than perched on a pole.
//
// `deckRise` is the barbette height — how far the turret's roller path sits
// above the deck at its own station. The superfiring pair (B and X) have to
// clear the pair in front of them, and the numbers are not symmetric because
// the deck is not level: the sheer lifts the forecastle nearly a metre between
// B's station and A's, so B has to be raised by that much again just to break
// even. See `assertSuperfiringClearance` at the foot of this file, which checks
// the arithmetic against the actual sheer rather than trusting these numbers.
export const TURRETS = [
  { id: 'turret.A', z: +0.25, deckRise: 0.9, arcCenter: 0, arc: 150, compartment: 'hull.fore', superfires: null },
  { id: 'turret.B', z: +0.15, deckRise: 5.6, arcCenter: 0, arc: 150, compartment: 'hull.fore', superfires: 'turret.A', bandstand: 4.0 },
  { id: 'turret.X', z: -0.25, deckRise: 5.4, arcCenter: 180, arc: 150, compartment: 'hull.aft', superfires: 'turret.Y', bandstand: 3.8 },
  { id: 'turret.Y', z: -0.36, deckRise: 0.9, arcCenter: 180, arc: 150, compartment: 'hull.aft', superfires: null },
];

export const TURRET_SPEC = {
  gunhouseW: 10.0, // m across
  gunhouseL: 12.0, // m fore-and-aft (face to rear)
  gunhouseH: 2.7,
  barbetteR: 4.6,
  barrelLength: 16.0,
  barrelR: 0.34, // scales the whole profile; the breech is ~2x this
  barrelSpacing: 2.9, // between the two guns
  trunnionZ: 1.5, // where the guns pivot, forward of the gunhouse centre
  traverseRate: 10, // deg/s
  elevateRate: 6, // deg/s
  elevMin: -4,
  elevMax: 43,
};

// --- secondary battery: casemate guns in the hull side ----------------------
// Fixed mounts; each barrel trains a little way inside its embrasure. Seven a
// side, on the upper hull just under the main deck, between the fore and aft
// superfiring turrets. Positions as fractions of L.
export const CASEMATES = {
  z: [-0.20, -0.13, -0.06, 0.01, 0.08, 0.15, 0.21],
  belowDeck: 2.4, // m the gun axis sits under the deck edge
  barrelLength: 5.5,
  barrelR: 0.14,
  train: 60, // deg either side of abeam
  elevMax: 30,
  rate: 12,
};

// --- AA mounts ---------------------------------------------------------------
// Twin mounts in tubs. `station: true` marks the one the crew-stations spec
// gives a seat: -0.12 L, high on the superstructure with a clear sky.
export const AA_MOUNTS = [
  { id: 'aa.1', x: 0.0, z: -0.085, y: 0, on: 'aftSuper', station: true },
  { id: 'aa.2', x: -0.55, z: -0.02, y: 0, on: 'funnelDeck' },
  { id: 'aa.3', x: +0.55, z: -0.02, y: 0, on: 'funnelDeck' },
  { id: 'aa.4', x: -0.62, z: -0.09, y: 0, on: 'funnelDeck' },
  { id: 'aa.5', x: +0.62, z: -0.09, y: 0, on: 'funnelDeck' },
  { id: 'aa.6', x: 0.0, z: +0.15, y: 0, on: 'turret.B' }, // on B turret's roof
];

// Anything mounted on a deckhouse has to actually sit on it. This is trivially
// easy to get wrong when the numbers are fractions of hull length in one place
// and metres in another, and the result — a tripod mast with a leg hanging in
// mid-air over the sea — is very visible. Checked at build time instead.
export function assertOnDeckhouse(items, house, L) {
  const z0 = house.z * L;
  for (const it of items) {
    const dz = Math.abs(it.z * L - z0);
    if (dz + it.halfLength > house.l / 2 || it.halfWidth > house.w / 2) {
      throw new Error(
        `${it.id} overhangs its deckhouse: needs ±${(dz + it.halfLength).toFixed(1)} m `
        + `fore-and-aft (have ${(house.l / 2).toFixed(1)}) and ±${it.halfWidth.toFixed(1)} m `
        + `across (have ${(house.w / 2).toFixed(1)})`,
      );
    }
  }
}

export const AA_SPEC = {
  traverseRate: 70, // deg/s
  elevMin: 0,
  elevMax: 85,
  barrelLength: 3.2,
  barrelR: 0.07,
  tubR: 1.7,
};

// --- superstructure ----------------------------------------------------------
export const SUPER = {
  bridge: { z: +0.06, base: [10, 14] }, // pagoda foot: [width, length] m
  funnel: { z: -0.04, rx: 3.0, rz: 2.2, h: 13, rake: 9 }, // rake in degrees aft
  // The mainmast stands ON the aft deckhouse, so its leg spread has to fit
  // inside that deckhouse's footprint — see `assertOnDeckhouse` below.
  mainmast: { z: -0.135, h: 30, spread: 6 }, // tripod: pole height, leg base spread
  aftSuper: { z: -0.135, w: 13, l: 26, h: 5 }, // deckhouse the aft AA station rides on
  funnelDeck: { z: -0.03, w: 20, l: 30, h: 2.5 }, // shelter deck round the funnel foot
};

// --- damage model (values the mechanics will read; nothing consumes them yet) -
// Hit points and armour in the same abstract units the shells will use.
// `critical` lists what a kill takes with it, so the consequences of losing a
// component are written down next to it rather than scattered through the game.
export const COMPONENT_STATS = {
  'hull.*': { hp: 400, armor: 8, floods: true },
  'hull.mid': { hp: 500, armor: 12, floods: true, critical: ['propulsion'] },
  'turret.*': { hp: 250, armor: 14, critical: ['magazine (if penetrated)'] },
  'casemate.*': { hp: 60, armor: 4 },
  'aa.*': { hp: 30, armor: 0 },
  // The two towers are tougher than they were, and for a reason: neither of
  // them comes off her any more, so their hit points are no longer "how long
  // until this falls over" but "how long until there is nothing left up there
  // worth calling a foremast". Most of the damage that gets them there arrives
  // as the cost of the fittings shot off them one at a time — see fittings.js
  // and the `hpCost` on each — and at the old numbers two shells finished the
  // job before there was any of that to watch.
  bridge: { hp: 320, armor: 10, critical: ['helm', 'fire control'] },
  funnel: { hp: 90, armor: 0, critical: ['speed -30%', 'smoke'] },
  mainmast: { hp: 150, armor: 0, critical: ['spotting range'] },
  steering: { hp: 120, armor: 3, critical: ['rudder jam'] },
  screws: { hp: 120, armor: 3, critical: ['propulsion'] },
};

// --- physics ----------------------------------------------------------------
// A ship of this size floats on the same solver as the launch; only the numbers
// change. Displacement follows from mass; probeArea is sized so six probes
// carrying `mass` sit at the design draft, and the rest is scaled off the
// launch's tuning by length ratio where the physics says it should be (drag and
// lateral area go as L^2, thrust as displacement^(2/3) for a given speed).
export const SHIP_CONFIG = {
  mass: 42000000, // kg — 42,000 t standard displacement
  probeArea: 1613, // m^2 of waterplane each of six probes stands for (sets the 8.5 m draft)
  maxDepth: 12.0,
  heaveDamp: 9000000,
  slopePush: 0.42, // she is long enough to span a swell, so less down-slope push

  thrust: 50000000, // N — high-power machinery gives a useful response from rest
  reverse: 0.12,
  dragFwd: 93000, // quadratic resistance; balances full power at ~45 kn

  lateralArea: 1400,
  lateralCd: 1.1,
  hullLift: 0.7,
  clrDepth: 5.0,

  rudderArea: 70,
  rudderLift: 2.6,
  rudderStall: 1.1,
  maxHelm: 32,
  helmRate: 2.4, // a battleship's rudder takes ~13 s hard over to hard over
  propWash: 0.28,

  bankIn: 0.6, // she is a displacement hull; she leans out of a turn
  rollDamp: 900000000,
  angDamp: 0.5,
};

// --- structure ---------------------------------------------------------------
//
// What each thing standing on her deck weighs, what holds it there, and — for
// anything tall and thin — the line along which it can be broken.
//
// This is the table `structure.js` works from, and it exists so that nothing
// about destruction is pre-cut. A funnel is not a funnel-that-can-fall-over in
// three preset pieces; it is thirteen metres of plate with a strength along its
// length, and where it breaks is wherever the strength ran out. Shoot the same
// funnel at the base and it goes over whole; shoot it two-thirds up and the top
// third comes off and the stump stays.
//
// `attach` is what it stands on. Losing that takes this with it, which is how a
// shelter deck blown open drops the AA tubs that were standing on it without
// anything having to say so.
//
// `foot` is the ring of plating that actually holds it down: a wound inside it
// eats the joint. `spine` is { base, dir, length, radius, sections } in the
// ship's own frame — `dir` need not be vertical (the funnel is raked).
//
// Masses are the real order of magnitude. They matter twice: for how long a
// thing takes to come down, and for how hard it hits what it lands on.
//
// The pagoda foremast and the mainmast used to be in here and are not any
// more. Neither of them leaves the ship: an armoured conning column carrying
// the ship's fire control does not go over the side in one piece, and a tripod
// mast does not either. What comes off those two is everything bolted to them,
// one fitting at a time — see fittings.js, and the lists at the end of
// buildBridge and buildMainmast.
export const STRUCTURE = {
  funnel: {
    mass: 130_000,
    attach: 'hull.mid',
    foot: { r: 3.6 },
    spine: { y0: 0, length: 13, radius: 3.4, sections: 10, strength: 1.0, rake: 9 },
  },
  // The AA mounts are small, they stand on deckhouses, and they are not built
  // of anything: they go over as a unit or not at all.
  'aa.*': { mass: 11_000, foot: { r: 2.0 }, spine: null },
  // A gunhouse is 1500 t of face-hardened plate on a roller path. Nothing
  // topples it. What happens to a turret is that the magazine under it lets go
  // and throws it off the barbette — see `magazine` in burst.js.
  'turret.*': { mass: 1_520_000, foot: { r: 5.2 }, spine: null, noTopple: true },
};

// --- what happens to a piece of her once it is in the water -------------------
//
// Seconds on the surface before it swamps. Zero means it goes straight down,
// which is what almost everything made of ship does.
//
// This is stated rather than derived, and it has to be. Whether a thing floats
// is a question about the air sealed inside it, and the only volume this
// project has for a piece of wreckage is its bounding box — which says a
// tripod mast is 97% air and a length of guardrail is 92% air, and is therefore
// a lie about both. So each number is here with the reason for it written next
// to it, and the reason is always the same question: what is inside it?
export const BUOYANCY = {
  // A funnel is a sealed uptake casing the size of a room, and nearly all of
  // what is inside it is air. It goes over on its side and swims off, and it is
  // the piece of a sunk battleship that photographs get taken of.
  funnel: 34,
  // Tripod legs are big closed tubes. They hold their air until the water finds
  // the holes that felled the mast.
  mainmast: 15,
  // A gun tub is a shallow open cylinder. Upside down it traps a bubble under
  // itself, and then it does not.
  'aa.*': 7,
  // The conning tower is a solid column of face-hardened plate with an armoured
  // tube down the middle of it. There is no air in that.
  bridge: 0,
  'turret.*': 0,
  // 25 mm steel bar. It is through the surface before the splash has closed.
  railings: 0,
};

// --- flooding ----------------------------------------------------------------
export const FLOODING = {
  // Discharge coefficient for a torn hole. 0.6 is the textbook value for a
  // sharp-edged orifice and there is no reason to invent a different one.
  cd: 0.6,
  // What the pumps can actually shift, m^3/s per compartment. A wartime
  // battleship's whole pumping outfit is a few hundred tons an hour, which is
  // 0.1 m^3/s or so — nothing at all against a hole that matters. That is not a
  // balance problem, it is the reason ships sink.
  pump: 0.14,
  // Where water goes when a compartment is full: over the bulkhead into the
  // next one, through doors and trunks of about this area.
  spillArea: 1.4, // m^2
  // Once the deck edge over a compartment is under, she starts down-flooding
  // through hatches, ventilators and every other opening in the weather deck.
  // This is the thing that actually finishes a ship, and it is why the last
  // part of a sinking accelerates.
  downfloodArea: 6.0, // m^2
  // Shellfire alone opens a ship very slowly — realistically so. A duel that
  // has to be settled by waterline hits wants this up around 4; torpedoes and
  // magazines are already decisive at 1.
  scale: 1.0,
};

// How much of a hole each kind of hit makes, in m^2, how big a crater it tears
// in the plating, and how far the burn round it reaches.
//
// `scorch` is the radius of the blast mark, and it is much the largest of the
// three because that is what a burst actually leaves: the hole is small, the
// torn patch round it is bigger, and the black is bigger again — a shell that
// takes two metres of plating out of a deckhouse blackens ten metres of it. It
// was previously sized as though it were the crater's own halo, which read as a
// smudge you had to be told about rather than as somewhere a shell went off.
export const WOUNDS = {
  // None of these opens her. A wound tears a cavity in her plating with a floor
  // to it — see PLATING in hull.js — and a bigger one is a wider cavity, not a
  // deeper one. `hole` is separate and is what the sea comes through.
  AP: { crater: 0.42, scorch: 4.4, punch: true, hole: 0.35 },
  HE: { crater: 2.6, scorch: 11.0, punch: false, hole: 3.4 },
  TORP: { crater: 6.5, scorch: 15.0, punch: false, hole: 26 },
  // Left where it was. This one is already a third of her length across, and it
  // is the one stamp big enough for its cost to be worth thinking about.
  MAGAZINE: { crater: 15, scorch: 34, punch: false, hole: 90 },
  IMPACT: { crater: 1.4, scorch: 5.0, punch: false, hole: 0.6 },
};
