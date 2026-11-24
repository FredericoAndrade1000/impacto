import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codebaseSize } from '../scripts/codebase-size.ts';

test('the inventory separates maintained code, tests, generated files and ignored dependencies', t => {
  const root = mkdtempSync(join(tmpdir(), 'impacto-codebase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const put = (file, text) => { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  put('.gitignore', 'node_modules/\nvalidation/\n');
  put('src/view.js', '// comentário\r\n\r\nexport const view = 1;\r\n');
  put('server/room.ts', 'export const room = 1;');
  put('scripts/report.py', '# ferramenta\nprint(1)\n');
  put('scripts/count.cjs', 'module.exports = 1;\n');
  put('native/dynamics/src/lib.rs', 'pub const STEP: u32 = 60;\n');
  put('native/dynamics/src/solver_tests.rs', '#[test] fn solver() {}\n');
  put('native/dynamics/tests/protocol.rs', '#[test] fn protocol() {}\n');
  put('native/dynamics/tests/fixtures/cost.json', '{}\n');
  put('native/construction-catalogue.json', '{}\n');
  put('tests/view.test.js', 'test();\n');
  put('tests/check.cjs', 'test();\n');
  put('tests/fixtures/world.json', '{}\n');
  put('src/native/core.js', '// generated\n');
  put('src/native/core.wasm', new Uint8Array([0, 97, 115, 109]));
  put('package-lock.json', '{}\n');
  put('README.md', '# Projeto\n');
  put('sounds/fire.mp3', new Uint8Array([0, 255, 10]));
  put('public/flags/br.svg', '<svg></svg>\n');
  put('diagnostics/report.html', '<p>diagnóstico</p>\n');
  put('diagnostics/trace.js', 'export const trace = 1;\n');
  for (const [extension, text] of Object.entries({
    html: '<p>estudo</p>\n', css: 'p { color: red; }\n', js: 'export const study = 1;\n',
    mjs: 'export const study = 1;\n', cjs: 'module.exports = 1;\n', py: 'print(1)\n',
    json: '{}\n', md: '# Estudo\n', png: new Uint8Array([0, 255, 10]),
  })) put('art/references/study/sample.' + extension, text);
  put('node_modules/vendor.js', 'not counted\n');
  put('validation/report.js', 'not counted\n');
  const report = codebaseSize(root), group = id => report.areas.find(area => area.id === id);
  assert.deepEqual(report.maintainedCode, { files: 5, bytes: Buffer.byteLength('// comentário\r\n\r\nexport const view = 1;\r\nexport const room = 1;pub const STEP: u32 = 60;\n# ferramenta\nprint(1)\nmodule.exports = 1;\n'), lines: 8, nonblank: 7 });
  assert.equal(group('tools').files, 2); assert.equal(group('tools').lines, 3);
  assert.equal(group('tests').lines, 2); assert.equal(group('data').files, 4);
  assert.equal(group('rust-tests').files, 2); assert.equal(group('rust-tests').lines, 2);
  assert.equal(group('generated').files, 4); assert.equal(group('generated').lines, 3);
  assert.equal(group('docs').lines, 1); assert.equal(group('assets').files, 2); assert.equal(group('assets').lines, 0);
  assert.equal(group('studies').files, 9); assert.equal(group('studies').lines, 8);
  assert.equal(group('interface').files, 0, 'study and diagnostic pages are outside the game interface');
  assert.equal(report.largest[0].file, 'src/view.js');
  assert.deepEqual(codebaseSize(root), report, 'the same working tree produces the same report');
});

test('the inventory counts TypeScript modules, tests and declarations in their owning areas', t => {
  const root = mkdtempSync(join(tmpdir(), 'impacto-codebase-'));
  t.after(() => { assert(root.startsWith(join(tmpdir(), 'impacto-codebase-'))); rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [file, source] of Object.entries({
    'src/view.ts': 'export const view: number = 1;\n', 'src/types.d.ts': 'export type View = number;\n',
    'server/room.mts': 'export const room: number = 1;\n', 'scripts/report.cts': 'module.exports = 1;\n',
    'tests/view.test.ts': 'test();\n', 'tests/room.test.mts': 'test();\n', 'tests/report.test.cts': 'test();\n',
    'src/native/core.d.ts': 'export function step(): void;\n',
  })) { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); }
  const report = codebaseSize(root), group = id => report.areas.find(area => area.id === id);
  assert.equal(report.maintainedCode.files, 4);
  assert.equal(report.maintainedCode.lines, 4);
  assert.equal(group('javascript').files, 2);
  assert.equal(group('server').files, 1); assert.equal(group('tools').files, 1);
  assert.equal(group('tests').files, 3); assert.equal(group('generated').files, 1);
  assert.equal(report.dependencies.modules, 3, 'declarations are counted as source without becoming executable modules');
});
