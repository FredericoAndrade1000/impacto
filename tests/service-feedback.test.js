import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { ammunitionCost } from '../src/construction-cost.ts';
import { reserveState } from '../src/component-volume.ts';
import { appraise, fieldParts, bill, billSum, load, CALM_SECONDS, SUPPLY_REACH } from '../src/economy.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { unitServices } from '../src/faction-ui.ts';

const BASES = [-213, 237];
function field(t) {
  const room = rehearsal(BASES, undefined, { fog: false }), world = room.world, joined = room.join('Ana');
  t.after(() => world.dispose());
  const player = room.players.get(joined.playerId), faction = room.faction(player),
    unit = actor => room.factionView(player.id).units.find(unit => unit.id === actor.id),
    piece = (actor, kind) => world.modules.find(part => part.actorId === actor.id && part.kind === kind),
    set = (actor, kind, state) => world.game().call({ op: 'setPartState', owner: world.game().handle(piece(actor, kind)), state }),
    designed = (actor, kind) => reserveState(actor.blueprint.modules.find(part => part.kind === kind));
  return { room, world, player, faction, unit, piece, set, designed,
    publish: (model = 'scout') => {
      player.builtAt = -Infinity;
      return world.actor(room.publish(player.id, createStructuredTemplate(model)).actor.id);
    },
    // Steps the field for a second and a half: a construction just published has settled on its ground by then.
    settle: () => { for (let i = 0; i < 90; i++) room.step(); },
    // Local point assays settle physical support without dispatching automatic deliveries.
    settlePhysics: () => { for (let i = 0; i < 90; i++) world.step(); },
    spend: (actor, fuelLitres, rounds = 0) => {
      set(actor, 'fuel', { fuelLitres: designed(actor, 'fuel').fuelLitres - fuelLitres });
      if (rounds) set(actor, 'ammo', { rounds: designed(actor, 'ammo').rounds - rounds });
    },
    put: (actor, x) => {
      const vehicle = actor.vehicle;
      world.command('setVehicleState', { actorId: actor.id, state: {
        x, y: vehicle.y - world.terrain.height(vehicle.x) + world.terrain.height(x), vx: 0, vy: 0,
      } });
    },
    // How long a construction is end to end, as it stands (Works.hull): a supply vehicle serves what is within SUPPLY_REACH
    // of its ends.
    long: actor => { const hull = room.works.hull(actor); return hull.maxX - hull.minX; } };
}

// Snapshot at a delivery stop: real parts, quotes and cargo; only the transient
// dispatch assignment is declared. This tests point authority, not trip physics.
function reservedRepair(t) {
  const f = field(t), supplier = f.publish('construction-truck'), anchor = f.publish('recon'), other = f.publish('scout');
  f.settle();
  const place = f.faction.base.x + 300;
  for (const [actor, x] of [[supplier, place], [anchor, place + 10], [other, place - 10]]) f.put(actor, x);
  for (const actor of [anchor, other]) f.set(actor, 'engine', { health: f.piece(actor, 'engine').maxHealth / 2 });
  const anchorCost = appraise(anchor, fieldParts(f.world)).repair, otherCost = appraise(other, fieldParts(f.world)).repair,
    carried = billSum(anchorCost, otherCost);
  assert(anchorCost.ferro > 0 && otherCost.ferro > 0);
  f.set(supplier, 'supply', { cargo: load(carried.ferro, carried.ligas, carried.silica, carried.combustivel) });
  f.room.supplyDispatch.jobs.set(supplier.id, { kind: 'repair', phase: 'deliver', ownerId: f.player.id, factionId: f.faction.id,
    targetId: anchor.id, targetX: f.room.position(anchor), reserved: bill(), reason: '', leg: null });
  return { ...f, supplier, anchor, other, anchorCost, otherCost, carried };
}

test('repair reservation: points and UI offer committed cargo only to its anchor', t => {
  const f = reservedRepair(t), { room, faction, supplier, anchor, other } = f,
    serving = t.mock.method(room, 'serving');
  assert.deepEqual(room.points(faction, other), [], 'a third recipient has no point in the reserved supplier');
  assert.equal(serving.mock.callCount(), 0, 'reservation rejects the supplier before discovering its physical pieces');
  serving.mock.resetCalls();
  assert.deepEqual(room.points(faction, anchor, false).map(point => point.supplier.id), [supplier.id]);
  assert.equal(serving.mock.callCount(), 1, 'the anchor still reads its actual cargo');
  const offered = f.unit(other), assigned = f.unit(anchor);
  assert.equal(offered.point, null); assert.equal(offered.mender, null);
  assert.equal(unitServices(offered, faction, { hand: true }).jobs.some(job => job.id === 'repair'), false,
    'the UI never advertises a repair paid by somebody else\'s reservation');
  assert.equal(assigned.mender.supplier, supplier.id);
  assert(unitServices(assigned, faction, { hand: true }).jobs.some(job => job.id === 'repair' && !job.disabled),
    'manual repair of the assigned anchor remains available');
});

test('repair reservation: a manual third-party repair cannot spend cargo and an explicit opt-out releases it', t => {
  const f = reservedRepair(t), { room, player, supplier, anchor, other, anchorCost, otherCost, carried } = f,
    cargo = () => f.piece(supplier, 'supply').cargo,
    stock = () => bill(cargo().ferro, cargo().ligas, cargo().silica, cargo().petroleo),
    order = actor => room.command(player.id, { type: 'repair', actorId: actor.id });
  assert.deepEqual(stock(), carried);
  assert.throws(() => order(other), /reparar/, 'the server refuses the same repair the UI cannot offer');
  assert.deepEqual(stock(), carried, 'refusal charges no material');
  assert.equal(room.record(other).service, null);
  const own = order(anchor);
  assert.equal(room.record(anchor).service.payer, supplier.id);
  assert.deepEqual(own.cost, anchorCost);
  assert.deepEqual(stock(), billSum(carried, anchorCost, -1), 'the anchor pays once from its own assigned cargo');
  assert.throws(() => order(other), /reparar/, 'the remaining cargo stays reserved until the player releases the job');
  room.command(player.id, { type: 'auto', actorId: supplier.id, on: false });
  assert.equal(room.supplyDispatch.jobs.has(supplier.id), false);
  assert.equal(f.unit(other).mender.supplier, supplier.id, 'opting out makes the physical cargo available again');
  const given = order(other);
  assert.deepEqual(given.cost, otherCost);
  assert.equal(room.record(other).service.payer, supplier.id);
  assert.deepEqual(stock(), bill(), 'the two allowed repairs spent exactly their real material');
});

test('base service confirms actual litres and rounds immediately and charges only once', t => {
  const f = field(t), { room, world, faction, unit, piece, designed } = f, actor = f.publish('ifv');
  f.settle(); assert.equal(unit(actor).still, true, 'the real chassis has settled before it is served');
  f.spend(actor, 12.375, 3);
  const stock = { ...faction.stock }, due = unit(actor).rearm, at = world.time;
  room.serve();
  assert.deepEqual(unit(actor).refilled, { at, until: at + 4, fuelLitres: 12.375, rounds: 3 });
  assert.equal(piece(actor, 'fuel').fuelLitres, designed(actor, 'fuel').fuelLitres);
  assert.equal(piece(actor, 'ammo').rounds, designed(actor, 'ammo').rounds);
  assert(due.ferro > 3 && due.combustivel === 12.375, 'fuel pays actual litres while ammunition retains its currency price');
  assert.deepEqual(faction.stock, billSum(stock, due, -1));
  assert.equal(room.record(actor).service, null, 'an instant refill adds no hold');
  const receipt = { ...unit(actor).refilled }, paid = { ...faction.stock };
  room.serve();
  assert.deepEqual([unit(actor).refilled, faction.stock], [receipt, paid]);
});

test('frequent fractional base refills conserve litres and cost the same as one bulk refill', t => {
  const f = field(t), { room, faction, piece } = f, actor = f.publish(); f.settle();
  faction.stock.combustivel = 100;
  const before = faction.stock.combustivel;
  for (let n = 0; n < 10; n++) { f.spend(actor, .6); room.serve(); }
  const frequent = before - faction.stock.combustivel;
  const bulkBefore = faction.stock.combustivel; f.spend(actor, 6); room.serve();
  const bulk = bulkBefore - faction.stock.combustivel;
  assert(Math.abs(frequent - 6) < 1e-8, `six actual litres cost ${frequent}`);
  assert(Math.abs(bulk - frequent) < 1e-8, 'the frequency of service cannot change its price');
  assert.equal(piece(actor, 'fuel').fuelLitres, f.designed(actor, 'fuel').fuelLitres);
});

test('ammunition service cannot grant fractional fuel for free and partial liquid stock remains usable', t => {
  const f = field(t), { room, faction, piece, designed } = f, actor = f.publish(); f.settle();
  f.spend(actor, .25, 1); faction.stock.combustivel = 0;
  const fuel = piece(actor, 'fuel').fuelLitres, beforeIron = faction.stock.ferro;
  room.serve();
  assert.equal(piece(actor, 'fuel').fuelLitres, fuel, 'a rounded-zero fuel quote cannot mint fuel during ammunition service');
  assert.equal(piece(actor, 'ammo').rounds, designed(actor, 'ammo').rounds);
  assert(faction.stock.ferro < beforeIron);
  faction.stock.combustivel = .125; room.serve();
  assert(Math.abs(piece(actor, 'fuel').fuelLitres - fuel - .125) < 1e-8);
  assert.equal(faction.stock.combustivel, 0, 'a fraction of a litre is transferred once, with no debt or loss');
  room.serve();
  assert(Math.abs(piece(actor, 'fuel').fuelLitres - fuel - .125) < 1e-8);
});

test('a supplier can use the last fraction of a litre in its own cargo away from base', t => {
  const f = field(t), { room, faction, piece, set } = f, actor = f.publish('supply');
  f.settle(); f.put(actor, faction.base.x + 300); f.settlePhysics();
  f.spend(actor, .5); set(actor, 'supply', { cargo: load(0, 0, 0, .125) });
  const before = piece(actor, 'fuel').fuelLitres, stock = { ...faction.stock };
  assert.equal(room.points(faction, actor)[0]?.stock.combustivel, .125, 'its own liquid stock remains an available source');
  room.serve();
  assert(Math.abs(piece(actor, 'fuel').fuelLitres - before - .125) < 1e-8);
  assert.equal(piece(actor, 'supply').cargo.petroleo, 0);
  assert.deepEqual(faction.stock, stock, 'remote service spends cargo only');
  room.serve();
  assert(Math.abs(piece(actor, 'fuel').fuelLitres - before - .125) < 1e-8, 'empty cargo cannot refill it again');
});

test('a supplier parked at an empty base can use its own carried fuel without leaving the depot', t => {
  const f = field(t), { room, faction, piece, set, unit } = f, actor = f.publish('supply');
  f.settle(); f.spend(actor, 1); faction.stock.combustivel = 0;
  set(actor, 'supply', { cargo: load(0, 0, 0, .125) });
  const before = piece(actor, 'fuel').fuelLitres;
  assert(room.atBase(faction, actor) && room.still(actor));
  room.serve();
  assert(Math.abs(piece(actor, 'fuel').fuelLitres - before - .125) < 1e-8, 'the empty depot must not strand usable fuel in its own cargo');
  assert.equal(piece(actor, 'supply').cargo.petroleo, 0);
  assert.equal(faction.stock.combustivel, 0, 'only carried fuel pays the refill');
  assert.equal(unit(actor).refilled.fuelLitres, .125);
  room.serve();
  assert(Math.abs(piece(actor, 'fuel').fuelLitres - before - .125) < 1e-8, 'exhausted cargo creates no further fuel');
});

test('a full ready fleet skips supply-point lookup and a new deficit is served immediately', t => {
  const f = field(t), { room, world, faction, set, designed } = f,
    actors = Array.from({ length: CONSTRUCTION_LIMITS.vehicles }, () => f.publish('ifv'));
  f.settle();
  for (const actor of actors) {
    assert(room.still(actor) && room.calm(actor));
    assert.equal(room.atBase(faction, actor), true);
    set(actor, 'fuel', { fuelLitres: designed(actor, 'fuel').fuelLitres });
    set(actor, 'ammo', { rounds: designed(actor, 'ammo').rounds });
    assert.deepEqual(appraise(actor, fieldParts(world)).repair, bill());
  }
  const points = t.mock.method(room, 'points'), stock = { ...faction.stock };
  room.serve();
  assert.equal(points.mock.callCount(), 0, 'whole, full vehicles need no source discovery');
  assert.deepEqual(faction.stock, stock);

  const actor = actors[7];
  f.spend(actor, 5, 2);
  const due = appraise(actor, fieldParts(world)).rearm;
  room.serve();
  assert.equal(points.mock.callCount(), 1, 'only the vehicle newly short of reserves looks for service');
  assert.deepEqual(appraise(actor, fieldParts(world)).rearm, bill());
  assert.deepEqual(faction.stock, billSum(stock, due, -1));
});

test('supplier discovery skips distant and non-supplier constructions and keeps point order, own fuel and fresh stock', t => {
  const f = field(t), { room, world, faction, set } = f,
    actor = f.publish('supply'), first = f.publish('supply'), second = f.publish('supply'),
    far = f.publish('supply'), plain = f.publish('ifv'), place = faction.base.x + 300;
  f.settle();
  // Four lorries as long as each other, facing the same way: the two either side of it SUPPLY_REACH - 2 off it end to end,
  // the far one SUPPLY_REACH + 1. Its hull is read where it stands, once a look of the field (Works.hull): it is put first.
  f.put(actor, place);
  const long = f.long(actor);
  for (const [unit, x] of [[first, place - long - SUPPLY_REACH + 2], [second, place + long + SUPPLY_REACH - 2],
    [far, place + long + SUPPLY_REACH + 1], [plain, place + 5]]) f.put(unit, x);
  set(actor, 'supply', { cargo: load(100, 5, 6, 7) });
  set(first, 'supply', { cargo: load(11, 0, 0, 5) });
  set(second, 'supply', { cargo: load(22, 0, 0, 9) });
  world.command('setVehicleState', { actorId: first.id, state: { vx: 2, vy: 0 } });
  room.record(second).combatAt = world.time;
  assert(!plain.blueprint.modules.some(part => part.kind === 'supply'), 'the real nearby IFV has no supply piece');
  const serving = t.mock.method(room, 'serving'), nearby = [actor.id, first.id, second.id],
    calls = () => serving.mock.calls.map(call => call.arguments[0]), points = room.points(faction, actor);
  assert.deepEqual(calls(), nearby, 'distance rejects the far supplier and the design rejects the nearby IFV before reading pieces');
  assert.deepEqual(points.map(point => point.supplier.id), [actor.id, first.id, second.id], 'equal-distance suppliers retain arrival order');
  assert.deepEqual(points.map(point => point.stock), [bill(0, 0, 0, 7), bill(11, 0, 0, 5), bill(22, 0, 0, 9)]);
  assert.deepEqual(points.map(point => point.held), ['', 'moving', 'combat']);

  serving.mock.resetCalls();
  const menders = room.points(faction, actor, false);
  assert.deepEqual(calls(), nearby, 'each nearby candidate is read only once for a repair lookup too');
  assert.deepEqual(menders.map(point => point.supplier.id), [first.id, second.id], 'the vehicle cannot arm or mend itself');

  set(first, 'supply', { cargo: load(4, 0, 0, 1) }); serving.mock.resetCalls();
  const next = room.points(faction, actor);
  assert.deepEqual(calls(), nearby);
  assert.deepEqual(next.find(point => point.supplier === first).stock, bill(4, 0, 0, 1), 'the next lookup reads the current cargo');
  assert.deepEqual(points.find(point => point.supplier === first).stock, bill(11, 0, 0, 5), 'the earlier point was a quote of its own instant');

  f.put(actor, faction.base.x); serving.mock.resetCalls();
  assert.deepEqual(room.points(faction, actor), [{ supplier: null, stock: faction.stock, held: '' }]);
  assert.equal(serving.mock.callCount(), 0, 'the base keeps priority without discovering any supplier');
});

test('faction readings keep fresh cargo in inactive holds and omit pieces absent from the field', t => {
  const f = field(t), { room, world, player, piece, set } = f,
    truck = f.publish('truck'), tanker = f.publish('tanker'), supplier = f.publish('supply'), plain = f.publish('ifv'),
    read = () => room.factionView(player.id).units, row = (rows, actor) => rows.find(unit => unit.id === actor.id);
  set(truck, 'hopper', { cargo: { ferro: 100, ligas: 2, silica: 3 } });
  set(tanker, 'cistern', { cargo: { petroleo: 17 } });
  set(supplier, 'supply', { cargo: load(40, 5, 6, 7) });
  const before = read();
  assert.deepEqual(before.map(unit => unit.id), [truck.id, tanker.id, supplier.id, plain.id], 'a reading preserves arrival order');
  assert.deepEqual(row(before, truck).cargo, load(100, 2, 3));
  assert.deepEqual(row(before, tanker).cargo, load(0, 0, 0, 17));
  assert.deepEqual([row(before, supplier).supplies, row(before, supplier).serves], [bill(40, 5, 6, 7), true]);
  assert.deepEqual([row(before, plain).cargo, row(before, plain).supplies, row(before, plain).serves], [load(), null, false]);

  set(truck, 'hopper', { cargo: { ferro: 103, ligas: 4, silica: 5 } });
  set(supplier, 'supply', { cargo: load(41, 6, 7, 8) });
  // Exercise the published projection: damage and detachment do not erase the load left in a hold.
  const hopper = piece(truck, 'hopper'), cistern = piece(tanker, 'cistern'), crate = piece(supplier, 'supply');
  hopper.health = 0; cistern.attached = false; crate.attached = false;
  const inactive = read();
  assert.deepEqual(row(inactive, truck).cargo, load(103, 4, 5));
  assert.deepEqual(row(inactive, tanker).cargo, load(0, 0, 0, 17));
  assert.deepEqual([row(inactive, supplier).supplies, row(inactive, supplier).serves], [bill(41, 6, 7, 8), false]);
  assert.deepEqual(row(before, supplier).supplies, bill(40, 5, 6, 7), 'an earlier reading stays a quote of its own instant');
  crate.attached = true; crate.health = 0;
  assert.equal(row(read(), supplier).serves, false, 'a destroyed attached crate also serves nobody');
  crate.health = crate.maxHealth;
  assert.equal(row(read(), supplier).serves, true, 'the next reading sees a working crate again');

  world.modules = world.modules.filter(part => part !== hopper && part !== cistern && part !== crate);
  const removed = read();
  assert.deepEqual([row(removed, truck).cargo, row(removed, tanker).cargo], [load(), load()]);
  assert.deepEqual([row(removed, supplier).supplies, row(removed, supplier).serves, row(removed, supplier).load], [null, false, null]);
  assert.deepEqual(removed.map(unit => unit.id), before.map(unit => unit.id), 'a missing piece does not remove or reorder its construction');
});

test('one faction reading shares point discovery while keeping own fuel, repair order and fresh supplier stock', t => {
  const f = field(t), { room, world, player, faction, piece, set, unit } = f,
    actor = f.publish('supply'), first = f.publish('supply'), second = f.publish('supply'), place = faction.base.x + 300;
  // Keep the first supplier clearly closer after real suspension settles on the slope.
  f.put(actor, place);
  const long = f.long(actor);
  for (const [vehicle, x] of [[first, place - long - SUPPLY_REACH + 4], [second, place + long + SUPPLY_REACH - 2]]) f.put(vehicle, x);
  f.settlePhysics();
  f.spend(actor, 5);
  set(actor, 'engine', { health: piece(actor, 'engine').maxHealth / 2 });
  const repair = appraise(actor, fieldParts(world)).repair;
  assert(repair.ferro > 0);
  set(actor, 'supply', { cargo: load(100, 0, 0, 7) });
  set(first, 'supply', { cargo: load(repair.ferro, repair.ligas, repair.silica, 9) });
  set(second, 'supply', { cargo: load(repair.ferro, repair.ligas, repair.silica, 11) });
  const points = t.mock.method(room, 'points'), before = unit(actor);
  assert.equal(points.mock.callCount(), 3, 'each construction discovers points once per reading');
  assert.deepEqual([before.point.supplier, before.point.stock, before.point.resupply], [actor.id, bill(0, 0, 0, 7), bill(0, 0, 0, 5)]);
  assert.equal(before.mender.supplier, first.id, 'the own point is excluded and the nearer supplier pays the repair');
  assert.equal(before.mend, null, 'the chosen supplier pays the whole repair');

  set(first, 'supply', { cargo: load() }); points.mock.resetCalls();
  const fresh = unit(actor);
  assert.equal(points.mock.callCount(), 3);
  assert.equal(fresh.mender.supplier, second.id, 'a new reading chooses the supplier that still pays');
  assert.deepEqual(before.mender.stock, bill(repair.ferro, repair.ligas, repair.silica, 9), 'reusing within a reading does not retain stock across readings');

  f.put(actor, faction.base.x); points.mock.resetCalls();
  const base = room.factionView(player.id).units.find(unit => unit.id === actor.id);
  assert.equal(points.mock.callCount(), 3);
  assert.deepEqual([base.point.supplier, base.point.stock, base.mender.supplier, base.mender.stock], [null, null, null, null], 'filtering the own point retains the base for both services');
});

test('a shared supplier updates each recipient and its remaining stock before serving the next vehicle, with one frame per refill', t => {
  const f = field(t), { room, world, faction, set, piece, designed } = f,
    supplier = f.publish('supply'), first = f.publish('ifv'), second = f.publish('ifv'), place = faction.base.x + 300;
  f.settle();
  for (const actor of [supplier, first, second]) {
    f.put(actor, place);
    set(actor, 'fuel', { fuelLitres: designed(actor, 'fuel').fuelLitres });
    if (piece(actor, 'ammo')) set(actor, 'ammo', { rounds: designed(actor, 'ammo').rounds });
  }
  f.spend(first, 5, 3); f.spend(second, 5, 3);
  const due = actor => appraise(actor, fieldParts(world)).rearm,
    firstCost = due(first), secondCost = due(second), stock = { ...faction.stock },
    game = world.game(), refill = room.refill;
  set(supplier, 'supply', { cargo: load(firstCost.ferro + secondCost.ferro, 0, 0, 7) });
  let observedNext = false;
  t.mock.method(room, 'refill', function (actor, quote, point) {
    if (actor === second) {
      observedNext = true;
      assert.deepEqual(due(first), bill(), 'the preceding recipient is full before another quote is applied');
      assert.equal(piece(supplier, 'supply').cargo.petroleo, 2);
      assert.equal(piece(supplier, 'supply').cargo.ferro, secondCost.ferro);
    }
    return refill.call(this, actor, quote, point);
  });
  const frames = t.mock.method(game, 'accept');
  room.serve();
  room.refill = refill;
  assert(observedNext);
  assert.equal(frames.mock.calls.filter(({ arguments: [frame] }) => frame).length, 2, 'two pieces changed per recipient, exported once each');
  assert.deepEqual(due(first), bill()); assert.deepEqual(due(second), bill(0, 0, 0, 3));
  assert.deepEqual(piece(supplier, 'supply').cargo, load());
  assert.deepEqual(faction.stock, stock, 'only the supplier paid for the parked recipients');
  const firstReceipt = { ...room.record(first).refilled }, secondReceipt = { ...room.record(second).refilled };
  assert.deepEqual([firstReceipt.fuelLitres, firstReceipt.rounds, secondReceipt.fuelLitres, secondReceipt.rounds], [5, 3, 2, 3]);
  frames.mock.resetCalls();
  room.serve();
  assert.equal(frames.mock.calls.filter(({ arguments: [frame] }) => frame).length, 0, 'an empty supplier cannot repeat the refill');
  assert.deepEqual([room.record(first).refilled, room.record(second).refilled], [firstReceipt, secondReceipt]);
  assert.deepEqual(faction.stock, stock);
});

test('one valid reserve patch publishes in one batch, including when a final missing piece is ignored', t => {
  const f = field(t), { room, world, piece, designed } = f, actor = f.publish('supply'),
    fuel = actor.blueprint.modules.find(part => part.kind === 'fuel'), game = world.game(),
    commands = t.mock.method(game, 'call'), frames = t.mock.method(game, 'accept');
  for (const [spent, extra] of [[5, {}], [7, { missing: { rounds: 1 } }]]) {
    commands.mock.resetCalls(); frames.mock.resetCalls();
    room.supply(actor, { [fuel.id]: { fuelLitres: designed(actor, 'fuel').fuelLitres - spent }, ...extra });
    assert.equal(commands.mock.callCount(), 1, 'one valid patch needs exactly its own command');
    const [request] = commands.mock.calls[0].arguments;
    assert.equal(request.op, 'setPartStates'); assert.equal(request.frame, undefined);
    assert.deepEqual(request.patches, [{ owner: game.handle(piece(actor, 'fuel')), state: { fuelLitres: designed(actor, 'fuel').fuelLitres - spent } }]);
    assert.equal(frames.mock.calls.filter(({ arguments: [frame] }) => frame).length, 1);
    assert.equal(piece(actor, 'fuel').fuelLitres, designed(actor, 'fuel').fuelLitres - spent);
    assert.deepEqual(appraise(actor, fieldParts(world)).rearm, bill(0, 0, 0, spent));
  }
  commands.mock.resetCalls(); frames.mock.resetCalls();
  room.supply(actor, { missing: { rounds: 1 } });
  assert.equal(commands.mock.callCount(), 0); assert.equal(frames.mock.callCount(), 0);
});

test('a later reserve patch failure still exposes preceding successful writes immediately', t => {
  const f = field(t), { room, world, piece, designed } = f, actor = f.publish('ifv'),
    fuel = actor.blueprint.modules.find(part => part.kind === 'fuel'), ammo = actor.blueprint.modules.find(part => part.kind === 'ammo'),
    game = world.game(), commands = t.mock.method(game, 'call'), frames = t.mock.method(game, 'accept');
  assert.throws(() => room.supply(actor, {
    [fuel.id]: { fuelLitres: designed(actor, 'fuel').fuelLitres - 5 },
    [ammo.id]: { rounds: -1 },
  }), /Invalid part state patch/);
  assert.equal(piece(actor, 'fuel').fuelLitres, designed(actor, 'fuel').fuelLitres - 5);
  assert.equal(piece(actor, 'ammo').rounds, designed(actor, 'ammo').rounds);
  assert.deepEqual(appraise(actor, fieldParts(world)).rearm, bill(0, 0, 0, 5));
  assert.deepEqual(commands.mock.calls.map(({ arguments: [request] }) => request.op), ['setPartStates', 'sync']);
  assert.equal(frames.mock.calls.filter(({ arguments: [frame] }) => frame).length, 1, 'the error returns no frame; the catch publishes its successful prefix once');
  assert.equal(commands.mock.calls.filter(({ arguments: [request] }) => request.op === 'sync').length, 1, 'only the interrupted batch needs an extra sync');
});

test('automatic base service publishes its real combat deadline and refills only after it passes', t => {
  const f = field(t), { room, world, faction, unit } = f, actor = f.publish();
  f.settle(); assert.equal(unit(actor).still, true, 'the real chassis has settled before the wait begins');
  f.spend(actor, 7, 2);
  const record = room.record(actor), stock = { ...faction.stock };
  record.combatAt = world.time - CALM_SECONDS + .1;
  const deadline = record.combatAt + CALM_SECONDS;
  assert.equal(unit(actor).calmUntil, deadline); assert.equal(unit(actor).calm, false);
  room.serve();
  assert.equal(Object.hasOwn(unit(actor), 'refilled'), false); assert.deepEqual(faction.stock, stock);
  for (let i = 0; i < 60 && !unit(actor).refilled; i++) room.step();
  const served = unit(actor);
  assert.equal(served.calm, true); assert.equal(Object.hasOwn(served, 'calmUntil'), false);
  assert(served.refilled.at >= deadline && served.refilled.at <= world.time);
  assert(Math.abs(served.refilled.fuelLitres - 7) < .01); assert.equal(served.refilled.rounds, 2);
  assert.equal(served.refilled.until, served.refilled.at + 4);
  assert.equal(room.record(actor).service, null);
});

test('a partial refill aggregates real transfers from multiple suppliers at the same instant', t => {
  const f = field(t), { room, world, faction, unit, set, piece } = f,
    first = f.publish('supply'), second = f.publish('supply'), actor = f.publish('ifv'), place = faction.base.x + 300,
    ammo = actor.blueprint.modules.find(part => part.kind === 'ammo'), price = ammunitionCost(ammo.ammoPreset, ammo.ammoType);
  f.put(first, place); f.put(second, place + 20); f.put(actor, place + 10);
  f.settlePhysics();
  set(first, 'supply', { cargo: load(0, 0, 0, 3) });
  set(second, 'supply', { cargo: load(2 * price, 0, 0, 4) });
  f.spend(actor, 12.375, 5);
  const stock = { ...faction.stock }, fuel = piece(actor, 'fuel').fuelLitres, rounds = piece(actor, 'ammo').rounds, at = world.time,
    iron = piece(second, 'supply').cargo.ferro;
  room.serve();
  assert.deepEqual(unit(actor).refilled, { at, until: at + 4, fuelLitres: 7, rounds: 2 });
  assert.equal(piece(actor, 'fuel').fuelLitres - fuel, 7); assert.equal(piece(actor, 'ammo').rounds - rounds, 2);
  assert.deepEqual(faction.stock, stock, 'suppliers pay; the faction is not charged too');
  assert.equal(piece(first, 'supply').cargo.petroleo, 0); assert.equal(piece(second, 'supply').cargo.petroleo, 0);
  assert(Math.abs(iron - piece(second, 'supply').cargo.ferro - Math.round(2 * price)) < 1e-6, 'two rounds at their price');
  const receipt = { ...unit(actor).refilled };
  room.serve();
  assert.deepEqual(unit(actor).refilled, receipt, 'a transfer nobody pays for does not renew the receipt');
  assert.equal(room.record(actor).service, null);
});

test('supplier combat deadlines are distinct from the recipient and absent for other holds or infinite deadlines', t => {
  const f = field(t), { room, world, faction, unit, set } = f,
    supplier = f.publish('supply'), actor = f.publish(), place = faction.base.x + 300;
  f.put(supplier, place); f.put(actor, place + 10); f.settlePhysics();
  set(supplier, 'supply', { cargo: load(0, 0, 0, 20) }); f.spend(actor, 6);
  const record = room.record(supplier);
  record.combatAt = world.time;
  const waiting = unit(actor), deadline = record.combatAt + CALM_SECONDS;
  assert.equal(waiting.calm, true); assert.equal(Object.hasOwn(waiting, 'calmUntil'), false);
  for (const point of [waiting.point, waiting.mender]) {
    assert.equal(point.supplier, supplier.id); assert.equal(point.held, 'combat'); assert.equal(point.calmUntil, deadline);
  }
  room.serve(); assert.equal(Object.hasOwn(unit(actor), 'refilled'), false);
  world.command('setVehicleState', { actorId: supplier.id, state: { vx: 2, vy: 0 } });
  assert.equal(unit(actor).point.held, 'moving'); assert.equal(Object.hasOwn(unit(actor).point, 'calmUntil'), false);
  f.put(supplier, place); record.combatAt = Infinity; f.settlePhysics();
  assert.equal(unit(actor).point.held, 'combat'); assert.equal(Object.hasOwn(unit(actor).point, 'calmUntil'), false);
  room.record(actor).combatAt = Infinity;
  assert.equal(Object.hasOwn(unit(actor), 'calmUntil'), false);
  room.record(actor).combatAt = -Infinity; record.combatAt = world.time - CALM_SECONDS;
  room.serve();
  assert.equal(unit(actor).refilled.fuelLitres, 6); assert.equal(unit(actor).refilled.rounds, 0);
  assert.equal(Object.hasOwn(unit(actor).point, 'calmUntil'), false);
});

test('feedback stays owner-only, adds a small optional frame field and is absent from saves and digests', t => {
  const f = field(t), { room, player, unit } = f, actor = f.publish(), enemy = room.join('Bia');
  f.settle(); f.spend(actor, 2, 1); room.serve(); assert(unit(actor).refilled, 'served by itself');
  const own = unit(actor), { refilled, ...without } = own,
    withFrame = new FrameWriter().encode({ state: {}, faction: { units: [own] } }, true),
    withoutFrame = new FrameWriter().encode({ state: {}, faction: { units: [without] } }, true);
  assert(withFrame.byteLength - withoutFrame.byteLength > 0 && withFrame.byteLength - withoutFrame.byteLength < 160);
  assert.deepEqual(new FrameReader().decode(withFrame).faction.units[0].refilled, refilled);
  assert.equal(JSON.stringify(room.factionView(enemy.playerId)).includes('"refilled"'), false);
  assert.equal(JSON.stringify(room.world.snapshot()).includes('"refilled"'), false);
  assert.equal(JSON.stringify(room.world.snapshot()).includes('"calmUntil"'), false);
  const saved = JSON.stringify(room.keep()), digest = room.digest();
  assert.equal(/"refilled"|"calmUntil"/.test(saved), false);
  delete room.record(actor).refilled;
  assert.equal(room.digest(), digest); assert.equal(JSON.stringify(room.keep()), saved);
  const again = rehearsal(BASES, undefined, { fog: false, kept: JSON.parse(saved) });
  t.after(() => again.world.dispose());
  assert.equal(Object.hasOwn(again.records.get(actor.id), 'refilled'), false);
  assert.equal(Object.hasOwn(again.factionView(player.id).units.find(unit => unit.id === actor.id), 'refilled'), false);
});

test('a receipt expires after four seconds and inactive or unpaid service adds no optional fields', t => {
  const f = field(t), { room, world, faction, unit } = f, actor = f.publish();
  f.settle();
  assert.equal(Object.hasOwn(unit(actor), 'calmUntil'), false); assert.equal(Object.hasOwn(unit(actor), 'refilled'), false);
  f.spend(actor, 5, 1); Object.assign(faction.stock, bill());
  room.serve();
  assert.equal(Object.hasOwn(unit(actor), 'refilled'), false);
  Object.assign(faction.stock, bill(1000, 0, 0, 1000)); room.serve();
  const until = unit(actor).refilled.until;
  let steps = 0;
  while (world.time < until && steps++ < 242) room.step();
  assert(world.time >= until); assert.equal(Object.hasOwn(unit(actor), 'refilled'), false);
  assert.equal(Object.hasOwn(unit(actor), 'calmUntil'), false);
  assert.deepEqual([...room.faults], []);
});
