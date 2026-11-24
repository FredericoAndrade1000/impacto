import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { physics, ownerState, flyRound } from './mechanical-queries.js';

const fixture = (t, template = 'heavy') => {
  const world = new World(createConstruction(template), { visualEvents: false });
  t.after(() => world.dispose()); world.game(); return world;
};
const shape = world => {
  const contours = structuredClone(world.actor().contactContours);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  return contours;
};
const properties = world => physics(world).bodyStates.map(b => ({
  handle: b.handle, mass: b.mass, inertia: b.inertia,
}));

test('perforation erodes ballistic material without editing the rigid contact contours or mass', t => {
  const world = fixture(t), plate = world.plates[0], before = properties(world),
    contour = shape(world), contactCount = physics(world).colliders,
    originalArea = plate.remainingArea, point = { ...plate.definition };
  world.cutBody(plate, point, point, plate.definition.thicknessMm / 2000 + .01);
  assert(plate.remainingArea > 0 && plate.remainingArea < originalArea);
  assert.equal(plate.materialPosition({ u: .5, v: .5 }), null);
  assert.deepEqual(properties(world), before); assert.deepEqual(shape(world), contour);
  world.cutBody(plate, point, point, plate.definition.length * 2);
  assert.equal(plate.remainingArea, 0);
  assert.deepEqual(properties(world), before); assert.deepEqual(shape(world), contour);
  assert.equal(physics(world).colliders, contactCount, 'ballistic holes never remove terrain support');
});

for (const template of ['heavy', 'scout']) test(`${template}: gear fails on the existing carrier without replacement bodies`, t => {
  const world = fixture(t, template), gear = world.modules.find(m => ['track', 'wheel'].includes(m.kind)),
    before = properties(world), contour = shape(world), carrier = ownerState(world, gear).body;
  // An armour-piercing round flown level into the leading end of the gear from two centimetres off it, spent inside.
  const strike = () => flyRound(world, { x: gear.x - gear.width / 2 - .02, y: gear.y, vx: 600, vy: 0,
    power: 100, radius: .025, mass: .2, caliberMm: 50, ammo: 'ap' }, .0001);
  strike();
  assert.equal(world.stats.penetrations, 1); assert(gear.health < gear.maxHealth, 'a ballistic strike still damages functional running gear');
  strike();
  assert.equal(gear.health, 0); assert(gear.attached);
  assert.equal(ownerState(world, gear).body, carrier);
  assert.deepEqual(properties(world), before); assert.deepEqual(shape(world), contour);
  for (let i = 0; i < 30; i++) world.step();
  assert(Number.isFinite(world.vehicle.y + world.vehicle.vx + world.vehicle.vy + world.vehicle.omega));
  assert.equal(world.dynamics.recoveries, 0);
});

test('failed installed mechanisms retain all admitted mass and the same contact contours', t => {
  const world = fixture(t), installed = world.modules.filter(m => !['wheel', 'track'].includes(m.kind)),
    before = properties(world), contour = shape(world), owners = installed.map(m => [m, ownerState(world, m).body]);
  // A charge goes off at one working mechanism after another until none works; the fuel and the ammunition go up with theirs.
  for (let i = 0; i < 12 && installed.some(m => m.health > 0); i++) {
    const module = installed.find(m => m.health > 0); world.explode(module.x, module.y, 600, 4.5);
  }
  assert(installed.every(m => m.health === 0 && m.attached));
  assert(installed.filter(m => ['fuel', 'ammo'].includes(m.kind)).every(m => m.detonated));
  assert.deepEqual(properties(world), before); assert.deepEqual(shape(world), contour);
  for (const [module, carrier] of owners) assert.equal(ownerState(world, module).body, carrier);
});

test('the runtime owns exactly one compiled rigid body per actor and no wheel constraints', t => {
  const world = fixture(t), state = physics(world);
  assert.equal(world.dynamics.backend, 'rust');
  assert.equal(world.dynamics.world, undefined); assert.equal(world.dynamics.sync, undefined);
  assert.equal(world.dynamics.bodyViews, undefined); assert.equal(world.vehicle.drive, undefined);
  assert.equal(state.bodies, world.actors.length);
  assert.equal(state.bodyStates.length, state.bodies);
  assert(state.owners.every(owner => owner.body === state.bodyStates[0].handle));
  assert(state.bodyStates.every(body => Number.isFinite(body.x + body.y + body.mass + body.inertia)));
});
