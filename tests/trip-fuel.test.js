import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { Terrain } from '../src/terrain.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { Squad } from '../src/squad.ts';
import { SupplyDispatch } from '../server/supply-dispatch.ts';
import { holdsCargo } from '../src/component-volume.ts';
import { nativeFuelFlow } from '../src/native-dynamics.ts';

// Every stock vehicle, all it carries full, sent by its pilot 700 m over one ground: 100 m on the level, a hill 500 m from
// foot to foot as steep as the steepest of that ground on the main world, and 100 m on the level again. The hill rises as
// much over its 250 m as the steepest 250 m of soil, gravel and rock there, and is as steep at its steepest as the
// steepest 50 m of sand and of mud, which climb no more than that anywhere (`HILL`). The fuel it burns is no more than
// what the dispatcher sets aside for the trip (SupplyDispatch.fuel over SupplyDispatch.travel), and no more than half of
// what that sets aside beyond its engine at full power for as long as the trip is reckoned to take: neither on this
// trip, nor on a long one, which keeps only the half again of that the reckoning sets aside.
const HILL = { soil: 60, gravel: 60, rock: 60, graded: 60, sand: 22, mud: 17 }, VEHICLES = CONSTRUCTION_TEMPLATES.map(({ id }) => id)
  .filter(id => { const source = createStructuredTemplate(id); return source.chassis && source.chassis.model !== 'aircraft'; });

function trip(model, ground) {
  const blueprint = createStructuredTemplate(model); blueprint.terrain = 'flat';
  const world = new World(blueprint), road = ground === 'graded', points = [{ x: -1600, y: 0 }];
  try {
    for (let x = -1000; x <= 1000; x += .5)
      points.push({ x, y: Math.fround(Math.abs(x) <= 250 ? HILL[ground] * Math.cos(Math.PI * x / 500) ** 2 : 0) });
    points.push({ x: 1600, y: 0 });
    world.terrain = Terrain.fromSnapshot({ id: 'flat', seed: 0, length: 2000, center: 0, spacing: .5, minX: -1000, maxX: 1000, material: 'soil',
      points, sectors: [{ start: -1600, end: 1600, surface: road ? 'soil' : ground }], features: [], rocks: [] });
    world.game(); if (road) world.pave(-1600, 1600, ground);
    const actor = world.actor('local'), facing = actor.facing || 1, from = -350 * facing, to = 350 * facing;
    world.command('setVehicleState', { actorId: 'local', state: { x: from, y: world.vehicle.y, vx: 0, vy: 0 } });
    for (const part of world.modules.filter(m => m.actorId === 'local' && holdsCargo(m)))
      world.command('setPartState', { owner: world.game().handle(part), state: { cargo: part.kind === 'cistern' ? { petroleo: 1e9 } : { ferro: 1e9 } } });
    for (let i = 0; i < 180; i++) world.step();
    const vehicle = world.vehicle, squad = new Squad({ world, roster: [{ id: 'local', team: 'local' }], defeats: {}, faction: { explored: [[-1e6, 1e6]] },
        knowsGround: () => true, input() {}, turnAbout: () => false }), unit = squad.units.get('local'),
      dispatch = Object.assign(Object.create(SupplyDispatch.prototype), { room: { world } }), drive = dispatch.drive(actor),
      seconds = dispatch.travel(actor, vehicle.x, to), budget = dispatch.fuel(actor, seconds),
      reckoned = nativeFuelFlow(drive.powerKw, drive.powerKw) * seconds / 3600, before = vehicle.powertrain.fuelLitres;
    unit.move = squad.leg('local', to);
    for (let step = 0; step < 600 * 60 && unit.move; step++) {
      if (step % 6 === 0) { const { throttle, brake } = squad.drive('local', unit); world.controlVehicle(throttle, brake); }
      world.step();
    }
    return { burnt: before - vehicle.powertrain.fuelLitres, budget, reckoned, there: !unit.move && Math.abs(vehicle.x - to) <= 2, loaded: vehicle.mass };
  } finally { world.dispose(); }
}

for (const model of VEHICLES)
  test(`loaded full, the ${model} burns no more fuel over the steepest of each ground than the dispatcher sets aside`, { timeout: 120000 }, () => {
    for (const ground of Object.keys(HILL)) {
      const { burnt, budget, reckoned, there } = trip(model, ground), where = `${ground}: ${burnt.toFixed(2)} L, ${budget} L set aside, reckoned at ${reckoned.toFixed(2)}`;
      assert(burnt > 0 && burnt <= (budget + reckoned) / 2, `${where}: no more than half of what this trip sets aside beyond it`);
      assert(burnt <= reckoned * 1.25, `${where}: no more than half of what a long trip sets aside beyond it`);
      // Only wheels bog down: on mud, which a loaded lorry does not climb as steep as that.
      assert(there || ground === 'mud', `${where}: it gets there`);
    }
  });
