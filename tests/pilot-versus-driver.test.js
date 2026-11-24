import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { ARRIVAL } from '../src/squad.ts';

// The pilot (an order to move) against a player at the controls of the same vehicle over the same stretch of the main
// world, as the server runs them: the player floors it and brakes all at once as late as stops it no further past the
// place than the pilot may stop from it (`ARRIVAL`), found by halving, as a good driver who knows his vehicle would. The
// pilot is there as soon, within `SLACK`; held to the speeds once planned for each ground, it took from 1.8 to 2.9 times
// as long over the stretches off the road. And it gets its vehicle there whole and upright, never further past the place.
const SLACK = 1.08;
const STRETCHES = [
  ['the asphalt', 'truck', -129552, -128856, 'asphalt'],
  ['soil and rock', 'scout', -129552, -128856],
  ['soil and rock', 'truck', -129552, -128856],
  ['the hills', 'truck', -14552, -13252],
  ['a steep descent', 'truck', 8475, 7600],
  ['a steep climb', 'heavy', 7600, 8475],
];

// One run from a standstill at `from`, far from its base: by the pilot, or by the player braking `brakeAt` metres short.
function run(model, from, to, paved, brakeAt = null) {
  const heading = Math.sign(to - from), base = from - heading * 1500, room = rehearsal([base], undefined, { fog: false }), world = room.world;
  try {
    if (paved) room.pave(Math.min(from, to) - 300, Math.max(from, to) + 300, paved);
    const pid = room.join('Corrida').playerId, id = room.publish(pid, createStructuredTemplate(model), { x: base, facing: heading }).actor.id,
      placed = world.actor(id).vehicle;
    world.command('setVehicleState', { actorId: id, state: { x: from, y: placed.y - world.terrain.height(placed.x) + world.terrain.height(from), vx: 0, vy: 0, omega: 0, angle: 0 } });
    room.command(pid, { type: 'squad', order: 'stop', ids: [id] });
    for (let i = 0; i < 180 || room.records.get(id)?.service; i++) { if (i % 60 === 0) room.command(pid, { type: 'ping' }); room.step(); }
    const unit = room.players.get(pid).squad.units.get(id),
      wear = () => world.plates.filter(plate => plate.actorId === id).reduce((sum, plate) => sum + (plate.revision || 0) + (plate.markRevision || 0), 0) +
        world.modules.filter(part => part.actorId === id).reduce((sum, part) => sum + (part.markRevision || 0) - part.health, 0),
      worn = wear(), manual = brakeAt !== null;
    if (manual) room.command(pid, { type: 'select', actorId: id });
    else room.command(pid, { type: 'squad', order: 'move', ids: [id], x: to });
    let steps = 0, past = -Infinity, upright = 1, braking = false, done = false, sent = '';
    for (; steps < 300 * 60 && !done; steps++) {
      if (steps % 60 === 0) room.command(pid, { type: 'ping' });
      const vehicle = world.actor(id).vehicle;
      if (manual) {
        braking ||= (to - vehicle.x) * heading <= brakeAt;
        const [throttle, brake] = braking ? [0, 1] : [heading, 0];
        if (sent !== throttle + ':' + brake) { sent = throttle + ':' + brake; room.command(pid, { type: 'drive', actorId: id, throttle, brake }); }
      }
      room.step();
      past = Math.max(past, (vehicle.x - to) * heading); upright = Math.min(upright, Math.cos(vehicle.angle));
      done = manual ? braking && Math.abs(vehicle.vx) < 1 : !unit.move;
    }
    const vehicle = world.actor(id).vehicle;
    return { done, seconds: steps / 60, error: (vehicle.x - to) * heading, past, upright, wear: wear() - worn, halt: unit.halt || '' };
  } finally { room.field.dispose(); }
}
// The good driver: the latest place to brake all at once that leaves the vehicle no further than `ARRIVAL` past, nor short.
function driver(model, from, to, paved) {
  let lo = 0, hi = 256, best = null;
  for (let i = 0; i < 8; i++) {
    const at = (lo + hi) / 2, ride = run(model, from, to, paved, at);
    if (!ride.done || ride.error > ARRIVAL) lo = at;
    else { hi = at; if (ride.error >= -ARRIVAL && (!best || ride.seconds < best.seconds)) best = ride; }
  }
  return best;
}

for (const [name, model, from, to, paved] of STRETCHES)
  test(`the pilot takes a ${model} over ${name} as soon as a good driver, and stops it there whole`, { timeout: 180000 }, () => {
    const pilot = run(model, from, to, paved), player = driver(model, from, to, paved),
      where = `${model} over ${name}: pilot ${pilot.seconds.toFixed(2)} s, driver ${player?.seconds.toFixed(2)} s`;
    assert(pilot.done && pilot.halt === '', `${where}: the pilot gets there (${pilot.halt})`);
    assert(Math.abs(pilot.error) <= ARRIVAL && pilot.past <= ARRIVAL, `${where}: it stops there, ${pilot.error.toFixed(2)} m off, ${pilot.past.toFixed(2)} past at the most`);
    assert(pilot.wear < 1e-9 && pilot.upright > .5, `${where}: whole and upright`);
    assert(player, `${where}: braking all at once, a driver stops there too`);
    assert(pilot.seconds <= player.seconds * SLACK, where);
  });
