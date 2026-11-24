import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { blueprintPowertrain } from '../src/mass-properties.ts';
import { advance } from './mechanical-queries.js';
import { writtenTrack } from '../src/chassis.ts';
import { withChassisGearScale, withChassisSuspension } from '../src/chassis-editing.ts';

const near = (a, b, slack = 1e-6) => Math.abs(a - b) < slack;

test('wheels have no speed ceiling while tracks of any size run no faster than 70 km/h', () => {
  const scout = createConstruction('scout'), small = withChassisSuspension(withChassisGearScale(createConstruction('tracked'), .5), 0);
  small.chassis.track = writtenTrack(small.chassis, -2, 2);
  const [wheeled, heavy, tracked, half] = [scout, createConstruction('heavy'), createConstruction('tracked'), small].map(blueprintPowertrain);
  assert.equal(wheeled.gearedSpeed, null);
  assert(Number.isFinite(wheeled.maxSpeed) && wheeled.maxSpeed > 0);
  for (const drive of [heavy, tracked, half]) assert(near(drive.gearedSpeed, 70 / 3.6));
  assert(half.radius < tracked.radius * .6, 'a track half the size runs as fast');
  assert(near(heavy.maxSpeed, heavy.gearedSpeed, 1e-5) && near(tracked.maxSpeed, tracked.gearedSpeed, 1e-5),
    'both have power to spare on a hard flat road: the track is what stops them');
  // A smaller engine pulls less and reaches a lower physical equilibrium.
  const weaker = structuredClone(scout), engine = weaker.components.find(part => part.kind === 'engine');
  engine.sizeScale = (engine.sizeScale ?? 1) * .8;
  const modest = blueprintPowertrain(weaker);
  assert.equal(modest.gearedSpeed, null);
  assert(modest.maxSpeed < wheeled.maxSpeed && modest.powerKw < wheeled.powerKw && modest.maxDriveForce < wheeled.maxDriveForce);
});

test('compiled workshop powertrains agree with live installation, no fuel tank and missing engines', t => {
  const tanker = createConstruction('tanker'), empty = structuredClone(tanker), unpowered = structuredClone(tanker);
  empty.components = empty.components.filter(part => part.kind !== 'fuel');
  unpowered.components = unpowered.components.filter(part => part.kind !== 'engine');
  for (const source of [createConstruction('scout'), createConstruction('heavy'), tanker, empty, unpowered]) {
    const before = structuredClone(source), compiled = compileBlueprint(source), drive = blueprintPowertrain(compiled),
      world = new World(source); t.after(() => world.dispose());
    world.game();
    const live = world.vehicle.powertrain;
    for (const key of ['powerKw', 'torqueNm', 'drag', 'maxSpeed', 'maxDriveForce', 'powerPerTonne', 'fuelLitres'])
      assert(near(drive[key], live[key], 1e-7), key + ' is the admitted native value');
    for (const key of ['gearedSpeed', 'tracked', 'fuelStarved']) assert.equal(drive[key], live[key]);
    assert.deepEqual(source, before);
  }
});

test('past its track ceiling a vehicle only rolls: holding the throttle neither pushes nor holds it back', t => {
  const blueprint = createConstruction('heavy'); blueprint.terrain = 'flat';
  // `dead` is the same vehicle with an engine that gives nothing: the throttle held, it rolls and no more.
  const started = (speed, throttle, dead = false) => {
    const world = new World(blueprint); t.after(() => world.dispose()); world.game(); advance(world, 60);
    if (dead) world.command('setPartState', { owner: world.game().handle(world.modules.find(m => m.kind === 'engine')), state: { health: 0 } });
    world.command('setVehicleState', { state: { x: world.vehicle.x, y: world.vehicle.y, vx: -speed, vy: 0 } });
    world.controlVehicle(-throttle); advance(world, 45); return { vx: -world.vehicle.vx };
  };
  const ceiling = blueprintPowertrain(blueprint).gearedSpeed, fast = ceiling + 8,
    held = started(fast, 1), rolling = started(fast, 1, true);
  assert(rolling.vx < fast && rolling.vx > ceiling, 'only rolling and drag slow it down');
  assert(Math.abs(held.vx - rolling.vx) < 1e-3, `throttle ${held.vx} m/s, rolling ${rolling.vx} m/s`);
  // Below the ceiling the same throttle pushes.
  assert(started(8, 1).vx > started(8, 1, true).vx + .5);
  // Let go of, it brakes: three quarters of a second take what the brake can of it.
  const released = started(fast, 0);
  assert(released.vx < rolling.vx - 3 && released.vx > rolling.vx - 5 * .75 - 1e-6, `let go ${released.vx} m/s`);
});

test('wheels receive engine power above track rotation speed and their own flat-road equilibrium', t => {
  const blueprint = createConstruction('scout'); blueprint.terrain = 'flat';
  const started = (speed, dead) => {
    const world = new World(blueprint); t.after(() => world.dispose()); world.game(); advance(world, 60);
    if (dead) world.command('setPartState', { owner: world.game().handle(world.modules.find(m => m.kind === 'engine')), state: { health: 0 } });
    world.command('setVehicleState', { state: { vx: -speed, vy: 0 } });
    world.controlVehicle(-1); advance(world, 1); return world.vehicle;
  };
  const drive = blueprintPowertrain(blueprint);
  for (const speed of [50 * drive.radius + 8, drive.maxSpeed * 1.2]) {
    const powered = started(speed, false), rolling = started(speed, true);
    assert.equal(powered.powertrain.gearedSpeed, null);
    assert(-powered.vx > -rolling.vx, 'the engine keeps pushing; resistance can still reduce the net speed');
    assert(Number.isFinite(powered.vx) && Number.isFinite(powered.slip));
    assert(powered.fuelRate > rolling.fuelRate, 'useful engine work still consumes fuel');
  }
});
