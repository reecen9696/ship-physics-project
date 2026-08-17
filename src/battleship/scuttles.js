import {
  CylinderGeometry, Mesh, Quaternion, TorusGeometry, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { SHIP, COMPARTMENTS } from './spec.js';
import { sideAt } from './hull.js';

// Scuttles: the round windows, down the hull side and down the deckhouse sides.
//
// One definition for both, because they are the same fitting. Three concentric
// parts is what makes a scuttle read as a fitting rather than as a spot on the
// paint: a brass rim standing proud of the plating, and the glass set back
// inside it, so the rim's own thickness is what reads as the depth of the
// recess.
//
// The hull's used to be drawn in the fragment shader instead, on the grounds
// that a disc has to be *fitted* to a curved hull and there are two dozen of
// them. Both objections turn out to be cheap to answer — the hull's section
// curve gives the point and the outward normal at any station (`sideAt`), and
// merging a whole run into one buffer costs one draw call per hull section —
// and neither was worth the cost of the answer, which was that a painted circle
// never stands off the plating. Alongside the modelled ones on the deckhouse
// two metres above it, it read as a different fitting altogether.

export const SCUTTLE = {
  r: 0.30, // outer radius of the rim, m
  rim: 0.06, // tube radius of the rim — also how far it stands off the plating
  proud: 0.06, // rim centreline, out along the normal from the plating
  pane: 0.04, // glass face, out along the normal: well back inside the rim
  brass: [0.46, 0.38, 0.20],
  glass: [0.045, 0.055, 0.065],
};

const L = SHIP.length;
const UP = new Vector3(0, 1, 0);
const AXIS = new Vector3(0, 0, 1); // what a TorusGeometry is built around
const _q = new Quaternion();

// The two geometries for one scuttle: `p` is the point on the plating, `n` the
// outward normal there (unit). Unpainted — the caller bakes the colours in,
// which is what lets a section's whole run merge into a single mesh.
export function scuttleGeometry(p, n) {
  const rim = new TorusGeometry(SCUTTLE.r, SCUTTLE.rim, 6, 16);
  rim.applyQuaternion(_q.setFromUnitVectors(AXIS, n));
  rim.translate(p.x + n.x * SCUTTLE.proud, p.y + n.y * SCUTTLE.proud, p.z + n.z * SCUTTLE.proud);
  const ri = SCUTTLE.r - SCUTTLE.rim;
  const glass = new CylinderGeometry(ri, ri, 0.04, 16);
  glass.applyQuaternion(_q.setFromUnitVectors(UP, n));
  glass.translate(p.x + n.x * SCUTTLE.pane, p.y + n.y * SCUTTLE.pane, p.z + n.z * SCUTTLE.pane);
  return { rim, glass };
}

// How brightly the room behind this scuttle is burning, 0 (dark) to 1.
//
// A row of scuttles all at the same brightness reads as a strip light behind a
// perforated plate, which is what a uniform value looks like once it is the
// brightest thing on a dark ship. What sells it is that a ship is a lot of
// separate cabins and about a third of them are dark at any hour — so this is
// hashed off the scuttle's own position, which means it is stable, it differs
// between neighbours, and it costs nothing at run time.
//
// Deliberately not random: the same scuttle has to come out the same brightness
// on every load, or the ship flickers between sessions.
function lampAt(p) {
  const h = Math.sin(p.x * 12.9898 + p.y * 78.233 + p.z * 37.719) * 43758.5453;
  const f = h - Math.floor(h);
  if (f < 0.34) return 0; // that one is turned in
  return 0.45 + 0.55 * ((f - 0.34) / 0.66);
}

// Paint one scuttle's pair the way every scuttle on the ship is painted, and
// push it onto `into`. `slot` is the damage slot of whatever it is cut into, so
// a scuttle chars with the plating around it rather than being a component.
//
// `lit` is for the ones on the deckhouses, which are cabins and offices above
// the weather deck and show a light at night. The runs down the hull side are
// never lit: those are the messdecks a deck below, and a ship at sea does not
// show a light out of her side — which is also what keeps the two runs reading
// as the same fitting in daylight and different things after dark.
export function pushScuttle(into, p, n, slot, { lit = false } = {}) {
  const { rim, glass } = scuttleGeometry(p, n);
  into.push(
    paint(rim, { color: SCUTTLE.brass, roughness: 0.35, slot }),
    paint(glass, {
      color: SCUTTLE.glass, roughness: 0.12, slot, metal: 0.15,
      lamp: lit ? lampAt(p) : 0,
    }),
  );
}

// --- the runs down the hull --------------------------------------------------
// Real ships do not space scuttles evenly down the whole length: they cluster
// where the accommodation is, in tight runs with blank plating between.
// Hull-local metres; `z0` is the aftmost of each run.
export const HULL_SCUTTLES = {
  y: 3.5, // hull-local height — 2.5 m under the deck edge amidships
  spacing: 2.35,
  runs: [
    { z0: 34.0, count: 10 }, // forward accommodation
    { z0: -50.0, count: 14 }, // aft accommodation
  ],
};

// A point on the plating at station `s` and hull-local height `y`, with the
// outward normal there.
//
// The normal is taken numerically off the section curve in both directions
// rather than assumed to be athwartships. At scuttle height the plating is
// near vertical amidships, but it takes on real flare forward — the forward run
// ends where the bow is already coming in hard — and a rim set square to the x
// axis there stands off the hull on one edge and buries itself on the other.
function onPlating(s, y, side) {
  const dy = 0.25;
  const dz = 1.5;
  const fy = (sideAt(s, y + dy) - sideAt(s, y - dy)) / (2 * dy);
  const fz = (sideAt(s + dz / L, y) - sideAt(s - dz / L, y)) / (2 * dz);
  return {
    p: new Vector3(side * sideAt(s, y), y, (s - 0.5) * L),
    // x flips with the side; the fore-and-aft and vertical tilt do not
    n: new Vector3(side, -fy, -fz).normalize(),
  };
}

const cptFor = (s) => COMPARTMENTS.find((k) => s >= k.s[0] && s < k.s[1]);

// One merged mesh per hull section, keyed by section id, for the caller to hang
// under that section's group — so the scuttles go wherever the plating goes.
export function buildHullScuttles({ materials }) {
  const geoms = new Map(COMPARTMENTS.map((c) => [c.id, []]));
  const S = HULL_SCUTTLES;
  for (const run of S.runs) {
    for (let k = 0; k < run.count; k++) {
      const s = (run.z0 + k * S.spacing) / L + 0.5;
      const cpt = cptFor(s);
      if (!cpt) continue;
      for (const side of [-1, 1]) {
        const { p, n } = onPlating(s, S.y, side);
        pushScuttle(geoms.get(cpt.id), p, n, materials.slotOf(cpt.id));
      }
    }
  }
  const meshes = new Map();
  for (const [id, parts] of geoms) {
    if (!parts.length) continue;
    const mesh = new Mesh(merge(parts), materials.body);
    mesh.name = `${id}.scuttles`;
    mesh.castShadow = true;
    meshes.set(id, mesh);
  }
  return meshes;
}
