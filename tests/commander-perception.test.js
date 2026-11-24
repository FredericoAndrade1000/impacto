import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { observeCommander } from '../server/commander-observation.ts';
import { chooseCommanderAction } from '../server/commander-policy.ts';
import { BaseWatch } from '../server/base-watch.ts';
import { packShots } from '../src/shots.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { isDefender } from '../server/commander-units.ts';
import { constructionSite } from '../server/field-construction.ts';
import { chooseGroundOperation } from '../server/commander-operations.ts';
import { newCommanderState } from '../server/faction-commander.ts';
import { commanderBlueprint } from '../server/commander-designs.ts';

const STEADY = { pace: () => 1 };

test('the protected cannon quote is admitted at Workshop I and charged from the exact execution blueprint', t => {
  const room = new SharedRoom({ industry: { workshop: 1, hangar: 0, processing: 1 } });
  t.after(() => room.world.dispose());
  const bot = room.addCommander('Oficina'), o = observeCommander(room, bot.id),
    offer = o.offers.find(row => row.model === 'scout-20mm');
  assert(offer); assert(offer.cost.ferro > o.offers.find(row => row.model === 'scout').cost.ferro);
  room.command(bot.id, { type: 'spawn', blueprint: commanderBlueprint('scout-20mm') });
  const stock = room.factions.get(bot.factionId).stock;
  for (const id of ['ferro', 'ligas', 'silica', 'combustivel']) assert.equal(stock[id], o.stock[id] - offer.cost[id]);
  const actor = room.owned(bot.id).find(actor => !o.units.some(unit => unit.id === actor.id));
  assert(actor.blueprint.modules.some(part => part.weaponPreset === 'rh202'));
});

test('normally paid ground units expose enough native mobility to budget a distant expedition', t => {
  const room = new SharedRoom({ industry: { workshop: 1, hangar: 0, processing: 1 } });
  t.after(() => room.world.dispose());
  const { playerId } = room.join('Preparação de campanha');
  for (let i = 0; i < 2; i++) {
    room.command(playerId, { type: 'spawn', blueprint: createConstruction('scout') });
    for (let step = 0; step < 70 * 60; step++) room.step(STEADY);
  }
  const units = observeCommander(room, playerId).units.filter(isDefender);
  assert.equal(units.length, 3);
  room.command(playerId, { type: 'squad', order: 'stance', ids: units.map(unit => unit.id), stance: 'fire' });
  const observation = observeCommander(room, playerId), base = observation.base.x, target = base + 8000,
    state = newCommanderState('balanced', room.world.time);
  for (const unit of observation.units.filter(isDefender)) {
    assert(unit.mobility?.speed > 0 && unit.mobility.range > 16000, 'ordinary native drivetrain telemetry is usable by planning');
  }
  // A synthetic already-surveyed objective isolates departure budgeting from
  // enemy perception; no hidden actor or terrain data supplies that objective.
  observation.bases = [{ id: 'surveyed-objective', x: target, radius: 100, seen: false, at: 0, sheltered: false }];
  observation.explored = [[base - 100, target + 100]];
  state.operation = chooseGroundOperation(observation, state, true)?.operation ?? null;
  assert.equal(state.operation?.phase, 'prepare');
  assert.equal(chooseGroundOperation(observation, state, true)?.operation?.phase, 'gather');
});

test('fixed offers use public placement rules and can reach a usable deposit beyond refused nearer sites', t => {
  const room = new SharedRoom({ base: n => n ? -1800 : 1800, fog: false,
    industry: { workshop: 2, hangar: 0, processing: 1 } });
  t.after(() => room.world.dispose());
  const bot = room.addCommander('Comandante', 'balanced'); room.join('Outra facção');
  const faction = room.factions.get(bot.factionId), stock = { ...faction.stock },
    observation = observeCommander(room, bot.id), offers = observation.offers.filter(offer => offer.x !== undefined);
  assert(offers.some(offer => offer.model === 'mining-site'), 'known usable ground still offers a mining site');
  for (const offer of offers) assert.doesNotThrow(() =>
    constructionSite(room, faction, createConstruction(offer.model), offer.x, offer.facing),
  'the same public territory, footprint and spacing rules apply before proposing the work');
  const nearer = observation.deposits.filter(site => site.material !== 'petroleo')
    .sort((a, b) => Math.abs(a.x - faction.base.x) - Math.abs(b.x - faction.base.x)).slice(0, 2);
  assert(offers.some(offer => offer.model === 'mining-site' && nearer.every(site => Math.abs(site.x - offer.x) > 20)),
    'unusable nearer proposals do not hide a farther known alternative');
  assert.deepEqual(faction.stock, stock); assert.equal(room.works.of(faction.id).length, 0);
});

test('counter-battery observation contains only the published anonymous ground fixes', t => {
  const { room, bot, enemy, put } = field(t), base = room.factions.get(bot.factionId).base.x;
  assert.equal(room.knows(bot.factionId, enemy), null);
  // Authored sensor input tests the observation boundary, not projectile physics.
  room.watch = new BaseWatch();
  room.watch.look({ time: room.world.time, terrain: { height: () => 0 }, bases: [{ team: bot.factionId, x: base, y: 0 }],
    teamOf: () => enemy.team, shots: packShots([{ number: 1, actorId: enemy.id, weapon: 'cannon', preset: 'm119',
      x: base + 1800, y: 6.5, vx: -300, vy: 50, age: .1 }]) });
  const publicMarks = room.players.get(bot.id).squad.side.batteries, before = observeCommander(room, bot.id).batteries;
  assert.equal(before.length, 1);
  assert.deepEqual(before, publicMarks.map(({ x, error, at }) => ({ x, error, at })));
  assert(!JSON.stringify(before).includes(enemy.id), 'a report is not an enemy identity or blueprint');
  put(enemy, 18000);
  assert.deepEqual(observeCommander(room, bot.id).batteries, before, 'hidden movement cannot update the measured firing place');
});

test('the owned capture warning survives missing enemy perception without exposing a hidden actor', t => {
  const { room, bot, other, enemy } = field(t), faction = room.factions.get(bot.factionId);
  assert.equal(room.knows(bot.factionId, enemy), null);
  assert.equal(observeCommander(room, bot.id).besieged, false);
  faction.capture = { by: room.players.get(other.playerId).factionId, at: room.world.time, progress: 20, state: 'advancing' };
  assert(room.factionView(bot.id).siege, 'the warning is already part of the normal faction interface');
  const before = room.digest(), o = observeCommander(room, bot.id);
  assert.equal(o.besieged, true);
  assert.equal(room.knows(bot.factionId, enemy), null, 'capture notification grants no contact or target identity');
  assert.deepEqual(room.digest(), before, 'observation does not change the field or its resources');
  faction.capture = null;
  assert.equal(observeCommander(room, bot.id).besieged, false, 'a cleared warning is not retained in another timer');
});

test('an admitted paid mortar remains artillery during construction and cannot stand in for a direct guard', t => {
  const room = new SharedRoom({ industry: { workshop: 2, hangar: 0, processing: 1 } });
  t.after(() => room.world.dispose());
  const bot = room.addCommander('Comandante', 'balanced'), before = observeCommander(room, bot.id),
    offer = before.offers.find(item => item.model === 'mortar');
  assert(offer);
  assert(offer.artilleryRange > 3600 && offer.artilleryRange < 6000,
    'the admitted mortar quote includes its Native ballistic reach beyond the former 3 km strategic cutoff');
  room.command(bot.id, { type: 'spawn', blueprint: createConstruction('mortar') });
  const added = observeCommander(room, bot.id).units.find(unit => !before.units.some(old => old.id === unit.id));
  assert(added?.artillery && added.armed && !added.ready);
  assert.equal(isDefender(added), false);
  const stock = room.factions.get(bot.factionId).stock;
  for (const material of ['ferro', 'ligas', 'silica', 'combustivel']) assert.equal(stock[material], before.stock[material] - offer.cost[material]);
});
function field(t) {
  const room = new SharedRoom({ base: n => n ? 15000 : -15000, random: () => .5 });
  t.after(() => room.world.dispose());
  const bot = room.addCommander('Comandante', 'balanced', '0011223344556677'),
    other = room.join('Outra facção', '', null, '8899aabbccddeeff'),
    enemy = room.owned(other.playerId).find(actor => actor.blueprint.modules.some(piece => piece.kind === 'weapon'));
  assert(enemy);
  const put = (actor, x, advance = false) => {
    const vehicle = room.world.actor(actor.id).vehicle; assert(vehicle);
    room.world.command('setVehicleState', { actorId: actor.id, state: {
      x, y: vehicle.y - room.world.terrain.height(vehicle.x) + room.world.terrain.height(x), vx: 0, vy: 0,
    } });
    if (advance) room.world.step(); // Native perception is refreshed on a physical frame.
    room.sight(room.steps, true);
  };
  return { room, bot, other, enemy, put };
}

test('commander observation and choice ignore hidden enemy movement and unobserved geological state', t => {
  const { room, bot, enemy, put } = field(t), faction = room.factions.get(bot.factionId),
    hidden = room.deposits.find(site => !faction.veins.has(site.id) && Math.abs(site.x - faction.base.x) > 6000);
  assert(hidden); room.sight();
  assert.equal(room.knows(bot.factionId, enemy), null);
  const before = observeCommander(room, bot.id), untouchedObservation = structuredClone(before),
    state = structuredClone(room.commanders.get(bot.id)), untouched = structuredClone(state),
    choice = chooseCommanderAction(before, state);
  assert.deepEqual(before, untouchedObservation, 'planning cannot spend or reorder the observed world');
  put(enemy, enemy.vehicle.x + 1200);
  room.veins.set(hidden.id, 0); room.extracted.set(hidden.id, 250);
  const after = observeCommander(room, bot.id);
  assert.deepEqual(after, before, 'hidden truth is absent from strategic observations');
  assert.deepEqual(chooseCommanderAction(after, state), choice);
  assert.deepEqual(state, untouched, 'choosing an action does not mutate strategic memory');
  assert(!JSON.stringify(after).includes(hidden.id));
  assert(after.units.every(unit => room.world.actor(unit.id).team === bot.factionId));
});

test('a lost visual contact cannot move the commander threat to an enemy new hidden position', t => {
  const { room, bot, enemy, put } = field(t), base = room.factions.get(bot.factionId).base.x;
  put(enemy, base + 100, true);
  assert.equal(room.knows(bot.factionId, enemy), 'seen', 'the scripted raider is in the real base view');
  const seen = observeCommander(room, bot.id);
  assert(seen.threats.some(threat => Math.abs(threat.x - enemy.vehicle.x) < 30));
  const hiddenX = 15000; put(enemy, hiddenX, true);
  assert.notEqual(room.knows(bot.factionId, enemy), 'seen');
  const hidden = observeCommander(room, bot.id);
  assert(hidden.threats.every(threat => Math.abs(threat.x - hiddenX) > 1000), 'a retained threat is at its observed place, never the new true position');
});

test('a commander does not repeat an existing haul or undo a confirmed worker threat interruption', t => {
  const { room, bot } = field(t), calls = [], command = room.command.bind(room);
  room.command = (playerId, input, draw) => {
    if (playerId === bot.id) calls.push({ time: room.world.time, input: structuredClone(input) });
    return command(playerId, input, draw);
  };
  for (let tick = 0; tick < 30 * 60 && !calls.some(call => call.input.type === 'squad' && call.input.order === 'haul'); tick++) room.step(STEADY);
  const first = calls.find(call => call.input.type === 'squad' && call.input.order === 'haul'); assert(first, 'the real initial kit receives a collection order');
  const minerId = first.input.ids[0], depositId = first.input.depositId;
  for (let tick = 0; tick < 8 * 60; tick++) room.step(STEADY);
  assert.equal(calls.filter(call => call.input.order === 'haul' && call.input.ids?.includes(minerId) && call.input.depositId === depositId).length, 1,
    'an already assigned haul is not restarted');
  // Seed the already-confirmed Squad interruption. Actual sensing/retreat is
  // covered by haul-retreat; here even a lost contact must not reset the order.
  const unit = room.players.get(bot.id).squad.units.get(minerId); assert(unit);
  unit.haul = null; unit.move = null; unit.halt = 'enemy-near';
  const interruptedAt = room.world.time;
  for (let tick = 0; tick < 20 * 60; tick++) room.step(STEADY);
  assert(!calls.some(call => call.time > interruptedAt && call.input.order === 'haul' && call.input.ids?.includes(minerId) && call.input.depositId === depositId),
    'the commander does not countermand local threat handling with another ore run');
  assert.equal(room.faults.size, 0);
});
