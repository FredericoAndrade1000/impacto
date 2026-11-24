import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal, asked } from '../server/room.ts';
import { FieldHost, replayField, DIARY } from '../server/field-host.ts';
import { writeField, readField } from '../server/field-snapshot.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { STOCK_IDS, SUPPLIED, SUPPLY_REACH, TRANSFER_RATE, CALM_SECONDS, appraise, bill, billSum, billTotal, buildSeconds, carriedBy, designBill, fieldParts, stow, supplied } from '../src/economy.ts';
import { cargoRoom, cargoVolume, cargoUnitVolume } from '../src/component-volume.ts';
import { CONSTRUCTION_REACH, constructionSite, constructionSpan } from '../server/field-construction.ts';
import { HOME_CLEARANCE, STEEPEST_SLOPE, siteRefusal } from '../src/construction-site.ts';
import { FOREIGN } from '../src/territory.ts';
import { footingBill } from '../src/fixed-footing.ts';
import { onField } from './helpers/field.js';
import { FIELD_SAVE } from '../server/field-save.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { nativePhotoOnly } from './helpers/runtime.js';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { chapters } from '../server/fog.ts';
import { Publication } from '../server/publication.ts';
import { MODULES } from '../src/materials.ts';
import { cellOf } from '../src/grid.ts';
import { CRANE_REACH } from '../src/work-arm.ts';

const bases = [-213, 30000], stocks = bill(1e9, 1e9, 1e9, 1e9);
const near = (a, b, tolerance = 1e-6) => assert(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const sameBill = (actual, expected, tolerance) => { for (const id of STOCK_IDS) near(actual[id], expected[id], tolerance); };
const half = amounts => bill(...STOCK_IDS.map(id => amounts[id] / 2));
// The constructor of the templates without its supply pieces: a builder that carries nothing.
const bare = () => { const truck = createStructuredTemplate('construction-truck'); return { ...truck, components: truck.components.filter(part => part.kind !== 'supply') }; };

// A field with a player on it whose faction may put up guard posts, and what a test does there: the works and the heaps of
// the player's faction as it is told them, a builder that carries nothing and a supply vehicle stood where a test asks, and
// what the supply pieces of a vehicle carry, or are made to carry.
function setup(t, { fog = false, at = bases, build = true } = {}) {
  const room = rehearsal(at, stocks, { fog }), f = onField(t, room), player = room.join('Construtor QA'),
    design = createStructuredTemplate('guard-post'), cost = designBill(compileStructuredConstruction(design)), faction = room.faction(room.players.get(player.playerId));
  room.building = build;
  const carried = id => supplied(carriedBy(room.serving(id)).carried),
    load = (id, amounts) => {
      const crates = room.serving(id);
      for (const crate of crates) f.set(crate, { cargo: {} });
      for (const stock of STOCK_IDS) if (amounts[stock] > 0) room.carry(stow(crates, SUPPLIED[stock], amounts[stock]).changed);
    },
    // A vehicle of the faction's, ready the moment it is published whatever the field builds in time.
    ready = model => { const building = room.building; room.building = false; try { return f.publish(player, model); } finally { room.building = building; } },
    // A vehicle out of automatic (supply-dispatch.ts): one with supply pieces loads at the base and unloads where it stands as
    // the player leaves it, and a builder works where it is left.
    off = id => { f.send(player, 'auto', { actorId: id, on: false }); return id; },
    // One these tests stand by hand is the player's, out of automatic.
    vehicle = (model, x, amounts = null) => {
      const id = ready(model);
      if (room.record(room.world.actor(id)).auto) off(id);
      f.run(1);
      if (amounts) load(id, amounts);
      f.put(id, x);
      return id;
    };
  return { ...f, player, faction, design, cost, carried, load, ready, off,
    works: (who = player) => room.factionView(who.playerId).works, heaps: (who = player) => room.factionView(who.playerId).heaps,
    // A constructor of the faction that carries nothing, and a supply vehicle with what it is given (or what the base gave it).
    builder: x => vehicle(bare(), x), supplier: (x, amounts) => vehicle('supply', x, amounts) };
}

test('unsupported vehicle manufacture leaves money, reservations and the old actor intact, while normal readmission stays allowed', t => {
  const f = setup(t, { build: false }), { room, world, player, faction } = f,
    supported = createStructuredTemplate('scout'), unsupported = structuredClone(supported),
    command = unsupported.components.find(part => part.kind === 'command'), seat = room.players.get(player.playerId);
  command.pose.y = 100;
  const noSupport = error => error.reason === 'PHYSICAL_SUPPORT' && error.ids?.includes(command.id),
    state = () => structuredClone({ stock: faction.stock, yard: faction.yard, serials: room.serials,
      reserved: [...room.reserved], works: [...room.works.pending], published: [...seat.published],
      actors: world.actors.map(actor => ({ id: actor.id, revision: actor.revision, construction: actor.construction })) }),
    empty = state();
  assert.throws(() => f.send(player, 'spawn', { blueprint: unsupported }), noSupport);
  assert.deepEqual(state(), empty, 'a refused new vehicle neither spends nor mints or reserves');
  const stock = { ...faction.stock }, id = f.publish(player, supported), original = world.actor(id), before = state();
  sameBill(faction.stock, billSum(stock, designBill(compileStructuredConstruction(supported)), -1));
  assert(room.reserved.has(id));
  assert.throws(() => f.send(player, 'replace', { actorId: id, blueprint: unsupported }), noSupport);
  assert.deepEqual(state(), before); assert.equal(world.actor(id), original);
  const admitted = world.replaceActor(unsupported, { id });
  assert.equal(admitted.id, id);
  assert.equal(admitted.construction.components.find(part => part.id === command.id).pose.y, 100,
    'restoring an existing source is not a new manufacturing request');
});

test('unsupported fixed manufacture opens no work or reservation, while a supported work and existing fixed readmission pass', t => {
  const f = setup(t, { build: false }), { room, world, player, faction, design } = f,
    unsupported = structuredClone(design), command = unsupported.components.find(part => part.kind === 'command');
  command.pose.y = 100;
  const x = f.site(player, unsupported),
    state = () => structuredClone({ stock: faction.stock, yard: faction.yard, serials: room.serials,
      reserved: [...room.reserved], works: [...room.works.pending], actors: world.actors.map(actor => actor.id) }),
    before = state();
  assert.throws(() => f.send(player, 'spawn', { blueprint: unsupported, x, facing: 1 }),
    error => error.reason === 'PHYSICAL_SUPPORT' && error.ids?.includes(command.id));
  assert.deepEqual(state(), before, 'a refused structure leaves no work, material change or minted ID');
  const answer = f.send(player, 'spawn', { blueprint: design, x, facing: 1 });
  assert.equal(room.works.pending.get(answer.work.id).blueprint.name, design.name);
  assert.deepEqual(faction.stock, before.stock, 'a supported work still receives its materials later');
  const admitted = world.addActor(unsupported, { id: 'previously-admitted-fixed', ownerId: player.playerId,
    team: faction.id, x: x + 20, facing: 1 });
  assert.equal(admitted.construction.components.find(part => part.id === command.id).pose.y, 100,
    'ordinary admission does not retroactively apply the new-work gate');
});

test('a structure stands at least 150 m from its own base, on ground its faction has seen, no steeper than 30° and clear', () => {
  const flat = { height: () => 0 }, limits = { minX: -1e5, maxX: 1e5 }, span = minX => ({ minX, maxX: minX + 4 }),
    refusal = (minX, more = {}) => siteRefusal({ span: span(minX), limits, ground: flat, home: 0, ...more });
  assert.equal(HOME_CLEARANCE, 150);
  // From the middle of the base to the nearest of the structure, to either side.
  assert.equal(refusal(149.99), 'Perto demais da base: no mínimo 150 m.');
  assert.equal(refusal(150), '');
  assert.equal(refusal(-153.99), 'Perto demais da base: no mínimo 150 m.');
  assert.equal(refusal(-154), '');
  // A faction with no base is kept from none.
  assert.equal(siteRefusal({ span: span(10), limits, ground: flat }), '');
  // Ground never seen is refused before anything else is told of it: neither its territories nor its relief.
  assert.equal(refusal(200, { explored: [[150, 300]] }), '');
  for (const explored of [[], [[150, 202]], [[202, 300]]]) assert.equal(refusal(200, { explored }), 'Terreno desconhecido: escolha chão já visto.');
  assert.equal(refusal(10, { explored: [] }), 'Terreno desconhecido: escolha chão já visto.');
  // The ground may rise and fall under it as far as 30° over as wide as it is, 4 m here, however it does, and no further.
  const slope = degrees => ({ height: x => Math.max(0, x - 200) * Math.tan(degrees * Math.PI / 180) });
  assert.equal(STEEPEST_SLOPE, 30);
  for (const degrees of [10, 29.9, 30]) assert.equal(refusal(200, { ground: slope(degrees) }), '');
  assert.equal(refusal(200, { ground: slope(30.1) }), 'Encosta íngreme demais: no máximo 30°.');
  assert.equal(refusal(200, { ground: { height: x => x > 202 ? 2.3 : 0 } }), '', 'a step 2.3 m high under 4 m is 29.9°');
  assert.equal(refusal(200, { ground: { height: x => x > 202 ? -2.32 : 0 } }), 'Encosta íngreme demais: no máximo 30°.');
  assert.equal(refusal(200, { ground: { height: x => x > 202 ? NaN : 0 } }), 'Posição no campo inválida.');
  assert.equal(refusal(200, { taken: [{ minX: 204.5, maxX: 210 }] }), 'Não há espaço aí: afaste das estruturas e obras vizinhas.');
  assert.equal(refusal(200, { taken: [{ minX: 204.9, maxX: 210 }] }), '');
  assert.equal(siteRefusal({ span: span(99998), limits, ground: flat }), 'A estrutura passa do limite do campo.');
  assert.equal(siteRefusal({ span: { minX: NaN, maxX: 2 }, limits, ground: flat }), 'Posição no campo inválida.');
});

test('a works is opened at the place chosen off the base for nothing, counts as a structure from then on, and is answered once', t => {
  const f = setup(t), { room, player, faction, design, cost } = f, stock = { ...faction.stock }, actors = room.world.actors.length;
  assert.throws(() => f.send(player, 'spawn', { blueprint: design, x: player.base.x + 60, facing: 1 }), { message: 'Perto demais da base: no mínimo 150 m.' });
  assert.throws(() => f.send(player, 'spawn', { blueprint: design, facing: 1 }), { message: 'Escolha o local da estrutura no campo.' });
  assert.throws(() => f.send(player, 'spawn', { blueprint: design, x: 1e9, facing: 1 }), { message: 'Posição no campo inválida.' });
  assert.equal(room.works.pending.size, 0);
  const x = f.site(player, design), request = { blueprint: design, x, facing: 1, ticket: 'first-work' }, answer = f.send(player, 'spawn', request);
  assert.deepEqual(answer, { work: { id: answer.work.id, name: design.name, x }, cost, seconds: buildSeconds(cost) });
  assert.deepEqual(f.send(player, 'spawn', request), answer, 'the same ticket is answered as it was');
  assert.deepEqual(faction.stock, stock, 'opening it costs nothing');
  assert.equal(room.world.actors.length, actors, 'nothing stands yet');
  const view = room.factionView(player.playerId);
  assert.deepEqual(view.counts, { vehicles: 0, fixed: 1 });
  assert.deepEqual(view.works, [{ id: answer.work.id, name: design.name, blueprint: design, x, facing: 1, cost, delivered: bill(), progress: 0, share: 0,
    seconds: answer.seconds, building: false, waiting: false, sent: null, supplying: false, blocked: '', from: null, lack: bill() }]);
  // Its place is its own: no other works nor any construction of the faction is opened over it.
  assert.throws(() => f.send(player, 'spawn', { blueprint: design, x: x + 1, facing: 1 }), { message: 'Não há espaço aí: afaste das estruturas e obras vizinhas.' });
  // A works is no construction to drive, supply or replace.
  assert.throws(() => f.send(player, 'replace', { actorId: answer.work.id, blueprint: design }));
});

test('a structure is not opened in the territory of another faction, however near its own base', t => {
  const f = setup(t, { at: [-213, 1800] }), { room, player, design } = f, other = room.join('Vizinha');
  assert.equal(other.base.x, 1800);
  for (const x of [player.base.x + 300, player.base.x - 300])
    assert.throws(() => f.send(player, 'spawn', { blueprint: design, x, facing: 1 }), { message: FOREIGN });
  assert.equal(room.works.pending.size, 0);
});

test('ground the faction never saw is refused, and so is a place only partly seen', t => {
  const f = setup(t, { fog: true }), { room, player, faction, design } = f, x = f.site(player, design), span = constructionSpan(design, x, 1);
  assert.throws(() => f.send(player, 'spawn', { blueprint: design, x: player.base.x + 1500, facing: 1 }), { message: 'Terreno desconhecido: escolha chão já visto.' });
  const explored = faction.explored;
  for (const seen of [[], [[span.minX - 50, (span.minX + span.maxX) / 2]], [[(span.minX + span.maxX) / 2, span.maxX + 50]]]) {
    faction.explored = seen;
    assert.throws(() => f.send(player, 'spawn', { blueprint: design, x, facing: 1 }), { message: 'Terreno desconhecido: escolha chão já visto.' });
  }
  assert.equal(room.works.pending.size, 0);
  faction.explored = explored;
  assert.equal(f.send(player, 'spawn', { blueprint: design, x, facing: 1 }).work.x, x);
});

test('a works is put up only as far as what came of it: nothing with nothing brought, half with half, and it stands once all of it came and was put up', t => {
  const f = setup(t), { room, player, design, cost } = f, id = f.open(player, design), work = () => f.works()[0], x = work().x;
  const builder = f.builder(x - 8);
  f.run(3);
  assert.deepEqual([work().progress, work().share, work().building, work().waiting], [0, 0, false, true], 'a builder beside it has nothing to put up');
  // A supply vehicle beside it, still and out of combat, unloads half of what it costs, and goes on unloading nothing more,
  // while the builder stands off it.
  f.put(builder, x - 200);
  const supplier = f.supplier(x + 8, half(cost));
  assert(f.until(() => billTotal(f.carried(supplier)) < 1, 30)); sameBill(work().delivered, half(cost), 2);
  sameBill(f.carried(supplier), bill(), 1); assert.equal(work().progress, 0); assert.equal(work().waiting, false, 'no builder stands by it');
  // Put up as fast as the base would build it, and no further than half.
  f.put(builder, x - 8);
  f.run(work().seconds / 4 - 1.5);
  assert(work().building && work().progress > .1 && work().progress < .4, `put up to ${work().progress}`);
  f.run(work().seconds / 2);
  near(work().progress, .5, .002); near(work().share, .5, .002); assert.deepEqual([work().building, work().waiting], [false, true], 'all that came is put up: it waits for the rest');
  assert(!room.world.actor(id));
  // The rest comes: it stands, where it was opened, and it is the structure the works was.
  f.load(supplier, cost);
  assert(f.until(() => room.world.actor(id), work()?.seconds ?? 30));
  const defence = room.world.actor(id);
  assert.deepEqual([defence.construction.name, defence.vehicle, defence.ownerId, defence.team, defence.x, defence.facing],
    [design.name, null, player.playerId, f.faction.id, x, 1]);
  assert.deepEqual(f.works(), []); assert.deepEqual(room.factionView(player.playerId).counts, { vehicles: 2, fixed: 1 });
  assert.equal(room.factionView(player.playerId).objectives.completed.buildDefense, true);
  sameBill(f.carried(supplier), half(cost), 1);
  assert.equal(f.send(player, 'blueprint', { actorId: id }).actor.blueprint.name, design.name);
  assert.throws(() => f.send(player, 'auto', { actorId: id, on: true }), /suprimentos, construtor ou máquina de estrada/);
});

test('a builder puts a works up only from beside it: the end of it no further off than a crane of the reference size reaches', t => {
  const f = setup(t), { room, player, design, cost } = f, id = f.open(player, design), work = room.works.pending.get(id), span = room.works.span(work);
  work.delivered = { ...cost };
  const builder = f.builder(work.x - 60),
    // Where it stands with its front end this far short of the works.
    off = gap => { const hull = room.works.hull(room.world.actor(builder)); return span.minX - gap - (hull.maxX - room.position(room.world.actor(builder))); },
    going = () => { const from = work.progress; f.run(1); return work.progress > from; };
  assert.deepEqual([CONSTRUCTION_REACH, Math.ceil(CRANE_REACH)], [7, 7]);
  f.put(builder, off(CONSTRUCTION_REACH + .5)); assert(!going(), 'just out of reach it puts up nothing');
  assert.equal(f.works()[0].building, false);
  f.put(builder, off(CONSTRUCTION_REACH - .5)); assert(going(), 'within reach it does');
  assert.equal(f.works()[0].building, true);
});

test('builders by a works put it up together, each at the pace of its size, on the power and the fuel of their engines', t => {
  const f = setup(t), { room, player, design, cost } = f, id = f.open(player, design), work = room.works.pending.get(id), x = work.x;
  work.delivered = { ...cost };
  // How fast it goes up for a while, as works-seconds a second: one builder of the reference size at its full pace makes one.
  const pace = (seconds = 2) => { const from = work.progress; f.run(seconds); return (work.progress - from) * work.seconds / seconds; };
  const one = f.builder(x - 8);
  near(pace(), 1, .01);
  assert.deepEqual(room.factionView(player.playerId).units.find(unit => unit.id === one).tools, { pace: 1 }, 'its faction is told it works at all its pace');
  const two = f.builder(x + 8);
  near(pace(), 2, .01); assert.deepEqual(room.works.builders.get(id), [one, two]);
  // A builder of half the size, as long and tall by half and as deep, does a quarter of that; keep its base on its
  // physical support.
  f.put(one, x - 400); f.put(two, x - 400);
  const truck = bare(), small = f.off(f.ready({ ...truck, components: truck.components.map(part => part.kind === 'builder'
    ? { ...part, sizeScale: .5, pose: { ...part.pose, y: part.pose.y + cellOf(MODULES.builder.height * (.5 - part.sizeScale) / 2) } } : part) }));
  f.run(1); f.put(small, x - 8);
  near(pace(4), 1 / 4, .01);
  // Its engine burns fuel for it, and with none left it puts nothing up, and its faction is told why.
  const fuel = () => f.parts(small, 'fuel').reduce((sum, tank) => sum + tank.fuelLitres, 0),
    burned = seconds => { const had = fuel(); f.run(seconds); return had - fuel(); }, working = burned(2);
  f.put(small, x - 400); assert(working > burned(2) + 1e-6, 'it burns fuel as it works'); f.put(small, x - 8);
  for (const tank of f.parts(small, 'fuel')) f.set(tank, { fuelLitres: 0 });
  f.run(.5); near(pace(), 0, 1e-9);
  assert.deepEqual(room.factionView(player.playerId).units.find(unit => unit.id === small).tools, { limit: 'fuel' });
});

test('a builder really runs dry at an unfinished work and resumes the same work after a supplier drives there', t => {
  const f = setup(t), { room, world, player, faction, design, cost } = f,
    id = f.open(player, design), work = room.works.pending.get(id), x = work.x;
  // Cold fixture: a fully paid material delivery and a healthy constructor already beside it.
  // After the fuel reserve is seeded, only ordinary field steps consume or deliver fuel.
  for (const material of STOCK_IDS) faction.stock[material] -= cost[material];
  work.delivered = { ...cost };
  const builder = f.builder(x - 8), tanks = f.parts(builder, 'fuel'),
    fuel = () => tanks.reduce((sum, tank) => sum + tank.fuelLitres, 0);
  assert(tanks.length > 0 && f.parts(builder, 'supply').length === 0);
  tanks.forEach((tank, i) => f.set(tank, { fuelLitres: i === 0 ? .0005 : 0 }));
  const beforeBurn = work.progress;
  assert(f.until(() => fuel() === 0, 10), 'the working engine consumes the actual remaining reserve');
  assert(work.progress > beforeBurn && work.progress < 1, 'real work precedes starvation without completing the source');
  f.run(1);
  const stopped = work.progress;
  f.run(2);
  assert.equal(work.progress, stopped, 'a dry constructor applies no work');
  assert.equal(room.factionView(player.playerId).units.find(unit => unit.id === builder).tools.limit, 'fuel');
  assert(f.parts(builder, 'engine', 'builder').every(part => part.health === part.maxHealth), 'fuel is the only missing capability');

  // This truck loads through the base's existing paid supply path. It then drives normally;
  // no pose, part state, progress or reserve is changed after departure. Sent onto the constructor, its squad stops it beside
  // it, the gap of the squad off it: there it hands it over (`SUPPLY_REACH`).
  const supplier = f.supplier(faction.base.x), suppliedFuel = () => f.carried(supplier).combustivel;
  assert(suppliedFuel() > 0, 'the base supplied real fuel cargo');
  const heldFuel = suppliedFuel(), bank = faction.stock.combustivel;
  f.order(player, 'move', { ids: [supplier], x: room.position(world.actor(builder)) });
  assert(f.until(() => fuel() > 0, 120), 'the truck physically reaches and refuels the dry constructor');
  assert(!room.atBase(faction, world.actor(builder)) && !room.atBase(faction, world.actor(supplier)));
  assert(suppliedFuel() < heldFuel, 'delivered fuel leaves the supplier cargo');
  assert(faction.stock.combustivel <= bank, 'the field delivery creates no base fuel');
  assert.equal(room.works.pending.get(id), work, 'the original work remains open');
  assert(f.until(() => work.progress > stopped, 5), 'power restored, the original work advances');
  assert(f.until(() => world.actor(id), work.seconds + 5), 'the same paid work finishes without reopening');
  assert.equal(room.works.pending.has(id), false);
  t.diagnostic(JSON.stringify({ source: id, dryProgress: stopped, suppliedFuel: heldFuel - suppliedFuel(), finalFuel: fuel() }));
});

test('every screen is told which builders put up or take down what: their faction at what share of their pace, another only that they work', t => {
  const f = setup(t, { fog: true, at: [-213, 12000] }), { room, player, design, cost } = f, bia = room.join('Bia'),
    id = f.open(player, design), work = room.works.pending.get(id), x = work.x, publication = new Publication(),
    told = (who, actorId) => { const state = publication.state(room.world.snapshot()); state.shared = true; state.players = room.roster();
      const sent = room.audience(state, chapters(state), [], room.players.get(who.playerId).factionId).state;
      return { actor: sent.actors.find(actor => actor.id === actorId), crane: sent.modules.find(m => m.actorId === actorId && m.kind === 'builder') }; };
  work.delivered = { ...cost };
  const builder = f.builder(x - 8), field = () => room.world.actor(builder).field,
    unit = actorId => room.factionView(player.playerId).units.find(unit => unit.id === actorId);
  f.run(1); assert.deepEqual(field().building, { at: id });
  assert.equal(unit(builder).builder.working, id); assert.equal(f.works()[0].building, true);
  // Bia's scout beside it sees its crane at work, and not what it is at, nor how far its engines let it go.
  const scout = f.publish(bia, 'scout'); f.run(1); f.put(scout, x - 15); f.run(1);
  const hers = told(bia, builder), his = told(player, builder);
  assert.deepEqual(hers.actor.field.building, {}); assert(!JSON.stringify(hers.actor).includes(`"${id}"`)); assert(hers.crane, 'its crane shows');
  assert.deepEqual(his.actor.field.building, { at: id });
  // Away from it, it works at nothing.
  f.put(builder, x - 400); assert.equal(field(), null);
  f.put(builder, x - 8); assert.deepEqual(field().building, { at: id });
  // A builder two and a half times the size, of 6.25 times the room, asks more of the engine than it gives: it is told
  // the share of its pace it works at.
  const truck = bare(), large = f.off(f.ready({ ...truck, components: truck.components.map(part => part.kind === 'builder'
    ? { ...part, sizeScale: 2.5, pose: { ...part.pose, y: part.pose.y + cellOf(MODULES.builder.height * (2.5 - part.sizeScale) / 2) } } : part) }));
  f.put(builder, x - 400); f.run(1); f.put(large, x + 8);
  const pace = room.world.actor(large).field.building.pace;
  assert(pace > 0 && pace < 1, `at ${pace} of its pace`); assert.deepEqual(room.world.actor(large).field.building, { at: id, pace });
  assert.deepEqual(unit(large).tools, { limit: 'power', pace });
  assert.equal(unit(large).builder.working, id); assert.equal(f.works()[0].building, true, 'partial working power still counts');
  // With no fuel it works at nothing.
  for (const tank of f.parts(large, 'fuel')) f.set(tank, { fuelLitres: 0 });
  f.run(1); assert.equal(room.world.actor(large).field?.building ?? null, null);
  assert.deepEqual(room.works.builders.get(id), [large], 'lack of fuel does not discard the internal selection');
  assert.equal(unit(large).builder.working, null); assert.equal(f.works()[0].building, false);
  // A structure taken down is what its builder is at.
  const post = f.raise(player, design, { x: f.site(player, design, { from: 400 }) }), spot = room.position(room.world.actor(post));
  f.send(player, 'remove', { actorId: post }); f.put(builder, spot + 8);
  assert.deepEqual(field().building, { at: post });
  assert.equal(unit(post).service.building, true);
  // Keep the same dismantling service and selected arm while its engine cannot pay for any work, then restore it.
  const service = room.record(room.world.actor(post)).service, progress = service.progress,
    engines = f.parts(builder, 'engine').map(piece => ({ piece, health: piece.health }));
  assert(engines.length > 0);
  for (const { piece } of engines) f.set(piece, { health: 0 });
  // Damage and restoration both start the ordinary combat quiet period; wait it out before checking engine power.
  f.run(CALM_SECONDS + .5);
  assert.equal(unit(builder).calm, true);
  assert.equal(unit(builder).tools.limit, 'engine'); assert.equal(field()?.building ?? null, null);
  assert.deepEqual(room.works.builders.get(post), [builder], 'an unpowered arm remains selected for this service');
  assert.equal(unit(builder).builder.working, null); assert.equal(unit(post).service.building, false);
  assert.equal(service.progress, progress);
  for (const { piece, health } of engines) f.set(piece, { health });
  f.run(CALM_SECONDS + .5);
  assert.equal(unit(builder).calm, true);
  assert.equal(room.record(room.world.actor(post)).service, service); assert(service.progress > progress);
  assert.equal(unit(builder).builder.working, post); assert.equal(unit(post).service.building, true);
});

test('a published builder quote drops cancelled and finished dismantling targets before another survey', t => {
  const f = setup(t), { room, world, player, faction, design } = f,
    post = f.raise(player, design), x = room.position(world.actor(post)), builder = f.builder(x + 8);
  f.send(player, 'remove', { actorId: post }); f.run(.5);
  const parts = fieldParts(world), published = room.units(faction, parts), surveyed = room.surveyed;
  assert.equal(published.find(unit => unit.id === builder).builder.working, post);
  assert.equal(published.find(unit => unit.id === post).service.building, true);
  f.send(player, 'cancel-dismantle', { actorId: post });
  const cancelled = room.units(faction, parts);
  assert.equal(room.surveyed, surveyed, 'the immediate read must not wait for a new survey');
  assert.equal(room.records.get(builder).building.at, post); assert.deepEqual(room.works.builders.get(post), [builder]);
  assert.equal(cancelled.find(unit => unit.id === builder).builder.working, null);
  assert.equal(cancelled.find(unit => unit.id === post).service, null);
  assert.equal(published.find(unit => unit.id === builder).builder.working, post, 'an already published quote is not mutated');
  // Start a real new powered step, then exercise the normal completion boundary without another survey.
  f.send(player, 'remove', { actorId: post }); f.run(.5);
  const nextParts = fieldParts(world), active = room.units(faction, nextParts), beforeFinish = room.surveyed;
  assert.equal(active.find(unit => unit.id === builder).builder.working, post);
  room.records.get(post).service.progress = 1; room.works.finish(room.works.takedown(post));
  const finished = room.units(faction, nextParts);
  assert.equal(room.surveyed, beforeFinish); assert(!world.actor(post)); assert(!room.records.has(post));
  assert.equal(room.records.get(builder).building.at, post); assert.deepEqual(room.works.builders.get(post), [builder]);
  assert.equal(finished.find(unit => unit.id === builder).builder.working, null); assert(!finished.some(unit => unit.id === post));
  assert.equal(active.find(unit => unit.id === builder).builder.working, post, 'completion also leaves the published quote intact');
});

test('a supply vehicle unloads into a works only beside it, as near as a builder works at it, out of combat', t => {
  const f = setup(t, { build: false }), { room, player, design, cost } = f, id = f.open(player, design), x = f.works()[0].x,
    span = constructionSpan(design, x, 1), supplier = f.supplier(span.maxX + SUPPLY_REACH + 5, cost),
    // Where it stands with the end of it this far off the works.
    off = gap => { const hull = room.works.hull(room.world.actor(supplier)); return span.maxX + gap + room.position(room.world.actor(supplier)) - hull.minX; };
  f.run(2); sameBill(f.works()[0].delivered, bill(), 0);
  // Just past where a builder works at it, or twice as far, it unloads nothing into it.
  for (const gap of [CONSTRUCTION_REACH + 1, 2 * CONSTRUCTION_REACH]) { f.put(supplier, off(gap)); f.run(1); sameBill(f.works()[0].delivered, bill(), 0); }
  // In combat it unloads nothing, until it is calm again.
  room.record(room.world.actor(supplier)).combatAt = room.world.time; f.put(supplier, off(CONSTRUCTION_REACH - 1));
  f.run(1); sameBill(f.works()[0].delivered, bill(), 0);
  assert(f.until(() => f.works()[0].supplying, 15), 'calm again, it unloads');
  assert(f.until(() => billTotal(room.works.need(room.works.pending.get(id))) === 0, 40));
  sameBill(f.carried(supplier), bill(), 1);
});

test('a supply vehicle loaded at the base takes first what the works of its faction lack, and then the shares of its fleet', t => {
  const f = setup(t, { build: false }), { room, player, design, cost } = f;
  const before = f.off(f.ready('supply')); f.run(1);
  assert(f.carried(before).silica < cost.silica / 4, 'with no works, the shares of a fleet of steel: hardly any Sílica');
  f.open(player, design);
  const lorry = f.off(f.ready('supply')); f.run(1);
  const carried = f.carried(lorry);
  near(carried.silica, cost.silica, 1); assert(carried.ferro > cost.ferro, 'and the rest of its room in the shares of the fleet');
  room.works.pending.values().next().value.delivered = { ...cost };
  const after = f.off(f.ready('supply')); f.run(1);
  assert(f.carried(after).silica < cost.silica / 4, 'what a works has is no more asked for');
});

test('a works given up leaves what came of it where it stood, in a heap a supply vehicle there loads; nobody else gives it up', t => {
  const f = setup(t, { build: false }), { room, player, design, cost } = f, id = f.open(player, design), x = f.works()[0].x,
    other = room.join('Outra facção');
  room.works.pending.get(id).delivered = half(cost);
  assert.throws(() => room.command(other.playerId, { type: 'cancel-work', workId: id }), { message: 'Essa obra já não está no campo.' });
  const answer = f.send(player, 'cancel-work', { workId: id });
  assert.deepEqual(answer, { cancelled: id, heap: { id, stock: f.heaps()[0].stock } });
  sameBill(f.heaps()[0].stock, half(cost), 1); assert.equal(f.heaps()[0].x, x);
  assert.deepEqual([f.works(), room.factionView(player.playerId).counts], [[], { vehicles: 0, fixed: 0 }]);
  assert.throws(() => f.send(player, 'cancel-work', { workId: id }), { message: 'Essa obra já não está no campo.' });
  // A supply vehicle with room parked 25 m off it loads nothing of it; parked beside it, a few metres off the pile
  // (`SUPPLY_REACH`), it loads it, and it is gone.
  const supplier = f.supplier(x + 25, bill()), pile = room.works.pile(room.works.heaps.get(id)),
    off = gap => { const hull = room.works.hull(room.world.actor(supplier)); return pile.maxX + gap + room.position(room.world.actor(supplier)) - hull.minX; };
  assert(room.works.gap(room.world.actor(supplier), pile) > SUPPLY_REACH);
  f.run(2); sameBill(f.carried(supplier), bill(), 0);
  f.put(supplier, off(SUPPLY_REACH - 2));
  assert(f.until(() => !f.heaps().length, 30), 'the heap is loaded');
  sameBill(f.carried(supplier), half(cost), 1);
  // The same native supply pieces, nearly full, keep all four stocks in proportion instead of taking Fe first.
  const amounts = bill(600, 200, 150, 50), total = billTotal(amounts),
    volume = STOCK_IDS.reduce((sum, material) => sum + amounts[material] * cargoUnitVolume(SUPPLIED[material]), 0),
    spare = 37.125, freeVolume = spare * volume / total;
  for (const piece of room.serving(supplier)) f.set(piece, { cargo: { ferro: cargoRoom(piece) / cargoUnitVolume('ferro') } });
  const last = room.serving(supplier)[0];
  assert(cargoRoom(last) > freeVolume);
  f.set(last, { cargo: { ferro: (cargoRoom(last) - freeVolume) / cargoUnitVolume('ferro') } });
  const before = f.carried(supplier), heap = room.works.heap(id, f.faction.id, x, amounts),
    moved = room.works.gather(heap, room.serving(supplier), TRANSFER_RATE), after = f.carried(supplier);
  near(moved, spare); assert(moved <= TRANSFER_RATE);
  for (const material of STOCK_IDS) {
    const received = after[material] - before[material];
    near(received, spare * amounts[material] / total);
    near(heap.stock[material] + received, amounts[material]);
  }
  for (const piece of room.serving(supplier)) assert(cargoVolume(piece) <= cargoRoom(piece) + 1e-9);
  assert.equal(room.works.heaps.get(id), heap, 'the ordinary finite heap remains until its real remaining stocks are gone');
  // Nothing came of a works given up at once: it leaves no heap.
  const empty = f.open(player, design);
  assert.deepEqual(f.send(player, 'cancel-work', { workId: empty }), { cancelled: empty, heap: null });
});

test('a structure is taken down where it stands by a builder beside it, in the time of what it gives back, which it leaves in a heap', t => {
  const f = setup(t), { room, player, design } = f, id = f.raise(player, design), defence = () => room.world.actor(id), x = room.position(defence());
  const value = appraise(defence(), fieldParts(room.world)).salvage, answer = f.send(player, 'remove', { actorId: id });
  assert.deepEqual(answer, { dismantling: id, seconds: buildSeconds(value), value });
  assert.equal(room.held(defence()), 'Essa estrutura está sendo desmontada.');
  assert.deepEqual(room.factionView(player.playerId).units.find(unit => unit.id === id).service,
    { kind: 'dismantle', progress: 0, seconds: answer.seconds, to: null, building: false, sent: null });
  // Nobody takes it down: it stands, held. Taken back, it is as it was; asked again, it is taken down.
  f.run(2); assert(defence());
  assert.deepEqual(f.send(player, 'cancel-dismantle', { actorId: id }), { kept: id });
  assert.equal(room.held(defence()), '');
  f.send(player, 'remove', { actorId: id });
  f.builder(x + 8);
  f.run(answer.seconds / 2);
  assert(room.records.get(id).service.progress > .3 && defence());
  assert(f.until(() => !defence(), answer.seconds), 'taken down');
  assert.deepEqual(f.heaps().map(heap => [heap.id, heap.x]), [[id, x]]);
  sameBill(f.heaps()[0].stock, value, 1);
  assert.deepEqual(room.factionView(player.playerId).counts, { vehicles: 1, fixed: 0 });
});

test('a structure moved is taken down where it stands and opened again where asked, of the same project, counting once', t => {
  const f = setup(t, { build: false }), { room, player, design, cost } = f, id = f.raise(player, design), from = room.position(room.world.actor(id)),
    scout = f.publish(player, 'scout');
  assert.throws(() => f.send(player, 'relocate', { actorId: scout, x: from, facing: 1 }), { message: 'Só estruturas são movidas assim: dê a ordem Mover ao veículo.' });
  assert.throws(() => f.send(player, 'relocate', { actorId: id, x: player.base.x + 20, facing: 1 }), { message: 'Perto demais da base: no mínimo 150 m.' });
  assert.equal(room.held(room.world.actor(id)), ''); assert.deepEqual(f.works(), []);
  // Moved elsewhere, where it may stand itself, facing the other way.
  const to = f.site(player, design, { from: Math.abs(from - player.base.x) + 3, facing: -1, ignore: id }),
    answer = f.send(player, 'relocate', { actorId: id, x: to, facing: -1, ticket: 'move' });
  assert.deepEqual(answer, { work: { id: answer.work.id, name: design.name, x: to }, dismantling: id, seconds: 0 });
  assert.deepEqual(f.send(player, 'relocate', { actorId: id, x: to, facing: -1, ticket: 'move' }), answer);
  assert.deepEqual([f.works()[0].from, f.works()[0].facing, f.works()[0].cost], [id, -1, cost]);
  assert.equal(room.records.get(id).service.to, answer.work.id);
  assert.deepEqual(room.factionView(player.playerId).counts, { vehicles: 1, fixed: 1 }, 'the structure moved counts as its works');
  // Kept where it stood, the works it was moved to is given up.
  assert.deepEqual(f.send(player, 'cancel-dismantle', { actorId: id }), { kept: id, heap: null });
  assert.deepEqual([f.works(), room.factionView(player.playerId).counts], [[], { vehicles: 1, fixed: 1 }]);
  // Moved again, a builder beside it takes it down: its heap lies where it stood, for its works.
  const again = f.send(player, 'relocate', { actorId: id, x: to, facing: -1 });
  f.builder(from + 8);
  assert(f.until(() => !room.world.actor(id), 5));
  assert.deepEqual(f.heaps().map(heap => heap.id), [id]); sameBill(f.heaps()[0].stock, cost, 1);
  assert.deepEqual(f.works().map(work => [work.id, work.from]), [[again.work.id, id]]);
  // Giving up the works then leaves the heap as it lies.
  f.send(player, 'cancel-work', { workId: again.work.id });
  assert.deepEqual(f.heaps().map(heap => heap.id), [id]);
});

// The first place `from` metres off the base or further, on the side the hills of the field are, where a structure may stand
// for the faction of the player and its footing costs `least` Sílica or more (fixed-footing.ts): a hillside. Its slope too.
function hillside(f, design, { from = 160, least = 1000, facing = 1, ignore = null } = {}) {
  const { room, player } = f, faction = room.faction(room.players.get(player.playerId)), blueprint = compileStructuredConstruction(design), ground = room.world.terrain;
  for (let x = player.base.x + from; x < player.base.x + from + 4000; x += 2) {
    try { constructionSite(room, faction, design, x, facing, ignore); } catch { continue; }
    const footing = footingBill(blueprint, ground, { x, facing }), span = constructionSpan(design, x, facing);
    if (footing.silica >= least) return { x, footing, degrees: Math.atan(Math.abs(ground.height(span.maxX) - ground.height(span.minX)) / (span.maxX - span.minX)) * 180 / Math.PI };
  }
  throw new Error('The fixture needs a hillside off the base.');
}

test('a works on a slope pays for its footing past the free 0.7 m and takes longer to put up; taken down, it gives none of it back', t => {
  const f = setup(t), { room, player, faction } = f, bunker = createStructuredTemplate('bunker'), price = designBill(compileStructuredConstruction(bunker)),
    { x, footing, degrees } = hillside(f, bunker), cost = billSum(price, footing);
  assert(degrees > 10 && degrees <= 30, `a hillside: ${degrees}°`);
  assert.deepEqual([footing.ferro, footing.ligas, footing.combustivel], [0, 0, 0], 'the footing is paid in Sílica alone');
  const answer = f.send(player, 'spawn', { blueprint: bunker, x, facing: 1 });
  assert.deepEqual([answer.cost, answer.seconds], [cost, buildSeconds(cost)]);
  assert(answer.seconds > buildSeconds(price), 'it takes longer than on level ground');
  assert.deepEqual(f.works().map(work => [work.cost, work.seconds]), [[cost, answer.seconds]]);
  // What the stocks lack of it is what supply vehicles take to it: the Sílica of the footing among it.
  const held = faction.stock; faction.stock = bill();
  assert.deepEqual(f.works()[0].lack, cost);
  faction.stock = held;
  // Raised there, it is worth what its pieces are: taking it down gives back nothing of its footing.
  f.send(player, 'cancel-work', { workId: answer.work.id });
  const id = f.raise(player, bunker, { x });
  sameBill(appraise(room.world.actor(id), fieldParts(room.world)).salvage, price, 1);
  // Moved, it pays for the footing of where it goes: none on level ground, another on another hillside.
  const flat = f.site(player, bunker, { ignore: id });
  f.send(player, 'relocate', { actorId: id, x: flat, facing: 1 });
  assert.deepEqual(f.works()[0].cost, price);
  f.send(player, 'cancel-dismantle', { actorId: id });
  const other = hillside(f, bunker, { from: x - player.base.x + 20, ignore: id });
  f.send(player, 'relocate', { actorId: id, x: other.x, facing: 1 });
  assert.deepEqual(f.works()[0].cost, billSum(price, other.footing));
});

test('a structure does not turn: it is moved to face the other way', t => {
  const f = setup(t, { build: false }), { room, player, design } = f, id = f.raise(player, design), scout = f.publish(player, 'scout');
  const unturned = 'Estruturas não viram: use Mover para montá-la virada para o outro lado.';
  assert.throws(() => f.order(player, 'turn', { ids: [id] }), { message: unturned });
  assert.throws(() => room.turn(room.players.get(player.playerId), room.world.actor(id)), { message: unturned });
  assert.deepEqual(f.order(player, 'turn', { ids: [id, scout] }).turning, [scout]);
  assert.equal(room.records.get(id).service, null);
});

test('a works all put up waits while the place or the limit of its faction refuses it, and stands once they admit it', t => {
  const f = setup(t, { build: false }), { room, player, faction, design, cost, world } = f;
  for (let i = 0; i < CONSTRUCTION_LIMITS.fixed - 1; i++) world.addActor(design,
    { id: `quota-f${i}`, ownerId: player.playerId, team: faction.id, x: player.base.x - 500 - i * 8, facing: 1 });
  const id = f.open(player, design);
  assert.deepEqual(room.factionView(player.playerId).counts, { vehicles: 0, fixed: 32 });
  // A construction admitted from an older field fills the allowance while the works is under way.
  world.addActor(design, { id: 'late-fixed', ownerId: player.playerId, team: faction.id, x: player.base.x - 900, facing: 1 });
  room.works.pending.get(id).delivered = { ...cost };
  f.builder(f.works()[0].x - 8);
  f.run(1);
  assert.deepEqual([f.works()[0].progress, f.works()[0].blocked], [1, 'Limite: 32 estruturas por facção.']);
  assert(!world.actor(id));
  // Then a structure of the faction stands over its place: it waits for the place to be clear. A vehicle of the faction
  // standing there keeps it from nothing: constructions pass through one another, and a vehicle moves off.
  const scout = f.ready('scout'); f.run(1); f.put(scout, f.works()[0].x);
  room.discard('late-fixed');
  world.addActor(design, { id: 'squatter', ownerId: player.playerId, team: faction.id, x: f.works()[0].x + 2, facing: 1 });
  f.run(.5);
  assert.equal(f.works()[0].blocked, 'Não há espaço aí: afaste das estruturas e obras vizinhas.'); assert(!world.actor(id));
  room.discard('squatter'); f.run(.5);
  assert.equal(world.actor(id).construction.name, design.name); assert.deepEqual(f.works(), []);
  assert(Math.abs(room.position(world.actor(scout)) - world.actor(id).x) < 1, 'it stands over the vehicle that stood there');
});

test('the works and the heaps of a faction are its own: another is told nothing of them, even standing beside them', t => {
  const f = setup(t, { fog: true, at: [-213, 12000], build: false }), { room, player, design, cost } = f, bia = room.join('Bia');
  const id = f.open(player, design), given = f.open(player, design), x = f.works()[0].x;
  room.works.pending.get(given).delivered = half(cost); f.send(player, 'cancel-work', { workId: given });
  const scout = f.publish(bia, 'scout'); f.run(1); f.put(scout, x + 8); f.run(1);
  assert(room.factionView(bia.playerId).explored.some(([from, to]) => from <= x && x <= to), 'Bia sees where they are');
  const views = () => JSON.stringify([room.factionView(bia.playerId), room.squadView(bia.playerId)]);
  assert.deepEqual([room.factionView(bia.playerId).works, room.factionView(bia.playerId).heaps], [[], []]);
  assert(!views().includes(`"${id}"`) && !views().includes(`"${given}"`));
  assert.deepEqual([f.works().map(work => work.id), f.heaps().map(heap => heap.id)], [[id], [given]]);
});

test('a works and a heap go back to the stocks with the faction when its base is taken, and leave with a faction that goes', t => {
  const f = setup(t, { build: false }), { room, player, faction, design, cost } = f, id = f.open(player, design), given = f.open(player, design);
  room.works.pending.get(id).delivered = half(cost); room.works.pending.get(given).delivered = half(cost);
  f.send(player, 'cancel-work', { workId: given });
  const stock = { ...faction.stock }, stripped = room.strip(faction);
  sameBill(stripped.returned, cost, 1);
  sameBill(faction.stock, bill(...STOCK_IDS.map(stockId => stock[stockId] + cost[stockId])), 1);
  assert.deepEqual([room.works.pending.size, room.works.heaps.size], [0, 0]);
  // A faction that goes takes its works and its heaps with it.
  f.open(player, design); room.works.pending.values().next().value.delivered = half(cost);
  const host = room.join('Anfitriã');
  f.send(host, 'invite', { playerId: player.playerId }); f.send(player, 'join-faction', { factionId: room.players.get(host.playerId).factionId });
  assert.equal(room.factions.has(faction.id), false);
  assert.deepEqual([room.works.pending.size, room.works.heaps.size], [0, 0]);
});

test('a member who leaves leaves the works opened with the faction: it stands for the leader', t => {
  const f = setup(t, { build: false }), { room, player, faction, design, cost } = f, bia = room.join('Bia'), carol = room.join('Carol');
  f.send(player, 'invite', { playerId: bia.playerId }); f.send(bia, 'join-faction', { factionId: faction.id });
  const id = f.open(bia, design);
  f.send(carol, 'invite', { playerId: bia.playerId }); f.send(bia, 'join-faction', { factionId: room.players.get(carol.playerId).factionId });
  assert.deepEqual(f.works().map(work => work.id), [id]);
  room.works.pending.get(id).delivered = { ...cost }; f.builder(f.works()[0].x - 8);
  assert(f.until(() => room.world.actor(id), 2));
  assert.deepEqual([room.world.actor(id).ownerId, room.world.actor(id).team], [player.playerId, faction.id]);
});

test('the host writes down a works opened, asked again and given up, and its snapshot and diary run again alike',
  nativePhotoOnly, async t => {
  const f = setup(t, { build: true }), { room, player, design } = f, field = { bases, stock: stocks }, host = new FieldHost(room, { field }),
    request = { type: 'spawn', blueprint: design, x: f.site(player, design), facing: 1, ticket: 'host-first', request: 7 };
  // A constructor of the faction stands beside the place with what the works asks for: it brings the works all of it and
  // puts it up, and the next one from the heap the first leaves when it is given up.
  const builder = f.ready('construction-truck'); f.run(1); f.load(builder, f.cost); f.put(builder, request.x - 8);
  sameBill(f.carried(builder), f.cost, 1);
  const snapshot = writeField(room, host.publication),
    header = { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT, field, origin: null, snapshot };
  assert.deepEqual(asked({ ...request, builderId: 'c1', forgedStock: bill(1e9) }), { type: 'spawn', ticket: 'host-first', blueprint: design, x: request.x, facing: 1 });
  assert.deepEqual(asked({ type: 'cancel-work', workId: 'c9', refund: 1 }), { type: 'cancel-work', workId: 'c9' });
  assert.deepEqual(asked({ type: 'relocate', actorId: 'c3', x: 5, facing: -1, ticket: 'm', blueprint: design }), { type: 'relocate', actorId: 'c3', x: 5, facing: -1, ticket: 'm' });
  const answer = host.command(player.playerId, request);
  assert.deepEqual(host.command(player.playerId, request), answer);
  // In automatic, it goes on to where its crane reaches the works first.
  for (let i = 0; i < 60 * 30 && !(room.works.pending.get(answer.work.id).progress > 0); i++) host.step();
  for (let i = 0; i < 60; i++) host.step();
  const mid = writeField(room, host.publication), restored = rehearsal(bases, stocks, { fog: false });
  t.after(() => restored.world.dispose());
  readField(restored, mid);
  assert.equal(restored.works.room, restored); assert(restored.works.pending.get(answer.work.id).progress > 0);
  const cancelled = host.command(player.playerId, { type: 'cancel-work', workId: answer.work.id });
  assert.equal(cancelled.heap.id, answer.work.id);
  const next = host.command(player.playerId, { ...request, ticket: 'host-next' });
  for (let i = 0; i < 60 * 60 && !room.world.actor(next.work.id); i++) host.step();
  assert(room.world.actor(next.work.id), 'the second works stands');
  host.keep();
  const again = await replayField([JSON.stringify(header), ...host.lines]);
  t.after(() => again.host.room.world.dispose());
  assert.equal(again.how, 'end', again.got); assert.equal(again.host.room.digest(), room.digest());
  assert(again.host.room.world.actor(next.work.id));
});
