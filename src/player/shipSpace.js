import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { GRAVITY, PLAYER } from './spec.js';

// A coordinate space in which the ship never moves.
//
// Everything that walks on her is simulated in here, against geometry that has
// zero velocity — the hull loft, the deckhouses, the turrets — while the hull
// itself goes on pitching and rolling in world space. That separation is the
// whole architecture, and it is not a coordinate-maths convenience: collision
// against a *moving* collider is the thing that breaks. Nested transforms are
// the easy part. Take the motion out of the collision problem and the entire
// class of "ping-ponged through the deck at 16 m/s" bugs stops existing,
// because in here the deck is not going anywhere.
//
// The asymmetry to hold on to:
//
//   geometry and position flow FORWARD   local -> world, for rendering
//   motion flows BACKWARD                world -> local, as fictitious forces
//
// Nothing inside this space ever learns where the ship is on the ocean, and it
// does not need to.
//
// What it costs is that ship motion no longer physically affects anyone aboard,
// and has to be put back by hand. That is a feature: the amount of sway becomes
// a number you can turn (`PLAYER.inertiaScale`) rather than an emergent
// property of a solver that, at full fidelity, means nobody can walk anywhere.

const WORLD_DOWN = new Vector3(0, -GRAVITY, 0);
const ONE = new Vector3(1, 1, 1);

// Clamps on the finite differences. A physics substep boundary, a collision
// resolve, or a frame that took 200 ms all show up here as an impulse of
// arbitrary size, and unclamped that is a player fired off the deck by nothing.
//
// The numbers are what a 42,000-tonne hull can actually do, with room to spare:
// she rolls at a fifth of a radian a second and turns at 17 degrees a second,
// and her angular acceleration is two orders below the cap. Anything past these
// is a discontinuity, not a ship.
const MAX_OMEGA = 1.5; // rad/s
const MAX_ACCEL = 25; // m/s^2 — 2.5 g, a very hard wave slam
const MAX_ALPHA = 2.0; // rad/s^2
// And a last backstop on the sum of the fictitious terms, because the two that
// scale with `r` are multiplied by 40 m at the masthead. Two g of apparent
// sideways gravity is already far past anything anyone can stand up in; past
// that it makes no difference to the feel and every difference to whether one
// bad frame throws the crew over the side.
const MAX_FICTITIOUS = 2 * GRAVITY;

const _q = new Quaternion();
const _dq = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();
const _f = new Vector3();

function clampLength(v, max) {
  const l = v.length();
  if (l > max) v.multiplyScalar(max / l);
  return v;
}

// `body` is anything boat-shaped: a world `position`, a `velocity`, and a
// drawn rotation. The *drawn* one is deliberate — a hull leaning into a turn
// leans by a cosmetic roll the solver never sees, and a player standing on her
// deck has to be thrown by the deck they can see, not by the one underneath it.
export function createShipSpace({
  id = 'ship', body, colliders, hull, skipShapes = null,
}) {
  const matrix = new Matrix4();
  const matrixInv = new Matrix4();
  const quat = new Quaternion();
  const quatInv = new Quaternion();
  const prevQuat = new Quaternion();
  const pos = new Vector3();

  const vel = new Vector3(); // world linear velocity of the hull
  const omega = new Vector3(); // world angular velocity, differenced from the drawn rotation
  const accel = new Vector3(); // world linear acceleration
  const alpha = new Vector3(); // world angular acceleration

  // the same four, expressed in the ship's own frame — which is the only frame
  // anything in here cares about
  const gravityLocal = new Vector3(0, -GRAVITY, 0);
  const omegaLocal = new Vector3();
  const alphaLocal = new Vector3();
  const accelLocal = new Vector3();

  let started = false;

  // Call once per frame, after the hull has been stepped in the ocean world and
  // its drawn transform written.
  function syncHull(dt) {
    pos.copy(body.position);
    prevQuat.copy(quat);
    quat.copy(body.visualQuaternion ?? body.quaternion);
    quatInv.copy(quat).invert();
    matrix.compose(pos, quat, ONE);
    matrixInv.copy(matrix).invert();

    if (started && dt > 1e-5) {
      // Angular velocity out of two rotations: the delta quaternion's vector
      // part is half the rotation vector for small angles, which every frame of
      // a ship's roll is. The sign flip keeps it on the short way round.
      _dq.copy(quat).multiply(_q.copy(prevQuat).invert());
      if (_dq.w < 0) { _dq.x = -_dq.x; _dq.y = -_dq.y; _dq.z = -_dq.z; _dq.w = -_dq.w; }
      _w.set(_dq.x, _dq.y, _dq.z).multiplyScalar(2 / dt);
      clampLength(_w, MAX_OMEGA);

      // The buoyancy solver hands out velocities, not accelerations, and the
      // accelerations are what produce the lurch. Difference them, clamp them,
      // and low-pass only lightly: the high-frequency content is the wave slam.
      const k = 1 - Math.exp(-dt / PLAYER.derivativeTau);
      _v.subVectors(_w, omega).divideScalar(dt);
      clampLength(_v, MAX_ALPHA);
      alpha.lerp(_v, k);
      omega.copy(_w);

      _v.subVectors(body.velocity, vel).divideScalar(dt);
      clampLength(_v, MAX_ACCEL);
      accel.lerp(_v, k);
    }
    vel.copy(body.velocity);
    started = true;

    // World-down, expressed in the ship's frame. This one vector does most of
    // the work of making a deck that never moves feel like it is at sea: as she
    // heels, local "down" tilts and everything drifts to leeward.
    gravityLocal.copy(WORLD_DOWN).applyQuaternion(quatInv);
    omegaLocal.copy(omega).applyQuaternion(quatInv);
    alphaLocal.copy(alpha).applyQuaternion(quatInv);
    accelLocal.copy(accel).applyQuaternion(quatInv);
  }

  // Apparent acceleration at a point in the accelerating, rotating hull frame:
  // real gravity plus the fictitious terms a body in that frame actually feels.
  //
  //   g_apparent = R^-1 (g - A)        gravity and linear acceleration
  //                - alpha x r         Euler
  //                - w x (w x r)       centrifugal
  //                - 2 w x v           Coriolis, omitted: nothing at walking speed
  //
  // The two terms in `r` scale with distance from the hull's origin, so they are
  // nothing amidships and considerable at the masthead — which is the right
  // answer, and worth keeping, because it is what makes where you are standing
  // on the ship matter.
  function apparentGravity(r, out) {
    const s = PLAYER.inertiaScale;
    _f.copy(accelLocal).multiplyScalar(-s);
    _f.addScaledVector(_v.crossVectors(alphaLocal, r), -s);
    _f.addScaledVector(_v.crossVectors(omegaLocal, _w.crossVectors(omegaLocal, r)), -s);
    clampLength(_f, MAX_FICTITIOUS);
    return out.copy(gravityLocal).add(_f);
  }

  const toWorld = (local, out) => out.copy(local).applyMatrix4(matrix);
  const toLocal = (world, out) => out.copy(world).applyMatrix4(matrixInv);

  // v_world = v_hull + w x r + R v_local.
  //
  // Dropping the `w x r` term is the classic bug in this architecture: a player
  // who jumps off a hard-turning ship falls straight down instead of being flung
  // off her. On a 180 m hull that term is metres per second at the ends.
  function velocityToWorld(local, localVel, out) {
    _v.copy(local).applyQuaternion(quat);
    out.crossVectors(omega, _v).add(vel);
    return out.add(_w.copy(localVel).applyQuaternion(quat));
  }

  function velocityToLocal(local, worldVel, out) {
    _v.copy(local).applyQuaternion(quat);
    return out.copy(worldVel).sub(vel).sub(_w.crossVectors(omega, _v)).applyQuaternion(quatInv);
  }

  return {
    id,
    body,
    colliders,
    hull,
    // Shapes this space's occupants do not collide with. See colliders.query.
    skipShapes,
    syncHull,
    apparentGravity,
    toWorld,
    toLocal,
    velocityToWorld,
    velocityToLocal,
    matrix,
    quaternion: quat,
    // The ship's frame *is* the top of the chain, so its rotation within its
    // parent and its rotation in the world are the same thing. A space nested
    // inside it — a gunhouse — has to distinguish them.
    worldQuaternion: quat,
    // read-only views for the HUD and for tuning
    hullVel: vel,
    hullOmega: omega,
    hullAccel: accel,
    gravityLocal,
  };
}
