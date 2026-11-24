import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { ConstructionService } from '../src/construction-service.ts';
import type { SupplyBill, CargoLoad } from '../src/economy-contract.ts';
import type { Capture } from '../src/economy.ts';
import type { GroundSight } from '../src/ground-sight.ts';
import type { Point } from '../src/math.ts';
import type { Squad } from '../src/squad.ts';
import type { SquadOrders } from '../src/squad-contract.ts';
import type { FlagChoice } from '../src/flag.ts';
import type { IndustryState } from './industry.ts';
import type { IndustryLevels } from '../src/industry.ts';
import type { Work, Heap } from './field-construction.ts';
import type { RoadOrder } from './road-works.ts';
import type { PublicationReceipt } from '../src/field-protocol-contract.ts';
import type { Duel } from '../src/duel.ts';

export type Span = import('../src/ground-sight.ts').SightSpan;
export type RawLoad = Required<CargoLoad>;
export type Facing = -1 | 1;
export type FactionFlag = FlagChoice;
export interface Base { x: number; facing: Facing }
export interface Depot { x: number; radius: number; post: string | null }
export type FactionCapture = Capture & { by: string };
export interface RecoveryRecord { at: number; base: number | null; from: number | null; lorry: boolean; aid: SupplyBill; aidAt?: number }
export interface RecoveryOffer { base: SupplyBill | null; lorry: SupplyBill | null; reserve: number; aid: SupplyBill; offered: boolean; wait?: number }
export interface KnownBase extends Base { at: number }
export interface KnownPost extends KnownBase { of: string }
export interface KnownDeposit { left: number; stock: number; at: number; still: boolean }
export interface FactionMet { since: number; at: number | null; x: number | null; defeatedAt: number | null }
export interface Post {
  id: string; x: number; facing: Facing; yard: RawLoad; refinedAt: number | null;
  salvage: SupplyBill; takedown: { progress: number; seconds: number } | null; capture: FactionCapture | null;
}
export interface LibraryModel { id: string; name: string; author: string; by: string; at: number; blueprint: AuthoredConstruction }
export interface Trade { acceptedAt?: undefined; id: string; from: string; to: string; give: SupplyBill; want: SupplyBill }
export interface Accord { id: string; from: string; to: string; text: string; kind?: 'declaration' | 'alliance'; acceptedAt: number | null }
export type { ChatMessage } from '../src/field-contract.ts';
import type { ChatMessage } from '../src/field-contract.ts';
export interface BaseFall { at: number; from: number; by: string; dismantled: number; returned: SupplyBill; cargo: RawLoad; stock: SupplyBill; yard: RawLoad }
export interface BaseTaken { at: number; of: string; dismantled: number; stock: SupplyBill; yard: RawLoad }
export interface PostLost { at: number; x: number; by: string; yard: RawLoad }
export interface PostSeized { at: number; x: number; of: string }
export interface Faction {
  id: string; ref: string; leader: string; admins: Set<string>; nation: string | null; flag: FactionFlag;
  stock: SupplyBill; yard: RawLoad; refinedAt: number | null; base: Base | null;
  fell: BaseFall | null; recovered: RecoveryRecord | null;
  removed: { at: number; from: { name: string; nation: string | null } } | null;
  capture: FactionCapture | null; taken: BaseTaken | null; away: number | null; fought: number | null; shelter: number | null;
  posts: Post[]; lost: PostLost | null; seized: PostSeized | null; industry: IndustryState;
  wrecks?: Map<string, import('../src/field-contract.ts').KnownWreck>;
  members: Set<string>; invited: Set<string>; met: Map<string, FactionMet>; library: LibraryModel[]; chat: ChatMessage[];
  explored: Span[] | null; seen: Span[]; eyes: GroundSight | null;
  veins: Map<string, KnownDeposit> | null; bases: Map<string, KnownBase> | null; outposts: Map<string, KnownPost> | null;
}
export type Objective = 'selectMiner' | 'collectOre' | 'deliverOre' | 'directControl' | 'fabricateVehicle' | 'buildDefense';
export interface PublicationAnswer extends PublicationReceipt {
  testIntent?: string; answer?: PublicationAnswer;
}
export interface DraftBase { p: Player; faction: Faction; blueprint: AuthoredConstruction; direction: Facing; position: number; cost: SupplyBill }
export interface FieldDraft extends DraftBase { work: true; seconds: number; old?: never }
export interface VehicleDraft extends DraftBase { work?: false; old: import('../src/scene-contract.ts').Actor | null }
export type ManufacturingDraft = FieldDraft | VehicleDraft;
export interface Player {
  id: string; token: string; name: string; color: string; selected: string | null; factionId?: string | null | undefined;
  request: string | null; builtAt: number; published: Map<string, PublicationAnswer>;
  objectives: Partial<Record<Objective, true>>; connected?: boolean; lastInput?: number;
  lapsed?: number; address?: string | null; aidAt?: number; chatAt?: number; hastened?: number;
  // Absent only during initial construction/cold restoration before Squad is attached.
  squad?: Squad;
}
export interface CargoWork { kind: 'load'; until?: number; waiting?: true; limited?: true }
export interface ExtractionWork { partId: string; siteId: string }
export interface BuildingWork { at: string; pace?: number }
export interface RoadWork { tool: 'blade' | 'paver'; from: number; to: number; idle?: true; short?: true }
export interface WreckRecord { until: number; abandoned: boolean; stripped: boolean; damagedShare?: number }
export interface DriveRecord { tick: number; wanted: number; throttle: number; brake: number | undefined; rise: number }
export type ToolStatus = import('../src/field-contract.ts').FieldToolStatus;
export interface RoomRecord {
  arrival: number; combatAt: number; wear: number | null; shots: number | null; wreck: WreckRecord | null;
  service: ConstructionService | null; declined: number | null; pulled: number | null; drive: DriveRecord | null;
  loading: string | null; extraction: ExtractionWork[] | null; tools: ToolStatus | null; building: BuildingWork | null;
  road: RoadWork | null; tipped: number | null; auto: boolean; homing: boolean;
  refilled?: { at: number; until: number; fuelLitres: number; rounds: number };
  cargoWork?: CargoWork | null; gatheredOre?: boolean; supplyDelivery?: true;
}
export type SerialKind = 'j' | 'f' | 'c' | 'r' | 't' | 'a' | 'm';
export type Serials = Record<SerialKind, number>;
// The cold format preserves absence: old free-fire orders acquire an anchor
// once during restoration, and old fields need not have social counters yet.
export type SavedSquadOrders = Omit<SquadOrders, 'fireAt'> & { fireAt?: number | null };
export type SavedSerials = Pick<Serials, 'j' | 'f' | 'c' | 'r'> & Partial<Pick<Serials, 't' | 'a' | 'm'>>;
export type SavedPlayer = Omit<Player, 'squad' | 'published' | 'connected' | 'lastInput' | 'builtAt' | 'address' | 'objectives'> & {
  objectives?: Partial<Record<Objective, boolean>>; published?: [string, PublicationAnswer][]; orders: [string, SavedSquadOrders][];
};
export type SavedFaction = Omit<Faction, 'admins' | 'members' | 'invited' | 'met' | 'eyes' | 'seen' | 'veins' | 'bases' | 'outposts' | 'chat' | 'wrecks'> & {
  admins: string[]; members: string[]; invited: string[]; met: [string, FactionMet][];
  veins: [string, KnownDeposit][] | null; bases?: [string, KnownBase][] | null; outposts: [string, KnownPost][] | null;
  chat?: ChatMessage[];
};
export type SavedRecord = Pick<RoomRecord, 'arrival' | 'wreck' | 'service' | 'declined' | 'tipped'> & {
  combatAt: number | null; auto?: boolean; homing?: boolean; gatheredOre?: boolean; supplyDelivery?: true;
};
export interface RoomSave {
  duel?: Duel;
  fieldId?: string; ground: string; veins: [string, number][]; extracted: [string, number][];
  arrivals: number; founded: number; chance: number; serials: SavedSerials;
  trades?: Trade[]; accords?: Accord[]; chat?: ChatMessage[]; startingIndustry: IndustryLevels;
  activities?: unknown; players: SavedPlayer[]; factions: SavedFaction[];
  // Strategic payloads are validated by their owner after World restores its clock.
  commanders?: [string, unknown][];
  records: [string, SavedRecord][]; works: Work[]; heaps: Heap[]; roadworks: RoadOrder[];
  scene: unknown;
}
export interface SharedRoomOptions {
  stock?: SupplyBill; base?: ((index: number) => number | null | undefined) | null;
  fog?: boolean; random?: (() => number) | null; kept?: unknown; build?: boolean; starter?: boolean; industry?: IndustryLevels;
}
export interface PublishOptions { actorId?: unknown; x?: unknown; facing?: unknown; ticket?: unknown; instant?: boolean }
export interface PlacementRequest { x?: unknown; facing?: unknown; ticket?: unknown; instant?: boolean }
export interface ServicePoint { supplier: import('../src/scene-contract.ts').Actor | null; stock: SupplyBill; held?: string }
export interface PointOrder { order: string; ids?: string[]; id?: string | null; x?: number; y?: number; targetId?: string; point?: Point; stance?: string; depositId?: string }

// Untrusted command values keep their unknown type until each existing command
// branch validates them. This envelope is not an authorization or Native input.
export interface OrderRequest {
 order?: unknown; id?: unknown; ids?: unknown; x?: unknown; y?: unknown; targetId?: unknown; point?: unknown; stance?: unknown; depositId?: unknown;
}
export interface RoomRequest extends OrderRequest {
  type: string; [field: string]: unknown;
  actorId?: unknown; request?: unknown; cancel?: unknown; active?: unknown;
  aim?: unknown; weapon?: unknown; queue?: unknown; ticket?: unknown; blueprint?: unknown;
  x?: unknown; y?: unknown; x0?: unknown; x1?: unknown; facing?: unknown; instant?: unknown;
  order?: unknown; id?: unknown; ids?: unknown; targetId?: unknown; point?: unknown; stance?: unknown; depositId?: unknown;
  act?: unknown; playerId?: unknown; factionId?: unknown; nation?: unknown; flag?: unknown;
  ref?: unknown; accept?: unknown; give?: unknown; want?: unknown; text?: unknown; kind?: unknown; scope?: unknown;
  wreckId?: unknown; on?: unknown; workId?: unknown; roadId?: unknown; postId?: unknown;
  action?: unknown; name?: unknown; throttle?: unknown; brake?: unknown; rise?: unknown;
}
