import { Vector3 } from 'three/webgpu';
import { helmStationPoint } from '../battleship/wheelhouse.js';

// The helm, as a set of controls you put your hands on.
//
// It is the same shape as a turret station — a place to stand, a reach, and a
// thing that happens while you are holding it — and deliberately so: from the
// player's side, taking the wheel and taking a gun are the same gesture at
// different gear. See turretStation.js, which is the other one.
//
// What is *not* here is the steering. The ship already has a helm — the telegraph
// and the wheel in boat/Boat.js, driven by the handling model in shipHandling.js —
// and the whole point of standing in the wheelhouse is that you are working that
// helm rather than a second copy of it. So the keys go where they always went, and
// all this does is decide whether they are being listened to (main.js asks
// `conning`), turn the gear so the room shows what she has been told, and know
// where a man has to stand to be doing it.
//
// The consequence worth having: the ship keeps steaming and steering exactly as she
// did when you were watching from outside, because it is the same helm. Nothing is
// handed over and nothing is reset.
export const CONN = {
  // How close you have to be to put a hand on the wheel. Measured to the wheel
  // itself, which you cannot stand in, so the reach has to cover walking up to it
  // from either side.
  reach: 1.9,
};

export function createHelmStation({ body, damage = null, wheelhouse = null }) {
  const place = helmStationPoint();
  const held = { on: false };

  // A wrecked bridge is a wrecked wheelhouse: the ship is conned from aft by hand
  // signals at that point, which is not a thing this game models, so the wheel
  // simply stops being a thing you can take.
  const alive = () => (damage ? damage.alive('bridge') : true);

  // What the gear shows. Read off the ship rather than off the keys, so the wheel
  // is where the rudder is — trailing the order by the several seconds the steering
  // engine takes — and the telegraph lever stands at what was last rung down
  // whoever rang it.
  function step() {
    if (!wheelhouse) return;
    const h = body.handling;
    if (h) {
      wheelhouse.setHelm(h.state.rudder, h.config.maxRudder);
    } else {
      wheelhouse.setHelm(body.state.helm ?? 0, 32);
    }
    wheelhouse.setTelegraph(body.telegraph ? body.telegraph.value : (body.input.throttle ?? 0));
  }

  return {
    id: 'helm',
    kind: 'helm',
    alive,
    step,
    get held() { return held.on; },
    hold() { held.on = true; },
    release() { held.on = false; },
    // where the wheel is, where you stand to work it, and which way you look
    station: place.station,
    approach: place.approach,
    approachHeading: place.approachHeading,
    reach: CONN.reach,
    // What the corner of the screen says while you have hold of it: the same three
    // numbers a helmsman actually watches.
    readout() {
      const h = body.handling;
      const rudder = h ? h.state.rudder : (body.state.helm ?? 0);
      return {
        telegraph: body.telegraph ? body.telegraph.label : `throttle ${(body.input.throttle * 100).toFixed(0)}%`,
        ordered: h ? h.state.throttle : body.input.throttle,
        rudder,
        heading: (body.heading + 360) % 360,
        knots: body.knots,
      };
    },
    // for anything that wants the wheel in world space
    world: (out = new Vector3()) => out.copy(place.station),
  };
}
