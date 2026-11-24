import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFeedback } from '../src/faction-ui.ts';
import { fieldPanel } from '../src/field-panel.ts';
import { bill, load } from '../src/economy.ts';

const unit = (patch = {}) => ({ id: 'truck', still: true, calm: false, calmUntil: 103, service: null,
  rearm: bill(0, 0, 0, 120), point: { supplier: null, held: '', resupply: bill(0, 0, 0, 120) }, ...patch });

test('the refill clock counts the real remaining safety wait without starting a fictitious service', () => {
  const quote = unit(), before = structuredClone(quote);
  assert.deepEqual(serviceFeedback(quote, 100), { kind: 'waiting', text: 'Abastecer em 3 s · aguardando segurança' });
  assert.equal(serviceFeedback(quote, 101.5).text, 'Abastecer em 2 s · aguardando segurança');
  assert.equal(serviceFeedback(quote, 103), null);
  assert.equal(serviceFeedback(quote, 104), null, 'a stale quote never claims refilling or a zero-second service');
  assert.deepEqual(quote, before, 'feedback never changes the server quote');
});

test('both recipient and supplier must be safe, and the later real deadline wins', () => {
  const point = { supplier: 'supplies', held: 'combat', calmUntil: 107, resupply: bill(30, 0, 0, 120) },
    quote = unit({ calmUntil: 104, rearm: bill(60, 0, 0, 120), point });
  assert.equal(serviceFeedback(quote, 100).text, 'Remuniciar e abastecer em 7 s · aguardando segurança dos suprimentos');
  assert.equal(serviceFeedback({ ...quote, calmUntil: 109 }, 100).text, 'Remuniciar e abastecer em 9 s · aguardando segurança');
  assert.equal(serviceFeedback({ ...quote, calm: true, calmUntil: undefined }, 100).text,
    'Remuniciar e abastecer em 7 s · aguardando segurança dos suprimentos');
  assert.equal(serviceFeedback({ ...quote, calm: true, point: { ...point, calmUntil: undefined } }, 100), null);
});

test('the countdown is absent when supplies cannot actually be given', () => {
  const quote = unit();
  for (const patch of [
    { still: false }, { point: null }, { rearm: bill() }, { point: { ...quote.point, resupply: bill() } },
    { calmUntil: undefined }, { calm: true, calmUntil: undefined },
    ...['build', 'repair', 'turn'].map(kind => ({ service: { kind, until: 110 } })),
    ...['moving', 'build', 'repair', 'turn'].map(held => ({ point: { ...quote.point, held } })),
  ]) assert.equal(serviceFeedback({ ...quote, ...patch }, 100), null, JSON.stringify(patch));
  assert.equal(serviceFeedback(null, 100), null);
  assert.equal(serviceFeedback(quote, undefined), null, 'wall-clock time is never substituted');
});

test('a partial payer names only what it can give, including a supply vehicle fuelling itself', () => {
  const quote = unit({ rearm: bill(60, 0, 0, 120) });
  assert.match(serviceFeedback({ ...quote, point: { ...quote.point, resupply: bill(30) } }, 100).text, /^Remuniciar em 3 s/);
  assert.match(serviceFeedback(quote, 100).text, /^Abastecer em 3 s/);
  assert.equal(serviceFeedback({ ...quote, point: { ...quote.point, supplier: quote.id, held: 'combat', calmUntil: 103 } }, 100).text,
    'Abastecer em 3 s · aguardando segurança');
});

test('a receipt reports actual partial quantities for its four seconds even after leaving the point', () => {
  const quote = unit({ refilled: { at: 100, until: 104, fuelLitres: 12.5, rounds: 30 }, point: null, still: false }),
    before = structuredClone(quote);
  assert.deepEqual(serviceFeedback(quote, 100), { kind: 'received', text: 'Recebeu 12,5 L · 30 tiros' });
  assert.equal(serviceFeedback(quote, 103.99).text, 'Recebeu 12,5 L · 30 tiros');
  assert.equal(serviceFeedback(quote, 99), null);
  assert.equal(serviceFeedback(quote, 104), null);
  assert.deepEqual(quote, before);
  assert.equal(serviceFeedback(unit({ refilled: { at: 100, until: 104, fuelLitres: 0, rounds: 1 } }), 100).text, 'Recebeu 1 tiro');
  assert.equal(serviceFeedback(unit({ refilled: { at: 100, until: 104, fuelLitres: .001, rounds: 0 } }), 100).text, 'Recebeu menos de 0,01 L');
  assert.equal(serviceFeedback(unit({ calm: true, refilled: { at: 100, until: 104, fuelLitres: 0, rounds: 0 } }), 100), null);
});

function panel(quotes, { time = 100, manual = null, picked = ['truck'], fuelLitres = 0 } = {}) {
  const units = quotes.map((quote, i) => ({ value: bill(9000), built: bill(10000), repair: bill(), repairSeconds: 0,
    atBase: true, cargo: load(), fill: { solid: 0, liquid: 0, supplies: 0 }, loading: null, supplies: null,
    serves: false, load: null, mend: null, mender: null, ...quote, id: i ? 'other' : 'truck' })),
    sharedFaction = { id: 'green', stock: bill(60000, 0, 0, 1500), yard: load(), base: { x: 1000 },
      members: [], known: [], strangers: [], ranking: [], invites: [], request: null, requests: [], library: [], count: units.length, units, wrecks: [], deposits: [] },
    state = { shared: true, time, localPlayerId: 'player', faction: sharedFaction, plates: [],
      squad: { manual, out: [], units: units.map(({ id }) => ({ id, stance: 'return', defeated: false })) },
      actors: units.map(({ id }) => ({ id, name: 'Caminhão', ownerId: 'player', team: 'green', x: 1000,
        vehicle: { x: 1000, y: 1, fuelLitres, fuelStarved: fuelLitres === 0, rangeKm: 100 } })),
      modules: units.map(({ id }) => ({ id: id + ':command', actorId: id, kind: 'command', health: 100, maxHealth: 100 })) };
  return fieldPanel({ tab: 'test', shared: true, connected: true, state, faction: sharedFaction, playerId: 'player', picked });
}

test('the feedback of a construction has its own field and preserves primary problems, order state and advice', () => {
  const waiting = panel([unit()]), legacy = panel([unit({ calmUntil: undefined })]),
    row = waiting.squad.units[0], old = legacy.squad.units[0];
  assert.deepEqual([row.status, row.doing, row.trouble, waiting.advice, waiting.services],
    [old.status, old.doing, old.trouble, legacy.advice, legacy.services]);
  assert.equal(row.status, 'sem combustível');
  assert.equal(row.feedback.text, 'Abastecer em 3 s · aguardando segurança');
  assert.equal(waiting.held, legacy.held, 'feedback does not displace an existing service refusal');
  assert.equal(legacy.squad.units[0].feedback, null);

  const receipt = unit({ calm: true, point: null, still: false, service: { kind: 'turn', until: 106 },
    refilled: { at: 100, until: 104, fuelLitres: 120, rounds: 30 } }), shown = panel([receipt], { manual: 'truck' });
  assert.equal(shown.squad.units[0].status, 'virando · 6 s', 'turning retains its primary timer');
  assert.equal(shown.squad.units[0].feedback.text, 'Recebeu 120 L · 30 tiros');
});

test('a partial receipt never conceals the lack of supplies for the remaining ammunition', () => {
  const quote = unit({ atBase: false, calm: true, rearm: bill(2952),
    point: { supplier: 'supplies', stock: bill(), held: '', resupply: bill() },
    refilled: { at: 100, until: 104, fuelLitres: 0, rounds: 50 } }), shown = panel([quote]);
  assert.match(shown.held, /não pagam a munição: Ferro 0 de 2\.952/);
  assert.equal(shown.squad.units[0].feedback.text, 'Recebeu 50 tiros', 'receipt and unpaid remainder have separate lines');
});

test('group receipts remain individually readable while ticking feedback does not rebuild the column', () => {
  const receipt = unit({ calm: true, point: null, refilled: { at: 100, until: 104, fuelLitres: 120, rounds: 30 } }),
    group = panel([receipt, receipt], { picked: ['truck', 'other'] });
  assert.equal(group.held, '', 'a group is not mistaken for one serviced vehicle');
  assert(group.squad.units.every(row => row.feedback.text === 'Recebeu 120 L · 30 tiros'));
  const first = panel([unit()]).squad.units, later = panel([unit()], { time: 101 }).squad.units;
  assert.notEqual(first[0].feedback.text, later[0].feedback.text);
  // The column is built again only when what it is built of changes: who is in it, at what place and in which group.
  const built = units => units.map(u => [u.id, u.number, u.group]);
  assert.deepEqual(built(first), built(later), 'the countdown belongs to the readings of the column, not to what builds it');
});
