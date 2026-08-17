import { BufferGeometry, BufferAttribute, Mesh } from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { SHIP } from './spec.js';
import { sideAt } from './hull.js';

// The pennant number on the bow.
//
// Two things make this read as a warship's number rather than as text stuck on
// a boat:
//
//  * The letterforms. Wartime USN hull numbers are not a typeface anyone has on
//    their machine — they are the Navy's own block numerals, laid out on a
//    grid: a heavy uniform stroke, flat terminals, an oval (not circular) bowl,
//    a 4 with a closed triangular counter and a 7 with a dead-straight
//    diagonal. They are drawn here from that grid, in a 0..1 box, so they are a
//    shape rather than a font dependency.
//
//  * They are painted *on the plating*, not floating beside it. The bow is
//    flared and raked, so a flat quad hung off the side either sinks into the
//    hull aft or lifts off it forward. Every vertex is instead projected onto
//    the hull skin at its own height and station and pushed out along the local
//    surface normal by a few centimetres, so the number wraps the flare the way
//    paint does.
//
// A soft drop shadow down and aft of each digit is the other half of the look:
// the real ones are painted with one, and without it a white numeral on grey
// plate has nothing to sit against.

// --- the numerals ------------------------------------------------------------
// Each digit is a list of parts in a box 0.62 wide and 1.0 tall — the Navy's
// proportion, narrower than it looks in a photograph — with a stroke of 0.19.
// A part is either a convex polygon (bars, the diagonals) or an elliptical
// annular sector (every bowl). Parts may overlap: they are opaque, so the union
// is free and nothing has to be booleaned.
const poly = (...points) => ({ points });
// `a0`/`a1` in degrees, 0 at 3 o'clock, counter-clockwise; sweeping a1 < a0
// goes the other way round. `t` is the stroke, taken off both radii.
const sector = (cx, cy, rx, ry, a0, a1, t) => ({ cx, cy, rx, ry, a0, a1, t });

const T = 0.19;
const DIGITS = {
  0: [sector(0.31, 0.50, 0.31, 0.50, 0, 360, T)],
  1: [
    poly([0.24, 0], [0.44, 0], [0.44, 1.00], [0.24, 1.00]),
    poly([0.24, 1.00], [0.05, 0.83], [0.24, 0.70]),
  ],
  2: [
    poly([0, 0], [0.62, 0], [0.62, 0.19], [0, 0.19]), // the base bar, full width
    poly([0.05, 0.19], [0.30, 0.19], [0.62, 0.72], [0.43, 0.78]), // the diagonal
    // the bowl runs a little past the diagonal at both ends so the strokes meet
    // in a join rather than in a notch
    sector(0.31, 0.72, 0.31, 0.28, -22, 205, T),
  ],
  3: [
    sector(0.31, 0.755, 0.31, 0.245, 170, -70, T),
    sector(0.31, 0.245, 0.31, 0.245, 70, -170, T),
  ],
  4: [
    poly([0.33, 0], [0.52, 0], [0.52, 1.00], [0.33, 1.00]), // stem
    poly([0, 0.28], [0.62, 0.28], [0.62, 0.47], [0, 0.47]), // cross bar
    poly([0.19, 1.00], [0.36, 1.00], [0.22, 0.28], [0.02, 0.28]), // the diagonal
  ],
  5: [
    poly([0.03, 0.81], [0.62, 0.81], [0.62, 1.00], [0.03, 1.00]),
    poly([0.03, 0.45], [0.22, 0.45], [0.22, 1.00], [0.03, 1.00]),
    sector(0.31, 0.30, 0.31, 0.30, 100, -160, T),
  ],
  6: [
    sector(0.31, 0.30, 0.31, 0.30, 0, 360, T),
    sector(0.31, 0.70, 0.31, 0.30, 180, 60, T),
  ],
  7: [
    poly([0, 0.81], [0.62, 0.81], [0.62, 1.00], [0, 1.00]),
    poly([0.42, 0.81], [0.62, 0.81], [0.33, 0], [0.13, 0]),
  ],
  8: [
    sector(0.31, 0.745, 0.29, 0.255, 0, 360, T),
    sector(0.31, 0.265, 0.31, 0.265, 0, 360, T),
  ],
  9: [
    sector(0.31, 0.70, 0.31, 0.30, 0, 360, T),
    sector(0.31, 0.30, 0.31, 0.30, 0, -120, T),
  ],
};
const GLYPH_W = 0.62;

// --- where she wears it ------------------------------------------------------
export const HULL_NUMBER_PLACEMENT = {
  s: 0.885, // station of the middle of the number
  height: 4.2, // cap height, m
  baseline: 2.7, // hull-local height of the foot of the digits, m
  gap: 0.55, // between digits, m
  proud: 0.07, // how far off the plating the paint stands, m
  shadow: [0.16, -0.16], // drop shadow, m: aft and down
};

// Flatten one part into convex polygons in the glyph's own 0..1 box.
function partPolygons(part) {
  if (part.points) return [part.points];
  const { cx, cy, rx, ry, a0, a1, t } = part;
  const sweep = a1 - a0;
  const n = Math.max(4, Math.ceil(Math.abs(sweep) / 9));
  const out = [];
  const at = (k, shrink) => {
    const a = (a0 + (sweep * k) / n) * Math.PI / 180;
    return [cx + Math.cos(a) * (rx - shrink), cy + Math.sin(a) * (ry - shrink)];
  };
  for (let k = 0; k < n; k++) {
    out.push([at(k, 0), at(k + 1, 0), at(k + 1, t), at(k, t)]);
  }
  return out;
}

// signed area, so every polygon can be wound the same way before it is fanned
const area2 = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a;
};

// The glyph outlines of a whole number, in metres, in a plane whose x runs aft
// to forward along the hull and whose y is hull-local height. Returns a flat
// list of convex polygons.
function numberPolygons(text, { height, gap }) {
  const advance = GLYPH_W * height + gap;
  const total = text.length * advance - gap;
  const polys = [];
  text.split('').forEach((ch, i) => {
    const parts = DIGITS[ch];
    if (!parts) return;
    const x0 = -total / 2 + i * advance;
    for (const part of parts) {
      for (const p of partPolygons(part)) {
        const m = p.map(([x, y]) => [x0 + x * height, y * height]);
        polys.push(area2(m) < 0 ? m.reverse() : m);
      }
    }
  });
  return polys;
}

// Project the flat glyph plane onto the hull skin. `side` is +1 or -1 on the
// ship's x; the glyphs are mirrored on the +x side so they read the right way
// round from outboard *and* so the triangles keep facing out of the hull.
function projectToHull(polys, { side, zMid, proud, offset }) {
  const pos = [];
  const idx = [];
  const skin = (a, h) => {
    const z = zMid + a;
    const s = Math.min(1, Math.max(0, z / SHIP.length + 0.5));
    return [side * sideAt(s, h), h, z];
  };
  // outward normal of the skin at (a, h), from the two surface tangents
  const e = 0.25;
  const normal = (a, h) => {
    const p = skin(a, h);
    const da = skin(a + e, h);
    const dh = skin(a, h + e);
    const ta = [da[0] - p[0], 0, e];
    const th = [dh[0] - p[0], e, 0];
    const n = [
      ta[1] * th[2] - ta[2] * th[1],
      ta[2] * th[0] - ta[0] * th[2],
      ta[0] * th[1] - ta[1] * th[0],
    ];
    // `ta x th` comes out pointing along -x, which is outboard on the port side
    // and into the plating on the starboard one
    const k = -side / (Math.hypot(n[0], n[1], n[2]) || 1);
    return [n[0] * k, n[1] * k, n[2] * k];
  };
  for (const p of polys) {
    const base = pos.length / 3;
    for (const [x, y] of p) {
      const a = (x + offset[0]) * (side > 0 ? -1 : 1);
      const h = y + offset[1];
      const q = skin(a, h);
      const n = normal(a, h);
      pos.push(q[0] + n[0] * proud, q[1] + n[1] * proud, q[2] + n[2] * proud);
    }
    for (let i = 1; i < p.length - 1; i++) idx.push(base, base + i, base + i + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Meshes for the number on both bows: a dark shadow laid on the plating and the
// white numerals standing a little further off it. They answer to the bow
// section's damage slot, because that is the plating they are painted on.
export function buildHullNumber(materials, text = '724', opts = {}) {
  const P = { ...HULL_NUMBER_PLACEMENT, ...opts };
  const slot = materials.slotOf('hull.bow');
  const zMid = (P.s - 0.5) * SHIP.length;
  const polys = numberPolygons(String(text), P);
  const meshes = [];
  for (const side of [-1, 1]) {
    for (const layer of [
      // Paint, not plate: the numbers are matt and barely metallic, which is
      // what keeps them legible when the topsides catch the sun.
      { offset: [P.shadow[0], P.baseline + P.shadow[1]], proud: P.proud * 0.5, color: [0.08, 0.09, 0.10], rough: 0.85, metal: 0.1 },
      { offset: [0, P.baseline], proud: P.proud, color: [0.95, 0.95, 0.93], rough: 0.7, metal: 0.05 },
    ]) {
      const g = projectToHull(polys, { side, zMid, proud: layer.proud, offset: layer.offset });
      const m = new Mesh(
        // `plate: 0` — this is paint lying on the plating, not plating: it must
        // not grow a set of seams and rivets of its own on top of the ones
        // already underneath it.
        paint(g, {
          color: layer.color, roughness: layer.rough, slot, metal: layer.metal, plate: 0,
        }),
        materials.body,
      );
      m.name = 'hullNumber';
      // It is paint, not a plate standing off the side: it must not cast.
      m.userData.noShadow = true;
      meshes.push(m);
    }
  }
  return meshes;
}
