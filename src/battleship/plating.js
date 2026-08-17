import { BufferGeometry, BufferAttribute } from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { STEEL } from './hull.js';

// The chunks of her that used to be where the hole is.
//
// shards.js already throws a few dozen chips off every burst, and that is the
// right system for what it does: they are small, there are many of them, they
// are gone in three seconds, and one instanced draw covers the lot. What it
// cannot do is *land*. An instanced pool has no contacts, so every piece of
// that plating falls through the deck it was blown onto and through the hull
// under that.
//
// So the large pieces come off separately, as real bodies in wreck.js: contact
// points, gravity, a tumble, and the ship's own surfaces to hit. A shell into a
// deckhouse throws several of these onto the deck below it, where they slide,
// come to rest, ride with her, and go over the side when she heels — which is
// the difference between plating that has been blown off her and plating that
// has been deleted. They are meant to still be lying there afterwards, because
// one day somebody has to walk round them.
//
// --- why they are chunks and not sheets --------------------------------------
// These were flat torn sheets, and a flat sheet is nearly invisible: seen
// edge-on it is a line, and lying on a deck it is a shadow. What a shell
// actually leaves on a deck is *chunks* — plate folded double by the blast,
// short lengths of the frames and stringers behind it, and lumps of the
// structure that was between them. Those have thickness from every angle, they
// cast a shadow you can read, and they are an obstacle rather than a decal. So
// there are three families here and none of them is flat.
//
// They share the ship's own material, so they are painted like the plate they
// came from and cost no shader of their own.

// A tiny deterministic generator, so the set is the same every run and the
// pieces can be told apart by eye rather than being six of the same shape.
function rng(seed) {
  let s = (seed * 9781) | 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Build an indexed mesh from a list of quads/tris over a shared point list.
function solidFrom(pts, faces) {
  const pos = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    pos[i * 3] = pts[i][0];
    pos[i * 3 + 1] = pts[i][1];
    pos[i * 3 + 2] = pts[i][2];
  }
  const idx = [];
  for (const f of faces) {
    for (let i = 1; i < f.length - 1; i++) idx.push(f[0], f[i], f[i + 1]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// --- torn plate, folded ------------------------------------------------------
// A panel ripped out and bent along a line across it, so it lies as a shallow
// tent rather than flat. Irregular in plan on both halves, and thick enough at
// the torn edge to read as plate rather than as paper.
function foldedPlate(seed) {
  const rand = rng(seed);
  const n = 5; // points along each half of the fold
  const fold = 0.28 + rand() * 0.45; // how far it is bent up
  const th = 0.055 + rand() * 0.05; // half the plate's thickness
  const top = [];
  const bot = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = (-0.5 + t) * (0.85 + rand() * 0.5);
      // the far edge of each half is torn, so its reach varies along the fold
      const reach = (0.35 + rand() * 0.4);
      const z = side * reach;
      const y = fold * (1 - Math.abs(side * reach) / 0.75) * (side > 0 ? 0.65 : 1);
      top.push([x, y + th, z]);
      bot.push([x, y - th, z]);
    }
  }
  const N = top.length;
  const pts = [...top, ...bot];
  const faces = [];
  // the two halves, top and bottom
  for (const off of [0, n]) {
    for (let i = 0; i < n - 1; i++) {
      faces.push([off + i, off + i + 1, N + off + i + 1, N + off + i]);
    }
  }
  // the fold itself, joining the inboard edges of the halves
  faces.push([0, n, N + n, N]);
  faces.push([n - 1, N + n - 1, N + 2 * n - 1, 2 * n - 1]);
  // torn edges all round
  for (let i = 0; i < N - 1; i++) faces.push([i, N + i, N + i + 1, i + 1]);
  return solidFrom(pts, faces);
}

// --- a lump of structure -----------------------------------------------------
// What was behind the plating: a short length of frame or stringer with the
// plate still hanging off it, torn out as one piece. A box with a web, bent.
function girder(seed) {
  const rand = rng(seed);
  const len = 0.55 + rand() * 0.55;
  const w = 0.13 + rand() * 0.12;
  const h = 0.22 + rand() * 0.2;
  const kink = (rand() - 0.5) * 0.5; // it did not come out straight
  const pts = [];
  const faces = [];
  const rings = 3;
  for (let k = 0; k < rings; k++) {
    const t = k / (rings - 1);
    const cx = (t - 0.5) * 2 * len;
    const cy = kink * Math.sin(t * Math.PI);
    const sw = w * (0.7 + rand() * 0.6);
    const sh = h * (0.7 + rand() * 0.6);
    pts.push([cx, cy - sh, -sw], [cx, cy - sh, sw], [cx, cy + sh, sw], [cx, cy + sh, -sw]);
  }
  for (let k = 0; k < rings - 1; k++) {
    const a = k * 4;
    const b = (k + 1) * 4;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      faces.push([a + i, a + j, b + j, b + i]);
    }
  }
  faces.push([3, 2, 1, 0]);
  const e = (rings - 1) * 4;
  faces.push([e, e + 1, e + 2, e + 3]);
  return solidFrom(pts, faces);
}

// --- a torn chunk ------------------------------------------------------------
// The general case: an irregular lump with no flat face on it anywhere. Two
// rings of scattered points, capped — it is what a piece of a ship blown apart
// looks like at the size these are seen at, which is a few metres.
function chunk(seed) {
  const rand = rng(seed);
  const n = 6;
  const pts = [];
  const faces = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.3;
      const r = 0.32 + rand() * 0.36;
      pts.push([Math.cos(a) * r, s * (0.16 + rand() * 0.22), Math.sin(a) * r]);
    }
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, n + j, n + i]);
  }
  faces.push(Array.from({ length: n }, (_, i) => n - 1 - i));
  faces.push(Array.from({ length: n }, (_, i) => n + i));
  return solidFrom(pts, faces);
}

// One set for the whole ship, built once and shared by every piece that comes
// off her. wreck.js never disposes a geometry it was handed, precisely so this
// can be true.
export function buildTornPlating({ materials }) {
  const slot = materials.slotOf('wreckage');
  const geoms = [
    foldedPlate(1), foldedPlate(2), foldedPlate(3),
    chunk(4), chunk(5),
    girder(6), girder(7),
  ];
  return geoms.map((g) => paint(g, {
    color: STEEL,
    roughness: 0.55,
    slot,
    metal: 0.7,
    // Rolled plate, so it carries seams and rivets like the rest of her — none
    // of these is a primitive the `paint` heuristic would read as plated.
    plate: 1,
  }));
}
