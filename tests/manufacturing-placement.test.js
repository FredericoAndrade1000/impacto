import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionSpan } from '../src/construction-placement.ts';
import { baseVehiclePosition } from '../server/manufacturing.ts';

await initNativeDynamics();
const source = createStructuredTemplate('chassis');
const actors = [
  { id: 'old', team: 'own', vehicle: { x: 0 } },
  { id: 'neighbour', team: 'own', vehicle: { x: 4 } },
  { id: 'unseen', team: 'other', vehicle: { x: 0 } },
  { id: 'far', team: 'own', vehicle: { x: 500 } },
];

test('base placement reads each relevant neighbour once and finds a replacement gap without changing the fleet', () => {
  const read = [], bounds = { minX: -2, maxX: 5 }, before = structuredClone(actors),
    world = { actors, actorBounds(id) { read.push(id); assert.equal(id, 'neighbour'); return bounds; } },
    request = { world, source, factionId: 'own', base: 0, limits: { minX: -1000, maxX: 1000 }, requested: 0, facing: 1, ignoreId: 'old' },
    x = baseVehiclePosition(request), span = constructionSpan(compileStructuredConstruction(source), { x, facing: 1 });
  assert(Math.abs(x) <= 100, 'the replacement remains in its base');
  assert(span.maxX + .8 < bounds.minX || span.minX - .8 > bounds.maxX, 'the new outline leaves a real gap');
  assert.deepEqual(read, ['neighbour'], 'the old vehicle, foreign vehicles and distant ones cannot refuse a place');
  assert.deepEqual(actors, before);
  assert.deepEqual(bounds, { minX: -2, maxX: 5 });
});

test('placement refuses an occupied request or an invalid base position without changing its inputs', () => {
  const world = { actors: [actors[1]], actorBounds: () => ({ minX: -200, maxX: 200 }) },
    request = { world, source, factionId: 'own', base: 0, limits: { minX: -1000, maxX: 1000 }, requested: 0, facing: 1 },
    before = structuredClone(source);
  assert.throws(() => baseVehiclePosition(request), /Não há espaço aí/);
  assert.throws(() => baseVehiclePosition({ ...request, requested: null }), /A base está cheia/);
  assert.throws(() => baseVehiclePosition({ ...request, requested: NaN }), /Posição no campo inválida/);
  assert.throws(() => baseVehiclePosition({ ...request, requested: 101 }), /Fabrique dentro da base/);
  assert.deepEqual(source, before);
});

test('an aircraft of the faction in the air over the base, however low, takes no place there; landed, it does', () => {
  const world = flying => ({ actors: [{ id: 'air', team: 'own', vehicle: { x: 0, flying } }], actorBounds: () => ({ minX: -5, maxX: 5 }) }),
    request = { source, factionId: 'own', base: 0, limits: { minX: -1000, maxX: 1000 }, requested: 0, facing: 1 };
  assert.equal(baseVehiclePosition({ ...request, world: world(true) }), 0, 'a vehicle is fabricated under it');
  assert.throws(() => baseVehiclePosition({ ...request, world: world(false) }), /Não há espaço aí/);
});
