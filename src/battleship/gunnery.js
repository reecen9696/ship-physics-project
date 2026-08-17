import {
  Group, Mesh, Sprite, SpriteNodeMaterial, MeshBasicNodeMaterial, LatheGeometry,
  Raycaster, Vector2, Vector3, Quaternion, Color, AdditiveBlending,
} from 'three/webgpu';
import {
  Fn, vec3, vec4, float, uv, dot, saturate, normalize, normalWorld, attribute, pow,
} from 'three/tsl';
import {
  SHELL, flightStep, aimAt, elevationThrough, rangeFor, elevationFor, maxRange,
} from './ballistics.js';

// Shells in the air.
//
// A projectile here is a body with a trajectory — see ballistics.js, which owns
// the trajectory and is shared with the sight so the two cannot disagree — drawn
// as the shell it actually is: a 406 mm armour-piercing round, 1.78 m over the
// windscreen, nose along its own velocity the whole way, turning on its own axis.
//
// What matters as much as the look is the hit test. The ship is a few hundred
// separate meshes and the shell moves twenty metres per frame, so testing the
// shell's *position* against anything would tunnel straight through her at any
// sensible muzzle velocity. Each step therefore raycasts along the segment the
// shell actually swept, which is exact at any speed and gives back the mesh and
// the point — the two things the damage model needs to place a hit.
//
// The sea is a flat plane test against the buoyancy solver's fitted water
// height, not the FFT surface. A shell that lands 30 m from the hull only has to
// throw a splash roughly where the water is; matching the wave it hit is not
// worth a GPU readback.

// Everything about the round itself now lives in ballistics.js. Re-exported
// because half the project asks the gunnery for it and there is no reason to
// make every one of those callers know where it came from.
export { SHELL, aimAt, elevationThrough, rangeFor, elevationFor, maxRange };

const FORWARD = new Vector3(0, 0, 1);

const isVisible = (o) => {
  for (let n = o; n; n = n.parent) if (!n.visible) return false;
  return true;
};

const isUnder = (o, root) => {
  for (let n = o; n; n = n.parent) if (n === root) return true;
  return false;
};

// --- what a shell looks like --------------------------------------------------
//
// Lathed from its own profile, which is most of what makes it read as a shell
// rather than as a bullet: a slightly waisted base (the boat tail, which is
// worth two per cent of range), two copper driving bands where the rifling bit
// into it, a long parallel body, and a tangent ogive over the last forty-five
// per cent to a blunt point. The ogive is generated rather than eyeballed —
// rho = (R^2 + L^2) / 2R is the radius of the arc that meets the body tangentially,
// which is what "tangent ogive" means and what stops the join showing as a crease.
function shellGeometry() {
  const R = SHELL.caliber / 2;
  const L = SHELL.length;
  const noseL = L * 0.45;
  const rho = (R * R + noseL * noseL) / (2 * R);

  const pts = [new Vector2(0, 0)]; // on the axis: the base, which caps it
  pts.push(new Vector2(R * 0.80, 0)); // boat tail
  pts.push(new Vector2(R * 0.99, L * 0.085));
  pts.push(new Vector2(R, L * 0.115));
  pts.push(new Vector2(R * 1.055, L * 0.135)); // driving bands, standing proud
  pts.push(new Vector2(R * 1.055, L * 0.175));
  pts.push(new Vector2(R, L * 0.20));
  pts.push(new Vector2(R * 1.055, L * 0.225));
  pts.push(new Vector2(R * 1.055, L * 0.265));
  pts.push(new Vector2(R, L * 0.29));
  pts.push(new Vector2(R, L - noseL)); // the parallel body
  for (let i = 8; i >= 1; i--) {
    // sampled from the tip back, so the points crowd where the curve is tightest
    const x = (noseL * i) / 8;
    pts.push(new Vector2(Math.sqrt(rho * rho - (noseL - x) ** 2) + R - rho, L - noseL + x));
  }
  pts.push(new Vector2(R * 0.05, L)); // a blunt point: a windscreen is not a needle
  const g = new LatheGeometry(pts, 14);
  g.rotateX(Math.PI / 2); // the lathe's +y is the shell's +z

  // Two colours, by where each vertex sits along the shell: gunmetal, and the
  // copper of the bands. One attribute, one draw call, no second material.
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const steel = new Color(0.055, 0.058, 0.065);
  const copper = new Color(0.52, 0.27, 0.11);
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const band = z > L * 0.125 && z < L * 0.30 && Math.hypot(pos.getX(i), pos.getY(i)) > R * 1.01;
    const c = band ? copper : steel;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new (pos.constructor)(col, 3));
  return g;
}

// Nothing in this project uses three's lighting model — see scene/shading.js —
// so the shell is shaded by hand off the same sun the ship and the sea are lit
// by. Two terms: the sun, and the sky it is sitting under. A shell drawn flat is
// a black splinter against a bright sea and reads as a hole in the frame.
function shellMaterial(shading) {
  const m = new MeshBasicNodeMaterial();
  if (!shading) return m;
  m.colorNode = Fn(() => {
    const n = normalize(normalWorld);
    const lam = saturate(dot(n, shading.sunDir)).mul(0.85).add(0.15);
    const sky = saturate(n.y.mul(0.5).add(0.5)).mul(0.35);
    const base = attribute('color', 'vec3');
    // Steel is a mirror before it is a colour: a hard, tight highlight where the
    // sun grazes the shoulder is what says "turned metal" at any distance.
    const spec = pow(saturate(dot(n, shading.sunDir)), float(28)).mul(0.6);
    return vec4(
      base.mul(shading.sunColor.mul(lam).add(shading.horizon.mul(sky)))
        .add(shading.sunColor.mul(spec)),
      1,
    );
  })();
  return m;
}

// The trace.
//
// A 406 mm shell is 40 cm across and four kilometres away: a fortieth of a pixel.
// Drawn honestly it is invisible, and a gunnery you cannot watch is a gunnery you
// cannot correct — spotting the fall of shot is the whole of the exercise. So
// each round carries a soft additive mote that holds a minimum *angular* size, in
// the way a tracer or the sun on a wet shell holds one. Near the muzzle it is
// smaller than the shell and never seen; at range it is what you follow.
function glowMaterial() {
  const m = new SpriteNodeMaterial();
  m.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const r2 = dot(p, p);
    const a = pow(saturate(float(1).sub(r2)), float(2.2));
    return vec4(vec3(1.0, 0.86, 0.62), a.mul(0.5));
  })();
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.toneMapped = false;
  return m;
}

export function createGunnery({ shading = null, smoke = null, max = 64 } = {}) {
  const group = new Group();
  group.name = 'gunnery.shells';
  group.frustumCulled = false;

  const geometry = shellGeometry();
  const material = shellMaterial(shading);
  const glowMat = glowMaterial();

  const live = [];
  const pool = [];
  const ray = new Raycaster();
  const _step = new Vector3();
  const _prev = new Vector3();
  const _dir = new Vector3();
  const _q = new Quaternion();
  const _emit = new Vector3();
  const _carry = new Vector3();
  const NO_WIND = new Vector3();

  // `owner` is the ship that fired, and `clearOf(worldPos)` says whether the
  // shell is still inside her. Between them they are the arming distance: a gun
  // firing over its own forecastle puts the shell through 45 m of its own ship
  // before it is anywhere, and without this every shot from A turret detonates on
  // the bow. Once the shell has left her, she becomes a target again — a round
  // that comes back down on your own deck should absolutely land on it.
  //
  // `inherit` is the velocity of whatever fired it. A shell leaves a ship making
  // fifteen knots with those fifteen knots already in it, which at right angles
  // to the line of fire is a couple of metres of deflection at four thousand — a
  // small thing that is free to have and wrong to leave out.
  function fire(origin, direction, {
    owner = null, clearOf = null, inherit = null, speed = SHELL.muzzle,
  } = {}) {
    if (live.length >= max) retire(0);
    let s = pool.pop();
    if (!s) {
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      const glow = new Sprite(glowMat);
      glow.frustumCulled = false;
      glow.renderOrder = 22;
      s = { mesh, glow, vel: new Vector3(), spin: 0 };
    }
    s.mesh.position.copy(origin);
    s.mesh.visible = true;
    s.glow.visible = true;
    s.vel.copy(direction).normalize().multiplyScalar(speed);
    if (inherit) s.vel.add(inherit);
    s.age = 0;
    s.spin = 0;
    s.trail = 0;
    s.owner = owner;
    s.clearOf = clearOf;
    s.armed = !owner;
    group.add(s.mesh);
    group.add(s.glow);
    live.push(s);
    return s;
  }

  function retire(i) {
    const s = live[i];
    group.remove(s.mesh);
    group.remove(s.glow);
    s.mesh.visible = false;
    s.glow.visible = false;
    pool.push(s);
    live.splice(i, 1);
  }

  // A thin trace of vapour, at a fixed interval *of distance* rather than of
  // time, so it does not bunch up as the shell slows near the top of its arc.
  function trail(s) {
    if (!smoke) return;
    smoke.emit(_emit.copy(s.mesh.position), 1, {
      kind: 0,
      rise: 0,
      spread: 0.6,
      size: 0.55,
      life: 1.5,
      grow: 1.6,
      carry: _carry.copy(s.vel).multiplyScalar(0.012),
    });
  }

  // `target` is what to test against — one object, or several, since there is
  // usually more than one hull in the water. `seaHeight` is where the water is.
  // `onHit` gets the intersection plus the shell that made it; `onMiss` fires
  // when one goes into the sea instead. `wind` is the air the shells are flying
  // through, and `camera` is only for how big to draw the trace.
  function update(dt, {
    target, seaHeight = 0, onHit = null, onMiss = null, wind = null, camera = null,
  }) {
    const targets = target && Array.isArray(target) ? target : (target ? [target] : null);
    const air = wind || NO_WIND;
    for (let i = live.length - 1; i >= 0; i--) {
      const s = live[i];
      s.age += dt;
      _prev.copy(s.mesh.position);

      // The trajectory is integrated in substeps of a fixed size, not in frames.
      // A shell's flight must not depend on the frame rate — the firing table
      // says where it will land and it has to land there on a slow machine too.
      let left = dt;
      while (left > 1e-5) {
        const h = Math.min(left, 1 / 90);
        flightStep(s.mesh.position, s.vel, h, air);
        left -= h;
      }

      if (!s.armed && (!s.clearOf || !s.clearOf(s.mesh.position))) s.armed = true;

      _step.subVectors(s.mesh.position, _prev);
      const dist = _step.length();

      if (targets && dist > 1e-4) {
        ray.set(_prev, _dir.copy(_step).divideScalar(dist));
        ray.far = dist;
        // A wrecked stretch of guardrail is hidden rather than removed, and the
        // raycaster does not check visibility — so a shell would detonate on a
        // rail that is not there any more.
        const hit = ray.intersectObjects(targets, true).find((h) => isVisible(h.object)
          && (s.armed || !isUnder(h.object, s.owner)));
        if (hit) {
          if (onHit) onHit({ ...hit, shell: s, speed: s.vel.length() });
          retire(i);
          continue;
        }
      }

      // Nose along the trajectory. A shell is spin-stabilised and its nose
      // follows the tangent of its path the whole way down, which is why a
      // plunging shell arrives point-first at forty degrees rather than
      // tumbling — and it is the single thing that makes one read as a shell.
      if (dist > 1e-6) {
        _q.setFromUnitVectors(FORWARD, _dir.copy(_step).divideScalar(dist));
        s.mesh.quaternion.copy(_q);
        s.spin = (s.spin + dt * 90) % (Math.PI * 2); // ~14 rev/s, near enough to see
        s.mesh.rotateZ(s.spin);
      }

      // A trace of vapour every so many metres of flight, for the first stretch
      // of the run where it is worth anything. Beyond that it is a smear across
      // half the sky and thousands of particles.
      s.trail += dist;
      if (smoke && s.age < 5 && s.trail > 55) { s.trail = 0; trail(s); }

      // The mote that stands in for a shell too far away to have a size — see
      // `glowMaterial`. Held at about a milliradian, so it is the same speck at
      // any range and is swallowed by the shell itself up close.
      s.glow.position.copy(s.mesh.position);
      const d = camera ? camera.position.distanceTo(s.mesh.position) : 400;
      s.glow.scale.setScalar(Math.max(SHELL.length * 0.5, d * 0.0016));

      // into the sea, or so far out it is never coming back. The cap is a long
      // one now: a shell fired at the elevation stop is in the air for the best
      // part of a minute, and cutting it off at twenty seconds used to delete it
      // at the top of its arc.
      if (s.mesh.position.y < seaHeight || s.age > 120) {
        if (onMiss && s.mesh.position.y < seaHeight) {
          onMiss({ point: s.mesh.position.clone(), shell: s, speed: s.vel.length() });
        }
        retire(i);
      }
    }
  }

  return {
    group,
    fire,
    update,
    clear() { for (let i = live.length - 1; i >= 0; i--) retire(i); },
    get count() { return live.length; },
  };
}
