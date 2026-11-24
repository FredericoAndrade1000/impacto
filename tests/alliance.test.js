import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal, asked } from '../server/room.ts';
import { FieldHost, replayField, DIARY } from '../server/field-host.ts';
import { writeField } from '../server/field-snapshot.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { chapters } from '../server/fog.ts';
import { Publication } from '../server/publication.ts';
import { FrameWriter, FrameReader, NETWORK_VERSION } from '../src/network-protocol.ts';
import { CORE_CONTRACT, nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import { ALLIANCE_TERMS } from '../src/faction-social.ts';
import { contains } from '../src/ground-sight.ts';
import { packShots, SHOT_WORDS, SHOT_X } from '../src/shots.ts';
import { onField } from './helpers/field.js';

const BASES = [0, 20000, 40000, 60000];
function field(t) {
  const f = onField(t, rehearsal(BASES)), players = ['Ana', 'Bia', 'Caio', 'Duda'].map(name => f.room.join(name)),
    send = (p, data) => f.room.command(p.playerId, data),
    propose = (from, to) => send(from, { type: 'accord', act: 'propose', ref: to.faction.ref, kind: 'alliance' }).proposed,
    ally = (from, to) => { const id = propose(from, to); send(to, { type: 'accord', act: 'accept', id, kind: 'alliance' }); return id; };
  return { ...f, players, send, propose, ally };
}

test('only explicit bilateral alliance consent grants intelligence, with current faction roles and no reciprocal implicit accept', t => {
  const { room, players: [ana, bia, caio, duda], send, propose } = field(t), a = ana.faction.id, b = bia.faction.id;
  const declaration = send(ana, { type: 'accord', act: 'propose', ref: bia.faction.ref, text: 'Aliança e livre passagem.' }).proposed;
  assert.throws(() => send(bia, { type: 'accord', act: 'accept', id: declaration, kind: 'alliance' }), /tipo de acordo/);
  send(bia, { type: 'accord', act: 'accept', id: declaration });
  assert(!room.allied(a, b), 'a declaration is not changed by the acceptance payload');
  const id = propose(ana, bia);
  assert.equal(propose(bia, ana), id); assert.equal(room.accords.get(id).acceptedAt, null);
  assert.equal(room.accords.get(id).text, ALLIANCE_TERMS);
  assert.throws(() => send(bia, { type: 'accord', act: 'accept', id }), /tipo de acordo/);
  assert.throws(() => send(caio, { type: 'accord', act: 'accept', id }), /não está disponível/);
  send(bia, { type: 'invite', playerId: duda.playerId }); send(duda, { type: 'join-faction', factionId: b });
  assert.throws(() => send(duda, { type: 'accord', act: 'accept', id }), /líder e os administradores/);
  send(bia, { type: 'member', playerId: duda.playerId, act: 'admin' });
  send(duda, { type: 'accord', act: 'accept', id, kind: 'alliance' }); assert(room.allied(a, b));
  send(bia, { type: 'member', playerId: duda.playerId, act: 'member' });
  assert.throws(() => send(duda, { type: 'accord', act: 'end', id }), /líder e os administradores/);
  assert.throws(() => send(bia, { type: 'accord', act: 'accept', id }), /não está disponível/);
  send(ana, { type: 'accord', act: 'end', id }); assert(!room.allied(a, b));
  assert.throws(() => send(bia, { type: 'accord', act: 'end', id }), /não está disponível/);
  assert.deepEqual(asked({ type: 'accord', act: 'propose', ref: bia.faction.ref, kind: 'alliance', pairs: [[a, caio.faction.id]] }),
    { type: 'accord', act: 'propose', ref: bia.faction.ref, kind: 'alliance' });
});

test('alliance publication grants actual sight and terrain, then freezes the last exterior immediately while private authority remains unchanged', t => {
  const { room, world, players: [ana, bia, caio, duda], publish, order, put, run, send, ally } = field(t),
    own = publish(ana, 'heavy'), relay = publish(bia, 'heavy'), enemy = publish(caio, 'heavy');
  for (const [p, id] of [[ana, own], [bia, relay], [caio, enemy]]) order(p, 'control', { id });
  put(enemy, world.actor(relay).vehicle.x + 30); run(.5); room.look();
  assert.equal(room.knows(bia.faction.id, world.actor(enemy)), 'seen', 'fixture: the ally actually sees the target');
  assert.notEqual(room.knows(ana.faction.id, world.actor(enemy)), 'seen');
  const publication = new Publication(), writer = new FrameWriter(), reader = new FrameReader(),
    shown = p => {
      const state = publication.state(world.snapshot()); state.shared = true; state.players = room.roster();
      return room.audience(state, chapters(state), [], p.faction.id).state;
    }, id = ally(ana, bia), current = shown(ana), target = current.actors.find(a => a.id === enemy),
    first = reader.decode(writer.encode({ state: current }, true)).state;
  assert(target && !target.ghost); assert(first.actors.some(a => a.id === enemy));
  assert(contains(room.factions.get(ana.faction.id).explored, target.vehicle.x));
  assert(current.sharedEyes.length); assert(current.sharedEyes.every(eye => Object.keys(eye).sort().join(',') === 'left,right,x,y'));
  assert(!shown(duda).actors.some(a => a.id === enemy), 'a third faction receives no alliance view');
  const external = current.modules.filter(m => m.actorId === enemy);
  assert(external.length && !external.some(m => ['engine', 'fuel', 'ammo', 'command'].includes(m.kind)));
  assert(external.every(m => !('rounds' in m) && !('fuelLitres' in m) && !('reload' in m) && !('loaded' in m) && !('feedReload' in m) && !(m.barrelTemperature > 0)));
  assert(!('eyes' in target) && !('fuelLitres' in target.vehicle));
  assert.equal(world.actor(own).team, ana.faction.id); assert.equal(world.actor(relay).team, bia.faction.id);
  assert.equal(room.usable(room.players.get(ana.playerId), world.actor(relay)), false);
  assert.throws(() => send(ana, { type: 'blueprint', actorId: relay }), /outra facção/);
  const explored = JSON.stringify(room.factions.get(ana.faction.id).explored), x = target.vehicle.x;
  send(ana, { type: 'accord', act: 'end', id });
  const damaged = world.modules.find(m => m.actorId === enemy && external.some(piece => piece.id === m.id)), oldHealth = damaged.health,
    tick = world.tick;
  world.game().call({ op: 'setVehicleState', actorId: enemy, state: { x: x + 40 } });
  world.game().call({ op: 'setPartState', owner: world.game().handle(damaged), state: { health: 0 } });
  assert.equal(world.tick, tick); assert.equal(world.actor(enemy).vehicle.x, x + 40); assert.equal(damaged.health, 0);
  const revoked = shown(ana), ghost = revoked.actors.find(a => a.id === enemy), delta = reader.decode(writer.encode({ state: revoked })).state;
  assert.equal(room.knows(ana.faction.id, world.actor(enemy)), 'ghost', 'revocation does not wait for SIGHT_GRACE');
  assert(ghost.ghost); assert.equal(ghost.vehicle.x, x); assert(Math.abs(delta.actors.find(a => a.id === enemy).vehicle.x - x) <= 5e-5);
  assert.equal(revoked.modules.find(m => m.id === damaged.id).health, oldHealth, 'hidden damage does not refresh a frozen exterior');
  assert.deepEqual(revoked.sharedEyes, []); assert.deepEqual(delta.sharedEyes, []);
  assert.equal(JSON.stringify(room.factions.get(ana.faction.id).explored), explored);
  const back = new FrameReader().decode(new FrameWriter().encode({ state: shown(ana) }, true)).state;
  assert(Math.abs(back.actors.find(a => a.id === enemy).vehicle.x - x) <= 5e-5, 'a new reader receives only frozen memory');
  writer.close();
});

test('accepted alliances resume from additive checkpoint records and replay from an origin or Native binary segment without changing declarations', async t => {
  const field = { bases: BASES }, host = new FieldHost(rehearsal(BASES), { field }); t.after(() => host.room.field.dispose());
  const ana = host.join('Ana'), bia = host.join('Bia'),
    legacy = host.command(ana.playerId, { type: 'accord', act: 'propose', ref: bia.faction.ref, text: 'Aliança declarada, sem efeito automático.' }).proposed;
  host.command(bia.playerId, { type: 'accord', act: 'accept', id: legacy });
  const id = host.command(ana.playerId, { type: 'accord', act: 'propose', ref: bia.faction.ref, kind: 'alliance' }).proposed;
  host.command(bia.playerId, { type: 'accord', act: 'accept', id, kind: 'alliance' });
  const checkpoint = JSON.parse(JSON.stringify(host.room.keep())), resumed = rehearsal(BASES, undefined, { kept: checkpoint });
  t.after(() => resumed.field.dispose()); assert(resumed.allied(ana.faction.id, bia.faction.id));
  assert.equal(resumed.accords.get(legacy).kind, undefined); assert.equal(resumed.accords.get(legacy).text, checkpoint.accords.find(a => a.id === legacy).text);
  assert(['native', 'wasm'].includes(nativeDynamicsRuntime));
  if (nativeDynamicsRuntime === 'native') assert.equal(typeof host.room.field.dynamics.core.export_state, 'function');
  const versions = { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT },
    start = [...host.lines], snapshot = nativeDynamicsRuntime === 'native' ? writeField(host.room, host.publication) : null;
  host.lines.length = 0;
  host.command(bia.playerId, { type: 'accord', act: 'end', id });
  const segments = [[JSON.stringify({ ...versions, field, origin: null }), ...start, ...host.lines]];
  // Whole binary snapshots are intentionally a Native host API (lib.rs); JSON checkpoints and origin replay serve both runtimes.
  if (snapshot) segments.push([JSON.stringify({ ...versions, field, origin: null, snapshot }), ...host.lines]);
  for (const lines of segments) {
    const again = await replayField(lines); t.after(() => again.host.room.field.dispose());
    assert.equal(again.how, 'end', again.got); assert.equal(again.host.room.digest(), host.room.digest());
    assert(!again.host.room.allied(ana.faction.id, bia.faction.id));
  }
  const damaged = structuredClone(checkpoint); damaged.accords[0].kind = 'unknown';
  assert.throws(() => rehearsal(BASES, undefined, { kept: damaged }), /acordos inválidos/);
  assert.equal(checkpoint.accords.find(a => a.id === id).kind, 'alliance'); assert.equal(checkpoint.accords.find(a => a.id === legacy).kind, undefined);
});

test('base radar and sound reports share only direct source books, keep anonymous ids and revoke before a new same-tick fix', t => {
  const { room, world, players: [ana, bia, caio, duda], publish, ally, send } = field(t),
    a = ana.faction.id, b = bia.faction.id, c = caio.faction.id, d = duda.faction.id,
    partner = publish(bia, 'heavy'), time = world.time,
    round = (number, actorId, x) => ({ number, actorId, weapon: 'cannon', preset: 'm119', x: x - 30, y: 6.5, vx: -300, vy: 50, age: .1 }),
    shots = packShots([round(1, partner, 6000), round(2, 'enemy-b', 26000), round(3, 'enemy-c', 46000)]),
    bases = [[a, 0], [b, 20000], [c, 40000]].map(([team, x]) => ({ team, x, y: 0 })),
    teamOf = id => id === partner ? b : d,
    look = block => room.watch.look({ shots: block, bases, terrain: { height: () => 0 }, teamOf, time });
  look(shots); const own = room.watch.marks(a, time); assert.equal(own.length, 1);
  const id = ally(ana, bia); ally(bia, caio);
  const publication = new Publication(), shown = block => {
    const state = publication.state(world.snapshot()); state.shots = block;
    return room.audience(state, chapters(state), [], a).state;
  }, current = shown(shots), shared = current.contacts.filter(c => c.kind === 'battery'),
    xs = state => Array.from({ length: state.shots.data.length / SHOT_WORDS }, (_, index) => state.shots.data[index * SHOT_WORDS + SHOT_X]);
  assert.equal(room.batteryMarks(a, time).length, 2);
  assert(shared.some(mark => mark.id.startsWith(`battery:${bia.faction.ref}:`)));
  assert(!shared.some(mark => mark.id.startsWith(`battery:${caio.faction.ref}:`)), 'B cannot relay its access to C');
  assert(shared.every(mark => Object.keys(mark).sort().join(',') === 'at,by,error,id,kind,x'));
  assert.deepEqual(xs(current).sort((x, y) => x - y), [5970, 25970]);
  assert(!current.shots.kinds.some(kind => 'actorId' in kind || 'weapon' in kind));
  assert.equal(room.batteryMarks(a, time, null, true).length, 1, 'an ally is omitted from automatic counterbattery only');
  // A grenade heard at the allied base is due this very tick, but reaches its report book on the next look.
  const echo = packShots([{ number: 10, actorId: 'sound-only', weapon: 'grenade', preset: 'mk19', x: 19970, y: 0, vx: -300, vy: 0, age: .1 }]);
  look(echo); assert(!room.watch.marks(b, time).some(mark => mark.by === 'sound'));
  send(ana, { type: 'accord', act: 'end', id });
  const moved = packShots([round(4, 'enemy-b', 26500)]); look(moved);
  assert(room.watch.marks(b, time).some(mark => mark.by === 'sound'), 'the source did receive a new same-tick sound report after revocation');
  const after = shown(moved);
  assert.deepEqual(after.contacts.filter(c => c.kind === 'battery'), own, 'the faction keeps its independently measured reports');
  assert.deepEqual(xs(after), []); assert.equal(room.batteryMarks(a, time, null, true).length, 1);
});

test('accepting between round portions cancels applied automatic fire and rechecks queued acquisition while preserving explicit and manual authority', t => {
  const { room, world, players: [ana, bia], publish, order, put, run, ally } = field(t),
    first = publish(ana, 'heavy'), queued = publish(ana, 'heavy'), explicit = publish(ana, 'heavy'), partner = publish(bia, 'heavy'),
    squad = room.players.get(ana.playerId).squad;
  order(ana, 'control', { id: first }); order(bia, 'control', { id: partner });
  put(queued, world.actor(first).vehicle.x - 30); put(explicit, world.actor(first).vehicle.x - 60);
  put(partner, world.actor(first).vehicle.x + 40); run(.5); room.look();
  order(ana, 'control', { id: null }); order(ana, 'stance', { ids: [first], stance: 'fire' });
  order(ana, 'attack', { ids: [explicit], targetId: partner });
  room.round = room.steps; room.step({ pace: () => 1 }); assert.equal(room.dealing.done, 1);
  assert.equal(squad.units.get(first).targetId, partner);
  const dealing = room.dealing, manual = room.players.get(bia.playerId).squad.manual;
  ally(ana, bia);
  assert.equal(room.dealing, dealing, 'permission changes invalidate the existing sample without inventing another cadence');
  assert.equal(squad.units.get(first).targetId, null);
  assert.equal(room.players.get(bia.playerId).squad.manual, manual);
  room.step({ pace: () => 1 }); assert.equal(room.dealing, null);
  assert.equal(squad.units.get(queued).targetId, null);
  assert.equal(squad.units.get(explicit).attack.targetId, partner); assert.equal(squad.units.get(explicit).targetId, null, 'the explicit order is retained while an allied contact is not an automatic target');
  assert.deepEqual([...room.faults], []);
});

test('ending between round portions makes the queued explicit pilot use received memory, with no new enemy pose from the former source', t => {
  const { room, world, players: [ana, bia, caio], publish, order, put, run, ally, send } = field(t),
    first = publish(ana, 'heavy'), queued = publish(ana, 'heavy'), relay = publish(bia, 'heavy'), enemy = publish(caio, 'heavy');
  order(ana, 'control', { id: first }); order(bia, 'control', { id: relay }); order(caio, 'control', { id: enemy });
  put(queued, world.actor(first).vehicle.x - 30); put(enemy, world.actor(relay).vehicle.x + 30); run(.5);
  const id = ally(ana, bia); order(ana, 'control', { id: null }); order(ana, 'attack', { ids: [queued], targetId: enemy });
  const game = world.game(), call = game.call.bind(game), answers = [];
  game.call = request => {
    const result = call(request);
    if (request.op === 'scriptedDecision' && request.actorId === queued) answers.push(result);
    return result;
  };
  room.round = room.steps; room.step({ pace: () => 1 }); assert.equal(room.dealing.done, 1);
  const before = call({ op: 'scriptedDecision', actorId: queued, targetId: enemy }).contact;
  assert(before.detected && before.visible);
  send(ana, { type: 'accord', act: 'end', id });
  game.call({ op: 'setVehicleState', actorId: enemy, state: { x: world.actor(enemy).vehicle.x + 1000 } });
  room.step({ pace: () => 1 }); assert.equal(room.dealing, null);
  assert.equal(answers.length, 1); assert.equal(answers[0].targetId, enemy);
  assert.equal(answers[0].contact.source, 'memory'); assert.equal(answers[0].contact.visible, false);
  assert.equal(answers[0].contact.x, before.x); assert.equal(answers[0].contact.y, before.y);
  assert.equal(room.players.get(ana.playerId).squad.units.get(queued).attack.targetId, enemy);
  assert.deepEqual([...room.faults], []);
});
