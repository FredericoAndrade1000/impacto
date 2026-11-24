import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDynamicsRows } from '../scripts/review-native-dynamics.ts';

test('parity compares the counts of a frame by value and detects a changed one', () => {
  const row = { name: 'diagnostics', steps: 1, actors: 0, exercise: 'audit', terrain: 'flat',
    finite: true, partsPreserved: true, recoveries: 0, meanMs: 1, p95Ms: 1,
    frames: [{ step: 1, state: { actors: [], plates: [], modules: [], stats: { impacts: 1, penetrations: 1 } } }] };
  const same = structuredClone(row);
  assert.equal(compareDynamicsRows(row, same).pass, true);
  same.frames[0].state.stats.penetrations = 0;
  assert.deepEqual(compareDynamicsRows(row, same).mismatches, ['stats.penetrations']);
  assert.equal(compareDynamicsRows(row, same).pass, false);
});
