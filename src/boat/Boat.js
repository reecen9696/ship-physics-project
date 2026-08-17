import { Vector2, Vector3, Quaternion } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { createWaterProbes } from './waterProbes.js';
import { createBoatMesh, halfBeamAt as boatHalfBeamAt, HULL as BOAT_HULL } from './boatMesh.js';
import { createHullSpray, sprayConfig } from './hullSpray.js';
import { createShipHandling, TELEGRAPH, TELEGRAPH_STOP } from './shipHandling.js';

const FORWARD_LOCAL = new Vector3(0, 0, 1);
const RHO = 1000; // water density, kg/m^3
const RHO_G = RHO * 9.81; // N/m^3
const KT = 1.94384; // m/s -> knots

// Body frame. The hull is modelled with its bow at +z and its mast at +y, so
// starboard is fwd x up = (0,0,1) x (0,1,0) = -x. That falls out of three.js
// being right-handed and is easy to get backwards — the default camera faces -z
// with up +y and its screen-right is +x, which is the same relation. Everything
// lateral below is expressed against the `stbd` vector rather than a raw axis so
// the convention is stated once, here.

// Six hull points, spread fore/aft and port/starboard so pitch and roll both get
// a real restoring couple. Quoted as fractions of the hull so they track any
// change to its dimensions; y sits just under the design waterline.
//
// The x offsets are deliberately well inboard of the rail. Each probe stands for
// a share of the waterplane, so sum(area * x^2) is the hull's roll stiffness —
// put all six out at the gunwale and you get a metacentric height of 8 m and a
// 1.3 s roll period, which is nothing like a boat. Pulled in to these fractions
// the same six probes reproduce L*B^3/12 for a realistic waterplane coefficient,
// giving GM ~= 3.9 m and a ~1.9 s roll.
const PROBE_BEAM = 0.672;
const PROBE_LAYOUT = [
  [-0.74, -0.51, 0.66], [0.74, -0.51, 0.66],
  [-0.93, -0.51, 0.00], [0.93, -0.51, 0.00],
  [-0.89, -0.51, -0.68], [0.89, -0.51, -0.68],
];

// Stations along the hull where lateral (sideways) flow is resisted. Spreading
// this along the length instead of lumping it at the centre is what makes the
// boat turn like a boat: the same set of forces produces sway damping, yaw
// damping, the drift angle in a turn, the pivot point, and the speed lost while
// turning — all coupled, instead of as separate hand-tuned terms.
const LATERAL_FRACTIONS = [-0.45, -0.30, -0.15, 0, 0.15, 0.30, 0.45];

// The solver is written against a hull *descriptor* rather than one hard-coded
// set of dimensions, so the same physics floats a 16 m launch and a 180 m
// battleship. A descriptor is { length, halfBeam, keel, deck, depth, halfBeamAt }.
function layoutFor(hull) {
  return {
    probes: PROBE_LAYOUT.map(([x, y, z]) => [
      x * PROBE_BEAM * hull.halfBeam, y * hull.keel, z * (hull.length / 2),
    ]),
    lateral: LATERAL_FRACTIONS.map((f) => f * hull.length),
    // Where each probe's spray actually leaves the hull: out at the hull side for
    // that station, not at the probe itself. The probes sit inboard under the
    // bottom, and launching from there fires droplets up through her own deck.
    sprayBeam: PROBE_LAYOUT.map(([x, , z]) => hull.halfBeamAt(z / 2 + 0.5) * Math.sign(x || 1)),
  };
}

export const boatConfig = {
  // --- flotation (mass and probeArea between them set the 0.72 m draft) ---
  mass: 52000, // kg
  probeArea: 12.0, // m^2 of waterplane each probe stands for
  maxDepth: 2.0, // buoyancy saturates once a probe is this deep
  heaveDamp: 22000, // N per m/s of vertical motion, per submerged probe
  slopePush: 0.55, // how hard a wave face pushes the hull down-slope

  // --- propulsion ---
  thrust: 190000, // N at full throttle; with dragFwd this gives ~27 kn
  reverse: 0.15, // astern thrust as a fraction of ahead (drag being quadratic,
  // this lands astern at roughly a third of the ahead speed)
  dragFwd: 950, // quadratic surge drag

  // --- hull lateral resistance ---
  lateralArea: 15, // m^2 of underwater profile, shared across the stations
  lateralCd: 1.3, // crossflow drag of the hull side-on; dominates when nearly
  // stopped, or when she is already sliding badly
  hullLift: 0.9, // A hull held at a drift angle works as a very low aspect
  // ratio foil, and that lift is linear in drift and grows with speed. Without
  // it the only thing resisting a slide is crossflow drag, which is quadratic
  // and so feeble at small angles that she skids through every turn.
  clrDepth: 1.0, // centre of lateral resistance, in metres below the CG. This
  // is the lever that turns a turn into a heel, so it sets how hard she leans.

  // --- rudder, modelled as a stalling foil in the propeller race ---
  rudderArea: 1.4, // m^2, both blades
  rudderLift: 2.8, // dCn/d(alpha), per radian
  rudderStall: 1.1, // normal-force coefficient ceiling
  maxHelm: 35, // degrees hard over
  helmRate: 20, // degrees/s — a helm takes a moment to swing, it doesn't snap
  propWash: 0.4, // how much of the screw race reaches the rudder, which is what
  // lets her be kicked around at a standstill

  // --- roll ---
  bankIn: 3.0, // 0 = leans out of the turn like a displacement hull, 1 = upright,
  // >1 = banks in like a fast hull riding on its own lift. The lumped stand-in
  // for planing lift, which is a real and large effect above about Fr 0.9 and
  // not something the buoyancy probes can produce on their own.
  rollDamp: 2700000, // N*m per (rad/s)^2 about the fore-and-aft axis. Being
  // quadratic it bites hardest on the fast roll a wave train drives — enough to
  // keep her off her beam ends in a big sea — while barely touching the slow
  // forced lean of a turn, so the two can be tuned almost independently.
  angDamp: 0.25, // residual damping on everything else
};

export function createBoat(renderer, {
  ocean, params, shading, hull = null, config = null, buildMesh = null, spray: makeSpray = true,
  flooding = null, capability = null, water: externalWater = null, handling: handlingConfig = null,
}) {
  const HULL = hull || { ...BOAT_HULL, halfBeamAt: boatHalfBeamAt };
  const c0 = config || boatConfig;
  // A hull given a `handling` config hands everything horizontal — surge,
  // sideslip and yaw — to the model in shipHandling.js, and keeps this solver
  // only for heave, pitch and roll. See that file for why a 42,000-tonne ship
  // wants stating rather than integrating.
  const handling = handlingConfig ? createShipHandling(handlingConfig) : null;
  const { probes: PROBES, lateral: LATERAL_STATIONS, sprayBeam: SPRAY_BEAM } = layoutFor(HULL);
  // The local water surface, handed to the hull shader as a plane so it can wet
  // itself below the waterline. Fitted to the probes every frame, so it tracks
  // the actual wave the boat is sitting on rather than mean sea level.
  // Callers that build their own meshes ahead of the solver pass the uniforms
  // their materials already captured, so both sides share one object.
  const water = externalWater || {
    height: uniform(0),
    slope: uniform(new Vector2()),
    origin: uniform(new Vector2()),
  };

  const group = buildMesh ? buildMesh({ water }) : createBoatMesh({ shading, water });
  const probes = createWaterProbes(renderer, {
    cascades: ocean.cascades,
    lengthScales: params.lengthScales,
    N: params.N,
    offsets: PROBES,
  });

  const position = new Vector3(0, 1.0, 0);
  const velocity = new Vector3();
  const quaternion = new Quaternion();
  const angVel = new Vector3();

  // Body-frame inertia of an equivalent box, per kg (x=pitch, y=yaw, z=roll).
  // Kept per-unit-mass so the GUI's mass slider stays consistent with it.
  const beam = 2 * HULL.halfBeam;
  const inertiaPerKg = new Vector3(
    (HULL.length ** 2 + HULL.depth ** 2) / 12,
    (HULL.length ** 2 + beam ** 2) / 12,
    (beam ** 2 + HULL.depth ** 2) / 12,
  );

  const THRUST_AT = [-0.26 * HULL.keel, -0.45 * HULL.length]; // [below CG, aft of CG]
  const RUDDER_AT = [-0.55 * HULL.keel, -0.46 * HULL.length];
  const PROP_DISC = 1.3; // m^2 swept by the screws, sets the race velocity

  const input = { throttle: 0, steer: 0 };
  let helm = 0; // actual rudder angle in radians, lagging the wheel
  const _steer = { throttle: 0, steer: 0 }; // scratch, handed to the handling model

  // Engine-room telegraph. Only hulls on the handling model have one: a launch
  // has a lever you push, a capital ship has eight positions and a man in the
  // engine room who answers them.
  let notch = TELEGRAPH_STOP;
  const telegraph = handling ? {
    get index() { return notch; },
    get label() { return TELEGRAPH[notch].label; },
    get value() { return TELEGRAPH[notch].value; },
    set(i) {
      notch = Math.min(Math.max(i, 0), TELEGRAPH.length - 1);
      input.throttle = TELEGRAPH[notch].value;
    },
    ring(delta) { telegraph.set(notch + delta); },
    stop() { telegraph.set(TELEGRAPH_STOP); },
  } : null;

  const stbd = new Vector3();
  const up = new Vector3();
  const fwd = new Vector3();
  const _r = new Vector3();
  const _r2 = new Vector3();
  const _f = new Vector3();
  const _t = new Vector3();
  const _v = new Vector3();
  const _q = new Quaternion();
  const force = new Vector3();
  const torque = new Vector3();

  const state = {
    submerged: 0, wet: 0, waterY: 0, slopeX: 0, slopeZ: 0, foam: 1, drift: 0, helm: 0,
  };

  const spray = makeSpray ? createHullSpray({ shading }) : null;
  const probeSub = new Float32Array(PROBES.length); // last frame's immersion depth
  // fractional droplets carried between frames; two extra slots for the stem
  const sprayDebt = new Float32Array(PROBES.length + 2);
  const STEM_DEBT = PROBES.length;
  const _origin = new Vector3();
  const _dir = new Vector3();
  const _carry = new Vector3();
  const _wind = new Vector3();
  const waterPlane = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };

  function refreshBasis() {
    up.set(0, 1, 0).applyQuaternion(quaternion);
    fwd.set(0, 0, 1).applyQuaternion(quaternion);
    stbd.copy(fwd).cross(up); // see the note at the top of this file
  }

  // Add `f` (world) acting at world offset `r` from the centre of mass.
  function applyAt(f, r) {
    force.add(f);
    torque.add(_t.copy(r).cross(f));
  }

  // Velocity of the point at body offset (down, aft) through the water, written
  // into `_v`; returns nothing, callers read `_v`.
  function pointVelocity(down, aft) {
    _r.copy(up).multiplyScalar(down).addScaledVector(fwd, aft);
    _v.copy(angVel).cross(_r).add(velocity);
  }

  function step(h) {
    const c = c0;
    refreshBasis();

    force.set(0, -c.mass * 9.81, 0);
    torque.set(0, 0, 0);

    let wet = 0;
    let sumSub = 0;
    let sumWaterY = 0;
    let sumSx = 0;
    let sumSz = 0;
    let minTurb = 10;
    // Accumulators for a least-squares plane through the probes — see the fit
    // below the buoyancy loop.
    let fSx = 0; let fSz = 0; let fSxx = 0; let fSxz = 0; let fSzz = 0;
    let fSy = 0; let fSxy = 0; let fSzy = 0;

    // --- buoyancy, from the probes riding the real surface ---
    for (let i = 0; i < PROBES.length; i++) {
      const o = PROBES[i];
      _r.copy(stbd).multiplyScalar(o[0]).addScaledVector(up, o[1]).addScaledVector(fwd, o[2]);
      const px = position.x + _r.x;
      const py = position.y + _r.y;
      const pz = position.z + _r.z;

      const h0 = probes.data[i * 4];
      const sx = probes.data[i * 4 + 1];
      const sz = probes.data[i * 4 + 2];
      minTurb = Math.min(minTurb, probes.data[i * 4 + 3]);
      sumSx += sx;
      sumSz += sz;

      // The sample is a frame or two old and taken at a slightly different spot;
      // ride the local surface plane to cover the gap. Bounded, because the
      // plane is only a fair description of the surface very close to the sample.
      const lift = sx * (px - probes.sampleXZ[i * 2]) + sz * (pz - probes.sampleXZ[i * 2 + 1]);
      const waterY = h0 + Math.min(Math.max(lift, -1), 1);
      sumWaterY += waterY;

      const dx = px - position.x;
      const dz = pz - position.z;
      fSx += dx; fSz += dz;
      fSxx += dx * dx; fSxz += dx * dz; fSzz += dz * dz;
      fSy += waterY; fSxy += dx * waterY; fSzy += dz * waterY;

      const sub = Math.min(Math.max(waterY - py, 0), c.maxDepth);
      if (sub <= 0) continue;
      wet++;
      sumSub += sub;

      // Flooding: water in the hull is buoyancy this probe no longer has. It is
      // applied per-probe and weighted by where the water actually is, so
      // compartments flooded forward put her down by the head — she trims and
      // lists on the same solver that already floats her, rather than through a
      // separate "sinking" animation.
      let floodLoss = 0;
      const floodAmount = flooding?.flood ?? flooding?.amount ?? 0;
      if (floodAmount > 0) {
        const zf = o[2] / HULL.length; // -0.5 .. 0.5
        // 1 at the flooded end, tailing off toward the other
        const floodZ = flooding?.floodZ ?? flooding?.z ?? 0;
        const bias = 1 + 2.2 * (zf * Math.sign(floodZ) * Math.min(Math.abs(floodZ) * 6, 1));
        floodLoss = Math.min(1, floodAmount * Math.max(0, bias));
      }
      const buoy = RHO_G * c.probeArea * sub * (1 - floodLoss);
      _v.copy(angVel).cross(_r).add(velocity);
      const frac = sub / c.maxDepth;

      // buoyancy is vertical; the down-slope term stands in for the pressure
      // gradient across a tilted hull, and is what lets the boat surf a face
      _f.set(-buoy * sx * c.slopePush, buoy - c.heaveDamp * _v.y * frac, -buoy * sz * c.slopePush);
      applyAt(_f, _r);
    }

    const wetFrac = wet / PROBES.length;
    const vFwd = velocity.dot(fwd);
    const vLat = velocity.dot(stbd);

    // helm swings toward the wheel at a finite rate, and only that lagged angle
    // ever reaches the water
    const helmAuthority = Math.min(Math.max(capability?.helm ?? 1, 0), 1);
    const wanted = Math.min(Math.max(input.steer, -1), 1)
      * c.maxHelm * helmAuthority * (Math.PI / 180);
    const swing = c.helmRate * (Math.PI / 180) * h;
    helm += Math.min(Math.max(wanted - helm, -swing), swing);

    // Under the handling model none of the horizontal terms below apply: it
    // states surge, sideslip and yaw outright, so resolving forces for them and
    // then overwriting the result would only cost time. Roll damping is still
    // wanted — the sea rolls her whether or not she is being steered — and is
    // applied on its own after this block.
    if (wetFrac > 0 && !handling) {
      // --- surge drag ---
      _f.copy(fwd).multiplyScalar(-c.dragFwd * vFwd * Math.abs(vFwd) * wetFrac);
      force.add(_f);

      // --- distributed lateral resistance ---
      // Each station feels its own sideways flow, which for a turning hull is
      // (drift + yawRate * distance from the CG). Summed, these give the sway
      // and yaw damping and the heeling couple together, all consistent.
      const q = 0.5 * RHO * (c.lateralArea / LATERAL_STATIONS.length) * wetFrac;
      const axialSpeed = Math.abs(vFwd);
      for (let i = 0; i < LATERAL_STATIONS.length; i++) {
        pointVelocity(-c.clrDepth, LATERAL_STATIONS[i]);
        const u = _v.dot(stbd);
        // crossflow drag (quadratic, speed-independent) + foil lift (linear in
        // drift, growing with headway) — the second is what makes her carve
        const fn = -q * (c.lateralCd * u * Math.abs(u) + c.hullLift * u * axialSpeed);
        _f.copy(stbd).multiplyScalar(fn);
        applyAt(_f, _r); // _r was set by pointVelocity
      }

      // --- screw thrust, low and aft so she squats under power ---
      const propulsion = Math.min(Math.max(capability?.propulsion ?? 1, 0), 1);
      const t = input.throttle >= 0 ? input.throttle : input.throttle * c.reverse;
      _f.copy(fwd).multiplyScalar(t * c.thrust * propulsion * wetFrac);
      applyAt(_f, _r.copy(up).multiplyScalar(THRUST_AT[0]).addScaledVector(fwd, THRUST_AT[1]));

      // --- rudder ---
      // A flat-plate foil: the force is normal to the blade and proportional to
      // the flow's component across it, saturating once the blade stalls. Going
      // astern the flow reverses and so does the steering, for free.
      pointVelocity(RUDDER_AT[0], RUDDER_AT[1]);
      const rudderR = _r2.copy(_r);
      const sinH = Math.sin(helm);
      const cosH = Math.cos(helm);
      // ahead thrust drives a race over the blade; astern it blows the other way
      const wash = input.throttle > 0
        ? c.propWash * Math.sqrt((input.throttle * c.thrust * propulsion) / (0.5 * RHO * PROP_DISC))
        : 0;
      const axial = _v.dot(fwd) + wash;
      const lateral = _v.dot(stbd);
      const normal = axial * sinH + lateral * cosH; // flow across the blade
      const speed2 = axial * axial + lateral * lateral;
      const speed = Math.sqrt(speed2);
      const cn = speed > 0.2
        ? Math.min(Math.max((c.rudderLift * normal) / speed, -c.rudderStall), c.rudderStall)
        : 0;
      const fn = 0.5 * RHO * c.rudderArea * cn * speed2 * wetFrac;
      // acts along the blade normal: sideways, plus the drag it costs
      _f.copy(stbd).multiplyScalar(-fn * cosH).addScaledVector(fwd, -fn * sinH);
      applyAt(_f, rudderR);

      // --- roll ---
      // The lateral forces above already act clrDepth below the CG, so she
      // naturally leans out of a turn the way a displacement hull does. A fast
      // hull running on its own lift banks the other way; `bankIn` blends
      // between the two, scaled by how hard she is actually turning.
      const yawUp = angVel.dot(up);
      torque.addScaledVector(fwd, -c.bankIn * c.mass * vFwd * yawUp * c.clrDepth * wetFrac);

      const roll = angVel.dot(fwd);
      torque.addScaledVector(fwd, -c.rollDamp * roll * Math.abs(roll) * wetFrac);

      // drift (leeway) angle: how far the hull is crabbing off its own heading
      state.drift = Math.abs(vFwd) > 0.5 ? (Math.atan2(vLat, Math.abs(vFwd)) * 180) / Math.PI : 0;
    }
    if (wetFrac > 0 && handling) {
      // The sea still rolls her, and that roll still has to be damped, whoever
      // owns the steering.
      const roll = angVel.dot(fwd);
      torque.addScaledVector(fwd, -c.rollDamp * roll * Math.abs(roll) * wetFrac);
    }

    // semi-implicit Euler
    velocity.addScaledVector(force, h / c.mass);

    // torque -> body frame -> angular acceleration -> back to world
    _t.copy(torque).applyQuaternion(_q.copy(quaternion).invert());
    _t.set(
      _t.x / (inertiaPerKg.x * c.mass),
      _t.y / (inertiaPerKg.y * c.mass),
      _t.z / (inertiaPerKg.z * c.mass),
    ).applyQuaternion(quaternion);
    angVel.addScaledVector(_t, h);
    angVel.multiplyScalar(1 / (1 + c.angDamp * h));
    // a hard stop on tumbling: a bad gust of numbers shouldn't barrel-roll it
    if (angVel.lengthSq() > 9) angVel.setLength(3);

    // q += (1/2) w q dt
    _q.set(angVel.x * h * 0.5, angVel.y * h * 0.5, angVel.z * h * 0.5, 0).multiply(quaternion);
    quaternion.set(
      quaternion.x + _q.x, quaternion.y + _q.y, quaternion.z + _q.z, quaternion.w + _q.w,
    ).normalize();

    // The handling model takes the horizontal half of the state from here: it
    // rewrites the surge and sway components of `velocity` and applies its own
    // yaw. It runs before the position integrate, not after, so she is moved by
    // the velocity that is actually hers this substep rather than by last
    // substep's — otherwise the correction lags the motion by a frame and shows
    // up as a hull that visibly settles into a turn a beat late.
    if (handling) {
      const helmAuth = Math.min(Math.max(capability?.helm ?? 1, 0), 1);
      const prop = Math.min(Math.max(capability?.propulsion ?? 1, 0), 1);
      _steer.throttle = input.throttle * prop;
      _steer.steer = input.steer * helmAuth;
      handling.step(h, _steer, { quaternion, velocity });
      refreshBasis();
      // Keep the body's angular velocity in step with the yaw the model just
      // applied. Everything downstream — the probe point velocities, the HUD's
      // rate of turn — reads it, and left stale it would describe a ship
      // turning at a rate she no longer is.
      angVel.addScaledVector(up, -handling.state.yawRate - angVel.dot(up));
      state.drift = handling.state.drift;
      state.helm = handling.state.rudder;
    }

    position.addScaledVector(velocity, h);

    // mean over the probes actually in the water — i.e. the draft, not the
    // deepest corner, which a roll alone can drive to the clamp
    state.submerged = wet ? sumSub / wet : 0;
    state.wet = wet;
    state.foam = minTurb;

    // --- the local water plane the hull shader sits in -------------------------
    //
    // Fitted, not averaged. The obvious thing is to take the mean of the probe
    // heights and the mean of the probe *slopes*, and that is what this did —
    // but a probe's slope is the slope of the actual surface at one point,
    // which on this sea is dominated by whatever ripple happens to be under it.
    // Six of those averaged is not the tilt of the sea under the ship; it is a
    // noisy number of roughly the right size, and it is applied as a lever arm
    // ninety metres long. That is what put an imaginary waterline up the side of
    // the superstructure and slid a hard-edged dark wedge across her every time
    // she pitched.
    //
    // A least-squares plane through the six probe *heights* is the tilt of the
    // sea across the hull by construction: it is the best plane through the
    // points the ship is actually floating on, it ignores ripple between them,
    // and it is what the buoyancy is responding to anyway.
    const n = PROBES.length;
    const det = n * (fSxx * fSzz - fSxz * fSxz)
      - fSx * (fSx * fSzz - fSxz * fSz)
      + fSz * (fSx * fSxz - fSxx * fSz);
    if (Math.abs(det) > 1e-6) {
      const inv = 1 / det;
      state.waterY = inv * (
        fSy * (fSxx * fSzz - fSxz * fSxz)
        - fSx * (fSxy * fSzz - fSxz * fSzy)
        + fSz * (fSxy * fSxz - fSxx * fSzy));
      state.slopeX = inv * (
        n * (fSxy * fSzz - fSzy * fSxz)
        - fSy * (fSx * fSzz - fSxz * fSz)
        + fSz * (fSx * fSzy - fSxy * fSz));
      state.slopeZ = inv * (
        n * (fSxx * fSzy - fSxy * fSxz)
        - fSx * (fSx * fSzy - fSxy * fSz)
        + fSy * (fSx * fSxz - fSxx * fSz));
    } else {
      // degenerate probe layout (collinear in plan) — fall back to the means
      state.waterY = sumWaterY / n;
      state.slopeX = sumSx / n;
      state.slopeZ = sumSz / n;
    }
    state.helm = (helm * 180) / Math.PI;
  }

  // Spray, driven off what the hull is actually doing to the water. Run once per
  // frame rather than per substep — these are rates, and sampling them at the
  // substep rate would just multiply the same event.
  function emitSpray(dt) {
    const s = sprayConfig;
    if (!s.enabled || dt <= 0) return;

    for (let i = 0; i < PROBES.length; i++) {
      const o = PROBES[i];
      _r.copy(stbd).multiplyScalar(o[0]).addScaledVector(up, o[1]).addScaledVector(fwd, o[2]);
      const px = position.x + _r.x;
      const py = position.y + _r.y;
      const pz = position.z + _r.z;

      const lift = probes.data[i * 4 + 1] * (px - probes.sampleXZ[i * 2])
        + probes.data[i * 4 + 2] * (pz - probes.sampleXZ[i * 2 + 1]);
      const waterY = probes.data[i * 4] + Math.min(Math.max(lift, -1), 1);
      const sub = Math.max(waterY - py, 0);

      // Rate of immersion: positive when hull and water are closing on each
      // other, whether that is her falling or a crest rising onto her. This is
      // the quantity that makes a splash.
      const closing = (sub - probeSub[i]) / dt;
      probeSub[i] = sub;

      // velocity of this point through the water
      _v.copy(angVel).cross(_r).add(velocity);
      const vFwd = _v.dot(fwd);
      const vLat = _v.dot(stbd);
      const outboard = Math.sign(o[0]) || 1; // which side of the hull this is

      let n = 0;
      // launch off the hull side at the waterline, not from the probe
      _origin.set(px, waterY, pz).addScaledVector(stbd, SPRAY_BEAM[i] - o[0]);
      _carry.copy(velocity).multiplyScalar(0.35);

      // --- slam: she drops back in, or a wave slams into her ---
      if (closing > s.slamThreshold && sub < 2.5) {
        const impact = closing - s.slamThreshold;
        n = impact * s.slamRate * dt;
        // Up and well outboard. A body entering water throws its root jet up the
        // side it hit and away from itself — straight up just makes a curtain
        // over her own deck.
        _dir.copy(up).multiplyScalar(0.75).addScaledVector(stbd, 0.9 * outboard).normalize();
        emitCount(i, n, _origin, _dir, impact * s.slamJet, 0.75, _carry, 1.25, 2.2);
      }

      // --- shouldering: the bow driving water aside, and the hull throwing it
      // sideways in a skid. Only the part of the hull at the surface does this;
      // deep down it just pushes water, it does not throw it. ---
      if (sub > 0.05 && sub < 1.5) {
        const bow = o[2] > 0 ? 1 : 0.35; // the bow does most of it
        const shoulder = Math.abs(vFwd) * bow + Math.abs(vLat) * 1.1;
        if (shoulder > s.bowThreshold) {
          const over = shoulder - s.bowThreshold;
          n = over * s.bowRate * dt;
          // out and up, and swept aft by her own passage
          const side = Math.abs(vLat) > 0.6 ? Math.sign(vLat) : outboard;
          _dir.copy(stbd).multiplyScalar(side * 0.9)
            .addScaledVector(up, 0.75)
            .addScaledVector(fwd, -0.25)
            .normalize();
          emitCount(i, n, _origin, _dir, over * s.bowSpeed, 0.55, _carry, 1.0, 3.2);
        }
      }
    }

    emitStem(dt);
  }

  // The stem in particular: the probes stop well short of it, but the bow wave
  // is thrown from right at the forefoot, and it is the most visible spray a
  // boat makes. Two sheets, one either side, fanning out and forward.
  function emitStem(dt) {
    const s = sprayConfig;
    const vFwd = velocity.dot(fwd);
    if (vFwd < s.bowThreshold) return;

    const stemZ = 0.46 * HULL.length;
    _r.copy(fwd).multiplyScalar(stemZ);
    const sx = position.x + _r.x;
    const sz = position.z + _r.z;
    // ride the fitted plane out to the stem — it is only a few metres past the
    // forward probes, well inside where the plane is still a fair description
    const waterY = state.waterY + state.slopeX * _r.x + state.slopeZ * _r.z;
    const stemY = position.y + _r.y;
    const sub = waterY - stemY;
    if (sub <= 0.02 || sub > 2.5) return; // out of the water, or buried

    // how much bow is actually in it — a deeply buried stem throws far more
    const bury = Math.min(sub / 1.2, 1.4);
    const n = (vFwd - s.bowThreshold) * bury * s.bowRate * dt;
    _carry.copy(velocity).multiplyScalar(0.3);

    for (const side of [-1, 1]) {
      _origin.set(sx, waterY, sz).addScaledVector(stbd, side * 0.55);
      _dir.copy(stbd).multiplyScalar(side * 1.0)
        .addScaledVector(up, 0.85)
        .addScaledVector(fwd, 0.35)
        .normalize();
      emitCount(STEM_DEBT + (side > 0 ? 0 : 1), n * 0.5, _origin, _dir,
        (vFwd - s.bowThreshold) * s.bowSpeed * bury, 0.5, _carry, 0.9, 2.0);
    }
  }

  // Carry the fractional part over between frames, so a slow trickle still
  // emits instead of rounding to nothing every frame.
  function emitCount(i, n, origin, dir, speed, spread, carry, lifeScale, sheet) {
    sprayDebt[i] += n;
    const whole = Math.floor(sprayDebt[i]);
    if (whole <= 0) return;
    sprayDebt[i] -= whole;
    spray.burst(origin, dir, speed, Math.min(whole, 160), {
      spread,
      carry,
      size: sprayConfig.size,
      life: sprayConfig.life * lifeScale,
      along: fwd, // smear the launch points fore-and-aft into a sheet
      alongScale: sheet,
    });
  }

  function reset() {
    position.set(0, 1.5, 0);
    velocity.set(0, 0, 0);
    quaternion.identity();
    angVel.set(0, 0, 0);
    input.throttle = 0;
    input.steer = 0;
    helm = 0;
    if (handling) { handling.reset(); telegraph.stop(); }
  }

  function update(dt) {
    // fixed substeps: the restoring forces are stiff, and this keeps the boat
    // behaving the same whether the frame took 8 ms or 40
    const steps = Math.min(Math.max(Math.ceil(dt / (1 / 120)), 1), 8);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) step(h);

    if (!Number.isFinite(position.x + position.y + position.z)) reset();

    group.position.copy(position);
    group.quaternion.copy(quaternion);
    // The turn's outward lean, laid on top of the roll the sea gave her. It is
    // applied here rather than through the solver on purpose: a forced roll
    // fought against the buoyancy probes would be a fight the probes win, and
    // the visible result would be a ship that shudders instead of leaning.
    if (handling && handling.state.heel !== 0) {
      _q.setFromAxisAngle(FORWARD_LOCAL, handling.state.heel);
      group.quaternion.multiply(_q);
    }

    // hand the hull shader the water plane it is sitting in
    water.height.value = state.waterY;
    water.slope.value.set(state.slopeX, state.slopeZ);
    water.origin.value.set(position.x, position.z);

    refreshBasis();
    if (spray) emitSpray(dt);

    waterPlane.height = state.waterY;
    waterPlane.slopeX = state.slopeX;
    waterPlane.slopeZ = state.slopeZ;
    waterPlane.originX = position.x;
    waterPlane.originZ = position.z;
    const wd = (params.local.windDirection * Math.PI) / 180;
    _wind.set(Math.cos(wd), 0, Math.sin(wd)).multiplyScalar(params.local.windSpeed * 0.25);
    if (spray) spray.update(dt, waterPlane, _wind);

    // queue next frame's surface query from where the hull now is
    probes.dispatch(position, stbd, up, fwd);
  }

  return {
    group,
    hull: HULL,
    config: c0,
    water, // the fitted local water plane uniforms
    position,
    velocity,
    quaternion,
    // The drawn rotation, which carries the handling model's cosmetic heel on
    // top of the physics one. The ocean's contact wash follows this rather than
    // `quaternion`, so the wash stays glued to the hull you can actually see.
    get visualQuaternion() { return group.quaternion; },
    input,
    handling,
    telegraph,
    update,
    reset,
    state,
    probes,
    spray,
    get speed() { return Math.hypot(velocity.x, velocity.z); },
    get knots() { return Math.hypot(velocity.x, velocity.z) * KT; },
    get heading() { return (Math.atan2(fwd.x, fwd.z) * 180) / Math.PI; },
    get forwardSpeed() { return velocity.dot(fwd); },
    // heel: + is starboard down. trim: + is bow up.
    get heel() { return (Math.asin(Math.min(Math.max(-stbd.y, -1), 1)) * 180) / Math.PI; },
    get trim() { return (Math.asin(Math.min(Math.max(fwd.y, -1), 1)) * 180) / Math.PI; },
    // + is a turn to starboard
    get turnRate() { return (-angVel.dot(up) * 180) / Math.PI; },
  };
}

// WASD helm.
//
// The two hulls are conned differently, because they are different things. The
// launch has a lever: W and S ramp a continuous throttle and A and D ramp a
// wheel. A ship on the handling model has a telegraph: W and S ring down one
// notch each, and the answer comes back over the next few seconds from the
// engine room. Her wheel is put over directly — the rudder's own slew rate is
// already the lag, and ramping the wheel on top of it would only be lag twice.
export function attachBoatControls(boat, { isActive = () => true } = {}) {
  const keys = new Set();
  const editing = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  const telegraph = boat.telegraph;

  addEventListener('keydown', (e) => {
    if (editing(e)) return;
    const k = e.key.toLowerCase();
    if ('wasd'.includes(k)) {
      keys.add(k);
      e.preventDefault();
    }
    if (k === 'r' && isActive()) boat.reset();
    if (telegraph) {
      // one notch per press, not per frame — `repeat` is a held key autofiring
      if (!e.repeat && isActive()) {
        if (k === 'w') telegraph.ring(1);
        else if (k === 's') telegraph.ring(-1);
        else if (k === ' ') telegraph.stop();
      }
      if (k === ' ') e.preventDefault();
      return;
    }
    if (k === ' ') { boat.input.throttle = 0; e.preventDefault(); }
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());

  return function tick(dt) {
    // +steer is starboard helm, so D (turn right) is +1
    const steer = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
    if (telegraph) {
      boat.input.steer = steer; // the rudder's slew rate does the lagging
      return;
    }
    const want = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    const rate = want === 0 ? 1.6 : 0.9; // spools up slower than it backs off
    boat.input.throttle += Math.min(Math.max(want - boat.input.throttle, -rate * dt), rate * dt);
    boat.input.steer += Math.min(Math.max(steer - boat.input.steer, -2.5 * dt), 2.5 * dt);
  };
}
