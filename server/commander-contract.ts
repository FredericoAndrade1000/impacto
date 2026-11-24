import type { CargoKind, SupplyBill } from '../src/economy-contract.ts';
import type { IndustryLevels, UpgradeId } from '../src/industry.ts';
import type { TemplateId } from '../src/construction-template-catalogue.ts';
import type { WreckView } from '../src/field-contract.ts';

export type CommanderProfile = 'balanced' | 'cautious';
export const COMMANDER_VEHICLES = ['mining-truck', 'tanker', 'construction-truck', 'truck', 'scout', 'scout-20mm', 'recon', 'ifv', 'mortar'] as const;
export const COMMANDER_STRUCTURES = ['guard-post', 'mining-site'] as const satisfies readonly TemplateId[];
export type CommanderModel = typeof COMMANDER_VEHICLES[number] | typeof COMMANDER_STRUCTURES[number];
export const COMMANDER_REASONS = ['recover', 'restore-mining', 'restore-construction', 'secure-fuel', 'collect-material',
  'revisit-source', 'explore', 'local-defense', 'evade-fire', 'retreat', 'recover-mobility', 'preserve-income', 'resume-repair', 'build-mining', 'release-mining-site', 'expand-transport', 'improve-workshop',
  'manufacture-defense', 'fund-production', 'recover-materials', 'counter-battery', 'protect-route', 'intercept-contact', 'end-interception',
  'prepare-operation', 'rally-force', 'advance-operation', 'fight-operation', 'occupy-base',
  'return-operation', 'complete-operation', 'abort-operation',
  'preserve-reserve', 'busy', 'waiting-source', 'waiting-service', 'no-base', 'disabled'] as const;
export type CommanderReason = typeof COMMANDER_REASONS[number];
export type CommanderAction =
  | { kind: 'haul'; unitId: string; depositId: string }
  | { kind: 'stop'; unitId: string }
  | { kind: 'home'; unitId: string }
  | { kind: 'dump-cargo'; unitId: string }
  | { kind: 'cancel-repair' | 'repair' | 'dismantle'; unitId: string }
  | { kind: 'salvage'; wreckId: string }
  | { kind: 'explore'; unitId: string; x: number }
  | { kind: 'reconnoitre'; unitId: string; x: number }
  | { kind: 'defend'; unitId: string; x: number }
  | { kind: 'deploy'; unitIds: [string, string]; x: number }
  | { kind: 'intercept'; unitId: string; targetId: string; x: number }
  | { kind: 'attack'; unitId: string; targetId: string }
  | { kind: 'stance'; unitId: string; stance: 'fire' | 'return' }
  | { kind: 'manufacture'; model: Exclude<CommanderModel, 'guard-post' | 'mining-site'> }
  | { kind: 'build'; model: 'guard-post' | 'mining-site'; x: number; facing: -1 | 1 }
  | { kind: 'upgrade'; upgrade: UpgradeId }
  | { kind: 'recover' };

// Stable intention identities are shared by selection and execution. A route
// interception cools its target across position updates and different units.
export function commanderActionKey(action: CommanderAction): string {
  switch (action.kind) {
    case 'haul': return `haul:${action.unitId}:${action.depositId}`;
    case 'stop': return `stop:${action.unitId}`;
    case 'home': return `home:${action.unitId}`;
    case 'dump-cargo': return `dump-cargo:${action.unitId}`;
    case 'cancel-repair': case 'repair': case 'dismantle': return `${action.kind}:${action.unitId}`;
    case 'salvage': return `salvage:${action.wreckId}`;
    case 'explore': return `explore:${action.unitId}:${action.x}`;
    case 'reconnoitre': return `reconnoitre:${action.unitId}:${action.x}`;
    case 'defend': return `defend:${action.unitId}:${action.x}`;
    case 'deploy': return `deploy:${action.unitIds.join(',')}:${action.x}`;
    case 'intercept': return `intercept:${action.targetId}`;
    case 'attack': return `attack:${action.unitId}:${action.targetId}`;
    case 'stance': return `stance:${action.unitId}:${action.stance}`;
    case 'manufacture': return `manufacture:${action.model}`;
    case 'build': return `build:${action.model}:${action.x}:${action.facing}`;
    case 'upgrade': return `upgrade:${action.upgrade}`;
    case 'recover': return 'recover';
    default: { const unexpected: never = action; throw new Error('Unknown commander action: ' + String(unexpected)); }
  }
}
interface OperationTarget { targetId: string; targetX: number; startedAt: number; until: number }
interface OperationForce extends OperationTarget { unitIds: [string, string]; guardId: string; rallyX: number }
export type GroundOperation =
  | (OperationTarget & { phase: 'prepare' })
  | (OperationForce & { phase: 'gather' | 'advance' | 'combat' | 'occupy' })
  | (OperationForce & { phase: 'return'; outcome: 'captured' | 'aborted' });
export interface CommanderChoice {
  action: CommanderAction | null; reason: CommanderReason;
  operation?: GroundOperation | null;
}
export interface CommanderTrace extends Pick<CommanderChoice, 'action' | 'reason'> {
  at: number; result: 'applied' | 'refused' | 'waiting'; detail?: string;
}
export type CommanderOrder =
  | { kind: 'haul'; depositId: string }
  | { kind: 'explore'; x: number }
  | { kind: 'reconnoitre'; x: number }
  | { kind: 'defend'; x: number }
  | { kind: 'home' }
  | { kind: 'intercept'; targetId: string; x: number; until: number };
// Persistent strategic memory. Actual orders, cargo and services remain with
// Squad/Room; timers use world seconds so cold resumes do not reset them.
export interface CommanderState {
  enabled: boolean; profile: CommanderProfile; nextAt: number; sequence: number; actions: number; refusals: number;
  cooldowns: Record<string, number>;
  blocked: Record<string, { reason: string; until: number }>;
  orders: Record<string, CommanderOrder>;
  deferredRepairs: string[];
  history: CommanderTrace[];
  operation: GroundOperation | null;
}
export interface CommanderUnit {
  id: string; x: number; vehicle: boolean; armed: boolean; artillery: boolean; builder: boolean; supply: boolean;
  extracts: CargoKind[]; carries: CargoKind[]; fuel: number; fuelCapacity: number; cargo: number; health: number; maxHealth: number;
  ammoRatio: number; attack: string | null;
  calm: boolean; still: boolean; manual: boolean; salvage: SupplyBill;
  maintenance: ({ critical: boolean; cost: SupplyBill } & (
    { phase: 'repairing'; payer: string | null } | { phase: 'needed' | 'declined'; available: boolean }
  )) | null;
  // Native estimate with current fuel: speed in m/s, remaining range in metres.
  mobility: { speed: number; range: number } | null;
  aircraft: boolean; combatAt: number | null;
  ready: boolean; atBase: boolean; atDepot: boolean; moving: boolean; home: boolean; auto: boolean; stance: string; halt: string;
  haul: { depositId: string; phase: string } | null;
  job: { kind: string | null; phase: string; reason: string } | null;
}
export interface CommanderDeposit {
  id: string; x: number; material: CargoKind; reserve: number; left: number; stock: number; seen: boolean; at: number | null;
}
export interface CommanderOffer { model: CommanderModel; cost: SupplyBill; artilleryRange?: number; x?: number; facing?: -1 | 1 }
// Signals may warn workers but never identify an attack target. A contact is
// currently held by sight/radar; grounded requires surveyed terrain there.
export type CommanderThreat =
  | { kind: 'signal'; x: number }
  | { kind: 'contact'; id: string; x: number; channel: 'seen' | 'radar'; armed: boolean | null; grounded: boolean };
export interface CommanderObservation {
  wrecks: Pick<WreckView, 'id' | 'x' | 'value' | 'inReach' | 'calmIn'>[];
  time: number; playerId: string; factionId: string; base: { x: number; facing: -1 | 1 } | null; stock: SupplyBill;
  recovery: { offered: boolean } | null; besieged: boolean; industry: { levels: IndustryLevels; pending: boolean };
  units: CommanderUnit[]; deposits: CommanderDeposit[];
  offers: CommanderOffer[]; upgrades: { id: UpgradeId; cost: SupplyBill; eligible: boolean }[];
  explored: readonly (readonly [number, number])[] | null; bounds: { minX: number; maxX: number };
  danger: readonly { lo: number; hi: number }[]; threats: readonly CommanderThreat[];
  batteries: readonly { x: number; error: number; at: number }[];
  works: { id: string; model: string; x: number; complete: boolean }[];
  bases: { id: string; x: number; radius: number; seen: boolean; at: number | null; sheltered: boolean }[];
  taken: { factionId: string; at: number } | null;
}
