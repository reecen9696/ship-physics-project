import {
  Group, Mesh, BoxGeometry, CylinderGeometry, TorusGeometry, SphereGeometry, Vector3,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { merge } from './mergeGeometry.js';
import { pushScuttle } from './scuttles.js';
import { SHIP, SUPER, HULL_NUMBER } from './spec.js';
import { deckY, zOf, sideAt, STEEL, STEEL_DARK } from './hull.js';
import { buildHullNumber } from './hullNumber.js';
import {
  strut, createRig, latticeMast, yardarm, topmast, aerialWire,
  airSearchArray, surfaceSearchDish, RIG,
} from './aerials.js';

// Each builder returns { id, object, damage } where `damage` is the uniform
// its materials share. Anything that should die as one thing (the pagoda, the
// funnel) is one such unit; small fittings that only dress the ship are merged
// into `decor` under the section they sit on.

function unit(id, materials) {
  const slot = materials.slotOf(id);
  const damage = materials.handleFor(id);
  // `mk(color, roughness)` returns a Mesh factory bound to this unit's damage
  // slot, so every part of the unit scorches together when it is hit.
  const mk = (color, roughness = 0.45) => (geometry) => new Mesh(
    paint(geometry, { color, roughness, slot }), materials.body,
  );
  // window panes, on the dedicated glass program
  const mkGlass = () => (geometry) => new Mesh(
    paint(geometry, { color: [0.05, 0.07, 0.09], roughness: 0.1, slot }), materials.glass,
  );
  const object = new Group();
  object.name = id;
  return { id, object, damage, mk, mkGlass, slot, materials };
}

// --- pagoda bridge -----------------------------------------------------------
// The signature of the type: a conning tower with the bridge levels stacked up
// and around it, each level a little different, capped by the main rangefinder
// and a pole topmast. Built as one destructible unit; the ship's helm and fire
// control live here, so a kill on it is a kill on both.
export function buildBridge({ materials }) {
  const u = unit('bridge', materials);
  const { object: g, mk, mkGlass } = u;
  const steel = mk(STEEL);
  const dark = mk(STEEL_DARK, 0.4);
  const glass = mkGlass();

  const z0 = zOf(SUPER.bridge.z);
  const y0 = deckY(SUPER.bridge.z);

  // The pagoda foremast.
  //
  // The thing that makes this silhouette is NOT a stack of boxes — build it
  // that way and you get a wedding cake, which is what was here before. What it
  // actually is: one armoured column running the whole height, with a small
  // number of *distinct* things hung off it — two or three enclosed houses with
  // window bands, and between them thin circular platforms that overhang the
  // column by a long way. The column stays visible between them. The rhythm is
  // irregular and the parts are different from each other; that irregularity is
  // the whole look.

  // --- base: a broad blockhouse on the deck, then a narrower one on top ------
  const base = steel(new BoxGeometry(17, 4.0, 21));
  base.position.set(0, y0 + 2.0, z0 - 1.0);
  g.add(base);
  const base2 = steel(new BoxGeometry(13, 3.4, 15));
  base2.position.set(0, y0 + 5.7, z0);
  g.add(base2);

  // --- the column ------------------------------------------------------------
  // Slightly conical and tall enough to be seen between every platform.
  const COL_TOP = 30.5; // m above the base blockhouse top
  const col = dark(new CylinderGeometry(2.1, 3.4, COL_TOP, 16));
  col.position.set(0, y0 + 7.4 + COL_TOP / 2, z0 - 0.5);
  g.add(col);
  // legs bracing the column down onto the blockhouse, in the open
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    g.add(strut(
      new Vector3(Math.cos(a) * 5.2, y0 + 7.4, z0 - 0.5 + Math.sin(a) * 5.2),
      new Vector3(Math.cos(a) * 2.4, y0 + 15.5, z0 - 0.5 + Math.sin(a) * 2.4),
      0.28, dark,
    ));
  }

  // --- railings --------------------------------------------------------------
  // A balcony is not a slab with a lip on it. What makes an open gallery read as
  // somewhere a person stands is the *gap*: a top rail held clear of the deck on
  // thin stanchions, with daylight through it. A solid parapet at the same
  // height just looks like another box.
  const railRing = (r, y, dz, stanchions = 16) => {
    const top = dark(new TorusGeometry(r, 0.075, 5, 28));
    top.rotation.x = Math.PI / 2;
    top.position.set(0, y0 + y + 1.05, z0 + dz);
    g.add(top);
    const mid = dark(new TorusGeometry(r, 0.05, 5, 28));
    mid.rotation.x = Math.PI / 2;
    mid.position.set(0, y0 + y + 0.6, z0 + dz);
    g.add(mid);
    for (let k = 0; k < stanchions; k++) {
      const a = (k / stanchions) * Math.PI * 2;
      const st = dark(new CylinderGeometry(0.055, 0.055, 1.1, 5));
      st.position.set(Math.cos(a) * r, y0 + y + 0.55, z0 + dz + Math.sin(a) * r);
      g.add(st);
    }
  };

  const railRect = (w, l, y, dz) => {
    const bar = (len, horiz, px, pz, h) => {
      const b = dark(new CylinderGeometry(0.07, 0.07, len, 5));
      b.rotation.z = Math.PI / 2;
      if (!horiz) b.rotation.y = Math.PI / 2;
      b.position.set(px, y0 + y + h, z0 + dz + pz);
      g.add(b);
    };
    for (const h of [1.05, 0.6]) {
      bar(w, true, 0, l / 2, h); bar(w, true, 0, -l / 2, h);
      bar(l, false, w / 2, 0, h); bar(l, false, -w / 2, 0, h);
    }
    for (const [px, pz] of [
      [-w / 2, -l / 2], [0, -l / 2], [w / 2, -l / 2],
      [-w / 2, 0], [w / 2, 0],
      [-w / 2, l / 2], [0, l / 2], [w / 2, l / 2],
    ]) {
      const st = dark(new CylinderGeometry(0.055, 0.055, 1.1, 5));
      st.position.set(px, y0 + y + 0.55, z0 + dz + pz);
      g.add(st);
    }
  };

  // --- a house: enclosed, window band, and an open balcony round it ----------
  const house = (w, h, l, y, dz, hasWindows = true, balcony = true) => {
    const b = steel(new BoxGeometry(w, h, l));
    b.position.set(0, y0 + y + h / 2, z0 + dz);
    g.add(b);
    if (hasWindows) {
      const band = glass(new BoxGeometry(w + 0.1, h * 0.34, l + 0.1));
      band.position.set(0, y0 + y + h * 0.72, z0 + dz);
      g.add(band);
    }
    if (balcony) {
      // gallery deck standing proud of the house all the way round, with
      // brackets under it — the brackets are what stop it looking glued on
      const bw = w + 2.6;
      const bl = l + 2.6;
      const floor = steel(new BoxGeometry(bw, 0.22, bl));
      floor.position.set(0, y0 + y + h + 0.11, z0 + dz);
      g.add(floor);
      railRect(bw - 0.3, bl - 0.3, y + h + 0.22, dz);
      for (const sx of [-1, 1]) {
        for (const pz of [-l * 0.35, l * 0.35]) {
          g.add(strut(
            new Vector3(sx * (w / 2), y0 + y + h - 1.4, z0 + dz + pz),
            new Vector3(sx * (bw / 2 - 0.2), y0 + y + h, z0 + dz + pz), 0.09, dark,
          ));
        }
      }
    }
    return b;
  };

  // --- a platform: a thin disc overhanging the column, railed all round ------
  const platform = (r, y, dz) => {
    const d = steel(new CylinderGeometry(r, r, 0.3, 24));
    d.position.set(0, y0 + y, z0 + dz);
    g.add(d);
    railRing(r - 0.2, y + 0.15, dz, Math.max(10, Math.round(r * 2.6)));
    // brackets under the overhang, back to the column
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      g.add(strut(
        new Vector3(Math.cos(a) * 2.0, y0 + y - 2.2, z0 + dz + Math.sin(a) * 2.0),
        new Vector3(Math.cos(a) * (r - 0.4), y0 + y - 0.2, z0 + dz + Math.sin(a) * (r - 0.4)),
        0.1, dark,
      ));
    }
  };

  // Irregular on purpose: house, big platform, house, platform, neck, top house.
  house(12.5, 3.6, 12.0, 7.4, 1.6); // lower bridge / chart house
  platform(7.4, 11.6, 1.2); // wide air-defence platform, overhangs everything
  house(9.0, 3.4, 8.5, 12.6, 1.4); // navigating bridge
  platform(6.0, 16.5, 1.0);
  house(7.2, 3.2, 7.0, 17.3, 1.0); // upper bridge
  platform(5.0, 21.0, 0.6); // searchlight platform
  // a gap here — bare column — which is what stops it reading as a stack
  platform(4.2, 26.5, 0.4);
  house(5.6, 3.0, 5.4, 27.1, 0.4); // fire-control tower

  // --- top: director drum, rangefinder, and the rig above them ---------------
  const topY = 30.1;
  const drum = dark(new CylinderGeometry(2.3, 2.6, 2.4, 16));
  drum.position.set(0, y0 + topY + 1.2, z0 + 0.4);
  g.add(drum);
  // the main rangefinder: a long horizontal tube out to both sides
  const rf = dark(new CylinderGeometry(0.8, 0.8, 13, 14));
  rf.rotation.z = Math.PI / 2;
  rf.position.set(0, y0 + topY + 3.0, z0 + 0.8);
  g.add(rf);
  for (const side of [-1, 1]) {
    const hood = dark(new BoxGeometry(1.4, 1.4, 1.6));
    hood.position.set(side * 6.5, y0 + topY + 3.0, z0 + 0.8);
    g.add(hood);
  }

  // --- the foremast rig ------------------------------------------------------
  // Above the director there is no more ship, only aerial. What was here was a
  // tapered pole with one bar across it, which is a flagstaff: solid, closed,
  // and nothing like the open lattice, combed yard and radar platforms that
  // make a warship's masthead. All of that is built in aerials.js and merged
  // into a single buffer, because it takes a hundred-odd thin members and one
  // draw call is what makes a hundred members affordable.
  const rig = createRig(u.slot);
  const foot = new Vector3(0, y0 + topY, z0 - 1.0); // on the fire-control house roof
  const head = latticeMast(rig, {
    x: foot.x, z: foot.z, y0: foot.y, height: 12.0, base: 1.7, top: 0.8, bays: 6,
  });
  // the signal yard, combed with whip aerials, low enough to be worked from the
  // platform below it
  const yard = yardarm(rig, { y: y0 + topY + 9.0, z: foot.z, span: 7.6, whips: 8 });
  // and the topmast proper: the slim pole with the stacked dipoles on it, which
  // is the highest thing in the ship
  const truck = topmast(rig, { at: head, height: 7.5, stacks: 5 });
  // aerial wires: down from under the truck to each yard tip, and on down to
  // the top of the pagoda. Rigging, not structure — hair-thin on purpose.
  const trunk = truck.clone().setY(truck.y - 1.4);
  aerialWire(rig, trunk, yard.port);
  aerialWire(rig, trunk, yard.stbd);
  aerialWire(rig, yard.port, new Vector3(-1.7, y0 + topY + 0.6, z0 - 2.1));
  aerialWire(rig, yard.stbd, new Vector3(1.7, y0 + topY + 0.6, z0 - 2.1));
  g.add(rig.mesh(u.materials.body));

  // platform at the masthead, under the topmast's foot
  const headPlat = steel(new CylinderGeometry(1.9, 1.9, 0.24, 16));
  headPlat.position.set(0, head.y - 0.12, foot.z);
  g.add(headPlat);
  railRing(1.7, topY + 12.0, -1.0, 12);

  // The surface-search set, on a platform bracketed out forward of the mast.
  //
  // Where it stands is not a matter of taste: a reflector two metres across
  // that turns all the way round has to have two metres of nothing all the way
  // round it, which rules out the lattice, rules out the yard, and — the one
  // that is easy to miss — rules out the whole height of the armoured column,
  // whose head is at topY + 7.8. So the platform is above that and well
  // forward, which is exactly where the real ones hang.
  const DISH_Y = topY + 8.6;
  const DISH_Z = 3.0;
  const dishPlat = steel(new CylinderGeometry(2.0, 2.0, 0.24, 16));
  dishPlat.position.set(0, y0 + DISH_Y, z0 + DISH_Z);
  g.add(dishPlat);
  railRing(1.8, DISH_Y + 0.12, DISH_Z, 12);
  for (const sx of [-1, 1]) {
    g.add(strut(
      new Vector3(sx * 0.8, y0 + topY + 5.4, z0 - 0.9),
      new Vector3(sx * 1.6, y0 + DISH_Y - 0.15, z0 + DISH_Z + 1.4), 0.1, dark,
    ));
    g.add(strut(
      new Vector3(sx * 0.8, y0 + DISH_Y - 0.15, z0 + DISH_Z - 1.4),
      new Vector3(sx * 1.6, y0 + DISH_Y - 0.15, z0 + DISH_Z + 1.4), 0.09, dark,
    ));
  }
  const dish = surfaceSearchDish({ slot: u.slot, material: u.materials.body, r: 1.33 });
  dish.position.set(0, y0 + DISH_Y + 0.05, z0 + DISH_Z); // pedestal foot on the platform
  g.add(dish);
  // A radar that has stopped turning is a dead radar, so she sweeps as long as
  // the bridge is alive and freezes where she stands when it is not.
  u.tick = (dt) => { if (u.damage.value < 0.999) dish.rotation.y += dt * 0.98; };

  // --- things hung off the column: searchlights and bridge wings ------------
  for (const side of [-1, 1]) {
    // open bridge wing off the lower house
    const wing = steel(new BoxGeometry(3.4, 0.35, 5.0));
    wing.position.set(side * 7.4, y0 + 10.9, z0 + 1.6);
    g.add(wing);
    // searchlight on the 21 m platform
    const sl = dark(new CylinderGeometry(0.85, 0.85, 1.2, 12));
    sl.position.set(side * 3.6, y0 + 21.9, z0 + 0.6);
    g.add(sl);
  }
  return u;
}

// --- funnel ------------------------------------------------------------------
export function buildFunnel({ materials }) {
  const u = unit('funnel', materials);
  const { object: g, mk } = u;
  const steel = mk(STEEL);
  const soot = mk([0.08, 0.08, 0.08], 0.7);
  const F = SUPER.funnel;
  const z0 = zOf(F.z);
  const y0 = deckY(F.z) + SUPER.funnelDeck.h;
  const rake = F.rake * Math.PI / 180;
  // where the axis has got to, `f` of the way up a raked stack
  const at = (f) => [0, y0 + F.h * f, z0 - Math.sin(rake) * F.h * f];

  // An oval stack, raked aft, and open at the top: a funnel is a pipe, and
  // looking down one should show sooty uptake, not a lid. That takes three
  // pieces — an outer wall, an inner wall turned inside out so its faces point
  // into the bore, and a chamfered lip joining them across the plating
  // thickness. Without the lip there is a visible gap between the two walls.
  const place = (m, f) => {
    m.scale.set(F.rx * (m.userData.rs || 1), 1, F.rz * (m.userData.rs || 1));
    m.rotation.x = -rake;
    const [, y, z] = at(f);
    m.position.set(0, y, z);
    return m;
  };
  const outer = steel(new CylinderGeometry(1, 1, F.h, 30, 1, true));
  g.add(place(outer, 0.5));

  // inner wall: winding reversed and normals negated, so it is lit and culled
  // as a surface facing into the pipe rather than out of it
  const boreGeo = new CylinderGeometry(0.86, 0.86, F.h, 30, 1, true);
  const bi = boreGeo.index.array;
  for (let i = 0; i < bi.length; i += 3) { const t = bi[i]; bi[i] = bi[i + 2]; bi[i + 2] = t; }
  const bn = boreGeo.getAttribute('normal').array;
  for (let i = 0; i < bn.length; i++) bn[i] = -bn[i];
  const bore = soot(boreGeo);
  bore.userData.rs = 1;
  g.add(place(bore, 0.5));

  // the lip: a short cone from the bore radius out to the shell radius, so the
  // plating thickness reads as a rim rather than as a crack
  const lip = soot(new CylinderGeometry(0.86, 1.0, 0.5, 30, 1, true));
  g.add(place(lip, 0.99));
  // a soot-blackened cap band just under the lip
  const cap = soot(new CylinderGeometry(1.05, 1.05, 1.8, 30, 1, true));
  cap.userData.rs = 1;
  g.add(place(cap, 0.93));
  // steam pipes up the back
  for (const dx of [-1.6, -0.6, 0.6, 1.6]) {
    const p = steel(new CylinderGeometry(0.16, 0.16, F.h * 0.9, 8));
    p.rotation.x = -rake;
    const [, y, z] = at(0.45);
    p.position.set(dx, y, z - F.rz - 0.3);
    g.add(p);
  }
  // an emitter point for smoke, at the lip
  const smoke = new Group();
  smoke.name = 'fx.smoke.funnel';
  smoke.position.set(0, y0 + F.h + 0.4, z0 - Math.sin(F.rake * Math.PI / 180) * F.h);
  g.add(smoke);
  return u;
}

// --- tripod mainmast ---------------------------------------------------------
export function buildMainmast({ materials }) {
  const u = unit('mainmast', materials);
  const { object: g, mk } = u;
  const steel = mk(STEEL);
  const dark = mk(STEEL_DARK, 0.4);
  const M = SUPER.mainmast;
  const z0 = zOf(M.z);
  // it stands on the aft deckhouse, so it starts at that deckhouse's roof
  const y0 = deckY(SUPER.aftSuper.z) + SUPER.aftSuper.h;
  const top = new Vector3(0, y0 + M.h * 0.72, z0);
  // three legs to a common head
  g.add(strut(new Vector3(0, y0, z0 + M.spread * 0.9), top, 0.32, dark));
  g.add(strut(new Vector3(-M.spread * 0.7, y0, z0 - M.spread * 0.55), top, 0.28, dark));
  g.add(strut(new Vector3(M.spread * 0.7, y0, z0 - M.spread * 0.55), top, 0.28, dark));
  // spotting top
  const spot = steel(new BoxGeometry(4.5, 2.2, 3.5));
  spot.position.copy(top).add(new Vector3(0, 1.1, 0));
  g.add(spot);
  // searchlight platform halfway up
  const plat = steel(new CylinderGeometry(3.2, 3.2, 0.3, 16));
  plat.position.set(0, y0 + M.h * 0.38, z0);
  g.add(plat);

  // --- the mainmast rig ------------------------------------------------------
  // A lattice topmast off the spotting top's roof, its own combed yard, and the
  // air-search array at the head of it. The array is the one thing up here that
  // has to be at the top of something: it is seven metres across and it turns,
  // so anything standing beside it is something it would hit.
  const rig = createRig(u.slot);
  const foot = new Vector3(0, top.y + 2.2, z0); // the spotting top's roof
  const head = latticeMast(rig, {
    z: z0, y0: foot.y, height: 8.0, base: 1.3, top: 0.6, bays: 4,
  });
  const yard = yardarm(rig, { y: foot.y + 2.8, z: z0, span: 5.4, whips: 6, whipH: 1.6 });
  aerialWire(rig, new Vector3(0, head.y - 0.6, z0), yard.port);
  aerialWire(rig, new Vector3(0, head.y - 0.6, z0), yard.stbd);
  // the gaff, raked aft off the mast: where the ensign flies under way
  rig.tube(
    new Vector3(0, foot.y + 1.0, z0 - 0.6),
    new Vector3(0, foot.y + 5.2, z0 - 4.4), 0.085, RIG, 0.42, 5,
  );
  g.add(rig.mesh(materials.body));

  const headPlat = steel(new CylinderGeometry(1.5, 1.5, 0.22, 14));
  headPlat.position.set(0, head.y - 0.11, z0);
  g.add(headPlat);

  const array = airSearchArray({ slot: u.slot, material: materials.body });
  array.position.set(0, head.y + 2.6, z0);
  g.add(array);
  u.tick = (dt) => { if (u.damage.value < 0.999) array.rotation.y += dt * 0.62; };
  return u;
}

// --- deckhouses ---------------------------------------------------------------
// The shelter deck around the funnel and the aft deckhouse. Big, plain, load-
// bearing: the AA tubs and boats sit on them. Not destructible on their own —
// they are part of the hull section under them.
export function buildDeckhouses({ materials }) {
  const u = unit('deckhouses', materials);
  const { object: g, mk } = u;
  const steel = mk(STEEL);
  const dark = mk(STEEL_DARK, 0.4);
  const D = SUPER.funnelDeck;
  const fd = steel(new BoxGeometry(D.w, D.h, D.l));
  fd.position.set(0, deckY(D.z) + D.h / 2, zOf(D.z));
  g.add(fd);

  // Scuttles down the deckhouse sides.
  //
  // The same fitting as the ones cut in the hull, off the same definition — see
  // scuttles.js. All this end has to supply is the point and the outward
  // normal, which on a flat plate is simply the side it is on.
  const scuttleGeoms = [];
  const SPACING = 1.9;
  function scuttle(x, y, z, side) {
    pushScuttle(scuttleGeoms, new Vector3(x, y, z), new Vector3(side, 0, 0), u.slot);
  }
  // A run down one side, `z0` the foremost of it. Runs are kept well short of
  // the corners of the plate, because a scuttle in the corner reads as a mistake.
  function scuttleRun(side, x, y, z0, count) {
    for (let k = 0; k < count; k++) scuttle(x, y, z0 - k * SPACING, side);
  }

  const A = SUPER.aftSuper;
  const ad = steel(new BoxGeometry(A.w, A.h, A.l));
  ad.position.set(0, deckY(A.z) + A.h / 2, zOf(A.z));
  g.add(ad);

  for (const side of [-1, 1]) {
    // shelter deck: one deck high, so one run, starting just clear of the
    // funnel's own footprint
    scuttleRun(side, side * (D.w / 2), deckY(D.z) + 1.45, zOf(D.z) - 4.2, 6);
    // aft deckhouse: one run, at the same height above its own deck. It is a
    // 5 m house and a second row up at the next deck would be defensible, but
    // two rows of scuttles read as a hotel rather than as a warship.
    scuttleRun(side, side * (A.w / 2), deckY(A.z) + 1.6, zOf(A.z) + 1.0, 7);
  }
  // rims and glass in one buffer: the colours are already baked per-vertex, so
  // two dozen scuttles cost one draw call rather than fifty
  g.add(new Mesh(merge(scuttleGeoms), materials.body));

  // Watertight doors into the superstructure.
  //
  // A rail with a gap in it is only half of a way aboard: the gap lands you on
  // the open deck, and the door is where you actually go inside. So there is one
  // either side at the head of each gangway — abreast the forward brow on the
  // shelter deck, abreast the after brow on the aft deckhouse — and one in the
  // aft deckhouse's after bulkhead, which is the face the quarterdeck walks up
  // to. Nowhere else: a door on a bulkhead nobody has a reason to walk to reads
  // as decoration.
  //
  // The parts are what make it read as a door rather than a painted rectangle: a
  // coaming standing proud of the plating (you step over it — that is the whole
  // reason it is there), the leaf recessed inside it, hinge straps down one
  // edge, and the handwheel that drives the dogs.
  //
  // Built facing local +x and turned by `yaw`, so the same door hangs on a side
  // bulkhead or on an end one. A group's local +x maps to (cos, 0, -sin), which
  // is why aft is +90°.
  const DOOR = { w: 0.86, h: 1.75, sill: 0.38 }; // knee-knocker coaming height
  const FACE = { port: 0, starboard: Math.PI, aft: Math.PI / 2, forward: -Math.PI / 2 };
  function watertightDoor(x, y, z, yaw) {
    const d = new Group();
    d.position.set(x, y, z);
    d.rotation.y = yaw;
    const coaming = dark(new BoxGeometry(0.10, DOOR.h + 0.24, DOOR.w + 0.24));
    coaming.position.set(0.05, DOOR.h / 2, 0);
    d.add(coaming);
    const leaf = mk([0.40, 0.43, 0.45], 0.5)(new BoxGeometry(0.07, DOOR.h, DOOR.w));
    leaf.position.set(0.07, DOOR.h / 2, 0);
    d.add(leaf);
    for (const dy of [-0.54, 0.54]) { // hinge straps down one edge
      const hinge = dark(new BoxGeometry(0.05, 0.16, 0.26));
      hinge.position.set(0.12, DOOR.h / 2 + dy, -DOOR.w / 2 + 0.1);
      d.add(hinge);
    }
    const wheel = dark(new TorusGeometry(0.14, 0.032, 5, 12));
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(0.13, DOOR.h * 0.52, DOOR.w * 0.24);
    d.add(wheel);
    g.add(d);
  }
  for (const side of [-1, 1]) {
    const face = side > 0 ? FACE.port : FACE.starboard;
    // shelter deck, at the head of the forward brow
    watertightDoor(side * (D.w / 2), deckY(D.z) + DOOR.sill, zOf(D.z) + 10, face);
    // aft deckhouse, at the head of the after brow
    watertightDoor(side * (A.w / 2), deckY(A.z) + DOOR.sill, zOf(A.z) + 5, face);
  }
  // and one out onto the quarterdeck, in the after bulkhead
  watertightDoor(0, deckY(A.z) + DOOR.sill, zOf(A.z) - A.l / 2, FACE.aft);

  // secondary director on the aft deckhouse
  const dir = dark(new CylinderGeometry(1.4, 1.6, 2.4, 14));
  dir.position.set(0, deckY(A.z) + A.h + 1.2, zOf(A.z) - 6);
  g.add(dir);
  return u;
}

// --- boats and derricks, ground tackle, fittings: dressing ------------------
export function buildDecor({ materials }) {
  const u = unit('decor', materials);
  const { object: g, mk } = u;
  const dark = mk(STEEL_DARK, 0.4);
  const D = SUPER.funnelDeck;
  const dy = deckY(D.z) + D.h;
  // Kingposts and derricks over the boat-handling strip.
  //
  // The ship's boats that used to stow here — three a side, in chocks on the
  // open main deck outboard of the shelter deck — have been taken off: at the
  // distance you actually see her from they read as plain slabs sitting on the
  // deck edge, not as boats. The handling gear stays.
  const boatX = (SHIP.halfBeam + D.w / 2) / 2; // midway between the deckhouse side and the rail
  for (const side of [-1, 1]) {
    // kingpost on the shelter deck, with a derrick boom reaching out over the strip
    const post = dark(new CylinderGeometry(0.35, 0.45, 14, 10));
    post.position.set(side * (D.w / 2 - 1.2), dy + 7, zOf(D.z) - 12);
    g.add(post);
    g.add(strut(
      new Vector3(side * (D.w / 2 - 1.2), dy + 12, zOf(D.z) - 12),
      new Vector3(side * boatX, dy + 4, zOf(D.z) - 1), 0.18, dark,
    ));
  }
  // Hawse pipes on the bow. (The bower anchors that used to hang there, and the
  // capstans and cable that used to run aft from here, have been taken off:
  // they read as clutter on the forecastle at any distance you actually see her
  // from.)
  const bowS = 0.87;
  const bz = (bowS - 0.5) * SHIP.length;
  const by = deckY(bowS - 0.5);
  for (const side of [-1, 1]) {
    const hpY = by - 1.5;
    const hpX = side * (sideAt(bowS, hpY) - 0.2);
    // hawse pipe through the plating, where the cable would run
    const hp = dark(new CylinderGeometry(0.75, 0.75, 1.6, 14, 1, true));
    hp.rotation.z = Math.PI / 2;
    hp.position.set(hpX, hpY, bz + 0.6);
    g.add(hp);
    const rim = dark(new TorusGeometry(0.75, 0.13, 6, 16));
    rim.rotation.y = Math.PI / 2;
    rim.position.set(hpX + side * 0.35, hpY, bz + 0.6);
    g.add(rim);
  }

  // Her pennant number, painted on the bow plating either side.
  for (const m of buildHullNumber(u.materials, HULL_NUMBER)) g.add(m);

  // (Life rings used to hang on the deckhouse sides, three a side. At this
  // scale a thin white torus on a grey bulkhead does not read as a life ring —
  // it reads as an empty scuttle, sitting in a row with the real ones and
  // making them look wrong. Taken off.)
  return u;
}

// --- steering gear and screws ------------------------------------------------
// Below the waterline at the stern. Two units, because a hit that jams the
// rudder is a different fight from one that stops the screws.
export function buildSteering({ materials }) {
  const u = unit('steering', materials);
  const { object: g, mk } = u;
  const red = mk([0.42, 0.14, 0.11], 0.5);
  const s = 0.05;
  const z0 = (s - 0.5) * SHIP.length;
  for (const side of [-1, 1]) {
    const rudder = red(new BoxGeometry(0.4, 5.5, 4.2));
    rudder.position.set(side * 3.2, -5.2, z0);
    rudder.name = side > 0 ? 'rudder.stbd' : 'rudder.port';
    g.add(rudder);
  }
  return u;
}

export function buildScrews({ materials }) {
  const u = unit('screws', materials);
  const { object: g, mk } = u;
  const brass = mk([0.62, 0.50, 0.28], 0.25);
  const red = mk([0.42, 0.14, 0.11], 0.5);
  const s = 0.085;
  const z0 = (s - 0.5) * SHIP.length;

  // Each screw is its own pivot so it can turn. The blades hang off it rather
  // than off the unit, because a propeller that is welded to the ship is the
  // sort of thing you only notice once — and then cannot stop noticing.
  const screws = [];
  const shafts = [
    [-6.4, -6.2, +1], [6.4, -6.2, -1], // wing shafts
    [-3.0, -7.4, +1], [3.0, -7.4, -1], // inner shafts
  ];
  for (const [x, y, dir] of shafts) {
    const pivot = new Group();
    pivot.position.set(x, y, z0);
    g.add(pivot);
    // Outboard and inboard shafts turn opposite ways. Real ships hand their
    // screws so the torques cancel — otherwise she crabs under power.
    screws.push({ pivot, dir });

    pivot.add(brass(new SphereGeometry(0.55, 10, 8)));
    // a fairing cone over the boss, aft
    const cone = brass(new CylinderGeometry(0.5, 0.12, 0.9, 10));
    cone.rotation.x = Math.PI / 2;
    cone.position.z = -0.6;
    pivot.add(cone);

    for (let k = 0; k < 3; k++) {
      const blade = brass(new BoxGeometry(0.25, 2.2, 1.1));
      blade.rotation.z = (k / 3) * Math.PI * 2;
      blade.rotation.y = 0.5 * dir; // pitch handed with the direction of turn
      blade.translateY(1.2);
      pivot.add(blade);
    }

    // shaft and its bracket back to the hull — these do not turn
    g.add(strut(new Vector3(x, y, z0), new Vector3(x * 0.55, y + 1.5, z0 + 12), 0.28, red));
    g.add(strut(new Vector3(x, y, z0 + 2), new Vector3(x * 0.4, y + 4.5, z0 + 2), 0.22, red));
  }

  // Turn the shafts. `rps` is revolutions per second at the shaft.
  u.spin = (dt, rps) => {
    const w = rps * Math.PI * 2 * dt;
    for (const sc of screws) sc.pivot.rotation.z += w * sc.dir;
  };
  return u;
}
