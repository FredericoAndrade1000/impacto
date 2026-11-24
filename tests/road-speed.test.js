import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { blueprintPowertrain } from '../src/mass-properties.ts';
import { groundBraking } from '../src/terrain-speed.ts';
import { setVehicle } from './mechanical-queries.js';
import { paced } from '../src/squad.ts';

// `blueprint` on level ground of one kind, or on a road laid over soil, a kilometre and a half from its end.
function level(t, blueprint, ground) {
  blueprint.terrain = 'flat';
  const world = new World(blueprint), road = ground === 'graded' || ground === 'asphalt'; t.after(() => world.dispose());
  world.terrain.sectors = [{ start: -1600, end: 1600, surface: road ? 'soil' : ground }];
  world.game();
  if (road) world.pave(-1600, 1600, ground);
  return world;
}
// A base model at full throttle on `ground` as long as it takes to stop gaining speed: the speed it then holds, in
// km/h, and the fuel it burns a kilometre at it. Over bumps one run is one draw of how they fall under the wheels, and
// a few centimetres of the vehicle change it by more than a smooth road saves: it is run from each of PHASES metres
// on, and what it does is the mean of them.
const PHASES = [0, 3, 7, 11];
function flatOut(t, model, ground) {
  const runs = PHASES.map(shift => {
    const world = level(t, createConstruction(model), ground), vehicle = world.vehicle,
      run = seconds => { for (let i = 0; i < seconds * 60; i++) world.step(); };
    if (shift) setVehicle(world, { x: vehicle.x + shift });
    const from = vehicle.x;
    world.controlVehicle(-1);
    for (let last = -1, held = 0; held < 2 && Math.abs(vehicle.x - from) < 1300; ) {
      run(1); const speed = Math.abs(vehicle.vx); held = speed < last + .01 ? held + 1 : 0; last = speed;
    }
    const x = vehicle.x, fuel = vehicle.powertrain.fuelLitres; run(5);
    const metres = Math.abs(vehicle.x - x);
    return { kmh: metres / 5 * 3.6, perKm: (fuel - vehicle.powertrain.fuelLitres) / metres * 1000 };
  }), mean = key => runs.reduce((sum, one) => sum + one[key], 0) / runs.length;
  return { kmh: mean('kmh'), perKm: mean('perKm') };
}

for (const [model, tracked] of [['chassis', false], ['tracked', true]])
  test(`the ${model} base model goes slower and burns more a kilometre the rougher the ground, and asphalt carries it fastest for the least fuel`, t => {
    const top = blueprintPowertrain(createConstruction(model)).maxSpeed * 3.6, at = {};
    for (const ground of ['concrete', 'asphalt', 'graded', 'soil', 'rock', 'mud']) at[ground] = flatOut(t, model, ground);
    // Asphalt has no bumps, as concrete has none, and rolls as freely: the vehicle goes as fast on it as on concrete, as
    // fast as it goes anywhere, and near the top speed it is rated for on a paved road.
    assert(at.asphalt.kmh >= at.concrete.kmh * .995 && at.asphalt.kmh > top * .97,
      `asphalt ${at.asphalt.kmh.toFixed(1)} km/h, concrete ${at.concrete.kmh.toFixed(1)}, top ${top.toFixed(1)}`);
    // Flat out, the bumps of a ground and how it rolls hold the vehicle back the more the rougher it is, and it burns
    // the more fuel a kilometre for it. A track is geared to go no faster on asphalt than on the smallest of bumps.
    assert(at.asphalt.kmh > at.graded.kmh || tracked && at.graded.kmh > top * .97, `graded ${at.graded.kmh.toFixed(1)} km/h`);
    assert(at.graded.kmh > at.soil.kmh && at.soil.kmh > at.rock.kmh && at.rock.kmh > at.mud.kmh);
    for (const [smooth, rough] of [['asphalt', 'graded'], ['graded', 'soil'], ['soil', 'rock'], ['rock', 'mud']])
      assert(at[smooth].perKm < at[rough].perKm, `${smooth} ${at[smooth].perKm.toFixed(2)} L/km, ${rough} ${at[rough].perKm.toFixed(2)} L/km`);
    assert(at.asphalt.perKm <= at.concrete.perKm * 1.005, `asphalt ${at.asphalt.perKm.toFixed(3)} L/km, concrete ${at.concrete.perKm.toFixed(3)}`);
  });

// No ground holds a pilot under the speed its vehicle goes at over it (terrain-speed.ts): the common vehicles, thrown onto
// each far faster than they go over it, at 180 km/h on wheels and 130 on tracks, and driven on as their pilots drive them
// flat out (squad.ts `paced`), are thrown about on their springs, but nothing of them strikes the ground or breaks, and
// they stay on their wheels. Braked all at once then, they stop as hard as their pilots count on (`groundBraking`).
for (const model of ['truck', 'scout', 'heavy', 'mining-truck'])
  test(`the ${model} goes over each ground as fast as it goes, and stops on it as its pilot counts on`, t => {
    for (const ground of ['soil', 'sand', 'gravel', 'rock', 'mud', 'graded']) {
      const blueprint = createStructuredTemplate(model), tracked = blueprint.chassis.model === 'tracked',
        world = level(t, blueprint, ground), vehicle = world.vehicle,
        health = () => world.modules.filter(part => part.actorId === 'local').reduce((sum, part) => sum + (part.health || 0), 0);
      setVehicle(world, { x: 1500 });
      for (let i = 0; i < 120; i++) world.step();
      world.drainEvents();
      setVehicle(world, { vx: -(tracked ? 130 : 180) / 3.6 });
      const leg = {}, whole = health();
      let struck = 0, lean = 0;
      const step = () => {
        world.step(); lean = Math.max(lean, Math.abs(vehicle.angle));
        struck += world.drainEvents().filter(event => event.type === 'ground').length;
      };
      // Ten looks a second, as the pilots decide.
      for (let i = 0; i < 12 * 60; i++) {
        if (i % 6 === 0) { const { throttle, brake } = paced(leg, vehicle, -1, -vehicle.vx, 100, world.time, { surge: Infinity }); world.controlVehicle(throttle, brake); }
        step();
      }
      const speed = Math.abs(vehicle.vx), from = vehicle.x, braking = groundBraking(ground, tracked, vehicle.groundPressureKPa || 0);
      world.controlVehicle(0, 1);
      for (let i = 0; i < 30 * 60 && Math.abs(vehicle.vx) > .05; i++) step();
      const stopped = speed * speed / (2 * Math.abs(vehicle.x - from)), where = `${ground} from ${(speed * 3.6).toFixed(0)} km/h`;
      assert(speed > 15, `${where}: it goes on`);
      assert.equal(struck, 0, `${where}: nothing strikes the ground`); assert(whole - health() < 1e-9, `${where}: nothing breaks`);
      assert(lean < .4, `${where}: it stays on its wheels, leaning ${lean.toFixed(3)} rad at the most`);
      assert(stopped > braking, `${where}: it stops at ${stopped.toFixed(2)} m/s², counted on for ${braking.toFixed(2)}`);
    }
  });
