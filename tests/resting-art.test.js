import test from 'node:test';
import assert from 'node:assert/strict';
import { RestingArt, ART_INTERVAL } from '../src/resting-art.ts';

// The art painted so far, and a place that asks for the art of a shape as a renderer does: what it is given is
// painted if it is not yet, and the count of paintings is what a drag costs.
function bench() {
  const art = new RestingArt(), painted = new Set();
  let paintings = 0;
  const ask = (place, wanted, now, hold = false) => {
    const key = art.shown(place, wanted, has => painted.has(has), now, hold);
    if (!painted.has(key)) { painted.add(key); paintings++; }
    return key;
  };
  return { art, painted, ask, paintings: () => paintings };
}

test('continuous changes show the latest shape at bounded intervals instead of waiting for the pointer to stop', () => {
  const { ask, paintings } = bench();
  assert.equal(ask('hull', 'a', 0), 'a', 'a place with nothing to show is painted');
  for (let now = 16; now < 1000; now += 16) assert.equal(ask('hull', 'a', now), 'a');
  assert.equal(paintings(), 1);
  // One edit, after a long while with none: it is seen as it is made.
  assert.equal(ask('hull', 'b', 1000), 'b'); assert.equal(paintings(), 2);
  // The pointer never rests: artwork must still catch up, skipping intermediate shapes.
  let shown = 'b', updated = 1000, updates = 0;
  for (let step = 1; step <= 27; step++) {
    const now = 1000 + step * 16, wanted = 'drag-' + step, next = ask('hull', wanted, now);
    if (next !== shown) {
      assert.equal(next, wanted, 'only the latest shape is painted');
      assert(now - updated >= ART_INTERVAL); shown = next; updated = now; updates++;
    }
    assert(now - updated < ART_INTERVAL, 'continuous motion cannot postpone a repaint indefinitely');
  }
  assert(updates > 1 && updates < 27, 'a drag updates periodically without painting every pointer step');
  assert.equal(ask('hull', 'drag-27', updated + ART_INTERVAL - 1), shown);
  assert.equal(ask('hull', 'drag-27', updated + ART_INTERVAL), 'drag-27');
  const finalCount = paintings();
  assert.equal(ask('hull', 'drag-27', updated + ART_INTERVAL * 2), 'drag-27');
  assert.equal(paintings(), finalCount, 'a stationary shape costs no more paintings');
});

test('steps slower than the interval are each painted at once, and a shape gone back to costs nothing', () => {
  const { ask, paintings } = bench();
  ask('gun', 'a', 0);
  for (let step = 1; step <= 5; step++) assert.equal(ask('gun', 'slow-' + step, step * ART_INTERVAL), 'slow-' + step);
  assert.equal(paintings(), 6);
  // Two quick steps and back to the art the place shows: it is the one asked for again, and nothing waits.
  const t = 6 * ART_INTERVAL;
  assert.equal(ask('gun', 'x', t + 300), 'x'); assert.equal(ask('gun', 'y', t + 320), 'x'); assert.equal(ask('gun', 'x', t + 340), 'x');
  assert.equal(ask('gun', 'x', t + 340 + ART_INTERVAL), 'x'); assert.equal(paintings(), 7);
});

test('art painted already is shown at once, each place waits on its own, and a place whose art is gone starts over', () => {
  const { art, painted, ask, paintings } = bench();
  ask('first', 'a', 0); ask('second', 'a', 0); assert.equal(paintings(), 1, 'two guns of one mount share their art');
  ask('first', 'b', 500);
  // The second gun is moved to the mount of the first in the middle of a drag of its own: that art is there.
  assert.equal(ask('second', 'c', 600), 'c'); assert.equal(ask('second', 'd', 620), 'c'); assert.equal(ask('second', 'b', 640), 'b');
  assert.equal(paintings(), 3);
  // While one place waits another is painted at once.
  assert.equal(ask('first', 'e', 1000), 'e'); assert.equal(ask('first', 'f', 1010), 'e'); assert.equal(ask('third', 'g', 1010), 'g');
  // The art a place shows is released, as when its part is out of view: it has nothing to go on with.
  painted.delete('e'); art.forget(key => painted.has(key));
  assert.equal(art.places.has('first'), false); assert.equal(art.places.has('third'), true);
  assert.equal(ask('first', 'f', 1020), 'f');
  // The same of art gone that nobody told the place of.
  painted.delete('g'); assert.equal(ask('third', 'h', 1030), 'h');
});

test('a moved editing gesture holds its hot art through continuous changes and finishes only the latest shape', () => {
  const { ask, paintings } = bench();
  ask('hull', 'start', 0);
  for (let now = 16; now <= 320; now += 16) assert.equal(ask('hull', 'step-' + now, now, true), 'start');
  assert.equal(paintings(), 1, 'a long gesture does not bake its intermediate outlines');
  assert.equal(ask('hull', 'step-320', 336), 'step-320');
  assert.equal(paintings(), 2, 'letting go paints the latest outline once');
  assert.equal(ask('hull', 'step-320', 352), 'step-320');
  ask('other', 'cached', 352);
  assert.equal(ask('hull', 'cached', 368, true), 'cached', 'cached shapes remain immediate during the gesture');
  assert.equal(paintings(), 3);
});

test('ending a short hold preserves the normal art interval, while cold or released art cannot leave a blank', () => {
  const { ask, painted, paintings } = bench();
  ask('hull', 'start', 0);
  assert.equal(ask('hull', 'end', 16, true), 'start');
  assert.equal(ask('hull', 'end', ART_INTERVAL - 1), 'start');
  assert.equal(ask('hull', 'end', ART_INTERVAL), 'end');
  assert.equal(paintings(), 2);
  assert.equal(ask('cold', 'new', 16, true), 'new');
  painted.delete('end');
  assert.equal(ask('hull', 'replacement', ART_INTERVAL + 1, true), 'replacement');
  assert.equal(paintings(), 4);
});
