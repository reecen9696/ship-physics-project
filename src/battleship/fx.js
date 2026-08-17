import {
  Sprite, SpriteNodeMaterial, NormalBlending, AdditiveBlending,
  InstancedBufferAttribute, DynamicDrawUsage, Vector3,
} from 'three/webgpu';
import {
  Fn, vec3, vec4, float, uv, dot, saturate, mix, pow, smoothstep, uniform,
  instancedBufferAttribute,
} from 'three/tsl';
import { createDirtyRanges } from '../util/dirtyRanges.js';

// Fire and smoke, as one billboard system.
//
// The two are the same particle with different shading and different buoyancy:
// flame is short-lived, bright, additively blended and rises fast; smoke is
// long-lived, dark, normally blended, rises slowly and swells as it goes. Both
// are dragged aft by the ship's motion and pushed downwind, which is what makes
// a burning ship look like it is underway rather than like a campfire.
//
// Kept on the CPU for the same reason the hull spray is: a few thousand
// particles, and the emission rules (which compartment is burning, how hard)
// live on the CPU anyway.

export function createFireSmoke({ shading, count = 4000 }) {
  // xyz + size
  const posSize = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  // life fraction, random seed, kind (0 = smoke, 1 = flame), heat
  const attrs = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  posSize.setUsage(DynamicDrawUsage);
  attrs.setUsage(DynamicDrawUsage);

  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const growth = new Float32Array(count);
  let cursor = 0;
  let alive = 0;
  // Only the slots that changed get uploaded — see dirtyRanges.js. A ship that
  // is neither making smoke nor on fire should cost nothing at all here, and
  // before this it cost a full buffer write a frame.
  const dirty = createDirtyRanges(count);

  const pa = instancedBufferAttribute(posSize);
  const fa = instancedBufferAttribute(attrs);
  const opacity = uniform(0.85);

  const material = new SpriteNodeMaterial();
  material.positionNode = pa.xyz;
  material.scaleNode = pa.w;
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2).toVar();
    const r2 = dot(p, p).toVar();
    const lifeFrac = fa.x;
    const seed = fa.y;
    const kind = fa.z;
    const age = float(1).sub(lifeFrac);

    // Smoke: soot near the source, greying and lightening as it ages and mixes
    // with air, lit by the sky rather than by the sun (it is optically thick).
    const sooty = vec3(0.06, 0.055, 0.05);
    const grey = mix(vec3(0.30, 0.30, 0.31), vec3(0.62, 0.63, 0.66), seed.mul(0.5).add(age.mul(0.5)));
    const smokeCol = mix(sooty, grey, saturate(age.mul(1.8))).mul(
      mix(float(0.55), float(1.0), saturate(shading.sunDir.y.add(0.4))),
    );

    // Flame: white-hot core through yellow to a red, smoky tip. Driven by age,
    // so a single particle burns down through the whole ramp.
    const hot = mix(vec3(1.0, 0.95, 0.75), vec3(1.0, 0.45, 0.09), saturate(age.mul(1.6)));
    const flameCol = mix(hot, vec3(0.35, 0.09, 0.03), saturate(age.mul(age).mul(1.4)));

    const col = mix(smokeCol, flameCol, kind);

    // Soft round falloff; flame is tighter so it reads as a licking tongue and
    // smoke is broad so overlapping puffs merge into a column.
    const edge = mix(float(1.6), float(0.9), kind);
    const alpha = pow(saturate(float(1).sub(r2)), edge);
    // smoke fades in as it leaves the fire and out as it thins; flame just dies
    const fade = mix(
      smoothstep(float(0), float(0.12), age).mul(saturate(lifeFrac.mul(2.2))),
      saturate(lifeFrac.mul(1.6)),
      kind,
    );
    const amount = mix(float(0.5), float(0.95), kind);
    return vec4(col, alpha.mul(fade).mul(amount).mul(opacity));
  })();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = NormalBlending;

  const mesh = new Sprite(material);
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.renderOrder = 21;

  // Flame wants additive blending to glow, smoke wants normal blending to
  // occlude. One sprite mesh can only have one, so flame is a second, small
  // instanced mesh sharing the same integrator.
  const flameCount = Math.floor(count / 4);
  const flamePosSize = new InstancedBufferAttribute(new Float32Array(flameCount * 4), 4);
  const flameAttrs = new InstancedBufferAttribute(new Float32Array(flameCount * 4), 4);
  flamePosSize.setUsage(DynamicDrawUsage);
  flameAttrs.setUsage(DynamicDrawUsage);

  const _d = new Vector3();

  // Emit `n` particles at `origin`. `kind` 0 = smoke, 1 = flame.
  function emit(origin, n, {
    kind = 0, rise = 3.0, spread = 1.2, size = 2.0, life: span = 4.0, carry = null, grow = 1.2,
  } = {}) {
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % count;
      if (life[i] <= 0) alive++;

      _d.set(
        (Math.random() - 0.5) * spread,
        rise * (0.6 + Math.random() * 0.8),
        (Math.random() - 0.5) * spread,
      );
      if (carry) _d.add(carry);
      const j = i * 3;
      vel[j] = _d.x; vel[j + 1] = _d.y; vel[j + 2] = _d.z;

      const p = i * 4;
      posSize.array[p] = origin.x + (Math.random() - 0.5) * spread;
      posSize.array[p + 1] = origin.y + (Math.random() - 0.5) * spread * 0.5;
      posSize.array[p + 2] = origin.z + (Math.random() - 0.5) * spread;
      posSize.array[p + 3] = size * (0.6 + Math.random() * 0.8);

      growth[i] = grow;
      maxLife[i] = span * (0.7 + Math.random() * 0.6);
      life[i] = maxLife[i];
      attrs.array[p + 1] = Math.random();
      attrs.array[p + 2] = kind;
      dirty.mark(i);
    }
  }

  function update(dt, wind) {
    if (alive === 0) {
      // Nothing alive: no integration and, more to the point, no upload. `emit`
      // may have marked slots this frame, so flush those and leave.
      dirty.flush(posSize, attrs);
      return;
    }
    alive = 0;
    for (let i = 0; i < count; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      dirty.mark(i);
      if (life[i] <= 0) { posSize.array[i * 4 + 3] = 0; continue; }
      alive++;
      const j = i * 3;
      const p = i * 4;
      const frac = life[i] / maxLife[i];
      const flame = attrs.array[p + 2] > 0.5;
      // Flame is buoyant and short. Smoke leaves the stack hot and rising, then
      // cools, and once it has cooled it simply *is* the air — so its buoyancy
      // decays and its horizontal velocity relaxes onto the wind. That decay is
      // what bends the column over downwind instead of leaving it standing up
      // like a pillar.
      const buoy = flame ? 6.0 : 3.4 * frac * frac;
      vel[j + 1] += buoy * dt;
      // relax onto the wind; a puff a couple of seconds old is moving with it
      const drag = flame ? 3.0 : 1.9;
      vel[j] += (wind.x - vel[j]) * drag * dt;
      vel[j + 2] += (wind.z - vel[j + 2]) * drag * dt;
      vel[j + 1] *= 1 / (1 + (flame ? 2.5 : 1.1) * dt);

      posSize.array[p] += vel[j] * dt;
      posSize.array[p + 1] += vel[j + 1] * dt;
      posSize.array[p + 2] += vel[j + 2] * dt;
      posSize.array[p + 3] += growth[i] * dt;
      attrs.array[p] = frac;
    }
    dirty.flush(posSize, attrs);
  }

  // Kill every live particle. Without this, switching the emitters off leaves
  // the last seven seconds of plume hanging over the ship — long enough that you
  // cannot tell whether the switch worked.
  function clear() {
    life.fill(0);
    for (let i = 0; i < count; i++) posSize.array[i * 4 + 3] = 0;
    for (let i = 0; i < count; i++) dirty.mark(i);
    dirty.flush(posSize, attrs);
    alive = 0;
  }

  return { mesh, emit, update, clear, opacity, get aliveCount() { return alive; } };
}
