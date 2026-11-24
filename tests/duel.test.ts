import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { FieldHost } from '../server/field-host.ts';
import { ReplayRecording } from '../server/replay-recording.ts';
import { bill, CAPTURE_SECONDS } from '../src/economy.ts';
import { isDuel, isDuelView } from '../src/duel.ts';
import { isFactionView } from '../src/field-protocol-codec.ts';
import { fieldPanel } from '../src/field-panel.ts';
import { duelPanel } from '../src/faction-ui.ts';
import { configureLanguage } from '../src/i18n.ts';
import { onField } from './helpers/field.js';

function fixture(t: TestContext) {
  configureLanguage({ search: '?lang=pt-BR' });
  const room = new SharedRoom({ stock: bill(400000, 10000, 10000, 4000), starter: false, build: false,
    fog: false, base: index => index ? 1800 : -1800 }), f = onField(t, room),
    players = [room.join('Ana'), room.join('Bia')] as const,
    factions = [room.faction(room.players.get(players[0].playerId)!), room.faction(room.players.get(players[1].playerId)!)] as const;
  return { ...f, players, factions };
}

test('a captured persistent base can recover; starting a later duel ignores its old capture', t => {
  const f = fixture(t), [winner, loser] = f.players, [won, lost] = f.factions,
    id = f.publish(winner, 'scout');
  f.order(winner, 'control', { id: null }); f.order(winner, 'stance', { ids: [id], stance: 'hold' });
  f.put(id, lost.base!.x);
  lost.capture = { by: won.id, at: f.world.time, progress: CAPTURE_SECONDS, state: 'advancing' };
  f.room.besiege(f.world.time);
  assert.equal(lost.base, null); assert.equal(f.room.ended, false);
  assert.equal(f.room.recovery(lost)!.offered, true);
  f.send(loser, 'recover');
  assert(lost.base);
  f.room.startDuel();
  f.run(1);
  assert.equal(f.room.duel!.phase, 'playing');
  assert.equal(f.room.factionView(winner.playerId)!.duel!.phase, 'playing');
});

test('a duel capture is final for either side, stops controls, survives restart and closes at a Native print', t => {
  const f = fixture(t), [loser, winner] = f.players, [lost, won] = f.factions,
    id = f.publish(winner, 'scout', { ticket: 'before-result' });
  f.order(winner, 'control', { id: null });
  const previousReceipt = f.room.players.get(winner.playerId)!.published.get('before-result');
  f.room.startDuel();
  f.put(id, lost.base!.x);
  lost.capture = { by: won.id, at: f.world.time, progress: CAPTURE_SECONDS, state: 'advancing' };
  f.room.besiege(f.world.time);
  assert.equal(f.room.duel!.phase, 'won');
  assert.equal(f.room.duel!.phase === 'won' && f.room.duel!.winner, won.id);
  assert.equal(f.room.recovery(lost), null);
  assert.throws(() => f.send(loser, 'recover'), /duelo terminou/);
  assert.throws(() => f.send(winner, 'abandon', { actorId: id }), /duelo terminou/);
  assert.throws(() => f.room.join('Terceira'), /duelo já tem/);
  assert.equal(f.room.command(winner.playerId, { type: 'spawn', ticket: 'before-result' }), previousReceipt);
  const squad = f.room.players.get(winner.playerId)!.squad!.units.get(id)!;
  assert.equal(squad.stance, 'hold'); assert.equal(squad.move, null); assert.equal(squad.attack, null);
  assert.equal(f.room.records.get(id)!.auto, false);
  const host = new FieldHost(f.room, { field: { bases: [-1800, 1800] }, diary: false }), shots = f.world.stats.shots;
  for (let n = 0; n < 60 && !host.ended; n++) host.step();
  assert(host.ended); assert.equal(f.room.steps % 60, 0); assert.equal(f.world.stats.shots, shots);
  const recording = new ReplayRecording('.');
  recording.observe(host, 'ready');
  assert.deepEqual(recording.markers.filter(marker => marker.label.startsWith('duel-')).map(marker => marker.label).sort(),
    ['duel-lost', 'duel-won']);
  const at = f.world.time; assert.throws(() => host.step(), /duelo terminou/); assert.equal(f.world.time, at);

  const kept = f.room.keep(), resumed = new SharedRoom({ kept });
  try {
    assert(resumed.ended); assert(new FieldHost(resumed, { diary: false }).ended);
    const winnerView = resumed.factionView(winner.playerId)!, loserView = resumed.factionView(loser.playerId)!;
    assert(isFactionView(winnerView)); assert(isFactionView(loserView));
    assert.equal(winnerView.duel!.phase, 'won'); assert.equal(loserView.duel!.phase, 'lost');
    assert.equal(resumed.recovery(resumed.factions.get(lost.id)!), null);
    const state = { ...resumed.world.snapshot(), shared: true, squad: resumed.squadView(winner.playerId), faction: winnerView,
      localPlayerId: winner.playerId };
    const panel = fieldPanel({ tab: 'test', shared: true, connected: true, faction: winnerView, state,
      playerId: winner.playerId, picked: [id] });
    assert.deepEqual(panel.orders, []); assert.deepEqual(panel.services, []);
    assert.equal(panel.control, false); assert.equal(panel.automatic, null);
    assert(panel.actions.every(action => action.id === 'copy'));
  } finally { resumed.world.dispose(); }
});

test('simultaneous duel captures draw from the same physical standing snapshot', t => {
  const f = fixture(t), [a, b] = f.players, [fa, fb] = f.factions,
    ca = f.publish(a, 'scout'), cb = f.publish(b, 'scout');
  f.order(a, 'control', { id: null }); f.order(b, 'control', { id: null });
  f.order(a, 'stance', { ids: [ca], stance: 'hold' }); f.order(b, 'stance', { ids: [cb], stance: 'hold' });
  f.room.startDuel();
  f.put(ca, fb.base!.x); f.put(cb, fa.base!.x);
  fa.capture = { by: fb.id, at: f.world.time, progress: CAPTURE_SECONDS, state: 'advancing' };
  fb.capture = { by: fa.id, at: f.world.time, progress: CAPTURE_SECONDS, state: 'advancing' };
  f.room.besiege(f.world.time);
  assert.equal(f.room.duel!.phase, 'draw'); assert(fa.base && fb.base);
  assert.equal(f.room.factionView(a.playerId)!.duel!.phase, 'draw');
  assert.equal(f.room.factionView(b.playerId)!.duel!.phase, 'draw');
  const clone = new SharedRoom({ kept: f.room.keep() });
  try { assert.equal(clone.duel!.phase, 'draw'); } finally { clone.world.dispose(); }
});

test('duel boundaries reject impossible state and expose translated outcomes', t => {
  const f = fixture(t), sides: [string, string] = [f.factions[0].id, f.factions[1].id];
  assert.equal(isDuel({ phase: 'playing', sides, since: 0, winner: sides[0] }), false);
  assert.equal(isDuel({ phase: 'won', sides, since: 10, at: 9, winner: sides[0], loser: sides[1] }), false);
  assert.equal(isDuel({ phase: 'won', sides, since: 0, at: 1, winner: sides[0], loser: sides[0] }), false);
  assert.equal(isDuelView({ phase: 'won', since: 10, at: 9 }), false);
  const saved = f.room.keep(); saved.duel = { phase: 'playing', sides, since: 1000 };
  assert.throws(() => new SharedRoom({ kept: saved }), /Duelo salvo inválido/);
  f.room.startDuel();
  assert.throws(() => f.send(f.players[0], 'leave-faction'), /permanecem separadas/);
  assert.equal(duelPanel({ phase: 'won', since: 0, at: 1 })!.text, 'Vitória · duelo encerrado');
  configureLanguage({ search: '?lang=en' }); t.after(() => configureLanguage({ search: '?lang=pt-BR' }));
  assert.equal(duelPanel({ phase: 'lost', since: 0, at: 1 })!.text, 'Defeat · duel finished');
});
