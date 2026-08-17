// Can a person get into a gunhouse, stand up in it, and reach the gear?
import { Vector3 } from 'three/webgpu';
import { createColliders } from './src/battleship/colliders.js';
import { createDeckAccess } from './src/player/deckAccess.js';
import { createCharacter } from './src/player/character.js';
import { PLAYER, GRAVITY } from './src/player/spec.js';
import { hullDescriptor, deckY, zOf } from './src/battleship/hull.js';
import {
  HOUSE, createHouseColliders, insideDoorVolumes, entryVolumes, landing,
} from './src/battleship/turretHouse.js';
import { TURRETS } from './src/battleship/spec.js';

const D = HOUSE.door;
console.log('--- clearances ---');
console.log(`  player            ${PLAYER.height.toFixed(2)} m tall, ${(PLAYER.radius*2).toFixed(2)} m across`);
console.log(`  gunhouse door     ${(D.head - D.sill).toFixed(2)} m clear, ${(D.halfLen*2).toFixed(2)} m wide, sill ${D.sill.toFixed(2)} m`);
console.log(`  bandstand passage 2.10 m clear`);
console.log(`  room headroom     ${(HOUSE.ceiling - HOUSE.floor).toFixed(2)} m`);
console.log(`  room              ${(HOUSE.halfW*2).toFixed(1)} x ${(HOUSE.fwd-HOUSE.aft).toFixed(1)} m`);
const bad = [];
if (D.head - D.sill < PLAYER.height + 0.15) bad.push('gunhouse door is too low');
if (D.halfLen * 2 < PLAYER.radius * 2 + 0.3) bad.push('gunhouse door is too narrow');
if (D.sill - HOUSE.floor > PLAYER.stepUp) bad.push('door sill is too high to step over');
if (HOUSE.ceiling - HOUSE.floor < PLAYER.height + 0.3) bad.push('room headroom is too low');
console.log(bad.length ? '  FAIL: ' + bad.join('; ') : '  all clear');

// walk about inside one
const house = createHouseColliders();
const space = { colliders: house, hull: null,
  apparentGravity: (r, out) => out.set(0, -GRAVITY, 0),
  toWorld: (v,o)=>o.copy(v), velocityToWorld: (p,v,o)=>o.copy(v), worldQuaternion: null };
const land = landing(-1);
const p = createCharacter({ space, spawn: { position: land.position.clone(), heading: land.heading } });
p.teleport(land.position, land.heading);   // the real path in uses teleport, not the constructor
console.log('\n--- inside the gunhouse ---');
console.log('  landed at', p.position.toArray().map(v=>v.toFixed(2)).join(', '), p.state.grounded ? 'on ' + p.state.standingOn : 'AIRBORNE');
const station = new Vector3(HOUSE.station.x, HOUSE.floor, HOUSE.station.z);
const REACH = 1.7;
const dt = 1/60;
// walk toward the gear
let t = 0;
for (let i = 0; i < 300; i++) {
  const dx = station.x - p.position.x, dz = station.z - p.position.z;
  p.state.heading = Math.atan2(dx, dz);
  p.step(dt, { forward: 1, strafe: 0, jump: false, sprint: false, rise: 0 }, t*1000);
  t += dt;
  if (p.position.distanceTo(station) < REACH - 0.1) break;
}
console.log(`  walked to the gear in ${t.toFixed(1)} s, ${p.position.distanceTo(station).toFixed(2)} m off it,`,
  p.state.grounded ? 'standing on ' + p.state.standingOn : 'AIRBORNE');
console.log('  reach is', REACH, '->', p.position.distanceTo(station) < REACH ? 'CAN take the gun' : 'CANNOT reach');

// and back out through the door
const doorsIn = insideDoorVolumes();
const inBox = (q, v, m=0) => Math.abs(q.x-v.c.x)<v.h.x+m && Math.abs(q.y-v.c.y)<v.h.y+m && Math.abs(q.z-v.c.z)<v.h.z+m;
console.log('  landing sits inside the way-out volume?',
  doorsIn.some(d => inBox(land.position, d)) ? 'YES — would bounce straight back' : 'no');
let reached = false;
t = 0;
for (let i = 0; i < 400; i++) {
  const d = doorsIn[0];
  p.state.heading = Math.atan2(d.c.x - p.position.x, d.c.z - p.position.z);
  p.step(dt, { forward: 1, strafe: 0, jump: false, sprint: false, rise: 0 }, t*1000);
  t += dt;
  if (inBox(p.position, doorsIn[0])) { reached = true; break; }
}
console.log(`  reached the door from the gear: ${reached ? `yes, ${t.toFixed(1)} s` : 'NO'}`);

// the way in, from the deck
console.log('\n--- the way in, from the deck ---');
const ship = { colliders: createColliders({ mounts: null, alive: () => true }), hull: hullDescriptor,
  apparentGravity: (r, out) => out.set(0, -GRAVITY, 0),
  toWorld: (v,o)=>o.copy(v), velocityToWorld: (p2,v,o)=>o.copy(v) };
const access = createDeckAccess();
for (const t2 of TURRETS) {
  const vols = entryVolumes(t2, deckY, zOf);
  const v = vols[1];
  const facing = Math.abs(t2.arcCenter) > 90 ? -1 : 1;
  // A route a person would take: along the deck to the foot of the way in, then
  // turn inboard. Bandstand turrets need no climb; A and Y have three treads.
  const inboard = Math.atan2(-Math.sign(v.c.x), 0);
  const alongZ = facing > 0 ? 0 : Math.PI;
  const start = t2.bandstand
    ? new Vector3(v.c.x + Math.sign(v.c.x) * (v.h.x + 3.0), v.sill + 3, v.c.z)
    : new Vector3(Math.sign(v.c.x) * (HOUSE.halfW + HOUSE.wall + 1.5),
      v.sill + 3, zOf(t2.z) + facing * (HOUSE.door.z - 3.4));
  const q = createCharacter({ space: ship, extra: access, spawn: { position: start, heading: 0 } });
  const walk = { forward: 1, strafe: 0, jump: false, sprint: false, rise: 0 };
  let hit = false; let s = 0;
  // walk along the deck until we are up at the sill (or already in the volume)
  if (!t2.bandstand) {
    q.state.heading = alongZ;
    for (let i = 0; i < 300; i++) {
      q.step(dt, walk, s * 1000); s += dt;
      if (inBox(q.position, v, 0.15)) { hit = true; break; }
      if (q.position.y > v.sill - 0.15 && q.state.grounded) break;
    }
  }
  // then turn inboard and go through
  if (!hit) {
    q.state.heading = inboard;
    for (let i = 0; i < 200; i++) {
      q.step(dt, walk, s * 1000); s += dt;
      if (inBox(q.position, v, 0.15)) { hit = true; break; }
    }
  }
  console.log(`  ${t2.id.padEnd(9)} ${t2.bandstand ? 'bandstand passage' : 'gunhouse door    '} `
    + `sill ${v.sill.toFixed(2)} m · start ${start.x.toFixed(1)},${start.z.toFixed(1)} · `
    + (hit ? `WALKED IN after ${s.toFixed(1)} s` : `did not reach it (stopped at x ${q.position.x.toFixed(2)} y ${q.position.y.toFixed(2)})`));
}
