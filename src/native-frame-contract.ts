import type { NativePowertrain, NativeVehicle } from './native-contract.gen.ts';
import type { Point, Pose } from './math.ts';
import type { SceneStats, SceneProjectile, SceneTow, SceneEvent, SceneEventBase, EventPoint,
  SurfaceMark, PlateDent, PlatePerforation, BarrelMark, MantletHole, GroundContact, SuspensionState, LiveModule } from './scene-contract.ts';
import type { ShotKind } from './shots.ts';
import type { CargoLoad } from './economy-contract.ts';
import type { MaterialGrid } from './armor-grid.ts';
import { MODULES } from './materials.ts';
import type { ModuleKind } from './materials.ts';
import { AMMO } from './weapons.ts';
import type { AmmoId } from './weapons.ts';
import { VEHICLE_STATE } from './native-vehicle.ts';
import type { ActorOptions } from './physics.ts';

export type Guard<T> = (value: unknown) => value is T;
export const nativeRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const nativeBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const nativeString = (value: unknown): value is string => typeof value === 'string';
export const nativePoint = (value: unknown): value is Point => nativeRecord(value) && finiteNumber(value.x) && finiteNumber(value.y);
export const nativePose = (value: unknown): value is Pose => nativeRecord(value) && nativePoint(value) && finiteNumber(value.angle);
const nullableNumber = (value: unknown): value is number | null => value === null || finiteNumber(value);
const nullableString = (value: unknown): value is string | null => value === null || nativeString(value);
const moduleKind = (value: unknown): value is ModuleKind => nativeString(value) && Object.hasOwn(MODULES, value);
const ammo = (value: unknown): value is AmmoId => nativeString(value) && Object.hasOwn(AMMO, value);

export function nativeArray<T>(value: unknown, guard: Guard<T>): value is T[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) if (!guard(entry)) return false;
  return true;
}
const numbers = (value: unknown): value is number[] => nativeArray(value, finiteNumber);
const points = (value: unknown): value is Point[] => nativeArray(value, nativePoint);
const station = (value: unknown): value is NativeVehicle['station'] => Array.isArray(value) && value.length === 2 && nullableNumber(value[0]) && nullableNumber(value[1]);

const powertrainFields = {
  powerKw: finiteNumber, torqueNm: finiteNumber, efficiency: finiteNumber, rollingCoefficient: finiteNumber,
  drag: finiteNumber, dragAstern: finiteNumber, dragOver: finiteNumber, dragUnder: finiteNumber,
  radius: finiteNumber, maxDriveForce: finiteNumber, gearedSpeed: nullableNumber, maxSpeed: finiteNumber,
  powerPerTonne: finiteNumber, fueled: nativeBoolean, fuelLitres: finiteNumber, rangeKm: finiteNumber,
  fuelStarved: nativeBoolean, tracked: nativeBoolean,
} satisfies { [K in keyof NativePowertrain]: Guard<NativePowertrain[K]> };
const powertrainEntries = Object.entries(powertrainFields);
function fieldsMatch(value: Record<string, unknown>, fields: readonly (readonly [string, Guard<unknown>])[]): boolean {
  for (const [key, guard] of fields) if (!guard(value[key])) return false;
  return true;
}
export const nativePowertrain = (value: unknown): value is NativePowertrain => nativeRecord(value) && fieldsMatch(value, powertrainEntries);
type VehicleSchema = { [K in keyof NativeVehicle]: Guard<NativeVehicle[K]> };
const vehicleFields: VehicleSchema = {
  x: finiteNumber, y: finiteNumber, angle: finiteNumber, enabled: nativeBoolean,
  mass: finiteNumber, massTonnes: finiteNumber, inertia: finiteNumber, carrierMass: finiteNumber, carrierInertia: finiteNumber,
  localCenter: nativePoint, carrierCenter: nativePoint, maxSpeed: finiteNumber, powerKw: finiteNumber, powerPerTonne: finiteNumber,
  fuelStarved: nativeBoolean, fuelLitres: finiteNumber, vx: finiteNumber, vy: finiteNumber, omega: finiteNumber, travel: finiteNumber,
  engine: nativeBoolean, throttle: finiteNumber, brake: finiteNumber, traction: finiteNumber, gearCount: finiteNumber,
  suspensionCount: finiteNumber, driveSpeed: finiteNumber, groundSlope: finiteNumber, groundSurface: nullableString,
  groundGrip: finiteNumber, groundLoad: finiteNumber, groundPressureKPa: finiteNumber, groundResistance: finiteNumber,
  softGroundLoad: finiteNumber, lastImpulse: finiteNumber, peakImpulse: finiteNumber, fuelRate: finiteNumber, slip: finiteNumber,
  slipped: finiteNumber, stuck: nullableString, rise: finiteNumber, flying: nativeBoolean, grounded: nativeBoolean,
  thrustN: finiteNumber, station, drivetrain: nativePowertrain,
} satisfies { [K in keyof NativeVehicle]: Guard<NativeVehicle[K]> };
const vehicleEntries = Object.entries(vehicleFields);
export const nativeVehicle = (value: unknown): value is NativeVehicle => nativeRecord(value) && fieldsMatch(value, vehicleEntries);
type VehicleStateKey = (typeof VEHICLE_STATE)[number];
type VehicleState = Partial<Pick<NativeVehicle, VehicleStateKey>>;
function restoreVehicleField<K extends VehicleStateKey>(target: VehicleState, source: Record<string, unknown>, key: K): void {
  const value = source[key], guard = vehicleFields[key];
  if (value === undefined) return;
  if (!guard(value)) throw new TypeError(`Invalid saved vehicle field: ${key}.`);
  target[key] = value;
}
export function restoreVehicleState(target: VehicleState, source: Record<string, unknown>): void {
  for (const key of VEHICLE_STATE) restoreVehicleField(target, source, key);
}

export const nativeGrid = (value: unknown): value is MaterialGrid => nativeRecord(value) && finiteNumber(value.version) &&
  finiteNumber(value.nx) && finiteNumber(value.ny) && nativeString(value.bits) && nativeBounds(value.bounds);
const nativeBounds = (value: unknown): value is { minX: number; maxX: number; minY: number; maxY: number } => nativeRecord(value) &&
  ['minX', 'maxX', 'minY', 'maxY'].every(key => finiteNumber(value[key]));
export const nativeMark = (value: unknown): value is SurfaceMark => nativeRecord(value) && finiteNumber(value.u) && finiteNumber(value.v) &&
  nativeString(value.kind) && finiteNumber(value.strength) && ['radiusU', 'radius', 'depth', 'part'].every(key => value[key] === undefined || finiteNumber(value[key]));
export const nativeMarks = (value: unknown): value is SurfaceMark[] => nativeArray(value, nativeMark);
export const nativeDents = (value: unknown): value is PlateDent[] => nativeArray(value, (entry): entry is PlateDent => nativeRecord(entry) &&
  finiteNumber(entry.u) && finiteNumber(entry.v) && finiteNumber(entry.depth) && finiteNumber(entry.radius));
export const nativePerforations = (value: unknown): value is PlatePerforation[] => nativeArray(value, (entry): entry is PlatePerforation =>
  nativeRecord(entry) && finiteNumber(entry.u) && finiteNumber(entry.radius));
export const nativeBarrelMarks = (value: unknown): value is BarrelMark[] => nativeArray(value, (entry): entry is BarrelMark =>
  nativeRecord(entry) && nativePoint(entry) && finiteNumber(entry.radius));
export const nativeHoles = (value: unknown): value is MantletHole[] => nativeArray(value, (entry): entry is MantletHole =>
  nativeRecord(entry) && finiteNumber(entry.min) && finiteNumber(entry.max));
export const nativeCargo = (value: unknown): value is CargoLoad => nativeRecord(value) && Object.values(value).every(finiteNumber);
export const nativeScars = (value: unknown): value is Record<string, number> => nativeRecord(value) && Object.values(value).every(finiteNumber);
export const nativePolygons = (value: unknown): value is Point[][] => nativeArray(value, points);
export const nativeSuspension = (value: unknown): value is SuspensionState => nativeRecord(value) && finiteNumber(value.travel) &&
  ['displacement', 'tilt', 'compression'].every(key => value[key] === undefined || finiteNumber(value[key])) &&
  (value.enabled === undefined || nativeBoolean(value.enabled));
export const nativeContact = (value: unknown): value is GroundContact | null => value === null || nativeRecord(value) && nativePoint(value) &&
  ['nx', 'ny', 'tx', 'ty', 'contacts', 'minX', 'maxX'].every(key => finiteNumber(value[key])) && nativeScars(value.materials);

export interface NativeActorRecord extends Record<string, unknown> { id: string }
// A cold record tells where a piece is; a live frame tells it in its block of numbers (RustGame.numbers).
export interface NativeModuleRecord extends Record<string, unknown> { owner: number }
export interface NativePlateRecord { owner: number; pose?: Pose; damage: Record<string, unknown> | null }
export interface NativeParts { actors: NativeActorRecord[]; modules: NativeModuleRecord[]; plates: NativePlateRecord[]; tows?: SceneTow[] }
const actorRecord = (value: unknown): value is NativeActorRecord => nativeRecord(value) && nativeString(value.id);
const moduleRecord = (value: unknown): value is NativeModuleRecord => nativeRecord(value) && finiteNumber(value.owner) && (value.x === undefined || nativePose(value));
const plateRecord = (value: unknown): value is NativePlateRecord => nativeRecord(value) && finiteNumber(value.owner) && (value.pose === undefined || nativePose(value.pose)) &&
  (value.damage === null || nativeRecord(value.damage));
const tow = (value: unknown): value is SceneTow => nativeRecord(value) && nativeString(value.actorId) && nativeString(value.targetId) &&
  nativeString(value.partAId) && nativeString(value.partBId) && nativePoint(value.localA) && nativePoint(value.localB) &&
  nativePoint(value.anchorA) && nativePoint(value.anchorB) && finiteNumber(value.length) &&
  ['tension', 'limit'].every(key => value[key] === undefined || finiteNumber(value[key])) && (value.sling === undefined || nativeBoolean(value.sling)) &&
  (value.bridle === undefined || value.bridle === null || Array.isArray(value.bridle) && value.bridle.length === 2 && nativePoint(value.bridle[0]) && nativePoint(value.bridle[1]));
function parts(value: unknown): value is NativeParts {
  return nativeRecord(value) && nativeArray(value.actors, actorRecord) && nativeArray(value.modules, moduleRecord) && nativeArray(value.plates, plateRecord) &&
    (value.tows === undefined || nativeArray(value.tows, tow));
}
export function decodeNativeParts(value: unknown): NativeParts {
  if (!parts(value)) throw new TypeError('Invalid Native construction projection.');
  return value;
}
export interface NativeRay { owner: number; actor: number; kind: 'plate' | 'module'; point: Point; exitPoint: Point; normal: Point; enter: number; exit: number; depth: number }
const ray = (value: unknown): value is NativeRay => nativeRecord(value) && finiteNumber(value.owner) && finiteNumber(value.actor) &&
  (value.kind === 'plate' || value.kind === 'module') && nativePoint(value.point) && nativePoint(value.exitPoint) && nativePoint(value.normal) &&
  finiteNumber(value.enter) && finiteNumber(value.exit) && finiteNumber(value.depth);
export function decodeNativeRay(value: unknown): NativeRay | null {
  if (value !== null && !ray(value)) throw new TypeError('Invalid Native material ray.');
  return value;
}
export function decodeNativeRays(value: unknown): NativeRay[] {
  if (!nativeArray(value, ray)) throw new TypeError('Invalid Native material rays.');
  return value;
}
// Cold JSON preserves the caller's original keys. The host replaces these two
// collection encodings with named Sets before exposing full projectile records.
export type NativeProjectileRecord = Omit<SceneProjectile, 'emitterIds' | 'visited'> & { emitterIds?: unknown; visited?: unknown };
const projectile = (value: unknown): value is NativeProjectileRecord => nativeRecord(value) && nativePoint(value) && finiteNumber(value.vx) && finiteNumber(value.vy) &&
  ['age', 'radius', 'number', 'numericId', 'power', 'mass', 'caliberMm', 'life'].every(key => value[key] === undefined || finiteNumber(value[key])) &&
  (value.actor === undefined || nullableNumber(value.actor)) &&
  ['id', 'weapon', 'ammo', 'material'].every(key => value[key] === undefined || nativeString(value[key])) &&
  ['actorId', 'preset'].every(key => value[key] === undefined || nullableString(value[key])) &&
  ['poweredTrail', 'fragment', 'spall'].every(key => value[key] === undefined || nativeBoolean(value[key])) &&
  ['emitterOwners', 'visitedOwners'].every(key => value[key] === undefined || numbers(value[key])) &&
  (value.flight === undefined || nativeRecord(value.flight));
export function decodeNativeProjectiles(value: unknown): NativeProjectileRecord[] {
  if (!nativeArray(value, projectile)) throw new TypeError('Invalid Native projectile records.');
  return value;
}
export interface NativeClock { time: number; tick: number }
const clock = (value: unknown): value is NativeClock => nativeRecord(value) && finiteNumber(value.time) && finiteNumber(value.tick);
export function decodeNativeClock(value: unknown): NativeClock {
  if (!clock(value)) throw new TypeError('Invalid Native clock.');
  return value;
}
export interface NativeShotKind extends Omit<ShotKind, 'actorId'> { actor: number | null }
const shotKind = (value: unknown): value is NativeShotKind => nativeRecord(value) && nullableNumber(value.actor) && nativeString(value.weapon) &&
  nullableString(value.preset) && nativeString(value.ammo) && nativeBoolean(value.poweredTrail) && nullableString(value.name);
const stats = (value: unknown): value is SceneStats => nativeRecord(value) && ['shots', 'impacts', 'penetrations', 'ricochets', 'explosions'].every(key => finiteNumber(value[key])) &&
  ['spallBursts', 'secondaryShots', 'secondaryComponentHits'].every(key => value[key] === undefined || finiteNumber(value[key]));

const eventNumberFields = ['time', 'x', 'y', 'power', 'radius', 'strength', 'angle', 'caliberMm', 'nx', 'ny', 'vx', 'vy', 'count', 'enter',
  'remaining', 'mass', 'energy', 'speed', 'impulse', 'normalSpeed', 'energyDeposited', 'powerSpent', 'energyBudget', 'energySpent', 'powerBudget', 'endX', 'endY', 'n', 'spread', 'damage', 'closingSpeed', 'impactEnergy'] as const;
const eventOwnerFields = ['actor', 'owner', 'sourceOwner', 'otherOwner', 'shooterActor', 'targetActor', 'emitterOwner'] as const;
const eventStringFields = ['id', 'componentId', 'otherId', 'projectileId', 'material', 'surface', 'result', 'reason', 'contactPair', 'otherMaterial'] as const;
const eventActorFields = ['actorId', 'shooterActorId', 'targetActorId', 'emitterId'] as const;
const eventBooleanFields = ['friendly', 'primaryContact', 'fragment', 'spall', 'internal', 'penetrated', 'spared', 'ground', 'terminal', 'shaped', 'exterior', 'instantaneous'] as const;
const eventPoint = (value: unknown): value is EventPoint => nativeRecord(value) && nativePoint(value) && finiteNumber(value.time) &&
  (value.vx === undefined || finiteNumber(value.vx)) && (value.vy === undefined || finiteNumber(value.vy));
const budgets = (value: unknown): value is Record<string, { energy: number; power: number }> => nativeRecord(value) && Object.values(value).every(entry => nativeRecord(entry) && finiteNumber(entry.energy) && finiteNumber(entry.power));
const positionedTypes = ['muzzle', 'impact', 'blocked', 'primary-contact', 'penetration', 'ricochet', 'spall', 'module', 'ground', 'secondary-impact', 'secondary-ray',
  'explosion', 'burn', 'destroyed', 'debris', 'weapon-blocked', 'weapon-empty'] as const;
export function isSceneEventBase(value: unknown): value is SceneEventBase {
  if (!nativeRecord(value) || !nativeString(value.type) ||
    !eventNumberFields.every(key => value[key] === undefined || finiteNumber(value[key])) ||
    !eventOwnerFields.every(key => value[key] === undefined || nullableNumber(value[key])) ||
    !eventStringFields.every(key => value[key] === undefined || nativeString(value[key])) ||
    !eventActorFields.every(key => value[key] === undefined || nullableString(value[key])) ||
    !eventBooleanFields.every(key => value[key] === undefined || nativeBoolean(value[key])) ||
    !(value.kind === undefined || moduleKind(value.kind)) || !(value.ammo === undefined || ammo(value.ammo)) ||
    !(value.weapon === undefined || nullableString(value.weapon)) || !(value.poweredTrail === undefined || value.poweredTrail === null || nativeBoolean(value.poweredTrail)) ||
    !(value.preset === undefined || nullableString(value.preset)) || !(value.source === undefined || nullableString(value.source) || finiteNumber(value.source)) ||
    !(value.detonation === undefined || value.detonation === 'airburst' || value.detonation === 'impact') ||
    !(value.points === undefined || nativeArray(value.points, eventPoint)) || !(value.spallTransfer === undefined || budgets(value.spallTransfer))) return false;
  return true;
}
function sceneEvent(value: unknown): value is SceneEvent {
  if (!isSceneEventBase(value)) return false;
  if (value.type === 'flight') return nativeString(value.id) && finiteNumber(value.n) && finiteNumber(value.radius) && nativeBoolean(value.terminal) && finiteNumber(value.time) && nativeArray(value.points, eventPoint);
  if (value.type === 'tow-release') return nativeString(value.actorId) && nativeString(value.otherId) && nativeString(value.reason) && finiteNumber(value.time);
  if (!positionedTypes.some(type => type === value.type) || !nativePoint(value) || value.weapon === null || value.poweredTrail === null) return false;
  switch (value.type) {
    case 'muzzle': return finiteNumber(value.angle) && finiteNumber(value.power);
    case 'impact': case 'blocked': case 'penetration': case 'ricochet': case 'module': case 'secondary-impact': case 'explosion': return finiteNumber(value.power);
    case 'primary-contact': return finiteNumber(value.nx) && finiteNumber(value.ny);
    case 'spall': return finiteNumber(value.nx) && finiteNumber(value.ny) && finiteNumber(value.power);
    case 'secondary-ray': return finiteNumber(value.endX) && finiteNumber(value.endY);
    case 'debris': return finiteNumber(value.count);
    case 'weapon-blocked': case 'weapon-empty': return finiteNumber(value.angle);
    case 'burn': return finiteNumber(value.radius) && finiteNumber(value.strength) && finiteNumber(value.spread) && nativeBoolean(value.exterior);
    default: return true;
  }
}
export interface NativeFrame extends NativeParts, NativeClock {
  nextId: number; randomState: number; recoveries: number; shots: number;
  stats: SceneStats; events: SceneEvent[]; shotKinds: { from: number; list: NativeShotKind[] }; projectiles?: NativeProjectileRecord[];
  // Whether the core holds numbers for this frame, to be taken once (`frame_block`), and those numbers once taken.
  block?: boolean; numbers?: Float64Array;
}
function frame(value: unknown): value is NativeFrame {
  return nativeRecord(value) && parts(value) && clock(value) && ['nextId', 'randomState', 'recoveries', 'shots'].every(key => finiteNumber(value[key])) &&
    stats(value.stats) && nativeArray(value.events, sceneEvent) && nativeRecord(value.shotKinds) && finiteNumber(value.shotKinds.from) &&
    nativeArray(value.shotKinds.list, shotKind) && (value.projectiles === undefined || nativeArray(value.projectiles, projectile)) &&
    (value.block === undefined || nativeBoolean(value.block));
}
export function decodeNativeFrame(value: unknown): NativeFrame {
  if (!frame(value)) {
    let detail = 'envelope';
    if (nativeRecord(value)) {
      if (!parts(value)) detail = 'piece routing';
      else if (!clock(value)) detail = 'clock';
      else if (!stats(value.stats)) detail = 'counters';
      else if (Array.isArray(value.events)) {
        const bad = value.events.findIndex(event => !sceneEvent(event));
        if (bad >= 0) {
          const event: unknown = value.events[bad];
          detail = `event ${bad} (${nativeRecord(event) ? String(event.type) : typeof event})`;
        }
      }
      if (detail === 'envelope' && nativeRecord(value.shotKinds) && Array.isArray(value.shotKinds.list)) {
        const bad = value.shotKinds.list.findIndex(kind => !shotKind(kind));
        if (bad >= 0) detail = `shot kind ${bad}`;
      }
      if (detail === 'envelope' && Array.isArray(value.projectiles)) {
        const bad = value.projectiles.findIndex(round => !projectile(round));
        if (bad >= 0) detail = `projectile ${bad}`;
      }
    }
    throw new TypeError(`Invalid Native frame: ${detail}.`);
  }
  return value;
}
export function decodeNativeEnvelope(value: unknown): { frame: NativeFrame | null; result: unknown } {
  if (!nativeRecord(value) || !Object.hasOwn(value, 'result')) throw new TypeError('Invalid Native command reply.');
  return { result: value.result, frame: value.frame === null ? null : decodeNativeFrame(value.frame) };
}
export function parseNativeJSON(text: string): unknown { const value: unknown = JSON.parse(text); return value; }

export interface KeptActor extends ActorOptions, Record<string, unknown> { construction: unknown; vehicle: Record<string, unknown> | null }
export interface KeptPlate extends Record<string, unknown> {
  id: string; pose: Pose; ballisticGrid: MaterialGrid; marks: SurfaceMark[]; dents: PlateDent[]; perforations: PlatePerforation[];
}
export interface KeptModule extends Record<string, unknown> { id: string }
export interface KeptTow { actorId: string; targetId: string; partAId: string; partBId: string; localA: Point; localB: Point; length: number }
export interface KeptWorld extends NativeClock {
  nextId: number; randomState: number; recoveries: number; stats: SceneStats; roads: unknown;
  actors: KeptActor[]; plates: KeptPlate[]; modules: KeptModule[]; tows?: KeptTow[];
}
const keptActor = (value: unknown): value is KeptActor => nativeRecord(value) && nativeString(value.id) && Object.hasOwn(value, 'construction') &&
  (value.vehicle === null || nativeRecord(value.vehicle)) &&
  ['ownerId', 'team'].every(key => value[key] === undefined || nullableString(value[key])) &&
  ['x', 'facing', 'revision'].every(key => value[key] === undefined || finiteNumber(value[key])) &&
  ['color', 'playerName'].every(key => value[key] === undefined || nativeString(value[key])) &&
  (value.rest === undefined || nativeBoolean(value.rest)) && (value.aloft === undefined || value.aloft === null ||
    nativeRecord(value.aloft) && finiteNumber(value.aloft.y) && finiteNumber(value.aloft.angle));
const keptPlate = (value: unknown): value is KeptPlate => nativeRecord(value) && nativeString(value.id) && nativePose(value.pose) &&
  nativeGrid(value.ballisticGrid) && nativeMarks(value.marks) && nativeDents(value.dents) && nativePerforations(value.perforations);
const keptModule = (value: unknown): value is KeptModule => nativeRecord(value) && nativeString(value.id);
const keptTow = (value: unknown): value is KeptTow => nativeRecord(value) && nativeString(value.actorId) && nativeString(value.targetId) &&
  nativeString(value.partAId) && nativeString(value.partBId) && nativePoint(value.localA) && nativePoint(value.localB) && finiteNumber(value.length);
function keptWorld(value: unknown): value is KeptWorld {
  return nativeRecord(value) && clock(value) && ['nextId', 'randomState', 'recoveries'].every(key => finiteNumber(value[key])) &&
    stats(value.stats) && nativeArray(value.actors, keptActor) && nativeArray(value.plates, keptPlate) && nativeArray(value.modules, keptModule) &&
    (value.tows === undefined || nativeArray(value.tows, keptTow));
}
export function decodeKeptWorld(value: unknown): KeptWorld {
  if (!keptWorld(value)) throw new TypeError('Invalid saved physical scene.');
  return value;
}
