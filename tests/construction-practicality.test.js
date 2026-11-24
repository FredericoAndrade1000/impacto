import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction, compileStructuredConstruction, compileDraftConstruction, planStructuredComponent,
  validateStructuredConstruction } from '../src/structured-construction.ts';
import { createCompartmentFromPlate } from '../src/workshop-ux.ts';
import { CHASSIS_ID, withChassisGearScale, withChassisThickness } from '../src/chassis-editing.ts';
import { chassisAxles, chassisGearScale, frameThicknessMm, gearProblem } from '../src/chassis.ts';
import { designBill } from '../src/economy.ts';
import { metresOf } from '../src/grid.ts';

await initNativeDynamics();

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const admitted = editor => {
  const compiled = compileDraftConstruction(editor.source);
  assert.deepEqual(compiled, editor.blueprint);
  if (compiled.mechanicalAdmission) assert(compiled.chassis.loadedKg <= compiled.chassis.limitKg);
  assert.equal(gearProblem(editor.source.chassis), null);
};
const closed = editor => {
  const compiled = editor.blueprint, enclosed = new Set();
  for (const room of compiled.rooms) {
    assert(room.walls.length >= 3);
    assert.equal(room.walls.length, room.polygon.length);
    for (const [i, wall] of room.walls.entries()) {
      const next = room.walls[(i + 1) % room.walls.length];
      near(wall.b.x, next.a.x); near(wall.b.y, next.a.y);
      enclosed.add(wall.id);
    }
  }
  assert(editor.source.plates.every(plate => enclosed.has(plate.id)), 'every authored plate actually bounds a room');
};
// How many cells higher `after` stands than `before`, all of it: its nodes, the points of its chassis and its equipment,
// each as far up or down and none along.
const lifted = (after, before) => {
  const lift = after.chassis.points[0].y - before.chassis.points[0].y, by = (a, b) => assert(a.x === b.x && a.y === b.y + lift);
  after.nodes.forEach((node, i) => by(node, before.nodes[i])); after.chassis.points.forEach((point, i) => by(point, before.chassis.points[i]));
  after.components.forEach((part, i) => by(part.pose, before.components[i].pose));
  return lift;
};
const roomyRoof = () => {
  const source = createStructuredConstruction({ length: 6, height: 1.6, thicknessMm: 10, frontInset: 0, rearInset: 0 });
  return validateStructuredConstruction(withChassisThickness(source, 30));
};
const roofSensor = t => {
  const source = roomyRoof();
  const a = source.nodes.find(node => node.id === 'hull-2'), b = source.nodes.find(node => node.id === 'hull-3');
  // On the cells nearest to so far along the roof, and the first clear over it (grid.ts).
  return planStructuredComponent(source, { id: 'camera', kind: 'sensor', sensorMode: 'visual',
    pose: { x: Math.round(a.x + (b.x - a.x) * t), y: a.y + 3, angle: 0 } }).construction;
};
const cameraPose = editor => {
  const camera = editor.blueprint.modules.find(part => part.id === 'camera');
  return { x: camera.x, y: camera.y, angle: camera.angle };
};

test('one roof action creates a short closed cabin and the whole edit can be undone and redone', () => {
  const editor = new Editor(roomyRoof()), before = structuredClone(editor.source),
    roof = editor.plateSpans().find(plate => plate.id === 'hull:roof');
  editor.select(roof.id);

  const cabin = createCompartmentFromPlate(editor, roof.id);

  assert(cabin);
  assert(cabin.length > 0 && cabin.length <= 1.8 + 1e-9);
  assert(cabin.length < roof.length);
  assert.equal(editor.blueprint.rooms.length, 2);
  assert(editor.source.nodes.length > before.nodes.length + 2, 'the cabin has explicit feet');
  // The roof it stands on is divided at its feet, the parts in its armour; the other plates are as they were.
  const parts = editor.source.plates.filter(plate => plate.id.startsWith('hull:roof'));
  assert.deepEqual(parts.map(plate => [plate.a, plate.b, plate.thicknessMm]),
    [['hull-2', parts[1].a, 10], [parts[1].a, parts[1].b, 10], [parts[1].b, 'hull-3', 10]]);
  assert.deepEqual(editor.source.plates.filter(plate => !plate.id.startsWith('hull:roof')).slice(0, before.plates.length - 1),
    before.plates.filter(plate => plate.id !== 'hull:roof'));
  assert.equal(editor.selection, cabin.plates[1]);
  assert.equal(editor.past.length, 1);
  closed(editor); admitted(editor);
  const after = structuredClone(editor.source);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  assert.equal(editor.blueprint.rooms.length, 1);
  assert(editor.redo()); assert.deepEqual(editor.source, after);
  closed(editor); admitted(editor);
});

test('a camera at the roof end keeps its physical pose while a cabin divides that roof', () => {
  const editor = new Editor(roofSensor(.08)), before = structuredClone(editor.source), camera = cameraPose(editor);

  assert(createCompartmentFromPlate(editor, 'hull:roof'));

  assert.deepEqual(cameraPose(editor), camera);
  assert.equal(editor.source.components.length, before.components.length);
  assert.deepEqual(editor.source.components[0].pose, before.components[0].pose);
  assert.equal(editor.past.length, 1);
  closed(editor); admitted(editor);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  assert.deepEqual(cameraPose(editor), camera);
});

test('a cabin may enclose an existing camera without moving it or searching another place', () => {
  const editor = new Editor(roofSensor(.5)), before = structuredClone(editor.source), camera = cameraPose(editor);
  assert(createCompartmentFromPlate(editor, 'hull:roof'));
  assert.deepEqual(editor.source.components, before.components); assert.deepEqual(cameraPose(editor), camera);
  assert.equal(editor.blueprint.rooms.length, 2); assert.equal(editor.past.length, 1);
  assert.equal(editor.blueprint.modules.find(part => part.id === 'camera').exposed, undefined);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  closed(editor); admitted(editor);
});
test('heavier armour and a larger engine retain the requested values and report capacity without redesigning the chassis', () => {
  const armour = new Editor(createStructuredConstruction({ length: 8, height: 1.4, thicknessMm: 8 })),
    engineBase = createStructuredConstruction({ length: 8, height: 3, thicknessMm: 8 }),
    engine = new Editor(planStructuredComponent(engineBase, { id: 'engine', kind: 'engine', sizeScale: 1,
      pose: { x: 0, y: 22, angle: 0 } }).construction);
  const preview = new Editor(planStructuredComponent(engineBase, { id: 'existing-engine', kind: 'engine', sizeScale: 1,
    pose: { x: 40, y: 6, angle: 0 } }).construction),
    previewBefore = structuredClone(preview.source),
    plan = preview.planModule('engine', { x: 10.4, y: preview.blueprint.frame.origin.y + 1.1 }, { sizeScale: 3.2 });
  assert(plan.source, 'the larger installation has a complete valid preview');
  assert.deepEqual(plan.source.chassis, previewBefore.chassis, 'capacity does not redesign the preview support');
  assert.equal(plan.blueprint.mechanicalAdmission, false);
  const installed = plan.blueprint.modules.find(part => part.id === plan.module.id);
  for (const field of ['x', 'y', 'width', 'height', 'angle']) near(plan.module[field], installed[field]);
  assert.equal(plan.source.components.find(part => part.id === plan.module.id).sizeScale, 3.2);
  assert.deepEqual(preview.source, previewBefore); assert.equal(preview.past.length, 0);
  for (const [editor, id, key, requested] of [[armour, 'hull:roof', 'thicknessMm', 150], [engine, 'engine', 'sizeScale', 3.2]]) {
    const before = structuredClone(editor.source), load = editor.blueprint.chassis.loadedKg,
      unsupported = { ...before, [key === 'thicknessMm' ? 'plates' : 'components']:
        before[key === 'thicknessMm' ? 'plates' : 'components'].map(part => part.id === id ? { ...part, [key]: requested } : part) };
    assert.throws(() => compileStructuredConstruction(unsupported), error => error.code === 'CHASSIS_OVERLOAD');
    editor.select(id); editor.editProperty(key, requested, true);

    const authored = [...editor.source.plates, ...editor.source.components].find(part => part.id === id);
    assert.equal(authored[key], requested);
    assert.deepEqual(editor.source.nodes, before.nodes, 'the requested equipment does not reshape its room');
    assert.deepEqual(editor.source.chassis, before.chassis);
    assert(editor.blueprint.chassis.loadedKg > load);
    assert.equal(editor.blueprint.mechanicalAdmission, false);
    assert.equal(editor.past.length, 1);
    closed(editor); admitted(editor);
    const after = structuredClone(editor.source);
    assert(editor.undo()); assert.deepEqual(editor.source, before);
    assert(editor.redo()); assert.deepEqual(editor.source, after);
  }
});

test('an explicit smaller uniform wheel size leaves the other authored supports untouched', () => {
  const editor = new Editor(createStructuredConstruction({ length: 8, height: 1.4, thicknessMm: 8 }));
  editor.select('hull:roof'); editor.editProperty('thicknessMm', 120, true);
  const before = structuredClone(editor.source), previousAxles = chassisAxles(before.chassis),
    previousGauge = frameThicknessMm(before.chassis), history = editor.past.length;
  assert.throws(() => compileStructuredConstruction(withChassisGearScale(before, .75)),
    error => error.code === 'CHASSIS_OVERLOAD');
  editor.select(CHASSIS_ID); editor.editProperty('gearScale', .75, true);

  assert.equal(chassisGearScale(editor.source.chassis), .75);
  assert.equal(editor.source.plates.find(plate => plate.id === 'hull:roof').thicknessMm, 120);
  // The smaller wheels hang the suspension lower, and the whole construction comes down with it.
  assert(lifted(editor.source, before) < 0);
  assert.deepEqual(chassisAxles(editor.source.chassis), previousAxles);
  assert.equal(frameThicknessMm(editor.source.chassis), previousGauge);
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  const wheels = editor.blueprint.modules.filter(part => part.kind === 'wheel');
  assert(wheels.every(part => part.width === wheels[0].width && part.height === wheels[0].height));
  assert.equal(editor.past.length, history + 1);
  admitted(editor);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
});

test('duplicating a large engine keeps its size and chassis in one undoable draft edit', () => {
  const base = createStructuredConstruction({ length: 8, height: 3, thicknessMm: 8 }),
    original = { id: 'engine', kind: 'engine', sizeScale: 3.2, pose: { x: -36, y: base.nodes[0].y + 24, angle: 0 } },
    editor = new Editor(planStructuredComponent(base, original).construction), before = structuredClone(editor.source),
    load = editor.blueprint.chassis.loadedKg;
  editor.select(original.id);

  const intent = editor.duplicate();
  assert.deepEqual(editor.source, before);
  const copy = editor.addModule(intent.kind, { x: 14.1, y: editor.blueprint.frame.origin.y + metresOf(original.pose.y) + .3 }, intent);

  assert(copy);
  assert.equal(editor.source.components.find(part => part.id === copy.id).sizeScale, original.sizeScale);
  assert.deepEqual(editor.source.components.find(part => part.id === original.id), before.components[0]);
  assert.equal(editor.blueprint.modules.filter(part => part.kind === 'engine').length, 2);
  assert(editor.blueprint.chassis.loadedKg > load);
  assert.deepEqual(editor.source.chassis, before.chassis);
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  assert.equal(editor.past.length, 1);
  closed(editor); admitted(editor);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
});

test('an impossible geometry edit preserves the current construction and the available redo', () => {
  const editor = new Editor(roomyRoof());
  editor.select('hull:roof'); editor.editProperty('thicknessMm', 20, true); editor.undo();
  const before = structuredClone(editor.source), past = structuredClone(editor.past), future = structuredClone(editor.future);
  assert(future.length > 0);

  assert.throws(() => editor.change(source => { source.nodes[2].x = 124; }));

  assert.deepEqual(editor.source, before);
  assert.deepEqual(editor.past, past); assert.deepEqual(editor.future, future);
  assert.equal(editor.before, null);
  closed(editor); admitted(editor);
  assert(editor.redo());
  assert.equal(editor.source.plates.find(plate => plate.id === 'hull:roof').thicknessMm, 20);
});

test('reducing aluminium frame thickness saves alloys without adding wheels, and draft undo/redo stays exact', () => {
  const base = createStructuredConstruction({ length: 8, height: 1.4, thicknessMm: 8 }),
    source = withChassisThickness({ ...base, chassis: { ...base.chassis, metal: 'aluminum' },
      plates: base.plates.map(plate => plate.id === 'hull:roof' ? { ...plate, thicknessMm: 150 } : plate) }, 30),
    editor = new Editor(source), before = structuredClone(editor.source), cost = designBill(editor.blueprint),
    supports = chassisAxles(before.chassis), frameKg = editor.blueprint.chassis.frameKg;
  assert.equal(editor.blueprint.mechanicalAdmission, false, 'a pending design still opens in the workshop');
  editor.select(CHASSIS_ID); editor.editProperty('frameThicknessMm', 8, true);

  const after = structuredClone(editor.source), { thicknessMm: _, points: __, ...chassis } = before.chassis, { points, ...rest } = after.chassis;
  assert.deepEqual(rest, chassis, 'only the gauge changed back to its canonical 8mm default');
  // A thinner frame hangs the suspension lower, and the whole construction comes down with it.
  assert(lifted(after, before) < 0);
  assert.deepEqual(chassisAxles(after.chassis), supports);
  assert.equal(chassisGearScale(after.chassis), chassisGearScale(before.chassis));
  assert.deepEqual(after.plates, before.plates);
  assert(editor.blueprint.chassis.frameKg < frameKg);
  assert(designBill(editor.blueprint).ligas < cost.ligas, 'the actual manufactured aluminium section costs less');
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  assert.throws(() => compileStructuredConstruction(after), error => error.code === 'CHASSIS_OVERLOAD');
  assert.equal(editor.past.length, 1);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  assert(editor.redo()); assert.deepEqual(editor.source, after);
  admitted(editor);
});

test('a pending capacity is resolved only by the support edit the author explicitly chooses', () => {
  const editor = new Editor(createStructuredConstruction({ length: 8, height: 1.4, thicknessMm: 8 }));
  editor.select('hull:roof'); editor.editProperty('thicknessMm', 150, true);
  const pending = structuredClone(editor.source), gauge = frameThicknessMm(pending.chassis), scale = chassisGearScale(pending.chassis);
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  editor.select(CHASSIS_ID); editor.editProperty('axleCount', 3, true);

  assert.equal(chassisAxles(editor.source.chassis).length, 3);
  assert.equal(frameThicknessMm(editor.source.chassis), gauge); assert.equal(chassisGearScale(editor.source.chassis), scale);
  assert.deepEqual(editor.source.plates, pending.plates); assert.deepEqual(editor.source.components, pending.components);
  assert.equal(editor.blueprint.mechanicalAdmission, true);
  assert(compileStructuredConstruction(editor.source).mechanicalAdmission);
  const completed = structuredClone(editor.source);
  assert(editor.undo()); assert.deepEqual(editor.source, pending); assert.equal(editor.blueprint.mechanicalAdmission, false);
  assert(editor.redo()); assert.deepEqual(editor.source, completed); assert.equal(editor.blueprint.mechanicalAdmission, true);
});
