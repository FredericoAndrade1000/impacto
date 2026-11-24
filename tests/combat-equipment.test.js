import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { validateStructuredConstruction, compileStructuredConstruction, planStructuredComponent } from '../src/structured-construction.ts';
import { pieceCost, constructionCost } from '../src/construction-cost.ts';
import { reserveState } from '../src/component-volume.ts';
import { blueprintMass, blueprintPowertrain } from '../src/mass-properties.ts';
import { compileBlueprint, parseBlueprint, serializeBlueprint, DESIGN_VERSION } from '../src/persistence.ts';
import { closedFrame } from '../src/lab-constructions.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { metresOf } from '../src/grid.ts';
import { writtenPose } from './helpers/designs.js';

await initNativeDynamics();

test('a command computer has fixed physical size, mass, price and persistence', () => {
  const b = createConstruction('scout'), computer = b.components.find(m => m.kind === 'command'),
    bare = { ...b, components: b.components.filter(m => m !== computer) };
  const before = compileBlueprint(bare), mass = before.fixedAssembly.mass, cost = constructionCost(before).total,
    compiled = compileBlueprint(b), installed = compiled.modules.find(m => m.id === computer.id);
  assert.equal(installed.physicalMass, 8); assert.equal(pieceCost(installed), 800);
  assert.equal(installed.width, .44); assert.equal(installed.height, .28);
  assert(Math.abs(compiled.fixedAssembly.mass - mass - 8) < 1e-8);
  assert.equal(constructionCost(compiled).total, cost + 800);
  assert.equal(installed.attached, true);
  assert.throws(() => validateStructuredConstruction({ ...b, components: b.components.map(part =>
    part.id === computer.id ? { ...part, sizeScale: .5 } : part) }), { reason: 'FIELD' });
  assert.deepEqual(parseBlueprint(serializeBlueprint(b)).components.find(m => m.kind === 'command'), computer);
});

test('reconnaissance and artillery templates have one connected command, connected guns fed by their own rounds, and their sensors', () => {
  for (const id of ['recon', 'mortar', 'howitzer']) {
    const b = compileBlueprint(createConstruction(id));
    assert.equal(b.mechanicalAdmission, true);
    assert.equal(b.modules.filter(m => m.kind === 'command').length, 1);
    const guns = b.modules.filter(m => m.kind === 'weapon');
    assert(guns.length > 0);
    for (const gun of guns) assert(b.modules.some(m => m.kind === 'ammo' && m.ammoPreset === gun.weaponPreset && reserveState(m).rounds > 0), id);
    // Includes the installed basic sensors and the frame of the chassis.
    const cost = constructionCost(b);
    assert(Number.isInteger(cost.total) && cost.total > 0 && cost.chassis > 0);
    assert.equal(cost.total, Object.entries(cost).reduce((sum, [group, value]) => group === 'total' ? sum : sum + value, 0));
    // The recon vehicle carries its three distinct sensor channels.
    if (id === 'recon') assert.deepEqual(b.modules.filter(m => m.kind === 'sensor').map(m => m.sensorMode).sort(), ['radar', 'sound', 'visual']);
  }
});

// A long hull with a gun on its front, its rounds, an engine and its fuel inside, and a command computer in the middle.
function longHull() {
  // This large 40 mm hull needs four real axles, rather than the new two-axle default (in cells: ±4 m and ±1.3 m).
  let source = validateStructuredConstruction({ version: DESIGN_VERSION, preset: 'vehicle', name: 'Casco largo',
    chassis: { model: 'wheeled', points: [{ x: -100, y: 0 }, { x: 100, y: 0 }], thicknessMm: 40, axles: [-80, -26, 26, 80] },
    ...closedFrame([[-5, 0], [5, 0], [4.9, 4], [-4.5, 4]], ['floor', 'rear', 'roof', 'front'],
      () => ({ material: 'steel', thicknessMm: 40 })), components: [] });
  for (const part of [
    { id: 'ammo', kind: 'ammo', ammoPreset: 'rh120', sizeScale: 1, pose: { x: -2.1, y: .385, angle: 0 } },
    { id: 'gun', kind: 'weapon', weaponPreset: 'rh120',
      pose: { x: -4.4120463626708775, y: 2.56713079533386, angle: 3.017237659043032 },
      mount: { preset: 'heavy-trunnion', sector: { min: -.08, max: .08 }, radiusM: .3 } },
    { id: 'engine', kind: 'engine', sizeScale: 1, pose: { x: 2.55, y: 2.285, angle: 0 } },
    { id: 'fuel', kind: 'fuel', sizeScale: 1, pose: { x: 2.4, y: 1.335, angle: 0 } },
    { id: 'command', kind: 'command', sizeScale: 1, pose: { x: .25, y: 2.085, angle: 0 } },
  ]) source = planStructuredComponent(source, { ...part, pose: writtenPose(part.pose) }).construction;
  return source;
}

test('an explicitly positioned piece retains its pose, and native mass and powertrain include every piece', () => {
  const source = longHull(), before = structuredClone(source), compiled = compileStructuredConstruction(source),
    command = compiled.modules.find(module => module.id === 'command'), authored = source.components.find(part => part.id === command.id);
  assert.equal(command.x, 12 + metresOf(authored.pose.x)); assert.equal(command.y, 1.3 + metresOf(authored.pose.y));
  assert.equal(command.attached, true);
  assert.equal(blueprintMass(compiled), compiled.fixedAssembly.mass);
  const drive = blueprintPowertrain(compiled);
  assert(drive.powerKw > 0); assert(drive.fuelLitres > 0);
  assert.equal(drive.powerPerTonne, drive.powerKw / (blueprintMass(compiled) / 1000));
  assert.deepEqual(source, before);
  const overlap = structuredClone(source); overlap.components.at(-1).pose = { ...overlap.components[0].pose };
  assert.throws(() => compileBlueprint(overlap), { code: 'CONSTRUCTION_OVERLAP' });
});
