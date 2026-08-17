import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { createMountSpace } from './mountSpace.js';
import {
  HOUSE, createHouseColliders, insideDoorVolumes, entryVolumes, landing, chamberStation,
} from '../battleship/turretHouse.js';
import { TURRET_SPEC } from '../battleship/spec.js';
import { deckY, zOf } from '../battleship/hull.js';
import { rangeFor } from '../battleship/ballistics.js';

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
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

export const LAYING = {
  // How hard the training and elevating engines can push. The rates themselves
  // are TURRET_SPEC's; these are how long it takes to get to them, which is what
  // gives the mount its weight. Roughly a second and a half to full traverse.
  trainAccel: 7, // deg/s^2
  elevAccel: 5, // deg/s^2
  // Degrees of demand per pixel of mouse at unit magnification. Divided by the
  // magnification in use, so a pixel is the same *angle on the target* however
  // far you are zoomed in — which is the only way a x36 sight is usable at all.
  sensitivity: 0.16, // deg per pixel

  // How far the demand may run ahead of the guns.
  //
  // This is the number that decides whether laying a turret feels like laying a
  // turret. Without it the mouse sets an angle anywhere on the horizon and the
  // gunhouse then grinds off after it for ten seconds, which is not a control —
  // it is an order you cannot take back. Clamped to a few degrees of lead, the
  // mouse stops being a pointer and becomes a handwheel: push it and the demand
  // pegs at the limit and the mount runs at its full rate; hold it there and it
  // keeps running; let go and the mount closes the last few degrees and stops.
  // The pip in the sight is then a *rate* indicator, which is what a follow-the-
  // pointer dial on a real mount is.
  lead: { train: 7, elev: 3.5 }, // degrees

  // How much of the ship's motion the gear takes out for you.
  //
  // The demand is held as a bearing and an elevation *in the world*, not in the
  // ship — so when she rolls four degrees, the mount is asked for four degrees
  // the other way and the sight stays on the target. That is what a stabilised
  // sight is, and without it laying a gun in any sea at all is impossible: at
  // x12 a two-degree roll swings the whole field twice over.
  //
  // Full. The sight is a gyro sight: it holds the line you gave it and the sea
  // does not move it, full stop. What the sea still does is make the *guns* lag
  // — the elevating gear does six degrees a second and a heavy roll asks for
  // more — so in a big sea the pip wanders off the cross and you wait for it to
  // come back before you fire. That is the honest version of the difficulty, and
  // it is a much better one than a horizon that will not sit still.
  stabilise: 1.0,
  // Below this the gear does not answer at all, so a hand resting on the mouse
  // does not walk fifteen hundred tonnes across the horizon.
  deadband: 0.15, // degrees
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
const _d = new Vector3();
const UP = new Vector3(0, 1, 0);
const _qi = new Quaternion();

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

  // Where the layer stands, and how you get to him.
  //
  // Two different answers for two different structures. A turret sitting on the
  // deck has its room in the gunhouse: that room *trains*, so it is the mount's
  // space, and getting in is a space transition through a door in the side. A
  // turret on a bandstand has its room in the bandstand: that does not train, so
  // it is part of the ship exactly as the deck is, and getting in is walking
  // through a passage. Nothing is handed anywhere and nothing is teleported.
  //
  // The mount space above exists either way, because the *sight* needs it: the
  // eye goes in a hood on the gunhouse roof and looks along the guns, and that is
  // a turret-frame question however the room below is arranged.
  const onBandstand = turret.bandstand > 0;
  // Which way the layer faces. A gunhouse room is in the turret's own frame and
  // always points along the guns; a working chamber is in the ship's, so an
  // after turret's is mirrored.
  const stationFacing = onBandstand && Math.abs(turret.arcCenter) > 90 ? -1 : 1;
  const room = onBandstand
    ? {
      space: shipSpace,
      station: chamberStation(turret),
      doorsIn: [],
      doorsOut: [],
      landing: null,
    }
    : {
      space,
      station: new Vector3(HOUSE.station.x, HOUSE.floor, HOUSE.station.z),
      doorsIn: insideDoorVolumes(),
      doorsOut: entryVolumes(turret, deckY, zOf),
      landing,
    };

  // --- laying ----------------------------------------------------------------
  //
  // The demand lives in *world* angles — a compass bearing and an elevation off
  // the horizon — and is converted into mount angles every frame against the
  // ship's current attitude. That one choice is the whole of the stabilisation:
  // roll her and the ship-frame demand moves without anybody touching the mouse,
  // and the gear goes after it.
  const lay = {
    demandBearing: 0, // deg, world, 0 = along +z
    demandPitch: 0, // deg, off the horizon
    demandYaw: mount.yaw, // the same thing in the ship's frame, for the pip
    demandElev: 0,
    trainRate: 0,
    elevRate: 0,
    reload: 0,
    held: false,
  };

  // world (bearing, pitch) -> the mount's own (yaw, elev), against her attitude
  function worldToMount(bearing, pitch, out) {
    const b = bearing * DEG;
    const p = pitch * DEG;
    _d.set(Math.sin(b) * Math.cos(p), Math.sin(p), Math.cos(b) * Math.cos(p));
    _qi.copy(shipSpace.worldQuaternion).invert();
    _d.applyQuaternion(_qi);
    // +yaw is to starboard, which is -x — the same convention mounts.js applies
    out.yaw = Math.atan2(-_d.x, _d.z) / DEG;
    out.elev = Math.asin(clamp(_d.y, -1, 1)) / DEG;
    return out;
  }

  // and back again, so a demand the arc or the lead had to clamp does not keep
  // straining against its limit for ever
  function mountToWorld(yaw, elev, out) {
    _d.set(0, Math.sin(elev * DEG), Math.cos(elev * DEG));
    _d.applyAxisAngle(UP, -yaw * DEG);
    _d.applyQuaternion(shipSpace.worldQuaternion);
    out.bearing = Math.atan2(_d.x, _d.z) / DEG;
    out.pitch = Math.asin(clamp(_d.y, -1, 1)) / DEG;
    return out;
  }

  const _want = { yaw: 0, elev: 0 };
  const _back = { bearing: 0, pitch: 0 };

  // Trapezoidal approach: run at the rate the engine can hold, but never faster
  // than you could still stop in the angle that is left. That is what stops a
  // heavy mount hunting round its demand, and it falls out of one square root.
  function slew(now, demand, rate, rateMax, accel, dt, wrap) {
    const err = wrap ? wrap180(demand - now) : demand - now;
    if (Math.abs(err) < LAYING.deadband && Math.abs(rate) < 0.05) return [now, 0];
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

    // Where the world-frame demand lands on the mount right now, given how she
    // is lying. Blended against the raw ship-frame demand by `stabilise`, so the
    // gear takes out most of the sea and leaves a little of it.
    worldToMount(lay.demandBearing, lay.demandPitch, _want);
    const k = LAYING.stabilise;
    lay.demandYaw += wrap180(_want.yaw - lay.demandYaw) * k;
    lay.demandElev += (_want.elev - lay.demandElev) * k;

    // Hold the demand inside the arc and the elevation limits...
    lay.demandYaw = mount.arcCenter + clamp(
      wrap180(lay.demandYaw - mount.arcCenter), -mount.arc, mount.arc,
    );
    lay.demandElev = clamp(lay.demandElev, mount.elevMin, mount.elevMax);
    // ...and then inside a few degrees of the guns, which is what turns the
    // mouse into a handwheel rather than a pointer. See LAYING.lead.
    lay.demandYaw = mount.yaw + clamp(
      wrap180(lay.demandYaw - mount.yaw), -LAYING.lead.train, LAYING.lead.train,
    );
    lay.demandElev = mount.elev + clamp(
      lay.demandElev - mount.elev, -LAYING.lead.elev, LAYING.lead.elev,
    );

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

    // Put the clamped demand back into world angles. Without this a demand that
    // ran into the end of the arc keeps pushing at it for ever, and the moment
    // she rolls the other way the sight jumps.
    mountToWorld(lay.demandYaw, lay.demandElev, _back);
    lay.demandBearing = _back.bearing;
    lay.demandPitch = _back.pitch;
  }

  // Called when the gear is taken: start from wherever the guns are pointing, in
  // world angles, or the first thing stabilisation does is chase a bearing
  // nobody asked for.
  function sync() {
    mountToWorld(mount.yaw, mount.elev, _back);
    lay.demandBearing = _back.bearing;
    lay.demandPitch = _back.pitch;
    lay.demandYaw = mount.yaw;
    lay.demandElev = mount.elev;
    lay.trainRate = 0;
    lay.elevRate = 0;
  }

  // Where a shell fired now would fall, and how long it would take to get
  // there. Off the firing table in ballistics.js — the same integrator the shell
  // itself flies on, so the plate cannot lie about the gun. It used to be the
  // schoolbook v^2 sin(2θ)/g, which ignores the air and reads two kilometres
  // long at full elevation.
  //
  // This is why elevation is the range control: you wind the gun up until the
  // plate says what the target is at, and the flight time under it is how long
  // you will be waiting to find out whether you were right.
  const rangeAt = (elevDeg) => rangeFor(elevDeg).range;
  const flightTime = (elevDeg) => rangeFor(elevDeg).tof;

  // --- the sight -------------------------------------------------------------
  //
  // The eye goes in the sighting hood on the gunhouse roof, and it looks along
  // the *stabilised line* — not along the guns.
  //
  // That is the whole point of a gyro sight and it took getting wrong to see it:
  // hang the sight off the barrels and every roll of the ship swings the field,
  // because the elevating gear cannot keep up with a sea. Hang it off the line
  // you asked for and it is rock steady, level with the horizon, and the lag
  // shows up where it belongs — as the guns trailing behind the cross, which the
  // pip draws for you. You can then see exactly when they are on.
  const _eye = new Vector3();
  const _dir = new Vector3();
  const _up = new Vector3();
  const _tgt = new Vector3();

  function sight(camera) {
    space.toWorld(_v.copy(HOUSE.sight), _eye);
    // the line she is laid on, in world angles, and world up so the horizon is
    // level whatever the ship is doing
    const b = lay.demandBearing * DEG;
    const p = lay.demandPitch * DEG;
    _dir.set(Math.sin(b) * Math.cos(p), Math.sin(p), Math.cos(b) * Math.cos(p));
    _up.set(0, 1, 0);
    camera.position.copy(_eye);
    _tgt.copy(_eye).add(_dir);
    _m.lookAt(_eye, _tgt, _up);
    camera.quaternion.setFromRotationMatrix(_m);
    return { eye: _eye, dir: _dir };
  }

  // How far the *guns* are off the sight line, as a fraction of the vertical
  // field. The cross is where the sight is looking; the pip is where the shells
  // will actually go. When they sit on top of each other, fire.
  function demandOffset(fovDeg) {
    return {
      dx: -wrap180(lay.demandYaw - mount.yaw) / fovDeg,
      dy: -(lay.demandElev - mount.elev) / fovDeg,
    };
  }

  return {
    id: turret.id,
    turret,
    mount,
    space,
    lay,
    step,
    sync,
    sight,
    demandOffset,
    rangeAt,
    flightTime,
    room,
    onBandstand,
    doorsIn: room.doorsIn,
    doorsOut: room.doorsOut,
    landing: room.landing,
    pivot,
    alive: () => !mount.destroyed && damage.alive(turret.id),
    // How close you have to be to put a hand on the gear. Measured to the middle
    // of the console, which you cannot stand in, so the reach has to cover
    // walking up to any face of it.
    station: room.station,
    reach: 1.9,
    // Where to stand to work it: a pace *behind* the console, facing it. Not
    // inboard of it — inboard of a gunhouse console is inside the starboard
    // breech, which is a metre and a half of gun and would shove you back out
    // again the moment you arrived.
    approach: new Vector3(
      room.station.x, room.station.y, room.station.z - stationFacing * 1.15,
    ),
    approachHeading: stationFacing > 0 ? 0 : Math.PI,
  };
}
