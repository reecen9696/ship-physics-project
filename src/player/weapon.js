import {
  AdditiveBlending, BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh,
  MeshBasicNodeMaterial, Quaternion, SphereGeometry, Vector3,
} from 'three/webgpu';
import { makeRifle } from './models.js';
import { bakeFigure, syncFieldXform } from './figureMaterial.js';
import { MUZZLE, MUZZLE_SLOT, TORCH, TORCH_SLOT } from '../scene/torch.js';
import { PLAYER } from './spec.js';

// The rifle in your hands.
//
// Everything else that shoots in this game is a mounting: it is bolted to the
// ship, it is laid by a pair of handwheels, and the whole of it — the training
// gear, the six-second loading cycle, the sight that is a room you sit in — is
// about the gap between where you asked the gun to point and where fifteen
// hundred tonnes of gunhouse has got to. A rifle is the opposite of that in
// every particular. It points where you are looking, it goes off the instant you
// ask, and the only lag in the whole system is the eighth of a second your own
// shoulder takes to come back down.
//
// So this file shares nothing with turretStation.js on purpose, and the four
// things it has to get right are the four things that file never has to think
// about:
//
//   1. A view model. The weapon is drawn a third of a metre from the camera, in
//      the camera's own frame, and almost all of what makes it feel like a
//      weapon is how it *lags* — the sway when you turn, the bob when you run,
//      the kick and the recovery. None of that is simulation. All of it is a
//      second-order response to inputs the camera already has.
//   2. Hitscan. A rifle bullet crosses this ship in a fifth of a second, and the
//      gunnery in battleship/gunnery.js is a ballistic solver with drag in it
//      that exists so a sixteen-inch shell can be lofted twenty miles. Putting a
//      5.56 round through it would be right and would also mean the round is a
//      physics object for two frames. It is a ray, marched against the same
//      analytic collision field the player's own feet are standing on.
//   3. Sound. Which is not a detail here: the muzzle report *is* the feedback
//      that a round went off, far more than the flash is, and it is the one part
//      of a weapon nobody forgives you for getting wrong. See util/sound.js.
//   4. The torch, which is the reason half of this ship is worth walking round
//      after dark. See scene/torch.js.
//
// --- what it does to the ship ---------------------------------------------------
//
// Nothing. A 5.56 round against 13 inches of belt, a barbette or a gunhouse face
// does not scratch the paint, and the damage model is written in terms of
// components being shot away. Rounds mark and spark and that is all they do,
// which is the honest answer and also the one that does not put a rifle on the
// same footing as an armour-piercing shell.

export const RIFLE = {
  // --- the weapon ------------------------------------------------------------
  rounds: 30,
  rpm: 750, // an M16A1 on automatic
  // Muzzle velocity is not used — the shot is a ray — but the range at which the
  // round stops being modelled is, and it is set by what is on this ship rather
  // than by the cartridge: four hundred metres reaches the far end of her from
  // either end with room to spare.
  range: 400,
  reload: 2.62, // s, and it is the length of the sample, which is the honest way
  // to time a reload animation nobody has authored
  chamber: 0.55, // s more if the bolt went back — the charging handle, at the end

  // --- where the rounds go ----------------------------------------------------
  //
  // Cone half-angles in degrees. The standing figure is the weapon and the
  // shooter together; going prone or bracing is not modelled, so the difference
  // between the two numbers is doing the work that a whole stance system would.
  spreadHip: 2.4,
  spreadAim: 0.28,
  // How much each round in a burst adds, and how fast it comes back off. This is
  // the thing that makes automatic fire a decision rather than a button: the
  // first three rounds go where you are looking and the rest go where the rifle
  // has walked to.
  bloom: 0.42, // degrees added per round
  bloomMax: 3.4,
  bloomDecay: 3.6, // degrees a second

  // --- what it does to you ----------------------------------------------------
  //
  // Two separate things, and conflating them is the usual mistake. The *view*
  // kicks and comes all the way back, so the weapon moves in your hands and the
  // picture recovers by itself. The *aim* is walked upward and does not come
  // back, so a long burst climbs and you have to pull it down. One is feel; the
  // other is the cost of holding the trigger.
  kickBack: 0.055, // m the weapon comes back toward the eye
  kickRise: 0.020, // m it climbs
  kickPitch: 2.1, // degrees the muzzle flips
  kickRoll: 1.4,
  kickRecover: 13, // 1/s the spring pulls it home
  climb: 0.28, // degrees of real aim, per round, that stays
  climbYaw: 0.11, // and how much of it wanders off to one side

  // --- how it hangs -----------------------------------------------------------
  //
  // Both poses are the position of the *sight datum* — the model's origin sits on
  // the line through the front post and the rear aperture, see player/models.js —
  // in the camera's own frame. Which is what makes the aimed pose trivial: put
  // the datum on the camera axis and the sights are aligned, by construction,
  // with no fudge factor and nothing to re-tune when the field of view changes.
  // Far enough out that the whole weapon is in front of the eye. The datum is
  // over the receiver — the middle of the gun, not the back of it — so a hip
  // pose set by eye at a third of a metre puts the butt plate behind the camera
  // and fills the bottom corner of the screen with the inside of a stock. The
  // butt sits a few centimetres in front of the near plane at this distance and
  // the muzzle a metre out, which is where a rifle carried at the waist is.
  hip: {
    pos: [0.185, -0.200, -0.52],
    rot: [3.0, -7.5, 2.4], // degrees
  },
  aim: {
    // x and y are zero and have to be: any other value is a weapon whose sights
    // do not line up with the middle of the screen.
    pos: [0, 0, -0.36],
    rot: [0, 0, 0],
  },
  aimTime: 0.16, // s from one to the other
  aimFov: -16, // how much narrower the field goes when the sights come up

  // Sway and bob. Both are small and both are the whole difference between a
  // weapon held by a person and one welded to the camera.
  swayAmount: 0.055, // m per radian-per-second of look
  swayTilt: 14, // degrees of the same
  swayDamp: 9, // 1/s the weapon catches up with the view
  bob: 0.021, // m at a walk
  bobRoll: 1.9, // degrees
  // Running with the weapon down. Not a separate pose — the same hip pose,
  // rolled out of the way — because a sprint pose you can shoot out of instantly
  // is worth more than one that looks better and costs you the shot.
  sprintDrop: 0.075,
  sprintTilt: 22,

  // --- and where it will not go ------------------------------------------------
  //
  // A view model is drawn in front of everything and does not collide, so walking
  // up to a bulkhead puts three quarters of a metre of barrel through it. The
  // usual fix is a second render pass with its own depth range, which is a lot of
  // machinery for a rifle; this is the other fix, which is what a person would do
  // anyway — bring it in when there is something in the way.
  clearance: 0.95, // m ahead of the eye that is probed
  clearDrop: 0.14, // m the weapon comes down when there is
  clearTilt: 34, // degrees
};

const DEG = Math.PI / 180;
const _v = new Vector3();
const _w = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();

// The bright, unshaded stuff: a muzzle flash, a tracer, the lens of a torch.
// None of it is a surface — it is all light with a shape — so it is drawn flat
// and added rather than lit.
function glowMaterial(color, opacity = 1) {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.blending = AdditiveBlending;
  m.color.setRGB(color[0], color[1], color[2]);
  m.opacity = opacity;
  m.toneMapped = false;
  return m;
}

// --- the tracers -----------------------------------------------------------
//
// One stretched box per round in the air, and "in the air" means about a
// twentieth of a second: a tracer is not the round, it is the streak the round
// leaves on your eye, and drawing it for as long as the round would actually
// take to arrive gives you a bright dash crawling across the deck.
//
// They are parented to the hull rather than to the world, because at twenty
// knots she moves half a metre while one is alight and a tracer left behind in
// world space visibly slides aft.
function createTracers(root, max = 24) {
  const geo = new BoxGeometry(0.012, 0.012, 1);
  geo.translate(0, 0, 0.5); // the near end on the origin, running out along +Z
  const mat = glowMaterial([2.6, 1.9, 0.9], 0.85);
  const FORWARD = new Vector3(0, 0, 1);
  const pool = [];
  const live = [];
  const LIFE = 0.055;

  function fire(from, to) {
    const mesh = pool.pop() ?? (() => {
      const m = new Mesh(geo, mat.clone());
      m.frustumCulled = false;
      return m;
    })();
    mesh.position.copy(from);
    // Not `lookAt`: that one takes its target in world space, and both ends of a
    // tracer are in the hull's frame — which is the entire point of parenting
    // them to her. Set the rotation from the two points directly instead.
    _d.subVectors(to, from);
    const len = Math.max(_d.length(), 0.1);
    mesh.quaternion.setFromUnitVectors(FORWARD, _d.divideScalar(len));
    mesh.scale.z = len;
    mesh.material.opacity = 0.85;
    mesh.visible = true;
    root.add(mesh);
    live.push({ mesh, t: 0 });
  }

  function update(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const s = live[i];
      s.t += dt;
      const k = 1 - s.t / LIFE;
      if (k <= 0) {
        s.mesh.visible = false;
        root.remove(s.mesh);
        pool.push(s.mesh);
        live.splice(i, 1);
      } else {
        s.mesh.material.opacity = 0.85 * k * k;
      }
    }
  }

  return { fire, update, get count() { return live.length; } };
}

// --- the flash ---------------------------------------------------------------
//
// Three parts on three clocks, which is the same shape as the sixteen-inch
// version in battleship/muzzleBlast.js and for the same reason — a flash is gas
// leaving a bore, burning in the open, and a shock coming off sideways — but at
// a thirtieth of the size and an eighth of the duration, and built here rather
// than reused because everything in that file is scaled off a bore and a 5.56
// bore scales it down to something you cannot see.
function createFlash() {
  const group = new Group();
  group.visible = false;

  const core = new Mesh(new SphereGeometry(0.028, 8, 6), glowMaterial([3.4, 3.0, 2.2]));
  const jet = new ConeGeometry(0.055, 0.22, 9, 1, true);
  jet.rotateX(Math.PI / 2); // the lathe's +y down the bore...
  jet.translate(0, 0, -0.11); // ...apex on the muzzle, mouth ahead of it
  const flame = new Mesh(jet, glowMaterial([2.6, 1.5, 0.55]));
  const disc = new Mesh(new SphereGeometry(0.09, 10, 6), glowMaterial([1.9, 1.15, 0.5]));
  disc.scale.z = 0.14;
  for (const m of [core, flame, disc]) { m.frustumCulled = false; m.renderOrder = 24; }
  group.add(core, flame, disc);

  let t = 1e3;
  const LIFE = { core: 0.030, jet: 0.048, disc: 0.062 };

  return {
    group,
    fire() {
      t = 0;
      group.visible = true;
      // No two alike: the gas leaves through a three-pronged flash hider and the
      // shape it makes is different every round.
      group.rotation.z = Math.random() * Math.PI * 2;
      const s = 0.85 + Math.random() * 0.35;
      core.scale.setScalar(s);
      flame.scale.set(s, s, 0.8 + Math.random() * 0.5);
    },
    update(dt) {
      if (t > 0.2) return;
      t += dt;
      const fade = (life) => Math.max(0, 1 - t / life);
      core.material.opacity = fade(LIFE.core) ** 1.2;
      flame.material.opacity = fade(LIFE.jet) ** 1.4;
      disc.material.opacity = fade(LIFE.disc) ** 2 * 0.7;
      core.visible = core.material.opacity > 0.003;
      flame.visible = flame.material.opacity > 0.003;
      disc.visible = disc.material.opacity > 0.003;
      group.visible = core.visible || flame.visible || disc.visible;
    },
    get live() { return t < LIFE.disc; },
    get age() { return t; },
  };
}

// --- the torch, as a thing you can see -----------------------------------------
//
// The light itself is a handful of uniforms (scene/torch.js) and lands on the
// ship. This is the other half: the lamp bolted to the handguard, its lens when
// it is burning, and the beam in the air between them.
function createTorchBody(material) {
  const group = new Group();

  const body = new Mesh(
    bakeFigure(
      new CylinderGeometry(0.017, 0.017, 0.09, 10).rotateX(Math.PI / 2),
      { color: [0.045, 0.046, 0.05], roughness: 0.45, metal: 0.6 },
    ),
    material,
  );
  group.add(body);

  const lens = new Mesh(
    new CylinderGeometry(0.015, 0.015, 0.004, 10).rotateX(Math.PI / 2),
    glowMaterial([2.4, 2.2, 1.7]),
  );
  lens.position.z = -0.047;
  lens.visible = false;
  group.add(lens);

  // The beam in the air. Nothing physical: a very faint additive cone, opened to
  // the same angle the light uses, whose opacity is driven by how dark it is.
  // In daylight it is not drawn at all, which is right — you cannot see a torch
  // beam in the sun, and drawing one is the single most common way a torch is
  // made to look like a toy.
  const spread = Math.tan(TORCH.outer * DEG) * 14;
  const cone = new ConeGeometry(spread, 14, 16, 1, true);
  cone.rotateX(Math.PI / 2);
  cone.translate(0, 0, -7);
  const beam = new Mesh(cone, glowMaterial([0.9, 0.85, 0.72], 0));
  beam.renderOrder = 22;
  beam.frustumCulled = false;
  beam.visible = false;
  group.add(beam);

  return {
    group,
    set(on, night) {
      lens.visible = on;
      const a = on ? 0.017 * Math.min(Math.max(night, 0), 1) : 0;
      beam.visible = a > 0.001;
      beam.material.opacity = a;
    },
  };
}

// --- the rifle ------------------------------------------------------------------

export function createRifle({
  camera,
  // The figure program — the rifle is shaded by it exactly as the man holding it
  // is. See player/figureMaterial.js.
  material,
  // What came out of the FBX: a merged geometry and the three mount points.
  proto,
  // The hull. Three things need it: the tracers hang off it, the carried lights
  // are stated in her frame, and the hitscan converts through it.
  root,
  // `{ set, clear }` off `battleship.materials.torch` — see scene/torch.js.
  lights = null,
  // The ship's smoke and fire system, for what a round does where it lands.
  fx = null,
  // `shading.night`, so the beam knows whether it is worth drawing.
  shading = null,
  sounds = null,
  // Called with the impact when a round lands on something solid. The reticle
  // draws a mark off it; nothing else listens, and nothing here needs to know
  // that.
  onHit = null,
  // Which space the shooter's body is being simulated in, this frame. It changes
  // when he walks into a gunhouse, and the hitscan has to follow him: the
  // colliders it marches are that space's, in that space's frame.
  getSpace,
}) {
  const view = makeRifle(proto, material); // in the camera's frame
  const held = makeRifle(proto, material); // in the deck figure's hands
  view.visible = false;
  held.visible = false;
  for (const g of [view, held]) g.traverse((o) => { o.frustumCulled = false; });

  // The muzzle and the torch, as nodes on each copy rather than as points looked
  // up on demand: parenting is what keeps them right through the sway, the kick
  // and whatever the ship is doing, without anything having to recompute a
  // transform.
  const rigs = [view, held].map((g) => {
    const muzzle = new Group();
    muzzle.position.copy(proto.muzzle);
    const flash = createFlash();
    muzzle.add(flash.group);
    const torch = createTorchBody(material);
    torch.group.position.copy(proto.torch);
    g.add(muzzle, torch.group);
    return { group: g, muzzle, flash, torch };
  });
  const viewRig = rigs[0];
  const heldRig = rigs[1];

  const tracers = createTracers(root);

  // --- state ----------------------------------------------------------------
  let rounds = RIFLE.rounds;
  let chambered = true; // a round in the spout: whether the bolt stayed forward
  let auto = true;
  let cooldown = 0;
  let reloading = 0;
  let bloom = 0;
  let torchOn = false;
  let flashLight = 1e3; // seconds since the last shot, for the light in slot 1
  let shots = 0;

  // The view model's own second-order state. None of it is the weapon's position
  // — that is recomputed from scratch every frame — it is what the weapon is
  // still recovering from.
  const sway = { x: 0, y: 0, vx: 0, vy: 0 };
  const kick = { back: 0, rise: 0, pitch: 0, roll: 0 };
  const punch = { pitch: 0, yaw: 0 }; // real aim, waiting to be handed to the look
  let aim = 0; // 0 hip, 1 sights up
  let clear = 1; // 1 nothing in the way, 0 pressed against a bulkhead
  let bobPhase = 0;
  let bobAmount = 0;

  const interval = 60 / RIFLE.rpm;

  // --- where a round goes -----------------------------------------------------
  //
  // Marched against the collision field rather than raycast against the meshes,
  // and the reason is what the field is: an analytic description of the ship
  // that the player's own feet are already being stood on, in the frame he is
  // already in. Raycasting the drawn geometry would mean walking nine hundred
  // meshes for every round, in a frame that has to be composed out first, and
  // would then disagree with the surface he is standing on about where the ship
  // is.
  //
  // Two step sizes, because the two cases are different: almost every round
  // fired aboard hits something within a few metres, and the ones that do not
  // are going out over the sea and want reach rather than resolution.
  const _hit = { normal: new Vector3(), id: null };
  const _from = new Vector3();
  const _dir = new Vector3();
  const _at = new Vector3();
  const impact = { point: new Vector3(), normal: new Vector3(), id: null, hit: false };

  function march(space, from, dir) {
    impact.hit = false;
    const colliders = space.colliders;
    const skip = space.skipShapes ?? null;
    const b = colliders.bounds;
    const M = 4;
    const inBounds = (p) => p.x > b.min.x - M && p.x < b.max.x + M
      && p.y > b.min.y - M && p.y < b.max.y + M
      && p.z > b.min.z - M && p.z < b.max.z + M;

    let t = 0.35; // clear of the shooter's own body
    let step = 0.22;
    let last = t;
    for (let i = 0; i < 700 && t < RIFLE.range; i++) {
      _at.copy(from).addScaledVector(dir, t);
      // Once the ray is outside her bounding box it is over the sea and there is
      // nothing left to hit. Not before, though — fired down her length it stays
      // inside the box for a hundred and eighty metres.
      if (!inBounds(_at) && t > 6) break;
      if (colliders.query(_at, _hit, null, skip) > 0) {
        // Bisect back onto the surface. Six halvings of a 22 cm step is 3 mm,
        // which is finer than the flash that is about to be drawn on it.
        let lo = last;
        let hi = t;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) * 0.5;
          _at.copy(from).addScaledVector(dir, mid);
          if (colliders.query(_at, _hit, null, skip) > 0) hi = mid; else lo = mid;
        }
        _at.copy(from).addScaledVector(dir, hi);
        // Read the normal a little way *inside* the surface, the way the floor
        // probe does: a sample taken exactly on it can come back from whichever
        // shape the bisection happened to land in.
        _p.copy(_at).addScaledVector(dir, 0.04);
        colliders.query(_p, _hit, null, skip);
        impact.point.copy(_at);
        impact.normal.copy(_hit.normal);
        impact.id = _hit.id;
        impact.hit = true;
        return impact;
      }
      last = t;
      // Coarse once it is clear of the structure around him: past thirty metres
      // a round is crossing open deck or open water and a 22 cm step is buying
      // nothing but queries.
      step = t < 30 ? 0.22 : 1.1;
      t += step;
    }
    return impact;
  }

  // --- firing -------------------------------------------------------------------

  function dryFire() {
    if (sounds) sounds.play('bolt', { gain: 0.35, rate: 1.6, vary: 0.04 });
    cooldown = 0.24; // so holding the trigger on an empty rifle is one click, not
    // a rattle
  }

  function shoot(space) {
    rounds--;
    chambered = rounds > 0;
    shots++;
    cooldown = interval;

    // Where from and along what line. The muzzle node is on the weapon, so it is
    // wherever the sway and the kick have left it — but the *shot* comes off the
    // camera axis, not off the drawn barrel. That is deliberate and it is what
    // every first-person weapon does: the barrel is a prop hanging in the corner
    // of the frame, and a round that left it would not go where the sights say.
    camera.getWorldDirection(_dir);
    _from.copy(camera.position);

    // Spread, as a cone about the line of sight. Bloom is added by firing and
    // taken off by not, so the first rounds of a burst are honest and the rest
    // are not.
    const cone = (aim > 0.5 ? RIFLE.spreadAim : RIFLE.spreadHip) + bloom;
    if (cone > 1e-4) {
      // A point in the disc, not on its edge: sqrt on the radius, or every round
      // lands on the rim of the group and none in the middle of it.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * cone * DEG;
      _v.set(Math.cos(a), Math.sin(a), 0).applyQuaternion(camera.quaternion);
      _dir.addScaledVector(_v, Math.tan(r)).normalize();
    }
    bloom = Math.min(bloom + RIFLE.bloom, RIFLE.bloomMax);

    // Into the space the shooter is standing in, which is where the colliders
    // are. On deck that is the hull's frame; inside a gunhouse it is the
    // gunhouse's, and neither this function nor the collision field has to know
    // which.
    space.toLocal(_from, _p);
    _qi.copy(space.worldQuaternion).invert();
    _v.copy(_dir).applyQuaternion(_qi);
    const shot = march(space, _p, _v);

    // The streak, in the hull's frame. It starts at the drawn muzzle rather than
    // at the eye — a tracer that comes out of the middle of the screen is the
    // one thing that gives the whole trick away.
    viewRig.muzzle.getWorldPosition(_w);
    root.worldToLocal(_w);
    if (shot.hit) {
      space.toWorld(shot.point, _at);
      root.worldToLocal(_at);
    } else {
      _at.copy(_from).addScaledVector(_dir, RIFLE.range);
      root.worldToLocal(_at);
    }
    tracers.fire(_w, _at);

    if (shot.hit && onHit) onHit(shot);
    if (shot.hit && fx) {
      // What a round does where it lands: a spark and a little dust off the
      // paint. It does nothing to the ship — see the note at the head of this
      // file — and pretending otherwise would put a rifle on the same footing as
      // an armour-piercing shell.
      space.toWorld(shot.point, _at);
      _v.copy(shot.normal).applyQuaternion(space.worldQuaternion);
      fx.emit(_at, 2, {
        kind: 1, rise: 0.6, spread: 0.14, size: 0.16, life: 0.10, grow: 1.6,
        carry: _v.clone().multiplyScalar(2.2),
      });
      fx.emit(_at, 3, {
        kind: 0, rise: 0.9, spread: 0.22, size: 0.30, life: 0.55, grow: 2.4,
        carry: _v.clone().multiplyScalar(1.1),
      });
    }

    // The flash, the light it throws, and the noise.
    viewRig.flash.fire();
    heldRig.flash.fire();
    flashLight = 0;
    if (sounds) sounds.play('shot', { gain: 0.9, vary: 0.035 });

    // What it does to the weapon, and separately what it does to the aim.
    kick.back += RIFLE.kickBack;
    kick.rise += RIFLE.kickRise;
    kick.pitch += RIFLE.kickPitch * (0.8 + Math.random() * 0.4);
    kick.roll += RIFLE.kickRoll * (Math.random() - 0.5) * 2;
    punch.pitch += RIFLE.climb * DEG;
    punch.yaw += RIFLE.climbYaw * DEG * (Math.random() - 0.5) * 2;
  }

  // The trigger, as a press. Held fire is polled in `update`, which is what makes
  // the difference between the two modes one line.
  function trigger() {
    if (reloading > 0 || cooldown > 0) return false;
    if (rounds <= 0) { dryFire(); return false; }
    shoot(getSpace());
    return true;
  }

  function reload() {
    if (reloading > 0 || rounds === RIFLE.rounds) return false;
    // An empty rifle takes longer, because the bolt is back and has to be let
    // go — which is a different sound and half a second more.
    reloading = RIFLE.reload + (chambered ? 0 : RIFLE.chamber);
    if (sounds) sounds.play('reload', { gain: 0.75 });
    return true;
  }

  function toggleTorch() {
    torchOn = !torchOn;
    return torchOn;
  }

  // --- the view model ------------------------------------------------------------

  // Where the weapon hangs this frame. Rebuilt from nothing every frame out of
  // the pose, the sway, the bob, the kick and whatever is in the way — there is
  // no accumulated transform anywhere, which is what stops it drifting.
  function place(dt, s) {
    const {
      look = { yaw: 0, pitch: 0 }, speed = 0, sprinting = false,
      grounded = true, crouch = 0,
    } = s;

    // Sway. The weapon trails the view: turn quickly and it is left behind, stop
    // and it catches up. Driven by the *rate* the view is turning rather than by
    // how far it has turned, so a slow pan does not drag it off to one side and
    // leave it there.
    //
    // A first-order lag rather than a spring. A spring overshoots, which is what
    // gives a weapon weight — and also what makes it wobble for half a second
    // every time you flick, at which point the sights are unusable. Aiming halves
    // it, for the same reason a man brings a rifle in to his shoulder.
    const rate = dt > 1e-5 ? 1 / dt : 60;
    const cap = 0.055 * (1 - aim * 0.65);
    const clampSway = (v) => Math.min(Math.max(v, -cap), cap);
    const wantX = clampSway(-look.yaw * rate * RIFLE.swayAmount);
    const wantY = clampSway(-look.pitch * rate * RIFLE.swayAmount);
    const catchUp = Math.min(dt * RIFLE.swayDamp, 1);
    sway.x += (wantX - sway.x) * catchUp;
    sway.y += (wantY - sway.y) * catchUp;

    // The bob, off the same distance-driven phase the camera uses, and a little
    // behind it: the weapon is being carried by the man the camera is inside.
    const walking = grounded ? speed : 0;
    bobPhase += (walking / Math.max(PLAYER.walk, 0.01)) * dt * 7.4;
    const wantBob = Math.min(walking / PLAYER.walk, 1.3) * (1 - aim * 0.75);
    bobAmount += (wantBob - bobAmount) * Math.min(dt * 8, 1);

    // The kick, coming home.
    const home = Math.min(dt * RIFLE.kickRecover, 1);
    kick.back -= kick.back * home;
    kick.rise -= kick.rise * home;
    kick.pitch -= kick.pitch * home;
    kick.roll -= kick.roll * home;

    // Bring the sights up, and put them down again if he starts running or there
    // is a bulkhead in the way — both of which are cases where the weapon is not
    // where his eye is.
    const wantAim = s.aiming && !sprinting && reloading <= 0 && clear > 0.5 ? 1 : 0;
    aim += (wantAim - aim) * Math.min(dt / RIFLE.aimTime, 1);

    const lerp = (a, b) => a + (b - a) * aim;
    const px = lerp(RIFLE.hip.pos[0], RIFLE.aim.pos[0]);
    const py = lerp(RIFLE.hip.pos[1], RIFLE.aim.pos[1]);
    const pz = lerp(RIFLE.hip.pos[2], RIFLE.aim.pos[2]);

    // Running, and pressed against something. Both roll the weapon out of the
    // way rather than moving it, because a barrel that goes *down* still has its
    // muzzle in the bulkhead and one that is turned across the body does not.
    const down = (sprinting ? 1 : 0) * (1 - aim);
    const blocked = 1 - clear;

    view.position.set(
      px + sway.x + Math.sin(bobPhase) * RIFLE.bob * bobAmount * 0.6,
      py + sway.y + Math.sin(bobPhase * 2) * RIFLE.bob * bobAmount
        + kick.rise - down * RIFLE.sprintDrop - blocked * RIFLE.clearDrop
        - crouch * 0.012,
      pz + kick.back,
    );
    view.rotation.set(
      (lerp(RIFLE.hip.rot[0], RIFLE.aim.rot[0]) + kick.pitch
        - sway.y * RIFLE.swayTilt * 6) * DEG,
      (lerp(RIFLE.hip.rot[1], RIFLE.aim.rot[1])
        + sway.x * RIFLE.swayTilt * 6
        + down * RIFLE.sprintTilt * 0.4 + blocked * RIFLE.clearTilt * 0.5) * DEG,
      (lerp(RIFLE.hip.rot[2], RIFLE.aim.rot[2]) + kick.roll
        + Math.sin(bobPhase) * RIFLE.bobRoll * bobAmount
        + down * RIFLE.sprintTilt + blocked * RIFLE.clearTilt) * DEG,
    );
  }

  // Is there a bulkhead where the barrel would be? One query, along the line of
  // sight, in the space the body is in. The same field the feet are standing on,
  // which is the only reason this is three lines rather than a second collision
  // system for the weapon.
  function probeClearance(space, dt) {
    camera.getWorldDirection(_dir);
    _v.copy(camera.position).addScaledVector(_dir, RIFLE.clearance);
    space.toLocal(_v, _p);
    const blocked = space.colliders.query(_p, _hit, null, space.skipShapes ?? null) > 0;
    const want = blocked ? 0 : 1;
    clear += (want - clear) * Math.min(dt * 12, 1);
    return clear;
  }

  // --- the frame ------------------------------------------------------------------

  function update(dt, s) {
    const space = getSpace();
    tracers.update(dt);
    viewRig.flash.update(dt);
    heldRig.flash.update(dt);
    flashLight += dt;

    if (reloading > 0) {
      reloading -= dt;
      if (reloading <= 0) {
        reloading = 0;
        // The bolt going home on an empty rifle. Timed off the end of the reload
        // rather than off its start, so it lands where the sample does.
        if (!chambered && sounds) sounds.play('charge', { gain: 0.5 });
        rounds = RIFLE.rounds;
        chambered = true;
      }
    }
    cooldown = Math.max(cooldown - dt, 0);
    bloom = Math.max(bloom - RIFLE.bloomDecay * dt, 0);

    if (s.held) {
      probeClearance(space, dt);
      // The view model hangs off the camera, so its own transform says nothing
      // about where it is on the ship — and every rig its program reads is in her
      // frame. Without this the torch clamped to the barrel lights everything
      // except the barrel.
      view.updateWorldMatrix(true, true);
      syncFieldXform(view, root);
      // Automatic. The trigger is a state rather than an event for exactly this
      // line: a press fires one round in either mode, and a *hold* keeps firing
      // only if the selector is over.
      if (auto && s.firing && reloading <= 0 && cooldown <= 0) {
        if (rounds > 0) shoot(space); else dryFire();
      }
      // Out of rounds with the trigger still down: reload without being asked.
      // Everybody presses R half a second later anyway, and the half second is
      // the whole of what it buys.
      if (rounds <= 0 && reloading <= 0 && s.firing) reload();
      place(dt, s);
    }

    // --- the lights ---------------------------------------------------------
    //
    // Whichever copy of the rifle is actually being drawn is the one carrying the
    // lamp: in first person that is the view model hanging off the camera, and
    // from outside it is the one in the deck figure's hands. They are the same
    // weapon and there is only ever one of it.
    // Whichever copy is being drawn is the one carrying the lamp. The two flags
    // are exclusive by contract — whoever owns the camera sets them, and there is
    // only ever one rifle — and the view model wins if they both somehow say yes.
    const rig = view.visible ? viewRig : (held.visible ? heldRig : null);
    if (lights) {
      if (rig && torchOn) {
        rig.torch.group.updateWorldMatrix(true, false);
        rig.torch.group.getWorldPosition(_w);
        root.worldToLocal(_w);
        rig.torch.group.getWorldQuaternion(_q);
        _d.set(0, 0, -1).applyQuaternion(_q);
        root.getWorldQuaternion(_qi).invert();
        _d.applyQuaternion(_qi);
        lights.set(TORCH_SLOT, _w, _d);
      } else {
        lights.clear(TORCH_SLOT);
      }

      // And the flash, which is a light for a twentieth of a second and is the
      // reason a rifle fired in a dark passage is worth firing there.
      if (rig && flashLight < MUZZLE.life) {
        const k = 1 - flashLight / MUZZLE.life;
        rig.muzzle.updateWorldMatrix(true, false);
        rig.muzzle.getWorldPosition(_w);
        root.worldToLocal(_w);
        rig.muzzle.getWorldQuaternion(_q);
        _d.set(0, 0, -1).applyQuaternion(_q);
        root.getWorldQuaternion(_qi).invert();
        _d.applyQuaternion(_qi);
        lights.set(MUZZLE_SLOT, _w, _d, {
          reach: MUZZLE.reach,
          inner: MUZZLE.inner,
          outer: MUZZLE.outer,
          color: MUZZLE.color,
          level: MUZZLE.level * k * k,
        });
      } else if (flashLight < MUZZLE.life + 0.2) {
        lights.clear(MUZZLE_SLOT);
      }
    }

    const night = shading ? shading.night.value : 0;
    for (const r of rigs) r.torch.set(torchOn && r.group.visible, night);
  }

  // The aim that the recoil has walked away and has not given back. Read once a
  // frame by whoever owns the look, and cleared by the read — the weapon does not
  // move the camera itself, because the camera is not its to move.
  function consumePunch(out) {
    out.pitch = punch.pitch;
    out.yaw = punch.yaw;
    punch.pitch = 0;
    punch.yaw = 0;
    return out;
  }

  return {
    view,
    held,
    update,
    trigger,
    release() { /* nothing to do: the hold is polled */ },
    reload,
    toggleTorch,
    consumePunch,
    cycleMode() { auto = !auto; return auto ? 'AUTO' : 'SEMI'; },
    show(on) { view.visible = !!on; },
    showHeld(on) { held.visible = !!on; },
    // Everything the read-out wants, and nothing it has to work out for itself.
    get rounds() { return rounds; },
    get capacity() { return RIFLE.rounds; },
    get reloading() { return reloading; },
    get mode() { return auto ? 'AUTO' : 'SEMI'; },
    get aiming() { return aim; },
    get torch() { return torchOn; },
    get spread() {
      return (aim > 0.5 ? RIFLE.spreadAim : RIFLE.spreadHip) + bloom;
    },
    get shots() { return shots; },
    // How hard it is kicking right now, 0..1. Wanted by the figure on the deck,
    // whose shoulder should be doing the same thing the view model is.
    get recoil() { return Math.min(kick.pitch / RIFLE.kickPitch, 1.5); },
    // The view model recovers on its own, but a weapon put away mid-burst should
    // come back level rather than still kicking.
    settle() {
      kick.back = 0; kick.rise = 0; kick.pitch = 0; kick.roll = 0;
      sway.x = 0; sway.y = 0; sway.vx = 0; sway.vy = 0;
      punch.pitch = 0; punch.yaw = 0;
      bloom = 0;
      aim = 0;
    },
  };
}
