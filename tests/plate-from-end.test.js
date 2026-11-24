import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { REACH_CELLS } from '../src/frame-editing.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

// The hull of the default construction, written in cells of 5 cm (grid.ts): its front from hull-0 (−54, −5) up to
// hull-3 (−44, 27), its roof on to hull-2 (52, 27) and its rear down to hull-1 (54, −5).
const hull = () => new Editor(createStructuredConstruction());
// A place of the design, so many cells from its reference, in the field.
const field = (editor, x, y) => { const origin = editor.blueprint.frame.origin; return { x: origin.x + x * .05, y: origin.y + y * .05 }; };
const end = (editor, x, y) => editor.pickNode(field(editor, x, y), .01, { nearest: true });
const plateOf = (source, id) => source.plates.find(plate => plate.id === id);
const nodeOf = (source, id) => source.nodes.find(node => node.id === id);
// The same hull made short, its rear brought forward to run from hull-1 (−4, −5) up to hull-2 (−6, 27): a plate from a
// corner to the corner across meets the walls there wide enough apart for plates of 40 mm (`Frame::meet` in the core),
// which across the long hull it would not.
const short = () => {
  const source = createStructuredConstruction();
  nodeOf(source, 'hull-1').x = -4; nodeOf(source, 'hull-2').x = -6;
  return new Editor(source);
};
// A plate drawn as a Shift drag from an end draws it, in one step of history.
function draw(editor, hit, to, reach = 0) {
  editor.begin(); const ids = editor.drawPlate(hit, to, reach); editor.commit(); return ids;
}

test('Shift dragged from an end of plates draws a plate from that very node, on the cell of the pointer, in one step', () => {
  const editor = hull();
  editor.change(source => {
    plateOf(source, 'hull:front').thicknessMm = 50; plateOf(source, 'hull:front').material = 'aluminum';
    plateOf(source, 'hull:roof').thicknessMm = 25;
  });
  const before = structuredClone(editor.source), history = editor.past.length, corner = end(editor, -44, 27);
  assert.equal(corner.id, 'hull-3');
  // Previewed while dragged: the plate follows the pointer, from the same document.
  editor.begin();
  assert.deepEqual(editor.drawPlate(corner, field(editor, -30.4, 39.6)), ['plate-2']);
  assert.equal(nodeOf(editor.source, plateOf(editor.source, 'plate-2').b).x, -30);
  const [id] = editor.drawPlate(corner, field(editor, -44.3, 40.2));
  editor.commit();
  const source = editor.source, plate = plateOf(source, id), far = nodeOf(source, plate.b);
  assert.equal(plate.a, 'hull-3', 'it starts on the node pressed, joined to the plates there');
  assert.deepEqual({ x: far.x, y: far.y }, { x: -44, y: 40 }, 'it ends on the whole cell under the pointer');
  assert.deepEqual({ material: plate.material, thicknessMm: plate.thicknessMm }, { material: 'aluminum', thicknessMm: 50 },
    'in the armour of the thickest plate ending there');
  assert.equal(source.plates.length, before.plates.length + 1); assert.equal(source.nodes.length, before.nodes.length + 1);
  assert.equal(editor.past.length, history + 1);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
});

test('the plate ends on an end of plates near the pointer, and in the construction box; a pull too short draws nothing', () => {
  const editor = short(), corner = end(editor, -44, 27), before = structuredClone(editor.source);
  // Let go near the rear bottom corner, it ends on it: a plate across the hull, joined at both ends.
  const [id] = draw(editor, corner, field(editor, -3.2, -4.1), .1);
  assert.deepEqual([plateOf(editor.source, id).a, plateOf(editor.source, id).b], ['hull-3', 'hull-1']);
  assert.equal(editor.source.nodes.length, before.nodes.length);
  assert(editor.undo());
  // Dragged far past the front, it stops at the limit of the construction.
  const [out] = draw(editor, corner, field(editor, -300, 27));
  assert.equal(nodeOf(editor.source, plateOf(editor.source, out).b).x, REACH_CELLS.minX);
  assert(editor.undo());
  // A cell from the node is no plate: nothing is drawn, nothing refused, nothing kept.
  editor.begin(); assert.equal(editor.drawPlate(corner, field(editor, -44, 28)), null);
  assert.equal(editor.blockedEdit, null); editor.commit();
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
});

test('a plate the compiler refuses is shown where it would be and not made', () => {
  const editor = hull(), corner = end(editor, -44, 27), before = structuredClone(editor.source);
  // Onto the other end of the front: the plate is there already.
  editor.begin(); assert.equal(editor.drawPlate(corner, field(editor, -54, -5), .1), null);
  assert.match(editor.blockedEdit.message, /Já existe uma chapa entre esses pontos/);
  assert.equal(editor.blockedEdit.polygons.length, 1);
  // Over the roof, a stretch away from the corner: the plates would stand in one place.
  assert.equal(editor.drawPlate(corner, field(editor, -40, 27)), null);
  assert.match(editor.blockedEdit.message, /ocupariam o mesmo lugar/);
  // Nearly along the roof: the two would run into each other at the corner they share.
  assert.equal(editor.drawPlate(corner, field(editor, -20, 28)), null);
  assert.match(editor.blockedEdit.message, /Abra mais o ângulo/);
  editor.commit();
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
});

test('in symmetric editing the plate stops at the axis and is drawn across it too, the two meeting there', () => {
  const editor = hull();
  editor.change(source => { nodeOf(source, 'hull-2').x = 44; });
  editor.symmetric = true;
  const corner = end(editor, -44, 27), plates = editor.source.plates.length;
  // Up and past the axis: the line to the pointer stops where it meets the axis, on a whole cell.
  const [id] = draw(editor, corner, field(editor, 20, 91)), source = editor.source, plate = plateOf(source, id),
    ridge = nodeOf(source, plate.b), across = source.plates.at(-1);
  assert.equal(source.plates.length, plates + 2);
  assert.equal(plate.a, 'hull-3'); assert.deepEqual({ x: ridge.x, y: ridge.y }, { x: 0, y: 71 });
  assert.deepEqual([across.a, across.b].toSorted(), ['hull-2', ridge.id].toSorted(), 'the one across starts on the end across and meets this one on the axis');
  assert.deepEqual({ material: across.material, thicknessMm: across.thicknessMm }, { material: plate.material, thicknessMm: plate.thicknessMm });
  assert.equal(editor.past.length, 2); assert(editor.undo()); assert.equal(editor.source.plates.length, plates);
});

test('from an end of plates, a drag any way draws from that very end, never on a plate of it nor nearly along one', () => {
  const editor = hull(), corner = end(editor, -44, 27);
  // Down and away from the front, which runs from this corner to (−54, −5): a plate from the corner, on the cell.
  const [id] = draw(editor, corner, field(editor, -30.2, 4.9), .1), plate = plateOf(editor.source, id), far = nodeOf(editor.source, plate.b);
  assert.equal(plate.a, 'hull-3'); assert.deepEqual({ x: far.x, y: far.y }, { x: -30, y: 5 });
  assert(editor.undo());
  // Down beside the front, even let go within reach of it: the end does not rest on the front, and the two would run
  // into each other at the corner they share.
  editor.begin();
  for (const x of [-52.2, -50.6]) {
    assert.equal(editor.drawPlate(corner, field(editor, x, 5), .1), null); assert.match(editor.blockedEdit.message, /Abra mais o ângulo/);
    assert.deepEqual(editor.meets, []);
  }
  // Along the front to its other end, it would be the front again.
  assert.equal(editor.drawPlate(corner, field(editor, -53.8, -4.6), .1), null);
  assert.match(editor.blockedEdit.message, /Já existe uma chapa entre esses pontos/);
  editor.cancel();
});

test('the end of the plate rests where an end let go there would, and what it meets is told to be lit', () => {
  const editor = short(), corner = end(editor, -44, 27), nodes = editor.source.nodes.length, plates = editor.source.plates.length;
  // Near the rear bottom corner: on it, joined.
  editor.begin(); editor.drawPlate(corner, field(editor, -4.8, -4.1), .1);
  const { x, y } = field(editor, -4, -5);
  assert.equal(editor.meets.length, 1);
  assert(Math.abs(editor.meets[0].x - x) < 1e-9 && Math.abs(editor.meets[0].y - y) < 1e-9, 'the end it joins');
  editor.cancel();
  // Near the rear, not near its ends: on the rear itself, exactly, which is divided there (a T), at the very end.
  editor.begin(); editor.drawPlate(corner, field(editor, -4.6, -2), .1);
  const lit = editor.meets; editor.commit();
  const id = editor.source.plates.find(plate => plate.a === 'hull-3' && !['hull:front', 'hull:roof'].includes(plate.id)).id,
    far = nodeOf(editor.source, plateOf(editor.source, id).b), a = nodeOf(editor.source, 'hull-1'), b = nodeOf(editor.source, 'hull-2');
  assert(Math.abs((far.x - a.x) * (b.y - a.y) - (far.y - a.y) * (b.x - a.x)) < 1e-9, 'on the line of the rear');
  assert(!Number.isInteger(far.x), 'not rounded off it to a cell');
  assert.equal(editor.source.nodes.length, nodes + 1);
  assert.equal(editor.source.plates.length, plates + 2, 'the new plate and the rest of the rear');
  assert.deepEqual([plateOf(editor.source, 'hull:rear').b, editor.source.plates.find(plate => plate.a === far.id && plate.id !== id).b].toSorted(),
    [far.id, 'hull-2'].toSorted(), 'the rear runs to the end, and on from it');
  const there = field(editor, far.x, far.y);
  assert.equal(lit.length, 1); assert(Math.hypot(lit[0].x - there.x, lit[0].y - there.y) < 1e-9, 'the point where the rear is divided, lit');
  assert(editor.undo()); assert.equal(editor.source.plates.length, plates, 'one step of history');
  // Away from all: on the cell, meeting nothing.
  editor.begin(); assert(editor.drawPlate(corner, field(editor, -30, 45), .1)); assert.deepEqual(editor.meets, []); editor.cancel();
});

test('the end is joined to an end of plates within reach of the cell it would rest on, though the pointer is not', () => {
  const editor = short();
  editor.change(source => { nodeOf(source, 'hull-1').y = -4.6; });
  const corner = end(editor, -44, 27), pointer = field(editor, -4.48, -5.45), { x, y } = field(editor, -4, -4.6);
  assert(Math.hypot(pointer.x - x, pointer.y - y) > .03, 'the pointer is out of reach of the corner');
  // The cell under the pointer, (−4, −5), is 2 cm from the corner (−4, −4.6): an end let go there joins it, and so does this.
  const [id] = draw(editor, corner, pointer, .03);
  assert.equal(plateOf(editor.source, id).b, 'hull-1');
});
