// Inventory the working tree through Git, including new source files and respecting .gitignore.
// Generated bindings, lockfiles and assets are reported apart from code people maintain.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDependencies } from './module-dependencies.ts';
import { scriptFile } from './source-modules.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AREAS: [string, string][] = [
  ['javascript', 'JavaScript/TypeScript do cliente e compartilhado'], ['rust', 'Núcleo Rust, incluindo testes embutidos'],
  ['server', 'Servidor'], ['interface', 'HTML e CSS'], ['tools', 'Ferramentas'],
  ['tests', 'Testes JavaScript/TypeScript'], ['rust-tests', 'Testes Rust em arquivos próprios'], ['docs', 'Documentação'], ['config', 'Configuração'],
  ['data', 'Dados e fixtures'], ['studies', 'Estudos e evidências de arte/áudio'],
  ['generated', 'Bindings e lockfiles gerados'], ['assets', 'Assets'],
];
const CODE = new Set(['javascript', 'rust', 'server', 'interface', 'tools']);
const TEXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.py', '.rs', '.html', '.css', '.md', '.json', '.toml', '.yaml', '.yml', '.txt', '.svg']);

type CountedFile = { file: string; area: string; bytes: number; lines: number; nonblank: number };

function area(file: string): string {
  const extension = extname(file);
  if (file.startsWith('src/native/') || file === 'native/construction-catalogue.json' || /(^|\/)(package-lock\.json|Cargo\.lock)$/.test(file)) return 'generated';
  if (file.startsWith('art/references/')) return 'studies';
  if (file.startsWith('tests/')) return scriptFile(file) ? 'tests' : 'data';
  if (/^native\/dynamics\/(?:tests\/.*\.rs|src\/(?:.*\/)?[^/]*_tests\.rs)$/.test(file)) return 'rust-tests';
  if (file.startsWith('native/dynamics/tests/') || file.startsWith('diagnostics/')) return 'data';
  if (file.endsWith('.md')) return 'docs';
  if (/^(public|music|sounds)\//.test(file) || ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.wav'].includes(extension)) return 'assets';
  if (file.startsWith('src/') && scriptFile(file)) return 'javascript';
  if (file.startsWith('native/dynamics/') && extension === '.rs') return 'rust';
  if (file.startsWith('server/') && scriptFile(file)) return 'server';
  if (file.startsWith('scripts/') && (scriptFile(file) || extension === '.py')) return 'tools';
  if (extension === '.css' || extension === '.html') return 'interface';
  if (TEXT.has(extension) || /(^|\/)(Dockerfile|\.\w[\w.-]*)$/.test(file)) return 'config';
  return 'assets';
}

export function codebaseSize(root = ROOT) {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  if (listed.error || listed.status !== 0) throw new Error('Execute o inventário em um repositório Git.');
  const files: CountedFile[] = [];
  for (const file of [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()) {
    const path = join(root, file);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const kind = area(file), counted = kind !== 'assets' && (TEXT.has(extname(file)) || extname(file) === '.lock' || kind === 'config');
    let lines = 0, nonblank = 0;
    if (counted && stat.size) {
      const text = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n'), rows = text.split('\n');
      if (text.endsWith('\n')) rows.pop();
      lines = rows.length; nonblank = rows.filter(row => row.trim()).length;
    }
    files.push({ file, area: kind, bytes: stat.size, lines, nonblank });
  }
  const sum = (list: readonly CountedFile[]) => list.reduce((total, file) => ({ files: total.files + 1, bytes: total.bytes + file.bytes,
    lines: total.lines + file.lines, nonblank: total.nonblank + file.nonblank }), { files: 0, bytes: 0, lines: 0, nonblank: 0 });
  const { imports, cycles } = moduleDependencies(root, files.filter(file => CODE.has(file.area)).map(file => file.file)),
    sourceCoupledTests = files.filter(file => file.area === 'tests' && /new Script\(|createContext\(/.test(readFileSync(join(root, file.file), 'utf8'))).length;
  return { version: 1, source: 'Git working tree, including untracked files; ignored untracked files and symlinks excluded.',
    counting: 'Physical lines, including comments, without a phantom line after a final newline. Dedicated test files are separate; the Rust core still includes inline tests. Studies include textual reports and data, separate from game code.',
    maintainedCode: sum(files.filter(file => CODE.has(file.area))),
    dependencies: { modules: Object.keys(imports).length, links: Object.values(imports).reduce((total, refs) => total + refs.length, 0), cycles },
    sourceCoupledTests,
    areas: AREAS.map(([id, label]) => ({ id, label, ...sum(files.filter(file => file.area === id)) })),
    largest: files.filter(file => CODE.has(file.area)).sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file)).slice(0, 15) };
}

function print(report: ReturnType<typeof codebaseSize>): void {
  console.log('Impacto — tamanho da base de código\n');
  console.log('Área'.padEnd(42) + 'Arquivos'.padStart(9) + 'Linhas'.padStart(11) + 'Não vazias'.padStart(12) + 'KiB'.padStart(12));
  for (const entry of report.areas) console.log(entry.label.padEnd(42) + String(entry.files).padStart(9) +
    String(entry.lines).padStart(11) + String(entry.nonblank).padStart(12) + (entry.bytes / 1024).toFixed(1).padStart(12));
  console.log(`\nCódigo do jogo e ferramentas: ${report.maintainedCode.files} arquivos, ${report.maintainedCode.lines} linhas (sem estudos, arquivos exclusivos de testes, configuração, documentação, dados, gerados e assets).`);
  console.log('Linhas físicas incluem comentários; testes embutidos no Rust permanecem na área Rust. Dependências e arquivos ignorados ficam fora.');
  console.log('Estudos incluem relatórios e dados textuais e não entram no total de código do jogo e ferramentas.');
  console.log(`Imports relativos executáveis: ${report.dependencies.modules} módulos, ${report.dependencies.links} referências, ${report.dependencies.cycles.length} grupos circulares.`);
  console.log(`Arquivos de teste com execução em VM: ${report.sourceCoupledTests} (inclui helpers; não é uma contagem de todos os testes frágeis).`);
  console.log('\nMaiores arquivos de código:');
  for (const entry of report.largest) console.log(String(entry.lines).padStart(6) + '  ' + entry.file);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('npm run size [-- --json]\nMede a árvore de trabalho sem dependências, respeitando .gitignore. --json produz um relatório para comparação.');
  else if (args.some(arg => arg !== '--json')) { console.error('Opção desconhecida. Use --help.'); process.exitCode = 1; }
  else try { const report = codebaseSize(); if (args.includes('--json')) console.log(JSON.stringify(report, null, 2)); else print(report); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
