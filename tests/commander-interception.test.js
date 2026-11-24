import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { FieldHost } from '../server/field-host.ts';
import { observeCommander } from '../server/commander-observation.ts';
import { INTERCEPTION_SECONDS } from '../server/commander-tactics.ts';
import { nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { STARTING_STOCK, BASE_RADIUS } from '../src/economy.ts';
import { FREE_FIRE_RADIUS } from '../src/squad.ts';

test('a prepared route interception moves physically, preserves a base guard and completes its bounded return', {
  timeout: 300000,
  skip: nativeDynamicsRuntime === 'native' ? false : 'The bounded route mission requires Native dynamics.',
}, t => {
  let seed = 1234;
  const room = new SharedRoom({ base: index => index ? 6000 : -4000, fog: true,
    random: () => (seed = seed * 16807 % 2147483647) / 2147483647 });
  t.after(() => room.world.dispose());
  const host = new FieldHost(room), bot = host.addCommander('Proteção de rota', 'balanced', '0011223344556677'),
    faction = room.factions.get(bot.factionId), baseX = faction.base.x,
    armed = playerId => room.owned(playerId).filter(actor => actor.vehicle && actor.blueprint.modules.some(part => part.kind === 'weapon'));
  assert.deepEqual(faction.stock, STARTING_STOCK);
  assert.equal(room.owned(bot.id).length, 3);
  // Declared preparation: a second scout and a tanker are bought at ordinary
  // prices during preparation. A working oil route is part of this fixture;
  // its existence must not depend on the opening's industrial priorities.
  const before = { ...faction.stock }, bought = host.command(bot.id, { type: 'spawn', blueprint: createConstruction('scout') });
  assert(bought.cost.ferro > 0 && bought.cost.combustivel > 0);
  for (const stock of Object.keys(STARTING_STOCK)) assert(Math.abs(before[stock] - faction.stock[stock] - bought.cost[stock]) < 1e-6);
  for (let tick = 0; tick < 30; tick++) host.step(() => 1); // Normal publication cooldown, with the controller active.
  const afterScout = { ...faction.stock }, oilCarrier = host.command(bot.id, { type: 'spawn', blueprint: createConstruction('tanker') });
  for (const stock of Object.keys(STARTING_STOCK)) assert(Math.abs(afterScout[stock] - faction.stock[stock] - oilCarrier.cost[stock]) < 1e-6);
  assert.equal(armed(bot.id).length, 2);
  const initialScouts = new Set(armed(bot.id).map(actor => actor.id)), initial = observeCommander(room, bot.id),
    oil = initial.deposits.find(site => site.material === 'petroleo');
  assert(oil && Math.abs(oil.x - baseX) > 1000 && Math.abs(oil.x - baseX) <= 3000);
  // A real scouting trip prepares known ground ahead of the working route.
  // Merely seeing an enemy above an unsurveyed slope cannot classify it as a
  // ground contact. The ordinary controller/economy continue during setup.
  const surveyor = initial.units.find(unit => initialScouts.has(unit.id) && unit.ready),
    surveyX = oil.x + Math.sign(oil.x - baseX) * 1000;
  assert(surveyor);
  host.command(bot.id, { type: 'squad', order: 'move', ids: [surveyor.id], x: surveyX });
  let surveyedAt = null, preparedAt = null, surveyTravel = 0;
  for (let tick = 0; tick < 900 * 60; tick++) {
    host.step(() => 1);
    if (tick % 60 !== 59) continue;
    const observation = observeCommander(room, bot.id), unit = observation.units.find(unit => unit.id === surveyor.id);
    assert(unit, 'the normal scout survives its peaceful reconnaissance');
    surveyTravel = Math.max(surveyTravel, Math.abs(unit.x - surveyor.x));
    if (surveyedAt === null && Math.abs(unit.x - surveyX) < 30) {
      surveyedAt = room.world.time;
      host.command(bot.id, { type: 'squad', order: 'home', ids: [unit.id] });
    }
    if (surveyedAt !== null && observation.units.filter(unit => initialScouts.has(unit.id)).every(unit =>
      unit.atBase && unit.atDepot && unit.ready && !unit.moving && !unit.home && unit.stance === 'fire' && unit.fuel >= unit.fuelCapacity * .5)) {
      preparedAt = room.world.time; break;
    }
  }
  assert(preparedAt !== null && surveyTravel > 2000, 'the scouts physically reconnoitre and return through normal base services');
  assert(room.explored(bot.factionId, surveyX), 'the route is known through the actual scouting trip');
  // Stage the arrival while strategic decisions are postponed. Otherwise a spare
  // scout can legitimately reconnoitre and disable this passive opponent far
  // away, so this would test an opening campaign rather than a prepared sortie.
  // Physics, automatic work, finite supplies and perception continue normally.
  // Leave the faction active: disabling its commander would correctly send
  // every worker Home, undoing the route we are preparing to protect.
  room.commanders.get(bot.id).nextAt = room.world.time + 1200;
  const other = host.join('Contato na rota'), enemy = armed(other.playerId)[0]; assert(enemy);
  assert.deepEqual(room.faction(room.players.get(other.playerId)).stock, STARTING_STOCK);
  assert.equal(room.knows(bot.factionId, enemy), null);
  // The opponent approaches the working route with its original finite kit.
  // Hold is a normal declared passive stance; neither health nor sensor data
  // is injected to produce a favorable firing solution.
  host.command(other.playerId, { type: 'squad', order: 'stance', ids: [enemy.id], stance: 'hold' });
  host.command(other.playerId, { type: 'squad', order: 'move', ids: [enemy.id], x: oil.x });
  let stagedContact = null;
  for (let tick = 0; tick < 900 * 60; tick++) {
    host.step(() => 1); host.tell([other.playerId]);
    if (tick % 60 !== 59) continue;
    const o = observeCommander(room, bot.id), contact = o.threats.find(threat => threat.kind === 'contact' &&
      threat.id === enemy.id && threat.grounded && Math.abs(threat.x - baseX) > 1800 &&
      Math.abs(threat.x - baseX) <= 3000 && Math.abs(threat.x - oil.x) <= 1000);
    if (contact) { stagedContact = { at: room.world.time, ...contact }; break; }
  }
  assert(stagedContact, 'the passive opponent physically reaches the known working route');
  // Assign a normal haul route. The tanker may already be extracting at its
  // destination; useful work there must not require continued movement.
  const tanker = observeCommander(room, bot.id).units.find(unit => unit.extracts.includes('petroleo')); assert(tanker);
  host.command(bot.id, { type: 'squad', order: 'haul', ids: [tanker.id], depositId: oil.id });
  const routeWorker = observeCommander(room, bot.id).units.find(unit => unit.id === tanker.id);
  assert.equal(routeWorker.haul?.depositId, oil.id, 'the ordinary command starts an actual oil route');
  assert(Math.abs(routeWorker.x - stagedContact.x) <= 1000, 'the real working tanker is near the current contact');
  room.commanders.get(bot.id).nextAt = room.world.time + 5;
  const scriptedBotCommands = host.lines.map(line => JSON.parse(line)).filter(row => row[1] === 'do' && row[2] === bot.id).length;
  const enemyHealth = () => room.world.modules.filter(part => part.actorId === enemy.id).reduce((sum, part) => sum + part.health, 0),
    initialHealth = enemyHealth(), actions = [], samples = [], missions = [], shots = new Map();
  let tracedAt = preparedAt, firstContact = null, minHealth = initialHealth, missingGuard = null;
  for (let tick = 0; tick < 900 * 60; tick++) {
    host.step(() => 1);
    const state = room.commanders.get(bot.id), trace = state.history.at(-1);
    if (trace && trace.at > tracedAt) {
      tracedAt = trace.at; actions.push(structuredClone(trace));
      if (trace.result === 'applied' && trace.action?.kind === 'intercept') {
        const observation = observeCommander(room, bot.id), order = state.orders[trace.action.unitId],
          candidate = observation.units.find(unit => unit.id === trace.action.unitId),
          guards = observation.units.filter(unit => initialScouts.has(unit.id) && unit.id !== candidate?.id && unit.atBase && unit.ready);
        const kept = JSON.parse(JSON.stringify(host.keep())), cold = new SharedRoom({ kept });
        let resumed;
        try {
          assert.deepEqual(cold.commanders.get(bot.id).orders[candidate.id], order, 'a real room save retains the accepted unit, target, waypoint and fixed deadline');
          assert.deepEqual(cold.factions.get(bot.factionId).stock, faction.stock, 'restoring a sortie grants no stock');
          assert.deepEqual(cold.world.actors.map(actor => actor.id).sort(), room.world.actors.map(actor => actor.id).sort(), 'restoring a sortie grants no extra kit');
          const coldHost = new FieldHost(cold, { diary: false }), time = cold.world.time;
          for (let tick = 0; tick < 60; tick++) coldHost.step(() => 1);
          assert.equal(cold.commanders.get(bot.id).orders[candidate.id].until, order.until, 'a few resumed physical steps do not renew the mission timer');
          resumed = { at: time, steppedTo: cold.world.time, order: structuredClone(cold.commanders.get(bot.id).orders[candidate.id]) };
        } finally { cold.world.dispose(); }
        missions.push({ at: trace.at, action: { ...trace.action }, order: structuredClone(order), candidate, resumed,
          guardIds: guards.map(unit => unit.id), contact: observation.threats.find(threat => threat.kind === 'contact' && threat.id === trace.action.targetId),
          maxDistance: Math.abs(candidate.x - baseX), maxTravel: 0, returnedAt: null, endedAt: null, endContact: null, attackAt: null });
      }
      for (const mission of missions) if (trace.result === 'applied' && trace.action?.unitId === mission.action.unitId && trace.at >= mission.at) {
        if (trace.action.kind === 'home' && mission.endedAt === null) {
          mission.endedAt = trace.at;
          mission.endContact = observeCommander(room, bot.id).threats.find(threat => threat.kind === 'contact' && threat.id === mission.action.targetId) ?? null;
        }
        if (trace.action.kind === 'attack') mission.attackAt ??= trace.at;
      }
    }
    if (tick % 60 !== 59) continue;
    const observation = observeCommander(room, bot.id), contact = observation.threats.find(threat => threat.kind === 'contact' && threat.id === enemy.id);
    if (contact) firstContact ??= { time: room.world.time, ...contact };
    minHealth = Math.min(minHealth, enemyHealth());
    for (const actor of armed(bot.id)) shots.set(actor.id, Math.max(shots.get(actor.id) ?? 0, actor.stats.shots));
    for (const mission of missions) {
      const unit = observation.units.find(unit => unit.id === mission.action.unitId);
      if (!unit) continue;
      if (mission.returnedAt === null) {
        mission.maxDistance = Math.max(mission.maxDistance, Math.abs(unit.x - baseX));
        mission.maxTravel = Math.max(mission.maxTravel, Math.abs(unit.x - mission.candidate.x));
        if (!observation.units.some(guard => mission.guardIds.includes(guard.id) && guard.atBase))
          missingGuard ??= { time: room.world.time, mission: mission.action.unitId, units: observation.units };
      }
      if (mission.endedAt !== null && unit.atBase && !unit.moving) mission.returnedAt ??= room.world.time;
    }
    if (tick % (20 * 60) === 20 * 60 - 1) samples.push({ time: room.world.time,
      enemyX: room.world.actor(enemy.id)?.vehicle?.x, contact, enemyHealth: enemyHealth(),
      units: observation.units.map(unit => ({ id: unit.id, x: unit.x, atBase: unit.atBase, moving: unit.moving,
        home: unit.home, health: unit.health, fuel: unit.fuel, ammo: unit.ammoRatio, attack: unit.attack, halt: unit.halt })),
      orders: structuredClone(state.orders), reason: trace?.reason });
    host.tell([other.playerId]);
    if (missions.some(mission => mission.returnedAt !== null && mission.maxTravel > FREE_FIRE_RADIUS + 30)) break;
  }
  const summary = { setup: { baseX, enemyBase: other.base.x, extraScoutCost: bought.cost, tankerCost: oilCarrier.cost, targetSite: oil.id, targetX: oil.x,
      surveyX, surveyedAt, preparedAt, surveyTravel, stagedContact,
      preparation: 'Paid scout/tanker, actual reconnaissance/Home, then postponed the strategic clock during the passive opponent approach while retaining active presence; all battle decisions are autonomous.' },
    firstContact, initialHealth, minHealth, shots: [...shots], missions, missingGuard, actions, samples, faults: [...room.faults] };
  t.diagnostic(JSON.stringify(summary));
  assert(firstContact, 'the route threat is acquired by real faction perception');
  assert(missions.length > 0, 'the controller launches a bounded route mission');
  const mission = missions.find(mission => mission.returnedAt !== null && mission.maxTravel > FREE_FIRE_RADIUS + 30);
  assert(mission, 'a military vehicle physically leaves local free fire and completes its return');
  assert(mission.contact && mission.contact.id === enemy.id && mission.contact.grounded, 'the launch names a current identified ground contact');
  assert(mission.guardIds.length > 0, 'a prepared original scout is kept at the base');
  assert.equal(missingGuard, null, 'the designated guard stays at the base throughout the sortie and return');
  assert(mission.maxDistance <= 3000 + BASE_RADIUS, 'the physical sortie remains near the declared base region');
  assert(mission.endedAt <= mission.at + INTERCEPTION_SECONDS + 5.1, 'an ordinary Home order terminates the sortie within its fixed deadline');
  assert.notEqual(room.commanders.get(bot.id).orders[mission.action.unitId]?.kind, 'intercept', 'the actual Home command retires the military intention');
  assert.equal(room.faults.size, 0, [...room.faults].join('\n'));
  assert.equal(room.factions.get(bot.factionId).base.x, baseX);
  assert.equal(host.lines.map(line => JSON.parse(line)).filter(row => row[1] === 'do' && row[2] === bot.id).length, scriptedBotCommands,
    'after the declared preparation only the controller commands the faction');
});
