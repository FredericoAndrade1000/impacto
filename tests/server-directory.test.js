import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { DIRECTORY_LEASE_MS } from '../src/server-directory-contract.ts';
import { createDirectory, digest } from '../server/server-directory.ts';
import { probeWorld, publicProbeIP } from '../server/directory-probe.ts';
import { announceField, directoryConfig } from '../server/directory-announcer.ts';

const field = { address: 'wss://campo.example/world', name: 'Campo', description: '', region: 'Brasil',
  language: 'pt-BR', field: 'Principal', network: 91, core: 90, players: 2, capacity: 32 };
const key = randomBytes(32).toString('base64url');
const official = 'wss://oficial.example/world', page = 'https://jogo.example';
async function fixture(t) {
  let now = 0, status = { network: field.network, core: field.core };
  const probes = [], hashes = new Map([[field.address, digest(key)], [official, digest(key)]]);
  const server = createDirectory({ readKey: address => hashes.get(address), now: () => now, official,
    origins: new Set([page]), probe: async address => { probes.push(address.href); return status; } });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port, url = origin + '/servers';
  return { origin, probes, advance: ms => now += ms, versions: value => status = value, get: headers => fetch(url, { headers }),
    announce: (data = field, bearer = key) => fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer }, body: JSON.stringify(data) }) };
}

test('publishes a verified lease, with the official address first and read-only CORS', async t => {
  const { announce, get, probes } = await fixture(t);
  assert.equal((await announce({ ...field, official: true })).status, 204);
  assert.equal((await announce({ ...field, address: official, name: 'Z' })).status, 204);
  assert.deepEqual(probes, [field.address, official]);
  const response = await get({ Origin: page });
  assert.equal(response.headers.get('access-control-allow-origin'), page);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=10');
  assert.deepEqual((await response.json()).servers.map(row => [row.address, row.official]), [[official, true], [field.address, false]]);
  assert.equal((await get({ Origin: 'https://outra.example' })).headers.get('access-control-allow-origin'), null);
});

test('rejects malformed announcements and keys before doing any network verification', async t => {
  const { announce, get, probes } = await fixture(t);
  assert.equal((await announce({ ...field, players: 33 })).status, 400);
  assert.equal((await announce({ ...field, address: 'ws://192.168.1.1/world' })).status, 400);
  assert.equal((await announce({ ...field, name: '\u0000', description: '' })).status, 400);
  assert.equal((await announce({ ...field, description: 'x'.repeat(5_000) })).status, 400);
  assert.equal((await announce(field, randomBytes(32).toString('base64url'))).status, 401);
  assert.equal((await announce({ ...field, address: 'wss://outra.example/world' })).status, 401);
  assert.deepEqual(probes, []);
  assert.deepEqual(await (await get()).json(), { servers: [] });
});

test('caps announcement text and strips control characters, keeping markup as plain JSON data', async t => {
  const { announce, get } = await fixture(t);
  const name = '<img src=x onerror=alert(1)>';
  assert.equal((await announce({ ...field, name: '\u202e' + name + '\u0000', description: 'x'.repeat(200),
    region: 'América\nLatina' })).status, 204);
  const [row] = (await (await get()).json()).servers;
  assert.equal(row.name, name);
  assert.equal(row.description.length, 140);
  assert.equal(row.region, 'América Latina');
});

test('both live versions must match; unreachable and expired servers disappear', async t => {
  const { announce, get, advance, versions } = await fixture(t);
  versions({ network: 92, core: 90 });
  assert.equal((await announce()).status, 422);
  advance(20_000); versions({ network: 91, core: 89 });
  assert.equal((await announce()).status, 422);
  advance(20_000); versions({ network: 91, core: 90 });
  assert.equal((await announce()).status, 204);
  assert.equal((await (await get()).json()).servers.length, 1);
  advance(DIRECTORY_LEASE_MS);
  assert.deepEqual(await (await get()).json(), { servers: [] });
  assert.equal((await announce()).status, 204);
  advance(20_000); versions(null);
  assert.equal((await announce()).status, 422);
  assert.deepEqual(await (await get()).json(), { servers: [] });
});

test('limits an announcing key, unauthenticated requests and list queries', async t => {
  const { announce, get, probes } = await fixture(t);
  assert.equal((await announce()).status, 204);
  assert.equal((await announce()).status, 204);
  assert.equal((await announce()).status, 429);
  for (let i = 0; i < 5; i++) assert.equal((await announce(field, '')).status, 401);
  assert.equal((await announce(field, '')).status, 429);
  for (let i = 0; i < 12; i++) assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 429);
  assert.equal(probes.length, 2);
});

test('probes reject local, translated and reserved addresses', async () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '192.168.0.1',
    '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '64:ff9b::7f00:1', '2001:db8::1'])
    assert.equal(publicProbeIP(address), false, address);
  assert.equal(publicProbeIP('8.8.8.8'), true);
  assert.equal(publicProbeIP('2606:4700::1111'), true);
  assert.equal(await probeWorld(new URL('wss://127.0.0.1/world')), null);
});

test('announcement is off without a key and sends the live versions and occupancy when enabled', async t => {
  const { origin, get } = await fixture(t);
  assert.equal(directoryConfig({}, null, true).announcement, null);
  assert.equal(directoryConfig({ IMPACTO_DIRECTORY_URL: origin }, null, true).announcement, null);
  const options = directoryConfig({ IMPACTO_DIRECTORY_URL: origin, IMPACTO_DIRECTORY_KEY: key,
    IMPACTO_DIRECTORY_NAME: field.name, IMPACTO_DIRECTORY_REGION: field.region, IMPACTO_DIRECTORY_LANGUAGE: field.language },
  new URL(field.address), true);
  const { network, core, players, capacity } = field;
  const stop = announceField(options.announcement, () => ({ network, core, players, capacity }));
  t.after(stop);
  for (let i = 0; i < 10; i++) {
    const { servers } = await (await get()).json();
    if (servers.length) {
      assert.deepEqual([servers[0].network, servers[0].core, servers[0].players, servers[0].capacity], [network, core, players, capacity]);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('announcement was not received');
});
