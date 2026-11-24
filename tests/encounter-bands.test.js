import test from 'node:test';
import assert from 'node:assert/strict';
import { EncounterBands } from '../src/encounter-bands.ts';

const event = (id, x, approximate = false) => ({ text: 'Aviso.', encounter: { id, x, approximate } });

test('encounters hold for four seconds, fade for eight and expire at twelve', () => {
  const bands = new EncounterBands(); bands.record([event('near', 0)], 10);
  assert.deepEqual(bands.sample(10), [{ id: 'near', x: 0, approximate: false, alpha: 1 }]);
  assert.equal(bands.sample(14)[0].alpha, 1); assert.equal(bands.sample(18)[0].alpha, .5);
  assert.equal(bands.sample(21)[0].alpha, .125); assert.deepEqual(bands.sample(22), []);
  assert.deepEqual(bands.sample(50), []);
});

test('repeat reports do not move, reorder or extend an active encounter', () => {
  const bands = new EncounterBands();
  bands.record(Array.from({ length: 8 }, (_, i) => event('contact:' + i, i)), 0);
  bands.record([event('contact:0', 900, true)], 8);
  assert.deepEqual(bands.sample(8)[0], { id: 'contact:0', x: 0, approximate: false, alpha: .5 });
  bands.record([event('new', -100)], 8);
  assert.deepEqual(bands.sample(8).map(band => band.id), ['contact:1', 'contact:2', 'contact:3', 'contact:4', 'contact:5', 'contact:6', 'contact:7', 'new']);
  assert.deepEqual(bands.sample(12).map(band => band.id), ['new']);
});

test('a genuinely new report can start again once its previous encounter has expired', () => {
  const bands = new EncounterBands(); bands.record([event('again', 5)], 0);
  bands.record([event('again', -5, true)], 12);
  assert.deepEqual(bands.sample(12), [{ id: 'again', x: -5, approximate: true, alpha: 1 }]);
});

test('only the latest eight distinct encounter places survive a large batch', () => {
  const bands = new EncounterBands(); bands.record(Array.from({ length: 100 }, (_, i) => event(String(i), -i)), 1);
  assert.equal(bands.sample(1).length, 8);
  assert.deepEqual(bands.sample(1).map(band => band.id), ['92', '93', '94', '95', '96', '97', '98', '99']);
});

test('invalid metadata and notices without an encounter are ignored, with zero and negative places preserved', () => {
  const bands = new EncounterBands();
  bands.record(null, 0); bands.record(undefined, 0); bands.record({}, 0);
  bands.record([null, undefined, {}, { text: 'Manutenção.', place: 100 }, event('', 0), event('   ', 0), event(1, 0),
    event('bad', NaN), event('bad', Infinity), event('bad', '0'), event('bad', null)], 0);
  assert.deepEqual(bands.sample(0), []);
  bands.record([event('zero', 0), event('negative', -123, true)], 0);
  bands.record([event('time', 23)], NaN); bands.record([event('time', 23)], Infinity);
  assert.deepEqual(bands.sample(0), [{ id: 'zero', x: 0, approximate: false, alpha: 1 }, { id: 'negative', x: -123, approximate: true, alpha: 1 }]);
});

test('sampling reuses the bounded array and entries, with no timers and a complete clear', () => {
  const bands = new EncounterBands(), empty = bands.sample(0);
  assert.equal(bands.sample(1), empty);
  bands.record([event('one', 7)], 1); const frame = bands.sample(1), mark = frame[0];
  for (let time = 1; time <= 10; time += .1) { assert.equal(bands.sample(time), frame); assert.equal(frame[0], mark); }
  bands.clear(); assert.equal(bands.sample(11), empty); assert.deepEqual(frame, []);
  bands.record([event('one', 8)], 12); assert.equal(bands.sample(12)[0].alpha, 1);
});
