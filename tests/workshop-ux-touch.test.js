import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { OFFERED_DEPTH } from '../src/frame-editing.ts';
import { createCompartmentFromPlate } from '../src/workshop-ux.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

test('the selected plate creates a partial closed room with one undoable touch action', () => {
  const editor = new Editor(createStructuredConstruction({ length: 6, height: 1.6, thicknessMm: 10, frontInset: 0, rearInset: 0 })),
    before = structuredClone(editor.source), oldRoof = editor.plateSpans().find(plate => plate.id === 'hull:roof');
  editor.select(oldRoof.id);

  const room = createCompartmentFromPlate(editor, editor.selection);

  assert(room);
  assert.equal(room.depth, OFFERED_DEPTH);
  assert(room.length <= 1.8 + 1e-9 && room.length < oldRoof.length);
  assert.equal(editor.blueprint.rooms.length, 2);
  assert.equal(editor.selection, room.plates[1], 'the new outer plate is ready to drag to another depth');
  assert.equal(editor.past.length, 1);
  editor.undo();
  assert.deepEqual(editor.source, before);
});

test('the complete extractor copies at the cursor without selecting an automatic surface', () => {
  for (const kind of ['excavator', 'drill']) {
    const editor = new Editor(createStructuredConstruction());
    const placed = editor.addModule(kind, { x: 12, y: 3.5 }, { sizeScale: .5 });
    editor.select(placed.id); const intent = editor.duplicate();
    const copy = editor.addModule(intent.kind, { x: 13.4, y: 3.5 }, intent),
      authored = editor.source.components.find(part => part.id === copy.id);
    assert(Math.abs(copy.x - 13.4) < 1e-8 && Math.abs(copy.y - 3.5) < 1e-8);
    assert(authored.pose && !('placement' in authored));
    assert.equal(editor.blueprint.modules.filter(part => part.kind === kind).length, 2);
    editor.undo(); assert.equal(editor.blueprint.modules.filter(part => part.kind === kind).length, 1);
  }
});

test('a plate facing down creates a compartment below it in one undoable action', () => {
  const editor = new Editor(createStructuredConstruction({ preset: 'bunker' })), before = structuredClone(editor.source);

  const floor = editor.plateSpans().find(plate => plate.id === 'hull:floor'),
    room = createCompartmentFromPlate(editor, 'hull:floor');
  assert(room && room.depth === OFFERED_DEPTH);
  assert.equal(editor.blueprint.rooms.length, 2);
  assert(editor.plateSpans().filter(plate => room.plates.includes(plate.id)).some(plate => plate.a.y < floor.a.y));
  assert.deepEqual(editor.source.components, before.components);
  assert.equal(editor.past.length, 1); editor.undo(); assert.deepEqual(editor.source, before);
});
