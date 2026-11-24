import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { MATERIALS, MATERIAL_NOTES, MATERIAL_ORDER, brittleMaterial } from '../src/materials.ts';
import { pieceCost } from '../src/construction-cost.ts';
import { pieceMass } from '../src/mass-properties.ts';
import { compileStructuredConstruction, createStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { soundCue } from '../src/audio.ts';
import { damageConstruction, face } from './damage-fixtures.js';
import { managedWorld, flyRound } from './mechanical-queries.js';

await initNativeDynamics();

const ADDED = ['hha', 'titanium', 'fiberglass', 'glass'];
// Independent prices retain the numerical armour regression oracle.
const PRICE_PER_KG = { steel: 1.4, aluminum: 3.2, ceramic: 6, concrete: .86, hha: 2.6, titanium: 12, fiberglass: 3.2, glass: 9 };
const front = (material, frontThickness = 100) => compileStructuredConstruction(damageConstruction({ material, frontThickness }))
  .plates.find(plate => plate.id === 'hull:front');
const shot = (overrides = {}) => ({ x: 9.9, y: 1.7, vx: 1100, vy: 0, mass: 5, caliberMm: 120, power: 900, radius: .06,
  ammo: 'ap', weapon: 'cannon', age: .1, life: 2, visited: new Set(), ...overrides });
// The first thing an armour-piercing shot of that power does to a 100 mm front wall: of a hull that drives, or,
// in the armour only what stands still is made of, of one that does not.
function strike(t, material, power) {
  const world = managedWorld(t, damageConstruction({ dynamic: !MATERIALS[material].fixed, height: 1.6, rideHeight: .9, frontThickness: 100, material })),
    plate = face(world);
  flyRound(world, shot({ power }), .002);
  const events = world.drainEvents(), contact = events.find(event => ['penetration', 'blocked', 'ricochet'].includes(event.type) &&
      !event.fragment && event.id === plate.id),
    rays = events.filter(event => event.type === 'secondary-ray' && event.internal);
  return { contact, thrown: rays.reduce((sum, ray) => sum + ray.energyBudget, 0) /
    (contact.energy * (1 - contact.remaining / contact.power)) };
}

test('the workshop lists every armour once, with what sets it apart and what it costs', () => {
  const ids = Object.keys(MATERIALS);
  assert.deepEqual([...MATERIAL_ORDER].sort(), [...ids].sort());
  for (const id of ADDED) assert(ids.includes(id), id + ' is offered');
  for (const id of ids) {
    const material = MATERIALS[id];
    assert.equal(material.id, id);
    assert(material.name && material.short && MATERIAL_NOTES[id] && pieceCost({ material: id, physicalMass: 1 }) > 0, id + ' is described and priced');
    assert(material.density > 0 && material.resistance > 0 && Number.isInteger(material.color));
  }
  assert.deepEqual(ids.filter(id => MATERIALS[id].transparent), ['glass'], 'only glass lets a camera see through');
});

test('the compiler takes the new armours and weighs and prices a plate by them', () => {
  const steel = front('steel'), volume = pieceMass(steel) / MATERIALS.steel.density;
  for (const id of Object.keys(MATERIALS)) {
    const plate = front(id), mass = pieceMass(plate);
    assert.equal(plate.material, id);
    assert(Math.abs(mass - volume * MATERIALS[id].density) < 1e-6 * mass, id + ' weighs its density');
    assert.equal(pieceCost(plate), Math.ceil(mass * PRICE_PER_KG[id] - 1e-9), id + ' costs its price per kilogram');
  }
  const unknown = damageConstruction({ material: 'mithril' });
  assert.throws(() => validateStructuredConstruction(unknown), { reason: 'ARMOUR_MATERIAL' });
});

test('a plate is no thinner than its armour stands as a plate, and only what does not drive is made of concrete', () => {
  // What bends no more and breaks no sooner than 5 mm of steel, in each: the compiler is the one that counts, and
  // it takes that much and refuses a millimetre under it.
  const least = { steel: 5, hha: 5, titanium: 6, aluminum: 8, ceramic: 8, fiberglass: 10, glass: 15, concrete: 50 };
  assert.deepEqual(Object.fromEntries(Object.keys(least).map(id => [id, MATERIALS[id].minThicknessMm])), least);
  for (const [id, mm] of Object.entries(least)) {
    assert.equal(front(id, mm).thicknessMm, mm, id);
    assert.throws(() => front(id, mm - 1), error => error.reason === 'FIELD' && ["hull:front"].every(id => error.ids?.includes(id)) && error.field === "thicknessMm", id);
  }
  assert.deepEqual(Object.keys(MATERIALS).filter(id => MATERIALS[id].fixed), ['concrete']);
  const wall = { material: 'concrete', frontThickness: 300 };
  assert.equal(front('concrete', 300).material, 'concrete');
  assert.throws(() => validateStructuredConstruction(damageConstruction({ ...wall, dynamic: true })), error => error.reason === 'ARMOUR_FIXED' && ["hull:front"].every(id => error.ids?.includes(id)));
  // In the workshop a plate that changes armour takes the least thickness of the new one in the same edit, and a
  // thicker one keeps what it has.
  const editor = new Editor(createStructuredConstruction({ name: 'caixa', length: 5, height: 1.6, thicknessMm: 5 }));
  editor.select('hull:roof'); editor.editProperty('material', 'glass', true);
  assert.deepEqual([editor.selected.material, editor.selected.thicknessMm], ['glass', 15]);
  editor.editProperty('material', 'titanium', true);
  assert.deepEqual([editor.selected.material, editor.selected.thicknessMm], ['titanium', 15]);
  editor.undo(); editor.undo(); editor.select('hull:roof');
  assert.deepEqual([editor.selected.material, editor.selected.thicknessMm], ['steel', 5], 'one edit each');
  assert.throws(() => editor.editProperty('material', 'concrete', true), 'a hull that drives is refused concrete');
  assert.equal(editor.selected.material, 'steel');
});

test('a plate resists by its material: a shot is stopped under what a wall of it takes, and goes through over it', t => {
  // What 100 mm of each takes from a shot: a hundred times its resistance, which the workshop tells as steel.
  const takes = { steel: 125, hha: 155, titanium: 112, aluminum: 48, ceramic: 130, fiberglass: 30, glass: 20, concrete: 18 };
  assert.deepEqual(Object.keys(takes).sort(), Object.keys(MATERIALS).sort());
  for (const [id, power] of Object.entries(takes)) {
    assert(Math.abs(MATERIALS[id].resistance * 100 - power) < 1e-9, id + ' is told in the workshop as the core counts it');
    assert.equal(strike(t, id, power - 2).contact.type, 'blocked', id);
    assert.equal(strike(t, id, power + 2).contact.type, 'penetration', id);
  }
  // Per kilogram, against steel: ceramic the most, then titanium, hard steel and aluminium a little over it;
  // fibreglass weighs what steel does for the same protection, and glass and concrete about twice that.
  const worth = id => MATERIALS[id].resistance / MATERIALS[id].density / (MATERIALS.steel.resistance / MATERIALS.steel.density);
  assert(worth('ceramic') > worth('titanium') && worth('titanium') > worth('hha') && worth('hha') > worth('aluminum') && worth('aluminum') > 1);
  assert(Math.abs(worth('fiberglass') - 1) < .1, 'fibreglass weighs about what steel does for the same protection');
  for (const id of ['glass', 'concrete']) assert(Math.abs(worth(id) - .5) < .05, id);
});

test('a perforation throws spall by the material: more from hard steel, almost none from fibreglass', t => {
  const steel = strike(t, 'steel', 900).thrown, hard = strike(t, 'hha', 900).thrown,
    fibre = strike(t, 'fiberglass', 900).thrown, titanium = strike(t, 'titanium', 900).thrown;
  assert(steel > 0 && steel <= .08 + 1e-9, 'steel keeps the share it always had');
  assert(Math.abs(hard / steel - 1.3) < 1e-6 && Math.abs(titanium / steel - .9) < 1e-6);
  assert(Math.abs(fibre / steel - .2) < 1e-6);
});

test('the material of a plate is one undoable edit of the workshop', () => {
  // The material edit starts from a wheeled factory box with 40 mm walls.
  const editor = new Editor(createStructuredConstruction({ name: 'caixa', length: 5, height: 1.6, chassis: 'wheeled' }));
  editor.select('hull:front');
  const before = pieceMass(editor.selected);
  for (const id of ADDED) {
    editor.editProperty('material', id, true);
    assert.equal(editor.selected.material, id);
    assert(Math.abs(pieceMass(editor.selected) / before - MATERIALS[id].density / MATERIALS.steel.density) < 1e-9);
  }
  editor.undo(); assert.equal(editor.source.plates.find(plate => plate.id === 'hull:front').material, 'fiberglass');
  editor.select('hull:front');
  assert.throws(() => editor.editProperty('material', 'mithril', true));
  assert.equal(editor.selected.material, 'fiberglass');
});

test('armour impacts distinguish hard surfaces from metals without changing the metal recording by alloy', () => {
  const cue = id => soundCue({ type: 'blocked', material: id, power: 120 });
  assert.notDeepEqual(cue('glass'), cue('steel')); assert.deepEqual(cue('hha'), cue('steel'));
});

test('a piece of plastic is struck as what splits, with a dull hit and dust instead of sparks, and no plate is made of it', () => {
  const cue = id => soundCue({ type: 'blocked', material: id, power: 120 });
  assert.deepEqual(cue('plastic'), cue('fiberglass')); assert.notDeepEqual(cue('plastic'), cue('steel'));
  assert.deepEqual(['plastic', 'fiberglass', 'glass', 'steel', 'aluminum'].map(brittleMaterial), [true, true, true, false, false]);
  assert(!Object.hasOwn(MATERIALS, 'plastic') && !MATERIAL_ORDER.includes('plastic'));
});
