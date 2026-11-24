import test from 'node:test';
import assert from 'node:assert/strict';
import { designation } from '../src/designation.ts';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';

const compiled = model => compileStructuredConstruction(createStructuredTemplate(model));

test('a construction on the field is named for its kind and its largest gun', () => {
  for (const [model, name] of [['heavy', 'Tanque 120 mm'], ['ifv', 'Blindado 25 mm'], ['scout', 'Viatura 12,7 mm'],
    ['recon', 'Viatura 12,7 mm'], ['mortar', 'Porta-morteiro 81 mm'], ['howitzer', 'Obuseiro 155 mm'],
    ['chassis', 'Transporte'], ['tracked', 'Transporte'], ['truck', 'Caminhão de minério'], ['tanker', 'Caminhão-cisterna'],
    ['supply', 'Caminhão de suprimentos'], ['construction-truck', 'Veículo construtor'], ['grader', 'Motoniveladora'], ['paver', 'Pavimentadora'], ['bunker', 'Casamata 30 mm'], ['outpost', 'Casamata 7,62 mm'], ['oil-well', 'Poço de petróleo'], ['mining-site', 'Posto de mineração'], ['plate', 'Estrutura'], ['empty', 'Estrutura']])
    assert.equal(designation(compiled(model)), name, model);
  const heavy = compiled('heavy'), ifv = compiled('ifv'), chassis = compiled('chassis');
  // A cannon on wheels is no tank, and what cannot drive is a chassis.
  assert.equal(designation({ ...heavy, modules: heavy.modules.map(m => m.kind === 'track' ? { ...m, kind: 'wheel' } : m) }), 'Caça-tanques 120 mm');
  assert.equal(designation({ ...chassis, modules: chassis.modules.filter(m => m.kind !== 'engine') }), 'Chassi');
  // One with no gun is named for what it carries in: a hopper makes a truck of it, whatever else it has, and a gun a fighting vehicle.
  const truck = compiled('truck'), cistern = compiled('tanker').modules.find(m => m.kind === 'cistern');
  assert.equal(designation({ ...truck, modules: [...truck.modules, cistern] }), 'Caminhão de minério');
  assert.equal(designation({ ...truck, modules: truck.modules.filter(m => m.kind !== 'engine') }), 'Chassi');
  assert.equal(designation({ ...truck, modules: [...truck.modules, compiled('scout').modules.find(m => m.kind === 'weapon')] }), 'Viatura 12,7 mm');
  // The largest gun names it, whatever else it carries and wherever in the design that gun comes.
  const cannon = heavy.modules.find(m => m.kind === 'weapon'), small = ifv.modules.find(m => m.kind === 'weapon');
  for (const guns of [[cannon, small], [small, cannon]])
    assert.equal(designation({ ...ifv, modules: [...ifv.modules.filter(m => m.kind !== 'weapon'), ...guns] }), 'Tanque 120 mm');
});

test('both chassis types are named for their running gear and equipment', () => {
  for (const kind of ['wheeled', 'tracked']) {
    const modules = [{ kind: 'engine' }, { kind: kind === 'wheeled' ? 'wheel' : 'track' }],
      chassis = { model: kind },
      vehicle = { preset: 'vehicle', chassis, modules };
    assert.equal(designation(vehicle), 'Transporte', kind);
    assert.equal(designation({ ...vehicle, modules: [...modules, { kind: 'weapon', weaponPreset: 'm2hb' }] }), 'Viatura 12,7 mm', kind);
    assert.equal(designation({ ...vehicle, modules: [...modules, { kind: 'weapon', weaponPreset: 'rh120' }] }),
      kind === 'wheeled' ? 'Caça-tanques 120 mm' : 'Tanque 120 mm', kind);
  }
});

test('a vehicle with no gun and nothing to carry in is named for its tool, or for what it watches with but the camera', () => {
  const sensor = sensorMode => ({ kind: 'sensor', sensorMode });
  for (const [running, excavator] of [['wheel', 'Retroescavadeira'], ['track', 'Escavadeira']]) {
    const named = (...more) => designation({ preset: 'vehicle', modules: [{ kind: 'engine' }, { kind: running }, sensor('visual'), ...more] });
    assert.equal(named(), 'Transporte', running);
    assert.equal(named({ kind: 'excavator' }), excavator, running);
    assert.equal(named({ kind: 'drill' }), 'Perfuratriz', running);
    assert.equal(named(sensor('radar'), sensor('sound')), 'Viatura de radar', running);
    assert.equal(named(sensor('sound')), 'Viatura de escuta', running);
    // What it carries in names it first, and a gun before all.
    assert.equal(named({ kind: 'excavator' }, { kind: 'hopper' }), 'Caminhão de minério', running);
    assert.equal(named({ kind: 'drill' }, { kind: 'cistern' }), 'Caminhão-cisterna', running);
    assert.equal(named(sensor('radar'), { kind: 'weapon', weaponPreset: 'm2hb' }), 'Viatura 12,7 mm', running);
  }
});

test('the field calls a construction by what it is, and its design keeps the name its author gave it', t => {
  const source = { ...createStructuredTemplate('heavy'), name: 'Fúria do sertão' }, world = new World(source);
  t.after(() => world.dispose());
  const added = world.addActor({ ...createStructuredTemplate('mortar'), name: 'Trovão' }, { id: 'other', ownerId: 'bob', x: 40, facing: -1 });
  assert.deepEqual(world.actors.map(a => a.name), ['Tanque 120 mm', 'Porta-morteiro 81 mm']);
  assert.deepEqual(world.snapshot().actors.map(a => a.name), ['Tanque 120 mm', 'Porta-morteiro 81 mm']);
  assert.equal(added.construction.name, 'Trovão'); assert.equal(world.snapshot().name, 'Fúria do sertão');
  // Rebuilt with another design, it is called by the new one.
  assert.equal(world.replaceActor(createStructuredTemplate('ifv'), { id: 'other' }).name, 'Blindado 25 mm');
});
