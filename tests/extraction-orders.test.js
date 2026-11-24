import test from 'node:test';
import assert from 'node:assert/strict';
import { Squad } from '../src/squad.ts';

// A vein the faction knows is never gone: it is told however little is left in it, which comes back by itself. Only
// a place that is no more (`gone`, an airdrop taken) is told as nothing.
function collector({ extracts = false, room = 0 } = {}) {
  const state = { x: 500, vx: 0, vy: 0, time: 0, carried: 0, left: 1000, stock: 0, area: true, ready: null, waiting: false, gone: false },
    squad = new Squad({ roster: [{ id: 'unit', team: 'local' }], defeats: {},
      world: { get time() { return state.time; }, actor: () => ({ vehicle: { x: state.x, vx: state.vx, vy: state.vy } }), terrain: { minX: -10000, maxX: 10000 } },
      deposit: () => !state.gone ? { x: 500, material: 'ferro', left: state.left, stock: state.stock, stilled: false,
        area: state.area ? typeof state.area === 'object' ? state.area : { lo: 490, hi: 510, goal: 500, ready: state.ready ?? Math.abs(state.x - 500) < 10,
          digs: extracts, loads: room > 0 } : null } : null,
      depot: () => ({ x: 0, radius: 100 }), load: () => ({ carried: state.carried, room, extracts, waiting: state.waiting }) }), unit = squad.units.get('unit');
  unit.haul = { depositId: 'site', material: 'ferro', phase: 'out' };
  return { state, unit, squad, turn: () => squad.haul('unit', unit), arrive: () => { state.x = unit.move.x; unit.move = null; } };
}

test('one collect order leaves an extractor without cargo working at the deposit until its reserve is empty', () => {
  const f = collector({ extracts: true });
  assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'load');
  for (let i = 0; i < 5; i++) { f.state.stock += 100; assert.equal(f.turn(), ''); }
  assert.equal(f.unit.move, null); assert.equal(f.unit.haul.phase, 'load');
  f.state.left = 0;
  assert.equal(f.turn(), 'vein-empty:ferro', 'it ends where it stands, with the pile it left there');
  assert.equal(f.unit.haul, null); assert.equal(f.unit.move, null);
});

test('a transporter waits for production, carries a depleted site pile home and stops only after unloading', () => {
  const f = collector({ room: 1000 }); f.turn();
  assert.equal(f.unit.haul.phase, 'load'); f.turn(); assert.equal(f.unit.move, null, 'no ready pile yet is not a spent reserve');
  f.state.left = 0; f.state.stock = 200; f.state.carried = 50; f.turn();
  assert.equal(f.unit.haul.phase, 'load', 'a pile is still collectible after the reserve runs out');
  assert.equal(f.unit.halt, '', 'an empty reserve with a pile beside it is no empty vein');
  f.state.stock = 0; f.state.carried = 250; f.turn(); assert.equal(f.unit.haul.phase, 'home');
  assert.equal(f.unit.halt, 'vein-empty:ferro', 'it says why on its way home'); assert(f.unit.move);
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.state.left = 50;
  f.state.carried = 0; assert.equal(f.turn(), 'vein-empty:ferro', 'what came back since does not send it out again');
  assert.equal(f.unit.haul, null); assert.equal(f.unit.move, null);
});

test('a new order to a vein the faction knows empty goes there before judging it', () => {
  for (const room of [0, 1000]) {
    const f = collector({ extracts: !room, room }); f.state.x = 200; f.state.left = 0;
    assert.equal(f.turn(), '', 'it may have come back since the faction last saw it');
    assert.equal(f.unit.haul.phase, 'out'); assert(f.unit.move.x >= 490 && f.unit.move.x <= 510, 'it makes for the vein');
    f.arrive(); assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'load');
    if (!room) { assert.equal(f.turn(), 'vein-empty:ferro'); assert.equal(f.unit.haul, null); continue; }
    f.turn(); assert.equal(f.unit.haul.phase, 'home'); assert.equal(f.unit.halt, 'vein-empty:ferro');
    f.arrive(); assert.equal(f.turn(), 'vein-empty:ferro', 'with nothing aboard it stops as it gets home'); assert.equal(f.unit.haul, null);
  }
  const f = collector({ room: 1000 }); f.state.x = 200; f.state.left = 0;
  f.turn(); f.arrive(); f.state.left = 3000; f.turn(); f.turn();
  assert.equal(f.unit.haul.phase, 'load', 'one that came back is worked as any other'); assert.equal(f.unit.halt, '');
});

test('a hauler whose place is gone goes home with what it carries and says the place is spent', () => {
  const f = collector({ room: 1000 }); f.turn();
  f.state.carried = 250; f.state.gone = true; f.turn();
  assert.equal(f.unit.haul.phase, 'home'); assert.equal(f.unit.halt, 'vein-spent:ferro');
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.state.carried = 0; assert.equal(f.turn(), 'vein-spent:ferro'); assert.equal(f.unit.haul, null);
});

test('a combined vehicle returns with a full load and goes back under the same order', () => {
  const f = collector({ extracts: true, room: 1000 }); f.turn();
  f.state.carried = 1000; f.turn(); assert.equal(f.unit.haul.phase, 'home');
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.state.carried = 0; f.turn(); assert.equal(f.unit.haul.phase, 'out'); assert.equal(f.unit.move.x, 500);
});

test('a single ready-material round returns when the finite pile empties and ends after physical unloading', () => {
  const f = collector({ room: 1000, extracts: true });
  f.unit.haul.once = true; f.state.stock = 250;
  f.turn(); assert.equal(f.unit.haul.phase, 'load');
  f.state.carried = 250; f.state.stock = 0;
  f.turn(); assert.equal(f.unit.haul.phase, 'home'); assert.equal(f.state.left, 1000, 'geological reserve does not keep this round waiting');
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.state.carried = 0; assert.equal(f.turn(), '');
  assert.equal(f.unit.haul, null); assert.equal(f.unit.move, null, 'the dispatcher chooses another ready site instead of repeating an empty leg');
  const g = collector({ room: 1000 }); g.unit.haul.once = true; g.state.left = 0; g.state.stock = 250;
  g.turn(); g.state.carried = 250; g.state.stock = 0; g.turn();
  assert.equal(g.unit.haul.phase, 'home'); assert.equal(g.unit.halt, '', 'a round for a ready pile finds no empty vein');
  g.arrive(); g.turn(); g.state.carried = 0; assert.equal(g.turn(), '');
});

test('a full combined vehicle starts a newly ordered haul by going home instead of approaching the vein', () => {
  const f = collector({ extracts: true, room: 1000 });
  f.state.x = 200; f.state.carried = 1000;
  f.unit.move = { x: 500, best: 300, since: 0 };
  assert.equal(f.turn(), '');
  assert.equal(f.unit.haul.phase, 'home'); assert.equal(f.unit.move.x, 75);
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.state.carried = 0; f.turn();
  assert.equal(f.unit.haul.phase, 'out'); assert.equal(f.unit.move.x, 500, 'the same order resumes after actual unloading');
});

test('a transporter delivers a partial pile, repeats the order and waits at the deposit without empty return trips', () => {
  const f = collector({ room: 1000 }); f.turn();
  f.state.carried = 250; f.state.waiting = true;
  // A pile found empty may be a pause of what digs it: the load goes home once it has not grown for eight seconds.
  f.turn(); assert.equal(f.unit.haul.phase, 'load');
  f.state.time = 7.9; f.turn(); assert.equal(f.unit.haul.phase, 'load');
  f.state.time = 8; f.turn(); assert.equal(f.unit.haul.phase, 'home'); assert(f.unit.move);
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.state.carried = 0; f.turn(); assert.equal(f.unit.haul.phase, 'out');
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'load');
  for (let i = 0; i < 10; i++) { f.turn(); assert.equal(f.unit.haul.phase, 'load'); assert.equal(f.unit.move, null); }
  f.state.carried = 100; f.state.waiting = false; f.turn(); assert.equal(f.unit.haul.phase, 'load');
  f.state.waiting = true; f.state.time = 12; f.turn(); assert.equal(f.unit.haul.phase, 'load', 'its load grew four seconds ago');
  f.state.time = 16; f.turn(); assert.equal(f.unit.haul.phase, 'home', 'new production is carried home under the same order');
});

test('continuous production does not send a growing partial load home just because the public pile is kept empty', () => {
  const f = collector({ extracts: true, room: 1000 }); f.turn();
  for (const cargo of [50, 250, 500, 750]) {
    f.state.carried = cargo; f.state.stock = 0; f.state.waiting = false;
    f.turn(); assert.equal(f.unit.haul.phase, 'load'); assert.equal(f.unit.move, null);
  }
  f.state.carried = 1000; f.turn(); assert.equal(f.unit.haul.phase, 'home');
});

test('a loaded vehicle takes its cargo home when its collection area becomes unavailable', () => {
  for (const phase of ['out', 'load', 'home']) {
    const f = collector({ extracts: true, room: 1000 });
    f.state.carried = 250; f.state.area = false; f.unit.haul.phase = phase;
    assert.equal(f.turn(), '', phase);
    assert.equal(f.unit.haul.phase, 'home'); assert(f.unit.move, 'returning does not need a reachable collection area');
    f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
    f.state.carried = 0; assert.equal(f.turn(), 'no-loader'); assert.equal(f.unit.haul, null);
  }
});

test('a vehicle already unloading keeps its order until empty even without a collection area', () => {
  const f = collector({ room: 1000 });
  f.state.x = 50; f.state.carried = 250; f.state.area = false; f.unit.haul.phase = 'unload';
  assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'unload');
  f.state.carried = 0; assert.equal(f.turn(), 'no-loader'); assert.equal(f.unit.haul, null);
});

test('an empty vehicle cannot start another collection leg without a reachable area', () => {
  const f = collector({ extracts: true, room: 1000 }); f.state.area = false;
  assert.equal(f.turn(), 'no-loader'); assert.equal(f.unit.haul, null); assert.equal(f.unit.move, null);
});

test('a parked tool that never reaches the ground ends its order after settling instead of idling outbound forever', () => {
  const f = collector({ extracts: true }); f.state.ready = false;
  assert.equal(f.turn(), ''); assert.equal(f.unit.move, null); assert.equal(f.unit.haul.phase, 'out');
  f.state.time = 7.9; assert.equal(f.turn(), ''); assert(f.unit.haul, 'give suspension and tilt time to settle');
  f.state.time = 8.1; assert.equal(f.turn(), 'no-loader');
  assert.equal(f.unit.haul, null); assert.equal(f.unit.move, null);
});

test('an unreachable collector returns its partial cargo once and ends after unloading instead of retrying the same mounting', () => {
  const f = collector({ extracts: true, room: 1000 }); f.state.ready = false; f.state.carried = 250;
  f.turn(); f.state.time = 8.1;
  assert.equal(f.turn(), ''); assert.equal(f.unit.haul.phase, 'home'); assert.equal(f.unit.move.x, 75);
  f.arrive(); f.turn(); assert.equal(f.unit.haul.phase, 'unload');
  f.state.carried = 0;
  assert.equal(f.turn(), 'no-loader'); assert.equal(f.unit.haul, null); assert.equal(f.unit.move, null);
});

test('settling at a temporary unready place resumes normal collection and resets the next approach deadline', () => {
  const f = collector({ extracts: true }); f.state.ready = false;
  f.turn(); f.state.time = 7; f.state.ready = true; f.turn();
  assert.equal(f.unit.haul.phase, 'load');
  f.state.time = 20; f.state.ready = false; f.turn(); assert.equal(f.unit.haul.phase, 'out');
  f.state.time = 27.9; assert.equal(f.turn(), ''); assert(f.unit.haul);
  f.state.time = 28.1; assert.equal(f.turn(), 'no-loader');
});

test('travelling, rolling into place and queueing do not consume the settled collector deadline', () => {
  const f = collector({ extracts: true }); f.state.ready = false; f.state.x = 200;
  f.turn(); f.state.time = 100; assert.equal(f.turn(), ''); assert(f.unit.move);
  f.arrive(); f.state.vx = 2; f.turn(); f.state.time = 200; assert.equal(f.turn(), ''); assert(f.unit.haul);
  f.state.vx = 0; f.turn(); f.state.time = 207.9; assert.equal(f.turn(), ''); assert(f.unit.haul);
  f.state.ready = true; f.turn(); assert.equal(f.unit.haul.phase, 'load');

  const q = collector({ extracts: true }), world = q.squad.side.world, original = world.actor;
  q.state.x = 500; q.state.ready = false;
  q.squad.side.roster.push({ id: 'other', team: 'local' });
  world.actor = id => id === 'other' ? { vehicle: { x: 500 } } : original(id);
  q.turn(); assert.equal(q.unit.haul.waiting, true); q.arrive();
  q.state.time = 100; assert.equal(q.turn(), ''); assert.equal(q.unit.haul.waiting, true);
  assert.equal(q.unit.move, null, 'a queue waits outside without reporting an invalid tool');
});

test('the collector deadline applies at an alternative free bay, not just the canonical tool goal', () => {
  const f = collector({ extracts: true }), world = f.squad.side.world, original = world.actor;
  f.state.x = 490; f.state.area = { lo: 480, hi: 520, goal: 500, ready: false, digs: true, loads: false };
  f.squad.side.roster.push({ id: 'other', team: 'local' });
  world.actor = id => id === 'other' ? { vehicle: { x: 500 } } : original(id);
  assert.equal(f.turn(), ''); assert.equal(f.unit.move, null); assert.equal(f.unit.haul.waiting, undefined);
  f.state.time = 8.1; assert.equal(f.turn(), 'no-loader'); assert.equal(f.unit.haul, null);
});

test('falling vertically at the loading position does not count as settled time or cancel the collection order', () => {
  const f = collector({ extracts: true }); f.state.ready = false; f.state.vy = -20;
  f.turn(); f.state.time = 20;
  assert.equal(f.turn(), ''); assert(f.unit.haul, 'zero horizontal speed does not make a falling vehicle parked');
  f.state.vy = 0; f.turn(); f.state.time = 27.9;
  assert.equal(f.turn(), ''); assert(f.unit.haul, 'the full settling allowance begins after the fall');
  f.state.time = 28.1; assert.equal(f.turn(), 'no-loader');
});
