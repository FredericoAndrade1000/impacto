import test from 'node:test';
import assert from 'node:assert/strict';
import { industryPage, industryReason } from '../src/industry-ui.ts';
import { BASIC_INDUSTRY } from '../src/industry.ts';
import { bill } from '../src/economy.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { configureLanguage } from '../src/i18n.ts';

const faction = (stock = bill(90000, 10000, 10000, 1500)) => ({ id: 'f1', industry: { levels: { ...BASIC_INDUSTRY }, pending: null },
  stock, base: { x: 0 }, members: [{ id: 'a', role: 'leader' }, { id: 'b', role: 'member' }] });
test('three next-step cards explain cost shortages, authority and absent base without hiding benefits', () => {
  const page = industryPage(faction(), 'a'); assert.equal(page.cards.length, 3);
  assert(page.cards.every(card => !card.disabled)); assert.equal(page.cards.find(card => card.facility === 'hangar').upgrade.id, 'hangar-i');
  const poor = industryPage(faction(bill()), 'a'); assert(poor.cards.every(card => card.disabled && /Faltam/.test(card.reason)));
  assert(industryPage(faction(), 'b').cards.every(card => card.disabled && /Só o líder/.test(card.reason)));
  assert(industryPage({ ...faction(), base: null }, 'a').cards.every(card => /Reconstrua/.test(card.reason)));
  assert.equal(industryPage(null, 'a'), null);
});
test('pending upgrade shows the field clock and leaves the current capacity readable', () => {
  const state = faction(); state.industry.pending = { id: 1, upgrade: 'workshop-ii', startedAt: 10, until: 130, cost: bill(), by: 'a' };
  const page = industryPage(state, 'a', 70), active = page.cards.find(card => card.facility === 'workshop');
  assert.equal(active.level, 1); assert.equal(active.remaining, 60); assert.equal(active.progress, .5);
  assert(page.cards.every(card => card.disabled));
});
test('workshop refusals name the exact facility in Portuguese and English; private designs remain available', t => {
  const source = createStructuredTemplate('heavy'), state = faction();
  assert.match(industryReason(source, state), /Oficina III/); assert.equal(industryReason(source, null), '');
  state.industry.levels.workshop = 3; assert.equal(industryReason(source, state), '');
  source.plates[0].material = 'hha';
  assert.match(industryReason(source, state), /Processamento II/, 'editing the same source object must refresh its requirements');
  configureLanguage({ languages: ['en'] }); t.after(() => configureLanguage({ languages: ['pt-BR'] }));
  state.industry.levels.workshop = 1;
  assert.match(industryReason(source, state), /Requires Workshop III/);
});
