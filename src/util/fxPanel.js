import { fx, fxList, FX_GROUPS, setFx } from './fxToggles.js';

// The bisection panel, bottom left.
//
// Deliberately not a lil-gui folder: lil-gui already owns the right-hand side
// and is full of sim parameters, and this is a different kind of control — a set
// of switches you flick while watching one spot on the hull. It wants to be
// where you can see it without your eye leaving the ship, and it wants "all off"
// to be one click.

export function createFxPanel() {
  const root = document.createElement('div');
  root.id = 'fxpanel';

  const head = document.createElement('div');
  head.className = 'fx-head';
  const title = document.createElement('span');
  title.textContent = 'Motion / water effects';
  const caret = document.createElement('span');
  caret.className = 'fx-caret';
  caret.textContent = '▾';
  head.append(title, caret);

  const body = document.createElement('div');
  body.className = 'fx-body';

  const boxes = new Map();
  const bind = (key, input) => {
    boxes.set(key, input);
    input.addEventListener('change', () => setFx(key, input.checked));
  };

  for (const group of FX_GROUPS) {
    const h = document.createElement('div');
    h.className = 'fx-group';
    h.textContent = group.title;
    body.append(h);
    for (const key of group.keys) {
      const e = fx[key];
      const row = document.createElement('label');
      row.className = 'fx-row';
      row.title = e.hint;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = e.on;
      const name = document.createElement('span');
      name.textContent = e.label;
      row.append(input, name);
      body.append(row);
      bind(key, input);
    }
  }

  const buttons = document.createElement('div');
  buttons.className = 'fx-buttons';
  const setAll = (on) => {
    for (const e of fxList) {
      setFx(e.key, on);
      boxes.get(e.key).checked = on;
    }
  };
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  buttons.append(btn('all on', () => setAll(true)), btn('all off', () => setAll(false)));
  body.append(buttons);

  head.addEventListener('click', () => {
    root.classList.toggle('fx-collapsed');
    caret.textContent = root.classList.contains('fx-collapsed') ? '▸' : '▾';
  });

  root.append(head, body);
  document.body.append(root);

  return {
    root,
    // keep the checkboxes honest if anything flips a toggle from elsewhere
    refresh() {
      for (const [key, input] of boxes) input.checked = fx[key].on;
    },
  };
}
