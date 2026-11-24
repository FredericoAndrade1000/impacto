import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleBox } from './helpers/designs.js';
import { createConstruction } from '../src/construction-templates.ts';
import { blueprintMass, blueprintPowertrain, pieceMass } from '../src/mass-properties.ts';
import { parseBlueprint, serializeBlueprint, validateBlueprint, compileBlueprint } from '../src/persistence.ts';
import { componentMaterialPoint } from '../scripts/review-harness.ts';
import { weaponSettings } from '../src/weapons.ts';
import { mechanicalState } from '../scripts/probes-mobility.ts';
import { engineBox, gearChassis } from './helpers/mechanics-source.js';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { physics, ownerState, wheelPhysics, impulse, setPart, flyRound, managedWorld, advance } from './mechanical-queries.js';
import { REVERSE_SHARE } from '../src/battle-rules.ts';
import { withChassisGearScale, withChassisThickness } from '../src/chassis-editing.ts';

// Admitted at once: what the vehicle weighs is the core's.
const managed = (t, b) => { const w = managedWorld(t, b); w.game(); return w; };
const nativeMass = w => mechanicalState(w).mass;
const contactShape = w => {
  const contours = w.actor().contactContours;
  assert(Array.isArray(contours) && contours.length > 0);
  assert(contours.every(polygon => Array.isArray(polygon) && polygon.length >= 3 &&
    polygon.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
  return structuredClone(contours);
};
// One contact of a stated power: an armour-piercing round set two centimetres off one end of a
// component (-1 its left, 1 its right) and flown level into it, spent a few centimetres inside.
const strike = (w, part, power, radius, side = -1) => flyRound(w, { x: part.x + side * (part.width / 2 + .02), y: part.y,
  vx: -side * 600, vy: 0, power, radius, mass: .2, caliberMm: radius * 2000, ammo: 'ap' }, .0001);
const velocityAt = (body, point) => ({ x: body.vx - body.omega * (point.y - body.center.y),
  y: body.vy + body.omega * (point.x - body.center.x) });
function measureEquilibrium(world, direction, { maxSeconds = 120, minSeconds = 30 } = {}) {
  // Two-second windows must converge, rather than sampling at a fixed time
  // while the heavier construction is still accelerating. No velocity is
  // prescribed to the solver. A finite horizon fails loudly if it never settles.
  const windowFrames = 120, windows = [];
  let samples = [], previous = null;
  world.controlVehicle(direction);
  for (let frames = 1; frames <= maxSeconds * 60; frames++) {
    advance(world, 1);
    const speed = direction * world.vehicle.vx;
    assert(Number.isFinite(speed), 'the speed measurement must remain finite');
    samples.push(speed);
    if (frames % windowFrames) continue;
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length,
      spread = Math.max(...samples) - Math.min(...samples), seconds = frames / 60,
      delta = previous ? Math.abs(mean - previous.mean) : Infinity;
    windows.push({ seconds, mean, spread });
    if (seconds >= minSeconds && mean > 5 && previous &&
        spread < mean * .0025 && previous.spread < previous.mean * .0025 && delta < mean * .0025)
      return { frames, seconds, speed: world.vehicle.vx, mean, samples, windows: windows.slice(-3) };
    previous = { mean, spread }; samples = [];
  }
  assert.fail('No observed equilibrium within the finite horizon: ' + JSON.stringify(windows.slice(-4)));
}
// The scout stands on two axles, on wheels of 0.95 m. Its hull has room for an engine
// of the size the speed experiment uses.
const twoAxleScout = () => createConstruction('scout');

test('admitted engine and wheel kilograms follow authored size', () => {
  assert.equal(pieceMass(compileBlueprint(engineBox()).modules[0]), 880);
  // Twice its room, as long and tall by the square root of two, as deep across the body: twice its mass.
  assert(Math.abs(pieceMass(compileBlueprint(engineBox(Math.sqrt(2))).modules[0])-1760)<1e-8);
  // A wheel of 0.74 m weighs 110 kg and grows with the 2.5th power of its diameter.
  const source = gearChassis(), wheel = compileBlueprint(source).modules.find(m => m.kind === 'wheel');
  assert(Math.abs(pieceMass(wheel) - 110 * (wheel.height / .74) ** 2.5) < 1e-8);
});

test('mass readings require a finite nonnegative measurement from the native compiler', () => {
  const source = createConstruction('scout'), compiled = compileBlueprint(source);
  assert.equal(blueprintMass(compiled), compiled.fixedAssembly.mass);
  assert.equal(blueprintMass(source), compiled.fixedAssembly.mass);
  assert.equal(pieceMass({ physicalMass: 0 }), 0);
  assert.throws(() => pieceMass({ length: 1, thicknessMm: 100, material: 'steel' }), TypeError);
  for (const part of [...compiled.plates, ...compiled.modules])
    assert.throws(() => pieceMass({ ...part, physicalMass: undefined }), TypeError, part.id);
  for (const mass of [undefined, NaN, Infinity, -1]) {
    assert.throws(() => pieceMass({ physicalMass: mass }), TypeError);
    assert.throws(() => blueprintMass({ ...compiled, fixedAssembly: { mass } }), TypeError);
  }
  assert.throws(() => blueprintMass({ ...compiled, fixedAssembly: undefined }), TypeError);
});

test('JSON persists construction and engine dimensions rather than cached performance ratings', t => {
  const b = createConstruction('scout');
  for (const key of ['massTonnes', 'maxSpeed']) assert.throws(() => validateBlueprint({ ...b,
    chassis: { ...b.chassis, [key]: 99 } }), { reason: 'AUTHORING_FIELDS' });
  const restored = parseBlueprint(serializeBlueprint(b)), mass = blueprintMass(restored);
  // Of the vehicle the file keeps the chassis as it was written, its model and its ends: no rating of it.
  assert.deepEqual(restored.chassis, b.chassis); assert.equal(restored.vehicle, undefined);
  const world = managed(t, restored);
  assert(Math.abs(world.vehicle.mass - mass) < 1e-6);
  assert(Math.abs(world.vehicle.powertrain.maxSpeed - blueprintPowertrain(restored).maxSpeed) < 1e-8);
  assert.equal(restored.components.find(m => m.kind === 'engine').sizeScale, b.components.find(m => m.kind === 'engine').sizeScale);
  b.components.find(m => m.kind === 'engine').depthM = 100;
  assert.throws(() => validateBlueprint(b), { reason: 'AUTHORING_FIELDS' });
});

test('an exposed engine remains part of one rigid carrier without a support permission', t => {
  const b = createConstruction('scout');
  const engine = b.components.find(part => part.kind === 'engine');
  engine.pose = { ...engine.pose, y: 80 }; // 4 m, in cells of the grid
  const compiled = compileBlueprint(b), outside = compiled.modules.find(part => part.id === engine.id), world = managed(t, b);
  assert.equal(outside.exposed, true); assert.equal(outside.y, 5.3);
  assert.equal(physics(world).bodies, 1); assert.equal(nativeMass(world), blueprintMass(compiled));
});

test('functional wheel failure preserves the one carrier and all admitted construction mass', t => {
  const b = twoAxleScout(), w = managed(t, b), expected = blueprintMass(b),
    wheel = w.modules.find(m => m.kind === 'wheel'), before = wheelPhysics(w, wheel);
  assert.equal(before.bodies.length, 1);
  assert(Math.abs(nativeMass(w) - expected) < expected * 2e-6);
  advance(w, 120); strike(w, wheel, 400, .06);
  assert(wheel.attached && wheel.health === 0);
  const after = wheelPhysics(w, wheel);
  assert.equal(after.owner.body, before.owner.body); assert.equal(physics(w).bodies, w.actors.length);
  assert.deepEqual(after.bodies.map(body => body.handle), before.bodies.map(body => body.handle));
  assert(Math.abs(nativeMass(w) - expected) < expected * 2e-6);
});

test('an off-centre wheel strike preserves carrier COM and inertia while transferring its impulse', t => {
  const w = managed(t, twoAxleScout()); advance(w, 60);
  const wheel = w.modules.find(m => m.kind === 'wheel'),
    before = ownerState(w, wheel), contour = contactShape(w),
    pose = { x: wheel.x, y: wheel.y, angle: wheel.angle }, mass = nativeMass(w);
  // The scout has come to rest: the step that flies the round moves it by nothing but the round,
  // which enters by the rim, a radius off the hub.
  assert(before.state.sleeping);
  strike(w, wheel, 100, .06, 1);
  assert.equal(w.stats.penetrations, 1); assert(wheel.health < wheel.maxHealth);
  const cut = ownerState(w, wheel);
  assert.equal(cut.body, before.body); assert.equal(cut.state.mass, before.state.mass);
  assert.equal(cut.state.inertia, before.state.inertia); assert.deepEqual(cut.state.center, before.state.center);
  assert.deepEqual({ x: wheel.x, y: wheel.y, angle: wheel.angle }, pose);
  assert.deepEqual(w.actor().contactContours, contour); assert.equal(nativeMass(w), mass);
  const point = { x: wheel.x + .1, y: wheel.y }, applied = { x: 20, y: 30 };
  impulse(w, wheel, point, applied);
  const after = ownerState(w, wheel).state;
  assert(Math.abs(after.mass * (after.vx - cut.state.vx) - applied.x) < .01);
  assert(Math.abs(after.mass * (after.vy - cut.state.vy) - applied.y) < .01);
  assert.equal(w.dynamics.recoveries || 0, 0);
});

test('a ballistic hub hit damages the installed wheel without creating a separate spin body', t => {
  const w = managed(t, twoAxleScout()), wheel = w.modules.find(m => m.kind === 'wheel'),
    before = wheelPhysics(w, wheel), mass = nativeMass(w);
  strike(w, wheel, 100, .06); // level, at the height of the hub
  assert.equal(w.stats.penetrations, 1); assert(wheel.health < wheel.maxHealth && wheel.attached);
  assert.equal(wheelPhysics(w, wheel).owner.body, before.owner.body);
  assert.equal(nativeMass(w), mass);
  advance(w, 60);
  assert(Number.isFinite(w.vehicle.y) && Math.abs(w.vehicle.vy) < 1);
  assert.equal(w.dynamics.recoveries || 0, 0);
});

test('destroyed running gear loses traction without removing support, mass or allocating epsilon bodies', t => {
  const w = managed(t, twoAxleScout()); advance(w, 120);
  const mass = nativeMass(w), contour = contactShape(w), x = w.vehicle.x;
  for (const wheel of w.modules.filter(m => m.kind === 'wheel')) setPart(w, wheel, { health: 0 });
  w.controlVehicle(1); advance(w, 120);
  assert.equal(w.vehicle.traction, 0);
  assert(Math.abs(w.vehicle.x - x) < .02); assert(Math.abs(w.vehicle.vx) < .01);
  assert.equal(nativeMass(w), mass); assert.deepEqual(w.actor().contactContours, contour);
  assert.equal(physics(w).bodies, 1);
  assert(Number.isFinite(w.vehicle.y + w.vehicle.vx + w.vehicle.vy + w.vehicle.omega));
  assert.equal(w.dynamics.recoveries || 0, 0);
});

test('two large wheels settle without bouncing and retain their material hub while rolling', t => {
  const w = managed(t, twoAxleScout()); advance(w, 180);
  let low = Infinity, high = -Infinity, verticalSpeed = 0;
  w.controlVehicle(1);
  for (let i = 0; i < 360; i++) {
    w.step(); w.drainEvents(); low = Math.min(low, w.vehicle.y); high = Math.max(high, w.vehicle.y);
    verticalSpeed = Math.max(verticalSpeed, Math.abs(w.vehicle.vy));
    for (const wheel of w.modules.filter(m => m.kind === 'wheel')) {
      const center = componentMaterialPoint(wheel, { u: .5, v: .5 });
      assert(Math.hypot(center.x - wheel.x, center.y - wheel.y) < 1e-6);
      // These wheels move within the 0.25 m of travel of the wheeled chassis.
      assert(wheel.suspension.displacement >= -.139 && wheel.suspension.displacement <= .254);
    }
  }
  assert(high - low < .035 && verticalSpeed < .16, `heave ${high - low}, vertical speed ${verticalSpeed}`);
  assert(w.vehicle.x > 30); assert.equal(w.dynamics.recoveries || 0, 0);
  assert(w.plates.every(p => p.attached && p.integrity === 1));
});

// A roomy authored bench keeps power and payload comparisons independent of changes to a factory cab.
function performanceBox() {
  return vehicleBox({ length: 6, height: 3, thicknessMm: 10, terrain: 'flat', components: [
    { id: 'engine', kind: 'engine', pose: { x: 1, y: 1, angle: 0 } },
    { id: 'fuel', kind: 'fuel', pose: { x: -1, y: .3, angle: 0 } },
  ] });
}

test('additional armour slows acceleration and physical top speed; a stronger engine increases both', t => {
  // Three evenly spaced supports and a real 25 mm frame carry the same hull with four times its armour. In cells: the
  // outer ones 0.8 m in from the ends. The explicit box leaves room to resize its engine without moving equipment.
  const scout = performanceBox(), front = scout.chassis.points[0].x, rear = scout.chassis.points.at(-1).x,
    base = withChassisGearScale(withChassisThickness(scout, 25), 1);
  base.chassis = { ...base.chassis, axles: [front + 16, (front + rear) / 2, rear - 16] };
  const heavy = structuredClone(base), stronger = structuredClone(base);
  for (const plate of heavy.plates) plate.thicknessMm *= 4;
  const bigger = stronger.components.find(m=>m.kind==='engine'); bigger.sizeScale = (bigger.sizeScale ?? 1) * Math.sqrt(2);
  // Each faces -X: the throttle that way drives it ahead.
  const worlds = [base, heavy, stronger].map(b => managed(t, b));
  for (const w of worlds) { advance(w, 90); w.controlVehicle(-1); advance(w, 180); }
  const [a, b, c] = worlds;
  assert(b.vehicle.mass > a.vehicle.mass * 1.6);
  assert(-b.vehicle.vx < -a.vehicle.vx * .75);
  // Both set off held by the grip of the ground, the same for the two; past that, twice the power for the 560 kg the
  // larger engine adds.
  assert(-c.vehicle.vx > -a.vehicle.vx * 1.2);
  assert([a, b, c].every(w => w.vehicle.powertrain.gearedSpeed == null));
  assert(c.vehicle.powertrain.maxSpeed > a.vehicle.powertrain.maxSpeed && b.vehicle.powertrain.maxSpeed < a.vehicle.powertrain.maxSpeed);
  const engine = c.modules.find(m => m.kind === 'engine'); setPart(c, engine, { health: 0 }); advance(c, 2);
  assert.equal(c.vehicle.availablePowerKw, 0); assert(-c.vehicle.vx > 1, 'engine failure retains coasting');
});

test('authored running gear reaches a stable flat-road speed within physical power and resistance budgets', t => {
  const b = performanceBox();
  const w = managed(t, b); advance(w, 120);
  const initialEnergy = physics(w).energyStoredJ.total, measured = measureEquilibrium(w, -1),
    seconds = measured.seconds,
    engineWorkBudget = w.vehicle.powertrain.powerKw * 1000 * w.vehicle.powertrain.efficiency * seconds,
    steadySamples = measured.samples;
  const speed = -w.vehicle.vx, powertrain = w.vehicle.powertrain,
    availablePower = powertrain.powerKw * 1000 * powertrain.efficiency,
    resistancePower = (w.vehicle.mass * 9.81 * w.vehicle.groundResistance + powertrain.drag * speed ** 2) * speed;
  assert(steadySamples.every(Number.isFinite) && speed > 5);
  assert(Math.max(...steadySamples) - Math.min(...steadySamples) < speed * .01,
    'the final two seconds converge within 1%, independently of the estimated transmission ceiling');
  assert.equal(powertrain.gearedSpeed, null, 'the wheels have no speed ceiling');
  assert(Math.abs(speed - powertrain.maxSpeed) < powertrain.maxSpeed * .03, `actual ${speed}, flat-road estimate ${powertrain.maxSpeed}`);
  assert(Number.isFinite(resistancePower) && resistancePower > 0 && resistancePower <= availablePower,
    'rolling resistance and hull drag cannot consume more than the available engine power at equilibrium');
  const finalEnergy = physics(w).energyStoredJ.total;
  assert(Number.isFinite(initialEnergy) && Number.isFinite(finalEnergy) && Number.isFinite(engineWorkBudget));
  assert(finalEnergy - initialEnergy <= engineWorkBudget, 'kinetic and gravitational energy remain within engine work');
  assert(w.vehicle.engine && !w.vehicle.fuelStarved && w.vehicle.traction > 0);
  assert(w.plates.every(p => p.attached && p.integrity === 1));
  assert.equal(w.dynamics.recoveries || 0, 0);
  t.diagnostic(JSON.stringify({ equilibrium: measured.windows, seconds, speed,
    transmissionCeiling: powertrain.gearedSpeed, resistancePower, availablePower,
    energyGrowth: finalEnergy - initialEnergy, engineWorkBudget }));
});

// A vehicle faces -X: the throttle that way drives it ahead, the other way backs it.
const reverseCeiling = powertrain => Math.min(powertrain.gearedSpeed ?? Infinity, REVERSE_SHARE * powertrain.maxSpeed);
for (const template of ['scout', 'heavy']) {
  test(`${template} backs on flat ground at the share of its top speed its reverse gear allows`, t => {
    const blueprint = createConstruction(template); blueprint.terrain = 'flat';
    const forward = managed(t, blueprint), reverse = managed(t, blueprint);
    advance(forward, 60); advance(reverse, 60);
    const first = measureEquilibrium(forward, -1), second = measureEquilibrium(reverse, 1),
      a = first.mean, b = second.mean, top = forward.vehicle.powertrain.maxSpeed;
    assert(Math.abs(a - top) < top * .03, `ahead ${a * 3.6} km/h, top speed ${top * 3.6} km/h`);
    assert(Math.abs(b - REVERSE_SHARE * top) < b * .03, `backing ${b * 3.6} km/h, ahead ${a * 3.6} km/h`);
    assert(Math.abs(forward.vehicle.driveSpeed + (forward.vehicle.powertrain.gearedSpeed ?? forward.vehicle.powertrain.maxSpeed)) < 1e-6 &&
      Math.abs(reverse.vehicle.driveSpeed - reverseCeiling(reverse.vehicle.powertrain)) < 1e-6,
      'the reading gives the forward estimate or track ceiling, and the existing reverse ratio');
    assert.equal(forward.dynamics.recoveries || 0, 0); assert.equal(reverse.dynamics.recoveries || 0, 0);
    t.diagnostic(JSON.stringify({ template, forward: first.windows, reverse: second.windows }));
  });
}

test('selecting reverse while moving brakes through zero without instantly reversing the chassis', t => {
  const blueprint = createConstruction('scout'); blueprint.terrain = 'flat';
  const w = managed(t, blueprint), forward = managed(t, blueprint);
  advance(w, 60); advance(forward, 60); w.controlVehicle(-1); forward.controlVehicle(-1);
  advance(w, 480);
  const speed = -w.vehicle.vx; assert(speed > 10);
  w.controlVehicle(1); advance(w, 1);
  assert(w.vehicle.vx < 0 && -w.vehicle.vx < speed);
  let lowestTransitionSpeed = Math.abs(w.vehicle.vx), crossedZero = false;
  for (let i = 0; i < 1200; i++) {
    advance(w, 1); lowestTransitionSpeed = Math.min(lowestTransitionSpeed, Math.abs(w.vehicle.vx));
    if (w.vehicle.vx >= 0) crossedZero = true;
  }
  assert(crossedZero && lowestTransitionSpeed < .15, 'braking passes through zero before reverse acceleration');
  advance(forward, 480 + 1 + 1200);
  const first = measureEquilibrium(forward, -1), second = measureEquilibrium(w, 1),
    forwardSpeed = first.mean, reverseSpeed = second.mean;
  assert(Math.abs(reverseSpeed - REVERSE_SHARE * forwardSpeed) < reverseSpeed * .04,
    `same authored vehicle: forward ${forwardSpeed * 3.6} km/h, reverse ${reverseSpeed * 3.6} km/h`);
  assert(Math.abs(w.vehicle.driveSpeed - reverseCeiling(w.vehicle.powertrain)) < 1e-6,
    'backing, the running gear turns at the ceiling of the reverse gear; actual equilibrium includes drag and contact losses');
  assert.equal(w.dynamics.recoveries || 0, 0); assert.equal(forward.dynamics.recoveries || 0, 0);
  t.diagnostic(JSON.stringify({ brakeMinimumSpeed: lowestTransitionSpeed,
    forward: first.windows, reverse: second.windows }));
  const engine = w.modules.find(m => m.kind === 'engine'); setPart(w, engine, { health: 0 });
  const coasting = Math.abs(w.vehicle.vx); advance(w, 60);
  assert(!w.vehicle.engine && Math.abs(w.vehicle.vx) < coasting, 'reverse also loses drive when the engine fails');
});

test('fixed fortifications retain one static carrier and constant mass through component damage', t => {
  const b = engineBox(Math.sqrt(2));
  const w = managed(t, b), m = w.modules.find(m => m.kind === 'engine'), installed = ownerState(w, m),
    pose = { x: m.x, y: m.y, angle: m.angle }, contour = contactShape(w);
  assert(Math.abs(m.physicalMass - 1760) < .001);
  assert(installed.body > 0 && !installed.state.dynamic);
  assert.equal(physics(w).bodies, 1);
  strike(w, m, 400, .03); advance(w, 2);
  assert.equal(m.health, 0);
  const failed = ownerState(w, m);
  assert.equal(failed.body, installed.body); assert.equal(failed.state.mass, installed.state.mass);
  assert.deepEqual({ x: m.x, y: m.y, angle: m.angle }, pose);
  assert.deepEqual(w.actor().contactContours, contour);
  assert(Math.abs(m.physicalMass - 1760) < .001);
});

test('rifle and heavy-MG bursts dent a tank gun casing without quickly disabling the mechanism', t => {
  const b = createConstruction('heavy');
  const w = managed(t, b), gun = w.modules.find(m => m.kind === 'weapon');
  const shot = weaponSettings('machinegun', { preset: 'm2hb', platform: 'ground', spread: 0 }),
    receiver = mountedWeaponPolygons(gun)[0], point = receiver.reduce((sum, p) => ({
      x: sum.x + p.x / receiver.length, y: sum.y + p.y / receiver.length }), { x: 0, y: 0 }),
    roof = w.plates.find(p => p.id === gun.weaponMount.hostId.replace(/:[^:]+$/, ':roof'));
  // Actual CCD from above, through a deliberately exposed roof opening.
  w.cutBody(roof, { x: point.x, y: roof.definition.y - .3 }, { x: point.x, y: roof.definition.y + .3 }, .18);
  w.command('configureLauncher', { point: { x: point.x, y: roof.definition.y + 2 } });
  for (let i = 0; i < 20; i++) { w.fire(point, shot, true); advance(w, 8); }
  assert(gun.marks?.length > 0, 'bullets actually reach the receiver');
  assert(gun.health > gun.maxHealth * .92 && !gun.barrelDisabled);
  assert.equal(gun.attached, true);
  const settings = weaponSettings('cannon', { preset: 'rh120', platform: 'vehicle', componentId: gun.id });
  assert(w.fire({ x: 0, y: gun.y }, settings, true), 'the surviving gun remains usable in its actual firing direction');
});
