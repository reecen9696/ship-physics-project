import { Vector3 } from 'three/webgpu';
import { GRAVITY, PLAYER } from './spec.js';

// A person, simulated entirely in ship-local space.
//
// There is no rigid body and no solver. In a space where the geometry has zero
// velocity a character is a much smaller problem than the general one, and the
// general one is what character controllers are bad at. Three questions, asked
// in this order every frame:
//
//   1. what does gravity feel like here?   -> the inertial layer, shipSpace.js
//   2. is anything in the way sideways?    -> penetration push-out at three heights
//   3. what is under my feet?              -> a downward probe of the same field
//
// All three are answered by point queries against the analytic collision field
// the ship already carries for wreckage and the camera (battleship/colliders.js),
// plus the ladders in deckAccess.js. Nothing is meshed, nothing is swept, and
// there is no continuous collision detection anywhere — because there is nothing
// moving to tunnel through. That is the whole return on the two-space split.

const PROBE_STEP = 0.15; // m between samples of the downward floor probe
const BISECT = 7; // halvings to land on the surface: 0.15 / 2^7 ~= 1 mm

// Where the body is sampled for walls, as heights above the feet. The lowest is
// deliberately just above `stepUp`: anything shorter than that is not a wall at
// all, it is a coaming, and the floor probe walks over it. That one line is the
// whole of the stair-stepping logic.
const wallHeights = () => [
  PLAYER.stepUp + 0.1,
  PLAYER.height * 0.56,
  PLAYER.height - PLAYER.radius,
];
// centre plus the four compass points at capsule radius
const RING = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

export function createCharacter({ space: home, extra: homeExtra = null, spawn }) {
  // Which space this body is being simulated in. It can change — walking through
  // a gunhouse door moves you from the ship's frame into the turret's — and
  // everything below reads it rather than closing over it, because the whole
  // point of the architecture is that the character does not care which space it
  // is in, only that the geometry in it is holding still.
  let space = home;
  let extra = homeExtra;
  let colliders = space.colliders;
  let hull = space.hull;

  const pos = new Vector3().copy(spawn.position); // ship-local, at the feet
  const vel = new Vector3(); // ship-local
  const groundNormal = new Vector3(0, 1, 0);
  const _p = new Vector3();
  const _g = new Vector3();
  const _r = new Vector3();
  const _want = new Vector3();
  const _tmp = new Vector3();
  const _wall = new Vector3();
  const _hit = { normal: new Vector3(), id: null };

  const state = {
    heading: spawn.heading ?? 0, // radians; 0 faces the bow
    pitch: 0,
    grounded: false,
    standingOn: null,
    tilt: 0,
    coyote: 0, // seconds of jump left after walking off an edge
    jumpWanted: 0, // seconds a pressed jump stays remembered for
    knockdownUntil: 0,
    fly: false,
    overboard: 0, // times she has put us in the sea
  };

  // --- the collision field ----------------------------------------------------

  // Penetration depth at a point: the deeper of the ship and her ladders, with
  // the outward normal left in `_hit`. Both queries write into the same scratch,
  // so the ship's normal has to be saved before the ladders can overwrite it.
  function solidAt(x, y, z) {
    _p.set(x, y, z);
    const d = colliders.query(_p, _hit);
    if (!extra) return d;
    const nx = _hit.normal.x; const ny = _hit.normal.y; const nz = _hit.normal.z;
    const id = _hit.id;
    const e = extra.query(_p, _hit);
    if (e > d) return e;
    _hit.normal.set(nx, ny, nz);
    _hit.id = id;
    return d;
  }

  const inside = (x, y, z) => solidAt(x, y, z) > 0;

  function bisect(x, z, yIn, yOut) {
    let lo = yIn; let hi = yOut;
    for (let i = 0; i < BISECT; i++) {
      const m = (lo + hi) * 0.5;
      if (inside(x, m, z)) lo = m; else hi = m;
    }
    return hi;
  }

  // The top of whatever solid is under (x, z), searched down from `yHi` to
  // `yLo`. Null if there is nothing in that band — which is what walking off the
  // deck edge looks like.
  function topSurface(x, z, yHi, yLo) {
    if (inside(x, yHi, z)) {
      // Buried: something has put us inside geometry. Climb out rather than
      // report no floor, which would drop the player through the ship.
      let up = yHi;
      for (let i = 0; i < 30 && inside(x, up, z); i++) up += PROBE_STEP;
      return inside(x, up, z) ? null : bisect(x, z, up - PROBE_STEP, up);
    }
    for (let y = yHi - PROBE_STEP; y > yLo - PROBE_STEP; y -= PROBE_STEP) {
      if (inside(x, y, z)) return bisect(x, z, y, y + PROBE_STEP);
    }
    return null;
  }

  // Push out of anything the body is standing in sideways. Only surfaces whose
  // normal is more horizontal than vertical count: a floor is the probe's job,
  // and a wall push with any vertical component in it would launch people.
  //
  // Leaves the direction it had to push in `_wall`, which is what turns walking
  // into a turret face into sliding along it rather than stopping dead against
  // it — the one thing move-and-slide does that a de-penetration pass does not.
  function resolveWalls() {
    const heights = wallHeights();
    _wall.set(0, 0, 0);
    let pushed = false;
    for (let it = 0; it < 4; it++) {
      let depth = 0; let nx = 0; let nz = 0;
      for (const h of heights) {
        for (const [ox, oz] of RING) {
          const d = solidAt(pos.x + ox * PLAYER.radius, pos.y + h, pos.z + oz * PLAYER.radius);
          if (d <= depth) continue;
          if (Math.abs(_hit.normal.y) > 0.6) continue;
          const len = Math.hypot(_hit.normal.x, _hit.normal.z);
          if (len < 1e-4) continue;
          depth = d; nx = _hit.normal.x / len; nz = _hit.normal.z / len;
        }
      }
      if (depth <= 0) break;
      // The offset sample is already the furthest point of the body that way, so
      // clearing it by its own depth carries the whole capsule out.
      pos.x += nx * (depth + 0.01);
      pos.z += nz * (depth + 0.01);
      _wall.x += nx; _wall.z += nz;
      pushed = true;
    }
    if (pushed && _wall.lengthSq() > 1e-8) _wall.normalize();
    return pushed;
  }

  function resolveCeiling() {
    const d = solidAt(pos.x, pos.y + PLAYER.height - PLAYER.radius, pos.z);
    if (d > 0 && _hit.normal.y < -0.4) {
      pos.y -= d + 0.01;
      if (vel.y > 0) vel.y = 0;
    }
  }

  // One invisible wall a little inboard of the sheer, and a stop at each end.
  // Cheaper and infinitely more reliable than letting a capsule negotiate
  // modelled guardrail stanchions, which is a source of edge cases forever.
  //
  // Only a space with a hull has a sheer to fall off. Inside a gunhouse there is
  // nothing here to do: the room is closed and its walls are the rail.
  function resolveRail() {
    if (!PLAYER.railings || !hull) return;
    const stop = hull.length / 2 - 1.2;
    if (pos.z > stop) pos.z = stop;
    else if (pos.z < -stop) pos.z = -stop;
    const s = pos.z / hull.length + 0.5;
    const deck = hull.deckAt(s);
    if (pos.y > deck + PLAYER.railHeight || pos.y < deck - 1.5) return;
    const lim = Math.max(hull.halfBeamAt(s) - PLAYER.railInset - PLAYER.radius, 0);
    if (pos.x > lim) pos.x = lim;
    else if (pos.x < -lim) pos.x = -lim;
  }

  // --- the step ---------------------------------------------------------------

  // `input` is { forward, strafe, jump, sprint, rise } — the first two in [-1, 1].
  function step(dt, input, now) {
    // Apparent gravity is evaluated at the body's centre, not its feet: the
    // Euler and centrifugal terms scale with distance from the hull's origin,
    // and it costs nothing to ask in the right place.
    _r.set(pos.x, pos.y + PLAYER.height * 0.5, pos.z);
    const g = space.apparentGravity(_r, _g);

    // The deck's own normal in local space never changes — the geometry does not
    // move. What changes is where "down" points relative to it. So how tilted the
    // deck feels is entirely the horizontal part of apparent gravity, and no
    // surface query is needed to know it.
    const tilt = Math.hypot(g.x, g.z) / GRAVITY;
    state.tilt = tilt;

    const knocked = now < state.knockdownUntil;
    const sin = Math.sin(state.heading); const cos = Math.cos(state.heading);
    // heading 0 faces the bow (+z); starboard is -x — see battleship/spec.js
    _want.set(
      sin * input.forward - cos * input.strafe,
      0,
      cos * input.forward + sin * input.strafe,
    );
    if (_want.lengthSq() > 1) _want.normalize();
    if (knocked) _want.set(0, 0, 0);
    else _want.multiplyScalar(input.sprint ? PLAYER.sprint : PLAYER.walk);

    if (state.fly) {
      // Debug only: walk out over the sea to look at her, or get onto a deck
      // there is no ladder to yet.
      const lift = Math.sin(state.pitch) * input.forward * PLAYER.sprint;
      vel.set(_want.x * 2.5, (lift + input.rise * 8) * 1.2, _want.z * 2.5);
      pos.addScaledVector(vel, dt);
      state.grounded = false;
      return;
    }

    // Coyote time and the jump buffer. Neither is physical and both are the
    // difference between a controller that answers you and one that seems to be
    // arguing: the jump stays available for a moment after you have run off the
    // edge, and a jump pressed just before you land is spent on touchdown rather
    // than thrown away.
    state.coyote = state.grounded ? PLAYER.coyote : Math.max(state.coyote - dt, 0);
    state.jumpWanted = input.jump && !knocked
      ? PLAYER.jumpBuffer
      : Math.max(state.jumpWanted - dt, 0);

    if (state.grounded && !knocked) {
      if (tilt > 0.01) {
        const dx = g.x / (tilt * GRAVITY); const dz = g.z / (tilt * GRAVITY);
        // Walking against the heel is slower. Cheap, immediately legible, and it
        // makes players favour the low side of the deck the way sailors do.
        const len = Math.hypot(_want.x, _want.z);
        if (len > 1e-4) {
          const align = (_want.x * dx + _want.z * dz) / len;
          if (align < 0) _want.multiplyScalar(1 + PLAYER.uphillPenalty * tilt * align);
        }
        // Past a threshold, a bounded downhill nudge — not free sliding, which
        // is slapstick and takes the game away from the player.
        if (tilt > PLAYER.slideThreshold) {
          const bite = (tilt - PLAYER.slideThreshold) / (1 - PLAYER.slideThreshold);
          _want.x += dx * PLAYER.slideDrift * bite;
          _want.z += dz * PLAYER.slideDrift * bite;
        }
      }
      // On the deck the legs own the velocity outright: pull it to what they are
      // asking for, hard enough that starting and stopping read as decisions
      // rather than as momentum.
      const k = Math.min(PLAYER.ground * dt, 1);
      vel.x += (_want.x - vel.x) * k;
      vel.z += (_want.z - vel.z) * k;
      if (vel.y < 0) vel.y = 0;
    } else {
      // In the air they do not. Add along the wished direction, and only up to
      // the wished speed *in that direction* — so a jump keeps the speed it left
      // with and can be steered, but cannot be used to brake or to accelerate
      // beyond a run. This is the old shooter air-control rule and it is why
      // those games feel the way they do.
      const wish = Math.hypot(_want.x, _want.z);
      if (wish > 1e-4) {
        const wx = _want.x / wish; const wz = _want.z / wish;
        const add = Math.min(wish - (vel.x * wx + vel.z * wz), PLAYER.air * dt);
        if (add > 0) { vel.x += wx * add; vel.z += wz * add; }
      }
      // The horizontal part of apparent gravity is the ship shoving you and is
      // taken at face value; only the fall is exaggerated.
      vel.x += g.x * dt;
      vel.z += g.z * dt;
      vel.y += g.y * dt * (vel.y > 0 ? PLAYER.riseGravity : PLAYER.fallGravity);
    }

    if (state.coyote > 0 && state.jumpWanted > 0 && !knocked) {
      // Along the deck's up, not the world's: leaving a heeled deck should land
      // you where the deck is going, not where it was.
      vel.y = PLAYER.jump;
      state.grounded = false;
      state.coyote = 0;
      state.jumpWanted = 0;
    }

    // --- move -----------------------------------------------------------------
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    if (resolveWalls()) {
      // Take out only the part of the velocity going into the wall and keep the
      // rest, so walking at a turret face carries you along it. Damping the
      // whole vector instead leaves the player pinned against the first thing
      // they touch, pressing forward and going nowhere.
      const into = vel.x * _wall.x + vel.z * _wall.z;
      if (into < 0) { vel.x -= _wall.x * into; vel.z -= _wall.z * into; }
    }

    // The band searched for a floor *is* the rule about what counts as one, so
    // there is no second test on the answer: anything found in the band grounds
    // us. Stating it once matters — the surface comes back from a bisection and
    // is a millimetre either side of where the feet already are, and a
    // "floor >= where I was going" test on top of the band flickers in and out
    // of grounded on flat deck, which flickers the traction with it.
    const wantY = pos.y + vel.y * dt;
    const rising = vel.y > 0;
    const walking = state.grounded && !rising;
    const hi = Math.max(pos.y, wantY) + (walking ? PLAYER.stepUp : 0.02);
    const lo = Math.min(pos.y, wantY) - (walking ? PLAYER.snapDown : 0.02);
    const floor = rising ? null : topSurface(pos.x, pos.z, hi, lo);
    let onDeck = false;
    if (floor !== null) {
      // Slope gate: read the normal a little way *inside* the surface, so a
      // sample taken near the deck edge answers "deck" rather than "ship's side".
      solidAt(pos.x, floor - 0.15, pos.z);
      groundNormal.copy(_hit.normal);
      if (groundNormal.y >= PLAYER.maxSlopeCos) {
        onDeck = true;
        pos.y = floor;
        vel.y = 0;
        state.standingOn = _hit.id;
      }
    }
    if (!onDeck) pos.y = wantY;
    state.grounded = onDeck;

    resolveCeiling();
    resolveRail();

    // --- overboard ------------------------------------------------------------
    //
    // This is where a SpaceManager belongs: hand the player to the ocean world
    // with the full velocity composition (v_hull + w x r + R v_local, which
    // shipSpace already computes), let them swim, and take them back aboard on
    // the tighter of two asymmetric margins with a grace period between. Until
    // there is somewhere to hand them to, going over the side puts you back on
    // the deck you left.
    // Stated against whatever this space's collision field covers, so it means
    // "over the side" on the ship and "somehow outside the gunhouse" in a turret
    // without either having to be spelled out twice.
    const b = colliders.bounds;
    if (pos.y < b.min.y - 3 || pos.y > b.max.y + 30
      || pos.x < b.min.x - 6 || pos.x > b.max.x + 6
      || pos.z < b.min.z - 6 || pos.z > b.max.z + 6) {
      state.overboard++;
      if (space !== home) rehome(home, homeExtra);
      respawn();
    }
  }

  // Move to another space, or somewhere else in this one. The caller has already
  // decided *that* it happens; all this does is put the body down and let the
  // floor probe settle it, which is what stops a transition landing somebody
  // half a metre inside a deck.
  function rehome(s, e = null) {
    space = s;
    extra = e;
    colliders = s.colliders;
    hull = s.hull;
  }

  function teleport(position, heading = state.heading) {
    pos.copy(position);
    vel.set(0, 0, 0);
    state.heading = heading;
    state.grounded = false;
    state.coyote = 0;
    state.jumpWanted = 0;
    const floor = topSurface(pos.x, pos.z, pos.y + 2.5, pos.y - 2.5);
    if (floor !== null) pos.y = floor + 0.02;
  }

  function respawn() {
    pos.copy(spawn.position);
    vel.set(0, 0, 0);
    state.grounded = false;
    state.knockdownUntil = 0;
    // Drop onto whatever is under the spawn mark rather than trusting a height
    // typed into a file: the sheer puts the deck at a different level at every
    // station, so a spawn only has to name a place on the plan.
    const floor = topSurface(pos.x, pos.z, pos.y + 30, pos.y - 30);
    if (floor !== null) pos.y = floor + 0.02;
  }

  // Direct knockback for crew near a blast (§8). The hull impulse is a separate
  // mechanism and needs nothing from here — everyone aboard feels that one
  // through apparent gravity automatically, which is the two-space split paying
  // for itself.
  function knockback(localCenter, magnitude, radius, now) {
    const dx = pos.x - localCenter.x;
    const dy = pos.y + PLAYER.height * 0.5 - localCenter.y;
    const dz = pos.z - localCenter.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > radius) return;
    const falloff = 1 - dist / radius;
    const mag = magnitude * falloff * falloff;
    const inv = dist > 0.01 ? mag / dist : 0;
    vel.x += dx * inv;
    vel.z += dz * inv;
    // Biased upward on purpose: people thrown into the air read as an explosion,
    // people shoved sideways read as a bug.
    vel.y += dy * inv + mag * 0.4;
    state.grounded = false;
    // and a spell with the input ignored, or players tap-recover instantly and
    // the blast has no weight at all
    state.knockdownUntil = now + 300 + 900 * falloff;
  }

  respawn();

  return {
    position: pos, // ship-local, at the feet
    velocity: vel, // ship-local
    get speed() { return Math.hypot(vel.x, vel.z); },
    groundNormal,
    state,
    step,
    respawn,
    rehome,
    teleport,
    knockback,
    get space() { return space; },
    // for anything that wants the player in the ocean world — a shell, a
    // rangefinder, another ship
    worldPosition(out) { return space.toWorld(_tmp.set(pos.x, pos.y + PLAYER.eye, pos.z), out); },
    worldVelocity(out) { return space.velocityToWorld(pos, vel, out); },
  };
}
