import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { miningRun } from './helpers/mining-mobility.js';

// Iron ore is the heaviest solid at 2400 kg/m³. Exercise the other two full
// loads too; every load enters native component mass through setPartState.
for (const [surface, grade] of [['soil', .5], ['rock', .5], ['sand', .3], ['mud', .3]])
  test(`the starter miner restarts on ${grade * 100}% ${surface}, empty and with each full ore, both directions`, () => {
    // What the lorry weighs empty, to see each full load on top of it (it is some 9.7 t).
    let empty;
    for (const direction of [-1, 1]) for (const cargo of [null, 'ferro', 'ligas', 'silica']) {
      const result = miningRun(createStructuredTemplate('mining-truck'), { surface, grade, direction, cargo, seconds: 24, distance: 30 });
      if (!cargo) empty = result.massKg;
      assert(result.startingSpeed < .05, 'the climb starts at rest instead of borrowing run-up');
      assert(result.progressM >= 30, `${surface}/${direction}/${cargo || 'empty'} only traversed ${result.progressM} m`);
      assert(result.minHealthFraction > .99, 'ordinary driving leaves the equipment intact');
      assert(Math.abs(result.powerKw - 180) < 1e-9);
      if (cargo) assert(result.cargoKg > 2000 && Math.abs(result.massKg - empty - result.cargoKg) < 1, 'the full hopper is real carried mass');
    }
  });

for (const [terrain, x, direction] of [['highlands', 2308, -1], ['plateau', 3168, -1]])
  test(`the fully loaded initial miner restarts on the real ${terrain} maximum slope`, () => {
    const result = miningRun(createStructuredTemplate('mining-truck'), { terrain, x, direction, cargo: 'ferro', seed: 6173, seconds: 24, distance: 25 });
    assert(result.passed, JSON.stringify({ terrain, progressM: result.progressM, seconds: result.seconds, speedAtStart: result.startingSpeed, health: result.minHealthFraction }));
    assert(result.samples.some(sample => Math.abs(sample.slope) > .35), 'the route includes the native mountain grade');
  });
