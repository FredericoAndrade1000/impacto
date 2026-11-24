// Analytic sensitivity, not a SharedRoom/route/combat simulation. Native facts
// are supplied by review-industry.ts; only proposal prices scale between runs.
import assert from 'node:assert/strict';
import { INDUSTRY_PROPOSAL } from './industry-proposal.ts';
import { STOCK_IDS, RAW_IDS, YIELD, bill, billSum, buildSeconds } from '../src/economy.ts';
import { DEPOSIT_RESERVE, RECOVERY_SECONDS } from '../src/deposits.ts';
import { nativeFuelFlow } from '../src/native-dynamics.ts';
import type { CargoKind, SupplyBill } from '../src/economy-contract.ts';
import type { IndustryUpgrade } from './industry-proposal.ts';

export interface IndustryTemplateFacts { id: string; cost: SupplyBill; extraction: readonly { rate: number; workKw: number }[]; engineKw: number }
export interface IndustryEconomyFacts {
  templates: readonly IndustryTemplateFacts[]; rawCapacity: Record<CargoKind, number>;
  stock: SupplyBill; postCost: SupplyBill; aircraft: { cost: SupplyBill };
}
interface IndustryScenario { id: string; veins: number; posts?: number; losses?: number; distance?: number; cadence?: number; cash?: boolean }
interface MaterialFlow { rawPerHour: number; fuelPerHour: number }

const add = billSum;
const scale = (a: SupplyBill, factor: number): SupplyBill => bill(a.ferro * factor, a.ligas * factor, a.silica * factor, a.combustivel * factor);
const affords = (stock: SupplyBill, cost: SupplyBill): boolean => STOCK_IDS.every(id => stock[id] + 1e-6 >= cost[id]);
const sum = (list: readonly SupplyBill[]): SupplyBill => list.reduce((total, cost) => add(total, cost), bill());
const reserve = bill(30000, 0, 3000, 500);

export function reviewIndustryEconomy(facts: IndustryEconomyFacts) {
  const template = (id: string): IndustryTemplateFacts => { const found = facts.templates.find(t => t.id === id); assert(found, `Missing measured template ${id}`); return found; };
  const bootstrap = add(scale(template('mining-truck').cost, 2), template('tanker').cost);
  const flows = (distance: number): Record<CargoKind, MaterialFlow> => {
    const flow = (raw: CargoKind): MaterialFlow => {
      const capacity = facts.rawCapacity[raw], vehicle = template(raw === 'petroleo' ? 'tanker' : 'mining-truck'), tool = vehicle.extraction[0];
      assert(tool, `Missing measured extraction tool for ${raw}`);
      const loading = capacity / tool.rate, travel = 2 * distance / 8, cycle = loading + travel;
      return { rawPerHour: capacity * 3600 / cycle,
        fuelPerHour: (nativeFuelFlow(tool.workKw, vehicle.engineKw) * loading
          + nativeFuelFlow(vehicle.engineKw, vehicle.engineKw) * travel) / cycle };
    };
    return { ferro: flow('ferro'), ligas: flow('ligas'), silica: flow('silica'), petroleo: flow('petroleo') };
  };
  function simulate(factor: number, scenario: IndustryScenario) {
    const start = scenario.cash ? { ...facts.stock } : add(facts.stock, bootstrap, -1);
    const buffer = scenario.cash ? bill() : reserve, workers = scenario.cash ? 1 : 3;
    let stock = { ...start }, produced = bill(), spent = bill(), losses = bill(), fuel = 0, posts = 0;
    let firstPurchase: number | null = null, fundedMinute: number | null = null, assignment: Record<CargoKind, number> | null = null,
      failure: { minute: number; reason: string; unpaid: SupplyBill } | null = null;
    const actions: (IndustryUpgrade & { order: number })[] = INDUSTRY_PROPOSAL.upgrades.filter(n => !scenario.cash || n.id === 'hangar-i')
      .map((n, order) => ({ ...n, order, cost: scale(n.cost, factor) }));
    for (let n = 0; n < (scenario.posts ?? 0); n++) actions.push({ id: `post-${n}`, order: -n, requires: n ? [`post-${n - 1}`] : [], cost: facts.postCost });
    if (scenario.cash) actions.push({ id: 'aircraft', order: actions.length, requires: ['hangar-i'], cost: facts.aircraft.cost });
    const done = new Set<string>(), purchases: { minute: number; id: string }[] = [];
    const eligible = () => actions.filter(n => !done.has(n.id) && n.requires.every(id => done.has(id)))
      .sort((a, b) => a.cost.ferro - b.cost.ferro || a.order - b.order);
    const buy = (minute: number): void => {
      for (;;) {
        const next = eligible().find(n => affords(stock, add(buffer, n.cost)));
        if (!next) break;
        stock = add(stock, next.cost, -1); spent = add(spent, next.cost); done.add(next.id);
        purchases.push({ minute, id: next.id });
        if (next.id.startsWith('post-')) posts++;
        else if (next.id !== 'aircraft') firstPurchase ??= minute;
      }
    };
    const deposits: Record<CargoKind, number[]> = { ferro: Array<number>(scenario.veins).fill(DEPOSIT_RESERVE), ligas: [DEPOSIT_RESERVE],
      silica: [DEPOSIT_RESERVE], petroleo: [DEPOSIT_RESERVE] };
    const flow = flows(scenario.distance ?? 1500), cadence = scenario.cadence ?? 1;
    buy(0);
    for (let minute = 1; minute <= 120 * 60; minute++) {
      const targetAction = eligible()[0];
      if (!targetAction) { fundedMinute = minute - 1; break; }
      const target = add(buffer, targetAction.cost);
      if (!assignment || (minute - 1) % cadence === 0) {
        assignment = { ferro: 0, ligas: 0, silica: 0, petroleo: !scenario.cash && stock.combustivel < target.combustivel + 5000 ? 1 : 0 };
        const assigned = assignment;
        for (let worker = 0; worker < workers; worker++) {
          const solids: readonly Exclude<CargoKind, 'petroleo'>[] = ['ferro', 'ligas', 'silica'];
          const raw = solids.map(raw => ({ raw,
            need: (target[raw] - stock[raw]) / flow[raw].rawPerHour - assigned[raw] / 60 }))
            .filter(n => n.need > 0).sort((a, b) => b.need - a.need)[0]?.raw;
          if (raw) assignment[raw]++;
        }
      }
      for (const raw of RAW_IDS) {
        const veins = deposits[raw];
        const count = assignment[raw], accessible = raw === 'ferro' && scenario.posts ? Math.min(veins.length, 2 + posts) : veins.length;
        for (let n = 0; n < veins.length; n++) {
          veins[n] = Math.min(DEPOSIT_RESERVE, Number(veins[n]) + DEPOSIT_RESERVE / RECOVERY_SECONDS * 60);
          if (n >= accessible) continue;
          const here = Math.floor(count / accessible) + Number(n < count % accessible);
          const extracted = Math.min(Number(veins[n]), flow[raw].rawPerHour * here / 60);
          veins[n] = Number(veins[n]) - extracted;
          const id = raw === 'petroleo' ? 'combustivel' : raw, amount = extracted * YIELD[raw];
          stock[id] += amount; produced[id] += amount;
        }
        const consumed = flow[raw].fuelPerHour * count / 60;
        stock.combustivel -= consumed; fuel += consumed;
      }
      const loss = scale(template('scout').cost, (scenario.losses ?? 0) / 60);
      if (!affords(stock, loss)) {
        failure = { minute, reason: 'cannot-fund-assumed-replacement', unpaid: loss };
        break; // No implicit credit: the proposed dispatch policy is infeasible.
      }
      stock = add(stock, loss, -1); losses = add(losses, loss); buy(minute);
      assert(STOCK_IDS.every(id => stock[id] >= -1e-6), `Scenario cannot sustain its assumed fuel/losses: ${scenario.id}, factor ${factor}, minute ${minute}, ${JSON.stringify(stock)}`);
      if (done.size === actions.length) { fundedMinute = minute; break; }
    }
    const expected = add(add(add(start, produced), spent, -1), losses, -1);
    expected.combustivel -= fuel;
    assert(STOCK_IDS.every(id => Math.abs(expected[id] - stock[id]) < 1e-4), 'Four-stock accounting identity');
    const airPurchase = purchases.find(n => n.id === 'aircraft');
    return { scenario: scenario.id, factor, status: failure ? 'infeasible-policy' : fundedMinute === null ? 'horizon-exceeded' : 'funded', failure,
      firstPurchaseMinutes: firstPurchase, fundedHours: fundedMinute === null ? null : fundedMinute / 60,
      // Optimistic funding + existing aircraft assembly only; no Hangar build,
      // scouting, first-trip latency, flight mission or sustained operations.
      optimisticAircraftReadyMinutes: airPurchase ? airPurchase.minute + buildSeconds(facts.aircraft.cost) / 60 : null,
      start, bootstrap: scenario.cash ? bill() : bootstrap, produced, spent, losses, operatingFuel: fuel, finalStock: stock, purchases };
  }
  const scenarios: IndustryScenario[] = [
    { id: 'two-iron-veins', veins: 2 },
    { id: 'four-iron-veins-two-paid-posts', veins: 4, posts: 2 },
    { id: 'two-veins-scout-loss-every-2h', veins: 2, losses: .5 },
    { id: 'two-veins-5km', veins: 2, distance: 5000 },
    { id: 'two-veins-15min-redispatch', veins: 2, cadence: 15 },
    { id: 'initial-cash-single-miner-air-first', veins: 2, cash: true },
  ];
  return { assumptions: {
    type: 'Fluid financing sensitivity, not live economy or PvP; numerical precision is not predictive precision.',
    fleet: 'Granted miner/scout/constructor plus two bought miners and tanker, six vehicles; clock starts after bootstrap readiness. Cash-air case keeps only the granted three and no tanker.',
    travel: 'Known deposits, 1.5km each way (5km where named), mean 8m/s; averaged arrivals. Material-switch travel and discovery omitted.',
    deposits: 'Central real reserve/regeneration; no competitors. Paid posts each grant one additional Fe vein with an assumed 1.5km collection route; valid map geometry not tested.',
    purchases: 'Least Fe-cost eligible purchase; any affordable eligible action can buy. Proposal upgrades only scale; actual post/vehicle bills do not. Buffer is voluntary and not enforced for bootstrap or cash-air.',
    buffer: reserve, dispatch: 'Three solid miners (one in cash-air) chase the next purchase deficit each minute; named cadence holds assignment for15min. Tanker only operates below purchase buffer plus5000L.',
    fuel: 'Native tool-load curve while loading; full-rated-engine upper envelope in travel, not measured fuel consumption. Idle scout/constructor omitted.',
    omissions: 'Installation/post/dispatch build times, exact cargo timing, ore cutoff, terrain/roads, supply trips, airborne missions, repairs/ammo and combat except explicit continuous scout-loss provision. No yield/rate bonus.',
    unit: 'fundedHours means all listed purchases financed, not operational industry. optimisticAircraftReadyMinutes also adds only the existing fixture build time.',
  }, scenarios, totalCost: sum(INDUSTRY_PROPOSAL.upgrades.map(n => n.cost)), bootstrap,
  flowEnvelopes: { '1500m': flows(1500), '5000m': flows(5000) },
  results: [.75, 1, 1.5].flatMap(factor => scenarios.map(scenario => simulate(factor, scenario))) };
}
