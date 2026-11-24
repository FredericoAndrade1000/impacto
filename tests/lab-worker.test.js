import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { TRIAL_TARGETS } from '../src/battle-rules.ts';

async function client(t) {
  const worker = new Worker(new URL('../scripts/worker-review-harness.ts', import.meta.url)), packets = [], waiters = new Set();
  t.after(async () => {
    worker.removeAllListeners('message');
    for (const w of waiters) clearTimeout(w.timer);
    await worker.terminate();
  });
  worker.on('message', packet => {
    packets.push(packet);
    if (packet.type === 'frame') worker.postMessage({ type: 'ack', serial: packet.serial });
    for (const w of waiters) if (w.predicate(packet)) {
      clearTimeout(w.timer); waiters.delete(w); w.resolve(packet);
    }
  });
  const wait = predicate => packets.some(predicate) ? Promise.resolve(packets.find(predicate)) : new Promise((resolve, reject) => {
    const w = { predicate, resolve, timer: setTimeout(() => { waiters.delete(w); reject(new Error('Worker não respondeu.')); }, 10000) };
    waiters.add(w);
  });
  let serial = 0;
  const request = (type, data = {}) => {
    const request = ++serial; worker.postMessage({ type, ...data, request });
    return wait(packet => packet.type === 'reply' && packet.request === request);
  };
  await wait(p => p.type === 'ready'); return { worker, request, wait, packets };
}

test('the worker of the lab holds the test alone: one construction, driven and fired by the player', { timeout: 20000 }, async t => {
  const c = await client(t), blueprint = createConstruction('ifv');
  assert((await c.request('load', { blueprint, generation: 11, paused: true })).ok);
  const bench = (await c.wait(p => p.type === 'frame' && p.generation === 11)).state;
  assert.deepEqual(bench.actors.map(actor => actor.id), ['local']); assert.equal(bench.stats.shots, 0);
  assert.deepEqual(['shared', 'squad', 'controlledActor'].filter(key => key in bench), [], 'a frame of the lab says nothing of a field');
  // Its gun fires at the player's word, and the construction takes the keys.
  const aim = { x: -40, y: 2 }, weapon = weaponSettings('autocannon', { preset: 'm242', platform: 'vehicle', componentId: 'weapon' });
  assert.equal((await c.request('fire', { force: true, queue: true, aim, weapon })).accepted, true);
  assert((await c.request('drive', { throttle: 1, brake: 0 })).ok);
  assert((await c.request('reset')).ok);
  // A construction of the workshop is a vehicle, and what its camera reads is not drawn: the worker has no command
  // for either, nor for anything but its test. The test of armour has no gun of its own to stand away from it.
  for (const [type, data] of [['vehicle-settings', { config: { enabled: false } }], ['sensor-view', { value: true }], ['test-distance', { value: 250 }]])
    assert.match((await c.request(type, data)).error, /desconhecido/, type);
});

test('the terrain test of the lab stands its targets ahead of the vehicle, and has them again when begun again', { timeout: 20000 }, async t => {
  const c = await client(t), scene = { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 };
  assert((await c.request('load', { blueprint: createConstruction('ifv'), terrain: MAIN_WORLD.terrain, scene, targets: true, generation: 12, paused: true })).ok);
  const loaded = await c.wait(p => p.type === 'frame' && p.generation === 12), ids = ['local', ...TRIAL_TARGETS.map((_, i) => `alvo-${i}`)];
  assert.deepEqual(loaded.state.actors.map(actor => actor.id), ids);
  assert((await c.request('reset')).ok);
  const again = await c.wait(p => p.type === 'frame' && p.serial > loaded.serial);
  assert.deepEqual(again.state.actors.map(actor => actor.id), ids);
});
