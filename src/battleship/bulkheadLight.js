import {
  BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry,
} from 'three/webgpu';
import { paint } from './shipMaterial.js';
import { STEEL_DARK } from './hull.js';

// The battle light.
//
// One fitting, used in one place: inside a gunhouse. A turret at action stations
// is a closed steel room with a dozen men in it who have to be able to see their
// gear and must not lose their night vision doing it, so what is burning in
// there is red — every navy of the period did the same thing, and it is the
// single most recognisable thing about the inside of a warship at night.
//
// `RED` is that light. Deliberately dim: the point of red lighting is that it is
// only just enough.
export const BATTLE_LAMP = {
  color: [0.62, 0.10, 0.07],
  // Sized to the room rather than to the ship: five metres reaches the far wall
  // of a gunhouse and stops, and the short softening radius is what puts the
  // brightness *at the fitting* — a long one spreads the same light evenly over
  // the whole compartment, which is a room with red paint in it rather than a
  // room with two red lamps in it.
  reach: 5.5,
  level: 0.85,
  soft: 0.9,
};

// The holder itself: an old cast bulkhead light.
//
// Not a lamp with a shade on it — the thing a warship of this date actually
// carried, which is a heavy fitting designed to survive being walked into and
// fired over. A cast backplate bolted to the wall, a short neck standing the
// glass off it, a cylindrical glass with a domed end, and a cage of six ribs
// between two rings round the whole of it with a cap on the outer end. The cage
// is what makes it read as period at a glance: a bare glass on a bracket is a
// garden light, and a glass inside a wire basket is a ship.
//
// Built projecting along +x and mirrored, because the only place it ever goes is
// flat against a wall. The glass carries `lamp` in its paintMask, which is the
// field the deckhouse scuttles use, so it burns at night off machinery that
// already exists rather than a second path for making glass glow.
export function bulkheadLight(slot, side) {
  const parts = [];
  const push = (g, color, o = {}) => parts.push(paint(g, {
    color, roughness: 0.42, slot, ...o,
  }));
  const x = (d) => side * d;

  // the backplate, and the four bolts holding it on
  const back = new BoxGeometry(0.05, 0.30, 0.30);
  back.translate(x(0.025), 0, 0);
  push(back, STEEL_DARK, { roughness: 0.5 });
  for (const dy of [-0.11, 0.11]) {
    for (const dz of [-0.11, 0.11]) {
      const bolt = new CylinderGeometry(0.018, 0.018, 0.05, 6);
      bolt.rotateZ(Math.PI / 2);
      bolt.translate(x(0.055), dy, dz);
      push(bolt, STEEL_DARK, { roughness: 0.35, metal: 0.8 });
    }
  }
  // the neck it stands off the wall on
  const neck = new CylinderGeometry(0.055, 0.075, 0.09, 10);
  neck.rotateZ(Math.PI / 2);
  neck.translate(x(0.095), 0, 0);
  push(neck, STEEL_DARK, { roughness: 0.38 });

  // the glass: a cylinder with a domed end, which is the shape these are
  const glassOpts = {
    color: [0.42, 0.10, 0.08], roughness: 0.14, metal: 0.08, lamp: 1, lampRed: true, plate: 0,
  };
  const globe = new CylinderGeometry(0.095, 0.095, 0.20, 14, 1, true);
  globe.rotateZ(Math.PI / 2);
  globe.translate(x(0.24), 0, 0);
  push(globe, glassOpts.color, glassOpts);
  const dome = new SphereGeometry(0.095, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateZ(x(Math.PI / 2));
  dome.translate(x(0.34), 0, 0);
  push(dome, glassOpts.color, glassOpts);

  // the cage: two rings, six ribs between them, and a cap over the end
  for (const d of [0.15, 0.345]) {
    const ring = new TorusGeometry(0.112, 0.016, 5, 14);
    ring.rotateY(Math.PI / 2);
    ring.translate(x(d), 0, 0);
    push(ring, STEEL_DARK, { roughness: 0.4, metal: 0.75 });
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 12;
    const rib = new BoxGeometry(0.21, 0.022, 0.022);
    rib.translate(x(0.25), Math.cos(a) * 0.112, Math.sin(a) * 0.112);
    push(rib, STEEL_DARK, { roughness: 0.4, metal: 0.75 });
  }
  const cap = new CylinderGeometry(0.05, 0.09, 0.05, 10);
  cap.rotateZ(x(Math.PI / 2));
  cap.translate(x(0.40), 0, 0);
  push(cap, STEEL_DARK, { roughness: 0.38 });
  return parts;
}

// The light over a door.
//
// Not a battle light and not trying to be: a small hooded fitting on the outside
// of the turret with a tungsten bulb in it, dull enough that it lights the
// doorway and about a metre of plating round it and nothing else. That is the
// whole job — a door in a grey wall at night is invisible, and one lamp over it
// is the difference between a turret you can get into and a turret you have to
// know the way into.
// Reach is the knob here, not level, and it is worth saying why: the falloff is
// a cubed linear ramp, so brightness collapses long before the stated range —
// at half of it you have an eighth of the light. This fitting is three to four
// metres above the deck it is meant to be lighting, so at a reach of five and a
// half the deck was sitting at nine per cent and level could not buy its way
// out of that. Twelve puts the deck at four tenths, which is a pool you can see
// from across the ship, and it is still a modest lamp.
export const DOOR_LAMP = {
  // Tungsten, which is what is actually in it. A filament lamp behind clear
  // glass is a warm yellow — nearer 2700 K than anything you would call white —
  // and the white it was reading as is the one colour a bulb of this date cannot
  // produce. It is still the cool one of the three by comparison: warmer than a
  // scuttle would be wrong, because a scuttle is this same bulb seen through a
  // curtained cabin, and the curtain is what makes that one orange.
  color: [0.60, 0.50, 0.24],
  reach: 12,
  level: 0.65,
  soft: 1.25,
};

// Built projecting along +x and mirrored, like the bulkhead light, because it
// hangs on the outside of a wall.
export function doorLight(slot, side) {
  const parts = [];
  const push = (g, color, o = {}) => parts.push(paint(g, {
    color, roughness: 0.42, slot, ...o,
  }));
  const x = (d) => side * d;
  // a plate on the wall and a short arm out of it
  const back = new BoxGeometry(0.05, 0.18, 0.22);
  back.translate(x(0.025), 0.02, 0);
  push(back, STEEL_DARK, { roughness: 0.5 });
  const arm = new CylinderGeometry(0.035, 0.045, 0.13, 8);
  arm.rotateZ(Math.PI / 2);
  arm.translate(x(0.10), 0.02, 0);
  push(arm, STEEL_DARK, { roughness: 0.4 });
  // the hood, which is what stops it being a lamp on a stick: a light over a
  // door on a warship is shaded downward so it shows the step and not the sea
  const hood = new CylinderGeometry(0.13, 0.16, 0.09, 12, 1, true);
  hood.rotateX(Math.PI);
  hood.translate(x(0.19), 0.05, 0);
  push(hood, STEEL_DARK, { roughness: 0.44 });
  const lens = new CylinderGeometry(0.10, 0.115, 0.06, 12);
  lens.translate(x(0.19), -0.01, 0);
  push(lens, [0.62, 0.55, 0.33], {
    roughness: 0.15, metal: 0.05, lamp: 1, lampWhite: true, plate: 0,
  });
  return parts;
}
