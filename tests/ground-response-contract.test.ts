import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGroundResponse } from '../src/ground-response-contract.ts';

test('ground replies preserve no-bounce and valid Native response without copying', () => {
  const response = { vx: 80, vy: 12, power: 60, retained: .5, cosine: .1 };
  assert.equal(decodeGroundResponse(null), null);
  assert.equal(decodeGroundResponse(response), response);
});

test('ground replies reject missing, wrong-type and nonfinite scalars', () => {
  const response = { vx: 80, vy: 12, power: 60, retained: .5, cosine: .1 };
  for (const value of [undefined, [], 0, {}, { ...response, vx: '80' },
    { ...response, vy: Infinity }, { ...response, power: NaN },
    { ...response, retained: undefined }, { ...response, cosine: null }]) {
    assert.throws(() => decodeGroundResponse(value), TypeError);
  }
});
