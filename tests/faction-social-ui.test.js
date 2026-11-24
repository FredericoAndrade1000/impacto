import test from 'node:test';
import assert from 'node:assert/strict';
import { initFactionSocial, offerParts, partsText } from '../src/faction-social-ux.ts';
import { FactionDialog, unseen } from '../src/faction-dialog.ts';
import { factionNews } from '../src/faction-page.ts';
import { bill } from '../src/economy.ts';
import { workspaceDOM } from './helpers/dom.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function tabs(t) {
  const { create } = workspaceDOM(t), trade = create('section', 'faction-panel-trade'), diplomacy = create('section', 'faction-panel-diplomacy');
  const own = { ref: 'r1', name: 'Ana' }, other = { ref: 'r2', name: 'Bia', flag: { country: 'br' } }, third = { ref: 'r3', name: 'Caio', nation: 'Serra' }, calls = [], said = [],
    network = { enabled: true, connected: true, playerId: 'j1', faction: { ...own, members: [{ id: 'j1', role: 'leader' }], stock: bill(30, 4, 0, 2500),
      ranking: [own, other, third], trades: [], accords: [] },
      command: async (type, data) => { calls.push([type, data]); return {}; } },
    ux = initFactionSocial({ trade, diplomacy, network, refresh() {}, tell: (text, error = false) => said.push([text, error]) });
  return { trade, diplomacy, own, other, third, calls, said, network, ux, get: selector => document.querySelector(selector) };
}

test('an offer is said in one line: who offers what for what, or what the faction offers to whom', () => {
  const own = { ref: 'r1', name: 'Ana' }, other = { ref: 'r2', name: 'Bia' }, line = (offer, ref = 'r1') => partsText(offerParts(offer, ref));
  assert.equal(line({ from: other, to: own, give: bill(500), want: bill(0, 200) }), 'Facção de Bia oferece 500 Ferro por 200 Ligas');
  assert.equal(line({ from: own, to: other, give: bill(500, 0, 20), want: bill(0, 200, 0, 1500) }),
    'Você oferece 500 Ferro e 20 Sílica à facção de Bia por 200 Ligas e 1.500 L de Combustível');
  assert.equal(line({ from: other, to: own, give: bill(), want: bill(0, 0, 3) }), 'Facção de Bia pede 3 Sílica, sem nada em troca');
  assert.equal(line({ from: own, to: { ...other, nation: 'Vale' }, give: bill(1, 2, 3), want: bill() }), 'Você oferece 1 Ferro, 2 Ligas e 3 Sílica à facção Vale, sem nada em troca');
  assert.deepEqual(offerParts({ from: other, to: own, give: bill(5), want: bill() }, 'r1').filter(part => part.stock).map(part => part.stock), ['ferro'],
    'each amount goes after the mark of its stock');
});

test('the trade tab sends explicit terms, keeps drafts through updates, says offers safely and hides the form from plain members', async t => {
  const { network, ux, get, own, other, third, calls, said } = tabs(t);
  assert.deepEqual([get('#trade-has-ferro').textContent, get('#trade-has-combustivel').textContent], ['tem 30', 'tem 2,5\u00a0mil L'], 'what the faction has is beside what it gives');
  get('#trade-target').value = other.ref; get('#trade-give-ferro').value = '12'; get('#trade-want-ligas').value = '4';
  get('#trade-form').dispatch('submit'); await settle();
  assert.deepEqual(calls[0], ['trade', { act: 'offer', ref: other.ref, give: bill(12), want: bill(0, 4) }]);
  assert.deepEqual(said.at(-1), ['Oferta enviada à facção de Bia.', false]);
  assert.deepEqual([get('#trade-give-ferro').value, get('#trade-want-ligas').value, get('#trade-target').value], ['', '', other.ref], 'the amounts sent are cleared; the faction stays');
  const input = get('#trade-give-ligas'); input.value = '9'; input.focus(); ux.render();
  assert.equal(get('#trade-give-ligas').getAttribute('aria-invalid'), 'true', 'more than the faction has is marked');
  network.faction = { ...network.faction, trades: [{ id: 't1', from: { ...other, name: '<img src=x>Bia' }, to: own, give: bill(5), want: bill(0, 2) },
    { id: 't2', from: own, to: third, give: bill(1), want: bill() }] };
  ux.render();
  assert.equal(document.activeElement, input); assert.equal(input.value, '9');
  const asked = get('[data-id=t1]'), sent = get('[data-id=t2]');
  assert.equal(asked.querySelector('.social-line').textContent, 'Facção de <img src=x>Bia oferece 5 Ferro por 2 Ligas');
  assert.equal(asked.querySelector('img'), null, 'a name is text, never markup');
  assert.equal(sent.querySelector('.social-line').textContent, 'Você oferece 1 Ferro à facção Serra, sem nada em troca');
  const buttons = row => row.querySelectorAll('button').filter(b => !b.hidden).map(b => b.textContent);
  assert.deepEqual([buttons(asked), buttons(sent)], [['Aceitar', 'Recusar'], ['Cancelar']]);
  ux.render(); assert.equal(get('[data-id=t1]'), asked, 'a row stays in place while its offer is there');
  sent.querySelectorAll('button')[1].click(); await settle();
  assert.deepEqual([calls.at(-1), said.at(-1)], [['trade', { act: 'cancel', id: 't2' }], ['Oferta cancelada.', false]]);
  network.faction = { ...network.faction, members: [{ id: 'j1', role: 'member' }] }; ux.render();
  assert(get('#trade-form').hidden); assert(!get('#faction-panel-trade').querySelector('.social-only').hidden);
  assert(asked.querySelector('.social-actions').hidden, 'a plain member reads the offers and answers none');
  network.faction = { ...network.faction, ref: third.ref }; ux.render();
  assert.equal(input.value, '', 'the drafts of the faction before are gone');
});

test('accepting a trade asks first with what goes and what comes, and says what was done', async t => {
  const { network, ux, get, own, other, calls, said } = tabs(t);
  const dialog = document.body.querySelector('#faction-panel-trade'), confirmDialog = document.createElement('dialog'), accept = document.createElement('button');
  for (const [element, id] of [[confirmDialog, 'confirm-dialog'], [accept, 'confirm-accept']]) element.id = id;
  document.body.append(confirmDialog); confirmDialog.append(accept);
  for (const id of ['confirm-title', 'confirm-text']) { const p = document.createElement('p'); p.id = id; confirmDialog.append(p); }
  document.getElementById = id => document.querySelector('#' + id);
  confirmDialog.showModal = () => { confirmDialog.open = true; }; confirmDialog.close = () => { confirmDialog.open = false; }; accept.value = 'ok';
  network.faction = { ...network.faction, trades: [{ id: 't1', from: other, to: own, give: bill(500), want: bill(0, 200) }] }; ux.render();
  dialog.querySelector('[data-id=t1]').querySelector('button').click();
  assert.deepEqual([get('#confirm-title').textContent, get('#confirm-text').textContent], ['Aceitar a troca?', 'Vocês entregam 200 Ligas e recebem 500 Ferro. A troca é imediata.']);
  accept.click(); await settle();
  assert.deepEqual(calls, [['trade', { act: 'accept', id: 't1' }]]);
  assert.deepEqual(said.at(-1), ['Troca feita: você entregou 200 Ligas e recebeu 500 Ferro.', false]);
});

test('what waits for an answer is news on its tab and on the button until that tab is open, and what comes again is news again', t => {
  const { create } = workspaceDOM(t), storage = new Map(), before = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  t.after(() => { globalThis.localStorage = before; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dialog = create('dialog', 'faction-dialog'), bar = create('div', 'faction-tabs', dialog), trigger = create('button', 'faction-open'), backs = [];
  create('small', 'faction-open-count', trigger); create('button', 'faction-dialog-close', dialog); create('output', 'faction-said', dialog);
  for (const id of ['faction', 'industry', 'trade', 'diplomacy']) { create('small', 'faction-news-' + id, create('button', 'faction-tab-' + id, bar)); create('section', 'faction-panel-' + id, dialog); }
  Object.assign(dialog, { showModal() { this.open = true; }, close() { this.open = false; this.dispatch('close'); },
    getBoundingClientRect: () => ({ left: 100, right: 700, top: 50, bottom: 650 }) });
  const $ = id => document.querySelector('#' + id), page = new FactionDialog({ $, back: () => backs.push('back') });
  const own = { ref: 'r1' }, other = { ref: 'r2' }, faction = { ref: 'r1', members: [{ id: 'j1', role: 'admin' }],
    invites: [{ factionId: 'f9' }], requests: [], trades: [{ id: 't1', from: other, to: own }, { id: 't2', from: own, to: other }],
    accords: [{ id: 'a1', from: other, to: own, acceptedAt: null }, { id: 'a2', from: other, to: own, acceptedAt: 3 }] };
  assert.deepEqual(factionNews(faction, 'j1'), { faction: ['invite:f9'], trade: ['trade:t1'], diplomacy: ['accord:a1'] });
  assert.deepEqual(factionNews({ ...faction, members: [{ id: 'j1', role: 'member' }] }, 'j1'), { faction: ['invite:f9'], trade: [], diplomacy: [] },
    'offers and proposals are news only to whoever answers them');
  page.tell(factionNews(faction, 'j1'));
  assert.deepEqual([$('faction-open-count').textContent, trigger.getAttribute('data-attention'), $('faction-news-trade').textContent], ['3', 'true', '1']);
  assert.equal(trigger.getAttribute('aria-label'), 'Facção · 3 novidades');
  trigger.click(); assert(dialog.open); assert.equal(page.tab, 'faction');
  assert.deepEqual([$('faction-open-count').textContent, $('faction-news-faction').hidden], ['2', true], 'the tab in sight is seen at once');
  $('faction-tab-trade').click(); assert.deepEqual([$('faction-panel-trade').hidden, $('faction-panel-faction').hidden], [false, true]);
  assert.equal($('faction-open-count').textContent, '1');
  page.say('Oferta enviada.'); assert.deepEqual([$('faction-said').hidden, $('faction-said').textContent], [false, 'Oferta enviada.']);
  t.mock.timers.tick(5000); assert.equal($('faction-said').hidden, true, 'what was said goes after a while');
  // A press that began and ended outside the window puts it away, and the keys go back to the field; the tab is kept.
  const outside = { target: dialog, clientX: 20, clientY: 20 };
  dialog.dispatch('pointerdown', outside); dialog.dispatch('click', outside);
  assert.deepEqual([dialog.open, backs, storage.get('impacto.faction-tab')], [false, ['back'], 'trade']);
  // A proposal that goes and comes back is news again; one still there and seen is not.
  page.tell(factionNews({ ...faction, trades: [] }, 'j1')); page.tell(factionNews(faction, 'j1'));
  assert.equal($('faction-open-count').textContent, '2');
  trigger.click(); assert.equal(page.tab, 'trade', 'the window opens on the tab last looked at');
  assert.equal($('faction-open-count').textContent, '1');
  dialog.dispatch('pointerdown', { target: $('faction-tab-trade'), clientX: 200, clientY: 100 }); dialog.dispatch('click', outside);
  assert(dialog.open, 'a drag from inside out of the window leaves it open');
  const esc = dialog.dispatch('cancel'); assert(esc.defaultPrevented); assert.deepEqual([dialog.open, backs.length], [false, 2], 'Esc closes it at once');
  trigger.click();
  const seen = new Set(['trade:t1', 'gone']);
  assert.deepEqual(unseen({ faction: [], trade: ['trade:t1', 'trade:t3'], diplomacy: [] }, seen), { faction: 0, industry: 0, trade: 1, diplomacy: 0 });
  assert.deepEqual([...seen], ['trade:t1'], 'what waits no more is forgotten');
  page.close();
});
