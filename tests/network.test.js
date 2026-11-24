import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { FIXED_DT, World } from '../src/physics.ts';
import { THROTTLE_IN, THROTTLE_OUT } from '../src/episode-input.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { PART_LIMITS, createStructuredConstruction, compileStructuredConstruction } from '../src/structured-construction.ts';
import { weaponSettings } from '../src/weapons.ts';
import { SharedRoom, rehearsal, ROOM_LIMITS } from '../server/room.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { decodeFrame, FrameWriter, FrameReader, NETWORK_VERSION, merged, keyOf, keyText } from '../src/network-protocol.ts';
import { MAIN_WORLD, AIM_SKY } from '../src/battle-rules.ts';
import { shotCount } from '../src/shots.ts';
import { proxyTrust } from '../server/network-address.ts';
import { WORLD_LIMITS } from '../server/network-limits.ts';
import { Publication } from '../server/publication.ts';
import { permanentParts, partsPreserved, partPhysics } from '../scripts/review-harness.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { regionGeometry } from '../src/scene-frame.ts';
import { serveNetwork } from './helpers/network.js';

function shared() { const w = new World(createStructuredConstruction({ preset: 'bunker', length: .2, height: .2, frontInset: .01, rearInset: .01 })); w.removeActor('local'); w.bounds = { minX: -200, maxX: 200 }; return w; }
const advance = (w, n) => { for (let i = 0; i < n; i++) w.step(); };
function two() { const w = shared(), blueprint = createStructuredTemplate('heavy'); w.addActor(blueprint, { id: 'a', ownerId: 'alice', x: -6, facing: 1 }); w.addActor(blueprint, { id: 'b', ownerId: 'bob', x: 6, facing: -1 }); return w; }

test('network publication rejects old authoring and read-only geometry without modifying the admitted world', t => {
  const room = rehearsal(), player = room.join('Alice'), source = createStructuredTemplate('heavy');
  t.after(() => room.world.dispose());
  const published = room.publish(player.playerId, source).actor;
  assert.equal(published.blueprint.version, DESIGN_VERSION); assert.equal(published.blueprint.derived, undefined);
  const before = room.world.game().core.current_frame(), selected = room.players.get(player.playerId).selected;
  room.players.get(player.playerId).builtAt = -Infinity;
  for (const rejected of [{ version: 1, preset: 'vehicle', plates: [], modules: [] },
    ...[2, 3, 4].map(version => ({ ...structuredClone(source), version })), compileStructuredConstruction(source)]) {
    assert.throws(() => room.publish(player.playerId, rejected), /não pode ser fabricado/);
    assert.throws(() => room.command(player.playerId, { type: 'replace', actorId: published.id,
      blueprint: rejected }), /não pode ser fabricado/);
    assert.equal(room.world.game().core.current_frame(), before);
    assert.equal(room.players.get(player.playerId).selected, selected);
    assert.equal(room.world.actors.length, 1);
  }
  assert.deepEqual(room.command(player.playerId, { type: 'blueprint', actorId: published.id }).actor.blueprint, source);
});

test('a bunker keeps its fixed carrier beside moving vehicles while blast damage changes only ballistic material', t => {
  const w = two(); w.addActor(createStructuredTemplate('bunker'), { id: 'bunker', ownerId: 'alice', x: -18 });
  t.after(() => w.dispose()); const initial = permanentParts(w);
  const bunker = w.plates.filter(p => p.actorId === 'bunker'),
    positions = bunker.map(p => p.nodes.map(n => [n.x, n.y]));
  w.controlVehicle(1, 0, 'a'); advance(w, 180);
  assert.equal(Object.hasOwn(w.snapshot(), 'fragments'), false);
  const states = w.game().call({ op: 'physics' });
  assert.equal(states.bodyStates.length, 3);
  assert(w.plates.every(p => p.integrity > 0.999999));
  const concrete = w.plates.find(p => p.actorId === 'bunker' && p.material.id === 'concrete');
  bunker.forEach((p, i) => assert.deepEqual(p.nodes.map(n => [n.x, n.y]), positions[i]));
  const fixed = partPhysics(w, concrete);
  assert.equal(fixed.state.dynamic, false, 'the bunker uses one fixed rigid carrier');
  assert(bunker.every(p => partPhysics(w, p).body === fixed.body));
  const originalArea = concrete.remainingArea, originalMass = concrete.physicalMass,
    contours = structuredClone(w.actor('bunker').contactContours);
  // Load the real outside face; a point inside the solid has no exposed face.
  const faceOffset = concrete.definition.thicknessMm / 2000 + .01,
    angle = concrete.definition.angle;
  w.explode(concrete.definition.x + Math.sin(angle) * faceOffset,
    concrete.definition.y - Math.cos(angle) * faceOffset, 180, 2.5); advance(w, 8);
  assert(concrete.remainingArea < originalArea, 'the blast still opens real ballistic apertures');
  assert.equal(concrete.physicalMass, originalMass); assert.equal(partPhysics(w, concrete).body, fixed.body);
  assert.deepEqual(w.actor('bunker').contactContours, contours);
  assert(partsPreserved(w, initial), 'ballistic damage preserves construction identity and its rigid carrier');
  assert.equal(Object.hasOwn(w.snapshot(), 'fragments'), false); assert(!Object.hasOwn(w, 'ejectedMassBySource'));
});

test('multiple vehicles have unique geometry, separate engines and independent controls', () => {
  const w = two(), parts = [...w.plates, ...w.modules];
  assert.equal(new Set(parts.map(p => p.id)).size, parts.length);
  assert.deepEqual(new Set(parts.map(p => p.actorId)), new Set(['a', 'b']));
  const b = w.actor('b').vehicle.x; w.controlVehicle(1, 0, 'a'); advance(w, 40);
  assert(w.actor('a').vehicle.x > -5.8); assert(Math.abs(w.actor('b').vehicle.x-b)<0.01);assert.equal(w.actor('b').vehicle.throttle,0);
  w.command('setPartState', { owner: w.game().handle(w.modules.find(m => m.actorId === 'a' && m.kind === 'engine')), state: { health: 0 } }); advance(w, 3);
  assert.equal(w.actor('a').vehicle.engine, false); assert.equal(w.actor('b').vehicle.engine, true);
});
test('mounted fire strikes an opposing vehicle and transfers momentum to that vehicle', () => {
  const w = two(), gun = weaponSettings('cannon', { preset: 'rh120', platform: 'vehicle', spread: 0 });
  const installed = w.modules.find(m => m.actorId === 'a' && m.kind === 'weapon');
  assert(w.fire({ x: 6, y: installed.y }, gun, false, 'a')); advance(w, 20);
  assert(w.actor('a').vehicle.peakImpulse > 5000); assert(w.actor('b').vehicle.peakImpulse > 100);
  assert(w.modules.some(m => m.actorId === 'b' && m.health < m.maxHealth));
  assert.equal(w.modules.find(m => m.actorId === 'a' && m.kind === 'weapon').health, w.modules.find(m => m.actorId === 'a' && m.kind === 'weapon').maxHealth);
});
test('room ownership applies to control, editing, servicing and removal', () => {
  const room = rehearsal(), a = room.join('Alice'), b = room.join('Bob');
  const one = room.publish(a.playerId, createStructuredTemplate('heavy')).actor, two = room.publish(b.playerId, createStructuredTemplate('heavy')).actor;
  for (const type of ['drive', 'fire', 'trigger', 'select', 'repair', 'replace', 'remove', 'abandon', 'blueprint']) assert.throws(() => room.command(a.playerId, { type, actorId: two.id }), /de outra facção/);
  assert.equal(room.world.actors.length, 2); assert(room.world.actor(one.id));
});

test('repairing and dismantling one construction leaves the damage of the others and the shared clock alone', t => {
  const room = rehearsal([0]), a = room.join('Alice'), b = room.join('Bob'); t.after(() => room.world.dispose());
  const one = room.publish(a.playerId, createStructuredTemplate('heavy')).actor, two = room.publish(b.playerId, createStructuredTemplate('heavy')).actor;
  // In their players' hands, neither is mended by itself: the repair is asked for.
  for (const [player, actor] of [[a, one], [b, two]]) room.command(player.playerId, { type: 'squad', order: 'control', id: actor.id });
  const game = room.world.game(), engine = id => room.world.modules.find(m => m.actorId === id && m.kind === 'engine'),
    run = seconds => { for (let i = 0; i < seconds * 60; i++) room.step(); };
  game.call({ op: 'setPartState', owner: game.handle(engine(two.id)), state: { health: 17 } });
  game.call({ op: 'setPartState', owner: game.handle(engine(one.id)), state: { health: 30 } });
  run(11);
  for (const [player, actor] of [[a, one], [b, two]]) room.command(player.playerId, { type: 'cancel-repair', actorId: actor.id });
  const time = room.world.time, quote = room.command(a.playerId, { type: 'repair', actorId: one.id });
  assert.equal(room.world.time, time, 'a repair takes its time on the clock of the field, which nothing rewinds');
  run(quote.seconds + 1); assert(Math.abs(room.world.time - time - quote.seconds - 1) < 1e-6);
  assert.equal(engine(one.id).health, engine(one.id).maxHealth); assert.equal(engine(two.id).health, 17);
  room.command(a.playerId, { type: 'remove', actorId: one.id }); assert.equal(room.world.actors.length, 1); assert.equal(engine(two.id).health, 17);
});
test('reconnecting retains ownership; disconnection and stale input release movement and firing', t => {
  const room = rehearsal(), a = room.join('Alice'), published = room.publish(a.playerId, createStructuredTemplate('heavy')).actor;
  t.after(() => room.world.dispose());
  // An input leaves the scene to the step that follows it, and the throttle goes all the way in `THROTTLE_IN` seconds.
  const throttle = (steps = 1) => { for (let i = 0; i < steps; i++) room.step(); return room.world.actor(published.id).vehicle.throttle; },
    eased = Math.ceil(THROTTLE_IN / FIXED_DT) + 1, hold = () => room.command(a.playerId, { type: 'squad', order: 'control', id: published.id });
  hold(); room.command(a.playerId, { type: 'drive', throttle: 1 }); assert.equal(throttle(eased), 1);
  room.disconnect(a.playerId); assert.equal(throttle(), 0);
  const joined = room.join('Alice', a.token); assert.equal(joined.playerId, a.playerId); assert.equal(joined.actors[0].id, published.id);
  // Back, the player commands; taken in hand again, the construction drives.
  assert.deepEqual(room.command(a.playerId, { type: 'drive', throttle: 1 }), {}); assert.equal(throttle(), 0);
  hold(); room.command(a.playerId, { type: 'drive', throttle: 1 }); assert.equal(throttle(eased), 1);
  room.checkLeases(room.steps + 120); assert.equal(throttle(), 0);
});

test('the throttle in the hands of a player eases in and out as a foot does, and the brake is as asked', t => {
  const room = rehearsal(), a = room.join('Alice'), id = room.publish(a.playerId, createStructuredTemplate('heavy')).actor.id;
  t.after(() => room.world.dispose());
  const vehicle = room.world.actor(id).vehicle, run = steps => { for (let i = 0; i < steps; i++) room.step(); return vehicle.throttle; },
    drive = (throttle, brake = 0) => room.command(a.playerId, { type: 'drive', throttle, brake });
  room.command(a.playerId, { type: 'squad', order: 'control', id });
  drive(1); assert.equal(run(1), FIXED_DT / THROTTLE_IN);
  assert.ok(Math.abs(run(Math.round(THROTTLE_IN / FIXED_DT / 2) - 1) - .5) < 1e-9, 'half of it in half the time');
  assert.equal(run(Math.ceil(THROTTLE_IN / FIXED_DT)), 1);
  // Asked again, it goes on from where it is; let go, it comes up quicker; asked the other way, it comes up first.
  drive(1); assert.equal(run(1), 1);
  drive(0); assert.ok(Math.abs(run(1) - (1 - FIXED_DT / THROTTLE_OUT)) < 1e-9);
  drive(-1); assert.ok(run(Math.round(THROTTLE_OUT / FIXED_DT) - 1) >= 0, 'it comes up before it goes down the other way');
  assert.equal(run(Math.ceil((THROTTLE_IN + THROTTLE_OUT) / FIXED_DT)), -1);
  drive(-1, 1); assert.equal(run(1), -1); assert.equal(vehicle.brake, 1);
  assert.throws(() => drive(Number.NaN), /Acelerador inválido/);
  room.command(a.playerId, { type: 'release' }); assert.equal(run(1), 0);
});

test('network limits, placement and server weapon presets cannot be bypassed by a client', () => {
  const room = rehearsal(), a = room.join('Alice'), mine = room.publish(a.playerId, createStructuredTemplate('heavy')).actor, there = room.world.actor(mine.id).vehicle.x;
  room.command(a.playerId, { type: 'squad', order: 'control', id: mine.id });
  assert.throws(() => room.publish(a.playerId, createStructuredTemplate('heavy'), { x: there }), /instante|ocupada/);
  room.players.get(a.playerId).builtAt = -Infinity; assert.throws(() => room.publish(a.playerId, createStructuredTemplate('heavy'), { x: there }), /Não há espaço aí/);
  const overlap = createStructuredTemplate('heavy'), engine = overlap.components.find(m => m.kind === 'engine');
  overlap.components.push({ ...structuredClone(engine), id: 'duplicate-engine' });
  assert.throws(() => room.publish(a.playerId, overlap), { code: 'CONSTRUCTION_OVERLAP' });
  const gun = room.world.modules.find(m => m.actorId === mine.id && m.kind === 'weapon'), aim = { x: gun.x + 40, y: gun.y + .5 };
  room.command(a.playerId, { type: 'aim', aim, weapon: { id: 'cannon' } }); advance(room.world, 120);
  room.command(a.playerId, { type: 'fire', aim, weapon: { id: 'cannon', power: 999999, rate: 999999, speed: 999999 }, force: true });
  advance(room.world, 1); // an input leaves the scene to the step that follows it
  const shot = room.world.projectiles[0]; assert(shot.power <= 689 && shot.power > 680, 'the power of the catalogue round, less what a step of air took');
  assert(Math.hypot(shot.vx, shot.vy) < 1700, 'the speed of the catalogue round, not the one asked for');
  const result = room.command(a.playerId, { type: 'fire', aim, weapon: { id: 'machinegun' }, force: true }); assert.equal(result.accepted, false);
  // An input to a construction that is no longer there is dropped; asked for an answer, it gets one.
  assert.deepEqual(room.command(a.playerId, { type: 'drive', actorId: 'missing', throttle: 1 }), {});
  assert.throws(() => room.command(a.playerId, { type: 'drive', actorId: 'missing', throttle: 1, request: 1 }), /já não está no campo/);
});
test('a place in the base is refused only for what the faction has there: a construction of another standing in it tells nothing', t => {
  const room = rehearsal([0, 400]), alice = room.join('Alice'), bob = room.join('Bob'), ground = room.world.terrain; t.after(() => room.world.dispose());
  const publish = (player, options) => { room.players.get(player.playerId).builtAt = -Infinity;
    const actor = room.world.actor(room.publish(player.playerId, createStructuredTemplate('heavy'), options).actor.id); return { id: actor.id, x: actor.vehicle.x }; };
  // Bob's tank stands in the middle of Alice's base, and she has nothing there that sees it.
  const theirs = publish(bob).id, v = room.world.actor(theirs).vehicle;
  room.world.command('setVehicleState', { actorId: theirs, state: { x: 0, y: v.y - ground.height(v.x) + ground.height(0) + 1, vx: 0, vy: 0 } });
  for (let i = 0; i < 90; i++) room.step();
  room.look(); assert(Math.abs(room.world.actor(theirs).vehicle.x) < 2); assert.equal(room.knows(alice.faction.id, room.world.actor(theirs)), null);
  // The first place of her row is hers, and so is a place asked for there, as if the tank were not there: constructions pass through each other.
  assert.equal(publish(alice).x, 0); room.command(alice.playerId, { type: 'remove', actorId: room.players.get(alice.playerId).selected });
  assert.equal(publish(alice, { x: 0 }).x, 0);
  // What is hers is in the way.
  assert.throws(() => publish(alice, { x: 0 }), /Não há espaço aí/);
  assert.equal(publish(alice).x, -12, 'the next place of her row');
});
test('an invitation goes to whoever the faction is told of: any other is answered as a name nobody has', t => {
  const room = rehearsal([0, 400, 800]), [alice, bob, carol] = ['Alice', 'Bob', 'Carol'].map(name => room.join(name)); t.after(() => room.world.dispose());
  const invite = (playerId, cancel) => room.command(alice.playerId, { type: 'invite', playerId, cancel }), invited = () => [...room.factions.get(alice.faction.id).invited];
  // Carol left with nothing on the field, of a faction Alice never met: to Alice she is nobody, as a name nobody has, as Alice herself.
  room.disconnect(carol.playerId);
  for (const nobody of [carol.playerId, 'j99', 'f1', 'c1', 42, null, alice.playerId])
    for (const cancel of [false, true]) assert.throws(() => invite(nobody, cancel), /^Error: Jogador não encontrado\.$/, String(nobody));
  // Of a faction Alice has met she knows every member, there or away.
  room.factions.get(alice.faction.id).met.set(carol.faction.id, { since: 0, at: 0, x: 800, defeatedAt: null });
  assert.deepEqual(invite(carol.playerId), {}); assert.deepEqual(invited(), [carol.playerId]);
  // Bob is on the field: he is invited as the panel offers. Gone, he is nobody to her again, but an invitation she gave she can call off.
  assert.deepEqual(invite(bob.playerId), {}); room.disconnect(bob.playerId);
  assert.throws(() => invite(bob.playerId), /^Error: Jogador não encontrado\.$/);
  assert.deepEqual(invite(bob.playerId, true), {}); assert.deepEqual(invited(), [carol.playerId]);
  assert.throws(() => invite(bob.playerId, true), /^Error: Jogador não encontrado\.$/);
});
test('the shared field is the main world: a base for each faction, and shots and aims anywhere over it', t => {
  const room = rehearsal([-213, 237, -663]), ground = room.world.terrain, [alice, bob, carol] = ['Alice', 'Bob', 'Carol'].map(name => room.join(name));
  t.after(() => room.world.dispose());
  // A construction published, where it stands and which way it faces.
  const publish = (player, model, options) => { room.players.get(player.playerId).builtAt = -Infinity;
    const actor = room.world.actor(room.publish(player.playerId, createStructuredTemplate(model), options).actor.id);
    return { id: actor.id, x: actor.vehicle.x, facing: actor.facing }; };
  assert.deepEqual([ground.id, ground.seed, ground.length], [MAIN_WORLD.terrain, MAIN_WORLD.seed, MAIN_WORLD.mapLength]);
  assert.deepEqual(room.world.bounds, { minX: ground.minX - 72, maxX: ground.maxX + 72 });
  assert.deepEqual(room.world.snapshot().terrainSettings, { seed: ground.seed, length: ground.length, center: ground.center }, 'a frame names the world');
  // A base stands on the ground of its place and faces the middle of the world.
  assert.deepEqual([alice, bob, carol].map(p => p.base), [[-213, 1], [237, -1], [-663, 1]].map(([x, facing]) => ({ x, y: ground.height(x), facing, radius: 100 })));
  assert.deepEqual(room.limits, { minX: ground.minX + 20, maxX: ground.maxX - 20 });
  // A page is welcomed with what it reads of its seat: whose it is, its base, its faction and the designs of what it has
  // on the field, each what the workshop opens of it.
  assert.deepEqual(Object.keys(alice), ['playerId', 'token', 'name', 'selected', 'base', 'faction', 'chat', 'actors']);
  const first = publish(alice, 'heavy'), second = publish(alice, 'ifv'), theirs = publish(bob, 'heavy');
  assert.deepEqual(Object.keys(room.design(room.world.actor(first.id))), ['id', 'blueprint']);
  assert.deepEqual([first.x, first.facing, second.x, second.facing], [alice.base.x, 1, alice.base.x - 12, 1], 'a row around the base');
  assert.deepEqual([theirs.x, theirs.facing], [bob.base.x, -1]);
  assert(Math.abs(room.world.actor(first.id).vehicle.y - ground.height(first.x)) < 3, 'a construction stands on the ground of its place');
  assert(Math.abs(room.world.actor(first.id).aim.y - ground.height(first.x) - 2.42) < 1e-9, 'and looks ahead, not at the bottom of the world');
  // A place asked for is a place inside the base.
  assert.equal(publish(carol, 'heavy', { x: carol.base.x + 60, facing: -1 }).x, carol.base.x + 60);
  for (const x of [carol.base.x + 101, carol.base.x - 101, 20000]) assert.throws(() => publish(carol, 'heavy', { x }), /dentro da base/);
  for (const x of [ground.maxX, ground.minX, 260000, NaN]) assert.throws(() => publish(carol, 'heavy', { x }), /Posição no campo inválida/);
  // An aim is refused only outside the field: beyond its ends, or further than AIM_SKY above or below it. The sky is open
  // far above it and the ground far under it.
  const gun = room.world.modules.find(m => m.actorId === first.id && m.kind === 'weapon'), aim = { x: gun.x + 400, y: ground.height(gun.x + 400) + 2 },
    send = (type, point) => room.command(alice.playerId, { type, actorId: first.id, aim: point, weapon: { id: 'cannon' }, force: true });
  room.command(alice.playerId, { type: 'select', actorId: first.id });
  for (const outside of [{ x: ground.maxX + 1, y: aim.y }, { x: aim.x, y: -AIM_SKY - 1 }, { x: aim.x, y: AIM_SKY + 1 }, { x: NaN, y: aim.y }])
    assert.throws(() => send('aim', outside), /Mira fora do campo/);
  const sky = { x: aim.x, y: aim.y + 4000 };
  send('aim', sky); advance(room.world, 1);
  assert.deepEqual(room.world.actor(first.id).aim, sky, 'an aim far up in the sky is kept where it was put: the barrel is raised at it, not below it');
  const deep = { x: aim.x, y: ground.minHeight - 40 };
  send('aim', deep); advance(room.world, 1);
  assert.deepEqual(room.world.actor(first.id).aim, deep, 'and one under the lowest ground: the barrel is lowered at it, not above it');
  // A round is no longer lost 200 m from the middle.
  send('aim', aim); advance(room.world, 120); assert.equal(send('fire', aim).accepted, true);
  let reach = 0; for (let i = 0; i < 90; i++) { room.step(); for (const shot of room.world.projectiles) reach = Math.max(reach, shot.x - gun.x); }
  assert(reach > 350, 'the round flew ' + reach + ' m');
  // What a player who left put on the field stays there however long, and the faction and its base with it.
  room.disconnect(bob.playerId); room.checkLeases(room.steps + 24 * 216_000);
  assert(room.world.actor(theirs.id)); assert.equal(room.factions.size, 3);
  assert.deepEqual(room.owned(bob.playerId).map(a => a.id), [theirs.id]);
  assert.deepEqual(room.roster().find(p => p.id === bob.playerId), { id: bob.playerId, connected: false }, 'a page says his constructions stand there without him');
  assert.deepEqual(room.join('Bob', bob.token).base, bob.base, 'a player who returns finds the base and what stood there');
  // A faction lasts while it has members: with nobody of it on the field and nothing of it standing, however long, it
  // is there with its base, its stocks and the objectives of its players, as it was.
  room.disconnect(bob.playerId); room.wreck(room.world.actor(theirs.id));
  const stock = { ...room.factions.get(bob.faction.id).stock };
  for (let i = 0; i < 60; i++) room.step();
  room.checkLeases(room.steps + 30 * 24 * 216_000);
  assert.equal(room.factions.size, 3);
  assert.deepEqual([room.players.get(bob.playerId).factionId, room.factions.get(bob.faction.id).stock], [bob.faction.id, stock]);
  assert.equal(room.players.get(bob.playerId).objectives.fabricateVehicle, true);
  const returned = room.join('Bob', bob.token);
  assert.deepEqual([returned.playerId, returned.faction.id, returned.base], [bob.playerId, bob.faction.id, bob.base], 'a player who comes back finds the faction');
  assert.deepEqual(returned.actors, [], 'and is given nothing for coming back');
  assert.deepEqual(room.join('Alice', alice.token).base, alice.base, 'a player who stayed keeps the base');
});
test('a seat is kept by its key: whoever comes with it, from any page, sits in it, and a key no seat keeps is refused', t => {
  const room = rehearsal([-213, 237, -663]), first = room.join('Alice'), other = room.join('Bia'); t.after(() => room.world.dispose());
  // A key is twenty-four letters and figures of those not mistaken for one another, told in groups of four; written in
  // small letters, with an O for a zero or an I or an L for a one, with spaces or none, it is the same key.
  assert.match(first.token, /^[0-9A-HJKMNP-TV-Z]{24}$/); assert.notEqual(first.token, other.token);
  assert.match(keyText(first.token), /^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);
  assert.equal(keyOf(` ${keyText(first.token).toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')} `), first.token);
  // Another page with the same key — another device, another tab — takes the seat, faction and all: the same player.
  // A page that says no name keeps the one the seat has.
  const second = room.join(null, keyText(first.token).toLowerCase());
  assert.deepEqual([second.playerId, second.token, second.name, second.faction.id, second.base], [first.playerId, first.token, 'Alice', first.faction.id, first.base]);
  assert.deepEqual([room.players.size, room.factions.size, room.players.get(first.playerId).connected], [2, 2, true]);
  assert.equal(room.join('Ana', first.token).name, 'Ana', 'one that says another renames it');
  // A key no seat keeps is refused — a key mistyped, one changed since, one of another field —, before anything on the
  // field changes; and so is one that is not a key.
  const was = () => [room.players.size, room.factions.size, { ...room.serials }, room.digest()], before = was();
  for (const wrong of ['ABCD-EFGH-JKMN', first.token.slice(1), 'chave'])
    assert.throws(() => room.join('Ana', wrong), error => error.unknownKey === true && error.message === 'Chave de acesso não encontrada neste campo: confira as letras e os números.');
  assert.deepEqual(was(), before);
  // A player changes the key of their seat: told the new one, and nobody else is. The one before is refused from then on.
  const old = first.token, changed = room.command(first.playerId, { type: 'rekey' });
  assert.deepEqual(Object.keys(changed), ['token']); assert.match(changed.token, /^[0-9A-HJKMNP-TV-Z]{24}$/); assert.notEqual(changed.token, old);
  assert.throws(() => room.join('Ana', old), error => error.unknownKey === true);
  assert.equal(room.join('Ana', changed.token).playerId, first.playerId);
  // Nothing anybody is told of the field says the key of a seat, theirs or another's.
  const told = JSON.stringify([room.factionView(other.playerId), room.factionView(first.playerId), room.roster(), room.join('Bia', other.token).faction]);
  for (const key of [changed.token, other.token, old]) assert(!told.includes(key));
});
test('an address has two players connected at a time: a third is refused, and whoever left does not count, whatever stands of theirs', t => {
  const room = rehearsal(), home = '203.0.113.7', away = '198.51.100.2', first = room.join('Alice', '', home); t.after(() => room.world.dispose());
  assert.equal(ROOM_LIMITS.perAddress, 2);
  // A second page from there is a second player, with a seat of its own. A third is refused, new or with the key of a
  // seat nobody sits in.
  const second = room.join('Bia', '', home), third = room.join('Caio', '', away);
  room.disconnect(third.playerId);
  assert.notEqual(second.playerId, first.playerId); assert.equal(room.players.size, 3);
  assert.throws(() => room.join('Caio', third.token, home), /^Error: Só 2 jogadores conectados ao mesmo tempo por conexão: a sua já tem 2\.$/);
  assert.throws(() => room.join('Bob', '', home), /Só 2 jogadores conectados ao mesmo tempo/); assert.equal(room.players.size, 3);
  // A page that comes with the key of a seat sitting there takes it from the other page: it is no third player.
  assert.equal(room.join('Alice', first.token, home).playerId, first.playerId);
  room.join('Bob', '', away); room.join('Bea', '', away); assert.equal(room.players.size, 5);
  // Gone with something standing, the two no longer count: a third page of the address comes in, and her seat is hers
  // again from there; with the two of them connected, the other seat waits.
  for (const player of [first, second]) { room.publish(player.playerId, createStructuredTemplate('heavy')); room.disconnect(player.playerId); }
  assert(room.owned(first.playerId).length && room.owned(second.playerId).length);
  room.join('Carol', '', home); assert.equal(room.players.size, 6);
  assert.equal(room.join('Alice', first.token, home).playerId, first.playerId);
  assert.throws(() => room.join('Bia', second.token, home), /Só 2 jogadores conectados ao mesmo tempo/);
  // Her seat is hers from wherever she comes back, but not from where Bob and Bea are connected.
  room.disconnect(first.playerId);
  assert.throws(() => room.join('Alice', first.token, away), /Só 2 jogadores conectados ao mesmo tempo/);
  assert.equal(room.join('Alice', first.token, '192.0.2.9').playerId, first.playerId); assert.equal(room.players.get(first.playerId).address, '192.0.2.9');
  assert.equal(room.join('Bia', second.token, home).playerId, second.playerId);
  // Whoever the server does not count comes as often as it likes.
  room.join('Dan'); room.join('Erin'); room.join('Frank'); assert.equal(room.players.size, 9);
});
test('an address is given three new seats in a day of the field: coming back by key is no new seat, and the day goes by in steps', t => {
  // A day of the field, sixty steps to a second.
  const room = rehearsal(), home = '203.0.113.7', away = '198.51.100.2', day = 24 * 60 * 60 * 60, seats = []; t.after(() => room.world.dispose());
  assert.equal(ROOM_LIMITS.newPerAddressPerDay, 3);
  for (const [name, at] of [['Alice', 0], ['Bia', 1000], ['Carla', 2000]]) {
    room.steps = at; const seat = room.join(name, '', home); seats.push(seat); room.disconnect(seat.playerId);
  }
  // With nobody of it connected, a fourth new seat is refused all the same, before anything on the field changes.
  room.join('Alice', seats[0].token, home);
  const was = () => [room.players.size, room.factions.size, { ...room.serials }, room.digest()], before = was();
  assert.throws(() => room.join('Dora', '', home),
    /^Error: Só 3 facções novas por conexão a cada 24 horas: a sua já fundou 3\. Volte mais tarde, ou entre com a que você já tem\.$/);
  assert.deepEqual(was(), before);
  // Coming back to a seat by its key is no new seat, however often, whether another page sits in it or not.
  assert.equal(room.join('Alice', seats[0].token, home).playerId, seats[0].playerId);
  for (let i = 0; i < 4; i++) for (const seat of seats.slice(1)) { assert.equal(room.join(null, seat.token, home).playerId, seat.playerId); room.disconnect(seat.playerId); }
  // Another address is counted by itself, and whoever the server does not count comes as often as it likes.
  for (const name of ['Eva', 'Fia', 'Gil']) room.disconnect(room.join(name, '', away).playerId);
  assert.throws(() => room.join('Hugo', '', away), /Só 3 facções novas/);
  for (let i = 0; i < 5; i++) room.disconnect(room.join('Local ' + i).playerId);
  // A seat given a day ago no longer counts: one new seat a day after the first, and another a day after the second.
  room.steps = day - 1; assert.throws(() => room.join('Dora', '', home), /Só 3 facções novas/);
  room.steps = day; room.disconnect(room.join('Dora', '', home).playerId);
  assert.throws(() => room.join('Edu', '', home), /Só 3 facções novas/);
  room.steps = day + 1000; room.join('Edu', '', home);
  assert.equal(room.players.size, 3 + 3 + 5 + 2);
});
test('the field has room for thirty-two players and no limit of its own to what their factions field', () => {
  assert.deepEqual(ROOM_LIMITS, { players: 32, perAddress: 2, newPerAddressPerDay: 3, perFaction: CONSTRUCTION_LIMITS, library: 100 });
  assert.equal(ROOM_LIMITS.perFaction, CONSTRUCTION_LIMITS);
  assert.deepEqual(PART_LIMITS, { plates: 32, components: 16 });
  const room = rehearsal(); try {
    const seats = Array.from({ length: 32 }, (_, i) => room.join('Jogador ' + i));
    assert.throws(() => room.join('Mais um'), /já tem 32 jogadores conectados/);
    // A seat that is left is free for another, and its own player finds the field full while that one is there.
    room.disconnect(seats[0].playerId); const late = room.join('Mais um');
    assert.throws(() => room.join('Jogador 0', seats[0].token), /já tem 32 jogadores conectados/);
    room.disconnect(late.playerId); assert.equal(room.join('Jogador 0', seats[0].token).playerId, seats[0].playerId);
  } finally { room.world.dispose(); }
  // Each of the thirty-two can found a base, and the world has room for them.
  const field = new SharedRoom(); try {
    for (let i = 0; i < 32; i++) field.join('Jogador ' + i);
    const bases = [...field.factions.values()].map(faction => faction.base.x).sort((a, b) => a - b), { minX, maxX } = field.world.terrain;
    assert.equal(bases.length, 32); assert(bases[0] > minX + 8000 && bases.at(-1) < maxX - 8000);
    for (let i = 1; i < 32; i++) assert(bases[i] - bases[i - 1] >= 10000 && bases[i] - bases[i - 1] <= 30000, `${bases[i - 1]} and ${bases[i]}`);
  } finally { field.world.dispose(); }
});
test('frames that tell only what changed bring the state a whole frame would have brought', () => {
  const w = two(); w.game();
  const gear = w.modules.find(m => m.kind === 'track'); gear.wheelAngularSpeed = -0;
  const packet = { type: 'frame', state: w.snapshot(), events: [], profile: {} }, writer = new FrameWriter(), reader = new FrameReader(), late = new FrameReader(),
    whole = sent => new FrameReader().decode(new FrameWriter().encode(sent, true)).state;
  assert(Object.is(gear.wheelAngularSpeed, -0), 'snapshot projection does not change the live module');
  assert.equal(Object.is(packet.state.modules.find(m => m.id === gear.id).wheelAngularSpeed, -0), false,
    'the snapshot uses the same canonical zero as JSON metadata');
  const full = reader.decode(writer.encode(packet, true)); assert.deepEqual(full.state, whole(packet));
  assert.deepEqual(regionGeometry(full.state.plates[0]), regionGeometry(packet.state.plates[0])); assert.equal(full.base, null);
  w.controlVehicle(1, 0, 'a');
  advance(w, 2); const next = { ...packet, state: w.snapshot() }, compact = writer.encode(next), decoded = reader.decode(compact);
  assert.deepEqual(decoded.state, whole(next), 'put together, it is the state itself');
  assert.equal(decoded.base, full.serial); assert.equal(decoded.state.plates[0].ballisticGrid, full.state.plates[0].ballisticGrid, 'what did not change is what the reader had');
  assert.equal(late.decode(compact), null, 'a reader that never had the frame before asks for a whole one');
  assert(compact.byteLength < new FrameWriter().encode(next, true).byteLength / 3, 'the design of a construction is told once');
  assert.throws(() => decodeFrame(new ArrayBuffer(4)));
  // A round goes through the other vehicle and flies on until it leaves the field, the vehicle brakes:
  // every frame on the way is the state itself. The hull sits back on its springs as it pulls away,
  // so the gun is kept laid until the round leaves.
  const gun = weaponSettings('cannon', { preset: 'rh120', platform: 'vehicle', spread: 0 }), muzzle = w.modules.find(m => m.actorId === 'a' && m.kind === 'weapon');
  let flying = 0, heard = 0;
  for (let i = 0; i < 40; i++) {
    if (i < 3) w.aimWeapon({ x: 6, y: muzzle.y }, gun, 'a');
    if (i === 3) assert(w.fire({ x: 6, y: muzzle.y }, gun, false, 'a'));
    if (i === 20) w.controlVehicle(0, 1, 'a');
    advance(w, 3);
    const sent = { ...packet, state: w.snapshot(), events: w.drainEvents() }, got = reader.decode(writer.encode(sent));
    assert.deepEqual(got.state, whole(sent)); assert.equal(got.events.length, sent.events.length);
    flying = Math.max(flying, shotCount(got.state.shots)); heard += got.events.length;
  }
  assert(flying > 0 && reader.state.shots.kinds.length > 0 && w.stats.shots === 1 && heard > 3, 'the round was told on its way');
  assert(w.modules.some(m => m.actorId === 'b' && m.health < m.maxHealth), 'and so was the damage it did');
  const initial = permanentParts(w);
  w.command('setPartState', { owner: w.game().handle(w.modules.find(m => m.kind === 'weapon')), state: { health: 0 } });
  const damaged = { ...packet, state: w.snapshot() }, decodedDamage = reader.decode(writer.encode(damaged));
  assert.deepEqual(decodedDamage.state, whole(damaged));
  assert(partsPreserved(w, initial));
  assert.equal(Object.hasOwn(decodedDamage.state, 'fragments'), false);
  // A place is told to a tenth of a millimetre, a turn of a wheel to a ten-thousandth of a radian; the rest as it is.
  const near = (a, b) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) <= 5e-5);
  const points = contours => contours.flatMap(contour => contour.flatMap(p => [p.x, p.y]));
  assert(decodedDamage.state.actors.every((a, i) => near(points(a.contactContours), points(damaged.state.actors[i].contactContours))));
  assert.deepEqual(decodedDamage.state.plates.map(p => [p.physicalMass, p.physicalInertia]), damaged.state.plates.map(p => [p.physicalMass, p.physicalInertia]));
  assert(near(decodedDamage.state.modules.map(m => m.wheelSpin ?? 0), damaged.state.modules.map(m => m.wheelSpin ?? 0)));
  assert.deepEqual(decodedDamage.state.modules.map(m => m.wheelAngularSpeed), damaged.state.modules.map(m => m.wheelAngularSpeed));
});

test('a vehicle on the move is told where it went, and of the plates, pieces and eyes that sit on it nothing', () => {
  const w = two(), publication = new Publication(), writer = new FrameWriter(), reader = new FrameReader(),
    header = buffer => JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, new DataView(buffer).getUint32(4, true)))),
    driven = state => state.actors.find(actor => actor.id === 'a').vehicle, near = (a, b, by, what) => assert(Math.abs(a - b) < by, `${what}: ${a - b}`);
  let sent = publication.state(w.snapshot()); reader.decode(writer.encode({ state: sent }, true));
  const start = driven(sent).x;
  let contacts = 0;
  w.controlVehicle(1, 0, 'a');
  for (let turn = 0; turn < 30; turn++) {
    advance(w, 3); const exact = w.snapshot(); sent = publication.state(exact);
    const buffer = writer.encode({ state: sent }), told = header(buffer).state, got = reader.decode(buffer).state;
    // Of its plates and its eyes nothing; of its pieces, where its running gear is, and where it touches the ground
    // only when that went a centimetre along the gear.
    assert.equal(told.plates, undefined, `turn ${turn}`);
    for (const words of told.actors?.with ?? []) assert(!('eyes' in words), `turn ${turn}: eyes`);
    (told.modules?.at ?? []).forEach((index, k) => {
      if (sent.modules[index].kind !== 'track') for (const key of ['x', 'y', 'angle']) assert(!(key in told.modules.with[k]), `turn ${turn}: ${sent.modules[index].kind} ${key}`);
      if ('groundContact' in told.modules.with[k]) contacts++;
    });
    // The page has every part where the field published it, to the tenth of a millimetre; and the field publishes where a
    // gear touches the ground to a centimetre.
    for (const name of ['plates', 'modules']) sent[name].forEach((part, index) => {
      const at = name === 'plates' ? part.definition : part, shown = name === 'plates' ? got[name][index].definition : got[name][index], what = `turn ${turn}, ${part.id}`;
      near(shown.x, at.x, 2e-4, what); near(shown.y, at.y, 2e-4, what); near(shown.angle, at.angle, 2e-5, what);
      if (part.groundContact) { near(shown.groundContact.x, part.groundContact.x, 2e-4, what + ' ground'); near(part.groundContact.x, exact[name][index].groundContact.x, .015, what + ' ground'); }
    });
    sent.actors.forEach((actor, index) => actor.eyes.forEach((eye, k) => { const shown = got.actors[index].eyes[k];
      near(shown.x, eye.x, 2e-4, `turn ${turn}, eye`); near(shown.y, eye.y, 2e-4, `turn ${turn}, eye`); assert.equal(shown.left, eye.left); }));
  }
  assert(driven(sent).x - start > 1, `it went ${driven(sent).x - start} m`);
  assert(contacts < 15, `where the gear touches the ground was told ${contacts} times in 30 frames`);
});

test('frames tell the eyes of every construction: where each looks from and how far to either side, and only ahead once the camera on its roof is gone', t => {
  // Both settle on their springs first: the one that stays is to stand still.
  const w = two(); t.after(() => w.dispose()); w.game(); advance(w, 120);
  const cameraRange = SENSOR_MODES.visual.range, packet = { type: 'frame', events: [], profile: {} }, writer = new FrameWriter(), reader = new FrameReader(),
    camera = id => w.modules.find(m => m.actorId === id && m.kind === 'sensor' && m.sensorMode === 'visual'),
    reach = eyes => eyes.map(eye => [eye.left, eye.right]).sort((p, q) => p[0] - q[0] || p[1] - q[1]),
    told = whole => { const state = w.snapshot(), got = reader.decode(writer.encode({ ...packet, state }, whole)).state;
      assert.deepEqual(got.actors.map(a => a.eyes), new FrameReader().decode(new FrameWriter().encode({ state }, true)).state.actors.map(a => a.eyes));
      return Object.fromEntries(got.actors.map(a => [a.id, a.eyes])); },
    // The eye of a tank is the camera on its turret, which sees over the hull to both sides as far as a camera sees; the
    // command post looks out of its vision block, ahead at its own shorter range.
    stands = (eyes, id) => { const lens = camera(id), seeing = eyes.filter(eye => Math.hypot(eye.x - lens.x, eye.y - lens.y) < 3e-4), [eye] = seeing;
      assert.equal(seeing.length, 1, id + ' looks from its camera'); assert.deepEqual([eye.left, eye.right], [cameraRange, cameraRange], id); assert.equal(eyes.length, 2, id); return eye; };
  const first = told(true), at = stands(first.a, 'a'); stands(first.b, 'b');
  // One of them drives off: the frames that tell only what changed bring its eye along, and leave the other's where it was.
  w.controlVehicle(1, 0, 'a'); advance(w, 60);
  const moved = told(false);
  assert(Math.abs(stands(moved.a, 'a').x - at.x) > .5, 'the eye went with the tank'); assert.deepEqual(moved.b, first.b);
  // Its camera on the roof shot away, the other only looks ahead to its left on the field, through the Command visor.
  w.command('setPartState', { owner: w.game().handle(camera('b')), state: { health: 0 } }); advance(w, 1);
  const blind = told(false);
  assert.deepEqual(reach(blind.b), [[650, 0]]); assert.deepEqual(reach(first.a).filter(([left]) => left === 0), [[0, 650]]); stands(blind.a, 'a');
  // And a construction out of action has no eyes at all, whatever it has left to look with.
  for (const id of ['a', 'b']) w.command('setPartState', { owner: w.game().handle(w.modules.find(m => m.actorId === id && m.kind === 'command')), state: { health: 0 } });
  advance(w, 1);
  assert.deepEqual(told(false), { a: [], b: [] });
});

test('an edit that keeps the count of material regions is told, and a reader that missed a frame asks for a whole state', () => {
  const whole = sent => new FrameReader().decode(new FrameWriter().encode(sent, true)).state;
  const geometry = (id, revision, maxX) => ({ id, revision,
    definition: { x: 12, y: 1, angle: 0, length: 2, thicknessMm: 100 },
    solidRegions: [{ minX: -1, maxX, minY: -.05, maxY: .05 }] }),
    initial = { state: { plates: [geometry('plate', 1, 1), geometry('second-plate', 1, 1)] } },
    writer = new FrameWriter(), reader = new FrameReader(), slow = new FrameReader(), first = writer.encode(initial, true);
  assert(reader.decode(first)); assert(slow.decode(first));
  const edited = { state: { plates: [geometry('plate', 2, .8), geometry('second-plate', 2, .7)] } },
    changed = writer.encode(edited), decoded = reader.decode(changed);
  assert.deepEqual(decoded.state.plates.map(p => p.solidRegions), edited.state.plates.map(p => p.solidRegions));
  assert.equal(Object.hasOwn(decoded.state, 'fragments'), false);
  assert.deepEqual(decoded.state.plates[1].definition, edited.state.plates[1].definition, 'kept from the frame before');
  const next = writer.encode(edited);
  assert(next.byteLength < changed.byteLength, 'told once');
  const retained = reader.decode(next).state, retainedText = JSON.stringify(retained);
  assert.deepEqual(retained, whole(edited));
  assert.equal(slow.decode(next), null, 'a frame is never put on a state older than the one it builds on');
  const deepened = { state: { plates: [geometry('plate', 3, .6), geometry('second-plate', 2, .7)] } };
  assert.deepEqual(reader.decode(writer.encode(deepened)).state, whole(deepened));
  assert.equal(JSON.stringify(retained), retainedText, 'a later edit leaves the earlier quiet frame intact');
  const again = writer.encode(deepened, true);
  assert.deepEqual(slow.decode(again).state, whole(deepened), 'a whole state recovers');
  assert(reader.decode(again));
  // A plate that took another's place in the list is another plate, told whole.
  const swapped = { state: { plates: [geometry('third-plate', 1, 1)] } };
  const other = writer.encode(swapped);
  for (const peer of [reader, slow]) assert.deepEqual(peer.decode(other).state, whole(swapped));
  assert.equal(JSON.stringify(retained), retainedText, 'removal and full resync leave retained history intact');
});
test('publishing a new construction cannot silently replace the selected one', () => {
  const room = rehearsal(), a = room.join('Alice'), first = room.command(a.playerId, { type: 'spawn', blueprint: createStructuredTemplate('heavy') }).actor;
  room.players.get(a.playerId).builtAt = -Infinity;
  const second = room.command(a.playerId, { type: 'spawn', actorId: first.id, blueprint: createStructuredTemplate('scout') }).actor;
  assert.notEqual(first.id, second.id); assert.equal(room.owned(a.playerId).length, 2); assert.equal(room.world.actor(first.id).blueprint.name, createStructuredTemplate('heavy').name);
  assert.equal(room.world.actor(second.id).blueprint.name, createStructuredTemplate('scout').name);
});
test('a construction made another stands where it stood, whatever the page asks, and faces as the workshop sends it or as it faced', t => {
  const room = rehearsal([0]), a = room.join('Alice'); t.after(() => room.world.dispose());
  // It was put facing away from where the base faces: the workshop may turn it as it makes it another, the base does not.
  const faces = -room.base(room.players.get(a.playerId)).facing,
    id = room.command(a.playerId, { type: 'spawn', x: -40, facing: faces, blueprint: createStructuredTemplate('scout') }).actor.id;
  for (let i = 0; i < 60; i++) room.step();
  const old = room.world.actor(id), stood = old.vehicle.x;
  room.command(a.playerId, { type: 'replace', actorId: id, x: 60, facing: -faces, blueprint: createStructuredTemplate('scout') });
  const made = room.world.actor(id);
  assert.equal(made.revision, old.revision + 1); assert.equal(made.facing, -faces);
  assert(Math.abs(made.vehicle.x - stood) < 0.5, `it stands at ${made.vehicle.x}, not ${stood}`);
  for (let i = 0; i < 60; i++) room.step();
  room.command(a.playerId, { type: 'replace', actorId: id, blueprint: createStructuredTemplate('scout') });
  assert.equal(room.world.actor(id).facing, -faces, 'asked no way, it faces as it faced');
});
test('a server that counts players by address lets two of each in at a time, and three new ones of each a day', { timeout: 25000 }, async t => {
  const { socket, url } = await serveNetwork(t, { rehearsal: { bases: [0] }, perAddress: true,
    trust: proxyTrust('127.0.0.1', 'cf-connecting-ip') }), home = '203.0.113.7';
  // Each comes through a proxy on the machine of the server, which says whom it comes for; the last comes by itself, from that machine.
  const connect = async (name, address, token) => {
    const ws = socket(url, address ? { headers: { 'CF-Connecting-IP': address } } : {}), messages = [];
    ws.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw)); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token }));
    for (const start = Date.now(); !messages.some(m => m.type === 'welcome' || m.error);) { if (Date.now() - start > 8000) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); }
    return { ...messages.find(m => m.type === 'welcome' || m.error), ws };
  };
  const leave = async ({ ws }) => { if (ws.readyState !== WebSocket.CLOSED) { ws.close(); await once(ws, 'close'); } };
  const alice = await connect('Alice', home), ana = await connect('Ana', home), other = await connect('Outra', home);
  assert.equal(alice.type, 'welcome'); assert.equal(ana.type, 'welcome');
  assert.match(other.error, /Só 2 jogadores conectados ao mesmo tempo por conexão/);
  // Whoever leaves makes room for another page: a third new player of the address, but no fourth that day. Ana's page
  // comes back to her seat.
  await leave(other); await leave(ana);
  const clara = await connect('Clara', home); assert.equal(clara.type, 'welcome'); await leave(clara);
  assert.match((await connect('Dora', home)).error, /Só 3 facções novas por conexão/);
  assert.equal((await connect('Ana', home, ana.token)).playerId, ana.playerId);
  assert.equal((await connect('Bob', '198.51.100.2')).type, 'welcome');
  for (const name of ['Local', 'Local de novo']) assert.equal((await connect(name)).type, 'welcome');
  assert.match((await connect('Local outra vez')).error, /Só 2 jogadores/);
});
test('an address holds four sockets at most and a socket that says nothing is let go in seconds', { timeout: 30000 }, async t => {
  const { socket, url } = await serveNetwork(t, { rehearsal: { bases: [0] }, perAddress: true,
    trust: proxyTrust('127.0.0.1', 'cf-connecting-ip') });
  // Each comes through a proxy on the machine of the server, which says whom it comes for; or by itself, from that machine.
  const open = address => new Promise(resolve => {
    const ws = socket(url, address ? { headers: { 'CF-Connecting-IP': address } } : {});
    ws.gone = new Promise(gone => ws.once('close', gone));
    ws.once('open', () => resolve(ws)); ws.once('error', () => resolve(null));
  });
  const closed = ws => ws.gone, home = [];
  for (let i = 0; i < 4; i++) home.push(await open('203.0.113.7'));
  assert(home.every(Boolean), 'four from one address');
  assert.equal(await open('203.0.113.7'), null, 'and no fifth');
  const away = await open('198.51.100.2'), local = await Promise.all([open(), open(), open(), open()]);
  assert(away && local.every(Boolean), 'other addresses have their own slots');
  assert.equal(await open(), null, 'the socket IP also has four slots');
  // Saying nothing, each is let go after five seconds, and the address has its room again.
  const started = Date.now(), codes = await Promise.all(home.map(closed));
  assert.deepEqual(codes, [1008, 1008, 1008, 1008]); assert(Date.now() - started < 7000, `let go after ${Date.now() - started} ms`);
  assert(await open('203.0.113.7'), 'room again');
});
test('two real WebSocket clients see the same world and ownership survives reconnection', { timeout: 25000 }, async t => {
  const { socket, url, close } = await serveNetwork(t, { rehearsal: { bases: [0] } });
  const connect = async (name, token) => {
    const ws = socket(), messages = [], frames = [], reader = new FrameReader();
    ws.on('message', (raw, binary) => { if (binary) { const packet = reader.decode(raw); if (packet) frames.push(packet); else ws.send(JSON.stringify({ type: 'resync' })); } else messages.push(JSON.parse(raw)); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token }));
    const until = async (fn, timeout = 4000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
    await until(() => messages.some(m => m.type === 'welcome')); return { ws, messages, frames, until, welcome: messages.find(m => m.type === 'welcome') };
  };
  try {
    // A WebSocket asked of any other path is refused at once. A browser makes one handshake with a server at a
    // time: left open, the one Vite's client asks for would keep the field waiting behind it.
    const stray = socket(url.replace('/world', '/?token=x'), 'vite-hmr');
    assert.match(await Promise.race([once(stray, 'error').then(([error]) => error.message),
      new Promise(resolve => setTimeout(() => resolve('left open'), 2000))]), /404/);
    const a = await connect('Alice'), b = await connect('Bob');
    // The old automatic positions put Bob behind Alice's bounded front mount.
    // Authored sectors do not permit the former unrestricted 180-degree turn.
    a.ws.send(JSON.stringify({ type: 'spawn', request: 1, x: -8, facing: 1, blueprint: createStructuredTemplate('heavy') }));
    b.ws.send(JSON.stringify({ type: 'spawn', request: 2, x: 8, facing: -1, blueprint: createStructuredTemplate('heavy') }));
    await a.until(() => a.messages.find(m => m.request === 1)?.actor && a.frames.at(-1)?.state.actors.length === 2);
    await b.until(() => b.frames.at(-1)?.state.actors.length === 2);
    const mine = a.messages.find(m => m.request === 1).actor.id, theirs = b.messages.find(m => m.request === 2).actor.id;
    // Publishing puts nobody at the controls: each player takes its construction in hand.
    a.ws.send(JSON.stringify({ type: 'squad', order: 'control', id: mine, request: 10 })); b.ws.send(JSON.stringify({ type: 'squad', order: 'control', id: theirs, request: 11 }));
    await a.until(() => a.messages.some(m => m.request === 10)); await b.until(() => b.messages.some(m => m.request === 11));
    assert.deepEqual(a.frames.at(-1).state.actors.map(v => v.id), b.frames.at(-1).state.actors.map(v => v.id));
    a.ws.send(JSON.stringify({ type: 'remove', actorId: theirs, request: 3 })); await a.until(() => a.messages.some(m => m.request === 3)); assert.match(a.messages.find(m => m.request === 3).error, /de outra facção/);
    // This tests one queued click, not leading a vehicle that still settles on
    // its suspension while the cannon turns. Both stand at rest, held by their
    // own brakes, before the replicated target point is taken.
    const still = client => client.frames.at(-1)?.state.actors.length === 2 &&
      client.frames.at(-1).state.actors.every(actor => Math.hypot(actor.vehicle.vx, actor.vehicle.vy) < .02);
    await a.until(() => still(a), 8000); await b.until(() => still(b), 8000);
    const carriers = a.frames.at(-1).state.actors.map(actor => ({ id: actor.id,
      x: actor.vehicle.x, y: actor.vehicle.y, angle: actor.vehicle.angle }));
    const target = b.frames.at(-1).state.modules.find(m => m.actorId === theirs && m.kind === 'weapon');
    const requestedTarget = { x: target.x, y: target.y };
    // A page tells how the gun is laid with the aim; the shot after it says nothing of that, and the gun is fired as it was laid.
    a.ws.send(JSON.stringify({ type: 'aim', actorId: mine, aim: { x: target.x, y: target.y }, weapon: { id: 'cannon' } }));
    a.ws.send(JSON.stringify({ type: 'fire', actorId: mine, request: 4, aim: { x: target.x, y: target.y }, queue: true }));
    const damaged = client => client.frames.at(-1)?.state.modules.some(m => m.actorId === theirs && m.kind === 'weapon' && m.health < m.maxHealth);
    // A single click survives idle-input expiry while the physical cannon turns.
    try {
      await a.until(() => a.messages.some(message => message.request === 4));
      const reply = a.messages.find(message => message.request === 4);
      assert.equal(reply.error, undefined);
      assert.equal(typeof reply.accepted, 'boolean',
        'false means the valid single click is queued while the physical cannon turns');
      await a.until(() => damaged(a), 12000); await b.until(() => damaged(b));
    } catch (error) {
      const sample = frame => ({ time: frame.state.time, modules: frame.state.modules
        .filter(module => module.kind === 'weapon').map(module => ({ id: module.id, actor: module.actorId,
          x: module.x, y: module.y, health: module.health, maxHealth: module.maxHealth,
          barrelAngle: module.barrelAngle, barrelDisabled: module.barrelDisabled })),
        events: frame.events?.map(event => ({ type: event.type, id: event.id, actorId: event.actorId,
          x: event.x, y: event.y, time: event.time })) });
      t.diagnostic(JSON.stringify({ requestedTarget, reply: a.messages.filter(message => message.request === 4),
        frameCount: a.frames.length, frames: [...a.frames.slice(0, 3), ...a.frames.slice(-4)].map(sample) }));
      throw error;
    }
    assert.equal(a.frames.at(-1).state.modules.find(m => m.actorId === theirs && m.kind === 'weapon').health, b.frames.at(-1).state.modules.find(m => m.actorId === theirs && m.kind === 'weapon').health);
    for (const actor of a.frames.at(-1).state.actors) {
      const stood = carriers.find(carrier => carrier.id === actor.id);
      assert(Math.hypot(actor.vehicle.x - stood.x, actor.vehicle.y - stood.y) < 1,
        'the single click hits a target standing where it was aimed at, through the real servo and projectile path');
    }
    a.ws.close(); await once(a.ws, 'close'); const rejoined = await connect('Alice', a.welcome.token); assert(rejoined.welcome.actors.some(v => v.id === mine));
  } finally { await close(); }
});
test('a page that comes with the key of a seat takes it from the page sitting there, which is told why; a key changed is refused', { timeout: 25000 }, async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [0, 600] } });
  const until = async (fn, timeout = 6000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const connect = async (name, token = '') => {
    const ws = socket(), page = { ws, messages: [], closed: null };
    ws.on('message', (raw, binary) => { if (!binary) page.messages.push(JSON.parse(raw)); });
    ws.on('close', (code, reason) => { page.closed = [code, String(reason)]; });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token }));
    await until(() => page.messages.some(m => m.type === 'welcome' || m.error));
    page.welcome = page.messages.find(m => m.type === 'welcome'); page.refused = page.messages.find(m => m.error);
    page.ask = async (request, data) => { ws.send(JSON.stringify({ ...data, request })); await until(() => page.messages.some(m => m.request === request)); return page.messages.find(m => m.request === request); };
    return page;
  };
  const phone = await connect('Ana'), bia = await connect('Bia'), key = phone.welcome.token;
  // Another device comes with her key, written as she reads it: it is Ana, with her faction and her name, and the phone is let go.
  const desk = await connect(null, keyText(key).toLowerCase());
  assert.deepEqual([desk.welcome.playerId, desk.welcome.name, desk.welcome.faction.id], [phone.welcome.playerId, 'Ana', phone.welcome.faction.id]);
  await until(() => phone.closed);
  assert.deepEqual(phone.closed, [4001, 'Sua conta entrou em outro aparelho.']); assert.equal(bia.closed, null);
  // She changes it there: told the new key, which nobody else is. With the old one no page comes in any more, and the
  // refusal says it is the key.
  const changed = await desk.ask(1, { type: 'rekey' });
  assert.match(changed.token, /^[0-9A-HJKMNP-TV-Z]{24}$/); assert.notEqual(changed.token, key);
  const stale = await connect('Ana', key);
  assert.deepEqual([stale.welcome, stale.refused.unknownKey, stale.refused.error], [undefined, true, 'Chave de acesso não encontrada neste campo: confira as letras e os números.']);
  assert.equal((await connect('Ana', changed.token)).welcome.playerId, phone.welcome.playerId);
  assert(!bia.messages.some(message => JSON.stringify(message).includes(changed.token) || JSON.stringify(message).includes(key)), 'Bia is told nobody\'s key');
});

test('a page is told the wealth of every faction of the field as they change: one named, founded or gone reaches every other page, met or not', { timeout: 25000 }, async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [-300, 300, 900] } });
  const until = async (fn, timeout = 6000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  // A page with its faction as it has it: whole with the welcome, and brought up to what changed since.
  const connect = async name => {
    const ws = socket(), page = { ws, messages: [], faction: null };
    ws.on('message', (raw, binary) => { if (binary) return; const message = JSON.parse(raw);
      if (message.type === 'welcome') { page.welcome = message; page.faction = message.faction; }
      if (message.type === 'faction') page.faction = merged(page.faction, message.changes); page.messages.push(message); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token: '' }));
    await until(() => page.faction);
    page.ask = async (request, data) => { ws.send(JSON.stringify({ ...data, request })); await until(() => page.messages.some(m => m.request === request)); return page.messages.find(m => m.request === request); };
    return page;
  };
  // Every faction of a rehearsal is as wealthy as the others: a billion of each material and of litres of fuel, at 0.84 kg each.
  const names = page => page.faction.ranking.map(n => n.nation ?? n.name), wealth = 3e9 + .84e9;
  const ana = await connect('Ana'), bia = await connect('Bia');
  // Bia is told of Ana's with her welcome, and Ana of Bia's at the faction's next telling; each of its own by its name on the field,
  // and every one by what a request to join it names it by.
  assert.deepEqual(bia.faction.ranking, [{ id: null, name: 'Ana', nation: null, flag: ana.faction.flag, ref: ana.faction.ref, wealth },
    { id: bia.welcome.faction.id, name: 'Bia', nation: null, flag: bia.faction.flag, ref: bia.faction.ref, wealth }]);
  await until(() => ana.faction.ranking.length === 2);
  assert.deepEqual(ana.faction.ranking, [{ id: ana.welcome.faction.id, name: 'Ana', nation: null, flag: ana.faction.flag, ref: ana.faction.ref, wealth },
    { id: null, name: 'Bia', nation: null, flag: bia.faction.flag, ref: bia.faction.ref, wealth }]);
  // Bia names her nation: Ana, who never met her, is told its name and its flag.
  const flag = { country: 'pt' };
  assert.equal((await bia.ask(1, { type: 'identity', nation: 'Império do Sul', flag })).error, undefined);
  await until(() => ana.faction.ranking[1].nation === 'Império do Sul');
  assert.deepEqual(ana.faction.ranking[1], { id: null, name: null, nation: 'Império do Sul', flag, ref: bia.faction.ref, wealth });
  assert.equal((await ana.ask(2, { type: 'identity', nation: 'império do sul', flag })).error, 'Já há uma facção com esse nome no campo.');
  // Caio comes: the others are told of his faction, and he of theirs, by the names they go by.
  const caio = await connect('Caio');
  await until(() => ana.faction.ranking.length === 3 && bia.faction.ranking.length === 3);
  assert.deepEqual([names(ana), names(bia), names(caio)], Array(3).fill(['Ana', 'Caio', 'Império do Sul']));
  // He joins Ana's faction: his own is gone, for Bia as for Ana.
  await ana.ask(3, { type: 'invite', playerId: caio.welcome.playerId });
  assert.equal((await caio.ask(4, { type: 'join-faction', factionId: ana.welcome.faction.id })).error, undefined);
  await until(() => ana.faction.ranking.length === 2 && bia.faction.ranking.length === 2 && caio.faction.ranking.length === 2);
  assert.deepEqual([names(ana), names(bia), names(caio)], Array(3).fill(['Ana', 'Império do Sul']));
  // Nothing Ana was sent names Bia's faction, which she never met.
  assert(!JSON.stringify(ana.messages).includes(`"${bia.welcome.faction.id}"`));
  // Bia asks to join Ana's by the name she was told of it: Ana is told who asks, accepts, and Bia's page is told the faction she is in now.
  assert.deepEqual((await bia.ask(5, { type: 'apply', ref: ana.faction.ref })).error, undefined);
  await until(() => ana.faction.requests.length === 1 && bia.faction.request?.ref === ana.faction.ref);
  assert.deepEqual(ana.faction.requests.map(r => r.name), ['Bia']);
  assert.equal((await caio.ask(6, { type: 'answer', playerId: bia.welcome.playerId, accept: true })).error, 'Só o líder e os administradores respondem aos pedidos.');
  assert.equal((await ana.ask(7, { type: 'answer', playerId: bia.welcome.playerId, accept: true })).error, undefined);
  await until(() => bia.faction.id === ana.welcome.faction.id && ana.faction.requests.length === 0);
  // A project goes to the library of the faction whole, and every member reads it back as the field would build it.
  const scout = createStructuredTemplate('scout'), published = await caio.ask(8, { type: 'library', act: 'publish', blueprint: scout });
  assert.deepEqual([published.error, published.model.name], [undefined, scout.name]);
  await until(() => bia.faction.library.length === 1);
  assert.deepEqual(bia.faction.library.map(m => [m.id, m.name, m.by]), [[published.model.id, scout.name, 'Caio']]);
  const shelf = await bia.ask(9, { type: 'library', act: 'get', ids: bia.faction.library.map(m => m.id) });
  assert.deepEqual(shelf.models.map(m => [m.id, m.blueprint.name, m.blueprint.components.length]), [[published.model.id, scout.name, scout.components.length]]);
  assert.match((await bia.ask(10, { type: 'library', act: 'publish', blueprint: { ...scout, version: 1 } })).error, /não pode ser fabricado/);
});

test('the names a page asks of the library of its faction are light messages, and the designs it publishes there are not', { timeout: 20000 }, async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [-300, 300] } });
  const until = async (fn, timeout = 6000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const connect = async name => {
    const ws = socket(), page = { ws, replies: [], closed: null };
    ws.on('message', (raw, binary) => { if (binary) return; const message = JSON.parse(raw); if (message.type === 'welcome') page.welcome = message; if (message.request) page.replies.push(message); });
    ws.on('close', code => { page.closed = code; });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token: '' }));
    await until(() => page.welcome);
    return page;
  };
  // Four designs at once fit the publication burst and use the design byte budget.
  const ana = await connect('Ana'), scout = createStructuredTemplate('scout');
  for (let i = 1; i <= 4; i++) ana.ws.send(JSON.stringify({ type: 'library', act: 'publish', blueprint: { ...scout, name: 'Batedor ' + i }, request: i }));
  await until(() => ana.replies.length === 4);
  assert.deepEqual([ana.closed, ana.replies.map(reply => reply.error ?? reply.model.name)], [null, ['Batedor 1', 'Batedor 2', 'Batedor 3', 'Batedor 4']]);
  // Requests for library IDs use the budget for light messages.
  const ids = Array.from({ length: ROOM_LIMITS.library }, (_, i) => i.toString(16).padStart(12, '0'));
  const lookup = JSON.stringify({ type: 'library', act: 'get', ids, request: 10 });
  for (let i = 0; i <= Math.ceil(WORLD_LIMITS.lightBytes[1] / Buffer.byteLength(lookup)); i++) ana.ws.send(lookup);
  await until(() => ana.closed !== null);
  assert.equal(ana.closed, 1008);
});
