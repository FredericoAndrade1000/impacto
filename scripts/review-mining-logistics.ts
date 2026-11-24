// Paid fleets on real terrain. This is a bounded economic comparison, not a
// new-player opening, a PvP balance claim or a hardware benchmark.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SharedRoom } from '../server/room.ts';
import { structureBill } from '../server/field-construction.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { bill, billSum, carriedBy, supplied, BASE_RADIUS, LOAD_REACH } from '../src/economy.ts';
import { depositsNear } from '../src/deposits.ts';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';
import { initNativeDynamics, nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { TemplateId } from '../src/construction-template-catalogue.ts';

await initNativeDynamics(); assert.equal(nativeDynamicsRuntime, 'native');
const STEADY = { pace: () => 1 }, PURSE = bill(150000, 10000, 10000, 3000);
type Strategy = 'mobile' | 'fixed';
interface Scenario { id: string; distance: number; direction: -1 | 1; scarce?: boolean; loss?: boolean }
const scenarios: Scenario[] = [
  { id: 'near', distance: 500, direction: 1 },
  { id: 'middle', distance: 1500, direction: -1 },
  { id: 'far', distance: 4000, direction: 1 },
  { id: 'scarce', distance: 1500, direction: -1, scarce: true },
  { id: 'hauler-loss', distance: 1500, direction: -1, loss: true },
];
function option(name: string): string | undefined {
  const at = process.argv.indexOf(name); if (at < 0) return undefined;
  const value = process.argv[at + 1]; assert(value && !value.startsWith('--'), `${name} needs a value`); return value;
}
const seconds = Number(option('--seconds') ?? 3600); assert(Number.isInteger(seconds) && seconds >= 300 && seconds <= 21600);
const carrierCount = Number(option('--carriers') ?? 2); assert(carrierCount === 1 || carrierCount === 2);
const chosen = option('--scenario'), strategy = option('--strategy'), earlyHaul = process.argv.includes('--early-haul');
assert(!chosen || scenarios.some(s => s.id === chosen)); assert(!strategy || ['mobile', 'fixed'].includes(strategy));
const cases = scenarios.filter(s => !chosen || s.id === chosen)
  .flatMap(s => (['mobile', 'fixed'] as const).filter(id => !strategy || id === strategy).map(strategy => ({ ...s, strategy })));

function run(scenario: Scenario & { strategy: Strategy }) {
  let base = 0;
  const room = new SharedRoom({ starter: false, stock: PURSE, fog: false, base: () => base, random: () => .5 });
  try {
    const ground = room.world.terrain, site = room.deposits.filter(s => s.material === 'ferro' &&
      depositsNear(room.deposits, s.x, 2 * LOAD_REACH).length === 1 &&
      Math.max(...[-9, -5, 0, 5, 9].map(dx => ground.height(s.x + dx))) -
      Math.min(...[-9, -5, 0, 5, 9].map(dx => ground.height(s.x + dx))) < .3)
      .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
    assert(site, 'A real isolated near-level iron site is needed for both strategies');
    base = site.x - scenario.direction * scenario.distance;
    const joined = room.join('Comparação de mineração'), owner = room.players.get(joined.playerId); assert(owner?.squad);
    const faction = room.faction(owner), start = room.world.time, initialStock = { ...faction.stock },
      initialReserve = scenario.scarce ? 1000 : site.reserve;
    if (scenario.scarce) room.veins.set(site.id, initialReserve);
    let regrown = 0;
    const replenish = room.replenish.bind(room);
    room.replenish = elapsed => { const before = room.left(site); replenish(elapsed); regrown += room.left(site) - before; };
    const purchases: { model: string; id: string; at: number; cost: SupplyBill; seconds: number }[] = [],
      haulIds: string[] = [], orders = new Set<string>(), previousCargo = new Map<string, number>(),
      deliveries: { id: string; at: number; kg: number }[] = [], lastLoaded = new Map<string, number>(),
      samples: unknown[] = [], transitions: unknown[] = [], previousPhase = new Map<string, string>();
    let fleetCost = bill(), serviceCost = bill(), workId: string | null = null, workCost = bill(),
      completedAt: number | null = null, workOpenedAt: number | null = null, deliveredKg = 0, firstDeliveryAt: number | null = null,
      loss: { id: string; at: number; cargoKg: number; fuelLitres: number } | null = null, interventions = 0, purchaseRounding = 0,
      retiredCargoKg = 0, retiredFuelLitres = 0;
    const charge = room.charge.bind(room);
    room.charge = (point, cost) => { serviceCost = billSum(serviceCost, cost); charge(point, cost); };
    const fuel = (id: string) => room.world.modules.filter(p => p.actorId === id && p.kind === 'fuel')
      .reduce((sum, p) => sum + (p.kind === 'fuel' ? p.fuelLitres : 0), 0),
      cargo = (id: string) => carriedBy(room.pieces(id)).carried.ferro,
      supplies = () => room.owned(owner.id).reduce((total, actor) => billSum(total, supplied(carriedBy(room.crates(actor.id)).carried)), bill()),
      inventoryFuel = () => faction.stock.combustivel + supplies().combustivel +
        room.owned(owner.id).reduce((sum, actor) => sum + fuel(actor.id), 0) +
        room.works.of(faction.id).reduce((sum, work) => sum + work.delivered.combustivel, 0);
    // Ordinary wreck expiry is a recorded loss, not delivery or fuel combustion.
    const discard = room.discard.bind(room);
    room.discard = id => {
      if (haulIds.includes(id)) { retiredCargoKg += cargo(id); retiredFuelLitres += fuel(id); }
      discard(id);
    };
    const models: TemplateId[] = ['construction-truck', ...Array<TemplateId>(carrierCount).fill(scenario.strategy === 'mobile' ? 'mining-truck' : 'truck')];
    let nextPurchaseAt = 0;
    for (let tick = 0; tick < seconds * 60; tick++) {
      const now = room.world.time - start;
      if (purchases.length < models.length && now + 1e-6 >= nextPurchaseAt) {
        const model = models[purchases.length]!;
        const made = room.publish(owner.id, createConstruction(model)); assert('actor' in made);
        const id = made.actor.id;
        fleetCost = billSum(fleetCost, made.cost); purchaseRounding += made.cost.combustivel - fuel(id);
        purchases.push({ model, id, at: now, cost: made.cost, seconds: made.seconds }); interventions++;
        if (model !== 'construction-truck') { haulIds.push(id); previousCargo.set(id, 0); }
        nextPurchaseAt = now + .5; // Ordinary publication cooldown and paid assembly remain active.
      } else if (scenario.strategy === 'fixed' && purchases.length === models.length && !workId && now + 1e-6 >= nextPurchaseAt) {
        const x = site.x + scenario.direction * 5, source = createConstruction('mining-site');
        workCost = structureBill(room, source, x, scenario.direction);
        const opened = room.publish(owner.id, source, { x, facing: scenario.direction }); assert('work' in opened);
        workId = opened.work.id; workOpenedAt = now; interventions++;
      }
      // Stage empty carriers at base until the work is built; they must not
      // park inside the future foundation while its constructor is approaching.
      for (const id of haulIds) if (!orders.has(id) && !room.record(room.world.actor(id)!).service &&
        (scenario.strategy === 'mobile' || completedAt !== null || earlyHaul)) {
        room.command(owner.id, { type: 'squad', order: 'haul', ids: [id], depositId: site.id });
        orders.add(id); interventions++;
      }
      if (scenario.loss && !loss && now >= 900 && haulIds.length === carrierCount) {
        const id = haulIds[0]!;
        loss = { id, at: now, cargoKg: cargo(id), fuelLitres: fuel(id) };
        for (const piece of room.world.modules.filter(p => p.actorId === id && p.kind === 'command'))
          room.world.game().call({ op: 'setPartState', owner: room.world.game().handle(piece), state: { health: 0 } });
      }
      if (tick % 3600 === 0) room.command(owner.id, { type: 'ping' });
      room.step(STEADY);
      if (workId && completedAt === null && room.world.actor(workId)) {
        completedAt = room.world.time - start;
        purchaseRounding += workCost.combustivel - fuel(workId);
      }
      for (const id of haulIds) {
        const actor = room.world.actor(id), carried = cargo(id), before = previousCargo.get(id) ?? 0,
          unit = owner.squad.units.get(id), phase = !actor ? 'retired' : unit?.halt || unit?.haul?.phase || (room.record(actor).service ? 'manufacturing' : 'idle');
        if (carried > before) lastLoaded.set(id, carried);
        if (actor && room.still(actor) && room.atDepot(faction, actor) && before > carried) {
          deliveredKg += before - carried; firstDeliveryAt ??= room.world.time - start;
          if (carried < 1e-6 && before > 0) deliveries.push({ id, at: room.world.time - start, kg: lastLoaded.get(id) ?? before });
        }
        previousCargo.set(id, carried);
        if (previousPhase.get(id) !== phase) {
          transitions.push({ id, at: room.world.time - start, phase, reason: unit?.reason, cargoKg: carried }); previousPhase.set(id, phase);
        }
      }
      if (tick % 1800 === 0) samples.push({ seconds: room.world.time - start, deliveredKg, pileKg: room.extracted.get(site.id) ?? 0,
        leftKg: room.left(site), stock: { ...faction.stock }, supplies: supplies(),
        fleet: room.owned(owner.id).map(actor => ({ id: actor.id, x: room.position(actor), fuelLitres: fuel(actor.id), cargoKg: cargo(actor.id),
          job: room.supplyDispatch.view(actor.id), builder: actor.blueprint.modules.some(piece => piece.kind === 'builder') ? room.builderRefusal(actor) : null })) });
    }
    const activeCargoKg = haulIds.filter(id => !room.world.actor(id)?.defeated).reduce((sum, id) => sum + cargo(id), 0),
      wreckCargoKg = haulIds.filter(id => room.world.actor(id)?.defeated).reduce((sum, id) => sum + cargo(id), 0),
      pileKg = room.extracted.get(site.id) ?? 0, leftKg = room.left(site),
      conservationErrorKg = initialReserve + regrown - leftKg - pileKg - activeCargoKg - wreckCargoKg - retiredCargoKg - deliveredKg,
      pending = room.works.of(faction.id).map(work => ({ id: work.id, progress: work.progress, delivered: work.delivered, missing: room.works.need(work) })),
      held = supplies(), heaps = room.works.heapsOf(faction.id).map(heap => heap.stock),
      completedCost = completedAt !== null ? workCost : bill(),
      ironLedgerError = faction.stock.ferro + faction.yard.ferro + held.ferro +
        pending.reduce((sum, work) => sum + work.delivered.ferro, 0) + heaps.reduce((sum, heap) => sum + heap.ferro, 0) +
        fleetCost.ferro + completedCost.ferro + serviceCost.ferro - deliveredKg - initialStock.ferro,
      fuelSpent = initialStock.combustivel - inventoryFuel() - purchaseRounding;
    assert(Math.abs(conservationErrorKg) < 1e-4, `Geological reserve, regrowth, pile, cargo and delivery must conserve iron: ${conservationErrorKg}`);
    assert(Math.abs(ironLedgerError) < 1e-4, `Refined stock, supply cargo, paid works and service must conserve the purse: ${ironLedgerError}`);
    assert(Object.values(faction.stock).every(value => Number.isFinite(value) && value >= -1e-6));
    return { scenario, carrierCount, seconds, baseX: base, site, budget: initialStock, purchases, fleetCost, workCost, workOpenedAt, completedAt,
      firstDeliveryAt, deliveredKg, deliveredPerHour: deliveredKg * 3600 / seconds, deliveries, pileKg, leftKg, regrownKg: regrown,
      activeCargoKg, wreckCargoKg, retiredCargoKg, retiredFuelLitres, initialReserveKg: initialReserve, conservationErrorKg, ironLedgerError,
      stock: { ...faction.stock }, yard: { ...faction.yard }, supplyCargo: held, pending, serviceCost, fuelSpent,
      fuelConsumedLitres: fuelSpent - retiredFuelLitres, purchaseRounding,
      netBaseIron: faction.stock.ferro + faction.yard.ferro - initialStock.ferro, loss, interventions,
      faults: [...room.faults], transitions, samples };
  } finally { room.world.dispose(); }
}
const results = cases.map(scenario => {
  const result = run(scenario);
  console.log(JSON.stringify({ scenario: scenario.id, strategy: scenario.strategy, firstDeliveryAt: result.firstDeliveryAt,
    deliveredKg: result.deliveredKg, pileKg: result.pileKg, completedAt: result.completedAt, fuelSpent: result.fuelSpent, faults: result.faults }));
  return result;
});
const repeated = process.argv.includes('--verify-repeat');
if (repeated) assert.deepEqual(cases.map(run), results, 'Paid mining/logistics cases must repeat exactly');
const report = { scope: 'Native mobile/fixed mining logistics with equal finite purse and simulated time horizon',
  runtime: nativeRuntimeInfo('native'), assumptions: {
    repeated, budget: 'Both start with 150k iron, 10k alloys, 10k silica, 3000 L, Basic Industry and no granted fleet. Every vehicle is purchased; normal assembly, publication cooldown and fixed construction are included.',
    fleets: `Both buy one ordinary constructor and ${carrierCount} carrier(s): mining trucks for mobile, cargo trucks plus one fixed mining site for fixed. Cash not spent remains in the comparison; auxiliary cargo is an asset, not mining income.`,
    knowledge: 'Same real isolated near-level iron site for both, base at the stated distance, full terrain knowledge; no roads or site are moved. Normal Native driving, power, fuel and carrying geometry.',
    earlyHaul,
    control: earlyHaul ? 'Traffic stress: order fixed carriers toward the empty site before its mining work is built. They may obstruct the constructor approach. No manual clearance is given.' :
      'One haul order per carrier after assembly; fixed carriers stage at base until the mining work completes so they do not occupy its construction approach. Automatic constructor supply/build/support continues normally. No reorders, teleports, reserve replenishment or fuel overrides during runs. Decisions fixed at normal pace to exclude test CPU contention.',
    conditions: 'Scarcity starts the geological reserve at 1000 kg; it regrows normally. Loss removes the command module of one carrier at 900 s, retaining its wreck and cargo; no replacement is purchased. Neither represents a full battle history.',
    metrics: 'Delivered raw iron is counted only as cargo physically leaves carriers at a depot. Piles, in-transit cargo, wreck cargo, expired wreck losses, auxiliary stock and purchased capital are separate. Fuel sums stock, tanks, supply cargo and unfinished work; initial purchase rounding is removed and expired-wreck fuel is separated from consumption.',
    limits: 'Selected routes on one map, no hostile competition or exploration strategy. Refuelling frequency is observed, not forced. Outcomes do not establish long-session, PvP or full progression balance.',
  }, cases: results };
const out = option('--out'); if (out) writeFileSync(resolve(out), JSON.stringify(report, null, 2) + '\n');
assert(results.every(result => !result.faults.length), 'Inspect Native faults before qualifying the comparison');
