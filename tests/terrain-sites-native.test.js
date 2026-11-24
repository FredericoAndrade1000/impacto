import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { constructionSite } from '../server/field-construction.ts';
import { STOCK_IDS, billSum, carriedBy, supplied } from '../src/economy.ts';

// The ordinary world/6173 draw, six independently founded factions, their real
// starter fleet and defenses put up off their bases, paid from their stocks. No custom poses or free stock.
test('six ordinary bases admit their starter and defense without damage or paid repairs during a minute at rest', { timeout: 60000 }, t => {
  const room = new SharedRoom({ build: false }), world = room.world, admitted = [],
    // Normal base provisioning transfers stock into the new constructor. Repairs would consume this total.
    resources = faction => billSum(faction.stock, supplied(carriedBy(room.enlisted(faction).flatMap(actor => room.crates(actor.id))).carried));
  t.after(() => world.dispose());
  for (let i = 0; i < 6; i++) {
    const joined = room.join('Base de terreno ' + (i + 1)), owner = room.players.get(joined.playerId),
      starter = room.owned(owner.id)[0], faction = room.faction(owner), source = createStructuredTemplate('guard-post'),
      available = [];
    for (const offset of [160, 172, 184, 196, 208, 220, 232, 244].flatMap(d => [d, -d])) try {
      constructionSite(room, faction, source, faction.base.x + offset, faction.base.facing);
      available.push(faction.base.x + offset);
    } catch (error) {
      assert.match(error.message, /nivelado|espaço/, 'reject only ordinary grade/occupancy conflicts beside the base');
    }
    assert(available.length > 0, `base ${faction.base.x} must have a level, unoccupied site for a defense beside it`);
    // Its works is opened, its whole bill brought from the stocks of the faction, and it is put up.
    owner.builtAt = -Infinity;
    const works = room.works.pending.get(room.command(owner.id, { type: 'spawn', blueprint: source, x: available[0], facing: faction.base.facing }).work.id);
    for (const id of STOCK_IDS) { faction.stock[id] -= works.cost[id]; works.delivered[id] = works.cost[id]; }
    works.progress = 1; room.works.complete(works);
    const defenseId = works.id, defense = world.actor(defenseId);
    assert(starter?.vehicle && !starter.defeated, 'the normal starter must be admitted');
    assert.equal(defense.vehicle, null, 'the defense keeps fixed-body admission');
    const bounds = world.actorBounds(defense.id);
    assert(Number.isFinite(bounds.minX + bounds.maxX + bounds.minY + bounds.maxY));
    admitted.push({ base: faction.base.x, faction: faction.id, availableDefenseSites: available.length,
      starter: starter.id, defense: defense.id, paidMaterials: resources(faction) });
  }
  const parts = () => [...world.plates, ...world.modules], key = part => part.actorId + '/' + part.id,
    condition = part => [part.health, part.integrity, part.revision ?? 0, part.markRevision ?? 0,
      part.marks?.length ?? 0, part.dents?.size ?? 0],
    material = part => structuredClone({ condition: condition(part), marks: part.marks ?? [],
      dents: [...(part.dents?.values() || [])], ballisticScars: part.ballisticScars ?? [], barrelMarks: part.barrelMarks ?? [] }),
    before = new Map(parts().map(part => [key(part), material(part)]));
  t.diagnostic(JSON.stringify(admitted));
  for (let step = 0; step < 60 * 60; step++) {
    room.step();
    const now = parts();
    assert.equal(now.length, before.size, 'resting constructions keep every installed piece');
    for (const part of now) assert.deepEqual(condition(part), before.get(key(part))?.condition,
      `${key(part)} must not acquire damage while resting at ${world.time.toFixed(2)} s`);
    // Check every frame so an automatic repair cannot hide damage before the final comparison.
    for (const row of admitted) {
      const kept = resources(room.factions.get(row.faction));
      for (const id of STOCK_IDS) assert(Math.abs(kept[id] - row.paidMaterials[id]) < 1e-6,
        `base ${row.base} must not consume ${id} after its defense was paid for; base provisioning only transfers it`);
      for (const id of [row.starter, row.defense]) assert.notEqual(room.records.get(id).service?.kind, 'repair',
        `${id} must not need automatic repair without being driven or attacked`);
    }
  }
  for (const part of parts()) assert.deepEqual(material(part), before.get(key(part)),
    `${key(part)} preserves all marks, dents and material state after a minute at rest`);
  for (const row of admitted) {
    const starter = world.actor(row.starter), v = starter.vehicle;
    assert(Number.isFinite(v.x + v.y + v.angle + v.vx + v.vy));
    assert(Math.cos(v.angle) > .8, 'a starter should settle upright without being driven');
    assert(!starter.defeated && !world.actor(row.defense).defeated);
  }
  assert.equal(world.dynamics.recoveries, 0);
  t.diagnostic(`all ${before.size} pieces and six paid stocks remain intact after ${world.time.toFixed(1)} s`);
});
