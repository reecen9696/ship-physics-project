import { Mesh, SphereGeometry, MeshBasicNodeMaterial, BackSide } from 'three/webgpu';
import {
  positionWorld, normalize, mix, smoothstep, max, dot, pow, float, floor, fract,
  vec3, Fn,
} from 'three/tsl';

// Analytic sky color for a view/reflection direction: vertical gradient plus a
// sun disc and soft halo. Shared by the sky dome and the ocean reflection so
// the reflected sky and the actual sky always match.
// `sunMask` attenuates only the direct sun terms, leaving the sky gradient
// alone — that is what a shadow does to water: it kills the glitter path, not
// the ambient sky it reflects.
//
// Night is the same function with different uniforms: a dark gradient and a
// dim, cool "sun" standing in for the moon. Doing it that way rather than as a
// separate night shader means the moon gets a disc, a glitter path on the water
// and a shadow off the ship for free, because they are the same code.
export function skyColor(dir, u, sunMask = float(1)) {
  const t = smoothstep(float(-0.05), float(0.4), dir.y);
  const grad = mix(u.horizon, u.zenith, t);
  const sd = max(dot(dir, u.sunDir), 0);
  const disc = pow(sd, float(1200)).mul(u.sunColor).mul(8); // sun/moon disc
  const halo = pow(sd, float(7)).mul(u.sunColor).mul(0.35); // soft glow
  return grad.add(disc.add(halo).mul(sunMask));
}

// Stars, for the dome only.
//
// Deliberately not part of `skyColor`: the ocean samples that function per
// fragment for its reflection, and a field of one-pixel points reflected off a
// moving, displaced surface scintillates horribly. The sky dome is static
// relative to the camera, so up there they simply sit still.
// A well-conditioned 3D -> 1D hash (Hoskins). The `fract` at the front is the
// important part: it folds the input back into [0,1) before anything is
// multiplied, so the arithmetic never leaves the range where float32 has
// precision to spare. Hashing a raw cell index by large primes instead lands
// the argument where the steps between neighbouring cells are below the float
// epsilon — which is how you get either an empty sky or, worse, one where the
// "random" values are correlated along the axes and the stars come out in rows.
const hash31 = (v, seed) => {
  const p3 = fract(v.mul(vec3(0.1031, 0.1030, 0.0973)).add(seed)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
};

const starField = Fn(([dir, night]) => {
  // Quantise the direction into cells and put at most one star in each.
  const cell = dir.mul(190).toVar();
  const id = floor(cell).toVar();
  const h = hash31(id, 0.0).toVar();
  const h2 = hash31(id, 17.31);
  // Offset each star inside its own cell so they do not sit on a lattice, and
  // measure the distance in all three axes. Measuring in two of them leaves the
  // third free, so on cells whose face happens to lie across that axis the star
  // is not a point at all but a streak — which is exactly how it looked.
  const jitter = vec3(hash31(id, 5.7), hash31(id, 9.2), hash31(id, 12.9))
    .sub(0.5).mul(0.5);
  const d = cell.sub(id).sub(0.5).sub(jitter).length();

  const point = smoothstep(float(0.30), float(0.05), d).mul(step0(h, 0.955));
  // Brightness varies a lot — an even field of identical dots reads as noise,
  // and it is the handful of bright ones that make it look like a sky.
  const bright = h2.mul(h2).mul(3.0).add(0.18);
  return vec3(0.85, 0.88, 1.0)
    .mul(point.mul(bright))
    // thin out into the horizon haze, but only right down at the rim
    .mul(smoothstep(float(0.0), float(0.16), dir.y))
    // Squared, so the stars fade faster than the lamps do. `night` drives both,
    // but they should not go together: at first light the ship still has every
    // light burning while the sky has already washed most of the stars out.
    .mul(night.mul(night));
});
const step0 = (x, edge) => smoothstep(float(edge), float(edge).add(0.004), x);

export function createSkyDome(u, radius = 12000) {
  const mat = new MeshBasicNodeMaterial();
  mat.side = BackSide;
  mat.fog = false;
  mat.colorNode = Fn(() => {
    const dir = normalize(positionWorld);
    return skyColor(dir, u).add(starField(dir, u.night));
  })();
  return new Mesh(new SphereGeometry(radius, 32, 16), mat);
}
