import { DESIGN_VERSION } from './design-contract.ts';
import { MATERIALS, METALS, MODULES } from './materials.ts';
import { AMMO, isWeaponId, isCartridgeId } from './weapons.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { WEAPON_MOUNTS } from './weapon-mounts.ts';
import { CHASSIS_MODELS, isChassisMetalId } from './chassis.ts';
import { VEHICLE_DETAILS } from './vehicle-details.ts';
import type { ModuleKind } from './materials.ts';
import type { AuthoredChassis, AuthoredComponent, AuthoredComponentPose, AuthoredConstruction, AuthoredDetail,
  AuthoredPlate, AuthoredWeaponMount, BallisticMaterialGrid, CanonicalConstruction, ChassisPartMetadata, ChassisPoint,
  ChassisProjection, CompiledFrame, CompiledModule, CompiledModuleBase, CompiledPlate, CompiledRoom, CompiledWall,
  ConstructionAppearance, ConstructionBounds, ConstructionError, ConstructionNode, ConstructionPoint,
  FixedAssembly, ModuleSupport, NativeAdmissionIssue, NativeCompiledConstruction, NativeCompilerContract,
  NativeCompilerResponse, WeaponMountProjection, WeaponMountShield, WeaponMountWall, ConstructionSource, SourceComponent, SourceComponentPose,
  SourceDetail, SourceAppearance } from './construction-contract.ts';
import type { NativePowertrain } from './native-contract.gen.ts';

import { record, numeric as number, textual as string, logical as boolean, unknownValue as unknown,
  absent, optional, literal, array } from './wire-shape.ts';
import type { Guard, Optional as OptionalCheck } from './wire-shape.ts';

type ObjectSchema<Value> = { [Key in keyof Value]-?: {} extends Pick<Value, Key>
  ? OptionalCheck<Exclude<Value[Key], undefined>> : Guard<Value[Key]> };
const either = <Value>(...checks: Guard<Value>[]): Guard<Value> => (value): value is Value => checks.some(check => check(value));
const nullable = <Value>(check: Guard<Value>): Guard<Value | null> => (value): value is Value | null => value === null || check(value);
const pair = <Value>(check: Guard<Value>): Guard<[Value, Value]> => (value): value is [Value, Value] =>
  Array.isArray(value) && value.length === 2 && check(value[0]) && check(value[1]);
const keyOf = <Catalogue extends object>(catalogue: () => Catalogue): Guard<Extract<keyof Catalogue, string>> =>
  (value): value is Extract<keyof Catalogue, string> => typeof value === 'string' && Object.hasOwn(catalogue(), value);
// This decoder checks the structure used by the host only, on cold compiler replies.
// Ranges, support, overlap, mass and all other physical decisions remain Native's.
function shape<Value extends object>(schema: ObjectSchema<Value>): Guard<Value> {
  return (value): value is Value => {
    if (!record(value)) return false;
    for (const key in schema) {
      const check = schema[key];
      if (typeof check === 'function') { if (!check(value[key])) return false; }
      else if (Object.hasOwn(value, key) && !check.test(value[key])) return false;
    }
    return true;
  };
}
const material = keyOf(() => MATERIALS), metal = keyOf(() => METALS), moduleKind = keyOf(() => MODULES),
  ammo = keyOf(() => AMMO), sensor = keyOf(() => SENSOR_MODES),
  mount = keyOf(() => WEAPON_MOUNTS), chassisModel = keyOf(() => CHASSIS_MODELS), detailKind = keyOf(() => VEHICLE_DETAILS);
// A gun of the catalogue or one made over in the workshop; the rounds a box holds, of a gun's cartridge.
const weapon = (value: unknown) => isWeaponId(value), cartridge = (value: unknown) => isCartridgeId(value);
const radarModel = either(literal('legacy'), literal('mobile'));
const point = shape<ConstructionPoint>({ x: number, y: number });
const node = shape<ConstructionNode>({ id: string, x: number, y: number });
const polygon = array(point), polygons = array(polygon);
const bounds = shape<ConstructionBounds>({ minX: number, maxX: number, minY: number, maxY: number });
const pose = shape<AuthoredComponentPose>({ x: number, y: number, angle: number, mirrored: optional(boolean) });
const authoredMount = shape<AuthoredWeaponMount>({ preset: optional(mount),
  sector: optional(shape({ min: number, max: number })), radiusM: optional(number) });
const authorSlots = {
  weaponPreset: optional(absent), weaponAmmo: optional(absent), mount: optional(absent), sensorMode: optional(absent),
  radarModel: optional(absent), ammoPreset: optional(absent), sizeScale: optional(absent), metal: optional(absent),
};
const authorBase = { id: string, pose };
const authoredWeapon = shape<Extract<AuthoredComponent, { kind: 'weapon' }>>({ ...authorBase, ...authorSlots,
  kind: literal('weapon'), weaponPreset: optional(weapon), weaponAmmo: optional(ammo), mount: optional(authoredMount) });
const authoredSensor = shape<Extract<AuthoredComponent, { kind: 'sensor' }>>({ ...authorBase, ...authorSlots,
  kind: literal('sensor'), sizeScale: optional(number), metal: optional(metal), sensorMode: optional(sensor), radarModel: optional(radarModel) });
const authoredAmmo = shape<Extract<AuthoredComponent, { kind: 'ammo' }>>({ ...authorBase, ...authorSlots,
  kind: literal('ammo'), sizeScale: optional(number), metal: optional(metal), ammoPreset: optional(cartridge) });
type SimpleKind = Exclude<ModuleKind, 'weapon' | 'sensor' | 'ammo' | 'wheel' | 'track'>;
const simpleKind: Guard<SimpleKind> = (value): value is SimpleKind => moduleKind(value) &&
  value !== 'weapon' && value !== 'sensor' && value !== 'ammo' && value !== 'wheel' && value !== 'track';
const authoredSimple = shape<Extract<AuthoredComponent, { kind: SimpleKind }>>({ ...authorBase, ...authorSlots,
  kind: simpleKind, sizeScale: optional(number), metal: optional(metal) });
export const isAuthoredComponent: Guard<AuthoredComponent> = either<AuthoredComponent>(authoredWeapon, authoredSensor, authoredAmmo, authoredSimple);
const sourcePose = shape<SourceComponentPose>({ x: number, y: number, angle: optional(number), mirrored: optional(boolean) });
const sourceBase = { id: string, pose: sourcePose };
const sourceWeapon = shape<Extract<SourceComponent, { kind: 'weapon' }>>({ ...sourceBase, ...authorSlots,
  kind: literal('weapon'), weaponPreset: optional(weapon), weaponAmmo: optional(ammo), mount: optional(authoredMount) });
const sourceSensor = shape<Extract<SourceComponent, { kind: 'sensor' }>>({ ...sourceBase, ...authorSlots,
  kind: literal('sensor'), sizeScale: optional(number), metal: optional(metal), sensorMode: optional(sensor), radarModel: optional(radarModel) });
const sourceAmmo = shape<Extract<SourceComponent, { kind: 'ammo' }>>({ ...sourceBase, ...authorSlots,
  kind: literal('ammo'), sizeScale: optional(number), metal: optional(metal), ammoPreset: optional(cartridge) });
const sourceSimple = shape<Extract<SourceComponent, { kind: SimpleKind }>>({ ...sourceBase, ...authorSlots,
  kind: simpleKind, sizeScale: optional(number), metal: optional(metal) });
const sourceComponent = either<SourceComponent>(sourceWeapon, sourceSensor, sourceAmmo, sourceSimple);
const authoredPlate = shape<AuthoredPlate>({ id: string, a: string, b: string, material, thicknessMm: number,
  ends: optional(shape({ start: number, end: number })) });
const chassisPoint = shape<ChassisPoint>({ x: number, y: number, gap: optional(boolean) });
const chassisPoints: Guard<AuthoredChassis['points']> = (value): value is AuthoredChassis['points'] =>
  Array.isArray(value) && value.length >= 2 && array(chassisPoint)(value);
const authoredChassis = shape<AuthoredChassis>({ model: chassisModel, points: chassisPoints, metal: optional(isChassisMetalId),
  thicknessMm: optional(number), gearScale: optional(number), armorMm: optional(number), axles: optional(array(number)),
  track: optional(shape({ front: number, rear: number, y: number })),
  skids: optional(shape({ front: number, rear: number, legs: pair(number) })),
  topPlate: optional(shape({ material, thicknessMm: number })) });
const authoredDetail = shape<AuthoredDetail>({ id: string, kind: detailKind, surface: either(literal('body'), literal('chassis'), literal('part')),
  host: string, x: number, y: number, angle: number, width: number, height: number, space: optional(literal('project')),
  mirrored: optional(boolean), automatic: optional(boolean), text: optional(string) });
const sourceDetail = shape<SourceDetail>({ id: string, kind: detailKind, surface: either(literal('body'), literal('chassis'), literal('part')),
  host: string, x: number, y: number, angle: optional(number), width: number, height: number, space: optional(literal('project')),
  mirrored: optional(boolean), automatic: optional(boolean), text: optional(string) });
const appearance = shape<ConstructionAppearance>({ paint: string, automaticDetails: optional(boolean), details: optional(array(authoredDetail)) });
const sourceAppearance = shape<SourceAppearance>({ paint: string, automaticDetails: optional(boolean), details: optional(array(sourceDetail)) });
const authoring = { version: literal(DESIGN_VERSION), name: optional(string), seed: optional(number), launcher: optional(point),
  appearance: optional(appearance), terrain: optional(string), nodes: array(node), plates: array(authoredPlate), components: array(isAuthoredComponent) };
const vehicle = shape<Extract<AuthoredConstruction, { preset: 'vehicle' }>>({ ...authoring, preset: literal('vehicle'), chassis: authoredChassis });
const bunker = shape<Extract<AuthoredConstruction, { preset: 'bunker' }>>({ ...authoring, preset: literal('bunker'), chassis: optional(absent) });
export const isAuthoredConstruction: Guard<AuthoredConstruction> = either<AuthoredConstruction>(vehicle, bunker);
const sourceAuthoring = { ...authoring, appearance: optional(sourceAppearance), components: array(sourceComponent) };
const sourceVehicle = shape<Extract<ConstructionSource, { preset: 'vehicle' }>>({ ...sourceAuthoring, preset: literal('vehicle'), chassis: authoredChassis });
const sourceBunker = shape<Extract<ConstructionSource, { preset: 'bunker' }>>({ ...sourceAuthoring, preset: literal('bunker'), chassis: optional(absent) });
export const isConstructionSource = either<ConstructionSource>(sourceVehicle, sourceBunker);
const canonicalDefaults = shape<{ name: string; seed: number; launcher: ConstructionPoint; appearance: ConstructionAppearance }>({ name: string, seed: number, launcher: point, appearance });
export const isCanonicalConstruction: Guard<CanonicalConstruction> = (value): value is CanonicalConstruction =>
  isAuthoredConstruction(value) && canonicalDefaults(value);
const admissionFields = { ids: optional(array(string)), nodeIds: optional(array(string)),
  field: optional(string), within: optional(string), index: optional(number), model: optional(string), value: optional(unknown),
  expected: optional(unknown), range: optional(array(number)), accepted: optional(array(string)), reason: optional(string),
  loadedKg: optional(number), limitKg: optional(number), gap: optional(number), count: optional(number), limit: optional(number), gun: optional(boolean),
  side: optional(string), tool: optional(string), direction: optional(string), angleDegrees: optional(number), surface: optional(string), least: optional(number), ready: optional(boolean),
  from: optional(number), to: optional(number), keys: optional(array(string)), max: optional(number), placement: optional(unknown) };
export const isNativeAdmissionIssue = shape<NativeAdmissionIssue>({ code: string, ...admissionFields });
export const isNativeAdmissionContext = shape<Partial<NativeAdmissionIssue>>({ code: optional(string), ...admissionFields });
export const isConstructionError = (value: unknown): value is ConstructionError => value instanceof Error && isNativeAdmissionIssue(value);

const ballisticGrid = shape<BallisticMaterialGrid>({ version: literal(1), nx: number, ny: number, bounds, bits: string });
const skidLeg = shape({ x: number, top: number, foot: number });
const skidFrame = shape({ front: number, rear: number, y: number, tube: number, legs: array(skidLeg) });
const skidProjection = shape({ front: number, rear: number, y: number, tube: number, struts: array(number) });
const chassisPart = shape<ChassisPartMetadata>({ model: chassisModel, kind: chassisModel, part: string, segment: number,
  depth: number, material: metal, thicknessMm: number, credits: optional(number), limitKg: optional(number), frameKg: optional(number),
  frameLimitKg: optional(number), gearLimitKg: optional(number), deck: optional(number), length: optional(number), suspension: optional(number),
  profile: optional(array(chassisPoint)), outlines: optional(polygons), axles: optional(array(number)), wheelDiameter: optional(number),
  track: optional(shape({ front: number, rear: number, y: number, height: number })), skids: optional(skidFrame) });
const compiledPlate = shape<CompiledPlate>({ kind: optional(absent), id: string, owner: number, x: number, y: number, angle: number, length: number, material,
  thicknessMm: number, widthM: number, anchors: array(shape({ u: number, v: number })), mountId: nullable(string), ballisticGrid,
  originalArea: number, physicalMass: number, physicalInertia: number, physicalCenterLocal: point,
  chassis: optional(chassisPart), dragWidthM: optional(number) });
const mountWall = shape<WeaponMountWall>({ owner: number, wallId: string, thicknessMm: number, a: point, b: point,
  port: optional(shape({ lo: number, hi: number, centerU: number, min: number, max: number })) });
const shield = shape<WeaponMountShield>({ radius: number, thickness: number, halfAngle: number, opening: number });
const weaponMount = shape<WeaponMountProjection>({ version: literal(3), preset: mount, min: number, max: number, maxSpeed: number,
  exposed: boolean, fireTolerance: number, mirrored: boolean, hostOwner: number, hostId: nullable(string), hullAxis: number,
  recoil: number, bodyWidth: number, walls: array(mountWall), materialDepth: number, materialDensity: number, material, shield: nullable(shield) });
export { weaponMount as isWeaponMountProjection };
const support = shape<ModuleSupport>({ host: string, foot: array(point), normal: point, reach: optional(number), polygon: optional(polygon), mass: optional(number) });
export { support as isModuleSupport, chassisPart as isChassisPartMetadata, appearance as isConstructionAppearance };
const moduleBase: ObjectSchema<CompiledModuleBase> = { id: string, owner: number, x: number, y: number, angle: number,
  width: number, height: number, mountId: nullable(string), attached: boolean, health: number, maxHealth: number,
  physicalMass: number, mechanicalDepth: number, physicalCenterLocal: point, physicalInertia: number,
  mirrored: optional(boolean), exposed: optional(boolean), metal: optional(metal) };
const moduleSlots = { weaponPreset: optional(absent), weaponAmmo: optional(absent), weaponMount: optional(absent), aimOffset: optional(absent),
  barrelAngle: optional(absent), targetBarrelAngle: optional(absent), barrelProfile: optional(absent), receiverMm: optional(absent), barrelMm: optional(absent),
  materialPolygons: optional(absent), sensorMode: optional(absent), radarModel: optional(absent), support: optional(absent), ammoPreset: optional(absent),
  ammoType: optional(absent), capacityRounds: optional(absent), rounds: optional(absent), roundMass: optional(absent), capacityLitres: optional(absent),
  fuelLitres: optional(absent), powerKw: optional(absent), thrustN: optional(absent), suspension: optional(absent), armorMm: optional(absent),
  capacityM3: optional(absent), workKw: optional(absent), toolReach: optional(absent) };
const compiledWeapon = shape<Extract<CompiledModule, { kind: 'weapon' }>>({ ...moduleBase, ...moduleSlots, kind: literal('weapon'),
  weaponPreset: weapon, weaponAmmo: ammo, weaponMount, aimOffset: number, barrelAngle: number, targetBarrelAngle: number,
  barrelProfile: shape({ start: number, end: number, radius: number }), receiverMm: number, barrelMm: number, materialPolygons: polygons });
const compiledSensor = shape<Extract<CompiledModule, { kind: 'sensor' }>>({ ...moduleBase, ...moduleSlots, kind: literal('sensor'),
  sensorMode: sensor, radarModel: optional(radarModel), support: optional(support) });
const compiledAmmo = shape<Extract<CompiledModule, { kind: 'ammo' }>>({ ...moduleBase, ...moduleSlots, kind: literal('ammo'),
  ammoPreset: cartridge, ammoType: ammo, capacityRounds: number, rounds: number, roundMass: number });
const compiledFuel = shape<Extract<CompiledModule, { kind: 'fuel' }>>({ ...moduleBase, ...moduleSlots, kind: literal('fuel'), capacityLitres: number, fuelLitres: number });
const compiledEngine = shape<Extract<CompiledModule, { kind: 'engine' }>>({ ...moduleBase, ...moduleSlots, kind: literal('engine'), powerKw: number });
const compiledThruster = shape<Extract<CompiledModule, { kind: 'thruster' }>>({ ...moduleBase, ...moduleSlots, kind: literal('thruster'), thrustN: number });
const compiledCommand = shape<Extract<CompiledModule, { kind: 'command' }>>({ ...moduleBase, ...moduleSlots, kind: literal('command') });
const compiledGear = shape<Extract<CompiledModule, { kind: 'wheel' | 'track' }>>({ ...moduleBase, ...moduleSlots, kind: either(literal('wheel'), literal('track')),
  suspension: shape({ enabled: boolean, travel: number }), armorMm: optional(number) });
const compiledCarrier = shape<Extract<CompiledModule, { kind: 'hopper' | 'cistern' | 'supply' }>>({ ...moduleBase, ...moduleSlots,
  kind: either(literal('hopper'), literal('cistern'), literal('supply')), capacityM3: number });
const compiledTool = shape<Extract<CompiledModule, { kind: 'excavator' | 'drill' | 'builder' }>>({ ...moduleBase, ...moduleSlots,
  kind: either(literal('excavator'), literal('drill'), literal('builder')), workKw: number });
const compiledBlade = shape<Extract<CompiledModule, { kind: 'blade' }>>({ ...moduleBase, ...moduleSlots, kind: literal('blade'),
  workKw: number, toolReach: optional(number), support: optional(support) });
const compiledPaver = shape<Extract<CompiledModule, { kind: 'paver' }>>({ ...moduleBase, ...moduleSlots, kind: literal('paver'),
  workKw: number, capacityM3: number, toolReach: optional(number) });
export const isCompiledModule: Guard<CompiledModule> = either<CompiledModule>(compiledWeapon, compiledSensor, compiledAmmo, compiledFuel, compiledEngine,
  compiledThruster, compiledCommand, compiledGear, compiledCarrier, compiledTool, compiledBlade, compiledPaver);
const wall = shape<CompiledWall>({ id: string, owner: number, a: point, b: point, normal: point, length: number, material,
  thicknessMm: number, exterior: optional(boolean) });
const room = shape<CompiledRoom>({ id: string, polygon, walls: array(wall) });
const frame = shape<CompiledFrame>({ origin: point, widthM: number, nodes: array(node), plates: array(shape({ id: string, owner: number, a: string, b: string })) });
const fixedAssembly = shape<FixedAssembly>({ origin: point, mass: number, centerLocal: point, inertia: number });
const chassis = shape<ChassisProjection>({ model: chassisModel, kind: chassisModel, front: number, rear: number, length: number,
  deck: number, suspension: number, depth: number, armorMm: number, metal, thicknessMm: number, points: array(chassisPoint),
  segments: array(shape({ index: number, gap: boolean, a: point, b: point, plates: array(string), low: boolean })),
  outlines: polygons, beds: array(wall), plates: array(string), gear: array(string), emptyKg: number, loadedKg: number,
  frameKg: number, sectionAreaM2: number, secondMomentM4: number, frameLimitKg: number, gearLimitKg: number, limitKg: number,
  balance: pair(number), axles: optional(array(number)), axleKg: optional(number), wheelDiameter: optional(number),
  track: optional(shape({ front: number, rear: number, y: number, wheels: number, height: number })),
  roadWheelKg: optional(number), noseMm: optional(number), skids: optional(skidProjection) });
const powertrain = shape<NativePowertrain>({ powerKw: number, torqueNm: number, efficiency: number, rollingCoefficient: number,
  drag: number, dragAstern: number, dragOver: number, dragUnder: number, radius: number, maxDriveForce: number, gearedSpeed: nullable(number),
  maxSpeed: number, powerPerTonne: number, fueled: boolean, fuelLitres: number, rangeKm: number, fuelStarved: boolean, tracked: boolean });
export const isNativeCompiledConstruction = shape<NativeCompiledConstruction>({ version: literal(1), canonicalVersion: literal(DESIGN_VERSION), derived: literal(true),
  mechanicalAdmission: boolean, admissionIssues: array(isNativeAdmissionIssue), preset: either(literal('vehicle'), literal('bunker')),
  name: string, seed: number, launcher: point, appearance, terrain: nullable(string),
  vehicle: shape({ enabled: boolean, chassisId: nullable(string) }), plates: array(compiledPlate), modules: array(isCompiledModule), frame,
  rooms: array(room), beds: array(wall), fixedAssembly,
  eyes: array(shape({ x: number, y: number, left: number, right: number })),
  sights: array(shape({ id: string, mode: sensor, x: number, y: number, range: number, left: number, right: number, hidden: array(pair(number)) })),
  manufacturing: shape({ emptyKg: number, envelope: shape({ lengthM: number, heightM: number }) }), powertrain, chassis: optional(chassis),
  flight: optional(shape({ lifts: boolean, balanced: boolean, hoverLitres: number, hoverLean: number, liftN: number, idleLitres: number })) });
const compilerContract = shape<NativeCompilerContract>({ compilerVersion: literal(DESIGN_VERSION), constructionVersion: literal(DESIGN_VERSION),
  drafts: literal(true), mechanicalAdmission: literal(true), physicalSupport: literal(true) });
const compilerResponse = shape<NativeCompilerResponse>({ contract: compilerContract, construction: isCanonicalConstruction, compiled: isNativeCompiledConstruction });
export function isNativeCompilerResponse(value: unknown, draft: boolean): value is NativeCompilerResponse {
  return compilerResponse(value) && value.compiled.mechanicalAdmission === (value.compiled.admissionIssues.length === 0) &&
    (draft || value.compiled.mechanicalAdmission);
}
