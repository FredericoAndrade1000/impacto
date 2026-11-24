import test from 'node:test';
import assert from 'node:assert/strict';
import { BASIC_INDUSTRY, FULL_INDUSTRY, industrialAdmission, missingIndustry } from '../src/industry.ts';
import { newIndustry, startUpgrade, cancelUpgrade, advanceIndustry, liquidateIndustry, validateIndustry } from '../server/industry.ts';
import { compileDraft } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { bill, billSum, STOCK_IDS } from '../src/economy.ts';
import { rehearsal, SharedRoom } from '../server/room.ts';
import { onField } from './helpers/field.js';
import { aircraft } from './helpers/aircraft.js';

const admission = source => { const result = compileDraft(source); return industrialAdmission(result.construction, result.compiled); };
test('basic industry admits the economic loop, roads, posts and basic counters; heavy families require an upgrade', () => {
  for (const id of ['mining-truck', 'construction-truck', 'truck', 'supply', 'tanker', 'grader', 'paver', 'scout', 'mortar', 'guard-post', 'outpost', 'mining-site', 'oil-well']) {
    const decision = admission(createStructuredTemplate(id));
    assert.equal(decision.oversized, null, id); assert.deepEqual(missingIndustry(decision, BASIC_INDUSTRY), [], id);
  }
  assert(missingIndustry(admission(createStructuredTemplate('heavy')), BASIC_INDUSTRY).some(need => need.facility === 'workshop' && need.level === 3));
  const defaults = createStructuredTemplate('heavy'); delete defaults.components.find(part => part.kind === 'weapon').weaponPreset;
  assert.deepEqual(admission(defaults).requirements, admission(createStructuredTemplate('heavy')).requirements, 'omitted presets are canonicalized by Native');
  const ammo = createStructuredTemplate('scout'); ammo.components.find(part => part.kind === 'ammo').ammoPreset = 'm777';
  assert(admission(ammo).requirements.some(need => need.facility === 'workshop' && need.level === 3), 'ammunition cannot bypass the heavy family');
});
test('aircraft use the hangar envelope and intrinsic turbine metal, while authored material choices require processing', () => {
  const source = aircraft(), decision = admission(source);
  assert.deepEqual(missingIndustry(decision, BASIC_INDUSTRY), [{ facility: 'hangar', level: 1 }]);
  assert.deepEqual(missingIndustry(decision, { ...BASIC_INDUSTRY, hangar: 1 }), []);
  source.components.find(part => part.kind === 'engine').metal = 'titanium';
  assert(missingIndustry(admission(source), { ...BASIC_INDUSTRY, hangar: 1 }).some(need => need.facility === 'processing' && need.level === 3));
  const renamed = structuredClone(source); renamed.name = 'Básico gratuito';
  assert.deepEqual(admission(renamed).requirements, admission(source).requirements);
});
test('the server uses Native dry mass and material dimensions, including fixed designs, instead of payload or labels', () => {
  const source = createStructuredTemplate('scout'), compiled = compileDraft(source), measured = compiled.compiled.manufacturing;
  const larger = industrialAdmission(compiled.construction, { manufacturing: { ...measured, emptyKg: 20000.1 } });
  assert(larger.requirements.some(need => need.facility === 'workshop' && need.level === 2));
  const outside = industrialAdmission(compiled.construction, { manufacturing: { ...measured, envelope: { lengthM: 18.1, heightM: 2 } } });
  assert.equal(outside.oversized, 'workshop');
  assert(admission(createStructuredTemplate('mining-site')).measurement.emptyKg > 0);
});
test('payment, repeats, competing upgrades and cancellation conserve faction stock, with stale cancels harmless', () => {
  const state = newIndustry(), stock = bill(1e6, 1e6, 1e6, 1e6), before = structuredClone(stock),
    first = startUpgrade(state, stock, 'workshop-ii', 'a', 10), paid = structuredClone(stock);
  assert.deepEqual(state.levels, BASIC_INDUSTRY, 'construction grants no premature capability');
  assert(startUpgrade(state, stock, 'workshop-ii', 'b', 10).already); assert.deepEqual(stock, paid);
  const held = structuredClone({ state, stock });
  assert.throws(() => startUpgrade(state, stock, 'hangar-i', 'b', 10)); assert.deepEqual({ state, stock }, held);
  assert.equal(advanceIndustry(state, 129.999), null);
  const cancelled = cancelUpgrade(state, stock, first.pending); assert.deepEqual(stock, before);
  assert.deepEqual(cancelled.refund, billSum(before, paid, -1));
  cancelUpgrade(state, stock, first.pending); assert.deepEqual(stock, before);
  const second = startUpgrade(state, stock, 'hangar-i', 'b', 130), secondStock = structuredClone(stock);
  assert(second.pending > first.pending); cancelUpgrade(state, stock, first.pending);
  assert.equal(state.pending.id, second.pending); assert.deepEqual(stock, secondStock);
});
test('completion commits capital once; cancellation after completion and free converted levels cannot mint resources', () => {
  const state = newIndustry(), stock = bill(1e6, 1e6, 1e6, 1e6), before = structuredClone(stock),
    receipt = startUpgrade(state, stock, 'workshop-ii', 'a', 0);
  assert.equal(advanceIndustry(state, 120), 'workshop-ii'); assert.equal(state.levels.workshop, 2);
  assert.equal(advanceIndustry(state, 10000), null); cancelUpgrade(state, stock, receipt.pending);
  assert(startUpgrade(state, stock, 'workshop-ii', 'a', 10000).already);
  assert.deepEqual(billSum(stock, state.capital), before);
  const salvage = liquidateIndustry(state); assert.deepEqual(billSum(stock, salvage), before);
  assert.deepEqual(state.levels, BASIC_INDUSTRY); assert.deepEqual(liquidateIndustry(state), bill());
  assert.deepEqual(liquidateIndustry(newIndustry(FULL_INDUSTRY)), bill(), 'free levels carry no paid capital');
});
test('malformed states and invalid requests are refused before mutating state or resources', () => {
  const state = newIndustry(), stock = bill(1, 1, 1, 1), before = structuredClone({ state, stock });
  for (const id of ['unknown', 'workshop-iii', 'workshop-ii']) { assert.throws(() => startUpgrade(state, stock, id, 'a', 0)); assert.deepEqual({ state, stock }, before); }
  for (const change of [{ levels: { ...BASIC_INDUSTRY, hangar: '1' } }, { capital: bill(-1, 0, 0, 0) }, { pending: {} }, { serial: -1 }])
    assert.throws(() => validateIndustry({ ...state, ...change }, 0));
  startUpgrade(state, bill(1e6, 1e6, 1e6, 1e6), 'hangar-i', 'a', 0);
  assert.throws(() => validateIndustry({ ...state, pending: { ...state.pending, cost: bill() } }, 1));
  assert.throws(() => validateIndustry(state, 1, false));
});
test('room authorization, pending/save resume and manufacturing use completed facilities of the shared faction', t => {
  const f = onField(t, rehearsal([-213, 20000], undefined, { industry: BASIC_INDUSTRY })), room = f.room,
    leader = room.join('Líder'), member = room.join('Membro'), faction = room.factions.get(leader.faction.id);
  f.send(leader, 'invite', { playerId: member.playerId }); f.send(member, 'join-faction', { factionId: faction.id });
  const before = structuredClone(room.keep());
  assert.throws(() => f.send(member, 'upgrade', { id: 'workshop-ii' }), /Só o líder/); assert.deepEqual(room.keep(), before);
  assert.throws(() => f.publish(leader, 'ifv'), error => error.code === 'INDUSTRY_REQUIRED');
  const receipt = f.send(leader, 'upgrade', { id: 'workshop-ii', cost: bill(), until: 0 });
  assert.equal(faction.industry.pending.until, 120); assert.equal(faction.industry.levels.workshop, 1);
  assert.throws(() => f.publish(leader, 'ifv'), error => error.code === 'INDUSTRY_REQUIRED');
  const saved = JSON.parse(JSON.stringify(room.keep())), restored = rehearsal([-213, 20000], undefined, { kept: saved }); t.after(() => restored.world.dispose());
  assert.deepEqual(restored.factions.get(faction.id).industry, faction.industry);
  advanceIndustry(faction.industry, 120); assert.equal(room.factionView(member.playerId).industry.levels.workshop, 2);
  assert(f.publish(leader, 'ifv')); assert.equal(faction.industry.pending, null);
  assert(f.send(leader, 'cancel-upgrade', { id: receipt.pending }).already);
});
test('base defeat settles paid and pending industry once and recovery starts basic, without transferring factories', t => {
  const f = onField(t, rehearsal([-213, 20000], undefined, { industry: BASIC_INDUSTRY })), { room } = f,
    loser = room.join('Defensor'), winner = room.join('Atacante'), faction = room.factions.get(loser.faction.id), victor = room.factions.get(winner.faction.id);
  f.send(loser, 'upgrade', { id: 'workshop-ii' }); advanceIndustry(faction.industry, 120);
  f.send(loser, 'upgrade', { id: 'hangar-i' });
  const before = billSum(faction.stock, victor.stock, 1), invested = billSum(faction.industry.capital, faction.industry.pending.cost);
  faction.capture = { by: victor.id, progress: 60, at: 0, state: 'advancing' }; room.fall(faction, 0);
  const after = billSum(faction.stock, victor.stock);
  assert.deepEqual(after, billSum(before, invested)); assert.deepEqual(faction.industry.levels, BASIC_INDUSTRY);
  assert.deepEqual(victor.industry.levels, BASIC_INDUSTRY); assert.deepEqual(faction.industry.capital, bill()); assert.equal(faction.industry.pending, null);
  assert.deepEqual(liquidateIndustry(faction.industry), bill());
  assert.deepEqual(validateIndustry(faction.industry, 0, false), faction.industry);
});
test('a fractional field clock survives cold JSON and the live room completes the paid upgrade without offline time', t => {
  const f = onField(t, rehearsal([-213], undefined, { industry: BASIC_INDUSTRY })), { room } = f,
    player = room.join('Montagem'), faction = room.factions.get(player.faction.id);
  f.run(1.1);
  const wealth = () => room.factionView(player.playerId).ranking.find(row => row.ref === faction.ref).wealth, beforeWealth = wealth();
  f.send(player, 'upgrade', { id: 'hangar-i' });
  const before = structuredClone(faction.industry), saved = JSON.parse(JSON.stringify(room.keep())),
    restored = rehearsal([-213], undefined, { kept: saved }); t.after(() => restored.world.dispose());
  assert.deepEqual(restored.factions.get(faction.id).industry, before, 'reopening neither finishes nor restarts construction');
  f.run(119); assert.equal(faction.industry.levels.hangar, 0); assert.equal(wealth(), beforeWealth, 'paid construction remains faction wealth');
  f.run(1.2); assert.equal(faction.industry.levels.hangar, 1); assert.equal(faction.industry.pending, null);
  assert.deepEqual(faction.industry.capital, before.pending.cost);
  assert.equal(wealth(), beforeWealth, 'committing paid capital does not erase or double faction wealth');
});
