import {
  Group, Mesh, BufferGeometry, BufferAttribute, BoxGeometry, CylinderGeometry,
  Color, Vector3,
} from 'three/webgpu';
import {
  float as tslFloat, sin as tslSin, pow as tslPow, max as tslMax, smoothstep as tslSmoothstep,
} from 'three/tsl';
import { createBoatMaterial, createDeckMaterial } from './boatMaterial.js';

const UP = new Vector3(0, 1, 0);

// A lofted planing hull, built station by station. Local frame matches the
// physics: +x starboard, +y up, +z forward, origin at the centre of mass (which
// sits roughly on the design waterline, so y=0 is the boot top).
// Sized as a ~16 m motor yacht. That is deliberate: the default sea state is a
// 16 m/s wind, and anything much smaller spends the whole time green-water
// swamped, which hides the buoyancy response rather than showing it off.
export const HULL = {
  length: 16.5,
  halfBeam: 2.9,
  depth: 3.0, // hull depth, used for the inertia estimate
  deck: 1.65, // freeboard amidships
  keel: 1.35, // draft at the deepest station
};

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// beam falls away at the transom a little and tapers to a stem at the bow.
// Exported so the spray can launch off the actual hull side rather than from
// somewhere under the centreline.
export const halfBeamAt = (s) => {
  const stern = 0.74 + 0.26 * smoothstep(0, 0.2, s);
  const bow = Math.max(1 - Math.pow(Math.max(0, (s - 0.55) / 0.45), 1.7), 0.03);
  return HULL.halfBeam * stern * bow;
};

// TSL twins of the section curves, for the ocean's hull-foam shader, which
// needs the same waterline on the GPU. Kept next to the originals so the two
// cannot drift apart.
export const hullTSL = {
  halfBeam: (s) => tslFloat(HULL.halfBeam)
    .mul(tslFloat(0.74).add(tslSmoothstep(tslFloat(0), tslFloat(0.2), s).mul(0.26)))
    .mul(tslMax(tslFloat(1).sub(tslPow(tslMax(s.sub(0.55).div(0.45), 0), 1.7)), 0.03)),
  keel: (s) => tslFloat(HULL.keel)
    .mul(tslFloat(0.6).add(tslSin(s.mul(Math.PI)).mul(0.4)))
    .mul(tslFloat(1).sub(tslSmoothstep(tslFloat(0.75), tslFloat(1), s).mul(0.55))),
  deck: (s) => tslFloat(HULL.deck).add(tslPow(s.sub(0.42).abs().div(0.58), 2).mul(0.55)),
  pow: () => tslFloat(1.5),
};

// deepest amidships, lifting toward the stem so the bow rides over water
const keelAt = (s) => HULL.keel * (0.6 + 0.4 * Math.sin(Math.PI * s)) * (1 - 0.55 * smoothstep(0.75, 1, s));

// sheer line: freeboard rises toward both ends, hardest at the bow
const deckAt = (s) => HULL.deck + 0.55 * Math.pow(Math.abs(s - 0.42) / 0.58, 2);

// hull section: sweep theta across the beam, cos^p sets how V-shaped it is
function section(s, u) {
  const th = (u - 0.5) * Math.PI;
  const b = halfBeamAt(s);
  const d = keelAt(s);
  const y = deckAt(s);
  return [b * Math.sin(th), y - (y + d) * Math.pow(Math.cos(th), 1.5), (s - 0.5) * HULL.length];
}

const ANTIFOUL = new Color(0x6d2f28);
const BOOT = new Color(0x141a20);
const TOPSIDE = new Color(0xeef2f5);

// waterline paint: antifoul below, a dark boot stripe at the line, white above
function hullColor(y, out) {
  if (y < -0.06) out.copy(ANTIFOUL);
  else if (y < 0.16) out.copy(BOOT);
  else out.copy(TOPSIDE);
  return out;
}

function buildHull() {
  const NS = 26; // stations bow-to-stern
  const NR = 15; // points around each section

  const pos = [];
  const col = [];
  const idx = [];
  const c = new Color();

  const push = (p) => {
    pos.push(p[0], p[1], p[2]);
    hullColor(p[1], c);
    col.push(c.r, c.g, c.b);
  };

  for (let i = 0; i < NS; i++) {
    const s = i / (NS - 1);
    for (let j = 0; j < NR; j++) push(section(s, j / (NR - 1)));
  }
  // wound so the normals face out of the hull: +u runs port->starboard and +s
  // runs aft->forward, so (u, s) as the triangle's first two edges points inward
  for (let i = 0; i < NS - 1; i++) {
    for (let j = 0; j < NR - 1; j++) {
      const a = i * NR + j;
      const b = a + NR;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  // transom: fan the stern-most section around its own centre
  const capCentre = (i, dir) => {
    let cx = 0; let cy = 0; let cz = 0;
    for (let j = 0; j < NR; j++) {
      cx += pos[(i * NR + j) * 3];
      cy += pos[(i * NR + j) * 3 + 1];
      cz += pos[(i * NR + j) * 3 + 2];
    }
    const base = pos.length / 3;
    push([cx / NR, cy / NR, cz / NR]);
    // Wrap all the way round: a section runs port sheer -> keel -> starboard
    // sheer, so the closing edge is the straight deck line between the two sheer
    // points. Stopping at NR-1 leaves that span unfilled, which on the transom
    // is a hole the full width of the boat.
    for (let j = 0; j < NR; j++) {
      const a = i * NR + j;
      const b = i * NR + ((j + 1) % NR);
      if (dir > 0) idx.push(base, a, b);
      else idx.push(base, b, a);
    }
  };
  capCentre(0, -1); // transom, facing aft
  capCentre(NS - 1, 1); // stem, facing forward

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// flat deck spanning the two sheer lines, as its own geometry so it can be teak
function buildDeck() {
  const NS = 26;
  const pos = [];
  const idx = [];
  for (let i = 0; i < NS; i++) {
    const s = i / (NS - 1);
    const p = section(s, 0);
    const q = section(s, 1);
    pos.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  }
  for (let i = 0; i < NS - 1; i++) {
    const a = i * 2; // a = port, a+1 = starboard
    idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); // normals up
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createBoatMesh(shading) {
  const group = new Group();
  const mk = (o) => createBoatMaterial({ ...shading, ...o });

  group.add(new Mesh(buildHull(), mk({ roughness: 0.32 }))); // vertex-coloured
  group.add(new Mesh(buildDeck(), createDeckMaterial({
    ...shading, color: [0.66, 0.47, 0.25], roughness: 0.7, planks: 0.17, grain: 0.09,
  })));

  // The wheelhouse sits aft of amidships so there is a real foredeck in front of
  // it; without that the boat reads as a box with a point on it.
  const CABIN_S = 0.40; // station the wheelhouse is centred on
  const deckY = deckAt(CABIN_S);
  const cabinZ = (CABIN_S - 0.5) * HULL.length;
  const cabinW = 1.24 * HULL.halfBeam;
  const cabinL = 0.30 * HULL.length;
  const cabinH = 1.75;

  const cabinMat = mk({ color: [0.95, 0.96, 0.97], roughness: 0.38, });
  const cabin = new Mesh(new BoxGeometry(cabinW, cabinH, cabinL), cabinMat);
  cabin.position.set(0, deckY + cabinH / 2, cabinZ);
  group.add(cabin);

  // glass band just under the roof, standing a hair proud of the cabin sides
  const glassMat = mk({ color: [0.06, 0.1, 0.13], roughness: 0.06, });
  const glass = new Mesh(new BoxGeometry(cabinW * 1.01, 0.62, cabinL * 1.005), glassMat);
  glass.position.set(0, deckY + cabinH - 0.5, cabinZ);
  group.add(glass);

  // a modest eyebrow, not a slab — a wide overhang dominates the whole boat
  const roofMat = mk({ color: [0.86, 0.89, 0.91], roughness: 0.42, grain: 0.06 });
  const roof = new Mesh(new BoxGeometry(cabinW * 1.04, 0.12, cabinL * 1.05), roofMat);
  roof.position.set(0, deckY + cabinH + 0.06, cabinZ);
  group.add(roof);

  const mastMat = mk({ color: [0.78, 0.81, 0.83], roughness: 0.3, });
  const mast = new Mesh(new CylinderGeometry(0.05, 0.08, 3.0, 8), mastMat);
  mast.position.set(0, deckY + cabinH + 1.6, cabinZ - cabinL * 0.3);
  group.add(mast);

  // guard rail along the foredeck sheer — the top wire is what actually reads
  const railMat = mk({ color: [0.72, 0.76, 0.78], roughness: 0.25, });
  const railH = 0.78;
  for (const side of [0, 1]) {
    const pts = [];
    for (let i = 0; i <= 7; i++) {
      const s = 0.56 + i * (0.42 / 7);
      pts.push(section(s, side));
    }
    pts.forEach((p, i) => {
      if (i % 2 === 0 && i < pts.length - 1) {
        const st = new Mesh(new CylinderGeometry(0.035, 0.035, railH, 6), railMat);
        st.position.set(p[0], p[1] + railH / 2, p[2]);
        group.add(st);
      }
      // wire segment to the next stanchion position
      if (i < pts.length - 1) {
        const q = pts[i + 1];
        const d = new Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        const wire = new Mesh(new CylinderGeometry(0.022, 0.022, d.length(), 5), railMat);
        wire.position.set((p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + railH, (p[2] + q[2]) / 2);
        wire.quaternion.setFromUnitVectors(UP, d.normalize());
        group.add(wire);
      }
    });
  }

  group.traverse((o) => {
    o.frustumCulled = false;
    if (o.isMesh) o.castShadow = true; // she throws a shadow onto the sea
  });
  return group;
}

// what the physics and the ocean shader need to know about this hull
export const hullDescriptor = {
  length: HULL.length,
  halfBeam: HULL.halfBeam,
  keel: HULL.keel,
  deck: HULL.deck,
  depth: HULL.depth,
  halfBeamAt,
  tsl: hullTSL,
};
