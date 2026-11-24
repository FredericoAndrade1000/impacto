import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsMetrics, FrameBudget } from '../src/performance.ts';
import { World } from '../src/physics.ts';
import { weaponSettings } from '../src/weapons.ts';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { parseBlueprint, serializeBlueprint, validateBlueprint } from '../src/persistence.ts';
import { ownerState, physics, setPart, freewheel, advance } from './mechanical-queries.js';
import { VEHICLE_ORIGIN } from '../src/vehicle.ts';
import { localToWorld, worldToLocal } from '../src/math.ts';
import { blueprintMass } from '../src/mass-properties.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { boxBlueprint } from './helpers/perception-scene.js';
import { vehicleBox, standing } from './helpers/designs.js';
import { withChassisSuspension } from '../src/chassis-editing.ts';

// A four-metre box behind a front of 100 mm, on a seven-metre, four-axle frame with a 20 mm section.
// A rear of 300 mm adds the physical mass of 3 m × 2.4 m of steel per millimetre, without changing its supports.
function simpleVehicle(rearMm = 20) {
  const b = vehicleBox({ length: 4, height: 3, thicknessMm: 20, thicknesses: { front: 100, rear: rearMm }, model: 'wheeled',
    components: [
      { id: 'engine', kind: 'engine', pose: { x: .55, y: .29, angle: 0 } },
      { id: 'fuel', kind: 'fuel', pose: { x: -.6, y: 1.94, angle: 0 } },
    ] });
  // In cells of 5 cm: a frame from -3.5 m to 3.5 m at -0.4 m, its axles at -2.4, -0.8, 0.8 and 2.4 m.
  b.chassis = { model: 'wheeled', points: [{ x: -70, y: -8 }, { x: 70, y: -8 }], thicknessMm: 20, axles: [-48, -16, 16, 48] };
  // The bench stands 5 m before its front: the 4.25 m tube of a 120 mm gun ends short of it.
  b.launcher = { x: 5, y: 1.42 };
  // All of it hung where the suspension of that frame reaches its wheels.
  return withChassisSuspension(b, 0);
}

test('a 165 Hz display gets 60 draws per second instead of rounding down to 55', () => {
  for (const hz of [60, 144, 165, 240]) {
    const budget = new FrameBudget(); let draws = 0;
    for (let i = 1; i <= hz * 10; i++) if (budget.take(i * 1000 / hz)) draws++;
    assert(Math.abs(draws - 600) <= 1, `${hz} Hz produced ${draws} frames`);
  }
  const slow = new FrameBudget(); let draws = 0;
  for (let i = 1; i <= 300; i++) if (slow.take(i * 1000 / 30)) draws++;
  assert.equal(draws, 300);
});

test('automatic frame pacing follows every refresh and adapts to another display without changing simulation time', () => {
  const budget = new FrameBudget(0, 0); let now = 0;
  for (const hz of [60, 90, 120, 144, 165, 240, 360, 60]) {
    let drawn = 0;
    for (let i = 0; i < hz; i++) { now += 1000 / hz; if (budget.take(now)) drawn++; }
    assert.equal(drawn, hz);
  }
  budget.setLimit(60); budget.reset(now);
  let drawn = 0;
  for (let i = 0; i < 1650; i++) { now += 1000 / 165; if (budget.take(now)) drawn++; }
  assert.equal(drawn, 600);
  budget.setLimit(0); assert(budget.take(now + 1000 / 165));
});

test('physics metrics expose stalled steps and an actual slowdown', () => {
  const m = new PhysicsMetrics(0, 0); for (let i = 1; i <= 8; i++) m.record(i * 125, i === 4 ? 130 : 120);
  const p = m.read(1000, 8 / 60, 1, false, 0.2, 3);
  assert.equal(p.physicsHz, 8); assert.equal(p.physicsPeak, 130); assert(p.simRatio < 0.14); assert.equal(p.backlogMs, 200);
  assert.equal(m.read(1100, 8 / 60, 1, true, 0, 0).physicsHz, 0);
});

test('held fire uses fixed simulation time regardless of render snapshot frequency', () => {
  const b = createConstruction('empty'), a = new World(b), c = new World(b);
  for (const w of [a, c]) w.setTrigger(true, { x: 35, y: 2 }, weaponSettings('machinegun', { platform: 'ground', rate: 600, spread: 0 }));
  for (let i = 0; i < 120; i++) { a.step(); c.step(); if (i % 12 === 0) a.snapshot(); c.snapshot(); }
  assert.equal(a.stats.shots, 20); assert.deepEqual(a.stats, c.stats);
  assert.deepEqual(a.projectiles.map(p => [p.x, p.y]), c.projectiles.map(p => [p.x, p.y]));
  a.setTrigger(false); advance(a, 20); assert.equal(a.stats.shots, 20);
});

test('drive moves the chassis, supports and internal modules together', () => {
  const w = new World(createConstruction('scout')), source = structuredClone(w.actor().construction), original = worldToLocal(w.vehicle.pose(), w.modules[0]),
    shape = w.plates[0].nodes.map(n => ({ ...n.local }));
  w.controlVehicle(1); advance(w, 60); assert(w.vehicle.x > VEHICLE_ORIGIN.x + 0.7);
  const expected = localToWorld(w.vehicle.pose(), original.u, original.v);
  // The material weld follows the same accepted pose as the chassis.
  assert(Math.hypot(w.modules[0].x - expected.x, w.modules[0].y - expected.y) < 0.002);
  assert(w.plates[0].nodes.every((n, i) => Math.hypot(n.local.x - shape[i].x, n.local.y - shape[i].y) < 2e-6));
  assert.deepEqual(w.actor().construction, source);
});

test('long supported metal panels hold their shape under gravity', () => {
  const w = new World(createConstruction('heavy')),
    shapes = w.plates.map(p => p.nodes.map(n => ({ ...n.local })));
  advance(w, 90);
  w.plates.forEach((p, i) => assert(p.nodes.every((n, j) =>
    Math.hypot(n.local.x - shapes[i][j].x, n.local.y - shapes[i][j].y) < .002)));
});

test('blocked projectile impulse is conserved and grounded vehicle response depends on mass', t => {
  const hit = (rearMm, projectileMass) => {
    const w = new World(simpleVehicle(rearMm)); t.after(()=>w.dispose());
    // Its wheels free: let go of, the vehicle would hold its brake against the blow.
    freewheel(w);
    w.fire({ x: 10, y: 1.42 }, weaponSettings('cannon', { platform: 'ground', power: 10, speed: 800, mass: projectileMass, spread: 0 }), true);
    advance(w, 4);
    const event=w.drainEvents().find(e=>e.type==='blocked' && e.primaryContact);
    assert(event,'the real primary must be stopped by the authored armour');
    assert(event.speed>0 && event.speed<800,'air drag reduces velocity before the hit');
    assert.equal(event.mass,projectileMass);
    assert(Math.abs(w.vehicle.peakImpulse-projectileMass*event.speed)<.1,
      'stopped momentum is measured at the actual dragged impact velocity');
    return w;
  };
  const light = hit(20, 2), heavy = hit(300, 2), big = hit(20, 4);
  assert(heavy.vehicle.mass > light.vehicle.mass * 1.8);
  assert(light.vehicle.vx>0);assert(heavy.vehicle.vx<light.vehicle.vx);assert(big.vehicle.vx>light.vehicle.vx);
  assert(Math.abs(light.vehicle.angle) > 0);
  assert(big.vehicle.peakImpulse>light.vehicle.peakImpulse);
});

test('a fixed vehicle resists impact translation and ignores drive input', () => {
  const w = new World(standing(simpleVehicle()));
  w.controlVehicle(1); w.fire({ x: 10, y: 1.42 }, weaponSettings('cannon', { platform: 'ground', power: 10, spread: 0 }), true); advance(w, 30);
  const [carrier] = physics(w).bodyStates;
  assert.equal(carrier.dynamic, false); assert.equal(carrier.x, 12); assert.equal(carrier.vx, 0);
});

test('repeated cannon hits disable the robust armament while retaining surviving welds and no automatic fireball', () => {
  const source = standing(createConstruction('heavy'));
  // This checks the gun casing itself. A penetrating receiver shot continues
  // downward into the stock fuel tank; its genuine cook-off belongs to the
  // reservoir/explosion tests rather than being mistaken for a gun fireball.
  source.components = source.components.filter(m => !['ammo', 'fuel'].includes(m.kind));
  const w = new World(source), gun = w.modules.find(m => m.kind === 'weapon'),
    shot = weaponSettings('cannon', { preset: 'rh120', platform: 'ground', spread: 0 });
  // Strike the receiver from above. The original sloping shot only grazes
  // the barrel and must not multiply damage along its connected silhouette.
  const receiver = mountedWeaponPolygons(gun)[0],
    center = receiver.reduce((p, v) => ({ x: p.x + v.x / receiver.length, y: p.y + v.y / receiver.length }), { x: 0, y: 0 });
  // The receiver sits inside the tower; the host-wall pivot is not
  // the mechanism's centre. Aim through the real native receiver polygon.
  // The tower stands open to the hull, so a round through the receiver goes on into the hull.
  // The muzzle comes down to 5 m over the ground, over the roof of the tower.
  w.command('configureLauncher', { point: { x: center.x, y: 5 + shot.barrel } });
  for (let i = 0; i < 8 && gun.health > 0; i++) { w.fire(center, shot, true); advance(w, 25); }
  assert.equal(gun.health, 0);
  assert.equal(w.stats.explosions, 0);
  assert.equal(ownerState(w, gun)?.body, physics(w).bodyStates[0].handle, 'the ballistic gun belongs to the carrier');
  assert.equal(ownerState(w, gun)?.colliders, 0, 'the barrel is not a terrain lever');
  assert(gun.physicalMass>0,'functional failure retains its physical bulk');
  assert.equal(gun.attached,true,'a centre hit retains the remote mounting material');
});

test('a destroyed engine stops acceleration but preserves the chassis inertia', () => {
  const w = new World(createConstruction('heavy')); advance(w,30);w.controlVehicle(1); advance(w, 45);
  const speed = w.vehicle.vx, x = w.vehicle.x,engine=w.modules.find(m=>m.kind==='engine'); setPart(w, engine, { health: 0 }); advance(w, 5);
  assert(!w.vehicle.engine); assert(w.vehicle.x > x + 0.01); assert(w.vehicle.vx > 0); assert(w.vehicle.vx < speed);
  // On this flat rock surface braking supplies 5 m/s² before rolling loss.
  // The entry speed changes with template mass; allow its physical stop time
  // plus one frame, retaining the same residual-speed threshold.
  const stoppingFrames = Math.ceil(w.vehicle.vx / 5 * 60) + 1;
  w.controlVehicle(0, 1); advance(w, stoppingFrames); assert(Math.abs(w.vehicle.vx) < 0.001);
});

test('mounted fire recoils, inherits movement and does not strike its own casing', () => {
  const source = createConstruction('heavy'), w = new World(source);
  w.removeActor('local'); w.addActor(source, { id: 'local', ownerId: 'local', facing: 1 });
  w.command('setVehicleState', { state: { vx: 2 } });
  const installed = w.modules.find(m => m.kind === 'weapon'),
    gun = weaponSettings('cannon', { preset: 'rh120', platform: 'vehicle', componentId: installed.id, spread: 0 });
  assert(w.fire({ x: 40, y: installed.y }, gun));
  assert(w.vehicle.vx < 2); assert(Math.abs(w.projectiles[0].vx - (gun.speed + 2)) < 1e-8);
  advance(w, 4); assert.equal(w.stats.impacts, 0); assert.equal(installed.health, installed.maxHealth);
  setPart(w, installed, { health: 0 }); assert.equal(w.fire({ x: 40, y: installed.y }, gun, true), false);
});

test('a moving damaged plate retains its genuine aperture', () => {
  const w = new World(simpleVehicle()),
    front = w.plates.find(p => p.id.endsWith('hull:front'));
  w.fire({ x: 10, y: 1.42 }, weaponSettings('cannon', { platform: 'ground', power: 430, spread: 0 }), true); advance(w, 12);
  const indices = [...front.activeIndices], before = w.vehicle.pose(), holeX = front.definition.x;
  w.controlVehicle(1); advance(w, 50);
  const after = w.vehicle.pose();
  const [a, c] = [{ x: holeX - .2, y: 1.42 }, { x: holeX + .2, y: 1.42 }]
    .map(point => worldToLocal(before, point)).map(point => localToWorld(after, point.u, point.v));
  assert.equal(w.index.raycast(a, c), null);
  assert.deepEqual([...front.activeIndices], indices, 'motion retains the original contour while the aperture stays empty');
});

test('installed armour preserves ballistic apertures independently of the fixed contact contour', t => {
  const blueprint = boxBlueprint({ length: 2, height: 2, rideHeight: .15, thicknessMm: 800 });
  const world = new World(blueprint); t.after(() => world.dispose());
  const plate = world.plates.find(p => p.id.endsWith('hull:front')), x = plate.definition.x,
    original = physics(world), contour = structuredClone(world.actor().contactContours);
  assert(contour.length > 0 && contour.every(polygon => polygon.length >= 3));
  world.cutBody(plate, { x: x - .5, y: 1.15 }, { x: x + .5, y: 1.15 }, .2);
  assert.equal(world.index.raycast({ x: x - .5, y: 1.15 }, { x: x + .5, y: 1.15 }), null);
  assert.equal(world.index.raycast({ x: x - .5, y: 1.6 }, { x: x + .5, y: 1.6 }).owner.id, plate.id);
  assert.equal(physics(world).bodies, original.bodies);
  assert.equal(physics(world).colliders, original.colliders);
  assert.deepEqual(world.actor().contactContours, contour);
  assert.equal(physics(world).bodyStates[0].mass, original.bodyStates[0].mass);
});

test('vehicle construction determines runtime mass and reset clears motion', () => {
  const b = simpleVehicle();
  const restored = parseBlueprint(serializeBlueprint(b));
  // Of the vehicle the design keeps only the chassis it stands on, as written: no mass, nothing derived.
  assert.deepEqual(restored.chassis, b.chassis); assert.equal(restored.vehicle, undefined);
  assert.deepEqual(restored.components, validateBlueprint(b).components);
  assert.throws(() => parseBlueprint(JSON.stringify({ ...b, chassis: { ...b.chassis, maxSpeed: 8 } })), { reason: 'AUTHORING_FIELDS' });
  const w = new World(restored); w.game(); assert(Math.abs(w.vehicle.mass - blueprintMass(w.blueprint)) < 1e-6);
  w.controlVehicle(1); advance(w, 40); w.reset();
  assert.equal(w.vehicle.x, 12); assert.equal(w.vehicle.vx, 0); assert.equal(w.trigger, null); assert.equal(w.vehicle.throttle, 0);
  // Whether it drives is not written either: it drives because it has a chassis.
  assert.throws(() => parseBlueprint(JSON.stringify({ ...b, vehicle: { enabled: true } })), { reason: 'AUTHORING_FIELDS' });
});
