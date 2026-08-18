import { MeshBasicNodeMaterial, DoubleSide, Matrix4, Vector4 } from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, normalize, dot, max, saturate, pow, mix, reflect, abs,
  smoothstep, cameraPosition, positionWorld, positionLocal, normalWorld, attribute,
  fract, floor, hash, fwidth, normalLocal, step, min, length, inverseSqrt, sqrt,
  uniform, texture3D, Loop, If, Discard,
} from 'three/tsl';
import { skyColor } from '../ocean/sky.js';
import { handLight } from '../scene/torch.js';
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
  // How thick the plating reads — how far off its own surface the backing has
  // to look to find the edge of the hole it is showing through. Passed in
  // rather than imported: this material is the launch's as well as the ship's,
  // and it has no business knowing about the battleship's hull module.
  platingDepth = 0.7,
  // The colour of the room behind a lit scuttle. See the lamp section below;
  // which scuttles are lit and how brightly is carried in the geometry.
  scuttleLamp = null,
  // The other lamp colour. Which of the two a pane burns is one bit of its
  // paintMask, so a red battle light and a warm cabin light share one program
  // and one term.
  battleLamp = null,
  // and the third: the tungsten yellow over a turret door
  doorLamp = null,
  // { count, pos, col } — the emitter rig that throws light back onto her. See
  // `lamps` in battleship/shipMaterial.js for how it is filled.
  lamps = null,
  // { count, on, pos, col } — the same again for her guns, which are lights for
  // a tenth of a second at a time. See the block at the foot of the shader.
  flashes = null,
  // { on, pos, dir, col } — the lights a man carries: the torch clamped under a
  // rifle's handguard and the flash at its muzzle. Same frame as the two rigs
  // above. See scene/torch.js.
  torch = null,
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
    // And whether this fragment is a surface of a room somebody stands in, which
    // decides whether her lamps land on it flat or through its own colour. Bit 8
    // of `paintMask` — see the note there for why it is a bit and not a ninth
    // vertex attribute — and the lamp block at the foot of this file for what it
    // does.
    const roomLit = (() => {
      if (!interior) return float(0).toVar();
      const m = attribute('paintMask', 'float');
      return floor(m.div(256)).sub(floor(m.div(512)).mul(2)).toVar();
    })();

    // Per-object, and *constant*: where this mesh's vertices land in the ship's
    // frame with every mount at rest. Constant is the entire point. A turret
    // that trains after being holed has to carry its hole round with it, and a
    // funnel lying across the quarterdeck has to keep the hits that felled it —
    // neither of which is true if the lookup uses the live world transform.
    //
    // Two things want it: the damage field, and the lamps. Both are volumes
    // written in her frame rather than properties of any mesh, so both need the
    // same answer to the same question — where in the ship am I? — and asking it
    // twice would be two matrices and two multiplies for one number.
    const shipXform = (destruction !== null || lamps !== null || flashes !== null || torch !== null)
      ? uniform(new Matrix4()).onObjectUpdate(function (frame) {
        const m = frame.object.userData.fieldXform;
        if (m) this.value.copy(m); else this.value.identity();
      })
      : null;

    if (destruction !== null) {
      const D = destruction;
      const fieldXform = shipXform;
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
        //
        // The backing is exempt, and that exemption is what makes a wound a
        // chip rather than a way in. It is one surface a plating's thickness
        // behind her skin (see PLATING in hull.js) and it is the floor of every
        // hole — so it cannot itself be part of any hole, at any size, at any
        // depth, however many bursts have overlapped there. Left subject to the
        // same test it went with the plating in front of it, and what you then
        // saw through a big enough hole was the *far* side of her curving away
        // in the dark: a ship with a room in it rather than a piece of armour
        // with a chip out of it. Pushing the threshold out of reach for these
        // fragments costs one multiply-add and is unconditional, which a tuned
        // crater depth could never be.
        const thr = float(0.5).add(nz.sub(0.5).mul(0.30)).add(inside.mul(10)).toVar();
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
      // `paintMask` carries three fields in one float, because eight vertex
      // buffers is the WebGPU limit and this geometry uses all eight: bit 0 is
      // the hull plating that takes this paint — so one shared material can
      // paint a hull and leave a funnel alone — bit 1 is rolled plate, read by
      // the plating section below, and everything from 4 up is a four-bit lamp
      // level, read by the scuttle section. Packing rather than adding a ninth
      // attribute is not squeamishness: a ninth does not fail at the draw call
      // with something legible, it fails as an invalid render pipeline and the
      // ship disappears.
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
      // bit 1, extracted rather than shifted-and-truncated: the lamp level lives
      // in the bits above this one, so `floor(flags / 2)` on its own would come
      // back as 2 or 3 on a lit scuttle and multiply the seams up with it.
      const gate = floor(flags.mul(0.5)).sub(floor(flags.mul(0.25)).mul(2))
        .mul(fx.hullPlating.u).toVar();
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
      // 2.2 rather than 1.6: the outer ring of a burn should still be plainly
      // discoloured paint rather than fading out before it gets there.
      base.assign(mix(base, mix(heat, soot, scorch), saturate(dmg.mul(2.2))));
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
      // This is the floor of a chip, and it has to look like one.
      //
      // It was shaded as the inside of a ship — bare steel in an unlit space,
      // which argues for very dark, and came out flat black. Every complaint
      // about the damage since has been the same complaint: a hole with black
      // in it does not read as a cavity in a piece of armour, it reads as a way
      // into a building, and no amount of making the cavity shallower fixes
      // that while the bottom of it is a void.
      //
      // So it is not an interior at all. It is the freshly torn face of her own
      // plating a hand's breadth down — the same bare, bright, unpainted steel
      // the rim of every hole is already shaded as — sitting in a shallow recess
      // and therefore a little shadowed, and nothing more. The frames read as
      // faint relief across it rather than as decks.
      const raw = vec3(0.20, 0.196, 0.185).mul(float(1).sub(ribs.mul(0.42)));
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
    // Starlight, and the moon when there is one.
    //
    // The two fills above are both the sky, and after dark the sky is nearly
    // black — so every surface on the ship fell to within a couple of counts of
    // zero and the deck stopped being a deck. That matters more than it sounds:
    // the plank seams are the one thing on her that says how big she is, and a
    // teak deck you cannot read the planks of is a dark floor.
    //
    // So there is a floor under the ambient at night, and it is cool on purpose.
    // The lamps are the warm light and they are local; this is the light that is
    // simply *around*, and if it were neutral the ship would read as underlit
    // daylight rather than as night. Small enough that the lit windows are still
    // far and away the brightest thing aboard.
    const nightFill = vec3(0.105, 0.125, 0.170).mul(shading.night);
    const sky = mix(skyFlat, skyDir, fx.hullSkyFill.u).mul(0.78).mul(shadeAmb)
      .add(nightFill);
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

    // The floor of a chip is a hand's breadth down and open to the sky, so it is
    // lit — a little shadowed by the lip standing over it, not cut off from the
    // day. It used to be cut by nine tenths on the argument that there is no sun
    // inside a ship, which was answering the wrong question: this is not inside
    // her, it is a shallow scoop out of her outside.
    //
    // The flat fill underneath matters as much as the cut. Every directional
    // term here is multiplied by the surface normal one way or another, and a
    // recess faces every which way, so without a term that does not care about
    // the normal there is always some facet of it that comes out black — and one
    // black facet is all it takes to read as a hole again.
    const litSun = interior ? sun.mul(float(1).sub(inside.mul(0.90))) : sun;
    const litSky = interior ? sky.mul(float(1).sub(inside.mul(0.35))) : sky;
    const fill = interior
      ? grey(shading.horizon, 0.7).mul(inside.mul(0.30))
      : vec3(0);
    const lit = albedo.mul(litSun.add(litSky).add(bounce).add(fill)).toVar();

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

      // Mullions between panes, and the frame at top and bottom of the band.
      //
      // `inPane` runs 0..1 across a pane, so min(inPane, 1 - inPane) is the
      // distance to the nearest mullion: zero *on* the bar and 0.5 in the middle
      // of the glass. The smoothstep runs backwards — its edges are (mull,
      // 0.2 mull) — so `vBar` is already 1 on the bar and 0 on the glass, and
      // `frame` is that, not its complement. It was written as `1 - vBar`, which
      // inverted the whole band: the panes were shaded as painted steel and the
      // mullions between them got the lit room behind, so at night the ship
      // showed rows of glowing vertical bars with dark glass between.
      const mull = fwidth(pu).mul(1.2).add(glass.mullion);
      const vBar = smoothstep(mull, mull.mul(0.2), min(inPane, float(1).sub(inPane)));
      const hy = positionLocal.y.div(float(glass.bandHalfHeight));
      const hBar = smoothstep(float(0.55), float(0.95), abs(hy));
      const frame = saturate(vBar).max(hBar);

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

    // --- lit scuttles ---------------------------------------------------------
    //
    // The round windows down the deckhouses have rooms behind them too, and at
    // night they should say so — the same warm light the bridge windows carry,
    // in the same places for the same reason. The ones cut in the hull are left
    // dark: those are the messdecks, they are a deck below the weather deck, and
    // a battleship at sea does not show a light out of her side.
    //
    // The level comes out of `paintMask`, four bits of it above the two flags —
    // so which scuttle is burning a light and how brightly is decided once, in
    // the geometry, and each one keeps its own answer. That matters more than it
    // sounds: derive it here from a hash of the fragment's position instead and
    // you cannot quantise finely enough to give one disc one value without
    // splitting some other disc in half, and a porthole lit down one side is
    // worse than no porthole lit at all.
    if (scuttleLamp !== null) {
      const lampFlags = attribute('paintMask', 'float').toVar();
      // four bits of level, then one bit saying which colour is in the holder
      const level = floor(lampFlags.mul(0.25)).sub(floor(lampFlags.div(64)).mul(16)).div(15);
      // two bits of colour above the level: 0 warm, 1 red, 2 white
      const red = floor(lampFlags.div(64)).sub(floor(lampFlags.div(128)).mul(2));
      const white = floor(lampFlags.div(128)).sub(floor(lampFlags.div(256)).mul(2));
      let lampCol = vec3(...scuttleLamp);
      if (battleLamp !== null) lampCol = mix(lampCol, vec3(...battleLamp), red);
      if (doorLamp !== null) lampCol = mix(lampCol, vec3(...doorLamp), white);
      const night = shading.night;
      lit.addAssign(lampCol
        .mul(level)
        .mul(float(0.04).add(night.mul(2.1))));
    }

    // --- what the lamps land on -------------------------------------------------
    //
    // A lit window is only half of a lit window. The other half is the patch of
    // bulkhead beside it, the rail in front of it and the strip of deck under it,
    // and without that the ship at night is a black silhouette with glowing
    // stickers on it — every light reads as painted on, because nothing anywhere
    // agrees that it is there.
    //
    // There are no scene lights to do this. The whole ship is one hand-written
    // node material with a sun, a sky and nothing else, so the lamps are put in
    // by hand: a short list of emitters in her own frame, each a position, a
    // reach and a colour, evaluated per fragment. They are *rig*, not geometry —
    // one emitter stands for a whole run of scuttles or a whole window band,
    // because what matters at this range is that the light comes from about
    // there, not that it comes from each pane.
    //
    // Costed like a rig, too. The loop is unrolled at graph-build time, it runs
    // over every fragment of the hull, the deck and every deckhouse, and it is
    // gated on `night` so it costs nothing in daylight — which is most of the
    // time, and is when the frame is already busiest.
    if (lamps !== null) {
      const night = shading.night;
      const spill = vec3(0).toVar();
      // How much of her lamplight reaches this point at all. One fetch of a grid
      // baked in her own frame (lampVolume.js), and the reason it is a fetch
      // rather than eight shadow maps is that nothing involved moves relative to
      // anything else involved — the lamps are bolted to her, the cargo is
      // lashed to her deck, and the whole assembly turns as one body.
      //
      // It multiplies the whole spill rather than being applied per lamp, which
      // is the one approximation in it: two lamps overlapping, one blocked, get
      // the weighted average instead of a clean cut. Worth knowing about; not
      // worth eight volumes on a ship whose lamps are twenty metres apart.
      const vis = float(1).toVar();
      If(night.greaterThan(0.004), () => {
        const shipP = shipXform.mul(vec4(positionLocal, 1)).xyz.toVar();
        // the surface normal in her frame. Rotation only — w = 0 drops the
        // translation — and renormalised, because nothing promises the transform
        // has no scale in it.
        const shipN = normalize(shipXform.mul(vec4(normalLocal, 0)).xyz).toVar();
        if (lamps.volume) {
          vis.assign(texture3D(
            lamps.volume,
            shipP.sub(lamps.volumeOrigin).mul(lamps.volumeInvSize),
          ).level(0).r);
        }
        // One lamp, added to `spill` if it reaches this fragment at all.
        //
        // --- why the reach test is a branch and not a multiply ------------------
        //
        // A lamp past its reach contributes exactly zero: `fall` saturates to 0
        // and the cube of 0 is 0. So the arithmetic below was always *correct*
        // for a lamp on the other end of the ship — it was just being done, in
        // full, on every fragment, for every lamp, to arrive at nothing. Twenty
        // lamps unrolled over a ship that fills the screen, and at any one point
        // on her one or two of them are lit and the rest are tens of metres away.
        //
        // Branching on it is exact rather than approximate — the skipped term is
        // zero, not nearly zero — and it is cheap in the way that matters on a
        // GPU: lamps are local to the thing they are bolted to, so neighbouring
        // fragments agree about which lamps are near them and the whole warp
        // takes the same side of the test.
        //
        // The test itself avoids the square root: inside the reach means
        // (dist/reach)^2 < 1, and `P.w` already holds 1/reach — see `write` in
        // shipMaterial.js — so it is two multiplies and a compare.
        const oneLamp = (i, scale = null) => {
          const P = lamps.pos.element(i);
          const toL = P.xyz.sub(shipP).toVar();
          const d2 = dot(toL, toL).toVar();
          const k = d2.mul(P.w).mul(P.w).toVar(); // (dist / reach)^2
          If(k.lessThan(1), () => {
            // Inverse-square is the honest falloff and the wrong one here: it has
            // no end, so every lamp lights every fragment a little and the far
            // side of the ship comes up in a wash. A reach that actually reaches
            // zero is what keeps a lamp local to the thing it is standing on.
            //
            // No `saturate`: inside the branch k is in [0, 1), so `fall` is
            // already in (0, 1].
            const fall = float(1).sub(sqrt(k)).toVar();
            // Cubed, not squared. The square reaches too far too strongly: a lamp
            // inside a house lit every plate of the tower it was in, which put the
            // whole pagoda up as one warm mass and lost the thing the light was
            // there to show — that this level has people in it and the one above
            // does not. The cube keeps a bright core and a short tail, which is
            // what a cabin light on a bulkhead actually looks like.
            const drop = fall.mul(fall).mul(fall);
            // Wrapped Lambert, but only just. A surface turned away from a light
            // is not black — there is no bounce pass here to say what it does
            // catch — but the floor has to stay small, because a lamp in the
            // middle of a deckhouse is surrounded by faces pointing away from it
            // and every one of them gets the floor.
            const invD = inverseSqrt(max(d2, float(1e-8)));
            const wrap = saturate(dot(shipN, toL.mul(invD))).mul(0.88).add(0.12);
            const c = lamps.col.element(i).mul(drop).mul(wrap);
            spill.addAssign(scale === null ? c : c.mul(scale));
          });
        };

        // --- the lamps out in the weather ---------------------------------------
        //
        // Nothing shuts these in, so there is no box to test and no slot in the
        // array that is not a lamp: `layout.open` is how many there actually are.
        // See the note on `layout` in shipMaterial.js for why the rig is sorted.
        const L = lamps.layout;
        for (let i = 0; i < L.open; i++) oneLamp(i);

        // --- and the ones shut in a room ----------------------------------------
        //
        // The red battle lights inside the turrets. The shadow volume cannot help
        // them: that grid is half a metre to a side and a gunhouse wall is two
        // hundred millimetres, so the trilinear fetch that makes its shadows soft
        // carries "lit" straight through the plating and the red comes out on the
        // *outside* of the bandstand as a glow on the paint. A light sealed in a
        // steel room does not want a soft edge, it wants the wall. This is the
        // wall.
        //
        // The box is tested once for the room and not once for each lamp in it,
        // and — this is the part that matters for the frame rate — the lamps
        // inside it are not evaluated at all unless the fragment is in the room.
        // Twelve of the twenty lamps on this ship are in one of four gunhouses,
        // and every fragment of her hull, her masts and her upperworks was
        // evaluating all twelve before multiplying them by zero.
        for (const room of L.rooms) {
          const H = lamps.roomHalf.element(room.slot);
          const C = lamps.pos.element(room.from); // the room's centre, in her frame
          // How far inside the box this fragment is, along whichever axis it is
          // nearest the wall on. Negative outside, and the whole room is skipped.
          const edge = min(
            min(H.x.sub(abs(shipP.x)), H.y.sub(abs(shipP.y.sub(C.y)))),
            H.z.sub(abs(shipP.z.sub(C.z))),
          ).toVar();
          If(edge.greaterThan(0), () => {
            // The edge is just soft enough not to alias — a sixth of a metre —
            // and outside it the lamp contributes exactly nothing, which is what
            // being inside a turret means.
            const soft = saturate(edge.mul(6)).toVar();
            for (let i = room.from; i < room.to; i++) oneLamp(i, soft);
          });
        }
      });
      // Flat on her outside, through the surface's own colour inside a room.
      //
      // The multiplier is `base` rather than `albedo`: albedo is the colour with
      // the metalness taken out of it, and every plate on this ship is most of
      // the way to bare steel, so lighting a compartment by albedo lights it at a
      // third of what it should be and takes the brass and the teak down with the
      // grey. What a lamp in a room lands on is the paint, and `base` is the
      // paint. The gain is what puts a mid grey bulkhead back at about the
      // brightness the flat term used to give it, so a room comes out lit rather
      // than merely tinted.
      lit.addAssign(spill.mul(mix(vec3(1), base.mul(1.5), roomLit)).mul(vis).mul(night));
    }

    // --- and when a gun goes off ------------------------------------------------
    //
    // A muzzle flash is a lamp, and it is a lamp that breaks every rule the ones
    // above are written to: it lasts a tenth of a second, it is somewhere new
    // each time, it is a hundred times brighter than everything else on the ship
    // together, and it is plainly visible in daylight — so it is neither gated on
    // night nor multiplied by the baked shadow volume, which was baked for lights
    // that are bolted to her and knows nothing about a gun.
    //
    // Every fragment of the ship pays for it, which is why the whole thing sits
    // inside one branch on a scalar that is zero except in the tenth of a second
    // after a salvo. Nothing is firing on almost every frame of the game, and on
    // those frames this block is a compare.
    //
    // One approximation, worth naming: `shipXform` is the *rest* pose — see the
    // note where it is built — so a trained turret's own plating is lit as though
    // it were still fore-and-aft. On the deck, the hull and the upperworks, which
    // is where you actually watch a flash land, it is exact; on the gunhouse the
    // flash is going off two metres away and is white anyway.
    if (flashes !== null) {
      If(flashes.on.greaterThan(0), () => {
        const shipP = shipXform.mul(vec4(positionLocal, 1)).xyz.toVar();
        const shipN = normalize(shipXform.mul(vec4(normalLocal, 0)).xyz).toVar();
        const blast = vec3(0).toVar();
        for (let i = 0; i < flashes.count; i++) {
          const P = flashes.pos.element(i);
          const toL = P.xyz.sub(shipP).toVar();
          const d2 = dot(toL, toL).toVar();
          const k = d2.mul(P.w).mul(P.w).toVar(); // (dist / reach)^2
          If(k.lessThan(1), () => {
            // Squared rather than cubed, unlike the lamps: a cabin light wants a
            // bright core and a short tail, and a muzzle flash wants to reach the
            // far end of the forecastle — because it does.
            const fall = float(1).sub(sqrt(k)).toVar();
            const drop = fall.mul(fall);
            const invD = inverseSqrt(max(d2, float(1e-8)));
            // A high floor on the wrap: this much light in the open air bounces
            // off the deck and the sea and comes back at everything, and a face
            // turned away from a gun going off next to it is not black.
            const wrap = saturate(dot(shipN, toL.mul(invD))).mul(0.68).add(0.32);
            blast.addAssign(flashes.col.element(i).mul(drop).mul(wrap));
          });
        }
        lit.addAssign(blast);
      });
    }

    // --- and the two lights that walk about -------------------------------------
    //
    // A torch under a rifle, and the flash at its muzzle. Same frame as the guns
    // and the lamps, same argument for the branch — for the great majority of
    // the game neither is burning, and on those frames this is a compare — but a
    // different shape of light: they have an axis and a cone, so a torch lights a
    // disc on a bulkhead rather than the whole compartment. See scene/torch.js.
    //
    // Not gated on night. A torch in daylight does nothing visible and the
    // falloff says so on its own; gating it would only mean the beam vanished at
    // dawn while the lamp was plainly still burning on the end of the gun.
    if (torch !== null) {
      If(torch.on.greaterThan(0), () => {
        const shipP = shipXform.mul(vec4(positionLocal, 1)).xyz.toVar();
        const shipN = normalize(shipXform.mul(vec4(normalLocal, 0)).xyz).toVar();
        // Multiplied by the albedo, unlike the two rigs above it. Those are
        // rig light: a scuttle's spill and a gun's flash are added flat, which
        // is a simplification they get away with because they are dim and warm
        // and land on a ship that is already lit. A torch is not — after dark it
        // *is* the light on whatever it is pointed at, and adding it flat lights
        // a black bulkhead and a white one to the same grey. Through the albedo
        // it lights them as what they are.
        lit.addAssign(handLight(torch, shipP, shipN).mul(albedo));
      });
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
