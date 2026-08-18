import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { PLAYER } from './spec.js';

// A man, animated without a single keyframe.
//
// The model arrives rigged and with no animation on it at all — 64 bones, an
// A-pose, and nothing else — so every frame of movement in this file is
// computed. That is not a workaround for a missing asset. It is the only thing
// that can work here, and the reason is the deck he is standing on.
//
// A clip is a function of time. What this figure has to be a function of is the
// *state of the character controller*: how fast he is actually going after the
// heel of the ship has taken a metre a second off him, how far through a crouch
// he is when the deckhead stopped him coming up, whether the floor probe found a
// tread or air. Driving a clip from those means a blend tree, a set of clips
// nobody has authored, and a permanent argument about whether the feet are
// keeping up with the ground. Driving the bones from them directly means the
// legs are always in step with the speed, because the speed *is* the input.
//
// --- how a pose is stated ----------------------------------------------------
//
// Every angle below is in the armature's own frame, which for this rig is:
//
//     +X  the man's left        +Y  up        +Z  the way he is facing
//
// and never in a bone's local frame, which for a Rigify export is a different
// and largely arbitrary basis for each of the 64. A rotation of a joint is
// applied as
//
//     q_local = inv(P) . R . P . q_rest
//
// where `P` is the parent's world rotation *at rest* and `R` is the rotation you
// meant. Compose that up the chain and each joint's total offset from rest works
// out as `D_parent . R` — the joint turns about the axis you named, and then
// whatever its parent did carries it. Which is what a skeleton is.
//
// That one line is what makes the rest of this file readable: "bend the knee" is
// a positive rotation about X on `shinL`, and it stays a positive rotation about
// X whatever the hip is doing.
//
// --- what is solved and what is faked -----------------------------------------
//
// The legs are solved, because they have to be. A crouch is a *height*: the
// character controller says the crown has come down 46 cm and the collision
// capsule is that much shorter, and a leg bend that does not put the hip where
// the controller thinks it is leaves a man whose feet are through the deck.
// Two links and a law of cosines is the whole solve.
//
// The walk on top of it is not solved and the feet do slide a little. A cheap
// procedural cycle slips a few centimetres a stride, and the alternatives — foot
// planting with IK, or root motion — are both large, and both would be paid for
// on a figure who is, in the mode where you can see him at all, a hundred metres
// away over the quarter.

const DEG = Math.PI / 180;

export const GAIT = {
  // One cycle is two steps, and it is driven by distance rather than by a clock
  // so the legs stay in step at any speed — the same argument as the head bob in
  // firstPerson.js, and for the same reason: a stride rate set by time makes a
  // man walking uphill into a mime.
  strideLength: 1.85, // m of deck per full cycle at a walk
  // How far the leg swings, in degrees at walking pace, and how much more of it
  // there is at a run. A run is not a fast walk: the knees come up further, the
  // trunk leans in, and the arms stop being able to hold a rifle still.
  swing: 26,
  swingRun: 42,
  knee: 34, // peak flexion in the swing phase
  kneeRun: 66,
  lean: 5, // degrees of forward trunk lean at a walk
  leanRun: 15,
  bounce: 0.022, // m the hips rise and fall over a stride
  roll: 3.5, // degrees the shoulders counter-rotate against the hips

  // Crouching. The head has to come down by whatever the controller says, and
  // there are two places to get it from: bending the knees and folding the trunk
  // forward over them. All of it in the knees is a full squat, which is not what
  // anybody presses CTRL for; all of it in the trunk is a bow. This is the share
  // that goes into the trunk.
  crouchLean: 0.35,
  crouchStance: 9, // degrees the knees splay outward, so he is not knock-kneed

  // In the air: knees up, trailing leg back. A figure who jumps with his legs
  // straight reads as being lifted rather than as jumping, and it is the single
  // cheapest tell there is.
  airLead: 38,
  airKnee: 62,
  airTrail: 22,
};

// The rifle, held. Two poses and everything in between: carried across the chest
// with the muzzle down and out, and up in the shoulder with the sights on the
// line of sight. Stated as the angles of the four joints that matter, because
// there is no IK here and there does not need to be — the weapon is parented to
// the right hand, so wherever the hand ends up the gun is in it.
// The rest pose is not a T — the arms already hang at about 55 degrees — so the
// work these have to do is almost all about **Y**: swinging an arm that is out
// at his side round to the front. The Z terms only tidy the elbow in against the
// ribs. Getting that the wrong way round is what pins both arms flat to his sides
// and leaves the rifle floating in front of a man who is not holding it.
const CARRY = {
  // [about X, about Y, about Z], degrees, for the man's LEFT limb. The right is
  // the mirror of it: reflecting through the fore-and-aft plane keeps a rotation
  // about X and reverses the other two.
  upperArm: [-10, -68, -16],
  forearm: [0, -52, -8],
  hand: [0, -12, 8],
  chest: [0, 16, 0], // he stands bladed to what he is pointing at
};
const AIMED = {
  upperArm: [-4, -82, -26],
  forearm: [0, -70, -4],
  hand: [0, -6, 4],
  chest: [0, 8, 0],
};

const _r = new Quaternion();
const _e = new Euler(0, 0, 0, 'YXZ');

// The chain of names this rig actually uses. Held in one place so that a rig
// with different names is one edit rather than forty.
const RIG = {
  hips: 'spine',
  spine: ['spine001', 'spine002', 'spine003'],
  neck: 'spine004',
  head: 'spine005',
  legs: [
    { thigh: 'thighL', shin: 'shinL', foot: 'footL', side: 1 },
    { thigh: 'thighR', shin: 'shinR', foot: 'footR', side: -1 },
  ],
  arms: [
    { upper: 'upper_armL', fore: 'forearmL', hand: 'handL', side: 1 },
    { upper: 'upper_armR', fore: 'forearmR', hand: 'handR', side: -1 },
  ],
};

export function createSoldier(model) {
  const { group, bones } = model;

  // --- the rest pose, captured once ------------------------------------------
  //
  // Everything below is stated as an offset from this, so it has to be read
  // before anything has been touched. `parentInv` is the inverse of each bone's
  // parent's world rotation at rest — the `inv(P)` of the identity at the head
  // of this file — and it never changes, because a rest pose does not.
  group.updateMatrixWorld(true);
  const rest = new Map();
  for (const [name, bone] of bones) {
    const parentWorld = new Quaternion();
    (bone.parent ?? group).getWorldQuaternion(parentWorld);
    rest.set(name, {
      bone,
      local: bone.quaternion.clone(),
      position: bone.position.clone(),
      parent: parentWorld.clone(),
      parentInv: parentWorld.clone().invert(),
    });
  }

  // Turn a joint by (x, y, z) degrees about the armature's own axes. The order
  // is YXZ, which means the Z term is applied first: for an arm that is the one
  // that brings it down off the A-pose, and the two after it are then swinging
  // an arm that is already by his side rather than one still sticking out.
  function turn(name, x, y, z) {
    const r = rest.get(name);
    if (!r) return;
    _e.set(x * DEG, y * DEG, z * DEG);
    _r.setFromEuler(_e);
    r.bone.quaternion.copy(r.parentInv).multiply(_r).multiply(r.parent).multiply(r.local);
  }

  // The same, mirrored for the man's right-hand limbs: reflecting a rotation
  // through the fore-and-aft plane keeps the component about X and reverses the
  // other two.
  const turnSide = (name, side, [x, y, z]) => turn(name, x, side * y, side * z);

  const put = (name, x, y, z) => {
    const r = rest.get(name);
    if (r) r.bone.position.set(r.position.x + x, r.position.y + y, r.position.z + z);
  };

  // --- how long his legs are ---------------------------------------------------
  //
  // Measured off the rig rather than typed in, because the whole point of
  // solving the crouch is that the hip ends up where the controller says it is,
  // and a thigh length that disagrees with the model by two centimetres puts it
  // somewhere else.
  //
  // Everything here is in **metres**, measured off the rig in world space with the
  // wrapper's scale already applied. That is worth stating, because the
  // alternative — the exporter's own units — is a trap: this file's one input from
  // the controller is a *height in metres*, and a solve that mixes the two gives a
  // man whose knees bend by the wrong amount and whose feet are through the deck.
  //
  // The one place bone units are unavoidable is `put`, which writes a bone's local
  // translation. `hipUnit` is the conversion for that, and it is taken off the
  // bone's own world matrix rather than off the wrapper's scale — the chain
  // between the two carries a scale of its own on this export, and reading the
  // wrapper instead is a four-hundred-fold error.
  const world = (name) => rest.get(name).bone.getWorldPosition(new Vector3());
  const hipRest = world(RIG.hips);
  const kneeRest = world('shinL');
  const ankleRest = world('footL');
  const THIGH = hipRest.distanceTo(kneeRest); // m
  const SHIN = kneeRest.distanceTo(ankleRest); // m
  const STANCE = hipRest.y - ankleRest.y; // m, hip above ankle standing
  const _hipScale = new Vector3();
  rest.get(RIG.hips).bone.matrixWorld.decompose(new Vector3(), new Quaternion(), _hipScale);
  const hipUnit = _hipScale.x || 1; // metres per unit of the hips bone's local position

  // A two-link solve for one leg, given how far the hip is above the ankle.
  // Returns the thigh's forward tilt and the knee's flexion, both in radians.
  // `d` is clamped inside the reachable band: a hip further from the ankle than
  // the leg is long is a straight leg, and one closer than the difference of the
  // two links is a knee folded flat.
  const _ik = { thigh: 0, knee: 0 };
  function legIK(d) {
    const lo = Math.abs(THIGH - SHIN) + 1e-3;
    const hi = THIGH + SHIN - 1e-3;
    const r = Math.min(Math.max(d, lo), hi);
    const cosHip = (THIGH * THIGH + r * r - SHIN * SHIN) / (2 * THIGH * r);
    const cosKnee = (THIGH * THIGH + SHIN * SHIN - r * r) / (2 * THIGH * SHIN);
    _ik.thigh = Math.acos(Math.min(Math.max(cosHip, -1), 1));
    _ik.knee = Math.PI - Math.acos(Math.min(Math.max(cosKnee, -1), 1));
    return _ik;
  }

  let phase = 0; // distance-driven, radians; one cycle is two steps
  let leanNow = 0;
  let aimNow = 0;
  let recoilNow = 0;

  // `s` is everything the pose depends on, and every field of it comes straight
  // off the character controller or off the weapon — nothing here has state of
  // its own except the stride phase and three smoothed scalars.
  function update(dt, s) {
    const {
      speed = 0, grounded = true, climbing = false, crouch = 0,
      pitch = 0, aiming = false, recoil = 0, height = PLAYER.height,
    } = s;

    // --- the stride -----------------------------------------------------------
    const moving = grounded && speed > 0.15;
    const run = Math.min(Math.max((speed - PLAYER.walk * 0.7)
      / (PLAYER.sprint - PLAYER.walk * 0.7), 0), 1);
    if (moving) {
      // Distance covered, not time elapsed. Divided by the stride length so a
      // cycle is a cycle however fast he is going, and stretched a little at a
      // run because a running stride is longer than a walking one.
      phase += (speed * dt * 2 * Math.PI) / (GAIT.strideLength * (1 + run * 0.55));
    } else {
      // Come to rest at the bottom of a step rather than stopping mid-swing,
      // which is the difference between a man halting and a man being paused.
      const home = Math.round(phase / Math.PI) * Math.PI;
      phase += (home - phase) * Math.min(dt * 9, 1);
    }
    const amp = moving ? Math.min(speed / PLAYER.walk, 1.25) : 0;

    // Smoothed, because all three are switches upstream and none of them should
    // read as one: a man does not snap into a firing position.
    const wantLean = (GAIT.lean + (GAIT.leanRun - GAIT.lean) * run) * amp;
    leanNow += (wantLean - leanNow) * Math.min(dt * 6, 1);
    aimNow += ((aiming ? 1 : 0) - aimNow) * Math.min(dt * 11, 1);
    recoilNow += (recoil - recoilNow) * Math.min(dt * 26, 1);

    const swing = (GAIT.swing + (GAIT.swingRun - GAIT.swing) * run) * amp;
    const kneeSwing = (GAIT.knee + (GAIT.kneeRun - GAIT.knee) * run) * amp;

    // --- the legs -------------------------------------------------------------
    //
    // The stance comes first and the stride is laid on top of it. That ordering
    // is what lets a man walk while crouched without either half having to know
    // about the other.
    const drop = (PLAYER.height - height) * (1 - GAIT.crouchLean);
    const stance = legIK(STANCE - drop);

    for (const leg of RIG.legs) {
      const p = phase + (leg.side > 0 ? 0 : Math.PI);
      if (climbing) {
        // On a ladder the legs do the same thing the arms do and half a cycle
        // out of step with them: one knee up on a rung while the other pushes.
        const lift = Math.max(Math.sin(p), 0);
        turn(leg.thigh, -22 - 46 * lift, 0, leg.side * GAIT.crouchStance * 0.5);
        turn(leg.shin, 30 + 52 * lift, 0, 0);
        turn(leg.foot, -10, 0, 0);
        continue;
      }
      if (!grounded) {
        // Airborne. Which leg leads is fixed rather than following the stride —
        // a jump is not half a step — and the trailing leg goes back, which is
        // what stops a jump reading as a hop.
        const lead = leg.side > 0;
        turn(leg.thigh, lead ? -GAIT.airLead : GAIT.airTrail, 0,
          leg.side * GAIT.crouchStance * 0.4);
        turn(leg.shin, lead ? GAIT.airKnee : GAIT.airKnee * 0.55, 0, 0);
        turn(leg.foot, lead ? -18 : 14, 0, 0);
        continue;
      }
      // Standing or walking. The hip's forward tilt out of the solve is the
      // stance; the sine on top of it is the stride. Knee flexion is the solve's
      // plus a swing-phase lift that only ever adds — a knee does not bend the
      // other way.
      const thighDeg = -stance.thigh / DEG - swing * Math.sin(p);
      const lift = Math.max(0, Math.sin(p + 0.55));
      const kneeDeg = stance.knee / DEG + kneeSwing * lift * lift;
      turn(leg.thigh, thighDeg, 0, leg.side * GAIT.crouchStance * (0.3 + crouch));
      turn(leg.shin, kneeDeg, 0, 0);
      // The foot tries to stay flat to the deck: it undoes whatever the two
      // joints above it have done, minus a little, so the heel still lifts.
      turn(leg.foot, -(thighDeg + kneeDeg) * 0.72, 0, 0);
    }

    // --- the hips and the trunk -------------------------------------------------
    //
    // Two steps to a stride, so the rise and fall runs at twice the sway — the
    // same relation the camera's head bob uses, and they have to agree or a man
    // watched from outside bobs out of step with the view from inside him.
    // `put` writes a bone's local translation, which is the one quantity in this
    // file that is not in metres.
    const bounce = (Math.sin(phase * 2) * GAIT.bounce * amp) / hipUnit;
    put(RIG.hips, 0, bounce, 0);
    const crouchLean = crouch * GAIT.crouchLean * 46;
    turn(RIG.hips, leanNow * 0.35 + crouchLean * 0.45,
      Math.sin(phase) * GAIT.roll * amp * 0.5, 0);

    // The trunk carries the rest of the lean, spread over three joints so it
    // curves rather than hinging, and counter-rotates against the hips — which
    // is the thing that makes a walk read as a walk rather than as a statue
    // being slid along.
    const trunk = (leanNow * 0.65 + crouchLean * 0.55) / RIG.spine.length;
    const chest = CARRY.chest.map((v, i) => v + (AIMED.chest[i] - v) * aimNow);
    RIG.spine.forEach((name, i) => {
      const last = i === RIG.spine.length - 1;
      turn(name, trunk - (last ? recoilNow * 3.5 : 0),
        -Math.sin(phase) * GAIT.roll * amp * 0.6 + (last ? chest[1] : 0), 0);
    });

    // The head holds the horizon: whatever the trunk has been leaned by is taken
    // back out here, and the player's own pitch is added. Split between the neck
    // and the skull so it is not one hinge.
    const look = -pitch / DEG - leanNow - crouchLean * 0.55;
    turn(RIG.neck, look * 0.45, 0, 0);
    turn(RIG.head, look * 0.55, 0, 0);

    // --- the arms and what is in them --------------------------------------------
    for (const arm of RIG.arms) {
      const isTrigger = arm.side < 0; // right hand on the grip
      const blend = (a, b) => a.map((v, i) => v + (b[i] - v) * aimNow);
      const upper = blend(CARRY.upperArm, AIMED.upperArm);
      const fore = blend(CARRY.forearm, AIMED.forearm);
      const hand = blend(CARRY.hand, AIMED.hand);
      // The left hand is further forward on the handguard than the right is on
      // the grip, so its elbow is straighter and its shoulder further round.
      const reach = arm.side > 0 ? 1 : 0.68;
      // Recoil goes into the shoulder that is taking it and, a good deal less,
      // into the one on the handguard.
      const kick = recoilNow * (isTrigger ? 9 : 4);
      turnSide(arm.upper, arm.side, [
        upper[0] * reach - kick, upper[1] * reach, upper[2] * reach,
      ]);
      turnSide(arm.fore, arm.side, [fore[0], fore[1] * reach, fore[2]]);
      turnSide(arm.hand, arm.side, hand);
    }
  }

  // --- hanging something off a bone ---------------------------------------------
  //
  // Parenting a rifle to `handR` is one line and then two hours of finding out
  // what that bone's local axes are, because for a Rigify export they are not
  // anything: each bone's basis is whatever fell out of the roll the rigger left
  // it at. So the same change of basis the poses use is applied to the mount —
  // the offset and the orientation are stated in the *armature's* frame, where
  // +X is his left and +Z is the way he faces, and the bone's own basis never
  // appears.
  //
  // The scale is the other half of it. Everything inside the figure is in the
  // exporter's units and the group carries the conversion to metres, so an object
  // that is already in metres has to have that conversion taken back off it or a
  // one-metre rifle is drawn a centimetre long.
  //
  // `offset` is in bone units, from the bone's own origin, along the armature's
  // axes. `rotation` is degrees about those same axes.
  // `at` is where the object's origin should end up and `rotation` is which way it
  // should be facing, both in the **armature's** frame and both stated for the
  // pose the figure is in *at the moment of the call*. Not the rest pose: a rifle
  // hung off the wrist of a man in a T-pose and then swung into a carry by three
  // shoulder rotations ends up wherever those rotations happen to put it, and
  // tuning it means tuning six numbers against three others that also move it.
  // Pose him first, then say where the weapon goes, and the two are independent.
  //
  // Everything after that is bookkeeping: convert the world point into the bone's
  // own space with its own inverse matrix — which carries the scale, so nothing
  // has to know what the exporter's units were — and take that scale back off the
  // object, which is already in metres.
  const _mi = new Matrix4();
  function attach(boneName, object, { at = [0, 0, 0], rotation = [0, 0, 0] } = {}) {
    const r = rest.get(boneName);
    if (!r) return null;
    group.updateMatrixWorld(true);
    const boneQuat = new Quaternion();
    const boneScale = new Vector3();
    r.bone.matrixWorld.decompose(new Vector3(), boneQuat, boneScale);
    const s2 = boneScale.x || 1;

    const holder = new Object3D();
    _mi.copy(r.bone.matrixWorld).invert();
    holder.position.copy(new Vector3(...at).applyMatrix4(_mi));
    _e.set(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG);
    holder.quaternion.copy(boneQuat).invert().multiply(_r.setFromEuler(_e));
    holder.scale.setScalar(1 / s2);
    holder.add(object);
    r.bone.add(holder);
    return holder;
  }

  // Where the rifle goes, and it is the right hand rather than a socket on the
  // chest: a socket needs the hands solved onto whatever it is holding, and this
  // does not — the gun is in the hand because it is parented to it.
  const gunHand = bones.get('handR') ?? null;

  return {
    group,
    bones,
    gunHand,
    attach,
    update,
    // For anything that wants to know where he is looking from without asking
    // the controller — the muzzle of the rifle he is holding, mostly.
    headWorld(out) {
      const b = bones.get(RIG.head);
      return b ? b.getWorldPosition(out) : out.copy(group.position);
    },
    get stride() { return phase; },
  };
}
