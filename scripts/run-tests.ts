// The suite (`npm test`): node --test over every test file, the longest first by the times of the
// last run (test-times-reporter.ts), so the few long files start at once instead of holding up the end.
// Files not timed yet go first. Arguments go on to node --test; naming test files runs those, in that order.
// Keep test artifacts in the worktree when node_modules is shared.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), modules = join(root, 'node_modules'),
  cache = lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink() ? join(root, 'validation', '.test-cache') : join(modules, '.cache'),
  times = join(cache, 'impacto-test-times.json'), record = join(cache, `impacto-test-times-${process.pid}.json`),
  TEST = /\.test\.(?:js|mjs|cjs|ts|mts|cts)$/, args = process.argv.slice(2);
const read = (file: string): Record<string, number> => {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, ms]) => typeof ms === 'number')) : {};
  } catch { return {}; }
};
const last = read(times), files = args.some(arg => TEST.test(arg)) ? [] : readdirSync(join(root, 'tests')).filter(name => TEST.test(name))
  .map(name => `tests/${name}`).sort((a, b) => (last[b] ?? Infinity) - (last[a] ?? Infinity) || a.localeCompare(b));
mkdirSync(cache, { recursive: true });
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=4',
  `--test-reporter=${process.stdout.isTTY ? 'spec' : 'tap'}`, '--test-reporter-destination=stdout',
  `--test-reporter=${pathToFileURL(join(root, 'scripts', 'test-times-reporter.ts')).href}`, `--test-reporter-destination=${record}`,
  ...args, ...files], { cwd: root, stdio: 'inherit',
  // Each test file is a process of its own that loads hundreds of modules: kept compiled, its TypeScript is not
  // stripped again by every one of them (about half of what starting one costs).
  env: { ...process.env, NODE_COMPILE_CACHE: join(cache, 'impacto-compile-cache') } });
// A run cut short tells nothing whole: only what it finished is written over the times kept.
const measured = read(record);
rmSync(record, { force: true });
if (Object.keys(measured).length) writeFileSync(times, JSON.stringify({ ...last, ...measured }, null, 1));
process.exitCode = run.status ?? 1;
