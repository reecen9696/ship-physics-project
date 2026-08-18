import { CapsuleGeometry, Group, Mesh, SphereGeometry } from 'three/webgpu';
import { paint } from '../battleship/shipMaterial.js';
import { syncFieldXform } from './figureMaterial.js';
import { createSoldier } from './soldier.js';
import { PLAYER } from './spec.js';

// The man on the deck.
//
// This is the only thing that turns a feet position and a heading into something
// you can see. The simulation deals in those two numbers and nothing else — see
// character.js — so whatever is here can be swapped for anything without a line
// changing anywhere upstream, which is the whole reason it was a capsule and a
// ball for as long as it was.
//
// It is now a rigged figure with a rifle in his hands, and the capsule is still
// here underneath. Not as a nicety: the model is an FBX fetched over the network
// and everything about it can fail — the file can be missing, the loader can
// throw, the rig can come back under different bone names — and none of those is
// a reason to have nobody standing on the deck. `figure` arriving as null is a
// perfectly ordinary outcome and this file treats it as one.
//
// --- why the pose is not this file's problem ----------------------------------
//
// Everything below the neck is soldier.js, which turns the controller's state
// into 64 bone rotations. What is here is the join: where he stands, which way he
// faces, what he is holding, and keeping his ship-frame matrix current so the
// lamps and the torch land on him. Four things, and all four are about the world
// he is in rather than about him.

const KHAKI = [0.36, 0.33, 0.25];
const SKIN = [0.52, 0.40, 0.31];

// Where the rifle sits, stated in the armature's own frame for the pose he is
// standing in when it is handed to him — see `attach` in soldier.js for why that
// is the workable way round.
//
// `at` is the sight datum over the receiver: out on his right, at the bottom of
// the ribs, a hand's breadth in front of him. `rotation` is which way the weapon
// points, and the 180 about Y is the whole of it — the model's muzzle is down
// its own -Z, so turning it about-face is what makes the muzzle lead. The other
// two are the muzzle-down of a weapon being carried rather than pointed, and the
// cant that comes of holding one in the right hand.
const HOLD = {
  at: [-0.17, 1.05, 0.16], // metres, armature frame: -x is his right
  rotation: [-14, 180, -8], // degrees
};

// And the pose he is holding it in when that measurement is taken. One frame of
// the carry stance, settled — every smoothed value in soldier.js is a lag, so a
// long step lands on the resting value exactly.
const SETTLE = {
  speed: 0, grounded: true, crouch: 0, pitch: 0, aiming: false, recoil: 0,
};

export function createAvatar({
  materials, castLayer = 1,
  // What came back from player/models.js, or null. Both are optional and
  // independently so: a figure with no rifle is a man standing on a deck, which
  // is what this was before.
  figure = null, rifle = null,
  // Her hull group. The figure's program reads three rigs that are all stated in
  // the ship's frame — her lamps, her guns' flashes, and the torch — and unlike
  // the ship's own plating a man moves through that frame, so the matrix has to
  // be rebuilt every frame he is drawn. See `syncFieldXform`.
  shipGroup = null,
}) {
  const group = new Group();
  const slot = materials.slotOf('crew');
  const soldier = figure ? createSoldier(figure) : null;

  if (soldier) {
    group.add(soldier.group);
    soldier.group.traverse((o) => {
      if (!o.isMesh) return;
      // He throws a shadow on the deck he is standing on, which is the cheapest
      // thing there is for grounding a figure — without it a person in first or
      // third person reads as hovering a few centimetres above the teak.
      // `castLayer` is the disjoint-caster layer the deck's shadow map is culled
      // against; see the note beside `deckShadow` in main.js.
      o.castShadow = true;
      o.layers.enable(castLayer);
      // A skinned figure's bounding sphere is computed from the bind pose and is
      // wrong the moment he moves. He is one draw call and he is always near the
      // camera that can see him, so there is nothing to cull.
      o.frustumCulled = false;
    });
    if (rifle) {
      // Into the carry stance first, then hand him the rifle: see `HOLD`.
      soldier.update(1, { ...SETTLE, height: PLAYER.height });
      soldier.attach('handR', rifle, HOLD);
    }
  } else {
    // The fallback, and it is the original: a capsule and a ball for a head.
    //
    // It shares the ship's material rather than bringing its own, because there
    // is no light in this scene for a standard material to answer to.
    // `slotOf('crew')` takes a damage slot no damage model ever writes to, so it
    // stays undamaged while the ship around it does not.
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
    for (const m of [body, head]) {
      m.castShadow = true;
      m.layers.enable(castLayer);
    }
  }

  // `pos` is the feet in ship-local space, `heading` radians about local up —
  // 0 faces the bow, which is the way the head is offset.
  function place(pos, heading) {
    group.position.copy(pos);
    group.rotation.y = heading;
  }

  // Everything that is not where he is standing: the legs, the trunk, the head,
  // the arms, and the rifle riding on one of them. Split from `place` because the
  // two are called from different places and at different times — he is placed
  // whether or not first person is active, and he is only posed when he is going
  // to be drawn.
  //
  // `s` is the controller's state, passed straight through. See soldier.js.
  function pose(dt, s) {
    if (soldier) soldier.update(dt, s);
  }

  // Called after the pose and after the group has been placed, and only when he
  // is actually being drawn: this walks every mesh under him and it is pure cost
  // on a frame where nobody can see him.
  function sync() {
    if (!soldier || !shipGroup) return;
    group.updateWorldMatrix(true, true);
    syncFieldXform(group, shipGroup);
  }

  return {
    group,
    place,
    pose,
    sync,
    soldier,
    // Whether there is a real figure here or the capsule that stands in for one.
    // The read-out says so, because "the man looks like a pill" and "the model
    // did not load" are the same picture and only one of them is a bug.
    get modelled() { return !!soldier; },
  };
}
