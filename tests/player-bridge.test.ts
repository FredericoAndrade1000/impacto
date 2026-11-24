import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attachNetworkServer } from '../server/network-server.ts';
import { record } from '../src/wire-shape.ts';
import { readPlayerRequest } from '../scripts/player/contract.ts';
import { PlayerSession } from '../scripts/player/session.ts';
import { servePlayer, callPlayer } from '../scripts/player/transport.ts';
import { PlayerObservation, quoteDesign } from '../scripts/player/observation.ts';
import { NetworkClient } from '../src/network-client.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { bill, billSum } from '../src/economy.ts';
import { factionView, fieldUnit, squadView } from './helpers/network-fixtures.js';
import type { FieldView } from '../src/faction-ui.ts';
import type { DrawingModule } from '../src/scene-drawing-contract.ts';

await initNativeDynamics();
const directory = () => mkdtempSync(join(tmpdir(), 'impacto-player-bridge-'));
function clean(path: string) { assert(path.startsWith(join(tmpdir(), 'impacto-player-bridge-'))); rmSync(path, { recursive: true, force: true }); }
function state() {
  const client = new NetworkClient(new URL('http://127.0.0.1:8404'));
  client.playerId = 'p1'; client.token = 'private-player-key'; client.connected = true; client.phase = 'connected';
  client.faction = factionView({ id: 'f1', units: [fieldUnit({ id: 'own', vehicle: true, value: bill(100, 0, 0, 10) })], deposits: [],
    stock: bill(90000, 10000, 10000, 1500), industry: { levels: { workshop: 1, hangar: 0, processing: 1 }, pending: null } });
  client.squad = squadView({ units: [{ id: 'own', move: { x: 100 }, activity: 'moving', reason: '' }] });
  const part: DrawingModule = { id: 'own-camera', actorId: 'own', kind: 'sensor', x: 0, y: 1, angle: 0, width: 1, height: 1,
    attached: true, health: 20, maxHealth: 40 };
  const scene: FieldView = { time: 10, actors: [
    { id: 'own', x: 0, y: 1, team: 'f1', ownerId: 'p1', name: 'Own vehicle', vehicle: { x: 0, y: 1, fuelLitres: 100 } },
    { id: 'contact', x: 800, y: 1, team: 'f2', name: 'Observed hull' },
    { id: 'memory', x: 1600, y: 1, team: 'f2', ghost: { since: 5 } },
  ], modules: [part], plates: [] };
  return { client, scene, receivedAt: performance.now() };
}
test('the player contract excludes privileged commands and invalid or ambiguous intentions', () => {
  for (const request of [
    { op: 'test', act: 'resources' }, { op: 'order', reason: 'x', action: { kind: 'repair', ids: ['own'], instant: true } },
    { op: 'build', design: { model: 'scout' }, reason: 'x', instant: true },
    { op: 'order', reason: 'x', action: { kind: 'move', ids: ['own', 'own'], x: 1 } },
    { op: 'order', reason: 'x', action: { kind: 'move', ids: [], x: 1 } },
    { op: 'order', reason: 'x', action: { kind: 'move', ids: ['own'], x: NaN } },
    { op: 'quote', design: { model: 'not-a-template' } }, { op: 'speed', factor: 16, reason: 'x' },
    { op: 'wait', after: -1 }, { op: 'wait', after: 0, wallSeconds: 60 },
  ]) assert.throws(() => readPlayerRequest(request));
  assert.equal(readPlayerRequest({ op: 'order', reason: 'Regroup', action: { kind: 'move', ids: ['own'], x: 100 } }).op, 'order');
});
test('observations contain only public faction data and distinguish memories from current contacts', () => {
  const view = state(), summary = new PlayerObservation().summary(view), encoded = JSON.stringify(summary);
  assert(!encoded.includes(view.client.token!));
  assert.equal(summary.units.length, 1); assert.equal(summary.units[0]!.health!.share, .5);
  assert.equal(summary.contacts.find(c => c.id === 'memory')!.knowledge, 'remembered');
  assert.equal(summary.contacts.find(c => c.id === 'contact')!.knowledge, 'current');
  assert.equal(summary.contacts.find(c => c.id === 'contact')!.observedWeapons.length, 0);
  assert(!('armed' in summary.contacts[0]!), 'missing enemy parts must not certify an unarmed enemy');
  assert.equal(summary.deposits.length, 0, 'unknown deposits are not synthesized from the world');
});
test('quotes reuse Native prices and published residual value for a replacement', () => {
  const view = state(), full = quoteDesign({ model: 'scout' }, view).quote,
    replacement = quoteDesign({ model: 'scout' }, view, 'own').quote;
  assert.deepEqual(replacement.cost, billSum(full.cost, view.client.faction!.units[0]!.value, -1));
  assert.deepEqual(replacement.fullCost, full.cost);
  assert.throws(() => quoteDesign({ model: 'scout' }, view, 'contact'), /this faction/);
});
test('separate local calls retain one session; waiting does not block plans and retry IDs do not repeat mutations', async t => {
  const dir = directory(), session = new PlayerSession({ origin: new URL('http://127.0.0.1:8404'), directory: dir, name: 'Test', key: '', speed: 8 });
  const server = await servePlayer(session); t.after(async () => { try { await server.close(); } finally { clean(dir); } });
  const originalSocket = session.client.socket;
  const first = await callPlayer(dir, { op: 'observe' }); assert(first.ok);
  const waiting = callPlayer(dir, { op: 'wait', after: session.observe().cursor, kinds: ['command'], wallSeconds: 2 });
  const request = { op: 'plan', goal: 'Protect income and regroup', notes: 'Try a flank before slowing the clock' } as const;
  const plan = await callPlayer(dir, request, 'stable-plan-id'); assert(plan.ok);
  assert.deepEqual(await callPlayer(dir, request, 'stable-plan-id'), plan);
  const conflict = await callPlayer(dir, { ...request, goal: 'Different plan' }, 'stable-plan-id'); assert.equal(conflict.ok, false);
  const wake = await waiting; assert(wake.ok);
  const log = readFileSync(join(dir, 'commands.jsonl'), 'utf8').trim().split('\n'); assert.equal(log.length, 1);
  assert.equal(session.client.socket, originalSocket, 'tool calls do not reconnect the player');
  assert(existsSync(join(dir, 'plan.json')));
  assert(!JSON.stringify(first).includes(JSON.parse(readFileSync(join(dir, 'connection.json'), 'utf8')).secret));
});
test('a stale connection refuses game mutations but retains a queryable state and plan', async t => {
  const dir = directory(), session = new PlayerSession({ origin: new URL('http://127.0.0.1:8404'), directory: dir, name: 'Test', key: '', speed: 8 });
  t.after(() => { try { session.close(); } finally { clean(dir); } });
  const answer = await session.request({ op: 'order', reason: 'Do not act on disconnected data', action: { kind: 'home', ids: ['own'] } });
  assert.equal(answer.ok, false);
  assert((await session.request({ op: 'observe' })).ok);
  assert((await session.request({ op: 'plan', goal: 'Wait for connection' })).ok);
});

test('abandoning an event wait releases it while the player session remains usable', async t => {
  const dir = directory(), session = new PlayerSession({ origin: new URL('http://127.0.0.1:8404'), directory: dir, name: 'Test', key: '', speed: 8 });
  t.after(() => { try { session.close(); } finally { clean(dir); } });
  const cancelled = new AbortController(), waiting = session.request({ op: 'wait', after: session.observe().cursor, wallSeconds: 45 }, 'cancel-wait', cancelled.signal);
  cancelled.abort(); const answer = await waiting;
  assert(answer.ok && record(answer.value)); assert.equal(answer.value.reason, 'cancelled');
  assert((await session.request({ op: 'plan', goal: 'Continue through the same bridge' })).ok);
});

test('the bridge plays through the real player socket with paid Native quotes and stable ownership between local calls', { timeout: 30000 }, async t => {
  const dir = directory(), sessionDir = join(dir, 'player');
  const { mkdirSync } = await import('node:fs'); mkdirSync(sessionDir);
  const stamp = 'abcd1234abcd1234', http = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<meta name="impacto-build" content="${stamp}">`);
  });
  const field = attachNetworkServer(http, { testTools: true, stamp: () => stamp, save: { dir: join(dir, 'field') } });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert(address && typeof address !== 'string');
  const session = new PlayerSession({ origin: new URL(`http://127.0.0.1:${address.port}`), directory: sessionDir, key: '', name: 'Bridge integration', speed: 8 });
  const local = await servePlayer(session);
  t.after(async () => { try { await local.close(); await field.close(); await new Promise<void>(done => http.close(() => done())); } finally { clean(dir); } });
  const opening = await session.connect(), socket = session.client.socket, player = session.client.playerId;
  assert.equal(opening.factor, 8); assert.equal(opening.units.length, 3);
  const miner = opening.units.find(u => u.capabilities.extracts.includes('ferro')); assert(miner && miner.x !== null);
  const quote = await callPlayer(sessionDir, { op: 'quote', design: { model: 'scout' } });
  assert(quote.ok && record(quote.value));
  const build = await callPlayer(sessionDir, { op: 'build', design: { model: 'scout' }, reason: 'Normal paid fabrication through the bridge' }, 'native-paid-scout');
  assert(build.ok && record(build.value) && record(build.value.result));
  assert.deepEqual(build.value.result.cost, quote.value.cost);
  assert.deepEqual(await callPlayer(sessionDir, { op: 'build', design: { model: 'scout' }, reason: 'Normal paid fabrication through the bridge' }, 'native-paid-scout'), build);
  const auto = await callPlayer(sessionDir, { op: 'order', reason: 'Retain an explicit travel order', action: { kind: 'auto', ids: [miner.id], on: false } }); assert(auto.ok);
  const movement = await callPlayer(sessionDir, { op: 'order', reason: 'Normal physical travel', observedAt: opening.at!, action: { kind: 'move', ids: [miner.id], x: miner.x + 20 } }); assert(movement.ok);
  const mark = session.observe().cursor;
  const after = await callPlayer(sessionDir, { op: 'wait', after: mark, simSeconds: 2, kinds: [], wallSeconds: 5 });
  assert(after.ok); assert.equal(session.client.socket, socket); assert.equal(session.client.playerId, player);
  const inspected = await callPlayer(sessionDir, { op: 'inspect', actorId: miner.id, blueprint: true });
  assert(inspected.ok && record(inspected.value) && record(inspected.value.vehicle));
  assert.equal(typeof inspected.value.vehicle.x, 'number'); assert(record(inspected.value.blueprint));
  assert.equal(session.observe().units.filter(u => !u.defeated).length, 4, 'one paid fabrication, not two');
  assert(session.client.squad!.units.find(u => u.id === miner.id)!.move, 'closing tool sockets did not send Home');
  const clock = await callPlayer(sessionDir, { op: 'speed', factor: 4, reason: 'Technical validation of explicit clock control' }); assert(clock.ok);
  assert.equal(session.client.testSpeed, 4);
  const snapshot = JSON.stringify(session.observe()); assert(!snapshot.includes(session.client.token!));
  const stale = await callPlayer(sessionDir, { op: 'wait', after: '00000000-0000-0000-0000-000000000000:0', wallSeconds: 1 });
  assert.equal(stale.ok, false, 'a cursor from another daemon cannot silently consume events');
  // Exercise the real CLI daemon and its separate short-lived CLI callers.
  // A daemon restart is an explicit disconnect; ordinary tool calls are not.
  await local.close();
  const cliDir = join(dir, 'cli'), child = spawn(process.execPath, ['scripts/player.ts', 'start', '--session', cliDir,
    '--server', session.options.origin.origin, '--key-file', join(sessionDir, 'seat.json'), '--speed', '4'], { windowsHide: true });
  const exit = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  await new Promise<void>((done, reject) => {
    let text = ''; const timeout = setTimeout(() => reject(new Error('CLI start timed out: ' + errors)), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CLI start exited ${code}: ${errors}`)); });
    child.stdout.on('data', data => { text += data; if (text.includes('"started":true')) { clearTimeout(timeout); done(); } });
  });
  const run = promisify(execFile), observeCli = async () => {
    const { stdout } = await run(process.execPath, ['scripts/player.ts', 'observe', '--session', cliDir], { encoding: 'utf8', windowsHide: true });
    const reply: unknown = JSON.parse(stdout); assert(record(reply) && reply.ok === true && record(reply.value)); return reply.value;
  };
  const cliFirst = await observeCli(); assert(record(cliFirst.connection)); assert.equal(cliFirst.connection.playerId, player);
  await run(process.execPath, ['scripts/player.ts', 'plan', '--session', cliDir, '--goal', 'Try another strategy before reducing the clock'], { windowsHide: true });
  const cliSecond = await observeCli(); assert(record(cliSecond.plan));
  assert.equal(cliSecond.plan.goal, 'Try another strategy before reducing the clock');
  assert.equal(cliSecond.factor, 4);
  await run(process.execPath, ['scripts/player.ts', 'stop', '--session', cliDir], { windowsHide: true });
  assert.equal((await exit)[0], 0);
});
