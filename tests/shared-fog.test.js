import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint, validateBlueprint, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { pieceMass } from '../src/mass-properties.ts';
import { pieceCost } from '../src/construction-cost.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { perceptionScene, instrumentBlueprint, addCover, instrument, health, until, moveTarget, sensed } from './helpers/perception-scene.js';

const armed = ['heavy', 'scout', 'recon', 'mortar', 'howitzer', 'ifv', 'bunker', 'outpost'];
test('stock designs have connected broad vision without redundant tracking hardware', () => {
  assert.deepEqual(Object.keys(SENSOR_MODES), ['visual', 'radar', 'sound']);
  for (const id of armed) {
    const blueprint = createConstruction(id), compiled = compileBlueprint(blueprint), modes = compiled.modules.filter(m => m.kind === 'sensor').map(s => s.sensorMode);
    assert.equal(compiled.mechanicalAdmission, true, id);
    assert.deepEqual(modes, id === 'recon' ? ['visual', 'radar', 'sound'] : ['visual'], id);
    assert.equal(new Set(modes).size, modes.length);
    assert.deepEqual(parseBlueprint(serializeBlueprint(blueprint)), validateBlueprint(blueprint));
  }
});

test('basic camera radar and sound modules retain their explicit footprint mass and cost', () => {
  for (const [mode, mass, cost, width, height] of [['visual', 4, 1500, .32, .24], ['radar', 35, 12000, .65, .546], ['sound', 3, 250, .32, .24]]) {
    const blueprint = instrumentBlueprint({ mode }), sensor = compileBlueprint(blueprint).modules.find(m => m.kind === 'sensor');
    assert(Math.abs(pieceMass(sensor) - mass - (sensor.support?.mass ?? 0)) < 1e-9, 'the installed mass adds exactly its physical support');
    assert.equal(pieceCost({ ...sensor, support: undefined }), cost);
    assert(pieceCost(sensor) >= cost, 'the support is paid for with the instrument');
    assert.equal(sensor.width, width); assert.equal(sensor.height, height);
    assert.equal(parseBlueprint(serializeBlueprint(blueprint)).components[0].sensorMode, mode);
    blueprint.components[0].sensorMode = 'omniscient'; assert.throws(() => validateBlueprint(blueprint), { reason: 'SENSOR_MODE' });
  }
});

test('a scout shortened or stretched keeps broad optical vision beside either other basic channel', () => {
  for (const other of ['radar', 'sound']) for (const [stretch, armourScale] of [[.94, .55], [1.06, 1.35]]) {
    const args = ['scout', { preset: 'm242', sensorModes: ['visual', other], stretch, armourScale }], blueprint = createConstruction(...args),
      compiled = compileBlueprint(blueprint), modes = compiled.modules.filter(m => m.kind === 'sensor').map(m => m.sensorMode);
    assert.equal(compiled.mechanicalAdmission, true);
    assert.deepEqual(modes, ['visual', other], 'only the requested channels; the Command keeps its own basic sight');
    assert.deepEqual(createConstruction(...args), blueprint); validateBlueprint(blueprint);
  }
});

test('distant ally sees exactly the shared measurement and remembered enemy never teleports behind cover', async t => {
  const world = await perceptionScene(t, { distance: 900, mode: null }),
    scout = world.addActor(instrumentBlueprint(), { id: 'scout', ownerId: 'blue', x: 700, facing: 1 });
  const own = sensed(world, 'own', 'enemy'), shared = sensed(world, scout.id, 'enemy');
  assert(own.detected && own.visible); assert.equal(own.source, 'team');
  assert.deepEqual(own, shared); assert.equal(own.classification, 'identified');
  addCover(world, 800, 8); moveTarget(world, { x: 1000, vx: 60 }); until(world, .2);
  const hidden = sensed(world, 'own', 'enemy'); assert.equal(hidden.source, 'memory');
  assert.equal(hidden.x, own.x); assert.equal(hidden.y, own.y); assert.equal(hidden.width, own.width);
  assert.equal(hidden.vx, own.vx); assert(hidden.age > 0); assert(!hidden.visible);
  assert.deepEqual(hidden, sensed(world, 'scout', 'enemy'));
  for (const key of ['modules', 'health', 'fuelLitres', 'rounds']) assert(!Object.hasOwn(hidden, key));
});

test('destroying the last allied camera stops new measurements and both observers see the same aging fog', async t => {
  const world = await perceptionScene(t, { distance: 900, mode: null });
  world.addActor(instrumentBlueprint(), { id: 'scout', ownerId: 'blue', x: 700, facing: 1 });
  const first = sensed(world, 'own', 'enemy'); health(world, instrument(world, 'visual', 'scout'), 0);
  moveTarget(world, { x: 950 }); until(world, .5);
  const old = sensed(world, 'own', 'enemy'); assert.equal(old.x, first.x); assert(Math.abs(old.age - .5) < 1e-9);
  assert.equal(old.source, 'memory'); assert(old.confidence < first.confidence);
  assert.deepEqual(old, sensed(world, 'scout', 'enemy')); until(world, 2.1);
  assert.equal(sensed(world, 'own', 'enemy').detected, false);
});
