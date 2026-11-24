import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { bill, billSum, STARTING_STOCK } from '../src/economy.ts';
import { onField } from './helpers/field.js';

const options = { build: false, fog: false, base: i => [-100, 15000, 30000, 45000, 60000][i % 5] };
function field(t, extra = {}) {
  const room = new SharedRoom({ ...options, ...extra }), f = onField(t, room);
  const ana = room.join('Ana'), bia = room.join('Bia');
  return { ...f, ana, bia, faction: p => room.faction(room.players.get(p.playerId)) };
}
function join(f, leader, member) {
  f.send(leader, 'invite', { playerId: member.playerId });
  f.send(member, 'join-faction', { factionId: f.faction(leader).id });
}
const saved = room => JSON.parse(JSON.stringify(room.keep()));
function reopen(t, kept) {
  const room = new SharedRoom({ ...options, starter: false, kept });
  const f = onField(t, room);
  return { ...f, faction: p => room.faction(room.players.get(p.playerId)) };
}

test('starting stocks and fleet belong to a new identity, never to repeated splits, expulsions or reconnects', t => {
  const f = field(t), { room, ana, bia, faction } = f;
  assert.deepEqual(faction(bia).stock, STARTING_STOCK);
  assert.equal(room.enlisted(faction(bia)).length, 3);
  const offer = f.send(bia, 'trade', { act: 'offer', ref: faction(ana).ref, give: { ...STARTING_STOCK }, want: bill() }).offered;
  f.send(ana, 'trade', { act: 'accept', id: offer });
  const combined = billSum(STARTING_STOCK, STARTING_STOCK);
  for (let cycle = 0; cycle < 8; cycle++) {
    join(f, ana, bia);
    if (cycle % 2) f.send(bia, 'leave-faction');
    else f.send(ana, 'member', { playerId: bia.playerId, act: 'remove' });
    assert.deepEqual(faction(bia).stock, bill());
    assert.equal(room.enlisted(faction(bia)).length, 0);
    assert.deepEqual(faction(ana).stock, combined);
  }
  const kept = saved(room), again = reopen(t, kept);
  const back = again.room.join('Bia', bia.token);
  assert.deepEqual(again.faction(back).stock, bill());
  assert.equal(again.room.enlisted(again.faction(back)).length, 0);
  const newcomer = again.room.join('Caio');
  assert.deepEqual(again.faction(newcomer).stock, STARTING_STOCK, 'a different new identity still gets its initial stock');
});

test('a shared subsidy follows all beneficiaries through split, merge, expulsion and save/reopen', t => {
  const f = field(t, { starter: false }), { room, ana, bia } = f;
  join(f, ana, bia); Object.assign(f.faction(ana).stock, bill());
  const truck = f.send(ana, 'recover').selected;
  f.send(ana, 'abandon', { actorId: truck });
  assert.equal(room.players.get(ana.playerId).aidAt, 0);
  assert.equal(room.players.get(bia.playerId).aidAt, 0, 'shared help belongs to every member, including its non-requester');
  for (let cycle = 0; cycle < 3; cycle++) {
    f.send(ana, 'member', { playerId: bia.playerId, act: 'remove' });
    const before = saved(room);
    assert.equal(room.recovery(f.faction(bia)).wait, 1800);
    assert.throws(() => f.send(bia, 'recover'), /Novo auxílio subsidiado em 1800 s/);
    assert.deepEqual(saved(room), before, 'refused grants do not change funds, history, actors or names');
    join(f, ana, bia);
  }
  // A saved clock exercises the boundary without thirty minutes of physics.
  const kept = saved(room); kept.scene.time = 1799.75; kept.scene.tick = 107985;
  const again = reopen(t, kept), back = again.room.join('Bia', bia.token);
  again.send(back, 'leave-faction');
  assert.equal(again.room.recovery(again.faction(back)).wait, .25);
  assert.throws(() => again.send(back, 'recover'), /Novo auxílio subsidiado em 1 s/);
  const boundary = saved(again.room); boundary.scene.time = 1800; boundary.scene.tick = 108000;
  const ready = reopen(t, boundary), player = ready.room.join('Bia', bia.token);
  assert.equal(ready.room.recovery(ready.faction(player)).offered, true);
  ready.send(player, 'recover');
  assert.equal(ready.room.players.get(player.playerId).aidAt, 1800);
  assert.equal(ready.room.enlisted(ready.faction(player)).length, 1, 'legitimate recovery still restores a working miner');
});

test('joining an aided faction cannot shed its legacy subsidy date by leaving it after reopen', t => {
  const f = field(t, { starter: false }), { room, ana, bia } = f;
  Object.assign(f.faction(ana).stock, bill());
  const truck = f.send(ana, 'recover').selected; f.send(ana, 'abandon', { actorId: truck });
  join(f, ana, bia);
  const kept = saved(room);
  for (const player of kept.players) delete player.aidAt;
  for (const faction of kept.factions) if (faction.recovered) delete faction.recovered.aidAt;
  const again = reopen(t, kept), back = again.room.join('Bia', bia.token);
  again.send(back, 'leave-faction');
  assert.equal(again.room.players.get(back.playerId).aidAt, 0, 'an old positive recovery event still supplies its real time');
  assert.equal(again.room.recovery(again.faction(back)).wait, 1800);
  assert.throws(() => again.send(back, 'recover'), /Novo auxílio subsidiado em 1800 s/);
});

test('member subsidy dates affect the canonical digest and malformed or future dates cannot reopen', t => {
  const f = field(t, { starter: false }), { room, ana } = f, p = room.players.get(ana.playerId);
  const before = room.digest(); p.aidAt = 0;
  assert.notEqual(room.digest(), before, 'time zero must not be omitted as falsy');
  const kept = saved(room);
  assert.equal(kept.players.find(s => s.id === p.id).aidAt, 0);
  for (const value of [-1, '0', 1]) {
    const bad = structuredClone(kept); bad.players.find(s => s.id === p.id).aidAt = value;
    const empty = new SharedRoom({ ...options, starter: false }); t.after(() => empty.field.dispose());
    assert.throws(() => empty.resume(bad), /Histórico de auxílio inválido/);
  }
});

test('defeat preserves subsidy history and paid recovery neither waits nor restarts the interval', t => {
  const f = field(t, { starter: false }), { room, ana, bia } = f;
  Object.assign(f.faction(ana).stock, bill()); f.send(ana, 'recover');
  const kept = saved(room); kept.scene.time = 300; kept.scene.tick = 18000;
  const again = reopen(t, kept), back = again.room.join('Ana', ana.token), faction = again.faction(back);
  Object.assign(faction.stock, billSum(again.room.baseCost(), bill(100000, 10000, 10000, 1000)));
  faction.capture = { by: again.faction(bia).id, at: 0, progress: 300, state: 'advancing' };
  again.room.fall(faction, 300);
  const quote = again.room.recovery(faction);
  assert.equal(quote.offered, true); assert.deepEqual(quote.aid, bill());
  again.send(back, 'recover');
  assert(faction.base);
  assert.equal(faction.recovered.at, 300, 'the paid reconstruction records the new event');
  assert.equal(faction.recovered.aidAt, 0, 'it preserves the last real subsidy');
  assert.equal(again.room.players.get(back.playerId).aidAt, 0);
  again.room.join('Bia', bia.token);
  join(again, bia, back); again.send(bia, 'member', { playerId: back.playerId, act: 'remove' });
  assert.equal(again.room.recovery(again.faction(back)).wait, 1500, 'another split cannot erase the original remaining interval');
});
