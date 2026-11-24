import type { AuthoredConstruction, CompiledConstruction, CompiledModule, ConstructionAppearance } from './construction-contract.ts';
import type { Point, Pose } from './math.ts';
import type { MaterialId, ModuleKind } from './materials.ts';
import type { MaterialGrid, GridBounds } from './armor-grid.ts';
import type { CargoLoad } from './economy-contract.ts';
import type { WeaponSettings, WeaponFamilyId, WeaponPresetId, AmmoId } from './weapons.ts';
import type { ActorService } from './construction-service.ts';
import type { FieldCargoWork } from './field-contract.ts';
import type { Vehicle, VehicleSnapshot } from './vehicle.ts';
import type { PlateMesh, PlateDefinition } from './mesh.ts';
import type { Road } from './roads.ts';
import type { TerrainSnapshot, TerrainId } from './terrain.ts';
import type { ShotBlock, ShotLegend } from './shots.ts';
export type { SceneFrame } from './scene-frame.ts';

export interface SurfaceMark { u: number; v: number; kind: string; strength: number; radiusU?: number; depth?: number; radius?: number; part?: number }
export interface PlateDent { u: number; v: number; depth: number; radius: number }
export interface PlatePerforation { u: number; radius: number }
export interface BarrelMark extends Point { radius: number }
export interface MantletHole { min: number; max: number }
export interface GroundContact extends Point {
  nx: number; ny: number; tx: number; ty: number; contacts: number;
  materials: Record<string, number>; minX: number; maxX: number;
}
export interface SuspensionState {
  enabled?: boolean; travel: number; displacement?: number; tilt?: number; compression?: number;
}
export interface ModuleState {
  actorId: string; burning: boolean; detonated: boolean; burnAge: number; fireAge: number;
  dryMass?: number; marks?: SurfaceMark[]; markRevision?: number; groundMarks?: number; groundDamage?: number;
  barrelDamage?: number; barrelDisabled?: boolean; barrelMarks?: BarrelMark[]; beltCut?: boolean;
  ballisticScars?: Record<string, number>; mantletHoles?: MantletHole[];
  elevationDamage?: number; elevationDisabled?: boolean;
  servoVelocity?: number; targetAimOffset?: number; servoMaxSpeed?: number; reload?: number;
  // How hot a gun's barrel is, °C (game_barrel.rs), and whether a pilot waits for it to cool.
  barrelTemperature?: number; barrelCooling?: boolean;
  // The rounds ready in a gun's belt or magazine, and the seconds until its crew has it loaded again (0 while it is not
  // being loaded): what its feed holds is the catalogue's (`weaponOf(preset).feed.rounds`).
  loaded?: number; feedReload?: number;
  groundContact?: GroundContact | null; wheelSpin?: number; wheelAngularSpeed?: number; suspension?: SuspensionState;
  cargo?: CargoLoad; thrust?: number; source?: string;
}
export type LiveModule = CompiledModule & ModuleState;
export type SceneModule = LiveModule;
export type LivePlate = PlateMesh;
export interface ScenePlate {
  id: string; actorId?: string | undefined; material: MaterialId; definition: PlateDefinition;
  ballisticGrid?: MaterialGrid | undefined; solidRegions: GridBounds[];
  integrity: number; revision: number; marks: SurfaceMark[]; markRevision: number;
  physicalMass?: number | undefined; physicalInertia?: number | undefined; physicalCenterLocal?: Point | undefined; attached?: boolean;
}
export type ScenePart = SceneModule | ScenePlate;
export interface SceneStats {
  shots: number; impacts: number; penetrations: number; ricochets: number; explosions: number;
  spallBursts?: number; secondaryShots?: number; secondaryComponentHits?: number;
  [metric: string]: unknown;
}
export interface SceneEye extends Point { left: number; right: number }
export interface SceneBodyPanel { id: string; actorId: string; localPolygon: Point[]; pose: Pose }
export interface SceneExtraction { partId: string; siteId: string }
export interface SceneField {
  wreck?: { until: number } | null; service?: ActorService | null;
  extraction?: SceneExtraction[] | null; building?: { at?: string; pace?: number } | null;
  cargoWork?: FieldCargoWork | null;
  road?: { tool: 'blade' | 'paver'; from: number; to: number; idle?: boolean; short?: boolean } | null;
}
export interface SceneTrigger { aim: Point; config: WeaponSettings }
export interface PendingShot { aim: Point; settings: WeaponSettings; expires: number }
export interface AdditionalTrigger extends SceneTrigger { held: boolean; expires: number | null }
export interface ActorStats { shots: number; [metric: string]: unknown }
export type SceneFacing = -1 | 1;
export interface SceneActorBase {
  id: string; ownerId: string | null | undefined; team?: string | null | undefined;
  name: string; blueprint: CompiledConstruction; construction: AuthoredConstruction;
  x: number; facing: SceneFacing; mirror: SceneFacing; revision: number;
  color?: string | undefined; playerName?: string | undefined;
  defeated?: boolean; field?: SceneField | null;
  cooldown: number; trigger: SceneTrigger | null; pendingShot?: PendingShot | null; also?: AdditionalTrigger[];
  lastWeapon: string | null; aim: Point; weapon: WeaponSettings | null; stats: ActorStats; eyes: SceneEye[];
  bodyPanels?: SceneBodyPanel[]; contactVolumes?: Point[][]; contactContours?: Point[][] | undefined;
}
export type SceneActor = SceneActorBase & ({ vehicle: Vehicle; y?: number } | { vehicle: null; y: number });
export type Actor = SceneActor;
export interface SceneActorView {
  id: string; ownerId?: string | null | undefined; team?: string | null | undefined;
  name?: string; playerName?: string | undefined; color?: string | undefined;
  preset?: CompiledConstruction['preset']; appearance?: ConstructionAppearance | null;
  x: number; facing?: SceneFacing; mirror?: SceneFacing; revision?: number;
  defeated?: boolean; burning?: boolean; ghost?: unknown;
  field?: SceneField | null; contactContours?: Point[][] | undefined;
  cooldown?: number; aim?: Point; weapon?: WeaponSettings | null; eyes?: SceneEye[];
}
export type SceneActorSnapshot = SceneActorView & (
  { vehicle: VehicleSnapshot; y?: number } | { vehicle?: null | undefined; y: number }
);
export interface SceneTow {
  actorId: string; targetId: string; partAId: string; partBId: string;
  localA: Point; localB: Point; anchorA: Point; anchorB: Point; length: number;
  tension?: number; limit?: number; sling?: boolean; bridle?: [Point, Point] | null;
}
export interface SceneSnapshot {
  time: number; tick?: number; name?: string; preset?: CompiledConstruction['preset']; terrain?: TerrainId;
  terrainSettings?: TerrainSnapshot | Pick<TerrainSnapshot, 'seed' | 'length' | 'center'>; roads?: readonly Road[]; weather?: string; appearance?: ConstructionAppearance | null;
  launcher?: Point; testDistance?: number; bodyPanels?: SceneBodyPanel[];
  actors: SceneActorSnapshot[]; plates: ScenePlate[]; modules: SceneModule[];
  shots?: ShotBlock<ShotLegend>; stats?: SceneStats; tows?: SceneTow[];
}
export type SceneState = SceneSnapshot;
// What a snapshot was read from (World.snapshot): the constructions and the plates in its order — its pieces are the
// scene's own —, and the frames the core told them by, with which of them changed each one and its vehicle
// (`RustGame.changedAfter`), for a reader that read the scene before to pass over what did not change since.
export interface SceneSources {
  changes: { readonly frames: number; readonly whole: number; changedAfter(object: object, frame: number): boolean };
  actors: readonly SceneActor[];
  plates: readonly object[];
}

export interface EventPoint extends Point { time: number; vx?: number; vy?: number }
export interface SceneEventBase {
  type: string; time?: number; x?: number; y?: number; actor?: number | null; owner?: number | null; sourceOwner?: number | null;
  actorId?: string | null | undefined; id?: string | undefined; componentId?: string | undefined;
  otherId?: string | undefined; source?: string | number | null | undefined; otherOwner?: number | null;
  shooterActor?: number | null; targetActor?: number | null; emitterOwner?: number | null;
  shooterActorId?: string | null; targetActorId?: string | null; emitterId?: string | null;
  friendly?: boolean; primaryContact?: boolean; fragment?: boolean; spall?: boolean; internal?: boolean;
  projectileId?: string; material?: string; surface?: string; kind?: ModuleKind;
  power?: number; radius?: number; strength?: number; angle?: number; caliberMm?: number; spread?: number;
  closingSpeed?: number; impactEnergy?: number; contactPair?: string; otherMaterial?: string;
  nx?: number; ny?: number; vx?: number; vy?: number; count?: number; enter?: number;
  weapon?: WeaponFamilyId | string | null; preset?: WeaponPresetId | string | null; ammo?: AmmoId; poweredTrail?: boolean | null;
  remaining?: number; mass?: number; energy?: number; speed?: number; impulse?: number; normalSpeed?: number;
  energyDeposited?: number; powerSpent?: number; energyBudget?: number; energySpent?: number; powerBudget?: number;
  result?: string; penetrated?: boolean; spared?: boolean; ground?: boolean; reason?: string; shaped?: boolean; exterior?: boolean; vented?: boolean;
  detonation?: 'airburst' | 'impact'; instantaneous?: boolean; damage?: number;
  endX?: number; endY?: number; n?: number; points?: EventPoint[]; terminal?: boolean;
  spallTransfer?: Record<string, { energy: number; power: number }>;
}
interface PositionedEvent extends SceneEventBase { x: number; y: number; weapon?: WeaponFamilyId | string; poweredTrail?: boolean }
export type PositionedSceneEvent =
  | PositionedEvent & { type: 'muzzle'; angle: number; power: number }
  | PositionedEvent & { type: 'impact' | 'blocked' | 'penetration' | 'ricochet' | 'module' | 'secondary-impact' | 'explosion'; power: number }
  | PositionedEvent & { type: 'ground' }
  | PositionedEvent & { type: 'primary-contact'; nx: number; ny: number }
  | PositionedEvent & { type: 'spall'; nx: number; ny: number; power: number }
  | PositionedEvent & { type: 'secondary-ray'; endX: number; endY: number }
  | PositionedEvent & { type: 'debris'; count: number }
  | PositionedEvent & { type: 'weapon-blocked' | 'weapon-empty'; angle: number }
  | PositionedEvent & { type: 'burn'; radius: number; strength: number; spread: number; exterior: boolean }
  | PositionedEvent & { type: 'destroyed' };
export interface FlightSceneEvent extends SceneEventBase {
  type: 'flight'; id: string; n: number; radius: number; terminal: boolean; time: number; points: EventPoint[];
}
export interface TowReleaseEvent extends SceneEventBase { type: 'tow-release'; actorId: string; otherId: string; reason: string; time: number }
export type SceneEvent = PositionedSceneEvent | FlightSceneEvent | TowReleaseEvent;

// A full projectile record is only requested for a rebuild or inspection. Drawing uses ShotBlock.
export interface SceneProjectile extends Point {
  id?: string; number?: number; numericId?: number; actorId?: string | null | undefined;
  vx: number; vy: number; age?: number; radius?: number; ammo?: string; weapon?: string; preset?: string | null;
  poweredTrail?: boolean; actor?: number | null; emitterOwners?: number[]; visitedOwners?: number[];
  emitterIds?: Iterable<string | number>; visited?: Iterable<string | number>;
  fragment?: boolean; spall?: boolean; material?: string;
  power?: number; mass?: number; caliberMm?: number; life?: number; flight?: object;
}
export type ProjectileInput = SceneProjectile;
