import test from 'node:test';
import assert from 'node:assert/strict';

// A finger held still on the canvas is shown its hold filling (touch.ts): a ring where the page says, that comes a third
// of the way into the hold, pulses as the hold takes and the device buzzes, and goes when the finger moves on, a second
// finger lands or the finger is lifted first.
let fresh = 0;
async function fingerOn(t, { grabs = () => true, held = () => 'shift', shown = () => ({ x: 120, y: 80 }) } = {}) {
  const saved = { document: globalThis.document, matchMedia: globalThis.matchMedia, PointerEvent: globalThis.PointerEvent,
      navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') },
    listeners = new Map(), made = [], buzzes = [], told = [];
  const element = () => {
    const attributes = new Map(), properties = new Map();
    return { hidden: false, offsetWidth: 68, style: { setProperty: (key, value) => properties.set(key, value), properties },
      setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key), hasAttribute: key => attributes.has(key) };
  };
  globalThis.document = { documentElement: { dataset: {} }, body: { append: node => made.push(node) }, createElement: () => element(),
    addEventListener: (type, listener) => listeners.set(type, [...listeners.get(type) || [], listener]) };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.PointerEvent = class { constructor(type, init) { Object.assign(this, { type, ...init }); } };
  Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 5, vibrate: ms => buzzes.push(ms) }, configurable: true });
  t.after(() => {
    Object.assign(globalThis, { document: saved.document, matchMedia: saved.matchMedia, PointerEvent: saved.PointerEvent });
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator); else delete globalThis.navigator;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const touch = await import('../src/touch.ts?hold-ring=' + (++fresh)), canvas = { dispatchEvent: event => { told.push(event); return true; } };
  touch.initTouch({ canvas, zoom() {}, pan() {}, grabs, held, shown });
  const emit = (type, patch = {}) => {
    const event = { type, pointerType: 'touch', pointerId: 1, target: canvas, clientX: 100, clientY: 70, timeStamp: 0,
      stopImmediatePropagation() {}, preventDefault() {}, ...patch };
    for (const listener of listeners.get(type) || []) listener(event);
  };
  const ring = () => made[0];
  return { ...touch, emit, ring, made, buzzes, told, tick: ms => t.mock.timers.tick(ms) };
}

test('a finger held on a point is shown a ring about it that fills over the hold and pulses as it takes', async t => {
  const f = await fingerOn(t);
  f.emit('pointerdown');
  f.tick(f.HOLD_MS * f.RING_FROM - 1); assert.equal(f.ring(), undefined, 'a tap is over before the ring comes');
  f.tick(1);
  assert.equal(f.ring().className, 'hold-ring'); assert.equal(f.ring().hidden, false);
  assert.deepEqual([f.ring().style.left, f.ring().style.top], ['120px', '80px'], 'about the point the page names');
  assert.equal(f.ring().style.properties.get('--fill'), Math.round(f.HOLD_MS * (1 - f.RING_FROM)) + 'ms', 'full the moment the hold takes');
  f.tick(f.HOLD_MS * (1 - f.RING_FROM));
  assert(f.ring().hasAttribute('data-armed')); assert.deepEqual(f.buzzes, [12]);
  assert.deepEqual(f.told.map(event => [event.type, Boolean(event.shiftKey)]), [['pointercancel', false], ['pointerdown', true]]);
  // The pulse is not cut short by the drag that follows the hold.
  f.emit('pointermove', { clientX: 140, timeStamp: 500 }); assert.equal(f.ring().hidden, false);
  f.tick(f.PULSE_MS); assert.equal(f.ring().hidden, true); assert(!f.ring().hasAttribute('data-armed'));
  assert.equal(f.made.length, 1);
});

test('the ring goes, unarmed, when the finger moves on, a second one lands or it is lifted before the hold', async t => {
  const f = await fingerOn(t);
  f.emit('pointerdown'); f.tick(f.HOLD_MS * f.RING_FROM);
  f.emit('pointermove', { clientX: 100 + f.STILL_PX + 1, timeStamp: 200 });
  assert.equal(f.ring().hidden, true); f.tick(f.HOLD_MS); assert.deepEqual(f.buzzes, []);
  f.emit('pointerup', { clientX: 111, timeStamp: 300 });
  // A second finger: the two are the camera's.
  f.emit('pointerdown', { pointerId: 2, timeStamp: 1000 }); f.tick(f.HOLD_MS * f.RING_FROM); assert.equal(f.ring().hidden, false);
  f.emit('pointerdown', { pointerId: 3, clientX: 300, timeStamp: 1200 }); assert.equal(f.ring().hidden, true);
  f.tick(f.HOLD_MS); assert.deepEqual(f.buzzes, []);
  f.emit('pointerup', { pointerId: 3, timeStamp: 1300 }); f.emit('pointerup', { pointerId: 2, timeStamp: 1300 });
  // Lifted between the ring and the hold.
  f.emit('pointerdown', { pointerId: 4, timeStamp: 2000 }); f.tick(f.HOLD_MS * f.RING_FROM); assert.equal(f.ring().hidden, false);
  f.emit('pointerup', { pointerId: 4, timeStamp: 2300 }); assert.equal(f.ring().hidden, true);
  f.tick(f.HOLD_MS); assert.deepEqual(f.buzzes, []); assert.equal(f.made.length, 1);
});

for (const [why, page, rings, buzzes] of [
  ['where the page shows none, the hold still takes, with no ring', { shown: () => null }, 0, [12]],
  ['where a hold does nothing for the finger, no ring', { held: () => null }, 0, []],
  ['over open ground the hold always does something, and is shown', { grabs: () => false, held: () => null }, 1, [12]],
]) test(why, async t => {
  const f = await fingerOn(t, page);
  f.emit('pointerdown'); f.tick(f.HOLD_MS);
  assert.equal(f.made.length, rings); assert.deepEqual(f.buzzes, buzzes);
  if (rings) assert(f.ring().hasAttribute('data-armed'));
});
