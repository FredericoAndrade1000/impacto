import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { serveNetwork } from './helpers/network.js';
import { NETWORK_VERSION, merged } from '../src/network-protocol.ts';

const until = async condition => {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('A rede não respondeu.'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

// A page on the field: what it was told, and its commands with their answers.
function pages(socket) {
  let serial = 0;
  return async (name, token = '') => {
    const ws = socket(), page = { ws, messages: [], faction: null };
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const message = JSON.parse(raw); page.messages.push(message);
      if (message.type === 'welcome') { page.welcome = message; page.faction = message.faction; }
      if (message.type === 'faction') page.faction = merged(page.faction, message.changes);
    });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token })); await until(() => page.welcome);
    page.send = (type, data = {}) => { const request = ++serial; ws.send(JSON.stringify({ type, ...data, request })); return request; };
    page.reply = async request => { await until(() => page.messages.some(message => message.request === request)); return page.messages.find(message => message.request === request); };
    page.ask = async (type, data) => page.reply(page.send(type, data));
    page.heard = id => page.messages.filter(m => m.type === 'chat' && m.message.id === id).length;
    return page;
  };
}

test('chat uses one direct message per recipient, private membership is current, and arrival restores recent history', { timeout: 30000 }, async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [-100, 15000, 30000, 45000] } }), enter = pages(socket);
  const ana = await enter('Ana'), bia = await enter('Bia'), caio = await enter('Caio');
  await ana.ask('invite', { playerId: bia.welcome.playerId }); await bia.ask('join-faction', { factionId: ana.faction.id });
  await until(() => bia.faction.ref === ana.faction.ref && bia.messages.some(m => m.type === 'chat-history'));
  const first = await bia.ask('chat', { scope: 'faction', text: 'Plano entre membros.' }); assert(!first.error);
  await until(() => ana.messages.some(m => m.type === 'chat' && m.message.id === first.sent));
  assert.equal(ana.messages.filter(m => m.type === 'chat' && m.message.id === first.sent).length, 1);
  assert.equal(bia.messages.filter(m => m.type === 'chat' && m.message.id === first.sent).length, 1);
  assert(!caio.messages.some(m => JSON.stringify(m).includes('Plano entre membros.')));
  // These two commands enter on the same socket in order, without waiting for a faction quote between them.
  const removed = ana.send('member', { playerId: bia.welcome.playerId, act: 'remove' }),
    spoken = ana.send('chat', { scope: 'faction', text: 'Depois da remoção.' });
  assert(!(await ana.reply(removed)).error); const second = await ana.reply(spoken); assert(!second.error);
  await until(() => bia.faction.ref !== ana.faction.ref);
  assert(!bia.messages.some(m => m.type === 'chat' && m.message.id === second.sent));
  const global = await caio.ask('chat', { scope: 'global', text: 'Aviso global.' }); assert(!global.error);
  await until(() => [ana, bia, caio].every(page => page.messages.some(m => m.type === 'chat' && m.message.id === global.sent)));
  assert([ana, bia, caio].every(page => page.messages.filter(m => m.type === 'faction').every(m => !JSON.stringify(m).includes('Aviso global.'))));
  assert(ana.messages.filter(m => m.type === 'chat').every(m => Object.keys(m).sort().join(',') === 'message,type'));
  const back = await enter(null, ana.welcome.token);
  assert.deepEqual(back.welcome.chat.faction.map(m => m.text), ['Plano entre membros.', 'Depois da remoção.']);
  assert.deepEqual(back.welcome.chat.global.map(m => m.text), ['Aviso global.']);
});

test('a message to the allies goes once to each player of the writer\'s faction and of its allies, to nobody else, and comes back with the seat', { timeout: 30000 }, async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [-100, 15000, 30000, 45000] } }), enter = pages(socket);
  const ana = await enter('Ana'), bia = await enter('Bia'), caio = await enter('Caio'), duda = await enter('Duda');
  await ana.ask('invite', { playerId: duda.welcome.playerId }); await duda.ask('join-faction', { factionId: ana.faction.id });
  await until(() => duda.faction.ref === ana.faction.ref);
  assert.equal((await ana.ask('chat', { scope: 'allies', text: 'Sem aliados.' })).error, 'Sua facção não tem aliados.');
  const { proposed } = await ana.ask('accord', { act: 'propose', ref: bia.faction.ref, kind: 'alliance' });
  assert(!(await bia.ask('accord', { act: 'accept', id: proposed, kind: 'alliance' })).error);
  const said = await duda.ask('chat', { scope: 'allies', text: 'Avançamos juntos.' }); assert(!said.error);
  await until(() => [ana, bia, duda].every(page => page.heard(said.sent)));
  const told = ana.messages.find(m => m.type === 'chat' && m.message.id === said.sent).message;
  assert.deepEqual([told.scope, told.of, told.to, told.by], ['allies', ana.faction.ref, [bia.faction.ref], 'Duda']);
  const answer = await bia.ask('chat', { scope: 'allies', text: 'Cobrimos o flanco.' }); assert(!answer.error);
  await until(() => [ana, bia, duda].every(page => page.heard(answer.sent)));
  assert.deepEqual([ana, bia, caio, duda].map(page => [said.sent, answer.sent].map(page.heard)), [[1, 1], [1, 1], [0, 0], [1, 1]]);
  assert(!caio.messages.some(m => JSON.stringify(m).includes('flanco')));
  const back = await enter(null, bia.welcome.token);
  assert.deepEqual(back.welcome.chat.faction.map(m => [m.scope, m.text]), [['allies', 'Avançamos juntos.'], ['allies', 'Cobrimos o flanco.']]);
});
