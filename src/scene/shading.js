import { Color, Vector3, MathUtils } from 'three/webgpu';
import { uniform } from './uniforms.js';

// The scene's shading state, as one set of uniforms.
//
// Nothing in this project uses three's lighting model — sea, sky and hull are
// all shaded by hand from these values — so "what the scene looks like" is
// entirely a matter of what is written here. That is what makes a time of day
// a data change rather than a second set of materials, and it is why this lives
// in its own module: every page that draws this world (the sim, the destruction
// test rig) has to build the same uniforms or its ship is lit differently from
// its sea.

export function createShading(params) {
  const c = params.colors;
  return {
    sunDir: uniform(new Vector3()),
    sunColor: uniform(new Color(c.sun)),
    horizon: uniform(new Color(c.skyHorizon)),
    zenith: uniform(new Color(c.skyZenith)),
    deepColor: uniform(new Color(c.deep)),
    scatterColor: uniform(new Color(c.scatter)),
    sssStrength: uniform(params.sssStrength),
    foamColor: uniform(new Color(c.foam)),
    foamThreshold: uniform(params.foamThreshold),
    foamScale: uniform(params.foamScale),
    detail: uniform(params.detailStrength),
    time: uniform(0),
    // 0 = day, 1 = night. Drives the stars and every lamp on the ship.
    night: uniform(0),
    // Global scales on the hull's metal response, over the per-vertex values
    // baked into each part. One knob each for how much steel shows through the
    // paint, how far the plating's grain stretches the highlights, and how much
    // the film on it splits the sun by wavelength. See boat/metal.js.
    metalness: uniform(params.hull.metalness),
    anisotropy: uniform(params.hull.anisotropy),
    dispersion: uniform(params.hull.dispersion),
  };
}

// Write the sun's direction from the azimuth/elevation in `params`. The caller
// still has to move its own DirectionalLight afterwards — that light owns the
// shadow map and has to stay over whatever it is meant to be shadowing, which
// is a per-page decision.
export function updateSunDir(params, shading) {
  const az = MathUtils.degToRad(params.sunAzimuth);
  const el = MathUtils.degToRad(params.sunElevation);
  shading.sunDir.value
    .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
    .normalize();
  return shading.sunDir.value;
}

const _ca = new Color();
const _cb = new Color();

// Apply a time of day, 0 = night through 1 = full day, by interpolating between
// whichever two of `params.timeKeys` bracket it. `onSun` runs once the sun
// direction has been rewritten, for the caller to reposition its light.
export function applyTimeOfDay(t, { params, shading, renderer = null, scene = null, onSun = null }) {
  params.timeOfDay = Math.min(Math.max(t, 0), 1);
  const keys = params.timeKeys;
  // find the two keys this time falls between
  let i = 0;
  while (i < keys.length - 2 && params.timeOfDay > keys[i + 1].at) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const f = Math.min(Math.max((params.timeOfDay - a.at) / (b.at - a.at), 0), 1);
  const lerp = (x, y) => x + (y - x) * f;
  const col = (key) => _ca.setHex(a.colors[key]).lerp(_cb.setHex(b.colors[key]), f);

  params.sunAzimuth = lerp(a.sunAzimuth, b.sunAzimuth);
  params.sunElevation = lerp(a.sunElevation, b.sunElevation);
  params.exposure = lerp(a.exposure, b.exposure);
  params.sssStrength = lerp(a.sssStrength, b.sssStrength);
  shading.sssStrength.value = params.sssStrength;
  shading.night.value = lerp(a.night, b.night);
  shading.deepColor.value.copy(col('deep'));
  shading.scatterColor.value.copy(col('scatter'));
  shading.sunColor.value.copy(col('sun'));
  shading.horizon.value.copy(col('skyHorizon'));
  shading.zenith.value.copy(col('skyZenith'));
  shading.foamColor.value.copy(col('foam'));
  if (renderer) {
    renderer.toneMappingExposure = params.exposure;
    renderer.setClearColor(col('skyHorizon'), 1);
  }
  if (scene && scene.fog) {
    scene.fog.color.copy(col('skyHorizon'));
    scene.fog.density = lerp(a.fog, b.fog);
  }
  updateSunDir(params, shading);
  if (onSun) onSun();
}
