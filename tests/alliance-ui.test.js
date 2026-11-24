import test from 'node:test';
import assert from 'node:assert/strict';
import { initFactionSocial, ALLIANCE_DESCRIPTION, ALLIANCE_LINE } from '../src/faction-social-ux.ts';
import { ALLIANCE_TERMS } from '../src/faction-social.ts';
import { workspaceDOM } from './helpers/dom.js';
import { contactMarks, sharedSoundReports } from '../src/faction-ui.ts';
import { fieldPanel, fieldNotices } from '../src/field-panel.ts';
import { threatened, Mood, TENSE_HOLD } from '../src/soundtrack.ts';
import { Squad } from '../src/squad.ts';
import { bill, load } from '../src/economy.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { pilotDecision } from './helpers/pilot-fixture.ts';

function diplomacyTab(t, role = 'leader', accords = []) {
  const { create } = workspaceDOM(t), trade = create('section', 'faction-panel-trade'), diplomacy = create('section', 'faction-panel-diplomacy');
  const own = { ref: 'r1', name: 'Ana' }, other = { ref: 'r2', name: 'Bia' }, calls = [], said = [],
    network = { enabled: true, connected: true, playerId: 'j1', faction: { ...own, members: [{ id: 'j1', role }],
      ranking: [own, other], trades: [], accords }, command: async (type, data) => { calls.push([type, data]); return {}; } },
    ui = initFactionSocial({ trade, diplomacy, network, refresh() {}, tell: (text, error = false) => said.push([text, error]) }),
    get = selector => diplomacy.querySelector(selector);
  return { create, own, other, calls, said, network, ui, get };
}

test('the diplomacy tab proposes an explicit alliance and keeps declared commitments visibly distinct', async t => {
  const { own, other, calls, network, ui, get } = diplomacyTab(t), text = get('#accord-text'),
    kind = id => get('.accord-kinds').querySelectorAll('button').find(b => b.dataset.kind === id);
  assert.equal(kind('declaration').getAttribute('aria-pressed'), 'true'); assert(get('#alliance-terms').hidden);
  assert.equal(get('.accord-line').textContent, 'Uma promessa por escrito, que fica pública quando aceita.');
  text.value = 'Uma declaração não concede visão.'; text.focus();
  kind('alliance').click();
  assert.equal(text.value, 'Uma declaração não concede visão.'); assert(!text.required); assert(get('.accord-terms').hidden);
  assert.deepEqual([get('.accord-line').textContent, get('#alliance-terms').hidden], [ALLIANCE_LINE, false], 'an alliance says in a line what it does');
  assert.equal(get('#alliance-terms').querySelector('p').textContent, ALLIANCE_DESCRIPTION, 'and the rest under "Saiba mais"');
  assert.equal(get('#accord-send').textContent, 'Propor aliança');
  get('#accord-target').value = other.ref; get('#accord-form').dispatch('submit'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[0], ['accord', { act: 'propose', ref: other.ref, kind: 'alliance' }]);
  assert.equal(text.value, 'Uma declaração não concede visão.', 'an alliance sent leaves the commitment being written');
  network.faction = { ...network.faction, accords: [
    { id: 'a1', from: own, to: other, kind: 'alliance', text: ALLIANCE_TERMS, acceptedAt: 1 },
    { id: 'a2', from: own, to: other, text: '<b>Declaração</b>', acceptedAt: 1 },
    { id: 'a3', from: other, to: own, text: 'Paz no vale.', acceptedAt: null },
    { id: 'a4', from: own, to: other, kind: 'alliance', text: ALLIANCE_TERMS, acceptedAt: null }] };
  ui.render();
  const line = id => get(`[data-id=${id}]`).querySelector('.social-line').textContent, buttons = id => get(`[data-id=${id}]`).querySelectorAll('button').filter(b => !b.hidden).map(b => b.textContent);
  assert.deepEqual(get('.social-records').children.map(row => row.dataset.id), ['a3', 'a1', 'a2', 'a4'], 'what waits for an answer comes first');
  assert.deepEqual([line('a3'), buttons('a3')], ['Facção de Bia propõe um compromisso', ['Aceitar', 'Recusar']]);
  assert.deepEqual([line('a1'), get('[data-id=a1]').querySelector('small').textContent, buttons('a1')], ['Aliança com a facção de Bia', 'visão e radar compartilhados', ['Encerrar']]);
  assert.equal(get('[data-id=a1]').querySelector('.social-terms').hidden, true, 'the recorded terms of an alliance are not read out');
  assert.deepEqual([line('a2'), get('[data-id=a2]').querySelector('.social-terms').textContent], ['Compromisso com a facção de Bia', '<b>Declaração</b>']);
  assert.equal(get('[data-id=a2]').querySelector('b'), null);
  assert.deepEqual([line('a4'), buttons('a4')], ['Você propôs uma aliança à facção de Bia', ['Cancelar']]);
  network.faction = { ...network.faction, members: [{ id: 'j1', role: 'member' }] }; ui.render();
  assert(get('#accord-form').hidden); assert(!get('.social-only').hidden); assert.deepEqual(buttons('a1'), []);
});

test('accept and end use the visible alliance consent, and dismissing either dialog sends no action', async t => {
  const own = { ref: 'r1', name: 'Ana' }, other = { ref: 'r2', name: 'Bia' },
    { create, calls, said, network, ui, get } = diplomacyTab(t, 'admin', [{ id: 'a1', from: other, to: own, kind: 'alliance', text: ALLIANCE_TERMS, acceptedAt: null }]);
  const dialog = create('dialog', 'confirm-dialog'), accept = create('button', 'confirm-accept', dialog);
  for (const id of ['confirm-title', 'confirm-text']) create('p', id, dialog);
  document.getElementById = id => document.querySelector('#' + id);
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; }; accept.value = 'ok';
  const buttons = () => get('[data-id=a1]').querySelectorAll('button'), settle = () => new Promise(resolve => setImmediate(resolve));
  buttons()[0].click(); assert(dialog.open); assert.equal(document.getElementById('confirm-title').textContent, 'Aceitar a aliança?');
  assert.match(document.getElementById('confirm-text').textContent, /visão e radar/);
  dialog.oncancel(); await settle(); assert.deepEqual(calls, []);
  buttons()[0].click(); accept.click(); await settle();
  assert.deepEqual(calls, [['accord', { act: 'accept', id: 'a1', kind: 'alliance' }]]);
  assert.deepEqual(said.at(-1), ['Aliança feita: vocês já compartilham visão e radar.', false]);
  network.faction.accords[0].acceptedAt = 1; ui.render(); buttons()[1].click();
  assert(document.getElementById('confirm-text').textContent.includes('deixam de ser compartilhados')); dialog.oncancel(); await settle();
  assert.equal(calls.length, 1);
  buttons()[1].click(); accept.click(); await settle(); assert.deepEqual(calls[1], ['accord', { act: 'end', id: 'a1' }]);
  assert.deepEqual(said.at(-1), ['Aliança encerrada.', false]);
});

test('allied hearing is readable without a squad or base, with frozen direction, field age, no spatial mark and one existing notice', () => {
  const report = { kind: 'sound', shared: true, from: { ref: 'r-amber', name: 'Bia', nation: 'Vale' }, side: -1, at: 8.5 },
    faction = { id: 'blue', ref: 'r-blue', name: 'Ana', stock: bill(), yard: load(), base: null, members: [{ id: 'ana', name: 'Ana', role: 'leader' }],
      known: [], strangers: [], ranking: [], invites: [], request: null, requests: [], library: [], recovery: null,
      fell: { at: 1, by: null, dismantled: 0, returned: bill(), cargo: load(), stock: bill(), yard: load() }, recovered: null,
      count: 0, counts: { vehicles: 0, fixed: 0 }, units: [], wrecks: [], deposits: [] },
    state = { shared: true, time: 10, localPlayerId: 'ana', faction, actors: [], plates: [], modules: [], bodyPanels: [], contacts: [report] },
    watch = () => fieldPanel({ shared: true, connected: true, state, faction, playerId: 'ana' }).watch,
    rows = sharedSoundReports(state), memo = {}, mood = new Mood(), writer = new FrameWriter(), reader = new FrameReader();
  assert.deepEqual(reader.decode(writer.encode({ state }, true)).state.contacts, [report]);
  assert.deepEqual(contactMarks(state), []);
  assert.deepEqual(rows, [{ id: 'allied-sound:r-amber:-1', shared: true,
    text: 'Relato aliado — Vale: contato ouvido à esquerda do observador aliado, há 1 s.' }]);
  assert.deepEqual(watch().contacts, rows);
  assert.deepEqual(fieldNotices(memo, watch(), 1000), [rows[0].text], 'the first complete look announces only the active report');
  assert(memo.spotted); assert.equal(memo.place, null); assert.equal(memo.entry, null);
  assert.deepEqual(memo.items, [{ text: rows[0].text, grave: false, place: null }]);
  assert.equal(threatened(state), true); assert.equal(mood.of({ state }, 1000), 'tense');
  state.time = 10.5; state.contacts = [{ ...report, at: 9 }];
  assert.deepEqual(reader.decode(writer.encode({ state })).state.contacts, state.contacts, 'a delta carries only the public frozen report');
  assert.deepEqual(fieldNotices(memo, watch(), 1000.5), [], 'a new half-second receipt uses the same source/side notice key');
  state.contacts = [{ ...report, at: 8.5 }]; state.time = 11.5;
  assert.deepEqual(sharedSoundReports(state), []); assert.deepEqual(watch().contacts, []);
  state.contacts = []; fieldNotices(memo, watch(), 1002);
  assert.deepEqual(reader.decode(writer.encode({ state })).state.contacts, []);
  writer.close();
  assert.equal(threatened(state), false); assert.equal(mood.of({ state }, 1000 + TENSE_HOLD + 1), 'calm');
  const ownState = { ...state, time: 10, actors: [{ id: 'own', x: 900 }], contacts: [{ kind: 'sound', by: 'own', side: 1, at: 9 }] };
  assert.deepEqual(sharedSoundReports(ownState), []); assert.equal(contactMarks(ownState)[0].x, 900);
  const ownFirst = { ...watch(), contacts: [{ id: 'own', text: 'Veículo 1: ouviu um inimigo.' }] };
  assert.deepEqual(fieldNotices({}, ownFirst, 2000), [], 'the initial own hearing notice policy is unchanged');
});

test('a shared ear drives the squad sensing without fabricating local hearing or a directional vehicle warning', () => {
  const actors = { own: { id: 'own', team: 'local', x: 0, vehicle: { x: 0, vx: 0 }, aim: { x: 100, y: 3 } },
      enemy: { id: 'enemy', team: 'red', x: 400, vehicle: { x: 400, vx: 0 } } },
    world = { time: 10, plates: [], modules: [], actor: id => actors[id] ?? null },
    side = { world, defeats: {}, arenaBounds: { minX: -10000, maxX: 10000 }, foe: id => id === 'enemy', sighted: () => false, input() {}, batteries: [],
      get roster() { return [{ id: 'own', team: 'local', role: 'armor', pilot: 'player' }]; } },
    squad = new Squad(side), decision = pilotDecision({ action: { type: 'controls', throttle: 0, brake: 1, fire: false, aim: { x: 400, y: 1 }, componentId: 'none' },
      targetId: 'enemy', contact: { detected: true, age: .1, x: 400, channel: 'sound', sharedSound: true }, diagnostics: { reason: 'search-contact', nearestFreshContactDistance: 400 } });
  world.game = () => ({ call: () => decision });
  squad.decide(side.roster[0], 1);
  // A report shared by an ally gives a side, not a place: it holds no automatic work (Squad.endangered).
  assert.equal(squad.units.get('own').threat, false); assert.equal(squad.view().units[0].heard, null);
  assert.equal(squad.view().units[0].targetId, null); assert.equal(squad.contacts.size, 1, 'existing encounter bookkeeping remains');
  world.time = 40; decision.contact.sharedSound = false;
  squad.decide(side.roster[0], 2);
  assert.deepEqual(squad.view().units[0].heard, { event: 'own:40', side: 1, channel: 'sound' }, 'own hearing keeps its original vehicle warning');
});
