import { Euler, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { createMountSpace } from './mountSpace.js';
import { STERN_AA } from '../battleship/spec.js';
import { deckY, zOf } from '../battleship/hull.js';
import { sternAASight, sternAAStation, SIGHT_RING } from '../battleship/sternAA.js';
import {
  DEG, wrap180, clamp, mountToWorld, slew,
} from './laying.js';

// The gun on her quarterdeck, from the seat.
//
// This is the counterpart of turretStation.js and it is written deliberately as
// its opposite. Both put a player behind a sight; almost every decision inside
// them goes the other way, and the four that matter are these.
//
// --- 1. the sight is not stabilised ------------------------------------------
//
// A turret's demand is held as a bearing and an elevation *in the world*, so
// the sea does not move the picture: that is what a gyro sight is and it is why
// laying the main battery in a seaway is possible at all.
//
// This mounting has no gyro in it, because there was not one to have. The layer
// is sitting on the machine with an open ring bolted in front of his face, and
// when she rolls four degrees the whole sky rolls four degrees with her. So the
// demand here is held in the *mount's own frame*: the mouse moves the gun
// relative to the ship, the horizon tips, and holding a mark on a target through
// a roll is work you do with your hands. That is the difficulty of anti-aircraft
// fire from a small mounting and it is the thing worth simulating about it.
//
// --- 2. the gun is nearly on the line ----------------------------------------
//
// A turret is four degrees behind your hand for seconds on end and the pip is
// how you read the wait. This trains at forty-six degrees a second with ninety
// of acceleration, so the pip sits almost on the cross in normal tracking and
// only opens up when you throw the mount across the sky — which is exactly when
// you want to be told that the guns have not got there yet.
//
// --- 3. the trigger is held, not pressed --------------------------------------
//
// One round every eighth of a second out of four barrels in turn, until the
// ready-use racks are empty or the barrels are too hot to go on. Everything
// interesting about firing this gun is in that sentence: it is not a question of
// when to take the shot, it is a question of how long a burst you can afford.
//
// --- 4. it cannot be laid onto her own ship ----------------------------------
//
// The cut-out cam. See sternAA.js — the mount refuses to depress into her
// superstructure and the sight refuses with it, so the cross stops dead as it
// comes down across the after deckhouse and the plate says why.

export const AA_LAYING = {
  // Degrees of demand per pixel of mouse. Quicker than the turret's, because
  // this is a hand on a shoulder-piece and not a hand on a training handwheel.
  sensitivity: 0.11,
  // Almost nothing: a light mounting answers the smallest movement, which is
  // most of why it feels like a different machine to hold.
  deadband: 0.04, // degrees

  // An open ring sight has no magnification, so there is one field of view and
  // Z does nothing at this gun. That is not a simplification — it is the sight:
  // what you are looking through is a hoop of steel with a bead beyond it, and
  // there is no optic in the path to magnify anything.
  fov: [58],
  magLabels: ['ring'],

  // The reticle, in degrees of half-angle. The outer one is not a number chosen
  // here: it is the angle the *steel* ring on the mounting actually subtends
  // from the layer's eye, so the drawn circle lands exactly on the modelled hoop
  // and there is one ring in the picture rather than two.
  //
  // And it is not decoration. The outer ring is the lead you take for a target
  // crossing at about a hundred metres a second at a thousand metres, the inner
  // for half that. You do not aim at an aeroplane, you aim at the ring it is
  // sitting on.
  ring: SIGHT_RING,
  innerRing: SIGHT_RING * 0.46,

  // What the layer feels. A burst is not one bang, it is a hundred and fifty a
  // minute out of four barrels a metre and a half from his head, so the shock is
  // small, fast and continuous — a rattle rather than a blow. It is set going
  // afresh by every round, which means what you actually feel is the *rate* of
  // fire, and it stops the instant the gun does.
  shock: {
    pitch: 0.62, // degrees at the eye
    yaw: 0.34,
    heave: 0.035, // m
    freq: 21, // Hz
    decay: 13, // per second
  },
  // The mounting shoves her, and it is worth having only because everybody
  // standing on the quarterdeck feels it through the inertial layer. A single
  // round is a bag of cement against forty-two thousand tonnes; a sustained
  // burst is a hum in the deck. It is no longer a constant: the round's own
  // momentum goes in through Boat.impulseAt at the muzzle, like the big guns'.
};

const _v = new Vector3();
const _m = new Matrix4();
const _kick = new Vector3();
const _qk = new Quaternion();
const _eu = new Euler();
const UP = new Vector3(0, 1, 0);

export function createAAStation({
  mount, shipSpace, damage, onRound = null,
}) {
  const S = STERN_AA;
  const pivot = new Vector3(0, deckY(S.z) + S.ringH, zOf(S.z));
  const where = sternAAStation();
  const eyeLocal = sternAASight();

  // The mounting's own frame. Exactly the same construction a gunhouse gets, and
  // for a weaker version of the same reason: nobody walks about on this mounting,
  // but the layer's eye is bolted to it and it swings at forty-six degrees a
  // second, which two metres off the axis is a metre and a half of seat going
  // sideways under him every second.
  const space = createMountSpace({
    id: S.id,
    parent: shipSpace,
    pivot,
    getYaw: () => -mount.yaw * DEG,
    colliders: null,
    hull: null,
  });

  // --- laying -----------------------------------------------------------------
  //
  // Held in the mount's frame, unlike the turret's. `sightBearing`/`sightPitch`
  // are the same line in the world and are *derived* — they exist only so the
  // camera has something to look along and so the readout can say what bearing
  // she is on. Nothing writes to them.
  const lay = {
    demandYaw: mount.yaw,
    demandElev: mount.elev,
    sightBearing: 0,
    sightPitch: 0,
    trainRate: 0,
    elevRate: 0,
    held: false, // hands on the gear
    trigger: false, // and the trigger down
    // the state of the gun itself
    rounds: S.clip,
    reload: 0,
    heat: 0,
    ceased: false, // the barrels are too hot and it will not answer
    cutout: false, // the cam is holding the guns up off her own ship
    firing: false, // rounds actually leaving, this frame
    next: 0, // seconds until the next round
    barrel: 0, // which of the four fires it
    fired: 0, // rounds this burst, for the readout
  };

  const _back = { bearing: 0, pitch: 0 };

  // The gun going off, as the man in the seat has it. Restarted by every round,
  // which is what makes a burst feel like a burst.
  const shock = { t: 1e3, mag: 0, side: 1 };
  // `side` is which side of the cradle the barrel that fired sits on. It goes
  // into the sideways half of the kick, so the seat is thrown the way the
  // mounting is actually shoved — and because the four barrels take their turn
  // from one side to the other, a burst rattles the layer's head left and right
  // rather than simply up and down. It is a small thing and it is the difference
  // between a shake and a *machine*.
  function jolt(strength = 1, side = 1) {
    shock.t = 0;
    shock.side = side;
    shock.mag = Math.max(shock.mag * 0.6, strength);
  }

  // --- the automatic ------------------------------------------------------------
  //
  // Everything that is not laying. Runs whether or not the player has hold of the
  // gear, because barrels cool and loaders refill racks while nobody is watching.
  function feed(dt) {
    lay.heat = Math.max(0, lay.heat - S.cool * dt);
    if (lay.ceased && lay.heat <= S.resume) lay.ceased = false;
    if (lay.reload > 0) {
      lay.reload = Math.max(0, lay.reload - dt);
      if (lay.reload === 0) lay.rounds = S.clip;
    }
    lay.next = Math.max(0, lay.next - dt);

    // The two numbers on the plate, put back onto the machine itself: the
    // barrels glow when they have been worked and the clips sink as the racks
    // empty. Done here rather than in the sight because they are true whether or
    // not anybody is sitting at it — a gun left hot goes on being hot, and the
    // men on the quarterdeck can see both.
    if (mount.setHeat) mount.setHeat(lay.heat);
    if (mount.setLoad) {
      mount.setLoad(lay.reload > 0
        ? 1 - lay.reload / S.reload // the loaders pushing fresh clips in
        : lay.rounds / S.clip);
    }

    lay.firing = false;
    if (!lay.trigger || !lay.held || mount.destroyed) { lay.fired = 0; return; }
    if (lay.reload > 0 || lay.ceased) return;

    // The cyclic rate, in rounds rather than in frames. A gun that fired once a
    // frame would be a different weapon on a fast machine, and one that fired
    // whatever fitted in `dt` would empty the racks in a single hitch — so the
    // loop steps the interval forward and stops when it runs out of budget, the
    // same shape the ballistic integrator uses and for the same reason.
    let guard = 8; // never more than this many in one frame, however long it was
    while (lay.next <= 0 && guard-- > 0) {
      if (lay.rounds <= 0) { lay.reload = S.reload; break; }
      if (lay.heat >= 1) { lay.ceased = true; break; }
      const gun = mount.guns[lay.barrel % mount.guns.length];
      const side = Math.sign(gun.barrel.position.x) || 1;
      lay.barrel = (lay.barrel + 1) % mount.guns.length;
      lay.rounds -= 1;
      lay.fired += 1;
      lay.heat = Math.min(1, lay.heat + S.heatPerRound);
      lay.next += S.cyclic;
      lay.firing = true;
      jolt(1, side);
      if (onRound) onRound(station, gun);
    }
    if (lay.next <= 0) lay.next = S.cyclic;
  }

  function step(dt) {
    if (shock.mag > 0) {
      shock.t += dt;
      if (shock.t > 0.6) shock.mag = 0;
    }
    feed(dt);
    if (!lay.held || mount.destroyed) return;

    // The arc, which on this mounting is the whole horizon, and the cut-out cam,
    // which is not a number. `floorAt` is asked at the bearing the *demand* is
    // on rather than the one the gun has reached, so the cross stops where the
    // gun will have to stop rather than where it is — otherwise you lay it into
    // the mainmast and watch the guns refuse to follow.
    lay.demandYaw = mount.arcCenter + clamp(
      wrap180(lay.demandYaw - mount.arcCenter), -mount.arc, mount.arc,
    );
    const floor = mount.floorAt(lay.demandYaw);
    const wanted = lay.demandElev;
    lay.demandElev = clamp(lay.demandElev, floor, mount.elevMax);
    lay.cutout = wanted < floor - 0.05 && floor > mount.elevMin + 0.05;

    const [y, ry] = slew(mount.yaw, lay.demandYaw, lay.trainRate,
      S.traverseRate, S.trainAccel, dt, true, AA_LAYING.deadband);
    const [e, re] = slew(mount.elev, lay.demandElev, lay.elevRate,
      S.elevateRate, S.elevAccel, dt, false, AA_LAYING.deadband);
    lay.trainRate = ry;
    lay.elevRate = re;
    mount.yaw = y;
    mount.elev = e;
    mount.targetYaw = y;
    mount.targetElev = e;
    mount.apply();

    // and where that line has ended up in the world, for the readout
    mountToWorld(shipSpace, mount.yaw, mount.elev, _back);
    lay.sightBearing = _back.bearing;
    lay.sightPitch = _back.pitch;
  }

  // Taking hold: start from where the guns are. In the mount's frame that is
  // simply where they are, which is the whole simplification an unstabilised
  // sight buys — there is no world bearing to be recovered and nothing to drift.
  function sync() {
    lay.demandYaw = mount.yaw;
    lay.demandElev = mount.elev;
    lay.trainRate = 0;
    lay.elevRate = 0;
    lay.next = 0;
    lay.fired = 0;
  }

  // The mouse. Straight onto the demand in the mount's own frame — no conversion,
  // no stabilisation, no leash. `dx`/`dy` arrive in degrees.
  function look(dx, dy) {
    lay.demandYaw = wrap180(lay.demandYaw + dx);
    lay.demandElev = clamp(lay.demandElev + dy, -90, 90);
  }

  // --- the sight ----------------------------------------------------------------
  //
  // The eye is on the mounting, behind the ring. Two things follow from that and
  // both are the opposite of the turret's:
  //
  //   the *up* is the ship's, not the world's, so the horizon rolls
  //   the eye swings bodily as the mount trains, so the whole picture is carried
  //     round rather than panned across
  //
  // And the line it looks along is the *guns*, not the demand — which is the one
  // place this station goes against the note in turretStation.js, deliberately.
  //
  // That note says: tie the picture to the machinery and the mouse stops
  // answering. It is right about a turret, where the machinery is fifteen
  // hundred tonnes doing ten degrees a second and the picture would move like a
  // crane. It is wrong here for two reasons. The first is that this mounting
  // does forty-six degrees a second off ninety of acceleration, so the picture
  // is a fifth of a second behind your hand and no further. The second is the
  // one that decides it: the sight is a *hoop of steel bolted to the gun*. It is
  // modelled, it is in the picture, and if the eye looked anywhere but along it
  // then the ring would drift off the middle of the view — which is not a thing
  // a ring sight has ever done, and looks exactly as broken as it sounds.
  //
  // So the eye looks down the barrels, and the demand — where your hand is
  // asking for — becomes the pip. Move the mouse and the pip leaves the middle
  // and the mount comes after it. That is the control a layer on an open mount
  // actually has, and it inverts the turret's reading of the same two marks.
  const _eye = new Vector3();
  const _dir = new Vector3();
  const _up = new Vector3();
  const _tgt = new Vector3();

  function sight(camera) {
    space.toWorld(_v.set(eyeLocal.x, eyeLocal.y, eyeLocal.z), _eye);
    // where the guns are actually laid, as a direction in the mount's frame,
    // then out to the world
    _dir.set(0, Math.sin(mount.elev * DEG), Math.cos(mount.elev * DEG));
    _dir.applyAxisAngle(UP, -mount.yaw * DEG);
    _dir.applyQuaternion(shipSpace.worldQuaternion);
    _up.set(0, 1, 0).applyQuaternion(shipSpace.worldQuaternion);
    camera.position.copy(_eye);
    _tgt.copy(_eye).add(_dir);
    _m.lookAt(_eye, _tgt, _up);
    camera.quaternion.setFromRotationMatrix(_m);

    if (shock.mag > 0) {
      const K = AA_LAYING.shock;
      const e = Math.exp(-K.decay * shock.t) * shock.mag;
      const ring = Math.cos(2 * Math.PI * K.freq * shock.t) * e;
      _kick.set(K.pitch * DEG * ring, K.yaw * DEG * ring * 0.6 * shock.side, 0);
      _qk.setFromEuler(_eu.set(_kick.x, _kick.y, 0, 'XYZ'));
      camera.quaternion.multiply(_qk);
      camera.position.addScaledVector(_dir, -K.heave * e);
    }
    return { eye: _eye, dir: _dir };
  }

  // How far the *demand* is off the guns, as a fraction of the vertical field.
  //
  // The same contract as the turret's — the sight does not have to know which
  // gun it is drawing for — and the opposite reading, because the two marks have
  // swapped places. In a turret the cross is the sight and the pip is the guns
  // trailing behind it; here the middle of the ring *is* the guns and the pip is
  // your hand out in front of them. Hence the signs, which are the turret's
  // negated: the demand to starboard is a pip to the right.
  const PIP_RIM = 0.45;
  function demandOffset(fovDeg) {
    const dx = wrap180(lay.demandYaw - mount.yaw) / fovDeg;
    const dy = (lay.demandElev - mount.elev) / fovDeg;
    const r = Math.hypot(dx, dy);
    if (r <= PIP_RIM) return { dx, dy, far: false };
    const k = PIP_RIM / r;
    return { dx: dx * k, dy: dy * k, far: true };
  }

  const station = {
    id: S.id,
    kind: 'aa',
    mount,
    space,
    lay,
    optics: { fov: AA_LAYING.fov, labels: AA_LAYING.magLabels },
    step,
    sync,
    look,
    sight,
    jolt,
    demandOffset,
    // The reticle wants to know what it is drawing over, and the readout wants
    // to know what the gun is doing. One object, refreshed by `step`.
    readout: () => ({
      rounds: lay.rounds,
      clip: S.clip,
      reload: lay.reload,
      heat: lay.heat,
      ceased: lay.ceased,
      cutout: lay.cutout,
      firing: lay.firing,
      bearing: lay.sightBearing,
      elevation: mount.elev,
      floor: mount.floorAt(mount.yaw),
      ring: AA_LAYING.ring,
      innerRing: AA_LAYING.innerRing,
    }),
    // A gun tub is part of the ship: it does not train, so there is no space to
    // be handed into and walking up to the mounting is simply walking. The
    // machine inside it turns, and that is the mount space above — which the
    // sight uses and the body never touches.
    inShipFrame: true,
    onBandstand: true, // the same thing, in the name firstPerson already knows
    room: null,
    doorsIn: [],
    doorsOut: [],
    landing: null,
    pivot,
    alive: () => !mount.destroyed && damage.alive(S.id),
    station: new Vector3(where.station.x, where.station.y, where.station.z),
    // Generous, because you take hold of this gun by climbing onto it rather
    // than by standing at a console: anywhere on the platform within arm's reach
    // of the mounting is close enough, and the mounting itself is over four
    // metres across.
    reach: 3.8,
    approach: new Vector3(where.approach.x, where.approach.y, where.approach.z),
    approachHeading: 0, // facing forward, along the guns at rest
    // What the trigger does, from firstPerson: this is a gun that is *held*
    // rather than pressed, so the button's state arrives every frame instead of
    // as an event.
    setTrigger(on) { lay.trigger = !!on; },
  };
  return station;
}
