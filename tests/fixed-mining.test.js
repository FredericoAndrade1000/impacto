import { FULL_INDUSTRY } from '../src/industry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { RECOVERY_SECONDS } from '../src/deposits.ts';
import { carriedBy } from '../src/economy.ts';
import { onField } from './helpers/field.js';

// What the veins of a room gain back by themselves from now on (room.ts `replenish`), counted site by site: a vein dug
// holds what it held less what was dug of it, plus that.
function regrowth(room) {
  const back = new Map(), replenish = room.replenish.bind(room);
  room.replenish = seconds => {
    const was = [...room.veins];
    replenish(seconds);
    for (const [id, left] of was) back.set(id, (back.get(id) ?? 0) + room.left(room.sites.get(id)) - left);
  };
  return site => back.get(site.id) ?? 0;
}

for (const material of ['ferro', 'ligas', 'silica']) for (const facing of [-1, 1])
  test(`a paid fixed miner extracts ${material}, facing ${facing}, into the public pile on real terrain`, t => {
    let base;
    // Every generated deposit holds a vein; the field, fuel and tool are real.
    const f = onField(t, new SharedRoom({ industry: FULL_INDUSTRY, starter: false, build: false, fog: false, base: () => base })),
      { room, world, ground } = f, regrown = regrowth(room),
      site = room.deposits.filter(s => s.material === material &&
        Math.max(...[-9, -5, 0, 5, 9].map(dx => ground.height(s.x + dx))) -
        Math.min(...[-9, -5, 0, 5, 9].map(dx => ground.height(s.x + dx))) < .3)
        .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
    assert(site, 'a generated near-level vein is available');
    // Stand beside the vein and face the arm toward it, leaving its middle open for haulers.
    base = site.x - facing * 250;
    const player = room.join('Miner'), faction = room.faction(room.players.get(player.playerId)),
      stock = { ...faction.stock }, source = createConstruction('mining-site'),
      id = f.raise(player, source, { x: site.x + facing * 5, facing }),
      fuel = () => f.parts(id, 'fuel')[0], initialFuel = fuel().fuelLitres,
      reserve = () => room.left(site), pile = () => room.extracted.get(site.id) ?? 0;
    assert(faction.stock.ferro < stock.ferro && faction.stock.silica < stock.silica, 'the actual structure and footing are paid');
    assert.equal(world.actor(id).vehicle, null);
    assert(f.until(() => room.records.get(id).extraction?.some(e => e.siteId === site.id), 2), 'its actual arm reaches the surface');
    f.run(2);
    assert(pile() > 50, 'the full-sized excavator produces at a useful pace');
    assert(regrown(site) > 0 && regrown(site) <= site.reserve * world.time / RECOVERY_SECONDS, 'the vein comes back as it is dug');
    assert(Math.abs(reserve() + pile() - site.reserve - regrown(site)) < 1e-6,
      'the geological reserve, and what came back of it, becomes a public pile exactly once');
    assert(fuel().fuelLitres < initialFuel, 'the fixed engine consumes real fuel');
    assert.deepEqual(carriedBy(f.parts(id, 'hopper', 'cistern', 'supply')).carried, { ferro: 0, ligas: 0, silica: 0, petroleo: 0 });
    if (material === 'ferro' && facing === -1) {
      // A normal cargo order can collect beside the fixed producer without crossing its service house.
      const truck = f.publish(player, 'truck');
      f.order(player, 'haul', { ids: [truck], depositId: site.id });
      const aboard = () => carriedBy(f.parts(truck, 'hopper')).carried.ferro;
      assert(f.until(() => aboard() > 0, 45), 'a real hauler reaches and collects the miner output');
      assert(Math.abs(reserve() + pile() + aboard() - site.reserve - regrown(site)) < 1e-5);
      f.order(player, 'stop', { ids: [truck] });
      f.set(fuel(), { fuelLitres: 0 });
      const before = reserve(), came = regrown(site); f.run(1);
      assert(regrown(site) > came, 'the vein goes on coming back');
      assert(Math.abs(reserve() - before - (regrown(site) - came)) < 1e-9, 'extraction stops with no fuel');
      assert.equal(room.records.get(id).extraction, null);
      const saved = JSON.parse(JSON.stringify(room.keep())), kept = reserve(),
        back = onField(t, new SharedRoom({ kept: saved, fog: false })), regrownBack = regrowth(back.room);
      assert.deepEqual(back.world.actor(id).construction, source);
      assert.equal(back.parts(id, 'fuel')[0].fuelLitres, 0);
      assert.equal(back.room.extracted.get(site.id), pile());
      assert.equal(back.room.left(site), kept, 'the field resumes with the vein as it was kept');
      back.run(1);
      assert(Math.abs(back.room.left(site) - kept - regrownBack(site)) < 1e-9 && back.room.records.get(id).extraction === null,
        'restoring the field neither refills the tank nor restarts unpaid extraction');
    }
  });
