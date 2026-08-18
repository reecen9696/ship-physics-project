import { Euler, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { createMountSpace } from './mountSpace.js';
import {
  HOUSE, createHouseColliders, insideDoorVolumes, entryVolumes, landing, chamberStation,
} from '../battleship/turretHouse.js';
import { TURRET_SPEC } from '../battleship/spec.js';
import { deckY, zOf } from '../battleship/hull.js';
import { rangeFor } from '../battleship/ballistics.js';
import {
  DEG, wrap180, clamp, worldToMount, mountToWorld, slew,
} from './laying.js';

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

  // --- why the sight is not tied to the guns ---------------------------------
  //
  // There used to be a `lead` here: a few degrees past which the demand was not
  // allowed to run ahead of the mount, on the argument that it turned the mouse
  // from a pointer into a handwheel. It did — and it also meant the *sight* was
  // on a seven-degree leash, because the sight looks along the demand. Move the
  // mouse quickly and the cross stopped dead at the end of the leash and crawled
  // along at the mount's ten degrees a second, so the whole field of view moved
  // like the turret rather than like your hand. That is the thing that made this
  // feel bad, and no amount of tuning the leash fixes it: any leash at all ties
  // the picture to the machinery.
  //
  // So there is no leash. The sight is a free line you lay with the mouse at
  // whatever speed you move it, bounded only by where the mount could physically
  // point; the guns then chase it at the rate the engines can hold. That is both
  // the better control and the more honest one — it is what a layer does, and
  // the lag he is fighting is the gun's, not his own hand's.
  //
  // What is lost is the handwheel's rate cue, and the pip gives it back better:
  // it is now the gun's true offset from the line you are on, so a long way off
  // is a long way off, and it walking in is the mount catching up.

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
  // How hard a salvo shoves her is not a number here any more. It is the round's
  // momentum and its propellant gas landed on the hull at the muzzle, through
  // Boat.impulseAt — see fireSalvo in main.js. The two constants this replaced
  // were dialled by eye and rolled her about five times too hard.

  // --- what the layer feels ---------------------------------------------------
  //
  // The guns coming back is drawn on the guns (muzzleBlast.js), and from every
  // position on the ship except one you can watch it happen. The exception is
  // the one the player is standing in: his eye is in a hood on the gunhouse roof
  // a couple of metres behind the trunnions, looking along the barrels, so the
  // whole of that metre and a bit of travel is foreshortened down the view axis
  // into almost nothing. From the sight, the most violent moving part on the
  // ship reads as a flicker.
  //
  // What he would actually get is the mounting throwing his head. Two sixteen-
  // inch guns going off inside a gunhouse he is bolted to is not a subtle event,
  // and it is the cue that says the gun fired rather than that a light came on.
  // So the eye is kicked and rings down over about half a second.
  //
  // The *line* is not touched. This is a gyro sight: it holds the bearing it was
  // given and the gun cannot argue with it — which is also the only playable
  // choice, since knocking the aim off every salvo would make laying impossible.
  // The picture shakes; the aim does not.
  shock: {
    pitch: 5.2, // degrees of kick at the eye
    yaw: 1.4, // and a little across, because the two guns are not symmetrical
    heave: 0.28, // m the eye is thrown back along the line of fire
    freq: 8.5, // Hz of the ringing
    decay: 6.5, // per second
  },
};

const _v = new Vector3();
const _m = new Matrix4();
const _kick = new Vector3();
const _qk = new Quaternion();
const _eu = new Euler();

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
    // Where the layer is looking. The mouse writes these directly, at whatever
    // speed he moves it, and nothing else touches them except the arc limits.
    sightBearing: 0, // deg, world, 0 = along +z
    sightPitch: 0, // deg, off the horizon
    // The same line in the mount's own frame, which is what the guns are asked
    // for. Not an independent quantity — it *is* the sight, converted.
    demandYaw: mount.yaw,
    demandElev: 0,
    trainRate: 0,
    elevRate: 0,
    reload: 0,
    held: false,
  };

  const _want = { yaw: 0, elev: 0 };
  const _back = { bearing: 0, pitch: 0 };

  // The gun going off, as the man at the sight has it. `t` runs from the instant
  // of firing; `mag` scales with how many barrels went at once.
  const shock = { t: 1e3, mag: 0 };
  function jolt(strength = 1) {
    shock.t = 0;
    shock.mag = Math.max(shock.mag, strength);
  }

  function step(dt) {
    if (lay.reload > 0) lay.reload = Math.max(lay.reload - dt, 0);
    // Ahead of the early return: the mounting goes on ringing whether or not he
    // still has hold of the gear.
    if (shock.mag > 0) {
      shock.t += dt;
      if (shock.t > 1.2) shock.mag = 0;
    }
    if (!lay.held || mount.destroyed) return;

    // Where the sight line lands on the mount right now, given how she is
    // lying. Blended by `stabilise`, so the gear takes out most of the sea and
    // can be made to leave a little of it.
    worldToMount(shipSpace, lay.sightBearing, lay.sightPitch, _want);
    const k = LAYING.stabilise;
    lay.demandYaw += wrap180(_want.yaw - lay.demandYaw) * k;
    lay.demandElev += (_want.elev - lay.demandElev) * k;

    // The only thing that bounds the sight is where the mount could point: the
    // training arc and the elevation limits. Push past either and the cross
    // stops there — the layer is looking through a hood on the gunhouse, and
    // there is nowhere for it to look that the gunhouse cannot go.
    const yawFree = lay.demandYaw;
    const elevFree = lay.demandElev;
    lay.demandYaw = mount.arcCenter + clamp(
      wrap180(lay.demandYaw - mount.arcCenter), -mount.arc, mount.arc,
    );
    lay.demandElev = clamp(lay.demandElev, mount.elevMin, mount.elevMax);
    // If either bit, put the clamped line back into world angles so the sight
    // does not keep straining against a limit it cannot pass — otherwise the
    // moment she rolls the other way the cross jumps by everything the mouse
    // pushed into the stop while it was there.
    if (lay.demandYaw !== yawFree || lay.demandElev !== elevFree) {
      mountToWorld(shipSpace, lay.demandYaw, lay.demandElev, _back);
      lay.sightBearing = _back.bearing;
      lay.sightPitch = _back.pitch;
    }

    const [y, ry] = slew(mount.yaw, lay.demandYaw, lay.trainRate,
      TURRET_SPEC.traverseRate, LAYING.trainAccel, dt, true, LAYING.deadband);
    const [e, re] = slew(mount.elev, lay.demandElev, lay.elevRate,
      TURRET_SPEC.elevateRate, LAYING.elevAccel, dt, false, LAYING.deadband);
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

  // Called when the gear is taken: start from wherever the guns are pointing, in
  // world angles, or the first thing stabilisation does is chase a bearing
  // nobody asked for.
  function sync() {
    mountToWorld(shipSpace, mount.yaw, mount.elev, _back);
    lay.sightBearing = _back.bearing;
    lay.sightPitch = _back.pitch;
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
    const b = lay.sightBearing * DEG;
    const p = lay.sightPitch * DEG;
    _dir.set(Math.sin(b) * Math.cos(p), Math.sin(p), Math.cos(b) * Math.cos(p));
    _up.set(0, 1, 0);
    camera.position.copy(_eye);
    _tgt.copy(_eye).add(_dir);
    _m.lookAt(_eye, _tgt, _up);
    camera.quaternion.setFromRotationMatrix(_m);

    // ...and then the mounting throws his head. Applied to the camera *after*
    // the line is laid, and to nothing else: `lay` is untouched, so when it has
    // rung down the sight is on exactly the bearing it was on when the gun went.
    // Cosine rather than sine so the first frame is the full kick — a shock that
    // starts at nothing and builds is a wobble, not a bang.
    if (shock.mag > 0) {
      const S = LAYING.shock;
      const e = Math.exp(-S.decay * shock.t) * shock.mag;
      const ring = Math.cos(2 * Math.PI * S.freq * shock.t) * e;
      _kick.set(S.pitch * DEG * ring, S.yaw * DEG * ring * 0.6, 0);
      _qk.setFromEuler(_eu.set(_kick.x, _kick.y, 0, 'XYZ'));
      camera.quaternion.multiply(_qk);
      // and shoved bodily back down the line of fire, which is the half of it
      // you feel in your neck rather than see
      camera.position.addScaledVector(_dir, -S.heave * e);
    }
    return { eye: _eye, dir: _dir };
  }

  // How far the *guns* are off the sight line, as a fraction of the vertical
  // field. The cross is where the sight is looking; the pip is where the shells
  // will actually go. When they sit on top of each other, fire.
  //
  // With no leash on the sight the guns can be most of an arc behind it, which
  // is a pip several screens off the glass and therefore no pip at all. So it is
  // held at the rim when it runs out of field and flagged `far`, and the sight
  // draws that as a bearing to the guns rather than as their position. You still
  // get the one thing that matters — which way they are coming from, and that
  // they are still coming.
  const PIP_RIM = 0.45; // fractions of the vertical field, just inside the glass

  function demandOffset(fovDeg) {
    const dx = -wrap180(lay.demandYaw - mount.yaw) / fovDeg;
    const dy = -(lay.demandElev - mount.elev) / fovDeg;
    const r = Math.hypot(dx, dy);
    if (r <= PIP_RIM) return { dx, dy, far: false };
    const k = PIP_RIM / r;
    return { dx: dx * k, dy: dy * k, far: true };
  }

  return {
    id: turret.id,
    kind: 'turret',
    turret,
    mount,
    space,
    lay,
    step,
    sync,
    sight,
    jolt,
    demandOffset,
    rangeAt,
    flightTime,
    room,
    onBandstand,
    // Whether the body stands in the ship's own frame while working this gear.
    // True for a working chamber, which does not train, and false for a gunhouse
    // room, which does — see `crossDoors` in firstPerson.js.
    inShipFrame: onBandstand,
    // The sight's fields of view and what to call them. Carried on the station
    // rather than read off LAYING, because the other gun on this ship has an
    // open ring sight with no magnification at all.
    optics: { fov: LAYING.fov, labels: LAYING.magLabels },
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
