// Build-order checkpoints for walking about on her, run headless.
//
// The three steps the architecture is judged on (see the design note, §11):
//
//   1. static ship, static player  — can a person get everywhere, and is the
//      collision geometry sane?
//   2. hull moving, nothing fed back — the player must be ROCK SOLID on a
//      heaving deck. Any drift at all means the two spaces are still coupled.
//   3. inertia on — is the deck alive but still crossable?
//
//   node probe-deck.mjs
//
// Nothing here touches the GPU, so it runs in a couple of seconds and is the
// fastest way to find out whether a change to the ship's geometry has walled
// somebody in.
//
// One caveat on what it is testing. The colliders built here are the base set:
// the superstructure's own solids come from the builders that draw them, which
// need materials, which need a device. So the ship in here is *less* solid than
// the one in the browser — the pagoda is its column and its blockhouses rather
// than its levels. A route that is clear in here may be blocked in the app; a
// route that is blocked in here is blocked in both.
import { Quaternion, Vector3 } from 'three/webgpu';
import { createColliders } from './src/battleship/colliders.js';
import { createDeckAccess } from './src/player/deckAccess.js';
import { createShipSpace } from './src/player/shipSpace.js';
import { createCharacter } from './src/player/character.js';
import { PLAYER, GRAVITY } from './src/player/spec.js';
import { hullDescriptor } from './src/battleship/hull.js';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

const AFT = Math.PI;
const FWD = 0;
const STBD = -Math.PI / 2; // starboard is -x
const PORT = Math.PI / 2;

// ---------------------------------------------------------------------------
// step 1: a ship that does not move
// ---------------------------------------------------------------------------

const still = {
  colliders: createColliders({ mounts: null, alive: () => true }),
  hull: hullDescriptor,
  apparentGravity: (r, out) => out.set(0, -GRAVITY, 0),
  toWorld: (v, out) => out.copy(v),
  velocityToWorld: (p, v, out) => out.copy(v),
};

// Steering round whatever is in the way.
//
// The weather deck has capstans, drums, vent cowls and bollards on it, and a
// straight line down it stops at the first one. What the probe is asking is
// whether a *person* can get from one end of her to the other, and a person
// veers. So: if no ground is being made good along the leg's heading, put the
// helm over for half a second and try again, alternating sides. It is a very
// stupid wall-follower and that is the point — if this can find the way, so can
// anybody.
function steerer(p, heading) {
  let stuck = 0;
  let veer = 0; // frames left on the current dodge
  let side = 1;
  let i = 0;
  const was = { x: p.position.x, z: p.position.z };
  return function aim() {
    p.state.heading = heading + (veer > 0 ? side * 0.44 : 0);
    if (veer > 0) { veer--; i++; return; }
    if (i % 6 === 5) {
      // ground made good along the leg's own heading over the last tenth of a second
      const made = (p.position.x - was.x) * Math.sin(heading)
        + (p.position.z - was.z) * Math.cos(heading);
      was.x = p.position.x; was.z = p.position.z;
      stuck = made < 0.15 ? stuck + 1 : 0;
      if (stuck >= 2) { veer = 30; side = -side; stuck = 0; }
    }
    i++;
  };
}

function walkLeg(p, heading, seconds, t0) {
  const dt = 1 / 60;
  const input = {
    forward: 1, strafe: 0, jump: false, sprint: false, rise: 0,
  };
  const aim = steerer(p, heading);
  let t = t0;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    aim();
    p.step(dt, input, t * 1000);
    t += dt;
  }
  return t;
}

function run(label, spawn, plan) {
  const p = createCharacter({
    space: still, extra: createDeckAccess(), spawn: { position: new Vector3(...spawn), heading: 0 },
  });
  let t = 0;
  const log = [];
  for (const leg of plan) {
    t = walkLeg(p, leg.heading, leg.seconds, t);
    log.push(`    ${String(leg.seconds).padStart(4)}s heading ${String(Math.round(leg.heading * 180 / Math.PI)).padStart(4)}: `
      + `x ${p.position.x.toFixed(2).padStart(6)} y ${p.position.y.toFixed(2).padStart(5)} z ${p.position.z.toFixed(2).padStart(7)}`
      + ` ${p.state.grounded ? `on ${p.state.standingOn ?? 'the deck'}` : 'AIRBORNE'}`
      + (p.state.overboard ? ` OVERBOARD x${p.state.overboard}` : ''));
  }
  console.log(`${label}\n${log.join('\n')}`);
}

console.log('=== step 1: static ship, static player ===\n');
console.log('spawn settles at:');
const s = createCharacter({ space: still, extra: createDeckAccess(), spawn: { position: new Vector3(0, 20, 66), heading: AFT } });
console.log('   ', s.position.toArray().map((v) => v.toFixed(2)).join(', '));

run('\nforecastle, walk aft down the centreline (should stop at A turret):',
  [0, 20, 66], [{ heading: AFT, seconds: 8 }]);

run('\nforecastle, out to the starboard rail (should stop at the rail):',
  [0, 20, 66], [{ heading: STBD, seconds: 8 }]);

run('\nstarboard side deck, aft from the forecastle, steering round A turret:',
  [0, 20, 66], [
    { heading: STBD, seconds: 2 },
    { heading: AFT, seconds: 3 },
    { heading: STBD, seconds: 2 },
    { heading: AFT, seconds: 35 },
  ]);

run('\nand back forward again:',
  [-12, 20, -60], [
    { heading: FWD, seconds: 40 },
  ]);

run('\nup the port ladder to the shelter deck (its foot is at x=9.1, z=12.6):',
  [9.1, 20, 14.5], [
    { heading: AFT, seconds: 5 },
  ]);

run('\nshelter deck: aft, inboard round the AA tub, aft again to the after house:',
  [9.1, 20, 14.5], [
    { heading: AFT, seconds: 5.2 },
    { heading: STBD, seconds: 2.0 },
    { heading: AFT, seconds: 3.5 },
  ]);

run('\nup the after ladder, shelter deck to the after deckhouse:',
  [-5.4, 12, -6.5], [
    { heading: AFT, seconds: 6 },
  ]);

run('\nwalk off the bow (rail on, should stop):',
  [0, 20, 66], [{ heading: FWD, seconds: 15 }]);

{
  const p = createCharacter({
    space: still, extra: createDeckAccess(), spawn: { position: new Vector3(-12, 20, 0), heading: 0 },
  });
  const N = 20000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    p.step(1 / 60, {
      forward: 1, strafe: 0, jump: false, sprint: false, rise: 0,
    }, i * 16.7);
  }
  const ms = performance.now() - t0;
  console.log(`\ncost: ${(ms / N * 1000).toFixed(1)} us per player per frame `
    + `(${N} steps in ${ms.toFixed(0)} ms)`);
}

// ---------------------------------------------------------------------------
// steps 2 and 3: a ship that does
// ---------------------------------------------------------------------------

// A hull in a seaway: heave, pitch and roll on three incommensurate periods,
// plus an optional steady turn so the Euler and centrifugal terms have
// something to say. Velocity is differenced from position, the way the real
// solver's would be if you only had its transform.
// `turn` is her rate of turn in rad/s and `speed` her speed through the water;
// between them they set the radius, and therefore the centripetal acceleration
// the crew actually feel. Stating a radius independently is how you accidentally
// test a ship doing 350 knots.
function makeHull({
  heave = 0, roll = 0, pitch = 0, turn = 0, speed = 8.2,
}) {
  const radius = turn === 0 ? 0 : speed / turn;
  const q = new Quaternion();
  const body = {
    position: new Vector3(),
    velocity: new Vector3(),
    quaternion: q,
    get visualQuaternion() { return q; },
  };
  const prev = new Vector3();
  const e = new Quaternion();
  const a = new Quaternion();
  let yaw = 0;
  let first = true;
  return {
    body,
    at(t, dt) {
      yaw += turn * dt;
      q.setFromAxisAngle(Y, yaw);
      a.setFromAxisAngle(X, (pitch * Math.PI / 180) * Math.sin((2 * Math.PI * t) / 7.3 + 1.1));
      e.setFromAxisAngle(Z, (roll * Math.PI / 180) * Math.sin((2 * Math.PI * t) / 11.0));
      q.multiply(a).multiply(e);
      prev.copy(body.position);
      body.position.set(
        Math.sin(yaw) * radius,
        heave * Math.sin((2 * Math.PI * t) / 9.0),
        Math.cos(yaw) * radius,
      );
      if (first) { prev.copy(body.position); first = false; }
      if (dt > 0) body.velocity.subVectors(body.position, prev).divideScalar(dt);
    },
  };
}

const WARMUP = 4; // seconds run before anything is measured

function trial({
  label, inertia, sea, seconds = 60, input = null, start = [-11, 8, 0], traction = true,
  heading = 0,
}) {
  PLAYER.inertiaScale = inertia;
  const slide = PLAYER.slideThreshold;
  const uphill = PLAYER.uphillPenalty;
  if (!traction) { PLAYER.slideThreshold = 99; PLAYER.uphillPenalty = 0; }

  const colliders = createColliders({ mounts: null, alive: () => true });
  const hull = makeHull(sea);
  const space = createShipSpace({ body: hull.body, colliders, hull: hullDescriptor });
  const player = createCharacter({
    space, extra: createDeckAccess(), spawn: { position: new Vector3(...start), heading },
  });
  const dt = 1 / 60;
  const idle = {
    forward: 0, strafe: 0, jump: false, sprint: false, rise: 0,
  };
  let t = 0;
  for (let i = 0; i < WARMUP / dt; i++) { t += dt; hull.at(t, dt); space.syncHull(dt); player.step(dt, idle, t * 1000); }

  const aim = input ? steerer(player, heading) : null;
  const home = player.position.clone();
  const tilts = [];
  let drift = 0;
  let air = 0;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    t += dt;
    hull.at(t, dt);
    space.syncHull(dt);
    if (aim) aim();
    player.step(dt, input ?? idle, t * 1000);
    drift = Math.max(drift, player.position.distanceTo(home));
    if (!player.state.grounded) air++;
    tilts.push(player.state.tilt);
  }
  tilts.sort((a, b) => a - b);
  const deg = (s) => (Math.asin(Math.min(s, 1)) * 180 / Math.PI).toFixed(1);
  console.log(
    `  ${label.padEnd(46)} drift ${drift.toFixed(3).padStart(7)} m · `
    + `airborne ${(air / n * 100).toFixed(0).padStart(3)}% · `
    + `tilt med ${deg(tilts[n >> 1]).padStart(4)}° p99 ${deg(tilts[Math.floor(n * 0.99)]).padStart(4)}°`
    + (input
      ? ` · made good ${(heading === 0
        ? player.position.z - home.z
        : home.x - player.position.x).toFixed(1).padStart(6)} m`
      : ''),
  );

  PLAYER.slideThreshold = slide;
  PLAYER.uphillPenalty = uphill;
  return player;
}

const CALM = {};
const MODERATE = { heave: 1.6, roll: 8, pitch: 2.5 };
const HEAVY = { heave: 3.4, roll: 20, pitch: 6 };
const TURN = { heave: 1.0, roll: 9, pitch: 2, turn: 0.30 }; // 17 deg/s hard over, 16 kn

console.log('\n=== step 2: hull moving, nothing fed back ===\n');
console.log('--- step 2: hull moving, nothing fed back. Must be rock solid. ---');
trial({ label: 'flat calm', inertia: 0, sea: CALM, traction: false });
trial({ label: 'moderate sea', inertia: 0, sea: MODERATE, traction: false });
trial({ label: 'heavy sea, 20 deg of roll', inertia: 0, sea: HEAVY, traction: false });
trial({ label: 'hard over at 17 deg/s', inertia: 0, sea: HEAVY, traction: false });
trial({ label: 'heavy sea, forward (r = 60 m)', inertia: 0, sea: HEAVY, start: [-6, 8, 60], traction: false });
trial({ label: 'heavy sea + hard over, forward', inertia: 0, sea: TURN, start: [-6, 8, 60], traction: false });

console.log('\n--- step 2b: as above but with the traction model on ---');
trial({ label: 'moderate sea', inertia: 0, sea: MODERATE });
trial({ label: 'heavy sea', inertia: 0, sea: HEAVY });

console.log('\n--- step 3: inertia on, standing still ---');
for (const s of [0.2, 0.4, 0.7, 1.0]) trial({ label: `moderate sea, inertiaScale ${s}`, inertia: s, sea: MODERATE });
for (const s of [0.2, 0.4, 0.7, 1.0]) trial({ label: `heavy sea, inertiaScale ${s}`, inertia: s, sea: HEAVY });
for (const s of [0.4, 1.0]) trial({ label: `hard over amidships, inertiaScale ${s}`, inertia: s, sea: TURN });
for (const s of [0.4, 1.0]) trial({ label: `hard over at 60 m fwd, inertiaScale ${s}`, inertia: s, sea: TURN, start: [-6, 8, 60] });

console.log('\n--- step 3b: can she be crossed? walking the side deck forward, 30 s ---');
const walk = {
  forward: 1, strafe: 0, jump: false, sprint: false, rise: 0,
};
console.log(`  (a clear run at ${PLAYER.walk} m/s for 30 s would make good ${(PLAYER.walk * 30).toFixed(0)} m; she is 180 m long)`);
for (const [name, sea] of [['calm', CALM], ['moderate', MODERATE], ['heavy', HEAVY]]) {
  for (const s of [0, 0.4, 1.0]) {
    trial({
      label: `${name} sea, inertiaScale ${s}`, inertia: s, sea, seconds: 30, input: walk, start: [-11, 8, -60],
    });
  }
}

// Fore-and-aft is the easy way on a rolling deck, because the heel is
// athwartships and the uphill penalty barely sees it. Crossing her is the hard
// way, and it is the one the tuning is really about.
console.log('\n--- step 3c: crossing her, beam to beam, 8 s ---');
// Between X and Y turrets is the one station with a clear run from rail to
// rail: 25.7 m of open quarterdeck.
console.log('  (25.7 m of open quarterdeck between X and Y turrets to get across)');
for (const [name, sea] of [['moderate', MODERATE], ['heavy', HEAVY]]) {
  for (const s of [0, 0.4, 1.0]) {
    trial({
      label: `${name} sea, inertiaScale ${s}`, inertia: s, sea, seconds: 8, input: walk,
      start: [12.8, 8, -55], heading: -Math.PI / 2,
    });
  }
}
PLAYER.inertiaScale = 0.4;
console.log(`\n(gravity ${GRAVITY} m/s^2; slide threshold ${PLAYER.slideThreshold} = ${(Math.asin(PLAYER.slideThreshold) * 180 / Math.PI).toFixed(0)} deg)`);
