import GUI from 'lil-gui';
import { applySpectrumParams } from './ocean/spectrum.js';
import { boatConfig } from './boat/Boat.js';
import { sprayConfig } from './boat/hullSpray.js';

// Live control panel. Sea-state changes (wind, amplitude, spread) rebuild the
// initial spectrum h0 on release; everything else just updates a uniform.
export function createGUI(params, {
  ocean, shading, updateSun, spray, boat, ship, contact, battleship, renderer, setTimeOfDay,
}) {
  const gui = new GUI({ title: 'Ocean controls' });

  const recompute = () => {
    applySpectrumParams(ocean.shared, params);
    ocean.updateInitialSpectrum();
  };

  const sea = gui.addFolder('Sea state');
  sea.add(params.local, 'windSpeed', 0, 30, 0.5).name('wind speed (m/s)').onFinishChange(recompute);
  sea.add(params.local, 'windDirection', 0, 360, 1).name('wind direction').onFinishChange(recompute);
  sea.add(params.local, 'scale', 0, 2, 0.02).name('amplitude').onFinishChange(recompute);
  sea.add(params.local, 'spreadBlend', 0, 1, 0.02).name('directionality').onFinishChange(recompute);
  sea.add(params, 'lambda', 0, 2.5, 0.02).name('choppiness').onChange((v) => { ocean.lambda.value = v; });
  sea.add(params, 'timeScale', 0, 3, 0.05).name('time scale');

  const foam = gui.addFolder('Foam');
  foam.add(params, 'foamThreshold', -0.5, 1.5, 0.02).name('threshold').onChange((v) => { shading.foamThreshold.value = v; });
  foam.add(params, 'foamScale', 0.2, 8, 0.1).name('coverage').onChange((v) => { shading.foamScale.value = v; });
  foam.add(params, 'foamDecay', 0.02, 1, 0.01).name('decay (low = lingers)').onChange((v) => { ocean.foamDecay.value = v; });
  if (contact) {
    foam.add(params, 'contactFoam', 0, 2, 0.05).name('foam at the hull').onChange((v) => { contact.strength.value = v; });
    foam.add(params, 'contactFoamWidth', 0.1, 6, 0.1).name('hull foam width (m)').onChange((v) => { contact.width.value = v; });
    foam.add(params, 'wakeLength', 0, 8, 0.1).name('wake trail (s of headway)');
  }

  const metal = gui.addFolder('Hull metal');
  metal.add(params.hull, 'metalness', 0, 1, 0.02).name('steel through the paint')
    .onChange((v) => { shading.metalness.value = v; });
  metal.add(params.hull, 'anisotropy', 0, 0.95, 0.02).name('plating grain')
    .onChange((v) => { shading.anisotropy.value = v; });
  metal.add(params.hull, 'dispersion', 0, 0.4, 0.01).name('sun dispersion')
    .onChange((v) => { shading.dispersion.value = v; });

  const surf = gui.addFolder('Surface');
  surf.add(params, 'detailStrength', 0, 0.5, 0.01).name('detail noise').onChange((v) => { shading.detail.value = v; });
  surf.add(params, 'sssStrength', 0, 3, 0.05).name('subsurface').onChange((v) => { shading.sssStrength.value = v; });

  // The frame-rate knob. This scene is fragment-bound — the sea is a long shader
  // over the whole screen — so time spent is close to linear in pixels drawn,
  // and this is the only control here that moves it by a factor rather than a
  // few percent. It reallocates every render target, so it is applied on release
  // rather than while the slider is moving.
  if (renderer) {
    const perf = gui.addFolder('Performance');
    perf.add(params, 'renderScale', 0.5, 2, 0.25).name('render scale')
      .onFinishChange((v) => {
        renderer.setPixelRatio(Math.min(devicePixelRatio, v));
        renderer.setSize(innerWidth, innerHeight);
      });
  }

  if (boat) {
    const b = gui.addFolder('Boat');
    b.add(boatConfig, 'mass', 15000, 120000, 500).name('mass (kg)');
    b.add(boatConfig, 'probeArea', 4, 30, 0.5).name('waterplane / probe');
    b.add(boatConfig, 'heaveDamp', 0, 80000, 500).name('heave damping');
    b.add(boatConfig, 'slopePush', 0, 2, 0.05).name('wave-face push');
    b.add(boatConfig, 'thrust', 0, 500000, 5000).name('engine (N)');
    b.add(boatConfig, 'dragFwd', 200, 4000, 25).name('surge drag');

    const turn = b.addFolder('Turning');
    turn.add(boatConfig, 'rudderArea', 0.05, 2.5, 0.05).name('rudder area (m²)');
    turn.add(boatConfig, 'maxHelm', 5, 50, 1).name('max helm (°)');
    turn.add(boatConfig, 'helmRate', 3, 90, 1).name('helm rate (°/s)');
    turn.add(boatConfig, 'propWash', 0, 1.2, 0.05).name('prop wash on rudder');
    turn.add(boatConfig, 'lateralArea', 3, 40, 0.5).name('lateral area (m²)');
    turn.add(boatConfig, 'lateralCd', 0.2, 2.5, 0.05).name('crossflow drag');
    turn.add(boatConfig, 'hullLift', 0, 3, 0.05).name('hull grip (0 = skids)');

    const roll = b.addFolder('Heel & roll');
    roll.add(boatConfig, 'bankIn', 0, 4, 0.05).name('bank in (0 = leans out)');
    roll.add(boatConfig, 'clrDepth', 0, 3, 0.05).name('lateral force depth (m)');
    roll.add(boatConfig, 'rollDamp', 0, 6000000, 50000).name('roll damping');
    roll.add(boatConfig, 'angDamp', 0, 2, 0.05).name('angular damping');

    const sp = b.addFolder('Spray');
    sp.add(sprayConfig, 'enabled').name('hull spray');
    sp.add(sprayConfig, 'slamThreshold', 0.1, 4, 0.05).name('slam threshold (m/s)');
    sp.add(sprayConfig, 'slamJet', 0.5, 5, 0.1).name('slam jet speed');
    sp.add(sprayConfig, 'slamRate', 0, 1000, 5).name('slam amount');
    sp.add(sprayConfig, 'bowThreshold', 0, 8, 0.1).name('bow threshold (m/s)');
    sp.add(sprayConfig, 'bowSpeed', 0, 1.5, 0.05).name('bow throw speed');
    sp.add(sprayConfig, 'bowRate', 0, 600, 2).name('bow amount');
    sp.add(sprayConfig, 'size', 0.01, 1.2, 0.005).name('droplet size');
    sp.add(sprayConfig, 'sizeTail', 0, 8, 0.1).name('big-gobbet tail');
    sp.add(sprayConfig, 'grow', 0, 1.5, 0.05).name('swell rate');
    sp.add(sprayConfig, 'life', 0.2, 3, 0.05).name('droplet life (s)');
    sp.add(sprayConfig, 'opacity', 0.02, 1, 0.02).name('opacity')
      .onChange((v) => { boat.spray.opacity.value = v; });
    sp.add(sprayConfig, 'aeration', 0, 1, 0.02).name('aeration (0 = sea colour)')
      .onChange((v) => { boat.spray.aeration.value = v; });
    sp.add(sprayConfig, 'settle', 0.05, 1.5, 0.05).name('settle time (s)');
    sp.add(sprayConfig, 'drag', 0.2, 6, 0.1).name('air drag');
    sp.add(sprayConfig, 'windCarry', 0, 1.5, 0.05).name('blown by wind');

    b.add({ reset: () => boat.reset() }, 'reset').name('reset boat (R)');
  }

  if (ship?.handling) {
    const h = ship.handling;
    const hc = h.config;
    const hf = gui.addFolder('Ship handling');
    // The one number worth watching while you tune: a real capital ship comes
    // round in four to five hull lengths, and it is very easy to make her turn
    // like a launch without noticing until she is on the water.
    const circle = { text: '' };
    const refresh = () => { circle.text = `${h.turnDiameter.toFixed(0)} m · ${h.turnLengths.toFixed(1)} hull lengths`; };
    refresh();
    hf.add(circle, 'text').name('turning circle').listen().disable();
    const watch = (o, k, lo, hi, stepSize, label) =>
      hf.add(o, k, lo, hi, stepSize).name(label).onChange(refresh);

    watch(hc, 'maxSpeedAhead', 4, 30, 0.5, 'top speed ahead (m/s)');
    hf.add(hc, 'maxSpeedAstern', 1, 12, 0.5).name('top speed astern (m/s)');
    hf.add(hc, 'accelTime', 4, 90, 1).name('stop → full (s)');
    hf.add(hc, 'brakeMultiplier', 1, 5, 0.1).name('astern bite');
    hf.add(hc, 'engineSpool', 0.2, 10, 0.1).name('engine-room lag (s)');
    watch(hc, 'maxRudder', 5, 45, 1, 'rudder hard over (°)');
    hf.add(hc, 'rudderSlew', 1, 30, 0.5).name('rudder slew (°/s)');
    watch(hc, 'rudderPower', 0.01, 0.6, 0.005, 'rudder power');
    hf.add(hc, 'rudderRefSpeed', 2, 25, 0.5).name('rudder full effect at (m/s)');
    watch(hc, 'yawDamping', 0.2, 6, 0.05, 'yaw damping');
    hf.add(hc, 'lateralGrip', 0.2, 10, 0.1).name('grip (low = driftier)');
    hf.add(hc, 'pivotOffset', 0, 120, 1).name('pivot ahead of CoM (m)');
    watch(hc, 'turnSpeedBleed', 0, 0.8, 0.01, 'speed lost in a turn');
    hf.add(hc, 'maxHeel', 0, 20, 0.5).name('outward lean (°)');
    hf.add(hc, 'heelResponse', 0.2, 8, 0.1).name('lean response');
  }

  if (battleship) {
    const bs = gui.addFolder('Battleship').close();
    // Aiming: bearing is in the ship's frame, 0 ahead and + to starboard, so
    // sweeping it shows exactly where each turret's blind zone starts.
    const aim = { bearing: 0, elevation: 10 };
    const retrain = () => {
      for (const m of battleship.turrets) m.setTarget(aim.bearing, aim.elevation);
      for (const m of battleship.aaMounts) m.setTarget(aim.bearing, Math.max(aim.elevation, 20));
    };
    const g = bs.addFolder('Gunnery');
    g.add(aim, 'bearing', -180, 180, 1).name('target bearing (deg)').onChange(retrain);
    g.add(aim, 'elevation', -5, 85, 1).name('elevation (deg)').onChange(retrain);
    g.add({ centre: () => { aim.bearing = 0; aim.elevation = 0; retrain(); } }, 'centre').name('stow all guns');

    // Damage: every destructible component, so the consequences of losing each
    // one can be seen before any shell exists to cause it.
    const d = bs.addFolder('Damage');
    const ids = [...battleship.damage.components.keys()];
    const target = { id: ids[0], amount: 120, fire: 0.6, breach: 0.5 };
    d.add(target, 'id', ids).name('component');
    d.add(target, 'amount', 10, 600, 10).name('damage');
    d.add(target, 'fire', 0, 1, 0.05).name('fire started');
    d.add(target, 'breach', 0, 1, 0.05).name('hull breached');
    d.add({
      hit: () => battleship.damage.hit(target.id, {
        damage: target.amount, pen: 20, fire: target.fire, breach: target.breach,
      }),
    }, 'hit').name('put a shell into it');
    d.add({
      broadside: () => {
        // a plunging salvo across the ship: several components at once
        for (const id of ['turret.B', 'bridge', 'hull.mid', 'funnel']) {
          battleship.damage.hit(id, { damage: 150, pen: 22, fire: 0.5, breach: 0.4 });
        }
      },
    }, 'broadside').name('take a salvo');
    d.add({
      flood: () => {
        for (const id of ['hull.bow', 'hull.fore']) {
          const c = battleship.damage.get(id);
          if (c) c.breach = 1;
        }
      },
    }, 'flood').name('torpedo forward');
    d.add({ repair: () => battleship.repair() }, 'repair').name('repair everything');

    // Guardrails: they come off with the hull section under them, but they are
    // also the thing a near miss takes away on its own, so there is a way to do
    // that to them directly.
    if (battleship.railings) {
      const r = bs.addFolder('Guardrails');
      const rail = {
        station: 0, // fraction of L, 0 amidships
        side: 'starboard',
        radius: 12,
        // read every frame by `.listen()`, so it also tracks rail lost to
        // shellfire on the hull sections rather than only to the button below
        get standing() {
          return `${battleship.railings.intact} / ${battleship.railings.bays} bays`;
        },
      };
      r.add(rail, 'standing').name('rail standing').listen().disable();
      r.add(rail, 'station', -0.48, 0.48, 0.01).name('station (0 = amidships)');
      r.add(rail, 'side', ['starboard', 'port']).name('side');
      r.add(rail, 'radius', 3, 40, 1).name('blast radius (m)');
      r.add({
        blast: () => battleship.railings.blastAt(
          rail.station, rail.side === 'port' ? 1 : -1, rail.radius,
        ),
      }, 'blast').name('put a shell through it');
      r.add({ restore: () => battleship.railings.restore() }, 'restore').name('rig it again');
    }
  }

  const sky = gui.addFolder('Sun & sky');
  if (setTimeOfDay) {
    const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());
    sky.add(params, 'timeOfDay', 0, 1, 0.01).name('time (0 night → 1 day)')
      .onChange((v) => { setTimeOfDay(v); refresh(); });
    const jump = {};
    for (const k of params.timeKeys) {
      jump[k.name] = () => { setTimeOfDay(k.at); refresh(); };
      sky.add(jump, k.name).name(k.name);
    }
  }
  sky.add(params, 'sunAzimuth', 0, 360, 1).name('sun azimuth').onChange(updateSun);
  sky.add(params, 'sunElevation', 0, 90, 1).name('sun elevation').onChange(updateSun);
  if (renderer) {
    sky.add(params, 'exposure', 0.3, 1.6, 0.02).name('exposure')
      .onChange((v) => { renderer.toneMappingExposure = v; });
  }

  if (spray) {
    const sp = gui.addFolder('Spray');
    sp.add(spray.uniforms.breakThreshold, 'value', 0, 1.2, 0.02).name('break threshold');
    sp.add(spray.uniforms.emitChance, 'value', 0, 1, 0.02).name('emit rate');
    sp.add(spray.uniforms.burst, 'value', 0, 14, 0.2).name('burst speed');
    sp.add(spray.uniforms.size, 'value', 0.1, 3, 0.05).name('droplet size');
    sp.add(spray.uniforms.opacity, 'value', 0, 1, 0.02).name('opacity');
    sp.add(spray.uniforms.emitRadius, 'value', 50, 400, 10).name('emit radius');
  }

  const col = gui.addFolder('Colors').close();
  const color = (key, uni) => col.addColor(params.colors, key).onChange(() => uni.value.setHex(params.colors[key]));
  color('deep', shading.deepColor);
  color('scatter', shading.scatterColor);
  color('foam', shading.foamColor);
  color('skyHorizon', shading.horizon);
  color('skyZenith', shading.zenith);

  return gui;
}
