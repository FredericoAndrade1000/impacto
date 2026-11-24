import { SALVAGE_REACH, STOCK_IDS } from '../src/economy.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { CommanderChoice, CommanderObservation, CommanderState, CommanderUnit } from './commander-contract.ts';
import { commanderActionKey } from './commander-contract.ts';
import { activeJob, canGuard, isDefender, mobilityBlocked, returning } from './commander-units.ts';
import { baseAlarm } from './commander-defense.ts';
import { safeCommanderRoute } from './commander-routes.ts';

const LOCAL_RECOVERY_DISTANCE = 1000;

// Dump is the ordinary partial, irreversible unloading command. A genuinely
// lighter vehicle may retry its existing return; never restart an unchanged
// failed trip or discard cargo merely because the unit has stopped briefly.
export function chooseCommanderLightening(o: CommanderObservation, state: CommanderState): CommanderChoice | null {
  for (const unit of o.units) {
    const order = state.orders[unit.id], action = { kind: 'dump-cargo', unitId: unit.id } as const;
    if (unit.vehicle && !unit.aircraft && unit.ready && !unit.manual && !unit.atDepot && !unit.moving && !activeJob(unit) &&
      unit.job?.reason !== 'manual-control' && !unit.attack && unit.calm && unit.cargo > 0 && unit.mobility && unit.fuel > 0 &&
      unit.halt.startsWith('stuck-') && (order?.kind === 'haul' || order?.kind === 'home') &&
      (state.cooldowns[commanderActionKey(action)] ?? -Infinity) <= o.time)
      return { action, reason: 'recover-mobility' };
  }
  return null;
}

// Known wrecks are ordinary recoverable capital. Approach only a nearby safe
// position; actual reach, calm, ownership and residual value are checked again
// by the normal Salvage command. No job, timer or reservation is persisted.
export function chooseCommanderRecovery(o: CommanderObservation, state: CommanderState, demand: SupplyBill): CommanderChoice | null {
  if (!o.base || state.operation) return null;
  const base = o.base, alarm = baseAlarm(o), available = (unit: CommanderUnit): boolean =>
    unit.ready && !unit.manual && !unit.moving && !returning(unit) && !unit.haul && !activeJob(unit) && !unit.attack &&
    unit.job?.reason !== 'manual-control' && !mobilityBlocked(unit) && (state.blocked[unit.id]?.until ?? -Infinity) <= o.time &&
    (isDefender(unit) && canGuard(unit) || unit.builder && Boolean(unit.mobility) && unit.fuel > 0),
    workers = o.units.filter(available);
  for (const wreck of [...o.wrecks].sort((a, b) => Math.abs(a.x - base.x) - Math.abs(b.x - base.x) || a.id.localeCompare(b.id))) {
    const salvage = { kind: 'salvage', wreckId: wreck.id } as const;
    if ((state.cooldowns[commanderActionKey(salvage)] ?? -Infinity) > o.time ||
      Math.abs(wreck.x - base.x) > LOCAL_RECOVERY_DISTANCE || !safeCommanderRoute(o, base.x, wreck.x) ||
      !STOCK_IDS.some(material => o.stock[material] < demand[material] && wreck.value[material] > 0)) continue;
    const near = workers.find(unit => Math.abs(unit.x - wreck.x) <= SALVAGE_REACH);
    if (near) {
      if (wreck.inReach) return { action: salvage, reason: 'recover-materials' };
      if (!alarm && (wreck.calmIn !== null || !near.still)) return { action: null, reason: 'recover-materials' };
    }
    if (alarm) continue;
    const worker = workers.filter(unit => unit.atDepot && unit.calm && unit.still)
      .sort((a, b) => Math.abs(a.x - wreck.x) - Math.abs(b.x - wreck.x) || a.id.localeCompare(b.id))[0];
    if (worker) return { action: { kind: 'defend', unitId: worker.id, x: wreck.x }, reason: 'recover-materials' };
  }
  return null;
}
