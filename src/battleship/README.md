# Battleship

A 180 m battleship built to be *fought over*: four turrets that train
independently, a hull divided into watertight sections, and a superstructure
whose pieces can be knocked off one at a time — each with a consequence the
rest of the ship has to live with.

She floats on the same buoyancy solver as the launch (`src/boat/Boat.js`) and
is shaded by the same hand-written material as the sea and sky, so she sits in
this world rather than on top of it.

**This is the ship, not the game.** There is no gunnery, no hit detection, no
AI. What exists is the structure those need: named mounts that train and
elevate at real rates inside real arcs, named components that take damage and
report what the ship can no longer do, and a flooding state that feeds straight
back into the buoyancy solver.

## Files

| File | What it owns |
|---|---|
| `spec.js` | Every dimension, position, rate and stat. One source of truth; everything else reads it. |
| `hull.js` | The section curves the hull is lofted from — in JS for the mesh and physics, and again in TSL for the ocean's waterline foam. Builds the hull and deck as five separately-indexed sections. |
| `mounts.js` | Main turrets and AA mounts. One slew/elevate machine, two sizes. |
| `superstructure.js` | Pagoda bridge, funnel, tripod mainmast, deckhouses, boats and derricks, anchors, rudders, screws, watertight doors. |
| `railings.js` | Guardrails round the weather deck: bays and the gangway breaks in them. |
| `debris.js` | What a piece does after it has been knocked off her. |
| `shipMaterial.js` | Two shader programs for the whole ship. |
| `damage.js` | Component graph, flooding, fire, and the capability queries. Pure state; touches no renderer. |
| `fx.js` | Fire and smoke billboards. |
| `Battleship.js` | Assembly. Wires meshes to damage slots and exposes the surface the mechanics will use. |

## Geometry

The hull is a loft of 90 sections. Each section is the curve

```
x = b(s)·sin θ
y = deck(s) − (deck(s) + keel(s))·cos(θ)^p(s)
```

swept from the port sheer through the keel to the starboard sheer, with `s`
running 0 at the stern to 1 at the bow. Four curves shape her:

- `halfBeamAt` — full midbody, rounded cruiser stern, a long fine entry where
  the beam starts coming off almost half a hull ahead of the stem
- `keelAt` — deepest amidships, lifting aft so the screws and rudders tuck
  under, and lifting to the forefoot
- `deckAt` — the sheer, sweeping up 5 m toward the stem
- `sectionPowAt` — section fullness: boxy amidships with a hard bilge, a V
  forward

**Every one of these exists twice**, once in JS and once in TSL (`hullTSL`),
because the ocean shader has to find the same waterline on the GPU to draw the
wash around her. They are written line-for-line next to each other; keep them
in step.

## Watertight subdivision

Five sections, each its own mesh, its own damage component and its own flooding
compartment:

| Section | Stations | Contains |
|---|---|---|
| `hull.stern` | 0.00–0.16 | steering gear, screws |
| `hull.aft` | 0.16–0.38 | X/Y magazines, aft engine room |
| `hull.mid` | 0.38–0.60 | boilers, engine rooms, citadel (armoured, 500 hp) |
| `hull.fore` | 0.60–0.82 | A/B magazines |
| `hull.bow` | 0.82–1.00 | cable locker, stores |

The sections share one vertex buffer and differ only in their index buffer, so
the seams between them are exact — the same vertices — while each still draws,
colours and dies on its own.

## Armament

**Main battery.** Four twin turrets in two superfiring pairs. Each has 150° of
traverse either side of its rest heading and therefore a 60° blind zone behind
it: the fore pair (A, B) is blind astern, the aft pair (X, Y) blind forward.
This is the point of the layout — hull heading decides which turrets bear, so
the helm has a job during a fight instead of just driving.

- traverse 10°/s, elevation −5° to +43° at 6°/s
- B turret carries an AA mount on its roof, which trains with the turret under it

Barbette heights are checked, not guessed. `checkSuperfiringClearance` in
`hull.js` recomputes from the same sheer curve the hull is lofted from whether B
can depress over A's roof and X over Y's, and throws at build time if it cannot.
It has to: the sheer lifts A's station nearly a metre above B's, so the barbette
height that works aft is too short forward.

**AA.** Six twin mounts in tubs — one on the aft deckhouse (the crew station
from the spec), four around the funnel deck, one on B turret. Full 360°
traverse at 70°/s, 0–85° elevation.

Every mount is the same object: a root, a yaw pivot, and elevation pivots
carrying barrels. `setTarget(yaw, elev)` and it slews there at its own rate,
stopping at its arc limits. A mount asked to point into its blind zone goes as
far round as it can and waits — which is the visible signal to the helm to turn
the ship.

```js
ship.aimMainBattery(worldPoint);  // all four turrets, with a gravity arc
ship.canBear(bearingDeg);         // which turrets can actually reach it
```

## Guardrails

A rail is the smallest thing aboard that still has to be right, because it is
what the eye measures the ship against: at 1.07 m it says how big the deck is in
a way that nothing else in view does. So it is built to the real dimensions — a
42-inch top rail, two courses under it, stanchions every 1.85 m — and none of
them is scaled up. The only cheat is the metal itself, drawn a couple of
centimetres thicker than 25 mm bar, because the real thing is thinner than a
pixel at the distance you see this ship from and shimmers rather than draws.

It runs the whole perimeter of the main deck: both sheer lines, closed across the
stem forward and across the transom aft. It is not continuous, for the same
reason a real one is not:

| Break | Station | |
|---|---|---|
| forward gangway | 0.52 | where the brow lands |
| after gangway, at the boats | 0.39 | where the brow lands |
| quarterdeck gangway | 0.20 | where the brow lands |
| cable party, at the hawse | 0.87 | open — the cable runs through it |

Every break is a plain gap, closed at each end by a stanchion so it is bounded by
metal rather than trailing three bars into the air. The gangways used to carry
gates — two leaves meeting in the middle, hinged on the standing rail, swinging
**inboard**, standing open with no way on and shut before she moved. They are
gone. Inboard is the only way a gate in a ship's side can open, and an open one
therefore stood square across the deck, reading as a fence facing inboard rather
than as a gate. Each gangway still lands on a deck, and at the head of each is a
watertight door into the superstructure: coaming to step over, leaf recessed
behind it, hinge straps and the handwheel that drives the dogs.

**One bay — a stanchion and the span to the next — is the unit of both
construction and destruction.** Two hundred bays as two hundred meshes is two
hundred draw calls for a handrail, so the standing bays of each watertight
section are merged into a single mesh, and each carries the damage slot of the
section under it, so the rail chars with the plating it is bolted to without
being a component of its own.

A bay that is destroyed is dropped from the merge and handed to `debris.js` as a
loose body: gravity, a little air drag, a free tumble, no contacts. It leaves
with the ship's own velocity in it, so it falls astern of her rather than
straight down, throws water when it lands (the launch's droplet system — water is
water) and then keeps sinking until the sea, which draws last, has covered it.
There is no fading, because fading needs a material per piece and this ship is
built around not having one.

```js
ship.railings.blastAt(zFrac, side, radius); // what a near miss does to it
ship.railings.wreck('hull.fore');           // what a lost section does to it
ship.railings.restore();
```
Hull damage already drives all three: a section takes a rail away a stretch at a
time as hits land on it, loses the lot when it is destroyed, and has it rigged
again on repair. The **Guardrails** folder in the GUI does it by hand.

## Damage

A battleship is not a health bar. What makes losing one interesting is that she
stops being able to do *specific things*, in an order the enemy chooses. So the
model is a graph of components, each with hit points, armour, and consequences.

**Hits.** `damage.hit(id, { damage, pen, fire, breach })`. Armour scales the
damage rather than blocking it outright, so a light gun chews up AA mounts and
superstructure all day without ever hurting a turret face.

**Fire** eats hit points while it burns, spreads slowly on its own, and is
fought by damage control. A component can burn to death without being hit
again.

**Flooding** is per-compartment. Each breach lets water in at a rate, pumps
take it out, and the resulting water is buoyancy the hull no longer has — fed
back into the solver *per probe and weighted by where the water is*, so
compartments flooded forward put her down by the head. She trims, lists and
eventually goes under on the same physics that floats her; there is no separate
sinking animation.

**Capabilities** are the interface the mechanics should ask, rather than reading
hit points:

| Query | Falls back to |
|---|---|
| `helm` | 1 normally; 0.55 with the bridge gone (conned from aft); 0 with the steering gear gone |
| `propulsion` | ×0.35 with the machinery spaces gone, ×0.7 with the funnel gone, 0 with the screws gone |
| `fireControl` | bridge director → mainmast spotting top (0.6) → local control at the turrets (0.3) |
| `mainBattery` / `aa` | count of mounts still alive |

A kill also shows: the paint blisters and chars through a noise-broken
threshold, turret guns droop at random angles and stop training, and a wrecked
hull section is flagged wide open to the sea.

## Why two materials for 250 meshes

The obvious build gives each mesh its own material — its own colour, roughness
and damage uniform. That is also 250 WGSL compiles of a large node graph, which
costs seconds *per frame* and simply stops the app. Everything that varies per
part is therefore moved off the material:

- **colour** → per-vertex `color` attribute
- **roughness** → per-vertex `rough` attribute
- **damage** → `dmg[i]`, a uniform array indexed by a per-vertex `dmgIndex`

The ship carries no procedural surface pattern at all — no plank seams, no paint
grain. At this size both read as a crawling texture rather than as a surface;
shape and shading carry her instead.

`paint(geometry, { color, roughness, slot })` bakes those in. The result is two
programs for the entire ship: body, and deck (identical, but double-sided so the
deck ribbon is lit from below when she heels).

If you add parts, use `materials.body` / `materials.deck` and `paint`. Never
build a material per mesh.

## Trying it

Press **B** to move the helm between the launch and the battleship; WASD
drives whichever you are on. The **Battleship** folder in the GUI has:

- **Gunnery** — sweep a target bearing and watch the blind zones bite
- **Damage** — put a shell into any named component, take a salvo, torpedo her
  forward, or repair everything

## What the mechanics still need to add

1. Shells: muzzle positions are already exposed (`mount.muzzles()`), as are
   shell speed and the gravity arc in `spec.js`.
2. Hit detection: map a world impact point to a component id.
   `damage.compartmentAt(zFrac)` covers the hull; mounts and superstructure want
   a bounding-volume test per part.
3. Recoil: `hull.AddForceAtPosition(-fireDir · impulse, muzzleWorld)` — the
   buoyancy solver already takes impulses, so she will rock and settle on her
   own.
4. Crew stations and seat swapping, per `battleship-crew-stations.md`.
