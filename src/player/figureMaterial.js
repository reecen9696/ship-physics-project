import { MeshBasicNodeMaterial, Matrix4, BufferAttribute, Color } from 'three/webgpu';
import {
  Fn, vec3, vec4, float, normalize, dot, max, saturate, sqrt, pow, mix, attribute,
  cameraPosition, positionWorld, positionLocal, normalWorld, normalLocal,
  uniform, If,
} from 'three/tsl';
import { skyColor } from '../ocean/sky.js';
import { handLight } from '../scene/torch.js';

// The things on this ship that are not part of the ship.
//
// A man and the rifle in his hands. Both are shaded from the same sun, the same
// sky and the same water this ship is shaded from — that is not optional, it is
// the whole reason the hull does not use a MeshStandardMaterial — but neither of
// them can share her program, and the reason is a hard limit rather than a
// preference.
//
// WebGPU allows a render pipeline eight vertex buffers. The ship's program
// already uses all eight (see the note above `paint()` in shipMaterial.js), and
// a skinned figure has to carry `skinIndex` and `skinWeight` on top — ten, which
// does not fail at the draw call with anything legible, it fails as an invalid
// pipeline and the man disappears. So the figures get a leaner program: position,
// normal, colour, roughness, metalness, and the two skinning attributes. Seven.
//
// Everything the ship's shader does that a person does not need is gone with it
// — the plating seams, the rivets, the waterline paint, the destruction field,
// the baked lamp-occlusion volume — which is most of why the ship's program is
// as long as it is. What is kept is what makes a figure sit in this scene rather
// than on top of it: the sun and its shadow, the sky as fill, the green bounce
// off the water, the night floor, her lamps, her muzzle flashes, and the torch.
//
// --- why the lamps are here but the volume is not ----------------------------
//
// The lamp *emitters* are a short list of positions in her frame and are exactly
// as valid for a man standing under one as for the bulkhead behind him. The
// occlusion volume is not: it was baked once, at load, from geometry that does
// not move, and a man walking about is precisely the thing it does not know
// about. Sampling it would mean a figure who crosses a crate's shadow goes dark
// with it — which is nearly right — and a figure standing *inside* a deckhouse's
// voxel goes dark while plainly out on the open deck, which is not. Left out.

const _c = new Color();

// Bake a figure's look into its geometry, the way `paint()` does for the ship —
// and deliberately not `paint()` itself, which writes three attributes this
// program has no use for and cannot afford.
//
// `color` may be a per-vertex Float32Array (three floats a vertex) when the look
// came off a texture, which is how the soldier keeps the palette he was authored
// with: see `bakeVertexColors` in player/models.js.
export function bakeFigure(geometry, { color, roughness = 0.6, metal = 0.1 }) {
  const n = geometry.getAttribute('position').count;
  if (color instanceof Float32Array) {
    geometry.setAttribute('color', new BufferAttribute(color, 3));
  } else {
    const col = new Float32Array(n * 3);
    if (Array.isArray(color)) _c.setRGB(color[0], color[1], color[2]);
    else _c.set(color);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    geometry.setAttribute('color', new BufferAttribute(col, 3));
  }
  geometry.setAttribute('rough', new BufferAttribute(new Float32Array(n).fill(roughness), 1));
  geometry.setAttribute('metal', new BufferAttribute(new Float32Array(n).fill(metal), 1));
  // Everything this program does not read is dropped rather than left lying
  // about: the FBX arrives with UVs and sometimes a second colour set, and each
  // one is a vertex buffer against a budget of eight.
  for (const name of Object.keys(geometry.attributes)) {
    if (!KEEP.has(name)) geometry.deleteAttribute(name);
  }
  return geometry;
}

const KEEP = new Set(['position', 'normal', 'color', 'rough', 'metal', 'skinIndex', 'skinWeight']);

// One material for every figure in the scene, for the same reason the ship has
// one: a node graph this size costs real time to compile, and a second copy of
// it to shade a rifle differently from the man holding it would be paid for on
// the frame he picks it up.
export function createFigureMaterial({
  shading, sunShadow = float(1),
  // Her lamp rig and her flash rig, straight off `battleship.materials` — the
  // same uniform arrays her own plating reads, so a man standing beside a lit
  // scuttle is lit by the light that is coming out of it.
  lamps = null, flashes = null, torch = null,
}) {
  const mat = new MeshBasicNodeMaterial();

  // Where this mesh's vertices land in the ship's frame. The three rigs below
  // are all stated in that frame and a figure is not part of the ship, so unlike
  // the hull's version of this matrix it genuinely changes every frame — a man
  // walks, and the gun in his hands is bolted to a camera. Whoever draws the
  // figure keeps it current; see `syncFieldXform` below.
  const shipXform = uniform(new Matrix4()).onObjectUpdate(function (frame) {
    const m = frame.object.userData.fieldXform;
    if (m) this.value.copy(m); else this.value.identity();
  });

  mat.colorNode = Fn(() => {
    const N = normalize(normalWorld).toVar();
    const V = normalize(cameraPosition.sub(positionWorld));
    const base = attribute('color', 'vec3').toVar();
    const rough = saturate(attribute('rough', 'float')).max(0.05).toVar();
    const metal = saturate(attribute('metal', 'float')).toVar();

    // The same three fills the hull gets, in the same order and for the same
    // reasons — see the long note in boatMaterial.js. Abbreviated here because a
    // person is not a mirror: there is no anisotropy, no plating frame and no
    // split-sum reflection, just a Blinn lobe over a Lambert one.
    const grey = (c, amount) => mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), amount);
    const ndl = saturate(dot(N, shading.sunDir));
    const sun = shading.sunColor.mul(ndl).mul(sunShadow).mul(1.15);

    const shadeAmb = sunShadow.mul(0.28).add(0.72);
    const skyRaw = skyColor(normalize(vec3(N.x, max(N.y, -0.2), N.z)), shading, sunShadow);
    const nightFill = vec3(0.105, 0.125, 0.170).mul(shading.night);
    const sky = grey(mix(shading.horizon, skyRaw, 0.35), 0.55)
      .mul(0.78).mul(shadeAmb).add(nightFill);
    const bounce = grey(mix(shading.deepColor, shading.scatterColor, 0.35), 0.5)
      .mul(saturate(N.y.negate()).mul(0.45).add(0.12)).mul(shadeAmb);

    const albedo = base.mul(float(1).sub(metal.mul(0.85))).toVar();
    const lit = albedo.mul(sun.add(sky).add(bounce)).toVar();

    // Specular. A Blinn-Phong lobe, which is what a cotton drill uniform and a
    // parkerised receiver both want and neither of them wants much of: the point
    // of it is the wet-looking line down the top of a barrel and the sheen off a
    // helmet, not a reflection of anything.
    const H = normalize(shading.sunDir.add(V));
    const gloss = float(2).div(rough.mul(rough).mul(rough).mul(rough)).add(2);
    const specCol = mix(vec3(0.045), base, metal);
    lit.addAssign(specCol
      .mul(pow(saturate(dot(N, H)), gloss))
      .mul(shading.sunColor).mul(sunShadow)
      .mul(ndl) // no highlight on a facet the sun cannot see
      .mul(mix(float(0.35), float(2.2), metal)));

    // --- her own lights, on the man standing under them -------------------------
    //
    // The emitter list, without the occlusion volume — see the note at the head
    // of this file. Gated on night exactly as the hull's is, so it costs a
    // compare in daylight.
    if (lamps !== null) {
      const night = shading.night;
      If(night.greaterThan(0.01), () => {
        const shipP = shipXform.mul(vec4(positionLocal, 1)).xyz.toVar();
        const shipN = normalize(shipXform.mul(vec4(normalLocal, 0)).xyz).toVar();
        const spill = vec3(0).toVar();
        // Only the lamps out in the weather. The ones inside rooms are held as a
        // room and a slot in the hull's program, and a figure has no business
        // being lit through a bulkhead by one of them.
        for (let i = 0; i < lamps.layout.open; i++) {
          const P = lamps.pos.element(i);
          const toL = P.xyz.sub(shipP).toVar();
          const d2 = dot(toL, toL).toVar();
          const k = d2.mul(P.w).mul(P.w).toVar();
          If(k.lessThan(1), () => {
            const fall = float(1).sub(saturate(k)).toVar();
            const drop = fall.mul(fall).mul(fall);
            const wrap = saturate(dot(shipN, normalize(toL))).mul(0.6).add(0.4);
            spill.addAssign(lamps.col.element(i).mul(drop).mul(wrap));
          });
        }
        lit.addAssign(spill.mul(night));
      });
    }

    // --- and when a gun goes off next to him ------------------------------------
    if (flashes !== null) {
      If(flashes.on.greaterThan(0), () => {
        const shipP = shipXform.mul(vec4(positionLocal, 1)).xyz.toVar();
        const shipN = normalize(shipXform.mul(vec4(normalLocal, 0)).xyz).toVar();
        const blast = vec3(0).toVar();
        for (let i = 0; i < flashes.count; i++) {
          const P = flashes.pos.element(i);
          const toL = P.xyz.sub(shipP).toVar();
          const d2 = dot(toL, toL).toVar();
          const k = d2.mul(P.w).mul(P.w).toVar();
          If(k.lessThan(1), () => {
            const fall = float(1).sub(sqrt(saturate(k))).toVar();
            const wrap = saturate(dot(shipN, normalize(toL))).mul(0.68).add(0.32);
            blast.addAssign(flashes.col.element(i).mul(fall.mul(fall)).mul(wrap));
          });
        }
        lit.addAssign(blast);
      });
    }

    // --- and the torch and the flash on the end of his rifle ---------------------
    //
    // Both point away from him, so what they light of the man is very little and
    // what they light of the rifle is the underside of its own barrel — which is
    // exactly what you see when you put a torch on a gun, and leaving it out is
    // what would look wrong.
    if (torch !== null) {
      If(torch.on.greaterThan(0), () => {
        const shipP = shipXform.mul(vec4(positionLocal, 1)).xyz.toVar();
        const shipN = normalize(shipXform.mul(vec4(normalLocal, 0)).xyz).toVar();
        lit.addAssign(handLight(torch, shipP, shipN).mul(albedo));
      });
    }

    return vec4(lit, 1);
  })();

  return mat;
}

// Keep a figure's ship-frame matrix current.
//
// Every rig this program reads is stated in the ship's own frame, and a figure
// is the one thing drawn in this scene that moves through that frame. `root` is
// whatever the figure hangs off — her hull group — and the object's own world
// matrix supplies the rest. Called once a frame per drawn figure, which is two.
const _inv = new Matrix4();
export function syncFieldXform(object, shipGroup) {
  _inv.copy(shipGroup.matrixWorld).invert();
  object.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.userData.fieldXform ?? (o.userData.fieldXform = new Matrix4());
    m.multiplyMatrices(_inv, o.matrixWorld);
  });
}
