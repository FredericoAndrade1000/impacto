// Local, in-memory SharedRoom only. No connection to the live field or saves.
// --expect-fixed turns both former grant loops into regression checks.
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { bill, billSum, billTotal, STOCK_IDS, STARTING_STOCK } from '../src/economy.ts';
import { INDUSTRY_PROPOSAL } from './industry-proposal.ts';

const room = new SharedRoom({ starter: false, build: false, fog: false,
  base: index => [-100, 15000, 30000, 45000, 60000][index % 5] });
const recordValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
try {
  const address = 'industry-offline-audit', main = room.join('Main', '', address), donor = room.join('Donor', '', address);
  const send = (player: { playerId: string }, type: string, data: Record<string, unknown> = {}): unknown => room.command(player.playerId, { type, ...data });
  const faction = (player: { playerId: string }) => { const state = room.players.get(player.playerId); assert(state); return room.faction(state); };
  const donate = () => {
    const stock = faction(donor).stock, give = bill(Math.floor(stock.ferro), Math.floor(stock.ligas), Math.floor(stock.silica), Math.floor(stock.combustivel));
    if (billTotal(give) === 0) return;
    const offer = send(donor, 'trade', { act: 'offer', ref: faction(main).ref, give, want: bill() });
    assert(recordValue(offer) && typeof offer.offered === 'string', 'The real trade command must return its offer id');
    send(main, 'trade', { act: 'accept', id: offer.offered });
  };
  const split = () => {
    send(main, 'invite', { playerId: donor.playerId });
    send(donor, 'join-faction', { factionId: faction(main).id });
    send(main, 'member', { playerId: donor.playerId, act: 'remove' });
  };
  const initial = { ...faction(main).stock }, cycles = 8;
  for (let n = 0; n < cycles; n++) { donate(); split(); }
  const afterSplits = { ...faction(main).stock }, gain = billSum(afterSplits, initial, -1);
  const repeatedGrantDetected = STOCK_IDS.some(id => gain[id] > STARTING_STOCK[id])
    || billTotal(faction(donor).stock) > 0 || room.enlisted(faction(donor)).length > 0;
  const candidateCost = INDUSTRY_PROPOSAL.upgrades.reduce((total, n) => billSum(total, n.cost), bill());

  // A stranded identity may receive its first genuine recovery. Dismantling and
  // donating it must not reset the subsidy date by recreating the faction.
  donate();
  const firstAid = send(donor, 'recover');
  assert(recordValue(firstAid) && typeof firstAid.selected === 'string', 'First recovery must return the vehicle it selected');
  send(donor, 'remove', { actorId: firstAid.selected }); donate(); split(); donate();
  const quote = room.recovery(faction(donor)), beforeRetry = JSON.stringify(room.keep());
  let repeatedAidGranted = false, refusedBy: string | null = null;
  try { send(donor, 'recover'); repeatedAidGranted = true; }
  catch (error) { assert(error instanceof Error); refusedBy = error.message; }
  const refusedWithoutMutation = !repeatedAidGranted && JSON.stringify(room.keep()) === beforeRetry;
  assert.equal(room.field.time, 0);
  console.log(JSON.stringify({ scope: 'offline reproduction, starter vehicles disabled; no live field edited',
    cycles, simulatedSeconds: room.field.time, countedIdentitiesAtAddress: room.newcomersOf(address).length,
    initialMainStock: initial, mainStockAfterSplits: afterSplits, facilities: faction(main).industry.levels,
    repeatedGrantDetected, candidateCost,
    canFinanceAllSixWithoutProduction: STOCK_IDS.every(id => afterSplits[id] >= candidateCost[id]),
    recoveryLoop: { firstAidGranted: Boolean(firstAid.selected), repeatedAidGranted, wait: quote?.wait ?? 0,
      refusedBy, refusedWithoutMutation },
    conclusion: repeatedGrantDetected || repeatedAidGranted ? 'BLOCKER: repeat grant/subsidy remains'
      : 'Fixed identities cannot repeat starting grants or bypass the existing 1800-second subsidy interval' }, null, 2));
  if (process.argv.includes('--expect-fixed')) {
    assert.equal(repeatedGrantDetected, false, 'Repeated foundation grant remains reproducible');
    assert.equal(repeatedAidGranted, false, 'Recreating the faction still resets recovery');
    assert(quote); assert.equal(quote.wait, 1800); assert(refusedWithoutMutation);
  }
} finally { room.field.dispose(); }
