import { DoubleSide, Color } from 'three/webgpu';
import { attribute, uniformArray, float } from 'three/tsl';
import { createBoatMaterial } from '../boat/boatMaterial.js';
import { PAINT } from './hull.js';

// One material for the whole ship.
//
// The obvious way to build a ship out of a few hundred meshes is to give each
// its own material — its own colour, its own roughness, its own damage
// uniform. That is also the way to compile a few hundred WGSL shaders, which on
// a node-material graph this size costs seconds per program and simply stops
// the frame. Everything that varies per part is therefore moved into the
// geometry or into an indexed uniform instead:
//
//   colour     -> per-vertex `color` attribute (the hull already worked this way)
//   roughness  -> per-vertex `rough` attribute
//   damage     -> `dmg[index]`, with the index a per-vertex attribute and the
//                 values a single uniform array the damage model writes into
//
// The result is two programs for the entire ship: hull-and-fittings, and the
// deck (which additionally wants planking and to be lit from both sides).

export const MAX_COMPONENTS = 64;

export function createShipMaterials({ shading, sunShadow, destruction = null }) {
  // one slot per destructible component; the damage model writes these
  const damageValues = new Float32Array(MAX_COMPONENTS);
  const damage = uniformArray(damageValues, 'float');

  const shared = {
    shading,
    sunShadow,
    color: null, // vertex colours
    roughness: attribute('rough', 'float'),
    // How much of each part answers as steel rather than as the paint on it.
    // Per-vertex for the same reason roughness is: it is the one number that
    // separates a gun barrel from a canvas dodger, and baking it into the
    // geometry keeps the whole ship on one program.
    metalness: attribute('metal', 'float'),
    damage: damage.element(attribute('dmgIndex', 'float').toUint()),
    // No procedural surface pattern anywhere on the ship: flat painted panels.
    // The plank seams and paint grain were the only two things generating
    // per-fragment detail, and at this size both read as a crawling texture
    // rather than as a surface. Shape and shading carry the ship instead.
    grain: 0,
    // painted from hull-local height on anything flagged with `paintMask`
    waterlinePaint: PAINT,
    // Holes, tears and the burn round them. Shared by all three programs, so a
    // shell that goes through the plating also goes through the deck it lands
    // on and the window band behind it — the field is in space, not on a part.
    destruction,
  };

  // She is a riveted ship, and every plated part of her says so: strakes about
  // two metres wide and plates six long, butts staggered, a row of heads down
  // every seam, and each plate bellying a little between the frames it is held
  // to. Sizes are what a wartime yard could actually roll and lift. Only the
  // body program carries it — the deck is timber and the windows are glass —
  // and inside the shader it is gated by the `plate` attribute, so her sides,
  // her deckhouses and her turret faces are plated and nothing turned or drawn
  // is given a seam it could not have. See `paint()` below.
  const body = createBoatMaterial({
    ...shared,
    // the liner meshes behind her plating ride on this same program — see
    // interior.js, and `inside` in paint() below
    interior: true,
    plating: {
      strake: 1.9, // plate width across the girth, m
      butt: 6.2, // plate length fore-and-aft, m
      seam: 0.045, // how wide the seam line reads, m
      lap: 0.22, // how hard the normal tips into a seam
      rivet: 0.11, // pitch of the heads along a seam, m (~4 diameters)
      head: 0.05, // radius of a head, m
      proud: 0.42, // how far a head's normal leans off the plate
      dish: 0.06, // the belly of a plate between its edges
    },
  });
  // Windows get their own program. It is the one place on the ship where the
  // shading model is genuinely different — a pane is a broken reflection with a
  // lit room behind it, not a painted surface — and it is a handful of meshes,
  // so a third program is a fair price.
  const glass = createBoatMaterial({
    ...shared,
    waterlinePaint: null,
    roughness: 0.1,
    metalness: 0, // a pane is a dielectric; only the frame around it is steel
    glass: {
      tint: [0.035, 0.05, 0.065],
      lamp: [0.52, 0.34, 0.15], // warm light from inside
      blur: 0.55, // how much the reflected sky is smeared
      paneWidth: 1.5, // metres between mullions
      mullion: 0.05, // mullion width as a fraction of a pane
      bandHalfHeight: 0.55, // half-height of a window band, for the top/bottom frame
    },
  });
  // The deck is the one surface on her that is not painted steel: a laid teak
  // deck, and the planking is what gives her scale. A 180 m ship with an
  // untextured deck reads as a model of a ship, because there is nothing on the
  // largest surface in view to say how big it is; 15 cm planks say it
  // immediately. They are deliberately narrow — the seams should be a fine grain
  // from the bridge, not stripes.
  //
  // This is why the deck is worth a third program rather than sharing the body's.
  const deck = createBoatMaterial({
    ...shared,
    planks: 0.15, // plank width, m
    weather: 0.6, // black seams, mismatched boards, grime in patches across them
    grain: 0.05,
  });
  deck.side = DoubleSide;

  // registry: component id -> slot
  const slots = new Map();
  const setDamage = (id, v) => {
    const i = slots.get(id);
    if (i === undefined) return;
    damageValues[i] = v;
    damage.needsUpdate = true;
  };
  const slotOf = (id) => {
    if (!slots.has(id)) {
      if (slots.size >= MAX_COMPONENTS) throw new Error(`ship: more than ${MAX_COMPONENTS} damage components`);
      slots.set(id, slots.size);
    }
    return slots.get(id);
  };

  // A uniform-array element behaves like a uniform to the rest of the code, so
  // the damage model can hold one of these per component and never know the
  // difference.
  const handleFor = (id) => {
    const i = slotOf(id);
    return {
      get value() { return damageValues[i]; },
      set value(v) { damageValues[i] = v; damage.needsUpdate = true; },
    };
  };

  return { body, deck, glass, slotOf, setDamage, handleFor, damageValues, slots };
}

// Bake a mesh's look into its geometry so it can share the ship material:
// a flat vertex colour, a roughness, a metalness, and which damage slot it
// answers to.
//
// `metal` defaults to most of the way to bare plate, because most of this ship
// *is* plate: everything above the boot topping is steel under a coat of paint
// thin enough that the plate is what you are really looking at. The exceptions
// are the ones worth naming at the call site — the teak deck (0), canvas, rope.
//
// `plate` is which parts are made of rolled plate, and so which ones carry
// seams and rivets. It is not passed at the call sites — there are several
// hundred of them — because the geometry already knows: plate is rolled flat
// and joined, so every plated thing on this ship is a box or a lofted surface,
// while everything turned, spun or drawn on a lathe or a draw bench — a gun
// barrel, a mast, a stanchion, a capstan, a bollard — is a cylinder, a sphere
// or a torus, and has no seam in it anywhere. Reading it off the primitive type
// gets that distinction right by construction and keeps it right as parts are
// added. Pass `plate` explicitly to override it either way.
//
// It rides in `paintMask` as a second bit rather than in an attribute of its
// own, because WebGPU allows a pipeline eight vertex buffers and this geometry
// already uses all eight (position, normal, color, rough, metal, dmgIndex,
// paintMask, inside). A ninth does not fail at the draw call with something
// legible — it fails as an invalid render pipeline and the ship disappears.
// Bit 0 is "takes the waterline paint", bit 1 is "is made of plate"; see the
// decode at the head of the planking section in boatMaterial.js.
const TURNED = /Cylinder|Sphere|Torus|Cone|Capsule|Lathe|Tube/;
const _c = new Color();
export function paint(geometry, {
  color, roughness = 0.45, slot = 0, keepColor = false, paintMask = 0, metal = 0.65,
  inside = 0, plate = null,
}) {
  const n = geometry.getAttribute('position').count;
  if (!keepColor) {
    const col = new Float32Array(n * 3);
    if (Array.isArray(color)) _c.setRGB(color[0], color[1], color[2]);
    else _c.set(color);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    geometry.setAttribute('color', new (geometry.getAttribute('position').constructor)(col, 3));
  }
  const Attr = geometry.getAttribute('position').constructor;
  geometry.setAttribute('rough', new Attr(new Float32Array(n).fill(roughness), 1));
  geometry.setAttribute('metal', new Attr(new Float32Array(n).fill(metal), 1));
  geometry.setAttribute('dmgIndex', new Attr(new Float32Array(n).fill(slot), 1));
  const plated = plate === null ? (TURNED.test(geometry.type) ? 0 : 1) : plate;
  geometry.setAttribute('paintMask', new Attr(new Float32Array(n).fill(paintMask + plated * 2), 1));
  // 1 on the inward-facing liner meshes: the same program shades them, but as
  // unpainted framed steel in a dark space rather than as her side.
  geometry.setAttribute('inside', new Attr(new Float32Array(n).fill(inside), 1));
  return geometry;
}
