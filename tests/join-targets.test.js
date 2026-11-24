import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { looseEnds } from '../src/frame-points.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

// The hull of the default construction (its roof from hull-3 at (−44, 27) to hull-2 at (52, 27), in cells of 5 cm) and a
// plate of its own over it, from (60, 60) to (80, 60); off the grid, so that an end may be let go beside another.
function hull() {
  const editor = new Editor(createStructuredConstruction());
  editor.change(source => {
    source.nodes.push({ id: 'over:a', x: 60, y: 60 }, { id: 'over:b', x: 80, y: 60 });
    source.plates.push({ id: 'over', a: 'over:a', b: 'over:b', material: 'steel', thicknessMm: 20 });
  });
  editor.snap = false;
  return editor;
}
const field = (editor, x, y) => { const origin = editor.blueprint.frame.origin; return { x: origin.x + x * .05, y: origin.y + y * .05 }; };
const plateOf = (source, id) => source.plates.find(plate => plate.id === id);

test('the end a dragged end lights is the one it is joined to when let go there', () => {
  const editor = hull(), hit = editor.pickNode(field(editor, 80, 60), .01);
  editor.begin();
  assert.deepEqual(editor.dropTarget(hit, .02), [], 'not moved, nothing to join');
  // 1.4 cm from the rear top corner, its plate would stand in the roof and the rear: out of reach, it may not be there;
  // within reach, it is shown on that corner, which it is joined to.
  assert.equal(editor.moveNode(hit, field(editor, 51.8, 27.2)), false); assert.match(editor.blockedEdit.message, /ocupariam o mesmo lugar/);
  assert(editor.moveNode(hit, field(editor, 51.8, 27.2), { joinReach: .02 }));
  const shown = editor.source.nodes.find(node => node.id === 'over:b');
  assert.deepEqual({ x: shown.x, y: shown.y }, { x: 52, y: 27 });
  assert.deepEqual(editor.dropTarget(hit, .02), ['hull-2']);
  assert(editor.joinDroppedNode(hit, .02)); editor.commit();
  assert.equal(plateOf(editor.source, 'over').b, 'hull-2', 'one end with the roof and the rear');
  assert(editor.undo());
  // 5 cm from it: out of reach, none lit and none joined.
  const again = editor.pickNode(field(editor, 80, 60), .01);
  editor.begin(); assert(editor.moveNode(again, field(editor, 51, 28), { joinReach: .02 }));
  assert.deepEqual(editor.dropTarget(again, .02), []); assert.equal(editor.joinDroppedNode(again, .02), false);
  editor.commit();
  // Left there, the two look one at a distance and are told apart: loose, not joined. The points of the chassis, which
  // no end of plates is joined to, are not counted, as the drawing does not.
  const { plates } = editor.blueprint.frame, nodes = editor.blueprint.frame.nodes.filter(node => !node.id.startsWith('chassis:'));
  assert.deepEqual([...looseEnds(nodes, plates, .08)].toSorted(), ['hull-2', 'over:b']);
  assert.deepEqual([...looseEnds(nodes, plates, .02)], [], 'seen nearer, they are apart');
});

test('an end whose plate would stand in another plate, within reach of it, is shown on its line, the plate divided there', () => {
  const editor = hull(), hit = editor.pickNode(field(editor, 80, 60), .01), plates = editor.source.plates.length;
  // 1.5 cm over the roof, between its ends: on the roof, which is divided at that very end.
  editor.begin(); assert(editor.moveNode(hit, field(editor, 40, 27.3), { joinReach: .02 }));
  const { x, y } = field(editor, 40, 27);
  assert.equal(editor.meets.length, 1); assert(Math.hypot(editor.meets[0].x - x, editor.meets[0].y - y) < 1e-9, 'where the roof is divided, lit');
  editor.commit();
  const end = editor.source.nodes.find(node => node.id === 'over:b');
  assert.deepEqual({ x: end.x, y: end.y }, { x: 40, y: 27 }); assert.equal(editor.source.plates.length, plates + 1);
  assert.deepEqual([plateOf(editor.source, 'hull:roof').a, plateOf(editor.source, 'hull:roof').b].toSorted(), ['hull-2', 'over:b']);
});

test('loose ends are those near another end without being in its place, other than the two ends of one plate', () => {
  const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'c', x: 0, y: 0 }, { id: 'b', x: .5, y: 0 }, { id: 'h', x: .504, y: 0 },
      { id: 'd', x: 1, y: 0 }, { id: 'e', x: 1.003, y: 0 }, { id: 'f', x: 2, y: 0 }, { id: 'g', x: 2.05, y: 0 }],
    plates = [{ id: 'short', a: 'd', b: 'e' }, { id: 'out', a: 'a', b: 'b' }];
  assert.deepEqual([...looseEnds(nodes, plates, .01)].toSorted(), ['b', 'h']);
});
