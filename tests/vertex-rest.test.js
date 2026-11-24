import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { metresOf } from '../src/grid.ts';

// Pointer snapping reads authored geometry. It does not ask the compiler to
// weld nodes, propagate movement or divide another plate. The nodes are written in
// units of 5 cm from the origin of the frame, and stand on the field in metres from it.
function fixture(snap = true) {
  const origin = { x: 12, y: 1.3 }, written = [{ id: 'a', x: -57, y: 15 }, { id: 'b', x: -58, y: -10 },
      { id: 'c', x: 27, y: -10 }, { id: 'd', x: 27, y: 15 }],
    nodes = written.map(({ id, x, y }) => ({ id, x: origin.x + metresOf(x), y: origin.y + metresOf(y) })),
    plates = [['front', 'a', 'b'], ['floor', 'b', 'c'], ['rear', 'c', 'd'], ['roof', 'd', 'a']].map(([id, a, b]) => ({ id, a, b })),
    source = { nodes: structuredClone(written), plates: structuredClone(plates), components: [] },
    frame = { origin, nodes, plates }, editor = Object.create(Editor.prototype);
  editor.document = { key: 'document', blueprint: source }; editor.root = { source, value: { frame } };
  editor.snap = snap;
  return { editor, source, nodes, hit: { ...nodes[0], source } };
}
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('a moved coordinate snaps to the stable project grid while the other stays authored', () => {
  // From 9.15 m, the cell nearest 9.03 m is 9.05 m.
  const { editor, hit } = fixture(), rested = editor.restNode(hit, { x: hit.x - .12, y: hit.y });
  near(rested.x, 9.05); near(rested.y, hit.y);
  const vertical = editor.restNode(hit, { x: hit.x, y: hit.y - .17 });
  near(vertical.x, hit.x); near(vertical.y, 1.9);
});

test('a drag shorter than half a cell leaves the pointer handle in place', () => {
  const { editor, hit } = fixture();
  assert.deepEqual(editor.restNode(hit, { x: hit.x + .02, y: hit.y + .02 }), { x: hit.x, y: hit.y });
});

test('a coordinate aligns exactly to an authored neighbour on its row or column of the grid', () => {
  const { editor, hit, nodes } = fixture(), foot = nodes[1], upright = editor.restNode(hit, { x: hit.x - .06, y: hit.y });
  near(upright.x, foot.x); near(upright.y, hit.y);
  const met = editor.restNode(hit, { x: foot.x + .02, y: foot.y + .02 });
  assert.deepEqual(met, { x: foot.x, y: foot.y });
});

test('snapping to a span returns its coordinates without splitting it or changing authoring', () => {
  // On the rear plate, at the cell nearest 1.46 m: 1.45 m.
  const { editor, source, hit } = fixture(), before = structuredClone(source), rested = editor.restNode(hit, { x: 13.36, y: 1.46 });
  near(rested.x, 13.35); near(rested.y, 1.45);
  assert.deepEqual(source, before); assert.equal(source.nodes.length, 4); assert.equal(source.plates.length, 4);
});

test('without grid assistance an endpoint follows the exact pointer, including short drags and points near other plates', () => {
  const { editor, source, hit, nodes } = fixture(false), before = structuredClone(source), foot = nodes[1];
  const points = [{ x: hit.x - .12, y: hit.y }, { x: hit.x, y: hit.y - .17 },
    { x: hit.x + .02, y: hit.y + .02 }, { x: foot.x + .02, y: foot.y + .02 }, { x: 13.36, y: 1.46 }];
  for (const point of points) assert.deepEqual(editor.restNode(hit, point), point);
  assert.deepEqual(source, before, 'nearness alone neither joins points nor splits a plate');
  editor.snap = true;
  near(editor.restNode(hit, points[0]).x, 9.05);
  editor.snap = false;
  assert.deepEqual(editor.restNode(hit, points[0]), points[0], 'turning assistance off restores free coordinates');
});
