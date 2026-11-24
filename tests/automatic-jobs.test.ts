import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';
import { jobView, idleJob, pausedJob } from '../src/automatic-jobs.ts';
import { typeDiagnostics } from './helpers/type-diagnostics.ts';

test('a public haul follows its real transport phase without changing the dispatcher leg or inventing a target', () => {
  const source = { kind: 'haul', phase: 'fetch', targetId: 'deposit', haul: { phase: 'home' } } satisfies Parameters<typeof jobView>[0];
  assert.deepEqual(jobView(source, true), { kind: 'haul', phase: 'home', targetId: 'deposit', reason: '', post: true });
  assert.equal(source.phase, 'fetch');
  assert.deepEqual(jobView({ kind: null, phase: 'return', targetId: null, reason: 'danger' }),
    { kind: null, phase: 'return', targetId: null, reason: 'danger' });
  assert.deepEqual(pausedJob('manual-control'), { kind: null, phase: 'paused', targetId: null, reason: 'manual-control' });
  assert.deepEqual(idleJob('waiting-stock', 'work'), { kind: null, phase: 'idle', targetId: 'work', reason: 'waiting-stock' });
});

test('typed job construction separates dispatcher phases, hauling phases and absent tasks', () => {
  const file = fileURLToPath(new URL('automatic-jobs.fixture.ts', import.meta.url)), rows = [
    "import { jobView } from '../src/automatic-jobs.ts';",
    "import type { DispatchView } from '../src/automatic-jobs.ts';",
    "import { jobText } from '../src/automatic-presentation.ts';",
    "jobView({ kind: 'build', phase: 'work', targetId: 'work' });",
    "jobView({ kind: 'haul', phase: 'fetch', targetId: 'deposit', haul: { phase: 'load' } });",
    "jobText({ auto: true, job: { kind: null, phase: 'paused', targetId: null, reason: 'manual-control' } });",
    "jobText({ auto: true, job: null });",
    "jobView({ kind: 'invented', phase: 'go', targetId: 'target' }); // invalid",
    "jobView({ kind: null, phase: 'go', targetId: null }); // invalid",
    "jobView({ kind: 'build', phase: 'work', targetId: null }); // invalid",
    "jobView({ kind: 'haul', phase: 'fetch', targetId: 'deposit', haul: { phase: 'deliver' } }); // invalid",
    "const paused: DispatchView = { kind: null, phase: 'paused', targetId: 'target', reason: '' }; // invalid",
  ], errors = typeDiagnostics(file, rows.join('\n'));
  const actual = errors.map(error => {
    assert.equal(resolve(error.file?.fileName ?? ''), file, ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    return error.file?.getLineAndCharacterOfPosition(error.start ?? 0).line;
  }).filter((line): line is number => line !== undefined).map(line => line + 1);
  assert.deepEqual([...new Set(actual)].sort((a, b) => a - b), rows.flatMap((row, index) => row.endsWith('// invalid') ? [index + 1] : []));
});

test('adding a job family to the real catalogue requires an explicit presentation branch', () => {
  const file = fileURLToPath(new URL('../src/automatic-jobs.ts', import.meta.url)), source = readFileSync(file, 'utf8'),
    changed = source.replace('rearm: 4,', "unhandledProbe: 1, rearm: 4,") + "\nimport type * as Presentation from './automatic-presentation.ts';\n";
  assert.notEqual(source, changed);
  const errors = typeDiagnostics(file, changed);
  assert(errors.some(error => error.file?.fileName.endsWith('automatic-presentation.ts') &&
    ts.flattenDiagnosticMessageText(error.messageText, ' ').includes('never')), errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
});
