import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { moduleDependencies } from '../scripts/module-dependencies.ts';

test('client, server and tool modules have no circular relative imports', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = ['src', 'server', 'scripts'].flatMap(folder => readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/')));
  const { cycles } = moduleDependencies(root, files);
  assert.deepEqual(cycles, [], 'shared data must not depend on the compiler, host or painter that consumes it');
});

test('the structural check detects re-export, dynamic-import and self-reference cycles', t => {
  const root = mkdtempSync(join(tmpdir(), 'impacto-module-'));
  t.after(() => { assert(root.startsWith(join(tmpdir(), 'impacto-module-'))); rmSync(root, { recursive: true, force: true }); });
  const sources = {
    'a.js': "import { b } from './b.js'; export const a = 1;",
    'b.js': "export { a } from './a.js'; export const b = 2;",
    'c.js': "export const run = () => import('./d.js');",
    'd.js': "import './c.js';",
    'e.js': "import './e.js';",
    'leaf.js': "export const image = new URL('./image.png', import.meta.url);",
  };
  for (const [file, source] of Object.entries(sources)) writeFileSync(join(root, file), source);
  const report = moduleDependencies(root, Object.keys(sources));
  assert.deepEqual(report.cycles, [['a.js', 'b.js'], ['c.js', 'd.js'], ['e.js']]);
  assert.deepEqual(report.imports['leaf.js'], [], 'asset URLs are not module imports or evidence of dead files');
});

test('the graph follows TypeScript runtime imports and CommonJS, keeping type-only cycles outside execution', t => {
  const root = mkdtempSync(join(tmpdir(), 'impacto-module-'));
  t.after(() => { assert(root.startsWith(join(tmpdir(), 'impacto-module-'))); rmSync(root, { recursive: true, force: true }); });
  const sources = {
    'a.ts': "import type { A } from './types.ts'; import { type B } from './b.mts'; export type { C } from './contract.d.ts'; type Lazy = typeof import('./types.ts');",
    'b.mts': "export { a } from './a.ts'; export const b: number = 1;",
    'types.ts': "import type { B } from './b.mts'; export type A = string;",
    'contract.d.ts': "import { a } from './a.ts'; export type C = typeof a;",
    'c.cts': "const other: unknown = require('./d.cts'); module.exports = other;",
    'd.cts': "module.exports = require('./c.cts');",
  };
  for (const [file, source] of Object.entries(sources)) writeFileSync(join(root, file), source);
  const report = moduleDependencies(root, Object.keys(sources));
  assert.deepEqual(report.cycles, [['a.ts', 'b.mts'], ['c.cts', 'd.cts']]);
  assert.deepEqual(report.imports['a.ts'], ['b.mts'], 'an inline type specifier retains an empty executable import');
  assert.deepEqual(report.imports['types.ts'], [], 'import type and import() in a type are erased');
  assert(!Object.hasOwn(report.imports, 'contract.d.ts'), 'declarations are not runtime modules');
});
