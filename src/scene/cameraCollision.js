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
export function createCameraCollision(camera, { pad = 1.4, iterations = 6 } = {}) {
  const solids = [];
  const _inv = new Matrix4();
  const _p = new Vector3();
  const _push = new Vector3();
  const _cand = new Vector3();
  const _acc = new Vector3();
  const _dir = new Vector3();
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
    _acc.set(0, 0, 0);
    for (let it = 0; it < iterations; it++) {
      let depth = 0;
      // The eye itself being inside something is the failure this exists to
      // prevent, and the ball is only a margin around it. So an eye hit outranks
      // any ball hit however deep, and is never refused for reversing: better to
      // be shoved back and forth for a frame than to be left looking out from
      // inside a turret.
      let fromEye = false;
      for (const s of solids) {
        if (!s.enabled) continue;
        const reach = s.radius + pad;
        if (Number.isFinite(reach)
          && s.object.position.distanceToSquared(camera.position) > reach * reach) continue;
        _inv.compose(s.object.position, s.object.quaternion, _one).invert();
        for (let si = 0; si < SAMPLES.length; si++) {
          const o = SAMPLES[si];
          _p.set(
            camera.position.x + o[0] * pad,
            camera.position.y + o[1] * pad,
            camera.position.z + o[2] * pad,
          ).applyMatrix4(_inv);
          const d = s.query(_p, _hit);
          if (d <= 0) continue;
          const eye = si === 0;
          if (!eye && fromEye) continue;
          _cand.copy(_hit.normal).applyQuaternion(s.object.quaternion);
          // Never undo a push already made this pass. A deck below and the
          // deckhouse standing on it are a gap the ball does not fit through,
          // and always taking the deepest face would walk the camera up and
          // down between the two until the iterations ran out — leaving it
          // wherever it happened to stop, which could be back inside the hull.
          // Refusing to reverse leaves the sideways way out, and where there is
          // none it settles on the deck with only the top of the ball under the
          // overhang, which is what standing under one looks like.
          if (!eye && moved && _cand.dot(_acc) < -0.1) continue;
          if (eye && !fromEye) { fromEye = true; depth = 0; }
          if (d <= depth) continue;
          depth = d;
          _push.copy(_cand);
        }
      }
      // The deepest sample is at most `pad` off the centre, so clearing it by
      // its own depth carries the whole ball out of that surface. A second pass
      // catches the corner cases — literally, the corners, where backing out of
      // one face pushes into another.
      if (depth <= 0) break;
      camera.position.addScaledVector(_push, depth + 0.05);
      _acc.addScaledVector(_push, depth + 0.05).normalize();
      moved = true;
    }
    // Welded surfaces — a deckhouse standing on the deck it is built on, a
    // barbette through the plating around it — meet in a seam where out of one
    // thing is straight into the next, and no push along any face normal ever
    // gets clear. Walk out sideways instead. Away from the centreline works on
    // anything ship-shaped, because everything on her is narrower than the sea.
    let stuck = deepestEye();
    if (stuck) {
      _dir.subVectors(camera.position, stuck.object.position);
      _dir.y = 0;
      if (_dir.lengthSq() < 1e-6) _dir.set(1, 0, 0);
      _dir.normalize();
      for (let i = 0; i < 40 && stuck; i++) {
        camera.position.addScaledVector(_dir, 2);
        stuck = deepestEye();
        moved = true;
      }
    }
    return moved;
  }

  // Which solid the eye itself is inside, deepest first, or null if it is clear.
  function deepestEye() {
    let worst = 0;
    let which = null;
    for (const s of solids) {
      if (!s.enabled) continue;
      const reach = s.radius + pad;
      if (Number.isFinite(reach)
        && s.object.position.distanceToSquared(camera.position) > reach * reach) continue;
      _inv.compose(s.object.position, s.object.quaternion, _one).invert();
      _p.copy(camera.position).applyMatrix4(_inv);
      const d = s.query(_p, _hit);
      if (d > worst) { worst = d; which = s; }
    }
    return which;
  }

  return {
    add,
    resolve,
    solids,
    get pad() { return pad; },
    set pad(v) { pad = v; },
  };
}
