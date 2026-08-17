import {
  Group, Mesh, BoxGeometry, CylinderGeometry, LatheGeometry, SphereGeometry,
  Vector2, Vector3, Quaternion, Matrix4,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { STEEL_DARK } from './hull.js';

// The rig: everything above the fire-control tops.
//
// A warship's masthead is the one part of her that is not plate. It is a
// lattice you can see the sky through, a yard combed with whip aerials, and one
// or two radar arrays turning on top of it — thin members and daylight, all the
// way up. Built as solid poles and boxes instead (a cylinder for the mast, one
// bar for the yard) the silhouette is roughly right and it still reads wrong,
// because the thing that says "aerial" is the openness, not the outline.
//
// So every member here is thin, and there are a great many of them: a lattice
// only reads as a lattice once it has the X-bracing on each face of each bay,
// and a yard only reads as an aerial yard once the whips are standing off it in
// a row. That is a hundred-odd cylinders per mast, which is affordable only
// because they are all painted into one buffer and drawn once — the same trick
// the scuttles use, for the same reason.

const UP = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);
const _d = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
const _mid = new Vector3();

// The rig is her own steel, but the aerial elements on it are darker: they are
// thin rod seen against the sky, and they never take the same light a plated
// surface does.
export const RIG = STEEL_DARK;
export const AERIAL = [0.15, 0.16, 0.17];

// A cylinder from a to b, with the placement baked into the geometry so it can
// be merged with its neighbours rather than carried by a mesh transform.
export function tubeGeometry(a, b, r, segs = 6) {
  _d.subVectors(b, a);
  const len = _d.length() || 1e-4;
  const g = new CylinderGeometry(r, r, len, segs, 1);
  _q.setFromUnitVectors(UP, _d.divideScalar(len));
  _mid.addVectors(a, b).multiplyScalar(0.5);
  g.applyMatrix4(_m.compose(_mid, _q, ONE));
  return g;
}

// The mesh form of the same member, for one-off struts that are not part of a
// merged rig (mast legs, derrick booms, propeller shafts).
export function strut(a, b, r, make, segs = 8) {
  return make(tubeGeometry(a, b, r, segs));
}

// A rig collects painted geometry and hands back a single mesh for the lot.
// Colour, roughness and damage slot are already baked per-vertex by `paint`, so
// a black dipole and a grey lattice leg live happily in the same buffer.
export function createRig(slot) {
  const geoms = [];
  const put = (geometry, color = RIG, roughness = 0.42, metal = 0.8) => {
    geoms.push(paint(geometry, { color, roughness, slot, metal }));
    return geometry;
  };
  return {
    put,
    tube: (a, b, r, color, roughness, segs) => put(tubeGeometry(a, b, r, segs), color, roughness),
    box: (w, h, l, at, color, roughness) => {
      const g = new BoxGeometry(w, h, l);
      g.translate(at.x, at.y, at.z);
      return put(g, color, roughness);
    },
    mesh: (material) => new Mesh(merge(geoms), material),
  };
}

// --- lattice tower -----------------------------------------------------------
// Four legs on a square, tapering as they rise, girts round every bay and an X
// across every face of every bay. The X-bracing is the whole point: without it
// this is four poles and a ladder, and it reads as scaffolding.
export function latticeMast(rig, {
  x = 0, z = 0, y0, height, base, top, bays = 5, leg = 0.14, brace = 0.055, color = RIG,
}) {
  // corner k, a fraction f of the way up
  const at = (k, f) => {
    const r = base + (top - base) * f;
    const a = k * Math.PI / 2 + Math.PI / 4;
    return new Vector3(x + Math.cos(a) * r, y0 + height * f, z + Math.sin(a) * r);
  };
  for (let k = 0; k < 4; k++) rig.tube(at(k, 0), at(k, 1), leg, color, 0.42, 6);
  for (let b = 0; b <= bays; b++) {
    const f = b / bays;
    for (let k = 0; k < 4; k++) rig.tube(at(k, f), at((k + 1) % 4, f), brace, color, 0.42, 5);
  }
  for (let b = 0; b < bays; b++) {
    const f0 = b / bays;
    const f1 = (b + 1) / bays;
    for (let k = 0; k < 4; k++) {
      rig.tube(at(k, f0), at((k + 1) % 4, f1), brace, color, 0.42, 4);
      rig.tube(at((k + 1) % 4, f0), at(k, f1), brace, color, 0.42, 4);
    }
  }
  return new Vector3(x, y0 + height, z);
}

// --- yardarm -----------------------------------------------------------------
// A spar across the mast carrying signal halyards and a row of whip aerials.
// The whips are what make it a yard on a warship rather than a crossbar: a long
// comb of thin rods standing off it, longest inboard and shortening towards the
// tips, with the blinker lights on the ends.
export function yardarm(rig, {
  x = 0, y, z, span, r = 0.1, whips = 8, whipH = 2.0, inboard = 0.16,
  color = RIG, aerial = AERIAL,
}) {
  const port = new Vector3(x - span, y, z);
  const stbd = new Vector3(x + span, y, z);
  rig.tube(port, stbd, r, color, 0.42, 6);
  for (const side of [-1, 1]) {
    for (let k = 0; k < whips; k++) {
      const f = inboard + (0.94 - inboard) * (k / (whips - 1));
      const h = whipH * (1.15 - 0.5 * f);
      const g = new CylinderGeometry(0.012, 0.045, h, 4);
      g.translate(x + side * span * f, y + h / 2 + r * 0.6, z);
      rig.put(g, aerial, 0.55);
    }
    // yardarm blinker on the tip, and a short strut under the yard back to the
    // mast so it is held up rather than balanced on it
    rig.box(0.26, 0.42, 0.26, new Vector3(x + side * span, y + 0.5, z), aerial, 0.5);
    rig.tube(
      new Vector3(x + side * span * 0.92, y, z),
      new Vector3(x, y - span * 0.28, z),
      0.05, color, 0.42, 4,
    );
  }
  return { port, stbd };
}

// --- topmast -----------------------------------------------------------------
// The slim pole above everything, carrying a stack of crossed dipoles and the
// masthead light. Alternating the pairs through 90 degrees is what gives the
// stack its bristled look from any bearing.
export function topmast(rig, {
  at, height, r0 = 0.17, r1 = 0.06, stacks = 5, arm = 0.6, color = RIG, aerial = AERIAL,
}) {
  const pole = new CylinderGeometry(r1, r0, height, 8);
  pole.translate(at.x, at.y + height / 2, at.z);
  rig.put(pole, color, 0.42);
  for (let k = 0; k < stacks; k++) {
    const y = at.y + height * (0.26 + 0.62 * (k / (stacks - 1)));
    const a = (k % 2) * Math.PI / 2;
    const d = new Vector3(Math.cos(a) * arm, 0, Math.sin(a) * arm);
    rig.tube(
      new Vector3(at.x - d.x, y, at.z - d.z),
      new Vector3(at.x + d.x, y, at.z + d.z),
      0.032, aerial, 0.55, 4,
    );
    // the elements turn up at their ends — a plain rod reads as a splinter
    for (const s of [-1, 1]) {
      rig.tube(
        new Vector3(at.x + s * d.x, y, at.z + s * d.z),
        new Vector3(at.x + s * d.x, y + 0.3, at.z + s * d.z),
        0.028, aerial, 0.55, 4,
      );
    }
  }
  const head = new Vector3(at.x, at.y + height, at.z);
  const lamp = new SphereGeometry(0.13, 8, 6);
  lamp.translate(head.x, head.y + 0.16, head.z);
  rig.put(lamp, [0.55, 0.5, 0.45], 0.3);
  return head;
}

// --- aerial wires ------------------------------------------------------------
// Rod, not rope, but at this scale the difference is that a wire has to be thin
// enough to nearly disappear. Two of these off the yard tips are what stop the
// whole rig looking like it was assembled rather than rigged.
export function aerialWire(rig, a, b, r = 0.022) {
  rig.tube(a, b, r, AERIAL, 0.6, 3);
}

// --- air-search array --------------------------------------------------------
// The "bedspring": a flat rectangular frame, a row of horizontal dipoles across
// the front of it, and a mesh reflector behind. Wide, thin, and open — from a
// mile off it is a dark rectangle with light through it, which is exactly what
// a plain box would not be. Returns a pivot that turns.
export function airSearchArray({ slot, material, width = 7.4, height = 2.9, rows = 8, mesh = 15 }) {
  const rig = createRig(slot);
  const w = width / 2;
  const h = height / 2;
  const P = (px, py, pz) => new Vector3(px, py, pz);

  // frame
  for (const s of [-1, 1]) rig.tube(P(s * w, -h, 0), P(s * w, h, 0), 0.085, RIG, 0.45, 5);
  for (const s of [-1, 1]) rig.tube(P(-w, s * h, 0), P(w, s * h, 0), 0.075, RIG, 0.45, 5);

  // reflector: verticals close-spaced, with three horizontal ties across them
  for (let k = 0; k < mesh; k++) {
    const px = -w + width * ((k + 0.5) / mesh);
    rig.tube(P(px, -h, -0.1), P(px, h, -0.1), 0.028, AERIAL, 0.55, 3);
  }
  for (const f of [-0.5, 0, 0.5]) {
    rig.tube(P(-w, f * height, -0.1), P(w, f * height, -0.1), 0.03, AERIAL, 0.55, 3);
  }

  // the dipoles themselves, standing off the reflector
  for (let k = 0; k < rows; k++) {
    const py = -h + height * ((k + 0.5) / rows);
    rig.tube(P(-w + 0.2, py, 0.26), P(w - 0.2, py, 0.26), 0.038, AERIAL, 0.5, 4);
    for (const s of [-1, 1]) {
      rig.tube(P(s * (w - 0.2), py, 0.26), P(s * (w - 0.2), py, -0.1), 0.028, AERIAL, 0.55, 3);
    }
  }

  // back structure: a spine down the middle, braces out to the frame corners,
  // the waveguide trunk and the yoke it all hangs in
  rig.tube(P(0, -h, -0.15), P(0, h, -0.15), 0.09, RIG, 0.45, 5);
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) rig.tube(P(0, t * h * 0.5, -0.9), P(s * w * 0.92, t * h, -0.12), 0.055, RIG, 0.45, 4);
  }
  rig.box(0.5, 0.5, 1.1, P(0, 0, -0.75), RIG, 0.5);
  rig.tube(P(0, -h - 0.9, -0.75), P(0, 0, -0.75), 0.22, RIG, 0.45, 8);
  rig.box(1.5, 0.45, 1.2, P(0, -h - 1.0, -0.75), RIG, 0.5);

  const pivot = new Group();
  pivot.add(rig.mesh(material));
  return pivot;
}

// --- surface-search reflector ------------------------------------------------
// A dished parabolic reflector with its feed horn at the focus.
//
// The dish is a *solid* — out along the back, across the rim, and in along the
// concave face — rather than the one-sided shell a lathe gives you by default.
// A shell disappears the instant you look at its back, which on something that
// turns is every few seconds.
export function surfaceSearchDish({ slot, material, r = 1.9, depth = 0.62, thick = 0.09 }) {
  const rig = createRig(slot);
  const N = 9;
  const pts = [];
  for (let i = 0; i <= N; i++) { const t = i / N; pts.push(new Vector2(r * t, depth * t * t - thick)); }
  for (let i = N; i >= 0; i--) { const t = i / N; pts.push(new Vector2(r * t, depth * t * t)); }
  const dish = new LatheGeometry(pts, 26);
  dish.rotateX(Math.PI / 2); // lathe axis +y -> +z, so the bowl opens forward
  rig.put(dish, RIG, 0.4);

  // feed horn at the focus, on the three legs that hold it there
  const focus = new Vector3(0, 0, r * r / (4 * depth) * 0.55);
  rig.box(0.34, 0.34, 0.6, focus, AERIAL, 0.5);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    rig.tube(
      new Vector3(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82, depth * 0.68),
      focus, 0.035, AERIAL, 0.55, 3,
    );
  }
  // trunnion yoke and the pedestal it turns on
  for (const s of [-1, 1]) rig.tube(new Vector3(s * r * 0.8, 0, -0.1), new Vector3(s * 0.45, -1.0, -0.35), 0.07, RIG, 0.45, 5);
  rig.tube(new Vector3(0, -1.7, -0.35), new Vector3(0, -0.95, -0.35), 0.24, RIG, 0.45, 8);

  const pivot = new Group();
  pivot.add(rig.mesh(material));
  return pivot;
}
