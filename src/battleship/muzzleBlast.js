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
  // How long each part lives. The core is gone before you can look at it; the
  // jet is what you actually see; the disc lingers longest and is the faintest.
  coreLife: 0.055,
  jetLife: 0.10,
  discLife: 0.15,
  // The light it throws, in bores of reach and in raw radiance.
  reach: 90, // bores — about 50 m for a 16-inch gun
  level: 5.5,
  color: [1.0, 0.74, 0.40],
  lightLife: 0.13,
  // Recoil: how far the gun comes back, and how long the recuperator takes to
  // run it out again. A real 16-inch gun recoils about a metre and takes the
  // better part of five seconds over it; this is the gun's share of the six
  // seconds the loading cycle already costs.
  recoil: 1.15, // m
  runIn: 0.055, // s to the back stop
  runOut: 2.2, // s to return
};

// The bore, from the barrel profile in mounts.js: the muzzle's outer radius is
// 1.36 of the nominal, and the hole in the end of it is 0.6 of that.
export const boreOf = (barrelR) => barrelR * 1.36 * 0.6 * 2;

const _v = new Vector3();
const _dir = new Vector3();

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
  const core = tint(new SphereGeometry(1, 10, 8), (c) => c.setRGB(2.6, 2.25, 1.7));

  // The jet: a cone lying along +z with its apex *at* the muzzle, opening
  // forwards. White where it leaves the bore, deep orange at its mouth, which is
  // the whole read of a muzzle flash — it is a flame that is cooling as it goes.
  const jet = new ConeGeometry(1, 1, 12, 1, true);
  jet.rotateX(-Math.PI / 2); // the lathe's +y down the bore, apex aft of the mouth
  jet.translate(0, 0, 0.5); // apex on the muzzle, mouth a bore-length ahead of it
  tint(jet, (c, x, y, z) => {
    const f = Math.min(Math.max(z, 0), 1);
    c.setRGB(2.4 - f * 1.5, 1.7 - f * 1.35, 1.0 - f * 0.94);
  });

  // The blast disc: the shock coming off the muzzle sideways, drawn as a
  // flattened ball so it is a lens from any angle rather than a card that
  // vanishes edge-on.
  const disc = tint(new SphereGeometry(1, 12, 8), (c, x, y, z) => {
    const r = Math.hypot(x, y);
    c.setRGB(1.5 - r * 0.5, 0.85 - r * 0.35, 0.32 - r * 0.16);
  });
  disc.scale(1, 1, 0.001 + FLASH.discDepth / FLASH.discRadius);
  return { core, jet, disc };
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
    for (const g of [geo.core, geo.jet, geo.disc]) {
      const mesh = new Mesh(g, flameMaterial());
      mesh.frustumCulled = false;
      mesh.renderOrder = 24;
      group.add(mesh);
      parts.push(mesh);
    }
    return { group, core: parts[0], jet: parts[1], disc: parts[2] };
  }

  // Fire one gun. `gun` is a mounts.js gun — { barrel, length } — and `barrelR`
  // its profile radius, from which the bore and therefore the whole blast is
  // scaled. Returns the muzzle position in world space, because the caller
  // almost always wants it for the shell.
  function fire(gun, { barrelR = 0.34, recoil = true } = {}) {
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

    live.push({ rig, t: 0, bore });
    lightFor(gun, bore);

    if (smoke) {
      // The gas, still burning as it leaves. A handful of flame that dies in a
      // third of a second...
      smoke.emit(muzzle, Math.round(3 + bore * 6), {
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
      smoke.emit(muzzle, Math.round(4 + bore * 16), {
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
      const r = recoiling.find((x) => x.gun === gun);
      if (r) { r.t = 0; } else {
        recoiling.push({ gun, t: 0, rest: gun.barrel.position.z, throw: FLASH.recoil * Math.min(bore * 2.2, 1) });
      }
    }
    return muzzle;
  }

  // The light, in her frame. Held as a point that does not move for the tenth of
  // a second it burns — the mount trains at ten degrees a second, which over that
  // time is a hand's breadth at the muzzle and nothing at all where the light
  // lands.
  function lightFor(gun, bore) {
    if (!root) return;
    gun.barrel.updateWorldMatrix(true, false);
    const p = gun.barrel.localToWorld(_v.set(0, 0, gun.length + bore * 3)).clone();
    root.worldToLocal(p);
    lights.push({ p, t: 0, bore });
  }

  function update(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const f = live[i];
      f.t += dt;
      const b = f.bore;
      // Each part on its own clock, because they are three different things: the
      // core is the gas still inside the muzzle, the jet is it burning in the
      // open, the disc is the shock that left before either.
      const core = 1 - f.t / FLASH.coreLife;
      const jet = 1 - f.t / FLASH.jetLife;
      const disc = 1 - f.t / FLASH.discLife;
      f.rig.core.visible = core > 0;
      f.rig.jet.visible = jet > 0;
      f.rig.disc.visible = disc > 0;
      if (core > 0) {
        f.rig.core.scale.setScalar(b * FLASH.core * (0.55 + (1 - core) * 0.9));
        f.rig.core.material.opacity = core * core;
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
        f.rig.jet.material.opacity = Math.min(1, jet * 1.6) ** 1.4;
      }
      if (disc > 0) {
        const grow = 1 - disc;
        f.rig.disc.scale.setScalar(b * FLASH.discRadius * (0.25 + grow * 1.5));
        f.rig.disc.material.opacity = disc * disc * 0.55;
      }
      if (disc <= 0) {
        f.rig.group.parent?.remove(f.rig.group);
        f.rig.group.visible = false;
        rigs.push(f.rig);
        live.splice(i, 1);
        if (rigs.length > max) rigs.length = max;
      }
    }

    for (let i = lights.length - 1; i >= 0; i--) {
      lights[i].t += dt;
      if (lights[i].t > FLASH.lightLife) lights.splice(i, 1);
    }

    // The gun coming back and running out. Fast in, slow out, and it is the one
    // moving part of the whole event: everything else is gas.
    for (let i = recoiling.length - 1; i >= 0; i--) {
      const r = recoiling[i];
      r.t += dt;
      let back;
      if (r.t < FLASH.runIn) {
        back = r.throw * (r.t / FLASH.runIn);
      } else {
        const k = Math.min((r.t - FLASH.runIn) / FLASH.runOut, 1);
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
      const k = Math.max(0, 1 - l.t / FLASH.lightLife);
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
