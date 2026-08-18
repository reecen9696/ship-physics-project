import {
  Group, Mesh, MeshBasicNodeMaterial, SphereGeometry, ConeGeometry,
  AdditiveBlending, Vector3, Color,
} from 'three/webgpu';

// What a gun does when it goes off.
//
// Firing a naval rifle is not a puff at the end of a tube. Thirty-odd tonnes of
// gun throws a tonne of shell out of a bore at four hundred metres a second, and
// behind the shell comes several hundred kilogrammes of propellant gas at
// several thousand degrees, still expanding, still burning as it meets the air.
// What you see is that gas: a white core at the muzzle you cannot look at, a
// blossom of flame reaching out along the bore further than the gun is long, a
// blast disc thrown sideways off the muzzle as the shock leaves it, and then
// half a second later a slow brown-grey cloud that hangs and drifts off downwind
// while the gun runs out again.
//
// All four of those things are here, plus the two that are not light: the recoil,
// which is the only part of the gun that actually moves, and the light the flash
// throws on everything around it. A 16-inch flash at night lights the whole
// forecastle — the deck, the barbette, the barrels themselves, the men standing
// on her — and a flash that does not do that reads as a decal stuck on the end
// of the barrel however good its shape is. See `lights` below and the flash rig
// in shipMaterial.js for how that gets back onto her paint.
//
// It is written against a *gun*, not against a turret: anything in mounts.js with
// a barrel and a length can be fired, and the whole blast scales off the bore. A
// 25 mm AA gun through the same code gets a flash a fifth of a metre across and a
// wisp, which is what it should get.

const FLASH = {
  // Everything below is in bores: a muzzle flash is the same shape at any
  // calibre and the only thing that changes is how big the bore was.
  core: 3.4, // radius of the white centre
  jetLength: 22, // how far the flame reaches along the bore
  jetRadius: 5.0, // and how wide it is at its mouth
  discRadius: 9.0, // the blast disc thrown off sideways
  discDepth: 1.6,

  // The fireball: the propellant gas burning in the open air once it is clear of
  // the bore, which is the largest and longest-lived part of a big gun's flash
  // and the part that was missing. Without it the flash is a cone, and a cone
  // pointing forwards reads as a rocket nozzle rather than as several kilograms
  // of powder going off. It leaves as a ball, expands hard against the air,
  // slows, and cools as it goes.
  ballRadius: 8.5, // bores, fully expanded
  ballDrift: 3.2, // bores it moves ahead of the muzzle while it burns
  ballLife: 0.30,

  // How the whole thing cools. Every luminous part is multiplied down this ramp
  // over its own life, which is the difference between a flash that fades and a
  // flash that *burns out*: white-hot gas going yellow, then orange, then the
  // dull red of the last of it. Fading alone keeps the same colour all the way
  // to nothing, and reads as a light being switched off.
  hot: [1.0, 0.98, 0.95],
  cool: [1.0, 0.34, 0.10],
  // How long each part lives. The core is gone before you can look at it; the
  // jet is what you actually see; the disc lingers longest and is the faintest.
  // Half again as long as they were. A muzzle flash is genuinely over in about a
  // twentieth of a second, and at that duration it is one frame of white that
  // you register as having happened rather than as having watched. These are the
  // durations at which the eye gets to see the shape of the thing — still short
  // enough that a salvo reads as a bang, not as a flare being lit.
  coreLife: 0.085,
  jetLife: 0.16,
  discLife: 0.23,
  // The light it throws, in bores of reach and in raw radiance.
  reach: 90, // bores — about 50 m for a 16-inch gun
  level: 9.0,
  color: [1.0, 0.76, 0.44],
  lightLife: 0.19,
  // Recoil: how far the gun comes back, and how long the recuperator takes to
  // run it out again. A real 16-inch gun recoils about a metre and takes the
  // better part of five seconds over it; this is the gun's share of the six
  // seconds the loading cycle already costs.
  // Longer than the real thing, deliberately. A 16-inch gun recoils about a
  // metre and a bit, and at that figure — on a barrel sixteen metres long, seen
  // either from a hundred metres off the beam or from a sighting hood two metres
  // behind it — the most violent moving part on the ship still reads as a twitch.
  // At three metres — near a fifth of the barrel — it reads as what it is: a gun
  // the length of a house being thrown backwards hard enough to shove a
  // battleship. Well past the real figure, and the reason to go past it is that
  // the real figure is measured against a gun you are standing next to; ours is
  // usually a hundred metres away or foreshortened down the sight axis, and at
  // that distance honesty and legibility are different numbers.
  //
  // What bounds it is the room, not the gun. The breeches travel aft past the
  // layer's station — they clear him by the better part of a metre across the
  // room, so they pass beside him rather than through him — and there is still
  // four metres between them and the rear bulkhead. Standing inside the gunhouse
  // when it goes is the one place you see the whole of the travel side-on.
  recoil: 3.0, // m
  // Time to the back stop. A real gun does this in about a twentieth of a
  // second, and at that figure it was three frames — which the eye does not read
  // as a gun recoiling, it reads as a barrel that was suddenly somewhere else.
  // An eighth of a second is eight frames of the thing actually travelling, so
  // you see it go, and it is still far and away the most violent movement on the
  // ship. The honest number is the one you cannot see; this is the one that
  // shows what the honest number means.
  runIn: 0.16, // s to the back stop
  runOut: 2.6, // s to return
};

// The bore, from the barrel profile in mounts.js: the muzzle's outer radius is
// 1.36 of the nominal, and the hole in the end of it is 0.6 of that.
export const boreOf = (barrelR) => barrelR * 1.36 * 0.6 * 2;

const _v = new Vector3();
const _dir = new Vector3();
const _cool = new Color();

// Take a flame material down the cooling ramp. `k` is how far through its life
// the part is, 0..1. Every luminous piece of the flash runs through this, which
// is why the whole event goes white -> yellow -> orange -> dull red together
// rather than each part fading in whatever colour it was baked.
function cool(material, k) {
  const t = Math.min(Math.max(k, 0), 1) ** 0.75;
  const [hr, hg, hb] = FLASH.hot;
  const [cr, cg, cb] = FLASH.cool;
  material.color.copy(_cool.setRGB(
    hr + (cr - hr) * t,
    hg + (cg - hg) * t,
    hb + (cb - hb) * t,
  ));
}

// One additive, unlit, hand-coloured material. Every part of every flash uses
// this graph, so the whole system is one program; what differs between them is
// geometry, vertex colour, scale and opacity, all of which are free.
function flameMaterial() {
  const m = new MeshBasicNodeMaterial();
  m.vertexColors = true;
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.toneMapped = false; // a muzzle flash is brighter than the frame, by definition
  m.color = new Color(1, 1, 1);
  return m;
}

// Colour a geometry by hand, so the shape carries its own gradient: white where
// the gas is still unburnt and hottest, orange where it has met the air.
function tint(geometry, at) {
  const pos = geometry.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    at(c, pos.getX(i), pos.getY(i), pos.getZ(i));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new (pos.constructor)(col, 3));
  return geometry;
}

function buildGeometries() {
  // The core: a small ball of white at the muzzle itself.
  const core = tint(new SphereGeometry(1, 10, 8), (c) => c.setRGB(4.4, 3.9, 3.0));

  // The jet: a cone lying along +z with its apex *at* the muzzle, opening
  // forwards. White where it leaves the bore, deep orange at its mouth, which is
  // the whole read of a muzzle flash — it is a flame that is cooling as it goes.
  const jet = new ConeGeometry(1, 1, 12, 1, true);
  jet.rotateX(-Math.PI / 2); // the lathe's +y down the bore, apex aft of the mouth
  jet.translate(0, 0, 0.5); // apex on the muzzle, mouth a bore-length ahead of it
  tint(jet, (c, x, y, z) => {
    const f = Math.min(Math.max(z, 0), 1);
    c.setRGB(4.0 - f * 2.5, 2.9 - f * 2.3, 1.7 - f * 1.6);
  });

  // The blast disc: the shock coming off the muzzle sideways, drawn as a
  // flattened ball so it is a lens from any angle rather than a card that
  // vanishes edge-on.
  const disc = tint(new SphereGeometry(1, 12, 8), (c, x, y, z) => {
    const r = Math.hypot(x, y);
    c.setRGB(2.5 - r * 0.85, 1.45 - r * 0.6, 0.56 - r * 0.28);
  });
  disc.scale(1, 1, 0.001 + FLASH.discDepth / FLASH.discRadius);

  // The fireball. Lumpy on purpose: a sphere is a balloon, and burning gas is
  // not. The radius is pushed about by a cheap three-axis warp, which at the
  // size and duration this is seen at is the whole difference between a ball of
  // fire and a ball. Brightest at its heart, falling away to the edge so it has
  // depth rather than reading as a flat disc.
  const ball = new SphereGeometry(1, 14, 10);
  {
    const pos = ball.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
      const k = 1
        + 0.22 * Math.sin(x * 4.1 + 1.3)
        + 0.18 * Math.sin(y * 5.3 + 2.7)
        + 0.20 * Math.sin(z * 3.7 + 0.6);
      pos.setXYZ(i, x * k, y * k, z * k);
    }
    ball.computeVertexNormals();
  }
  tint(ball, (c, x, y, z) => {
    const r = Math.min(Math.hypot(x, y, z), 1.4) / 1.4;
    c.setRGB(3.0 - r * 1.7, 1.75 - r * 1.25, 0.70 - r * 0.55);
  });
  return { core, jet, disc, ball };
}

// `smoke` is the ship's fire-and-smoke system (fx.js), which lives in world
// space; `root` is the hull, because the light this throws is written in her own
// frame — see the flash rig in shipMaterial.js.
export function createMuzzleBlast({ smoke = null, root = null, max = 8 } = {}) {
  const geo = buildGeometries();
  const rigs = [];
  const live = [];
  const recoiling = [];
  // What the ship's paint is asked to answer to. Rebuilt every frame, in her own
  // frame, brightest first — the rig holds four and a full broadside is eight
  // guns, and the two in one gunhouse are a metre and a half apart.
  const lights = [];

  function makeRig() {
    const group = new Group();
    group.frustumCulled = false;
    const parts = [];
    for (const g of [geo.core, geo.jet, geo.disc, geo.ball]) {
      const mesh = new Mesh(g, flameMaterial());
      mesh.frustumCulled = false;
      mesh.renderOrder = 24;
      group.add(mesh);
      parts.push(mesh);
    }
    return {
      group, core: parts[0], jet: parts[1], disc: parts[2], ball: parts[3],
    };
  }

  // Fire one gun. `gun` is a mounts.js gun — { barrel, length } — and `barrelR`
  // its profile radius, from which the bore and therefore the whole blast is
  // scaled. Returns the muzzle position in world space, because the caller
  // almost always wants it for the shell.
  // `recoil` is false for no travel at all, true for the full stroke, or a
  // fraction of it. The fraction is what an automatic wants: a quadruple 40 mm
  // has a recuperator stroke of a couple of hundred millimetres and it is
  // running again a tenth of a second later, so a gun that came back the same
  // proportion of its length as a 16-inch rifle would be a sewing machine.
  //
  // `life` scales how long the whole flash lasts and `smokeScale` how much gas
  // it leaves. Both are 1 for a rifle and both want to be small for an
  // automatic, for the same reason: nine of these a second at a naval rifle's
  // durations is not a gun firing, it is a gun that has caught fire. A 40 mm
  // flash is genuinely over in a fiftieth of a second and its smoke is a wisp;
  // shortened here, the four barrels read as four separate flashes going round
  // rather than as one continuous orange smear at the end of the mounting.
  //
  // `discScale` and `ballScale` trim the two *soft* parts of the event — the
  // shock coming off the muzzle sideways and the fireball behind it — without
  // touching the core or the jet. They exist because those two are sized for a
  // sixteen-inch gun seen from a hundred metres off the beam, and the same
  // proportions on a mounting the player is standing eight metres from read as a
  // red veil hung over the sea rather than as a gun going off. The flame stays;
  // the haze round it comes down.
  function fire(gun, {
    barrelR = 0.34, recoil = true, runIn = FLASH.runIn, runOut = FLASH.runOut,
    life = 1, smokeScale = 1, lightLife = 1, discScale = 1, ballScale = 1,
  } = {}) {
    const bore = boreOf(barrelR);
    const rig = rigs.pop() || makeRig();
    // On the barrel, at the muzzle: the flash is part of the gun for the tenth
    // of a second it exists, and a ship making thirty knots moves a metre and a
    // half in that time. Hanging it in the world instead leaves it behind.
    gun.barrel.add(rig.group);
    rig.group.position.set(0, 0, gun.length);
    rig.group.rotation.z = Math.random() * Math.PI * 2; // no two flashes alike
    rig.group.visible = true;

    gun.barrel.updateWorldMatrix(true, false);
    const muzzle = gun.barrel.localToWorld(_v.set(0, 0, gun.length)).clone();
    const dir = gun.barrel.getWorldDirection(_dir).clone();

    live.push({ rig, t: 0, bore, life, discScale, ballScale });
    lightFor(gun, bore, lightLife);

    if (smoke && smokeScale > 0) {
      // The gas, still burning as it leaves. A handful of flame that dies in a
      // third of a second...
      smoke.emit(muzzle, Math.max(1, Math.round((3 + bore * 6) * smokeScale)), {
        kind: 1,
        rise: 1.2,
        spread: bore * 3.5,
        size: bore * 2.6,
        life: 0.3,
        grow: bore * 3,
        carry: _v.copy(dir).multiplyScalar(26 * Math.min(bore * 2, 1)),
      });
      // ...and the smoke that is still there when the gun has run out again. A
      // small amount of it, drifting off the muzzle downwind, not a broadside's
      // worth of fog.
      smoke.emit(muzzle, Math.max(1, Math.round((4 + bore * 16) * smokeScale)), {
        kind: 0,
        rise: 0.9,
        spread: bore * 5,
        size: bore * 3.4,
        life: 2.6,
        grow: bore * 2.4,
        carry: _v.copy(dir).multiplyScalar(11 * Math.min(bore * 2, 1)),
      });
    }

    if (recoil) {
      const stroke = FLASH.recoil * Math.min(bore * 2.2, 1) * (recoil === true ? 1 : recoil);
      const r = recoiling.find((x) => x.gun === gun);
      // Restarted rather than stacked: a gun that fires again while it is still
      // running out goes back to the stop from wherever it had got to, which is
      // what the recuperator actually does and what makes an automatic *judder*
      // instead of walking backwards out of its cradle.
      if (r) { r.t = 0; r.throw = stroke; r.runIn = runIn; r.runOut = runOut; } else {
        recoiling.push({
          gun, t: 0, rest: gun.barrel.position.z, throw: stroke, runIn, runOut,
        });
      }
    }
    return muzzle;
  }

  // The light, in her frame. Held as a point that does not move for the tenth of
  // a second it burns — the mount trains at ten degrees a second, which over that
  // time is a hand's breadth at the muzzle and nothing at all where the light
  // lands.
  function lightFor(gun, bore, lightLife = 1) {
    if (!root) return;
    gun.barrel.updateWorldMatrix(true, false);
    const p = gun.barrel.localToWorld(_v.set(0, 0, gun.length + bore * 3)).clone();
    root.worldToLocal(p);
    lights.push({ p, t: 0, bore, life: FLASH.lightLife * lightLife });
  }

  function update(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const f = live[i];
      f.t += dt;
      const b = f.bore;
      // Each part on its own clock, because they are three different things: the
      // core is the gas still inside the muzzle, the jet is it burning in the
      // open, the disc is the shock that left before either.
      const L = f.life;
      const core = 1 - f.t / (FLASH.coreLife * L);
      const jet = 1 - f.t / (FLASH.jetLife * L);
      const disc = 1 - f.t / (FLASH.discLife * L);
      const ball = 1 - f.t / (FLASH.ballLife * L);
      f.rig.core.visible = core > 0;
      f.rig.jet.visible = jet > 0;
      f.rig.disc.visible = disc > 0;
      f.rig.ball.visible = ball > 0;
      if (core > 0) {
        f.rig.core.scale.setScalar(b * FLASH.core * (0.55 + (1 - core) * 0.9));
        // Not squared. A square spends most of its life near zero, so almost
        // all of the extra duration above would have been given to a flash too
        // faint to see; these hold up and then go.
        f.rig.core.material.opacity = core ** 1.3;
        cool(f.rig.core.material, (1 - core) * 0.5);
      }
      if (jet > 0) {
        // It reaches its length almost at once and then burns down in place,
        // rather than growing steadily — which is the difference between a flash
        // and a jet of gas from a nozzle.
        const grow = Math.min(1, (1 - jet) * 4.5);
        f.rig.jet.scale.set(
          b * FLASH.jetRadius * (0.45 + grow * 0.75),
          b * FLASH.jetRadius * (0.45 + grow * 0.75),
          b * FLASH.jetLength * (0.30 + grow * 0.85),
        );
        f.rig.jet.material.opacity = Math.min(1, jet * 1.9) ** 1.15;
        cool(f.rig.jet.material, 1 - jet);
      }
      if (ball > 0) {
        // Expansion against the air: very fast at first and then hardly at all,
        // because what is driving it is a pressure that has already gone. A
        // linear growth reads as something being inflated. `sqrt` is the cheap
        // shape of a blast that is losing its push.
        const u = 1 - ball;
        const grow = Math.sqrt(u);
        f.rig.ball.scale.setScalar(b * FLASH.ballRadius * f.ballScale * (0.18 + grow * 0.92));
        // and it walks off the muzzle as it burns, which is what stops it
        // looking pinned to the end of the gun
        f.rig.ball.position.z = b * FLASH.ballDrift * grow;
        // Holds up, then goes: the last third of a fireball is the part you
        // actually watch, so it must not have faded out before it gets there.
        f.rig.ball.material.opacity = Math.min(1, ball * 1.5) ** 1.6 * 0.9;
        cool(f.rig.ball.material, u);
      }
      if (disc > 0) {
        const grow = 1 - disc;
        // The shock, so it decelerates hardest of all — most of its travel is
        // over in the first fifth of its life.
        f.rig.disc.scale.setScalar(b * FLASH.discRadius * f.discScale * (0.25 + Math.sqrt(grow) * 1.7));
        f.rig.disc.material.opacity = disc ** 1.5 * 0.8;
        cool(f.rig.disc.material, grow);
      }
      if (ball <= 0 && disc <= 0) {
        f.rig.group.parent?.remove(f.rig.group);
        f.rig.group.visible = false;
        f.rig.ball.position.z = 0; // it walked forward; put it back for the next shot
        rigs.push(f.rig);
        live.splice(i, 1);
        if (rigs.length > max) rigs.length = max;
      }
    }

    for (let i = lights.length - 1; i >= 0; i--) {
      lights[i].t += dt;
      if (lights[i].t > lights[i].life) lights.splice(i, 1);
    }

    // The gun coming back and running out. Fast in, slow out, and it is the one
    // moving part of the whole event: everything else is gas.
    for (let i = recoiling.length - 1; i >= 0; i--) {
      const r = recoiling[i];
      r.t += dt;
      let back;
      if (r.t < r.runIn) {
        back = r.throw * (r.t / r.runIn);
      } else {
        const k = Math.min((r.t - r.runIn) / r.runOut, 1);
        // eased, so it settles onto the stop rather than arriving at it
        back = r.throw * (1 - k) * (1 - k);
        if (k >= 1) {
          r.gun.barrel.position.z = r.rest;
          recoiling.splice(i, 1);
          continue;
        }
      }
      r.gun.barrel.position.z = r.rest - back;
    }
  }

  // What the ship's material is given: up to `n` emitters, brightest first, in
  // her own frame. The level falls off as the flash burns down, which is what
  // makes the deck flicker rather than blink.
  function lampList(n = 4) {
    if (!lights.length) return null;
    const out = [];
    for (const l of lights) {
      const k = Math.max(0, 1 - l.t / l.life);
      out.push({
        x: l.p.x,
        y: l.p.y,
        z: l.p.z,
        reach: l.bore * FLASH.reach,
        color: FLASH.color,
        // The eye's response, not the gas's: full brightness for the first
        // instant and then a fast decay, so what you get is a snap of light and
        // not a lamp being turned up.
        level: FLASH.level * k * k * Math.min(1, l.bore * 2.2),
      });
    }
    out.sort((a, b) => b.level - a.level);
    return out.slice(0, n);
  }

  function clear() {
    for (const f of live) {
      f.rig.group.parent?.remove(f.rig.group);
      f.rig.group.visible = false;
      rigs.push(f.rig);
    }
    live.length = 0;
    lights.length = 0;
    for (const r of recoiling) r.gun.barrel.position.z = r.rest;
    recoiling.length = 0;
  }

  return {
    fire, update, lampList, clear, FLASH, get count() { return live.length; },
  };
}
