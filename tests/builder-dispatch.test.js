import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { BUILD_REACH, SITE_CLEARANCE } from '../src/construction-site.ts';
import { boxesOf, workFrame, craneLayout, craneSide, craneRoute } from '../src/work-arm.ts';
import { workShape } from '../src/work-art.ts';
import { BASE_RADIUS, STOCK_IDS, SUPPLIED, bill, billSum, billTotal, carriedBy, designBill, stow, supplied } from '../src/economy.ts';
import { constructionSpan } from '../server/field-construction.ts';
import { onField } from './helpers/field.js';
import { pileLook, pileSize } from '../src/cargo-art.ts';

// Builders the dispatch sends (server/supply-dispatch.ts): on a rehearsed field a works stands, and a structure is taken
// down, the moment a builder stands beside it with all its material there, so what takes time is the real way there,
// driven by the squad as any vehicle drives. Nothing is stood in place by hand once the dispatch has a vehicle.
const bases = [-213, 30000], stocks = bill(1e9, 1e9, 1e9, 1e9);
// The constructor of the templates without its supply pieces: a builder that carries nothing.
const bare = () => { const truck = createStructuredTemplate('construction-truck'); return { ...truck, components: truck.components.filter(part => part.kind !== 'supply') }; };

function setup(t) {
  const room = rehearsal(bases, stocks, { fog: false }), f = onField(t, room), player = room.join('Construtora'), world = room.world,
    design = createStructuredTemplate('guard-post'), cost = designBill(compileStructuredConstruction(design)), faction = room.faction(room.players.get(player.playerId));
  const x = id => room.position(world.actor(id)), unit = id => room.factionView(player.playerId).units.find(u => u.id === id),
    // A builder of the faction's, out of the player's hands, and where it is put, if anywhere.
    builder = (at = null) => { const id = f.publish(player, bare()); f.run(.5); if (at !== null) f.put(id, at); return id; },
    // A works of the guard post opened where it may stand, `from` metres off the base or further, with all its material there.
    opened = (how = {}, from = 160) => { const id = f.open(player, design, { x: f.site(player, design, { from }), ...how }); room.works.pending.get(id).delivered = { ...cost }; return id; },
    // Beside what it was sent to, as the field measures it: the end of it within reach of it.
    beside = (id, span) => room.works.gap(world.actor(id), span) <= BUILD_REACH,
    // A builder given the job of a works by the dispatch, before the works has what would make the dispatch choose it.
    task = (id, work) => room.supplyDispatch.assign(world.actor(id), 'build', work);
  return { ...f, player, world, design, cost, faction, x, unit, builder, opened, beside, task,
    errand: id => room.supplyDispatch.errand(id), works: () => room.factionView(player.playerId).works,
    order: (order, data) => f.order(player, order, data), send: (type, data) => f.send(player, type, data),
    still: id => !room.players.get(player.playerId).squad.units.get(id).move && room.still(world.actor(id)) };
}

test('a works opened sends the nearest free builder there by its squad: it puts it up and stays where it stopped, and another further off stays where it is', t => {
  const f = setup(t), { room, world } = f, site = f.site(f.player, f.design), other = f.builder(), home = f.x(other), sent = f.builder(site - 70);
  const id = f.opened({ x: site }), span = constructionSpan(f.design, room.works.pending.get(id).x, 1);
  f.run(3);
  assert.deepEqual([f.errand(sent)?.kind, f.errand(sent)?.targetId, f.errand(other)], ['build', id, null], 'the nearest, not the other');
  assert.deepEqual(f.unit(sent).job, { kind: 'build', targetId: id, phase: 'go', reason: '' });
  assert.deepEqual(f.works()[0].sent, { phase: 'go', reason: '' }, 'its card says a builder is on its way');
  assert(f.until(() => world.actor(id), 120), 'it gets there and puts it up');
  assert(f.beside(sent, span), `it stands within reach, at ${f.x(sent)}`);
  f.run(1.5); assert.equal(f.errand(sent), null);
  f.run(3); const stood = f.x(sent); f.run(5);
  assert(f.still(sent) && Math.abs(f.x(sent) - stood) < .5, 'done, it stays where it is');
  assert(Math.abs(f.x(other) - home) < 1 && f.errand(other) === null, 'the other one never moved');
});

test('an automatic builder arriving from either side parks its real crane over an unfinished work before material arrives', t => {
  for (const side of [1, -1]) {
    const f = setup(t), { room, world } = f, site = f.site(f.player, f.design),
      id = f.builder(site - side * 70), at = f.opened({ x: site }), work = room.works.pending.get(at);
    // Keep the normal job open without changing its price or build pace: no material has arrived yet.
    work.delivered = bill(); f.task(id, at);
    assert(f.until(() => f.still(id) && f.errand(id)?.phase === 'work', 120), 'the ordinary squad completes its preferred approach');
    const shape = workShape(compileStructuredConstruction(work.blueprint), world.terrain, work.x, work.facing),
      target = { lo: shape.minX, hi: shape.maxX, down: false, boxes: [{ lo: shape.minX, hi: shape.maxX, top: shape.maxY }] },
      parts = [...world.plates.filter(part => part.actorId === id && part.attached !== false).map(part => part.definition),
        ...world.modules.filter(part => part.actorId === id && part.attached !== false)],
      tool = parts.find(part => part.kind === 'builder'), layout = craneLayout(tool, workFrame(tool, parts), craneSide(tool, target)),
      route = craneRoute(layout, parts, x => world.terrain.height(x), target), boxes = boxesOf(parts);
    assert(route.to.x >= target.lo && route.to.x <= target.hi, 'the real installed crane reaches the work after travelling');
    assert(Math.max(...boxes.map(box => box.hi)) <= target.lo - SITE_CLEARANCE + 1e-6 ||
      Math.min(...boxes.map(box => box.lo)) >= target.hi + SITE_CLEARANCE - 1e-6, 'the body remains outside the future structure');
    assert.equal(work.progress, 0, 'approaching does not invent material');
    work.delivered = { ...work.cost };
    assert(f.until(() => world.actor(at), 30), 'ordinary delivered material still completes the same work');
  }
});

test('a displaced preferred crane stop leaves the builder working beside the works where it stands, till the place is free', t => {
  // Beside it, facing it: its crane, at the rear, reaches it only from the other side.
  const f = setup(t), { room } = f, site = f.site(f.player, f.design), id = f.builder(site - 8),
    at = f.opened({ x: site }), squad = room.players.get(f.player.playerId).squad,
    clear = squad.clear.bind(squad), before = f.x(id);
  room.works.pending.get(at).delivered = bill(); f.task(id, at);
  let attempts = 0, taken = true;
  // A neighbouring vehicle may make clear() choose a different place, including beyond work reach.
  squad.clear = (actorId, x, ...args) => actorId === id && taken ? (attempts++, x + 100) : clear(actorId, x, ...args);
  f.run(4);
  assert(f.still(id) && Math.abs(f.x(id) - before) < .3, 'an uncertified fine stop never starts a movement');
  assert.equal(f.errand(id)?.phase, 'work', 'the permitted work is retained');
  assert(attempts > 1, 'it asks again for the place at later looks');
  // The vehicle there leaves: the builder goes where its crane reaches the works, and works there.
  taken = false;
  assert(f.until(() => Math.abs(f.x(id) - before) > 3 && f.still(id) && f.errand(id)?.phase === 'work', 30), 'it parks by its crane once the place is free');
  assert.equal(room.works.pending.get(at).progress, 0, 'parking does not provide material');
});

test('a structure taken down sends the nearest free builder, which goes on to the next one that waits for a builder', t => {
  const f = setup(t), { room, world } = f, first = f.raise(f.player, f.design), second = f.raise(f.player, f.design, { x: f.site(f.player, f.design, { from: 420 }) }),
    held = f.builder(), sent = f.builder(f.x(first) - 90), elsewhere = f.x(held);
  // The one in the player's hands is not free: the nearest free one goes to the first, and the second waits for it.
  f.order('control', { id: held });
  f.send('remove', { actorId: first }); f.send('remove', { actorId: second }); f.run(1.5);
  assert.deepEqual([f.errand(sent)?.kind, f.errand(sent)?.targetId, f.errand(held)], ['dismantle', first, null]);
  assert.deepEqual(f.unit(second).service.sent, null, 'nobody is free for the second');
  assert.deepEqual(f.unit(first).service.sent?.phase, 'go');
  assert(f.until(() => !world.actor(first), 60), 'the first is taken down');
  assert(room.works.heaps.has(first), 'and its material lies where it stood');
  f.run(1.5);
  assert.deepEqual([f.errand(sent)?.kind, f.errand(sent)?.targetId], ['dismantle', second], 'then it goes on to the second');
  assert(f.until(() => !world.actor(second), 120), 'which it takes down too');
  assert(Math.abs(f.x(held) - elsewhere) < 1, 'the one in hand stayed');
});

test('a structure moved is taken down by the builder sent to it, which then puts it up where it was moved to with the material a supply truck brings from its heap', t => {
  const f = setup(t), { room, world } = f, id = f.raise(f.player, f.design), from = f.x(id), builder = f.builder(),
    to = f.site(f.player, f.design, { from: Math.abs(from - f.player.base.x) + 300, ignore: id }), truck = f.publish(f.player, 'supply');
  assert.equal(room.record(world.actor(truck)).auto, true, 'a supply truck comes with its dispatch on');
  const moved = f.send('relocate', { actorId: id, x: to, facing: 1 }).work.id;
  f.run(1.5);
  assert.deepEqual([f.errand(builder)?.kind, f.errand(builder)?.targetId, f.errand(builder)?.then], ['dismantle', id, moved]);
  assert.deepEqual(f.works()[0].sent, { phase: 'dismantle', reason: '' }, 'its new works says its builder takes it down first');
  assert(f.until(() => !world.actor(id), 90), 'taken down where it stood');
  f.run(1.5);
  assert.deepEqual([f.errand(builder)?.kind, f.errand(builder)?.targetId], ['build', moved], 'and on to where it was moved');
  assert(f.until(() => world.actor(moved), 400), 'it stands where it was moved, of what its heap gave back');
  assert(f.beside(builder, constructionSpan(f.design, to, 1)), 'the builder by it');
});

test('an order of the player\'s to a builder on a job ends it and pauses its automatic while it lasts, and another builder in automatic takes the job over', t => {
  const f = setup(t), { room, world } = f, sent = f.builder(), other = f.builder(f.player.base.x - 200), id = f.opened(), base = f.player.base.x;
  f.run(3);
  assert.deepEqual([f.errand(sent)?.targetId, f.errand(other)], [id, null], 'the works has its builder');
  f.order('move', { ids: [sent], x: base - 60 });
  assert.equal(f.errand(sent), null, 'the order ends its job');
  assert.deepEqual([room.record(world.actor(sent)).auto, f.unit(sent).auto, f.unit(sent).job], [true, true, { kind: null, phase: 'paused', targetId: null, reason: 'manual-order' }]);
  const squad = room.players.get(f.player.playerId).squad;
  assert(Math.abs(squad.units.get(sent).move.x - (base - 60)) < 10, 'and the vehicle goes where the player sent it');
  f.run(2);
  assert.deepEqual([f.errand(other)?.targetId, f.errand(sent)], [id, null], 'the other one, in automatic, goes in its place');
  // Any other order does as much: taking it in hand.
  f.order('control', { id: other });
  assert.deepEqual([f.errand(other), room.record(world.actor(other)).auto, f.unit(other).job.reason], [null, true, 'manual-control']);
  assert(f.until(() => f.errand(sent)?.targetId === id, 30), 'once where the player sent it, it goes by itself to the works nobody is on');
});
test('a builder with no fuel for the way waits for some and says so, and goes once it has it', t => {
  const f = setup(t), { room, world } = f, away = f.player.base.x - 400, builder = f.builder(away),
    tanks = f.parts(builder, 'fuel'), full = tanks.map(tank => tank.fuelLitres);
  for (const tank of tanks) f.set(tank, { fuelLitres: 0 });
  const id = f.opened(); f.task(builder, id); f.run(3);
  assert.deepEqual(f.unit(builder).job, { kind: 'build', targetId: id, phase: 'go', reason: 'waiting-fuel' });
  assert.deepEqual(f.works()[0].sent, { phase: 'go', reason: 'waiting-fuel' });
  assert(Math.abs(f.x(builder) - away) < 1, 'it does not go');
  tanks.forEach((tank, i) => f.set(tank, { fuelLitres: full[i] }));
  assert(f.until(() => world.actor(id), 180), 'fuelled, it goes and puts it up');
  assert.equal(room.works.pending.size, 0);
});

// A structure taken down by the constructor of the templates, which carries supplies too, with a supply truck of the dispatch
// in the base, published first so that it is the first to look for a job. The constructor stands in automatic or out of it as
// `auto` says, and `out` of the base, on the way to the structure, with nothing aboard, if so; and `watch` steps the
// field until `done`, saying whether the truck was ever sent for the heap (`sent`), and while the constructor loaded it (`early`).
function takedown(t, { design = 'guard-post', auto = true, out = false, crates = true } = {}) {
  const f = setup(t), { room, world } = f, id = f.raise(f.player, design), truck = f.publish(f.player, 'supply'),
    constructor = crates ? f.publish(f.player, 'construction-truck') : f.builder();
  if (!auto) f.send('auto', { actorId: constructor, on: false });
  if (out) {
    const base = f.player.base.x;
    f.put(constructor, base + Math.sign(f.x(id) - base) * (BASE_RADIUS + 20)); room.unload(room.serving(constructor), bill());
  }
  f.run(2);
  const carried = who => supplied(carriedBy(room.serving(who)).carried), parked = f.x(truck);
  let sent = false, early = false;
  const watch = (done, seconds) => f.until(() => {
    const trip = room.supplyDispatch.jobs.get(truck), now = trip?.targetId === id || trip?.source === id;
    sent ||= now; early ||= now && f.errand(constructor)?.phase === 'load';
    return done();
  }, seconds);
  f.send('remove', { actorId: id });
  return { ...f, id, truck, constructor, carried, parked, watch, sent: () => sent, early: () => early, value: () => room.works.heaps.get(id)?.stock,
    heap: () => room.works.heaps.has(id), gone: () => !world.actor(id) };
}

// Whether the crane of a builder as it stands now reaches a heap, as the screens draw the pile (cargo-art.ts) and the crane
// (work-arm.ts): its hook over the pile, and over its own supply piece.
function craneOverHeap(f, id, heap) {
  const { world } = f, { width, height } = pileSize(pileLook(heap.stock)), lo = heap.x - width / 2, hi = heap.x + width / 2,
    target = { lo, hi, down: false, boxes: [{ lo, hi, top: world.terrain.height(heap.x) + height }] },
    parts = [...world.plates.filter(part => part.actorId === id && part.attached !== false).map(part => part.definition),
      ...world.modules.filter(part => part.actorId === id && part.attached !== false)],
    tool = parts.find(part => part.kind === 'builder'), layout = craneLayout(tool, workFrame(tool, parts), craneSide(tool, target)),
    route = craneRoute(layout, parts, x => world.terrain.height(x), target);
  return route.to.x >= lo - 1e-6 && route.to.x <= hi + 1e-6 && [route.from, route.to].every(point => Math.abs(point.x - layout.pivot.x) <= route.reach + 1e-9);
}

test('a constructor of the dispatch that takes a structure down loads its heap there and takes it to the base, and no truck is sent for it', t => {
  const f = takedown(t), { room, world, faction, constructor } = f;
  assert(f.watch(f.gone, 90), 'taken down');
  const value = { ...f.value() }, before = { ...faction.stock };
  f.run(1.5);
  assert.deepEqual([f.errand(constructor)?.phase, room.supplyDispatch.view(constructor)], ['load', { kind: 'dismantle', phase: 'load', targetId: f.id, reason: '' }],
    'it loads the heap where it stands');
  assert(f.watch(() => f.still(constructor) && craneOverHeap(f, constructor, room.works.heaps.get(f.id)), 20), 'where its crane reaches the heap');
  assert(f.watch(() => !f.heap(), 60), 'all of it aboard');
  assert(f.watch(() => room.atBase(faction, world.actor(constructor)) && !billTotal(f.carried(constructor)), 120), 'and unloaded in the base');
  // The fuel stock also fills its tank in the base: only the materials are counted.
  for (const material of STOCK_IDS.filter(id => id !== 'combustivel'))
    assert(Math.abs(faction.stock[material] - before[material] - value[material]) < 1, `${material}: what lay in the heap went to the stocks`);
  assert(!f.sent() && Math.abs(f.x(f.truck) - f.parked) < 1, 'the truck was never sent for it');
});

test('a constructor out of automatic is sent to nothing; put beside a structure being taken down, it takes it down, loads its heap and stays there with it, and no truck is sent for it', t => {
  const f = takedown(t, { auto: false, out: true }), { constructor } = f;
  assert.deepEqual(f.carried(constructor), bill(), 'it comes with nothing aboard');
  f.watch(() => false, 5);
  assert.deepEqual([f.errand(constructor), f.unit(f.id).service.sent], [null, null], 'out of automatic, nobody sends it');
  // The player drives it there.
  const side = Math.sign(f.x(constructor) - f.x(f.id));
  f.order('move', { ids: [constructor], x: f.x(f.id) + side * 8 });
  assert(f.watch(f.gone, 90), 'taken down');
  const value = { ...f.value() }, stood = f.x(constructor);
  assert(f.watch(() => !f.heap(), 60), 'all of it aboard');
  f.watch(() => false, 10);
  assert(f.still(constructor) && Math.abs(f.x(constructor) - stood) < .5 && f.errand(constructor) === null, 'done, it stays where it is');
  for (const material of STOCK_IDS) assert(Math.abs(f.carried(constructor)[material] - value[material]) < 1, `${material}: aboard`);
  assert(!f.sent() && Math.abs(f.x(f.truck) - f.parked) < 1, 'the truck was never sent for it');
});

test('a heap more than a constructor of the dispatch takes: it takes home all it can, and a truck fetches the rest', t => {
  const f = takedown(t, { design: 'outpost' }), { room, constructor } = f;
  assert(f.watch(f.gone, 90), 'taken down');
  f.run(1.5);
  assert.equal(f.errand(constructor)?.phase, 'load');
  assert(f.watch(() => !f.errand(constructor), 120), 'it loads as far as it goes');
  assert(f.heap() && !room.supplyDispatch.spare(room.world.actor(constructor)), 'full, with some of the heap left');
  assert.equal(room.supplyDispatch.jobs.get(constructor)?.phase, 'return', 'it goes home with it');
  assert(!f.early(), 'no truck was sent while it loaded');
  assert(f.watch(f.sent, 5), 'then a truck is sent for the rest');
});

test('a builder with no supply pieces leaves the heap of what it took down to the trucks', t => {
  const f = takedown(t, { crates: false }), { constructor } = f;
  assert(f.watch(f.gone, 90), 'taken down');
  assert(f.watch(f.sent, 5), 'a truck is sent for its heap');
  assert.equal(f.errand(constructor), null);
});

test('a supply truck and a constructor come in automatic; on no job in its base either carries nothing, and out of automatic it is filled there', t => {
  const f = setup(t), { room, world, faction } = f, truck = f.publish(f.player, 'supply');
  assert.deepEqual([room.record(world.actor(truck)).auto, f.unit(truck).auto], [true, true]);
  f.run(2);
  const carried = id => supplied(carriedBy(room.serving(id)).carried);
  assert.deepEqual(carried(truck), bill(), 'it takes nothing on by itself'); assert.equal(f.unit(truck).load, null);
  // Whatever it has aboard in its base on no trip goes back to the stocks.
  const crates = room.serving(truck), given = bill(500, 0, 0, 40), before = { ...faction.stock };
  for (const id of STOCK_IDS) if (given[id] > 0) room.carry(stow(crates, SUPPLIED[id], given[id]).changed);
  f.run(2);
  assert.deepEqual([carried(truck), faction.stock], [bill(), billSum(before, given)]);
  // Out of automatic, it is filled at the base as the truck the player takes where it serves.
  f.send('auto', { actorId: truck, on: false }); f.run(2);
  assert(billTotal(carried(truck)) > 0 && f.unit(truck).auto === false);
  // A constructor carries supplies too, and builds: it comes in automatic as well, and takes nothing on by itself.
  const constructor = f.publish(f.player, 'construction-truck'); f.run(2);
  assert.deepEqual([room.record(world.actor(constructor)).auto, f.unit(constructor).auto, f.unit(constructor).job.phase], [true, true, 'idle']);
  assert.deepEqual(carried(constructor), bill());
  f.send('auto', { actorId: constructor, on: false }); f.run(2);
  assert(billTotal(carried(constructor)) > 0, 'out of automatic, it is filled there');
});

// The constructor of the templates, in automatic in its base, given the player's orders to move one after another (`obey`): what
// it carries as it goes (`aboard`), and how many times what it carries changed in its base and turned from more to less or the
// other way there, while the orders held it and `after` seconds after each.
function told(t) {
  const f = setup(t), { room, world, faction } = f, id = f.publish(f.player, 'construction-truck'),
    aboard = () => Math.round(billTotal(supplied(carriedBy(room.serving(id)).carried))), inBase = () => room.atBase(faction, world.actor(id));
  let last = null, way = 0, changes = 0, turns = 0;
  const look = () => {
    const now = aboard();
    if (last !== null && now !== last && inBase()) { const sign = Math.sign(now - last); changes++; if (way && sign !== way) turns++; way = sign; }
    last = now;
  };
  const obey = (x, after = 3) => {
    f.order('move', { ids: [id], x });
    assert(f.until(() => (look(), f.still(id)), 120), `it gets to ${x}`);
    f.until(() => (look(), false), after);
  };
  f.run(1.5); look();
  return { ...f, id, aboard, inBase, obey, changes: () => changes, turns: () => turns };
}

test('a constructor in automatic told to move about its base is neither filled nor emptied there, and told out of it goes empty and stays where it stops', t => {
  const f = told(t), base = f.faction.base.x;
  assert.deepEqual([f.room.record(f.world.actor(f.id)).auto, f.aboard()], [true, 0], 'in automatic in its base on no job, it carries nothing');
  f.obey(base + 60); f.obey(base - 40); f.obey(base + 20);
  assert.deepEqual([f.changes(), f.aboard()], [0, 0], 'the base never fills what its dispatch empties');
  const out = base + BASE_RADIUS + 80;
  f.obey(out, 10);
  assert(!f.inBase() && Math.abs(f.x(f.id) - out) < 3, `it stays where it was sent, at ${f.x(f.id)}`);
  assert.deepEqual([f.aboard(), f.room.supplyDispatch.jobs.has(f.id), f.unit(f.id).job.phase], [0, false, 'idle'], 'empty, on no way home');
  f.obey(base - 20);
  assert.deepEqual([f.changes(), f.aboard()], [0, 0], 'and back in its base as well');
});

test('a constructor in automatic loading for a works, told to move about its base, turns its load there once at most and takes the works what it lacks after', t => {
  const f = told(t), { room } = f, base = f.faction.base.x, work = f.open(f.player, f.design, { x: f.site(f.player, f.design, { from: 400 }) });
  assert(f.until(() => f.errand(f.id)?.targetId === work && f.aboard() > 0, 5), 'sent to the works, it loads at the base what that lacks');
  const loaded = f.aboard(), away = Math.sign(base - room.works.pending.get(work).x);
  f.obey(base + away * 60); f.obey(base + away * 20);
  assert(f.turns() <= 1, `its load turned ${f.turns()} times in the base`);
  assert(f.until(() => f.errand(f.id)?.targetId === work && !f.inBase(), 60), 'let go, it goes on to the works');
  assert(Math.abs(f.aboard() - loaded) <= 2, `with what the works lacks: ${f.aboard()} of ${loaded}`);
});
