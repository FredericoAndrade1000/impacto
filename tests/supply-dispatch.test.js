import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { appraise, bill, billTotal, carriedBy, fieldParts, supplied, BASE_RADIUS, CALM_SECONDS, STOCK_IDS, SUPPLY_REACH, TURN_SECONDS } from '../src/economy.ts';
import { ammunitionCost } from '../src/construction-cost.ts';
import { cargoMass, cargoRoom, cargoVolume, reserveState } from '../src/component-volume.ts';
import { componentReference } from '../src/component-size.ts';
import { unitsOf } from '../src/grid.ts';
import { onField } from './helpers/field.js';
import { PRIORITY } from '../server/supply-dispatch.ts';
import { BUILD_REACH, SITE_CLEARANCE } from '../src/construction-site.ts';
import { flyRound } from './mechanical-queries.js';

// Every vehicle starts in the base. Targets drive out under ordinary squad
// orders; the proof of dispatch never teleports a chassis or invents a pose.
// A supplier comes on the field with its dispatch on: these are switched off first, and standing in the base so a supplier
// takes supplies on from the stocks by itself; opting it in (`start`) gives those back to the stocks first, so that what
// it carries out is what the dispatch loaded for an ally.
function field(t, { trucks = 1, supplier = 'supply', targetModel = 'scout' } = {}) {
  const room = rehearsal([12, 20000], bill(1e7, 1e6, 1e6, 1e5)), world = room.world, helpers = onField(t, room);
  const joined = room.join('Ana'), player = room.players.get(joined.playerId), faction = room.faction(player);
  const publish = source => { player.builtAt = -Infinity; return room.publish(player.id, typeof source === 'string' ? createStructuredTemplate(source) : source).actor.id; },
    suppliers = Array.from({ length: trucks }, () => publish(supplier)),
    target = publish(targetModel),
    run = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) room.step(); },
    until = (done, seconds = 100) => { for (let i = 0; i < seconds * 60 && !done(); i++) room.step(); return done(); },
    send = (type, data = {}) => room.command(player.id, { type, ...data }),
    order = (order, data) => send('squad', { order, ...data }),
    part = (id, kind) => world.modules.find(piece => piece.actorId === id && piece.kind === kind),
    set = (piece, state) => world.game().call({ op: 'setPartState', owner: world.game().handle(piece), state }),
    stock = id => supplied(carriedBy(room.serving(id)).carried),
    enable = id => send('auto', { actorId: id, on: true }),
    demand = () => { set(part(target, 'ammo'), { rounds: 0 }); set(part(target, 'fuel'), { fuelLitres: 1 }); },
    deploy = (id, goal) => {
      order('move', { ids: [id], x: goal });
      assert(until(() => !player.squad.units.get(id).move && Math.abs(room.position(world.actor(id)) - goal) < 3 && room.still(world.actor(id))), 'the real vehicle drove out and stopped');
    },
    out = () => {
      deploy(target, faction.base.x + 300);
      assert(!room.atBase(faction, world.actor(target)));
    },
    start = () => { for (const id of suppliers) { enable(id); room.supplyDispatch.unload(world.actor(id), faction); } },
    quote = id => appraise(world.actor(id), fieldParts(world));
  for (const id of suppliers) send('auto', { actorId: id, on: false });
  run(2);
  return { room, world, player, faction, suppliers, target, publish, run, until, send, order, part, set, stock, enable, demand, out, start, quote, deploy,
    phase: id => room.supplyDispatch.view(id).phase,
    // A works of the player's, a structure raised for the player, and both as the faction is told them.
    open: (model, how) => helpers.open(joined, model, how), raise: (model, how) => helpers.raise(joined, model, how), site: (model, how) => helpers.site(joined, model, how),
    works: () => room.factionView(player.id).works, heaps: () => room.factionView(player.id).heaps };
}

function resources(f) {
  let iron = f.faction.stock.ferro, fuel = f.faction.stock.combustivel;
  for (const piece of f.world.modules) {
    if (piece.kind === 'ammo') iron += piece.rounds * ammunitionCost(piece.ammoPreset, piece.ammoType);
    if (piece.kind === 'fuel') fuel += piece.fuelLitres;
    if (piece.kind === 'supply') { iron += piece.cargo?.ferro || 0; fuel += piece.cargo?.petroleo || 0; }
  }
  return { iron, fuel };
}

// A real three-axle recon drives out normally, then starts this isolated repair
// scenario with damaged running gear. Its reserves stay above the rearm trigger.
function repairOnly(f, count = 1) {
  f.out();
  const wheels = f.world.modules.filter(part => part.actorId === f.target && part.kind === 'wheel');
  assert(wheels.length >= count);
  for (const piece of wheels.slice(0, count)) f.set(piece, { health: piece.maxHealth / 2 });
  f.run(CALM_SECONDS + 1);
  const actor = f.world.actor(f.target), quote = f.quote(f.target);
  assert(f.room.calm(actor) && f.room.still(actor));
  assert(billTotal(quote.repair) > 0, 'the damage has a real material bill');
  for (const piece of actor.blueprint.modules.filter(piece => ['ammo', 'fuel'].includes(piece.kind))) {
    const key = piece.kind === 'fuel' ? 'fuelLitres' : 'rounds', full = reserveState(piece)[key];
    assert(quote.levels[piece.id][key] > full * .35, 'no reserve is low enough to request rearm');
  }
  return quote;
}

for (const supplier of ['construction-truck', 'supply']) test(`repair dispatch: empty ${supplier} collects and pays for damage alone`, t => {
  const f = field(t, { supplier, targetModel: 'recon' }), { room, world, suppliers: [truck], target } = f,
    quote = repairOnly(f), dispatch = room.supplyDispatch,
    rounds = f.part(target, 'ammo')?.rounds;
  f.start();
  assert.equal(billTotal(f.stock(truck)), 0, 'the opted-in supplier starts empty');
  const before = resources(f), loads = t.mock.method(dispatch, 'stow');
  assert(f.until(() => dispatch.jobs.get(truck)?.targetId === target, 3), 'damage alone requests the supply trip');
  assert.equal(dispatch.jobs.get(truck).kind, 'repair');
  assert.equal(loads.mock.callCount(), 1, 'one collection of the quoted repair materials');
  assert.deepEqual(f.stock(truck), quote.repair, 'the repair load is not an ammunition or fuel top-up');
  assert(f.until(() => room.record(world.actor(target)).service?.kind === 'repair', 100), 'the actual supplier drove into reach and paid the repair');
  const service = room.record(world.actor(target)).service;
  assert.equal(service.payer, truck); assert.equal(service.pieces, null);
  assert.deepEqual(service.cost, quote.repair);
  assert.equal(resources(f).iron, before.iron - service.cost.ferro, 'existing stock paid once');
  if (rounds !== undefined) assert.equal(f.part(target, 'ammo').rounds, rounds, 'repair materials never become ammunition');
  assert(f.until(() => !room.record(world.actor(target)).service && billTotal(f.quote(target).repair) === 0, quote.seconds + 2));
  f.run(3);
  assert.equal(loads.mock.callCount(), 1, 'a complete repair does not collect again');
  assert(![...dispatch.jobs.values()].some(job => job.kind === 'repair' && job.targetId === target));
});

test('repair dispatch: a meaningful partial repair spends its actual stock once and waits instead of looping trips', t => {
  const f = field(t, { supplier: 'construction-truck', targetModel: 'recon' }), { room, world, suppliers: [truck], target, faction } = f,
    quote = repairOnly(f, 2), dispatch = room.supplyDispatch,
    first = quote.mendable.find(piece => piece.id.includes('wheel'));
  assert(first && first.stock !== 'combustivel' && billTotal(quote.repair) > first.cost);
  f.start();
  const stock = bill(0, 0, 0, 1e5); stock[first.stock] = first.cost;
  Object.assign(faction.stock, stock);
  const loads = t.mock.method(dispatch, 'stow'), starts = t.mock.method(dispatch, 'start');
  assert(f.until(() => dispatch.jobs.get(truck)?.targetId === target, 3), 'a whole damaged piece is worth a partial repair trip');
  assert(f.until(() => room.record(world.actor(target)).service?.kind === 'repair', 100));
  const service = room.record(world.actor(target)).service;
  assert.equal(service.payer, truck);
  assert.equal(service.cost[first.stock], first.cost);
  assert(service.pieces?.length && service.pieces.some(piece => piece.share === 1), 'the existing partial-mend policy repairs a whole piece');
  assert.equal(faction.stock[first.stock] + f.stock(truck)[first.stock], 0, 'every reserved unit was paid, with no duplicate charge');
  assert(f.until(() => !room.record(world.actor(target)).service, service.until - world.time + 2));
  assert(billTotal(f.quote(target).repair) > 0, 'the unfunded damage remains');
  f.run(40);
  assert.equal(loads.mock.callCount(), 1);
  assert.equal(starts.mock.calls.filter(call => call.arguments[1].kind === 'repair').length, 1, 'no endless empty repair journeys');
  assert.equal(dispatch.view(truck).reason, 'waiting-stock');
});

// A bunker raised off the base whose gun a round went through when it had nothing left: burst, as a hit leaves a piece, and of
// no use. Its whole repair is more than twice what a supply vehicle of the templates takes.
function burstGun(f) {
  const id = f.raise('bunker', { x: f.site('bunker', { from: 300 }) }), gun = () => f.part(id, 'weapon');
  f.set(gun(), { health: 1 });
  for (const side of [-1, 1]) if (!gun().detonated) {
    const { x, y, width } = gun();
    flyRound(f.world, { x: x + side * (width / 2 + .02), y, vx: -side * 600, vy: 0, power: 200, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, .0002);
  }
  assert(gun().detonated && gun().health === 0, 'the gun burst');
  f.run(CALM_SECONDS + 1);
  return { id, gun };
}

test('repair dispatch: a piece that burst and costs more than the supply pieces hold is mended in parts, trip after trip, and works again', t => {
  const f = field(t), { room, world, suppliers: [truck], until } = f, dispatch = room.supplyDispatch, { id, gun } = burstGun(f),
    quote = f.quote(id);
  assert(dispatch.holding(quote.repair, dispatch.capacity(world.actor(truck))) < billTotal(quote.repair) / 2, 'its supply pieces hold less than half of it');
  f.start();
  const loads = t.mock.method(dispatch, 'stow'), reasons = new Set(), look = done => () => { reasons.add(dispatch.view(truck).reason); return done(); };
  // The first part of it brought, the gun works again, as a damaged one works.
  assert(until(look(() => !gun().detonated), 200), 'a part of the repair brings the gun back');
  assert(gun().health > 0 && gun().health < gun().maxHealth);
  // And the rest is brought, trip after trip, until it is whole.
  assert(until(look(() => billTotal(f.quote(id).repair) === 0), 900), 'the rest is brought trip after trip');
  assert.equal(gun().health, gun().maxHealth);
  assert(loads.mock.callCount() >= 3, `${loads.mock.callCount()} loads`);
  assert(!reasons.has('waiting-stock') && !reasons.has('no-room'), [...reasons].join());
});

test('repair dispatch: a plate is mended whole, one at a time, where what is brought pays for it and not for all the damage', t => {
  const f = field(t, { targetModel: 'recon' }), { room, world, faction, target, until } = f;
  f.out();
  const holed = world.plates.filter(plate => plate.actorId === target).slice(0, 3);
  for (const plate of holed) { const { x, y } = plate.frame; world.cutBody(plate, { x: x - .3, y: y - .3 }, { x: x + .3, y: y + .3 }, .15); }
  f.run(CALM_SECONDS + 1);
  const [first, ...rest] = f.quote(target).mendable.filter(piece => piece.entire),
    plate = id => world.plates.find(piece => piece.actorId === target && piece.id.endsWith(':' + id));
  assert(first && rest.length, 'plates of it are holed');
  f.start();
  Object.assign(faction.stock, { ...bill(), ...first.costs, combustivel: 1e5 });
  assert(until(() => room.record(world.actor(target)).service?.kind === 'repair', 100), 'what pays for one plate is brought');
  const service = room.record(world.actor(target)).service;
  assert.deepEqual(service.pieces, [{ id: first.id, share: 1 }]);
  assert(until(() => !room.record(world.actor(target)).service, service.until - world.time + 2));
  assert.equal(plate(first.id).integrity, 1, 'that plate is whole again');
  assert(rest.every(piece => plate(piece.id).integrity < 1), 'and the others are as they were');
});

test('repair dispatch: with stocks to spare, a vehicle that has no room for a part of a repair worth its trip says so, not that the stocks lack it', t => {
  const f = field(t), { room, suppliers: [truck] } = f, dispatch = room.supplyDispatch;
  burstGun(f);
  t.mock.method(dispatch, 'capacity', () => ({ volume: 1e-3, mass: Infinity }));
  f.start(); f.run(3);
  assert.deepEqual([dispatch.view(truck).phase, dispatch.view(truck).reason], ['idle', 'no-room']);
});

test('repair dispatch: manual control, a move, cancellation and combat keep their existing repair veto', t => {
  const f = field(t, { supplier: 'construction-truck', targetModel: 'recon' }), { room, world, player, faction, target } = f;
  repairOnly(f);
  const actor = world.actor(target), record = room.record(actor), unit = player.squad.units.get(target),
    offered = () => room.supplyDispatch.demands(faction, fieldParts(world)).list.some(demand => demand.kind === 'repair' && demand.id === target);
  assert.equal(offered(), true, 'damage is offered before any veto');
  f.order('control', { id: target }); assert.equal(offered(), false, 'never hold a vehicle in the player\'s hands for repair');
  f.order('control', { id: null }); assert.equal(offered(), true);
  f.order('move', { ids: [target], x: room.position(actor) + 30 }); assert.equal(offered(), false);
  f.order('stop', { ids: [target] }); assert.equal(unit.move, null); assert.equal(offered(), true);
  record.declined = room.position(actor); assert.equal(offered(), false, 'a cancelled repair is not restarted at the same position');
  record.declined = null; assert.equal(offered(), true);
  const before = record.combatAt;
  record.combatAt = world.time; assert.equal(offered(), false, 'ten seconds out of combat remain mandatory');
  record.combatAt = before; assert.equal(offered(), true);
  const ownerId = actor.ownerId;
  // Directed dispatch-boundary fixture: the visible target remains in the fleet
  // list, but its ownership changed before the planner checks it.
  actor.ownerId = room.join('Bia').playerId;
  assert.equal(offered(), false, 'an ownership/faction mismatch is never serviced');
  actor.ownerId = ownerId;
});

test('repair dispatch: urgent rearm keeps priority four over repair priority two', t => {
  const f = field(t, { supplier: 'construction-truck', targetModel: 'recon' }), { room, faction, suppliers: [truck], target } = f;
  repairOnly(f);
  const urgent = f.publish('scout');
  f.deploy(urgent, faction.base.x + 400);
  f.set(f.part(urgent, 'ammo'), { rounds: 0 });
  f.set(f.part(urgent, 'fuel'), { fuelLitres: 1 });
  f.start();
  assert.deepEqual([PRIORITY.rearm, PRIORITY.repair], [4, 2]);
  const list = room.supplyDispatch.demands(faction, fieldParts(f.world)).list;
  assert(list.some(demand => demand.kind === 'repair' && demand.id === target));
  assert(list.some(demand => demand.kind === 'rearm' && demand.id === urgent));
  assert(f.until(() => room.supplyDispatch.jobs.has(truck), 3));
  assert.equal(room.supplyDispatch.jobs.get(truck).kind, 'rearm');
  assert.equal(room.supplyDispatch.jobs.get(truck).targetId, urgent, 'the slightly farther empty ally is served before optional repair');
});

test('the faction is told a construction runs low of fuel as the dispatch reckons it, by its tanks alone', t => {
  const f = field(t), { room, world, player, target } = f, parts = () => fieldParts(world),
    designed = reserveState(world.actor(target).blueprint.modules.find(piece => piece.kind === 'fuel')).fuelLitres,
    told = () => room.factionView(player.id).units.find(unit => unit.id === target), need = () => Boolean(room.supplyDispatch.need(world.actor(target), parts()));
  f.set(f.part(target, 'fuel'), { fuelLitres: designed * .4 });
  assert.deepEqual([told().fuelLow, need()], [undefined, false], 'above the share a supply vehicle is sent for');
  f.set(f.part(target, 'fuel'), { fuelLitres: designed * .3 });
  assert.deepEqual([told().fuelLow, need()], [true, true]);
  f.set(f.part(target, 'fuel'), { fuelLitres: designed }); f.set(f.part(target, 'ammo'), { rounds: 0 });
  assert.deepEqual([told().fuelLow, need()], [undefined, true], 'its magazines running low are no fuel');
});

test('ready transport uses faction memory, never hidden live stock, and a manual haul already owns its pickup', t => {
  const f = field(t, { trucks: 0 }), { room, faction, player, target } = f, dispatch = room.supplyDispatch,
    [known, hidden] = room.deposits.filter(site => Math.abs(site.x - faction.base.x) > BASE_RADIUS + 100);
  assert(known && hidden);
  faction.veins = new Map([[known.id, { left: 1000, stock: 500, still: false, at: -100 }]]);
  room.extracted.set(hidden.id, 90000); room.extracted.delete(known.id);
  assert.deepEqual(dispatch.readyPiles(faction).map(site => [site.id, site.stock]), [[known.id, 500]], 'a stale known pile is attempted honestly; an unseen rich pile is not discovered by the planner');
  player.squad.units.get(target).haul = { depositId: known.id, material: known.material, phase: 'out' };
  assert(!dispatch.demands(faction, fieldParts(room.world)).list.some(demand => demand.kind === 'haul' && demand.id === known.id));
  player.squad.units.get(target).haul = null; faction.veins.clear();
  assert.deepEqual(dispatch.readyPiles(faction), [], 'clearing the only known pile never falls back to invisible current piles');
});

test('disabled automatic supply skips actor discovery and enabled supply still requires a working supplier', t => {
  const f = field(t), { room, world, suppliers: [truck], target } = f,
    crate = f.part(truck, 'supply'),
    lookups = t.mock.method(world, 'actor'), serving = t.mock.method(room, 'serving');
  for (const id of [truck, target, 'missing']) assert.equal(room.supplyDispatch.manages(id), false);
  assert.equal(lookups.mock.callCount(), 0, 'disabled or absent opt-in needs no field lookup');
  assert.equal(serving.mock.callCount(), 0);

  f.enable(truck); lookups.mock.resetCalls(); serving.mock.resetCalls();
  assert.equal(room.supplyDispatch.manages(truck), true);
  assert.deepEqual(lookups.mock.calls.map(call => call.arguments), [[truck]]);
  assert.deepEqual(serving.mock.calls.map(call => call.arguments), [[truck]]);

  f.set(crate, { health: 0 }); lookups.mock.resetCalls(); serving.mock.resetCalls();
  assert.equal(room.supplyDispatch.manages(truck), false, 'opt-in cannot make a destroyed supply piece serve');
  assert.equal(lookups.mock.callCount(), 1); assert.equal(serving.mock.callCount(), 1);
});

test('automatic supply survives one member disconnecting, gives no job while the faction is away, and goes on when a member comes back', t => {
  const f = field(t), { room, world, player, faction, suppliers: [truck] } = f,
    ally = room.players.get(room.join('Bia').playerId), actor = world.actor(truck);
  room.command(player.id, { type: 'invite', playerId: ally.id });
  room.command(ally.id, { type: 'join-faction', factionId: faction.id });
  const work = f.open('guard-post', { x: f.site('guard-post', { from: 250 }) });
  f.enable(truck);
  assert(f.until(() => room.supplyDispatch.jobs.get(truck)?.targetId === work, 3), 'it takes the works its material');

  room.disconnect(player.id);
  assert.equal(player.connected, false); assert.equal(room.players.has(player.id), true);
  assert.equal(actor.ownerId, player.id, 'disconnect leaves the existing squad on the field');
  assert.equal(faction.away, null); assert.equal(room.record(actor).auto, true);
  assert.equal(room.supplyDispatch.manages(truck), true, 'another online member keeps faction work autonomous');

  room.disconnect(ally.id);
  assert.equal(faction.away, world.time); assert.equal(room.record(actor).auto, true, 'it stays in automatic for when a member comes back');
  assert.equal(room.supplyDispatch.jobs.size, 0, 'the last departure ends its job');
  f.run(5);
  assert.equal(room.supplyDispatch.jobs.size, 0, 'nobody of the faction on the field: no job is given');
  room.join('Ana', player.token);
  assert.equal(faction.away, null);
  assert(f.until(() => room.supplyDispatch.jobs.get(truck)?.targetId === work, 5), 'back on the field, the works is brought its material again');
});

test('an invalid faction invitation leaves dispatch intact and a real faction transfer removes its stale suppliers', t => {
  const f = field(t), { room, world, player, faction, suppliers: [truck] } = f,
    other = room.players.get(room.join('Bia').playerId), destination = room.faction(other);
  f.enable(truck);
  assert.throws(() => room.command(player.id, { type: 'join-faction', factionId: 'missing' }), /convite/);
  assert.equal(room.supplyDispatch.manages(truck), true, 'a rejected faction command changes no standing work');

  room.command(other.id, { type: 'invite', playerId: player.id });
  room.command(player.id, { type: 'join-faction', factionId: destination.id });
  assert.equal(room.factions.has(faction.id), false, 'the empty old faction is disbanded');
  assert.equal(player.factionId, destination.id); assert(!world.actor(truck));
  assert.equal(room.records.has(truck), false);
  const lookups = t.mock.method(world, 'actor');
  assert.equal(room.supplyDispatch.manages(truck), false);
  assert.equal(lookups.mock.callCount(), 0, 'a removed faction has no opted-in supplier to discover');
});

test('an opted-in supply truck loads only actual deficits, drives to the ally, services it and returns its remainder without creating resources', t => {
  const f = field(t), { room, world, faction, suppliers: [truck], target, out, demand, start, until, stock, quote } = f;
  assert.equal(room.record(world.actor(truck)).auto, false);
  out(); f.deploy(truck, faction.base.x + 150); demand(); start();
  const due = quote(target).rearm, before = resources(f), held = { ...faction.stock };
  assert(until(() => f.phase(truck) === 'collect', 5), 'the empty supplier first heads back to collect real stock');
  assert.equal(billTotal(stock(truck)), 0);
  assert(until(() => f.phase(truck) === 'deliver', 45), 'loaded and dispatched');
  const aboard = stock(truck), crates = room.serving(truck), origin = room.position(world.actor(truck));
  assert(aboard.ferro > 0 && aboard.ferro <= due.ferro && aboard.combustivel > 0 && aboard.combustivel <= due.combustivel + 1);
  assert.equal(aboard.ligas, 0); assert.equal(aboard.silica, 0);
  assert.equal(held.ferro - faction.stock.ferro, aboard.ferro, 'the exact loaded iron came from real stock');
  assert(held.combustivel - faction.stock.combustivel >= aboard.combustivel, 'target and trip fuel were paid');
  assert(crates.every(piece => cargoVolume(piece) <= cargoRoom(piece) + 1e-9));
  assert(crates.reduce((sum, piece) => sum + cargoMass(piece), 0) <= room.supplyDispatch.capacity(world.actor(truck)).mass + 1e-6);
  assert(until(() => f.part(target, 'ammo').rounds > 0 && f.phase(truck) === 'return', 100), 'the real supplier reached and served its ally');
  assert(Math.abs(room.position(world.actor(truck)) - origin) > BASE_RADIUS, 'it travelled beyond its base');
  assert(until(() => !room.supplyDispatch.jobs.has(truck) && room.atBase(faction, world.actor(truck)) && room.still(world.actor(truck)), 100), 'it returned under the ordinary driver');
  assert.equal(billTotal(stock(truck)), 0, 'unused cargo is returned to the actual stocks');
  const after = resources(f);
  assert(Math.abs(after.iron - before.iron) <= 1, 'iron is conserved to the economy whole-unit bill');
  assert(after.fuel <= before.fuel + 1 && after.fuel > before.fuel - 5, 'only real engine consumption spends fuel');
  assert(f.part(target, 'ammo').rounds > reserveState(world.actor(target).blueprint.modules.find(piece => piece.kind === 'ammo')).rounds * .35);
});

test('a supply truck parks beside the vehicle it serves, a few metres off it end to end, and hands over only from there', t => {
  const f = field(t), { room, world, faction, suppliers: [truck], target, order, until } = f,
    apart = () => room.works.gap(world.actor(truck), room.works.hull(world.actor(target))), rounds = () => f.part(target, 'ammo').rounds;
  f.out(); f.demand(); f.start();
  let handed = null;
  assert(until(() => (handed = rounds() > 0 ? { gap: apart(), still: room.still(world.actor(truck)), move: Boolean(f.player.squad.units.get(truck).move) } : null), 100), 'the target is rearmed');
  t.diagnostic(JSON.stringify(handed));
  assert(handed.gap <= SUPPLY_REACH && handed.gap >= 1 && handed.still && !handed.move, `parked beside it: ${handed.gap.toFixed(2)} m off it`);
  // Sent 25 m off it end to end, it is no point of service of it there.
  f.demand();
  const hull = room.works.hull(world.actor(target)), goal = hull.minX - 25 - (room.works.hull(world.actor(truck)).maxX - room.position(world.actor(truck)));
  order('move', { ids: [truck], x: goal });
  assert(until(() => !f.player.squad.units.get(truck).move && room.still(world.actor(truck)), 60), 'it drove off and stopped');
  assert(apart() > SUPPLY_REACH, `${apart().toFixed(1)} m off it`);
  assert(!room.points(faction, world.actor(target)).some(point => point.supplier?.id === truck), 'it serves nothing from there');
});

test('two dispatchers reserve one ally once and a second truck stays at the base without taking another load', t => {
  const f = field(t, { trucks: 2 }); f.out(); f.demand();
  const before = f.faction.stock.ferro, due = f.quote(f.target).rearm.ferro;
  f.start(); f.run(3);
  const jobs = [...f.room.supplyDispatch.jobs.entries()].filter(([, job]) => job.phase !== 'return');
  assert.equal(jobs.length, 1); assert.equal(jobs[0][1].targetId, f.target);
  assert.equal(f.stock(f.suppliers.find(id => id !== jobs[0][0])).ferro, 0);
  assert(f.faction.stock.ferro >= before - due);
});

test('one urgent delivery rearms nearby reserves above the trip threshold before paying for damage, and mends that after, from what it loaded for it', t => {
  const f = field(t), { room, world, faction, target, suppliers: [truck] } = f,
    near = f.publish('scout'), far = f.publish('scout');
  f.out(); f.deploy(near, faction.base.x + 280); f.deploy(far, faction.base.x + 345);
  for (const id of [near, far]) {
    const ammo = world.actor(id).blueprint.modules.find(piece => piece.kind === 'ammo'), fuel = world.actor(id).blueprint.modules.find(piece => piece.kind === 'fuel');
    f.set(f.part(id, 'ammo'), { rounds: Math.floor(reserveState(ammo).rounds * .75) });
    f.set(f.part(id, 'fuel'), { fuelLitres: reserveState(fuel).fuelLitres * .6 });
  }
  f.set(f.part(target, 'engine'), { health: f.part(target, 'engine').maxHealth * .99 });
  f.run(CALM_SECONDS + 1);
  assert.equal(room.supplyDispatch.need(world.actor(near), fieldParts(world)), null, 'the neighbour alone would not start a trip');
  f.demand();
  const due = f.quote(target).rearm.ferro + f.quote(near).rearm.ferro,
    nearRounds = reserveState(world.actor(near).blueprint.modules.find(piece => piece.kind === 'ammo')).rounds,
    farRounds = f.part(far, 'ammo').rounds, before = resources(f);
  assert(f.quote(target).repair.ferro > 0 && f.quote(target).repair.ferro < f.quote(near).rearm.ferro, 'the urgent construction could otherwise spend the neighbours ammunition budget on a whole repair');
  const mend = f.quote(target).repair, loads = t.mock.method(room.supplyDispatch, 'stow');
  f.start(); assert(f.until(() => f.phase(truck) === 'deliver', 5));
  assert.deepEqual(room.supplyDispatch.jobs.get(truck).targetIds, [target, near]);
  assert.deepEqual(room.supplyDispatch.jobs.get(truck).after.map(stop => [stop.kind, stop.targetId]), [['repair', target]], 'its repair is the next stop');
  assert.equal(f.stock(truck).ferro, due + mend.ferro, 'the two real deficits were loaded, and the repair apart, with no cargo for the farther construction');
  assert.equal(f.stock(truck).ligas, 0); assert.equal(f.stock(truck).silica, 0);
  const served = f.until(() => f.part(target, 'ammo').rounds > 0 && f.part(near, 'ammo').rounds === nearRounds, 100);
  if (!served) t.diagnostic(JSON.stringify({ now:world.time, truckX:room.position(world.actor(truck)), targetX:room.position(world.actor(target)), nearX:room.position(world.actor(near)),
    truckSpeed:world.actor(truck).vehicle.vx, stock:f.stock(truck), phase:f.phase(truck), job:room.supplyDispatch.jobs.get(truck), targetAmmo:f.part(target,'ammo').rounds,
    nearAmmo:f.part(near,'ammo').rounds, nearRounds, service:room.record(world.actor(target)).service }));
  assert(served, 'the same physical stop rearmed both before any automatic repair');
  assert.equal(room.record(world.actor(target)).service, null, 'the extra cargo was not diverted to a repair');
  assert.equal(f.part(far, 'ammo').rounds, farRounds, 'a construction near the target but beyond the truck stop was not served');
  assert(Math.abs(resources(f).iron - before.iron) <= 1, 'grouping moved existing iron without creating resources');
  assert(f.until(() => f.part(target, 'engine').health === f.part(target, 'engine').maxHealth, 100), 'then it is mended');
  assert.equal(loads.mock.callCount(), 1, 'from the one load');
});

test('two supply trucks commit overlapping nearby recipients only once and Stop releases the whole job', t => {
  const f = field(t, { trucks: 2 }), { room, world, faction, target } = f, near = f.publish('scout');
  f.out(); f.deploy(near, faction.base.x + 288); f.demand();
  f.set(f.part(near, 'ammo'), { rounds: 0 }); f.set(f.part(near, 'fuel'), { fuelLitres: 1 });
  const due = f.quote(target).rearm.ferro + f.quote(near).rearm.ferro;
  f.start(); const before = faction.stock.ferro; f.run(3);
  const jobs = [...room.supplyDispatch.jobs].filter(([, job]) => job.kind === 'rearm');
  assert.equal(jobs.length, 1, 'the second pair was reevaluated after the first load committed both recipients');
  const [truck, job] = jobs[0], other = f.suppliers.find(id => id !== truck);
  // The two stand too far apart to be served from one stop beside one of them (`SUPPLY_REACH`): the other is the next stop
  // of the same trip (`after`).
  assert.deepEqual(new Set([...job.targetIds, ...(job.after ?? []).flatMap(stop => stop.targetIds)]), new Set([target, near]));
  assert.equal(f.stock(truck).ferro, due); assert.equal(f.stock(other).ferro, 0);
  assert.equal(before - faction.stock.ferro, due);
  f.order('stop', { ids: [truck] });
  assert.equal(room.supplyDispatch.jobs.has(truck), false); assert.equal(room.record(world.actor(truck)).auto, false);
  assert(!room.supplyDispatch.claimed().has(target) && !room.supplyDispatch.claimed().has(near), 'the manual cancellation leaves no secondary reservation');
});

test('scarce rearm loads respect capacity and each suppliers anchor before the general service pass', t => {
  const model = createStructuredTemplate('supply'), supplier = { ...model,
    components: model.components.map(piece => piece.kind === 'supply' ? { ...piece, sizeScale: .25,
      pose: { ...piece.pose, y: piece.pose.y - unitsOf(componentReference(piece).height * ((piece.sizeScale ?? 1) - .25) / 2) } } : piece) },
    f = field(t, { supplier }), { room, world, faction, target, suppliers: [truck] } = f, near = f.publish('scout');
  f.out(); f.deploy(near, faction.base.x + 288);
  const ammo = world.actor(target).blueprint.modules.find(piece => piece.kind === 'ammo');
  f.set(f.part(target, 'ammo'), { rounds: Math.floor(reserveState(ammo).rounds * .75) });
  f.set(f.part(near, 'ammo'), { rounds: 0 }); f.set(f.part(near, 'fuel'), { fuelLitres: 1 });
  assert(f.quote(target).rearm.ferro > 100, 'the older neighbour could consume the entire scarce load if visited first');
  f.start(); Object.assign(faction.stock, bill(100, 0, 0, 20));
  const before = resources(f);
  assert(f.until(() => f.phase(truck) === 'deliver', 5));
  const carried = f.stock(truck), crates = room.serving(truck), capacity = room.supplyDispatch.capacity(world.actor(truck));
  assert(carried.ferro > 0 && carried.ferro <= 100 && carried.combustivel <= 20);
  assert(STOCK_IDS.every(id => faction.stock[id] >= 0), 'no reserved or absent stock was invented');
  assert(crates.reduce((sum, piece) => sum + cargoVolume(piece), 0) <= capacity.volume + 1e-9);
  assert(crates.reduce((sum, piece) => sum + cargoMass(piece), 0) <= capacity.mass + 1e-6);
  assert(f.until(() => f.part(near, 'ammo').rounds > 0, 100), 'the urgent newer construction receives ammunition first');
  assert(Number.isInteger(f.part(near, 'ammo').rounds));
  assert(Math.abs(resources(f).iron - before.iron) <= 1, 'the partial paid rearm preserves the iron ledger');

  // A separate authored in-progress state: two partial cargoes, two anchors, all within reach of both suppliers.
  // The existing offer/start path builds the jobs; this is a service-order assay, not a resource-earning journey.
  // Within reach of both is a few metres off each end to end (`SUPPLY_REACH`): the two lorries stand through each other
  // between them, as vehicles may — the squad would park them apart, each out of reach of the farther anchor —, put there.
  const g = field(t, { trucks: 2 }), second = g.publish('scout'), [firstTruck, secondTruck] = g.suppliers,
    stand = (id, x) => { const v = g.world.actor(id).vehicle, ground = g.world.terrain;
      g.world.command('setVehicleState', { actorId: id, state: { x, y: v.y - ground.height(v.x) + ground.height(x), vx: 0, vy: 0 } }); };
  g.out(); g.deploy(second, g.faction.base.x + 318);
  for (const id of g.suppliers) stand(id, g.faction.base.x + 309);
  g.run(1.5);
  const magazine = g.world.actor(g.target).blueprint.modules.find(piece => piece.kind === 'ammo'),
    price = ammunitionCost(magazine.ammoPreset, magazine.ammoType), halfRounds = Math.floor(75 / price + 1e-9),
    initialRounds = reserveState(magazine).rounds - 2 * halfRounds;
  assert(halfRounds > 0 && initialRounds >= 0, 'each 75-iron load pays a nonempty whole-round half of the deficit');
  for (const id of [g.target, second]) g.set(g.part(id, 'ammo'), { rounds: initialRounds });
  for (const id of g.suppliers) g.set(g.part(id, 'supply'), { cargo: { ferro: 75, ligas: 0, silica: 0, petroleo: 0 } });
  const pieces = fieldParts(g.world);
  for (const [carrierId, anchorId] of [[firstTruck, g.target], [secondTruck, second]]) {
    g.enable(carrierId);
    const anchor = g.world.actor(anchorId), man = g.room.supplyDispatch.crewman(g.world.actor(carrierId), pieces),
      demand = { kind: 'rearm', id: anchorId, x: g.room.position(anchor), target: anchor, quote: g.quote(anchorId) },
      offer = g.room.supplyDispatch.offer(man, demand, g.faction, pieces);
    assert.equal(offer.phase, 'deliver');
    g.room.supplyDispatch.start(man, demand, offer, g.faction, pieces);
  }
  for (const carrierId of g.suppliers) for (const anchorId of [g.target, second])
    assert(g.room.handy(g.world.actor(carrierId), g.world.actor(anchorId)), 'both suppliers can physically reach both anchors');
  const held = resources(g);
  g.room.serve();
  for (const anchorId of [g.target, second])
    assert(g.part(anchorId, 'ammo').rounds >= initialRounds + halfRounds, 'each anchor receives its own suppliers partial load before incidental service');
  assert(Math.abs(resources(g).iron - held.iron) <= 1 + 1e-9, 'both whole-round charges preserve iron to the existing bill rounding');
});

test('an opted-in supply truck brings a works what it lacks from the base, as much as the stocks have, comes back and goes again', t => {
  const f = field(t), { room, world, faction, suppliers: [truck], until, stock } = f, id = f.open('guard-post', { x: f.site('guard-post', { from: 250 }) }),
    work = () => f.works().find(one => one.id === id), cost = work().cost;
  f.start();
  // The stocks have a little more than half of the iron it costs, and plenty of the rest.
  const some = Math.ceil(cost.ferro / 2) + 1;
  faction.stock.ferro = some;
  const before = faction.stock.ferro + stock(truck).ferro;
  assert(until(() => f.phase(truck) === 'deliver', 10), 'loaded at the base and on its way');
  assert.deepEqual([room.supplyDispatch.view(truck).kind, room.supplyDispatch.view(truck).targetId], ['work', id]);
  assert.equal(stock(truck).ferro, some, 'it loaded all the iron there was, no more than the works lacks');
  assert.equal(faction.stock.ferro, 0);
  // What the stocks have not of what the works lacks, less what is on its way: the faction is told what is missing.
  assert.equal(work().lack.ferro, cost.ferro - some);
  // It unloads only once it stands beside it, the end of it clear of the works and no further off than a builder works from.
  const span = room.works.span(room.works.pending.get(id)), gaps = [],
    unloading = () => { if (room.works.feeders.has(id)) gaps.push(room.works.gap(world.actor(truck), span)); return gaps.length > 0; };
  assert(until(unloading, 60), 'it unloads beside the works');
  assert(work().supplying);
  assert(until(() => { unloading(); return f.phase(truck) === 'return' || !room.supplyDispatch.jobs.has(truck); }, 30));
  assert(gaps.every(gap => gap >= SITE_CLEARANCE - .1 && gap <= BUILD_REACH),
    `it unloads from ${Math.min(...gaps).toFixed(2)} to ${Math.max(...gaps).toFixed(2)} m off the works`);
  assert(Math.abs(work().delivered.ferro - some) <= 1, 'all it carried of what the works lacked went in');
  assert(until(() => room.atBase(faction, world.actor(truck)) && room.supplyDispatch.view(truck).reason === 'waiting-stock', 90), 'home, it waits for stock');
  assert(Math.abs(faction.stock.ferro + stock(truck).ferro + work().delivered.ferro - before) <= 1, 'no iron is made or lost');
  // The stocks are filled again: it goes again, and the works has all of it.
  faction.stock.ferro = 1e6;
  assert(until(() => STOCK_IDS.every(material => work().delivered[material] >= cost[material]), 120), 'the works has all it costs');
  assert(until(() => !room.supplyDispatch.jobs.has(truck) && room.atBase(faction, world.actor(truck)), 120), 'and the truck came home');
  assert.equal(billTotal(stock(truck)), 0);
  assert.deepEqual(work().lack, bill());
});

test('a works is loaded at the base for what it asks of each stock, in that measure, whatever stock it asks most of', t => {
  const f = field(t), { room, world, suppliers: [truck], until, stock } = f, id = f.open('guard-post', { x: f.site('guard-post', { from: 250 }) }),
    work = room.works.pending.get(id);
  // Concrete is paid above all in silica: the load follows the works, not the mix the supply pieces take on at the base.
  work.cost = bill(400, 0, 30000, 0);
  f.start();
  assert(until(() => f.phase(truck) === 'deliver', 10), 'loaded at the base and on its way');
  const aboard = stock(truck), room_ = room.supplyDispatch.capacity(world.actor(truck));
  assert(aboard.silica > 0 && aboard.ferro > 0 && aboard.ligas === 0 && aboard.combustivel === 0);
  assert(Math.abs(aboard.silica * 400 - aboard.ferro * 30000) <= 30000, 'each stock in the share the works asks of it');
  assert(aboard.silica < 30000 && room.serving(truck).reduce((sum, piece) => sum + cargoVolume(piece), 0) > room_.volume * .98, 'as much as it carries');
  assert(until(() => STOCK_IDS.every(material => work.delivered[material] >= work.cost[material] - 1e-6), 400), 'trip after trip, all of it came, to the last unit');
});

test('an opted-in supply truck takes a heap of the faction back to the base, and nothing of it is made or lost', t => {
  const f = field(t), { room, world, faction, suppliers: [truck], until, stock } = f, id = f.open('guard-post', { x: f.site('guard-post', { from: 250 }) }),
    work = room.works.pending.get(id), carried = bill(...STOCK_IDS.map(material => work.cost[material] / 3));
  for (const material of STOCK_IDS) { faction.stock[material] -= carried[material]; work.delivered[material] = carried[material]; }
  f.send('cancel-work', { workId: id });
  f.start();
  const before = faction.stock.ferro + stock(truck).ferro + f.heaps()[0].stock.ferro;
  assert(until(() => f.phase(truck) === 'fetch', 10), 'off to the heap');
  assert.deepEqual([room.supplyDispatch.view(truck).kind, room.supplyDispatch.view(truck).targetId], ['heap', id]);
  assert(until(() => !f.heaps().length, 90), 'it loads it all');
  assert(until(() => !room.supplyDispatch.jobs.has(truck) && room.atBase(faction, world.actor(truck)), 90), 'and brings it home');
  assert.equal(billTotal(stock(truck)), 0);
  assert(Math.abs(faction.stock.ferro - before) <= 1);
});

test('a structure moved has its works brought from its own heap first, and from the base only for what that lacks', t => {
  const f = field(t), { room, world, faction, suppliers: [truck], until, stock } = f, id = f.raise('guard-post', { x: f.site('guard-post', { from: 250 }) }),
    from = room.position(world.actor(id)), to = f.site('guard-post', { from: Math.abs(from - faction.base.x) + 150, ignore: id });
  f.start(); f.run(1);
  const moved = f.send('relocate', { actorId: id, x: to, facing: 1 }), workId = moved.work.id;
  // Nobody takes it down yet: the works waits for its heap, and the truck takes nothing from the base for it.
  const before = faction.stock.ferro;
  f.run(5);
  assert.equal(room.supplyDispatch.view(truck).reason, 'waiting-dismantle'); assert.equal(faction.stock.ferro, before);
  // A builder stood beside it takes it down: its heap goes to its works, and then the base makes up what it lacks.
  const truckDesign = createStructuredTemplate('construction-truck'),
    builder = f.publish({ ...truckDesign, components: truckDesign.components.filter(part => part.kind !== 'supply') });
  f.run(1); f.deploy(builder, from + 12);
  const iron = faction.stock.ferro;
  assert(until(() => !world.actor(id), 10), 'taken down');
  // Half of what it gave back is gone from its heap: the base is to make up the rest.
  for (const material of STOCK_IDS) room.works.heaps.get(id).stock[material] /= 2;
  const heap = { ...room.works.heaps.get(id).stock };
  // It looks again once the wait it was given is over.
  assert(until(() => f.phase(truck) === 'fetch', 35), 'off to the heap first');
  assert.equal(room.supplyDispatch.view(truck).targetId, workId);
  assert.equal(faction.stock.ferro, iron, 'nothing came from the base yet');
  assert(until(() => !f.heaps().length, 120), 'the heap is loaded');
  assert(until(() => f.works()[0]?.supplying, 120), 'and brought to the works');
  // The builder stands by the works in automatic, putting it up as its material comes (at once, on a rehearsed field): on
  // the step the last of it comes the works may stand already, a structure where it was.
  const cost = { ...f.works()[0].cost };
  assert(until(() => f.works().length ? STOCK_IDS.every(material => f.works()[0].delivered[material] >= cost[material]) : !!world.actor(workId), 240),
    'the base makes up the rest');
  assert(faction.stock.ferro < iron, 'what the heap lacked came from the base');
  assert(Math.abs(iron - faction.stock.ferro - (cost.ferro - heap.ferro) - stock(truck).ferro) <= 2, 'just what the heap lacked');
});

// A supplier on its way to rearm an ally, as the room tells it, with how its squad holds it and whether it is in automatic.
function delivering(t) {
  const f = field(t), [truck] = f.suppliers, dispatch = f.room.supplyDispatch;
  f.out(); f.demand(); f.start();
  assert(f.until(() => f.phase(truck) === 'deliver', 5));
  return { ...f, truck, dispatch, unit: () => f.player.squad.units.get(truck), auto: () => f.room.record(f.world.actor(truck)).auto,
    at: () => f.room.position(f.world.actor(truck)), paused: reason => ({ kind: null, phase: 'paused', targetId: null, reason }) };
}

test('a manual move pauses the automatic while the vehicle drives there, and it goes back to work by itself from where it stops', t => {
  const f = delivering(t), { truck, dispatch } = f, goal = f.faction.base.x - 150;
  f.order('move', { ids: [truck], x: goal });
  const manual = f.unit().move;
  assert(manual); assert.equal(f.auto(), true, 'it stays in automatic'); assert.equal(dispatch.jobs.has(truck), false, 'its job ends');
  assert.deepEqual(dispatch.view(truck), f.paused('manual-order'));
  f.run(2); assert.equal(f.unit().move, manual, 'automatic cancellation preserved the newly accepted manual leg');
  assert.equal(dispatch.jobs.has(truck), false, 'no job is given while the order holds it');
  assert(f.until(() => !f.unit().move, 60), 'it gets there'); const there = f.at();
  assert(Math.abs(there - goal) < 3);
  assert(f.until(() => dispatch.jobs.has(truck), 5), 'once it stands there it is given a job again');
  assert.deepEqual([dispatch.jobs.get(truck).kind, dispatch.jobs.get(truck).targetId, f.auto()], ['rearm', f.target, true]);
  assert(Math.abs(f.at() - there) < 1, 'from where it stopped');
});

test('a new order during the pause takes the place of the one before, and the pause lasts until that one is carried out', t => {
  const f = delivering(t), { truck, dispatch } = f, far = f.faction.base.x - 900, near = f.faction.base.x - 120;
  f.order('move', { ids: [truck], x: far }); f.run(2);
  f.order('move', { ids: [truck], x: near });
  assert.deepEqual([f.unit().move.x, dispatch.view(truck)], [near, f.paused('manual-order')]);
  assert(f.until(() => !f.unit().move, 60) && Math.abs(f.at() - near) < 3, 'it stops where the second order sent it');
  assert(f.until(() => dispatch.jobs.get(truck)?.kind === 'rearm', 5), 'and goes back to work from there');
});

test('a manual move that ends where the way is shut lets go of the vehicle, which waits there as any in automatic does', t => {
  const f = delivering(t), { truck, dispatch } = f, from = f.at();
  // The way is behind it: the squad turns it about first, which is the order's too.
  f.order('move', { ids: [truck], x: f.faction.base.x - 400 });
  assert(f.until(() => !f.room.record(f.world.actor(truck)).service && Math.abs(f.at() - from) > 5, 20), 'on its way');
  assert.equal(dispatch.paused.get(truck), 'manual-order');
  // This is Squad's result after its progress timeout, not a prediction from slope or cargo.
  Object.assign(f.unit(), { move: null, halt: 'stuck-slope', reason: 'stuck-slope' });
  f.run(3);
  assert.deepEqual([dispatch.paused.has(truck), f.auto(), dispatch.jobs.has(truck), dispatch.view(truck).reason], [false, true, false, 'stuck-slope']);
  f.run(35); assert.equal(dispatch.jobs.has(truck), false, 'never sent again by itself after its cooldown');
});

test('Stop is the one order that takes a vehicle out of automatic, until the switch puts it back; a stance keeps it on its job', t => {
  const f = delivering(t), { truck, dispatch } = f;
  f.order('stop', { ids: [truck] });
  assert.deepEqual([f.auto(), dispatch.jobs.has(truck), dispatch.view(truck)], [false, false, f.paused('manual-order')]);
  f.run(35);
  assert.deepEqual([f.unit().move, f.auto(), dispatch.jobs.has(truck)], [null, false, false], 'nothing puts it back by itself');
  f.enable(truck); assert.equal(f.auto(), true);
  assert(f.until(() => f.phase(truck) === 'deliver', 5));
  f.order('stance', { ids: [truck], stance: 'hold' });
  assert.deepEqual([f.auto(), f.phase(truck)], [true, 'deliver'], 'fire policy leaves dispatch and its job as they were');
});

test('turning about pauses the automatic until the vehicle is turned', t => {
  const f = delivering(t), { truck, dispatch } = f, facing = f.world.actor(truck).facing;
  f.order('turn', { ids: [truck] });
  assert.deepEqual([f.auto(), dispatch.jobs.has(truck)], [true, false]);
  assert.equal(f.room.record(f.world.actor(truck)).service.kind, 'turn', 'cancelling dispatch preserves the accepted manual turn');
  f.run(TURN_SECONDS - 1);
  assert.deepEqual(dispatch.view(truck), f.paused('manual-order'), 'held while it turns');
  assert(f.until(() => f.world.actor(truck).facing === -facing, 2), 'the real turn completed');
  assert(f.until(() => f.phase(truck) === 'deliver', 3), 'and it goes back to its work');
});

test('a player taking the supplier controls pauses it until letting it go, and in hand its switch says what it does then', t => {
  const f = delivering(t), { truck, dispatch } = f;
  f.order('control', { id: truck }); f.run(3);
  assert.deepEqual([f.player.squad.manual, f.unit().move, f.auto(), dispatch.jobs.has(truck)], [truck, null, true, false]);
  assert.deepEqual(dispatch.view(truck), f.paused('manual-control'));
  f.run(5); assert.equal(dispatch.jobs.has(truck), false, 'never replaced by an automatic order while in hand');
  f.order('control', { id: null });
  assert(f.until(() => f.phase(truck) === 'deliver', 5), 'let go, it goes back to its work');
  // Switched off in hand, it stays where it is let go; switched on again in hand, it waits to be let go.
  f.order('control', { id: truck });
  f.send('auto', { actorId: truck, on: false }); f.send('auto', { actorId: truck, on: true });
  assert.deepEqual([f.auto(), dispatch.view(truck)], [true, f.paused('manual-control')]);
  f.send('auto', { actorId: truck, on: false }); f.order('control', { id: null }); f.run(3);
  assert.deepEqual([f.auto(), dispatch.jobs.has(truck), dispatch.view(truck)], [false, false, f.paused('')]);
});

test('an order that is refused pauses nothing, and one an order does not reach goes on with its job', t => {
  const f = delivering(t), { truck, dispatch } = f, job = dispatch.jobs.get(truck);
  assert.throws(() => f.order('move', { ids: [truck], x: NaN }), /Destino inválido/);
  assert.throws(() => f.order('attack', { ids: [truck], targetId: 'nobody' }), /Alvo inválido/);
  assert.deepEqual([dispatch.jobs.get(truck), dispatch.paused.has(truck), f.auto()], [job, false, true]);
  // An order to the faction's other vehicle leaves this one alone.
  f.order('move', { ids: [f.target], x: f.room.position(f.world.actor(f.target)) + 20 });
  assert.deepEqual([dispatch.jobs.get(truck), dispatch.paused.has(truck)], [job, false]);
});

test('the faction leaving the field during a pause ends it: its vehicles go home, in automatic for when a member comes back', t => {
  const f = field(t), { room, player, faction, suppliers: [truck] } = f, dispatch = room.supplyDispatch,
    work = f.open('guard-post', { x: f.site('guard-post', { from: 250 }) });
  f.enable(truck);
  assert(f.until(() => dispatch.jobs.get(truck)?.targetId === work, 3), 'it takes the works its material');
  f.order('move', { ids: [truck], x: faction.base.x - 400 });
  assert(f.until(() => !room.atBase(faction, f.world.actor(truck)), 30), 'held by the order, it drives out');
  assert.equal(dispatch.paused.get(truck), 'manual-order');
  room.disconnect(player.id);
  assert.equal(faction.away, f.world.time);
  assert.deepEqual([dispatch.paused.has(truck), room.record(f.world.actor(truck)).auto], [false, true], 'the pause ends, and it stays in automatic');
  assert(Math.abs(player.squad.units.get(truck).move.x - faction.base.x) < BASE_RADIUS, 'it is called home');
  assert.equal(dispatch.view(truck).phase, 'idle');
  f.run(5); assert.equal(dispatch.jobs.size, 0, 'nobody of the faction on the field: no job is given');
  room.join('Ana', player.token);
  assert(f.until(() => dispatch.jobs.get(truck)?.targetId === work, 60), 'back on the field, it brings the works its material again');
});

test('no stock leaves the supplier idle without repeat move commands', t => {
  const f = field(t), [truck] = f.suppliers; f.out(); f.demand();
  f.start(); Object.assign(f.faction.stock, bill());
  const squad = f.player.squad, command = squad.command.bind(squad); let moves = 0;
  squad.command = data => { if (data.order === 'move' && data.ids?.includes(truck)) moves++; return command(data); };
  f.run(20);
  assert.equal(moves, 0); assert.equal(billTotal(f.stock(truck)), 0); assert.equal(f.room.supplyDispatch.view(truck).reason, 'waiting-stock');
});

test('small expenditure does not start a new trip and moving or lost allies are not chased', t => {
  const f = field(t), [truck] = f.suppliers; f.out();
  f.set(f.part(f.target, 'fuel'), { fuelLitres: reserveState(f.world.actor(f.target).blueprint.modules.find(piece => piece.kind === 'fuel')).fuelLitres - 3 });
  f.start(); f.run(3); assert.equal(f.room.supplyDispatch.jobs.has(truck), false);
  f.demand(); assert(f.until(() => f.phase(truck) === 'deliver', 5));
  f.order('move', { ids: [f.target], x: f.faction.base.x + 600 }); f.run(2);
  assert(['return', 'idle'].includes(f.phase(truck))); assert.equal(f.room.supplyDispatch.view(truck).reason, 'target-moving');
  assert(![...f.room.supplyDispatch.jobs.values()].some(job => job.phase === 'deliver' && job.targetId === f.target));
});

test('a confirmed physical stall ends the dispatch and never gets automatically reordered after its cooldown', t => {
  const f = field(t), [truck] = f.suppliers; f.out(); f.demand(); f.start();
  assert(f.until(() => f.phase(truck) === 'deliver', 5));
  // This is Squad's result after its progress timeout, not a prediction from slope or cargo.
  const unit = f.player.squad.units.get(truck); unit.move = null; unit.halt = unit.reason = 'stuck-slope';
  f.run(35);
  assert.equal(f.room.supplyDispatch.jobs.has(truck), false); assert.equal(unit.move, null);
  assert.equal(f.room.supplyDispatch.view(truck).reason, 'stuck-slope');
  f.enable(truck); assert.equal(unit.halt, '', 'an explicit reactivation allows a new attempt');
  assert(f.until(() => f.phase(truck) === 'deliver', 5));
});

test('destroyed drive equipment pauses dispatch as immobile instead of inventing a terrain refusal', t => {
  const f = field(t), [truck] = f.suppliers; f.out(); f.demand(); f.start();
  assert(f.until(() => f.phase(truck) === 'deliver' && !f.room.atBase(f.faction, f.world.actor(truck)), 30));
  const before = resources(f);
  f.set(f.part(truck, 'engine'), { health: 0 }); f.run(3);
  assert.equal(f.room.supplyDispatch.jobs.has(truck), false);
  assert.equal(f.room.supplyDispatch.view(truck).reason, 'immobile');
  assert.equal(f.room.record(f.world.actor(truck)).auto, true);
  assert.equal(resources(f).iron, before.iron, 'cancelling preserves the paid supply cargo');
  f.enable(truck); f.run(3);
  assert.equal(f.room.supplyDispatch.jobs.has(truck), false, 'reactivation cannot repair a destroyed engine');
  assert.equal(f.room.supplyDispatch.view(truck).reason, 'immobile');
});

test('a collection leg ending away from the base reports an actual blocked way', t => {
  const f = field(t), [truck] = f.suppliers; f.out(); f.deploy(truck, f.faction.base.x + 150); f.demand(); f.start();
  assert(f.until(() => f.phase(truck) === 'collect', 5));
  const unit = f.player.squad.units.get(truck); unit.move = null;
  f.run(2);
  assert.equal(f.room.supplyDispatch.jobs.has(truck), false);
  assert.equal(f.room.supplyDispatch.view(truck).reason, 'blocked-way');
});

test('an empty opted-in supplier outside its base returns after a checkpoint loses its transient job', t => {
  const f = field(t), [truck] = f.suppliers; f.out(); f.demand(); f.start();
  assert(f.until(() => f.phase(truck) === 'return' && billTotal(f.stock(truck)) === 0, 100));
  // Portable saves intentionally do not serialize the scheduler. Stop its old
  // leg at this checkpoint too, to cover a restored idle chassis with no cargo.
  f.room.supplyDispatch.cancel(truck);
  const kept = JSON.parse(JSON.stringify(f.room.keep())), again = rehearsal([12, 20000], undefined, { kept });
  t.after(() => again.world.dispose());
  const restored = again.world.actor(truck), player = again.players.get(f.player.id), faction = again.faction(player);
  assert.equal(again.record(restored).auto, true); assert.equal(again.supplyDispatch.jobs.size, 0);
  assert(!again.atBase(faction, restored)); assert.equal(player.squad.units.get(truck).move, null);
  for (let i = 0; i < 100 * 60 && !(again.atBase(faction, again.world.actor(truck)) && again.still(again.world.actor(truck))); i++) again.step();
  assert(again.atBase(faction, again.world.actor(truck)) && again.still(again.world.actor(truck)), 'the empty vehicle really drove back after restoration');
  assert.equal(again.record(again.world.actor(truck)).auto, true);
});

test('a dry supplier without fuel for returning does not depart or fabricate fuel from a base quote', t => {
  const f = field(t), [truck] = f.suppliers; f.out(); f.demand();
  f.start(); f.set(f.part(truck, 'fuel'), { fuelLitres: 0 }); Object.assign(f.faction.stock, bill(10000)); f.run(3);
  assert.equal(f.room.supplyDispatch.jobs.has(truck), false); assert.equal(f.player.squad.units.get(truck).move, null);
  assert.equal(f.part(truck, 'fuel').fuelLitres, 0); assert.equal(f.faction.stock.combustivel, 0);
  assert.equal(f.room.supplyDispatch.view(truck).reason, 'waiting-fuel');
});
