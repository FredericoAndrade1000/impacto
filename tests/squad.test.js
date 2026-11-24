import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { Squad, STANCES, ARRIVAL, GAP, DEPOT_INSET, RETURN_FIRE_SECONDS, COUNTER_ERROR, scriptedDecision } from '../src/squad.ts';
import { TURN_SECONDS } from '../src/economy.ts';
import { controlContext } from '../src/ui-model.ts';
import { WEAPON_PRESETS, propellantCharges, weaponSettings } from '../src/weapons.ts';
import { firingSolution } from '../src/ballistics.ts';
import { segmentInBox } from '../src/math.ts';
import { WORLD_EDGE } from '../src/battle-rules.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { onField } from './helpers/field.js';
import { pilotDecision } from './helpers/pilot-fixture.ts';

const LOCAL_FIRE_RADIUS = 120; // the approved locomotion policy, independent of ballistic range

// Alice's squad on the shared field and Bob's, `gap` metres apart, facing each other: of each, a heavy tank, a
// reconnaissance vehicle ahead of it and an artillery carrier behind it — Alice's a mortar (`artillery`), Bob's a
// howitzer. Nobody is at the controls of any of them, nor does the field serve any by itself. `own` and `enemies`
// are their names, the heavy tank's first.
function commanded(t, { artillery = 'mortar', gap = 300 } = {}) {
  const f = onField(t, rehearsal([12 - gap / 2, 12 + gap / 2])), room = f.room, world = room.world, [alice, bob] = ['Alice', 'Bob'].map(name => room.join(name)),
    line = (player, models, front, facing) => models.map((model, i) => f.publish(player, model, { x: front - facing * [18, 0, 36][i], facing }));
  const own = line(alice, ['heavy', 'recon', artillery], 12 - gap / 2, 1), enemies = line(bob, ['heavy', 'recon', 'howitzer'], 12 + gap / 2, -1);
  for (const player of [alice, bob]) { f.order(player, 'control', { id: null }); }
  f.run(.5);
  const squad = room.players.get(alice.playerId).squad, side = squad.side,
    at = id => world.actor(id).vehicle.x, moduleOf = (id, kind) => world.modules.find(m => m.actorId === id && m.kind === kind);
  return { ...f, alice, bob, squad, side, own, enemies, at, moduleOf,
    decide: id => squad.decide(side.member(world.actor(id))),
    // Takes a little of the health of a part of a construction: a hit, to whoever compares its wear.
    damage: (id, kind = 'fuel') => { f.set(moduleOf(id, kind), { health: moduleOf(id, kind).health - 1 }); world.step(1 / 60); } };
}

test('a squad commands the player\'s vehicles, and the one in the player\'s hands is given no decision', t => {
  const { squad, own, decide } = commanded(t);
  assert.deepEqual(squad.members.map(m => m.id), own);
  assert.equal(squad.manual, null, 'the vehicles come under command');
  assert.deepEqual(squad.view().units.map(u => [u.id, u.role, u.stance]), [[own[0], 'armor', 'return'], [own[1], 'armor', 'return'], [own[2], 'artillery', 'return']]);
  squad.command({ order: 'control', id: own[1] });
  assert.equal(decide(own[1]), null); assert.equal(squad.manual, own[1]);
});

test('the rule pilot engages only the enemy an order names', t => {
  const { world, side, own, enemies, at } = commanded(t), bounds = side.arenaBounds;
  for (const targetId of enemies) for (const id of [own[0], own[2]]) {
    const decision = scriptedDecision(world, id, bounds, targetId);
    assert.equal(decision.targetId, targetId);
    assert(Math.abs(decision.contact.x - at(targetId)) < 12, 'the contact is the reading of that enemy');
  }
  // Friends are never targets, and an unknown or own name is refused.
  assert.equal(scriptedDecision(world, own[0], bounds, own[1]).targetId, null);
  for (const targetId of [own[0], 'nobody', 7])
    assert.throws(() => world.game().call({ op: 'scriptedDecision', actorId: own[0], arenaBounds: bounds, targetId }), /Alvo de pilotagem inválido/);
});

test('an attack order holds every ordered vehicle on its target until the target is out', t => {
  const { room, squad, own, enemies, decide, moduleOf, set, run } = commanded(t), target = enemies[2];
  squad.command({ order: 'attack', ids: own, targetId: target });
  for (const id of own) {
    const action = decide(id);
    assert.equal(action.targetId, target); assert.equal(action.throttle, 0); assert.equal(action.brake, 1);
  }
  assert.deepEqual(squad.view().units.map(u => u.attack), own.map(() => ({ targetId: target })));
  assert.throws(() => squad.command({ order: 'attack', ids: own, targetId: own[1] }), /Alvo inválido/);
  set(moduleOf(target, 'command'), { health: 0 }); run(.2);
  assert(room.outOfAction()[target]);
  assert.throws(() => squad.command({ order: 'attack', ids: own, targetId: target }), /Alvo inválido/);
  for (const id of own) decide(id);
  assert.deepEqual(squad.view().units.map(u => u.attack), [null, null, null]);
});

test('vehicles sent to one point drive to their own places, in the order they stood, and the order ends there', { timeout: 60000 }, t => {
  const { world, side, squad, own, at, room } = commanded(t, { gap: 600 }), before = own.map(at), goal = at(own[0]) + 50;
  squad.command({ order: 'move', ids: own, x: goal, arrival: .45 });
  assert(own.every(id => squad.units.get(id).move.arrival === undefined), 'public orders cannot select the private loading approach');
  const places = Object.fromEntries(squad.view().units.map(u => [u.id, u.move.x]));
  const line = own.slice().sort((a, b) => before[own.indexOf(a)] - before[own.indexOf(b)]), rooms = line.map(id => squad.room(id)),
    ends = line.map((id, i) => [places[id] - rooms[i] / 2, places[id] + rooms[i] / 2]);
  // End to end about the place, in the order they stood, the gap between each two.
  assert(ends.slice(1).every(([start], i) => Math.abs(start - ends[i][1] - GAP) < 1e-9), JSON.stringify(ends));
  assert(Math.abs((ends[0][0] + ends[2][1]) / 2 - goal) < 1e-9);
  for (let i = 0; i < 40 * 60 && squad.view().units.some(u => u.move); i++) room.step();
  assert.deepEqual(squad.view().units.map(u => u.move), [null, null, null]);
  for (let i = 0; i < 120; i++) room.step();
  for (const id of own) {
    assert(Math.abs(at(id) - places[id]) <= ARRIVAL + 1, `${id} stopped ${Math.abs(at(id) - places[id]).toFixed(1)} m from its place`);
    assert(Math.abs(world.actor(id).vehicle.vx) < .5, `${id} still rolls at ${world.actor(id).vehicle.vx.toFixed(2)} m/s`);
  }
  // A place past the end of the field is brought inside it.
  squad.command({ order: 'move', ids: [own[0]], x: 1e9 });
  assert(squad.view().units[0].move.x < side.arenaBounds.maxX);
  squad.command({ order: 'stop', ids: own }); assert.equal(squad.view().units[0].move, null);
});

test('a vehicle sent to the end of the field, or past it, drives as far as the field lets it, and its order ends there', { timeout: 60000 }, t => {
  const room = rehearsal(() => Math.round(room.world.terrain.maxX - 60)), f = onField(t, room), { world, ground, until } = f,
    alice = room.join('Alice'), id = f.publish(alice, 'recon'), squad = room.players.get(alice.playerId).squad, unit = () => squad.units.get(id),
    reach = ground.maxX - WORLD_EDGE;
  f.order(alice, 'control', { id: null });
  for (const x of [ground.maxX + 500, ground.maxX]) { f.order(alice, 'move', { ids: [id], x }); assert.equal(unit().move.x, reach); }
  assert(until(() => !unit().move, 40), 'it gets there');
  assert.equal(unit().halt, '', 'no way is shut'); assert(Math.abs(world.actor(id).vehicle.x - reach) <= ARRIVAL, `it stopped at ${world.actor(id).vehicle.x - ground.maxX} m`);
});

// Base: a vehicle that drives goes into its base as a hauler goes there to unload, as far inside its edge, and stops; one
// that stands in it already stops where it is.
test('sent home, a vehicle that drives goes into its base and stops there; one there already stops where it stands', { timeout: 60000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, run, until } = f, alice = room.join('Alice'), id = f.publish(alice, 'recon'),
    squad = room.players.get(alice.playerId).squad, unit = () => squad.units.get(id), at = () => world.actor(id).vehicle.x,
    base = (faction => room.depot(faction, faction.base.x))(room.faction(room.players.get(alice.playerId))), toward = Math.sign(400 - base.x);
  f.order(alice, 'control', { id: null });
  f.put(id, base.x + toward * (base.radius + 150));
  f.order(alice, 'home', { ids: [id] });
  const goal = base.x + toward * (base.radius - DEPOT_INSET);
  assert.deepEqual(squad.view().units[0].move, { x: goal, home: true }, 'the page is told it goes home');
  assert(until(() => !unit().move, 40), `still ${Math.abs(at() - goal).toFixed(1)} m away`);
  run(2);
  assert.equal(unit().halt, '', 'no way is shut');
  assert(Math.abs(at() - goal) <= ARRIVAL + .5 && Math.abs(world.actor(id).vehicle.vx) < .5, `stopped at ${at().toFixed(1)} for ${goal}`);
  // In its base already, it is sent nowhere else.
  f.order(alice, 'home', { ids: [id] });
  assert(Math.abs(unit().move.x - at()) < 1e-9, `${unit().move.x} for ${at()}`);
  assert(until(() => !unit().move, 5));
});

test('on a steep slope a vehicle sent down it stops at the place, its brakes against its weight, one sent up it climbs there, and both stay', { timeout: 60000 }, t => {
  const f = onField(t, rehearsal([0])), { room, world, ground, run } = f, alice = room.join('Alice'), id = f.publish(alice, 'heavy');
  f.order(alice, 'control', { id: null });
  const squad = room.players.get(alice.playerId).squad, at = () => world.actor(id).vehicle.x;
  // A stretch of 20° or so, 50 m long, where the vehicle is set down at rest.
  const slope = x => Math.atan2(ground.height(x + 2) - ground.height(x - 2), 4), steep = x => Math.abs(Math.abs(slope(x)) * 180 / Math.PI - 20) < 3;
  let x = ground.minX + 200; while (!(steep(x) && [-25, -15, -5, 5, 15, 25].every(d => Math.abs(slope(x + d) - slope(x)) < .07))) x += 2;
  world.game().call({ op: 'setVehicleState', actorId: id, state: { x, y: ground.height(x) + 2.5, angle: slope(x), vx: 0, vy: 0, omega: 0 } });
  run(3);
  const unit = squad.units.get(id), down = -Math.sign(slope(x));
  for (const way of [down, -down]) {
    squad.command({ order: 'move', ids: [id], x: at() + way * 15 });
    const goal = unit.move.x;
    for (let i = 0; i < 30 * 60 && unit.move; i++) room.step();
    assert.deepEqual([unit.move, unit.halt], [null, ''], 'it got there');
    run(5);
    assert(Math.abs(at() - goal) <= ARRIVAL, `${way === down ? 'down' : 'up'} the slope it stands ${(at() - goal).toFixed(2)} m from the place`);
    assert(Math.abs(world.actor(id).vehicle.vx) < .05, 'and stays there');
  }
});

test('a vehicle sent back the way it came stops on its brakes and goes there: the wait for a shut way begins where it stopped', { timeout: 60000 }, t => {
  // The vehicle of the squad nearest the enemy has nobody of its own in its way.
  const { room, world, squad, own, enemies, at } = commanded(t, { gap: 780 }), side = Math.sign(at(enemies[0]) - at(own[0])),
    id = own.reduce((lead, other) => at(other) * side > at(lead) * side ? other : lead), unit = squad.units.get(id), start = at(id),
    speed = () => world.actor(id).vehicle.vx * side;
  squad.command({ order: 'move', ids: [id], x: start + side * 400 });
  assert.equal(unit.move.turning, false, 'sent somewhere from rest, it has nothing to stop');
  for (let i = 0; i < 40 * 60 && Math.abs(at(id) - start) < 150; i++) room.step();
  const fast = speed(), turned = at(id); assert(fast > 10, `it rolls at ${fast.toFixed(1)} m/s`);
  squad.command({ order: 'move', ids: [id], x: turned - side * 60 });
  const goal = unit.move.x; let far = 0, steps = 0; assert.equal(unit.move.turning, true);
  for (; steps < 40 * 60 && unit.move; steps++) { room.step(); far = Math.max(far, (at(id) - turned) * side); }
  // Wheels spun backwards slowed it at some 2 m/s², and the 8 s a shut way is waited for ran out before it was back where it turned.
  assert(far < fast * fast / (2 * 3.5), `on its brakes: it rolled ${far.toFixed(1)} m on from ${fast.toFixed(1)} m/s`);
  assert(steps / 60 > 8, 'longer on the way than a shut way is waited for');
  assert.deepEqual([unit.move, unit.halt], [null, ''], 'and the order was not given up');
  assert(Math.abs(at(id) - goal) <= ARRIVAL + 1, `it stopped ${Math.abs(at(id) - goal).toFixed(1)} m from the place`);
});

test('without an attack order the stance decides the fire: held, returned for a while after a hit, or free', t => {
  const { world, squad, side, own, enemies, decide, damage } = commanded(t), unit = id => squad.units.get(id), recon = own[1];
  assert.deepEqual(Object.keys(STANCES), ['hold', 'return', 'fire']);
  // The same aligned shot, admitted or not by the stance.
  const shot = stance => {
    squad.command({ order: 'stance', ids: [recon], stance });
    let fired = false;
    for (let i = 0; i < 240 && !fired; i++) { world.step(1 / 60); if (i % 6 === 0) { const action = decide(recon); side.input(recon, action, true); fired = action.fire; } }
    return fired;
  };
  assert.equal(shot('fire'), true, 'the reconnaissance gun bears on the enemy');
  assert.equal(shot('hold'), false); assert.equal(squad.view().units[1].reason, 'holding');
  unit(recon).alertUntil = -Infinity;
  assert.equal(shot('return'), false);
  damage(recon);
  assert.equal(shot('return'), true, 'a vehicle that was hit answers');
  assert(squad.view().units[1].alert); assert(!squad.view().units[0].alert, 'the alarm belongs to the vehicle that was hit');
  unit(recon).alertUntil = world.time - 1e-3;
  assert.equal(shot('return'), false, `and stops ${RETURN_FIRE_SECONDS} s after the last hit`);
  // Holding fire drops an attack order; an attack order fires whatever the stance.
  squad.command({ order: 'attack', ids: own, targetId: enemies[1] });
  squad.command({ order: 'stance', ids: [recon], stance: 'hold' });
  assert.equal(unit(recon).attack, null); assert.deepEqual(unit(own[0]).attack, { targetId: enemies[1] });
  // A stance that leaves the driving to the rule pilot is none: the squad drives its vehicles itself.
  for (const stance of ['berserk', 'auto']) assert.throws(() => squad.command({ order: 'stance', ids: own, stance }), /Postura desconhecida/);
  assert.equal(unit(own[0]).stance, 'return');
});

test('on Revidar a vehicle answers a hit on another of its side within the reach of its guns', t => {
  const { world, squad, own, at, decide, damage } = commanded(t), [heavy, recon, mortar] = own, unit = id => squad.units.get(id),
    answering = id => unit(id).answerUntil > world.time,
    // This checks response distances, not driving. Place and step physics without
    // running the room's pilots, which would start an unrelated live exchange.
    place = (id, x) => {
      const vehicle = world.actor(id).vehicle;
      world.command('setVehicleState', { actorId: id, state: { x, y: vehicle.y - world.terrain.height(vehicle.x) + world.terrain.height(x) + 1, vx: 0, vy: 0 } });
      world.step(1 / 60);
    };
  // A mortar reaches by its arcs; a gun that fires at what it sees, no farther than its sensors see.
  const sight = Math.max(...world.modules.filter(m => m.actorId === recon && m.kind === 'sensor').map(m => (SENSOR_MODES[m.sensorMode] || SENSOR_MODES.visual).range));
  const reach = squad.reach(mortar); assert(reach > 5000 && reach < 6000, `the mortar reaches ${reach} m`);
  const gun = world.modules.find(m => m.actorId === recon && m.kind === 'weapon'), gunReach = squad.reach(recon),
    settings = weaponSettings(WEAPON_PRESETS[gun.weaponPreset].family, { preset: gun.weaponPreset, trajectory: 'low', charge: 'auto' }),
    reached = far => firingSolution({ x: 0, y: 0 }, { x: far, y: 0 }, settings).reachable;
  assert(gunReach < sight, 'the radar sees farther than this gun can fire');
  assert.equal(reached(gunReach - .1), true, 'the response reaches the ballistic envelope of the installed gun');
  assert.equal(reached(gunReach + .1), false, 'sensor range never extends the gun beyond its ballistic envelope');
  for (const id of own) decide(id);
  // The heavy tank is hit beside them: it answers for itself, the others for it.
  damage(heavy); decide(recon);
  assert(unit(heavy).alertUntil > world.time && !answering(heavy), 'its own hit is its own alarm');
  assert(answering(recon) && answering(mortar) && unit(recon).alertUntil < world.time);
  assert.deepEqual(squad.view().units.map(u => u.alert), [true, false, false], 'the alarm is still the hit vehicle\'s alone');
  // Hit farther from the reconnaissance vehicle than its sensors see, within the mortar's arcs: the mortar alone answers.
  const away = Math.sign(at(heavy) - at(mortar)) || 1;
  place(heavy, at(recon) + away * (sight + 300)); place(mortar, at(recon) + away * (sight + 300 - reach + 500));
  decide(recon);
  for (const id of [recon, mortar]) unit(id).answerUntil = -Infinity;
  assert.equal(world.projectiles.length, 0, 'only the known distant hit can start the response');
  damage(heavy); decide(recon);
  assert.deepEqual([answering(recon), answering(mortar)], [false, true]);
});

test('a repair reduces wear and a renewed construction is no fresh hit when no other impact occurs', t => {
  // The preceding reach test advances a live battle while it relocates vehicles.
  // Use a fresh field here: an incoming round would be a legitimate reason to answer.
  const { world, squad, own, decide, damage, set, moduleOf } = commanded(t), [heavy, recon, mortar] = own,
    unit = id => squad.units.get(id), answering = id => unit(id).answerUntil > world.time;
  for (const id of own) decide(id);
  damage(heavy); decide(recon);
  assert(answering(recon) && answering(mortar), 'the known damage still alerts both nearby responders');
  for (const renewed of [false, true]) {
    const before = new Map(squad.wear);
    if (renewed) { squad.renewed(heavy); decide(recon); }
    for (const id of own) unit(id).answerUntil = -Infinity;
    const fuel = moduleOf(heavy, 'fuel'), repaired = renewed ? .25 : .5;
    assert.equal(world.projectiles.length, 0, 'the repair baseline contains no round in flight');
    world.drainEvents(); set(fuel, { health: fuel.health + repaired });
    world.step(1 / 60); decide(recon);
    const impacts = world.drainEvents().filter(event => ['penetration', 'ricochet', 'blocked', 'module', 'secondary-impact'].includes(event.type));
    assert.deepEqual(impacts, [], 'the repair step contains no unrelated new hit');
    assert.equal(world.projectiles.length, 0);
    assert(Math.abs(squad.wear.get(heavy) - (before.get(heavy) - repaired)) < 1e-9, 'repair reduces measured wear by the health restored');
    for (const id of [recon, mortar]) {
      assert.equal(squad.wear.get(id), before.get(id), 'no responder was damaged during the repair');
      assert.equal(answering(id), false, 'restored health never starts a new response');
    }
  }
});

test('the rule pilot of a squad\'s vehicle never drives it: whatever its stance, it holds its place', t => {
  const { world, squad, own, decide } = commanded(t), core = world.game(), call = core.call.bind(core), asked = [];
  core.call = request => {
    const result = call(request);
    if (request.op === 'scriptedDecision') asked.push([request.actorId, request.targetId, result.action.throttle, result.action.brake]);
    return result;
  };
  squad.command({ order: 'stance', ids: own.slice(0, 2), stance: 'fire' });
  for (const id of own) decide(id);
  assert.deepEqual(asked, own.map(id => [id, undefined, 0, 1]));
});

// The rule pilot of a vehicle of the squad made to answer, in place of what it has in its senses, as `answers` says: with
// the reason a gun of it has or has no shot, at the enemy `target`, or nothing in its senses (`search-contact`). The
// rest of its decision is its own, but that it does not fire. Vehicles that `answers` does not name decide on their own.
function answering({ world, at }, answers, target) {
  const core = world.game(), call = core.call.bind(core), answer = (actorId, decision) => {
    if (!answers.has(actorId)) return decision;
    const reading = answers.get(actorId), picked = typeof reading === 'string' ? { reason: reading } : reading,
      reason = picked.reason, action = { ...decision.action, fire: false }, seen = reason !== 'search-contact';
    delete action.also;
    return { ...decision, action, targetId: seen ? picked.targetId ?? target : null,
      diagnostics: { ...decision.diagnostics, reason, viableShots: 0, ...picked.diagnostics },
      contact: seen ? { ...decision.contact, detected: true, visible: true, source: 'team', channel: 'visual', confidence: 1,
        age: 0, x: at(target), y: world.actor(target).vehicle.y + 1, ...picked.contact } : { ...decision.contact, detected: false } };
  };
  core.call = request => {
    const result = call(request);
    if (request.op === 'scriptedDecision') return answer(request.actorId, result);
    if (request.op === 'scriptedDecisions') return result.map((row, i) => {
      if (Object.hasOwn(row, 'error')) return row;
      const decision = answer(request.requests[i].actorId, row.result);
      return decision === row.result ? row : { ...row, result: decision };
    });
    return result;
  };
}

test('on Fogo livre terrain cover permits a physical local approach inside the posture region', { timeout: 60000 }, t => {
  const f = commanded(t, { gap: 110 }), { room, world, squad, own, enemies, at, decide, run, put } = f,
    id = own[1], target = enemies[0], unit = squad.units.get(id), start = at(id),
    answers = new Map([[id, 'terrain-cover']]);
  put(target, start + LOCAL_FIRE_RADIUS - 1);
  answering(f, answers, target);
  squad.command({ order: 'stance', ids: [id], stance: 'fire' });
  const anchor = unit.fireAt, first = decide(id);
  assert.equal(first.fire, false); assert.equal(first.targetId, target);
  assert(unit.move, 'cover starts an ordinary drive towards the measured enemy');
  const leg = unit.move, since = leg.since;
  decide(id);
  assert.equal(unit.move, leg); assert.equal(unit.move.since, since, 'the same contact does not restart progress');
  for (let i = 0; i < 20 * 60; i++) {
    room.step();
    if (unit.move) assert(Math.abs(unit.move.x - anchor) <= LOCAL_FIRE_RADIUS - 20, 'every destination leaves braking room inside the region');
    assert(Math.abs(at(id) - anchor) <= LOCAL_FIRE_RADIUS + ARRIVAL, 'the vehicle remains in its local region');
    assert.equal(unit.fireAt, anchor, 'approaching a contact never advances the anchor');
  }
  assert(at(id) > anchor + 10, 'ordinary controls actually moved the vehicle');
  assert.equal(world.actor(id).stats.shots, 0, 'terrain cover grants no shot');
  answers.set(id, 'search-contact'); run(3);
  assert.equal(unit.move, null); assert(Math.abs(world.actor(id).vehicle.vx) < .5, 'losing the contact brakes without a return trip');
  const stopped = at(id); run(3); assert(Math.abs(at(id) - stopped) < .5);
});

test('a closer fresh contact cannot renew a blocked free-fire trip without physical progress', { timeout: 60000 }, t => {
  const f = commanded(t, { gap: 100 }), { world, squad, own, enemies, at, run, parts, set } = f,
    id = own[1], target = enemies[0], unit = squad.units.get(id), answers = new Map([[id, 'terrain-cover']]);
  answering(f, answers, target);
  const gear = parts(id, 'wheel', 'track'); assert(gear.length > 0);
  // Real admitted machinery, obstructed by loss of its running gear, as in the existing haul regression.
  // Do not fake config.disabled, stuck, position, the driver, or its progress timer.
  for (const part of gear) set(part, { health: 0 });
  run(1.5);
  const vehicle = world.actor(id).vehicle, power = vehicle.drivetrain.powerKw, start = at(id), width = squad.room(target),
    apart = (squad.room(id) + Math.max(7, width)) / 2 + GAP, began = world.time;
  assert(vehicle.config.enabled && power > 0, 'the ordinary mobility path is still enabled');
  squad.command({ order: 'stance', ids: [id], stance: 'fire' });
  let attempted = false;
  for (let reading = 0; reading < 95 && !unit.halt; reading++) {
    answers.set(id, { reason: 'terrain-cover', contact: { x: start + apart + 5 - reading * .01, width } });
    run(.1); attempted ||= Boolean(unit.move);
  }
  assert(attempted, 'the normal pilot attempted to drive');
  assert(Math.abs(at(id) - start) < .5, 'the physical obstruction allowed no progress');
  assert.equal(vehicle.drivetrain.powerKw, power, 'its engine power was not disabled to force the result');
  assert.equal(unit.move, null, 'contact drift cannot extend a trip indefinitely');
  assert.match(unit.halt, /^(blocked-way|stuck-(ground|grip|slope))$/, 'the real driver reports its obstruction');
  assert(world.time - began > 8 && world.time - began < 9, 'the existing eight-second progress timeout still ends the trip');
  run(1); assert.equal(unit.move, null, 'the same contact cannot restart a confirmed blocked trip');
});

test('on Fogo livre an explicit move has priority and completion or manual release recaptures its local region', { timeout: 60000 }, t => {
  const f = commanded(t), { room, world, squad, own, enemies, at, run, decide, put } = f, id = own[1], unit = squad.units.get(id),
    answers = new Map([[id, 'terrain-cover']]), start = at(id), way = Math.sign(at(enemies[0]) - start);
  answering(f, answers, enemies[0]);
  squad.command({ order: 'stance', ids: [id], stance: 'fire' });
  squad.command({ order: 'move', ids: [id], x: start + way * 20 });
  const explicit = unit.move, goal = explicit.x;
  decide(id); assert.equal(unit.move, explicit, 'a contact cannot replace the human trip');
  for (let i = 0; i < 30 * 60 && unit.move; i++) room.step();
  assert.deepEqual([unit.move, unit.halt], [null, '']);
  assert((at(id) - start) * way > 15, 'the explicit move took it forward');
  assert(Math.abs(unit.fireAt - goal) <= ARRIVAL, 'the completed explicit order authorizes the new region');
  const relocated = unit.fireAt;
  run(5);
  assert.equal(unit.fireAt, relocated, 'later contacts and idle decisions do not recapture the region');
  assert(Math.abs(at(id) - goal) <= ARRIVAL, 'an enemy outside the local region starts no further drive');
  squad.command({ order: 'stop', ids: [id] }); assert.equal(unit.fireAt, null);
  put(enemies[0], at(id) + way * 70);
  decide(id); assert.equal(unit.move, null, 'Stop keeps a fresh nearby contact from starting a pursuit');
  squad.command({ order: 'stance', ids: [id], stance: 'fire' });
  decide(id); assert(unit.move, 'a new posture explicitly enables local pursuit again');
  squad.command({ order: 'control', id });
  assert.deepEqual([unit.move, unit.fireAt], [null, null]); assert.equal(decide(id), null, 'manual control owns the vehicle');
  answers.set(id, 'search-contact');
  squad.command({ order: 'control', id: null });
  assert.equal(unit.fireAt, at(id), 'release captures the place where the player actually left it');
  run(3); assert.equal(unit.move, null); assert(Math.abs(world.actor(id).vehicle.vx) < .5);
});

test('free-fire movement uses fresh visual or radar contacts, and respects shot and worker vetoes', t => {
  const f = commanded(t, { gap: 100 }), { squad, side, room, own, enemies, decide, at } = f, id = own[1], target = enemies[0],
    unit = squad.units.get(id), answers = new Map([[id, 'terrain-cover']]);
  answering(f, answers, target);
  const renew = reading => {
    squad.command({ order: 'stance', ids: [id], stance: 'fire' });
    answers.set(id, { reason: 'terrain-cover', ...reading });
    return decide(id);
  };
  renew({ contact: { source: 'team', channel: 'radar', visible: true } });
  assert(unit.move, 'a current radar reading is a real placement, not optical-only visibility');
  for (const contact of [
    { source: 'memory', channel: 'radar' }, { visible: false }, { channel: 'sound' }, { age: 1 },
    { x: at(id) + LOCAL_FIRE_RADIUS + 1 },
  ]) {
    renew({ contact });
    assert.equal(unit.move, null, JSON.stringify(contact));
  }
  // The native decision can still carry a stale target identity. Side eligibility, not a hidden pose or health query, decides it.
  const foe = side.foe.bind(side);
  side.foe = () => false;
  renew({ targetId: own[0] }); assert.equal(unit.move, null, 'an allied target is vetoed');
  renew({ targetId: target }); assert.equal(unit.move, null, 'a target the side knows out of action is vetoed');
  side.foe = foe;
  for (const reason of ['ally-in-line', 'own-in-line', 'blast-too-close', 'no-armed-feed', 'reloading', 'servo-aligning']) {
    renew({ reason }); assert.equal(unit.move, null, reason);
  }
  renew({ diagnostics: { viableShots: 1 } }); assert.equal(unit.move, null, 'a valid shot waiting on its servo needs no drive');
  room.records.get(id).auto = true;
  renew({}); assert.equal(unit.move, null, 'automatic work owns its vehicle even between its trips');
  room.records.get(id).auto = false;
  renew({}); assert(unit.move, 'leaving automatic work restores the explicit posture authority');
  // Guardians derive their anchor from the drop and restore their ordinary fire leg.
  // Repeated no-contact decisions must retain its progress clock instead of giving it eight new seconds each time.
  const anchor = at(id) + 40;
  side.freeFireRegion = () => ({ anchor, radius: LOCAL_FIRE_RADIUS, home: true });
  unit.move = { ...squad.leg(id, anchor), purpose: 'fire' };
  unit.move.since -= 2;
  const home = unit.move, since = home.since;
  answers.set(id, 'search-contact'); decide(id); decide(id);
  assert.equal(unit.move, home); assert.equal(unit.move.since, since, 'a restored autonomous return remains its own leg');
});

test('a rear M2 contact can request the normal five-second turn after a hit, without an instant flip', { timeout: 60000 }, t => {
  const f = onField(t, rehearsal([0, 1000])), { room, world, run, set } = f,
    alice = room.join('Alice'), bob = room.join('Bob'),
    id = f.publish(alice, 'scout', { facing: -1 }),
    observer = f.publish(alice, 'recon', { facing: 1 }),
    target = f.publish(bob, 'chassis', { facing: -1 });
  f.order(alice, 'control', { id: null }); f.order(bob, 'control', { id: null });
  f.order(alice, 'stance', { ids: [observer], stance: 'hold' });
  // Manufacture in each real base, then stand the fixture at the measured combat positions.
  f.put(id, 0); f.put(observer, -30); f.put(target, 140); run(1);
  const squad = room.players.get(alice.playerId).squad, side = squad.side, unit = squad.units.get(id),
    fuel = f.parts(id, 'fuel')[0], gun = f.parts(id, 'weapon')[0];
  assert.equal(gun.weaponPreset, 'm2hb');
  set(fuel, { health: fuel.health - 1 }); run(.2);
  f.order(alice, 'stance', { ids: [id], stance: 'fire' });
  const anchor = unit.fireAt, action = squad.decide(side.member(world.actor(id))), service = room.records.get(id).service;
  assert.equal(action.targetId, target); assert.equal(unit.reason, 'turn-to-fire');
  assert.deepEqual([action.throttle, action.brake, action.fire], [0, 1, false]);
  assert.equal(service?.kind, 'turn'); assert(Math.abs(service.until - world.time - TURN_SECONDS) < 1e-9);
  assert(unit.alertUntil > world.time, 'a previous hit does not forbid a fire manoeuvre');
  assert.equal(world.actor(id).facing, -1);
  assert.equal(unit.move, null, 'an enemy beyond the movement region permits a local turn, not a pursuit leg');
  run(TURN_SECONDS - .2); assert.equal(world.actor(id).facing, -1, 'the timed service must finish first');
  assert(f.until(() => world.actor(id).facing === 1 && !room.records.get(id).service, 1));
  assert.equal(unit.fireAt, anchor, 'turning never shifts the posture region');
});

test('a point is bombarded with a fed gun, seen or not', t => {
  const { ground, squad, side, own, enemies, at, decide, moduleOf } = commanded(t), [heavy, , mortar] = own,
    point = { x: at(enemies[0]), y: ground.height(at(enemies[0])) + 2 };
  squad.command({ order: 'bombard', ids: [heavy, mortar], point });
  for (const id of [heavy, mortar]) {
    const action = decide(id), gun = moduleOf(id, 'weapon');
    assert.deepEqual(action.aim, point); assert.equal(action.fire, true); assert.equal(action.componentId, gun.id);
    assert.equal(side.input(id, action, true), true);
  }
  // A mortar is given the charge its arc takes to the point, worked out once: the core lays a gun again at every step.
  const charge = decide(mortar).charge;
  assert(propellantCharges('m252').some(level => level.value === charge), `charge ${charge}`); assert.equal(decide(mortar).charge, charge);
  // Each gun is laid by an arc that falls on the place, not by the line of sight: a gun that fires direct by its low arc, a mortar by
  // its automatic one.
  assert.equal(decide(heavy).trajectory, 'low'); assert.equal(decide(mortar).trajectory, 'auto');
  assert.equal(squad.view().units[0].reason, 'bombarding');
  assert.deepEqual(squad.view().units[2].attack, { point }, 'what a page is told of the order is the place');
  assert.throws(() => squad.command({ order: 'bombard', ids: [heavy], point: { x: NaN, y: 0 } }), /Ponto de ataque inválido/);
  // A place where its own shells would burst near enough to harm it is not bombarded, and the vehicle says why.
  const beside = { x: at(mortar) + 6, y: ground.height(at(mortar) + 6) + 2 };
  squad.command({ order: 'bombard', ids: [mortar], point: beside });
  assert.equal(decide(mortar).fire, false); assert.equal(squad.view().units[2].reason, 'point-too-close');
});

test('a gun bombards by an arc its mount lets it take, and says so when no arc of it falls on the place', t => {
  // A howitzer's own arc is the low one, and this one, an M119 raised on the roof of its tower, stands upright with
  // thirty-four degrees to either side: it cannot sink to a low arc. Its automatic arc takes the high one, and it fires.
  const raised = createStructuredTemplate('howitzer', { preset: 'm119', highArc: true }),
    { world, ground, squad, side, own, enemies, at, decide, moduleOf } = commanded(t, { artillery: raised }), id = own[2], gun = moduleOf(id, 'weapon'),
    way = Math.sign(at(enemies[0]) - at(id)), place = x => ({ x, y: ground.height(x) + 2 }), point = place(at(id) + way * 3000);
  assert.deepEqual([gun.weaponPreset, gun.weaponMount.preset, gun.weaponMount.min, gun.weaponMount.max], ['m119', 'elevated-trunnion', -.6, .6]);
  squad.command({ order: 'bombard', ids: [id], point });
  const action = decide(id);
  assert.deepEqual([action.fire, action.trajectory, action.componentId], [true, 'auto', gun.id]);
  assert(Math.sin(firingSolution(gun, point, weaponSettings('howitzer', { preset: 'm119', trajectory: 'auto', charge: action.charge })).angle) > Math.SQRT1_2, 'laid high');
  assert(propellantCharges('m119').some(level => level.value === action.charge), `charge ${action.charge}`);
  assert.equal(squad.view().units[2].reason, 'bombarding');
  const shots = () => world.actor(id).stats.shots;
  for (let i = 0; i < 600 && !shots(); i++) { if (i % 6 === 0) side.input(id, decide(id), true); world.step(1 / 60); }
  assert.equal(shots(), 1, 'it fires');
  // A place no arc of the gun falls on: it holds its fire, turned that way, and says why.
  const far = place(point.x + way * 30000);
  squad.command({ order: 'bombard', ids: [id], point: far });
  const held = decide(id);
  assert.deepEqual([held.fire, held.componentId, held.trajectory, held.charge, held.aim], [false, gun.id, 'auto', undefined, far]);
  assert.deepEqual([squad.view().units[2].reason, squad.view().units[2].activity], ['point-out-of-reach', 'attacking']);
  assert.equal(side.input(id, held, true), true);
  // The place it could reach, again: the arc is worked out for the order given.
  squad.command({ order: 'bombard', ids: [id], point }); assert.deepEqual([decide(id).fire, decide(id).trajectory], [true, 'auto']);
});

test('bombardment holds for a blocking ally or the own vehicle and resumes when the core clears the line', t => {
  const { world, squad, own, enemies, at, decide } = commanded(t), id = own[2],
    point = { x: at(enemies[0]), y: 2 }, core = world.game(), call = core.call.bind(core);
  let blocked = 'ally';
  core.call = request => request.op === 'lineOfFire' ? blocked : call(request);
  squad.command({ order: 'bombard', ids: [id], point });
  for (const reason of ['ally', 'own']) {
    blocked = reason;
    assert.equal(decide(id).fire, false);
    assert.equal(squad.units.get(id).reason, reason + '-in-line');
  }
  blocked = null;
  assert.equal(decide(id).fire, true);
  assert.equal(squad.units.get(id).reason, 'bombarding');
});

test('with leave to fire, no order and nothing in its senses, a curved-fire gun answers the fire its base placed', t => {
  // The howitzer of the squad is its third vehicle. The enemy is within sight: here the core is made to answer as it
  // does when nothing is in a vehicle's senses, the enemy being where it is.
  const { room, world, squad, side, own, enemies, at, decide, moduleOf, damage } = commanded(t, { artillery: 'howitzer' }), [heavy, , id] = own,
    unit = squad.units.get(id), core = world.game(), call = core.call.bind(core),
    from = at(id), way = Math.sign(at(enemies[0]) - from), place = from + way * 3000,
    mark = (more = {}) => ({ id: 'battery:1', kind: 'battery', x: place, error: 60, at: 0, by: 'radar', ...more }),
    // One decision of a vehicle with its base holding these marks: the squad reads them once a round.
    turn = (marks, who = id) => { room.watch.marks = () => marks; squad.sampled = null; return decide(who); }, told = () => squad.view().units[2];
  let blockedLine = null;
  core.call = request => {
    const result = request.op === 'lineOfFire' && blockedLine ? blockedLine : call(request);
    return request.op !== 'scriptedDecision' ? result : { ...result, action: { ...result.action, throttle: 0, brake: 1, fire: false },
      contact: { ...result.contact, detected: false }, targetId: null, diagnostics: { ...result.diagnostics, reason: 'search-contact' } };
  };
  // Told to return fire and not hit, it holds: a mark is no leave to fire.
  assert.equal(turn([mark()]).fire, false); assert.equal(told().counter, null);
  squad.command({ order: 'stance', ids: [heavy, id], stance: 'fire' });
  const action = turn([mark()]), gun = moduleOf(id, 'weapon');
  assert.deepEqual([action.fire, action.trajectory, action.componentId, action.aim.x, action.throttle], [true, 'auto', gun.id, place, 0]);
  assert(propellantCharges('m119').some(level => level.value === action.charge), `charge ${action.charge}`);
  assert.deepEqual([told().counter, told().reason, told().activity, told().attack], [{ x: place }, 'bombarding', 'firing', null], 'what it answers is not an order');
  for (const blocked of ['ally', 'own']) {
    blockedLine = blocked;
    assert.equal(turn([mark()]).fire, false, 'counterfire obeys the same line check as an explicit order');
    assert.equal(told().reason, blocked + '-in-line');
  }
  blockedLine = null;
  assert.equal(turn([mark()]).fire, true, 'counterfire resumes when the ally moves away');
  // The heavy beside it has no gun made for it: it watches, free to fire as it is.
  assert.equal(turn([mark()], heavy).fire, false); assert.equal(squad.view().units[0].counter, null);
  // A place held too loosely is not worth the shells, and a base that places no guns asks for none.
  assert.equal(turn([mark({ error: COUNTER_ERROR + 1 })]).fire, false); assert.equal(told().counter, null); assert.equal(turn([mark({ error: COUNTER_ERROR })]).fire, true);
  assert.equal(turn([]).fire, false); assert.equal(unit.counters.size, 0, 'what it was laid on goes with the mark');
  // The place it is laid on stands while the mark is held within half of what it may be off by, and moves with it past that.
  turn([mark()]); const kept = unit.counter;
  turn([mark({ x: place + 25 })]); assert.equal(unit.counter, kept); assert.equal(turn([mark({ x: place + 25 })]).aim.x, place);
  assert.equal(turn([mark({ x: place + 40 })]).aim.x, place + 40); assert.notEqual(unit.counter, kept);
  // Of two guns it answers the nearer it has an arc to: one beyond the reach of its gun is left alone.
  const far = mark({ id: 'battery:2', x: from + way * 60000 }), nearer = mark({ id: 'battery:3', x: from + way * 2000 });
  assert.equal(turn([far]).fire, false); assert.equal(told().counter, null);
  assert.equal(turn([far, mark()]).aim.x, place); assert.equal(turn([mark(), nearer, far]).aim.x, nearer.x); assert.deepEqual([...unit.counters.keys()].sort(), ['battery:1', 'battery:2', 'battery:3']);
  // One placed where a friend stands is not answered: the shells would burst on the friend, harming nothing of it. The
  // next one is, its way clear.
  const stand = x => {
    const v = world.actor(heavy).vehicle, y = v.y - world.terrain.height(v.x) + world.terrain.height(x);
    core.call({ op: 'setVehicleState', actorId: heavy, state: { x, y, vx: 0, vy: 0 } }); world.step(1 / 60);
  }, stood = at(heavy);
  stand(nearer.x);
  assert.equal(turn([nearer]).fire, false); assert.equal(told().counter, null);
  const next = turn([nearer, mark()]);
  assert.deepEqual([next.fire, next.aim.x], [true, place]);
  stand(stood);
  // It fires: a shell leaves the gun for the place.
  const shots = () => world.actor(id).stats.shots;
  for (let i = 0; i < 600 && !shots(); i++) { if (i % 6 === 0) side.input(id, turn([mark()]), true); world.step(1 / 60); }
  assert.equal(shots(), 1);
  // An order comes first — to move, to bombard a place of the player's choosing — and so does the player's own hand.
  squad.command({ order: 'move', ids: [id], x: from + 40 }); turn([mark()]); assert.equal(told().counter, null);
  squad.command({ order: 'stop', ids: [id] }); assert.equal(turn([mark()]).fire, true);
  squad.command({ order: 'bombard', ids: [id], point: { x: place - way * 500, y: 2 } }); assert.equal(turn([mark()]).aim.x, place - way * 500); assert.equal(told().counter, null);
  squad.command({ order: 'stop', ids: [id] }); squad.command({ order: 'control', id }); assert.equal(turn([mark()]), null); assert.equal(squad.units.get(id).counter, null);
  squad.command({ order: 'control', id: null });
  // Told to return fire, it answers the placed gun for as long as it answers a hit; told to hold, never.
  squad.command({ order: 'stance', ids: [id], stance: 'return' }); unit.alertUntil = -Infinity; assert.equal(turn([mark()]).fire, false);
  damage(id); assert.equal(turn([mark()]).fire, true, 'hit, it fires back at where the fire comes from');
  squad.command({ order: 'stance', ids: [id], stance: 'hold' }); assert.equal(turn([mark()]).fire, false);
});

test('taking a vehicle over clears its orders, releases the one left and never obeys orders itself', t => {
  // The field reads the scene at its next step: the drive asked for is read here at once.
  const { world, squad, side, own, enemies, at, moduleOf, set } = commanded(t), read = () => world.game().call({ op: 'sync' });
  squad.command({ order: 'move', ids: own, x: at(own[0]) + 40 });
  squad.command({ order: 'control', id: own[0] });
  assert.equal(squad.view().manual, own[0]); assert.equal(squad.view().units[0].move, null); assert(squad.view().units[1].move);
  squad.command({ order: 'attack', ids: own, targetId: enemies[0] });
  assert.equal(squad.units.get(own[0]).attack, null, 'the vehicle in hand takes no order');
  side.input(own[0], { type: 'drive', throttle: 1, brake: 0 }); read();
  assert.equal(world.actor(own[0]).vehicle.throttle, 1);
  squad.command({ order: 'control', id: own[2] }); read();
  assert.equal(world.actor(own[0]).vehicle.throttle, 0); assert.equal(squad.manual, own[2]);
  assert.throws(() => squad.command({ order: 'control', id: enemies[0] }), /não pode ser controlado/);
  set(moduleOf(own[2], 'command'), { health: 0 }); world.step(1 / 60);
  assert.equal(squad.view().manual, null);
  assert.throws(() => squad.command({ order: 'control', id: own[2] }), /não pode ser controlado/);
});


test('the screen is in manual control only of the vehicle taken over', () => {
  const view = { mode: 'test' }, network = { enabled: true, connected: true, selected: 'a', manualActorId: null },
    state = manual => ({ shared: true, actors: [{ id: 'a' }, { id: 'b' }], controlledActor: manual, squad: { manual, units: [] } });
  assert.deepEqual([controlContext(view, state(null), network)].map(c => [c.actorId, c.manual, c.autopilot]), [[null, false, true]]);
  network.manualActorId = 'b';
  assert.deepEqual([controlContext(view, state('b'), network)].map(c => [c.actorId, c.manual, c.autopilot]), [['b', true, false]]);
  // A selected construction is not a control grant while metadata is absent.
  network.manualActorId = null;
  assert.deepEqual([controlContext(view, { shared: true, actors: [{ id: 'a' }] }, network)].map(c => [c.actorId, c.manual, c.autopilot]), [['a', false, false]]);
});

test('the mark of an order is drawn as far as the screen goes, however far off the place is', () => {
  const box = (a, b) => segmentInBox(a, b, 800, 450, 40), near = (cut, ends) => cut.every((p, i) => Math.abs(p.x - ends[i][0]) < 1e-9 && Math.abs(p.y - ends[i][1]) < 1e-9);
  // Both ends on the screen: the whole line.
  assert.deepEqual(box({ x: 100, y: 100 }, { x: 700, y: 300 }), [{ x: 100, y: 100 }, { x: 700, y: 300 }]);
  // A place ten kilometres off with the camera close on the gun: a hundred and eighty thousand pixels away, and
  // the line ends forty past the edge of the screen.
  assert(near(box({ x: 400, y: 200 }, { x: 180400, y: -1600 }), [[400, 200], [840, 195.6]]));
  // From a vehicle off one side to a place off the other: the stretch across the screen.
  assert(near(box({ x: -5000, y: 225 }, { x: 5000, y: 225 }), [[-40, 225], [840, 225]]));
  assert(near(box({ x: 10, y: -900 }, { x: 10, y: 900 }), [[10, -40], [10, 490]]));
  // Passing outside it, or wholly off one side: nothing is drawn.
  assert.equal(box({ x: -500, y: -500 }, { x: -100, y: 2000 }), null); assert.equal(box({ x: 900, y: 10 }, { x: 5000, y: 10 }), null);
  assert.deepEqual(box({ x: 5, y: 5 }, { x: 5, y: 5 }), [{ x: 5, y: 5 }, { x: 5, y: 5 }]);
});

// A field with fog as one player's squad has it, made by hand: what its side is told of the enemy (`foe`, `sighted`),
// and a core whose rule pilot answers what `decide` says to what it is asked, which is kept in `asked`.
function fogged({ actors, foe = () => true, sighted = () => false, decide }) {
  const asked = [], world = { time: 10, plates: [], modules: [], actor: id => actors[id] ?? null,
    game: () => ({ call: request => { asked.push(request); return decide(request); } }) };
  const field = { world, defeats: {}, arenaBounds: { minX: -10000, maxX: 10000 }, foe: id => foe(id), sighted: id => sighted(id), input() {}, batteries: [],
    get roster() { return Object.values(actors).map(a => ({ id: a.id, team: a.team, role: 'armor', pilot: 'player' })); } };
  const squad = new Squad(field), member = id => field.roster.find(m => m.id === id);
  return { squad, asked, world, member, decideFor: (id, round) => squad.decide(member(id), round) };
}
const vehicle = (id, team, x) => ({ id, team, x, vehicle: { x, vx: 0 }, aim: { x: x + 100, y: 3 } });
const watching = pilotDecision({ action: { throttle: 0, brake: 1, fire: false, aim: { x: 40, y: 1 }, componentId: 'none' },
  targetId: null, contact: { detected: false }, diagnostics: { reason: 'search-contact', nearestFreshContactDistance: null } });

test('on a field with fog an attack holds until the side sees its target out of the fight or gone, and one answer is given whatever became of it', () => {
  const actors = { a1: vehicle('a1', 'local', 0), a2: vehicle('a2', 'local', -50), b1: vehicle('b1', 'opponent', 900) };
  let held = true;
  const { squad, asked, world, decideFor } = fogged({ actors, foe: id => id === 'b1' && held, decide: () => watching });
  // The side holds b1, on its radar: it is a target, out of the fight or not — the squad goes by what the side is told.
  squad.command({ order: 'attack', ids: ['a1'], targetId: 'b1' });
  decideFor('a1', 1); assert.equal(asked.at(-1).targetId, 'b1');
  // b1 leaves the field unseen. The order stands; the pilot looks for it and finds nothing: the core is asked of a
  // vehicle of the side instead, which it never takes for an enemy.
  delete actors.b1; world.time = 11;
  decideFor('a1', 2);
  assert.equal(asked.at(-1).targetId, 'a2'); assert.deepEqual(squad.view().units.find(u => u.id === 'a1').attack, { targetId: 'b1' });
  assert.equal(squad.view().units.find(u => u.id === 'a1').activity, 'attacking');
  // With no other vehicle of the side the pilot decides alone, and holds its fire and its gun where it lies.
  delete actors.a2; world.time = 12;
  const alone = decideFor('a1', 3);
  assert.equal(asked.at(-1).targetId, undefined); assert.deepEqual([alone.fire, alone.targetId, alone.aim, alone.also], [false, null, { x: 100, y: 3 }, undefined]);
  // An attack on it is taken as on any other enemy the side holds.
  squad.command({ order: 'attack', ids: ['a1'], targetId: 'b1' });
  // The side sees it gone, or out of the fight: the order ends, and an order on it is refused.
  held = false; world.time = 13; decideFor('a1', 4);
  assert.equal(squad.view().units.find(u => u.id === 'a1').attack, null);
  assert.throws(() => squad.command({ order: 'attack', ids: ['a1'], targetId: 'b1' }), /Alvo inválido/);
});

test('a squad names the enemy its guns are on only while the side has it in sight or on radar, and of one only heard says the side', () => {
  const actors = { a1: vehicle('a1', 'local', 0), b1: vehicle('b1', 'opponent', 300) };
  let sighted = false, contact = null;
  const { squad, world, decideFor } = fogged({ actors, sighted: () => sighted, decide: () => ({ ...watching, targetId: 'b1', contact: { ...watching.contact, ...contact }, diagnostics: { ...watching.diagnostics,
      nearestFreshContactDistance: contact?.detected && contact.age < 1 ? Math.abs(contact.x - actors.a1.vehicle.x) : null } }) }), unit = () => squad.view().units[0],
    // Nothing in its senses at `time`, and then what it picked up.
    sense = (round, time, picked) => { contact = null; world.time = time; decideFor('a1', round); contact = picked; world.time = time + .5; decideFor('a1', round + .5); };
  // Picked up by ear: the side it is on, and no name.
  sense(1, 10, { detected: true, age: .1, x: 300, channel: 'sound' });
  assert.deepEqual([unit().heard, unit().targetId], [{ event: 'a1:10.5', side: 1, channel: 'sound' }, null]);
  // Seen by this vehicle alone, of a construction its side does not hold: the same.
  sense(2, 30, { detected: true, age: .1, x: -300, channel: 'visual' });
  assert.deepEqual([unit().heard, unit().targetId], [{ event: 'a1:30.5', side: -1, channel: 'visual' }, null]);
  // Held by the side: where it is, and which.
  sighted = true; sense(3, 50, { detected: true, age: .1, x: -300, channel: 'visual' });
  assert.deepEqual([unit().heard, unit().targetId], [{ event: 'a1:50.5', x: -300, channel: 'visual' }, 'b1']);
});
