import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { rehearsal } from '../server/room.ts';
import { SHOT_WORDS, shotCount, listShots, packShots } from '../src/shots.ts';

const burst = () => weaponSettings('machinegun', { platform: 'ground', rate: 600, spread: 0 });

test('rounds in the air are read as numbers: eight a round, with a legend of their kinds', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  assert.equal(shotCount(w.shots), 0); assert.deepEqual(w.snapshot().shots.kinds, []);
  w.setTrigger(true, { x: 35, y: 30 }, burst());
  for (let i = 0; i < 60; i++) w.step();
  const shots = w.shots, full = w.projectiles, list = listShots(shots);
  assert(full.length >= 5, 'a burst is in the air'); assert.equal(shotCount(shots), full.length); assert.equal(shots.data.length, full.length * SHOT_WORDS);
  assert.equal(shots.kinds.length, 1, 'the rounds of one gun are of one kind');
  for (const [i, round] of full.entries()) {
    const shot = list[i];
    assert.deepEqual([shot.id, shot.number, shot.actorId, shot.ammo, shot.weapon, shot.preset ?? null, shot.poweredTrail],
      [round.id, round.numericId, round.actorId, round.ammo, round.weapon, round.preset ?? null, Boolean(round.poweredTrail)]);
    for (const key of ['x', 'y', 'vx', 'vy', 'age', 'radius']) assert.equal(shot[key], round[key], key);
  }
  assert.equal(w.snapshot().shots, shots, 'one block until the core moves the rounds again');
  w.step(); assert.notEqual(w.shots, shots); assert.equal(w.shots.kinds, shots.kinds, 'and one legend, which only grows');
  // A block made by hand reads the same way.
  assert.deepEqual(listShots(packShots(list)), list);
});

test('a quiet step tells only the clock and loses nothing: the scene read later is the scene stepped in full', t => {
  const [eager, quiet] = [0, 1].map(() => { const w = new World(createConstruction('heavy')); t.after(() => w.dispose()); return w; }),
    heard = [[], []], hear = (w, log) => { w.sync(); log.push(...w.drainEvents()); };
  for (const w of [eager, quiet]) { w.controlVehicle(1, 0); w.setTrigger(true, { x: -60, y: 14 }, burst()); }
  const before = quiet.actor().vehicle.x;
  for (let i = 0; i < 5; i++) { eager.step(); quiet.step(undefined, { quiet: true }); }
  assert.equal(quiet.tick, eager.tick); assert.equal(quiet.time, eager.time);
  assert.equal(quiet.actor().vehicle.x, before, 'unread, the scene is where it was');
  assert.notEqual(eager.actor().vehicle.x, before);
  assert.deepEqual(quiet.projectiles, eager.projectiles, 'the rounds are asked of the core, which went on');
  quiet.sync(); assert.equal(quiet.actor().vehicle.x, eager.actor().vehicle.x);
  hear(eager, heard[0]); hear(quiet, heard[1]);
  for (let i = 0; i < 200; i++) {
    eager.step(); hear(eager, heard[0]);
    quiet.step(undefined, { quiet: true }); if (i % 7 === 6) hear(quiet, heard[1]);
  }
  // A command brings the frame of whatever went unread.
  for (const w of [eager, quiet]) w.setTrigger(false);
  hear(eager, heard[0]); hear(quiet, heard[1]);
  assert(heard[0].length > 20 && eager.stats.shots > 20, 'things happened');
  assert.deepEqual(heard[1], heard[0], 'every event, in order, with the frame that came for them');
  assert.deepEqual(quiet.snapshot(), eager.snapshot());
  assert.deepEqual(quiet.projectiles, eager.projectiles);
});

test('the shared field stepped quietly is the same field', t => {
  const fields = [false, true].map(quiet => {
    const room = rehearsal([-100, 100]), player = room.join('Alice'); t.after(() => room.world.dispose());
    const id = room.publish(player.playerId, createStructuredTemplate('scout')).actor.id, send = (type, data) => room.command(player.playerId, { type, ...data });
    send('squad', { order: 'control', id });
    for (let i = 0; i < 120; i++) room.step({ quiet });
    const gun = room.world.modules.find(m => m.actorId === id && m.kind === 'weapon'), at = gun.x + 300;
    send('drive', { throttle: 1, brake: 0 });
    send('trigger', { active: true, aim: { x: at, y: room.world.terrain.height(at) + 40 }, weapon: { id: 'cannon', componentId: gun.id } });
    for (let i = 0; i < 240; i++) room.step({ quiet });
    if (quiet) assert(room.field.rustGame.stale, 'nothing read the scene since the last step');
    const world = room.world, actor = world.actor(id);
    assert(!room.field.rustGame.stale);
    return { time: world.time, tick: world.tick, x: actor.vehicle.x, y: actor.vehicle.y, angle: actor.vehicle.angle, fired: actor.stats.shots,
      stats: world.stats, rounds: Array.from(world.shots.data), health: world.modules.map(m => m.health), calm: room.calm(actor) };
  });
  assert(fields[0].fired > 5 && fields[0].rounds.length > 0 && !fields[0].calm, 'the scout drove and fired');
  assert.deepEqual(fields[1], fields[0]);
});
