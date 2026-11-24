import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, availableParallelism } from 'node:os';
import { WorkerPool } from './worker-pool.ts';
import { reviewCases, REVIEW_SUITES, readJSON } from './review-cases.ts';
import { reviewFailures } from './review-checks.ts';
import { fingerprint, isMain } from './review-harness.ts';
import { record, expectRecord, expectArray, errorMessage } from './operational-input.ts';
import { isWeaponPresetId } from '../src/weapons.ts';
import type { ReviewCase, ReviewOptions } from './review-cases.ts';

interface ReviewRow {
  id: string; probe: string; scenario: unknown; resultFile: string;
  result: Record<string, unknown>; failures: unknown[];
}
interface Comparison {
  id: string; identicalState: boolean; beforeMeanMs: unknown; afterMeanMs: unknown;
  reductionPercent: number; beforeP95Ms: unknown; afterP95Ms: unknown;
}
interface ReviewMetadata {
  suite: string; options: ReviewOptions; workers: number; reportFile: string;
  hardware: {cpu: string | undefined; logicalProcessors: number}; units: string;
  batch?: {workers: number}; comparison?: Comparison[];
}
const presentRow = (row: ReviewRow | undefined): row is ReviewRow => row !== undefined;


// Every option is a whole number within its bounds, a text or a flag. A scene runs for 20 minutes at most.
const numeric = { workers: [1, 32], count: [1, 512], limit: [1, 10000], frames: [1, 72000] } satisfies Record<string, [number, number]>;
const textOptions = {mode: true, case: true, output: true, label: true, scene: true};
const isNumeric = (name: string): name is keyof typeof numeric => Object.hasOwn(numeric, name);
const isText = (name: string): name is keyof typeof textOptions => Object.hasOwn(textOptions, name);
const defaultWorkers = () => Math.max(1, Math.min(8, availableParallelism() - 2));
export function reviewArguments(args: string[]) {
  const options: ReviewOptions = {}, suite = args[0]?.startsWith('--') ? null : args.shift();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    const name = argument.replace(/^--/, '').replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
    if (!argument.startsWith('--')) throw new Error('Opção sem nome: ' + argument);
    if (name === 'help' || name === 'list') options[name] = true;
    else if (isNumeric(name) || isText(name)) {
      const raw = args[i + 1];
      if (!raw || raw.startsWith('--')) throw new Error('Falta valor para --' + name);
      i++;
      if (isNumeric(name)) {
        const n = options[name] = Number(raw), bounds = numeric[name];
        if (!Number.isInteger(n) || n < bounds[0] || n > bounds[1]) throw new Error('Valor inválido para --' + name);
      } else options[name] = raw;
    } else throw new Error('Opção desconhecida: ' + args[i]);
  }
  return { suite, options };
}

const bulky = new Set(['trace', 'traces', 'samples', 'preparationSamples', 'events', 'impulses', 'native', 'history']);
export const compactResult = (result: Record<string, unknown>) => Object.fromEntries(Object.entries(result).filter(([key]) => !bulky.has(key)));
// The cases, those that failed and why, and how many of each weapon model a suite that names it ran and saw fail.
export function reviewSummary(rows: readonly (Pick<ReviewRow, 'id' | 'failures' | 'scenario'> | null | undefined)[]) {
  const completed = rows.filter((row): row is Pick<ReviewRow, 'id' | 'failures' | 'scenario'> => Boolean(row)), failures = completed.filter(r => r.failures.length), groups: Record<string, {cases: number; failed: number}> = {};
  for (const row of completed) if (record(row.scenario) && row.scenario.preset) {
    const group = groups['preset:' + row.scenario.preset] ||= { cases: 0, failed: 0 };
    group.cases++; group.failed += Number(row.failures.length > 0);
  }
  return { cases: completed.length, failed: failures.length, failures: failures.map(r => ({ id: r.id, reasons: r.failures })), groups };
}

const isReviewCase = (value: unknown): value is ReviewCase => record(value) && typeof value.id === 'string' &&
  typeof value.probe === 'string' && typeof value.checks === 'string' && record(value.params) &&
  (value.scenario === undefined || record(value.scenario) &&
    (value.scenario.preset === undefined || isWeaponPresetId(value.scenario.preset)));

export function pairedInputs(entries: ReviewCase[], before: unknown): ReviewCase[] {
  if (!Array.isArray(before) || fingerprint(entries, { opaqueIdentities: true }) !== fingerprint(before, { opaqueIdentities: true }))
    throw new Error('Os parâmetros do ensaio mudaram; use os mesmos casos, controles e filtros de before.');
  if (!before.every(isReviewCase)) throw new TypeError('Invalid review input case.');
  return before;
}

// One output format: frozen inputs, a full file per result, and compact progress.
export async function runReview(suite: string, options: ReviewOptions = {}, { signal }: {signal?: AbortSignal} = {}) {
  let entries = reviewCases(suite, options);
  if (options.case) entries = entries.filter(e => e.id === options.case);
  if (options.limit) entries = entries.slice(0, options.limit);
  if (!entries.length) throw new Error('Nenhum caso corresponde ao filtro.');
  if (options.list) return { suite, cases: entries.map(({ id, probe, params, scenario, checks }) => ({ id, probe, params, scenario, checks })) };
  const folder = resolve(options.output || 'validation/reviews/' + suite), label = options.label || 'current',
    directory = resolve(folder, label), started = performance.now(), rows: (ReviewRow | undefined)[] = Array(entries.length),
    workers = options.workers ?? defaultWorkers(), metadata: ReviewMetadata = { suite, options, workers, reportFile: resolve(directory, 'report.json'),
      hardware: { cpu: cpus()[0]?.model, logicalProcessors: availableParallelism() },
      units: 'Fixed 60 Hz / one rigid solve; timings include diagnostic instrumentation, not rendering FPS. Gameplay approximations, not calibrated live-fire data.' };
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Rótulo de relatório inválido.');
  const before = label === 'after' ? expectRecord(readJSON(resolve(folder, 'before/report.json'))) : null;
  if (before) {
    if (before.suite !== suite || !before.complete) throw new Error('O relatório before não contém um ensaio completo desta suite.');
    entries = pairedInputs(entries, readJSON(resolve(folder, 'before/inputs.json')));
  }
  if (['before', 'after'].includes(label) && existsSync(directory) && readdirSync(directory).length)
    throw new Error(`O relatório ${label} já contém arquivos. Use --output com outra pasta para preservar este controle.`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'inputs.json'), JSON.stringify(entries));
  const report = () => ({ ...metadata, complete: rows.filter(presentRow).length === entries.length, wallSeconds: (performance.now() - started) / 1000,
    summary: reviewSummary(rows), rows: rows.filter(presentRow) });
  const saveResult = (index: number, result: Record<string, unknown>) => {
    const entry = entries[index];
    if (!entry) throw new TypeError('Review worker returned an unassigned case index.');
    const failures = reviewFailures(entry, result), filename = 'case-' + entry.id.split('/').at(-1) + '.json';
    writeFileSync(resolve(directory, filename), JSON.stringify({ id: entry.id, scenario: entry.scenario, result, failures }, null, 2));
    rows[index] = { id: entry.id, probe: entry.probe, scenario: entry.scenario || result.scenario || entry.params.scenario,
      resultFile: filename, result: compactResult(result), failures };
    writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report(), null, 2));
    console.log(JSON.stringify({ completed: rows.filter(presentRow).length, total: entries.length, id: entry.id, failures }));
  };
  const run = async (count: number) => {
    const pool = new WorkerPool(new URL('./review-worker.ts', import.meta.url), count);
    try {
      await pool.collectDecoded(entries, undefined, expectRecord, { ...(signal === undefined ? {} : {signal}), onProgress: ({ index, result }) => saveResult(index, result) });
      return { workers: count };
    } finally { await pool.dispose(); }
  };
  try {
    metadata.batch = await run(Math.min(workers, entries.length));
    if (label === 'after') {
      if (!before) throw new TypeError('After comparison requires its before report.');
      const previousRows = expectArray(before.rows).map(expectRecord);
      metadata.comparison = rows.filter(presentRow).map(row => {
        const prior = previousRows.find(p => p.id === row.id), previous = prior && record(prior.result) ? prior.result : null;
        if (!previous || previous.fingerprint !== row.result.fingerprint || !row.result.fingerprint) throw new Error('O ensaio físico mudou: ' + row.id);
        return { id: row.id, identicalState: true, beforeMeanMs: previous.meanMs, afterMeanMs: row.result.meanMs,
          reductionPercent: (1 - Number(row.result.meanMs) / Number(previous.meanMs)) * 100, beforeP95Ms: previous.p95Ms, afterP95Ms: row.result.p95Ms };
      });
    }
    return report();
  } finally { writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report(), null, 2)); }
}

async function main() {
  const { suite, options } = reviewArguments(process.argv.slice(2));
  if (options.help || !suite) {
    console.log('Uso: node scripts/review.ts <suite> [--list] [--case suite/0001] [--limit N] [--workers 4] [--output pasta] [--label before|after|current]');
    console.log('Perfis: --mode all|quick|trace|diagnostic --count 12 --scene internal --frames 90');
    console.log('Suites: ' + REVIEW_SUITES.join(', ')); return;
  }
  const controller = new AbortController(), cancel = () => controller.abort(); process.once('SIGINT', cancel);
  try {
    const report = await runReview(suite, options, { signal: controller.signal });
    const summary = 'rows' in report ? (({rows, ...summary}) => summary)(report) : report;
    console.log(JSON.stringify(options.list ? report : summary, null, options.list ? 2 : 0));
    if ('summary' in report && report.summary.failed) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', cancel); }
}
if (isMain(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
