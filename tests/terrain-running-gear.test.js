import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { World } from '../src/physics.ts';
import { boxBlueprint } from './helpers/perception-scene.js';
import { createConstruction } from '../src/construction-templates.ts';
import { serializeBlueprint, parseBlueprint } from '../src/persistence.ts';
import { componentPolygon, isRunningGear } from '../src/assembly.ts';
import { weaponSettings } from '../src/weapons.ts';
import { firingSolution } from '../src/ballistics.ts';
import { predictImpact } from '../src/impact-preview.ts';
import { reviewDrive } from '../scripts/probes-mobility.ts';
import { wheelPhysics, managedWorld, advance } from './mechanical-queries.js';
import { SharedRoom } from '../server/room.ts';


test('terrain has a flat workshop and its drawn vertices are the exact contact surface', () => {
  const ground = new Terrain('rough');
  for (let x = 0; x <= 16; x += .1) assert.equal(ground.height(x), 0);
  for (const p of ground.points) assert.equal(ground.height(p.x), p.y);
  assert(ground.height(30) > 1.8);
  const hit = ground.raycast({ x: 22, y: 6 }, { x: 22, y: -2 });
  assert(Math.abs(hit.y - ground.height(22)) < 1e-10); assert(hit.nx < 0 && hit.ny > 0);
  assert.equal(ground.raycast({ x: 22, y: hit.y }, { x: 22, y: 6 }), null, 'an outbound shot is not a new impact');
});

for (const ammo of ['ap', 'he']) test(`${ammo}: a fast shot and its preview hit the uphill terrain before a target behind it`, t => {
  const b = createConstruction('empty'); b.terrain = 'hills';
  const w = managedWorld(t, b), config = weaponSettings('cannon', { preset: 'rh120', platform: 'ground', ammo, spread: 0 });
  w.addActor(boxBlueprint({ length: 1, height: 2, rideHeight: .15, thicknessMm: 100 }),
    { id: 'hidden', ownerId: 'target', x: 39 });
  // The bench has an explicit muzzle in front of the workshop hull, 4.25 m before it. Prediction
  // and the actual shot must use this same public launcher configuration.
  const launcher = { x: 15.5, y: 1.5 }, aim = { x: 38, y: .6 };
  w.game().call({ op: 'configureLauncher', point: launcher });
  const solution = firingSolution(launcher, aim, config), predicted = predictImpact(w.snapshot(), solution);
  assert(solution.x < 21, 'the real barrel mouth starts before the uphill face');
  assert.equal(predicted.owner.type, 'ground'); assert(predicted.x > 21 && predicted.x < 24);
  assert(predicted.y > .5); assert(Math.abs(predicted.y - w.terrain.height(predicted.x)) < 1e-8);
  w.fire(aim, config, true); const events = [];
  for (let i = 0; i < 6; i++) { w.step(); events.push(...w.drainEvents()); }
  const impact = events.find(e => e.type === (ammo === 'he' ? 'explosion' : 'ground'));
  assert(impact); assert.equal(w.stats.impacts, 0, 'the hidden plate is shielded by real terrain');
  const offset = ammo === 'he' ? .08 : 0;
  assert(Math.hypot(impact.x - predicted.x - predicted.nx * offset,
    impact.y - predicted.y - predicted.ny * offset) < .02);
  assert(predicted.angleDegrees > 0 && predicted.angleDegrees < 90);
});

test('the admitted rigid contact contours settle on a hill rather than the zero-height plane', t => {
  const b = createConstruction('scout'); b.terrain = 'hills';
  const w = managedWorld(t, b); w.command('setVehicleState', { state: { x: 30, y: 6, vx: 0, vy: 0 } });
  advance(w, 240);
  const v = w.vehicle, c = Math.cos(v.angle), s = Math.sin(v.angle);
  assert(v.y > 1.8 && Math.abs(v.vy) < .02);
  const contours = w.actor().contactContours;
  assert(contours.length > 0, 'the carrier has admitted body contact shapes');
  for (const contour of contours) for (const p of contour) {
    const x = v.x + c * p.x - s * p.y, y = v.y + s * p.x + c * p.y;
    assert(y >= w.terrain.height(x) - .01);
  }
  assert.equal(w.dynamics.recoveries, 0);
});

test('a terrain crest blocks the direct explosion pulse while the exposed side remains reachable', t => {
  const b = createConstruction('empty'); b.terrain = 'hills'; const w = managedWorld(t, b);
  // One charge at the foot of the hill and a low wall on either side of the crest: every line
  // from the charge to the far wall runs through the ground. Then the far wall with no hill between.
  const wall = () => boxBlueprint({ length: 1, height: 1, rideHeight: .15, thicknessMm: 100 }),
    marks = (world, id) => world.plates.filter(p => p.actorId === id).reduce((sum, p) => sum + p.marks.length, 0);
  w.addActor(wall(), { id: 'far', ownerId: 'target', x: 38 }); w.addActor(wall(), { id: 'near', ownerId: 'target', x: 25 });
  w.explode(22, 1, 410, 20);
  assert.equal(marks(w, 'far'), 0); assert(marks(w, 'near') > 0);
  const flat = managedWorld(t, createConstruction('empty'));
  flat.addActor(wall(), { id: 'far', ownerId: 'target', x: 38 }); flat.explode(22, 1, 410, 20);
  assert(marks(flat, 'far') > 0);
});

for (const template of ['heavy', 'scout']) for (const terrain of ['hills', 'rough']) for (const direction of [1, -1])
  test(`${template} on ${terrain}, ${direction}: climbs and descends without tunnelling or geometry damage`, () => {
    const row = reviewDrive({ template, terrain, direction, seconds: direction > 0 ? 9 : 15 });
    assert(direction > 0 ? row.end.x > 43 : row.end.x < -30);
    const ground = new Terrain(terrain), positions = [row.start.x, row.end.x, ...row.samples.map(s => s.x)],
      minX = Math.min(...positions), maxX = Math.max(...positions), grades = [];
    for (let i = 1; i < ground.points.length; i++) {
      const a = ground.points[i - 1], b = ground.points[i];
      if (b.x >= minX && a.x <= maxX) grades.push(Math.atan2(Math.abs(b.y - a.y), b.x - a.x));
    }
    assert(grades.length > 0 && Math.max(...grades) > .15, 'the driven route includes a real incline');
    // A short rocky ramp may pitch the carrier beyond the old .5-radian
    // ceiling. Stability means remaining upright and on the upper side of
    // the actual contact tangent, not matching an old chassis geometry.
    assert(row.peaks.angle > .15 && row.peaks.angle < Math.PI / 2,
      `pitch ${row.peaks.angle}; steepest traversed segment ${Math.max(...grades)}`);
    assert(row.samples.every(s => Number.isFinite(s.angle) && Number.isFinite(s.groundSlope) &&
      Math.abs(s.angle - s.groundSlope) < Math.PI / 2), 'carrier remains upright relative to contact normals');
    assert(row.samples.some(s => Math.abs(s.groundSlope) > 0), 'traction samples the actual incline');
    assert(Number.isFinite(row.peaks.speed) && row.peaks.speed < 50);
    assert(Number.isFinite(row.peaks.kineticJ) && row.peaks.kineticJ < 1e10);
    // The engine no longer holds a vehicle back at the ceiling of its running
    // gear, so crests are taken faster and a landing sinks a little deeper for one step.
    // On soil the gear rides the bumps of the ground (game_terrain.rs `Bumps`),
    // as deep as 3.5 cm under the line it is drawn by in a trough.
    assert(row.peaks.groundPenetration < .025 + .035);
    assert(row.retained.every(n => n > .999)); assert(row.originalUnchanged && row.restored);
    assert.equal(row.recoveries, 0, 'ordinary driving must not rely on the instability fallback');
  });

for (const template of ['heavy', 'scout']) test(`${template}: braking on a slope stops the vehicle; loss of engine preserves coasting`, () => {
  const brake = reviewDrive({ template, action: 'brake', seconds: 8 }),
    engine = reviewDrive({ template, action: 'engine', seconds: 8 }),
    gear = reviewDrive({ template, action: 'gear', seconds: 8 });
  assert(Math.abs(brake.end.vx) < .04 && Math.abs(brake.end.vy) < .04);
  assert(engine.end.x > engine.actionX + 1 && !engine.end.engine);
  assert.equal(gear.end.traction, 0); assert(gear.retained.every(n => n > .999));
});

test('logical wheel rotation follows carrier travel on the ground and runs down of itself in the air', t => {
  const b = createConstruction('scout'); b.terrain = 'hills'; const w = managedWorld(t, b);
  advance(w, 30); w.controlVehicle(1); advance(w, 180);
  const wheels = w.modules.filter(m => m.kind === 'wheel');
  assert(wheels.every(wheel => Math.abs(wheel.wheelSpin) > 5));
  assert(wheels.some(wheel => wheel.groundContact && Math.abs(wheel.wheelAngularSpeed) > 2),
    'at least one supporting wheel follows meaningful travel; the leading axle may be airborne over a crest');
  for (const wheel of wheels) {
    const velocity = w.vehicle.velocityAt(wheel), radius = wheel.height / 2,
      longitudinal = velocity.x * Math.cos(w.vehicle.angle) + velocity.y * Math.sin(w.vehicle.angle);
    if (wheel.groundContact) assert(Math.abs(wheel.wheelAngularSpeed + longitudinal / radius) < 1e-8,
      'spin uses the admitted wheel radius and rigid carrier velocity during ground contact');
    else assert(Number.isFinite(wheel.wheelAngularSpeed), 'a wheel over a crest turns with what speed it left the ground with');
    assert.equal(wheelPhysics(w, wheel).bodies.length, 1);
  }
  // Lifted off the ground with no speed of its own, the vehicle has its wheels still turning: they slow down, and stop.
  const rolling = new Map(wheels.map(wheel => [wheel.id, { speed: wheel.wheelAngularSpeed, spin: wheel.wheelSpin }]));
  assert([...rolling.values()].some(was => Math.abs(was.speed) > 2));
  w.command('setVehicleState', { state: { y: 3000, vx: 0, vy: 0 } }); advance(w, 1);
  const lifted = w.modules.filter(m => m.kind === 'wheel');
  for (const wheel of lifted) {
    const was = rolling.get(wheel.id); assert(!wheel.groundContact);
    assert(Math.abs(wheel.wheelAngularSpeed) <= Math.abs(was.speed) && wheel.wheelAngularSpeed * was.speed >= 0, 'it does not turn faster, nor back');
    if (Math.abs(was.speed) > 2) {
      assert(Math.abs(wheel.wheelAngularSpeed) > Math.abs(was.speed) * .9, 'a wheel in the air does not stand still at once');
      assert(Math.abs(wheel.wheelSpin - was.spin - was.speed / 60) < 1e-9, 'and has turned on by the speed it had');
    }
  }
  advance(w, 60);
  for (const wheel of w.modules.filter(m => m.kind === 'wheel')) {
    const was = rolling.get(wheel.id);
    if (Math.abs(was.speed) > 2) assert(Math.abs(wheel.wheelAngularSpeed) < Math.abs(was.speed) * .6 && Math.abs(wheel.wheelAngularSpeed) > Math.abs(was.speed) * .4,
      'after a second it has about half its speed left');
  }
  // A brake stops them where they are; left alone they come to rest too.
  w.controlVehicle(0, 1); advance(w, 30);
  assert(w.modules.filter(m => m.kind === 'wheel').every(wheel => wheel.wheelAngularSpeed === 0));
  const rest = w.modules.filter(m => m.kind === 'wheel').map(wheel => wheel.wheelSpin); advance(w, 30);
  assert.deepEqual(w.modules.filter(m => m.kind === 'wheel').map(wheel => wheel.wheelSpin), rest);
});

test('suspended running gear cannot accelerate the chassis without ground contact', t => {
  const b = createConstruction('scout'); b.terrain = 'hills';
  const powered = managedWorld(t, b), passive = managedWorld(t, b);
  for (const w of [powered, passive]) w.command('setVehicleState', { state: { y: w.vehicle.y + 3 } });
  powered.controlVehicle(1);
  advance(powered, 30); advance(passive, 30);
  assert.equal(powered.vehicle.traction, 0); assert.equal(powered.vehicle.vx, passive.vehicle.vx);
});

test('terrain survives JSON restoration; multiplayer spawns start above the shared ground', t => {
  const b = createConstruction('scout'); b.terrain = 'rough';
  assert.equal(parseBlueprint(serializeBlueprint(b)).terrain, 'rough');
  const missing = parseBlueprint(JSON.stringify({ ...b, terrain: 'missing' }));
  assert.throws(() => new World(missing), /Terreno/);
  const room = new SharedRoom({ starter: false, base: () => x }); t.after(() => room.world.dispose());
  assert.equal(room.world.snapshot().terrain, 'world');
  // A hillside of the world near its middle: the construction is set down above it and leans with it.
  const ground = room.world.terrain, steep = x => [-4, 0, 4].every(dx => Math.abs(ground.surface(x + dx).slope) > .1),
    x = Array.from({ length: 2400 }, (_, i) => i - 1200).find(steep);
  const player = room.join('Ensaio'), result = room.publish(player.playerId, b, { x });
  const actor = room.world.actor(result.actor.id), gears = room.world.modules.filter(m => m.actorId === actor.id && isRunningGear(m));
  assert(actor.vehicle.y > ground.height(x));
  assert(gears.flatMap(componentPolygon).every(p => p.y >= ground.height(p.x) - .005));
  advance(room.world, 90); assert(Number.isFinite(actor.vehicle.y + actor.vehicle.angle));
  assert(actor.vehicle.y > ground.height(actor.vehicle.x) && actor.vehicle.y < ground.height(actor.vehicle.x) + 3 && Math.abs(actor.vehicle.angle) > .05);
});
