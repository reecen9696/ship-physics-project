import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { PLAYER } from './spec.js';

// A space inside a space.
//
// The ship is a space on the ocean because collision against a moving collider
// is the thing that breaks. A gunhouse is a space inside the ship for the same
// reason and at the same scale of the same problem: it trains at ten degrees a
// second, which eight metres off the axis is a metre and a half a second of deck
// going sideways under somebody's feet. Nothing about that is different in kind
// from a hull rolling; it is the same failure one level down, and it takes the
// same answer.
//
// So the chain is
//
//     worldPose = M_hull . M_turret . localPose
//
// and it composes exactly the way it reads. Geometry and position flow forward
// through it; motion flows backward through it as fictitious forces, the ship's
// arriving already-summed from the parent and this frame's own added on top.
//
// The turret's own contribution is small — a tenth of a radian a second, a few
// metres of lever — and it is included anyway, because it is four lines and
// because the lurch when a 1500-tonne gunhouse starts and stops is a real thing
// to feel while you are standing in it.
//
// Unlike the hull, this frame's motion is *known* rather than measured: the
// mount is asked what bearing it is at. Only the rate has to be differenced.

const _v = new Vector3();
const _w = new Vector3();
const _f = new Vector3();
const ONE = new Vector3(1, 1, 1);
const UP = new Vector3(0, 1, 0);

const MAX_ALPHA = 6; // rad/s^2 — a gunhouse cannot start faster than this
const MAX_FICTITIOUS = 2 * 9.81;

// `pivot` is where this frame's origin sits in the parent's frame, and
// `getYaw()` its bearing about the parent's up axis in radians. That is the whole
// of the attachment: a turret does not translate and does not tip.
export function createMountSpace({
  id, parent, pivot, getYaw, colliders, hull,
}) {
  const quat = new Quaternion(); // this frame's rotation *within the parent*
  const quatInv = new Quaternion();
  const worldQuat = new Quaternion(); // and the same thing composed out to the sea
  const matrix = new Matrix4(); // local -> parent
  const matrixInv = new Matrix4();
  const origin = new Vector3().copy(pivot);

  const omega = new Vector3(); // rad/s about local up
  const alpha = new Vector3();
  let prevRate = 0;
  let prevYaw = getYaw();
  let yawNow = prevYaw;
  let started = false;

  // The parent's apparent gravity at our origin, expressed in our frame, plus
  // our own terms. Reused every query, so it is worked out once a frame.
  const parentGravity = new Vector3(0, -9.81, 0);

  function syncHull(dt) {
    const yaw = getYaw();
    yawNow = yaw;
    quat.setFromAxisAngle(UP, yaw);
    quatInv.copy(quat).invert();
    worldQuat.copy(parent.worldQuaternion).multiply(quat);
    matrix.compose(origin, quat, ONE);
    matrixInv.copy(matrix).invert();

    if (started && dt > 1e-5) {
      let d = yaw - prevYaw;
      // shortest way round, in case a mount is ever allowed to cross the back
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const rate = d / dt;
      const a = (rate - prevRate) / dt;
      omega.set(0, rate, 0);
      alpha.set(0, Math.min(Math.max(a, -MAX_ALPHA), MAX_ALPHA), 0);
      prevRate = rate;
    }
    prevYaw = yaw;
    started = true;
  }

  // Called once a frame after syncHull, with the parent already synced: caches
  // the parent's apparent gravity at our pivot, rotated into our frame. Doing it
  // per-query would mean walking the whole chain for every player.
  function refresh() {
    parent.apparentGravity(origin, parentGravity);
    parentGravity.applyQuaternion(quatInv);
  }

  function apparentGravity(r, out) {
    const s = PLAYER.inertiaScale;
    // Euler and centrifugal about the training axis. No linear term: the pivot
    // does not move in the ship, so the only acceleration of this frame's origin
    // is the ship's own, and that arrived inside `parentGravity`.
    _f.copy(_v.crossVectors(alpha, r)).multiplyScalar(-s);
    _f.addScaledVector(_v.crossVectors(omega, _w.crossVectors(omega, r)), -s);
    const l = _f.length();
    if (l > MAX_FICTITIOUS) _f.multiplyScalar(MAX_FICTITIOUS / l);
    return out.copy(parentGravity).add(_f);
  }

  const toParent = (local, out) => out.copy(local).applyMatrix4(matrix);
  const fromParent = (p, out) => out.copy(p).applyMatrix4(matrixInv);

  const toWorld = (local, out) => parent.toWorld(toParent(local, out), out);
  const toLocal = (world, out) => fromParent(parent.toLocal(world, out), out);

  // v_parent = w x r + R v_local. The parent then composes its own on top, so a
  // man who jumps out of a training turret off a turning ship carries both.
  const _pp = new Vector3();
  const _pv = new Vector3();

  function velocityToParent(local, localVel, out) {
    _v.copy(local).applyQuaternion(quat);
    out.crossVectors(omega, _v);
    return out.add(_w.copy(localVel).applyQuaternion(quat));
  }

  function velocityToWorld(local, localVel, out) {
    velocityToParent(local, localVel, _pv);
    toParent(local, _pp);
    return parent.velocityToWorld(_pp, _pv, out);
  }

  // Going the other way, across the doorway.
  function velocityFromParent(local, parentVel, out) {
    _v.copy(local).applyQuaternion(quat);
    return out.copy(parentVel).sub(_w.crossVectors(omega, _v)).applyQuaternion(quatInv);
  }

  return {
    id,
    parent,
    colliders,
    hull,
    syncHull,
    refresh,
    apparentGravity,
    toWorld,
    toLocal,
    toParent,
    fromParent,
    velocityToWorld,
    velocityToParent,
    velocityFromParent,
    // This frame's bearing within its parent. Anything crossing the boundary has
    // to turn by it: a man facing the bow on deck is facing something else once
    // he is standing in a turret that has trained thirty degrees.
    get yaw() { return yawNow; },
    get quaternion() { return quat; },
    get worldQuaternion() { return worldQuat; },
    matrix,
    origin,
    omega,
  };
}
