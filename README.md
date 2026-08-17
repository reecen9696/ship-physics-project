# Poseidon — Real-time FFT Ocean (WebGPU)

A real-time, Tessendorf-style **spectral ocean** built in [Three.js](https://threejs.org/)
with the **WebGPURenderer + TSL**, where the inverse FFT runs entirely in
**WebGPU compute shaders**.

## Features

- **GPU butterfly IFFT** (Stockham, precomputed twiddle/index buffer), validated
  in isolation against an analytic impulse/frequency before wiring to the ocean.
- **3 wave cascades** (250 / 17 / 5 m) over disjoint wavenumber bands for swell +
  ripples without visible tiling.
- **Horvath / JONSWAP directional spectrum** — wind-sea + swell, with TMA depth
  correction, Donelan-Banner spreading and short-wave fade.
- **Choppy** horizontal displacement, **fold-aware normals** from the slope FFTs.
- **Foam** from the displacement **Jacobian**, accumulated with build/decay so
  whitecaps linger and dissipate; bubbly texture + sun-lit shading.
- **Shading**: Fresnel sky reflection, reflected-sun glitter, subsurface scatter,
  sub-grid detail noise, depth-based water color.
- **Drivable boat** with buoyancy read back from the wave field itself — see below.
- **lil-gui** panel for live tuning (wind, choppiness, foam, sun, colors).
- Optional **GPU ballistic spray-particle** system (disabled by default).

## The boat

A rigid hull floating on the actual simulated surface, not on an analytic
approximation of it. Six probe points under the hull are sampled by a small
compute pass that reads the same cascade maps the surface shader reads, so hull
and render can't disagree; the results come back over an async buffer map. Each
probe contributes buoyancy proportional to its submersion, damping against its
own vertical velocity, and a down-slope term standing in for the pressure
gradient on a tilted hull — which is what lets the boat surf a wave face. Forces
and torques integrate as a 6-DOF rigid body at a fixed 120 Hz substep.

Two details worth knowing, because both are consequences of *this* ocean rather
than of buoyancy in general:

- The map lookup has to be **inverted**. Choppiness displaces the surface
  horizontally, so the texel that lands at a given world position isn't the one
  stored there. A relaxed, distance-capped fixed-point iteration recovers it —
  relaxed because the surface genuinely folds over at breaking crests (that fold
  is what the foam pass keys on) and the naive iteration runs away there.
- Surface slopes are **clamped** before the physics sees them. The shader can
  live with the fold-aware denominator passing through zero; the physics can't,
  because an unbounded slope becomes an unbounded force.

### Turning

Steering is not a yaw torque bolted onto the hull. Two pieces do the work:

- **Lateral resistance spread along the length**, at seven stations rather than
  lumped at the centre. Each station feels its own sideways flow — drift plus
  yaw rate times distance from the CG — and answers with crossflow drag (which
  dominates when nearly stopped) plus low-aspect-ratio foil lift (linear in
  drift, growing with speed, and what makes her carve instead of skid). Sway
  damping, yaw damping, the drift angle, the pivot point and the speed lost in a
  turn all fall out of that one set of forces, coupled the way they should be.
- **A rudder modelled as a stalling foil** in the propeller race. Force is
  normal to the blade and proportional to the flow across it, saturating past
  the stall. Rudder drag, the loss of steerage when you cut the throttle, the
  ability to kick her around at a standstill on the screws alone, and steering
  reversing astern all come out of that for free rather than being special-cased.
  The helm itself swings at a finite rate, so it never snaps hard over.

Heel is likewise a consequence: the lateral forces act a metre below the centre
of mass, so she leans *out* of a turn the way a displacement hull does. A fast
hull riding on its own lift banks the other way, so a `bank in` term blends
between the two — that one is a lumped stand-in for planing lift, not something
the buoyancy probes can produce, and it is labelled as such in the panel.

Roll damping is quadratic, which is what lets the two roll behaviours be tuned
almost independently: it bites hard on the fast roll a wave train drives, and
barely at all on the slow forced lean of a turn.

Note the probe x-offsets sit well inboard of the rail. Each probe stands for a
share of the waterplane, so `sum(area * x^2)` *is* the roll stiffness — put all
six out at the gunwale and you get a metacentric height of 8 m and a 1.3 s roll
period, which is nothing like a boat.

### Sitting in the water, not on it

Two things stop the hull reading as a separate object dropped on a plane.

**Contact foam.** An opaque sea surface simply intersects the hull, and a hard
polygon edge across a boat reads as the water clipping through it — at a bad
moment the sea appears to slice the hull into disconnected pieces. The ocean is
drawn after the boat and compares its own depth against what is already in the
buffer; close to the hull, the water turns to foam. That hides the intersection
and puts a wake-coloured ring around the waterline where one belongs. Tunable
under *Foam* (`foam at the hull`, `hull foam width`); set the strength to 0 to
see what it is doing.

**Shared lighting.** The hull is shaded by hand from the same uniforms as the sea
and sky rather than by three's lighting model — the same sun colour, the same
analytic sky gradient, the same water colour, so moving the sun or restyling the
sea carries to the boat automatically. It gets sun, sky ambient sampled in the
normal direction, bounce off the water from below, and a Fresnel sky reflection.
Below the waterline it darkens and goes glossy, the way a wet hull does.

Flat panels get surface detail — planking on the deck, fine grain on paintwork.
Without it a deck or a wheelhouse roof shades to one flat colour, because every
fragment of a flat surface shares a normal and the Fresnel term is nearly
nothing head-on, so it reads as coloured paper rather than a surface. The grain
frequencies are deliberately high and well separated: on a flat panel one axis
is constant, and closely spaced frequencies band into visible streaks.

The boat also casts a real shadow onto the sea. Nothing here uses three's
lighting model, so the directional light exists only to own a shadow map, which
the ocean shader samples with `shadow()`. Only the sun-driven terms are gated on
it — the glitter path, the crest glow, the lit side of the foam — because
shading a wave does not stop it reflecting the sky. A little is taken off the
reflection too, since a hull overhead blocks skylight as well as sun, and without
that the shadow is nearly invisible on water whose look is dominated by a
reflection the sun never touches.

### Spray

Spray is thrown by the hull, and its momentum comes from the hull–water
interaction rather than from a timer. Three sources, all reading the same probe
data the buoyancy uses:

- **Slam.** Each probe tracks how fast it is being immersed — positive whether
  she is falling into the sea or a crest is rising onto her, which is the
  quantity that actually makes a splash. Past a threshold it throws a jet up and
  *outboard* at a couple of times the entry speed, the way a body entering water
  throws its root jet up the side it hit. This is the burst you get dropping off
  a wave.
- **Shouldering.** The bow driving water aside, and the hull throwing it sideways
  when she skids through a turn. Only the part of the hull near the surface does
  this — deep down it pushes water rather than throwing it.
- **The stem.** A dedicated emitter right at the forefoot, because the probes
  stop well short of it and the bow wave is the most visible spray a boat makes.
  Two sheets, one either side, and it scales with how buried the bow is.

Droplets fly ballistically with gravity, air drag and wind. That is not a
shortcut: once water has left the surface it *is* a projectile, and ballistics
with drag is the correct model for it. Smoothed-particle hydrodynamics governs
**bulk** liquid — and here the bulk liquid is the FFT ocean, which is synthesised
from a wave spectrum rather than simulated, so there is no fluid state for SPH
particles to share. The place SPH would earn its keep is the sea itself, and this
project deliberately does not simulate the sea that way.

Landing is not a delete. A droplet that falls back through the surface is pinned
to it, its fall arrested, and it spreads and fades over `settle` seconds as it
merges back into the water. Popping droplets out of existence the instant they
touch is the most obvious tell that they were never water.

They launch from the hull *side* at the waterline, not from the probes — the
probes sit inboard under the bottom, and firing from there sends droplets up
through her own deck.

### Making spray look like water

Three sprite treatments were tried before one worked, and the failures are worth
recording because each looks like a different wrong thing:

- **Soft white blobs** → smoke. A soft radial alpha falloff is how you draw fog.
- **Hard-edged shaded spheres** → soap bubbles. A full spherical normal gives
  every droplet a bright Fresnel rim and a dark middle, which is exactly how a
  bubble is drawn; hard rims also stop droplets merging, so they read as a ball
  pit.
- **Soft ocean-coloured blobs, thinly spread** → droplets on a lens. Right
  colour, but nothing overlapped.

What works is the third with the dispersion fixed. Droplets are shaded with the
*ocean's own* model — same deep colour, same subsurface scatter, same Fresnel
against the same analytic sky — then mixed toward foam by an `aeration` term,
because airborne water carries entrained air and is whiter than the sea it came
from. The spherical normal is flattened hard toward the viewer to kill the rim.

Cohesion then comes from **local density**, not from any individual droplet: they
are short-lived and heavily damped so they stay packed around the hull. Volume
comes from droplet count, never from droplet size — scaling the size up to get
more water just produces beach balls, and on a 16.5 m hull anything past about
0.3 m across stops reading as water at all.

Sizes come off a skewed distribution, so a handful are several times larger than
the rest — real spray is mostly fine mist with a few heavier gobbets in it, and a
flat distribution reads as uniform fog.

Everything is tunable under *Boat › Spray*; `aeration` runs from the sea's own
colour to pure foam. The pool is 30k droplets and the integration stays well
under a millisecond of CPU per frame even with all of them live.

**On [tiamat](https://github.com/owenyuwono/tiamat).** It splats particles into a
3D density field and raymarches an isosurface out of it. That is the right way to
render a *body* of liquid, and the transferable idea is that cohesion has to come
from a field rather than from individual particles. The same logic is why the
sprite experiments above failed and why local density is what fixes them. Its
simulation half — SPH — has nothing to attach to here, for the reason given
above, and its renderer would replace the analytic sky-and-Fresnel shading the
whole scene is built on.

### Measured behaviour

In calm water (set *amplitude* and *swell* to 0), the hull settles to a draft of
0.722 m — exactly `mass / (rho * waterplane area)` — and does 27.5 kn ahead,
10.6 kn astern. Response to the wheel is progressive:

| helm | speed | turn rate | tactical dia. | heel | drift |
|-----:|------:|----------:|--------------:|-----:|------:|
|  15% | 27.2 kn |  3.9 °/s | 25 L | 3.3° |  3.0° |
|  30% | 26.2 kn |  7.5 °/s | 12 L | 6.0° |  5.8° |
|  50% | 24.1 kn | 11.4 °/s |  7 L | 8.2° |  9.4° |
|  75% | 20.6 kn | 14.9 °/s |  5 L | 9.0° | 13.8° |
| 100% | 16.9 kn | 17.0 °/s |  3.4 L | 8.0° | 18.4° |

Tactical diameter of 3–5 boat lengths at full helm is about right for a hull
this size. Throwing the wheel hard over from a straight 27.5 kn run gives a
lurch to 19° of heel and 20°/s, settling over about four seconds to 8° and
17°/s as the speed bleeds off — she does not simply snap into the turn.

Prop wash matters at low speed: from a standstill, full throttle and full helm
gives 16.4°/s, against 8.7°/s with the wash disabled. Coasting with the engine
off, full helm musters only 3.7°/s.

At the default 16 m/s wind the sea is around 5 m significant wave height, and a
16 m boat in that gets thrown about and takes green water over the deck. That is
the honest answer, not a bug — wind the *wind speed* slider down if you want a
gentler ride.

`window.poseidon` exposes the renderer, ocean, boat, battleship and params for
poking at from the console.

## The battleship

A 180 m battleship shares the scene and the same buoyancy solver — four turrets
that train independently inside real firing arcs, a hull divided into five
watertight sections, and a superstructure whose pieces can be shot away one at
a time, each with a consequence: lose the bridge and the helm is conned from
aft, lose the funnel and she loses a third of her speed, flood two compartments
forward and she goes down by the head on the same physics that floats her.

She is the ship only — the sim page carries no gunnery. Full design notes,
including the component graph and why the whole ship shares two shaders, are in
[`src/battleship/README.md`](src/battleship/README.md).

### Walking her deck

Press `V`, or the *Go aboard* button, and you are standing on the forecastle of a
180 m ship that is pitching and rolling on the same wave field she floats on.
WASD walks, shift runs, space jumps, the mouse looks; `ESC` or `V` puts you back
outside. She holds whatever the telegraph and the wheel were set to, so you can
ring down full ahead, go aboard, and walk her deck at 25 knots.

The movement is a shooter's, not a person's, and deliberately: she is 180 m long
and the point of being aboard is to get about her. A walk is 5 m/s and a sprint
8.4, which puts her stem to stern in half a minute; the jump is 1.5 m and 0.85 s
of hang, on gravity that is a third heavier going up and twice as heavy coming
down, because asymmetric gravity is most of what makes a jump read as a jump. On
the deck the legs own the velocity outright — 67 ms from a standstill to full
speed and the same back — and in the air they do not: velocity is *added to*
along the direction you are asking for and only up to the speed you are asking
for, so a jump keeps every bit of the run it left with and can be steered but
not braked. Coyote time and a jump buffer cover the two frames either side of an
edge. All of it is in `src/player/spec.js`.

Click to put a shell into her. It is the destruction rig's gunnery — the same
ballistic ball, hit-tested along the segment it swept, resolved to the component
that owns the mesh it struck, handed to `battleship.strike` — pointed by an eye
standing on her own deck, so you can walk up to a turret and open it and then
walk round the hole. `1`/`2`/`3` load AP, HE or a torpedo. `N` puts her into
night. The sim page still has no gunnery of its own and is not getting one; what
it has is the rig's, and the rig is still the place to watch her come apart from
outside.

**The architecture is two coordinate spaces, and everything else follows from
it.** Walking on a moving ship reads like a character-controller problem and is
not: the thing that breaks is collision against a *moving* collider, and no
amount of tuning fixes that. Rapier's kinematic controller documents that it does
not support rotational movement, and a deck that rolls is rotational movement.
Parenting the player to the hull makes their world position the product of two
transforms and multiplies every degree of hull error by their distance from her
centre.

So the player is simulated in a space in which the ship never moves. The
geometry in there has zero velocity, which means there is nothing to tunnel
through, no continuous collision detection, no contest between the hull's
interpolation and the character solve — and the whole class of *ping-ponged
through the plating* bugs stops existing by construction rather than by tuning.
Rendering is one matrix multiply: `worldPose = hullMatrix · localPose`.

What that space collides against is not a second description of the ship. It is
`battleship/colliders.js` — the analytic loft, deckhouses, barbettes and
turrets that wreckage already lands on and the camera is already kept out of.
It was in her own frame all along; nobody had asked it to hold a person up
before. A turret that has trained out from under you, and a funnel that has been
shot away, are gone for the player too, because there is only one answer to
where the ship is.

The cost of the split is that her motion no longer physically reaches anyone
aboard, and has to be put back deliberately. **That is the feature.** Physically
honest motion in a heavy sea means nobody can cross the deck; adding it back as
an explicit layer makes the amount of sway a number you can turn:

- **Rotated gravity** does most of the work. Express world-down in her frame and,
  as she heels, "down" tilts and everything drifts to leeward. Note what falls
  out: the deck's normal in local space never changes, so *how tilted the deck
  feels* is entirely the direction of apparent gravity, and no surface query is
  needed to know it.
- **Her linear acceleration**, finite-differenced from the buoyancy solver's
  velocity, is the shove on a wave slam. Barely filtered, because the
  high-frequency part of that term *is* the slam.
- **Euler and centrifugal** scale with distance from her centre of mass, so they
  are nothing amidships and considerable at the ends — which is why the
  forecastle is genuinely unpleasant with the wheel hard over, and worth keeping.
- **Coriolis** is skipped. It is nothing at walking speed.

Traction is deliberately not free sliding, which is slapstick. Walking against
the heel is slower, and past about 10° there is a bounded downhill drift. Both
come off the horizontal component of apparent gravity.

Two pieces of collision geometry are authored rather than derived, both for the
reason §6 of the design note gives: catching a capsule on modelled detail feels
terrible and generates edge cases forever. One invisible wall sits a little
inboard of the guardrail, and the ladders to the shelter deck are stacks of
boxes no riser taller than a step — which means the stair-stepping problem is
solved by *not having any stepping code*, since the floor probe simply finds the
next tread. The main battery gets a blockout that trains with the guns, because
sixteen metres of barrel at chest height over the forecastle is otherwise
something you walk straight through.

The figure on deck is a capsule and a ball, standing in for a rigged model. The
simulation deals in a feet position and a heading, so replacing it touches one
file.

Not built yet, and named where they go: space transitions (going over the side
puts you back on deck rather than into the sea), multiplayer, and swimming. The
networking decision that matters is already made, though — everything about the
player is in local coordinates, and a player standing still on a ship making 16
knots through heavy swell is a constant.

```
V            go aboard / back to the sea       WASD   walk
SHIFT        run                               SPACE  jump
CLICK        put a shell into her              1/2/3  AP · HE · torpedo
N            night / day                       R      back to the spawn mark
G            fly (debug)                       ESC    back to the sea
```

Tuning lives in `src/player/spec.js` and is on `poseidon.PLAYER` for poking at
live; `inertiaScale` is the one to turn first (0 is a perfectly steady deck, 0.4
is the default, 1.0 is honest and unplayable).

`node probe-deck.mjs` runs the three build-order checkpoints headless — can a
person get everywhere, is she rock solid on a heaving deck with nothing fed
back, and is the deck still crossable with the inertia on. It costs about 9 µs
per player per frame and takes a couple of seconds to run, which makes it the
fastest way to find out whether a change to her geometry has walled somebody in.

### Destruction test rig — `/test-destruction/`

A second page that exists to make the damage model observable: the same ocean,
the same buoyancy solver and the same ship, stopped and beam-on, with the mouse
wired to a gun. Click to put a shell into her; the panel on the right shows every
component's hit points, fires and flooding live, and logs what each hit struck,
what took the damage and what it cost.

Shells are ballistic and are hit-tested along the segment they swept rather than
at their position, so nothing tunnels through her at 320 m/s. A hit resolves to
the component that owns the mesh it struck — the AA mount on B turret's roof
before B turret itself — and anything with no component of its own (deckhouses,
fittings, guardrail) charges the damage to the compartment underneath.

```
click        fire at the ship        drag  orbit
1 / 2 / 3    AP · HE · torpedo       V     next camera station
R            repair everything       N     night / day
X            breach every compartment (watch her go down)
K            kill all four turrets   P     damage control on/off
```

## Run

```bash
npm install
npm run dev
```

Open the printed URL in a **WebGPU-capable** browser (Chrome/Edge 113+, Safari 18+).
This targets WebGPU only — there is no WebGL fallback.

Helm: `W`/`S` throttle ahead and astern · `A`/`D` rudder · `R` reset the controlled ship ·
`B` move the helm between the launch and the battleship (the battleship is selected at start) · `C` toggle camera
follow · `V` go aboard the battleship on foot · `N` night/day · mouse drag orbits, wheel zooms.

Views (keys): `F` ocean · `5` height map · `1/2/3` cascade spectra.

The destruction test rig is a second page on the same dev server, at
`/test-destruction/`.

## Credits

Spectrum and FFT techniques adapted from
[gasgiant/FFT-Ocean](https://github.com/gasgiant/FFT-Ocean) (MIT), implementing
Tessendorf 2001 (*Simulating Ocean Water*) and Horvath 2015 (*Empirical
Directional Wave Spectra for Computer Graphics*).
