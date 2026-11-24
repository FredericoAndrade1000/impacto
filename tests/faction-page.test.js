import test from 'node:test';
import assert from 'node:assert/strict';
import { factionPage, memberActions, pointsText, wealthText } from '../src/faction-page.ts';
import { configureLanguage } from '../src/i18n.ts';

const flag = { country: 'br' }, faction = (more = {}) => ({
  id: 'f1', ref: 'r1', name: 'Ana', nation: 'Vale Verde', flag, base: { x: 0 },
  members: [{ id: 'ana', name: 'Ana', connected: true, role: 'leader' }, { id: 'bia', name: 'Bia', connected: false, role: 'admin' },
    { id: 'caio', name: 'Caio', connected: true, role: 'member' }],
  ranking: [{ id: 'f2', ref: 'r2', name: 'Duda', nation: null, flag, wealth: 2_480_000 }, { id: 'f1', ref: 'r1', name: 'Ana', nation: 'Vale Verde', flag, wealth: 1_234_567 },
    { id: null, ref: 'r3', name: null, nation: 'Serra', flag, wealth: 8_200 }],
  known: [{ id: 'f2', name: 'Duda', nation: null, flag, seen: false, at: 10, x: -3200, defeated: null,
    members: [{ id: 'duda', name: 'Duda', connected: true, invited: true }] }],
  strangers: [{ id: 'edu', name: 'Edu', connected: false, invited: false }],
  invites: [], request: null, requests: [], library: [], ...more,
});

test('the ranking puts every nation of the field by its wealth in points, the player\'s standing at its head', () => {
  const page = factionPage(faction(), 'caio', 70);
  assert.deepEqual(page.standing, { place: 2, of: 3, points: '1,2 milhão de pontos', title: '1.234.567 pontos de riqueza' });
  assert.deepEqual(page.ranking.map(row => [row.place, row.name, row.wealth, row.own, row.detail]), [
    [1, 'Facção de Duda', '2,5 milhões', false, 'vista há 1 min · a 3,2 km ←'],
    [2, 'Vale Verde', '1,2 milhão', true, 'sua nação'],
    [3, 'Serra', '8.200', false, '']]);
  assert.equal(page.ranking[0].x, -3200, 'a nation met and out of sight takes the camera where it was last seen');
  const stands = (patch, time) => factionPage(faction({ known: [{ ...faction().known[0], ...patch }] }), 'caio', time).ranking[0];
  assert.deepEqual([stands({ seen: true }, 500).detail, stands({ seen: true }, 500).x], ['à vista agora', null], 'in sight it is on the screen: no place is told');
  assert.equal(stands({ at: 260, x: 12300 }, 500).detail, 'vista há 4 min · a 12,3 km →');
  assert.equal(stands({ at: 90, x: 600 }, 80).detail, 'vista há 0 s · a 600 m →', 'never ahead of the frame on screen');
  assert.deepEqual([stands({ at: null, x: null, defeated: 140 }, 500).detail, stands({ at: null, x: null, defeated: 140 }, 500).x], ['derrotada há 6 min', null]);
  assert.equal(wealthText(1_000_000), '1 milhão');
  assert.deepEqual([pointsText(350_400), pointsText(2_500_000), pointsText(820)], ['350,4 mil pontos', '2,5 milhões de pontos', '820 pontos']);
});

test('the player asks to join any nation of the ranking but their own and one that invited them, one at a time, and the leader and the administrators are told who asks', () => {
  const acts = more => factionPage(faction(more), 'caio', 70).ranking.map(row => [row.ref, row.act]);
  assert.deepEqual(acts(), [['r2', 'apply'], ['r1', null], ['r3', 'apply']]);
  const asked = factionPage(faction({ request: { ref: 'r2', id: 'f2', name: 'Duda', nation: null, flag } }), 'caio', 70).ranking[0];
  assert.deepEqual([asked.act, asked.detail], ['unapply', 'pedido enviado · vista há 1 min · a 3,2 km ←']);
  assert.deepEqual(acts({ invites: [{ factionId: 'f9', ref: 'r3', name: 'Edu', nation: 'Serra', flag, members: 1 }] }), [['r2', 'apply'], ['r1', null], ['r3', null]]);
  const requests = [{ id: 'duda', name: 'Duda', connected: false, from: { id: null, name: 'Duda', nation: null, flag } },
    { id: 'eva', name: 'Eva', connected: true, from: { id: 'f2', name: 'Duda', nation: 'Serra', flag } }];
  assert.deepEqual(factionPage(faction({ requests }), 'ana').requests, [{ id: 'duda', name: 'Duda', detail: 'Facção de Duda · desconectado' }, { id: 'eva', name: 'Eva', detail: 'Serra' }]);
});

test('members say their role and the player may act on them only as the roles allow', () => {
  const rows = player => factionPage(faction(), player).members.map(m => [m.id, m.detail, m.actions]);
  assert.deepEqual(rows('ana'), [['ana', 'líder · você', []], ['bia', 'administrador · desconectado', ['remove', 'member', 'leader']],
    ['caio', 'membro', ['remove', 'admin', 'leader']]]);
  assert.deepEqual(rows('bia').map(row => row[2]), [[], [], ['remove']], 'an administrator removes plain members only');
  assert.deepEqual(rows('caio').map(row => row[2]), [[], [], []]);
  assert.deepEqual([memberActions('admin', 'admin'), memberActions('member', 'member')], [[], []]);
});

test('whoever is not of the faction may be invited, and leaving takes another member to keep the faction', () => {
  const page = factionPage(faction(), 'ana');
  assert.deepEqual(page.invitable.map(p => [p.id, p.act, p.detail]), [['duda', 'cancel', 'Facção de Duda'], ['edu', 'invite', 'ainda não encontrado · desconectado']]);
  assert.equal(page.leave, true);
  assert.equal(factionPage(faction({ members: [{ id: 'ana', name: 'Ana', connected: true, role: 'leader' }] }), 'ana').leave, false);
  assert.equal(factionPage(null), null);
});

test('social lists and ranking distinguish active and paused AI from absent humans in both languages', t => {
  t.after(() => configureLanguage({ languages: ['pt-BR'] }));
  const original = faction(), active = { ...original.known[0].members[0], connected: false, ai: 'active' },
    paused = { ...original.strangers[0], ai: 'paused' },
    shown = faction({ members: [...original.members, { id: 'bot', name: 'Controlador', connected: false, role: 'member', ai: 'active' }],
      known: [{ ...original.known[0], members: [active] }], strangers: [paused],
      ranking: original.ranking.map((row, i) => ({ ...row, ...(i === 0 ? { ai: 'active' } : i === 2 ? { ai: 'paused' } : {}) })),
      requests: [{ id: 'bot', name: 'Controlador', connected: false, ai: 'active', from: { id: null, name: 'Grupo misto', nation: null, flag } }] });
  for (const [language, running, stopped, offline] of [['pt-BR', 'IA', 'IA pausada', 'desconectado'], ['en', 'AI', 'Paused AI', 'disconnected']]) {
    configureLanguage({ languages: [language] });
    const page = factionPage(shown, 'ana', 70);
    assert(page.members.find(row => row.id === 'bot').detail.endsWith(' · ' + running));
    assert(page.members.find(row => row.id === 'bia').detail.endsWith(' · ' + offline));
    assert(page.invitable.find(row => row.id === active.id).detail.endsWith(' · ' + running));
    assert(page.invitable.find(row => row.id === paused.id).detail.endsWith(' · ' + stopped));
    assert(page.requests[0].detail.endsWith(' · ' + running));
    assert(page.ranking[0].detail.startsWith(running + ' · '));
    assert.equal(page.ranking[2].detail, stopped);
    assert.deepEqual([page.ranking[2].id, page.ranking[2].x], [null, null]);
    assert.equal(page.members.find(row => row.id === 'bot').name, 'Controlador', 'translation does not rewrite identity');
  }
});
