import test from 'node:test';
import assert from 'node:assert/strict';

import { initNativeDynamics } from '../src/native-dynamics.ts';
import { workshopCanvas } from './helpers/workshop-canvas.js';
import { componentPolygon } from '../src/assembly.ts';

await initNativeDynamics();

test('a short plate middle keeps the explicitly selected point group when its grips overlap', () => {
  const f = workshopCanvas(), added = f.editor.addPlate({ x: 13, y: 5 }, { x: 13.1, y: 5 }),
    plate = f.editor.source.plates.find(plate => plate.id === added.id), ids = ['node:' + plate.a, 'node:' + plate.b];
  f.editor.select(ids);
  const before = structuredClone(f.editor.source), history = f.editor.past.length,
    at = f.renderer.board.camera.toScreen(13.05, 5);
  f.downAt(at.x, at.y); assert.equal(f.input.gesture.type, 'move');
  f.move(.3, .2); f.end();
  assert.deepEqual([...f.editor.selectionIds], ids);
  assert.equal(f.editor.past.length, history + 1);
  f.editor.undo(); assert.deepEqual(f.editor.source, before);
});

test('dragging a whole connected plate through the canvas keeps both joints and one saved edit', () => {
  const f = workshopCanvas(), left = f.editor.addPlate({ x: 13, y: 5 }, { x: 14, y: 5 }),
    middle = f.editor.addPlate({ x: 14, y: 5 }, { x: 14, y: 6 }),
    right = f.editor.addPlate({ x: 14, y: 6 }, { x: 15, y: 6 });
  f.editor.select([]); f.editor.snap = false;
  const before = structuredClone(f.editor.source), history = f.editor.past.length, saves = f.calls.save,
    plate = id => before.plates.find(part => part.id === id), selected = plate(middle.id),
    movedEnds = new Set([selected.a, selected.b]),
    length = f.editor.plateSpans().find(part => part.id === middle.id).length,
    from = f.renderer.board.camera.toScreen(14, 5.5), to = f.renderer.board.camera.toScreen(14.137, 5.683);
  assert.equal(plate(left.id).b, selected.a); assert.equal(plate(right.id).a, selected.b);
  f.downAt(from.x, from.y); assert.equal(f.input.gesture.type, 'edge', 'the actual whole-plate gesture is exercised');
  f.moveAt(to.x, to.y); f.upAt(to.x, to.y);
  for (const node of before.nodes) {
    const current = f.editor.source.nodes.find(other => other.id === node.id), moving = movedEnds.has(node.id);
    assert(Math.abs(current.x - node.x - (moving ? .137 / .05 : 0)) < 1e-8, node.id + '.x');
    assert(Math.abs(current.y - node.y - (moving ? .183 / .05 : 0)) < 1e-8, node.id + '.y');
  }
  assert.deepEqual(f.editor.source.plates, before.plates, 'no endpoint IDs were detached or welded');
  assert.equal(f.editor.source.nodes.length, before.nodes.length);
  assert.deepEqual(f.editor.source.components, before.components);
  assert.deepEqual(f.editor.source.chassis, before.chassis);
  assert(Math.abs(f.editor.plateSpans().find(part => part.id === middle.id).length - length) < 1e-9);
  assert.equal(f.editor.past.length, history + 1); assert.equal(f.calls.save, saves + 1);
  const moved = structuredClone(f.editor.source);
  assert(f.editor.undo()); assert.deepEqual(f.editor.source, before);
  assert(f.editor.redo()); assert.deepEqual(f.editor.source, moved);
});

test('canvas selections and drag release preserve the camera instead of automatically revealing the selection', () => {
  const f = workshopCanvas(), first = f.editor.addPlate({ x: 13, y: 5 }, { x: 14, y: 5 });
  f.editor.addPlate({ x: 15, y: 5 }, { x: 16, y: 5 }); f.editor.select(first.id);
  const at = f.renderer.board.camera.toScreen(15.5, 5);
  const framing = () => ({ ...f.renderer.camera.asked });
  for (const key of ['shiftKey', 'ctrlKey', 'metaKey']) {
    const before = framing();
    f.downAt(at.x, at.y, 'mouse', { [key]: true });
    assert.equal(f.input.gesture, null); assert.deepEqual(framing(), before);
    f.upAt(at.x, at.y);
  }
  const before = framing();
  f.downAt(at.x, at.y); assert.equal(f.input.gesture.type, 'move'); f.end('pointercancel');
  assert.deepEqual(framing(), before, 'a cancelled drag preserves the camera');
  f.input.spacePan = true;
  f.downAt(at.x, at.y, 'mouse', { shiftKey: true }); assert.equal(f.input.gesture.type, 'pan'); f.upAt(at.x, at.y);
  assert.deepEqual(framing(), before, 'Space without a drag preserves the camera');
  f.input.spacePan = false; f.view.mode = 'test';
  f.downAt(at.x, at.y, 'mouse', { shiftKey: true }); assert.equal(f.input.gesture.type, 'pan'); f.upAt(at.x, at.y);
  assert.deepEqual(framing(), before, 'the field Shift pan without a drag preserves the camera');
});

for (const pointer of ['mouse', 'touch']) for (const end of ['pointerup', 'pointercancel'])
test(`${pointer}: dropping an endpoint onto another joins it in the drag edit; ${end} preserves history`, () => {
  const f = workshopCanvas(), first = f.editor.addPlate({x:13,y:5},{x:14,y:5}), second = f.editor.addPlate({x:15,y:5},{x:15,y:6});
  f.editor.select([]);
  const before = structuredClone(f.editor.source), history = f.editor.past.length,
    plate = id => f.editor.source.plates.find(p => p.id === id),
    from = f.renderer.board.camera.toScreen(14,5), to = f.renderer.board.camera.toScreen(15,5);
  f.downAt(from.x,from.y,pointer);assert.equal(f.input.gesture.type,'hull');
  f.moveAt(to.x,to.y,pointer);
  assert.notEqual(plate(first.id).b,plate(second.id).a,'the preview does not weld before release');
  if (end === 'pointercancel') f.end('pointercancel',pointer); else f.upAt(to.x,to.y,pointer);
  if (end === 'pointercancel') {
    assert.deepEqual(f.editor.source,before);assert.equal(f.editor.past.length,history);
  } else {
    assert.equal(plate(first.id).b,plate(second.id).a);
    assert.equal(f.editor.past.length,history+1,'drag and join share one undo step');
    f.editor.undo();assert.deepEqual(f.editor.source,before);
  }
});

for (const pointer of ['mouse', 'touch']) test(`an isolated plate is drawn below the local reference, down to the floor and no further, in one undoable ${pointer} drag`, () => {
  const f = workshopCanvas(), before = structuredClone(f.editor.source), history = f.editor.past.length;
  f.view.buildTool = 'plate';
  const start = f.renderer.board.camera.toScreen(8, .5), end = f.renderer.board.camera.toScreen(7, -.8);
  f.downAt(start.x, start.y, pointer); f.moveAt(end.x, end.y, pointer);
  assert.equal(f.renderer.platePreview.b.y, 0, 'held on the floor of the workshop');
  f.upAt(end.x, end.y, pointer);
  assert.equal(f.editor.source.plates.length, before.plates.length + 1);
  const drawn = f.editor.source.plates.at(-1), heights = [drawn.a, drawn.b].map(id => f.editor.source.nodes.find(node => node.id === id).y);
  assert.deepEqual(heights, [-16, -26], 'in cells from the reference (grid.ts)');
  assert.deepEqual(f.editor.source.components, before.components);
  assert.deepEqual(f.editor.source.chassis, before.chassis);
  for (const plate of before.plates) assert.deepEqual(f.editor.source.plates.find(p => p.id === plate.id), plate);
  assert.equal(f.editor.past.length, history + 1); assert.equal(f.renderer.platePreview, null);
  assert.equal(f.view.buildTool, 'select');
  f.editor.undo(); assert.deepEqual(f.editor.source, before);
});

test('a plate-only copy has a visible cursor preview and is placed as one explicit edit', () => {
  const f = workshopCanvas();
  f.editor.addPlate({ x: 16, y: 3 }, { x: 17, y: 3 });
  const before = structuredClone(f.editor.source), history = f.editor.past.length, intent = f.editor.duplicate();
  assert.equal(intent.copies.length, 0); assert.equal(intent.plates.length, 1);
  f.view.buildTool = 'module'; f.view.placement = intent;
  const target = f.renderer.board.camera.toScreen(16, 4);
  f.moveAt(target.x, target.y);
  const preview = f.renderer.modulePreview;
  assert.equal(preview.modules.length, 0); assert.equal(preview.plates.length, 1);
  assert(Number.isFinite(preview.x) && Number.isFinite(preview.y)); assert(!preview.refused);
  f.downAt(target.x, target.y);
  assert.equal(f.editor.source.plates.length, before.plates.length + 1);
  assert.equal(f.editor.past.length, history + 1);
  f.editor.undo(); assert.deepEqual(f.editor.source, before);
});

test('normal canvas installation and dragging use the same nearby face assistance with a pixel reach', () => {
  const f = workshopCanvas(), plate = f.editor.addPlate({ x: 16, y: 4 }, { x: 18, y: 4 }),
    top = plate.y + plate.thicknessMm / 2000, options = { sizeScale: .25, angle: .37 },
    sample = f.editor.planModule('fuel', { x: 17, y: 5 }, options).module,
    height = sample.y - Math.min(...componentPolygon(sample).map(point => point.y)),
    y = Math.ceil((top + height + .015) * 20) / 20, target = f.renderer.board.camera.toScreen(17, y);
  f.view.buildTool = 'module'; f.view.placement = { kind: 'fuel', ...options };
  f.moveAt(target.x, target.y);
  const preview = f.renderer.modulePreview.modules[0], before = structuredClone(f.editor.source), history = f.editor.past.length;
  assert(Math.abs(Math.min(...componentPolygon(preview).map(point => point.y)) - top) < 1e-8);
  f.downAt(target.x, target.y); f.upAt(target.x, target.y);
  assert.equal(f.editor.past.length, history + 1); assert.equal(f.editor.selected.y, preview.y);
  f.editor.undo(); assert.deepEqual(f.editor.source, before);

  // At this zoom the same physical gap is more than fourteen pixels: normal
  // placement stays free, rather than broadening the snap to a distant face.
  f.renderer.camera.zoom = 800;
  f.view.buildTool = 'module'; f.view.placement = { kind: 'fuel', ...options };
  const close = f.renderer.board.camera.toScreen(17, y);
  f.moveAt(close.x, close.y); assert(Math.abs(f.renderer.modulePreview.modules[0].y - y) < 1e-10);
  f.downAt(close.x, close.y); f.upAt(close.x, close.y);
  const installed = f.editor.selected, original = structuredClone(f.editor.source);
  f.renderer.camera.zoom = 100; f.begin(); f.move(.1, 0); f.end();
  assert(Math.abs(Math.min(...componentPolygon(f.editor.selected).map(point => point.y)) - top) < 1e-8);
  assert(Math.abs(f.editor.selected.x - installed.x - .1) < 1e-8);
  f.editor.undo(); assert.deepEqual(f.editor.source, original);
});
