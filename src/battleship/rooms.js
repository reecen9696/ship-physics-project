import { Box3, Vector3 } from 'three/webgpu';

// The rooms inside her, and when they are worth drawing.
//
// --- what this is for --------------------------------------------------------
//
// Four turrets have a crew space in them — the gunhouse itself on A and Y, the
// working chamber in the bandstand on B and X — and between them those four
// rooms are about four hundred meshes, which is getting on for half the mesh
// count of the whole ship. They are also, from anywhere except standing in the
// doorway, completely invisible: a room inside a steel box seen through a
// door 1.8 m wide.
//
// Drawing them anyway cost about twelve milliseconds a frame, and it bought
// nothing at all for the ninety-nine per cent of the time the eye is out on the
// sea looking at her from half a mile away. So they are drawn when the eye is
// near enough to see into one, and not otherwise.
//
// --- and out of the shadow maps entirely -------------------------------------
//
// Separately from the visibility, nothing in one of these rooms ever casts a
// shadow. The rule in Battleship.js is deliberately blunt — everything that is
// not the deck casts — and that is right for everything standing out in the
// weather, but a ready rack bolted to the inside of a gunhouse is inside a
// sealed steel box with the sun on the outside of it. Its shadow falls on
// nothing. It was being drawn into both maps regardless, which is two more
// passes over four hundred meshes for a result that cannot be seen.

// How near the eye has to be before a room is drawn.
//
// Generous on purpose. The distance is measured to the centre of the room and
// the rooms are several metres across, so this is really about fifteen metres
// from the door — far enough that the room is already there by the time you are
// close enough to look through the doorway, and near enough that it is off
// whenever the ship is being watched from the sea. There is no fade and none is
// needed: at this range the room is behind plating from every angle but one.
const NEAR = 22;

// Which groups count. Named by the builders that raise them: `turret.A.interior`
// is the gunhouse room, `turret.B.chamber` the working chamber under a
// bandstand. Matching on the name rather than taking a list from the callers
// keeps this true when a fifth turret room is added.
//
// Anchored on `turret.` on purpose, and this is not fussiness. `ship.interior`
// is the hull's liner — the framed steel you see through a shell hole — and it
// is the one interior that has to be drawn from a mile away, because the holes
// it shows through are punched in her side and visible from anywhere. Sweeping
// it up with the turret rooms would make every wound in her plating a window
// onto nothing.
const ROOM = /^turret\.[^.]+\.(interior|chamber)$/;

export function createRooms(root) {
  const rooms = [];
  const _box = new Box3();
  root.traverse((o) => {
    if (!ROOM.test(o.name || '')) return;
    _box.setFromObject(o, true);
    rooms.push({
      group: o,
      // In the ship's frame, and it stays there: a turret's room turns with the
      // guns, but it turns about an axis a couple of metres from its own centre,
      // which is nothing against a twenty-two metre threshold.
      centre: _box.getCenter(new Vector3()),
    });
    o.traverse((m) => {
      if (!m.isMesh) return;
      m.castShadow = false;
      m.userData.noShadow = true; // and it stays off when the wreck re-applies the rule
    });
  });

  const _eye = new Vector3();
  // `viewer` is a world position — the camera's. Null leaves every room drawn,
  // which is what a caller that has not been taught about this should get.
  function update(viewer) {
    if (!viewer) return;
    for (const r of rooms) {
      _eye.copy(r.centre).applyMatrix4(root.matrixWorld);
      r.group.visible = _eye.distanceToSquared(viewer) < NEAR * NEAR;
    }
  }

  // The layer half of the shadow rule is applied after this module has run — see
  // Battleship.js — so it asks whether a mesh is in a room rather than being
  // told twice.
  const inRoom = (o) => o.userData.noShadow === true;

  return { rooms, update, inRoom, count: rooms.length };
}
