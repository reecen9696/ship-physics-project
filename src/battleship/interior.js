import {
  BufferGeometry, BufferAttribute, Group, Mesh, MeshBasicNodeMaterial, Vector3,
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
import { SHIP, COMPARTMENTS } from './spec.js';

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

// A horizontal slab inside the hull, between two stations, clipped to the
// hull's own half-breadth at its height. This is what a deck is: a floor that
// meets the shell, so its edge has to follow the section curve or you can see
// daylight between it and the plating.
function deckSlab(s0, s1, y, inset = 0.35) {
  const steps = Math.max(3, Math.round((s1 - s0) * 34));
  const pos = [];
  const idx = [];
  for (let i = 0; i <= steps; i++) {
    const s = s0 + ((s1 - s0) * i) / steps;
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
function bulkhead(s, inset = 0.25) {
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

    // Decks. Two of them: an inner bottom well down in the hull, and a lower
    // deck a little above the waterline. Between them is where the water you
    // can see through a hole in her side actually is.
    const mid = (cpt.s[0] + cpt.s[1]) / 2;
    const top = deckAt(mid);
    const bot = -keelAt(mid);
    add(deckSlab(cpt.s[0], cpt.s[1], bot + 1.6));
    add(deckSlab(cpt.s[0], cpt.s[1], top - 3.4));
    // and the deckhead: the underside of the weather deck, so looking up
    // through a hole in the side does not show the sky
    add(deckSlab(cpt.s[0], cpt.s[1], top - 0.3, 0.15));

    // The bulkheads that make it a compartment rather than a tube. Only the
    // forward one of each, so neighbours share a wall.
    add(bulkhead(cpt.s[0]));
    if (cpt === COMPARTMENTS[COMPARTMENTS.length - 1]) add(bulkhead(cpt.s[1]));

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
