import { MeshBasicNodeMaterial, DoubleSide, Matrix4, Vector4 } from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, normalize, dot, max, saturate, pow, mix, reflect, abs,
  smoothstep, cameraPosition, positionWorld, positionLocal, normalWorld, attribute,
  fract, floor, hash, fwidth, normalLocal, step, min, length,
  uniform, texture3D, Loop, If, Discard,
} from 'three/tsl';
import { skyColor } from '../ocean/sky.js';
import { fx } from '../util/fxToggles.js';
import {
  platingFrame, anisoReflectDir, envDFG, energyCompensation, ggxSpecular,
} from './metal.js';

// The boat is shaded by hand from the same uniforms the ocean and sky use,
// rather than by three's standard lighting. That is the whole point: a
// MeshStandardMaterial lit by its own DirectionalLight sits in a different world
// from an ocean whose sky is analytic, and reads as pasted on. Here the sun
// colour, the sky gradient and the water colour are literally the same nodes the
// sea is using, so when the sun moves or the sea changes colour the hull follows.
//
// Lighting is: a diffuse half — shadowed sun + sky ambient sampled in the normal
// direction + bounce off the water from below — and a specular half that is a
// metal BRDF, in ./metal.js.
// `sunShadow` is left at 1 by default. The hull is what casts into the shadow
// map, and a material cannot both write that map and sample it in the same pass;
// with nothing else in the scene to cast on her there is nothing to lose by it.
// `damage` is an optional node (usually a per-component uniform, 0..1). As it
// rises the paint blisters and chars: the base colour goes to soot in a ragged,
// hash-broken pattern rather than a flat tint, and the surface loses its gloss.
// It is the one hook every destructible part of a ship shares, so a hit can be
// shown on any component the same way before anything more elaborate exists.
// `metalness` is how much of this surface answers as steel rather than as the
// paint on it (0 = a dielectric coat, 1 = bare plate); `anisotropy` stretches
// its highlight along the run of the plating, and `dispersion` splits the sun's
// image in it slightly by wavelength. All three are scaled by a global uniform
// off `shading` so the whole ship can be dialled from the panel at once. See
// ./metal.js for what each one is actually doing.
// `destruction` is the damage field (battleship/damageField.js): a volume in
// the ship's own frame saying how much of the material at a point is gone, plus
// a short list of punctures too small for that volume to resolve. When it is
// supplied this material stops being able to be looked *at* and starts being
// able to be looked *through*.
// `interior` turns on the inward-facing half of the ship: the same program
// shades the liner meshes behind her plating, gated on a per-vertex `inside`
// flag, so seeing into a hole costs one more attribute rather than another
// program.
export function createBoatMaterial({
  shading, sunShadow = float(1), color = null, roughness = 0.5,
  planks = 0, weather = 0, grain = 0.04, plating = null,
  damage = null, waterlinePaint = null, glass = null, destruction = null, interior = false,
  metalness = 0, anisotropy = 0.6, dispersion = 0.1, metalColor = [0.56, 0.57, 0.58],
}) {
  const mat = new MeshBasicNodeMaterial();

  mat.colorNode = Fn(() => {
    // A var because a mapped surface bends it — see the planking below. Nothing
    // above that point reads it.
    const N = normalize(normalWorld).toVar();
    const V = normalize(cameraPosition.sub(positionWorld));
    // declared vec3 explicitly — TSL's vertexColor() is a vec4, which would
    // overflow the vec4() at the end of this function
    const base = (color === null ? attribute('color', 'vec3') : vec3(...color)).toVar();

    // --- battle damage: holes, tears and the metal round them -----------------
    //
    // Everything below is a *field*, not a property of this mesh. A crater is a
    // region of the ship's own frame with nothing left in it, so whatever passes
    // through that region — the side plating, the deck behind it, the scuttle
    // cut into it, the internal bulkhead two metres in — is discarded by the
    // same test, and none of them has to know about the others. That is the
    // whole reason this is a volume and not a per-component number.
    //
    // Note there is no `castShadowNode` to go with it. The renderer already
    // multiplies the shadow pass's alpha by this node's alpha (see
    // `_getShadowNodes`), which drags the discards below into the depth-only
    // program with it — so a hole stops casting a shadow for free, and the rest
    // of the shading is dropped there as dead code.
    const rimT = float(0).toVar();
    const scorchT = float(0).toVar();
    const heatT = float(0).toVar();
    // How far this fragment is inside the ship rather than on her outside. Baked
    // per-vertex so the liner meshes can share this program; see interior.js.
    const inside = (interior ? attribute('inside', 'float') : float(0)).toVar();

    if (destruction !== null) {
      const D = destruction;
      // Per-object, and *constant*: where this mesh's vertices land in the
      // ship's frame with every mount at rest. Constant is the entire point. A
      // turret that trains after being holed has to carry its hole round with
      // it, and a funnel lying across the quarterdeck has to keep the hits that
      // felled it — neither of which is true if the lookup uses the live world
      // transform.
      const fieldXform = uniform(new Matrix4()).onObjectUpdate(function (frame) {
        const m = frame.object.userData.fieldXform;
        if (m) this.value.copy(m); else this.value.identity();
      });
      // The plane a piece was torn off along: discard where dot(n, p) > d. A
      // zero normal means this object is whole.
      const cutPlane = uniform(new Vector4()).onObjectUpdate(function (frame) {
        const c = frame.object.userData.cutPlane;
        if (c) this.value.copy(c); else this.value.set(0, 0, 0, 0);
      });

      const fp = fieldXform.mul(vec4(positionLocal, 1)).xyz.toVar();

      // Two scales of tiling value noise, one fetch each. This is what turns
      // every edge below from a smooth analytic surface into torn steel, and it
      // has to be sampled at an explicit level: a filtered fetch inside
      // non-uniform control flow is illegal in WGSL, and there are no mips on
      // either of these textures to choose between anyway.
      const nA = texture3D(D.noise, fp.mul(1 / 3.1)).level(0).r;
      const nB = texture3D(D.noise, fp.mul(1 / 0.85).add(vec3(0.37, 0.11, 0.73))).level(0).r;
      const nz = nA.mul(0.6).add(nB.mul(0.4)).toVar();

      // 1. the tear a severed piece leaves. Both halves of a break read the
      // same plane with opposite signs and the same noise, so the stump and the
      // piece that fell off it interlock.
      If(dot(cutPlane.xyz, cutPlane.xyz).greaterThan(0.25), () => {
        // The wobble is a displacement of the *position*, not of the distance,
        // which matters: the stump and the piece that fell off it carry the
        // same plane with opposite signs, so a term added to the distance would
        // eat a gap between them that you could see daylight through. Displace
        // the point instead and the two tears interlock exactly.
        const sd = dot(cutPlane.xyz, fp.add(vec3(nz.sub(0.5).mul(1.15)))).sub(cutPlane.w);
        Discard(sd.greaterThan(0));
        // a break is bare metal for a metre back from the edge
        rimT.assign(saturate(sd.add(0.9).mul(1.1)));
      });

      // 2. craters, from the volume, and punctures, from the list. `active` is
      // zero until the first hit lands, so an undamaged ship pays for none of
      // the fetches below.
      If(D.active.greaterThan(0), () => {
        const uvw = fp.sub(D.origin).mul(D.invSize);
        const f = texture3D(D.volume, uvw).level(0);
        const rem = f.r.toVar();
        // A puncture is a sphere with a hard wall: the same 0.5-at-the-wall
        // convention as the volume, so the two just take a max of each other.
        Loop(D.punctureCount, ({ i }) => {
          const pnc = D.punctures.element(i);
          const d = length(fp.sub(pnc.xyz));
          rem.assign(max(rem, saturate(pnc.w.sub(d).div(pnc.w.mul(0.55)).add(0.5))));
        });
        // The threshold is where the hole actually ends, and moving it with the
        // noise is what makes the edge ragged rather than a smooth blob. Doing
        // it here rather than by perturbing the position keeps the two sides of
        // a plate agreeing on where the hole is.
        const thr = float(0.5).add(nz.sub(0.5).mul(0.30)).toVar();
        Discard(rem.greaterThan(thr));
        rimT.assign(max(rimT, smoothstep(thr.sub(0.26), thr, rem)));
        scorchT.assign(f.g);
        heatT.assign(f.b.mul(smoothstep(float(0.15), float(0.75), rem)));
      });
    }

    // --- waterline paint ------------------------------------------------------
    // Boot-topping is a painted line, not a fade. Baking it into vertex colours
    // makes it a fade whatever you do: the hull loft has a couple of dozen rings
    // around each section, so neighbouring vertices are metres apart in height
    // and the interpolator smears every band edge across that whole span. Paint
    // it in the fragment instead, from the hull-local height, with edges only as
    // soft as one pixel — which is a crisp line at any distance and does not
    // alias when the ship is far away.
    if (waterlinePaint !== null) {
      const wp = waterlinePaint;
      const y = positionLocal.y;
      const e = fwidth(y).mul(0.75).add(0.02); // one-pixel edge, never zero
      const toBoot = smoothstep(float(wp.bootLow).sub(e), float(wp.bootLow).add(e), y);
      const toGrey = smoothstep(float(wp.bootHigh).sub(e), float(wp.bootHigh).add(e), y);
      const paintCol = mix(mix(vec3(...wp.antifoul), vec3(...wp.boot), toBoot), vec3(...wp.topside), toGrey);
      // The scuttles used to be cut in here as well — three concentric circles
      // in the fragment, which is cheap and is on the hull's curve by
      // construction, but which can only ever be flat. They are modelled now,
      // in battleship/scuttles.js, so that the ones in the hull are the same
      // fitting as the ones on the deckhouses two metres above them.
      //
      // `paintMask` carries two flags in one float, because eight vertex
      // buffers is the WebGPU limit and this geometry uses all eight: bit 0 is
      // the hull plating that takes this paint — so one shared material can
      // paint a hull and leave a funnel alone — and bit 1 is rolled plate, read
      // by the plating section below.
      const mask = attribute('paintMask', 'float').toVar();
      const painted = mask.sub(floor(mask.mul(0.5)).mul(2));
      base.assign(mix(base, paintCol, painted.mul(fx.hullPaint.u)));
    }

    // Nothing here shades against the water any more.
    //
    // There used to be a local water plane at this point — height and slope
    // fitted to the buoyancy probes each frame — and the hull darkened below it
    // and picked up a band of clinging foam at it. It was never sound. A plane
    // is only a description of the sea between the probes, and the ends of a
    // 180 m ship are well outside them, so the slope term was extrapolated tens
    // of metres and put an imaginary waterline up the superstructure: a
    // hard-edged wedge that slid across her plating every time she pitched.
    // Fitting the plane better and clamping how far it reached shrank the
    // artefact but could not remove it, because the underlying quantity — one
    // flat plane standing in for a displaced, choppy surface — is wrong at
    // exactly the scale the effect is drawn at.
    //
    // What sells a hull sitting in water is the wash the *ocean* draws along her
    // waterline (see `contacts` in oceanSurfaceMaterial.js). That is computed
    // from the real displaced surface and the hull's own section curves, so it
    // follows the actual water, and it is enough on its own.

    // --- surface detail ---
    // A flat panel gives every fragment the same normal, and the Fresnel term is
    // near nothing head-on, so without this a deck or a wheelhouse roof shades to
    // one flat colour and reads as coloured paper rather than a surface.
    // Both of the patterns below are procedural and unfiltered, so both have to
    // be band-limited by hand. A texture lookup gets mipmapping for free; a
    // hash of a position does not, and the moment its features fall below a
    // pixel the undersampled result stops being detail and becomes a moire that
    // crawls across the surface as the object moves. `aaFade` measures the
    // feature size in pixels with a screen-space derivative and fades the
    // pattern out as it approaches one, which is the only honest thing to draw
    // there: a surface too far away to resolve its own grain is a flat surface.
    const aaFade = (coord, feature) => {
      const w = fwidth(coord).div(feature);
      return saturate(float(1.4).sub(w));
    };

    // The other way to fade detail: by distance to the eye, in metres.
    //
    // `aaFade` is the better measure where it works, but `fwidth` is a
    // derivative of a value interpolated across a triangle — near-constant
    // within one and discontinuous at every edge where the surface turns. On a
    // flat panel that is invisible; on the hull, which is a loft two metres to
    // a station and curving the whole way, each triangle gets its own fade and
    // the mesh itself appears on her side as a lattice of faint diagonal
    // creases. Distance is smooth everywhere. The cost is that the ranges are
    // metres tuned by eye rather than pixels measured, so they do not follow a
    // change of resolution.
    const eye = length(cameraPosition.sub(positionWorld)).toVar();
    const upTo = (near, far) => saturate(float(far).sub(eye).div(far - near));

    // TSL's `hash` converts its seed to a uint, and a negative float converted
    // to a uint is zero — so every seed to port of the centreline hashes to the
    // same number. On a deck that showed up as a hard line down the middle of
    // the ship with mismatched planking either side of it: one half varied, the
    // other flat. Bias the seed positive first. The offset is far larger than
    // any seed this file makes (the widest is the half-beam in plank widths,
    // about 100) and small enough to stay exact in a float32.
    const phash = (seed) => hash(float(seed).add(8192));

    // Blotches in three dimensions, hashed from the cell a fragment falls in.
    //
    // The thing to avoid here is hashing a *continuous* combination of the
    // coordinates. `hash(x*a + y*b + z*c)` looks like a 3D hash and is not: its
    // argument is constant across every plane perpendicular to (a, b, c), so
    // what it draws on a surface is a set of parallel stripes at whatever angle
    // that plane cuts it — and two of them multiplied together is a lattice of
    // diagonals lying across the ship at a fixed angle, which is what the
    // scorch used to do. Taking `floor` first is the whole fix: each cell gets
    // one value, neighbouring cells are unrelated, and the pattern has no
    // direction of its own.
    const cellNoise = (scale, k) => {
      const c = floor(positionLocal.mul(scale)).toVar();
      // wrapped into a small block so the seed stays exact in a float32 at any
      // point on a 180 m ship; the repeat is far too coarse to read as tiling
      const w = c.sub(floor(c.div(97)).mul(97));
      return phash(w.x.mul(k).add(w.y.mul(k * 37.1)).add(w.z.mul(k * 91.7)));
    };

    // --- planking -------------------------------------------------------------
    //
    // Laid planking, drawn rather than sampled.
    //
    // A scanned plank set was tried here and taken out again. It brought its own
    // scale and its own butt joints with it, and neither could be argued with:
    // the tile is a fixed number of boards wide, so the plank width and the
    // plank length are one number between them, and a map with a cross-beam
    // baked into its edge rules the deck into bricks however it is tiled or
    // staggered. What is wanted on a ship this size is a very fine, very even
    // grain, and that is the one thing three lines of arithmetic are better at
    // than a photograph of somebody's fence.
    if (planks > 0) {
      // laid fore-and-aft, so the run of the planking follows the hull
      const u = positionLocal.x.div(planks);
      const fade = aaFade(u, 1).mul(fx.hullGrain.u);
      const board = floor(u).toVar();
      const seam = abs(fract(u).sub(0.5)).mul(2);
      const groove = smoothstep(float(0.86), float(1), seam).mul(fade);

      // No butt joints. A plank is a finite length of timber and a real deck is
      // broken across by staggered joints, but a joint is only a few centimetres
      // long against a plank several metres long: at any distance where the deck
      // is worth looking at, that is a sub-pixel mark, and a sub-pixel dark mark
      // scattered over a surface does not read as a joint — it reads as dirt
      // speckled over the deck. The seams that survive resampling are the ones
      // that run continuously, so those are the only ones drawn.
      //
      // `weather` (0 = a new deck, 1 = a hard-worked one) drives everything that
      // makes laid timber look used rather than milled: blacker pitch in the
      // seams, boards that no longer match each other, and grime in patches
      // across the run of them. A clean deck is the default because a varnished
      // launch wants to stay a varnished launch.
      const wear = float(weather);

      // caulking in the seams, darker than any tone variation in the wood so the
      // lines read as pitch rather than as a pale board
      base.assign(base.mul(mix(float(1), mix(float(0.45), float(0.26), wear), groove)));
      // tone: each board is its own piece of timber, and the longer the deck has
      // been down the further apart those pieces have drifted
      const spread = mix(float(0.20), float(0.32), wear);
      base.assign(base.mul(mix(
        float(1), phash(board.mul(1.13)).mul(spread).add(float(1).sub(spread.mul(0.5))), fade,
      )));
      // grain: fibres running with the plank, a few across each board. Constant
      // along the length on purpose — that is what makes it read as the run of
      // the timber and not as noise sprinkled over a stripe.
      const fibre = u.mul(5);
      base.assign(base.mul(mix(
        float(1), phash(floor(fibre).mul(2.37)).mul(0.13).add(0.94),
        aaFade(fibre, 1).mul(fx.hullGrain.u),
      )));

      // Weathering, at a scale that has nothing to do with the planking.
      //
      // Dirt on a deck does not respect the boards: it is walked and washed
      // across a dozen of them at once. Everything above this point is per-board
      // or finer, and per-board dirt reads as a striped deck rather than a worn
      // one — so this is a separate, much coarser field.
      //
      // Two things keep it from reading as *patches*, which one octave of cell
      // noise always does however soft its edges are:
      //
      //   * Two scales, a broad one and a third of it at half the weight. One
      //     scale gives blotches of one size — the eye finds the cell grid
      //     immediately and the deck looks stained rather than worn. Summing
      //     octaves is what makes a natural surface: no size dominates.
      //   * It greys the timber more than it darkens it. Weathered teak goes
      //     silver-grey as the sun takes the oils out of it; multiplying the
      //     colour down instead just makes brown mud, and mud in blobs is
      //     exactly what "patchy" means.
      if (weather > 0) {
        // one octave of value noise: hash the cell corners, smoothstep between
        const octave = (scale, kx, kz) => {
          const p = positionLocal.mul(scale).toVar();
          const c = floor(p).toVar();
          const f = fract(p).toVar();
          const w = f.mul(f).mul(float(3).sub(f.mul(2)));
          const at = (dx, dz) => phash(c.x.add(dx).mul(kx).add(c.z.add(dz).mul(kz)));
          return mix(
            mix(at(0, 0), at(1, 0), w.x),
            mix(at(0, 1), at(1, 1), w.x),
            w.z,
          );
        };
        // ~6 m and ~2 m; the second is a third of the first, which is far enough
        // apart that neither reads as the scale of the pattern
        const worn = octave(0.17, 1.7, 31.3).mul(0.67)
          .add(octave(0.52, 5.1, 17.9).mul(0.33));
        const amount = wear.mul(0.34).mul(fx.hullGrain.u).mul(saturate(worn.mul(1.4).sub(0.2)));
        // sun-bleached grey, mixed toward rather than multiplied in, and a much
        // gentler darkening on top of it
        const bleached = vec3(0.60, 0.58, 0.55).mul(base.r.add(base.g).add(base.b).mul(0.55));
        base.assign(mix(base, bleached, amount));
        base.assign(base.mul(float(1).sub(amount.mul(0.28))));
      }
    }
    if (grain > 0) {
      // Fine break-up so large painted areas are not perfectly uniform.
      //
      // `cellNoise` handles both of the traps here: it hashes the *cell* rather
      // than a continuous combination of the coordinates, so the result is
      // grain rather than the stripes a plane equation draws, and it wraps the
      // seed into a small block first, so a position a hundred metres down the
      // ship still lands where float32 steps are finer than the distance
      // between neighbouring fragments. Multiplying a raw local position by a
      // few hundred is fine on a 16 m hull and returns garbage on a 180 m one.
      const q = positionLocal.mul(3.7); // ~27 cm features
      const g = cellNoise(3.7, 2.3);
      const amount = float(grain).mul(aaFade(q.x.add(q.y).add(q.z), 1)).mul(fx.hullGrain.u);
      base.assign(base.mul(float(1).sub(amount.mul(0.5)).add(g.mul(amount))));
    }

    // --- riveted plating --------------------------------------------------------
    //
    // What makes a surface read as a ship's side rather than as a grey box is
    // that it is *built* out of plates, and all three of the things that says
    // are shading, not colour — which is why this bends the normal and barely
    // touches the base colour at all. A painted-on rivet is a freckle; a rivet
    // is a thing the light runs over.
    //
    // Three terms, in the order you stop being able to see them as she gets
    // further away:
    //
    //   * Panting, or oil-canning. Plates are thin and welded or riveted to
    //     frames only at their edges, so every one of them bellies a little
    //     between them. Under a low sun that is a set of soft bands running the
    //     length of the hull, and it is by far the strongest cue at any distance
    //     where you can see the whole ship — a truly flat topside looks like
    //     sheet plastic, and no amount of rivet detail fixes that.
    //   * The seams themselves, a shadow line where one plate laps the next.
    //   * The rivets: heads along every seam, at about four diameters' pitch.
    //     These are 5 cm objects on a 180 m ship, so they are only ever visible
    //     from a boat's length away and are faded out well before they alias.
    //
    // Plate sizes are the real ones a yard could roll and handle: strakes a
    // couple of metres wide, plates six or so long, with the butts staggered
    // every other strake so the seams do not line up into a grid.
    //
    // Bit 1 of `paintMask` is the gate: set on anything made of rolled plate,
    // clear on anything turned, spun or drawn — a gun barrel, a mast, a
    // stanchion — which has no seam in it anywhere. See `paint()` in
    // battleship/shipMaterial.js, which reads it off the geometry type.
    if (plating !== null) {
      const P = plating;
      const flags = attribute('paintMask', 'float').toVar();
      const gate = floor(flags.mul(0.5)).mul(fx.hullPlating.u).toVar();
      const { T, B } = platingFrame(N); // T along the run of the strakes, B across

      // plate coordinates, in plates
      const sy = positionLocal.y.div(P.strake).toVar();
      // stagger the butts half a plate on every other strake
      const stag = fract(floor(sy).mul(0.5)).mul(P.butt);
      const sz = positionLocal.z.add(stag).div(P.butt).toVar();

      // q runs -1..1 across a plate, so |q| = 1 is a seam
      const qy = fract(sy).sub(0.5).mul(2).toVar();
      const qz = fract(sz).sub(0.5).mul(2).toVar();
      const sgn = (q) => step(float(0), q).mul(2).sub(1);
      // signed distance in metres from the nearest seam, negative on one side
      const offY = qy.sub(sgn(qy)).mul(P.strake * 0.5).toVar();
      const offZ = qz.sub(sgn(qz)).mul(P.butt * 0.5).toVar();

      // Each term fades on its own — the seams outlast the rivets by a long
      // way — and all three fade by distance rather than with `aaFade`, for the
      // reason given where `upTo` is defined: a derivative-based fade prints
      // the hull's own triangulation onto her side.
      const fadePlate = upTo(200, 420).mul(gate).toVar(); // 2 m features
      const fadeSeam = upTo(70, 150).mul(gate).toVar(); // 4 cm lines, but continuous
      const fadeRivet = upTo(16, 34).mul(gate).toVar(); // 5 cm domes: gone by a ship's length

      // 1. panting: a linear tilt across each plate, which is a shallow barrel.
      // It flips sign at the plate edge, and that discontinuity is hidden under
      // the seam that is drawn there anyway.
      const tiltB = qy.mul(P.dish).mul(fadePlate).toVar();
      const tiltT = qz.mul(P.dish * 0.5).mul(fadePlate).toVar();

      // 2. seams: a notch, so the normal tips toward the seam from both sides
      const notch = (off, half) => smoothstep(float(P.seam), float(0), abs(off))
        .mul(sgn(off).negate()).mul(half);
      tiltB.addAssign(notch(offY, float(P.lap)).mul(fadeSeam));
      tiltT.addAssign(notch(offZ, float(P.lap)).mul(fadeSeam));

      // 3. rivet heads, in a row down the middle of every seam. Distance is
      // measured in the surface: across the seam, and along it to the nearest
      // head. A dome's normal leans away from its centre, so the tilt is just
      // that offset, scaled.
      const head = (across, along) => {
        const d = vec2(across, along).div(P.head);
        const dome = smoothstep(float(1), float(0.2), length(d));
        return d.mul(dome).mul(P.proud);
      };
      const alongZ = fract(positionLocal.z.div(P.rivet)).sub(0.5).mul(P.rivet);
      const alongY = fract(positionLocal.y.div(P.rivet)).sub(0.5).mul(P.rivet);
      const rY = head(offY, alongZ).mul(fadeRivet);
      const rZ = head(offZ, alongY).mul(fadeRivet);
      tiltB.addAssign(rY.x.add(rZ.y));
      tiltT.addAssign(rY.y.add(rZ.x));

      N.assign(normalize(N.add(B.mul(tiltB)).add(T.mul(tiltT))));

      // and a trace of colour: paint gathers dirt in a seam and gets rubbed thin
      // over a rivet. Small — the shading above is what carries this.
      const line = smoothstep(float(P.seam), float(0), abs(offY))
        .max(smoothstep(float(P.seam), float(0), abs(offZ))).mul(fadeSeam);
      base.assign(base.mul(float(1).sub(line.mul(0.10))));
    }

    const gloss = float(1).sub(float(roughness)).toVar();
    if (damage !== null) {
      // Scorch creeps in from a noisy threshold, so at half damage half the
      // panel is black and the rest is heat-discoloured, not a uniform grey.
      //
      // Both octaves are cell noise, and both fade toward their own mean as
      // they stop being resolvable. That matters more here than anywhere else
      // in this file. Soot is a near-black mixed into the paint through a
      // hard-edged mask, so once the mask is finer than a pixel the hardware
      // averages black against grey and the whole section resolves to a flat
      // mid-grey wash that swims as the ship moves — which is exactly what
      // "shooting her turns her grey" was. Fading the noise to its mean makes
      // the far-away result the honest average of the near-up one instead.
      const n = mix(float(0.5), cellNoise(2.2, 1.7), upTo(110, 240)).toVar(); // ~45 cm
      const n2 = mix(float(0.5), cellNoise(7.0, 3.1), upTo(35, 85)).toVar(); // ~14 cm
      // Where the burn is comes from the field and *only* from the field. The
      // per-component number used to feed this as well — a part that had been
      // worked over went dirty all over — and it was wrong for the reason the
      // field was built in the first place: a shell lands in one place, and it
      // is that place that blackens. Sooting the whole deckhouse because
      // something hit a corner of it says the hit happened everywhere, and it
      // swamps the actual crater, which is the thing worth looking at.
      //
      // So the scorch is the field's own halo: a blast zone round a hit, of the
      // size the burst had, and unhit plating stays the colour it was painted.
      const dmg = scorchT.mul(fx.hullScorch.u).toVar();
      const scorch = smoothstep(float(0).sub(0.25), float(0.25), dmg.sub(n.mul(0.7).add(n2.mul(0.3))));
      const soot = vec3(0.05, 0.045, 0.04).mul(n2.mul(0.5).add(0.6));
      const heat = base.mul(vec3(0.55, 0.42, 0.34)); // browned paint short of charring
      base.assign(mix(base, mix(heat, soot, scorch), saturate(dmg.mul(1.6))));
      // What the per-component number is still allowed to do is take the shine
      // off. A part that has been hammered is dull and scuffed over all of it,
      // and that reads as wear without repainting it.
      gloss.assign(gloss.mul(float(1).sub(scorch.mul(0.85))).mul(float(1).sub(float(damage).mul(0.35))));
    }

    // --- the inside of her ------------------------------------------------------
    // The liner meshes (interior.js) carry `inside = 1` and are wound the other
    // way round, so they are the surfaces you see through a hole: frames and
    // stringers on bare, unpainted, unlit steel. It is the same program because
    // the alternative — a second material — is a second WGSL compile of this
    // graph, which is the one thing the ship is built around not doing.
    if (interior) {
      // frames every 1.2 m fore-and-aft, stringers every 1.1 m up: the shadow
      // lines are what give a dark space depth and scale
      const fr = abs(fract(positionLocal.z.div(1.2)).sub(0.5)).mul(2);
      const st = abs(fract(positionLocal.y.div(1.1)).sub(0.5)).mul(2);
      const ribs = smoothstep(float(0.72), float(0.95), max(fr, st));
      const raw = vec3(0.115, 0.112, 0.105).mul(float(1).sub(ribs.mul(0.45)));
      base.assign(mix(base, raw, inside));
      gloss.assign(mix(gloss, float(0.12), inside));
    }
    // --- direct sun, cut by the shadow map ---
    const ndl = saturate(dot(N, shading.sunDir));
    const sun = shading.sunColor.mul(ndl).mul(sunShadow).mul(1.15);

    // --- ambient: the analytic sky in the normal direction, plus light bounced
    // up off the water, which is what fills a hull's shaded side at sea ---
    //
    // Both are desaturated before they are used as fill. Sampling the sky in
    // one direction gives the colour of that patch of sky, but a diffuse
    // surface integrates the whole hemisphere — most of which is pale horizon,
    // not deep zenith blue — and then bounces light around the ship itself,
    // which greys it further. Feeding the raw sample in as the only fill is why
    // every panel facing away from the sun came out navy: a light grey turret
    // face lit by nothing but zenith blue *is* navy. The same argument applies
    // to the green water bounce.
    const grey = (c, amount) => mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), amount);
    const skyRaw = skyColor(normalize(vec3(N.x, max(N.y, -0.2), N.z)), shading, sunShadow);
    // Weighted toward the horizon colour: a hemisphere is mostly horizon by
    // solid angle, and the deep zenith blue that a straight directional sample
    // returns for an upward-tilted panel is a small part of what actually
    // reaches it. Take the sample too literally and every shaded panel is navy.
    // Skylight is not blocked by the shadow map — a surface in shade still sees
    // most of the sky — but a surface shadowed by structure directly overhead is
    // also enclosed by that structure, so take a little off. Without it a shadow
    // on a hull is a flat grey wash with no weight to it.
    // Both fills are switchable, and "off" means *flat* rather than *absent*:
    // the term keeps roughly the brightness it had and loses only its dependence
    // on the surface normal. Deleting the fill outright would just black out
    // every shaded panel, which tells you nothing about a moving artefact; what
    // you want to know is whether the thing crawling across her plating is
    // coming from the normal being fed into these samples.
    const shadeAmb = sunShadow.mul(0.28).add(0.72);
    const skyDir = grey(mix(shading.horizon, skyRaw, 0.35), 0.55);
    const skyFlat = grey(shading.horizon, 0.55);
    const sky = mix(skyFlat, skyDir, fx.hullSkyFill.u).mul(0.78).mul(shadeAmb);
    const bounceCol = grey(mix(shading.deepColor, shading.scatterColor, 0.35), 0.5);
    const bounce = bounceCol
      .mul(mix(float(0.2), saturate(N.y.negate()).mul(0.45).add(0.12), fx.hullBounce.u))
      .mul(shadeAmb);

    // ======================= how this surface answers light ====================
    //
    // Two numbers decide it. `rough` is what the blocks above have left of the
    // gloss the part was painted with — scorch dulls it. `metal` is how much of
    // what you are looking at is steel rather than the paint on it.
    //
    // A warship's side is a thin coat over plate, so neither reading is right on
    // its own: the coat scatters light diffusely and carries the colour, the
    // plate underneath reflects specularly and carries the *metal*. Blending
    // between the two is the standard metalness approximation, and the part that
    // has to be right is the reflectance it blends toward. Deriving it from the
    // base colour alone — the usual shortcut — gives a mid-grey hull an F0 of
    // 0.3, which is not a metal that exists and is why grey ships rendered this
    // way look like grey plastic. Keeping most of steel's own 0.56-0.58 and
    // letting the paint only tint it means the hull reflects like steel while a
    // red-lead bottom still comes back warm.
    //
    // The other half of the blend is the one people forget: a metal has no
    // diffuse lobe at all. Its free electrons absorb whatever is not reflected,
    // so as `metal` rises the body colour has to *go away* and be replaced by
    // what the surface is reflecting. A hull that is both fully lit in its own
    // paint colour and mirroring the sky reads as neither.
    const rough = saturate(float(1).sub(gloss)).max(0.045).toVar();
    const metal = saturate(float(metalness).mul(shading.metalness ?? float(1))).toVar();

    // --- the torn edge of a hole ------------------------------------------------
    // A shell does not cut plate, it tears it, and what is exposed at the tear
    // is the one surface on the ship with no paint on it at all: bright, rough,
    // fully metallic, curled back on itself. It is a narrow band and it is the
    // single thing that says "hole" rather than "dark patch" — without it a
    // discarded region reads as a decal.
    if (destruction !== null) {
      const torn = rimT.mul(fx.hullScorch.u).toVar();
      base.assign(mix(base, vec3(0.255, 0.250, 0.245), torn));
      rough.assign(mix(rough, float(0.68), torn));
      metal.assign(mix(metal, float(1.0), torn));
    }
    if (interior) {
      // nothing inside her is polished, and nothing inside her is painted
      metal.assign(mix(metal, float(0.35), inside));
    }

    const alpha = rough.mul(rough).toVar();
    const specTint = mix(base, vec3(...metalColor), 0.7);
    const F0 = mix(vec3(0.04), specTint, metal).toVar();
    const albedo = base.mul(float(1).sub(metal)).toVar();

    // Inside the hull there is no sun and very little sky: what light there is
    // came in through the hole you are looking through. Scaling the terms rather
    // than replacing them keeps this on one program, and keeps an interior
    // shading the same colour of daylight as the plating round the hole.
    const litSun = interior ? sun.mul(float(1).sub(inside.mul(0.94))) : sun;
    const litSky = interior ? sky.mul(float(1).sub(inside.mul(0.55))) : sky;
    const lit = albedo.mul(litSun.add(litSky).add(bounce)).toVar();

    // Rolled plate is scratched along the direction it was rolled, and on a ship
    // that is fore-and-aft. Only the steel is: paint has no grain, so the
    // anisotropy fades out with the metalness.
    const aniso = saturate(float(anisotropy).mul(shading.anisotropy ?? float(1)))
      .mul(metal).mul(fx.hullAniso.u).toVar();
    const { T, B } = platingFrame(N);
    const NoV = saturate(dot(N, V)).add(1e-4).toVar();
    const dfg = envDFG(NoV, rough).toVar();
    // Rough metal scatters light between its own microfacets several times
    // before releasing it, and a single-scatter lobe drops all but the first
    // bounce. Since every bounce off steel is a near-total reflection, dropping
    // them is what turns rough metal into grey felt. Both specular terms are
    // scaled by the same compensation, because both lost the same energy.
    const comp = energyCompensation(F0, dfg.x).toVar();

    // --- specular from the sky ------------------------------------------------
    //
    // Replaces a Fresnel lerp toward the mirror sample that had to be multiplied
    // by gloss squared to stop every near-vertical panel becoming a sheet of
    // zenith blue. That fudge is gone: the split-sum DFG term below is what the
    // roughness spreading actually does to the reflection, and a rough surface
    // gets a dim wide one from it for the right reason instead of an arbitrary
    // one. Two roughness effects on top of it, both of which the mirror sample
    // cannot express — the reflected direction is bent along the plating grain
    // so the sky smears the same way the sun does, and the sample itself is
    // dragged toward the horizon colour, since a wide cone of *this* sky is
    // mostly pale horizon rather than the deep blue the mirror ray happens to
    // hit. Between them they stand in for a prefiltered environment map, which
    // there is nothing to build here: the sky is a function, not a texture.
    const Rw = anisoReflectDir(N, V, T, B, aniso, rough);
    const reflRaw = skyColor(normalize(vec3(Rw.x, max(Rw.y, 0.02), Rw.z)), shading, sunShadow);
    // How hard to blur is the whole difficulty of this term, and it is bounded on
    // both sides.
    //
    // Blur it as hard as the diffuse fill above is blurred and the reflection
    // collapses to a constant: a near-uniform wash added to every panel, which
    // takes the shape straight back out of the hull and leaves it reading as grey
    // paper — while claiming to be the term that makes it metal. Blur it by
    // roughness squared, which is what the cone width nominally says, and the
    // opposite happens: a turret roof is horizontal, so its cone points at the
    // zenith, and this sky's zenith is a saturated blue. The roofs come out navy.
    //
    // Between them, and closer to the second, because a GGX lobe is not a cone.
    // It has long tails, and on a horizontal surface those tails reach a long way
    // down a sky that is pale near the horizon — so the honest prefiltered value
    // for rolled steel is a good deal less blue than the mirror ray. The light
    // desaturation is the same argument once more: what comes back off a rough
    // surface has bounced around in it, and bouncing takes the edge off a colour.
    const refl = grey(mix(reflRaw, shading.horizon, saturate(rough.mul(0.7))), rough.mul(0.35));
    lit.addAssign(refl
      .mul(F0.mul(dfg.x).add(dfg.y))
      .mul(comp).mul(shadeAmb).mul(fx.hullFresnel.u)
      // a compartment does not reflect the sky; it has not got one
      .mul(interior ? float(1).sub(inside.mul(0.92)) : float(1)));

    // --- specular from the sun ------------------------------------------------
    //
    // Anisotropic GGX with the sun treated as the disc it is, evaluated at three
    // slightly different lobe widths so the highlight disperses. The old term
    // here was a Blinn-Phong exponent capped low on purpose, because on a hull
    // that is one long smooth curve a tight mirror lobe degenerates to a razor
    // line sliding along her as she rolls. That is still true of an isotropic
    // lobe — but it is the wrong fix. A stretched lobe *should* run along the
    // ship; what made the old one read as a drawn line rather than as light on
    // steel is that it was infinitely thin across, and this one is not, because
    // the sun subtends half a degree and the grain spreads it further.
    lit.addAssign(ggxSpecular({
      N, V, L: shading.sunDir, T, B, alpha, aniso, F0, rough,
      dispersion: float(dispersion).mul(shading.dispersion ?? float(1)).mul(fx.hullDispersion.u),
    }).mul(shading.sunColor).mul(comp).mul(sunShadow).mul(fx.hullSpecular.u)
      .mul(interior ? float(1).sub(inside) : float(1)));

    // --- glass ----------------------------------------------------------------
    // A window band is not one pane. What makes it read as windows is the
    // division: mullions between panes, a frame top and bottom, and — the part
    // that really sells it — each compartment lit differently, because a ship
    // is full of separate rooms and some of them are dark. One uniform strip of
    // glow reads as a light-up toy; a row of panes at different brightnesses,
    // with a couple unlit, reads as a ship with people in it.
    if (glass !== null) {
      // Run the pane pattern along whichever way the wall faces: a band around a
      // deckhouse has front, back and side faces, and each wants its panes laid
      // out along its own length.
      const sideFace = step(float(0.5), abs(normalLocal.x));
      const u = mix(positionLocal.x, positionLocal.z, sideFace);
      const pw = float(glass.paneWidth);
      const pu = u.div(pw);
      const paneId = floor(pu);
      const inPane = fract(pu);

      // mullions between panes, and the frame at top and bottom of the band
      const mull = fwidth(pu).mul(1.2).add(glass.mullion);
      const vBar = smoothstep(mull, mull.mul(0.2), min(inPane, float(1).sub(inPane)));
      const hy = positionLocal.y.div(float(glass.bandHalfHeight));
      const hBar = smoothstep(float(0.55), float(0.95), abs(hy));
      const frame = saturate(float(1).sub(vBar)).max(hBar);

      // reflection: smeared, because ship's windows are neither flat nor clean
      const R2 = reflect(V.negate(), N);
      const j = hash(paneId.mul(37.1).add(positionLocal.y.mul(5.3)));
      const j2 = hash(paneId.mul(91.7).add(11.3));
      const blur = float(glass.blur);
      const Rj = normalize(vec3(
        R2.x.add(j.sub(0.5).mul(blur)),
        max(R2.y.add(j.mul(j2).sub(0.25).mul(blur)), 0.02),
        R2.z.add(j2.sub(0.5).mul(blur)),
      ));
      const skyR = skyColor(Rj, shading, sunShadow);
      const fres2 = float(0.06).add(float(0.94).mul(pow(float(1).sub(saturate(dot(N, V))), 4)));

      // The room behind. `lit` is per-pane: most compartments are burning a
      // light, some are not. Brightness is pushed hard at night, when the
      // windows stop being a reflection with a hint behind them and become the
      // brightest thing on the ship.
      const lampOn = step(float(0.22), j2); // a few panes dark
      const roomLevel = float(0.45).add(j.mul(0.55));
      const night = shading.night;
      const room = vec3(...glass.lamp)
        .mul(roomLevel).mul(lampOn)
        .mul(float(0.5).add(night.mul(3.2)));
      // by day the pane is mostly reflection; at night it is mostly the room
      const mixR = saturate(fres2.mul(0.8).add(0.34)).mul(float(1).sub(night.mul(0.72)));
      const pane = mix(vec3(...glass.tint).add(room), skyR, mixR);

      // the frame is painted steel, not glass — shade it like the rest of the ship
      lit.assign(mix(pane, lit.mul(0.85), frame));
    }

    // --- still hot ---------------------------------------------------------
    // Steel torn open by a burst glows for a while, and it is the only light
    // this ship emits. Squared, because the visible part of that cooling is the
    // top of the curve and the tail should go quickly; and confined to the tear
    // itself, so a burn mark does not light up.
    if (destruction !== null) {
      const glow = heatT.mul(heatT).mul(saturate(rimT.mul(1.6).add(0.15))).toVar();
      lit.addAssign(vec3(1.35, 0.42, 0.09).mul(glow).mul(fx.hullScorch.u));
    }

    return vec4(lit, 1);
  })();

  return mat;
}

// The deck ribbon is a single flat sheet, so it needs to be lit from both sides
// when she heels far enough to show its underside.
export function createDeckMaterial(opts) {
  const mat = createBoatMaterial(opts);
  mat.side = DoubleSide;
  return mat;
}
