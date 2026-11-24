// Experimental economic selector. The only input is authorized faction data;
// movement, emergencies, services and operations retain the ordinary policy.
import { chooseCommanderAction } from '../../server/commander-policy.ts';
import { baseAlarm } from '../../server/commander-defense.ts';
import { safeCommanderRoute } from '../../server/commander-routes.ts';
import { activeJob, isDefender, mobilityBlocked, returning } from '../../server/commander-units.ts';
import { commanderActionKey } from '../../server/commander-contract.ts';
import type { CommanderChoice, CommanderObservation, CommanderState, CommanderUnit } from '../../server/commander-contract.ts';
import { CONSTRUCTION_LIMITS } from '../../src/construction-limits.ts';
import { upgradeById } from '../../src/industry.ts';
import type { SupplyBill } from '../../src/economy-contract.ts';
import { NO_TREND } from './history.ts';
import type { StockTrend } from './history.ts';

export const FEATURES = ['time', 'iron', 'alloy', 'silica', 'fuel', 'netIron', 'netAlloy', 'netSilica', 'netFuel', 'trendWindow',
  'miners', 'activeHauls', 'transportReady', 'guards', 'guardHealth', 'guardAmmo', 'mortars',
  'health', 'ready', 'safeIron', 'alarm', 'leftPressure', 'rightPressure', 'workshop', 'hangar', 'processing', 'industryPending', 'base',
  'wait', 'mine', 'haul', 'fuelAction', 'guard', 'mortar', 'upgrade', 'other',
  'workshopUpgrade', 'hangarUpgrade', 'processingUpgrade', 'upgradeLevel', 'upgradeSeconds',
  'ironCost', 'alloyCost', 'silicaCost', 'fuelCost', 'miningReserve', 'defenseReserve',
  'unitHealth', 'distance', 'siteStock', 'siteLeft', 'baseline'] as const;
export const HIDDEN = 8, PARAMETERS = FEATURES.length * HIDDEN + HIDDEN * 2 + 1;
export const BASELINE_MARGIN = .05;
export interface EconomicModel { version: 2; features: readonly string[]; hidden: 8; baselineMargin: number; parameters: number[] }
export interface Proposal { choice: CommanderChoice; features: number[] }

export function readEconomicModel(raw: unknown): EconomicModel {
  if (!raw || typeof raw !== 'object') throw new Error('Economic model must be an object.');
  const m = raw as Partial<EconomicModel>;
  if (m.version !== 2 || m.hidden !== HIDDEN || JSON.stringify(m.features) !== JSON.stringify(FEATURES) ||
    typeof m.baselineMargin !== 'number' || !Number.isFinite(m.baselineMargin) || m.baselineMargin < 0 || m.baselineMargin > 1 ||
    !Array.isArray(m.parameters) || m.parameters.length !== PARAMETERS ||
    !m.parameters.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 16))
    throw new Error('Incompatible economic model.');
  return { version: 2, features: [...FEATURES], hidden: HIDDEN, baselineMargin: m.baselineMargin, parameters: [...m.parameters] };
}
export function initialEconomicModel(seed = 1): EconomicModel {
  const parameters = Array<number>(PARAMETERS).fill(0);
  for (let i = 0; i < FEATURES.length * HIDDEN; i++) {
    seed = seed * 16807 % 2147483647; parameters[i] = (seed / 2147483647 - .5) * .4;
  }
  return { version: 2, features: [...FEATURES], hidden: HIDDEN, baselineMargin: BASELINE_MARGIN, parameters };
}
export function economicScore(model: EconomicModel, features: readonly number[]): number {
  if (features.length !== FEATURES.length || !features.every(Number.isFinite)) throw new Error('Invalid economic features.');
  const p = model.parameters, bias = FEATURES.length * HIDDEN, output = bias + HIDDEN;
  let score = p[PARAMETERS - 1]!;
  for (let h = 0; h < HIDDEN; h++) {
    let value = p[bias + h]!;
    for (let i = 0; i < FEATURES.length; i++) value += features[i]! * p[h * FEATURES.length + i]!;
    score += Math.tanh(value) * p[output + h]!;
  }
  return score;
}

export function economicProposals(o: CommanderObservation, state: CommanderState, trend: StockTrend = NO_TREND): Proposal[] {
  const baseline = chooseCommanderAction(o, state), action = baseline.action;
  // Do not steal tactical decisions, explicit operation transitions or service
  // authority. A one-choice decision is not a learned choice in the metrics.
  const forced = !o.base || !state.enabled || baseAlarm(o) || state.operation !== null || baseline.operation !== undefined ||
    action && !['manufacture', 'haul', 'upgrade'].includes(action.kind);
  // Economic alternatives never change an operation. Keep the ordinary reason
  // when an alternative would only repeat its same command (or the same wait).
  const identity = (c: CommanderChoice) => c.action ? commanderActionKey(c.action) : 'wait',
    choices = [baseline], keys = new Set([identity(baseline)]),
    cooled = (c: CommanderChoice): boolean => c.action !== null &&
      (state.cooldowns[commanderActionKey(c.action)] ?? -Infinity) > o.time,
    add = (choice: CommanderChoice) => {
      const key = identity(choice);
      if (!keys.has(key) && !cooled(choice)) { keys.add(key); choices.push(choice); }
    },
    miners = o.units.filter(u => u.vehicle && u.extracts.includes('ferro')),
    guards = o.units.filter(isDefender), mortars = o.units.filter(u => u.artillery),
    canPay = (cost: SupplyBill) => (['ferro', 'ligas', 'silica', 'combustivel'] as const).every(k => o.stock[k] >= cost[k]),
    available = (unit: CommanderUnit) => unit.ready && !unit.manual && !unit.moving && !returning(unit) && !unit.haul && !activeJob(unit) &&
      unit.job?.reason !== 'manual-control' && !unit.attack && !mobilityBlocked(unit) && (state.blocked[unit.id]?.until ?? -Infinity) <= o.time;
  if (!forced) {
    add({ action: null, reason: 'preserve-reserve' });
    if (o.units.filter(u => u.vehicle).length < CONSTRUCTION_LIMITS.vehicles)
      for (const offer of o.offers) {
        const model = offer.model, allowed = model === 'mining-truck' ? miners.length < 2 :
          model === 'tanker' ? !o.units.some(u => u.extracts.includes('petroleo')) :
          model === 'mortar' ? mortars.length < 1 : ['scout', 'scout-20mm', 'ifv'].includes(model) && guards.length < 3;
        if (allowed && canPay(offer.cost) && model !== 'guard-post' && model !== 'mining-site')
          add({ action: { kind: 'manufacture', model }, reason: model === 'mining-truck' ? 'restore-mining' :
            model === 'tanker' ? 'secure-fuel' : model === 'mortar' ? 'counter-battery' : 'manufacture-defense' });
      }
    for (const unit of o.units) {
      if (!available(unit)) continue;
      for (const site of o.deposits) if (unit.extracts.includes(site.material) && unit.carries.includes(site.material) &&
        site.left >= 1000 && (state.cooldowns['route:' + site.id] ?? -Infinity) <= o.time && safeCommanderRoute(o, unit.x, site.x))
        add({ action: { kind: 'haul', unitId: unit.id, depositId: site.id }, reason: 'collect-material' });
    }
    for (const upgrade of o.upgrades) if (upgrade.eligible && canPay(upgrade.cost))
      add({ action: { kind: 'upgrade', upgrade: upgrade.id }, reason: 'improve-workshop' });
  }
  const clamp = (x: number) => Math.max(-4, Math.min(4, x)),
    mean = (units: readonly CommanderUnit[], key: 'health' | 'ammoRatio') =>
      units.length ? units.reduce((n, u) => n + u[key], 0) / units.length : 0,
    hostileLocations = [...o.threats.filter(t => t.kind === 'signal' || t.armed !== false),
      ...o.bases.filter(b => b.seen || b.at !== null)],
    pressure = (side: -1 | 1) => o.base ? Math.max(0, ...hostileLocations
      .map(t => (t.x - o.base!.x) * side).filter(distance => distance >= 0).map(distance => 1 - distance / 6000)) : 0,
    minerCost = o.offers.find(offer => offer.model === 'mining-truck')?.cost,
    guardCost = o.offers.filter(offer => ['scout', 'scout-20mm', 'ifv'].includes(offer.model))
      .reduce<SupplyBill | undefined>((cheapest, offer) => !cheapest || offer.cost.ferro < cheapest.ferro ? offer.cost : cheapest, undefined),
    // Number of replacement bills payable after this action, constrained by
    // the scarcest required stock. Catalogue offers already respect industry.
    reserve = (replacement: SupplyBill | undefined, cost: SupplyBill | undefined) => replacement ?
      Math.min(...(['ferro', 'ligas', 'silica', 'combustivel'] as const).filter(k => replacement[k] > 0)
        .map(k => (o.stock[k] - (cost?.[k] ?? 0)) / replacement[k])) : 0,
    context = {
      time: o.time / 1200, iron: o.stock.ferro / 100000, alloy: o.stock.ligas / 10000, silica: o.stock.silica / 10000,
      fuel: o.stock.combustivel / 2000, netIron: trend.perMinute.ferro / 10000, netAlloy: trend.perMinute.ligas / 1000,
      netSilica: trend.perMinute.silica / 1000, netFuel: trend.perMinute.combustivel / 200, trendWindow: trend.seconds / 60,
      miners: miners.length / 2, activeHauls: o.units.filter(u => u.haul).length / 2,
      transportReady: o.units.filter(u => u.carries.length && available(u)).length / 2,
      guards: guards.length / 3, guardHealth: mean(guards, 'health'), guardAmmo: mean(guards, 'ammoRatio'), mortars: mortars.length,
      health: mean(o.units, 'health'), ready: o.units.filter(u => u.ready).length / 8,
      safeIron: Number(o.deposits.some(s => s.material === 'ferro' && s.left >= 1000 && o.base && safeCommanderRoute(o, o.base.x, s.x))),
      alarm: Number(baseAlarm(o)), leftPressure: pressure(-1), rightPressure: pressure(1),
      workshop: o.industry.levels.workshop / 3, hangar: o.industry.levels.hangar / 2, processing: o.industry.levels.processing / 3,
      industryPending: Number(o.industry.pending), base: Number(o.base !== null),
    };
  return choices.map((choice, index) => {
    const a = choice.action, model = a?.kind === 'manufacture' ? a.model : null,
      family = !a ? 0 : model === 'mining-truck' ? 1 : a.kind === 'haul' ? 2 : model === 'tanker' ? 3 :
        model === 'mortar' ? 5 : model ? 4 : a.kind === 'upgrade' ? 6 : 7,
      cost = a?.kind === 'upgrade' ? o.upgrades.find(u => u.id === a.upgrade)?.cost : o.offers.find(p => p.model === model)?.cost,
      unit = a && 'unitId' in a ? o.units.find(u => u.id === a.unitId) : null,
      site = a?.kind === 'haul' ? o.deposits.find(d => d.id === a.depositId) : null,
      upgrade = a?.kind === 'upgrade' ? upgradeById(a.upgrade) : null,
      values = { ...context, wait: Number(family === 0), mine: Number(family === 1), haul: Number(family === 2),
        fuelAction: Number(family === 3), guard: Number(family === 4), mortar: Number(family === 5), upgrade: Number(family === 6), other: Number(family === 7),
        workshopUpgrade: Number(upgrade?.facility === 'workshop'), hangarUpgrade: Number(upgrade?.facility === 'hangar'),
        processingUpgrade: Number(upgrade?.facility === 'processing'), upgradeLevel: (upgrade?.level ?? 0) / 3, upgradeSeconds: (upgrade?.seconds ?? 0) / 240,
        ironCost: (cost?.ferro ?? 0) / 100000, alloyCost: (cost?.ligas ?? 0) / 10000, silicaCost: (cost?.silica ?? 0) / 10000,
        fuelCost: (cost?.combustivel ?? 0) / 2000, miningReserve: reserve(minerCost, cost), defenseReserve: reserve(guardCost, cost),
        unitHealth: unit?.health ?? 1, distance: site && o.base ? Math.abs(site.x - o.base.x) / 4000 : 0,
        siteStock: (site?.stock ?? 0) / 10000, siteLeft: (site?.left ?? 0) / 100000, baseline: Number(index === 0),
      } satisfies Record<typeof FEATURES[number], number>;
    return { choice, features: FEATURES.map(key => clamp(values[key])) };
  });
}

export function selectEconomicProposal(model: EconomicModel, proposals: readonly Proposal[]): number {
  if (!proposals.length) throw new Error('No economic proposals.');
  // A fixed preference for the expert is independent of the learned baseline
  // feature. Ties and sub-margin noise retain the ordinary choice. This is a
  // score difference, not a calibrated probability or confidence estimate.
  let best = 0, score = economicScore(model, proposals[0]!.features) + model.baselineMargin;
  for (let i = 1; i < proposals.length; i++) {
    const next = economicScore(model, proposals[i]!.features);
    if (next > score) { best = i; score = next; }
  }
  return best;
}

// Residual own capital includes refundable construction value. Buying and
// dismantling cannot manufacture reward by merely moving iron to/from stock.
export function economicCapital(o: CommanderObservation): number {
  return o.stock.ferro + o.units.reduce((n, u) => n + u.salvage.ferro, 0);
}
