import { Data3DTexture, RedFormat, LinearFilter, RepeatWrapping, UnsignedByteType } from 'three/webgpu';

// A small tiling 3D value-noise texture.
//
// Everything that has to look torn rather than cut — the edge of a shell hole,
// the line a funnel breaks along, the boundary of a scorch mark — needs a
// per-fragment random field, and it needs it at a *higher* frequency than the
// damage volume itself can carry. Hashing the position in the shader works and
// is what the paint grain does, but a hash is eight ALU-heavy calls per octave
// and this is sampled on every fragment of the ship. One trilinear fetch from a
// 32^3 texture is a fraction of that and is smooth by construction.
//
// The noise is built to tile, so it can be sampled at any world scale without a
// seam, and it is deliberately tiny: 32^3 single-channel is 32 KB, which lives
// in cache.

// value noise, periodic over `n`
function valueNoise(n, seed, freq) {
  const g = new Float32Array(freq * freq * freq);
  // hash the lattice
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < g.length; i++) g[i] = rnd();

  const out = new Float32Array(n * n * n);
  const smooth = (t) => t * t * (3 - 2 * t);
  const at = (x, y, z) => g[
    (((z % freq) + freq) % freq) * freq * freq
    + (((y % freq) + freq) % freq) * freq
    + (((x % freq) + freq) % freq)
  ];
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const fx = (x / n) * freq;
        const fy = (y / n) * freq;
        const fz = (z / n) * freq;
        const ix = Math.floor(fx); const iy = Math.floor(fy); const iz = Math.floor(fz);
        const tx = smooth(fx - ix); const ty = smooth(fy - iy); const tz = smooth(fz - iz);
        const lerp = (a, b, t) => a + (b - a) * t;
        const c00 = lerp(at(ix, iy, iz), at(ix + 1, iy, iz), tx);
        const c10 = lerp(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), tx);
        const c01 = lerp(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), tx);
        const c11 = lerp(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), tx);
        out[z * n * n + y * n + x] = lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
      }
    }
  }
  return out;
}

// Two octaves summed, which is enough: the shader samples this at two different
// world scales anyway, so a third octave here would only duplicate that.
export function makeNoise3D(n = 32) {
  const a = valueNoise(n, 0x9e3779b9, 4);
  const b = valueNoise(n, 0x85ebca6b, 8);
  const data = new Uint8Array(n * n * n);
  for (let i = 0; i < data.length; i++) {
    const v = a[i] * 0.65 + b[i] * 0.35;
    data[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  const tex = new Data3DTexture(data, n, n, n);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.wrapR = RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'noise3D';
  return tex;
}
