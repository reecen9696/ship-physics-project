import {
  Data3DTexture, RGBAFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping,
  Vector3, Vector4,
} from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';
import { makeNoise3D } from '../util/noise3D.js';

// Where the ship has been hurt, as a field in space rather than a number on a part.
//
// The old model gave every component one float and let the shader char the whole
// of it. That can only ever say *how much* a part has been hit, never *where*,
// which is why a working-over turned a whole bow section grey instead of
// punching holes in it. So damage is stored here as a volume in the ship's own
// frame, sampled per fragment by the ship's materials, and geometry that falls
// inside a crater is discarded. A hole is then a hole in whatever happens to
// pass through that region — the side plating, the deck behind it, the scuttle
// cut into it — without any of them knowing about each other.
//
// Three channels:
//
//   R  removed   a signed distance to the crater wall, remapped so 0.5 is the
//                wall itself. The shader thresholds it against a noise field,
//                which is what makes the edge ragged instead of a smooth blob,
//                and takes the band just outside it as torn bare metal.
//   G  scorch    the burnt halo, much wider than the hole
//   B  heat      1 at the instant of a burst, decayed over ~20 s; drives the
//                glow on a torn edge and tells the fire emitters where to work
//
// The volume is authoritative for *looks* only. Structure and flooding read the
// CPU-side wound list instead, which is exact and does not have to be sampled
// back off the GPU.
//
// --- why a CPU array and not a compute shader --------------------------------
// A burst is a few thousand voxels; stamping it on the CPU costs nothing. What
// would cost something is re-uploading the whole 4.5 MB volume for each one, so
// only the z-slices a wound actually touched are uploaded — a 4 m crater is 12
// slices out of 265, which is a 200 KB write. That keeps the whole thing to one
// texture, no compute pass, no readback, and no storage-texture plumbing.

export const VOXEL = 0.7; // m

// A crater's wall is not a step: it is feathered over a voxel and a half so the
// trilinear sample has something to interpolate, and so the noise threshold has
// somewhere to move to.
const FEATHER = VOXEL * 1.6;

export const MAX_PUNCTURES = 24;

// Heat falls off over about twenty seconds, which is roughly how long torn
// steel stays visibly hot.
const HEAT_DECAY = 0.055; // per second, exponential
const DECAY_INTERVAL = 0.25; // s between decay passes

export function createDamageField({
  bounds = { min: [-17, -11, -94], max: [17, 50, 94] },
  voxel = VOXEL,
} = {}) {
  const min = new Vector3(...bounds.min);
  const max = new Vector3(...bounds.max);
  const size = new Vector3().subVectors(max, min);
  const nx = Math.ceil(size.x / voxel);
  const ny = Math.ceil(size.y / voxel);
  const nz = Math.ceil(size.z / voxel);
  // snap the bounds up to a whole number of voxels so the texel centres are on
  // a regular lattice from the min corner
  max.set(min.x + nx * voxel, min.y + ny * voxel, min.z + nz * voxel);
  size.subVectors(max, min);

  const data = new Uint8Array(nx * ny * nz * 4);
  const texture = new Data3DTexture(data, nx, ny, nz);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.name = 'ship.damageField';
  // The WebGPU backend uploads only these slices when the set is non-empty, and
  // the whole volume when it is. Data3DTexture does not declare the pair, but
  // the backend only duck-types them — see WebGPUTextureUtils.updateTexture.
  texture.layerUpdates = new Set();
  texture.clearLayerUpdates = () => texture.layerUpdates.clear();
  // Upload the empty volume once, up front. Without this an undamaged ship
  // never flushes — `flush` has nothing dirty to write — so the texture stays at
  // version 0, three substitutes its default 1x1 *2D* white for the binding, and
  // the `texture3D` fetch in the ship's shader fails WebGPU validation with a
  // dimension mismatch before a single shell has been fired.
  texture.needsUpdate = true;

  const origin = uniform(min.clone());
  const invSize = uniform(new Vector3(1 / size.x, 1 / size.y, 1 / size.z));
  const active = uniform(0); // 0 until the first wound; the shader skips the fetches

  // --- punctures ------------------------------------------------------------
  // A 0.4 m armour-piercing entry hole is smaller than a voxel, so it cannot
  // live in the volume at all — it would come out as a soft 1.4 m blob. Small
  // sharp holes are therefore kept as an explicit list and tested as spheres in
  // the shader. The list is short and ring-buffered; an entry pushed out of it
  // is stamped into the volume on the way, so an old hole degrades into a
  // soft-edged one rather than healing.
  const punctures = [];
  for (let i = 0; i < MAX_PUNCTURES; i++) punctures.push(new Vector4(0, 0, 0, 0));
  const punctureArray = uniformArray(punctures, 'vec4');
  const punctureCount = uniform(0, 'int');
  let punctureCursor = 0;

  const noise = makeNoise3D(32);

  // --- the CPU wound list ---------------------------------------------------
  // What structure and flooding read. Kept small: wounds close enough to each
  // other to be the same crater are merged, which also stops a magazine hit
  // leaving forty entries behind.
  const wounds = [];
  const hotBoxes = []; // recent wounds, for the heat decay pass

  const idx = (x, y, z) => ((z * ny + y) * nx + x) * 4;
  const dirty = new Set();
  let initialized = false;

  function clampVox(v, n) { return v < 1 ? 1 : (v > n - 2 ? n - 2 : v); }

  // Stamp a crater. `p` is in the ship's own frame; `remove` is the radius out
  // to which material is gone; `scorch` the radius of the burn halo.
  //
  // `axis` and `flatten` squash it. A burst against a surface tears a wide
  // shallow bowl out of that surface; it does not excavate a sphere out of the
  // ship. Stamped as a sphere, a shell on the weather deck removed the deck,
  // the deckhead under it, the lower deck under that and the liner behind all
  // three — leaving a shaft with nothing in it, which is neither what happens
  // nor anything a man could ever walk across. Given the shell's own direction
  // as the axis, the removal reaches `remove` across the surface and only
  // `remove / flatten` into her, so what is under the hole is still there and
  // is what you see through it.
  //
  // `depthLimit` is the hard floor: no material is removed further than this
  // along the axis, whatever the severity and however many bursts have overlapped
  // there. Squashing the tear alone is not enough for that — the shader's discard
  // threshold moves about with noise, so the *ragged* edge of a tear reaches half
  // again as far as its solid part, and it only takes a few overlapping bursts
  // for that fringe to speckle its way through whatever was meant to be the floor
  // of the hole. A stated limit is exact, and it is what makes a wound a chip out
  // of her rather than a way into her.
  function stamp({
    x, y, z, remove = 2, scorch = null, heat = 1, axis = null, flatten = 1,
    depthLimit = Infinity,
  }) {
    const rScorch = scorch === null ? remove * 2.4 : scorch;
    const r = Math.max(remove + FEATHER, rScorch);
    const x0 = clampVox(Math.floor((x - r - min.x) / voxel), nx);
    const x1 = clampVox(Math.ceil((x + r - min.x) / voxel), nx);
    const y0 = clampVox(Math.floor((y - r - min.y) / voxel), ny);
    const y1 = clampVox(Math.ceil((y + r - min.y) / voxel), ny);
    const z0 = clampVox(Math.floor((z - r - min.z) / voxel), nz);
    const z1 = clampVox(Math.ceil((z + r - min.z) / voxel), nz);
    if (x1 < x0 || y1 < y0 || z1 < z0) return;

    const invFeather = 1 / (2 * FEATHER);
    const invScorch = 1 / Math.max(rScorch, 0.01);
    // the squash, as a unit axis and the factor the reach along it is divided by
    const ax = axis ? axis.x : 0;
    const ay = axis ? axis.y : 0;
    const az = axis ? axis.z : 0;
    const squash = axis && flatten !== 1;
    const f2 = flatten * flatten;
    for (let k = z0; k <= z1; k++) {
      const pz = min.z + (k + 0.5) * voxel - z;
      dirty.add(k);
      for (let j = y0; j <= y1; j++) {
        const py = min.y + (j + 0.5) * voxel - y;
        const zy = pz * pz + py * py;
        let o = idx(x0, j, k);
        for (let i = x0; i <= x1; i++, o += 4) {
          const px = min.x + (i + 0.5) * voxel - x;
          let d;
          let past = false;
          if (squash) {
            const along = px * ax + py * ay + pz * az;
            past = along > depthLimit;
            const perp2 = zy + px * px - along * along;
            d = Math.sqrt((perp2 > 0 ? perp2 : 0) + along * along * f2);
          } else {
            d = Math.sqrt(zy + px * px);
          }
          // removed: 0.5 exactly at the crater wall, feathered either side
          const rem = past ? 0 : 0.5 + (remove - d) * invFeather;
          if (rem > 0) {
            const v = rem > 1 ? 255 : (rem * 255) | 0;
            if (v > data[o]) data[o] = v;
          }
          // A burn is not a linear falloff from a point. The inner third of it
          // is uniformly black — that is where the flame actually stood — and
          // the fade is what happens outside that. A straight ramp puts the
          // half-value at half the radius, which reads as a soft smudge with no
          // centre to it however wide you make it.
          const sc = Math.min(1, (1 - d * invScorch) * 1.55);
          if (sc > 0) {
            const v = sc > 1 ? 255 : (sc * 255) | 0;
            if (v > data[o + 1]) data[o + 1] = v;
            const h = (v * heat) | 0;
            if (h > data[o + 2]) data[o + 2] = h;
          }
        }
      }
    }
    hotBoxes.push({ x0, x1, y0, y1, z0, z1, age: 0 });
    if (hotBoxes.length > 40) hotBoxes.shift();
    active.value = 1;
  }

  // A small sharp hole. Goes into the puncture list, not the volume.
  function puncture({ x, y, z, radius = 0.4 }) {
    const slot = punctureCursor;
    punctureCursor = (punctureCursor + 1) % MAX_PUNCTURES;
    const old = punctures[slot];
    if (old.w > 0) {
      // evicted: leave a soft mark behind rather than healing the plating
      stamp({ x: old.x, y: old.y, z: old.z, remove: old.w * 0.7, scorch: old.w * 3, heat: 0 });
    }
    old.set(x, y, z, radius);
    punctureArray.needsUpdate = true;
    if (punctureCount.value < MAX_PUNCTURES) punctureCount.value++;
    active.value = 1;
  }

  // --- wounds ---------------------------------------------------------------
  // The record structure and flooding read. Merged when they overlap heavily,
  // so a salvo into one compartment does not leave forty of them.
  function addWound(w) {
    for (const o of wounds) {
      const d = Math.hypot(o.x - w.x, o.y - w.y, o.z - w.z);
      if (d < Math.max(o.r, w.r) * 0.45) {
        // same crater: grow the one that is there
        const grown = Math.min(Math.hypot(o.r, w.r), o.r + w.r);
        o.x += (w.x - o.x) * (w.r / (o.r + w.r));
        o.y += (w.y - o.y) * (w.r / (o.r + w.r));
        o.z += (w.z - o.z) * (w.r / (o.r + w.r));
        o.r = grown;
        o.t = 0;
        return o;
      }
    }
    wounds.push(w);
    if (wounds.length > 96) wounds.shift();
    return w;
  }

  let decayAccum = 0;
  function update(dt) {
    for (const w of wounds) w.t += dt;
    decayAccum += dt;
    if (decayAccum >= DECAY_INTERVAL) {
      // Only the boxes a recent wound touched are walked, so this costs a few
      // tens of thousands of bytes rather than the whole 4.5 MB volume.
      const f = Math.exp(-HEAT_DECAY * decayAccum * 20);
      decayAccum = 0;
      for (let b = hotBoxes.length - 1; b >= 0; b--) {
        const box = hotBoxes[b];
        let any = 0;
        for (let k = box.z0; k <= box.z1; k++) {
          let changed = false;
          for (let j = box.y0; j <= box.y1; j++) {
            let o = idx(box.x0, j, k) + 2;
            for (let i = box.x0; i <= box.x1; i++, o += 4) {
              const v = data[o];
              if (v === 0) continue;
              const nv = (v * f) | 0;
              if (nv !== v) { data[o] = nv; changed = true; any += nv; }
            }
          }
          if (changed) dirty.add(k);
        }
        if (any === 0) hotBoxes.splice(b, 1);
      }
    }
    flush();
  }

  // Upload whatever changed. One write per touched z-slice; the backend turns
  // each into a queue.writeTexture of one slice at the right buffer offset.
  function flush() {
    if (dirty.size === 0) return;
    if (initialized) {
      for (const k of dirty) texture.layerUpdates.add(k);
    }
    initialized = true;
    dirty.clear();
    texture.needsUpdate = true;
  }

  function reset() {
    data.fill(0);
    wounds.length = 0;
    hotBoxes.length = 0;
    for (const p of punctures) p.set(0, 0, 0, 0);
    punctureArray.needsUpdate = true;
    punctureCount.value = 0;
    punctureCursor = 0;
    active.value = 0;
    texture.layerUpdates.clear();
    for (let k = 0; k < nz; k++) dirty.add(k);
    flush();
  }

  // How much of the material at a ship-frame point is gone, 0..1. Nearest
  // sample; the callers that use this (colliders, hole placement) are asking a
  // question the trilinear tail would only blur.
  function removedAt(x, y, z) {
    const i = Math.round((x - min.x) / voxel - 0.5);
    const j = Math.round((y - min.y) / voxel - 0.5);
    const k = Math.round((z - min.z) / voxel - 0.5);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    return data[idx(i, j, k)] / 255;
  }

  return {
    // what the materials need
    shading: {
      volume: texture,
      origin,
      invSize,
      punctures: punctureArray,
      punctureCount,
      noise,
      active,
    },
    stamp,
    puncture,
    addWound,
    wounds,
    update,
    reset,
    removedAt,
    bounds: { min, max, size },
    dims: { nx, ny, nz, voxel },
    get bytes() { return data.length; },
  };
}
