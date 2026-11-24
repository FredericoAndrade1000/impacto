import { nativePhotoOnly } from './helpers/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { rehearsal, SharedRoom } from '../server/room.ts';
import { fieldStore, FIELD_SAVE } from '../server/field-save.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { DIARY, replayField } from '../server/field-host.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { STOCK_IDS, stocked } from '../src/economy.ts';
import { onField } from './helpers/field.js';
import { Publication } from '../server/publication.ts';
import { readField, writeField } from '../server/field-snapshot.ts';
import { convertFieldBase49, pinFieldBase49Roots } from '../scripts/convert-field-base49.ts';

// Three bases, each far enough from the others for the territory about it to be its faction's alone (territory.ts).
const BASES = [0, 12000, -12000];
// What a field is written out as, read back.
const written = room => JSON.parse(JSON.stringify(room.keep()));
// A field kept with somebody on it, as it is resumed: nobody is, and every faction somebody of which was is away from then on.
const away = kept => ({ ...kept, factions: kept.factions.map(faction => ({ ...faction, away: faction.away ?? kept.scene.time })) });
const resumed = (t, kept) => { const room = rehearsal(BASES, undefined, { kept }); t.after(() => room.world.dispose()); return room; };
const run = (room, seconds) => { for (let i = 0; i < Math.round(seconds * 60); i++) room.step(); };
// A field with things under way on it: Ana's tank, which fired, her lorry on its way somewhere, her scout holed
// by a blast, and the wreck of Bia's support vehicle at her base; off it, Bia's bunker, a guard post of hers with half
// its material come and a quarter put up, and what had come of another she gave up, in a heap. Caio came and built nothing.
function busy(t, names = ['Ana', 'Bia', 'Caio']) {
  const room = rehearsal(BASES), field = onField(t, room), [ana, bia, caio] = names.map(name => room.join(name)), world = room.world;
  const publish = field.publish, send = (player, type, data = {}) => room.command(player.playerId, { type, ...data }),
    tank = publish(ana, 'heavy'), lorry = publish(ana, 'truck'), scout = publish(ana, 'scout'), bunker = field.raise(bia, 'bunker'), support = publish(bia, 'ifv'),
    works = room.works.pending.get(field.open(bia, 'guard-post')), given = room.works.pending.get(field.open(bia, 'guard-post'));
  for (const id of STOCK_IDS) { works.delivered[id] = works.cost[id] / 2; given.delivered[id] = given.cost[id] / 4; }
  works.progress = .25;
  const heap = send(bia, 'cancel-work', { workId: given.id }).heap.id;
  run(room, 1);
  send(ana, 'squad', { order: 'move', ids: [lorry], x: 70 }); send(ana, 'squad', { order: 'control', id: tank });
  const gun = world.actor(tank).vehicle;
  send(ana, 'fire', { actorId: tank, aim: { x: gun.x + 400, y: gun.y + 30 }, weapon: { id: 'cannon' }, queue: true });
  run(room, 4);
  const hit = world.actor(scout).vehicle; world.explode(hit.x + 1.5, hit.y + 1, 40, 6);
  room.wreck(world.actor(support));
  run(room, 1);
  return { room, world, field, ana, bia, caio, send, tank, lorry, scout, bunker, support, works: works.id, heap };
}
// Whether two fields written out are the same field. A scene the core has just been given is told a little
// otherwise than one it has been stepping: it has worked out again the drag of each vehicle and where its gear
// touches the ground, holds no suspension pressed yet and names every part by a number of its own; and nobody
// drives a field resumed. Fuel quantization can shift the derived range by less than a metre.
const AGAIN = new Set(['drag', 'groundContact', 'displacement', 'compression', 'hostOwner', 'owner', 'driveSpeed', 'throttle', 'brake']);
function differences(a, b, path = '', found = []) {
  if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > (path.endsWith('fuelLitres') ? 1e-2 : path.endsWith('rangeKm') ? 1e-3 : 1e-9)) found.push(`${path}: ${a} ≠ ${b}`); }
  else if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) found.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }
  else for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!AGAIN.has(key)) differences(a[key], b[key], `${path}.${key}`, found);
  return found;
}

test('a field kept and resumed is the field it was: every construction as it stood, every faction with what it had and knew, every seat', t => {
  const { room, world, ana, bia, caio, tank, lorry, scout, bunker, support, works, heap } = busy(t);
  assert(world.actor(tank).stats.shots > 0, 'the tank fired'); assert(Math.abs(world.actor(lorry).vehicle.vx) > 1, 'the lorry is on its way');
  assert(world.plates.some(p => p.actorId === scout && p.marks.length), 'the scout is marked'); assert(world.actor(support).defeated);
  const kept = written(room), again = resumed(t, kept);
  assert.deepEqual(differences(away(kept), written(again)), []);
  // Bia's works and her heap are kept as they were: what came of each, and how far the works was put up.
  assert.deepEqual([kept.works.map(work => [work.id, work.factionId, work.progress]), kept.heaps.map(pile => [pile.id, pile.factionId])],
    [[[works, bia.faction.id, .25]], [[heap, bia.faction.id]]]);
  assert.deepEqual([[...again.works.pending.keys()], [...again.works.heaps.keys()]], [[works], [heap]]);
  assert(kept.factions.every(faction => faction.away === null) && [...again.factions.values()].every(faction => faction.away === world.time));
  // What is kept is every construction, whole: none of its parts goes missing between the design and the scene.
  assert.equal(kept.scene.actors.length, 5); assert.deepEqual(kept.scene.actors.map(a => a.id).sort(), [tank, lorry, scout, bunker, support].sort());
  assert.equal(kept.scene.plates.length, world.plates.length); assert.equal(kept.scene.modules.length, world.modules.length);
  assert.equal(again.world.time, world.time); assert.equal(again.world.tick, world.tick);
  // Nobody is on it yet, and nothing is in anybody's hands.
  assert.deepEqual([...again.players.values()].map(p => [p.name, p.connected, p.squad.manual]),
    ['Ana', 'Bia', 'Caio'].map(name => [name, false, null]));
  assert(again.world.actors.every(a => !a.trigger && !a.pendingShot));
  // The seat is its key's: the same player, with the same construction to look at, the same base, the same designs.
  const back = again.join('Ana', ana.token), seat = room.players.get(ana.playerId);
  assert.deepEqual([back.playerId, back.token, back.selected], [ana.playerId, ana.token, tank]);
  assert.deepEqual(back.base, room.base(seat)); assert.equal(again.players.get(ana.playerId).color, seat.color);
  assert.deepEqual(back.actors, room.owned(ana.playerId).map(actor => room.design(actor)));
  // What each is told of its faction and of its squad is what it was told before, once the sensors were read
  // again, but for what a squad works out as it goes — what each vehicle is doing just now and what alarmed it —
  // and for whose hands are on what: whoever takes a seat again commands, with the construction it was looking at picked,
  // and holds nothing of the faction until asking for it.
  again.join('Bia', bia.token); again.join('Caio', caio.token); again.look();
  const told = (field, player) => JSON.parse(JSON.stringify([field.factionView(player.playerId), field.squadView(player.playerId)],
    (key, value) => ['activity', 'reason', 'targetId', 'alert', 'manual', 'reserved'].includes(key) ? undefined : value));
  assert(again.squadView(ana.playerId).units.every(unit => !unit.reserved && !unit.by));
  for (const player of [ana, bia, caio]) assert.deepEqual(differences(told(room, player), told(again, player)), []);
  assert.deepEqual([ana, bia, caio].map(player => again.players.get(player.playerId).squad.manual), [null, null, null]);
  // A key nobody was given takes no seat: it is refused.
  assert.throws(() => again.join('Intrusa', 'F'.repeat(24)), error => error.unknownKey === true);
  assert.equal(again.players.size, 3);
});

// Build the checkpoint from the current room schema and remove only the ground counters
// to exercise how absent counters are distinguished from impact damage.
test('a synthetic checkpoint without ground counters keeps its impact damage', t => {
  const { room, world, scout } = busy(t, ['Fixture Alpha', 'Fixture Beta', 'Fixture Gamma']);
  const kept = written(room), parts = kept.scene;
  assert(world.plates.some(plate => plate.actorId === scout && plate.marks.length));
  assert(world.modules.some(part => part.actorId === scout && part.health < part.maxHealth));
  for (const plate of parts.plates) delete plate.groundMarks;
  for (const part of parts.modules) { delete part.groundMarks; delete part.groundDamage; }

  const again = resumed(t, kept);
  const rewritten = written(again);
  for (const plate of rewritten.scene.plates) {
    assert.equal(plate.groundMarks, 0);
    delete plate.groundMarks;
  }
  for (const part of rewritten.scene.modules) {
    assert.equal(part.groundMarks, 0);
    assert.equal(part.groundDamage, 0);
    delete part.groundMarks;
    delete part.groundDamage;
  }
  assert.deepEqual(differences(away(kept), rewritten), []);
});

test('a field kept when its pieces held and weighed more is resumed by the rules of now: each piece as its design makes it, holding what it held as far as that room goes, its body weighed again', t => {
  const room = rehearsal(BASES), field = onField(t, room), ana = room.join('Ana'), lorry = field.publish(ana, 'truck'), world = room.world;
  const part = (scene, kind) => scene.modules.find(m => m.actorId === lorry && m.kind === kind);
  const set = (scene, piece, state) => scene.game().call({ op: 'setPartState', owner: scene.game().handle(piece), state });
  // Out of automatic and away from its base, where it would tip its load into the stocks.
  room.command(ana.playerId, { type: 'auto', actorId: lorry, on: false }); field.put(lorry, BASES[0] + 3000); run(room, 1);
  const hopper = part(world, 'hopper'), full = hopper.capacityM3 * 2400;
  set(world, hopper, { cargo: { ferro: full } }); run(room, .5);
  const designed = Object.fromEntries(['hopper', 'fuel', 'engine'].map(kind => [kind, structuredClone(part(world, kind))])), mass = world.actor(lorry).vehicle.mass;
  assert(Math.abs(designed.hopper.cargo.ferro - full) < 1e-6, 'it holds a full load');
  // As a core whose pieces grew deeper with their size would have kept it: rooms and empty weights three times as big, a
  // load and a tank fuller than the pieces of now hold, and every weight over what they are now.
  const kept = written(room), state = id => kept.scene.modules.find(m => m.id === id), empty = designed.hopper.physicalMass - full;
  Object.assign(state(designed.hopper.id), { capacityM3: designed.hopper.capacityM3 * 3, dryMass: empty * 3,
    cargo: { ferro: full * 3, ligas: 0, silica: 0 }, physicalMass: empty * 3 + full * 3 });
  Object.assign(state(designed.fuel.id), { capacityLitres: designed.fuel.capacityLitres * 3, fuelLitres: designed.fuel.capacityLitres * 2.5,
    physicalMass: designed.fuel.physicalMass * 3 });
  Object.assign(state(designed.engine.id), { dryMass: designed.engine.physicalMass * 2, physicalMass: designed.engine.physicalMass * 2 });
  kept.scene.actors.find(a => a.id === lorry).vehicle.mass = mass * 3;
  const again = resumed(t, kept), scene = again.world;
  assert.equal(part(scene, 'hopper').capacityM3, designed.hopper.capacityM3); assert.equal(part(scene, 'fuel').capacityLitres, designed.fuel.capacityLitres);
  assert.equal(part(scene, 'fuel').fuelLitres, designed.fuel.capacityLitres, 'a tank no fuller than its room');
  run(again, .2);
  assert(Math.abs(part(scene, 'hopper').cargo.ferro - full) < 1e-6, 'a hopper no fuller than its room');
  for (const kind of ['hopper', 'fuel', 'engine']) assert(Math.abs(part(scene, kind).physicalMass - designed[kind].physicalMass) < 1, kind);
  assert(Math.abs(scene.actor(lorry).vehicle.mass - mass) < 1, `${scene.actor(lorry).vehicle.mass} kg weighed again for ${mass} kg`);
});

test('publication receipts survive a cold save even after replacement, completed works and relocation', t => {
  const room = rehearsal(BASES), field = onField(t, room), ana = room.join('Ana'), bia = room.join('Bia'),
    receipts = [], ask = (type, data) => {
      const command = { type, ...data }, answer = field.send(ana, type, data);
      receipts.push([command, structuredClone(answer)]); return answer;
    };
  const first = ask('spawn', { blueprint: createStructuredTemplate('scout'), ticket: 'vehicle' });
  ask('replace', { actorId: first.actor.id, blueprint: createStructuredTemplate('recon'), ticket: 'refit' });
  const design = createStructuredTemplate('guard-post'), x = field.site(ana, design), fixed = { blueprint: design, x, facing: 1, ticket: 'fixed' };
  ask('spawn', fixed);
  const id = field.raise(ana, design, fixed);
  ask('relocate', { actorId: id, x: field.site(ana, design, { from: 200, ignore: id }), facing: -1, ticket: 'move' });
  const kept = written(room), again = resumed(t, kept), back = again.join('Ana', ana.token),
    state = () => structuredClone({ stock: again.faction(again.players.get(back.playerId)).stock,
      actors: again.world.actors.map(actor => actor.id), works: [...again.works.pending] }), before = state();
  // These are historical answers: the original vehicle was replaced and the fixed works is already standing or moving.
  for (const [command, answer] of receipts) assert.deepEqual(again.command(back.playerId, command), answer);
  assert.deepEqual(state(), before, 'a retry creates no new construction or works and charges nothing');
  kept.players[0].published[0][1].selected = 'changed-by-reader';
  assert.deepEqual(again.command(back.playerId, receipts[0][0]), receipts[0][1], 'resume owns its receipt data');
  const snapshot = room.keep(); snapshot.players[0].published[0][1].selected = 'changed-by-writer';
  assert.deepEqual(room.command(ana.playerId, receipts[0][0]), receipts[0][1], 'keep does not expose the live receipt');
  again.join('Bia', bia.token);
  assert.notEqual(again.command(bia.playerId, receipts[0][0]).actor.id, first.actor.id, 'a ticket belongs to one player');
  // Older saves have no receipts: the field and its constructions still resume normally.
  for (const player of kept.players) delete player.published;
  const legacy = resumed(t, kept);
  assert.deepEqual(legacy.world.actors.map(actor => actor.id), room.world.actors.map(actor => actor.id));
});

test('what was under way on a field goes on when it is resumed: an order, a repair, the time a wreck has left', t => {
  const { room, world, ana, send, lorry, scout, support } = busy(t);
  // The scout was hit: it is mended by itself once it has been left alone for a while. The lorry is sent off again meanwhile.
  send(ana, 'squad', { order: 'control', id: null }); run(room, 11);
  send(ana, 'squad', { order: 'move', ids: [lorry], x: -80 }); run(room, .5);
  const service = room.records.get(scout).service, wreck = room.records.get(support).wreck;
  assert.equal(service.kind, 'repair'); assert(service.until > world.time + 1, 'the repair takes a while');
  const again = resumed(t, written(room)), field = again.world;
  assert.deepEqual(again.records.get(scout).service, service); assert.deepEqual(again.records.get(support).wreck, wreck);
  assert.deepEqual(field.actor(scout).field, world.actor(scout).field, 'and every screen is told of the repair');
  assert.equal(again.players.get(ana.playerId).squad.units.get(lorry).move.x, -80);
  // The repair ends when it was to end, and leaves the scout whole, built anew.
  const whole = scene => scene.modules.filter(m => m.actorId === scout).every(m => m.health === m.maxHealth);
  assert(!whole(field));
  run(again, service.until - field.time + .2);
  assert.equal(again.records.get(scout).service, null); assert.equal(field.actor(scout).revision, 1); assert(whole(field));
  // The lorry went on to where it was sent.
  run(again, 15);
  assert(Math.abs(field.actor(lorry).vehicle.x + 80) < 8, `the lorry is at ${field.actor(lorry).vehicle.x}`);
  assert.equal(again.players.get(ana.playerId).squad.units.get(lorry).move, null);
  // A field resumed is kept and resumed in its turn: a construction rebuilt since it came is one more thing kept.
  const third = resumed(t, written(again));
  assert.deepEqual(differences(written(again), written(third)), []); assert.equal(third.world.actor(scout).revision, 1);
  // The wreck leaves the field when its time is over, by the clock of the field, which was kept with it.
  third.field.time = wreck.until - 1; third.field.rustGame = null; third.field.game();
  run(third, .5); assert(third.world.actor(support), 'not before its time');
  run(third, 1.5); assert(!third.world.actor(support), 'and no longer'); assert.equal(third.records.has(support), false);
});

test('a free-fire checkpoint preserves its exact region and progress; Stop and an old save have distinct meanings', t => {
  const { room, field, ana, send, tank } = busy(t), live = field => field.players.get(ana.playerId).squad.units.get(tank),
    saved = kept => kept.players.find(player => player.id === ana.playerId).orders.find(([id]) => id === tank)[1];
  send(ana, 'squad', { order: 'control', id: null });
  const anchor = room.world.actor(tank).vehicle.x;
  send(ana, 'squad', { order: 'stance', ids: [tank], stance: 'fire' });
  // Stand it partway through its local region. The anchor is an authorization, not a rolling record of its pose.
  field.put(tank, anchor + 30);
  const squad = room.players.get(ana.playerId).squad;
  live(room).move = { ...squad.leg(tank, anchor + 45), purpose: 'fire' };
  live(room).move.since -= 2;
  const kept = written(room), order = saved(kept), from = room.world.actor(tank).vehicle.x,
    retired = ['post', 'guard', 'sensedAt'];
  assert.equal(order.fireAt, anchor); assert(Math.abs(from - anchor) > 20);
  assert(retired.every(key => !Object.hasOwn(order, key)), 'no retired enemy-position cache is kept');
  order.post = anchor - 80;
  const original = structuredClone(order), again = resumed(t, kept);
  assert.equal(live(again).stance, 'fire'); assert.equal(live(again).fireAt, anchor);
  assert.deepEqual(live(again).move, order.move, 'the checkpoint keeps the existing leg and its progress time exactly');
  assert(retired.every(key => !Object.hasOwn(live(again), key)), 'the old post does not return to live squad state');
  run(again, .3);
  assert.equal(live(again).move, null, 'without a fresh local enemy the first decision cancels a player pursuit');
  assert.equal(live(again).fireAt, anchor, 'loading or looking without a contact never recaptures the anchor');
  assert.deepEqual(order, original, 'reading a checkpoint leaves its source intact');

  const stopped = structuredClone(kept); saved(stopped).fireAt = null; saved(stopped).move = null;
  const idle = resumed(t, stopped);
  assert.equal(live(idle).fireAt, null, 'a saved Stop remains a Stop');
  run(idle, .3); assert.equal(live(idle).move, null); assert.equal(live(idle).fireAt, null);

  const old = structuredClone(stopped); delete saved(old).fireAt;
  const legacy = resumed(t, old);
  assert.equal(live(legacy).fireAt, legacy.world.actor(tank).vehicle.x, 'an actual old save gets its local region once at its saved pose');
  assert.notEqual(live(legacy).fireAt, saved(old).post, 'a retired post never authorizes a different region');
  assert(!Object.hasOwn(saved(old), 'fireAt'), 'old input is not rewritten by the loader');
  const corrupt = structuredClone(stopped); saved(corrupt).fireAt = 'elsewhere';
  assert.throws(() => resumed(t, corrupt), /Origem de fogo livre inválida no campo salvo/);
});

test('a field resumed holds no round in the air, and has every faction away from then on, however long, and none forgotten', t => {
  const { room, world, ana, bia, caio, send, tank } = busy(t);
  const gun = world.actor(tank).vehicle;
  send(ana, 'trigger', { actorId: tank, active: true, aim: { x: gun.x + 400, y: gun.y + 30 }, weapon: { id: 'cannon' } });
  const fired = world.actor(tank).stats.shots;
  for (let i = 0; i < 900 && world.actor(tank).stats.shots === fired; i++) room.step();
  assert(world.projectiles.length > 0, 'a round is in the air'); assert(world.actor(tank).trigger, 'and the trigger is held');
  const kept = written(room), again = resumed(t, kept);
  assert.equal(again.world.projectiles.length, 0); assert.equal(again.world.actor(tank).trigger ?? null, null);
  // The gun fires again every ten seconds while its trigger is held: on the field resumed nobody holds it.
  run(again, 12); assert.equal(again.world.actor(tank).stats.shots, fired + 1);
  // Everybody left when the server stopped, as far as the field can tell: every faction is away from when it was
  // resumed, the time it was down no part of it. Caio, who has nothing standing, is there however long, faction and all.
  assert.deepEqual([...again.factions.values()].map(faction => faction.away), Array(3).fill(world.time));
  again.checkLeases(again.steps + 30 * 24 * 216_000);
  assert.deepEqual([...again.players.keys()].sort(), [ana.playerId, bia.playerId, caio.playerId].sort());
  assert.equal(again.factions.size, 3); assert.deepEqual(again.owned(caio.playerId), []);
  assert.equal(again.join('Caio', caio.token).faction.id, caio.faction.id);
});

test('a works and a heap are kept with the field: resumed, a builder puts the works up as far as what came of it, and a supply vehicle loads the heap', t => {
  const room = rehearsal(BASES), f = onField(t, room), ana = room.join('Ana'), design = createStructuredTemplate('guard-post');
  const works = room.works.pending.get(f.open(ana, design)), given = room.works.pending.get(f.open(ana, design));
  for (const id of STOCK_IDS) { works.delivered[id] = works.cost[id] / 2; given.delivered[id] = given.cost[id] / 4; }
  const heap = f.send(ana, 'cancel-work', { workId: given.id }).heap.id, pile = { ...room.works.heaps.get(heap) };
  const dir = mkdtempSync(join(tmpdir(), 'impacto-works-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const said = [], { error, log } = console; console.error = console.log = (...words) => said.push(words.join(' '));
  t.after(() => { Object.assign(console, { error, log }); });
  fieldStore(dir).save(room);
  const again = fieldStore(dir).open(kept => rehearsal(BASES, undefined, { kept })), field = onField(t, again);
  assert.deepEqual([...again.works.pending.values()], [works]); assert.deepEqual([...again.works.heaps.values()], [pile]);
  again.join('Ana', ana.token);
  // A constructor out of automatic with nothing aboard puts the works up beside it as far as half of it, what came of it, and
  // waits there.
  const builder = field.publish(ana, 'construction-truck'); field.send(ana, 'auto', { actorId: builder, on: false }); field.run(1);
  for (const crate of again.serving(builder)) field.set(crate, { cargo: {} });
  field.put(builder, works.x - 5); field.run(1);
  const resumedWorks = () => again.factionView(ana.playerId).works.find(work => work.id === works.id);
  assert(field.until(() => resumedWorks().progress >= .5, 30), 'the supplied half is constructed within its work time');
  assert.deepEqual([resumedWorks().share, resumedWorks().progress, resumedWorks().building], [.5, .5, false]);
  // A supply vehicle out of automatic, loaded at the base, brings the rest beside it, and it stands.
  const lorry = field.publish(ana, 'supply'); field.send(ana, 'auto', { actorId: lorry, on: false }); field.run(2); field.put(lorry, works.x + 8);
  assert(field.until(() => again.world.actor(works.id), 30), 'the guard post stands');
  assert.equal(again.world.actor(works.id).construction.name, design.name);
  // The heap is loaded by the supply vehicle stood beside it.
  field.put(lorry, pile.x);
  assert(field.until(() => !again.works.heaps.has(heap), 30), 'the heap is loaded');
});

test('who leads each faction, who administers it and where one founded for a player removed from another came from are kept with the field', t => {
  const room = rehearsal(BASES), [ana, bia, caio, davi] = ['Ana', 'Bia', 'Caio', 'Davi'].map(name => room.join(name));
  t.after(() => room.world.dispose());
  const send = (player, type, data = {}) => room.command(player.playerId, { type, ...data });
  for (const player of [bia, caio, davi]) { send(ana, 'invite', { playerId: player.playerId }); send(player, 'join-faction', { factionId: ana.faction.id }); }
  send(ana, 'member', { playerId: caio.playerId, act: 'admin' }); run(room, .5);
  const at = room.world.time; send(caio, 'member', { playerId: davi.playerId, act: 'remove' });
  const kept = written(room), again = resumed(t, kept), faction = again.factions.get(ana.faction.id);
  assert.deepEqual(differences(away(kept), written(again)), []);
  assert(kept.factions.every(f => !Object.hasOwn(f, 'founder')));
  assert.deepEqual([faction.leader, [...faction.admins], [...faction.members]], [ana.playerId, [caio.playerId], [ana, bia, caio].map(p => p.playerId)]);
  assert.deepEqual(again.faction(again.players.get(davi.playerId)).removed, { at, from: { name: 'Ana', nation: null } });
  assert.deepEqual(again.join('Ana', ana.token).faction.members.map(m => m.role), ['leader', 'member', 'admin']);
  assert.deepEqual(again.join('Davi', davi.token).faction.removed, { at, from: { name: 'Ana', nation: null } });
});

test('a current JSON field retains its players, materials, orders, damage, objectives, factions and captures regardless of an obsolete core metadata tag', t => {
  assert.equal(FIELD_SAVE, 32);
  const dir = mkdtempSync(join(tmpdir(), 'impacto-cold-save28-')), file = join(dir, 'field.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { room, world, field, ana, bia, tank, lorry, scout } = busy(t, ['Ana', 'Bia']),
    vein = room.prospected(room.faction(room.players.get(ana.playerId)))[0], site = vein.id, reserve = room.left(vein), amount = 125.25;
  // A vein dug below its reserve is the one the field names, with what is left of it.
  assert(reserve > amount); room.veins.set(site, reserve - amount); room.extracted.set(site, amount);
  const yard = room.faction(room.players.get(ana.playerId)).yard;
  Object.assign(yard, { ferro: 37.5, ligas: 11.25 });
  // Ana is taking Bia's base, and took another before: both remain as they were saved.
  const theirs = room.faction(room.players.get(bia.playerId));
  theirs.capture = { by: room.faction(room.players.get(ana.playerId)).id, progress: 12, at: world.time, state: 'contested' };
  room.faction(room.players.get(ana.playerId)).taken = { at: 1, of: 'f9', dismantled: 0, stock: { ferro: 100, ligas: 0, silica: 0, combustivel: 0 }, yard: { ferro: 0, ligas: 0, silica: 0, petroleo: 0 } };
  room.completeObjective(room.players.get(ana.playerId), 'collectOre');
  assert.equal(room.players.size, 2);
  assert(world.plates.some(plate => plate.actorId === scout && plate.marks.length));
  assert.equal(room.players.get(ana.playerId).squad.units.get(lorry).move.x, 70);
  const gun = field.parts(tank, 'weapon')[0], ammo = field.parts(tank, 'ammo')[0];
  assert(ammo.capacityRounds > 3 && gun.weaponMount.shield);
  field.set(gun, { health: gun.maxHealth * .6, barrelDamage: gun.maxHealth * .1,
    mantletHoles: [{ min: .58, max: .66 }], elevationDamage: gun.maxHealth * .4 });
  field.set(ammo, { rounds: 3 });
  const canonical = written(room), kept = structuredClone(canonical),
    mounts = new Map(world.modules.filter(part => part.weaponMount).map(part => [part.id, structuredClone(part.weaponMount)]));
  assert(canonical.scene.modules.every(part => !Object.hasOwn(part, 'weaponMount')), 'JSON25 writes live state without derived mount profiles');
  // Old JSON25 carried the derived cold profile; one is absent its new value, another is deliberately forged.
  for (const part of kept.scene.modules) if (mounts.has(part.id)) {
    part.weaponMount = structuredClone(mounts.get(part.id)); delete part.weaponMount.fireTolerance;
    if (part.id === gun.id) Object.assign(part.weaponMount, { fireTolerance: 99, min: 99, max: -99, maxSpeed: 0, walls: [] });
  }
  assert(kept.scene.modules.some(part => part.weaponMount && !Object.hasOwn(part.weaponMount, 'fireTolerance')));
  const keptGun = canonical.scene.modules.find(part => part.id === gun.id);
  assert(keptGun.health < gun.maxHealth && keptGun.barrelDamage > 0 && keptGun.elevationDamage > 0 && keptGun.mantletHoles.length);
  assert.equal(canonical.scene.modules.find(part => part.id === ammo.id).rounds, 3);
  // The previous core's tag is metadata on JSON, not a binary snapshot to decode or a format to transform.
  const text = JSON.stringify({ save: FIELD_SAVE, core: CORE_CONTRACT - 1, at: '2026-10-20T00:00:00.000Z', room: kept });
  assert(kept.factions.every(f => f.fell === null && f.recovered === null) && kept.factions.some(f => f.capture) && kept.factions.some(f => f.taken));
  assert(kept.players.every(seat => seat.request === null) && kept.factions.every(f => /^[0-9a-f]{12}$/.test(f.ref) && f.library.length === 0));
  assert.doesNotMatch(JSON.stringify(kept), /loadFraction/);
  assert(kept.factions.every(f => f.admins.length === 0 && f.removed === null));
  assert(!Object.hasOwn(kept.scene, 'projectiles'), 'cold fields contain no in-flight projectile state');
  const said = [], { error, log } = console; console.error = console.log = (...words) => said.push(words.join(' '));
  t.after(() => { Object.assign(console, { error, log }); });
  writeFileSync(file, text); const store = fieldStore(dir); let opens = 0;
  const again = store.open(cold => { opens++; assert(cold, 'the known cold field must not fall back to an empty room'); return rehearsal(BASES, undefined, { kept: cold }); });
  t.after(() => again.world.dispose());
  assert.equal(opens, 1); assert.equal(again.players.size, 2);
  for (const [id, profile] of mounts) {
    const restored = again.world.modules.find(part => part.id === id);
    assert.deepEqual(differences(profile, restored.weaponMount), [], 'the admitted design owns the whole mount profile');
    assert(Number.isFinite(restored.weaponMount.fireTolerance) && restored.weaponMount.fireTolerance > 0);
  }
  assert.deepEqual(differences(away(canonical), written(again)), [], 'damage, holes, ammunition and every saved pose remain');
  assert.deepEqual([...again.factions.values()].map(f => [f.away, f.fought, f.shelter]), kept.factions.map(f => [world.time, f.fought, f.shelter]));
  assert.deepEqual([...again.extracted], [[site, amount]]); assert.equal(again.veins.get(site), reserve - amount);
  assert.deepEqual(again.faction(again.players.get(ana.playerId)).yard, yard);
  assert.equal(yard.ferro, 37.5); assert.equal(yard.ligas, 11.25);
  assert.equal(again.players.get(ana.playerId).objectives.collectOre, true);
  assert.equal(again.players.get(bia.playerId).objectives.fabricateVehicle, true);
  for (const original of [ana, bia]) {
    const back = again.join(original === ana ? 'Ana' : 'Bia', original.token.toLowerCase());
    assert.equal(back.playerId, original.playerId); assert.equal(back.token, original.token);
    const stock = room.faction(room.players.get(original.playerId)).stock;
    assert.deepEqual(again.faction(again.players.get(original.playerId)).stock, stock, 'the save retains fractional fuel exactly');
    assert.deepEqual(back.faction.stock, Object.fromEntries(STOCK_IDS.map(id => [id, stocked(stock[id])])), 'the joining page receives the usual whole-unit stock presentation');
  }
  assert.equal(readFileSync(file, 'utf8'), text, 'opening never rewrites or retags the old checkpoint');
  assert.deepEqual(readdirSync(dir), ['field.json']);
  assert(!said.some(line => /posto de lado/.test(line)));
  run(again, .2); // The real server also advances twelve steps before accepting a resumed field.
  assert.equal(again.players.size, 2); assert.deepEqual([...again.extracted], [[site, amount]]);
  store.save(again);
  const next = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(next.save, FIELD_SAVE); assert(!Object.hasOwn(next, 'core')); assert.deepEqual(next.room, written(again));
  assert.deepEqual(next.room.factions.map(f => [f.leader, f.admins, f.removed]), kept.factions.map(f => [f.leader, [], null]));
  assert.deepEqual(readdirSync(dir), ['field.json']);
});

for (const priorCore of [CORE_CONTRACT - 1, CORE_CONTRACT + 1]) test(`a core${priorCore} diary is refused before its binary snapshot is decoded`, async () => {
  const header = { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: priorCore,
    snapshot: { core: 'not-decoded-old-binary', heap: {} } };
  await assert.rejects(replayField([JSON.stringify(header)]), new RegExp(`outro contrato do núcleo \\(${priorCore}; este lê o ${CORE_CONTRACT}\\)`));
});

test('a refused checkpoint stays intact and cannot open a substitute field; failed writes report false and can recover', t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-save-')), file = join(dir, 'field.json');
  const said = [], { error, log } = console; console.error = console.log = (...words) => said.push(words.join(' '));
  t.after(() => { Object.assign(console, { error, log }); rmSync(dir, { recursive: true, force: true }); });
  const { room, ana, tank } = busy(t), store = fieldStore(dir), rooms = [];
  let newFields = 0;
  const open = () => store.open(kept => { if (!kept) newFields++; const opened = rehearsal(BASES, undefined, { kept }); rooms.push(opened); return opened; });
  t.after(() => { for (const opened of rooms) opened.world.dispose(); });
  // Nothing kept yet: this really is a new field.
  assert.equal(open().players.size, 0); assert.equal(newFields, 1);
  assert.equal(store.save(room), true);
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(kept.save, FIELD_SAVE); assert(Date.parse(kept.at) <= Date.now());
  assert.deepEqual(kept.room, written(room));
  assert.deepEqual(readFileSync(file, 'utf8').length > 0 && Object.keys(kept), ['save', 'at', 'room']);
  const again = open();
  assert.equal(again.join('Ana', ana.token).selected, tank); assert.match(said.join('\n'), /Campo retomado/);
  // Wrong versions, invalid content and resume failures all preserve the canonical file. None opens an empty field.
  const spoil = change => { const next = structuredClone(kept); change(next); return JSON.stringify(next); };
  const incompatible = [
    ['another save', spoil(k => { k.save = FIELD_SAVE + 1; })],
    ['missing room', spoil(k => { delete k.room; })], ['null room', spoil(k => { k.room = null; })],
    ['save label as a string', spoil(k => { k.save = String(FIELD_SAVE); })],
    ['another ground', spoil(k => { k.room.ground = 'x'.repeat(16); })], ['cut short', JSON.stringify(kept).slice(0, 5000)],
    ['malformed publication receipts', spoil(k => { k.room.players[0].published = [['ticket']]; })],
    ['duplicate publication tickets', spoil(k => { k.room.players[0].published = [['ticket', {}], ['ticket', {}]]; })],
    ['unbounded publication receipts', spoil(k => { k.room.players[0].published = Array.from({ length: 9 }, (_, i) => [String(i), {}]); })],
    ['an old design', spoil(k => { k.room.scene.actors[0].construction.version = 3; })],
    ['a part gone', spoil(k => { k.room.scene.plates.pop(); })], ['a record gone', spoil(k => { k.room.records.pop(); })]];
  for (const [why, text] of incompatible) {
    writeFileSync(file, text);
    assert.throws(open, undefined, why);
    assert.equal(newFields, 1, why);
    assert.equal(readFileSync(file, 'utf8'), text, why);
    assert.deepEqual(readdirSync(dir), ['field.json'], why);
  }
  // A real filesystem failure leaves the last good file and reports false; normal saving can recover later.
  assert.equal(store.save(room), true); const before = readFileSync(file, 'utf8'), blocked = join(dir, `field.json.${process.pid}.${threadId}.tmp`);
  mkdirSync(blocked);
  assert.equal(store.save(room), false); assert.equal(store.save(room), false);
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(said.filter(line => line.startsWith('Campo não salvo:')).length, 1);
  rmdirSync(blocked);
  assert.equal(store.save(room), true);
  assert.equal(open().join('Ana', ana.token).selected, tank);
});

test('diagnostic logs allow a fresh field, but field artifacts without its checkpoint require recovery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-fresh-save-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'client-performance.jsonl'), '{}\n');
  writeFileSync(join(dir, 'client-performance.previous.jsonl'), '{}\n');
  let fresh = 0;
  const open = () => fieldStore(dir).open(kept => { assert.equal(kept, null); fresh++; return 'new'; });
  assert.equal(open(), 'new'); assert.equal(fresh, 1);
  for (const name of ['field.json.123.1.tmp', 'field.unreadable.20261024T000000Z.json', 'replays']) {
    const path = join(dir, name); if (name === 'replays') mkdirSync(path); else writeFileSync(path, 'preserve');
    assert.throws(open); assert.equal(fresh, 1, name);
    if (name === 'replays') rmdirSync(path); else { assert.equal(readFileSync(path, 'utf8'), 'preserve'); rmSync(path); }
  }
});

test('a field resumed draws and names as it would have had it never stopped: its draw and its count of names are kept', t => {
  const room = new SharedRoom(), ana = room.join('Ana'); t.after(() => room.world.dispose());
  assert.deepEqual(room.keep().serials, { j: 1, f: 1, c: 3, r: 0, t: 0, a: 0, m: 0 }, 'the initial fleet does not advance player, faction, road or social names');
  const again = new SharedRoom({ kept: written(room) }); t.after(() => again.world.dispose());
  const [beto, betoAgain] = [room, again].map(field => field.join('Beto')), base = (field, joined) => field.faction(field.players.get(joined.playerId)).base;
  assert.deepEqual([ana.playerId, beto.playerId, betoAgain.playerId], ['j1', 'j2', 'j2'], 'players are named in turn');
  assert.deepEqual([beto, betoAgain].map(joined => joined.faction.id), ['f2', 'f2'], 'and factions, each by a count of its own');
  assert.deepEqual(base(again, betoAgain), base(room, beto), 'whoever comes next is founded where the field would have drawn it');
});

test('each kind of thing is named by a count of its own, and a field resumed counts on past every name it gave', t => {
  const room = rehearsal(BASES), [ana, beto] = ['Ana', 'Beto'].map(name => room.join(name)); t.after(() => room.world.dispose());
  const publish = (field, player) => { field.players.get(player.playerId).builtAt = -Infinity; return field.publish(player.playerId, createStructuredTemplate('scout')).actor.id; };
  const built = [publish(room, ana), publish(room, ana), publish(room, beto)];
  // Whoever builds learns from the name of what it built how many constructions there are, and nothing of how many came.
  assert.deepEqual([ana.playerId, beto.playerId, ana.faction.id, beto.faction.id, ...built], ['j1', 'j2', 'f1', 'f2', 'c1', 'c2', 'c3']);
  const caio = room.join('Caio');
  assert.deepEqual([caio.playerId, caio.faction.id, publish(room, caio)], ['j3', 'f3', 'c4']);
  // The last of each kind leaves — Caio joins Ana's faction, and his own is gone with what he had —: its name is given to
  // nothing else, for an enemy may still remember it by that name.
  room.command(ana.playerId, { type: 'invite', playerId: caio.playerId }); room.command(caio.playerId, { type: 'join-faction', factionId: ana.faction.id });
  assert(!room.factions.has('f3') && !room.world.actor('c4'));
  assert.equal(room.players.get('j3').factionId, 'f1');
  const again = resumed(t, written(room)), dan = again.join('Dan');
  assert.deepEqual([dan.playerId, dan.faction.id, publish(again, dan)], ['j4', 'f4', 'c5'], 'each kind counts on past every name it gave, including deleted objects');
});

test('resume requires independent valid counters rather than guessing from remaining objects or a shared counter', t => {
  const room = new SharedRoom(); t.after(() => room.world.dispose());
  room.join('Ana');
  const kept = written(room);
  for (const serials of [undefined, { j: 1, f: 1 }, { j: -1, f: 1, c: 2 }, { j: 1, f: 1, c: 1.5 }, { j: 1, f: 1, c: 3 }, { j: 1, f: 1, c: 3, r: -1 }])
    assert.throws(() => new SharedRoom({ kept: { ...kept, serials } }), /contadores válidos/);
});

// This cross-core case deliberately requires the preserved executable49 root. It must run before base50 cutover.
test('the explicit base49 converter preserves a damaged live field and refuses a real new-base overlap without output', {
  skip: CORE_CONTRACT !== 50 ? 'Requires the physical-base Core50 build.' :
    !process.env.IMPACTO_BASE49_ROOT ? 'Set IMPACTO_BASE49_ROOT to the preserved executable Core49 checkout.' : false,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-base49-')), oldRoot = resolve(process.env.IMPACTO_BASE49_ROOT),
    newRoot = fileURLToPath(new URL('..', import.meta.url)), input = join(dir, 'old-field.json'), output = join(dir, 'converted');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The fixture belongs to49: do not generate it with new50 factories or load both hosts in this process.
  const prepare = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [root, destination] = process.argv.slice(1),
      sourceModule = path => /\\.[jt]s$/.test(path) ? path.slice(0, -3) + (existsSync(join(root, path.slice(0, -3) + '.ts')) ? '.ts' : '.js') : path,
      load = path => import(pathToFileURL(join(root, sourceModule(path)))), fieldSave = 'server/field-save.js';
    const [{ rehearsal }, { createStructuredTemplate }, { FIELD_SAVE }, { STOCK_IDS }] = await Promise.all([
      load('server/room.ts'), load('src/structured-templates.ts'), load(fieldSave), load('src/economy.ts')]);
    const room = rehearsal([0, 3000, -3000]);
    try {
      const joined = room.join('Private conversion fixture'), player = room.players.get(joined.playerId),
        faction = room.factions.get(joined.faction.id), source = createStructuredTemplate('howitzer');
      for (const facing of [-1, 1]) { player.builtAt = -Infinity; room.publish(player.id, source, { facing }); }
      const truck = createStructuredTemplate('truck');
      truck.components.push({ id: 'fixture-cargo', kind: 'hopper', sizeScale: .25, pose: { x: 0, y: 140, angle: 0 } });
      player.builtAt = -Infinity; room.publish(player.id, truck);
      const world = room.world;
      for (const module of world.modules) {
        let state;
        if (module.kind === 'weapon') state = { health: module.maxHealth * .8, mantletHoles: [{ min: .8, max: .85 }] };
        else if (module.kind === 'fuel') state = { fuelLitres: module.capacityLitres * .37 };
        else if (module.kind === 'ammo') state = { rounds: Math.max(1, Math.floor(module.capacityRounds * .41)) };
        else if (module.kind === 'hopper') state = { cargo: { ferro: 1 } };
        if (state) world.command('setPartState', { owner: world.game().handle(module), state });
      }
      const plate = world.plates.find(p => !p.definition.chassis), p = plate.definition,
        n = { x: -Math.sin(p.angle || 0), y: Math.cos(p.angle || 0) };
      world.cutBody(plate, { x: p.x - n.x, y: p.y - n.y }, { x: p.x + n.x, y: p.y + n.y }, .012);
      faction.library.push({ id: 'fixture-library', name: source.name, author: player.id, by: player.name, at: world.time, blueprint: source });
      const work = room.works.open({ p: player, faction, blueprint: createStructuredTemplate('guard-post'), direction: 1,
        position: 160, cost: Object.fromEntries(STOCK_IDS.map(id => [id, 20])), seconds: 50 });
      work.progress = .125; for (const id of STOCK_IDS) { work.delivered[id] = 3; faction.stock[id] = 12345.67; }
      const moving = world.actors.find(a => a.vehicle && world.modules.some(m => m.actorId === a.id && m.kind === 'weapon' && !m.weaponMount.exposed)),
        pose = moving.vehicle.pose();
      world.command('setVehicleState', { actorId: moving.id,
        state: { x: pose.x + 7.25, y: pose.y + 1.375, angle: .17, vx: 2.5, vy: -.35, omega: .23 } });
      writeFileSync(destination, JSON.stringify({ save: FIELD_SAVE, at: 'fixture49', room: room.keep() }), { mode: 0o600 });
    } finally { room.world.dispose(); }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', prepare, oldRoot, input],
    { cwd: oldRoot, env: { ...process.env, IMPACTO_DYNAMICS_RUNTIME: 'native' }, stdio: 'ignore' });
  const original = readFileSync(input), before = JSON.parse(original), pins = pinFieldBase49Roots(oldRoot, newRoot),
    draft = join(dir, 'working.json'), draftText = JSON.stringify({ projectId: 'kept-project', blueprint: before.room.scene.actors[0].construction });
  writeFileSync(draft, draftText, { mode: 0o600 });
  assert(before.room.scene.modules.some(m => m.mantletHoles?.length));
  assert(before.room.scene.modules.some(m => m.cargo?.ferro > 0));
  assert(before.room.scene.actors.some(a => a.vehicle && a.vehicle.angle === .17 && a.vehicle.vx === 2.5));
  assert.throws(() => new SharedRoom({ kept: structuredClone(before.room) }),
    /Integrated weapon material prefix differs from current fixed base geometry/);
  assert.deepEqual(readFileSync(input), original, 'normal50 refuses old live geometry without rewriting49');
  const preview = await convertFieldBase49({ input, output, pins, projects: [draft] });
  assert.equal(preview.status, 'SIMULATION_ONLY'); assert.equal(preview.simulationSteps, 0); assert.equal(preview.strictReopens, 2);
  assert(!readdirSync(dir).includes('converted')); assert.deepEqual(readFileSync(input), original);
  const receipt = await convertFieldBase49({ input, output, pins, projects: [draft], write: true }),
    result = JSON.parse(readFileSync(join(output, 'field.json')));
  assert.equal(receipt.status, 'WRITTEN'); assert.equal(receipt.outputSHA256, preview.outputSHA256);
  assert.equal(readFileSync(join(output, 'project-1.json'), 'utf8'), draftText);
  for (const key of Object.keys(before.room).filter(key => key !== 'scene')) assert.deepEqual(result.room[key], before.room[key], key);
  for (const key of ['time', 'tick', 'nextId', 'randomState', 'stats', 'recoveries', 'roads', 'plates'])
    assert.deepEqual(result.room.scene[key], before.room.scene[key], key);
  const carrier = new Set(['mass', 'carrierMass', 'carrierInertia', 'carrierCenter', 'localCenter']);
  for (const actor of before.room.scene.actors) {
    const fresh = result.room.scene.actors.find(a => a.id === actor.id);
    for (const key of Object.keys(actor).filter(key => key !== 'vehicle')) assert.deepEqual(fresh[key], actor[key], actor.id + ':' + key);
    if (actor.vehicle) for (const key of Object.keys(actor.vehicle).filter(key => !carrier.has(key)))
      assert.deepEqual(fresh.vehicle[key], actor.vehicle[key], actor.id + ':vehicle:' + key);
  }
  const derived = new Set(['physicalMass', 'physicalCenterLocal', 'physicalInertia', 'materialPolygons']);
  for (const old of before.room.scene.modules) {
    const fresh = result.room.scene.modules.find(m => m.id === old.id), changed = receipt.inertia.some(item => item.id === old.id);
    for (const key of Object.keys(old)) if (!changed || !derived.has(key)) assert.deepEqual(fresh[key], old[key], old.id + ':' + key);
  }
  assert(receipt.inertia.some(item => item.before !== item.after));
  await assert.rejects(convertFieldBase49({ input, output, pins, write: true }), error => error.code === 'OUTPUT_EXISTS');
  assert.deepEqual(readFileSync(input), original);

  // A valid quarter-scale fuel tank is .20 x .18 m. Its bounds, relative to this trunnion,
  // are x[-.175,.025], y[.0975,.2775]: clear of the old .15 m receiver and curved mask,
  // but across the new .012 m upper foot at H=.09/cos(.65)+.09*tan(.65).
  // Sensors have no quarter-scale size.
  // Its old library entry must stay recoverable; conversion must not silently move it.
  const conflict = structuredClone(before), floating = { version: 8, preset: 'bunker', name: 'Base intersection', nodes: [], plates: [], components: [
    { id: 'gun', kind: 'weapon', weaponPreset: 'minimi', pose: { x: 0, y: 0, angle: 0 }, mount: { preset: 'light-trunnion', sector: { min: 0, max: 0 } } },
    { id: 'interference', kind: 'fuel', sizeScale: .25, pose: { x: -1.5, y: 3.75, angle: 0 } },
  ] };
  conflict.room.factions[0].library.push({ id: 'base-conflict', blueprint: floating });
  const badInput = join(dir, 'overlap.json'), refusedOutput = join(dir, 'refused');
  writeFileSync(badInput, JSON.stringify(conflict), { mode: 0o600 });
  const badBytes = readFileSync(badInput);
  await assert.rejects(convertFieldBase49({ input: badInput, output: refusedOutput, pins, write: true }),
    error => error.phase === 'candidate' && ['CONSTRUCTION_OVERLAP', 'BREECH_COMPONENT'].includes(error.code));
  assert(!readdirSync(dir).includes('refused')); assert.deepEqual(readFileSync(badInput), badBytes); assert.deepEqual(readFileSync(input), original);
});

// A real two-vehicle checkpoint. Only fixture setup changes Native body pose/speed: restoring
// this already-moving, stretched cable must not run the stationary four-metre hitch admission.
function towCheckpoint(t) {
  const f = onField(t, rehearsal(BASES)), { room, world } = f, alice = room.join('Alice'),
    tug = f.publish(alice, 'truck'), target = f.publish(alice, 'supply'),
    frames = id => world.plates.filter(p => p.actorId === id && p.definition.chassis?.part === 'frame'),
    left = id => Math.min(...frames(id).map(p => p.bounds.minX)), right = id => Math.max(...frames(id).map(p => p.bounds.maxX));
  f.send(alice, 'auto', { actorId: target, on: false });
  f.put(tug, 0); f.put(target, world.actor(target).vehicle.x + left(tug) - 2 - right(target));
  const old = written(room); delete old.scene.tows;
  f.send(alice, 'tow', { act: 'attach', actorId: tug, targetId: target });
  f.order(alice, 'move', { ids: [tug], x: 30 });
  world.command('setVehicleState', { actorId: tug, state: { vx: 1 } });
  world.command('setVehicleState', { actorId: target, state: { x: world.actor(target).vehicle.x - 3, vx: 1 } });
  return { ...f, alice, tug, target, old };
}

test('an attached tow survives moving, stretched cold JSON without re-hitching or reviving the worker', t => {
  const { room, world, alice, tug, target, old } = towCheckpoint(t);
  assert.deepEqual(resumed(t, old).world.tows, [], 'an actual old scene has no cable');
  const live = world.tows[0];
  assert(Math.hypot(live.anchorA.x - live.anchorB.x, live.anchorA.y - live.anchorB.y) > 4, 'the saved pair is outside new-hitch range');
  assert.equal(world.actor(target).vehicle.vx, 1, 'and above new-hitch speed');
  const kept = written(room), link = kept.scene.tows[0], original = structuredClone(kept), cold = resumed(t, kept),
    unit = field => field.players.get(alice.playerId).squad.units.get(target),
    coldLink = JSON.parse(JSON.stringify(cold.world.keep().tows[0]));
  assert.deepEqual(Object.keys(link).sort(), ['actorId', 'targetId', 'partAId', 'partBId', 'localA', 'localB', 'length'].sort());
  assert.deepEqual(coldLink, link, 'cold restore resolves saved material endpoints without live hitch admission');
  assert.equal(cold.players.get(alice.playerId).squad.units.get(tug).move.x, 30);
  assert.equal(cold.records.get(target).auto, false); assert.deepEqual([unit(cold).move, unit(cold).haul, unit(cold).attack, unit(cold).fireAt], [null, null, null, null]);
  assert.deepEqual(kept, original, 'the supplied checkpoint is not rewritten');
  const back = cold.join('Alice', alice.token), before = cold.world.actor(target).vehicle,
    motion = [before.x, before.y, before.vx, before.vy];
  cold.command(back.playerId, { type: 'tow', act: 'detach', actorId: target });
  const after = cold.world.actor(target).vehicle;
  assert.deepEqual([after.x, after.y, after.vx, after.vy], motion); assert.equal(after.brake, 1); assert.deepEqual(cold.world.tows, []);
  assert.equal(cold.records.get(target).auto, false); assert.equal(unit(cold).move, null);
  assert.deepEqual([...room.faults, ...cold.faults], []);
});

test('an attached tow continues exactly from a Native binary Photo', nativePhotoOnly, t => {
  const { room, world } = towCheckpoint(t), photo = writeField(room, new Publication()), exact = onField(t, rehearsal(BASES)).room;
  readField(exact, photo);
  assert.equal(exact.digest(), room.digest()); assert.deepEqual(exact.world.tows, world.tows);
  // Host pacing is an input to a replay: the default measures CPU time and may
  // choose different AI rounds under load. Compare the same input on both cuts.
  room.step({ pace: () => 1 }); exact.step({ pace: () => 1 });
  assert.equal(exact.digest(), room.digest(), 'the same force and possible cable release continue from the exact Native cut');
  assert.deepEqual(exact.world.tows, world.tows); assert.deepEqual([...room.faults, ...exact.faults], []);
});
