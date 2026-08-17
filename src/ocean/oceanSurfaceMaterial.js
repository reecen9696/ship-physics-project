import { MeshBasicNodeMaterial, DoubleSide } from 'three/webgpu';
import {
  Fn, positionGeometry, positionWorld, cameraPosition, vec2, vec3, vec4, float,
  texture, normalize, reflect, dot, max, pow, mix, saturate, abs, smoothstep,
  linearDepth, viewportLinearDepth, min, sin, sqrt, step, Discard,
} from 'three/tsl';
import { skyColor } from './sky.js';
import { fx } from '../util/fxToggles.js';

// The ocean surface: multi-cascade displacement (vertex) + water shading
// (fragment). Shading is manual (unlit MeshBasicNodeMaterial): Fresnel blends
// the deep water body against an analytic sky reflection, the reflected sun
// disc gives the glitter path, SSS adds crest glow, and accumulated-Jacobian
// foam whitens breaking crests. A cheap baked tiling noise texture (sampled at
// two scrolling scales) adds sub-grid normal detail and breaks up the foam, so
// neither the surface nor the whitecaps read as uniform.
// `offset` is the mesh's own XZ translation. The grid follows the camera/boat so
// there is always ocean underfoot, but every map lookup adds the offset back, so
// the waves stay pinned to world space instead of sliding along with the mesh.
export function createOceanSurfaceMaterial(cascades, {
  lengthScales, shading, detailTex, offset, sunShadow, contacts,
}) {
  const mat = new MeshBasicNodeMaterial();
  // Plane is authored in XY and remapped to XZ in positionNode, flipping the
  // winding — render both sides so it's visible from above too.
  mat.side = DoubleSide;
  const worldXZ = vec2(positionGeometry.x, positionGeometry.y).add(offset);

  mat.positionNode = Fn(() => {
    const disp = vec3(0).toVar();
    cascades.forEach((c, i) => {
      disp.addAssign(texture(c.displacement, worldXZ.div(lengthScales[i])).level(0).xyz);
    });
    return vec3(positionGeometry.x.add(disp.x), disp.y, positionGeometry.y.add(disp.z));
  })();

  mat.colorNode = Fn(() => {
    const t = shading.time;

    // world normal from summed derivative maps (fold-aware slope)
    const d = vec4(0).toVar();
    cascades.forEach((c, i) => {
      d.addAssign(texture(c.derivatives, worldXZ.div(lengthScales[i])));
    });
    const slopeX = d.x.div(float(1).add(d.z));
    const slopeZ = d.y.div(float(1).add(d.w));
    const N = normalize(vec3(slopeX.negate(), float(1), slopeZ.negate())).toVar();

    // sub-grid ripple detail from the baked noise texture, two scrolling scales
    const det1 = texture(detailTex, worldXZ.mul(0.06).add(vec2(t.mul(0.012), t.mul(0.008)))).xy.sub(0.5).mul(2);
    const det2 = texture(detailTex, worldXZ.mul(0.17).add(vec2(t.mul(-0.02), t.mul(0.015)))).xy.sub(0.5).mul(2);
    const detail = det1.add(det2.mul(0.5)).mul(shading.detail);
    N.assign(normalize(N.add(vec3(detail.x, 0, detail.y))));

    const V = normalize(cameraPosition.sub(positionWorld));
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(N, V), 0)), 5)));

    // Anything the sun drives — the glitter path, the crest glow, the lit side
    // of the foam — is gated on the shadow map, so the boat's shadow lands on the
    // water. The reflected sky is not: shading a wave does not stop it reflecting
    // the sky, it only takes the sun out of it.
    const shadowMask = mix(float(1), sunShadow, fx.seaShadow.u);
    const sh = shadowMask.mul(0.88).add(0.12); // never fully black; the sea still scatters

    // sky reflection, reflected ray clamped to the upper hemisphere
    const R = reflect(V.negate(), N);
    const reflection = skyColor(normalize(vec3(R.x, abs(R.y).max(0.02), R.z)), shading, sh);

    // deep water body + subsurface scatter on sunlit crests
    const heightFactor = saturate(positionWorld.y.mul(0.5).add(0.4));
    const H = normalize(N.negate().add(shading.sunDir));
    const sss = pow(saturate(dot(V, H.negate())), 4).mul(shading.sssStrength).mul(heightFactor).mul(sh);
    const body = mix(shading.deepColor, shading.scatterColor, saturate(float(0.12).add(sss)));
    // A hull overhead blocks skylight as well as sun, so take a little off the
    // reflected sky too. Reusing the sun's shadow map for that is an
    // approximation, but it is what keeps the shadow readable on water whose
    // appearance is otherwise dominated by a reflection the sun never touches.
    const water = mix(body, reflection.mul(shadowMask.mul(0.3).add(0.7)), fresnel);

    // foam on real crest-folds only (skip the finest cascade's constant speckle)
    const foamRaw = float(0).toVar();
    cascades.forEach((c, i) => {
      if (i >= cascades.length - 1) return;
      const turb = texture(c.displacement, worldXZ.div(lengthScales[i])).w;
      foamRaw.addAssign(saturate(shading.foamThreshold.sub(turb).mul(shading.foamScale)));
    });
    // Contact foam where the sea meets a hull.
    //
    // Without this the ocean plane simply intersects the hull, and a hard
    // polygon edge across a ship reads as the water clipping through it rather
    // than the hull sitting in the water.
    //
    // Two terms. The depth buffer gives the distance to whatever solid was drawn
    // behind this fragment, which catches every hull in the scene cheaply but
    // only sees geometry *behind* the water along the view ray — from above it
    // finds the flared bow and transom and nothing down the sides — and it fires
    // on hull that is merely near the surface, like a bow lifted clear in a
    // trough. So each tracked hull also gets an analytic term: the surface point
    // is taken into that hull's frame, the section curve its mesh is lofted from
    // is evaluated at that station, and that gives exactly where the waterline
    // cuts the hull. Foam sits in a band around that line, and only where the
    // hull is really in the water. The ocean is drawn after the hulls so the
    // depth is there to read.
    const gap = viewportLinearDepth.sub(linearDepth()).mul(contacts.depthScale).abs();

    // bubbly structure: modulate foam BRIGHTNESS with the noise texture at two
    // scrolling scales (never carve coverage -> no dots), then shade the foam as
    // a near-Lambertian surface lit by sun + sky so it has depth, not flat paint
    const fb1 = texture(detailTex, worldXZ.mul(0.45).add(vec2(t.mul(0.03), t.mul(0.02)))).b;
    const fb2 = texture(detailTex, worldXZ.mul(1.6).add(vec2(t.mul(-0.05), t.mul(0.04)))).a;

    // The band is a solid white wash at the waterline that feathers out into
    // ragged fingers, so its outer edge is jittered by the noise rather than
    // being a clean offset of the hull outline.
    const ragged = float(0.7).add(fb1.mul(0.4)).add(fb2.mul(0.2));

    const shore = float(0).toVar();
    // Set where any hull's skin is between the eye and this piece of sea. Such
    // fragments must not be drawn at all — see the discard below.
    const buried = float(0).toVar();
    for (const h of contacts.hulls) {
      const local = h.worldToHull.mul(vec4(positionWorld, 1)).xyz; // x stbd, y up, z fwd
      const halfL = float(h.hull.length).mul(0.5);
      const s = saturate(local.z.div(h.hull.length).add(0.5));
      const halfBeam = h.hull.tsl.halfBeam(s);
      const keel = h.hull.tsl.keel(s);
      const deck = h.hull.tsl.deck(s);
      const p = h.hull.tsl.pow(s);
      // The section is x = b sin(th), y = deck - (deck + keel) cos(th)^p. At
      // water height y that inverts to a waterline half-width b * u, with
      // (1 - u^2)^(p/2) = (deck - y) / (deck + keel). Ratio >= 1 means the water
      // is below the keel here: this station is out of the water entirely.
      const ratio = deck.sub(local.y).div(deck.add(keel).max(0.01));
      const wet = smoothstep(float(1.0), float(0.94), ratio);
      const uwl = sqrt(saturate(float(1).sub(pow(saturate(ratio), float(2).div(p)))));
      const wlHalfBeam = halfBeam.mul(uwl);

      // trail the wash aft of the transom into a short wake
      const behind = max(local.z.negate().sub(halfL), 0);
      const tail = saturate(float(1).sub(behind.div(h.wake.max(0.01)))).mul(fx.seaWake.u);
      const dx = local.x.abs().sub(wlHalfBeam.mul(float(0.55).add(tail.mul(0.45))));
      const dz = max(local.z.sub(halfL), behind.sub(h.wake));
      // signed distance to the waterline outline, in plan
      const outside = vec2(max(dx, 0), max(dz, 0)).length().add(min(max(dx, dz), 0));

      // Ocean inside the hull.
      //
      // The sea is one plane through the whole scene, and it passes straight
      // through every hull floating on it. Normally the hull's skin is nearer
      // the eye and the depth test throws that inside-the-hull sea away — but
      // the surface is displaced horizontally as well as vertically
      // (choppiness), so its triangles slide sideways by metres and poke back
      // out through the topsides in slivers a pixel or two wide. Painted white
      // by the wash below, those slivers are the streaks that crawl over a hull
      // as the waves move. Depth bias cannot fix it: the geometry really is on
      // the wrong side. So the fragments are discarded outright, using the same
      // section curve the hull is lofted from — sea inside a ship is sea nobody
      // can see anyway.
      //
      // Above the deck it is *also* discarded — up to the top of the
      // superstructure — unless she is genuinely awash there. A wave crest that
      // rises a metre over the deck inside the outline is otherwise drawn as a
      // thin sheet slicing straight through the turrets and the bridge, and the
      // depth-foam term paints it white: that is the pale streak that used to
      // crawl across her decks. "Genuinely awash" is decided by the mean water
      // plane the solver fits each frame, not by the wave: if the *plane* is
      // above the deck at this station she is going under and the water over
      // her decks is real; if only a crest is, it is clipped at the hull.
      const planeY = h.water.height
        .add(h.water.slope.x.mul(positionWorld.x.sub(h.water.origin.x)))
        .add(h.water.slope.y.mul(positionWorld.z.sub(h.water.origin.y)));
      const planeLocalY = h.worldToHull.mul(vec4(positionWorld.x, planeY, positionWorld.z, 1)).y;
      const awash = step(deck.add(0.4), planeLocalY);
      const ceiling = mix(deck.add(80), deck, awash); // 80 m: well over the foretop
      const inHull = step(local.x.abs(), wlHalfBeam)
        .mul(step(local.z.abs(), halfL))
        .mul(step(local.y, ceiling))
        .mul(step(ratio.min(1), 1)) // and above the keel at this station
        .mul(step(local.y, deck).max(float(1).sub(awash))); // below deck always; above deck unless awash
      buried.assign(max(buried, inHull));

      const band = h.width.mul(ragged);
      // The depth term catches hull the plan outline cannot see — a flared bow,
      // a transom overhang — but it is only a depth comparison, so on its own it
      // also fires on open sea that happens to lie at the same distance as a
      // mast or a funnel high above it. Gate it on actually being near the hull
      // in plan, which is the one thing a depth buffer cannot tell you.
      const nearHull = saturate(float(1).sub(outside.div(band.mul(4))));
      shore.assign(max(shore, max(
        saturate(float(1).sub(gap.div(band))).mul(nearHull),
        saturate(float(1).sub(outside.abs().div(band))).mul(tail),
      ).mul(wet).mul(h.strength).mul(fx.seaWash.u)));
    }
    // `buried` is 1 where this fragment is sea inside a hull; drop it.
    Discard(buried.mul(fx.seaClip.u).greaterThan(0.5));
    const hullFoam = smoothstep(float(0.0), float(0.6), shore);

    // Whitecap foam is broken up by the noise; the wash at a hull is churned
    // and aerated right through, so it stays bright and near-uniform.
    const bubbles = saturate(fb1.mul(0.7).add(fb2.mul(0.5)).add(0.2))
      .max(hullFoam.mul(0.92));

    const coverage = max(
      smoothstep(float(0.2), float(0.9), foamRaw).mul(fx.seaCrestFoam.u), // smooth crest coverage
      hullFoam,
    );
    const foamLight = float(0.55).add(saturate(dot(N, shading.sunDir)).mul(0.6).mul(sh));
    const foamShaded = shading.foamColor.mul(foamLight).mul(bubbles);
    return mix(water, foamShaded, coverage);
  })();

  return mat;
}
