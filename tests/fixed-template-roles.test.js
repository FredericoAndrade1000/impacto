import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { designBill, billTotal } from '../src/economy.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { constructionSupportSite } from '../src/construction-admission.ts';
import { compileManufacture } from '../src/structured-construction.ts';
import { coldConstructionPlacement, constructionSpan } from '../src/construction-placement.ts';
import { Terrain } from '../src/terrain.ts';

const model = id => compileBlueprint(createConstruction(id));
const cost = id => billTotal(designBill(model(id)));

test('every ready-made fixed model passes actual manufacturing support on level ground in both directions', () => {
  const terrain = new Terrain('flat');
  for (const { id } of CONSTRUCTION_TEMPLATES.filter(t => t.type === 'structure')) for (const facing of [-1, 1]) {
    const source = createConstruction(id), b = compileBlueprint(source),
      placement = coldConstructionPlacement(b, terrain, { facing, settle: true }),
      site = constructionSupportSite(terrain, placement, constructionSpan(b));
    assert.equal(compileManufacture(source, site).compiled.mechanicalAdmission, true, `${id}, facing ${facing}`);
  }
});

test('ready-made defences have distinct affordable roles and pay only for their own equipment', () => {
  const ids = ['guard-post', 'outpost', 'bunker'], prices = ids.map(cost);
  assert(prices[0] < prices[1] && prices[1] < prices[2]);
  assert(prices[1] < 20000, 'a machine-gun post is an intermediate work, not the old 42k surveillance bunker');
  assert(prices[2] < 50000, 'the autocannon bunker avoids the old 65k radar and steel-roof bill');
  for (const [i, id] of ids.entries()) {
    const b = model(id), source = createConstruction(id);
    assert.equal(b.vehicle.enabled, false);
    assert.equal(b.chassis, undefined);
    assert.deepEqual(b.modules.map(p => p.kind).sort(), ['ammo', 'command', 'sensor', 'weapon']);
    assert.deepEqual(b.modules.filter(p => p.kind === 'sensor').map(p => p.sensorMode), ['visual']);
    assert.equal(b.modules.find(p => p.kind === 'weapon').weaponPreset, ['minimi', 'fnmag', 'mk44'][i]);
    assert(b.modules.find(p => p.kind === 'ammo').capacityRounds > 0);
    assert.equal(designBill(b).combustivel, 0);
    assert.deepEqual(parseBlueprint(serializeBlueprint(source)), source, 'the model remains an ordinary editable design');
  }
  const post = model('outpost'), bunker = model('bunker');
  for (const b of [post, bunker]) assert(b.plates.every(p => p.material === 'concrete'));
  assert(bunker.plates.find(p => p.id === 'hull:front').thicknessMm > post.plates.find(p => p.id === 'hull:front').thicknessMm);
  assert(bunker.plates.find(p => p.id === 'hull:roof').thicknessMm > post.plates.find(p => p.id === 'hull:roof').thicknessMm);
});

test('fixed extractors pair full-sized tools with adequate engines and useful fuel, without unused cargo or combat parts', () => {
  assert.equal(CONSTRUCTION_TEMPLATES.find(t => t.id === 'mining-site')?.type, 'structure');
  for (const [id, tool] of [['mining-site', 'excavator'], ['oil-well', 'drill']]) {
    const source = createConstruction(id), b = compileBlueprint(source), machine = b.modules.find(p => p.kind === tool);
    assert.equal(source.preset, 'bunker'); assert.equal(source.chassis, undefined);
    assert.equal(b.vehicle.enabled, false);
    assert.deepEqual(b.modules.map(p => p.kind).sort(), ['command', tool, 'engine', 'fuel', 'sensor'].sort());
    assert(b.powertrain.powerKw > machine.workKw && b.powertrain.powerKw <= machine.workKw * 1.11,
      'the engine runs the unscaled tool at full pace with a small margin');
    assert.equal(machine.exposed, true);
    assert.equal(source.components.find(p => p.kind === tool).sizeScale, 1);
    assert(b.modules.find(p => p.kind === 'fuel').capacityLitres >= 200);
    assert.equal(b.modules.find(p => p.kind === 'sensor').sensorMode, 'visual');
    assert.deepEqual(parseBlueprint(serializeBlueprint(source)), source);
  }
  assert(cost('mining-site') < cost('mining-truck') * .6, 'a stationary producer saves the cost of mobility and its ore hopper');
});
