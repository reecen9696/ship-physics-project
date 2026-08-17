import { Vector3 } from 'three/webgpu';
import { SHIP } from '../battleship/spec.js';

// Which component did that mesh belong to?
//
// The ship is built as a tree of named groups — hull sections, turrets, mounts,
// superstructure units — and the damage model keys off those same names, but a
// raycast comes back with a leaf `Mesh` (one plate of a gunhouse, one leg of the
// mainmast). So the map is object -> component id for every object that *owns* a
// component, and resolving a hit means walking up from the leaf until one of
// them turns up.
//
// Order matters and falls out of the walk for free: the AA mount on B turret's
// roof is a child of B turret, so a hit on the mount finds `aa.6` before it ever
// reaches `turret.B`. Hitting the turret itself walks past the mount.
//
// Anything with no component of its own — deckhouses, fittings, guardrail —
// charges the hit to the hull compartment underneath it, which is what actually
// takes the structural damage when a shell goes through a deckhouse.

export function createHitMap(battleship) {
  const byObject = new Map();
  for (const [id, part] of battleship.parts) byObject.set(part.object, id);
  for (const [id, m] of battleship.mounts) byObject.set(m.root, id);

  const _local = new Vector3();

  function resolve(object, worldPoint) {
    for (let o = object; o && o !== battleship.group.parent; o = o.parent) {
      const id = byObject.get(o);
      const component = id && battleship.damage.get(id);
      if (component) return { id, component, direct: true, part: id };
    }
    // no component of its own: charge it to the compartment under the hit
    _local.copy(worldPoint);
    battleship.group.worldToLocal(_local);
    const component = battleship.damage.compartmentAt(_local.z / SHIP.length);
    return {
      id: component ? component.id : null,
      component: component || null,
      direct: false,
      part: nameOf(object, byObject, battleship),
    };
  }

  return { resolve, byObject };
}

// A readable name for what was actually struck, for the hit log — the component
// that takes the damage is often not the thing you were looking at.
function nameOf(object, byObject, battleship) {
  for (let o = object; o && o !== battleship.group.parent; o = o.parent) {
    const id = byObject.get(o);
    if (id) return id;
    if (o.name) return o.name;
  }
  return 'structure';
}
