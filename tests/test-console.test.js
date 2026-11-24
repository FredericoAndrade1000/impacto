import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveNetwork } from './helpers/network.js';
import { onField } from './helpers/field.js';
import { rehearsal } from '../server/room.ts';
import { checkTestSave, TEST_MARKER } from '../server/test-server.ts';
import { fieldServerConfig } from '../server/field-config.ts';
import { FieldHost, openRoom, replayField } from '../server/field-host.ts';
import { nativePhotoOnly } from './helpers/runtime.js';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { appraise, fieldParts, bill, STOCK_IDS, BASE_RADIUS } from '../src/economy.ts';
import { TEST_TARGET_TEAM, fieldAccumulator } from '../src/test-tools.ts';
import { TRIAL_WORLD } from '../src/battle-rules.ts';
import { FIXED_DT } from '../src/physics.ts';
import { PhysicsMetrics } from '../src/performance.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionSpan } from '../src/construction-placement.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { DomView } from '../src/dom-view.ts';
import { TestConsole } from '../src/test-console.ts';
import { workspaceDOM } from './helpers/dom.js';
import { Publication } from '../server/publication.ts';
import { chapters } from '../server/fog.ts';

function temporary(t, label, close = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), `impacto-test-${label}-`));
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function ask(ws, data, accept = message => message.request === data.request) {
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); ws.off('message', heard); ws.off('close', closed); },
      closed = () => { clear(); reject(new Error('Socket closed before the test reply.')); },
      heard = (bytes, binary) => {
        if (binary) return;
        const message = JSON.parse(bytes.toString());
        if (accept(message)) { clear(); resolve(message); }
      }, timer = setTimeout(() => { clear(); reject(new Error('Test server reply timed out.')); }, 8000);
    ws.on('message', heard); ws.on('close', closed); if (data) ws.send(JSON.stringify(data));
  });
}
const hello = ws => ask(ws, { type: 'hello', name: 'Tester', version: NETWORK_VERSION }, message => message.type === 'welcome');
const creation = (ticket, templateId = 'scout', x = -500, kind = 'vehicle') =>
  ({ type: 'test', act: 'spawn', kind, templateId, x, facing: 1, ticket });

test('test tools require an explicitly isolated server; forged requests on a normal server do not reach its diary or stock', { timeout: 30000 }, async t => {
  let network;
  const root = temporary(t, 'boundary', () => network?.close()), marked = join(root, 'marked'), occupied = join(root, 'occupied');
  mkdirSync(occupied); writeFileSync(join(occupied, 'field.json'), 'preserved fixture');
  assert.throws(() => checkTestSave(true, null), /absoluta e isolada/);
  assert.throws(() => checkTestSave(true, { dir: 'relative-test-save' }), /absoluta e isolada/);
  assert.throws(() => checkTestSave(true, { dir: occupied }), /dados existentes foram preservados/);
  assert.equal(readFileSync(join(occupied, 'field.json'), 'utf8'), 'preserved fixture');
  checkTestSave(true, { dir: marked }); assert(existsSync(join(marked, TEST_MARKER)));
  assert.throws(() => checkTestSave(false, { dir: marked }), /não abra como campo normal/);
  assert.deepEqual(fieldServerConfig({}), { testTools: false, save: null });
  assert.throws(() => fieldServerConfig({ IMPACTO_TEST_SERVER: 'true' }), /0 ou 1/);
  assert.throws(() => fieldServerConfig({ IMPACTO_TEST_SERVER: '1', IMPACTO_TEST_SAVE_DIR: marked, IMPACTO_SAVE_DIR: occupied }), /somente IMPACTO_TEST_SAVE_DIR/);
  const dir = join(root, 'normal'); network = await serveNetwork(t, { rehearsal: { bases: [-500] }, save: { dir } }); const ws = network.socket();
  await once(ws, 'open');
  const premature = await ask(ws, { type: 'test', act: 'list', request: 1, testTools: true });
  assert.match(premature.error, /indisponíveis/); assert.equal(premature.actors, undefined);
  const welcome = await hello(ws); assert.equal(welcome.testTools, undefined);
  for (const [request, data] of [[2, { type: 'test', act: 'list' }], [3, creation('forged')],
    [4, { type: 'test', act: 'resources', stock: bill(5, 6, 7, 8) }],
    [5, { type: 'spawn', blueprint: createStructuredTemplate('scout'), instant: true }],
    [6, { type: 'replace', actorId: 'unseen', blueprint: createStructuredTemplate('scout'), instant: true }],
    [7, { type: 'test', act: 'speed', factor: 8 }]]) {
    const refused = await ask(ws, { ...data, request, testTools: true, admin: true });
    assert.match(refused.error, /indisponíve/); assert.equal(refused.actor, undefined); assert.equal(refused.actors, undefined); assert.equal(refused.stock, undefined); assert.equal(refused.factor, undefined);
  }
  await network.close();
  const kept = JSON.parse(readFileSync(join(dir, 'field.json'), 'utf8')).room;
  assert.equal(kept.serials.c, 0); assert.equal(kept.scene.actors.length, 0);
  assert.deepEqual(kept.factions[0].stock, welcome.faction.stock);
  const lines = readdirSync(join(dir, 'replays')).flatMap(name => readFileSync(join(dir, 'replays', name), 'utf8').trim().split('\n').slice(1).map(JSON.parse));
  assert(!lines.some(line => line[1] === 'do' && (line[3].type === 'test' || line[3].instant)), 'refused before host.command');
});

test('an isolated test server lists administrative metadata and acts at distance without granting normal blueprint access', { timeout: 30000 }, async t => {
  let network;
  const dir = temporary(t, 'enabled', () => network?.close());
  network = await serveNetwork(t, { rehearsal: { bases: [-500] }, save: { dir }, testTools: true }); const ws = network.socket();
  await once(ws, 'open'); const welcome = await hello(ws); assert.equal(welcome.testTools, true);
  const spawned = await ask(ws, { ...creation('remote-target', 'scout', 5000, 'target'), request: 1 });
  assert.equal(spawned.error, undefined); assert.equal(spawned.actor.blueprint.name, createStructuredTemplate('scout').name);
  const listing = await ask(ws, { type: 'test', act: 'list', request: 2 });
  assert.deepEqual(listing.actors.map(actor => Object.keys(actor).sort()), [['active', 'facing', 'id', 'mobile', 'name', 'x']]);
  assert.equal(listing.actors[0].id, spawned.actor.id); assert.equal(listing.actors[0].active, true);
  assert(Math.abs(listing.actors[0].x - 5000) < 2);
  const ordinary = await ask(ws, { type: 'blueprint', actorId: spawned.actor.id, request: 3 });
  assert.equal(ordinary.actor, undefined, 'normal fog/ownership remains the normal command boundary');
  const repaired = await ask(ws, { type: 'test', act: 'repair', actorId: spawned.actor.id, request: 4 });
  assert.equal(repaired.error, undefined); assert.equal(repaired.changed, spawned.actor.id);
  const assigned = await ask(ws, { type: 'test', act: 'resources', stock: bill(1001, 1002, 1003, 1004), request: 5 });
  assert.equal(assigned.error, undefined); assert.deepEqual(assigned.stock, bill(1001, 1002, 1003, 1004));
  assert.equal(welcome.factor, 1); assert.equal(listing.factor, 1);
  const settings = ask(ws, { type: 'test', act: 'speed', factor: 8, request: 6 }, message => message.type === 'test-settings');
  assert.equal((await settings).factor, 8);
  assert.equal((await ask(ws, { type: 'test', act: 'list', request: 7 })).factor, 8);
  assert.match((await ask(ws, { type: 'test', act: 'speed', factor: 3, request: 8 })).error, /1, 2, 4 ou 8/);
  const observer = network.socket(); await once(observer, 'open');
  const observed = await ask(observer, { type: 'hello', name: 'Observer', version: NETWORK_VERSION }, message => message.type === 'welcome');
  assert.equal(observed.factor, 8, 'another joined tester sees the same global setting');
  const notice = ask(ws, null, message => message.type === 'test-settings' && message.factor === 2),
    [, changed] = await Promise.all([notice, ask(observer, { type: 'test', act: 'speed', factor: 2, request: 9 })]);
  assert.equal(changed.factor, 2);
  await network.close();
  const diary = readdirSync(join(dir, 'replays')).map(name => readFileSync(join(dir, 'replays', name), 'utf8')).join('\n');
  assert(!diary.includes('"act":"list"'), 'picker refresh has no do entry');
  assert(!diary.includes('"act":"speed"'), 'operational scheduling is not a deterministic room command');
  const kept = JSON.parse(readFileSync(join(dir, 'field.json'), 'utf8')).room;
  assert.equal(kept.testTools, undefined); assert.equal(kept.players[0].testTools, undefined);
  assert.equal(kept.testSpeed, undefined); assert.equal(kept.factor, undefined);
  assert.equal(kept.scene.actors[0].ownerId, null); assert.equal(kept.scene.actors[0].team, TEST_TARGET_TEAM);
  network = await serveNetwork(t, { rehearsal: { bases: [-500] }, save: { dir }, testTools: true });
  const resumed = network.socket(); await once(resumed, 'open');
  const returned = await ask(resumed, { type: 'hello', name: 'Tester', token: welcome.token, version: NETWORK_VERSION }, message => message.type === 'welcome');
  assert.equal(returned.factor, 1, 'restart does not resume operational acceleration from JSON');
  await network.close();
});

test('an F1 bunker exists before detection and its real exterior is published once a camera sees it', t => {
  const f = onField(t, rehearsal([-500])), { room, world } = f, joined = room.join('Tester'),
    player = room.players.get(joined.playerId), command = data => room.command(player.id, data),
    created = command(creation('optical-bunker', 'bunker', 400, 'target')), target = world.actor(created.actor.id),
    publication = new Publication(), shown = () => {
      const state = publication.state(world.snapshot()); state.shared = true; state.players = room.roster();
      return room.audience(state, chapters(state), [], player.factionId).state;
    };
  assert(target && !target.defeated);
  room.look();
  assert.equal(room.knows(player.factionId, target), null, 'administrative creation grants no optical sight');
  assert(!shown().actors.some(actor => actor.id === target.id));
  command(creation('optical-observer', 'scout', 300));
  assert(f.until(() => { room.look(); return room.knows(player.factionId, target) === 'seen'; }, 1.5),
    'ordinary room and sensor cadence discover the new target without a forced native reading');
  const visible = shown();
  assert(visible.actors.some(actor => actor.id === target.id && !actor.ghost));
  assert(visible.plates.some(plate => plate.actorId === target.id), 'concrete geometry reaches the renderer');
  assert(visible.bodyPanels.some(panel => panel.actorId === target.id), 'the closed bunker has a real exterior');
});

test('the worker accumulator scales fixed-step cadence and keeps existing debt and work budgets while pace reports achieved time', () => {
  const advance = (factor, elapsed = .01, turns = 100) => {
    let accumulator = 0, total = 0, largest = 0;
    for (let turn = 0; turn < turns; turn++) {
      accumulator = fieldAccumulator(accumulator, elapsed, factor);
      let steps = 0;
      while (accumulator + 1e-10 >= FIXED_DT && steps < 4) { steps++; total++; accumulator -= FIXED_DT; }
      largest = Math.max(largest, steps);
    }
    return { total, largest, accumulator };
  };
  assert.equal(advance(1).total, 60); assert.equal(advance(2).total, 120); assert.equal(advance(4).total, 240);
  const loaded = advance(8); assert.equal(loaded.largest, 4); assert(loaded.total < 480, 'requested rate cannot override the existing step budget');
  assert(fieldAccumulator(.24, 1000, 8) <= .25, 'a delayed timer keeps the existing debt cap');
  const metrics = new PhysicsMetrics(0, 0), achieved = metrics.read(1000, 4, 1, false, 0, 0);
  assert.equal(achieved.simRatio, 4, 'never divide reported pace by the requested acceleration');
});

test('test maintenance preserves cargo and stock, separates repair from reserves, rejects wrecks and fixed movement, and deduplicates creation', t => {
  const f = onField(t, rehearsal([-500])), { room, world } = f, player = room.join('Tester'), p = room.players.get(player.playerId),
    command = data => room.command(player.playerId, data), vehicle = command(creation('working', 'ifv')).actor.id,
    hauler = command(creation('cargo', 'truck', -480)).actor.id, stock = structuredClone(room.faction(p).stock);
  assert.equal(p.selected, null); assert.equal(p.squad.manual, null, 'creation never takes manual control');
  const before = room.serials.c, again = command(creation('working', 'ifv'));
  assert.equal(again.actor.id, vehicle); assert.equal(room.serials.c, before);
  assert.throws(() => command(creation('working', 'ifv', 600)), /outra criação/);
  assert.throws(() => command(creation('invalid', 'plate')), /inválido/);
  assert.throws(() => command(creation('beyond', 'scout', world.terrain.maxX)), /fora do campo/);
  assert.equal(room.serials.c, before, 'refusal consumes no actor identity');
  const fuel = f.parts(vehicle, 'fuel')[0], ammo = f.parts(vehicle, 'ammo')[0], engine = f.parts(vehicle, 'engine')[0], bin = f.parts(hauler, 'hopper')[0];
  assert(fuel && ammo && engine && bin);
  f.set(fuel, { fuelLitres: 7 }); f.set(ammo, { rounds: 3 }); f.set(engine, { health: engine.maxHealth / 2 }); f.set(bin, { cargo: { ferro: 37.125 } });
  const quote = id => appraise(world.actor(id), fieldParts(world)), injured = quote(vehicle), cargo = quote(hauler).levels;
  command({ type: 'test', act: 'resupply', actorId: vehicle });
  const supplied = quote(vehicle); assert.equal(supplied.repair.ferro, injured.repair.ferro, 'resupply does not repair');
  assert(Object.values(supplied.levels).some(level => level.fuelLitres > 7));
  f.set(f.parts(vehicle, 'fuel')[0], { fuelLitres: 7 }); f.set(f.parts(vehicle, 'ammo')[0], { rounds: 3 });
  const levels = quote(vehicle).levels;
  command({ type: 'test', act: 'repair', actorId: vehicle }); assert.deepEqual(quote(vehicle).levels, levels);
  assert.equal(quote(vehicle).repair.ferro, 0, 'repair restores damage');
  command({ type: 'test', act: 'repair', actorId: hauler }); command({ type: 'test', act: 'resupply', actorId: hauler });
  assert.deepEqual(quote(hauler).levels, cargo, 'cargo is not a reserve and is preserved by both operations');
  command({ type: 'test', act: 'reposition', actorId: vehicle, x: 2500, facing: -1 });
  assert.equal(world.actor(vehicle).facing, -1); assert(Math.abs(world.actor(vehicle).vehicle.x - 2500) < 1e-6);
  assert.deepEqual(quote(vehicle).levels, levels, 'turning/repositioning does not refill');
  assert.equal(world.actor(vehicle).vehicle.vx, 0); assert.equal(world.actor(vehicle).vehicle.vy, 0);
  const fixed = command(creation('fixed', 'guard-post', -400, 'target')).actor.id;
  assert.throws(() => command({ type: 'test', act: 'reposition', actorId: fixed, x: 0, facing: 1 }), /apenas para veículos móveis/);
  world.actor(vehicle).defeated = true;
  for (const act of ['repair', 'resupply', 'reposition']) assert.throws(() => command({ type: 'test', act, actorId: vehicle, x: 0, facing: 1 }), /fora de combate/);
  assert.deepEqual(room.faction(p).stock, stock, 'free test actions neither debit nor mint faction stocks');
  const other = room.join('Other'), theirs = room.factions.get(other.faction.id), foreignStock = { ...theirs.stock }, faction = room.faction(p),
    yard = { ...faction.yard }, carried = quote(hauler).levels, assigned = bill(1001, 1002, 1003, 1004);
  assert.deepEqual(command({ type: 'test', act: 'resources', stock: assigned, factionId: theirs.id }), { stock: assigned });
  assert.deepEqual(faction.stock, assigned); assert.deepEqual(theirs.stock, foreignStock, 'caller cannot name another faction');
  assert.deepEqual(faction.yard, yard); assert.deepEqual(quote(hauler).levels, carried, 'resources changes no raw yard or cargo');
  for (const ferro of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => command({ type: 'test', act: 'resources', stock: { ...assigned, ferro } }), /inteiras/);
  assert.throws(() => command({ type: 'test', act: 'resources', stock: { ferro: 1 } }), /quatro estoques/);
  assert.throws(() => command({ type: 'test', act: 'resources', stock: { ...assigned, petroleo: 1 } }), /inválidos/);
  assert.deepEqual(faction.stock, assigned, 'all resource validation precedes mutation');
  assert.equal(command({ type: 'test', act: 'resources', stock: { ...assigned, ferro: Number.MAX_SAFE_INTEGER } }).stock.ferro, Number.MAX_SAFE_INTEGER);
  const base = faction.base; faction.base = null;
  assert.throws(() => command({ type: 'test', act: 'resources', stock: assigned }), /base/i); faction.base = base;
});

test('instant publication pays normal costs, completes the same works and leaves existing builds alone without advancing time', t => {
  const f = onField(t, rehearsal([-500], bill(1e7, 1e7, 1e7, 1e7), { build: true, fog: false })), { room, world } = f,
    player = room.join('Tester'), p = room.players.get(player.playerId), faction = room.faction(p), source = createStructuredTemplate('scout'),
    at = world.time, normal = f.send(player, 'spawn', { blueprint: source, x: -500, facing: 1, ticket: 'normal' });
  assert(normal.seconds > 0); assert.equal(room.records.get(normal.actor.id).service.kind, 'build');
  const stock = { ...faction.stock }, instant = f.send(player, 'spawn', { blueprint: source, x: -480, facing: 1, ticket: 'instant', instant: true });
  assert.equal(instant.seconds, 0); assert.equal(room.records.get(instant.actor.id).service, null);
  assert.equal(room.records.get(normal.actor.id).service.kind, 'build', 'does not finish an older manufacturing job');
  for (const id of STOCK_IDS) assert.equal(faction.stock[id], stock[id] - instant.cost[id]);
  const serial = room.serials.c, paid = { ...faction.stock };
  assert.equal(f.send(player, 'spawn', { blueprint: source, x: -480, facing: 1, ticket: 'instant', instant: true }).actor.id, instant.actor.id);
  assert.equal(room.serials.c, serial); assert.deepEqual(faction.stock, paid, 'same ticket never pays twice');
  const fixed = createStructuredTemplate('guard-post'), position = f.site(player, fixed), beforeWorks = { ...faction.stock },
    completed = f.send(player, 'spawn', { blueprint: fixed, x: position, facing: 1, instant: true, ticket: 'fixed' });
  assert(completed.actor, completed.blocked); assert.equal(completed.seconds, 0); assert.equal(room.works.pending.size, 0);
  assert.equal(world.actor(completed.actor.id).ownerId, p.id); assert.equal(world.actor(completed.actor.id).team, faction.id);
  for (const id of STOCK_IDS) assert.equal(faction.stock[id], beforeWorks[id] - completed.cost[id]);
  const waiting = f.open(player, fixed, { from: 200, ticket: 'waiting' }), pending = room.works.pending.get(waiting);
  assert.equal(pending.progress, 0, 'unflagged publication keeps normal works semantics');
  const replacement = f.send(player, 'replace', { actorId: instant.actor.id, blueprint: source, facing: 1, ticket: 'replacement', instant: true });
  assert.equal(replacement.actor.id, instant.actor.id); assert.equal(replacement.seconds, 0);
  assert.equal(room.works.pending.get(waiting), pending); assert.equal(pending.progress, 0);
  f.send(player, 'test', { act: 'resources', stock: bill() });
  const refusedAt = f.site(player, fixed, { from: 240 }), before = [room.serials.c, world.actors.length, room.works.pending.size];
  assert.throws(() => f.send(player, 'spawn', { blueprint: fixed, x: refusedAt, facing: 1, instant: true }), /[Ff]alt|[Rr]ecur|[Pp]recis/);
  assert.deepEqual([room.serials.c, world.actors.length, room.works.pending.size], before);
  assert.equal(world.time, at, 'no clock, physics step or old queue is fast-forwarded');
});

test('replacement retains a fitting position, uses a nearby base gap for a larger design and preserves the old actor when the base is full', t => {
  const f = onField(t, rehearsal([-500])), { room, world } = f, player = room.join('Tester'), faction = room.factions.get(player.faction.id),
    id = f.publish(player, 'scout', { x: -500, facing: 1 }), from = world.actor(id).vehicle.x,
    same = f.send(player, 'replace', { actorId: id, blueprint: createStructuredTemplate('scout'), facing: 1 });
  assert.equal(same.relocated, undefined); assert.equal(world.actor(id).vehicle.x, from);
  const choices = ['truck', 'howitzer', 'heavy'].map(template => {
    const source = createStructuredTemplate(template), span = constructionSpan(compileStructuredConstruction(source), { x: 0, facing: 1 });
    return { source, span, width: span.maxX - span.minX };
  }).sort((a, b) => b.width - a.width), wide = choices[0], oldBounds = world.actorBounds(id),
    rightGrowth = from + wide.span.maxX - oldBounds.maxX, leftGrowth = oldBounds.minX - from - wide.span.minX,
    blockerX = rightGrowth >= leftGrowth ? from + (oldBounds.maxX - oldBounds.minX) + 1 : from - (oldBounds.maxX - oldBounds.minX) - 1;
  assert(Math.max(rightGrowth, leftGrowth) > 1, 'fixture requires a genuinely larger catalogue outline');
  const blocker = f.publish(player, 'scout', { x: blockerX, facing: 1 }), neighbour = world.actor(blocker), neighbourX = neighbour.vehicle.x,
    stock = { ...faction.stock }, replaced = f.send(player, 'replace', { actorId: id, blueprint: wide.source, facing: 1 });
  assert.equal(replaced.actor.id, id); assert.equal(replaced.relocated.from, from); assert.equal(replaced.relocated.to, world.actor(id).vehicle.x);
  assert(Math.abs(replaced.relocated.to - faction.base.x) <= BASE_RADIUS);
  assert.equal(world.actor(blocker), neighbour); assert.equal(neighbour.vehicle.x, neighbourX, 'does not push the neighbour away');
  const ours = world.actorBounds(id), beside = world.actorBounds(blocker);
  assert(ours.maxX + .8 < beside.minX || ours.minX - .8 > beside.maxX, 'the new physical outline fits the gap');
  for (const key of STOCK_IDS) assert.equal(faction.stock[key], stock[key] - replaced.cost[key]);

  // A declared already-built defensive site, within the existing fixed cap. A captured base can contain structures.
  // Their physical outlines cover the base for the new vehicle; no mock of placement/bounds is used.
  const full = onField(t, rehearsal([-500])), owner = full.room.join('Full'), base = full.room.factions.get(owner.faction.id),
    keptId = full.publish(owner, 'truck', { x: -500, facing: 1 }), kept = full.world.actor(keptId), count = Math.min(21, CONSTRUCTION_LIMITS.fixed),
    defence = createStructuredTemplate('guard-post'), defenceSpan = constructionSpan(compileStructuredConstruction(defence), { x: 0, facing: 1 });
  assert(wide.width + defenceSpan.maxX - defenceSpan.minX + 1.6 > 2 * BASE_RADIUS / (count - 1), 'fixture covers gaps between its structures');
  for (let i = 0; i < count; i++) full.world.addActor(defence, { id: `standing:${i}`, ownerId: owner.playerId, team: base.id,
    x: base.base.x - BASE_RADIUS + 2 * BASE_RADIUS * i / (count - 1), facing: 1 });
  const hopper = full.parts(keptId, 'hopper')[0]; full.set(hopper, { cargo: { ferro: 37.125 } });
  const before = { stock: { ...base.stock }, serial: full.room.serials.c, revision: kept.revision, x: kept.vehicle.x,
    levels: appraise(kept, fieldParts(full.world)).levels, actors: full.world.actors.length };
  assert.throws(() => full.send(owner, 'replace', { actorId: keptId, blueprint: wide.source, facing: 1 }), /Não há espaço aí/);
  assert.equal(full.world.actor(keptId), kept); assert.equal(kept.revision, before.revision); assert.equal(kept.vehicle.x, before.x);
  assert.equal(full.room.serials.c, before.serial); assert.equal(full.world.actors.length, before.actors);
  assert.deepEqual(base.stock, before.stock); assert.deepEqual(appraise(kept, fieldParts(full.world)).levels, before.levels);
});

test('test actions before and after a real segmented photo replay exactly without a saved administrative privilege', nativePhotoOnly, async t => {
  let host;
  const dir = temporary(t, 'replay', () => { host?.diary?.close(); host?.room.field.dispose(); }), field = { bases: [-500] };
  host = new FieldHost(openRoom(field), { field, segment: Infinity }); const room = host.room;
  host.record(dir); const player = host.join('Tester'), command = data => host.command(player.playerId, data);
  command({ type: 'test', act: 'resources', stock: bill(1e7, 1e7, 1e7, 1e7) });
  const id = command(creation('before-photo', 'scout')).actor.id;
  for (let i = 0; i < 60; i++) host.step();
  host.flush(); const first = host.diary.file, firstDigest = room.digest(); host.cut();
  assert.notEqual(host.diary.file, first); const second = host.diary.file;
  assert.equal(command(creation('before-photo', 'scout')).actor.id, id, 'ticket remains deduplicated across the real photo');
  command({ type: 'test', act: 'reposition', actorId: id, x: -450, facing: -1 });
  command({ type: 'test', act: 'resupply', actorId: id }); command({ type: 'test', act: 'repair', actorId: id });
  command(creation('after-photo', 'scout', -430, 'target'));
  command({ type: 'spawn', blueprint: createStructuredTemplate('scout'), x: -490, facing: 1, ticket: 'instant-after-photo', instant: true });
  for (let i = 0; i < 60; i++) host.step(); host.flush();
  for (const [file, expected] of [[first, firstDigest], [second, room.digest()]]) {
    const lines = readFileSync(file, 'utf8').trim().split('\n'), header = JSON.parse(lines[0]);
    assert.equal(Boolean(header.snapshot), file === second);
    const again = await replayField(lines); t.after(() => again.host.room.field.dispose());
    assert.equal(again.how, 'end', again.got); assert.equal(again.host.room.digest(), expected);
    assert.equal(again.host.room.testTools, undefined);
  }
});

test('the private worker confines tools to proving ground, addresses explicit targets and restores the original workshop by normal load', async t => {
  const told = [], before = { self: globalThis.self, setInterval: globalThis.setInterval }, original = createStructuredTemplate('scout'),
    source = structuredClone(original);
  globalThis.self = { postMessage: message => told.push(message) }; globalThis.setInterval = () => 0;
  const send = data => { told.length = 0; globalThis.self.onmessage({ data }); return told.find(message => message.type === 'reply'); },
    frame = () => told.find(message => message.type === 'frame'), ack = () => { const seen = frame(); if (seen) send({ type: 'ack', serial: seen.serial }); };
  try {
    await import('../src/simulation-worker.ts'); globalThis.setInterval = before.setInterval;
    send({ type: 'load', request: 1, generation: 1, blueprint: original, terrain: 'flat', targets: false }); ack();
    assert.match(send({ type: 'test', act: 'list', request: 2 }).error, /apenas no campo de provas/);
    send({ type: 'load', request: 3, generation: 2, blueprint: original, terrain: TRIAL_WORLD.terrain, targets: true }); ack();
    const initial = send({ type: 'test', act: 'list', request: 4 }).actors, originalName = initial.find(actor => actor.id === 'local').name;
    assert.match(send({ type: 'test', act: 'resources', stock: bill(1, 2, 3, 4), request: 41 }).error, /não tem estoque/);
    assert.match(send({ type: 'test', act: 'speed', factor: 4, request: 42 }).error, /servidor de testes/);
    const replacement = send({ ...creation('private-swap', 'truck', 12), request: 5 });
    assert.equal(replacement.actor.id, 'local'); assert.equal(replacement.actor.blueprint.name, createStructuredTemplate('truck').name); ack();
    assert.notEqual(send({ type: 'test', act: 'list', request: 51 }).actors.find(actor => actor.id === 'local').name, originalName);
    const target = send({ ...creation('private-target', 'scout', -200, 'target'), request: 6 }).actor.id; ack();
    for (const act of ['repair', 'resupply']) { assert.deepEqual(send({ type: 'test', act, actorId: target, request: 7 }).changed, target); ack(); }
    assert.equal(send({ type: 'test', act: 'reposition', actorId: target, x: -250, facing: -1, request: 8 }).changed, target); ack();
    const listed = send({ type: 'test', act: 'list', request: 9 }).actors;
    assert.equal(listed.length, initial.length + 1); assert(Math.abs(listed.find(actor => actor.id === target).x + 250) < 1e-6);
    send({ type: 'load', request: 10, generation: 3, blueprint: original, terrain: TRIAL_WORLD.terrain, targets: true });
    assert.equal(frame().state.actors.find(actor => actor.id === 'local').name, originalName);
    ack(); assert.deepEqual(send({ type: 'test', act: 'list', request: 11 }).actors.map(actor => actor.id), initial.map(actor => actor.id));
    assert.deepEqual(original, source, 'the supplied workshop design was never rewritten');
  } finally {
    if (globalThis.self?.onmessage) send({ type: 'clear', request: 12, generation: 4 });
    Object.assign(globalThis, before);
  }
});

function consoleSurface(t, request) {
  const { create } = workspaceDOM(t), ui = new DomView(), get = id => ui.get('#' + id);
  const controls = {
    select: ['test-facing', 'test-actor', 'test-vehicle-template', 'test-target-template', 'test-speed'],
    input: ['test-position-x', 'test-instant', ...STOCK_IDS.map(id => 'test-stock-' + id)],
    button: ['test-console-toggle', 'test-create-vehicle', 'test-create-target', 'test-repair', 'test-resupply', 'test-reposition',
      'test-refresh-actors', 'test-use-camera', 'test-set-stock', 'test-use-stock', 'test-set-speed'],
    p: ['test-console-scope', 'test-vehicle-note', 'test-actor-description', 'test-position-help', 'test-private-fabrication-note',
      'test-stock-help', 'test-reposition-reason', 'test-console-status', 'test-speed-current'],
    details: ['test-server-tools', 'test-server-speed'],
  };
  for (const [tag, ids] of Object.entries(controls)) for (const id of ids) {
    const element = create(tag, id); element.value = ''; element.checked = false;
    if (tag === 'input') Object.defineProperty(element, 'valueAsNumber', {
      get() { return this.value === '' ? NaN : Number(this.value); },
    });
  }
  get('test-facing').value = '-1';
  const panel = new TestConsole(ui, { request, cameraX: () => 42, stopControls() {}, refresh() {}, notify() {} });
  return { panel, get };
}

const uiActor = id => ({ id, name: 'Veículo ' + id, x: 42, facing: -1, mobile: true, active: true });
const uiContext = () => ({ key: {}, available: true, testServer: true, trial: false, open: true, blocked: '',
  selectedId: 'a', actors: [], speed: 1, stock: Object.fromEntries(STOCK_IDS.map(id => [id, 100])) });

test('the F1 picker follows real game selection once, keeps panel-only choice, and ignores an old socket reply', async t => {
  const rows = ['a', 'b', 'c'].map(uiActor), calls = [], pending = [];
  let delay = false;
  const f = consoleSurface(t, intent => {
    calls.push(intent);
    if (delay) return new Promise(resolve => pending.push(resolve));
    return Promise.resolve({ actors: rows });
  }), c = uiContext();
  f.panel.render(c); await f.panel.act('list', null, 'a');
  const picked = { ...c, selectedId: 'b' };
  f.panel.render(picked); await Promise.resolve();
  assert.equal(f.get('test-actor').value, 'b');
  const queries = calls.length;
  for (let frame = 0; frame < 10; frame++) f.panel.render({ ...picked });
  assert.equal(calls.length, queries, 'ordinary frames do not poll the roster');
  f.get('test-actor').value = 'c'; f.get('test-actor').dispatch('change');
  f.panel.render({ ...picked }); assert.equal(f.get('test-actor').value, 'c');
  assert(calls.every(intent => intent.act === 'list'), 'choosing in the panel neither controls nor orders an actor');
  delay = true; const old = f.panel.act('list');
  f.panel.render({ ...c, key: {}, open: false }); pending.shift()({ actors: rows }); await old;
  assert.equal(f.get('test-actor').value, '', 'reply from the old socket cannot repopulate the new picker');
});

test('F1 resources preserve exact stock units and require four safe integers, and private trials have no stock tools', async t => {
  const sent = [], f = consoleSurface(t, intent => { sent.push(intent); return Promise.resolve({ stock: intent.stock }); }), c = uiContext();
  f.panel.render(c); f.panel.useStock();
  f.get('test-stock-ferro').value = '0'; f.get('test-stock-combustivel').value = String(Number.MAX_SAFE_INTEGER);
  const stock = { ...c.stock, ferro: 0, combustivel: Number.MAX_SAFE_INTEGER };
  await f.panel.act('resources'); assert.deepEqual(sent, [{ act: 'resources', stock }]);
  assert.equal(f.get('test-stock-combustivel').value, String(Number.MAX_SAFE_INTEGER));
  for (const invalid of ['-1', '1.5', '', '9007199254740992']) {
    f.get('test-stock-ferro').value = invalid;
    assert.throws(() => f.panel.intent('resources'), /quatro valores inteiros/);
  }
  f.panel.render({ ...c, key: {}, trial: true, testServer: false, actors: [] });
  assert.equal(f.get('test-server-tools').hidden, true);
  assert.equal(f.get('test-private-fabrication-note').hidden, false);
  assert.throws(() => f.panel.intent('resources'), /servidor de testes/);
  assert.equal(sent.length, 1, 'no actor list or private stock mutation was requested');
});

test('F1 instant fabrication survives the workshop on the same explicit test socket and is cleared outside it', t => {
  const f = consoleSurface(t, () => { throw new Error('this choice sends no command'); }), c = uiContext();
  f.panel.render(c); f.get('test-instant').checked = true;
  f.panel.render({ ...c, available: false, open: false });
  assert.equal(f.panel.available, false); assert.equal(f.panel.instant, true, 'workshop hides the panel but preserves the same-connection intent');
  f.panel.render({ ...c, key: {} }); assert.equal(f.panel.instant, false);
  f.get('test-instant').checked = true;
  f.panel.render({ ...c, available: false, testServer: false, open: false }); assert.equal(f.panel.instant, false);
  f.panel.render(c); f.get('test-instant').checked = true;
  f.panel.render({ ...c, key: 7, trial: true, testServer: false, actors: [] }); assert.equal(f.panel.instant, false);
});

test('F1 server speed uses reported settings, sends a closed factor, and does not poll or leak into trials', async t => {
  const sent = [], f = consoleSurface(t, intent => { sent.push(intent); return Promise.resolve({ factor: intent.factor }); }), c = uiContext();
  f.panel.render(c); assert.equal(f.get('test-speed').value, '1');
  f.get('test-speed').value = '4'; f.get('test-speed').dispatch('input');
  for (let frame = 0; frame < 10; frame++) f.panel.render({ ...c });
  assert.equal(f.get('test-speed').value, '4', 'unchanged reported settings preserve the pending choice');
  assert.equal(sent.length, 0, 'normal frames do not ask for settings');
  await f.panel.act('speed'); assert.deepEqual(sent, [{ act: 'speed', factor: 4 }]);
  f.panel.render({ ...c, speed: 2 });
  assert.equal(f.get('test-speed').value, '2', 'a new server-reported factor wins over a draft');
  for (const invalid of ['', '0', '3', '16']) {
    f.get('test-speed').value = invalid;
    assert.throws(() => f.panel.intent('speed'), /1×, 2×, 4× ou 8×/);
  }
  f.panel.render({ ...c, key: {}, speed: 1 }); assert.equal(f.get('test-speed').value, '1');
  f.panel.render({ ...c, key: 7, trial: true, testServer: false, speed: null, actors: [] });
  assert.equal(f.get('test-server-speed').hidden, true);
  assert.throws(() => f.panel.intent('speed'), /servidor de testes/);
  assert.equal(sent.length, 1, 'speed changes neither query actors nor run in the private trial');
});
