import { clamp, lerp, pointInTriangle, angleDifference } from './math.ts';
import { componentPolygon, isRunningGear } from './assembly.ts';
import { weaponAngle } from './weapon-geometry.ts';
import { regionPolygons } from './damage-regions.ts';
import { gridRegions } from './armor-grid.ts';
import type { Point, Pose, PlateGeometry } from './math.ts';
import type { ComponentGeometry } from './assembly.ts';
import type { ArmourMaterial, MaterialId } from './materials.ts';
import type { ClipVertex } from './damage-regions.ts';
import type { GridBounds } from './armor-grid.ts';
import type { CompiledConstruction, CompiledModule, CompiledPlate } from './construction-contract.ts';
import type { NativeVehicle } from './native-contract.gen.ts';
import type { SceneSnapshot } from './scene-contract.ts';

export interface IndexActor { id: string }
export interface IndexPlate { id: string; actorId?: string | undefined; definition?: Pose | undefined }
export interface IndexModule { id: string; actorId?: string | undefined; definition?: never }
export interface IndexSource {
  readonly time?: number | undefined;
  readonly actors?: readonly IndexActor[] | undefined;
  readonly plates?: readonly IndexPlate[] | undefined;
  readonly modules?: readonly IndexModule[] | undefined;
}
export type FrameSource = IndexSource;
export interface RegionSource {
  definition: Pick<PlateGeometry, 'length' | 'thicknessMm'> & Partial<Pose>;
  solidRegions: readonly GridBounds[];
  revision?: number | undefined;
  material?: MaterialId | ArmourMaterial | undefined;
}
type BodyChannels = Pick<NativeVehicle, 'x' | 'y' | 'angle' | 'travel'>;
export type FrameBody = { [Key in keyof BodyChannels]?: BodyChannels[Key] | undefined } & { chassisId?: string | null | undefined };
export interface FrameActor extends IndexActor { revision?: number | undefined; vehicle?: FrameBody | null | undefined }
export interface FrameModule extends IndexModule, ComponentGeometry { exposed?: boolean | undefined }
export type GeometryPlate = (IndexPlate & { definition: PlateGeometry }) | (IndexPlate & PlateGeometry & { definition?: never });
export interface GeometrySource extends IndexSource {
  readonly actors?: readonly FrameActor[] | undefined;
  readonly plates?: readonly GeometryPlate[] | undefined;
  readonly modules?: readonly FrameModule[] | undefined;
}
type Records<Value> = Value extends readonly (infer Item)[] ? Item : never;
export type FrameActorOf<Source extends IndexSource> = Extract<Records<Source['actors']>, IndexActor>;
export type FramePlateOf<Source extends IndexSource> = Extract<Records<Source['plates']>, IndexPlate>;
export type FrameModuleOf<Source extends IndexSource> = Extract<Records<Source['modules']>, IndexModule>;
type DefinitionOf<Plate> = Plate extends unknown ? 'definition' extends keyof Plate
  ? Plate extends { definition: infer Definition } ? Definition : Plate extends { definition?: infer Definition } ? NonNullable<Definition> | Plate : Plate
  : Plate : never;
interface PlatePart<Plate extends IndexPlate> { id: string; type: 'plate'; data: Plate; order: number; definition: DefinitionOf<Plate>; actorId: string }
interface ModulePart<Module extends IndexModule> { id: string; type: 'module'; data: Module; order: number; definition: Module; actorId: string }
export type FramePart<Source extends IndexSource = SceneSnapshot> = PlatePart<FramePlateOf<Source>> | ModulePart<FrameModuleOf<Source>>;
export type SceneFramePart<Source extends IndexSource = SceneSnapshot> = FramePart<Source>;
export interface SceneIndex<Source extends IndexSource = SceneSnapshot> {
  readonly source: Source;
  readonly actors: Map<string, FrameActorOf<Source>>;
  readonly parts: FramePart<Source>[];
  readonly byId: Map<string, FramePart<Source>>;
  readonly actorParts: Map<string, FramePart<Source>[]>;
  get(id: string | null | undefined, type: 'plate'): FramePlateOf<Source> | null;
  get(id: string | null | undefined, type: 'module'): FrameModuleOf<Source> | null;
  get(id: string | null | undefined, type?: 'plate' | 'module'): FramePlateOf<Source> | FrameModuleOf<Source> | null;
}
export interface ComponentBuffers { positions: Float32Array; uvs: Float32Array; indices: Uint32Array; revision: string }
export interface RegionGeometry {
  positions: Float32Array; uvs: Float32Array; indices: Uint32Array;
  polygons: ClipVertex[][]; vertices: ClipVertex[]; edges: { a: number; b: number }[];
  revision: number | undefined; material: MaterialId | ArmourMaterial | undefined;
}
export type FrameSurface<Source extends GeometrySource = SceneSnapshot> =
  | PlatePart<FramePlateOf<Source>> & { component: null; gear: null; geometry: FramePlateOf<Source>; layer: 'plateLayer' }
  | ModulePart<FrameModuleOf<Source>> & { component: FrameModuleOf<Source>; gear: boolean; geometry: ComponentBuffers; layer: 'runningGearLayer' | 'outsideLayer' | 'moduleLayer' };
export interface SceneFrame<Source extends GeometrySource = SceneSnapshot> extends SceneIndex<Source> { readonly surfaces: FrameSurface<Source>[] }

const frames = new WeakMap<object, unknown>();
const geometries = new WeakMap<RegionSource, RegionGeometry>();
const componentGeometries = new Map<string, ComponentBuffers>(), COMPONENT_GEOMETRIES = 256;
const hasArea = (a: Point, b: Point, c: Point): boolean => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) > 1e-12;

// A plate view carries its definition and remaining material regions. Its
// rectangular base and UV orientation are derived here; only the clipped
// drawing geometry needs buffers. Picking and previews use the same shape.
export function regionGeometry(data: RegionSource): RegionGeometry {
  const cached = geometries.get(data); if (cached) return cached;
  const plate = data.definition, corners: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0]], nodes = corners.map(([u, v]) => ({
    x: (u - .5) * plate.length, y: (.5 - v) * plate.thicknessMm / 1000, u, v,
  })), polygons = regionPolygons(nodes, [0, 1, 2, 0, 2, 3], data.solidRegions), points: ClipVertex[] = [], indices: number[] = [], ids = new Map<string, number>();
  const vertex = (p: ClipVertex): number => {
    // Both texture channels start finite and are retained by every clipping interpolation.
    const key = [p.x, p.y, p.u!, p.v!].map(n => Math.round(n * 1e9)).join(':');
    if (!ids.has(key)) { ids.set(key, points.length); points.push(p); }
    return ids.get(key)!;
  };
  for (const poly of polygons) for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0]!, b = poly[i]!, c = poly[i + 1]!;
    if (hasArea(a, b, c)) indices.push(vertex(a), vertex(b), vertex(c));
  }
  // Cancel overlapping edges, including partial edges at region junctions.
  // Welding triangle vertices alone would leave visible seams inside material.
  interface EdgeEvent { t: number; delta: number; point: ClipVertex }
  const lines = new Map<string, EdgeEvent[]>(), edges: { a: number; b: number }[] = [];
  for (const poly of polygons) for (let i = 0; i < poly.length; i++) {
    let a = poly[i]!, b = poly[(i + 1) % poly.length]!, dx = b.x - a.x, dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 1e-10) continue;
    if (dx < -1e-10 || Math.abs(dx) <= 1e-10 && dy < 0) { [a, b] = [b, a]; dx = -dx; dy = -dy; }
    const length = Math.hypot(dx, dy), ux = dx / length, uy = dy / length,
      key = [ux, uy, uy * a.x - ux * a.y].map(n => Math.round(n * 1e9)).join(':');
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push({ t: ux * a.x + uy * a.y, delta: 1, point: a }, { t: ux * b.x + uy * b.y, delta: -1, point: b });
  }
  for (const events of lines.values()) {
    events.sort((a, b) => a.t - b.t); let active = 0, previous: EdgeEvent | undefined;
    for (let i = 0; i < events.length;) {
      const event = events[i]!;
      if (active === 1 && previous && event.t - previous.t > 1e-10) edges.push({ a: vertex(previous.point), b: vertex(event.point) });
      do { active += events[i++]!.delta; } while (i < events.length && Math.abs(events[i]!.t - event.t) < 1e-9);
      previous = event;
    }
  }
  const geometry = { positions: new Float32Array(points.flatMap(p => [p.x, p.y])),
    uvs: new Float32Array(points.flatMap(p => [p.u!, p.v!])), indices: new Uint32Array(indices),
    polygons, vertices: points, edges, revision: data.revision, material: data.material };
  geometries.set(data, geometry); return geometry;
}

// `pose` is where the plate stands: by default where its record has it, and where a frame draws it for a pick of what the
// frame shows (editor.ts `pickShownPiece`). The shape stays that of the record, worked out once for it.
export function regionContains(data: RegionSource & { definition: PlateGeometry }, point: Point, pose?: Point & { angle?: number | undefined }): boolean;
export function regionContains(data: RegionSource, point: Point, pose: Point & { angle?: number | undefined }): boolean;
export function regionContains(data: RegionSource, point: Point, pose: { x?: number | undefined; y?: number | undefined; angle?: number | undefined } = data.definition): boolean {
  const c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0),
    dx = point.x - pose.x!, dy = point.y - pose.y!, local = { x: c * dx + s * dy, y: -s * dx + c * dy };
  return regionGeometry(data).polygons.some(poly => poly.slice(1, -1).some((p, i) =>
    hasArea(poly[0]!, p, poly[i + 2]!) && pointInTriangle(local, poly[0]!, p, poly[i + 2]!)));
}

// Admission indexes one immutable snapshot. All presentation consumers retain
// its original records; this is not another editable document or solver state.
function indexedSource<Source extends IndexSource>(value: unknown, source: Source): value is SceneIndex<Source> {
  // Only createIndex writes this cache; its maps keep the source's own records.
  return value !== null && typeof value === 'object' && 'source' in value && value.source === source;
}
function createIndex(source: IndexSource): SceneIndex<IndexSource> {
  const actors = new Map((source.actors || []).map(actor => [actor.id, actor]));
  const parts: FramePart<IndexSource>[] = [
    ...(source.plates || []).map((data, order): PlatePart<IndexPlate> => ({
      id: data.id, type: 'plate', data, order, definition: data.definition || data, actorId: data.actorId || 'local',
    })),
    ...(source.modules || []).map((data, order): ModulePart<IndexModule> => ({
      id: data.id, type: 'module', data, order, definition: data.definition || data, actorId: data.actorId || 'local',
    })),
  ];
  const byId = new Map(parts.map(part => [part.id, part])), actorParts = new Map<string, FramePart<IndexSource>[]>();
  for (const part of parts) {
    if (!actorParts.has(part.actorId)) actorParts.set(part.actorId, []);
    actorParts.get(part.actorId)!.push(part);
  }
  function get(id: string | null | undefined, type: 'plate'): IndexPlate | null;
  function get(id: string | null | undefined, type: 'module'): IndexModule | null;
  function get(id: string | null | undefined, type?: 'plate' | 'module'): IndexPlate | IndexModule | null;
  function get(id: string | null | undefined, type?: 'plate' | 'module'): IndexPlate | IndexModule | null {
    const part = id == null ? undefined : byId.get(id);
    return part && (!type || part.type === type) ? part.data : null;
  }
  return { source, actors, parts, byId, actorParts, get };
}

export function sceneIndex<Source extends IndexSource>(source: Source): SceneIndex<Source> {
  const cached = frames.get(source); if (indexedSource(cached, source)) return cached;
  const frame = createIndex(source);
  if (source.time !== undefined || source.actors) frames.set(source, frame);
  if (!indexedSource(frame, source)) throw new TypeError('Scene index lost its source identity.');
  return frame;
}

function addSurfaces<Source extends GeometrySource>(frame: SceneIndex<Source>): asserts frame is SceneFrame<Source> {
  if ('surfaces' in frame) return;
  let surfaces: FrameSurface<Source>[] | undefined;
  const buildSurfaces = (): FrameSurface<Source>[] => frame.parts.flatMap((part): FrameSurface<Source>[] => {
    if (part.type === 'plate') return [{ ...part, component: null, gear: null, geometry: part.data, layer: 'plateLayer' }];
    const component = part.data;
    if (component.kind === 'weapon') return [];
    const gear = isRunningGear(component) && component.attached !== false;
    // What is carried out in the open stands over the skin of its hull, as the running gear does.
    return [{ ...part, component, gear, geometry: componentGeometry(component),
      layer: gear ? 'runningGearLayer' : component.exposed && component.attached !== false ? 'outsideLayer' : 'moduleLayer',
      order: frame.byId.get(component.id)!.order }];
  });
  Object.defineProperty(frame, 'surfaces', { enumerable: true, configurable: true, get: () => surfaces ||= buildSurfaces() });
}

export function sceneFrame<Source extends GeometrySource>(source: Source): SceneFrame<Source> {
  const frame = sceneIndex(source);
  addSurfaces(frame);
  return frame;
}

function componentGeometry(component: FrameModule): ComponentBuffers {
  // Canonical local contours depend only on the kind and dimensions. Reflection
  // is a pose transform, so actors facing either way share geometry and UVs. Network snapshots
  // replace component records even when this shape is unchanged; share the
  // read-only mesh across them and actors, without retaining their records.
  const revision = `${component.kind}:${component.width}:${component.height}`,
    cached = componentGeometries.get(revision);
  if (cached) {
    componentGeometries.delete(revision); componentGeometries.set(revision, cached);
    return cached;
  }
  const points = componentPolygon({ ...component, x: 0, y: 0, angle: 0, mirrored: false });
  const geometry = { positions: new Float32Array(points.flatMap(p => [p.x, p.y])),
    uvs: new Float32Array(points.flatMap(p => [p.x / component.width + .5, .5 - p.y / component.height])),
    indices: new Uint32Array(points.slice(1, -1).flatMap((_, i) => [0, i + 1, i + 2])),
    revision };
  componentGeometries.set(revision, geometry);
  if (componentGeometries.size > COMPONENT_GEOMETRIES) componentGeometries.delete(componentGeometries.keys().next().value!);
  return geometry;
}

// Blueprints enter the same frame contract once after an edit. The renderer
// does not carry a second editor-only draw pipeline.
export interface DesignActor {
  id: string; name: string; preset: CompiledConstruction['preset'];
  appearance: CompiledConstruction['appearance']; vehicle: CompiledConstruction['vehicle'];
  x: number; facing: number; mirror: number;
}
export interface DesignPlate extends RegionSource {
  id: string; actorId: string; definition: CompiledPlate; material: MaterialId;
  ballisticGrid: CompiledPlate['ballisticGrid']; solidRegions: GridBounds[];
  integrity: number; revision: number; marks: never[]; markRevision: number;
}
export type DesignModule = CompiledModule & { actorId: string };
export type DesignScene<Blueprint extends CompiledConstruction = CompiledConstruction> =
  Omit<Blueprint, 'actors' | 'time' | 'modules' | 'plates'> & { actors: DesignActor[]; time: number; modules: DesignModule[]; plates: DesignPlate[] };
type VariantKeys<Value> = Value extends unknown ? keyof Value : never;
export type WithAbsentSlots<Value, Keys extends PropertyKey = VariantKeys<Value>> = Value extends unknown
  ? Value & Partial<Record<Exclude<Keys, keyof Value>, never>> : never;

export function designFrame<Blueprint extends CompiledConstruction>(blueprint: Blueprint): DesignScene<Blueprint> {
  const actor = { id: 'local', name: blueprint.name, preset: blueprint.preset,
    appearance: blueprint.appearance, vehicle: blueprint.vehicle, x: 12, facing: -1, mirror: 1 };
  return { ...blueprint, actors: [actor], time: 0,
    modules: blueprint.modules.map(module => ({ ...module, actorId: actor.id })),
    plates: blueprint.plates.map(definition => ({ id: definition.id, actorId: actor.id, definition,
      material: definition.material,
      ballisticGrid: definition.ballisticGrid,
      solidRegions: definition.ballisticGrid ? gridRegions(definition.ballisticGrid) :
        [{ minX: -definition.length / 2, minY: -definition.thicknessMm / 2000,
          maxX: definition.length / 2, maxY: definition.thicknessMm / 2000 }],
      integrity: 1, revision: 0, marks: [], markRevision: 0 })) };
}

export interface SampleMotion {
  barrelAngle?: number | undefined; travel?: number | undefined; wheelSpin?: number | undefined;
}
export interface SampleHistory extends SampleMotion {
  x?: number | undefined; y?: number | undefined; angle?: number | undefined;
  definition?: { x?: number | undefined; y?: number | undefined; angle?: number | undefined } | undefined;
}
type PoseFields = Point & { angle?: number | undefined };
export type Sampleable = SampleMotion & { kind?: string | undefined } & (
  (PoseFields & { definition?: never }) | { definition: PoseFields; x?: number; y?: number; angle?: number }
);
export type Sampled<Part> = Part extends Sampleable ? Omit<Part, keyof Pose | keyof SampleMotion> & Pose & SampleMotion : never;
export function posePart<Part extends Sampleable>(part: Part, previous?: SampleHistory | null, alpha?: number): Sampled<Part>;
export function posePart(part: Sampleable, previous: SampleHistory | null = null, alpha = 1): Pose & SampleMotion {
  const t = clamp(alpha, 0, 1), gun = part.kind === 'weapon' || part.barrelAngle !== undefined;
  const current = part.definition || part, before = previous?.definition || previous,
    pose: Pose & SampleMotion = { ...part, x: lerp(before?.x ?? current.x, current.x, t), y: lerp(before?.y ?? current.y, current.y, t),
      angle: (before?.angle ?? current.angle ?? 0) + angleDifference(current.angle || 0, before?.angle ?? current.angle ?? 0) * t };
  if (gun) { const angle = weaponAngle(part), old = previous ? weaponAngle(previous) : angle;
    pose.barrelAngle = old + angleDifference(angle, old) * t; }
  if (part.travel !== undefined) pose.travel = lerp(previous?.travel ?? part.travel, part.travel, t);
  // Native wheel phase is unwrapped. Shortest-angle interpolation would reverse
  // a fast wheel or discard complete turns between delivered snapshots.
  if (part.wheelSpin !== undefined) pose.wheelSpin = lerp(previous?.wheelSpin ?? part.wheelSpin, part.wheelSpin, t);
  return pose;
}

// One sampled pose per identity serves surface drawing, servo/muzzle overlays,
// camera following and suspension. Geometry remains in its declared space.
type FramePiece<Source extends GeometrySource> = FramePlateOf<Source> | FrameModuleOf<Source>;
type SourceBody<Source extends GeometrySource> = NonNullable<FrameActorOf<Source>['vehicle']> & Point;
type PiecePose<Source extends GeometrySource> = Sampled<FramePiece<Source>>;
type BodyPose<Source extends GeometrySource> = Sampled<SourceBody<Source>>;
export type ScenePose<Source extends GeometrySource = SceneSnapshot> = PiecePose<Source> | BodyPose<Source>;
export interface SceneSample<Source extends GeometrySource = SceneSnapshot> {
  frame: SceneFrame<Source>;
  pose(id: string | null | undefined, type: 'plate'): Sampled<FramePlateOf<Source>> | null;
  pose(id: string | null | undefined, type: 'module'): Sampled<FrameModuleOf<Source>> | null;
  pose(id: string | null | undefined, type?: 'plate' | 'module'): PiecePose<Source> | null;
  actor(id: string | null | undefined): BodyPose<Source> | null;
}
function positioned<Body extends FrameBody>(body: Body | null | undefined): body is Body & Point {
  return Number.isFinite(body?.x) && Number.isFinite(body?.y);
}
export function sampleScene<Source extends GeometrySource>(state: Source, previous: Source | null = null, alpha = 1): SceneSample<Source> {
  const frame = sceneFrame(state), old = previous && sceneFrame(previous), poses = new Map<string | SourceBody<Source>, ScenePose<Source>>();
  function sample(key: string, current: FramePiece<Source>, actorId: string): PiecePose<Source>;
  function sample(key: SourceBody<Source>, current: SourceBody<Source>, actorId: string): BodyPose<Source>;
  function sample(key: string | SourceBody<Source>, current: FramePiece<Source> | SourceBody<Source>, actorId: string): ScenePose<Source> {
    const cached = poses.get(key); if (cached) return cached;
    const before = sameAdmission(actorId) ? typeof key === 'string' ? old?.get(key) : actorBody(old, actorId) : null;
    const pose = posePart(current, before, alpha);
    poses.set(key, pose); return pose;
  }
  const actorBody = (index: SceneFrame<Source> | null, id: string | null | undefined) => id == null ? undefined : index?.actors.get(id)?.vehicle;
  // A turn or replacement readmits the parts even when the source chassisId stays the same.
  // Sample its body and pieces from that admission together, before resuming ordinary motion.
  const sameAdmission = (id: string) => frame.actors.get(id)?.revision === old?.actors.get(id)?.revision &&
    actorBody(frame, id)?.chassisId === actorBody(old, id)?.chassisId;
  function pose(id: string | null | undefined, type: 'plate'): Sampled<FramePlateOf<Source>> | null;
  function pose(id: string | null | undefined, type: 'module'): Sampled<FrameModuleOf<Source>> | null;
  function pose(id: string | null | undefined, type?: 'plate' | 'module'): PiecePose<Source> | null;
  function pose(id: string | null | undefined, type?: 'plate' | 'module'): PiecePose<Source> | null {
    const current = frame.get(id, type);
    return current ? sample(current.id, current, current.actorId || 'local') : null;
  }
  return { frame, pose, actor: id => {
    const body = actorBody(frame, id);
    if (!positioned(body) || id == null) return null;
    return sample(body, body, id);
  } };
}
