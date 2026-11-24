import type { AuthoredConstruction } from './construction-contract.ts';
import type { CaptureState } from './economy.ts';
import type { FactionService } from './construction-service.ts';
import type { SupplyBill, CargoLoad, StockId } from './economy-contract.ts';
import type { FlagChoice } from './flag.ts';
import type { SquadUnitView } from './squad-contract.ts';
import type { DispatchPhase, DispatchView, JobReason } from './automatic-jobs.ts';
import type { ActivityView, WorkView, HeapView, IndustryView, RoadworkView } from './field-service-contract.ts';
import type { DuelView } from './duel.ts';

// Transported observations of a field. These DTOs carry no server instances.
export type RawLoad = Required<CargoLoad>;
export type Facing = -1 | 1;
export type MemberRole = 'leader' | 'admin' | 'member';
export type AiStatus = 'active' | 'paused';
export type Span = readonly [number, number];
export type Objective = 'selectMiner' | 'collectOre' | 'deliverOre' | 'directControl' | 'fabricateVehicle' | 'buildDefense';
export interface FieldIdentity { name: string; nation: string | null; flag: FlagChoice }
export interface PublicIdentity extends FieldIdentity { ref: string }
export interface FieldStanding { id: string | null; name: string | null; nation: string | null; flag: FlagChoice; ai?: AiStatus }
export interface FieldBase { x: number; y: number; facing: Facing; radius: number }
export interface KnownBase { x: number; facing: Facing; at: number }
export interface FieldPerson { id: string; name: string; connected: boolean | undefined; invited: boolean; ai?: AiStatus }
export interface FieldPresence { id: string; connected?: boolean | undefined; ai?: AiStatus }
export interface ChatMessage { id: string; of: string; by: string; nation: string; at: number; scope: 'global' | 'faction' | 'allies'; text: string; to?: string[] }
export type StockWantKind = 'ammo' | 'fuel' | 'repair' | 'work' | 'road';
export interface StockWantFor { kind: StockWantKind; n: number; fixed?: number; name?: string | undefined }
export interface StockWant { level: 'waiting' | 'short'; missing: number; for: StockWantFor[] }
export type StockWants = Partial<Record<StockId, StockWant>>;
export interface TradeView { id: string; from: PublicIdentity; to: PublicIdentity; give: SupplyBill; want: SupplyBill; acceptedAt?: undefined }
export interface AccordView { id: string; from: PublicIdentity; to: PublicIdentity; text: string; kind?: 'declaration' | 'alliance'; acceptedAt: number | null }
export interface RecoveryOffer { base: SupplyBill | null; lorry: SupplyBill | null; reserve: number; aid: SupplyBill; offered: boolean; wait?: number }
export interface RecoveryRecord { at: number; base: number | null; from: number | null; lorry: boolean; aid: SupplyBill; aidAt?: number }
export interface FieldCapture { progress: number; at: number; state: CaptureState }
export interface FieldRefilled { at: number; until: number; fuelLitres: number; rounds: number }
export interface FieldCargoWork { kind: 'load'; until?: number; waiting?: true; limited?: true }
export type FieldToolStatus = { limit: 'engine' | 'fuel'; pace?: never; tool?: never } |
  { pace: number; limit?: 'engine' | 'fuel' | 'power'; tool?: never } |
  { limit: 'ground'; tool: 'blade' | 'paver'; pace?: never };
export interface FieldDispatchComing { phase: DispatchPhase | 'dismantle'; reason: JobReason }
export interface FieldServicePoint { supplier: string | null; stock: SupplyBill | null; held: string; calmUntil?: number }
export interface UnitView {
  id: string; vehicle: boolean; value: SupplyBill; built: SupplyBill; repair: SupplyBill; repairSeconds: number; rearm: SupplyBill;
  mend: { cost: SupplyBill; seconds: number } | null; atBase: boolean; atPost?: boolean; calm: boolean; calmUntil?: number;
  fuelLow?: boolean; refilled?: FieldRefilled; cargoWork?: FieldCargoWork;
  builder?: { reach: number; ready: boolean; reason: string; working: string | null }; road?: boolean;
  auto?: boolean; job?: DispatchView; homing?: boolean; aloft?: boolean;
  still: boolean; service: FactionService<FieldDispatchComing | null> | null; declined: boolean; cargo: RawLoad;
  fill: { solid: number; liquid: number; supplies: number }; loading: string | null; extracting: string | null; tools?: FieldToolStatus;
  supplies: SupplyBill | null; serves: boolean; load: SupplyBill | null; mix?: { held: SupplyBill; fill: number };
  point: (FieldServicePoint & { resupply: SupplyBill }) | null; mender: FieldServicePoint | null;
}
export interface KnownWreck { id: string; name: string; x: number; until: number; value: SupplyBill; cargo: RawLoad }
export interface WreckView extends KnownWreck { inReach: boolean; calmIn: number | null }
export interface DepositView { id: string; left: number; stock: number; at: number | null; seen: boolean; loading: boolean; extracting: boolean; active: boolean }
export interface RoomSquadView {
  manual: string | null;
  units: (SquadUnitView & { reserved?: boolean; by?: { id: string; name: string } })[];
  out: string[];
}
export interface FactionView extends FieldIdentity {
  duel?: DuelView;
  id: string; ref: string; stock: SupplyBill; wants: StockWants; yard: RawLoad; base: FieldBase | null;
  industry: IndustryView; objectives: { fieldId: string; completed: Record<Objective, boolean> };
  recovery: RecoveryOffer | null; recovered: RecoveryRecord | null;
  fell: { at: number; from: number; by: FieldIdentity | null; dismantled: number; returned: SupplyBill; cargo: RawLoad; stock: SupplyBill; yard: RawLoad } | null;
  removed: { at: number; from: { name: string; nation: string | null } } | null;
  explored: readonly Span[] | null; siege: FieldCapture | null;
  taking: (FieldIdentity & FieldCapture & { id: string; post?: string; x?: number; sheltered: boolean; full?: boolean })[];
  lost: { at: number; x: number; by: FieldIdentity | null; yard: RawLoad } | null;
  seized: { at: number; x: number; of: FieldIdentity | null } | null;
  taken: { at: number; of: FieldIdentity | null; dismantled: number; stock: SupplyBill; yard: RawLoad } | null;
  bases: (FieldIdentity & { id: string; x: number; facing: Facing; radius: number; seen: boolean; at: number | null; sheltered: boolean })[];
  outposts: (FieldIdentity & { id: string; of: string; x: number; facing: Facing; radius: number; seen: boolean; at: number | null; sheltered: boolean })[];
  members: (Pick<FieldPerson, 'id' | 'name' | 'connected' | 'ai'> & { role: MemberRole })[];
  known: (FieldIdentity & { id: string; color: string | null; members: FieldPerson[]; seen: boolean; at: number | null; x: number | null; defeated: number | null })[];
  strangers: FieldPerson[]; ranking: (FieldStanding & { ref: string; wealth: number })[];
  invites: (FieldIdentity & { factionId: string; ref: string; members: number })[];
  request: (FieldStanding & { ref: string }) | null;
  requests: (Pick<FieldPerson, 'id' | 'name' | 'connected' | 'ai'> & { from: FieldStanding })[];
  library: { id: string; name: string; author: string; by: string; at: number }[];
  trades: TradeView[]; accords: AccordView[]; count: number; counts: { vehicles: number; fixed: number };
  posts: { id: string; x: number; facing: Facing; radius: number; eye: number; sight: number;
    takedown: { progress: number; seconds: number; building: boolean; sent: FieldDispatchComing | null } | null;
    siege: (FieldCapture & { by: FieldIdentity | null }) | null }[];
  territory: { kind: string; color: string | null; spans: readonly Span[] }[];
  units: UnitView[]; wrecks: WreckView[]; deposits: DepositView[]; activity: ActivityView | null;
  works: WorkView[]; heaps: HeapView[]; roadworks: RoadworkView[];
}
export interface FieldDesign { id: string; blueprint: AuthoredConstruction }
