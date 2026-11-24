import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function javascript(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = join(folder, entry.name);
    if (file === join(root, 'src', 'native')) return []; // Generated Wasm bindings.
    return entry.isDirectory() ? javascript(file) : /\.[cm]?js$/.test(entry.name) ? [relative(root, file).replaceAll('\\', '/')] : [];
  });
}
const remaining = ['src', 'server', 'scripts'].flatMap(folder => javascript(join(root, folder)));
if (remaining.length) {
  console.error('Use TypeScript for game, server and tool sources:\n' + remaining.join('\n'));
  process.exitCode = 1;
}
