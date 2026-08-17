// Bottom-left action bar.
//
// Two things you reach for constantly while driving — swapping which hull you
// have the helm of, and jumping to the gunnery rig — used to be a keystroke you
// had to know about (B) and a URL you had to type. They are the only controls
// down here now, so they get to be plain buttons rather than another panel.

export function createNavButtons({
  onChangeBoat, onGoAboard = null, onTestCannons = null, onFrontCannon = null,
  onTakeHelm = null, testDestructionHref = '/test-destruction/',
}) {
  const root = document.createElement('div');
  root.id = 'navbtns';

  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    root.append(b);
    return b;
  };

  const destruction = btn('Test destruction', () => { location.href = testDestructionHref; });
  destruction.title = 'Open the destruction / gunnery test rig';

  const change = btn('Change boat', () => onChangeBoat());
  change.title = 'Swap the helm between the battleship and the launch (B)';

  if (onGoAboard) {
    const aboard = btn('Go aboard', () => onGoAboard());
    aboard.title = 'Stand on the battleship\'s deck (V)';
  }

  if (onTakeHelm) {
    const wheel = btn('Take the helm', () => onTakeHelm());
    wheel.title = 'Straight to the wheelhouse, hands on the wheel (H)';
  }

  if (onFrontCannon) {
    const front = btn('Front cannon', () => onFrontCannon());
    front.title = 'Straight to A turret\'s gear, hands on the gun';
  }

  if (onTestCannons) {
    const guns = btn('Test cannons', () => onTestCannons());
    guns.title = 'Take the gun in the next turret (T) — press again for the next one';
  }

  document.body.append(root);
  return { root };
}
