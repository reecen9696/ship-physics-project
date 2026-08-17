import {
  vec2, vec3, vec4, float, normalize, dot, cross, max, min, mix, saturate, pow,
  exp2, abs, smoothstep, reflect, normalLocal, modelNormalMatrix, PI,
} from 'three/tsl';

// The specular half of the hull's shading model: a metal BRDF.
//
// Everything here exists because a ship is made of rolled steel, and rolled
// steel does three things that the Blinn-Phong-plus-Fresnel-lerp this replaced
// could not do at all:
//
//   1. It has a *tinted, bright* specular reflectance. A dielectric — paint,
//      plastic, wood — reflects about 4% of the light at normal incidence, and
//      that 4% is white whatever colour the surface is. Metal reflects 55-95%,
//      and it reflects it *coloured*: that is the whole physical difference
//      between metal and everything else, and it is why the old material read
//      as painted cardboard no matter how the highlight was tuned. Metal also
//      has no diffuse lobe at all — the light that is not reflected is absorbed
//      by the free electrons — so as a surface goes metallic its body colour
//      has to go away and be replaced by what it is reflecting.
//
//   2. Its highlight is *stretched*. Hull plating is rolled and the strakes run
//      fore-and-aft, so the microscopic scratch direction is fore-and-aft too,
//      and the sun smears along the ship rather than sitting in a round blob.
//      Anisotropy is the single strongest "this is metal" cue there is; a round
//      highlight reads as plastic however bright it gets.
//
//   3. At any real roughness it scatters light between its own microfacets
//      several times before letting it go. Single-scatter GGX throws that light
//      away, which is what makes rough metal render as dull grey felt. The
//      compensation term below puts it back.
//
// All of it is analytic — there is no environment map in this scene, the sky is
// a function — so the "prefiltered environment" is that same function sampled
// once and blended toward the horizon colour by roughness, which is a fair
// stand-in for integrating a cone of a sky that is a smooth vertical gradient.

// GGX alpha is roughness squared, and at alpha ~ 0 the lobe is a delta function
// that no finite number of samples can hit. Floor it.
const MIN_ALPHA = 0.0015;

// The sun is a disc about half a degree across, not a point. tan(half-angle) is
// ~0.00465, and Karis' sphere-light approximation widens the specular lobe by
// that much and scales the peak down to keep the total energy the same. Without
// it a low-roughness fitting reflecting a *mathematically point-sized* sun has
// an unbounded peak, and unbounded is not a brightness the tone curve can do
// anything sensible with.
const SUN_TAN_HALF_ANGLE = 0.00465;

// Even with the disc widening, a near-mirror surface reflecting the sun is
// genuinely in the tens of thousands of nits, and this renderer is not an HDR
// sensor — NeutralToneMapping rolls everything over ~4 to the same white. Cap
// it: past this the only thing more energy buys is a wider clipped blob.
const SPEC_CAP = 12;

// --- Fresnel -----------------------------------------------------------------
// Schlick, with the grazing value pulled down as the surface roughens.
//
// Textbook Schlick sends every material to a perfect mirror at grazing
// incidence. That is true of a *smooth* surface and false of a rough one: on
// rough steel the grazing rays that would mirror are shadowed by the microfacets
// in front of them, so the rim never reaches 1. Taking F90 = 1 - roughness is
// the standard fix, and it is what stops a rough turret face seen edge-on from
// turning into a sheet of sky — the failure the old material worked around by
// multiplying the whole term by gloss squared.
export function fresnelSchlick(F0, cosT, rough) {
  const F90 = max(vec3(float(1).sub(rough)), F0);
  return mix(F0, F90, pow(saturate(float(1).sub(cosT)), 5));
}

// --- split-sum environment BRDF ----------------------------------------------
// Karis' split-sum approximation normally reads its (scale, bias) pair from a
// precomputed 2D LUT. This is Lazarov's analytic fit to that LUT: same two
// numbers, no texture, accurate to well under a percent over the whole domain.
// The environment specular is then `prefiltered * (F0 * scale + bias)`.
export function envDFG(NoV, rough) {
  const c0 = vec4(-1, -0.0275, -0.572, 0.022);
  const c1 = vec4(1, 0.0425, 1.04, -0.04);
  const r = vec4(rough).mul(c0).add(c1).toVar();
  const a004 = min(r.x.mul(r.x), exp2(NoV.mul(-9.28))).mul(r.x).add(r.y);
  return vec2(-1.04, 1.04).mul(a004).add(r.zw);
}

// Multiple-scattering compensation (Karis / Filament).
//
// A GGX lobe only accounts for light that bounces off one microfacet and
// leaves. The light that bounces off a second facet before leaving is dropped,
// and since a metal's every bounce is a near-total reflection, dropping it is
// how rough metal ends up darker than rough plastic — which is backwards. The
// missing energy is exactly the shortfall of the DFG scale term from 1, so
// scaling the whole specular by this puts it back, coloured by F0 because that
// is what a second bounce off the same metal does to it.
export function energyCompensation(F0, dfgScale) {
  return float(1).add(F0.mul(float(1).div(max(dfgScale, 0.05)).sub(1)));
}

// --- the plating's grain direction -------------------------------------------
// Hull strakes, deck plates and the sides of a deckhouse are all rolled and laid
// fore-and-aft, so the anisotropy axis is the ship's own +Z projected onto the
// surface. Two things to get right:
//
//   * on a bow or transom face +Z is the *normal*, and its projection into the
//     surface is a zero vector that normalizes to garbage — a band of noise
//     right across the stem. Those faces are cross-plated anyway, so swing the
//     grain athwartships there, and swing it *smoothly* so the changeover is not
//     itself a visible line.
//   * the frame must be built in local space and then rotated to world, or every
//     turret and gun barrel carries the hull's grain direction instead of its
//     own, and the highlight stops turning with the mount.
export function platingFrame(N) {
  const nl = normalize(normalLocal);
  const foreAft = vec3(0, 0, 1);
  const athwart = vec3(1, 0, 0);
  const dir = mix(athwart, foreAft, smoothstep(float(0.95), float(0.8), abs(dot(nl, foreAft))));
  const tLocal = dir.sub(nl.mul(dot(nl, dir)));
  const T = normalize(modelNormalMatrix.mul(tLocal)).toVar();
  // re-orthogonalise against the *shaded* normal, which is the interpolated one
  const B = normalize(cross(N, T)).toVar();
  T.assign(cross(B, N));
  return { T, B };
}

// The environment reflection has to stretch with the highlight or the surface
// reads as two different materials at once. Filament's construction: build the
// normal of the plane containing the view ray and the grain direction, and bend
// the shading normal toward it. On a rough surface the bend is the whole effect;
// on a smooth one it barely matters, hence the roughness ramp.
export function anisoReflectDir(N, V, T, B, aniso, rough) {
  const axis = B;
  const anisoT = cross(axis, V);
  const anisoN = cross(anisoT, axis);
  const bend = aniso.mul(saturate(rough.mul(5)));
  return reflect(V.negate(), normalize(mix(N, anisoN, bend)));
}

// --- direct specular ---------------------------------------------------------
// Anisotropic GGX (Burley's D, Heitz' height-correlated visibility), evaluated
// three times for the three colour channels at slightly different lobe widths.
//
// That last part is the "slight refraction from the sun". Steel at sea is never
// bare: there is a film on it — oxide, oil, salt, the paint's own varnish — and
// a film has a refractive index that varies with wavelength, so the sun's image
// in it is dispersed. Red is bent least and rides in a fractionally wider lobe
// than blue, which puts a warm fringe around the outside of every highlight and
// leaves its core cool. It is a small effect and it should stay small: at
// `dispersion` around 0.1 you do not see rainbows, you see a highlight that has
// a temperature gradient across it instead of being one flat colour, which is
// the thing that separates a photograph of metal from a render of it.
export function ggxSpecular({ N, V, L, T, B, alpha, aniso, F0, rough, dispersion }) {
  const H = normalize(L.add(V)).toVar();
  const NoV = abs(dot(N, V)).add(1e-5).toVar();
  const NoL = saturate(dot(N, L)).toVar();
  const NoH = saturate(dot(N, H)).toVar();
  const LoH = saturate(dot(L, H)).toVar();
  const ToH = dot(T, H).toVar();
  const BoH = dot(B, H).toVar();

  // Widen for the sun's disc and scale the peak to match, so total reflected
  // energy is unchanged and only its concentration is bounded.
  const aSun = saturate(alpha.add(SUN_TAN_HALF_ANGLE)).toVar();
  const discNorm = alpha.div(aSun).pow(2).toVar();

  const at = max(aSun.mul(float(1).add(aniso)), MIN_ALPHA).toVar();
  const ab = max(aSun.mul(float(1).sub(aniso)), MIN_ALPHA).toVar();

  // Burley's anisotropic GGX distribution, as a function of the two axis widths.
  const D = (ax, ay) => {
    const a2 = ax.mul(ay);
    const d = vec3(ay.mul(ToH), ax.mul(BoH), a2.mul(NoH));
    const b2 = a2.div(max(dot(d, d), 1e-9));
    return a2.mul(b2).mul(b2).div(PI);
  };

  // Dispersion shifts the lobe width per channel; the visibility and Fresnel
  // terms are shared, since neither is where the colour separation comes from.
  const sR = float(1).add(dispersion);
  const sB = float(1).sub(dispersion);
  const spec = vec3(
    D(at.mul(sR), ab.mul(sR)),
    D(at, ab),
    D(at.mul(sB), ab.mul(sB)),
  ).toVar();

  const lambdaV = NoL.mul(vec3(at.mul(dot(T, V)), ab.mul(dot(B, V)), NoV).length());
  const lambdaL = NoV.mul(vec3(at.mul(dot(T, L)), ab.mul(dot(B, L)), NoL).length());
  const Vis = float(0.5).div(lambdaV.add(lambdaL).add(1e-5));

  return min(
    spec.mul(discNorm).mul(Vis).mul(NoL).mul(fresnelSchlick(F0, LoH, rough)),
    vec3(SPEC_CAP),
  );
}
