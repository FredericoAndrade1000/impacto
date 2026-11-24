import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { bill, billSum, carriedBy, load, refined, BASE_RADIUS, CALM_SECONDS, LOAD_REACH, REFINE_RATE, POST_REFINE_RATE, TRANSFER_RATE } from '../src/economy.ts';
import { reserveState } from '../src/component-volume.ts';
import { depositsNear } from '../src/deposits.ts';
import { POST_RADIUS, POST_BILL, POST_EYE, POST_SIGHT } from '../src/territory.ts';
import { jobText, haulText, unitServices, repairNeedsOrder } from '../src/faction-ui.ts';
import { onField } from './helpers/field.js';

// A field with a faction whose base is at `at[0]`, and a post of it raised at once 3 to 4 km off its base, clear of the sites
// of the ground (`post`, standing at `at`); and what a test does with vehicles there: one published at the base out of
// automatic — unless it is to stay in it — and stood at a place (`vehicle`), what a piece of it carries (`stow`, `cargo`,
// `aboard`), and the faction's view of it (`unit`) and of the post (`told`).
function setup(t, stock = bill(1e6, 1e6, 1e6, 1e6)) {
  const room = rehearsal([-213, 40000], stock, { fog: false }), f = onField(t, room), player = room.join('Posto QA'), faction = room.faction(room.players.get(player.playerId)),
    base = faction.base.x, clear = x => !depositsNear(room.deposits, x, POST_RADIUS + 2 * LOAD_REACH).length;
  let x = base + 4000;
  while (!clear(x)) x -= 7;
  const post = f.send(player, 'post', { x, facing: 1, instant: true }).post.id, at = faction.posts[0].x,
    vehicle = (design, where, auto = false) => {
      const id = f.publish(player, design);
      if (!auto && room.records.get(id).auto) f.send(player, 'auto', { actorId: id, on: false });
      if (where !== undefined) f.put(id, where);
      return id;
    },
    piece = (id, kind) => room.world.modules.find(m => m.actorId === id && m.kind === kind);
  return { ...f, room, player, faction, base, post, at, vehicle, piece,
    stow: (id, kind, cargo) => f.set(piece(id, kind), { cargo }),
    cargo: id => carriedBy(room.pieces(id)).carried, aboard: id => carriedBy(room.crates(id)).carried,
    unit: id => room.factionView(player.playerId).units.find(u => u.id === id),
    told: () => room.factionView(player.playerId).posts.find(each => each.id === post) };
}

test('a post is a place of its faction, not a construction: nothing of it is on the field, and it is told where it stands, as far as it serves and sees', t => {
  const f = setup(t), { room, world, faction, post, at } = f;
  assert.deepEqual(POST_BILL, bill(22500, 2500, 2500, 0), 'a quarter of what a faction is founded with, of each material, and no fuel');
  assert(!world.actor(post), 'no body: nothing meets it, nobody shoots it, it is never a wreck');
  assert.equal(room.records.has(post), false);
  const view = room.factionView(f.player.playerId);
  assert.deepEqual(view.counts, { vehicles: 0, fixed: 0 }, 'no structure of the faction');
  assert(!view.units.some(unit => unit.id === post));
  assert.deepEqual(f.told(), { id: post, x: at, facing: 1, radius: POST_RADIUS, eye: POST_EYE, sight: POST_SIGHT, takedown: null, siege: null });
  assert.deepEqual(faction.posts[0], { id: post, x: at, facing: 1, yard: load(), refinedAt: null, salvage: POST_BILL, takedown: null, capture: null });
});

test('a post is a base for loads: a hauler unloads into its yard, and its refinery makes stock of it at a quarter of the pace of the base, the two adding up', t => {
  const f = setup(t), { room, faction, base, post, at } = f;
  assert.equal(POST_REFINE_RATE, TRANSFER_RATE);
  assert.deepEqual(room.depots(faction), [{ x: base, radius: BASE_RADIUS, post: null }, { x: at, radius: POST_RADIUS, post }]);
  const there = f.vehicle('truck'), home = f.vehicle('truck'), had = { ...faction.stock }, yard = faction.posts[0].yard;
  f.stow(there, 'hopper', { ferro: 3000 }); f.stow(home, 'hopper', { ferro: 6000 });
  f.put(there, at + 20); f.put(home, base + 30);
  // Each unloaded where it stands, into the yard there: the post's into its own, the base's into the faction's.
  assert.deepEqual([f.cargo(there), f.cargo(home)], [load(), load()]);
  const refinedNow = () => faction.stock.ferro - had.ferro;
  assert(yard.ferro > 0 && yard.ferro < 3000, 'the post refines what came');
  assert(Math.abs(yard.ferro + faction.yard.ferro + refinedNow() - 9000) < 1e-6, 'nothing is lost nor made');
  assert.deepEqual([f.unit(there).atPost, f.unit(there).atBase, f.unit(home).atPost], [true, false, undefined]);
  assert.deepEqual(room.factionView(f.player.playerId).yard, load(Math.round(yard.ferro + faction.yard.ferro)), 'the faction is told all its yards together');
  // A thousand units a second at the base and a quarter of that at the post: they add up.
  const from = { post: yard.ferro, base: faction.yard.ferro }, time = room.world.time;
  f.run(2);
  const seconds = room.world.time - time;
  assert(Math.abs(from.post - yard.ferro - POST_REFINE_RATE * seconds) <= POST_REFINE_RATE * 1.01, `the post took ${(from.post - yard.ferro).toFixed(0)} in ${seconds.toFixed(1)} s`);
  assert(Math.abs(from.base - faction.yard.ferro - REFINE_RATE * seconds) <= REFINE_RATE * 1.01, `the base took ${(from.base - faction.yard.ferro).toFixed(0)} in ${seconds.toFixed(1)} s`);
  f.run(3000 / POST_REFINE_RATE);
  assert.deepEqual([yard, faction.yard], [load(), load()]);
  assert(Math.abs(refinedNow() - 9000) < 1e-6, 'all of it is in the stocks of the faction');
  // A hauler takes a load home to the nearer of the base and the post (Squad.haul).
  const side = room.players.get(f.player.playerId).squad.side;
  f.put(there, at + 800); assert.deepEqual(side.depot(there), { x: at, radius: POST_RADIUS });
  f.put(there, base + 1200); assert.deepEqual(side.depot(there), { x: base, radius: BASE_RADIUS });
});

test('a post rearms, refuels and repairs from the stocks of the faction, as the base does, and nothing does so a little way off it', t => {
  const f = setup(t), { room, faction, at } = f, tank = f.vehicle('scout', at - 25), off = f.vehicle('scout', at + POST_RADIUS + 60),
    ammo = reserveState(room.world.actor(tank).blueprint.modules.find(m => m.kind === 'ammo')).rounds;
  for (const id of [tank, off]) {
    f.set(f.piece(id, 'ammo'), { rounds: 2 }); f.set(f.piece(id, 'fuel'), { fuelLitres: 40 });
    f.set(f.piece(id, 'engine'), { health: f.piece(id, 'engine').maxHealth * .5 });
  }
  f.run(1);
  const due = f.unit(tank), had = { ...faction.stock };
  assert.deepEqual(due.point, { supplier: null, stock: null, held: '', resupply: due.rearm }, 'the stocks of the faction serve it there');
  assert.equal(f.unit(off).point, null, 'out of the reach of the post nothing does');
  f.run(CALM_SECONDS + 1);
  const served = f.unit(tank);
  assert.deepEqual([served.rearm, f.piece(tank, 'ammo').rounds, served.service?.kind], [bill(), ammo, 'repair']);
  assert.deepEqual(faction.stock, billSum(billSum(had, due.rearm, -1), due.repair, -1), 'paid from the stocks, once');
  assert.equal(f.piece(off, 'ammo').rounds, 2);
  f.run(due.repairSeconds + 1);
  assert.equal(f.piece(tank, 'engine').health, f.piece(tank, 'engine').maxHealth);
});

test('a supply vehicle in automatic with nothing to do takes what it carries to the nearer of the base and the post, and gives it back there', t => {
  const f = setup(t), { room, faction, at } = f, supply = f.vehicle('supply', undefined, true), had = faction.stock.ferro;
  f.stow(supply, 'supply', { ferro: 400 }); f.put(supply, at + 600);
  const job = () => room.supplyDispatch.jobs.get(supply), move = () => room.players.get(f.player.playerId).squad.units.get(supply).move;
  assert(f.until(() => job()?.phase === 'return', 5), 'it goes home');
  assert(Math.abs(move().x - at) <= POST_RADIUS, `to the post: ${move().x} for ${at}`);
  assert.deepEqual(room.supplyDispatch.view(supply), { kind: null, phase: 'return', targetId: null, reason: '', post: true });
  assert.equal(jobText(f.unit(supply)), 'voltando ao posto com a carga restante');
  assert(f.until(() => faction.stock.ferro - had >= 400 - 1e-6, 120), 'the supplies it carried are back in the stocks');
  assert.deepEqual(f.aboard(supply), load());
  assert(Math.abs(room.position(room.world.actor(supply)) - at) <= POST_RADIUS);
});

test('vehicles are fabricated, dismantled and modified at the base alone: a post serves, it makes and unmakes nothing', t => {
  const f = setup(t), { room, at } = f, lorry = f.vehicle('truck', at + 10);
  assert.throws(() => f.publish(f.player, 'scout', { x: at }), { message: 'Fabrique dentro da base.' });
  assert.throws(() => f.send(f.player, 'remove', { actorId: lorry }), { message: 'Leve a construção até a base para desmontar.' });
  assert.equal(f.unit(lorry).atBase, false);
  assert(room.world.actor(lorry), 'it stands where it was');
});

test('a post is taken down by a builder of its faction beside it: it serves no longer meanwhile, gives back what it was put up with in a heap, and its yard goes into the stocks', t => {
  const f = setup(t), { room, faction, post, at } = f, truck = f.vehicle('truck');
  f.stow(truck, 'hopper', { ferro: 6000 }); f.put(truck, at + 15);
  const yard = faction.posts[0].yard;
  assert(yard.ferro > 4000, 'unloaded there');
  // Asked, it is being taken down: it serves no longer, and a load brought there stays aboard.
  const asked = f.send(f.player, 'remove-post', { postId: post });
  assert.deepEqual(asked, { dismantling: post, seconds: 0, value: POST_BILL });
  assert.throws(() => f.send(f.player, 'remove-post', { postId: post }), { message: 'Esse posto já está sendo desmontado.' });
  assert.deepEqual(room.depots(faction).map(place => place.post), [null]);
  const left = { ...yard };
  f.stow(truck, 'hopper', { ferro: 500 }); f.run(2);
  assert.deepEqual([f.cargo(truck), f.unit(truck).atPost, yard], [load(500), undefined, left], 'nothing unloaded, nothing refined');
  assert.deepEqual(f.told().takedown, { progress: 0, seconds: 0, building: false, sent: null });
  // Kept, it serves again; asked again, a builder in automatic goes there and takes it down.
  assert.deepEqual(f.send(f.player, 'keep-post', { postId: post }), { kept: post });
  assert.deepEqual(room.depots(faction).map(place => place.post), [null, post]);
  assert.throws(() => f.send(f.player, 'keep-post', { postId: post }), { message: 'Esse posto não está sendo desmontado.' });
  f.send(f.player, 'remove-post', { postId: post });
  const builder = f.vehicle('construction-truck', at + 600, true), stock = { ...faction.stock }, waiting = { ...yard };
  assert(f.until(() => !faction.posts.length, 120), 'taken down');
  assert.equal(room.supplyDispatch.jobs.get(builder)?.kind, 'dismantle', 'by the builder sent to it');
  const heap = room.works.heaps.get(post);
  assert.deepEqual([heap.x, heap.stock], [at, POST_BILL], 'all it was put up with lies where it stood');
  const gained = billSum(faction.stock, stock, -1), made = refined(waiting);
  assert(Math.abs(gained.ferro - made.ferro) < 1e-6, `its yard went into the stocks, refined: ${gained.ferro} for ${made.ferro}`);
  assert.deepEqual(room.depots(faction).map(place => place.post), [null]);
  assert.deepEqual(room.factionView(f.player.playerId).posts, []);
  assert.throws(() => f.send(f.player, 'remove-post', { postId: post }), { message: 'Esse posto não é da sua facção.' });
});

test('a faction away calls its vehicles to the nearer of its base and its posts, and shelters them there', t => {
  const f = setup(t), { room, faction, base, at } = f, near = f.vehicle('scout', at + 400), home = f.vehicle('scout', base + 700),
    squad = room.players.get(f.player.playerId).squad;
  room.disconnect(f.player.playerId); f.run(.2);
  assert(Math.abs(squad.units.get(near).move.x - at) <= POST_RADIUS, 'to the post');
  assert(Math.abs(squad.units.get(home).move.x - base) <= BASE_RADIUS, 'to the base');
  assert(f.until(() => room.atDepot(faction, room.world.actor(near)) && room.still(room.world.actor(near)), 60), 'it gets there');
  faction.shelter = room.field.time; f.run(.2);
  assert(room.sheltered.has(room.world.actor(near)), 'sheltered at the post');
});

test('a vehicle is told when it loads, unloads or is mended at a post rather than at its base', () => {
  const job = (kind, phase, post) => ({ job: { kind, phase, targetId: null, reason: '', ...(post ? { post: true } : {}) } });
  assert.deepEqual(['collect', 'home', 'unload'].map(phase => jobText(job('haul', phase, true))), ['preparando transporte no posto', 'levando a carga ao posto', 'descarregando no posto']);
  assert.deepEqual(['collect', 'home', 'unload'].map(phase => jobText(job('haul', phase, false))), ['preparando transporte na base', 'levando a carga à base', 'descarregando na base']);
  assert.equal(jobText(job('rearm', 'collect', true)), 'buscando suprimentos no posto');
  assert.equal(jobText({ ...job(null, 'return', true), atPost: true, supplies: bill(10) }), 'devolvendo suprimentos no posto');
  assert.equal(haulText({ phase: 'home' }, null, { post: true }), 'transportando · voltando ao posto');
  assert.equal(unitServices({ service: { kind: 'repair', cost: bill(5), payer: null }, atBase: false, atPost: true }, { stock: bill() }, { hand: true }).held,
    'Em reparo no posto: acelere para cancelar.');
  assert.equal(repairNeedsOrder({ atBase: false, atPost: true, declined: false }, true), false, 'in a post a vehicle in hand is mended by itself, as in the base');
  assert.deepEqual(unitServices({ atBase: false, atPost: true, cargo: load(100), point: null }, { stock: bill() }).jobs, [], 'nothing is tipped out where it is unloaded whole');
});
