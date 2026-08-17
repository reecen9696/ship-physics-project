import { Matrix4, Vector3 } from 'three/webgpu';

const _one = new Vector3(1, 1, 1);

// Keep the camera out of the ships.
//
// The usual third-person answer — cast a ray from the orbit target out to the
// camera and stop at the first thing it hits — has nowhere to cast from here.
// The target sits at the middle of a 180 m hull, which is several decks inside
// her, so every cast starts in solid steel.
//
// De-penetration works instead. Let the controls put the camera wherever the
// user asked for, then ask each hull whether it ended up inside, and push it
// back out along the surface it went in through. The push is instantaneous on
// purpose: easing it would mean a frame or two of seeing the sea through the
// plating, which is the thing being fixed.
//
// The camera is a ball, not a point. A point can sit a millimetre off the deck
// with the near plane already through it, and the fix would be invisible. Seven
// samples — the centre and the six poles — are enough for surfaces the size of a
// hull section, and the whole thing is analytic: a few dozen box and cylinder
// tests a frame, no triangles and no acceleration structure. See
// battleship/colliders.js and boat/hullShape.js for the queries themselves.
export function createCameraCollision(camera, { pad = 1.4, iterations = 4 } = {}) {
  const solids = [];
  const _inv = new Matrix4();
  const _p = new Vector3();
  const _push = new Vector3();
  const _hit = { normal: new Vector3(), id: null };

  const SAMPLES = [
    [0, 0, 0],
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  // `object` supplies the frame (position and quaternion; no scale, which
  // nothing in this scene has); `query(localPoint, out)` returns the
  // penetration depth and writes the outward normal into `out.normal`.
  // `radius` is a bound on the solid, so a hull on the far side of the sea
  // costs one distance test rather than a hundred shape tests.
  function add(object, query, { radius = Infinity } = {}) {
    const solid = {
      object, query, radius, enabled: true,
    };
    solids.push(solid);
    return solid;
  }

  // Call after controls.update() and before rendering. Returns true if the
  // camera had to be moved.
  function resolve() {
    let moved = false;
    for (let it = 0; it < iterations; it++) {
      let depth = 0;
      for (const s of solids) {
        if (!s.enabled) continue;
        const reach = s.radius + pad;
        if (Number.isFinite(reach)
          && s.object.position.distanceToSquared(camera.position) > reach * reach) continue;
        _inv.compose(s.object.position, s.object.quaternion, _one).invert();
        for (const o of SAMPLES) {
          _p.set(
            camera.position.x + o[0] * pad,
            camera.position.y + o[1] * pad,
            camera.position.z + o[2] * pad,
          ).applyMatrix4(_inv);
          const d = s.query(_p, _hit);
          if (d > depth) {
            depth = d;
            _push.copy(_hit.normal).applyQuaternion(s.object.quaternion);
          }
        }
      }
      // The deepest sample is at most `pad` off the centre, so clearing it by
      // its own depth carries the whole ball out of that surface. A second pass
      // catches the corner cases — literally, the corners, where backing out of
      // one face pushes into another.
      if (depth <= 0) break;
      camera.position.addScaledVector(_push, depth + 0.05);
      moved = true;
    }
    return moved;
  }

  return {
    add,
    resolve,
    solids,
    get pad() { return pad; },
    set pad(v) { pad = v; },
  };
}
