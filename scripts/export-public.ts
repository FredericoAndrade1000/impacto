import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleReferences, runtimeModule } from './source-modules.ts';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const maxFileBytes = 20_000_000;

// Inclusion rules apply to the working tree, so they also cover an export before commit.
const files = [
  '.dockerignore', '.env.example', '.gitignore', '.gitattributes',
  'README.md', 'LICENSE', 'LICENSE-ASSETS.md', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'Dockerfile', 'Dockerfile.directory', 'compose.yaml', 'compose.directory.yaml',
  'package.json', 'package-lock.json', 'tsconfig.base.json', 'tsconfig.json', 'tsconfig.runtime.json', 'vite.config.ts',
  'index.html', 'ui.css', 'favicon.svg', 'replay.html', 'replay.css',
  'docs/automatic-services.md', 'docs/balanceamento.md', 'docs/client-context.md', 'docs/faction-commander.md',
  'docs/field-base49-conversion.md', 'docs/field-recovery.md', 'docs/game-design.md', 'docs/glossario-es.md',
  'docs/industrial-progression.md', 'docs/localization.md', 'docs/maintenance-map.md', 'docs/mobile-performance.md',
  'docs/player-bridge.md', 'docs/project-design8-conversion.md', 'docs/replay-viewer.md', 'docs/servidores.md',
  'docs/test-tools.md', 'docs/typescript.md',
  'benchmarks/a15.json', // Shared profile definition, without measured runs.
  'native/construction-catalogue.json', 'native/dynamics/Cargo.toml', 'native/dynamics/Cargo.lock', 'native/dynamics/build.rs',
  'src/tsconfig.json', 'src/native/battle_dynamics.js', 'src/native/battle_dynamics.json', 'src/native/battle_dynamics_bg.wasm',
  'src/assets/fire-flame.LICENSE.txt', 'src/assets/fire-flame.png',
  'src/assets/base-canvas-grain.webp', 'src/assets/base-concrete-grain.webp', 'src/assets/base-earth-grain.webp',
  'src/assets/base-paint-grain.webp', 'src/assets/base-rubber-grain.webp', 'src/assets/boulder-grain.webp',
  'src/assets/clouds-natural-v6.webp', 'src/assets/concrete-grain.webp', 'src/assets/flora-natural-v2.webp',
  'src/assets/frame-grain.webp', 'src/assets/hull-inside-grain.webp', 'src/assets/hull-outside-grain.webp',
  'src/assets/radar-grain.webp', 'src/assets/scenery-ranges-v4.webp', 'src/assets/terrain-rock-detail.webp',
  'src/assets/terrain-soil-detail.webp', 'src/assets/track-rubber-grain.webp', 'src/assets/track-steel-grain.webp',
  'src/assets/wear-earth.webp', 'src/assets/wear-oil.webp', 'src/assets/wear-oxide.webp', 'src/assets/wear-scuffs.webp',
  'src/assets/wheel-grain.webp',
  'public/flags/HISTORIC.txt', 'public/flags/LICENSE', 'sounds/origem.tsv',
  'tests/armor-grid-contract.js', 'tests/concrete-penetration-fixtures.js', 'tests/damage-fixtures.js',
  'tests/mechanical-queries.js', 'tests/scenery-canvas.js', 'tests/solver-rounding.js',
  'tests/fixtures/atmosphere-parity.json', 'tests/fixtures/contact-mixed-route.json', 'tests/fixtures/editor-chassis.json',
  'tests/fixtures/landscape-parity.json', 'tests/fixtures/rooms.js', 'tests/fixtures/terrain-protected-sites.json',
  'scripts/mobile-benchmark.html',
];
const privateTools = new Set(['keep-wsl.ts', 'tunnel-token.ts', 'sound-feedback.ts', 'sound-study-site.ts']);
const studyTests = new Set(['cannon-study.test.js', 'sound-study-recommendations.test.js', 'vehicle-sfx-study.test.js']);
const match = (pattern: RegExp) => (name: string) => pattern.test(name);

function select(folder: string, wanted: (name: string) => boolean, nested = false): string[] {
  const path = join(root, folder);
  if (!lstatSync(path).isDirectory() || relative(root, realpathSync(path)).replaceAll('\\', '/') !== folder)
    throw new Error(`Diretório de inclusão inválido: ${folder}`);
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const name = `${folder}/${entry.name}`;
    if (entry.isDirectory() && nested) return select(name, wanted, true);
    return wanted(entry.name) ? [name] : [];
  });
}

const sensitivePath = /(?:^|\/)(?:\.git(?:\/|$)|\.claude(?:\/|$)|\.codex[^/]*|node_modules(?:\/|$)|\.env[^/]*|antes-[^/]*|diagnostics(?:\/|$)|data(?:\/|$)|directory-data(?:\/|$)|validation(?:\/|$)|output(?:\/|$)|screenshots(?:\/|$)|replays(?:\/|$)|field(?:\.json[^/]*|[.-][^/]*\.json)|mirrored-field\.json|[^/]+\.(?:jsonl|dump|dmp)$)/i;
const contentRules: [string, RegExp][] = [
  ['caminho de máquina', /(?:\b[A-Z]:[\\/]{1,2}[a-z0-9_.-]+|\/(?:mnt\/[a-z]|home|Users)\/[\w.-]+|file:\/\/[A-Za-z/])/i],
  ['e-mail', /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi],
  ['chave privada', /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ['token conhecido', /\b(?:gh[pousr]_[\w]{30,}|github_pat_[\w]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]{18,}|sk_(?:live|test)_[\w]{16,}|AIza[\w-]{35}|eyJ[\w-]{12,}\.eyJ[\w-]{12,}\.[\w-]{12,})\b/],
  ['credencial em URL', /https?:\/\/[^/\s:@"'<>]+:[^/\s@"'<>]+@(?:[\w-]+\.)+[\w-]+/i],
  ['segredo atribuído', /\b(?:client[_-]?secret|api[_-]?key|secret[_-]?key|access[_-]?token|TUNNEL_TOKEN|IMPACTO_DIRECTORY_KEY|password)\s*["']?\s*[:=]\s*["']?[\w/+.-]{24,}(?:["'\s;]|$)/i],
];

function inspect(base: string, names: readonly string[]) {
  const issues: string[] = [];
  const included = new Set(names);
  for (const name of names)
    for (let folder = dirname(name); folder !== '.'; folder = dirname(folder)) included.add(folder.replaceAll('\\', '/'));
  const sizes = names.map(name => {
    if (name !== '.env.example' && sensitivePath.test(name)) throw new Error(`Caminho proibido: ${name}`);
    const file = join(base, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || relative(base, realpathSync(file)).replaceAll('\\', '/') !== name)
      throw new Error(`Entrada inválida: ${name}`);
    if (stat.size > maxFileBytes) throw new Error(`Arquivo acima de 20 MB: ${name}`);
    const bytes = readFileSync(file);
    // MPEG frames are compressed binary. Inspect the ID3 header and trailer for text.
    const tag = bytes.subarray(0, 3).toString() === 'ID3' && bytes.length >= 10
      ? bytes.subarray(10, 10 + bytes.subarray(6, 10).reduce((size, byte) => size * 128 + (byte & 127), 0)) : Buffer.alloc(0);
    const trailer = bytes.subarray(-128, -125).toString() === 'TAG' ? bytes.subarray(-125) : Buffer.alloc(0);
    const payload = name.endsWith('.mp3') ? Buffer.concat([tag, trailer]) : bytes;
    const text = name + '\n' + payload.toString('utf8');
    for (const [label, pattern] of contentRules) {
      const matches = pattern.global ? Array.from(text.matchAll(pattern), match => match[0]) : (pattern.test(text) ? [''] : []);
      if (matches.some(value => label !== 'e-mail' || !/^(?:\d+\+)?[^@]*@(?:users\.)?noreply\.[\w.-]+$/i.test(value)))
        issues.push(`${name}: ${label}`);
    }
    const refs = runtimeModule(name) ? moduleReferences(name, bytes.toString('utf8'), { urls: true }) :
      name.endsWith('.html') ? Array.from(text.matchAll(/\b(?:href|src)="(\/(?!\/)[^"]+)"/g), match => match[1]!) : [];
    for (const ref of refs) {
      const target = ref.startsWith('/') ? resolve(base, `.${ref}`) : resolve(dirname(file), ref);
      const expected = relative(base, target).replaceAll('\\', '/');
      if (expected && !expected.startsWith('../') && !isAbsolute(expected) && !included.has(expected) && existsSync(target))
        issues.push(`${name}: referência local excluída (${expected})`);
    }
    return { name, size: stat.size };
  });
  if (issues.length) throw new Error('Verificação falhou:\n' + issues.join('\n'));
  return sizes;
}

const args = process.argv.slice(2);
const [action, directory] = args.length === 1 ? ['export', args[0]] : args;
if (!directory || (action !== 'export' && action !== '--check') || args.length > 2)
  throw new Error('Uso: npm run export:public -- <pasta vazia> | --check <cópia pública>');
const requested = resolve(directory);

function exportedFiles(base: string, folder = ''): string[] {
  return readdirSync(join(base, folder), { withFileTypes: true }).flatMap(entry => {
    const name = folder ? `${folder}/${entry.name}` : entry.name;
    if (name !== '.env.example' && sensitivePath.test(name)) throw new Error(`Caminho proibido: ${name}`);
    return entry.isDirectory() ? exportedFiles(base, name) : [name];
  });
}

if (action === 'export') {
  const parent = realpathSync(dirname(requested));
  const outside = relative(root, parent);
  if (!outside || (!isAbsolute(outside) && !/^\.\.(?:[\\/]|$)/.test(outside))) throw new Error('Use um destino fora da árvore de origem.');
  const names = [...files,
    ...select('src', match(/\.(?:ts|css)$/)), ...select('src/locales', match(/\.ts$/)), ...select('server', match(/\.ts$/)),
    ...select('scripts', name => /\.ts$/.test(name) && !privateTools.has(name)), ...select('scripts/player', match(/\.ts$/)),
    ...select('scripts/commander-learning', match(/\.(?:ts|json|py)$/)),
    ...select('tests', name => /\.test\.[jt]s$/.test(name) && !studyTests.has(name)), ...select('tests/helpers', match(/\.[jt]s$/)),
    ...select('native/dynamics/src', match(/\.rs$/), true), ...select('native/dynamics/tests', match(/\.rs$/), true),
    ...select('public/flags', match(/^[a-z0-9-]+\.svg$/)), ...select('sounds', match(/^[a-z-]+\.mp3$/)),
    ...select('music', match(/^(?:calm-[1-4]|construction-[1-4]|tense-[1-7])\.mp3$/)),
  ].sort();
  inspect(root, names);
  if (!lstatSync(requested, { throwIfNoEntry: false })) mkdirSync(requested);
  if (!lstatSync(requested).isDirectory() || readdirSync(requested).length) throw new Error('O destino deve ser um diretório vazio e sem junção.');
  for (const name of names) {
    const file = join(requested, name);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(root, name), file);
  }
}
const destination = realpathSync(requested);
const sizes = inspect(destination, exportedFiles(destination).sort());
console.log(`${sizes.length} arquivos, ${sizes.reduce((sum, file) => sum + file.size, 0)} bytes no total.`);
for (const { name, size } of sizes.sort((a, b) => b.size - a.size).slice(0, 10)) console.log(`${size} bytes  ${name}`);
