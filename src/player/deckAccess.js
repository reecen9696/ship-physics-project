import { Vector3 } from 'three/webgpu';
import { boxHit } from '../battleship/colliders.js';
import { SUPER, TURRETS, TURRET_SPEC } from '../battleship/spec.js';
import { HOUSE } from '../battleship/turretHouse.js';
import { deckY, zOf } from '../battleship/hull.js';
import { deckPropSolids } from '../battleship/deckProps.js';
import { PLAYER } from './spec.js';

// Getting off the main deck.
//
// The ship's colliders describe what a falling funnel can land on and what the
// camera must stay out of. They do not describe how a person gets from the
// weather deck up onto the shelter deck, because until now nothing needed to.
// These boxes are that, and they are kept here rather than in colliders.js
// deliberately: wreckage and the camera should not start resting on a ladder.
//
// The treads are the invisible-ramp answer to stair stepping, in its cheapest
// form. Each tread is a solid pillar from below the deck up to its own height,
// no riser taller than `PLAYER.stepUp` — so the floor probe simply finds the
// next one and the player walks up without any stepping code existing at all.
// It never fails and never needs tuning. (The caution about invisible ramps
// being an authoring burden applies to procedural levels. This ship is
// hand-authored once.)
//
// A run comes out around 35 degrees, which is what a ship's ladder is.

const _n = new Vector3();
const _q = new Vector3();

const TREAD_RUN = 0.6; // m fore-and-aft per step

// One flight, as a stack of pillars. `x` is the centreline of the run, `zFoot`
// the outer edge of the bottom tread, and `dir` which way it climbs. The head of
// the flight is placed to overlap the deck it lands on, so there is no gap at
// the top for a capsule to drop through.
function flight(boxes, {
  id, x, halfWidth, zFoot, dir, yFoot, yHead,
}) {
  const rise = yHead - yFoot;
  const treads = Math.max(1, Math.ceil(rise / (PLAYER.stepUp - 0.03)));
  const step = rise / treads;
  for (let i = 1; i <= treads; i++) {
    const top = yFoot + step * i;
    boxes.push({
      id,
      c: new Vector3(x, (yFoot - 1 + top) / 2, zFoot + dir * TREAD_RUN * (i - 0.5)),
      h: new Vector3(halfWidth, (top - yFoot + 1) / 2, TREAD_RUN / 2),
    });
  }
  return boxes;
}

export function createDeckAccess({ mounts = null, alive = () => true } = {}) {
  const boxes = [];
  const D = SUPER.funnelDeck;
  const A = SUPER.aftSuper;
  const shelter = deckY(D.z) + D.h; // top of the shelter deck round the funnel
  const aftTop = deckY(A.z) + A.h; // top of the after deckhouse

  // Main deck to the shelter deck, one ladder each side, right forward where
  // the shelter deck ends. Placed outboard of the bridge's base blockhouse
  // (half-width 8.5 m) and inboard of the rail, climbing aft so its head tread
  // overlaps the shelter deck's forward edge.
  {
    const HALF = 1.4;
    // Straddling the shelter deck's edge rather than hung off it, and far
    // enough in that a body at the head of the ladder is clear of the bulwark
    // below. Two failures were fixed by moving this one number: land the run
    // outboard of the edge and you walk straight off it again at the top, and
    // land it against the bulwark and its end cap stops you dead the moment you
    // try to walk past.
    const x = D.w / 2 - 0.9;
    const zEdge = zOf(D.z) + D.l / 2; // forward edge of the shelter deck
    for (const side of [-1, 1]) {
      flight(boxes, {
        id: 'ladder.shelter',
        x: side * x,
        halfWidth: HALF,
        zFoot: zEdge + 3.0,
        dir: -1,
        yFoot: deckY(D.z),
        yHead: shelter,
      });
    }
  }

  // A bulwark down each side of the shelter deck, from the ladder heads aft.
  // Same idea as the rail round the main deck: one invisible wall a hand's
  // breadth inboard of the edge, rather than any attempt to negotiate the
  // modelled guardrail. Without it the AA tubs — which are sponsons, sitting
  // flush with the deck edge — shoulder anyone walking past them straight off
  // the side, and a 2.5 m drop to the main deck is a poor answer to squeezing
  // past a gun. It leaves a genuine pinch abreast of the tubs, where there is
  // no side deck at all and you have to go inboard; that is the ship, not the
  // controller.
  {
    const top = shelter;
    const zAft = zOf(D.z) - D.l / 2;
    const zFwd = zOf(D.z) + D.l / 2 - 0.7; // clear of the ladder heads
    for (const side of [-1, 1]) {
      boxes.push({
        id: 'bulwark.shelter',
        c: new Vector3(side * (D.w / 2 - 0.1), top + 0.6, (zAft + zFwd) / 2),
        h: new Vector3(0.1, 0.6, (zFwd - zAft) / 2),
      });
    }
  }

  // Shelter deck up onto the after deckhouse, where the aft AA station is. It
  // stands on one house and lands on the other, which is possible only because
  // the two overlap fore-and-aft. Offset to starboard to clear the funnel.
  if (aftTop > shelter + 0.2) {
    flight(boxes, {
      id: 'ladder.aft',
      x: -5.4,
      halfWidth: 1.2,
      zFoot: zOf(A.z) + A.l / 2 + 3.0, // three treads forward of the house face
      dir: -1,
      yFoot: shelter,
      yHead: aftTop,
    });
  }

  // The main battery's barrels.
  //
  // The ship's own colliders stop at the gunhouse, because until now the only
  // question asked of them was what a falling mast lands on and a barrel is not
  // that. A person is a different question: sixteen metres of gun sticks out at
  // chest height over the forecastle, and without this you walk into the breech
  // and out through the muzzle. One box per turret covering both guns, tested in
  // the turret's own frame so it trains with her — standing under a gun that is
  // swinging over you should push you out of the way, and does.
  //
  // Elevation is ignored on purpose. The box is the barrels at rest, which is
  // where they spend their time, and when they are up the space in front of the
  // muzzles is not somewhere to stand either.
  for (const t of TURRETS) {
    const cz = zOf(t.z);
    const trunnionY = deckY(t.z) + t.deckRise + TURRET_SPEC.gunhouseH * 0.42;
    const reach = TURRET_SPEC.barrelLength;
    boxes.push({
      id: `${t.id}.guns`,
      turret: t.id,
      pivotZ: cz,
      c: new Vector3(0, trunnionY, cz + TURRET_SPEC.trunnionZ + reach / 2),
      h: new Vector3(
        TURRET_SPEC.barrelSpacing / 2 + TURRET_SPEC.barrelR * 2,
        TURRET_SPEC.barrelR * 2.2,
        reach / 2,
      ),
    });
  }

  // Up to the doors of the turrets that stand on the deck rather than on a
  // bandstand. A and Y sit a metre off it, which is two steps; B and X are four
  // metres up and are entered through their bandstands instead, at deck level,
  // so they need nothing here. See turretHouse.js.
  //
  // The flights are fixed to the ship and the doors turn with the guns, so they
  // line up at the turret's rest bearing and nowhere else. That is true of every
  // fixed ladder to a rotating structure, it is why the real answer is a trunk
  // inside the barbette, and it is why the way into a superfiring turret is one.
  for (const t of TURRETS) {
    if (t.bandstand > 0) continue;
    const facing = Math.abs(t.arcCenter) > 90 ? -1 : 1;
    const y0 = deckY(t.z);
    const top = y0 + t.deckRise + HOUSE.door.sill;
    if (top - y0 < PLAYER.stepUp) continue;
    for (const side of [-1, 1]) {
      flight(boxes, {
        id: `${t.id}.ladder`,
        x: side * (HOUSE.halfW + HOUSE.wall + 1.5),
        halfWidth: 1.1,
        zFoot: zOf(t.z) + facing * (HOUSE.door.z - 1.8),
        dir: facing,
        yFoot: y0,
        yHead: top,
      });
    }
  }

  // Everything lying about on the weather deck.
  //
  // These are here rather than in colliders.js for the reason at the head of
  // this file, and the reason is the same one: wreckage and the third-person
  // camera must not start resting on a crate. A falling funnel goes through the
  // drums, which nobody will ever see, and the camera does not shove itself
  // sideways every time it passes a vent cowl, which everybody would.
  //
  // Nothing here needs any handling of its own. A coaming is 0.25 m and
  // `PLAYER.stepUp` is 0.45, so the floor probe walks over it; a drum is 0.88
  // and the lowest wall sample is at 0.55, so it is a wall. That one comparison
  // is the whole of it — see the note on `wallHeights` in character.js.
  boxes.push(...deckPropSolids());

  for (const b of boxes) {
    if (b.turret) {
      // whatever way she is trained, in plan
      const R = Math.hypot(Math.abs(b.c.z - b.pivotZ) + b.h.z, b.h.x);
      b.min = new Vector3(-R, b.c.y - b.h.y, b.pivotZ - R);
      b.max = new Vector3(R, b.c.y + b.h.y, b.pivotZ + R);
      continue;
    }
    b.min = new Vector3().subVectors(b.c, b.h);
    b.max = new Vector3().addVectors(b.c, b.h);
  }

  // Same contract as colliders.query: penetration depth, outward normal in
  // `out.normal`, and what was hit in `out.id`.
  function query(p, out) {
    let best = 0;
    let bestId = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (p.x < b.min.x || p.x > b.max.x) continue;
      if (p.y < b.min.y || p.y > b.max.y) continue;
      if (p.z < b.min.z || p.z > b.max.z) continue;
      let d;
      if (b.turret) {
        if (!alive(b.turret)) continue; // shot away: the guns went with it
        const m = mounts && mounts.get(b.turret);
        const yaw = m ? m.yawPivot.rotation.y : 0;
        const c = Math.cos(-yaw); const s = Math.sin(-yaw);
        const dx = p.x; const dz = p.z - b.pivotZ;
        _q.set(dx * c + dz * s, p.y, -dx * s + dz * c + b.pivotZ);
        d = boxHit(_q, b.c, b.h, _n);
        if (d > 0) {
          const nx = _n.x; const nz = _n.z;
          _n.set(nx * c - nz * s, _n.y, nx * s + nz * c);
        }
      } else {
        d = boxHit(p, b.c, b.h, _n);
      }
      if (d > best) { best = d; bestId = b.id; out.normal.copy(_n); }
    }
    out.id = bestId;
    return best;
  }

  return { query, boxes };
}
