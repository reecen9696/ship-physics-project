// The hull as a solid, from the curves the mesh was lofted from.
//
// Two things want to know where a hull *is* rather than what it looks like, and
// neither of them wants a mesh. The camera has to be kept from walking through
// the plating, and the collision solver has to know when two hulls are in the
// same water. Both work in the hull's own frame, which is where the descriptors
// in hull.js and boatMesh.js already live, so both are served from the same
// analytic curves the geometry came from — no acceleration structure, no
// triangles, and no second description of the ship that can drift out of step
// with the first.

// --- the hull as a volume ----------------------------------------------------
//
// Penetration depth (> 0 when the point is inside) and the outward normal of the
// nearest surface, in the hull's frame. Same contract as `query` in
// battleship/colliders.js, so a caller can hold either without caring which.
//
// The section is treated as a box at each station: full plan beam from keel to
// deck. That is a fair description of a small hull with slab topsides and a
// crude one of a flared section — which is why the battleship uses her own
// colliders, built from her real section curve, and this is what the launch
// gets.
export function hullQuery(hull) {
  const deckAt = hull.deckAt || (() => hull.deck);
  const keelAt = hull.keelAt || (() => hull.keel);

  return function query(p, out) {
    const s = p.z / hull.length + 0.5;
    if (s <= 0.002 || s >= 0.998) return 0;

    const dTop = deckAt(s) - p.y;
    if (dTop <= 0) return 0;
    const dBottom = p.y + keelAt(s);
    if (dBottom <= 0) return 0;
    const dSide = hull.halfBeamAt(s) - Math.abs(p.x);
    if (dSide <= 0) return 0;

    if (out) out.id = null;
    // out through whichever face is nearest
    if (dTop <= dSide && dTop <= dBottom) { out.normal.set(0, 1, 0); return dTop; }
    if (dBottom <= dSide) { out.normal.set(0, -1, 0); return dBottom; }
    out.normal.set(Math.sign(p.x) || 1, 0, 0);
    return dSide;
  };
}

// --- the hull as a chain of spheres ------------------------------------------
//
// What the collision solver works on. A sphere per station down the centreline,
// each with the plan beam at that station for its radius, so the chain has the
// hull's waterplane shape: full amidships, fine at the bow, and the right length.
//
// It has no freeboard — a sphere of the half beam is far taller than the hull is
// deep — and that is deliberate. Everything that collides here floats on the
// same sea at the same level, so the question is only ever whether two
// waterplanes overlap, and the vertical extent of the shape never comes into it.
// The day something flies over a deck, this is the assumption that breaks.
export function hullSpheres(hull, count = 9) {
  const spheres = [];
  // A fine bow tapers to nothing, and a sphere of nothing lets the other hull
  // slide past the stem untouched. Hold a floor under it.
  const minR = hull.halfBeam * 0.14;
  // Centred on the hull's own mid-depth rather than on the waterline, so the
  // chain sits in the hull instead of half above it.
  const y = (hull.deck - hull.keel) * 0.5;
  for (let i = 0; i < count; i++) {
    const s = (i + 0.5) / count;
    spheres.push({
      z: (s - 0.5) * hull.length,
      y,
      r: Math.max(hull.halfBeamAt(s), minR),
    });
  }
  return spheres;
}
