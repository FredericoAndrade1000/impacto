import test from 'node:test';
import assert from 'node:assert/strict';
import { configureLanguage } from '../src/i18n.ts';

// Configure before importing presentation tables, as the browser bootstrap does.
configureLanguage({ languages: ['en'] });
const { jobText, jobAdvice, serviceFeedback, unitServices, stockWants, veinRows, dismantlePlan } = await import('../src/faction-ui.ts');
const { bill } = await import('../src/economy.ts');

test('automatic jobs explain danger, delivery and service receipts in English while preserving player names', () => {
  const unit = { id: 'a', auto: true, supplies: bill(1), job: { phase: 'return', reason: 'danger' } };
  assert.equal(jobText(unit), 'returning to base with remaining cargo · dangerous destination');
  assert.match(jobAdvice(unit), /another faction’s territory.*manual order/);
  const name = 'Ferro {0}';
  assert.equal(jobText({ ...unit, job: { kind: 'rearm', phase: 'deliver', targetId: 'b' } }, { name: () => name }),
    'delivering supplies to ' + name);
  assert.equal(jobText({ ...unit, job: { kind: 'haul', phase: 'home', post: true } }), 'taking cargo to outpost');
  assert.equal(jobText({ ...unit, job: { kind: 'pave', phase: 'work' } }), 'paving the road');
  assert.equal(serviceFeedback({ refilled: { at: 0, until: 5, rounds: 3, fuelLitres: 0 } }, 1).text, 'Received 3 rounds');
  assert.match(unitServices({ service: { kind: 'turn', aloft: true } }).held, /Turning in the air: keeps flying/);
});

test('resource cards and grouped refusals translate authored text without treating names as keys', () => {
  const name = 'Ferro {0}', wants = stockWants({ stock: bill() }, { name, price: bill(20) });
  assert.match(wants.ferro.text, /manufacture Ferro \{0\}/);
  assert.match(wants.ferro.text, /missing 20/);
  const [vein] = veinRows([{ id: 'v', x: 10, material: 'ferro', feature: 'outcrop', active: true,
    reserve: 1000, left: 500, stock: 200, seen: true }], null);
  assert.match(vein.name, /Iron.*outcrop/);
  assert.match(vein.lines.join(' '), /Reserve.*Ready/);
  const plan = dismantlePlan([{ id: 'a', vehicle: {}, atBase: false }, { id: 'b', vehicle: {}, atBase: false }]);
  assert.match(plan.reason, /2 outside base/);
});
