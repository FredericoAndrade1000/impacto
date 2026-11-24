// What the server of the field is made of, as it stands on disk: the worker of the field and
// everything it loads, found by reading each file for the files it names. Two readings give the
// same stamp while none of those files changed in what it says. A page is given the stamp of the
// moment it was served, and the server keeps its startup stamp to refuse a different page (network-server.ts).
// What only the page loads — the drawing, the styles — is no part of it: the field need not
// start again for a change the field never runs.
import { createHash } from 'node:crypto';
import type { BinaryLike } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { moduleReferences, runtimeModule } from '../scripts/source-modules.ts';

// The field worker, the Node host selected by the package's import map, and its
// core record. The import map is part of the running code too.
const ENTRIES: [string, string, string, string, string] = ['server/physics-worker.ts', 'scripts/native-dynamics-host.ts',
  `native/artifacts/battle_dynamics-${process.platform}-${process.arch}.json`, 'package.json', 'server/network-server.ts'];
const sha256 = (bytes: BinaryLike): string => createHash('sha256').update(bytes).digest('hex');

// The stamp of the game in `root` now. Read once at server startup, when serving a page and before recovering a crash.
export function buildStamp(root: string): string {
  const seen = new Map<string, string | null>(), queue = ENTRIES.map(entry => join(root, entry));
  while (queue.length) {
    const file = queue.pop();
    if (file === undefined) break;
    if (seen.has(file)) continue;
    seen.set(file, null);
    let bytes;
    try { bytes = readFileSync(file); }
    catch { continue; /* A missing optional module or core record contributes nothing. */ }
    seen.set(file, sha256(bytes));
    if (runtimeModule(file)) for (const ref of moduleReferences(file, bytes.toString('utf8'), { urls: true }))
      queue.push(resolve(dirname(file), ref));
  }
  const hash = createHash('sha256');
  for (const [file, digest] of [...seen].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (digest)
    hash.update(relative(root, file).split(sep).join('/') + '\0' + digest + '\0');
  return hash.digest('hex').slice(0, 16);
}

// Page source and asset roots. Reference studies, saves and validation runs are not releases.
export const PAGE_INPUTS = ['index.html', 'ui.css', 'favicon.svg', 'src', 'music', 'sounds', 'public', 'package.json', 'package-lock.json', 'vite.config.ts'];
export function pageStamp(root: string, core = buildStamp(root)): string {
  const files: string[] = [], visit = (file: string): void => {
    let stat;
    try { stat = statSync(file); } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(file, { withFileTypes: true }))
        if (entry.isFile() || entry.isDirectory()) visit(join(file, entry.name));
    } else if (runtimeModule(file) || /\.(?:html|css|json|wasm|webp|png|jpe?g|svg|mp3|ogg|wav|woff2?)$/i.test(file)) files.push(file);
  };
  for (const input of PAGE_INPUTS) visit(join(root, input));
  const hash = createHash('sha256').update(core + '\0');
  for (const file of files.sort()) hash.update(relative(root, file).split(sep).join('/') + '\0' + sha256(readFileSync(file)) + '\0');
  return hash.digest('hex').slice(0, 16);
}

// The core runs twice: built for the page and built for the server. Each build records the source it
// was made from; one made from another source than the other is said here, and nothing when both agree
// or when a record is missing.
export function coreMismatch(root: string): string | null {
  const source = (file: string): string | null => {
    try {
      const metadata: unknown = JSON.parse(readFileSync(join(root, file), 'utf8'));
      return metadata && typeof metadata === 'object' && 'sourceSHA256' in metadata && typeof metadata.sourceSHA256 === 'string' && metadata.sourceSHA256
        ? metadata.sourceSHA256 : null;
    } catch { return null; }
  },
    page = source('src/native/battle_dynamics.json'), server = source(ENTRIES[2]);
  return page && server && page !== server ? 'O núcleo da página e o do servidor foram compilados de fontes diferentes. Rode npm run build:native e npm run build:wasm.' : null;
}
