import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rehearsal } from '../server/room.ts';
import { FieldHost, openRoom, replayField, DIARY } from '../server/field-host.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { manufactureDesign } from '../server/field-construction.ts';
import { NETWORK_VERSION, merged } from '../src/network-protocol.ts';
import { serveNetwork } from './helpers/network.js';

const TAKEN = 'Esse nome já é de outro jogador.';
const taken = error => error.nameTaken === true && error.message === TAKEN;
// What a refusal leaves as it was: the seats, the factions, the counts and the field to its print, names and all.
const was = room => [room.players.size, room.factions.size, { ...room.serials }, room.digest()];
const names = room => [...room.players.values()].map(p => p.name);

test('a player goes by another name on everything of theirs, and is refused one another player goes by, however it is written', t => {
  const room = rehearsal([-213, 237, -663]), ana = room.join('Ana'), bia = room.join('Bia'); t.after(() => room.world.dispose());
  const seat = room.players.get(ana.playerId), scout = room.furnish(seat, manufactureDesign(createStructuredTemplate('scout'))),
    model = room.command(ana.playerId, { type: 'library', act: 'publish', blueprint: createStructuredTemplate('scout') }).model;
  assert.deepEqual(room.command(ana.playerId, { type: 'rename', name: '  Ana  Maria\u0007 ' }), { name: 'Ana  Maria' });
  // Her construction goes under it, as every page is told the field; her project in the library; the faction that goes
  // by her name while it has none of its own, as the others are told it; and she, to whoever is told of her.
  assert.equal(seat.name, 'Ana  Maria');
  assert.equal(room.world.snapshot().actors.find(actor => actor.id === scout.id).playerName, 'Ana  Maria');
  assert.equal(room.factionView(ana.playerId).library.find(entry => entry.id === model.id).by, 'Ana  Maria');
  assert.deepEqual(room.factionView(ana.playerId).members.map(m => m.name), ['Ana  Maria']);
  assert.deepEqual(room.factionView(bia.playerId).ranking.map(f => f.name).sort(), ['Ana  Maria', 'Bia']);
  assert.deepEqual(room.factionView(bia.playerId).strangers.map(person => person.name), ['Ana  Maria']);
  // Another player is refused it with any case, any accents and any spaces between its words; and none is no name.
  // Whatever is refused changes nothing.
  const before = was(room);
  for (const name of ['ana maria', 'ÂNA MARÍA', ' Ána   Mariá ']) assert.throws(() => room.command(bia.playerId, { type: 'rename', name }), taken, name);
  for (const name of ['', '   ', '\u0007']) assert.throws(() => room.command(bia.playerId, { type: 'rename', name }), /^Error: Escreva o seu nome\.$/);
  assert.throws(() => room.command(bia.playerId, { type: 'rename', name: 7 }), /Nome de jogador inválido/);
  assert.deepEqual(was(room), before);
  // Her own name is hers to write otherwise; and a name let go is anybody's.
  assert.deepEqual(room.command(ana.playerId, { type: 'rename', name: 'ANA MARIA' }), { name: 'ANA MARIA' });
  room.command(ana.playerId, { type: 'rename', name: 'Carla' });
  assert.deepEqual(room.command(bia.playerId, { type: 'rename', name: 'Ána Maria' }), { name: 'Ána Maria' });
  assert.deepEqual(names(room), ['Carla', 'Ána Maria']);
});

test('a new seat is refused a name another goes by, on the field or away, and one who says none is the first free player', t => {
  const room = rehearsal([-213, 237, -663]), ana = room.join('Ana'); t.after(() => room.world.dispose());
  const before = was(room);
  for (const name of ['ana', ' ÁNA ', 'Âna']) assert.throws(() => room.join(name), taken, name);
  assert.deepEqual(was(room), before, 'no seat is made for it');
  // A name is the seat's for as long as the seat is: one who left the field keeps it.
  room.disconnect(ana.playerId);
  assert.throws(() => room.join('ANA'), taken);
  // Whoever comes with no name, or nothing to be read in it, is the first player no seat goes by.
  assert.deepEqual([room.join(null), room.join(''), room.join(' \u0007 ')].map(seat => seat.name), ['Jogador', 'Jogador 2', 'Jogador 3']);
  assert.throws(() => room.join('jogador  2'), taken);
  const writer = room.join('JOGADOR 5'), first = [...room.players.values()].find(p => p.name === 'Jogador');
  room.command(first.id, { type: 'rename', name: 'Dora' });
  assert.deepEqual([room.join(null), room.join(null)].map(seat => seat.name), ['Jogador', 'Jogador 4']);
  assert.equal(room.join(null).name, 'Jogador 6', 'past one a player wrote');
  assert.equal(room.players.get(writer.playerId).name, 'JOGADOR 5');
});

test('a player who comes back by their key comes in with their own name; two a field kept under one name keep it until one changes it', t => {
  const room = rehearsal([-213, 237, -663]), ana = room.join('Ana'), bia = room.join('Bia'); t.after(() => room.world.dispose());
  room.disconnect(ana.playerId);
  assert.equal(room.join('Ana', ana.token).playerId, ana.playerId);
  assert.equal(room.join('ána', ana.token).name, 'ána', 'her own, written otherwise');
  assert.equal(room.join(null, ana.token).name, 'ána', 'and none keeps the one she has');
  room.disconnect(ana.playerId);
  const before = was(room);
  assert.throws(() => room.join('BIA', ana.token), taken, 'another\'s is refused by key too');
  assert.deepEqual(was(room), before); assert.equal(room.players.get(ana.playerId).connected, false);
  // A field kept before names were told apart, with two of one name: each comes back with it, and a third is refused it.
  const kept = room.keep();
  for (const seat of kept.players) seat.name = 'Ana';
  const again = rehearsal([-213, 237, -663], undefined, { kept }); t.after(() => again.world.dispose());
  assert.deepEqual([again.join('Ana', ana.token).name, again.join('ANA', bia.token).name], ['Ana', 'ANA']);
  assert.throws(() => again.join('Âna'), taken);
  // Until one of them changes it: then it is the other's alone.
  again.command(bia.playerId, { type: 'rename', name: 'Bia' });
  assert.throws(() => again.command(bia.playerId, { type: 'rename', name: 'Ana' }), taken);
  assert.deepEqual(names(again), ['Ana', 'Bia']);
});

test('a change of name goes into the diary of the field and is run again as it went; one changed otherwise in it is caught', async t => {
  const field = { bases: [-150, 150, 450] }, host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => room.field.dispose());
  const ana = host.join('Ana', '', '203.0.113.7'), bia = host.join('Bia', '', '198.51.100.9');
  for (let i = 0; i < 120; i++) {
    if (i === 10) host.command(ana.playerId, { type: 'rename', name: 'Carla' });
    if (i === 20) assert.throws(() => host.command(bia.playerId, { type: 'rename', name: 'cárla' }), taken);
    if (i === 30) host.join(null, '', '192.0.2.4');
    if (i === 40) assert.throws(() => host.join('CARLA', '', '192.0.2.5'), taken);
    if (i === 80) host.command(bia.playerId, { type: 'rename', name: 'Ana' });
    host.step();
  }
  assert.deepEqual(names(room), ['Carla', 'Ana', 'Jogador']);
  const lines = [JSON.stringify({ diary: DIARY, network: NETWORK_VERSION, save: FIELD_SAVE, contract: CORE_CONTRACT, field, origin: null }), ...host.lines],
    said = lines.slice(1).map(line => JSON.parse(line)).filter(([, kind]) => kind === 'join' || kind === 'do');
  // Each change of name as it was asked, the one refused with the rest; a hello refused is not written down.
  assert.deepEqual(said.map(([, kind, ...args]) => kind === 'join' ? ['join', args[0]] : ['do', args[1].type, args[1].name]),
    [['join', 'Ana'], ['join', 'Bia'], ['do', 'rename', 'Carla'], ['do', 'rename', 'cárla'], ['join', null], ['do', 'rename', 'Ana']]);
  const again = await replayField(lines); t.after(() => again.host.room.field.dispose());
  assert.equal(again.how, 'end', again.got);
  assert.deepEqual([again.step, again.prints], [room.steps, 2]);
  assert.equal(again.host.room.digest(), room.digest());
  assert.deepEqual(names(again.host.room), names(room));
  // The print of the field has the names in it: a diary that renamed her otherwise goes otherwise from there.
  const at = lines.findIndex(line => line.includes('"Carla"')),
    otherwise = await replayField(lines.with(at, lines[at].replace('"Carla"', '"Clara"'))); t.after(() => otherwise.host.room.field.dispose());
  assert.equal(otherwise.how, 'diverged');
  assert.equal(JSON.parse(otherwise.expected)[1], 'print');
});

test('pages: a name changed reaches the other pages, and one taken is refused, with why, to a page that asks for it or comes with it', { timeout: 25000 }, async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [-300, 300, 900] } });
  const until = async (fn, timeout = 6000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  // A page with its faction as it has it: whole with the welcome, and brought up to what changed since.
  const connect = async name => {
    const ws = socket(), page = { ws, messages: [], faction: null };
    ws.on('message', (raw, binary) => { if (binary) return; const message = JSON.parse(raw);
      if (message.type === 'welcome') { page.welcome = message; page.faction = message.faction; }
      if (message.type === 'faction') page.faction = merged(page.faction, message.changes); page.messages.push(message); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token: '' }));
    await until(() => page.faction || page.messages.some(m => m.error));
    page.refused = page.messages.find(m => m.error);
    page.ask = async (request, data) => { ws.send(JSON.stringify({ ...data, request })); await until(() => page.messages.some(m => m.request === request)); return page.messages.find(m => m.request === request); };
    return page;
  };
  const ana = await connect('Ana'), bia = await connect('Bia');
  const refused = await ana.ask(1, { type: 'rename', name: 'BÍA' });
  assert.deepEqual([refused.error, refused.nameTaken], [TAKEN, true]);
  assert.equal((await ana.ask(2, { type: 'rename', name: 'Carla' })).name, 'Carla');
  // Bia is told of Ana's faction by the new name, which it goes by while it has none of its own.
  await until(() => bia.faction.ranking.some(f => f.name === 'Carla'));
  assert(!bia.faction.ranking.some(f => f.name === 'Ana'));
  // A page that comes with it is refused, and told it is the name.
  const late = await connect('carla');
  assert.deepEqual([late.welcome, late.refused.error, late.refused.nameTaken], [undefined, TAKEN, true]);
  assert.equal((await connect('Ana')).welcome.name, 'Ana', 'the name she let go is anybody\'s');
});
