import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { checkTestSave } from '../server/test-server.ts';
import { fieldServerConfig } from '../server/field-config.ts';
import { readWorkerOptions } from '../server/worker-contract.ts';
import { fieldStore } from '../server/field-save.ts';
import { openRoom } from '../server/field-host.ts';
import { diaryLines } from '../server/field-journal.ts';
import { STARTING_STOCK, STOCK_IDS } from '../src/economy.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { serveNetwork } from './helpers/network.js';
import './helpers/runtime.js';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-commander-worker-'));
  t.after(() => { assert(dir.startsWith(join(tmpdir(), 'impacto-commander-worker-'))); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function worker(t, options) {
  const instance = new Worker(new URL('../server/physics-worker.ts', import.meta.url), { workerData: options });
  t.after(() => instance.terminate());
  const ready = new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.on('message', message => { if (message.type === 'ready') resolve(); });
  });
  return { instance, ready, async checkpoint() {
    const done = new Int32Array(new SharedArrayBuffer(4));
    instance.postMessage({ type: 'save', done });
    await Atomics.waitAsync(done, 0, 0, 8000).value;
    assert.equal(Atomics.load(done, 0), 1, 'the real worker saved the live room');
  } };
}

test('test commanders are default-off, bounded and forbidden on normal or rich rehearsal workers', t => {
  const dir = directory(t);
  assert.deepEqual(fieldServerConfig({}), { testTools: false, save: null });
  for (const count of ['0', '1', '4']) assert.throws(() => fieldServerConfig({ IMPACTO_TEST_COMMANDERS: count }), /exige IMPACTO_TEST_SERVER=1/);
  for (const count of ['', '-1', '5', '1.5', 'Infinity', 'many']) assert.throws(() =>
    fieldServerConfig({ IMPACTO_TEST_SERVER: '1', IMPACTO_TEST_SAVE_DIR: dir, IMPACTO_TEST_COMMANDERS: count }), /0 a 4/);
  for (const count of [0, 1, 4]) assert.deepEqual(
    fieldServerConfig({ IMPACTO_TEST_SERVER: '1', IMPACTO_TEST_SAVE_DIR: dir, IMPACTO_TEST_COMMANDERS: String(count) }),
    { testTools: true, save: { dir }, commanders: count });
  assert.throws(() => readWorkerOptions({ commanders: 1 }), /IMPACTO_TEST_SERVER=1/);
  for (const options of [{ testTools: true, commanders: 1, rehearsal: { bases: [] } }, { testTools: true, commanders: 1, stress: 1 }])
    assert.throws(() => readWorkerOptions(options), /estoques e fabricação normais/);
  assert.deepEqual(readWorkerOptions({ testTools: true, commanders: 1 }), { testTools: true, commanders: 1 });
});

test('a test worker runs without peers and resumes paused identities without granting a second starter kit', { timeout: 30000 }, async t => {
  const root = directory(t), dir = join(root, 'test'), options = { testTools: true, commanders: 1, save: { dir } };
  checkTestSave(true, options.save);
  const first = worker(t, options); await first.ready; await delay(100); await first.checkpoint(); await first.instance.terminate();
  const file = join(dir, 'field.json'), kept = JSON.parse(readFileSync(file, 'utf8')).room,
    [[id, state]] = kept.commanders, owner = kept.players.find(player => player.id === id),
    faction = kept.factions.find(faction => faction.id === owner.factionId),
    kit = kept.scene.actors.filter(actor => actor.ownerId === id).map(actor => actor.id);
  assert(kept.scene.time > 0, 'no websocket is required for the simulation to advance');
  assert(state.sequence > 0, 'the controller made its first decision');
  assert.equal(owner.connected, undefined, 'cold saves do not invent a socket connection');
  assert.equal(kit.length, 3);
  for (const material of STOCK_IDS) assert(faction.stock[material] <= STARTING_STOCK[material], 'no rehearsal grant');
  const store = fieldStore(dir), room = store.open(data => openRoom(null, data));
  room.setCommanderEnabled(id, false);
  const pausedSequence = room.commanders.get(id).sequence, pausedStock = { ...room.factions.get(owner.factionId).stock };
  assert.equal(store.save(room), true); room.world.dispose();
  const second = worker(t, options); await second.ready; await delay(100); await second.checkpoint(); await second.instance.terminate();
  const resumed = JSON.parse(readFileSync(file, 'utf8')).room;
  assert.equal(resumed.commanders.length, 1);
  assert.equal(resumed.commanders[0][0], id);
  assert.equal(resumed.commanders[0][1].enabled, false, 'restart respects an explicit pause');
  assert.equal(resumed.commanders[0][1].sequence, pausedSequence);
  assert.deepEqual(resumed.scene.actors.filter(actor => actor.ownerId === id).map(actor => actor.id), kit);
  assert.deepEqual(resumed.factions.find(faction => faction.id === owner.factionId).stock, pausedStock);
  const entries = [];
  for (const name of readdirSync(join(dir, 'replays'))) for await (const line of diaryLines(join(dir, 'replays', name))) {
    const entry = JSON.parse(line); if (Array.isArray(entry)) entries.push(entry);
  }
  assert.equal(entries.filter(entry => entry[1] === 'commander').length, 1, 'creation is recorded once before its first decision');
  assert(!entries.some(entry => entry[1] === 'do'), 'internal strategic actions are never duplicated as client commands');
  // A copied cold checkpoint cannot enable bots on a normal worker. This
  // boundary is independent of the marker that protects test directories.
  const normal = join(root, 'normal'); mkdirSync(normal);
  const bytes = readFileSync(file, 'utf8'); writeFileSync(join(normal, 'field.json'), bytes);
  const refused = worker(t, { save: { dir: normal } });
  await assert.rejects(refused.ready, /comandantes autônomos exige servidor de testes/);
  assert.equal(readFileSync(join(normal, 'field.json'), 'utf8'), bytes);
  assert.deepEqual(readdirSync(normal), ['field.json'], 'no replacement world or diary is created');
});

test('explicit public zero resumes existing AI without replacing identities; absent opt-in and over-cap saves fail closed', { timeout: 30000 }, async t => {
  const root = directory(t), dir = join(root, 'public'), store = fieldStore(dir), room = openRoom(null),
    active = room.addCommander('Ativo'), paused = room.addCommander('Pausado');
  room.setCommanderEnabled(paused.id, false);
  const kits = [active.id, paused.id].map(id => room.owned(id).map(actor => actor.id));
  assert.equal(store.save(room), true); room.world.dispose();
  const file = join(dir, 'field.json'), bytes = readFileSync(file, 'utf8'), refused = worker(t, { save: { dir } });
  await assert.rejects(refused.ready, /configuração pública explícita/);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(readdirSync(dir), ['field.json'], 'unauthorized boot creates no replacement or diary');
  const resumed = worker(t, { commanderFill: 0, save: { dir } });
  await resumed.ready; await delay(100); await resumed.checkpoint(); await resumed.instance.terminate();
  const kept = JSON.parse(readFileSync(file, 'utf8')).room;
  assert.deepEqual(kept.commanders.map(([id, state]) => [id, state.enabled]), [[active.id, true], [paused.id, false]]);
  for (const [index, id] of [active.id, paused.id].entries()) {
    assert.deepEqual(kept.scene.actors.filter(actor => actor.ownerId === id).map(actor => actor.id), kits[index]);
    assert.equal(kept.players.find(player => player.id === id).connected, undefined);
  }
  assert.equal(kept.commanders.find(([id]) => id === paused.id)[1].sequence, 0);
  assert(kept.commanders.find(([id]) => id === active.id)[1].sequence > 0, 'zero authorizes existing AI, it does not pause it');
  const excessive = join(root, 'over-cap'), oversized = openRoom(null);
  for (let i = 0; i < 5; i++) { const bot = oversized.addCommander(`IA ${i}`); oversized.setCommanderEnabled(bot.id, false); }
  assert.equal(fieldStore(excessive).save(oversized), true); oversized.world.dispose();
  const overFile = join(excessive, 'field.json'), overBytes = readFileSync(overFile, 'utf8'),
    over = worker(t, { commanderFill: 0, save: { dir: excessive } });
  await assert.rejects(over.ready, /limite de quatro identidades/);
  assert.equal(readFileSync(overFile, 'utf8'), overBytes);
  assert.deepEqual(readdirSync(excessive), ['field.json']);
});

test('a public network keeps normal human admission and refuses test tools; population config grants no immediate kits', { timeout: 20000 }, async t => {
  const dir = directory(t), network = await serveNetwork(t, { commanderFill: 4, save: { dir } }), ws = network.socket();
  await once(ws, 'open');
  const ask = (data, accept) => new Promise((resolve, reject) => {
    const heard = (bytes, binary) => {
      if (binary) return;
      const reply = JSON.parse(bytes.toString());
      if (accept(reply)) { clearTimeout(timer); ws.off('message', heard); resolve(reply); }
    }, timer = setTimeout(() => { ws.off('message', heard); reject(new Error('Public server reply timed out.')); }, 8000);
    ws.on('message', heard); ws.send(JSON.stringify(data));
  });
  const welcome = await ask({ type: 'hello', name: 'Humano', version: NETWORK_VERSION, commanderFill: 20, testTools: true },
    reply => reply.type === 'welcome');
  assert.equal(welcome.testTools, undefined);
  assert.equal(welcome.faction.members.length, 1);
  assert.equal(welcome.faction.members[0].ai, undefined);
  const refusal = await ask({ type: 'test', act: 'list', request: 1 }, reply => reply.request === 1);
  assert.match(refusal.error, /indisponíveis/);
  await network.close();
  const kept = JSON.parse(readFileSync(join(dir, 'field.json'), 'utf8')).room;
  assert.equal(kept.commanders, undefined, 'public boot does not prefill the field before the first minute');
  assert.equal(kept.players.length, 1);
  assert.equal(kept.scene.actors.length, 3);
  assert.deepEqual(kept.factions[0].stock, STARTING_STOCK);
});
