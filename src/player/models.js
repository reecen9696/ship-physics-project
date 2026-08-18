import {
  Box3, BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, Vector3,
} from 'three/webgpu';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { bakeFigure } from './figureMaterial.js';
import { PLAYER } from './spec.js';

// The two things in this scene that were modelled by somebody else.
//
// Everything else here is generated: the ship is built out of primitives by
// forty files of code, the sea is a spectrum, the sky is a function. A rifle and
// a man are the two shapes where that stops being the right approach — nobody
// wants a battleship's worth of parameters for a trigger guard — so they arrive
// as FBX, and this file is the whole of the seam between an authored asset and a
// procedural scene.
//
// It does four things to each of them, and the reason for all four is the same:
// an asset arrives in the artist's conventions, and every one of those has to be
// converted exactly once, here, rather than being worked around at each of the
// places that reads it.
//
//   1. Units and orientation. The rifle is in some tool's units, lying along X
//      with its muzzle at -X, and it comes through a Z-up conversion on the way.
//      It leaves here in metres, pointing down -Z with +Y up, and with its origin
//      on the sight line — which is the one datum a first-person weapon actually
//      needs, because aiming is "put the sights on the camera axis".
//   2. Materials. Both arrive with a MeshPhongMaterial, and there is nothing in
//      this scene for three's lighting model to work with: the one directional
//      light has an intensity of zero and exists to own a shadow map. So the
//      surfaces are re-baked into vertex attributes and handed the figure
//      program — see figureMaterial.js.
//   3. Draw calls. The rifle is nineteen separate meshes sharing one material,
//      and it is drawn twice — once in the player's hands, once in the hands of
//      the man on the deck. Merged, that is two draws instead of thirty-eight.
//   4. The mount points. Where the muzzle is, where the sight line is, where the
//      torch is clamped. Measured off the model once, published as vectors, and
//      never guessed at again.
//
// Nothing here throws. A model that fails to load leaves the game with a capsule
// for a man and no rifle, which is exactly what it had before, and one line in
// the console saying why.

// --- the rifle ---------------------------------------------------------------

// What the model measures, in its own units, read off the meshes it is built
// from. Everything below is derived from these four numbers, so a different
// rifle is four numbers rather than a rewrite.
const M16 = {
  overall: 1428.3, // muzzle to butt plate, the length the scale is fitted to
  bore: 66, // height of the barrel's axis above the model's origin
  sightLine: 161, // and of the line through the front post and the rear aperture
  muzzleX: -715.6, // the far end of the barrel; the model looks down -X
  // Where a torch goes on an M16: clamped to the underside of the handguard,
  // a third of the way back from the flash hider. The handguard's bottom is at
  // y = 12, and the body of the lamp hangs below it.
  torchX: -372,
  torchY: -14,
  // and the real length of the thing, which is what fixes the scale
  metres: 0.99,
};

// Which parts are steel and which are the black stuff. One material in the file,
// two materials on the real weapon, and the difference between them — a barrel
// and a front sight catching the sun while the receiver and the furniture do not
// — is most of what makes a gun read as a gun rather than as a black shape.
const STEEL = new Set([
  'Cylinder', // the barrel, run full length through the receiver
  'Cylinder001', // the gas block and the front of the receiver
  'Cylinder002', // the charging handle
  'Cube005', // the trigger
  'Cube007', // the magazine catch
  'Cube008', // the bolt release
  'Cube017', // the rear aperture
]);
// Neither is black. A parkerised barrel and a glass-filled nylon stock
// photographed in daylight are both dark warm greys, and true black in a scene
// with a tone curve over it reads as a hole cut in the picture rather than as a
// surface — which is what the first pass at these looked like against the teak.
const GUNMETAL = [0.190, 0.192, 0.205];
const FURNITURE = [0.110, 0.108, 0.118];

// The soldier's palette lives in a 256-wide gradient rather than in a texture
// with anything drawn on it: the model is UV'd so that each material region
// lands on one band of it. Sampled per vertex at load, that becomes a colour
// attribute — which is what the figure program wants anyway — and the texture,
// the sampler and the UV attribute all go away.
async function bakeVertexColors(geometry, url) {
  const uv = geometry.getAttribute('uv');
  if (!uv) return null;
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const g2 = cv.getContext('2d', { willReadFrequently: true });
  g2.drawImage(bmp, 0, 0);
  const { data, width, height } = g2.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();

  // The image is sRGB and everything downstream of the figure program works in
  // linear light. Convert here, once per vertex, rather than per fragment.
  const toLinear = (b) => {
    const c = b / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = toLinear(i);

  const n = uv.count;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Clamped rather than wrapped: a vertex exactly on the edge of the band it
    // was assigned would otherwise pick up the next one along.
    const x = Math.min(Math.max(Math.floor(uv.getX(i) * width), 0), width - 1);
    // three's UV origin is the bottom-left; an ImageData's is the top-left.
    const y = Math.min(Math.max(Math.floor((1 - uv.getY(i)) * height), 0), height - 1);
    const p = (y * width + x) * 4;
    out[i * 3] = lut[data[p]];
    out[i * 3 + 1] = lut[data[p + 1]];
    out[i * 3 + 2] = lut[data[p + 2]];
  }
  return out;
}

// Concatenate a set of geometries that already agree about their attributes.
// Not `battleship/mergeGeometry.js`: that one is for the ship's indexed,
// eight-attribute buffers, and what comes out of an FBX is neither indexed nor
// carrying the same set.
function concat(geoms) {
  const names = Object.keys(geoms[0].attributes);
  let n = 0;
  for (const g of geoms) n += g.attributes.position.count;
  const out = new BufferGeometry();
  for (const name of names) {
    const size = geoms[0].attributes[name].itemSize;
    const arr = new Float32Array(n * size);
    let o = 0;
    for (const g of geoms) {
      const a = g.attributes[name];
      arr.set(a.array, o);
      o += a.count * size;
    }
    out.setAttribute(name, new BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

const _m = new Matrix4();

// The rifle, in a frame a first-person weapon can be posed in: origin on the
// sight line over the receiver, muzzle down -Z, metres.
function buildRifle(root) {
  root.updateMatrixWorld(true);
  const s = M16.metres / M16.overall;
  // World -> canonical, in one matrix, applied to the vertices rather than left
  // on a node: the whole point of merging is that there are no nodes left.
  //
  //   drop the sight line to zero, scale to metres, then turn -X into -Z
  //
  // written right to left, which is the order a matrix product reads in.
  const toLocal = new Matrix4()
    .makeRotationY(-Math.PI / 2)
    .multiply(_m.makeScale(s, s, s))
    .multiply(_m.makeTranslation(0, -M16.sightLine, 0));

  const steel = [];
  const black = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(_m.copy(toLocal).multiply(o.matrixWorld));
    // Down to the two attributes the merge and the bake both agree about. The
    // exporter puts UVs on some of these meshes and not others, and `concat`
    // reads its attribute list off the first geometry it is given — so one mesh
    // without a UV set silently short-fills the buffer for all nineteen.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    (STEEL.has(o.name) ? steel : black).push(g);
  });
  if (!steel.length && !black.length) return null;

  // Two buckets, one geometry: the look is in the vertex attributes, so a
  // gunmetal barrel and a polymer stock share a draw call the way a scuttle's
  // brass rim shares one with its glass.
  const parts = [];
  if (steel.length) {
    parts.push(bakeFigure(concat(steel), {
      color: GUNMETAL, roughness: 0.34, metal: 0.72,
    }));
  }
  if (black.length) {
    parts.push(bakeFigure(concat(black), {
      // Anodised alloy and glass-filled nylon. Not actually black — a rifle
      // photographed in daylight is a very dark warm grey, and true black in a
      // scene with a tone curve on it reads as a hole.
      color: FURNITURE, roughness: 0.58, metal: 0.18,
    }));
  }
  const geometry = parts.length === 1 ? parts[0] : concat(parts);

  const pt = (x, y) => new Vector3(x, y, 0).applyMatrix4(toLocal);
  return {
    geometry,
    // Everything anyone needs to know about where things are on this weapon.
    muzzle: pt(M16.muzzleX, M16.bore), // where the flash and the round leave
    torch: pt(M16.torchX, M16.torchY), // where the lamp is clamped
    // The bore, at the breech. A round leaves along -Z from `muzzle`; this is
    // only wanted for the shell ejecting and for lining the barrel up.
    breech: pt(0, M16.bore),
    length: M16.metres,
  };
}

// --- the soldier ---------------------------------------------------------------

async function buildSoldier(root, gradientUrl) {
  root.updateMatrixWorld(true);
  let skinned = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  if (!skinned) return null;

  const colors = await bakeVertexColors(skinned.geometry, gradientUrl).catch(() => null);
  bakeFigure(skinned.geometry, {
    // If the gradient could not be read he comes out in drab, which is a
    // perfectly good uniform and better than a missing man.
    color: colors ?? [0.29, 0.28, 0.20],
    roughness: 0.82,
    metal: 0.03,
  });

  // How tall he is, and it has to be measured with the node transforms applied.
  //
  // The geometry's own bounding box is not his height and is not in his units:
  // this exporter leaves a scale on the mesh node, so the vertices come out
  // 0.45 units tall and the node multiplies them up by four hundred. Measuring
  // the geometry gives a man four times the height of the ship. `setFromObject`
  // walks the transforms, which is the only reading that means anything.
  //
  // Scaled on a wrapper rather than baked into the vertices, because baking a
  // scale into a skinned mesh means rescaling the bind matrix, every bone
  // inverse and every bone's rest translation to match, and getting one of those
  // wrong is a figure that turns inside out the first time it moves.
  const box = new Box3().setFromObject(root);
  const height = box.max.y - box.min.y;
  const figure = new Group();
  figure.scale.setScalar(PLAYER.height / (height > 1e-6 ? height : PLAYER.height));
  figure.add(root);

  // The rig is Rigify's metarig, so the names are known and stable. Handed out
  // by name rather than by index: an index into a bone array is the sort of
  // thing that keeps working until somebody re-exports the model.
  const bones = new Map();
  root.traverse((o) => { if (o.isBone) bones.set(o.name, o); });

  return { group: figure, mesh: skinned, bones };
}

// --- loading -------------------------------------------------------------------

function loadFBX(url) {
  return new Promise((resolve, reject) => {
    new FBXLoader().load(url, resolve, undefined, reject);
  });
}

// Load both, tolerate either failing, and hand back what arrived. Awaited once
// during setup; nothing in the game loop touches this file.
export async function loadPlayerModels({
  rifle = '/models/m16.fbx',
  soldier = '/models/soldier.fbx',
  gradient = '/models/soldier_gradient.jpg',
} = {}) {
  const [r, s] = await Promise.allSettled([loadFBX(rifle), loadFBX(soldier)]);
  const out = { rifle: null, soldier: null };
  if (r.status === 'fulfilled') {
    try { out.rifle = buildRifle(r.value); } catch (e) { console.warn('rifle:', e.message); }
  } else console.warn(`rifle: ${rifle} — ${r.reason?.message ?? r.reason}`);
  if (s.status === 'fulfilled') {
    try { out.soldier = await buildSoldier(s.value, gradient); } catch (e) { console.warn('soldier:', e.message); }
  } else console.warn(`soldier: ${soldier} — ${s.reason?.message ?? s.reason}`);
  return out;
}

// One drawn copy of the rifle. Two are made: the one in the player's hands, which
// hangs off the camera, and the one in the deck figure's, which hangs off his
// right hand. They share a geometry and a material and differ only in where they
// are parented.
export function makeRifle(proto, material) {
  const mesh = new Mesh(proto.geometry, material);
  mesh.frustumCulled = false; // a view model is never off screen, and its
  // bounding sphere is computed in a frame that has nothing to do with where it
  // is actually drawn
  const group = new Group();
  group.add(mesh);
  return group;
}
