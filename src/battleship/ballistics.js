// The shell, and what happens to it between the muzzle and the target.
//
// There is one shell. A battleship's main battery fires one round out of one
// gun, and the three-way ammunition switch this project used to carry was a
// test rig's convenience rather than anything a ship has: a turret is loaded
// with what the magazine sent up and the layer does not choose it in the middle
// of a salvo. So AP is what is in the hoist, and everything below describes that
// one projectile.
//
// --- why this is a module and not four lines in the gunnery ------------------
//
// Because the interesting part of naval gunnery is not the impact, it is the
// eleven seconds before it. A shell leaves the muzzle at 400 m/s and arrives
// somewhere else entirely: it falls the whole way, it is slowed by air that
// thins as it climbs, its drag jumps as it comes back down through the speed of
// sound, and the wind moves it sideways for the whole of its flight. At two
// kilometres that is five seconds in the air and thirty metres of drop; at eight
// it is twenty-two seconds and six hundred metres of it. None of that is a
// detail you can bolt on afterwards, because the *aim* is derived from it — the
// elevation that puts a shell on a target is the answer to the trajectory, and
// if the sight and the shell disagree about the trajectory the gun does not
// shoot where the plate says it does.
//
// So there is exactly one integrator here, and everything asks it: the shells in
// the air, the firing table behind the AIM DISTANCE plate, the aim-off for a
// shot taken from the eye, and the ship's own fire control. They cannot come
// apart, because there is nothing for them to come apart from.

const G = 9.80665;

// --- the projectile ----------------------------------------------------------
//
// A 16-inch armour-piercing shell: 1225 kg, 406 mm, a little under four and a
// half calibres long, with a hardened cap under a thin ballistic windscreen.
// Mass and calibre are the real ones because they are what the drag is computed
// from — the shell's sectional density is the whole of its ballistic character,
// and inventing it would mean inventing the trajectory too.
//
// The muzzle velocity is *not* the real one. A real 16"/45 throws this shell at
// 790 m/s and puts it 35 km away, and this world is 180 m of ship on a piece of
// sea you can see the end of: at that velocity every engagement here is a flat
// shot needing a tenth of a degree of elevation, and the gun becomes a laser.
// 400 m/s is the number that puts the whole of the ballistics inside the ranges
// this world actually fights at — a degree and three quarters at a thousand
// metres, seven and a half at four thousand, and fourteen kilometres at the stop.
// It is the one deliberate lie in the file and it is the one that makes the rest
// of it visible.
export const SHELL = {
  key: 'AP',
  name: 'armour piercing',
  caliber: 0.406, // m
  length: 1.78, // m, over the windscreen
  mass: 1225, // kg
  muzzle: 400, // m/s at the muzzle
  // What the damage model wants. `wound` names the entry in WOUNDS (spec.js)
  // that says how big a crater this tears, how wide it burns and how much of a
  // hole it leaves for the sea.
  wound: 'AP',
  damage: 118,
  pen: 26,
  fire: 0.10,
  breach: 1.0,
  // The propellant, and the reason the gun's shove is bigger than the shell's
  // own momentum. A 16-inch charge is about a fifth of the shell's weight and it
  // leaves the muzzle as gas at appreciably more than the shell's speed, so the
  // gun is pushed by both. The usual allowance is the charge times about 1.3
  // times muzzle velocity; leaving it out under-reads a battleship's recoil by
  // very nearly a third, which is not a rounding error.
  charge: 290, // kg of propellant
  gasSpeed: 1.3, // ...leaving at this multiple of the muzzle velocity

  // How much of the gun's shove she feels, per gun. Kept here rather than in the
  // laying because it is a property of the round: this much mass leaving at this
  // much speed is what the recoil *is*.
  get momentum() {
    return this.mass * this.muzzle + this.charge * this.gasSpeed * this.muzzle;
  },
};

// --- and the other projectile ------------------------------------------------
//
// The stern mounting's round. There is one of these too, for the same reason
// there is one shell: an automatic is fed from a belt and the layer does not
// pick what is in it.
//
// Everything that makes it behave differently from the 16-inch round is in two
// numbers — its mass and its calibre — and the difference is enormous. Sectional
// density, mass over frontal area, is what decides how fast a projectile is
// eaten by the air: the AP shell has 7,400 kg/m^2 and this has 760, a tenth of
// it. So it leaves fifty per cent faster and is down to half speed inside four
// seconds, which is exactly why an automatic gun is a short-range weapon and no
// amount of muzzle velocity fixes that.
//
// The muzzle velocity is a *real* one, unlike the main battery's. The lie in
// SHELL.muzzle exists to bring a 35 km gun down into a world you can see across;
// this gun's honest 850 m/s already puts its useful range at two or three
// thousand metres, which is exactly where the fighting here happens.
//
// `fuze` is the round destroying itself in the air, and it is the thing that
// makes AA fire look like AA fire. A tracer round that missed does not fly on
// for ever and come down on somebody: it is built to burst at the end of its
// useful run, and what you see is the sky ahead of the aeroplane filling with
// black puffs. Without it you get a hosepipe of sparks going off to infinity,
// which is a firework and not a gun.
export const AA_ROUND = {
  key: 'HE-T',
  name: 'high explosive tracer',
  caliber: 0.040, // m
  length: 0.30,
  mass: 0.96, // kg
  muzzle: 850, // m/s
  fuze: 4.4, // s to self-destruct
  // How long the composition in its base actually burns. Shorter than the fuze
  // on purpose and true of the real thing: the last second of the run is a dark
  // round nobody can follow, and then it goes off. That gap is what makes a sky
  // full of these read as *flak* — puffs appearing out of nothing — rather than
  // as a firework where every spark ends in a bang you watched arrive.
  tracerLife: 3.2, // s
  wound: 'FLAK',
  damage: 7,
  pen: 3,
  fire: 0.03,
  breach: 0.12,
  // The trace. A tracer is a lamp on the back of the round burning the whole way
  // out, and it is far and away the brightest thing about the gun: at any range
  // past a few hundred metres it is the *only* thing you can see of the round.
  tracer: [1.0, 0.72, 0.30],
  // Proportionally more gas than the big gun — a light shell out of a long case
  // is most of a boot in the shoulder. See SHELL for what this is.
  charge: 0.31,
  gasSpeed: 1.4,
  get momentum() {
    return this.mass * this.muzzle + this.charge * this.gasSpeed * this.muzzle;
  },
};

// Frontal area, m^2 — cached on the projectile the first time anything asks, so
// the integrator is not doing a squaring and a multiply by pi per substep.
const areaOf = (proj) => {
  if (proj._area === undefined) proj._area = Math.PI * (proj.caliber / 2) ** 2;
  return proj._area;
};

// --- the air -----------------------------------------------------------------
//
// Density falls off exponentially with height, which matters because a shell at
// full elevation spends most of its flight above two kilometres where there is
// three quarters of the air there is at the waterline. The speed of sound falls
// with temperature over the same climb, which matters for the drag below.
const rho = (y) => 1.225 * Math.exp(-Math.max(y, 0) / 8500);
const soundSpeed = (y) => 20.05 * Math.sqrt(Math.max(288.15 - 0.0065 * Math.max(y, 0), 216.65));

// Drag coefficient against Mach number, for a long-ogive capped shell.
//
// This curve is the reason a shell is not a thrown stone. Below about Mach 0.85
// a well-shaped projectile is astonishingly slippery — Cd 0.12, less than a
// modern car — and then the shock forms and it more than doubles in the space of
// a tenth of a Mach. Our shell leaves at Mach 1.18 and decelerates *hardest* in
// the first second, drops through the transonic hump on the way up, and coasts
// the rest of its flight in the cheap subsonic regime. That is why the impact
// velocity at long range is barely lower than at short: everything expensive
// happened at the start.
const CD = [
  [0.00, 0.120], [0.70, 0.120], [0.85, 0.140], [0.95, 0.220],
  [1.02, 0.300], [1.20, 0.290], [1.50, 0.260], [2.00, 0.230], [3.00, 0.200],
];

function dragCoefficient(mach) {
  if (mach <= CD[0][0]) return CD[0][1];
  for (let i = 1; i < CD.length; i++) {
    if (mach <= CD[i][0]) {
      const [m0, c0] = CD[i - 1];
      const [m1, c1] = CD[i];
      return c0 + ((c1 - c0) * (mach - m0)) / (m1 - m0);
    }
  }
  return CD[CD.length - 1][1];
}

// The one number the whole flight turns on: acceleration = -k |v| v, with
// k = rho Cd A / 2m. Everything above feeds this and nothing else uses any of it.
// `speed` and `y` are the airspeed and the height; the caller supplies the
// airspeed rather than the ground speed so that wind is simply a different `v`.
export function dragFactor(speed, y, proj = SHELL) {
  return (0.5 * rho(y) * dragCoefficient(speed / soundSpeed(y)) * areaOf(proj)) / proj.mass;
}

// --- flight ------------------------------------------------------------------
//
// One step of the integrator, in three dimensions, with the wind as a velocity
// the air itself has. Velocity-Verlet rather than Euler: at 400 m/s a plain
// forward step loses tens of metres of range over a long shot, and the whole
// point of this module is that the table and the shell agree.
//
// `p` and `v` are {x,y,z} — any object with those, so a Vector3 or a plain
// literal both work and the table does not have to allocate.
const _a = { x: 0, y: 0, z: 0 };

function accel(v, y, wind, out, proj) {
  // relative to the air, which is what a shell is actually moving through
  const rx = v.x - (wind ? wind.x : 0);
  const ry = v.y - (wind ? wind.y : 0);
  const rz = v.z - (wind ? wind.z : 0);
  const speed = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const k = dragFactor(speed, y, proj);
  out.x = -k * speed * rx;
  out.y = -G - k * speed * ry;
  out.z = -k * speed * rz;
  return out;
}

const _vp = { x: 0, y: 0, z: 0 };

// `proj` is which projectile is flying: the same integrator carries a tonne of
// armour-piercing shell and a kilogramme of tracer, and the only thing that
// changes between them is the drag factor above.
export function flightStep(p, v, dt, wind = null, proj = SHELL) {
  // Predict with the acceleration where we are...
  accel(v, p.y, wind, _a, proj);
  const ax = _a.x;
  const ay = _a.y;
  const az = _a.z;
  _vp.x = v.x + ax * dt;
  _vp.y = v.y + ay * dt;
  _vp.z = v.z + az * dt;
  // ...and correct with the average of that and the acceleration where the
  // prediction says we are going. Drag depends on the velocity, so the plain
  // Verlet form is implicit and this predictor-corrector is the honest version
  // of it; one extra evaluation buys an order of accuracy, which over a
  // fifty-second flight is the difference between a firing table and a guess.
  accel(_vp, p.y + v.y * dt, wind, _a, proj);
  p.x += 0.5 * (v.x + _vp.x) * dt;
  p.y += 0.5 * (v.y + _vp.y) * dt;
  p.z += 0.5 * (v.z + _vp.z) * dt;
  v.x += 0.5 * (ax + _a.x) * dt;
  v.y += 0.5 * (ay + _a.y) * dt;
  v.z += 0.5 * (az + _a.z) * dt;
  return p;
}

// --- the firing table --------------------------------------------------------
//
// Fire the gun at every elevation from flat to the stop, in the plane, and write
// down where the shell lands and how long it took. That is a firing table, it is
// what a gunnery officer actually has in his hand, and it is the only honest way
// to answer "what range is this gun laid to" once drag is in the picture — the
// schoolbook v² sin 2θ / g is out by two kilometres at full elevation here.
//
// Built once, on the first question anybody asks. About two hundred trajectories
// at a twentieth of a second a step: a few milliseconds, once, and after that
// every range readout is two array lookups.
const STEP = 0.25; // degrees between rows
const MAX_ELEV = 48; // beyond any mount on this ship
const TABLE = { elev: [], range: [], tof: [], maxRange: 0, maxRangeElev: 0 };

// One shot in the vertical plane, from `height` above the water, told to stop
// when it comes back down to sea level. `sample` is called along the way if the
// caller wants the shape of the arc rather than just its end.
export function simulate(elevDeg, {
  height = 0, dt = 0.05, wind = null, speed = SHELL.muzzle, maxTime = 200, sample = null,
} = {}) {
  const th = (elevDeg * Math.PI) / 180;
  const p = { x: 0, y: height, z: 0 };
  const v = { x: speed * Math.cos(th), y: speed * Math.sin(th), z: 0 };
  let t = 0;
  let apex = height;
  while (t < maxTime) {
    const py = p.y;
    const px = p.x;
    flightStep(p, v, dt, wind);
    t += dt;
    if (p.y > apex) apex = p.y;
    if (sample) sample(p.x, p.y, t);
    if (p.y <= 0 && t > 2 * dt) {
      // land it on the water rather than under it
      const f = py / (py - p.y);
      return {
        range: px + (p.x - px) * f,
        tof: t - dt * (1 - f),
        speed: Math.hypot(v.x, v.y),
        fall: (Math.atan2(-v.y, v.x) * 180) / Math.PI,
        apex,
      };
    }
  }
  return { range: p.x, tof: t, speed: Math.hypot(v.x, v.y), fall: 0, apex };
}

function build() {
  if (TABLE.elev.length) return TABLE;
  for (let e = 0; e <= MAX_ELEV + 1e-9; e += STEP) {
    const r = simulate(e, { dt: 0.05 });
    TABLE.elev.push(e);
    TABLE.range.push(r.range);
    TABLE.tof.push(r.tof);
    if (r.range > TABLE.maxRange) { TABLE.maxRange = r.range; TABLE.maxRangeElev = e; }
  }
  return TABLE;
}

// What the gun is laid to, right now: the range it would drop a shell at, and
// how long that shell would be in the air. Below the horizontal it reaches
// nothing — a gun laid flat still throws a shell a fair way, but the plate reads
// what she is *ranged* to and a depressed gun is not ranged to anything.
export function rangeFor(elevDeg) {
  const T = build();
  if (elevDeg <= 0) return { range: 0, tof: 0 };
  const i = Math.min(Math.floor(elevDeg / STEP), T.elev.length - 2);
  const f = (elevDeg - T.elev[i]) / STEP;
  return {
    range: T.range[i] + (T.range[i + 1] - T.range[i]) * f,
    tof: T.tof[i] + (T.tof[i + 1] - T.tof[i]) * f,
  };
}

// And the other way round, which is what fire control actually wants: the
// elevation that reaches a range. The low arc — the table is monotonic up to the
// elevation of maximum range, and everything past that is the plunging solution
// nobody lays a battleship gun on.
export function elevationFor(range) {
  const T = build();
  if (range <= 0) return 0;
  if (range >= T.maxRange) return T.maxRangeElev;
  for (let i = 1; i < T.range.length; i++) {
    if (T.range[i] >= range) {
      const f = (range - T.range[i - 1]) / (T.range[i] - T.range[i - 1]);
      return T.elev[i - 1] + STEP * f;
    }
    if (T.elev[i] >= T.maxRangeElev) break;
  }
  return T.maxRangeElev;
}

export function maxRange() { return build().maxRange; }

// --- putting one on a particular point ---------------------------------------
//
// Not the same question as `elevationFor`, and the difference is the thing that
// used to make every shot from the forecastle land short: a target is not at sea
// level. It is on a deck fifteen metres up, or on a hilltop, or on the water a
// long way below a gun that is itself thirty metres up, and the elevation that
// reaches its *ground range* is not the elevation that passes through it.
//
// So this solves the real problem: find the launch angle whose trajectory passes
// through the offset (horizontal `d`, vertical `h`) from the muzzle. Bisection on
// a live integration — the height at a given horizontal distance rises
// monotonically with elevation over the low arc, so twelve halvings put it inside
// a thousandth of a degree, and each one costs a few hundred multiplies. It is
// run once per shot fired, which is nothing.
function heightAt(elevDeg, d, wind) {
  const th = (elevDeg * Math.PI) / 180;
  const p = { x: 0, y: 0, z: 0 };
  const v = { x: SHELL.muzzle * Math.cos(th), y: SHELL.muzzle * Math.sin(th), z: 0 };
  const dt = 0.04;
  for (let t = 0; t < 200; t += dt) {
    const px = p.x;
    const py = p.y;
    flightStep(p, v, dt, wind);
    if (p.x >= d) {
      const f = (d - px) / Math.max(p.x - px, 1e-6);
      return py + (p.y - py) * f;
    }
    // falling short and well past anything that could be a target: it never
    // gets there, and there is no sense integrating it into the seabed
    if (v.y < 0 && p.y < -2000) break;
  }
  return -Infinity;
}

// The elevation, in degrees above the *horizontal*, that puts a shell through a
// point `d` metres away and `h` metres up. `elevMax` caps it at the mount's stop,
// so a target out of reach is engaged at maximum elevation and falls short —
// which is the correct behaviour and is visible as such.
export function elevationThrough(d, h, { wind = null, elevMax = MAX_ELEV } = {}) {
  if (d < 1e-3) return 0;
  let lo = -20;
  let hi = elevMax;
  if (heightAt(hi, d, wind) < h) return hi; // cannot reach it at all
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid, d, wind) < h) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// The same answer as a direction, for a gun that is simply pointed rather than
// laid: take the line to the target, work out the elevation that gets there, and
// hand back a unit vector. `to` is the offset from the muzzle to the target;
// `out` receives the direction.
export function aimAt(to, out, { wind = null, elevMax = MAX_ELEV } = {}) {
  const d = Math.hypot(to.x, to.z);
  if (d < 1e-3) return out.set(0, 1, 0);
  const elev = (elevationThrough(d, to.y, { wind, elevMax }) * Math.PI) / 180;
  const c = Math.cos(elev) / d;
  return out.set(to.x * c, Math.sin(elev), to.z * c).normalize();
}
