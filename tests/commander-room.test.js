import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { nativePhotoOnly } from './helpers/runtime.js';
import { FieldHost, openRoom, replayField, DIARY } from '../server/field-host.ts';
import { writeField, readField } from '../server/field-snapshot.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { STARTING_STOCK, SHELTER_AWAY } from '../src/economy.ts';
import { factionFieldGuards, isFactionView } from '../src/field-protocol-codec.ts';
import { stepCommanders, validateCommanderState } from '../server/faction-commander.ts';
import { commanderRouteKey, ROUTE_RETRY_SECONDS } from '../server/commander-routes.ts';
import { carriedBy, dumpOf, loadTotal, stow } from '../src/economy.ts';

function field(t, kept = null) {
  const room = openRoom(null, kept);
  t.after(() => room.world.dispose());
  return room;
}
const run = (host, steps) => { for (let i = 0; i < steps; i++) host.step(() => 1); };
const header = room => JSON.stringify({ diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT,
  field: null, origin: null, fieldId: room.fieldId });

test('commander lightening uses the real partial dump, preserves stocks and keeps the ordinary return', t => {
  const room = field(t), bot = room.addCommander('Carga'), state = room.commanders.get(bot.id);
  stepCommanders(room);
  const first = state.history.find(row => row.action?.kind === 'haul').action,
    unit = room.players.get(bot.id).squad.units.get(first.unitId), pieces = room.pieces(first.unitId),
    added = stow(pieces, 'ferro', 2000);
  room.carry(added.changed); assert(added.moved > 0);
  const vehicle = room.world.actor(first.unitId).vehicle, x = vehicle.x + 500;
  room.world.command('setVehicleState', { actorId: first.unitId, state: {
    x, y: room.world.terrain.height(x) + 2, vx: 0, vy: 0,
  } });
  room.sight(room.steps, true);
  unit.move = null; unit.halt = 'stuck-slope'; unit.haul.phase = 'home'; unit.haul.blocked = 'stuck-slope';
  const before = carriedBy(room.pieces(first.unitId)), discarded = loadTotal(dumpOf(before.carried, before.room)),
    stock = { ...room.factions.get(bot.factionId).stock };
  state.nextAt = room.world.time; stepCommanders(room);
  assert.deepEqual(state.history.at(-1).action, { kind: 'dump-cargo', unitId: first.unitId });
  assert.equal(state.history.at(-1).result, 'applied');
  assert.equal(loadTotal(carriedBy(room.pieces(first.unitId)).carried), loadTotal(before.carried) - discarded);
  assert.deepEqual(room.factions.get(bot.factionId).stock, stock);
  assert.equal(unit.haul.phase, 'home'); assert.equal(unit.halt, '');
  assert.equal(state.cooldowns['dump-cargo:' + first.unitId], room.world.time + 180);
  const cold = field(t, room.keep());
  assert.equal(cold.commanders.get(bot.id).cooldowns['dump-cargo:' + first.unitId], state.cooldowns['dump-cargo:' + first.unitId]);
});

test('a lost economic vehicle delays its route across replacements and cold resume, while ordinary removal does not', t => {
  for (const wrecked of [true, false]) {
    const room = field(t), bot = room.addCommander('Renda'), state = room.commanders.get(bot.id);
    stepCommanders(room);
    const first = state.history.find(row => row.action?.kind === 'haul')?.action;
    assert(first, 'the ordinary opening assigns an economic trip');
    if (wrecked) room.wreck(room.world.actor(first.unitId));
    else room.discard(first.unitId);
    state.nextAt = room.world.time; stepCommanders(room);
    const key = commanderRouteKey(first.depositId);
    assert.equal(state.cooldowns[key], wrecked ? room.world.time + ROUTE_RETRY_SECONDS : undefined);
    assert.equal(state.orders[first.unitId], undefined);
    const cold = field(t, room.keep()), restored = cold.commanders.get(bot.id);
    assert.equal(restored.cooldowns[key], state.cooldowns[key]);
    assert.deepEqual(validateCommanderState(restored, cold.world.time), restored, 'resume does not start a new retry interval');
  }
});

test('native danger and physical blockage delay the shared route once rather than renewing it on every decision', t => {
  for (const [halt, wait] of [['enemy-near', ROUTE_RETRY_SECONDS], ['stuck-slope', 600]]) {
  const room = field(t), bot = room.addCommander('Cautela'), state = room.commanders.get(bot.id);
  stepCommanders(room);
  const first = state.history.find(row => row.action?.kind === 'haul')?.action;
  assert(first);
  const unit = room.players.get(bot.id).squad.units.get(first.unitId);
  unit.halt = halt;
  state.nextAt = room.world.time; stepCommanders(room);
  const key = commanderRouteKey(first.depositId), deadline = state.cooldowns[key];
  assert.equal(deadline, room.world.time + wait);
  state.nextAt = room.world.time; stepCommanders(room);
  assert.equal(state.cooldowns[key], deadline);
  }
});

test('a successful strategic withdrawal remembers known route danger before Home replaces the haul', t => {
  for (const scenario of ['danger', 'refused', 'held']) {
    const room = field(t), bot = room.addCommander('Rota'), state = room.commanders.get(bot.id);
    stepCommanders(room);
    const first = state.history.find(row => row.action?.kind === 'haul')?.action;
    assert(first);
    const unit = room.players.get(bot.id).squad.units.get(first.unitId), key = commanderRouteKey(first.depositId);
    assert.equal(unit.halt, '', 'the commander can retreat before the native pilot reports danger');
    // Known risk enters through the same faction boundary as civilian work.
    t.mock.method(room.supplyDispatch, 'perils', () => scenario === 'held' ? [] : [[-50000, 50000]]);
    if (scenario === 'held') state.cooldowns[key] = room.world.time + 90;
    if (scenario === 'refused') {
      const command = room.command.bind(room);
      t.mock.method(room, 'command', (id, request) => {
        if (request.type === 'squad' && request.order === 'home') throw new Error('Return refused');
        return command(id, request);
      });
    }
    state.nextAt = room.world.time; stepCommanders(room);
    assert.deepEqual(state.history.at(-1).action, { kind: 'home', unitId: first.unitId });
    assert.equal(state.history.at(-1).reason, 'retreat');
    assert.equal(state.cooldowns[key], scenario === 'danger' ? room.world.time + ROUTE_RETRY_SECONDS :
      scenario === 'held' ? room.world.time + 90 : undefined,
      'only an applied withdrawal with current known danger starts a new interval');
    assert.deepEqual(state.orders[first.unitId], scenario === 'refused' ? { kind: 'haul', depositId: first.depositId } : { kind: 'home' });
  }
});

test('a commander has ordinary stocks and starter vehicles, real presence and no reconnectable socket seat', t => {
  const room = field(t), bot = room.addCommander('Comandante', 'balanced'), player = room.players.get(bot.id),
    faction = room.factions.get(bot.factionId), human = room.join('Jogador');
  assert.deepEqual(Object.keys(bot).sort(), ['enabled', 'factionId', 'id']);
  assert.deepEqual(faction.stock, STARTING_STOCK);
  assert.deepEqual(room.faction(room.players.get(human.playerId)).stock, faction.stock);
  assert.equal(room.owned(bot.id).length, 3);
  assert.equal(room.owned(human.playerId).length, 3);
  assert.equal(player.connected, false);
  assert.equal(player.address, null);
  assert.equal(room.requirePlayer(bot.id), player);
  assert.equal(room.manned(faction), true);
  assert.equal(faction.away, null);
  room.shelter(room.world.time + SHELTER_AWAY + 1);
  assert.equal(faction.shelter, null, 'an active AI cannot gain offline shelter without a socket');
  assert.deepEqual(room.roster().find(seat => seat.id === bot.id), { id: bot.id, connected: false, ai: 'active' });
  const cannotReconnect = () => assert.throws(() => room.join('Tomar IA', player.token), error => error.unknownKey === true);
  cannotReconnect();
  const actor = room.owned(bot.id)[0];
  room.command(bot.id, { type: 'squad', order: 'move', ids: [actor.id], x: faction.base.x + 200 });
  assert(room.players.get(bot.id).squad.units.get(actor.id).move);
  assert.deepEqual(room.setCommanderEnabled(bot.id, false), { ...bot, enabled: false });
  assert.deepEqual(room.roster().find(seat => seat.id === bot.id), { id: bot.id, connected: false, ai: 'paused' });
  assert.equal(room.players.get(bot.id).squad.units.get(actor.id).move, null, 'pause uses the ordinary offline recall at the base');
  assert.equal(room.manned(faction), false);
  assert.equal(faction.away, room.world.time);
  assert.throws(() => room.requirePlayer(bot.id), /Entre no campo primeiro/);
  cannotReconnect();
  room.shelter(room.world.time + SHELTER_AWAY + 1);
  assert.notEqual(faction.shelter, null, 'a paused controller follows the ordinary offline rule');
  room.setCommanderEnabled(bot.id, true);
  assert.equal(player.connected, false);
  assert.equal(room.manned(faction), true);
  assert.equal(faction.away, null);
  assert.equal(faction.shelter, null, 'resuming removes the offline shelter immediately');
  cannotReconnect();
});

test('public AI status is honest without changing connectivity or revealing an unknown faction', t => {
  const room = field(t), bot = room.addCommander('Controlador'), human = room.join('Comandante IA humano'),
    botFaction = room.factions.get(bot.factionId), humanFaction = room.faction(room.players.get(human.playerId)),
    view = () => room.factionView(human.playerId), rank = () => view().ranking.find(row => row.ref === botFaction.ref);
  assert.equal(view().members[0].ai, undefined, 'an AI-looking human name is not an AI identity');
  assert.deepEqual([rank().ai, rank().id, view().known.length], ['active', null, 0]);
  const stranger = view().strangers.find(row => row.id === bot.id);
  assert.deepEqual([stranger.ai, stranger.connected], ['active', false]);
  assert.deepEqual(Object.keys(stranger).sort(), ['ai', 'connected', 'id', 'invited', 'name']);
  assert(isFactionView(view()));
  assert(!JSON.stringify(view()).includes(room.players.get(bot.id).token));

  room.command(human.playerId, { type: 'apply', ref: botFaction.ref });
  room.command(bot.id, { type: 'apply', ref: humanFaction.ref });
  assert.deepEqual([view().request.ai, view().request.id, view().requests[0].ai, view().requests[0].from.ai], ['active', null, 'active', 'active']);
  room.setCommanderEnabled(bot.id, false);
  assert.deepEqual([rank().ai, view().strangers.find(row => row.id === bot.id).ai], ['paused', 'paused']);
  assert.deepEqual([room.factionView(bot.id).members[0].ai, room.players.get(bot.id).connected], ['paused', false]);

  room.setCommanderEnabled(bot.id, true);
  room.command(bot.id, { type: 'invite', playerId: human.playerId });
  room.command(human.playerId, { type: 'join-faction', factionId: botFaction.id });
  assert.equal(rank().ai, undefined, 'a mixed faction is not labeled as entirely AI-controlled');
  assert.deepEqual(view().members.map(row => [row.id, row.ai, row.connected]), [[bot.id, 'active', false], [human.playerId, undefined, true]]);
  const outsider = room.join('Visitante'), otherFaction = room.faction(room.players.get(outsider.playerId));
  room.command(bot.id, { type: 'apply', ref: otherFaction.ref });
  const request = room.factionView(outsider.playerId).requests[0];
  assert.deepEqual([request.ai, request.from.ai], ['active', undefined], 'the applicant is AI even when their faction is mixed');
});

test('AI metadata accepts only active or paused at every public codec boundary and remains optional', () => {
  const flag = { country: 'br' }, person = { id: 'bot', name: 'Controlador', connected: false, invited: false },
    standing = { id: null, name: 'Controlador', nation: null, flag },
    cases = [
      ['members', [{ id: 'bot', name: person.name, connected: false, role: 'leader' }], rows => rows[0]],
      ['strangers', [person], rows => rows[0]],
      ['known', [{ id: 'known', name: person.name, nation: null, flag, color: null, members: [person], seen: false, at: null, x: null, defeated: null }], rows => rows[0].members[0]],
      ['ranking', [{ ...standing, ref: 'ref', wealth: 10 }], rows => rows[0]],
      ['request', { ...standing, ref: 'ref' }, row => row],
      ['requests', [{ id: 'bot', name: person.name, connected: false, from: standing }], rows => rows[0]],
      ['requests', [{ id: 'bot', name: person.name, connected: false, from: standing }], rows => rows[0].from],
    ];
  for (const [key, original, row] of cases) {
    assert(factionFieldGuards[key](original), `${key}: older human DTOs remain valid`);
    for (const ai of ['active', 'paused', 'offline', true, null, undefined]) {
      const value = structuredClone(original); row(value).ai = ai;
      assert.equal(factionFieldGuards[key](value), ai === 'active' || ai === 'paused', `${key}: ${String(ai)}`);
    }
  }
});

test('cold saves preserve enabled and paused controller identities, strategic memory and normal stocks', t => {
  const room = field(t), host = new FieldHost(room), bot = host.addCommander('Ativo'), paused = host.addCommander('Pausado', 'cautious');
  host.setCommanderEnabled(paused.id, false);
  run(host, 120);
  assert(room.commanders.get(bot.id).sequence > 0);
  assert.equal(room.commanders.get(paused.id).sequence, 0);
  const kept = JSON.parse(JSON.stringify(room.keep())), cold = field(t, kept);
  assert.deepEqual([...cold.commanders], [...room.commanders]);
  for (const id of [bot.id, paused.id]) {
    const original = room.players.get(id), restored = cold.players.get(id);
    assert.equal(restored.connected, false);
    assert.equal(restored.token, original.token);
    assert.throws(() => cold.holder(restored.token), error => error.unknownKey === true);
    assert.deepEqual(cold.faction(restored).stock, room.faction(original).stock);
    assert.deepEqual(cold.owned(id).map(actor => actor.id), room.owned(id).map(actor => actor.id));
  }
  assert.equal(cold.factions.get(bot.factionId).away, null);
  assert.equal(cold.manned(cold.factions.get(paused.factionId)), false);
  assert.equal(cold.factions.get(paused.factionId).away, room.factions.get(paused.factionId).away);
  const independent = room.keep();
  independent.commanders[0][1].sequence++;
  assert.notEqual(independent.commanders[0][1].sequence, room.commanders.get(bot.id).sequence, 'keep does not lend strategic state');
});

test('a controller cannot be restored for a missing player, twice, or with invalid strategic state', t => {
  const room = field(t), bot = room.addCommander('Ativo'), base = JSON.parse(JSON.stringify(room.keep()));
  for (const change of [
    kept => { kept.commanders[0][0] = 'missing-seat'; },
    kept => { kept.commanders.push(structuredClone(kept.commanders[0])); },
    kept => { kept.commanders[0][1].profile = 'omniscient'; },
    kept => { kept.commanders[0][1].nextAt = kept.scene.time + 3601; },
  ]) {
    const kept = structuredClone(base); change(kept);
    assert.throws(() => openRoom(null, kept), /[Cc]omandante|Controladores/);
  }
  assert.equal(room.commanders.get(bot.id).profile, 'balanced');
});

test('creation and pause/resume are external diary events; decisions replay exactly without duplicate do entries', async t => {
  const room = field(t), host = new FieldHost(room), first = header(room), bot = host.addCommander('IA', 'balanced', '0123456789abcdef');
  run(host, 180);
  host.setCommanderEnabled(bot.id, false); run(host, 120);
  host.setCommanderEnabled(bot.id, true); run(host, 180);
  const state = room.commanders.get(bot.id), lines = [first, ...host.lines],
    entries = host.lines.map(line => JSON.parse(line));
  assert(state.actions > 0, 'the ordinary commander actually issued an in-game action');
  assert.equal(entries.filter(row => row[1] === 'commander').length, 1);
  assert.equal(entries.filter(row => row[1] === 'commander-enabled').length, 2);
  assert.equal(entries.filter(row => row[1] === 'do').length, 0, 'Room decisions are recomputed, not executed twice');
  assert(!lines.join('\n').includes(room.players.get(bot.id).token));
  const again = await replayField(lines);
  t.after(() => again.host.room.world.dispose());
  assert.equal(again.how, 'end', again.got);
  assert.equal(again.host.room.steps, room.steps);
  assert.equal(again.host.room.digest(), room.digest());
  assert.deepEqual([...again.host.room.commanders], [...room.commanders]);
});

test('a binary field photo retains plain controller maps and the next decision cadence', nativePhotoOnly, t => {
  const room = field(t), host = new FieldHost(room), bot = host.addCommander('IA');
  run(host, 120);
  const snapshot = writeField(room, host.publication), restored = field(t), other = new FieldHost(restored);
  other.publication = readField(restored, snapshot);
  assert(restored.commanders instanceof Map);
  assert.deepEqual([...restored.commanders], [...room.commanders]);
  assert.equal(Object.getPrototypeOf(restored.commanders.get(bot.id)), Object.prototype);
  assert.equal(restored.digest(), room.digest());
  run(host, 240); run(other, 240);
  assert.equal(restored.digest(), room.digest(), 'the next AI actions and physics follow the same ticks');
});

test('a forged diary join cannot take a bot seat or stall replay; noted command refusals still replay', { timeout: 15000 }, () => {
  // Isolate the parser so a regression that loops between awaits cannot block
  // the suite's event loop and defeat the node:test timeout itself.
  const source = `
    import assert from 'node:assert/strict';
    import ${JSON.stringify(new URL('./helpers/runtime.js', import.meta.url).href)};
    import { FieldHost, openRoom, replayField, DIARY } from ${JSON.stringify(new URL('../server/field-host.ts', import.meta.url).href)};
    import { FIELD_SAVE } from ${JSON.stringify(new URL('../server/field-save.ts', import.meta.url).href)};
    import { CORE_CONTRACT } from ${JSON.stringify(new URL('../src/native-dynamics.ts', import.meta.url).href)};
    import { NETWORK_VERSION } from ${JSON.stringify(new URL('../src/network-protocol.ts', import.meta.url).href)};
    const room = openRoom(null), host = new FieldHost(room),
      first = JSON.stringify({diary:DIARY,network:NETWORK_VERSION,save:FIELD_SAVE,contract:CORE_CONTRACT,field:null,origin:null,fieldId:room.fieldId}),
      draw = '0123456789abcdef', bot = host.addCommander('IA', 'balanced', draw);
    host.setCommanderEnabled(bot.id, false);
    assert.throws(() => host.command(bot.id, {type:'squad',order:'stop',ids:['c1']}), /Entre no campo primeiro/);
    const lines = [first,...host.lines], control = await replayField(lines);
    assert.equal(control.how, 'end', 'an ordinary noted refusal is still compared and consumed');
    control.host.room.world.dispose();
    const forged = JSON.stringify([room.steps,'join','Intruso',bot.id,null,draw]),
      refused = await replayField([...lines,forged]);
    assert(['fell','diverged'].includes(refused.how));
    assert.equal(refused.host.room.players.get(bot.id).connected, false);
    assert.equal(refused.host.room.commanders.get(bot.id).enabled, false);
    refused.host.room.world.dispose(); room.world.dispose();
    console.log('finished');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'finished');
});
