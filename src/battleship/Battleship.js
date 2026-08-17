import { Group, Mesh, Vector3, Quaternion, Matrix4 } from 'three/webgpu';
import { createShipMaterials, paint } from './shipMaterial.js';
import {
  SHIP, COMPARTMENTS, TURRETS, TURRET_SPEC, AA_MOUNTS, SUPER, COMPONENT_STATS,
  assertOnDeckhouse,
} from './spec.js';
import {
  buildHullSections, buildDeckSections, hullDescriptor, deckY, zOf, halfBeamAt,
  checkSuperfiringClearance, DECK_COLOR, STEEL, deckAt, sideAt, keelAt, PLATING,
} from './hull.js';
import { createMainTurret, createAAMount } from './mounts.js';
import {
  buildBridge, buildFunnel, buildMainmast, buildDeckhouses, buildDecor,
  buildSteering, buildScrews,
} from './superstructure.js';
import { buildRailings } from './railings.js';
import { buildDeckProps } from './deckProps.js';
import { buildHullScuttles } from './scuttles.js';
import { createWreck } from './wreck.js';
import { createDamageModel, STATUS } from './damage.js';
import { createFireSmoke } from './fx.js';
import { createHullSpray } from '../boat/hullSpray.js';
import { createDamageField, VOXEL } from './damageField.js';
import { buildInterior, buildDeckhouseInteriors, buildFloodWater } from './interior.js';
import { createColliders } from './colliders.js';
import { createStructure } from './structure.js';
import { createFittings } from './fittings.js';
import { createFlooding } from './flooding.js';
import { createShards } from './shards.js';
import { createBurst } from './burst.js';
import { buildTornPlating } from './plating.js';
import { STRUCTURE, WOUNDS, BUOYANCY } from './spec.js';

// Mean sea level, for anything that has left the ship and has to land somewhere.
// Replaced each frame by the plane the buoyancy solver fitted to her probes.
const FLAT_SEA = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };
const DOWN = new Vector3(0, -1, 0);

// How much flatter a tear is than it is wide, measured along the shell's own
// path. A burst against a surface takes a wide shallow bowl out of *that
// surface*; it does not bore a sphere through the ship.
//
// The number is set against PLATING, the depth her plating reads as and the
// depth interior.js draws the backing at. A shell's tear has to stop short of
// that, because the backing is the floor of the chip and a tear that goes
// through it turns the chip back into a window. At 3.2 an HE shell opens three
// metres of deck and reaches about one metre in, against a backing at 1.15 — so
// what you see through the hole is a solid floor a metre down. A torpedo's tear
// reaches nearly four metres and goes straight through it, which is the one
// case where you *should* be looking into her.
const TEAR_FLATTEN = 3.2;

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

  // Where she has been hurt, as a field in her own frame. This has to exist
  // before the materials do, because every one of them samples it — see
  // damageField.js for what is in it and boatMaterial.js for what is done with
  // it. Bounds cover keel to foretop with a voxel of margin all round, so the
  // clamp-to-edge sample outside them reads zero.
  const field = createDamageField({
    bounds: {
      min: [-SHIP.halfBeam - 2.5, -SHIP.keel - 2.5, -SHIP.length / 2 - 3],
      max: [SHIP.halfBeam + 2.5, 50, SHIP.length / 2 + 3],
    },
  });

  // Two shader programs for the whole ship: everything that varies per part
  // lives in vertex attributes or in an indexed damage array. See
  // shipMaterial.js — building a material per mesh instead costs a WGSL compile
  // per mesh, which for a ship of a few hundred parts stops the frame outright.
  const materials = createShipMaterials({ shading, sunShadow, destruction: field.shading });
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

  // --- the inside of her -----------------------------------------------------
  // Without this a hole in her side shows you the sea through the ship, because
  // the far side of the hull is facing away and is culled. See interior.js: the
  // liner rides on the same program as the plating and is drawn after it, so
  // where the plating is whole the depth test throws it away unshaded.
  const interior = buildInterior({ materials });
  root.add(interior.group);
  // The same again for the boxes standing on her deck. Built after the hull
  // liner and before the deckhouses themselves, so a hole punched in a
  // deckhouse side looks into a compartment rather than out at the sky.
  const houseInterior = buildDeckhouseInteriors({ materials });
  root.add(houseInterior.group);
  const floodWater = buildFloodWater({ shading });
  root.add(floodWater.group);

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

  // What lands on her, and what that does to her, is in wreck.js. Colliders are
  // wired in below once the mounts exist — a piece of wreckage has to be able to
  // tell a turret roof from the sea.
  const wreck = createWreck({
    material: materials.body,
    onSplash: (at, speed, mass) => {
      if (!splash.mesh.visible) return; // the fx panel's hull-spray switch
      // a hundred tonnes of funnel going in is not a guardrail going in
      const heft = Math.min(3.5, 0.6 + Math.log10(Math.max(mass, 10)) * 0.55);
      splash.burst(at, _splashUp,
        Math.min(2.5 + speed * 0.4, 10) * heft,
        Math.min(220, (14 + speed * 4) * heft),
        { spread: 1.1 * heft, size: 0.55 * heft, life: 1.4 + heft * 0.4 });
    },
    onImpact: (ev) => onWreckImpact(ev),
  });
  // the guardrail has always called this `debris`, and it is the same thing
  const debris = wreck;

  // How long a piece of this component swims once it is in the water. The
  // wildcard entries are what a family shares: every AA tub is the same tub.
  const buoyancyOf = (id) => BUOYANCY[id]
    ?? BUOYANCY[`${String(id).split('.')[0]}.*`]
    ?? 0;

  const railings = buildRailings({
    materials,
    // ship frame -> world. The piece leaves with the ship's own velocity in it,
    // which is what makes it fall astern of her instead of straight down.
    onDetach: ({ geometry, position, quaternion, impulse, spin }) => {
      wreck.spawn(
        geometry,
        toWorld(position, new Vector3()),
        _dq.copy(root.quaternion).multiply(quaternion),
        impulse.applyQuaternion(root.quaternion).add(shipVelocity),
        spin,
        { buoyancy: buoyancyOf('railings') },
      );
    },
  });
  root.add(railings.object);
  parts.set('railings', { object: railings.object, damage: null });

  // --- what is lying about on her deck ---------------------------------------
  //
  // Vent cowls, drums, crates, hatch coamings and mooring gear. The same
  // arrangement as the guardrail and for the same reasons: merged per watertight
  // section so eighty-odd objects cost five draw calls, carrying that section's
  // damage slot so they char with the plating they stand on, and handed to the
  // wreck integrator a piece at a time when a shell reaches them. See
  // deckProps.js — in particular for why they are solid to the player and not to
  // the camera.
  const deckProps = buildDeckProps({
    materials,
    onDetach: ({ geometry, position, quaternion, impulse, spin, mass }) => {
      wreck.spawn(
        geometry,
        toWorld(position, new Vector3()),
        _dq.copy(root.quaternion).multiply(quaternion),
        impulse.applyQuaternion(root.quaternion).add(shipVelocity),
        spin,
        // A crate is a box of air with boards round it and it swims; everything
        // else here is a steel casting or a drum full of oil and it does not.
        { mass, buoyancy: mass < 80 ? 20 : 0 },
      );
    },
  });
  root.add(deckProps.object);
  parts.set('deckProps', { object: deckProps.object, damage: null });

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
  // Water is no longer a number this owns. `flooding.js` holds it, because it
  // is a question about holes and heads and where the water sits, and none of
  // that is expressible as one float per compartment.
  const flooding = createFlooding();
  const shards = createShards({ shading });
  const burst = createBurst({ fx, splash, shards });
  // The large pieces of plating a burst takes off her. One set of geometries for
  // the whole ship; see plating.js for why these are bodies and the shards are
  // not.
  const platePieces = buildTornPlating({ materials });

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
      z: mid - 0.5,
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
        // A wrecked section is open to the sea over its whole side, there is no
        // guardrail left standing over it, and anything that was bolted to it
        // has nothing left to be bolted to.
        flooding.wreck(cpt.id);
        railings.wreck(cpt.id);
        deckProps.wreck(cpt.id);
        if (structure) structure.collapse(cpt.id, { x: 0, y: deckY(mid - 0.5), z: zOf(mid - 0.5) });
      },
      onRepair: () => {
        railWear.set(cpt.id, 0);
        railings.restore(); // a no-op once the first section has put it all back
        deckProps.restore();
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
      onKill: () => {
        m.kill();
        // a tub is a light thing bolted to a deckhouse; killing it usually
        // means it is no longer bolted to anything
        if (structure) structure.weaken(m.id, 0.7);
      },
      onRepair: () => { m.restore(); },
    });
  }
  for (const id of ['bridge', 'funnel', 'mainmast', 'steering', 'screws']) {
    const stats = COMPONENT_STATS[id];
    damage.add({
      id, hp: stats.hp, armor: stats.armor, group: 'super',
      damage: damageUniforms.get(id), z: id === 'bridge' ? SUPER.bridge.z : SUPER.mainmast.z,
      critical: stats.critical || [],
      // Running out of hit points does not decide where a thing breaks — that is
      // still whichever of its sections was thinnest, which is wherever it was
      // shot. It only decides that something has to give.
      //
      // For the two towers it decides something different, because neither of
      // them leaves her: a destroyed pagoda is a wrecked pagoda still standing
      // where it was, with everything that was hung on it down on the deck. See
      // fittings.js.
      onKill: () => {
        if (id === 'bridge' || id === 'mainmast') fittings.collapse(id);
        else if (structure) structure.weaken(id, 1.2);
      },
      onRepair: () => { if (structure) structure.repair(); },
    });
  }

  // --- where every mesh sits in the damage field ------------------------------
  //
  // Baked once, with every mount at rest, and never touched again. This is the
  // matrix the shader uses to find a fragment's place in the field, and the
  // reason it is per-object and constant rather than the live world transform
  // is in boatMaterial.js: a turret has to carry its holes round with it as it
  // trains, and a funnel lying across the quarterdeck has to keep the ones that
  // felled it.
  root.updateMatrixWorld(true);
  const _rootInv = new Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.fieldXform = new Matrix4().multiplyMatrices(_rootInv, o.matrixWorld);
  });

  // --- what a falling piece can land on ---------------------------------------
  //
  // `extra` is every level of the two towers, handed over by the builders that
  // drew them rather than restated here. Without it the pagoda was a four-metre
  // column inside a seventeen-metre tower as far as anything falling on it was
  // concerned, and a yardarm shot off the foretop went through every gallery on
  // the way down and came to rest inside one of them.
  //
  // Some of those levels can themselves be shot away — the mainmast's spotting
  // top, its searchlight platform, the bridge wings — so a shape can name a
  // fitting instead of a component, and stops being solid when that fitting
  // leaves. Fitting ids and component ids share one namespace here, which is
  // what lets both kinds go through `needs`.
  const colliders = createColliders({
    mounts,
    alive: (id) => {
      const f = fittings.get(id);
      return f ? !f.gone : damage.alive(id);
    },
    extra: superUnits.flatMap((un) => un.solids || []),
    // so a crater is a hole to a falling body as well as to the eye
    removed: (x, y, z) => field.removedAt(x, y, z),
  });
  wreck.setColliders(colliders);

  // --- what can break, and where -----------------------------------------------
  // The spine geometry is read off the same numbers superstructure.js built the
  // meshes from, so the line a funnel breaks along is the funnel's own axis and
  // not an approximation of it.
  const funnelRake = (SUPER.funnel.rake * Math.PI) / 180;
  //
  // The pagoda and the mainmast are not in this list, and that is deliberate.
  // Both used to be spined structure units, so enough damage at the foot sent
  // the whole tower — or the whole tripod — over the side as one object. A
  // funnel does that; an armoured conning column carrying the ship's fire
  // control does not, and a tripod mast does not either. What comes off them is
  // the top-hamper, piece by piece, and that lives in fittings.js. See
  // buildBridge and buildMainmast for what is registered.
  const structureUnits = [
    {
      id: 'funnel',
      object: parts.get('funnel').object,
      mass: STRUCTURE.funnel.mass,
      attach: STRUCTURE.funnel.attach,
      foot: {
        x: 0, y: deckY(SUPER.funnel.z) + SUPER.funnelDeck.h, z: zOf(SUPER.funnel.z),
        r: STRUCTURE.funnel.foot.r, strength: 1.3,
      },
      spine: {
        base: new Vector3(0, deckY(SUPER.funnel.z) + SUPER.funnelDeck.h, zOf(SUPER.funnel.z)),
        // raked aft, like the stack itself
        dir: new Vector3(0, Math.cos(funnelRake), -Math.sin(funnelRake)),
        length: STRUCTURE.funnel.spine.length,
        radius: STRUCTURE.funnel.spine.radius,
        sections: STRUCTURE.funnel.spine.sections,
        strength: STRUCTURE.funnel.spine.strength,
      },
    },
  ];
  // The AA mounts: nothing to break along, but plenty to knock off its feet —
  // and each is attached to the deckhouse it stands on, so losing that takes
  // them with it.
  for (const m of aaMounts) {
    const a = AA_MOUNTS.find((k) => k.id === m.id);
    if (!a || a.on === 'turret.B') continue;
    structureUnits.push({
      id: m.id,
      object: m.root,
      mass: STRUCTURE['aa.*'].mass,
      attach: a.on === 'aftSuper' ? 'hull.aft' : 'hull.mid',
      foot: {
        x: m.root.position.x, y: m.root.position.y, z: m.root.position.z,
        r: STRUCTURE['aa.*'].foot.r, strength: 0.5,
      },
      spine: null,
    });
  }

  const _sevPos = new Vector3();
  const _sevQuat = new Quaternion();
  const _sevScale = new Vector3();
  const _sevM = new Matrix4();

  const structure = createStructure({
    units: structureUnits,
    colliders,
    onSever: (ev) => {
      // Where the piece is standing at the instant it lets go, in the ship's
      // frame. Taken off the live matrix rather than assumed, because an AA
      // mount is parented under its own root and a superstructure unit is not.
      root.updateMatrixWorld(true);
      _sevM.copy(root.matrixWorld).invert().multiply(ev.unit.object.matrixWorld);
      _sevM.decompose(_sevPos, _sevQuat, _sevScale);
      ev.object.position.copy(_sevPos);
      ev.object.quaternion.copy(_sevQuat);
      wreck.spawnPiece(ev.object, {
        mass: ev.mass,
        restPos: _sevPos.clone(),
        restQuat: _sevQuat.clone(),
        hinge: ev.hinge,
        bounds: ev.bounds,
        componentId: ev.unit.id,
        buoyancy: buoyancyOf(ev.unit.id),
      });
      // The tear itself is a wound: bare torn metal round the break, and a
      // shower of plate off it.
      field.stamp({
        x: ev.cutPoint.x, y: ev.cutPoint.y, z: ev.cutPoint.z,
        remove: 0.9, scorch: 7, heat: 0.8,
      });
      burst.play('IMPACT', toWorld(ev.cutPoint, new Vector3()), null, 2.4);
      // and a thing that has come off her is a thing that no longer works
      const c = damage.get(ev.unit.id);
      if (c && c.status !== STATUS.DESTROYED) damage.hit(ev.unit.id, { damage: 1e6, pen: 999 });
    },
  });

  // --- the top-hamper: what comes off a tower that does not itself come off ----
  //
  // Registered here rather than in the builders because a fitting only becomes a
  // fitting once there is a wreck integrator for it to fall into. Each builder
  // hands over a list of groups it has already separated out for the purpose.
  const _fitKick = new Vector3();
  const _fitSpin = new Vector3();
  const _fitWorld = new Vector3();

  const fittings = createFittings({
    onDetach: (ev) => {
      root.updateMatrixWorld(true);
      _sevM.copy(root.matrixWorld).invert().multiply(ev.object.matrixWorld);
      _sevM.decompose(_sevPos, _sevQuat, _sevScale);
      // Away from whatever hit it, and upward — a yardarm blown off a foretop
      // does not drop, it is thrown. With no wound to go on (the whole tower has
      // been destroyed and the rig is coming down with it) it simply falls.
      _fitKick.set(0, 0, 0);
      if (ev.from) {
        _fitKick.set(ev.centre.x - ev.from.x, ev.centre.y - ev.from.y, ev.centre.z - ev.from.z);
        if (_fitKick.lengthSq() < 1e-4) _fitKick.set(0, 1, 0);
        _fitKick.normalize();
        _fitKick.y = Math.abs(_fitKick.y) * 0.5 + 0.45;
        _fitKick.normalize().multiplyScalar(3 + Math.random() * 7);
        _fitKick.applyQuaternion(root.quaternion);
      }
      // spawnPiece adds her own way through the water to this; adding it here
      // as well would throw the piece off at twice the speed she is making
      _fitSpin.set(
        (Math.random() - 0.5) * 3.4, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 3.4,
      );
      wreck.spawnPiece(ev.object, {
        mass: ev.mass,
        restPos: _sevPos.clone(),
        restQuat: _sevQuat.clone(),
        kick: _fitKick.clone(),
        spin: _fitSpin.clone(),
        componentId: ev.parent,
        buoyancy: ev.buoyancy,
      });
      // Where it was bolted is now bare torn metal, and a fitting the size of a
      // rangefinder takes some of the tower with it. Scaled by what came off:
      // a bay of guardrail leaves a scar you can barely see, and twenty of them
      // going at once must not add up to a blackened tower.
      field.stamp({
        x: ev.centre.x, y: ev.centre.y, z: ev.centre.z,
        remove: Math.min(1.1, 0.15 + ev.mass / 4000),
        scorch: 1.2 + Math.min(4.0, ev.mass / 1200),
        heat: 0.7,
      });
      toWorld(ev.centre, _fitWorld);
      burst.play('IMPACT', _fitWorld, null, 0.5 + Math.min(1.6, ev.mass / 2500));
      // Losing it costs the thing it was bolted to. Shoot every aerial off the
      // mainmast and the mainmast stops being a mainmast, without any single
      // shell having had to destroy it.
      if (ev.hpCost > 0) {
        const c = damage.get(ev.parent);
        if (c && c.status !== STATUS.DESTROYED) {
          damage.hit(ev.parent, { damage: ev.hpCost, pen: 999 });
        }
      }
    },
  });

  for (const un of superUnits) {
    if (!un.fittings) continue;
    for (const f of un.fittings) {
      // The builder keeps a handle on the record so it can stop ticking a radar
      // that is no longer on the ship.
      f.record = fittings.add({
        id: f.object.name,
        object: f.object,
        parent: un.id,
        mass: f.mass,
        strength: f.strength,
        hpCost: f.hpCost,
        topHamper: f.topHamper ?? true,
        supportedBy: f.supportedBy || null,
      });
    }
  }

  // --- the one door every damaging event comes through -------------------------
  //
  // A shell, a torpedo, a magazine, a funnel landing on an AA tub: all of them
  // are a point, a direction and an energy, and all of them go through here. The
  // four things that happen to a wound — how it looks, what it breaks, what it
  // opens to the sea, and what it throws into the air — are four calls, and none
  // of them knows about the others.
  const _local = new Vector3();
  const _sdir = new Vector3();
  const _hole = new Vector3();
  const _propAt = new Vector3();
  const _cookWorld = new Vector3();

  // A drum going up.
  //
  // `deckProps.blast` has already worked the chain out — a drum that catches
  // reaches for its neighbours, and they reach for theirs — and hands back every
  // place a drum let go, in her frame. What that *is* happens here, because a
  // burst, a scorch and a hit on the plating under it are all the ship's
  // business and deckProps.js does not know about any of them.
  //
  // Deliberately not routed back through `strike`. A shell is one event with one
  // set of consequences and it has already been through that door; a secondary
  // going off in the middle of it would re-enter the whole thing, and the reason
  // to want that — the blast sweeping more props — is exactly the part
  // deckProps.blast has already done for itself.
  function cookOff(places) {
    if (!places || !places.length) return;
    for (const at of places) {
      // Fuel oil, not high explosive: a fireball and a black mark, not a hole.
      // The plating under it takes a little of it, which is what makes leaving
      // drums stacked against the superstructure a decision rather than dressing.
      field.stamp({
        x: at.x, y: at.y, z: at.z, remove: 0.35, scorch: 6.5, heat: 1,
      });
      toWorld(at, _cookWorld);
      burst.play('HE', _cookWorld, null, 1.1);
      const cpt = damage.compartmentAt(at.z / SHIP.length);
      if (cpt) damage.hit(cpt.id, { damage: 22, pen: 999, fire: 0.5 });
    }
  }
  const _rootQi = new Quaternion();

  function strike({
    point, dir = null, kind = 'HE', componentId = null,
    damage: dmgAmount = null, pen = 0, fire = 0, breach = 1, severity: forced = null,
  }) {
    const spec = WOUNDS[kind] || WOUNDS.HE;

    // world -> her own frame, which is the frame the field is written in
    _local.copy(point);
    root.worldToLocal(_local);
    _rootQi.copy(root.quaternion).invert();
    _sdir.copy(dir || DOWN).normalize().applyQuaternion(_rootQi);

    // --- 1. what it did to the component --------------------------------------
    let severity = forced ?? 0.5;
    let result = null;
    if (componentId && dmgAmount !== null) {
      result = damage.hit(componentId, { damage: dmgAmount, pen, fire });
      if (result) {
        severity = Math.min(1.2, (result.effect / Math.max(1, result.component.maxHp)) * 1.2);
      } else {
        severity *= 0.5; // already destroyed; the wreck still takes the metal off
      }
    }

    // --- 2. how it looks -------------------------------------------------------
    //
    // Two radii, and they are not the same thing. `rCrater` is how much of this
    // component the hit ate, and the structure and the wound list are scored on
    // it. `rTear` is how much plating is gone, and only the field sees it.
    //
    // They came apart because a single shell was leaving no hole at all in
    // anything it hit. The tear has to clear the shader's threshold to read as
    // an opening: the field stores a signed distance with 0.5 at the crater
    // wall, and the discard test moves that threshold about with noise over
    // roughly 0.35..0.65 to make the edge ragged. A tear that only just reaches
    // 0.5 at the surface therefore has *no* part of it that is removed for
    // certain — half the fragments in it survive, and what you get is a patch
    // of speckle rather than a hole. Only the deck looked right, and only
    // because it has the liner behind it: the speckle showed dark and read as
    // damage, while the same speckle in a deckhouse side showed sky through it
    // and read as nothing at all.
    //
    // So the tear no longer scales from nothing. A shell that goes off against
    // plating tears a hole of about the size of that shell's burst whatever the
    // plating belonged to — a 15-inch shell does not know that the compartment
    // behind it happened to be rated at 500 points — and severity only says how
    // much *more* than that.
    const rCrater = spec.crater * (0.55 + 0.65 * Math.min(1.2, severity));
    const rTear = spec.crater * (0.85 + 0.45 * Math.min(1.2, severity));

    // The crater centre is pushed *inward* along the shell's path. A burst
    // behind the plating removes a disc of it; a burst on the outside of it only
    // scoops, which is what makes a decal rather than a hole. How far in is
    // measured against the tear, not fixed: pushed in further than its own
    // radius, the sphere never reaches the surface it went through and there is
    // nothing to see. That is exactly what was happening to every AP hit on the
    // ship — a 0.27 m entry hole centred 0.55 m behind the plate.
    //
    // A light push now, because the tear is squashed along the same axis (see
    // TEAR_FLATTEN and `stamp`) and a deep centre would put the whole of it
    // under the surface it went through.
    //
    // Capped against the plating, because the push is measured from the surface
    // and the depth limit below is measured from the *centre*: leave it
    // proportional to the crater and a magazine puts its centre two metres
    // inside her, at which point no limit about the centre can keep the tear out
    // of the backing. A big wound is a wider chip, not a deeper one, so the
    // centre of every one of them sits at about the same place in her plating.
    const depth = spec.punch
      ? rTear * 0.35
      : Math.min(spec.crater * 0.15, PLATING * 0.35);
    const cx = _local.x + _sdir.x * depth;
    const cy = _local.y + _sdir.y * depth;
    const cz = _local.z + _sdir.z * depth;

    if (spec.punch) {
      field.puncture({ x: cx, y: cy, z: cz, radius: rTear });
      // an entry hole still burns the paint round it
      field.stamp({ x: cx, y: cy, z: cz, remove: 0, scorch: spec.scorch * 0.6, heat: 1 });
    } else {
      field.stamp({
        x: cx, y: cy, z: cz, remove: rTear, scorch: spec.scorch, heat: 1,
        axis: _sdir, flatten: TEAR_FLATTEN,
        // Nothing chews further into her than her plating is thick — not a
        // torpedo, not her own magazine. What a bigger wound gets is a *wider*
        // chip, not a way in, which is the whole model: she is a piece of
        // armour, and armour comes off in flakes. Keeping this unconditional
        // also keeps the collision floor and the visible floor at the same
        // depth, so what a man would stand on in there is what he can see.
        //
        // The margin is most of a voxel: the field is sampled trilinearly, so a
        // limit cut exactly at the backing still smears half a cell past it.
        depthLimit: Math.max(0.2, PLATING - depth - VOXEL * 0.7),
      });
    }
    const wound = field.addWound({
      x: cx, y: cy, z: cz, r: Math.max(rCrater, 0.6), t: 0, id: componentId,
    });

    // --- 3. what it broke ------------------------------------------------------
    structure.wound({ x: cx, y: cy, z: cz, r: Math.max(rCrater, 0.5), severity });
    // and what it took off the towers, which is a different question: a burst
    // among a set of aerials takes the aerials, whatever it did to the tower
    fittings.wound({ x: cx, y: cy, z: cz, r: Math.max(rTear, 1.2), severity });
    // and what it swept off her deck. A drum is not a structure and has no
    // strength to run out of: it is either inside the blast or it is not, and
    // the radius is generous because a shell landing amidships ought to scatter
    // cargo the player can see from across the deck rather than only the crate
    // it landed on. deckProps.blast widens it again for the loose ones and
    // narrows it for the lashed, which is what the rope is there to say.
    _propAt.set(cx, cy, cz);
    cookOff(deckProps.blast(_propAt, Math.max(rTear * 2.2, 5), { speed: 6 + 9 * severity }));

    // --- 4. what it opened to the sea ------------------------------------------
    // Only if the crater actually reached her skin. The area is the shell's, not
    // the crater's: a burst tears a wide ragged patch of plating, but what the
    // sea comes through is the hole in the middle of it.
    if (breach > 0 && spec.hole > 0) {
      const st = cz / SHIP.length + 0.5;
      if (st > 0.012 && st < 0.988) {
        const top = deckAt(st);
        if (cy < top) {
          const half = sideAt(st, Math.max(cy, -keelAt(st) + 0.2));
          if (Math.abs(Math.abs(cx) - half) < rCrater + 0.8) {
            const cpt = damage.compartmentAt(cz / SHIP.length);
            if (cpt) {
              _hole.set(Math.sign(cx || 1) * half, cy, cz);
              // The tear's own reach up and down her side: a rent that straddles
              // the waterline takes water through the half of it that is under.
              flooding.addHole(cpt.id, _hole, spec.hole * breach, Math.max(0.35, rTear * 0.8));
            }
          }
        }
      }
    }

    // --- 5. what it threw into the air -----------------------------------------
    burst.play(kind, point, dir, 0.5 + severity);
    throwPlating(point, _sdir, rTear);
    if (kind === 'MAGAZINE' || kind === 'TORP') wreck.disturb(point, 30);

    return { wound, result, severity };
  }

  // The plate that was where the hole is, as bodies rather than as particles.
  //
  // `burst.play` already throws a shower of small stuff through `shards`, which
  // is instanced and has no contacts — right for chips of steel that are gone in
  // three seconds, wrong for the large pieces, which fell through the deck they
  // were blown onto and through the hull under that. The big pieces come off
  // here instead, through the same wreck integrator a funnel uses, so they land
  // on her, slide, lie there, and go over the side when she rolls.
  //
  // Only for a tear big enough to have large pieces in it, and never more than
  // three, because these are chaff and the pool has a funnel to keep room for.
  const _plateAt = new Vector3();
  const _plateV = new Vector3();
  const _plateKick = new Vector3();
  const _plateSpin = new Vector3();
  const _plateQ = new Quaternion();
  const _plateLocal = new Vector3();
  const _plateQi = new Quaternion();
  const _plateHit = { normal: new Vector3(), id: null };

  // A chunk must not be born inside her.
  //
  // The crater centre is pushed *inward* along the shell's path, which is what
  // makes a hole rather than a scoop — and it means that for a hit on the
  // weather deck the burst point is under the deck. A chunk started there is
  // inside solid ship, and the contact solve cannot always get it out again: it
  // wakes up wedged, pushes against two surfaces at once, and goes to sleep
  // still half a metre into the plating. So it is walked out along the surface
  // normal before it exists, and if it cannot be got out in four tries it is
  // not thrown at all — no chunk is better than one buried in the deck.
  function clearOfShip(worldPos) {
    _plateQi.copy(root.quaternion).invert();
    _plateLocal.copy(worldPos).sub(root.position).applyQuaternion(_plateQi);
    for (let k = 0; k < 4; k++) {
      const d = colliders.query(_plateLocal, _plateHit);
      if (d <= 0) {
        worldPos.copy(_plateLocal).applyQuaternion(root.quaternion).add(root.position);
        return true;
      }
      _plateLocal.addScaledVector(_plateHit.normal, d + 0.3);
    }
    return colliders.query(_plateLocal, _plateHit) <= 0;
  }

  function throwPlating(point, dirLocal, rTear) {
    if (rTear < 1.0 || !platePieces.length) return;
    // As many chunks as there was hole. A shell tears a couple out; a torpedo
    // strews the deck with them.
    const n = Math.min(6, 2 + Math.floor(rTear / 1.4));
    // back out of the hole it made, biased upward — the same direction the
    // burst's own debris goes
    _plateV.copy(dirLocal).applyQuaternion(root.quaternion).negate();
    _plateV.y = Math.abs(_plateV.y) * 0.5 + 0.6;
    _plateV.normalize();
    for (let i = 0; i < n; i++) {
      const geo = platePieces[(Math.random() * platePieces.length) | 0];
      // clear of the plating it came out of, so it is not born inside her
      _plateAt.copy(point).addScaledVector(_plateV, 0.8 + Math.random() * rTear * 0.6);
      if (!clearOfShip(_plateAt)) continue;
      _plateSpin.set(
        (Math.random() - 0.5) * 11, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 11,
      );
      _plateQ.set(Math.random(), Math.random(), Math.random(), Math.random()).normalize();
      // along the blast, with enough scatter that three pieces off one hit do
      // not fly in formation
      _plateKick.set(
        _plateV.x + (Math.random() - 0.5) * 0.7,
        _plateV.y + (Math.random() - 0.5) * 0.5,
        _plateV.z + (Math.random() - 0.5) * 0.7,
      ).multiplyScalar(7 + Math.random() * 11).add(shipVelocity);
      const scale = rTear * (0.4 + Math.random() * 0.45);
      wreck.spawn(
        geo, _plateAt, _plateQ, _plateKick, _plateSpin,
        // A square metre of 25 mm plate is about 200 kg, and these are folded
        // double or have a frame in them, so it goes as the area. Light, so it
        // takes the coarse contact set and cannot hurt her — a piece of her own
        // side landing on her deck is not a second hit — and it is steel, so it
        // goes straight down when it reaches the water.
        { scale, mass: 200 * scale * scale, light: true, buoyancy: 0 },
      );
    }
  }

  // A piece of her landing on the rest of her. Same door, and the energy is
  // real: 130 tonnes of funnel arriving at twenty metres a second carries
  // twenty-six megajoules, which is an order of magnitude more than a shell.
  //
  // The colliders name a component for everything they carry except the hull,
  // which is one analytic loft rather than five — so a piece that comes down on
  // bare deck arrives with no id, and the compartment it landed over is looked
  // up from where it landed. Without that, the single most likely thing for a
  // mast to fall on is the one thing it could not hurt.
  const _impact = new Vector3();

  function onWreckImpact({ point, energy, componentId }) {
    const s = Math.min(2.6, Math.sqrt(energy / 1.5e6));
    if (s < 0.28) return; // a bay of guardrail is four orders of magnitude short
    let id = componentId;
    if (!id) {
      _impact.copy(point);
      root.worldToLocal(_impact);
      const cpt = damage.compartmentAt(_impact.z / SHIP.length);
      if (cpt) id = cpt.id;
    }
    strike({
      point,
      dir: DOWN,
      kind: 'IMPACT',
      componentId: id,
      damage: 55 * s * s,
      pen: 9,
      breach: 0.25,
    });
  }

  // Where fire and smoke come out of a given component, in the ship's frame.
  // A fallback only: a burning component with wounds on it burns *at* them.
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
  let floodAccum = 0;
  let heelDeg = 0;
  const _woundOut = new Vector3();

  // Somewhere on this component that has actually been hit, for a fire to come
  // out of. Prefers the freshest wound, so a ship being worked over burns where
  // the last salvo landed.
  function woundOrigin(id) {
    let best = null;
    for (const w of field.wounds) {
      if (w.id !== id) continue;
      if (!best || w.t < best.t) best = w;
    }
    return best ? _woundOut.set(best.x, best.y, best.z) : null;
  }

  let shaftRps = 0;
  const _carry = new Vector3();
  let smokeDebt = 0;
  // She only makes funnel smoke while the boilers are being worked up, so we
  // need her acceleration: last frame's speed, and a smoothed rate of change so
  // the plume doesn't flicker with the sea state jostling her velocity about.
  let lastSpeed = 0;
  let accel = 0;
  const fireDebt = new Map();

  // Ship-local point -> world, using the root's current transform.
  function toWorld(v, out) {
    return out.copy(v).applyQuaternion(root.quaternion).add(root.position);
  }

  // --- the sea coming in -------------------------------------------------------
  //
  // A hole below the waterline is not a mark on her plating, it is a hole with
  // the sea pouring through it, and until now you could only tell she was open
  // by watching the tonnage climb in the readout. Nothing here decides anything:
  // flooding.js has already worked out which holes are under and what head is
  // across each of them this instant — Torricelli through a sharp-edged orifice,
  // both ways round — so `h.wet` and `h.flow` are the answer and this only has
  // to show it. Same droplets as everything else that throws water.
  //
  // It runs inboard and down, because that is where the water is going, and it
  // stops the moment her roll lifts the hole clear.
  const _holeAt = new Vector3();
  const _holeDir = new Vector3();
  const SPILL_BUDGET = 90; // droplets a frame across the whole ship

  function spillIn(dt) {
    if (!splash.mesh.visible) return;
    let budget = SPILL_BUDGET;
    for (const c of flooding.compartments) {
      for (const h of c.holes) {
        if (budget <= 0) return;
        if (!h.wet || !(h.flow > 0.15)) continue;
        // how hard it is running: the head across it, and how big it is
        const rate = Math.min(16, 2 + h.flow * 3.5 + Math.sqrt(h.area) * 1.2);
        h.spill = (h.spill || 0) + rate * dt;
        const n = Math.min(budget, Math.floor(h.spill));
        if (n <= 0) continue;
        h.spill -= n;
        budget -= n;
        toWorld(h.p, _holeAt);
        _holeDir.set(-Math.sign(h.p.x || 1) * 0.75, -0.66, 0).normalize()
          .applyQuaternion(root.quaternion);
        splash.burst(_holeAt, _holeDir, 2.5 + Math.sqrt(h.flow) * 3.0, n, {
          spread: 0.5, size: 0.45, life: 1.2,
        });
      }
    }
  }

  const state = {
    flood: 0,
    floodZ: 0,
    burning: 0,
    sinking: false,
    foundered: false,
    tons: 0,
    holes: 0,
    // The water in her, as loads on the buoyancy solver: a mass at the place
    // that mass actually is. Boat.js applies these directly, which is where
    // trim, list and the free-surface loss of stability all come from.
    loads: flooding.loads,
  };

  // Things the ship is *set* to, as opposed to things that have happened to her.
  const settings = {};

  // `throttle` turns the shafts, `velocity` is differenced for the acceleration
  // that gates funnel smoke, `velocity`/`wind` carry the plumes, and
  // `sea` is the water plane the buoyancy solver fitted this frame — wreckage
  // needs to know where the surface is to land in it.
  function update(dt, {
    throttle = 0, velocity = null, wind = null, dcEffort = 1, sea = FLAT_SEA,
    funnelSmoke: makeSmoke = true, fires: makeFires = true, heel = 0,
  } = {}) {
    heelDeg = heel;
    for (const m of mounts.values()) m.update(dt);
    // anything on the superstructure that moves under its own power — the radar
    // arrays on the masts sweep, and stop when the mast they stand on is killed
    for (const un of superUnits) if (un.tick) un.tick(dt);
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
    state.burning = d.burning;

    // --- water ------------------------------------------------------------
    // Rate-limited: flooding moves on a timescale of minutes and the polygon
    // clipping behind it, while cheap, is the one thing in here that scales
    // with the number of compartments. Twenty times a second is far finer than
    // anything it drives.
    floodAccum += dt;
    if (floodAccum >= 0.05) {
      const f = flooding.update(floodAccum, {
        position: root.position, quaternion: root.quaternion, sea, dcEffort,
      });
      floodAccum = 0;
      state.flood = f.flood;
      state.floodZ = f.floodZ;
      state.tons = f.tons;
      state.holes = f.holes;
      state.foundered = f.foundered;
      state.sinking = f.flood > 0.25;
      // and the surface you can see through the hole
      for (const c of flooding.compartments) {
        const mesh = floodWater.byCompartment.get(c.id);
        if (!mesh) continue;
        const show = c.volume > 40;
        mesh.visible = show;
        if (show) mesh.userData.floodPlane.copy(c.plane);
      }
    }
    spillIn(dt);

    _w.set(0, 0, 0);
    if (wind) _w.copy(wind);
    _carry.set(0, 0, 0);
    if (velocity) _carry.copy(velocity).multiplyScalar(0.5);

    // How hard she is gathering way. Positive only: coming off the power or
    // backing down is not work for the boilers, so it makes no smoke.
    if (velocity) {
      const speed = Math.hypot(velocity.x, velocity.z);
      const raw = dt > 0 ? (speed - lastSpeed) / dt : 0;
      lastSpeed = speed;
      accel += (raw - accel) * Math.min(dt * 4, 1);
    } else {
      accel += (0 - accel) * Math.min(dt * 4, 1);
    }
    // Working up: 0 at a steady speed, 1 by the time she is really pouring it
    // on. m/s^2 — a battleship accelerating hard is still under half of one.
    const workingUp = Math.min(Math.max(accel, 0) / 0.35, 1) * Math.abs(throttle);

    // Funnel smoke, in three parts.
    //
    // There is always some. Her boilers are lit whenever she is a going
    // concern — steam for the turbines, the generators, the auxiliaries — and a
    // capital ship lying stopped with a clean funnel looks switched off. What
    // she makes at rest is thin: a haze standing off the top and leaning away
    // downwind.
    //
    // Steaming adds to it, and *working up* adds a great deal more on top,
    // because that is the one that is really a description of the stokehold:
    // opening her out means more oil into the furnaces than the fires have
    // caught up with, and the surplus goes up the funnel as black smoke.
    //
    // A shot-away funnel belches regardless — that smoke is damage, not effort.
    const steaming = Math.min(Math.abs(throttle), 1);
    smokeDebt += makeSmoke
      ? (5 + steaming * 9 + workingUp * 28 + (damage.alive('funnel') ? 0 : 40)) * dt
      : 0;
    const puffs = Math.floor(smokeDebt);
    if (puffs > 0) {
      smokeDebt -= puffs;
      fx.emit(toWorld(funnelSmoke, new Vector3()), puffs, {
        kind: 0,
        // The idle haze is not just less smoke, it is *different* smoke: it
        // barely rises, it drifts, and it thins out quickly. Effort is what
        // makes a plume that climbs and holds together.
        rise: 1.6 + steaming * 1.2 + workingUp * 2.8,
        spread: SUPER.funnel.rx * 1.4,
        size: 2.4 + workingUp * 1.2,
        life: 4.5 + workingUp * 3.0,
        grow: 2.6,
        carry: _carry,
      });
    }

    // Burning components throw flame and a much larger volume of smoke — out of
    // the holes in them. A component with wounds burns at its wounds, which is
    // the difference between a ship that is on fire and a ship with a fire
    // emitter bolted to the middle of each of its sections.
    for (const c of makeFires ? damage.components.values() : []) {
      if (c.fire <= 0.01) continue;
      const origin = woundOrigin(c.id) || fireOrigins.get(c.id);
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
    // Wreckage needs to know where she is, not just where the sea is: it does
    // its contacts in her frame so that a piece can come to rest on a deck that
    // is itself rolling.
    wreck.update(dt, sea, {
      position: root.position,
      quaternion: root.quaternion,
      velocity: shipVelocity,
      heel: heelDeg,
    });
    shards.update(dt, sea.height);
    field.update(dt);
    splash.update(dt, sea, _w);
  }

  // --- public surface --------------------------------------------------------
  return {
    group: root,
    materials,
    clearances,
    fx,
    railings,
    deckProps,
    // these live in world space; main.js puts them in the scene itself
    debris, // the guardrail's name for `wreck`
    splash,
    hull: hullDescriptor,
    mounts, // id -> mount, all of them
    turrets,
    aaMounts,
    damage,
    // the halves of destruction: the look, the breaking, what comes off the
    // towers, the water, the wreckage
    field,
    structure,
    fittings,
    flooding,
    wreck,
    shards,
    colliders,
    burst,
    interior,
    floodWater,
    // Every damaging event goes through this. See the note where it is defined.
    strike,
    state,
    settings,
    update,
    // Put her back together, including everything the destruction model owns.
    repair() {
      damage.repair();
      structure.repair();
      flooding.repair();
      field.reset();
      wreck.clear();
      // after wreck.clear, which is what takes the detached fittings out of the
      // wreck group before they are bolted back where they came from
      fittings.repair();
      shards.clear();
      colliders.clearStumps();
      for (const mesh of floodWater.byCompartment.values()) mesh.visible = false;
      root.traverse((o) => { if (o.isMesh) delete o.userData.cutPlane; });
      // The readout is driven off these and they are only recomputed on the
      // flooding tick, so without this she reads as still holed for a moment
      // after she has been put right.
      state.flood = 0;
      state.floodZ = 0;
      state.tons = 0;
      state.holes = 0;
      state.burning = 0;
      state.sinking = false;
      state.foundered = false;
    },
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
