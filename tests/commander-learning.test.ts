import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { FieldHost, replayField, DIARY } from '../server/field-host.ts';
import { writeField } from '../server/field-snapshot.ts';
import { coreBuild } from '../server/field-journal.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { CORE_CONTRACT, initNativeDynamics } from '../src/native-dynamics.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { observeCommander } from '../server/commander-observation.ts';
import { commanderActionKey } from '../server/commander-contract.ts';
import { chooseCommanderAction } from '../server/commander-policy.ts';
import { economicProposals, economicScore, FEATURES, HIDDEN, initialEconomicModel,
  readEconomicModel, selectEconomicProposal, economicCapital } from '../scripts/commander-learning/policy.ts';
import { nativePhotoOnly } from './helpers/runtime.js';
import { episodeScore } from '../scripts/commander-learning/objective.ts';
import { DiscoveryProgress } from '../scripts/commander-learning/discovery.ts';
import { EconomicHistory } from '../scripts/commander-learning/history.ts';
await initNativeDynamics();

test('capture and definitive duel outcomes outrank arbitrary capital while a horizon is not a victory', () => {
  const richHorizon = episodeScore('horizon', 0, Number.MAX_SAFE_INTEGER, 1),
    expensiveCapture = episodeScore('base-captured', Number.MAX_SAFE_INTEGER, 0),
    expensiveWin = episodeScore('duel-win', Number.MAX_SAFE_INTEGER, 0),
    richLoss = episodeScore('duel-loss', 0, Number.MAX_SAFE_INTEGER);
  assert(richHorizon <= .5);
  assert(expensiveCapture > richHorizon);
  assert(expensiveWin > expensiveCapture);
  assert(richLoss < episodeScore('horizon', Number.MAX_SAFE_INTEGER, 0));
  assert.equal(episodeScore('horizon', 100, 100), 0);
  // A useful new discovery can outweigh a modest operating cost. The pilot
  // otherwise preferred buying once and waiting forever over any exploration.
  assert(episodeScore('horizon', 200000, 180000, .2) > episodeScore('horizon', 200000, 200000));
  assert.throws(() => episodeScore('horizon', NaN, 0), /capital/);
  assert.throws(() => episodeScore('horizon', 0, 0, 1.01), /progress/);
});

test('discovery credit uses useful authorized information once, is bounded, and cannot pay for revisits', t => {
  const room = new SharedRoom({ base: () => -1800 }); t.after(() => room.world.dispose());
  const bot = room.addCommander('Discovery test'), o = observeCommander(room, bot.id),
    known = { id: 'initial', x: -1700, material: 'ferro' as const, reserve: 2000, left: 2000, stock: 0, seen: true, at: 0 };
  o.deposits = [known]; o.bases = []; o.danger = [];
  const progress = new DiscoveryProgress(o), before = JSON.stringify(o);
  progress.observe(o); assert.equal(progress.value, 0); assert.equal(JSON.stringify(o), before);
  o.deposits = [{ ...known, id: 'unconfirmed', seen: false, at: null },
    { ...known, id: 'depleted', left: 0 }, { ...known, id: 'far', x: 4000 }];
  progress.observe(o); assert.equal(progress.value, 0);
  o.deposits = [{ ...known, id: 'dangerous' }]; o.danger = [{ lo: -1800, hi: -1600 }];
  progress.observe(o); assert.equal(progress.value, 0);
  o.danger = []; o.deposits = (['ferro', 'ligas', 'silica', 'petroleo'] as const).map(material =>
    ({ ...known, id: 'new-' + material, material }));
  progress.observe(o); assert.equal(progress.value, .8);
  o.bases = [{ id: 'hostile', x: 3000, radius: 200, seen: false, at: null, sheltered: false }];
  progress.observe(o); assert.equal(progress.value, .8);
  o.bases[0]!.seen = true; progress.observe(o); assert.equal(progress.value, 1);
  for (let i = 0; i < 20; i++) progress.observe(o);
  assert.equal(progress.value, 1);
  assert.equal(episodeScore('horizon', 100, 100, progress.value), .4);
});

test('economic history and neutral proposals preserve classical decisions and physics at the same recorded cadence', t => {
  const rooms = [0, 1].map(() => new SharedRoom({ base: i => i ? 1600 : -1600 }));
  rooms.forEach(room => t.after(() => room.world.dispose()));
  const hosts = rooms.map(room => {
    for (let i = 0; i < 2; i++) room.addCommander('Observer ' + i, 'balanced', String(i + 1).padStart(16, '0'));
    room.startDuel(); return new FieldHost(room);
  });
  assert.equal(rooms[0]!.digest(), rooms[1]!.digest());
  const history = new EconomicHistory(), neutral = initialEconomicModel();
  for (let tick = 0; tick < 30 * 60; tick++) {
    hosts.forEach((host, i) => {
      host.decideCommander('j1', (o, state) => {
        if (!i) return chooseCommanderAction(o, state);
        const proposals = economicProposals(o, state, history.observe(o));
        return proposals[selectEconomicProposal(neutral, proposals)]!.choice;
      });
      host.step(() => 1);
      if (host.room.steps % (60 * (i ? 30 : 1)) === 0) observeCommander(host.room, 'j1');
    });
  }
  assert.equal(rooms[0]!.digest(), rooms[1]!.digest());
});

test('the economic scorer has a bounded versioned schema and a neutral model preserves its baseline choice', () => {
  const model = initialEconomicModel(), features = Array<number>(FEATURES.length).fill(0);
  assert.deepEqual(readEconomicModel(JSON.parse(JSON.stringify(model))), model);
  assert.equal(economicScore(model, features), 0);
  const output = FEATURES.length * HIDDEN + HIDDEN;
  model.parameters.fill(0); model.parameters[FEATURES.indexOf('guard')] = 2; model.parameters[output] = 1;
  features[FEATURES.indexOf('guard')] = 1;
  assert.equal(economicScore(model, features), Math.tanh(2));
  for (const bad of [{ ...model, version: 1 }, { ...model, version: 3 }, { ...model, baselineMargin: undefined },
    { ...model, baselineMargin: -.01 }, { ...model, baselineMargin: Infinity }, { ...model, features: [...FEATURES].reverse() },
    { ...model, parameters: [NaN] }, { ...model, parameters: model.parameters.map(() => Infinity) }])
    assert.throws(() => readEconomicModel(bad), /Incompatible/);
  assert.throws(() => economicScore(model, []), /features/);
});

test('a sub-margin score change retains the expert; a clear improvement still selects the best alternative', () => {
  const model = initialEconomicModel(); model.parameters.fill(0);
  model.parameters[FEATURES.indexOf('guard')] = 1;
  model.parameters[FEATURES.length * HIDDEN + HIDDEN] = 1;
  const proposal = (value: number) => {
    const features = Array<number>(FEATURES.length).fill(0); features[FEATURES.indexOf('guard')] = value;
    return { choice: { action: null, reason: 'preserve-reserve' as const }, features };
  };
  const tiny = [proposal(0), proposal(.000001)];
  assert.equal(selectEconomicProposal(model, tiny), 0);
  assert.equal(selectEconomicProposal({ ...model, baselineMargin: 0 }, tiny), 1);
  assert.equal(selectEconomicProposal(model, [proposal(.1), proposal(.15)]), 0, 'margin is relative to the baseline score');
  assert.equal(selectEconomicProposal(model, [proposal(0), proposal(.02), proposal(.2), proposal(.1)]), 2);
  assert.equal(selectEconomicProposal(model, [proposal(0), proposal(.2), proposal(.2)]), 1, 'stable ties');
});

test('economic memory reports a bounded recent net stock change and forgets gaps without inventing income', () => {
  const history = new EconomicHistory(), stock = { ferro: 100000, ligas: 10000, silica: 10000, combustivel: 2000 };
  assert.equal(history.observe({ time: 0, stock }).seconds, 0);
  stock.ferro -= 10000; stock.combustivel -= 50;
  const trend = history.observe({ time: 30, stock });
  assert.equal(trend.seconds, 30); assert.equal(trend.perMinute.ferro, -20000); assert.equal(trend.perMinute.combustivel, -100);
  assert.deepEqual(history.observe({ time: 30, stock }), trend, 'repeated reads do not add elapsed time');
  stock.ferro += 30000;
  const recent = history.observe({ time: 90, stock });
  assert.equal(recent.seconds, 60); assert.equal(recent.perMinute.ferro, 30000, 'earlier bills leave the window');
  assert.equal(history.observe({ time: 300, stock }).seconds, 0, 'a long observation gap is not a one-minute measurement');
  assert.throws(() => history.observe({ time: 299, stock }), /chronological/);
});

test('economic inputs distinguish upgrade purpose, scarce replacement resources and known exposure without depending on map origin', t => {
  const room = new SharedRoom({ base: () => -1800 }); t.after(() => room.world.dispose());
  const bot = room.addCommander('Semantic inputs'), o = observeCommander(room, bot.id), state = room.commanders.get(bot.id)!;
  o.stock = { ferro: 200000, ligas: 50000, silica: 50000, combustivel: 500 };
  o.units = []; o.deposits = []; o.danger = []; o.threats = [];
  o.offers = [
    { model: 'mining-truck', cost: { ferro: 10000, ligas: 0, silica: 0, combustivel: 100 } },
    { model: 'scout', cost: { ferro: 20000, ligas: 10, silica: 0, combustivel: 100 } },
  ];
  o.bases = [
    { id: 'known-left', x: o.base!.x - 4500, radius: 200, seen: false, at: 0, sheltered: false },
    { id: 'known-right', x: o.base!.x + 3500, radius: 200, seen: true, at: 0, sheltered: false },
  ];
  const proposals = economicProposals(o, state), feature = (p: typeof proposals[number], name: typeof FEATURES[number]) => p.features[FEATURES.indexOf(name)];
  const workshop = proposals.find(p => p.choice.action?.kind === 'upgrade' && p.choice.action.upgrade === 'workshop-ii')!,
    hangar = proposals.find(p => p.choice.action?.kind === 'upgrade' && p.choice.action.upgrade === 'hangar-i')!,
    processing = proposals.find(p => p.choice.action?.kind === 'upgrade' && p.choice.action.upgrade === 'processing-ii')!;
  assert(workshop && hangar && processing);
  assert.equal(feature(workshop, 'workshopUpgrade'), 1); assert.equal(feature(hangar, 'hangarUpgrade'), 1);
  assert.equal(feature(processing, 'processingUpgrade'), 1); assert.equal(feature(processing, 'hangarUpgrade'), 0);
  assert.equal(feature(hangar, 'alloyCost'), .8);
  assert.equal(feature(workshop, 'miningReserve'), 2, 'fuel, not abundant iron, limits replacements after this bill');
  assert.equal(feature(workshop, 'defenseReserve'), 2);
  assert.equal(feature(workshop, 'leftPressure'), .25); assert.equal(feature(workshop, 'rightPressure'), 1 - 3500 / 6000);
  assert(proposals.every(p => p.features.length === FEATURES.length && p.features.every(Number.isFinite)));
  o.base!.x += 10000; o.bases.forEach(b => { b.x += 10000; });
  assert.deepEqual(economicProposals(o, state), proposals, 'translation preserves relative strategic inputs');
});

test('economic proposals use ordinary admitted costs and do not steal an active operation or modify its observation', t => {
  const room = new SharedRoom({ base: () => -1800 }); t.after(() => room.world.dispose());
  const bot = room.addCommander('Economic test'), o = observeCommander(room, bot.id), state = room.commanders.get(bot.id)!,
    before = JSON.stringify([o, state]), proposals = economicProposals(o, state);
  assert(proposals.length > 1); assert.equal(selectEconomicProposal(initialEconomicModel(), proposals), 0);
  const keys = proposals.map(p => p.choice.action ? commanderActionKey(p.choice.action) : 'wait');
  assert.equal(new Set(keys).size, keys.length, 'the network compares distinct actions, not wording variants');
  assert.equal(JSON.stringify([o, state]), before);
  o.stock = { ferro: 0, ligas: 0, silica: 0, combustivel: 0 };
  assert(!economicProposals(o, state).some(p => p.choice.action?.kind === 'manufacture' || p.choice.action?.kind === 'upgrade'));
  o.units.forEach(unit => { unit.manual = true; }); o.offers = []; o.upgrades = [];
  const busy = chooseCommanderAction(o, state);
  assert.equal(busy.reason, 'busy');
  assert.deepEqual(economicProposals(o, state).map(p => p.choice), [busy], 'a second wait cannot change only the explanation');
  state.operation = { phase: 'prepare', targetId: 'unknown', targetX: 1800, startedAt: 0, until: 1200 };
  assert.equal(economicProposals(o, state).length, 1, 'the operation state machine retains authority');
});

test('a base alarm keeps ordinary paid defense ahead of a learned wait', t => {
  const room = new SharedRoom({ base: () => -1800 }); t.after(() => room.world.dispose());
  const bot = room.addCommander('Alarm admission'), o = observeCommander(room, bot.id), state = room.commanders.get(bot.id)!;
  o.units = o.units.filter(u => !u.armed); o.besieged = true;
  const ordinary = chooseCommanderAction(o, state);
  assert.equal(ordinary.action?.kind, 'manufacture');
  assert.equal(ordinary.reason, 'manufacture-defense');
  assert.deepEqual(economicProposals(o, state).map(p => p.choice), [ordinary]);
});

test('a selected intention pays once at ordinary cadence and replays exactly without its selector or neural model', nativePhotoOnly, async t => {
  const room = new SharedRoom({ base: () => -1800 }), host = new FieldHost(room), bot = room.addCommander('Recorded selector');
  t.after(() => room.world.dispose());
  room.site = null;
  const header = { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT,
    core: coreBuild(), field: null, fieldId: room.fieldId, step: 0, snapshot: writeField(room, host.publication) },
    capital = economicCapital(observeCommander(room, bot.id)), before = room.factions.get(bot.factionId)!.stock.ferro,
    price = observeCommander(room, bot.id).offers.find(o => o.model === 'mining-truck')!.cost.ferro;
  let calls = 0;
  assert(host.decideCommander(bot.id, () => { calls++; return { action: { kind: 'manufacture', model: 'mining-truck' }, reason: 'restore-mining' }; }));
  assert.equal(room.factions.get(bot.factionId)!.stock.ferro, before - price);
  assert.equal(economicCapital(observeCommander(room, bot.id)), capital, 'buying refundable assets cannot create economic reward');
  assert.equal(host.decideCommander(bot.id, () => { throw new Error('Must not be called before next cycle'); }), false);
  for (let i = 0; i < 120; i++) host.step(() => 1);
  assert.equal(calls, 1);
  const lines = [JSON.stringify(header), ...host.lines!], again = await replayField(lines);
  t.after(() => again.host?.room.world.dispose());
  assert.equal(again.how, 'end', JSON.stringify({ expected: again.expected, got: again.got, error: again.error }));
  assert.equal(again.host!.room.digest(), room.digest());
  assert.equal(room.commanders.get(bot.id)!.actions, 1);
});
