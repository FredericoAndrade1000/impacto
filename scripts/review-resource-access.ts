// Real first deliveries at favourable, median and distant foundation positions.
// Uses the granted miner and a normally purchased tanker with finite stocks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SharedRoom } from '../server/room.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { carriedBy, designBill, supplied, YIELD, bill, CAPTURE_SECONDS } from '../src/economy.ts';
import { RESERVE_STEP, RECOVERY_SECONDS } from '../src/deposits.ts';
import { compileManufacture } from '../src/structured-construction.ts';
import { foundationAccess } from './review-foundations.ts';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';
import { initNativeDynamics, nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import type { CargoKind } from '../src/economy-contract.ts';

const STEADY = { pace: () => 1 }, LIMIT_SECONDS = 1800;
await initNativeDynamics(); assert.equal(nativeDynamicsRuntime, 'native', 'This delivery audit requires Native dynamics');
type Foundation = ReturnType<typeof foundationAccess>['samples'][number];
type Material = Extract<CargoKind, 'ferro' | 'petroleo'>;
type Scenario = { kind: 'isolated'; material: Material; sample: Foundation }
  | { kind: 'occupied'; material: Material; seed: number; depletion: 'none' | 'local' | 'all' }
  | { kind: 'recovery'; material: 'ferro'; seed: number; depletion: 'local' | 'all' };
const distance = (sample: Foundation, material: Material): number => {
  const source = sample.resources.find(resource => resource.material === material)?.nearest;
  assert(source); return source.metres;
};
const occupied = process.argv.includes('--occupied'), foundations = occupied ? null : foundationAccess();
const scenarios: Scenario[] = occupied ? [
  { kind: 'occupied', material: 'petroleo', seed: 7, depletion: 'none' },
  { kind: 'occupied', material: 'ferro', seed: 1234, depletion: 'local' },
  { kind: 'occupied', material: 'ferro', seed: 987654, depletion: 'all' },
  { kind: 'recovery', material: 'ferro', seed: 1234, depletion: 'all' },
] : (['ferro', 'petroleo'] as const).flatMap(material => {
  assert(foundations);
  const sorted = foundations.samples.slice().sort((a, b) => distance(a, material) - distance(b, material));
  return [0, Math.floor(sorted.length / 2), sorted.length - 1].map(index => {
    const site = sorted[index]; assert(site); return { kind: 'isolated' as const, material, sample: site };
  });
});
function firstDelivery(scenario: Scenario) {
  const { material } = scenario;
  let draw = scenario.kind === 'isolated' ? 0 : scenario.seed;
  const room = new SharedRoom(scenario.kind === 'isolated' ? { base: () => scenario.sample.baseX } :
    { random: () => (draw = draw * 16807 % 2147483647) / 2147483647 });
  try {
    const veterans = scenario.kind === 'isolated' ? [] : Array.from({ length: 8 }, (_, n) => room.join(`Veterano ${n + 1}`));
    let depletedSites = 0;
    if (scenario.kind !== 'isolated' && scenario.depletion !== 'none') {
      const bases = room.bases();
      for (const deposit of room.deposits) if (scenario.depletion === 'all' || bases.some(x => Math.abs(x - deposit.x) <= 5000)) {
        room.veins.set(deposit.id, 0); depletedSites++;
      }
    }
    const player = room.join('Primeira entrega'), owner = room.players.get(player.playerId); assert(owner);
    const faction = room.faction(owner); assert(faction.base && owner.squad);
    let recovery = null;
    if (scenario.kind === 'recovery') {
      const victor = veterans[0]; assert(victor?.faction);
      faction.capture = { by: victor.faction.id, progress: CAPTURE_SECONDS, at: room.world.time, state: 'advancing' };
      room.fall(faction, room.world.time); Object.assign(faction.stock, bill());
      const offer = room.recovery(faction); assert(offer?.offered);
      room.command(player.playerId, { type: 'recover' });
      recovery = { offer, granted: faction.recovered };
    }
    const veteran = veterans[0];
    if (veteran) {
      const state = room.players.get(veteran.playerId); assert(state);
      const veteranFaction = room.faction(state), miner = room.owned(veteran.playerId).find(a => a.blueprint.modules.some(m => m.kind === 'excavator')),
        deposit = room.prospected(veteranFaction).filter(site => site.material === 'ferro')
          .sort((a, b) => Math.abs(a.x - veteranFaction.base!.x) - Math.abs(b.x - veteranFaction.base!.x))[0];
      assert(miner && deposit && room.known(room.faction(state), deposit));
      room.command(veteran.playerId, { type: 'squad', order: 'haul', ids: [miner.id], depositId: deposit.id });
    }
    const raw = material, stockId = raw === 'petroleo' ? 'combustivel' : raw,
      site = room.endow(faction.base, raw); assert(site && room.known(faction, site));
    const fuelInventory = () => faction.stock.combustivel + faction.yard.petroleo * YIELD.petroleo +
      room.owned(player.playerId).reduce((sum, actor) => sum +
        room.world.modules.filter(part => part.actorId === actor.id && part.kind === 'fuel')
          .reduce((litres, part) => litres + (part.kind === 'fuel' ? part.fuelLitres : 0), 0) +
        supplied(carriedBy(room.crates(actor.id)).carried).combustivel, 0),
      initialStock = { ...faction.stock }, start = room.world.time, initialFuelInventory = fuelInventory();
    // A fully depleted world needs time to regain a visible extraction quantum.
    // This explicit player wait uses the surveyed site's normal regeneration rate.
    let waited = 0;
    if (scenario.kind !== 'isolated' && scenario.depletion === 'all') {
      waited = Math.ceil(RESERVE_STEP / (site.reserve / RECOVERY_SECONDS));
      for (let step = 0; step < waited * 60; step++) room.step(STEADY);
    }
    let actor = room.owned(player.playerId).find(actor => actor.blueprint.modules.some(part => part.kind === 'excavator'));
    let purchase = null, purchaseFuelRounding = 0;
    if (raw === 'petroleo') {
      const source = createConstruction('tanker'); purchase = designBill(compileManufacture(source).compiled);
      const made = room.publish(player.playerId, source); assert('actor' in made);
      const madeId = made.actor.id; actor = room.world.actor(madeId);
      assert(actor);
      const installedFuel = room.world.modules.filter(part => part.actorId === madeId && part.kind === 'fuel')
        .reduce((sum, part) => sum + (part.kind === 'fuel' ? part.fuelLitres : 0), 0);
      purchaseFuelRounding = purchase.combustivel - installedFuel;
      for (let step = 0; step < 180 * 60 && room.record(actor).service; step++) room.step(STEADY);
      assert(!room.record(actor).service, 'normal manufacturing must complete before collection');
    }
    assert(actor?.vehicle);
    const id = actor.id, fuel = () => room.world.modules.filter(part => part.actorId === id && part.kind === 'fuel')
      .reduce((sum, part) => sum + (part.kind === 'fuel' ? part.fuelLitres : 0), 0),
      cargo = () => carriedBy(room.pieces(id)).carried[raw] ?? 0,
      before = faction.stock[stockId] + faction.yard[raw] * YIELD[raw], initialFuel = fuel(),
      startedAt = room.world.time, initialMassKg = actor.vehicle.mass;
    room.command(player.playerId, { type: 'squad', order: 'haul', ids: [id], depositId: site.id });
    const samples = [];
    let loadedAt: number | null = null, deliveredAt: number | null = null, status = 'time-limit', maxCargo = 0,
      previousCargo = 0, deliveredRaw = 0, maxMassKg = initialMassKg;
    for (let step = 0; step < LIMIT_SECONDS * 60; step++) {
      room.step(STEADY);
      const live = room.world.actor(id), unit = owner.squad.units.get(id), carried = cargo(), now = room.world.time;
      if (!live?.vehicle || room.outOfAction()[id]) { status = 'out-of-action'; break; }
      maxCargo = Math.max(maxCargo, carried);
      maxMassKg = Math.max(maxMassKg, live.vehicle.mass);
      if (room.still(live) && room.atDepot(faction, live)) deliveredRaw += Math.max(0, previousCargo - carried);
      previousCargo = carried;
      if (carried > 1) loadedAt ??= now - start;
      if (step % 60 === 0) samples.push({ seconds: now - start, phase: unit?.haul?.phase ?? null,
        x: live.vehicle.x, speed: Math.hypot(live.vehicle.vx, live.vehicle.vy), cargo: carried,
        fuel: fuel(), reason: unit?.reason ?? null });
      const income = faction.stock[stockId] + faction.yard[raw] * YIELD[raw] - before;
      if (loadedAt !== null && carried < 1 && income > 1) { deliveredAt = now - start; status = 'delivered'; break; }
      if (!unit?.haul && unit?.halt) { status = unit.halt; break; }
      assert(Number.isFinite(fuel()) && fuel() >= 0, 'actual tank cannot borrow fuel');
    }
    room.command(player.playerId, { type: 'squad', order: 'stop', ids: [id] });
    const finalFuelInventory = fuelInventory(), fuelProduced = raw === 'petroleo' ? deliveredRaw * YIELD.petroleo : 0,
      fuelCostLitres = initialFuelInventory + fuelProduced - finalFuelInventory - purchaseFuelRounding;
    return { material, sample: scenario.kind === 'isolated' ? scenario.sample : null, baseX: faction.base.x,
      conditioning: { kind: scenario.kind, veteranFactions: veterans.length, actors: room.world.actors.length, depletedSites,
        waitForRegrowthSeconds: waited, recovery }, status, initialStock, purchase, initialMassKg, manufactureSeconds: Math.max(0, startedAt - start - waited),
      initialFuel, finalFuel: fuel(), loadedAt, deliveredAt, maxCargo, finalStock: { ...faction.stock },
      site: { id: site.id, x: site.x, metres: Math.abs(site.x - faction.base.x) },
      deliveredRaw, maxMassKg, initialFuelInventory, finalFuelInventory, purchaseFuelRounding, fuelCostLitres,
      remainingYard: { ...faction.yard }, finalOffset: room.position(actor) - faction.base.x, faults: [...room.faults], samples };
  } finally { room.world.dispose(); }
}
const cases = scenarios.map(scenario => {
  const result = firstDelivery(scenario);
  console.log(JSON.stringify({ material: result.material, kind: result.conditioning.kind, base: result.baseX, status: result.status, seconds: result.deliveredAt }));
  return result;
});
const repeated = process.argv.includes('--verify-repeat');
if (repeated) assert.deepEqual(scenarios.map(firstDelivery), cases, 'Starting deliveries must repeat with identical timing, stock, cargo and physical state');
const runtime = nativeRuntimeInfo('native'); assert(runtime.runtime === 'native');
const report = { scope: 'Native first extraction and delivery, not a multiplayer balance or hardware measurement', runtime,
  assumptions: { foundations: foundations?.scope ?? 'Eight existing factions and their ordinary granted fleets, then a real foundation or reconstruction.',
    field: occupied ? 'Occupied runs seed geological depletion near existing bases or across the map, without creating piles or crediting resources. One existing miner follows a normal haul. Recovery seeds a completed defeat and consumed remaining stocks, then uses the normal subsidy command; combat preceding the defeat is not replayed.' : 'Each sampled base position is reopened in an isolated ordinary fresh faction on the same terrain, without competing fleets, depleted veins or enemies.',
    resources: 'Unchanged starting stock and granted fleet. Petroleum buys an ordinary ready tanker and waits for paid assembly; no gifts, teleports, fuel overwrites or physics changes.',
    control: 'Real Squad pilots, fixed decision pace, 60Hz Native, ordinary terrain knowledge, extraction, cargo mass, refuelling and refinery. End at first delivery; 1800 simulated seconds per route.',
    fuel: 'Inventory includes faction stock, refinery yard yield, every owned tank and supply module. Delivered petroleum yield is added once; tanker purchase rounding is separated. Refills transfer actual litres. fuelCostLitres measures the target faction, not competitor expenditure.',
    omissions: 'No exploration strategy or hostile interference. Depletion and prior defeat are explicit initial conditions, not a full historical playthrough. Initial petroleum advice identifies a site, not a road.', repeated }, cases };
const output = process.argv.indexOf('--out');
if (output >= 0) { const path = process.argv[output + 1]; assert(path, '--out needs a path'); writeFileSync(resolve(path), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ scope: report.scope, cases: cases.map(({ material, baseX, site, conditioning, status, manufactureSeconds, loadedAt, deliveredAt, maxCargo, finalFuel, faults }) =>
  ({ material, base: baseX, metres: site.metres, conditioning, status, manufactureSeconds, loadedAt, deliveredAt, maxCargo, finalFuel, faults })) }, null, 2));
assert(cases.every(result => result.status === 'delivered' && !result.faults.length), 'Inspect real route failures in the report before qualifying starting access');
