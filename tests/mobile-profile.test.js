import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mobileProfile, MobileFrameBudget } from '../scripts/mobile-profile.ts';
const reference = JSON.parse(readFileSync(new URL('../benchmarks/a15.json', import.meta.url)));

test('the recovered CPU proxy cannot silently qualify as a complete A15 simulation', () => {
  assert.throws(() => mobileProfile(reference), /gpu, transfers/);
  const diagnostic = mobileProfile(reference, { diagnostic: true });
  assert.equal(diagnostic.label, 'desktop-diagnostic'); assert.equal(diagnostic.simulatedDeviceFPS, false);
  assert.deepEqual(diagnostic.missing, ['gpu', 'transfers']);
});

test('relative graphics and upload budgets pace work separately without adding overlapping costs', () => {
  const p = structuredClone(reference); p.gpu.slowdown = 4; p.transfers.bytesPerSecond = 1000000;
  assert.throws(()=>mobileProfile(p),/calibração/);
  p.calibration = { benchmark:p.benchmark,hostSHA256:'a'.repeat(64),referenceSHA256:'b'.repeat(64),inputsSHA256:'c'.repeat(64) };
  const profile = mobileProfile(p), budget = new MobileFrameBudget(profile);
  assert.equal(profile.simulatedDeviceFPS, true);
  assert.equal(budget.spend(100, { gpuMs: 2, uploadBytes: 16000 }).next, 116);
  assert(!budget.ready(115.9)); assert(budget.ready(116));
  assert.equal(budget.spend(116, { gpuMs: 5, uploadBytes: 1000 }).next, 136);
  assert.throws(() => budget.spend(140, { uploadBytes: 1000 }), /GPU/);
  budget.reset(); assert(budget.ready(0)); assert.equal(budget.transferBytes, 0);
});

test('zero, nonfinite and misleading memory calibrations are refused', () => {
  for (const rate of [0, -1, Infinity, NaN]) {
    const profile = structuredClone(reference); profile.gpu.slowdown = rate;
    assert.throws(() => mobileProfile(profile, { diagnostic: true }), /Calibração/);
  }
  assert.throws(() => mobileProfile({ ...reference, transfers: { scope: 'all-ram' } }, { diagnostic: true }), /RAM/);
});
