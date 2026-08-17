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

const CSS = `
#gunsight { position:fixed; inset:0; z-index:40; pointer-events:none; display:none;
  font:600 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; color:#dfe6ea;
  letter-spacing:.06em; }
#gunsight.on { display:block; }
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
`;

export function createGunsight() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

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

  graticule.append(...hair, ...ticks, pip);
  svg.append(defs, shade, ...rings.map((r) => r.g), graticule);

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

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'MOUSE = lay · CLICK = fire · 1/2/3 = shell · Z = magnification · E or ESC = leave the gun';

  const load = document.createElement('div');
  load.className = 'load';

  root.append(range, panel, hint, load);
  document.body.append(root);

  let w = 0;
  let h = 0;

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
    fieldHoles.forEach((c, i) => {
      c.setAttribute('cx', cx(i));
      c.setAttribute('cy', cy);
      c.setAttribute('r', r);
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
  }
  addEventListener('resize', layout);
  layout();

  return {
    root,
    show(on) {
      root.classList.toggle('on', !!on);
      if (on) layout();
    },
    // `dx`/`dy` are the demand's offset from the guns, in fractions of the
    // vertical field of view. That is what puts the pip in the right place at
    // any magnification without this file having to know what a magnification is.
    set(state) {
      rangeValue.textContent = state.range > 0 ? Math.round(state.range) : '—';
      turretLabel.textContent = state.turret;
      shellLabel.textContent = state.shell;
      mags.forEach((el) => el.classList.toggle('sel', Number(el.dataset.m) === state.mag));
      load.textContent = state.reload > 0
        ? `RELOADING ${state.reload.toFixed(1)}s`
        : (state.onTarget ? '' : '');
      const px = w / 2 + state.dx * h;
      const py = h / 2 - state.dy * h;
      pipRing.setAttribute('cx', px); pipRing.setAttribute('cy', py);
      pipDot.setAttribute('cx', px); pipDot.setAttribute('cy', py);
      const off = Math.hypot(state.dx, state.dy) > 0.004;
      pip.setAttribute('opacity', off ? '1' : '0.25');
    },
    dispose() { root.remove(); style.remove(); },
  };
}
