import {
  BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Group, Mesh,
  Quaternion, SphereGeometry, TorusGeometry, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import {
  SHIP, SUPER, TURRETS, TURRET_SPEC, AA_MOUNTS, AA_SPEC, COMPARTMENTS,
} from './spec.js';
import { deckY, zOf, halfBeamAt, STEEL, STEEL_DARK } from './hull.js';
import { PLAYER } from '../player/spec.js';

// The things lying about on her weather deck.
//
// Everything else on this ship was drawn to be looked at from a mile away. This
// file is the first that is drawn to be looked at from a metre, because it is
// what a person standing on the deck actually sees: a deck with nothing on it is
// a floor, and a floor is the one thing that tells you immediately you are in a
// model rather than on a ship. Eight things fix that — a vent cowl, a mushroom
// head, an oil drum, a crate, two kinds of hatch, a set of bitts and a fairlead
// — and between them they do four jobs at once. They give the eye something at
// human scale to measure the deck against; they break the sightline so the deck
// has near, middle and far in it; they give the camera something to rise over,
// which is what makes 0.25 m of coaming worth more than any amount of texture;
// and they say what each part of the ship is *for*, because ventilation stands
// where the machinery is and mooring gear stands at the ends.
//
// --- what these are made of --------------------------------------------------
//
// Procedural, like everything else she is built from, and for the same two
// reasons. The ship is one shader program with the part's colour, roughness,
// metalness and damage slot baked into vertex attributes (shipMaterial.js), so a
// loaded model is a model that does not scorch, does not char, does not take the
// waterline paint, and costs its own WGSL compile. And a prop that is a lathe
// and six boxes can be *placed* against curves the hull is lofted from rather
// than eyeballed onto it. The reference models were used for proportion and for
// what detail is worth having up close — the rolling hoops on a drum, the corner
// battens on a crate, the dark throat inside a cowl — and none of them for
// geometry.
//
// --- static, and why that is not a compromise --------------------------------
//
// The design note asks for eight to ten dynamic bodies: drums that roll to
// leeward as she heels. There is no rigid-body solver in this project — the
// player is a point query against an analytic field (player/character.js) and
// wreckage is its own integrator (wreck.js) — so nothing here is dynamic and
// nothing here is replicated.
//
// What it does instead is go through the wreck integrator, exactly as the
// guardrail does: a shell landing on the waist throws the drums and crates
// around it off the ship as bodies with their own trajectories, and they land on
// her, slide, and go over the side when she rolls. That is §8's drama — props
// scattering wider than people do, tumbling rather than sliding — bought with
// the machinery that already exists, and it costs nothing at all in the steady
// state, which twelve sleeping rigid bodies would not.
//
// --- what they are solid to ---------------------------------------------------
//
// The player, and only the player. Their collision boxes go into
// player/deckAccess.js rather than into colliders.js, for the reason stated at
// the head of that file: wreckage and the third-person camera must not start
// resting on a ladder, and they must not start resting on a crate either. A
// falling funnel goes through the drums, which nobody will ever see, and the
// camera does not shove itself sideways every time it passes a vent, which
// everybody would.
//
// Nothing here is taller than the ship needs it to be, and the two rules that
// keeps are the ones that decide whether a deck is walkable: everything under
// PLAYER.stepUp (0.45 m) is walked over without the player noticing, and
// everything over it stands against the superstructure, against the deck edge,
// or in a cluster with a route round it. `assertClearance` below checks the
// second of those against the hull's own curves at build time, so a prop moved
// two metres outboard in six months' time fails loudly rather than quietly
// walling somebody in.

const L = SHIP.length;

// --- dimensions ---------------------------------------------------------------
// Real sizes, in metres. A 200 litre drum is 0.88 by 0.58 and nothing here is
// scaled up to be seen, because at a metre away everything is seen.
export const PROP = {
  cowl: {
    h: 1.79, trunkR: 0.25, bellR: 0.35, wall: 0.028, bend: 0.42, riseTo: 1.02,
  },
  mushroom: { h: 0.90, trunkR: 0.225, capR: 0.40, louvre: 0.15 },
  // Larger than the 200 litre drum they are drawn from, deliberately. They are
  // the only object on this deck that is a hazard as well as a prop — see
  // `cookOff` below — and a thing that goes off has to be readable as a thing
  // that goes off from further away than a real drum is readable at all.
  drum: { h: 1.02, r: 0.335 },
  crate: { w: 0.90, h: 0.70, d: 0.90, batten: 0.075 },
  hatch: { w: 1.20, d: 0.90, coaming: 0.25, wall: 0.08, lid: 1.00 },
  scuttle: { r: 0.40, coaming: 0.20, wall: 0.06 },
  bitts: { baseW: 1.40, baseD: 0.60, postR: 0.175, postH: 0.60, spread: 0.42 },
  fairlead: { w: 0.55, h: 0.42, d: 0.30, throatW: 0.30, throatH: 0.20 },
};

// The one number that decides whether the deck is a working ship or an obstacle
// course: how much clear deck has to be left outboard of anything standing on a
// side deck. A person is 0.68 m across, so this is a shoulder and a half.
const LANE = 1.5;

// --- colours ------------------------------------------------------------------
// Drums are the only things aboard that are allowed to be a colour. Everything
// else on this ship is Kure grey, and three drums in oxide red against it are
// worth more to the eye than any amount of variation in the grey would be.
const TIMBER = [0.255, 0.190, 0.120];
const TIMBER_DARK = [0.185, 0.135, 0.085];
const ROPE = [0.46, 0.40, 0.28];
const THROAT = [0.30, 0.105, 0.085]; // the inside of a cowl bell: red lead
// All red, and brighter than paint on a warship has any business being. That is
// the point: everything else on this deck is Kure grey, so red is not a colour
// here, it is a word — and the word is that the drum is full of something that
// burns. The three shades are only so a group of them does not read as one
// object stamped out three times.
const DRUM_PAINT = [
  [0.66, 0.115, 0.075],
  [0.58, 0.145, 0.095],
  [0.72, 0.170, 0.090],
];

// --- a seeded generator -------------------------------------------------------
//
// Placement is jittered, and the jitter has to be the *same* jitter twice: once
// when the meshes are built and once when player/deckAccess.js asks for the
// collision boxes, with a headless probe run (probe-deck.mjs) in between that
// has no materials and no device. Math.random would put the boxes somewhere the
// props are not, which is the sort of bug that takes a day to see.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- geometry helpers ---------------------------------------------------------

const _t = new Vector3();
const _n = new Vector3();
const _b = new Vector3();
const _prev = new Vector3();

// A tube of varying radius swept along a path, with the frame parallel
// transported so it does not twist. This is the one shape three.js does not
// have and the one shape three of these props need: a cowl is a tube that bends
// through ninety degrees while it flares, and a lashing is a closed loop of rope
// round a stack of crates.
//
// Built with a uv, which matters more than it looks: `merge` takes its attribute
// list from the first geometry in the batch, so a geometry missing one that the
// primitives have cannot be merged with them.
function sweepTube(points, radii, radial = 12, closed = false, caps = false) {
  const n = points.length;
  const rings = [];
  const tangents = [];
  for (let i = 0; i < n; i++) {
    const a = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    tangents.push(new Vector3().subVectors(b, a).normalize());
  }
  // a starting normal: any unit vector not parallel to the first tangent
  const t0 = tangents[0];
  _n.set(0, 1, 0);
  if (Math.abs(_n.dot(t0)) > 0.9) _n.set(1, 0, 0);
  _n.addScaledVector(t0, -_n.dot(t0)).normalize();
  _prev.copy(_n);

  const pos = [];
  const uv = [];
  for (let i = 0; i < n; i++) {
    _t.copy(tangents[i]);
    // parallel transport: the previous normal, with whatever component the new
    // tangent has taken of it removed
    _n.copy(_prev).addScaledVector(_t, -_prev.dot(_t));
    if (_n.lengthSq() < 1e-8) _n.set(_t.y, -_t.x, 0);
    _n.normalize();
    _prev.copy(_n);
    _b.crossVectors(_t, _n);
    const p = points[i];
    const r = radii[i];
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pos.push(
        p.x + r * (c * _n.x + s * _b.x),
        p.y + r * (c * _n.y + s * _b.y),
        p.z + r * (c * _n.z + s * _b.z),
      );
      uv.push(k / radial, i / (n - 1));
    }
  }
  const idx = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const a = i * (radial + 1);
    const c = ((i + 1) % n) * (radial + 1);
    for (let k = 0; k < radial; k++) {
      // wound so the skin faces outward: the frame (normal, binormal, tangent)
      // is right-handed, so the ring's own winding has to run the other way
      idx.push(a + k, a + k + 1, c + k, a + k + 1, c + k + 1, c + k);
    }
  }
  if (caps && !closed) {
    for (const [i, flip] of [[0, false], [n - 1, true]]) {
      const centre = pos.length / 3;
      pos.push(points[i].x, points[i].y, points[i].z);
      uv.push(0.5, 0.5);
      const a = i * (radial + 1);
      for (let k = 0; k < radial; k++) {
        if (flip) idx.push(centre, a + k + 1, a + k);
        else idx.push(centre, a + k, a + k + 1);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// The same tube turned inside out: same path, a wall thickness less radius,
// wound the other way so it is the *inside* you are looking at. This is what
// makes a cowl read as an opening rather than as a lump — a bell mouth with no
// throat behind it is a spoon.
function invert(geometry) {
  const idx = geometry.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t; }
  const nrm = geometry.getAttribute('normal').array;
  for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i];
  return geometry;
}

// A closed loop of rope lying in a plane: a rounded rectangle `w` by `h`, swept
// at `tube`. `plane` is which two axes it lies in.
function ropeLoop(w, h, tube, plane, cornerR = 0.09) {
  const pts = [];
  const hw = w / 2 - cornerR;
  const hh = h / 2 - cornerR;
  // the four corner arcs, walked in order, which is the loop
  const corners = [[+hw, +hh], [-hw, +hh], [-hw, -hh], [+hw, -hh]];
  for (let c = 0; c < 4; c++) {
    const [cx, cy] = corners[c];
    for (let k = 0; k < 3; k++) {
      const a = (c * Math.PI) / 2 + (k / 3) * (Math.PI / 2);
      const px = cx + Math.cos(a) * cornerR;
      const py = cy + Math.sin(a) * cornerR;
      pts.push(plane === 'xy' ? new Vector3(px, py, 0)
        : plane === 'zy' ? new Vector3(0, py, px)
          : new Vector3(px, 0, py));
    }
  }
  return sweepTube(pts, pts.map(() => tube), 6, true);
}

// --- the eight models ---------------------------------------------------------
//
// Each returns an array of painted geometries in its own local frame, standing
// on y = 0 and — where it has a front — facing +z. The caller turns and places
// them; nothing here knows where on the ship it is going.

function paintAll(parts, slot) {
  return parts.map(([g, o]) => paint(g, { slot, ...o }));
}

// 4.1a Swan-neck ventilator cowl.
//
// The most valuable object on the deck, and the one worth the most triangles: a
// straight trunk, a ninety-degree bend that flares as it turns, and a bell mouth
// with a red-leaded throat behind it. Nothing else aboard is this legible at
// this size — you know what it is, and therefore how big it is, from any angle
// and any distance.
function swanNeck(slot) {
  const C = PROP.cowl;
  const pts = [];
  const rad = [];
  const RISE = 4;
  for (let i = 0; i < RISE; i++) {
    pts.push(new Vector3(0, (i / RISE) * C.riseTo, 0));
    rad.push(C.trunkR);
  }
  const ARC = 6;
  for (let i = 0; i <= ARC; i++) {
    const a = (i / ARC) * (Math.PI / 2);
    pts.push(new Vector3(0, C.riseTo + C.bend * Math.sin(a), C.bend - C.bend * Math.cos(a)));
    // the flare is all in the last third of the bend, the way a spun bell is
    rad.push(C.trunkR + (C.bellR - C.trunkR) * 0.55 * (i / ARC) ** 2.4);
  }
  // and the mouth itself, which opens quickly
  const lipY = C.riseTo + C.bend;
  for (let i = 1; i <= 2; i++) {
    pts.push(new Vector3(0, lipY, C.bend + 0.09 * i));
    rad.push(C.trunkR + (C.bellR - C.trunkR) * (0.55 + 0.45 * (i / 2) ** 0.6));
  }

  const outer = sweepTube(pts, rad, 12);
  const inner = invert(sweepTube(pts, rad.map((r) => r - C.wall), 12));
  // the lip: an annulus closing the gap between the two skins at the mouth
  const lip = new TorusGeometry(C.bellR - C.wall / 2, C.wall / 2, 4, 14);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, lipY, pts[pts.length - 1].z);

  const flange = new CylinderGeometry(C.trunkR + 0.09, C.trunkR + 0.11, 0.09, 14);
  flange.translate(0, 0.045, 0);
  // the clamp band the cowl turns in — it is trimmed into the wind by hand, and
  // the band is what says so
  const band = new TorusGeometry(C.trunkR + 0.025, 0.032, 4, 14);
  band.rotateX(Math.PI / 2);
  band.translate(0, 0.34, 0);
  // a grille across the trunk, seen looking down the throat
  const bars = [];
  for (let k = -1; k <= 1; k++) {
    const bar = new BoxGeometry(C.trunkR * 2 - 0.06, 0.02, 0.035);
    bar.translate(0, 0.62, k * 0.11);
    bars.push(bar);
  }

  return paintAll([
    [outer, { color: STEEL, roughness: 0.46 }],
    [inner, { color: THROAT, roughness: 0.62, metal: 0.4, plate: 0 }],
    [lip, { color: STEEL_DARK, roughness: 0.4 }],
    [flange, { color: STEEL_DARK, roughness: 0.44 }],
    [band, { color: STEEL_DARK, roughness: 0.38 }],
    ...bars.map((g) => [g, { color: [0.10, 0.11, 0.12], roughness: 0.6 }]),
  ], slot);
}

// 4.1b Mushroom vent. The filler: half the height, so it dresses a deck without
// taking a sightline away from it.
function mushroomVent(slot) {
  const M = PROP.mushroom;
  const trunkH = M.h - M.louvre - 0.16;
  const trunk = new CylinderGeometry(M.trunkR, M.trunkR, trunkH, 14);
  trunk.translate(0, trunkH / 2, 0);
  const flange = new CylinderGeometry(M.trunkR + 0.08, M.trunkR + 0.10, 0.08, 14);
  flange.translate(0, 0.04, 0);
  // The louvre gap. What makes a mushroom head read as a vent and not as a
  // bollard with a hat is that you can see daylight through the ring under the
  // cap — so it is a ring of posts with air between them, not a cylinder.
  const posts = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const p = new BoxGeometry(0.055, M.louvre, 0.045);
    p.rotateY(-a);
    p.translate(Math.cos(a) * (M.trunkR + 0.03), trunkH + M.louvre / 2, Math.sin(a) * (M.trunkR + 0.03));
    posts.push(p);
  }
  // The cap is a spun dome, not a plate. Flatten it much past this and the whole
  // thing reads as a bollard with a lid on rather than as a mushroom head — the
  // dome is the entire silhouette.
  const cap = new SphereGeometry(M.capR, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.62, 1);
  cap.translate(0, trunkH + M.louvre, 0);
  const rim = new TorusGeometry(M.capR - 0.01, 0.035, 4, 16);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, trunkH + M.louvre + 0.005, 0);
  const skirt = new CylinderGeometry(M.capR - 0.02, M.capR - 0.02, 0.05, 16, 1, true);
  skirt.translate(0, trunkH + M.louvre + 0.02, 0);

  return paintAll([
    [trunk, { color: STEEL, roughness: 0.46 }],
    [flange, { color: STEEL_DARK, roughness: 0.44 }],
    ...posts.map((g) => [g, { color: STEEL_DARK, roughness: 0.42 }]),
    [cap, { color: STEEL, roughness: 0.44 }],
    [rim, { color: STEEL_DARK, roughness: 0.38 }],
    [skirt, { color: [0.10, 0.11, 0.12], roughness: 0.7, plate: 0 }],
  ], slot);
}

// 4.2a A 200 litre drum.
//
// Two rolling hoops and two chime rims, and they are the whole model: take them
// off and you have a cylinder, which reads as a bollard or a bucket or nothing
// at all. A drum is one of about four objects a person can identify from its
// silhouette alone, and the silhouette is the hoops.
function oilDrum(slot, variant = 0) {
  const D = PROP.drum;
  const bodyH = D.h - 0.08;
  const body = new CylinderGeometry(D.r, D.r, bodyH, 18);
  body.translate(0, D.h / 2, 0);
  const parts = [[body, { color: DRUM_PAINT[variant % DRUM_PAINT.length], roughness: 0.52, metal: 0.55 }]];
  for (const y of [0.045, D.h - 0.045]) {
    const chime = new TorusGeometry(D.r - 0.012, 0.036, 5, 18);
    chime.rotateX(Math.PI / 2);
    chime.translate(0, y, 0);
    parts.push([chime, { color: STEEL_DARK, roughness: 0.42, metal: 0.7 }]);
  }
  for (const y of [D.h * 0.35, D.h * 0.65]) {
    const hoop = new TorusGeometry(D.r + 0.005, 0.026, 5, 18);
    hoop.rotateX(Math.PI / 2);
    hoop.translate(0, y, 0);
    parts.push([hoop, { color: STEEL_DARK, roughness: 0.45, metal: 0.6 }]);
  }
  const bung = new CylinderGeometry(0.052, 0.052, 0.022, 8);
  bung.translate(0.16, D.h - 0.012, 0.05);
  parts.push([bung, { color: [0.42, 0.40, 0.34], roughness: 0.35, metal: 0.8 }]);
  return paintAll(parts, slot);
}

// 4.2b A crate. Boarded, not moulded: a core of boards with the framing outside
// it, which is the only way the corner light reads right at half a metre.
function crate(slot) {
  const C = PROP.crate;
  const b = C.batten;
  const core = new BoxGeometry(C.w - b, C.h - b * 0.6, C.d - b);
  core.translate(0, C.h / 2, 0);
  const parts = [[core, { color: TIMBER, roughness: 0.86, metal: 0, plate: 0 }]];
  const batten = (w, h, d, x, y, z, rot = 0, axis = 'x') => {
    const g = new BoxGeometry(w, h, d);
    if (rot) { if (axis === 'x') g.rotateX(rot); else g.rotateZ(rot); }
    g.translate(x, y, z);
    parts.push([g, { color: TIMBER_DARK, roughness: 0.88, metal: 0, plate: 0 }]);
  };
  // four corner uprights
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batten(b, C.h, b, sx * (C.w / 2 - b / 2), C.h / 2, sz * (C.d / 2 - b / 2));
    }
  }
  // top and bottom rails, all four sides
  for (const y of [b / 2 + 0.01, C.h - b / 2 - 0.01]) {
    for (const sz of [-1, 1]) batten(C.w, b, b, 0, y, sz * (C.d / 2 - b / 2));
    for (const sx of [-1, 1]) batten(b, b, C.d - 2 * b, sx * (C.w / 2 - b / 2), y, 0);
  }
  // one diagonal brace a side — the detail that says "made by a carpenter"
  const diag = Math.hypot(C.w - 2 * b, C.h - 2 * b);
  const lean = Math.atan2(C.w - 2 * b, C.h - 2 * b);
  for (const sz of [-1, 1]) batten(b * 0.8, diag, b * 0.7, 0, C.h / 2, sz * (C.d / 2 - b / 2), sz * lean, 'z');
  for (const sx of [-1, 1]) batten(b * 0.7, diag, b * 0.8, sx * (C.w / 2 - b / 2), C.h / 2, 0, -sx * lean, 'x');
  return paintAll(parts, slot);
}

// 4.3a A rectangular hatch, closed or standing open.
//
// Almost free, and the single best thing on this list for first person: the
// camera rising 0.25 m as you cross a coaming does more for the sense of a real
// surface than the plank seams do. `PLAYER.stepUp` is 0.45, so the floor probe
// walks the player over it with no stepping code involved at all.
//
// The open ones are open with a grating in, not open onto a hole. A hole would
// have to be cut in the deck ribbon and would look into the hull liner, and
// there is no lower deck to land on when you fell down it — so the lid stands up
// on its hinges, the grating is shipped, and what you see through the bars is
// dark. That is what a hatch on a ship in daylight actually looks like, and it
// is not a lie the player can walk into.
function hatchCoaming(slot, open = false) {
  const H = PROP.hatch;
  const parts = [];
  const hw = H.w / 2;
  const hd = H.d / 2;
  const t = H.wall;
  const wall = (w, d, x, z) => {
    const g = new BoxGeometry(w, H.coaming, d);
    g.translate(x, H.coaming / 2, z);
    parts.push([g, { color: STEEL, roughness: 0.44 }]);
    // the rolled bar along the top of a coaming: you step on this, so it is
    // round rather than a plate edge
    const bar = new CylinderGeometry(t * 0.52, t * 0.52, Math.max(w, d), 6);
    if (w > d) bar.rotateZ(Math.PI / 2);
    else bar.rotateX(Math.PI / 2);
    bar.translate(x, H.coaming, z);
    parts.push([bar, { color: STEEL_DARK, roughness: 0.38 }]);
  };
  wall(H.w + 2 * t, t, 0, hd + t / 2);
  wall(H.w + 2 * t, t, 0, -hd - t / 2);
  wall(t, H.d, hw + t / 2, 0);
  wall(t, H.d, -hw - t / 2, 0);

  if (open) {
    // the grating, set down in the coaming
    const back = new BoxGeometry(H.w, 0.02, H.d);
    back.translate(0, H.coaming - 0.16, 0);
    parts.push([back, { color: [0.045, 0.05, 0.055], roughness: 0.9, metal: 0.2 }]);
    for (let k = 0; k < 7; k++) {
      const g = new BoxGeometry(H.w, 0.05, 0.032);
      g.translate(0, H.coaming - 0.045, -hd + (H.d * (k + 0.5)) / 7);
      parts.push([g, { color: STEEL_DARK, roughness: 0.5 }]);
    }
    for (let k = 0; k < 5; k++) {
      const g = new BoxGeometry(0.028, 0.038, H.d);
      g.translate(-hw + (H.w * (k + 0.5)) / 5, H.coaming - 0.05, 0);
      parts.push([g, { color: STEEL_DARK, roughness: 0.5 }]);
    }
    // the lid standing up on its hinges, leaning a little past vertical
    const lean = 0.16;
    const lid = new BoxGeometry(H.w + 2 * t, H.lid, 0.055);
    lid.translate(0, H.lid / 2, -0.028);
    lid.rotateX(-lean);
    lid.translate(0, H.coaming, -hd - t);
    parts.push([lid, { color: STEEL, roughness: 0.45 }]);
    // the stiffeners on its back, which is the face you see
    for (const x of [-hw * 0.55, hw * 0.55]) {
      const s = new BoxGeometry(0.06, H.lid - 0.12, 0.05);
      s.translate(x, H.lid / 2, -0.075);
      s.rotateX(-lean);
      s.translate(0, H.coaming, -hd - t);
      parts.push([s, { color: STEEL_DARK, roughness: 0.42 }]);
    }
    for (const x of [-hw * 0.7, hw * 0.7]) {
      const hinge = new CylinderGeometry(0.05, 0.05, 0.16, 8);
      hinge.rotateZ(Math.PI / 2);
      hinge.translate(x, H.coaming, -hd - t);
      parts.push([hinge, { color: STEEL_DARK, roughness: 0.36, metal: 0.8 }]);
    }
  } else {
    const lid = new BoxGeometry(H.w + 2 * t, 0.06, H.d + 2 * t);
    lid.translate(0, H.coaming + 0.03, 0);
    parts.push([lid, { color: STEEL, roughness: 0.46 }]);
    // dogs round the edge and a handle across the middle — a flush lid with
    // nothing on it reads as a patch of paint
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const d = new CylinderGeometry(0.035, 0.035, 0.09, 6);
      d.translate(Math.cos(a) * hw * 0.92, H.coaming + 0.08, Math.sin(a) * hd * 0.92);
      parts.push([d, { color: STEEL_DARK, roughness: 0.34, metal: 0.8 }]);
    }
    const grip = new TorusGeometry(0.13, 0.028, 4, 12, Math.PI);
    grip.rotateY(Math.PI / 2);
    grip.translate(0, H.coaming + 0.06, 0);
    parts.push([grip, { color: STEEL_DARK, roughness: 0.34, metal: 0.8 }]);
  }
  return paintAll(parts, slot);
}

// 4.3b A round scuttle: the same idea at half the size, for the places a
// 1.2 m hatch would be in the way.
//
// Always shut. The design note asks for a third of the hatches to be standing
// open, and on a rectangular hatch that works — the lid is a metre of plate
// standing on end and it reads as a lid. On a 0.8 m scuttle it does not: from
// standing height the open ring reads as a hole in the deck rather than as a
// fitting, and a hole you cannot fall down is worse than no hole. So the small
// ones are dogged and the vertical interest comes from the big ones.
function roundScuttle(slot) {
  const S = PROP.scuttle;
  const parts = [];
  const ring = new CylinderGeometry(S.r + S.wall, S.r + S.wall, S.coaming, 20, 1, true);
  ring.translate(0, S.coaming / 2, 0);
  // No throat and no floor inside it: the lid overhangs the coaming, so nothing
  // in there is ever seen.
  const rim = new TorusGeometry(S.r + S.wall / 2, S.wall * 0.55, 5, 20);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, S.coaming * 0.5, 0);
  parts.push(
    [ring, { color: STEEL, roughness: 0.44 }],
    [rim, { color: STEEL_DARK, roughness: 0.36 }],
  );
  // The lid, dogged down over the coaming, with a hinge strap and a handle so it
  // reads as something that opens rather than as a disc of paint.
  const lid = new CylinderGeometry(S.r + S.wall * 1.3, S.r + S.wall * 1.3, 0.055, 20);
  lid.translate(0, S.coaming + 0.028, 0);
  parts.push([lid, { color: STEEL, roughness: 0.46 }]);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const d = new CylinderGeometry(0.032, 0.032, 0.085, 6);
    d.translate(Math.cos(a) * (S.r + 0.01), S.coaming + 0.02, Math.sin(a) * (S.r + 0.01));
    parts.push([d, { color: STEEL_DARK, roughness: 0.34, metal: 0.8 }]);
  }
  const strap = new BoxGeometry(0.18, 0.05, 0.22);
  strap.translate(0, S.coaming + 0.03, -S.r - S.wall * 0.6);
  parts.push([strap, { color: STEEL_DARK, roughness: 0.4, metal: 0.8 }]);
  const grip = new TorusGeometry(0.10, 0.024, 4, 10, Math.PI);
  grip.rotateY(Math.PI / 2);
  grip.translate(0, S.coaming + 0.055, S.r * 0.35);
  parts.push([grip, { color: STEEL_DARK, roughness: 0.34, metal: 0.8 }]);
  return paintAll(parts, slot);
}

// 4.4a Twin bitts. Human scale at the deck edge, and they say the ship gets
// moored without occupying any deck anybody needs.
function twinBitts(slot) {
  const B = PROP.bitts;
  const parts = [];
  const base = new BoxGeometry(B.baseW, 0.09, B.baseD);
  base.translate(0, 0.045, 0);
  parts.push([base, { color: STEEL_DARK, roughness: 0.5 }]);
  for (const sx of [-1, 1]) {
    const x = sx * B.spread;
    const post = new CylinderGeometry(B.postR, B.postR * 1.08, B.postH, 14);
    post.translate(x, 0.09 + B.postH / 2, 0);
    parts.push([post, { color: STEEL, roughness: 0.4, metal: 0.75 }]);
    const collar = new TorusGeometry(B.postR + 0.02, 0.035, 4, 14);
    collar.rotateX(Math.PI / 2);
    collar.translate(x, 0.115, 0);
    parts.push([collar, { color: STEEL_DARK, roughness: 0.42 }]);
    // the head, wider than the post: it is what stops a turn of wire riding off
    const head = new CylinderGeometry(B.postR + 0.055, B.postR + 0.02, 0.075, 14);
    head.translate(x, 0.09 + B.postH + 0.03, 0);
    parts.push([head, { color: STEEL, roughness: 0.36, metal: 0.8 }]);
  }
  // the cross bar between them, at three-quarter height
  const bar = new CylinderGeometry(0.045, 0.045, B.spread * 2, 8);
  bar.rotateZ(Math.PI / 2);
  bar.translate(0, 0.09 + B.postH * 0.72, 0);
  parts.push([bar, { color: STEEL_DARK, roughness: 0.38, metal: 0.8 }]);
  return paintAll(parts, slot);
}

// 4.4b A fairlead: four castings round a throat, which is the cheapest way to
// get a hole in a thing without cutting one.
function fairlead(slot) {
  const F = PROP.fairlead;
  const parts = [];
  const cheekW = (F.w - F.throatW) / 2;
  const sillH = (F.h - F.throatH) / 2;
  const box = (w, h, d, x, y) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(x, y, 0);
    parts.push([g, { color: STEEL, roughness: 0.42 }]);
  };
  box(F.w, sillH, F.d, 0, sillH / 2);
  box(F.w, sillH, F.d, 0, F.h - sillH / 2);
  for (const sx of [-1, 1]) box(cheekW, F.throatH, F.d, sx * (F.w - cheekW) / 2, F.h / 2);
  // rounded lips top and bottom of the throat — a wire runs over these, so they
  // are the one part of a fairlead that is never square
  for (const y of [sillH, F.h - sillH]) {
    const lip = new CylinderGeometry(0.045, 0.045, F.throatW, 8);
    lip.rotateZ(Math.PI / 2);
    lip.translate(0, y, 0);
    parts.push([lip, { color: STEEL_DARK, roughness: 0.32, metal: 0.85 }]);
  }
  return paintAll(parts, slot);
}

// --- lashings -----------------------------------------------------------------
//
// The trick that buys visual density for nothing. Ten of the eighteen drums and
// crates are lashed: identical models, stacked neat, with rope over them. The
// rope is the whole point — it is what tells a player, without a word of
// tutorial, which cargo is part of the ship and which is loose. Cluster the
// loose ones against the lashed ones and a shell scatters the loose against the
// static, which reads as far more chaos than eight bodies can pay for.
function lashing(slot, w, h, d) {
  const parts = [];
  const tube = 0.026;
  for (const g of [
    ropeLoop(w + 0.06, h + 0.06, tube, 'xy'),
    ropeLoop(d + 0.06, h + 0.06, tube, 'zy'),
  ]) {
    g.translate(0, h / 2, 0);
    parts.push([g, { color: ROPE, roughness: 0.95, metal: 0, plate: 0 }]);
  }
  const round = ropeLoop(w + 0.07, d + 0.07, tube, 'xz');
  round.translate(0, h * 0.66, 0);
  parts.push([round, { color: ROPE, roughness: 0.95, metal: 0, plate: 0 }]);
  // and the deck ring-bolts it is set up to
  for (const sx of [-1, 1]) {
    const ring = new TorusGeometry(0.075, 0.022, 4, 10);
    ring.rotateY(Math.PI / 2);
    ring.translate(sx * (w / 2 + 0.16), 0.075, 0);
    parts.push([ring, { color: STEEL_DARK, roughness: 0.5, metal: 0.8 }]);
  }
  return paintAll(parts, slot);
}

// --- where anything can stand -------------------------------------------------
//
// What is already on the weather deck, as half-widths either side of the
// centreline over a range of stations. Read off spec.js and mounts.js rather
// than restated, so a deckhouse that gets wider takes its props outboard with it
// instead of swallowing them.
//
// The pads are deliberate: a prop 20 cm off the corner of a deckhouse looks like
// it was placed by a machine, which it was.
function houses() {
  const list = [];
  const pad = 1.2;
  const add = (z0, z1, half) => list.push({ z0: z0 - pad / L, z1: z1 + pad / L, half });
  for (const h of [SUPER.funnelDeck, SUPER.aftSuper]) {
    add(h.z - h.l / 2 / L, h.z + h.l / 2 / L, h.w / 2);
  }
  // the pagoda's base blockhouse — 17 by 21, set 1 m aft of its station
  add(SUPER.bridge.z - 11.5 / L, SUPER.bridge.z + 9.5 / L, 8.5);
  // the superfiring turrets stand on bandstands; the others on their barbettes
  for (const t of TURRETS) {
    const w = t.bandstand ? TURRET_SPEC.barbetteR * 2.5 * 1.12 : TURRET_SPEC.barbetteR * 2;
    const d = t.bandstand ? TURRET_SPEC.barbetteR * 2.5 * 1.26 : TURRET_SPEC.barbetteR * 2;
    add(t.z - d / 2 / L, t.z + d / 2 / L, w / 2);
  }
  return list;
}
const HOUSES = houses();

// How far out from the centreline the first clear deck is, at this station.
export function houseHalfAt(z) {
  let half = 0;
  for (const h of HOUSES) if (z >= h.z0 && z <= h.z1 && h.half > half) half = h.half;
  return half;
}

// And how far out the deck goes: the sheer, less the guardrail's own line.
export const deckHalfAt = (z) => halfBeamAt(z + 0.5) - 0.45;

const SHELTER_Y = deckY(SUPER.funnelDeck.z) + SUPER.funnelDeck.h;

// --- and on the shelter deck ---------------------------------------------------
//
// The deck round the funnel foot is the other place worth standing, and it is a
// completely different kind of space from a side deck: an open platform with
// things growing up through it rather than a strip beside a wall. What is in the
// way up there is the funnel itself, the pagoda's base blockhouse — which passes
// straight through this deck on its way up from the main deck, and is the single
// easiest thing on the ship to place a prop inside of — the four AA tubs, and
// the two ladder heads that are the only way onto it.
const SHELTER = {
  half: SUPER.funnelDeck.w / 2 - 0.1, // the invisible bulwark in deckAccess.js
  z0: zOf(SUPER.funnelDeck.z) - SUPER.funnelDeck.l / 2,
  z1: zOf(SUPER.funnelDeck.z) + SUPER.funnelDeck.l / 2,
  // boxes: { cx (mirrored port and starboard), half, z0, z1 }
  boxes: [
    // the pagoda's base blockhouse, which stands on the *main* deck and comes up
    // through this one
    { cx: 0, half: 8.5, z0: zOf(SUPER.bridge.z) - 11.5, z1: zOf(SUPER.bridge.z) + 9.5 },
    // the two ladder heads: the only way onto this deck, so nothing goes near them
    {
      cx: SUPER.funnelDeck.w / 2 - 0.9,
      half: 1.4,
      z0: zOf(SUPER.funnelDeck.z) + SUPER.funnelDeck.l / 2 - 3.6,
      z1: zOf(SUPER.funnelDeck.z) + SUPER.funnelDeck.l / 2 + 3.0,
    },
  ],
  // circles: [x, z, radius]
  circles: [
    [0, zOf(SUPER.funnel.z), SUPER.funnel.rx + 0.5],
    ...AA_MOUNTS.filter((a) => a.on === 'funnelDeck')
      .map((a) => [a.x * SHIP.halfBeam, zOf(a.z), AA_SPEC.tubR + 0.35]),
  ],
};
const cptFor = (z) => {
  const s = z + 0.5;
  return (COMPARTMENTS.find((k) => s >= k.s[0] && s < k.s[1]) || COMPARTMENTS[COMPARTMENTS.length - 1]).id;
};

// --- the manifest -------------------------------------------------------------
//
// Three rules run this list and they are worth more than the coordinates are.
//
// Cluster in odd numbers, three to six. A grid is detected instantly and a pair
// reads as placed; three and five read as things that ended up there.
//
// Anchor to function. Ventilation is round the funnel and down the sides of the
// machinery spaces, because that is where the uptakes are. Mooring gear is at
// the bow and the stern. Cargo is where cargo gets staged — outside a
// superstructure door, beside a hatch. Placement that follows function reads as
// designed even when nobody can say why.
//
// Leave the ends sparse. The instinct is to fill the two biggest empty areas
// first; the contrast between a dense waist and an open forecastle is the whole
// reason the deck reads as a working ship rather than a prop dump, and it is
// only a discipline problem.
export function deckPropPlacements() {
  const rnd = mulberry32(0x0decc1a5);
  const jit = (m) => (rnd() - 0.5) * 2 * m;
  const out = [];

  // `x` positive is port. `hug` places a prop that many metres outboard of
  // whatever is standing on the deck here; `edge` that many metres inboard of
  // the sheer. Both resolve against the hull's own curves, so nothing in this
  // list is a number that can drift away from the ship.
  const add = (kind, o) => {
    const z = o.z;
    let x = o.x ?? 0;
    let rule = 'abs';
    if (o.hug !== undefined) { x = (houseHalfAt(z) + o.hug) * (o.side ?? 1); rule = 'hug'; }
    else if (o.edge !== undefined) { x = (deckHalfAt(z) - o.edge) * (o.side ?? 1); rule = 'edge'; }
    else x *= o.side ?? 1;
    out.push({
      kind,
      rule,
      variant: o.variant ?? 0,
      open: o.open ?? false,
      lashed: o.lashed ?? false,
      x,
      y: (o.shelter ? SHELTER_Y : deckY(z)) + (o.lift ?? 0),
      z: zOf(z),
      zf: z,
      yaw: o.yaw ?? 0,
      scale: o.scale ?? 1,
      shelter: !!o.shelter,
      cpt: cptFor(z),
    });
  };

  // A group of cowls, all trimmed the same way.
  //
  // They used to get a few tens of degrees of random heading each, on the theory
  // that uniform random reads as debris and a jittered common heading reads as a
  // watch that went round and trimmed them. It does not, at this scale: ten or
  // fifteen degrees is too little to read as variety and too much to read as
  // straight, so what you actually see is a rank of vents that all lean slightly
  // the same way, which looks like a mistake. They face dead ahead now, which is
  // also where a ship under way would trim them. The size jitter stays — that one
  // reads as different castings rather than as a slipped heading.
  const cowls = (at, opts = {}) => {
    for (const [z, x, side] of at) {
      add('cowl', { ...opts, z, x, side, yaw: 0, scale: 1 + jit(0.08) });
    }
  };

  // Cargo goes down in clumps of two and three, never singly and never in a row.
  // A drum on its own reads as a mistake; three drums together read as three
  // drums somebody put there. `at` is [dz, hug] offsets about the clump's own
  // station, so the whole group moves as one number.
  const clump = (kind, z, side, at, opts = {}) => {
    for (const [dz, hug, extra] of at) {
      add(kind, {
        ...opts, ...(extra || {}), z: z + dz / L, hug, side, yaw: jit(0.5),
      });
    }
  };

  // --- 1. the bow: ground tackle ---------------------------------------------
  // Tight at the tip where the cable runs, and then nothing until A turret. This
  // hull's forefoot is finer than the design note's — she is down to three metres
  // of beam by 0.44 L — so the cluster sits a little further aft than the note
  // asks and hangs off the deck edge rather than off a stated x.
  for (const side of [-1, 1]) {
    add('bitts', { z: 0.395, edge: 0.95, side, yaw: Math.PI / 2 });
    add('fairlead', { z: 0.428, edge: 0.75, side, yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2 });
    add('bitts', { z: 0.312, edge: 1.05, side, yaw: Math.PI / 2 });
    add('mushroom', { z: 0.352, x: 3.1, side });
  }
  add('hatch', { z: 0.372, x: 0, yaw: Math.PI / 2 });
  add('hatch', { z: 0.318, x: 1.9 });
  // Kept clear of the circle A turret's gunhouse sweeps as she trains: the sheer
  // lifts the deck 0.4 m between the turret's station and this one, which is
  // enough to bring a scuttle up into the gunhouse corner.
  add('scuttle', { z: 0.300, x: -3.4 });
  cowls([[0.336, 4.9, 1], [0.336, 4.9, -1]]);

  // --- 2. abreast the forward turrets ----------------------------------------
  // One clump of crates against B turret's bandstand and two mushroom heads,
  // and that is all: this is the route from the forecastle aft and it stays a
  // route.
  add('crate', { z: 0.138, hug: 1.1, side: -1, yaw: 0.08, lashed: true });
  add('crate', { z: 0.138, hug: 1.1, side: -1, yaw: 0.08, lashed: true, lift: PROP.crate.h });
  add('crate', { z: 0.146, hug: 2.40, side: -1, yaw: -0.5 });
  for (const side of [-1, 1]) add('mushroom', { z: 0.176, hug: 0.9, side });
  add('hatch', { z: 0.199, x: 0 });

  // --- 3. the side decks ------------------------------------------------------
  //
  // The strip between the superstructure and the guardrail is the ship's main
  // fore-and-aft artery and it is 4.3 m wide abreast the shelter deck. Nothing
  // taller than a coaming goes in that stretch — not one vent, however good the
  // photograph of a vent against a bulkhead looks. Hatches and fairleads are
  // under step height and cost nothing, so they can go anywhere.
  //
  // Nothing stands in a doorway either. The watertight doors are at the head of
  // each gangway (see buildDeckhouses), which is exactly where a vent placed by
  // rule rather than by eye ends up, and a cowl a metre outside a door is the
  // one thing that says nobody looked at this from the deck.
  for (const side of [-1, 1]) {
    add('hatch', { z: -0.048, hug: 1.3, side, yaw: -side * (Math.PI / 2) });
    add('scuttle', { z: 0.130, edge: 1.5, side });
    // forward of the shelter deck, where the strip opens out again
    add('cowl', { z: 0.083, hug: 1.0, side, scale: 1 + jit(0.08) });
    add('mushroom', { z: 0.112, hug: 0.95, side });
  }
  // A fairlead for the midships spring, and no bitts to go with it: a 0.6 m
  // bollard is the one thing that would narrow the artery, and at 0.42 m a
  // fairlead is walked over.
  add('fairlead', { z: 0.148, edge: 0.75, side: 1, yaw: Math.PI / 2 });

  // --- 4. the funnel base, on the shelter deck --------------------------------
  //
  // The one place on the ship where ventilation is allowed to be dense, and the
  // reason it is dense is that it is true: this is the top of the boiler rooms
  // and every uptake on her comes out here. It is also the best thing on the
  // ship to walk into — you come up the ladder at the forward end and there is a
  // stand of cowls between you and the funnel.
  //
  // Five of them, not eight. An odd number, kept clear of the funnel itself, of
  // the four AA tubs on this deck and of the two ladder heads.
  cowls([
    [-0.030, 4.9, 1], [-0.030, 4.9, -1],
    [-0.064, 4.6, 1], [-0.064, 4.6, -1],
    [-0.089, 3.1, 1],
  ], { shelter: true });
  for (const side of [-1, 1]) add('mushroom', { z: -0.010, x: 5.6, side, shelter: true });
  add('hatch', { z: -0.040, x: 7.4, shelter: true, open: true, yaw: Math.PI / 2 });
  add('scuttle', { z: -0.092, x: 6.0, side: -1, shelter: true });

  // --- 5. the after waist ------------------------------------------------------
  // Down both side decks abreast the after deckhouse, which is the widest open
  // strip on the ship — 6.8 m of it — and therefore the one place cargo and
  // ventilation can both stand without either being in the way. The densest
  // area aboard, and the stores are here because the after gangway is here.
  for (const side of [-1, 1]) {
    add('cowl', { z: -0.132, hug: 1.05, side, scale: 1 + jit(0.08) });
    add('cowl', { z: -0.168, hug: 1.0, side, scale: 1 + jit(0.08) });
    add('mushroom', { z: -0.150, hug: 0.95, side });
    add('mushroom', { z: -0.196, hug: 0.95, side });
    add('hatch', { z: -0.205, hug: 1.35, side, yaw: -side * (Math.PI / 2), open: side < 0 });
    add('scuttle', { z: -0.222, edge: 1.5, side });
    add('bitts', { z: side < 0 ? -0.150 : -0.128, edge: 0.95, side, yaw: Math.PI / 2 });
  }
  // Stores staged outboard of the after gangway, starboard side: a lashed stack
  // of two with a pair of loose ones beside it.
  clump('crate', -0.140, -1, [
    [0, 2.0, { lashed: true, yaw: 0.06 }],
    [0, 2.0, { lashed: true, yaw: 0.06, lift: PROP.crate.h }],
    [-1.45, 2.05],
    [0.1, 3.35],
  ]);
  // and the drums in two groups, three to port and two to starboard, so a burst
  // among them throws the loose ones against the stack that stays
  clump('drum', -0.158, 1, [[0, 1.0], [0, 1.78], [-0.80, 1.39]], { variant: 1 });
  clump('drum', -0.186, -1, [[0, 1.05], [0, 1.80]], { variant: 0 });

  // --- 6. abreast the after turrets ------------------------------------------
  // The one station on her with a clear run rail to rail is between X and Y, and
  // it stays clear. Two mushroom heads and one clump of crates hard against X's
  // bandstand, nothing else.
  for (const side of [-1, 1]) add('mushroom', { z: -0.279, hug: 0.9, side });
  add('crate', { z: -0.236, hug: 1.0, side: 1, yaw: 0.1, lashed: true });
  add('crate', { z: -0.236, hug: 1.0, side: 1, yaw: 0.1, lashed: true, lift: PROP.crate.h });
  add('crate', { z: -0.246, hug: 2.40, side: 1, yaw: -0.35 });
  add('hatch', { z: -0.309, x: 3.2, yaw: Math.PI / 2 });

  // --- 7. the quarterdeck ------------------------------------------------------
  // Deliberately sparse: mooring gear and two hatches. It was kept clear for
  // boat handling and for ceremony, and the contrast with the waist is what
  // makes the ship read as functional rather than randomly cluttered. The
  // temptation to fill it is exactly the thing to resist.
  for (const side of [-1, 1]) {
    add('bitts', { z: -0.452, edge: 0.95, side, yaw: Math.PI / 2 });
    add('fairlead', { z: -0.470, edge: 0.75, side, yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2 });
  }
  add('bitts', { z: -0.480, x: 0, yaw: 0 });
  add('hatch', { z: -0.424, x: 2.6 });
  add('hatch', { z: -0.446, x: -2.4, yaw: Math.PI / 2 });
  add('scuttle', { z: -0.408, x: 3.6 });
  add('cowl', { z: -0.412, x: -5.2 });
  add('mushroom', { z: -0.418, x: -3.0 });

  return assertClearance(out);
}

// --- how much room each of them takes ----------------------------------------
//
// Half-extents in the prop's own frame, and how high off the deck the box
// starts. Boxes only: a 0.29 m cylinder inside a 0.30 m box is a difference
// nobody can feel, and the player's collision field is a point query against
// axis-aligned boxes (player/deckAccess.js) which is exactly what this is.
//
// The cowl's box is its trunk and not its bell. The bell is at head height and
// overhangs half a metre to one side, and boxing it would make a 1 m obstacle
// out of a 0.5 m one — a real cowl is something you duck, not something you
// walk round.
const SOLID = {
  cowl: { hx: 0.31, hz: 0.31, y0: 0, hy: 0.90 },
  mushroom: { hx: 0.41, hz: 0.41, y0: 0, hy: 0.45 },
  drum: { hx: 0.345, hz: 0.345, y0: 0, hy: 0.51 },
  crate: { hx: 0.46, hz: 0.46, y0: 0, hy: 0.35 },
  hatch: { hx: 0.70, hz: 0.55, y0: 0, hy: 0.13 },
  scuttle: { hx: 0.47, hz: 0.47, y0: 0, hy: 0.10 },
  bitts: { hx: 0.72, hz: 0.32, y0: 0, hy: 0.35 },
  fairlead: { hx: 0.29, hz: 0.17, y0: 0, hy: 0.21 },
};

// The collision boxes, in the ship's frame, for player/deckAccess.js.
//
// A yawed prop is given the box its own box sweeps, which is generous the right
// way round: something meant to be walked round rather than through.
export function deckPropSolids() {
  const boxes = [];
  for (const p of deckPropPlacements()) {
    const s = SOLID[p.kind];
    const c = Math.abs(Math.cos(p.yaw));
    const sn = Math.abs(Math.sin(p.yaw));
    boxes.push({
      id: `prop.${p.kind}`,
      c: new Vector3(p.x, p.y + s.y0 + s.hy * p.scale, p.z),
      h: new Vector3(
        (s.hx * c + s.hz * sn) * p.scale,
        s.hy * p.scale,
        (s.hz * c + s.hx * sn) * p.scale,
      ),
    });
    // An open hatch lid stands a metre up on its hinges, and it is the one part
    // of any of this that is a wall rather than a step.
    if (p.kind === 'hatch' && p.open) {
      const dx = Math.sin(p.yaw) * (PROP.hatch.d / 2 + 0.1);
      const dz = -Math.cos(p.yaw) * (PROP.hatch.d / 2 + 0.1);
      boxes.push({
        id: 'prop.hatch.lid',
        c: new Vector3(p.x + dx, p.y + PROP.hatch.coaming + PROP.hatch.lid / 2, p.z + dz),
        h: new Vector3(
          0.72 * c + 0.14 * sn,
          PROP.hatch.lid / 2,
          0.14 * c + 0.72 * sn,
        ),
      });
    }
  }
  return boxes;
}

// Nothing may stand on the sea, inside a deckhouse, or across a side deck.
//
// Checked against the same curves the hull is lofted from, at build time,
// because the failure mode is a player walled into a corner of the ship nobody
// visits for a month, and the numbers in the manifest above are the kind that
// look fine and are not.
//
// The lane rule reads differently at each end of a side deck, which is the whole
// reason both ends are used. A prop hugging the superstructure has to leave the
// lane *outboard* of it; a prop at the deck edge has to leave it *inboard*. That
// is not a technicality — it is why bitts at the sheer never obstruct anybody
// and why the same bitts moved two metres in would turn the deck into an
// obstacle course.
//
// Anything shorter than `PLAYER.stepUp` is exempt from all of it. The floor
// probe walks the player straight over a coaming without the wall samples ever
// seeing it (character.js), so a hatch is not an obstacle in any sense the rule
// is about.
function assertOnShelter(p, reach) {
  const where = `${p.kind} on the shelter deck at z ${p.z.toFixed(1)} x ${p.x.toFixed(2)}`;
  const ax = Math.abs(p.x);
  if (ax + reach > SHELTER.half) {
    throw new Error(`deckProps: ${where} is over the side (bulwark at ${SHELTER.half} m)`);
  }
  if (p.z - reach < SHELTER.z0 || p.z + reach > SHELTER.z1) {
    throw new Error(`deckProps: ${where} is off the end of the shelter deck`);
  }
  for (const b of SHELTER.boxes) {
    if (Math.abs(ax - b.cx) > b.half + reach) continue;
    if (p.z > b.z0 - reach && p.z < b.z1 + reach) {
      throw new Error(`deckProps: ${where} is inside the pagoda base or a ladder head`);
    }
  }
  for (const [cx, cz, r] of SHELTER.circles) {
    if (Math.hypot(p.x - cx, p.z - cz) < r + reach) {
      throw new Error(`deckProps: ${where} is inside the funnel or an AA tub `
        + `(${Math.hypot(p.x - cx, p.z - cz).toFixed(2)} m from its centre, needs ${(r + reach).toFixed(2)})`);
    }
  }
}

function assertClearance(list) {
  for (const p of list) {
    const s = SOLID[p.kind];
    if (p.shelter) { assertOnShelter(p, Math.max(s.hx, s.hz) * p.scale); continue; }
    const reach = Math.max(s.hx, s.hz) * p.scale;
    const inner = houseHalfAt(p.zf);
    const outer = deckHalfAt(p.zf);
    const ax = Math.abs(p.x);
    const where = `${p.kind} at z ${p.zf.toFixed(3)} x ${p.x.toFixed(2)}`;
    if (ax + reach > outer) {
      throw new Error(`deckProps: ${where} hangs over the sheer `
        + `(clear deck ends at ${outer.toFixed(2)} m)`);
    }
    if (inner > 0 && ax - reach < inner) {
      throw new Error(`deckProps: ${where} is inside the superstructure `
        + `(clear deck starts at ${inner.toFixed(2)} m)`);
    }
    if (inner <= 0) continue; // no side deck here: it is the open deck, not a strip
    if ((s.y0 + 2 * s.hy) * p.scale <= PLAYER.stepUp) continue; // walked over
    const lane = p.rule === 'edge' ? (ax - reach) - inner : outer - (ax + reach);
    if (lane < LANE) {
      throw new Error(`deckProps: ${where} leaves only ${lane.toFixed(2)} m of side deck `
        + `${p.rule === 'edge' ? 'inboard' : 'outboard'} of it (needs ${LANE})`);
    }
  }
  return list;
}

// --- the build ----------------------------------------------------------------

const _v = new Vector3();
const _q = new Quaternion();
const UP = new Vector3(0, 1, 0);

// Mass of each, for what it hits when it lands and how big a splash it makes.
const MASS = {
  cowl: 90, mushroom: 55, drum: 190, crate: 65, hatch: 120, scuttle: 60,
  bitts: 260, fairlead: 110,
};

export function buildDeckProps({ materials, onDetach = null }) {
  const object = new Group();
  object.name = 'deckProps';
  const placements = deckPropPlacements();

  // Build each model once per damage slot it is needed in, then instance it by
  // baking the transform into a copy of the buffer. The ship has no instanced
  // draw path — everything is merged — and merging is the cheaper answer here
  // anyway: eighty-odd props come out as five meshes, one per watertight
  // section, and each carries that section's damage slot so a prop scorches
  // with the plating it is bolted to rather than being a component of its own.
  const cache = new Map();
  const model = (kind, slot, key, make) => {
    const id = `${kind}:${slot}:${key}`;
    if (!cache.has(id)) cache.set(id, merge(make(slot)));
    return cache.get(id);
  };

  const props = [];
  for (const p of placements) {
    const slot = materials.slotOf(p.cpt);
    let geo;
    switch (p.kind) {
      case 'cowl': geo = model('cowl', slot, 0, swanNeck); break;
      case 'mushroom': geo = model('mushroom', slot, 0, mushroomVent); break;
      case 'drum': geo = model('drum', slot, p.variant, (s) => oilDrum(s, p.variant)); break;
      case 'crate': geo = model('crate', slot, 0, crate); break;
      case 'hatch': geo = model('hatch', slot, p.open ? 'o' : 'c', (s) => hatchCoaming(s, p.open)); break;
      case 'scuttle': geo = model('scuttle', slot, 0, roundScuttle); break;
      case 'bitts': geo = model('bitts', slot, 0, twinBitts); break;
      default: geo = model('fairlead', slot, 0, fairlead); break;
    }
    const g = geo.clone();
    if (p.scale !== 1) g.scale(p.scale, p.scale, p.scale);
    g.rotateY(p.yaw);
    g.translate(p.x, p.y, p.z);
    props.push({
      ...p, geo: g, alive: true, mass: MASS[p.kind],
      // where the body's own origin is, for when it comes off her
      centre: new Vector3(p.x, p.y + (SOLID[p.kind].hy * p.scale), p.z),
    });
  }

  // The rope over the lashed stacks. Added after the cargo so a stack's straps
  // are one object with the crates under them: shoot the stack and the lashing
  // goes with it, which is the difference between a lashed stack and a lashed
  // stack of nothing.
  const stacks = new Map();
  for (const p of props) {
    if (!p.lashed) continue;
    const key = `${p.x.toFixed(2)}|${p.z.toFixed(2)}`;
    if (!stacks.has(key)) stacks.set(key, []);
    stacks.get(key).push(p);
  }
  for (const stack of stacks.values()) {
    const base = stack[0];
    const kind = base.kind;
    const w = kind === 'crate' ? PROP.crate.w : PROP.drum.r * 2;
    const d = kind === 'crate' ? PROP.crate.d : PROP.drum.r * 2;
    const h = stack.length * (kind === 'crate' ? PROP.crate.h : PROP.drum.h);
    const slot = materials.slotOf(base.cpt);
    const g = merge(lashing(slot, w, h, d));
    g.rotateY(base.yaw);
    g.translate(base.x, base.y, base.z);
    // it belongs to the bottom of the stack, so the whole stack lets go together
    base.geo = merge([base.geo, g]);
  }

  // --- one mesh per watertight section ----------------------------------------
  const sections = new Map();
  for (const cpt of COMPARTMENTS) {
    const own = props.filter((p) => p.cpt === cpt.id);
    if (!own.length) continue;
    const mesh = new Mesh(merge(own.map((p) => p.geo)), materials.body);
    mesh.name = `deckProps.${cpt.id}`;
    mesh.castShadow = true;
    object.add(mesh);
    sections.set(cpt.id, { mesh, props: own });
  }

  function rebuild(id) {
    const sec = sections.get(id);
    if (!sec) return;
    const alive = sec.props.filter((p) => p.alive);
    if (!alive.length) { sec.mesh.visible = false; return; }
    const old = sec.mesh.geometry;
    sec.mesh.geometry = merge(alive.map((p) => p.geo));
    sec.mesh.visible = true;
    old.dispose();
  }

  // --- what a shell does to them -----------------------------------------------
  //
  // The two differences from the guardrail, and they are §8's two differences
  // from player knockback. Props catch blast wider than anything else does,
  // because a shell landing amidships should scatter drums the player can see
  // from across the deck and not only the ones at their feet. And they are given
  // a hard random tumble, because an impulse through the centre of mass slides a
  // thing flat across the deck, which looks wrong — the tumble is most of what
  // sells the hit.
  //
  // Lashed props are harder to shift than loose ones, which is what the rope is
  // for: 0.55 of the radius, so a near miss scatters the loose drums against the
  // stack that stays. That is the cheap drama the design note is after and it
  // costs nothing between hits.
  const touched = new Set();

  function detach(p, from, speed) {
    p.alive = false;
    touched.add(p.cpt);
    if (!p.loose) {
      p.loose = p.geo.clone().translate(-p.centre.x, -p.centre.y, -p.centre.z);
    }
    if (!onDetach) return;
    _v.subVectors(p.centre, from);
    if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
    _v.normalize().multiplyScalar(speed * (0.6 + Math.random() * 0.9));
    _v.y = Math.abs(_v.y) + speed * 0.5 + 2.0; // thrown, not shoved
    onDetach({
      geometry: p.loose,
      position: p.centre.clone(),
      quaternion: _q.setFromAxisAngle(UP, p.yaw).clone(),
      impulse: _v.clone(),
      spin: new Vector3(
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 12,
      ),
      mass: p.mass,
    });
  }

  // --- the drums go off --------------------------------------------------------
  //
  // A drum is not a crate that happens to be round. It is two hundred litres of
  // fuel oil sitting on a wooden deck, and the reason it is worth having on the
  // ship at all is that a shell anywhere near it does not knock it over, it
  // lights it — and the drum next to that one goes with it.
  //
  // The chain is a work queue rather than recursion, and it terminates on its
  // own: a prop can only be detached once, so a drum can only ever seed one more
  // sweep. Worst case is every drum on the ship, which is five.
  //
  // The cook-off is fed back out to the caller rather than played here, because
  // what an explosion *is* — a burst, a scorch in the damage field, a shove to
  // anyone standing near it — is the ship's business and this file does not know
  // about any of it. See `strike` in Battleship.js.
  const COOK = {
    radius: 5.5, // how far the burning drum reaches for the next thing
    speed: 15, // and how hard it throws what it reaches
  };
  const _queue = [];

  // `point` is in the ship's frame. Returns the cook-offs it set off, in the
  // ship's frame and in the order they went up.
  function blast(point, radius = 9, { speed = 8, cook = true } = {}) {
    touched.clear();
    const fired = [];
    _queue.length = 0;
    _queue.push({ x: point.x, y: point.y, z: point.z, r: radius, speed });
    for (let i = 0; i < _queue.length; i++) {
      const q = _queue[i];
      _v.set(q.x, q.y, q.z);
      for (const p of props) {
        if (!p.alive) continue;
        // Lashed cargo is harder to shift than loose — that is what the rope is
        // there to say — and everything loose catches blast wider than a person
        // does. A drum is wider again: it does not have to be knocked over to
        // let go, only reached.
        const reach = p.lashed ? 0.55 : (p.kind === 'drum' ? 1.8 : 1.4);
        if (p.centre.distanceTo(_v) > q.r * reach) continue;
        detach(p, _v, q.speed);
        if (cook && p.kind === 'drum') {
          fired.push(p.centre.clone());
          _queue.push({
            x: p.centre.x, y: p.centre.y, z: p.centre.z, r: COOK.radius, speed: COOK.speed,
          });
        }
      }
    }
    for (const id of touched) rebuild(id);
    return fired;
  }

  // A wrecked section takes everything standing on it.
  function wreckSection(id) {
    const sec = sections.get(id);
    if (!sec) return 0;
    let n = 0;
    touched.clear();
    const from = new Vector3();
    for (const p of sec.props) {
      if (!p.alive) continue;
      from.set(0, p.centre.y - 2.5, p.centre.z);
      detach(p, from, 7);
      n++;
    }
    for (const cid of touched) rebuild(cid);
    return n;
  }

  function restore() {
    let missing = 0;
    for (const p of props) if (!p.alive) { p.alive = true; missing++; }
    if (!missing) return 0;
    for (const id of sections.keys()) rebuild(id);
    return missing;
  }

  return {
    id: 'deckProps',
    object,
    blast,
    wreck: wreckSection,
    restore,
    placements,
    get count() { return props.length; },
    get intact() { return props.filter((p) => p.alive).length; },
  };
}
