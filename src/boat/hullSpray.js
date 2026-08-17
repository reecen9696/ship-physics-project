import {
  Sprite, SpriteNodeMaterial, NormalBlending, InstancedBufferAttribute, DynamicDrawUsage,
  Vector3,
} from 'three/webgpu';
import {
  Fn, vec3, vec4, float, uv, dot, sqrt, saturate, mix, pow, reflect, normalize, max,
  smoothstep, uniform, instancedBufferAttribute,
} from 'three/tsl';
import { skyColor } from '../ocean/sky.js';
import { createDirtyRanges } from '../util/dirtyRanges.js';

// Spray thrown off the hull.
//
// This is not an SPH fluid. A boat's spray is thin sheets breaking into
// millimetre droplets, which particle-based fluids resolve badly at any count
// that runs in real time — and there is nothing to couple an SPH sim *to* here,
// because the sea is synthesised from a wave spectrum each frame rather than
// simulated. What actually makes spray convincing is that its momentum comes
// from the real hull–water interaction, so that is what is modelled: droplets are
// launched with velocities derived from how fast the hull is being immersed and
// how fast it is pushing water aside, then fly ballistically and die when they
// fall back through the surface.
//
// Droplets are integrated on the CPU. There are only a few thousand, the hull
// state that spawns them already lives there, and it keeps the emission rules
// readable — which is the part worth being able to reason about.
export const sprayConfig = {
  enabled: true,
  // Slam: how hard the hull has to be driving into the water before it throws
  // any, and how fast the resulting jet leaves. A wedge entering water throws a
  // root jet at a couple of times its entry speed, which is why `slamJet` is
  // above 1 — this is the burst you get when she drops off a crest.
  slamThreshold: 0.8, // m/s of immersion
  slamJet: 2.4, // jet speed as a multiple of entry speed
  slamRate: 220, // droplets per m/s of immersion per second

  // Shouldering: the bow pushing water aside as she drives forward, and the
  // hull throwing it sideways when she skids through a turn.
  bowRate: 160, // droplets per m/s of shouldering per second
  bowSpeed: 0.55, // launch speed as a fraction of the shouldering speed
  bowThreshold: 2.2, // m/s below which the bow makes no spray worth drawing

  // Short-lived, and individually very sheer — spray reads as spray because
  // hundreds of droplets overlap into a sheet, not because each one is opaque.
  // Long-lived opaque droplets look like falling snow.
  // Volume comes from droplet *count*, not droplet size. Scaling the size up to
  // get more water just turns the spray into beach balls — on a 16.5 m hull
  // anything past about 0.3 m across stops reading as water.
  size: 0.045,
  // Real spray is mostly fine mist with a few heavier gobbets in it. A flat size
  // distribution reads as uniform fog; skewing it is part of what sells it.
  sizeTail: 1.4,
  opacity: 0.35,
  // 0 = shaded exactly as sea water, 1 = pure foam. Airborne water is aerated,
  // so it sits between the two.
  aeration: 0.5,
  settle: 0.28, // seconds a droplet takes to merge back into the sea on landing
  grow: 0.03, // m/s the droplets swell as the sheet breaks up
  // Short-lived and heavily damped, which keeps the spray packed around the
  // hull where it belongs. Spread thinly over a wide volume nothing overlaps,
  // and isolated droplets can only ever read as isolated droplets — cohesion
  // comes from local density.
  life: 0.5,
  drag: 2.8, // atomised water sheds speed fast
  windCarry: 0.12,
};

export function createHullSpray({ shading, count = 30000 }) {
  const opacity = uniform(sprayConfig.opacity);
  const aeration = uniform(sprayConfig.aeration);
  // The camera's world basis, so a billboard can be shaded as a sphere.
  const camRight = uniform(new Vector3(1, 0, 0));
  const camUp = uniform(new Vector3(0, 1, 0));
  const camFwd = uniform(new Vector3(0, 0, 1));
  // xyz + size. Size 0 means dead, which also collapses the billboard to nothing.
  const posSize = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  // remaining life fraction + a per-droplet random, for varied shading
  const fade = new InstancedBufferAttribute(new Float32Array(count * 2), 2);
  posSize.setUsage(DynamicDrawUsage);
  fade.setUsage(DynamicDrawUsage);

  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  let cursor = 0;
  let alive = 0;
  // Only the slots that changed get uploaded — see dirtyRanges.js. The pool is
  // sized for the worst sea state it will ever meet, and on an ordinary frame
  // almost none of it is alive.
  const dirty = createDirtyRanges(count);

  const pa = instancedBufferAttribute(posSize);
  const fa = instancedBufferAttribute(fade);

  const material = new SpriteNodeMaterial();
  material.positionNode = pa.xyz;
  material.scaleNode = pa.w;
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2).toVar(); // -1..1 across the billboard
    const r2 = dot(p, p).toVar();
    const lifeFrac = fa.x;
    const seed = fa.y;

    // Treat the billboard as a sphere facing the camera, then run the *ocean's*
    // own shading model over that normal — same deep colour, same subsurface
    // scatter, same Fresnel against the same analytic sky. Spray is the sea in
    // the air, so it should answer to light the way the sea does; shading it as
    // a white blob with a rim highlight is what made it read as soap bubbles.
    // The sphere normal is flattened hard toward the viewer. A full spherical
    // normal gives every droplet a bright Fresnel rim and a dark middle, which
    // is precisely how a soap bubble is drawn — it was the bubble tell. Keeping
    // a little of it gives shading variety without the rim.
    const N = normalize(
      camRight.mul(p.x.mul(0.45))
        .add(camUp.mul(p.y.mul(0.45)))
        .add(camFwd.mul(sqrt(saturate(float(1).sub(r2))).add(0.55))),
    ).toVar();
    const V = camFwd; // billboards face the camera, so this is the view direction

    const fres = float(0.02).add(float(0.98).mul(pow(float(1).sub(saturate(dot(N, V))), 5)));
    const R = reflect(V.negate(), N);
    const refl = skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z)), shading);

    // ocean body colour, including the crest-glow scatter term
    const Hs = normalize(N.negate().add(shading.sunDir));
    const sss = pow(saturate(dot(V, Hs.negate())), 4).mul(shading.sssStrength);
    const body = mix(shading.deepColor, shading.scatterColor, saturate(float(0.12).add(sss)));
    const sea = mix(body, refl, fres);

    // Airborne water is full of entrained air, so it is whiter than the sea it
    // came from — but it is still that water, not paint.
    const foamLight = float(0.55).add(saturate(dot(N, shading.sunDir)).mul(0.6));
    const col = mix(sea, shading.foamColor.mul(foamLight), aeration).toVar();

    // Soft-edged, so that overlapping droplets accumulate into a continuous
    // wash of water rather than a heap of separate balls. Hard rims read as
    // bubbles; cohesion has to come from density, not from each droplet being
    // individually solid.
    const alpha = pow(saturate(float(1).sub(r2)), 1.4);

    const age = float(1).sub(lifeFrac);
    const fadeIn = saturate(age.mul(7)).mul(saturate(lifeFrac.mul(1.7)));
    return vec4(col, alpha.mul(fadeIn).mul(opacity));
  })();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = NormalBlending;

  const mesh = new Sprite(material);
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.renderOrder = 20; // after the sea, which is itself drawn after the hull

  const _d = new Vector3();

  // Launch `n` droplets from `origin` along `dir`, at `speed` (m/s), spread over
  // a cone of `spread` radians, and carried by `carry` (the hull's own velocity —
  // spray leaves the boat already moving with it).
  function burst(origin, dir, speed, n, {
    spread = 0.5, carry = null, size = 0.16, life: lifeSpan = 1.1,
    along = null, alongScale = 0,
  } = {}) {
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % count;
      if (life[i] <= 0) alive++;

      // jitter the launch direction within the cone
      _d.copy(dir);
      _d.x += (Math.random() - 0.5) * spread;
      _d.y += (Math.random() - 0.5) * spread * 0.6;
      _d.z += (Math.random() - 0.5) * spread;
      _d.normalize().multiplyScalar(speed * (0.55 + Math.random() * 0.9));
      if (carry) _d.add(carry);

      const j = i * 3;
      vel[j] = _d.x; vel[j + 1] = _d.y; vel[j + 2] = _d.z;

      // Smear the launch point along the hull rather than firing every droplet
      // from one spot — spray leaves as a sheet down the side, not a fountain.
      const a = along ? (Math.random() - 0.5) * alongScale : 0;
      const p = i * 4;
      posSize.array[p] = origin.x + (along ? along.x * a : 0) + (Math.random() - 0.5) * 0.35;
      posSize.array[p + 1] = origin.y + (along ? along.y * a : 0) + (Math.random() - 0.5) * 0.2;
      posSize.array[p + 2] = origin.z + (along ? along.z * a : 0) + (Math.random() - 0.5) * 0.35;
      const r = Math.random();
      posSize.array[p + 3] = size * (0.35 + r * r * sprayConfig.sizeTail);

      maxLife[i] = lifeSpan * (0.7 + Math.random() * 0.7);
      life[i] = maxLife[i];
      fade.array[i * 2 + 1] = Math.random();
      dirty.mark(i);
    }
  }

  // `water` is the local surface plane the hull fitted this frame; droplets die
  // when they fall back through it.
  function update(dt, water, wind) {
    if (alive === 0) {
      // Nothing to integrate, and — the part that used to cost real time —
      // nothing to upload either. `burst` may still have marked slots dirty
      // before this ran, so flush those and leave.
      dirty.flush(posSize, fade);
      return;
    }
    const drag = 1 / (1 + sprayConfig.drag * dt);
    const wc = sprayConfig.windCarry;
    alive = 0;
    for (let i = 0; i < count; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      dirty.mark(i);
      if (life[i] <= 0) { posSize.array[i * 4 + 3] = 0; continue; }
      alive++;

      const j = i * 3;
      const p = i * 4;
      vel[j + 1] -= 9.81 * dt;
      vel[j] = (vel[j] + wind.x * wc * dt) * drag;
      vel[j + 1] *= drag;
      vel[j + 2] = (vel[j + 2] + wind.z * wc * dt) * drag;

      posSize.array[p] += vel[j] * dt;
      posSize.array[p + 1] += vel[j + 1] * dt;
      posSize.array[p + 2] += vel[j + 2] * dt;

      // Back into the sea. The local plane is only fair near the boat, but that
      // is where the droplets are and they do not live long enough to drift far.
      //
      // Landing is not a delete: the droplet is pinned to the surface, its fall
      // arrested, and it spreads and fades over `settle` seconds as it merges
      // back into the water. Popping droplets out of existence the instant they
      // touch is the single most obvious tell that they were never water.
      const wy = water.height
        + water.slopeX * (posSize.array[p] - water.originX)
        + water.slopeZ * (posSize.array[p + 2] - water.originZ);
      if (posSize.array[p + 1] < wy && vel[j + 1] < 0) {
        posSize.array[p + 1] = wy;
        vel[j + 1] = 0;
        vel[j] *= 0.3;
        vel[j + 2] *= 0.3;
        const settle = sprayConfig.settle;
        if (life[i] > settle) { life[i] = settle; maxLife[i] = settle; }
      }

      // droplets swell as the sheet breaks up and atomises
      posSize.array[p + 3] += dt * sprayConfig.grow;
      fade.array[i * 2] = life[i] / maxLife[i];
    }
    dirty.flush(posSize, fade);
  }

  // Feed the shader the camera basis each frame; billboards are shaded as
  // spheres and need to know which way is right/up/toward the viewer.
  function setCamera(camera) {
    const e = camera.matrixWorld.elements;
    camRight.value.set(e[0], e[1], e[2]);
    camUp.value.set(e[4], e[5], e[6]);
    camFwd.value.set(e[8], e[9], e[10]); // camera +z points back toward the eye
  }

  return {
    mesh,
    burst,
    update,
    setCamera,
    opacity, // uniforms, so the gui can drive them without a rebuild
    aeration,
    get aliveCount() { return alive; },
  };
}
