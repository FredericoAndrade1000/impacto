import { MODULES, MATERIALS, METALS } from './materials.ts';
import { AMMO, isWeaponSettings, isWeaponId, isCartridgeId } from './weapons.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { TERRAIN_PROFILES } from './terrain.ts';
import { isRoadKind } from './roads.ts';
import { VIEW } from './network-protocol.ts';
import { factionFieldGuards, isFactionView, isRoomSquadView, isAiStatus } from './field-protocol-codec.ts';
import { isChassisPartMetadata, isConstructionAppearance, isModuleSupport, isWeaponMountProjection } from './construction-codec.ts';
import { nativeGrid, nativeMarks, nativeBarrelMarks, nativeHoles, nativeScars, isSceneEventBase } from './native-frame-contract.ts';
import { record, object as wireObject, numeric, textual, logical, unknownValue, undefinedValue, absent, literal, union, optional, tuple } from './wire-shape.ts';
import type { Guard, Optional } from './wire-shape.ts';
import type { Point, Pose } from './math.ts';
import type { SceneEventBase, SceneEye, SceneField } from './scene-contract.ts';
import type { TerrainId, TerrainRock, TerrainSector, TerrainSnapshot } from './terrain.ts';
import type { DrawingActor, DrawingBodyPanel, DrawingDefinition, DrawingModule, DrawingPlate, DrawingScene,
  DrawingShotBlock, DrawingTow, DrawingVehicle } from './scene-drawing-contract.ts';
import type { DepositObservation, FieldContact, FieldView } from './faction-ui.ts';
import type { RenderFaction, RenderFieldView } from './render.ts';
import type { CargoLoad } from './economy-contract.ts';

type Schema<Value extends object> = {
  [Key in keyof Value]-?: {} extends Pick<Value, Key> ? Optional<Value[Key]> : Guard<Value[Key]>;
};
// FrameReader replaces changed records and preserves the identity of unchanged
// records and payloads. Validate those immutable observations once, without
// cloning them or rescanning a retained array on every frame.
function memo<Value>(check: Guard<Value>): Guard<Value> {
  const accepted = new WeakSet<object>();
  return (value): value is Value => {
    if (value === null || typeof value !== 'object') return check(value);
    if (accepted.has(value)) return true;
    if (!check(value)) return false;
    accepted.add(value); return true;
  };
}
function structure<Value extends object>(schema: Schema<Value>): Guard<Value> {
  return (value): value is Value => {
    if (!record(value)) return false;
    for (const key in schema) {
      const check = schema[key];
      if (typeof check === 'function') { if (!check(value[key])) return false; }
      else if (check && key in value && !check.test(value[key])) return false;
    }
    return true;
  };
}
const object = <Value extends object>(schema: Schema<Value>): Guard<Value> => memo(structure(schema));
const struct = <const Checks extends Readonly<Record<string, Guard<unknown> | Optional<unknown>>>>(checks: Checks) => memo(wireObject(checks));
type Keys<Value> = Value extends unknown ? keyof Value : never;
type Slots<Value> = { [Key in Keys<Value>]: Value extends unknown ? Key extends keyof Value ? Value[Key] : undefined : never };
function array<Value>(check: Guard<Value>): Guard<Value[]> {
  return memo((value): value is Value[] => {
    if (!Array.isArray(value)) return false;
    const rows: readonly unknown[] = value;
    return rows.every(check);
  });
}
const maybe = <Value>(check: Guard<Value>): Guard<Value | undefined> => union(undefinedValue, check);
const nullable = <Value>(check: Guard<Value>): Guard<Value | null> => union(literal(null), check);
const keyOf = <Catalogue extends object>(catalogue: Catalogue): Guard<Extract<keyof Catalogue, string>> =>
  (value): value is Extract<keyof Catalogue, string> => typeof value === 'string' && Object.hasOwn(catalogue, value);
const point = object<Point>({ x: numeric, y: numeric });
const pose = object<Pose>({ x: numeric, y: numeric, angle: numeric });
const points = array(point), polygons = array(points);
const material = keyOf(MATERIALS), metal = keyOf(METALS), moduleKind = keyOf(MODULES), ammo = keyOf(AMMO), sensor = keyOf(SENSOR_MODES);
const weapon = (value: unknown) => isWeaponId(value), cartridge = (value: unknown) => isCartridgeId(value);
const facing = union(literal(-1), literal(1));
const preset = union(literal('vehicle'), literal('bunker'));
const terrainId: Guard<TerrainId> = keyOf(TERRAIN_PROFILES);
const outside = (value: object): boolean => Reflect.get(value, VIEW) === undefined || Reflect.get(value, VIEW) === 'outside';
const appearance = memo(isConstructionAppearance), marks = memo(nativeMarks), grid = memo(nativeGrid), scars = memo(nativeScars);
const cargo = object<CargoLoad>({ ferro: optional(numeric), ligas: optional(numeric), silica: optional(numeric), petroleo: optional(numeric) });
const eye = object<SceneEye>({ x: numeric, y: numeric, left: numeric, right: numeric });
const eyes = array(eye);
const service = union(
  struct({ kind: literal('build'), until: numeric }), struct({ kind: literal('repair'), until: numeric }),
  struct({ kind: literal('turn'), until: numeric }), struct({ kind: literal('dismantle'), progress: numeric }),
);
const field = object<SceneField>({
  wreck: optional(nullable(struct({ until: numeric }))), service: optional(nullable(service)),
  extraction: optional(nullable(array(struct({ partId: textual, siteId: textual })))),
  building: optional(nullable(struct({ at: optional(textual), pace: optional(numeric) }))),
  cargoWork: optional(nullable(struct({ kind: literal('load'), until: optional(numeric), waiting: optional(literal(true)), limited: optional(literal(true)) }))),
  road: optional(nullable(struct({ tool: union(literal('blade'), literal('paver')), from: numeric, to: numeric, idle: optional(logical), short: optional(logical) }))),
});

type VehicleFields = Slots<DrawingVehicle>;
const vehicleFields = object<VehicleFields>({
  x: maybe(numeric), y: maybe(numeric), angle: maybe(numeric), maxSpeed: maybe(numeric), powerKw: maybe(numeric),
  fuelStarved: maybe(logical), fuelLitres: maybe(numeric), rangeKm: maybe(numeric), driveSpeed: maybe(numeric),
  traction: maybe(numeric), gearCount: maybe(numeric), slip: maybe(numeric), stuck: maybe(nullable(textual)),
  thrustN: maybe(numeric), flying: maybe(logical), vx: maybe(numeric), vy: maybe(numeric), omega: maybe(numeric),
  engine: maybe(logical), throttle: maybe(numeric), brake: maybe(numeric), chassisId: maybe(nullable(textual)),
  fuelRate: maybe(numeric), enabled: maybe(logical), powerPerTonne: maybe(numeric), massTonnes: maybe(numeric), travel: maybe(numeric),
  groundSlope: maybe(numeric), groundSurface: maybe(nullable(textual)), groundGrip: maybe(numeric), groundLoad: maybe(numeric),
  groundPressureKPa: maybe(numeric), groundResistance: maybe(numeric), softGroundLoad: maybe(numeric), lastImpulse: maybe(numeric), peakImpulse: maybe(numeric),
});
const vehicle: Guard<DrawingVehicle> = memo((value): value is DrawingVehicle => vehicleFields(value) &&
  (numeric(value.x) && numeric(value.y) && numeric(value.angle) || typeof value.enabled === 'boolean' && (value.chassisId === null || typeof value.chassisId === 'string')));

type ActorFields = Slots<Omit<DrawingActor, typeof VIEW>>;
const actorFields = object<ActorFields>({ id: textual, x: numeric, ownerId: maybe(nullable(textual)), team: maybe(nullable(textual)),
  name: maybe(textual), playerName: maybe(textual), color: maybe(textual), preset: maybe(preset), appearance: maybe(nullable(appearance)),
  facing: maybe(numeric), mirror: maybe(numeric), revision: maybe(numeric), defeated: maybe(logical), burning: maybe(logical), ghost: unknownValue,
  field: maybe(nullable(field)), cooldown: maybe(numeric), eyes: maybe(eyes), y: maybe(numeric), vehicle: maybe(nullable(vehicle)),
  aim: maybe(point), weapon: maybe(nullable(memo(isWeaponSettings))), contactContours: maybe(polygons),
});
const actor: Guard<DrawingActor> = memo((value): value is DrawingActor => actorFields(value) && outside(value));

type Suspension = NonNullable<DrawingModule['suspension']>;
type SuspensionFields = Slots<Suspension>;
const suspension = object<SuspensionFields>({ enabled: maybe(logical), travel: maybe(numeric), displacement: maybe(numeric), tilt: maybe(numeric), compression: maybe(numeric) });
type Contact = NonNullable<DrawingModule['groundContact']>;
type ContactFields = Slots<Contact>;
const contact = object<ContactFields>({ x: numeric, y: maybe(numeric), nx: maybe(numeric), ny: maybe(numeric), tx: maybe(numeric), ty: maybe(numeric),
  contacts: maybe(numeric), minX: maybe(numeric), maxX: maybe(numeric), materials: maybe(scars) });
type ModuleFields = Slots<Omit<DrawingModule, typeof VIEW>>;
const moduleFields = object<ModuleFields>({ id: textual, actorId: textual, kind: moduleKind, x: numeric, y: numeric, angle: numeric,
  width: numeric, height: numeric, attached: logical, mountId: maybe(nullable(textual)), health: maybe(numeric), maxHealth: maybe(numeric),
  owner: maybe(numeric), physicalMass: maybe(numeric), mechanicalDepth: maybe(numeric), physicalCenterLocal: maybe(point), physicalInertia: maybe(numeric),
  mirrored: maybe(logical), exposed: maybe(logical), metal: maybe(metal), weaponPreset: maybe(weapon), weaponAmmo: maybe(ammo),
  weaponMount: maybe(memo(isWeaponMountProjection)), aimOffset: maybe(numeric), barrelAngle: maybe(numeric), targetBarrelAngle: maybe(numeric),
  barrelProfile: maybe(struct({ start: numeric, end: numeric, radius: numeric })), receiverMm: maybe(numeric), barrelMm: maybe(numeric),
  materialPolygons: maybe(polygons), sensorMode: maybe(sensor), radarModel: maybe(union(literal('legacy'), literal('mobile'))),
  support: maybe(memo(isModuleSupport)), ammoPreset: maybe(cartridge), ammoType: maybe(ammo), capacityRounds: maybe(numeric), rounds: maybe(numeric),
  roundMass: maybe(numeric), capacityLitres: maybe(numeric), fuelLitres: maybe(numeric), powerKw: maybe(numeric), thrustN: maybe(numeric),
  suspension: maybe(suspension), armorMm: maybe(numeric), capacityM3: maybe(numeric), workKw: maybe(numeric), toolReach: maybe(numeric),
  burning: maybe(logical), detonated: maybe(logical), marks: maybe(marks), markRevision: maybe(numeric), groundMarks: maybe(numeric), groundDamage: maybe(numeric),
  barrelDisabled: maybe(logical), barrelMarks: maybe(memo(nativeBarrelMarks)), beltCut: maybe(logical), mantletHoles: maybe(memo(nativeHoles)),
  elevationDamage: maybe(numeric), elevationDisabled: maybe(logical), servoVelocity: maybe(numeric), servoMaxSpeed: maybe(numeric), reload: maybe(numeric),
  wheelSpin: maybe(numeric), cargo: maybe(cargo), thrust: maybe(numeric), source: maybe(textual), groundContact: maybe(nullable(contact)),
  dryMass: maybe(numeric), burnAge: maybe(numeric), fireAge: maybe(numeric), barrelDamage: maybe(numeric), ballisticScars: maybe(scars),
  targetAimOffset: maybe(numeric), wheelAngularSpeed: maybe(numeric), barrelTemperature: maybe(numeric), barrelCooling: maybe(logical),
  loaded: maybe(numeric), feedReload: maybe(numeric),
});
const module: Guard<DrawingModule> = memo((value): value is DrawingModule => moduleFields(value) && outside(value));

type DefinitionFields = Slots<DrawingDefinition>;
const definition = object<DefinitionFields>({ id: textual, x: numeric, y: numeric, angle: numeric, length: numeric, thicknessMm: numeric, material,
  anchors: maybe(array(struct({ u: numeric, v: numeric }))), widthM: maybe(numeric), massScale: maybe(numeric), chassis: maybe(memo(isChassisPartMetadata)),
  owner: maybe(numeric), mountId: maybe(nullable(textual)), physicalMass: maybe(numeric), physicalCenterLocal: maybe(point), physicalInertia: maybe(numeric),
  kind: undefinedValue, actorId: maybe(textual), ballisticGrid: maybe(grid), originalArea: maybe(numeric), dragWidthM: maybe(numeric) });
const bounds = struct({ minX: numeric, minY: numeric, maxX: numeric, maxY: numeric });
type PlateFields = Slots<DrawingPlate>;
const plateFields = object<PlateFields>({ id: textual, actorId: maybe(textual), material, definition, solidRegions: array(bounds), integrity: numeric,
  revision: numeric, marks, markRevision: numeric, attached: maybe(logical), ballisticGrid: maybe(grid),
  physicalMass: maybe(numeric), physicalCenterLocal: maybe(point), physicalInertia: maybe(numeric) });
const plate: Guard<DrawingPlate> = memo((value): value is DrawingPlate => plateFields(value));
const bodyPanelFields = object<Slots<DrawingBodyPanel>>({ id: textual, actorId: maybe(textual), localPolygon: maybe(points), pose: maybe(pose),
  roomId: maybe(textual), poly: maybe(points) });
const bodyPanel: Guard<DrawingBodyPanel> = memo((value): value is DrawingBodyPanel => bodyPanelFields(value) &&
  (typeof value.actorId === 'string' && value.localPolygon !== undefined && value.pose !== undefined || typeof value.roomId === 'string' && value.poly !== undefined));
type TowFields = Slots<DrawingTow>;
const towFields = object<TowFields>({ actorId: textual, targetId: textual, anchorA: point, anchorB: point, length: numeric,
  partAId: maybe(textual), partBId: maybe(textual), localA: maybe(point), localB: maybe(point), tension: maybe(numeric), limit: maybe(numeric),
  sling: maybe(logical), bridle: maybe(nullable(tuple(point, point))) });
const tow: Guard<DrawingTow> = memo((value): value is DrawingTow => towFields(value));
const shotKind = struct({ preset: nullable(textual), ammo: textual, poweredTrail: logical,
  actorId: optional(maybe(nullable(textual))), weapon: optional(maybe(textual)), name: optional(maybe(nullable(textual))) });
const doubleArray: Guard<Float64Array> = (value): value is Float64Array => value instanceof Float64Array;
const shots = object<DrawingShotBlock>({ data: doubleArray, kinds: array(shotKind), drag: optional(doubleArray) });

const sector = object<TerrainSector>({ start: numeric, end: numeric, surface: textual, label: optional(textual) });
const rock = object<TerrainRock>({ start: numeric, peak: numeric, end: numeric, height: numeric });
const featureKind = union(literal('ridge'), literal('scarp'), literal('outcrop'), literal('talus'), literal('drywash'), literal('lowland'), literal('road'), literal('dune'), literal('embankment'), literal('ruins'));
const feature = union(
  struct({ kind: literal('plateau'), start: numeric, peak: numeric, end: numeric, height: numeric, surface: textual, crest: numeric }),
  struct({ kind: featureKind, start: numeric, peak: numeric, end: numeric, height: numeric, surface: textual, crest: optional(absent) }),
);
const terrain = object<TerrainSnapshot>({ id: terrainId, seed: numeric, length: numeric, center: numeric, spacing: numeric, material: textual,
  minX: numeric, maxX: numeric, points, sectors: array(sector), features: optional(array(feature)), rocks: optional(array(rock)) });
const terrainSummary = object<Pick<TerrainSnapshot, 'seed' | 'length' | 'center'>>({ seed: numeric, length: numeric, center: numeric });
const terrainGeometryKeys = ['id', 'spacing', 'material', 'minX', 'maxX', 'points', 'sectors', 'features', 'rocks'];
const terrainSettings: Guard<NonNullable<DrawingScene['terrainSettings']>> = memo((value): value is NonNullable<DrawingScene['terrainSettings']> =>
  record(value) && (terrainGeometryKeys.some(key => Object.hasOwn(value, key)) ? terrain(value) : terrainSummary(value)));
const road = struct({ x0: numeric, x1: numeric, kind: isRoadKind });
const stats = struct({ shots: numeric, impacts: numeric, penetrations: numeric, ricochets: numeric, explosions: numeric,
  spallBursts: optional(numeric), secondaryShots: optional(numeric), secondaryComponentHits: optional(numeric) });
const flag = memo(factionFieldGuards.flag);
const contactMark: Guard<FieldContact> = union(
  object<Extract<FieldContact, { kind: 'radar' }>>({ id: textual, kind: literal('radar'), x: numeric, y: numeric, error: numeric, at: numeric,
    shared: optional(absent), from: optional(absent), side: optional(absent), by: optional(absent) }),
  object<Extract<FieldContact, { shared: true }>>({ kind: literal('sound'), shared: literal(true), from: struct({ ref: textual, nation: nullable(textual),
    flag: optional(flag), name: optional(textual) }), side: facing, at: numeric,
    id: optional(absent), x: optional(absent), y: optional(absent), error: optional(absent), by: optional(absent) }),
  object<Extract<FieldContact, { kind: 'sound'; by: string }>>({ kind: literal('sound'), by: textual, side: numeric, at: numeric,
    id: optional(absent), x: optional(absent), y: optional(absent), error: optional(absent), shared: optional(absent), from: optional(absent) }),
  object<Extract<FieldContact, { kind: 'battery' }>>({ id: textual, kind: literal('battery'), x: numeric, y: optional(numeric), error: numeric, at: numeric,
    by: union(literal('radar'), literal('sound')), shared: optional(absent), from: optional(absent), side: optional(absent) }),
);
// Viewer metadata can be attached after transport admission. Recheck the small
// envelope each time while the immutable rows and nested payloads stay cached.
const scene = structure<DrawingScene>({
  time: numeric, tick: optional(numeric), actors: array(actor), modules: array(module), plates: array(plate), bodyPanels: optional(array(bodyPanel)), tows: optional(array(tow)), shots: optional(shots),
  name: optional(textual), preset: optional(preset), terrain: optional(nullable(textual)), terrainSettings: optional(terrainSettings), roads: optional(array(road)),
  weather: optional(textual), appearance: optional(nullable(appearance)), launcher: optional(point), testDistance: optional(numeric), stats: optional(stats),
});
type ViewerMetadata = Omit<FieldView, keyof DrawingScene | 'faction'>;
const viewer = structure<ViewerMetadata>({ localPlayerId: optional(maybe(nullable(textual))), squad: optional(nullable(memo(isRoomSquadView))),
  contacts: optional(array(contactMark)), controlledActor: optional(nullable(textual)), shared: optional(logical),
  pace: optional(numeric), players: optional(array(struct({ id: textual, connected: optional(maybe(logical)), ai: optional(isAiStatus) }))), sharedEyes: optional(eyes),
});
const events = array(memo(isSceneEventBase));
export { scene as isDrawingScene };
const faction = memo(isFactionView);
export const isFieldView: Guard<FieldView> = (value): value is FieldView => scene(value) && viewer(value) &&
  (!('faction' in value) || value.faction === null || faction(value.faction));
const depositObservation = object<DepositObservation>({ id: textual, left: numeric, stock: numeric, at: optional(nullable(numeric)),
  seen: optional(logical), loading: optional(logical), extracting: optional(logical), active: optional(logical) });
const renderFaction = object<RenderFaction>({ id: textual, flag, known: memo(factionFieldGuards.known), deposits: array(depositObservation),
  explored: optional(memo(factionFieldGuards.explored)), units: optional(memo(factionFieldGuards.units)),
  works: optional(memo(factionFieldGuards.works)), posts: optional(memo(factionFieldGuards.posts)), base: optional(memo(factionFieldGuards.base)),
  bases: optional(memo(factionFieldGuards.bases)), outposts: optional(memo(factionFieldGuards.outposts)), roadworks: optional(memo(factionFieldGuards.roadworks)),
  heaps: optional(memo(factionFieldGuards.heaps)), territory: optional(memo(factionFieldGuards.territory)), activity: optional(memo(factionFieldGuards.activity)),
});
export const isRenderFieldView: Guard<RenderFieldView> = (value): value is RenderFieldView => scene(value) && viewer(value) &&
  (!('faction' in value) || value.faction === null || renderFaction(value.faction)) &&
  (!('observerBases' in value) || factionFieldGuards.bases(value.observerBases));

export function decodeDrawingScene(value: unknown): DrawingScene {
  if (!scene(value)) throw new TypeError('Invalid drawing scene.');
  return value;
}
export function decodeFieldView(value: unknown): FieldView {
  if (!isFieldView(value)) throw new TypeError('Invalid field view.');
  return value;
}
export function decodeRenderFieldView(value: unknown): RenderFieldView {
  if (!isRenderFieldView(value)) throw new TypeError('Invalid render field view.');
  return value;
}
export function decodeDrawingEvents(value: unknown): readonly SceneEventBase[] {
  if (!events(value)) throw new TypeError('Invalid drawing events.');
  return value;
}
