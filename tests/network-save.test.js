import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { FrameReader, NETWORK_VERSION, merged } from '../src/network-protocol.ts';
import { serveNetwork } from './helpers/network.js';

const until = async (fn, timeout = 30000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
// A server of a field kept in `dir`, and the pages that come to it.
async function serving(t, dir, options = {}) {
  const { socket, close } = await serveNetwork(t, { rehearsal: { bases: [0] }, save: { dir, seconds: 3600 }, ...options });
  // A page that asks to come in, with the token of a seat or none: it is welcomed or told why not.
  const connect = async (name, { token = '', build } = {}) => {
    const ws = socket(), client = { ws, messages: [], frames: [], closed: null }, reader = new FrameReader();
    ws.on('message', (raw, binary) => { if (binary) { const packet = reader.decode(raw); if (packet) client.frames.push(packet); else ws.send(JSON.stringify({ type: 'resync' })); }
      else { const message = JSON.parse(raw); if (message.type === 'welcome') client.faction = message.faction;
        if (message.type === 'faction') client.faction = merged(client.faction, message.changes); client.messages.push(message); } });
    ws.on('close', code => { client.closed = code; });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token, build }));
    await until(() => client.messages.some(m => m.type === 'welcome' || m.error));
    client.welcome = client.messages.find(m => m.type === 'welcome'); client.refused = client.messages.find(m => m.error);
    return client;
  };
  return { connect, close };
}
const spawn = async (client, ticket) => {
  client.ws.send(JSON.stringify({ type: 'spawn', request: 1, ticket, x: 0, facing: 1, blueprint: createStructuredTemplate('scout') }));
  await until(() => client.frames.at(-1)?.state.actors.length === 1);
  return client.frames.at(-1).state.actors[0].id;
};

test('a server that stops keeps its field, and the one that starts next resumes it: each seat by its token, with what it had there', { timeout: 120000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-save-')), file = join(dir, 'field.json');
  let running;
  const log = console.log; console.log = () => {}; t.after(async () => { await running?.close(); console.log = log; rmSync(dir, { recursive: true, force: true }); });
  const ticket = 'scout-before-restart', first = running = await serving(t, dir), alice = await first.connect('Alice'), scout = await spawn(alice, ticket);
  await until(() => alice.messages.some(m => m.type === 'reply' && m.request === 1));
  const receipt = alice.messages.find(m => m.type === 'reply' && m.request === 1);
  // The scout was paid for from the stocks of her faction.
  const paid = () => alice.faction?.stock.ferro < alice.welcome.faction.stock.ferro ? alice.faction.stock : null;
  await until(paid);
  const stock = paid();
  // Her faction came whole with the welcome: she was told since what changed of it, and not the faction again.
  const since = alice.messages.filter(m => m.type === 'faction').map(m => m.changes);
  assert(since.length && since.every(changes => !('id' in changes) && !('name' in changes)), JSON.stringify(since).slice(0, 300));
  assert.equal(existsSync(file), false, 'nothing is written before its time');
  await first.close();
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(kept.room.scene.actors.map(a => a.id), [scout]); assert.equal(kept.room.players[0].token, alice.welcome.token);
  // Another server on the same directory: the field is the one that was kept.
  let disk = 'one';
  const second = running = await serving(t, dir, { stamp: () => disk }), back = await second.connect('Alice', { token: alice.welcome.token, build: 'one' });
  assert.equal(back.welcome.playerId, alice.welcome.playerId); assert.equal(back.welcome.selected, scout);
  assert.deepEqual(back.welcome.actors.map(a => a.id), [scout]);
  await until(() => back.frames.at(-1)?.state.actors.length === 1);
  assert.deepEqual(back.welcome.faction.stock, stock, 'the stocks are what was left after the scout was paid for');
  // If the page missed the original acknowledgement, its retry after restart returns the same publication.
  back.ws.send(JSON.stringify({ type: 'spawn', request: 2, ticket, x: 0, facing: 1, blueprint: createStructuredTemplate('scout') }));
  await until(() => back.messages.some(m => m.type === 'reply' && m.request === 2));
  assert.deepEqual({ ...back.messages.find(m => m.type === 'reply' && m.request === 2), request: 1 }, receipt);
  // A stranger has a seat of their own on it.
  const bob = await second.connect('Bob', { build: 'one' });
  assert.notEqual(bob.welcome.playerId, alice.welcome.playerId); assert.equal(bob.welcome.actors.length, 0);
  // New source and a newer page leave the running field alone until an explicit server restart.
  disk = 'two';
  const ahead = await second.connect('Alice', { token: alice.welcome.token, build: 'two' });
  assert.equal(ahead.refused.outdated, true); assert.match(ahead.refused.error, /reinicie o servidor/);
  assert.equal(ahead.welcome, undefined); assert.equal(back.closed, null);
  await second.close();
  await until(() => back.closed !== null);
  assert.equal(back.closed, 1001, 'an explicit shutdown lets the page reconnect');
  const third = running = await serving(t, dir, { stamp: () => disk }), resumed = await third.connect('Alice', { token: alice.welcome.token, build: 'two' });
  assert.equal(resumed.welcome.playerId, alice.welcome.playerId); assert.equal(resumed.welcome.selected, scout);
  assert.deepEqual(resumed.welcome.actors.map(a => a.id), [scout]); assert.deepEqual(resumed.welcome.faction.stock, stock);
});

test('repeated worker failures preserve the checkpoint and require an explicit server restart', { timeout: 120000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-save-')), file = join(dir, 'field.json'),
    falling = join(dir, 'falling.mjs'), whole = new URL('../server/physics-worker.ts', import.meta.url);
  // A field that stands, resumes what was kept, and falls a moment later.
  writeFileSync(falling, `import ${JSON.stringify(whole.href)};\nsetTimeout(() => { throw new Error('queda do campo'); }, 400);\n`);
  let running;
  const said = [], { error, log } = console; console.error = console.log = (...words) => said.push(words.join(' '));
  t.after(async () => { await running?.close(); Object.assign(console, { error, log }); rmSync(dir, { recursive: true, force: true }); });
  const first = running = await serving(t, dir, { save: { dir, seconds: .2 } }), alice = await first.connect('Alice'), scout = await spawn(alice);
  await until(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).room.scene.actors.length === 1);
  await first.close();
  const checkpoint = readFileSync(file);
  // The first crash is transient: a hello resumes the same checkpoint and seat.
  let entry = pathToFileURL(falling), starts = 0;
  const fell = () => said.filter(line => /Servidor físico: queda do campo/.test(line)).length,
    failed = running = await serving(t, dir, { entry: () => { starts++; return entry; } }), { connect } = failed;
  await until(() => fell() === 1);
  assert.deepEqual(readFileSync(file), checkpoint);
  // That one is started for whoever comes, resumes what was kept — and falls in its turn.
  const again = await connect('Alice', { token: alice.welcome.token });
  assert.deepEqual(again.welcome.actors.map(a => a.id), [scout], 'resumed, before it falls');
  await until(() => fell() === 2);
  assert.deepEqual(readFileSync(file), checkpoint, 'repeated failure never renames or rewrites the checkpoint');
  // Repeated requests cannot spawn another worker or replace the world with an empty one.
  entry = whole;
  const stale = await connect('Alice', { token: alice.welcome.token });
  assert.deepEqual([stale.welcome, stale.refused?.retryable, stale.refused?.unknownKey], [undefined, true, undefined]);
  const fresh = await connect('Alice');
  assert.deepEqual([fresh.welcome, fresh.refused?.retryable], [undefined, true]); assert.equal(starts, 2);
  assert(!stale.refused.error.includes(dir) && !fresh.refused.error.includes(dir), 'operator paths stay private');
  await failed.close();
  const restarted = running = await serving(t, dir), back = await restarted.connect(null, { token: alice.welcome.token });
  assert.equal(back.welcome.playerId, alice.welcome.playerId); assert.equal(back.welcome.token, alice.welcome.token);
  assert.deepEqual(back.welcome.actors.map(actor => actor.id), [scout]);
});

test('a refused checkpoint blocks repeated boot attempts without losing its bytes or reporting an unknown access key', { timeout: 60000 }, async t => {
  const said = [], error = console.error; console.error = (...words) => said.push(words.join(' ')); t.after(() => { console.error = error; });
  for (const invalid of [`{"save":${FIELD_SAVE},"room":`, JSON.stringify({ save: FIELD_SAVE + 1, room: null })]) {
    const dir = mkdtempSync(join(tmpdir(), 'impacto-refused-save-')), file = join(dir, 'field.json');
    let server;
    t.after(async () => { await server?.close(); rmSync(dir, { recursive: true, force: true }); });
    writeFileSync(file, invalid); const before = said.length;
    let starts = 0;
    server = await serving(t, dir, { entry: () => { starts++; return new URL('../server/physics-worker.ts', import.meta.url); } });
    await until(() => said.slice(before).some(line => line.startsWith('Servidor físico:')));
    for (const token of ['QA-EXISTING-ACCESS', '']) {
      const refused = await server.connect('QA Saved Field', { token });
      assert.equal(refused.welcome, undefined); assert.equal(refused.refused.retryable, true);
      assert.equal(refused.refused.unknownKey, undefined); assert(!refused.refused.error.includes(dir));
    }
    assert.equal(starts, 1, 'client retries cannot repeatedly construct a worker that never reached ready');
    assert.equal(readFileSync(file, 'utf8'), invalid); await server.close();
  }
});

test('a real failed write warns connected and arriving clients, then clears after a successful retry on the same worker', { timeout: 90000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-write-health-')), file = join(dir, 'field.json'), marker = join(dir, 'blocked-path.txt'),
    entry = join(dir, 'blocked-write.mjs'), realWorker = new URL('../server/physics-worker.ts', import.meta.url);
  let running;
  t.after(async () => { await running?.close(); rmSync(dir, { recursive: true, force: true }); });
  const seed = running = await serving(t, dir), alice = await seed.connect('Alice'), scout = await spawn(alice);
  await seed.close(); const checkpoint = readFileSync(file);
  writeFileSync(entry, `import ${JSON.stringify(realWorker.href)};\n` +
    "import { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { threadId, workerData } from 'node:worker_threads';\n" +
    `const blocked = join(workerData.save.dir, 'field.json.' + process.pid + '.' + threadId + '.tmp'); mkdirSync(blocked); writeFileSync(${JSON.stringify(marker)}, blocked);\n`);
  let starts = 0;
  const server = running = await serving(t, dir, { save: { dir, seconds: .2 }, entry: () => { starts++; return pathToFileURL(entry); } }),
    live = await server.connect('Alice', { token: alice.welcome.token });
  await until(() => live.messages.some(message => message.persistenceFailed === true));
  live.ws.send(JSON.stringify({ type: 'rename', request: 77, name: 'Alice revised' }));
  await until(() => live.messages.some(message => message.request === 77));
  assert.equal(live.messages.find(message => message.request === 77).error, undefined, 'the live field still accepts player actions');
  assert.deepEqual(readFileSync(file), checkpoint, 'a failed write leaves the last good checkpoint exact');
  const bob = await server.connect('Bob'); assert.equal(bob.welcome.persistenceFailed, true, 'arrival during a failure receives the current health');
  const blocked = readFileSync(marker, 'utf8');
  assert.equal(dirname(blocked), dir); assert.match(blocked.slice(dir.length + 1), /^field\.json\.\d+\.\d+\.tmp$/);
  rmdirSync(blocked); // only this worker's verified empty obstruction
  await until(() => [live, bob].every(client => client.messages.some(message => message.persistenceFailed === false)));
  assert.equal(starts, 1);
  assert(live.messages.filter(message => typeof message.persistenceFailed === 'boolean').every(message => !message.request && !message.error));
  await until(() => JSON.parse(readFileSync(file, 'utf8')).room.players.some(player => player.name === 'Alice revised'));
  await server.close();
  const restarted = running = await serving(t, dir), back = await restarted.connect(null, { token: alice.welcome.token });
  assert.equal(back.welcome.name, 'Alice revised'); assert.equal(back.welcome.persistenceFailed, false);
  assert.equal(back.welcome.playerId, alice.welcome.playerId); assert.deepEqual(back.welcome.actors.map(actor => actor.id), [scout]);
});
