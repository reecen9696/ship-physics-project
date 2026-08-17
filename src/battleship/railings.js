import {
  CylinderGeometry, Group, Mesh, Quaternion, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { SHIP, COMPARTMENTS } from './spec.js';
import { deckAt, halfBeamAt, STEEL_DARK } from './hull.js';

// Guardrails round the weather deck.
//
// Every deck edge a person can walk to on a real ship has a rail on it, and the
// rail is the smallest thing aboard that still has to be right: it is what the
// eye measures the ship against. Get the height wrong and a 180 m hull reads as
// a model of one. So the numbers here are the real ones — a 1.07 m top rail
// (42 in), two courses under it, stanchions at 1.85 m — and none of them is
// scaled up to be visible. What *is* scaled up is the metal: the bars are drawn
// a couple of centimetres thicker than 25 mm bar, because at the distance you
// actually see this ship from, the real thing is thinner than a pixel and
// shimmers rather than draws.
//
// The rail is not continuous, for the same reason a real one is not. It breaks
// at the gangways where the brow lands, at the boat-handling position, and on
// the forecastle where the cable runs. The breaks are plain gaps, closed at
// each end by a stanchion. The gangways used to carry gates as well — two
// leaves hinged on the standing rail, swinging inboard, open alongside and shut
// before she moved — and they are gone: a gate can only open inboard, there
// being nothing outboard of it to swing over, so an open one stood square
// across the deck like a fence facing in, which is not what anyone looking at
// the ship reads it as.
//
// --- how this is built -------------------------------------------------------
//
// One bay — a stanchion, and the span of rail from it to the next — is the unit
// of both construction and destruction. Two hundred bays as two hundred meshes
// would be two hundred draw calls for a handrail, so the standing bays of each
// watertight section are merged into a single mesh; a bay that is blown away is
// dropped from that merge and handed to the debris system as a loose body.
// Rebuilding a section costs one merge of ~40 small buffers, which is nothing at
// the rate shells arrive.
//
// Bays carry the damage slot of the hull section under them, so the rail chars
// with the plating it is bolted to without having to be a component of its own.

const L = SHIP.length;

export const RAIL = {
  height: 1.07, // top rail, m — 42 in, which is what a guardrail actually is
  courses: [0.36, 0.715], // the two courses under it
  spacing: 1.85, // stanchions, m
  inboard: 0.30, // how far in from the deck edge they are bolted
  postR: 0.045, // drawn heavier than the real 25 mm — see the note above
  postH: 1.13,
  wireR: 0.028,
};

// Where the rail breaks. Stations (0 stern .. 1 bow); both sides, because a ship
// works both sides. A gap is about 3.5 m — the width of a brow — except the
// forecastle break, which is wider because the cable party needs the room.
export const OPENINGS = [
  { id: 'brow.fwd', s: [0.514, 0.534], name: 'forward gangway' },
  { id: 'brow.aft', s: [0.382, 0.402], name: 'after gangway / boat handling' },
  { id: 'brow.qd', s: [0.189, 0.209], name: 'quarterdeck gangway' },
  { id: 'cable', s: [0.858, 0.888], name: 'cable party, at the hawse' },
];

// The rail stops short of the stem and of the transom edge and is closed across
// both by a transverse run: a breakwater rail forward, a taffrail aft.
const S_AFT = 0.006;
const S_FWD = 0.972;

const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();

const cptFor = (s) => COMPARTMENTS.find((k) => s >= k.s[0] && s < k.s[1])
  || COMPARTMENTS[COMPARTMENTS.length - 1];

// --- geometry helpers --------------------------------------------------------

// A point on the rail line: `side` is the sign of x (+1 port, -1 starboard).
function edge(s, side) {
  return new Vector3(side * (halfBeamAt(s) - RAIL.inboard), deckAt(s), (s - 0.5) * L);
}

function post(at, r = RAIL.postR) {
  const g = new CylinderGeometry(r * 0.85, r, RAIL.postH, 6);
  g.translate(at.x, at.y + RAIL.postH / 2, at.z);
  return g;
}

// A rail run from a to b, `h` above the deck. Open-ended: nobody ever sees the
// end of a 3 cm bar, and the caps would be a third of its triangles.
function wire(a, b, h) {
  _d.subVectors(b, a);
  const len = _d.length();
  const g = new CylinderGeometry(RAIL.wireR, RAIL.wireR, len, 5, 1, true);
  g.applyQuaternion(_q.setFromUnitVectors(UP, _d.divideScalar(len)));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + h, (a.z + b.z) / 2);
  return g;
}

// Walk the closed deck-edge loop and drop a stanchion every `spacing` metres of
// it, so the spacing stays even round the bow and across the stern rather than
// only down the straight sides.
function resample(dense, spacing) {
  const n = dense.length;
  const seg = new Float32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    seg[i] = dense[i].p.distanceTo(dense[(i + 1) % n].p);
    total += seg[i];
  }
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;
  const posts = [];
  let i = 0;
  let walked = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (i < n - 1 && walked + seg[i] < target) { walked += seg[i]; i++; }
    const t = seg[i] > 1e-6 ? Math.min((target - walked) / seg[i], 1) : 0;
    const a = dense[i];
    const b = dense[(i + 1) % n];
    posts.push({
      p: a.p.clone().lerp(b.p, t),
      s: a.s + (b.s - a.s) * t,
      side: t < 0.5 ? a.side : b.side,
    });
  }
  return posts;
}

export function buildRailings({ materials, onDetach = null }) {
  const object = new Group();
  object.name = 'railings';
  const M = materials.body;

  // --- the deck-edge loop, densely sampled -----------------------------------
  const dense = [];
  const add = (p, s, side) => dense.push({ p, s, side });
  const NS = 300;
  for (let i = 0; i <= NS; i++) {
    const s = S_AFT + (S_FWD - S_AFT) * (i / NS);
    add(edge(s, -1), s, -1);
  }
  // Across the bow. By this station the two sides have converged to a couple of
  // metres apart, so the rail closes across rather than running to a point.
  const bowHalf = halfBeamAt(S_FWD) - RAIL.inboard;
  const bowN = Math.max(2, Math.round((2 * bowHalf) / (RAIL.spacing * 0.5)));
  for (let i = 1; i < bowN; i++) {
    add(new Vector3(-bowHalf + 2 * bowHalf * (i / bowN), deckAt(S_FWD), (S_FWD - 0.5) * L), S_FWD, 0);
  }
  for (let i = 0; i <= NS; i++) {
    const s = S_FWD - (S_FWD - S_AFT) * (i / NS);
    add(edge(s, +1), s, +1);
  }
  // and the taffrail across the transom
  const sternHalf = halfBeamAt(S_AFT) - RAIL.inboard;
  const sternN = Math.max(2, Math.round((2 * sternHalf) / (RAIL.spacing * 0.6)));
  for (let i = 1; i < sternN; i++) {
    add(new Vector3(sternHalf - 2 * sternHalf * (i / sternN), deckAt(S_AFT), (S_AFT - 0.5) * L), S_AFT, 0);
  }

  const posts = resample(dense, RAIL.spacing);

  // --- bays ------------------------------------------------------------------
  const bays = [];
  for (let k = 0; k < posts.length; k++) {
    const a = posts[k];
    const b = posts[(k + 1) % posts.length];
    const side = a.side === b.side ? a.side : 0;
    const s = (a.s + b.s) / 2;
    // the transverse runs across the bow and the stern are never broken
    const opening = side === 0 ? null : OPENINGS.find((o) => s >= o.s[0] && s <= o.s[1]) || null;
    bays.push({ a, b, side, s, opening, cpt: cptFor(s).id, alive: !opening, capEnd: false });
  }
  // A bay that ends a run gets its far stanchion too, so an opening is bounded
  // by metal at both ends instead of trailing three bars into the air.
  for (let k = 0; k < bays.length; k++) {
    bays[k].capEnd = !!bays[(k + 1) % bays.length].opening;
  }

  for (const bay of bays) {
    if (bay.opening) continue;
    const parts = [post(bay.a.p)];
    for (const h of [RAIL.height, ...RAIL.courses]) parts.push(wire(bay.a.p, bay.b.p, h));
    if (bay.capEnd) parts.push(post(bay.b.p));
    const geo = merge(parts);
    for (const p of parts) p.dispose();
    paint(geo, { color: STEEL_DARK, roughness: 0.5, slot: materials.slotOf(bay.cpt) });
    geo.computeBoundingBox();
    bay.geo = geo;
    bay.center = geo.boundingBox.getCenter(new Vector3());
  }

  const standing = bays.filter((b) => b.geo);

  // --- one mesh per watertight section ---------------------------------------
  const sections = new Map();
  for (const cpt of COMPARTMENTS) {
    const own = standing.filter((b) => b.cpt === cpt.id);
    if (!own.length) continue;
    const mesh = new Mesh(merge(own.map((b) => b.geo)), M);
    mesh.name = `railings.${cpt.id}`;
    object.add(mesh);
    sections.set(cpt.id, { mesh, bays: own });
  }

  function rebuild(id) {
    const sec = sections.get(id);
    if (!sec) return;
    const alive = sec.bays.filter((b) => b.alive);
    if (!alive.length) { sec.mesh.visible = false; return; }
    const old = sec.mesh.geometry;
    sec.mesh.geometry = merge(alive.map((b) => b.geo));
    sec.mesh.visible = true;
    old.dispose(); // the bays' own buffers are the sources; only the merge dies
  }

  // --- destruction -----------------------------------------------------------
  // A detached piece is handed out centred on its own origin, with where it was
  // and how it was turned in the ship's frame; the ship converts that to world
  // and hands it to the debris integrator.
  const touched = new Set();

  function throwOff(geometry, position, quaternion, from, speed) {
    if (!onDetach) return;
    _v.subVectors(position, from);
    if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
    _v.normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.7));
    _v.y = Math.abs(_v.y) + speed * 0.35 + 1.5; // it goes up before it goes over
    onDetach({
      geometry,
      position,
      quaternion,
      impulse: _v.clone(),
      spin: new Vector3(
        (Math.random() - 0.5) * 9,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 9,
      ),
    });
  }

  function detachBay(bay, from, speed) {
    bay.alive = false;
    touched.add(bay.cpt);
    if (!bay.loose) {
      bay.loose = bay.geo.clone().translate(-bay.center.x, -bay.center.y, -bay.center.z);
    }
    throwOff(bay.loose, bay.center.clone(), new Quaternion(), from, speed);
  }

  // Knock the rail out around a point in the ship's frame — what a shell landing
  // near the deck edge does to it. Deliberately generous: guardrail is 25 mm bar
  // and a near miss takes a long stretch of it away.
  function blast(point, radius = 10, { speed = 9 } = {}) {
    let n = 0;
    touched.clear();
    for (const bay of standing) {
      if (!bay.alive || bay.center.distanceTo(point) > radius) continue;
      detachBay(bay, point, speed);
      n++;
    }
    for (const id of touched) rebuild(id);
    return n;
  }

  // Station-and-side form, for the mechanics and the GUI. `zFrac` is the same
  // fore-and-aft fraction the rest of the ship is laid out in, 0 amidships.
  function blastAt(zFrac, side, radius = 10, opts) {
    const s = zFrac + 0.5;
    return blast(edge(s, side).setY(deckAt(s) + RAIL.height * 0.5), radius, opts);
  }

  // A wrecked hull section takes its rail with it — all of it, thrown outboard
  // from the centreline.
  function wreck(id) {
    const sec = sections.get(id);
    if (!sec) return 0;
    let n = 0;
    touched.clear();
    const from = new Vector3();
    for (const bay of sec.bays) {
      if (!bay.alive) continue;
      from.set(0, bay.center.y - 3, bay.center.z);
      detachBay(bay, from, 6);
      n++;
    }
    for (const cid of touched) rebuild(cid);
    return n;
  }

  function restore() {
    let missing = 0;
    for (const bay of standing) if (!bay.alive) { bay.alive = true; missing++; }
    if (!missing) return 0;
    for (const id of sections.keys()) rebuild(id);
    return missing;
  }

  return {
    id: 'railings',
    object,
    openings: OPENINGS,
    blast,
    blastAt,
    wreck,
    restore,
    get bays() { return standing.length; },
    get intact() { return standing.filter((b) => b.alive).length; },
  };
}
