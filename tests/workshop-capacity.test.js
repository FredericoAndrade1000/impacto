import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { createStructuredConstruction, compileStructuredConstruction, compileDraftConstruction } from '../src/structured-construction.ts';
import { chassisCapacity } from '../src/workshop-capacity.ts';
import { CHASSIS_ID } from '../src/chassis-editing.ts';
import { applySettings } from '../src/piece-settings.ts';
import { World } from '../src/physics.ts';

await initNativeDynamics();

test('capacity uses the compiler total with full reserves, including the chassis itself', () => {
  const editor = new Editor(createStructuredTemplate('tanker')), before = structuredClone(editor.source),
    compiled = editor.blueprint.chassis, capacity = chassisCapacity(editor.blueprint);
  assert.equal(capacity.loadedKg, compiled.loadedKg);
  assert.equal(capacity.limitKg, compiled.limitKg);
  assert.equal(capacity.marginKg, compiled.limitKg - compiled.loadedKg);
  assert.equal(capacity.emptyKg, compiled.emptyKg);
  assert.equal(capacity.frameLimitKg, compiled.frameLimitKg);
  assert.equal(capacity.gearLimitKg, compiled.gearLimitKg);
  assert(Number.isFinite(capacity.frameLimitKg) && Number.isFinite(capacity.gearLimitKg));
  assert(capacity.emptyKg < capacity.loadedKg, 'the cistern and fuel are included at full capacity');
  assert.equal(chassisCapacity(editor.blueprint), capacity, 'unchanged designs reuse the reading');
  assert.deepEqual(editor.source, before);
  assert.match(capacity.detail, /limites: estrutura .+ t, rodagem .+ t$/);
  assert.doesNotMatch(capacity.detail, /por eixo|por par|nominal|classe/);
  assert.equal(Object.hasOwn(capacity, 'axleLoads'), false, 'capacity never implies measured load on each axle');
  assert.equal(chassisCapacity(new Editor(createStructuredTemplate('plate')).blueprint), null);
});

test('changing the chassis or its armour updates the reading and undo restores it', () => {
  const editor = new Editor(createStructuredTemplate('chassis'));
  editor.select(CHASSIS_ID); applySettings(editor, 'axleCount', new Map([[CHASSIS_ID, 3]]));
  const beforeSource = structuredClone(editor.source), before = chassisCapacity(editor.blueprint);
  applySettings(editor, 'axleCount', new Map([[CHASSIS_ID, 2]]));
  const fewer = chassisCapacity(editor.blueprint);
  assert(fewer.gearLimitKg < before.gearLimitKg, 'fewer axles lower the running-gear limit');
  assert(fewer.limitKg <= before.limitKg, 'the structural limit may already be lower');
  assert(fewer.loadedKg < before.loadedKg, 'removing an axle removes its own mass too');
  assert(editor.undo()); assert.deepEqual(chassisCapacity(editor.blueprint), before);
  const proposedArmour = compileStructuredConstruction({ ...editor.source,
    chassis: { ...editor.source.chassis, armorMm: 10 } });
  editor.select(CHASSIS_ID); applySettings(editor, 'armorMm', new Map([[CHASSIS_ID, 10]]));
  const armoured = chassisCapacity(editor.blueprint);
  assert(armoured.loadedKg > before.loadedKg);
  assert.equal(armoured.frameLimitKg, before.frameLimitKg, 'gear armour does not reshape or strengthen the frame');
  assert.notEqual(armoured.gearLimitKg, before.gearLimitKg, 'added gear mass changes the cab-heavy design\'s support-load distribution');
  assert.deepEqual(armoured, chassisCapacity(proposedArmour), 'the HUD reads the same loaded envelope as the canonical proposal');
  assert.equal(armoured.limitKg, Math.min(armoured.frameLimitKg, armoured.gearLimitKg));
  assert(editor.undo()); assert.deepEqual(editor.source, beforeSource);
  assert.deepEqual(chassisCapacity(editor.blueprint), before);
});

test('capacity is over only past the limit, preserves overweight drafts and refuses their manufacture', () => {
  const projected = loadedKg => chassisCapacity({ chassis: { loadedKg, emptyKg: 7000, limitKg: 10000 } });
  assert.equal(projected(9000).margin, 'Sobram 1 t');
  assert.deepEqual([9999, 10000, 10001].map(kg => projected(kg).over), [false, false, true]);
  assert(['warn', 'notice'].every(key => !Object.hasOwn(projected(9999), key)), 'nearing the limit is warned of nowhere');
  assert.equal(projected(10000).marginKg, 0);
  assert.equal(projected(9990).margin, 'Sobram 10 kg');
  assert.equal(projected(10010).margin, '10 kg acima do limite');
  assert.equal(projected(9000).detail, 'Vazio: 7 t', 'missing structural fields are not invented or inferred from an old axle rating');
  // Four independent, square-ended plates: their lengths follow these authored
  // dimensions, without extra corner material from the retired automatic mitres.
  const source = createStructuredConstruction({ length: 5.4, height: 1.8, frontInset: .5, rearInset: .1, thicknessMm: 80 });
  source.appearance = { ...source.appearance, automaticDetails: false, details: [] };
  const editor = new Editor(source), before = structuredClone(editor.source),
    reading = chassisCapacity(editor.blueprint);
  for (const [id, length] of [['rear', Math.hypot(1.8, .1)],
    ['roof', 4.8], ['front', Math.hypot(1.8, .5)]]) {
    const plate = editor.blueprint.plates.find(part => part.id === 'hull:' + id);
    assert(Math.abs(plate.length - length) < 1e-9, 'capacity uses the explicitly authored plate blank');
  }
  assert(reading.ratio > 0 && reading.ratio < 1, 'the original hull is admitted below its actual limit');
  assert.equal(reading.over, false);
  const proposedRoof = { ...editor.source, plates: editor.source.plates.map(plate =>
    plate.id === 'hull:roof' ? { ...plate, thicknessMm: 1000 } : plate) };
  assert.throws(() => compileStructuredConstruction(proposedRoof), error => error.code === 'CHASSIS_OVERLOAD',
    'the unreinforced authoring remains a real refusal in the strict compiler');
  editor.select('hull:roof');
  editor.editProperty('thicknessMm', 1000, true);
  assert.equal(editor.source.plates.find(plate => plate.id === 'hull:roof').thicknessMm, 1000);
  const pending = chassisCapacity(editor.blueprint);
  assert(pending.loadedKg > reading.loadedKg);
  assert(pending.loadedKg > pending.limitKg); assert(pending.marginKg < 0);
  assert.equal(pending.over, true); assert.match(pending.margin, /^.+ acima do limite$/);
  assert.deepEqual(pending, chassisCapacity(compileDraftConstruction(editor.source)));
  assert.deepEqual(editor.source, proposedRoof, 'the edit preserves the requested armour without adding structure or axles');
  assert.equal(editor.blueprint.mechanicalAdmission, false);
  assert(editor.blueprint.admissionIssues.some(issue => issue.code === 'CHASSIS_OVERLOAD'));
  for (const manufacture of [compileStructuredConstruction, source => new World(source)])
    assert.throws(() => manufacture(editor.source), error => error.code === 'CHASSIS_OVERLOAD',
      'the editable projection cannot become an admitted physical vehicle');
  assert.equal(editor.past.length, 1);
  assert.equal(editor.selection, 'hull:roof');
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  assert.deepEqual(chassisCapacity(editor.blueprint), reading);
  assert(editor.redo()); assert.deepEqual(editor.source, proposedRoof);
  assert.deepEqual(chassisCapacity(editor.blueprint), pending);
  assert.throws(() => compileStructuredConstruction(editor.source), error => error.code === 'CHASSIS_OVERLOAD');
});
