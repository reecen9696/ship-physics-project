import { Matrix4, Vector3 } from 'three/webgpu';
import { createMountSpace } from './mountSpace.js';
import {
  HOUSE, createHouseColliders, insideDoorVolumes, entryVolumes, landing,
} from '../battleship/turretHouse.js';
import { TURRET_SPEC } from '../battleship/spec.js';
import { deckY, zOf } from '../battleship/hull.js';

// A turret you can go inside and lay.
//
// Three things in one place, because they are three views of the same object:
//
//   the space   — the gunhouse's own frame, in which the room never moves
//   the doors   — where you cross between it and the ship
//   the laying  — what happens when you take hold of the gear
//
// The laying is the part with an opinion in it. A gunhouse is fifteen hundred
// tonnes on a roller path and it trains at ten degrees a second; the guns
// elevate at six. Those are the real numbers and they are already in spec.js.
// What is added here is that it cannot *start* at ten degrees a second either:
// the demand and the gun are two different angles, the gun runs a trapezoidal
// profile toward the demand, and the sight shows you both. Laying a gun is
// therefore a matter of leading a target and waiting, which is what laying a gun
// is.

const DEG = Math.PI / 180;
const GRAVITY = 9.81;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

export const LAYING = {
  // How hard the training and elevating engines can push. The rates themselves
  // are TURRET_SPEC's; these are how long it takes to get to them, which is what
  // gives the mount its weight. Roughly a second and a half to full traverse.
  trainAccel: 7, // deg/s^2
  elevAccel: 5, // deg/s^2
  // Radians of demand per pixel of mouse at unit magnification. Divided by the
  // magnification in use, so a pixel is the same *angle on the target* however
  // far you are zoomed in — which is the only way a x36 sight is usable at all.
  sensitivity: 0.10, // deg per pixel
  // Fields of view for x1 / x12 / x36. Not the literal ratios: a true x36 is a
  // degree and a half and you cannot find anything in it. These are the ratios
  // an optic of that power reads as while still leaving you able to search.
  fov: [55, 9.5, 3.4],
  magLabels: ['x1', 'x12', 'x36'],
  reload: 6.0, // seconds. A real 16-inch turret is thirty and nobody would play it.
  spread: 0.13, // degrees of dispersion between the two barrels
  // How hard a full salvo shoves her. Small — she is 42,000 tonnes — but it goes
  // in as a roll impulse on the hull, which means everybody standing on her deck
  // feels the broadside through the inertial layer without anything having to
  // tell them. That is section 8 of the design note paying for itself.
  recoilRoll: 0.010, // rad/s of roll per gun fired abeam
  recoilSurge: 0.05, // m/s
};

const _v = new Vector3();
const _m = new Matrix4();

export function createTurretStation({
  turret, mount, shipSpace, damage,
}) {
  const pivot = new Vector3(0, deckY(turret.z) + turret.deckRise, zOf(turret.z));

  const space = createMountSpace({
    id: turret.id,
    parent: shipSpace,
    pivot,
    // The mount holds its bearing in degrees, positive to starboard, and starboard
    // is -x — so the rotation about local up is the negative of it, the same
    // conversion `apply()` makes in mounts.js.
    getYaw: () => -mount.yaw * DEG,
    colliders: createHouseColliders(),
    hull: null, // no sheer to fall off in here, and no rail to be kept inboard of
  });

  const doorsIn = insideDoorVolumes();
  const doorsOut = entryVolumes(turret, deckY, zOf);

  // --- laying ----------------------------------------------------------------
  const lay = {
    demandYaw: mount.yaw,
    demandElev: 0,
    trainRate: 0,
    elevRate: 0,
    reload: 0,
    held: false,
  };

  // Trapezoidal approach: run at the rate the engine can hold, but never faster
  // than you could still stop in the angle that is left. That is what stops a
  // heavy mount hunting round its demand, and it falls out of one square root.
  function slew(now, demand, rate, rateMax, accel, dt, wrap) {
    const err = wrap ? wrap180(demand - now) : demand - now;
    const stop = Math.sign(err) * Math.sqrt(2 * accel * Math.abs(err));
    const want = clamp(stop, -rateMax, rateMax);
    const next = rate + clamp(want - rate, -accel * dt, accel * dt);
    let pos = now + next * dt;
    // do not step through the demand
    if ((err > 0 && pos > demand && !wrap) || (err < 0 && pos < demand && !wrap)) pos = demand;
    return [pos, next];
  }

  function step(dt) {
    if (lay.reload > 0) lay.reload = Math.max(lay.reload - dt, 0);
    if (!lay.held || mount.destroyed) return;

    lay.demandYaw = mount.arcCenter + clamp(
      wrap180(lay.demandYaw - mount.arcCenter), -mount.arc, mount.arc,
    );
    lay.demandElev = clamp(lay.demandElev, mount.elevMin, mount.elevMax);

    const [y, ry] = slew(mount.yaw, lay.demandYaw, lay.trainRate,
      TURRET_SPEC.traverseRate, LAYING.trainAccel, dt, true);
    const [e, re] = slew(mount.elev, lay.demandElev, lay.elevRate,
      TURRET_SPEC.elevateRate, LAYING.elevAccel, dt, false);
    lay.trainRate = ry;
    lay.elevRate = re;
    mount.yaw = y;
    mount.elev = e;
    // Keep the mount's own target in step, so letting go of the gear does not
    // hand her back to the fire-control model pointing somewhere she is not.
    mount.targetYaw = y;
    mount.targetElev = e;
    mount.apply();
  }

  // Where a shell fired now would fall, if it fell the whole way there:
  // R = v^2 sin(2θ) / g. This is the number on the AIM DISTANCE plate, and it is
  // why elevation is the range control — you wind the gun up until the plate
  // reads what the target is at.
  const rangeAt = (elevDeg, speed) => (elevDeg <= 0
    ? 0
    : (speed * speed * Math.sin(2 * elevDeg * DEG)) / GRAVITY);

  // --- the sight -------------------------------------------------------------
  //
  // The eye goes in the sighting hood on the gunhouse roof, and it looks along
  // the guns: the sight is geared to them, so it moves at their rate and not at
  // the mouse's. That lag *is* the feel of the thing.
  const _eye = new Vector3();
  const _dir = new Vector3();
  const _up = new Vector3();
  const _tgt = new Vector3();

  function sight(camera) {
    space.toWorld(_v.copy(HOUSE.sight), _eye);
    // The gun axis in the turret's own frame, composed out to the sea in one
    // step — a gunhouse only yaws, so its up and the ship's are the same vector
    // and the sight's horizon rolls with her the way a bolted-down sight must.
    _dir.set(0, Math.sin(mount.elev * DEG), Math.cos(mount.elev * DEG))
      .applyQuaternion(space.worldQuaternion);
    _up.set(0, 1, 0).applyQuaternion(space.worldQuaternion);
    camera.position.copy(_eye);
    _tgt.copy(_eye).add(_dir);
    _m.lookAt(_eye, _tgt, _up);
    camera.quaternion.setFromRotationMatrix(_m);
    return { eye: _eye, dir: _dir };
  }

  // How far the demand is off the guns, as a fraction of the vertical field —
  // which is what the sight needs to put the pip in the right place, and is
  // magnification-independent by construction.
  function demandOffset(fovDeg) {
    return {
      dx: wrap180(lay.demandYaw - mount.yaw) / fovDeg,
      dy: (lay.demandElev - mount.elev) / fovDeg,
    };
  }

  return {
    id: turret.id,
    turret,
    mount,
    space,
    lay,
    step,
    sight,
    demandOffset,
    rangeAt,
    doorsIn,
    doorsOut,
    landing,
    pivot,
    alive: () => !mount.destroyed && damage.alive(turret.id),
    // The layer's station, and how close you have to be to put a hand on it.
    // Measured to the middle of the pedestal, which you cannot stand in — so the
    // reach has to cover walking up to any face of it.
    station: new Vector3(HOUSE.station.x, HOUSE.floor, HOUSE.station.z),
    reach: 1.7,
  };
}
