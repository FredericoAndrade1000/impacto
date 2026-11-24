import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { NETWORK_VERSION } from '../src/network-protocol.ts';

test('page and lockfile releases are announced without unsafe HMR; changed backend waits for a real restart', { timeout: 20000 }, async () => {
  const fixture = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'impacto-manual-updates-'))),
    configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url)), source = join(fixture, 'src/app.js'),
    transport = join(fixture, 'server/network-server.ts');
  let server, socket, url;
  const start = async () => {
    // Node reads the TypeScript config directly, so Vite does not write a
    // temporary bundle into a node_modules junction shared by worktrees.
    server = await createServer({ configFile, configLoader: 'native', root: fixture, logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false } });
    const ready = once(server.watcher, 'ready'); await server.listen(); await ready;
    url = `http://127.0.0.1:${server.httpServer.address().port}`;
  }, change = async (file, text) => {
    const changed = new Promise((resolveChange, reject) => {
      const timeout = setTimeout(() => { server.watcher.off('change', check); reject(new Error('File update was not observed')); }, 5000);
      const check = changedFile => { if (resolve(changedFile) !== resolve(file)) return; clearTimeout(timeout); server.watcher.off('change', check); resolveChange(); };
      server.watcher.on('change', check);
    });
    await writeFile(file, text); await changed;
  }, metadata = async () => {
    const response = await fetch(url + '/api/network'); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert(Array.isArray(data.addresses)); return data.update;
  }, meta = (html, name) => html.match(new RegExp('<meta name="' + name + '" content="([a-f0-9]{16})"'))?.[1];
  try {
    await mkdir(join(fixture, 'src')); await mkdir(join(fixture, 'server'));
    await writeFile(join(fixture, 'index.html'), '<!doctype html><title>Workshop</title><link rel="stylesheet" href="/ui.css"><script type="module" src="/src/app.js"></script>');
    await writeFile(source, 'document.title = "Workshop v1";');
    await writeFile(join(fixture, 'ui.css'), 'body{color:black}');
    await writeFile(join(fixture, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/eventemitter3":{"version":"5.0.0"}}}');
    await writeFile(transport, 'export const transport = 1;');
    await start();
    const response = await fetch(url), html = await response.text(), core = meta(html, 'impacto-build');
    assert.equal(response.headers.get('cache-control'), 'no-cache'); assert.doesNotMatch(html, /@vite\/client/);
    let previous = await metadata(); assert.equal(previous.ready, true); assert.equal(previous.version, meta(html, 'impacto-page'));
    assert.match(await (await fetch(url + '/src/app.js')).text(), /Workshop v1/);
    assert.equal(server.config.server.hmr, false); assert.equal(server.config.server.ws, false);
    for (const [file, value] of [[source, 'document.title = "Workshop v2";'], [join(fixture, 'ui.css'), 'body{color:red}'],
      [join(fixture, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/eventemitter3":{"version":"5.0.1"}}}']]) {
      await change(file, value); const update = await metadata(); assert.notEqual(update.version, previous.version); assert.equal(update.ready, true); previous = update;
    }
    assert.match(await (await fetch(url + '/src/app.js?release=1')).text(), /Workshop v2/);
    assert.doesNotMatch(await (await fetch(url)).text(), /@vite\/client/);
    socket = new WebSocket(url.replace('http:', 'ws:') + '/world');
    const welcome = new Promise((resolveWelcome, reject) => {
      const timeout = setTimeout(() => reject(new Error('PvP welcome timed out')), 5000);
      socket.on('message', (raw, binary) => { if (!binary) { const message = JSON.parse(raw); if (message.type === 'welcome') { clearTimeout(timeout); resolveWelcome(message); } } });
      socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name: 'Update check', build: core }));
    assert.equal((await welcome).type, 'welcome');
    await change(transport, 'export const transport = 2;');
    const blocked = await metadata(); assert.notEqual(blocked.version, previous.version); assert.equal(blocked.ready, false);
    assert.notEqual(meta(await (await fetch(url)).text(), 'impacto-build'), core, 'disk source is not the running backend');
    socket.terminate(); await once(socket, 'close'); socket = null;
    for (let restart = 0; restart < 3; restart++) {
      await server.close(); server = null; await start();
      assert.deepEqual(await metadata(), { version: blocked.version, ready: true }, 'each completed close leaves the next server ready');
    }
  } finally {
    socket?.terminate();
    if (server) await server.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
