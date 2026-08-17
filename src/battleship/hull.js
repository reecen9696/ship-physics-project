import { BufferGeometry, BufferAttribute, Color } from 'three/webgpu';
import {
  float, sin, pow, mix, max, min, saturate, smoothstep,
} from 'three/tsl';
import { SHIP, COMPARTMENTS } from './spec.js';

// The hull is a loft of sections, each section a curve
//   x = b(s) sin(th),  y = deck(s) - (deck(s) + keel(s)) cos(th)^p(s)
// swept from the port sheer (th = -pi/2) through the keel to the starboard
// sheer. `p` sets the section shape: small p is a full, boxy midbody with a
// hard bilge; p > 1 is a V, which is what the fine bow entry wants.
//
// Every curve here exists twice, once in JS for the mesh and the physics and
// once in TSL for the ocean's hull-foam shader, which needs the same waterline
// on the GPU. Keep them in step: the pairs are written line-for-line.

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// plan view: full midbody, rounded cruiser stern, long fine bow
export const halfBeamAt = (s) => SHIP.halfBeam
  * (1 - 0.70 * clamp01((0.28 - s) / 0.28) ** 2)
  // A long, fine entry: the beam starts coming off well aft of the stem and the
  // last tenth is nearly a knife edge. A bow that only narrows in the final
  // fifth reads as a slab with a point stuck on it.
  * (1 - 0.985 * clamp01((s - 0.52) / 0.48) ** 1.35);

// profile: deepest amidships, lifting to the stern (screws and rudder tuck
// under) and to the forefoot
export const keelAt = (s) => SHIP.keel
  * (0.55 + 0.45 * Math.sin(Math.PI * s) ** 0.6)
  * (1 - 0.6 * clamp01((0.15 - s) / 0.15) ** 2)
  * (1 - 0.5 * clamp01((s - 0.80) / 0.20) ** 2);

// sheer: flush deck, rising 3 m to the stem and a touch at the stern
export const deckAt = (s) => SHIP.deck
  // Sheer: the deck line sweeps up toward the stem — 5 m of rise over the
  // forward third — which is what keeps a bow dry and what makes a ship's
  // profile a curve rather than a plank.
  + 5.0 * clamp01((s - 0.55) / 0.45) ** 1.8
  + 0.9 * clamp01((0.32 - s) / 0.32) ** 2;

// section fullness: boxy amidships, V at the bow, moderate at the stern
export const sectionPowAt = (s) => 0.5
  + 1.1 * clamp01((s - 0.60) / 0.40) ** 1.2
  + 0.5 * clamp01((0.25 - s) / 0.25);

// TSL twins of the four curves above, for the ocean shader
export const hullTSL = {
  halfBeam: (s) => float(SHIP.halfBeam)
    .mul(float(1).sub(pow(saturate(float(0.28).sub(s).div(0.28)), 2).mul(0.70)))
    .mul(float(1).sub(pow(saturate(s.sub(0.52).div(0.48)), 1.35).mul(0.985))),
  keel: (s) => float(SHIP.keel)
    .mul(float(0.55).add(pow(sin(s.mul(Math.PI)).max(0), 0.6).mul(0.45)))
    .mul(float(1).sub(pow(saturate(float(0.15).sub(s).div(0.15)), 2).mul(0.6)))
    .mul(float(1).sub(pow(saturate(s.sub(0.80).div(0.20)), 2).mul(0.5))),
  deck: (s) => float(SHIP.deck)
    .add(pow(saturate(s.sub(0.55).div(0.45)), 1.8).mul(5.0))
    .add(pow(saturate(float(0.32).sub(s).div(0.32)), 2).mul(0.9)),
  pow: (s) => float(0.5)
    .add(pow(saturate(s.sub(0.60).div(0.40)), 1.2).mul(1.1))
    .add(saturate(float(0.25).sub(s).div(0.25)).mul(0.5)),
};

// a point on the hull skin: station s (0 stern .. 1 bow), u across (0 port sheer
// .. 0.5 keel .. 1 starboard sheer)
export function section(s, u) {
  const th = (u - 0.5) * Math.PI;
  const b = halfBeamAt(s);
  const d = keelAt(s);
  const y = deckAt(s);
  return [b * Math.sin(th), y - (y + d) * Math.pow(Math.cos(th), sectionPowAt(s)), (s - 0.5) * SHIP.length];
}

// Half-width of the hull skin at station `s` and hull-local height `y`.
//
// `halfBeamAt` is the beam at the *sheer* — the widest the section ever gets.
// Anything mounted on the side has to be placed against the skin at its own
// height, which on a flared or tumblehome section is a different number, and
// using the plan beam instead buries the fitting inside the plating where
// nothing can see it. Inverts the same section curve the hull is lofted from.
export function sideAt(s, y) {
  const b = halfBeamAt(s);
  const d = keelAt(s);
  const top = deckAt(s);
  const ratio = clamp01((top - y) / Math.max(top + d, 0.01));
  const u = Math.sqrt(Math.max(0, 1 - ratio ** (2 / sectionPowAt(s))));
  return b * u;
}

// what the physics and the ocean shader need to know about the hull
export const hullDescriptor = {
  length: SHIP.length,
  halfBeam: SHIP.halfBeam,
  keel: SHIP.keel,
  deck: SHIP.deck,
  depth: SHIP.depth,
  halfBeamAt,
  keelAt,
  deckAt,
  sectionPowAt,
  tsl: hullTSL,
};

// --- paint -------------------------------------------------------------------
// Three flat bands with hard edges between them: red below the waterline, a
// dark boot stripe at it, grey topsides above. The band heights are hull-local
// y, and the shader draws them per fragment — see `waterlinePaint` in
// boatMaterial.js for why they cannot be baked into vertex colours.
export const PAINT = {
  antifoul: [0.72, 0.10, 0.07], // solid red
  boot: [0.09, 0.10, 0.11],
  topside: [0.44, 0.47, 0.49], // Kure grey
  bootLow: -0.35, // m: below this is antifoul
  bootHigh: 0.75, // m: above this is topside
  // The scuttles down each side used to be painted in here too. They are
  // modelled now — see scuttles.js — because a painted circle cannot stand
  // proud of the plating, and every other scuttle on the ship does.
};
const ANTIFOUL = new Color(0xb4241c);
const BOOT = new Color(0x1a1d20);
const TOPSIDE = new Color(0x6f767b);
// Laid teak, hard worked: warm underneath but greyed off by sun, salt and
// however many years of feet. Fresh timber brown on a warship reads as a yacht,
// and even a clean-scrubbed deck at sea is a good deal darker than the colour
// the timber comes in.
export const DECK_COLOR = [0.185, 0.155, 0.117];
export const STEEL = [0.44, 0.47, 0.50];
export const STEEL_DARK = [0.34, 0.37, 0.40];
export const CANVAS = [0.62, 0.60, 0.55];

function hullColor(y, out) {
  if (y < -0.35) out.copy(ANTIFOUL);
  else if (y < 0.9) out.copy(BOOT);
  else out.copy(TOPSIDE);
  return out;
}

// --- geometry ----------------------------------------------------------------
// One loft, many meshes. Positions/colours/normals are computed once for the
// whole hull and shared; each compartment gets its own index buffer over the
// station range it owns, so the seams between sections are exact (same
// vertices) and each section can still be drawn, coloured and damaged apart.
export const HULL_STATIONS = 90;
const NR = 23;

export function buildHullSections() {
  const NS = HULL_STATIONS;
  const pos = [];
  const col = [];
  const c = new Color();
  const push = (p) => {
    pos.push(p[0], p[1], p[2]);
    hullColor(p[1], c);
    col.push(c.r, c.g, c.b);
  };
  for (let i = 0; i < NS; i++) {
    const s = i / (NS - 1);
    for (let j = 0; j < NR; j++) push(section(s, j / (NR - 1)));
  }
  // caps: fan the end sections about their own centre (stern is rounded, the
  // stem is a knife edge — either way the fan closes it)
  const capIndex = {};
  for (const [name, i] of [['stern', 0], ['bow', NS - 1]]) {
    let cx = 0; let cy = 0; let cz = 0;
    for (let j = 0; j < NR; j++) {
      cx += pos[(i * NR + j) * 3]; cy += pos[(i * NR + j) * 3 + 1]; cz += pos[(i * NR + j) * 3 + 2];
    }
    capIndex[name] = pos.length / 3;
    push([cx / NR, cy / NR, cz / NR]);
  }

  const position = new BufferAttribute(new Float32Array(pos), 3);
  const color = new BufferAttribute(new Float32Array(col), 3);

  const sections = COMPARTMENTS.map((cpt) => {
    const i0 = Math.round(cpt.s[0] * (NS - 1));
    const i1 = Math.round(cpt.s[1] * (NS - 1));
    const idx = [];
    for (let i = i0; i < i1; i++) {
      for (let j = 0; j < NR - 1; j++) {
        const a = i * NR + j;
        const b = a + NR;
        idx.push(a, a + 1, b, a + 1, b + 1, b); // wound to face outward
      }
    }
    if (i0 === 0) { // stern cap, facing aft
      for (let j = 0; j < NR; j++) idx.push(capIndex.stern, ((j + 1) % NR), j);
    }
    if (i1 === NS - 1) { // stem cap, facing forward
      const base = (NS - 1) * NR;
      for (let j = 0; j < NR; j++) idx.push(capIndex.bow, base + j, base + ((j + 1) % NR));
    }
    const g = new BufferGeometry();
    g.setAttribute('position', position);
    g.setAttribute('color', color);
    g.setIndex(idx);
    return { id: cpt.id, geometry: g, s: cpt.s };
  });
  // normals over the whole loft, once, then shared
  const all = new BufferGeometry();
  all.setAttribute('position', position);
  const allIdx = [];
  sections.forEach((sc) => allIdx.push(...sc.geometry.index.array));
  all.setIndex(allIdx);
  all.computeVertexNormals();
  sections.forEach((sc) => sc.geometry.setAttribute('normal', all.getAttribute('normal')));
  return sections;
}

// The main deck: a flat ribbon between the two sheer lines, split the same way
// as the hull so a section keeps its own piece of deck.
export function buildDeckSections() {
  const NS = HULL_STATIONS;
  const pos = [];
  for (let i = 0; i < NS; i++) {
    const s = i / (NS - 1);
    const p = section(s, 0);
    const q = section(s, 1);
    pos.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  }
  const position = new BufferAttribute(new Float32Array(pos), 3);
  return COMPARTMENTS.map((cpt) => {
    const i0 = Math.round(cpt.s[0] * (NS - 1));
    const i1 = Math.round(cpt.s[1] * (NS - 1));
    const idx = [];
    for (let i = i0; i < i1; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); // normals up
    }
    const g = new BufferGeometry();
    g.setAttribute('position', position);
    g.setIndex(idx);
    g.computeVertexNormals();
    return { id: cpt.id, geometry: g };
  });
}

// deck height at a station, for placing things on it
// How deep a chip in her goes.
//
// A shell hole in a battleship should read the way a chip in a brick reads: a
// cavity with a floor a hand's breadth in, not a window. What was here before
// was a ship modelled as a shell with three decks in her, and a hole anywhere
// in the weather deck looked down through all of them — you could see the levels
// receding into the dark and the whole thing read as a gaping hole into a
// building rather than as damage to a piece of armour.
//
// So there is one surface behind her plating, this far in, and it is what you
// see at the bottom of any wound a shell can make. It is deliberately shallow —
// a chip, not a pit. Deep enough to read as thickness when you are standing on
// the deck beside it, shallow enough that you are looking at a floor rather
// than down a shaft. Only something that reaches
// further than this — a torpedo, a magazine — opens her properly, which is the
// one time you *should* be looking into her.
//
// interior.js draws the backing and colliders.js makes it solid, so this is
// stated once, here, where deckAt and keelAt already are.
export const PLATING = 0.7;

// The decks inside her that are not the backing: just the one, deep down, which
// is only ever seen through a torpedo hole.
export const INNER_DECKS = [
  (s) => -keelAt(s) + 1.6, // inner bottom, riding over the keel
];

export const deckY = (zFrac) => deckAt(zFrac + 0.5);
export const zOf = (zFrac) => zFrac * SHIP.length;


// --- superfiring clearance ---------------------------------------------------
// A superfiring turret must be able to fire, and to depress, over the roof of
// the turret in front of it. Getting this wrong is not subtle — the barrels
// pass through the lower gunhouse — and it is easy to get wrong because the
// deck is not level: the sheer lifts the lower turret's station relative to the
// upper one, so the barbette height that works aft is too short forward.
//
// Rather than leave the numbers in spec.js as magic, this recomputes the
// geometry from the same curves the hull is lofted from and reports the worst
// clearance. Called once at build time; it throws if a turret would clip.
export function checkSuperfiringClearance(turrets, spec) {
  const trunnion = (t) => deckAt(t.z + 0.5) + t.deckRise + spec.gunhouseH * 0.42;
  const roofOf = (t) => deckAt(t.z + 0.5) + t.deckRise + spec.gunhouseH;
  const results = [];
  for (const t of turrets) {
    if (!t.superfires) continue;
    const lower = turrets.find((k) => k.id === t.superfires);
    const reach = Math.abs(t.z - lower.z) * SHIP.length; // how far out the lower roof is
    // worst case is full depression: the barrel is lowest there
    const drop = reach * Math.sin(-spec.elevMin * Math.PI / 180);
    const clearance = trunnion(t) - drop - spec.barrelR - roofOf(lower);
    results.push({ turret: t.id, over: lower.id, clearance });
    if (clearance < 0.3) {
      throw new Error(
        `${t.id} clears ${lower.id} by only ${clearance.toFixed(2)} m at full depression `
        + `— raise its deckRise by at least ${(0.3 - clearance).toFixed(2)} m`,
      );
    }
  }
  return results;
}
