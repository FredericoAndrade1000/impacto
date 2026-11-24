import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { duel } from './helpers/duel.js';

test('a workshop world and a world of two vehicles initialize the default Rust solver without caller bootstrapping', t => {
  const design = createConstruction('ifv'), world = new World(design), pair = duel(t, design);
  t.after(() => world.dispose());
  for (const instance of [world, pair]) {
    assert.equal(instance.dynamics.backend, 'rust'); instance.step();
    assert(instance.actors.every(a => Number.isFinite(a.vehicle.x) && Number.isFinite(a.vehicle.y)));
  }
});
