import { clamp } from './math.ts';
import { count, number } from './format.ts';
import { billTotal, fillName } from './economy.ts';
import { tr } from './i18n.ts';
import type { ActorService } from './construction-service.ts';
import type { SupplyBill } from './economy-contract.ts';

// Shares are shown in whole percent, never more than what is done.
export const percentText = (share: number): string => Math.floor(clamp(share, 0, 1) * 100) + '%';
const remaining = (until: number, time: number): number => Math.max(0, Math.ceil(until - time));

function unknownService(service: never): never {
  throw new Error(`Unknown construction service: ${JSON.stringify(service)}`);
}

export function serviceText(service: ActorService, time: number): string {
  switch (service.kind) {
    case 'build': return `${tr('em construção')} · ${remaining(service.until, time)} s`;
    case 'repair': return `${tr('em reparo')} · ${remaining(service.until, time)} s`;
    case 'turn': return `${tr('virando')} · ${remaining(service.until, time)} s`;
    case 'dismantle': return `${tr('desmontando')} · ${percentText(service.progress)}`;
    default: return unknownService(service);
  }
}

export function serviceWaitText(service: Pick<ActorService, 'kind'>): string {
  const kind = service.kind;
  switch (kind) {
    case 'build': return tr('Em construção: aguarde ficar pronta.');
    case 'repair': return tr('Em reparo: aguarde o fim do serviço.');
    case 'turn': return tr('Virando: aguarde o fim do giro.');
    case 'dismantle': return tr('Essa estrutura está sendo desmontada.');
    default: return unknownService(kind);
  }
}

type RefillReceipt = { at: number; until: number; fuelLitres: number; rounds: number };
type FeedbackPoint = {
  supplier?: string | null; held?: string; calmUntil?: number; resupply?: SupplyBill;
};
// Only the fields read by the feedback, independent of driving and automatic jobs.
export type ServiceFeedbackUnit = {
  id?: string; still?: boolean; calm?: boolean; calmUntil?: number;
  service?: ActorService | null; refilled?: RefillReceipt;
  point?: FeedbackPoint | null; rearm?: SupplyBill;
};
export type ServiceFeedback = { kind: 'received' | 'waiting'; text: string };

// Refilling is instantaneous. A receipt survives leaving the point; a safety
// countdown uses only the real deadlines of the recipient and its supplier.
export function serviceFeedback(unit: ServiceFeedbackUnit | null | undefined, time: number | undefined): ServiceFeedback | null {
  if (!unit || typeof time !== 'number' || !Number.isFinite(time)) return null;
  const received = unit.refilled;
  if (received && time >= received.at && time < received.until) {
    const amounts = [received.fuelLitres > 0 && (received.fuelLitres < .01 ? tr('menos de 0,01 L') : `${number(received.fuelLitres, 2)} L`),
      received.rounds > 0 && `${count(received.rounds)} ${received.rounds === 1 ? tr('tiro') : tr('tiros')}`].filter(Boolean);
    if (amounts.length) return { kind: 'received', text: tr('Recebeu ') + amounts.join(' · ') };
  }
  const point = unit.point;
  if (!unit.still || unit.service || !point?.resupply || !unit.rearm ||
    !(billTotal(point.resupply) > 0 && billTotal(unit.rearm) > 0) || point.held && point.held !== 'combat') return null;
  const ownUntil = unit.calm === false ? unit.calmUntil : time,
    supplier = point.held === 'combat', supplierUntil = supplier ? point.calmUntil : time;
  if (typeof ownUntil !== 'number' || !Number.isFinite(ownUntil) || typeof supplierUntil !== 'number' || !Number.isFinite(supplierUntil)) return null;
  const until = Math.max(ownUntil, supplierUntil);
  if (!(until > time)) return null;
  return { kind: 'waiting', text: tr`${fillName(point.resupply)} em ${remaining(until, time)} s · aguardando segurança` +
    (supplier && point.supplier !== unit.id && supplierUntil >= ownUntil ? tr(' dos suprimentos') : '') };
}
