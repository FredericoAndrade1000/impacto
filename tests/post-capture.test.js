import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { depositsNear } from '../src/deposits.ts';
import { onField } from './helpers/field.js';
import { CAPTURE_SECONDS, POST_CAPTURE_SECONDS, SHELTER_AWAY, LOAD_REACH, captureAt, bill, billSum, load, refined } from '../src/economy.ts';
import { POST_BILL, POST_FULL, POST_LIMIT, POST_RADIUS, POST_TERRITORY, BASE_TERRITORY } from '../src/territory.ts';
import { captureBar, lostText, seizedText, POST_SIEGE_NEWS } from '../src/faction-ui.ts';
import { fieldPanel, fieldNotices } from '../src/field-panel.ts';

// A field of two factions: Ana's base at -213 and Bia's at 40000, each with stocks to raise posts and fabricate from, and
// a post of Bia's raised at once 4 km off her base towards Ana's, clear of the sites of the ground (`post`, standing at
// `at`). What a test does there: stands a vehicle of a player's, fabricated at its base and holding its fire, at a place
// (`stand`), raises a post of a player's at a clear place `from` to `to` metres off its base (`raise`), and looks at how
// far the capture of the post has gone (`gone`) and at what the field tells a player (`view`).
function field(t) {
  const room = rehearsal([-213, 40000], bill(1e9, 1e9, 1e9, 1e9), { fog: false }), f = onField(t, room),
    [ana, bia] = ['Ana', 'Bia'].map(name => room.join(name)), faction = player => room.faction(room.players.get(player.playerId)),
    clear = x => !depositsNear(room.deposits, x, POST_RADIUS + 2 * LOAD_REACH).length,
    spot = (player, from, to, side) => {
      const home = faction(player).base.x;
      for (let d = to; d >= from; d -= 7) if (clear(home + side * d)) return home + side * d;
      throw new Error('The fixture needs a place clear of sites.');
    },
    raise = (player, from, to, side = 1) => f.send(player, 'post', { x: spot(player, from, to, side), facing: 1, instant: true }).post.id,
    post = raise(bia, 3500, 4000, -1), mine = () => faction(bia).posts.find(each => each.id === post) ?? faction(ana).posts.find(each => each.id === post),
    at = mine().x,
    stand = (player, x, model = 'scout') => {
      const id = f.publish(player, createStructuredTemplate(model));
      f.order(player, 'stance', { ids: [id], stance: 'hold' });
      f.put(id, x);
      return id;
    };
  return { ...f, room, ana, bia, faction, raise, post, at, mine, stand,
    gone: () => { const capture = mine().capture; return capture && captureAt(capture, room.world.time, POST_CAPTURE_SECONDS); },
    view: player => room.factionView(player.playerId),
    finish: () => Object.assign(mine().capture, { progress: POST_CAPTURE_SECONDS - .5, at: room.world.time }),
    // Takes the post at once, as the field looks at it: what waits in its yard is what waited there then.
    take: () => { Object.assign(mine().capture, { progress: POST_CAPTURE_SECONDS, at: room.world.time }); room.besiege(room.world.time); } };
}
// What a player's page says as it comes about, from the faction the field tells it: a page with nothing of its own on the
// field (base-capture.test.js).
function page(room, player) {
  const memo = {};
  return () => {
    const time = room.world.time, faction = room.factionView(player.playerId),
      state = { shared: true, time, localPlayerId: player.playerId, players: [], plates: [], modules: [], actors: [], squad: null },
      panel = fieldPanel({ tab: 'test', shared: true, connected: true, state, faction, playerId: player.playerId });
    return { said: fieldNotices(memo, panel.watch, time), grave: memo.grave, panel };
  };
}

test('a dissolved faction releases its post sight while the destination faction keeps its own', t => {
  const f = field(t), { room, ana, bia } = f, old = f.mine(),
    kept = f.raise(ana, 3500, 4000), destination = f.faction(ana).id;
  room.lookout(old); room.lookout(room.post(kept));
  assert(room.lookouts.has(old.id) && room.lookouts.has(kept));
  f.send(ana, 'invite', { playerId: bia.playerId });
  f.send(bia, 'join-faction', { factionId: destination });
  assert.equal(room.post(old.id), null);
  assert(room.post(kept));
  assert(!room.lookouts.has(old.id), 'a deleted post no longer retains its terrain sweep');
  assert(room.lookouts.has(kept), 'the surviving post keeps its reusable terrain sweep');
});

test('a faction that stands armed alone in the post of another takes it in two minutes, what of the post stands armed there holds it, and it goes back once the taker leaves', t => {
  const f = field(t), { room, world, ana, bia, faction, at, view } = f;
  assert.equal(POST_CAPTURE_SECONDS, 120);
  const ears = page(room, bia);
  ears();
  const raider = f.stand(ana, at + 10);
  f.run(1.5);
  const capture = f.mine().capture;
  // Bia is told at once, by the alarm of bad news, what to do about it and what holds the post; and over her field, how long
  // is left and that it goes on; Ana, how long she has to go.
  const told = ears();
  assert.deepEqual([told.said.at(-1), told.grave], [POST_SIEGE_NEWS, true]);
  assert.deepEqual(told.panel.posts.map(row => [row.id, row.lines.some(line => /^Sendo tomado pela facção de Ana · avançando$/.test(line))]), [[f.post, true]]);
  assert.match(captureBar(view(bia), world.time).text, /^Posto sendo tomado · 1:5\d · avançando$/);
  assert.equal(captureBar(view(bia), world.time).hint, 'Destrua os veículos armados inimigos no posto.');
  assert.match(captureBar(view(ana), world.time).text, /^Tomando o posto da facção de Bia · 1:5\d · avançando$/);
  assert.deepEqual(ears().said, [], 'told once');
  assert.deepEqual(capture, { by: faction(ana).id, progress: 0, at: capture.at, state: 'advancing' });
  assert.deepEqual(view(bia).posts[0].siege, { progress: 0, at: capture.at, state: 'advancing', by: { name: 'Ana', nation: null, flag: faction(ana).flag } });
  assert.deepEqual(view(ana).taking.map(({ id, post, x, state, full }) => [id, post, x, state, full]), [[faction(bia).id, f.post, at, 'advancing', false]]);
  assert(faction(ana).fought === faction(bia).fought && faction(ana).fought > 0, 'both fight while it goes on');
  // A scout of Bia's comes: the capture stands still.
  const guard = f.stand(bia, at - 15);
  const held = f.gone();
  assert.equal(capture.state, 'contested');
  f.run(2);
  assert.equal(f.gone(), held, 'contested, it stands still');
  assert.match(captureBar(view(ana), world.time).text, /· disputada$/);
  room.wreck(world.actor(guard));
  f.run(1.5);
  assert.equal(capture.state, 'advancing');
  // Ana's scout leaves: the capture goes back, down to nothing, and is over.
  f.put(raider, at + POST_RADIUS + 200);
  assert.equal(capture.state, 'receding');
  Object.assign(capture, { progress: .5, at: world.time });
  f.run(2);
  assert.deepEqual([f.mine().capture, view(bia).posts[0].siege, view(ana).taking], [null, null, []]);
  assert.equal(faction(bia).posts[0].id, f.post, 'still hers');
});

test('a post taken is the taker’s, with its territory and its services; nothing is taken from the stocks, and what waited in its yard goes to the faction that lost it', t => {
  const f = field(t), { room, ana, bia, faction, at, view } = f;
  const raider = f.stand(ana, at + 10), ears = { ana: page(room, ana), bia: page(room, bia) };
  f.run(1.5);
  ears.ana(); ears.bia();
  Object.assign(f.mine().yard, load(4000, 0, 400, 0));
  const stocks = { ana: { ...faction(ana).stock }, bia: { ...faction(bia).stock } };
  f.take();
  // It changed hands as it stood.
  assert.deepEqual([faction(bia).posts, faction(ana).posts.map(post => post.id)], [[], [f.post]]);
  assert.deepEqual(f.mine(), { id: f.post, x: at, facing: 1, yard: load(), refinedAt: null, salvage: bill(), takedown: null, capture: null });
  assert.deepEqual(faction(ana).stock, stocks.ana, 'Ana takes nothing of Bia’s stocks');
  assert.deepEqual(faction(bia).stock, billSum(stocks.bia, refined(load(4000, 0, 400, 0))), 'what waited in its yard is Bia’s, refined');
  assert.deepEqual(room.territory(faction(ana)), [[-213 - BASE_TERRITORY, -213 + BASE_TERRITORY], [at - POST_TERRITORY, at + POST_TERRITORY]]);
  assert.deepEqual(room.territory(faction(bia)), [[40000 - BASE_TERRITORY, 40000 + BASE_TERRITORY]]);
  assert.deepEqual(room.depots(faction(ana)).map(place => place.post), [null, f.post], 'it serves Ana now');
  assert.equal(room.factionView(ana.playerId).units.find(unit => unit.id === raider).atPost, true);
  // Both are told: Bia, when, where, to whom and what of the yard went back; Ana, when, where and whose it was.
  assert.deepEqual(view(bia).lost, { at: view(bia).lost.at, x: at, by: { name: 'Ana', nation: null, flag: faction(ana).flag }, yard: load(4000, 0, 400, 0) });
  assert.deepEqual(view(ana).seized, { at: view(bia).lost.at, x: at, of: { name: 'Bia', nation: null, flag: faction(bia).flag } });
  assert.deepEqual(view(ana).posts.map(post => post.id), [f.post]);
  assert.deepEqual(view(bia).outposts.map(({ id, of, name, x }) => [id, of, name, x]), [[f.post, faction(ana).id, 'Ana', at]], 'Bia knows it Ana’s');
  // Bia hears it as bad news; Ana as good news.
  const heard = { bia: ears.bia(), ana: ears.ana() };
  assert.deepEqual([heard.bia.said, heard.bia.grave], [[lostText(view(bia))], true]);
  assert.match(lostText(view(bia)), /^Posto a [\d,]+ km ← da base tomado pela facção de Ana\. O que esperava no pátio dele \(Ferro 4\.000 \+ Sílica 400\) foi refinado para os estoques\.$/);
  assert.deepEqual(heard.ana.said, [seizedText(view(ana))]);
  assert.match(seizedText(view(ana)), /^Posto da facção de Bia tomado a [\d,]+ km → da base: agora é seu, com o território em volta\.$/);
  // Taken down by Ana, it gives nothing back: she put nothing into it.
  const builder = f.stand(ana, at + 400, 'construction-truck');
  f.send(ana, 'auto', { actorId: builder, on: true });
  const asked = f.send(ana, 'remove-post', { postId: f.post });
  assert.deepEqual(asked.value, bill());
  assert(f.until(() => !faction(ana).posts.length, 120), 'taken down');
  assert.equal(room.works.heaps.has(f.post), false, 'no heap: nothing to give back');
});

test('a faction with all the posts it may have takes no other, a sheltered faction’s post is taken by nobody, and whoever stands armed in it is told why', t => {
  const f = field(t), { room, world, ana, bia, faction, at, view } = f;
  // Ana has four posts — the last of them a works not put up yet.
  for (const [from, to, side] of [[1600, 2000, 1], [3200, 3600, 1], [1600, 2000, -1]]) f.raise(ana, from, to, side);
  f.send(ana, 'post', { x: faction(ana).posts[2].x - 1600, facing: 1 });
  assert.equal(room.postPlaces(faction(ana)).length, POST_LIMIT);
  f.stand(ana, at + 10);
  f.run(1.5);
  assert.equal(f.mine().capture, null, 'full, it begins none');
  assert.deepEqual(view(ana).taking.map(({ post, state, progress, full, sheltered }) => [post, state, progress, full, sheltered]), [[f.post, 'contested', 0, true, false]]);
  assert.deepEqual(captureBar(view(ana), world.time), { own: false, share: 0, text: `Sem tomar o posto da facção de Bia: ${POST_FULL}`, hint: '' });
  // Its works given up, it has room for one more, and the capture begins.
  f.send(ana, 'cancel-work', { workId: view(ana).works.find(work => work.post).id });
  f.run(1.5);
  const capture = f.mine().capture;
  assert.equal(capture.state, 'advancing');
  // Filled again meanwhile, its capture stands still as contested, told so.
  f.send(ana, 'post', { x: faction(ana).posts[2].x - 1600, facing: 1 });
  f.run(1.5);
  assert.deepEqual([capture.state, view(ana).taking[0].full], ['contested', true]);
  assert.deepEqual([captureBar(view(ana), world.time).text.endsWith('· disputada'), captureBar(view(ana), world.time).hint], [true, POST_FULL]);
  f.finish(); f.run(1.5);
  assert.equal(faction(bia).posts.length, 1, 'never taken while it is full');
  // Bia's post is sheltered once she has been away long enough with no fighting: nobody begins to take it.
  f.send(ana, 'cancel-work', { workId: view(ana).works.find(work => work.post).id });
  f.mine().capture = null; faction(ana).fought = faction(bia).fought = null;
  room.disconnect(bia.playerId); faction(bia).away = world.time - SHELTER_AWAY;
  f.run(1.5);
  assert(faction(bia).shelter !== null, 'sheltered');
  assert.equal(f.mine().capture, null);
  assert.deepEqual(view(ana).taking.map(({ post, state, sheltered }) => [post, state, sheltered]), [[f.post, 'contested', true]]);
  assert.equal(captureBar(view(ana), world.time).text, 'Posto da facção de Bia protegido: ninguém dela está no campo');
});

test('a base taken takes its posts with it: what each gives back goes into the stocks, and what waited in its yard into that of the base', t => {
  const f = field(t), { room, ana, bia, faction } = f;
  f.stand(ana, faction(bia).base.x + 20);
  f.run(1.5);
  Object.assign(f.mine().yard, load(2000, 0, 0, 0));
  const stock = { ...faction(bia).stock };
  Object.assign(faction(bia).capture, { progress: CAPTURE_SECONDS, at: room.world.time }); room.besiege(room.world.time);
  assert(faction(bia).fell, 'the base was taken');
  const { fell } = faction(bia);
  assert.deepEqual(faction(bia).posts, []);
  assert.deepEqual(fell.cargo, load(2000, 0, 0, 0), 'its yard went into that of the base');
  assert(fell.returned.ferro >= POST_BILL.ferro, 'what it was put up with is back');
  assert(faction(bia).stock.ferro > stock.ferro, 'in the stocks, less the looting');
});
