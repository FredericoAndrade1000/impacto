import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { STARTING_STOCK, BASE_RADIUS, LOAD_REACH } from '../src/economy.ts';
import { RESERVE_STEP } from '../src/deposits.ts';

test('new factions know usable iron and petroleum without extra stock, invented deposits or remote advanced-resource intelligence', t => {
  for (const seed of [7, 1234, 987654]) {
    let draw = seed;
    const room = new SharedRoom({ starter: false, random: () => (draw = draw * 16807 % 2147483647) / 2147483647 });
    t.after(() => room.world.dispose());
    const deposits = structuredClone(room.deposits);
    for (let n = 0; n < 12; n++) {
      const player = room.join(`Jogador ${n}`), faction = room.factions.get(player.faction.id);
      assert.deepEqual(faction.stock, STARTING_STOCK);
      for (const material of ['ferro', 'petroleo']) {
        const site = room.endow(faction.base, material);
        assert(site && room.known(faction, site), `${material} is identified for the new faction`);
        assert(room.left(site) >= RESERVE_STEP);
        assert(Math.abs(site.x - faction.base.x) > BASE_RADIUS + LOAD_REACH);
      }
      assert.equal(faction.met.size, 0);
      assert.equal(faction.bases.size, 0);
      assert([...faction.veins.keys()].every(id => {
        const site = room.sites.get(id);
        return ['ferro', 'petroleo'].includes(site.material) || Math.abs(site.x - faction.base.x) <= 1000;
      }), 'advanced deposits beyond the initial surveyed ground still require exploration');
    }
    assert.deepEqual(room.deposits, deposits, 'placement changes neither geography nor geological reserves');
    const bases = room.bases().sort((a, b) => a - b);
    assert(bases.slice(1).every((x, n) => x - bases[n] >= 10000 && x - bases[n] <= 30000));
  }
});

test('foundation advice prefers an available source over an empty closer vein and retains finite piles and depleted-world fallback', t => {
  const room = new SharedRoom({ starter: false, base: () => 0 }); t.after(() => room.world.dispose());
  const player = room.join('Coleta'), faction = room.factions.get(player.faction.id), before = { ...faction.stock };
  for (const material of ['ferro', 'petroleo']) {
    const first = room.endow(faction.base, material);
    room.veins.set(first.id, 0);
    const alternative = room.endow(faction.base, material);
    assert.notEqual(alternative.id, first.id, 'an exhausted nearest vein does not hide an available alternative');
    room.stake(faction);
    assert(room.known(faction, alternative)?.left >= RESERVE_STEP);
    assert.equal(room.left(first), 0, 'advice does not refill an exhausted vein');
    room.extracted.set(first.id, 1);
    assert.equal(room.endow(faction.base, material).id, alternative.id, 'an invisible crumb is not a useful starting load');
    room.extracted.set(first.id, 500);
    assert.equal(room.endow(faction.base, material).id, first.id, 'a real ready pile is usable even with an empty vein');
    room.extracted.delete(first.id);
    for (const site of room.deposits) if (site.material === material) room.veins.set(site.id, 0);
    assert.equal(room.endow(faction.base, material).id, first.id, 'fully depleted resources keep their nearest regenerating site');
    room.stake(faction); assert.equal(room.known(faction, first).left, 0);
  }
  assert.deepEqual(faction.stock, before);
  assert.equal(room.world.actors.length, 0);
});
