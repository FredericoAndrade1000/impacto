import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { planStructuredComponent,
  compileStructuredConstruction, createStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { cellOf, metresOf } from '../src/grid.ts';
import { applySettings } from '../src/piece-settings.ts';
import { closedFrame } from '../src/lab-constructions.ts';
import { suspensionZero } from '../src/chassis.ts';
import { DESIGN_VERSION, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { weaponLayout, weaponPartBounds } from '../src/weapon-paint.ts';
import { vehicleBox } from './helpers/designs.js';
import { DesignLibrary } from '../src/library.ts';

await initNativeDynamics();

// One closed room of one armour, its corners counter-clockwise from the lower front one, on a six-metre tracked frame
// under the middle of its floor, hung where its model hangs it: the floor of the room is at the height of its deck. The
// corners are laid out in metres over that deck and written in cells.
function framed(name, points, sides, thicknessMm) {
  const floor = points.filter(([, y]) => y === 0).map(([x]) => x), middle = (Math.min(...floor) + Math.max(...floor)) / 2,
    ends = [{ x: cellOf(middle - 3), y: 0 }, { x: cellOf(middle + 3), y: 0 }], deck = suspensionZero({ model: 'tracked', points: ends });
  return validateStructuredConstruction({ version: DESIGN_VERSION, preset: 'vehicle', name, chassis: { model: 'tracked', points: ends.map(end => ({ ...end, y: deck })) },
    ...closedFrame(points.map(([x, y]) => [x, y + metresOf(deck)]), sides, () => ({ material: 'steel', thicknessMm })), components: [] });
}
const part = (editor, id) => editor.source.components.find(candidate => candidate.id === id);
test('weapon replacement takes the box it alone fed to its calibre and keeps the others, through persistence and undo', () => {
  const editor = new Editor(createStructuredTemplate('heavy', { dual: true })),
    weapon = editor.source.components.find(candidate => candidate.kind === 'weapon'), before = structuredClone(editor.source),
    reserves = source => source.components.filter(candidate => candidate.kind === 'ammo');
  editor.select(weapon.id); editor.editProperty('weaponPreset', 'mk44', true);
  assert.equal(part(editor, weapon.id).weaponPreset, 'mk44');
  // The box of the old gun is now of the new one; the box of the other gun, and all else of both, is as it was.
  assert.deepEqual(reserves(editor.source), reserves(before).map(box => box.ammoPreset === 'rh120' ? { ...box, ammoPreset: 'mk44' } : box));
  assert.equal(editor.past.length, 1);
  const after = structuredClone(editor.source), memory = new Map(),
    library = new DesignLibrary({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) });
  assert.deepEqual(library.create(editor.source).blueprint, after);
  assert.deepEqual(parseBlueprint(serializeBlueprint(editor.source)), after);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  assert(editor.redo()); assert.deepEqual(editor.source, after);
});
test('manual ammunition calibre survives unrelated edits and their undo and redo', () => {
  const editor = new Editor(createStructuredTemplate('heavy')), reserve = editor.source.components.find(part => part.kind === 'ammo');
  editor.select(reserve.id); editor.editProperty('ammoPreset', 'm2hb', true);
  const manual = structuredClone(editor.source), history = editor.past.length;
  editor.change(source => { source.name = 'Reserva escolhida manualmente'; });
  assert.equal(part(editor, reserve.id).ammoPreset, 'm2hb');
  assert.equal(editor.past.length, history + 1);
  assert(editor.undo()); assert.deepEqual(editor.source, manual);
  assert(editor.redo()); assert.equal(part(editor, reserve.id).ammoPreset, 'm2hb');
});
test('a tank and an ammunition box have no fill to set: they are built full', () => {
  const editor = new Editor(createStructuredTemplate('heavy'));
  for (const kind of ['fuel', 'ammo']) {
    const reserve = editor.source.components.find(part => part.kind === kind), before = structuredClone(editor.source), history = editor.past.length;
    assert.equal(Object.hasOwn(reserve, 'loadFraction'), false, kind);
    editor.select(reserve.id);
    assert.throws(() => editor.editProperty('loadFraction', .25, true), /não tem esse ajuste/, kind);
    assert.deepEqual(editor.source, before); assert.equal(editor.past.length, history);
  }
});

test('opening another document with the same piece IDs preserves its authored ammunition and remains reversible', () => {
  const editor = new Editor(createStructuredTemplate('heavy'), 'first'), before = structuredClone(editor.source),
    incoming = createStructuredTemplate('heavy', { preset: 'mk44' });
  for (const part of incoming.components) if (part.kind === 'ammo') part.ammoPreset = 'rh120';
  const opened = new Editor(incoming, 'second').source;
  editor.replace(incoming, 'second');
  assert.equal(editor.projectId, 'second'); assert.deepEqual(editor.source, opened);
  assert(editor.undo()); assert.equal(editor.projectId, 'first'); assert.deepEqual(editor.source, before);
  assert(editor.redo()); assert.equal(editor.projectId, 'second'); assert.deepEqual(editor.source, opened);
});

test('a component resize keeps its pose and refuses occupied space without changing another component', () => {
  const source = vehicleBox({ height: 1, components: [{ id: 'reserve', kind: 'ammo', ammoPreset: 'rh120', pose: { x: 0, y: .05, angle: 0 } }], appearance: { paint: '#68765a', automaticDetails: false, details: [] } });
  const editor = new Editor(source), before = structuredClone(editor.source), reserve = editor.source.components.find(candidate => candidate.kind === 'ammo');
  assert.deepEqual(applySettings(editor, 'sizeScale', new Map([[reserve.id, (reserve.sizeScale ?? 1) + .2]])), { refused: [] });
  assert.equal(part(editor, reserve.id).sizeScale, (reserve.sizeScale ?? 1) + .2);
  assert.deepEqual(part(editor, reserve.id).pose, reserve.pose);
  assert.deepEqual(editor.source.components.filter(candidate => candidate.id !== reserve.id), before.components.filter(candidate => candidate.id !== reserve.id));
  editor.undo(); assert.deepEqual(editor.source, before);
  assert.throws(() => applySettings(editor, 'sizeScale', new Map([[reserve.id, (reserve.sizeScale ?? 1) + .5]])), error =>
    error.reason === 'COMPONENT_PLATE' && error.ids.includes(reserve.id));
  assert.deepEqual(editor.source, before);
});
test('a refused interior resize preserves the document, selection and existing undo and redo branch', () => {
  const editor = new Editor(createStructuredTemplate('heavy')), reserve = editor.source.components.find(part => part.kind === 'ammo');
  editor.change(source => { source.name = 'Nome a refazer'; }); editor.undo(); editor.select(reserve.id);
  const before = editor.source, past = structuredClone(editor.past), future = structuredClone(editor.future);
  assert.throws(() => applySettings(editor, 'sizeScale', new Map([[reserve.id, (reserve.sizeScale ?? 1) + .5]])),
    { reason: 'COMPONENT_PLATE' });
  assert.equal(editor.source, before); assert.equal(editor.selection, reserve.id);
  assert.deepEqual(editor.past, past); assert.deepEqual(editor.future, future);
  assert(editor.redo()); assert.equal(editor.source.name, 'Nome a refazer');
});

test('a hopper that cannot grow at its authored position is refused without sliding along the bed', () => {
  const editor = new Editor(createStructuredTemplate('truck')), hopper = editor.source.components.find(part => part.kind === 'hopper'), before = structuredClone(editor.source);
  editor.select(hopper.id);
  // A fifth bigger about its middle, it would go down into the frame it stands on.
  assert.throws(() => applySettings(editor, 'sizeScale', new Map([[hopper.id, hopper.sizeScale + .2]])));
  assert.deepEqual(editor.source, before); assert.equal(editor.selection, hopper.id); assert.equal(editor.past.length, 0);
});
test('an installation near the cab is refused at its requested position and size', () => {
  const truck = createStructuredTemplate('truck'), editor = new Editor({ ...truck, components: truck.components.filter(part => part.kind !== 'hopper') }),
    before = structuredClone(editor.source), engine = editor.blueprint.modules.find(part => part.kind === 'engine'),
    point = { x: engine.x, y: engine.y }, options = { sizeScale: 1.5 }, plan = editor.planModule('hopper', point, options);
  assert.equal(plan.source, null); assert(plan.reason); assert.equal(plan.module.sizeScale, 1.5);
  assert.throws(() => editor.addModule('hopper', point, options));
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
  assert.equal(editor.planModule('hopper', { x: 24.1, y: 1.8 }, options).source, null);
});
test('an installation near the bed end keeps its intended pose without extending the chassis', () => {
  const truck = createStructuredTemplate('truck'), editor = new Editor({ ...truck, components: truck.components.filter(part => part.kind !== 'hopper') }),
    before = structuredClone(editor.source), point = { x: 15.4, y: 3 }, options = { sizeScale: 1.5 }, plan = editor.planModule('hopper', point, options);
  assert(plan.source, plan.reason);
  assert.equal(plan.source.components.find(part => part.id === plan.module.id).sizeScale, 1.5);
  assert.deepEqual(plan.source.chassis, before.chassis, 'placing equipment does not extend or refit the chassis');
  assert(Math.abs(plan.module.x - point.x) < 1e-7);
  assert.deepEqual(editor.source, before, 'planning remains a preview');
  const installed = editor.addModule('hopper', point, options), posed = editor.blueprint.modules.find(part => part.id === installed.id);
  for (const key of ['id', 'x', 'y', 'width', 'height', 'mountId']) assert.equal(posed[key], plan.module[key], key);
  assert.deepEqual(editor.source.chassis, plan.source.chassis);
  assert.equal(editor.past.length, 1);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
});

const bedWithLoads = (loadX, otherX) => {
  const truck = createStructuredTemplate('truck'), original = truck.components.find(part => part.kind === 'hopper'),
    source = { ...truck, components: truck.components.filter(part => part.kind !== 'hopper') },
    load = (id, x) => ({ id, kind: 'hopper', sizeScale: .5,
      pose: { x: original.pose.x + cellOf(x - .5), y: original.pose.y, angle: 0 } });
  return validateStructuredConstruction({ ...source, components: [...source.components, load('load', loadX), load('neighbour', otherX)] });
};

test('installing a sensor keeps the counterweights of an asymmetrical valid construction', () => {
  const box = createStructuredConstruction({ length: 6, height: 3, thicknessMm: 8, frontInset: 0, rearInset: 0 }),
    // Axles at .3 m and 1.8 m, and an engine 1.3 m back and .7 m over the floor, written in cells.
    source = validateStructuredConstruction({ ...box, chassis: { ...box.chassis, thicknessMm: 25, axles: [6, 36] },
      components: [{ id: 'counterweight-engine', kind: 'engine', sizeScale: 2,
        pose: { x: 26, y: Math.min(...box.nodes.map(node => node.y)) + 14, angle: 0 } }] }),
    editor = new Editor(source), before = structuredClone(editor.source);
  assert.throws(() => compileStructuredConstruction({ ...source, components: [] }), { reason: 'CHASSIS_BALANCE', direction: 'front' },
    'the hull without its equipment is not a valid admission baseline');
  const native = planStructuredComponent(source, { id: 'new-camera', kind: 'sensor', sensorMode: 'visual', sizeScale: 1,
    pose: { x: 36, y: Math.max(...source.nodes.map(node => node.y)) + 4, angle: 0 } }),
    expected = native.compiled.modules.find(part => part.id === 'new-camera'), point = { x: expected.x, y: expected.y },
    options = { sensorMode: 'visual' }, plan = editor.planModule('sensor', point, options);
  assert(plan.source, plan.reason);
  const sensor = plan.source.components.find(part => part.id === plan.module.id);
  assert.deepEqual(sensor.pose, native.component.pose);
  assert(Math.hypot(plan.module.x - expected.x, plan.module.y - expected.y) < 1e-7,
    'the preview uses the real seat admitted with the existing equipment');
  assert.deepEqual(editor.source, before);
  const installed = editor.addModule('sensor', point, options);
  assert.deepEqual(editor.source.components.filter(part => part.id !== installed.id), before.components);
  assert.deepEqual(editor.source.chassis, before.chassis, 'valid counterweights do not trigger an unrelated chassis repair');
  assert(editor.blueprint.chassis.loadedKg <= editor.blueprint.chassis.limitKg);
  assert.equal(editor.past.length, 1);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
});

test('growth keeps geometric refusals atomic and leaves overloaded support for the author to resolve', () => {
  const source = bedWithLoads(.5, 1.7), before = structuredClone(source), editor = new Editor(source);
  editor.select('load');
  assert.throws(() => applySettings(editor, 'sizeScale', new Map([['load', 1.2]])));
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0); assert.equal(editor.selection, 'load');
  const truck = createStructuredTemplate('truck'), lighter = new Editor({ ...truck, chassis: { ...truck.chassis, thicknessMm: 5, armorMm: 40 },
    components: truck.components.map(part => part.kind === 'hopper' ? { ...part, sizeScale: 1.4 } : part) });
  lighter.select('hopper'); const original = lighter.captureSelection(); lighter.begin();
  assert(lighter.moveSelection(original, 1, 1)); lighter.commit();
  const saved = structuredClone(lighter.source), history = lighter.past.length;
  assert.deepEqual(applySettings(lighter, 'sizeScale', new Map([['hopper', 1.7]])), { refused: [] });
  assert.equal(part(lighter, 'hopper').sizeScale, 1.7);
  assert.deepEqual(part(lighter, 'hopper').pose, saved.components.find(part => part.id === 'hopper').pose);
  assert.throws(() => compileStructuredConstruction(lighter.source), { code: 'CHASSIS_OVERLOAD' });
  assert.equal(lighter.blueprint.mechanicalAdmission, false); assert.deepEqual(lighter.source.chassis, saved.chassis);
  assert.equal(lighter.past.length, history + 1); assert(lighter.undo()); assert.deepEqual(lighter.source, saved);
});
test('a hopper copy stays pending until the cursor chooses its new bed position', () => {
  const truck = createStructuredTemplate('truck'); truck.chassis.points.at(-1).x += 40;
  const editor = new Editor({ ...truck, components: truck.components.map(part => part.kind === 'hopper' ? { ...part, sizeScale: .6 } : part) }), before = structuredClone(editor.source),
    hopper = editor.blueprint.modules.find(part => part.kind === 'hopper'), originalPose = part(editor, hopper.id).pose;
  editor.select(hopper.id); const intent = editor.duplicate(), point = { x: hopper.x + hopper.width + .2, y: hopper.y }, plan = editor.planModule(intent.kind, point, intent);
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0); assert(plan.source, plan.reason);
  const copy = editor.addModule(intent.kind, point, intent), authored = part(editor, copy.id),
    intendedDx = cellOf(point.x - hopper.x);
  assert.equal(authored.pose.x - originalPose.x, intendedDx); assert.equal(authored.sizeScale, .6);
  assert.equal(authored.pose.y, originalPose.y, 'an unchanged axis retains the exact authored datum');
  assert(Math.abs(copy.x - hopper.x - metresOf(intendedDx)) < 1e-9, 'the explicit grid delta preserves the original pose');
  assert.deepEqual(editor.source.components.filter(part => part.id !== copy.id), before.components);
  assert.equal(editor.past.length, 1); editor.undo(); assert.deepEqual(editor.source, before);
});

test('moving resting equipment horizontally preserves its exact authored height', () => {
  const editor = new Editor(createStructuredTemplate('tanker')), cistern = editor.source.components.find(part => part.kind === 'cistern'),
    before = structuredClone(editor.source);
  editor.select(cistern.id); const original = editor.captureSelection(); editor.begin();
  assert.equal(editor.moveSelection(original, .1, 0), true, editor.blockedEdit?.message);
  editor.commit();
  assert.equal(part(editor, cistern.id).pose.y, cistern.pose.y);
  assert.deepEqual(editor.source.components.filter(part => part.id !== cistern.id), before.components.filter(part => part.id !== cistern.id));
  assert.deepEqual(editor.source.nodes, before.nodes); assert.deepEqual(editor.source.chassis, before.chassis);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
});
test('resizing across real roof metal is refused without moving the part or changing another piece', () => {
  const frame = createStructuredConstruction({ preset: 'bunker', length: 4, height: 2 }),
    roof = Math.max(...frame.nodes.map(node => node.y)),
    source = { ...frame, components: [{ id: 'tank', kind: 'fuel', sizeScale: .5,
      pose: { x: 0, y: roof - 6, angle: 0 } }] },
    tank = new Editor(source), before = structuredClone(tank.source);
  assert.throws(() => applySettings(tank, 'sizeScale', new Map([['tank', 1]])), { reason: 'COMPONENT_PLATE' });
  assert.deepEqual(tank.source, before);
  const moved = { ...source, components: source.components.map(part => ({ ...part, pose: { ...part.pose, y: roof - 20 } })) }, room = new Editor(moved);
  applySettings(room, 'sizeScale', new Map([['tank', 1]]));
  assert.deepEqual(room.source.components[0].pose, moved.components[0].pose);
});
test('a stretch of armour gains a node in the middle and loses it again, never a joint of three plates', () => {
  const editor = new Editor(vehicleBox({ appearance: { paint: '#68765a', automaticDetails: false, details: [] } })), count = () => [editor.source.nodes.length, editor.source.plates.length], began = count(),
    known = new Set(editor.source.nodes.map(node => node.id)), before = structuredClone(editor.source);
  assert.equal(editor.splitPlateMiddle('hull:roof'), true); assert.deepEqual(count(), began.map(n => n + 1));
  const added = editor.nodes().find(node => !known.has(node.id));
  assert.equal(editor.removeNode(added), true); assert.deepEqual(count(), began); assert.deepEqual(editor.source, before);
  assert(editor.splitPlateMiddle('hull:roof'));
  const foot = editor.nodes().find(node => !known.has(node.id));
  assert(editor.addPlate(foot, { x: foot.x, y: foot.y + 1 }));
  const junction = structuredClone(editor.source);
  assert.equal(editor.removeNode(foot), false); assert.deepEqual(editor.source, junction); assert(editor.blockedEdit.message);
  assert.equal(editor.splitPlateMiddle('hull:missing'), false);
});

test('the compiled outline the workshop paints keeps a node that sits close to its neighbour', () => {
  // Tracing the hull again from its plates joins ends within 22 cm, which dropped this node from the painted panel.
  // The node is on the cell nearest where it was (5.14 m, .12 m).
  const points = [[0, 0], [5, 0], [5.15, .1], [4.7, 1.6], [4.2, 2.05], [.4, 2.05]],
    compiled = compileStructuredConstruction(framed('rear', points, ['floor', 'rear', 'low', 'high', 'top', 'roof'], 40)),
    origin = compiled.frame.origin, deck = compiled.chassis.deck, panel = compiled.bodyPanels.find(face => face.roomId === compiled.rooms[0].id);
  assert(Math.hypot(.15, .1) < .22); assert.equal(compiled.bodyPanels.length, 1);
  assert.deepEqual(panel.poly.map(point => [Math.round((point.x - origin.x) * 100) / 100, Math.round((point.y - deck) * 100) / 100]), points);
});

test('a turned mechanism is painted from its own box, laid at the angle it was mounted', () => {
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], turn = .35,
    spin = point => ({ x: point.x * Math.cos(turn) - point.y * Math.sin(turn), y: point.x * Math.sin(turn) + point.y * Math.cos(turn) }),
    solids = [rect(-.9, -.24, 0, .24), rect(0, -.06, 1.8, .06), rect(.12, -.26, .4, -.07), rect(.12, .07, .4, .26)],
    straight = weaponLayout('rh120', solids), turned = weaponLayout('rh120', [solids[0].map(spin), ...solids.slice(1)]);
  assert.equal(straight.turn, 0); assert(Math.abs(turned.turn - turn) < 1e-9);
  for (const key of ['x0', 'x1', 'y0', 'y1']) assert(Math.abs(turned.receiver[key] - straight.receiver[key]) < 1e-9, key);
  const box = weaponPartBounds(turned), corners = solids[0].map(spin);
  assert(box.x0 <= Math.min(...corners.map(point => point.x)) + 1e-9 && box.y1 >= Math.max(...corners.map(point => point.y)) - 1e-9);
  assert.deepEqual(weaponPartBounds(turned, 'receiver'), turned.receiver);
});
