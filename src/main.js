import {
  Scene, PerspectiveCamera, WebGPURenderer, Color, Vector2, Vector3, Matrix4, Mesh,
  FogExp2, MathUtils, DirectionalLight, PCFSoftShadowMap, NeutralToneMapping, Raycaster,
  Quaternion,
} from 'three/webgpu';
import { shadow } from 'three/tsl';
import { uniform } from './scene/uniforms.js';
import { createShading, applyTimeOfDay, updateSunDir } from './scene/shading.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { params } from './ocean/params.js';
import { Ocean } from './ocean/Ocean.js';
import { validateFFT } from './ocean/fft.js';
import { createOceanSurfaceMaterial } from './ocean/oceanSurfaceMaterial.js';
import { makeDetailTexture } from './ocean/detailTexture.js';
import { makeOceanGrid } from './ocean/oceanGrid.js';
import { createSpray } from './ocean/spray.js';
import { createSkyDome } from './ocean/sky.js';
import { createDebugView, spectrumDebugMaterial } from './ocean/debugView.js';
import { createBoat, attachBoatControls, boatConfig } from './boat/Boat.js';
import { capitalShipHandling } from './boat/shipHandling.js';
import { sprayConfig } from './boat/hullSpray.js';
import { hullDescriptor as boatHull } from './boat/boatMesh.js';
import { createHullCollision } from './boat/collision.js';
import { createHullDamage } from './boat/hullDamage.js';
import { hullQuery } from './boat/hullShape.js';
import { createBattleship } from './battleship/Battleship.js';
import { createColliders } from './battleship/colliders.js';
import { createGunnery, aimAt, SHELL, AA_ROUND } from './battleship/gunnery.js';
import { createHitMap } from './battleship/hitmap.js';
import { SHIP_CONFIG, TURRETS, AA_MOUNTS, STERN_AA } from './battleship/spec.js';
import { createCameraCollision } from './scene/cameraCollision.js';
import { createFirstPerson } from './player/firstPerson.js';
import { loadPlayerModels } from './player/models.js';
import { createFigureMaterial } from './player/figureMaterial.js';
import { createSoundBank } from './util/sound.js';
import { PLAYER } from './player/spec.js';
import { LAYING } from './player/turretStation.js';
import { AA_LAYING } from './player/aaStation.js';
import { createGUI } from './gui.js';
import { createHUD } from './util/hud.js';
import { fx, onFx } from './util/fxToggles.js';
import { createFxPanel } from './util/fxPanel.js';
import { createNavButtons } from './util/navButtons.js';

const hud = createHUD();

async function main() {
  if (WebGPU.isAvailable() === false) {
    hud.error('WebGPU is not available. Use Chrome/Edge 113+ or Safari 18+ — this build has no WebGL fallback.');
    return;
  }

  const c = params.colors;
  const scene = new Scene();
  // Thin enough that a 180 m ship reads at half a mile, thick enough to hide the
  // edge of the ocean grid. The two hulls in this scene are an order of magnitude
  // apart in size, and the fog has to serve both.
  scene.fog = new FogExp2(new Color(c.skyHorizon).getHex(), 0.0020);

  const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 30000);
  // behind and above the boat — the hull's forward axis is +z, so the camera
  // belongs at -z, looking the way it travels
  camera.position.set(0, 11, -34);

  const renderer = new WebGPURenderer({ antialias: true, trackTimestamp: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, params.renderScale));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.setClearColor(new Color(c.skyHorizon), 1);
  // Everything in this scene is shaded by hand and the sun terms are allowed to
  // go above 1 — a sunlit crest and a specular highlight both should. Clipping
  // that at 1 per channel is what bleaches a grey hull to white and a teal sea
  // to pale blue: the brightest channel pins first and the colour walks toward
  // the corner of the cube. A tone curve rolls the highlights off instead, so
  // bright surfaces stay the colour they are. Khronos Neutral is the one that
  // holds saturation through the roll-off rather than desaturating into it,
  // which is exactly the failure being fixed.
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

  // FFT isolation test (hard gate)
  const fftTest = await validateFFT(renderer, params.N);
  const fftStr = `FFT self-test: ${fftTest.pass ? 'PASS ✓' : 'FAIL ✗'} (impulse=${fftTest.err1.toExponential(1)}, freq=${fftTest.err2.toExponential(1)})`;
  if (!fftTest.pass) hud.error(fftStr + ' — IFFT not matching analytic result.');

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1, 0);
  // Just past horizontal, so you can look up at the sky (and the stars at
  // night) without being able to drop the camera under the sea.
  controls.maxPolarAngle = Math.PI * 0.92;

  // shared shading uniforms (sky dome + ocean reflection use the same values)
  const shading = createShading(params);
  // Nothing in this scene uses three's lighting model — sea, sky and hull are all
  // shaded by hand from the `shading` uniforms. This light exists only to own a
  // shadow map, which `shadow()` then samples from the ocean and the hull, so the
  // boat throws a real shadow onto the water it is floating on.
  // Metres of sea the shadow map covers, centred on whichever hull is conned.
  // A span tight enough to give the launch a crisp shadow cannot contain the
  // battleship at all, so it is resized when the helm moves between them.
  const sunLight = new DirectionalLight(new Color(c.sun), 0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  const SUN_DIST = 400; // how far up the sun direction the light is parked
  sunLight.shadow.bias = -0.0004;
  function setShadowSpan(span) {
    const cam = sunLight.shadow.camera;
    if (cam.right === span) return;
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
    // The light sits SUN_DIST away along the sun direction, so everything worth
    // shadowing lies in a slab around that distance. Clamping near/far to that
    // slab instead of spanning 1..1000 is most of the depth precision available:
    // a shadow map is a depth buffer, and the further apart its planes the
    // coarser every comparison in it becomes — which shows up as acne on a hull
    // that is trying to shadow itself.
    cam.near = Math.max(SUN_DIST - span * 2.2, 1);
    cam.far = SUN_DIST + span * 2.2;
    // Bias has to scale with the texel footprint, or a setting that is right for
    // the launch is either useless or produces peter-panning on the battleship.
    sunLight.shadow.normalBias = (span * 2) / 4096 * 2.5;
    cam.updateProjectionMatrix();
  }
  setShadowSpan(34);
  scene.add(sunLight, sunLight.target);

  // 1 where the sun reaches, 0 in shadow. Sampled by the sea *and* by the ships
  // themselves, so the superstructure lays a shadow across her own decks. The
  // shadow-map pass draws with a depth material rather than these ones, so a
  // mesh casting into the map and sampling it in the main pass is fine.
  const sunShadow = shadow(sunLight);

  // --- and a second map, for what is standing on her deck ----------------------
  //
  // The ship casts into the map above and does not sample it, for the reason
  // written against `createBattleship` below: in this three build a mesh that
  // writes a shadow map and whose material also reads it trips a WebGPU
  // validation error, because the depth texture is still bound as the render
  // attachment. The note there says the fix is to make the casters and the
  // samplers disjoint sets. This is that.
  //
  // The split is one rule and it is drawn in Battleship.js: everything that
  // *stands on* the deck casts — the superstructure, the turrets, the vents and
  // drums and crates, the guardrail, the man walking about — and the teak deck
  // itself receives. Nothing is on both sides of it, so nothing reads a map it
  // wrote. It is enforced by layer: this camera is set to CAST_LAYER and three
  // culls the shadow pass against it (see `shadow.camera.layers.mask` in
  // ShadowNode), so the deck is not merely told not to cast — it is not drawn
  // into the map at all.
  //
  // A second 4096 map is not free, and it buys the one thing the first cannot:
  // the sun's map has to hold a whole 180 m hull *and* the sea round it, which
  // is far too coarse to resolve a crate. This one holds the ship and nothing
  // else.
  const CAST_LAYER = 1;
  const deckLight = new DirectionalLight(new Color(c.sun), 0);
  deckLight.castShadow = true;
  // 2048, not 4096. The map holds the ship and nothing else, so a 200 m span
  // across 2048 texels is about 10 cm — a crate's shadow is nine texels wide,
  // which is enough. The larger map cost several frames a second in first
  // person for a sharpness nobody standing on the deck can see.
  deckLight.shadow.mapSize.set(2048, 2048);
  deckLight.shadow.bias = -0.0004;
  deckLight.shadow.camera.layers.set(CAST_LAYER);
  {
    const span = 100; // she is 180 m long, and this has to hold her at any heading
    const cam = deckLight.shadow.camera;
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
    cam.near = Math.max(SUN_DIST - span * 2.2, 1);
    cam.far = SUN_DIST + span * 2.2;
    deckLight.shadow.normalBias = (span * 2) / 2048 * 2.5;
    cam.updateProjectionMatrix();
  }
  // Rendered on demand, not every frame.
  //
  // This map costs a full depth pass over the whole ship — hull, superstructure,
  // turrets, guardrail, every crate on the deck — and it is sampled by exactly
  // one thing, the teak deck, and only to shadow the *sun*. After dark there is
  // no sun to shadow, so the entire pass draws a map nothing can see; that alone
  // was most of what the night frame was paying for the lighting.
  //
  // In daylight it still has to follow her, but not at sixty hertz: what moves
  // in it is her roll and her turrets, and a soft directional shadow updated
  // every third frame is not a thing anybody can see moving late — she rolls
  // on an eleven-second period, and twenty hertz is sixty samples of it.
  deckLight.shadow.autoUpdate = false;
  scene.add(deckLight, deckLight.target);
  const deckShadow = shadow(deckLight);
  // What the deck map is centred on. Null until she exists — `placeSun` runs
  // once during setup, before there is a ship to follow — and her body position
  // from then on.
  let deckFollow = null;
  let deckShadowFrame = 0;

  function placeSun(x, z) {
    // The shadow camera is small and follows the boat; the light rides above it
    // along the sun direction so the hull is always inside the map.
    sunLight.target.position.set(x, 0, z);
    sunLight.position.copy(shading.sunDir.value).multiplyScalar(SUN_DIST).add(sunLight.target.position);
    sunLight.target.updateMatrixWorld();
    // The deck map follows the battleship rather than whichever hull is conned:
    // it is her deck it is for, and she is where the props and the crew are.
    deckLight.target.position.set(
      deckFollow ? deckFollow.x : x, 0, deckFollow ? deckFollow.z : z,
    );
    deckLight.position.copy(shading.sunDir.value).multiplyScalar(SUN_DIST)
      .add(deckLight.target.position);
    deckLight.target.updateMatrixWorld();
  }

  function updateSun() {
    updateSunDir(params, shading);
    placeSun(sunLight.target.position.x, sunLight.target.position.z);
  }
  updateSun();

  // The dome is finite, and the boat can sail out of it; keeping it on the
  // camera makes the sky the same everywhere, however far you go.
  const skyDome = createSkyDome(shading);
  scene.add(skyDome);

  // Apply a time of day. Everything in the scene is shaded from the `shading`
  // uniforms, so this is a matter of writing new values into them — there is no
  // second set of materials anywhere, and no separate night renderer.
  const setTimeOfDay = (t) => applyTimeOfDay(t, {
    params, shading, renderer, scene, onSun: () => placeSun(sunLight.target.position.x, sunLight.target.position.z),
  });
  setTimeOfDay(params.timeOfDay);

  // FFT-ocean simulation
  const ocean = new Ocean(renderer, params);
  await ocean.updateInitialSpectrum();

  // shaded ocean surface — ~300k-vert tiled plane (smaller extent keeps the
  // triangles small within budget; fog hides the edge)
  const detailTex = makeDetailTexture();
  // The grid has to be big enough that a 180 m ship has open water around her,
  // and fine enough that a 16 m launch still sits on real waves. Those two pull
  // in opposite directions and a uniform grid can only satisfy both by being
  // fine everywhere, which is 1.6 million triangles of which the great majority
  // are hundreds of metres away and smaller than a pixel. The spacing is graded
  // instead — 1 m cells under the ship, opening to several metres at the horizon
  // — for the same reach at an eighth of the triangles. See oceanGrid.js.
  const OCEAN_EXTENT = 900;
  const OCEAN_CELL = 1; // metres, the finest cell: right under the camera
  const OCEAN_SEGS = 320; // grid lines per side
  const oceanOffset = uniform(new Vector2());
  // `depthScale` converts the normalised linear-depth difference back into
  // metres, so `width` can be stated as a real distance from the hull.
  // Every hull in the scene registers here; the ocean shader draws a wash along
  // each one's waterline. `worldToHull` is refreshed per frame from the body's
  // transform, and `hull` carries the TSL section curves for that hull's shape.
  const contacts = {
    depthScale: uniform(camera.far - camera.near),
    hulls: [],
  };
  const _one = new Vector3(1, 1, 1);
  function registerHull(hull, { width, strength = 1, wakeSeconds = 1.0, water }) {
    const h = {
      hull,
      water, // the solver's fitted plane {height, slope, origin}: tells the shader when she is awash
      worldToHull: uniform(new Matrix4()),
      width: uniform(width),
      strength: uniform(strength),
      wake: uniform(0),
      wakeSeconds,
      _m: new Matrix4(),
      sync(body) {
        // the drawn rotation, not the physics one — a hull leaning into a turn
        // should take its wash with it
        const q = body.visualQuaternion ?? body.quaternion;
        h.worldToHull.value.copy(h._m.compose(body.position, q, _one).invert());
        h.wake.value = Math.min(Math.max(body.forwardSpeed, 0) * h.wakeSeconds, hull.length * 0.5);
      },
    };
    contacts.hulls.push(h);
    return h;
  }
  const oceanSurfaceMat = createOceanSurfaceMaterial(ocean.cascades, {
    lengthScales: params.lengthScales, shading, detailTex, offset: oceanOffset, sunShadow, contacts,
  });
  const oceanMesh = new Mesh(
    makeOceanGrid({ extent: OCEAN_EXTENT, segs: OCEAN_SEGS, cell: OCEAN_CELL }),
    oceanSurfaceMat,
  );
  oceanMesh.frustumCulled = false;
  // draw the sea last, so the depth buffer it samples already holds the hull
  oceanMesh.renderOrder = 10;
  scene.add(oceanMesh);

  // Recentre the grid on a point, snapped to whole cells so vertices land on the
  // same world positions every frame (a free-sliding grid shimmers). The graded
  // grid keeps this working by rounding every one of its vertices onto the same
  // whole-cell lattice, coarse rings included.
  function recentreOcean(x, z) {
    const ox = Math.round(x / OCEAN_CELL) * OCEAN_CELL;
    const oz = Math.round(z / OCEAN_CELL) * OCEAN_CELL;
    oceanMesh.position.set(ox, 0, oz);
    oceanOffset.value.set(ox, oz);
  }

  // ballistic spray particles off breaking crests (temporarily disabled)
  const ENABLE_SPRAY = false;
  const spray = ENABLE_SPRAY
    ? createSpray(renderer, { cascades: ocean.cascades, lengthScales: params.lengthScales, N: params.N, shading })
    : null;
  if (spray) scene.add(spray.mesh);
  const windVec = new Vector3();
  const trueWind = new Vector3();

  // boat: rigid hull floating on GPU-sampled probes of the same cascade maps.
  // She has no component graph — see hullDamage.js — but she is holed and
  // flooded on the same two numbers the battleship hands the solver, so ramming
  // something eleven times her length has the consequence it should.
  const launchDamage = createHullDamage({ hp: 100 });
  const boat = createBoat(renderer, {
    ocean, params, shading, flooding: launchDamage.state, capability: launchDamage.capability,
  });
  scene.add(boat.group);
  scene.add(boat.spray.mesh); // droplets live in world space, not on the hull
  const boatContact = registerHull(boatHull, {
    width: params.contactFoamWidth, strength: params.contactFoam, wakeSeconds: params.wakeLength,
    water: boat.water,
  });

  // battleship: the same solver and the same shading, at 11x the length. She is
  // an assembly rather than a single mesh — five watertight hull sections, four
  // training turrets, casemates, AA, and a superstructure whose pieces are
  // separately destructible.
  // The mean water plane the solver fits to her buoyancy probes each frame. The
  // hull shader no longer touches it — see boatMaterial.js for why a plane was
  // the wrong thing to shade a hull against — but the ocean still needs it, to
  // decide whether sea drawn over her decks is a ship going under or just a
  // crest passing through geometry it cannot see.
  const shipWater = {
    height: uniform(0), slope: uniform(new Vector2()), origin: uniform(new Vector2()),
  };
  // She still does not receive `sunShadow`, and for the reason that note has
  // always given: in this three build a mesh that casts into a map and whose
  // material also samples that map trips a WebGPU validation error, because the
  // depth texture is still bound as the render attachment. She casts into the
  // sun's map, onto the sea, and reads nothing from it.
  //
  // `deckShadow` is the second map, and it is the disjoint-sets answer that note
  // asked for — see where it is built above. Everything standing on her deck
  // casts into it; the teak deck reads it; nothing does both.
  const battleship = createBattleship({ shading, deckShadow, castLayer: CAST_LAYER });
  const ship = createBoat(renderer, {
    ocean, params, shading,
    hull: battleship.hull,
    config: SHIP_CONFIG,
    spray: false,
    flooding: battleship.state,
    capability: battleship.damage.capability,
    water: shipWater,
    // She is conned, not sailed: surge, sideslip and yaw come from the handling
    // model, and this solver keeps only the heave, pitch and roll the sea gives
    // her. The launch stays on the full force solve — at 16 m the forces are
    // the behaviour, which is the case the solver was written for.
    handling: capitalShipHandling,
    buildMesh: () => battleship.group,
  });
  deckFollow = ship.position; // where she actually is, each frame
  // The camera is in the scene, which it was not and did not need to be while
  // nothing was parented to it. The first-person rifle is: a view model is drawn
  // in the camera's own frame, and a child of a camera that is not in the graph
  // is never traversed and never drawn.
  scene.add(camera);
  scene.add(ship.group);
  scene.add(battleship.fx.mesh);
  // Anything that has come off her — guardrail, fittings — and the water it
  // throws when it lands. Both are world-space: they stop moving with the ship
  // the moment they leave her.
  scene.add(battleship.wreck.group);
  scene.add(battleship.shards.mesh);
  scene.add(battleship.splash.mesh);
  // The plane the solver fitted to her buoyancy probes this frame, in the form
  // the ballistic systems want it: where the sea is, at a world point near her.
  const shipSea = { height: 0, slopeX: 0, slopeZ: 0, originX: 0, originZ: 0 };
  const shipContact = registerHull(battleship.hull, {
    width: 3.5, strength: 1, wakeSeconds: 2.0, water: shipWater,
  });

  // --- the two hulls, against each other -------------------------------------
  //
  // Both are registered with the same solver; see boat/collision.js. What each
  // one makes of being hit is its own business, which is why the damage lands
  // through a callback rather than in the solver: the battleship works out which
  // compartment took it and hits her damage model there, and the launch has one
  // number and a hole in her.
  //
  // The scaling is set by the one collision that can actually happen: the launch
  // at her full 26 kn into a stopped battleship, which is about 4.4 MJ. That
  // should very nearly write off the launch and open a compartment on the ship
  // without ever threatening her — a boat is not a torpedo.
  const RAM_TO_SHIP = 9; // hit points per megajoule, against 400 per compartment
  const RAM_TO_LAUNCH = 22; // hit points per megajoule, against 100 for the hull
  const _rammed = new Vector3(0, 1, 0);
  const collisions = createHullCollision();
  collisions.add(ship, {
    hull: battleship.hull,
    mass: SHIP_CONFIG.mass,
    stations: 11,
    name: 'battleship',
    onImpact: (ev) => {
      const mj = ev.energy / 1e6;
      const cpt = battleship.damage.compartmentAt(ev.local.z / battleship.hull.length);
      battleship.damage.hit(cpt.id, {
        damage: mj * RAM_TO_SHIP,
        // A stem is a blunt instrument next to a shell: it dents plate over a
        // wide area rather than punching through armour.
        pen: 6,
        breach: ev.kind === 'impact' ? Math.min(0.4, mj * 0.05) : 0,
      });
      if (ev.kind === 'impact' && battleship.splash.mesh.visible) {
        battleship.splash.burst(ev.point, _rammed,
          Math.min(3 + ev.speed, 12), Math.min(160, 30 + ev.speed * 12),
          { spread: 1.3, size: 0.6, life: 1.6 });
      }
    },
  });
  collisions.add(boat, {
    hull: boatHull,
    mass: boatConfig.mass,
    stations: 7,
    name: 'launch',
    onImpact: (ev) => {
      const mj = ev.energy / 1e6;
      launchDamage.hit({
        damage: mj * RAM_TO_LAUNCH,
        breach: ev.kind === 'impact' ? Math.min(0.6, mj * 0.12) : 0,
        z: ev.local.z / boatHull.length,
      });
      if (ev.kind === 'impact' && boat.spray.mesh.visible) {
        boat.spray.burst(ev.point, _rammed, Math.min(2 + ev.speed, 9), Math.min(90, 20 + ev.speed * 8),
          { spread: 1.1, size: 0.4, life: 1.2 });
      }
    },
  });

  // --- and the camera, against both ------------------------------------------
  //
  // The ship's own colliders — the same analytic hull loft, deckhouses, funnel
  // and turrets that wreckage lands on — double as what the camera is kept out
  // of, so the camera cannot get inside anything a falling mast could rest on.
  // Turrets are tested in their trained position, and a component that has been
  // shot away stops being solid, both of which fall out of asking the ship
  // rather than keeping a second description of her.
  const shipColliders = createColliders({
    mounts: battleship.mounts,
    alive: (id) => battleship.damage.alive(id),
  });
  const cameraSolids = createCameraCollision(camera);
  cameraSolids.add(ship.group, shipColliders.query, { radius: battleship.hull.length * 0.62 });
  cameraSolids.add(boat.group, hullQuery(boatHull), { radius: boatHull.length * 0.7 });
  // Dollying in past this is what used to put the eye inside the hull; the
  // de-penetration would catch it, but stopping the zoom is the kinder answer.
  controls.minDistance = 4;

  // --- something to shoot her with --------------------------------------------
  //
  // The same gunnery the destruction rig uses, and deliberately the same: a
  // ballistic ball, hit-tested along the segment it swept rather than at its
  // position, resolved to the component that owns the mesh it struck, and handed
  // to `battleship.strike` — the one door every damaging event on this ship goes
  // through. This page has no gunnery of its own and is not getting one; it has
  // the rig's, pointed by an eye on her own deck, so you can walk up to a turret
  // and open it.
  // The smoke goes to her own fire-and-smoke system, so a shell in flight leaves
  // a trace made of the same particles her funnel and her fires are made of.
  const gunnery = createGunnery({ shading, smoke: battleship.fx });
  scene.add(gunnery.group);
  const hitMap = createHitMap(battleship);
  // One shell. A turret is loaded with what the magazine sent up and the layer
  // does not pick it in the middle of a salvo — see ballistics.js.
  const _hitDir = new Vector3();
  const _hitPoint = new Vector3();
  const _up = new Vector3(0, 1, 0);

  const under = (o, root) => { for (let n = o; n; n = n.parent) if (n === root) return true; return false; };

  function onShellHit({ point, object, shell }) {
    // Which projectile arrived. Two guns on this ship now put things in the air
    // and they are not remotely the same event: a tonne of armour-piercing shell
    // and a kilogramme of high explosive off the stern mounting.
    const t = shell.proj || SHELL;
    // There are two hulls in the water and either can be hit. The launch has one
    // number and a hole in her; the battleship has a component graph.
    if (under(object, boat.group)) {
      const mj = t.damage;
      launchDamage.hit({
        damage: mj,
        breach: t.breach * 0.5,
        z: boat.group.worldToLocal(_hitPoint.copy(point)).z / boatHull.length,
      });
      if (boat.spray.mesh.visible) {
        boat.spray.burst(point, _up, 9, 70, { spread: 1.2, size: 0.4, life: 1.3 });
      }
      return;
    }
    const { id, component } = hitMap.resolve(object, point);
    if (!component) return;
    // The direction matters: `strike` pushes the crater in along the shell's
    // path, because a burst behind the plating takes a disc of it away and a
    // burst on the outside only scoops.
    _hitDir.copy(shell.vel).normalize();
    battleship.strike({
      point,
      dir: _hitDir,
      kind: t.key,
      componentId: id,
      damage: t.damage,
      pen: t.pen,
      fire: t.fire,
      breach: t.breach,
    });
  }

  // A round of the stern mounting's reaching the end of its fuze and destroying
  // itself. Nothing is hit and nothing is damaged: what it leaves is the puff,
  // and a sky full of those is the whole picture of anti-aircraft fire.
  function onShellBurst({ point }) {
    battleship.burst.play('FLAK', point, null, 1);
  }

  function onShellMiss({ point, speed }) {
    battleship.shellSplash(point, speed);
  }

  // Fired from the eye, down the middle of the screen. The drop is taken out
  // over the range to whatever is under the crosshair, so a shell aimed at the
  // funnel from the forecastle lands on the funnel rather than a couple of
  // metres under it.
  const _recoil = new Vector3();
  const _muzzle = new Vector3();
  const _aim = new Vector3();
  const _to = new Vector3();
  const _shot = new Raycaster();
  function fireFromEye() {
    camera.getWorldDirection(_aim);
    ship.group.updateMatrixWorld(true);
    _shot.set(camera.position, _aim);
    _shot.far = 2000;
    const seen = _shot.intersectObject(ship.group, true)[0];
    const range = seen ? seen.distance : 400;
    // clear of the near plane, and clear of the shooter's own head
    _muzzle.copy(camera.position).addScaledVector(_aim, 1.2);
    // Where the crosshair is pointing, as a point in space, and then the launch
    // angle that actually puts a shell through it — solved against the same
    // trajectory the shell will fly, drag and all. See ballistics.js.
    _to.copy(_aim).multiplyScalar(range).add(camera.position).sub(_muzzle);
    aimAt(_to, _aim);
    gunnery.fire(_muzzle, _aim);
  }

  // --- her own main battery, laid by hand -------------------------------------
  //
  // A salvo is the same shell out of the same gunnery as a test shot, fired from
  // the real muzzles along the real barrels. What is different is where the
  // aiming came from: not a crosshair on the screen but a fifteen-hundred-tonne
  // gunhouse that has been trained round at ten degrees a second and is pointing
  // where it is pointing.
  const _muz = new Vector3();
  const _gun = new Vector3();
  const _spin = new Quaternion();
  const _axis = new Vector3();

  // Is a shell still inside the ship that fired it? Stated against her own
  // collision bounds rather than a distance, because 45 m is clear of the bow
  // from A turret and nowhere near it from Y.
  const _shellLocal = new Vector3();
  function insideShip(worldPos) {
    _shellLocal.copy(worldPos);
    ship.group.worldToLocal(_shellLocal);
    const b = battleship.colliders.bounds;
    const M = 8;
    return _shellLocal.x > b.min.x - M && _shellLocal.x < b.max.x + M
      && _shellLocal.y > b.min.y - M && _shellLocal.y < b.max.y + M
      && _shellLocal.z > b.min.z - M && _shellLocal.z < b.max.z + M;
  }

  function fireSalvo(station) {
    ship.group.updateMatrixWorld(true);
    for (const g of station.mount.guns) {
      // The gun going off: the flash at the muzzle, the smoke, the recoil, and
      // the light all of that throws back on her. It hands back where the shell
      // leaves from and along what line — see battleship/muzzleBlast.js.
      const shot = battleship.fireGun(station.mount, g);
      if (!shot) continue;
      _muz.copy(shot.muzzle);
      _gun.copy(shot.dir);
      // She feels it, and she feels it *where the gun is*. The shove is the
      // round's momentum plus its propellant gas — see SHELL.momentum — straight
      // back down the bore, landed on the hull at the muzzle. Everything that
      // makes one gun's recoil different from another's then falls out of the
      // geometry rather than being written down: B turret is four metres higher
      // than A and heels her harder for it, a gun laid at thirty degrees puts
      // most of its shove down through her instead of across her, and firing
      // fore-and-aft rolls her hardly at all.
      //
      // Before the dispersion below, deliberately. The spread is where the
      // *shell* went; the gun pushed back down its own bore either way.
      _recoil.copy(shot.dir).multiplyScalar(-SHELL.momentum);
      ship.impulseAt(_recoil, shot.muzzle);
      // Dispersion. Two guns in one gunhouse are cross-coupled through the
      // structure and never land in the same place; a shared aim point with no
      // spread reads as one gun fired twice.
      _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      _spin.setFromAxisAngle(_axis, MathUtils.degToRad(LAYING.spread) * (Math.random() - 0.5) * 2);
      _gun.applyQuaternion(_spin).normalize();
      gunnery.fire(_muz, _gun, {
        owner: ship.group,
        clearOf: insideShip,
        // A shell leaves a ship making twenty knots with those twenty knots
        // already in it, which across the line of fire is metres at any range.
        inherit: ship.velocity,
      });
    }
  }

  // --- and her stern mounting, a round at a time -------------------------------
  //
  // The same gunnery again, and the third thing it has had to carry: not a salvo
  // out of a gunhouse but one round out of one barrel, called eight or nine times
  // a second for as long as the trigger is held. What makes it a different weapon
  // rather than a fast turret is entirely in the round — see AA_ROUND in
  // ballistics.js — and in the dispersion, which is wide on purpose. An automatic
  // is not aimed at an aeroplane, it is aimed at the piece of sky the aeroplane is
  // going to be in, and a gun that put every round through the same hole would be
  // useless at that.
  let aaRound = 0; // which round of the burst this is, for the smoke
  function fireAARound(station, gun) {
    ship.group.updateMatrixWorld(true);
    const A = station.mount.automatic;
    aaRound += 1;
    // Which side of the cradle this barrel is on. It decides which way the empty
    // case is thrown and which way the mounting is shoved, and it is read off the
    // barrel itself rather than passed in — the gun knows where it is.
    const side = Math.sign(gun.barrel.position.x) || 1;
    const shot = battleship.fireGun(station.mount, gun, {
      recoil: A.recoilScale,
      // The recuperator runs the gun out again before the next round leaves it,
      // which is what an automatic *is*; at the main battery's two and a half
      // seconds the barrels would walk back into the cradle and stay there.
      runIn: A.recoilIn,
      runOut: A.recoilOut,
      // and the flash is over before the next one starts, which is what makes
      // four barrels read as four barrels taking turns
      life: A.flashLife,
      lightLife: A.lightLife,
      // and the soft half of it cut down — see the note on `discScale` in
      // spec.js. Standing eight metres from the muzzles, the blast disc at a
      // naval rifle's proportions is a red veil across the whole quarterdeck.
      discScale: A.discScale,
      ballScale: A.ballScale,
      // A wisp per round and the full cloud every sixth, so a long burst leaves
      // something drifting downwind without every round contributing a lungful.
      // See the note on `smokePuff` in spec.js.
      smokeScale: aaRound % A.smokePuff === 0 ? 1.1 : A.smokeScale,
      // and the empty, out of the breech and onto the tub floor
      eject: { side, floor: A.caseFloor, speed: A.caseSpeed },
    });
    if (!shot) return;
    // The mounting answers. Up on the elevation spring every round, and across
    // on the training one in whichever direction this barrel sits — so the four
    // of them firing in turn walk the couple from one side to the other and the
    // whole machine waggles rather than simply nodding. See SHUDDER in mounts.js.
    station.mount.shove(A.shudderRise, side * A.shudderSwing);
    _muz.copy(shot.muzzle);
    _gun.copy(shot.dir);
    _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    _spin.setFromAxisAngle(
      _axis,
      MathUtils.degToRad(A.spread) * (Math.random() - 0.5) * 2,
    );
    _gun.applyQuaternion(_spin).normalize();
    gunnery.fire(_muz, _gun, {
      owner: ship.group,
      clearOf: insideShip,
      inherit: ship.velocity,
      proj: AA_ROUND,
    });
    // What she feels, which is almost nothing — a round of this weighs less than
    // a bag of cement and she is 42,000 tonnes. But it is *continuous*, and a
    // deck that hums while the after gun is firing is worth the two lines. Same
    // door as the main battery, so the mounting's height and train do the work.
    _recoil.copy(shot.dir).multiplyScalar(-AA_ROUND.momentum);
    ship.impulseAt(_recoil, shot.muzzle);
  }

  // --- and a person, on her deck ----------------------------------------------
  //
  // Walking around on a ship that is pitching and rolling is not a character-
  // controller tuning problem, it is a coordinate-space one: the failure mode is
  // collision against a *moving* collider. So the player is simulated in a space
  // where the ship does not move — against the very colliders above, which are
  // already in her frame and already static — and her real motion is fed back in
  // as inertial forces. See src/player/shipSpace.js.
  //
  // She walks on the ship's own colliders — `battleship.colliders`, the fuller
  // of the two, with the pagoda's levels and the mainmast's platforms in it and
  // resting wreckage added to it as it settles — rather than on a second
  // description of the ship. A turret that has trained out from under you, a
  // funnel that has been shot away and a length of mast lying across the deck
  // are all the same for the player as for anything else, because there is only
  // one answer to where the ship is.
  // --- the man, his rifle, and the noise it makes --------------------------------
  //
  // Three authored assets and the two things built out of them, loaded here
  // rather than inside the first-person code for one reason: every one of them
  // can fail — a file that is not there, a loader that throws, a rig that comes
  // back under different names — and a game that stops because a texture 404'd
  // is a worse game than one with a capsule on the deck. `loadPlayerModels`
  // never rejects; it returns nulls and says why in the console, and everything
  // downstream of it treats a null as an ordinary answer.
  //
  // Awaited, and it is worth being clear about what that costs: about four
  // hundred kilobytes off the local disk, on a page that has already compiled a
  // WebGPU FFT and built a battleship out of primitives.
  const models = await loadPlayerModels();

  // One program for everything in this scene that is not the ship, the sea or
  // the sky: the man and the weapon in his hands. It reads the same sun, the
  // same sky and the same water her plating does, plus her lamps, her guns'
  // flashes and the torch — see player/figureMaterial.js for why it cannot
  // simply be her own material.
  const figureMaterial = createFigureMaterial({
    shading,
    sunShadow: deckShadow,
    lamps: battleship.materials.lamps ?? null,
    flashes: battleship.materials.flashes ?? null,
    torch: battleship.materials.torch,
  });

  // Sound. See util/sound.js: it is fetched and decoded now and does not make a
  // noise until the player has done something, which a browser insists on.
  const sounds = createSoundBank({
    shot: '/audio/gun/shot.mp3',
    reload: '/audio/gun/reload.mp3',
    charge: '/audio/gun/charge.mp3',
    bolt: '/audio/gun/bolt.mp3',
    // Three recordings of a sea, not four: the pack ships Waves4 as a
    // byte-identical copy of Waves1. Matched to each other in level on the way
    // in — see the note in util/sound.js about why a crossfade between beds of
    // different loudness is worse than no crossfade at all.
    sea1: '/audio/sea/waves1.mp3',
    sea2: '/audio/sea/waves2.mp3',
    sea3: '/audio/sea/waves3.mp3',
  });
  sounds.load();

  // The sea, under everything, always. Two chains crossfading between three
  // twelve-second recordings — see `ambience` in util/sound.js for why that is
  // not just a looping buffer.
  // `gain` is the one knob for how loud the sea is overall — the recordings are
  // matched to -28 LUFS on the way in, so this is the only thing above them.
  const seaBed = sounds.ambience(['sea1', 'sea2', 'sea3'], { gain: 1.5, fade: 3 });

  // How loud it is from wherever the eye happens to be. Three things move it,
  // and all three are things you can see out of the window:
  //
  //   - how big a sea is running, which is the wind;
  //   - how far above it you are, which only really bites in fly mode — at deck
  //     height it is worth a couple of per cent, and it should be;
  //   - whether there is a ship between you and it. In a gunhouse or at the
  //     wheel you are inside a steel box, and the sea goes a long way off.
  const SEA_AUDIO = {
    calm: 0.20, // level in a flat calm...
    gale: 0.90, // ...and at the top of the wind slider
    wind: [2, 22], // m/s the two above correspond to
    height: 130, // m above the sea at which it is down to half
    indoors: 0.30, // what is left of it inside her
    duck: 2.2, // 1/s the indoor change moves at — a hatch closing, not a fader
  };
  let seaIndoor = 1;
  function seaLevel(dt) {
    const w = MathUtils.clamp(
      (params.local.windSpeed - SEA_AUDIO.wind[0]) / (SEA_AUDIO.wind[1] - SEA_AUDIO.wind[0]), 0, 1,
    );
    const h = Math.max(0, camera.position.y - shipSea.height);
    const shut = firstPerson.active && (firstPerson.inside || firstPerson.conning);
    const want = shut ? SEA_AUDIO.indoors : 1;
    seaIndoor += (want - seaIndoor) * Math.min(1, SEA_AUDIO.duck * dt);
    return (SEA_AUDIO.calm + (SEA_AUDIO.gale - SEA_AUDIO.calm) * w)
      * seaIndoor
      / (1 + (h / SEA_AUDIO.height) ** 2);
  }

  // A browser will not start an AudioContext until the user has done something.
  // Going aboard used to be that something, which meant the sea — which plays
  // from the sea view as well — stayed silent until you took a gun. Any gesture
  // at all will do, so the first one is taken.
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    addEventListener(ev, () => sounds.unlock(), { once: true, passive: true });
  }

  const firstPerson = createFirstPerson({
    camera,
    controls,
    element: renderer.domElement,
    body: ship,
    colliders: battleship.colliders,
    hull: battleship.hull,
    materials: battleship.materials,
    // the guns train, and the blockout that keeps a person out of their breech
    // has to train with them — and stop existing when a turret is shot away
    mounts: battleship.mounts,
    alive: (id) => battleship.damage.alive(id),
    onFire: () => fireFromEye(),
    // The three main-battery turrets, each of which is a room you can walk into
    // and a gun you can lay. See player/turretStation.js.
    turrets: TURRETS,
    damage: battleship.damage,
    onSalvo: fireSalvo,
    // The stern mounting: an automatic with a seat on it rather than a room, and
    // a trigger that is held rather than pressed. See player/aaStation.js.
    sternAA: STERN_AA.id,
    onRound: fireAARound,
    shellFor: () => SHELL,
    // And her wheelhouse: the pagoda's second level is a room with the wheel in it
    // and clear glass all the way round, reached by the ladder trunk up her
    // starboard side. Taking the wheel is the same gesture as taking a gun — walk
    // up to it and press E — and while you have it, WASD is her helm and the mouse
    // is only your head. See battleship/wheelhouse.js and player/helmStation.js.
    conn: { wheelhouse: battleship.wheelhouse },
    // On the forecastle, forward of A turret, looking aft down the length of
    // her. The height is found by dropping onto whatever is under the mark.
    spawn: { position: new Vector3(0, 20, 66), heading: Math.PI },
    // The man and the rifle. All five may be null and the mode still works —
    // see the note where they are loaded, and the parameter block in
    // firstPerson.js.
    figure: models.soldier,
    weapon: models.rifle,
    figureMaterial,
    lights: battleship.materials.torch,
    sounds,
    shading,
    // What a round does where it lands, out of the ship's own fire-and-smoke
    // system rather than a second particle system for small arms.
    smoke: battleship.fx,
    shipGroup: ship.group,
  });

  // The battleship is the ship you are here to drive; the launch is kept in the
  // scene as the small-hull case the same solver has to keep handling.
  let helmTarget = ship; // which body WASD drives
  ship.position.set(0, 0, 0);
  boat.position.set(60, 1, -240);

  // Park the camera on the quarter of whichever hull has the helm. One function
  // for both the opening shot and the B-key swap, so the two can't drift apart:
  // the distance is a multiple of hull length, close enough that the ship is the
  // subject of the frame rather than a detail in a seascape.
  const CHASE = { ship: 210, boat: 34 };
  const frameHull = (v) => {
    const p = v.position;
    const back = v === ship ? CHASE.ship : CHASE.boat;
    controls.target.copy(p);
    camera.position.set(p.x, p.y + back * 0.32, p.z - back);
  };
  frameHull(ship);

  // WASD is the helm or it is your legs, never both. Nothing is rung down or
  // reset while you are on foot, and the ship holds whatever she was doing —
  // which is the point: you want to walk her deck while she is under way.
  //
  // With one exception, and it is the whole point of the wheelhouse: standing at
  // her wheel with your hands on it, WASD is the helm again. It is the *same* helm
  // — the same telegraph, the same wheel, the same handling model — because a
  // second copy of it that only worked from the bridge would be two ships. R is
  // held back, though: at the wheel it must not put her back on the origin, and on
  // foot it is the key that puts the player on his spawn mark.
  const onFoot = () => firstPerson.active && !firstPerson.conning;
  const helm = attachBoatControls(boat, { isActive: () => helmTarget === boat && !firstPerson.active });
  const shipHelm = attachBoatControls(ship, {
    isActive: () => helmTarget === ship && !onFoot(),
    canReset: () => helmTarget === ship && !firstPerson.active,
  });

  // debug views
  const debug = createDebugView();
  const spectrumMats = ocean.cascades.map((cc) => spectrumDebugMaterial(cc.h0, params.N, { exposure: 0.12 }));
  const heightHeatmap = spectrumDebugMaterial(ocean.cascades[0].DyDxz, params.N, { exposure: 0.5 });

  createGUI(params, {
    ocean, shading, updateSun, spray, boat, ship, contact: boatContact, battleship, renderer,
    setTimeOfDay,
  });

  // The fx switchboard is off by default — the bottom-left corner is for the two
  // buttons now. The toggles still exist and still drive the sim from their
  // defaults; poseidon.showFxPanel() puts the panel back for a bisection session.
  let fxPanel = null;
  const showFxPanel = () => (fxPanel ??= createFxPanel());

  // The shader-side terms are scaled by uniforms the panel writes directly; the
  // two particle systems have no shader term to scale, so they are hooked here.
  onFx('hullSpray', (on) => {
    sprayConfig.enabled = on;
    boat.spray.mesh.visible = on;
    // the same droplets, thrown by wreckage going into the sea
    battleship.splash.mesh.visible = on;
  });
  const clearPlumes = (on) => { if (!on) battleship.fx.clear(); };
  onFx('funnelSmoke', clearPlumes);
  onFx('fireSmoke', clearPlumes);

  // dev handle: lets the console poke at the sim without a rebuild
  globalThis.poseidon = {
    renderer, scene, camera, controls, ocean, boat, boatConfig, sprayConfig, helm, params,
    shading, contacts, boatContact, shipContact, sunLight, battleship, ship, setTimeOfDay,
    showFxPanel, collisions, launchDamage, cameraSolids, shipColliders,
    firstPerson, PLAYER, gunnery, hitMap,
  };

  let view = 'fft';
  let followBoat = true;
  // Which way the N key will take her next. Seeded from the time she actually
  // starts at rather than assumed: she opens at night now (see `timeOfDay` in
  // ocean/params.js), and a flag hard-coded to `false` would have offered to
  // turn on the night she was already in.
  let night = params.timeOfDay < 0.5;

  // swap the helm between the launch and the battleship, and put the camera
  // behind whichever hull you just took
  const swapHelm = () => {
    helmTarget = helmTarget === boat ? ship : boat;
    frameHull(helmTarget);
  };

  createNavButtons({
    onChangeBoat: swapHelm,
    onGoAboard: () => firstPerson.toggle(),
    // Straight into a turret with your hands on the gear. Press it again and you
    // are in the next one, which is the fastest way to check all four.
    // The forward turret specifically: it is the one that sits on the deck
    // rather than on a bandstand, so its room is up in the gunhouse and turns
    // with the guns — which is the case worth looking at.
    onFrontCannon: () => firstPerson.goToStation(firstPerson.stationById.get('turret.A')),
    onTestCannons: () => {
      const st = firstPerson.nextGun();
      if (st) hud.flash?.(`at the gear in ${st.id}`);
    },
    // Straight to the wheel. The climb is a door in her side, a hallway through the
    // pagoda's base and eleven metres of ladder, and when what you want is to drive
    // her from the bridge you should not have to make it every time.
    onTakeHelm: () => {
      if (firstPerson.goToHelm()) hud.flash?.('you have the wheel');
    },
  });

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'v') { firstPerson.toggle(); return; }
    if (k === 't') { firstPerson.nextGun(); return; }
    if (k === 'h') { firstPerson.goToHelm(); return; }
    if (k === 'n') { night = !night; setTimeOfDay(night ? 0 : 1); return; }
    // Everything below drives the ship or the debug views. On foot, none of it
    // should answer — WASD is your legs and R would put the helm back to zero
    // from three decks away.
    if (firstPerson.active) {
      if (k === 'e') {
        // The one hand-on-the-gear key: take the set of controls you are standing
        // at, or let go of the one you are holding. It does not care which kind of
        // gear it is — a gun's training handwheels or the ship's wheel.
        if (firstPerson.laying) firstPerson.leaveGun();
        else if (firstPerson.conning) firstPerson.leaveWheel();
        else if (firstPerson.near) firstPerson.takeControls(firstPerson.near);
      } else if (k === 'z') firstPerson.cycleMag();
      else if (k === 'g' && !firstPerson.laying && !firstPerson.conning) {
        firstPerson.player.state.fly = !firstPerson.player.state.fly;
      } else if (k === 'p' && !firstPerson.laying && !firstPerson.conning) {
        // The spawn mark, which used to be R. R is the magazine now, and of the
        // two a man on foot presses one of them a hundred times a session and
        // the other when he has walked into the sea.
        firstPerson.player.respawn();
      }
      // R, L and X are the rifle's — the magazine, the torch and the selector —
      // and they are answered in firstPerson.js, which is the only place that
      // knows whether the rifle is in his hands or a turret's handwheels are.
      return;
    }
    if (k === 'c') followBoat = !followBoat;
    else if (k === 'b') swapHelm();
    else if (k === 'r') {
      // The hull's own listener has already reset the physics; this puts back
      // what the physics does not own. The launch also goes back to her billet
      // out on the quarter — `reset()` drops her on the origin, which is now
      // inside the battleship rather than merely on top of her.
      if (helmTarget === boat) { launchDamage.repair(); boat.position.set(60, 1, -240); }
      else battleship.damage.repair();
    }
    else if (k === 'f') view = 'fft';
    else if (k === '1') view = 'spectrum0';
    else if (k === '2' && ocean.cascades[1]) view = 'spectrum1';
    else if (k === '3' && ocean.cascades[2]) view = 'spectrum2';
    else if (k === '5') view = 'height';
    else if (k === '=' || k === '+') ocean.lambda.value = Math.min(ocean.lambda.value + 0.1, 3);
    else if (k === '-' || k === '_') ocean.lambda.value = Math.max(ocean.lambda.value - 0.1, 0);
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // render loop + timing
  let elapsed = 0;
  let last = performance.now();
  let emaWall = 16.7;
  let hudAccum = 1;
  const follow = new Vector3();

  // An exception inside the animation callback stops three's loop dead and
  // leaves a frozen frame with no explanation, which is a miserable thing to
  // debug. Catch it, show it, and keep going.
  let loopError = null;
  renderer.setAnimationLoop(() => {
    try {
      frame();
    } catch (e) {
      if (String(e?.stack ?? e) !== loopError) {
        loopError = String(e?.stack ?? e);
        console.error('[poseidon] frame error', e);
        hud.error('frame error: ' + loopError);
      }
    }
  });

  function frame() {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt * params.timeScale;

    ocean.evolve(elapsed, dt * params.timeScale); // foam dissipation tracks time scale
    shading.time.value = elapsed;

    // The sea, which is the one thing that is making a noise whatever else is
    // happening. `step` schedules the next clip against the audio clock, so it
    // does not care how regularly it gets called.
    seaBed.level(seaLevel(dt));
    seaBed.step();

    // The boat runs on real time, not the wave clock — so `time scale = 0`
    // freezes the sea into a solid surface you can still drive over, which is
    // the most direct way to check the buoyancy against a known shape.
    const simDt = Math.min(dt, 0.05);
    const wd = MathUtils.degToRad(params.local.windDirection);
    // The spray wants a fraction of the true wind (droplets are heavy and only
    // partly carried); smoke is weightless by comparison and ends up moving
    // with the air, so it gets the whole of it.
    windVec.set(Math.cos(wd), 0, Math.sin(wd)).multiplyScalar(params.local.windSpeed * 0.3);
    trueWind.set(Math.cos(wd), 0, Math.sin(wd)).multiplyScalar(params.local.windSpeed);
    if (helmTarget === boat) helm(simDt); else shipHelm(simDt);
    boat.update(simDt);
    ship.update(simDt);
    // Both hulls have integrated and drawn themselves by now, so a contact
    // resolved here has to put the drawn transform back where the corrected body
    // is — otherwise the frame shows the overlap the solver just removed. Only
    // position moves; the rotation a collision imparts arrives through `angVel`
    // on the next step, where the solver owns it.
    collisions.update(simDt);
    boat.group.position.copy(boat.position);
    ship.group.position.copy(ship.position);
    launchDamage.update(simDt);
    shipSea.height = ship.state.waterY;
    shipSea.slopeX = ship.state.slopeX;
    shipSea.slopeZ = ship.state.slopeZ;
    shipSea.originX = ship.position.x;
    shipSea.originZ = ship.position.z;
    battleship.update(dt, {
      // signed, so the shafts turn astern when she backs down; the funnel smoke
      // gates on the acceleration it differences out of `velocity`, so she only
      // makes it while working up
      throttle: ship.input.throttle,
      velocity: ship.velocity,
      wind: trueWind,
      sea: shipSea,
      dcEffort: 1,
      funnelSmoke: fx.funnelSmoke.on,
      fires: fx.fireSmoke.on,
      // wreckage resting on her decks slides off when she rolls far enough
      heel: ship.heel,
      // and the rooms inside her are only drawn when the eye can see into one
      viewer: camera.position,
    });

    // The hull has drawn itself by now — position and the visual quaternion
    // both — which is what the ship-local space differences its motion out of.
    // On foot this writes the camera; off it, it keeps the avatar standing on
    // the deck and the derivatives continuous.
    firstPerson.update(simDt, now);

    // Shells stay in the air whether or not you are still standing on her deck.
    gunnery.update(simDt, {
      target: [ship.group, boat.group],
      seaHeight: shipSea.height,
      onHit: onShellHit,
      onMiss: onShellMiss,
      onBurst: onShellBurst,
      // A shell is in the air for seconds at a time and the air is moving.
      wind: trueWind,
      camera,
    });

    const followed = helmTarget;
    const aboard = firstPerson.active;
    if (followBoat && !aboard) {
      // orbit around whichever hull the helm is on: carry the camera along,
      // leave the user's orbit angle and zoom untouched
      follow.subVectors(followed.position, controls.target);
      controls.target.copy(followed.position);
      camera.position.add(follow);
    }
    recentreOcean(followBoat && !aboard ? followed.position.x : camera.position.x,
      followBoat && !aboard ? followed.position.z : camera.position.z);
    skyDome.position.copy(camera.position);
    boat.spray.setCamera(camera); // droplets are shaded as spheres facing the eye
    battleship.splash.setCamera(camera);
    boatContact.wakeSeconds = params.wakeLength;
    boatContact.sync(boat);
    shipContact.sync(ship);
    setShadowSpan(followed === ship ? 130 : 34);
    placeSun(followed.position.x, followed.position.z); // keep the shadow map on the conned ship
    // Skip the deck's shadow pass entirely once the sun is down — it shadows the
    // sun and nothing else — and halve its rate the rest of the time.
    deckShadowFrame++;
    deckLight.shadow.needsUpdate = shading.night.value < 0.75
      && deckShadowFrame % 3 === 0;

    if (spray) spray.update(dt, camera.position, windVec);
    // On foot the eye belongs to the character controller, which has already
    // placed it. The orbit controls would fight it for the position, and the
    // de-penetration that keeps a camera out of the ship would fire every frame
    // on an eye that is legitimately standing inside her.
    if (!aboard) {
      controls.update();
      // Last word on where the eye is, after the controls and the follow have
      // both had theirs, and before anything is drawn from it.
      if (cameraSolids.resolve()) skyDome.position.copy(camera.position);
    }

    if (view === 'fft') {
      renderer.render(scene, camera);
    } else {
      debug.mesh.material =
        view === 'spectrum0' ? spectrumMats[0]
          : view === 'spectrum1' ? spectrumMats[1]
            : view === 'spectrum2' ? spectrumMats[2]
              : heightHeatmap;
      renderer.render(debug.scene, debug.camera);
    }

    emaWall = emaWall * 0.9 + dt * 1000 * 0.1;
    hudAccum += dt;
    if (hudAccum >= 0.25 && firstPerson.laying && firstPerson.laying.kind === 'aa') {
      hudAccum = 0;
      // At the stern mounting the corner says the two things the ring sight
      // cannot: what the machine is doing, and what the cut-out cam is refusing
      // to let it do. The second is the one that would otherwise look like a
      // bug — a gun that will not come down when you push the mouse forward.
      const g = firstPerson.laying;
      const r = g.readout();
      const cam = r.floor > STERN_AA.elevMin + 0.05;
      hud.set(
        `${(1000 / emaWall).toFixed(0)} fps\n`
        + `${g.id} · trained ${g.mount.yaw.toFixed(0)}° (asked ${g.lay.demandYaw.toFixed(0)}°) · `
        + `elevation ${g.mount.elev.toFixed(0)}°${cam ? ` (cut-out floor ${r.floor.toFixed(0)}°)` : ''}\n`
        + `${r.rounds}/${r.clip} rounds${r.reload > 0 ? ` · refilling ${r.reload.toFixed(1)}s` : ''} · `
        + `barrels ${(r.heat * 100).toFixed(0)}%${r.ceased ? ' — CEASED FIRE' : ''} · `
        + `${gunnery.count} in the air · ${ship.heel.toFixed(0)}° of heel\n`
        + 'MOUSE = lay · HOLD CLICK = fire · E or ESC = leave the gun',
      );
    } else if (hudAccum >= 0.25 && firstPerson.laying) {
      hudAccum = 0;
      // At the gun the sight carries its own instruments, so the corner is left
      // to what the sight cannot show you: what the mount is actually doing.
      const g = firstPerson.laying;
      hud.set(
        `${(1000 / emaWall).toFixed(0)} fps\n`
        + `${g.id} · trained ${g.mount.yaw.toFixed(1)}° (asked ${g.lay.demandYaw.toFixed(1)}°) · `
        + `elevation ${g.mount.elev.toFixed(1)}° (asked ${g.lay.demandElev.toFixed(1)}°)\n`
        + `${Math.abs(g.lay.trainRate) > 0.05 ? `training ${g.lay.trainRate.toFixed(1)}°/s` : 'steady'} · `
        + `${g.lay.reload > 0 ? `reloading ${g.lay.reload.toFixed(1)}s` : 'ready'} · `
        + `${firstPerson.magnification} · ${ship.heel.toFixed(0)}° of heel`,
      );
    } else if (hudAccum >= 0.25 && firstPerson.conning) {
      hudAccum = 0;
      // At the wheel the corner is a helmsman's: what was rung down, what the
      // engine room has actually given you, where the rudder has got to, and the
      // heading it is producing. Nothing about where you are standing — you are
      // standing at the wheel.
      const r = firstPerson.conning.readout();
      const rud = Math.abs(r.rudder) < 0.5 ? 'amidships'
        : `${Math.abs(r.rudder).toFixed(0)}° ${r.rudder > 0 ? 'starboard' : 'port'}`;
      hud.set(
        `${(1000 / emaWall).toFixed(0)} fps\n` +
        `at the wheel · ${r.telegraph} (engines ${(r.ordered * 100).toFixed(0)}%) · ` +
        `${r.knots.toFixed(1)} kn\n` +
        `wheel ${rud} · heading ${r.heading.toFixed(0)}° · ` +
        `turn ${ship.turnRate.toFixed(1)}°/s · heel ${ship.heel.toFixed(0)}°\n` +
        `${battleship.damage.alive('bridge') ? '' : 'BRIDGE WRECKED · '}` +
        'W/S = telegraph · A/D = wheel · SPACE = stop · mouse = look round · ' +
        'E = let go of the wheel · V or ESC = back to the sea',
      );
    } else if (hudAccum >= 0.25 && aboard) {
      hudAccum = 0;
      // On foot the interesting numbers are different ones: where you are on
      // her in her own frame, and how much of her motion is reaching you.
      const p = firstPerson.player;
      const st = p.state;
      const s = firstPerson.space;
      hud.set(
        `${(1000 / emaWall).toFixed(0)} fps\n` +
        `on deck · frame ${(p.position.z / battleship.hull.length + 0.5).toFixed(2)} L · ` +
        `x ${p.position.x.toFixed(1)} m · ${p.position.y.toFixed(1)} m above the waterline\n` +
        `${st.climbing ? 'on the ladder'
          : st.grounded ? `standing on ${st.standingOn ?? 'the deck'}` : 'in the air'} · ` +
        `deck tilt ${(Math.asin(Math.min(st.tilt, 1)) * 180 / Math.PI).toFixed(1)}° · ` +
        `heel ${ship.heel.toFixed(0)}° · ${ship.knots.toFixed(1)} kn · ` +
        `hull ${(s.hullOmega.length() * 180 / Math.PI).toFixed(1)}°/s\n` +
        `${st.grounded ? `${p.speed.toFixed(1)} m/s` : 'falling'} · ` +
        `${st.crouch > 0.05 ? `crouched${st.pinned ? ' (no room to stand)' : ''} · ` : ''}` +
        `loaded ${SHELL.key} (${SHELL.name})${gunnery.count ? ` · ${gunnery.count} in the air` : ''}` +
        `${st.fly ? ' · FLYING' : ''}${st.overboard ? ` · overboard ${st.overboard}x` : ''}\n` +
        // The rifle, when there is one. The count and the selector are on the
        // reticle where the eye already is; what belongs up here is the state of
        // the *asset*, because a capsule with no gun and a man with one look
        // exactly like a bug and a feature respectively.
        `${firstPerson.rifle
          ? `M16 · ${firstPerson.rifle.rounds}/${firstPerson.rifle.capacity} · `
            + `${firstPerson.rifle.mode}${firstPerson.rifle.torch ? ' · TORCH' : ''}`
            + `${firstPerson.modelled ? '' : ' · (no figure — model did not load)'}\n`
          : 'no rifle — the model did not load\n'}` +
        `${firstPerson.inside ? `inside ${firstPerson.inside.id} · trained ${firstPerson.inside.mount.yaw.toFixed(0)}°` : ''}` +
        `${firstPerson.near
          ? `  [ E or CLICK — take the ${firstPerson.near.kind === 'helm' ? 'wheel' : 'gun'} ]`
          : ''}` +
        `${st.climbing ? '  [ W — up the ladder, S — down ]' : ''}\n` +
        'WASD = walk · SHIFT = run · SPACE = jump · CTRL = crouch · ' +
        'CLICK = fire · RIGHT-CLICK = sights · R = reload · X = auto/semi · L = torch\n' +
        `P = spawn mark · G = fly · H = the wheel · N = ${night ? 'day' : 'night'} · V or ESC = back to the sea`,
      );
    } else if (hudAccum >= 0.25) {
      hudAccum = 0;
      // report whichever hull the helm is actually on
      const v = helmTarget;
      const isShip = v === ship;
      const motion = v.knots >= 0.25 ? 'UNDER WAY' : 'STOPPED';
      const helmTxt = Math.abs(v.state.helm) < 0.5 ? 'amidships'
        : `${Math.abs(v.state.helm).toFixed(0)}° ${v.state.helm > 0 ? 'stbd' : 'port'}`;
      // On a telegraph, what you rang for and what the engine room has actually
      // given you are two different numbers, and the gap between them is most
      // of what the model is for — so show both.
      const engineTxt = v.telegraph
        ? `${v.telegraph.label} (${(v.handling.state.throttle * 100).toFixed(0)}%)`
        : `throttle ${(v.input.throttle * 100).toFixed(0)}%`;
      const cap = battleship.damage.capability;
      const shipLine = isShip
        ? `guns ${cap.mainBattery}/${TURRETS.length} main · ${cap.aa}/${AA_MOUNTS.length + 1} AA · `
        + `helm ${(cap.helm * 100).toFixed(0)}% · ` +
          `power ${(cap.propulsion * 100).toFixed(0)}% · flooding ${(battleship.state.flood * 100).toFixed(0)}%` +
          `${battleship.state.burning > 0.05 ? ` · ON FIRE (${battleship.state.burning.toFixed(1)})` : ''}` +
          `${battleship.state.sinking ? ' · SINKING' : ''}\n`
        : `hull ${(launchDamage.integrity * 100).toFixed(0)}% · ` +
          `helm ${(launchDamage.capability.helm * 100).toFixed(0)}% · ` +
          `power ${(launchDamage.capability.propulsion * 100).toFixed(0)}% · ` +
          `flooding ${(launchDamage.state.flood * 100).toFixed(0)}%` +
          `${launchDamage.state.flood > 0.5 ? ' · SINKING' : ''} · ` +
          `${boat.spray.aliveCount} droplets\n`;
      hud.set(
        `${(1000 / emaWall).toFixed(0)} fps\n` +
        `${isShip ? 'battleship' : 'launch'}: ${motion} · ${v.knots.toFixed(1)} kn · hdg ${((v.heading + 360) % 360).toFixed(0)}° · ` +
        `${engineTxt} · helm ${helmTxt}\n` +
        `turn ${v.turnRate.toFixed(1)}°/s · drift ${v.state.drift.toFixed(1)}° · ` +
        `heel ${v.heel.toFixed(0)}° · trim ${v.trim.toFixed(0)}° · ` +
        `draft ${v.state.submerged.toFixed(2)} m · ${v.state.wet}/6 wet\n` +
        shipLine +
        `${v.telegraph ? 'W/S = telegraph · A/D = wheel · SPACE = stop' : 'WASD = helm'} · ` +
        `R = reset · C = ${followBoat ? 'unfollow' : 'follow'} · drag = orbit · ` +
        `N = ${night ? 'day' : 'night'} · V = go aboard`,
      );
    }
  }
}

main().catch((e) => hud.error(String(e?.stack ?? e)));
