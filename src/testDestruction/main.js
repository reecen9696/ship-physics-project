import {
  Scene, PerspectiveCamera, WebGPURenderer, Color, Vector2, Vector3, Matrix4, Mesh,
  FogExp2, MathUtils, DirectionalLight, PCFSoftShadowMap, NeutralToneMapping, Raycaster,
} from 'three/webgpu';
import { uniform, shadow } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { params } from '../ocean/params.js';
import { Ocean } from '../ocean/Ocean.js';
import { createOceanSurfaceMaterial } from '../ocean/oceanSurfaceMaterial.js';
import { makeDetailTexture } from '../ocean/detailTexture.js';
import { makeOceanGrid } from '../ocean/oceanGrid.js';
import { createSkyDome } from '../ocean/sky.js';
import { createShading, applyTimeOfDay, updateSunDir } from '../scene/shading.js';
import { createBoat } from '../boat/Boat.js';
import { capitalShipHandling } from '../boat/shipHandling.js';
import { createBattleship } from '../battleship/Battleship.js';
import { SHIP_CONFIG, COMPARTMENTS, TURRETS, AA_MOUNTS, STERN_AA } from '../battleship/spec.js';
import { createHUD } from '../util/hud.js';
import { createGunnery, aimAt, SHELL } from '../battleship/gunnery.js';
import { createHitMap } from '../battleship/hitmap.js';
import { createReadout } from './readout.js';

// Destruction test rig.
//
// The sim page drives a ship; this one shoots at her. Everything below the
// gunnery is the same world — same FFT ocean, same buoyancy solver, same
// battleship assembly — because the interesting half of the damage model is
// what flooding does to a hull that is genuinely floating. What is different is
// that she is stopped, beam-on, and there is a mouse pointer wired to a gun.
//
// Deliberately not shared with src/main.js: the helm, the launch, the GUI, the
// debug spectrum views. This page exists to make one subsystem observable.

const hud = createHUD();

// Camera stations round the ship, in her own frame (+z forward, +y up).
const VIEWS = [
  { name: 'port beam', pos: [175, 42, 10], look: [0, 6, 0] },
  { name: 'starboard beam', pos: [-175, 42, -10], look: [0, 6, 0] },
  { name: 'bow', pos: [70, 34, 195], look: [0, 6, 20] },
  { name: 'quarter', pos: [-120, 40, -165], look: [0, 6, -20] },
  { name: 'masthead', pos: [40, 150, 150], look: [0, 0, 0] },
];

async function main() {
  if (WebGPU.isAvailable() === false) {
    hud.error('WebGPU is not available. Use Chrome/Edge 113+ or Safari 18+ — this build has no WebGL fallback.');
    return;
  }

  const c = params.colors;
  const scene = new Scene();
  scene.fog = new FogExp2(new Color(c.skyHorizon).getHex(), 0.0020);

  const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 30000);

  const renderer = new WebGPURenderer({ antialias: true, trackTimestamp: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, params.renderScale));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.setClearColor(new Color(c.skyHorizon), 1);
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = params.exposure;
  document.body.appendChild(renderer.domElement);

  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) {
    hud.error('Renderer fell back to WebGL2 — this project targets WebGPU only.');
    return;
  }
  const device = renderer.backend.device;
  if (device && typeof device.addEventListener === 'function') {
    device.addEventListener('uncapturederror', (e) => hud.error('WebGPU validation: ' + (e.error?.message ?? String(e.error))));
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.92;

  const shading = createShading(params);

  const sunLight = new DirectionalLight(new Color(c.sun), 0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  const SUN_DIST = 400;
  sunLight.shadow.bias = -0.0004;
  {
    const span = 130; // wide enough to hold a 180 m ship
    const cam = sunLight.shadow.camera;
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
    cam.near = Math.max(SUN_DIST - span * 2.2, 1);
    cam.far = SUN_DIST + span * 2.2;
    sunLight.shadow.normalBias = (span * 2) / 4096 * 2.5;
    cam.updateProjectionMatrix();
  }
  scene.add(sunLight, sunLight.target);
  const sunShadow = shadow(sunLight);

  function placeSun(x, z) {
    sunLight.target.position.set(x, 0, z);
    sunLight.position.copy(shading.sunDir.value).multiplyScalar(SUN_DIST).add(sunLight.target.position);
    sunLight.target.updateMatrixWorld();
  }
  updateSunDir(params, shading);
  placeSun(0, 0);

  const skyDome = createSkyDome(shading);
  scene.add(skyDome);

  const setTimeOfDay = (t) => applyTimeOfDay(t, {
    params, shading, renderer, scene, onSun: () => placeSun(0, 0),
  });
  setTimeOfDay(params.timeOfDay);

  // --- sea -------------------------------------------------------------------
  const ocean = new Ocean(renderer, params);
  await ocean.updateInitialSpectrum();

  const detailTex = makeDetailTexture();
  const OCEAN_EXTENT = 900;
  const OCEAN_CELL = 1;
  const OCEAN_SEGS = 320;
  const oceanOffset = uniform(new Vector2());
  const contacts = { depthScale: uniform(camera.far - camera.near), hulls: [] };
  const _one = new Vector3(1, 1, 1);
  function registerHull(hull, { width, strength = 1, wakeSeconds = 1.0, water }) {
    const h = {
      hull,
      water,
      worldToHull: uniform(new Matrix4()),
      width: uniform(width),
      strength: uniform(strength),
      wake: uniform(0),
      wakeSeconds,
      _m: new Matrix4(),
      sync(body) {
        const q = body.visualQuaternion ?? body.quaternion;
        h.worldToHull.value.copy(h._m.compose(body.position, q, _one).invert());
        h.wake.value = Math.min(Math.max(body.forwardSpeed, 0) * h.wakeSeconds, hull.length * 0.5);
      },
    };
    contacts.hulls.push(h);
    return h;
  }
  const oceanMesh = new Mesh(
    makeOceanGrid({ extent: OCEAN_EXTENT, segs: OCEAN_SEGS, cell: OCEAN_CELL }),
    createOceanSurfaceMaterial(ocean.cascades, {
      lengthScales: params.lengthScales, shading, detailTex, offset: oceanOffset, sunShadow, contacts,
    }),
  );
  oceanMesh.frustumCulled = false;
  oceanMesh.renderOrder = 10;
  scene.add(oceanMesh);

  // --- the ship, floating and shootable ---------------------------------------
  const shipWater = {
    height: uniform(0), slope: uniform(new Vector2()), origin: uniform(new Vector2()),
  };
  const battleship = createBattleship({ shading });
  const ship = createBoat(renderer, {
    ocean, params, shading,
    hull: battleship.hull,
    config: SHIP_CONFIG,
    spray: false,
    flooding: battleship.state,
    capability: battleship.damage.capability,
    water: shipWater,
    handling: capitalShipHandling,
    buildMesh: () => battleship.group,
  });
  scene.add(ship.group);
  scene.add(battleship.fx.mesh);
  // Everything that has left her lives in world space, so it goes in the scene
  // rather than under the hull: whole pieces of ship under `wreck`, the plate
  // thrown off a burst under `shards`, and the water either of them puts up.
  scene.add(battleship.wreck.group);
  scene.add(battleship.shards.mesh);
  scene.add(battleship.splash.mesh);
  const shipSea = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };
  registerHull(battleship.hull, { width: 3.5, strength: 1, wakeSeconds: 2.0, water: shipWater });
  const shipContact = contacts.hulls[0];

  ship.position.set(0, 0, 0);
  // She lies stopped, heading north, so the world frame and her frame agree and
  // the camera stations above mean what they say.
  const trueWind = new Vector3();

  // --- gunnery ---------------------------------------------------------------
  const gunnery = createGunnery({ shading, smoke: battleship.fx });
  scene.add(gunnery.group);
  const hitMap = createHitMap(battleship);

  const readout = createReadout({
    groups: [
      { title: 'hull compartments', components: COMPARTMENTS },
      { title: 'main battery', components: TURRETS },
      { title: 'superstructure', components: ['bridge', 'funnel', 'mainmast', 'steering', 'screws'].map((id) => ({ id })) },
      { title: 'anti-aircraft', components: [STERN_AA, ...AA_MOUNTS] },
    ],
  });

  const _dir = new Vector3();

  // The rig does not damage the ship itself. It resolves *what* was hit and
  // hands the shell to `battleship.strike`, which is the one door every
  // damaging event on this ship comes through — the crater in the field, the
  // structure the crater ate, the hole it opened to the sea and the burst off
  // it are all on the far side of that call. Doing any of it here would give
  // this page a destruction model of its own that the sim page did not have.
  function onHit({ point, object, shell }) {
    const { id, component, direct, part } = hitMap.resolve(object, point);
    if (!component) return;
    const before = component.hp;
    const t = SHELL;

    // The direction matters: `strike` pushes the crater in along the shell's
    // path, because a burst *behind* the plating takes a disc of it away and a
    // burst on the outside of it only scoops.
    _dir.copy(shell.vel).normalize();
    const { result } = battleship.strike({
      point,
      dir: _dir,
      kind: t.wound, // the entry in the wound table this round tears
      componentId: id,
      damage: t.damage,
      pen: t.pen,
      fire: t.fire,
      breach: t.breach,
    });

    const took = result ? result.effect : 0;
    const tag = direct ? id : `${part} → ${id}`;
    const dead = result && result.destroyed;
    readout.logHit(
      `${t.key.padEnd(4)} ${tag}  −${took.toFixed(0)}  ${Math.ceil(component.hp)}/${component.maxHp}`
      + `${dead ? '  DESTROYED' : ''}`,
      dead ? '#ff6b6b' : (before - component.hp > t.damage * 0.5 ? '#ffcf6b' : '#9fc4e0'),
    );
  }

  function onMiss({ point, speed }) {
    battleship.shellSplash(point, speed);
  }

  // --- aiming ----------------------------------------------------------------
  // OrbitControls owns left-drag, so a click only counts as a shot if the mouse
  // did not travel while it was down. Without this every attempt to look round
  // the ship also empties a magazine into her.
  const ray = new Raycaster();
  const ndc = new Vector2();
  const _aim = new Vector3();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const held = performance.now() - down.t;
    down = null;
    if (moved > 6 || held > 500) return; // that was an orbit, not a shot
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // Aim off for the drop over the range to whatever is under the crosshair, so
    // the shell lands where you pointed rather than a couple of metres below it.
    ship.group.updateMatrixWorld(true);
    const aimed = ray.intersectObject(ship.group, true)[0];
    const range = aimed ? aimed.distance : camera.position.distanceTo(controls.target);
    // The launch angle that actually puts a shell through what you clicked on,
    // solved against the trajectory it will fly — see battleship/ballistics.js.
    _aim.copy(ray.ray.direction).multiplyScalar(range);
    gunnery.fire(ray.ray.origin, aimAt(_aim, _aim));
  });

  // --- keys ------------------------------------------------------------------
  let view = 0;
  let dcEffort = 1;
  let night = false;
  function setView(i) {
    view = ((i % VIEWS.length) + VIEWS.length) % VIEWS.length;
    const v = VIEWS[view];
    camera.position.set(...v.pos);
    controls.target.set(...v.look);
    controls.update();
  }
  setView(0);

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') { battleship.repair(); gunnery.clear(); battleship.fx.clear(); ship.reset(); }
    else if (k === 'v') setView(view + 1);
    else if (k === 'p') dcEffort = dcEffort > 0 ? 0 : 1;
    else if (k === 'n') { night = !night; setTimeOfDay(night ? 0 : 1); }
    else if (k === 'x') {
      // open every compartment to the sea, to watch her go down without having
      // to shoot the waterline apart first
      battleship.flooding.scuttle();
    } else if (k === 'k') {
      for (const t of battleship.turrets) battleship.damage.hit(t.id, { damage: 1e6, pen: 999 });
    } else if (k === 'm' || k === 'b') {
      // Break the funnel without having to hit it, at the height the key says —
      // `m` two-thirds up (the top comes off, the stump stays and keeps
      // belching), `b` at the foot (the whole thing goes over). This is the one
      // behaviour of the structure model that is tedious to reach with the
      // mouse and the thing most worth watching.
      battleship.structure.breakAt('funnel', k === 'm' ? 0.66 : 0.02);
    } else if (k === 'j') {
      // And the other half of it: strip the top-hamper off both towers, one
      // fitting at a time from the masthead down. The towers themselves stay
      // standing, because they are not things that come off her — see
      // fittings.js.
      const up = [...battleship.fittings.list]
        .filter((f) => !f.gone)
        .sort((a, b) => b.centre.y - a.centre.y);
      for (const f of up.slice(0, 4)) battleship.fittings.detach(f, f.centre);
    }
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  globalThis.poseidon = {
    renderer, scene, camera, controls, ocean, params, shading, battleship, ship, gunnery,
    hitMap, setTimeOfDay,
  };

  // --- loop ------------------------------------------------------------------
  let elapsed = 0;
  let last = performance.now();
  let emaWall = 16.7;
  let hudAccum = 1;
  let loopError = null;

  renderer.setAnimationLoop(() => {
    try {
      frame();
    } catch (err) {
      if (String(err?.stack ?? err) !== loopError) {
        loopError = String(err?.stack ?? err);
        console.error('[destruction] frame error', err);
        hud.error('frame error: ' + loopError);
      }
    }
  });

  function frame() {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt * params.timeScale;

    ocean.evolve(elapsed, dt * params.timeScale);
    shading.time.value = elapsed;

    const simDt = Math.min(dt, 0.05);
    const wd = MathUtils.degToRad(params.local.windDirection);
    trueWind.set(Math.cos(wd), 0, Math.sin(wd)).multiplyScalar(params.local.windSpeed);

    ship.update(simDt);
    shipSea.height = ship.state.waterY;
    shipSea.slopeX = ship.state.slopeX;
    shipSea.slopeZ = ship.state.slopeZ;
    shipSea.originX = ship.position.x;
    shipSea.originZ = ship.position.z;

    battleship.update(dt, {
      throttle: 0,
      velocity: ship.velocity,
      wind: trueWind,
      sea: shipSea,
      dcEffort,
      // wreckage resting on her decks has to be shed over the side when she
      // heels far enough, which it can only know from her
      heel: ship.heel,
    });

    // Shells fly against the ship as she is drawn *this* frame, and the ship's
    // world matrices were last updated by the renderer a frame ago — so refresh
    // them before the raycast or every hit lands one frame stale, which at 300
    // m/s on a rolling hull is a visible miss.
    ship.group.updateMatrixWorld(true);
    gunnery.update(dt, {
      target: ship.group,
      seaHeight: shipSea.height,
      onHit,
      onMiss,
      wind: trueWind,
      camera,
    });

    const ox = Math.round(camera.position.x / OCEAN_CELL) * OCEAN_CELL;
    const oz = Math.round(camera.position.z / OCEAN_CELL) * OCEAN_CELL;
    oceanMesh.position.set(ox, 0, oz);
    oceanOffset.value.set(ox, oz);

    skyDome.position.copy(camera.position);
    battleship.splash.setCamera(camera);
    shipContact.sync(ship);
    controls.update();

    renderer.render(scene, camera);

    emaWall = emaWall * 0.9 + dt * 1000 * 0.1;
    hudAccum += dt;
    if (hudAccum >= 0.1) {
      hudAccum = 0;
      readout.update(battleship.damage, battleship.state);
      hud.set(
        `DESTRUCTION TEST · ${(1000 / emaWall).toFixed(0)} fps · ${gunnery.count} shells in the air\n`
        + `shell: ${SHELL.key} — ${SHELL.name} `
        + `(${SHELL.mass} kg at ${SHELL.muzzle} m/s · dmg ${SHELL.damage} · pen ${SHELL.pen})\n`
        + `heel ${ship.heel.toFixed(1)}° · trim ${ship.trim.toFixed(1)}° · draft ${ship.state.submerged.toFixed(2)} m`
        + ` · damage control ${dcEffort ? 'ON' : 'OFF'}\n`
        + `${battleship.state.holes} holes · ${Math.round(battleship.state.tons)} t of water`
        + ` · ${battleship.wreck.count} pieces off her`
        + ` · ${battleship.fittings.count}/${battleship.fittings.list.length} fittings aloft`
        + `${battleship.state.foundered ? ' · FOUNDERED' : ''}\n`
        + `\n`
        + `CLICK to fire at the ship · DRAG to orbit\n`
        + `R = repair all · X = open her to the sea · K = kill all turrets\n`
        + `M = break funnel two-thirds up · B = break it at the foot\n`
        + `J = strip the four highest fittings off the towers\n`
        + `P = damage control on/off · V = view (${VIEWS[view].name}) · N = ${night ? 'day' : 'night'}`,
      );
    }
  }
}

main().catch((e) => hud.error(String(e?.stack ?? e)));
