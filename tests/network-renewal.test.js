import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { FrameReader, NETWORK_VERSION } from '../src/network-protocol.ts';
import { serveNetwork } from './helpers/network.js';
import { proxyTrust } from '../server/network-address.ts';

test('source edits and newer pages never replace a running field; incompatible pages are refused and matching seats reconnect', { timeout: 90000 }, async t => {
  let disk = 'one', starts = 0;
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [0] }, stamp: () => disk,
    entry: () => { starts++; return new URL('../server/physics-worker.ts', import.meta.url); } });
  const until = async (fn, timeout = 30000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  // A page of the code `build` asks to come in: it is welcomed or told why not.
  const connect = async (name, build, { token = '', version = NETWORK_VERSION } = {}) => {
    const ws = socket(), client = { ws, messages: [], frames: [], closed: null }, reader = new FrameReader();
    ws.on('message', (raw, binary) => { if (binary) { const packet = reader.decode(raw); if (packet) client.frames.push(packet); else ws.send(JSON.stringify({ type: 'resync' })); } else client.messages.push(JSON.parse(raw)); });
    ws.on('close', code => { client.closed = code; });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version, name, build, token }));
    await until(() => client.messages.some(m => m.type === 'welcome' || m.error));
    client.welcome = client.messages.find(m => m.type === 'welcome'); client.refused = client.messages.find(m => m.error);
    return client;
  };
  const alice = await connect('Alice', 'one');
  assert(alice.welcome, 'a page of the code the field runs comes in');
  const publish = { type: 'spawn', request: 1, ticket: 'scout-once', x: 0, facing: 1, blueprint: createStructuredTemplate('scout') };
  alice.ws.send(JSON.stringify(publish));
  await until(() => alice.frames.at(-1)?.state.actors.length === 1);
  const scout = alice.frames.at(-1).state.actors[0].id;
  const old = await connect('Antiga', 'zero');
  assert.match(old.refused.error, /Recarregue a página/); assert.equal(old.refused.outdated, true); assert.equal(old.welcome, undefined);
  // The disk moves on. A page of the startup code still enters the same field.
  disk = 'two';
  // With nothing on the field he sees none of its constructions: it is the field Alice is on all the same.
  const bob = await connect('Bob', 'one');
  assert(bob.welcome.faction.strangers.some(p => p.name === 'Alice')); await until(() => bob.frames.length > 2);
  assert.equal(bob.frames.at(-1).state.actors.length, 0); assert.deepEqual(bob.frames.at(-1).state.players.map(p => p.id), [bob.welcome.playerId], 'nor whose they are');
  const ahead = await connect('Carol', 'two');
  assert.match(ahead.refused.error, /Recarregue a página.*reinicie o servidor/);
  assert.equal(ahead.refused.outdated, true); assert.equal(ahead.welcome, undefined);
  const seen = alice.frames.length; await until(() => alice.frames.length > seen + 2);
  assert.equal(starts, 1, 'source edits and new pages start no worker');
  assert.deepEqual([alice.closed, bob.closed], [null, null]);
  const back = await connect('Alice', 'one', { token: alice.welcome.token });
  assert.equal(back.welcome.playerId, alice.welcome.playerId); assert.equal(back.welcome.selected, scout);
  assert.deepEqual(back.welcome.actors.map(a => a.id), [scout]);
  await until(() => alice.closed === 4001);
  back.ws.send(JSON.stringify({ ...publish, request: 2 }));
  await until(() => back.messages.some(m => m.type === 'reply' && m.request === 2));
  assert.equal(back.messages.find(m => m.request === 2).actor.id, scout, 'the publication ticket survives reconnection');
  await until(() => back.frames.length > 2); assert.equal(back.frames.at(-1).state.actors.length, 1);
  const wrongProtocol = await connect('Incompatível', 'one', { version: NETWORK_VERSION - 1 });
  assert.match(wrongProtocol.refused.error, /Recarregue a página/); assert.equal(wrongProtocol.welcome, undefined);
  // A page that says nothing of its code is taken as it comes: the version of the protocol still guards it.
  assert((await connect('Dora')).welcome);
});

test('a field that never reached ready stays unavailable until an explicit server restart', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'impacto-field-')), broken = join(directory, 'broken.mjs');
  writeFileSync(broken, "throw new Error('núcleo por compilar');\n");
  let entry = pathToFileURL(broken);
  const failures = [], log = console.error; console.error = (...said) => failures.push(said.join(' ')); t.after(() => { console.error = log; });
  let starts = 0;
  const { socket, close } = await serveNetwork(t, { rehearsal: { bases: [0] }, entry: () => { starts++; return entry; } });
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const connect = async (name, open = socket) => {
    const ws = open(), messages = [];
    ws.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw)); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name }));
    const start = Date.now(); while (!messages.some(m => m.type === 'welcome' || m.error)) { if (Date.now() - start > 30000) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); }
    return messages.find(m => m.type === 'welcome' || m.error);
  };
  const start = Date.now(); while (!failures.length) { if (Date.now() - start > 30000) throw new Error('the field never fell'); await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.match(failures[0], /núcleo por compilar/);
  const refused = (await connect('Alice')).error;
  assert.match(refused, /fora do ar/); assert.doesNotMatch(refused, /núcleo por compilar/, 'why is for the log, not for the player');
  entry = new URL('../server/physics-worker.ts', import.meta.url);
  assert.equal((await connect('Alice')).retryable, true); assert.equal(starts, 1, 'another hello cannot spawn a failed boot again');
  await close();
  const restarted = await serveNetwork(t, { rehearsal: { bases: [0] }, entry: () => entry });
  assert.equal((await connect('Alice', restarted.socket)).type, 'welcome', 'an explicit restart may open the working entry');
});

test('a field that stops without a word is down as one that throws: its pages are let go, and whoever comes next is answered', { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'impacto-field-')), stopping = join(directory, 'stopping.mjs'), ending = join(directory, 'ending.mjs');
  // A field that stands, and stops when a page says so: of itself, or throwing. And one that ends before it stands.
  writeFileSync(stopping, `import ${JSON.stringify(new URL('../server/physics-worker.ts', import.meta.url).href)};\nimport { parentPort } from 'node:worker_threads';\n` +
    "parentPort.on('message', ({ data }) => { if (data?.type === 'rename' && data.name === 'Parar') process.exit(0); if (data?.type === 'rename' && data.name === 'Cair') throw new Error('queda do campo'); });\n");
  writeFileSync(ending, '');
  let entry = pathToFileURL(stopping), disk = 'one', starts = 0;
  const said = [], log = console.error; console.error = (...words) => said.push(words.join(' ')); t.after(() => { console.error = log; });
  const { socket, close } = await serveNetwork(t, { rehearsal: { bases: [0] }, stamp: () => disk,
    entry: () => { starts++; return entry; } });
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const until = async (fn, timeout = 10000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const connect = async name => {
    const ws = socket(), client = { ws, messages: [], closed: null };
    ws.on('message', (raw, binary) => { if (!binary) client.messages.push(JSON.parse(raw)); });
    ws.on('close', (code, reason) => { client.closed = code; client.reason = String(reason); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, build: 'one' }));
    await until(() => client.messages.some(m => m.type === 'welcome' || m.error) || client.closed !== null);
    client.welcome = client.messages.find(m => m.type === 'welcome'); client.refused = client.messages.find(m => m.error);
    return client;
  };
  const fell = () => said.filter(line => line.startsWith('Servidor físico:'));
  // The field ends of itself: whoever was on it is let go with why, and the next page has the field started again.
  const alice = await connect('Alice');
  assert(alice.welcome, alice.refused?.error);
  alice.ws.send(JSON.stringify({ type: 'rename', name: 'Parar' }));
  await until(() => alice.closed !== null);
  assert.deepEqual([alice.closed, alice.reason], [1011, 'O campo parou.']);
  assert.equal(fell().length, 1); assert.match(fell()[0], /parou sem dizer por quê \(código 0\)/);
  const bob = await connect('Bob');
  assert(bob.welcome, bob.refused?.error ?? `closed ${bob.closed}`);
  assert.deepEqual(bob.welcome.faction.strangers.map(p => p.name), [], 'a field started anew');
  // The field throws: it says why and then stops, and is let go once.
  bob.ws.send(JSON.stringify({ type: 'rename', name: 'Cair' }));
  await until(() => bob.closed !== null);
  assert.equal(bob.closed, 1011);
  // A crash cannot apply edited sources under this server's startup stamp.
  disk = 'two';
  const edited = await connect('Editada');
  assert.match(edited.refused?.error ?? '', /fora do ar/); assert.equal(edited.refused.retryable, true);
  assert.equal(starts, 2, 'a source change never starts an updated worker under the previous stamp');
  disk = 'one';
  // A field that ends before it stands is no field: the page is told so at once, not when the wait for it runs out.
  entry = pathToFileURL(ending);
  const carol = await connect('Carol');
  assert.match(carol.refused?.error ?? '', /fora do ar/);
  assert.equal(fell().length, 2, 'the field that threw was let go once'); assert.match(fell()[1], /queda do campo/);
  assert.equal(carol.refused.retryable, true); assert.equal(starts, 3);
  entry = pathToFileURL(stopping);
  const dora = await connect('Dora');
  assert.equal(dora.welcome, undefined); assert.equal(dora.refused?.retryable, true);
  assert.equal(starts, 3, 'a failed recovery boot is not respawned by later requests');
  // A server that closes stops its field: that is no fall.
  const count = said.length; await close();
  assert.deepEqual(said.slice(count), []);
});

test('a page that leaves during crash recovery leaves no seat behind on the recovered field', { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'impacto-recovery-')), stopping = join(directory, 'stopping.mjs');
  writeFileSync(stopping, "import { parentPort } from 'node:worker_threads';\nawait new Promise(resolve => setTimeout(resolve, 150));\n" +
    `await import(${JSON.stringify(new URL('../server/physics-worker.ts', import.meta.url).href)});\n` +
    "parentPort.on('message', ({ data }) => { if (data?.type === 'rename' && data.name === 'Parar') process.exit(0); });\n");
  let starts = 0;
  t.mock.method(console, 'error', () => {});
  const { socket, url, close } = await serveNetwork(t, { rehearsal: { bases: [0] }, perAddress: true, trust: proxyTrust('127.0.0.1', 'cf-connecting-ip'),
    entry: () => { starts++; return pathToFileURL(stopping); } }), home = '203.0.113.7';
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const until = async (fn, timeout = 30000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  // Each comes through a proxy on the machine of the server, which says whom it comes for: all from one address.
  const open = async name => {
    const ws = socket(url, { headers: { 'CF-Connecting-IP': home } }), client = { ws, messages: [], closed: null };
    ws.on('message', (raw, binary) => { if (!binary) client.messages.push(JSON.parse(raw)); });
    ws.on('close', code => { client.closed = code; });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name }));
    return client;
  };
  const connect = async name => {
    const client = await open(name);
    await until(() => client.messages.some(m => m.type === 'welcome' || m.error));
    client.welcome = client.messages.find(m => m.type === 'welcome'); client.refused = client.messages.find(m => m.error);
    return client;
  };
  const alice = await connect('Alice');
  assert(alice.welcome);
  alice.ws.send(JSON.stringify({ type: 'rename', name: 'Parar' }));
  await until(() => alice.closed !== null);
  assert.equal(alice.closed, 1011);
  const gone = await open('Fugaz'); gone.ws.close();
  await until(() => starts === 2 && gone.closed !== null);
  // The recovered field has nobody of the vanished page: the address brings its two players in.
  const ana = await connect('Ana');
  assert(ana.welcome, ana.refused?.error); assert.deepEqual(ana.welcome.faction.strangers.map(p => p.name), []);
  const bia = await connect('Bia');
  assert(bia.welcome, bia.refused?.error); assert.deepEqual(bia.welcome.faction.strangers.map(p => p.name), ['Ana']);
  assert.equal(gone.welcome, undefined); assert(!gone.messages.some(m => m.type === 'welcome'));
});
