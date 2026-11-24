import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { landEnds, moveNodes } from '../src/frame-editing.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

// The default construction — its roof from hull-3 at (−44, 27) to hull-2 at (52, 27), in cells of 5 cm, and its rear
// from there down to hull-1 at (54, −5) — with ends of plates of its own (`nodes`, each [id, x, y]) and plates of 2 cm
// between them (`plates`, each [id, a, b]).
function design(nodes, plates) {
  const source = createStructuredConstruction();
  source.nodes.push(...nodes.map(([id, x, y]) => ({ id, x, y })));
  source.plates.push(...plates.map(([id, a, b]) => ({ id, a, b, material: 'steel', thicknessMm: 20 })));
  return source;
}
// That design in the workshop, off the grid unless it is asked for.
function workshop(nodes, plates, { snap = false } = {}) {
  const editor = new Editor(createStructuredConstruction());
  editor.change(() => { editor.blueprint = design(nodes, plates); });
  editor.snap = snap;
  return editor;
}
// An upright post of 1 m standing at (60, 60).
const POST = [[['foot', 60, 60], ['top', 60, 80]], [['post', 'foot', 'top']]];
const field = (editor, x, y) => { const origin = editor.blueprint.frame.origin; return { x: origin.x + x * .05, y: origin.y + y * .05 }; };
const cells = count => count * .05;
const plateOf = (source, id) => source.plates.find(plate => plate.id === id);
const nodeOf = (source, id) => source.nodes.find(node => node.id === id);
const ends = (source, id) => { const plate = plateOf(source, id); return [plate.a, plate.b].map(end => ({ id: end, x: nodeOf(source, end).x, y: nodeOf(source, end).y })); };
const places = (source, id) => ends(source, id).map(({ x, y }) => ({ x, y }));
const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9;

test('a plate let go whole by an end of the hull slides onto it, unbent, and is joined to it in one step', () => {
  const editor = workshop(...POST), hit = editor.pickPlate(field(editor, 60, 70), .01), before = structuredClone(editor.source);
  editor.begin();
  // Its foot 5.6 cm from the rear top corner: without a reach to join in, it goes where the pointer takes it.
  assert(editor.movePlate(hit, cells(-8.5), cells(-32)));
  assert.deepEqual(places(editor.source, 'post'), [{ x: 51.5, y: 28 }, { x: 51.5, y: 48 }]);
  assert.deepEqual(editor.meets, []);
  // Within reach, it is shown on the corner whole — as long and as upright — and the corner is lit.
  assert(editor.movePlate(hit, cells(-8.5), cells(-32), { joinReach: .06 }));
  assert.deepEqual(ends(editor.source, 'post'), [{ id: 'hull-2', x: 52, y: 27 }, { id: 'top', x: 52, y: 47 }]);
  assert.equal(editor.meets.length, 1); assert(near(editor.meets[0], field(editor, 52, 27)));
  editor.commit();
  assert.equal(plateOf(editor.source, 'post').a, 'hull-2', 'one end with the roof and the rear');
  assert(editor.undo()); assert.deepEqual(editor.source, before, 'one step undoes the move and the join');
});

test('with the grid, a plate let go with an end on the very cell of another end is joined to it', () => {
  const editor = workshop(...POST, { snap: true }), hit = editor.pickPlate(field(editor, 60, 70), .01);
  editor.begin(); assert(editor.movePlate(hit, cells(-8), cells(-33), { joinReach: .01 })); editor.commit();
  assert.deepEqual(ends(editor.source, 'post'), [{ id: 'hull-2', x: 52, y: 27 }, { id: 'top', x: 52, y: 47 }]);
});

test('a plate let go whole over the middle of another lands on it, which is divided at its end', () => {
  const editor = workshop(...POST), hit = editor.pickPlate(field(editor, 60, 70), .01), plates = editor.source.plates.length;
  editor.begin(); assert(editor.movePlate(hit, cells(-40), cells(-32.5), { joinReach: .06 }));
  assert.equal(editor.meets.length, 1); assert(near(editor.meets[0], field(editor, 20, 27)), 'where the roof is divided, lit');
  editor.commit();
  assert.deepEqual(places(editor.source, 'post'), [{ x: 20, y: 27 }, { x: 20, y: 47 }], 'slid onto it whole');
  assert.equal(editor.source.plates.length, plates + 1);
  assert.deepEqual([plateOf(editor.source, 'hull:roof').a, plateOf(editor.source, 'hull:roof').b], ['hull-2', 'foot']);
});

test('where an end lands is told where it is let go: slid there, it is not taken by an end it then comes near', () => {
  // Its foot 9.5 cm over the roof and 13 cm from the rear top corner: within reach of the roof alone. On the roof it is 9 cm
  // from the corner, within reach of it too, but it stands where it landed, upright.
  const editor = workshop(...POST), hit = editor.pickPlate(field(editor, 60, 70), .01);
  editor.begin(); assert(editor.movePlate(hit, cells(-9.8), cells(-31.1), { joinReach: .1 })); editor.commit();
  assert.deepEqual(places(editor.source, 'post'), [{ x: 50.2, y: 27 }, { x: 50.2, y: 47 }]);
  assert.deepEqual([plateOf(editor.source, 'hull:roof').a, plateOf(editor.source, 'hull:roof').b], ['hull-2', 'foot']);
});

test('the ends of a group let go by different ends are all joined: the nearest by sliding the group, the others alone', () => {
  // An arch over the hull, its right leg 2.5 cm shorter and 3 cm further out than the roof is long.
  const editor = workshop([['g0', -44, 60], ['g1', -44, 80], ['g2', 52.6, 80], ['g3', 52.6, 60.5]],
    [['left', 'g0', 'g1'], ['top', 'g1', 'g2'], ['right', 'g2', 'g3']]);
  editor.select(['left', 'top', 'right']); editor.begin();
  assert(editor.moveSelection(editor.captureSelection(), cells(.4), cells(-32.6), { joinReach: .08 }));
  for (const corner of [[-44, 27], [52, 27]]) assert(editor.meets.some(point => near(point, field(editor, ...corner))), `${corner} lit`);
  editor.commit();
  // The left leg slid onto the front top corner, as upright and as long; the right one went alone onto the rear one.
  assert.deepEqual(ends(editor.source, 'left'), [{ id: 'hull-3', x: -44, y: 27 }, { id: 'g1', x: -44, y: 47 }]);
  assert.deepEqual(ends(editor.source, 'right'), [{ id: 'g2', x: 52.6, y: 47 }, { id: 'hull-2', x: 52, y: 27 }]);
});

test('of two ends of a group let go by one end, only the nearer is joined to it; the other goes with the group', () => {
  const editor = workshop([['n0', 60, 60], ['n1', 60, 80], ['f0', 61.5, 60], ['f1', 61.5, 80]], [['near', 'n0', 'n1'], ['far', 'f0', 'f1']]);
  editor.select(['near', 'far']); editor.begin();
  assert(editor.moveSelection(editor.captureSelection(), cells(-8.4), cells(-32.6), { joinReach: .08 }));
  assert.equal(editor.meets.length, 1);
  editor.commit();
  assert.deepEqual(ends(editor.source, 'near'), [{ id: 'hull-2', x: 52, y: 27 }, { id: 'n1', x: 52, y: 47 }]);
  assert.deepEqual(ends(editor.source, 'far'), [{ id: 'f0', x: 53.5, y: 27 }, { id: 'f1', x: 53.5, y: 47 }], 'slid with it, not joined');
});

test('plates copied and put in by an end of the hull are joined to it, lit as they are shown, in one step', () => {
  const editor = workshop(...POST);
  editor.select(['post']);
  const intent = editor.duplicate(), at = field(editor, 52.6, 27.6), options = { ...intent, snap: false, joinReach: .08 },
    plan = editor.planModule(intent.kind, at, options), history = editor.past.length;
  assert(plan.source, plan.reason); assert.equal(plan.meets.length, 1); assert(near(plan.meets[0], field(editor, 52, 27)));
  editor.addModule(intent.kind, at, options);
  const copy = editor.source.plates.at(-1);
  assert.deepEqual(ends(editor.source, copy.id)[0], { id: 'hull-2', x: 52, y: 27 }); assert.equal(nodeOf(editor.source, copy.b).y, 47);
  assert.equal(editor.past.length, history + 1);
  // Without a reach to join in, the copy goes where the pointer takes it.
  const apart = editor.planModule(intent.kind, field(editor, 52.6, 27.6), { ...intent, snap: false });
  assert(apart.source, apart.reason); assert.deepEqual(apart.meets, []);
});

test('in symmetric editing the plate across the axis lands mirrored where the one moved does', () => {
  const editor = workshop([['b0', -30, 60], ['b1', 30, 60], ['r0', 20, 70.5], ['r1', 20, 90], ['l0', -20, 70.5], ['l1', -20, 90]],
    [['beam', 'b0', 'b1'], ['right', 'r0', 'r1'], ['left', 'l0', 'l1']]);
  editor.symmetric = true;
  const hit = editor.pickPlate(field(editor, 20, 80), .02);
  editor.begin(); assert(editor.movePlate(hit, cells(.3), cells(-10), { joinReach: .08 }));
  assert.equal(editor.meets.length, 2); editor.commit();
  assert.deepEqual(places(editor.source, 'right'), [{ x: 20.3, y: 60 }, { x: 20.3, y: 79.5 }]);
  assert.deepEqual(places(editor.source, 'left'), [{ x: -20.3, y: 60 }, { x: -20.3, y: 79.5 }]);
  assert.equal(editor.source.plates.filter(plate => plate.id.startsWith('beam')).length, 3, 'the beam divided at both');
});

test('where joined it would be refused, a plate let go goes where the pointer takes it; where that is refused too, it stays', () => {
  // A plate falling gently to the left over the roof: its end on the rear top corner, it would lie in the roof.
  const editor = workshop([['f0', 60, 60], ['f1', 27, 62]], [['flat', 'f0', 'f1']]), hit = editor.pickPlate(field(editor, 43.5, 61), .02);
  editor.begin();
  assert(editor.movePlate(hit, cells(-7), cells(-32), { joinReach: .08 }));
  assert.deepEqual(ends(editor.source, 'flat'), [{ id: 'f0', x: 53, y: 28 }, { id: 'f1', x: 20, y: 30 }]);
  assert.deepEqual(editor.meets, []); assert.equal(editor.blockedEdit, null);
  assert.equal(editor.movePlate(hit, cells(-7.5), cells(-32.5), { joinReach: .08 }), false);
  assert.match(editor.blockedEdit.message, /ocupariam o mesmo lugar/);
  assert.deepEqual(places(editor.source, 'flat'), [{ x: 53, y: 28 }, { x: 20, y: 30 }], 'where it last could be');
  editor.commit();
});

test('an end held by a plate that does not move whole is no loose end: only the free ends of what moved land', () => {
  // An arm hanging from the top of the post down to the rear top corner, and a stay whose end is by the top of the post.
  const source = design([['foot', 60, 60], ['top', 60, 80], ['tip', 53, 28], ['stay:a', 59, 79.5], ['stay:b', 40, 90]],
      [['post', 'foot', 'top'], ['arm', 'top', 'tip'], ['stay', 'stay:a', 'stay:b']]),
    // The arm moved whole bends the post, which keeps its foot.
    moved = (ox, oy) => moveNodes(source, new Map([['top', { x: 59.4 + ox, y: 79.4 + oy }], ['tip', { x: 52.4 + ox, y: 27.4 + oy }]])),
    landed = landEnds(source, moved, 1);
  assert.deepEqual(landed.ends, [{ x: 52, y: 27 }]);
  assert.deepEqual([plateOf(landed.source, 'arm').a, plateOf(landed.source, 'arm').b], ['top', 'hull-2']);
  assert.equal(plateOf(landed.source, 'stay').a, 'stay:a', 'the top of the post is not joined to the stay by it');
  // Nothing moved, nothing lands; an end moved alone bends its plate, which moves whole no more.
  assert.equal(landEnds(source, () => source, 1), null);
  assert.equal(landEnds(source, (ox, oy) => moveNodes(source, new Map([['tip', { x: 52.4 + ox, y: 27.4 + oy }]])), 1), null);
});
