import type { RepairLevels, SupplyBill } from './economy-contract.ts';
import type { MessageKey } from './message-contract.ts';

export type BuildService = { kind: 'build'; until: number; objective?: true };
export type RepairPiece = { id: string; share: number };
export type RepairService = {
  kind: 'repair'; until: number; levels: RepairLevels; cost: SupplyBill;
  payer: string | null; pieces: RepairPiece[] | null;
};
export type TurnService = { kind: 'turn'; until: number; aloft?: true };
// Builders advance dismantling by progress. It has no clock deadline.
export type DismantleService = { kind: 'dismantle'; progress: number; seconds: number; to: string | null };
export type ConstructionService = BuildService | RepairService | TurnService | DismantleService;
export type ServiceKind = ConstructionService['kind'];

export function buildService(until: number, objective = false): BuildService {
  return objective ? { kind: 'build', until, objective: true } : { kind: 'build', until };
}
export function repairService(until: number, payment: Omit<RepairService, 'kind' | 'until'>): RepairService {
  return { kind: 'repair', until, levels: payment.levels, cost: payment.cost, payer: payment.payer, pieces: payment.pieces };
}
export function turnService(until: number, aloft = false): TurnService {
  return aloft ? { kind: 'turn', until, aloft: true } : { kind: 'turn', until };
}
export function dismantleService(seconds: number, to: string | null): DismantleService {
  return { kind: 'dismantle', progress: 0, seconds, to };
}

export type ServiceChange =
  | { kind: 'finish-build'; objective: boolean }
  | { kind: 'finish-repair' }
  | { kind: 'finish-turn' }
  | { kind: 'cancel-turn' };

function unknownService(service: never): never {
  throw new Error(`Unknown construction service: ${JSON.stringify(service)}`);
}

// A hit cancels turning, including at its deadline. Paid repairs and manufacture
// keep their deadlines; dismantling advances only when Works supplies builders.
export function advanceService(service: ConstructionService | null, time: number, hit: boolean): ServiceChange | null {
  if (!service) return null;
  switch (service.kind) {
    case 'build': return time >= service.until ? { kind: 'finish-build', objective: Boolean(service.objective) } : null;
    case 'repair': return time >= service.until ? { kind: 'finish-repair' } : null;
    case 'turn': return hit ? { kind: 'cancel-turn' } : time >= service.until ? { kind: 'finish-turn' } : null;
    case 'dismantle': return null;
    default: return unknownService(service);
  }
}

// The public actor field exposes neither payment nor the reserves a repair keeps.
export type ActorService =
  | { kind: 'build'; until: number }
  | { kind: 'repair'; until: number }
  | { kind: 'turn'; until: number }
  | { kind: 'dismantle'; progress: number };

export function actorService(service: ConstructionService | null): ActorService | null {
  if (!service) return null;
  switch (service.kind) {
    case 'build': case 'repair': case 'turn': return { kind: service.kind, until: service.until };
    case 'dismantle': return { kind: service.kind, progress: Math.floor(service.progress * 100) / 100 };
    default: return unknownService(service);
  }
}

type TimedService = BuildService | RepairService | TurnService;
type UnpaidView<Kind extends 'build' | 'turn'> = {
  kind: Kind; until: number; cost: undefined; payer: undefined; partial: false;
};
type TimedServiceView =
  | UnpaidView<'build'>
  | (UnpaidView<'turn'> & { aloft?: true })
  | { kind: 'repair'; until: number; cost: SupplyBill; payer: string | null; partial: boolean };
type DismantleWork<Sent> = { building: boolean; sent: Sent };
export type DismantleServiceView<Sent> = {
  kind: 'dismantle'; progress: number; seconds: number; to: string | null;
} & DismantleWork<Sent>;
export type FactionService<Sent = unknown> = TimedServiceView | DismantleServiceView<Sent>;

export function factionService(service: TimedService | null): TimedServiceView | null;
export function factionService<Sent>(service: DismantleService, work: DismantleWork<Sent>): DismantleServiceView<Sent>;
export function factionService<Sent>(service: ConstructionService | null, work?: DismantleWork<Sent>): FactionService<Sent> | null {
  if (!service) return null;
  switch (service.kind) {
    case 'build': return { kind: service.kind, until: service.until, cost: undefined, payer: undefined, partial: false };
    case 'repair': return { kind: service.kind, until: service.until, cost: service.cost, payer: service.payer, partial: Boolean(service.pieces) };
    case 'turn': return service.aloft
      ? { kind: service.kind, until: service.until, cost: undefined, payer: undefined, partial: false, aloft: true }
      : { kind: service.kind, until: service.until, cost: undefined, payer: undefined, partial: false };
    case 'dismantle': {
      if (!work) throw new Error('Dismantling requires its builder and dispatch status.');
      return { kind: service.kind, progress: Math.floor(service.progress * 1000) / 1000,
        seconds: service.seconds, to: service.to, building: work.building, sent: work.sent };
    }
    default: return unknownService(service);
  }
}

// Canonical server refusals; the browser translates them at the message boundary.
export function serviceHold(service: ConstructionService | null): MessageKey | '' {
  if (!service) return '';
  switch (service.kind) {
    case 'build': return 'Essa construção ainda não ficou pronta.';
    case 'dismantle': return 'Essa estrutura está sendo desmontada.';
    case 'repair': return 'Essa construção está em reparo.';
    case 'turn': return 'Essa construção está virando.';
    default: return unknownService(service);
  }
}
