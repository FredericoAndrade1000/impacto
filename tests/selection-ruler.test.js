import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.ts';
import { selectionRuler } from '../src/selection-ruler.ts';
import { initSquadUX } from '../src/squad-ux.ts';

const camera = (zoom = 10) => { const view = new Camera(667, 375); view.x = view.y = 0; view.zoom = zoom; return view; };
const point = (view, sx, sy) => ({ sx, sy, ...view.toWorld(sx, sy) });

test('the ruler measures world width × height in either direction and formats kilometres in Portuguese', () => {
  const view = camera(.1), start = point(view, 100, 50);
  assert.equal(selectionRuler(view, start, { sx: 220, sy: 350 }).text, '1,2 km × 3 km');
  assert.equal(selectionRuler(view, point(view, 220, 350), { sx: 100, sy: 50 }).text, '1,2 km × 3 km');
  assert.equal(selectionRuler(view, start, { sx: 100, sy: 350 }).text, '0 m × 3 km');
  view.zoom = 10;
  assert.equal(selectionRuler(view, point(view, 100, 100), { sx: 240, sy: 100 }).text, '14 m × 0 m');
  assert.equal(selectionRuler(view, point(view, 100, 100), { sx: 300, sy: 300 }).text, '20 m × 20 m');
});

test('zoom keeps the first world point anchored while the current pointer defines the other end', () => {
  const view = camera(), start = point(view, 100, 90), pointer = { sx: 500, sy: 200 }, before = structuredClone(start);
  assert.equal(selectionRuler(view, start, pointer).text, '40 m × 11 m');
  view.zoom = 20;
  const reading = selectionRuler(view, start, pointer);
  assert.equal(reading.text, '32 m × 10 m');
  assert.deepEqual(reading.end, view.toWorld(500, 200));
  assert.equal(reading.box.left, 0, 'the original world point can leave the viewport without an oversized overlay');
  assert.equal(reading.box.width, 500);
  assert.deepEqual(start, before);
});

test('the rectangle and its fixed-size label remain inside a short landscape viewport', () => {
  const view = camera(), start = point(view, 330, 180);
  for (const [sx, sy] of [[0, 0], [667, 0], [0, 375], [667, 375], [-300, -200], [1000, 600]]) {
    const { box, label } = selectionRuler(view, start, { sx, sy });
    assert(box.left >= 0 && box.left + box.width <= view.width);
    assert(box.top >= 0 && box.top + box.height <= view.height);
    assert(label.left - 88 >= 8 && label.left + 88 <= view.width - 8);
    assert(label.top - 28 >= 8 && label.top <= view.height - 8);
  }
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.hidden = false; this.textContent = ''; }
  get firstChild() { return this.children[0]; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function fixture(t) {
  const previous = { document: globalThis.document, window: globalThis.window, observer: globalThis.ResizeObserver, frame: globalThis.requestAnimationFrame },
    viewport = new Element('div'), sidebar = new Element('aside'), panel = new Element('div'), canvas = new Element('canvas'), captures = new Set(), documentEvents = new Map();
  globalThis.document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    querySelector: selector => ({ '#viewport': viewport, '.sidebar': sidebar, '#field-pawns': panel })[selector], querySelectorAll: () => [],
    addEventListener: (type, listener) => { documentEvents.set(type, listener); } };
  globalThis.window = { addEventListener() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = () => { throw new Error('The ruler must use the existing frame, without a new timer'); };
  t.after(() => { globalThis.document = previous.document; globalThis.window = previous.window; globalThis.ResizeObserver = previous.observer; globalThis.requestAnimationFrame = previous.frame; });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }); canvas.focus = () => {};
  canvas.setPointerCapture = id => captures.add(id); canvas.hasPointerCapture = id => captures.has(id); canvas.releasePointerCapture = id => captures.delete(id);
  const view = camera(), actors = [0, 14].map((x, i) => ({ id: 'v' + i, ownerId: 'p', team: 'f', vehicle: { x, y: 0 } })),
    state = { shared: true, actors, squad: { units: actors.map(actor => ({ id: actor.id })), out: [], manual: null },
      localPlayerId: 'p', faction: { id: 'f', deposits: [] }, modules: [], plates: [] },
    renderer = { state, canvas, camera: view, scene: null, markHeight: () => 0, ground: { length: 20000, center: 0, features: [] } },
    mode = { mode: 'test' }, commands = [], ux = initSquadUX({ renderer, view: mode, command: (...args) => { commands.push(args); return Promise.resolve(); },
      refresh() {}, toast() {}, alert() {}, stopControls() {}, sendAim() {} }),
    box = viewport.children.find(child => child.className === 'squad-box'), ruler = viewport.children.find(child => child.className === 'squad-ruler');
  const event = (type, x, y, patch = {}) => {
    const sent = { type, target: canvas, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerType: 'mouse', pointerId: 1, stopPropagation() { this.stopped = true; }, preventDefault() {}, ...patch };
    for (const listener of viewport.listeners.get(type) || []) listener(sent);
    return sent;
  };
  return { view, ux, box, ruler, captures, commands, event, documentEvents, mode };
}

test('selection drag reuses the ruler through zoom, then selects the same world rectangle without a network order', t => {
  const { view, ux, box, ruler, captures, commands, event } = fixture(t), original = ruler;
  event('pointerdown', 100, 90); assert.equal(ruler.hidden, true);
  event('pointermove', 102, 91); assert.equal(ruler.hidden, true, 'a click does not flash a measurement');
  event('pointermove', 500, 200); assert.equal(ruler.hidden, false); assert.equal(ruler.textContent, '40 m × 11 m');
  view.zoom = 20; ux.follow();
  assert.equal(ruler, original); assert.equal(ruler.textContent, '32 m × 10 m'); assert.equal(box.style.left, '0px');
  event('pointerup', 500, 200);
  assert.equal(box.hidden, true); assert.equal(ruler.hidden, true); assert.equal(captures.size, 0);
  assert.deepEqual(ux.picked(), ['v0']); assert.deepEqual(commands, []);
});

test('additive selection, touch cancel and shift-camera drags keep their existing meaning', t => {
  const { ux, box, ruler, captures, commands, event } = fixture(t);
  ux.pick('v0'); ux.choice();
  event('pointerdown', 425, 100, { ctrlKey: true }); event('pointermove', 525, 290); assert.equal(ruler.textContent, '10 m × 19 m');
  event('pointerup', 525, 290); assert.deepEqual(ux.picked(), ['v0', 'v1']);
  event('pointerdown', 100, 90, { pointerType: 'touch' }); event('pointermove', 500, 200, { pointerType: 'touch' });
  assert.equal(ruler.hidden, false); event('pointercancel', 500, 200, { pointerType: 'touch', button: -1 });
  assert.equal(box.hidden, true); assert.equal(ruler.hidden, true); assert.equal(captures.size, 0); assert.deepEqual(ux.picked(), ['v0', 'v1']);
  const pan = event('pointerdown', 100, 90, { shiftKey: true }); event('pointermove', 500, 200); ux.follow();
  assert.equal(pan.stopped, undefined); assert.equal(ruler.hidden, true); assert.deepEqual(commands, []);
});

test('an armed touch gesture never measures and retains its existing tap-to-order behaviour', t => {
  const { ux, ruler, commands, event, documentEvents } = fixture(t);
  ux.pick('v0'); ux.choice();
  ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'move' }], refused: {} });
  documentEvents.get('keydown')({ key: 'm', target: {}, preventDefault() {}, stopPropagation() {} });
  event('pointerdown', 100, 90, { pointerType: 'touch' }); event('pointermove', 500, 200, { pointerType: 'touch' });
  assert.equal(ruler.hidden, true); event('pointercancel', 500, 200, { pointerType: 'touch', button: -1 }); assert.deepEqual(commands, []);
  event('pointerdown', 500, 200, { pointerType: 'touch' }); event('pointerup', 500, 200, { pointerType: 'touch' });
  assert.equal(ruler.hidden, true); assert.equal(commands.length, 1); assert.equal(commands[0][1].order, 'move');
});
