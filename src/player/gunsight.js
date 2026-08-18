// The layer's sight.
//
// Everything here is DOM over the top of the canvas rather than geometry in
// front of the camera, for the same reason the HUD and the fx panel are: it is
// sharp at any resolution, it costs no draw calls, and a mask that has to line
// up with the middle of the screen is a much easier thing to write in SVG than
// in a shader.
//
// The shape is a pair of overlapping circles — what you actually see down a
// binocular sight is one field, not two, but it is bounded by two eyecups and
// the join between them is the whole reason a gunsight reads as a gunsight
// rather than as a vignette. The graticule is a plain cross: a fine horizontal
// wire and a vertical one, both stopping short of the middle so the mark is not
// hidden by them.
//
// The one moving part is the demand pip. The gun is slow — a battleship turret
// trains at ten degrees a second — so where you have asked it to point and where
// it is pointing are two different things for seconds at a time, and the gap
// between them is most of what makes laying a gun feel like laying a gun. The pip
// is where you asked. The cross is where the guns are.

const NS = 'http://www.w3.org/2000/svg';

// How long the eye takes to come back, and how it comes back. Deliberately much
// longer than the flash in the world: the flash is over in a third of a second
// and being dazzled by it is not.
const DAZZLE = { life: 1.35, falloff: 2.6 };

const CSS = `
#gunsight { position:fixed; inset:0; z-index:40; pointer-events:none; display:none;
  font:600 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; color:#dfe6ea;
  letter-spacing:.06em; }
#gunsight.on { display:block; }

/* The gun going off in your face.
 *
 * Two sixteen-inch guns fire a couple of metres from the sighting hood, and
 * what the eye does about that is stop working for a moment. The muzzle flash
 * itself is drawn in the world and is over in a third of a second; this is the
 * part that happens *behind* the eye, and it has to outlast the flash by a good
 * margin or it reads as a lamp rather than as being dazzled.
 *
 * Its own element rather than a filter on the scene: it must sit over the
 * graticule as well, because the wires are the first thing to come back out of
 * the white and that is most of what sells the recovery. Screen-blended, so it
 * washes the picture out rather than painting over it. */
#gunsight .dazzle { position:absolute; inset:0; opacity:0;
  background:radial-gradient(135% 105% at 50% 46%,
    #fffef9 0%, #fff4d8 28%, #ffd79a 60%, #f0a04a 100%); }
#gunsight svg { position:absolute; inset:0; width:100%; height:100%; }
#gunsight .plate { position:absolute; left:50%; transform:translateX(-50%);
  background:linear-gradient(#2a2f36,#171a1f); border:2px solid #6b5a34;
  border-radius:3px; box-shadow:0 2px 10px #0009, inset 0 1px 0 #ffffff18;
  text-align:center; }
#gunsight .range { top:1.2vh; padding:3px 22px 7px; }
#gunsight .range b { display:block; font-size:11px; letter-spacing:.22em; color:#c9ac68;
  text-shadow:0 1px 0 #000; }
#gunsight .range span { display:block; font-size:38px; line-height:1; margin-top:3px;
  color:#eef3f6; text-shadow:0 0 10px #9ecbff55; font-variant-numeric:tabular-nums; }
#gunsight .panel { bottom:1.2vh; padding:7px 16px 9px; display:flex; gap:26px; }
#gunsight .panel div { text-align:center; }
#gunsight .panel b { display:block; font-size:10px; letter-spacing:.16em; color:#c9ac68;
  margin-bottom:4px; }
#gunsight .panel i { display:block; font-style:normal; font-size:12px; opacity:.42; }
#gunsight .panel i.sel { opacity:1; color:#ffd479; text-shadow:0 0 8px #ffd47966; }
#gunsight .hint { position:absolute; left:50%; bottom:12vh; transform:translateX(-50%);
  font-size:11px; opacity:.55; letter-spacing:.1em; white-space:nowrap; }
#gunsight .load { position:absolute; left:50%; top:calc(50% + 12vh); transform:translateX(-50%);
  font-size:11px; letter-spacing:.14em; color:#ffb36b; }

/* --- the stern mounting -----------------------------------------------------
 *
 * A different instrument, because it is a different gun. There is no range
 * plate: an automatic firing a self-destructing round at two thousand metres is
 * not laid to a range, it is pointed. What the layer needs told instead is the
 * two things that decide whether he may go on pulling the trigger — how many
 * rounds are in the racks and how hot the barrels are — and the one thing that
 * decides whether the gun will answer at all, which is the cut-out. */
#gunsight.aa .range, #gunsight.aa .panel { display:none; }
#gunsight .aapanel { display:none; bottom:1.2vh; padding:7px 18px 9px; gap:24px;
  align-items:flex-end; }
#gunsight.aa .aapanel { display:flex; }
#gunsight .aapanel div { text-align:center; }
#gunsight .aapanel b { display:block; font-size:10px; letter-spacing:.16em; color:#c9ac68;
  margin-bottom:5px; }
#gunsight .aapanel i { display:block; font-style:normal; font-size:15px;
  font-variant-numeric:tabular-nums; }
#gunsight .heat { width:128px; height:9px; background:#0b0e12; border:1px solid #4a4034;
  position:relative; overflow:hidden; }
#gunsight .heat u { display:block; height:100%; width:0%; text-decoration:none;
  background:linear-gradient(90deg,#5fa9d8 0%,#e8c464 55%,#ff5f2a 100%); }
/* where the gun ceases fire, drawn on the gauge so the limit is a place rather
 * than a surprise */
#gunsight .heat s { position:absolute; top:0; bottom:0; width:1px; background:#ffffff66; }
#gunsight .warn { position:absolute; left:50%; top:calc(50% + 15vh); transform:translateX(-50%);
  font-size:12px; letter-spacing:.2em; color:#ff8a5c; text-shadow:0 0 10px #ff5a2a55;
  white-space:nowrap; }
`;

export function createGunsight() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const flash = { t: 1e3, mag: 0 };

  const root = document.createElement('div');
  root.id = 'gunsight';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  root.append(svg);

  // The mask. In an SVG mask white shows and black hides, so the rect is white —
  // the shade is drawn *everywhere* — and the eyecups are black, which is what
  // punches the view out of it. Getting this the wrong way round fills the
  // eyecups with ink and leaves you looking at the deck through the surround,
  // which is exactly as useless as it sounds.
  // Radii are in viewport height, so the sight is the same size whatever shape
  // the window is.
  const defs = document.createElementNS(NS, 'defs');
  const mask = document.createElementNS(NS, 'mask');
  mask.setAttribute('id', 'gs-eyecups');
  const white = document.createElementNS(NS, 'rect');
  white.setAttribute('fill', '#fff');
  const holes = [];
  for (let i = 0; i < 2; i++) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('fill', '#000');
    holes.push(c);
  }
  mask.append(white, ...holes);
  defs.append(mask);

  const shade = document.createElementNS(NS, 'rect');
  shade.setAttribute('fill', '#05070a');
  shade.setAttribute('mask', 'url(#gs-eyecups)');

  // The same shape the other way round, for everything that is *engraved on the
  // glass*: wires, ticks, the demand pip. Without it the graticule runs on past
  // the edge of the field and out across the eyecup, which is a thing no sight
  // has ever done — the wires are inside the tube.
  const fieldMask = document.createElementNS(NS, 'mask');
  fieldMask.setAttribute('id', 'gs-field');
  const fieldRect = document.createElementNS(NS, 'rect');
  fieldRect.setAttribute('fill', '#000');
  const fieldHoles = [0, 1].map(() => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('fill', '#fff');
    return c;
  });
  fieldMask.append(fieldRect, ...fieldHoles);
  defs.append(fieldMask);
  const graticule = document.createElementNS(NS, 'g');
  graticule.setAttribute('mask', 'url(#gs-field)');

  // The rubber round the inside of the eyecups.
  //
  // Two full circles will not do it. Where the eyecups overlap, each one's edge
  // runs straight across the middle of the other's field, and what you get is a
  // pair of rings drawn over the view like a Venn diagram — which is what the
  // sight looked like before this. What is actually wanted is the rim of the
  // *union*: the part of each circle's edge that is outside the other one.
  //
  // So each rim is clipped by a mask that hides it inside its neighbour. Two
  // masks, four lines, and the boundary comes out continuous the whole way round.
  const rimMasks = [0, 1].map((i) => {
    const m = document.createElementNS(NS, 'mask');
    m.setAttribute('id', `gs-outside-${i}`);
    const w = document.createElementNS(NS, 'rect');
    w.setAttribute('fill', '#fff');
    const other = document.createElementNS(NS, 'circle');
    other.setAttribute('fill', '#000');
    m.append(w, other);
    defs.append(m);
    return { mask: m, rect: w, other };
  });

  const rings = [0, 1].map((i) => {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('mask', `url(#gs-outside-${i})`);
    // a wide soft shadow and a hard lip inside it, which is what reads as rubber
    const soft = document.createElementNS(NS, 'circle');
    soft.setAttribute('fill', 'none');
    soft.setAttribute('stroke', '#05070a');
    soft.setAttribute('stroke-opacity', '0.30');
    const lip = document.createElementNS(NS, 'circle');
    lip.setAttribute('fill', 'none');
    lip.setAttribute('stroke', '#05070a');
    lip.setAttribute('stroke-opacity', '0.95');
    g.append(soft, lip);
    return { g, soft, lip };
  });

  const hair = ['h1', 'h2', 'v1', 'v2'].map(() => {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('stroke', '#0b0f13');
    l.setAttribute('stroke-width', '1.4');
    l.setAttribute('stroke-opacity', '0.8');
    return l;
  });
  // range ticks down the vertical wire
  const ticks = [];
  for (let i = 0; i < 10; i++) {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('stroke', '#0b0f13');
    l.setAttribute('stroke-width', '1.4');
    l.setAttribute('stroke-opacity', '0.7');
    ticks.push(l);
  }

  const pip = document.createElementNS(NS, 'g');
  const pipRing = document.createElementNS(NS, 'circle');
  pipRing.setAttribute('fill', 'none');
  pipRing.setAttribute('stroke', '#ff7a3c');
  pipRing.setAttribute('stroke-width', '1.8');
  pipRing.setAttribute('r', '7');
  const pipDot = document.createElementNS(NS, 'circle');
  pipDot.setAttribute('fill', '#ff7a3c');
  pipDot.setAttribute('r', '1.8');
  pip.append(pipRing, pipDot);

  // --- the ring sight ---------------------------------------------------------
  //
  // What is engraved on the stern mounting's sight, and it is not a cross. A
  // cross tells you where the gun is pointing, which is the wrong question for a
  // target that is crossing: what a ring sight tells you is *how far to aim in
  // front*, by giving you a set of radii that correspond to crossing speeds. You
  // put the aeroplane on the ring and fire where it is going.
  //
  // The radii are angular — degrees of half-angle, from AA_LAYING — so they are
  // sized against the field of view in `set` rather than against the window in
  // `layout`. That is the whole reason this is drawn rather than modelled: a
  // hoop of steel in front of the camera would be the right size at exactly one
  // field of view and the wrong size at every other.
  const reticle = document.createElementNS(NS, 'g');
  const aaRings = [0, 1].map((i) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', i ? '#0b0f13' : '#0b0f13');
    c.setAttribute('stroke-width', i ? '2.6' : '2.0');
    c.setAttribute('stroke-opacity', i ? '0.85' : '0.7');
    return c;
  });
  // Four short posts at the cardinals, which is what holds a real ring in its
  // mount and is also what stops a bare circle reading as a lens flare.
  const posts = [0, 1, 2, 3].map(() => {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('stroke', '#0b0f13');
    l.setAttribute('stroke-width', '2.4');
    l.setAttribute('stroke-opacity', '0.85');
    return l;
  });
  // and the bead in the middle: the gun's own line, open in the centre so it
  // does not hide the thing you are shooting at
  const bead = document.createElementNS(NS, 'circle');
  bead.setAttribute('fill', 'none');
  bead.setAttribute('stroke', '#0b0f13');
  bead.setAttribute('stroke-width', '2.2');
  bead.setAttribute('stroke-opacity', '0.9');
  reticle.append(...aaRings, ...posts, bead);

  graticule.append(...hair, ...ticks, pip);
  svg.append(defs, shade, ...rings.map((r) => r.g), reticle, graticule);

  const range = document.createElement('div');
  range.className = 'plate range';
  range.innerHTML = '<b>AIM DISTANCE</b><span>0</span>';
  const rangeValue = range.querySelector('span');

  const panel = document.createElement('div');
  panel.className = 'plate panel';
  panel.innerHTML = '<div><b>Turret</b><i class="t"></i></div>'
    + '<div><b>Shell</b><i class="s"></i></div>'
    + '<div><b>Magnification</b><i data-m="2">x36</i><i data-m="1">x12</i><i data-m="0">x1</i></div>';
  const turretLabel = panel.querySelector('.t');
  const shellLabel = panel.querySelector('.s');
  const mags = [...panel.querySelectorAll('[data-m]')];

  const aapanel = document.createElement('div');
  aapanel.className = 'plate aapanel';
  aapanel.innerHTML = '<div><b>Mounting</b><i class="m"></i></div>'
    + '<div><b>Rounds</b><i class="r"></i></div>'
    + '<div><b>Barrels</b><span class="heat"><u></u><s></s></span></div>'
    + '<div><b>Bearing</b><i class="b"></i></div>'
    + '<div><b>Elevation</b><i class="e"></i></div>';
  const aaMount = aapanel.querySelector('.m');
  const aaRounds = aapanel.querySelector('.r');
  const aaHeat = aapanel.querySelector('.heat u');
  const aaCease = aapanel.querySelector('.heat s');
  const aaBearing = aapanel.querySelector('.b');
  const aaElev = aapanel.querySelector('.e');

  const warn = document.createElement('div');
  warn.className = 'warn';

  const hint = document.createElement('div');
  hint.className = 'hint';
  const HINTS = {
    turret: 'MOUSE = lay · CLICK = fire · Z = magnification · E or ESC = leave the gun',
    aa: 'MOUSE = lay · HOLD CLICK = fire · watch the barrels · E or ESC = leave the gun',
  };
  hint.textContent = HINTS.turret;

  const load = document.createElement('div');
  load.className = 'load';

  // Over everything, including the graticule — see the note in the CSS.
  const dazzle = document.createElement('div');
  dazzle.className = 'dazzle';

  root.append(range, panel, aapanel, hint, load, warn, dazzle);
  document.body.append(root);

  let w = 0;
  let h = 0;
  // Which gun's sight is on the glass, and what field of view it is looking
  // through. The field matters because the ring sight's radii are angles: a
  // thirteen-degree ring is a different number of pixels in a fifty-eight degree
  // field than in a three-degree one, and the whole point of a ring is that the
  // lead it stands for does not change when the picture does.
  let mode = 'turret';
  let field = 55;

  // Everything that is one sight and not the other. Done by hiding rather than
  // by building two sights, because the pip, the dazzle and the plates are
  // common to both and there is nothing to be gained by having two of each.
  function applyMode() {
    const aa = mode === 'aa';
    root.classList.toggle('aa', aa);
    hint.textContent = HINTS[mode];
    shade.setAttribute('display', aa ? 'none' : 'inline');
    for (const r of rings) r.g.setAttribute('display', aa ? 'none' : 'inline');
    for (const l of hair) l.setAttribute('display', aa ? 'none' : 'inline');
    for (const l of ticks) l.setAttribute('display', aa ? 'none' : 'inline');
    reticle.setAttribute('display', aa ? 'inline' : 'none');
    layout();
  }

  function layout() {
    w = innerWidth; h = innerHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const r = Math.min(h * 0.40, w * 0.26);
    const gap = r * 0.62; // how far each eyecup sits off centre — they overlap
    const cy = h * 0.5;
    white.setAttribute('x', 0); white.setAttribute('y', 0);
    white.setAttribute('width', w); white.setAttribute('height', h);
    shade.setAttribute('x', 0); shade.setAttribute('y', 0);
    shade.setAttribute('width', w); shade.setAttribute('height', h);
    const cx = (i) => w / 2 + (i ? gap : -gap);
    holes.forEach((c, i) => {
      c.setAttribute('cx', cx(i));
      c.setAttribute('cy', cy);
      c.setAttribute('r', r);
    });
    fieldRect.setAttribute('x', 0); fieldRect.setAttribute('y', 0);
    fieldRect.setAttribute('width', w); fieldRect.setAttribute('height', h);
    // In the binocular sight the graticule is clipped to the eyecups, because
    // the wires are inside the tube. An open ring sight has no tube, so the mask
    // is opened right out and the pip may go anywhere on the glass.
    fieldHoles.forEach((c, i) => {
      c.setAttribute('cx', mode === 'aa' ? w / 2 : cx(i));
      c.setAttribute('cy', cy);
      c.setAttribute('r', mode === 'aa' ? Math.hypot(w, h) : r);
    });
    rimMasks.forEach((m, i) => {
      m.rect.setAttribute('x', 0); m.rect.setAttribute('y', 0);
      m.rect.setAttribute('width', w); m.rect.setAttribute('height', h);
      // the *other* eyecup, pulled in a hair so the two rims meet cleanly at the
      // cusps instead of leaving a pinhole of shade between them
      m.other.setAttribute('cx', cx(1 - i));
      m.other.setAttribute('cy', cy);
      m.other.setAttribute('r', r - 1);
    });
    rings.forEach((ring, i) => {
      for (const [c, inset, width] of [
        [ring.soft, 0.055, 0.11], [ring.lip, 0.012, 0.024],
      ]) {
        c.setAttribute('cx', cx(i));
        c.setAttribute('cy', cy);
        c.setAttribute('r', r - r * inset);
        c.setAttribute('stroke-width', r * width);
      }
    });
    const reach = gap + r;
    const inner = r * 0.05;
    // horizontal wire, in two pieces either side of the mark
    hair[0].setAttribute('x1', w / 2 - reach); hair[0].setAttribute('x2', w / 2 - inner);
    hair[1].setAttribute('x1', w / 2 + inner); hair[1].setAttribute('x2', w / 2 + reach);
    hair[0].setAttribute('y1', cy); hair[0].setAttribute('y2', cy);
    hair[1].setAttribute('y1', cy); hair[1].setAttribute('y2', cy);
    // vertical wire
    hair[2].setAttribute('y1', cy - r); hair[2].setAttribute('y2', cy - inner);
    hair[3].setAttribute('y1', cy + inner); hair[3].setAttribute('y2', cy + r);
    hair[2].setAttribute('x1', w / 2); hair[2].setAttribute('x2', w / 2);
    hair[3].setAttribute('x1', w / 2); hair[3].setAttribute('x2', w / 2);
    ticks.forEach((l, i) => {
      const y = cy - r * 0.9 + (i * r * 1.8) / 9;
      const len = (i % 5 === 0) ? r * 0.06 : r * 0.03;
      l.setAttribute('x1', w / 2 - len); l.setAttribute('x2', w / 2 + len);
      l.setAttribute('y1', y); l.setAttribute('y2', y);
    });
    if (mode === 'aa') layoutReticle();
  }

  // The ring sight, sized off the field of view rather than off the window.
  // `half` is the projection: half the picture's height is tan(fov/2) of range,
  // so an angle theta lands at tan(theta)/tan(fov/2) of that.
  let ringDeg = 13.5;
  let innerDeg = 6.2;
  function layoutReticle() {
    const cy = h / 2;
    const cxm = w / 2;
    const half = Math.tan((field / 2) * (Math.PI / 180));
    const px = (deg) => (Math.tan(deg * (Math.PI / 180)) / half) * (h / 2);
    const R = px(ringDeg);
    const r2 = px(innerDeg);
    aaRings[0].setAttribute('cx', cxm); aaRings[0].setAttribute('cy', cy);
    aaRings[0].setAttribute('r', r2);
    aaRings[1].setAttribute('cx', cxm); aaRings[1].setAttribute('cy', cy);
    aaRings[1].setAttribute('r', R);
    // the posts, standing out from the outer ring
    const out = R * 1.22;
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    posts.forEach((l, i) => {
      const [dx, dy] = dirs[i];
      l.setAttribute('x1', cxm + dx * R); l.setAttribute('y1', cy + dy * R);
      l.setAttribute('x2', cxm + dx * out); l.setAttribute('y2', cy + dy * out);
    });
    bead.setAttribute('cx', cxm); bead.setAttribute('cy', cy);
    bead.setAttribute('r', Math.max(3, px(0.55)));
  }
  addEventListener('resize', layout);
  layout();

  return {
    root,
    show(on) {
      root.classList.toggle('on', !!on);
      if (on) layout();
      if (!on) { flash.t = 1e3; dazzle.style.opacity = '0'; }
    },

    // The gun fired. Full white at once — a dazzle that fades *in* is a lamp —
    // and then a long slow recovery, which is the whole point: the flash is gone
    // in a third of a second and the eye is not.
    fire(strength = 1) {
      flash.t = 0;
      flash.mag = Math.min(1, strength);
      // Written here and not left to the next `step`: a frame of black between
      // the guns going off and the white arriving is very visible.
      dazzle.style.opacity = String(flash.mag);
    },

    // Advanced from the frame loop, because it has to fade on wall time rather
    // than on however often anybody happens to call `set`.
    step(dt) {
      if (flash.t > DAZZLE.life) return;
      flash.t += dt;
      const u = Math.min(flash.t / DAZZLE.life, 1);
      // Off full quickly and then a long dim tail — half gone by a third of a
      // second, but still washing the picture a second later. A straight `1 - u`
      // comes back far too evenly and reads as a dimmer being wound down.
      const a = flash.mag * (1 - u) ** DAZZLE.falloff;
      dazzle.style.opacity = String(a);
    },
    // `dx`/`dy` are the demand's offset from the guns, in fractions of the
    // vertical field of view. That is what puts the pip in the right place at
    // any magnification without this file having to know what a magnification is.
    set(state) {
      const want = state.mode || 'turret';
      const wantField = state.field || field;
      if (want !== mode || Math.abs(wantField - field) > 0.01
        || (state.ring && Math.abs(state.ring - ringDeg) > 0.01)) {
        mode = want;
        field = wantField;
        if (state.ring) ringDeg = state.ring;
        if (state.innerRing) innerDeg = state.innerRing;
        applyMode();
      }
      if (mode === 'aa') {
        aaMount.textContent = state.mount;
        aaRounds.textContent = `${state.rounds}/${state.clip}`;
        aaRounds.style.color = state.reload > 0 ? '#ff8a5c'
          : (state.rounds < state.clip * 0.25 ? '#ffd479' : '#dfe6ea');
        aaHeat.style.width = `${Math.round(state.heat * 100)}%`;
        // Where the gun gives up, marked on the gauge. The bar is not a health
        // bar: what it is telling you is how long a burst you have left, and
        // that is only readable if the cut-off is drawn on it.
        aaCease.style.left = '100%';
        aaBearing.textContent = `${((Math.round(state.bearing) + 360) % 360).toString().padStart(3, '0')}°`;
        aaElev.textContent = `${state.elevation.toFixed(0)}°`;
        // One line, and it says the most urgent true thing. Order matters: a gun
        // that will not fire because its barrels are cooked should say so before
        // it mentions that it is also pointing at the mainmast.
        warn.textContent = state.ceased ? 'BARRELS COOKED — CEASE FIRE'
          : state.reload > 0 ? `LOADERS REFILLING  ${state.reload.toFixed(1)}s`
            : state.cutout ? `CUT-OUT — GUNS HELD AT ${state.floor.toFixed(0)}°`
              : '';
        load.textContent = '';
      } else {
        warn.textContent = '';
        rangeValue.textContent = state.range > 0 ? Math.round(state.range) : '—';
        turretLabel.textContent = state.turret;
        shellLabel.textContent = state.shell;
        load.textContent = state.reload > 0
          ? `RELOADING ${state.reload.toFixed(1)}s`
          : '';
      }
      mags.forEach((el) => el.classList.toggle('sel', Number(el.dataset.m) === state.mag));
      const px = w / 2 + state.dx * h;
      const py = h / 2 - state.dy * h;
      pipRing.setAttribute('cx', px); pipRing.setAttribute('cy', py);
      pipDot.setAttribute('cx', px); pipDot.setAttribute('cy', py);
      const off = Math.hypot(state.dx, state.dy) > 0.004;
      pip.setAttribute('opacity', off ? '1' : '0.25');
      // Held at the rim because the guns are further off the line than the glass
      // is wide. The ring alone then reads as a bearing to them rather than as
      // where they are pointing, which is the honest thing to say — dropping the
      // dot is the whole of the difference and it is enough.
      pipDot.setAttribute('opacity', state.far ? '0' : '1');
    },
    dispose() { root.remove(); style.remove(); },
  };
}
