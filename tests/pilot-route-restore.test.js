import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom, rehearsal } from '../server/room.ts';
import { onField } from './helpers/field.js';

test('current restoration resumes named hauls while preserving physical blocks, retreats and idle vehicles', t => {
  const original = rehearsal([0], undefined, { fog: false }), f = onField(t, original), player = original.join('Retomada'),
    ids = [-45, -15, 15, 45].map(x => f.publish(player, 'mining-truck', { x })),
    site = original.prospected(original.faction(original.players.get(player.playerId))).find(site => site.material === 'ferro');
  assert(site);
  f.order(player, 'haul', { ids: ids.slice(0, 3), depositId: site.id });
  const kept = JSON.parse(JSON.stringify(original.keep())), orders = new Map(kept.players[0].orders),
    [continuing, physicallyBlocked, retreating] = ids.map(id => orders.get(id));
  Object.assign(continuing, { halt: '', move: null });
  Object.assign(physicallyBlocked, { halt: 'stuck-ground', move: null });
  Object.assign(physicallyBlocked.haul, { phase: 'home', blocked: 'stuck-ground' });
  Object.assign(retreating, { halt: 'enemy-near', move: null });
  Object.assign(retreating.haul, { phase: 'home', fled: true, threat: 'encounter-before-save' });

  const restored = new SharedRoom({ kept, starter: false, build: false, fog: false }); t.after(() => restored.field.dispose());
  restored.join('Retomada', player.token);
  const squad = restored.players.get(player.playerId).squad, units = ids.map(id => squad.units.get(id));
  assert.equal(units[0].halt, ''); assert.equal(units[0].haul.blocked, undefined);
  assert.equal(units[0].haul.depositId, site.id, 'the original destination and material remain the haul purpose');
  assert.equal(units[1].halt, 'stuck-ground'); assert.equal(units[1].haul.blocked, 'stuck-ground');
  assert.equal(units[2].halt, 'enemy-near'); assert.equal(units[2].haul.fled, true);
  assert.equal(units[3].halt, ''); assert.equal(units[3].move, null, 'an idle vehicle remains idle');
  restored.step();
  assert(units[0].move, 'the named haul creates its next normal drive leg after restoration');
  assert.equal(units[1].move, null, 'a physically blocked return still waits for help');
  assert.equal(units[2].haul, null, 'the empty retreat ends at its base without beginning another exposed trip');
  assert.equal(units[2].reason, 'enemy-near');
  assert.equal(units[3].move, null);
  squad.command({ order: 'move', ids: [ids[3]], x: 200 });
  assert(units[3].move, 'the idle vehicle accepts an explicit new order');
});
