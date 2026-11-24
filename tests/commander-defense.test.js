import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { FieldHost } from '../server/field-host.ts';
import { observeCommander } from '../server/commander-observation.ts';
import { nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import { FREE_FIRE_RADIUS } from '../src/squad.ts';
import { STARTING_STOCK, BASE_RADIUS } from '../src/economy.ts';

test('an active commander defends its base against a normally driven, perceived raider', {
  timeout: 120000,
  skip: nativeDynamicsRuntime === 'native' ? false : 'The full defense scenario requires Native dynamics.',
}, t => {
  const room = new SharedRoom({ base: index => index ? 1200 : -1200, fog: true, random: () => .5 });
  t.after(() => room.world.dispose());
  const host = new FieldHost(room, { diary: false }),
    bot = host.addCommander('Defensora', 'balanced', '0011223344556677'),
    raider = host.join('Incursora'), owner = room.players.get(bot.id),
    faction = room.factions.get(bot.factionId), baseX = faction.base.x,
    armed = playerId => room.owned(playerId).filter(actor => actor.vehicle && actor.blueprint.modules.some(part => part.kind === 'weapon')),
    defender = armed(bot.id)[0], invader = armed(raider.playerId)[0];
  assert(defender && invader, 'both ordinary starting kits include an armed scout');
  assert.deepEqual(faction.stock, STARTING_STOCK);
  assert.deepEqual(room.faction(room.players.get(raider.playerId)).stock, STARTING_STOCK);
  assert.equal(owner.connected, false, 'the commander does not need a fabricated socket');
  assert.equal(room.manned(faction), true, 'the commander has genuine active presence');
  assert.equal(room.knows(bot.factionId, invader), null, 'the distant raider starts outside faction knowledge');

  // Only normal commands move the granted raider across the terrain. Its
  // finite fuel, ammunition, health and spawn placement are never replaced.
  host.command(raider.playerId, { type: 'squad', order: 'stance', ids: [invader.id], stance: 'fire' });
  host.command(raider.playerId, { type: 'squad', order: 'move', ids: [invader.id], x: baseX + 60 });
  const initialInvaderX = room.position(invader), health = () => room.world.modules
    .filter(part => part.actorId === invader.id).reduce((sum, part) => sum + part.health, 0),
    initialHealth = health(), shots = new Map(), responded = new Set(), responders = new Map(), samples = [], maintenance = [];
  let firstSeen = null, firstResponse = null, positionedAt = null, minHealth = initialHealth, nearest = Infinity, maxDefensePursuit = 0;
  for (let tick = 0; tick < 600 * 60; tick++) {
    host.step(() => 1);
    if (tick % 60 !== 59) continue;
    const trace = room.commanders.get(bot.id).history.at(-1);
    if (trace?.result === 'applied' && trace.at > (maintenance.at(-1)?.at ?? -1) &&
      ['home', 'cancel-repair'].includes(trace.action?.kind)) {
      const unit = observeCommander(room, bot.id).units.find(unit => unit.id === trace.action.unitId);
      maintenance.push({ ...trace, unit });
    }
    const actor = room.world.actor(invader.id), knowledge = actor && room.knows(bot.factionId, actor);
    if (knowledge === 'seen' || knowledge === 'radar') firstSeen ??= room.world.time;
    positionedAt ??= room.commanders.get(bot.id).history.find(row => row.result === 'applied' && row.action?.kind === 'defend')?.at ?? null;
    if (actor) { minHealth = Math.min(minHealth, health()); nearest = Math.min(nearest, Math.abs(room.position(actor) - baseX)); }
    for (const actor of room.owned(bot.id)) {
      const previous = shots.get(actor.id) ?? 0;
      if (firstSeen !== null && actor.stats.shots > previous) {
        firstResponse ??= room.world.time;
        responded.add(actor.id);
      }
      // A legitimate Return-fire response can precede the strategic stance
      // order. Keep that responder and record its anchor when assigned.
      const order = owner.squad.units.get(actor.id), anchor = order?.fireAt;
      if (responded.has(actor.id) && actor.vehicle && Number.isFinite(anchor) && !responders.has(actor.id)) responders.set(actor.id, anchor);
      shots.set(actor.id, Math.max(previous, actor.stats.shots));
      // The same defender can later receive a normal Move to salvage a wreck.
      // Measure autonomous pursuit from its current fire anchor, rather than
      // treating every later strategic journey as pursuit from the first one.
      if (responders.has(actor.id) && !room.outOfAction()[actor.id] && Number.isFinite(anchor) &&
        (!order.move || order.move.purpose === 'fire'))
        maxDefensePursuit = Math.max(maxDefensePursuit, Math.abs(room.position(actor) - anchor));
    }
    if (tick % (60 * 60) === 60 * 60 - 1) samples.push({
      time: room.world.time, x: actor ? room.position(actor) : null, knowledge,
      shots: [...shots.values()].reduce((sum, count) => sum + count, 0), health: actor ? health() : null,
    });
    // Exercise ordinary publication/event draining without changing perception
    // or issuing any commands to the defending faction.
    host.tell([raider.playerId]);
  }
  const summary = { firstSeen, firstResponse, nearest, initialInvaderX, initialHealth, minHealth, maxDefensePursuit,
    responders: [...responders],
    shots: [...shots.values()].reduce((sum, count) => sum + count, 0), samples,
    history: room.commanders.get(bot.id).history, maintenance };
  t.diagnostic(JSON.stringify(summary));
  assert(firstSeen !== null, 'the normal approach actually enters current faction perception');
  assert(nearest < 1000 && initialInvaderX - baseX > 2000, 'the invader physically approaches the base and can be stopped before reaching it');
  assert(firstResponse !== null && summary.shots > 0, 'the autonomous faction fires after perceiving the invader');
  assert(positionedAt !== null && positionedAt < firstResponse, 'the guard physically repositions before it has a firing solution');
  assert(minHealth < initialHealth, 'the normal defensive fire actually damages the invader');
  assert([...responders.values()].some(anchor => Math.abs(anchor - baseX) <= BASE_RADIUS), 'an actual responding vehicle is anchored at the base');
  assert(maxDefensePursuit <= FREE_FIRE_RADIUS + 20, 'autonomous pursuit stays within the current normal fire region; strategic moves are separate');
  assert.equal(room.commanders.get(bot.id).enabled, true);
  assert.equal(room.manned(faction), true);
  assert.equal(faction.shelter, null, 'a live commander receives no offline protection');
  assert(!maintenance.some(row => row.action.kind === 'cancel-repair' && row.unit?.auto),
    'budgeting must not repeatedly release an automatic worker back into the same repair and retreat cycle');
  assert.equal(room.faults.size, 0, [...room.faults].join('\n'));
});
