import { BufferAttribute, BufferGeometry } from 'three/webgpu';

// Merge indexed geometries that share an attribute set into one buffer.
//
// This is `BufferGeometryUtils.mergeGeometries` in eight lines, and it is here
// rather than imported because the addons build imports from `three` while
// everything in this project comes from `three/webgpu` — two module instances,
// two BufferGeometry classes, and a merged geometry that came from the wrong
// one. Ours are all Float32 and all indexed, which is the whole of the case the
// general version has to handle.
//
// Note that `paint` bakes colour, roughness and damage slot into vertex
// attributes, so geometries that have already been painted differently can be
// merged into one mesh and still look like different things — which is how a
// scuttle's brass rim and its glass end up in the same draw call.
export function merge(geoms) {
  const names = Object.keys(geoms[0].attributes);
  let vertices = 0;
  let indices = 0;
  for (const g of geoms) {
    vertices += g.attributes.position.count;
    indices += g.index.count;
  }
  const out = new BufferGeometry();
  for (const name of names) {
    const size = geoms[0].attributes[name].itemSize;
    const arr = new Float32Array(vertices * size);
    let o = 0;
    for (const g of geoms) { arr.set(g.attributes[name].array, o); o += g.attributes[name].count * size; }
    out.setAttribute(name, new BufferAttribute(arr, size));
  }
  const index = new Uint32Array(indices);
  let o = 0;
  let base = 0;
  for (const g of geoms) {
    for (let i = 0; i < g.index.count; i++) index[o++] = g.index.array[i] + base;
    base += g.attributes.position.count;
  }
  out.setIndex(new BufferAttribute(index, 1));
  return out;
}
