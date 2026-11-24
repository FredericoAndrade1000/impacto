import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { metresOf } from '../src/grid.ts';

const near = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);
function plate({ x = .37, y = 40.91, cells = 10, ends } = {}) {
  const source = createStructuredTemplate('empty');
  source.nodes = [{ id: 'precision:a', x: x - cells / 2, y }, { id: 'precision:b', x: x + cells / 2, y }];
  source.plates = [{ id: 'precision', a: 'precision:a', b: 'precision:b', material: 'steel', thicknessMm: 5, ...(ends ? { ends } : {}) }];
  source.components = [];
  const editor = new Editor(source); editor.snap = false; return editor;
}
const span = e => e.plateSpans().find(p => p.id === 'precision');

test('numeric plate rotation preserves its centre, length and saved free endpoints through repeated angles', () => {
  for (const snap of [false, true]) {
    const e = plate(), before = structuredClone(e.source), centre = { x: .37, y: 40.91 }; e.snap = snap;
    e.select('precision'); e.editProperty('angle', Math.PI / 4, true);
    near(span(e).length, .5); assert.equal(e.past.length, 1);
    e.undo(); assert.deepEqual(e.source, before);
    for (const degrees of [45, 0, -17.25, 90, 180, 0]) {
      e.select('precision'); e.editProperty('angle', degrees * Math.PI / 180, true);
      near(span(e).length, .5);
      near((e.source.nodes[0].x + e.source.nodes[1].x) / 2, centre.x);
      near((e.source.nodes[0].y + e.source.nodes[1].y) / 2, centre.y);
      assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)), e.source);
    }
    e.editProperty('angle', -.317, true); e.editProperty('length', .617, true);
    near(span(e).length, .617);
    near(Math.atan2(span(e).b.y - span(e).a.y, span(e).b.x - span(e).a.x), -.317);
    near((e.source.nodes[0].x + e.source.nodes[1].x) / 2, centre.x);
    near((e.source.nodes[0].y + e.source.nodes[1].y) / 2, centre.y);
    assert(!Object.hasOwn(e.source.plates[0], 'length'), 'length is a transform, never another saved geometric state');
  }
});

test('numeric edits include asymmetric end stock and preserve the displayed physical centre', () => {
  for (const snap of [false, true]) {
    const e = plate({ ends: { start: 2, end: 0 } }); e.snap = snap; e.select('precision');
    const before = structuredClone(e.source), piece = () => e.pieces.find(p => p.id === 'precision'),
      centre = { x: piece().x, y: piece().y };
    near(piece().length, .6);
    for (const angle of [.317, Math.PI / 4, 0, -Math.PI / 2]) {
      e.editProperty('angle', angle, true);
      near(piece().length, .6); near(piece().x, centre.x); near(piece().y, centre.y);
    }
    e.editProperty('length', .617, true);
    near(piece().length, .617); near(piece().x, centre.x); near(piece().y, centre.y);
    assert.deepEqual(e.source.plates[0].ends, before.plates[0].ends);
    assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)), e.source);
    e.undo(); near(piece().length, .6); e.select('precision');
    assert.throws(() => e.editProperty('length', .05, true));
  }
});

test('free and assisted plate drags translate both ends together; duplication preserves their shape', () => {
  const e = plate(); let hit = span(e), original = structuredClone(e.source.nodes);
  e.begin(); assert(e.movePlate(hit, .013, .027)); e.commit();
  for (let i = 0; i < 2; i++) { near(metresOf(e.source.nodes[i].x - original[i].x), .013); near(metresOf(e.source.nodes[i].y - original[i].y), .027); }
  e.snap = true; hit = span(e); original = structuredClone(e.source.nodes);
  e.begin(); assert(e.movePlate(hit, .07, .07)); e.commit();
  for (let i = 0; i < 2; i++) { near(metresOf(e.source.nodes[i].x - original[i].x), .05); near(metresOf(e.source.nodes[i].y - original[i].y), .05); }
  e.snap = false; e.select('precision'); e.editProperty('angle', .317, true);
  const before = span(e), intent = e.duplicate();
  e.addModule(intent.kind, { x: 16.013, y: 4.017 }, { ...intent, snap: false });
  const copied = e.plateSpans().find(s => s.id === e.selection);
  near(copied.length, before.length);
  near(copied.b.x - copied.a.x, before.b.x - before.a.x);
  near(copied.b.y - copied.a.y, before.b.y - before.a.y);
});

test('splitting a free sloping plate stays on its line with or without along-edge assistance', () => {
  for (const snap of [false, true]) {
    const e = plate({ cells: 30 }); e.select('precision'); e.editProperty('angle', .617, true); e.snap = snap;
    const before = span(e), at = { x: before.a.x + (before.b.x - before.a.x) * .37, y: before.a.y + (before.b.y - before.a.y) * .37 };
    assert(e.splitPlate(before, at));
    const pieces = e.plateSpans(); assert.equal(pieces.length, 2);
    near(pieces.reduce((sum, s) => sum + s.length, 0), before.length);
    for (const piece of pieces) for (const point of [piece.a, piece.b])
      near((point.x - before.a.x) * (before.b.y - before.a.y) - (point.y - before.a.y) * (before.b.x - before.a.x), 0);
  }
});

test('a deliberate near drop joins independent free endpoints, while a nearby same-plate end does not collapse it', () => {
  const e = plate(), second = e.addPlate({ x: 13, y: 3.3455 }, { x: 13, y: 4.3455 }),
    hit = e.pickNode(span(e).b, .001), before = structuredClone(e.source);
  e.begin(); assert(e.moveNode(hit, { x: 12.996, y: 3.3455 }, { joinReach: .02 })); assert(e.joinDroppedNode(hit, .02)); e.commit();
  assert.equal(e.source.plates.find(p => p.id === 'precision').b, e.source.plates.find(p => p.id === second.id).a, 'the drop shares one junction regardless of which endpoint ID survives');
  e.undo(); assert.deepEqual(e.source, before);
  const small = plate({ cells: 2 }), end = small.pickNode(span(small).b, .001);
  small.begin(); assert(small.moveNode(end, { x: end.x + .001, y: end.y }));
  assert.equal(small.joinDroppedNode(end, .18), false);
  near(span(small).length, .101);
  const sharedPosition = plate({ cells: 2 });
  const separate = structuredClone(sharedPosition.source), a = separate.nodes[0];
  separate.nodes.push({ ...a, id: 'separate:a' }, { ...a, id: 'separate:b', y: a.y + 20 });
  separate.plates.push({ id: 'separate', a: 'separate:a', b: 'separate:b', material: 'steel', thicknessMm: 5 });
  sharedPosition.replace(separate);
  const endAt = sharedPosition.pickNode(span(sharedPosition).b, .001);
  sharedPosition.begin(); assert(sharedPosition.moveNode(endAt, { x: endAt.x + .001, y: endAt.y }));
  assert.equal(sharedPosition.joinDroppedNode(endAt, .18), false);
  near(span(sharedPosition).length, .101);
});

test('numeric rotation at the floor handles exact half-turns and refuses a change that would move the centre', () => {
  const e = plate({ y: -26, x: 0 }); e.select('precision');
  e.editProperty('angle', Math.PI, true); assert(e.source.nodes.every(n => n.y === -26));
  const before = structuredClone(e.source);
  assert.throws(() => e.editProperty('angle', Math.PI / 4, true), error => error.reason === 'AUTHORING_EXTENT');
  assert.deepEqual(e.source, before);
});
