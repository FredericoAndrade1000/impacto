import test from 'node:test';
import assert from 'node:assert/strict';
import { stressField, STRESS_FIELD } from '../server/stress-field.ts';
import { ROOM_LIMITS, rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { Publication } from '../server/publication.ts';

test('the stress factory manufactures its full vehicle allowance with supported 20 mm guns', t => {
  assert.equal(STRESS_FIELD.battles.length * STRESS_FIELD.perBattle, 20, 'the reference workload stays at twenty factions');
  const { room } = stressField(1); t.after(() => room.world.dispose());
  const [player] = room.players.values(), actors = room.owned(player.id);
  assert.equal(actors.length, ROOM_LIMITS.perFaction.vehicles);
  for (const actor of actors) {
    assert.equal(actor.construction.name, 'Pesado 20 mm');
    const gun = actor.construction.components.find(part => part.kind === 'weapon');
    assert.equal(gun.weaponPreset, 'rh202');
    assert.equal(gun.mount.preset, 'medium-trunnion');
    assert.deepEqual(gun.mount.sector, { min: -.08, max: .08 });
    const magazines = actor.construction.components.filter(part => part.kind === 'ammo');
    assert(magazines.length > 0);
    assert(magazines.every(part => part.ammoPreset === 'rh202'));
  }
});

// A publication handed what the core changed since it last read (`sources`) passes over the plates and pieces that did not
// change, on a vehicle that did not move: in a battle, it publishes turn after turn what a publication that reads all does.
test('a publication by parts publishes what a whole one does, and passes over the parts that did not change', t => {
  const { room, feed } = stressField(4), world = room.world, parted = new Publication(), whole = new Publication(), changes = world.rustGame;
  t.after(() => world.dispose());
  let turns = 0, asked = 0, still = 0, shots = 0;
  // What the core changed, as it tells it, counting how often it tells a part unchanged: the same teller every turn.
  const counted = { get frames() { return changes.frames; }, get whole() { return changes.whole; },
    changedAfter(object, frame) { const changed = changes.changedAfter(object, frame); asked++; if (!changed) still++; return changed; } };
  for (let step = 0; step < 240; step++) {
    room.step({ quiet: true }); feed(world.time);
    if (step % 3 !== 2) continue;
    const [by, all] = world.snapshot((state, sources) => [parted.state(state, { ...sources, changes: counted }), whole.state(state)]);
    shots += world.drainEvents().filter(event => event.type === 'muzzle').length; turns++;
    assert.deepEqual(by, all, `turn ${turns}: the publication by parts agrees with the whole one`);
  }
  assert(shots > 0, 'the battle was fought');
  assert(still > asked / 4, `the core told many parts unchanged (${still} of ${asked})`);
  assert(still < asked, 'and some changed');
});

// What the core changes of a piece on a vehicle that stands — a magazine hit, which the vehicle does not feel — is told by the
// piece alone: a publication by parts publishes it.
test('a piece the core changes on a vehicle that stands is published as it changed', t => {
  const { room } = stressField(1), world = room.world, parted = new Publication(), whole = new Publication(), changes = world.rustGame;
  t.after(() => world.dispose());
  const publish = () => world.snapshot((state, sources) => [parted.state(state, sources), whole.state(state)]);
  for (let step = 0; step < 180; step++) { room.step({ quiet: true }); if (step % 3 === 2) { publish(); world.drainEvents(); } }
  const since = changes.frames, standing = world.modules.find(module => module.kind === 'ammo' && module.health > 1 && world.actor(module.actorId)?.vehicle &&
    !changes.changedAfter(world.actor(module.actorId).vehicle, since));
  assert(standing, 'a vehicle of the faction stands');
  const health = standing.health / 2;
  world.command('setPartState', { owner: world.game().handle(standing), state: { health } });
  assert.equal(changes.changedAfter(world.actor(standing.actorId).vehicle, since), false, 'its vehicle still stands');
  const [by, all] = publish();
  assert.deepEqual(by, all);
  assert.equal(by.modules.find(module => module.id === standing.id).health, health, 'the piece is published as it is now');
});

// What the server puts into a piece itself — the load of a hopper, told to the core without a frame back — it says the piece
// changed (`touch`): a publication by parts publishes the load before the core reads the piece again.
test('a load the server stows on a vehicle that stands is published at once', t => {
  const room = rehearsal(), world = room.world, parted = new Publication(), whole = new Publication(), changes = world.rustGame;
  t.after(() => world.dispose());
  world.addActor(createStructuredTemplate('mining-truck'), { id: 'lorry', x: 60 });
  const publish = () => world.snapshot((state, sources) => [parted.state(state, sources), whole.state(state)]);
  for (let step = 0; step < 240; step++) { world.step(); if (step % 3 === 2) { publish(); world.drainEvents(); } }
  const [hopper] = room.pieces('lorry'), since = changes.frames;
  assert(hopper, 'the lorry has a hopper');
  room.carry(new Map([[hopper, { ferro: 500 }]]));
  assert.equal(changes.changedAfter(world.actor('lorry').vehicle, since), false, 'the lorry stands');
  const [by, all] = publish();
  assert.deepEqual(by, all);
  assert.deepEqual(by.modules.find(module => module.id === hopper.id).cargo, { ferro: 500 }, 'the load is published');
});
