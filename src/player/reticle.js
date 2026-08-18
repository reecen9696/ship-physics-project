// The crosshair, and what is left in the magazine.
//
// DOM over the top of the canvas rather than geometry in front of the camera,
// for the same three reasons the gunsight and the HUD are (see gunsight.js): it
// is sharp at any resolution, it costs no draw calls, and something that has to
// line up with the exact middle of the screen is a far easier thing to write in
// CSS than in a shader.
//
// The one part of it that is not decoration is the gap. A crosshair that does not
// answer to the weapon is a sticker: it says "the middle of the screen" when what
// the player needs to know is "the size of the group". So the four wires stand
// off the centre by the actual cone the next round will go into — the same number
// the shot uses, projected through the same field of view the camera is on — and
// firing opens it, running opens it further, and bringing the sights up shuts it
// and then hides it altogether, because at that point the rifle has its own.

const CSS = `
#reticle { position:fixed; inset:0; z-index:38; pointer-events:none; display:none;
  font:600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing:.10em; color:#dfe6ea; }
#reticle.on { display:block; }

#reticle .cross { position:absolute; left:50%; top:50%; width:0; height:0;
  transition:opacity .12s linear; }
#reticle .cross i { position:absolute; background:#f2f6f8; display:block;
  box-shadow:0 0 3px #000a, 0 0 1px #000c; }
/* the two horizontal wires and the two vertical ones */
#reticle .cross i.h { width:9px; height:2px; margin-top:-1px; }
#reticle .cross i.v { width:2px; height:9px; margin-left:-1px; }
/* and the dot, which is where the round actually goes */
#reticle .cross i.dot { width:2px; height:2px; margin:-1px 0 0 -1px; opacity:.72; }

/* A round arriving on something. Brief and small: it is confirmation, not a
 * reward, and anything bigger reads as an arcade game. */
#reticle .hit { position:absolute; left:50%; top:50%; width:0; height:0; opacity:0; }
#reticle .hit i { position:absolute; width:2px; height:9px; margin:-4px 0 0 -1px;
  background:#ffd9a8; box-shadow:0 0 4px #000a; }

#reticle .ammo { position:absolute; right:312px; bottom:1.6vh; text-align:right;
  text-shadow:0 1px 0 #000, 0 0 8px #0009; }
#reticle .ammo b { font-size:30px; line-height:1; letter-spacing:.02em;
  font-variant-numeric:tabular-nums; }
#reticle .ammo b.low { color:#ff9a5c; }
#reticle .ammo b.out { color:#ff5f4a; }
#reticle .ammo span { opacity:.55; font-size:15px; }
#reticle .ammo em { display:block; font-style:normal; font-size:11px; opacity:.5;
  margin-top:3px; }
#reticle .ammo em u { text-decoration:none; color:#ffd479; opacity:1; }

/* The reload, drawn as the thing it is: a bar that has to fill before the rifle
 * works again. Under the counter, so the eye is already there. */
#reticle .load { position:absolute; right:312px; bottom:calc(1.6vh + 62px);
  width:132px; height:3px; background:#ffffff22; display:none; }
#reticle .load.on { display:block; }
#reticle .load i { display:block; height:100%; width:0; background:#ffd479;
  box-shadow:0 0 6px #ffd47966; }
`;

// Half the width of the screen, in world units at one metre, for a given
// vertical field of view. Turning an angle into pixels is this and nothing else,
// and doing it properly is what keeps the gap honest as the sights come up and
// the field narrows.
const pixelsPerRadian = (fovDeg) => innerHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));

export function createReticle() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.id = 'reticle';
  root.innerHTML = `
    <div class="cross">
      <i class="h l"></i><i class="h r"></i><i class="v u"></i><i class="v d"></i>
      <i class="dot"></i>
    </div>
    <div class="hit"><i></i><i></i></div>
    <div class="load"><i></i></div>
    <div class="ammo"><b>30</b><span>/30</span><em></em></div>
  `;
  document.body.append(root);

  const cross = root.querySelector('.cross');
  const wires = {
    l: root.querySelector('.h.l'),
    r: root.querySelector('.h.r'),
    u: root.querySelector('.v.u'),
    d: root.querySelector('.v.d'),
  };
  const hit = root.querySelector('.hit');
  const hitArms = hit.querySelectorAll('i');
  hitArms[0].style.transform = 'rotate(45deg)';
  hitArms[1].style.transform = 'rotate(-45deg)';
  const load = root.querySelector('.load');
  const loadBar = load.querySelector('i');
  const ammo = { count: root.querySelector('.ammo b'), cap: root.querySelector('.ammo span'), note: root.querySelector('.ammo em') };

  let hitAge = 1e3;
  let shown = false;
  // Everything below is written to the DOM only when it changes. Not premature:
  // this runs every frame, and a style write that does not change anything still
  // makes the browser reconsider the layout of the element it is on.
  const last = { gap: -1, rounds: -1, mode: '', torch: null, load: -1, hide: null };

  function set({
    rounds, capacity, mode, reloading, reloadFor, torch, spread, fov, aiming,
  }) {
    // The sights are up: the rifle's own aperture is doing this job now, and two
    // crosshairs is worse than either.
    const hide = aiming > 0.6;
    if (hide !== last.hide) {
      cross.style.opacity = hide ? '0' : '1';
      last.hide = hide;
    }

    if (!hide) {
      // The cone the next round goes into, at the screen. Half the angle, because
      // the gap is measured from the middle out.
      const gap = Math.round(Math.min(
        Math.max(pixelsPerRadian(fov) * Math.tan((spread * Math.PI) / 180), 3), 220,
      ));
      if (gap !== last.gap) {
        wires.l.style.transform = `translate(${-gap - 9}px, 0)`;
        wires.r.style.transform = `translate(${gap}px, 0)`;
        wires.u.style.transform = `translate(0, ${-gap - 9}px)`;
        wires.d.style.transform = `translate(0, ${gap}px)`;
        last.gap = gap;
      }
    }

    if (rounds !== last.rounds) {
      ammo.count.textContent = String(rounds);
      ammo.count.className = rounds === 0 ? 'out' : rounds <= 6 ? 'low' : '';
      last.rounds = rounds;
    }
    if (capacity !== last.cap) {
      ammo.cap.textContent = `/${capacity}`;
      last.cap = capacity;
    }
    const note = `${mode}${torch ? ' · <u>TORCH</u>' : ''}`;
    if (note !== last.mode) { ammo.note.innerHTML = note; last.mode = note; }

    const k = reloading > 0 && reloadFor > 0 ? 1 - reloading / reloadFor : -1;
    if (k !== last.load) {
      load.classList.toggle('on', k >= 0);
      if (k >= 0) loadBar.style.width = `${Math.round(k * 100)}%`;
      last.load = k;
    }
  }

  function update(dt) {
    if (hitAge > 0.36) return;
    hitAge += dt;
    const f = Math.max(0, 1 - hitAge / 0.36);
    hit.style.opacity = String(f);
    const spread = 6 + (1 - f) * 5;
    hitArms[0].style.transform = `translate(${-spread}px, ${-spread}px) rotate(45deg)`;
    hitArms[1].style.transform = `translate(${spread}px, ${-spread}px) rotate(-45deg)`;
  }

  return {
    root,
    set,
    update,
    // A round arrived on something solid. Called from the shot, not from the
    // frame, so it is one tick per hit however long the frame was.
    struck() { hitAge = 0; },
    show(on) {
      shown = !!on;
      root.classList.toggle('on', shown);
      if (!shown) hitAge = 1e3;
    },
    get shown() { return shown; },
  };
}
