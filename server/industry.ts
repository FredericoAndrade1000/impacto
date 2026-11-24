import { BASIC_INDUSTRY, isIndustryLevels, upgradeById, upgradeShortages } from '../src/industry.ts';
import { bill, billSum, STOCK_IDS, STOCKS } from '../src/economy.ts';
import { phrase, phraseList } from '../src/i18n.ts';
import { userError } from '../src/user-message.ts';
import type { IndustryLevels, UpgradeId } from '../src/industry.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { IndustryView, PendingUpgrade } from '../src/field-service-contract.ts';
import { record, numeric } from '../src/wire-shape.ts';

export interface IndustryState { levels: IndustryLevels; capital: SupplyBill; pending: PendingUpgrade | null; serial: number }
export function newIndustry(levels: IndustryLevels = BASIC_INDUSTRY): IndustryState {
  if (!isIndustryLevels(levels)) throw new Error('Instalações iniciais inválidas.');
  return { levels: { ...levels }, capital: bill(), pending: null, serial: 0 };
}
export function advanceIndustry(state: IndustryState, time: number): UpgradeId | null {
  const pending = state.pending;
  if (!pending || time + 1e-9 < pending.until) return null;
  const upgrade = upgradeById(pending.upgrade);
  if (!upgrade) throw new Error('Melhoria pendente inválida.');
  // The guard at creation/resume guarantees this exact next level.
  state.levels = { ...state.levels, [upgrade.facility]: upgrade.level };
  state.capital = billSum(state.capital, pending.cost); state.pending = null;
  return upgrade.id;
}
export function startUpgrade(state: IndustryState, stock: SupplyBill, id: unknown, by: string, time: number) {
  const upgrade = upgradeById(id);
  if (!upgrade) throw userError('Melhoria desconhecida.');
  if (state.levels[upgrade.facility] >= upgrade.level) return { upgrade: upgrade.id, already: true as const };
  if (state.pending?.upgrade === upgrade.id) return { upgrade: upgrade.id, pending: state.pending.id, already: true as const };
  if (state.pending) throw userError('Conclua ou cancele a melhoria em andamento.');
  if (state.levels[upgrade.facility] !== upgrade.level - 1) throw userError('Conclua o nível anterior desta instalação.');
  const missing = upgradeShortages(stock, upgrade.cost);
  if (missing.length) throw userError`Faltam recursos para a melhoria: ${phraseList(missing.map(item => phrase`${item.amount} ${phrase(STOCKS[item.id])}`))}.`;
  // All admission precedes payment. The target level makes retries idempotent;
  // the serial makes an old cancellation harmless after another start.
  const pending: PendingUpgrade = { id: state.serial + 1, upgrade: upgrade.id, by, startedAt: time, until: time + upgrade.seconds, cost: { ...upgrade.cost } };
  for (const key of STOCK_IDS) stock[key] -= upgrade.cost[key];
  state.serial = pending.id; state.pending = pending;
  return { upgrade: upgrade.id, pending: pending.id };
}
export function cancelUpgrade(state: IndustryState, stock: SupplyBill, id: unknown) {
  if (!numeric(id) || !Number.isSafeInteger(id) || id <= 0) throw userError('Melhoria pendente inválida.');
  if (!state.pending || state.pending.id !== id) return { cancelled: id, refund: bill(), already: true as const };
  const refund = { ...state.pending.cost };
  for (const key of STOCK_IDS) stock[key] += refund[key];
  state.pending = null;
  return { cancelled: id, refund };
}
// Base defeat uses the same stock/loot settlement as other constructions. Free
// starter/migration levels carry no paid capital and cannot mint a refund.
export function liquidateIndustry(state: IndustryState): SupplyBill {
  const returned = billSum(state.capital, state.pending?.cost ?? bill());
  Object.assign(state, newIndustry(), { serial: state.serial });
  return returned;
}
export function industryView(state: IndustryState): IndustryView {
  return { levels: { ...state.levels }, pending: state.pending ? structuredClone(state.pending) : null };
}
const validBill = (value: unknown): value is SupplyBill => record(value) && STOCK_IDS.every(key => numeric(value[key]) && value[key] >= 0);
export function validateIndustry(value: unknown, time: number, based = true): IndustryState {
  const invalid = (): never => { throw new Error('Instalações inválidas no campo salvo.'); };
  if (!record(value) || !isIndustryLevels(value.levels) || !validBill(value.capital) || !numeric(value.serial) ||
    !Number.isSafeInteger(value.serial) || value.serial < 0 || !Number.isFinite(time) || time < 0) return invalid();
  const { levels, capital, serial, pending } = value;
  if (pending !== null) {
    if (!record(pending) || !numeric(pending.id) || pending.id !== value.serial || pending.id < 1 || typeof pending.by !== 'string' || !pending.by ||
      !numeric(pending.startedAt) || pending.startedAt < 0 || pending.startedAt > time + 1e-9 || !numeric(pending.until) ||
      pending.until <= pending.startedAt || !validBill(pending.cost)) return invalid();
    const upgrade = upgradeById(pending.upgrade), cost = pending.cost;
    if (!upgrade || levels[upgrade.facility] !== upgrade.level - 1 || Math.abs(pending.until - pending.startedAt - upgrade.seconds) > 1e-7 ||
      STOCK_IDS.some(key => cost[key] !== upgrade.cost[key])) return invalid();
  }
  if (!based && (pending !== null || STOCK_IDS.some(key => capital[key] !== 0) ||
    Object.keys(BASIC_INDUSTRY).some(key => levels[key as keyof IndustryLevels] !== BASIC_INDUSTRY[key as keyof IndustryLevels]))) return invalid();
  return { levels: { ...value.levels }, capital: { ...value.capital }, serial: value.serial,
    pending: pending === null ? null : { id: pending.id as number, upgrade: upgradeById(pending.upgrade)!.id, by: pending.by as string,
      startedAt: pending.startedAt as number, until: pending.until as number, cost: { ...pending.cost as SupplyBill } } };
}
