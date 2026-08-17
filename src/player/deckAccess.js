import { Vector3 } from 'three/webgpu';
import { boxHit } from '../battleship/colliders.js';
import { SHIP, SUPER, TURRETS, TURRET_SPEC } from '../battleship/spec.js';
import {
  HOUSE, chamberSolids, entryVolumes, houseShellSolids,
} from '../battleship/turretHouse.js';
import { deckY, zOf } from '../battleship/hull.js';
import { deckPropSolids } from '../battleship/deckProps.js';
import { wheelhouseStoop } from '../battleship/wheelhouse.js';
import { bridgeDoorways, ladderVolumes, platformTop } from '../battleship/bridgeAccess.js';
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

// How many deck props had to be made non-solid because they were standing in a
// doorway. Reported on `poseidon.firstPerson.access` so it is findable rather
// than silent — a number above zero means deckProps.js and the turret entries
// disagree about who owns that patch of deck.
export const blockedByProps = [];

// One flight, as a stack of pillars. `x` is the centreline of the run, `zFoot`
// the outer edge of the bottom tread, and `dir` which way it climbs. The head of
// the flight is placed to overlap the deck it lands on, so there is no gap at
// the top for a capsule to drop through.
function flight(boxes, {
  id, x, halfWidth, zFoot, dir, yFoot, yHead, landing = 0,
}) {
  const rise = yHead - yFoot;
  const treads = Math.max(1, Math.ceil(rise / (PLAYER.stepUp - 0.03)));
  const step = rise / treads;
  // Treads overlap by a few centimetres. Butted exactly, two of them share a
  // face — and a foot landing on that seam is inside neither, because every box
  // test here is a strict one. You fall between two steps of a ladder, which is
  // not a thing anybody would think to look for.
  const LAP = 0.04;
  for (let i = 1; i <= treads; i++) {
    const top = yFoot + step * i;
    boxes.push({
      id,
      c: new Vector3(x, (yFoot - 1 + top) / 2, zFoot + dir * TREAD_RUN * (i - 0.5)),
      h: new Vector3(halfWidth, (top - yFoot + 1) / 2, TREAD_RUN / 2 + LAP),
    });
  }
  // A grating at the head of it. Without somewhere to stand at the top, the last
  // tread is a place you arrive and immediately walk off the end of, which is
  // exactly what happened the first time — and there is nothing to see in the
  // trace that says so, because falling off a ladder and walking down a deck
  // look the same from here.
  if (landing > 0) {
    boxes.push({
      id,
      c: new Vector3(x, (yFoot - 1 + yHead) / 2,
        zFoot + dir * (TREAD_RUN * treads + landing / 2)),
      h: new Vector3(halfWidth, (yHead - yFoot + 1) / 2, landing / 2),
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

  // Up into the wheelhouse. The ladder trunk lets you out on the air-defence
  // platform, which is a metre or so under the wheelhouse's own deck, so there are
  // three treads outside each of her doors — the last of the climb from the weather
  // deck to the wheel. See wheelhouse.js, which owns where they go.
  boxes.push(...wheelhouseStoop({ platformTop: platformTop() }));

  // The gunhouses of the turrets that carry a room, as a shell with the door and
  // the window cut out of it rather than as the solid block the ship's own
  // colliders use. Tested in the turret's frame, so it trains with her.
  //
  // This is the other half of a pair: `firstPerson` tells the ship's space to
  // skip the solid turret shapes for the player, and these stand in their place.
  // Without both, either you cannot walk through a door you can see or you can
  // walk through the plating either side of it.
  for (const t of TURRETS) {
    if (t.bandstand > 0) continue; // B and X keep their solid house; their room is below
    const cz = zOf(t.z);
    const py = deckY(t.z) + t.deckRise;
    for (const b of houseShellSolids()) {
      boxes.push({
        id: `${t.id}.house`,
        turret: t.id,
        pivotZ: cz,
        c: new Vector3(b.c[0], b.c[1] + py, b.c[2] + cz),
        h: new Vector3(b.h[0], b.h[1], b.h[2]),
      });
    }
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

  // The bandstands, and the working chamber inside each of them.
  //
  // The ship's own colliders give a superfiring turret a barbette-radius drum
  // and nothing else, because until now the only question was what a falling
  // mast lands on and the drum is the load-bearing part of that answer. A person
  // wants the *block* to be there, the passage through it to be a passage, and
  // the room inside it to be a room — so all three come in here, from the one
  // description in turretHouse.js that the plating is drawn from.
  //
  // They are in the ship's frame and not a turret's, and that is the point: a
  // bandstand does not train. B and X are rooms in the ship exactly as the deck
  // is, which is why walking into one is walking, with nothing to hand you
  // anywhere. Only A and Y, whose rooms are up in the gunhouse, cross a space.
  //
  // Because the player skips the ship's drum entirely (see `skipShapes` in
  // firstPerson.js), the stretch of barbette it also stood for has to come in
  // here too: between the bandstand's roof and the gunhouse sitting on it there
  // is a metre or two of bare barbette, and without this you could stand on the
  // bandstand and walk into it. Square rather than round, which is the same
  // trade `chamber.trunk` beside it already makes — it is a metre of drum under
  // a gunhouse, and nobody is measuring its corners.
  for (const t of TURRETS) {
    if (!t.bandstand) continue;
    boxes.push(...chamberSolids(t));
    const roof = deckY(t.z) + t.bandstand;
    const under = deckY(t.z) + t.deckRise; // where the gunhouse starts
    if (under > roof + 0.05) {
      boxes.push({
        id: `${t.id}.barbette`,
        c: new Vector3(0, (roof + under) / 2, zOf(t.z)),
        h: new Vector3(TURRET_SPEC.barbetteR, (under - roof) / 2, TURRET_SPEC.barbetteR),
      });
    }
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
    const top = deckY(t.z) + t.deckRise + HOUSE.door.sill;
    const zFoot = zOf(t.z) + facing * (HOUSE.door.z - 1.8);
    // The deck under the *foot of the ladder*, not under the turret. She has five
    // metres of sheer over her forward third, so those are different numbers by
    // most of a step, and a flight that starts from the wrong one has a first
    // tread nobody can get onto.
    const yFoot = deckY(zFoot / SHIP.length);
    if (top - yFoot < PLAYER.stepUp) continue;
    for (const side of [-1, 1]) {
      flight(boxes, {
        id: `${t.id}.ladder`,
        // Overlapping the gunhouse skin, not standing off it. Set clear of the
        // plating there is a third of a metre of nothing between the head of
        // the ladder and the deck inside the door, and a man walking in drops
        // into it — which reads as the doorway itself being broken.
        x: side * (HOUSE.halfW + 0.9),
        halfWidth: 1.3,
        zFoot,
        dir: facing,
        yFoot,
        yHead: top,
        landing: 1.3,
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
  //
  // Minus anything standing in a doorway. deckProps.js places its own furniture
  // and checks its own clearances, but it does not know where the ways into the
  // turrets are, and a crate in front of X turret's passage is a turret nobody
  // can get into — which is invisible from anywhere except by trying it. The
  // proper home for this is deckProps' `assertClearance`; until it is taught
  // about the doorways, they are subtracted here.
  //
  // The way to the bridge is subtracted the same way and for the same reason: the
  // hallway through the pagoda's base and the trunk at the end of it are the only
  // route to the wheel, and a vent cowl standing in the doorway would close it.
  {
    const mouths = [
      ...TURRETS.flatMap((t) => entryVolumes(t, deckY, zOf)),
      ...bridgeDoorways(),
    ];
    const blocks = (b) => mouths.some((m) => Math.abs(b.c[0] - m.c.x) < b.h[0] + m.h.x + 0.8
      && Math.abs(b.c[2] - m.c.z) < b.h[2] + m.h.z + 0.8
      && b.c[1] - b.h[1] < m.c.y + m.h.y);
    let dropped = 0;
    for (const prop of deckPropSolids()) {
      const b = { c: [prop.c.x, prop.c.y, prop.c.z], h: [prop.h.x, prop.h.y, prop.h.z] };
      if (blocks(b)) { dropped++; continue; }
      boxes.push(prop);
    }
    if (dropped) blockedByProps.push(dropped);
  }

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

  return {
    query,
    boxes,
    // The one way up this ship that is not a flight of treads. It is a mode rather
    // than a shape — see `ladderAt` in character.js — so it rides alongside the
    // query rather than in it, and a body handed into a gunhouse (where `extra` is
    // null) cannot be on one.
    ladders: ladderVolumes(),
  };
}
