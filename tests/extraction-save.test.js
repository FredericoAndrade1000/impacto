import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom, rehearsal } from '../server/room.ts';
import { FieldHost, openRoom, replayField, DIARY } from '../server/field-host.ts';
import { STARTING_STOCK, STOCK_IDS, SUPPLIED, bill, billTotal, carriedBy, load, supplied, sharePile, TRANSFER_RATE, WRECK_SECONDS } from '../src/economy.ts';
import { cargoRoom, cargoSpace, cargoVolume, cargoUnitVolume } from '../src/component-volume.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { AIRDROP, activityView, resumeActivities, stepActivities } from '../server/world-activities.ts';
import { GUARDIAN, removeGuardian } from '../server/airdrop-guardian.ts';
import { depositsNear, recovered } from '../src/deposits.ts';
import { workArea } from '../src/loading-area.ts';
import { LOAD_REACH } from '../src/economy.ts';
import { onField } from './helpers/field.js';
import { FIELD_SAVE } from '../server/field-save.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { NETWORK_VERSION, keyOf } from '../src/network-protocol.ts';

test('the production default grants a ready miner, scout and constructor only to a genuinely new seat, without preselection', t => {
  const room = new SharedRoom(); t.after(() => room.field.dispose());
  const alice = room.join('Alice'), [design] = alice.actors, actor = room.world.actor(design.id),
    kinds = actor.blueprint.modules.map(piece => piece.kind);
  assert.equal(alice.actors.length, 3); assert.equal(alice.selected, null);
  assert.equal(actor.blueprint.chassis.kind, 'tracked');
  assert.equal(kinds.filter(kind => kind === 'excavator').length, 1);
  assert.equal(kinds.filter(kind => kind === 'hopper').length, 1);
  assert(!kinds.some(kind => ['weapon', 'cistern', 'drill'].includes(kind)));
  assert.equal(room.records.get(actor.id).service, null, 'the starter is ready, including when ordinary construction takes time');
  assert.deepEqual(alice.faction.stock, { ...STARTING_STOCK }, 'the internal grant is not charged to starting stocks');
  assert.equal(room.players.get(alice.playerId).squad.manual, null);
  room.disconnect(alice.playerId);
  assert.deepEqual(room.join('Alice', alice.token).actors.map(owned => owned.id), alice.actors.map(owned => owned.id));
  for (const owned of alice.actors) room.discard(owned.id);
  room.disconnect(alice.playerId);
  assert.deepEqual(room.join('Alice', alice.token).actors, [], 'returning to an empty squad grants nothing');
  const player = room.players.get(alice.playerId), faction = room.faction(player);
  Object.assign(faction.stock, bill()); room.recover(player);
  const [aided, ...more] = room.owned(alice.playerId);
  assert.deepEqual([more.length, aided.blueprint.modules.some(piece => piece.kind === 'hopper'), room.records.get(aided.id).service], [0, true, null],
    'the aid is one ore lorry, ready at once, never a second starter');
});

test('an explicitly empty rehearsal remains empty while the production default stays enabled', t => {
  const empty = rehearsal(); t.after(() => empty.field.dispose());
  assert.deepEqual(empty.join('Fixture').actors, []);
});

test('a mining truck really extracts and destroying its command stops production before the next economy turn', t => {
  let base;
  const room = new SharedRoom({ starter: false, build: false, fog: false, base: () => base }), f = onField(t, room),
    site = room.deposits.filter(site => site.material === 'ferro' && depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1)
      .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
  base = site.x + 250;
  const alice = room.join('Alice'), id = f.publish(alice, 'mining-truck'), area = workArea(room.world, id, site, LOAD_REACH);
  assert(area, 'the installed starter tool has a parking interval');
  // Reach the work normally. The teleport helper drops a vehicle a metre, whose real impact damage now
  // correctly pauses extraction; this case is about production and losing command, not an airdrop.
  f.order(alice, 'haul', { ids: [id], depositId: site.id });
  assert(f.until(() => room.records.get(id).extraction?.[0].siteId === site.id, 45), 'the ordinary collection order reaches the site');
  assert.equal(room.records.get(id).extraction?.[0].siteId, site.id, 'actual reach and stationary native contact allow extraction');
  const before = room.left(site), pile = room.extracted.get(site.id), lookedAt = room.hauledAt, command = f.parts(id, 'command')[0];
  assert(before < site.reserve, 'the truck dug the vein below its reserve');
  f.set(command, { health: 0 }); f.run(.2);
  // The vein gains back what it does over the looks since, one look at a time, and nothing more is dug out of it into the pile.
  assert(room.hauledAt > lookedAt);
  assert(Math.abs(room.left(site) - recovered(site, before, room.hauledAt - lookedAt)) < 1e-9, 'what came back is all that changed');
  assert.equal(room.extracted.get(site.id), pile);
  assert(room.records.get(id).wreck);
  assert.equal(room.world.actor(id).field.extraction, undefined);
});

test('a kept field preserves public extracted stocks, including a pile whose reserve is already depleted', t => {
  const room = new SharedRoom({ starter: false }); t.after(() => room.field.dispose());
  const alice = room.join('Alice'), site = room.prospected(room.faction(room.players.get(alice.playerId)))[0];
  room.veins.set(site.id, 0); room.extracted.set(site.id, 321.5);
  const kept = JSON.parse(JSON.stringify(room.keep())), resumed = new SharedRoom({ kept });
  t.after(() => resumed.field.dispose());
  assert.deepEqual([...resumed.extracted], [[site.id, 321.5]]);
  assert.deepEqual([...resumed.veins], [[site.id, 0]], 'only the emptied vein is named, and every other holds its whole reserve');
  assert.equal(resumed.left(site), 0);
  const before = resumed.digest(); resumed.extracted.set(site.id, 322.5);
  assert.notEqual(resumed.digest(), before, 'the replay print includes the pile');
  const back = resumed.join('Alice', alice.token);
  assert.deepEqual(back.actors, [], 'resuming an existing player does not create a starter');
  assert.deepEqual(back.faction.stock, alice.faction.stock);
});

test('a current diary replays an existing seat returning and a new seat receiving its starter', async t => {
  const original = new SharedRoom({ starter: false }); t.after(() => original.field.dispose());
  const alice = original.join('Alice'), kept = JSON.parse(JSON.stringify(original.keep()));
  const host = new FieldHost(openRoom(null, kept)); t.after(() => host.room.field.dispose());
  assert.equal(host.room.extracted.size, 0);
  assert.deepEqual(host.join('Alice', alice.token).actors, []);
  assert.equal(host.join('Bob').actors.length, 3);
  const origin = { ...kept, players: kept.players.map(seat => ({ ...seat, token: keyOf(seat.id) })) },
    again = await replayField([JSON.stringify({ diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT, field: null, origin }), ...host.lines]);
  t.after(() => again.host.room.field.dispose());
  assert.equal(again.how, 'end', again.got);
  assert.equal(again.host.room.digest(), host.room.digest());
  assert.equal(again.host.room.owned(alice.playerId).length, 0);
  assert.equal(again.host.room.owned('j2').length, 3);
});

test('resume requires the current extracted-stock map', t => {
  const room = new SharedRoom({ starter: false }); t.after(() => room.field.dispose());
  const kept = JSON.parse(JSON.stringify(room.keep())); delete kept.extracted;
  assert.throws(() => room.resume(kept), /Campo salvo sem mapa de materiais extraídos/);
});

test('F2 airdrop: active refined Fe converts its exact remaining balance while legacy raw and malformed balances stay explicit', () => {
  const saved = { nextId: 2, nextAt: 43200, drop: { id: 'airdrop:1', x: -700,
    stock: 44343.8976, refined: true, known: ['f1'], arrivesAt: 100, expiresAt: 900,
    guardianId: 'c3' }, orders: [] }, before = structuredClone(saved),
    expected = structuredClone(saved);
  expected.drop.supplies = bill(saved.drop.stock);
  delete expected.drop.stock; delete expected.drop.refined;
  const converted = resumeActivities(saved);
  assert.deepEqual(converted, expected, 'only the existing remaining Fe changes representation, without upgrading its reward or calendar');
  assert.deepEqual(saved, before, 'the original active-event data is not rewritten');
  const raw = { ...saved, drop: { id: 'airdrop:1', x: -700, stock: 4000, arrivesAt: 100, expiresAt: 900 } };
  assert.deepEqual(resumeActivities(raw), raw, 'an active raw legacy drop retains stock, old audience and refinery semantics');
  const current = { ...saved, drop: { id: 'airdrop:1', x: -700, supplies: bill(48000, 16000, 12000, 4000),
    known: ['f1'], arrivesAt: 100, expiresAt: 900 } };
  assert.deepEqual(resumeActivities(current), current);
  assert.deepEqual(resumeActivities({ ...current, drop: { ...current.drop, supplies: bill(0, 27.5, 0, 3.125) } }).drop.supplies,
    bill(0, 27.5, 0, 3.125), 'a partial real balance need not retain its original proportions');
  for (const supplies of [bill(-1), bill(0, 0, 0, NaN), bill(80001),
    { ...current.drop.supplies, mineral: 1 }, { ferro: 1, ligas: 0, silica: 0 }])
    assert.throws(() => resumeActivities({ ...current, drop: { ...current.drop, supplies } }), /airdrop inválido/);
  assert.throws(() => resumeActivities({ ...current, drop: { ...current.drop, stock: 80000 } }), /airdrop inválido/);
  assert.throws(() => resumeActivities({ ...current, drop: { ...current.drop, refined: true } }), /airdrop inválido/);
  assert.throws(() => resumeActivities({ ...current, drop: { ...current.drop, known: undefined } }), /airdrop inválido/);
});

test('F2 airdrop: legacy raw haul authorization and two physical collectors conserve the one finite public pile', t => {
  const f = onField(t, rehearsal([-300, 300, 9000], undefined, { fog: false })), { room, world } = f,
    alice = room.join('Alice'), bob = room.join('Bob'), third = room.join('Third'),
    ids = [f.publish(alice, 'truck'), f.publish(bob, 'truck')],
    bins = id => f.parts(id, 'hopper'), cargo = id => carriedBy(bins(id)).carried.ferro;
  f.order(alice, 'stop', { ids: [ids[0]] });
  f.order(bob, 'stop', { ids: [ids[1]] });
  for (const [i, id] of ids.entries()) f.put(id, i ? 5 : -5);
  f.run(11); // Any impact from the ordinary positioning helper has left the combat safety window.
  const rawStock = 4000, drop = { id: 'airdrop:1', x: 0, stock: rawStock, arrivesAt: world.time + 20, expiresAt: world.time + 200 };
  room.activities = { nextId: 2, nextAt: world.time + AIRDROP.interval, drop };
  assert.throws(() => f.order(alice, 'haul', { ids: [ids[0]], depositId: drop.id }), /Jazida desconhecida/);
  assert.equal(room.sites.has(drop.id), false); assert.equal(room.veins.has(drop.id), false); assert.equal(room.extracted.has(drop.id), false);
  // A real pre-update announcement may have no sentinel yet. Cold admission preserves it without retroactive birth.
  const announced = JSON.parse(JSON.stringify(room.keep()));
  announced.activities.drop = { ...announced.activities.drop, supplies: { ...AIRDROP.supplies }, known: [alice.faction.id, bob.faction.id, third.faction.id] };
  delete announced.activities.drop.stock;
  const old = onField(t, rehearsal([-300, 300, 9000], undefined, { fog: false, kept: announced })),
    oldEvent = structuredClone(old.room.activities), oldActors = old.world.actors.map(actor => actor.id);
  stepActivities(old.room);
  assert.deepEqual(old.room.activities, oldEvent); assert.deepEqual(old.world.actors.map(actor => actor.id), oldActors);
  old.room.activities.drop.arrivesAt = old.world.time; stepActivities(old.room);
  assert.equal(old.room.activities.drop.guardianId, undefined, 'arrival cannot retroactively create an enemy on players already beside the old point');
  assert.deepEqual(old.world.actors.map(actor => actor.id), oldActors); assert.deepEqual(old.room.activities.drop.supplies, AIRDROP.supplies);
  assert.equal(old.room.activities.drop.x, oldEvent.drop.x); assert.equal(old.room.activities.drop.expiresAt, oldEvent.drop.expiresAt);
  // Isolate the existing economic turn with a ready-pile fixture, as logistics.test.js does; actual arrival/guardian runs below.
  drop.arrivesAt = world.time;
  assert(ids.every(id => workArea(world, id, { ...drop, type: 'airdrop', feature: 'airdrop', material: 'ferro' }, LOAD_REACH)?.ready), 'both native containers stand over the public pickup band');
  const bin = bins(ids[1])[0], initial = cargoSpace(bin, 'ferro') - 37.125;
  assert(initial > 0); f.set(bin, { cargo: { ferro: initial } });
  for (const [i, player] of [alice, bob].entries()) {
    f.order(player, 'haul', { ids: [ids[i]], depositId: drop.id });
    assert.equal(room.players.get(player.playerId).squad.units.get(ids[i]).haul.depositId, drop.id);
  }
  const beforeForeign = ids.map(cargo);
  assert.throws(() => f.order(third, 'haul', { ids: [ids[0]], depositId: drop.id }), /^Error: Selecione veículos com recipiente compatível para transportar o airdrop\.$/);
  assert.deepEqual(ids.map(cargo), beforeForeign); assert.equal(drop.stock, rawStock); assert.equal(room.players.get(third.playerId).squad.units.size, 0);
  const builder = f.publish(alice, 'construction-truck');
  assert.throws(() => f.order(alice, 'haul', { ids: [builder], depositId: drop.id }), /veículos com recipiente compatível/);
  const fixed = world.addActor(createStructuredTemplate('oil-well'), { id: 'fixed-pickup', ownerId: alice.playerId, team: alice.faction.id, x: 0 });
  assert.throws(() => f.order(alice, 'haul', { ids: [fixed.id], depositId: drop.id }), /veículos com recipiente compatível/);
  let turns = 0;
  while (drop.stock > 0 && turns++ < 20) {
    const before = ids.map(cargo), ready = drop.stock,
      expected = sharePile(ready, ids.map(id => Math.min(TRANSFER_RATE, bins(id).reduce((sum, piece) => sum + cargoSpace(piece, 'ferro'), 0))));
    room.haul(1);
    for (const [i, id] of ids.entries()) assert(Math.abs(cargo(id) - before[i] - expected[i]) < 1e-6, 'the canonical per-vehicle rate and small request release govern each turn');
    assert(Math.abs(drop.stock + ids.reduce((sum, id) => sum + cargo(id), 0) - rawStock - initial) < 1e-6, 'one debit conserves all physical cargo');
    assert.equal(room.extracted.has(drop.id), false); assert.equal(room.veins.has(drop.id), false);
  }
  assert.equal(drop.stock, 0); assert(turns < 20);
  const loaded = ids.map(cargo); room.haul(1); assert.deepEqual(ids.map(cargo), loaded, 'repeating a turn on the empty pile grants nothing');
  drop.stock = .000004; const before = cargo(ids[0]); room.haul(.1);
  assert(cargo(ids[0]) > before, 'a legitimate final fraction above the canonical epsilon is still collected');
  assert(Math.abs(cargo(ids[0]) - before - .000004) < 1e-6); assert.equal(drop.stock, 0);
  const stock = [alice, bob].map(player => ({ ...room.faction(room.players.get(player.playerId)).stock }));
  const expenses = [0, 0], charge = room.charge.bind(room);
  room.charge = (point, cost) => {
    const i = [alice, bob].findIndex(player => room.faction(room.players.get(player.playerId)).stock === point.stock);
    if (i >= 0) expenses[i] += cost.ferro;
    return charge(point, cost);
  };
  for (const [i, player] of [alice, bob].entries()) f.order(player, 'stop', { ids: [ids[i]] });
  for (const [i, player] of [alice, bob].entries()) {
    f.put(ids[i], player.base.x); f.run(1);
    const faction = room.faction(room.players.get(player.playerId)), received = faction.stock.ferro - stock[i].ferro + faction.yard.ferro + expenses[i],
      expected = loaded[i] + (i ? 0 : .000004);
    t.diagnostic(JSON.stringify({ delivery: { id: ids[i], cargo: cargo(ids[i]), stockDelta: faction.stock.ferro - stock[i].ferro, yard: faction.yard.ferro,
      knownIronExpenses: expenses[i], received, expected, service: room.records.get(ids[i]).service?.kind, speed: world.actor(ids[i]).vehicle.vx } }));
    assert.equal(cargo(ids[i]), 0, 'the physical cargo has actually unloaded');
    assert(Math.abs(received - expected) < 1e-6, 'stock plus yard, including actual canonical service charges, conserves the delivered cargo');
    assert(faction.stock.ferro - stock[i].ferro + expenses[i] > 0, 'some of the delivered ore was actually refined into iron');
  }
  assert.deepEqual([...room.faults], []);
});

test('F2 airdrop: mixed supplies share the physical room and one transfer rate, then survive interrupts, depletion and cold delivery once', t => {
  const f = onField(t, rehearsal([-300, 300, 50000], undefined, { fog: false })), { room, world } = f,
    alice = room.join('Alice'), bob = room.join('Bob'), hidden = room.join('Distant'),
    id = f.publish(alice, 'supply'), other = f.publish(bob, 'supply'), ids = [id, other],
    held = (actorId = id) => carriedBy(room.crates(actorId)).carried,
    volumeOf = amounts => STOCK_IDS.reduce((sum, material) => sum + amounts[material] * cargoUnitVolume(SUPPLIED[material]), 0);
  f.order(alice, 'stop', { ids: [id] });
  f.order(bob, 'stop', { ids: [other] });
  f.put(id, -5); f.put(other, 5); f.run(11);
  for (const actorId of [id, other]) for (const crate of room.crates(actorId)) f.set(crate, { cargo: {} });
  // Supplies are fungible: a delivery also returns the ordinary supplies already mixed with its pickup.
  f.set(room.crates(id)[0], { cargo: { ferro: 12.5, ligas: 1.25, silica: 3, petroleo: 8 } });
  // A partially collected current event keeps the approved mixture. Use real compiled capacities, not an oversized test reservoir.
  assert.equal(TRANSFER_RATE, 250);
  const reward = bill(1200, 400, 300, 100), total = billTotal(reward), mixtureVolume = volumeOf(reward),
    spare = 37.125, freeVolume = spare * mixtureVolume / total;
  assert(room.crates(id).reduce((sum, piece) => sum + cargoRoom(piece) - cargoVolume(piece), 0) > mixtureVolume,
    'the current supplier really has room for this finite remaining event');
  for (const piece of room.crates(other)) f.set(piece, { cargo: { ferro: cargoRoom(piece) / cargoUnitVolume('ferro') } });
  const last = room.crates(other)[0];
  assert(cargoRoom(last) > freeVolume);
  f.set(last, { cargo: { ferro: (cargoRoom(last) - freeVolume) / cargoUnitVolume('ferro') } });
  const initial = held(), originalCargo = ids.map(actorId => supplied(held(actorId))),
    drop = { id: 'airdrop:1', x: 0, supplies: { ...reward },
    known: [alice.faction.id, bob.faction.id], arrivesAt: world.time, expiresAt: world.time + 2 };
  room.activities = { nextId: 2, nextAt: world.time + AIRDROP.interval, drop };
  const site = { ...drop, type: 'airdrop', feature: 'airdrop', refined: true };
  assert(ids.every(actorId => workArea(world, actorId, site, LOAD_REACH, { dig: false })?.ready));
  assert.equal(activityView(room, room.faction(room.players.get(hidden.playerId))), null, 'a far faction gets no global event notice');
  assert.throws(() => f.order(hidden, 'haul', { ids: [id], depositId: drop.id }), /Jazida desconhecida/);
  const view = activityView(room, room.faction(room.players.get(alice.playerId)));
  assert.deepEqual(view.supplies, reward); assert.equal(view.refined, true);
  for (const key of ['stock', 'material', 'reserve', 'left', 'known']) assert(!Object.hasOwn(view, key), 'new announcements contain supplies, not a geological reserve or private audience');
  view.supplies.ferro = 0;
  assert.equal(drop.supplies.ferro, reward.ferro, 'published balances cannot alias the authoritative remaining cargo');
  const raw = f.publish(alice, 'truck'), fixed = world.addActor(createStructuredTemplate('oil-well'),
    { id: 'fixed-refined-pickup', ownerId: alice.playerId, team: alice.faction.id, x: 0 });
  assert.throws(() => f.order(alice, 'haul', { ids: [raw], depositId: drop.id }), /veículos com recipiente compatível/);
  assert.throws(() => f.order(alice, 'haul', { ids: [fixed.id], depositId: drop.id }), /veículos com recipiente compatível/);
  assert.throws(() => f.order(bob, 'haul', { ids: [id], depositId: drop.id }), /veículos com recipiente compatível/);
  f.order(alice, 'haul', { ids: [id], depositId: drop.id });
  f.order(bob, 'haul', { ids: [other], depositId: drop.id });
  assert.equal(room.players.get(alice.playerId).squad.units.get(id).haul.refined, true);
  assert(!Object.hasOwn(room.players.get(alice.playerId).squad.units.get(id).haul, 'material'));
  const oreBefore = room.records.get(id).gatheredOre, objectivesBefore = structuredClone(room.players.get(alice.playerId).objectives);
  let turns = 0;
  while (billTotal(drop.supplies) > 1e-6 && turns++ < 20) {
    const ready = { ...drop.supplies }, readyUnits = billTotal(ready), beforeCargo = ids.map(actorId => supplied(held(actorId))),
      requests = ids.map(actorId => Math.min(TRANSFER_RATE, readyUnits / volumeOf(ready) *
        room.crates(actorId).reduce((sum, piece) => sum + Math.max(0, cargoRoom(piece) - cargoVolume(piece)), 0))),
      expected = sharePile(readyUnits, requests);
    if (turns === 1) {
      assert(Math.abs(expected[0] - TRANSFER_RATE) < 1e-6);
      assert(Math.abs(expected[1] - spare) < 1e-6, 'the almost-full physical supplier releases the rest of its per-vehicle request');
    }
    room.haul(1);
    for (const [index, actorId] of ids.entries()) {
      const after = supplied(held(actorId));
      let received = 0;
      for (const material of STOCK_IDS) {
        const picked = after[material] - beforeCargo[index][material]; received += picked;
        assert(Math.abs(picked - expected[index] * ready[material] / readyUnits) < 1e-6, `${material} retains the available mixture at the one total rate`);
      }
      assert(Math.abs(received - expected[index]) < 1e-6); assert(received <= TRANSFER_RATE + 1e-6);
      for (const piece of room.crates(actorId)) assert(cargoVolume(piece) <= cargoRoom(piece) + 1e-9);
    }
    for (const material of STOCK_IDS) assert(Math.abs(drop.supplies[material] +
      ids.reduce((sum, actorId) => sum + supplied(held(actorId))[material], 0) - reward[material] -
      originalCargo.reduce((sum, cargo) => sum + cargo[material], 0)) < 1e-6, `${material} is conserved across the two factions and pile`);
  }
  assert(turns > 1 && turns < 20); assert(billTotal(drop.supplies) <= 1e-6, 'normal physical transfers exhaust the finite remaining mix');
  const loaded = held();
  for (const material of STOCK_IDS) assert(supplied(loaded)[material] > supplied(initial)[material], 'all four resource stocks really entered physical cargo, including fuel 1:1');
  const exhausted = ids.map(actorId => held(actorId)); room.haul(1);
  assert.deepEqual(ids.map(actorId => held(actorId)), exhausted, 'the empty event cannot yield a repeated transfer');
  assert.equal(room.extracted.has(drop.id), false); assert.equal(room.veins.has(drop.id), false);
  assert.equal(room.records.get(id).supplyDelivery, true);
  assert.equal(room.records.get(other).supplyDelivery, true);
  assert.equal(room.records.get(id).gatheredOre, oreBefore, 'refined pickup does not become raw ore');
  assert.deepEqual(room.players.get(alice.playerId).objectives, objectivesBefore, 'refined pickup does not complete raw mining objectives');
  const returning = room.players.get(bob.playerId).squad, returningUnit = returning.units.get(other);
  assert.equal(returning.haul(other, returningUnit), '');
  assert.equal(returningUnit.haul.phase, 'home', 'the ordinary pilot returns the remaining physical load after depletion');
  assert.equal(returningUnit.halt, 'supplies-spent');
  assert(returningUnit.move, 'the pilot plans its normal return leg rather than teleporting or fabricating a replacement event');
  f.send(alice, 'select', { actorId: id });
  assert.equal(room.players.get(alice.playerId).squad.manual, id);
  assert.equal(room.players.get(alice.playerId).squad.units.get(id).haul, null);
  assert.equal(room.records.get(id).supplyDelivery, true, 'manual control does not cancel a physical delivery');
  f.send(alice, 'release');
  f.order(alice, 'move', { ids: [id], x: alice.base.x });
  assert.equal(room.players.get(alice.playerId).squad.units.get(id).haul, null);
  assert.equal(room.records.get(id).supplyDelivery, true);
  stepActivities(room);
  assert.equal(room.activities.drop, null, 'the event is gone before saving the returning cargo');
  const kept = JSON.parse(JSON.stringify(room.keep()));
  assert.equal(kept.records.find(([actorId]) => actorId === id)[1].supplyDelivery, true);
  const back = onField(t, rehearsal([-300, 300], undefined, { fog: false, kept })),
    restored = back.room, seat = restored.join('Alice', alice.token), actor = back.world.actor(id),
    faction = restored.faction(restored.players.get(seat.playerId)), before = { ...faction.stock },
    aboard = () => carriedBy(restored.crates(id)).carried, expected = supplied(loaded),
    yard = { ...faction.yard };
  assert.deepEqual(aboard(), loaded); assert.equal(restored.activities.drop, null);
  assert.equal(restored.records.get(id).supplyDelivery, true);
  back.order(seat, 'stop', { ids: [id] });
  assert.equal(restored.records.get(id).supplyDelivery, true, 'Stop also preserves pending delivery');
  // As in the public-pile case above, isolate the economy turn from travel and workshop expenses.
  const vehicle = actor.vehicle;
  back.world.command('setVehicleState', { actorId: id, state: { x: faction.base.x,
    y: vehicle.y - back.ground.height(vehicle.x) + back.ground.height(faction.base.x), vx: 0, vy: 0 } });
  let deliveries = 0;
  const unload = restored.unload.bind(restored);
  restored.unload = (pieces, target) => {
    const moved = unload(pieces, target);
    if (pieces.some(piece => piece.actorId === id && piece.kind === 'supply') && moved.ferro > 0) deliveries++;
    return moved;
  };
  restored.haul(1);
  assert.deepEqual(aboard(), load(), 'the actual remaining supply cargo is emptied');
  for (const [material, units] of Object.entries(expected)) assert.equal(faction.stock[material], before[material] + units);
  assert.deepEqual(faction.yard, yard, 'refined supply does not enter the raw refinery queue');
  assert.equal(restored.records.get(id).supplyDelivery, undefined);
  assert(!JSON.parse(JSON.stringify(restored.keep())).records.find(([actorId]) => actorId === id)[1].supplyDelivery);
  restored.haul(1); restored.haul(1);
  assert(aboard().ferro > 0, 'ordinary provisioning resumes after the one delivery');
  const reloaded = supplied(aboard());
  for (const [material, units] of Object.entries(expected))
    assert(Math.abs(faction.stock[material] + reloaded[material] - before[material] - units) < 1e-6);
  assert.equal(deliveries, 1, 'normal provision must not feed a repeated unload/credit loop');
  assert.deepEqual([...room.faults, ...restored.faults], []);
});

test('F2 airdrop: sentinel born at announcement retains identity through arrival, depletion, deadline and cold warning', t => {
  const f = onField(t, rehearsal([-1000])), { room, world } = f;
  const alice = room.join('Alice');
  room.activities = { nextId: 1, nextAt: world.time, drop: null };
  const counts = [room.players.size, room.factions.size];
  assert.equal(world.actors.length, 0);
  stepActivities(room);
  const announcedId = room.activities.drop.guardianId;
  assert(announcedId); assert.equal(world.actors.length, 1);
  assert.equal(world.actor(announcedId).playerName, 'Sentinela do airdrop');
  Object.assign(room.activities.drop, { known: [alice.faction.id], arrivesAt: world.time + .2, expiresAt: world.time + 2 });
  assert.equal(activityView(room, room.faction(room.players.get(alice.playerId))).phase, 'announcement');
  const early = JSON.parse(JSON.stringify(room.keep())), defeated = onField(t, rehearsal([-1000], undefined, { kept: early }));
  defeated.set(defeated.parts(announcedId, 'command')[0], { health: 0 });
  assert(defeated.until(() => defeated.world.time >= defeated.room.activities.drop.arrivesAt && defeated.room.records.get(announcedId).wreck, 1));
  assert.equal(defeated.room.activities.drop.guardianId, announcedId); assert.equal(defeated.room.serials.c, early.serials.c);
  assert.deepEqual(defeated.room.activities.drop.supplies, AIRDROP.supplies, 'defeating the sentinel during the wait does not change the later cargo');
  assert.equal(defeated.world.actors.filter(actor => actor.team === 'guardian:airdrop:1').length, 1, 'the wreck is not replaced at arrival');
  assert(f.until(() => world.time >= room.activities.drop.arrivesAt, 1));
  assert.equal(room.activities.drop.guardianId, announcedId); assert.equal(world.actors.length, 1, 'arrival never grants a second sentinel');
  const id = room.activities.drop.guardianId, before = JSON.parse(JSON.stringify(room.keep()));
  assert.deepEqual([world.actor(id).ownerId, world.actor(id).team, room.players.size, room.factions.size], [null, 'guardian:airdrop:1', ...counts]);
  assert.equal(world.actors.length, 1);
  const stockBranch = onField(t, rehearsal([-1000], undefined, { kept: before }));
  Object.assign(stockBranch.room.activities.drop.supplies, bill());
  assert(stockBranch.until(() => stockBranch.room.activities.drop.retireAt !== undefined, 1));
  const retireAt = stockBranch.room.activities.drop.retireAt;
  assert(Math.abs(retireAt - (stockBranch.world.time - 1 / 60 + AIRDROP.warning)) < 1e-6, 'the one warning deadline is based on the actual survey clock');
  stockBranch.run(.5); assert.equal(stockBranch.room.activities.drop.retireAt, retireAt, 'another survey never renews the warning');
  const warning = JSON.parse(JSON.stringify(stockBranch.room.keep())), value = structuredClone(stockBranch.room.activities),
    restored = onField(t, rehearsal([-1000], undefined, { kept: warning })), stocks = [...restored.room.factions.values()].map(faction => ({ ...faction.stock }));
  assert.deepEqual(restored.room.activities, value); assert.equal(restored.room.activities.drop.retireAt, retireAt);
  assert(restored.until(() => restored.room.activities.drop === null, AIRDROP.warning + 1));
  assert(!restored.world.actor(id)); assert.equal(restored.room.guardianSquad, null);
  assert.deepEqual([...restored.room.factions.values()].map(faction => faction.stock), stocks, 'withdrawal gives no resources or extra wreck');
  restored.run(.5); assert.equal(restored.world.actors.length, 0); assert.equal(restored.room.activities.nextId, 2);
  const dying = onField(t, rehearsal([-1000], undefined, { kept: warning }));
  assert(dying.until(() => dying.world.time >= retireAt - .05, AIRDROP.warning));
  dying.set(dying.parts(id, 'command')[0], { health: 0 });
  assert(dying.until(() => dying.room.activities.drop === null, 1));
  assert(dying.world.actor(id), 'death at the withdrawal boundary leaves the physical wreck');
  assert(dying.room.records.get(id).wreck, 'it follows the normal death path');
  assert.equal(dying.room.guardianSquad, null); assert.equal(dying.room.serials.c, before.serials.c);
  assert(dying.room.records.get(id).wreck.until > dying.world.time + WRECK_SECONDS - 1);
  assert(f.until(() => room.activities.drop.retireAt !== undefined, 3), 'the original branch expires without collecting');
  assert.deepEqual(room.activities.drop.supplies, bill()); assert.equal(room.activities.drop.guardianId, id);
  const closed = room.factionView([...room.players.keys()][0]).activity;
  assert.equal(closed.phase, 'withdrawal'); assert.equal(closed.active, false);
  assert.deepEqual([...room.faults, ...restored.room.faults, ...dying.room.faults], []);
});

test('F2 airdrop: map-wide draws ignore base anchors, veto occupied current ground and advance failed slots', t => {
  assert.deepEqual(AIRDROP.supplies, bill(48000, 16000, 12000, 4000));
  assert.equal(AIRDROP.clearance, 8000);
  assert.equal(AIRDROP.first, 12 * 3600); assert.equal(AIRDROP.interval, 12 * 3600); assert.equal(AIRDROP.noticeReach, 30000);
  const a = onField(t, rehearsal([-50000, 60000], undefined, { fog: false })),
    b = onField(t, rehearsal([50000, -60000], undefined, { fog: false }));
  for (const f of [a, b]) { const alice = f.room.join('Alice'); f.room.join('Bob'); if (f === b) f.publish(alice, 'scout'); }
  b.room.random(); b.room.random(); b.room.random();
  const before = [a.room.chance.state, b.room.chance.state];
  assert.notEqual(before[0], before[1]); assert.notEqual(a.world.actors.length, b.world.actors.length);
  for (const f of [a, b]) {
    f.room.activities = { nextId: 1, nextAt: f.world.time, drop: null };
    f.room.random = () => assert.fail('public placement must not consume the shared field draw');
    stepActivities(f.room);
    const drop = f.room.activities.drop, { x, supplies, known, arrivesAt, expiresAt } = drop, { minX, maxX } = f.room.limits;
    assert(x >= minX + 150 && x <= maxX - 150);
    assert.deepEqual(supplies, bill(48000, 16000, 12000, 4000)); assert.equal(billTotal(supplies), 80000); assert(Array.isArray(known));
    for (const key of ['stock', 'material', 'refined']) assert(!Object.hasOwn(drop, key), 'one canonical persisted supplies balance');
    assert.equal(arrivesAt, f.world.time + 3600); assert.equal(expiresAt, arrivesAt + 8 * 3600);
    assert.equal(f.room.activities.nextId, 2);
    assert.equal(f.room.activities.nextAt, f.world.time + 12 * 3600);
  }
  const publicPolicy = f => { const { known, guardianId, ...drop } = f.room.activities.drop; return { ...f.room.activities, drop }; };
  assert.deepEqual(publicPolicy(a), publicPolicy(b), 'the same public map, seed and id give the same site despite different private positions, fleets and random history; the audience is private');
  assert.deepEqual([a.room.chance.state, b.room.chance.state], before);
  t.diagnostic(JSON.stringify({ neutralSite: { id: a.room.activities.drop.id, x: a.room.activities.drop.x },
    map: { seed: a.world.terrain.seed, center: a.world.terrain.center, length: a.world.terrain.length }, sharedDrawUnchanged: true }));
  // Reuse the one real scout: a live vehicle at the first candidate vetoes it even in a no-fog debug field.
  const first = a.room.activities.drop.x, scout = b.world.actors.find(actor => actor.ownerId);
  removeGuardian(b.room); b.put(scout.id, first);
  assert(!b.room.outOfAction()[scout.id]); assert(b.world.actor(scout.id).eyes.length > 0); assert.equal(b.room.fog, null);
  const occupied = b.world.actorBounds(scout.id);
  b.room.activities = { nextId: 1, nextAt: b.world.time, drop: null }; stepActivities(b.room);
  assert(b.room.activities.drop); assert.notEqual(b.room.activities.drop.x, first);
  const away = b.room.activities.drop.x;
  assert(Math.max(occupied.minX - away, away - occupied.maxX, 0) >= AIRDROP.clearance + GUARDIAN.leash,
    'the whole sentinel travel band stays at least8km from the live native body bounds');
  // The same position occupied only by its actual wreck no longer steers the draw.
  removeGuardian(b.room); b.set(b.parts(scout.id, 'command')[0], { health: 0 }); b.run(.2);
  assert(b.room.records.get(scout.id).wreck);
  b.room.activities = { nextId: 1, nextAt: b.world.time, drop: null }; stepActivities(b.room);
  assert.equal(b.room.activities.drop.x, first, 'wrecks and their remembered sight do not veto a new point');
  // Reuse this already drawn event and the two existing seats to exercise only its audience boundary.
  // Moving fixture bases afterward cannot influence the preceding map-wide draw or consume a shared random value.
  const [near, far] = [...a.room.factions.values()], drop = a.room.activities.drop, towardCenter = drop.x < 0 ? 1 : -1;
  near.base.x = drop.x + towardCenter * AIRDROP.noticeReach;
  far.base.x = drop.x + towardCenter * (AIRDROP.noticeReach + .01);
  drop.known.length = 0; stepActivities(a.room);
  assert.deepEqual(drop.known, [near.id], '30km is inclusive and an outside faction gets no announcement');
  const notice = activityView(a.room, near);
  assert.equal(notice.phase, 'announcement'); assert.equal(notice.active, false); assert.equal(notice.refined, true);
  assert.deepEqual(notice.supplies, AIRDROP.supplies);
  for (const key of ['material', 'stock', 'reserve', 'left', 'known']) assert(!Object.hasOwn(notice, key));
  assert.equal(activityView(a.room, far), null);
  near.base.x += towardCenter * 100;
  stepActivities(a.room); assert.deepEqual(drop.known, [near.id], 'a discovered event remains known after leaving the notice range');
  let heights = 0;
  const failed = { field: { time: a.world.time, terrain: { seed: a.world.terrain.seed, center: a.world.terrain.center,
    height: x => { heights++; return 1000 * x; } } }, limits: a.room.limits, deposits: [], factions: a.room.factions,
    world: a.world, players: a.room.players, records: a.room.records, outOfAction: () => a.room.outOfAction(),
    activities: { nextId: 2, nextAt: a.world.time, drop: null } };
  stepActivities(failed);
  assert.equal(heights, 32, 'sixteen candidates each fail their first static ground offset');
  assert.equal(failed.activities.drop, null); assert.equal(failed.activities.nextId, 3);
  assert.equal(failed.activities.nextAt, failed.field.time + AIRDROP.interval);
  stepActivities(failed); assert.equal(heights, 32); assert.equal(failed.activities.nextId, 3, 'failure keeps the normal interval, without immediate retry');
  failed.field.time = failed.activities.nextAt; stepActivities(failed);
  assert.equal(heights, 64); assert.equal(failed.activities.nextId, 4, 'the next due slot uses the next public id, even after failure');
});
