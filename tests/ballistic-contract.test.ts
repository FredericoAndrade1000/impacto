import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBallisticReply } from '../src/ballistic-contract.ts';
import type { FlightSolution, FlightState } from '../src/ballistic-contract.ts';

test('Native ballistic replies keep their values and identity while malformed operations fail at the boundary', () => {
  const state: FlightState = { x: 1.2345678901234567, y: 2, vx: -0, vy: 15, time: .25 },
    solution: FlightSolution = { ...state, angle: .5, speed: 300, charge: 1, reachable: true, distance: 100,
      target: { x: 100, y: 2 }, apex: 25, limit: null, miss: 0, flightLimit: 120,
      flight: { model: 'quadratic-drag-v2', mass: 5, caliberMm: 120, family: 'cannon', dragCoefficient: .2, airDensity: 1.225, scaleHeight: 8500 } },
    path = [state, { ...state, time: .5 }];
  const solved: FlightSolution = decodeBallisticReply('solution', solution),
    mounted: FlightSolution = decodeBallisticReply('mounted', solution),
    point: FlightState = decodeBallisticReply('point', state),
    samples: FlightState[] = decodeBallisticReply('path', path);
  assert.equal(solved, solution); assert.equal(mounted, solution); assert.equal(point, state); assert.equal(samples, path);
  assert(Object.is(point.vx, -0));
  for (const value of [null, [], { ...solution, target: { x: 100 } }, { ...solution, limit: 'unknown' },
    { ...solution, flight: { ...solution.flight, model: 'other' } }, { ...solution, flightLimit: Infinity }, { ...solution, reachable: 1 }])
    assert.throws(() => decodeBallisticReply('solution', value), /Invalid Native ballistic reply/);
  for (const value of [{ ...state, time: NaN }, { ...state, x: '1' }, { x: 1, y: 2, time: 0 }])
    assert.throws(() => decodeBallisticReply('point', value), /Invalid Native ballistic reply/);
  for (const value of [[], [state], Array(2), [state, { ...state, vy: null }], Array(514).fill(state)])
    assert.throws(() => decodeBallisticReply('path', value), /Invalid Native ballistic reply/);
});
