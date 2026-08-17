import { Vector3 } from 'three/webgpu';
import { SHIP, SUPER, TURRETS, TURRET_SPEC, AA_MOUNTS } from './spec.js';
import {
  deckAt, keelAt, sideAt, deckY, zOf,
} from './hull.js';

// What a falling piece of ship can land on.
//
// Everything here is analytic and lives in the ship's own frame, because the
// ship is already described analytically — the hull is a loft of four curves,
// the deckhouses are boxes with numbers in spec.js — and a mesh-accurate
// collider would be both slower and *less* faithful than the curves the mesh
// was lofted from. There is no broadphase and no body-body contact: a piece of
// wreckage hits the ship, and the ship is the only thing it hits. Two funnels
// bouncing off each other is not a thing that needs to be simulated.
//
// Each shape carries the component id it belongs to, so a mast coming down
// across an AA tub damages the AA mount rather than "the ship".
//
// Two levels of rejection keep this free even with a deck full of wreckage on
// it. Every shape carries a box that contains it, tested with six compares
// before any of the real maths; and the whole ship carries one, so a piece that
// has gone over the side answers "nothing to hit" for its entire fall without
// ever looking at a shape. Both boxes are conservative — a shape is always
// inside its own box, and a severed funnel's box is still the whole funnel's —
// so neither can produce a false miss.

const _p = new Vector3();

// --- shape primitives --------------------------------------------------------
// Each returns the penetration depth (> 0 when the point is inside) and writes
// the outward surface normal into `n`.

function boxHit(p, c, h, n) {
  const dx = h.x - Math.abs(p.x - c.x);
  if (dx <= 0) return 0;
  const dy = h.y - Math.abs(p.y - c.y);
  if (dy <= 0) return 0;
  const dz = h.z - Math.abs(p.z - c.z);
  if (dz <= 0) return 0;
  // out along the nearest face
  if (dy <= dx && dy <= dz) { n.set(0, Math.sign(p.y - c.y) || 1, 0); return dy; }
  if (dx <= dz) { n.set(Math.sign(p.x - c.x) || 1, 0, 0); return dx; }
  n.set(0, 0, Math.sign(p.z - c.z) || 1);
  return dz;
}

// An upright cylinder, or a raked one: `axis` is a unit vector, `len` the run
// along it from `base`.
function cylinderHit(p, base, axis, len, r, n) {
  const vx = p.x - base.x; const vy = p.y - base.y; const vz = p.z - base.z;
  const t = vx * axis.x + vy * axis.y + vz * axis.z;
  if (t < 0 || t > len) return 0;
  const rx = vx - axis.x * t; const ry = vy - axis.y * t; const rz = vz - axis.z * t;
  const d = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (d >= r) return 0;
  // out sideways, unless it is nearer to the end cap
  const cap = Math.min(t, len - t);
  if (cap < r - d) { n.copy(axis).multiplyScalar(t < len - t ? -1 : 1); return cap; }
  if (d < 1e-4) { n.set(1, 0, 0); return r; }
  n.set(rx / d, ry / d, rz / d);
  return r - d;
}

export function createColliders({ mounts = null, alive = () => true } = {}) {
  const shapes = [];

  const box = (id, cx, cy, cz, hx, hy, hz, opts = {}) => shapes.push({
    kind: 'box', id, c: new Vector3(cx, cy, cz), h: new Vector3(hx, hy, hz), ...opts,
  });
  const cyl = (id, base, axis, len, r, opts = {}) => shapes.push({
    kind: 'cyl', id, base, axis, len, r, ...opts,
  });

  // --- the deckhouses ---------------------------------------------------------
  const D = SUPER.funnelDeck;
  box('hull.mid', 0, deckY(D.z) + D.h / 2, zOf(D.z), D.w / 2, D.h / 2, D.l / 2);
  const A = SUPER.aftSuper;
  box('hull.aft', 0, deckY(A.z) + A.h / 2, zOf(A.z), A.w / 2, A.h / 2, A.l / 2);

  // --- the bridge -------------------------------------------------------------
  {
    const z0 = zOf(SUPER.bridge.z);
    const y0 = deckY(SUPER.bridge.z);
    box('bridge', 0, y0 + 2.0, z0 - 1.0, 8.5, 2.0, 10.5, { needs: 'bridge' });
    box('bridge', 0, y0 + 5.7, z0, 6.5, 1.7, 7.5, { needs: 'bridge' });
    cyl('bridge', new Vector3(0, y0 + 7.4, z0 - 0.5), new Vector3(0, 1, 0), 33, 4.4,
      { needs: 'bridge', severable: true });
  }

  // --- the funnel -------------------------------------------------------------
  {
    const F = SUPER.funnel;
    const rake = (F.rake * Math.PI) / 180;
    cyl('funnel',
      new Vector3(0, deckY(F.z) + SUPER.funnelDeck.h, zOf(F.z)),
      new Vector3(0, Math.cos(rake), -Math.sin(rake)), F.h, F.rx,
      { needs: 'funnel', severable: true });
  }

  // --- the mainmast -----------------------------------------------------------
  {
    const M = SUPER.mainmast;
    cyl('mainmast',
      new Vector3(0, deckY(SUPER.aftSuper.z) + SUPER.aftSuper.h, zOf(M.z)),
      new Vector3(0, 1, 0), M.h * 0.72, 1.4,
      { needs: 'mainmast', severable: true });
  }

  // --- turrets ----------------------------------------------------------------
  // The gunhouse turns, so its box is tested in the turret's own frame: the
  // point is spun back by the mount's current yaw before the box test. That is
  // one sin/cos per turret per query and it is what stops a piece of wreckage
  // resting on thin air after the turret has trained out from under it.
  for (const t of TURRETS) {
    const y0 = deckY(t.z) + t.deckRise;
    cyl(t.id, new Vector3(0, deckY(t.z), zOf(t.z)), new Vector3(0, 1, 0),
      t.deckRise, TURRET_SPEC.barbetteR);
    shapes.push({
      kind: 'turret',
      id: t.id,
      mountId: t.id,
      c: new Vector3(0, y0 + TURRET_SPEC.gunhouseH / 2, zOf(t.z)),
      h: new Vector3(TURRET_SPEC.gunhouseW / 2, TURRET_SPEC.gunhouseH / 2, TURRET_SPEC.gunhouseL / 2),
      needs: t.id,
    });
  }

  // --- AA tubs ----------------------------------------------------------------
  for (const a of AA_MOUNTS) {
    if (a.on === 'turret.B') continue; // rides on the turret; the turret box has it
    let y = deckY(a.z);
    if (a.on === 'aftSuper') y = deckY(SUPER.aftSuper.z) + SUPER.aftSuper.h;
    else if (a.on === 'funnelDeck') y = deckY(SUPER.funnelDeck.z) + SUPER.funnelDeck.h;
    cyl(a.id, new Vector3(a.x * SHIP.halfBeam, y, zOf(a.z)), new Vector3(0, 1, 0),
      2.2, 1.9, { needs: a.id });
  }

  // --- the boxes everything is rejected against -------------------------------
  // Built once, after the shape list is complete. A turret's box is the one it
  // sweeps as it trains — its half-diagonal in plan — so it stays valid at any
  // bearing without being rebuilt.
  const bounds = {
    min: new Vector3(Infinity, Infinity, Infinity),
    max: new Vector3(-Infinity, -Infinity, -Infinity),
  };
  const grow = (x0, y0, z0, x1, y1, z1) => {
    if (x0 < bounds.min.x) bounds.min.x = x0;
    if (y0 < bounds.min.y) bounds.min.y = y0;
    if (z0 < bounds.min.z) bounds.min.z = z0;
    if (x1 > bounds.max.x) bounds.max.x = x1;
    if (y1 > bounds.max.y) bounds.max.y = y1;
    if (z1 > bounds.max.z) bounds.max.z = z1;
  };
  for (const sh of shapes) {
    if (sh.kind === 'box') {
      sh.min = new Vector3().subVectors(sh.c, sh.h);
      sh.max = new Vector3().addVectors(sh.c, sh.h);
    } else if (sh.kind === 'cyl') {
      const tip = _p.copy(sh.base).addScaledVector(sh.axis, sh.len);
      sh.min = new Vector3(
        Math.min(sh.base.x, tip.x) - sh.r,
        Math.min(sh.base.y, tip.y) - sh.r,
        Math.min(sh.base.z, tip.z) - sh.r,
      );
      sh.max = new Vector3(
        Math.max(sh.base.x, tip.x) + sh.r,
        Math.max(sh.base.y, tip.y) + sh.r,
        Math.max(sh.base.z, tip.z) + sh.r,
      );
    } else {
      const R = Math.hypot(sh.h.x, sh.h.z); // whatever way it is trained
      sh.min = new Vector3(-R, sh.c.y - sh.h.y, sh.c.z - R);
      sh.max = new Vector3(R, sh.c.y + sh.h.y, sh.c.z + R);
    }
    grow(sh.min.x, sh.min.y, sh.min.z, sh.max.x, sh.max.y, sh.max.z);
  }
  // and the hull itself, walked along its own loft
  {
    let top = -Infinity;
    let bot = Infinity;
    for (let i = 0; i <= 40; i++) {
      const s = i / 40;
      top = Math.max(top, deckAt(s));
      bot = Math.min(bot, -keelAt(s));
    }
    grow(-SHIP.halfBeam, bot, -SHIP.length / 2, SHIP.halfBeam, top, SHIP.length / 2);
  }

  // Can a body of this radius, centred here in the ship's frame, be touching any
  // part of her? The one question worth asking before the contact solve.
  function nearBounds(x, y, z, r) {
    return x + r > bounds.min.x && x - r < bounds.max.x
      && y + r > bounds.min.y && y - r < bounds.max.y
      && z + r > bounds.min.z && z - r < bounds.max.z;
  }

  const _n = new Vector3();
  const _q = new Vector3();

  // The hull itself, from the curves it was lofted from. Two surfaces matter:
  // the weather deck a thing lands on, and the side it slides off over.
  function hullHit(p, out) {
    const s = p.z / SHIP.length + 0.5;
    if (s <= 0.002 || s >= 0.998) return 0;
    const top = deckAt(s);
    const bottom = -keelAt(s);
    if (p.y > top || p.y < bottom) return 0;
    const half = sideAt(s, p.y);
    const ax = Math.abs(p.x);
    if (ax > half) return 0;
    const dTop = top - p.y;
    const dSide = half - ax;
    if (dTop <= dSide) { out.set(0, 1, 0); return dTop; }
    out.set(Math.sign(p.x) || 1, 0, 0);
    return dSide;
  }

  // Deepest penetration among everything, in the ship's frame. `out.normal` is
  // the direction to push back along, `out.id` what was hit.
  function query(p, out) {
    let best = 0;
    let bestId = null;
    // the hull
    const dh = hullHit(p, _n);
    if (dh > best) { best = dh; bestId = null; out.normal.copy(_n); }

    for (let i = 0; i < shapes.length; i++) {
      const sh = shapes[i];
      if (p.x < sh.min.x || p.x > sh.max.x) continue;
      if (p.y < sh.min.y || p.y > sh.max.y) continue;
      if (p.z < sh.min.z || p.z > sh.max.z) continue;
      if (sh.needs && !alive(sh.needs)) continue;
      let d = 0;
      if (sh.kind === 'box') {
        d = boxHit(p, sh.c, sh.h, _n);
      } else if (sh.kind === 'cyl') {
        let len = sh.len;
        if (sh.severable && sh.stump !== undefined) len = sh.stump;
        if (len <= 0.05) continue;
        d = cylinderHit(p, sh.base, sh.axis, len, sh.r, _n);
      } else {
        // a turret: spin the point back into the gunhouse's own frame
        const m = mounts && mounts.get(sh.mountId);
        const yaw = m ? m.yawPivot.rotation.y : 0;
        const cz = sh.c.z;
        const c = Math.cos(-yaw); const sn = Math.sin(-yaw);
        const dx = p.x; const dz = p.z - cz;
        _q.set(dx * c + dz * sn, p.y, -dx * sn + dz * c + cz);
        d = boxHit(_q, sh.c, sh.h, _n);
        if (d > 0) {
          // and the normal back out into the ship's frame
          const nx = _n.x; const nz = _n.z;
          _n.set(nx * c - nz * sn, _n.y, nx * sn + nz * c);
        }
      }
      if (d > best) { best = d; bestId = sh.id; out.normal.copy(_n); }
    }
    out.id = bestId;
    return best;
  }

  // Is this point inside the hull at all? Used to decide whether a piece is
  // still on board or has gone over the side.
  function insideHull(x, y, z) {
    const s = z / SHIP.length + 0.5;
    if (s <= 0 || s >= 1) return false;
    return y < deckAt(s) && y > -keelAt(s) && Math.abs(x) < sideAt(s, y);
  }

  // When a mast or a funnel is broken off partway up, what is left standing is
  // shorter — and a piece landing on the stump has to know that.
  function setStump(id, height) {
    for (const sh of shapes) if (sh.id === id && sh.severable) sh.stump = height;
  }
  function clearStumps() {
    for (const sh of shapes) if (sh.severable) delete sh.stump;
  }

  return { query, insideHull, nearBounds, bounds, setStump, clearStumps, shapes };
}
