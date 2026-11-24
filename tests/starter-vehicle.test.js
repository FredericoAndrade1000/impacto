import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { reserveState } from '../src/component-volume.ts';
import { BASE_RADIUS, STARTING_STOCK } from '../src/economy.ts';

test('the additional starter is the ordinary editable light scout, mechanically admitted with fuel and matching ammunition', () => {
  const source = createStructuredTemplate('scout'), compiled = compileStructuredConstruction(source),
    { chassis, modules } = compiled, weapon = modules.find(piece => piece.kind === 'weapon'),
    ammo = modules.find(piece => piece.kind === 'ammo'), fuel = modules.find(piece => piece.kind === 'fuel');
  assert.equal(compiled.mechanicalAdmission, true);
  assert.equal(chassis.kind, 'wheeled'); assert.equal(source.chassis.axles.length, 2);
  assert(chassis.loadedKg > 0 && chassis.loadedKg <= chassis.limitKg, 'full reserves fit the real chassis and running gear');
  assert(modules.some(piece => piece.kind === 'engine') && modules.some(piece => piece.kind === 'command'));
  assert.equal(weapon.weaponPreset, 'm2hb'); assert.equal(ammo.ammoPreset, weapon.weaponPreset);
  assert(reserveState(ammo).rounds > 0 && reserveState(fuel).fuelLitres > 0);
});

test('new factions receive a ready miner, scout and constructor without preselection or spending stock', t => {
  const room = new SharedRoom(); t.after(() => room.world.dispose());
  for (let i = 0; i < 6; i++) {
    const joined = room.join('Iniciante ' + i), owner = room.players.get(joined.playerId), [miner, scout, constructor] = room.owned(owner.id),
      bounds = [miner, scout, constructor].map(actor => room.world.actorBounds(actor.id));
    assert.equal(joined.actors.length, 3); assert.equal(joined.selected, null, 'the first selection is an explicit player action');
    assert.deepEqual(joined.actors.map(actor => actor.blueprint), ['mining-truck', 'scout', 'construction-truck'].map(id => createStructuredTemplate(id)));
    assert.deepEqual(joined.faction.stock, { ...STARTING_STOCK });
    assert.equal(joined.faction.count, 3); assert.equal(joined.faction.units.length, 3);
    assert.deepEqual(room.squadView(owner.id).units.map(unit => unit.id), [miner.id, scout.id, constructor.id]);
    assert.equal(owner.squad.manual, null, 'joining keeps manual control an explicit action');
    for (const [i, first] of bounds.entries()) for (const next of bounds.slice(i + 1))
      assert(first.maxX + .8 < next.minX || next.maxX + .8 < first.minX, 'starter vehicles use ordinary occupied-span placement');
    for (const actor of [miner, scout, constructor]) {
      assert.equal(actor.ownerId, owner.id); assert.equal(actor.team, joined.faction.id);
      assert.equal(actor.facing, joined.base.facing); assert.equal(actor.playerName, owner.name);
      assert(Math.abs(actor.vehicle.x - joined.base.x) <= BASE_RADIUS);
      assert.equal(room.record(actor).service, null); assert.equal(room.held(actor), '');
      assert(!actor.defeated);
      assert(room.world.modules.filter(piece => piece.actorId === actor.id && piece.kind === 'fuel').every(piece => reserveState(piece).fuelLitres > 0));
    }
    assert.equal(room.record(constructor).auto, true, 'the constructor comes in automatic');
    assert(room.serving(constructor.id).every(piece => !Object.values(piece.cargo ?? {}).some(units => units > 0)), 'with nothing aboard that no job asks of it');
    assert(room.serving(constructor.id).length > 0 && room.world.modules.some(piece => piece.actorId === constructor.id && piece.kind === 'builder'),
      'the constructor has an ordinary supply container and an attached construction mechanism');
  }
  assert.equal(room.world.actors.length, 18);
});

test('the granted scout can be selected and driven immediately while the truck stays in the squad', t => {
  const room = new SharedRoom({ base: () => 0 }); t.after(() => room.world.dispose());
  const joined = room.join('Motorista'), owner = room.players.get(joined.playerId), [miner, scout, constructor] = room.owned(owner.id),
    start = scout.vehicle.x;
  assert.deepEqual(room.command(owner.id, { type: 'select', actorId: scout.id }), { selected: scout.id });
  assert.equal(owner.squad.manual, scout.id);
  assert.deepEqual(room.command(owner.id, { type: 'drive', actorId: scout.id, request: 1, throttle: 1, brake: 0 }), {});
  for (let i = 0; i < 60; i++) room.step();
  assert(Math.abs(scout.vehicle.x - start) > .1, 'native propulsion moves the granted vehicle');
  assert.equal(room.record(scout).service, null);
  assert.deepEqual(room.owned(owner.id).map(actor => actor.id), [miner.id, scout.id, constructor.id]);
});

test('saved or returning seats retain their existing fleet without retroactive grants or duplicate starter vehicles', t => {
  const room = new SharedRoom(); t.after(() => room.world.dispose());
  const joined = room.join('Persistente'), ids = joined.actors.map(actor => actor.id),
    kept = JSON.parse(JSON.stringify(room.keep())), resumed = new SharedRoom({ kept });
  t.after(() => resumed.world.dispose());
  assert.deepEqual(resumed.join('Persistente', joined.token).actors.map(actor => actor.id), ids);
  resumed.disconnect(joined.playerId);
  assert.deepEqual(resumed.join('Persistente', joined.token).actors.map(actor => actor.id), ids);
  const old = new SharedRoom({ starter: false }); t.after(() => old.world.dispose());
  const earlier = old.join('Sem concessão'), existing = new SharedRoom({ kept: JSON.parse(JSON.stringify(old.keep())) });
  t.after(() => existing.world.dispose());
  assert.deepEqual(existing.join('Sem concessão', earlier.token).actors, [], 'an existing seat receives no upgrade grant');
  assert.equal(existing.join('Novo').actors.length, 3, 'the new kit is granted only to a new seat');
});

test('an earlier two-vehicle fleet and its explicit selection remain unchanged when the tutorial gains a constructor', t => {
  const room = new SharedRoom(); t.after(() => room.world.dispose());
  const player = room.join('Anterior'), [miner, scout, constructor] = room.owned(player.playerId);
  room.discard(constructor.id);
  room.command(player.playerId, { type: 'select', actorId: scout.id });
  const resumed = new SharedRoom({ kept: JSON.parse(JSON.stringify(room.keep())) }); t.after(() => resumed.world.dispose());
  const back = resumed.join('Anterior', player.token);
  assert.deepEqual(back.actors.map(actor => actor.id), [miner.id, scout.id]);
  assert.equal(back.selected, scout.id, 'returning keeps explicit focus instead of applying the fresh-player rule');
  assert.equal(resumed.players.get(player.playerId).squad.manual, null, 'rejoining still commands rather than drives');
});

test('resuming an earlier miner preserves its authored motor and frame instead of silently replacing it with the new starter', t => {
  const room = new SharedRoom({ base: () => 0 }); t.after(() => room.world.dispose());
  const joined = room.join('Projeto preservado'), [miner] = room.owned(joined.playerId), earlier = createStructuredTemplate('mining-truck');
  earlier.chassis.thicknessMm = 20;
  earlier.components.find(part => part.kind === 'engine').sizeScale *= Math.sqrt(115 / 180);
  const canonical = validateStructuredConstruction(earlier);
  room.world.replaceActor(canonical, { id: miner.id, rest: true });
  const resumed = new SharedRoom({ kept: JSON.parse(JSON.stringify(room.keep())) }); t.after(() => resumed.world.dispose());
  assert.deepEqual(resumed.world.actor(miner.id).construction, canonical);
  assert.equal(compileStructuredConstruction(resumed.world.actor(miner.id).construction).chassis.thicknessMm, 20);
  assert.deepEqual(resumed.join('Projeto preservado', joined.token).actors.map(actor => actor.id), joined.actors.map(actor => actor.id));
  assert.notDeepEqual(resumed.world.actor(miner.id).construction, createStructuredTemplate('mining-truck'));
});
