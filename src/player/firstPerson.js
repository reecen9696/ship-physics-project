import { Euler, Quaternion, Vector3 } from 'three/webgpu';
import { createShipSpace } from './shipSpace.js';
import { createDeckAccess } from './deckAccess.js';
import { createCharacter } from './character.js';
import { createAvatar } from './avatar.js';
import { createPlayerInput } from './input.js';
import { createGunsight } from './gunsight.js';
import { createReticle } from './reticle.js';
import { createRifle, RIFLE } from './weapon.js';
import { createTurretStation, LAYING } from './turretStation.js';
import { createAAStation, AA_LAYING } from './aaStation.js';
import { createHelmStation } from './helmStation.js';
import { HOUSE } from '../battleship/turretHouse.js';
import { PLAYER } from './spec.js';

// Going aboard, going inside a turret, and taking a gun.
//
// Owns the mode: which camera is driving, who has the keys, which *space* the
// body is being simulated in, and whether the hands are on a set of training
// gear. Everything underneath is written as if there could be any number of
// spaces and any number of people in them, because there is already a number and
// it is five.
//
// The chain the render walks is
//
//     world  <-  hull  <-  gunhouse  <-  you
//
// and the camera is the only place any two links of it meet. The character never
// learns where the ship is. The ship never learns there is anybody on it. A
// gunhouse never learns either of those things.
//
// Crossing a gunhouse door is a portal rather than a continuous boundary, and
// that is a decision rather than a shortcut. On a superfiring turret the way in
// is a passage through the bandstand at deck level and the gunhouse is four
// metres above it, turning at ten degrees a second: no fixed ladder reaches a
// rotating room, which is precisely why real ships put the trunk inside the
// barbette and climb it. Walking into the passage and arriving in the gunhouse
// *is* that trunk. The asymmetric margins the design note asks for fall out of
// the two volumes being different places — one outside on the deck, one inside
// against the door — with a grace period on top.

const _local = new Vector3();
const _world = new Vector3();
const _v = new Vector3();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _q = new Quaternion();
const _punch = { pitch: 0, yaw: 0 };
const IDLE = {
  forward: 0, strafe: 0, jump: false, sprint: false, rise: 0,
};

const GRACE = 0.4; // seconds before a body may cross a boundary again

const inBox = (p, vol, margin = 0) => Math.abs(p.x - vol.c.x) < vol.h.x + margin
  && Math.abs(p.y - vol.c.y) < vol.h.y + margin
  && Math.abs(p.z - vol.c.z) < vol.h.z + margin;

export function createFirstPerson({
  camera, controls, element, body, colliders, hull, materials, spawn,
  mounts = null, alive = () => true, turrets = [], damage = null,
  onFire = null, onSalvo = null, onRound = null, shellFor = null,
  // The stern mounting, if she has one: the id of an all-round automatic in
  // `mounts` that gets a seat rather than a room. See player/aaStation.js.
  sternAA = null,
  // The wheelhouse, if she has one: `{ wheelhouse }` off the ship's own bridge.
  // With it, the helm becomes a station you walk up to like a turret's.
  conn = null,
  // --- the man and what he is carrying -----------------------------------------
  //
  // All optional, and all independently so. Every one of these is either an
  // authored asset fetched over the network or something built out of one, and a
  // file that did not arrive is not a reason for the deck to be empty: with none
  // of them this is exactly the game it was — a capsule on the deck and a
  // crosshair that fires test shells.
  //
  // `figure` is the rigged soldier off player/models.js, `weapon` the rifle from
  // the same place, `figureMaterial` the program both are drawn with, `lights`
  // the carried-light rig off `materials.torch`, and `sounds` the bank the
  // report comes out of.
  figure = null, weapon = null, figureMaterial = null,
  lights = null, sounds = null, shading = null, smoke = null,
  // Her hull group. Wanted by the rifle — the tracers hang off it and the lights
  // it carries are stated in her frame — and by the figure, whose ship-frame
  // matrix has to be rebuilt every frame because unlike her plating he moves
  // through it.
  shipGroup = null,
}) {
  const shipSpace = createShipSpace({
    id: 'ship',
    body,
    colliders,
    hull,
    // A turret is one solid block to a falling mast and to the camera, and that
    // is the right answer for both. It is the wrong one for a person: it turns
    // the door they can see into a wall. The player gets the door-cut shell from
    // deckAccess instead — see `houseShellSolids`.
    //
    // The same is true one deck down, and for the same reason. A superfiring
    // turret's barbette is drawn as a drum four and a half metres across
    // standing in the middle of its bandstand, and the ship's colliders make it
    // solid from the deck all the way up. But the bandstand has a room in it and
    // a passage through it, and that drum stood across the passage: you could
    // walk in through the door, take two steps, and stop against nothing. The
    // player skips it and gets the chamber's own floor, walls and trunk from
    // deckAccess — see `chamberSolids` — which is the shape that is actually
    // drawn in there.
    skipShapes: (sh) => sh.kind === 'turret' || (sh.barbette && sh.bandstand),
  });
  const access = createDeckAccess({ mounts, alive });
  const player = createCharacter({ space: shipSpace, extra: access, spawn });
  // The rifle. Built before the avatar, because the avatar is what puts it in
  // his hands — see `HOLD` in avatar.js.
  //
  // `getSpace` rather than the space itself: a man who walks into a gunhouse is
  // simulated in the gunhouse's frame from that moment, and the rounds he fires
  // have to be marched against the gunhouse's colliders in the gunhouse's frame.
  // Handing the rifle a space would mean remembering to hand it another one at
  // every door.
  const rifle = (weapon && figureMaterial && shipGroup)
    ? createRifle({
      camera,
      material: figureMaterial,
      proto: weapon,
      root: shipGroup,
      lights,
      fx: smoke,
      shading,
      sounds,
      onHit: () => reticle && reticle.struck(),
      getSpace: () => player.space,
    })
    : null;
  if (rifle) camera.add(rifle.view);

  const avatar = createAvatar({
    materials,
    figure,
    rifle: rifle ? rifle.held : null,
    shipGroup,
  });
  body.group.add(avatar.group); // ship-local by construction

  // One station per main-battery turret: its own space, its own doors, its own
  // training gear.
  //
  // ...and one more that is not a turret at all. The gun on her quarterdeck is
  // an open mounting with a seat on it: no room, no doors, no gyro sight, a
  // trigger you hold down. It goes in the same list because everything below
  // this line — walking up to it, taking the gear, the sight, letting go — is
  // the same gesture, and the differences are all inside the station itself.
  const stations = mounts
    ? turrets.map((t) => createTurretStation({
      turret: t, mount: mounts.get(t.id), shipSpace, damage,
    }))
    : [];
  if (mounts && sternAA && mounts.get(sternAA)) {
    stations.push(createAAStation({
      mount: mounts.get(sternAA), shipSpace, damage, onRound,
    }));
  }
  const stationById = new Map(stations.map((s) => [s.id, s]));

  // And one for the wheel. It is in the ship's own frame — the wheelhouse is part
  // of the pagoda and the pagoda does not train — so there is no space to be handed
  // into and walking up to it is simply walking, exactly as it is for the working
  // chamber of a superfiring turret.
  const helm = conn ? createHelmStation({
    body, damage, wheelhouse: conn.wheelhouse ?? null,
  }) : null;

  const sight = createGunsight();
  // Two instruments, and only ever one of them up. The gunsight is what you see
  // through a turret's hood; the reticle is what a man walking about with a
  // rifle has instead, and it is the rifle's own — it opens with the group and
  // shuts when the sights come up. See reticle.js.
  const reticle = rifle ? createReticle() : null;

  let active = false;
  let conning = null; // the helm, if our hands are on it
  let laying = null; // the station whose gear is in our hands, or null
  let inside = null; // the station whose gunhouse we are standing in, or null
  let grace = 0;
  // Which of LAYING.fov is in use. Starts at 0 — x1 — and is put back there
  // every time a gun is taken, so every turret opens at the naked-eye field
  // rather than at whatever the last one was left on. x12 was the old default
  // and it is the wrong one to arrive at: you come to the gun not knowing where
  // anything is, and a nine-degree field is for laying on something you have
  // already found.
  let mag = 0;
  let near = null; // a station's controls within reach
  const saved = { position: new Vector3(), target: new Vector3(), fov: 0 };

  // Head bob and the sprint's field of view. Neither is simulation — both are
  // the difference between moving and being moved. The bob is driven by distance
  // covered rather than by a clock, so it stays in step with the legs at any
  // speed and stops dead when you do.
  let bobPhase = 0;
  let bobAmount = 0;
  let fov = PLAYER.fov;

  const input = createPlayerInput({
    element,
    onExit: () => exit(),
    onFire: () => fire(),
    // Three keys that belong to the weapon, and they are handled here rather
    // than with the rest of the keyboard in main.js for one reason: they only
    // mean anything while the rifle is actually in his hands, and this is the
    // only file that knows whether it is. R at a turret's gear must not eject a
    // magazine, and L on the bridge must not light one.
    onTap: (k) => {
      if (!rifle || !active || laying || conning) return;
      if (k === 'r') rifle.reload();
      else if (k === 'l') rifle.toggleTorch();
      else if (k === 'x') rifle.cycleMode();
    },
  });

  // Whether the rifle is in his hands this instant.
  //
  // It is not while a turret's training gear is, or the ship's wheel, or while
  // you are watching from the sea — three states that are otherwise unrelated
  // and all mean the same thing to a weapon. Slung rather than dropped: the
  // magazine, the selector and the torch all keep their state, because a man who
  // lets go of a gun to steer the ship has not put his torch out.
  function carry(on) {
    if (!rifle) return;
    rifle.show(on);
    // The copy in the deck figure's hands is drawn only when the deck figure is,
    // which is when nobody is aboard. Standing at a turret's gear is `on === false`
    // as well, and there the man is hidden — so this is keyed off `active` rather
    // than off the argument.
    rifle.showHeld(!active && avatar.modelled);
    if (reticle) reticle.show(on);
    if (!on) rifle.settle();
  }

  // --- taking and giving up a gun --------------------------------------------

  // The click that takes hold of an automatic must not also fire it.
  //
  // The trigger is a *state* — see input.js — and the button is still down at
  // the instant the gear arrives in your hands, so without this you climb onto
  // the mounting and it empties a second and a half of ammunition into the sea
  // before you have let go of the mouse. Latched on taking the gun and released
  // the first time the button comes up.
  let triggerLatch = false;

  function takeGun(station) {
    if (!station || !station.alive()) return;
    laying = station;
    triggerLatch = true;
    mag = 0; // every gun opens at x1
    station.lay.held = true;
    station.sync(); // start from where the guns actually are, in world angles
    carry(false);
    avatar.group.visible = false;
    sight.show(true);
    applyFov();
  }

  function leaveGun() {
    if (!laying) return;
    laying.lay.held = false;
    // Let go of the trigger on the way out. A gun left firing because the mouse
    // happened to be down when you pressed E would go on emptying its racks at
    // nothing while you walked away from it.
    if (laying.setTrigger) laying.setTrigger(false);
    laying = null;
    sight.show(false);
    carry(active);
    applyFov();
  }

  // --- and taking the wheel ---------------------------------------------------
  //
  // The same gesture, and a different thing at the end of it. With the wheel in
  // your hands the body is parked — you are standing at it, not walking about —
  // WASD is the helm rather than your legs, and the mouse is only your head: it
  // turns the whole way round, because a man at a wheel with windows on all four
  // sides can look at any of them.
  //
  // Nothing about the ship changes when you take it. She is steered by the same
  // telegraph and the same wheel she was steered by from outside, so whatever she
  // was doing she carries on doing until you ring something different. See
  // helmStation.js.
  function takeHelm() {
    if (!helm || !helm.alive()) return false;
    leaveGun();
    conning = helm;
    helm.hold();
    carry(false);
    avatar.group.visible = false;
    applyFov();
    return true;
  }

  function leaveWheel() {
    if (!conning) return;
    conning.release();
    conning = null;
    carry(active);
    applyFov();
  }

  // Whichever set of controls is under your hand. One door for both, so E and the
  // mouse button do not have to know which kind of gear they found.
  function takeControls(station) {
    if (!station) return;
    if (station.kind === 'helm') takeHelm();
    else takeGun(station);
  }

  function fire() {
    if (!active) return;
    if (conning) return; // both hands on the wheel
    if (laying) {
      // An automatic is not fired by a click. Its trigger is *held*, and the
      // button's state is read every frame further down in `update` — so a click
      // at this gun does nothing here and the gun answers to holding it instead.
      if (laying.setTrigger) return;
      if (laying.lay.reload > 0 || !laying.alive()) return;
      laying.lay.reload = LAYING.reload;
      // Both barrels at once, so he gets the whole of it. See LAYING.shock: the
      // guns coming back is drawn on the guns, but from the sighting hood that
      // travel is straight down the view axis and reads as nothing — this is
      // what tells him at the eyepiece that the gun went off.
      laying.jolt(1);
      // ...and this is what tells his *eye*. Two sixteen-inch guns go off a
      // couple of metres in front of the hood; the flash on the muzzles is over
      // in a third of a second and being blinded by it is not.
      sight.fire(1);
      if (onSalvo) onSalvo(laying);
      return;
    }
    // On foot: walking up to a set of training gear and pressing the button is
    // the same click that would otherwise fire the rifle. The gear wins — you
    // are standing at it, which is not a place anybody shoots from.
    if (near) { takeControls(near); return; }
    // A press fires one round whichever way the selector is set; holding it is
    // read in `update`, and only answers on automatic. See weapon.js.
    if (rifle) { rifle.trigger(); return; }
    // No rifle — the model did not load, or there never was one. The test shell
    // out of the eye is what this button did before and still does.
    if (onFire) onFire();
  }

  // Whatever optic the gun in your hands actually has. A turret carries a x36
  // telescope with three powers; the stern mounting carries a hoop of steel with
  // one. Read off the station rather than off LAYING, or Z at the AA gun zooms a
  // sight that has no lenses in it.
  const optics = () => (laying ? laying.optics : LAYING);

  function applyFov() {
    const want = laying ? optics().fov[mag] : fov;
    if (Math.abs(camera.fov - want) > 0.02) {
      camera.fov = want;
      camera.updateProjectionMatrix();
    }
  }

  function cycleMag() {
    if (!laying) return;
    mag = (mag + 1) % optics().fov.length;
    applyFov();
  }

  // --- doors -----------------------------------------------------------------

  // Is a point in this room, with a margin? Negative tightens it.
  const roomHas = (p, m) => Math.abs(p.x) < HOUSE.halfW + m
    && p.z > HOUSE.aft - m && p.z < HOUSE.fwd + m
    && p.y > HOUSE.floor - 0.8 && p.y < HOUSE.ceiling + m;

  const _cross = new Vector3();
  const _crossVel = new Vector3();

  // Crossing a gunhouse door.
  //
  // It is not a teleport, and it took making it one to see why it must not be.
  // The two frames describe the same world: a body standing in a doorway is in
  // the same place whichever of them you write its position in. So the crossing
  // is a *change of reference frame* and nothing else — convert the position,
  // convert the velocity, turn the heading by the turret's bearing, and the man
  // does not move at all. No snap, no landing spot, no respawn. The camera is
  // where it was because the eye is where it was.
  //
  // The boundary is the room itself rather than a trigger box, which is what
  // gives it the asymmetric margins the design note asks for: you are handed in
  // once you are properly inside (-0.15 m) and handed back only once you are
  // properly out (+0.35 m), and half a metre of hysteresis sits between them.
  function crossDoors(dt) {
    grace = Math.max(grace - dt, 0);
    if (grace > 0 || laying || conning) return;

    if (inside) {
      if (roomHas(player.position, 0.35)) return;
      const st = inside;
      st.space.velocityToParent(player.position, player.velocity, _crossVel);
      st.space.toParent(player.position, _cross);
      inside = null;
      player.rehome(shipSpace, access);
      player.position.copy(_cross);
      player.velocity.copy(_crossVel);
      player.state.heading += st.space.yaw;
      avatar.group.parent?.remove(avatar.group);
      body.group.add(avatar.group);
      grace = GRACE;
      return;
    }

    for (const st of stations) {
      // A working chamber is part of the ship, so there is no boundary to cross.
      if (st.inShipFrame || !st.alive()) continue;
      st.space.fromParent(player.position, _cross);
      if (!roomHas(_cross, -0.15)) continue;
      st.space.velocityFromParent(player.position, player.velocity, _crossVel);
      inside = st;
      player.rehome(st.space, null);
      player.position.copy(_cross);
      player.velocity.copy(_crossVel);
      player.state.heading -= st.space.yaw;
      avatar.group.parent?.remove(avatar.group);
      st.mount.yawPivot.add(avatar.group);
      grace = GRACE;
      return;
    }
  }

  // Are we standing at a set of controls?
  //
  // Two places to look, because there are two kinds of room: the gunhouse you
  // have been handed into, or — if you are still on the ship's own frame — any
  // working chamber whose gear you have walked up to. Both measure a distance in
  // the space the body is actually in, which is the only reason this is two
  // lines rather than a transform.
  function findControls() {
    if (laying || conning) return null;
    if (inside) {
      return player.position.distanceTo(inside.station) < inside.reach ? inside : null;
    }
    for (const st of stations) {
      if (!st.inShipFrame || !st.alive()) continue;
      if (player.position.distanceTo(st.station) < st.reach) return st;
    }
    // and the wheel, which is in the ship's frame like a working chamber is
    if (helm && helm.alive() && player.position.distanceTo(helm.station) < helm.reach) return helm;
    return null;
  }

  // --- mode ------------------------------------------------------------------

  function enter() {
    if (active) return;
    // Every space has to be read once before the first step, or the first
    // frame's finite differences see a jump from nothing.
    shipSpace.syncHull(0);
    for (const st of stations) { st.space.syncHull(0); st.space.refresh(); }
    player.rehome(shipSpace, access);
    inside = null;
    player.respawn();
    saved.position.copy(camera.position);
    saved.target.copy(controls.target);
    saved.fov = camera.fov;
    controls.enabled = false;
    fov = PLAYER.fov;
    bobPhase = 0;
    bobAmount = 0;
    camera.fov = fov;
    camera.near = 0.12; // close enough to the deck to stand on it
    camera.updateProjectionMatrix();
    active = true;
    input.enable();
    // A browser will not start an AudioContext until the user has done something,
    // and going aboard is a keypress or a button — a real gesture, and always
    // before the first round. See util/sound.js.
    if (sounds) sounds.unlock();
    carry(true);
    place();
  }

  function exit() {
    if (!active) return;
    leaveGun();
    leaveWheel();
    active = false;
    carry(false);
    // Mid-burst, and the player has just gone back to watching from a mile away.
    // The tails are two and a third seconds long and would follow him out there.
    if (sounds) sounds.silence();
    input.disable();
    controls.enabled = true;
    camera.fov = saved.fov;
    camera.near = 0.5;
    camera.updateProjectionMatrix();
    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
  }

  const toggle = () => (active ? exit() : enter());

  // --- straight to a gun -------------------------------------------------------
  //
  // Walking to a turret, finding the way in and getting to the gear is most of a
  // minute, and when you are trying to see whether the sight is drawn right you
  // want to be looking through it. This puts you at one, and pressing it again
  // moves you to the next — which is also the quickest way to check that all four
  // are actually reachable and actually lay.
  let nextStation = 0;

  function goToStation(st) {
    if (!st || !st.alive()) return false;
    if (!active) enter();
    leaveGun();
    leaveWheel();
    avatar.group.parent?.remove(avatar.group);
    if (st.inShipFrame) {
      // its room is part of the ship, so there is no space to be handed into
      inside = null;
      player.rehome(shipSpace, access);
      body.group.add(avatar.group);
    } else {
      inside = st;
      player.rehome(st.space, null);
      st.mount.yawPivot.add(avatar.group);
    }
    player.teleport(st.approach, st.approachHeading);
    grace = GRACE;
    near = st;
    takeGun(st);
    return true;
  }

  // Round the battery, skipping anything that has been shot away.
  function nextGun() {
    for (let i = 0; i < stations.length; i++) {
      const st = stations[(nextStation + i) % stations.length];
      if (goToStation(st)) {
        nextStation = (nextStation + i + 1) % stations.length;
        return st;
      }
    }
    return null;
  }

  // Straight to the wheel, for the same reason `nextGun` exists: the climb to the
  // bridge is a minute of ladders, and when what you want to see is whether the
  // wheelhouse looks right from the wheel you should be at the wheel.
  function goToHelm() {
    if (!helm || !helm.alive()) return false;
    if (!active) enter();
    leaveGun();
    avatar.group.parent?.remove(avatar.group);
    inside = null;
    player.rehome(shipSpace, access);
    body.group.add(avatar.group);
    player.teleport(helm.approach, helm.approachHeading);
    player.state.pitch = 0;
    grace = GRACE;
    near = helm;
    takeHelm();
    return true;
  }

  function feel(dt) {
    const speed = player.state.grounded ? player.speed : 0;
    bobPhase += (speed / Math.max(PLAYER.walk, 0.01)) * dt * 7.4;
    const want = Math.min(speed / PLAYER.walk, 1.35);
    bobAmount += (want - bobAmount) * Math.min(dt * 9, 1);

    // Wider flat out, narrower with the sights up. The second is not a zoom and
    // is not pretending to be one: an aperture sight has no lenses in it. It is
    // what happens to the *picture* when a man stops scanning and starts looking
    // at one thing, and sixteen degrees of it is about the difference.
    const wantFov = PLAYER.fov
      + PLAYER.sprintFov * Math.min(Math.max(
        (player.speed - PLAYER.walk) / (PLAYER.sprint - PLAYER.walk), 0,
      ), 1)
      + (rifle ? RIFLE.aimFov * rifle.aiming : 0);
    fov += (wantFov - fov) * Math.min(dt * 6, 1);
    applyFov();
  }

  // worldPose = M . L, for the eye and for the way it is looking. `L` is in
  // whatever space the body is in — the hull's frame on deck, a gunhouse's frame
  // inside one — and composing it out is the space's business, not this file's.
  function place() {
    const space = player.space;
    // Two steps to a stride, so the rise and fall runs at twice the sway.
    const rise = Math.sin(bobPhase * 2) * PLAYER.bob * bobAmount;
    const sway = Math.sin(bobPhase) * PLAYER.bobRoll * bobAmount;
    // `player.eye`, not PLAYER.eye: he can crouch, and the camera has to come
    // down with the collision capsule or the head goes through whatever he
    // ducked under. See character.js.
    _local.set(player.position.x, player.position.y + player.eye + rise, player.position.z);
    space.toWorld(_local, _world);
    camera.position.copy(_world);
    // The view rolls with whatever you are standing in, because that is the frame
    // you are standing in. Yaw and pitch are yours; the space's attitude is laid
    // on top, and the sway on top of that.
    _euler.set(player.state.pitch, player.state.heading + Math.PI, sway);
    camera.quaternion.copy(space.worldQuaternion).multiply(_q.setFromEuler(_euler));
  }

  // Called every frame whether or not first person is active: the avatar keeps
  // standing where it is when you are watching from outside, the turrets keep
  // laying, and the derivatives want a continuous history rather than one that
  // restarts every time you go aboard.
  function update(dt, now) {
    shipSpace.syncHull(dt);

    // Order matters here, and it is the difference between a sight that answers
    // the mouse and one that answers it a frame late: take the mouse, let the
    // mounts run on it, and only *then* work out where the gunhouses ended up.
    // Reading the frames the other way round shows you last frame's bearing
    // through this frame's sight, which at x36 is a visible stutter.
    const look = active ? input.consumeLook() : null;
    if (laying && look) {
      // The mouse moves the *sight*, not the guns, and it moves it as fast as
      // the hand does — there is nothing between the two. The guns then go after
      // the line at the rate the engines can hold, which is what the pip shows. `look` arrives already
      // multiplied by the walking sensitivity, so that is divided back out.
      //
      // Scaled by the field itself, so a pixel of mouse is the same fraction of
      // the picture at every magnification: about a screen per three hundred and
      // fifty pixels, x1 or x36.
      //
      // It used to be scaled by the square root of the field, because linear
      // scaling made a x36 sight too slow to traverse in — but that was the
      // leash talking. Traversing meant waiting for the mount, so the sight had
      // to be over-geared to get anywhere, and the price was that fine laying at
      // high power was twitchy. With the sight free of the guns you can throw it
      // across the horizon at any power, so it can afford to be geared honestly,
      // and a small movement at x36 is now a small movement.
      const gearing = laying.setTrigger ? AA_LAYING.sensitivity : LAYING.sensitivity;
      const f = optics().fov;
      const perPixel = gearing * (f[mag] / f[0]);
      const dx = (look.yaw / PLAYER.sensitivity) * perPixel;
      const dy = (look.pitch / PLAYER.sensitivity) * perPixel;
      // Two guns, two frames the hand is working in, and the station says which.
      //
      // A turret's demand is a bearing and an elevation in the *world*, so a hand
      // held still holds the sight still however she rolls — that is the gyro
      // sight. The stern mounting has no gyro: its demand is in its own frame, the
      // hand moves the gun relative to the ship, and the sea moves the picture.
      // The signs are the same either way and they match the walking camera —
      // mouse right trains to starboard, mouse up elevates — because a sight that
      // goes down when you push the mouse up is unusable however good the rest of
      // it is.
      if (laying.look) laying.look(dx, dy);
      else {
        laying.lay.sightBearing += dx;
        laying.lay.sightPitch += dy;
      }
    }
    // The trigger, as a state rather than as an event: an automatic is held
    // down. Read every frame and only while the gear is in your hands, so
    // clicking your way back into the tub does not open fire on the way past.
    if (!input.firing) triggerLatch = false;
    if (laying && laying.setTrigger) {
      laying.setTrigger(active && input.firing && !triggerLatch);
    }
    // Ahead of any of the branches below, so the dazzle fades on wall time
    // rather than only while something happens to be redrawing the sight.
    sight.step(dt);
    for (const st of stations) st.step(dt);
    // The automatic going off in the layer's face.
    //
    // A turret's salvo gets the full dazzle once every six seconds, because that
    // is what happens: two sixteen-inch guns and then a long wait. This gun
    // gives him a fifth of that nine times a second and never lets it clear, so
    // what he is looking through the whole time he has the trigger down is a
    // washed-out picture that comes back the moment he stops. That is the honest
    // reason an open mounting has a flash hider on every barrel, and it is the
    // one cue that makes a long burst *cost* something to look at.
    if (laying && laying.lay.firing) sight.fire(0.18);
    for (const st of stations) {
      st.space.syncHull(dt);
      st.space.refresh();
    }
    // The wheel and the telegraph lever turn whether or not anybody is holding
    // them, because they show what the ship has been told and she can be told it
    // from the sea view as well as from the bridge.
    if (helm) helm.step(dt);

    if (!active) {
      player.step(dt, IDLE, now);
      avatar.group.visible = true;
      avatar.place(player.position, player.state.heading);
      poseAvatar(dt);
      // Not held, but still burning: a torch left on when you go back to watching
      // her from the sea is still on the end of the rifle in his hands, and the
      // light it throws has to keep following him about her deck. Everything
      // inside that is about *aiming* is skipped — see `s.held`.
      if (rifle) rifle.update(dt, { held: false });
      return;
    }

    if (laying) {
      laying.sight(camera);
      const off = laying.demandOffset(optics().fov[mag]);
      // Two guns, two instruments. A turret's sight is a range plate and a
      // shell; an automatic's is a rounds counter and a heat gauge, because
      // those are the two numbers that decide whether you may pull the trigger.
      if (laying.setTrigger) {
        sight.set({
          mode: 'aa',
          mount: laying.id.replace('aa.', ''),
          mag,
          field: optics().fov[mag],
          dx: off.dx,
          dy: off.dy,
          far: off.far,
          ...laying.readout(),
        });
      } else {
        const shell = shellFor ? shellFor() : { key: '—' };
        sight.set({
          mode: 'turret',
          range: laying.rangeAt(laying.mount.elev),
          tof: laying.flightTime(laying.mount.elev),
          turret: laying.id.replace('turret.', ''),
          shell: shell.key,
          mag,
          reload: laying.lay.reload,
          dx: off.dx,
          dy: off.dy,
          far: off.far,
        });
      }
      avatar.group.visible = false;
      return;
    }

    // The mouse is your head, and at the wheel that is *all* it is. Heading is not
    // wrapped or limited, so it turns the whole way round — the wheelhouse has
    // windows on four sides and you should be able to look out of any of them
    // without letting go.
    player.state.heading += look.yaw;
    player.state.pitch = Math.min(
      Math.max(player.state.pitch + look.pitch, -PLAYER.pitchLimit),
      PLAYER.pitchLimit,
    );

    if (conning) {
      // Standing at the wheel: the body does not step at all, exactly as it does
      // not while laying a gun. It stays where it was put and the space carries it,
      // so she heaves and rolls under you and the horizon moves in the windows
      // without the legs having to be simulated to do it. WASD is hers now — see
      // helmStation.js for why the keys go to the ship's own helm rather than
      // through here.
      if (!conning.alive()) leaveWheel();
      feel(dt);
      place();
      avatar.group.visible = false;
      avatar.place(player.position, player.state.heading);
      return;
    }

    const keys = input.read();
    player.step(dt, keys, now);
    crossDoors(dt);
    near = findControls();
    feel(dt);
    place();
    avatar.group.visible = false;
    avatar.place(player.position, player.state.heading);

    // The rifle, last: it hangs off the camera and reads the camera's axis for
    // where the round goes, so it has to run after `place` has put the camera
    // where it belongs this frame. Running it before is a weapon that answers
    // last frame's look — the same argument, and the same frame of lag, as the
    // note about the mouse and the mounts at the top of this function.
    if (rifle) {
      rifle.update(dt, {
        held: true,
        firing: input.firing,
        aiming: input.aiming,
        look,
        speed: player.speed,
        sprinting: keys.sprint && player.state.grounded,
        grounded: player.state.grounded,
        crouch: player.state.crouch,
      });
      // What the recoil has walked the aim to, handed back once and cleared. The
      // weapon does not move the camera itself — the camera is not its to move,
      // and a weapon that writes the look directly cannot be overridden by the
      // hand that is trying to pull it back down.
      rifle.consumePunch(_punch);
      player.state.pitch = Math.min(
        Math.max(player.state.pitch + _punch.pitch, -PLAYER.pitchLimit),
        PLAYER.pitchLimit,
      );
      player.state.heading += _punch.yaw;
      if (reticle) {
        reticle.update(dt);
        reticle.set({
          rounds: rifle.rounds,
          capacity: rifle.capacity,
          mode: rifle.mode,
          reloading: rifle.reloading,
          reloadFor: RIFLE.reload,
          torch: rifle.torch,
          spread: rifle.spread,
          fov: camera.fov,
          aiming: rifle.aiming,
        });
      }
    }
  }

  // The figure, posed. Split out because it is wanted from two places — the
  // frame where nobody is aboard and he is standing on the deck being looked at
  // from the sea, and the frame where he is being walked about — and because
  // neither of them should have to know the shape of what soldier.js wants.
  function poseAvatar(dt) {
    const st = player.state;
    avatar.pose(dt, {
      speed: player.speed,
      grounded: st.grounded,
      climbing: st.climbing,
      crouch: st.crouch,
      height: player.height,
      pitch: st.pitch,
      aiming: !!(rifle && rifle.aiming > 0.5),
      recoil: rifle ? rifle.recoil : 0,
    });
    avatar.sync();
  }

  return {
    get active() { return active; },
    get laying() { return laying; },
    get inside() { return inside; },
    get near() { return near; },
    get conning() { return conning; },
    get magnification() { return optics().labels[mag]; },
    // The rifle, for the read-out. Null when the model did not load, which is
    // the case the HUD has to be able to say something about.
    rifle,
    // Whether the man on the deck is the modelled figure or the capsule that
    // stands in for one — same reason.
    get modelled() { return avatar.modelled; },
    enter,
    exit,
    toggle,
    update,
    takeGun,
    leaveGun,
    takeControls,
    takeHelm,
    leaveWheel,
    goToHelm,
    helm,
    goToStation,
    nextGun,
    cycleMag,
    stations,
    stationById,
    space: shipSpace,
    player,
    avatar,
    access,
    house: HOUSE,
    get locked() { return input.locked; },
    worldPosition: (out) => player.worldPosition(out),
  };
}
