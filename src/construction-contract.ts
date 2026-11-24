import type { DESIGN_VERSION } from './design-contract.ts';
import type { MaterialId, MetalId, ModuleKind } from './materials.ts';
import type { AmmoId, WeaponId } from './weapons.ts';
import type { SensorMode } from './combat-sensors.ts';
import type { WeaponMountId } from './weapon-mounts.ts';
import type { NativePowertrain } from './native-contract.gen.ts';
import type { DetailKind } from './vehicle-details.ts';
import type { CHASSIS_MODELS, ChassisMetalId } from './chassis.ts';

export interface ConstructionPoint { x: number; y: number }
export interface ConstructionPose extends ConstructionPoint { angle: number }
export type MaterialPolygon = ConstructionPoint[];
export interface ConstructionBounds { minX: number; maxX: number; minY: number; maxY: number }
export type ChassisModelId = keyof typeof CHASSIS_MODELS;
export type RadarModel = 'legacy' | 'mobile';

export interface ConstructionNode extends ConstructionPoint { id: string }
export interface AuthoredPlate {
  id: string; a: string; b: string; material: MaterialId; thicknessMm: number;
  ends?: { start: number; end: number };
}
export interface AuthoredComponentPose extends ConstructionPose { mirrored?: boolean }
export interface AuthoredWeaponMount { preset?: WeaponMountId; sector?: { min: number; max: number }; radiusM?: number }
interface AuthoredComponentBase { id: string; pose: AuthoredComponentPose }
interface SizedAuthoring { sizeScale?: number; metal?: MetalId }
type AuthoredVariants =
  | AuthoredComponentBase & { kind: 'weapon'; weaponPreset?: WeaponId; weaponAmmo?: AmmoId; mount?: AuthoredWeaponMount }
  | AuthoredComponentBase & SizedAuthoring & { kind: 'sensor'; sensorMode?: SensorMode; radarModel?: RadarModel }
  | AuthoredComponentBase & SizedAuthoring & { kind: 'ammo'; ammoPreset?: WeaponId }
  | AuthoredComponentBase & SizedAuthoring & { kind: Exclude<ModuleKind, 'weapon' | 'sensor' | 'ammo' | 'wheel' | 'track'> };
// Absent slots remain readable as undefined while each variant rejects foreign fields.
type VariantKeys<Value> = Value extends unknown ? keyof Value : never;
export type WithAbsentSlots<Value, Keys extends PropertyKey = VariantKeys<Value>> = Value extends unknown
  ? Value & Partial<Record<Exclude<Keys, keyof Value>, never>> : never;
export type AuthoredComponent = WithAbsentSlots<AuthoredVariants>;

export interface ChassisPoint extends ConstructionPoint { gap?: boolean }
export interface ChassisTrackAuthoring { front: number; rear: number; y: number }
export interface ChassisSkidsAuthoring { front: number; rear: number; legs: [number, number] }
export interface AuthoredChassis {
  model: ChassisModelId; points: [ChassisPoint, ChassisPoint, ...ChassisPoint[]];
  metal?: ChassisMetalId; thicknessMm?: number; gearScale?: number; armorMm?: number;
  axles?: number[]; track?: ChassisTrackAuthoring; skids?: ChassisSkidsAuthoring;
  topPlate?: { material: MaterialId; thicknessMm: number };
}
export interface AuthoredDetail extends ConstructionPose {
  id: string; kind: DetailKind; surface: 'body' | 'chassis' | 'part'; host: string;
  width: number; height: number; space?: 'project'; mirrored?: boolean; automatic?: boolean; text?: string;
}
export interface ConstructionAppearance { paint: string; automaticDetails?: boolean; details?: AuthoredDetail[] }
interface ConstructionAuthoring {
  version: typeof DESIGN_VERSION; name?: string; seed?: number; launcher?: ConstructionPoint;
  appearance?: ConstructionAppearance; terrain?: string; nodes: ConstructionNode[];
  plates: AuthoredPlate[]; components: AuthoredComponent[];
}
export type AuthoredConstruction = ConstructionAuthoring &
  ({ preset: 'vehicle'; chassis: AuthoredChassis } | { preset: 'bunker'; chassis?: never });
// Native supplies omitted angles when it canonicalizes a source. Editor documents
// and compiler replies use the explicit poses above; imports may omit those defaults.
export type SourceComponentPose = Omit<AuthoredComponentPose, 'angle'> & { angle?: number };
type SourceVariant<Component> = Component extends AuthoredComponent ? Omit<Component, 'pose'> & { pose: SourceComponentPose } : never;
export type SourceComponent = SourceVariant<AuthoredComponent>;
export type SourceDetail = Omit<AuthoredDetail, 'angle'> & { angle?: number };
export type SourceAppearance = Omit<ConstructionAppearance, 'details'> & { details?: SourceDetail[] };
export type ConstructionSource = Omit<ConstructionAuthoring, 'components' | 'appearance'> & {
  components: SourceComponent[]; appearance?: SourceAppearance;
} & ({ preset: 'vehicle'; chassis: AuthoredChassis } | { preset: 'bunker'; chassis?: never });
export type CanonicalConstruction = AuthoredConstruction & {
  name: string; seed: number; launcher: ConstructionPoint; appearance: ConstructionAppearance;
};

export interface BallisticMaterialGrid {
  version: 1; nx: number; ny: number; bounds: ConstructionBounds; bits: string;
}
export interface ChassisPartMetadata {
  model: ChassisModelId; kind: ChassisModelId; part: string; segment: number; depth: number; material: MetalId; thicknessMm: number;
  credits?: number; limitKg?: number; frameKg?: number; frameLimitKg?: number; gearLimitKg?: number;
  deck?: number; length?: number; suspension?: number; profile?: ChassisPoint[]; outlines?: MaterialPolygon[];
  axles?: number[]; wheelDiameter?: number; track?: { front: number; rear: number; y: number; height: number };
  skids?: { front: number; rear: number; y: number; tube: number; legs: { x: number; top: number; foot: number }[] };
}
export interface CompiledPlate extends ConstructionPose {
  kind?: never;
  id: string; owner: number; length: number; material: MaterialId; thicknessMm: number; widthM: number;
  anchors: { u: number; v: number }[]; mountId: string | null; ballisticGrid: BallisticMaterialGrid;
  originalArea: number; physicalMass: number; physicalInertia: number; physicalCenterLocal: ConstructionPoint;
  chassis?: ChassisPartMetadata; dragWidthM?: number;
}
export interface WeaponMountWall {
  owner: number; wallId: string; thicknessMm: number; a: ConstructionPoint; b: ConstructionPoint;
  port?: { lo: number; hi: number; centerU: number; min: number; max: number };
}
export interface WeaponMountShield { radius: number; thickness: number; halfAngle: number; opening: number }
export interface WeaponMountProjection {
  version: 3; preset: WeaponMountId; min: number; max: number; maxSpeed: number; exposed: boolean;
  fireTolerance: number; mirrored: boolean; hostOwner: number; hostId: string | null;
  hullAxis: number; recoil: number; bodyWidth: number; walls: WeaponMountWall[];
  materialDepth: number; materialDensity: number; material: MaterialId; shield: WeaponMountShield | null;
}
export interface ModuleSupport { host: string; foot: ConstructionPoint[]; normal: ConstructionPoint; reach?: number; polygon?: MaterialPolygon; mass?: number }
export interface CompiledModuleBase extends ConstructionPose {
  id: string; owner: number; width: number; height: number; mountId: string | null; attached: boolean;
  health: number; maxHealth: number; physicalMass: number; mechanicalDepth: number;
  physicalCenterLocal: ConstructionPoint; physicalInertia: number; mirrored?: boolean; exposed?: boolean; metal?: MetalId;
}
type CompiledVariants =
  | CompiledModuleBase & { kind: 'weapon'; weaponPreset: WeaponId; weaponAmmo: AmmoId; weaponMount: WeaponMountProjection;
      aimOffset: number; barrelAngle: number; targetBarrelAngle: number; barrelProfile: { start: number; end: number; radius: number };
      receiverMm: number; barrelMm: number; materialPolygons: MaterialPolygon[] }
  | CompiledModuleBase & { kind: 'sensor'; sensorMode: SensorMode; radarModel?: RadarModel; support?: ModuleSupport }
  | CompiledModuleBase & { kind: 'ammo'; ammoPreset: WeaponId; ammoType: AmmoId; capacityRounds: number; rounds: number; roundMass: number }
  | CompiledModuleBase & { kind: 'fuel'; capacityLitres: number; fuelLitres: number }
  | CompiledModuleBase & { kind: 'engine'; powerKw: number }
  | CompiledModuleBase & { kind: 'thruster'; thrustN: number }
  | CompiledModuleBase & { kind: 'command' }
  | CompiledModuleBase & { kind: 'wheel' | 'track'; suspension: { enabled: boolean; travel: number }; armorMm?: number }
  | CompiledModuleBase & { kind: 'hopper' | 'cistern' | 'supply'; capacityM3: number }
  | CompiledModuleBase & { kind: 'excavator' | 'drill' | 'builder'; workKw: number }
  | CompiledModuleBase & { kind: 'blade'; workKw: number; toolReach?: number; support?: ModuleSupport }
  | CompiledModuleBase & { kind: 'paver'; workKw: number; capacityM3: number; toolReach?: number };
export type CompiledModule = WithAbsentSlots<CompiledVariants>;
export type CompiledWeapon = Extract<CompiledModule, { kind: 'weapon' }>;
export type CompiledPiece = WithAbsentSlots<CompiledPlate | CompiledModule>;

export interface CompiledWall {
  id: string; owner: number; a: ConstructionPoint; b: ConstructionPoint; normal: ConstructionPoint;
  length: number; material: MaterialId; thicknessMm: number; exterior?: boolean;
}
export interface CompiledRoom { id: string; polygon: MaterialPolygon; walls: CompiledWall[] }
export interface CompiledFrame {
  origin: ConstructionPoint; widthM: number; nodes: ConstructionNode[];
  plates: { id: string; owner: number; a: string; b: string }[];
}
export interface BodyPanel { id: string; roomId: string; poly: MaterialPolygon }
export interface FixedAssembly { origin: ConstructionPoint; mass: number; centerLocal: ConstructionPoint; inertia: number }
export interface ChassisProjection {
  model: ChassisModelId; kind: ChassisModelId; front: number; rear: number; length: number; deck: number;
  suspension: number; depth: number; armorMm: number; metal: MetalId; thicknessMm: number; points: ChassisPoint[];
  segments: { index: number; gap: boolean; a: ConstructionPoint; b: ConstructionPoint; plates: string[]; low: boolean }[];
  outlines: MaterialPolygon[]; beds: CompiledWall[]; plates: string[]; gear: string[]; emptyKg: number; loadedKg: number;
  frameKg: number; sectionAreaM2: number; secondMomentM4: number; frameLimitKg: number; gearLimitKg: number; limitKg: number;
  balance: [number, number]; axles?: number[]; axleKg?: number; wheelDiameter?: number;
  track?: { front: number; rear: number; y: number; wheels: number; height: number }; roadWheelKg?: number; noseMm?: number;
  skids?: { front: number; rear: number; y: number; tube: number; struts: number[] };
}
export interface NativeAdmissionIssue {
  code: string; ids?: string[]; nodeIds?: string[]; field?: string; within?: string; index?: number; model?: string;
  value?: unknown; expected?: unknown; range?: number[]; accepted?: string[]; reason?: string;
  loadedKg?: number; limitKg?: number; gap?: number; count?: number; limit?: number; gun?: boolean;
  side?: string; tool?: string; direction?: string; angleDegrees?: number; surface?: string; least?: number; ready?: boolean;
  from?: number; to?: number; keys?: string[]; max?: number; placement?: unknown;
}
export interface ConstructionError extends Error, NativeAdmissionIssue {}
export interface NativeCompiledConstruction {
  version: 1; canonicalVersion: typeof DESIGN_VERSION; derived: true; mechanicalAdmission: boolean; admissionIssues: NativeAdmissionIssue[];
  preset: 'vehicle' | 'bunker'; name: string; seed: number; launcher: ConstructionPoint;
  appearance: ConstructionAppearance; terrain: string | null; vehicle: { enabled: boolean; chassisId: string | null };
  plates: CompiledPlate[]; modules: CompiledModule[]; frame: CompiledFrame; rooms: CompiledRoom[]; beds: CompiledWall[];
  fixedAssembly: FixedAssembly; eyes: (ConstructionPoint & { left: number; right: number })[];
  sights: (ConstructionPoint & { id: string; mode: SensorMode; range: number; left: number; right: number; hidden: [number, number][] })[];
  manufacturing: { emptyKg: number; envelope: { lengthM: number; heightM: number } }; powertrain: NativePowertrain;
  chassis?: ChassisProjection;
  flight?: { lifts: boolean; balanced: boolean; hoverLitres: number; hoverLean: number; liftN: number; idleLitres: number };
}
export interface CompiledConstruction extends NativeCompiledConstruction { bodyPanels: BodyPanel[] }
export interface NativeCompilerContract {
  compilerVersion: typeof DESIGN_VERSION; constructionVersion: typeof DESIGN_VERSION; drafts: true;
  mechanicalAdmission: true; physicalSupport: true;
}
export interface NativeCompilerResponse {
  contract: NativeCompilerContract; construction: CanonicalConstruction; compiled: NativeCompiledConstruction;
}
export interface CompilerResponse extends NativeCompilerResponse { compiled: CompiledConstruction }
