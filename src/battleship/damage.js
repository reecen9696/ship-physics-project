import { COMPARTMENTS, COMPONENT_STATS } from './spec.js';

// The damage model.
//
// A battleship is not a health bar. What makes losing one interesting is that
// the ship stops being able to do specific things, in an order the enemy gets
// to choose: her forward turrets are wrecked but she still shoots astern; the
// bridge is gone so she is conned from aft and steers badly; two compartments
// forward are flooded so she is down by the head, slower, and her A turret is
// dipping into the sea. So the model here is a graph of components, each with
// its own hit points and its own consequences, plus a flooding model that feeds
// straight into the buoyancy solver.
//
// Nothing in here reaches into the renderer. Components own a `damage` uniform
// (which the shared hull material reads) and optional `onKill`/`onDamage`
// callbacks; the ship wires those up when it builds the meshes. That keeps this
// file a pure state machine, which is the part that has to be right.

export const STATUS = { OK: 'ok', DAMAGED: 'damaged', DESTROYED: 'destroyed' };

// Flooding used to live here, as one number per compartment filling at a fixed
// rate while a `breach` flag was set. It is in flooding.js now, because water
// getting into a ship is a question about where the holes are, how deep each of
// them is at this instant of her roll, and where inside her the water then
// sits — and none of that is expressible as a fraction per compartment. What is
// left here is what this file was always good at: components, hit points,
// armour, fire, and what she can no longer do.

export function createDamageModel({ onFlood = null } = {}) {
  const components = new Map();

  function add({
    id, hp, armor = 0, group = null, damage = null,
    z = 0, critical = [], onKill = null, onDamage = null, onRepair = null,
  }) {
    const c = {
      id,
      maxHp: hp,
      hp,
      armor,
      group, // e.g. 'turret', 'aa', 'hull' — for querying "are any turrets left"
      damage, // uniform 0..1 the materials read, or null
      z, // fore-and-aft position, fraction of L; where its effects act
      fire: 0, // 0..1 how hard it is burning
      status: STATUS.OK,
      critical,
      onKill,
      onDamage,
      onRepair,
    };
    components.set(id, c);
    return c;
  }

  // Apply a hit. `pen` is the shell's penetration; armour subtracts from it, so
  // a light gun can chew up AA mounts and superstructure all day without ever
  // hurting a turret face. Returns what actually happened, so the caller can
  // decide whether to spawn a splash or an explosion.
  function hit(id, { damage = 0, pen = 0, fire = 0 } = {}) {
    const c = components.get(id);
    if (!c || c.status === STATUS.DESTROYED) return null;
    // armour scales the damage down rather than blocking outright: a bounce
    // still shakes the crew, and an over-match still gets through
    const effect = damage * Math.min(1, Math.max(0.05, (pen + 1) / (c.armor + 1)));
    c.hp = Math.max(0, c.hp - effect);
    c.fire = Math.min(1, c.fire + fire);
    const frac = 1 - c.hp / c.maxHp;
    if (c.damage) c.damage.value = Math.min(1, frac);
    if (c.hp <= 0) {
      c.status = STATUS.DESTROYED;
      if (c.damage) c.damage.value = 1;
      if (c.onKill) c.onKill(c);
    } else {
      c.status = frac > 0.35 ? STATUS.DAMAGED : STATUS.OK;
      if (c.onDamage) c.onDamage(c, frac);
    }
    return { component: c, effect, destroyed: c.status === STATUS.DESTROYED };
  }

  // Damage control: pumps fight flooding, hoses fight fire, neither repairs
  // structure. `effort` 0..1 scales both (a ship whose crew is dead pumps
  // nothing).
  function update(dt, effort = 1) {
    let burning = 0;
    for (const c of components.values()) {
      if (c.fire > 0) {
        // fire spreads a little on its own, and eats hit points while it burns
        const spread = c.status === STATUS.DESTROYED ? 0.02 : 0.008;
        c.fire = Math.min(1, Math.max(0, c.fire + (spread - 0.045 * effort) * dt));
        if (c.fire > 0) {
          c.hp = Math.max(0, c.hp - c.fire * 3 * dt);
          if (c.damage) c.damage.value = Math.min(1, Math.max(c.damage.value, 1 - c.hp / c.maxHp));
          if (c.hp <= 0 && c.status !== STATUS.DESTROYED) {
            c.status = STATUS.DESTROYED;
            if (c.onKill) c.onKill(c);
          }
          burning += c.fire;
        }
      }
    }
    const state = { burning };
    if (onFlood) onFlood(state);
    return state;
  }

  const get = (id) => components.get(id);
  const alive = (id) => {
    const c = components.get(id);
    return !!c && c.status !== STATUS.DESTROYED;
  };
  const byGroup = (group) => [...components.values()].filter((c) => c.group === group);

  // Capability queries — what the ship can still do. This is the interface the
  // mechanics should ask, rather than reading hit points directly.
  const capability = {
    // helm: the bridge cons the ship, the steering gear turns her. Losing the
    // bridge is recoverable (aft conning position, slower); losing the steering
    // gear is not.
    get helm() {
      if (!alive('steering')) return 0;
      return alive('bridge') ? 1 : 0.55;
    },
    get propulsion() {
      let p = 1;
      if (!alive('screws')) return 0;
      if (!alive('hull.mid')) p *= 0.35; // machinery spaces gone
      if (!alive('funnel')) p *= 0.7; // no draught to the boilers
      return p;
    },
    // fire control: the bridge director, then the mainmast spotting top
    get fireControl() {
      if (alive('bridge')) return 1;
      if (alive('mainmast')) return 0.6;
      return 0.3; // local control at the turrets
    },
    get mainBattery() { return byGroup('turret').filter((c) => c.status !== STATUS.DESTROYED).length; },
    get aa() { return byGroup('aa').filter((c) => c.status !== STATUS.DESTROYED).length; },
  };

  // Put her back together. Useful for testing, and the obvious thing for a
  // between-battles repair.
  function repair() {
    for (const c of components.values()) {
      c.hp = c.maxHp;
      c.fire = 0;
      c.status = STATUS.OK;
      if (c.damage) c.damage.value = 0;
      if (c.onRepair) c.onRepair(c);
    }
  }

  return {
    add, hit, update, get, alive, byGroup, capability, components, repair,
    // convenience for the mechanics: the compartment covering a station
    compartmentAt(zFrac) {
      const s = zFrac + 0.5;
      const cpt = COMPARTMENTS.find((k) => s >= k.s[0] && s < k.s[1]) || COMPARTMENTS[COMPARTMENTS.length - 1];
      return components.get(cpt.id);
    },
    stats: COMPONENT_STATS,
  };
}
