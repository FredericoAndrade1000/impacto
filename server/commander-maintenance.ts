import { STOCK_IDS } from '../src/economy.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { CommanderChoice, CommanderObservation, CommanderState } from './commander-contract.ts';
import { activeJob } from './commander-units.ts';

const covers = (stock: SupplyBill, cost: SupplyBill, reserve?: SupplyBill): boolean =>
  STOCK_IDS.every(id => stock[id] + 1e-6 >= cost[id] + (cost[id] > 0 ? reserve?.[id] ?? 0 : 0));

// The controller can cancel its own depot repair and request it again, exactly
// as a player can. No stock is reserved or rewritten behind the service system.
// Essential damage and repairs paid by a supply vehicle keep their authority.
export function chooseCommanderMaintenance(o: CommanderObservation, state: CommanderState, reserve: SupplyBill): CommanderChoice | null {
  for (const unit of o.units) {
    const mend = unit.maintenance;
    if (!mend || !unit.atDepot || !unit.still || unit.auto || unit.moving || unit.haul || activeJob(unit) ||
      unit.manual || unit.job?.reason === 'manual-control') continue;
    if (mend.phase === 'repairing') {
      if (!mend.critical && mend.payer === null && STOCK_IDS.some(id => mend.cost[id] > 0 && o.stock[id] + 1e-6 < reserve[id]))
        return { action: { kind: 'cancel-repair', unitId: unit.id }, reason: 'preserve-income' };
    } else if (mend.phase === 'declined' && state.deferredRepairs.includes(unit.id) && unit.ready && mend.available &&
      covers(o.stock, mend.cost, mend.critical ? undefined : reserve)) {
      return { action: { kind: 'repair', unitId: unit.id }, reason: 'resume-repair' };
    }
  }
  return null;
}
