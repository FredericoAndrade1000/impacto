import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { blueprintPowertrain } from '../src/mass-properties.ts';
import { advance } from './mechanical-queries.js';


for (const template of ['scout', 'heavy']) test(`${template}: held at its top speed on level ground it burns what its estimated range says`, t => {
  const blueprint = createConstruction(template); blueprint.terrain = 'flat';
  const world = new World(blueprint); t.after(() => world.dispose()); world.game(); advance(world, 60);
  const design = blueprintPowertrain(blueprint).rangeKm, told = world.vehicle.snapshot();
  assert(told.rangeKm > 20, `${told.rangeKm} km`);
  assert(Math.abs(told.rangeKm - design) < design * .005 + .06, `the vehicle says ${told.rangeKm} km, its design ${design} km`);
  // Put at its top speed ahead (it faces -X) with the throttle held, it settles there.
  world.command('setVehicleState', { state: { x: world.vehicle.x, y: world.vehicle.y, vx: -told.maxSpeed, vy: 0 } });
  world.controlVehicle(-1); advance(world, 90);
  const cruising = world.vehicle.snapshot();
  assert(Math.abs(cruising.vx + told.maxSpeed) < .05 && cruising.fuelRate > 0);
  const burned = cruising.fuelLitres / cruising.fuelRate * -cruising.vx * 3.6;
  assert(Math.abs(burned - cruising.rangeKm) < cruising.rangeKm * .01 + .06, `at ${cruising.fuelRate} L/h it would go ${burned} km, told ${cruising.rangeKm} km`);
  // As the tank empties the range comes down with it.
  assert(cruising.fuelLitres < told.fuelLitres && cruising.rangeKm <= told.rangeKm);
});
