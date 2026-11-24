import { bill } from '../src/economy-contract.ts';
import type { CargoKind, SupplyBill } from '../src/economy-contract.ts';
import type { CommanderAction, CommanderChoice, CommanderDeposit, CommanderObservation, CommanderOffer, CommanderReason, CommanderState, CommanderUnit } from './commander-contract.ts';
import { commanderActionKey } from './commander-contract.ts';
import { chooseInterception, maintainInterception } from './commander-tactics.ts';
import { activeJob, canGuard, exploring, isDefender, mobilityBlocked, returning, stranded } from './commander-units.ts';
import { baseAlarm, chooseBaseDefense, needsCounterBattery } from './commander-defense.ts';
import { baseKnown, chooseGroundOperation, operationReason, operationUnit } from './commander-operations.ts';
import { chooseCommanderMaintenance } from './commander-maintenance.ts';
import { chooseCommanderLightening, chooseCommanderRecovery } from './commander-recovery.ts';
import { commanderRouteKey, safeCommanderRoute } from './commander-routes.ts';

const STOCKS = ['ferro', 'ligas', 'silica', 'combustivel'] as const;
const ORES = ['ferro', 'silica', 'ligas'] as const;
const REVISIT_SECONDS = 120;
const sum = (left: SupplyBill, right: SupplyBill): SupplyBill => ({
  ferro: left.ferro + right.ferro, ligas: left.ligas + right.ligas,
  silica: left.silica + right.silica, combustivel: left.combustivel + right.combustivel,
});
const affordable = (stock: SupplyBill, cost: SupplyBill): boolean => STOCKS.every(id => stock[id] + 1e-6 >= cost[id]);

// Only a faction observation enters this policy. Existing orders, physical
// state, prices and admissible placements are owned by their normal systems.
export function chooseCommanderAction(observation: CommanderObservation, state: CommanderState): CommanderChoice {
  const o = observation, wait = (reason: CommanderReason): CommanderChoice => ({ action: null, reason });
  if (!state.enabled) return wait('disabled');
  const blocked = (id: string): boolean => (state.blocked[id]?.until ?? -Infinity) > o.time,
    cooled = (action: CommanderAction): boolean => (state.cooldowns[commanderActionKey(action)] ?? -Infinity) > o.time,
    choose = (action: CommanderAction, reason: CommanderReason): CommanderChoice | null => cooled(action) ? null : { action, reason };
  if (o.recovery?.offered) {
    const recovery = choose({ kind: 'recover' }, 'recover');
    if (recovery) return recovery;
  }
  if (!o.base) return wait('no-base');
  const base = o.base, alive = o.units.filter(unit => unit.health > 0),
    interceptionActive = Object.values(state.orders).some(order => order.kind === 'intercept'),
    intercepting = (unit: CommanderUnit): boolean => state.orders[unit.id]?.kind === 'intercept',
    free = (unit: CommanderUnit): boolean => unit.ready && !unit.manual && !unit.moving && !returning(unit) && !unit.haul && !activeJob(unit) &&
      unit.job?.reason !== 'manual-control' && !blocked(unit.id) && !mobilityBlocked(unit) && !intercepting(unit) && !operationUnit(state, unit.id),
    safeRoute = (from: number, to: number): boolean => safeCommanderRoute(o, from, to),
    offer = <M extends CommanderOffer['model']>(model: M): (CommanderOffer & { model: M }) | undefined =>
      o.offers.find((item): item is CommanderOffer & { model: M } => item.model === model),
    minerOffer = offer('mining-truck'), fuelBuffer = state.profile === 'cautious' ? 600 : 300,
    reserve = minerOffer ? sum(minerOffer.cost, bill(0, 0, 0, fuelBuffer)) : bill(0, 0, 0, fuelBuffer),
    canSpend = (cost: SupplyBill, extra = bill()): boolean => Boolean(minerOffer) && affordable(o.stock, sum(sum(cost, reserve), extra)),
    unfinished = o.works.some(work => !work.complete),
    miningWorks = o.works.filter(work => work.model === 'mining-site'),
    miningAt = (x: number): boolean => miningWorks.some(work => Math.abs(work.x - x) <= 30),
    hasMiner = alive.some(unit => unit.vehicle && unit.extracts.includes('ferro') && unit.carries.includes('ferro') && !stranded(unit)),
    fixedMiner = alive.some(unit => !unit.vehicle && unit.extracts.includes('ferro')),
    oreCarriers = alive.filter(unit => unit.vehicle && unit.carries.includes('ferro') && !stranded(unit)),
    hasOreCapacity = hasMiner || fixedMiner && oreCarriers.some(unit => unit.extracts.length === 0),
    fuelCarriers = alive.filter(unit => unit.vehicle && unit.extracts.includes('petroleo') && unit.carries.includes('petroleo')),
    builders = alive.filter(unit => unit.builder),
    defenders = alive.filter(unit => isDefender(unit) && !stranded(unit)),
    guardingBase = defenders.some(unit => unit.atBase && unit.ready && canGuard(unit)),
    // A paid guard assembling or being serviced at home is not a second
    // missing purchase. Keep readiness for actual duty, not capital planning.
    committedGuard = defenders.some(unit => unit.atBase && canGuard(unit) && !unit.manual &&
      unit.job?.reason !== 'manual-control' && !mobilityBlocked(unit)),
    artillery = alive.filter(unit => unit.artillery && unit.vehicle && unit.armed && !unit.aircraft && !stranded(unit)),
    localThreat = baseAlarm(o),
    knownRival = o.bases.some(target => target.id !== o.factionId && !target.sheltered && baseKnown(target)),
    workshop = o.upgrades.find(upgrade => upgrade.id === 'workshop-ii' && upgrade.eligible),
    routeHeld = (id: string): boolean => (state.cooldowns[commanderRouteKey(id)] ?? -Infinity) > o.time,
    sources = (material: CargoKind): CommanderDeposit[] => o.deposits.filter(site => site.material === material && !blocked(site.id) && !routeHeld(site.id) && safeRoute(base.x, site.x))
      .sort((a, b) => {
        const available = (site: CommanderDeposit) => site.left >= 1000 || site.stock >= 250;
        return Number(available(b)) - Number(available(a)) || Math.abs(a.x - base.x) - Math.abs(b.x - base.x) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      }),
    usable = (site: CommanderDeposit): boolean => site.left >= 1000 || site.stock >= 250 ||
      !site.seen && site.at !== null && o.time - site.at >= REVISIT_SECONDS,
    fixedExtraction = (site: CommanderDeposit): boolean => site.left >= 1000 && alive.some(unit => !unit.vehicle &&
      unit.extracts.includes(site.material) && Math.abs(unit.x - site.x) <= 30),
    workingCarrier = (unit: CommanderUnit): boolean => Boolean(unit.mobility) && unit.fuel > 0 && !mobilityBlocked(unit),
    productionPath = (unit: CommanderUnit, material: CargoKind): boolean => sources(material).some(site =>
      (site.left >= 1000 || site.stock >= 250) &&
      (unit.extracts.includes(material) && !miningAt(site.x) || site.stock >= 250 || fixedExtraction(site))),
    // Owning a tool is not an income path when it cannot move or every known
    // source is unsafe/depleted. Loaded returns remain useful without replacing
    // their orders; no delivery estimate or hidden deposit state is invented.
    productiveOre = oreCarriers.some(unit => workingCarrier(unit) &&
      (unit.cargo > 0 && returning(unit) || ORES.some(material => productionPath(unit, material)))),
    workingIron = oreCarriers.some(unit => workingCarrier(unit) && productionPath(unit, 'ferro')),
    // A working iron path and a ready home guard can fund the next military
    // purchase without holding a second miner's entire iron price in cash.
    // Other materials retain their full replacement reserve; civil investment
    // and upgrades still preserve the original complete reserve.
    militaryReserve = { ...reserve, ferro: guardingBase && workingIron ? 0 : reserve.ferro },
    canArm = (cost: SupplyBill): boolean => Boolean(minerOffer) && affordable(o.stock, sum(cost, militaryReserve)),
    // A known opponent justifies a protected cannon without waiting for the
    // heavy IFV. Selection and execution use the same income/fuel reserve.
    response = localThreat || knownRival || state.operation !== null,
    defenseBudget = localThreat ? bill(0, 0, 0, fuelBuffer) : militaryReserve,
    choices = (response ? [offer('ifv'), offer('scout-20mm'), offer('scout')] :
      o.industry.levels.workshop >= 2 ? [offer('ifv'), offer('scout')] : [offer('scout')])
      .filter(item => item !== undefined),
    defender = choices.find(item => affordable(o.stock, sum(item.cost, defenseBudget))) ?? choices[0],
    counterBattery = needsCounterBattery(o), mortar = counterBattery && !artillery.length ? offer('mortar') : undefined,
    wantedDefenders = localThreat ? state.profile === 'cautious' ? 3 : 2 : state.operation?.phase === 'prepare' ? 3 : o.industry.levels.workshop >= 2 ? 2 : 1,
    militaryPurchase = mortar && guardingBase ? mortar : defenders.length < wantedDefenders ? defender : mortar,
    defenseReserve = (localThreat || knownRival ? defender?.cost : militaryPurchase?.cost) ?? bill(),
    plannedCost = o.industry.levels.workshop < 2 ? o.upgrades.find(upgrade => upgrade.id === 'workshop-ii')?.cost :
      militaryPurchase?.cost ?? defender?.cost,
    // Search before the current purchase consumes the last replacement batch.
    // This is a forecast, not an extra charge or a hidden resource allowance.
    materialDemand = sum(sum(plannedCost ?? bill(), reserve), defender?.cost ?? bill()),
    // A plant serves its own deposit. Neither its tool nor a pure carrier can
    // extract another known raw reserve when that material becomes scarce.
    missingExtractor = !hasMiner && (!fixedMiner || shortages().some(material => {
      const known = sources(material);
      return known.some(site => site.left >= 1000) && !known.some(site => site.stock >= 250 || fixedExtraction(site));
    })),
    fuelSecured = fuelCarriers.length > 0 || o.stock.combustivel >= (workshop?.cost.combustivel ?? 0) + reserve.combustivel,
    upgradeDefenseReserve = response ? defenseReserve : (offer('scout-20mm') ?? defender)?.cost ?? bill(),
    progression = !localThreat && !unfinished && !o.industry.pending && productiveOre && guardingBase && fuelSecured &&
      workshop && canSpend(workshop.cost, upgradeDefenseReserve) ? workshop : undefined,
    growthReserve = progression?.cost ?? bill(),
    canInvest = (cost: SupplyBill, extra = bill()): boolean => productiveOre && canSpend(cost, sum(sum(extra, defenseReserve), growthReserve));

  // A bounded combat mission owns its approach/focus/return. Routine danger
  // avoidance cannot immediately cancel the approach to its declared contact.
  const continuing = maintainInterception(o, state);
  if (continuing?.action) {
    const action = choose(continuing.action, continuing.reason); if (action) return action;
  }
  const defense = chooseBaseDefense(o, state);
  if (defense?.action) { const action = choose(defense.action, defense.reason); if (action) return action; }
  const lighten = chooseCommanderLightening(o, state);
  if (lighten) return lighten;
  const maintenance = chooseCommanderMaintenance(o, state, sum(sum(reserve, defenseReserve), growthReserve));
  if (maintenance?.action) { const action = choose(maintenance.action, maintenance.reason); if (action) return action; }
  if (state.operation?.phase === 'prepare' && progression)
    return { action: null, reason: 'abort-operation', operation: null };
  // Stored fuel can fund a bounded deployment even when the tanker was lost.
  // Assembly and material collection share the very same next purchase quote.
  const funded = productiveOre && o.stock.combustivel >= fuelBuffer + 300 && !unfinished && canArm(militaryPurchase?.cost ?? bill()),
    operating = state.operation ? chooseGroundOperation(o, state, funded) : null;
  if (operating) return operating.action && cooled(operating.action) ? wait(operationReason(state.operation!)) : operating;

  // Retreat may replace a live economic/exploration order. Ordinary scheduling
  // below never interrupts one. A prior failed outbound trip cannot veto safety.
  for (const unit of alive) {
    if (!unit.vehicle || !unit.ready || unit.job?.reason === 'manual-control' || returning(unit) || intercepting(unit) ||
      operationUnit(state, unit.id) || unit.atDepot && !unit.moving && !unit.haul && !activeJob(unit)) continue;
    const target = unit.haul && o.deposits.find(site => site.id === unit.haul!.depositId), previous = state.orders[unit.id],
      reconnaissance = previous?.kind === 'reconnoitre' && isDefender(unit) && unit.health >= .8 && unit.ammoRatio >= .6 &&
        unit.fuel > unit.fuelCapacity * .5 && !unit.halt,
      dangerous = !safeRoute(unit.x, unit.x) || target && (!safeRoute(unit.x, target.x) ||
        previous?.kind === 'haul' && previous.depositId === target.id && routeHeld(target.id)) ||
        exploring(previous) && previous && 'x' in previous && !safeRoute(unit.x, previous.x);
    if (localThreat && exploring(previous) && !unit.haul && !activeJob(unit)) {
      const action = choose({ kind: 'home', unitId: unit.id }, 'local-defense'); if (action) return action;
    }
    // One normal return replaces the commander's failed outbound trip. A
    // failed return stays unavailable: restarting it would reset the pilot's
    // progress timer without changing the terrain or the vehicle's traction.
    if (mobilityBlocked(unit)) {
      const ownedRoute = previous?.kind === 'haul' ? unit.haul?.depositId === previous.depositId :
        previous && previous.kind !== 'home';
      if (!unit.aircraft && unit.halt !== 'immobile' && !unit.moving && !activeJob(unit) && ownedRoute && !unit.atDepot) {
        const action = choose({ kind: 'home', unitId: unit.id }, 'recover-mobility'); if (action) return action;
      }
      continue;
    }
    // Lost cargo can cancel the native haul while leaving a drivable hull.
    // One ordinary return restores its parts at the depot. A full usable
    // carrier, another movement, an existing return or service keeps authority.
    if (previous?.kind === 'haul' && unit.halt === 'no-room' && unit.mobility &&
      !unit.haul && !unit.moving && !activeJob(unit)) {
      const source = o.deposits.find(site => site.id === previous.depositId);
      if (source ? !unit.carries.includes(source.material) : unit.carries.length === 0) {
        const action = choose({ kind: 'home', unitId: unit.id }, 'retreat'); if (action) return action;
      }
    }
    // A local guard accepts the risk that justified its bounded approach.
    // Routine civilian withdrawal must not cancel Defend on the next cycle;
    // depleted or badly damaged guards still withdraw and can use services.
    if (reconnaissance || previous?.kind === 'defend' && unit.atBase && canGuard(unit)) continue;
    if (exploring(previous) && unit.halt) { const action = choose({ kind: 'home', unitId: unit.id }, 'retreat'); if (action) return action; }
    if (dangerous) { const action = choose({ kind: 'home', unitId: unit.id }, 'retreat'); if (action) return action; }
  }

  const recovery = chooseCommanderRecovery(o, state, materialDemand);
  if (recovery) return recovery;

  // With no functional home guard, an immediate armed response comes first.
  // Once it has one, lost income precedes topping up the guard count: capital
  // recovered for the miner must not immediately buy back a redundant guard.
  if (localThreat && militaryPurchase && ((hasOreCapacity && !missingExtractor) || !committedGuard)) {
    const candidates = [militaryPurchase, ...(defenders.length < wantedDefenders ? [offer('scout')] : []), mortar];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const cost = sum(candidate.cost, bill(0, 0, 0, fuelBuffer));
      if (affordable(o.stock, cost)) {
        const action = choose({ kind: 'manufacture', model: candidate.model },
          candidate.model === 'mortar' ? 'counter-battery' : 'manufacture-defense');
        if (action) return action;
      }
      // Finance the admitted response before settling for another light guard.
      // Only an idle builder may fund this choice, with home coverage intact.
      if (candidate === militaryPurchase && guardingBase && productiveOre) {
        const capital = recycleCapital(stock => affordable(stock, cost), 'fund-production', unit => unit.builder && !unit.armed);
        if (capital) return capital;
      }
    }
  }

  // A remaining scout/constructor means ordinary recovery aid is unavailable.
  // Restoring income may spend materials it can replenish along a known safe
  // productive route. It must not consume the next guard's other ore inputs:
  // an iron hauler cannot repay the last silica spent on its own replacement.
  // A plant needs a dedicated transporter: its standby mobile extractor gives
  // the plant its mouth and cannot also count as that transport capacity.
  if (missingExtractor || fixedMiner && !oreCarriers.some(unit => unit.extracts.length === 0)) {
    const needed = missingExtractor ? minerOffer : offer('truck'),
      incomeMaterials = ORES.filter(material => sources(material).some(site =>
        (site.left >= 1000 || site.stock >= 250) && (missingExtractor ? !miningAt(site.x) : site.stock >= 250 || fixedExtraction(site)))),
      protectedMaterials = localThreat || knownRival ? { ...defenseReserve, combustivel: 0 } : bill();
    for (const material of incomeMaterials) protectedMaterials[material] = 0;
    const recoveryCost = needed && sum(needed.cost, protectedMaterials);
    if (needed && recoveryCost && incomeMaterials.length && affordable(o.stock, recoveryCost)) {
      const action = choose({ kind: 'manufacture', model: needed.model === 'truck' ? 'truck' : 'mining-truck' }, 'restore-mining');
      if (action) return action;
    }
    if (recoveryCost && incomeMaterials.length && !affordable(o.stock, recoveryCost)) {
      // Recover income from genuinely spare capital through normal paid-value
      // dismantling. Keep a working guard, live jobs, cargo and repairs intact.
      const capital = recycleCapital(stock => affordable(stock, recoveryCost), 'restore-mining');
      if (capital) return capital;
    }
  }

  // A fixed extractor and a mobile extractor cannot share the same mouth.
  // Cancel only this conflicting extraction intention, leaving a loaded return
  // and every service alone. Stop also disables the miner's automatic pickup,
  // so the transport dispatcher can use the completed plant without a race.
  for (const unit of oreCarriers.filter(unit => unit.extracts.includes('ferro'))) {
    if (!unit.ready || returning(unit) || blocked(unit.id) || unit.job?.reason === 'manual-control') continue;
    const destination = unit.haul && o.deposits.find(site => site.id === unit.haul!.depositId),
      extractingThere = destination && miningAt(destination.x),
      waitingThere = unit.auto && !unit.moving && !activeJob(unit) && miningAt(unit.x);
    if (extractingThere || waitingThere) {
      const action = choose({ kind: 'stop', unitId: unit.id }, 'release-mining-site'); if (action) return action;
    }
  }
  // Normal automatic builders stay beside finished works when empty. Clear
  // that staging place once the plant is ready for its transport vehicles.
  for (const unit of builders) if (free(unit) && !unit.atDepot &&
    miningWorks.some(work => work.complete && Math.abs(work.x - unit.x) <= 30)) {
    const action = choose({ kind: 'home', unitId: unit.id }, 'release-mining-site'); if (action) return action;
  }

  const haul = (unit: CommanderUnit, material: CargoKind, reason: CommanderReason): CommanderChoice | null => {
    // A paid loop may change material at its next empty depot departure.
    // Only matching commander-owned routes qualify; loaded returns, services,
    // manual control and journeys already outside the depot retain authority.
    const source = unit.haul && o.deposits.find(site => site.id === unit.haul!.depositId), previous = state.orders[unit.id],
      changeMaterial = Boolean(source && source.material !== material && previous?.kind === 'haul' && previous.depositId === source.id &&
        unit.ready && unit.atDepot && unit.cargo === 0 && unit.haul?.phase === 'out' && !returning(unit) &&
        !activeJob(unit) && unit.job?.reason !== 'manual-control' && !blocked(unit.id));
    if (!free(unit) && !changeMaterial) return null;
    for (const site of sources(material)) {
      if (!usable(site) || !safeRoute(unit.x, site.x) || unit.extracts.includes(material) && miningAt(site.x)) continue;
      if (!unit.extracts.includes(material) && site.stock < 250 && !fixedExtraction(site)) continue;
      const action = choose({ kind: 'haul', unitId: unit.id, depositId: site.id }, site.left < 1000 && site.stock < 250 ? 'revisit-source' : reason);
      if (action) return action;
    }
    return null;
  };
  if (o.stock.combustivel < reserve.combustivel + 300) {
    for (const unit of fuelCarriers) { const action = haul(unit, 'petroleo', 'secure-fuel'); if (action) return action; }
  }
  const neededMaterial = missingMaterial();
  for (const unit of oreCarriers) {
    if (!unit.extracts.includes('ferro') && (!neededMaterial || neededMaterial === 'petroleo')) continue;
    const material = neededMaterial && neededMaterial !== 'petroleo' && unit.carries.includes(neededMaterial) ? neededMaterial : 'ferro';
    const action = haul(unit, material, 'collect-material'); if (action) return action;
    if (unit.extracts.includes('ferro') && free(unit) && !unit.atDepot && miningAt(unit.x)) {
      const home = choose({ kind: 'home', unitId: unit.id }, 'release-mining-site'); if (home) return home;
    }
  }

  // Reuse genuinely idle production capital only if its normal residual value
  // completes the concrete next plan and all applicable reserves. Recompute the
  // plan next cycle; no earmarked money or additional durable state is needed.
  const plan = progression ? sum(sum(progression.cost, reserve), defenseReserve) :
    militaryPurchase ? sum(militaryPurchase.cost, militaryReserve) : null;
  if (!state.operation && !unfinished && guardingBase && productiveOre && plan && !affordable(o.stock, plan)) {
    const capital = recycleCapital(stock => affordable(stock, plan), 'fund-production', unit => unit.builder && !unit.armed);
    if (capital) return capital;
  }

  // An existing intake can keep working. Stored fuel may already fund industry;
  // buying a new tanker then competes with that concrete growth reserve.
  const tanker = offer('tanker');
  if (!fuelCarriers.length && sources('petroleo').length && tanker &&
    (o.stock.combustivel < fuelBuffer ? affordable(o.stock, tanker.cost) : canInvest(tanker.cost))) {
    const action = choose({ kind: 'manufacture', model: 'tanker' }, 'secure-fuel'); if (action) return action;
  }
  for (const unit of fuelCarriers) { const action = haul(unit, 'petroleo', 'secure-fuel'); if (action) return action; }

  for (const unit of [...defenders, ...artillery]) if (free(unit)) {
    if (!unit.atDepot && (localThreat || !needsExploration() || state.orders[unit.id]?.kind === 'defend')) {
      const action = choose({ kind: 'home', unitId: unit.id }, 'local-defense'); if (action) return action;
    } else if (unit.atDepot && unit.stance !== 'fire') {
      const action = choose({ kind: 'stance', unitId: unit.id, stance: 'fire' }, 'local-defense'); if (action) return action;
    }
  }

  // Progression has a concrete next use. Do not spend its budget on an idle
  // constructor or begin another light force while the improvement is funded.
  if (!state.operation && progression && canSpend(progression.cost, defenseReserve)) {
    const action = choose({ kind: 'upgrade', upgrade: progression.id }, 'improve-workshop'); if (action) return action;
  }
  const constructor = offer('construction-truck');
  if (!builders.length && constructor && hasOreCapacity && fuelCarriers.length && canInvest(constructor.cost)) {
    const action = choose({ kind: 'manufacture', model: 'construction-truck' }, 'restore-construction'); if (action) return action;
  }

  // One live construction plan at a time avoids spending its not-yet-delivered
  // materials on upgrades. The observation deliberately does not copy a ledger.
  if (unfinished) return wait('waiting-service');

  const guard = o.offers.find(item => item.model === 'guard-post' && item.x !== undefined && item.facing !== undefined &&
    safeRoute(base.x, item.x) && !o.works.some(work => work.model === 'guard-post' && Math.abs(work.x - item.x!) < 30));
  if (localThreat && builders.length && guard && o.works.filter(work => work.model === 'guard-post').length < (state.profile === 'cautious' ? 2 : 1) && canInvest(guard.cost)) {
    const action = choose({ kind: 'build', model: 'guard-post', x: guard.x!, facing: guard.facing! }, 'local-defense'); if (action) return action;
  }

  // Workshop II has a concrete next use: a local defense vehicle. Processing
  // opens material choices and is never treated as a refinery-rate multiplier.
  const preparation = !state.operation && !interceptionActive && !progression ? chooseGroundOperation(o, state, funded) : null;
  if (preparation) return preparation;
  if (militaryPurchase && hasOreCapacity && canArm(militaryPurchase.cost)) {
    const action = choose({ kind: 'manufacture', model: militaryPurchase.model },
      militaryPurchase.model === 'mortar' ? 'counter-battery' : 'manufacture-defense'); if (action) return action;
  }

  // Only an already prepared spare defender may cover a threatened working
  // route. Essential income, services and the base guard keep their priority.
  const interception = state.operation ? null : chooseInterception(o, state);
  if (interception?.action) {
    const action = choose(interception.action, interception.reason); if (action) return action;
  }

  // A close vein is useful only if its material can sustain the next purchases.
  // Compare stock coverage of the actual quote and income reserve; placement,
  // safety and the future transporter's full price still come first.
  const truck = offer('truck'), productionNeed = materialDemand,
    coverage = (item: CommanderOffer): number => {
      const site = o.deposits.find(site => item.x !== undefined && Math.abs(site.x - item.x) <= 30);
      return site && site.material !== 'petroleo' && productionNeed[site.material] > 0 ?
        o.stock[site.material] / productionNeed[site.material] : Infinity;
    },
    mine = truck && o.offers.filter(item => item.model === 'mining-site' && item.x !== undefined && item.facing !== undefined &&
      safeRoute(base.x, item.x) && !o.works.some(work => work.model === 'mining-site' && Math.abs(work.x - item.x!) < 20) && canInvest(item.cost, truck.cost))
      .sort((a, b) => { const left = coverage(a), right = coverage(b); return left < right ? -1 : left > right ? 1 : 0; })[0];
  if (!state.operation && !fixedMiner && hasMiner && fuelCarriers.length && builders.length && o.industry.levels.workshop >= 2 && mine && truck) {
    const action = choose({ kind: 'build', model: 'mining-site', x: mine.x!, facing: mine.facing! }, 'build-mining'); if (action) return action;
  }
  // Diversification needs a second extractor, preserving the only iron income.
  const material = missingMaterial();
  if (material && material !== 'ferro' && material !== 'petroleo') {
    const spare = oreCarriers.find(unit => free(unit) && unit.extracts.includes(material) && oreCarriers.length > 1);
    if (spare) { const action = haul(spare, material, 'collect-material'); if (action) return action; }
    if (oreCarriers.length < 2 && minerOffer && canInvest(minerOffer.cost) && sources(material).some(usable)) {
      const action = choose({ kind: 'manufacture', model: 'mining-truck' }, 'collect-material'); if (action) return action;
    }
  }
  if (!localThreat && !interceptionActive && (!state.operation || state.operation.phase === 'prepare' && material !== null) &&
    !defenders.some(returning) && !alive.some(unit => unit.moving && state.orders[unit.id]?.kind === 'explore') && needsExploration()) {
    const resourceSurvey = missingSource() !== null,
      // A gap in sight after combat is not another uncontested opening.
      // Existing owned reports survive that gap without a new timer or memory.
      loneOpeningScout = resourceSurvey && defenders.length === 1 && alive.every(unit => unit.combatAt === null) &&
        !o.bases.some(target => target.id !== o.factionId && !target.sheltered),
      guard = defenders.filter(unit => canGuard(unit) && unit.atBase && unit.ready && !unit.moving && !unit.attack && !unit.halt &&
        !blocked(unit.id) && !activeJob(unit))
        .sort((a, b) => b.maxHealth - a.maxHealth || a.id.localeCompare(b.id))[0],
      canScout = (unit: CommanderUnit): boolean => free(unit) && unit.fuel > unit.fuelCapacity * (resourceSurvey ? .2 : .5) &&
        (resourceSurvey || unit.health >= .8 && unit.ammoRatio >= .6),
      armedSpare = guard ? defenders.find(unit => unit.id !== guard.id && canScout(unit)) : undefined,
      utility = resourceSurvey ? alive.find(unit => unit.vehicle && !unit.aircraft && !isDefender(unit) && !unit.artillery &&
        free(unit) && unit.cargo === 0 && unit.health >= .8 && unit.fuel > unit.fuelCapacity * .2) : undefined,
      scout = armedSpare ?? utility ?? (loneOpeningScout ? defenders.find(canScout) : undefined);
    if (scout) {
      const connected = o.explored?.find(([lo, hi]) => lo <= scout.x && hi >= scout.x) ?? [base.x - 750, base.x + 750],
        step = state.profile === 'cautious' ? 500 : 800,
        points = [connected[0] - step, connected[1] + step].map(x => Math.round(Math.max(o.bounds.minX + 100, Math.min(o.bounds.maxX - 100, x))))
          .filter(x => Math.abs(x - scout.x) > 100 && (!resourceSurvey || safeRoute(scout.x, x)))
          .sort((a, b) => (!resourceSurvey ? Number(Math.sign(b - base.x) === base.facing) - Number(Math.sign(a - base.x) === base.facing) : 0) ||
            Math.abs(a - scout.x) - Math.abs(b - scout.x) || (a - b) * -base.facing);
      for (const x of points) { const action = choose({ kind: resourceSurvey ? 'explore' : 'reconnoitre', unitId: scout.id, x }, 'explore'); if (action) return action; }
    }
  }
  return wait(state.operation ? operationReason(state.operation) : alive.some(unit => !free(unit)) ? 'busy' : material ? 'waiting-source' : 'preserve-reserve');

  function recycleCapital(pays: (stock: SupplyBill) => boolean, reason: CommanderReason,
    eligible: (unit: CommanderUnit) => boolean = () => true): CommanderChoice | null {
    const spare = alive.filter(unit => eligible(unit) && free(unit) && !unit.attack && unit.atBase && unit.calm && unit.still &&
      unit.cargo === 0 && !unit.maintenance && !unit.extracts.includes('ferro') && (!unit.builder || !unfinished) &&
      (!unit.extracts.includes('petroleo') || o.stock.combustivel >= fuelBuffer + 300) &&
      (!isDefender(unit) || defenders.some(other => other.id !== unit.id && other.ready && other.atBase && canGuard(other))) && pays(sum(o.stock, unit.salvage)))
      .sort((a, b) => Number(isDefender(a)) - Number(isDefender(b)) || a.salvage.ferro - b.salvage.ferro);
    for (const unit of spare) {
      const action = choose({ kind: 'dismantle', unitId: unit.id }, reason); if (action) return action;
    }
    return null;
  }

  function missingMaterial(): CargoKind | null {
    if (!sources('ferro').length) return 'ferro';
    if (!sources('petroleo').length || o.stock.combustivel < fuelBuffer && !fuelCarriers.length) return 'petroleo';
    return shortages()[0] ?? null;
  }
  function shortages(): ('ferro' | 'silica' | 'ligas')[] {
    return ORES.filter(id => materialDemand[id] > 0 && o.stock[id] < materialDemand[id])
      .sort((a, b) => o.stock[a] / materialDemand[a] - o.stock[b] / materialDemand[b]);
  }
  function missingSource(): CargoKind | null {
    if (!sources('ferro').length) return 'ferro';
    if (!sources('petroleo').length) return 'petroleo';
    return shortages().find(material => !sources(material).length) ?? null;
  }
  function needsExploration(): boolean {
    return missingSource() !== null ||
      o.industry.levels.workshop >= 2 && defenders.length >= 2 && !knownRival;
  }
}
