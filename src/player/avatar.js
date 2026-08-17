import { CapsuleGeometry, Group, Mesh, SphereGeometry } from 'three/webgpu';
import { paint } from '../battleship/shipMaterial.js';
import { PLAYER } from './spec.js';

// A placeholder for a person.
//
// A capsule and a ball for a head, parented to the ship's own group — which is
// to say, standing in ship-local space, exactly where the character controller
// puts it. Swapping this for a rigged model changes nothing anywhere else: the
// simulation deals in a feet position and a heading, and this is the only thing
// that turns those into something you can see.
//
// It shares the ship's material rather than bringing its own, because nothing in
// this scene uses three's lighting model — there is no light to shade a standard
// material with. `slotOf('crew')` takes a damage slot no damage model ever
// writes to, so it stays undamaged while the ship around it does not.

const KHAKI = [0.36, 0.33, 0.25];
const SKIN = [0.52, 0.40, 0.31];

export function createAvatar({ materials }) {
  const group = new Group();
  const slot = materials.slotOf('crew');

  const bodyH = PLAYER.height - 0.22 - PLAYER.radius; // leaves room for the head
  const body = new Mesh(
    paint(new CapsuleGeometry(PLAYER.radius * 0.82, bodyH - PLAYER.radius * 1.64, 4, 12), {
      color: KHAKI, roughness: 0.85, metal: 0.0, slot,
    }),
    materials.body,
  );
  body.position.y = bodyH / 2;

  const head = new Mesh(
    paint(new SphereGeometry(0.115, 12, 10), {
      color: SKIN, roughness: 0.7, metal: 0.0, slot,
    }),
    materials.body,
  );
  head.position.y = bodyH + 0.11;
  // Off the centreline so which way she is facing is readable from the bridge
  // wing without a face on her: the head leads the body.
  head.position.z = 0.02;

  group.add(body, head);

  // `pos` is the feet in ship-local space, `heading` radians about local up —
  // 0 faces the bow, which is the way the head is offset.
  function place(pos, heading) {
    group.position.copy(pos);
    group.rotation.y = heading;
  }

  return { group, place };
}
