import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { referenceScenario } from '../src/scenarios.ts';
import { weaponSettings } from '../src/weapons.ts';
import { physics, setPart, flyRound, managedWorld, advance } from './mechanical-queries.js';
import { decodeNativeFrame, parseNativeJSON } from '../src/native-frame-contract.ts';
import { VEHICLE_STATE } from '../src/native-vehicle.ts';


test('the compiled world advances motion, damage, explosions and perception without JS mechanical callbacks', t => {
  const world = managedWorld(t, createConstruction('heavy'));
  world.game();
  const forbidden = () => { throw new Error('A simulation substep called the JavaScript reference engine'); };
  for (const key of ['step', 'fragmentImpulse', 'sync']) world.dynamics[key] = forbidden;
  world.vehicle.drive = forbidden; world.vehicle.impulse = forbidden;
  for (const key of ['rebuild', 'raycast', 'rayIntervals']) world.index[key] = forbidden;
  const start = world.vehicle.x, engine = world.modules.find(m => m.kind === 'engine');
  world.controlVehicle(.8); advance(world, 60);
  assert(world.vehicle.x > start + .1);
  const before = engine.health;
  world.explode(engine.x, engine.y, 160, 1.5); advance(world, 20);
  assert.equal(world.stats.explosions, 1);
  assert(engine.health < before);
  assert(world.events.some(e => e.type === 'explosion'));
  const vision = world.game().call({ op: 'teamSight' });
  assert(vision && typeof vision === 'object');
  assert.equal(world.dynamics.recoveries, 0);
});

test('cold roster changes preserve projectiles, damaged material, RNG, fixed mass and contact contours', t => {
  const design = createConstruction('bunker');
  const uninterrupted = managedWorld(t, design), edited = managedWorld(t, design);
  for (const world of [uninterrupted, edited]) {
    world.projectiles.push({ id: 'pending-round', age: 0, x: -100, y: 100,
      vx: 20, vy: 0, power: 10, mass: 1, caliberMm: 20, radius: .01 });
    world.explode(11.5, 1.65, 140, 1.1); advance(world, 2);
  }
  const random = edited.random.state, stats = structuredClone(edited.stats),
    material = edited.plates.map(p => structuredClone({ grid: p.ballisticGrid, marks: p.marks, dents: [...p.dents.values()] })),
    projectiles = structuredClone(edited.projectiles), contours = structuredClone(edited.actor().contactContours),
    properties = physics(edited).bodyStates.map(b => [b.mass, b.inertia]);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  edited.addActor(createConstruction('empty'), { id: 'visitor', ownerId: 'visitor', x: 30 });
  edited.command('teamSight');
  assert.equal(edited.random.state, random); assert.deepEqual(edited.stats, stats);
  assert.deepEqual(edited.projectiles, projectiles);
  assert.deepEqual(edited.actor().contactContours, contours);
  assert.deepEqual(physics(edited).bodyStates.filter(b => b.actor === edited.game().actorHandles.get('local')).map(b => [b.mass, b.inertia]), properties);
  assert.deepEqual(edited.plates.filter(p => p.actorId === 'local').map(p => ({ grid: p.ballisticGrid, marks: p.marks, dents: [...p.dents.values()] })), material);
  edited.removeActor('visitor');
  advance(uninterrupted, 12); advance(edited, 12);
  assert.deepEqual(edited.stats, uninterrupted.stats); assert.equal(edited.random.state, uninterrupted.random.state);
  assert.deepEqual(edited.projectiles, uninterrupted.projectiles);
  for (const [i, p] of edited.plates.entries()) {
    assert.equal(p.remainingArea, uninterrupted.plates[i].remainingArea);
    assert.deepEqual(p.ballisticGrid, uninterrupted.plates[i].ballisticGrid);
    assert.deepEqual(p.marks, uninterrupted.plates[i].marks);
  }
});

test('a roster edit retains an active trigger and never restores consumed resources or disabled components', t => {
  const world = managedWorld(t, createConstruction('recon')), engine = world.modules.find(m => m.kind === 'engine'),
    box = world.modules.find(m => m.kind === 'ammo'), fuel = world.modules.find(m => m.kind === 'fuel');
  setPart(world, box, { rounds: 3 }); setPart(world, fuel, { fuelLitres: 2 }); setPart(world, engine, { health: 0 });
  world.setTrigger(true, { x: 5, y: 2 }, weaponSettings('machinegun', { preset: 'fnmag', spread: 0 }));
  advance(world, 1);
  const shots = world.stats.shots, trigger = structuredClone(world.trigger);
  assert(shots > 0);
  world.addActor(createConstruction('empty'), { id: 'visitor', ownerId: 'visitor', x: 30 });
  advance(world, 12);
  assert(world.stats.shots > shots); assert.deepEqual(world.trigger, trigger);
  assert.equal(engine.health, 0); assert.equal(box.rounds, 3); assert.equal(fuel.fuelLitres, 2);
  assert.equal(world.vehicle.availablePowerKw, 0);
});

test('marks-only native frames retain perforated material, dents and current rigid poses across a roster edit', t => {
  const world = managedWorld(t, createConstruction('heavy')), game = world.game(),
    // The thickest plate, the longest of those: it is cut a third of its length behind its middle, and struck as far before it.
    plate = world.plates.reduce((a, b) => b.definition.thicknessMm > a.definition.thicknessMm ||
      b.definition.thicknessMm === a.definition.thicknessMm && b.definition.length > a.definition.length ? b : a), along = plate.definition.length / 3,
    owner = game.handle(plate), frames = [], accept = game.accept.bind(game);
  game.accept = frame => { if (frame) frames.push(frame); accept(frame); };
  world.controlVehicle(0, 1);
  const c = plate.frame.c, s = plate.frame.s, thickness = plate.definition.thicknessMm / 1000,
    local = (x, y) => ({ x: plate.frame.x + c * x - s * y, y: plate.frame.y + s * x + c * y });
  game.call({ op: 'cut', owner, start: local(-along, thickness), end: local(-along, -thickness), radius: .008 });
  assert(plate.remainingArea < plate.originalArea);
  const regions = structuredClone(plate.solidRegions), area = plate.remainingArea,
    point = local(along, thickness / 2), direction = { x: s, y: -c };
  // A round that the plate stops, flown from two centimetres above it and strong enough to dent the metal.
  flyRound(world, { x: point.x - .02 * direction.x, y: point.y - .02 * direction.y, vx: 600 * direction.x, vy: 600 * direction.y,
    power: 150, mass: .2, caliberMm: 25, radius: .005, ammo: 'ap' }, .0001);
  assert.equal(world.stats.impacts, 1); assert.equal(world.stats.penetrations, 0);
  const delta = frames.at(-1).plates.find(p => p.owner === owner).damage;
  assert.equal(delta.solidRegions, undefined, 'a surface-only impact does not resend the already projected aperture');
  assert(delta.marks.length > 0); assert(delta.dents.length > 0);
  assert.equal(delta.wear, undefined);
  assert.deepEqual(plate.solidRegions, regions); assert.equal(plate.remainingArea, area);
  const material = () => ({ regions: plate.solidRegions, area: plate.remainingArea, spans: plate.solidSpans(),
    marks: plate.marks, dents: [...plate.dents.values()] }),
    retained = structuredClone(material());
  world.controlVehicle(.7); advance(world, 12);
  assert.deepEqual(material(), retained);
  assert.equal(frames.at(-1).plates.find(p => p.owner === owner), undefined,
    'unchanged marks and damage history are absent from subsequent presentation packets');
  const moved = world.snapshot().plates.find(p => p.id === plate.id),
    // A live frame tells the pose in its numbers; the cold frame of the core, in words.
    nativePose = JSON.parse(game.core.current_frame()).plates.find(p => p.owner === owner).pose;
  // Native and presentation transform the same rigid pose. Evaluating its
  // sine/cosine in the two hosts can differ by a few double-precision ULPs.
  const samePose = (definition, pose) => {
    for (const key of ['x', 'y', 'angle']) {
      assert(Number.isFinite(definition[key]) && Number.isFinite(pose[key]));
      const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(definition[key]), Math.abs(pose[key]));
      assert(Math.abs(definition[key] - pose[key]) <= tolerance, 'rigid pose ' + key);
    }
  };
  samePose(moved.definition, nativePose);
  const location = structuredClone(nativePose);
  world.addActor(createConstruction('empty'), { id: 'visitor', ownerId: 'visitor', x: 30 });
  world.controlVehicle(0, 1); // Cold admission projects the same current pose without taking a physics step.
  assert.deepEqual(material(), retained);
  samePose(plate.definition, location);
  world.removeActor('visitor'); world.controlVehicle(0, 1);
  assert.deepEqual(material(), retained);
  const snapshot = world.snapshot().plates.find(p => p.id === plate.id);
  assert.deepEqual(snapshot.solidRegions, retained.regions); assert.deepEqual(snapshot.marks, retained.marks);
  assert.equal(world.dynamics.recoveries, 0);
});

test('the numbers of live frames leave the scene as the cold frame of the core tells it', t => {
  const world = managedWorld(t, createConstruction('heavy')), game = world.game();
  world.controlVehicle(.8); advance(world, 45);
  assert(Math.abs(world.vehicle.vx) > .1, 'it drives');
  game.sync();
  const cold = decodeNativeFrame(parseNativeJSON(game.core.current_frame()));
  for (const state of cold.actors) {
    const a = world.actor(state.id);
    assert.deepEqual({ cooldown: a.cooldown, aim: a.aim, stats: a.stats, eyes: a.eyes },
      { cooldown: state.cooldown, aim: state.aim, stats: state.stats, eyes: state.eyes }, state.id);
    if (!state.vehicle) continue;
    for (const key of VEHICLE_STATE) assert.deepEqual(a.vehicle[key], state.vehicle[key], `vehicle ${key}`);
    assert.equal(a.vehicle.mass, state.vehicle.massTonnes * 1000); assert.equal(a.vehicle.config.enabled, state.vehicle.enabled);
    assert.deepEqual(a.vehicle.drivetrain, state.vehicle.drivetrain);
  }
  for (const state of cold.plates) {
    const { x, y, angle } = game.objects.get(state.owner).definition;
    assert.deepEqual({ x, y, angle }, state.pose);
  }
  const told = ['x', 'y', 'angle', 'health', 'physicalMass', 'physicalInertia', 'burnAge', 'fireAge', 'groundMarks', 'groundDamage',
    'aimOffset', 'fuelLitres', 'rounds', 'thrust', 'targetAimOffset', 'servoVelocity', 'targetBarrelAngle', 'reload', 'barrelTemperature', 'loaded', 'feedReload', 'groundContact',
    'wheelSpin', 'wheelAngularSpeed'];
  let touching = 0;
  for (const state of cold.modules) {
    const m = game.objects.get(state.owner);
    for (const key of told) if (state[key] !== undefined) assert.deepEqual(m[key], state[key], `${m.id} ${key}`);
    if (m.kind === 'weapon') assert.equal(m.barrelAngle, state.barrelAngle, `${m.id} barrelAngle`);
    if (state.suspension) for (const key of ['travel', 'displacement', 'tilt', 'compression'])
      assert.equal(m.suspension[key], state.suspension[key], `${m.id} suspension ${key}`);
    if (state.groundContact) touching++;
  }
  assert(touching > 0, 'its wheels stand on the ground');
});
