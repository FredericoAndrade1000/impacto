import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainSpeed, groundBraking, groundSpeed, travelSeconds, climbed, BRAKING } from '../src/terrain-speed.ts';
import { Terrain } from '../src/terrain.ts';
import { NO_ROADS, paved } from '../src/roads.ts';
import { Squad } from '../src/squad.ts';

// Paved ground: nothing of it shakes a vehicle, and only its shape slows one.
const ground = height => ({ minX: -300000, maxX: 300000, height, groundAt: () => 'asphalt' }),
  crest = x => 2 - Math.max(-20, Math.min(20, x - 100)) ** 2 * .005;

test('straight ground and a constant slope only hold a vehicle to stopping by the end of the way it plans, either way', () => {
  const steep = Math.tan(20 * Math.PI / 180);
  for (const grade of [0, .1, -.1, steep]) for (const direction of [1, -1]) {
    const plan = terrainSpeed(ground(x => x * grade), 0, direction * 1000, { speed: 50 }), along = grade * direction,
      brake = BRAKING + 9.81 * Math.min(0, along / Math.hypot(1, along));
    assert(Math.abs(plan.speed2 - 2 * brake * plan.range) < 1e-6, 'its brakes, less what the slope takes off them, over the way it plans');
    if (along > -steep) assert(plan.speed2 > 50 ** 2, 'on level ground, up a slope and down an ordinary one it keeps its full speed');
    else assert(plan.range > 0 && plan.speed2 < 50 ** 2, 'down a steep one it goes no faster than it stops from by then');
  }
});

test('a crest is anticipated within braking distance and a broad bend allows a higher speed', () => {
  const road = ground(crest), early = terrainSpeed(road, 0, 1000, { speed: 50 }),
    near = terrainSpeed(road, 70, 1000, { speed: 50 }), over = terrainSpeed(road, 100, 1000, { speed: 50 });
  assert(Number.isFinite(early.speed2) && early.speed2 < 50 ** 2, 'braking begins before the crest');
  assert(early.speed2 > near.speed2 && near.speed2 > over.speed2, 'the envelope approaches the local crest speed');
  assert(terrainSpeed(ground(x => crest(x) / 4), 100, 1000, { speed: 50 }).speed2 > over.speed2 * 2);
  assert(terrainSpeed(road, 100, 0, { speed: 50 }).speed2 < 50 ** 2, 'reverse travel sees the same real crest');
});

test('loaded top-heavy geometry and weak ground leave more braking and support margin', () => {
  const high = terrainSpeed(ground(crest), 100, 1000, { speed: 50, length: 4, height: 4 }),
    low = terrainSpeed(ground(crest), 100, 1000, { speed: 50, length: 4, height: 1 });
  assert(high.speed2 < low.speed2);
  const sand = { ...ground(crest), groundAt: () => 'sand' }, firm = terrainSpeed(ground(crest), 0, 1000, { speed: 50 }),
    soft = terrainSpeed(sand, 0, 1000, { speed: 50, pressure: 300 });
  assert(soft.speed2 < firm.speed2, 'native pressure/soft-ground grip need an earlier approach');
  const descent = { ...ground(x => -.4 * x - Math.max(0, x - 90) ** 2 * .005), groundAt: () => 'mud' };
  assert.equal(terrainSpeed(descent, 0, 1000, { speed: 50, pressure: 1000 }).speed2, 0,
    'a slippery descent which overcomes the brakes gets no invented minimum braking credit');
  const straightDescent = { ...ground(x => -.4 * x), groundAt: () => 'mud' };
  assert.equal(terrainSpeed(straightDescent, 0, 1000, { speed: 10, pressure: 1000 }).speed2, 0,
    'nothing erases a real downhill braking deficit');
});

test('the forecast never reads hidden terrain and approaches the frontier without cancelling the trip', () => {
  let reads = 0;
  const known = x => x <= 48, road = { ...ground(x => { assert(known(x)); reads++; return 0; }),
    groundAt: x => { assert(known(x)); return 'asphalt'; } }, plan = terrainSpeed(road, 0, 1000, { speed: 50, known });
  assert(reads > 0); assert(plan.speed2 > 0 && plan.speed2 < 50 ** 2);
  assert(plan.range <= 48);
  assert.equal(terrainSpeed(road, 60, 1000, { speed: 50, known }).range, 0);
});

test('the braking corridor has a fixed query budget even on a very long, fast trip, and stops by its end', () => {
  let reads = 0;
  const plan = terrainSpeed(ground(() => { reads++; return 0; }), -250000, 250000, { speed: 200 });
  assert(plan.range <= 512); assert(reads <= 387);
  assert(Math.abs(plan.speed2 - 2 * BRAKING * plan.range) < 1e-6 && plan.ahead === plan.range);
});

function pilot(height = crest, known = () => true) {
  let reads = 0;
  const vehicle = { x: 0, y: 1, angle: 0, vx: 50, vy: 0, mass: 10000, localCenter: { x: 0, y: .5 }, groundPressureKPa: 100, groundGrip: .8,
    config: { enabled: true }, drivetrain: { powerKw: 240, maxDriveForce: 60000, efficiency: .82, rollingCoefficient: .018, maxSpeed: 60 } },
    actor = { id: 'a', facing: 1, revision: 0, vehicle }, parts = [-3, 3].map(x =>
      ({ id: 'wheel' + x, actorId: 'a', kind: 'wheel', x, y: .5, width: 1, height: 1, health: 100, maxHealth: 100, groundContact: { y: 0 } })),
    terrain = ground(x => { assert(known(x), 'the pilot may not query hidden ground'); reads++; return height(x); }),
    world = { time: 0, terrain, modules: parts, plates: [], actor: () => actor },
    side = { world, roster: [{ id: 'a', team: 'local' }], defeats: {}, faction: { explored: [[-100, 1000]] }, knowsGround: known, input() {} },
    squad = new Squad(side), unit = squad.units.get('a');
  unit.move = { x: 1000, best: 1000, since: 0, turning: false };
  return { actor, vehicle, world, side, parts, squad, unit, reads: () => reads };
}

test('only the automatic pilot brakes for a known crest, preserving the order and normal arrival', () => {
  const f = pilot();
  assert.deepEqual(f.squad.drive('a', f.unit), { throttle: 0, brake: 1 }); assert(f.unit.move);
  const flat = pilot(() => 0); assert.equal(flat.squad.drive('a', flat.unit).brake, 0);
  f.vehicle.x = f.unit.move.x - 1; f.vehicle.vx = 0;
  assert.equal(f.squad.drive('a', f.unit).brake, 1); assert.equal(f.unit.move, null, 'ordinary arrival remains 1.5 m');
  f.squad.sample = () => {}; f.squad.manual = 'a';
  const count = f.reads(); assert.equal(f.squad.decide(f.side.roster[0]), null); assert.equal(f.reads(), count, 'human controls do not forecast');
});

test('cached terrain plans expire with progress, knowledge, body changes and live load', () => {
  const f = pilot(() => 0); f.squad.safeSpeed('a', f.unit.move); let count = f.reads();
  for (let i = 0; i < 10; i++) f.squad.safeSpeed('a', f.unit.move); assert.equal(f.reads(), count);
  f.squad.command({ order: 'stop', ids: ['a'] }); f.squad.sync(); assert.equal(f.unit.move, null);
  f.unit.move = f.squad.leg('a', 1000); f.squad.safeSpeed('a', f.unit.move);
  assert(f.reads() > count, 'a new leg to the same destination needs its own corridor'); count = f.reads();
  f.world.time = .3; f.squad.safeSpeed('a', f.unit.move); assert(f.reads() > count); count = f.reads();
  f.side.faction.explored = [[-100, 2000]]; f.squad.safeSpeed('a', f.unit.move); assert(f.reads() > count); count = f.reads();
  f.vehicle.mass *= 1.1; f.squad.safeSpeed('a', f.unit.move); assert(f.reads() > count); count = f.reads();
  f.actor.revision++; f.squad.safeSpeed('a', f.unit.move); assert(f.reads() > count); count = f.reads();
  f.parts[0].health = 0; f.squad.safeSpeed('a', f.unit.move); assert(f.reads() > count);
});

test('no ground holds a cached plan to a cruising ceiling: it stops by the end of its way on the brakes the ground holds', () => {
  for (const surface of ['soil', 'rock', 'gravel', 'sand', 'mud', 'graded']) for (const heading of [1, -1]) {
    const f = pilot(() => 0);
    f.world.terrain.groundAt = () => surface;
    f.vehicle.vx = heading * 50 / 3.6; f.unit.move.x = heading * 1000;
    const before = f.squad.safeSpeed('a', f.unit.move), reads = f.reads(), plan = f.unit.terrainPlan.plan,
      braking = groundBraking(surface, false, f.vehicle.groundPressureKPa);
    assert(Math.abs(before ** 2 - 2 * braking * plan.range) < 1e-6 && before > 50 / 3.6, `${surface}, heading ${heading}: ${before}`);
    f.vehicle.x = heading * 1.5; f.world.time = .1;
    const after = f.squad.safeSpeed('a', f.unit.move);
    assert(Math.abs(after ** 2 - (before ** 2 - 2 * BRAKING * 1.5)) < 1e-6, 'the way gone spends the braking counted on for it');
    assert.equal(f.reads(), reads, 'crossing the same ground reuses the corridor');
  }
});

test('cached softer ground, a crest and the frontier still spend their real approaching braking distance', () => {
  const softer = pilot(() => 0), crestRoute = pilot(), frontier = pilot(() => 0, x => x <= 48);
  softer.world.terrain.groundAt = x => x < 80 ? 'asphalt' : 'mud'; softer.vehicle.vx = 20;
  for (const f of [softer, crestRoute, frontier]) {
    const before = f.squad.safeSpeed('a', f.unit.move), reads = f.reads();
    f.vehicle.x = 1.5; f.world.time = .1;
    const after = f.squad.safeSpeed('a', f.unit.move);
    assert(Number.isFinite(before) && after < before, 'a real spatial constraint still tightens while approaching it');
    assert(Math.abs(after ** 2 - (before ** 2 - 2 * BRAKING * 1.5)) < 1e-9, 'the same approach budget the plan counted on');
    assert.equal(f.reads(), reads, 'this is the cached approach, before a new forecast');
  }
  const plan = softer.unit.terrainPlan.plan;
  assert(plan.speed2 < 2 * BRAKING * plan.range, 'mud on the way it plans to stop on holds the brakes back');
});

test('ordinary downhill trips hold the speed they are allowed with proportional braking through a small overspeed, in either direction', () => {
  for (const heading of [1, -1]) {
    const f = pilot(x => -heading * .1 * x), target = 50 / 3.6;
    f.world.terrain.groundAt = () => 'soil'; f.actor.facing = heading; f.unit.move.x = heading * 1000; f.squad.safeSpeed = () => target;
    Object.assign(f.vehicle, { vx: heading * (target - .02), groundSlope: -heading * Math.atan(.1), groundResistance: .018 });
    const action = f.squad.drive('a', f.unit);
    assert.equal(action.throttle, 0, 'gravity already supplies more pull than rolling takes');
    assert(action.brake > 0 && action.brake < .5, 'it holds the descent on part of its brakes, without first accelerating past the ceiling');
    f.vehicle.vx = heading * (target + .1);
    const overspeed = f.squad.drive('a', f.unit);
    assert.equal(overspeed.throttle, 0);
    assert(overspeed.brake > action.brake && overspeed.brake < 1, 'a small excess is braked harder, without jumping to all its brakes');
    assert(f.unit.move, 'holding the ceiling keeps the original trip');
  }
});

test('ordinary acceleration uses the available drivetrain instead of a working machine surge limit', () => {
  const f = pilot(() => 0);
  f.world.terrain.groundAt = () => 'soil'; Object.assign(f.vehicle, { vx: 3, groundResistance: .018 });
  assert.deepEqual(f.squad.drive('a', f.unit), { throttle: 1, brake: 0 });
});

test('an automatic tow takes up slack gently without turning and remains an ordinary finite trip', () => {
  const f = pilot(() => 0); f.vehicle.vx = 0; f.actor.facing = -1;
  const tow = { actorId: 'a', targetId: 'load', tension: 0, anchorA: { x: -1 }, anchorB: { x: 1 } };
  f.world.tows = [tow];
  f.side.turnAbout = () => { throw new Error('A linked chassis must not request a timed turn'); };
  f.unit.move.lean = { down: true, since: -10, top: 0, speed: 0, at: 0 };
  const first = f.squad.drive('a', f.unit);
  assert(first.throttle > 0 && first.throttle < 1); assert.equal(first.brake, 0);
  assert.equal(f.unit.move.lean, null, 'an old obstruction burst cannot carry into the tow');
  assert.equal(f.unit.move.pace, undefined, 'the tow does not become an endless road-work leg');
  f.vehicle.vx = 2.5; f.world.time = .1;
  const overspeed = f.squad.drive('a', f.unit);
  assert.equal(overspeed.throttle, 0); assert(overspeed.brake > 0 && overspeed.brake < 1);
  f.squad.safeSpeed = () => 0;
  assert.deepEqual(f.squad.drive('a', f.unit), { throttle: 0, brake: 1 }, 'a closed safe-speed envelope never allows a towing creep or burst');
  assert(f.unit.move); f.squad.safeSpeed = () => Infinity;
  f.world.tows = []; f.vehicle.vx = 3; f.actor.facing = 1;
  assert.deepEqual(f.squad.drive('a', f.unit), { throttle: 1, brake: 0 }, 'detaching restores ordinary acceleration');
  f.world.tows = [tow];
  f.vehicle.x = f.unit.move.x - 1; f.vehicle.vx = 0;
  assert.deepEqual(f.squad.drive('a', f.unit), { throttle: 0, brake: 1 }); assert.equal(f.unit.move, null);
});

test('the endpoint envelope asks for proportional deceleration before its limit and still stops the order at arrival', () => {
  const f = pilot(() => 0);
  Object.assign(f.unit.move, { x: 10, best: 10 }); Object.assign(f.vehicle, { vx: 8.5, groundResistance: .018 });
  const action = f.squad.drive('a', f.unit);
  assert.equal(action.throttle, 0); assert(action.brake > 0 && action.brake < 1, 'the planned stop is fed forward before overspeed, without throttle between brake touches');
  f.vehicle.vx = 8.7;
  const overspeed = f.squad.drive('a', f.unit);
  assert.equal(overspeed.throttle, 0); assert(overspeed.brake > action.brake && overspeed.brake < 1, 'the same stopping budget increases braking proportionally for a small excess');
  f.vehicle.vx = 12;
  assert.deepEqual(f.squad.drive('a', f.unit), { throttle: 0, brake: 1 }, 'a large stopping-envelope violation still saturates the brakes');
  f.vehicle.x = 9; f.vehicle.vx = 0;
  assert.deepEqual(f.squad.drive('a', f.unit), { throttle: 0, brake: 1 }); assert.equal(f.unit.move, null);
});

test('the pilot slows for the unexplored frontier while keeping the same travel order', () => {
  const f = pilot(() => 0, x => x <= 48);
  const action = f.squad.drive('a', f.unit); assert.equal(action.brake, 1); assert(f.unit.move);
});

test('two ten-metre haulers can use a fourteen-metre pickup interval with precise arrival', () => {
  const f = pilot(() => 0), other = { id: 'b', facing: 1, vehicle: { x: -100 } }, actors = new Map([['a', f.actor], ['b', other]]);
  f.world.actor = id => actors.get(id); f.side.roster.push({ id: 'b', team: 'local' }); f.squad.sync(); f.squad.room = () => 10;
  f.side.depot = () => ({ x: -100, radius: 10 }); f.side.load = () => ({ carried: 0, room: 2000 });
  f.side.deposit = () => ({ x: 0, material: 'ferro', left: 0, area: { lo: -7, hi: 7, goal: 0, ready: false } });
  f.vehicle.x = -100; f.vehicle.vx = 0;
  const a = f.unit, b = f.squad.units.get('b'); a.haul = b.haul = { depositId: 'mine', material: 'ferro', phase: 'out' };
  a.move = null; b.move = null;
  f.squad.haul('a', a); assert(Math.abs(a.move.x - 6.55) < 1e-9, 'the first transporter takes the far bay, leaving the centre clear');
  f.squad.haul('b', b); assert(Math.abs(b.move.x + 6.45) < 1e-9, 'the second slot is retained inside the real pickup interval');
  f.vehicle.x = 6; a.move = { x: 6.5, best: .5, since: f.world.time, turning: false };
  f.squad.safeSpeed = () => Infinity;
  assert.deepEqual(f.squad.drive('a', a), { throttle: 1, brake: 0 }); assert(a.move, 'fine parking uses enough pull to start, inside the ordinary arrival tolerance');
  f.squad.safeSpeed = () => 0;
  assert.deepEqual(f.squad.drive('a', a), { throttle: 0, brake: 1 }, 'the starting pull never overrides an unsafe speed envelope');
  f.squad.safeSpeed = () => Infinity;
  f.vehicle.x = 6.1; assert.equal(f.squad.drive('a', a).brake, 1); assert.equal(a.move, null);
});

test('an extractor keeps its shared central work point, leaving the pile visible', () => {
  const f = pilot(() => 0); f.vehicle.x = -100; f.unit.move = null;
  f.unit.haul = { depositId: 'mine', material: 'ferro', phase: 'out' };
  f.side.load = () => ({ carried: 0, room: 0, extracts: true }); f.side.depot = () => ({ x: -1000, radius: 100 });
  f.side.deposit = () => ({ x: 0, left: 1000, area: { lo: -7, hi: 7, goal: 0, ready: false, digs: true } });
  f.squad.haul('a', f.unit); assert.equal(f.unit.move.x, 0);
});

test('the brakes are counted on by the grip of the ground, and the ground ahead slows only by what it holds', () => {
  assert.equal(groundBraking('asphalt'), BRAKING); assert.equal(groundBraking('rock'), BRAKING);
  assert(Math.abs(groundBraking('mud') - 9.81 * .26) < 1e-9 && groundBraking('mud', true) === BRAKING, 'a track grips mud as wheels do firm ground');
  assert(groundBraking('sand', false, 300) < groundBraking('sand'), 'sand gives under a wheel pressed hard into it');
  assert.equal(groundBraking(null), groundBraking('mud'), 'ground a pilot is not told of is taken for the one that holds least');
  // Asphalt up to x = 200, then mud: crossing onto it, it has only the mud to stop on.
  const road = { ...ground(() => 0), groundAt: x => x < 200 ? 'asphalt' : 'mud' };
  const away = terrainSpeed(road, 150, -1000, { speed: 30 }), near = terrainSpeed(road, 150, 1000, { speed: 30 }),
    far = terrainSpeed(road, 0, 1000, { speed: 30 }), on = terrainSpeed(road, 250, 1000, { speed: 30 });
  assert.equal(far.speed2, away.speed2, 'mud beyond where it stops holds nothing back');
  assert(near.speed2 < away.speed2 && near.speed2 < 2 * BRAKING * near.range, 'mud nearer takes some of the way it plans to stop on');
  assert(Math.abs(on.speed2 - 2 * groundBraking('mud') * on.range) < 1e-6 && on.speed2 > 30 ** 2, 'on the mud, no ceiling under its own speed');
  assert.equal(groundSpeed(road, 100), Infinity); assert.equal(groundSpeed({ groundAt: () => 'graded' }, 0), 135 / 3.6);
  assert.equal(groundSpeed({ groundAt: () => 'graded' }, 0, true), 70 / 3.6); assert.equal(groundSpeed({ groundAt: () => 'concrete' }, 0), Infinity);
});

test('a way is reckoned at the slower of the top speed and the speed reckoned for each stretch of its ground', () => {
  const terrain = new Terrain('flat');
  terrain.sectors = [{ start: -1600, end: 0, surface: 'mud' }, { start: 0, end: 1600, surface: 'soil' }];
  terrain.roads = paved(paved(NO_ROADS, 100, 300, 'asphalt'), 300, 400, 'graded');
  const top = 30, seconds = (from, to, options = {}) => travelSeconds(terrain, from, to, { top, ...options });
  // 100 m of mud at 55 km/h and 100 of soil at 105; 200 of asphalt and 100 graded at the top speed, under the 135 km/h
  // reckoned for graded ground; 100 more of soil.
  const expected = 100 / (55 / 3.6) + 100 / (105 / 3.6) + 200 / top + 100 / top + 100 / (105 / 3.6);
  assert(Math.abs(seconds(-100, 500) - expected) < 1e-9);
  assert.equal(seconds(500, -100), seconds(-100, 500), 'either way');
  assert(Math.abs(seconds(-100, 500, { share: .5 }) - 2 * expected) < 1e-9);
  assert(Math.abs(seconds(150, 250, { top: 10 }) - 10) < 1e-9, 'on asphalt only its own speed holds it back');
  assert(Math.abs(seconds(-100, 0, { tracked: true }) - 100 / (55 / 3.6)) < 1e-9, 'a track crosses mud at 55 km/h');
  assert(Math.abs(seconds(500, 600, { tracked: true }) - 100 / (70 / 3.6)) < 1e-9, 'and soil at 70');
  assert.equal(seconds(42, 42), 0);
  assert(Math.abs(seconds(0, 50, { top: 0 }) - 50) < 1e-9, 'never under a metre a second');
});

test('a way is reckoned besides at the time the engine takes at full power to lift the vehicle up every rise of it, either way', () => {
  // Soil, level but for a hill 40 m high, 500 m from foot to foot about x = 0.
  const points = [{ x: -1600, y: 0 }];
  for (let x = -1000; x <= 1000; x += .5) points.push({ x, y: Math.abs(x) <= 250 ? 40 * Math.cos(Math.PI * x / 500) ** 2 : 0 });
  points.push({ x: 1600, y: 0 });
  const terrain = Terrain.fromSnapshot({ id: 'flat', seed: 0, length: 2000, center: 0, spacing: .5, minX: -1000, maxX: 1000, material: 'soil',
    points, sectors: [{ start: -1600, end: 1600, surface: 'soil' }], features: [], rocks: [] });
  for (const [from, to] of [[-500, 500], [500, -500], [-500, 0], [500, 0]]) assert(Math.abs(climbed(terrain, from, to) - 40) < 1e-9, `${from} → ${to}`);
  assert.equal(climbed(terrain, 0, 500), 0, 'down the hill it climbs nothing');
  const level = travelSeconds(terrain, -500, 500, { top: 30 });
  assert(Math.abs(travelSeconds(terrain, -500, 500, { top: 30, lift: 2 }) - level - 20) < 1e-9, 'forty metres at two a second');
  assert.equal(travelSeconds(terrain, 0, 500, { top: 30, lift: 2 }), travelSeconds(terrain, 0, 500, { top: 30 }));
});
