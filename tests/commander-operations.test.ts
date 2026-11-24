import test from 'node:test';
import assert from 'node:assert/strict';
import { bill } from '../src/economy-contract.ts';
import { newCommanderState, validateCommanderState } from '../server/faction-commander.ts';
import { baseAlarm, chooseBaseDefense } from '../server/commander-defense.ts';
import { chooseGroundOperation, readGroundOperation } from '../server/commander-operations.ts';
import type { CommanderObservation, CommanderUnit, GroundOperation } from '../server/commander-contract.ts';

const unit = (id: string, x: number): CommanderUnit => ({ id, x, vehicle: true, aircraft: false, combatAt: null, armed: true, artillery: false,
  builder: false, supply: false, extracts: [], carries: [], fuel: 200, fuelCapacity: 200, cargo: 0, health: 1, maxHealth: 1000,
  mobility: { speed: 20, range: 200000 },
  calm: true, still: true, manual: false, salvage: bill(), maintenance: null,
  ammoRatio: 1, attack: null, ready: true, atBase: true, atDepot: true, moving: false, home: false, auto: false,
  stance: 'fire', halt: '', haul: null, job: null });
function context() {
  const o: CommanderObservation = { time: 200, playerId: 'j1', factionId: 'own', base: { x: 0, facing: 1 },
    stock: bill(200000, 10000, 10000, 2000), recovery: null, besieged: false,
    industry: { levels: { workshop: 2, hangar: 0, processing: 1 }, pending: false },
    units: [unit('guard', 0), unit('alpha', 20), unit('bravo', 30)], deposits: [], offers: [], upgrades: [],
    explored: [[-1000, 5000]], bounds: { minX: -10000, maxX: 10000 }, danger: [], threats: [], batteries: [], works: [], wrecks: [],
    bases: [{ id: 'enemy', x: 3000, radius: 100, seen: true, at: null, sheltered: false }], taken: null };
  return { o, state: newCommanderState('balanced', 0) };
}
function deployed() {
  const c = context();
  c.state.operation = chooseGroundOperation(c.o, c.state, true)!.operation!;
  c.state.operation = chooseGroundOperation(c.o, c.state, true)!.operation!;
  assert(c.state.operation.phase === 'gather'); return c;
}

test('a perceived blocker on the approach is engaged and a brief contact gap does not skip the unfinished advance', () => {
  const { o, state } = deployed();
  assert(state.operation && state.operation.phase !== 'prepare');
  state.operation = { ...state.operation, phase: 'advance' };
  for (const soldier of o.units.slice(1)) Object.assign(soldier, { x: 2050, moving: true, atBase: false, atDepot: false });
  o.threats = [{ kind: 'contact', id: 'blocker', x: 1900, channel: 'seen', armed: true, grounded: true }];
  let choice = chooseGroundOperation(o, state, true)!;
  assert.deepEqual(choice.action, { kind: 'attack', unitId: 'alpha', targetId: 'blocker' });
  assert.equal(choice.operation?.phase, 'combat'); state.operation = choice.operation!;
  o.units[1]!.attack = o.units[2]!.attack = 'blocker';
  o.threats = [...o.threats, { kind: 'contact', id: 'other', x: 2060, channel: 'seen', armed: true, grounded: true }];
  assert.equal(chooseGroundOperation(o, state, true), null, 'a still-observed assigned target is not swapped for a slightly nearer one');
  o.threats = [];
  assert.equal(chooseGroundOperation(o, state, true), null, 'loss of current sight does not replace an unfinished approach');
  o.units[1]!.moving = o.units[2]!.moving = false;
  choice = chooseGroundOperation(o, state, true)!;
  assert.equal(choice.operation?.phase, 'occupy'); state.operation = choice.operation!;
  o.units[1]!.moving = o.units[2]!.moving = true;
  assert.equal(chooseGroundOperation(o, state, true), null, 'units approaching the base keep permission to fire');
  for (const soldier of o.units.slice(1)) Object.assign(soldier, { x: 3000, moving: false });
  assert.equal(chooseGroundOperation(o, state, true)?.action?.kind, 'stance', 'pursuit is restrained after physical arrival');
});

test('recent observed combat keeps the guard and repositions it through a normal move', () => {
  const { o, state } = context(); o.units = [o.units[0]!, { ...unit('builder', 100), armed: false, builder: true, combatAt: 195 }];
  o.threats = [{ kind: 'contact', id: 'raider', x: 2200, channel: 'seen', armed: true, grounded: true }];
  const before = structuredClone([o, state]);
  assert(baseAlarm(o)); assert.deepEqual(chooseBaseDefense(o, state), { action: { kind: 'defend', unitId: 'guard', x: 80 }, reason: 'local-defense' });
  assert.deepEqual([o, state], before);
  o.units[0]!.ready = false; assert.equal(chooseBaseDefense(o, state), null, 'a service keeps its authority');
  o.time = 230; assert.equal(baseAlarm(o), false, 'old combat cannot pin the garrison indefinitely');
  o.threats = [{ kind: 'contact', id: 'hauler', x: 500, channel: 'seen', armed: false, grounded: true }];
  assert.equal(baseAlarm(o), false, 'a visibly unarmed carrier does not become an invasion alarm');
  o.threats = [{ kind: 'contact', id: 'unknown', x: 500, channel: 'radar', armed: null, grounded: true }];
  assert(baseAlarm(o), 'radar cannot certify that a contact is unarmed');
});

test('assembly waits for ordinary base service without stealing it or mistaking direct control for service', () => {
  const { o, state } = deployed();
  Object.assign(o.units[1]!, { ready: false, moving: true });
  assert.equal(chooseGroundOperation(o, state, true), null, 'automatic base service may briefly suspend the existing departure');
  o.units[1]!.job = { kind: null, phase: 'paused', reason: 'manual-control' };
  assert.equal(chooseGroundOperation(o, state, true)?.operation?.phase, 'return', 'the driver retains authority and ends the deployment');
});

test('the expedition keeps a prepared light guard and sends the two most durable surplus vehicles', () => {
  const { o, state } = context();
  Object.assign(o.units[0]!, { maxHealth: 2400 });
  Object.assign(o.units[1]!, { maxHealth: 725 });
  Object.assign(o.units[2]!, { maxHealth: 905 });
  o.units.push({ ...unit('heavy', 40), maxHealth: 3000 });
  state.operation = chooseGroundOperation(o, state, true)!.operation!;
  const choice = chooseGroundOperation(o, state, true)!;
  assert(choice.operation && choice.operation.phase !== 'prepare');
  assert.equal(choice.operation.guardId, 'alpha');
  assert.deepEqual(choice.operation.unitIds, ['heavy', 'guard']);
  assert.deepEqual(choice.action, { kind: 'deploy', unitIds: ['heavy', 'guard'], x: 250 });
});

test('a returning force waits for temporary service and does not report completion while a survivor is outside', () => {
  const { o, state } = deployed();
  assert(state.operation && state.operation.phase !== 'prepare');
  state.operation = { ...state.operation, phase: 'return', outcome: 'aborted' };
  Object.assign(o.units[1]!, { x: 800, atBase: false, atDepot: false, ready: false });
  assert.equal(chooseGroundOperation(o, state, true), null, 'the service retains authority while the return memory remains active');
  o.units[1]!.ready = true;
  assert.deepEqual(chooseGroundOperation(o, state, true)?.action, { kind: 'home', unitId: 'alpha' });
  o.units[1]!.job = { kind: null, phase: 'paused', reason: 'manual-control' };
  assert.equal(chooseGroundOperation(o, state, true)?.operation, null, 'explicit direct control still takes ownership of the unit');
});

test('a funded mission assembles two ground units, preserves a guard, fights, occupies and physically returns', () => {
  const { o, state } = context(), before = structuredClone([o, state]);
  let choice = chooseGroundOperation(o, state, true)!;
  assert.equal(choice.operation?.phase, 'prepare'); assert.deepEqual([o, state], before, 'planning does not mutate memory or the observation');
  state.operation = choice.operation!; choice = chooseGroundOperation(o, state, true)!;
  assert.equal(choice.operation?.phase, 'gather'); assert.deepEqual(choice.action, { kind: 'deploy', unitIds: ['alpha', 'bravo'], x: 250 });
  state.operation = choice.operation!;
  for (const soldier of o.units.slice(1)) Object.assign(soldier, { x: 250, atBase: false, atDepot: false });
  choice = chooseGroundOperation(o, state, true)!; assert.equal(choice.operation?.phase, 'advance'); state.operation = choice.operation!;
  o.units[1]!.x = o.units[2]!.x = 2200;
  o.threats = [{ kind: 'contact', id: 'defender', x: 3000, channel: 'seen', armed: true, grounded: true }];
  choice = chooseGroundOperation(o, state, true)!;
  assert.deepEqual(choice.action, { kind: 'defend', unitId: 'alpha', x: 2800 });
  state.operation = choice.operation!;
  state.orders.alpha = { kind: 'defend', x: 2800 }; o.units[1]!.x = 2800;
  choice = chooseGroundOperation(o, state, true)!;
  assert.deepEqual(choice.action, { kind: 'defend', unitId: 'bravo', x: 2620 });
  state.orders.bravo = { kind: 'defend', x: 2620 }; o.units[2]!.x = 2620;
  choice = chooseGroundOperation(o, state, true)!;
  assert.equal(choice.action?.kind, 'attack'); assert.equal(choice.operation?.phase, 'combat'); state.operation = choice.operation!;
  o.units[1]!.attack = o.units[2]!.attack = 'defender';
  assert.equal(chooseGroundOperation(o, state, true), null, 'the current attack is not restarted');
  o.threats = []; o.units[1]!.attack = o.units[2]!.attack = null;
  choice = chooseGroundOperation(o, state, true)!; assert.equal(choice.operation?.phase, 'occupy'); state.operation = choice.operation!;
  o.units[1]!.x = o.units[2]!.x = 3000;
  assert.equal(chooseGroundOperation(o, state, true)?.action?.kind, 'stance', 'occupation restrains incidental pursuit');
  o.taken = { factionId: 'enemy', at: 300 }; o.time = 300;
  choice = chooseGroundOperation(o, state, true)!; assert.equal(choice.operation?.phase, 'return'); state.operation = choice.operation!;
  assert.equal(chooseGroundOperation(o, state, true)?.action?.kind, 'home');
  o.units[1]!.home = true; assert.equal(chooseGroundOperation(o, state, true)?.action?.kind, 'home');
  o.units[2]!.home = true; assert.equal(chooseGroundOperation(o, state, true), null, 'both physical returns continue without reissuing Home');
  for (const soldier of o.units.slice(1)) soldier.atBase = true;
  assert.equal(chooseGroundOperation(o, state, true), null, 'crossing the base radius does not finish a Home order that is still parking');
  for (const soldier of o.units.slice(1)) Object.assign(soldier, { atBase: true, home: false });
  assert.deepEqual(chooseGroundOperation(o, state, true), { action: null, reason: 'complete-operation', operation: null });
});

test('a healthy forward force screens a known attacker instead of retreating away from it', () => {
  const { o, state } = deployed(); assert(state.operation && state.operation.phase !== 'prepare');
  state.operation = { ...state.operation, phase: 'advance' };
  for (const [i, soldier] of o.units.slice(1).entries()) Object.assign(soldier, { x: 400 + i * 200, atBase: false, atDepot: false });
  o.threats = [{ kind: 'contact', id: 'raider', x: 800, channel: 'seen', armed: true, grounded: true }];
  const before = structuredClone([o, state]); assert(baseAlarm(o));
  const approach = chooseGroundOperation(o, state, true)!;
  assert.deepEqual(approach.action, { kind: 'defend', unitId: 'alpha', x: 600 });
  assert.equal(approach.operation?.phase, 'combat'); assert.deepEqual([o, state], before);
  state.operation = approach.operation!;
  for (const soldier of o.units.slice(1)) state.orders[soldier.id] = { kind: 'defend', x: 600 };
  assert.equal(chooseGroundOperation(o, state, true)?.action?.kind, 'attack', 'the same approach is not restarted each cycle');
  o.threats = [{ ...o.threats[0]!, x: 850 }];
  assert.equal(chooseGroundOperation(o, state, true)?.action?.kind, 'attack', 'small observation changes do not churn movement');
  o.threats = [{ ...o.threats[0]!, x: 1100 }];
  assert.deepEqual(chooseGroundOperation(o, state, true)?.action, { kind: 'defend', unitId: 'alpha', x: 900 });
  o.besieged = true;
  assert.equal(chooseGroundOperation(o, state, true)?.operation?.phase, 'return', 'actual base capture still interrupts the fight');
  o.besieged = false; o.threats = [{ kind: 'signal', x: 800 }];
  assert.equal(chooseGroundOperation(o, state, true)?.operation?.phase, 'return', 'an anonymous warning cannot authorize chasing a hidden target');
});

test('a combat pair staggers support behind its durable front in either direction without repeating moves', () => {
  for (const side of [-1, 1]) {
    const { o, state } = deployed(); assert(state.operation && state.operation.phase !== 'prepare');
    state.operation = { ...state.operation, phase: 'advance', targetX: side * 3000 };
    o.bases[0]!.x = side * 3000;
    Object.assign(o.units[1]!, { x: side * 1000, maxHealth: 700, atBase: false, atDepot: false, moving: true });
    Object.assign(o.units[2]!, { x: side * 1100, maxHealth: 1000, atBase: false, atDepot: false, moving: true });
    o.threats = [{ kind: 'contact', id: 'blocker', x: side * 2000, channel: 'seen', armed: true, grounded: true }];
    const lead = chooseGroundOperation(o, state, true)!;
    assert.deepEqual(lead.action, { kind: 'defend', unitId: 'bravo', x: side * 1800 });
    state.operation = lead.operation!; state.orders.bravo = { kind: 'defend', x: side * 1800 };
    assert.deepEqual(chooseGroundOperation(o, state, true)?.action, { kind: 'defend', unitId: 'alpha', x: side * 1620 });
    state.orders.alpha = { kind: 'defend', x: side * 1620 };
    assert.equal(chooseGroundOperation(o, state, true)?.action?.kind, 'attack', 'existing physical approaches continue while target focus is assigned');
    o.units[1]!.attack = o.units[2]!.attack = 'blocker';
    assert.equal(chooseGroundOperation(o, state, true), null);
  }
});

test('a wounded mobile guard evades recent measured fire once and ordinary defense does not undo it', () => {
  const { o, state } = context(); o.units = [unit('guard', 60)];
  Object.assign(o.units[0]!, { health: .9, combatAt: 199 });
  o.batteries = [{ x: 2200, error: 300, at: 198 }];
  const before = structuredClone([o, state]), escape = chooseBaseDefense(o, state)!;
  assert.deepEqual(escape, { action: { kind: 'defend', unitId: 'guard', x: -80 }, reason: 'evade-fire' });
  assert.deepEqual([o, state], before, 'planning cannot move or repair the unit');
  state.history = [{ ...escape, at: 200, result: 'applied' }];
  o.units[0]!.x = -80; o.time = 205; o.units[0]!.combatAt = 204;
  assert.equal(chooseBaseDefense(o, state), null, 'the old exposed position is not reassigned');
  assert.deepEqual(validateCommanderState(JSON.parse(JSON.stringify(state)), o.time), state, 'cold resume preserves the same grace');
  state.history = []; o.batteries[0]!.at = 180;
  assert.equal(chooseBaseDefense(o, state), null, 'old reports do not sustain evasion');
  o.batteries[0]!.at = 204; o.units[0]!.health = 1;
  assert.equal(chooseBaseDefense(o, state), null, 'firing alone without damage is insufficient');
  o.units[0]!.maintenance = { phase: 'needed', critical: true, cost: bill(300), available: true };
  assert.equal(chooseBaseDefense(o, state)?.reason, 'evade-fire', 'damaged armour also justifies moving before internal parts fail');
  o.units[0]!.maintenance = null;
  o.units[0]!.health = .9; o.units[0]!.ready = false;
  assert.equal(chooseBaseDefense(o, state), null, 'ordinary service keeps authority');
  o.units[0]!.ready = true; o.units[0]!.job = { kind: null, phase: 'paused', reason: 'manual-control' };
  assert.equal(chooseBaseDefense(o, state), null);
});

test('a brief contact gap preserves the existing approach after a minor base hit but cannot renew its grace', () => {
  const { o, state } = deployed(); assert(state.operation && state.operation.phase !== 'prepare');
  state.operation = { ...state.operation, phase: 'combat' };
  for (const soldier of o.units.slice(1)) Object.assign(soldier, { x: 700, moving: true, atBase: false, atDepot: false });
  state.history = [{ at: 200, result: 'applied', reason: 'fight-operation', action: { kind: 'attack', unitId: 'alpha', targetId: 'lost-contact' } }];
  o.time = 205; o.units[0]!.combatAt = 204;
  const before = structuredClone([o, state]); assert(baseAlarm(o));
  assert.equal(chooseGroundOperation(o, state, true), null);
  assert.deepEqual([o, state], before, 'waiting adds no fresh memory or deadline');
  o.time = 216; o.units[0]!.combatAt = 215;
  assert.equal(chooseGroundOperation(o, state, true)?.operation?.phase, 'return');
  o.time = 210; o.units[0]!.health = .7;
  assert.equal(chooseGroundOperation(o, state, true)?.operation?.phase, 'return', 'a badly damaged guard receives no sensory-gap grace');
  o.units[0]!.health = 1; o.besieged = true;
  assert.equal(chooseGroundOperation(o, state, true)?.operation?.phase, 'return');
});

test('a failed expedition return is not restarted and keeps its original closing deadline', () => {
  const { o, state } = deployed();
  assert(state.operation && state.operation.phase !== 'prepare');
  state.operation = { ...state.operation, phase: 'return', outcome: 'aborted' };
  Object.assign(o.units[1]!, { x: 800, atBase: false, atDepot: false, halt: 'stuck-slope' });
  state.orders.alpha = { kind: 'defend', x: 250 };
  assert.deepEqual(chooseGroundOperation(o, state, true)?.action, { kind: 'home', unitId: 'alpha' });
  state.orders.alpha = { kind: 'home' };
  assert.equal(chooseGroundOperation(o, state, true), null, 'another Home would only reset the same failed approach');
  o.time = state.operation.until + 300;
  assert.deepEqual(chooseGroundOperation(o, state, true), { action: null, reason: 'abort-operation', operation: null });
});

test('unknown, unexplored or sheltered bases and unavailable launch units cannot create an expedition', () => {
  for (const change of [
    (o: CommanderObservation) => { o.bases = []; },
    (o: CommanderObservation) => { o.bases[0]!.seen = false; },
    (o: CommanderObservation) => { o.bases[0]!.sheltered = true; },
    (o: CommanderObservation) => { o.explored = [[-1000, 1000]]; },
  ]) { const { o, state } = context(); change(o); assert.equal(chooseGroundOperation(o, state, true), null); }
  const unfunded = context(); assert.equal(chooseGroundOperation(unfunded.o, unfunded.state, false), null);
  const remembered = context(); remembered.o.bases[0]!.seen = false; remembered.o.bases[0]!.at = 195;
  remembered.o.explored = [[-1000, 1000], [2900, 3100]];
  assert.equal(chooseGroundOperation(remembered.o, remembered.state, true)?.operation?.phase, 'prepare', 'recent fixed-base intelligence survives optical gaps in the crossed terrain');
  for (const patch of [{ aircraft: true }, { health: .7 }, { ammoRatio: .2 }, { home: true }, { ready: false }, { attack: 'other' }, { job: { kind: null, phase: 'paused', reason: 'manual-control' } }]) {
    const { o, state } = context(); state.operation = chooseGroundOperation(o, state, true)!.operation!;
    Object.assign(o.units[2]!, patch); assert.equal(chooseGroundOperation(o, state, true), null, JSON.stringify(patch));
  }
});

test('loss of guard, a relocated objective, fuel reserve and manual control end the mission without stealing protected orders', () => {
  for (const change of [
    (o: CommanderObservation) => { o.units[0]!.atBase = false; },
    (o: CommanderObservation) => { o.units[1]!.fuel = 20; },
    (o: CommanderObservation) => { o.units[1]!.job = { kind: 'repair', phase: 'deliver', reason: '' }; },
    (o: CommanderObservation) => { o.bases[0]!.x += 200; },
  ]) {
    const { o, state } = deployed(); change(o);
    const choice = chooseGroundOperation(o, state, true)!; assert.equal(choice.operation?.phase, 'return');
    state.operation = choice.operation!;
    if (o.units[1]!.job) { o.units[1]!.atBase = false; assert.equal(chooseGroundOperation(o, state, true)?.action, null); }
  }
});

test('cold mission memory preserves deadlines, defaults old saves and rejects impossible forces', () => {
  const { state } = deployed(), source = JSON.parse(JSON.stringify(state));
  assert.deepEqual(validateCommanderState(source, 210), state);
  assert.equal(validateCommanderState(source, 2000).operation?.until, state.operation!.until, 'an expired deadline is never renewed');
  const legacy = { ...source }; delete legacy.operation; assert.equal(validateCommanderState(legacy, 210).operation, null);
  const mission = state.operation as Exclude<GroundOperation, { phase: 'prepare' }>;
  for (const bad of [
    { ...mission, until: Infinity }, { ...mission, until: mission.startedAt + 7201 },
    { ...mission, phase: 'prepare', until: mission.startedAt + 1201 },
    { ...mission, startedAt: 220 }, { ...mission, unitIds: ['alpha', 'alpha'] },
    { ...mission, guardId: 'alpha' }, { ...mission, phase: 'return', outcome: 'unknown' }, { ...mission, phase: 'teleport' },
  ]) assert.throws(() => readGroundOperation(bad, 210), /Operação/);
});

test('campaigns use the known objective and the force travel budget instead of a map-distance band', () => {
  for (const distance of [1000, 8000, 14000]) for (const side of [-1, 1]) {
    const { o, state } = context(); o.bases[0]!.x = distance * side; o.explored = [[-20000, 20000]];
    state.operation = chooseGroundOperation(o, state, true)?.operation ?? null;
    assert.equal(state.operation?.phase, 'prepare', `${distance} m, side ${side}`);
    const departure = chooseGroundOperation(o, state, true)!;
    assert.equal(departure.operation?.phase, 'gather');
    assert(departure.operation!.until > state.operation!.until, 'the round trip is budgeted in addition to combat time');
    assert.deepEqual(readGroundOperation(departure.operation, o.time), departure.operation);
  }
});

test('a surveyed fixed base remains an objective through optical gaps, while a reported relocation aborts', () => {
  const { o, state } = context(); o.time = 2000; o.bases[0]!.seen = false; o.bases[0]!.at = 100;
  state.operation = chooseGroundOperation(o, state, true)?.operation ?? null;
  assert.equal(state.operation?.phase, 'prepare', 'aging does not move or erase a previously surveyed structure');
  state.operation = chooseGroundOperation(o, state, true)!.operation!;
  o.time += 700;
  assert.equal(chooseGroundOperation(o, state, true), null, 'the existing rally waits without restarting or aborting');
  o.bases[0]!.x += 200;
  assert.equal(chooseGroundOperation(o, state, true)?.operation?.phase, 'return', 'new location information is respected');
});

test('expeditions leave unsuitable vehicles guarding home and never launch beyond fuel or time reserves', () => {
  const { o, state } = context();
  o.units[1]!.maxHealth = 5000; o.units[1]!.mobility = { speed: 20, range: 1000 };
  state.operation = chooseGroundOperation(o, state, true)!.operation!;
  const launch = chooseGroundOperation(o, state, true)!.operation;
  assert(launch && launch.phase === 'gather');
  assert.equal(launch.guardId, 'alpha', 'a durable short-range vehicle is useful locally');
  assert.deepEqual(new Set(launch.unitIds), new Set(['guard', 'bravo']));
  for (const patch of [
    { fuel: 150, mobility: { speed: 20, range: 8000 } },
    { mobility: { speed: .5, range: 200000 } },
    { mobility: null },
  ]) {
    const c = context(); c.o.units.forEach(unit => Object.assign(unit, patch));
    c.state.operation = chooseGroundOperation(c.o, c.state, true)!.operation!;
    const rejected = chooseGroundOperation(c.o, c.state, true)!;
    assert.equal(rejected.operation, null, 'an unviable departure is aborted before any vehicle is sent');
    assert.equal(rejected.action, null);
  }
});
