import {
  Group, Mesh, Sprite, SpriteNodeMaterial, MeshBasicNodeMaterial, LatheGeometry,
  Raycaster, Vector2, Vector3, Quaternion, Color, AdditiveBlending, Box3, Matrix4,
} from 'three/webgpu';
import {
  Fn, vec3, vec4, float, uv, dot, saturate, normalize, normalWorld, attribute, pow,
} from 'three/tsl';
import {
  SHELL, AA_ROUND, flightStep, aimAt, elevationThrough, rangeFor, elevationFor, maxRange,
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
export { SHELL, AA_ROUND, aimAt, elevationThrough, rangeFor, elevationFor, maxRange };

const FORWARD = new Vector3(0, 0, 1);
const AXES = ['x', 'y', 'z'];

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

// --- and what the stern mounting's round looks like ---------------------------
//
// Thirty centimetres of 40 mm high explosive, which at the ranges it is fired
// over is a fifth of a pixel: honestly drawn it is invisible, exactly as the
// 16-inch shell is, and the answer is the same one — the trace carries it. So
// the body is four lines of lathe rather than a profile with driving bands on
// it, because nobody has ever seen one and nobody will.
//
// What is worth having is the *base*. A tracer burns out of the back of the
// round the whole way to the fuze, so the base is drawn as a hot disc and the
// glow behind it is the round's real signature. Coloured by hand rather than
// shaded: a lamp is not lit by the sun.
function tracerGeometry(proj) {
  const R = proj.caliber / 2;
  const L = proj.length;
  const g = new LatheGeometry([
    new Vector2(0, 0),
    new Vector2(R, L * 0.06), // the base, square, with the tracer in it
    new Vector2(R, L * 0.62), // parallel body
    new Vector2(R * 0.72, L * 0.86), // and a stubby ogive; it is not a rifle round
    new Vector2(R * 0.10, L),
  ], 8);
  g.rotateX(Math.PI / 2);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const body = new Color(0.10, 0.10, 0.11);
  const lit = new Color(3.0, 1.6, 0.5); // the tracer composition, burning
  for (let i = 0; i < pos.count; i++) {
    const c = pos.getZ(i) < L * 0.09 ? lit : body;
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

// A tracer is not lit, it is *alight*. Same vertex colours, no sun in the graph,
// no tone mapping — a burning composition is brighter than the frame in daylight
// and it is the only thing you can see of the round at night.
function tracerMaterial() {
  const m = new MeshBasicNodeMaterial();
  m.vertexColors = true;
  m.toneMapped = false;
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
function glowMaterial(color = [1.0, 0.86, 0.62], strength = 0.5, falloff = 2.2) {
  const m = new SpriteNodeMaterial();
  m.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const r2 = dot(p, p);
    const a = pow(saturate(float(1).sub(r2)), float(falloff));
    return vec4(vec3(...color), a.mul(strength));
  })();
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.toneMapped = false;
  return m;
}

// `max` is how many projectiles may be in the air at once, and it is a great
// deal larger than it was: a main battery salvo is two rounds every six seconds
// and the stern mounting is nine rounds a second for as long as the trigger is
// held. Nothing here costs anything while the pools are empty.
export function createGunnery({ shading = null, smoke = null, max = 200 } = {}) {
  const group = new Group();
  group.name = 'gunnery.shells';
  group.frustumCulled = false;

  // --- one set of drawing gear per projectile ---------------------------------
  //
  // The ship fires two entirely different things — a tonne of armour-piercing
  // shell and a kilogramme of tracer — and they share the integrator, the hit
  // test and the pool machinery while sharing none of the *look*. So the
  // per-projectile parts (geometry, material, the colour and size of the mote
  // that stands in for it at range, and its own free list) are built once, on
  // the first round of that kind fired, and hung off the projectile itself.
  const kinds = new Map();
  function kindFor(proj) {
    let k = kinds.get(proj);
    if (k) return k;
    const isTracer = !!proj.tracer;
    k = {
      proj,
      tracer: isTracer,
      geometry: isTracer ? tracerGeometry(proj) : shellGeometry(),
      material: isTracer ? tracerMaterial() : shellMaterial(shading),
      // A tracer's mote is smaller, tighter and much brighter than a shell's —
      // it is a burning composition rather than sunlight on wet steel, and what
      // it has to read as is a *point* of light travelling, not a soft blob.
      glowMat: isTracer ? glowMaterial(proj.tracer, 0.95, 1.4) : glowMaterial(),
      angular: isTracer ? 0.0021 : 0.0016,
      // Never smaller than this, so a round passing close by is still a spark
      // and not thirty centimetres of dark metal you cannot see.
      minSize: isTracer ? proj.length * 4 : proj.length * 0.5,
      pool: [],
    };
    kinds.set(proj, k);
    return k;
  }

  // --- the broad phase ----------------------------------------------------------
  //
  // Every round in the air raycasts along the segment it swept, against a ship
  // that is several hundred separate meshes. That is exact and it is the right
  // answer — see the note at the head of this file — and it costs almost nothing
  // when the thing in the air is two rounds every six seconds.
  //
  // The stern mounting puts forty in the air at once. A raycast through her costs
  // the better part of two milliseconds; forty of them a frame is eighty, which
  // is not a frame rate. So every segment is first tested against the target's
  // own bounding box, and one that comes nowhere near it never touches the
  // raycaster at all. A burst spends a tenth of a second inside her bounds and
  // the other four seconds outside them, so almost all of the work disappears.
  //
  // A *box*, and in the target's own frame rather than a sphere in the world.
  // The sphere is two lines shorter and it is much too generous on a hull this
  // shape: 180 m long by 30 across gives a sphere 96 m in radius, so a round
  // passing fifty metres abeam — which is most of a burst — would still pay for
  // a full traversal. Transforming the two ends of the segment into her frame
  // costs two matrix multiplies and buys the real shape.
  //
  // The box is measured once per target and then carried by its matrix, because
  // a hull is rigid: walking a few hundred meshes every frame to discover it is
  // still the same size would cost more than the test it is meant to save.
  const bounds = new Map();
  const _a = new Vector3();
  const _b = new Vector3();

  function boundsFor(obj) {
    let bx = bounds.get(obj);
    if (!bx) {
      const box = new Box3().setFromObject(obj);
      // her own frame: the world box is axis-aligned to the sea, and she turns
      const min = obj.worldToLocal(box.min.clone());
      const max = obj.worldToLocal(box.max.clone());
      const M = 3; // margin, for guns run out and anything that has since moved
      bx = {
        lo: new Vector3(
          Math.min(min.x, max.x) - M, Math.min(min.y, max.y) - M, Math.min(min.z, max.z) - M,
        ),
        hi: new Vector3(
          Math.max(min.x, max.x) + M, Math.max(min.y, max.y) + M, Math.max(min.z, max.z) + M,
        ),
        // world -> her frame, refreshed once a frame rather than once a round:
        // forty rounds against two hulls is eighty matrix inversions a frame, and
        // the answer is the same for all of them.
        inv: new Matrix4(),
      };
      bounds.set(obj, bx);
    }
    return bx;
  }

  // Does the segment from `p0` to `p1` touch any target's box? The standard slab
  // test, run in each target's own frame.
  function refreshBounds(targets) {
    for (const t of targets) boundsFor(t).inv.copy(t.matrixWorld).invert();
  }

  function nearAny(targets, p0, p1) {
    for (const t of targets) {
      const bx = bounds.get(t);
      _a.copy(p0).applyMatrix4(bx.inv);
      _b.copy(p1).applyMatrix4(bx.inv);
      let t0 = 0;
      let t1 = 1;
      let out = false;
      for (const ax of AXES) {
        const a = _a[ax];
        const d = _b[ax] - a;
        const lo = bx.lo[ax];
        const hi = bx.hi[ax];
        if (Math.abs(d) < 1e-9) {
          if (a < lo || a > hi) { out = true; break; }
        } else {
          let n = (lo - a) / d;
          let f = (hi - a) / d;
          if (n > f) { const k = n; n = f; f = k; }
          if (n > t0) t0 = n;
          if (f < t1) t1 = f;
          if (t0 > t1) { out = true; break; }
        }
      }
      if (!out) return true;
    }
    return false;
  }

  const live = [];
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
    owner = null, clearOf = null, inherit = null, proj = SHELL, speed = null,
  } = {}) {
    if (live.length >= max) retire(0);
    const kind = kindFor(proj);
    let s = kind.pool.pop();
    if (!s) {
      const mesh = new Mesh(kind.geometry, kind.material);
      mesh.frustumCulled = false;
      const glow = new Sprite(kind.glowMat);
      glow.frustumCulled = false;
      glow.renderOrder = 22;
      s = { mesh, glow, vel: new Vector3(), spin: 0, kind, proj };
    }
    s.mesh.position.copy(origin);
    s.mesh.visible = true;
    s.glow.visible = true;
    s.vel.copy(direction).normalize().multiplyScalar(speed ?? proj.muzzle);
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
    s.kind.pool.push(s);
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
  // `onBurst` is a round destroying itself in the air at the end of its fuze —
  // see AA_ROUND in ballistics.js. It is not a miss and it is not a hit: it is
  // the round doing what it was built to do, and what it leaves behind is the
  // black puff that makes a sky full of them read as flak.
  function update(dt, {
    target, seaHeight = 0, onHit = null, onMiss = null, onBurst = null,
    wind = null, camera = null,
  }) {
    const targets = target && Array.isArray(target) ? target : (target ? [target] : null);
    if (targets && live.length) refreshBounds(targets);
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
        flightStep(s.mesh.position, s.vel, h, air, s.proj);
        left -= h;
      }

      if (!s.armed && (!s.clearOf || !s.clearOf(s.mesh.position))) s.armed = true;

      _step.subVectors(s.mesh.position, _prev);
      const dist = _step.length();

      if (targets && dist > 1e-4 && nearAny(targets, _prev, s.mesh.position)) {
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
      // ...and only for the main battery. A tracer's trace is the tracer; a
      // vapour trail behind nine rounds a second is a thousand particles a
      // second and a smear across the whole quarter.
      s.trail += dist;
      if (smoke && !s.kind.tracer && s.age < 5 && s.trail > 55) { s.trail = 0; trail(s); }

      // The mote that stands in for a shell too far away to have a size — see
      // `glowMaterial`. Held at about a milliradian, so it is the same speck at
      // any range and is swallowed by the shell itself up close.
      //
      // ...and a tracer burns out. The composition in the base of the round
      // lasts a few seconds and then there is nothing in it left to burn, so the
      // last stretch of the flight is dark and the burst at the end of the fuze
      // appears out of an empty sky — which is precisely what anti-aircraft fire
      // looks like from underneath, and is free.
      s.glow.position.copy(s.mesh.position);
      const burn = s.proj.tracerLife
        ? Math.max(0, 1 - Math.max(0, s.age - s.proj.tracerLife) / 0.5)
        : 1;
      if (burn <= 0) {
        s.glow.visible = false;
      } else {
        s.glow.visible = true;
        const d = camera ? camera.position.distanceTo(s.mesh.position) : 400;
        s.glow.scale.setScalar(Math.max(s.kind.minSize, d * s.kind.angular) * burn);
      }

      // The fuze. A self-destructing round has a life measured from the muzzle
      // rather than a range set on it, which is what the tracer round actually
      // carries: it burns for so long and then it goes off, wherever it has got
      // to. Checked after the hit test, so a round that reaches its target on
      // the last tenth of its fuze still hits it.
      if (s.proj.fuze && s.age >= s.proj.fuze) {
        if (onBurst) onBurst({ point: s.mesh.position.clone(), shell: s });
        retire(i);
        continue;
      }

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
