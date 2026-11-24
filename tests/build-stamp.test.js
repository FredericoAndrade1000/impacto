import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildStamp, coreMismatch, pageStamp } from '../server/build-stamp.ts';

function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'impacto-stamp-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };
  for (const [name, text] of Object.entries(files)) write(name, text);
  return { root, write };
}

test('the stamp is of the entry and of everything it loads, and of nothing else', t => {
  const { root, write } = project(t, {
    'server/physics-worker.ts': "import { a } from '../src/a.js';\nimport '../src/side.js';\nexport { b } from '../src/b.js';\nconst lazy = () => import('../src/lazy.js');\n",
    'src/a.js': "import { deep } from './deep/c.js';\nexport const a = new URL('./data.json', import.meta.url);\n",
    'src/deep/c.js': "import { gone } from './missing.js';\nexport const deep = 1;\n",
    'src/side.js': '', 'src/b.js': 'export const b = 2;\n', 'src/lazy.js': 'export default 3;\n', 'src/data.json': '{"n":1}',
    'src/page-only.js': "import './a.js';\n", 'style.css': 'body{}',
  }), stamp = () => buildStamp(root), first = stamp();
  assert.match(first, /^[0-9a-f]{16}$/); assert.equal(stamp(), first);
  // What only the page loads is no part of the server's code.
  write('src/page-only.js', "import './a.js';\n// drawn another way\n"); write('style.css', 'body{color:red}');
  assert.equal(stamp(), first);
  // A file written again with what it had says the same, whatever its date.
  write('src/b.js', 'export const b = 2;\n'); utimesSync(join(root, 'src/b.js'), new Date(), new Date(Date.now() + 5000));
  assert.equal(stamp(), first);
  for (const [name, text] of [['src/deep/c.js', 'export const deep = 22;\n'], ['src/data.json', '{"n":12}'], ['src/lazy.js', 'export default 33;\n'],
    ['src/b.js', 'export const b = 22;\n'], ['src/side.js', '// side effect\n']]) {
    const before = stamp(); write(name, text);
    assert.notEqual(stamp(), before, name + ' is part of what the server runs');
  }
  // A module that comes to name another brings it in.
  const before = stamp(); write('src/side.js', "import './page-only.js';\n");
  assert.notEqual(stamp(), before);
  const within = stamp(); write('src/page-only.js', "import './a.js';\n// and now the server loads it too\n");
  assert.notEqual(stamp(), within);
});

test('a fresh stamp detects source changes even when file size and modification time were preserved', t => {
  const { root, write } = project(t, { 'server/physics-worker.ts': 'export const one = 1;\n' }),
    stamp = () => buildStamp(root), date = new Date('2020-01-01');
  utimesSync(join(root, 'server/physics-worker.ts'), date, date);
  const first = stamp();
  write('server/physics-worker.ts', 'export const one = 2;\n');
  utimesSync(join(root, 'server/physics-worker.ts'), date, date);
  assert.notEqual(stamp(), first);
});

test('the default stamp includes the transport, worker, host resolution and built core record, without page-only files', t => {
  const native = `native/artifacts/battle_dynamics-${process.platform}-${process.arch}.json`, files = {
    'server/physics-worker.ts': "import './room.ts';\n", 'server/room.ts': "import '../src/network-protocol.ts';\n",
    'src/network-protocol.ts': 'export const version = 1;\n',
    'scripts/native-dynamics-host.ts': "import './rust-source-hash.ts';\n", 'scripts/rust-source-hash.ts': 'export const source = 1;\n',
    [native]: '{"sourceSHA256":"aaa"}', 'package.json': '{"imports":{"#dynamics-host":{"node":"./scripts/native-dynamics-host.ts"}}}',
    'src/render.ts': '', 'src/main.ts': '', 'server/network-server.ts': '',
  }, { root, write } = project(t, files), first = buildStamp(root);
  for (const name of ['src/render.ts', 'src/main.ts']) write(name, '// changed\n');
  assert.equal(buildStamp(root), first);
  for (const name of ['server/physics-worker.ts', 'server/room.ts', 'src/network-protocol.ts', 'scripts/native-dynamics-host.ts', 'scripts/rust-source-hash.ts', native, 'package.json', 'server/network-server.ts']) {
    const before = buildStamp(root); write(name, files[name] + '\n');
    assert.notEqual(buildStamp(root), before, name + ' is part of the server');
  }
});

test('page edits change the release without changing the field, while identical bytes and validation output do not', t => {
  const { root, write } = project(t, { 'server/physics-worker.ts': 'export const field = 1;',
    'src/main.ts': 'export const page = 1;', 'ui.css': 'body{}',
    'package-lock.json': '{"lockfileVersion":3,"packages":{"node_modules/eventemitter3":{"version":"5.0.0"}}}' }), core = buildStamp(root);
  let version = pageStamp(root);
  write('validation/result.json', '{"attempt":2}'); assert.equal(pageStamp(root), version);
  for (const [file, value] of [['src/main.ts', 'export const page = 2;'], ['ui.css', 'body{color:red}'],
    ['package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/eventemitter3":{"version":"5.0.1"}}}']]) {
    write(file, value); const next = pageStamp(root);
    assert.notEqual(next, version); assert.equal(buildStamp(root), core);
    write(file, value); assert.equal(pageStamp(root), next); version = next;
  }
});

test('cores built from different sources are told apart, and a missing record says nothing', t => {
  const native = `native/artifacts/battle_dynamics-${process.platform}-${process.arch}.json`,
    { root, write } = project(t, { [native]: '{"sourceSHA256":"aaa"}' });
  assert.equal(coreMismatch(root), null, 'a page core with no record is not judged');
  write('src/native/battle_dynamics.json', '{"sourceSHA256":"aaa"}'); assert.equal(coreMismatch(root), null);
  write('src/native/battle_dynamics.json', '{"sourceSHA256":"bbb"}'); assert.match(coreMismatch(root), /fontes diferentes/);
});

test('the field stamp follows erased TypeScript runtime imports, lazy modules and worker assets', t => {
  const { root, write } = project(t, {
    'server/physics-worker.ts': "import '../src/field.ts';",
    'src/field.ts': "import type { State } from './state.ts'; export type { View } from './view.d.ts'; import { type Live } from './live.mts'; const load = () => import('./lazy.ts'); const worker = new URL('./worker.cts', import.meta.url); type LazyState = typeof import('./state.ts');",
    'src/state.ts': 'export type State = { tick: number };',
    'src/view.d.ts': 'export interface View { tick: number }',
    'src/live.mts': 'export type Live = number;',
    'src/lazy.ts': 'export const n: number = 1;',
    'src/worker.cts': "const settings: unknown = require('./settings.json'); module.exports = settings;",
    'src/settings.json': '{"rate":1}',
  }), first = buildStamp(root);
  write('src/state.ts', 'export type State = { time: number };');
  write('src/view.d.ts', 'export interface View { time: number }');
  assert.equal(buildStamp(root), first, 'erased dependencies change no executable field');
  for (const [file, source] of [['src/live.mts', 'export const live: number = 2;'], ['src/lazy.ts', 'export const n: number = 2;'],
    ['src/worker.cts', "module.exports = require('./settings.json');"], ['src/settings.json', '{"rate":2}']]) {
    const before = buildStamp(root); write(file, source);
    assert.notEqual(buildStamp(root), before, file);
  }
});

test('TypeScript page sources affect the release while declarations do not, and invalid runtime TypeScript is reported', t => {
  const { root, write } = project(t, { 'src/page.ts': 'export const x: number = 1;', 'src/types.d.ts': 'export type X = number;' }),
    first = pageStamp(root);
  write('src/types.d.ts', 'export type X = string;'); assert.equal(pageStamp(root), first);
  write('src/page.ts', 'export const x: number = 2;'); assert.notEqual(pageStamp(root), first);
  write('server/physics-worker.ts', "import '../src/page.ts';");
  write('src/page.ts', 'export enum NonErasable { Value }');
  assert.throws(() => buildStamp(root), { code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' });
});
