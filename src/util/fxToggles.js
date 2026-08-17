import { uniform } from 'three/tsl';

// Every effect on a hull that is coupled to the sea or to the ship's own motion,
// in one switchable registry.
//
// The point of this file is bisection. A hull in this scene is shaded by a dozen
// terms layered on top of each other, several of them driven by the sea state or
// by the ship's own motion, and when something crawls across her plating there
// is no way to tell by reading which term did it. Each entry here is a
// float uniform the shaders multiply their term by, so a checkbox turns one term
// off without recompiling a program or restarting the sim, and whatever is left
// on the screen when the artefact goes away is the culprit.
//
// Scene-side effects (particles, the shadow map) have no shader term to scale,
// so an entry can also carry `hooks` — callbacks main.js registers to do the
// CPU-side equivalent.

const make = (key, label, hint) => ({ key, label, hint, u: uniform(1), on: true, hooks: [] });

const list = [
  // The hull used to shade itself against a water plane fitted to the buoyancy
  // probes — a wet darkening below it and a foam band at it. That whole group is
  // gone; see the note in boatMaterial.js for why a plane could not describe
  // this surface at the scale the effect was drawn at. The wash the ocean draws
  // along a waterline (`seaWash` below) does the job from the real surface.

  // --- how the hull is lit ----------------------------------------------------
  make('hullSkyFill', 'sky ambient (directional)', 'sky sampled along the normal; flat horizon fill when off'),
  make('hullBounce', 'water bounce (directional)', 'light off the sea onto downward faces; flat when off'),
  make('hullFresnel', 'sky reflection (env spec)', 'the sky reflected in the plating, spread by roughness'),
  make('hullSpecular', 'sun highlight', 'specular band where the sun mirrors off the topsides'),
  make('hullAniso', 'plating grain (anisotropy)', 'stretches both highlights along the run of the strakes'),
  make('hullDispersion', 'highlight dispersion', 'splits the sun in the surface film slightly by wavelength'),

  // --- surface detail ---------------------------------------------------------
  make('hullGrain', 'paint grain / planking', 'procedural per-fragment break-up, hashed from local position'),
  make('hullPlating', 'plate seams & rivets', 'strakes, butts, rivet heads and the belly of each plate between them'),
  make('hullPaint', 'boot topping', 'antifoul, boot stripe and topsides painted in the fragment'),
  make('hullScorch', 'battle damage', 'soot and heat discolouring from the damage model'),

  // --- what the sea does around the hull --------------------------------------
  make('seaWash', 'wash at the hull', 'contact foam the ocean draws along a waterline'),
  make('seaWake', 'wake trail', 'that wash trailed aft of the transom with headway'),
  make('seaClip', 'clip sea inside hull', 'discards ocean fragments that are inside a hull'),
  make('seaCrestFoam', 'whitecaps', 'jacobian foam on breaking crests'),
  make('seaShadow', 'ship shadow on sea', 'the shadow map, sampled by the ocean surface'),

  // --- particles --------------------------------------------------------------
  make('funnelSmoke', 'funnel smoke', 'the plume off the stack, which drifts across her'),
  make('fireSmoke', 'fire & battle smoke', 'flame and smoke from burning components'),
  make('hullSpray', 'hull spray', 'droplets thrown off the launch'),
];

export const fx = Object.fromEntries(list.map((e) => [e.key, e]));
export const fxList = list;

// Panel layout: the order above, cut into labelled sections.
export const FX_GROUPS = [
  { title: 'hull lighting', keys: ['hullSkyFill', 'hullBounce'] },
  { title: 'hull metal', keys: ['hullFresnel', 'hullSpecular', 'hullAniso', 'hullDispersion'] },
  { title: 'hull surface', keys: ['hullGrain', 'hullPlating', 'hullPaint', 'hullScorch'] },
  { title: 'sea at the hull', keys: ['seaWash', 'seaWake', 'seaClip', 'seaCrestFoam', 'seaShadow'] },
  { title: 'particles', keys: ['funnelSmoke', 'fireSmoke', 'hullSpray'] },
];

export function setFx(key, on) {
  const e = fx[key];
  if (!e) return;
  e.on = on;
  e.u.value = on ? 1 : 0;
  for (const h of e.hooks) h(on);
}

// Register a CPU-side effect for a toggle. Fires immediately so the hook and the
// switch agree from the first frame.
export function onFx(key, hook) {
  fx[key].hooks.push(hook);
  hook(fx[key].on);
}
