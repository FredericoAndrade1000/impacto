import { nativePhotoOnly } from './helpers/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { manufactureDesign } from '../server/field-construction.ts';
import { rehearsal } from '../server/room.ts';
import { MAX_FACTION_CONSTRUCTIONS } from '../src/construction-limits.ts';
import { FrameWriter, FrameReader, NETWORK_VERSION, merged } from '../src/network-protocol.ts';
import { DECISION_STEPS, ARRIVAL } from '../src/squad.ts';
import { AIRDROP } from '../server/world-activities.ts';
import { GUARDIAN, GuardianSide, spawnGuardian } from '../server/airdrop-guardian.ts';
import { designBill, appraise, fieldParts, TURN_SECONDS } from '../src/economy.ts';
import { AIM_SKY } from '../src/battle-rules.ts';
import { SENSOR_MODES, COMMAND_CAMERA_RANGE } from '../src/combat-sensors.ts';
import { controlContext } from '../src/ui-model.ts';
import { firingSolution } from '../src/ballistics.ts';
import { weaponSettings } from '../src/weapons.ts';
import { turnedLauncher } from '../src/turn-about.ts';
import { Publication } from '../server/publication.ts';
import { chapters } from '../server/fog.ts';
import { readField, writeField } from '../server/field-snapshot.ts';
import { onField } from './helpers/field.js';
import { serveNetwork } from './helpers/network.js';

// Alice with three constructions on the left, Bob with one on the right, facing each other.
function field(t) {
  const f = onField(t, rehearsal([-100, 60])), room = f.room, alice = room.join('Alice'), bob = room.join('Bob'),
    publish = (player, model, x, facing) => f.publish(player, model, { x, facing });
  const heavy = publish(alice, 'heavy', -90, 1), ifv = publish(alice, 'ifv', -110, 1), mortar = publish(alice, 'mortar', -130, 1),
    enemy = publish(bob, 'heavy', 60, -1), run = f.run, order = (player, data) => f.send(player, 'squad', data),
    unit = id => room.squadView(alice.playerId).units.find(u => u.id === id), x = id => room.world.actor(id).vehicle.x;
  // Publishing puts nobody at the controls: each player takes the last construction it published into hand.
  order(alice, { order: 'control', id: mortar }); order(bob, { order: 'control', id: enemy });
  return { room, alice, bob, heavy, ifv, mortar, enemy, run, order, unit, x, publish, squad: room.players.get(alice.playerId).squad };
}

test('publishing, and coming into the field, put nobody at the controls: the new construction is only picked', t => {
  const room = rehearsal([-100]); t.after(() => room.world.dispose());
  const alice = room.join('Alice'), squad = room.players.get(alice.playerId).squad;
  const scout = room.publish(alice.playerId, createStructuredTemplate('scout')).actor.id;
  assert.deepEqual([room.players.get(alice.playerId).selected, squad.manual], [scout, null], 'picked, under command');
  room.command(alice.playerId, { type: 'squad', order: 'control', id: scout }); assert.equal(squad.manual, scout);
  // Another construction published lets go of the one in hand too.
  room.players.get(alice.playerId).builtAt = -Infinity;
  const truck = room.publish(alice.playerId, createStructuredTemplate('truck')).actor.id;
  assert.deepEqual([room.players.get(alice.playerId).selected, squad.manual], [truck, null]);
  // Back on the field after leaving it, the player commands: nothing is in hand.
  room.command(alice.playerId, { type: 'squad', order: 'control', id: scout }); room.disconnect(alice.playerId);
  room.join('Alice', alice.token); assert.deepEqual([room.players.get(alice.playerId).selected, squad.manual], [scout, null]);
});

test('on the shared field a player has one construction in hand and the others under orders', t => {
  const { room, alice, bob, heavy, ifv, mortar, enemy, order, squad } = field(t), view = room.squadView(alice.playerId);
  assert.equal(view.manual, mortar, 'the construction taken into hand');
  assert.deepEqual(view.units.map(u => [u.id, u.role, u.stance]), [[heavy, 'armor', 'return'], [ifv, 'armor', 'return'], [mortar, 'artillery', 'return']]);
  assert.deepEqual(room.squadView(bob.playerId).units.map(u => u.id), [enemy]); assert.deepEqual(view.out, []);
  // Choosing a construction still puts it in the player's hands; a squad order moves them, or lets go.
  assert.deepEqual(room.command(alice.playerId, { type: 'select', actorId: heavy }), { selected: heavy }); assert.equal(squad.manual, heavy);
  assert.deepEqual(order(alice, { order: 'control', id: ifv }), { selected: ifv }); assert.equal(room.players.get(alice.playerId).selected, ifv);
  assert.deepEqual(order(alice, { order: 'control', id: null }), { selected: ifv }); assert.equal(squad.manual, null);
  // The construction stays in focus for the workshop; only driving and firing need it in hand.
  assert.deepEqual(room.command(alice.playerId, { type: 'drive', throttle: 1, brake: 0 }), {}, 'an input on its way is dropped');
  assert.throws(() => room.command(alice.playerId, { type: 'fire', request: 1, aim: { x: 0, y: 3 }, weapon: { id: 'cannon' } }), /Assuma o controle/);
  assert.equal(room.command(alice.playerId, { type: 'blueprint' }).actor.id, ifv);
  // The screen is in manual control of the construction in hand only.
  const network = { enabled: true, connected: true, selected: ifv, manualActorId: null }, state = id => ({ shared: true, squad: { ...room.squadView(alice.playerId), manual: id }, actors: [{ id: ifv }, { id: heavy }] });
  assert.equal(controlContext({ mode: 'test' }, state(null), network).manual, false);
  network.manualActorId = heavy;
  assert.equal(controlContext({ mode: 'test' }, state(heavy), network).actorId, heavy); assert.equal(controlContext({ mode: 'test' }, state(heavy), network).manual, true);
});

test('orders reach only the player\'s own constructions, and only the constructions of others are targets', t => {
  const { room, alice, bob, heavy, ifv, mortar, enemy, order, unit } = field(t);
  order(alice, { order: 'control', id: null });
  order(bob, { order: 'move', ids: [heavy, ifv, mortar], x: 150 }); order(bob, { order: 'stance', ids: [heavy], stance: 'fire' });
  assert.equal(unit(heavy).move, null); assert.equal(unit(heavy).stance, 'return');
  assert.throws(() => order(bob, { order: 'control', id: heavy }), /de outra facção/);
  assert.throws(() => order(alice, { order: 'attack', ids: [heavy], targetId: ifv }), /Alvo inválido/);
  assert.throws(() => order(alice, { order: 'attack', ids: [heavy], targetId: 'nobody' }), /Alvo inválido/);
  const ground = room.world.terrain, point = { x: 40, y: ground.height(40) + 4 };
  for (const outside of [{ x: ground.maxX + 1, y: point.y }, { x: 40, y: -AIM_SKY - 1 }, { x: 40, y: AIM_SKY + 1 }])
    assert.throws(() => order(alice, { order: 'bombard', ids: [mortar], point: outside }), /fora do campo/);
  assert.throws(() => order(alice, { order: 'move', ids: [heavy], x: 'far' }), /Destino inválido/);
  assert.throws(() => order(alice, { order: 'dance', ids: [heavy] }), /Ordem desconhecida/);
  order(alice, { order: 'attack', ids: [heavy, ifv, 'nobody', enemy], targetId: enemy });
  assert.deepEqual([heavy, ifv, mortar].map(id => unit(id).attack?.targetId ?? null), [enemy, enemy, null]);
  order(alice, { order: 'bombard', ids: [mortar], point }); assert.deepEqual(unit(mortar).attack, { point });
  order(alice, { order: 'stop', ids: [heavy, ifv, mortar] }); assert.deepEqual([heavy, ifv, mortar].map(id => unit(id).attack), [null, null, null]);
});

test('the server carries the orders out: a construction told to attack fires, one told to move drives there', t => {
  const { room, alice, heavy, ifv, enemy, run, order, unit, x } = field(t);
  order(alice, { order: 'control', id: null }); run(2);
  assert.equal(room.world.stats.shots, 0, 'nobody fires without being hit or ordered');
  order(alice, { order: 'attack', ids: [heavy], targetId: enemy });
  for (let second = 0; second < 12 && !room.world.stats.shots; second++) run(1);
  assert(room.world.stats.shots > 0, 'the construction ordered to attack fired');
  assert.equal(unit(heavy).targetId, enemy); assert.deepEqual([...room.faults], []);
  // The leading construction has open ground ahead; one behind a friend would wait for it instead.
  const from = x(heavy); order(alice, { order: 'move', ids: [heavy], x: from + 25 });
  for (let second = 0; second < 20 && unit(heavy).move; second++) run(1);
  assert.equal(unit(heavy).move, null, 'the order ends at the place'); assert(Math.abs(x(heavy) - (from + 25)) < 3, `it stopped ${(x(heavy) - from).toFixed(1)} m on`);
  assert.equal(unit(heavy).attack.targetId, enemy, 'and the attack order stands');
  // Taken over, it obeys the player's hands and no longer the orders.
  order(alice, { order: 'move', ids: [heavy], x: from }); order(alice, { order: 'control', id: heavy });
  assert.equal(unit(heavy).move, null); assert.equal(unit(heavy).attack, null); const held = x(heavy);
  room.command(alice.playerId, { type: 'drive', throttle: 1, brake: 0 }); run(2);
  assert(x(heavy) > held + 1, 'the construction in hand is driven by the player');
  assert.deepEqual([...room.faults], []);
});

test('orders outlive what they name without stopping the field', t => {
  const { room, alice, bob, heavy, ifv, mortar, enemy, run, order, unit, publish, squad } = field(t);
  order(alice, { order: 'control', id: null });
  order(alice, { order: 'attack', ids: [heavy, ifv], targetId: enemy }); run(1);
  room.command(bob.playerId, { type: 'abandon', actorId: enemy }); run(1);
  assert.deepEqual([unit(heavy).attack, unit(ifv).attack], [null, null], 'a target that left the fight is no order');
  order(alice, { order: 'move', ids: [ifv], x: -60 }); order(alice, { order: 'stance', ids: [ifv], stance: 'fire' });
  run(11); // work on a construction waits for it to be out of combat
  room.players.get(alice.playerId).builtAt = -Infinity;
  room.command(alice.playerId, { type: 'replace', actorId: ifv, blueprint: createStructuredTemplate('ifv') });
  assert.deepEqual([room.players.get(alice.playerId).selected, squad.manual], [ifv, null], 'a replaced construction is picked, with nobody at its controls');
  assert.deepEqual([unit(ifv).move, unit(ifv).stance], [null, 'return'], 'and carries none of the old orders');
  room.command(alice.playerId, { type: 'remove', actorId: heavy }); run(1);
  assert.deepEqual(room.squadView(alice.playerId).units.map(u => u.id).sort(), [ifv, mortar].sort()); assert.deepEqual([...room.faults], []);
  // A player who leaves lets go of everything; coming back, the player commands: the construction is picked, not in hand.
  order(alice, { order: 'control', id: mortar }); room.disconnect(alice.playerId);
  assert.equal(squad.manual, null); run(1);
  const back = room.join('Alice', alice.token);
  assert.equal(back.selected, mortar); assert.equal(squad.manual, null);
  publish(bob, 'heavy', 90, -1); run(1); assert.deepEqual([...room.faults], []);
});

test('the constructions of a player who left stay on the field under the orders they were left with', t => {
  // A tank and a machine gun in sight of each other, on a stretch of open ground. The tank came first:
  // it is the one that pays for the reading of a round, and the machine gun decides in the step after it.
  const room = rehearsal([810, 890]); t.after(() => room.world.dispose());
  const alice = room.join('Alice'), bob = room.join('Bob'),
    heavy = room.publish(alice.playerId, createStructuredTemplate('heavy'), { facing: 1 }).actor.id,
    scout = room.publish(bob.playerId, createStructuredTemplate('scout'), { facing: -1 }).actor.id,
    run = seconds => { for (let i = 0; i < seconds * 60; i++) room.step(); },
    order = (player, data) => room.command(player.playerId, { type: 'squad', ...data }),
    unit = () => room.squadView(alice.playerId).units.find(u => u.id === heavy), shots = id => room.world.actor(id).stats.shots,
    squad = room.players.get(alice.playerId).squad;
  order(alice, { order: 'control', id: null }); order(bob, { order: 'control', id: null });
  order(alice, { order: 'stance', ids: [heavy], stance: 'hold' });
  order(bob, { order: 'attack', ids: [scout], targetId: heavy });
  for (let second = 0; second < 10 && !unit().alert; second++) run(1);
  assert(unit().alert, 'the machine gun marked the armour'); run(3);
  assert(shots(scout) > 20, 'whoever decides in the second step of a round keeps firing, by the reading of the first: ' + shots(scout));
  assert.equal(shots(heavy), 0, 'with its player there, a construction holding its fire waits for the order');
  // The machine gun stops before it wears through the armour; it fires again further on, to be answered.
  order(bob, { order: 'stance', ids: [scout], stance: 'hold' });
  // The player leaves. Nothing of theirs goes with them, however long they stay away.
  room.disconnect(alice.playerId); room.checkLeases(room.steps + 24 * 216_000);
  assert.deepEqual(room.squadView(alice.playerId).units.map(u => u.id), [heavy]);
  assert.deepEqual(room.roster().find(p => p.id === alice.playerId), { id: alice.playerId, connected: false });
  run(8); assert.equal(shots(heavy), 0, 'left alone, the construction holding its fire holds it still');
  assert.equal(unit().stance, 'hold', 'its orders are what its player left');
  // Told to return fire before the player left, it answers the one that hits it.
  room.join('Alice', alice.token); order(alice, { order: 'control', id: null }); order(alice, { order: 'stance', ids: [heavy], stance: 'return' });
  room.disconnect(alice.playerId); order(bob, { order: 'attack', ids: [scout], targetId: heavy });
  for (let second = 0; second < 15 && !shots(heavy); second++) run(1);
  assert(shots(heavy) > 0, 'left to return fire, it answers the hit'); assert.deepEqual([...room.faults], []);
  // Back, the player finds it where it stood, picked and under command.
  const back = room.join('Alice', alice.token);
  assert.deepEqual([back.playerId, back.selected, back.actors.map(a => a.id)], [alice.playerId, heavy, [heavy]]);
  assert.equal(squad.manual, null);
});

test('constructions that only watch look around seldom; one with an order decides at the pace of a pilot', t => {
  const { room, alice, heavy, enemy, run, order, squad } = field(t);
  order(alice, { order: 'control', id: null }); run(1);
  let decisions = 0; const decide = squad.decide.bind(squad); squad.decide = (...args) => { decisions++; return decide(...args); };
  run(2); const watching = decisions / 3; // three constructions under orders
  assert(watching >= 3 && watching <= 6, `about twice a second while idle (${watching} rounds in 2 s)`);
  decisions = 0; order(alice, { order: 'attack', ids: [heavy], targetId: enemy }); run(2);
  assert(decisions / 3 >= 2 * 60 / DECISION_STEPS / 3, `the whole squad decides with the busy one (${decisions / 3} rounds in 2 s)`);
});

test('only an order that changes something asks the field for a round, and a player asks no more than once a round of the pilots', t => {
  const { room, alice, heavy, ifv, mortar, enemy, run, order, squad } = field(t), seat = room.players.get(alice.playerId),
    send = data => { try { order(alice, data); } catch { /* refused */ } };
  order(alice, { order: 'control', id: null }); order(alice, { order: 'stop', ids: [heavy, ifv, mortar] }); run(1);
  while (room.dealing) room.step();
  // A flood of orders refused, or that change nothing, leaves the field to its pace: no round is asked for.
  const pace = room.round;
  for (let i = 0; i < 120; i++) send([{ order: 'x' }, { order: 'dance', ids: [heavy] }, { order: 'move', ids: [heavy], x: 'far' }, { order: 'stop', ids: [enemy] },
    { order: 'attack', ids: [heavy], targetId: 'nobody' }, { order: 'stop', ids: [heavy] }, { order: 'control', id: null }][i % 7]);
  assert.equal(room.round, pace, 'the next round is the one the field had');
  // An order obeyed is obeyed at the next step: the whole squad decides then.
  let decisions = 0; const decide = squad.decide.bind(squad); squad.decide = (...args) => { decisions++; return decide(...args); };
  order(alice, { order: 'stance', ids: [heavy], stance: 'fire' }); assert.equal(room.round, 0);
  room.step(); assert.equal(decisions, 3, 'decided in the step after the order');
  // Another, sooner than a round of the pilots after it, is obeyed when that round is up; and a flood of them asks no more.
  const hastened = seat.hastened;
  for (let i = 0; i < 120; i++) { order(alice, { order: 'stance', ids: [ifv], stance: i % 2 ? 'hold' : 'fire' }); assert.notEqual(room.round, 0); }
  assert(room.round <= hastened + DECISION_STEPS, `a round at step ${room.round}, the order at ${hastened}`);
  decisions = 0;
  for (let i = 0; i < 60; i++) { room.step(); for (const stance of ['hold', 'fire']) order(alice, { order: 'stance', ids: [ifv], stance }); }
  // At most twice the pace of a busy squad, where a round at every step would be sixty.
  assert(decisions <= 2 * 3 * 60 / DECISION_STEPS, `${decisions / 3} rounds in a second of orders at every step`);
  assert.deepEqual([...room.faults], []);
});

test('an order names no more constructions than a faction has, by their names, and is refused before any is looked for', t => {
  const { room, alice, heavy, ifv, order, unit } = field(t);
  order(alice, { order: 'control', id: null });
  const lookup = room.field.actor; let looked = 0;
  room.field.actor = id => { looked++; return lookup.call(room.field, id); }; t.after(() => { delete room.field.actor; });
  for (const ids of [Array(MAX_FACTION_CONSTRUCTIONS + 1).fill(heavy), Array.from({ length: 100_000 }, (_, i) => 'c' + i), [heavy, 7], [heavy, { id: heavy }], heavy])
    assert.throws(() => order(alice, { order: 'stance', ids, stance: 'fire' }), /^Error: Ordem inválida\.$/);
  assert.equal(looked, 0, 'no construction was looked for'); assert.equal(unit(heavy).stance, 'return');
  // As many as a faction has are an order like any other, the same one named twice or not.
  order(alice, { order: 'stance', ids: [...Array(MAX_FACTION_CONSTRUCTIONS - 1).fill(heavy), ifv], stance: 'fire' });
  assert.deepEqual([unit(heavy).stance, unit(ifv).stance], ['fire', 'fire']);
});

test('orders and objective selection cover a legacy fleet of thirteen vehicles and thirty-two fixed constructions', t => {
  const { room, world, send, order } = onField(t, rehearsal([-100])), alice = room.join('Alice'),
    seat = room.players.get(alice.playerId), faction = room.faction(seat), defence = createStructuredTemplate('guard-post');
  // These vehicles predate the lower vehicle quota; the fixed allowance can take their total above forty-four.
  for (let i = 0; i < 13; i++) room.furnish(seat, manufactureDesign(createStructuredTemplate(i === 12 ? 'mining-truck' : 'chassis')));
  for (let i = 0; i < 32; i++) world.addActor(defence,
    { id: `legacy-fixed-${i}`, ownerId: alice.playerId, team: faction.id, x: alice.base.x - 500 - i * 8, facing: 1 });
  const ids = world.actors.map(actor => actor.id);
  assert.equal(ids.length, 45); assert.deepEqual(room.constructionCounts(faction), { vehicles: 13, fixed: 32 });
  order(alice, 'stance', { ids, stance: 'hold' });
  assert.equal(seat.squad.units.size, ids.length); assert([...seat.squad.units.values()].every(unit => unit.stance === 'hold'));
  assert.deepEqual(send(alice, 'objectives', { action: 'select', ids }), {});
  assert.equal(seat.objectives.selectMiner, true, 'selection is processed for the real fleet');
  const lookup = room.field.actor; let looked = 0;
  room.field.actor = id => { looked++; return lookup.call(room.field, id); }; t.after(() => { delete room.field.actor; });
  for (const excessive of [[...ids, ids[0]], Array(100_000).fill(ids[0])]) {
    assert.throws(() => order(alice, 'stance', { ids: excessive, stance: 'fire' }), /^Error: Ordem inválida\.$/);
    assert.throws(() => send(alice, 'objectives', { action: 'select', ids: excessive }), /^Error: Seleção de objetivo inválida\.$/);
  }
  assert.equal(looked, 0, 'oversized orders and selections are refused before actor lookup');
  assert([...seat.squad.units.values()].every(unit => unit.stance === 'hold'));
});

test('a real client is told of its squad, alone, and commands it over the socket', async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [-50, 50] } });
  const connect = async name => {
    const ws = socket(), messages = [], frames = [], reader = new FrameReader();
    // The squad as the page has it: what changed of it, put together with what it was told before.
    let orders = null;
    ws.on('message', (raw, binary) => { if (binary) { const packet = reader.decode(raw); if (packet) frames.push(packet); else ws.send(JSON.stringify({ type: 'resync' })); }
      else { const message = JSON.parse(raw); if (message.type === 'squad') orders = merged(orders, message.changes); messages.push(message); } });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token: '' }));
    const until = async (fn, timeout = 6000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
    const squad = () => orders?.squad, reply = request => messages.find(m => m.request === request);
    await until(() => messages.some(m => m.type === 'welcome'));
    return { ws, messages, frames, until, squad, reply, send: data => ws.send(JSON.stringify(data)) };
  };
  const a = await connect('Alice'), b = await connect('Bob');
  a.send({ type: 'spawn', request: 1, x: -40, facing: 1, blueprint: createStructuredTemplate('heavy') });
  await a.until(() => a.reply(1)?.actor); const first = a.reply(1).actor.id;
  await new Promise(resolve => setTimeout(resolve, 450)); // the server asks for a pause between two publications
  a.send({ type: 'spawn', request: 2, x: -60, facing: 1, blueprint: createStructuredTemplate('ifv') });
  b.send({ type: 'spawn', request: 3, x: 40, facing: -1, blueprint: createStructuredTemplate('heavy') });
  await a.until(() => a.reply(2)?.actor && a.squad()?.units.length === 2); await b.until(() => b.reply(3)?.actor && b.squad()?.units.length === 1);
  const second = a.reply(2).actor.id, theirs = b.reply(3).actor.id;
  assert.equal(a.squad().manual, null, 'publishing puts nobody at the controls'); assert.deepEqual(a.squad().units.map(u => u.id), [first, second]);
  assert.deepEqual(b.squad().units.map(u => u.id), [theirs], 'each player is told of its own squad only');
  assert(a.frames.at(-1).state.squad === undefined, 'the frame everybody receives carries nobody\'s orders');
  a.send({ type: 'squad', request: 4, order: 'control', id: null });
  a.send({ type: 'squad', request: 5, order: 'attack', ids: [first, second], targetId: theirs });
  await a.until(() => a.reply(5) && a.squad().manual === null && a.squad().units.every(u => u.attack?.targetId === theirs));
  assert.equal(a.reply(4).error, undefined); assert.equal(a.reply(4).selected, second);
  b.send({ type: 'squad', request: 6, order: 'attack', ids: [first], targetId: theirs }); await b.until(() => b.reply(6));
  assert.match(b.reply(6).error, /Alvo inválido/);
  a.send({ type: 'squad', request: 7, order: 'control', id: first }); await a.until(() => a.reply(7) && a.squad().manual === first);
  assert.equal(a.squad().units[0].attack, null, 'taking a construction over ends its order');
});

test('a real client tips part of a load out over the socket: the reply says what came out, and its faction is told what is left', async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [0] } }), ws = socket(), messages = [];
  let faction = null;
  ws.on('message', (raw, binary) => { if (binary) return; const message = JSON.parse(raw); if (message.type === 'welcome') faction = message.faction;
    if (message.type === 'faction') faction = merged(faction, message.changes); messages.push(message); });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name: 'Alice', token: '' }));
  const until = async (fn, timeout = 6000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } },
    reply = request => messages.find(m => m.request === request), ask = async (request, data) => { ws.send(JSON.stringify({ ...data, request })); await until(() => reply(request)); return reply(request); },
    told = id => faction?.units.find(unit => unit.id === id);
  await until(() => messages.some(m => m.type === 'welcome'));
  // A lorry in its base. Empty, it has nothing to tip out.
  const lorry = (await ask(2, { type: 'spawn', blueprint: createStructuredTemplate('truck'), x: 0 })).actor.id;
  assert.equal((await ask(30, { type: 'auto', actorId: lorry, on: false })).auto, false);
  assert.equal((await ask(3, { type: 'dump-cargo', actorId: lorry })).error, 'Essa construção não leva carga para despejar.');
  // The one load there is without a vein: a supply vehicle out of automatic filled by its base and left just outside
  // it, whose wreck the lorry takes the supplies of, as ore — outside, where its hopper is not emptied into the yard. A
  // quarter of what the hopper holds when full is tipped out, or what is left of it.
  await new Promise(resolve => setTimeout(resolve, 600));
  const supply = (await ask(4, { type: 'spawn', blueprint: createStructuredTemplate('supply'), x: 10 })).actor.id;
  assert.equal((await ask(5, { type: 'auto', actorId: supply, on: false })).auto, false);
  await until(() => told(supply)?.supplies?.ferro > 1000, 20000);
  await ask(6, { type: 'squad', order: 'move', ids: [lorry, supply], x: 170 });
  await until(() => [lorry, supply].every(id => told(id) && !told(id).atBase && told(id).still), 40000);
  const loaded = told(supply).supplies.ferro;
  assert.equal((await ask(7, { type: 'abandon', actorId: supply })).error, undefined);
  const taken = await ask(8, { type: 'salvage', wreckId: supply });
  assert(loaded > 1000); assert.deepEqual([taken.error, taken.cargo.ferro], [undefined, loaded]);
  const tipped = await ask(9, { type: 'dump-cargo', actorId: lorry });
  assert.equal(tipped.error, undefined); assert(tipped.dumped.ferro > 0 && tipped.dumped.ferro < loaded);
  await until(() => told(lorry)?.cargo.ferro > 0 && told(lorry).cargo.ferro < loaded, 20000);
  assert.equal(told(lorry).cargo.ferro, loaded - tipped.dumped.ferro);
});

test('a two-portion round keeps input order across factions and rechecks who can still decide', t => {
  const { room, alice, bob, heavy, ifv, mortar, enemy, run, order, unit, x, publish } = field(t),
    extra = publish(alice,'scout',-160,1);
  order(alice,{order:'control',id:null}); order(bob,{order:'control',id:null}); run(.5);
  order(alice,{order:'move',ids:[heavy],x:x(heavy)+1.3});
  order(bob,{order:'stance',ids:[enemy],stance:'hold'});
  const game=room.world.game(), call=game.call.bind(game), inputs=[], batches=[];
  game.call=request=>{
    const result=call(request);
    if(request.op==='scriptedDecisions') batches.push(request.requests.map(r=>r.actorId));
    if(request.op==='input' && request.input.type==='controls' && request.input.phase==='decision') inputs.push(request.actorId);
    return result;
  };
  room.round=room.steps; room.step({pace:()=>1});
  assert.equal(room.dealing.done,1); assert.equal(unit(heavy).move,null,'the first portion completes the real arrival');
  assert.deepEqual(inputs,[heavy]);
  // The preceding move recorded Alice's hasten time: taking control now waits
  // for that cadence, leaving this round's original ordered actors in place.
  order(alice,{order:'control',id:ifv}); room.discard(mortar);
  inputs.length=0;
  room.step({pace:()=>1});
  assert.equal(room.dealing,null); assert.equal(room.squadView(alice.playerId).manual,ifv);
  assert.deepEqual(batches,[[enemy,extra]],'the remaining ordinary pilots share a batch across factions');
  assert.deepEqual(inputs,[enemy,extra],'manual and removed actors get no decision input');
  assert.deepEqual([...room.faults],[]);
});

test('F2 guardian: real Native perception and muzzle, bounded pursuit, effective return, base veto and finite saved resources', t => {
  let dropX = 0;
  const f = onField(t, rehearsal(i => i ? dropX + 200 : -2000)), { room, world, ground } = f;
  dropX = Array.from({ length: 101 }, (_, i) => i * 20 - 1000).find(x => [-140, -40, 40, 140].every(dx => Math.abs(ground.height(x + dx) - ground.height(x)) < 4));
  assert(Number.isFinite(dropX), 'this fixture needs an ordinary level stretch, without editing the terrain');
  const alice = room.join('Alice'), target = f.publish(alice, 'scout', { facing: 1 });
  f.put(target, dropX - 30); f.order(alice, 'control', { id: target });
  room.activities = { nextId: 2, nextAt: world.time + AIRDROP.interval,
    drop: { id: 'airdrop:1', x: dropX, stock: 4000, arrivesAt: world.time + .2, expiresAt: world.time + AIRDROP.collect } };
  spawnGuardian(room); // This encounter fixture places the existing AI deliberately; ordinary events spawn only on their safe announcement.
  assert(f.until(() => room.guardianSquad, 1));
  const id = room.activities.drop.guardianId, side = room.guardianSquad.side, inputs = [], realInput = side.input.bind(side),
    resources = helper => ({ fuel: helper.parts(id, 'fuel').map(piece => piece.fuelLitres), rounds: helper.parts(id, 'ammo').map(piece => piece.rounds) });
  side.input = (actorId, input, decision) => {
    if (decision) inputs.push({ at: world.time, targetId: input.targetId, throttle: input.throttle, brake: input.brake, fire: input.fire,
      reason: input.diagnostics?.reason,
      contact: input.contact && { detected: input.contact.detected, visible: input.contact.visible, source: input.contact.source,
        confidence: input.contact.confidence, age: input.contact.age, channel: input.contact.channel || input.contact.source, x: input.contact.x } });
    return realInput(actorId, input, decision);
  };
  const initial = resources(f), began = world.time; let shot = null;
  t.diagnostic(JSON.stringify({ guardianEconomy: { rawIron: 4000, ordinaryCost: designBill(world.actor(id).blueprint), ordinarySalvage: appraise(world.actor(id), fieldParts(world)).salvage } }));
  world.drainEvents();
  assert(f.until(() => {
    for (const event of world.drainEvents()) if (event.type === 'muzzle' && event.actorId === id && event.time >= began) shot = { type: event.type, actorId: event.actorId, time: event.time };
    return Boolean(shot);
  }, 8), 'a new published muzzle belongs to this exact guardian, not an ACK or speculative projectile');
  assert(inputs.some(input => input.targetId === target && input.contact?.detected && input.contact.age < 1 && ['visual', 'radar'].includes(input.contact.channel)), 'its actual Native decision has a placed human contact');
  assert(resources(f).rounds.reduce((a, b) => a + b, 0) < initial.rounds.reduce((a, b) => a + b, 0));
  assert.equal(world.actor(id).ownerId, null); assert.equal(room.players.size, 1); assert.equal(room.factions.size, 1);
  // Outside the patrol is still a legitimate shot. This return fixture instead loses the target beyond
  // every installed sensor's catalogue reach, with room for the patrol and both physical hulls.
  const sensorReach = Math.max(COMMAND_CAMERA_RANGE, ...f.parts(id, 'sensor').map(sensor =>
      (SENSOR_MODES[sensor.sensorMode] || SENSOR_MODES.visual).range)),
    lostDistance = sensorReach + GUARDIAN.leash + 100,
    lostX = dropX + lostDistance < world.bounds.maxX - 20 ? dropX + lostDistance : dropX - lostDistance,
    lostAt = world.time;
  assert(lostX > world.bounds.minX + 20 && lostX < world.bounds.maxX - 20, 'the ordinary map must have room outside this sensor envelope');
  f.put(target, lostX);
  assert(f.until(() => {
    const input = inputs.at(-1), contact = input?.contact;
    return input?.at > lostAt && !(input.targetId === target && contact?.detected && contact.visible &&
      contact.source !== 'memory' && contact.age < 1 && ['visual', 'radar'].includes(contact.channel));
  }, 2), 'a real Native decision must confirm loss of fresh placed contact before the return is timed');
  world.drainEvents();
  const distantLeg = room.guardianSquad.units.get(id).move;
  assert(!distantLeg || Math.abs(distantLeg.x - dropX) <= GUARDIAN.leash - 20 + 1e-6,
    'a distant contact may be shot with a real solution, but cannot move the patrol objective');
  const actor = world.actor(id), v = actor.vehicle, beforePositioning = { at: world.time, x: v.x - dropX, move: structuredClone(room.guardianSquad.units.get(id).move) };
  room.guardianSquad.command({ order: 'stop', ids: [id] });
  t.diagnostic(JSON.stringify({ returnFixture: { targetOutsideSensors: { x: lostX, sensorReach, lostAt },
    beforePositioning, stoppedMove: room.guardianSquad.units.get(id).move } }));
  world.command('setVehicleState', { actorId: id, state: { x: dropX + GUARDIAN.leash + 10, y: v.y - ground.height(v.x) + ground.height(dropX + GUARDIAN.leash + 10), vx: 0, vy: 0 } });
  const outside = Math.abs(world.actor(id).vehicle.x - dropX), fuelBeforeReturn = resources(f).fuel.reduce((a, b) => a + b, 0);
  assert(outside > GUARDIAN.leash);
  let furthestGoal = 0; const trajectory = [];
  const returned = f.until(() => {
    const unit = room.guardianSquad.units.get(id);
    if (unit.move) furthestGoal = Math.max(furthestGoal, Math.abs(unit.move.x - dropX));
    if (!trajectory.length || world.time - trajectory.at(-1).at >= 1) trajectory.push({ at: world.time, x: world.actor(id).vehicle.x - dropX, vx: world.actor(id).vehicle.vx,
      facing: world.actor(id).facing, goal: unit.move?.x - dropX, halt: unit.halt, reason: unit.reason, activity: unit.activity, fuel: resources(f).fuel });
    return Math.abs(world.actor(id).vehicle.x - dropX) <= 20;
  }, 30);
  t.diagnostic(JSON.stringify({ guardianReturn: { id, dropX, outside, returned,
    trajectory: { count: trajectory.length, first: trajectory.slice(0, 2), last: trajectory.slice(-2) },
    inputs: guardianInputSummary(inputs) } }));
  assert(returned, 'the ordinary Squad actually drives back from outside the leash');
  assert(furthestGoal <= GUARDIAN.leash - 20 + 1e-6);
  assert(resources(f).fuel.reduce((a, b) => a + b, 0) < fuelBeforeReturn, 'the physical return spends its finite fuel');
  const kept = JSON.parse(JSON.stringify(room.keep())), keptResources = resources(f), serial = room.serials.c;
  room.join('New base');
  f.put(target, dropX - 30); f.run(.5); world.drainEvents(); f.run(2);
  assert(!world.drainEvents().some(event => event.type === 'muzzle' && event.actorId === id), 'a real base founded in the protected zone vetoes attack');
  assert.equal(room.guardianSquad.units.get(id).move, null, 'it does not pursue the new base');
  const again = onField(t, rehearsal([-2000], undefined, { kept })), { room: restored, world: back } = again;
  assert.deepEqual(resources(again), keptResources); assert.equal(restored.serials.c, serial);
  assert.equal(back.actors.filter(actor => actor.id === id).length, 1, 'resume reuses the one physical actor');
  for (const piece of again.parts(id, 'fuel')) again.set(piece, { fuelLitres: 0 });
  for (const piece of again.parts(id, 'ammo')) again.set(piece, { rounds: 0 });
  const current = back.actor(id).vehicle;
  back.command('setVehicleState', { actorId: id, state: { x: current.x, y: current.y, vx: 0, vy: 0 } });
  const goal = current.x + 50;
  restored.guardianSquad.command({ order: 'move', ids: [id], x: goal }); back.drainEvents(); again.run(3);
  assert(resources(again).fuel.every(value => value === 0)); assert(resources(again).rounds.every(value => value === 0));
  assert(!back.drainEvents().some(event => event.type === 'muzzle' && event.actorId === id));
  assert(Math.abs(back.actor(id).vehicle.x - goal) > ARRIVAL, 'an empty tank does not create powered travel');
  const facing = back.actor(id).facing;
  restored.turn(null, back.actor(id), true);
  assert(again.until(() => back.actor(id).facing === -facing && !restored.record(back.actor(id)).service, 7));
  assert(resources(again).fuel.every(value => value === 0)); assert(resources(again).rounds.every(value => value === 0), 'turning does not reset ammunition');
  const exhausted = JSON.parse(JSON.stringify(restored.keep())), last = onField(t, rehearsal([-2000], undefined, { kept: exhausted }));
  assert.deepEqual(resources(last), resources(again)); assert.equal(last.world.actor(id).facing, back.actor(id).facing);
  assert.equal(last.room.serials.c, serial); assert.deepEqual([...room.faults, ...restored.faults, ...last.room.faults], []);
  t.diagnostic(JSON.stringify({ guardian: id, muzzle: shot, nativeContacts: inputs.filter(input => input.contact?.detected).length, outside, furthestGoal, returnedTo: world.actor(id).vehicle.x - dropX, resourcesBeforeSave: keptResources }));
});

// Each encounter publishes the ordinary M2HB scout before arrival. Poses are set only during fixture setup;
// after guardian arrival, perception, movement, aiming, the timed turn and muzzle publication are real.
function guardianEncounter(t, targetOffset) {
  let dropX = 0;
  const f = onField(t, rehearsal([-2000])), { room, world, ground } = f;
  dropX = Array.from({ length: 101 }, (_, i) => i * 20 - 1000)
    .find(x => [-160, -140, -40, 40, 140, 160].every(dx => Math.abs(ground.height(x + dx) - ground.height(x)) < 4));
  assert(Number.isFinite(dropX), 'the encounter needs ordinary level ground, without editing terrain');
  const player = room.join('Guardian encounter'), target = f.publish(player, 'scout', { facing: 1 });
  f.order(player, 'control', { id: target }); f.put(target, dropX + targetOffset);
  room.activities = { nextId: 2, nextAt: world.time + AIRDROP.interval,
    drop: { id: 'airdrop:1', x: dropX, stock: 4000, arrivesAt: world.time + .2, expiresAt: world.time + AIRDROP.collect } };
  spawnGuardian(room); // The encounter is authored before stepping, not a second birth when the cargo arrives.
  assert(f.until(() => room.guardianSquad, 1));
  const id = room.activities.drop.guardianId, squad = room.guardianSquad, side = squad.side, unit = squad.units.get(id),
    actor = () => world.actor(id), service = () => room.record(actor()).service,
    resources = () => ({ fuel: f.parts(id, 'fuel').reduce((sum, m) => sum + m.fuelLitres, 0),
      rounds: f.parts(id, 'ammo').reduce((sum, m) => sum + m.rounds, 0) }),
    inputs = [], input = side.input.bind(side);
  side.input = (actorId, action, decision) => {
    const accepted = input(actorId, action, decision);
    if (decision) inputs.push({ at: world.time, targetId: action.targetId, reason: action.diagnostics?.reason,
      contact: action.contact && { ...action.contact }, goal: unit.move?.x ?? null });
    return accepted;
  };
  const muzzle = events => events.some(event => event.type === 'muzzle' && event.actorId === id);
  return { ...f, dropX, target, id, squad, side, unit, actor, service, resources, inputs, muzzle };
}

function guardianInputSummary(inputs) {
  const reasons = {}, compact = input => ({ at: input.at, targetId: input.targetId, reason: input.reason, goal: input.goal,
    contact: input.contact && { detected: input.contact.detected, confidence: input.contact.confidence, age: input.contact.age,
      channel: input.contact.channel || input.contact.source, x: input.contact.x, y: input.contact.y } });
  for (const input of inputs) reasons[input.reason || 'none'] = (reasons[input.reason || 'none'] || 0) + 1;
  return { count: inputs.length, reasons, first: inputs.slice(0, 2).map(compact), last: inputs.slice(-2).map(compact) };
}

test('F3 guardian: the live event anchors travel, physical map bounds aiming, and the existing base veto remains', () => {
  const drop = { guardianId: 'g', x: 500 }, bounds = { minX: -10000, maxX: 10000 };
  let bases = [-2000];
  const room = { world: { bounds }, activities: { drop }, bases: () => bases }, side = new GuardianSide(room);
  assert.strictEqual(side.arenaBounds, bounds, 'the patrol leash is not the weapon arena');
  assert.deepEqual(side.freeFireRegion('g'), { anchor: 500, radius: GUARDIAN.leash, home: true });
  assert.equal(side.freeFireRegion('other'), null);
  drop.x = 700;
  assert.deepEqual(side.freeFireRegion('g'), { anchor: 700, radius: GUARDIAN.leash, home: true }, 'resume derives the event anchor, without another saved coordinate');
  for (const sign of [-1, 1]) {
    bases = [drop.x + sign * 250]; assert.equal(side.freeFireRegion('g'), null, 'the existing 250 m base veto still applies on either side');
    bases = [drop.x + sign * 250.01]; assert(side.freeFireRegion('g'));
  }
  delete room.activities.drop; assert.equal(side.freeFireRegion('g'), null, 'withdrawal leaves no patrol objective');
});

test('F3 guardian: a real front contact beyond the travel region can produce an ordinary finite M2HB muzzle', t => {
  const f = guardianEncounter(t, -150), { world, id, dropX, inputs, resources, muzzle } = f,
    before = resources(), began = world.time;
  world.drainEvents(); let fired = false;
  const shot = f.until(() => { fired ||= muzzle(world.drainEvents()); return fired; }, 8);
  t.diagnostic(JSON.stringify({ guardianOutsidePatrol: { id, shot, began, ended: world.time, before, after: resources(), inputs: guardianInputSummary(inputs) } }));
  assert(inputs.some(input => input.targetId === f.target && input.contact?.detected && input.contact.age < 1 &&
    ['visual', 'radar'].includes(input.contact.channel || input.contact.source) && Math.abs(input.contact.x - dropX) > GUARDIAN.leash),
  'the actual Native sensors, not a synthetic contact, place the human vehicle outside the movement region');
  assert(shot, 'the actual gun publishes a new muzzle; widening a movement order alone is not sufficient');
  assert(resources().rounds < before.rounds); assert(resources().fuel <= before.fuel);
  assert(inputs.every(input => input.goal === null || Math.abs(input.goal - dropX) <= GUARDIAN.leash - 20 + 1e-6));
  assert.equal(world.actor(id).ownerId, null); assert.equal(world.actors.filter(actor => actor.id === id).length, 1);
  assert.deepEqual([...f.room.faults], []);
});

test('F3 guardian: a rear contact after damage uses the normal timed firing turn, and another hit cancels that turn', t => {
  const f = guardianEncounter(t, 100), { room, world, id, squad, actor, service, resources, inputs } = f,
    gun = f.parts(id, 'weapon')[0], target = world.actor(f.target),
    point = { x: target.vehicle.x, y: target.vehicle.y + 1 },
    settings = weaponSettings('machinegun', { preset: gun.weaponPreset, trajectory: 'low', charge: 'auto' }),
    facing = actor().facing, before = resources();
  assert.equal(gun.weaponPreset, 'm2hb'); assert.equal(settings.trajectory, 'low');
  // The ordinary pilot tries the catalogue's low arc. Unlike a direct preview, this invokes the
  // canonical intercept and real mount-sector test used by Squad.lay; no weapon sector is changed.
  const current = firingSolution(gun, point, settings), reversed = firingSolution(turnedLauncher(actor(), gun), point, settings),
    summary = solution => ({ reachable: solution.reachable, angle: solution.angle, limit: solution.limit, miss: solution.miss });
  t.diagnostic(JSON.stringify({ guardianRearGeometry: { id, facing, point, mount: { angle: gun.angle, min: gun.weaponMount.min, max: gun.weaponMount.max },
    current: summary(current), reversed: summary(reversed) } }));
  assert.equal(current.reachable, false, 'the current mount has no low-arc solution behind it');
  assert.equal(reversed.reachable, true, 'the reflected real mount has a canonical low-arc solution after turning');
  room.survey(); squad.sampled = null; squad.sample();
  // A small explicit part-health loss exercises the same wear/hit path without inventing a shooter contact.
  const hit = () => {
    const engine = f.parts(id, 'engine')[0]; f.set(engine, { health: engine.health - .5 }); world.sync();
    room.survey(); squad.sampled = null; squad.sample();
  };
  hit(); assert.equal(room.calm(actor()), false); assert(f.unit.alertUntil > world.time);
  assert(f.until(() => inputs.some(input => input.targetId === f.target && input.reason === 'no-ballistic-solution' &&
    input.contact?.detected && input.contact.confidence >= .32 && input.contact.age < 1 &&
    ['visual', 'radar'].includes(input.contact.channel || input.contact.source)), 1),
  'the actual Native decision must place this rear human contact and reject the current gun solution before a turn is required');
  const turning = f.until(() => service()?.kind === 'turn', 2);
  t.diagnostic(JSON.stringify({ guardianRearTurn: { id, turning, at: world.time, facing: actor().facing,
    service: structuredClone(service()), alertUntil: f.unit.alertUntil, inputs: guardianInputSummary(inputs) } }));
  assert(turning, 'a valid firing turn is attempted despite the ordinary post-hit alert');
  assert(inputs.some(input => input.targetId === f.target && input.contact?.detected && input.contact.age < 1 &&
    ['visual', 'radar'].includes(input.contact.channel || input.contact.source)));
  assert.equal(actor().facing, facing); assert(service().until >= world.time + TURN_SECONDS - .1, 'the ordinary five seconds remain');
  f.run(1); hit();
  assert.equal(service(), null, 'damage during the five seconds cancels the existing field service');
  assert.equal(actor().facing, facing, 'cancellation cannot instantaneously flip the vehicle');
  assert(f.until(() => service()?.kind === 'turn', 2), 'with the contact still valid, an ordinary later attempt may begin');
  const until = service().until;
  f.run(Math.max(0, until - world.time - .2));
  assert.equal(actor().facing, facing); assert.equal(service()?.kind, 'turn');
  assert(f.until(() => actor().facing === -facing, 1), 'only completion of the full service changes facing');
  world.drainEvents(); let fired = false;
  assert(f.until(() => { fired ||= f.muzzle(world.drainEvents()); return fired; }, 8), 'real Native perception and the turned gun then publish a muzzle');
  assert(resources().rounds < before.rounds); assert(resources().fuel <= before.fuel);
  assert.equal(world.actors.filter(value => value.id === id).length, 1, 'turning does not mint a second guardian');
  assert.deepEqual([...room.faults], []);
});

test('F3 guardian: cold resume reclassifies a legacy automatic move without resetting progress, stance or finite resources', t => {
  const f = guardianEncounter(t, -150), { room, world, id, squad, unit, dropX } = f;
  squad.command({ order: 'move', ids: [id], x: dropX - 80 });
  delete unit.move.purpose; unit.move.since = world.time - .75;
  const leg = structuredClone(unit.move), before = f.resources(), serial = room.serials.c,
    kept = JSON.parse(JSON.stringify(room.keep())),
    again = onField(t, rehearsal([-2000], undefined, { kept })),
    restored = again.room.guardianSquad.units.get(id), saved = again.room.keep().activities.orders.find(([actorId]) => actorId === id)[1];
  assert.deepEqual(restored.move, { ...leg, purpose: 'fire' }, 'the old goal, best distance, since and braking state are not recaptured');
  assert.deepEqual([restored.stance, restored.halt], [unit.stance, unit.halt]);
  assert.deepEqual(saved.move, restored.move); assert.equal(again.world.time, world.time);
  assert.equal(again.room.serials.c, serial); assert.equal(again.world.actors.filter(actor => actor.id === id).length, 1);
  assert.deepEqual({ fuel: again.parts(id, 'fuel').reduce((sum, m) => sum + m.fuelLitres, 0),
    rounds: again.parts(id, 'ammo').reduce((sum, m) => sum + m.rounds, 0) }, before);
  assert.deepEqual(again.room.guardianSquad.side.freeFireRegion(id), { anchor: dropX, radius: GUARDIAN.leash, home: true });
  assert(!Object.hasOwn(saved, 'anchor'), 'drop.x is the sole guardian anchor');
});

test('F3 guardian: current automatic move survives cold JSON and an exact Photo without resetting its progress clock', nativePhotoOnly, t => {
  const f = guardianEncounter(t, -150), { room, world, id, squad, unit, dropX } = f;
  // This declared checkpoint state is a current automatic leg; its progress need not be zero at a cut.
  squad.command({ order: 'move', ids: [id], x: dropX - 80 });
  Object.assign(unit.move, { purpose: 'fire', since: world.time - .75 });
  const leg = structuredClone(unit.move), kept = JSON.parse(JSON.stringify(room.keep())),
    cold = onField(t, rehearsal([-2000], undefined, { kept })),
    keptAgain = JSON.parse(JSON.stringify(cold.room.keep()));
  assert.deepEqual(cold.room.guardianSquad.units.get(id).move, leg);
  assert.deepEqual(keptAgain.activities.orders, kept.activities.orders);
  const coldAgain = onField(t, rehearsal([-2000], undefined, { kept: keptAgain }));
  assert.deepEqual(coldAgain.room.guardianSquad.units.get(id).move, leg, 'another checkpoint does not renew the eight-second progress budget');
  // Photo restores the complete Squad object graph, rather than calling resumeGuardian. Remove only the
  // test observer (a function the ordinary serializer correctly refuses) before taking that exact graph.
  delete f.side.input;
  const photo = writeField(room, new Publication()), back = onField(t, rehearsal([-2000]));
  readField(back.room, photo);
  assert.deepEqual(back.room.guardianSquad.units.get(id).move, leg);
  assert.equal(back.room.digest(), room.digest());
  for (let step = 0; step < 60; step++) { room.step(); back.room.step(); }
  assert.equal(back.room.digest(), room.digest(), 'the exact Photo continues the same ordinary decision sequence');
  assert.deepEqual(back.room.guardianSquad.units.get(id).move, room.guardianSquad.units.get(id).move);
  assert.deepEqual([...room.faults, ...back.room.faults, ...cold.room.faults, ...coldAgain.room.faults], []);
});


test('F2 guardian: unsupported manufacture is refused before mint, actor, stock or event identity changes', t => {
  const f = onField(t, rehearsal([-1000])), { room, world } = f, alice = room.join('Alice'),
    drop = { id: 'airdrop:1', x: 0, stock: 4000, arrivesAt: world.time, expiresAt: world.time + AIRDROP.collect };
  room.activities = { nextId: 2, nextAt: AIRDROP.interval, drop };
  const normal = room.validateDesign.bind(room), before = structuredClone(room.keep());
  room.validateDesign = source => {
    const unsupported = structuredClone(normal(source)); unsupported.components.find(piece => piece.kind === 'command').pose.y = 100;
    return unsupported;
  };
  try { assert.throws(() => spawnGuardian(room), error => error.reason === 'PHYSICAL_SUPPORT'); }
  finally { delete room.validateDesign; }
  assert(isDeepStrictEqual(room.keep(), before), 'the same manufacture50 gate runs before the new actor transaction');
  assert.equal(drop.guardianId, undefined); assert.equal(world.actors.length, 0); assert.equal(room.guardianSquad, null);
  spawnGuardian(room); const id = drop.guardianId; spawnGuardian(room);
  assert.equal(world.actors.length, 1); assert.equal(world.actor(id).ownerId, null); assert.equal(room.players.size, 1); assert.equal(room.factions.size, 1);
  assert.deepEqual(room.faction(room.players.get(alice.playerId)).stock, alice.faction.stock);
});

// Native chooses the attachment material. The fixture only stands two real chassis within reach,
// with a two-metre gap between their actual frame ends, and lets their suspension settle.
function towField(t) {
  const f = onField(t, rehearsal([0, 3000, -3000])), { room, world } = f, alice = room.join('Alice'),
    tug = f.publish(alice, 'truck'), target = f.publish(alice, 'supply'),
    span = id => world.plates.filter(p => p.actorId === id && p.definition.chassis?.part === 'frame')
      .reduce((a, p) => ({ min: Math.min(a.min, p.bounds.minX), max: Math.max(a.max, p.bounds.maxX) }), { min: Infinity, max: -Infinity });
  f.send(alice, 'auto', { actorId: target, on: false });
  f.put(tug, 0);
  f.put(target, world.actor(target).vehicle.x + span(tug).min - 2 - span(target).max);
  return { ...f, alice, tug, target, seat: room.players.get(alice.playerId),
    tow: (act = 'attach', actorId = tug, targetId = target) => f.send(alice, 'tow', { act, actorId, ...(act === 'attach' ? { targetId } : {}) }) };
}

test('a basic tow preserves the tug controls, releases a damaged worker and detaches without reviving its job', t => {
  const f = towField(t), { room, world, alice, tug, target, seat, tow } = f,
    targetUnit = seat.squad.units.get(target), targetEngine = f.parts(target, 'engine')[0], wheel = f.parts(target, 'wheel')[0];
  f.send(alice, 'auto', { actorId: target, on: true });
  f.order(alice, 'move', { ids: [target], x: world.actor(target).vehicle.x - 30 });
  f.set(targetEngine, { health: 0 }); f.set(wheel, { health: wheel.maxHealth / 2 });
  f.order(alice, 'control', { id: tug });
  assert(!room.outOfAction()[target], 'lost propulsion is repairable, rather than an intangible wreck');
  assert.deepEqual(tow(), { towing: true });
  assert.equal(seat.squad.manual, tug); assert.equal(room.record(world.actor(target)).auto, false);
  assert.deepEqual([targetUnit.move, targetUnit.attack, targetUnit.haul, targetUnit.fireAt], [null, null, null, null]);
  assert.equal(world.actor(target).vehicle.throttle, 0); assert.equal(world.actor(target).vehicle.brake, 0);
  f.send(alice, 'drive', { actorId: tug, throttle: 1, brake: 0 }); f.run(.1);
  assert(world.actor(tug).vehicle.throttle > 0, 'the cable does not put the tug in the global held state');
  assert.equal(world.actor(target).vehicle.throttle, 0); assert.equal(world.actor(target).vehicle.brake, 0, 'queued pilots cannot park the towed target');
  const stock = structuredClone(room.faction(seat).stock);
  for (const command of [
    () => f.order(alice, 'control', { id: target }),
    () => f.order(alice, 'move', { ids: [target], x: 30 }),
    () => f.send(alice, 'auto', { actorId: target, on: true }),
    () => f.send(alice, 'repair', { actorId: target }),
    () => f.order(alice, 'turn', { ids: [tug] }),
  ]) assert.throws(command, /cabo|rebocad/i);
  assert.deepEqual(room.faction(seat).stock, stock, 'a refused repair is never charged');
  f.order(alice, 'control', { id: null });
  f.order(alice, 'move', { ids: [tug], x: 30 });
  const move = structuredClone(seat.squad.units.get(tug).move), cold = structuredClone(room.keep().scene.tows[0]),
    engine = f.parts(tug, 'engine')[0];
  // Actual Native inputs describe a pair already moving, with the tug's motor now damaged. Repeating
  // a successful attachment must not revalidate new-hitch speed/motor or recapture either endpoint.
  for (const id of [tug, target]) world.command('setVehicleState', { actorId: id, state: { vx: .8 } });
  f.set(engine, { health: 0 });
  assert.deepEqual(tow(), { towing: true });
  assert.deepEqual(seat.squad.units.get(tug).move, move); assert.deepEqual(room.keep().scene.tows[0], cold);
  f.order(alice, 'stop', { ids: [tug] }); f.run(.1);
  assert.equal(world.tows.length, 1, 'Stop brakes the tug without detaching'); assert.equal(world.actor(tug).vehicle.brake, 1);
  assert.equal(room.record(world.actor(target)).service, null, 'automatic repair does not replace an attached body');
  const before = { ...world.actor(target).vehicle }, paid = structuredClone(room.faction(seat).stock);
  assert.deepEqual(tow('detach', target), { towing: false });
  const after = world.actor(target).vehicle;
  assert.deepEqual([after.x, after.y, after.vx, after.vy], [before.x, before.y, before.vx, before.vy], 'detach preserves current pose and momentum');
  assert.equal(after.brake, 1); assert.equal(after.throttle, 0); assert.deepEqual(world.tows, []);
  assert.equal(room.record(world.actor(target)).auto, false); assert.equal(targetUnit.move, null);
  assert.deepEqual(room.faction(seat).stock, paid, 'a cable neither repairs nor spends a service bill');
  assert.deepEqual(tow('detach'), { towing: false }); assert.deepEqual([...room.faults], []);
});

test('tow authority refuses foreign, occupied and servicing targets atomically, and publishes cables only to their faction', t => {
  const f = towField(t), { room, world, alice, tug, target, seat, tow } = f, ally = room.join('Bia'), enemy = room.join('Caio'),
    foreign = f.publish(enemy, 'truck'), proof = () => JSON.parse(JSON.stringify({
      owners: world.actors.map(a => [a.id, a.ownerId]), stock: room.faction(seat).stock,
      reserved: [...room.reserved], orders: [...room.players].map(([id, p]) => [id, p.squad.manual, [...p.squad.units]]),
      auto: [...room.records].map(([id, r]) => [id, r.auto, r.service]), tows: world.tows,
    }));
  let before = proof(); assert.throws(() => tow('attach', tug, foreign), /facção|campo/); assert.deepEqual(proof(), before);
  f.send(alice, 'invite', { playerId: ally.playerId }); f.send(ally, 'join-faction', { factionId: alice.faction.id });
  f.order(alice, 'free', { ids: [tug, target] }); f.order(ally, 'control', { id: target });
  assert.equal(room.reserved.has(tug), false, 'the tug is free before an occupied-target refusal');
  before = proof(); assert.throws(() => tow(), /está com Bia/); assert.deepEqual(proof(), before, 'no partial claim of the tug');
  f.order(ally, 'free', { ids: [target] }); f.order(alice, 'turn', { ids: [target] });
  before = proof(); assert.throws(() => tow(), /virando|virar/i); assert.deepEqual(proof(), before, 'a real timed service stays untouched');
  f.run(TURN_SECONDS + .2);
  assert(f.until(() => [tug, target].every(id => {
    const v = world.actor(id).vehicle;
    return Math.hypot(v.vx, v.vy) < .1 && Math.abs(v.omega) < .01;
  }), 5), 'the newly turned body and its real suspension must settle before hitching');
  assert.deepEqual(tow(), { towing: true });
  const publication = new Publication(), view = factionId => {
    const state = world.snapshot(s => publication.state(s));
    return room.audience(state, chapters(state), [], factionId).state;
  }, own = view(alice.faction.id), other = view(enemy.faction.id), writer = new FrameWriter(), reader = new FrameReader();
  t.after(() => writer.close());
  assert.equal(own.tows.length, 1); assert.deepEqual(other.tows, []);
  assert.deepEqual(Object.keys(own.tows[0]).sort(), ['actorId', 'targetId', 'anchorA', 'anchorB', 'length', 'tension', 'limit'].sort());
  const received = reader.decode(writer.encode({ state: own }, true)).state.tows,
    metadata = links => links.map(({ anchorA, anchorB, ...link }) => link);
  assert.deepEqual(metadata(received), metadata(own.tows));
  for (const key of ['anchorA', 'anchorB']) for (const axis of ['x', 'y'])
    assert(Math.abs(received[0][key][axis] - own.tows[0][key][axis]) <= .0001, 'anchors keep the ordinary tenth-millimetre network precision');
  tow('detach');
  assert.deepEqual(reader.decode(writer.encode({ state: view(alice.faction.id) })).state.tows, [], 'the normal delta removes the rope');
  assert.deepEqual([...room.faults], []);
});
