import { nativePhotoOnly } from './helpers/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { FIXED_DT } from '../src/physics.ts';
import { THROTTLE_IN } from '../src/episode-input.ts';
import { serveNetwork } from './helpers/network.js';
import { onField } from './helpers/field.js';
import { NETWORK_VERSION, keyOf } from '../src/network-protocol.ts';
import { FieldHost, openRoom, replayField, DIARY } from '../server/field-host.ts';
import { diaryLines, findDiary, tidyDiaries } from '../server/field-journal.ts';
import { fieldStore, FIELD_SAVE } from '../server/field-save.ts';
import { AIRDROP, activityView } from '../server/world-activities.ts';
import { GUARDIAN } from '../server/airdrop-guardian.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { defaultFlag } from '../src/flag.ts';
import { bill, carriedBy, supplied } from '../src/economy.ts';
import { reserveState } from '../src/component-volume.ts';

const kinds = lines => lines.map(line => JSON.parse(line)[1]);
const versions = { diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT };
test('replay refuses missing or different diary, core, save and network versions before opening either kind of field', async () => {
  for (const snapshot of [false, true]) for (const [key, message] of [
    ['diary', /Este diário é de outra versão/],
    ['contract', /outro contrato do núcleo/], ['save', /outra versão do campo salvo/], ['network', /outra versão da rede/],
  ]) for (const value of [undefined, versions[key] - 1, versions[key] + 1]) {
    // Opening this origin or importing this snapshot would fail for another reason.
    const header = { ...versions, [key]: value, field: null, origin: { ground: 'not-the-current-ground' }, ...(snapshot ? { snapshot: {} } : {}) };
    await assert.rejects(replayField([JSON.stringify(header)]), message, `${key}=${value}, snapshot=${snapshot}`);
  }
});
// A field with two players, each with a scout: one drives and fires at the other, which is let go to its orders;
// the field is told to them as a server tells it, kept once, and one of them leaves. With the lines its host wrote down.
function played(t, { dir = null, segment } = {}) {
  const field = { bases: [-150, 150] }, host = new FieldHost(openRoom(field), { field, segment }), room = host.room;
  t.after(() => room.field.dispose());
  if (dir) host.record(dir);
  const alice = host.join('Alice', '', '203.0.113.7'), bob = host.join('Bob', '', '198.51.100.9'),
    // Each takes what it published in hand: publishing puts nobody at the controls.
    spawn = (player, x, facing) => { const id = host.command(player.playerId, { type: 'spawn', request: 1, x, facing, blueprint: createStructuredTemplate('scout') }).actor.id;
      host.command(player.playerId, { type: 'squad', order: 'control', id }); return id; },
    scout = spawn(alice, -150, 1), theirs = spawn(bob, 150, -1),
    // What the field refuses it answers with the refusal: written down all the same.
    attempt = (player, data) => { try { host.command(player.playerId, data); } catch { /* refused */ } };
  for (let i = 0; i < 900; i++) {
    if (i === 30) host.command(alice.playerId, { type: 'drive', throttle: 1, brake: 0 });
    if (i === 60) {
      const gun = room.world.modules.find(m => m.actorId === scout && m.kind === 'weapon');
      host.command(alice.playerId, { type: 'trigger', active: true, aim: { x: 150, y: room.world.terrain.height(150) + 2 }, weapon: { id: 'cannon', componentId: gun.id } });
    }
    if (i === 200) host.command(bob.playerId, { type: 'squad', order: 'control', id: null });
    // A flood of orders, refused, the same again or new, each step for a while: rounds are asked for as they were then.
    if (i > 210 && i < 260) for (const stance of ['x', 'fire', 'fire', 'hold'])
      attempt(bob, { type: 'squad', order: stance === 'x' ? 'x' : 'stance', ids: [theirs], stance });
    // The faction is quoted to everybody now and then, and to one player in between, as a reply asks.
    if (i % 3 === 0) host.tell([alice.playerId, bob.playerId], i % 15 === 0 || (i % 5 === 0 && [i % 2 ? alice.playerId : bob.playerId]));
    if (i === 500) host.keep();
    if (i === 600) host.leave(bob.playerId);
    host.step();
    if (dir) host.flush();
  }
  return { host, room, alice, lines: [JSON.stringify({ ...versions, field, origin: null }), ...host.lines] };
}

test('a field run again from its diary goes as it went, print for print, to the field it came to', async t => {
  const { room, alice, lines } = played(t), said = kinds(lines.slice(1));
  for (const kind of ['join', 'do', 'tell', 'keep', 'leave', 'pace', 'print']) assert(said.includes(kind), kind);
  assert(said.filter(kind => kind === 'print').length === 15, 'a print every second of the field');
  const text = lines.join('\n');
  assert(!text.includes(alice.token) && !text.includes('203.0.113.7') && !text.includes('198.51.100.9'), 'no token and no address in it');
  const again = await replayField(lines);
  t.after(() => again.host.room.field.dispose());
  assert.equal(again.how, 'end', again.got);
  assert.deepEqual([again.step, again.read, again.prints], [room.steps, lines.length, 15]);
  assert.equal(again.host.room.digest(), room.digest());
  assert.deepEqual([...again.host.room.factions.values()].map(f => f.flag), [...room.factions.values()].map(f => f.flag), 'under the same flags');
  assert(again.host.room.world.stats.shots > 5, 'the scout fired there too');
  // Stopped on the way, it is the field as it came to that step.
  const halfway = await replayField(lines, { until: 450 });
  t.after(() => halfway.host.room.field.dispose());
  assert.deepEqual([halfway.how, halfway.step, halfway.prints], ['until', 450, 7]);
  // A faction quoted to one player is quoted to that one alone.
  const { players } = again.host.tell([alice.playerId, 'j2'], [alice.playerId]);
  assert.deepEqual([...players.values()].map(told => told.faction?.id ?? null), [alice.faction.id, null]);
});

test('a diary run again otherwise than it went is caught at the first line that differs', async t => {
  const { lines } = played(t), drive = lines.findIndex(line => line.includes('"drive"')),
    changed = lines.with(drive, lines[drive].replace('"throttle":1', '"throttle":0.5'));
  const again = await replayField(changed);
  t.after(() => again.host.room.field.dispose());
  assert.equal(again.how, 'diverged');
  assert.equal(JSON.parse(again.expected)[1], 'print', 'the field drove otherwise, and its print says so');
  assert(again.step <= 60 * Math.ceil((JSON.parse(lines[drive])[0] + 1) / 60), 'at the first print after the drive');
  // A diary that says a round ended where the field ends none is caught there.
  const pace = lines.findIndex((line, i) => i > drive && JSON.parse(line)[1] === 'pace'),
    early = await replayField(lines.with(pace, lines[pace].replace(/^\[(\d+)/, (_, step) => `[${Number(step) - 1}`)));
  t.after(() => early.host.room.field.dispose());
  assert.equal(early.how, 'diverged');
});

test('a hello the field refuses changes nothing on it and is not written down: whoever comes next is who would have come', async t => {
  // The field of the game, which draws its bases: one tried with hellos it refuses, one without.
  const open = () => { const host = new FieldHost(openRoom(null)); t.after(() => host.room.field.dispose()); return host; },
    plain = open(), tried = open(), home = '203.0.113.7', away = '198.51.100.9',
    state = room => [room.digest(), { ...room.serials }, room.chance.state, room.players.size, room.factions.size];
  for (const host of [plain, tried]) { host.join('Alice', '', home); host.join('Ana', '', home); }
  const was = state(tried.room), written = tried.lines.length;
  // A name that is no words, given as a page could give it, and a third player from an address that has two.
  for (const name of [{ toString: 1 }, [{ toString: 1 }], { valueOf: 1, toString: 1 }, 5, true]) {
    assert.throws(() => tried.join(name, '', away), /Nome de jogador inválido/);
    assert.throws(() => tried.room.join(name), /Nome de jogador inválido/);
  }
  assert.throws(() => tried.join('Outra', '', home), /Só 2 jogadores conectados ao mesmo tempo por conexão/);
  // And a key no seat keeps.
  assert.throws(() => tried.join('Ana', 'ZZZZ-ZZZZ', away), error => error.unknownKey === true);
  assert.deepEqual(state(tried.room), was); assert.equal(tried.lines.length, written, 'nothing written down');
  const bob = plain.join('Bob', '', away), again = tried.join('Bob', '', away);
  assert.equal(again.playerId, bob.playerId); assert.deepEqual(again.base, bob.base); assert.deepEqual(state(tried.room), state(plain.room));
  // The address of the refused hellos is named as if they had never come: the two diaries say the same, but for the
  // flags drawn for the factions founded, which nothing of the field draws.
  const drawless = lines => lines.map(line => { const entry = JSON.parse(line); return entry[1] === 'join' ? entry.slice(0, -1) : entry; });
  assert.deepEqual(drawless(tried.lines), drawless(plain.lines));
  // A name is written down as the field works it out, and is that name again when the field is run again.
  assert.equal(tried.join(' Carol\u0007' + 'x'.repeat(18) + ' tail', '', '192.0.2.4').playerId, 'j4');
  assert.equal(tried.room.players.get('j4').name, 'Carol' + 'x'.repeat(18), 'words, cut short');
  assert.equal(JSON.parse(tried.lines.at(-1))[2], 'Carol' + 'x'.repeat(18));
  const replayed = await replayField([JSON.stringify({ ...versions, field: null, origin: null }), ...tried.lines]);
  t.after(() => replayed.host.room.field.dispose());
  assert.equal(replayed.how, 'end', replayed.got); assert.equal(replayed.host.room.digest(), tried.room.digest());
});

test('a command is written down as the field reads it: what the field ignores, and a design it does not publish, are not', async t => {
  const field = { bases: [-150, 150] }, host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => room.field.dispose()); t.mock.method(console, 'warn', () => {}); // what the core says of a design it refuses
  const alice = host.join('Alice', '', null), pad = 'x'.repeat(60_000), padded = { ...createStructuredTemplate('scout'), pad },
    tries = (data, refusals) => { try { host.command(alice.playerId, data); } catch (error) { refusals?.add(error.message); } },
    id = host.command(alice.playerId, { type: 'spawn', request: 1, x: -150, facing: 1, blueprint: createStructuredTemplate('scout'), pad }).actor.id;
  // A design published is written down as the field keeps it, with where it was put and how it faces.
  const [, , , published] = JSON.parse(host.lines.at(-1));
  assert.deepEqual(Object.keys(published), ['type', 'blueprint', 'x', 'facing']); assert.deepEqual(published.blueprint, room.design(room.world.actor(id)).blueprint);
  host.command(alice.playerId, { type: 'squad', order: 'control', id, pad });
  const from = host.lines.length, refusals = new Set();
  for (let i = 0; i < 120; i++) {
    // A design padded with what the field ignores, again and again: in the wait after the last one, and after it.
    tries({ type: 'spawn', request: 2, x: -140, facing: 1, blueprint: padded, pad }, refusals);
    tries({ type: 'replace', request: 3, actorId: id, x: -100, facing: -1, blueprint: padded, pad }, refusals);
    // And the commands of every day, with it too: one the field does not know is refused as the controls are.
    tries({ type: 'drive', throttle: i % 2, brake: 0, pad });
    tries({ type: 'ping', time: i * 1e12, pad }); tries({ type: 'dance', actorId: id, request: 4, pad }, refusals);
    host.step();
  }
  // A design the field refuses for where it would stand is refused for that, written down without it.
  tries({ type: 'spawn', x: 400, facing: 1, blueprint: createStructuredTemplate('scout'), pad }, refusals);
  assert.deepEqual(JSON.parse(host.lines.at(-1))[3], { type: 'spawn' });
  assert(refusals.has('Aguarde um instante antes de fabricar novamente.') && refusals.has('Fabrique dentro da base.') && refusals.has('Ação inválida.'), [...refusals].join(' | '));
  const said = host.lines.slice(from).filter(line => JSON.parse(line)[1] === 'do'), written = said.reduce((sum, line) => sum + line.length + 1, 0);
  assert.equal(said.length, 120 * 5 + 1);
  assert(said.every(line => line.length < 120 && !line.includes('xxxx')), said.find(line => line.length >= 120));
  assert(written < 120 * 6 * 120, `${written} bytes for ${said.length} commands of 60 kB`);
  // Run again from what was written down, the field goes as it went.
  const replayed = await replayField([JSON.stringify({ ...versions, field, origin: null }), ...host.lines]);
  t.after(() => replayed.host.room.field.dispose());
  assert.equal(replayed.how, 'end', replayed.got); assert.equal(replayed.prints, 2); assert.equal(replayed.host.room.digest(), room.digest());
});

test('a faction founded for whoever leaves one or is removed from it flies the flag the diary drew for it: run again, the field flies it too', async t => {
  const field = { bases: [-150, 150, 450, 750, 1050] }, host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => room.field.dispose());
  const [ana, bia, caio] = ['Ana', 'Bia', 'Caio'].map(name => host.join(name, '', null));
  for (const player of [bia, caio]) {
    host.command(ana.playerId, { type: 'invite', playerId: player.playerId }); host.command(player.playerId, { type: 'join-faction', factionId: ana.faction.id });
  }
  host.step();
  // What a page says of a draw is nothing to the field: the host draws it.
  host.command(bia.playerId, { type: 'leave-faction', draw: '0000000000000000' });
  assert.throws(() => host.command(ana.playerId, { type: 'member', playerId: 'j9', act: 'admin' }), /já não é da facção/);
  host.command(ana.playerId, { type: 'member', playerId: caio.playerId, act: 'remove' });
  // To the second of the field, which a print of it ends.
  for (let i = 0; i < 59; i++) host.step();
  const done = host.lines.map(line => JSON.parse(line)).filter(entry => entry[1] === 'do'),
    left = done.find(entry => entry[3].type === 'leave-faction'), removed = done.find(entry => entry[3].act === 'remove');
  assert.deepEqual(left.slice(2, 4), [bia.playerId, { type: 'leave-faction' }]); assert.match(left[4], /^[0-9a-f]{16}$/); assert.match(removed[4], /^[0-9a-f]{16}$/);
  assert(done.filter(entry => entry !== left && entry !== removed).every(entry => entry.length === 4), 'a command that founds nothing goes without a draw');
  assert.deepEqual([room.faction(room.players.get(bia.playerId)).flag, room.faction(room.players.get(caio.playerId)).flag], [defaultFlag(left[4]), defaultFlag(removed[4])]);
  const replayed = await replayField([JSON.stringify({ ...versions, field, origin: null }), ...host.lines]);
  t.after(() => replayed.host.room.field.dispose());
  assert.equal(replayed.how, 'end', replayed.got); assert.equal(replayed.host.room.digest(), room.digest());
  const factions = room => [...room.factions.values()].map(f => [f.id, f.flag, f.leader, f.removed]);
  assert.deepEqual(factions(replayed.host.room), factions(room));
});

test('timestamped pings renew control leases at recorded steps without moving the field clock, and replay alike', async t => {
  const field = { bases: [0] }, host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => room.field.dispose());
  const alice = host.join('Alice', '', null),
    id = host.command(alice.playerId, { type: 'spawn', blueprint: createStructuredTemplate('scout') }).actor.id,
    player = room.players.get(alice.playerId);
  host.command(alice.playerId, { type: 'squad', order: 'control', id });
  host.command(alice.playerId, { type: 'drive', throttle: 1, brake: 0 });
  for (let i = 0; i < 240; i++) {
    if (i % 30 === 0) {
      const before = [room.steps, room.field.time];
      host.command(alice.playerId, { type: 'ping', time: i % 60 ? -1e12 : 1e15 });
      assert.deepEqual([room.steps, room.field.time], before);
      assert.equal(player.lastInput, room.steps);
      assert.deepEqual(JSON.parse(host.lines.at(-1))[3], { type: 'ping' }, 'RTT time is not part of the deterministic command');
    }
    host.step();
    // The throttle eases in (episode-input.ts `easedThrottle`); held there, it stays.
    if (i >= Math.ceil(THROTTLE_IN / FIXED_DT)) assert.equal(room.world.actor(id).vehicle.throttle, 1, 'presence keeps the held controls alive');
  }
  for (let i = 0; i < 92; i++) host.step();
  assert.equal(room.world.actor(id).vehicle.throttle, 0, 'silence still releases stale movement');
  const replayed = await replayField([JSON.stringify({ ...versions, field, origin: null }), ...host.lines]);
  t.after(() => replayed.host.room.field.dispose());
  assert.equal(replayed.how, 'end', replayed.got); assert.equal(replayed.host.room.digest(), room.digest());
});

test('a publication asked again under the ticket it went with is answered as it was: built and paid once, on the field and when it is run again', async t => {
  const field = { bases: [-150, 150] }, host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => room.field.dispose());
  const alice = host.join('Alice', '', null), faction = room.faction(room.players.get(alice.playerId)),
    publish = (type, ticket, more = {}) => host.command(alice.playerId, { type, request: 1, ticket, facing: 1, blueprint: createStructuredTemplate('scout'), ...more }),
    wait = () => { for (let i = 0; i < 30; i++) host.step(); };
  const first = publish('spawn', 'a1'), paid = { ...faction.stock };
  // Its answer was lost on the way: asked again, at once or later, it is answered as it was, and nothing more is built or paid.
  assert.deepEqual(publish('spawn', 'a1'), first); wait();
  assert.deepEqual(publish('spawn', 'a1', { blueprint: createStructuredTemplate('recon') }), first);
  assert.deepEqual([room.world.actors.length, faction.stock], [1, paid]);
  // Another ticket is another publication; and a replacement asked again is answered so too.
  const second = publish('spawn', 'a2'); assert.notEqual(second.actor.id, first.actor.id); assert.equal(room.world.actors.length, 2); wait();
  const swap = { actorId: first.actor.id, blueprint: createStructuredTemplate('recon') }, swapped = publish('replace', 'b1', swap), after = { ...faction.stock }; wait();
  assert.deepEqual(publish('replace', 'b1', swap), swapped); assert.deepEqual([room.world.actors.length, faction.stock], [2, after]);
  // What the field answered already its diary writes down without a design: nothing was published for it.
  const said = host.lines.map(line => JSON.parse(line)).filter(line => line[1] === 'do').map(line => line[3]);
  assert.deepEqual(said.map(command => [command.type, command.ticket, 'blueprint' in command]),
    [['spawn', 'a1', true], ['spawn', 'a1', false], ['spawn', 'a1', false], ['spawn', 'a2', true], ['replace', 'b1', true], ['replace', 'b1', false]]);
  const replayed = await replayField([JSON.stringify({ ...versions, field, origin: null }), ...host.lines]);
  t.after(() => replayed.host.room.field.dispose());
  assert.equal(replayed.how, 'end', replayed.got); assert.equal(replayed.host.room.digest(), room.digest());
  // A diary begun after a cold restart can omit the retried design too: its origin keeps the receipt.
  const origin = JSON.parse(JSON.stringify(room.keep()));
  for (const seat of origin.players) seat.token = keyOf(seat.id);
  const renewed = new FieldHost(openRoom(field, origin), { field }); t.after(() => renewed.room.field.dispose());
  renewed.join('Alice', keyOf(alice.playerId), null);
  assert.deepEqual(renewed.command(alice.playerId, { type: 'replace', ticket: 'b1', ...swap }), swapped);
  const retried = JSON.parse(renewed.lines.at(-1))[3]; assert.equal('blueprint' in retried, false);
  for (let i = 0; i < 60; i++) renewed.step();
  const coldReplay = await replayField([JSON.stringify({ ...versions, field, origin }), ...renewed.lines]);
  t.after(() => coldReplay.host.room.field.dispose());
  assert.equal(coldReplay.how, 'end', coldReplay.got); assert.equal(coldReplay.host.room.digest(), renewed.room.digest());
});

test('every so often the diary goes on in a new file that begins from the field written out whole, and each is run again alike from there', nativePhotoOnly, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-fotos-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { room } = played(t, { dir, segment: 300 }), files = readdirSync(dir).sort();
  assert.equal(files.length, 4, 'one to begin with and one every 300 steps');
  const heads = files.map(name => JSON.parse(readFileSync(join(dir, name), 'utf8').split('\n', 1)[0]));
  assert.deepEqual(heads.map(head => [head.step, Boolean(head.snapshot)]), [[0, false], [300, true], [600, true], [900, true]]);
  // The field written out holds nobody's key: each seat has its own name for one.
  for (const name of files) {
    let text = ''; for await (const line of diaryLines(join(dir, name))) text += line;
    assert(![...room.players.values()].some(seat => text.includes(seat.token)), name);
  }
  for (const [i, name] of files.entries()) {
    const again = await replayField(diaryLines(join(dir, name)));
    t.after(() => again.host.room.field.dispose());
    assert.equal(again.how, 'end', `${name}: ${again.got}`);
    assert.equal(again.step, [300, 600, 900, 900][i]);
    assert.equal(again.prints, i === 3 ? 0 : 5);
    if (i === 3) assert.equal(again.host.room.digest(), room.digest(), 'the last begins where the field stood, and is it');
  }
  // From the field written out at step 300, the rest of it: run on, given what came after.
  const lines = [];
  for (const [i, name] of files.slice(1).entries()) {
    let first = true;
    for await (const line of diaryLines(join(dir, name))) { if (i === 0 || !first) lines.push(line); first = false; }
  }
  const through = await replayField(lines);
  t.after(() => through.host.room.field.dispose());
  assert.deepEqual([through.how, through.step, through.prints], ['end', 900, 10]);
  assert.equal(through.host.room.digest(), room.digest());
});

test('a segment cut while a moving pilot uses its terrain plan resumes print for print', nativePhotoOnly, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-pilot-photo-')), field = { bases: [-14552] },
    host = new FieldHost(openRoom(field), { field, segment: Infinity }), room = host.room;
  t.after(() => { host.diary?.close(); room.field.dispose(); rmSync(dir, { recursive: true, force: true }); });
  host.record(dir);
  const player = host.join('Pilot'), id = host.command(player.playerId,
    { type: 'spawn', x: -14552, facing: 1, blueprint: createStructuredTemplate('truck') }).actor.id,
    squad = room.players.get(player.playerId).squad, terrain = room.world.terrain;
  for (let i = 0; i < 180; i++) host.step();
  host.command(player.playerId, { type: 'squad', order: 'move', ids: [id], x: -13252 });
  let reads = 0, planned = null, hitWhileMoving = false;
  const height = terrain.height, safeSpeed = squad.safeSpeed,
    heights = t.mock.method(terrain, 'height', function (...args) { reads++; return height.apply(this, args); }),
    forecast = t.mock.method(Object.getPrototypeOf(squad), 'safeSpeed', function (actorId, leg) {
      const before = reads, safe = safeSpeed.call(this, actorId, leg), vehicle = this.side.world.actor(actorId).vehicle;
      if (actorId === id && this === squad) {
        if (reads > before) planned = { x: vehicle.x, time: room.world.time };
        else if (planned && Math.abs(vehicle.vx) > 1 && Math.abs(vehicle.x - planned.x) > 0 &&
          Math.abs(vehicle.x - planned.x) < 1 && room.world.time - planned.time < .15) hitWhileMoving = true;
      }
      return safe;
    });
  for (let i = 0; i < 1800 && !hitWhileMoving; i++) host.step();
  forecast.mock.restore(); heights.mock.restore();
  assert(hitWhileMoving, 'the cut needs a moving vehicle with a live cached braking corridor');
  const cut = room.steps;
  host.cut();
  const end = Math.ceil((cut + 600) / 60) * 60;
  while (room.steps < end) host.step();
  host.flush(); host.diary.close(); host.diary = null;
  const files = readdirSync(dir).sort(); assert.equal(files.length, 2);
  const again = await replayField(diaryLines(join(dir, files[1])));
  t.after(() => again.host.room.field.dispose());
  assert.equal(again.how, 'end', `first differing line: ${again.got}`);
  assert.equal(again.step, room.steps);
  assert.equal(again.prints, Math.floor(room.steps / 60) - Math.floor(cut / 60));
  assert.equal(again.host.room.digest(), room.digest());
});

test('a funded supply group survives a segmented diary exactly while cold save keeps cargo and recomputes jobs', nativePhotoOnly, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-supply-group-photo-')),
    field = { bases: [12, 20000], stock: bill(1e7, 1e6, 1e6, 1e5) },
    initial = openRoom(field), fixture = onField(t, initial), joined = initial.join('Ana'),
    truck = fixture.publish(joined, 'supply'), target = fixture.publish(joined, 'scout'), near = fixture.publish(joined, 'scout'),
    faction = initial.faction(initial.players.get(joined.playerId));
  fixture.send(joined, 'auto', { actorId: truck, on: false });
  // The other one on the way to it, short of where the supply vehicle stops beside it, near enough that one stop serves both
  // (SUPPLY_REACH, `rearmLoad`).
  fixture.put(target, faction.base.x + 300); fixture.put(near, faction.base.x + 279);
  for (const [id, share] of [[target, 0], [near, .6]]) {
    const piece = initial.world.modules.find(part => part.actorId === id && part.kind === 'ammo'),
      source = initial.world.actor(id).blueprint.modules.find(part => part.kind === 'ammo');
    fixture.set(piece, { rounds: Math.floor(reserveState(source).rounds * share) });
  }
  initial.supplyDispatch.unload(initial.world.actor(truck), faction);
  // The fixture's explicit reserve deficits and placements are the cold origin, before recording starts.
  const origin = JSON.parse(JSON.stringify(initial.keep())), host = new FieldHost(openRoom(field, origin), { field, segment: Infinity }), room = host.room;
  t.after(() => { host.diary?.close(); room.field.dispose(); rmSync(dir, { recursive: true, force: true }); });
  host.record(dir, origin);
  host.join('Ana', joined.token);
  host.command(joined.playerId, { type: 'auto', actorId: truck, on: true });
  const group = () => room.supplyDispatch.jobs.get(truck);
  for (let i = 0; i < 1200 && !(group()?.phase === 'deliver' && group().targetIds?.length === 2); i++) host.step();
  assert.equal(group()?.phase, 'deliver', 'a real paid load was dispatched from the base');
  assert.deepEqual(group().targetIds, [target, near], 'the paid commitment contains both real deficits');
  const cargo = field => supplied(carriedBy(field.serving(truck)).carried), aboard = cargo(room);
  assert(aboard.ferro > 0 && aboard.ligas === 0 && aboard.silica === 0);
  const kept = JSON.parse(JSON.stringify(room.keep())), cold = openRoom(field, kept);
  t.after(() => cold.field.dispose());
  assert.deepEqual(cargo(cold), aboard, 'cold save preserves the physical cargo');
  assert.equal(cold.record(cold.world.actor(truck)).auto, true, 'the ordinary cold-resume automatic policy remains');
  assert.equal(cold.supplyDispatch.jobs.size, 0, 'cold resume recomputes dispatch instead of persisting stale claims');
  const cut = room.steps;
  host.cut();
  const end = Math.ceil((cut + 180) / 60) * 60;
  while (room.steps < end) host.step();
  host.flush(); host.diary.close(); host.diary = null;
  const files = readdirSync(dir).sort(); assert.equal(files.length, 2);
  const lines = [];
  for await (const line of diaryLines(join(dir, files[1]))) lines.push(line);
  const header = JSON.parse(lines[0]);
  assert(header.snapshot.heap.keys.includes('targetIds'), 'the ordinary object graph writes the funded group');
  const again = await replayField(lines);
  t.after(() => again.host.room.field.dispose());
  assert.deepEqual([again.how, again.step, again.prints], ['end', room.steps, Math.floor(end / 60) - Math.floor(cut / 60)], again.got);
  assert.equal(again.host.room.digest(), room.digest(), 'all physical and room state resumes exactly');
  assert.deepEqual(again.host.room.supplyDispatch.jobs.get(truck)?.targetIds, group()?.targetIds);
});

test('the diaries of a field: deflated once nobody writes to them, the oldest making room, and read alike either way', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-diarios-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, lines, age) => { const file = join(dir, name); writeFileSync(file, lines.join('\n') + '\n'); const at = (Date.now() - age) / 1000; utimesSync(file, at, at); return file; };
  const old = write('2026-01-01T00-00-00-000Z-1-0.ndjson.gz', [], 0), lines = ['{"diary":1}', '[0,"join","Alice",null,false,null]'];
  writeFileSync(old, gzipSync('{"diary":1}\n'.repeat(4000)));
  const stopped = write('2026-01-02T00-00-00-000Z-2-0.ndjson', lines, 10 * 60_000), running = write('2026-01-03T00-00-00-000Z-3-0.ndjson', lines, 0),
    own = write('2026-01-04T00-00-00-000Z-4-0.ndjson', lines, 10 * 60_000), cut = write('2026-01-02T00-00-00-000Z-2-0.ndjson.gz.part', ['x'], 10 * 60_000);
  await tidyDiaries(dir, { own, budget: 10 ** 9 });
  assert.deepEqual(readdirSync(dir).sort(), ['2026-01-01T00-00-00-000Z-1-0.ndjson.gz', '2026-01-02T00-00-00-000Z-2-0.ndjson.gz',
    '2026-01-03T00-00-00-000Z-3-0.ndjson', '2026-01-04T00-00-00-000Z-4-0.ndjson']);
  assert(!existsSync(stopped) && !existsSync(cut) && existsSync(running) && existsSync(own));
  const read = async file => { const all = []; for await (const line of diaryLines(file)) all.push(line); return all; };
  assert.deepEqual(await read(stopped + '.gz'), lines); assert.deepEqual(await read(running), lines);
  assert.equal(findDiary(dir), own, 'the newest');
  // Over its room, the oldest that is closed goes first; one still open, never.
  await tidyDiaries(dir, { own, budget: 100 });
  assert.deepEqual(readdirSync(dir).sort(), ['2026-01-03T00-00-00-000Z-3-0.ndjson', '2026-01-04T00-00-00-000Z-4-0.ndjson']);
});

const until = async (fn, timeout = 30000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
async function serving(t, dir) {
  const { socket, close } = await serveNetwork(t, { rehearsal: { bases: [0, 400] }, save: { dir, seconds: 3600 } });
  const connect = async (name, token = '') => {
    const ws = socket(), client = { ws, messages: [] };
    ws.on('message', (raw, binary) => { if (!binary) client.messages.push(JSON.parse(raw)); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token }));
    await until(() => client.messages.some(m => m.type === 'welcome'));
    client.welcome = client.messages.find(m => m.type === 'welcome');
    client.send = data => ws.send(JSON.stringify(data));
    return client;
  };
  return { connect, close };
}

test('a server writes the diary of its field as it runs it, and each run of the field is run again alike, the one resumed too', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-diario-')), replays = join(dir, 'replays');
  const log = console.log; let first, second;
  console.log = () => {}; t.after(async () => {
    try { await first?.close(); await second?.close(); }
    finally { console.log = log; rmSync(dir, { recursive: true, force: true }); }
  });
  first = await serving(t, dir);
  const alice = await first.connect('Alice'), bob = await first.connect('Bob');
  alice.send({ type: 'spawn', request: 1, x: 0, facing: 1, blueprint: createStructuredTemplate('scout') });
  bob.send({ type: 'spawn', request: 2, x: 400, facing: -1, blueprint: createStructuredTemplate('scout') });
  await until(() => alice.messages.some(m => m.request === 1) && bob.messages.some(m => m.request === 2));
  alice.send({ type: 'drive', throttle: 1, brake: 0 });
  alice.send({ type: 'ping', time: -1e12 });
  await until(() => alice.messages.some(m => m.type === 'pong'));
  assert.equal(alice.messages.find(m => m.type === 'pong').time, -1e12, 'RTT uses the page timestamp unchanged');
  await new Promise(resolve => setTimeout(resolve, 2500));
  bob.ws.close();
  await new Promise(resolve => setTimeout(resolve, 500));
  alice.ws.close(); await first.close();
  const [diary] = readdirSync(replays), text = readFileSync(join(replays, diary), 'utf8');
  assert(!text.includes(alice.welcome.token) && !text.includes(bob.welcome.token), 'no token in it');
  const presence = text.trim().split('\n').map(line => JSON.parse(line)).find(line => line[1] === 'do' && line[3].type === 'ping');
  assert.deepEqual(presence?.[3], { type: 'ping' }, 'worker presence renews the lease through the recorded host command');
  const replayed = async file => { const again = await replayField(diaryLines(file)); t.after(() => again.host.room.field.dispose()); return again; };
  const one = await replayed(join(replays, diary));
  assert.equal(one.how, 'end', one.got); assert(one.prints >= 2, `${one.prints} prints`);
  const said = kinds(text.trim().split('\n').slice(1));
  for (const kind of ['join', 'do', 'tell', 'pace', 'print', 'leave', 'keep']) assert(said.includes(kind), kind);
  // The field resumed is a run of its own, from the field it was kept as: each seat with its own name, written as a key, for a token.
  second = await serving(t, dir);
  const back = await second.connect('Alice', alice.welcome.token);
  assert.equal(back.welcome.playerId, alice.welcome.playerId);
  // What the field resumed goes on with is what it was kept as: spent from, it changes, and the diary begins from it as it was.
  back.send({ type: 'spawn', request: 3, x: 40, facing: 1, blueprint: createStructuredTemplate('scout') });
  await until(() => back.messages.some(m => m.request === 3));
  assert(!back.messages.find(m => m.request === 3).error);
  await new Promise(resolve => setTimeout(resolve, 1500));
  back.ws.close(); await second.close();
  const newer = readdirSync(replays).sort().filter(name => name !== diary)[0], resumed = readFileSync(join(replays, newer), 'utf8'),
    header = JSON.parse(resumed.slice(0, resumed.indexOf('\n')));
  assert.deepEqual(header.origin.players.map(seat => seat.token), header.origin.players.map(seat => keyOf(seat.id)));
  assert(!resumed.includes(alice.welcome.token));
  const two = await replayed(join(replays, newer));
  assert.equal(two.how, 'end', two.got); assert(two.prints >= 1);
});

test('a live activity origin precedes startup warmup, and its announcement, collection and withdrawal resume from JSON and segmented photos', { ...nativePhotoOnly, timeout: 90000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-activity-replay-')), replays = join(dir, 'replays'),
    fixture = onField(t, openRoom({ bases: [0] })), seed = fixture.room, player = seed.join('Activity replay'),
    scout = fixture.publish(player, 'scout', { x: 0, facing: 1 }),
    supply = fixture.publish(player, 'supply', { x: -30, facing: 1 });
  let live, host;
  t.after(async () => {
    try { await live?.close(); host?.diary?.close(); }
    finally { host?.room.field.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
  // A paid vehicle still being made carries a real load; another has an explicit driving order.
  // Both exercise the startup origin beyond an empty field or an activity record alone.
  seed.building = true;
  const cargoActor = fixture.publish(player, 'mining-truck', { x: 30, facing: 1 }), hopper = fixture.parts(cargoActor, 'hopper')[0];
  assert(hopper); fixture.set(hopper, { cargo: { ferro: 17.5 } });
  fixture.order(player, 'move', { ids: [scout], x: 70 });
  assert.equal(seed.records.get(cargoActor).service.kind, 'build');
  assert(seed.records.get(cargoActor).service.until > seed.world.time + 6);
  assert.equal(fieldStore(dir).save(seed), true);
  const before = JSON.parse(readFileSync(join(dir, 'field.json'), 'utf8')).room,
    savedPlayer = before.players.find(seat => seat.id === player.playerId),
    cargo = scene => scene.modules.filter(piece => piece.cargo !== undefined).map(piece => [piece.id, piece.cargo]);
  assert(!Object.hasOwn(before, 'activities'), 'the normal live worker must enable the new calendar itself');
  assert(savedPlayer.orders.some(([id, order]) => id === scout && order.move?.x === 70));
  assert(cargo(before.scene).some(([, load]) => load.ferro === 17.5));
  // No rehearsal option here: this is the production worker path, with its actual twelve-step resume check.
  live = await serveNetwork(t, { save: { dir, seconds: 3600 } });
  const ws = live.socket(), messages = [];
  ws.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw)); });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name: player.name, token: player.token }));
  await until(() => messages.some(message => message.type === 'welcome'));
  await until(() => existsSync(replays) && readdirSync(replays).some(name => name.endsWith('.ndjson') && /\[\d+,"print",/.test(readFileSync(join(replays, name), 'utf8'))));
  const left = once(ws, 'close'); ws.close(); await left; await live.close();
  const [run, ...extra] = readdirSync(replays).filter(name => name.endsWith('.ndjson')).sort();
  assert(run); assert.equal(extra.length, 0);
  const header = JSON.parse(readFileSync(join(replays, run), 'utf8').split('\n', 1)[0]), origin = header.origin;
  assert.equal(header.field, null); assert.equal(header.step, 12);
  assert.equal(origin.scene.time, before.scene.time, 'the diary begins before the twelve warmup steps');
  assert.equal(origin.scene.tick, before.scene.tick);
  assert.equal(origin.activities.nextAt, before.scene.time + AIRDROP.first);
  assert.equal(origin.activities.drop, null);
  assert.deepEqual(origin.records.find(([id]) => id === cargoActor)[1].service, before.records.find(([id]) => id === cargoActor)[1].service);
  assert.deepEqual(cargo(origin.scene), cargo(before.scene));
  assert.deepEqual(origin.players.find(seat => seat.id === player.playerId).orders, savedPlayer.orders);
  const started = await replayField(diaryLines(join(replays, run)));
  t.after(() => started.host?.room.field.dispose());
  assert.equal(started.how, 'end', started.got); assert(started.prints >= 1, 'the real worker produced and verified a print');

  // Use the ordinary placement once, then author shorter deadlines and a previously discovered balance for the
  // phase fixture. Real pickup is exercised in extraction-save; no unrecorded mutation occurs inside this diary.
  const active = started.host.room;
  active.activities.nextAt = active.world.time;
  for (let i = 0; i < 60 && !active.activities.drop; i++) started.host.step(() => 1);
  assert(active.activities.drop, 'the ordinary event planner found a real site');
  const at = active.world.time;
  assert.deepEqual(active.activities.drop.supplies, bill(48000, 16000, 12000, 4000));
  for (const key of ['stock', 'material', 'refined']) assert(!Object.hasOwn(active.activities.drop, key));
  assert(active.activities.drop.guardianId); assert(active.world.actor(active.activities.drop.guardianId));
  Object.assign(active.activities.drop, { arrivesAt: at + 2, expiresAt: at + 4, known: [savedPlayer.factionId] });
  // The already present sentinel is tested in its combat cases; this phase/photo fixture stays outside its current sensing reach.
  const carrier = active.world.actor(supply), v = carrier.vehicle, x = active.activities.drop.x + AIRDROP.clearance + GUARDIAN.leash + 100,
    crate = active.world.modules.find(piece => piece.actorId === supply && piece.kind === 'supply');
  active.world.command('setVehicleState', { actorId: supply,
    state: { x, y: v.y - active.world.terrain.height(v.x) + active.world.terrain.height(x), vx: 0, vy: 0 } });
  active.world.game().call({ op: 'setPartState', owner: active.world.game().handle(crate),
    state: { cargo: { ferro: 19.25, ligas: 7.5, silica: 3.125, petroleo: 2.75 } } });
  active.record(carrier).supplyDelivery = true;
  const kept = JSON.parse(JSON.stringify(active.keep())), phaseOrigin = structuredClone(kept), phaseDir = join(dir, 'phases');
  host = new FieldHost(openRoom(null, kept), { segment: Infinity });
  host.record(phaseDir, phaseOrigin);
  host.join(player.name, host.room.players.get(player.playerId).token, null);
  const room = host.room, cuts = [], phases = ['announcement', 'collection', 'withdrawal'];
  for (const [index, step] of [60, 180, 300].entries()) {
    while (room.steps < step) host.step(() => 1);
    const faction = room.factions.get(savedPlayer.factionId);
    assert.equal(activityView(room, faction).phase, phases[index]);
    assert.equal(activityView(room, faction).refined, true);
    assert.deepEqual(activityView(room, faction).supplies, index < 2 ? AIRDROP.supplies : bill());
    for (const key of ['stock', 'material', 'reserve', 'left']) assert(!Object.hasOwn(activityView(room, faction), key));
    if (index === 1) {
      host.command(player.playerId, { type: 'squad', order: 'haul', ids: [supply], depositId: room.activities.drop.id });
      assert.equal(room.players.get(player.playerId).squad.units.get(supply).haul.refined, true, 'the ordinary server order classifies the supply containers');
      assert(!Object.hasOwn(room.players.get(player.playerId).squad.units.get(supply).haul, 'material'));
    }
    const saved = JSON.parse(JSON.stringify(host.keep())), cold = openRoom(null, saved);
    try {
      const restored = JSON.parse(JSON.stringify(cold.keep()));
      assert.deepEqual(restored.activities, saved.activities, `${phases[index]}: calendar, balance, guardian identity and orders`);
      assert.deepEqual(restored.serials, saved.serials, 'cold admission grants no second guardian or construction');
      assert.deepEqual(cargo(restored.scene), cargo(saved.scene), 'cold admission preserves carried materials');
      assert.deepEqual(restored.records.map(([id, record]) => [id, record.service]), saved.records.map(([id, record]) => [id, record.service]));
      assert.deepEqual(restored.records.map(([id, record]) => [id, record.supplyDelivery]), saved.records.map(([id, record]) => [id, record.supplyDelivery]));
      assert.deepEqual(restored.players.map(seat => [seat.id, seat.orders]), saved.players.map(seat => [seat.id, seat.orders]));
      assert.deepEqual(restored.factions.map(side => [side.id, side.stock, side.yard]), saved.factions.map(side => [side.id, side.stock, side.yard]));
      assert.equal(activityView(cold, cold.factions.get(savedPlayer.factionId)).phase, phases[index]);
      assert.equal(cold.world.actors.filter(actor => actor.team === 'guardian:' + saved.activities.drop.id).length, 1);
    } finally { cold.field.dispose(); }
    cuts.push({ step, phase: phases[index], digest: room.digest(), supplyDelivery: room.record(room.world.actor(supply)).supplyDelivery,
      refinedHaul: room.players.get(player.playerId).squad.units.get(supply).haul?.refined, supplies: { ...room.activities.drop.supplies } });
    host.cut();
  }
  while (room.steps < 360) host.step(() => 1);
  host.keep(); host.flush(); host.diary.close(); host.diary = null;
  const final = { step: room.steps, digest: room.digest() }, files = readdirSync(phaseDir).sort();
  assert.equal(files.length, 4);
  for (const [index, name] of files.entries()) {
    const file = join(phaseDir, name), head = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]);
    if (index > 0) {
      const cut = cuts[index - 1], photo = await replayField([JSON.stringify(head)]);
      try {
        assert(head.snapshot, `${cut.phase}: a real segmented binary photo`);
        assert.equal(photo.how, 'end', photo.got); assert.equal(photo.step, cut.step);
        assert.equal(photo.host.room.digest(), cut.digest, `${cut.phase}: photo restores every bit`);
        const side = photo.host.room.factions.get(savedPlayer.factionId);
        assert.equal(activityView(photo.host.room, side).phase, cut.phase);
        assert.deepEqual(photo.host.room.activities.drop.supplies, cut.supplies);
        for (const key of ['stock', 'material', 'refined']) assert(!Object.hasOwn(photo.host.room.activities.drop, key));
        assert.deepEqual(photo.host.room.activities.drop.known, [savedPlayer.factionId]);
        assert.equal(photo.host.room.records.get(supply).supplyDelivery, cut.supplyDelivery);
        assert.equal(photo.host.room.players.get(player.playerId).squad.units.get(supply).haul?.refined, cut.refinedHaul);
      } finally { photo.host?.room.field.dispose(); }
    }
    const replayed = await replayField(diaryLines(file)), end = index < cuts.length ? cuts[index] : final;
    try {
      assert.equal(replayed.how, 'end', replayed.got); assert.equal(replayed.step, end.step);
      assert.equal(replayed.prints, (end.step - head.step) / 60);
      assert.equal(replayed.host.room.digest(), end.digest, `segment ${index} resumes print for print`);
    } finally { replayed.host?.room.field.dispose(); }
  }
});

test('explicit tow attach, repeat and detach replay through the current diary without caller-supplied physics', async t => {
  const field = { bases: [0] }, host = new FieldHost(openRoom(field), { field }), { room } = host, world = room.world;
  t.after(() => world.dispose());
  const alice = host.join('Alice', '', null), blueprint = createStructuredTemplate('truck'),
    send = data => host.command(alice.playerId, data),
    tug = send({ type: 'spawn', x: 0, facing: 1, blueprint }).actor.id,
    steps = count => { for (let i = 0; i < count; i++) host.step(); };
  steps(60);
  // Identical real chassis: their compiled frame ends determine the second publication, within the base.
  const frame = world.plates.filter(p => p.actorId === tug && p.definition.chassis?.part === 'frame'),
    x = world.actor(tug).vehicle.x + Math.min(...frame.map(p => p.bounds.minX)) - 2 - Math.max(...frame.map(p => p.bounds.maxX)),
    target = send({ type: 'spawn', x, facing: 1, blueprint }).actor.id;
  steps(60);
  const attach = { type: 'tow', act: 'attach', actorId: tug, targetId: target };
  assert.deepEqual(send({ ...attach, length: 0, tension: 1e12, localA: { x: 999, y: 999 } }), { towing: true });
  assert.deepEqual(JSON.parse(host.lines.at(-1))[3], attach, 'the diary keeps intent, never client-proposed cable geometry or force');
  const length = world.tows[0].length;
  send({ type: 'squad', order: 'move', ids: [tug], x: 20 }); steps(30);
  assert.equal(world.tows.length, 1); assert.deepEqual(send(attach), { towing: true }); assert.equal(world.tows[0].length, length);
  host.tell([alice.playerId], true);
  send({ type: 'squad', order: 'stop', ids: [tug] });
  assert.deepEqual(send({ type: 'tow', act: 'detach', actorId: target }), { towing: false }); steps(30);
  assert.deepEqual(world.tows, []);
  const again = await replayField([JSON.stringify({ ...versions, field, origin: null }), ...host.lines]);
  t.after(() => again.host.room.world.dispose());
  assert.equal(again.how, 'end', again.got); assert.equal(again.host.room.digest(), room.digest());
  assert.deepEqual(again.host.room.world.tows, []); assert.deepEqual([...room.faults, ...again.host.room.faults], []);
});
