import { mkdir, stat, rename, open } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 2048, EVERY = 30_000, FILE_BYTES = 1024 * 1024, QUEUED = 64;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const string = (value: unknown, size: number): value is string => typeof value === 'string' && value.length <= size && !/[\u0000-\u001f\u007f]/.test(value);
const dimensions = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(n => Number.isInteger(n) && number(n, 1, 16384));
const ranges = { spanMs: [10_000, 60_000], frames: [1, 60_000], fps: [.01, 1000], frameP50Ms: [0, 1000],
  frameP95Ms: [0, 1000], framesOver1000Ms: [0, 60_000], frameMaxMs: [0, 60_000], dpr: [.1, 16], resolution: [.1, 16], zoom: [.001, 100_000],
  actors: [0, 4096], visible: [0, 4096], moving: [0, 4096], particles: [0, 100_000], shots: [0, 100_000],
  statesHz: [0, 1000], arrivalRatio: [0, 10], serverPace: [0, 10], stateGapMs: [0, 60_000], pingMs: [0, 60_000] } satisfies Record<string, [number, number]>;
type PerformanceNumbers = Record<keyof typeof ranges, number>;
export type PerformanceSample = PerformanceNumbers & {
  version: 1; limit: 0 | 60; mode: 'field' | 'workshop'; viewport: [number, number]; canvas: [number, number]; pixels: [number, number];
};
export interface PerformanceDevice {
  browser: string; major: number; platform: string; model: string; gpu: string; gpuVendor: string; logicalCoresHint: number; memoryHintGiB: number;
}
export interface PerformanceLog { write(record: unknown): void; close(): Promise<void> }
const performanceNumbers = (value: unknown): value is PerformanceNumbers => record(value) &&
  Object.entries(ranges).every(([key, [min, max]]) => number(value[key], min, max));

// Copy only diagnostic fields. Everything a client says, including its model and FPS, is untrusted.
export function performanceSample(sample: unknown): PerformanceSample | null {
  if (!record(sample) || sample.version !== 1 || sample.limit !== 0 && sample.limit !== 60 || sample.mode !== 'field' && sample.mode !== 'workshop'
    || !dimensions(sample.viewport) || !dimensions(sample.canvas) || !dimensions(sample.pixels)) return null;
  const values: unknown = Object.fromEntries(Object.keys(ranges).map(key => [key, sample[key]]));
  if (!performanceNumbers(values) || !Number.isInteger(values.frames) || !Number.isInteger(values.framesOver1000Ms) || values.framesOver1000Ms > values.frames
    || values.frameP50Ms > values.frameP95Ms || values.visible > values.actors || values.moving > values.visible
    || values.frameP95Ms > Math.ceil(values.frameMaxMs * 2) / 2
    || Math.abs(values.fps - values.frames * 1000 / values.spanMs) > .2) return null;
  return { version: 1, limit: sample.limit, mode: sample.mode, ...values,
    viewport: [...sample.viewport], canvas: [...sample.canvas], pixels: [...sample.pixels] };
}
export function performanceDevice(device: unknown): PerformanceDevice | null {
  if (!record(device) || !string(device.browser, 32) || !string(device.platform, 24) || !string(device.model, 80) || !string(device.gpu, 128) || !string(device.gpuVendor, 64)
    || !Number.isInteger(device.major) || !number(device.major, 0, 1000)
    || !Number.isInteger(device.logicalCoresHint) || !number(device.logicalCoresHint, 0, 256) || !number(device.memoryHintGiB, 0, 32)) return null;
  return { browser: device.browser, major: device.major, platform: device.platform, model: device.model,
    gpu: device.gpu, gpuVendor: device.gpuVendor, logicalCoresHint: device.logicalCoresHint, memoryHintGiB: device.memoryHintGiB };
}

// At most two private 1 MiB files, outside the served tree. There is no public reader.
// Serial asynchronous writes cannot block physics; a slow or full disk drops diagnostics.
export function performanceLog(dir: string | null | undefined): PerformanceLog | null {
  if (!dir) return null;
  const file = join(dir, 'client-performance.jsonl'), previous = join(dir, 'client-performance.previous.jsonl');
  let ready = false, size = 0, queued = 0, failed = false, work = Promise.resolve();
  return {
    write(record: unknown) {
      if (queued >= QUEUED || failed) return;
      const line = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(line); queued++;
      work = work.then(async () => {
        if (failed) return;
        if (!ready) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          try { size = (await stat(file)).size; } catch (error) {
            if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
          }
          ready = true;
        }
        if (size + bytes > FILE_BYTES) { await rename(file, previous); size = 0; }
        const handle = await open(file, 'a', 0o600);
        try { await handle.writeFile(line); } finally { await handle.close(); }
        size += bytes;
      }).catch(error => {
        const code: unknown = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        failed = true; console.error('Diagnóstico dos aparelhos indisponível:', code ?? 'falha de escrita');
      }).finally(() => { queued--; });
    },
    close() { return work; },
  };
}

export class ClientPerformanceReports {
  log: PerformanceLog | null | undefined;
  build: () => string | null;
  constructor(log: PerformanceLog | null | undefined, build: () => string | null = () => null) { this.log = log; this.build = build; }
  receive(socket: { joined?: boolean; performanceAt?: number }, data: unknown, bytes: number, now = Date.now()): boolean {
    if (!socket.joined || bytes > MAX_BYTES || now - (socket.performanceAt ?? -Infinity) < EVERY) return false;
    socket.performanceAt = now;
    if (!record(data)) return false;
    const sample = performanceSample(data.sample), device = performanceDevice(data.device);
    if (!sample || !device) return false;
    this.log?.write({ at: new Date(now).toISOString(), build: this.build(), device, sample });
    return true;
  }
  close() { return this.log?.close(); }
}
