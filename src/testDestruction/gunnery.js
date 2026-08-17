import {
  Group, Mesh, SphereGeometry, MeshBasicNodeMaterial, Raycaster, Vector3, Color,
} from 'three/webgpu';

// Shells, for the destruction test rig.
//
// A projectile here is a point with a ballistic trajectory, drawn as a ball so
// you can watch it fly. What matters is the hit test: the ship is a few hundred
// separate meshes and the shell moves tens of metres per frame, so testing the
// shell's *position* against anything would tunnel straight through her at any
// sensible muzzle velocity. Each step therefore raycasts along the segment the
// shell actually swept, which is exact at any speed and gives back the mesh and
// the point — the two things the damage model needs to place a hit.
//
// The sea is a flat plane test against the buoyancy solver's fitted water
// height, not the FFT surface. A shell that lands 30 m from the hull only has
// to throw a splash roughly where the water is; matching the wave it hit is not
// worth a GPU readback.

const GRAVITY = 9.81;

const isVisible = (o) => {
  for (let n = o; n; n = n.parent) if (!n.visible) return false;
  return true;
};

// Where to point a gun to put a shell through `range` metres away at `speed`,
// given it falls the whole way there. Returned as a direction, so the caller
// can hand it straight to `fire`. Without this the rig shoots low by a couple of
// metres at any useful range and every attempt to hit the bridge takes the
// funnel instead.
export function aimWithDrop(direction, range, speed, out) {
  const t = range / speed;
  out.copy(direction).normalize();
  out.y += (0.5 * GRAVITY * t * t) / Math.max(range, 1);
  return out.normalize();
}

// Shell types. `pen` is what the damage model subtracts armour from, so AP is
// the only thing that hurts a turret face and HE is what strips her fittings,
// starts fires and opens her up to the sea.
// `wound` names the entry in WOUNDS (spec.js) that says how big a crater this
// tears, how wide it burns and how much of a hole it leaves for the sea — so
// the look of a hit, the structure it breaks and the water it lets in all come
// off one description rather than three.
export const SHELL_TYPES = [
  {
    key: 'AP', name: 'armour piercing', color: 0xffe9a8, wound: 'AP',
    damage: 110, pen: 26, fire: 0.05, breach: 1.0, speed: 320, radius: 0.55,
  },
  {
    key: 'HE', name: 'high explosive', color: 0xff8a4a, wound: 'HE',
    damage: 70, pen: 6, fire: 0.45, breach: 1.0, speed: 300, radius: 0.55,
  },
  {
    key: 'TORP', name: 'torpedo', color: 0x7fd4ff, wound: 'TORP',
    damage: 220, pen: 10, fire: 0.15, breach: 1.0, speed: 90, radius: 0.8,
  },
];

export function createGunnery({ max = 48 } = {}) {
  const group = new Group();
  group.name = 'test.shells';
  group.frustumCulled = false;

  // One material per shell type, so you can see at a glance what is in the air.
  const materials = new Map();
  const materialFor = (hex) => {
    if (!materials.has(hex)) {
      const m = new MeshBasicNodeMaterial({ color: new Color(hex) });
      m.toneMapped = false; // a tracer should stay bright against a dark sea
      materials.set(hex, m);
    }
    return materials.get(hex);
  };
  const geometry = new SphereGeometry(1, 10, 8);

  const live = [];
  const pool = [];
  const ray = new Raycaster();
  const _step = new Vector3();
  const _prev = new Vector3();
  const _dir = new Vector3();

  function fire(origin, direction, type) {
    const mesh = pool.pop() || new Mesh(geometry, materialFor(type.color));
    mesh.material = materialFor(type.color);
    mesh.scale.setScalar(type.radius);
    mesh.position.copy(origin);
    mesh.visible = true;
    group.add(mesh);
    live.push({
      mesh,
      type,
      vel: _dir.copy(direction).normalize().multiplyScalar(type.speed).clone(),
      age: 0,
    });
    return live[live.length - 1];
  }

  function retire(i) {
    const s = live[i];
    group.remove(s.mesh);
    s.mesh.visible = false;
    pool.push(s.mesh);
    live.splice(i, 1);
  }

  // `target` is the object to test against; `seaHeight` is where the water is.
  // `onHit` gets the intersection plus the shell that made it; `onMiss` fires
  // when one goes into the sea instead.
  function update(dt, { target, seaHeight = 0, onHit = null, onMiss = null }) {
    for (let i = live.length - 1; i >= 0; i--) {
      const s = live[i];
      s.age += dt;
      s.vel.y -= GRAVITY * dt;
      _prev.copy(s.mesh.position);
      _step.copy(s.vel).multiplyScalar(dt);
      const dist = _step.length();

      if (target && dist > 1e-4) {
        ray.set(_prev, _dir.copy(_step).divideScalar(dist));
        ray.far = dist;
        // A wrecked stretch of guardrail is hidden rather than removed, and the
        // raycaster does not check visibility — so a shell would detonate on a
        // rail that is not there any more.
        const hit = ray.intersectObject(target, true).find((h) => isVisible(h.object));
        if (hit) {
          if (onHit) onHit({ ...hit, shell: s, speed: s.vel.length() });
          retire(i);
          continue;
        }
      }

      s.mesh.position.add(_step);
      // into the sea, or so far out it is never coming back
      if (s.mesh.position.y < seaHeight || s.age > 20) {
        if (onMiss && s.mesh.position.y < seaHeight) {
          onMiss({ point: s.mesh.position.clone(), shell: s, speed: s.vel.length() });
        }
        retire(i);
      }
    }
  }

  return {
    group,
    fire,
    update,
    clear() { for (let i = live.length - 1; i >= 0; i--) retire(i); },
    get count() { return live.length; },
  };
}
