// Standalone, loopback-only observer. Do not import the normal Vite config:
// that config starts a live field, while this tool only reads frozen diaries.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2), roots: string[] = [];
let port = 8440, cache = 'validation/replay-viewer/cache';
for (let i = 0; i < args.length; i++) {
  const value = args[i]!;
  if (value === '--port') port = Number(args[++i]);
  else if (value === '--cache') { const next = args[++i]; if (!next) throw new Error('--cache requires a directory.'); cache = next; }
  else if (value.startsWith('--')) throw new Error(`Unknown argument: ${value}`);
  else roots.push(resolve(value));
}
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
if (!roots.length) throw new Error('Usage: npm run replay:viewer -- <diary file or field folder> [more folders] [--port 8440]');
process.env.IMPACTO_DYNAMICS_RUNTIME = 'native';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const { initNativeDynamics } = await import('../src/native-dynamics.ts');
await initNativeDynamics();
const { ReplayViewer } = await import('../server/replay-viewer.ts'), origin = `http://127.0.0.1:${port}`,
  viewer = new ReplayViewer(roots, resolve(cache), origin);
const server = await createServer({
  configFile: false, root, clearScreen: false, appType: 'mpa',
  cacheDir: resolve(root, 'node_modules/.vite-replay', String(port)),
  optimizeDeps: { entries: ['replay.html'] },
  server: { host: '127.0.0.1', port, strictPort: true, open: false,
    watch: { ignored: ['**/validation/**', '**/art/references/**', '**/native/target/**'] },
    fs: { deny: ['**/.env*', '**/validation/**', '**/field.json', '**/*.ndjson', '**/*.ndjson.gz', '**/server/**', '**/native/artifacts/**'] } },
  plugins: [{ name: 'read-only-replay', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url?.startsWith('/api/')) { void viewer.request(request, response); return; }
      if (request.url?.split('?')[0] === '/index.html') { response.writeHead(404); response.end(); return; }
      if (request.url === '/' || request.url?.startsWith('/?')) request.url = '/replay.html' + request.url.slice(1);
      next();
    });
  } }],
});
await server.listen();
console.log(`Replay viewer: ${origin}/`);
console.log(`Read-only sources: ${roots.join(', ')}`);
let closing = false;
async function close() { if (closing) return; closing = true; await viewer.close(); await server.close(); }
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
