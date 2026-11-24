import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { onField } from './helpers/field.js';
import { SHELTER_AWAY, SHELTER_CALM, SHELTER_LONGEST } from '../src/economy.ts';

const BASES = [0, 12000, 24000];
// How much harm a construction of a field has taken: the health of its pieces and what its plates went through.
const harm = (world, id) => JSON.stringify([world.modules.filter(m => m.actorId === id).map(m => m.health),
  world.plates.filter(p => p.actorId === id).map(p => [p.revision ?? 0, p.markRevision ?? 0])]);
// Where a construction stands, and a blast of nobody's over it.
const where = (world, id) => world.actor(id).vehicle ?? world.actor(id);
const blast = (world, id, power = 40) => { const at = where(world, id); world.explode(at.x + 1.5, at.y + 1, power, 6); };
// A field of factions twelve kilometres apart — Ana's base at 0, Bia's at 12000, each with a territory of its own
// (territory.ts) —, with all it takes to build; the faction
// of a player, and what the squad of a player tells of one of its constructions.
function field(t, ...names) {
  const f = onField(t, rehearsal(BASES)), { room } = f, players = names.map(name => room.join(name));
  return { ...f, players,
    faction: player => room.faction(room.players.get(player.playerId)),
    unit: (player, id) => room.squadView(player.playerId).units.find(u => u.id === id),
    // Caio comes into Ana's faction.
    enlist: (leader, other) => { room.command(leader.playerId, { type: 'invite', playerId: other.playerId });
      room.command(other.playerId, { type: 'join-faction', factionId: leader.faction.id }); } };
}

test('when the last member of a faction on the field leaves, its fleet comes home and stops there; one that cannot stays', t => {
  const { room, world, players: [ana, bia, caio], faction, enlist, publish, raise, put, order, run, until, unit } = field(t, 'Ana', 'Bia', 'Caio');
  enlist(ana, caio);
  const scout = publish(ana, 'scout'), truck = publish(ana, 'truck'), lost = publish(caio, 'scout'), bunker = raise(ana, 'bunker');
  put(scout, 600); put(truck, 900); put(lost, 1200); room.wreck(world.actor(lost));
  order(ana, 'move', { ids: [scout], x: 1500 }); order(ana, 'stance', { ids: [scout], stance: 'fire' });
  // Ana leaves while Caio is on the field: nothing changes.
  room.disconnect(ana.playerId);
  assert.deepEqual([faction(ana).away, unit(ana, scout).move?.x], [null, 1500]);
  // Caio leaves too: the faction is away from then on, and every vehicle of it that can go is sent home, Ana's and his.
  room.disconnect(caio.playerId);
  assert.equal(faction(ana).away, world.time);
  for (const id of [scout, truck]) assert(Math.abs(unit(ana, id).move?.x) < 30, `${id} goes home`);
  assert.deepEqual([unit(ana, scout).stance, unit(caio, lost)?.move ?? null, unit(ana, bunker).move], ['fire', null, null], 'holding its fire as it did');
  assert(until(() => [scout, truck].every(id => !unit(ana, id).move), 120), 'they come home');
  run(3);
  for (const id of [scout, truck]) {
    assert(room.atBase(faction(ana), world.actor(id)), `${id} stopped at ${where(world, id).x}`);
    assert(Math.abs(world.actor(id).vehicle.vx) < .5);
  }
  assert(Math.abs(where(world, lost).x - 1200) < 1, 'the wreck stays where it is');
  // Bia, who stayed on the field, is left as she was.
  assert.equal(faction(bia).away, null);
});

test('a faction away two minutes after its last fight has its base sheltered until a member comes back: what stands there takes no harm', t => {
  const { room, world, players: [ana], faction, publish, put, run } = field(t, 'Ana', 'Bia');
  const lorry = publish(ana, 'truck'), scout = publish(ana, 'scout'), outside = publish(ana, 'scout');
  put(outside, 500); room.disconnect(ana.playerId);
  const left = world.time;
  // A minute on, a blast of nobody's harms the scout sent home: that is a fight of the faction, wherever it is.
  run(60);
  const before = harm(world, outside); blast(world, outside, 10); run(.5);
  assert.notEqual(harm(world, outside), before); assert(faction(ana).fought > left + 59);
  const fought = faction(ana).fought;
  // Two minutes after the fight, and no sooner, the base is sheltered.
  run(SHELTER_AWAY - 60); assert.equal(faction(ana).shelter, null, 'two minutes away are not enough');
  run(fought + SHELTER_CALM - world.time - .5); assert.equal(faction(ana).shelter, null);
  run(1); assert(faction(ana).shelter >= fought + SHELTER_CALM, `sheltered at ${faction(ana).shelter}`);
  // Nothing in the base is harmed now, the blasts are no fight, and the shelter stays.
  const sheltered = [harm(world, lorry), harm(world, scout)], since = faction(ana).shelter;
  blast(world, lorry); blast(world, scout); run(1);
  assert.deepEqual([harm(world, lorry), harm(world, scout), faction(ana).shelter], [...sheltered, since]);
  // Ana comes back: the base is sheltered no longer, from that very step.
  room.join('Ana', ana.token);
  assert.deepEqual([faction(ana).away, faction(ana).shelter], [null, null]);
  blast(world, lorry); run(.5); assert.notEqual(harm(world, lorry), sheltered[0]);
});

test('every member must be away two minutes: one who leaves later starts the count again', t => {
  const { room, world, players: [ana, , caio], faction, enlist, run } = field(t, 'Ana', 'Bia', 'Caio');
  enlist(ana, caio);
  room.disconnect(ana.playerId); run(60);
  room.disconnect(caio.playerId); const left = world.time;
  run(SHELTER_AWAY - 1); assert.equal(faction(ana).shelter, null);
  run(1.5); assert(faction(ana).shelter >= left + SHELTER_AWAY);
});

test('a capture of its base or by it is fighting: a base is not sheltered while it goes on, nor for two minutes after', t => {
  const { room, world, players: [ana, bia], faction, publish, put, run, until } = field(t, 'Ana', 'Bia');
  // Bia's scout stands armed in Ana's base, and takes it a second a second. Ana leaves.
  const raider = publish(bia, 'scout'); put(raider, 30);
  const capture = faction(ana).capture;
  assert.equal(capture?.by, bia.faction.id);
  room.disconnect(ana.playerId);
  run(SHELTER_AWAY + 5);
  assert.equal(faction(ana).shelter, null);
  assert(world.time - faction(ana).fought < 1.5 && world.time - faction(bia).fought < 1.5, 'both fight while it goes on');
  // The scout is lost: the capture goes back to nothing, and two minutes on Ana's base is sheltered.
  room.wreck(world.actor(raider)); Object.assign(capture, { progress: 1, at: world.time });
  assert(until(() => !faction(ana).capture, 5));
  const over = world.time;
  run(SHELTER_CALM - 2); assert.equal(faction(ana).shelter, null);
  run(3.5); assert(faction(ana).shelter > over);
});

test('what a base shelters fires on nobody nor is fired on, until a member comes back', t => {
  const { room, world, players: [ana, bia], faction, publish, put, order, run } = field(t, 'Ana', 'Bia');
  const tank = publish(ana, 'heavy', { x: 40, facing: 1 }), theirs = publish(bia, 'heavy');
  order(ana, 'stance', { ids: [tank], stance: 'fire' }); order(bia, 'stance', { ids: [theirs], stance: 'fire' });
  room.disconnect(ana.playerId); faction(ana).away = world.time - SHELTER_AWAY; run(.5);
  assert.notEqual(faction(ana).shelter, null);
  // Bia's tank comes within reach, on the near side of the crest at 350 m (from 390 m on, Ana's sight grazes it): neither fires.
  put(theirs, 350); run(20);
  const shots = () => [tank, theirs].map(id => world.actor(id).stats.shots);
  assert.deepEqual(shots(), [0, 0]);
  // Ana comes back: the two tanks fire on each other.
  room.join('Ana', ana.token); run(20);
  assert(shots().every(count => count > 0), `shots ${shots()}`);
});

test('a base is sheltered seven days at most after the last member left, and not again before one comes back', t => {
  const { room, world, players: [ana], faction, run } = field(t, 'Ana', 'Bia');
  room.disconnect(ana.playerId); faction(ana).away = world.time - SHELTER_LONGEST + 1; run(.5);
  assert.notEqual(faction(ana).shelter, null);
  run(1); assert.equal(faction(ana).shelter, null, 'seven days on');
  run(SHELTER_AWAY); assert.equal(faction(ana).shelter, null, 'and not again');
  room.join('Ana', ana.token); room.disconnect(ana.playerId); run(SHELTER_AWAY + 1);
  assert.notEqual(faction(ana).shelter, null, 'once she came back and left, it is sheltered again');
});

test('since when a faction is away, when it last fought and its shelter are kept with the field, and the shelter holds on the field resumed', t => {
  const { room, world, players: [ana, bia], faction, publish, run } = field(t, 'Ana', 'Bia');
  const lorry = publish(ana, 'truck'); run(1);
  room.disconnect(ana.playerId); Object.assign(faction(ana), { away: world.time - SHELTER_AWAY, fought: world.time - SHELTER_CALM - 3 }); run(.5);
  const was = faction(ana), told = ({ away, fought, shelter }) => [away, fought, shelter];
  assert.notEqual(was.shelter, null);
  const kept = JSON.parse(JSON.stringify(room.keep()));
  assert.deepEqual(told(kept.factions.find(f => f.id === was.id)), told(was));
  const again = rehearsal(BASES, undefined, { kept }); t.after(() => again.world.dispose());
  assert.deepEqual(told(again.factions.get(was.id)), told(was), 'Ana was away: as she was');
  assert.deepEqual(told(again.factions.get(bia.faction.id)), [again.world.time, null, null], 'Bia was on the field: away from when it was resumed');
  // The core is told of the shelter at the first look of the field resumed: what the base shelters takes no harm.
  for (let i = 0; i < 10; i++) again.step();
  const before = harm(again.world, lorry);
  blast(again.world, lorry); for (let i = 0; i < 30; i++) again.step();
  assert.equal(harm(again.world, lorry), before);
});
