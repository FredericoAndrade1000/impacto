import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredConstruction, compileStructuredConstruction, compileDraftConstruction,
  compileDraft, validateDraftConstruction } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { chassisAxles, chassisGearScale, frameThicknessMm, gearProblem, trackLength, writtenTrack } from '../src/chassis.ts';
import { planStructuredModule } from '../src/structured-editing.ts';
import { pointCells } from '../src/grid.ts';

await initNativeDynamics();
const roof = (source, thicknessMm) => ({ ...source, plates: source.plates.map(plate => plate.id === 'hull:roof' ? { ...plate, thicknessMm } : plate) });
const drawn = result => {
  assert.deepEqual(compileDraftConstruction(result.construction), result.compiled);
  assert.equal(gearProblem(result.construction.chassis), null);
  assert.equal(result.compiled.chassis.limitKg, Math.min(result.compiled.chassis.frameLimitKg, result.compiled.chassis.gearLimitKg));
};

test('valid drafts preserve the authored structure and running gear', () => {
  for (const id of ['scout', 'chassis', 'tanker', 'heavy']) {
    const source = createStructuredTemplate(id), before = structuredClone(source), result = compileDraft(source);
    assert.deepEqual(result.construction, source, id);
    assert.deepEqual(source, before); assert.equal(result.compiled.mechanicalAdmission, true); drawn(result);
  }
});

test('an overloaded draft keeps its gauge, wheel size and axle count but cannot be manufactured', () => {
  const source = createStructuredConstruction({ length: 8, height: 1.4, thicknessMm: 8 }),
    candidate = roof(source, 150), before = structuredClone(candidate), result = compileDraft(candidate);
  assert.throws(() => compileStructuredConstruction(candidate), error => error.code === 'CHASSIS_OVERLOAD');
  assert.deepEqual(result.construction, candidate);
  assert.equal(result.compiled.mechanicalAdmission, false); assert(result.compiled.admissionIssues.length > 0);
  assert(result.compiled.chassis.loadedKg > result.compiled.chassis.limitKg);
  assert.equal(chassisAxles(result.construction.chassis).length, 2);
  assert.equal(chassisGearScale(result.construction.chassis), 1);
  assert.equal(frameThicknessMm(result.construction.chassis), frameThicknessMm(source.chassis));
  assert.deepEqual(candidate, before); drawn(result);
});

test('an unbalanced draft retains its chosen axle centres and reports a manufacturing issue', () => {
  const source = createStructuredConstruction({ length: 6, height: 1.4, thicknessMm: 8 }),
    candidate = { ...source, chassis: { ...source.chassis, axles: [14, 40] } }, result = compileDraft(candidate);
  assert.throws(() => compileStructuredConstruction(candidate), { reason: 'CHASSIS_BALANCE', direction: 'front' });
  assert.deepEqual(result.construction, candidate);
  assert.equal(result.compiled.mechanicalAdmission, false); assert(result.compiled.admissionIssues.length > 0); drawn(result);
});

test('an unbalanced track retains its authored physical span and centre', () => {
  const source = createStructuredConstruction({ length: 6, height: 1.4, thicknessMm: 8, chassis: 'tracked' }),
    candidate = { ...source, chassis: { ...source.chassis, track: writtenTrack(source.chassis, .5, .5 + trackLength(source.chassis.model, 3, source.chassis)) } },
    result = compileDraft(candidate);
  assert.throws(() => compileStructuredConstruction(candidate), { reason: 'CHASSIS_BALANCE', direction: 'front' });
  assert.deepEqual(result.construction, candidate);
  assert.equal(result.compiled.mechanicalAdmission, false); drawn(result);
});

test('cached drafts never bypass manufacturing admission', () => {
  const source = createStructuredConstruction({ length: 6, height: 1.4, thicknessMm: 8 }), candidate = roof(source, 250);
  for (let n = 0; n < 3; n++) {
    const result = compileDraft(candidate);
    assert.equal(result.compiled.mechanicalAdmission, false); assert.deepEqual(result.construction.chassis, source.chassis);
    assert.throws(() => compileStructuredConstruction(candidate), error => error.code === 'CHASSIS_OVERLOAD');
    assert.deepEqual(validateDraftConstruction(candidate), candidate);
  }
  assert.equal(compileDraft(source).compiled.mechanicalAdmission, true);
});

test('a hull overhang does not extend an unselected chassis', () => {
  const source = createStructuredConstruction({ length: 6, height: 1.4, thicknessMm: 8 }),
    candidate = { ...source, nodes: source.nodes.map(node => node.x === 60 ? { ...node, x: 74 } : node) },
    before = structuredClone(candidate), result = compileDraft(candidate);
  assert.deepEqual(result.construction.chassis, source.chassis);
  assert.deepEqual(result.construction.nodes, candidate.nodes);
  assert.deepEqual(candidate, before); drawn(result);
});

test('exposed equipment keeps its pose and physical reserve without growing a support', () => {
  const source = createStructuredTemplate('chassis'), part = { id: 'exposed-fuel', kind: 'fuel', pose: { x: 80, y: 40, angle: .2 } },
    candidate = { ...source, components: [...source.components, part] }, result = compileDraft(candidate),
    installed = result.compiled.modules.find(module => module.id === part.id);
  assert.deepEqual(result.construction.chassis, source.chassis);
  assert.deepEqual(result.construction.components.find(component => component.id === part.id).pose, part.pose);
  assert(Math.abs(installed.x - 16) < 1e-7); assert(Math.abs(installed.y - 3.3) < 1e-7);
  assert(installed.capacityLitres > 0); drawn(result);
});

test('cargo preserves its requested size and full physical reserve', () => {
  const source = createStructuredTemplate('chassis'), part = { id: 'haul', kind: 'hopper', sizeScale: 1.8, pose: { x: 0, y: 80, angle: 0 } },
    candidate = { ...source, components: [...source.components, part] }, result = compileDraft(candidate),
    installed = result.compiled.modules.find(component => component.id === part.id);
  assert.equal(result.construction.components.find(component => component.id === part.id).sizeScale, part.sizeScale);
  // Four fifths of its room, 1.8 times as long and tall as the reference and as deep across the body.
  assert(Math.abs(installed.capacityM3 - 1.6 * .9 * 1.2 * .8 * 1.8 ** 2) < 1e-9, installed.capacityM3);
  assert(result.compiled.chassis.loadedKg - result.compiled.chassis.emptyKg >= installed.capacityM3 * 2400);
  assert.deepEqual(result.construction.chassis, source.chassis); drawn(result);
});

test('construction bounds remain admission errors for a free draft', () => {
  const source = createStructuredConstruction({ length: 6, height: 1.4, thicknessMm: 8 }),
    outside = { ...source, nodes: source.nodes.map(node => node.x === 60 ? { ...node, x: 122 } : node) };
  assert.throws(() => compileDraft(outside), { reason: 'FIELD', field: 'x' });
});

test('a blade cannot occupy actual tyres or track metal, but may share their x above them', () => {
  for (const model of ['wheeled', 'tracked']) {
    const box = createStructuredConstruction({ length: 6, thicknessMm: 8, chassis: model }),
      bare = { ...box, nodes: [], plates: [], components: [] },
      compiled = compileDraftConstruction(bare), gear = compiled.modules.find(part => ['wheel', 'track'].includes(part.kind)),
      blade = { id: 'blade', kind: 'blade', sizeScale: .25,
        pose: { ...pointCells({ x: gear.x - compiled.frame.origin.x, y: gear.y - compiled.frame.origin.y }), angle: 0 } };
    assert.throws(() => compileDraft({ ...bare, components: [blade] }), error => error.reason === 'COMPONENT_GEAR' &&
      error.ids.includes('blade') && error.ids.includes(gear.id), model);
    const above = { ...blade, pose: { ...blade.pose, y: 40 } }, made = compileDraft({ ...bare, components: [above] });
    assert.deepEqual(made.construction.components[0].pose, above.pose);
    assert.deepEqual(made.construction.chassis, bare.chassis);
  }
});

test('a gun copied with the plate it fires through fires through the copy, and the original through its own', () => {
  const source = createStructuredTemplate('guard-post'), before = structuredClone(source), compiled = compileDraftConstruction(source),
    gun = compiled.modules.find(part => part.kind === 'weapon'), component = source.components.find(part => part.id === gun.id),
    plate = source.plates.find(plate => plate.id === gun.weaponMount.hostId),
    nodes = new Map(compiled.frame.nodes.map(node => [node.id, node])),
    plan = planStructuredModule(source, 'weapon', { x: gun.x, y: gun.y + 3 }, {
      copies: [{ component, x: gun.x, y: gun.y }],
      plates: [{ plate, a: nodes.get(plate.a), b: nodes.get(plate.b) }], anchor: { x: gun.x, y: gun.y },
    });
  assert(plan.source, plan.reason);
  const copy = plan.source.components.find(part => part.id === plan.module.id), copiedPlate = plan.plates[0];
  assert.equal(Object.hasOwn(copy.mount, 'hostId'), false);
  assert.equal(plan.module.weaponMount.hostId, copiedPlate.id);
  assert.equal(plan.blueprint.modules.find(part => part.id === gun.id).weaponMount.hostId, plate.id);
  assert.deepEqual(source, before);
  assert.deepEqual(plan.source.components.filter(part => part.id !== copy.id), source.components);
});
