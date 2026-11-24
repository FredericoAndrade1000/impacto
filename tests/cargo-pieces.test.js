import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredConstruction, planStructuredComponent } from '../src/structured-construction.ts';
import { damageConstruction, interior } from './damage-fixtures.js';
import { MODULES } from '../src/materials.ts';
import { CARGO, carries, cargoRoom, cargoVolume, cargoMass, cargoSpace, componentDepth } from '../src/component-volume.ts';
import { componentSizeLimits, BODY_WIDTH } from '../src/component-size.ts';
import { pieceMass, blueprintMass } from '../src/mass-properties.ts';
import { pieceCost, constructionCost } from '../src/construction-cost.ts';
import { pieceSettings } from '../src/piece-settings.ts';
import { validateBlueprint, serializeBlueprint, compileBlueprint } from '../src/persistence.ts';
import { setPart } from './mechanical-queries.js';

const advance = (w, frames) => { for (let i = 0; i < frames; i++) { w.step(); w.drainEvents(); } };
const piece = (kind, options = {}) => compileBlueprint(damageConstruction({ length: 10, height: 5,
  components: [interior(kind, { x: -1, y: 1 }, kind, options)] })).modules[0];
// A plain truck with a hopper and a cistern in it.
const fitted = (design, parts) => parts.reduce((made, part) => planStructuredComponent(made, part).construction, design);
const hauler = () => {
  const source = createStructuredConstruction({ name: 'Misto', length: 7, height: 2.2, frontInset: .4, rearInset: .1, thicknessMm: 10 }),
    floor = source.nodes[0].y;
  // In cells over the floor node; the hopper and the cistern, 2 cm over the floor in metres, stand on the cell above it.
  return fitted(source, [
    { id: 'engine', kind: 'engine', sizeScale: 1, pose: { x: 55, y: floor + 7, angle: 0 } },
    { id: 'fuel', kind: 'fuel', sizeScale: 1, pose: { x: 32, y: floor + 8, angle: 0 } },
    { id: 'command', kind: 'command', sizeScale: 1, pose: { x: 57, y: floor + 19, angle: 0 } },
    { id: 'hopper', kind: 'hopper', sizeScale: 1, pose: { x: -40, y: floor + 10, angle: 0 } },
    { id: 'cistern', kind: 'cistern', sizeScale: 1, pose: { x: -8, y: floor + 10, angle: 0 } },
  ]);
};

test('a hopper and a cistern are pieces of their own size: what they take, weigh and cost follows their volume', () => {
  const hopper = piece('hopper'), cistern = piece('cistern');
  assert.deepEqual([hopper.width, hopper.height, componentDepth(hopper), hopper.maxHealth, hopper.health], [1.6, .9, 1.2, 120, 120]);
  assert.deepEqual([cistern.width, cistern.height, componentDepth(cistern), cistern.maxHealth, cistern.health], [1.4, .9, 1.1, 90, 90]);
  assert.deepEqual([MODULES.hopper.name, MODULES.cistern.name], ['Caçamba', 'Cisterna']);
  // Empty as a design has them: four fifths of a hopper are room for ore, and a little less of a cistern for petroleum.
  assert.deepEqual([hopper.physicalMass, pieceMass(hopper), pieceCost(hopper), cargoMass(hopper)], [380, 380, 900, 0]);
  assert.deepEqual([cistern.physicalMass, pieceMass(cistern), pieceCost(cistern), cargoMass(cistern)], [260, 260, 1100, 0]);
  assert(Math.abs(hopper.capacityM3 - 1.6 * .9 * 1.2 * .8) < 1e-12 && Math.abs(cistern.capacityM3 - 1.4 * .9 * 1.1 * .78) < 1e-12);
  assert.deepEqual([cargoRoom(hopper), cargoRoom(cistern), cargoRoom(piece('fuel'))], [hopper.capacityM3, cistern.capacityM3, 0]);
  // Its size makes it longer and taller and leaves it as deep across the body: it weighs, costs and takes the square of
  // its size, as much more as the side view shows of it.
  for (const factor of [.5, 1.5, 2]) for (const [kind, reference] of [['hopper', hopper], ['cistern', cistern]]) {
    const scaled = piece(kind, { sizeScale: factor });
    assert(Math.abs(scaled.physicalMass - reference.physicalMass * factor ** 2) < 1e-9 && Math.abs(scaled.capacityM3 - reference.capacityM3 * factor ** 2) < 1e-12, `${kind} × ${factor}`);
    assert.equal(pieceCost(scaled), Math.ceil(pieceCost(reference) * factor ** 2 - 1e-9));
    for (const [size, at] of [[scaled.width, reference.width], [scaled.height, reference.height]])
      assert(Math.abs(size - at * factor) < 1e-12, 'its length and its height by the one scale');
    assert.deepEqual([componentDepth(scaled), scaled.mechanicalDepth], [componentDepth(reference), reference.mechanicalDepth], 'as deep at any size');
  }
  // A hopper, a cistern and a supply piece grow up to three times their size, as deep as at the reference one, and weigh,
  // cost and take nine times what they do there.
  for (const kind of ['hopper', 'cistern', 'supply']) {
    const { width, height, depthM } = MODULES[kind], reference = piece(kind), largest = piece(kind, { sizeScale: 3 });
    assert.deepEqual(componentSizeLimits({ kind }), { min: .25, max: 3 });
    assert.deepEqual([largest.width, largest.height, componentDepth(largest), largest.mechanicalDepth], [width * 3, height * 3, depthM, depthM]);
    assert(Math.abs(largest.physicalMass - reference.physicalMass * 9) < 1e-9 && Math.abs(largest.capacityM3 - reference.capacityM3 * 9) < 1e-12, kind);
    assert(Math.abs(largest.capacityM3 - width * height * 9 * depthM * { hopper: .8, cistern: .78, supply: .7 }[kind]) < 1e-12, kind);
    assert.equal(pieceCost(largest), Math.ceil(pieceCost(reference) * 9 - 1e-9));
    assert(depthM < BODY_WIDTH);
    assert.throws(() => piece(kind, { sizeScale: 3.05 }));
  }
  // Every other piece stays within 4 m long and tall.
  assert.deepEqual(['engine', 'fuel', 'ammo', 'excavator', 'drill', 'builder'].map(kind => componentSizeLimits({ kind }).max), [3.8, 5, 5.1, 3.3, 3.05, 3.3]);
  // The bar over a selected one edits its size and explicit orientation.
  for (const kind of ['hopper', 'cistern', 'supply'])
    assert.deepEqual(pieceSettings(piece(kind), { kind, sizeScale: 1, pose: { x: -1, y: 1, angle: 0 } })
      .map(s => [s.key, s.label, s.unit, s.value, s.min, s.max]), [
      ['sizeScale', 'Tamanho', '%', 100, 25, 300], ['angle', 'Ângulo', '°', 0, -180, 180],
    ]);
  // Solids go in the one and liquids in the other.
  assert.deepEqual(Object.keys(CARGO), ['ferro', 'ligas', 'silica', 'petroleo']);
  assert.deepEqual(Object.keys(CARGO).map(name => [carries(hopper, name), carries(cistern, name)]), [[true, false], [true, false], [true, false], [false, true]]);
  assert.deepEqual([carries(piece('fuel'), 'petroleo'), carries(hopper, 'ouro')], [false, false]);
  // A unit of ore is a kilogram and one of petroleum a litre: how many fit goes by what a cubic metre of each weighs.
  assert(Math.abs(cargoSpace(hopper, 'ferro') - hopper.capacityM3 * 2400) < 1e-9 && Math.abs(cargoSpace(hopper, 'ligas') - hopper.capacityM3 * 1500) < 1e-9 &&
    Math.abs(cargoSpace(hopper, 'silica') - hopper.capacityM3 * 1600) < 1e-9 && Math.abs(cargoSpace(cistern, 'petroleo') - cistern.capacityM3 * 1000) < 1e-9);
  assert.deepEqual([cargoSpace(hopper, 'petroleo'), cargoSpace(cistern, 'ferro')], [0, 0]);
  const half = { ...hopper, cargo: { ferro: hopper.capacityM3 * 1200, silica: 80 } };
  assert(Math.abs(cargoVolume(half) - hopper.capacityM3 / 2 - .05) < 1e-12 && Math.abs(cargoMass(half) - hopper.capacityM3 * 1200 - 80) < 1e-9);
  assert(Math.abs(cargoSpace(half, 'ligas') - (hopper.capacityM3 / 2 - .05) * 1500) < 1e-9);
  // A piece on the field weighs what the core last weighed; a missing measurement is an invalid projection.
  assert.equal(pieceMass(half), 380);
  assert.throws(() => pieceMass({ ...half, physicalMass: undefined }), TypeError);
  assert(Math.abs(cargoMass({ ...cistern, cargo: { petroleo: 1000 } }) - 850) < 1e-9, 'a litre of petroleum weighs 850 g');
});

test('what a piece carries is weighed into the one body a step of load at a time, and a piece takes only its kind, as far as it has room', t => {
  const w = new World(hauler()); t.after(() => w.dispose()); advance(w, 60);
  const part = kind => w.modules.find(m => m.kind === kind), empty = w.vehicle.mass, room = cargoRoom(part('hopper'));
  assert(Math.abs(empty - blueprintMass(w.blueprint)) < .005, 'a design comes empty'); assert.equal(cargoMass(part('hopper')), 0);
  // Less than twenty kilograms is carried without the body being weighed again.
  setPart(w, part('hopper'), { cargo: { ferro: 15 } }); advance(w, 12);
  assert.deepEqual([part('hopper').cargo.ferro, part('hopper').physicalMass, w.vehicle.mass], [15, 380, empty]);
  assert.equal(pieceMass(part('hopper')), 380, 'displayed piece mass respects the native weighing threshold');
  setPart(w, part('hopper'), { cargo: { ferro: 1200, ligas: 300 } }); advance(w, 6);
  assert(Math.abs(w.vehicle.mass - empty - 1500) < 1e-6 && Math.abs(part('hopper').physicalMass - 1880) < 1e-9, 'a tonne and a half of ore, on the vehicle and in the hopper');
  // Petroleum by the litre, at what a litre of it weighs.
  setPart(w, part('cistern'), { cargo: { petroleo: 1000 } }); advance(w, 6);
  assert(Math.abs(w.vehicle.mass - empty - 1500 - 850) < 1e-6 && Math.abs(part('cistern').physicalMass - 260 - 850) < 1e-9);
  // Each takes its own kind alone, and nothing that is not dug.
  for (const [kind, cargo] of [['hopper', { petroleo: 5 }], ['cistern', { ferro: 5 }], ['hopper', { ouro: 5 }], ['fuel', { petroleo: 5 }]])
    assert.throws(() => setPart(w, part(kind), { cargo }), `${kind} ${Object.keys(cargo)}`);
  assert.deepEqual([part('hopper').cargo.ferro, part('cistern').cargo.petroleo], [1200, 1000], 'a load refused changes nothing');
  // More than there is room for is cut to the room, thing by thing in the order they are listed.
  setPart(w, part('hopper'), { cargo: { ferro: 1e9, ligas: 1e9 } }); setPart(w, part('cistern'), { cargo: { petroleo: 1e9 } }); advance(w, 6);
  assert(Math.abs(part('hopper').cargo.ferro - room * 2400) < 1e-6 && !(part('hopper').cargo.ligas > 0)); assert(Math.abs(part('cistern').cargo.petroleo - cargoRoom(part('cistern')) * 1000) < 1e-6);
  setPart(w, part('hopper'), { cargo: { ferro: room * 1200, ligas: 1e9, silica: 1e9 } }); advance(w, 6);
  assert(Math.abs(part('hopper').cargo.ligas - room / 2 * 1500) < 1e-6 && !(part('hopper').cargo.silica > 0), 'half the room in iron leaves the other half for the alloys');
  assert(Math.abs(w.vehicle.mass - empty - room * 1200 - room / 2 * 1500 - cargoRoom(part('cistern')) * 850) < 1e-6);
  // Emptied, the vehicle weighs what it did; and a design never keeps what its pieces carried.
  setPart(w, part('cistern'), { cargo: {} }); setPart(w, part('hopper'), { cargo: { silica: 400 } }); advance(w, 6);
  assert(Math.abs(w.vehicle.mass - empty - 400) < 1e-6);
  assert.doesNotMatch(serializeBlueprint(w.construction), /cargo|capacityM3|petroleo|silica/);
  w.reset(); advance(w, 6);
  assert.equal(cargoMass(part('hopper')), 0); assert(Math.abs(w.vehicle.mass - empty) < 1e-6, 'a construction put back as designed is empty again');
});

test('the workshop starts a hauler of each kind, and no design says how wide it is', () => {
  const truck = createConstruction('truck'), tanker = createConstruction('tanker'), kinds = design => design.components.map(part => part.kind);
  assert(kinds(truck).includes('hopper') && !kinds(truck).includes('cistern') && kinds(tanker).includes('cistern') && !kinds(tanker).includes('hopper'));
  for (const design of [truck, tanker]) { assert(!kinds(design).includes('weapon') && !kinds(design).includes('ammo'), 'a hauler is unarmed'); assert(kinds(design).includes('sensor')); }
  const figures = design => [Math.round(blueprintMass(compileBlueprint(design)) * 10) / 10, constructionCost(compileBlueprint(design)).total];
  // The bonneted 6×6 hauler and longer 8×8 tanker keep real structural mass and material cost; the tanker carries its drill too.
  assert(kinds(tanker).includes('drill') && !kinds(truck).includes('excavator'));
  assert.deepEqual([figures(truck), figures(tanker)], [[6517.8, 24799], [7866.5, 30637]]);
  for (const design of [truck, tanker]) {
    const compiled = compileBlueprint(design), fuel = compiled.modules.find(part => part.kind === 'fuel'),
      frame = compiled.plates.filter(plate => plate.chassis).reduce((sum, plate) => sum + pieceMass(plate), 0);
    assert(Math.abs(frame - compiled.chassis.frameKg) < 1e-6, 'the generated frame weighs its actual structural section');
    assert(Math.abs(blueprintMass(compiled) - compiled.chassis.emptyKg - fuel.fuelLitres * .835) < 1e-6,
      'the displayed total includes the same frame, gear, equipment and actual fuel as native admission');
    assert.equal(constructionCost(compiled).total, [...compiled.plates, ...compiled.modules].reduce((sum, part) => sum + pieceCost(part), 0));
  }
  // Every construction is as wide as the next: the width is no longer written, and a design that still writes it is refused.
  for (const design of [truck, tanker, createConstruction('heavy')]) assert.doesNotMatch(JSON.stringify(validateBlueprint(design)), /widthM/);
  assert.throws(() => validateBlueprint({ ...createConstruction('scout'), widthM: 2.6 }), { reason: 'AUTHORING_FIELDS' });
});
