import {
  Data3DTexture, RedFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping,
  Vector3,
} from 'three/webgpu';
import { uniform } from '../scene/uniforms.js';
import { SHIP, SUPER, TURRETS, TURRET_SPEC } from './spec.js';
import { deckY, zOf } from './hull.js';
import { deckPropSolids } from './deckProps.js';
import { WHEEL } from './wheelhouse.js';

// What her own lights cannot get past.
//
// The lamp rig in shipMaterial.js throws warm light back onto the ship at night
// — onto the side decks, the galleries, the plating round each scuttle — and
// until now it threw it through everything. A crate standing in the middle of a
// pool of light had no shadow behind it, the deckhouse did not stop the light
// from the port run reaching the starboard deck, and the result read as a wash
// painted on the ship rather than as light falling on it. That is what the
// missing half of a light is: not the pool, but the dark shape in it.
//
// --- why this is baked -------------------------------------------------------
//
// The honest way to shadow eight lights is eight shadow maps, and it is not
// available: these are not three.js lights, they are a hand-written rig in one
// node material, and eight more depth passes a frame to shade a ship that is
// mostly dark would cost more than everything else in this file put together.
//
// But nothing about the problem is dynamic. The lamps are bolted to the ship,
// the crates are lashed to her deck, the deckhouses are where they were laid
// down, and the whole assembly moves as one rigid body — so *in her own frame*
// the answer at any point never changes. A thing that never changes should be
// computed once, and this is that: one pass at load, writing how much of her
// lamplight actually reaches each point of a grid in her frame, and one texture
// fetch a fragment at run time.
//
// It is cheaper than what it replaces, not dearer. The shader was evaluating ten
// emitters per fragment over the whole ship; it now evaluates them and multiplies
// by one sample. (Baking the light itself rather than the visibility would drop
// the loop entirely, and is the obvious next step — but the loop is what carries
// the surface normal, and a volume cannot, so the light would go flat.)
//
// --- what is approximate about it --------------------------------------------
//
// One scalar for all the lamps, not one per lamp: what is stored is the fraction
// of the light arriving here that got here, weighted by how much each lamp
// contributes. Where two lamps overlap and only one of them is blocked, the
// shadow is softened toward the average instead of being cut where it should be.
// On this ship the lamps are far enough apart that it almost never comes up, and
// the alternative is eight volumes.
//
// The grid is coarse enough that the edge of a shadow is soft — about half a
// metre — which for cabin light through a porthole at night is not a compromise,
// it is what it looks like.

// The box the grid covers, in her frame, and how fine it is.
//
// Sized to the lamps rather than to the ship: everything forward of the bridge
// and abaft the after deckhouse is out of reach of every one of them, and a
// voxel out there would be storing "nothing is blocking a light that is not
// shining". Outside the box the sample clamps to the edge, which is 1 — no
// occlusion — and that is exactly right for somewhere no light reaches.
export const LAMP_VOL = {
  // Wide enough to clear her sheer, deep enough to reach from under the main
  // deck to the top house on the pagoda, and long enough to hold the lights on
// Y turret aft and A turret forward with their reach around them — a lamp
// outside the box casts no
  // shadows at all, and `lampsInsideVolume` below will say so — and half a metre
  // to a side, which is about the width of the shadow edge that comes out of a
  // trilinear fetch. Crisper than that is not wanted: this is cabin light
  // through a porthole, and its shadows have no hard edge in the first place.
  min: [-16.5, 3.5, -76.0],
  max: [16.5, 38.0, 56.0],
  voxel: 0.55,
};

export function lampVolumeDims() {
  const { min, max, voxel } = LAMP_VOL;
  return {
    nx: Math.ceil((max[0] - min[0]) / voxel),
    ny: Math.ceil((max[1] - min[1]) / voxel),
    nz: Math.ceil((max[2] - min[2]) / voxel),
  };
}

// Allocated fully lit, so the ship looks exactly as it did until the bake lands.
export function createLampVolume() {
  const { nx, ny, nz } = lampVolumeDims();
  const data = new Uint8Array(nx * ny * nz).fill(255);
  const texture = new Data3DTexture(data, nx, ny, nz);
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.needsUpdate = true;

  const min = new Vector3(...LAMP_VOL.min);
  const size = new Vector3(...LAMP_VOL.max).sub(min);
  return {
    texture,
    data,
    origin: uniform(min.clone()),
    invSize: uniform(new Vector3(1 / size.x, 1 / size.y, 1 / size.z)),
  };
}

// --- the falloff, in JS ------------------------------------------------------
//
// The twin of the one in boatMaterial.js, and it has to stay its twin: this
// decides how much each lamp counts toward the weighted visibility, and the
// shader decides how much each lamp actually contributes. If they disagree the
// shadow is weighted for a light that is not there. The pair is written
// line-for-line, the same arrangement the hull curves use — see hull.js.
function lampWeight(px, py, pz, lamp, out) {
  const ex = lamp.ext ? lamp.ext[0] : 0;
  const ey = lamp.ext ? lamp.ext[1] : 0;
  const ez = lamp.ext ? lamp.ext[2] : 0;
  const dx = px - lamp.x;
  const dy = py - lamp.y;
  const dz = pz - lamp.z;
  // the nearest point on the emitter, which is what the distance is measured to
  const cx = Math.min(Math.max(dx, -ex), ex) - dx;
  const cy = Math.min(Math.max(dy, -ey), ey) - dy;
  const cz = Math.min(Math.max(dz, -ez), ez) - dz;
  // A lamp shut in a room contributes nothing outside it, so it must not be
  // weighted outside it either — the shader applies the same cut (see `bound` in
  // shipMaterial.js), and a weight the shader disagrees with would drag this
  // voxel's visibility toward a light that is not reaching it.
  if (lamp.room) {
    const r = lamp.room;
    if (Math.abs(px) > r[0] || Math.abs(py - lamp.y) > r[1] || Math.abs(pz - lamp.z) > r[2]) {
      return 0;
    }
  }
  const dist = Math.hypot(cx, cy, cz);
  const reach = Math.max(lamp.reach, 0.01);
  const k = dist / reach;
  if (k >= 1) return 0;
  const win = 1 - k * k * k * k;
  const soft = dist / Math.max(lamp.soft ?? 2.2, 0.05);
  const atten = (win * win) / (soft * soft + 1);
  // the lamp's own brightness, so a dim lamp does not drag the average about
  const level = lamp.level ?? 1;
  const lum = (lamp.color[0] + lamp.color[1] + lamp.color[2]) / 3;
  out.x = cx; out.y = cy; out.z = cz;
  return atten * level * lum;
}

// --- occluders ---------------------------------------------------------------
//
// Boxes in her frame. The props come straight from the collision list that the
// player already walks round — one statement of where a crate is, used for both
// — and the superstructure is read off spec.js the same way deckProps.js reads
// it. Nothing here is a second description of the ship.
export function lampOccluders() {
  const boxes = [];
  const add = (cx, cy, cz, hx, hy, hz) => boxes.push({
    cx, cy, cz, hx, hy, hz,
  });

  // what is standing on her deck
  for (const b of deckPropSolids()) {
    add(b.c.x, b.c.y, b.c.z, b.h.x, b.h.y, b.h.z);
  }

  // the deckhouses. Given their real height, because a light on the shelter deck
  // side must not reach the starboard deck through twenty metres of ship — which
  // it did, and which is the least subtle of the things this fixes.
  for (const h of [SUPER.funnelDeck, SUPER.aftSuper]) {
    add(0, deckY(h.z) + h.h / 2, zOf(h.z), h.w / 2, h.h / 2, h.l / 2);
  }
  // the pagoda's two base blockhouses, off the numbers buildBridge draws them at
  {
    const y0 = deckY(SUPER.bridge.z);
    const z0 = zOf(SUPER.bridge.z);
    add(0, y0 + 2.0, z0 - 1.0, 8.5, 2.0, 10.5);
    add(0, y0 + 5.7, z0, 6.5, 1.7, 7.5);
    // and the column above them, as a box: it is round, but a shadow half a
    // metre soft does not know the difference.
    //
    // In two pieces, with the wheelhouse's height out of the middle, because the
    // column itself is now drawn that way (see superstructure.js). Left whole, it
    // stood in the middle of the wheelhouse blocking that room's own window band
    // from lighting the half of the room the light is actually in.
    const gap = [WHEEL.y, WHEEL.y + WHEEL.ceiling];
    for (const [a, b] of [[7.4, gap[0]], [gap[1], 7.4 + 30.5]]) {
      add(0, y0 + (a + b) / 2, z0 - 0.5, 3.0, (b - a) / 2, 3.0);
    }
  }
  // the funnel
  {
    const F = SUPER.funnel;
    add(0, deckY(F.z) + SUPER.funnelDeck.h + F.h / 2, zOf(F.z), F.rx, F.h / 2, F.rz);
  }
  // The turrets, as two boxes rather than one.
  //
  // It used to be a single block the size of the barbette, run all the way up to
  // the roof, and that is a good deal *narrower and shorter* than the gunhouse
  // standing on it — 9.2 by 9.2 against 10 by 12. The difference is exactly the
  // strip the door lights hang on, so the light over a door was not being
  // stopped by the very turret it is bolted to and came out on the front face.
  for (const t of TURRETS) {
    // what it stands on: the bandstand, or the barbette drum
    const sw = t.bandstand ? TURRET_SPEC.barbetteR * 2.5 * 1.12 : TURRET_SPEC.barbetteR * 2;
    const sd = t.bandstand ? TURRET_SPEC.barbetteR * 2.5 * 1.26 : TURRET_SPEC.barbetteR * 2;
    add(0, deckY(t.z) + t.deckRise / 2, zOf(t.z), sw / 2, t.deckRise / 2, sd / 2);
    // and the gunhouse itself, at its own size. Taken at rest: it trains, and a
    // baked volume has one answer — which is the same bargain the damage field
    // makes, and for the same reason.
    add(0, deckY(t.z) + t.deckRise + TURRET_SPEC.gunhouseH / 2, zOf(t.z) - 1.0,
      TURRET_SPEC.gunhouseW / 2, TURRET_SPEC.gunhouseH / 2, TURRET_SPEC.gunhouseL / 2);
  }
  return boxes;
}

// Does the segment from `p` to `p + dir` (dir not normalised — it is the whole
// span) clear this box? The standard slab test, with the two cases that matter
// on a ship: a segment that starts inside a box is not blocked by it, because
// that is a fragment on the surface of the very thing being tested, and a box
// the segment reaches only past its far end does not block either.
function blocked(px, py, pz, dx, dy, dz, b) {
  let t0 = 0;
  let t1 = 1;
  const lo = [b.cx - b.hx, b.cy - b.hy, b.cz - b.hz];
  const hi = [b.cx + b.hx, b.cy + b.hy, b.cz + b.hz];
  const p = [px, py, pz];
  const d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (p[a] < lo[a] || p[a] > hi[a]) return false;
      continue;
    }
    const inv = 1 / d[a];
    let n = (lo[a] - p[a]) * inv;
    let f = (hi[a] - p[a]) * inv;
    if (n > f) { const t = n; n = f; f = t; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }
  // Starting inside is not being blocked: shading a crate's own face must not
  // read that crate as the thing shadowing it, or every prop turns matte black.
  return t0 > 1e-4;
}

// --- the bake ----------------------------------------------------------------
//
// One pass over the grid. Most of it costs nothing: a voxel out of reach of
// every lamp writes "lit" and moves on, and on this ship that is most of them.
// Where a lamp does reach, the segment to it is tested against the boxes whose
// own bounds it could possibly cross, found through a coarse grid — without that
// it is 500,000 voxels against 100 boxes and the ship takes a second to appear.
export function bakeLampVolume(volume, lamps) {
  if (!lamps || !lamps.length) return 0;
  const boxes = lampOccluders();
  const { nx, ny, nz } = lampVolumeDims();
  const { min, voxel } = LAMP_VOL;
  const data = volume.data;

  // a coarse bucket grid over the occluders, so a voxel only ever tests the
  // handful of boxes anywhere near it
  const CELL = 6.0;
  const cells = new Map();
  const key = (i, j, k) => `${i}|${j}|${k}`;
  for (const b of boxes) {
    const i0 = Math.floor((b.cx - b.hx) / CELL);
    const i1 = Math.floor((b.cx + b.hx) / CELL);
    const j0 = Math.floor((b.cy - b.hy) / CELL);
    const j1 = Math.floor((b.cy + b.hy) / CELL);
    const k0 = Math.floor((b.cz - b.hz) / CELL);
    const k1 = Math.floor((b.cz + b.hz) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const id = key(i, j, k);
          if (!cells.has(id)) cells.set(id, []);
          cells.get(id).push(b);
        }
      }
    }
  }

  // every box the segment's own bounding box touches
  const seen = new Set();
  const near = [];
  function candidates(px, py, pz, qx, qy, qz) {
    near.length = 0;
    seen.clear();
    const i0 = Math.floor(Math.min(px, qx) / CELL);
    const i1 = Math.floor(Math.max(px, qx) / CELL);
    const j0 = Math.floor(Math.min(py, qy) / CELL);
    const j1 = Math.floor(Math.max(py, qy) / CELL);
    const k0 = Math.floor(Math.min(pz, qz) / CELL);
    const k1 = Math.floor(Math.max(pz, qz) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const list = cells.get(key(i, j, k));
          if (!list) continue;
          for (const b of list) {
            if (seen.has(b)) continue;
            seen.add(b);
            near.push(b);
          }
        }
      }
    }
    return near;
  }

  const dir = { x: 0, y: 0, z: 0 };
  let shaded = 0;
  for (let k = 0; k < nz; k++) {
    const pz = min[2] + (k + 0.5) * voxel;
    for (let j = 0; j < ny; j++) {
      const py = min[1] + (j + 0.5) * voxel;
      for (let i = 0; i < nx; i++) {
        const px = min[0] + (i + 0.5) * voxel;
        let total = 0;
        let visible = 0;
        for (const L of lamps) {
          const w = lampWeight(px, py, pz, L, dir);
          // Below this a lamp is contributing under a percent of its own peak
          // and the ratio it is about to be folded into cannot notice — but the
          // occlusion ray it would cost is the most expensive thing in this
          // loop, and there are twenty lamps now. Raising the floor from 1e-4
          // took the bake from two and a half seconds back under one.
          if (w <= 2e-3) continue;
          total += w;
          const list = candidates(px, py, pz, px + dir.x, py + dir.y, pz + dir.z);
          let hit = false;
          for (let b = 0; b < list.length; b++) {
            if (blocked(px, py, pz, dir.x, dir.y, dir.z, list[b])) { hit = true; break; }
          }
          if (!hit) visible += w;
        }
        // No light here at all: store lit. It costs nothing and it keeps the
        // trilinear filter from dragging a shadow out of a region that has no
        // light in it to shadow.
        const v = total > 1e-4 ? visible / total : 1;
        if (v < 0.999) shaded++;
        data[i + nx * (j + ny * k)] = Math.round(Math.min(Math.max(v, 0), 1) * 255);
      }
    }
  }
  volume.texture.needsUpdate = true;
  return shaded;
}

// Kept for the caller that wants to know whether the box is big enough to hold
// the ship's lights — a lamp outside it is a lamp whose shadows are all missing,
// and that is a hard thing to see and an easy thing to check.
export function lampsInsideVolume(lamps) {
  const { min, max } = LAMP_VOL;
  return lamps.filter((l) => l.x >= min[0] && l.x <= max[0]
    && l.y >= min[1] && l.y <= max[1]
    && l.z >= min[2] && l.z <= max[2]);
}

export const LAMP_VOL_HULL = SHIP; // re-exported so the bounds above can be read against her
