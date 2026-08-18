import { PLAYER } from './spec.js';

// Keyboard and pointer-lock mouse for a person on foot.
//
// It only listens while first person is active, so WASD keeps driving the ship
// the rest of the time. The two sets of controls share every key they use and
// there is no modifier to remember: which one you are talking to is which one
// you can see.

export function createPlayerInput({
  element, onExit, onFire = null,
  // A key that does something once, wherever it is pressed. WASD is polled and
  // these are not: reloading twice because the frame was long is a bug, and
  // reloading not at all because the key went down and up inside one frame is a
  // worse one. The auto-repeat the operating system generates while a key is held
  // is filtered out here rather than at the call site.
  onTap = null,
}) {
  const keys = new Set();
  // Whether the trigger is *down*, as opposed to whether it was pressed.
  //
  // Every gun on this ship used to be fired by a click, because every gun on
  // this ship was a sixteen-inch rifle that takes six seconds to load. The stern
  // mounting is an automatic: what it wants is not an event but a state, read
  // once a frame for as long as the button is held. Both are here, and the two
  // do not interfere — a press still fires a salvo and still takes hold of a set
  // of gear, and the flag is simply whether the button is still down.
  let held = false;
  // And the other hand. The right button is not a second trigger — it is the
  // left hand bringing the sights up to the eye, which is a state exactly as the
  // trigger is and is read the same way.
  let sighting = false;
  const input = {
    forward: 0, strafe: 0, jump: false, sprint: false, crouch: false, rise: 0,
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
    const k = e.key.toLowerCase();
    if (!e.repeat && !keys.has(k) && onTap) onTap(k, e);
    keys.add(k);
    if (' wasdc'.includes(k)) e.preventDefault();
  }
  const onKeyUp = (e) => keys.delete(e.key.toLowerCase());
  const onBlur = () => { keys.clear(); held = false; sighting = false; };

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
  const onMouseDown = (e) => {
    if (!active) return;
    if (e.button === 0) held = true;
    else if (e.button === 2) { sighting = true; e.preventDefault(); }
  };
  const onMouseUp = (e) => {
    if (e.button === 0) held = false;
    else if (e.button === 2) sighting = false;
  };
  // Without this the right button opens the browser's menu over the top of the
  // game the first time anybody brings a rifle up.
  const onContext = (e) => { if (active) e.preventDefault(); };

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
    element.addEventListener('mousedown', onMouseDown);
    // On the window rather than the canvas: a button released with the pointer
    // somewhere else still has to count, or the gun goes on firing for ever.
    addEventListener('mouseup', onMouseUp);
    element.addEventListener('contextmenu', onContext);
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
    element.removeEventListener('mousedown', onMouseDown);
    removeEventListener('mouseup', onMouseUp);
    element.removeEventListener('contextmenu', onContext);
    held = false;
    sighting = false;
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
    // CTRL or C, and both because neither is obviously the one: C is what one
    // generation of shooters trained people to press and CTRL is what the next
    // one did. The character ignores it while flying, which is what keeps C free
    // to mean "down" there — see `rise` below and `resolveCrouch` in
    // character.js.
    input.crouch = keys.has('control') || keys.has('c');
    // Fly mode only. On SPACE and C rather than Q and E, because E is the hand
    // you put on a set of training gear and it can only mean one thing.
    input.rise = (keys.has(' ') ? 1 : 0) - (keys.has('c') ? 1 : 0);
    return input;
  }

  return {
    enable,
    disable,
    read,
    consumeLook,
    keys,
    get firing() { return held; },
    get aiming() { return sighting; },
    get locked() { return document.pointerLockElement === element; },
  };
}
