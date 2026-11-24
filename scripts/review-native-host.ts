// Compare host compilation with Wasm in isolated workers using the same game.
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';
import { isMain } from './review-harness.ts';
import type { NativeRuntime } from '../src/native-host-contract.ts';
import type { DynamicsComparisonPart, DynamicsComparisonRow, DynamicsComparisonState } from './review-native-dynamics.ts';

export interface HostProbeOptions { kind: 'dynamics'; steps?: number }
export interface HostProbeResult { runtime: NativeRuntime; rows: DynamicsComparisonRow[] }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = (value: unknown): value is number => typeof value === 'number';
const numericFields = (value: Record<string, unknown>, fields: readonly string[]): boolean => fields.every(key => numeric(value[key]));
function comparisonPart(value: unknown): value is DynamicsComparisonPart {
  return record(value) && numericFields(value, ['x', 'y', 'angle']) &&
    ['vx', 'vy', 'omega'].every(key => value[key] === undefined || numeric(value[key]));
}
function comparisonState(value: unknown): value is DynamicsComparisonState {
  return record(value) && record(value.stats) && Array.isArray(value.actors) && value.actors.every(comparisonPart) &&
    Array.isArray(value.plates) && value.plates.every(comparisonPart) && Array.isArray(value.modules) && value.modules.every(comparisonPart);
}
function comparisonRow(value: unknown): value is DynamicsComparisonRow {
  return record(value) && typeof value.name === 'string' && typeof value.exercise === 'string' && typeof value.terrain === 'string' &&
    numericFields(value, ['steps', 'actors', 'recoveries']) && typeof value.finite === 'boolean' && typeof value.partsPreserved === 'boolean' &&
    ['meanMs', 'p95Ms'].every(key => value[key] === undefined || numeric(value[key])) && Array.isArray(value.frames) &&
    value.frames.every((frame: unknown) => record(frame) && numeric(frame.step) && comparisonState(frame.state));
}
function decodeHostProbe(value: unknown): HostProbeResult {
  if (!record(value) || value.runtime !== 'native' && value.runtime !== 'wasm' || !Array.isArray(value.rows) || !value.rows.every(comparisonRow))
    throw new TypeError('Invalid native host probe result.');
  // Retain the original rows and their unconsumed report fields. This guard
  // covers only the frame fields comparison reads; numerical metrics check
  // their own fields before arithmetic in compareDynamicsRows.
  return { runtime: value.runtime, rows: value.rows };
}
function probeOptions(value: unknown): value is HostProbeOptions {
  return record(value) && value.kind === 'dynamics' && Object.keys(value).every(key => ['kind', 'steps'].includes(key)) &&
    (value.steps === undefined || numeric(value.steps));
}

export async function hostProbe(runtime: NativeRuntime, options: HostProbeOptions): Promise<HostProbeResult> {
  const result: unknown = await new Promise<unknown>((accept, reject) => {
    const worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: options,
      env: { ...process.env, IMPACTO_DYNAMICS_RUNTIME: runtime } });
    let replied = false, result: unknown;
    worker.once('message', (message: unknown) => { replied = true; result = message; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code || !replied) reject(new Error(`Host ${runtime} exited without a successful result (${code}).`));
      else accept(result);
    });
  });
  return decodeHostProbe(result);
}

if (parentPort) {
  const options: unknown = workerData;
  if (!probeOptions(options)) throw new Error('Unknown native host probe.');
  const binding = await import('../src/native-dynamics.ts');
  await binding.initNativeDynamics();
  const nativeDynamicsRuntime = binding.nativeDynamicsRuntime || 'wasm';
  const { dynamicsCases, runDynamicsCase } = await import('./review-native-dynamics.ts'),
    cases = dynamicsCases(options.steps), seed = cases.find(c => c.name === 'scout-controls-flat');
  if (!seed) throw new TypeError('Native host probes require the flat scout control case.');
  for (const contact of ['solo', 'ally', 'enemy', 'wreck']) cases.push({ ...seed, name: 'contact-' + contact,
    actors: contact === 'solo' ? 1 : 2, exercise: 'pass', starts: [8, 14], owners: ['blue', contact === 'ally' ? 'blue' : 'red'],
    ...(contact === 'wreck' ? { defeatedActor: 1 } : {}) });
  const rows: Awaited<ReturnType<typeof runDynamicsCase>>[] = [];
  for (const item of cases) rows.push(await runDynamicsCase(item));
  parentPort.postMessage({ runtime: nativeDynamicsRuntime, rows });
  parentPort.close();
} else if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), value = (flag: string, fallback: string): string | undefined => {
    const at = args.indexOf(flag); return at < 0 ? fallback : args[at + 1];
  }, steps = Number(value('--steps', '240')), repeats = Number(value('--repeats', '3')),
    outputName = value('--out', 'validation/native-host-2026-10-07/parity.json');
  if (outputName === undefined) throw new Error('--out needs a path.');
  const output = resolve(outputName);
  if (!Number.isInteger(steps) || steps < 180 || steps > 3600 || !Number.isInteger(repeats) || repeats < 1)
    throw new Error('Use --steps 180..3600 and --repeats >=1.');
  const { compareDynamicsRows } = await import('./review-native-dynamics.ts'), rows: (HostProbeResult & { repeat: number })[] = [],
    comparisons: (ReturnType<typeof compareDynamicsRows> & { repeat: number; name: string })[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const paired: Partial<Record<NativeRuntime, HostProbeResult>> = {},
      runtimes: readonly NativeRuntime[] = repeat % 2 ? ['native', 'wasm'] : ['wasm', 'native'];
    for (const runtime of runtimes) {
      const result = await hostProbe(runtime, { kind: 'dynamics', steps }); paired[runtime] = result;
      rows.push({ repeat, ...result }); console.log(JSON.stringify({ repeat, runtime: result.runtime,
        rows: result.rows.map(({ frames, ...row }) => row) }));
    }
    const { wasm, native } = paired;
    if (!wasm || !native) throw new TypeError('Native parity requires both runtime probes.');
    for (let i = 0; i < wasm.rows.length; i++) {
      const reference = wasm.rows[i], candidate = native.rows[i];
      if (!reference || !candidate) throw new TypeError('Native parity requires corresponding cases from both runtimes.');
      comparisons.push({ repeat, name: reference.name, ...compareDynamicsRows(reference, candidate) });
    }
  }
  const cpu = cpus()[0];
  if (!cpu) throw new TypeError('Native host diagnostics require CPU information.');
  const report = { generatedAt: new Date().toISOString(), hardware: { cpu: cpu.model, node: process.version },
    method: 'Same core, constructions, accepted controls, seeds, 60 Hz and one rigid solve; isolated workers, alternating runtime order. End-to-end World.step timing excludes setup, snapshots and diagnostics.',
    pass: comparisons.every(c => c.pass), comparisons,
    // Compare every sampled frame above, but retain only the final frame per
    // case in the report instead of duplicating large histories per repeat.
    rows: rows.map(run => ({ ...run, rows: run.rows.map(({ frames, ...row }) =>
      ({ ...row, samples: frames.length, final: frames.at(-1) })) })) };
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, pass: report.pass, comparisons }));
  if (!report.pass) process.exitCode = 1;
}
