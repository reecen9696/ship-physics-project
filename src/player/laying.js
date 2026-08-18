import { Quaternion, Vector3 } from 'three/webgpu';

// The arithmetic every gun on this ship is laid by.
//
// Two mounts now put a player behind a sight and they are very different
// machines — a fifteen-hundred-tonne gunhouse with a gyro sight, and an open AA
// mounting that swings with the sea — but the three sums underneath are the
// same ones, and they are here so the two cannot come apart on the conventions.
//
// The conventions, once, since getting either of them backwards is a gun that
// trains the wrong way and looks almost right:
//
//   yaw       degrees, 0 dead ahead, positive to starboard — which is -x
//   elevation degrees off the mount's own horizontal, positive up
//   bearing   the same, but in the *world*: 0 along +z, positive to starboard
//
// The world pair and the mount pair are the same line written in two frames, and
// converting between them against the ship's live attitude is the whole of what
// a stabilised sight is. A mount whose sight is *not* stabilised simply never
// makes the conversion in that direction — see aaStation.js.

export const DEG = Math.PI / 180;
export const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
export const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

const _d = new Vector3();
const _qi = new Quaternion();
const UP = new Vector3(0, 1, 0);

// world (bearing, pitch) -> the mount's own (yaw, elev), against her attitude
export function worldToMount(space, bearing, pitch, out) {
  const b = bearing * DEG;
  const p = pitch * DEG;
  _d.set(Math.sin(b) * Math.cos(p), Math.sin(p), Math.cos(b) * Math.cos(p));
  _qi.copy(space.worldQuaternion).invert();
  _d.applyQuaternion(_qi);
  out.yaw = Math.atan2(-_d.x, _d.z) / DEG;
  out.elev = Math.asin(clamp(_d.y, -1, 1)) / DEG;
  return out;
}

// and back again, so a demand the arc or the cut-out had to clamp does not keep
// straining against its limit for ever
export function mountToWorld(space, yaw, elev, out) {
  _d.set(0, Math.sin(elev * DEG), Math.cos(elev * DEG));
  _d.applyAxisAngle(UP, -yaw * DEG);
  _d.applyQuaternion(space.worldQuaternion);
  out.bearing = Math.atan2(_d.x, _d.z) / DEG;
  out.pitch = Math.asin(clamp(_d.y, -1, 1)) / DEG;
  return out;
}

// The direction a bearing and a pitch point in, in the world. What the sight
// camera looks along, and what a shell would leave along if the gun were on.
export function lineOf(bearing, pitch, out) {
  const b = bearing * DEG;
  const p = pitch * DEG;
  return out.set(Math.sin(b) * Math.cos(p), Math.sin(p), Math.cos(b) * Math.cos(p));
}

// Trapezoidal approach: run at the rate the engine can hold, but never faster
// than you could still stop in the angle that is left. That is what stops a
// heavy mount hunting round its demand, and it falls out of one square root.
//
// It is right for the light mounting too, and for a reason worth stating: an
// automatic that snapped instantly onto its demand would make the pip useless
// and the gun a laser pointer. What makes tracking a *skill* is that the mount
// is always a little behind the hand, whether that little is four degrees or a
// quarter of one.
export function slew(now, demand, rate, rateMax, accel, dt, wrap, deadband) {
  const err = wrap ? wrap180(demand - now) : demand - now;
  if (Math.abs(err) < deadband && Math.abs(rate) < 0.05) return [now, 0];
  const stop = Math.sign(err) * Math.sqrt(2 * accel * Math.abs(err));
  const want = clamp(stop, -rateMax, rateMax);
  const next = rate + clamp(want - rate, -accel * dt, accel * dt);
  let pos = now + next * dt;
  // do not step through the demand
  if ((err > 0 && pos > demand && !wrap) || (err < 0 && pos < demand && !wrap)) pos = demand;
  return [pos, next];
}
