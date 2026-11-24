import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { bill, LOAD_REACH } from '../src/economy.ts';
import { depositsNear } from '../src/deposits.ts';
import { BASE_TERRITORY, POST_TERRITORY, POST_LIMIT, POST_SPACING, POST_RADIUS, POST_NAME, POST_BILL, OUTSIDE, FOREIGN, territoryOf, territoryRefusal, postRefusal, postSpan, meeting } from '../src/territory.ts';
import { siteRefusal } from '../src/construction-site.ts';
import { constructionSpan } from '../server/field-construction.ts';
import { onField } from './helpers/field.js';

const stocks = bill(1e9, 1e9, 1e9, 1e9);

// A field with a faction whose base is at `at[0]` — and the others, if any, at the rest —, and what a test does with posts
// there: the farthest place from its base, `from` to `to` metres off it to one side, clear of the sites of the ground for a
// post (`spot`), a post opened there, and one raised at once there.
function setup(t, { at = [-213, 40000], fog = false, names = ['Posto QA'] } = {}) {
  const room = rehearsal(at, stocks, { fog }), f = onField(t, room), players = names.map(name => room.join(name)),
    [player] = players, faction = room.faction(room.players.get(player.playerId)),
    clear = x => !depositsNear(room.deposits, x, POST_RADIUS + LOAD_REACH).length,
    spot = (from, to, side = 1, who = player) => {
      const home = room.faction(room.players.get(who.playerId)).base.x;
      for (let d = to; d >= from; d -= 7) if (clear(home + side * d)) return home + side * d;
      throw new Error('The fixture needs a place clear of sites.');
    },
    post = (x, who = player, ticket = undefined) => f.send(who, 'post', { x, facing: 1, instant: true, ...(ticket ? { ticket } : {}) }),
    raised = (x, who = player) => { const answer = post(x, who); assert(answer.post, `a post at ${x}: ${JSON.stringify(answer)}`); return answer.post.id; };
  return { ...f, room, players, player, faction, spot, post, raised, clear };
}

test('a territory is the union of 5 km about the base and 2 km about each post, in spans of the field', () => {
  assert.deepEqual([BASE_TERRITORY, POST_TERRITORY, POST_LIMIT, POST_SPACING], [5000, 2000, 4, 1500]);
  assert.deepEqual(territoryOf(0), [[-5000, 5000]]);
  assert.deepEqual(territoryOf(0, [4500, 8000]), [[-5000, 10000]], 'posts that overlap the base and each other make one span');
  assert.deepEqual(territoryOf(0, [-12000]), [[-14000, -10000], [-5000, 5000]], 'a post off the base holds its own span');
  assert.deepEqual(territoryOf(null, [100]), [[-1900, 2100]], 'a faction with no base holds what its posts hold');
  assert.deepEqual(territoryOf(null), []);
  assert.deepEqual(meeting([[-5000, 5000], [8000, 12000]], [[4000, 9000]]), [[4000, 5000], [8000, 9000]], 'of another territory, what was explored');
});

test('a structure stands within its own territory, at its edge too, and nowhere in another faction’s', () => {
  const own = [[-5000, 5000]], foreign = [[[7000, 9000]], [[-20000, -6000]]], span = (minX, wide = 4) => ({ minX, maxX: minX + wide });
  assert.equal(territoryRefusal(span(0), own, foreign), '');
  assert.equal(territoryRefusal(span(4996), own, foreign), '', 'its far end at the edge');
  assert.equal(territoryRefusal(span(4997), own, foreign), OUTSIDE);
  assert.equal(territoryRefusal(span(-5004), own, foreign), OUTSIDE);
  assert.equal(territoryRefusal(span(0), [[-5000, 5000], [6996, 9000]], foreign), '', 'in another span of its own');
  assert.equal(territoryRefusal(span(6997), [[-5000, 9000]], foreign), FOREIGN, 'where its own and another’s overlap');
  assert.equal(territoryRefusal(span(8000), [[-5000, 9000]], [[[7000, 9000]]]), FOREIGN);
  assert.equal(territoryRefusal(span(6995, 5), [[-5000, 9000]], [[[7000, 9000]]]), '', 'touching the edge of another’s is standing out of it');
  assert.equal(OUTSIDE, 'Fora do território da sua facção.');
  assert.equal(FOREIGN, 'No território de outra facção.');
  // The territory is read after the ground is known, and before the base and the slope.
  const flat = { height: () => 0 }, limits = { minX: -1e5, maxX: 1e5 };
  assert.equal(siteRefusal({ span: span(6000), limits, ground: flat, explored: [[0, 100]], own }), 'Terreno desconhecido: escolha chão já visto.');
  assert.equal(siteRefusal({ span: span(6000), limits, ground: flat, own }), OUTSIDE);
  assert.equal(siteRefusal({ span: span(10), limits, ground: flat, home: 0, own }), 'Perto demais da base: no mínimo 150 m.');
  assert.equal(siteRefusal({ span: span(6000), limits, ground: flat }), '', 'no territory read where none is given');
});

test('a post keeps 1.5 km from its base and its other posts, off the sites of the ground, and a faction has 4 at most', () => {
  assert.equal(postRefusal({ x: 1500, base: 0 }), '');
  assert.equal(postRefusal({ x: 1499, base: 0 }), 'Perto demais da base ou de outro posto: no mínimo 1,5 km.');
  assert.equal(postRefusal({ x: -3000, base: 0, posts: [-4499] }), 'Perto demais da base ou de outro posto: no mínimo 1,5 km.');
  assert.equal(postRefusal({ x: -3000, base: 0, posts: [-4500] }), '');
  assert.equal(postRefusal({ x: 3000, sites: [{ x: 3000 + POST_RADIUS + LOAD_REACH }] }), 'Perto demais de uma jazida: o posto descarregaria onde os caminhões carregam.');
  assert.equal(postRefusal({ x: 3000, sites: [{ x: 3000 + POST_RADIUS + LOAD_REACH + .5 }] }), '');
  assert.equal(postRefusal({ x: 30000, posts: [1, 2, 3, 4] }), 'Sua facção já tem 4 postos.');
  // A post is a place, named so, over the ground it serves, and costs what it costs wherever it stands.
  assert.equal(POST_NAME, 'Posto');
  assert.deepEqual(postSpan(3000), { minX: 3000 - POST_RADIUS, maxX: 3000 + POST_RADIUS });
  assert.deepEqual(POST_BILL, bill(22500, 2500, 2500, 0));
});

test('works and posts are opened only in the territory of their faction, and a post opened is answered once, as a structure', t => {
  const f = setup(t), { room, player, faction } = f, base = faction.base.x, guard = createStructuredTemplate('guard-post');
  assert.throws(() => f.send(player, 'spawn', { blueprint: guard, x: base + BASE_TERRITORY + 50, facing: 1 }), { message: OUTSIDE });
  assert.throws(() => f.post(f.spot(BASE_TERRITORY + 50, BASE_TERRITORY + 600)), { message: OUTSIDE });
  assert.throws(() => f.post(f.spot(300, 1400)), { message: 'Perto demais da base ou de outro posto: no mínimo 1,5 km.' });
  const near = room.deposits.find(site => site.x > base + POST_SPACING + 100 && site.x < base + BASE_TERRITORY - 100);
  assert.throws(() => f.post(near.x), { message: 'Perto demais de uma jazida: o posto descarregaria onde os caminhões carregam.' });
  // Opened, it is a works of a post that costs nothing then, and the same ticket is answered as it was.
  const stock = { ...faction.stock }, x = f.spot(3000, 4000), asked = { x, facing: 1, ticket: 'first-post' }, answer = f.send(player, 'post', asked);
  assert.deepEqual(answer, { work: { id: answer.work.id, name: POST_NAME, x }, cost: POST_BILL, seconds: 0 });
  assert.deepEqual(f.send(player, 'post', asked), answer);
  assert.deepEqual(faction.stock, stock);
  const work = room.factionView(player.playerId).works.find(each => each.id === answer.work.id);
  assert.deepEqual([work.post, work.name, work.cost, Object.hasOwn(work, 'blueprint')], [true, POST_NAME, POST_BILL, false], 'of no design');
  assert.deepEqual(room.factionView(player.playerId).counts, { vehicles: 0, fixed: 0 }, 'nor a structure for the limit of the faction');
  assert.deepEqual(room.factionView(player.playerId).posts, [], 'a works is no post yet');
  // Another post keeps from the works of one as from a post.
  assert.throws(() => f.post(x - POST_SPACING + 10), { message: 'Perto demais da base ou de outro posto: no mínimo 1,5 km.' });
});

test('a post keeps off the veins where trucks load, emptied or not: every site of the ground holds one', t => {
  const f = setup(t), { room, faction } = f, base = faction.base.x, NEAR = 'Perto demais de uma jazida: o posto descarregaria onde os caminhões carregam.',
    vein = room.deposits.find(site => site.x > base + POST_SPACING + 100 && site.x < base + BASE_TERRITORY - 100),
    tried = x => { try { f.post(x); return ''; } catch (error) { return error.message; } };
  assert.equal(tried(vein.x + 60), NEAR);
  // Emptied, the vein comes back, and trucks load there again.
  room.veins.set(vein.id, 0); room.extracted.delete(vein.id);
  assert.equal(tried(vein.x + 60), NEAR);
});

test('a post raised widens the territory, and the next one is raised at its edge: a faction grows a post at a time, 4 at most', t => {
  const f = setup(t), { room, player, faction } = f, base = faction.base.x, ids = [];
  let edge = base + BASE_TERRITORY;
  for (let i = 0; i < POST_LIMIT; i++) {
    // Its ground is in the territory: its middle no nearer the edge than it serves.
    assert.throws(() => f.post(f.spot(edge - base - POST_RADIUS + 1, edge - base - 1)), { message: OUTSIDE });
    const x = f.spot(edge - base - 450, edge - base - POST_RADIUS);
    ids.push(f.raised(x)); edge = x + POST_TERRITORY;
    assert.deepEqual(room.territory(faction), [[base - BASE_TERRITORY, edge]]);
  }
  const view = room.factionView(player.playerId);
  assert.deepEqual(view.posts.map(post => post.id), ids);
  assert(!view.units.some(unit => unit.id === ids[0]), 'a post is no construction of the faction');
  assert.throws(() => f.post(f.spot(BASE_TERRITORY - 400, BASE_TERRITORY - POST_RADIUS, -1)), { message: 'Sua facção já tem 4 postos.' });
  // A works of a structure beyond the base stands in what the posts hold.
  const guard = createStructuredTemplate('guard-post'), x = edge - 300;
  assert.equal(f.send(player, 'spawn', { blueprint: guard, x, facing: 1 }).work.x, x);
});

test('paid post capital remains faction wealth while standing, being dismantled and returned as a heap', t => {
  const f = setup(t), { room, player, faction } = f,
    wealth = () => { f.run(1.1); return room.factionView(player.playerId).ranking.find(row => row.ref === faction.ref).wealth; },
    before = wealth(), id = f.raised(f.spot(3500, 4000));
  assert.equal(wealth(), before, 'completing a paid post does not erase its recoverable capital');
  f.send(player, 'remove-post', { postId: id });
  assert.equal(wealth(), before, 'taking down a post keeps its capital until it becomes a heap');
  room.lowered(room.post(id));
  assert.equal(wealth(), before, 'the returned heap replaces the post capital without counting it twice');
});

test('a post being taken down holds no territory: a works beyond it waits all put up, saying so, and is put up once the post is kept', t => {
  const f = setup(t), { room, world, player, faction } = f, base = faction.base.x, post = f.raised(f.spot(4500, 4950)),
    at = faction.posts[0].x, beyond = at + 1500, guard = createStructuredTemplate('guard-post'),
    id = f.open(player, guard, { x: beyond }), work = room.works.pending.get(id);
  assert.deepEqual(room.territory(faction), [[base - BASE_TERRITORY, at + POST_TERRITORY]]);
  f.send(player, 'remove-post', { postId: post });
  assert.deepEqual([room.posts(faction).length, room.territory(faction)], [0, [[base - BASE_TERRITORY, base + BASE_TERRITORY]]]);
  assert.deepEqual(room.factionView(player.playerId).posts.map(told => [told.id, Boolean(told.takedown)]), [[post, true]], 'it is told being taken down');
  work.delivered = { ...work.cost }; work.progress = 1; room.works.complete(work);
  assert.equal(room.works.blocked.get(id), OUTSIDE);
  assert(!world.actor(id), 'it stands as a works until its place is the faction’s again');
  f.send(player, 'keep-post', { postId: post });
  room.works.complete(work);
  assert(world.actor(id), 'put up');
});

test('a structure is never opened in the territory of another faction, and a faction is told whole territories of its own and its allies’, the others’ as far as it explored', t => {
  const f = setup(t, { at: [-213, 8787, 30000], fog: true, names: ['Primeira', 'Vizinha', 'Aliada'] }), { room, players: [one, two, three], faction } = f,
    neighbour = room.faction(room.players.get(two.playerId)), ally = room.faction(room.players.get(three.playerId)), guard = createStructuredTemplate('guard-post');
  faction.explored = [[-20000, 20000]];
  const x = 4000, span = constructionSpan(guard, x, 1);
  assert(span.maxX < faction.base.x + BASE_TERRITORY && span.minX > neighbour.base.x - BASE_TERRITORY, 'in both territories');
  assert.throws(() => f.send(one, 'spawn', { blueprint: guard, x, facing: 1 }), { message: FOREIGN });
  room.accords.set('a1', { id: 'a1', kind: 'alliance', from: faction.id, to: ally.id, text: '', acceptedAt: 0 });
  faction.explored = [[-6000, 4887]];
  const told = room.factionView(one.playerId).territory, colour = who => room.players.get(who.playerId).color;
  assert.deepEqual(told, [
    { kind: 'own', color: colour(one), spans: [[-5213, 4787]] },
    { kind: 'other', color: colour(two), spans: [[3787, 4887]] },
    { kind: 'ally', color: colour(three), spans: [[25000, 35000]] }]);
  faction.explored = [[-6000, 3000]];
  assert.deepEqual(room.factionView(one.playerId).territory.map(held => held.kind), ['own', 'ally'], 'none of a territory never seen');
});
