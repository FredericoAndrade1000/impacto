import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { FULL_INDUSTRY } from '../src/industry.ts';
import { convertPostsField, FROM_SAVE } from '../scripts/convert-field-posts.ts';
import { appraise, fieldParts, bill, buildSeconds, load } from '../src/economy.ts';
import { POST_BILL, POST_RADIUS } from '../src/territory.ts';
import { onField } from './helpers/field.js';

// A field of two factions as a rehearsal makes it — Ana's base at -213 and Bia's at 40000 — kept, and the room it is opened
// as again (`make`), as the converter opens it.
const bases = [-213, 40000], stocks = bill(1e7, 1e7, 1e7, 1e7), make = state => rehearsal(bases, stocks, { kept: state });
// What the field kept as FIELD_SAVE 26 looked like for a room kept now (`kept`): its factions had no posts of their own, and a
// post was a structure of its faction (`record.post`), with the yard of its refinery on its record, as is the wreck of one;
// the works of a post was the works of the design of a post (`work.post`, with its project). `posts` are the structures to
// be posts, by name, with the yard of each; `wrecks` the wrecks of posts, with theirs; `works` the works to be of posts.
function asSave26(kept, { posts = new Map(), wrecks = new Map(), works = [] } = {}) {
  const old = structuredClone(kept);
  delete old.startingIndustry;
  for (const faction of old.factions) delete faction.industry;
  for (const faction of old.factions) { delete faction.posts; delete faction.lost; delete faction.seized; delete faction.outposts; }
  for (const [id, record] of old.records) {
    if (posts.has(id)) Object.assign(record, { post: true, yard: posts.get(id), refinedAt: null });
    if (wrecks.has(id)) Object.assign(record, { yard: wrecks.get(id), refinedAt: null });
  }
  for (const work of old.works) if (works.includes(work.id)) work.post = true;
  return JSON.stringify({ save: FROM_SAVE, at: 'fixture26', room: old });
}

test('a field of 26 with no post is a field of the current save, its factions with none', t => {
  const f = onField(t, rehearsal(bases, stocks)), { room } = f;
  room.join('Ana'); room.join('Bia');
  const { text, receipt } = convertPostsField(asSave26(JSON.parse(JSON.stringify(room.keep()))), 'now', make), kept = JSON.parse(text);
  assert.deepEqual([kept.save, kept.at], [FIELD_SAVE, 'now']);
  assert.deepEqual(receipt, { from: 26, to: FIELD_SAVE, factions: 2, posts: 0, works: 0, wreckYards: 0, refunded: bill() });
  assert(kept.room.factions.every(faction => Array.isArray(faction.posts) && !faction.posts.length && faction.lost === null && faction.seized === null));
  const again = make(kept.room); t.after(() => again.world.dispose());
  assert.equal(again.factions.size, 2);
  assert(kept.room.factions.every(faction => JSON.stringify(faction.industry.levels) === JSON.stringify(FULL_INDUSTRY)));
  // A file of the current save, or of none, is no field of 26.
  assert.throws(() => convertPostsField(JSON.stringify({ save: FIELD_SAVE, room: kept.room }), 'now', make), { message: 'O campo salvo não é do formato 26.' });
});

test('each post structure of a field of 26 is a post where it stood, with its yard, the one being taken down so, its works a works of a post, and the wreck of one keeps no yard', t => {
  const f = onField(t, rehearsal(bases, stocks)), { room, world } = f, ana = room.join('Ana'), bia = room.join('Bia'),
    faction = room.faction(room.players.get(ana.playerId)),
    standing = f.raise(ana, 'guard-post'), lowered = f.raise(ana, 'guard-post'), wrecked = f.raise(ana, 'guard-post'), work = f.open(ana, 'guard-post');
  f.send(ana, 'remove', { actorId: lowered });
  room.wreck(world.actor(wrecked));
  // The works had more of the alloys than a post asks for; and Bia's lorry stays as it was.
  Object.assign(room.works.pending.get(work), { cost: bill(9000, 4000, 9000, 0), delivered: bill(1000, 4000, 0, 0), progress: .5 });
  const where = id => ({ x: room.position(world.actor(id)), facing: world.actor(id).facing }), at = { standing: where(standing), lowered: where(lowered) },
    salvage = { standing: appraise(world.actor(standing), fieldParts(world)).salvage, lowered: appraise(world.actor(lowered), fieldParts(world)).salvage },
    seconds = room.records.get(lowered).service.seconds, kept = JSON.parse(JSON.stringify(room.keep())), stock = { ...faction.stock },
    text = asSave26(kept, { posts: new Map([[standing, load(3000, 0, 0, 0)], [lowered, load()]]), wrecks: new Map([[wrecked, load(100, 0, 0, 0)]]), works: [work] });
  const { text: converted, receipt } = convertPostsField(text, 'now', make), next = JSON.parse(converted).room;
  assert.deepEqual(receipt, { from: 26, to: FIELD_SAVE, factions: 2, posts: 2, works: 1, wreckYards: 1, refunded: bill(0, 1500, 0, 0) });
  const again = make(next); t.after(() => again.world.dispose());
  const theirs = again.faction(again.players.get(ana.playerId));
  assert.deepEqual(theirs.posts, [
    { id: standing, ...at.standing, yard: load(3000, 0, 0, 0), refinedAt: null, salvage: salvage.standing, takedown: null, capture: null },
    { id: lowered, ...at.lowered, yard: load(), refinedAt: null, salvage: salvage.lowered, takedown: { progress: 0, seconds }, capture: null }]);
  assert(![standing, lowered].some(id => again.world.actor(id) || again.records.has(id)), 'no construction is a post any longer');
  assert.deepEqual(again.depots(theirs).map(place => place.post), [null, standing], 'the one being taken down serves no longer');
  assert.deepEqual(again.factionView(ana.playerId).posts.map(post => post.id), [standing, lowered]);
  // The wreck stands, with no yard; the works is of a post, of no design.
  assert(again.records.get(wrecked).wreck && !Object.hasOwn(again.records.get(wrecked), 'yard'));
  const opened = again.works.pending.get(work);
  assert.deepEqual([opened.post, Object.hasOwn(opened, 'blueprint'), opened.cost, opened.delivered, opened.seconds],
    [true, false, POST_BILL, bill(1000, 2500, 0, 0), 0]);
  assert(Math.abs(opened.progress - again.works.share(opened)) < 1e-9 && opened.progress < .5, 'put up no further than what came lets it be');
  assert.deepEqual(theirs.stock, { ...stock, ligas: stock.ligas + 1500 }, 'what came of the works beyond a post went back to the stocks');
  assert.equal(buildSeconds(POST_BILL), 60);
  // The post serves: a hauler unloads into its yard as at a base.
  assert.deepEqual(again.depots(theirs)[1], { x: at.standing.x, radius: POST_RADIUS, post: standing });
  assert(again.players.get(bia.playerId), 'and the other faction is as it was');
});
