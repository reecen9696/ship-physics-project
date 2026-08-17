import { Vector3 } from 'three/webgpu';
import { WOUNDS } from './spec.js';

// What a hit looks like.
//
// One place for the recipes, so that "an HE shell" is a single description
// rather than thirty lines scattered through the hit handler, and so that a
// funnel landing on a deckhouse can ask for the same burst a shell does without
// knowing anything about particle systems.
//
// Everything here drives systems that already exist: the fire-and-smoke
// billboards, the launch's droplet system (water is water — a shell going into
// the sea and a shell throwing spray off a wet hull are the same particles),
// and the shard pool. What is new is only the *composition*, and the ordering,
// which matters more than it sounds: a burst reads as an explosion when the
// flash is much shorter than the fireball, the fireball much shorter than the
// smoke, and the debris outlives all three.

const _d = new Vector3();
const _up = new Vector3(0, 1, 0);

export function createBurst({ fx, splash, shards }) {
  // `dir` is the direction the *blast* is going — for a shell, the way it was
  // travelling; for a piece of wreckage, up off the surface it hit.
  function play(kind, at, dir = null, strength = 1) {
    const spec = WOUNDS[kind] || WOUNDS.HE;
    const s = Math.max(0.15, strength);
    _d.copy(dir || _up).normalize();
    // the blast comes back out of the hole it made, biased upward
    const out = _d.clone().negate();
    out.y = Math.abs(out.y) * 0.5 + 0.55;
    out.normalize();

    if (kind === 'AP') {
      // A cap piercing plate is not an explosion on the outside — it is a flash
      // and a spray of spall. What it does happens inside her.
      fx.emit(at, Math.round(7 * s), {
        kind: 1, rise: 9, spread: 1.1, size: 1.5 * s, life: 0.35, grow: 1.2,
      });
      fx.emit(at, Math.round(9 * s), {
        kind: 0, rise: 4, spread: 1.6, size: 1.9 * s, life: 3.2, grow: 1.6,
      });
      if (splash) splash.burst(at, out, 9, Math.round(22 * s), { spread: 0.9, size: 0.3, life: 0.8 });
      if (shards) shards.burst(at, out, Math.round(4 * s), { speed: 18, spread: 0.9, scale: 0.45 });
      return;
    }

    if (kind === 'TORP') {
      // The column, not the flame: a torpedo detonating against a hull throws a
      // forty-metre tower of water up her side, and that is the whole picture
      // from outside. The fire is somewhere you cannot see.
      if (splash) {
        splash.burst(at, _up, 34, 260, { spread: 2.2, size: 1.5, life: 3.4 });
        splash.burst(at, out, 16, 90, { spread: 1.8, size: 0.9, life: 2.0 });
      }
      fx.emit(at, 26, { kind: 1, rise: 12, spread: 4, size: 4.5, life: 0.9, grow: 3.0 });
      fx.emit(at, 55, { kind: 0, rise: 7, spread: 6, size: 5.5, life: 11, grow: 4.0 });
      if (shards) shards.burst(at, out, 26, { speed: 26, spread: 1.0, scale: 1.5 });
      return;
    }

    if (kind === 'MAGAZINE') {
      // Everything at once, and then a column of smoke that stands over her for
      // the rest of the action.
      fx.emit(at, 90, { kind: 1, rise: 26, spread: 9, size: 9, life: 1.9, grow: 7 });
      fx.emit(at, 220, { kind: 0, rise: 15, spread: 12, size: 10, life: 26, grow: 6.5 });
      if (splash) splash.burst(at, _up, 30, 160, { spread: 3.5, size: 1.1, life: 2.6 });
      if (shards) {
        shards.burst(at, _up, 90, { speed: 52, spread: 1.3, scale: 2.2 });
        shards.burst(at, out, 40, { speed: 38, spread: 1.1, scale: 1.4 });
      }
      return;
    }

    if (kind === 'IMPACT') {
      // Steel on steel: no fire, a lot of dust off the paint, and a shower of
      // whatever was already loose.
      fx.emit(at, Math.round(10 * s), {
        kind: 0, rise: 3.5, spread: 2.4 * s, size: 2.4 * s, life: 3.5, grow: 2.2,
      });
      if (shards) shards.burst(at, out, Math.round(8 * s), { speed: 12 * s, spread: 1.1, scale: 0.7, hot: 0.15 });
      if (splash) splash.burst(at, out, 6 * s, Math.round(18 * s), { spread: 1.0, size: 0.28, life: 0.7 });
      return;
    }

    // HE, and anything else
    // flash: very short, very bright, and gone before the eye has finished with
    // it — which is what makes the fireball behind it read as heat rather than
    // as a puff
    fx.emit(at, Math.round(14 * s), {
      kind: 1, rise: 16, spread: 1.4 * s, size: 3.4 * s, life: 0.22, grow: 5.0,
    });
    fx.emit(at, Math.round(20 * s), {
      kind: 1, rise: 8, spread: 3.0 * s, size: 3.0 * s, life: 0.95, grow: 2.2,
    });
    fx.emit(at, Math.round(34 * s), {
      kind: 0, rise: 5.5, spread: 4.0 * s, size: 3.8 * s, life: 8.5, grow: 3.0,
    });
    if (splash) splash.burst(at, out, 12 * s, Math.round(38 * s), { spread: 1.3, size: 0.4, life: 1.2 });
    if (shards) shards.burst(at, out, Math.round(13 * s), { speed: 25, spread: 1.0, scale: 1.0 });
  }

  return { play, spec: (kind) => WOUNDS[kind] || WOUNDS.HE };
}
