import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// Where the numbers in src/player/models.js came from.
//
// An authored asset arrives in somebody else's conventions — its own units, its
// own up axis, its own idea of which way "forward" is — and every one of those
// has to be converted exactly once, at the seam. This is how that seam was
// measured, kept so the next model can be measured the same way rather than by
// loading it into the game and nudging numbers until it stops looking wrong.
//
//   node probe-models.mjs public/models/m16.fbx public/models/soldier.fbx
//
// For a weapon what you want out of it is the per-mesh table: the barrel is the
// long cylinder, the muzzle is the far end of it, the handguard is the box the
// torch clamps under, and their extents fix the scale and the mount points. For
// a figure it is the bone tree: the names the rig actually uses and where each
// joint sits, which is what soldier.js poses and what fixes his height.

// Node has no DOM, and the loader reaches for one on the texture path.
global.self = global;
const stub = () => ({
  style: {}, setAttribute() {}, addEventListener() {}, removeEventListener() {},
  getContext: () => null,
});
global.document = { createElement: stub, createElementNS: stub };
global.URL.createObjectURL = () => 'blob:stub';

const fixed = (v, w = 6) => v.toFixed(1).padStart(w);

for (const path of process.argv.slice(2)) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let root;
  try {
    root = new FBXLoader().parse(ab, '');
  } catch (e) {
    console.log(`${path}: PARSE FAILED — ${e.message}`);
    continue;
  }
  root.updateMatrixWorld(true);

  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  console.log(`\n==== ${path}`);
  console.log(`  extent  ${size.toArray().map((n) => n.toFixed(1)).join(' x ')}`
    + `   min ${box.min.toArray().map((n) => n.toFixed(1)).join(',')}`
    + `   max ${box.max.toArray().map((n) => n.toFixed(1)).join(',')}`);
  console.log(`  root    rot ${root.rotation.toArray().slice(0, 3)
    .map((n) => (n * 180 / Math.PI).toFixed(0)).join(',')}°`
    + `   animations ${root.animations.length}`);

  // --- the meshes, sorted along the longest axis ---------------------------
  const rows = [];
  let bones = 0;
  root.traverse((o) => {
    if (o.isBone) bones++;
    if (!o.isMesh) return;
    const b = new Box3().setFromObject(o);
    rows.push({
      name: o.name,
      skinned: !!o.isSkinnedMesh,
      c: b.getCenter(new Vector3()),
      s: b.getSize(new Vector3()),
      tri: (o.geometry.index ? o.geometry.index.count
        : o.geometry.attributes.position.count) / 3,
      attrs: Object.keys(o.geometry.attributes).join('+'),
    });
  });
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');
  rows.sort((a, b) => a.c[axis] - b.c[axis]);
  console.log(`  ${rows.length} mesh(es), sorted along ${axis}:`);
  for (const r of rows) {
    console.log(`    ${r.name.padEnd(13)}`
      + ` centre(${fixed(r.c.x)},${fixed(r.c.y)},${fixed(r.c.z)})`
      + ` size(${fixed(r.s.x)},${fixed(r.s.y)},${fixed(r.s.z)})`
      + ` ${String(r.tri).padStart(5)} tri  ${r.skinned ? 'skinned ' : ''}${r.attrs}`);
  }

  // --- and the rig ----------------------------------------------------------
  if (!bones) continue;
  console.log(`  ${bones} bones:`);
  const dump = (b, depth) => {
    const p = b.getWorldPosition(new Vector3());
    console.log(`    ${'  '.repeat(depth)}${b.name}`
      + `  (${fixed(p.x)},${fixed(p.y)},${fixed(p.z)})`);
    for (const c of b.children) if (c.isBone) dump(c, depth + 1);
  };
  root.traverse((o) => { if (o.isBone && !o.parent?.isBone) dump(o, 0); });
}
