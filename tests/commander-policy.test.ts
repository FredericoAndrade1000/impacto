import test from 'node:test';
import assert from 'node:assert/strict';
import { bill } from '../src/economy-contract.ts';
import { chooseCommanderAction } from '../server/commander-policy.ts';
import { commanderActionKey } from '../server/commander-contract.ts';
import { chooseCommanderLightening, chooseCommanderRecovery } from '../server/commander-recovery.ts';
import { commanderRouteKey } from '../server/commander-routes.ts';
import type { CommanderObservation, CommanderState, CommanderUnit, CommanderThreat } from '../server/commander-contract.ts';

const unit = (id: string, patch: Partial<CommanderUnit> = {}): CommanderUnit => ({
  id, x: 0, vehicle: true, aircraft: false, combatAt: null, armed: false, artillery: false, builder: false, supply: false,
  extracts: [], carries: [], fuel: 200, fuelCapacity: 202, cargo: 0, health: 1, maxHealth: 1000, ammoRatio: 1, attack: null,
  mobility: { speed: 20, range: 200000 },
  calm: true, still: true, manual: false, salvage: bill(), maintenance: null,
  ready: true, atBase: true, atDepot: true, moving: false, home: false, auto: true, stance: 'return', halt: '',
  haul: null, job: { kind: null, phase: 'idle', reason: '' }, ...patch,
});

test('a paid home guard awaiting service preserves replacement mining capital instead of buying a duplicate', () => {
  const o = observation({ stock: bill(62000, 10000, 10000, 2000), upgrades: [],
    threats: [{ kind: 'contact', id: 'raider', x: 1700, channel: 'seen', armed: true, grounded: true }] });
  o.units = o.units.filter(u => !u.extracts.includes('ferro'));
  Object.assign(o.units.find(u => u.armed)!, { ready: false, auto: false, job: null });
  o.offers.push({ model: 'scout-20mm', cost: bill(37057, 0, 1291, 203) }, { model: 'scout', cost: bill(22063, 0, 1291, 203) });
  const before = structuredClone(o);
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'manufacture', model: 'mining-truck' }, reason: 'restore-mining' });
  assert.deepEqual(o, before);
  o.danger = [{ lo: 400, hi: 1000 }];
  assert.equal(chooseCommanderAction(o, state()).action, null, 'an unsafe income route preserves the cash until it can be restored');
  o.danger = [];
  for (const patch of [{ manual: true }, { ammoRatio: 0 }, { health: .3 }, { halt: 'immobile' }]) {
    const withoutGuard = structuredClone(o); Object.assign(withoutGuard.units.find(u => u.armed)!, patch);
    assert.equal(chooseCommanderAction(withoutGuard, state()).reason, 'manufacture-defense', 'unavailable coverage still justifies an emergency defender');
  }
});
function state(patch: Partial<CommanderState> = {}): CommanderState {
  return { enabled: true, profile: 'balanced', nextAt: 0, sequence: 0, actions: 0, refusals: 0,
    cooldowns: {}, blocked: {}, orders: {}, deferredRepairs: [], history: [], operation: null, ...patch };
}
function observation(patch: Partial<CommanderObservation> = {}): CommanderObservation {
  return {
    time: 200, playerId: 'j1', factionId: 'f1', base: { x: 0, facing: 1 }, stock: bill(60000, 10000, 10000, 1500),
    recovery: null, wrecks: [], besieged: false, industry: { levels: { workshop: 1, hangar: 0, processing: 1 }, pending: false },
    units: [
      unit('miner', { extracts: ['ferro', 'ligas', 'silica'], carries: ['ferro', 'ligas', 'silica'], haul: { depositId: 'iron', phase: 'out' }, moving: true, atDepot: false }),
      unit('tanker', { extracts: ['petroleo'], carries: ['petroleo'], haul: { depositId: 'oil', phase: 'out' }, moving: true, atDepot: false }),
      unit('builder', { builder: true, supply: true }), unit('scout', { armed: true, stance: 'fire' }),
    ],
    deposits: [
      { id: 'iron', x: 650, material: 'ferro', reserve: 60000, left: 60000, stock: 0, seen: false, at: 0 },
      { id: 'oil', x: -1500, material: 'petroleo', reserve: 60000, left: 60000, stock: 0, seen: false, at: 0 },
    ],
    offers: [
      { model: 'mining-truck', cost: bill(29555, 0, 787, 203) },
      { model: 'tanker', cost: bill(29688, 0, 787, 203) },
      { model: 'construction-truck', cost: bill(53223, 0, 1840, 203) },
    ],
    upgrades: [{ id: 'workshop-ii', cost: bill(60000, 2000, 3000, 300), eligible: true }],
    explored: [[-1000, 1000]], bounds: { minX: -50000, maxX: 50000 }, danger: [], threats: [], batteries: [], works: [], bases: [], taken: null, ...patch,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

test('a loaded stuck owned return may lighten once, while live work, empty hulls and manual orders retain authority', () => {
  const o = observation(), miner = o.units[0]!, s = state({ orders: { miner: { kind: 'haul', depositId: 'iron' } } });
  Object.assign(miner, { x: 500, atBase: false, atDepot: false, moving: false, cargo: 1000,
    halt: 'stuck-slope', haul: { depositId: 'iron', phase: 'home' } });
  const before = structuredClone([o, s]), action = { kind: 'dump-cargo', unitId: miner.id } as const;
  assert.deepEqual(chooseCommanderLightening(o, s), { action, reason: 'recover-mobility' });
  assert.deepEqual([o, s], before);
  for (const patch of [{ cargo: 0 }, { moving: true }, { manual: true }, { atDepot: true }, { ready: false },
    { halt: 'enemy-near' }, { halt: '' }, { fuel: 0 }, { aircraft: true }, { calm: false },
    { job: { kind: 'build', phase: 'work', reason: '' } }]) {
    const other = structuredClone(o); Object.assign(other.units[0]!, patch);
    assert.equal(chooseCommanderLightening(other, s), null, JSON.stringify(patch));
  }
  assert.equal(chooseCommanderLightening(o, state()), null, 'an unowned trip cannot lose cargo');
  s.cooldowns[commanderActionKey(action)] = o.time + 180;
  assert.equal(chooseCommanderLightening(o, s), null);
  o.time += 180; assert.deepEqual(chooseCommanderLightening(o, s)?.action, action);
});

test('an empty stranded extractor does not prevent a paid replacement, while a depot repair still counts', () => {
  const o = observation({ upgrades: [] }), miner = o.units[0]!,
    s = state({ orders: { miner: { kind: 'home' } } });
  Object.assign(miner, { x: 500, atBase: false, atDepot: false, moving: false, home: true, halt: 'stuck-slope',
    haul: { depositId: 'iron', phase: 'home' } });
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'mining-truck' });
  Object.assign(miner, { atBase: true, atDepot: true, ready: false });
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'mining-truck' });
});

test('defense compares admitted cannon, heavy vehicle and scout quotes against the actual budget', () => {
  const o = besiegedBase(), s = state();
  o.units = o.units.filter(unit => unit.id !== 'reserve');
  o.offers.push({ model: 'scout-20mm', cost: bill(37000, 0, 1291, 203) });
  o.stock = bill(50000, 10000, 6000, 3000);
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'scout-20mm' }, 'a useful admitted cannon need not wait for the IFV');
  o.stock.ferro = 90000;
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'ifv' });
  o.stock.ferro = 30000;
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'scout' }, 'a first response still has a cheaper fallback');
  o.stock.combustivel = 202;
  assert.notEqual(chooseCommanderAction(o, s).action?.kind, 'manufacture', 'the real fuel price and reserve still apply');
  o.offers = o.offers.filter(offer => offer.model !== 'scout-20mm'); o.stock = bill(50000, 10000, 6000, 3000);
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'scout-20mm' }, 'an unavailable design is never invented by planning');
});

test('a new hauler avoids a recently interrupted source, uses an alternative and retries after the saved deadline', () => {
  const o = observation(), miner = o.units[0]!;
  Object.assign(miner, { id: 'replacement', moving: false, atDepot: true, haul: null });
  o.deposits.push({ ...o.deposits[0]!, id: 'other-iron', x: 950 });
  const s = state({ cooldowns: { [commanderRouteKey('iron')]: o.time + 180 } });
  const before = structuredClone([o, s]);
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: miner.id, depositId: 'other-iron' });
  assert.deepEqual([o, s], before, 'selection owns neither the observed world nor persistent scheduling');
  o.time += 180;
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: miner.id, depositId: 'iron' });
  o.time -= 180; o.deposits = o.deposits.filter(site => site.id !== 'other-iron'); o.units = o.units.filter(unit => unit !== miner);
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'mining-truck' },
    'an interrupted source cannot justify immediately buying another worker for the same trip');
});

test('a held route recalls only the commander-owned outbound trip and preserves a loaded return', () => {
  const o = observation(), miner = o.units[0]!,
    s = state({ cooldowns: { [commanderRouteKey('iron')]: o.time + 180 }, orders: { miner: { kind: 'haul', depositId: 'iron' } } });
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'home', unitId: miner.id });
  Object.assign(miner, { cargo: 1000, haul: { depositId: 'iron', phase: 'home' } });
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'home', unitId: miner.id });
  miner.haul!.phase = 'out'; s.orders = {};
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'home', unitId: miner.id }, 'an unowned order keeps its authority');
});

function fixedPlantIncome(): CommanderObservation {
  const o = observation({ stock: bill(200000, 10000, 10000, 3000),
    works: [{ id: 'plant', model: 'mining-site', x: 655, complete: true }] });
  o.units = o.units.filter(unit => unit.id !== 'miner');
  o.units.push(unit('plant', { vehicle: false, x: 655, atDepot: false, extracts: ['ferro', 'silica', 'ligas'] }),
    unit('truck', { x: 400, carries: ['ferro', 'silica', 'ligas'], moving: true, atDepot: false, haul: { depositId: 'iron', phase: 'home' }, cargo: 2000 }));
  o.offers.push({ model: 'truck', cost: bill(23850, 0, 787, 203) });
  return o;
}

function besiegedBase(): CommanderObservation {
  const o = observation({ stock: bill(200000, 10000, 10000, 3000), upgrades: [],
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
  o.units[3]!.combatAt = o.time;
  o.units.push(unit('reserve', { armed: true, stance: 'fire' }));
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) },
    { model: 'scout', cost: bill(22063, 0, 1291, 203) }, { model: 'mortar', cost: bill(31246, 0, 1227, 203), artilleryRange: 4500 });
  return o;
}

test('known nearby wreck value restores the miner through ordinary salvage and a full-price purchase', () => {
  const o = observation({ stock: bill(10000, 10000, 10000, 1500), upgrades: [] });
  o.units = o.units.filter(u => u.armed);
  o.wrecks = [{ id: 'wreck', x: 5, value: bill(25000, 0, 400), inReach: true, calmIn: null }];
  const before = structuredClone(o.units);
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'salvage', wreckId: 'wreck' }, reason: 'recover-materials' });
  assert.notEqual(chooseCommanderAction(o, state({ cooldowns: { 'salvage:wreck': o.time + 60 } })).action?.kind, 'salvage');
  for (const material of ['ferro', 'ligas', 'silica', 'combustivel'] as const) o.stock[material] += o.wrecks[0]!.value[material];
  o.wrecks = [];
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'manufacture', model: 'mining-truck' }, reason: 'restore-mining' });
  assert.deepEqual(o.units, before, 'the last physical guard is not dismantled');
});

test('local recovery approaches surveyed safe wrecks and respects danger, active work and direct control', () => {
  for (const direction of [-1, 1]) {
    const o = observation({ stock: bill(10000, 10000, 10000, 1500) });
    o.units = o.units.filter(u => u.armed);
    o.wrecks = [{ id: 'wreck', x: direction * 500, value: bill(25000), inReach: false, calmIn: null }];
    assert.deepEqual(chooseCommanderRecovery(o, state(), bill(29555)),
      { action: { kind: 'defend', unitId: 'scout', x: direction * 500 }, reason: 'recover-materials' });
    for (const patch of [{ manual: true }, { moving: true }, { haul: { depositId: 'iron', phase: 'home' } },
      { job: { kind: 'build', phase: 'work', reason: '' } }]) {
      const occupied = structuredClone(o); Object.assign(occupied.units[0]!, patch);
      assert.equal(chooseCommanderRecovery(occupied, state(), bill(29555)), null);
    }
    o.danger = [{ lo: Math.min(200 * direction, 300 * direction), hi: Math.max(200 * direction, 300 * direction) }];
    assert.equal(chooseCommanderRecovery(o, state(), bill(29555)), null);
    o.danger = []; o.wrecks[0]!.x = direction * 5000;
    assert.equal(chooseCommanderRecovery(o, state(), bill(29555)), null);
    o.wrecks[0]!.x = direction * 500;
    Object.assign(o.units[0]!, { x: direction * 500, atBase: false, atDepot: false, calm: false });
    o.wrecks[0]!.calmIn = 5;
    assert.deepEqual(chooseCommanderRecovery(o, state(), bill(29555)), { action: null, reason: 'recover-materials' });
    o.wrecks[0]!.inReach = true; o.units[0]!.calm = true;
    assert.equal(chooseCommanderRecovery(o, state(), bill(29555))?.action?.kind, 'salvage');
  }
});

test('stored fuel funds the next industrial step before buying an optional intake vehicle', () => {
  const o = observation({ stock: bill(90000, 10000, 10000, 1500) });
  o.units = o.units.filter(u => u.id !== 'tanker');
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'upgrade', upgrade: 'workshop-ii' }, reason: 'improve-workshop' });
  o.stock.combustivel = 750;
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'manufacture', model: 'tanker' }, reason: 'secure-fuel' },
    'the upgrade must still leave the ordinary miner replacement and fuel buffer payable');
});

test('an unusable extractor or an unsafe known route does not justify an industrial investment', () => {
  const o = observation({ stock: bill(200000, 10000, 10000, 1500) });
  Object.assign(o.units[0]!, { moving: false, atDepot: true, haul: null, mobility: null });
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'upgrade');
  o.units[0]!.mobility = { speed: 20, range: 200000 };
  o.danger = [{ lo: 600, hi: 700 }];
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'upgrade');
  o.danger = [];
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'haul', unitId: 'miner', depositId: 'iron' },
    'restore the ordinary productive order before committing to the industrial plan');
});

test('an armed home guard lets measured indirect fire take priority over redundant direct-fire guards', () => {
  const o = besiegedBase(); o.units = o.units.filter(u => u.id !== 'reserve');
  o.batteries = [{ x: 3600, error: 40, at: o.time }];
  assert.deepEqual(chooseCommanderAction(o, state({ profile: 'cautious' })),
    { action: { kind: 'manufacture', model: 'mortar' }, reason: 'counter-battery' });
  o.batteries[0]!.at = o.time - 61;
  assert.deepEqual(chooseCommanderAction(o, state({ profile: 'cautious' })).action,
    { kind: 'manufacture', model: 'ifv' }, 'an expired report does not justify buying artillery');
  o.batteries[0]!.at = o.time; o.units = o.units.filter(u => !u.armed);
  assert.deepEqual(chooseCommanderAction(o, state()).action,
    { kind: 'manufacture', model: 'ifv' }, 'a base without a functional guard still needs immediate armed coverage');
});

test('an idle builder can finance the concrete defender plan without selling income or the last guard', () => {
  const o = observation({ stock: bill(30000, 10000, 10000, 1500), upgrades: [],
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  const builder = o.units.find(u => u.builder)!; builder.salvage = bill(53223, 0, 1840, 203);
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'dismantle', unitId: builder.id }, reason: 'fund-production' });
  for (const patch of [{ moving: true }, { calm: false }, { cargo: 1 }, { manual: true }, { salvage: bill(1) },
    { job: { kind: 'build', phase: 'work', reason: '' } }]) {
    const other = structuredClone(o); Object.assign(other.units.find(u => u.builder)!, patch);
    assert.notEqual(chooseCommanderAction(other, state()).action?.kind, 'dismantle');
  }
  const before = structuredClone(o.units.filter(u => !u.builder));
  o.units = o.units.filter(u => !u.builder);
  for (const material of ['ferro', 'ligas', 'silica', 'combustivel'] as const) o.stock[material] += builder.salvage[material];
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'manufacture', model: 'ifv' }, reason: 'manufacture-defense' });
  assert.deepEqual(o.units, before);
});

test('working iron can fund a missing armed response while other replacement materials remain protected', () => {
  const o = observation({ stock: bill(80000, 10000, 4000, 1500), upgrades: [],
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'ifv' });
  o.stock.silica = 2000;
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'ifv' },
    'iron income does not replace the silica required to recover the miner');
  o.stock.silica = 4000; o.units[0]!.mobility = null;
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'ifv' },
    'without a working iron path, the ordinary cash reserve remains necessary');
});

test('an unfinished defender never makes the last ready home guard expendable for income', () => {
  const o = observation({ stock: bill(10000, 10000, 10000, 1500), upgrades: [] });
  o.units = o.units.filter(u => u.id !== 'miner' && u.id !== 'builder');
  o.units.find(u => u.armed)!.salvage = bill(22063, 0, 1291, 203);
  o.units.push(unit('unfinished', { armed: true, stance: 'fire', ready: false }));
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'dismantle');
});

test('a fixed mine cannot replace the mobile extractor needed for another scarce material', () => {
  const o = fixedPlantIncome(), s = state();
  o.stock = bill(80000, 200000, 75, 89000); o.upgrades = []; o.industry.levels.workshop = 2;
  o.works[0]!.x = 2000; o.units.find(u => u.id === 'plant')!.x = 2000;
  o.deposits.push({ ...o.deposits[0]!, id: 'alloys', material: 'ligas', x: 2005 },
    { ...o.deposits[0]!, id: 'silica', material: 'silica', x: 7000 });
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  o.units.find(u => u.armed)!.combatAt = o.time;
  const builder = o.units.find(u => u.builder)!, carrier = structuredClone(o.units.find(u => u.id === 'truck')!);
  builder.salvage = bill(53223, 0, 1840, 203);
  assert.deepEqual(chooseCommanderAction(o, s),
    { action: { kind: 'dismantle', unitId: builder.id }, reason: 'restore-mining' });
  o.units = o.units.filter(u => u.id !== builder.id);
  for (const material of ['ferro', 'ligas', 'silica', 'combustivel'] as const) o.stock[material] += builder.salvage[material];
  assert.deepEqual(chooseCommanderAction(o, s),
    { action: { kind: 'manufacture', model: 'mining-truck' }, reason: 'restore-mining' });
  const cost = o.offers.find(offer => offer.model === 'mining-truck')!.cost;
  for (const material of ['ferro', 'ligas', 'silica', 'combustivel'] as const) o.stock[material] -= cost[material];
  o.units.push(unit('replacement-miner', { extracts: ['ferro', 'ligas', 'silica'], carries: ['ferro', 'ligas', 'silica'] }));
  assert.deepEqual(chooseCommanderAction(o, s).action,
    { kind: 'haul', unitId: 'replacement-miner', depositId: 'silica' });
  assert.deepEqual(o.units.find(u => u.id === 'truck'), carrier, 'the loaded return and the last guard remain intact');
  assert(o.units.some(u => u.id === 'scout' && u.armed));
});

test('a pure carrier changes its empty owned loop to ready scarce material, without being sent to unworked ore', () => {
  const o = fixedPlantIncome(); o.upgrades = []; o.industry.levels.workshop = 2; o.stock.silica = 2000;
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  o.deposits.push({ ...o.deposits[0]!, id: 'silica', material: 'silica', x: 900, stock: 4000 });
  const carrier = o.units.find(u => u.id === 'truck')!;
  Object.assign(carrier, { x: 0, atBase: true, atDepot: true, cargo: 0, haul: { depositId: 'iron', phase: 'out' } });
  const s = state({ orders: { truck: { kind: 'haul', depositId: 'iron' } } });
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: carrier.id, depositId: 'silica' });
  carrier.haul!.phase = 'home'; carrier.cargo = 2000;
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: carrier.id, depositId: 'silica' },
    'a loaded return keeps authority');
  o.units.push(unit('miner', { extracts: ['ferro', 'silica'], carries: ['ferro', 'silica'], moving: true,
    atDepot: false, haul: { depositId: 'iron', phase: 'out' } }));
  Object.assign(carrier, { cargo: 0, haul: null, moving: false }); o.deposits.at(-1)!.stock = 0;
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: carrier.id, depositId: 'silica' },
    'a carrier has no tool to extract an unworked reserve');
  Object.assign(carrier, { x: 655, atBase: false, atDepot: false });
  assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'home', unitId: carrier.id },
    'a carrier waiting for the fixed plant does not need to clear the extraction mouth');
});

test('the next military replacement is surveyed before the last affordable purchase consumes its material', () => {
  const o = besiegedBase(); o.stock = bill(300000, 10000, 3000, 4000); o.upgrades = [];
  for (const unit of o.units) unit.combatAt = null;
  o.bases = [{ id: 'known-base', x: 4000, radius: 100, seen: false, at: 100, sheltered: false }];
  const s = state({ cooldowns: { 'operation:known-base': o.time + 300 } });
  assert.equal(chooseCommanderAction(o, s).action?.kind, 'explore',
    'the present stock pays one IFV, but another replacement plus the income reserve needs an unknown silica source');
});

test('a funded workshop improvement precedes an idle replacement constructor', () => {
  const o = observation({ stock: bill(120000, 10000, 10000, 3000) });
  o.units = o.units.filter(unit => !unit.builder);
  o.offers.push({ model: 'scout', cost: bill(22063, 0, 1291, 203) });
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'upgrade', upgrade: 'workshop-ii' }, reason: 'improve-workshop' });
});

test('a workshop upgrade retains a useful military purchase as well as the full income replacement', () => {
  const o = observation({ stock: bill(90000, 10000, 10000, 3000) });
  o.offers.push({ model: 'scout', cost: bill(22063, 0, 1291, 203) },
    { model: 'scout-20mm', cost: bill(37000, 0, 1291, 203) });
  const before = structuredClone(o);
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'upgrade', 'initial capital must not disappear into industry before a useful response can be paid');
  assert.deepEqual(o, before);
  o.stock.ferro = 130000;
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'upgrade', upgrade: 'workshop-ii' });
});

test('a depot repair can be deferred for income and resumed only by the controller that deferred it', () => {
  const o = observation({ stock: bill(500, 10000, 10000, 3000) }), guard = o.units[3]!;
  guard.ready = false; guard.auto = false;
  guard.maintenance = { phase: 'repairing', critical: false, cost: bill(800), payer: null };
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'cancel-repair', unitId: guard.id }, reason: 'preserve-income' });
  guard.ready = true; guard.maintenance = { phase: 'declined', critical: false, cost: bill(800), available: true };
  const s = state({ deferredRepairs: [guard.id] });
  assert.notEqual(chooseCommanderAction(o, s).action?.kind, 'repair', 'the refund alone cannot cause a cancel/resume loop');
  o.stock.ferro = 100000;
  assert.deepEqual(chooseCommanderAction(o, s), { action: { kind: 'repair', unitId: guard.id }, reason: 'resume-repair' });
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'repair', 'a manual cancellation is not a commander-owned pause');
});

test('repair budgeting preserves essential damage, supplier payment and direct control, and compares only materials the repair consumes', () => {
  const o = observation({ stock: bill(500, 10000, 10000, 3000) }), guard = o.units[3]!;
  guard.ready = false; guard.auto = false;
  for (const patch of [{ critical: true, payer: null }, { critical: false, payer: 'supplier' }]) {
    guard.maintenance = { phase: 'repairing', cost: bill(800), ...patch };
    assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'cancel-repair');
  }
  guard.maintenance = { phase: 'repairing', critical: false, cost: bill(800), payer: null }; guard.manual = true;
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'cancel-repair');
  guard.manual = false;
  for (const patch of [{ auto: true }, { moving: true }, { haul: { depositId: 'iron', phase: 'out' as const } },
    { job: { kind: 'repair' as const, phase: 'deliver' as const, reason: '' } }]) {
    const working = structuredClone(o); Object.assign(working.units[3]!, patch);
    assert.notEqual(chooseCommanderAction(working, state()).action?.kind, 'cancel-repair',
      'a productive worker cannot be repeatedly interrupted by repair budgeting');
  }
  guard.manual = false; o.stock = bill(300000, 10000, 0, 3000);
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'cancel-repair', 'a silica shortage cannot justify cancelling an iron-only repair');
});

test('spare capital can restore income at its actual salvage value without selling the last guard or an active worker', () => {
  const o = observation({ stock: bill(1000, 10000, 10000, 3000), upgrades: [] });
  o.units = o.units.filter(unit => unit.id !== 'miner');
  const builder = o.units.find(unit => unit.builder)!; builder.salvage = bill(53223, 0, 1840, 200);
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'dismantle', unitId: builder.id }, reason: 'restore-mining' });
  for (const patch of [{ moving: true }, { calm: false }, { still: false }, { cargo: 1 },
    { job: { kind: 'build', phase: 'work', reason: '' } }, { salvage: bill(1) }]) {
    const other = structuredClone(o); Object.assign(other.units.find(unit => unit.builder)!, patch);
    assert.notEqual(chooseCommanderAction(other, state()).action?.kind, 'dismantle');
  }
  o.units = o.units.filter(unit => !unit.builder); o.units.find(unit => unit.armed)!.salvage = bill(40000);
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'dismantle', 'the final functional guard remains');
});

test('a siege preserves a priced military replacement before discretionary civilian restoration', () => {
  const o = besiegedBase(); o.units = o.units.filter(u => !u.builder); o.stock = bill(160000, 10000, 3056, 3000);
  assert.equal(chooseCommanderAction(o, state()).action, null, 'a replacement builder must not consume the last military silica');
  o.stock.silica = 4500;
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'manufacture', model: 'construction-truck' }, reason: 'restore-construction' },
    'civilian recovery proceeds once both actual purchases and the income reserve are funded');
});

test('restoring a fixed mine hauler preserves military materials that its safe income cannot replenish', () => {
  const o = fixedPlantIncome();
  o.upgrades = []; o.industry.levels.workshop = 2;
  o.stock = bill(100000, 10000, 2000, 3000);
  o.units = o.units.filter(u => u.id !== 'truck' && !u.builder);
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  o.bases = [{ id: 'rival', x: 3600, radius: 100, seen: false, at: 100, sheltered: false }];
  const replacement = { kind: 'manufacture', model: 'truck' };
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, replacement,
    'iron income cannot repay the military silica consumed by another hauler');
  o.stock.silica = 2359;
  assert.deepEqual(chooseCommanderAction(o, state()).action, replacement,
    'income recovery proceeds when the normally priced hauler leaves the next IFV silica payable');
  o.stock.silica = 2000;
  o.deposits.push({ ...o.deposits[0]!, id: 'silica', material: 'silica', x: 900, stock: 4000 });
  assert.deepEqual(chooseCommanderAction(o, state()).action, replacement,
    'ready silica on a safe known route can repay the recovery investment');
  o.danger = [{ lo: 850, hi: 950 }];
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, replacement,
    'an unsafe source cannot justify spending the last military input');
});

test('an emergency income vehicle needs an actual compatible productive route before consuming its budget', () => {
  const o = fixedPlantIncome(); o.upgrades = [];
  o.units = o.units.filter(u => u.id !== 'truck' && !u.builder);
  const replacement = { kind: 'manufacture', model: 'truck' };
  o.danger = [{ lo: 100, hi: 200 }];
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, replacement,
    'a live plant beyond a blocked corridor does not fund repeated civilian replacements');
  o.danger = [];
  assert.deepEqual(chooseCommanderAction(o, state()).action, replacement);
});

test('a known rival keeps a military replacement budget through a quiet gap in combat', () => {
  const o = besiegedBase();
  o.stock = bill(152767, 10000, 2926, 10000);
  o.units = o.units.filter(unit => !unit.builder);
  for (const unit of o.units) unit.combatAt = null;
  o.bases = [{ id: 'rival', x: 3600, radius: 100, seen: false, at: 100, sheltered: false }];
  o.works = [{ id: 'mine', model: 'mining-site', x: -2800, complete: false }];
  assert.notDeepEqual(chooseCommanderAction(o, state()).action,
    { kind: 'manufacture', model: 'construction-truck' },
    'an idle replacement constructor cannot spend the next defender during a gap in the local alarm');
  o.units = o.units.filter(unit => unit.id !== 'reserve');
  o.threats = [{ kind: 'contact', id: 'invader', x: 900, channel: 'seen', armed: true, grounded: true }];
  o.units.find(unit => unit.armed)!.x = 80;
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'ifv' },
    'the same normally priced stock can pay the defender when the attack returns');
});

test('a threatened base without a functional guard can buy a defender before income, and uses an affordable admitted fallback', () => {
  const o = besiegedBase(); o.units = o.units.filter(u => !u.armed && u.id !== 'miner');
  o.threats = [{ kind: 'contact', id: 'raider', x: 900, channel: 'seen', armed: true, grounded: true }];
  o.stock = bill(90000, 10000, 2000, 2000);
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'manufacture', model: 'ifv' }, reason: 'manufacture-defense' });
  o.stock = bill(30000, 10000, 1500, 2000);
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'manufacture', model: 'scout' }, reason: 'manufacture-defense' });
  o.stock.silica = 1200;
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'scout' }, 'no fallback can waive its material bill');
});

test('an owned capture warning prioritizes an affordable defender even without a current enemy contact', () => {
  const o = besiegedBase();
  o.units = o.units.filter(u => !u.armed && u.id !== 'miner');
  o.threats = []; o.batteries = []; o.bases = [];
  for (const u of o.units) u.combatAt = null;
  o.stock = bill(30000, 10000, 1500, 2000);
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'mining-truck' });
  o.besieged = true;
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'manufacture', model: 'scout' }, reason: 'manufacture-defense' },
    'the ordinary capture warning must not lose to the missing-income branch');
  o.stock.silica = 1200;
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'scout' },
    'an emergency still pays the complete normal material price');
});

test('capital recovered for lost income restores the miner before another guard while one functional guard remains', () => {
  const o = besiegedBase();
  o.units = o.units.filter(unit => unit.armed);
  o.stock = bill(10415, 10000, 7564, 1269);
  for (const guard of o.units) guard.combatAt = o.time;
  const spare = o.units[0]!, remaining = o.units[1]!;
  spare.salvage = bill(22063, 0, 1291, 203); remaining.salvage = bill(71157, 0, 1572, 203);
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'dismantle', unitId: spare.id }, reason: 'restore-mining' });
  // The ordinary dismantle pays the displayed stock value; on the next
  // decision the same alarm must not buy back the redundant guard first.
  o.units = [remaining];
  for (const material of ['ferro', 'ligas', 'silica', 'combustivel'] as const) o.stock[material] += spare.salvage[material];
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'manufacture', model: 'mining-truck' }, reason: 'restore-mining' });
});

test('counter-battery preparation uses recent precise reports and retains an existing direct guard', () => {
  const o = besiegedBase(); o.batteries = [{ x: -1800, error: 60, at: o.time - 5 }];
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'manufacture', model: 'mortar' }, reason: 'counter-battery' });
  const distant = structuredClone(o); distant.batteries[0]!.x = -3600;
  assert.deepEqual(chooseCommanderAction(distant, state()), { action: { kind: 'manufacture', model: 'mortar' }, reason: 'counter-battery' },
    'a precise report beyond 3 km remains answerable by the admitted physical range');
  for (const mark of [null, { x: -1800, error: 121, at: 195 }, { x: -1800, error: 60, at: 139 },
    { x: -1800, error: 60, at: 201 }, { x: -4490, error: 60, at: 195 }]) {
    const changed = structuredClone(o); changed.batteries = mark ? [mark] : [];
    assert.notDeepEqual(chooseCommanderAction(changed, state()).action, { kind: 'manufacture', model: 'mortar' }, JSON.stringify(mark));
  }
  const unquoted = structuredClone(o); delete unquoted.offers.find(offer => offer.model === 'mortar')!.artilleryRange;
  assert.notDeepEqual(chooseCommanderAction(unquoted, state()).action, { kind: 'manufacture', model: 'mortar' },
    'missing ballistic admission cannot become unlimited range');
  o.units[3]!.combatAt = null;
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'mortar' }, 'an unrelated report alone does not declare a siege');
});

test('a remembered fixed base does not send another lone defender to discover the same objective', () => {
  const o = besiegedBase(); o.time = 2000; o.units[3]!.combatAt = null;
  o.bases = [{ id: 'enemy-base', x: 4000, radius: 100, seen: false, at: 400, sheltered: false }];
  const waiting = state({ cooldowns: { 'operation:enemy-base': o.time + 300 } });
  assert.equal(chooseCommanderAction(o, waiting).action, null,
    'operation cooldown preserves an already surveyed objective instead of launching a fresh solo reconnaissance');
  o.bases[0]!.at = null;
  assert.equal(chooseCommanderAction(o, waiting).action?.kind, 'reconnoitre',
    'an unknown objective still allows ordinary reconnaissance with the home guard preserved');
});

test('artillery under construction prevents duplicate purchases but never substitutes a direct defender', () => {
  const o = besiegedBase(); o.batteries = [{ x: -1800, error: 60, at: 195 }];
  o.units.push(unit('mortar', { armed: true, artillery: true, stance: 'fire', ready: false }));
  assert.equal(chooseCommanderAction(o, state()).action, null);
  o.units = o.units.filter(u => u.id !== 'reserve');
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'manufacture', model: 'ifv' }, reason: 'manufacture-defense' });
});

test('a safe empty departure can supply the actual military material shortage during a siege', () => {
  const o = besiegedBase(); o.stock = bill(82000, 10000, 1216, 2000);
  Object.assign(o.units[0]!, { moving: false, atDepot: true, haul: { depositId: 'iron', phase: 'out' } });
  o.deposits.push({ id: 'silica', x: 500, material: 'silica', reserve: 60000, left: 60000, stock: 0, seen: true, at: null });
  assert.deepEqual(chooseCommanderAction(o, state({ orders: { miner: { kind: 'haul', depositId: 'iron' } } })),
    { action: { kind: 'haul', unitId: 'miner', depositId: 'silica' }, reason: 'collect-material' });
});

test('the commander is a deterministic reader and can order only a known safe source', () => {
  const o = observation(); Object.assign(o.units[0]!, { haul: null, moving: false, atDepot: true });
  const s = state(), before = structuredClone([o, s]); freeze(o); freeze(s);
  const choice = chooseCommanderAction(o, s);
  assert.deepEqual(choice.action, { kind: 'haul', unitId: 'miner', depositId: 'iron' });
  assert.deepEqual(chooseCommanderAction(o, s), choice);
  assert.deepEqual([o, s], before, 'planning changes neither physical observation nor strategic memory');
  const unknown = observation({ deposits: o.deposits.filter(site => site.material !== 'ferro'), upgrades: [] });
  Object.assign(unknown.units[0]!, { haul: null, moving: false, atDepot: true });
  assert.equal(chooseCommanderAction(unknown, state()).action?.kind, 'explore', 'missing geology leads to reconnaissance, not an invented deposit');
});

test('normal recovery takes priority and a missing base never permits fabrication', () => {
  assert.deepEqual(chooseCommanderAction(observation({ base: null, units: [], recovery: { offered: true } }), state()),
    { action: { kind: 'recover' }, reason: 'recover' });
  assert.deepEqual(chooseCommanderAction(observation({ base: null, recovery: { offered: false } }), state()), { action: null, reason: 'no-base' });
  assert.deepEqual(chooseCommanderAction(observation(), state({ enabled: false })), { action: null, reason: 'disabled' });
});

test('losing the only miner restores income before discretionary improvements', () => {
  const o = observation({ stock: bill(100000, 10000, 10000, 2000) }); o.units = o.units.filter(unit => unit.id !== 'miner');
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'manufacture', model: 'mining-truck' }, reason: 'restore-mining' });
  o.offers = [];
  assert.equal(chooseCommanderAction(o, state()).action, null, 'without an admitted offer the policy cannot create a catalogue exception');
});

test('an idle petroleum carrier secures fuel before an otherwise affordable workshop', () => {
  const o = observation({ stock: bill(120000, 10000, 10000, 1000) });
  Object.assign(o.units[1]!, { moving: false, atDepot: true, haul: null });
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'haul', unitId: 'tanker', depositId: 'oil' }, reason: 'secure-fuel' });
});

test('discretionary upgrades retain a replacement miner and the selected fuel buffer', () => {
  const o = observation({ stock: bill(85000, 10000, 10000, 2000) });
  assert.equal(chooseCommanderAction(o, state()).action, null, 'an affordable upgrade must not remove the only means of replacing lost mining income');
  o.stock = bill(100000, 10000, 10000, 900);
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'upgrade', upgrade: 'workshop-ii' });
  assert.equal(chooseCommanderAction(o, state({ profile: 'cautious' })).action, null, 'caution changes reserves, not the price or physical output');
});

test('ongoing hauls, moves, dispatch jobs and services are preserved', () => {
  const o = observation({ upgrades: [] });
  o.deposits.push({ ...o.deposits[0]!, id: 'closer-iron', x: 150 });
  assert.equal(chooseCommanderAction(o, state()).action, null, 'a shorter newly known route does not interrupt a live haul');
  for (const patch of [
    { haul: null, moving: false, ready: false },
    { haul: null, moving: true },
    { haul: null, moving: false, job: { kind: 'repair', phase: 'deliver', reason: '' } },
    { haul: null, moving: false, job: { kind: null, phase: 'return', reason: '' } },
    { haul: null, moving: false, job: { kind: null, phase: 'paused', reason: 'manual-control' } },
  ]) {
    Object.assign(o.units[0]!, { ready: true, haul: null, moving: false, job: { kind: null, phase: 'idle', reason: '' } }, patch);
    assert.equal(chooseCommanderAction(o, state()).action, null);
  }
});

test('danger can interrupt a live haul for withdrawal but does not repeatedly replace an existing return', () => {
  const o = observation({ upgrades: [], danger: [{ lo: 600, hi: 700 }] });
  o.units[0]!.x = 300;
  assert.deepEqual(chooseCommanderAction(o, state({ blocked: { miner: { reason: 'enemy-near', until: 300 } } })),
    { action: { kind: 'home', unitId: 'miner' }, reason: 'retreat' });
  o.units[0]!.home = true;
  const next = chooseCommanderAction(o, state()).action;
  assert(!next || !('unitId' in next) || next.unitId !== 'miner', 'an independent unit may act, but the returning miner is not redirected');
  o.units[0]!.home = false; o.units[0]!.haul!.phase = 'home';
  const haulingHome = chooseCommanderAction(o, state()).action;
  assert(!haulingHome || !('unitId' in haulingHome) || haulingHome.unitId !== 'miner', 'the normal haul return is already a withdrawal, without an explicit Home order');
});

test('the scout is placed on local free fire once, preserving its existing anchor', () => {
  const o = observation({ upgrades: [] }); o.units[3]!.stance = 'return';
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'stance', unitId: 'scout', stance: 'fire' }, reason: 'local-defense' });
  o.units[3]!.stance = 'fire';
  assert.equal(chooseCommanderAction(o, state()).action, null, 'the planner does not re-anchor free fire every cycle');
});

test('a stale depleted source is revisited after cooldown without reading its real reserve', () => {
  const o = observation({ upgrades: [], time: 200 });
  Object.assign(o.units[0]!, { haul: null, moving: false, atDepot: true, job: { kind: null, phase: 'paused', reason: 'manual-order' } });
  Object.assign(o.deposits[0]!, { left: 0, stock: 0, at: 0, seen: false });
  const action = { kind: 'haul', unitId: 'miner', depositId: 'iron' } as const,
    s = state({ cooldowns: { [commanderActionKey(action)]: 250 } });
  assert.equal(chooseCommanderAction(o, s).action, null);
  o.time = 251;
  assert.deepEqual(chooseCommanderAction(o, s), { action, reason: 'revisit-source' });
  o.deposits[0]!.seen = true;
  assert.equal(chooseCommanderAction(o, s).action, null, 'a current empty observation is not replaced by imagined regeneration');
});

test('hazardous routes and blocked actors are not retried as ordinary collection', () => {
  const o = observation({ upgrades: [] }); Object.assign(o.units[0]!, { haul: null, moving: false, atDepot: true });
  o.danger = [{ lo: 300, hi: 700 }]; o.deposits.push({ ...o.deposits[0]!, id: 'safe-iron', x: -1200 });
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'haul', unitId: 'miner', depositId: 'safe-iron' });
  assert.equal(chooseCommanderAction(o, state({ blocked: { miner: { reason: 'stuck-ground', until: 250 } } })).action, null);
});

test('an open work blocks optional spending and a new mine reserves its future transporter', () => {
  const o = observation({ stock: bill(200000, 10000, 10000, 3000), works: [{ id: 'work', model: 'mining-site', x: 1000, complete: false }] });
  assert.deepEqual(chooseCommanderAction(o, state()), { action: null, reason: 'waiting-service' });
  o.works = []; o.industry.levels.workshop = 2; o.upgrades = []; o.stock.ferro = 60000;
  o.units.push(unit('ifv', { armed: true, stance: 'fire' }));
  o.offers.push({ model: 'truck', cost: bill(23850, 0, 787, 203) }, { model: 'mining-site', cost: bill(10715, 0, 2240, 203), x: 655, facing: 1 });
  assert.equal(chooseCommanderAction(o, state()).action?.kind, 'reconnoitre', 'without spending the mine reserve a prepared spare may reconnoitre');
  o.stock.ferro = 100000;
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'build', model: 'mining-site', x: 655, facing: 1 });
});

test('fixed production follows material coverage of the next paid purchase, rather than only the nearest vein', () => {
  for (const direction of [-1, 1] as const) for (const [stock, material] of [
    [bill(400000, 10000, 10000, 4000), 'ferro'],
    [bill(350000, 10000, 4000, 4000), 'silica'],
  ] as const) {
    const o = observation({ stock, upgrades: [], explored: [[-2000, 2000]],
      industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
    o.units.push(unit('reserve', { armed: true, stance: 'fire' }));
    o.deposits[0]!.x = direction * 1800;
    o.deposits.push({ ...o.deposits[0]!, id: 'silica', material: 'silica', x: direction * 400 });
    o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) },
      { model: 'truck', cost: bill(23850, 0, 787, 203) },
      { model: 'mining-site', cost: bill(10715, 0, 2240, 203), x: direction * 405, facing: direction },
      { model: 'mining-site', cost: bill(10715, 0, 2240, 203), x: direction * 1805, facing: direction });
    const chosen = chooseCommanderAction(o, state()).action;
    assert(chosen?.kind === 'build');
    assert.equal(chosen.x, direction * (material === 'ferro' ? 1805 : 405),
      'both orientations use the actual material budget; lower silica coverage selects silica');
    if (material === 'ferro') {
      o.danger = [{ lo: Math.min(direction * 1700, direction * 1900), hi: Math.max(direction * 1700, direction * 1900) }];
      Object.assign(o.units[0]!, { moving: false, atDepot: true, haul: null });
      const safer = chooseCommanderAction(o, state()).action;
      assert(safer?.kind === 'build');
      assert.equal(safer.x, direction * 405, 'a production target does not authorize a dangerous working route');
    }
  }
});

test('a second extractor can diversify while the original iron haul continues', () => {
  const o = observation({ stock: bill(60000, 10000, 2000, 2000) });
  o.units.push(unit('second-miner', { extracts: ['ferro', 'silica', 'ligas'], carries: ['ferro', 'silica', 'ligas'] }));
  o.deposits.push({ ...o.deposits[0]!, id: 'silica', material: 'silica', x: 900 });
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'haul', unitId: 'second-miner', depositId: 'silica' });
  assert.equal(o.units[0]!.haul?.depositId, 'iron');
});

test('a new fixed mine receives its mouth from the mobile extractor without discarding an ongoing return', () => {
  const o = observation({ upgrades: [], works: [{ id: 'plant', model: 'mining-site', x: 655, complete: false }] }),
    miner = o.units[0]!, stop = { kind: 'stop', unitId: 'miner' } as const;
  assert.deepEqual(chooseCommanderAction(o, state()), { action: stop, reason: 'release-mining-site' });
  assert.equal(commanderActionKey(stop), 'stop:miner');
  o.works[0]!.complete = true;
  assert.deepEqual(chooseCommanderAction(o, state()).action, stop, 'a completed plant also needs the mouth released');
  for (const patch of [
    { haul: { depositId: 'iron', phase: 'home' }, cargo: 2000 },
    { haul: { depositId: 'iron', phase: 'unload' }, cargo: 2000 },
    { ready: false },
    { job: { kind: null, phase: 'paused', reason: 'manual-control' } },
  ]) {
    Object.assign(miner, { ready: true, cargo: 0, haul: { depositId: 'iron', phase: 'out' }, job: null }, patch);
    assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'stop');
  }
  Object.assign(miner, { ready: true, job: null, haul: { depositId: 'iron', phase: 'out' } });
  assert.equal(chooseCommanderAction(o, state({ cooldowns: { [commanderActionKey(stop)]: 205 } })).action, null,
    'a short stop cooldown does not restart the conflicting haul');
});

test('after releasing a fixed mine, a mobile miner uses another known source or clears the mouth home', () => {
  const o = observation({ upgrades: [], works: [{ id: 'plant', model: 'mining-site', x: 655, complete: true }] }), miner = o.units[0]!;
  Object.assign(miner, { x: 650, haul: null, moving: false, auto: false, atDepot: false, job: { kind: null, phase: 'paused', reason: 'manual-stop' } });
  assert.deepEqual(chooseCommanderAction(o, state()), { action: { kind: 'home', unitId: 'miner' }, reason: 'release-mining-site' });
  o.deposits.push({ ...o.deposits[0]!, id: 'other-iron', x: -700 });
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'haul', unitId: 'miner', depositId: 'other-iron' });
  miner.auto = true;
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'stop', unitId: 'miner' }, 'disable automatic pickup before handing the mouth to the transporter');
  o.works = [];
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'haul', unitId: 'miner', depositId: 'iron' }, 'an absent or destroyed plant no longer owns the source');
});

test('an empty builder clears a completed plant for transport but is left alone while working or servicing', () => {
  const o = observation({ upgrades: [], works: [{ id: 'plant', model: 'mining-site', x: 655, complete: true }] }),
    builder = o.units[2]!;
  Object.assign(o.units[0]!, { auto: false, moving: false, haul: null, atDepot: true });
  Object.assign(builder, { x: 662, atDepot: false });
  const home = { kind: 'home', unitId: 'builder' } as const;
  assert.deepEqual(chooseCommanderAction(o, state()), { action: home, reason: 'release-mining-site' });
  for (const patch of [
    { ready: false }, { moving: true }, { home: true },
    { job: { kind: 'build', phase: 'work', reason: '' } },
    { job: { kind: null, phase: 'paused', reason: 'manual-control' } },
  ]) {
    Object.assign(builder, { ready: true, moving: false, home: false, job: null }, patch);
    assert.notDeepEqual(chooseCommanderAction(o, state()).action, home);
  }
  Object.assign(builder, { ready: true, moving: false, home: false, job: null });
  o.works[0]!.complete = false;
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, home, 'the crane stays beside an unfinished plant');
});

test('a fixed plant restores a lost dedicated transporter using its remaining ordinary funds', () => {
  const o = observation({ stock: bill(30000, 10000, 1500, 1000), upgrades: [],
    works: [{ id: 'plant', model: 'mining-site', x: 655, complete: true }] });
  Object.assign(o.units[0]!, { auto: false, haul: null, moving: false, atDepot: true });
  o.units.push(unit('plant', { vehicle: false, x: 655, atDepot: false, extracts: ['ferro', 'silica', 'ligas'] }));
  o.offers.push({ model: 'truck', cost: bill(23850, 0, 787, 203) });
  const before = structuredClone(o), action = { kind: 'manufacture', model: 'truck' } as const;
  assert.deepEqual(chooseCommanderAction(o, state()), { action, reason: 'restore-mining' });
  assert.deepEqual(o, before, 'restoration spends through a normal command; the planner cannot credit resources');
  assert.equal(chooseCommanderAction(o, state({ cooldowns: { [commanderActionKey(action)]: 250 } })).action, null);
  o.stock.ferro = 23849;
  assert.equal(chooseCommanderAction(o, state()).action, null, 'a required transporter still needs its complete official price');
  o.stock.ferro = 30000;
  o.units.push(unit('busy-truck', { carries: ['ferro'], moving: true, atDepot: false, haul: { depositId: 'iron', phase: 'out' } }));
  assert.equal(chooseCommanderAction(o, state()).action, null, 'a busy existing transporter must not cause another purchase');
  o.units.pop(); o.offers = o.offers.filter(offer => offer.model !== 'truck');
  assert.equal(chooseCommanderAction(o, state()).action, null, 'without an admitted truck offer no substitute price or vehicle is invented');
});

test('an operating fixed plant can replace a lost builder after its mobile miner is lost', () => {
  const o = fixedPlantIncome();
  o.units = o.units.filter(unit => unit.id !== 'builder'); o.upgrades = [];
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'manufacture', model: 'construction-truck' }, reason: 'restore-construction' });
});

test('an operating fixed plant can improve the workshop after its mobile miner is lost', () => {
  assert.deepEqual(chooseCommanderAction(fixedPlantIncome(), state()),
    { action: { kind: 'upgrade', upgrade: 'workshop-ii' }, reason: 'improve-workshop' });
});

test('an operating fixed plant can restore local defense after its mobile miner is lost', () => {
  const o = fixedPlantIncome(); o.upgrades = []; o.industry.levels.workshop = 2;
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'manufacture', model: 'ifv' }, reason: 'manufacture-defense' });
});

test('urgent fuel restores a missing tanker at its official price without requiring a second reserve', () => {
  const o = observation({ stock: bill(30000, 10000, 10000, 250), upgrades: [] });
  o.units = o.units.filter(unit => unit.id !== 'tanker');
  const before = structuredClone(o), action = { kind: 'manufacture', model: 'tanker' } as const;
  assert.deepEqual(chooseCommanderAction(o, state()), { action, reason: 'secure-fuel' });
  assert.deepEqual(o, before, 'restoration cannot credit stocks or change an existing income haul');
  assert.equal(chooseCommanderAction(o, state({ cooldowns: { [commanderActionKey(action)]: 250 } })).action, null);
  o.units.push(unit('tanker-under-service', { extracts: ['petroleo'], carries: ['petroleo'], ready: false }));
  assert.equal(chooseCommanderAction(o, state()).action, null, 'a present tanker in service is not a missing tanker');
});

test('tanker recovery preserves reserves outside an emergency and requires payment and a safe known supply route', () => {
  for (const scenario of [
    { name: 'ample fuel preserves the replacement-miner reserve', stock: bill(30000, 10000, 10000, 1500), danger: [] },
    { name: 'urgent fuel does not waive the iron invoice', stock: bill(29687, 10000, 10000, 250), danger: [] },
    { name: 'urgent fuel does not waive the fuel invoice', stock: bill(30000, 10000, 10000, 202), danger: [] },
    { name: 'urgent fuel does not justify a dangerous petroleum route', stock: bill(30000, 10000, 10000, 250), danger: [{ lo: -1000, hi: -700 }] },
  ]) {
    const o = observation({ stock: scenario.stock, danger: scenario.danger, upgrades: [] });
    o.units = o.units.filter(unit => unit.id !== 'tanker');
    assert.notDeepEqual(chooseCommanderAction(o, state()).action, { kind: 'manufacture', model: 'tanker' }, scenario.name);
  }
});

test('local defense recalls only its own reconnaissance when a nearby threat allows that interruption', () => {
  const scenarios: { name: string; threats: CommanderThreat[]; patch?: Partial<CommanderUnit>; ownExplore?: boolean; recall?: boolean }[] = [
    { name: 'a nearby threat recalls the commander scout', threats: [{ kind: 'signal', x: 500 }], recall: true },
    { name: 'quiet reconnaissance continues', threats: [] },
    { name: 'a distant threat does not recall reconnaissance', threats: [{ kind: 'signal', x: 2000 }] },
    { name: 'a service retains the scout', threats: [{ kind: 'signal', x: 500 }], patch: { ready: false } },
    { name: 'manual control retains the scout', threats: [{ kind: 'signal', x: 500 }], patch: { job: { kind: null, phase: 'paused', reason: 'manual-control' } } },
    { name: 'an existing return continues', threats: [{ kind: 'signal', x: 500 }], patch: { home: true } },
    { name: 'an active supply haul continues', threats: [{ kind: 'signal', x: 500 }], patch: { supply: true, haul: { depositId: 'supply-drop', phase: 'out' } } },
    { name: 'a move not issued as reconnaissance retains its owner', threats: [{ kind: 'signal', x: 500 }], ownExplore: false },
  ];
  for (const scenario of scenarios) {
    const o = observation({ threats: scenario.threats, upgrades: [] });
    Object.assign(o.units[3]!, { x: -1200, atBase: false, atDepot: false, moving: true, ...scenario.patch });
    const s = state({ orders: scenario.ownExplore === false ? {} : { scout: { kind: 'explore', x: -2000 } } }),
      choice = chooseCommanderAction(o, s);
    if (scenario.recall) assert.deepEqual(choice, { action: { kind: 'home', unitId: 'scout' }, reason: 'local-defense' }, scenario.name);
    else assert(!choice.action || !('unitId' in choice.action) || choice.action.unitId !== 'scout', scenario.name);
  }
});

test('military reconnaissance accepts a known contested corridor but yields to damage, terrain, services and base defense', () => {
  const o = observation({ upgrades: [], danger: [{ lo: 2000, hi: 4000 }],
    threats: [{ kind: 'contact', id: 'enemy', x: 3500, channel: 'seen', armed: true, grounded: true }] });
  Object.assign(o.units[3]!, { x: 2500, atBase: false, atDepot: false, moving: true });
  const s = state({ orders: { scout: { kind: 'reconnoitre', x: 3800 } } });
  assert.equal(chooseCommanderAction(o, s).action, null, 'a prepared military scout can identify a base beyond the first threat');
  s.orders.scout = { kind: 'explore', x: 3800 };
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'home', unitId: 'scout' }, 'a resource survey still withdraws from that corridor');
  s.orders.scout = { kind: 'reconnoitre', x: 3800 };
  for (const patch of [{ health: .7 }, { ammoRatio: .4 }, { fuel: 80 }, { halt: 'stuck-slope', moving: false }]) {
    const damaged = structuredClone(o); Object.assign(damaged.units[3]!, patch);
    assert.deepEqual(chooseCommanderAction(damaged, s).action, { kind: 'home', unitId: 'scout' });
  }
  for (const patch of [{ ready: false }, { job: { kind: null, phase: 'paused', reason: 'manual-control' } }]) {
    const protectedUnit = structuredClone(o); Object.assign(protectedUnit.units[3]!, patch);
    assert.equal(chooseCommanderAction(protectedUnit, s).action, null, 'the service or driver retains the unit');
  }
  o.threats = [{ kind: 'contact', id: 'raider', x: 1700, channel: 'seen', armed: true, grounded: true }];
  assert.deepEqual(chooseCommanderAction(o, s), { action: { kind: 'home', unitId: 'scout' }, reason: 'local-defense' });
});

test('military exploration needs an available guard in the base, beyond merely owning a second defender', () => {
  const o = observation({ upgrades: [], industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
  o.units.push(unit('spare', { armed: true, stance: 'fire' }));
  Object.assign(o.units[3]!, { ready: false, atBase: false, atDepot: false });
  assert.equal(chooseCommanderAction(o, state()).action?.kind, undefined, 'the only available guard stays in the yard');
  o.units[3]!.ready = true;
  assert.equal(chooseCommanderAction(o, state()).action?.kind, 'reconnoitre', 'the spare in the base covers the existing explorer');
});

function preparingForce() {
  const o = observation({ stock: bill(200000, 10000, 2212, 3000), upgrades: [],
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false },
    explored: [[-1000, 4000]], bases: [{ id: 'enemy', x: 3000, radius: 100, seen: true, at: null, sheltered: false }] });
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  o.units.push(unit('spare', { armed: true, stance: 'fire' }));
  const s = state({ operation: { phase: 'prepare', targetId: 'enemy', targetX: 3000, startedAt: 180, until: 1380 } });
  return { o, s };
}

test('a failed owned outbound trip gets one return, preserving drivers, services and existing returns', () => {
  const o = observation({ upgrades: [] }), miner = o.units[0]!;
  Object.assign(miner, { x: 400, atBase: false, atDepot: false, moving: false, halt: 'stuck-slope' });
  const s = state({ blocked: { miner: { reason: 'stuck-slope', until: 800 } }, orders: { miner: { kind: 'haul', depositId: 'iron' } } });
  assert.deepEqual(chooseCommanderAction(o, s), { action: { kind: 'home', unitId: 'miner' }, reason: 'recover-mobility' });
  for (const patch of [
    { ready: false }, { moving: true }, { aircraft: true }, { home: true }, { halt: 'immobile' },
    { job: { kind: null, phase: 'paused', reason: 'manual-control' } },
    { job: { kind: 'repair', phase: 'working', reason: '' } }, { haul: { depositId: 'iron', phase: 'home' }, cargo: 2000 },
  ]) {
    const protectedState = structuredClone(o); Object.assign(protectedState.units[0]!, patch);
    assert.notDeepEqual(chooseCommanderAction(protectedState, s).action, { kind: 'home', unitId: 'miner' }, JSON.stringify(patch));
  }
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, { kind: 'home', unitId: 'miner' }, 'an unknown failed order is not taken over');
  s.orders.miner = { kind: 'home' }; miner.haul = null; o.time = 1000;
  const next = chooseCommanderAction(o, s).action;
  assert(!(next && 'unitId' in next && next.unitId === miner.id),
    'an expired block does not restart a failed return or resend the original haul; a paid replacement is separate');
});

test('a stranded defender cannot fund the guard count, while a vehicle being built at home still counts', () => {
  const o = observation({ stock: bill(200000, 10000, 10000, 3000), upgrades: [],
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  const stuck = o.units[3]!; Object.assign(stuck, { x: 800, atBase: false, atDepot: false, halt: 'stuck-slope' });
  o.units.push(unit('guard', { armed: true, stance: 'fire' }));
  const s = state({ orders: { scout: { kind: 'home' } } });
  assert.deepEqual(chooseCommanderAction(o, s), { action: { kind: 'manufacture', model: 'ifv' }, reason: 'manufacture-defense' });
  Object.assign(stuck, { x: 0, atBase: true, atDepot: true, ready: false, halt: '' });
  assert.notEqual(chooseCommanderAction(o, s).action?.kind, 'manufacture', 'do not buy the same replacement on every cycle while it is being built');
});

test('resource surveys keep the stronger home guard when another faction is known', () => {
  const o = observation({ upgrades: [], industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false },
    bases: [{ id: 'rival', x: 3000, radius: 100, seen: true, at: null, sheltered: false }] });
  o.deposits = o.deposits.filter(site => site.material !== 'petroleo');
  o.units[3]!.maxHealth = 725;
  o.units.push(unit('heavy', { armed: true, stance: 'fire', maxHealth: 905 }));
  assert.equal(chooseCommanderAction(o, state()).action?.kind, 'explore');
  assert.equal((chooseCommanderAction(o, state()).action as { unitId: string }).unitId, 'scout');
  o.units = o.units.filter(unit => unit.id !== 'scout');
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'builder', x: 1800 },
    'an idle utility surveys while the last available guard stays home');
  o.bases = [];
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'builder', x: 1800 },
    'an unlocated rival does not justify sending the only guard when an idle utility can survey');
  o.units = o.units.filter(unit => !unit.builder);
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'heavy', x: 1800 }, 'an uncontested opening can still find its essential resources with one scout');
});

test('a quiet interval after combat does not reopen the lone-guard resource survey exception', () => {
  const guard = unit('guard', { armed: true, stance: 'fire' }),
    o = observation({ time: 3600, upgrades: [], units: [
      unit('miner', { extracts: ['ferro'], carries: ['ferro'], moving: true,
        atDepot: false, haul: { depositId: 'iron', phase: 'out' } }), guard,
    ] });
  o.deposits = o.deposits.filter(site => site.material !== 'petroleo');
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'guard', x: 1800 },
    'a genuinely uncontested opening may locate essential resources');
  for (const survivor of o.units) {
    survivor.combatAt = 1;
    assert.equal(chooseCommanderAction(o, state()).action, null,
      'an old report on either survivor still means the opening has already met combat');
    survivor.combatAt = null;
  }
  guard.combatAt = 1;
  o.units.push(unit('utility', { builder: true }));
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'utility', x: 1800 },
    'the guard reserve does not prevent utility resource exploration');
  o.units.pop();
  o.units.push(unit('spare', { armed: true, stance: 'fire', maxHealth: guard.maxHealth - 1 }));
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'spare', x: 1800 },
    'a second combat vehicle may still explore while the stronger guard remains');
});

test('an owned local defense approach accepts its declared threat without a contradictory routine retreat', () => {
  const guard = unit('guard', { armed: true, stance: 'fire', x: 20, moving: true }),
    o = observation({ units: [guard], offers: [], upgrades: [], danger: [{ lo: -100, hi: 100 }],
      threats: [{ kind: 'signal', x: 500 }] }),
    s = state({ orders: { guard: { kind: 'defend', x: 80 } } });
  assert.equal(chooseCommanderAction(o, s).action, null, 'the perceived threat is the reason for this bounded defense');
  guard.health = .4;
  assert.deepEqual(chooseCommanderAction(o, s), { action: { kind: 'home', unitId: 'guard' }, reason: 'retreat' },
    'serious damage still permits withdrawal');
  Object.assign(guard, { moving: false, x: 0 });
  s.orders.guard = { kind: 'home' };
  assert.equal(chooseCommanderAction(o, s).action, null, 'the wounded guard waits at its service point rather than being sent forward again');
  guard.health = 1;
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'defend', unitId: 'guard', x: 80 }, 'normal defense resumes after recovery');
});

test('resource surveys retain a home guard before any rival base has been identified', () => {
  const o = observation({ upgrades: [], industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
  o.deposits = o.deposits.filter(site => site.material !== 'petroleo');
  o.units[3]!.maxHealth = 725;
  o.units.push(unit('heavy', { armed: true, stance: 'fire', maxHealth: 905 }));
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'scout', x: 1800 });
  Object.assign(o.units[3]!, { atBase: false, atDepot: false, moving: true, x: 1200 });
  const s = state({ orders: { scout: { kind: 'explore', x: 1800 } } });
  assert.equal(chooseCommanderAction(o, s).action, null, 'a second survey cannot send the remaining guard after the first');
  Object.assign(o.units[3]!, { atBase: true, atDepot: true, moving: false, x: 0 });
  o.units.at(-1)!.ready = false;
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'explore', unitId: 'builder', x: 1800 },
    'the utility can survey, but a paid unfinished guard does not cover the remaining prepared guard departure');
});

test('stored fuel funds a missing defender without inventing a tanker or waiving its price and fuel reserve', () => {
  const { o, s } = preparingForce(); o.stock.silica = 6000;
  o.units = o.units.filter(unit => unit.id !== 'tanker'); o.deposits = o.deposits.filter(site => site.material !== 'petroleo');
  assert.deepEqual(chooseCommanderAction(o, s), { action: { kind: 'manufacture', model: 'ifv' }, reason: 'manufacture-defense' });
  for (const stock of [bill(200000, 10000, 6000, 705), bill(71156, 10000, 6000, 3000)]) {
    o.stock = stock;
    assert.notDeepEqual(chooseCommanderAction(o, s).action, { kind: 'manufacture', model: 'ifv' }, 'military supply still pays the complete quote and preserves its fuel reserve');
  }
});

test('the third military vehicle drives the same material request as its actual purchase', () => {
  const { o, s } = preparingForce();
  o.units.push(unit('second-miner', { extracts: ['ferro', 'ligas', 'silica'], carries: ['ferro', 'ligas', 'silica'] }));
  o.deposits.push({ ...o.deposits[0]!, id: 'silica', material: 'silica', x: 900 });
  const before = structuredClone([o, s]);
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: 'second-miner', depositId: 'silica' });
  assert.deepEqual([o, s], before, 'the existing iron route and all stock remain owned by the normal command path');
});

test('a sole miner may change material on its own empty outbound departure without requiring a second miner', () => {
  const { o, s } = preparingForce(); o.stock = bill(150000, 10000, 1000, 3000);
  o.deposits.push({ ...o.deposits[0]!, id: 'silica', material: 'silica', x: 900 });
  Object.assign(o.units[0]!, { x: 0, atBase: true, atDepot: true, cargo: 0 });
  s.orders.miner = { kind: 'haul', depositId: 'iron' };
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: 'miner', depositId: 'silica' });
  for (const patch of [
    { cargo: 1 }, { ready: false }, { atBase: false, atDepot: false }, { home: true },
    { haul: { depositId: 'iron', phase: 'home' } },
    { job: { kind: null, phase: 'paused', reason: 'manual-control' } },
  ]) {
    const protectedTrip = structuredClone(o); Object.assign(protectedTrip.units[0]!, patch);
    assert.notDeepEqual(chooseCommanderAction(protectedTrip, s).action, { kind: 'haul', unitId: 'miner', depositId: 'silica' }, JSON.stringify(patch));
  }
  const foreign = structuredClone(s); delete foreign.orders.miner;
  assert.notDeepEqual(chooseCommanderAction(o, foreign).action, { kind: 'haul', unitId: 'miner', depositId: 'silica' }, 'an existing trip without matching strategic ownership is preserved');
  const supplied = structuredClone(o), returningToIron = structuredClone(s);
  supplied.stock.silica = 6000; supplied.units[0]!.haul = { depositId: 'silica', phase: 'out' };
  returningToIron.orders.miner = { kind: 'haul', depositId: 'silica' };
  assert.deepEqual(chooseCommanderAction(supplied, returningToIron).action, { kind: 'haul', unitId: 'miner', depositId: 'iron' }, 'normal iron income resumes once the material gap is filled');
  o.stock.ferro = 100000;
  assert.deepEqual(chooseCommanderAction(o, s).action, { kind: 'haul', unitId: 'miner', depositId: 'silica' },
    'collecting a missing material does not require the complete future purchase budget; ordinary iron income resumes after the gap is filled');
});

test('preparation lets a necessary resource survey finish and recalls it only after the missing purchase is funded', () => {
  const { o, s } = preparingForce();
  const exploration = chooseCommanderAction(o, s).action;
  assert(exploration?.kind === 'explore' && exploration.unitId === 'spare', 'the guard remains home while the missing geology is surveyed');
  Object.assign(o.units.at(-1)!, { atBase: false, atDepot: false, moving: true, x: 1500 });
  s.orders.spare = { kind: 'explore', x: exploration.x };
  assert.equal(chooseCommanderAction(o, s).action, null, 'assembly cannot immediately undo its own necessary material survey');
  o.stock.silica = 3000;
  assert.deepEqual(chooseCommanderAction(o, s), { action: { kind: 'home', unitId: 'spare' }, reason: 'rally-force' });
});

test('interception owns its dangerous approach and keeps the last guard home through the return', () => {
  const o = observation({ upgrades: [], deposits: [observation().deposits[0]!], danger: [{ lo: 800, hi: 3000 }],
    threats: [{ kind: 'contact', id: 'enemy', x: 2000, channel: 'seen', armed: true, grounded: true }] });
  o.units.push(unit('spare', { armed: true, stance: 'fire', x: 900, atBase: false, atDepot: false, moving: true }));
  const s = state({ orders: { spare: { kind: 'intercept', targetId: 'enemy', x: 1800, until: 380 } } }),
    spare = o.units.at(-1)!;
  assert.equal(chooseCommanderAction(o, s).action, null,
    'routine danger retreat cannot cancel the approach or send the remaining guard exploring for the missing oil');
  spare.x = 1800; spare.moving = false;
  assert.deepEqual(chooseCommanderAction(o, s),
    { action: { kind: 'attack', unitId: 'spare', targetId: 'enemy' }, reason: 'intercept-contact' });
  o.time = 380; spare.attack = 'enemy';
  assert.deepEqual(chooseCommanderAction(o, s),
    { action: { kind: 'home', unitId: 'spare' }, reason: 'end-interception' });
  s.orders.spare = { kind: 'home' }; spare.home = true; spare.moving = true; spare.attack = null;
  assert.equal(chooseCommanderAction(o, s).action, null, 'exploration cannot pull the last guard out while the interceptor returns');
  Object.assign(spare, { x: 0, atBase: true, atDepot: true, home: false, moving: false });
  assert.equal(chooseCommanderAction(o, s).action?.kind, 'explore', 'ordinary reconnaissance resumes after the reserve physically returns');
});

test('a completed guard complement still replenishes scarce replacement materials before a loss', () => {
  const o = observation({ stock: bill(150000, 10000, 1800, 3000), upgrades: [],
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false } });
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  o.units.push(unit('guard', { armed: true, stance: 'fire' }),
    unit('spare-miner', { extracts: ['ferro', 'silica', 'ligas'], carries: ['ferro', 'silica', 'ligas'] }));
  o.deposits.push({ ...o.deposits[0]!, id: 'silica', material: 'silica', x: 900 });
  assert.deepEqual(chooseCommanderAction(o, state()),
    { action: { kind: 'haul', unitId: 'spare-miner', depositId: 'silica' }, reason: 'collect-material' });
});

test('an idle utility vehicle can survey missing materials without removing the only home guard', () => {
  const o = observation({ stock: bill(18000, 10000, 206, 3000), upgrades: [],
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false },
    bases: [{ id: 'rival', x: 6000, radius: 100, seen: false, at: 0, sheltered: false }] });
  o.offers.push({ model: 'ifv', cost: bill(71157, 0, 1572, 203) });
  const choice = chooseCommanderAction(o, state());
  assert.deepEqual(choice, { action: { kind: 'explore', unitId: 'builder', x: 1800 }, reason: 'explore' });
  for (const patch of [
    { ready: false }, { moving: true }, { cargo: 100 }, { halt: 'stuck-slope' }, { aircraft: true }, { health: .7 },
    { job: { kind: 'repair', phase: 'deliver', reason: '' } },
    { job: { kind: null, phase: 'paused', reason: 'manual-control' } },
  ]) {
    const protectedState = structuredClone(o); Object.assign(protectedState.units[2]!, patch);
    assert.notDeepEqual(chooseCommanderAction(protectedState, state()).action, choice.action, JSON.stringify(patch));
  }
  o.danger = [{ lo: -2000, hi: -1100 }, { lo: 1100, hi: 2000 }];
  assert.notEqual(chooseCommanderAction(o, state()).action?.kind, 'explore', 'a resource survey never accepts a known hazardous corridor; ordinary withdrawal still applies');
  o.danger = [];
  Object.assign(o.units[2]!, { x: 1200, atBase: false, atDepot: false, moving: true });
  o.units.push(unit('other-utility', { builder: true }));
  const surveying = state({ orders: { builder: { kind: 'explore', x: 1800 } } });
  assert.equal(chooseCommanderAction(o, surveying).action, null, 'one active resource survey is enough');
  o.units[3]!.combatAt = o.time;
  assert.deepEqual(chooseCommanderAction(o, surveying),
    { action: { kind: 'home', unitId: 'builder' }, reason: 'local-defense' }, 'a new base alarm recalls the idle worker survey');
  o.units[2]!.job = { kind: 'repair', phase: 'deliver', reason: '' };
  assert.notDeepEqual(chooseCommanderAction(o, surveying).action, { kind: 'home', unitId: 'builder' }, 'the actual service keeps authority');
});

test('routine collection and resource surveys avoid a known hostile base without inventing hidden defenders', () => {
  const o = observation({ upgrades: [], bases: [{ id: 'rival', x: 1400, radius: 100, seen: false, at: 0, sheltered: false }] });
  Object.assign(o.units[0]!, { moving: false, haul: null, atDepot: true });
  o.deposits[0]!.x = 2000;
  o.deposits.push({ ...o.deposits[0]!, id: 'safe-iron', x: -2200 });
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'haul', unitId: 'miner', depositId: 'safe-iron' });
  o.deposits = o.deposits.filter(site => site.id !== 'safe-iron');
  Object.assign(o.units[0]!, { x: 1000, atBase: false, atDepot: false, moving: true, haul: { depositId: 'iron', phase: 'out' } });
  const hauling = state({ orders: { miner: { kind: 'haul', depositId: 'iron' } } });
  assert.deepEqual(chooseCommanderAction(o, hauling), { action: { kind: 'home', unitId: 'miner' }, reason: 'retreat' });
  o.units[0]!.haul!.phase = 'home'; o.units[0]!.cargo = 2000;
  assert.notDeepEqual(chooseCommanderAction(o, hauling).action, { kind: 'home', unitId: 'miner' }, 'an existing loaded return is not restarted');
  o.deposits = []; o.offers = [];
  o.units = [unit('scout', { armed: true, stance: 'fire' }), unit('guard', { armed: true, stance: 'fire', maxHealth: 2000 })];
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'scout', x: -1800 },
    'a resource survey uses the other frontier; a known base is not an attackable actor');
  o.bases = [];
  assert.deepEqual(chooseCommanderAction(o, state()).action, { kind: 'explore', unitId: 'scout', x: 1800 }, 'unknown bases cannot influence the route');
});

test('a haul interrupted by destroyed cargo returns for ordinary repair without overriding another intention', () => {
  const o = observation({ stock: bill(60000, 10000, 750, 5000), upgrades: [],
    units: [unit('carrier', { x: 2800, atBase: false, atDepot: false, auto: false,
      health: .42, cargo: 327, halt: 'no-room',
      job: { kind: null, phase: 'paused', reason: 'manual-order' } }),
    unit('plant', { vehicle: false, x: 650, atBase: false, atDepot: false, extracts: ['ferro', 'silica', 'ligas'] }),
    unit('guard', { armed: true, stance: 'fire' })] });
  o.offers.push({ model: 'truck', cost: bill(23850, 0, 787, 203) });
  const s = state({ orders: { carrier: { kind: 'haul', depositId: 'iron' } } }),
    recovery = { kind: 'home', unitId: 'carrier' };
  assert.deepEqual(chooseCommanderAction(freeze(structuredClone(o)), freeze(structuredClone(s))),
    { action: recovery, reason: 'retreat' }, 'a drivable hull with no usable cargo must not wait forever beside the deposit');
  for (const patch of [
    { carries: ['ferro'] },
    { moving: true, halt: '' },
    { job: { kind: 'repair', phase: 'deliver', reason: '' } },
    { job: { kind: null, phase: 'paused', reason: 'manual-control' } },
    { moving: true, home: true },
  ] satisfies Partial<CommanderUnit>[]) {
    const protectedUnit = structuredClone(o); Object.assign(protectedUnit.units[0]!, patch);
    assert.notDeepEqual(chooseCommanderAction(protectedUnit, s).action, recovery, JSON.stringify(patch));
  }
  assert.notDeepEqual(chooseCommanderAction(o, state()).action, recovery, 'a route without strategic ownership is not commandeered');
});
