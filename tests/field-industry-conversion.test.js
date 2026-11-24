import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { BASIC_INDUSTRY } from '../src/industry.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { convertIndustryField, FROM_SAVE } from '../scripts/convert-field-industry.ts';
import { onField } from './helpers/field.js';

test('an explicit industry conversion preserves a legacy fleet and resources, grants existing capabilities, and reopens with basic facilities for new factions', t => {
  const room = rehearsal([-213, 20000]), f = onField(t, room), joined = room.join('Legacy'),
    faction = room.faction(room.players.get(joined.playerId)), id = f.publish(joined, 'heavy');
  faction.yard.ferro = 1234;
  const before = JSON.parse(JSON.stringify(room.keep()));
  delete before.startingIndustry; before.startingResearch = [];
  for (const row of before.factions) { delete row.industry; row.research = { completed: [], points: 3 }; }
  const make = kept => rehearsal([-213, 20000], undefined, { kept }),
    { text, receipt } = convertIndustryField(JSON.stringify({ save: FROM_SAVE, room: before }), 'upgrade', make), converted = JSON.parse(text);
  assert.equal(converted.save, FIELD_SAVE); assert.equal(converted.at, 'upgrade');
  assert.equal(receipt.retiredPoints, 3);
  const kept = converted.room, restored = make(kept); t.after(() => restored.world.dispose());
  assert.deepEqual(kept.factions[0].stock, before.factions[0].stock);
  assert.deepEqual(kept.factions[0].yard, before.factions[0].yard);
  assert.deepEqual(restored.world.actor(id).construction, room.world.actor(id).construction);
  assert.equal(kept.factions[0].industry.levels.workshop, 3);
  assert(!Object.hasOwn(kept.factions[0], 'research'));
  assert.deepEqual(kept.factions[0].industry.capital, { ferro: 0, ligas: 0, silica: 0, combustivel: 0 });
  const newcomer = restored.join('New player');
  assert.deepEqual(restored.factions.get(newcomer.faction.id).industry.levels, BASIC_INDUSTRY);
  assert.deepEqual(JSON.parse(JSON.stringify(before.factions[0].stock)), faction.stock, 'the input was not mutated');
});

test('the industry converter accepts saved ground contacts with or without the legacy grounded observation', t => {
  const room = rehearsal([-213, 20000]), f = onField(t, room), joined = room.join('Legacy');
  f.publish(joined, 'heavy'); f.run(1);
  const before = JSON.parse(JSON.stringify(room.keep()));
  delete before.startingIndustry; before.startingResearch = [];
  for (const row of before.factions) { delete row.industry; row.research = { completed: [], points: 3 }; }
  assert.ok(before.scene.modules.some(module => module.groundContact), 'a wheel was read on the ground when the field was saved');
  const make = kept => rehearsal([-213, 20000], undefined, { kept });
  for (const grounded of [true, false]) {
    const saved = structuredClone(before);
    if (!grounded) for (const actor of saved.scene.actors) if (actor.vehicle) delete actor.vehicle.grounded;
    const { receipt } = convertIndustryField(JSON.stringify({ save: FROM_SAVE, room: saved }), 'upgrade', make);
    assert.equal(receipt.to, FIELD_SAVE);
  }
});

test('the industry converter refuses a wrong format or facilities already present rather than guessing', t => {
  const room = rehearsal([-213]); t.after(() => room.world.dispose()); room.join('Legacy');
  const kept = JSON.parse(JSON.stringify(room.keep())), make = state => rehearsal([-213], undefined, { kept: state });
  assert.throws(() => convertIndustryField(JSON.stringify({ save: FIELD_SAVE, room: kept }), 'now', make));
  assert.throws(() => convertIndustryField(JSON.stringify({ save: FROM_SAVE, room: kept }), 'now', make));
});

test('the industry converter refuses a lossy restore even when its result reopens consistently', t => {
  const room = rehearsal([-213]); t.after(() => room.world.dispose()); room.join('Legacy');
  const kept = JSON.parse(JSON.stringify(room.keep()));
  delete kept.startingIndustry; kept.startingResearch = [];
  for (const faction of kept.factions) { delete faction.industry; faction.research = { completed: [], points: 0 }; }
  const lossy = state => {
    const restored = rehearsal([-213], undefined, { kept: state });
    for (const faction of restored.factions.values()) faction.stock.ferro = 0;
    return restored;
  };
  assert.throws(() => convertIndustryField(JSON.stringify({ save: FROM_SAVE, room: kept }), 'now', lossy), /alterou o estado existente/);
});
