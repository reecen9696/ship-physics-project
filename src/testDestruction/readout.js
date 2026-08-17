// The instrument panel for the destruction rig.
//
// The point of the page is to watch the damage model work, and most of what it
// does is invisible from outside: a compartment can be flooding hard while the
// ship still looks fine, and a turret reads as "destroyed" some seconds before
// the fire that killed it has finished burning. So every component gets a row
// showing hit points, status, fire and flooding, and every hit gets a line in a
// log saying what was struck, what took the damage, and what it cost.

const STATUS_COLOR = { ok: '#7fd4a0', damaged: '#ffcf6b', destroyed: '#ff6b6b' };

export function createReadout({ groups }) {
  const panel = document.createElement('div');
  panel.id = 'rig';
  document.body.append(panel);

  const rows = new Map();
  const section = (title) => {
    const h = document.createElement('div');
    h.className = 'rig-group';
    h.textContent = title;
    panel.append(h);
  };

  const summary = document.createElement('div');
  summary.className = 'rig-summary';
  panel.append(summary);

  for (const g of groups) {
    section(g.title);
    for (const c of g.components) {
      const row = document.createElement('div');
      row.className = 'rig-row';
      const name = document.createElement('span');
      name.className = 'rig-name';
      name.textContent = c.id;
      const bar = document.createElement('span');
      bar.className = 'rig-bar';
      const fill = document.createElement('i');
      bar.append(fill);
      const flood = document.createElement('i');
      flood.className = 'rig-flood';
      bar.append(flood);
      const val = document.createElement('span');
      val.className = 'rig-val';
      row.append(name, bar, val);
      panel.append(row);
      rows.set(c.id, { row, fill, flood, val });
    }
  }

  section('hits');
  const log = document.createElement('div');
  log.className = 'rig-log';
  panel.append(log);

  const lines = [];
  function logHit(text, color = '#cfe6ff') {
    lines.unshift({ text, color });
    if (lines.length > 12) lines.pop();
    log.replaceChildren(...lines.map((l, i) => {
      const d = document.createElement('div');
      d.textContent = l.text;
      d.style.color = l.color;
      d.style.opacity = String(1 - i * 0.06);
      return d;
    }));
  }

  function update(damage, state) {
    for (const [id, r] of rows) {
      const c = damage.get(id);
      if (!c) continue;
      const hp = Math.max(0, c.hp / c.maxHp);
      r.fill.style.width = `${(hp * 100).toFixed(0)}%`;
      r.fill.style.background = STATUS_COLOR[c.status];
      r.flood.style.width = `${(c.flood * 100).toFixed(0)}%`;
      // a burning component pulses, because fire is the one thing here that
      // keeps taking hit points off with nobody shooting
      r.row.classList.toggle('rig-fire', c.fire > 0.02);
      const bits = [`${Math.ceil(c.hp)}`];
      if (c.fire > 0.02) bits.push(`🔥${(c.fire * 100).toFixed(0)}`);
      if (c.flood > 0.005) bits.push(`💧${(c.flood * 100).toFixed(0)}`);
      r.val.textContent = bits.join(' ');
      r.val.style.color = STATUS_COLOR[c.status];
    }
    const cap = damage.capability;
    summary.innerHTML =
      `<b>main battery</b> ${cap.mainBattery}/4 &nbsp; <b>AA</b> ${cap.aa}/6<br>`
      + `<b>helm</b> ${(cap.helm * 100) | 0}% &nbsp; <b>power</b> ${(cap.propulsion * 100) | 0}%`
      + ` &nbsp; <b>fire ctl</b> ${(cap.fireControl * 100) | 0}%<br>`
      // +z is forward, so water forward of amidships puts her down by the head
      + `<b>flooding</b> ${(state.flood * 100).toFixed(1)}%`
      + `${state.flood > 0.005 ? ` (${state.floodZ > 0 ? 'by the head' : 'by the stern'})` : ''}`
      + `${state.burning > 0.05 ? ` &nbsp; <b style="color:#ff8a4a">burning ${state.burning.toFixed(1)}</b>` : ''}`
      + `${state.sinking ? ' &nbsp; <b style="color:#ff6b6b">SINKING</b>' : ''}`;
  }

  return { update, logHit };
}
