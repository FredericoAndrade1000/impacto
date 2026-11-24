import test from 'node:test';
import assert from 'node:assert/strict';

import { installFrameGrowth } from '../src/workshop-ux.ts';

import { initNativeDynamics } from '../src/native-dynamics.ts';
import { workshopCanvas } from './helpers/workshop-canvas.js';

await initNativeDynamics();

function fixture({ node = null, edge = { id: 'roof', a: { x: 9, y: 10 }, b: { x: 11, y: 10 }, normal: { x: 0, y: 1 } }, along = null } = {}) {
  const listeners = new Map(), keys = [], calls = { begin: 0, draw: 0, lay: [], commit: 0, cancel: 0, capture: 0, selected: [], toast: [] },
    canvas = { style: {}, addEventListener: (type, fn) => listeners.set(type, fn), focus() {},
      setPointerCapture() { calls.capture++; }, hasPointerCapture: () => true, releasePointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    editor = { blockedEdit: null, pickPoint: () => node, pick: () => edge?.id, source: { plates: [] },
      commit() { calls.commit++; return true; }, begin() { calls.begin++; },
      drawRoom() { calls.draw++; return { length: 2, depth: 1, plates: ['side', 'roof-new', 'front'] }; },
      layPlates(edge, from, to) { calls.lay.push([from, to]); this.source = { plates: [{ id: 'laid-1' }, { id: 'laid-2' }] }; return ['laid-1', 'laid-2']; },
      preview() {}, select(id, options) { calls.selected.push({ id, toggle: options?.toggle }); },
      cancel() { calls.cancel++; } },
    context = { canvas, editor, view: { buildTool: 'select' },
      renderer: { ready: true, camera: { zoom: 40 } }, editing: () => true, alongAt: () => along,
      worldAt: event => ({ x: event.clientX, y: event.clientY }), outlineAt: () => edge,
      attempt: fn => fn(), closeMenus() {}, offered: () => [], paintOffer() {}, offerGrowth() {}, refresh() {},
      showAt() {}, metres: String, toast: message => calls.toast.push(message),
      readout: { toggleAttribute() {}, removeAttribute() {} },
      document: { addEventListener: (type, fn) => { if (type === 'keydown') keys.push(fn); } }, window: { addEventListener() {} },
      state: { growing: null, offer: null, dragging: false, shaping: false, pointer: null } };
  installFrameGrowth({ ...context, effects: context });
  const event = extra => ({ button: 0, shiftKey: true, ctrlKey: false, metaKey: false, pointerId: 7,
    pointerType: 'mouse', clientX: 10, clientY: 10, stopImmediatePropagation() {}, preventDefault() {}, ...extra });
  return { calls, context, send: (type, extra) => listeners.get(type)(event(extra)),
    key: extra => { for (const fn of keys) fn({ target: {}, stopImmediatePropagation() {}, preventDefault() {}, ...extra }); } };
}

for (const pointerType of ['mouse', 'touch']) test(`${pointerType}: a modified drag from a node cannot start another plate`, () => {
  const f = fixture({ node: { id: 'corner' } });
  f.send('pointerdown', { pointerType }); f.send('pointermove', { pointerType, clientY: 40 }); f.send('pointerup', { pointerType });
  assert.equal(f.calls.capture, 0); assert.equal(f.calls.begin, 0); assert.equal(f.calls.draw, 0);
  assert.equal(f.calls.commit, 0); assert.equal(f.context.state.growing, null);
});

for (const pointerType of ['mouse', 'touch']) test(`${pointerType}: a modified drag from an outer face creates one whole compartment`, () => {
  const f = fixture();
  f.send('pointerdown', { pointerType }); f.send('pointermove', { pointerType, clientY: 40 }); f.send('pointerup', { pointerType });
  assert.equal(f.calls.capture, 1); assert.equal(f.calls.begin, 1); assert.equal(f.calls.draw, 1);
  assert.equal(f.calls.selected.at(-1).id, 'roof-new'); assert.equal(f.calls.toast.length, 1);
  assert.match(f.calls.toast[0], /Compartimento criado/); assert.equal(f.context.state.growing, null);
});

// The roof from x 9 to 11 at y 10, as an edge to lay plates on (edge-plates.ts), pressed at x 10.
const roofEdge = () => ({ points: [{ x: 9, y: 10 }, { x: 11, y: 10 }], offsets: [.02], at: 1 });
for (const pointerType of ['mouse', 'touch']) test(`${pointerType}: a modified drag along an edge lays plates on it, one across pulls a room`, () => {
  const along = fixture({ along: roofEdge() });
  along.send('pointerdown', { pointerType }); along.send('pointermove', { pointerType, clientX: 10.04 + 20, clientY: 11 }); along.send('pointerup', { pointerType });
  assert.equal(along.calls.draw, 0); assert.deepEqual(along.calls.lay, [[1, 2]], 'from where it was pressed to the end of the edge, on the grid');
  assert.deepEqual(along.calls.selected.at(-1).id, ['laid-1', 'laid-2']); assert.match(along.calls.toast[0], /2 chapas criadas/);
  const across = fixture({ along: roofEdge() });
  across.send('pointerdown', { pointerType }); across.send('pointermove', { pointerType, clientY: 40 }); across.send('pointerup', { pointerType });
  assert.equal(across.calls.lay.length, 0); assert.equal(across.calls.draw, 1); assert.match(across.calls.toast[0], /Compartimento criado/);
  // On the chassis, with no room to pull, a drag across lays plates all the same.
  const chassis = fixture({ edge: null, along: roofEdge() });
  chassis.send('pointerdown', { pointerType }); chassis.send('pointermove', { pointerType, clientX: 9, clientY: 40 }); chassis.send('pointerup', { pointerType });
  assert.equal(chassis.calls.draw, 0); assert.deepEqual(chassis.calls.lay, [[1, 0]]);
});

for (const pointerType of ['mouse', 'touch']) test(`${pointerType}: from a point on an edge, a modified drag lays plates and a press alone chooses the point`, () => {
  const point = { id: 'corner', key: 'node:corner' };
  const drag = fixture({ node: point, along: roofEdge() });
  drag.send('pointerdown', { pointerType }); drag.send('pointermove', { pointerType, clientX: 9, clientY: 40 }); drag.send('pointerup', { pointerType });
  assert.equal(drag.calls.draw, 0, 'no room is pulled from a point'); assert.deepEqual(drag.calls.lay, [[1, 0]]);
  const press = fixture({ node: point, along: roofEdge() });
  press.send('pointerdown', { pointerType }); press.send('pointerup', { pointerType });
  assert.equal(press.calls.lay.length, 0); assert.deepEqual(press.calls.selected, [{ id: 'node:corner', toggle: true }]);
});

test('empty space and a zero-length edge do not capture a compartment gesture', () => {
  for (const edge of [null, { id: 'point', a: { x: 10, y: 10 }, b: { x: 10, y: 10 }, normal: null }]) {
    const f = fixture({ edge }); f.send('pointerdown'); f.send('pointermove', { clientY: 40 }); f.send('pointerup');
    assert.equal(f.calls.capture, 0); assert.equal(f.calls.draw, 0);
  }
});

test('floors and isolated plates can start the same explicit compartment gesture', () => {
  for (const normal of [{ x: 0, y: -1 }, null]) {
    const f = fixture({ edge: { id: 'edge', a: { x: 9, y: 10 }, b: { x: 11, y: 10 }, normal } });
    f.send('pointerdown'); f.send('pointermove', { clientY: -20 }); f.send('pointerup');
    assert.equal(f.calls.capture, 1); assert.equal(f.calls.begin, 1); assert.equal(f.calls.draw, 1);
    assert.equal(f.calls.selected.at(-1).id, 'roof-new');
  }
});

test('a modified click still toggles selection and cancelling a growth cancels its preview', () => {
  const click = fixture(); click.send('pointerdown'); click.send('pointerup');
  assert.equal(click.calls.draw, 0); assert.equal(click.calls.selected[0].id, 'roof'); assert.equal(click.calls.selected[0].toggle, true);
  const drag = fixture(); drag.send('pointerdown'); drag.send('pointermove', { clientY: 40 }); drag.send('pointercancel');
  assert.equal(drag.calls.cancel, 1); assert.equal(drag.calls.selected.length, 0); assert.equal(drag.context.state.growing, null);
});

test('Esc or C cancels a compartment being pulled, while Ctrl+C and a C typed into a field leave it', () => {
  for (const key of ['Escape', 'c', 'C']) {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientY: 40 });
    f.key({ key }); assert.equal(f.calls.cancel, 1, key); assert.equal(f.context.state.growing, null); assert.equal(f.calls.commit, 1, 'nothing more is committed');
  }
  for (const extra of [{ key: 'c', ctrlKey: true }, { key: 'c', target: { matches: () => true } }, { key: 'x' }]) {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientY: 40 });
    f.key(extra); assert.equal(f.calls.cancel, 0); assert.notEqual(f.context.state.growing, null);
  }
});

for (const end of ['pointerup', 'pointercancel']) test(`a group drag keeps repeated cells quiet, reports refusal and ends through ${end}`, () => {
  const f = workshopCanvas(), before = structuredClone(f.editor.source), selected = [...f.editor.selectionIds],
    pointer = end === 'pointercancel' ? 'touch' : 'mouse';
  // -.14 m and -.13 m both rest on the cell of 5 cm at -.15 m.
  f.begin(); f.move(-.14, 0, pointer);
  const first = f.editor.source;
  assert.deepEqual(f.events, ['preview']); assert.deepEqual(f.calls, { refresh: 0, draftRefresh: 0, save: 0 });
  f.move(-.13, 0, pointer);
  assert.equal(f.editor.source, first); assert.deepEqual(f.events, ['preview']);
  assert.deepEqual(f.calls, { refresh: 0, draftRefresh: 0, save: 0 });
  f.move(-.3, 0, pointer);
  const accepted = structuredClone(f.editor.source), kept = f.editor.source;
  assert.notEqual(kept, first); assert.deepEqual(f.events, ['preview', 'preview']);
  f.move(1.4, 0, pointer);
  assert.equal(f.editor.source, kept); assert(f.editor.blockedEdit.message && f.editor.blockedEdit.polygons.length);
  assert.deepEqual(f.events, ['preview', 'preview', 'feedback']);
  f.move(1.42, 0, pointer);
  assert.equal(f.editor.source, kept); assert.deepEqual(f.events, ['preview', 'preview', 'feedback']);
  assert.deepEqual(f.calls, { refresh: 1, draftRefresh: 1, save: 0 });
  assert.deepEqual(f.refreshed, [kept], 'refusal feedback flushes the latest pending preview without waiting for a frame');
  f.end(end, pointer);
  assert.deepEqual(f.events, ['preview', 'preview', 'feedback', 'document']);
  assert.deepEqual(f.calls, { refresh: 2, draftRefresh: 2, save: 1 });
  assert.equal(f.input.gesture, null); assert.equal(f.captured.size, 0);
  assert.deepEqual([...f.editor.selectionIds], selected);
  assert.deepEqual(f.editor.source, end === 'pointerup' ? accepted : before);
  assert.equal(f.editor.past.length, end === 'pointerup' ? 1 : 0);
  if (end === 'pointerup') { assert(f.editor.undo()); assert.deepEqual(f.editor.source, before); }
});

test('several accepted group previews refresh only their latest source at the next display frame', () => {
  const f = workshopCanvas(), before = structuredClone(f.editor.source), sources = [];
  f.begin();
  for (const dx of [-.14, -.24, -.34]) { f.move(dx); sources.push(f.editor.source); }
  assert.equal(new Set(sources).size, 3, 'three different accepted cells produced three proposals');
  assert.deepEqual(f.events, ['preview', 'preview', 'preview']);
  assert.deepEqual(f.calls, { refresh: 0, draftRefresh: 0, save: 0 });
  assert.deepEqual(f.refreshed, []); assert.equal(f.editor.past.length, 0);
  f.frame();
  assert.deepEqual(f.calls, { refresh: 1, draftRefresh: 1, save: 0 });
  assert.deepEqual(f.refreshed, [sources[2]], 'superseded proposals never reach the panel refresh');
  f.frame();
  assert.deepEqual(f.calls, { refresh: 1, draftRefresh: 1, save: 0 }, 'an empty frame cannot refresh again');
  f.end('pointercancel');
  assert.deepEqual(f.editor.source, before); assert.equal(f.editor.past.length, 0);
  assert.deepEqual(f.saved, [before]);
});

test('a held transaction updates its projection once per changed shape while figures wait, and cancel restores it', () => {
  const f = workshopCanvas(), before = structuredClone(f.editor.source);
  f.begin(); f.move(-.14); f.frame(true);
  assert.equal(f.renderer.blueprint, f.editor.blueprint);
  assert.deepEqual(f.calls, { refresh: 0, draftRefresh: 1, save: 0 });
  f.frame(true); assert.equal(f.calls.draftRefresh, 1, 'the same projection needs no second design update');
  f.move(-.34); f.frame(true);
  assert.equal(f.renderer.blueprint, f.editor.blueprint); assert.equal(f.calls.draftRefresh, 2);
  f.end('pointercancel');
  assert.deepEqual(f.editor.source, before); assert.equal(f.renderer.blueprint, f.editor.blueprint);
  assert.equal(f.calls.refresh, 1); assert.deepEqual(f.saved, [before]);
});

for (const end of ['pointerup', 'pointercancel']) test(`pending group previews publish the final document before another display frame on ${end}`, () => {
  const f = workshopCanvas(), before = structuredClone(f.editor.source), selected = [...f.editor.selectionIds];
  f.begin();
  for (const dx of [-.14, -.24, -.34]) f.move(dx);
  const accepted = structuredClone(f.editor.source);
  assert.deepEqual(f.events, ['preview', 'preview', 'preview']);
  assert.deepEqual(f.calls, { refresh: 0, draftRefresh: 0, save: 0 });
  f.end(end);
  const expected = end === 'pointerup' ? accepted : before;
  assert.deepEqual(f.events, ['preview', 'preview', 'preview', 'document']);
  assert.deepEqual(f.calls, { refresh: 1, draftRefresh: 1, save: 1 }, 'document and normal end UI share one microtask flush');
  assert.deepEqual(f.editor.source, expected); assert.deepEqual(f.saved, [expected]);
  assert.equal(f.refreshed.length, 1); assert.equal(f.refreshed[0], f.editor.source);
  assert.equal(f.editor.past.length, end === 'pointerup' ? 1 : 0);
  assert.deepEqual([...f.editor.selectionIds], selected);
  assert.equal(f.input.gesture, null); assert.equal(f.captured.size, 0);
  f.frame();
  assert.deepEqual(f.calls, { refresh: 1, draftRefresh: 1, save: 1 }, 'the next frame cannot repeat the completed flush');
  if (end === 'pointerup') { assert(f.editor.undo()); assert.deepEqual(f.editor.source, before); }
});

test('a mirrored group drag at125km follows global camera motion without treating board lift as another preview', () => {
  const f = workshopCanvas(), control = workshopCanvas(), before = structuredClone(f.editor.source),
    selected = [...f.editor.selectionIds], camera = f.renderer.camera;
  assert.deepEqual(control.editor.source, before);
  Object.assign(f.boardFrame, { x: 125000.375, y: 7.125, mirror: true });
  camera.x = 125012.375; camera.y = 11.375;
  assert.equal(f.renderer.board.camera.turn, -1);
  f.begin(); control.begin();
  const start = f.input.gesture.start, pointer = camera.toScreen(start.x + .14, start.y);
  f.moveAt(pointer.x, pointer.y); control.move(-.14);
  const first = f.editor.source, localBefore = f.renderer.board.camera.toWorld(pointer.x, pointer.y);
  assert.deepEqual(first, control.editor.source, 'rightward global motion moves the mirrored authored group left');
  assert.deepEqual(f.events, ['preview']);

  f.boardFrame.y += .8;
  assert.notEqual(f.renderer.board.camera.toWorld(pointer.x, pointer.y).y, localBefore.y, 'the board really changed its local pointer projection');
  f.moveAt(pointer.x, pointer.y);
  assert.equal(f.editor.source, first); assert.deepEqual(f.events, ['preview']);

  // Keep the delivered CSS position fixed: this ordinary camera pan really changes its global point by .2m.
  camera.pan(-20, 0);
  f.moveAt(pointer.x, pointer.y); control.move(-.34);
  const moved = f.editor.source;
  assert.notEqual(moved, first); assert.deepEqual(moved, control.editor.source);
  assert.deepEqual(f.events, ['preview', 'preview']);

  // A pixel is a centimetre at this zoom: from -.34 m the group stays on its cell of 5 cm, at -.35 m.
  f.boardFrame.y -= .3;
  f.moveAt(pointer.x - 1, pointer.y);
  assert.equal(f.editor.source, moved, 'another lift and a pointer move within the same global cell do not revise the proposal');
  assert.deepEqual(f.events, ['preview', 'preview']);
  assert.deepEqual(f.calls, { refresh: 0, draftRefresh: 0, save: 0 });
  f.end('pointercancel'); control.end('pointercancel');
  assert.deepEqual(f.editor.source, before); assert.deepEqual(control.editor.source, before);
  assert.deepEqual(f.events, ['preview', 'preview', 'document']);
  assert.deepEqual(f.saved, [before]); assert.deepEqual([...f.editor.selectionIds], selected);
  assert.deepEqual(f.calls, { refresh: 1, draftRefresh: 1, save: 1 });
  assert.equal(f.editor.past.length, 0); assert.equal(f.input.gesture, null); assert.equal(f.captured.size, 0);
});
