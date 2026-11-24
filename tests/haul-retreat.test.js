import test from 'node:test';
import assert from 'node:assert/strict';
import { Squad, HEARD_AGAIN } from '../src/squad.ts';
import { fieldPanel, fieldNotices } from '../src/field-panel.ts';
import { bill, load } from '../src/economy.ts';
import { pilotDecision } from './helpers/pilot-fixture.ts';

// The core supplies contacts and mobility; orders, progress and player notices
// are real. No physics or browser timing is needed to exercise these decisions.
function workers({ count = 1, extracts = false, capacity = 1000 } = {}) {
  const state = { time: 10, target: null, channel: 'visual', round: 0, carried: capacity ? 200 : 0, left: 1000 },
    own = Array.from({ length: count }, (_, i) => ({ id: 'truck-' + i, ownerId: 'player', team: 'green', facing: 1,
      vehicle: { x: 500 + i * 25, y: 0, vx: 0, fuelLitres: 100, engine: true, config: { enabled: true } } })),
    world = { get time() { return state.time; }, terrain: { minX: -10000, maxX: 10000 }, plates: [], modules: [],
      actor: id => own.find(a => a.id === id) ?? { id, team: 'enemy', vehicle: { x: 800, y: 0 } },
      game: () => ({ call: request => pilotDecision({ action: { throttle: 0, brake: 1, fire: false }, targetId: state.target,
        contact: state.target ? { detected: true, age: 0, x: 800, y: 0, channel: state.channel } : { detected: false },
        diagnostics: { reason: 'search-contact', nearestFreshContactDistance: state.target ? Math.abs(800 - own.find(actor => actor.id === request.actorId).vehicle.x) : null } }) }) },
    side = { world, roster: own.map(a => ({ id: a.id, team: 'local', role: 'support' })), defeats: {}, batteries: [], input() {},
      arenaBounds: { minX: -10000, maxX: 10000 }, sighted: () => state.channel !== 'sound', foe: () => true, tipped: () => false, veinAt: () => null,
      // The enemy, armed, as the side holds it: its guns reach any of them.
      threats: () => state.target ? [{ x: 800, y: 0, reach: Infinity }] : [],
      deposit: () => state.left > 0 ? { id: 'mine', x: 500, material: 'ferro', left: state.left, stilled: false,
        area: { lo: 450, hi: 650, goal: 500, ready: true } } : null,
      depot: () => ({ x: 0, radius: 100 }), load: () => ({ room: capacity, carried: state.carried, extracts }) },
    squad = new Squad(side), ids = own.map(a => a.id), unit = id => squad.units.get(id ?? ids[0]);
  squad.command({ order: 'haul', ids, depositId: 'mine' });
  const decide = () => { const round = ++state.round; return own.map(a => squad.decide(side.roster.find(m => m.id === a.id), round)); },
    watch = () => {
      const faction = { id: 'green', name: 'Player', base: { x: 0, radius: 100 }, stock: bill(), yard: load(), known: [], members: [],
        strangers: [], ranking: [], invites: [], request: null, requests: [], library: [], deposits: [], wrecks: [], units: ids.map(id => ({ id, built: bill(1000), value: bill(1000), repair: bill(),
          repairSeconds: 0, rearm: bill(), cargo: load(state.carried), fill: { solid: state.carried / Math.max(1, capacity), liquid: 0, supplies: 0 },
          still: true, calm: true, atBase: false, service: null })) },
        snapshot = { shared: true, time: state.time, localPlayerId: 'player', faction, actors: own, squad: squad.view(), plates: [],
          modules: own.map(a => ({ id: a.id + ':cargo', actorId: a.id, kind: capacity ? 'hopper' : 'excavator', health: 100, maxHealth: 100 })) };
      return fieldPanel({ tab: 'test', shared: true, connected: true, state: snapshot, faction, playerId: 'player' }).watch;
    };
  return { state, own, squad, ids, unit, decide, watch };
}

test('several threatened haulers all retreat immediately but announce one encounter, even with changing sensors', () => {
  const f = workers({ count: 3 }), memo = {};
  f.decide(); assert.deepEqual(fieldNotices(memo, f.watch(), 0), []);
  f.state.target = 'enemy-one';
  const actions = f.decide(), units = f.ids.map(f.unit), legs = units.map(u => u.move);
  assert(units.every(u => u.haul.fled && u.haul.phase === 'home' && u.move.x < 100));
  assert(actions.every(a => a.throttle < 0 && !a.brake), 'every worker begins driving home in this decision');
  assert.equal(new Set(units.map(u => u.haul.threat)).size, 1);
  const heard = f.squad.view().units.filter(u => u.heard);
  assert.equal(heard.length, 1, 'only the announcement is shared, not perception or retreat');
  assert.equal(fieldNotices(memo, f.watch(), 1).length, 1, 'contact and retreat are one player notice');
  for (let i = 1; i <= 40; i++) {
    f.state.time += .5; f.state.channel = i % 2 ? 'sound' : 'radar';
    // The trucks make real progress so this test isolates repeated threat readings.
    for (const a of f.own) a.vehicle.x -= 1;
    f.decide();
    assert.deepEqual(fieldNotices(memo, f.watch(), i + 1), []);
    for (const [index, u] of units.entries()) assert.equal(u.move, legs[index], 'same home leg, not replaced on every alert');
  }
});

test('empty threatened workers already in their base retain one encounter notice when the haul ends immediately', () => {
  const f = workers({ count: 3 }), memo = {};
  f.state.carried = 0; f.own.forEach((actor, index) => { actor.vehicle.x = 10 + index * 25; });
  f.decide(); fieldNotices(memo, f.watch(), 0);
  f.state.target = 'enemy-one'; f.decide();
  assert(f.ids.every(id => f.unit(id).haul === null && f.unit(id).move === null));
  assert.equal(fieldNotices(memo, f.watch(), 1).length, 1);
  assert.equal(new Set(f.squad.view().units.map(u => u.haltEvent)).size, 1);
  f.squad.command({ order: 'move', ids: f.ids, x: 200 });
  assert(f.squad.view().units.every(u => !u.haltEvent), 'new orders clear the completed encounter cause');
});

test('different enemies and a genuine reacquisition notify again, while a brief loss does not', () => {
  const f = workers({ count: 2 }), memo = {};
  f.squad.command({ order: 'stop', ids: f.ids }); f.decide(); fieldNotices(memo, f.watch(), 0);
  f.state.target = 'enemy-one'; f.decide();
  assert.equal(fieldNotices(memo, f.watch(), 1).length, 1);
  f.state.time += .1; f.state.target = 'enemy-two'; f.decide();
  assert.equal(fieldNotices(memo, f.watch(), 1.1).length, 1, 'a new enemy is not hidden by the prior six-second contact badge');
  f.state.time += 1; f.state.target = null; f.decide(); fieldNotices(memo, f.watch(), 2.1);
  f.state.time += 1; f.state.target = 'enemy-one'; f.decide();
  assert.deepEqual(fieldNotices(memo, f.watch(), 3.1), []);
  f.state.target = null; f.state.time += HEARD_AGAIN + 1; f.decide(); fieldNotices(memo, f.watch(), 20);
  f.state.target = 'enemy-one'; f.state.time += .1; f.decide();
  assert.equal(fieldNotices(memo, f.watch(), 20.1).length, 1);
});

test('sound-only encounters never publish an enemy identity or position', () => {
  const f = workers({ count: 2 });
  f.state.target = 'secret-enemy'; f.state.channel = 'sound'; f.decide();
  const published = f.squad.view();
  assert(published.units.every(u => u.targetId === null));
  assert.equal(published.units.find(u => u.heard).heard.side, 1);
  assert.equal('x' in published.units.find(u => u.heard).heard, false);
  assert.equal(JSON.stringify(published).includes('secret-enemy'), false);
});

test('loss of contact, refuelling and a service interruption preserve the return, which ends after unloading', () => {
  const f = workers(); f.state.target = 'enemy'; f.decide();
  const unit = f.unit(), home = unit.move.x;
  f.state.target = null; f.state.time += 1; f.decide();
  assert.equal(unit.move.x, home); assert.equal(unit.haul.phase, 'home');
  f.own[0].vehicle.fuelStarved = true;
  for (let i = 0; i < 5; i++) { f.state.time += 10; assert.deepEqual(f.decide().map(a => [a.throttle, a.brake]), [[0, 1]]); }
  assert(unit.haul && unit.move, 'waiting for fuel never becomes a blocked-way timeout');
  f.own[0].vehicle.fuelStarved = false; f.state.time += .1;
  assert(f.decide()[0].throttle < 0, 'refuelling resumes the same destination');
  // Room clears the transient leg while repairing, keeps haul, then resumes it.
  unit.move = null; f.state.time += 60; f.squad.resume(f.ids[0]);
  assert(f.decide()[0].throttle < 0); assert.equal(unit.move.x, home);
  f.own[0].vehicle.x = home; f.state.time += 1; f.decide();
  assert.equal(unit.haul.phase, 'unload');
  f.state.carried = 0; f.state.time += 1; f.decide();
  assert.equal(unit.haul, null); assert.equal(unit.reason, 'enemy-near');
  f.state.time += 1; f.decide(); assert.equal(unit.move, null, 'unloading does not start another exposed trip');
});

test('a failed outbound trip attempts home once; a blocked return waits for help without a retry loop', () => {
  const f = workers(), unit = f.unit();
  f.squad.side.deposit = () => ({ id: 'mine', x: 900, material: 'ferro', left: 1000, stilled: false,
    area: { lo: 880, hi: 920, goal: 900, ready: false } });
  f.decide(); assert(unit.move.x > 500);
  f.state.time += 9; f.decide();
  assert.equal(unit.haul.phase, 'home'); assert(unit.move.x < 100, 'blocked outbound path makes it return, rather than abandoning work there');
  f.state.time += 9; f.decide();
  assert.equal(unit.haul.blocked, 'blocked-way'); assert.equal(unit.move, null);
  for (let i = 0; i < 20; i++) { f.state.time += 10; f.decide(); assert.equal(unit.move, null); }
  const warned = f.watch();
  assert(warned.ills.some(ill => ill.key === 'blocked-way'));
  f.squad.resume(f.ids[0]); f.state.time += .1;
  assert(f.decide()[0].throttle < 0, 'service completion can resume the return');
  assert.equal(unit.reason, 'haul-interrupted', 'the failed trip is not described as a current loss of mobility');
});

test('lightening a worker stuck on the return resumes the same homeward purpose without claiming it remains stuck', () => {
  const f = workers(), unit = f.unit(); f.state.target = 'enemy'; f.decide();
  f.state.target = null; f.own[0].vehicle.stuck = 'ground'; f.state.time += 9; f.decide();
  assert.equal(unit.haul.blocked, 'stuck-ground'); assert.equal(unit.move, null);
  f.squad.lightened(f.ids[0]); f.own[0].vehicle.stuck = null; f.state.time += .1;
  assert(f.decide()[0].throttle < 0); assert.equal(unit.haul.blocked, undefined);
  assert.equal(unit.reason, 'enemy-near');
  assert.equal(f.watch().ills.some(ill => ill.key === 'held:ground'), false);
});

test('explicit player orders replace the retreat; a pure extractor also returns when threatened but stops at depletion', () => {
  const f = workers({ extracts: true, capacity: 0 }); f.state.target = 'enemy'; f.decide();
  assert.equal(f.unit().haul.phase, 'home'); assert(f.unit().move.x < 100);
  f.squad.command({ order: 'move', ids: f.ids, x: 700 }); f.state.time += .1; f.decide();
  assert.equal(f.unit().haul, null); assert.equal(f.unit().move.x, 700, 'manual move is not converted into another retreat');
  f.squad.command({ order: 'stop', ids: f.ids }); f.state.time += .1; f.decide(); assert.equal(f.unit().move, null);
  f.squad.command({ order: 'control', id: f.ids[0] }); assert.equal(f.decide()[0], null);
  const exhausted = workers({ extracts: true, capacity: 0 }); exhausted.decide(); exhausted.state.left = 0; exhausted.state.carried = 0;
  exhausted.state.time += .1; exhausted.decide();
  assert.equal(exhausted.unit().haul, null); assert.equal(exhausted.unit().move, null);
});
