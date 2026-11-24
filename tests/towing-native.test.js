import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { emptyBlueprint } from './helpers/perception-scene.js';

function empty(t) {
  const world = new World(emptyBlueprint(), { visualEvents: false });
  t.after(() => world.dispose()); world.removeActor('local'); return world;
}
function pair(t) {
  const world = empty(t), source = createStructuredTemplate('scout');
  world.addActor(source, { id: 'tug', ownerId: 'blue', x: 0 });
  world.addActor(source, { id: 'load', ownerId: 'blue', x: 8 });
  return world;
}
function attach(world) { assert.equal(world.command('towAttach', { actorId: 'tug', targetId: 'load' }), true); }
const identity = ({ actorId, targetId, partAId, partBId, localA, localB, length }) =>
  ({ actorId, targetId, partAId, partBId, localA, localB, length });

test('towing projection reads never synchronize quiet steps or install a lazy scene', t => {
  const world = pair(t);
  assert.equal(world.rustGame, null); assert.deepEqual(world.tows, []); assert.equal(world.rustGame, null);
  const game = world.game(); world.step(1 / 60, { quiet: true });
  const sync = t.mock.method(game, 'sync', () => { throw new Error('A getter must not read a frame'); });
  for (let i = 0; i < 100; i++) assert.deepEqual(world.tows, []);
  assert.equal(sync.mock.calls.length, 0); sync.mock.restore(); world.sync();
  attach(world); const before = world.tows;
  world.step(1 / 60, { quiet: true });
  const again = t.mock.method(game, 'sync', () => { throw new Error('A getter must not read a frame'); });
  for (let i = 0; i < 100; i++) assert.equal(world.tows, before);
  assert.equal(again.mock.calls.length, 0); again.mock.restore(); world.sync();
});

test('Native commands publish one complete relation and neutralize late target controls', t => {
  const world = pair(t); attach(world); const cable = structuredClone(world.tows[0]);
  assert.equal(world.tows.length, 1);
  assert.equal(cable.actorId, 'tug'); assert.equal(cable.targetId, 'load');
  for (const [actorId, key] of [['tug', 'partAId'], ['load', 'partBId']])
    assert(world.plates.some(p => p.id === cable[key] && p.actorId === actorId && p.definition.chassis?.part === 'frame'));
  for (const key of ['localA', 'localB', 'anchorA', 'anchorB']) assert(Number.isFinite(cable[key].x) && Number.isFinite(cable[key].y));
  assert(cable.length >= .25 && cable.length <= 4 && cable.tension === 0 && cable.limit > 0);
  world.controlVehicle(-1, 1, 'load');
  world.game().call({ op: 'input', actorId: 'load', input: { type: 'release', phase: 'before', brake: 1 } });
  const vehicle = world.actor('load').vehicle;
  assert.equal(vehicle.throttle, 0); assert.equal(vehicle.brake, 0);
  assert.deepEqual(world.tows[0], cable);
  world.command('setVehicleState', { actorId: 'load', state: { vx: 2 } });
  assert.equal(world.command('towDetach', { actorId: 'load' }), true);
  assert.deepEqual(world.tows, []); assert.equal(vehicle.brake, 1); assert.equal(vehicle.vx, 2);
  assert.equal(world.command('towDetach', { actorId: 'load' }), false);
});

test('cold towing keeps only canonical locals and restores a stretched moving cable without attach replay', t => {
  const world = pair(t);
  // Explicit initial airborne pose isolates the cold checkpoint from terrain/parking contacts.
  for (const [actorId, sign] of [['tug', -1], ['load', 1]]) {
    const y = world.actor(actorId).vehicle.y + 40;
    world.command('setVehicleState', { actorId, state: { y, vx: .2 * sign, vy: 0 } });
  }
  attach(world); for (let i = 0; i < 3; i++) world.step();
  const cable = structuredClone(world.tows[0]); assert(cable.tension > 0);
  // Saved pose/speed need not satisfy the gate for a new coupling.
  const v = world.actor('load').vehicle;
  world.command('setVehicleState', { actorId: 'load', state: { x: v.x + 5, vx: 2 } });
  const kept = JSON.parse(JSON.stringify(world.keep()));
  assert.deepEqual(kept.tows, [identity(cable)]);
  assert(!Object.hasOwn(kept.tows[0], 'anchorA')); assert(!Object.hasOwn(kept.tows[0], 'tension'));
  const resumed = empty(t);
  resumed.resume(kept);
  assert.deepEqual(resumed.tows.map(identity), kept.tows);
  assert.equal(resumed.actor('load').vehicle.vx, 2);
  assert(Math.hypot(resumed.tows[0].anchorA.x - resumed.tows[0].anchorB.x,
    resumed.tows[0].anchorA.y - resumed.tows[0].anchorB.y) > 4);
  // Recomputed force still follows the physical rating on the first resumed step.
  resumed.step();
  assert.deepEqual(resumed.tows, [], 'the over-stretched saved cable ruptures in the solver phase, not during cold admission');
  assert(Math.abs(resumed.actor('load').vehicle.vx) > 1, 'rupture preserves moving momentum');
});

test('a cable actually tows a damaged scout over normal ground without moving either body by hand', t => {
  const world = pair(t);
  for (let i = 0; i < 120; i++) world.step();
  const engine = world.modules.find(m => m.actorId === 'load' && m.kind === 'engine');
  world.game().call({ op: 'setPartState', owner: world.game().handle(engine), state: { health: 0 } });
  attach(world);
  const start = world.actor('load').vehicle.x;
  let peak = 0;
  for (let i = 0; i < 720; i++) {
    world.controlVehicle(-.6 * Math.min(1, (i + 1) / 60), 0, 'tug');
    world.step();
    assert.equal(world.tows.length, 1, `the basic cable must survive ordinary acceleration at step ${i}`);
    peak = Math.max(peak, world.tows[0].tension);
    assert(world.tows[0].tension <= world.tows[0].limit);
    assert.equal(world.actor('load').vehicle.brake, 0);
  }
  const travelled = start - world.actor('load').vehicle.x;
  assert(travelled > 3, `the damaged vehicle must really roll behind the tug: ${travelled} m`);
  assert.equal(world.dynamics.recoveries, 0);
  t.diagnostic(JSON.stringify({ seconds: 12, travelledM: travelled, peakTensionN: peak, limitN: world.tows[0].limit }));
});

test('a scout with its own engine keeps pace with its tug: both pull, both burn fuel, and the cable hardly pulls', t => {
  const world = pair(t);
  for (let i = 0; i < 120; i++) world.step();
  attach(world);
  const fuel = id => world.modules.filter(m => m.actorId === id && m.kind === 'fuel').reduce((sum, m) => sum + m.fuelLitres, 0),
    tanks = { tug: fuel('tug'), load: fuel('load') }, start = world.actor('load').vehicle.x;
  let peak = 0, driven = 0;
  for (let i = 0; i < 720; i++) {
    world.controlVehicle(-.6 * Math.min(1, (i + 1) / 60), 0, 'tug');
    world.step();
    assert.equal(world.tows.length, 1);
    peak = Math.max(peak, world.tows[0].tension);
    if (world.actor('load').vehicle.throttle !== 0) driven++;
  }
  const tug = world.actor('tug').vehicle, load = world.actor('load').vehicle;
  assert(start - load.x > 30, 'the pair goes on together');
  assert(Math.abs(tug.vx - load.vx) < .05, 'at one speed');
  assert(driven > 600, `the load drives itself the way its tug goes: ${driven} of 720 steps`);
  assert(peak < 2500, `the cable carries next to nothing: ${peak} N`);
  assert(fuel('tug') < tanks.tug && fuel('load') < tanks.load, 'each engine burns its own fuel');
  assert.equal(world.dynamics.recoveries, 0);
  t.diagnostic(JSON.stringify({ seconds: 12, travelledM: start - load.x, peakTensionN: peak }));
});

test('Native rejected replacement preserves the original cable and admitted scene', t => {
  const world = pair(t); attach(world); const cable = structuredClone(world.tows), game = world.game(),
    before = world.command('digest', { frame: false }), core = world.dynamics.core, command = core.game_command;
  const refuse = t.mock.method(core, 'game_command', function (request) {
    const packet = JSON.parse(request);
    if (packet.op === 'admit') packet.plates[0].indices = [0, 1, 999999];
    return command.call(this, JSON.stringify(packet));
  });
  assert.throws(() => world.replaceActor(createStructuredTemplate('scout'), { id: 'tug' }), /indices|index|outside|material/i);
  refuse.mock.restore();
  assert.equal(world.game(), game); assert.deepEqual(world.tows, cable);
  assert.equal(world.command('digest', { frame: false }), before);
  assert.equal(world.command('towAttach', { actorId: 'tug', targetId: 'load' }), true);
});

for (const operation of ['remove', 'replace', 'turn']) test(`accepted low-level ${operation} releases the old endpoint without erasing target momentum`, t => {
  const world = pair(t); attach(world);
  world.command('setVehicleState', { actorId: 'load', state: { vx: 2 } });
  if (operation === 'remove') world.removeActor('tug');
  if (operation === 'replace') world.replaceActor(createStructuredTemplate('scout'), { id: 'tug' });
  if (operation === 'turn') world.turnActor('tug');
  assert.deepEqual(world.tows, [], 'admit publishes the complete updated relation even without a full frame');
  // The accepted construction packet only names coming actors. Read the other actor explicitly here.
  world.command('sync');
  assert.equal(world.actor('load').vehicle.brake, 1); assert.equal(world.actor('load').vehicle.vx, 2);
  const kept = JSON.parse(JSON.stringify(world.keep())); assert(!Object.hasOwn(kept, 'tows'));
  const resumed = empty(t); resumed.resume(kept); assert.deepEqual(resumed.tows, []);
});
