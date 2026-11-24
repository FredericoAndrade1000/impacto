import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { bill, buildSeconds } from '../src/economy.ts';
import { fieldNotices } from '../src/field-panel.ts';
import { unitServices, serviceText } from '../src/faction-ui.ts';

test('a construction takes as long to build as what its materials cost: fuel is poured in, and what a replacement gives back takes no time', () => {
  assert.equal(buildSeconds(bill()), 5);
  assert.equal(buildSeconds(bill(21148)), 47);
  assert.equal(buildSeconds(bill(20000, 3000, 500, 9000)), 52);
  assert.equal(buildSeconds(bill(-1147, 3000, 500)), 12);
  assert.equal(buildSeconds(bill(1e6)), 180, 'none takes longer than three minutes');
});

test('a published construction is built at the base: until it is ready it is neither driven nor turned about, and it stays where it came in', t => {
  const room = rehearsal([-100], undefined, { build: true }), world = room.world; t.after(() => world.dispose());
  const alice = room.join('Alice'), result = room.publish(alice.playerId, createStructuredTemplate('scout')), id = result.actor.id,
    actor = () => world.actor(id), send = data => room.command(alice.playerId, data),
    run = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) room.step(); };
  assert.equal(result.seconds, buildSeconds(result.cost));
  assert.deepEqual(actor().field, { wreck: null, service: { kind: 'build', until: world.time + result.seconds } });
  assert.equal(room.factionView(alice.playerId).units.find(u => u.id === id).service.kind, 'build');
  // Taken in hand, it is not driven; nor is it turned about.
  send({ type: 'squad', order: 'control', id });
  assert.throws(() => send({ type: 'drive', throttle: 1, request: 1 }), /^Error: Essa construção ainda não ficou pronta\.$/);
  assert.throws(() => send({ type: 'squad', order: 'turn', ids: [id] }), /^Error: Essa construção ainda não ficou pronta\.$/);
  const x = room.position(actor());
  run(result.seconds - 1);
  assert.equal(actor().field?.service?.kind, 'build'); assert(Math.abs(room.position(actor()) - x) < .5, 'it stands where it was built');
  run(1.5);
  assert.equal(actor().field, null, 'ready');
  send({ type: 'drive', throttle: 1, request: 2 }); run(2);
  assert(Math.abs(room.position(actor()) - x) > .5, 'ready, it drives');
});

test('a place a construction is sent to while it is being built is where it goes once it is ready', t => {
  const room = rehearsal([-100], undefined, { build: true }), world = room.world; t.after(() => world.dispose());
  const alice = room.join('Alice'), result = room.publish(alice.playerId, createStructuredTemplate('scout')), id = result.actor.id,
    unit = room.players.get(alice.playerId).squad.units.get(id), from = room.position(world.actor(id));
  room.command(alice.playerId, { type: 'squad', order: 'move', ids: [id], x: from + 30 });
  for (let i = 0; i < Math.round((result.seconds + 1) * 60); i++) room.step();
  assert.equal(world.actor(id).field, null);
  assert.equal(unit.move?.x, from + 30, 'the wait was no way shut'); assert.notEqual(unit.reason, 'blocked-way');
  for (let i = 0; i < 20 * 60 && unit.move; i++) room.step();
  assert(Math.abs(room.position(world.actor(id)) - (from + 30)) < 2, 'it got there');
});

test('the panel says a construction is being built and for how long, and once that it is ready', () => {
  const services = unitServices({ id: 'a', service: { kind: 'build', until: 9 }, atBase: true, cargo: {}, point: { supplier: null } }, { stock: {} });
  assert.deepEqual(services, { jobs: [], held: 'Em construção: fica parada na base até ficar pronta.' });
  assert.equal(serviceText({ kind: 'build', until: 47 }, 10.2), 'em construção · 37 s');
  const watch = builds => ({ faction: null, fell: null, recovered: null, met: [], veins: null, hauls: [], batteries: [], repairs: [], partly: [], cancelled: [], turns: [], ills: [], gone: {}, facing: {},
    units: [{ id: 'a', label: 'Veículo 1 · Ana' }], builds });
  const memo = {};
  assert.deepEqual(fieldNotices(memo, watch(['a']), 10), []);
  assert.deepEqual(fieldNotices(memo, watch([]), 11), ['Veículo 1 · Ana: pronto.']);
  assert.equal(memo.grave, false, 'good news');
  assert.deepEqual(fieldNotices(memo, watch([]), 12), []);
});
