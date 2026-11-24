import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientPerformance, deviceInformation, gpuInformation } from '../src/client-performance.ts';
import { ClientPerformanceReports, performanceSample, performanceDevice, performanceLog } from '../server/client-performance.ts';
import { summarizePerformance } from '../scripts/performance-report.ts';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';

const device = () => ({ browser: 'Google Chrome', major: 140, platform: 'Android', model: 'SM-A155M',
  logicalCoresHint: 8, memoryHintGiB: 4, gpu: 'Mali-G57 MC2', gpuVendor: 'ARM' });
const context = () => ({ mode: 'field', viewport: [844, 390], canvas: [844, 390], pixels: [1688, 780], dpr: 2, resolution: 2,
  zoom: 24, actors: 6, visible: 5, moving: 3, particles: 0, shots: 0, pingMs: 25 });
function page() {
  const p = { reports: [], connection: {}, read: 0, now: 0, context: context() };
  p.client = new ClientPerformance({ device: device(), send: report => p.reports.push({ now: p.now, report }),
    context: () => { p.read++; return { ...p.context, viewport: [...p.context.viewport] }; } });
  p.frame = (now, active = true, limit = 0) => { p.now = now; p.client.frame(now, active, limit, p.connection); };
  p.run = (from, to, interval = 10, active = true, limit = 0) => { for (let now = from; now <= to; now += interval) p.frame(now, active, limit); };
  return p;
}
const report = () => { const p = page(); p.run(0, 10_000); return p.reports[0].report; };

test('field performance reports count real intervals with fixed memory and at most one small packet every thirty seconds', () => {
  const p = page(); p.run(0, 72_000);
  assert.deepEqual(p.reports.map(r => r.now), [10_000, 41_000, 72_000]);
  assert.equal(p.client.bins.byteLength, 8004);
  assert.equal(p.read, 33, 'context is read once a second only during the ten-second windows');
  const [a, b] = p.reports.map(r => r.report);
  assert.equal(a.sample.frames, 1000); assert.equal(a.sample.fps, 100);
  assert.equal(a.sample.frameP50Ms, 10); assert.equal(a.sample.frameP95Ms, 10);
  assert(a.device); assert.deepEqual(b.device, a.device, 'small metadata stays self-contained when an earlier packet is lost');
  assert(Buffer.byteLength(JSON.stringify(a)) < 2048); assert(performanceSample(a.sample)); assert(performanceDevice(a.device));
});

test('half-millisecond frame quantiles retain hitches and separate server arrivals from rendering FPS', () => {
  const p = page();
  for (let now = 0; now <= 10_000; now += 20) {
    p.frame(now);
    if (now % 100 === 0) p.client.state(now, now / 1000 * .8, 1);
  }
  const { sample } = p.reports[0].report;
  assert.equal(sample.fps, 50); assert.equal(sample.statesHz, 10); assert.equal(sample.arrivalRatio, .8); assert.equal(sample.serverPace, 1);
  const q = page(); q.frame(0); for (let n = 1; n <= 600; n++) q.frame(n * 1000 / 60);
  const sixty = q.reports[0].report.sample;
  assert.equal(sixty.frameP50Ms, 17); assert.equal(sixty.frameP95Ms, 17); assert.equal(sixty.fps, 60);
  assert(performanceSample(sixty), 'rounding a bin upward is valid even when the exact maximum rounds to16.7ms');
  const r = page(); for (let n = 0; n <= 625; n++) r.frame(n * 16.01);
  assert(performanceSample(r.reports[0].report.sample), 'maximum rounding must not reject the upward half-millisecond percentile bin');
});

test('background, pause, changed cap and resized canvas discard mixed windows', () => {
  const p = page(); p.run(0, 5000); p.frame(6000, false); p.run(20_000, 29_990);
  assert.equal(p.reports.length, 0); p.frame(30_000); assert.equal(p.reports.length, 1);
  assert.equal(p.reports[0].report.sample.frameMaxMs, 10, 'hidden time is excluded');
  const q = page(); q.run(0, 5000); q.run(6000, 15_990, 10, true, 60);
  assert.equal(q.reports.length, 0); q.frame(16_000, true, 60); assert.equal(q.reports[0].report.sample.limit, 60);
  const r = page(); r.run(0, 5000); r.context.pixels = [844, 390]; r.run(6000, 15_990);
  assert.equal(r.reports.length, 0); r.run(16_000, 17_000); assert.equal(r.reports[0].report.sample.pixels[0], 844);
  const s = page(); s.run(0, 5000); s.context.mode = 'workshop'; s.run(6000, 15_990);
  assert.equal(s.reports.length, 0); s.run(16_000, 17_000); assert.equal(s.reports[0].report.sample.mode, 'workshop');
});

test('reconnection resends metadata while preserving the thirty-second packet bound', () => {
  const p = page(); p.run(0, 10_000); p.connection = {}; p.run(11_000, 40_990);
  assert.equal(p.reports.length, 1); p.frame(41_000);
  assert(p.reports[1].report.device); assert.equal(p.reports[1].now - p.reports[0].now, 31_000);
});

test('device hints may be missing and GPU information only consults the existing context', async () => {
  const known = deviceInformation({ userAgent: 'Mozilla Android Chrome/140.0', hardwareConcurrency: 8, deviceMemory: 4,
    userAgentData: { platform: 'Android', brands: [{ brand: 'Google Chrome', version: '140' }],
      getHighEntropyValues: async () => ({ model: 'SM-A155M' }) } });
  assert.equal(known.model, ''); await Promise.resolve(); assert.equal(known.model, 'SM-A155M');
  assert.equal(known.userAgent, undefined); assert.equal(deviceInformation({}).model, '');
  assert.equal(deviceInformation({ userAgent: 'iPhone Version/18.0 Safari/600' }).platform, 'iOS');
  const brands = [{ brand: 'Chromium', version: '140' }, { brand: 'Google Chrome', version: '140' }];
  assert.equal(deviceInformation({ userAgentData: { brands } }).browser, 'Google Chrome');
  assert.equal(deviceInformation({ userAgentData: { brands: [...brands, { brand: 'Microsoft Edge', version: '140' }] } }).browser, 'Microsoft Edge');
  const samsung = deviceInformation({ userAgent: 'Chrome/129.0 SamsungBrowser/27.0', userAgentData: { brands: [{ brand: 'Chromium', version: '129' }] } });
  assert.equal(samsung.browser, 'Samsung Internet'); assert.equal(samsung.major, 27);
  for (const [ua, browser] of [['Chrome/140.0 Safari/600 Edg/140.0', 'Microsoft Edge'], ['iPhone CriOS/140.0 Safari/600', 'Google Chrome'],
    ['iPhone FxiOS/140.0 Mobile Safari/600', 'Firefox'], ['Chrome/140.0 SamsungBrowser/28.0', 'Samsung Internet']])
    assert.equal(deviceInformation({ userAgent: ua }).browser, browser);
  const asked = [], gl = { getExtension: name => { asked.push(name); return { UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2 }; },
    getParameter: key => { asked.push(key); return key === 1 ? 'Mali-G57 MC2' : 'ARM'; } };
  assert.deepEqual(gpuInformation(gl), { gpu: 'Mali-G57 MC2', gpuVendor: 'ARM' });
  assert.deepEqual(asked, ['WEBGL_debug_renderer_info', 1, 2]); assert.deepEqual(gpuInformation(null), {});
  assert.deepEqual(gpuInformation({ getExtension() { throw new Error('unavailable'); } }), {});
});

test('server accepts only authenticated, bounded, typed reports and copies a strict allowlist', () => {
  const written = [], reports = new ClientPerformanceReports({ write: row => written.push(row) }, () => 'build-a'), data = report(), socket = {};
  assert.equal(reports.receive(socket, data, 1024, 0), false); assert.equal(written.length, 0);
  socket.joined = true;
  assert.equal(reports.receive(socket, data, 2049, 0), false);
  data.token = 'secret'; data.sample.name = 'Ana'; data.device.ip = '127.0.0.1';
  assert.equal(reports.receive(socket, data, 1024, 0), true);
  assert.equal(reports.receive(socket, data, 1024, 29_999), false);
  assert.equal(reports.receive(socket, data, 1024, 30_000), true);
  assert.equal(reports.receive(socket, { sample: data.sample }, 600, 60_000), false, 'each report must stand on its own');
  assert.equal(written.length, 2); const text = JSON.stringify(written);
  assert(!/secret|Ana|127\.0\.0\.1|token|"ip"|"name"/.test(text)); assert.equal(written[0].device.model, 'SM-A155M');
  for (const [key, value] of [['fps', '60'], ['spanMs', 9999], ['frames', 1.5], ['frameP95Ms', NaN], ['moving', 9999], ['limit', 165]])
    assert.equal(performanceSample({ ...data.sample, [key]: value }), null, key);
  assert.equal(performanceSample({ ...data.sample, pixels: [1, 20000] }), null);
  assert.equal(performanceDevice({ ...data.device, gpu: 'x'.repeat(129) }), null);
  assert.equal(performanceDevice({ ...data.device, model: 'model\nnew log' }), null);
});

test('invalid reports consume their per-socket rate allowance without writing', () => {
  const data = report();
  for (const invalid of [null, [], 7, {}, { ...data, sample: { ...data.sample, frames: -1 } }]) {
    const written = [], reports = new ClientPerformanceReports({ write: row => written.push(row) }), socket = { joined: true };
    assert.equal(reports.receive(socket, invalid, 1000, 0), false);
    assert.equal(reports.receive(socket, data, 1000, 1), false);
    assert.equal(reports.receive(socket, data, 1000, 30_000), true); assert.equal(written.length, 1);
  }
});

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'impacto-performance-'));
  assert(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
test('private performance logs rotate at one MiB without adding a public endpoint', async t => {
  const dir = await temporary(t), current = join(dir, 'client-performance.jsonl'), previous = join(dir, 'client-performance.previous.jsonl');
  await writeFile(current, 'x'.repeat(1024 * 1024 - 1)); await writeFile(previous, 'old');
  const log = performanceLog(dir), row = { at: new Date(0).toISOString(), ...report() };
  log.write(row); await log.close();
  assert.equal((await stat(previous)).size, 1024 * 1024 - 1); assert((await stat(current)).size < 2048);
  assert.deepEqual(JSON.parse((await readFile(current, 'utf8')).trim()), row);
  if (process.platform !== 'win32') assert.equal((await stat(current)).mode & 0o077, 0);
});

test('a missing or unwritable diagnostic directory cannot throw through the game', async t => {
  const dir = await temporary(t), file = join(dir, 'file'); await writeFile(file, 'occupied');
  const before = console.error, errors = []; console.error = (...args) => errors.push(args);
  t.after(() => { console.error = before; });
  const log = performanceLog(file); log.write({ sample: 'one' }); log.write({ sample: 'two' });
  await log.close(); log.write({ sample: 'three' }); await log.close();
  assert.equal(errors.length, 1); assert.equal(performanceLog(null), null);
});

test('offline summaries separate motion, resolution and cap and label window percentiles correctly', () => {
  const data = report(), rows = [false, true].map((moving, i) => ({ at: new Date(i * 1000).toISOString(), build: 'a', device: data.device,
    sample: { ...data.sample, moving: Number(moving) } })), summary = summarizePerformance(rows);
  assert.equal(summary.groups.length, 2); assert.deepEqual(summary.groups.map(g => g.moving), [false, true]);
  assert(summary.groups.every(g => g.fps === 100 && g.medianWindowP95Ms === 10));
  assert.equal(summary.groups[0].frameP95Ms, undefined);
  assert.equal(summarizePerformance([null, {}, false]).groups.length, 0);
  const p = page(); for (let now = 0; now <= 10_000; now += 2000) p.frame(now);
  const slow = p.reports[0].report; assert.equal(slow.sample.framesOver1000Ms, 5); assert(performanceSample(slow.sample));
  const censored = summarizePerformance([{ at: new Date(0).toISOString(), build: 'a', ...slow }]).groups[0];
  assert.equal(censored.windowsWithCensoredP95, 1); assert.equal(censored.medianWindowP95Ms, null, 'a saturated histogram is not an exact one-second P95');
});

test('offline summaries keep an empty camera out of the rendered workload and expose camera changes', () => {
  const data = report(), row = (sample, i) => ({ at: new Date(i * 1000).toISOString(), build: 'a', device: data.device,
    sample: { ...data.sample, actors: 24, moving: 0, ...sample } });
  const summary = summarizePerformance([
    row({ visible: 24, zoom: 1, frames: 700, fps: 70, frameP50Ms: 15, frameP95Ms: 16, frameMaxMs: 600, stateGapMs: 450 }, 0),
    row({ visible: 0, zoom: 1, frames: 1650, fps: 165, frameP50Ms: 6, frameP95Ms: 8, frameMaxMs: 10, stateGapMs: 60 }, 1),
    row({ visible: 2, zoom: 32, frames: 450, fps: 45, frameP50Ms: 22, frameP95Ms: 24, frameMaxMs: 30, stateGapMs: 80 }, 2),
    row({ mode: 'workshop', visible: 0, moving: 0 }, 3),
  ]);
  const actors = summary.groups.find(g => g.scene === 'actors'), empty = summary.groups.find(g => g.scene === 'empty');
  assert.equal(summary.groups.length, 3);
  assert.equal(actors.windows, 2); assert.equal(actors.fps, 57.5);
  assert.deepEqual(actors.windowZoomRange, [1, 32]); assert.deepEqual(actors.windowVisibleActorsRange, [2, 24]);
  assert.equal(actors.maxFrameMs, 600); assert.equal(actors.maxStateGapMs, 450);
  assert.equal(empty.windows, 1); assert.equal(empty.fps, 165);
  assert.deepEqual(empty.windowVisibleActorsRange, [0, 0]);
  assert.equal(empty.maxFrameMs, 10); assert.equal(empty.maxStateGapMs, 60);
  assert.equal(summary.groups.find(g => g.mode === 'workshop').scene, undefined, 'an editor project is not an empty field');
});
