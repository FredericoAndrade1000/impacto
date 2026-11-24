import test from 'node:test';
import assert from 'node:assert/strict';
import { checkServerEntry, compatible, loadServerList, measureServer, pageField, typedServer } from '../src/server-browser.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { DEFAULT_SOURCE_URL } from '../src/source-url.ts';

const local = pageField(new URL('https://oficial.example/'));
const config = { directory: 'https://lista.example', official: local.href };
const status = { network: NETWORK_VERSION, core: CORE_CONTRACT, players: 3, capacity: 32 };
const signal = () => new AbortController().signal;

test('the source link uses the page host configuration even without a directory', async t => {
  let offered;
  const custom = 'https://codigo.example/projeto/release';
  const withCredentials = new URL(custom);
  withCredentials.username = 'example';
  withCredentials.password = 'test';
  for (const source of [custom, 'javascript:alert(1)', withCredentials.href, undefined]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ directory: null, source }));
    assert.equal((await loadServerList(signal(), false, url => { offered = url; })).state, 'disabled');
    assert.equal(offered, source === custom ? custom : DEFAULT_SOURCE_URL);
    fetch.mock.restore();
  }
});

test('an empty or disabled list still permits immediate entry on this page', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async url => Response.json(
    String(url) === '/api/server-directory' ? config : { servers: [] }));
  assert.deepEqual(await loadServerList(signal()), { state: 'loaded', official: local.href, servers: [] });
  assert.equal(mock.mock.calls.length, 2);
  assert.equal(await checkServerEntry(local, local, signal()), 'compatible');
  assert.equal(mock.mock.calls.length, 2);
  mock.mock.mockImplementation(async () => Response.json({ directory: null }));
  assert.equal((await loadServerList(signal())).state, 'disabled');
});

test('an offline list retains the local entry choice and trusted official address', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url) === '/api/server-directory') return Response.json(config);
    throw new Error('offline');
  });
  assert.deepEqual(await loadServerList(signal()), { state: 'offline', official: local.href, servers: [] });
  assert.equal(await checkServerEntry(local, local, signal()), 'compatible');
});

test('the menu checks core and wire versions and ignores an official flag from a different address', async t => {
  const shared = { ...status, description: '', region: 'Brasil', language: 'pt-BR', field: 'Principal', official: true };
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url) === '/api/server-directory' ? config : { servers: [
    { ...shared, address: 'wss://campo.example/world', name: '<b>Campo</b>', core: CORE_CONTRACT + 1 },
    { ...shared, address: local.href, name: 'Oficial' },
  ] }));
  const { servers } = await loadServerList(signal());
  assert.deepEqual(servers.map(server => [server.name, server.official, compatible(server)]),
    [['<b>Campo</b>', false, false], ['Oficial', true, true]]);
  assert.equal(compatible({ ...status, network: NETWORK_VERSION + 1 }), false);
});

test('typed addresses are canonical and checked without credentials or redirects', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(status));
  const withCredentials = new URL('wss://campo.example/world');
  withCredentials.username = 'u';
  withCredentials.password = 'p';
  for (const unsafe of ['javascript:alert(1)', 'http://campo.example', withCredentials.href,
    'wss://campo.example/other', 'wss://campo.example/world?token=key', 'wss://campo.example/world#'])
    assert.equal(await checkServerEntry(typedServer(unsafe), local, signal()), 'invalid', unsafe);
  assert.equal(mock.mock.calls.length, 0);
  const address = typedServer('Campo.Example:8443');
  assert.equal(address.href, 'wss://campo.example:8443/world');
  assert.equal(await checkServerEntry(address, local, signal()), 'compatible');
  const [url, options] = mock.mock.calls[0].arguments;
  assert.equal(url, 'https://campo.example:8443/api/server-status');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.ok(Number.isInteger((await measureServer(address, signal())).ping));
  mock.mock.mockImplementation(async () => Response.json({ ...status, core: CORE_CONTRACT + 1 }));
  assert.equal(await checkServerEntry(address, local, signal()), 'incompatible');
  mock.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  assert.equal(await checkServerEntry(address, local, signal()), 'unavailable');
});
