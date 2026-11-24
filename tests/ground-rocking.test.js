import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { Terrain } from '../src/terrain.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { physics, setVehicle } from './mechanical-queries.js';

for (const drop of [1.5, 3])
  test(`a tracked vehicle settles after falling ${drop} m onto an uneven slope`, t => {
    const world = new World(createConstruction('heavy'), { visualEvents: false });
    t.after(() => world.dispose());
    world.terrain = new Terrain('rough'); world.game(); world.controlVehicle(0, 1);
    const contours = structuredClone(world.actor().contactContours), mass = world.vehicle.mass;
    assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
    setVehicle(world, { x: 31, y: world.vehicle.y + world.terrain.height(31) + drop,
      angle: 0, vx: 0, vy: 0, omega: 0 });
    const angles = [], speeds = [];
    for (let frame = 0; frame < 900; frame++) {
      world.step();
      if (frame >= 600) { angles.push(world.vehicle.angle); speeds.push(Math.abs(world.vehicle.omega)); }
    }
    assert(Math.max(...angles) - Math.min(...angles) < .5 * Math.PI / 180,
      'normal support must dissipate the rocking instead of sustaining a several-degree oscillation');
    assert(Math.max(...speeds) < .02, 'support removes persistent angular motion');
    assert.equal(world.vehicle.mass, mass); assert.deepEqual(world.actor().contactContours, contours);
    const state = physics(world);
    assert.equal(state.bodies, 1); assert.equal(state.recoveries, 0);
  });

for (const omega of [-1.2, 1.2])
  test(`an airborne vehicle preserves its ${omega} rad/s angular motion`, t => {
    const world = new World(createConstruction('heavy'), { visualEvents: false });
    t.after(() => world.dispose()); world.game();
    setVehicle(world, { y: 8, angle: .1, vx: 0, vy: 0, omega });
    const initial = world.vehicle.angle;
    for (let frame = 0; frame < 12; frame++) {
      world.step();
      assert(Math.abs(world.vehicle.omega - omega) < 1e-6);
      assert.equal(world.vehicle.traction, 0);
    }
    assert(Math.abs(world.vehicle.angle - initial - omega * .2) < 2e-6,
      'ground damping does not become an airborne attitude controller');
    assert.equal(physics(world).recoveries, 0);
  });
