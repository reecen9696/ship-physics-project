import { PlaneGeometry } from 'three/webgpu';

// The grid the sea surface is drawn on.
//
// A uniform grid is the wrong shape for this. The sea has to reach far enough
// that the horizon is water rather than an edge — several hundred metres — and
// it has to be fine enough near the camera that a launch sits on real waves,
// and a uniform grid can only be both by being fine *everywhere*. At 1 m cells
// over 900 m that is 1.6 million triangles, and the great majority of them are
// hundreds of metres away, where a cell covers a fraction of a pixel. Measured
// on this scene the surface was about seven eighths of the whole frame's render
// time, and roughly half of that was the grid alone.
//
// So the spacing is graded: fine under the ship, coarsening with distance. The
// curve is
//
//   w(u) = a·u + (1 - a)·u³,   u ∈ [-1, 1] along each axis
//
// with `a` fixed by the requirement that the innermost spacing come out at
// exactly one cell. Everything outside that stretches, cubically, so the last
// ring of cells is several metres across by the time it reaches the horizon —
// which is still far finer than a pixel at that distance.
//
// Two properties are worth spelling out, because both are load-bearing:
//
//   It is one continuous grid, not a set of concentric rings. Rings are the
//   usual way to do this and they bring T-junctions with them: two fine edges
//   meeting one coarse edge do not agree on where the surface is, and the
//   disagreement shows as slivers of sky flickering through the sea along every
//   ring boundary. Warping a single grid cannot crack.
//
//   Every vertex lands on a whole-metre lattice, because the warped coordinate
//   is rounded to a multiple of the base cell. That is what lets the mesh be
//   snapped as it follows the ship (see `recentreOcean`): the mesh origin moves
//   in whole cells and the offsets within it are whole cells, so a vertex
//   samples the wave field at the same world position every frame it exists.
//   Without that the grid slides continuously under a fixed wave field and the
//   surface crawls. Rounding cannot collapse a quad, since the spacing is never
//   less than one cell to begin with.
export function makeOceanGrid({ extent, segs, cell }) {
  const half = extent / 2;
  // linear share of the curve — chosen so w'(0) puts the first cell at `cell`
  const a = (segs * cell) / extent;
  if (a > 1) throw new Error('ocean grid: segs x cell exceeds the extent');

  const g = new PlaneGeometry(extent, extent, segs, segs);
  const pos = g.attributes.position;
  const warp = (v) => {
    const u = Math.abs(v);
    const w = (a * u + (1 - a) * u * u * u) * half;
    return Math.sign(v) * Math.round(w / cell) * cell;
  };
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, warp(pos.getX(i) / half));
    pos.setY(i, warp(pos.getY(i) / half));
  }
  pos.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}
