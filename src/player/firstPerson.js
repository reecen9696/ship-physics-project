import { Euler, Quaternion, Vector3 } from 'three/webgpu';
import { createShipSpace } from './shipSpace.js';
import { createDeckAccess } from './deckAccess.js';
import { createCharacter } from './character.js';
import { createAvatar } from './avatar.js';
import { createPlayerInput } from './input.js';
import { createGunsight } from './gunsight.js';
import { createTurretStation, LAYING } from './turretStation.js';
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
  onFire = null, onSalvo = null, shellFor = null,
}) {
  const shipSpace = createShipSpace({ id: 'ship', body, colliders, hull });
  const access = createDeckAccess({ mounts, alive });
  const player = createCharacter({ space: shipSpace, extra: access, spawn });
  const avatar = createAvatar({ materials });
  body.group.add(avatar.group); // ship-local by construction

  // One station per main-battery turret: its own space, its own doors, its own
  // training gear.
  const stations = mounts
    ? turrets.map((t) => createTurretStation({
      turret: t, mount: mounts.get(t.id), shipSpace, damage,
    }))
    : [];
  const stationById = new Map(stations.map((s) => [s.id, s]));

  const sight = createGunsight();

  let active = false;
  let laying = null; // the station whose gear is in our hands, or null
  let inside = null; // the station whose gunhouse we are standing in, or null
  let grace = 0;
  let mag = 1;
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
  });

  // --- taking and giving up a gun --------------------------------------------

  function takeGun(station) {
    if (!station || !station.alive()) return;
    laying = station;
    // Start from where the guns actually are, or the first thing the gear does
    // is chase a demand nobody asked for.
    station.lay.held = true;
    station.lay.demandYaw = station.mount.yaw;
    station.lay.demandElev = station.mount.elev;
    station.lay.trainRate = 0;
    station.lay.elevRate = 0;
    avatar.group.visible = false;
    sight.show(true);
    applyFov();
  }

  function leaveGun() {
    if (!laying) return;
    laying.lay.held = false;
    laying = null;
    sight.show(false);
    applyFov();
  }

  function fire() {
    if (!active) return;
    if (laying) {
      if (laying.lay.reload > 0 || !laying.alive()) return;
      laying.lay.reload = LAYING.reload;
      if (onSalvo) onSalvo(laying);
      return;
    }
    // On foot: walking up to a set of training gear and pressing the button is
    // the same click that would otherwise put a shell into her.
    if (near) { takeGun(near); return; }
    if (onFire) onFire();
  }

  function applyFov() {
    const want = laying ? LAYING.fov[mag] : fov;
    if (Math.abs(camera.fov - want) > 0.02) {
      camera.fov = want;
      camera.updateProjectionMatrix();
    }
  }

  function cycleMag() {
    if (!laying) return;
    mag = (mag + 1) % LAYING.fov.length;
    applyFov();
  }

  // --- doors -----------------------------------------------------------------

  function crossDoors(dt) {
    grace = Math.max(grace - dt, 0);
    if (grace > 0 || laying) return;

    if (inside) {
      // On the way out. These volumes are against the inside of each door, and
      // the landing is well clear of them, so there is nothing to oscillate on.
      for (const d of inside.doorsIn) {
        if (!inBox(player.position, d)) continue;
        const out = inside.doorsOut.find((o) => o.side === d.side) ?? inside.doorsOut[0];
        inside = null;
        player.rehome(shipSpace, access);
        avatar.group.parent?.remove(avatar.group);
        body.group.add(avatar.group);
        _v.copy(out.c);
        _v.x += Math.sign(out.c.x) * (out.h.x + 0.75);
        _v.y = out.sill + 0.5;
        player.teleport(_v, Math.sign(out.c.x) > 0 ? Math.PI / 2 : -Math.PI / 2);
        grace = GRACE;
        return;
      }
      return;
    }

    // On the way in. The entry volumes are stated in the ship's frame at each
    // turret's rest bearing, because the deck you are standing on does not train
    // and neither does a bandstand.
    for (const st of stations) {
      if (!st.alive()) continue;
      for (const d of st.doorsOut) {
        if (!inBox(player.position, d, 0.15)) continue;
        const land = st.landing(d.side);
        player.rehome(st.space, null);
        inside = st;
        avatar.group.parent?.remove(avatar.group);
        st.mount.yawPivot.add(avatar.group);
        player.teleport(land.position, land.heading);
        grace = GRACE;
        return;
      }
    }
  }

  // Are we standing at a set of controls? Only ever asked inside a gunhouse.
  function findControls() {
    if (!inside || laying) return null;
    return player.position.distanceTo(inside.station) < inside.reach ? inside : null;
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
    place();
  }

  function exit() {
    if (!active) return;
    leaveGun();
    active = false;
    input.disable();
    controls.enabled = true;
    camera.fov = saved.fov;
    camera.near = 0.5;
    camera.updateProjectionMatrix();
    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
  }

  const toggle = () => (active ? exit() : enter());

  function feel(dt) {
    const speed = player.state.grounded ? player.speed : 0;
    bobPhase += (speed / Math.max(PLAYER.walk, 0.01)) * dt * 7.4;
    const want = Math.min(speed / PLAYER.walk, 1.35);
    bobAmount += (want - bobAmount) * Math.min(dt * 9, 1);

    const wantFov = PLAYER.fov
      + PLAYER.sprintFov * Math.min(Math.max(
        (player.speed - PLAYER.walk) / (PLAYER.sprint - PLAYER.walk), 0,
      ), 1);
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
    _local.set(player.position.x, player.position.y + PLAYER.eye + rise, player.position.z);
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
    for (const st of stations) {
      st.space.syncHull(dt);
      st.space.refresh();
      st.step(dt);
    }

    if (!active) {
      player.step(dt, IDLE, now);
      avatar.group.visible = true;
      avatar.place(player.position, player.state.heading);
      return;
    }

    const look = input.consumeLook();
    if (laying) {
      // The mouse moves the *demand*, not the guns. What the guns do about it is
      // the mount's business, and it takes its time. `look` arrives already
      // multiplied by the walking sensitivity, so it is divided back out: a
      // pixel of mouse should be the same angle *on the target* at any
      // magnification, which is the only thing that makes a x36 sight usable.
      const perPixel = LAYING.sensitivity * (LAYING.fov[mag] / LAYING.fov[0]);
      laying.lay.demandYaw -= (look.yaw / PLAYER.sensitivity) * perPixel;
      laying.lay.demandElev -= (look.pitch / PLAYER.sensitivity) * perPixel;
      laying.sight(camera);
      const off = laying.demandOffset(LAYING.fov[mag]);
      const shell = shellFor ? shellFor() : { key: '—', speed: 320 };
      sight.set({
        range: laying.rangeAt(laying.mount.elev, shell.speed),
        turret: laying.id.replace('turret.', ''),
        shell: shell.key,
        mag,
        reload: laying.lay.reload,
        dx: off.dx,
        dy: off.dy,
      });
      avatar.group.visible = false;
      return;
    }

    player.state.heading += look.yaw;
    player.state.pitch = Math.min(
      Math.max(player.state.pitch + look.pitch, -PLAYER.pitchLimit),
      PLAYER.pitchLimit,
    );
    player.step(dt, input.read(), now);
    crossDoors(dt);
    near = findControls();
    feel(dt);
    place();
    avatar.group.visible = false;
    avatar.place(player.position, player.state.heading);
  }

  return {
    get active() { return active; },
    get laying() { return laying; },
    get inside() { return inside; },
    get near() { return near; },
    get magnification() { return LAYING.magLabels[mag]; },
    enter,
    exit,
    toggle,
    update,
    takeGun,
    leaveGun,
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
