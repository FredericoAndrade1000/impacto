import test from 'node:test';
import assert from 'node:assert/strict';
import { stockWants } from '../src/faction-ui.ts';
import { bill } from '../src/economy.ts';

// What the field tells of the stocks (server/stock-wants.ts), as the page says it over the field.
const faction = (wants, stock = bill(500, 0, 2000, 40)) => ({ id: 'green', stock, wants });

test('a stock something stands still for says what and how much, one short of all that asks of it too, and the rest nothing', () => {
  const told = stockWants(faction({
    ligas: { level: 'waiting', missing: 1200, for: [{ kind: 'work', n: 1, name: 'Casamata' }, { kind: 'repair', n: 2 }] },
    combustivel: { level: 'short', missing: 900, for: [{ kind: 'fuel', n: 5 }] },
    ferro: { level: 'short', missing: 4500, for: [{ kind: 'ammo', n: 1, fixed: 1 }, { kind: 'repair', n: 3, fixed: 1 }, { kind: 'work', n: 2 }, { kind: 'road', n: 1 }] } }));
  assert.deepEqual(Object.keys(told).sort(), ['combustivel', 'ferro', 'ligas'], 'Sílica has nothing to say');
  assert.deepEqual(told.ligas, { level: 'waiting', text: 'Parado por falta: obra Casamata e reparo de 2 veículos · faltam 1.200' });
  assert.deepEqual(told.combustivel, { level: 'short', text: 'Não cobre tudo: abastecimento de 5 veículos · faltam 900 L' });
  assert.equal(told.ferro.text, 'Não cobre tudo: munição de 1 estrutura, reparo de 3 construções, 2 obras e estrada de asfalto · faltam 4.500');
  assert.deepEqual(stockWants(faction({})), {});
  assert.deepEqual(stockWants(null), {});
});

test('a vehicle the stocks alone kept the player from fabricating stands still for the stocks it costs more of, until they have it', () => {
  const fabrication = { name: 'Tanque leve', price: bill(800, 0, 100, 20) };
  assert.deepEqual(stockWants(faction({}), fabrication), { ferro: { level: 'waiting', text: 'Parado por falta: fabricar Tanque leve · faltam 300' } },
    'only the iron is short of it');
  // Beside what the field says stands still, and over what it says is short only.
  const told = stockWants(faction({ ferro: { level: 'waiting', missing: 1000, for: [{ kind: 'work', n: 1, name: 'Posto' }] } }), fabrication);
  assert.equal(told.ferro.text, 'Parado por falta: obra Posto e fabricar Tanque leve · faltam 1.300');
  assert.deepEqual(stockWants(faction({ ferro: { level: 'short', missing: 50, for: [{ kind: 'repair', n: 1 }] } }), fabrication).ferro,
    { level: 'waiting', text: 'Parado por falta: fabricar Tanque leve · faltam 300' });
  assert.deepEqual(stockWants(faction({}, bill(800, 0, 2000, 40)), fabrication), {}, 'with the stocks for it, it waits for nothing');
});
