import { World } from '../../src/physics.ts';
import { Terrain } from '../../src/terrain.ts';
import { CARGO, cargoSpace } from '../../src/component-volume.ts';
import { setPart } from '../mechanical-queries.js';

// Ordinary native contacts, engine, running gear and load mass; no injected
// speed or run-up. Each admission starts stationary and aligned to the ground.
export function miningWorld(source, { grade = .5, surface = 'soil', direction = 1, facing = direction, cargo = 'ferro',
  terrain = null, seed = 6173, x = 12 } = {}) {
  const world = new World(source, { visualEvents: false, scene: { seed, mapLength: 10000 } });
  try {
    if (terrain) world.terrain = new Terrain(terrain, { seed, length: 10000 });
    else {
      world.terrain = new Terrain('flat');
      for (const point of world.terrain.points) point.y = Math.fround(50 + direction * grade * (point.x - 12));
      world.terrain.profiles = []; world.terrain.material = surface;
      world.terrain.sectors = [{ start: -1600, end: 1600, surface }];
    }
    world.replaceActor(source, { id: 'local', x, facing, rest: true });
    const hopper = world.modules.find(part => part.kind === 'hopper');
    if (cargo) setPart(world, hopper, { cargo: { [cargo]: cargoSpace(hopper, cargo) } });
    for (let i = 0; i < 90; i++) { world.step(); world.drainEvents(); }
    return world;
  } catch (error) { world.dispose(); throw error; }
}
export function miningRun(source, { grade = .5, surface = 'soil', direction = 1, cargo = 'ferro', seconds = 20,
  terrain = null, seed = 6173, x = 12, distance = 30, returnTrip = false } = {}) {
  const world = miningWorld(source, { grade, surface, direction, cargo, terrain, seed, x });
  try {
    const hopper = world.modules.find(part => part.kind === 'hopper');
    const start = world.vehicle.x, startingSpeed = Math.hypot(world.vehicle.vx, world.vehicle.vy), initialHealth = world.modules.map(part => part.health);
    const row = { surface, grade, terrain, seed, direction, cargo: cargo || 'empty', start, startingSpeed,
      massKg: world.vehicle.mass, cargoKg: cargo ? hopper.capacityM3 * CARGO[cargo].density : 0, powerKw: world.vehicle.drivetrain.powerKw,
      powerPerTonne: world.vehicle.powerPerTonne, maxDriveForce: world.vehicle.drivetrain.maxDriveForce, maxPitch: 0, minHealthFraction: 1, maxSpeed: 0, samples: [] };
    row.drivetrain = { torqueNm: world.vehicle.drivetrain.torqueNm, efficiency: world.vehicle.drivetrain.efficiency,
      rollingCoefficient: world.vehicle.drivetrain.rollingCoefficient, sprocketRadiusM: world.vehicle.drivetrain.radius,
      gearedSpeedMps: world.vehicle.drivetrain.gearedSpeed, maxSpeedMps: world.vehicle.drivetrain.maxSpeed,
      groundPressureKPa: world.vehicle.groundPressureKPa, groundResistance: world.vehicle.groundResistance };
    world.controlVehicle(direction, 0);
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      world.step(); world.drainEvents();
      const vehicle = world.vehicle; row.maxPitch = Math.max(row.maxPitch, Math.abs(vehicle.angle)); row.maxSpeed = Math.max(row.maxSpeed, Math.abs(vehicle.vx));
      if (i % 60 === 59) row.samples.push({ seconds: (i + 1) / 60, x: vehicle.x, speed: vehicle.vx, slope: vehicle.groundSlope, traction: vehicle.traction });
      if ((vehicle.x - start) * direction >= distance) { row.seconds = (i + 1) / 60; break; }
    }
    row.seconds ??= seconds; row.end = world.vehicle.x; row.progressM = (row.end - start) * direction; row.finalSpeed = world.vehicle.vx * direction;
    row.passed = row.progressM >= distance && row.startingSpeed < .05 && row.minHealthFraction > .99;
    if (returnTrip && row.passed) {
      world.controlVehicle(0, 1); for (let i = 0; i < 120; i++) { world.step(); world.drainEvents(); }
      world.turnActor('local');
      for (let i = 0; i < 90; i++) { world.step(); world.drainEvents(); }
      const from = world.vehicle.x, speedAtStart = Math.hypot(world.vehicle.vx, world.vehicle.vy), massKg = world.vehicle.mass;
      world.controlVehicle(-direction, 0); let elapsed = seconds;
      for (let i = 0; i < Math.ceil(seconds * 60); i++) {
        world.step(); world.drainEvents();
        if ((world.vehicle.x - start) * direction <= 0) { elapsed = (i + 1) / 60; break; }
      }
      row.return = { from, end: world.vehicle.x, seconds: elapsed, speedAtStart, massKg,
        cargoKg: cargo ? Object.values(world.modules.find(part => part.kind === 'hopper').cargo || {}).reduce((sum, value) => sum + value, 0) : 0,
        reachedStart: (world.vehicle.x - start) * direction <= 0 };
      row.passed &&= row.return.reachedStart && speedAtStart < .05;
    }
    row.minHealthFraction = Math.min(...world.modules.map(part => part.health / part.maxHealth));
    row.healthUnchanged = initialHealth.every((health, i) => Math.abs(world.modules[i].health - health) < 1e-6);
    row.passed &&= row.minHealthFraction > .99;
    return row;
  } finally { world.dispose(); }
}
