import { Vector3 } from 'three/webgpu';
import { SHIP, SUPER, TURRETS, TURRET_SPEC, AA_MOUNTS } from './spec.js';
import {
  deckAt, keelAt, sideAt, deckY, zOf, INNER_DECKS, PLATING,
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

export function boxHit(p, c, h, n) {
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

export function createColliders({
  mounts = null, alive = () => true, extra = [],
  // `removed(x, y, z)` -> 0..1 of the material at that point that a shell has
  // taken away. The damage field's own answer, so a hole is a hole to physics
  // as well as to the shader. Null leaves her whole.
  removed = null,
} = {}) {
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

  // --- the towers -------------------------------------------------------------
  // The pagoda's levels and the mainmast's platforms are not written out here.
  // They come in through `extra`, from the builders that drew them — see
  // `solidList` in superstructure.js for why. What used to be here was the
  // column and the two base blockhouses and nothing else, which meant a tower
  // seventeen metres across was four metres across to anything falling on it.
  for (const sh of extra) {
    if (sh.kind === 'box') {
      box(sh.id, sh.c[0], sh.c[1], sh.c[2], sh.h[0], sh.h[1], sh.h[2],
        sh.needs ? { needs: sh.needs } : {});
    } else {
      cyl(sh.id, new Vector3(...sh.base), new Vector3(...sh.axis), sh.len, sh.r,
        sh.needs ? { needs: sh.needs } : {});
    }
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

  // --- the mainmast tripod ----------------------------------------------------
  // The legs, which stay up whatever happens to what is standing on them — so,
  // like the pagoda, always here. What stands on them comes in through `extra`
  // and answers to its own fitting.
  {
    const M = SUPER.mainmast;
    cyl('mainmast',
      new Vector3(0, deckY(SUPER.aftSuper.z) + SUPER.aftSuper.h, zOf(M.z)),
      new Vector3(0, 1, 0), M.h * 0.72, 1.4);
  }

  // --- turrets ----------------------------------------------------------------
  // The gunhouse turns, so its box is tested in the turret's own frame: the
  // point is spun back by the mount's current yaw before the box test. That is
  // one sin/cos per turret per query and it is what stops a piece of wreckage
  // resting on thin air after the turret has trained out from under it.
  for (const t of TURRETS) {
    const y0 = deckY(t.z) + t.deckRise;
    // The barbette, as one solid drum from the deck to the gunhouse.
    //
    // `barbette` marks it because on a superfiring turret it is not solid to
    // everybody. B and X carry a working chamber inside the bandstand this drum
    // stands in the middle of, and a man is meant to walk in through it — so the
    // player skips this shape and gets the room, its walls and its trunk from
    // deckAccess instead, which is the same pair the gunhouse door already works
    // by. Everything else — a falling mast, a bay of guardrail, the camera —
    // still wants the drum, because to them a barbette is exactly what it looks
    // like.
    cyl(t.id, new Vector3(0, deckY(t.z), zOf(t.z)), new Vector3(0, 1, 0),
      t.deckRise, TURRET_SPEC.barbetteR, { barbette: true, bandstand: t.bandstand > 0 });
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

  // --- wreckage lying on her --------------------------------------------------
  //
  // A piece that has come to rest is frozen into the ship's frame, and the ship's
  // frame is the frame every shape here is written in — so from that moment it is
  // simply one more box in the list, and the next thing to come down lands on top
  // of it instead of through it. Taken out again the moment it wakes or is
  // retired.
  //
  // The box is axis-aligned in her frame, so a piece lying at an angle is
  // approximated generously. That is the right way round for something meant to
  // be walked round rather than through.
  const bodyShapes = new Map();

  function removeBody(key) {
    const sh = bodyShapes.get(key);
    if (!sh) return;
    const i = shapes.indexOf(sh);
    if (i >= 0) shapes.splice(i, 1);
    bodyShapes.delete(key);
  }

  function addBody(key, c, h) {
    removeBody(key);
    const sh = {
      kind: 'box',
      id: 'wreckage',
      owner: key, // so a body never contacts its own shape
      c: c.clone(),
      h: h.clone(),
      min: new Vector3().subVectors(c, h),
      max: new Vector3().addVectors(c, h),
    };
    bodyShapes.set(key, sh);
    shapes.push(sh);
    grow(sh.min.x, sh.min.y, sh.min.z, sh.max.x, sh.max.y, sh.max.z);
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
  const _hn = new Vector3();

  // The hull itself, from the curves it was lofted from.
  //
  // She is a *shell with decks in her*, not a solid. She used to be solid: any
  // point inside the loft was inside the ship, and the push-out was toward
  // whichever of the weather deck or the side was nearer. That is exactly right
  // for the only question anyone was asking of it — where does a falling funnel
  // stop — and it is useless for the question being asked now, which is what is
  // at the bottom of a hole in her. A solid has nothing at the bottom of a hole;
  // it has *more solid*, at whatever depth the crater happened to stop, floating
  // above the deck you can plainly see down there.
  //
  // So what is solid is her plating and her decks, and the spaces between them
  // are spaces. A piece that comes down on the weather deck still stops on the
  // weather deck; a piece that comes down through a shell hole in it now falls
  // into the compartment and lands on the deck below, which is the one you are
  // looking at. See INNER_DECKS in hull.js — interior.js draws those same three
  // surfaces, so what you stand on and what you see are the same thing.
  //
  // And where a shell has taken the material away, there is nothing here at all:
  // the field that decides whether the shader draws a fragment is the same one
  // that decides whether this reports a surface, so a hole is a hole to both.
  // Her plating is solid this deep, which is PLATING — the same depth
  // interior.js draws the backing at, so the floor of a chip in her is where it
  // looks like it is. It doubles as the depth a fast arrival may bury itself
  // and still be put back on top.
  // Solid to the backing at least, and to a metre and a half whatever the
  // backing is at: this doubles as the depth a fast arrival may bury itself in
  // her and still be put back on top, and a shallow chip is not much of a catch.
  const PLATE_T = Math.max(PLATING, 1.4);
  const DECK_T = 0.45; // a deck inside her, which does have two sides to it

  function hullHit(p, out) {
    const s = p.z / SHIP.length + 0.5;
    if (s <= 0.002 || s >= 0.998) return 0;
    const top = deckAt(s);
    const bottom = -keelAt(s);
    if (p.y > top || p.y < bottom) return 0;
    const half = sideAt(s, p.y);
    const ax = Math.abs(p.x);
    if (ax > half) return 0;
    if (removed !== null && removed(p.x, p.y, p.z) > 0.5) return 0;

    // Nearest way out. Zero means it is in none of them, which is to say it is
    // in a compartment and there is nothing there to hold it up.
    let best = Infinity;
    const consider = (d, nx, ny, nz) => {
      if (d >= 0 && d < best) { best = d; _hn.set(nx, ny, nz); }
    };

    // Her side and her weather deck push one way only, and that matters more
    // than it looks. Treat the deck as a slab with two faces and anything that
    // arrives fast enough to bury itself past the middle of it comes out of the
    // *bottom* — the nearest way out is downward — so a bay of guardrail
    // dropped from the foretop is quietly posted through her deck into the
    // machinery spaces. Plating is thin; the thickness here is only how deep a
    // fast arrival may be caught and put back. So the deck pushes up, the side
    // pushes outboard, and neither ever pushes the other way.
    const sx = Math.sign(p.x) || 1;
    const dSide = half - ax;
    if (dSide < PLATE_T) consider(dSide, sx, 0, 0);
    const dTop = top - p.y;
    if (dTop < PLATE_T) consider(dTop, 0, 1, 0);

    // The decks inside her are the other case: a thin floor with a space above
    // it and a space below it, so it holds from either side. Only the inner
    // bottom is one of these now — the backing under her weather deck is the
    // underside of the plating slab above, and taking it twice would have the
    // two fighting each other over the same metre.
    for (let i = 0; i < INNER_DECKS.length; i++) {
      const y = INNER_DECKS[i](s);
      const above = p.y - y;
      if (above >= 0) { if (above < DECK_T) consider(above, 0, 1, 0); } else if (above > -DECK_T) {
        consider(DECK_T + above, 0, -1, 0);
      }
    }
    if (best === Infinity) return 0;
    out.copy(_hn);
    return best;
  }

  // Deepest penetration among everything, in the ship's frame. `out.normal` is
  // the direction to push back along, `out.id` what was hit.
  // `ignore` is a resting body's own key: whatever it is, it is not standing on
  // itself. `skip` is a predicate over the shapes, for a caller that needs a
  // different answer than everyone else — the player wants a gunhouse with a
  // door in it rather than the solid block a falling mast needs.
  function query(p, out, ignore = null, skip = null) {
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
      if (sh.owner !== undefined && sh.owner === ignore) continue;
      if (skip && skip(sh)) continue;
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

  return {
    query, insideHull, nearBounds, bounds, setStump, clearStumps, shapes,
    addBody, removeBody,
    clearBodies() { for (const key of [...bodyShapes.keys()]) removeBody(key); },
  };
}
