import type { AuthoredConstruction } from './construction-contract.ts';
import type { SupplyBill } from './economy-contract.ts';
import type { DispatchPhase, JobReason } from './automatic-jobs.ts';
import type { IndustryLevels, UpgradeId } from './industry.ts';
import type { RoadKind } from './roads.ts';

type Facing = -1 | 1;
export interface HeapView { id: string; x: number; stock: SupplyBill }
export interface PendingUpgrade { id: number; upgrade: UpgradeId; by: string; startedAt: number; until: number; cost: SupplyBill }
export interface IndustryView { levels: IndustryLevels; pending: PendingUpgrade | null }
export interface RoadworkView { id: string; x0: number; x1: number; kind: RoadKind; graded: number; paved: number; working: ('grade' | 'pave')[]; coming: boolean }
interface WorkViewFields {
  id: string; name: string | undefined; x: number; facing: Facing; cost: SupplyBill; delivered: SupplyBill;
  progress: number; share: number; seconds: number; building: boolean; waiting: boolean;
  sent: { phase: DispatchPhase | 'dismantle'; reason: JobReason } | null; supplying: boolean;
  blocked: string; from: string | null; lack: SupplyBill;
}
export type WorkView = WorkViewFields & ({ post: true; blueprint?: never } | { post?: never; blueprint: AuthoredConstruction });

export interface ActivitySiteBase { id: string; type: 'airdrop'; feature: 'airdrop'; x: number }
export type ActivitySite = ActivitySiteBase & (
  { refined: true; supplies: SupplyBill; material?: never; reserve?: never; stock?: never; left?: never } |
  { material: 'ferro'; reserve: number; refined?: never; supplies?: never; stock?: number; left?: number }
);
export type ActivityPhase = 'withdrawal' | 'announcement' | 'collection';
export type ActivityView = ActivitySite & { arrivesAt: number; expiresAt: number; retireAt?: number; guarded: true;
  phase: ActivityPhase; active: boolean; seen: true };
