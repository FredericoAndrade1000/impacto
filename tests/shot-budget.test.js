import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { SHOT_BUDGET } from '../src/construction-limits.ts';
import { SharedRoom } from '../server/room.ts';
import { duel } from './helpers/duel.js';

// A world with a budget holds the fire of a side with that many rounds in the air (native core, game_shot_budget.rs):
// the round stays in its box, the field says why, and the gun fires again once they come down. The shared field is
// made with the budget of the field.
test('a side with its share of rounds in the air holds its fire, its round unspent, until they come down', t => {
  const w = duel(t, createStructuredTemplate('ifv', { preset: 'minimi' }), { shotBudget: { faction: 2, own: 0 } });
  const shot = actorId => {
    const gun = w.modules.find(m => m.actorId === actorId && m.kind === 'weapon'),
      settings = w.playerWeapon({ platform: 'vehicle', componentId: gun.id, aimAngle: gun.barrelAngle }, actorId),
      aim = { x: gun.x + 20 * Math.cos(gun.barrelAngle), y: gun.y + 20 * Math.sin(gun.barrelAngle) };
    return w.fire(aim, settings, true, actorId);
  };
  const rounds = actorId => w.modules.filter(m => m.actorId === actorId && m.kind === 'ammo').reduce((sum, m) => sum + m.rounds, 0);
  assert(shot('local') && shot('local'));
  const left = rounds('local');
  assert.equal(shot('local'), false, 'its side has its share in the air');
  assert.equal(rounds('local'), left, 'the round it held is still in its box');
  assert.deepEqual(w.drainEvents().filter(e => e.type === 'weapon-blocked').map(e => [e.reason, e.actorId]), [['budget', 'local']]);
  assert(shot('opponent'), 'another side has its own share');
  for (let i = 0; i < 600 && w.projectiles.length; i++) w.step();
  assert.equal(w.projectiles.length, 0, 'the rounds came down');
  assert(shot('local'), 'with them down it fires again');
});

test('the shared field lets a faction 1024 rounds in the air, and each construction 4 of its own', t => {
  const room = new SharedRoom({ starter: false, build: false }); t.after(() => room.field.dispose());
  assert.equal(room.field.shotBudget, SHOT_BUDGET);
  assert.deepEqual(SHOT_BUDGET, { faction: 1024, own: 4 });
});
