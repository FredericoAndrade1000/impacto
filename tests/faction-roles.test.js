import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom, ROOM_LIMITS } from '../server/room.ts';
import { bill } from '../src/economy.ts';
import { onField } from './helpers/field.js';

// Bases far enough apart for a faction to be founded anywhere else when somebody leaves one.
const BASES = [-100, 15000, 30000, 45000, -15000, -30000, 60000, -45000, 75000, -60000];
// A field of players who come with what a player is given (`grantStarter`), and what a test does on it.
function field(t, names, addresses = []) {
  const room = new SharedRoom({ build: false, base: i => BASES[i] }), f = onField(t, room),
    players = names.map((name, i) => room.join(name, '', addresses[i] ?? null));
  const view = player => room.factionView(player.playerId), squad = player => room.players.get(player.playerId).squad;
  return { ...f, room, players, view, squad,
    // What each member is to the faction, in the order they came into it.
    roles: player => view(player).members.map(m => [m.name, m.role]),
    // A player of the faction does something about another (`member`).
    act: (who, whom, act) => f.send(who, 'member', { playerId: whom.playerId, act }),
    // Players invited into the faction of the first, which they join in that order.
    together: (leader, ...others) => { for (const other of others) {
      f.send(leader, 'invite', { playerId: other.playerId }); f.send(other, 'join-faction', { factionId: room.players.get(leader.playerId).factionId }); } } };
}

test('a faction has a leader, administrators and members: the leader names and unnames administrators and hands the leadership over, and nobody else does', t => {
  const { room, act, send, roles, view, together, players: [ana, beto, caio, duda, eva] } = field(t, ['Ana', 'Beto', 'Caio', 'Duda', 'Eva']);
  together(ana, beto, caio, duda);
  assert.deepEqual(roles(ana), [['Ana', 'leader'], ['Beto', 'member'], ['Caio', 'member'], ['Duda', 'member']]);
  const state = () => JSON.stringify([...room.factions.values()].map(f => [f.id, f.leader, [...f.admins], [...f.members]]));
  // A member does nothing about the others.
  let was = state();
  for (const [what, why] of [['remove', 'Só o líder e os administradores removem membros.'], ['admin', 'Só o líder nomeia e tira administradores.'],
    ['member', 'Só o líder nomeia e tira administradores.'], ['leader', 'Só o líder passa a liderança.']])
    assert.throws(() => act(beto, caio, what), { message: why });
  assert.equal(state(), was);
  // The leader names administrators: once or twice, alike.
  assert.deepEqual(act(ana, beto, 'admin'), {}); assert.deepEqual(act(ana, beto, 'admin'), {}); act(ana, caio, 'admin');
  assert.deepEqual(roles(beto), [['Ana', 'leader'], ['Beto', 'admin'], ['Caio', 'admin'], ['Duda', 'member']]);
  // An administrator removes neither another nor the leader, and names nobody.
  was = state();
  for (const [whom, what, why] of [[caio, 'remove', 'Só o líder remove administradores.'], [ana, 'remove', 'O líder não pode ser removido.'],
    [duda, 'admin', 'Só o líder nomeia e tira administradores.'], [caio, 'member', 'Só o líder nomeia e tira administradores.'], [duda, 'leader', 'Só o líder passa a liderança.']])
    assert.throws(() => act(beto, whom, what), { message: why });
  // Nobody acts on themself, on somebody who is not of the faction or on nobody, nor does anything the field does not know.
  assert.throws(() => act(ana, ana, 'admin'), { message: 'Escolha outro membro da facção.' });
  for (const playerId of [eva.playerId, 'j99', 7, null, undefined]) assert.throws(() => send(ana, 'member', { playerId, act: 'remove' }), { message: 'Esse jogador já não é da facção.' });
  for (const what of ['king', undefined, 1]) assert.throws(() => act(ana, duda, what), { message: 'Ação inválida.' });
  assert.equal(state(), was);
  // The leader makes an administrator a member again, and hands the leadership over: whoever led stays on as an administrator,
  // and the faction goes by the name of the one who leads it now.
  act(ana, caio, 'member'); assert.deepEqual(act(ana, caio, 'member'), {});
  assert.equal(view(ana).name, 'Ana'); assert.deepEqual(act(ana, duda, 'leader'), {});
  assert.deepEqual(roles(ana), [['Ana', 'admin'], ['Beto', 'admin'], ['Caio', 'member'], ['Duda', 'leader']]);
  assert.deepEqual([view(ana).name, view(caio).name], ['Duda', 'Duda']);
  // Leading was hers to give once: now she does what an administrator does.
  assert.throws(() => act(ana, beto, 'member'), { message: 'Só o líder nomeia e tira administradores.' });
  act(duda, beto, 'leader'); assert.deepEqual(roles(duda), [['Ana', 'admin'], ['Beto', 'leader'], ['Caio', 'member'], ['Duda', 'admin']]);
});

test('the leader removes anyone and an administrator a member: what that one had on the field stays with the faction, the leader\'s, and that one has a faction of their own, told once where from', t => {
  const { room, world, act, send, order, publish, run, roles, view, squad, together, players: [ana, beto, caio, duda] } = field(t, ['Ana', 'Beto', 'Caio', 'Duda']);
  together(ana, beto, caio, duda); act(ana, beto, 'admin');
  send(ana, 'identity', { nation: 'Farofa', flag: view(ana).flag });
  // Caio has a scout of his own, on its way somewhere.
  const scout = publish(caio, 'scout'); run(1);
  order(caio, 'move', { ids: [scout], x: view(ana).base.x + 60 });
  const way = structuredClone(squad(caio).units.get(scout).move), had = room.owned(ana.playerId).length;
  assert(way && view(caio).units.some(unit => unit.id === scout));
  // An administrator removes him. He has an empty faction and base of his own;
  // it is told where he was removed from and when, as that faction was named then.
  const time = world.time, ownBase = view(ana).base.x;
  assert.deepEqual(act(beto, caio, 'remove'), {});
  const his = view(caio);
  assert.notEqual(his.id, ana.faction.id); assert.notEqual(his.base.x, ownBase);
  assert.deepEqual(his.members, [{ id: caio.playerId, name: 'Caio', connected: true, role: 'leader' }]);
  assert.deepEqual(his.removed, { at: time, from: { name: 'Ana', nation: 'Farofa' } });
  assert.deepEqual([his.stock, his.units.length, his.recovery.offered, his.fell, his.recovered], [bill(), 0, true, null, null]);
  assert(his.units.every(unit => unit.id !== scout));
  // His scout is the leader's, as it stood, under her name and colour, on its way where he had sent it.
  const actor = world.actor(scout);
  assert.deepEqual([actor.ownerId, actor.team, actor.color, actor.playerName], [ana.playerId, ana.faction.id, room.players.get(ana.playerId).color, 'Ana']);
  assert.deepEqual(squad(ana).units.get(scout).move, way);
  assert.equal(room.owned(ana.playerId).length, had + 1); assert(!squad(caio).units.has(scout));
  assert.deepEqual(roles(ana), [['Ana', 'leader'], ['Beto', 'admin'], ['Duda', 'member']]);
  assert.equal(view(ana).removed, null);
  // The leader removes an administrator; an administrator removed is told it all the same.
  act(ana, beto, 'remove');
  assert.deepEqual(roles(ana), [['Ana', 'leader'], ['Duda', 'member']]);
  assert.deepEqual(view(beto).removed.from, { name: 'Ana', nation: 'Farofa' });
  // Whoever is removed with a construction in hand lets go of it; the leader's hands stay where they were.
  const lorry = publish(duda, 'scout'); run(1); order(duda, 'control', { id: lorry }); order(ana, 'control', { id: scout });
  act(ana, duda, 'remove');
  assert.deepEqual([squad(duda).manual, squad(ana).manual, world.actor(lorry).ownerId], [null, scout, ana.playerId]);
  // Removed, a player is like anybody else to the faction: invited again, he may come back, and is told no more of where he was removed from.
  send(ana, 'invite', { playerId: caio.playerId }); send(caio, 'join-faction', { factionId: ana.faction.id });
  assert.deepEqual([view(caio).id, view(caio).removed], [ana.faction.id, null]);
  assert.deepEqual(roles(caio), [['Ana', 'leader'], ['Caio', 'member']]);
});

test('a player leaves the faction for one of their own, counted among the new factions of the address in a day; alone in it, nobody leaves', t => {
  const home = '203.0.113.7', away = '198.51.100.2',
    { room, act, send, publish, run, roles, view, together, players: [ana, beto] } = field(t, ['Ana', 'Beto'], [home, away]);
  // The address of Ana gives two more factions today, Carla's and Bia's.
  room.disconnect(room.join('Carla', '', home).playerId);
  const bia = room.join('Bia', '', home);
  assert.throws(() => send(ana, 'leave-faction'), { message: 'Você é o único membro da facção.' });
  together(ana, beto, bia);
  // Beto leaves with a scout standing: it stays with the faction, with the rest of what it has on the field, none of which is
  // his any longer; and his new faction receives no second starting grant.
  const scout = publish(beto, 'scout'); run(1);
  const fleet = view(beto).units.map(unit => unit.id);
  assert(fleet.includes(scout) && fleet.length > 1);
  assert.equal(room.newcomersOf(away).length, 1);
  const reply = send(beto, 'leave-faction'), his = view(beto);
  assert.deepEqual(reply, { removed: fleet, selected: null, base: room.base(room.players.get(beto.playerId)) });
  assert.notEqual(his.id, ana.faction.id); assert.deepEqual([his.removed, his.units.length, his.stock], [null, 0, bill()]);
  assert.equal(room.world.actor(scout).ownerId, ana.playerId);
  assert.equal(room.newcomersOf(away).length, 2, 'a new faction of his address');
  assert.deepEqual(roles(ana), [['Ana', 'leader'], ['Bia', 'member']]);
  // Bia may not leave hers until a day has gone by since the first of those.
  assert.equal(room.newcomersOf(home).length, ROOM_LIMITS.newPerAddressPerDay);
  const was = [room.factions.size, JSON.stringify(roles(ana)), { ...room.serials }, room.world.actors.length, room.newcomersOf(home).length];
  assert.throws(() => send(bia, 'leave-faction'),
    { message: 'Só 3 facções novas por conexão a cada 24 horas: a sua já fundou 3. Volte mais tarde, ou entre com a que você já tem.' });
  assert.deepEqual([room.factions.size, JSON.stringify(roles(ana)), { ...room.serials }, room.world.actors.length, room.newcomersOf(home).length], was,
    'refused before anything on the field changes');
  // Removed, she is given a faction of her own all the same, and that is no new faction of the address.
  act(ana, bia, 'remove');
  assert.notEqual(view(bia).id, ana.faction.id); assert.equal(room.newcomersOf(home).length, ROOM_LIMITS.newPerAddressPerDay);
  // A day of the field after the first, the address has room for one more.
  room.steps += 24 * 60 * 60 * 60;
  send(ana, 'invite', { playerId: bia.playerId }); send(bia, 'join-faction', { factionId: ana.faction.id });
  assert.deepEqual(Object.keys(send(bia, 'leave-faction')), ['removed', 'selected', 'base']);
});

test('whoever leads a faction and leaves it, the leadership goes to the administrator who came into it first, or with none to the member who did, and what they had on the field with it', t => {
  const { room, world, act, send, publish, run, roles, view, together, players: [ana, beto, caio, duda, eva, fabio] } =
    field(t, ['Ana', 'Beto', 'Caio', 'Duda', 'Eva', 'Fábio']);
  together(ana, beto, caio, duda, eva);
  // Eva is named an administrator before Caio, who came into the faction before her.
  act(ana, eva, 'admin'); act(ana, caio, 'admin');
  const scout = publish(ana, 'scout'); run(1);
  const hers = room.owned(ana.playerId).map(actor => actor.id);
  assert.equal(hers.length, 4, 'the scout and what she was given when she came');
  assert.deepEqual(send(ana, 'leave-faction').removed, hers);
  assert.deepEqual(roles(beto), [['Beto', 'member'], ['Caio', 'leader'], ['Duda', 'member'], ['Eva', 'admin']]);
  assert.deepEqual(hers.map(id => world.actor(id).ownerId), hers.map(() => caio.playerId));
  assert.equal(view(beto).name, 'Caio');
  // Caio joins another faction: what he had, hers with it, stays with this one, Eva's now.
  send(fabio, 'invite', { playerId: caio.playerId });
  assert.deepEqual(send(caio, 'join-faction', { factionId: fabio.faction.id }).removed, hers);
  assert.deepEqual(roles(beto), [['Beto', 'member'], ['Duda', 'member'], ['Eva', 'leader']]);
  assert(hers.every(id => world.actor(id).ownerId === eva.playerId));
  assert.deepEqual(roles(caio), [['Fábio', 'leader'], ['Caio', 'member']]);
  // With no administrator, the member who came first leads.
  send(eva, 'leave-faction');
  assert.deepEqual(roles(beto), [['Beto', 'leader'], ['Duda', 'member']]);
  assert(hers.every(id => world.actor(id).ownerId === beto.playerId)); assert.equal(world.actor(scout).playerName, 'Beto');
  // The last one out of a faction takes what is left of it off the field with it.
  send(beto, 'member', { playerId: duda.playerId, act: 'remove' });
  const left = room.owned(beto.playerId).map(actor => actor.id), gone = ana.faction.id;
  send(fabio, 'invite', { playerId: beto.playerId });
  assert.deepEqual(send(beto, 'join-faction', { factionId: fabio.faction.id }).removed, left);
  assert(left.every(id => !world.actor(id))); assert(!room.factions.has(gone));
});
