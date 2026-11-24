import test from 'node:test';
import assert from 'node:assert/strict';
import { bill } from '../src/economy.ts';
import { repairOffer, serviceOffers } from '../server/service-policy.ts';

const actor = () => ({ id: 'recipient', blueprint: { modules: [{ id: 'tank', kind: 'fuel' }] } });
const quote = () => ({ repair: bill(100), mendable: [{ id: 'engine', stock: 'ferro', cost: 100 }],
  rearm: bill(0, 0, 0, 10), full: { tank: { fuelLitres: 10 } }, levels: { tank: { fuelLitres: 0 } } });
const point = (iron, fuel = 0, held = '') => ({ stock: bill(iron, 0, 0, fuel), held });

test('repair prefers a whole quote, then the nearest meaningful partial repair, without spending stock', () => {
  const near = point(50), far = point(100), wanted = quote(), before = structuredClone([near, far, wanted]);
  assert.deepEqual(repairOffer([near, far], wanted), [far, null]);
  const [chosen, partial] = repairOffer([near, point(0)], wanted);
  assert.equal(chosen, near); assert.equal(partial.cost.ferro, 50); assert.equal(partial.pieces[0].share, .5);
  assert.deepEqual([near, far, wanted], before);
  assert.deepEqual(repairOffer([point(0)], wanted), [null, null]);
});

test('a piece paid from two stocks is mended in part as far as the scarcer of them goes, each paying that share', () => {
  // A radar of glass fibre: its housing paid from Sílica, its equipment from Ferro (economy.ts `kept`).
  const radar = { repair: bill(1000, 0, 100), mendable: [{ id: 'radar', stock: 'silica', cost: 1100, costs: { silica: 100, ferro: 1000 } }],
    rearm: bill(), full: {}, levels: {} };
  const mended = stock => repairOffer([{ stock, held: '' }], radar)[1];
  assert.deepEqual(mended(bill(1000, 0, 50)), { pieces: [{ id: 'radar', share: .5 }], cost: bill(500, 0, 50), seconds: mended(bill(1000, 0, 50)).seconds });
  assert.deepEqual(mended(bill(300, 0, 100)).pieces, [{ id: 'radar', share: .3 }]);
  assert.deepEqual(mended(bill(300, 0, 100)).cost, bill(300, 0, 30));
  // With none of one of them, nothing of it is mended.
  assert.equal(mended(bill(1000)), null);
});

test('refill chooses the nearest ready point that actually supplies reserves, including a partial load', () => {
  const held = point(100, 10, 'moving'), empty = point(0), near = point(0, 4), far = point(100, 10),
    offer = serviceOffers(actor(), quote(), [held, empty, near, far]);
  assert.equal(offer.point, near); assert.equal(offer.rearm.combustivel, 4);
  assert.equal(offer.mender, far); assert.equal(offer.part, null);
});

test('a supplier can fuel itself while another point pays for its repair', () => {
  const recipient = actor(), own = { ...point(100, 10), supplier: recipient }, other = point(50),
    offer = serviceOffers(recipient, quote(), [own, other]);
  assert.equal(offer.point, own); assert.equal(offer.mender, other); assert.equal(offer.part.cost.ferro, 50);
  assert.equal(serviceOffers(recipient, quote(), [own]).mender, undefined);
});

test('when nobody can serve, the display retains the closest explanation without granting resources', () => {
  const busy = point(0, 0, 'combat'), offer = serviceOffers(actor(), quote(), [busy]);
  assert.equal(offer.point, busy); assert.equal(offer.mender, busy); assert.equal(offer.part, null);
  assert.deepEqual(offer.rearm, bill());
  assert.deepEqual(serviceOffers(actor(), quote(), []), { point: undefined, rearm: bill(), mender: undefined, part: null });
});
