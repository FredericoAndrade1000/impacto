import test from 'node:test';
import assert from 'node:assert/strict';
import { newCommanderState, validateCommanderState } from '../server/faction-commander.ts';

function keptState() {
  const state = newCommanderState('cautious', 95);
  state.enabled = false; state.sequence = 3; state.actions = 1; state.refusals = 1; state.nextAt = 105;
  state.cooldowns['haul:c1:ferro:0'] = 220;
  state.blocked.c1 = { reason: 'enemy-near', until: 280 };
  state.orders.c1 = { kind: 'haul', depositId: 'ferro:0' };
  state.deferredRepairs = ['c2'];
  state.history = [
    { at: 95, action: { kind: 'haul', unitId: 'c1', depositId: 'ferro:0' }, reason: 'collect-material', result: 'applied' },
    { at: 100, action: { kind: 'upgrade', upgrade: 'workshop-ii' }, reason: 'improve-workshop', result: 'refused', detail: 'Funds were already committed.' },
  ];
  return state;
}

test('cold strategic memory retains a paused controller and world-time retries without sharing saved objects', () => {
  const source = keptState(), json = JSON.parse(JSON.stringify(source)), restored = validateCommanderState(json, 100);
  assert.deepEqual(restored, source);
  restored.blocked.c1!.until = 300; restored.history[0]!.action = null;
  assert.equal(json.blocked.c1.until, 280); assert.equal(json.history[0].action.kind, 'haul');
});

test('ordinary wreck recovery survives a cold save and rejects an invalid wreck identity', () => {
  const source = keptState();
  source.history[0] = { at: 95, action: { kind: 'salvage', wreckId: 'known-wreck' }, reason: 'recover-materials', result: 'applied' };
  assert.deepEqual(validateCommanderState(JSON.parse(JSON.stringify(source)), 100), source);
  source.history[0]!.action = { kind: 'salvage', wreckId: '__proto__' };
  assert.throws(() => validateCommanderState(source, 100), /comandante|Comandante/);
});

test('invalid strategic timers, impossible counters and executable or oversized history are rejected', () => {
  const bad = [
    { ...keptState(), nextAt: Infinity },
    { ...keptState(), nextAt: 10000 },
    { ...keptState(), actions: 100 },
    { ...keptState(), orders: { c1: { kind: 'drive', throttle: 1 } } },
    { ...keptState(), cooldowns: JSON.parse('{"__proto__": 110}') },
    { ...keptState(), deferredRepairs: null },
    { ...keptState(), deferredRepairs: ['c2', 'c2'] },
    { ...keptState(), history: Array(41).fill(keptState().history[0]) },
    { ...keptState(), history: [{ at: 90, action: { kind: 'manufacture', model: 'unknown-free-tank' }, reason: 'restore-mining', result: 'applied' }] },
    { ...keptState(), history: [{ at: 101, action: null, reason: 'busy', result: 'waiting' }] },
  ];
  for (const value of bad) assert.throws(() => validateCommanderState(value, 100), /comandante|Comandante/);
});

test('older commander memory opens with no deferred repairs and persists ordinary maintenance actions', () => {
  const legacy = { ...keptState() } as Record<string, unknown>; delete legacy.deferredRepairs;
  assert.deepEqual(validateCommanderState(legacy, 100).deferredRepairs, []);
  for (const kind of ['cancel-repair', 'repair', 'dismantle'] as const) {
    const s = keptState(); s.history = [{ at: 100, action: { kind, unitId: 'c2' }, reason: 'preserve-income', result: 'applied' }];
    assert.deepEqual(validateCommanderState(JSON.parse(JSON.stringify(s)), 100), s);
  }
});

test('restoring diagnostic actions cannot carry publication shortcuts or callbacks into the controller', () => {
  const restored = validateCommanderState({ ...keptState(), callback: () => true,
    history: [{ at: 90, action: { kind: 'manufacture', model: 'scout', instant: true, blueprint: { unsafe: true } },
      reason: 'manufacture-defense', result: 'applied' }] }, 100);
  assert.deepEqual(restored.history[0]!.action, { kind: 'manufacture', model: 'scout' });
  assert.equal(Object.hasOwn(restored, 'callback'), false);
});

test('a cold interception preserves its fixed waypoint and deadline, and cannot become an unbounded mission pool', () => {
  const state = keptState();
  state.orders.scout = { kind: 'intercept', targetId: 'enemy', x: 1500, until: 260 };
  state.history = [{ at: 95, action: { kind: 'intercept', unitId: 'scout', targetId: 'enemy', x: 1500 }, reason: 'protect-route', result: 'applied' }];
  assert.deepEqual(validateCommanderState(JSON.parse(JSON.stringify(state)), 100), state);
  assert.deepEqual(validateCommanderState(state, 300).orders.scout, state.orders.scout, 'a resumed expired mission stays expired');
  for (const orders of [
    { scout: { ...state.orders.scout, until: Infinity } },
    { scout: { ...state.orders.scout, until: 1000 } },
    { scout: state.orders.scout, other: { ...state.orders.scout } },
  ]) assert.throws(() => validateCommanderState({ ...state, orders }, 100), /comandante|Comandante/);
});
