import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { probeLightWheel } from '../scripts/probes-mobility.ts';
import { lightWheelBlueprint } from '../src/scenarios.ts';
import { blueprintMass } from '../src/mass-properties.ts';
import { reserveState } from '../src/component-volume.ts';
import { DESIGN_VERSION, compileBlueprint } from '../src/persistence.ts';
import { chassisSpec } from '../src/chassis.ts';

test('the current light impact author has real mass, 39 kW and fuel without hidden ballast', () => {
  const source = lightWheelBlueprint(), b = compileBlueprint(source);
  assert.equal(source.version, DESIGN_VERSION); assert.equal(b.mechanicalAdmission, true);
  // A wheel on each axle of its chassis.
  assert.equal(b.modules.filter(m => m.kind === 'wheel').length, chassisSpec(source.chassis.model).axles);
  assert(Math.abs(blueprintMass(b) - b.fixedAssembly.mass) < 1e-8);
  assert(Math.abs(b.modules.find(m => m.kind === 'engine').powerKw - 39) < .001);
  assert(Math.abs(reserveState(b.modules.find(m => m.kind === 'fuel')).fuelLitres - 25.272) < .001);
});

for (const throttle of [-1, 0, 1]) test(`a rim strike transfers finite shot momentum and loses post-impact energy with throttle ${throttle}`, () => {
  const row = probeLightWheel({ seed: 3, target: 'wheel-upper', throttle, seconds: 8, diagnostic: true });
  assert.equal(row.thrown, null); assert.equal(row.stats.shots, 1);
  assert(row.events.some(e => e.type === 'module' && e.kind === 'wheel'));
  assert(row.peaks.speed < 8 && row.peaks.clearance < .1);
  const wheelImpulses = row.impulses.filter(j => j.kind === 'wheel');
  const magnitude = j => j.magnitude ?? Math.hypot(j.x, j.y);
  assert(wheelImpulses.length && wheelImpulses.some(j => magnitude(j) > .01));
  assert(wheelImpulses.every(j => Number.isFinite(magnitude(j)) && magnitude(j) <= 5500),
    'a penetrating rim absorbs only part of the catalogue round momentum');
  assert(row.peaks.passiveGrowth < 50, 'kinetic, gravitational and suspension energy do not grow after all loads end');
  assert.equal(row.end.throttle, 0);
  assert(Math.abs(row.end.vx) < .01, 'the damaged wheel dissipates its initial spin instead of acting as a free motor');
  assert.equal(row.recoveries, 0);
});

test('a high-speed sequence through the small engine retains its chassis without trapping WASM', () => {
  const row = probeLightWheel({ seed: 4, target: 'engine', throttle: 1, startSpeedKmh: 43,
    shots: 15, seconds: 8, diagnostic: true });
  assert.equal(row.thrown, null, JSON.stringify(row.thrown));
  assert.equal(row.stats.shots, 15); assert.equal(row.end.powerKw, 0);
  assert(row.peaks.clearance < .5, 'damage retains the supporting rigid chassis');
  assert(row.peaks.passiveGrowth < 500, 'allows repeated external impulses, not a powered disabled engine');
  assert(row.peaks.solverGrowth < 5000, 'the native solve cannot manufacture a megajoule pulse');
});

test('150 real 20 mm shots against the small engine keep valid body references and finite damage state', () => {
  const row = probeLightWheel({ seed: 4, target: 'engine', shots: 150, preset: 'rh202', seconds: 18 });
  assert.equal(row.thrown, null, JSON.stringify(row.thrown));
  assert.equal(row.stats.shots, 150); assert.equal(row.end.powerKw, 0);
  assert(row.peaks.clearance < 1);
  // A ten-second barrage carries 18 kN s even after the engine has stopped.
  // Retain that propulsion by external impacts, then verify passive decay.
  assert(row.peaks.energy < 150 * .5 * .12 * 1000 ** 2);
  assert(row.peaks.passiveGrowth < 500);
  const quiet = row.trace.filter(r => r.quiet);
  assert(quiet.length > 1, 'observe the aftermath after surviving rounds leave the world');
  assert(quiet.at(-1).totalEnergy <= quiet[0].totalEnergy + .01);
  assert(Math.abs(quiet.at(-1).vx) <= Math.max(.001, Math.abs(quiet[0].vx)),
    'a resting vehicle remains at rest within contact-solver tolerance');
});

test('a disabled rolling assembly still supports weight and supplies passive drag with the engine off', t => {
  const world = new World(lightWheelBlueprint()); t.after(() => world.dispose());
  for (let i = 0; i < 60; i++) world.step();
  const mass = world.vehicle.mass;
  for (const m of world.modules) if (m.kind === 'engine' || m.kind === 'wheel')
    world.game().call({op:'setPartState',owner:world.game().handle(m),state:{health:0}});
  world.game().call({op:'setVehicleState',state:{vx:3,vy:0,omega:0}});
  world.controlVehicle(1); world.step();
  assert.equal(world.vehicle.availablePowerKw, 0); assert.equal(world.vehicle.traction, 0);
  assert.equal(world.vehicle.mass, mass, 'failed components remain part of the single carrier');
  assert(world.modules.filter(m => m.kind === 'wheel').every(m => m.groundContact));
  assert(world.vehicle.vx < 3 && world.vehicle.vx > 0, 'external/coasting motion remains possible and dissipates');
});
