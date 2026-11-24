import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { AGING } from '../server/supply-dispatch.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { CALM_SECONDS, STOCK_IDS, SUPPLIED, bill, billTotal, carriedBy, fieldParts, stow, supplied } from '../src/economy.ts';
import { onField } from './helpers/field.js';
import { MODULES } from '../src/materials.ts';
import { CELL } from '../src/grid.ts';
import { reserveState } from '../src/component-volume.ts';
import { nativeFuelFlow } from '../src/native-dynamics.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { RETURN_FIRE_SECONDS, SCARE_HOLD } from '../src/squad.ts';

// The jobs of a faction given out to its vehicles in automatic (server/supply-dispatch.ts): every vehicle drives there by its
// squad, as any vehicle drives, and the room loads, unloads and builds at its own pace. On a rehearsed field a works stands, and
// a structure is taken down, the moment a builder stands beside it with all its material there.
const bases = [-213, 30000];
// The constructor of the templates without its supply pieces: a builder that carries nothing.
const bare = () => { const truck = createStructuredTemplate('construction-truck'); return { ...truck, components: truck.components.filter(part => part.kind !== 'supply') }; };

function setup(t) {
  const room = rehearsal(bases, bill(1e6, 1e6, 1e6, 1e5), { fog: false }), f = onField(t, room), player = room.join('Logística'), world = room.world,
    faction = room.faction(room.players.get(player.playerId)), dispatch = room.supplyDispatch;
  const x = id => room.position(world.actor(id)), carried = id => supplied(carriedBy(room.serving(id)).carried),
    // A vehicle of a template or a design, in the base, as it comes: in automatic when it has supply pieces or a builder.
    vehicle = design => { const id = f.publish(player, design); f.run(.5); return id; },
    // A works of the guard post where it may stand, `from` metres off the base or further, with nothing of it come yet.
    work = from => f.open(player, 'guard-post', { x: f.site(player, 'guard-post', { from }) }),
    // A heap where a works was given up with a share of its material come, `from` metres off the base or further.
    heap = (from, share = .1) => {
      const id = work(from), opened = room.works.pending.get(id);
      for (const material of STOCK_IDS) { const some = opened.cost[material] * share; faction.stock[material] -= some; opened.delivered[material] = some; }
      f.send(player, 'cancel-work', { workId: id });
      return id;
    },
    // A scout out of the base, stopped, with no rounds and its tank all but dry.
    low = from => {
      const id = vehicle('scout'), goal = faction.base.x + from;
      f.order(player, 'move', { ids: [id], x: goal });
      assert(f.until(() => !room.players.get(player.playerId).squad.units.get(id).move && Math.abs(x(id) - goal) < 3 && room.still(world.actor(id)), 100), 'the scout drove out');
      for (const piece of f.parts(id, 'ammo')) f.set(piece, { rounds: 0 });
      for (const piece of f.parts(id, 'fuel')) f.set(piece, { fuelLitres: 1 });
      return id;
    };
  return { ...f, room, world, player, faction, dispatch, x, carried, vehicle, work, heap, low,
    job: id => dispatch.jobs.get(id) ?? null, atBase: id => room.atBase(faction, world.actor(id)),
    off: id => f.send(player, 'auto', { actorId: id, on: false }), on: id => f.send(player, 'auto', { actorId: id, on: true }) };
}

// A funded last delivery, authored in progress: every earlier material unit came from the real stock, and the last
// fuel is physically loaded into the carrier. This isolates service order; it is not a claim of a completed journey.
function lastFuelDelivery(t, { model, missing, from = 300, standBack = 12 }) {
  const f = setup(t), carrier = f.vehicle(model);
  f.off(carrier); f.room.building = true;
  const id = f.open(f.player, 'oil-well', { x: f.site(f.player, 'oil-well', { from }) }), work = f.room.works.pending.get(id);
  f.put(carrier, work.x - standBack);
  assert(work.cost.combustivel > missing);
  Object.assign(work.delivered, work.cost, { combustivel: work.cost.combustivel - missing });
  for (const material of STOCK_IDS) f.faction.stock[material] -= work.delivered[material];
  work.progress = f.room.works.share(work);
  const put = stow(f.room.serving(carrier), 'petroleo', missing);
  assert.equal(put.moved, missing, 'the real supply pieces take the funded last fuel');
  f.room.carry(put.changed); f.faction.stock.combustivel -= put.moved; f.world.command('sync');
  const totalFuel = () => f.faction.stock.combustivel
    + f.world.modules.reduce((sum, piece) => sum + (piece.kind === 'fuel' ? piece.fuelLitres : piece.kind === 'supply' ? piece.cargo?.petroleo ?? 0 : 0), 0)
    + [...f.room.works.pending.values()].reduce((sum, pending) => sum + pending.delivered.combustivel, 0);
  return { ...f, carrier, work, totalFuel };
}

test('a funded last works delivery is not spent topping up a builder that can finish its job and return', t => {
  const f = lastFuelDelivery(t, { model: 'construction-truck', missing: 8 }), { room, world, dispatch, carrier, work } = f,
    actor = world.actor(carrier), tank = f.parts(carrier, 'fuel')[0];
  f.set(tank, { fuelLitres: dispatch.tanks(actor) - 5 });
  f.on(carrier); dispatch.step();
  assert.equal(f.job(carrier).phase, 'go', 'protection starts before the first work phase');
  const held = f.parts(carrier, 'fuel')[0].fuelLitres, before = f.totalFuel(), stock = { ...f.faction.stock },
    published = room.units(f.faction, fieldParts(world)).find(unit => unit.id === carrier);
  assert.equal(published.point.resupply.combustivel, 0, 'the automatic quote does not offer the committed last fuel');
  assert.equal(published.point.stock.combustivel, 0);
  assert.equal(published.supplies.combustivel, 8, 'the allowance changes no physical cargo');
  room.serve();
  assert.equal(f.carried(carrier).combustivel, 8, 'a nearly full tank leaves the funded last delivery in its box');
  assert.equal(f.parts(carrier, 'fuel')[0].fuelLitres, held);
  assert.deepEqual(f.faction.stock, stock);
  assert(Math.abs(f.totalFuel() - before) <= 1e-6, 'service alone creates and consumes no fuel');
  const started = world.time, powerKw = dispatch.drive(world.actor(carrier)).powerKw,
    fullFlow = nativeFuelFlow(powerKw, powerKw);
  assert(f.until(() => world.actor(work.id), work.seconds + 20), 'the ordinary transfer and builder complete the last delivery without another collection');
  assert(!room.works.pending.has(work.id));
  world.command('sync'); // Read final native quantities after completion; no extra simulation step.
  const made = world.actor(work.id), installedFuel = made.blueprint.modules
    .reduce((sum, piece) => sum + (piece.kind === 'fuel' ? reserveState(piece).fuelLitres : 0), 0),
    billRounding = work.cost.combustivel - installedFuel;
  assert(billRounding >= -1e-6 && billRounding < 1 + 1e-6, 'one oil-well tank has only the declared upward whole-unit bill rounding');
  // totalFuel includes the finished structure's real tanks after the pending work is removed. Native has two fuel
  // consumption paths (drive and tools); even both at full installed power cannot exceed this interval's stated bound.
  const fuelSpent = before - f.totalFuel() - billRounding,
    maxFuelSpent = 2 * fullFlow * (world.time - started) / 3600;
  assert(fuelSpent >= -1e-6 && fuelSpent <= maxFuelSpent + 1e-6,
    `fuel balance: spent ${fuelSpent}, engine bound ${maxFuelSpent}, bill rounding ${billRounding}, interval ${world.time - started}s`);
});

test('a dry works carrier takes physical fuel for the remaining job and a manual Stop releases the remaining cargo', t => {
  const f = lastFuelDelivery(t, { model: 'supply', missing: 40, from: 600, standBack: 200 }), { room, world, dispatch, carrier, work } = f,
    actor = world.actor(carrier), pieces = f.parts(carrier, 'fuel'),
    demand = { kind: 'work', id: work.id, x: work.x, work }, man = dispatch.crewman(actor), offer = dispatch.offer(man, demand, f.faction);
  assert.equal(offer.phase, 'deliver', 'the ordinary direct delivery starts before it runs dry');
  f.on(carrier); dispatch.start(man, demand, offer, f.faction);
  for (const tank of pieces) f.set(tank, { fuelLitres: 0 });
  const before = f.totalFuel(), stock = { ...f.faction.stock },
    published = room.units(f.faction, fieldParts(world)).find(unit => unit.id === carrier);
  assert(published.point.resupply.combustivel > 0 && published.point.resupply.combustivel < 40, 'the quote offers only the required operating fuel');
  room.serve();
  const filled = world.actor(carrier).vehicle.fuelLitres, left = f.carried(carrier).combustivel;
  assert(Math.abs(filled - published.point.resupply.combustivel) <= 1e-6, 'the quoted own allowance is the one physically paid');
  assert(filled > 0 && filled < dispatch.tanks(world.actor(carrier)), 'the dry carrier receives its operating fuel without demanding a full design tank');
  assert(left > 0 && left < 40, 'the paid remainder stays aboard for the works');
  assert(Math.abs(filled + left - 40) <= 1e-6);
  assert.deepEqual(f.faction.stock, stock, 'the distant base quote does not pay for this rescue');
  assert(Math.abs(f.totalFuel() - before) <= 1e-6, 'the rescue moved existing physical fuel');
  f.order(f.player, 'stop', { ids: [carrier] });
  assert.equal(f.job(carrier), null);
  room.serve();
  assert.equal(f.carried(carrier).combustivel, 0, 'with no committed automatic job the existing self-refill remains available');
  assert(world.actor(carrier).vehicle.fuelLitres > filled);
  assert(Math.abs(f.totalFuel() - before) <= 1e-6, 'manual cancellation changes no paid material or fuel total');
});
// Two builders at a mining site, or a grader at work by a builder, filled their tanks out of the fuel the other brought for
// the works: it came a few litres short, and one went back to the base for them while the other waited, empty.
test('a vehicle beside a builder fills its tank from what that carries beyond what its works lacks, never from that', t => {
  const f = setup(t), { room, world, dispatch } = f, carrier = f.vehicle('construction-truck'), other = f.vehicle('scout');
  f.off(carrier); room.building = true;
  const id = f.open(f.player, 'oil-well', { x: f.site(f.player, 'oil-well', { from: 300 }) }), work = room.works.pending.get(id);
  // The scout stands beside the builder, a few metres off it end to end, where what that carries reaches it (`SUPPLY_REACH`).
  f.put(carrier, work.x - 12); f.put(other, work.x - 22);
  Object.assign(work.delivered, work.cost, { combustivel: work.cost.combustivel - 8 });
  for (const material of STOCK_IDS) f.faction.stock[material] -= work.delivered[material];
  work.progress = room.works.share(work);
  const put = stow(room.serving(carrier), 'petroleo', 13);
  assert.equal(put.moved, 13);
  room.carry(put.changed); f.faction.stock.combustivel -= put.moved;
  for (const tank of f.parts(other, 'fuel')) f.set(tank, { fuelLitres: 1 });
  world.command('sync');
  f.on(carrier); dispatch.step();
  assert.equal(f.job(carrier).kind, 'build');
  room.serve();
  assert.equal(f.carried(carrier).combustivel, 8, 'what the works lacks stays aboard for it');
  assert(Math.abs(world.actor(other).vehicle.fuelLitres - 6) < 1e-6, `the rest fills the scout: ${world.actor(other).vehicle.fuelLitres} L`);
});

// The real dismantle-to-build handoff: while loading its old structure, a builder still has a dismantle job whose
// future work is then. No new build job exists yet. Its tank is short of full but ample for this local operation.
function relocatedFuel(t) {
  const f = setup(t), carrier = f.vehicle('construction-truck');
  f.off(carrier);
  const source = f.raise(f.player, 'oil-well', { x: f.site(f.player, 'oil-well', { from: 300 }) }), from = f.x(source),
    to = f.site(f.player, 'oil-well', { from: Math.abs(from - f.faction.base.x) + 40, ignore: source });
  f.put(carrier, from + 12);
  const actor = f.world.actor(carrier);
  f.set(f.parts(carrier, 'fuel')[0], { fuelLitres: f.dispatch.tanks(actor) - 7 });
  f.room.building = true; f.on(carrier);
  const workId = f.send(f.player, 'relocate', { actorId: source, x: to, facing: 1 }).work.id,
    work = f.room.works.pending.get(workId);
  assert(f.until(() => !f.world.actor(source), 90), 'the normal builder finishes the real source dismantle');
  assert.equal(f.job(carrier).kind, 'dismantle');
  assert.equal(f.job(carrier).then, workId);
  const fuel = f.world.actor(carrier).vehicle.fuelLitres;
  assert(f.until(() => f.job(carrier)?.phase === 'load' && f.carried(carrier).combustivel >= 20, 20), 'the same job gathers real salvage before its build handoff');
  return { ...f, carrier, source, work, fuel };
}

test('a builder loading its dismantled structure preserves fuel for the linked reconstruction', t => {
  const f = relocatedFuel(t), { room, world, carrier, work } = f,
    actor = world.actor(carrier), before = f.carried(carrier).combustivel,
    published = room.units(f.faction, fieldParts(world)).find(unit => unit.id === carrier);
  assert(actor.vehicle.fuelLitres <= f.fuel + 1e-6, 'loading does not top up an already operational tank from the reconstruction fuel');
  assert.equal(published.point.resupply.combustivel, 0, 'the load-phase quote protects the same fuel as the future build');
  room.serve();
  assert.equal(f.carried(carrier).combustivel, before, 'the quoted restriction is also used by the real service pass');
  let collected = false;
  assert(f.until(() => {
    collected ||= f.job(carrier)?.phase === 'collect';
    return world.actor(work.id);
  }, 180), 'salvage supplies the linked reconstruction');
  assert.equal(collected, false, 'an ample own tank needs no extra trip for the fuel recovered from the old structure');
});

test('a dry builder loading salvage gets only operating fuel and Stop releases the remaining load', t => {
  const f = relocatedFuel(t), { room, world, carrier } = f;
  f.set(f.parts(carrier, 'fuel')[0], { fuelLitres: 0 });
  const before = f.carried(carrier).combustivel,
    published = room.units(f.faction, fieldParts(world)).find(unit => unit.id === carrier);
  assert(published.point.resupply.combustivel > 0 && published.point.stock.combustivel < Math.floor(before), 'a dry load-phase builder may use the bounded future-build budget');
  room.serve();
  const gain = world.actor(carrier).vehicle.fuelLitres, left = f.carried(carrier).combustivel;
  assert(Math.abs(gain - published.point.resupply.combustivel) <= 1e-6, 'quote and paid physical refill agree');
  assert(Math.abs(gain + left - before) <= 1e-6, 'only existing salvage fuel moved');
  const released = left;
  f.order(f.player, 'stop', { ids: [carrier] });
  room.serve();
  assert(Math.abs(f.carried(carrier).combustivel) <= 1e-6, 'Stop releases the remaining fuel, including the fraction of a litre');
  assert(Math.abs(world.actor(carrier).vehicle.fuelLitres - gain - released) <= 1e-6);
});

test('of two jobs of the same weight, the nearer is done first', t => {
  const f = setup(t), { room } = f, truck = f.vehicle('supply'), far = f.work(700), near = f.work(220), targets = [];
  assert(Math.abs(room.works.pending.get(near).x - f.faction.base.x) < Math.abs(room.works.pending.get(far).x - f.faction.base.x));
  assert(f.until(() => { const to = f.job(truck)?.targetId; if (to && to !== targets.at(-1)) targets.push(to); return to === far; }, 400), 'it goes to the far one in the end');
  assert.equal(targets[0], near, 'the near one first');
  assert.deepEqual(room.supplyDispatch.wanted(room.works.pending.get(near)), bill(), 'and only once that one lacks nothing');
});

test('a builder and a supply truck each do what only it can, with no dispute over the works', t => {
  const f = setup(t), { room, world } = f, builder = f.vehicle(bare()), truck = f.vehicle('supply'), id = f.work(300), cost = { ...room.works.pending.get(id).cost },
    before = { ...f.faction.stock };
  let truckJobs = new Set(), builderJobs = new Set();
  assert(f.until(() => {
    truckJobs.add(f.job(truck)?.kind ?? null); builderJobs.add(f.job(builder)?.kind ?? null);
    return world.actor(id);
  }, 300), 'the works stands');
  assert.deepEqual([...builderJobs].filter(Boolean), ['build'], 'the builder only builds');
  assert.deepEqual([...truckJobs].filter(Boolean), ['work'], 'the truck only brings its material');
  // Fuel goes out of the stocks for the way too: of the rest, just what the works cost.
  for (const material of STOCK_IDS.filter(material => material !== 'combustivel')) {
    const taken = before[material] - f.faction.stock[material] - f.carried(truck)[material];
    assert(Math.abs(taken - cost[material]) <= 1, `${material}: the stocks gave what the works cost, ${taken} of ${cost[material]}`);
  }
});

test('a constructor in automatic is never filled at the base, and one sent to put up a works takes from the base only what that works asks', t => {
  const f = setup(t), { room, world, dispatch } = f, constructor = f.vehicle('construction-truck');
  f.run(3);
  assert.deepEqual([f.carried(constructor), f.job(constructor), room.factionView(f.player.playerId).units.find(u => u.id === constructor).load], [bill(), null, null],
    'in its base with nothing to do it carries nothing, and is to take nothing on there');
  const id = f.work(300), cost = { ...room.works.pending.get(id).cost };
  assert(f.until(() => f.job(constructor)?.phase === 'go', 5), 'it loads at the base and goes');
  const aboard = f.carried(constructor);
  for (const material of STOCK_IDS) assert(aboard[material] <= cost[material] + 1e-6, `${material}: ${aboard[material]} aboard, no more than the works asks (${cost[material]})`);
  assert(billTotal(aboard) > 0 && aboard.ligas === 0 && aboard.combustivel === 0, 'what the works asks of, and nothing else');
  assert(f.until(() => f.job(constructor)?.phase === 'work', 200), 'it stands beside the works');
  const job = f.job(constructor), nextAt = dispatch.nextAt;
  // Assembly and delivery continue while the next dispatch look is still in the future.
  dispatch.nextAt = world.time + 200;
  assert(f.until(() => world.actor(id), 200), 'it puts it up with what it brought');
  assert(dispatch.nextAt > world.time && !room.works.pending.has(id));
  const completed = room.factionView(f.player.playerId).units.find(u => u.id === constructor);
  assert.deepEqual([completed.builder.working, completed.job], [null, { kind: null, phase: 'idle', targetId: null, reason: '' }],
    'the first reading after completion cannot say it is waiting for material for the completed structure');
  assert.strictEqual(f.job(constructor), job, 'reading the job does not retire it or advance the dispatch');
  dispatch.nextAt = nextAt;
  f.run(3); const stood = f.x(constructor); f.run(5);
  assert(Math.abs(f.x(constructor) - stood) < .5 && !f.atBase(constructor) && f.job(constructor) === null, 'with nothing aboard and nothing to do, it stays where it is');
});

test('a constructor by a works that lacks what nothing brings goes for it itself, and comes back to put it up', t => {
  const f = setup(t), { room, world, dispatch } = f, constructor = f.vehicle('construction-truck');
  // On a field that takes its time to put works up, half of one comes the moment it is put back in automatic beside it.
  room.building = true;
  const id = f.work(300), work = room.works.pending.get(id);
  f.off(constructor); f.put(constructor, work.x - 12);
  for (const material of STOCK_IDS) work.delivered[material] = work.cost[material] / 2;
  f.on(constructor);
  const kinds = [], track = () => { const kind = f.job(constructor)?.kind ?? null; if (kind !== kinds.at(-1)) kinds.push(kind); };
  const parkingAt = world.time;
  // Its rear crane first parks on the other side, about18 m from this cold start.
  assert(f.until(() => { track(); return f.job(constructor)?.phase === 'work'; }, 10), 'it parks by its real crane and starts building');
  t.diagnostic(JSON.stringify({ parkingSeconds: world.time - parkingAt, parkedX: f.x(constructor), workX: work.x }));
  const nextAt = dispatch.nextAt;
  dispatch.nextAt = world.time + 120;
  assert(f.until(() => { track(); return work.progress >= .5 - 1e-6; }, 120), 'it puts up what is there');
  const waiting = room.factionView(f.player.playerId).units.find(u => u.id === constructor);
  assert(!world.actor(id) && room.works.pending.has(id) && billTotal(room.works.need(work)) > 0);
  assert.deepEqual(waiting.job, { kind: 'build', phase: 'work', targetId: id, reason: '' }, 'a pending works really waiting for material keeps its job');
  dispatch.nextAt = nextAt;
  assert(f.until(() => { track(); return world.actor(id); }, 300), 'the works stands');
  assert.deepEqual(kinds.filter(Boolean), ['build', 'work'], 'it brings the rest from the base and puts it up as it unloads it, from beside it');
});

// A scout out of the base, stopped, its engine at half its health.
function hurt(f, from) {
  const id = f.vehicle('scout'), squad = f.room.players.get(f.player.playerId).squad, goal = f.faction.base.x + from;
  f.order(f.player, 'move', { ids: [id], x: goal });
  assert(f.until(() => !squad.units.get(id).move && f.room.still(f.world.actor(id)), 100), 'the scout drove out');
  const engine = f.parts(id, 'engine')[0];
  f.set(engine, { health: engine.maxHealth / 2 });
  return () => f.parts(id, 'engine')[0].health === engine.maxHealth;
}

test('one trip from the base to rearm takes along the repair of that vehicle and of another near it, and rearms first: the material of a works there waits for a trip of its own', t => {
  const f = setup(t), { room, dispatch } = f, truck = f.vehicle('supply');
  f.off(truck);
  const low = f.low(700), engine = () => f.parts(low, 'engine')[0];
  f.set(engine(), { health: engine().maxHealth / 2 });
  const mended = hurt(f, 760), id = f.work(650), work = room.works.pending.get(id);
  f.run(CALM_SECONDS + 1);
  const loads = t.mock.method(dispatch, 'stow');
  f.on(truck);
  let armedAt = null;
  const armed = () => f.parts(low, 'ammo').every(piece => piece.rounds > 0), whole = () => engine().health === engine().maxHealth;
  assert(f.until(() => { if (armedAt === null && armed()) { armedAt = f.world.time; assert(!whole(), 'rearmed before it is mended'); } return whole() && mended(); }, 600),
    'both are rearmed and mended');
  assert.equal(loads.mock.callCount(), 1, 'from one load at the base');
  assert(!STOCK_IDS.some(stock => work.delivered[stock] > 0), 'the works got nothing of that load');
});

test('one trip from the base for a works takes along a repair and the material of another works near its way', t => {
  const f = setup(t), { room, dispatch } = f, truck = f.vehicle('supply');
  f.off(truck);
  const mended = hurt(f, 670), far = room.works.pending.get(f.work(600)), near = room.works.pending.get(f.work(350));
  // Each lacks a tenth of what it costs, so that a load takes all of both and the repair.
  for (const work of [far, near]) for (const material of STOCK_IDS) {
    const some = work.cost[material] * .9; f.faction.stock[material] -= some; work.delivered[material] = some;
  }
  f.run(CALM_SECONDS + 1);
  assert(near.x < far.x, 'the one works nearer the base than the other');
  const full = work => STOCK_IDS.every(stock => work.delivered[stock] >= work.cost[stock] - 1e-6);
  const loads = t.mock.method(dispatch, 'stow');
  f.on(truck);
  assert(f.until(() => full(near) && full(far) && mended(), 600), 'all three are served');
  assert.equal(loads.mock.callCount(), 1, 'from one load at the base');
});

test('a works has a place on each side: one more that brings it material waits outside, out of its reach, and goes in once one is free; none stands on another', t => {
  const f = setup(t), { room, world, dispatch } = f, trucks = [0, 1, 2, 3].map(() => f.vehicle('construction-truck')),
    id = f.open(f.player, 'bunker', { x: f.site(f.player, 'bunker', { from: 400 }) }), span = room.works.span(room.works.pending.get(id)),
    length = truck => { const hull = room.works.hull(world.actor(truck)); return hull.maxX - hull.minX; };
  let waited = false, stacked = '', far = '';
  assert(f.until(() => {
    const beside = trucks.filter(truck => room.works.beside(world.actor(truck), span) && room.still(world.actor(truck)));
    for (const a of beside) for (const b of beside)
      if (a < b && Math.abs(f.x(a) - f.x(b)) < (length(a) + length(b)) / 2) stacked ||= `${a} on ${b}`;
    waited ||= trucks.some(truck => dispatch.view(truck).reason === 'waiting-place' && !room.works.beside(world.actor(truck), span));
    // It says it waits for a place where it waits, not all the way there from the base.
    far ||= trucks.find(truck => dispatch.view(truck).reason === 'waiting-place' && Math.abs(f.x(truck) - (span.minX + span.maxX) / 2) > 100) ?? '';
    return !room.works.pending.has(id);
  }, 900), 'the works stands');
  assert(waited, 'one waited outside for a place');
  assert.equal(far, '', 'none said so on its way there');
  assert.equal(stacked, '', 'none stood on another beside it');
});

test('a works a constructor brings the material of, with nothing to put up till that comes, is put up by that one: no other builder is sent there to wait', t => {
  const f = setup(t), { room, world, dispatch } = f, constructor = f.vehicle('construction-truck'), builder = f.vehicle(bare());
  f.off(constructor); f.off(builder);
  const id = f.work(300), work = room.works.pending.get(id), card = () => room.factionView(f.player.playerId).works.find(w => w.id === id);
  f.put(builder, f.faction.base.x - Math.sign(work.x - f.faction.base.x) * 600);
  // The constructor is sent from the base with all the works lacks, as for any works.
  f.on(constructor);
  const man = dispatch.crewman(world.actor(constructor)), demand = { kind: 'work', id, x: work.x, work };
  dispatch.start(man, demand, dispatch.offer(man, demand, f.faction), f.faction, fieldParts(world));
  assert.equal(f.job(constructor)?.kind, 'work');
  f.on(builder); f.run(1.5);
  assert.deepEqual(card().sent, { phase: 'go', reason: '' }, 'its card says a builder is on its way');
  const sent = new Set();
  assert(f.until(() => { sent.add(f.job(builder)?.kind ?? null); return world.actor(id); }, 120), 'the works stands');
  assert.deepEqual([...sent].filter(Boolean), [], 'the other builder was sent nowhere');
});

// A constructor by a works with half of its iron and silica come and nothing more to put up till more comes, and a truck
// further on sent to it with what it lacks of the stocks it `brings`.
function awaited(t, brings) {
  const f = setup(t), { room, dispatch } = f, constructor = f.vehicle('construction-truck'), truck = f.vehicle('supply');
  room.building = true;
  const id = f.work(300), work = room.works.pending.get(id);
  f.off(constructor); f.off(truck); f.put(constructor, work.x - 12); f.put(truck, work.x + 200);
  Object.assign(work.delivered, { ...work.cost, ferro: work.cost.ferro / 2, silica: work.cost.silica / 2 });
  work.progress = room.works.share(work);
  // What it was filled with at the base goes back to the stocks: it carries just that.
  const need = room.works.need(work), filled = f.carried(truck),
    load = bill(...STOCK_IDS.map(material => brings.includes(material) ? need[material] : 0));
  for (const material of STOCK_IDS) {
    room.carry(stow(room.serving(truck), SUPPLIED[material], load[material] - filled[material]).changed);
    f.faction.stock[material] += filled[material] - load[material];
  }
  f.world.command('sync');
  assert.deepEqual(f.carried(truck), load);
  f.on(truck);
  const man = dispatch.crewman(f.world.actor(truck)), demand = { kind: 'work', id, x: work.x, work }, offer = dispatch.offer(man, demand, f.faction);
  assert.equal(offer.phase, 'deliver', 'the truck goes straight there with what it carries');
  dispatch.start(man, demand, offer, f.faction);
  f.on(constructor);
  return { ...f, constructor, truck, id, work };
}

test('a constructor by a works waits for what is on its way there, saying so, but goes itself for what nothing brings', t => {
  // The truck brings iron, and nothing brings the silica: the constructor goes for that at once, not to wait for the truck first.
  let f = awaited(t, ['ferro']);
  f.dispatch.step();
  assert.equal(f.job(f.constructor)?.kind, 'work', 'it goes for what nothing brings');
  assert(f.job(f.constructor).reserved.silica > 0 && f.job(f.constructor).reserved.ferro === 0, 'the silica, and none of the iron on its way');
  // The truck brings all it lacks: the constructor waits beside it, and says what it waits for.
  f = awaited(t, ['ferro', 'silica']);
  assert(f.until(() => f.job(f.constructor)?.phase === 'work', 15), 'it is sent to put it up and waits beside it');
  f.run(1.5);
  assert.deepEqual(f.room.factionView(f.player.playerId).units.find(u => u.id === f.constructor).job,
    { kind: 'build', phase: 'work', targetId: f.id, reason: 'waiting-material' });
  assert(f.until(() => f.world.actor(f.id), 120), 'and puts it up once the truck unloads it');
});

test('a constructor given nothing to do says why, and of what: the job nearest it that it could not take', t => {
  const f = setup(t), { room, dispatch } = f, constructor = f.vehicle('construction-truck');
  room.building = true;
  const id = f.work(300), work = room.works.pending.get(id);
  f.off(constructor); f.put(constructor, work.x - 12);
  Object.assign(work.delivered, { ...work.cost, silica: work.cost.silica / 2 });
  work.progress = room.works.share(work);
  f.faction.stock.silica = 0;
  f.on(constructor); dispatch.step();
  assert.equal(f.job(constructor), null);
  assert.deepEqual(room.factionView(f.player.playerId).units.find(u => u.id === constructor).job,
    { kind: null, phase: 'idle', targetId: id, reason: 'waiting-stock' }, 'the stocks lack what the works beside it does');
});

test('a supply truck with no room for a unit of what a works lacks, while the stocks have it, says so: not that the stocks lack it', t => {
  const f = setup(t), { room, dispatch } = f, truck = f.vehicle('supply'), id = f.work(300);
  t.mock.method(dispatch, 'capacity', () => ({ volume: 1e-6, mass: Infinity }));
  f.run(3);
  assert.equal(f.job(truck), null);
  assert.deepEqual(room.factionView(f.player.playerId).units.find(u => u.id === truck).job,
    { kind: null, phase: 'idle', targetId: id, reason: 'no-room' });
});

test('a vehicle that is done goes on to the next job from where it stands, without the base when that job needs nothing there', t => {
  const f = setup(t), { room } = f, first = f.heap(250), second = f.heap(520), truck = f.vehicle('supply'),
    a = room.works.heaps.get(first).x, b = room.works.heaps.get(second).x;
  assert(Math.sign(a - f.faction.base.x) === Math.sign(b - f.faction.base.x), 'both on the same side of the base');
  assert(f.until(() => f.job(truck)?.phase === 'fetch', 10));
  assert.equal(f.job(truck).targetId, first, 'the nearer heap first');
  let home = false;
  assert(f.until(() => { home ||= !room.works.heaps.has(first) && f.atBase(truck); return f.job(truck)?.targetId === second; }, 200), 'then on to the other one');
  assert(!room.works.heaps.has(first) && !home, 'straight from the first, without going by the base');
  assert(f.until(() => !room.works.heaps.size && f.atBase(truck) && !billTotal(f.carried(truck)), 300), 'both home in the end');
});

// A casemate that fired all it had at an enemy that kept hitting it was never out of combat, so nothing was sent to it, and the
// constructor by the base said only that it had nothing to do.
test('a casemate out of rounds that keeps being hit is rearmed where it stands, by a constructor as by a supply truck', t => {
  const f = setup(t), { room, world } = f, post = f.raise(f.player, 'guard-post', { x: f.site(f.player, 'guard-post', { from: 300 }) }),
    constructor = f.vehicle('construction-truck'), rounds = () => f.parts(post, 'ammo').reduce((sum, piece) => sum + piece.rounds, 0), full = rounds();
  for (const piece of f.parts(post, 'ammo')) f.set(piece, { rounds: 0 });
  world.command('sync');
  const kinds = new Set();
  assert(f.until(() => {
    room.record(world.actor(post)).combatAt = world.time;
    kinds.add(f.job(constructor)?.kind ?? null);
    return rounds() === full;
  }, 90), 'it is brought its rounds while it is hit');
  assert(kinds.has('rearm'), 'by the constructor, which has a crane and supply pieces both');
});

test('rearming a vehicle that runs low comes before taking a heap home, even a nearer one', t => {
  const f = setup(t), truck = f.vehicle('supply');
  f.off(truck);
  const pile = f.heap(200), scout = f.low(f.room.works.heaps.get(pile).x > f.faction.base.x ? -420 : 420);
  assert(Math.abs(f.room.works.heaps.get(pile).x - f.faction.base.x) < Math.abs(f.x(scout) - f.faction.base.x), 'the heap is the nearer');
  f.on(truck);
  assert(f.until(() => f.job(truck), 5));
  assert.deepEqual([f.job(truck).kind, f.job(truck).targetId], ['rearm', scout]);
  assert(f.until(() => f.job(truck)?.targetId === pile, 200), 'and the heap after');
});

test('a constructor, the one vehicle with supply pieces, rearms a vehicle that runs low before a works far off, and puts that up after', t => {
  const f = setup(t), constructor = f.vehicle('construction-truck');
  f.off(constructor);
  const scout = f.low(300), post = f.work(700);
  f.on(constructor);
  assert(f.until(() => f.job(constructor), 5));
  assert.deepEqual([f.job(constructor).kind, f.job(constructor).targetId], ['rearm', scout], 'the vehicle that runs low first');
  assert(f.until(() => f.job(constructor)?.targetId === post, 200), 'and the works after');
  assert(f.until(() => f.world.actor(post), 200), 'which stands');
});

test('a constructor rearms nobody a free supply truck rearms: each does what only it can', t => {
  const f = setup(t), constructor = f.vehicle('construction-truck'), truck = f.vehicle('supply');
  f.off(constructor); f.off(truck);
  const scout = f.low(300), post = f.work(700);
  f.on(constructor); f.on(truck);
  assert(f.until(() => f.job(constructor) && f.job(truck), 5));
  assert.deepEqual([f.job(truck).kind, f.job(truck).targetId], ['rearm', scout]);
  assert.deepEqual([f.job(constructor).kind, f.job(constructor).targetId], ['build', post]);
});

test('a constructor beside a works it can finish puts it up before a little repair far off, and does that after', t => {
  const f = setup(t), { room, world } = f, constructor = f.vehicle('construction-truck'), scout = f.vehicle('scout');
  room.building = true;
  f.off(constructor);
  const id = f.work(300), work = room.works.pending.get(id), side = Math.sign(work.x - f.faction.base.x);
  f.put(constructor, work.x - side * 12);
  Object.assign(work.delivered, work.cost); work.progress = .5;
  f.put(scout, f.faction.base.x - side * 1500);
  const engine = f.parts(scout, 'engine')[0];
  f.set(engine, { health: engine.maxHealth * .9 });
  f.on(constructor);
  assert(f.until(() => f.job(constructor), 5));
  assert.deepEqual([f.job(constructor).kind, f.job(constructor).targetId], ['build', id], 'the works it can finish');
  assert(f.until(() => world.actor(id), 60), 'which stands');
  assert(f.until(() => f.job(constructor)?.kind === 'repair', 10), 'and the repair after');
});

test('a road machine makes roads and nothing else: its supply pieces take no job of the others', t => {
  const design = createStructuredTemplate('paver'), compiled = compileBlueprint(design),
    floor = compiled.plates.find(plate => plate.id === 'conveyor:roof'), f = setup(t),
    // The real floor is above the frame profile; touch its upper face without snapping or an invisible gap.
    paver = f.vehicle({ ...design, components: [...design.components, { id: 'supply', kind: 'supply', sizeScale: .8,
      pose: { x: 15, y: (floor.y - compiled.frame.origin.y + floor.thicknessMm / 2000 + MODULES.supply.height * .8 / 2) / CELL, angle: 0 } }] });
  assert(f.room.serving(paver).length > 0, 'it carries supply pieces');
  const pile = f.heap(200), scout = f.low(f.room.works.heaps.get(pile).x > f.faction.base.x ? -420 : 420), kinds = new Set();
  f.until(() => { kinds.add(f.job(paver)?.kind ?? null); return false; }, 20);
  assert.deepEqual([...kinds].filter(Boolean), [], 'neither the vehicle that runs low nor the heap is its job');
  const truck = f.vehicle('supply');
  assert(f.until(() => f.job(truck), 5));
  assert.deepEqual([f.job(truck).kind, f.job(truck).targetId], ['rearm', scout], 'a supply truck takes them');
});

test('a job that has waited long enough goes before a nearer one that has not', t => {
  const f = setup(t), { room, faction, dispatch } = f, truck = f.vehicle('supply');
  f.off(truck);
  const old = f.heap(640), fresh = f.heap(200);
  assert(Math.abs(room.works.heaps.get(fresh).x - faction.base.x) < Math.abs(room.works.heaps.get(old).x - faction.base.x));
  // As if the far heap had waited three times `AGING` with nobody to take it home.
  dispatch.since.set(`heap:${old}`, { factionId: faction.id, at: room.world.time - 3 * AGING });
  f.on(truck);
  assert(f.until(() => f.job(truck), 5));
  assert.equal(f.job(truck).targetId, old, 'the one that waited goes first');
  assert(f.until(() => f.job(truck)?.targetId === fresh, 300), 'and the near one after');
});
test('a shared distant contact does not hold an automatic worker, but a nearby threat and recent combat do', t => {
  const room = rehearsal(bases, bill(1e6, 1e6, 1e6, 1e5), { fog: true }), f = onField(t, room), { world } = f,
    alice = room.join('Obras'), bob = room.join('Guarda'), owner = room.players.get(alice.playerId),
    faction = room.faction(owner), dispatch = room.supplyDispatch,
    worker = f.publish(alice, createStructuredTemplate('paver', { sensorModes: [] })),
    relay = f.publish(alice, 'recon'), guard = f.publish(bob, 'heavy');
  f.order(alice, 'control', { id: null }); f.order(bob, 'control', { id: null });
  f.order(alice, 'stance', { ids: [worker, relay], stance: 'hold' });
  f.order(bob, 'stance', { ids: [guard], stance: 'hold' });
  f.send(alice, 'auto', { actorId: worker, on: true });
  const actor = world.actor(worker), here = actor.vehicle.x, unit = owner.squad.units.get(worker),
    read = () => owner.squad.decide(owner.squad.side.member(world.actor(worker))),
    ready = () => dispatch.ready(world.actor(worker), faction, fieldParts(world));
  // Declared fixture placement: real Native sensors, shared contacts and the ordinary room pilots still run.
  // The worker keeps only its 650 m command optic; the Recon reads the guard from 30 m away.
  f.put(relay, here + 1970); f.put(guard, here + 2000);
  assert(!f.parts(worker, 'sensor').length);
  const far = read(), sight = world.game().call({ op: 'teamSight', frame: false }).sight[faction.id];
  assert(far.contact?.detected && far.contact.age < 1 && far.contact.x - actor.vehicle.x > 1900);
  assert(sight.some(contact => contact.actorId === guard && contact.by === relay && contact.age < 1), 'the measured contact really comes from the Recon');
  assert.equal(dispatch.safe(actor, owner), true, 'a guard shared from 2 km away must not pause the paver');
  assert.equal(unit.threat, false);
  assert(far.diagnostics.nearestFreshContactDistance > 1900);
  assert(ready(), 'a physically ready worker may take its next automatic job');

  // Keep a real observer 30 m from the guard for both positive-contact setups.
  f.put(relay, here + 720); f.put(guard, here + 750);
  const near = read();
  assert(near.contact?.detected && near.contact.age < 1);
  assert(near.diagnostics.nearestFreshContactDistance < 800);
  assert.equal(unit.threat, true); assert.equal(dispatch.safe(actor, owner), false);
  assert.equal(ready(), false); assert.equal(dispatch.waits.get(worker).reason, 'threat');
  f.put(relay, here + 1170); f.put(guard, here + 1200);
  const outside = read();
  assert(outside.contact?.detected && outside.contact.age < 1, 'the shared enemy remains known outside the work safety radius');
  assert.equal(unit.threat, false); assert.equal(dispatch.safe(actor, owner), true);
  assert(f.until(ready, 12), 'the existing finite retry expires after the threat leaves the radius');

  f.put(guard, here + 12000);
  const lost = read();
  assert(!lost.contact?.detected || lost.contact.age >= 1, 'no current sensor keeps this contact fresh');
  assert.equal(lost.diagnostics.nearestFreshContactDistance, null);
  assert.equal(unit.threat, false); assert(ready(), 'a lost contact cannot hold the worker indefinitely');
  unit.answerUntil = world.time + 1;
  assert.equal(dispatch.safe(actor, owner), false, 'the existing response-to-allied-hit hold remains independent of proximity');
  unit.answerUntil = -Infinity;

  const command = f.parts(worker, 'command')[0], beforeHit = world.time;
  f.set(command, { health: command.health - 1 }); f.run(.2); read();
  assert(room.record(actor).combatAt >= beforeHit && !room.calm(actor), 'a real Native health loss starts the ordinary combat cooldown');
  assert(unit.alertUntil > world.time, 'the squad still answers its own recent hit');
  assert.equal(dispatch.safe(actor, owner), false); assert.equal(ready(), false);
  assert(f.until(ready, RETURN_FIRE_SECONDS + 12), 'combat and the existing finite dispatch retry expire without a permanent safety wait');
  const shown = owner.squad.view().units.find(row => row.id === worker);
  assert(!('threat' in shown) && !('nearestFreshContactDistance' in shown), 'the proximity reading remains internal to automatic work');
});
test('an unarmed enemy in sight holds no automatic worker, and an armed one that never fires holds it for a minute in five', t => {
  const room = rehearsal(bases, bill(1e6, 1e6, 1e6, 1e5), { fog: true }), f = onField(t, room), { world } = f,
    alice = room.join('Obras'), bob = room.join('Visita'), owner = room.players.get(alice.playerId),
    faction = room.faction(owner), dispatch = room.supplyDispatch,
    worker = f.publish(alice, createStructuredTemplate('paver')), scout = f.publish(bob, 'chassis'), guard = f.publish(bob, 'heavy');
  f.order(alice, 'control', { id: null }); f.order(bob, 'control', { id: null });
  f.order(bob, 'stance', { ids: [guard], stance: 'hold' });
  f.send(alice, 'auto', { actorId: worker, on: true });
  const actor = world.actor(worker), here = actor.vehicle.x, unit = owner.squad.units.get(worker),
    read = () => owner.squad.decide(owner.squad.side.member(world.actor(worker))),
    ready = () => dispatch.ready(world.actor(worker), faction, fieldParts(world));
  f.put(guard, here + 30000);
  // A chassis with a camera and no gun, 300 m off and in plain view of the paver's own optic.
  f.put(scout, here + 300);
  const near = read();
  assert(near.contact?.detected && near.diagnostics.nearestFreshContactDistance < 400, 'the paver really senses it');
  assert.equal(room.knows(faction.id, world.actor(scout)), 'seen');
  assert.equal(unit.threat, false, 'an unarmed enemy holds nothing'); assert(f.until(ready, 12));
  // The armed one, in sight and within reach of its gun, its fire held: the worker waits, for SCARE_HOLD and no more.
  f.put(scout, here + 30000); f.put(guard, here + 400);
  read(); assert.equal(unit.threat, true); assert.equal(ready(), false); assert.equal(dispatch.waits.get(worker).reason, 'threat');
  assert(f.until(() => !unit.threat, SCARE_HOLD + 5), 'the guard has only shown itself: the hold runs out');
  assert(world.time - unit.scare.from >= SCARE_HOLD - 1);
  assert(f.until(ready, 12), 'free for its work again, with the guard still there');
  assert.equal(room.knows(faction.id, world.actor(guard)), 'seen');
});
