import { DoubleSide, Color, Vector3, Vector4 } from 'three/webgpu';
import { attribute, float } from 'three/tsl';
import { uniform, uniformArray } from '../scene/uniforms.js';
import { createBoatMaterial } from '../boat/boatMaterial.js';
import { createClearGlass } from './glazing.js';
import { createLampVolume } from './lampVolume.js';
import { createHandLights } from '../scene/torch.js';
import { PAINT, PLATING } from './hull.js';

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

// How many lamps throw light back onto her.
//
// A hard ceiling rather than a budget, because every one of them is evaluated on
// every fragment of the ship — this is a forward pass with no culling of any
// kind — so the cost is (lamps x ship pixels) and it is paid whether or not a
// lamp is anywhere near what is being drawn. One emitter per scuttle run, one
// per window band, one over each turret door and two inside each turret, which
// is the right granularity anyway: what a run of seven portholes throws on the
// deck is one soft patch, not seven.
export const MAX_LAMPS = 40;

// And how many separate rooms have lamps shut inside them.
//
// Seven today: the four turrets, the wheelhouse, and the conning trunk in two
// halves. Growing this list is nearly free in a way that growing the one above is
// not — a room costs one box test per fragment and the lamps inside it cost
// nothing at all unless you are standing in it, which is the whole reason the
// lights in a compartment go in here rather than out in the weather.
export const MAX_LAMP_ROOMS = 10;

// How many guns can be lighting her at once.
//
// A muzzle flash is a lamp that lasts a tenth of a second and is a hundred times
// brighter than every other light on the ship put together, and it has to be on
// this list rather than in the one above for three reasons: it moves, it is not
// gated on night — a 16-inch flash is plainly visible on a bright afternoon —
// and it must not be attenuated by the baked lamp volume, which was baked for
// lights that are bolted to her and knows nothing about a gun that is pointing
// somewhere new.
//
// Four is a full broadside's worth once you allow that the two guns in one
// gunhouse are a metre and a half apart and can share an emitter. Everything in
// this block is skipped entirely — one branch, taken by the whole warp — unless
// something is actually firing.
export const MAX_FLASHES = 4;

export function createShipMaterials({
  shading, sunShadow, destruction = null,
  // The second shadow map: what is standing on her deck, cast onto her deck.
  // Only the deck program reads it, and no mesh drawn with the deck program is
  // allowed to write it — see the note in main.js for why that has to be true.
  deckShadow = null,
}) {
  // one slot per destructible component; the damage model writes these
  const damageValues = new Float32Array(MAX_COMPONENTS);
  const damage = uniformArray(damageValues, 'float');

  // --- the lamp rig -----------------------------------------------------------
  //
  // Position and reach in one vec4, colour in another, both in her own frame.
  // They are allocated dark and filled after the ship is built, because the
  // materials have to exist before the builders that know where the lights are
  // can run — the same order the damage slots are handed out in.
  const lampPos = Array.from({ length: MAX_LAMPS }, () => new Vector4(0, 0, 0, 0));
  const lampCol = Array.from({ length: MAX_LAMPS }, () => new Vector3(0, 0, 0));
  // The room a lamp is shut inside, if it is shut inside one: half-extents about
  // (0, y, z) in her frame, with w > 0 saying the bound is live.
  //
  // This exists for the red battle lights in the turrets, and it exists because
  // the shadow volume cannot help them. That grid is half a metre to a side and
  // a gunhouse wall is two hundred millimetres, so the trilinear fetch that
  // makes its shadows soft also carries "lit" straight through the plating —
  // the red came out on the *outside* of the bandstand as a glow on the paint.
  // No resolution that fits in memory fixes that, and it should not have to: a
  // light sealed in a steel room does not want a soft edge, it wants the wall.
  // This is the wall.
  //
  // A room is held once, not once per lamp in it: the two battle lights in a
  // gunhouse are shut in the same gunhouse, and the shader tests the box once
  // and then does both of them. That is the whole point of the arrangement — see
  // `layout` below.
  const roomHalf = Array.from({ length: MAX_LAMP_ROOMS }, () => new Vector3(0, 0, 0));
  // And what stops it. A grid in her own frame saying how much of her lamplight
  // reaches each point — baked once, because none of it moves relative to any of
  // the rest of it. Allocated fully lit and filled after the ship is built; see
  // lampVolume.js.
  const volume = createLampVolume();

  // --- how the rig is laid out, and why it matters ------------------------------
  //
  // The loop over these lamps is unrolled into the ship's fragment program and
  // runs on every fragment of her, so its length is not a detail — it was a third
  // of the cost of the whole frame at night. Two things were being paid for and
  // neither was wanted:
  //
  //   - Empty slots. The array is sized to a ceiling and the shader walked all
  //     of it, evaluating a full lamp for every unused entry to multiply by a
  //     colour of zero.
  //   - The lamps that are shut in a room. Twelve of the twenty are inside the
  //     four turrets, they cannot light anything outside those four boxes, and
  //     they were being fully evaluated on every fragment of the ship anyway —
  //     the whole hull, the sea-facing plating, the masts — before being
  //     multiplied by a bound that was zero.
  //
  // So the rig is sorted rather than taken in the order the builders happened to
  // report it: the lamps out in the weather first, then the ones in rooms,
  // grouped by which room. `layout` says where the boundaries are, and the
  // shader reads it when it builds the graph — which is on the first draw, and
  // therefore after `setLamps` has run. Nothing else in the frame depends on it,
  // and if `setLamps` is never called the layout says "no lamps", which is both
  // correct and free.
  const layout = { open: 0, rooms: [] };
  const lamps = {
    layout,
    volume: volume.texture,
    volumeOrigin: volume.origin,
    volumeInvSize: volume.invSize,
    pos: uniformArray(lampPos, 'vec4'),
    col: uniformArray(lampCol, 'vec3'),
    roomHalf: uniformArray(roomHalf, 'vec3'),
  };

  // And the one light on this ship that is not bolted to her: a torch clamped
  // under a rifle's handguard, carried by whoever is walking her deck. It is the
  // same idea as the two rigs either side of it — a position and a colour in her
  // own frame, evaluated per fragment — with an axis and a cone on top, which is
  // what a torch has and a lamp does not. See scene/torch.js.
  const torch = createHandLights();

  // The guns, as lights. Same shape as a lamp — position and 1/reach in a vec4,
  // colour times level in a vec3 — so the shader can treat one exactly like the
  // other, and one scalar saying whether any of them are burning.
  const flashPos = Array.from({ length: MAX_FLASHES }, () => new Vector4(0, 0, 0, 0));
  const flashCol = Array.from({ length: MAX_FLASHES }, () => new Vector3(0, 0, 0));
  const flashes = {
    count: MAX_FLASHES,
    on: uniform(0),
    pos: uniformArray(flashPos, 'vec4'),
    col: uniformArray(flashCol, 'vec3'),
  };

  // Called every frame by whatever is firing her guns — `null` or an empty list
  // when nothing is, which is the common case and costs one uniform write.
  function setFlashes(list) {
    const n = Math.min(list ? list.length : 0, MAX_FLASHES);
    for (let i = 0; i < MAX_FLASHES; i++) {
      const f = i < n ? list[i] : null;
      if (f) {
        flashPos[i].set(f.x, f.y, f.z, f.reach > 0.01 ? 1 / f.reach : 0);
        const k = f.level ?? 1;
        flashCol[i].set(f.color[0] * k, f.color[1] * k, f.color[2] * k);
      } else {
        flashPos[i].set(0, 0, 0, 0);
        flashCol[i].set(0, 0, 0);
      }
    }
    flashes.pos.needsUpdate = true;
    flashes.col.needsUpdate = true;
    flashes.on.value = n > 0 ? 1 : 0;
  }

  // `list` is [{ x, y, z, reach, color, level, room }]. Anything past MAX_LAMPS is
  // dropped with a warning rather than silently: a light that is in the model
  // and not in the rig is the sort of thing nobody notices until they are
  // wondering why one corner of the ship is dark.
  function setLamps(list) {
    if (list.length > MAX_LAMPS) {
      console.warn(`ship: ${list.length} lamps, rig holds ${MAX_LAMPS} — dropping the rest`);
    }
    const kept = list.slice(0, MAX_LAMPS);
    const open = kept.filter((l) => !l.room);
    // Grouped by the box, not by the lamp. The box is the room's half-extents
    // about (0, y, z) in her frame, so two lamps agree on a room exactly when
    // all five numbers agree — which is how the pair on either wall of a
    // gunhouse end up sharing one test.
    const byRoom = new Map();
    for (const l of kept) {
      if (!l.room) continue;
      const key = `${l.room[0]}|${l.room[1]}|${l.room[2]}|${l.y}|${l.z}`;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key).push(l);
    }
    if (byRoom.size > MAX_LAMP_ROOMS) {
      console.warn(`ship: ${byRoom.size} lit rooms, rig holds ${MAX_LAMP_ROOMS}`);
    }
    const rooms = [...byRoom.values()].slice(0, MAX_LAMP_ROOMS);

    const write = (i, l) => {
      // `1/reach`, not the reach. The shader divides the distance by it on every
      // lamp on every fragment, and a reciprocal computed once here is a multiply
      // there. A lamp with no reach at all is written as zero, which makes its
      // falloff 1 everywhere — harmless, because its colour is zero too.
      lampPos[i].set(l.x, l.y, l.z, l.reach > 0.01 ? 1 / l.reach : 0);
      const k = l.level ?? 1;
      lampCol[i].set(l.color[0] * k, l.color[1] * k, l.color[2] * k);
    };

    let n = 0;
    for (const l of open) write(n++, l);
    layout.open = n;
    layout.rooms = [];
    rooms.forEach((group, r) => {
      const from = n;
      for (const l of group) write(n++, l);
      // The half-extents go in the room's own slot; the centre is read off the
      // first lamp in the span, which is where it already is.
      roomHalf[r].set(group[0].room[0], group[0].room[1], group[0].room[2]);
      layout.rooms.push({ slot: r, from, to: n });
    });
    // and everything past the last lamp is dark
    for (let i = n; i < MAX_LAMPS; i++) {
      lampPos[i].set(0, 0, 0, 0);
      lampCol[i].set(0, 0, 0);
    }
    for (let r = layout.rooms.length; r < MAX_LAMP_ROOMS; r++) roomHalf[r].set(0, 0, 0);
  }

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
    // how thick her plating reads, for the cut face round the lip of a chip
    platingDepth: PLATING,
    // And the same for the lamps, for the same reason: a light on the shelter
    // deck falls on the plating, on the teak and on the glass of the window
    // opposite it, and none of those three programs should have its own opinion
    // about where the light is.
    lamps,
    // and the guns, which are the same idea for a tenth of a second at a time
    flashes,
    // and the torch, which is the same idea again and walks about
    torch,
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
    // The deckhouse scuttles are on this program rather than the glass one — a
    // 0.6 m disc has no use for a mullion pattern — so the warm room behind them
    // is one term here, gated by the lamp level packed into each scuttle's
    // paintMask. Warmer and dimmer than the bridge windows: a scuttle is a
    // cabin with one bulb in it, not a wheelhouse.
    scuttleLamp: [0.48, 0.30, 0.13],
    // and the red one, for the battle lights inside the turrets
    battleLamp: [0.66, 0.09, 0.06],
    // and the door lights: a tungsten bulb behind clear glass, which is a warm
    // yellow and not the white it was. Weak on purpose — these are not there to
    // light anything, they are there so you can find the door.
    doorLamp: [0.70, 0.60, 0.32],
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
  // And one genuinely transparent program, for the windows of the one room on
  // her that is looked *out of* rather than at: the wheelhouse. See glazing.js
  // for why the painted band above cannot serve there.
  const clearGlass = createClearGlass({ shading });
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
    // The one surface on the ship that catches a shadow. Everything above it
    // throws one: the pagoda across the forecastle in the afternoon, a vent
    // cowl, a stack of crates, a man walking aft.
    sunShadow: deckShadow ?? sunShadow,
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

  return {
    body, deck, glass, clearGlass, slotOf, setDamage, handleFor, damageValues, slots, setLamps,
    setFlashes,
    // The rig itself rather than a setter: whoever is carrying the torch calls
    // `torch.set(...)` with the lamp in her frame, and the figure materials —
    // which are not built here — need the same object to read from.
    torch,
    lampVolume: volume,
  };
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
  // How brightly the room behind this pane is lit, 0..1, for the scuttles on the
  // deckhouses. Quantised to four bits and packed into `paintMask` above the two
  // flags — see the note there, and the lamp section in boatMaterial.js. It is
  // per-geometry rather than per-fragment on purpose: one scuttle, one answer.
  lamp = 0,
  // Red, rather than the warm white every other lit pane on the ship carries.
  // One bit, in the space above the four the level uses — see the note on
  // `paintMask` in boatMaterial.js for why this goes in there rather than into a
  // ninth vertex attribute.
  lampRed = false,
  // And dull white, for the lights over the turret doors. Two bits of colour
  // now — warm, red, white — in the space above the four the level uses.
  lampWhite = false,
  // 1 on a surface that is *inside* a lit room, and it changes exactly one
  // thing: what her lamps do to it.
  //
  // The lamp rig adds its spill flat — see the block at the foot of
  // boatMaterial.js — rather than multiplying it by what it is falling on. On
  // her outside that is right and cheap: the spill is a wash over paint that the
  // sky is already lighting, so nobody can tell that the warm patch on a grey
  // bulkhead is not tinted by the grey. Inside a room at night it is the *only*
  // light there is, and a light that ignores what it lands on paints the whole
  // compartment one flat colour — the deck, the deckhead, the brass and the
  // teak all come out the same yellow, which is what the wheelhouse looked like.
  // So a surface marked this way takes its lamplight through its own colour.
  //
  // It rides in `paintMask` rather than in an attribute of its own, and that is
  // not tidiness: eight vertex buffers is the WebGPU limit, this geometry already
  // uses all eight, and a ninth does not fail at the draw call with something
  // legible — it fails as an invalid render pipeline and the ship disappears. One
  // bit, in the space above the two the lamp colours use.
  roomLit = 0,
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
  const lampQ = Math.round(Math.min(Math.max(lamp, 0), 1) * 15);
  geometry.setAttribute('paintMask', new Attr(
    new Float32Array(n).fill(paintMask + plated * 2 + lampQ * 4
      + (lampRed ? 64 : 0) + (lampWhite ? 128 : 0) + (roomLit ? 256 : 0)), 1,
  ));
  // 1 on the inward-facing liner meshes: the same program shades them, but as
  // unpainted framed steel in a dark space rather than as her side.
  geometry.setAttribute('inside', new Attr(new Float32Array(n).fill(inside), 1));
  return geometry;
}
