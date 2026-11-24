import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredConstruction, validateDraftConstruction } from '../src/structured-construction.ts';
import { CHASSIS_ID } from '../src/chassis-editing.ts';
import { groupSelectionHit } from '../src/workshop-selection.ts';

await initNativeDynamics();
const near = (a, b, label) => assert(Math.abs(a - b) < 1e-6, `${label}: ${a} != ${b}`);
const setup = (vehicle = false) => {
  const source = createStructuredConstruction({ preset: vehicle ? 'vehicle' : 'bunker', length: 5, height: 2, thicknessMm: 20, frontInset: 0, rearInset: 0 });
  // Two sensors 1 m either side of the middle and 3 m up, written in cells of 5 cm.
  source.components = [{ id: 'sensor-a', kind: 'sensor', sensorMode: 'visual', pose: { x: -20, y: 60, angle: 0 } },
    { id: 'sensor-b', kind: 'sensor', sensorMode: 'radar', pose: { x: 20, y: 60, angle: .2 } }];
  return new Editor(source);
};
function rigid(before, after, ids, dx, dy) {
  const moved = new Set(ids), current = new Map([...after.plates, ...after.modules].map(part => [part.id, part]));
  for (const was of [...before.plates, ...before.modules]) {
    const now = current.get(was.id), selected = moved.has(was.id);
    assert(now); near(now.x, was.x + (selected ? dx : 0), was.id + '.x'); near(now.y, was.y + (selected ? dy : 0), was.id + '.y');
    near(now.angle || 0, was.angle || 0, was.id + '.angle');
    for (const size of was.material ? ['length', 'thicknessMm'] : ['width', 'height']) near(now[size], was[size], was.id + '.' + size);
  }
  // What the pieces weigh but for the columns sensors stand on, as long as the way down to the metal under them
  // (game_construction.rs `standoff`).
  const own = blueprint => blueprint.fixedAssembly.mass - blueprint.modules.reduce((sum, part) => sum + (part.support?.mass ?? 0), 0);
  near(own(after), own(before), 'mass');
}

test('selecting hull plates captures only them, leaving contents and external equipment unselected', () => {
  const editor = setup(), ids = editor.source.plates.map(plate => plate.id); editor.select(ids);
  assert.deepEqual(editor.captureSelection().map(part => part.id), ids);
  assert.deepEqual([...editor.selectionIds], ids);
  editor.select(['hull:roof', 'sensor-a']);
  assert.deepEqual(editor.captureSelection().map(part => part.id).sort(), ['hull:roof', 'sensor-a'].sort());
  editor.select(CHASSIS_ID); assert.deepEqual(editor.captureSelection(), []);
});

test('an explicit plate and component group keeps its junctions without carrying unselected equipment', () => {
  const editor = setup(), source = structuredClone(editor.source), before = editor.blueprint;
  editor.select(['hull:roof', 'sensor-a']); const original = editor.captureSelection();
  editor.begin(); assert(editor.moveSelection(original, -.3, .4)); assert(editor.commit());
  const roof = source.plates.find(plate => plate.id === 'hull:roof'), ends = new Set([roof.a, roof.b]);
  for (const node of source.nodes) {
    const current = editor.source.nodes.find(other => other.id === node.id), moving = ends.has(node.id);
    near(current.x, node.x + (moving ? -6 : 0), node.id + '.x'); near(current.y, node.y + (moving ? 8 : 0), node.id + '.y');
  }
  assert.deepEqual(editor.source.plates, source.plates);
  const sensor = editor.source.components.find(part => part.id === 'sensor-a');
  assert.deepEqual(sensor.pose, { ...source.components[0].pose, x: source.components[0].pose.x - 6, y: source.components[0].pose.y + 8 });
  assert.deepEqual(editor.source.components.find(part => part.id === 'sensor-b'), source.components[1]);
  const previousRoof = before.plates.find(part => part.id === roof.id), currentRoof = editor.blueprint.plates.find(part => part.id === roof.id);
  near(currentRoof.length, previousRoof.length, 'selected roof length'); near(currentRoof.angle, previousRoof.angle, 'selected roof angle');
  const accepted = structuredClone(editor.source); assert.equal(editor.past.length, 1);
  assert.deepEqual(validateDraftConstruction(editor.source), editor.source);
  assert(editor.undo()); assert.deepEqual(editor.source, source); assert(editor.redo()); assert.deepEqual(editor.source, accepted);
});

test('each preview uses the gesture origin and returning to zero creates no topology edit', () => {
  const editor = setup(); editor.select([...editor.source.plates.map(plate => plate.id), 'sensor-a']);
  const source = structuredClone(editor.source), original = editor.captureSelection(), before = editor.blueprint;
  editor.begin(); assert(editor.moveSelection(original, -.14, .24));
  assert(editor.moveSelection(original, -.3, .4)); rigid(before, editor.blueprint, original.map(part => part.id), -.3, .4);
  assert(editor.moveSelection(original, 0, 0)); assert.deepEqual(editor.source, source);
  assert.equal(editor.commit(), false); assert.equal(editor.past.length, 0);
});

test('moving hull geometry beyond a chassis end never extends an unselected chassis', () => {
  const editor = setup(true), before = editor.blueprint, source = structuredClone(editor.source), ids = source.plates.map(plate => plate.id);
  editor.select(ids); editor.begin(); assert(editor.moveSelection(editor.captureSelection(), -.8, .1)); assert(editor.commit());
  assert.deepEqual(editor.source.chassis, source.chassis);
  rigid(before, editor.blueprint, ids, -.8, .1);
  assert.deepEqual(editor.blueprint.frame.origin, before.frame.origin);
  assert.deepEqual(validateDraftConstruction(editor.source), editor.source);
});

test('groups can move vertically without any support projection or hidden relocation', () => {
  const editor = setup(), source = structuredClone(editor.source), before = editor.blueprint;
  editor.select(['sensor-a', 'sensor-b']); const original = editor.captureSelection();
  editor.begin(); assert(editor.moveSelection(original, .15, -.35)); assert(editor.commit());
  rigid(before, editor.blueprint, original.map(part => part.id), .15, -.35);
  assert.deepEqual(editor.source.nodes, source.nodes); assert.deepEqual(editor.source.plates, source.plates);
});

test('a group exceeding actual authoring limits is refused atomically and retains redo', () => {
  const editor = setup(); editor.change(source => { source.name = 'Other'; }); assert(editor.undo());
  editor.select(['hull:roof', 'sensor-a']); const source = structuredClone(editor.source), future = structuredClone(editor.future);
  editor.begin(); assert.equal(editor.moveSelection(editor.captureSelection(), -10, 0), false); assert.equal(editor.commit(), false);
  assert.deepEqual(editor.source, source); assert.deepEqual(editor.future, future); assert(editor.blockedEdit.polygons.length > 0);
  assert(groupSelectionHit(editor, { plate: { id: 'hull:roof' } }));
  assert.equal(groupSelectionHit(editor, { plate: { id: 'hull:floor' } }), false);
});
