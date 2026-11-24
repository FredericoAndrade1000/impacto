import { CollisionIndex } from './collision.ts';
import { componentPolygons } from './assembly.ts';
import { MATERIALS } from './materials.ts';
import { flightPath, flightState, GRAVITY } from './ballistics.ts';
import { clamp } from './math.ts';
import { Terrain } from './terrain.ts';
import { NO_ROADS } from './roads.ts';
import { groundResponse } from './ground-impact.ts';
import { regionGeometry } from './scene-frame.ts';
import { FIXED_DT } from './physics.ts';
import { skidPlate } from './chassis.ts';
import type { CollisionGroup, CollisionHit, RaycastOptions } from './collision.ts';
import type { ArmourMaterial } from './materials.ts';
import type { Point } from './math.ts';
import type { GroundResponse } from './ground-response-contract.ts';
import type { FlightTrajectory, FlightState } from './ballistic-contract.ts';
import type { TerrainOptions, TerrainRaycast } from './terrain.ts';
import type { AmmoId } from './weapons.ts';
import type { DrawingScene, DrawingModule, DrawingPlate, DrawingActor, DrawingVehicle } from './scene-drawing-contract.ts';

type QueryModuleKey = 'id' | 'kind' | 'width' | 'height' | 'x' | 'y' | 'angle' | 'weaponPreset' | 'weaponMount' | 'materialPolygons' | 'health' | 'attached' | 'barrelAngle' | 'mirrored' | 'barrelDisabled' | 'markRevision';
export type PreviewModule = Pick<DrawingModule, QueryModuleKey> & { actorId?: string | undefined };
export type PreviewPlate = Pick<DrawingPlate, 'id' | 'actorId' | 'material' | 'solidRegions' | 'revision' | 'attached'> & {
  definition: Pick<DrawingPlate['definition'], 'x' | 'y' | 'angle' | 'length' | 'thicknessMm'>;
};
export type PreviewVehicle = DrawingVehicle;
export type PreviewActor = Pick<DrawingActor, 'id' | 'defeated' | 'team' | 'revision' | 'facing' | 'mirror'> & { vehicle?: PreviewVehicle | null | undefined };
export interface PreviewScene extends Pick<DrawingScene, 'terrain' | 'terrainSettings' | 'roads'> {
  time: number; actors: readonly PreviewActor[]; plates: readonly PreviewPlate[]; modules: readonly PreviewModule[];
}
type PreviewPart = PreviewModule | PreviewPlate;

export type PreviewOwner =
  | { type: 'plate'; id: string; object: PreviewPlate; material: ArmourMaterial }
  | { type: 'module'; id: string; object: PreviewModule; material: undefined };
export interface GroundPreviewOwner { type: 'ground'; id: 'ground'; object?: never; material?: never }
export interface GroundPreviewHit extends TerrainRaycast { depth: 0; owner: GroundPreviewOwner; exitX?: never; exitY?: never }
export type PreviewContact = CollisionHit<PreviewOwner> | GroundPreviewHit;
const isGroundHit = (hit: PreviewContact): hit is GroundPreviewHit => hit.owner.type === 'ground';
interface PredictionFields { path: (Point & { time?: number })[]; time: number; angleDegrees: number; direction: Point; traversedMm: number }
export type MaterialImpactPrediction = CollisionHit<PreviewOwner> & PredictionFields & { surface: undefined; bounce: null };
export type GroundImpactPrediction = GroundPreviewHit & PredictionFields & { surface: string; bounce: GroundResponse | null };
export type ImpactPrediction = MaterialImpactPrediction | GroundImpactPrediction;
export type PredictableFlight = FlightTrajectory & { reachable: boolean };
export interface ImpactOptions { platform?: 'vehicle' | 'ground'; componentId?: string | null; actorId?: string | null | undefined; ammo?: AmmoId; power?: number }
export interface ImpactIndex { raycast(start: Point, end: Point, options?: RaycastOptions): CollisionHit<PreviewOwner> | null }
interface PreviewRecord {
  owner: PreviewOwner; key?: string; group?: CollisionGroup<PreviewOwner> | null;
  local?: Point[]; points?: Point[]; polygons?: Point[][]; stamp?: unknown[];
}
interface Admission {
  state?: PreviewScene; records: Map<string, PreviewRecord>;
  terrainKey?: string; terrain?: Terrain;
}

const admissions = new WeakMap<ImpactIndex, Admission>();
const sameArray = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a?.length === b.length && b.every((value, i) => value === a[i]);
function previewOwner(item: PreviewPart): PreviewOwner {
  return 'kind' in item ? { type: 'module', id: item.id, object: item, material: undefined } :
    { type: 'plate', id: item.id, object: item, material: MATERIALS[item.material] };
}

// Refit one preview index between immutable snapshots. A damage revision clips
// the small base contour once; motion only updates the current rigid pose.
export function snapshotCollisionIndex(state: PreviewScene, index: CollisionIndex<PreviewOwner> | null = null) {
  index ||= new CollisionIndex<PreviewOwner>();
  let admission = admissions.get(index);
  if (!admission) { admission = { records: new Map() }; admissions.set(index, admission); }
  if (admission.state === state) return index;
  index.clear();
  const present = new Set<string>(), recordFor = (item: PreviewPart, type: 'plate' | 'module') => {
    const key = type + ':' + item.id; present.add(key);
    let record = admission.records.get(key);
    if (!record) { record = { owner: previewOwner(item) }; admission.records.set(key, record); }
    Object.assign(record.owner, { object: item, material: 'material' in item ? MATERIALS[item.material] : undefined });
    return record;
  };
  // Defeat belongs to the whole actor. A destroyed piece on a live actor still supplies its remaining cover. A round
  // flies between the skids of an aircraft.
  const defeated = new Set((state.actors || []).filter(actor => actor.defeated).map(actor => actor.id));
  for (const plate of state.plates) if (!defeated.has(plate.actorId || 'local') && !skidPlate(plate.id))
    addMesh(index, plate, recordFor(plate, 'plate'));
  for (const module of state.modules || []) if (module.attached !== false && !defeated.has(module.actorId || 'local'))
    addModule(index, module, recordFor(module, 'module'));
  for (const key of admission.records.keys()) if (!present.has(key)) admission.records.delete(key);
  admission.state = state; index.refreshHierarchy();
  return index;
}
function addMesh(index: CollisionIndex<PreviewOwner>, item: PreviewPlate, record: PreviewRecord) {
  const key = [item.revision, item.definition?.length, item.definition?.thicknessMm].join(':'), pose = item.definition || item;
  if (record.key !== key) {
    record.key = key; record.group = null;
    const polygons = regionGeometry(item).polygons;
    record.local = polygons.flat(); record.points = record.local.map(() => ({ x: 0, y: 0 })); record.polygons = [];
    let offset = 0;
    for (const polygon of polygons) { record.polygons.push(record.points.slice(offset, offset + polygon.length)); offset += polygon.length; }
  }
  const vertices = record.points!, c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0);
  for (let i = 0; i < vertices.length; i++) {
    const p = record.local![i]!; vertices[i]!.x = pose.x + p.x * c - p.y * s; vertices[i]!.y = pose.y + p.x * s + p.y * c;
  }
  record.group = index.include(record.owner, record.polygons!, record.group);
}
function addModule(index: CollisionIndex<PreviewOwner>, module: PreviewModule, record: PreviewRecord) {
  // The tube remains visible and reserves construction space, but direct shots
  // pass through it. The forecast traces the receiver and the actual shield.
  const mount = module.weaponMount, shield = mount?.shield,
    polygons = componentPolygons(module).filter((_, i) => module.kind !== 'weapon' || i !== 1),
    stamp = [module.kind, module.width, module.height, module.weaponPreset, mount?.exposed,
      shield?.radius, shield?.thickness, shield?.halfAngle, shield?.opening,
      module.kind === 'weapon' ? module.markRevision : null, ...polygons.map(poly => poly.length)],
    changed = !sameArray(record.stamp, stamp);
  let count = 0;
  for (const poly of polygons) count += poly.length;
  if (record.points?.length !== count) record.points = Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  const vertices = record.points!;
  let at = 0;
  for (const poly of polygons) for (const point of poly) {
    const vertex = vertices[at++]!; vertex.x = point.x; vertex.y = point.y;
  }
  if (changed) {
    record.stamp = stamp; record.group = null; record.polygons = [];
    let offset = 0;
    for (const poly of polygons) { record.polygons.push(vertices.slice(offset, offset + poly.length)); offset += poly.length; }
  }
  record.group = index.include(record.owner, record.polygons!, record.group);
}
export function predictImpact(state: PreviewScene, solution: PredictableFlight | null | undefined, options: ImpactOptions = {}, index: ImpactIndex = snapshotCollisionIndex(state)): ImpactPrediction | null {
  if (!solution) return null;
  const settings: TerrainOptions = state.terrainSettings || {}, key = [state.terrain || 'flat', settings.seed, settings.length, settings.center, Boolean(settings.points)].join(':');
  let admission = admissions.get(index);
  if (!admission) { admission = { records: new Map() }; admissions.set(index, admission); }
  if (admission.terrainKey !== key) {
    admission.terrain = new Terrain(state.terrain || 'flat', settings); admission.terrainKey = key;
  }
  // The ground a round meets is the road where the field has laid one (roads.ts).
  const terrain = admission.terrain!; terrain.roads = state.roads || NO_ROADS;
  // A live round travels one straight chord per simulation step and strikes
  // where that chord does, so the forecast traces the same chords from the
  // muzzle: the two agree to the step, grazing contacts included. A flight too
  // long for one bounded path is first walked several steps at a time, and
  // only a stretch that may touch something is traced step by step.
  // A shot that cannot reach the aim has no point to stop at: it is followed to wherever it comes down.
  const limit = solution.flightLimit ?? solution.time, reach = solution.reachable ? Math.min(solution.time, limit) : limit,
    steps = Math.max(1, Math.ceil(reach / FIXED_DT - 1e-9)), stride = Math.ceil(steps / 512), span = stride * FIXED_DT,
    whole = Math.min(Math.ceil(steps / stride), Math.floor(limit / span + 1e-12)),
    samples = whole ? flightPath(solution, whole, Math.min(limit, whole * span)) : [flightState(solution, 0)];
  if (whole * span < reach - 1e-9) samples.push(flightState(solution, Math.min(limit, (whole + 1) * span)));
  // A round meets whatever stands in its way, of its own side or not, as the core's does (`Sides`): the vehicle that
  // fires it and its allies are met as anyone. The gun itself is passed on the first chord.
  const gun = options.platform === 'vehicle' ? options.componentId : null, path: (Point & { time?: number })[] = [samples[0]!],
    ignoreIds = gun ? new Set([gun]) : null;
  const contact = (a: Point, b: Point, ignore: ReadonlySet<string> | null): PreviewContact | null => {
    const plate = index.raycast(a, b, { completeExit: true, ...(ignore ? { ignoreIds: ignore } : {}), projectile: true }), ground = terrain.raycast(a, b);
    return ground && (!plate || ground.enter < plate.enter) ?
      { ...ground, depth: 0, owner: { type: 'ground', id: 'ground' } } : plate;
  };
  // One chord of the live flight, cut where the flight comes level with the point it was asked to reach.
  type ChordPoint = Point & { time: number };
  const live = (a: ChordPoint, b: ChordPoint, ignore: ReadonlySet<string> | null) => {
    let end: ChordPoint = b;
    if (b.time > reach + 1e-9) {
      const last = flightState(solution, reach), dx = b.x - a.x, dy = b.y - a.y,
        share = clamp(((last.x - a.x) * dx + (last.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      end = { x: a.x + dx * share, y: a.y + dy * share, time: a.time + (b.time - a.time) * share };
    }
    return { hit: contact(a, end, ignore), a, end };
  };
  // The steps inside a longer stretch. The arc bulges above its chord by no
  // more than gravity gives it, so nothing reaches the steps without crossing
  // the chord or the same chord raised by that much.
  const stretch = (a: FlightState, b: FlightState, first: boolean) => {
    const dt = b.time - a.time, lift = GRAVITY * dt * dt / 6 + .002;
    if (dt <= FIXED_DT * (1 + 1e-9)) return live(a, b, first ? ignoreIds : null);
    if (!first && b.time <= reach + 1e-9 && !contact(a, b, null) && !index.raycast({ x: a.x, y: a.y + lift }, { x: b.x, y: b.y + lift }, { projectile: true })) return { hit: null, a, end: b };
    let from: ChordPoint = a, traced: ReturnType<typeof live> | null = null;
    for (let step = 1; from.time < Math.min(b.time, reach) - 1e-9; step++) {
      const time = a.time + step * FIXED_DT, next = time < b.time - 1e-9 ? flightState(solution, time) : b;
      traced = live(from, next, first && step === 1 ? ignoreIds : null);
      if (traced.hit) return traced;
      from = next;
    }
    return traced || { hit: null, a, end: b };
  };
  for (let i = 1; i < samples.length; i++) {
    const { hit, a, end } = stretch(samples[i - 1]!, samples[i]!, i === 1);
    if (hit) {
      const time = a.time + (end.time - a.time) * hit.enter, { vx, vy } = flightState(solution, Math.min(time, limit)),
        speed = Math.hypot(vx, vy), cosine = clamp(Math.abs((vx * hit.nx + vy * hit.ny) / speed), 0, 1);
      path.push({ x: hit.x, y: hit.y });
      if (isGroundHit(hit)) return { ...hit, path, time, angleDegrees: Math.acos(cosine) * 180 / Math.PI,
        surface: hit.surface,
        bounce: groundResponse({ vx, vy, ammo: options.ammo, power: options.power || 1 }, hit, hit.surface),
        direction: { x: vx / speed, y: vy / speed }, traversedMm: hit.depth * 1000 };
      return { ...hit, path, time, angleDegrees: Math.acos(cosine) * 180 / Math.PI,
        surface: undefined, bounce: null,
        direction: { x: vx / speed, y: vy / speed }, traversedMm: hit.depth * 1000 };
    }
    path.push(end);
    if (end.time >= reach - 1e-9) break;
  }
  return null;
}
