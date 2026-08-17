// What can happen to a hull that is not the battleship.
//
// The battleship has a graph of named components with their own hit points and
// their own consequences, and she deserves one: what makes losing her
// interesting is the order in which she stops being able to do things. A 16 m
// launch has no such graph. There is the hull, and there is whether it still
// keeps the sea out — so this is one number and the two consequences that number
// has: she loses way and steerage as she is stove in, and she takes water
// through the hole.
//
// The flooding is deliberately shaped to what the buoyancy solver in Boat.js
// already consumes (`flood` and `floodZ`), so a holed launch settles, trims by
// whichever end was stove in, and eventually goes under on the same solver that
// floats her — there is no separate sinking animation here any more than there
// is on the battleship.

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

export function createHullDamage({
  hp = 100,
  floodRate = 0.10, // fraction of her volume per second at a full breach
  pumpRate = 0.004, // what a bilge pump and a bucket are worth
} = {}) {
  const state = {
    hp,
    maxHp: hp,
    breach: 0, // 0..1, how open to the sea she is
    flood: 0, // 0..1 of her volume; read by the buoyancy solver
    floodZ: 0, // where that water is, as a fraction of L: this is the trim
    wrecked: false,
  };

  // `z` is the fraction of her length the blow landed at, -0.5 aft .. 0.5
  // forward, matching the convention everywhere else in this directory.
  function hit({ damage = 0, breach = 0, z = 0 }) {
    if (damage <= 0 && breach <= 0) return state;
    state.hp = Math.max(0, state.hp - damage);
    if (breach > 0) {
      // where the water is going is the running mean of where the holes are,
      // weighted by how big each one was
      state.floodZ += (z - state.floodZ) * (breach / (state.breach + breach));
      state.breach = Math.min(1, state.breach + breach);
    }
    state.wrecked = state.hp <= 0;
    return state;
  }

  function update(dt, effort = 1) {
    const inflow = state.breach * floodRate;
    const pumped = state.flood > 0 ? pumpRate * effort : 0;
    state.flood = clamp01(state.flood + (inflow - pumped) * dt);
  }

  function repair() {
    state.hp = state.maxHp;
    state.breach = 0;
    state.flood = 0;
    state.floodZ = 0;
    state.wrecked = false;
  }

  const integrity = () => state.hp / state.maxHp;

  // The same shape Boat.js expects from the battleship's damage model: what she
  // can still do, not what has happened to her.
  const capability = {
    // She still steers with her bow stove in; she steers badly. She stops
    // steering altogether once there is more water in her than boat.
    get helm() { return clamp01(0.45 + 0.55 * integrity()) * clamp01(1 - state.flood * 1.5); },
    // Half a hull makes half a knot: the engine is the last thing to give up,
    // and it gives up when the water reaches it.
    get propulsion() { return clamp01(0.25 + 0.75 * integrity()) * clamp01(1 - state.flood * 1.7); },
  };

  return {
    state,
    hit,
    update,
    repair,
    capability,
    get integrity() { return integrity(); },
  };
}
