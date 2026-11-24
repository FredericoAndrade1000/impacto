import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { serveNetwork } from './helpers/network.js';
import { fieldServerConfig } from '../server/field-config.ts';
import { playerAddress, proxyTrust } from '../server/network-address.ts';
import { WORLD_LIMITS as LIMIT } from '../server/network-limits.ts';
import { NetworkClient } from '../src/network-client.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';

const fixture = () => new URL('./helpers/world-security-worker.js', import.meta.url);
const hello = (ws, name = 'Jogador') => ask(ws, { type: 'hello', version: NETWORK_VERSION, name });
const send = (ws, data) => ws.send(JSON.stringify(data));
function read(ws) { return once(ws, 'message').then(([raw]) => JSON.parse(raw)); }
function ask(ws, data) { const reply = read(ws); send(ws, data); return reply; }
async function open(network, headers, perMessageDeflate = { concurrencyLimit: LIMIT.deflate.concurrencyLimit }) {
  const ws = network.socket(network.url, { headers, perMessageDeflate });
  await once(ws, 'open');
  return ws;
}
function denied(network, headers) {
  const ws = network.socket(network.url, { headers });
  return once(ws, 'error').then(([error]) => error.message);
}

test('forwarded addresses apply only to configured peers and the configured header', () => {
  const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  const cf = 'cf-connecting-ip', xff = 'x-forwarded-for', headers = { [cf]: '203.0.113.7', [xff]: '203.0.113.8' };
  const cloudflare = proxyTrust('172.29.110.2, ::1', cf);
  for (const direct of ['127.0.0.1', '172.29.110.1', '192.168.0.12', '198.51.100.2'])
    assert.equal(playerAddress(request(direct, headers), cloudflare), direct);
  assert.equal(playerAddress(request('::ffff:ac1d:6e02', headers), cloudflare), '203.0.113.7');
  assert.equal(playerAddress(request('0:0:0:0:0:0:0:1', { [cf]: '2001:0db8:00ab:0001::7' }), cloudflare), '2001:db8:ab:1::/64');
  assert.equal(playerAddress(request('172.29.110.2', { [xff]: '203.0.113.9' }), cloudflare), '172.29.110.2');
  assert.equal(playerAddress(request('172.29.110.2', { [cf]: '203.0.113.7, 203.0.113.8' }), cloudflare), '172.29.110.2');
  assert.equal(playerAddress(request('2001:0db8:0001:0002::9%eth0'), cloudflare), '2001:db8:1:2::/64');
  const chain = proxyTrust('127.0.0.1, 172.29.110.2');
  assert.equal(playerAddress(request('127.0.0.1', { [cf]: '203.0.113.7', [xff]: '203.0.113.8, 198.51.100.2, 172.29.110.2' }), chain), '198.51.100.2');
  assert.equal(playerAddress(request('127.0.0.1', { [xff]: '203.0.113.8, inválido' }), chain), '127.0.0.1');
  assert.throws(() => proxyTrust('172.29.110.0/29'), /endereços IP/);
  assert.throws(() => proxyTrust('', 'host'), /IMPACTO_PROXY_IP_HEADER/);
});

test('the WebSocket limit uses the socket address when clients supply forwarding headers directly', { timeout: 10_000 }, async t => {
  const network = await serveNetwork(t, { entry: fixture, perAddress: true });
  for (let i = 0; i < LIMIT.socketsPerAddress; i++) {
    const ws = await open(network, { 'CF-Connecting-IP': `203.0.113.${i + 1}`, 'X-Forwarded-For': `198.51.100.${i + 1}` });
    assert.equal((await hello(ws)).address, '127.0.0.1');
  }
  assert.match(await denied(network, { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '198.51.100.9' }), /429/);
});

test('the address opening quota leaves capacity for other addresses', { timeout: 10_000 }, async t => {
  t.mock.method(performance, 'now', () => 0);
  const network = await serveNetwork(t, { entry: fixture, perAddress: true, trust: proxyTrust('127.0.0.1', 'cf-connecting-ip') });
  const home = { 'CF-Connecting-IP': '203.0.113.7' };
  for (let i = 0; i < LIMIT.openPerAddress[1]; i++) {
    const ws = await open(network, home);
    const closed = once(ws, 'close');
    ws.close();
    await closed;
  }
  for (let i = 0; i < LIMIT.openGlobal[1]; i++) assert.match(await denied(network, home), /429/);
  const away = await open(network, { 'CF-Connecting-IP': '198.51.100.2' });
  assert.equal((await hello(away)).address, '198.51.100.2');
});

test('public upgrades require TLS, with forwarded HTTPS only from the configured proxy', { timeout: 10_000 }, async t => {
  const publicHost = 'impacto.example', headers = { Host: publicHost, 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '203.0.113.7' };
  const direct = await serveNetwork(t, { entry: fixture, publicHost });
  assert.match(await denied(direct, headers), /403/);
  assert.equal((await hello(await open(direct))).type, 'welcome', 'local access');
  const tunnel = await serveNetwork(t, { entry: fixture, publicHost, perAddress: true, trust: proxyTrust('127.0.0.1', 'cf-connecting-ip') });
  assert.match(await denied(tunnel, { ...headers, 'X-Forwarded-Proto': 'http' }), /403/);
  assert.equal((await hello(await open(tunnel, headers))).address, '203.0.113.7');
});

test('cross-site world upgrades use the exact origin allowlist and expose ready versions', { timeout: 10_000 }, async t => {
  const origin = 'https://menu.example', network = await serveNetwork(t, { entry: fixture, clientOrigins: new Set([origin]) });
  assert.match(await denied(network, { Origin: 'https://other.example' }), /hang up/);
  assert.match(await denied(network, { Origin: origin + ':8443' }), /hang up/);
  assert.equal((await hello(await open(network, { Origin: origin }))).type, 'welcome');
  const probe = network.socket(network.url);
  const [response] = await once(probe, 'upgrade');
  assert.equal(response.headers['impacto-network'], String(NETWORK_VERSION));
  assert.equal(response.headers['impacto-core'], String(CORE_CONTRACT));
});

test('production rejects all privileged field modes', () => {
  for (const flag of ['IMPACTO_TEST_SERVER', 'IMPACTO_TEST_SAVE_DIR', 'IMPACTO_TEST_COMMANDERS', 'IMPACTO_REHEARSAL', 'IMPACTO_STRESS'])
    assert.throws(() => fieldServerConfig({ IMPACTO_ADDRESS: 'https://impacto.example', [flag]: '1' }), /produção/);
  assert.throws(() => fieldServerConfig({ NODE_ENV: 'production', IMPACTO_STRESS: '1' }), /produção/);
  assert.throws(() => fieldServerConfig({ IMPACTO_REHEARSAL: '1' }, true), /produção/);
  assert.deepEqual(fieldServerConfig({ NODE_ENV: 'production', IMPACTO_TEST_SERVER: '0' }), { testTools: false, save: null });
});

test('unadmitted peers have bounded slots and commands stop at the network host until welcome', { timeout: 10_000 }, async t => {
  const network = await serveNetwork(t, { entry: fixture });
  const waiting = await open(network);
  for (let i = 1; i < LIMIT.greetings; i++) await open(network);
  assert.match(await denied(network), /429/);
  const closed = once(waiting, 'close');
  send(waiting, { type: 'spawn', blueprint: createStructuredTemplate('scout') });
  assert.match(String((await closed)[1]), /Entre no campo/);
  const ws = await open(network);
  await hello(ws);
  assert.equal((await ask(ws, { type: 'ping', time: 10 })).received, 2, 'worker saw only hello and ping');
  const repeated = once(ws, 'close');
  send(ws, { type: 'hello', version: NETWORK_VERSION, name: 'Outro' });
  assert.match(String((await repeated)[1]), /já foi solicitada/);
});

test('payload size, JSON shape and flood limits apply before posting to the worker', { timeout: 10_000 }, async t => {
  const network = await serveNetwork(t, { entry: fixture });
  const cases = [
    [1009, ws => send(ws, { type: 'spawn', blueprint: { name: 'x'.repeat(LIMIT.payload) } })],
    [1008, ws => send(ws, { type: 'aim', pad: 'x'.repeat(LIMIT.lightPayload) })],
    [1008, ws => ws.send(`{"type":"aim","pad":${'['.repeat(LIMIT.depth + 1)}0${']'.repeat(LIMIT.depth + 1)}}`)],
    [1008, ws => { for (let i = 0; i < LIMIT.socketRate.messages[1] + 20; i++) send(ws, { type: 'ping', time: i }); }],
  ];
  for (const [code, transmit] of cases) {
    const ws = await open(network, undefined, false);
    assert.equal(ws.extensions, '');
    await hello(ws);
    const closed = once(ws, 'close');
    transmit(ws);
    assert.equal((await closed)[0], code);
  }
});

test('deflate negotiates bounded windows, including clients that omit the client window parameter', { timeout: 10_000 }, async t => {
  const network = await serveNetwork(t, { entry: fixture });
  for (const [offer, serverBits, clientBits] of [
    [{}, LIMIT.deflate.serverMaxWindowBits, LIMIT.deflate.clientMaxWindowBits],
    [{ clientMaxWindowBits: false }, LIMIT.deflate.serverMaxWindowBits, undefined],
    [{ serverMaxWindowBits: 10, clientMaxWindowBits: 10 }, 10, 10],
  ]) {
    const ws = network.socket(network.url, { perMessageDeflate: { ...offer, concurrencyLimit: LIMIT.deflate.concurrencyLimit } });
    const [response] = await once(ws, 'upgrade');
    const [extension, ...params] = response.headers['sec-websocket-extensions'].split('; ');
    assert.equal(extension, 'permessage-deflate');
    assert(params.includes('server_no_context_takeover'));
    assert(params.includes('client_no_context_takeover'));
    assert(params.includes(`server_max_window_bits=${serverBits}`));
    assert.equal(params.find(param => param.startsWith('client_max_window_bits=')),
      clientBits === undefined ? undefined : `client_max_window_bits=${clientBits}`);
    assert.equal((await hello(ws)).type, 'welcome');
  }
});

test('inflate rejects an oversized compressed message before materializing its output', { timeout: 10_000 }, async t => {
  const network = await serveNetwork(t, { entry: fixture });
  const ws = network.socket(network.url, { perMessageDeflate: { concurrencyLimit: LIMIT.deflate.concurrencyLimit } });
  const [{ socket }] = await once(ws, 'upgrade');
  assert.equal((await hello(ws)).type, 'welcome');
  assert.equal(ws.extensions, 'permessage-deflate');

  let inflated = 0;
  const createInflate = zlib.createInflateRaw;
  t.mock.method(zlib, 'createInflateRaw', options => {
    assert.equal(options.chunkSize, LIMIT.deflate.zlibInflateOptions.chunkSize);
    assert.equal(options.windowBits, LIMIT.deflate.clientMaxWindowBits);
    const stream = createInflate(options), push = stream.push;
    stream.push = function (chunk, encoding) {
      if (chunk) inflated += chunk.byteLength;
      return push.call(this, chunk, encoding);
    };
    return stream;
  });
  const oversized = Buffer.from(JSON.stringify({ type: 'spawn', blueprint: { name: 'x'.repeat(8 * 1024 * 1024) } }));
  const initialWritten = socket.bytesWritten, initialPeak = process.resourceUsage().maxRSS;
  const closed = once(ws, 'close');
  ws.send(oversized, { binary: false });
  assert.equal((await closed)[0], 1009);
  const written = socket.bytesWritten - initialWritten, peakIncrease = process.resourceUsage().maxRSS - initialPeak;
  assert(written < LIMIT.payload, 'the compressed frame fits the wire limit');
  assert(inflated > LIMIT.payload && inflated <= LIMIT.payload + LIMIT.deflate.zlibInflateOptions.chunkSize);
  t.diagnostic(`Mensagem de ${oversized.byteLength} B, ${written} B no socket (com fechamento), inflate interrompido em ${inflated} B. Aumento do pico de RSS do processo de teste: ${peakIncrease} KiB.`);
});

test('expensive commands are shed and the worker queue stays bounded even without acknowledgements', { timeout: 10_000 }, async t => {
  const network = await serveNetwork(t, { entry: fixture });
  const ws = await open(network);
  await hello(ws);
  for (let request = 1; request <= LIMIT.costlyPerSocket[1]; request++)
    assert.equal((await ask(ws, { type: 'blueprint', actorId: 'c1', request })).received, request + 1);
  assert.match((await ask(ws, { type: 'blueprint', actorId: 'c1', request: 50 })).error, /ocupado/);
  assert.equal((await ask(ws, { type: 'ping', time: 10 })).received, LIMIT.costlyPerSocket[1] + 2);

  const fill = socket => {
    for (let i = 0; i < LIMIT.queuedPerSocket; i++) send(socket, { type: 'drive', throttle: 1 });
  };
  fill(ws);
  assert.match((await ask(ws, { type: 'drive', throttle: 0, request: 99 })).error, /ocupado/);
  for (let i = 1; i < LIMIT.queuedGlobal / LIMIT.queuedPerSocket; i++) {
    const other = await open(network);
    await hello(other, `Jogador ${i}`);
    fill(other);
    await ask(other, { type: 'drive', throttle: 0, request: 99 });
  }
  const last = await open(network);
  const answer = await hello(last, 'Último');
  assert.match(answer.error, /ocupado/);
  assert.equal(answer.retryable, true);
});

test('the expensive command budget follows the seat when it reconnects', { timeout: 10_000 }, async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const network = await serveNetwork(t, { entry: fixture }), first = await open(network);
  await hello(first);
  const query = { type: 'blueprint', actorId: 'c1', request: 1 };
  for (let i = 0; i < LIMIT.costlyPerSeat[1]; i++) assert.equal((await ask(first, query)).error, undefined);
  const left = once(first, 'close'); first.close(); await left;
  const back = await open(network);
  await hello(back);
  assert.match((await ask(back, query)).error, /ocupado/);
  now = 1000;
  assert.equal((await ask(back, query)).error, undefined);
});

test('idle application sockets expire even while the peer responds to WebSocket pings', { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const network = await serveNetwork(t, { entry: fixture }), ws = await open(network);
  await hello(ws);
  const ping = once(ws, 'ping');
  now += LIMIT.heartbeatMs; t.mock.timers.tick(LIMIT.heartbeatMs);
  await ping;
  assert.equal(ws.readyState, WebSocket.OPEN);
  const closed = once(ws, 'close');
  now = LIMIT.idleMs; t.mock.timers.tick(LIMIT.heartbeatMs);
  assert.match(String((await closed)[1]), /inativa/);
});

test('the game client joins, drives, aims and publishes with measured traffic below the budgets', { timeout: 20_000 }, async t => {
  const network = await serveNetwork(t, { rehearsal: { bases: [0] }, perAddress: true });
  const outgoing = [], incoming = [], errors = [];
  let socket, transport, initialRead, initialWritten;
  class MeasuredSocket extends WebSocket {
    constructor(url) {
      super(url);
      socket = this;
      this.once('upgrade', ({ socket }) => {
        transport = socket;
        initialRead = socket.bytesRead;
        initialWritten = socket.bytesWritten;
      });
      this.on('message', raw => incoming.push(raw));
    }
    send(data) {
      outgoing.push({ now: performance.now(), type: JSON.parse(data).type, bytes: Buffer.byteLength(data) });
      super.send(data);
    }
  }
  const NativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = MeasuredSocket;
  t.after(() => { globalThis.WebSocket = NativeSocket; });
  const client = new NetworkClient(new URL(network.url.replace('ws:', 'http:')));
  t.after(() => { client.enabled = false; client.closeSocket(); });
  client.onerror = error => errors.push(error);
  const welcome = new Promise(resolve => { client.onwelcome = resolve; });
  client.connect('Cliente de teste');
  await welcome;
  const largest = CONSTRUCTION_TEMPLATES.map(({ id }) => createStructuredTemplate(id))
    .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
  const { actor } = await client.command('spawn', { blueprint: createStructuredTemplate('heavy'), x: 0, facing: 1 });
  await client.command('squad', { order: 'control', id: actor.id });
  await client.command('drive', { throttle: 1, brake: 0 });
  const { model } = await client.command('library', { act: 'publish', blueprint: largest });
  const start = performance.now();
  while (performance.now() - start < 3000) {
    client.aim({ x: 20 + (performance.now() - start) / 1000, y: 3 }, { id: 'cannon' });
    await delay(8);
  }
  await client.command('drive', { throttle: 0, brake: 1 });
  assert.equal(client.connected, true);
  assert.equal(socket.extensions, 'permessage-deflate');
  assert(model.id); assert.deepEqual(errors, []);
  assert(outgoing.filter(packet => packet.type === 'aim').length >= 20);
  assert(outgoing.filter(packet => packet.type === 'ping').length >= 4);
  const peak = Math.max(...outgoing.map(packet => outgoing.filter(item => item.now >= packet.now && item.now < packet.now + 1000).length));
  const largestPacket = Math.max(...outgoing.map(packet => packet.bytes));
  const light = outgoing.filter(packet => packet.type !== 'spawn' && packet.type !== 'library');
  const lightPeak = Math.max(...light.map(packet => light.filter(item => item.now >= packet.now && item.now < packet.now + 1000)
    .reduce((bytes, item) => bytes + item.bytes, 0)));
  assert(peak < LIMIT.socketRate.messages[0]);
  assert(largestPacket < LIMIT.payload);
  assert(lightPeak < LIMIT.lightBytes[0]);
  const bytes = incoming.reduce((size, raw) => size + raw.byteLength, 0),
    downloaded = transport.bytesRead - initialRead, uploaded = transport.bytesWritten - initialWritten;
  assert(downloaded < bytes, 'the negotiated extension reduces download bytes');
  assert(uploaded < outgoing.reduce((size, packet) => size + packet.bytes, 0), 'large client messages are compressed');
  t.diagnostic(`Cliente real, ${outgoing.length} mensagens, pico ${peak}/s e ${lightPeak} B leves/s, maior ${largestPacket} B. Payload da saída do campo: ${bytes} B. WebSocket: ${downloaded} B recebidos, ${uploaded} B enviados.`);
});
