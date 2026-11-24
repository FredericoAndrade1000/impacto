import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { observeCommander } from '../server/commander-observation.ts';
import { stepCommanders } from '../server/faction-commander.ts';
import { bill, billSum, STOCK_IDS } from '../src/economy.ts';
import { FULL_INDUSTRY } from '../src/industry.ts';
import { onField } from './helpers/field.js';

test('the commander cancels a light depot repair through the ordinary refund and resumes its saved intention with ordinary payment', t => {
  const room = new SharedRoom({ stock: bill(400000, 10000, 10000, 4000), industry: FULL_INDUSTRY,
    starter: false, build: false, fog: false, base: () => -1000 }), f = onField(t, room),
    bot = room.addCommander('Manutenção');
  room.commanders.get(bot.id)!.nextAt = 600;
  const guard = f.publish(bot, 'scout'); f.publish(bot, 'mining-truck');
  f.order(bot, 'control', { id: null }); f.order(bot, 'stance', { ids: [guard], stance: 'fire' });
  f.run(2);
  const engine = f.parts(guard, 'engine')[0]!;
  f.set(engine, { health: engine.maxHealth * .9 });
  assert(f.until(() => room.records.get(guard)?.service?.kind === 'repair', 180), 'ordinary base service must actually start');
  const paid = room.records.get(guard)!.service!; assert.equal(paid.kind, 'repair');
  if (paid.kind !== 'repair') throw new Error('Expected ordinary repair');
  const health = room.world.modules.find(part => part.id === engine.id)!.health,
    faction = room.factions.get(bot.factionId)!;
  Object.assign(faction.stock, bill(500, 10000, 10000, 3000));
  const before = { ...faction.stock }, refund = { ...paid.cost }, state = room.commanders.get(bot.id)!;
  state.enabled = true; state.nextAt = room.world.time;
  stepCommanders(room);
  assert.equal(state.history.at(-1)!.action!.kind, 'cancel-repair');
  assert.deepEqual(faction.stock, billSum(before, refund));
  assert.equal(room.world.modules.find(part => part.id === engine.id)!.health, health, 'cancellation repairs nothing');
  assert.deepEqual(state.deferredRepairs, [guard]);
  const kept = room.keep(), cold = new SharedRoom({ kept });
  try {
    const restored = cold.commanders.get(bot.id)!;
    assert.deepEqual(restored.deferredRepairs, [guard]);
    const view = observeCommander(cold, bot.id).units.find(unit => unit.id === guard)!;
    assert.equal(view.maintenance?.phase, 'declined');
    assert.equal(view.maintenance?.critical, false);
    const stock = cold.factions.get(bot.factionId)!.stock;
    Object.assign(stock, bill(400000, 10000, 10000, 4000));
    const available = { ...stock }, quote = view.maintenance!.cost;
    restored.nextAt = cold.world.time;
    stepCommanders(cold);
    assert.equal(restored.history.at(-1)!.action!.kind, 'repair');
    assert.deepEqual(restored.deferredRepairs, []);
    assert.equal(cold.records.get(guard)!.service?.kind, 'repair');
    for (const id of STOCK_IDS) assert.equal(stock[id], available[id] - quote[id]);
  } finally { cold.world.dispose(); }
});

test('ordinary dismantling of an idle constructor funds an admitted replacement miner and preserves the last armed guard', t => {
  const room = new SharedRoom({ stock: bill(400000, 10000, 10000, 4000), industry: FULL_INDUSTRY,
    starter: false, build: false, fog: false, base: () => -1000 }), f = onField(t, room),
    bot = room.addCommander('Reposição');
  room.commanders.get(bot.id)!.nextAt = 600;
  const guard = f.publish(bot, 'scout'), builder = f.publish(bot, 'construction-truck');
  f.order(bot, 'control', { id: null }); f.order(bot, 'stance', { ids: [guard], stance: 'fire' });
  f.run(2);
  const faction = room.factions.get(bot.factionId)!;
  Object.assign(faction.stock, bill(1000, 10000, 10000, 3000));
  const observation = observeCommander(room, bot.id), value = observation.units.find(unit => unit.id === builder)!.salvage,
    minerPrice = observation.offers.find(offer => offer.model === 'mining-truck')!.cost,
    state = room.commanders.get(bot.id)!;
  state.enabled = true; state.nextAt = room.world.time;
  stepCommanders(room);
  assert.deepEqual(state.history.at(-1)!.action, { kind: 'dismantle', unitId: builder });
  assert(!room.world.actor(builder)); assert(room.world.actor(guard));
  assert(faction.stock.ferro >= 1000 + value.ferro, 'only the normal residual value is available');
  const beforePurchase = { ...faction.stock };
  state.nextAt = room.world.time; stepCommanders(room);
  assert.deepEqual(state.history.at(-1)!.action, { kind: 'manufacture', model: 'mining-truck' });
  assert.equal(room.owned(bot.id).length, 2);
  for (const id of STOCK_IDS) assert.equal(faction.stock[id], beforePurchase[id] - minerPrice[id]);
});
