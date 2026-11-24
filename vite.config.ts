import { defineConfig } from 'vite';
import type { HtmlTagDescriptor, Plugin, PreviewServer, ViteDevServer } from 'vite';
import { attachNetworkServer } from './server/network-server.ts';
import { peerIPs, playerAddress, proxyTrust } from './server/network-address.ts';
import { announceField, directoryConfig } from './server/directory-announcer.ts';
import { retainedBudget, TokenBucket } from './server/request-budget.ts';
import { FIELD_STATUS_PATH } from './src/server-directory-contract.ts';
import { DEFAULT_SOURCE_URL, sourceURL } from './src/source-url.ts';
import { fieldServerConfig } from './server/field-config.ts';
import { buildStamp, coreMismatch, pageStamp, PAGE_INPUTS } from './server/build-stamp.ts';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// The address the game is reached by from outside, when it is served under a name (compose.yaml):
// the page offers that one instead of this machine's own, and the server answers to that name.
const address = process.env.IMPACTO_ADDRESS ? new URL(process.env.IMPACTO_ADDRESS) : null;
if (address && address.protocol !== 'https:') throw new Error('IMPACTO_ADDRESS deve usar HTTPS.');

// The shared field runs in this server's own process. A page reloaded is read from disk again, and
// the field runs the code it was started with: every page is told which code it was served, and
// a page of another version is refused. Applying backend changes takes an explicit server restart.
function sharedWorld(): Plugin {
  let root = process.cwd(), outDir = 'dist', dirty = true, cached: { core: string; version: string } | undefined;
  let stopField: (() => Promise<void>) | undefined;
  const current = () => {
    if (dirty || !cached) { const core = buildStamp(root); cached = { core, version: pageStamp(root, core) }; dirty = false; }
    return cached;
  };
  // Production reports the release the static HTML actually contains, not newer source files on disk.
  const published = () => {
    const html = readFileSync(resolve(root, outDir, 'index.html'), 'utf8'),
      meta = (name: string) => html.match(new RegExp('<meta name="' + name + '" content="([a-f0-9]{16})"'))?.[1];
    return { core: meta('impacto-build'), version: meta('impacto-page') };
  };
  const configure = (server: ViteDevServer | PreviewServer, preview = false) => {
    const httpServer = server.httpServer;
    if (!httpServer) throw new Error('O campo compartilhado precisa de um servidor HTTP.');
    const source = sourceURL(process.env.IMPACTO_SOURCE_URL || DEFAULT_SOURCE_URL);
    if (!source) throw new Error('IMPACTO_SOURCE_URL deve ser uma URL HTTPS de até 1024 caracteres e sem credenciais.');
    const telemetry = process.env.IMPACTO_CLIENT_TELEMETRY;
    if (telemetry !== undefined && telemetry !== '0' && telemetry !== '1')
      throw new Error('IMPACTO_CLIENT_TELEMETRY deve ser 0 ou 1.');
    // `npm run stress` serves the stress field instead of the game's (scripts/stress-field.ts), with as many of its factions as IMPACTO_STRESS says. With
    // IMPACTO_SAVE_DIR the game's field is kept in that directory and resumed from it (server/field-save.ts). With
    // IMPACTO_REHEARSAL the field is one to rehearse on (server/room.ts `rehearsal`): a vehicle is ready the moment it is
    // published and a structure the moment its works has all its material and a builder beside it, and a faction founded
    // there has stocks it does not run out of; its bases are drawn as in the game.
    const { save, testTools, commanders, commanderFill } = fieldServerConfig(process.env, preview),
      trust = proxyTrust(process.env.IMPACTO_TRUSTED_PROXIES, process.env.IMPACTO_PROXY_IP_HEADER),
      directory = directoryConfig(process.env, address, !preview),
      localHttpPeers = peerIPs(process.env.IMPACTO_LOCAL_HTTP_PEERS ?? '', 'IMPACTO_LOCAL_HTTP_PEERS'),
      rehearsal = (commanders ?? 0) > 0 ? null : process.env.IMPACTO_REHEARSAL ? { bases: [] } : null,
      room = attachNetworkServer(httpServer, { rehearsal, stress: Number(process.env.IMPACTO_STRESS) || false, stamp: () => buildStamp(root), save, perAddress: true, testTools,
        trust, localHttpPeers, clientOrigins: directory.clientOrigins, requireTLS: preview || Boolean(address),
        telemetry: telemetry === '1',
        ...(address ? { publicHost: address.host } : {}),
        ...(commanders === undefined ? {} : { commanders }), ...(commanderFill === undefined ? {} : { commanderFill }) });
    // A server told to stop keeps its field on the way out: a signal nobody answers would end it at once.
    if (save) {
      process.once('exit', () => room.flush());
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(0));
    }
    if (!preview && 'watcher' in server) server.watcher.on('all', (_event, file) => {
      file = resolve(file);
      if ([...PAGE_INPUTS, 'server', 'scripts', 'native/artifacts'].some(input => file === resolve(root, input) || file.startsWith(resolve(root, input) + sep))) dirty = true;
    });
    server.middlewares.use('/api/network', (_req, res) => {
      let update: { version: string | undefined; ready: boolean } | null = null;
      try { const page = preview ? published() : current(); update = { version: page.version, ready: Boolean(page.version && page.core === room.build && !coreMismatch(root)) }; } catch {}
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      const bound = httpServer.address(), port = bound && typeof bound === 'object' ? bound.port : 8131;
      const addresses = address ? [address.href] : process.env.IMPACTO_DISCOVER_LAN === '1' ? room.addresses(port || 8131) : [];
      res.end(JSON.stringify({ addresses, update }));
    });
    server.middlewares.use('/api/server-directory', (_req, res) => {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ directory: directory.url?.origin ?? null, official: directory.official?.href ?? null, source }));
    });
    const statusRate = new TokenBucket([80, 120]), statusClients = retainedBudget(() => new TokenBucket([2, 8]));
    const prune = setInterval(() => statusClients.prune(performance.now()), 30_000).unref();
    server.middlewares.use(FIELD_STATUS_PATH, (req, res) => {
      const origin = req.headers.origin, now = performance.now();
      res.setHeader('Vary', 'Origin');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; return res.end(); }
      if (!room.allowedTransport(req)) { res.statusCode = 403; return res.end(); }
      if (origin && directory.clientOrigins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
      if (!statusRate.take(now) || !statusClients.get(playerAddress(req, trust), now).take(now)) {
        res.setHeader('Retry-After', '1'); res.statusCode = 429; return res.end();
      }
      const status = room.status();
      if (!status) { res.statusCode = 503; return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status));
    });
    const stopAnnouncement = directory.announcement && announceField(directory.announcement, room.status);
    // HTTP close starts cleanup; Vite's awaited close hooks keep a new server from
    // loading Native while the previous worker is still terminating.
    let stopped: Promise<void> | undefined;
    stopField = () => stopped ||= (async () => { clearInterval(prune); stopAnnouncement?.(); await room.close(); })();
    httpServer.once('close', stopField);
  };
  return { name: 'impacto-shared-world', configureServer: server => configure(server), configurePreviewServer: server => configure(server, true),
    closeServer: () => stopField?.(), closePreviewServer: () => stopField?.(),
    configResolved(config) { root = config.root; outDir = config.build.outDir; },
    transformIndexHtml(): HtmlTagDescriptor[] {
      const mismatch = coreMismatch(root);
      const page = current();
      return [{ tag: 'meta', attrs: { name: 'impacto-build', content: page.core }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'impacto-page', content: page.version }, injectTo: 'head' },
        ...(mismatch ? [{ tag: 'meta', attrs: { name: 'impacto-core', content: mismatch }, injectTo: 'head' as const }] : [])];
    } };
}

function manualUpdates(): Plugin {
  return {
    name: 'impacto-manual-updates',
    apply: 'serve',
    transformIndexHtml: {
      order: 'post',
      // Vite still injects its client with HMR disabled. Without that client,
      // optimizer/server restarts cannot reload an unsaved construction either.
      handler: html => html.replace(/<script\b[^>]*\bsrc=["'][^"']*\/@vite\/client["'][^>]*>\s*<\/script>/g, ''),
    },
  };
}

export default defineConfig({
  plugins: [sharedWorld(), manualUpdates()],
  // Worktrees can share node_modules through a junction. Their optimizers must
  // not replace each other's chunks while another server still serves them.
  cacheDir: '.vite',
  // Validation snapshots are archived projects, not additional editor entries.
  optimizeDeps: { entries: ['index.html'] },
  worker: { format: 'es' },
  build: { target: 'esnext' },
  // The page owns the save/notice/reload sequence, including style updates. Vite must not bypass it.
  // The field keeps its own /world WebSocket; backend source edits still require a server restart.
  server: { host: '127.0.0.1', port: 8131, strictPort: true, hmr: false, ws: false,
    watch: { ignored: ['**/validation/**', '**/native/dynamics/target/**'] } },
  preview: { host: '0.0.0.0', port: 8131, strictPort: true, allowedHosts: address ? [address.hostname] : [],
    headers: { 'Content-Security-Policy': "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff' } },
});
