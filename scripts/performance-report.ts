import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performanceSample, performanceDevice } from '../server/client-performance.ts';
import { parseJSON, record as isRecord, errorCode, errorMessage } from './operational-input.ts';

interface PerformanceGroup {
  context: Record<string, unknown>; windows: number; ms: number; frames: number; minFps: number; p95Windows: number[]; censoredP95s: number;
  visible: number; moving: number; arrivalRatio: number; serverPace: number; minZoom: number; maxZoom: number; minVisible: number; maxVisible: number;
  maxFrame: number; maxStateGap: number;
}
const earliest = (previous: string | null, at: string): string => previous === null || at < previous ? at : previous;
const latest = (previous: string | null, at: string): string => previous === null || at > previous ? at : previous;

// Offline only: inspect the two private logs through the server's shell.
// Window percentiles are kept as window percentiles, not presented as a pooled frame P95.
export function summarizePerformance(records: Iterable<unknown>) {
  const groups = new Map<string, PerformanceGroup>(); let first: string | null = null, last: string | null = null;
  for (const record of records) {
    if (!isRecord(record) || typeof record.at !== 'string') continue;
    const { at, build } = record, device = performanceDevice(record.device), sample = performanceSample(record.sample);
    if (!device || !sample) continue;
    first = earliest(first, at); last = latest(last, at);
    // Empty views are another workload; ranges expose camera changes without a bucket for every zoom value.
    const context = { build, platform: device.platform, model: device.model || null, gpu: device.gpu || null, gpuVendor: device.gpuVendor || null,
      browser: device.browser + (device.major ? ` ${device.major}` : ''),
      logicalCoresHint: device.logicalCoresHint || null, memoryHintGiB: device.memoryHintGiB || null,
      mode: sample.mode, limit: sample.limit, pixels: sample.pixels, moving: sample.moving > 0,
      ...(sample.mode === 'field' ? { scene: sample.visible > 0 ? 'actors' : 'empty' } : {}) }, key = JSON.stringify(context),
      bucket = groups.has(key) || groups.size < 64 ? key : 'other';
    let group = groups.get(bucket);
    if (!group) { group = { context: bucket === 'other' ? { other: true } : context, windows: 0, ms: 0, frames: 0,
      minFps: Infinity, p95Windows: [], censoredP95s: 0, visible: 0, moving: 0, arrivalRatio: 0, serverPace: 0,
      minZoom: Infinity, maxZoom: 0, minVisible: Infinity, maxVisible: 0, maxFrame: 0, maxStateGap: 0 }; groups.set(bucket, group); }
    group.windows++; group.ms += sample.spanMs; group.frames += sample.frames;
    group.minFps = Math.min(group.minFps, sample.fps); group.p95Windows.push(sample.frameP95Ms);
    if (sample.frames - sample.framesOver1000Ms < Math.ceil(sample.frames * .95)) group.censoredP95s++;
    group.visible += sample.visible; group.moving += sample.moving; group.arrivalRatio += sample.arrivalRatio; group.serverPace += sample.serverPace;
    group.minZoom = Math.min(group.minZoom, sample.zoom); group.maxZoom = Math.max(group.maxZoom, sample.zoom);
    group.minVisible = Math.min(group.minVisible, sample.visible); group.maxVisible = Math.max(group.maxVisible, sample.visible);
    group.maxFrame = Math.max(group.maxFrame, sample.frameMaxMs); group.maxStateGap = Math.max(group.maxStateGap, sample.stateGapMs);
  }
  const rounded = (n: number): number => Math.round(n * 100) / 100;
  return { first, last, groups: [...groups.values()].map(g => {
    g.p95Windows.sort((a, b) => a - b);
    const medianP95 = g.p95Windows[Math.floor(g.p95Windows.length / 2)];
    if (medianP95 === undefined) throw new Error('Grupo sem janelas de desempenho.');
    return { ...g.context, windows: g.windows, seconds: rounded(g.ms / 1000), fps: rounded(g.frames * 1000 / g.ms),
      minWindowFps: g.minFps, medianWindowP95Ms: medianP95 >= 1000 && g.censoredP95s ? null : medianP95,
      windowsWithCensoredP95: g.censoredP95s,
      visibleActors: rounded(g.visible / g.windows), movingActors: rounded(g.moving / g.windows),
      windowZoomRange: [g.minZoom, g.maxZoom], windowVisibleActorsRange: [g.minVisible, g.maxVisible],
      maxFrameMs: g.maxFrame, maxStateGapMs: g.maxStateGap,
      arrivalRatio: rounded(g.arrivalRatio / g.windows), serverPace: rounded(g.serverPace / g.windows) };
  }) };
}

async function main() {
  const dir = process.argv[2] || process.env.IMPACTO_SAVE_DIR;
  if (!dir) throw new Error('Uso: node scripts/performance-report.ts <diretório privado de IMPACTO_SAVE_DIR>');
  const records: unknown[] = [];
  for (const name of ['client-performance.previous.jsonl', 'client-performance.jsonl']) {
    let text;
    try { text = await readFile(join(dir, name), 'utf8'); } catch (error) { if (errorCode(error) === 'ENOENT') continue; throw error; }
    for (const line of text.split('\n')) { if (!line) continue; try { records.push(parseJSON(line)); } catch { /* A stopped append can leave one incomplete final line. */ } }
  }
  console.log(JSON.stringify(summarizePerformance(records), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error: unknown) => { console.error(errorMessage(error)); process.exitCode = 1; });
