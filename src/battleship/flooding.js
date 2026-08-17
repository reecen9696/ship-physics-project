import { Vector3 } from 'three/webgpu';
import { COMPARTMENTS, FLOODING, SHIP } from './spec.js';
import { section, deckAt, keelAt, sideAt } from './hull.js';

// Water in her.
//
// The old model was a number per compartment that went up at a fixed rate while
// a `breach` flag was set, and came out the far end as a single ship-wide
// fraction that scaled the buoyancy at each probe. It could put her down by the
// head and it could sink her, and that was the whole of it.
//
// This one is water. Every hole is a hole at a place, with an area; water goes
// through it at the rate the head across it says, in or *out*; what gets in
// fills the compartment from the bottom; and the result is a mass of water at
// the place that water actually is, handed to the buoyancy solver as a load.
// Everything people mean by "realistic flooding" then happens on its own:
//
//   * She lists toward the damage, because the water is on that side.
//   * Listing puts more holes under and lifts others clear, so the flooding
//     accelerates in the direction she was hit, and holes on the high side
//     spout water back out as she rolls.
//   * Half-full compartments cost her stability, because the water's centroid
//     runs to the low side as she heels — the free-surface effect, which for
//     one flooded machinery space on this ship is worth about two metres of
//     metacentric height, and is not something you would ever think to write in
//     by hand.
//   * When the deck edge goes under she down-floods through every opening in
//     it, which is the thing that actually finishes ships and is why the last
//     part of a sinking is so much faster than the first.
//
// None of those is a rule in this file. They are all consequences of putting
// the water where it is.
//
// Volumes come from the same section curves the hull was lofted from, clipped
// by the tilted water line, so they are the volumes of *this* hull and not of a
// box with her dimensions.

const RHO = 1025;
const G = 9.81;
const NR = 23;
const STATIONS = 9; // per compartment

// --- section polygons --------------------------------------------------------
// The enclosed area of a station, as a closed polygon: the loft curve from the
// port sheer round through the keel to the starboard sheer, closed across the
// deck.
function sectionPolygon(s) {
  const xs = new Float64Array(NR + 1);
  const ys = new Float64Array(NR + 1);
  for (let j = 0; j < NR; j++) {
    const p = section(s, j / (NR - 1));
    xs[j] = p[0];
    ys[j] = p[1];
  }
  xs[NR] = xs[0];
  ys[NR] = ys[0];
  return { xs, ys, n: NR };
}

// Clip a polygon to the half-plane below the line y = c + a x, and return the
// wet area, its centroid, and the width of the cut. Sutherland-Hodgman, then
// the shoelace formula: twenty-odd points, and it is the only thing in this
// file that runs per station per frame.
const _cx = new Float64Array(64);
const _cy = new Float64Array(64);
function clipBelow(poly, a, c, out) {
  const { xs, ys, n } = poly;
  let m = 0;
  let px = xs[n - 1];
  let py = ys[n - 1];
  let pd = py - (c + a * px);
  for (let i = 0; i < n; i++) {
    const qx = xs[i];
    const qy = ys[i];
    const qd = qy - (c + a * qx);
    if (qd <= 0) {
      if (pd > 0) {
        const t = pd / (pd - qd);
        _cx[m] = px + (qx - px) * t;
        _cy[m] = py + (qy - py) * t;
        m++;
      }
      _cx[m] = qx; _cy[m] = qy; m++;
    } else if (pd <= 0) {
      const t = pd / (pd - qd);
      _cx[m] = px + (qx - px) * t;
      _cy[m] = py + (qy - py) * t;
      m++;
    }
    px = qx; py = qy; pd = qd;
    if (m > 60) break;
  }
  if (m < 3) { out.area = 0; out.cx = 0; out.cy = 0; out.width = 0; return; }
  let area2 = 0;
  let sx = 0;
  let sy = 0;
  let minCut = Infinity;
  let maxCut = -Infinity;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const cr = _cx[i] * _cy[j] - _cx[j] * _cy[i];
    area2 += cr;
    sx += (_cx[i] + _cx[j]) * cr;
    sy += (_cy[i] + _cy[j]) * cr;
    // points sitting on the cut line are the waterline of this section
    if (Math.abs(_cy[i] - (c + a * _cx[i])) < 1e-6) {
      if (_cx[i] < minCut) minCut = _cx[i];
      if (_cx[i] > maxCut) maxCut = _cx[i];
    }
  }
  const area = Math.abs(area2) * 0.5;
  out.area = area;
  if (area > 1e-6) {
    out.cx = sx / (3 * area2);
    out.cy = sy / (3 * area2);
  } else { out.cx = 0; out.cy = 0; }
  out.width = maxCut > minCut ? maxCut - minCut : 0;
}

const _clip = { area: 0, cx: 0, cy: 0, width: 0 };

export function createFlooding() {
  const compartments = [];

  for (const cpt of COMPARTMENTS) {
    const polys = [];
    const zs = [];
    let dz = 0;
    for (let i = 0; i < STATIONS; i++) {
      const s = cpt.s[0] + ((cpt.s[1] - cpt.s[0]) * (i + 0.5)) / STATIONS;
      polys.push(sectionPolygon(s));
      zs.push((s - 0.5) * SHIP.length);
    }
    dz = ((cpt.s[1] - cpt.s[0]) * SHIP.length) / STATIONS;
    const mid = (cpt.s[0] + cpt.s[1]) / 2;

    // the volume it can hold, taken off the same polygons with a level plane
    let vmax = 0;
    for (const p of polys) {
      clipBelow(p, 0, 1e4, _clip);
      vmax += _clip.area * dz;
    }

    compartments.push({
      id: cpt.id,
      s: cpt.s,
      polys,
      zs,
      dz,
      vmax,
      deckY: deckAt(mid),
      keelY: -keelAt(mid),
      zMid: (mid - 0.5) * SHIP.length,
      // the low corner of the weather deck at this compartment, both sides:
      // where she starts down-flooding once it is under
      edge: [
        { x: sideAt(mid, deckAt(mid) - 0.05), y: deckAt(mid), z: (mid - 0.5) * SHIP.length },
        { x: -sideAt(mid, deckAt(mid) - 0.05), y: deckAt(mid), z: (mid - 0.5) * SHIP.length },
      ],
      sill: deckAt(cpt.s[1]) - 0.6, // bulkhead top, for spilling into the next one
      volume: 0,
      level: -1e4, // world height of the water surface inside
      plane: new Vector3(0, 0, -1e4), // (a, b, c) — that surface in the ship's frame
      waterplane: 0,
      centroid: new Vector3(),
      inflow: 0,
      holes: [],
      wrecked: false,
    });
  }

  const byId = new Map(compartments.map((c) => [c.id, c]));
  const _p = new Vector3();
  const _w = new Vector3();
  const loads = [];
  const state = { flood: 0, floodZ: 0, tons: 0, foundered: false, holes: 0 };

  // --- holes ------------------------------------------------------------------
  // A wound that reaches the skin makes one. The area is the shell's, not the
  // crater's: a burst tears a big ragged patch of plating but what the sea
  // actually comes through is the hole in it.
  function addHole(cptId, point, area, r = 0.35) {
    const c = byId.get(cptId);
    if (!c) return null;
    // merge with an existing hole close by, so a salvo into one frame is one
    // wound in the plating rather than six
    for (const h of c.holes) {
      if (h.p.distanceToSquared(point) < 16) {
        h.area = Math.min(h.area + area * 0.55, 140);
        h.r = Math.max(h.r, r);
        return h;
      }
    }
    // `r` is how far it reaches above and below its centre. A tear that
    // straddles the waterline is half a hole, and it is the half under that
    // counts.
    const h = { p: point.clone(), area, r, cpt: c };
    c.holes.push(h);
    if (c.holes.length > 14) c.holes.shift();
    return h;
  }

  // A wrecked compartment is open to the sea over its whole side; there is no
  // plating left to be a hole in.
  function wreck(cptId) {
    const c = byId.get(cptId);
    if (!c || c.wrecked) return;
    c.wrecked = true;
    c.holes.push({
      p: new Vector3(0, c.keelY + 1.5, c.zMid),
      area: 90,
      // open over her whole side, so the band is her whole depth
      r: (c.deckY - c.keelY) * 0.5,
      cpt: c,
      gash: true,
    });
  }

  // --- the step ---------------------------------------------------------------
  //
  // `frame` is where the ship is; `sea` the plane the buoyancy solver fitted to
  // her probes this step. Both are needed because every head in here is the
  // difference between two water levels measured in the *world*, on a hull that
  // is rolling.
  function update(dt, { position, quaternion, sea, dcEffort = 1 } = {}) {
    if (!position) return state;
    const e = quaternion.clone();
    // rows of the rotation matrix we need: world y of a ship-local point is
    // py + R10 x + R11 y + R12 z
    const { x: qx, y: qy, z: qz, w: qw } = e;
    const R10 = 2 * (qx * qy + qz * qw);
    const R11 = 1 - 2 * (qx * qx + qz * qz);
    const R12 = 2 * (qy * qz - qx * qw);
    const invR11 = 1 / (Math.abs(R11) < 0.15 ? Math.sign(R11 || 1) * 0.15 : R11);

    const seaAt = (x, z) => sea.height + sea.slopeX * (x - sea.originX) + sea.slopeZ * (z - sea.originZ);
    const worldY = (p) => position.y + R10 * p.x + R11 * p.y + R12 * p.z;
    const toWorld = (p, out) => out.copy(p).applyQuaternion(quaternion).add(position);

    loads.length = 0;
    let totalV = 0;
    let momentZ = 0;
    let holeCount = 0;

    for (const c of compartments) {
      // 1. where the water in this compartment is, written in her frame
      const a = -R10 * invR11;
      const b = -R12 * invR11;
      const cc = (c.level - position.y) * invR11;
      c.plane.set(a, b, cc);

      // 2. measure what that plane actually holds, and where it holds it
      let vol = 0;
      let wp = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let i = 0; i < c.polys.length; i++) {
        const z = c.zs[i];
        clipBelow(c.polys[i], a, cc + b * z, _clip);
        if (_clip.area <= 0) continue;
        const dv = _clip.area * c.dz;
        vol += dv;
        wp += _clip.width * c.dz;
        mx += _clip.cx * dv;
        my += _clip.cy * dv;
        mz += z * dv;
      }
      c.waterplane = wp;

      // 3. what went in or out through the holes this step
      //
      // A hole is a hole, not a point. Testing the head at its centre says a
      // four-metre tear whose bottom is a metre under and whose top is three
      // metres clear is *dry*, which is the difference between a ship taking
      // water through a rent in her side that you can watch the sea run into
      // and a ship serenely ignoring it. So each is a vertical band `2r` deep:
      // the part of it under the sea is what is open, and the head is measured
      // to the middle of that part.
      let q = 0;
      for (const h of c.holes) {
        toWorld(h.p, _w);
        const r = h.r || 0.35;
        const lo = _w.y - r;
        const span = 2 * r;
        const sea = seaAt(_w.x, _w.z);
        // how much of it the sea is over, and how much the water inside is over
        const fOut = Math.max(0, Math.min(1, (sea - lo) / span));
        const fIn = Math.max(0, Math.min(1, (c.level - lo) / span));
        // mean head over the wetted strip: the surface, less the middle of it
        const hOut = fOut > 0 ? sea - (lo + 0.5 * fOut * span) : 0;
        const hIn = fIn > 0 ? c.level - (lo + 0.5 * fIn * span) : 0;
        const dh = hOut - hIn;
        h.wet = fOut > 0;
        h.flow = dh;
        h.open = Math.max(fOut, fIn); // the share of it that is actually a hole
        if (Math.abs(dh) < 1e-3) continue;
        // Torricelli through a sharp-edged orifice, either way round. The "out"
        // case is not a nicety: a compartment flooded above a hole that the roll
        // has lifted clear pours back over the side, which is a thing you can
        // watch happen on a listing ship.
        q += Math.sign(dh) * FLOODING.cd * h.area * h.open * Math.sqrt(2 * G * Math.abs(dh))
          * FLOODING.scale;
        if (hOut > 0) holeCount++;
      }

      // 4. down-flooding: once the deck edge over this compartment is under,
      // she is open through hatches, trunks and ventilators, and the sinking
      // stops being gradual
      c.downflood = 0;
      for (const ed of c.edge) {
        _p.set(ed.x, ed.y, ed.z);
        toWorld(_p, _w);
        const under = seaAt(_w.x, _w.z) - _w.y;
        if (under > 0) {
          c.downflood += FLOODING.cd * FLOODING.downfloodArea * Math.sqrt(2 * G * under);
        }
      }
      q += c.downflood * FLOODING.scale;

      // 5. pumps. They lose, and they are supposed to.
      if (vol > 0) q -= FLOODING.pump * dcEffort * (c.wrecked ? 0 : 1);

      c.inflow = q;
      c.volume = Math.max(0, Math.min(c.vmax, c.volume + q * dt));

      // 6. move the surface to match the volume. The waterplane area is dV/dY,
      // so this is one Newton step and it converges immediately; the measured
      // volume from step 2 is what keeps it from drifting.
      const dv = c.volume - vol;
      if (c.volume <= 0) {
        c.level = worldY(_p.set(0, c.keelY - 0.5, c.zMid));
      } else if (wp > 1) {
        c.level += dv / wp;
      } else {
        c.level += Math.sign(dv) * 0.25 * dt;
      }
      // never above her deck, never below her keel
      const top = worldY(_p.set(0, c.deckY, c.zMid));
      const bot = worldY(_p.set(0, c.keelY - 0.5, c.zMid));
      if (c.level > top) c.level = top;
      if (c.level < bot) c.level = bot;

      // 7. the load on the ship: the mass of that water, at the place it is.
      // This one line is where trim, list and the free-surface loss of
      // stability all come from — none of them is modelled separately.
      if (vol > 1) {
        c.centroid.set(mx / vol, my / vol, mz / vol);
        loads.push({ mass: vol * RHO, r: c.centroid });
      } else {
        c.centroid.set(0, c.keelY, c.zMid);
      }
      totalV += c.volume;
      momentZ += c.volume * (c.zMid / SHIP.length);
    }

    // 8. spilling over the bulkheads, in the order they stand
    for (let i = 0; i < compartments.length - 1; i++) {
      const A = compartments[i];
      const B = compartments[i + 1];
      const sillY = worldY(_p.set(0, Math.min(A.sill, B.sill), (A.zMid + B.zMid) / 2));
      const hi = A.level > B.level ? A : B;
      const lo = hi === A ? B : A;
      const over = hi.level - sillY;
      if (over <= 0 || hi.volume <= 0) continue;
      const q = FLOODING.cd * FLOODING.spillArea * Math.sqrt(2 * G * over) * dt;
      const moved = Math.min(q, hi.volume, lo.vmax - lo.volume);
      hi.volume -= moved;
      lo.volume += moved;
    }

    const vtot = compartments.reduce((a, c) => a + c.vmax, 0);
    state.flood = totalV / vtot;
    state.floodZ = totalV > 0 ? momentZ / totalV : 0;
    state.tons = (totalV * RHO) / 1000;
    state.holes = holeCount;
    state.foundered = state.flood > 0.92;
    return state;
  }

  function repair() {
    for (const c of compartments) {
      c.volume = 0;
      c.level = -1e4;
      c.holes.length = 0;
      c.wrecked = false;
      c.inflow = 0;
      c.plane.set(0, 0, -1e4);
    }
    loads.length = 0;
    state.flood = 0;
    state.floodZ = 0;
    state.tons = 0;
    state.foundered = false;
  }

  // Open every compartment at once — the "watch her go down" key.
  function scuttle() {
    for (const c of compartments) {
      addHole(c.id, new Vector3(0, c.keelY + 1.0, c.zMid), 8, 1.2);
    }
  }

  return {
    compartments, byId, update, addHole, wreck, repair, scuttle,
    loads,
    state,
    get(id) { return byId.get(id); },
  };
}
