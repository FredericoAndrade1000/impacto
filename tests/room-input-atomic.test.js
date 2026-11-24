import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { onField } from './helpers/field.js';

function controlled(t) {
  const f = onField(t, rehearsal([-100])), player = f.room.join('Atomic input'), id = f.publish(player, 'heavy', { facing: 1 });
  f.order(player, 'control', { id });
  const gun = f.world.modules.find(piece => piece.actorId === id && piece.kind === 'weapon'),
    weapon = f.world.playerWeapon({ platform: 'vehicle', componentId: gun.id }, id),
    aim = angle => ({ x: gun.x + Math.cos(angle) * 80, y: gun.y + Math.sin(angle) * 80 });
  return { ...f, player, id, gun, weapon, aim,
    sync: () => f.world.game().call({ op: 'sync' }),
    send: (type, data) => f.room.command(player.playerId, { type, actorId: id, ...data }) };
}

test('a refused shared-field firing input cannot cancel a queued shot or spend its resources', t => {
  const f = controlled(t), aim = f.aim(f.gun.angle - .3);
  f.send('fire', { aim, weapon: f.weapon, queue: true }); f.sync();
  assert(f.world.actor(f.id).pendingShot, 'the valid input left a shot waiting for its barrel');
  const before = structuredClone(f.world.snapshot()), pending = structuredClone(f.world.actor(f.id).pendingShot);
  for (const invalid of [
    { aim: { x: NaN, y: 0 }, weapon: f.weapon },
    { aim, weapon: { ...f.weapon, id: 'unknown' } },
    { aim, weapon: { ...f.weapon, charge: 'invalid' } },
  ]) {
    assert.throws(() => f.send('fire', { ...invalid, cancel: true }), /inválid|fora do campo/);
    f.sync(); assert.deepEqual(f.world.actor(f.id).pendingShot, pending); assert.deepEqual(f.world.snapshot(), before);
  }
});

test('only a boolean trigger release discards its obsolete aim and weapon setup', t => {
  const f = controlled(t), aim = f.aim(f.gun.angle);
  for (const active of [0, null, undefined, 'yes'])
    assert.throws(() => f.send('trigger', { active, aim, weapon: f.weapon }), /Gatilho inválido/);
  assert.deepEqual(f.send('trigger', { active: false, cancel: true, aim: { x: NaN }, weapon: { id: 'unknown' } }), {});
  f.sync(); assert.equal(f.world.actor(f.id).trigger, null); assert.equal(f.world.actor(f.id).stats.shots, 0);
});

test('a refused trigger does not consume the valid first pull of the same field tick', t => {
  const disturbed = controlled(t), reference = controlled(t);
  assert.throws(() => disturbed.send('trigger', { active: true, aim: disturbed.aim(disturbed.gun.angle),
    weapon: { ...disturbed.weapon, charge: 'invalid' } }), /inválido/);
  for (const f of [disturbed, reference]) {
    f.send('trigger', { active: true, aim: f.aim(f.gun.angle), weapon: f.weapon }); f.sync();
  }
  assert.equal(reference.world.actor(reference.id).stats.shots, 1, 'the admitted first pull fires immediately');
  assert.equal(disturbed.world.actor(disturbed.id).stats.shots, 1, 'a malformed pull has no effect on the next one');
});
