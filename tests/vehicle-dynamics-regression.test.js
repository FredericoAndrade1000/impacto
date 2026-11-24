import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { kineticEnergy } from '../scripts/probes-impact.ts';
import { mechanicalState, actorPhysics, partPhysics, physicsState, componentMaterialPoint } from '../scripts/review-harness.ts';
import { componentPolygon } from '../src/assembly.ts';
import { managedWorld, advance } from './mechanical-queries.js';
import { SHAPED_GEAR, shapedDesign } from './helpers/shaped-gear.js';

function momentum(world) {
  const state = mechanicalState(world);
  return { mass: state.mass, x: state.px, y: state.py, moment: state.angular };
}
const near = (a, b, tolerance = .02) => assert(Math.abs(a - b) < tolerance, a + ' != ' + b);

test('public part views compare replay state without exposing the ownership graph or native body references', t => {
  const design = createConstruction('heavy'), left = managedWorld(t, design), right = managedWorld(t, design);
  for (const world of [left, right]) {
    for (const key of ['modules', 'plates', 'actors'])
      assert(Object.keys(world[key]).every(key => /^\d+$/.test(key)), 'part views expose only ordered items');
    assert(world.modules.every(m => !Object.keys(m).includes('body') && !Object.keys(m).includes('originCache')));
    world.controlVehicle(.4); advance(world, 24);
    assert.doesNotThrow(() => structuredClone(world.snapshot()), 'snapshot is a transferable state projection');
  }
  assert.deepEqual(left.modules, right.modules, 'deterministic module data compares without traversing the backend');
});

test('paused construction and restore expose the real fuel and motor rating without advancing motion', t => {
  const world = managedWorld(t, createConstruction('heavy')), initial = world.snapshot().actors.find(actor => actor.id === 'local').vehicle,
    fuel = world.modules.filter(m => m.kind === 'fuel' && m.attached !== false)
      .reduce((sum, m) => sum + m.fuelLitres, 0), pose = world.vehicle.pose();
  assert(fuel > 0); assert.equal(initial.fuelLitres, fuel);
  assert(initial.powerKw > 0 && initial.engine && !initial.fuelStarved);
  world.snapshot(); world.snapshot();
  assert.equal(world.tick, 0); assert.equal(world.time, 0); assert.deepEqual(world.vehicle.pose(), pose);
  for (const tank of world.modules.filter(m => m.kind === 'fuel')) {
    world.command('setPartState', { owner: world.game().handle(tank), state: { fuelLitres: 0 } });
  }
  const empty = world.snapshot().actors.find(actor => actor.id === 'local').vehicle;
  assert.equal(empty.fuelLitres, 0); assert.equal(empty.powerKw, 0);
  assert(!empty.engine && empty.fuelStarved); assert.equal(empty.maxSpeed, 0);
  world.reset();
  const restored = world.snapshot().actors.find(actor => actor.id === 'local').vehicle;
  assert.equal(restored.fuelLitres, fuel); assert.equal(restored.powerKw, initial.powerKw);
  assert.equal(restored.maxSpeed, initial.maxSpeed);
  assert.equal(world.tick, 0); assert.equal(world.time, 0); assert.deepEqual(world.vehicle.pose(), pose);
});

test('damage and consumed reserves change the one motor projection immediately while preserving coasting', t => {
  const world = managedWorld(t, createConstruction('heavy')), vehicle = world.vehicle,
    engine = world.modules.find(m => m.kind === 'engine'), ammo = world.modules.find(m => m.kind === 'ammo'),
    initial = world.snapshot().actors.find(actor => actor.id === 'local').vehicle;
  world.game().call({ op: 'setVehicleState', state: { vx: 3, vy: -.2, omega: .1 } });
  const motion = [vehicle.vx, vehicle.vy, vehicle.omega], pose = vehicle.pose(), field = vehicle.velocityAt(pose);
  world.game().call({ op: 'setPartState', owner: world.game().handle(engine), state: { health: engine.maxHealth * .75 } });
  const damaged = vehicle.snapshot();
  near(damaged.powerKw, initial.powerKw * .75, 1e-8);
  assert.equal(vehicle.availablePowerKw, damaged.powerKw);
  assert.equal(vehicle.drivetrain.maxSpeed, damaged.maxSpeed);
  assert.equal(vehicle.powerPerTonne, damaged.powerPerTonne);
  assert.deepEqual([vehicle.vx, vehicle.vy, vehicle.omega], motion);
  world.game().call({ op: 'setPartState', owner: world.game().handle(ammo), state: { rounds: ammo.rounds - 1 } });
  const lighter = vehicle.snapshot();
  assert.equal(lighter.massTonnes, damaged.massTonnes);
  assert.equal(lighter.powerPerTonne, damaged.powerPerTonne); assert.equal(lighter.powerKw, damaged.powerKw);
  near(vehicle.velocityAt(pose).x, field.x, 1e-8); near(vehicle.velocityAt(pose).y, field.y, 1e-8);
  const lighterMotion = [vehicle.vx, vehicle.vy, vehicle.omega];
  world.game().call({ op: 'setPartState', owner: world.game().handle(engine), state: { health: 0 } });
  const failed = vehicle.snapshot();
  assert.equal(failed.powerKw, 0); assert.equal(failed.powerPerTonne, 0);
  assert.equal(vehicle.drivetrain.maxSpeed, 0); assert(!failed.engine);
  assert.equal(world.tick, 0); assert.deepEqual(vehicle.pose(), pose);
  assert.deepEqual([vehicle.vx, vehicle.vy, vehicle.omega], lighterMotion);
});

test('armour perforations preserve installation, fixed mass and the rigid carrier velocity field', t => {
  const world = managedWorld(t, createConstruction('heavy')), vehicle = world.vehicle, roof = world.plates.find(p => p.id.endsWith('hull:roof')), body = actorPhysics(world).handle;
  world.command('setVehicleState', { state: { vx: 2.4, vy: -.35, omega: .83 } });
  const beforeMass = momentum(world).mass, beforeArea = roof.remainingArea,
    sample = { x: roof.definition.x, y: roof.definition.y }, expected = vehicle.velocityAt(sample),
    contours = structuredClone(world.actor().contactContours);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  world.cutBody(roof, { x: sample.x, y: sample.y - .15 }, { x: sample.x, y: sample.y + .15 }, .035);
  assert(roof.remainingArea < beforeArea); assert(roof.attached);
  assert.equal(actorPhysics(world).handle, body);
  near(momentum(world).mass, beforeMass); assert.deepEqual(world.actor().contactContours, contours);
  const native = actorPhysics(world), actual = { x: native.vx - native.omega * (sample.y - native.center.y),
    y: native.vy + native.omega * (sample.x - native.center.x) };
  near(actual.x, expected.x, .00002); near(actual.y, expected.y, .00002);
  const after = momentum(world); physicsState(world); assert.deepEqual(momentum(world), after);
});

test('removing all chassis material cannot disconnect installed engines or running gear', t => {
  const world = managedWorld(t, createConstruction('heavy')), root = world.plates.find(p => p.id === world.vehicle.config.chassisId),
    vehicle = world.vehicle, carrier = actorPhysics(world).handle,
    engine = world.modules.find(m => m.kind === 'engine'), power = vehicle.availablePowerKw,
    bodies = physicsState(world).bodyStates.map(b => b.handle),
    mass = momentum(world).mass;
  world.cutBody(root, root.definition, root.definition, root.definition.length * 2);
  assert.equal(root.remainingArea, 0); assert(root.attached && engine.attached);
  assert.equal(vehicle.availablePowerKw, power);
  assert.equal(actorPhysics(world).handle, carrier);
  assert.deepEqual(physicsState(world).bodyStates.map(b => b.handle), bodies);
  near(momentum(world).mass, mass);
  advance(world, 15);
  assert(world.modules.every(m => m.attached));
  assert.equal(world.dynamics.recoveries || 0, 0);
  assert(Number.isFinite(vehicle.y + vehicle.vx + vehicle.vy + vehicle.omega));
});

test('intact multi-point armour stays rigid with local material and suspension mass preserved', t => {
  const world = managedWorld(t, createConstruction('heavy')), roof = world.plates.find(p => p.id.endsWith('hull:roof')), geometry = roof.nodes.map(n => ({ ...n.local })), before = momentum(world).mass;
  advance(world, 90);
  assert.equal(roof.integrity, 1); assert(roof.attached);
  assert.deepEqual(roof.nodes.map(n => n.local), geometry);
  assert.equal(partPhysics(world, roof).body, actorPhysics(world).handle);
  near(momentum(world).mass, before);
  assert.equal(world.dynamics.recoveries || 0, 0);
});

// Running gear the player placed unevenly hangs on its carrier as the model's does: one rigid body that keeps its mass,
// no joints, all of it attached; and the construction comes to rest level on its gear.
for (const [name, template, shape] of SHAPED_GEAR)
  test(`${name}: the gear stays rigid on its carrier, keeps the mass of the structure and rests level`, t => {
    const world = managedWorld(t, { ...shapedDesign(template, shape), terrain: 'flat' }), mass = momentum(world).mass,
      body = actorPhysics(world).handle;
    advance(world, 120);
    assert(world.modules.every(m => m.attached));
    assert.equal(actorPhysics(world).handle, body);
    near(momentum(world).mass, mass);
    assert.equal(world.dynamics.recoveries || 0, 0);
    assert(Math.abs(world.vehicle.pose().angle) < .2 * Math.PI / 180, `${name}: ${world.vehicle.pose().angle} rad`);
  });

test('an off-centre load on a rotating carrier preserves linear and angular impulse', t => {
  const point = { x: 10.23, y: 2.01 }, impulse = { x: 40, y: -11 },
    expectedMoment = point.x * impulse.y - point.y * impulse.x,
    halfUlp32 = value => 2 ** (Math.floor(Math.log2(Math.max(Math.abs(value), 2 ** -126))) - 24),
    unitRoundoff = 2 ** -24, gamma5 = 5 * unitRoundoff / (1 - 5 * unitRoundoff);
  for (const omega of [0, 11, -11]) {
    const world = managedWorld(t, createConstruction('heavy')), owner = world.plates[0];
    world.command('setVehicleState', { state: { vx: 2.5, vy: -.75, omega } });
    const before = momentum(world), body = actorPhysics(world), center = body.center,
      unchanged = b => [b.x, b.y, b.angle, b.mass, b.inertia, b.center.x, b.center.y];
    world.command('impulse', { owner: world.game().handle(owner), point, impulse });
    const after = momentum(world), loaded = actorPhysics(world);
    near(after.x - before.x, impulse.x); near(after.y - before.y, impulse.y);
    // Rapier stores velocity in f32. A final half ULP is weighted by the
    // admitted inertia, mass and COM instead of a construction-specific .02.
    const stateRounding = body.inertia * halfUlp32(loaded.omega) + body.mass *
      (Math.abs(center.x) * halfUlp32(loaded.vy) + Math.abs(center.y) * halfUlp32(loaded.vx)),
      pointRounding = Math.abs(impulse.y * (Math.fround(point.x) - point.x)) +
        Math.abs(impulse.x * (Math.fround(point.y) - point.y)),
      // At most five rounded operations before velocity addition: lever-arm
      // subtraction, product, cross subtraction, inverse property and product.
      arithmetic = gamma5 * (Math.abs((point.x - center.x) * impulse.y) +
        Math.abs((point.y - center.y) * impulse.x) + Math.abs(center.x * impulse.y) + Math.abs(center.y * impulse.x)),
      projectionRounding = 4 * Number.EPSILON * (Math.abs(before.moment) + Math.abs(after.moment)),
      bound = stateRounding + pointRounding + arithmetic + projectionRounding;
    assert(bound < Math.abs(expectedMoment) / 1000, 'quantization allowance stays below 0.1% of the applied angular impulse');
    near(after.moment - before.moment, expectedMoment, bound);
    assert.deepEqual(unchanged(loaded), unchanged(body), 'instant impulse preserves pose, COM, mass and inertia');
    assert.equal(after.mass, before.mass); assert(partPhysics(world, owner).state.dynamic);
    assert.equal(world.tick, 0); assert.equal(world.time, 0);
  }
});

test('a 25 mm shot damages the rigidly installed track with bounded mechanical energy and fixed mass', t => {
  const world = managedWorld(t, createConstruction('heavy')); world.game();
  const track = world.modules.find(m => m.kind === 'track'),
    initialIntegrity = new Map(world.plates.map(p => [p.id, p.integrity])),
    contours = structuredClone(world.snapshot().actors[0].contactContours), mass = momentum(world).mass,
    settings = weaponSettings('autocannon', { preset: 'm242', platform: 'ground', ammo: 'ap', spread: 0 }),
    aim = componentMaterialPoint(track, { u: .5, v: .85 }),
    launcher = { x: Math.min(...componentPolygon(track).map(p => p.x)) - settings.barrel - 1, y: aim.y };
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  world.game().call({ op: 'configureLauncher', point: launcher });
  world.fire(aim, settings, true); world.step();
  assert(world.drainEvents().some(e => e.type === 'module' && e.id === track.id));
  assert(track.attached && track.health < track.maxHealth * .75);
  for (let i = 1; i < 90; i++) {
    world.step(); assert(kineticEnergy(world) < settings.mass * settings.speed ** 2);
  }
  near(momentum(world).mass, mass, 1e-9); assert.deepEqual(world.actor().contactContours, contours);
  assert.equal(world.stats.explosions, 0);
  assert(world.plates.every(p => p.attached && p.integrity === initialIntegrity.get(p.id)));
  assert.equal(world.dynamics.recoveries || 0, 0);
});

test('a curved track hit transfers finite impulse to the full carrier inertia', t => {
  const world = managedWorld(t, createConstruction('heavy')), track = world.modules.find(m => m.kind === 'track'),
    point = componentMaterialPoint(track, { u: .015, v: .21 }),
    launcher = { x: 1.65, y: .55 }, dx = point.x - launcher.x, dy = point.y - launcher.y,
    direction = Math.hypot(dx, dy), settings = weaponSettings('cannon', { preset: 'rh120', ammo: 'ap', spread: 0 }),
    incidentImpulse = settings.mass * settings.speed, jx = incidentImpulse * dx / direction, jy = incidentImpulse * dy / direction;
  const before = momentum(world), contours = structuredClone(world.actor().contactContours);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  world.command('impulse', { owner: world.game().handle(track), point, impulse: { x: jx, y: jy } });
  const after = momentum(world);
  near(after.x - before.x, jx); near(after.y - before.y, jy);
  near(after.moment - before.moment, point.x * jy - point.y * jx);
  assert(kineticEnergy(world) < .5 * settings.mass * settings.speed ** 2);
  near(after.mass, before.mass); assert.deepEqual(world.actor().contactContours, contours);
});
