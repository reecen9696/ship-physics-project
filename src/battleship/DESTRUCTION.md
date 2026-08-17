# Ship destruction — design

*Companion to `README.md`. This is the plan for turning "a component's slot goes
grey" into a ship that gets holed, floods through the holes, sheds her funnel
onto her own deck, and breaks where the shells actually hit her.*

---

## 0. What we have, and why it reads as fake

Reading the code as it stands:

| Piece | Today | What it looks like |
|---|---|---|
| Damage shading | One float per component (`dmg[slot]`), a noise-broken threshold in `boatMaterial.js` scorches the *whole* part | The whole bow section goes dark; nothing says *where* it was hit |
| Kill | `onKill`: guns droop, rail wrecked, `breach = 1` | Preset. Every dead funnel is the same funnel, still standing |
| Flooding | `breach` 0..1 → constant inflow; one ship-wide `flood`/`floodZ` pair biases the six probes fore/aft | She trims and sinks evenly; no list, no visible water, no relation to hole position |
| Wreckage | `debris.js`: rail bays only, gravity + drag, no contacts, sinks | Nothing big ever leaves her, nothing lands on her |
| Burst | Flame/smoke sprites + spray at the hit point | Fine as far as it goes; there is no *hole* left behind |

The good news is that everything structural about the build is right for what
we want and does not have to be undone:

- **Two shader programs for the ship** (`shipMaterial.js`). Every new visual
  below is designed as *one more texture sample and one more per-object uniform*
  in those programs — never a material per part.
- **The hull is one vertex buffer with per-section index buffers.** That is
  exactly the shape you need to (a) parameterise the hull surface for damage,
  (b) split her in two later without touching vertices.
- **The section curves are analytic and exist in JS.** Compartment volumes,
  hole depths, an inside/outside test for wreckage landing on the deck, and the
  internal water surface all fall out of `section(s,u)` / `sideAt(s,y)`.
- **The buoyancy solver takes forces at offsets** (`applyAt`). Realistic
  flooding is *water as weight at its centroid*, which is one call.
- **`damage.js` is a pure state graph with capability queries.** Keep it. It
  stops being the *look* of damage and becomes what damage *means* (helm, fire
  control, propulsion). The look moves to a field.

## 1. Principles (what "realistic" is being taken to mean)

1. **Damage lives where the shell landed**, not on the component. The unit of
   damage is a *wound* — a point, a radius, a severity — not a component id.
2. **Metal is removed, not recoloured.** A hit leaves a hole with a torn, bare
   rim you can see through into a dark interior. Scorch is the halo around a
   hole, not the damage itself.
3. **Structure fails where it is weakest, wherever that turns out to be.** A
   funnel shot through at 60 % height breaks at 60 % height. There are no
   pre-cut pieces.
4. **Anything that leaves the ship is a body in the world.** It falls under
   real gravity, it lands on whatever is under it, and what it lands on takes
   the hit. Chain reactions are emergent, not scripted.
5. **Falling time is not tuned.** `g = 9.81`, real dimensions. A 30 m mast
   takes four-plus seconds to come down and its tip arrives at ~30 m/s; that
   *is* the "slow at this scale" look, and it comes for free once nothing is
   scaled.
6. **Flooding is water through holes.** Rate from hole area and head, into a
   compartment whose volume comes from the actual hull, weighing on the ship
   at its actual centroid. Trim, list, free-surface loss of stability,
   progressive flooding and the final plunge are consequences, not states.

## 2. The pipeline

Every damaging event — shell, torpedo, magazine, a funnel landing on an AA tub —
goes through the same door:

```
strike({ point, dir, kind, energy })
   │
   ├─ resolve: which frame is it in (ship / turret.B / …), which component is under it
   │
   ├─ wound = { centre, rRemove, rScorch, severity, frame, t }
   │      │
   │      ├─► DAMAGE FIELD   stamp into the 3D volume (or the puncture list)      → the look
   │      ├─► STRUCTURE      component HP, spine sections, joint integrity        → sever / topple / capability
   │      ├─► FLOODING       if it opens the skin: hole { compartment, y, area }  → inflow
   │      └─► BURST          flash, fireball, smoke, shards, splinters, splash
   │
   └─ chain: a sever spawns a wreck body → contact → strike(...) again
```

Four new modules, one per branch, and a small `strike` router in
`Battleship.js`. `damage.js` stays; `debris.js` grows into `wreck.js`.

```
src/battleship/
  damageField.js   the volume + puncture list, compute stamp, decay, shader hooks
  structure.js     structural bodies, spines, joints, sever, topple, chains
  wreck.js         rigid bodies with contacts against the ship (replaces debris.js)
  colliders.js     ship-local collision proxies + hull inside/outside from the loft
  flooding.js      compartment volume tables, holes, inflow, spill, pumps, centroids
  interior.js      inner decks, frames, per-compartment water planes
  burst.js         the explosion recipes (uses fx.js, hullSpray, wreck shards)
```

## 3. The damage field — holes where the hits are

### 3.1 Representation

**A 3D texture in ship-local space covering the whole ship**, sampled per
fragment. It replaces the per-slot scalar as the thing the shader reads.

- Bounds: x ±16 m, y −10 … +50 m (keel to foretop), z ±92 m.
- Format `rgba8unorm` as a `Storage3DTexture` (writable from compute, sampled
  with trilinear filtering). Channels:
  - **R removed** — 0..1, "how much of the material here is gone"
  - **G scorch** — the burnt/blistered halo
  - **B heat** — 1 at the instant of a hit, decayed by a slow compute pass;
    drives the emissive glow on torn edges and the fire emitters
  - **A soot/wet** — spare; oil, soot streaking below fires
- Resolution 0.5 m → 64 × 120 × 368 = 2.8 M texels = **11 MB**. 0.4 m is
  22 MB. Start at 0.5; the shader noise supplies the ragged sub-texel edge, the
  volume only has to carry the low-frequency crater.

**Why a volume and not per-vertex or per-mesh state:** it is one sample in one
program, it is frame-independent of how the ship is meshed (a hole through the
side plating also holes the internal deck behind it and the scuttle sitting on
it — they are all just geometry passing through the same region), and it makes
"round / real explosion location" literal: the crater is a sphere in space, and
whatever geometry crosses it is what gets removed.

**Punctures — the small, sharp things.** AP entry holes are ~0.5 m; at 0.5 m
voxels they blur into blobs. So alongside the volume there is a short uniform
array of punctures (`≤ 48`, ring-buffered): `{ centre, radius, normal, frame }`,
tested per fragment as discs — sharp round holes with a petalled rim. This list
also carries **anything on an articulated frame**: turrets and AA mounts rotate,
and a wound stamped in ship space would smear across a turret as it trains. So
the volume is *ship frame only*; a mount's damage lives in the puncture list in
the mount's own frame (a `frameOf[slot]` uniform array maps a vertex's
`dmgIndex` to a frame matrix — ship, four turrets, six AA). Turrets are armoured
box structures anyway: they take punctures, scorch and dents, and the *big*
turret events (gunhouse blown off the barbette) are structural, not field.

### 3.2 Stamping

A hit does one compute dispatch over the wound's bounding box (a 3–15 m sphere
is 200–30 000 voxels; trivial):

```
removed  = max(removed, sat(1 - d/rRemove) * severity * (1 + 0.35 * fbm(p)))
scorch   = max(scorch,  sat(1 - d/rScorch))
heat     = max(heat, 1 - d/rScorch)
```

with `p` the voxel's ship-local position and `d` its distance to the crater
centre. The crater centre is the hit point pushed *inward* along the incoming
direction by the shell's penetration (a burst on the far side of the plating
is what makes a hole rather than a scoop). A hollow-shell result comes for
free: the hull is a skin, so a sphere through it removes a disc of skin.

Every ~0.25 s a decay pass runs `heat *= 0.94` over the whole volume (2.8 M
texels; nothing).

The wound is also kept CPU-side in a list. **The CPU list is the source of
truth** for structure and flooding; the volume is a render of it. Nothing ever
reads the volume back.

### 3.3 Shading

In the body/deck/glass programs, per fragment, in ship-local position `p`
(a varying: `worldToShip * worldPosition`, `worldToShip` updated per frame):

1. `f = volume(p)`; `hole = f.r > 0.5 + 0.18 * noise(p * 6)`  → **`Discard()`**.
   Same test in `material.castShadowNode`, or every hole casts a solid shadow.
2. **Torn rim**: `rim = smoothstep(0.30, 0.50, f.r)` (just outside the discard
   band) → colour → bare steel `[0.30,0.31,0.33]`, `rough → 0.75`,
   `metal → 1`, plus emissive `vec3(1.0,0.35,0.08) * f.b² * rim` for the
   still-hot edge. Rim gets a bit of `noise` displacement in colour so it reads
   as petalled/curled plate rather than a clean cut.
3. **Scorch**: the existing scorch/soot code, driven by `f.g` (wide halo,
   noise-broken) instead of `dmg[slot]`. `dmg[slot]` is demoted to a light
   grime tint capped at ~0.25 — a working-over should leave a part looking
   worn, not painted black.
4. **Punctures**: loop the list (`≤ 48` sphere-disc tests; skip entries not in
   this fragment's frame). Inside radius → discard; the ring `r..1.35r` → bare
   metal petals with a dark inner edge.
5. **Backfaces = interior**. Hull, deckhouse plates and the funnel go
   `DoubleSide` and branch on `frontFacing`. The inside is: no sky reflection,
   flat dark steel lit only by ambient, a procedural frame/stringer pattern
   from ship-local `z` (frames every 1.2 m — cheap stripes), darker with depth
   below the deck. Through a hole in the side you see the inside face of the
   far plating, not the sea beyond her.

### 3.4 Interior (`interior.js`)

Enough inside her that a hole is a hole into *something*:

- Two dark internal deck slabs per compartment (a lower deck at ~+2.5 m, the
  tank top at ~−6 m), one mesh, body material, dark colour, `dmgIndex` of the
  compartment. They live in the same volume, so a burst that comes through the
  side also holes the deck behind it.
- **The internal water surface**, one quad per compartment at the flooding
  model's water level, tilted to world-level, clipped to the compartment's
  station range and to the hull's half-breadth at that height. Dark green-black,
  a small ripple normal, a slow slosh lag behind heel. This is the "you can see
  it flooding" shot: look in through the torpedo hole and there is black water
  climbing the frames.
- Fire and smoke emit from **wound positions** (heat channel > threshold), not
  from the five hard-coded `fireOrigins`.

## 4. Structure — things that fall over and fall off

### 4.1 Structural bodies

Every above-deck unit becomes a **structural body**:

```js
{ id, mass, com, footprint: { centre, radius | box }, height,
  attachedTo: 'hull.mid' | 'deckhouse.funnelDeck' | 'turret.B' | …,
  joint: { hp, integrity: 1 },
  spine: null | { a, b, r, sections: Float32Array(N) } }
```

- `attachedTo` builds an attachment tree: bridge → hull.mid; funnel → shelter
  deck → hull.mid; mainmast → aft deckhouse → hull.aft; AA.2–5 → shelter deck;
  AA.1 → aft deckhouse; AA.6 → turret.B roof; boats/derricks → their deckhouse.
  Losing a parent takes the children (the shelter deck blown open drops the AA
  tubs standing on it into the crater).
- **Joint integrity** is eaten by wounds within reach of the footing:
  `integrity -= Σ severity * overlap(wound, footprintRing)`. Below zero the
  body **detaches** — the whole thing goes.
- **Spines** are for anything tall and thin: funnel, mainmast legs and pole,
  bridge column and topmast, gun barrels, derricks. A spine is a segment with N
  sections along it, each with a strength; a wound within `r + rRemove` of the
  spine at height `h` reduces the sections it overlaps. Any section < 0 →
  **sever at `h`**. That is the "shoot the chimney enough and it breaks off":
  a funnel with 3 HE hits at 8 m up breaks at 8 m up, and the same funnel hit
  at the base falls whole. Nothing is pre-cut.

Debris impacts (a wreck body landing on something) go through the same
`strike()` with `energy = ½mv²`, so a body landing on a joint can sever it —
that is how the funnel takes the mainmast with it, without a rule that says so.

### 4.2 Severing without cutting meshes

A sever at height `h` in the unit's frame:

- The stump keeps the unit's meshes and gets `userData.cut = { y: h, sign: -1 }`.
- The falling piece is a **clone of the same meshes** (shared geometry, no
  buffer copies) under a new pivot, `userData.cut = { y: h, sign: +1 }`, handed
  to `wreck.js`.
- The shader has one more per-object uniform — `cutY`, `cutSign` — bound with
  `uniform(...).onObjectUpdate(({ object }) => object.userData.cut …)`, so it is
  read per draw from the object, **still one program**. `Discard()` above/below
  the plane, with the same noise wobble as the holes so the break is ragged.
  Backfaces render dark, so a severed funnel shows a hollow bore and a severed
  column shows a dark cross-section, which is right.

No triangle splitting, no caps, and it works on every primitive the ship is
built from. (If a clean capped cut is ever wanted for a specific case, a plane
slice of Box/Cylinder geometry is ~150 lines — but ragged is the look.)

### 4.3 Toppling

A severed or detached body is a rigid body in `wreck.js`:

- **Phase 1 — hinge.** For the first part of the fall it is pinned along the
  tear-away edge on the far side of the cut from the blast (the side the plating
  hasn't torn yet): an inverted pendulum with `I = m L²/3`,
  `α = (3g / 2L) sin θ`, plus the blast's initial angular kick. It releases to
  free 6-DoF once it has rotated ~30° or the hinge force goes into tension.
  This is what makes it *fall over* rather than *drop*.
- **Phase 2 — free body.** Semi-implicit Euler at the boat's 120 Hz substep,
  quaternion integration, box-approximated inertia tensor, the existing air
  drag. It leaves with the ship's velocity in it (as rails do now).
- **Times you get with nothing tuned:** funnel (13 m) from a small nudge, ~2.5–3 s
  to horizontal, tip at ~20 m/s; mainmast (30 m) ~4–5 s, tip at ~30 m/s; free
  drop from the foretop (45 m) 3.0 s. Big, slow, heavy — because the numbers are
  real, not because there is a slow-motion factor. **Do not add one.**

### 4.4 Landing on the ship — contacts

`colliders.js` gives the ship a set of analytic proxies in ship-local space,
each tagged with the component it belongs to:

- the hull itself: inside/outside from `sideAt(s, y)` / `deckAt(s)` /
  `keelAt(s)` — a query `hullDistance(p) → { d, n }` from the loft curves,
  no mesh
- the weather deck plane (with sheer), the deckhouse boxes, barbettes and
  gunhouse boxes, the bridge column cylinder and blockhouse boxes, the funnel
  cylinder, the mast tripod as capsules

Wreck bodies carry 8–12 sample points (bbox corners, mid-edges, spine ends).
Each substep: points → ship-local → query the proxies → penalty spring +
damping + Coulomb friction (μ ≈ 0.4), low restitution. First contact at speed
above a threshold → `strike()` at the point with `energy = ½mv²`: crush stamp in
the volume, `damage.hit` on the component under it, sparks/dust burst. Then it
settles, slides, or rolls off — the deck's camber and the flare of the hull do
that on their own; a body at rest on deck **sleeps** (reparented under the ship
so it rides with her without jitter) and wakes when she rolls past a threshold,
at which point it slides over the side into the existing sink-and-retire path.

Cap: ~24 awake bodies. This is a few hundred lines of hand-rolled physics with
no broadphase and no body-body contact (wreck hits *ship*, not other wreck),
which is the level of fidelity the rest of the sim is written at. Escape hatch
if it grows teeth: rapier (WASM, ~2 MB) with the ship as a kinematic compound.

### 4.5 The bigger discrete events

Not preset destruction — but some things happen as *events* because that is
what they are:

- **Turret gunhouse blown off** on a magazine hit (AP, high pen, into a turret or
  its section, probability rising with damage): the gunhouse becomes a wreck
  body launched upward at 10–20 m/s with spin, the barbette stays as an open
  ring (a stump cut), the volume gets a huge stamp, fire from the barbette.
- **Barrels sever** like any spine (a shot-through gun droops now; it can also
  be blown off).
- **Hull breaks in two.** A magazine blast that removes a full band of hull
  around a section boundary → the hull sections either side are regrouped under
  two roots, each with a `Boat` solver on a truncated hull descriptor
  (`stations 0..s_cut` and `s_cut..1`; the descriptor is already how the solver
  is parameterised) with mass split by volume, and an open end that is a 100 %
  breach into the end compartment. The per-section index buffers over one vertex
  buffer make the split a regrouping, not a rebuild. Stretch goal — Stage 4 —
  but the architecture already allows it and it is the single most convincing
  thing a battleship can do.

## 5. Flooding — water through holes

### 5.1 Compartments from the loft

At build time, for each of the five compartments, integrate the section curves
into tables:

- `V(y)` — volume below hull-local height `y`, keel to main deck (0.25 m steps)
- `A(y)` — waterplane area at `y`, `b(y)` — half-breadth at the mid station
- the mid-station polygon (the 23 loft points) for the tilted-water centroid

Rough magnitudes: `hull.mid` ≈ 40 m × 29 m × 14.5 m × 0.85 block ≈ 14 000 m³
below the deck; the whole hull ≈ 60 000 m³; the ship displaces 42 000 m³.

### 5.2 Holes and inflow

Every wound that opens the skin (the wound sphere intersects the loft surface,
tested against the section curve at stamp time) becomes one or more
**holes**: `{ compartment, y (ship-local), x side, area }`. Area ≈ π rRemove² for
a burst, the puncture disc for AP, ~30 m² for a torpedo.

Each substep, per hole, with the outer water height at the hole from the
solver's fitted sea plane in ship frame (so heel and trim matter — a hole on
the high side comes out of the water as she lists), and the compartment's
internal level `y_w`:

```
head  = outerLevel(hole) - max(y_w, y_hole)        // > 0 in, < 0 out
Q     = 0.6 * area * sqrt(2 g |head|) * sign(head)  // Torricelli, Cd ~ 0.6
```

Outflow is real: a compartment flooded to above a hole on the side that lifts
as she rolls **pours water back out** — spouts from the holes, which the spray
system already knows how to draw.

Numbers, unscaled:

| Hole | Depth | Q | Fills `hull.mid` in |
|---|---|---|---|
| HE burst 1.5 m² | 2 m | 5.6 m³/s | ~40 min |
| Two HE + list dips them to 4 m | 4 m | 16 m³/s | ~15 min |
| Torpedo 30 m² | 5 m | 180 m³/s | ~75 s |
| Broken back, open end 150 m² | 6 m | 980 m³/s | ~15 s |

That is honest and, for torpedoes and magazines, already dramatic. Shell holes
at the waterline flood slowly in reality too. A single `floodScale` knob
(default 1; 3–5 makes shellfire decisive) is the only concession — never
per-hole rates.

**Emergent, and worth calling out:** as she settles, holes that were above the
waterline go under; as she lists, more open on the low side and close on the
high side. Flooding accelerates on its own, and it does it in the direction the
enemy shot her.

### 5.3 Progressive flooding, down-flooding, pumps

- **Spill**: internal level above the compartment's bulkhead top (main deck at
  the boundary station) → flow into the neighbour ∝ `sqrt(head over sill)`
  through a fixed door/hatch area.
- **Down-flooding**: the outer waterline anywhere over a compartment reaching
  the deck edge (deck edge immersed — the fitted plane vs `deckAt(s)` on the
  low side) opens a large area (hatches, ventilators) into that compartment.
  This is what actually sinks ships and it gives the accelerating final plunge
  without any "sinking" logic.
- **Pumps**: fixed m³/s per compartment × `dcEffort`, zeroed for a destroyed
  compartment. Realistic pump capacity (a few hundred t/h) cannot keep up with
  any hole that matters, which is correct.

### 5.4 Coupling to the ship — water as weight

Replace the probe-buoyancy bias with the **added-weight method**: each
compartment's water is a mass `ρ V_flood` at its centroid, applied through
`applyAt(−m g ŷ, r_centroid)` every step. The centroid is computed honestly:
clip the compartment's mid-section polygon by the (world-level, ship-tilted)
water line, take area and centroid of the wet part, extrude over the
compartment length. Twenty lines, five compartments, 120 Hz — nothing.

What falls out:

- **Trim and list** from where the water is, forward/aft *and* port/starboard.
- **Free-surface effect**: the wet centroid shifts to the low side as she
  heels, which is a heeling moment that grows with heel — the loss of
  stability that partly-flooded compartments cause. For `hull.mid`
  (40 × 29 m) `i = l b³/12 ≈ 81 000 m⁴`, GM loss ≈ `ρ i / Δ ≈ 1.9 m` — a
  large fraction of her stability from *one* half-flooded machinery space.
- **She goes under** because weight beats buoyancy, not because a `flood`
  number crossed 0.55.

Two things the solver needs so that this can end properly:

1. **Buoyancy must saturate at the hull, not at `maxDepth`.** Currently probe
   immersion clamps at 12 m; once fully submerged with weight > buoyancy she has
   to keep going. Immersion beyond the deck adds no buoyancy (already the
   deck-edge down-flooding case) and beyond a foundering depth she is retired.
2. **She must be able to capsize.** Six probes at fixed offsets are linear
   springs and give a righting moment that never turns over. Real GZ peaks near
   35–45° and vanishes by 60–70°. Cheapest fix that keeps the probes: scale each
   probe's effective area by an immersion-shape factor that decays once the
   deck edge on that side is under (the waterplane can't get any wider than the
   hull), so the restoring couple flattens and, with the free-surface term and
   flood water high in the hull, reverses. Then a badly listed ship rolls over
   the way one does, and the deck-edge under → down-flooding → over sequence is
   the same one that put real ships on the bottom.

### 5.5 Seeing it

- The internal water planes (§3.4) through every hole.
- Inflow at holes near the surface: the water "boils" — spray/foam bursts at
  the hole where air is escaping.
- Outflow spouts on the high side as she rolls.
- She sits deeper; the ocean draws last with depth, so an awash deck simply
  *is* under the sea, and the existing hull-contact foam rides the new
  waterline.
- List, then a lurch as a bulkhead spills, then the deck edge goes under.

## 6. The burst

`burst.js` owns the recipes; everything is existing systems plus a shard pool.

| Kind | Removal | Scorch | Look |
|---|---|---|---|
| **AP** | puncture disc r 0.3–0.5 m, pushed inward by `pen` | small | flash, brief smoke, spall spray *inside*; if it goes into a magazine → *magazine* |
| **HE** | sphere r 2–4 m at the skin | 2.5× | flash sprite (0.15 s, additive), fireball (existing flame, bigger/faster), heavy smoke, shock ring, 6–14 plate shards, deck splinters if on teak |
| **Torpedo** | sphere r 6–8 m, mostly below the waterline | 1.5× | 40 m water column (existing splash, huge), then the hole and the boil |
| **Magazine** | band r 12–18 m | whole section | everything above, gunhouse launched, fire from the barbette, hull sever check |
| **Debris impact** | crush stamp r ∝ energy | small | dust, sparks, a metallic bounce splash on the sea |

**Shards** are the removed plating made physical: an `InstancedMesh` pool
(~400) of a few plate-chunk shapes on the body material, thrown from the crater
with the blast direction + spread, gravity + drag, no contacts, sink on landing.
Cheap and it is what sells "blown off" — the hole opens *and* something flies.

Fire afterwards comes from wounds with `heat > 0.6` on a component that is
burning, and burning components are those with recent wounds — the
`fireOrigins` map goes away.

## 7. What changes in what exists

- `damage.js` — keeps components, HP, capabilities, `hit()`. Gains
  `strikeAt(componentId, energy)` for debris and joint accounting. `breach`
  goes; flooding moves to `flooding.js` and `update()` reads it back for the
  capability queries. Its `damage.value` scalar stays as the light grime tint.
- `shipMaterial.js` / `boatMaterial.js` — the volume sample, the puncture
  loop, `Discard`, torn-rim and heat, `frontFacing` interior branch, per-object
  `cut` uniform, `castShadowNode` running the same discard. Still body / deck /
  glass — three programs.
- `Battleship.js` — the `strike()` router; wires structure, flooding, wreck,
  interior; `fireOrigins` removed; hull sections marked `DoubleSide`.
- `debris.js` → `wreck.js` — same spawn/sink/retire life cycle, plus inertia,
  hinge phase, contacts, sleep, `strike` on impact. Rails keep using it.
- `Boat.js` — added-weight flooding hook (`flooding.forces(step)` → `applyAt`),
  buoyancy saturation at the hull, the capsize shape factor, founder/retire.
- `spec.js` — mass and footing per unit; spine definitions; hole area per shell
  kind; pump capacity; door/hatch spill areas.
- Test rig — the shell hit hands `strike()` a point and direction (it already
  has both); readout gains per-compartment level / m³ / inflow / holes; keys for
  "sever funnel here", a volume slice view, and `floodScale`.

## 8. Build order

Each stage is shippable and visible on its own; each later stage stands on the
one before.

**Stage 1 — the field.** `damageField.js`, shader hooks, interior slabs,
backface interior, shards. *You see:* real holes with torn glowing rims wherever
you shoot, scorch as a halo, into a dark interior; plate flying. This alone
kills "panels go grey" and is the largest single visual step. Risk: the shadow
pass discard; the turret frame mapping.

**Stage 2 — flooding.** `flooding.js`, added-weight coupling, internal water
planes, spill/down-flooding, solver saturation + capsize factor. *You see:* the
torpedo hole with black water rising inside it, list toward the hit, spouts as
she rolls back, the deck edge going under, the plunge — or the roll-over.

**Stage 3 — structure.** `structure.js`, `colliders.js`, `wreck.js` upgrade,
sever/topple/contacts/impact-strike. *You see:* the funnel breaks where you shot
it, hinges over in three slow seconds, lands across the aft deckhouse and
crushes the AA tub, kills the mount, rolls off the side; the mast comes down on
the quarterdeck; the shelter deck blown open drops what stood on it.

**Stage 4 — the big events.** Gunhouse launch, magazine, hull sever into two
floating halves.

Rough relative sizes: Stage 1 ≈ 1, Stage 2 ≈ 1, Stage 3 ≈ 1.5, Stage 4 ≈ 1
(the hull split is most of it).

## 9. Risks, decisions, knobs

- **Shadow pass discard.** Node materials build their own depth program; the
  hole test must also run in `castShadowNode` or holes cast solid shadows.
  Verify early in Stage 1.
- **Volume memory / sampling.** 11 MB at 0.5 m is fine; if the sub-texel look
  isn't good enough, go to 0.4 m (22 MB) before adding any second field.
- **Articulated frames.** The `frameOf[slot]` map is the one place the
  "one program" rule gets fiddly. If it fights, turrets fall back to punctures
  + slot scorch only, and lose nothing important.
- **Rigid-body stability.** Penalty contacts at 120 Hz with heavy bodies want a
  soft-ish spring and enough damping; clamp penetration correction per step.
  Body-body contacts are deliberately out.
- **Sleeping on a moving deck.** Reparent-while-asleep is a hack that works;
  wake threshold on the ship's angular acceleration and heel.
- **Flood rate realism vs play.** `floodScale`, default 1. Torpedoes and
  magazines are already right at 1; a shell duel that has to sink a ship by
  waterline hits alone wants ~4. Nothing else about the water model is a knob.
- **The ocean's hull-foam shader** uses the analytic hull and won't see holes.
  Correct — the waterline is still where the hull is — and irrelevant once she
  settles.
- **What we are not doing:** per-mesh materials; voxelising the ship geometry;
  a general-purpose physics engine (yet); scaling gravity or time for effect.

---

*In one sentence: damage becomes a field in space rather than a number on a
part; structure fails through that field wherever it is thin; anything that
lets go is a real body that lands on real things; and water gets in through the
actual holes and weighs what water weighs.*
