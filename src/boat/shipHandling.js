import { Vector3, Quaternion, MathUtils } from 'three/webgpu';

// Capital-ship handling.
//
// The force solver in Boat.js is a good boat and a bad ship. It resolves
// everything — thrust, crossflow drag, hull lift, rudder normal force — and
// integrates it, which is exactly right for a 16 m launch, whose behaviour *is*
// those forces at a scale where they are all comparable. On 42,000 tonnes it is
// a tuning problem with no good answer. The terms meant to stop her skidding
// are quadratic in the sideways flow, so they are feeble at the small drift
// angles that decide how a turn reads and vicious at the large ones; between
// that and a rudder force that scales with speed squared, she would enter a
// turn crabbing seventy degrees off her heading and slide through it. That is
// the drift.
//
// This model does not resolve forces. It states the answer — a target speed, a
// yaw rate, and the sideslip a hull pivoting about a point forward of its
// centre of mass genuinely has — and then puts the weight back by hand, as lag:
// the engine room takes seconds to answer the telegraph, the rudder is a heavy
// object that swings at a finite rate, and a hard turn costs speed. Weight in a
// ship is not force, it is delay, and delay is the thing a force model of this
// scale gets wrong first.
//
// It owns horizontal velocity and yaw. Buoyancy keeps heave, pitch and roll —
// she still rides the sea, she just no longer skids across it.
//
// Frame, as everywhere in this directory: +z forward, +y up, and starboard is
// fwd x up, which is -x. See the note at the top of Boat.js.

const WORLD_UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Fraction of the way to a target after `dt` seconds at rate `rate` (1/s).
// Exponential rather than `x += (target - x) * rate * dt`, which is only the
// same thing for small dt and diverges outright once rate * dt exceeds 1 — the
// difference between a ship that settles and one that rings at low frame rates.
const decay = (rate, dt) => 1 - Math.exp(-rate * dt);

export const capitalShipHandling = {
  length: 180, // m, for the tactical-diameter sanity check only

  // Speed. A Fuso did about 23 kn; this is nudged up to 31, because the sea is
  // 900 m across and a ship that takes four minutes to cross it is not fun.
  maxSpeedAhead: 16, // m/s
  maxSpeedAstern: 6,

  accelTime: 22, // s from stop to full ahead. The real thing is 60-90.
  brakeMultiplier: 2.2, // astern thrust bites harder, so a crash stop works
  engineSpool: 2.5, // s for the engines to answer a change of telegraph

  maxRudder: 32, // degrees hard over
  rudderSlew: 5, // deg/s — hard over to hard over in about 13 s

  // Yaw acceleration (rad/s^2) per radian of rudder, at the reference speed.
  //
  // This is the one number that decides whether she reads as a battleship, and
  // it is worth doing the arithmetic rather than dialling it by eye. The
  // steady-state yaw rate is maxRudder * rudderPower / yawDamping, and the
  // circle she carves at that rate is `turnDiameter` below. A real capital ship
  // turns in four to five hull lengths. At 0.55 — a plausible-looking number —
  // she comes round at 12 deg/s and turns inside her own length, which is a
  // patrol boat; worse, the sideslip that goes with a yaw rate that high is
  // over ten metres a second, so she spends the turn crabbing at forty-five
  // degrees. Most of what reads as "drifting" is a ship yawing faster than her
  // hull could ever push water aside.
  rudderPower: 0.07, // -> 1.5 deg/s, ~780 m circle, 4.3 hull lengths
  rudderRefSpeed: 10, // m/s at which the rudder has its full effect

  lateralGrip: 3.0, // 1/s — how fast sideslip settles. Lower is driftier.
  pivotOffset: 46, // m forward of the CoM that the hull pivots about
  yawDamping: 1.6, // 1/s — she stops swinging when the helm comes off

  turnSpeedBleed: 0.35, // fraction of top speed lost at full rate of turn
  maxHeel: 5, // degrees of outward lean at full rate of turn
  heelResponse: 2.0, // 1/s — how fast that lean follows the turn
};

// Engine telegraph. Ships do not have analogue throttles, and discrete notches
// read as far more nautical than a smooth axis: you ring down for what you want
// and then wait for it, which is most of what makes a big ship feel big.
export const TELEGRAPH = [
  { label: 'Full astern', value: -1.0 },
  { label: 'Half astern', value: -0.5 },
  { label: 'Slow astern', value: -0.25 },
  { label: 'Stop', value: 0 },
  { label: 'Slow ahead', value: 0.25 },
  { label: 'Half ahead', value: 0.5 },
  { label: 'Full ahead', value: 0.75 },
  { label: 'Flank ahead', value: 1.0 },
];
export const TELEGRAPH_STOP = TELEGRAPH.findIndex((t) => t.value === 0);

export function createShipHandling(config = capitalShipHandling) {
  const c = { ...config };

  const state = {
    throttle: 0, // what the engines are actually doing, trailing the telegraph
    rudder: 0, // degrees, trailing the wheel
    yawRate: 0, // rad/s, + is a turn to starboard (matching `turnRate` in Boat.js)
    heel: 0, // radians, + is starboard down. Cosmetic; see below.
    speed: 0, // through the water, along the bow
    sideslip: 0, // through the water, along starboard
    drift: 0, // degrees off her own heading
  };

  const fwd = new Vector3();
  const stbd = new Vector3();
  const _q = new Quaternion();

  // Steady-state yaw rate at full rudder and full speed. Everything that scales
  // with how hard she is turning is normalised against it, so those effects do
  // not need retuning every time the rudder numbers move.
  const maxYawRate = () => MathUtils.degToRad(c.maxRudder) * c.rudderPower / c.yawDamping;

  // Her basis, flattened to the horizontal. Using the true forward vector would
  // leak the pitch a wave puts into her straight into the drive direction,
  // which reads as the ship surging up and down the face rather than through
  // it — and would make her climb out of the water on a steep enough sea.
  function basis(quaternion) {
    fwd.copy(FORWARD).applyQuaternion(quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.copy(FORWARD);
    else fwd.normalize();
    stbd.copy(fwd).cross(WORLD_UP);
  }

  // `input` is { throttle: -1..1, steer: -1..1 }; `body` is the solver's
  // { quaternion, velocity }, both mutated in place.
  function step(dt, input, body) {
    const telegraph = clamp(input.throttle, -1, 1);
    const wheel = clamp(input.steer, -1, 1) * c.maxRudder;

    basis(body.quaternion);
    let vFwd = body.velocity.dot(fwd);
    let vLat = body.velocity.dot(stbd);

    // The telegraph is instant; the shafts are not. This lag is also what makes
    // ahead-to-astern feel like a ship rather than like a car.
    state.throttle += (telegraph - state.throttle) * decay(1 / c.engineSpool, dt);

    // The rudder is a heavy object and swings at a finite rate.
    const swing = c.rudderSlew * dt;
    state.rudder += clamp(wheel - state.rudder, -swing, swing);

    // Yaw from the rudder. Scaled by speed, so the helm goes dead when she is
    // stopped, and signed by the direction of travel, so it inverts going
    // astern with no special case.
    const speedFactor = clamp(Math.abs(vFwd) / c.rudderRefSpeed, 0, 1);
    const yawAccel = MathUtils.degToRad(state.rudder)
      * c.rudderPower * speedFactor * Math.sign(vFwd || 1);
    state.yawRate += yawAccel * dt;
    state.yawRate -= state.yawRate * c.yawDamping * dt;

    // + is a turn to starboard, which is negative about world up
    _q.setFromAxisAngle(WORLD_UP, -state.yawRate * dt);
    body.quaternion.premultiply(_q).normalize();
    // Re-derive after rotating, so thrust goes where the bow points now rather
    // than where it pointed at the top of the frame.
    basis(body.quaternion);

    // A hard turn costs speed: she is putting her side to the water. Without
    // this, turning is free and the whole thing feels weightless.
    const turnFraction = clamp(Math.abs(state.yawRate) / maxYawRate(), 0, 1);
    const target = state.throttle >= 0
      ? state.throttle * c.maxSpeedAhead * (1 - c.turnSpeedBleed * turnFraction)
      : state.throttle * c.maxSpeedAstern;

    const accel = c.maxSpeedAhead / c.accelTime;
    const delta = target - vFwd;
    // Backing down bites harder than working up, so a crash stop is worth
    // ringing for. Clamping the step rather than the difference is what makes
    // her arrive at the ordered speed instead of creeping onto it.
    const braking = Math.sign(delta) !== Math.sign(vFwd || 1);
    const limit = accel * dt * (braking ? c.brakeMultiplier : 1);
    vFwd += clamp(delta, -limit, limit);

    // Sideslip, and the reason it is not simply damped to zero: a hull pivots
    // about a point well forward of its centre of mass, so in a turn the centre
    // of mass really does slide outward, at the yaw rate times that lever. That
    // slide is what you read as a ship's weight — a few degrees of it. Damping
    // to zero instead puts her on rails and she corners like a car; leaving it
    // undamped is the seventy-degree crab this model replaced.
    const latTarget = -state.yawRate * c.pivotOffset;
    vLat += (latTarget - vLat) * decay(c.lateralGrip, dt);

    const vy = body.velocity.y; // buoyancy owns this
    body.velocity.copy(fwd).multiplyScalar(vFwd).addScaledVector(stbd, vLat);
    body.velocity.y = vy;

    // She leans *out* of a turn, like any displacement hull. Cosmetic: the
    // buoyancy solver owns the roll the sea gives her, and this is laid on top
    // of it at draw time rather than fought through it.
    const heelTarget = -Math.sign(state.yawRate || 1)
      * turnFraction * MathUtils.degToRad(c.maxHeel);
    state.heel += (heelTarget - state.heel) * decay(c.heelResponse, dt);

    state.speed = vFwd;
    state.sideslip = vLat;
    state.drift = Math.abs(vFwd) > 0.5
      ? (Math.atan2(vLat, Math.abs(vFwd)) * 180) / Math.PI
      : 0;
  }

  function reset() {
    state.throttle = 0;
    state.rudder = 0;
    state.yawRate = 0;
    state.heel = 0;
    state.speed = 0;
    state.sideslip = 0;
    state.drift = 0;
  }

  return {
    config: c,
    state,
    step,
    reset,
    get maxYawRate() { return maxYawRate(); },
    // The circle she carves at full rudder, in metres. Sanity check: a real
    // capital ship turns in four to five hull lengths.
    get turnDiameter() {
      return 2 * c.maxSpeedAhead * (1 - c.turnSpeedBleed) / maxYawRate();
    },
    get turnLengths() { return this.turnDiameter / c.length; },
  };
}
