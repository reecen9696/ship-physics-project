import { PLAYER } from './spec.js';

// Keyboard and pointer-lock mouse for a person on foot.
//
// It only listens while first person is active, so WASD keeps driving the ship
// the rest of the time. The two sets of controls share every key they use and
// there is no modifier to remember: which one you are talking to is which one
// you can see.

export function createPlayerInput({ element, onExit, onFire = null }) {
  const keys = new Set();
  const input = {
    forward: 0, strafe: 0, jump: false, sprint: false, rise: 0,
  };
  let active = false;
  let hadLock = false;
  let triedLock = false;
  let look = null; // { dYaw, dPitch } accumulated between frames
  const delta = { yaw: 0, pitch: 0 };

  const editing = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  function onKeyDown(e) {
    if (editing(e)) return;
    keys.add(e.key.toLowerCase());
    if (' wasdc'.includes(e.key.toLowerCase())) e.preventDefault();
  }
  const onKeyUp = (e) => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();

  function onMouseMove(e) {
    if (document.pointerLockElement !== element) return;
    // Mouse right turns to starboard, which is -x in the ship's frame.
    delta.yaw -= e.movementX * PLAYER.sensitivity;
    delta.pitch -= e.movementY * PLAYER.sensitivity;
  }

  // Losing the pointer is Escape, and Escape means "get me out of here". Staying
  // in first person with no mouse would leave the view stuck facing one way with
  // no obvious way back.
  //
  // Only once we have actually *had* the pointer, though. A lock request can be
  // refused — the document is not focused, the browser is throttling repeated
  // requests, the click came from somewhere it does not count — and treating a
  // refusal as "the player pressed Escape" bounces you straight back out to the
  // orbit camera the instant you go aboard, with nothing to say why. Better to
  // stand on the deck with the keyboard working and wait for a click.
  function onLockChange() {
    if (!active) return;
    if (document.pointerLockElement === element) { hadLock = true; return; }
    if (hadLock) onExit();
  }
  // The first click takes the pointer; after that a click is a shot. And if the
  // lock never arrived — it can be refused, for the reasons above — later clicks
  // shoot anyway rather than asking forever, so the mouse is at least good for
  // something.
  function onClick() {
    if (!active) return;
    if (document.pointerLockElement === element || triedLock) {
      if (onFire) onFire();
      return;
    }
    triedLock = true;
    lock();
  }

  function lock() {
    const p = element.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  function enable() {
    if (active) return;
    active = true;
    hadLock = false;
    triedLock = false;
    keys.clear();
    delta.yaw = 0; delta.pitch = 0;
    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    addEventListener('blur', onBlur);
    addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onLockChange);
    element.addEventListener('click', onClick);
    lock();
  }

  function disable() {
    if (!active) return;
    active = false;
    keys.clear();
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('blur', onBlur);
    removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onLockChange);
    element.removeEventListener('click', onClick);
    if (document.pointerLockElement === element) document.exitPointerLock();
  }

  // Read and clear: the mouse delta is per-frame, not per-event, or a fast mouse
  // turns further on a slow frame.
  function consumeLook() {
    look = look || {};
    look.yaw = delta.yaw; look.pitch = delta.pitch;
    delta.yaw = 0; delta.pitch = 0;
    return look;
  }

  function read() {
    input.forward = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    input.strafe = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
    input.jump = keys.has(' ');
    input.sprint = keys.has('shift');
    // Fly mode only. On SPACE and C rather than Q and E, because E is the hand
    // you put on a set of training gear and it can only mean one thing.
    input.rise = (keys.has(' ') ? 1 : 0) - (keys.has('c') ? 1 : 0);
    return input;
  }

  return {
    enable, disable, read, consumeLook, keys, get locked() { return document.pointerLockElement === element; },
  };
}
