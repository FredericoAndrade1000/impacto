import test from 'node:test';
import assert from 'node:assert/strict';
import { currentStabilityEncounter, assertCurrentStability } from './helpers/current-stability.js';
import { createConstruction } from '../src/construction-templates.ts';
import { managedWorld, physics, setVehicle, ownerState, impulse } from './mechanical-queries.js';
import { SHAPED_GEAR, shapedDesign } from './helpers/shaped-gear.js';

test('finite loaded motion is allowed without an arbitrary speed limit', t => {
  const world = managedWorld(t, createConstruction('heavy'));
  setVehicle(world, { y: 20, vx: 300 });
  const before = physics(world);
  world.step();
  const after = physics(world);
  assert(world.vehicle.vx > 299 && world.vehicle.x > 16.9);
  assert(after.energyStoredJ.kinetic > before.energyStoredJ.kinetic * .99);
  assert.equal(after.recoveries, 0);
  assert.equal(after.energy.last.invalid, 0);
});

test('gravity may become kinetic energy without suspended joints or creating total energy', t => {
  const world = managedWorld(t, createConstruction('heavy'));
  setVehicle(world, { y: 20 });
  const before = physics(world);
  for (let frame = 0; frame < 60; frame++) world.step();
  const after = physics(world);
  assert(world.vehicle.y < 16 && world.vehicle.vy < -9);
  assert(after.energyStoredJ.kinetic > 1000);
  assert(after.energyStoredJ.gravity < before.energyStoredJ.gravity);
  assert(after.energyStoredJ.total <= before.energyStoredJ.total);
  assert(after.energy.last.gravityWork > 0 && Number.isFinite(after.energy.last.constraintEnergy));
  assert.equal(after.energy.last.constraintEnergy, 0, 'springs off the ground do no work');
  assert.equal(after.energyStoredJ.spring, 0);
  assert.equal(after.recoveries, 0);
});

test('non-finite host state and invalid timesteps are rejected before committing any part of the patch', t => {
  const world = managedWorld(t, createConstruction('heavy')), before = physics(world);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => setVehicle(world, { x: 200, vx: value }), /Invalid state patch/);
    assert.throws(() => world.step(value), /fixed step/);
    assert.deepEqual(physics(world), before);
  }
  world.step(); assert.equal(physics(world).recoveries, 0);
});

test('an atomic request rejection cannot erase a real incoming impulse', t => {
  // Solver-created runaway energy and restoration are covered by the typed
  // native force_motor_budget_and_solver_recovery_keep_game_limits test.
  const world = managedWorld(t, createConstruction('heavy')), plate = world.plates[0],
    before = ownerState(world, plate).state;
  impulse(world, plate, before.center, { x: before.mass * 12, y: 0 });
  const loaded = physics(world), body = ownerState(world, plate).state;
  assert(Math.abs(body.vx - before.vx - 12) < .00001);
  assert.throws(() => world.step(1 / 240), /fixed step/);
  assert.deepEqual(physics(world), loaded);
  world.step();
  assert(physics(world).bodyStates.some(body => body.vx > 0));
  assert.equal(physics(world).recoveries, 0);
});

test('a pile pressed against a bunker and let go comes apart instead of holding the world still', t => {
  // A big vehicle pushes a row of others against a bunker as hard as its own weight, and lets go. What the
  // push pressed into the pile the solver gives back as it takes them out of one another: a step taken back
  // for that came again the same, and every step after it, and a vehicle the push had lifted hung there.
  const world = managedWorld(t, createConstruction('heavy'));
  for (const [i, [template, facing]] of [['scout', 1], ['recon', -1], ['recon', 1], ['scout', -1], ['truck', -1], ['supply', 1]].entries())
    world.addActor(createConstruction(template), { id: `a${i}`, ownerId: 'alvo', x: -7.5 * i, facing });
  world.addActor(createConstruction('bunker'), { id: 'wall', ownerId: 'alvo', x: -48, facing: 1 });
  world.game();
  const plate = world.plates.find(p => p.actorId === 'local'), local = () => ownerState(world, plate).state, mass = local().mass;
  world.controlVehicle(-1, 0, 'local');
  for (let frame = 0; frame < 300; frame++) {
    const body = local();
    if (body.vx > -10) impulse(world, plate, body.center, { x: -mass * 10 / 60, y: 0 });
    world.step();
  }
  world.controlVehicle(0, 0, 'local');
  const pressed = physics(world);
  for (let frame = 0; frame < 120; frame++) world.step();
  const after = physics(world);
  assert.equal(after.recoveries, pressed.recoveries);
  assert(after.bodyStates.some((body, i) => body.x !== pressed.bodyStates[i].x), 'the pile moves once let go');
});

// Running gear the player placed unevenly settles and drives over rough ground, ahead and back, with every step the
// solver takes accepted and none taken back, never tipping over, and getting at least half as far as its template.
for (const [name, template, shape] of SHAPED_GEAR)
  test(`${name}: drives over rough ground with every solve accepted, upright, as its template does`, t => {
    const drive = (design, throttle) => {
      const world = managedWorld(t, { ...design, terrain: 'rough', seed: 900015 }), x = world.vehicle.x;
      let steepest = 0;
      for (let frame = 0; frame < 420; frame++) {
        if (frame === 60) world.controlVehicle(throttle);
        world.step();
        assert.equal(physics(world).energy.last.invalid, 0);
        steepest = Math.max(steepest, Math.abs(world.vehicle.pose().angle));
      }
      assert.equal(physics(world).recoveries, 0);
      return { went: Math.abs(world.vehicle.x - x), steepest };
    };
    for (const throttle of [-1, 1]) {
      const shaped = drive(shapedDesign(template, shape), throttle), made = drive(createConstruction(template), throttle);
      assert(shaped.steepest < 40 * Math.PI / 180, `${name}: ${shaped.steepest} rad`);
      assert(shaped.went > made.went / 2, `${name}: ${shaped.went} m against ${made.went} m`);
    }
  });

for (const name of ['ifv-rough-900015', 'balanced-mud-900003'])
  test(`${name}: current loaded motion retains the energy and stability gates`, t => {
    const row = currentStabilityEncounter(name, { template: 'ifv' });
    // Retain the braked-motion gate from the archived test: rough terrain is
    // compared with its identical quiet settling control, mud is <0.3 m/s.
    assertCurrentStability(row, { speed: name.includes('rough') ? 20 : .3, clearance: 3 });
    assert(row.firstLoad && row.firstLoad.step <= row.steps, 'measure loaded motion only after a real shot/explosion');
    if (name.includes('rough')) {
      const control = currentStabilityEncounter(name, { template: 'ifv', fire: false });
      assert.equal(control.stats.shots, 0); assert.equal(control.stats.explosions, 0);
      assert.equal(control.recoveries, 0); assert.equal(control.energyAudit.invalid, 0);
      // Both stand held by their brakes, so the quiet run only settles: the blows may add
      // their recoil to that, a centimetre a second at most, and rock the hull on its springs,
      // a millimetre at most, and nothing of the solver's.
      assert(row.loadedPeaks.speed <= control.peaks.speed + .01, `${row.loadedPeaks.speed} against ${control.peaks.speed}`);
      assert(row.loadedPeaks.clearance <= control.peaks.clearance + 1e-3);
      assert(row.energyAudit.maxUnexplainedGrowthJ <= control.energyAudit.maxUnexplainedGrowthJ + 1e-6);
    } else assert(row.loadedPeaks.speed < .3);
    t.diagnostic(JSON.stringify({ name, peaks: row.peaks, loadedPeaks: row.loadedPeaks, energyAudit: row.energyAudit, stats: row.stats }));
  });
