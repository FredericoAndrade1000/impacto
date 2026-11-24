import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { CAPACITY, PART_LIMITS, createStructuredConstruction, validateStructuredConstruction, compileStructuredConstruction, validateDraftConstruction, compileDraftConstruction, compileDraft, planStructuredComponent } from '../src/structured-construction.ts';
import { DESIGN_VERSION, serializeBlueprint, parseBlueprint } from '../src/persistence.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { fedAmmo, fixedWeapon, cartridgeOf } from '../src/weapons.ts';
import { componentPolygon } from '../src/assembly.ts';
import { plateCorners } from '../src/math.ts';

await initNativeDynamics();

const editor = () => new Editor(createStructuredConstruction(), 'saved-structured');
const checkCanonical = e => {
  assert.equal(e.source.version, DESIGN_VERSION); assert.equal(e.document.blueprint, e.source);
  for (const key of ['modules', 'rooms', 'frame', 'derived', 'attachments']) assert.equal(Object.hasOwn(e.source, key), false);
  assert.deepEqual(validateDraftConstruction(e.source), e.source);
};

test('grid assistance starts enabled, and disabling it preserves a sub-five-centimetre component and mixed move', () => {
  const e = new Editor(createStructuredTemplate('empty'));
  assert.equal(e.snap, true);
  const fuel = e.addModule('fuel', { x: 12.013, y: 4.017 }, { sizeScale: .25 });
  assert(Math.abs(fuel.x - 12) < 1e-10 && Math.abs(fuel.y - 4) < 1e-10);
  e.snap = false;
  const plate = e.addPlate({ x: 11, y: 6 }, { x: 12, y: 6 });
  e.select([fuel.id, plate.id]);
  const before = structuredClone(e.source), history = e.past.length, original = e.captureSelection(),
    beforeFuel = e.blueprint.modules.find(part => part.id === fuel.id),
    beforeNodes = before.nodes.filter(node => {
      const own = before.plates.find(part => part.id === plate.id); return node.id === own.a || node.id === own.b;
    });
  e.begin(); assert(e.moveSelection(original, .013, .017)); assert(e.commit());
  const afterFuel = e.blueprint.modules.find(part => part.id === fuel.id);
  assert(Math.abs(afterFuel.x - beforeFuel.x - .013) < 1e-10);
  assert(Math.abs(afterFuel.y - beforeFuel.y - .017) < 1e-10);
  for (const original of beforeNodes) {
    const moved = e.source.nodes.find(node => node.id === original.id);
    assert(Math.abs(moved.x - original.x - .26) < 1e-10);
    assert(Math.abs(moved.y - original.y - .34) < 1e-10);
  }
  assert.equal(e.past.length, history + 1); checkCanonical(e);
  const moved = structuredClone(e.source);
  e.undo(); assert.deepEqual(e.source, before); e.redo(); assert.deepEqual(e.source, moved);
});

test('free component placement retains a fractional authored pose and actual compiled position', () => {
  const e = new Editor(createStructuredTemplate('empty')); e.snap = false;
  const placed = e.addModule('fuel', { x: 12.013, y: 4.017 }, { sizeScale: .25 }),
    authored = e.source.components.find(part => part.id === placed.id);
  assert(Math.abs(placed.x - 12.013) < 1e-10 && Math.abs(placed.y - 4.017) < 1e-10);
  assert(!Number.isInteger(authored.pose.x) && !Number.isInteger(authored.pose.y));
  checkCanonical(e); assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)), e.source);
});

test('an unsupported component stays editable and saveable while its native finding identifies it for the drawing', () => {
  const e = new Editor(createStructuredTemplate('chassis')); e.snap = false;
  assert.deepEqual(e.reviewManufacture(), [], 'the factory chassis starts supported');
  const fuel = e.addModule('fuel', { x: 12.013, y: 4.017 }, { sizeScale: .25 });
  e.editProperty('angle', .37, true);
  const source = structuredClone(e.source), drawing = e.blueprint, findings = e.reviewManufacture();
  assert(findings.some(issue => issue.code === 'PHYSICAL_SUPPORT' && issue.ids.includes(fuel.id)));
  assert.equal(e.manufactureIssues, findings, 'the drawing reads the native source IDs');
  assert.equal(e.blueprint, drawing); assert.equal(drawing.mechanicalAdmission, true);
  assert.deepEqual(e.source, source, 'review does not rewrite or refuse the authoring');
  assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)), source); checkCanonical(e);
});

test('a fixed design is reviewed resting on the level bench: a piece in the air is found, one on the ground beside it is not', () => {
  const e = new Editor(createStructuredTemplate('guard-post')); e.snap = false;
  assert.deepEqual(e.reviewManufacture(), [], 'the catalogue post stands on the bench');
  const lowest = Math.min(...e.blueprint.plates.flatMap(plateCorners).map(p => p.y)),
    beside = Math.max(...e.blueprint.plates.flatMap(plateCorners).map(p => p.x)) + 1,
    probe = e.planModule('sensor', { x: beside, y: 5 }, { sensorMode: 'visual' }).module,
    height = probe.y - Math.min(...componentPolygon(probe).map(p => p.y));
  const floating = e.addModule('sensor', { x: 12, y: 8 }, { sensorMode: 'visual' });
  assert.deepEqual(e.reviewManufacture(), [{ code: 'PHYSICAL_SUPPORT', ids: [floating.id] }]);
  e.undo();
  e.addModule('sensor', { x: beside, y: lowest + height }, { sensorMode: 'visual' });
  assert.deepEqual(e.reviewManufacture(), [], 'the ground beside the post holds a piece standing on it');
  e.undo();
  const raised = e.addModule('sensor', { x: beside, y: lowest + height + .1 }, { sensorMode: 'visual' });
  assert.deepEqual(e.reviewManufacture(), [{ code: 'PHYSICAL_SUPPORT', ids: [raised.id] }], 'a gap over the ground holds nothing');
});

test('nearby face installation keeps exact contact, settings and one undo while disabled assistance remains free', () => {
  const e = new Editor(createStructuredTemplate('empty')), options = { sizeScale: .25, angle: .37, faceTolerance: .08 },
    fuel = e.planModule('fuel', { x: 12, y: 5 }, options).module,
    floor = e.blueprint.plates.find(plate => plate.id === 'hull:floor'), top = floor.y + floor.thicknessMm / 2000,
    height = fuel.y - Math.min(...componentPolygon(fuel).map(point => point.y)),
    point = { x: floor.x, y: Math.ceil((top + height + .015) * 20) / 20 },
    before = structuredClone(e.source), history = e.past.length, plan = e.planModule('fuel', point, options);
  assert(plan.source, plan.reason); assert.deepEqual(e.source, before, 'a preview is not an edit');
  const installed = e.addModule('fuel', point, options), source = structuredClone(e.source);
  for (const key of ['width', 'height', 'angle']) assert.equal(installed[key], fuel[key]);
  assert(Math.abs(Math.min(...componentPolygon(installed).map(point => point.y)) - top) < 1e-8);
  assert.equal(installed.y, plan.module.y, 'installation uses the same assisted position as its preview');
  assert.equal(e.past.length, history + 1); checkCanonical(e);
  assert(e.undo()); assert.deepEqual(e.source, before);
  assert(e.redo()); assert.deepEqual(e.source, source);
  e.undo(); e.snap = false;
  const free = e.addModule('fuel', point, options);
  assert(Math.abs(free.y - point.y) < .1, 'nearby surface assistance also seats parts with the grid disabled');
  assert(Math.abs(Math.min(...componentPolygon(free).map(point => point.y)) - top) < 1e-8, 'surface seating is independent of grid quantization');
});

test('nearby face dragging changes only the individual component and numeric and group movement stay explicit', () => {
  const e = new Editor(createStructuredTemplate('empty')),
    fuel = e.addModule('fuel', { x: 11, y: 5 }, { sizeScale: .25, angle: .37 }),
    floor = e.blueprint.plates.find(plate => plate.id === 'hull:floor'), top = floor.y + floor.thicknessMm / 2000,
    height = fuel.y - Math.min(...componentPolygon(fuel).map(point => point.y)),
    target = Math.ceil((top + height + .015) * 20) / 20, before = structuredClone(e.source), history = e.past.length;
  e.begin(); assert(e.moveSelection(e.captureSelection(), 0, target - fuel.y, { faceTolerance: .08 })); assert(e.commit());
  const moved = e.selected;
  assert(Math.abs(Math.min(...componentPolygon(moved).map(point => point.y)) - top) < 1e-8);
  assert.deepEqual(e.source.plates, before.plates); assert.deepEqual(e.source.nodes, before.nodes);
  for (const key of ['width', 'height', 'angle']) assert.equal(moved[key], fuel[key]);
  assert.equal(e.past.length, history + 1);
  e.begin(); assert(e.transformSelection(e.captureSelection(), part => ({ x: part.x, y: part.y + .013 }))); assert(e.commit());
  assert(Math.abs(e.selected.y - moved.y - .013) < 1e-10, 'precise transforms do not invoke gesture assistance');
  e.undo(); e.undo(); assert.deepEqual(e.source, before);
  const other = e.addModule('fuel', { x: 13, y: 5 }, { sizeScale: .25, angle: .37 });
  e.select([fuel.id, other.id]);
  e.begin(); assert(e.moveSelection(e.captureSelection(), 0, target - fuel.y, { faceTolerance: .08 })); assert(e.commit());
  for (const id of [fuel.id, other.id]) {
    const part = e.blueprint.modules.find(part => part.id === id);
    assert(Math.abs(part.y - target) < 1e-10);
    assert(Math.min(...componentPolygon(part).map(point => point.y)) > top + .01, 'a group keeps its rigid explicit delta');
  }
});

test('a mixed copy keeps its fractional common delta without rounding either the plate or component', () => {
  const e = new Editor(createStructuredTemplate('empty')); e.snap = false;
  const fuel = e.addModule('fuel', { x: 12.013, y: 4.017 }, { sizeScale: .25 }),
    plate = e.addPlate({ x: 11.123, y: 6.017 }, { x: 12.123, y: 6.017 });
  e.select([fuel.id, plate.id]);
  const intent = e.duplicate(), before = structuredClone(e.source),
    plan = e.planModule(intent.kind, { x: intent.anchor.x + 2.013, y: intent.anchor.y + .017 }, intent);
  assert(plan.source);
  const copied = plan.modules.find(part => part.kind === 'fuel');
  assert(Math.abs(copied.x - fuel.x - 2.013) < 1e-10 && Math.abs(copied.y - fuel.y - .017) < 1e-10);
  for (const end of ['a', 'b']) {
    const original = intent.plates[0][end];
    // Physical endpoints are read from the compiled frame because the plate
    // projection itself stores centre/angle, rather than a second endpoint DTO.
    const sourcePlate = plan.source.plates.find(part => part.id === plan.plates[0].id), node = plan.source.nodes.find(node => node.id === sourcePlate[end]),
      origin = plan.blueprint.frame.origin;
    assert(Math.abs(node.x / 20 + origin.x - original.x - 2.013) < 1e-10);
    assert(Math.abs(node.y / 20 + origin.y - original.y - .017) < 1e-10);
  }
  assert.deepEqual(e.source, before, 'planning a copy does not change the document');
});

test('free chassis vertices and axles preserve real centimetre edits and undo exactly', () => {
  const e = new Editor(createStructuredTemplate('chassis')); e.snap = false;
  const before = structuredClone(e.source), rear = e.chassisPoints().at(-1), handle = e.pickChassisPoint(rear, .001);
  e.begin(); assert(e.moveChassisPoint(handle, { x: rear.x + .013, y: rear.y })); assert(e.commit());
  assert(Math.abs(e.source.chassis.points.at(-1).x - before.chassis.points.at(-1).x - .26) < 1e-10);
  checkCanonical(e); e.undo(); assert.deepEqual(e.source, before);
  const axle = e.gearHandle('axle-0'), world = e.chassisGear()[0];
  e.begin(); assert(e.moveGear(axle, { x: world.x + .013, y: world.y })); assert(e.commit());
  assert(Math.abs(e.chassisGear()[0].x - world.x - .013) < 1e-10);
  checkCanonical(e); e.undo(); assert.deepEqual(e.source, before);
});

test('vehicle admission stores one canonical document of this version; DTO mutations never become saved geometry', () => {
  const old = createStructuredTemplate('scout'), original = structuredClone(old), e = new Editor(old);
  checkCanonical(e); assert.deepEqual(old, original);
  assert.equal(e.source.components.length, old.components.length);
  const derived = e.blueprint;
  assert.throws(() => { derived.modules[0].x = 999; }, TypeError);
  assert.throws(() => { derived.plates[0].thicknessMm = 999; }, TypeError);
  assert.equal(e.blueprint, derived, 'immutable projection is compiled once per document');
  assert.notEqual(e.blueprint.modules[0].x, 999); assert.notEqual(e.blueprint.plates[0].thicknessMm, 999);
  assert.throws(() => { e.blueprint = derived; }, /não pode ser editado/);
  assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)), e.source);
  assert.throws(() => serializeBlueprint(e.blueprint), /não é um projeto desta versão/);
});

test('an accepted frame preview exposes an isolated frozen projection and cancellation restores the original drawing', () => {
  const e = editor(), before = structuredClone(e.source), original = structuredClone(e.blueprint),
    hit = e.nodes().find(node => node.id === 'hull-3');
  e.begin(); assert.equal(e.moveNode(hit, { x: hit.x + .24, y: hit.y + .19 }), true);
  const accepted = structuredClone(e.source), preview = e.blueprint;
  assert.notDeepEqual(preview, original);
  assert.deepEqual(preview, compileDraftConstruction(e.source));
  assert(Object.isFrozen(preview)); assert(Object.isFrozen(preview.frame.nodes[0]));
  assert.throws(() => { preview.plates[0].x = 999; }, TypeError);
  assert.equal(e.blueprint, preview);
  assert.deepEqual(e.source, accepted); assert.equal(Object.isFrozen(e.source.nodes[0]), false);
  e.cancel();
  assert.deepEqual(e.source, before); assert.equal(e.past.length, 0);
  const restored = e.blueprint;
  assert.notEqual(restored, preview); assert.deepEqual(restored, original);
  assert(Object.isFrozen(restored)); assert.equal(e.blueprint, restored);
});

test('construction and drawing projections remain isolated across repeated admission and draft requests', () => {
  const source = createStructuredTemplate('scout'), original = structuredClone(source),
    drawing = compileStructuredConstruction(source), expected = structuredClone(drawing), draft = compileDraft(source);
  const admitted = validateStructuredConstruction(source), authoredDraft = validateDraftConstruction(source),
    drawnDraft = compileDraftConstruction(source);
  admitted.nodes[0].x = 999; authoredDraft.plates[0].thicknessMm = 999;
  drawing.plates[0].x = 999; drawnDraft.rooms[0].polygon[0].x = 999;
  draft.construction.components[0].kind = 'altered'; draft.compiled.modules[0].x = 999;
  assert.deepEqual(source, original);
  assert.deepEqual(validateStructuredConstruction(source), original);
  assert.deepEqual(validateDraftConstruction(source), original);
  assert.deepEqual(compileStructuredConstruction(source), expected);
  assert.deepEqual(compileDraftConstruction(source), expected);
  const again = compileDraft(source);
  assert.deepEqual(again.construction, original); assert.deepEqual(again.compiled, expected);
});

test('project identity exists before edits and follows each document through undo and redo', () => {
  const e = editor(), key = e.documentKey, initial = structuredClone(e.source);
  e.change(b => { b.name = 'Primeiro'; }); e.change(b => { b.name = 'Segundo'; });
  assert(e.undo()); assert.equal(e.source.name, 'Primeiro');
  e.change(b => { b.name = 'Outro ramo'; }); assert.equal(e.future.length, 0);
  assert.equal(e.documentKey, key);
  assert(e.undo()); assert.equal(e.projectId, 'saved-structured');
  assert(e.undo()); assert.deepEqual(e.source, initial); assert.equal(e.documentKey, key);
  e.replace(createStructuredTemplate('plate'), 'lab'); assert.equal(e.source.version, DESIGN_VERSION);
  assert(e.undo()); checkCanonical(e); assert.equal(e.documentKey, key); assert.equal(e.projectId, 'saved-structured');
  assert(e.redo()); assert.equal(e.projectId, 'lab'); assert.equal(e.source.preset, 'bunker');
  e.replace(initial); const fresh = e.projectId;
  assert.equal(typeof fresh, 'string'); assert(fresh); assert.notEqual(fresh, 'lab');
  assert(e.undo()); assert.equal(e.projectId, 'lab');
  assert(e.redo()); assert.equal(e.projectId, fresh);
});

test('forgetting the open project validates its replacement and prevents undo from restoring a removed identity', () => {
  const a = createStructuredTemplate('scout'), b = createStructuredTemplate('bunker'), e = new Editor(a, 'A');
  e.change(source => { source.name = 'A editado'; }); e.replace(b, 'B');
  e.change(source => { source.name = 'B editado'; });
  const kept = structuredClone(e.source);
  e.replace(a, 'A'); e.select('hull:front'); e.begin(); e.source.name = 'A em prévia'; e.preview();
  e.blockedEdit = { message: 'Bloqueado' };
  const before = structuredClone({ document: e.document, past: e.past, future: e.future, before: e.before, revision: e.revision }), events = [];
  e.onchange = event => events.push(event.kind);
  assert.throws(() => e.forgetProject('A', { id: 'B', blueprint: { ...b, version: 4 } }), /não é um projeto desta versão/);
  assert.throws(() => e.forgetProject('A', { id: 'A', blueprint: b }), /outro projeto/);
  assert.deepEqual({ document: e.document, past: e.past, future: e.future, before: e.before, revision: e.revision }, before);
  assert.deepEqual(events, []);
  assert.equal(e.forgetProject('A', { id: 'B', blueprint: kept }), true);
  assert.equal(e.projectId, 'B'); assert.deepEqual(e.source, kept); assert.deepEqual(events, ['document']);
  assert.equal(e.revision, before.revision + 1); assert.equal(e.before, null); assert.equal(e.compiled, null);
  assert.equal(e.selection, null); assert.equal(e.blockedEdit, null);
  const names = [];
  while (e.undo()) { assert.equal(e.projectId, 'B'); names.push(e.source.name); }
  assert(names.includes(b.name), 'the remaining project keeps its earlier edits');
  while (e.redo()) assert.equal(e.projectId, 'B');
});

test('forgetting another project removes its redo documents while preserving the current preview and undo history', () => {
  const a = createStructuredTemplate('scout'), b = createStructuredTemplate('bunker'), e = new Editor(a, 'A');
  e.change(source => { source.name = 'A editado'; }); e.replace(b, 'B'); e.change(source => { source.name = 'B editado'; });
  assert(e.undo()); assert(e.undo()); assert.equal(e.projectId, 'A'); assert(e.future.some(document => document.projectId === 'B'));
  e.select('hull:front'); e.begin(); e.source.name = 'A em prévia'; e.preview();
  e.blockedEdit = { message: 'Bloqueado' };
  const document = e.document, preview = e.before, compiled = e.blueprint, past = structuredClone(e.past), events = [];
  e.onchange = event => events.push(event.kind);
  assert.equal(e.forgetProject('B'), false);
  assert.equal(e.document, document); assert.equal(e.before, preview); assert.equal(e.blueprint, compiled);
  assert.equal(e.source.name, 'A em prévia'); assert.equal(e.selection, 'hull:front'); assert.equal(e.blockedEdit.message, 'Bloqueado');
  assert.deepEqual(e.past, past); assert.deepEqual(e.future, []); assert.deepEqual(events, []);
  e.commit(); assert(e.undo()); assert.equal(e.projectId, 'A'); assert.equal(e.source.name, 'A editado');
  assert(e.undo()); assert.deepEqual(e.source, a); assert.equal(e.projectId, 'A'); assert.equal(e.redo(), true); assert.equal(e.projectId, 'A');
});

test('module previews use direct poses, preserve authoring and report actual overlap', () => {
  const e = editor(), before = structuredClone(e.source), point = { x: 11, y: 4.3 }, plan = e.planModule('engine', point);
  assert.equal(plan.refused, false); assert.equal(plan.reason, ''); assert(plan.module);
  assert.deepEqual(e.source, before); assert.equal(e.past.length, 0);
  const installed = e.addModule('engine', point); checkCanonical(e);
  assert.deepEqual(e.source.components[0].pose, { x: -20, y: 60, angle: 0 }); // -1 m, 3 m, in cells
  const occupied = e.planModule('engine', installed), history = e.past.length, source = structuredClone(e.source);
  assert(occupied.overlap); assert(occupied.reason); assert.equal(occupied.source, null);
  assert.throws(() => e.addModule('engine', installed), { reason: 'CONSTRUCTION_OVERLAP' });
  assert.equal(e.past.length, history); assert.deepEqual(e.source, source);
});

test('grid-assisted component movement and precise numeric rotation retain one authored pose', () => {
  const e = editor(), first = e.addModule('engine', { x: 11, y: 4.3 });
  e.begin(); assert(e.moveSelection(e.captureSelection(), .17, .18)); assert(e.commit());
  // From -1 m, 3 m to the cell nearest -.83 m, 3.18 m: -.85 m, 3.2 m.
  const part = e.source.components.find(part => part.id === first.id);
  assert.equal(part.pose.x, -17); assert.equal(part.pose.y, 64);
  e.editProperty('angle', .7, true); assert.equal(e.source.components.find(part => part.id === first.id).pose.angle, .7);
  assert.equal('placement' in e.source.components[0], false); checkCanonical(e);
});

test('the running gear comes only with the chassis, while exposed sensors need no support', () => {
  const e = editor(), before = e.source;
  for (const kind of ['wheel', 'track']) assert.throws(() => e.addModule(kind, { x: 11, y: .3 }), /vêm com o chassi/);
  assert.equal(e.source, before); assert.equal(e.past.length, 0);
  const camera = e.addModule('sensor', { x: 15, y: 5 }, { sensorMode: 'radar' });
  assert.equal(camera.sensorMode, 'radar'); assert.equal('placement' in e.source.components[0], false); checkCanonical(e);
});

test('weapons use explicit free poses and preserve the selected mounting and calibre', () => {
  const e = editor(), gun = e.addModule('weapon', { x: 8, y: 4 }, { weaponPreset: 'minimi', sector: { min: -.08, max: .08 } });
  const authored = () => e.source.components.find(part => part.id === gun.id);
  assert(authored().mount.preset); assert.equal(authored().pose.angle, Math.PI);
  assert.throws(() => e.editProperty('sizeScale', 2, true), /modelo e calibre/);
  assert.throws(() => e.editProperty('x', 15, true), /arraste-a/);
  e.editProperty('weaponPreset', 'm2hb', true); assert.equal(authored().weaponPreset, 'm2hb');
  assert.equal(authored().pose.angle, Math.PI); checkCanonical(e);
});

test('ammunition choices survive compatible weapon swaps and cannot change non-weapons', () => {
  const e = new Editor(createStructuredTemplate('ifv'), 'saved-structured'), gun = e.source.components.find(part => part.kind === 'weapon'),
    fed = () => e.source.components.find(part => part.id === gun.id), module = () => compileStructuredConstruction(e.source).modules.find(part => part.id === gun.id);
  assert.equal(fedAmmo(gun), 'ap');
  e.select(gun.id); e.editProperty('weaponAmmo', 'he', true); assert.equal(fed().weaponAmmo, 'he'); assert.equal(module().weaponAmmo, 'he');
  assert.equal(fixedWeapon({ platform: 'vehicle', componentId: gun.id, ammo: 'ap' }, compileStructuredConstruction(e.source).modules).ammo, 'he');
  e.editProperty('weaponAmmo', 'ap', true); assert.equal('weaponAmmo' in fed(), false);
  const before = structuredClone(e.source); assert.throws(() => e.editProperty('weaponAmmo', 'smoke', true), /munição/); assert.deepEqual(e.source, before);
  const box = e.source.components.find(part => part.kind === 'ammo'); e.select(box.id); assert.throws(() => e.editProperty('weaponAmmo', 'he', true), /munição/);
  e.select(gun.id); e.editProperty('weaponAmmo', 'he', true); e.editProperty('weaponPreset', 'rh202', true); assert.equal(fed().weaponAmmo, 'he');
  e.editProperty('weaponPreset', 'm2hb', true); assert.equal('weaponAmmo' in fed(), false); checkCanonical(e);
});

test('one calibre has one ammunition choice and the reserve carries rounds of its actual mass', () => {
  const stock = createStructuredTemplate('ifv'), gun = stock.components.find(part => part.kind === 'weapon'),
    source = { ...stock, components: stock.components.map(part => part.id === gun.id ? { ...part, weaponAmmo: 'he' } : part) },
    twin = { id: 'twin', kind: 'weapon', weaponPreset: gun.weaponPreset, weaponAmmo: 'ap',
      pose: { x: -80, y: 70, angle: Math.PI }, mount: { preset: gun.mount.preset, sector: { min: -.04, max: .04 } } },
    e = new Editor(planStructuredComponent(source, twin).construction),
    fed = () => e.source.components.filter(part => part.weaponPreset === gun.weaponPreset).map(fedAmmo),
    reserve = () => compileStructuredConstruction(e.source).modules.find(part => part.kind === 'ammo' && part.ammoPreset === gun.weaponPreset);
  assert.deepEqual(fed(), ['he', 'he']); assert.equal(reserve().roundMass, cartridgeOf(gun.weaponPreset, 'he').massKg);
  const rounds = reserve().rounds; e.select('twin'); e.editProperty('weaponAmmo', 'ap', true);
  assert.deepEqual(fed(), ['ap', 'ap']); assert.equal(reserve().rounds, rounds); assert.equal(reserve().roundMass, cartridgeOf(gun.weaponPreset, 'ap').massKg);
  assert.throws(() => validateStructuredConstruction({ ...e.source, components: e.source.components.map(part => part.id === 'twin' ? { ...part, weaponAmmo: 'he' } : part) }), { reason: 'AMMUNITION_MISMATCH', ids: ['twin'] });
});

test('armour properties, isolated duplication and open-hull deletion are ordinary history edits', () => {
  const e = editor(), before = structuredClone(e.source); e.select('hull:front');
  e.editProperty('thicknessMm', 120, true); e.editProperty('material', 'ceramic', true);
  assert.equal(e.selected.thicknessMm, 120); assert.equal(e.selected.material, 'ceramic');
  const edited = e.source; assert.throws(() => e.editProperty('widthM', 2, true), /nós e chapas/); assert.equal(e.source, edited);
  assert.equal(e.duplicate().plates.length, 1); e.remove(); assert.equal(e.source.plates.length, before.plates.length - 1);
  assert.equal(e.blueprint.rooms.length, 0); assert(e.undo()); assert(e.undo()); assert(e.undo()); assert.deepEqual(e.source, before);
});

test('duplication remains a cursor intent and a failed installation preserves history', () => {
  const e = editor(), fuel = e.addModule('fuel', { x: 12.1, y: 4.3 }, { sizeScale: .5 }), before = structuredClone(e.source), history = e.past.length;
  const intent = e.duplicate(); assert.deepEqual(e.source, before); assert.equal(e.past.length, history);
  assert.equal(e.planModule(intent.kind, fuel, intent).source, null);
  assert.throws(() => e.addModule(intent.kind, fuel, intent), { reason: 'CONSTRUCTION_OVERLAP' });
  const point = { x: 10.9, y: 4.3 }, plan = e.planModule(intent.kind, point, intent); assert(plan.source, plan.reason);
  const copy = e.addModule(intent.kind, point, intent); assert.notEqual(copy.id, fuel.id); assert.equal(copy.id, plan.module.id);
  assert.equal(e.source.components[1].sizeScale, .5); assert.equal(e.past.length, history + 1); assert(e.undo()); assert.deepEqual(e.source, before);
});

test('authoring refuses out-of-bounds pieces at their chosen size without resizing them', () => {
  const e = editor(), source = structuredClone(e.source), history = e.past.length,
    plan = e.planModule('engine', { x: 25, y: 4.3 }, { sizeScale: 2 });
  assert.equal(plan.source, null); assert.equal(plan.module.sizeScale, 2); assert(plan.reason);
  assert.throws(() => e.addModule('engine', { x: 25, y: 4.3 }, { sizeScale: 2 }));
  assert.deepEqual(e.source, source); assert.equal(e.past.length, history);
});

test('component authoring and duplicate admission use the field quota', () => {
  const e = new Editor(createStructuredConstruction({ preset: 'bunker', length: 11, height: 3, thicknessMm: 10, frontInset: 0, rearInset: 0 }));
  for (let i = 0; i < PART_LIMITS.components; i++) e.addModule('fuel', { x: 7.2 + .6 * i, y: 1.2 }, { sizeScale: .5 });
  const before = structuredClone(e.source), history = e.past.length, plan = e.planModule('fuel', { x: 12, y: 2.4 }, { sizeScale: .5 });
  assert.equal(plan.source, null); assert.equal(plan.reason, CAPACITY);
  assert.throws(() => e.addModule('fuel', { x: 12, y: 2.4 }, { sizeScale: .5 }), { message: CAPACITY });
  e.select(e.source.components[0].id); assert.throws(() => e.duplicate(), { message: CAPACITY });
  assert.deepEqual(e.source, before); assert.equal(e.past.length, history);
});

test('invalid pointer previews expose no non-finite drawing geometry or document changes', () => {
  const e = editor(), before = structuredClone(e.source), preview = e.planModule('fuel', { x: NaN, y: Infinity });
  assert.equal(preview.source, null); assert(preview.reason); assert.deepEqual(preview.modules, []); assert.deepEqual(preview.plates, []);
  assert.equal(preview.module, undefined); assert.deepEqual(e.source, before); checkCanonical(e);
});
