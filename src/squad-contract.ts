import type { Point } from './math.ts';
import type { CargoKind } from './economy-contract.ts';
import type { HaulPhase } from './automatic-jobs.ts';
import type { TerrainSpeedPlan } from './terrain-speed.ts';
import type { Trajectory } from './weapons.ts';
import type { SceneActor, LiveModule } from './scene-contract.ts';
import type { Terrain } from './terrain.ts';
import type { World } from './physics.ts';
import type { PilotBounds } from './scripted-contract.ts';

export type SquadStance = 'hold' | 'return' | 'fire';
export type FuelRefusal = 'returning' | 'short';
export interface SquadSpan { lo: number; hi: number }
export interface SquadLandingSpan extends SquadSpan { strict?: boolean | undefined }
export type SquadLandingReason = 'order' | 'fuel' | 'mend' | 'forced' | 'work' | 'ammo';
export type SquadMovePurpose = 'order' | 'home' | 'fire' | 'strike' | 'land';

// A leg retains independent measurements of ground travel, flight and landing.
// Landing is not a dispatch phase and does not replace an aircraft's height.
export interface SquadMove {
  x: number; best: number; since: number; turning: boolean;
  purpose?: SquadMovePurpose | undefined;
  height?: number | undefined; sky?: true | undefined; land?: SquadLandingReason | undefined;
  within?: SquadSpan | undefined; arrival?: number | undefined; pace?: number | undefined;
  bearing?: { low: number; at: number } | undefined;
  lean?: { down: boolean; since: number; top: number; speed: number; at: number } | null | undefined;
  servo?: { sum: number; start: number; at: number } | undefined;
  flown?: number | undefined; borne?: boolean | undefined; down?: boolean | undefined; straight?: boolean | undefined;
  slack?: number | null | undefined; tipping?: { heading: number; value: number } | undefined;
}

export type SquadHaulBlock = 'immobile' | 'blocked-way' | `stuck-${string}`;
export const isSquadHaulBlock = (value: unknown): value is SquadHaulBlock => typeof value === 'string' &&
  (value === 'immobile' || value === 'blocked-way' || value.startsWith('stuck-'));
interface HaulProgress {
  depositId: string; phase: HaulPhase;
  blocked?: SquadHaulBlock | undefined; empty?: boolean | undefined; far?: boolean | undefined; fled?: boolean | undefined;
  fuel?: boolean | undefined; full?: boolean | undefined; interrupted?: string | undefined; mend?: boolean | undefined;
  once?: boolean | undefined; parkedAt?: number | undefined; threat?: string | undefined; waiting?: boolean | undefined;
}
export type SquadHaul = HaulProgress & (
  { material: CargoKind; refined?: false | undefined } |
  { refined: true; material?: never }
);
export type SquadAttack = { targetId: string; point?: never } | { point: Point; targetId?: never };
export interface SquadPointOrder { point: Point; id?: string | undefined; targetId?: string | null | undefined }
export interface SquadCounter extends SquadPointOrder { id: string }
export interface SquadBurn { at: number; litres: number; x: number; y: number; vx: number; scale: number | null }
export type SquadHeard = { event: string; channel: string } & ({ x: number; side?: never } | { side: number; x?: never });
export interface SquadGunWay { componentId: string; trajectory: Trajectory; charge?: number | 'auto' | undefined }
export interface SquadLaidGun extends Point { angle: number; way: SquadGunWay | null; turned?: SquadGunWay | null | undefined }

// These channels coexist: explicit orders, logistics, transient combat and
// service ownership remain separate facts rather than one combined mode.
export interface SquadOrders {
  stance: SquadStance; fireAt: number | null; move: SquadMove | null;
  attack: SquadAttack | null; haul: SquadHaul | null; halt: string;
}
export interface SquadUnit extends SquadOrders {
  alertUntil: number; answerUntil: number; heardAt: number; heard: SquadHeard | null;
  threat: boolean; scare: { from: number; spent: number; looked: number } | null;
  activity: string; reason: string; targetId: string | null; counter: SquadCounter | null;
  counters: Map<string, SquadCounter>;
  burn?: SquadBurn | null | undefined; fireHeight?: { anchor: number; y: number } | undefined;
  fought?: boolean | undefined; gained?: { carried: number; at: number } | undefined;
  haltEvent?: string | null | undefined; hopped?: boolean | undefined; mend?: boolean | undefined;
  laid?: Map<SquadPointOrder, Map<string, SquadLaidGun>> | undefined;
  shotAt?: number | null | undefined; takeoff?: { x: number; mass: number } | undefined;
  thrust?: number | undefined; turnAim?: SquadPointOrder | undefined; weave?: { way: number } | null | undefined;
  terrainPlan?: SquadTerrainPlan | undefined;
}
// Object identities are part of cache invalidation; the concrete world types
// are supplied by the physics contract rather than a replacement scene.
export interface SquadTerrainPlan {
  leg: SquadMove; actor: SceneActor; revision: number; modules: readonly LiveModule[]; parts: readonly LiveModule[];
  terrain: Terrain; explored: readonly (readonly [number, number])[] | null | undefined;
  heading: number; to: number; x: number; time: number; speed: number; mass: number; length: number;
  height: number; pressure: number; plan: TerrainSpeedPlan;
}

export type SquadCommand =
  | { order: 'control'; id?: string | null | undefined }
  | { order: 'stance'; ids: string[]; stance: SquadStance }
  | { order: 'move'; ids: string[]; x: number; y?: number | undefined }
  | { order: 'attack'; ids: string[]; targetId: string }
  | { order: 'bombard'; ids: string[]; point: Point }
  | { order: 'haul'; ids: string[]; depositId: string }
  | { order: 'stop' | 'home'; ids: string[] };

export interface SquadMember { id: string; team: 'local' | 'ally' | 'opponent'; role: string; pilot?: string | undefined }
export interface SquadUnitView {
  id: string; role: string; defeated: boolean; stance: SquadStance;
  move: { x: number; height?: number | undefined; land?: SquadLandingReason | undefined; home?: true | undefined } | null;
  attack: SquadAttack | null; haul: SquadHaul | null; counter: { x: number } | null;
  alert: boolean; heard: SquadHeard | null; activity: string; reason: string;
  haltEvent?: string | undefined; targetId: string | null;
}
export interface SquadView { manual: string | null; units: SquadUnitView[] }
export interface SquadDepositArea extends SquadSpan { goal: number; digs: boolean; ready: boolean }
export interface SquadVein { id: string; x: number; reach: number }
interface SquadDepositPlace { id?: string | undefined; x: number; reach: number; stock: number; stilled: boolean; area?: SquadDepositArea | null | undefined }
export type SquadDeposit = SquadDepositPlace & (
  { material: CargoKind; left: number; refined?: false | undefined } |
  { refined: true; material?: never; left?: never }
);
export interface SquadDepot { x: number; radius: number; post?: string | null | undefined }
export interface SquadBattery extends Point { id: string; error: number; y: number }
export interface SquadGroundBattery { id: string; x: number; error: number; y?: number | undefined; at: number }
export interface SquadThreat extends Point { id: string; reach: number | null }
export interface SquadWhereabouts extends Point { seen?: boolean | undefined }
export interface SquadFreeFireRegion { anchor: number | null; radius: number; home?: boolean | undefined }
export interface SquadLoad { room: number; carried: number; waiting?: boolean | undefined; full?: boolean | undefined; extracts: boolean }
export interface SquadSide {
  readonly world: World; readonly arenaBounds: PilotBounds; readonly roster: readonly SquadMember[];
  readonly defeats: Readonly<Record<string, boolean | string | undefined>>;
  readonly batteries: readonly SquadGroundBattery[];
  readonly faction?: { explored?: readonly (readonly [number, number])[] | null | undefined } | undefined;
  input(id: string, input: object, decision?: boolean): unknown;
  member(actor: SceneActor): SquadMember;
  foe(id: string): boolean; sighted(id: string): boolean;
  deposit(id: string, actorId?: string): SquadDeposit | null;
  veinAt(x: number): SquadVein | null;
  depot?(id: string, x?: number): SquadDepot | null;
  load?(id: string): SquadLoad;
  role?(id: string, material: CargoKind | undefined): 'digs' | 'carries' | null;
  readonly fuelled?: boolean;
  tipped?(id: string): boolean;
  freeFireRegion(id: string, anchor: number | null): SquadFreeFireRegion | null;
  homing?(id: string): boolean;
  threats?(): readonly SquadThreat[];
  whereabouts?(id: string): SquadWhereabouts | null;
  turnAbout?(id: string): boolean;
  unhook?(id: string): boolean;
  knowsGround?(x: number): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown): boolean => value === undefined || finite(value);
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';
const point = (value: unknown): value is Point => isRecord(value) && finite(value.x) && finite(value.y);
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id: unknown) => typeof id === 'string');
export const isSquadStance = (value: unknown): value is SquadStance => value === 'hold' || value === 'return' || value === 'fire';
// Network payloads are decoded before the squad checks what the side knows or
// owns. This does not claim vehicles, admit a haul, or change any live orders.
export function decodeSquadCommand(value: unknown): SquadCommand {
  if (!isRecord(value)) throw new Error('Ordem desconhecida.');
  if (value.order === 'control') {
    if (value.id !== null && value.id !== undefined && typeof value.id !== 'string') throw new Error('Este veículo não pode ser controlado.');
    return { order: 'control', id: value.id ?? null };
  }
  const named = value.ids == null ? [] : value.ids;
  if (!ids(named)) throw new Error('Ordem inválida.');
  switch (value.order) {
    case 'stance':
      if (!isSquadStance(value.stance)) throw new Error('Postura desconhecida.');
      return { order: 'stance', ids: named, stance: value.stance };
    case 'move':
      if (!finite(value.x) || value.y != null && !finite(value.y)) throw new Error('Destino inválido.');
      return { order: 'move', ids: named, x: value.x, ...(value.y == null ? {} : { y: value.y }) };
    case 'attack':
      if (typeof value.targetId !== 'string') throw new Error('Alvo inválido.');
      return { order: 'attack', ids: named, targetId: value.targetId };
    case 'bombard':
      if (!point(value.point)) throw new Error('Ponto de ataque inválido.');
      return { order: 'bombard', ids: named, point: value.point };
    case 'haul':
      if (typeof value.depositId !== 'string') throw new Error('Jazida desconhecida: escolha uma que a facção já encontrou. Explore o campo para achar outras.');
      return { order: 'haul', ids: named, depositId: value.depositId };
    case 'stop': case 'home': return { order: value.order, ids: named };
    default: throw new Error('Ordem desconhecida.');
  }
}
export function isSquadMove(value: unknown): value is SquadMove {
  if (!isRecord(value) || !finite(value.x) || !finite(value.best) || !finite(value.since) || typeof value.turning !== 'boolean') return false;
  if (value.purpose !== undefined && (typeof value.purpose !== 'string' || !['order', 'home', 'fire', 'strike', 'land'].includes(value.purpose))) return false;
  if (value.land !== undefined && (typeof value.land !== 'string' || !['order', 'fuel', 'mend', 'forced', 'work', 'ammo'].includes(value.land))) return false;
  if (value.sky !== undefined && value.sky !== true) return false;
  if (![value.height, value.arrival, value.pace, value.flown].every(optionalNumber) ||
    ![value.borne, value.down, value.straight].every(optionalBoolean) || value.slack !== null && !optionalNumber(value.slack)) return false;
  if (value.within !== undefined && (!isRecord(value.within) || !finite(value.within.lo) || !finite(value.within.hi))) return false;
  if (value.bearing !== undefined && (!isRecord(value.bearing) || !finite(value.bearing.low) || !finite(value.bearing.at))) return false;
  if (value.lean !== undefined && value.lean !== null && (!isRecord(value.lean) || typeof value.lean.down !== 'boolean' ||
    ![value.lean.since, value.lean.top, value.lean.speed, value.lean.at].every(finite))) return false;
  if (value.servo !== undefined && (!isRecord(value.servo) || ![value.servo.sum, value.servo.start, value.servo.at].every(finite))) return false;
  if (value.tipping !== undefined && (!isRecord(value.tipping) || !finite(value.tipping.heading) || !finite(value.tipping.value))) return false;
  return true;
}
export function isSquadAttack(value: unknown): value is SquadAttack {
  return isRecord(value) && (typeof value.targetId === 'string' && value.point === undefined || point(value.point) && value.targetId === undefined);
}
export function isSquadHaul(value: unknown): value is SquadHaul {
  if (!isRecord(value) || typeof value.depositId !== 'string' || typeof value.phase !== 'string' || !['out', 'load', 'home', 'unload'].includes(value.phase)) return false;
  if (value.refined === true ? value.material !== undefined :
    value.refined !== undefined && value.refined !== false || typeof value.material !== 'string' || !['ferro', 'ligas', 'silica', 'petroleo'].includes(value.material)) return false;
  if (![value.empty, value.fled, value.fuel, value.full, value.mend, value.once, value.waiting, value.far].every(optionalBoolean) ||
    ![value.parkedAt].every(optionalNumber)) return false;
  return (value.blocked === undefined || isSquadHaulBlock(value.blocked)) &&
    [value.interrupted, value.threat].every(v => v === undefined || typeof v === 'string');
}
export function isSquadOrders(value: unknown): value is SquadOrders {
  return isRecord(value) && isSquadStance(value.stance) && (value.fireAt === null || finite(value.fireAt)) && typeof value.halt === 'string' &&
    (value.move === null || isSquadMove(value.move)) && (value.attack === null || isSquadAttack(value.attack)) && (value.haul === null || isSquadHaul(value.haul));
}
export function decodeSquadOrders(value: unknown): SquadOrders {
  if (!isSquadOrders(value)) throw new Error('Ordens salvas do esquadrão inválidas.'); return value;
}
