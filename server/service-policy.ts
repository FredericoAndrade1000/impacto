import { bill, billTotal, partialMend, resupply, shortText } from '../src/economy.ts';
import type { ResupplyDesign } from '../src/economy.ts';
import type { RepairLevels, StockId, SupplyBill } from '../src/economy-contract.ts';

type MendablePiece = { id: string; cost: number; entire?: boolean } & (
  | { stock: StockId; costs?: Partial<SupplyBill> }
  | { stock: null; costs: Partial<SupplyBill> }
);
export interface RepairQuote {
  repair: SupplyBill;
  mendable: readonly MendablePiece[];
}
export interface PartialRepair {
  pieces: { id: string; share: number }[];
  cost: SupplyBill;
  seconds: number;
}
export interface RepairPoint { stock: SupplyBill }
export type RepairOffer<Point extends RepairPoint> =
  | [point: Point, partial: PartialRepair | null]
  | [point: null, partial: null];

export interface ServiceActor {
  blueprint: ResupplyDesign;
}
export interface ServicePoint extends RepairPoint {
  held?: string;
  supplier?: ServiceActor | null;
}
export interface ServiceQuote extends RepairQuote {
  rearm: SupplyBill;
  full: RepairLevels;
  levels: RepairLevels;
}
export interface ServiceOffers<Point extends ServicePoint> {
  point: Point | undefined;
  rearm: SupplyBill;
  mender: Point | undefined;
  part: PartialRepair | null;
}

// Points arrive in distance order. Whole repair takes precedence over partial repair;
// stock remains untouched until the room accepts and pays the actual service.
export function repairOffer<Point extends RepairPoint>(points: readonly Point[], quote: RepairQuote): RepairOffer<Point> {
  const whole = points.find(point => !shortText(point.stock, quote.repair));
  if (whole) return [whole, null];
  for (const point of points) { const part = partialMend(quote, point.stock); if (part) return [point, part]; }
  return [null, null];
}

// The same economic offers feed the condition display and repair dispatch. Readiness,
// self-supplied fuel and the explanation when nobody can pay remain distinct rules.
export function serviceOffers<Point extends ServicePoint>(actor: ServiceActor, quote: ServiceQuote, points: readonly Point[]): ServiceOffers<Point> {
  const ready = points.filter(point => !point.held), wanted = billTotal(quote.rearm) > 0;
  let point: Point | null | undefined = null, rearm = bill();
  if (wanted) for (const candidate of ready) {
    const given = resupply(actor.blueprint, quote, candidate.stock).cost;
    if (billTotal(given) > 0) { point = candidate; rearm = given; break; }
  }
  if (!point) {
    point = ready[0] || points[0];
    if (point && wanted) rearm = resupply(actor.blueprint, quote, point.stock).cost;
  }
  const menders = points.filter(point => point.supplier !== actor),
    [paying, part] = repairOffer(menders.filter(point => !point.held), quote),
    mender = paying || menders.find(point => !point.held) || menders[0];
  return { point, rearm, mender, part };
}
