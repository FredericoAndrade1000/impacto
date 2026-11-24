import test from 'node:test';
import assert from 'node:assert/strict';
import { bill } from '../src/economy-contract.ts';
import { chooseInterception, INTERCEPTION_SECONDS, maintainInterception } from '../server/commander-tactics.ts';
import type { CommanderObservation, CommanderState, CommanderUnit } from '../server/commander-contract.ts';
import { commanderActionKey } from '../server/commander-contract.ts';

const unit = (id: string, patch: Partial<CommanderUnit> = {}): CommanderUnit => ({
  id, x: 0, vehicle: true, aircraft: false, combatAt: null, armed: false, artillery: false, builder: false, supply: false, extracts: [], carries: [],
  health: 1, maxHealth: 1000, fuel: 200, fuelCapacity: 200, cargo: 0, ammoRatio: 1, attack: null,
  mobility: { speed: 20, range: 200000 },
  calm: true, still: true, manual: false, salvage: bill(), maintenance: null,
  ready: true, atBase: true, atDepot: true, moving: false, home: false, auto: false, stance: 'fire', halt: '', haul: null, job: null, ...patch,
});
function field(): { o: CommanderObservation; state: CommanderState } {
  return { o: {
    time: 200, playerId: 'commander', factionId: 'own', base: { x: 0, facing: 1 }, stock: bill(90000, 10000, 10000, 1500),
    recovery: null, besieged: false, industry: { levels: { workshop: 1, hangar: 0, processing: 1 }, pending: false },
    units: [unit('worker', { x: 1200, atBase: false, atDepot: false, moving: true, armed: false, extracts: ['ferro'], carries: ['ferro'],
      haul: { depositId: 'iron', phase: 'out' } }),
    unit('guard', { x: -20, armed: true }), unit('spare', { x: 30, armed: true })],
    deposits: [{ id: 'iron', x: 2500, material: 'ferro', reserve: 60000, left: 60000, stock: 0, seen: false, at: 0 }],
    offers: [], upgrades: [], explored: [[-750, 3000]], bounds: { minX: -10000, maxX: 10000 },
    danger: [{ lo: 1000, hi: 3000 }], threats: [{ kind: 'contact', id: 'enemy', x: 2000, channel: 'seen', armed: true, grounded: true }], batteries: [], works: [], wrecks: [], bases: [], taken: null,
  }, state: { enabled: true, profile: 'balanced', nextAt: 0, sequence: 0, actions: 0, refusals: 0,
    cooldowns: {}, blocked: {}, orders: {}, deferredRepairs: [], history: [], operation: null } };
}
function mission() {
  const context = field();
  context.state.orders.spare = { kind: 'intercept', targetId: 'enemy', x: 1800, until: context.o.time + INTERCEPTION_SECONDS };
  Object.assign(context.o.units[2]!, { x: 900, atBase: false, atDepot: false, moving: true });
  return context;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

test('route protection deploys a prepared spare, keeps a guard and reads only the supplied current contact', () => {
  const { o, state } = field(), before = structuredClone([o, state]); freeze(o); freeze(state);
  const choice = chooseInterception(o, state);
  assert.equal(choice?.action?.kind, 'intercept');
  if (choice?.action?.kind !== 'intercept') return;
  assert.equal(choice.action.unitId, 'spare'); assert.equal(choice.action.targetId, 'enemy');
  assert(choice.action.x > o.base!.x && choice.action.x < o.threats[0]!.x, 'the waypoint approaches from the base without parking on the contact');
  assert(Math.abs(choice.action.x - o.base!.x) <= 3000);
  assert.deepEqual(chooseInterception(o, state), choice);
  assert.deepEqual([o, state], before, 'planning changes neither orders, deadlines, stocks nor physics observations');
  const radar = field(); radar.o.threats = [{ kind: 'contact', id: 'radar-enemy', x: 2000, channel: 'radar', armed: null, grounded: true }];
  const radarChoice = chooseInterception(radar.o, radar.state)?.action;
  assert(radarChoice?.kind === 'intercept' && radarChoice.targetId === 'radar-enemy', 'a currently identified radar contact may be protected against');
});

test('signals, airborne or distant contacts and inactive work do not create a ground sortie', () => {
  const cases: { name: string; change(o: CommanderObservation): void }[] = [
    { name: 'visibly unarmed logistics', change: o => { o.threats = [{ kind: 'contact', id: 'truck', x: 2000, channel: 'seen', armed: false, grounded: true }]; } },
    { name: 'sound has no identified target', change: o => { o.threats = [{ kind: 'signal', x: 2000 }]; } },
    { name: 'aerial contact', change: o => { o.threats = [{ kind: 'contact', id: 'aircraft', x: 2000, channel: 'seen', armed: true, grounded: false }]; } },
    { name: 'outside the local mission region', change: o => { o.threats = [{ kind: 'contact', id: 'far', x: 4000, channel: 'seen', armed: true, grounded: true }]; } },
    { name: 'away from the active work route', change: o => { o.threats = [{ kind: 'contact', id: 'other-side', x: -2500, channel: 'seen', armed: true, grounded: true }]; } },
    { name: 'no current contact', change: o => { o.threats = []; } },
    { name: 'no active economic work', change: o => { Object.assign(o.units[0]!, { moving: false, haul: null }); } },
  ];
  for (const item of cases) { const { o, state } = field(); item.change(o); assert.equal(chooseInterception(o, state), null, item.name); }
});

test('a moving contact and a different spare cannot bypass its cooldown, while another threat remains actionable', () => {
  const { o, state } = field(), first = chooseInterception(o, state)?.action;
  assert(first?.kind === 'intercept');
  state.cooldowns[commanderActionKey(first)] = 560;
  o.time = 300;
  assert.equal(chooseInterception(o, state), null);
  o.threats = [{ kind: 'contact', id: 'enemy', x: 2001, channel: 'seen', armed: true, grounded: true }];
  assert.equal(chooseInterception(o, state), null, 'a one-metre position update is the same strategic target');
  o.units[1]!.x = 40; o.units[2]!.x = -50;
  assert.equal(chooseInterception(o, state), null, 'swapping the available unit cannot create a relay pursuit');
  o.threats = [...o.threats, { kind: 'contact', id: 'other', x: 2100, channel: 'seen', armed: true, grounded: true }];
  const other = chooseInterception(o, state)?.action;
  assert(other?.kind === 'intercept' && other.targetId === 'other', 'a cooled target cannot hide a different current route threat');
  o.time = 560;
  const resumed = chooseInterception(o, state)?.action;
  assert(resumed?.kind === 'intercept' && resumed.targetId === 'enemy');
});

test('deployment preserves base defense, military preparation and the current owner of each unit', () => {
  const cases: { name: string; change(o: CommanderObservation, state: CommanderState): void }[] = [
    { name: 'the only guard stays', change: o => { o.units = o.units.filter(unit => unit.id !== 'spare'); } },
    { name: 'a distant post is not the base guard', change: o => { Object.assign(o.units[1]!, { x: 5000, atBase: false, atDepot: true }); } },
    { name: 'an urgent base alarm takes priority', change: o => { o.threats = [...o.threats, { kind: 'signal', x: 500 }]; } },
    { name: 'damaged launchers', change: o => { o.units.filter(unit => unit.armed).forEach(unit => { unit.health = .79; }); } },
    { name: 'insufficient sortie fuel', change: o => { o.units.filter(unit => unit.armed).forEach(unit => { unit.fuel = 99; }); } },
    { name: 'insufficient sortie ammunition', change: o => { o.units.filter(unit => unit.armed).forEach(unit => { unit.ammoRatio = .24; }); } },
    { name: 'a service retains the spare', change: o => { o.units[2]!.ready = false; } },
    { name: 'a live move retains the spare', change: o => { o.units[2]!.moving = true; } },
    { name: 'an explicit attack is not commandeered', change: o => { o.units.filter(unit => unit.armed).forEach(unit => { unit.attack = 'other-target'; }); } },
    { name: 'confirmed obstruction has not expired', change: (_, state) => { state.blocked.spare = { reason: 'immobile', until: 250 }; } },
  ];
  for (const item of cases) { const { o, state } = field(); item.change(o, state); assert.equal(chooseInterception(o, state), null, item.name); }
});

test('a single fixed-deadline mission approaches, focuses once and leaves economic planning available', () => {
  const { o, state } = mission(), original = structuredClone(state);
  assert.equal(chooseInterception(o, state), null, 'no second interception is created');
  assert.equal(maintainInterception(o, state), null, 'ordinary movement continues while the faction may plan its economy');
  o.units[2]!.x = 1780;
  assert.deepEqual(maintainInterception(o, state),
    { action: { kind: 'attack', unitId: 'spare', targetId: 'enemy' }, reason: 'intercept-contact' });
  o.units[2]!.attack = 'enemy'; o.time += 30;
  assert.equal(maintainInterception(o, state), null, 'the existing normal attack is not issued again');
  assert.deepEqual(state, original, 'approach and focus cannot renew the mission deadline');
  const before = structuredClone([o, state]); freeze(o); freeze(state);
  assert.equal(maintainInterception(o, state), null); assert.deepEqual([o, state], before);
});

test('loss of purpose, readiness or local security ends the sortie with an ordinary Home order', () => {
  const cases: { name: string; change(o: CommanderObservation, state: CommanderState): void }[] = [
    { name: 'contact lost', change: o => { o.threats = []; } },
    { name: 'only a sound signal remains', change: o => { o.threats = [{ kind: 'signal', x: 2000 }]; } },
    { name: 'target left the allowed region', change: o => { o.threats = [{ kind: 'contact', id: 'enemy', x: 3500, channel: 'radar', armed: null, grounded: true }]; } },
    { name: 'deadline reached', change: (o, state) => { const order = state.orders.spare!; assert(order.kind === 'intercept'); o.time = order.until; } },
    { name: 'damaged interceptor', change: o => { o.units[2]!.health = .54; } },
    { name: 'fuel return reserve', change: o => { o.units[2]!.fuel = 49; } },
    { name: 'ammunition return reserve', change: o => { o.units[2]!.ammoRatio = .09; } },
    { name: 'the remaining guard left the base', change: o => { o.units[1]!.atDepot = false; } },
    { name: 'the remaining guard is at a post', change: o => { Object.assign(o.units[1]!, { x: 5000, atBase: false, atDepot: true }); } },
    { name: 'the remaining guard has another assigned attack', change: o => { o.units[1]!.attack = 'other-target'; } },
    { name: 'the remaining guard needs service', change: o => { o.units[1]!.ready = false; } },
    { name: 'base alarm', change: o => { o.threats = [...o.threats, { kind: 'signal', x: 500 }]; } },
    { name: 'failed approach', change: o => { o.units[2]!.moving = false; o.units[2]!.halt = 'stuck-terrain'; } },
  ];
  for (const item of cases) {
    const { o, state } = mission(); item.change(o, state);
    assert.deepEqual(maintainInterception(o, state), { action: { kind: 'home', unitId: 'spare' }, reason: 'end-interception' }, item.name);
  }
});

test('maintenance never steals a service, manual control, logistics or an existing return', () => {
  for (const patch of [
    { ready: false }, { home: true }, { haul: { depositId: 'iron', phase: 'home' } },
    { supply: true, haul: { depositId: 'supply-drop', phase: 'out' } },
    { job: { kind: null, phase: 'paused', reason: 'manual-control' } },
    { job: { kind: 'repair', phase: 'deliver', reason: '' } }, { attack: 'other-target' },
  ]) {
    const { o, state } = mission(); Object.assign(o.units[2]!, patch); o.threats = []; o.time += INTERCEPTION_SECONDS;
    assert.equal(maintainInterception(o, state), null, JSON.stringify(patch));
  }
  const missing = mission(); missing.o.units = missing.o.units.filter(unit => unit.id !== 'spare');
  assert.equal(maintainInterception(missing.o, missing.state), null, 'the host retires absent units; no fabricated command is issued');
});
