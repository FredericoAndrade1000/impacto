import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { planStructuredComponent } from '../src/structured-construction.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { CELL, cellOf, metresOf } from '../src/grid.ts';
import { withChassisSuspension, withChassisThickness } from '../src/chassis-editing.ts';

await initNativeDynamics();

const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const module = (editor, id = 'hopper') => editor.blueprint.modules.find(part => part.id === id);
const authored = (editor, id = 'hopper') => editor.source.components.find(part => part.id === id);
// In cells (grid.ts): a cab over the front of the bed, its floor on the cell of the deck; all of it hung where its
// suspension reaches its wheels.
const lorry = kind => withChassisSuspension({ version: DESIGN_VERSION, preset: 'vehicle', name: 'Carga sobre a carroceria',
  chassis: { model: 'wheeled', points: [{ x: -60, y: -8 }, { x: 60, y: -8 }], thicknessMm: 20, axles: [-44, 0, 44] },
  nodes: [[-60, -8], [-20, -8], [-20, 24], [-60, 24]].map(([x, y], i) => ({ id: `cab-${i}`, x, y })),
  plates: [['cab:floor', 0, 1], ['cab:rear', 1, 2], ['cab:roof', 2, 3], ['cab:front', 3, 0]]
    .map(([id, a, b]) => ({ id, a: `cab-${a}`, b: `cab-${b}`, material: 'steel', thicknessMm: 20 })),
  components: [{ id: 'hopper', kind, sizeScale: 1, pose: { x: 30, y: 1, angle: 0 } }],
}, 0);

test('the mining truck hopper can stay put or slide into its own footprint without another support being selected', () => {
  const editor = new Editor(createStructuredTemplate('mining-truck')), source = structuredClone(editor.source), before = module(editor);
  editor.select('hopper');
  const original = editor.captureSelection();
  editor.begin();
  assert(editor.moveSelection(original, 0, 0));
  assert.equal(editor.blockedEdit, null);
  assert.deepEqual(editor.source, source);
  assert.equal(editor.commit(), false, 'an unchanged pointer must not create an undo entry');
  editor.begin();
  assert(editor.moveSelection(original, .05, 0));
  const moved = module(editor);
  near(moved.x, before.x + .05, 'requested horizontal movement');
  near(moved.y, before.y, 'bed height');
  assert.deepEqual([moved.width, moved.height, moved.angle], [before.width, before.height, before.angle]);
  assert.deepEqual(editor.source.chassis, source.chassis);
  assert.deepEqual(editor.source.nodes, source.nodes);
  assert.deepEqual(editor.source.plates, source.plates);
  assert.deepEqual(editor.source.components.filter(part => part.id !== 'hopper'), source.components.filter(part => part.id !== 'hopper'));
  assert(editor.commit());
  const accepted = structuredClone(editor.source);
  assert.equal(editor.past.length, 1);
  assert(editor.undo()); assert.deepEqual(editor.source, source);
  assert(editor.redo()); assert.deepEqual(editor.source, accepted);
});

test('a hopper drag is measured from its starting pose and returning to it leaves no edit', () => {
  const editor = new Editor(createStructuredTemplate('mining-truck')), source = structuredClone(editor.source), before = module(editor);
  editor.select('hopper'); const original = editor.captureSelection(); editor.begin();
  // A drag lands on the cell nearest to it (grid.ts): a part of one cell is the cell nearest.
  for (const dx of [.05, -.05, .03, 0]) {
    assert(editor.moveSelection(original, dx, 0));
    near(module(editor).x, before.x + metresOf(cellOf(dx)), 'gesture origin');
    near(module(editor).y, before.y, 'stable support height');
    assert.equal(authored(editor).pose.y, source.components.find(part => part.id === 'hopper').pose.y);
  }
  assert.deepEqual(editor.source, source);
  assert.equal(editor.commit(), false);
  assert.equal(editor.past.length, 0);
});

test('moving the hopper still rejects occupied space and points beyond the supported coordinates atomically', () => {
  for (const occupied of [true, false]) {
    const editor = new Editor(createStructuredTemplate('mining-truck')), source = editor.source;
    const before = module(editor), target = editor.blueprint.modules.find(part => part.kind === 'engine'),
      [dx, dy] = occupied ? [target.x - before.x, target.y - before.y] : [30, 0];
    editor.select('hopper'); const original = editor.captureSelection(); editor.begin();
    assert.equal(editor.moveSelection(original, dx, dy), false, `${dx},${dy}`);
    assert.equal(editor.source, source, 'invalid intent cannot clamp or relocate the load');
    assert(editor.blockedEdit.message);
    assert.equal(editor.commit(), false);
    assert.equal(editor.past.length, 0);
  }
});

test('a hopper may move into open air without changing another part to manufacture a support', () => {
  const editor = new Editor(lorry('hopper')), before = module(editor), source = structuredClone(editor.source);
  editor.select('hopper'); const original = editor.captureSelection(); editor.begin();
  assert(editor.moveSelection(original, 0, 3));
  near(module(editor).y, before.y + 3, 'freely authored height');
  assert.deepEqual(editor.source.chassis, source.chassis);
  assert.deepEqual(editor.source.plates, source.plates);
  assert.deepEqual(editor.source.nodes, source.nodes);
  assert(editor.commit());
});

test('existing deck loads reclaim only their own occupied footprint while a new load cannot claim it', () => {
  for (const kind of ['hopper', 'cistern', 'supply']) {
    const editor = new Editor(lorry(kind)), source = editor.source, before = module(editor), part = authored(editor);
    assert.throws(() => planStructuredComponent(source, { ...part, id: 'another-load' }), undefined,
      `${kind}: another piece still occupies that point`);
    editor.select('hopper'); const original = editor.captureSelection(); editor.begin();
    assert(editor.moveSelection(original, .1, 0), kind);
    near(module(editor).x, before.x + .1, `${kind}: requested movement`);
    near(module(editor).y, before.y, `${kind}: support height`);
    assert.equal(authored(editor).sizeScale, part.sizeScale, 'moving cannot shrink the load to fit');
  }
});

test('an overloaded design keeps its hopper movable without changing its frame or running gear', () => {
  const source = withChassisThickness(lorry('hopper'), 5);
  source.plates = source.plates.map(plate => ({ ...plate, thicknessMm: 80 }));
  const editor = new Editor(source), before = module(editor), chassis = structuredClone(editor.source.chassis);
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  assert(editor.blueprint.admissionIssues.some(issue => issue.code === 'CHASSIS_OVERLOAD'));
  editor.select('hopper'); const original = editor.captureSelection(); editor.begin();
  assert(editor.moveSelection(original, .1, 0));
  near(module(editor).x, before.x + .1, 'overloaded draft movement');
  near(module(editor).y, before.y, 'overloaded draft support height');
  assert.deepEqual(editor.source.chassis, chassis);
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  assert(editor.blueprint.admissionIssues.some(issue => issue.code === 'CHASSIS_OVERLOAD'));
  assert(editor.commit());
});

test('an existing hopper can move from its bed to a valid compartment roof and slide on that roof', () => {
  // On the roof: on the first cell clear of its top face (grid.ts), as the one under it would sink into the plate.
  const editor = new Editor(lorry('hopper')), before = module(editor), roof = editor.blueprint.rooms[0].walls.find(wall => wall.id === 'cab:roof'),
    origin = editor.blueprint.frame.origin, onTop = roof.a.y + .01 + before.height / 2,
    target = { x: (roof.a.x + roof.b.x) / 2, y: origin.y + metresOf(Math.ceil((onTop - origin.y) / CELL - 1e-9)) };
  editor.select('hopper'); const original = editor.captureSelection(); editor.begin();
  assert(editor.moveSelection(original, target.x - before.x, target.y - before.y));
  near(module(editor).x, target.x, 'explicit roof position');
  near(module(editor).y, target.y, 'explicit roof height');
  assert.equal(module(editor).width, before.width);
  assert.equal(module(editor).height, before.height);
  assert(editor.commit());
  const onRoof = module(editor), roofY = authored(editor).pose.y, second = editor.captureSelection(); editor.begin();
  assert(editor.moveSelection(second, .1, 0));
  near(module(editor).x, onRoof.x + .1, 'roof slide');
  near(module(editor).y, onRoof.y, 'roof height');
  assert.equal(authored(editor).pose.y, roofY);
});
