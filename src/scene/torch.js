import { Vector4 } from 'three/webgpu';
import {
  float, dot, saturate, max, sqrt, inverseSqrt, smoothstep, vec3,
} from 'three/tsl';
import { uniform, uniformArray } from './uniforms.js';

// The lights a man carries.
//
// Everything else that lights this ship is either the sky or bolted to her, and
// both of those could be answered where they were: the sky is a function, the
// lamps are a fixed list baked against a fixed occlusion volume. A torch under a
// rifle's handguard is neither. It is carried, it points wherever the man
// carrying it is looking, and at night it is by a wide margin the brightest thing
// within fifty metres of him — which means it has to be evaluated per fragment on
// every program that draws anything he might point it at, and it has to be *one*
// light rather than a rig standing in for a run of them.
//
// So it is its own module, imported by both the ship's materials and the ones the
// figures use, rather than being smuggled into the flash list. Three differences
// from a gun's flash make that worth the file:
//
//   - these have a direction and a cone, and a point light with no cone pointed
//     at a bulkhead two metres away lights the whole compartment instead of a
//     disc;
//   - the torch lasts as long as you leave it on, so it cannot ride the `on`
//     scalar the flashes use to be free on the frames nothing is firing;
//   - they are stated in the ship's own frame, because that is the frame every
//     program already has a matrix for.
//
// --- why there are two of them ------------------------------------------------
//
// Slot 0 is the torch. Slot 1 is the flash at the muzzle of the same rifle, and
// it is here rather than in the ship's flash rig because that rig is sized and
// scaled for sixteen-inch guns: it holds four, it is refilled every frame from
// the mounts that are firing, and everything in it is scaled off a bore. A 5.56
// flash through it comes out as a light with a reach of eighty centimetres,
// which is to say no light at all — while what a rifle going off in a dark
// passage actually does is print the whole compartment on your retina for a
// fortieth of a second.
//
// Giving it a slot here costs one more unrolled iteration inside a branch that
// already exists, and it gets a cone for free: a flash is a light with a very
// wide cone rather than a different kind of thing.
//
// There is no shadowing on either, and there is not going to be: one more depth
// pass a frame for a hand torch is not a trade worth making on a ship that is
// mostly dark. What you get instead is a cone that stops at nothing, and the
// place you notice is standing in a doorway shining it at the far bulkhead — the
// frame of the door does not cut the beam. Everywhere else the falloff and the
// wrap do the work.

export const HAND_LIGHTS = 2;
export const TORCH_SLOT = 0;
export const MUZZLE_SLOT = 1;

export const TORCH = {
  // A service torch, not a searchlight: about thirty metres of usable throw with
  // a bright middle and a wide spill round it. The angles are the half-angles of
  // the two cones the beam is built from.
  reach: 34, // m
  inner: 9, // degrees — the hot spot
  outer: 27, // degrees — the edge of the spill
  color: [1.0, 0.94, 0.80], // a filament rather than an LED: warm, and green-shy
  // Enough to read a bulkhead by at ten metres and not enough to blow it white
  // at three. The first pass at this was six times as bright and added flat, and
  // the turret it was pointed at came back as a white silhouette — which is what
  // a torch does to a photograph and not what it does to an eye. It is scaled by
  // the surface's own albedo where it lands; see the note at the call site in
  // boatMaterial.js.
  level: 1.8,
};

export const MUZZLE = {
  // A rifle flash. Half the torch's reach and several times its level, which is
  // the right way round: it is not a beam, it is everything within a few metres
  // of the muzzle being lit for a fortieth of a second by something you cannot
  // look at.
  reach: 16, // m
  inner: 60, // degrees — near enough a bare bulb
  outer: 105, // and it spills behind the muzzle too, because the gas does
  color: [1.0, 0.83, 0.55],
  // Bright, and bounded by the reach rather than by the level: what a rifle going
  // off does is light everything within a few metres of the muzzle for a
  // twentieth of a second, and nothing beyond that at all.
  level: 14,
  life: 0.055, // s, and it decays as the square, so most of it is in the first 20 ms
};

export function createHandLights() {
  // Packed three-to-a-vec4 for the same reason the lamps are: one uniform write
  // a frame, and the shader wants the reach and the two cone cosines alongside
  // the vectors they qualify anyway.
  const pos = Array.from({ length: HAND_LIGHTS }, () => new Vector4(0, 0, 0, 0));
  const dir = Array.from({ length: HAND_LIGHTS }, () => new Vector4(0, 0, 1, 1));
  const col = Array.from({ length: HAND_LIGHTS }, () => new Vector4(0, 0, 0, 1));

  const rig = {
    count: HAND_LIGHTS,
    // Zero unless something is burning. Almost every frame of this game has
    // nobody on deck with a torch, and on those frames the whole block below is
    // one compare on every program that reads it.
    on: uniform(0),
    pos: uniformArray(pos, 'vec4'),
    dir: uniformArray(dir, 'vec4'),
    col: uniformArray(col, 'vec4'),

    // `p` and `d` are the lamp and its axis in the ship's own frame.
    set(i, p, d, {
      reach = TORCH.reach, inner = TORCH.inner, outer = TORCH.outer,
      color = TORCH.color, level = TORCH.level,
    } = {}) {
      pos[i].set(p.x, p.y, p.z, reach > 0.01 ? 1 / reach : 0);
      const len = Math.hypot(d.x, d.y, d.z) || 1;
      dir[i].set(d.x / len, d.y / len, d.z / len, Math.cos((outer * Math.PI) / 180));
      col[i].set(color[0] * level, color[1] * level, color[2] * level,
        Math.cos((inner * Math.PI) / 180));
      rig.sync();
    },

    clear(i) {
      col[i].set(0, 0, 0, 1);
      pos[i].set(0, 0, 0, 0);
      rig.sync();
    },

    // A slot with no colour in it contributes nothing, so the gate is simply
    // whether any of them has any.
    sync() {
      let live = 0;
      for (const c of col) if (c.x + c.y + c.z > 1e-4) live = 1;
      rig.on.value = live;
      rig.pos.needsUpdate = true;
      rig.dir.needsUpdate = true;
      rig.col.needsUpdate = true;
    },
  };
  return rig;
}

// What the carried lights land on, given a point and a normal *in the ship's
// frame*. Returns black outside every reach and every cone, so the caller adds it
// unconditionally inside its own `If (rig.on)`.
//
// A plain function rather than a TSL `Fn`, so it inlines into whichever graph is
// building — the same shape as `grey` and `platingFrame` elsewhere. It lives in
// this file rather than at either call site because the two call sites are in
// different modules, and a cone light that disagrees with itself between the deck
// and the man standing on it is worse than no cone.
export const handLight = (rig, P, N) => {
  const sum = vec3(0).toVar();
  for (let i = 0; i < rig.count; i++) {
    const Lp = rig.pos.element(i);
    const Ld = rig.dir.element(i);
    const Lc = rig.col.element(i);
    const toL = Lp.xyz.sub(P).toVar(); // fragment -> lamp
    const d2 = max(dot(toL, toL), float(1e-6)).toVar();
    const k = d2.mul(Lp.w).mul(Lp.w).toVar(); // (dist / reach)^2
    const L = toL.mul(inverseSqrt(d2)).toVar(); // unit, fragment -> lamp
    // How far off the beam axis this fragment is. The lamp points along `dir`,
    // so the ray that reaches here leaves the lamp along -L.
    const cone = smoothstep(Ld.w, Lc.w, dot(L.negate(), Ld.xyz)).toVar();
    // Inverse-square would be right and is unusable: it puts a hundred times the
    // light on a bulkhead at half a metre than on one at five, so the near
    // surface blows out white while the room stays black. This is the same
    // squared-linear falloff the muzzle flashes use — bounded at the lamp, and
    // still carrying light to the edge of the throw rather than dying at a tenth
    // of it.
    const fall = float(1).sub(sqrt(saturate(k))).toVar();
    // A high floor on the wrap, and it earns its keep here more than anywhere: a
    // torch is held at the eye, so almost everything it lights is being looked at
    // straight on, and the few surfaces at a glancing angle are the ones carrying
    // the shape of what you are looking at.
    const wrap = saturate(dot(N, L)).mul(0.72).add(0.28);
    sum.addAssign(Lc.rgb.mul(fall.mul(fall)).mul(cone).mul(wrap));
  }
  return sum;
};
