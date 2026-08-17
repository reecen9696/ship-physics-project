import { BufferGeometry, BufferAttribute } from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { STEEL } from './hull.js';

// The plating that used to be where the hole is — as bodies, not as particles.
//
// shards.js already throws a few dozen pieces of torn plate off every burst,
// and that is the right system for what it does: they are small, there are many
// of them, they are gone in three seconds, and one instanced draw covers the
// lot. What it cannot do is *land*. An instanced pool has no contacts, so every
// piece of that plating falls through the deck it was blown onto and through
// the hull under that.
//
// So the large pieces come off separately, as real bodies in wreck.js: half a
// dozen contact points each, gravity, a tumble, and the ship's own analytic
// surfaces to hit. A shell into a deckhouse throws two or three of these onto
// the deck below it, where they slide, come to rest, ride with her, and go over
// the side when she heels — which is the difference between plating that has
// been blown off her and plating that has been deleted.
//
// They share the ship's own material, so they are painted grey on the outside
// like the plate they came from, and they cost no shader of their own.

// A torn sheet, roughly a metre across at scale 1: irregular in plan, buckled
// out of flat, and thick enough to read edge-on. Two of them, because one
// silhouette repeated across a deck full of wreckage is a texture.
function tornSheet(seed) {
  // plan outline, walked round; r varies so no two pieces share a silhouette
  const n = 7;
  const top = [];
  const bot = [];
  let rnd = seed * 9781;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 0.34 + rand() * 0.36;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r * (0.6 + rand() * 0.7);
    // buckled: the sheet is not flat, it has been folded by the blast
    const y = (rand() - 0.5) * 0.22;
    top.push([x, y + 0.018, z]);
    bot.push([x, y - 0.018, z]);
  }
  const pos = [];
  const idx = [];
  const push = (p) => { pos.push(p[0], p[1], p[2]); return pos.length / 3 - 1; };
  const ti = top.map(push);
  const bi = bot.map(push);
  // both faces, as fans
  for (let i = 1; i < n - 1; i++) {
    idx.push(ti[0], ti[i], ti[i + 1]);
    idx.push(bi[0], bi[i + 1], bi[i]);
  }
  // and the torn edge round the rim
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(ti[i], bi[i], bi[j]);
    idx.push(ti[i], bi[j], ti[j]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// One set for the whole ship, built once and shared by every piece that comes
// off her. wreck.js never disposes a geometry it was handed, precisely so this
// can be true.
export function buildTornPlating({ materials }) {
  const slot = materials.slotOf('wreckage');
  return [1, 2, 3, 4].map((s) => paint(tornSheet(s), {
    color: STEEL,
    roughness: 0.55,
    slot,
    metal: 0.7,
    // Rolled plate, so it carries seams and rivets like the rest of her — the
    // geometry is not a box, so it would otherwise be read as something turned.
    plate: 1,
  }));
}
