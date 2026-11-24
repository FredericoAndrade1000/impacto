import type { ConstructionSource } from './construction-contract.ts';
import type { SupplyBill } from './economy-contract.ts';
import type { RawLoad, FieldBase, FieldDesign, FactionView, RoomSquadView, ChatMessage } from './field-contract.ts';
import type { FlagChoice } from './flag.ts';
import type { Point } from './math.ts';
import type { SquadCommand } from './squad-contract.ts';
import type { WireMessage } from './message-contract.ts';
import type { ConstructionTemplateId } from './construction-template-catalogue.ts';
import type { UpgradeId } from './industry.ts';
import type { WeaponOverrides } from './weapons.ts';

export type TestSpeed = 1 | 2 | 4 | 8;
export type TestAct = 'list' | 'spawn' | 'repair' | 'resupply' | 'reposition' | 'resources' | 'speed';
export interface TestActor { id: string; name: string; x: number; facing: number; mobile: boolean; active: boolean }
export type TestRequest =
  | { act: 'list' }
  | { act: 'speed'; factor: TestSpeed }
  | { act: 'resources'; stock: SupplyBill }
  | { act: 'spawn'; kind: 'vehicle' | 'target'; templateId: ConstructionTemplateId; x: number; facing: -1 | 1; ticket?: string }
  | { act: 'repair'; actorId: string }
  | { act: 'resupply'; actorId: string }
  | { act: 'reposition'; actorId: string; x: number; facing: -1 | 1 };
export type TestIntent = TestRequest & { type: 'test' };
export type TestResult = { actors: TestActor[] } | { factor: TestSpeed } | { stock: SupplyBill } | { actor: FieldDesign } | { changed: string };
export type TestResultFor<Act extends TestAct> = Act extends 'list' ? { actors: TestActor[] } : Act extends 'resources' ? { stock: SupplyBill } :
  Act extends 'speed' ? { factor: TestSpeed } : Act extends 'spawn' ? { actor: FieldDesign } : { changed: string };
export interface ActorCommand { actorId?: string | null | undefined }
export interface GunCommand extends ActorCommand { aim?: Point; weapon?: WeaponOverrides & { also?: WeaponOverrides[] }; queue?: boolean; cancel?: boolean }
export type LibraryRequest = { act: 'publish'; blueprint: ConstructionSource } | { act: 'get'; ids: string[] } | { act: 'remove'; id: string };
export type LibraryAct = LibraryRequest['act'];
export interface LibraryDesign extends FieldDesign { name: string; author: string; by: string; at: number }
export type LibraryResultFor<Act extends LibraryAct> = Act extends 'get' ? { models: LibraryDesign[] } : Act extends 'publish' ?
  { model: { id: string; name: string; replaced: boolean } } : CommonReceipt;
export interface PublicationCommand extends ActorCommand { blueprint: ConstructionSource; x?: number; facing?: number; ticket?: string; instant?: boolean }
export interface PlacementCommand extends ActorCommand { x?: number; facing?: number; ticket?: string; instant?: boolean }
export type SquadClientCommand = SquadCommand | { order: 'free' | 'turn'; ids: string[] };
export interface CommandData {
  rekey: {}; rename: { name: string }; release: {}; recover: {};
  blueprint: ActorCommand; select: ActorCommand; remove: ActorCommand; 'cancel-dismantle': ActorCommand;
  abandon: ActorCommand; repair: ActorCommand; 'cancel-repair': ActorCommand; 'dump-cargo': ActorCommand;
  auto: ActorCommand & { on: boolean }; homing: ActorCommand & { on: boolean };
  spawn: PublicationCommand; replace: PublicationCommand; relocate: PlacementCommand; post: PlacementCommand;
  'remove-post': { postId: string }; 'keep-post': { postId: string }; 'cancel-work': { workId: string };
  road: { x0: number; x1: number; kind: 'graded' | 'asphalt' }; 'cancel-road': { roadId: string };
  salvage: { wreckId: string }; squad: SquadClientCommand;
  tow: ActorCommand & ({ act: 'detach' } | { act: 'attach'; targetId: string; partId?: string; targetPartId?: string; point?: Point; end?: Point });
  invite: { playerId: string; cancel?: boolean }; 'join-faction': { factionId: string }; decline: { factionId: string };
  member: { playerId: string; act: 'admin' | 'member' | 'leader' | 'remove' }; 'leave-faction': {};
  identity: { nation: string; flag: FlagChoice }; apply: { ref: string; cancel?: boolean }; answer: { playerId: string; accept: boolean };
  library: LibraryRequest;
  upgrade: { id: UpgradeId }; 'cancel-upgrade': { id: number };
  trade: { act: 'offer'; ref: string; give: SupplyBill; want: SupplyBill } | { act: 'accept' | 'cancel'; id: string };
  accord: { act: 'propose'; ref: string; text: string; kind?: 'declaration' } | { act: 'propose'; ref: string; kind: 'alliance' } | { act: 'accept' | 'end'; id: string; kind?: 'alliance' };
  chat: { scope: 'global' | 'faction' | 'allies'; text: string }; objectives: { action: 'select'; ids: string[] };
  test: TestRequest; fire: GunCommand & { aim: Point }; aim: GunCommand; trigger: GunCommand & { active: boolean };
  drive: ActorCommand & { throttle: number; brake?: number; rise?: number };
}
export type CommandKind = keyof CommandData;
export interface CommonReceipt { actor?: FieldDesign; selected?: string | null }
export interface PublicationReceipt extends CommonReceipt { cost?: SupplyBill; seconds?: number; work?: { id: string; name?: string | undefined; x: number }; post?: { id: string; x?: number }; blocked?: string | undefined; relocated?: { from: number; to: number } }
export interface ManufactureReceipt extends PublicationReceipt { cost: SupplyBill }
export interface RepairReceipt { partial: boolean; seconds: number; cost: SupplyBill }
export interface CancelRepairReceipt { refund: SupplyBill; lost: SupplyBill; supplier: string | null; gone: boolean }
export type RemoveReceipt = { removed: string; selected: string | null; refund: SupplyBill; cargo: RawLoad } |
  { dismantling: string; seconds: number; value: SupplyBill };
export interface CancelDismantleReceipt { kept: string; heap?: string | null }
export interface CancelWorkReceipt { cancelled: string; heap: { id: string; stock: SupplyBill } | null }
export interface SquadReceipt extends CommonReceipt { refused?: WireMessage; held?: string[]; turning?: string[]; seconds?: number; aloft?: boolean }
export interface CommandResults {
  rekey: { token: string }; rename: { name: string }; release: CommonReceipt; recover: CommonReceipt & { base: FieldBase | null };
  blueprint: { actor: FieldDesign }; select: { selected: string }; remove: RemoveReceipt; 'cancel-dismantle': CancelDismantleReceipt;
  abandon: { removed: string; selected: string | null }; repair: RepairReceipt; 'cancel-repair': CancelRepairReceipt; 'dump-cargo': { dumped: RawLoad };
  auto: { auto: boolean }; homing: { homing: boolean }; spawn: ManufactureReceipt; replace: ManufactureReceipt; relocate: PublicationReceipt; post: ManufactureReceipt;
  'remove-post': { dismantling: string; seconds: number; value: SupplyBill }; 'keep-post': { kept: string }; 'cancel-work': CancelWorkReceipt;
  road: { road: { id: string; x0: number; x1: number; kind: 'graded' | 'asphalt' } }; 'cancel-road': { cancelled: string };
  salvage: { salvaged: string; value: SupplyBill; cargo: RawLoad; left: RawLoad }; squad: SquadReceipt; tow: { towing: boolean };
  invite: CommonReceipt; 'join-faction': CommonReceipt; decline: CommonReceipt; member: CommonReceipt; 'leave-faction': CommonReceipt;
  identity: CommonReceipt; apply: CommonReceipt; answer: CommonReceipt;
  library: LibraryResultFor<LibraryAct>;
  upgrade: { upgrade: UpgradeId; pending?: number; already?: true }; 'cancel-upgrade': { cancelled: number; refund: SupplyBill; already?: true }; trade: { offered?: string; cancelled?: string; traded?: string };
  accord: { proposed?: string; ended?: string; accepted?: string }; chat: { sent: string }; objectives: CommonReceipt;
  test: TestResult; fire: { accepted: boolean }; drive: CommonReceipt; aim: CommonReceipt; trigger: CommonReceipt;
}
export type CommandResult<Kind extends CommandKind = CommandKind> = CommandResults[Kind];
export interface ChatHistory { ref: string | null | undefined; global: ChatMessage[]; faction: ChatMessage[] }
export interface WelcomeMessage {
  type: 'welcome'; playerId: string; token: string; name: string; selected: string | null; base: FieldBase | null;
  faction: FactionView; actors: FieldDesign[]; chat?: ChatHistory; watch?: { x: number; y: number; zoom: number } | null; persistenceFailed?: boolean; testTools?: boolean; factor?: TestSpeed;
}
export interface SquadMetadata { squad: RoomSquadView | null; selected: string | null }
export interface ServerReply { type: 'reply'; request?: number; error?: string; userMessage?: WireMessage; unknownKey?: boolean; nameTaken?: boolean;
  retryable?: boolean; outdated?: boolean; persistenceFailed?: boolean; factor?: TestSpeed }
