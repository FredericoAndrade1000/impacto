import test from 'node:test';
import assert from 'node:assert/strict';
import { Side } from '../server/room.ts';

test('a shared side builds roster roles only for its own and allied constructions, in field order', () => {
  let enemyRoleReads = 0;
  const actor = (id, ownerId) => ({ id, ownerId, blueprint: { modules: [] } }),
    first = actor('first', 'p1'), ally = actor('ally', 'p3'), last = actor('last', 'p1'),
    enemy = { id: 'enemy', ownerId: 'p2', get blueprint() { enemyRoleReads++; return { modules: [] }; } },
    actors = [first, enemy, ally, actor('unowned', null), last],
    players = new Map([['p1', { factionId: 'red' }], ['p2', { factionId: 'blue' }], ['p3', { factionId: 'red' }]]),
    room = { players, fielded: () => actors, world: { actor: id => actors.find(actor => actor.id === id) },
      faction: player => ({ id: player.factionId }), knows: () => 'seen', outOfAction: () => ({}) },
    side = new Side(room, 'p1');
  assert.deepEqual(side.roster, [
    { id: 'first', pilot: 'player', role: 'armor', team: 'local' },
    { id: 'ally', pilot: 'player', role: 'armor', team: 'ally' },
    { id: 'last', pilot: 'player', role: 'armor', team: 'local' },
  ]);
  assert.deepEqual(['first', 'ally', 'enemy'].map(id => side.foe(id)), [false, false, true]);
  assert.equal(enemyRoleReads, 0, 'neither roster nor the enemy predicate needs the role of an opponent');
  assert.deepEqual(side.member(enemy), { id: 'enemy', pilot: 'player', role: 'armor', team: 'opponent' },
    'the existing individual member contract used by pilots stays complete');
  assert.equal(enemyRoleReads, 1);
  assert.deepEqual(side.member(first), side.roster[0]);
});

test('local ownership and the existing strict faction comparison survive absent seats and a transient null faction', () => {
  const actor = (id, ownerId) => ({ id, ownerId, blueprint: { modules: [] } }),
    actors = [actor('mine', 'p1'), actor('red-ally', 'p3'), actor('missing-owner', 'gone'),
      actor('without-faction', 'p4'), actor('null-faction', 'p5')],
    players = new Map([['p1', { factionId: 'red' }], ['p3', { factionId: 'red' }], ['p4', {}], ['p5', { factionId: null }]]),
    side = new Side({ players, fielded: () => actors }, 'p1'), ids = () => side.roster.map(member => member.id);
  assert.deepEqual(ids(), ['mine', 'red-ally']);
  players.delete('p1');
  assert.deepEqual(ids(), ['mine', 'without-faction'], 'own stays local without its seat; an existing undefined faction compares as before');
  assert.equal(side.member(actors[0]).team, 'local');
  assert.equal(side.member(actors[2]).team, 'opponent', 'a missing owner is never made an ally by absent faction values');
  players.set('p1', { factionId: null });
  assert.deepEqual(ids(), ['mine', 'null-faction'], 'the leave transition keeps strict null equality, without coercion');
  players.set('p1', {});
  assert.deepEqual(ids(), ['mine', 'without-faction'], 'undefined is not changed into null');
});
