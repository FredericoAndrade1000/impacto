import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { localToWorld } from '../src/math.ts';
import { physics } from './mechanical-queries.js';
import { chassisSpec } from '../src/chassis.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';

test('structured runtime uses derived rooms, one carrier and canonical reset', t => {
  // The infantry carrier has an open turret ring joining its hull and tower.
  const source = createStructuredTemplate('ifv'),
    expected = compileStructuredConstruction(source), world = new World(source);
  t.after(() => world.dispose());
  assert.deepEqual(world.construction, source);
  assert.equal(expected.rooms.length, 1); assert.equal(world.actor().bodyPanels.length, expected.rooms.length);
  for (let i = 0; i < 30; i++) world.step();
  assert.equal(physics(world).bodies, 1);
  world.reset();
  assert.equal(world.construction.version, DESIGN_VERSION);
  assert.deepEqual(world.construction, source);
  assert.equal(world.actor().bodyPanels.length, expected.bodyPanels.length);
});

for (const facing of [-1, 1]) test(`derived panels reflect with the rigid body at facing ${facing}`, t => {
  const source = createStructuredTemplate('scout'),
    expected = compileStructuredConstruction(source), world = new World(source);
  t.after(() => world.dispose());
  const actor = world.addActor(source, { id: 'copy', ownerId: 'opponent', x: 40, facing }),
    lift = actor.vehicle.y - 1.3, mirror = -facing;
  assert.deepEqual(actor.construction, source);
  for (const [i, panel] of actor.bodyPanels.entries()) for (const [j, p] of panel.localPolygon.entries()) {
    const actual = localToWorld(actor.vehicle.pose(), p.x, p.y), original = expected.bodyPanels[i].poly[j];
    assert(Math.abs(actual.x - (40 + mirror * (original.x - 12))) < 1e-9);
    assert(Math.abs(actual.y - original.y - lift) < 1e-9);
  }
  world.step();
  assert.equal(physics(world).bodies, 2);
});

test('the suspension travel of the chassis model and a disabled carrier survive cold actor admission', t => {
  const source = createStructuredTemplate('scout'), { travel } = chassisSpec(source.chassis.model);
  const world = new World(source); t.after(() => world.dispose());
  assert(world.modules.some(m => m.suspension));
  assert(world.modules.filter(m => m.suspension).every(m => m.suspension.travel === travel));
  world.command('control', { throttle: 0, enabled: false });
  assert.equal(world.vehicle.snapshot().enabled, false);
  world.addActor(source, { id: 'other', ownerId: 'other', x: 40 });
  assert.equal(world.vehicle.snapshot().enabled, false);
  assert(world.modules.filter(m => m.suspension).every(m => m.suspension.travel === travel));
  for (let i = 0; i < 10; i++) world.step();
  assert.equal(world.vehicle.snapshot().enabled, false);
});
