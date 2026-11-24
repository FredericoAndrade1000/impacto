import { rehearsal } from '../../server/room.ts';
import { createStructuredTemplate } from '../../src/structured-templates.ts';
import { blastReach } from '../../src/weapons.ts';
import { onField } from './field.js';
import { gunship, skywatch } from './aircraft.js';

// Rehearsed trials of the pilots against aircraft, and of aircraft against what stands on the ground, on the field of the
// game with its fog: Alice's base at the middle, where her side stands, and Bob's twelve kilometres off, out of the way of
// her territory (territory.ts), so that she may raise structures by hers. What each trial measures is counted from the
// events of the field, as a page is told them: the rounds a gun of one side fires (`muzzle`), and each of them that strikes a
// construction of the other or bursts within the reach of its blast (`explosion`), once a round. Its pilots decide every
// tenth of a second whatever the time a round of decisions took (SharedRoom.step `pace`): a field under load has them
// decide less often, and a trial would tell as much of the machine it runs on as of them.
const STRUCTURES = new Set(['guard-post', 'outpost', 'bunker', 'bunker-he']), STEADY = Object.freeze({ pace: () => 1 });
// A design by name: a stock one, or one of tests/helpers/aircraft.js; the bunker fed with high explosive instead of its long
// rods (`bunker-he`), or a gunship with a camera under it (`gunship-eye`).
function designOf(name) {
  if (name === 'skywatch') return skywatch();
  if (name.startsWith('gunship')) return gunship({ eye: name === 'gunship-eye' });
  const source = createStructuredTemplate(name.replace(/-he$/, ''));
  if (name.endsWith('-he')) for (const part of source.components) if (part.kind === 'weapon') part.weaponAmmo = 'he';
  return source;
}
// A field of the two sides with nothing on it yet.
function field() {
  const cleanups = [], f = onField({ after: fn => cleanups.push(fn) }, rehearsal([0, 12000])), { room } = f,
    alice = room.join('Alice'), bob = room.join('Bob');
  return { ...f, alice, bob, dispose: () => { for (const fn of cleanups) fn(); },
    field: (player, name) => STRUCTURES.has(name) ? f.raise(player, designOf(name)) : f.publish(player, designOf(name)) };
}
// What the rounds of `shooter` did to `target` in the events of a step, into `tally`: fired, and struck or burst near, once
// a round, and when the first did. A shell that bursts in the air on its fuze tells no shooter: one that bursts within the
// reach of its blast of the target is the shooter's, for in a trial only one side fires shells at the other.
function count(world, events, shooter, target, tally) {
  for (const e of events) {
    if (e.type === 'muzzle' && e.actorId === shooter) tally.shots++;
    let round = null;
    if (e.primaryContact && e.targetActorId === target && e.shooterActorId === shooter) round = e.projectileId;
    else if (e.type === 'explosion' && e.detonation === 'airburst') {
      const b = world.actorBounds(target);
      if (Math.hypot(Math.max(b.minX - e.x, e.x - b.maxX, 0), Math.max(b.minY - e.y, e.y - b.maxY, 0)) <= blastReach(e.radius))
        round = `burst:${e.time}:${e.x}:${e.y}`;
    }
    if (round === null || tally.struck.has(round)) continue;
    tally.struck.add(round); tally.first ??= tally.now();
  }
}
// Puts an aircraft `height` over the ground at `x` and takes it up from there: its pilot asks it to climb for a moment and
// lets its flight computer hold it there (game_hover.rs). With `hold`, the player keeps it in hand.
function airborne(f, player, id, x, height, hold = false) {
  const { world, ground } = f, place = () => world.command('setVehicleState', { actorId: id,
    state: { x, y: ground.height(x) + height, vx: 0, vy: 0, angle: 0, omega: 0 } });
  place(); f.order(player, 'control', { id }); f.send(player, 'drive', { throttle: 0, brake: 0, rise: 1 }); f.run(.2);
  f.send(player, 'drive', { throttle: 0, brake: 0, rise: 0 });
  if (!hold) f.order(player, 'control', { id: null });
  place();
}
// Whether an aircraft is down: out of action, or short of a thruster or of its fuel, or no longer flying.
export function down(f, id) {
  const { room, world } = f, parts = world.modules.filter(m => m.actorId === id), gone = m => !(m.health > 0) || m.attached === false;
  return Boolean(room.outOfAction()[id]) || parts.some(m => m.kind === 'thruster' && gone(m)) ||
    parts.filter(m => m.kind === 'fuel').every(m => gone(m) || !(m.fuelLitres > 0)) || !world.actor(id).vehicle.flying;
}

// A drone of Bob's, in his hands, with a gun under it and no rounds for it, before a shooter of Alice's that is free to fire
// (`Fogo livre`): hovering `distance` metres before the shooter, the way it faces, `height` over the ground; or, at `speed`,
// crossing over it level at that height from `reach` before it to as far behind it, held to that course and speed
// whatever its thrusters do. Within `seconds`: how many rounds the shooter fired and how many struck the drone or burst by
// it, when the first did, when the drone was brought down, and why the shooter held its fire, a tenth of a second at a time.
export function defence({ shooter, height, distance = 250, speed = 0, seconds = 40, reach = 800, craft = 'gunship' }) {
  const f = field(), { room, world, ground, alice, bob } = f;
  try {
    const own = f.field(alice, shooter), drone = f.publish(bob, designOf(craft));
    f.order(alice, 'control', { id: null }); f.run(1);
    for (const box of f.parts(drone, 'ammo')) f.set(box, { rounds: 0 });
    const actor = world.actor(own), x0 = actor.vehicle?.x ?? actor.x, facing = actor.facing, way = -facing,
      start = x0 + facing * (speed ? reach : distance), level = ground.height(start) + height;
    airborne(f, bob, drone, start, height, true);
    f.order(alice, 'stance', { ids: [own], stance: 'fire' });
    const t0 = world.time, tally = { shots: 0, struck: new Set(), first: null, now: () => +(world.time - t0).toFixed(2) },
      reasons = {}, unit = () => room.players.get(alice.playerId).squad.units.get(own);
    let killed = null;
    for (let i = 0; i < seconds * 60; i++) {
      // He keeps it in hand, asking nothing of it.
      if (i % 30 === 0) f.send(bob, 'drive', { throttle: 0, brake: 0, rise: 0 });
      if (speed) world.command('setVehicleState', { actorId: drone, state: { y: level, vx: speed * way, vy: 0, angle: 0, omega: 0 } });
      const from = world.events.length; room.step(STEADY);
      count(world, world.events.slice(from), own, drone, tally);
      if (i % 6 === 0) { const why = unit().reason || 'none'; reasons[why] = (reasons[why] || 0) + 1; }
      if (down(f, drone)) { killed = tally.now(); break; }
      if (speed && (world.actor(drone).vehicle.x - x0) * way > reach) break;
    }
    return { shots: tally.shots, hits: tally.struck.size, first: tally.first, killed, time: tally.now(), reasons };
  } finally { f.dispose(); }
}

// A gunship of Bob's, `height` over the ground `distance` metres before a target of Alice's, ordered to attack it (or, with
// `stance`, only given that stance), with `rounds` in its box if told: the target parked, or with `drive` driving off along
// the field, its guns free to fire back. His base is far off: its fuel return is switched off, for going home for its fuel,
// or refusing the attack for want of it, is no part of the trial. Within `seconds`: how many rounds the gunship fired and
// how many struck the target, when the first did, when the target was put out of action, how many of the target's struck
// the gunship, whether it was brought down and when, how low over the ground it flew, where it ended, what it was doing and
// why it went to land, if it did. With `trace`, where it was — and which side of the target (`side`, the way from the
// target to it), the way it faced —, and what it did each second.
export function strike({ target, height = 60, distance = 600, seconds = 90, drive = false, stance = null, craft = 'gunship-eye', rounds = null, trace = null }) {
  const f = field(), { room, world, ground, alice, bob } = f;
  try {
    const own = f.field(alice, target), drone = f.publish(bob, designOf(craft)), squad = room.players.get(bob.playerId).squad;
    f.send(bob, 'homing', { actorId: drone, on: false });
    f.order(alice, 'control', { id: null }); f.run(1);
    if (rounds !== null) for (const box of f.parts(drone, 'ammo')) f.set(box, { rounds });
    const actor = world.actor(own), x0 = actor.vehicle?.x ?? actor.x, facing = actor.facing;
    airborne(f, bob, drone, x0 + facing * distance, height);
    f.order(alice, 'stance', { ids: [own], stance: 'fire' });
    if (drive) f.order(alice, 'move', { ids: [own], x: x0 - facing * 4000 });
    if (stance) f.order(bob, 'stance', { ids: [drone], stance });
    else f.order(bob, 'attack', { ids: [drone], targetId: own });
    const t0 = world.time, now = () => +(world.time - t0).toFixed(2), dealt = { shots: 0, struck: new Set(), first: null, now },
      taken = { shots: 0, struck: new Set(), first: null, now }, activity = {}, unit = () => squad.units.get(drone);
    let killed = null, defeated = null, lowest = Infinity;
    for (let i = 0; i < seconds * 60; i++) {
      const from = world.events.length; room.step(STEADY);
      const events = world.events.slice(from);
      count(world, events, drone, own, dealt); count(world, events, own, drone, taken);
      if (i % 6 === 0) { const u = unit(), what = `${u.activity}:${u.reason || '-'}`; activity[what] = (activity[what] || 0) + 1; }
      const v = world.actor(drone).vehicle; lowest = Math.min(lowest, v.y - ground.height(v.x));
      if (defeated === null && room.outOfAction()[own]) defeated = now();
      if (trace && i % 60 === 0) { const u = unit(), at = world.actor(own).vehicle?.x ?? world.actor(own).x;
        trace({ t: now(), ahead: +((at - v.x) * world.actor(drone).facing).toFixed(1), side: Math.sign(v.x - at), facing: world.actor(drone).facing,
          height: +(v.y - ground.height(v.x)).toFixed(1), vx: +v.vx.toFixed(1), vy: +v.vy.toFixed(1),
          leg: u.move && { ahead: +((at - u.move.x) * world.actor(drone).facing).toFixed(1), height: u.move.height && +u.move.height.toFixed(1), purpose: u.move.purpose },
          what: `${u.activity}:${u.reason || '-'}`, dealt: dealt.struck.size, taken: taken.struck.size }); }
      if (down(f, drone)) { killed = now(); break; }
    }
    const v = world.actor(drone).vehicle, at = world.actor(own).vehicle?.x ?? world.actor(own).x;
    return { shots: dealt.shots, hits: dealt.struck.size, first: dealt.first, defeated, taken: taken.struck.size, killed, time: now(),
      lowest: +lowest.toFixed(1), ahead: +((at - v.x) * world.actor(drone).facing).toFixed(1), height: +(v.y - ground.height(v.x)).toFixed(1),
      rounds: f.parts(drone, 'ammo').reduce((sum, m) => sum + m.rounds, 0), landing: unit().move?.land ?? null, activity };
  } finally { f.dispose(); }
}
