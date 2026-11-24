import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientPerformance } from '../src/client-performance.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { serveNetwork } from './helpers/network.js';

test('device reports stop at the authenticated network boundary and never reach the physics worker', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'impacto-performance-network-'));
  assert(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  const entry = join(dir, 'worker.mjs');
  await writeFile(entry, `import { parentPort } from 'node:worker_threads';
    const commands = [];
    parentPort.on('message', message => {
      if (message.type === 'save') { Atomics.store(message.done, 0, 1); Atomics.notify(message.done, 0); return; }
      if (message.type !== 'command') return;
      commands.push(message.data.type);
      parentPort.postMessage({ type: 'direct', peerId: message.peerId, payload: message.data.type === 'hello'
        ? { type: 'welcome' } : { type: 'reply', commands } });
    });`);
  const { socket: open, close } = await serveNetwork(t, { entry: () => pathToFileURL(entry), save: { dir } }), socket = open();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  await once(socket, 'open');
  const payloads = [], sampler = new ClientPerformance({ device: { browser: 'Google Chrome', major: 140, platform: 'Android', model: 'SM-A155M',
    logicalCoresHint: 8, memoryHintGiB: 4, gpu: 'Mali-G57 MC2', gpuVendor: 'ARM' }, send: report => payloads.push(report),
    context: () => ({ mode: 'field', viewport: [844, 390], canvas: [844, 390], pixels: [844, 390], dpr: 1, resolution: 1,
      zoom: 24, actors: 2, visible: 2, moving: 1, particles: 0, shots: 0, pingMs: 10 }) });
  const connection = {}; for (let now = 0; now <= 10_000; now += 20) sampler.frame(now, true, 0, connection);
  const packet = JSON.stringify({ type: 'performance', ...payloads[0], token: 'must-not-be-stored', name: 'not-stored', ip: 'not-stored' });
  socket.send(packet);
  const welcome = once(socket, 'message'); socket.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION }));
  assert.equal(JSON.parse((await welcome)[0]).type, 'welcome');
  socket.send(packet); socket.send(packet);
  const reply = once(socket, 'message'); socket.send(JSON.stringify({ type: 'ping' }));
  assert.deepEqual(JSON.parse((await reply)[0]).commands, ['hello', 'ping']);
  const stopped = once(socket, 'close'); await close();
  assert.equal((await stopped)[0], 1001, 'server shutdown reaches the client before transport cleanup');
  const lines = (await readFile(join(dir, 'client-performance.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, 'unauthenticated and rate-limited packets write nothing');
  assert.equal(JSON.parse(lines[0]).device.model, 'SM-A155M'); assert(!/must-not-be-stored|not-stored|"token"|"name"|"ip"/.test(lines[0]));
});
