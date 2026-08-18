// A person on a ship — dimensions and feel.
//
// Two groups of numbers, and they are not the same kind of thing. The first
// describes a body: how tall, how fast, how far it can step. The second is the
// tuning of the inertial layer, which is where a walkable deck is won or lost —
// see `shipSpace.js` for why the ship's real motion has to be added back to the
// player deliberately rather than falling out of a solver.

export const PLAYER = {
  // --- the body ---------------------------------------------------------------
  height: 1.78, // m, crown to sole
  eye: 1.62, // m, where the camera sits
  radius: 0.34, // m, the capsule's half-width

  // --- locomotion -------------------------------------------------------------
  //
  // These are game speeds, not human ones. A person walks at 1.4 m/s and it is
  // unbearable to play; a shooter's "walk" has always been a jog and its sprint
  // a sprint nobody could hold. The ship is 180 m long and the point of being on
  // her is to get about her, so err fast.
  walk: 5.0, // m/s — the length of her in 36 seconds
  sprint: 8.4,
  jump: 6.2, // m/s off the deck

  // --- down on one knee ---------------------------------------------------
  //
  // Crouching is three numbers and one rule, and the rule is the part that has
  // to be right: you may always go down, and you may only come up if there is
  // room over your head. Without it, ducking under the barbette of B turret and
  // letting go of the key stands you up inside four inches of armour, and the
  // de-penetration pass then fires you out sideways at whatever speed it takes
  // to clear it.
  //
  // The eye does not sit at the same fraction of the height it does standing.
  // A man on one knee has his head much closer to the top of him than a man
  // standing has, and setting the crouched eye by scaling 1.62/1.78 puts the
  // camera in his chest.
  crouchHeight: 1.22, // m, crown to sole with the knees bent
  crouchEye: 1.08, // m
  crouchWalk: 2.3, // m/s — a shuffle, and there is no crouched run
  // How fast he goes down and comes up, as a fraction of the way per second.
  // Fast: this is a key you tap to get under something, and a slow duck is a
  // key that appears not to have worked.
  crouchRate: 8.5,

  ground: 32, // 1/s toward the wanted velocity with feet on the deck: ~50 ms to
  // full speed, which is what makes the controls feel connected rather than
  // like steering something heavy

  // Air control, and it is a different rule rather than a weaker version of the
  // same one. On the ground the velocity is pulled toward what the legs want; in
  // the air it is *added to*, and only up to the wanted speed along the wanted
  // direction. So a jump keeps every bit of the speed it left with — you can
  // steer it, you cannot brake with it — which is the difference between a jump
  // that feels like a jump and one that feels like being lowered.
  air: 14, // m/s^2 along the wished direction

  // Asymmetric gravity: up a bit fast, down faster. Physically nonsense and the
  // single largest contributor to a jump feeling good — it puts the apex where
  // you can see it and gets you back on the deck before you have got bored.
  // With `jump` above: about 1.5 m of air and 0.85 s of it.
  riseGravity: 1.35,
  fallGravity: 1.95,

  // Two small mercies that between them are most of the difference between a
  // controller that answers and one that seems to ignore you. Coyote time keeps
  // the jump available for a moment after walking off an edge; the buffer
  // remembers a jump pressed just before landing and spends it on touchdown.
  coyote: 0.12, // s
  jumpBuffer: 0.12, // s

  // A ship's ladder is steep and its coamings are ankle-height. Anything shorter
  // than `stepUp` is walked over without noticing, which is what makes the
  // hidden stair boxes in deckAccess.js work without any stepping logic at all:
  // the floor probe simply finds the next tread.
  stepUp: 0.45, // m
  snapDown: 0.5, // m the feet stay glued to a deck falling away beneath them

  // How fast you go up a ladder.
  //
  // A vertical ladder is the one way up this ship that the invisible-tread trick
  // cannot build: treads make a 35-degree ramp, and the eleven metres from the
  // weather deck to the air-defence platform would want sixteen metres of run that
  // the pagoda has not got. So a ladder is a *mode* — see `ladderAt` in
  // character.js — and this is the climb rate in it. Brisk on purpose: a real man
  // does 0.5 m/s and the eleven metres would take twenty-two seconds.
  climb: 3.2, // m/s
  maxSlopeCos: Math.cos((52 * Math.PI) / 180), // steeper than this is not a floor

  // --- the inertial layer (see shipSpace.js §5) --------------------------------
  //
  // How much of the hull's real motion reaches the player. 1.0 is physically
  // correct and unplayable: in a real sea nobody crosses the deck. Rotated
  // gravity is deliberately *not* scaled by this — the tilt is the readable,
  // learnable half of the feel, and the acceleration terms are the half that
  // takes control away.
  inertiaScale: 0.4,
  // Response of the finite-differenced hull derivatives, in seconds. Short: the
  // high-frequency content of hull acceleration *is* the wave slam, and
  // smoothing it away is what makes a violent sea feel like a lift.
  derivativeTau: 0.04,

  // --- traction ---------------------------------------------------------------
  // Free sliding on a tilted deck is slapstick. Two readable effects instead.
  slideThreshold: 0.18, // sine of deck angle before any drift at all (~10 deg)
  // Metres per second of downhill drift at full tilt, added to the *velocity*
  // the legs are asking for rather than integrated into it. That is what makes
  // it bounded: a person on a heeled deck leans and shuffles to leeward, they
  // do not accelerate off it. (The reference calls this an acceleration. It
  // isn't, and the difference is the whole reason it stays controllable.)
  slideDrift: 4.0, // m/s
  uphillPenalty: 0.45, // fraction of speed lost walking against the heel

  // --- the rail ---------------------------------------------------------------
  // One invisible wall slightly inboard of the modelled guardrail. Catching a
  // capsule on individual stanchions feels terrible and generates edge cases
  // forever; this solves it permanently and costs two compares.
  railings: true,
  railInset: 0.6, // m inboard of the sheer line
  // Higher than the modelled guardrail, and higher than the jump clears, so
  // nobody goes over the side by accident on the way past. The clamp lifts above
  // this so there is still a way over if you mean it.
  railHeight: 1.9, // m above the deck the wall stands

  // --- look -------------------------------------------------------------------
  sensitivity: 0.0022, // radians per pixel of mouse
  pitchLimit: (86 * Math.PI) / 180,
  fov: 75, // a person's field of view, not a camera's
  sprintFov: 9, // and how much wider it goes flat out — cheap, and it is most of
  // what makes running feel like running
  // Head bob. Small: enough to say the feet are hitting something, not enough to
  // be noticed as an effect. It goes to nothing when you stop.
  bob: 0.035, // m of rise and fall at walking pace
  bobRoll: 0.012, // radians of sway with it
};

export const GRAVITY = 9.81;
