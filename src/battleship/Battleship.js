import { Group, Mesh, Vector3, Quaternion } from 'three/webgpu';
import { createShipMaterials, paint } from './shipMaterial.js';
import {
  SHIP, COMPARTMENTS, TURRETS, TURRET_SPEC, AA_MOUNTS, SUPER, COMPONENT_STATS,
  assertOnDeckhouse,
} from './spec.js';
import {
  buildHullSections, buildDeckSections, hullDescriptor, deckY, zOf, halfBeamAt,
  checkSuperfiringClearance, DECK_COLOR, STEEL,
} from './hull.js';
import { createMainTurret, createAAMount } from './mounts.js';
import {
  buildBridge, buildFunnel, buildMainmast, buildDeckhouses, buildDecor,
  buildSteering, buildScrews,
} from './superstructure.js';
import { buildRailings } from './railings.js';
import { buildHullScuttles } from './scuttles.js';
import { createDebris } from './debris.js';
import { createDamageModel, STATUS } from './damage.js';
import { createFireSmoke } from './fx.js';
import { createHullSpray } from '../boat/hullSpray.js';

// Mean sea level, for anything that has left the ship and has to land somewhere.
// Replaced each frame by the plane the buoyancy solver fitted to her probes.
const FLAT_SEA = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };

// The ship as an assembly.
//
// Structure is: one root Group carrying every part, with the hull split into
// five sections that are separately drawn and separately destructible; the
// turrets, AA and casemates are articulated mounts under it; the bridge,
// funnel, mainmast, steering and screws are their own destructible units. A
// damage model owns the state, and each component's `damage` uniform is what
// its materials read, so a hit shows up without anything being rebuilt.
//
// This is the ship only — no gunnery, no AI, no hit detection. What it exposes
// is the surface those will need: named mounts that train, named components
// that take damage, and a flooding state the buoyancy solver can consume.

export function createBattleship({ shading, sunShadow }) {
  const root = new Group();
  root.name = 'battleship';
  const parts = new Map(); // id -> { object, damage }

  // Two shader programs for the whole ship: everything that varies per part
  // lives in vertex attributes or in an indexed damage array. See
  // shipMaterial.js — building a material per mesh instead costs a WGSL compile
  // per mesh, which for a ship of a few hundred parts stops the frame outright.
  const materials = createShipMaterials({ shading, sunShadow });
  const damageUniforms = new Map();
  const uni = (id) => {
    if (!damageUniforms.has(id)) damageUniforms.set(id, materials.handleFor(id));
    return damageUniforms.get(id);
  };

  // --- hull, in watertight sections -----------------------------------------
  const hullSections = buildHullSections();
  const deckSections = buildDeckSections();
  // The scuttles down each side, modelled and fitted to the section curve. One
  // merged mesh per hull section, carrying that section's damage slot, so they
  // char and are destroyed with the plating they are cut into.
  const hullScuttles = buildHullScuttles({ materials });
  for (const sec of hullSections) {
    const g = new Group();
    g.name = sec.id;
    const slot = materials.slotOf(sec.id);
    uni(sec.id);
    // the hull loft is already vertex-coloured: antifoul below, boot topping at
    // the line, grey above — so only roughness and the damage slot are added
    g.add(new Mesh(paint(sec.geometry, {
      roughness: 0.42, slot, keepColor: true, paintMask: 1,
    }), materials.body));
    const deck = deckSections.find((d) => d.id === sec.id);
    // teak, not plate: the one large surface on her that is not metal at all
    g.add(new Mesh(paint(deck.geometry, { color: DECK_COLOR, roughness: 0.78, slot, metal: 0 }), materials.deck));
    if (hullScuttles.has(sec.id)) g.add(hullScuttles.get(sec.id));
    root.add(g);
    parts.set(sec.id, { object: g, damage: uni(sec.id) });
  }

  // --- superstructure --------------------------------------------------------
  // nothing may hang off the edge of the deckhouse it stands on
  assertOnDeckhouse([
    { id: 'mainmast', z: SUPER.mainmast.z, halfLength: SUPER.mainmast.spread * 0.9, halfWidth: SUPER.mainmast.spread * 0.7 },
    ...AA_MOUNTS.filter((a) => a.on === 'aftSuper').map((a) => ({ ...a, halfLength: 2.2, halfWidth: 2.2 })),
  ], SUPER.aftSuper, SHIP.length);
  const superUnits = [
    buildDeckhouses({ materials }),
    buildBridge({ materials }),
    buildFunnel({ materials }),
    buildMainmast({ materials }),
    buildDecor({ materials }),
    buildSteering({ materials }),
    buildScrews({ materials }),
  ];
  const screwUnit = superUnits.find((x) => x.id === 'screws');
  for (const u of superUnits) {
    root.add(u.object);
    parts.set(u.id, { object: u.object, damage: u.damage });
    damageUniforms.set(u.id, u.damage);
  }

  // --- guardrails, and the wreckage they become ------------------------------
  // Wreckage does not live on the ship: a length of rail that has been blown off
  // her is a body in world space with its own trajectory, so `debris.group` goes
  // into the scene rather than under `root` (main.js adds it). Splashes are the
  // launch's droplet system — a piece of steel going into the sea throws water,
  // and water is water.
  const splash = createHullSpray({ shading, count: 3000 });
  const shipVelocity = new Vector3();
  const _dq = new Quaternion();
  const _splashUp = new Vector3(0, 1, 0);

  const debris = createDebris({
    material: materials.body,
    onSplash: (at, speed) => {
      if (!splash.mesh.visible) return; // the fx panel's hull-spray switch
      splash.burst(at, _splashUp, Math.min(2.5 + speed * 0.4, 10), Math.min(70, 14 + speed * 4), {
        spread: 1.1, size: 0.55, life: 1.4,
      });
    },
  });

  const railings = buildRailings({
    materials,
    // ship frame -> world. The piece leaves with the ship's own velocity in it,
    // which is what makes it fall astern of her instead of straight down.
    onDetach: ({ geometry, position, quaternion, impulse, spin }) => {
      debris.spawn(
        geometry,
        toWorld(position, new Vector3()),
        _dq.copy(root.quaternion).multiply(quaternion),
        impulse.applyQuaternion(root.quaternion).add(shipVelocity),
        spin,
      );
    },
  });
  root.add(railings.object);
  parts.set('railings', { object: railings.object, damage: null });

  // --- main battery ----------------------------------------------------------
  // throws if a superfiring turret would shoot through the one in front of it
  const clearances = checkSuperfiringClearance(TURRETS, TURRET_SPEC);
  const mounts = new Map();
  const turrets = [];
  for (const t of TURRETS) {
    const m = createMainTurret({
      id: t.id, materials, arcCenter: t.arcCenter, arc: t.arc,
      barbetteHeight: t.deckRise, bandstand: t.bandstand || 0,
    });
    m.root.position.set(0, deckY(t.z), zOf(t.z));
    m.station = t;
    root.add(m.root);
    mounts.set(t.id, m);
    turrets.push(m);
    parts.set(t.id, { object: m.root, damage: m.damage });
    damageUniforms.set(t.id, m.damage);
  }

  // --- AA mounts -------------------------------------------------------------
  const aaMounts = [];
  for (const a of AA_MOUNTS) {
    const m = createAAMount({ id: a.id, materials });
    let y = deckY(a.z);
    if (a.on === 'aftSuper') y = deckY(SUPER.aftSuper.z) + SUPER.aftSuper.h;
    else if (a.on === 'funnelDeck') y = deckY(SUPER.funnelDeck.z) + SUPER.funnelDeck.h;
    else if (a.on === 'turret.B') {
      const b = mounts.get('turret.B');
      // rides on B turret's roof, so it trains with the turret under it
      m.root.position.set(0, TURRET_SPEC.gunhouseH + 0.1, -2.0);
      b.yawPivot.add(m.root);
      m.carriedBy = b;
      aaMounts.push(m);
      mounts.set(a.id, m);
      damageUniforms.set(a.id, m.damage);
      continue;
    }
    m.root.position.set(a.x * SHIP.halfBeam, y + (a.y || 0), zOf(a.z));
    root.add(m.root);
    mounts.set(a.id, m);
    aaMounts.push(m);
    damageUniforms.set(a.id, m.damage);
  }

  // --- damage model ----------------------------------------------------------
  const fx = createFireSmoke({ shading });
  const damage = createDamageModel();

  // hull sections: they flood, and their volume is roughly their share of the
  // length weighted by how full that part of the hull is
  //
  // `railWear` is how much damage a section had taken the last time its rail was
  // touched, so a working-over strips the rail a stretch at a time as the hits
  // land rather than all at once at some threshold.
  const railWear = new Map();
  for (const cpt of COMPARTMENTS) {
    const mid = (cpt.s[0] + cpt.s[1]) / 2;
    const stats = COMPONENT_STATS[cpt.id] || COMPONENT_STATS['hull.*'];
    damage.add({
      id: cpt.id,
      hp: stats.hp,
      armor: stats.armor,
      group: 'hull',
      damage: uni(cpt.id),
      floods: true,
      z: mid - 0.5,
      volume: (cpt.s[1] - cpt.s[0]) * halfBeamAt(mid) / SHIP.halfBeam,
      critical: stats.critical || [],
      onDamage: (c, frac) => {
        const worn = railWear.get(c.id) || 0;
        if (frac - worn < 0.05) return;
        railWear.set(c.id, frac);
        // somewhere along this compartment, one side or the other
        const s = cpt.s[0] + Math.random() * (cpt.s[1] - cpt.s[0]);
        railings.blastAt(s - 0.5, Math.random() < 0.5 ? 1 : -1, 5 + 24 * (frac - worn));
      },
      onKill: () => {
        // a wrecked section is wide open to the sea, and there is no guardrail
        // left standing over it
        damage.get(cpt.id).breach = 1;
        railings.wreck(cpt.id);
      },
      onRepair: () => {
        railWear.set(cpt.id, 0);
        railings.restore(); // a no-op once the first section has put it all back
      },
    });
  }
  // turrets: a kill droops the guns and stops them training
  for (const m of turrets) {
    damage.add({
      id: m.id, hp: COMPONENT_STATS['turret.*'].hp, armor: COMPONENT_STATS['turret.*'].armor,
      group: 'turret', damage: m.damage, z: m.station.z,
      onKill: () => { m.kill(); },
      onRepair: () => { m.restore(); },
    });
  }
  for (const m of aaMounts) {
    const stats = COMPONENT_STATS['aa.*'];
    damage.add({
      id: m.id, hp: stats.hp, armor: stats.armor, group: m.kind, damage: m.damage,
      onKill: () => { m.kill(); },
      onRepair: () => { m.restore(); },
    });
  }
  for (const id of ['bridge', 'funnel', 'mainmast', 'steering', 'screws']) {
    const stats = COMPONENT_STATS[id];
    damage.add({
      id, hp: stats.hp, armor: stats.armor, group: 'super',
      damage: damageUniforms.get(id), z: id === 'bridge' ? SUPER.bridge.z : SUPER.mainmast.z,
      critical: stats.critical || [],
    });
  }

  // Where fire and smoke come out of a given component, in the ship's frame.
  const fireOrigins = new Map([
    ['hull.stern', new Vector3(0, deckY(-0.42), zOf(-0.42))],
    ['hull.aft', new Vector3(0, deckY(-0.23), zOf(-0.23))],
    ['hull.mid', new Vector3(0, deckY(-0.01), zOf(-0.01))],
    ['hull.fore', new Vector3(0, deckY(0.21), zOf(0.21))],
    ['hull.bow', new Vector3(0, deckY(0.41), zOf(0.41))],
    ['bridge', new Vector3(0, deckY(SUPER.bridge.z) + 14, zOf(SUPER.bridge.z))],
    ['funnel', new Vector3(0, deckY(SUPER.funnel.z) + 6, zOf(SUPER.funnel.z))],
    ['mainmast', new Vector3(0, deckY(SUPER.mainmast.z) + 6, zOf(SUPER.mainmast.z))],
  ]);
  for (const m of turrets) fireOrigins.set(m.id, new Vector3(0, deckY(m.station.z) + 3, zOf(m.station.z)));

  // funnel smoke emitter, in ship-local space
  const funnelSmoke = new Vector3(
    0,
    deckY(SUPER.funnel.z) + SUPER.funnelDeck.h + SUPER.funnel.h + 0.5,
    zOf(SUPER.funnel.z) - Math.sin(SUPER.funnel.rake * Math.PI / 180) * SUPER.funnel.h,
  );

  // Every part of the ship both casts into the shadow map and reads from it, so
  // the pagoda lays a shadow down her own decks and a turret shadows the hull
  // beside it. Without `receiveShadow` the meshes still cast, which gives you
  // the odd result of a ship that shadows the sea but not itself.
  //
  // The exception is anything flagged `noShadow`: geometry that stands a couple
  // of centimetres off a surface to stand in for paint. It has no thickness to
  // cast with, and at that offset its own entry in the shadow map lands back on
  // itself, which turns a white numeral into a black one.
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = !o.userData.noShadow;
    o.frustumCulled = false;
  });

  const _w = new Vector3();
  let shaftRps = 0;
  const _carry = new Vector3();
  let smokeDebt = 0;
  const fireDebt = new Map();

  // Ship-local point -> world, using the root's current transform.
  function toWorld(v, out) {
    return out.copy(v).applyQuaternion(root.quaternion).add(root.position);
  }

  const state = {
    flood: 0,
    floodZ: 0,
    burning: 0,
    sinking: false,
  };

  // Things the ship is *set* to, as opposed to things that have happened to her.
  const settings = {};

  // `throttle` drives funnel smoke, `velocity`/`wind` carry the plumes, and
  // `sea` is the water plane the buoyancy solver fitted this frame — wreckage
  // needs to know where the surface is to land in it.
  function update(dt, {
    throttle = 0, velocity = null, wind = null, dcEffort = 1, sea = FLAT_SEA,
    funnelSmoke: makeSmoke = true, fires: makeFires = true,
  } = {}) {
    for (const m of mounts.values()) m.update(dt);
    if (velocity) shipVelocity.copy(velocity);

    // Shafts. They turn with the throttle, they keep turning (slowly) while she
    // still has way on with the engines stopped — a stopped screw on a moving
    // ship windmills — and they stop dead if the screws are shot away.
    if (screwUnit) {
      const way = velocity ? Math.min(Math.hypot(velocity.x, velocity.z) / 12, 1) : 0;
      const demand = Math.abs(throttle) * 3.6 + way * 0.7; // rev/s at the shaft
      shaftRps += (demand - shaftRps) * Math.min(dt * 0.8, 1); // engines spool
      const alive = damage.alive('screws') ? 1 : 0;
      screwUnit.spin(dt, shaftRps * alive * Math.sign(throttle || 1));
    }

    const d = damage.update(dt, dcEffort);
    state.flood = d.flood;
    state.floodZ = d.floodZ;
    state.burning = d.burning;
    state.sinking = d.flood > 0.55;

    _w.set(0, 0, 0);
    if (wind) _w.copy(wind);
    _carry.set(0, 0, 0);
    if (velocity) _carry.copy(velocity).multiplyScalar(0.5);

    // funnel smoke: a working ship always makes some, and more under power
    smokeDebt += makeSmoke
      ? (2 + Math.abs(throttle) * 26 + (damage.alive('funnel') ? 0 : 40)) * dt
      : 0;
    const puffs = Math.floor(smokeDebt);
    if (puffs > 0) {
      smokeDebt -= puffs;
      fx.emit(toWorld(funnelSmoke, new Vector3()), puffs, {
        kind: 0,
        rise: 3.5 + throttle * 2.5,
        spread: SUPER.funnel.rx * 1.4,
        size: 3.2,
        life: 7.0,
        grow: 2.6,
        carry: _carry,
      });
    }

    // burning components throw flame and a much larger volume of smoke
    for (const c of makeFires ? damage.components.values() : []) {
      if (c.fire <= 0.01) continue;
      const origin = fireOrigins.get(c.id);
      if (!origin) continue;
      const world = toWorld(origin, new Vector3());
      const rate = c.fire * 55;
      const debt = (fireDebt.get(c.id) || 0) + rate * dt;
      const n = Math.floor(debt);
      fireDebt.set(c.id, debt - n);
      if (n > 0) {
        fx.emit(world, Math.ceil(n * 0.45), {
          kind: 1, rise: 7, spread: 3.5 * c.fire, size: 2.4, life: 1.1, grow: 1.4, carry: _carry,
        });
        fx.emit(world, n, {
          kind: 0, rise: 5, spread: 4.5 * c.fire, size: 3.4, life: 9, grow: 3.2, carry: _carry,
        });
      }
    }
    fx.update(dt, _w);
    debris.update(dt, sea);
    splash.update(dt, sea, _w);
  }

  // --- public surface --------------------------------------------------------
  return {
    group: root,
    materials,
    clearances,
    fx,
    railings,
    // both live in world space; main.js puts them in the scene itself
    debris,
    splash,
    hull: hullDescriptor,
    mounts, // id -> mount, all of them
    turrets,
    aaMounts,
    damage,
    state,
    settings,
    update,
    // aim every main turret at a world point; those that cannot bear stay at
    // their limit, which is the visible signal to the helm to turn the ship
    aimMainBattery(worldPoint) {
      const local = root.worldToLocal(worldPoint.clone());
      const yaw = Math.atan2(-local.x, local.z) * 180 / Math.PI;
      const range = Math.hypot(local.x, local.z);
      // rough gravity arc for a 250 m/s shell, small-angle solution
      const elev = Math.min(TURRET_SPEC.elevMax,
        0.5 * Math.asin(Math.min(1, (range * 9.81) / (250 * 250))) * 180 / Math.PI);
      for (const m of turrets) if (!m.destroyed) m.setTarget(yaw, elev);
      return { yaw, elev, range };
    },
    // which turrets can actually bear on a bearing (deg, 0 = ahead, + starboard)
    canBear(yaw) {
      return turrets.filter((m) => {
        if (m.destroyed) return false;
        const rel = ((((yaw - m.arcCenter) + 180) % 360) + 360) % 360 - 180;
        return Math.abs(rel) <= m.arc;
      });
    },
    parts,
    STATUS,
  };
}
