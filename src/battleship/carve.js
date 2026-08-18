// A box with rooms cut out of it.
//
// The pagoda's base blockhouse is one seventeen-metre box, and it has to gain a
// passage down the middle of it and a ladder well at the after end without
// gaining a second description of itself. So it is carved: the box and the voids
// go in, and what comes out is the list of boxes that is the original solid minus
// the voids.
//
// That list is then used for both jobs at once, which is the whole point. It is
// the collision the player walks against, and it is the plating that is drawn —
// and because every piece is a closed box, the inside of the passage is simply
// the outward faces of the pieces beside it. Nothing needs a liner and nothing
// can disagree: the wall you walk into is the wall you can see, because there is
// only one of them.
//
// (Contrast the hull and the deckhouses, which are shells and therefore *do*
// need a liner behind them — see interior.js. A shell has one surface and a
// carved solid has two, and that difference is the reason this is eight
// rectangles instead of a second inside-out mesh.)
//
// The method is a grid: split the box at every void boundary in all three axes,
// throw away the cells that fall inside a void, and glue what is left back
// together greedily. Exact, in any arrangement, and it cannot leave a gap.

// Unique sorted split planes for one axis: the box's own two, plus any void edge
// that actually falls inside it.
function splits(lo, hi, edges) {
  const out = [lo, hi];
  for (const e of edges) if (e > lo + 1e-6 && e < hi - 1e-6) out.push(e);
  out.sort((a, b) => a - b);
  return out.filter((v, i) => i === 0 || v - out[i - 1] > 1e-6);
}

const inside = (v, lo, hi) => v > lo && v < hi;

// `box` and each void are { min: [x,y,z], max: [x,y,z] }.
export function carveBox(box, voids) {
  const xs = splits(box.min[0], box.max[0], voids.flatMap((v) => [v.min[0], v.max[0]]));
  const ys = splits(box.min[1], box.max[1], voids.flatMap((v) => [v.min[1], v.max[1]]));
  const zs = splits(box.min[2], box.max[2], voids.flatMap((v) => [v.min[2], v.max[2]]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const nz = zs.length - 1;

  // solid[i][j][k]: is this cell still material?
  const at = (i, j, k) => (i * ny + j) * nz + k;
  const solid = new Uint8Array(nx * ny * nz).fill(1);
  for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ny; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      for (let k = 0; k < nz; k++) {
        const cz = (zs[k] + zs[k + 1]) / 2;
        for (const v of voids) {
          if (inside(cx, v.min[0], v.max[0])
            && inside(cy, v.min[1], v.max[1])
            && inside(cz, v.min[2], v.max[2])) { solid[at(i, j, k)] = 0; break; }
        }
      }
    }
  }

  // Greedy merge: grow each surviving cell as far as it will go in x, then in z,
  // then in y, and mark what it swallowed. Order matters only for how many boxes
  // come out; any order is correct. x-then-z-then-y suits a blockhouse, whose
  // voids are long passages and whose leftovers are therefore slabs.
  const taken = new Uint8Array(solid.length);
  const out = [];
  const free = (i, j, k) => solid[at(i, j, k)] && !taken[at(i, j, k)];
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        if (!free(i, j, k)) continue;
        let i1 = i + 1;
        while (i1 < nx && free(i1, j, k)) i1++;
        let k1 = k + 1;
        while (k1 < nz) {
          let ok = true;
          for (let ii = i; ii < i1 && ok; ii++) if (!free(ii, j, k1)) ok = false;
          if (!ok) break;
          k1++;
        }
        let j1 = j + 1;
        while (j1 < ny) {
          let ok = true;
          for (let ii = i; ii < i1 && ok; ii++) {
            for (let kk = k; kk < k1 && ok; kk++) if (!free(ii, j1, kk)) ok = false;
          }
          if (!ok) break;
          j1++;
        }
        for (let ii = i; ii < i1; ii++) {
          for (let jj = j; jj < j1; jj++) {
            for (let kk = k; kk < k1; kk++) taken[at(ii, jj, kk)] = 1;
          }
        }
        out.push({
          c: [(xs[i] + xs[i1]) / 2, (ys[j] + ys[j1]) / 2, (zs[k] + zs[k1]) / 2],
          h: [(xs[i1] - xs[i]) / 2, (ys[j1] - ys[j]) / 2, (zs[k1] - zs[k]) / 2],
        });
      }
    }
  }
  return out;
}
