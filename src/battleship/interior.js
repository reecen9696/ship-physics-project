import {
  BoxGeometry, BufferGeometry, BufferAttribute, Group, Mesh, MeshBasicNodeMaterial, Vector3,
} from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, positionLocal, normalize, dot, saturate,
  cameraPosition, positionWorld, mix, pow, max, min, sin, abs, fract, smoothstep,
  attribute, reflect,
} from 'three/tsl';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { skyColor } from '../ocean/sky.js';
import {
  section, sideAt, deckAt, keelAt, halfBeamAt, hullTSL, HULL_STATIONS,
} from './hull.js';
import { SHIP, COMPARTMENTS, SUPER } from './spec.js';

// The inside of her.
//
// A hole is only a hole if there is something behind it. Without this file a
// shell that removes a disc of side plating shows you the sea through the ship,
// because the far side of the hull is facing away and is culled — which reads
// as a decal cut in a sheet, not as damage.
//
// So the hull gets a liner: the same loft, wound the other way round and inset
// by the thickness of her plating, plus internal decks, plus transverse
// bulkheads on the compartment boundaries so you are looking into a *space*
// rather than down the whole length of an empty shell. All of it carries
// `inside = 1`, which is the flag the shared body program reads to shade it as
// unpainted framed steel in the dark instead of as her side. That is why this
// costs one vertex attribute rather than a second WGSL program.
//
// The liner is drawn after the plating (`renderOrder`), so where the plating is
// whole the depth test throws the liner away before it is shaded. It is only
// paid for through the holes.
//
// The water inside her is the other half: one surface per compartment, held
// world-horizontal while she rolls, clipped to the hull's own section at
// whatever height the flooding model has filled it to.

const PLATE = 0.22; // how far the liner stands inside the skin, m
// How far in from the stem and the stern the end bulkheads stand, as a fraction
// of her length — far enough not to share a plane with the hull's own end caps.
const END_BULKHEAD = 0.014; // ~2.5 m
const NR = 23; // rings round a section — the same as the hull loft

// --- geometry helpers --------------------------------------------------------

// Both facings of a sheet. The ship's material is single-sided, so an internal
// deck built as one sheet vanishes when you look up at it from the deck below.
function twoSided(pos, idx) {
  const n = pos.length / 3;
  const p2 = new Float32Array(pos.length * 2);
  p2.set(pos, 0);
  p2.set(pos, pos.length);
  const i2 = new Uint32Array(idx.length * 2);
  for (let i = 0; i < idx.length; i++) i2[i] = idx[i];
  for (let i = 0; i < idx.length; i += 3) {
    i2[idx.length + i] = idx[i + 2] + n;
    i2[idx.length + i + 1] = idx[i + 1] + n;
    i2[idx.length + i + 2] = idx[i] + n;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(p2, 3));
  g.setIndex(new BufferAttribute(i2, 1));
  g.computeVertexNormals();
  return g;
}

// A deck inside the hull, between two stations, clipped to the hull's own
// half-breadth at its height.
//
// `yAt` is a *function* of the station, and it has to be. Take one height for
// the whole compartment — the height amidships, say — and the sheer will put
// the slab straight through the weather deck at the forward end of it: this
// hull's deck line rises five metres over her forward third, so a flat slab
// under the middle of the bow compartment stands a metre proud of the plank
// deck at its after end. What that looks like is a black rectangle laid across
// her forecastle, and it is worse than it sounds, because `sideAt` given a
// height above the sheer returns the *full* beam — so the rectangle runs right
// out to the deck edge on both sides.
//
// An interior deck follows the same curves the hull was lofted from, at a fixed
// distance under the deck above it or over the keel below it. Then it cannot
// escape, by construction, at any station.
function deckSlab(s0, s1, yAt, inset = 0.35) {
  const steps = Math.max(4, Math.round((s1 - s0) * 46));
  const pos = [];
  const idx = [];
  for (let i = 0; i <= steps; i++) {
    const s = s0 + ((s1 - s0) * i) / steps;
    const y = yAt(s);
    const half = Math.max(sideAt(s, y) - inset, 0.2);
    const z = (s - 0.5) * SHIP.length;
    pos.push(-half, y, z, half, y, z);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
  }
  return twoSided(new Float32Array(pos), idx);
}

// A transverse wall filling the section at a station, from the keel to the deck.
//
// `inset` is deliberately larger than the liner's own plate thickness: the wall
// has to finish clearly *inside* the shell, not on it. Land the two within a
// couple of centimetres of each other and the depth buffer cannot separate
// them, which shows up as the two surfaces flickering against each other along
// the turn of the bilge.
function bulkhead(s, inset = 0.38) {
  const z = (s - 0.5) * SHIP.length;
  const top = deckAt(s) - 0.1;
  const bot = -keelAt(s) + 0.3;
  const rows = 8;
  const cols = 9;
  const pos = [];
  const idx = [];
  for (let r = 0; r <= rows; r++) {
    const y = bot + ((top - bot) * r) / rows;
    const half = Math.max(sideAt(s, y) - inset, 0.15);
    for (let c = 0; c <= cols; c++) {
      pos.push(-half + (2 * half * c) / cols, y, z);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return twoSided(new Float32Array(pos), idx);
}

// The hull loft again, inset and turned inside out.
function linerSkin(sRange) {
  const NS = HULL_STATIONS;
  const i0 = Math.round(sRange[0] * (NS - 1));
  const i1 = Math.round(sRange[1] * (NS - 1));
  const rows = i1 - i0 + 1;
  const pos = new Float32Array(rows * NR * 3);
  // build the outer skin first, take its normals, then step inward along them
  const outer = [];
  for (let i = i0; i <= i1; i++) {
    const s = i / (NS - 1);
    for (let j = 0; j < NR; j++) outer.push(...section(s, j / (NR - 1)));
  }
  const tmp = new BufferGeometry();
  tmp.setAttribute('position', new BufferAttribute(new Float32Array(outer), 3));
  const tidx = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < NR - 1; j++) {
      const a = i * NR + j;
      const b = a + NR;
      tidx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  tmp.setIndex(tidx);
  tmp.computeVertexNormals();
  const nrm = tmp.getAttribute('normal').array;
  for (let k = 0; k < rows * NR; k++) {
    pos[k * 3] = outer[k * 3] - nrm[k * 3] * PLATE;
    pos[k * 3 + 1] = outer[k * 3 + 1] - nrm[k * 3 + 1] * PLATE;
    pos[k * 3 + 2] = outer[k * 3 + 2] - nrm[k * 3 + 2] * PLATE;
  }
  // reversed winding, so the inward faces are the front faces
  const idx = new Uint32Array(tidx.length);
  for (let i = 0; i < tidx.length; i += 3) {
    idx[i] = tidx[i + 2]; idx[i + 1] = tidx[i + 1]; idx[i + 2] = tidx[i];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// --- the liner ---------------------------------------------------------------

const RAW_STEEL = [0.115, 0.112, 0.105];

export function buildInterior({ materials }) {
  const group = new Group();
  group.name = 'ship.interior';
  const byCompartment = new Map();

  for (const cpt of COMPARTMENTS) {
    const slot = materials.slotOf(cpt.id);
    const geoms = [];
    const add = (g) => geoms.push(paint(g, {
      color: RAW_STEEL, roughness: 0.86, slot, metal: 0.5, inside: 1,
    }));

    add(linerSkin(cpt.s));

    // Decks. Three of them, and every one measured off the hull's own curves at
    // its own station rather than off a single height for the whole compartment
    // — see the note on `deckSlab` for what that costs.
    //
    //   * an inner bottom riding over the keel, which is the floor of the space
    //     the water you can see through a hole is standing in
    //   * a lower deck a little above the waterline
    //   * the deckhead: the underside of the weather deck, so that looking up
    //     through a hole in her side shows you a deck and not the sky
    //
    // The inner bottom follows the keel and the other two follow the sheer,
    // which is what they do on a ship: the tank top is parallel to the bottom
    // and the decks are parallel to each other.
    add(deckSlab(cpt.s[0], cpt.s[1], (s) => -keelAt(s) + 1.6));
    add(deckSlab(cpt.s[0], cpt.s[1], (s) => deckAt(s) - 3.4));
    add(deckSlab(cpt.s[0], cpt.s[1], (s) => deckAt(s) - 0.4, 0.15));

    // The bulkheads that make this a compartment rather than a length of tube.
    // Only the after one of each, so neighbours share a wall.
    //
    // The two on the very ends are pulled inboard a couple of metres. At station
    // 0 and station 1 the hull closes itself — the loft fans a cap across the
    // stern and another across the stem — so a bulkhead put there is a second
    // surface in the same plane as the first, and the depth buffer cannot
    // choose between them: what you see is a ragged black patch flickering
    // across her transom. Standing it two metres in gives it somewhere of its
    // own to be, and gives a shell that opens her counter something to find.
    add(bulkhead(Math.max(cpt.s[0], END_BULKHEAD)));
    if (cpt === COMPARTMENTS[COMPARTMENTS.length - 1]) {
      add(bulkhead(Math.min(cpt.s[1], 1 - END_BULKHEAD)));
    }

    // One draw call per compartment for the whole of its insides.
    const mesh = new Mesh(merge(geoms), materials.body);
    mesh.name = `interior.${cpt.id}`;
    mesh.frustumCulled = false;
    // after the plating, so where the plating is whole the depth test kills
    // this before it is ever shaded
    mesh.renderOrder = 1;
    mesh.castShadow = false;
    mesh.userData.noShadow = true;
    group.add(mesh);
    byCompartment.set(cpt.id, mesh);
  }

  return { group, byCompartment };
}

// --- the inside of the deckhouses --------------------------------------------
//
// The same argument as the hull liner, for the boxes standing on her deck. A
// deckhouse is a plate shell and nothing else, so a shell that opens its side
// shows you the far wall — which is facing away and is culled — and then the
// sky beyond that. A hole you can see daylight through does not read as a hole
// in a building; it reads as the building not being there. That is most of why
// "holes only appear in the deck": the deck has this behind it and the
// superstructure did not.
//
// One inverted shell inset by the plating, a floor at the level a deck would be
// on, and a bulkhead across the middle so the space has an end to it. Drawn
// after the plating like the hull liner, so it costs nothing until something
// opens a way in.
const HOUSES = () => [
  { id: 'deckhouses', w: SUPER.funnelDeck.w, h: SUPER.funnelDeck.h, l: SUPER.funnelDeck.l,
    y: deckAt(SUPER.funnelDeck.z + 0.5), z: SUPER.funnelDeck.z },
  { id: 'deckhouses', w: SUPER.aftSuper.w, h: SUPER.aftSuper.h, l: SUPER.aftSuper.l,
    y: deckAt(SUPER.aftSuper.z + 0.5), z: SUPER.aftSuper.z },
  // the pagoda's base blockhouse — the same two boxes the colliders carry
  { id: 'bridge', w: 17, h: 4, l: 21, y: deckAt(SUPER.bridge.z + 0.5), z: SUPER.bridge.z, dz: -1 },
];

// Turn a box outside-in: reverse each triangle and flip its normals, so what is
// drawn is the inside of the far wall rather than the outside of the near one.
function inward(g) {
  const a = g.getIndex().array;
  for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
  const n = g.getAttribute('normal').array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return g;
}

export function buildDeckhouseInteriors({ materials }) {
  const group = new Group();
  group.name = 'ship.interior.houses';
  const geoms = [];

  for (const b of HOUSES()) {
    const slot = materials.slotOf(b.id);
    const add = (g) => geoms.push(paint(g, {
      color: RAW_STEEL, roughness: 0.86, slot, metal: 0.5, inside: 1, plate: 1,
    }));
    const cy = b.y + b.h / 2;
    const cz = (b.z * SHIP.length) + (b.dz || 0);
    const g = inward(new BoxGeometry(b.w - 2 * PLATE, b.h - 2 * PLATE, b.l - 2 * PLATE));
    g.translate(0, cy, cz);
    add(g);
    // A flat at the height a deck would be, and one bulkhead across her, so a
    // hole looks into a compartment instead of into a crate. Thin slabs rather
    // than sheets because a slab is closed and reads right from either side.
    const flat = new BoxGeometry(b.w - 2 * PLATE, 0.16, b.l - 2 * PLATE);
    flat.translate(0, b.y + b.h * 0.55, cz);
    add(flat);
    const bhd = new BoxGeometry(b.w - 2 * PLATE, b.h - 2 * PLATE, 0.16);
    bhd.translate(0, cy, cz + b.l * 0.12);
    add(bhd);
  }

  const mesh = new Mesh(merge(geoms), materials.body);
  mesh.name = 'interior.deckhouses';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.userData.noShadow = true;
  group.add(mesh);
  return { group, mesh };
}

// --- the water in her --------------------------------------------------------

// The half-breadth of the hull skin at station `s` and hull-local height `y`,
// in TSL. The JS twin is `sideAt` in hull.js; the two are inverting the same
// section curve and have to stay in step.
function sideAtTSL(s, y) {
  const b = hullTSL.halfBeam(s);
  const d = hullTSL.keel(s);
  const top = hullTSL.deck(s);
  const ratio = saturate(top.sub(y).div(max(top.add(d), 0.01)));
  const u = pow(max(float(1).sub(pow(ratio, float(2).div(hullTSL.pow(s)))), 0), 0.5);
  return b.mul(u);
}

// One flooded compartment's water surface.
//
// It has to be world-horizontal while the ship rolls under it, and it has to
// stop exactly at the plating. Both are done in the vertex shader. `plane` is
// that world-horizontal surface written in the *ship's* frame — the ship-local
// height of the water over a point is `plane.z + plane.x * x + plane.y * z`, a
// plane whose tilt is simply her heel and trim — and the athwartships
// coordinate is a fraction of the hull's own half-breadth at the height that
// lands on.
//
// The circularity (the breadth depends on the height, the height depends on the
// breadth) is resolved by doing it twice. At any heel a ship can survive, the
// second pass is already right to a few centimetres.
//
// One material for all five compartments: `plane` is a per-object uniform read
// off `userData`, which is what keeps five different water levels on one
// program. Five materials would be five compiles of this graph, which is the
// same mistake the ship is built around not making.
export function createFloodWater({ shading }) {
  const material = new MeshBasicNodeMaterial();

  const plane = uniform(new Vector3(0, 0, -1000)).onObjectUpdate(function (frame) {
    const p = frame.object.userData.floodPlane;
    if (p) this.value.copy(p); else this.value.set(0, 0, -1000);
  });

  material.positionNode = Fn(() => {
    const u = positionLocal.x; // -1 .. 1 across
    const z = positionLocal.z;
    const s = z.div(SHIP.length).add(0.5).toVar();
    const level = (x) => plane.z.add(plane.x.mul(x)).add(plane.y.mul(z));
    const y0 = level(u.mul(hullTSL.halfBeam(s))).toVar();
    const x1 = u.mul(sideAtTSL(s, y0)).toVar();
    const y1 = level(x1).toVar();
    // The surface is never quite flat. Free water in a hull sloshes on a long
    // period, and that slow heave is most of what makes it read as liquid
    // rather than as a dark sheet stretched across a hole.
    const w = sin(z.mul(0.17).add(shading.time.mul(1.05))).mul(0.13)
      .add(sin(x1.mul(0.55).sub(shading.time.mul(1.7))).mul(0.06));
    return vec3(x1, y1.add(w), z);
  })();

  material.colorNode = Fn(() => {
    const N = normalize(vec3(
      sin(positionWorld.z.mul(0.85).add(shading.time.mul(2.1))).mul(0.07),
      1,
      sin(positionWorld.x.mul(1.05).sub(shading.time.mul(1.6))).mul(0.07),
    ));
    const V = normalize(cameraPosition.sub(positionWorld));
    const R = reflect(V.negate(), N);
    const sky = skyColor(normalize(vec3(R.x, max(R.y, 0.03), R.z)), shading, float(1));
    // Oily black. Water in a hull is not the sea: it is in the dark, it has fuel
    // and paint floating on it, and there is nothing beneath it to scatter any
    // light back up.
    const bodyCol = vec3(0.014, 0.020, 0.021);
    const fres = float(0.02).add(float(0.98).mul(pow(float(1).sub(saturate(dot(N, V))), 5)));
    const col = mix(bodyCol, sky.mul(0.45), saturate(fres.mul(0.85)));
    // scum, so the surface has something on it to read as a surface when it has
    // nothing to reflect
    const film = smoothstep(float(0.55), float(0.92),
      abs(fract(positionWorld.x.mul(0.21).add(positionWorld.z.mul(0.13))).sub(0.5)).mul(2));
    return vec4(col.add(vec3(0.020, 0.018, 0.012).mul(film)), 1);
  })();

  return material;
}

// One surface per compartment, all on the one program above.
export function buildFloodWater({ shading }) {
  const group = new Group();
  group.name = 'ship.flood';
  const material = createFloodWater({ shading });
  const byCompartment = new Map();

  for (const cpt of COMPARTMENTS) {
    const steps = Math.max(4, Math.round((cpt.s[1] - cpt.s[0]) * 40));
    const cols = 8;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= steps; i++) {
      const s = cpt.s[0] + ((cpt.s[1] - cpt.s[0]) * i) / steps;
      const z = (s - 0.5) * SHIP.length;
      for (let c = 0; c <= cols; c++) pos.push(-1 + (2 * c) / cols, 0, z);
    }
    for (let i = 0; i < steps; i++) {
      for (let c = 0; c < cols; c++) {
        const a = i * (cols + 1) + c;
        const b = a + cols + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1); // wound to face up
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    const mesh = new Mesh(g, material);
    mesh.name = `flood.${cpt.id}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.userData.noShadow = true;
    mesh.userData.floodPlane = new Vector3(0, 0, -1000);
    group.add(mesh);
    byCompartment.set(cpt.id, mesh);
  }
  return { group, byCompartment, material };
}
