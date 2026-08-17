import { Vector3 } from 'three/webgpu';
import {
  Fn, instanceIndex, attributeArray, uniform, float, vec2, vec4, ivec2,
  floor, mix, min, max, length, clamp, textureLoad,
} from 'three/tsl';

// GPU-side query of the ocean surface at a handful of hull points.
//
// The surface only exists as cascade maps on the GPU, so the physics can't just
// evaluate a function: it has to ask. A tiny compute pass samples the same maps
// the surface shader uses (so hull and render agree exactly), writes one vec4 per
// probe, and the result is pulled back with an async map. The readback lands a
// frame or two late — at boat speeds that's a few centimetres, invisible.
//
// The lookup has to be inverted, not just sampled. `displacement.xz` moves the
// surface horizontally (choppiness), so the point that *lands* at world xz is
// not the texel at world xz. A fixed-point iteration recovers it:
//   uv <- p - D_xz(uv),  repeated until it settles (4 passes is plenty).
//
// Output per probe: ( water height, dW/dx, dW/dz, foam/turbulence ).
export function createWaterProbes(renderer, { cascades, lengthScales, N, offsets }) {
  const P = offsets.length;

  // hull-local probe positions — static, uploaded once
  const local = attributeArray(P, 'vec4');
  const la = local.value.array;
  offsets.forEach((o, i) => { la[i * 4] = o[0]; la[i * 4 + 1] = o[1]; la[i * 4 + 2] = o[2]; });
  local.value.needsUpdate = true;

  const out = attributeArray(P, 'vec4');

  // boat frame, refreshed every frame (probe world positions are built in-shader
  // so nothing but 4 vec3s crosses the CPU->GPU boundary per frame)
  const u = {
    pos: uniform(new Vector3()),
    right: uniform(new Vector3(1, 0, 0)),
    up: uniform(new Vector3(0, 1, 0)),
    fwd: uniform(new Vector3(0, 0, 1)),
  };

  // repeat-wrap that stays correct for negative coordinates (WGSL % truncates)
  const wrap = (v, n) => v.sub(n.mul(floor(v.div(n))));

  // bilinear tap into a cascade map; the maps are storage textures, so filtering
  // is done by hand rather than by a sampler
  const sample = (tex, xz, L) => {
    const f = xz.div(float(L)).mul(float(N)).sub(0.5).toVar();
    const i0 = floor(f).toVar();
    const fr = f.sub(i0).toVar();
    const at = (dx, dy) => textureLoad(tex, ivec2(wrap(i0.add(vec2(dx, dy)), float(N))));
    return mix(mix(at(0, 0), at(1, 0), fr.x), mix(at(0, 1), at(1, 1), fr.x), fr.y);
  };

  const kernel = Fn(() => {
    const lo = local.element(instanceIndex).xyz;
    const world = u.pos.add(u.right.mul(lo.x)).add(u.up.mul(lo.y)).add(u.fwd.mul(lo.z));
    const p = vec2(world.x, world.z).toVar();

    // Invert the horizontal displacement to find which texel lands here.
    //
    // Plain iteration (q <- p - D(q)) only converges while |dD/dx| < 1, and this
    // surface deliberately folds over — that fold is what the foam pass keys on.
    // Near a breaking crest the naive form runs away and samples a height from
    // somewhere else entirely, which reads as the hull ignoring the wave. Under-
    // relaxing and capping how far the guess may wander keeps it bounded: at a
    // genuine fold there is no single answer anyway, so a nearby one is right.
    const MAX_OFF = float(Math.max(...lengthScales) * 0.25);
    const q = p.toVar();
    for (let it = 0; it < 3; it++) {
      const d = vec2(0).toVar();
      cascades.forEach((c, i) => { d.addAssign(sample(c.displacement, q, lengthScales[i]).xz); });
      q.assign(q.add(p.sub(d).sub(q).mul(0.65)));
      const off = q.sub(p).toVar();
      q.assign(p.add(off.mul(MAX_OFF.div(max(length(off), MAX_OFF)))));
    }

    const h = float(0).toVar();
    const der = vec4(0).toVar();
    const turb = float(10).toVar();
    cascades.forEach((c, i) => {
      const disp = sample(c.displacement, q, lengthScales[i]);
      h.addAssign(disp.y);
      der.addAssign(sample(c.derivatives, q, lengthScales[i]));
      // finest cascade carries constant speckle — same exclusion the shader makes
      if (i < cascades.length - 1) turb.assign(min(turb, disp.w));
    });

    // Fold-aware slope, matching oceanSurfaceMaterial's normal reconstruction.
    // The shader can live with (1 + dDx/dx) passing through zero at a fold — it
    // only tips a normal. The physics cannot: an unbounded slope becomes an
    // unbounded force. Hold the denominator off zero and cap the result at a
    // 60-degree face, which is steeper than any water that isn't already broken.
    // (a negative denominator means the surface has folded back on itself; the
    // floor keeps the physics on the outward-facing branch)
    const slope = (num, den) => clamp(num.div(max(float(1).add(den), float(0.2))), -1.7, 1.7);
    const slopeX = slope(der.x, der.z);
    const slopeZ = slope(der.y, der.w);

    out.element(instanceIndex).assign(vec4(h, slopeX, slopeZ, turb));
  })().compute(P);

  // latest resolved sample, and the probe world-xz it was taken at (so the
  // physics can extrapolate along the local surface plane while it waits)
  const data = new Float32Array(P * 4);
  const sampleXZ = new Float32Array(P * 2);
  const pendingXZ = new Float32Array(P * 2);
  let inFlight = false;
  let ready = false;

  const _r = new Vector3();

  function dispatch(pos, right, up, fwd) {
    u.pos.value.copy(pos);
    u.right.value.copy(right);
    u.up.value.copy(up);
    u.fwd.value.copy(fwd);
    renderer.compute(kernel);

    if (inFlight) return;
    inFlight = true;
    // mirror the shader's probe placement so the readback can be located
    offsets.forEach((o, i) => {
      _r.copy(right).multiplyScalar(o[0])
        .addScaledVector(up, o[1])
        .addScaledVector(fwd, o[2])
        .add(pos);
      pendingXZ[i * 2] = _r.x;
      pendingXZ[i * 2 + 1] = _r.z;
    });
    const taken = pendingXZ.slice();
    renderer.getArrayBufferAsync(out.value)
      .then((ab) => {
        data.set(new Float32Array(ab, 0, P * 4));
        sampleXZ.set(taken);
        ready = true;
      })
      .catch(() => {})
      .finally(() => { inFlight = false; });
  }

  // Diagnostic: resolve the current probe values now, rather than whenever the
  // next frame's readback happens to land. Only for console/self-test use.
  function sampleAsync() {
    return renderer.getArrayBufferAsync(out.value).then((ab) => {
      data.set(new Float32Array(ab, 0, P * 4));
      ready = true;
      return Array.from(data);
    });
  }

  return { dispatch, sampleAsync, data, sampleXZ, count: P, isReady: () => ready };
}
