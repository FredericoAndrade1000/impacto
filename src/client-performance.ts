// Small field reports, independent of the optional F3 profiler. A fixed histogram counts
// displayed frame intervals in half-millisecond bins; it does not time GPU work or read pixels.
// A second of margin keeps ordinary network jitter from crossing the server's thirty-second limit.
const WINDOW = 10_000, EVERY = 31_000, BIN = .5, LAST_BIN = 2000;
const rounded = (value: number): number => Math.round(value * 10) / 10;
const text = (value: unknown, length = 80): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, length) : '';
const BROWSERS: Readonly<Record<string, string>> = { SamsungBrowser: 'Samsung Internet', Edg: 'Microsoft Edge', EdgA: 'Microsoft Edge', EdgiOS: 'Microsoft Edge',
  OPR: 'Opera', CriOS: 'Google Chrome', FxiOS: 'Firefox', Firefox: 'Firefox', Chrome: 'Google Chrome', Version: 'Safari' };

export interface PerformanceDevice {
  browser: string; major: number; platform: string; model: string; logicalCoresHint: number; memoryHintGiB: number; gpu: string; gpuVendor: string;
}
export interface NavigatorInformation {
  readonly userAgent?: string;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly userAgentData?: {
    readonly brands?: readonly { readonly brand: string; readonly version: string }[];
    readonly platform?: string;
    getHighEntropyValues?(hints: string[]): Promise<{ readonly model?: unknown }>;
  };
}
export interface GraphicsInformationSource { getExtension(name: string): unknown; getParameter(parameter: number): unknown }
export type GPUInformation = { gpu: string; gpuVendor: string } | { gpu?: never; gpuVendor?: never };
interface WorkloadCounts { actors: number; visible: number; moving: number; particles: number; shots: number }
export interface PerformanceContext extends WorkloadCounts {
  mode: 'field' | 'workshop'; viewport: readonly [number, number]; canvas: readonly [number, number]; pixels: readonly [number, number];
  dpr: number; resolution: number; zoom: number; pingMs: number;
}
export interface PerformanceSample extends PerformanceContext {
  version: 1; spanMs: number; frames: number; fps: number; frameP50Ms: number; frameP95Ms: number;
  framesOver1000Ms: number; frameMaxMs: number; limit: number; statesHz: number; arrivalRatio: number; serverPace: number; stateGapMs: number;
}
export interface PerformanceReport { sample: PerformanceSample; device: PerformanceDevice }
export interface ClientPerformanceOptions { send(report: PerformanceReport): void; context(): PerformanceContext; device?: PerformanceDevice }
interface Arrivals { first: number; last: number; timeFirst: number; timeLast: number; count: number; gap: number }
interface MeasurementWindow {
  started: number; last: number; limit: number; frames: number; over: number; max: number; contextAt: number; contexts: number;
  counts: WorkloadCounts; context: PerformanceContext | null; arrivals: Arrivals | null; pace: number; paces: number;
}
const COUNTS = ['actors', 'visible', 'moving', 'particles', 'shots'] as const;
const DIMENSIONS = ['viewport', 'canvas', 'pixels'] as const;

export function deviceInformation(nav: NavigatorInformation | null | undefined = globalThis.navigator): PerformanceDevice {
  const ua = nav?.userAgent ?? '', brands = nav?.userAgentData?.brands ?? [],
    brand = ['Microsoft Edge', 'Google Chrome', 'Chromium'].map(name => brands.find(b => b.brand === name)).find(Boolean),
    product = ua.match(/(SamsungBrowser|EdgiOS|EdgA?|OPR|CriOS|FxiOS)\/(\d+)/),
    fallback = product || ua.match(/(Firefox|Chrome|Version)\/(\d+)/), productName = product?.[1], fallbackName = fallback?.[1],
    browser = product ? productName && BROWSERS[productName] : brand?.brand || (fallbackName && BROWSERS[fallbackName]) || 'Unknown',
    platform = nav?.userAgentData?.platform || (/Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown');
  const device = { browser: text(browser, 32), major: Number(product?.[2] ?? brand?.version ?? fallback?.[2]) || 0,
    platform: text(platform, 24), model: '', logicalCoresHint: Math.min(256, Math.max(0, nav?.hardwareConcurrency || 0)),
    memoryHintGiB: Math.min(32, Math.max(0, nav?.deviceMemory || 0)), gpu: '', gpuVendor: '' };
  // This is a browser hint, not a model guessed from screen dimensions or a benchmark score.
  try { nav?.userAgentData?.getHighEntropyValues?.(['model']).then(hints => { device.model = text(hints.model); }).catch(() => {}); } catch {}
  return device;
}

// Only the game's already-created context is consulted, once. Browsers may hide its renderer.
export function gpuInformation(gl: GraphicsInformationSource | null | undefined): GPUInformation {
  try {
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info && typeof info === 'object' && 'UNMASKED_RENDERER_WEBGL' in info && typeof info.UNMASKED_RENDERER_WEBGL === 'number' &&
      'UNMASKED_VENDOR_WEBGL' in info && typeof info.UNMASKED_VENDOR_WEBGL === 'number' ? {
        gpu: text(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL), 128), gpuVendor: text(gl?.getParameter(info.UNMASKED_VENDOR_WEBGL), 64),
      } : {};
  } catch { return {}; }
}

export class ClientPerformance {
  readonly send: ClientPerformanceOptions['send'];
  readonly context: ClientPerformanceOptions['context'];
  readonly device: PerformanceDevice;
  readonly bins = new Uint32Array(LAST_BIN + 1);
  next = 0;
  connection: unknown = null;
  private window: MeasurementWindow | null = null;
  constructor({ send, context, device = deviceInformation() }: ClientPerformanceOptions) {
    this.send = send; this.context = context; this.device = device;
  }
  get last(): number | null { return this.window?.last ?? null; }
  rest(): void { this.window = null; }
  state(now: number, time: number, pace?: number): void {
    const w = this.window; if (!w || !Number.isFinite(time)) return;
    if (!w.arrivals) w.arrivals = { first: now, last: now, timeFirst: time, timeLast: time, count: 1, gap: 0 };
    else {
      const arrivals = w.arrivals;
      arrivals.gap = Math.max(arrivals.gap, now - arrivals.last);
      arrivals.count++; arrivals.last = now; arrivals.timeLast = time;
    }
    if (typeof pace === 'number' && Number.isFinite(pace)) { w.pace += pace; w.paces++; }
  }
  frame(now: number, active: boolean, limit: number, connection: unknown): void {
    if (!active) { this.rest(); return; }
    if (connection !== this.connection) { this.connection = connection; this.rest(); }
    if (now < this.next) return;
    let w = this.window;
    if (!w || w.limit !== limit) {
      this.bins.fill(0);
      w = this.window = { started: now, last: now, limit, frames: 0, over: 0, max: 0, contextAt: -Infinity, contexts: 0,
        counts: { actors: 0, visible: 0, moving: 0, particles: 0, shots: 0 }, context: null, arrivals: null, pace: 0, paces: 0 };
    } else {
      const interval = Math.max(0, now - w.last); w.last = now;
      // A suspended process is not a minute-long rendering frame.
      if (interval > 60_000) { this.rest(); return; }
      if (interval > LAST_BIN * BIN) w.over++;
      const bin = Math.min(LAST_BIN, Math.ceil(interval / BIN)), hits = this.bins[bin];
      if (hits !== undefined) this.bins[bin] = hits + 1;
      w.frames++; w.max = Math.max(w.max, interval);
    }
    if (now - w.contextAt >= 1000) {
      const context = this.context(), before = w.context;
      if (before && (DIMENSIONS.some(key => context[key].some((n, i) => n !== before[key][i]))
        || context.dpr !== before.dpr || context.resolution !== before.resolution || context.mode !== before.mode)) { this.rest(); return; }
      w.context = context; w.contextAt = now; w.contexts++;
      for (const key of COUNTS) w.counts[key] += context[key];
    }
    if (now - w.started < WINDOW || !w.frames || !w.context) return;
    const quantile = (share: number): number => {
      const target = Math.ceil(w.frames * share); let count = 0;
      for (const [i, hits] of this.bins.entries()) if ((count += hits) >= target) return i * BIN;
      return LAST_BIN * BIN;
    }, span = now - w.started, arrivals = w.arrivals, arrivalSpan = arrivals && arrivals.count > 1 ? arrivals.last - arrivals.first : 0;
    if (span > 60_000) { this.rest(); return; }
    const sample: PerformanceSample = { version: 1, spanMs: rounded(span), frames: w.frames, fps: rounded(w.frames * 1000 / span),
      frameP50Ms: quantile(.5), frameP95Ms: quantile(.95), framesOver1000Ms: w.over,
      frameMaxMs: Math.ceil(w.max * 10) / 10, limit, mode: w.context.mode,
      viewport: w.context.viewport, canvas: w.context.canvas, pixels: w.context.pixels,
      dpr: w.context.dpr, resolution: w.context.resolution, zoom: Math.round(w.context.zoom * 1000) / 1000,
      actors: rounded(w.counts.actors / w.contexts), visible: rounded(w.counts.visible / w.contexts), moving: rounded(w.counts.moving / w.contexts),
      particles: rounded(w.counts.particles / w.contexts), shots: rounded(w.counts.shots / w.contexts),
      statesHz: arrivals && arrivalSpan > 0 ? rounded((arrivals.count - 1) * 1000 / arrivalSpan) : 0,
      arrivalRatio: arrivals && arrivalSpan > 0 ? Math.round((arrivals.timeLast - arrivals.timeFirst) * 100_000 / arrivalSpan) / 100 : 0,
      serverPace: w.paces ? Math.round(w.pace / w.paces * 100) / 100 : 0,
      stateGapMs: rounded(Math.max(arrivals?.gap ?? 0, now - (arrivals?.last ?? w.started))), pingMs: rounded(w.context.pingMs) };
    // The readings are made once, but each small report carries them: a lost first packet
    // must not make the rest unusable, and a delayed model hint can appear in the next one.
    const report = { sample, device: { ...this.device } };
    this.next = now + EVERY - WINDOW; this.rest();
    try { this.send(report); } catch { /* Diagnostics never interrupt the game. */ }
  }
}
