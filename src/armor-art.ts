import { regionGeometry } from './scene-frame.ts';
import { partitionArmorJoints } from './armor-joints.ts';
import type { Point, Pose, LocalPoint } from './math.ts';
import type { GridBounds } from './armor-grid.ts';
import type { RegionSource, RegionGeometry } from './scene-frame.ts';
import type { ClipVertex } from './damage-regions.ts';
import type { JointBuffers } from './armor-joints.ts';
import type { XY } from './canvas-art.ts';
interface ArmorSource extends RegionSource {
  definition: RegionSource['definition'] & { anchors?: readonly LocalPoint[] | undefined };
  actorId?: string | undefined; shapeKey?: string | undefined; regionRevision?: number | undefined; integrity?: number | undefined;
  attached?: boolean | undefined; fragment?: boolean | undefined; detached?: boolean | undefined;
}
export interface ArmorArtGeometry extends Omit<RegionGeometry, 'vertices' | 'polygons' | 'edges'> {
  vertices?: readonly ClipVertex[]; polygons: readonly (readonly ClipVertex[])[];
  edges: readonly { a: number; b: number }[]; artBevel?: number; artBevelEnds?: readonly [number, number];
}
export interface ArmorArtOptions { bevelRatio?: number; maxBevel?: number; joinGap?: number; cellSize?: number; posePrecision?: number;
  maxBucketEntries?: number; maxCellsPerPlate?: number; leftBevel?: number | undefined; rightBevel?: number | undefined }
interface Edge { a: Point; b: Point }
interface ArtShape { key: string; base: RegionGeometry; geometry: ArmorArtGeometry; edges: Edge[] }
interface ArtInput { id: string; source: ArmorSource; shape: ArtShape; pose: Pose; order: number }
interface PositionedEntry extends ArtInput { localPose: Pose }
interface WholeEntry extends IndexedEntry { polygon: Point[]; ends: Point[] }
interface IndexedEntry extends PositionedEntry { index: number; bounds?: GridBounds; outlinePolygons?: { polygon: Point[]; bounds: GridBounds }[] }
export interface ArmorArtPart { geometry: JointBuffers & Pick<ArmorArtGeometry, 'material' | 'revision'>; materialGeometry: RegionGeometry; shapeKey: string; edges: Edge[] }
interface ArtPlan { signature: string; poses: Pose[]; parts: Map<string, ArmorArtPart> }
export type ArmorArtSurface = { type: 'plate'; id: string; actorId?: string | undefined; geometry?: ArmorSource | undefined; data: ArmorSource; order?: number | undefined }
  | { type: 'module'; id: string };


const EPS = 1e-8;
const defaults = Object.freeze({ bevelRatio: .42, maxBevel: .055, joinGap: .015,
  cellSize: .5, posePrecision: 1e4, maxBucketEntries: 32, maxCellsPerPlate: 128 });
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const mix = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const rotate = (point: Point, pose: Pose) => ({ x: pose.x + point.x * Math.cos(pose.angle) - point.y * Math.sin(pose.angle),
  y: pose.y + point.x * Math.sin(pose.angle) + point.y * Math.cos(pose.angle) });
const unrotate = (point: Point, pose: Pose) => {
  const x = point.x - pose.x, y = point.y - pose.y, c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  return { x: x * c + y * s, y: -x * s + y * c };
};
const angle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));
const relativePose = (pose: Pose, reference: Pose) => ({ ...unrotate(pose, reference), angle: angle(pose.angle - reference.angle) });
const validPose = (pose: { x: number | undefined; y: number | undefined; angle: number } | null | undefined): pose is Pose => Boolean(pose && [pose.x, pose.y, pose.angle ?? 0].every(Number.isFinite));
const localEdges = (geometry: ArmorArtGeometry) => geometry.edges.map(edge => ({
  a: { x: geometry.positions[edge.a * 2]!, y: geometry.positions[edge.a * 2 + 1]! },
  b: { x: geometry.positions[edge.b * 2]!, y: geometry.positions[edge.b * 2 + 1]! },
}));
const boundsOf = (points: readonly Point[]): GridBounds => ({ minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) });
const touchesBounds = (a: GridBounds, b: GridBounds) => a.maxX >= b.minX - EPS && b.maxX >= a.minX - EPS && a.maxY >= b.minY - EPS && b.maxY >= a.minY - EPS;

function plateArtShapeKey(source: ArmorSource) {
  const p = source.definition || {}, regions = source.solidRegions || [], region = regions.length === 1 ? regions[0]! : null;
  // A design frame has no region revision: a mounting port that moves along
  // the plate keeps the same count of solid stretches, so their spans join the key.
  const spans = source.regionRevision === undefined && regions.length > 1 && regions.length <= 16
    ? regions.map(r => r.minX + ',' + r.maxX).join(';') : '';
  return ['armor-art-v1', source.shapeKey, source.revision, source.regionRevision,
    p.length, p.thicknessMm, source.integrity ?? 1, source.attached !== false,
    Boolean(source.fragment || source.detached), regions.length,
    region?.minX, region?.maxX, region?.minY, region?.maxY, spans].join(':');
}

function isWholePlate(source: ArmorSource, geometry: ArmorArtGeometry) {
  const p = source.definition, regions = source.solidRegions;
  if (!p || !Number.isFinite(p.length) || !Number.isFinite(p.thicknessMm) || p.length <= EPS || p.thicknessMm <= EPS ||
      source.attached === false || source.fragment || source.detached || (source.integrity ?? 1) < 1 - EPS ||
      regions?.length !== 1 || geometry.edges.length !== 4 || !geometry.indices.length) return false;
  const h = p.thicknessMm / 2000, l = p.length / 2, r = regions[0]!;
  if (Math.max(Math.abs(r.minX + l), Math.abs(r.maxX - l), Math.abs(r.minY + h), Math.abs(r.maxY - h)) > EPS) return false;
  let area = 0;
  for (const poly of geometry.polygons) for (let i = 1; i < poly.length - 1; i++) area += Math.abs(cross(poly[0]!, poly[i]!, poly[i + 1]!)) / 2;
  return Math.abs(area - p.length * h * 2) <= Math.max(EPS, p.length * h * 1e-6);
}

// This is a drawing mesh, never a substitute for regionGeometry in picking,
// collision, sensors, bounds or damage. Every new vertex lies inside the
// original rectangle and retains its original affine material coordinates.
export function beveledPlateGeometry(source: ArmorSource, base: ArmorArtGeometry = regionGeometry(source), options: ArmorArtOptions = {}): ArmorArtGeometry {
  if (!isWholePlate(source, base)) return base;
  const settings = { ...defaults, ...options }, p = source.definition, l = p.length / 2, h = p.thicknessMm / 2000,
    bevel = Math.max(0, Math.min(h * settings.bevelRatio, l * .04, settings.maxBevel));
  if (bevel <= EPS) return base;
  const left = options.leftBevel === 0 ? 0 : bevel, right = options.rightBevel === 0 ? 0 : bevel,
    outline: XY[] = [[-l + left, -h], [l - right, -h], [l, -h + right], [l, h - right],
      [l - right, h], [-l + left, h], [-l, h - left], [-l, -h + left]],
    corners = outline.filter((p, i) => i === 0 || Math.hypot(p[0]! - outline[i - 1]![0]!, p[1]! - outline[i - 1]![1]!) > EPS);
  if (Math.hypot(corners[0]![0]! - corners.at(-1)![0]!, corners[0]![1]! - corners.at(-1)![1]!) <= EPS) corners.pop();
  const polygon = corners.map(([x, y]) => ({ x, y, u: x / p.length + .5, v: .5 - y / (h * 2) }));
  return { positions: new Float32Array(corners.flat()), uvs: new Float32Array(polygon.flatMap(v => [v.u, v.v])),
    indices: new Uint32Array(Array.from({ length: polygon.length - 2 }, (_, i) => [0, i + 1, i + 2]).flat()),
    edges: polygon.map((_, i) => ({ a: i, b: (i + 1) % polygon.length })), polygons: [polygon],
    material: base.material, revision: base.revision, artBevel: bevel, artBevelEnds: [left, right] };
}

function clipInterval(a: Point, b: Point, polygon: readonly Point[]): [number, number] | null {
  let lo = 0, hi = 1;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!, start = cross(p, q, a), end = cross(p, q, b), delta = end - start;
    if (Math.abs(delta) <= EPS) { if (start < -EPS) return null; continue; }
    const t = -start / delta;
    if (delta > 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (hi - lo < EPS) return null;
  }
  return [Math.max(0, lo), Math.min(1, hi)];
}

function hiddenInterval(a: Point, b: Point, polygon: readonly Point[], order: string, neighborOrder: string) {
  const interval = clipInterval(a, b, polygon); if (!interval) return null;
  const middle = mix(a, b, (interval[0]! + interval[1]!) / 2);
  let boundary: [Point, Point] | undefined;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!, side = cross(p, q, middle);
    if (side < -EPS) return null;
    if (Math.abs(side) <= EPS) boundary = [p, q];
  }
  if (!boundary) return interval;
  const [p, q] = boundary, direction = (b.x - a.x) * (q.x - p.x) + (b.y - a.y) * (q.y - p.y);
  // Opposed coincident edges are an internal seam. Same-facing edges belong
  // to the exterior; retain one so overlapping plates cannot erase the hull.
  return direction < 0 || order > neighborOrder ? interval : null;
}

function subtract(intervals: readonly [number, number][], hidden: readonly [number, number]): [number, number][] {
  const [lo, hi] = hidden, result: [number, number][] = [];
  for (const [a, b] of intervals) {
    if (hi <= a + EPS || lo >= b - EPS) result.push([a, b]);
    else { if (lo > a + EPS) result.push([a, lo]); if (hi < b - EPS) result.push([hi, b]); }
  }
  return result;
}

function distanceToAxis(point: Point, entry: Pick<PositionedEntry, 'localPose' | 'source'>) {
  const local = unrotate(point, entry.localPose), l = entry.source.definition.length / 2;
  return Math.hypot(local.x - Math.max(-l, Math.min(l, local.x)), local.y);
}

// Cache joins in an actor/body coordinate frame. Rigid movement changes only
// the renderer's transforms, so worker snapshots with new objects do not cause
// clipping, neighbor searches or tessellation on each animation frame.
export class ArmorArtCache {
  declare options: Required<Pick<ArmorArtOptions, keyof typeof defaults>>; declare shapes: Map<string, ArtShape>; declare plans: Map<string, ArtPlan>;
  declare stats: { shapeBuilds: number; planBuilds: number; candidatePairs: number };
  constructor(options: ArmorArtOptions = {}) {
    this.options = { ...defaults, ...options }; this.shapes = new Map(); this.plans = new Map();
    this.stats = { shapeBuilds: 0, planBuilds: 0, candidatePairs: 0 };
  }
  clear() { this.shapes.clear(); this.plans.clear(); }
  // `unseen` names the actors nobody looks at: what was made for their plates is kept, and nothing is made anew.
  prepare(surfaces: readonly ArmorArtSurface[], poseFor: ((id: string) => (Point & { angle?: number }) | null | undefined) | null = null, unseen: ReadonlySet<string> | null = null) {
    const groups = new Map<string, PositionedEntry[]>(), used = new Set<string>(), result = new Map<string, ArmorArtPart>();
    for (const surface of surfaces) {
      if (surface.type !== 'plate') continue;
      const id = surface.id;
      if (unseen?.size && unseen.has(String(surface.actorId ?? (surface.geometry || surface.data).actorId ?? 'local'))) { used.add(id); continue; }
      const source = surface.geometry || surface.data, key = plateArtShapeKey(source);
      used.add(id); let shape = this.shapes.get(id);
      if (shape?.key !== key) {
        const base = regionGeometry(source), geometry = beveledPlateGeometry(source, base, this.options);
        shape = { key, base, geometry, edges: localEdges(geometry) }; this.shapes.set(id, shape); this.stats.shapeBuilds++;
      }
      const rawPose = poseFor ? poseFor(id) : source.definition, pose = rawPose && { x: rawPose.x, y: rawPose.y, angle: rawPose.angle || 0 },
        groupKey = String(surface.actorId ?? source.actorId ?? 'local');
      if (!validPose(pose)) { result.set(id, { geometry: shape.geometry, materialGeometry: shape.base, shapeKey: shape.key, edges: shape.edges }); continue; }
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      const group = groups.get(groupKey)!;
      group.push({ id, source, shape, pose, order: surface.order ?? 0, localPose: relativePose(pose, group[0]?.pose ?? pose) });
    }
    for (const id of this.shapes.keys()) if (!used.has(id)) this.shapes.delete(id);
    for (const key of this.plans.keys()) if (!groups.has(key) && !unseen?.has(key)) this.plans.delete(key);
    for (const [key, entries] of groups) {
      const tolerance = 1 / this.options.posePrecision;
      const signature = JSON.stringify(entries.map(e => [e.id, e.shape.key, e.order, e.source.definition?.anchors?.map(a => [a.u, a.v])]));
      let plan = this.plans.get(key);
      const previous = plan;
      const samePose = previous?.signature === signature && entries.every((e, i) => {
        const before = previous.poses[i]!, current = e.localPose;
        return Math.hypot(current.x - before.x, current.y - before.y) <= tolerance &&
          Math.abs(angle(current.angle - before.angle)) <= tolerance / Math.max(1, e.source.definition.length);
      });
      if (!samePose) {
        plan = { signature, poses: entries.map(e => ({ ...e.localPose })), parts: this.buildPlan(entries) };
        this.plans.set(key, plan); this.stats.planBuilds++;
      }
      for (const [id, part] of plan!.parts) result.set(id, part);
    }
    return result;
  }
  buildPlan(input: readonly PositionedEntry[]): Map<string, ArmorArtPart> {
    const entries: IndexedEntry[] = input.map((entry, index) => Object.assign(entry, { index }));
    const options = this.options, grid = new Map<string, WholeEntry[]>(), neighbors = new Map<string, IndexedEntry[]>(), straightEnds = new Map<string, [boolean, boolean]>(),
      whole = entries.filter(e => e.shape.geometry.artBevel).map(entry => Object.assign(entry, {
        polygon: Array.from({ length: entry.shape.geometry.positions.length / 2 }, (_, i) =>
          rotate({ x: entry.shape.geometry.positions[i * 2]!, y: entry.shape.geometry.positions[i * 2 + 1]! }, entry.localPose)),
        ends: [-1, 1].map(sign => rotate({ x: sign * entry.source.definition.length / 2, y: 0 }, entry.localPose)),
      })),
      padding = Math.min(.25, Math.max(0, ...whole.map(e => e.source.definition.thicknessMm / 2000)) + options.joinGap),
      cell = (p: Point): [number, number] => [Math.floor(p.x / options.cellSize), Math.floor(p.y / options.cellSize)], key = (x: number, y: number) => x + ':' + y;
    for (const entry of whole) {
      const xs = entry.polygon.map(p => p.x), ys = entry.polygon.map(p => p.y),
        [x0, y0] = cell({ x: Math.min(...xs) - padding, y: Math.min(...ys) - padding }),
        [x1, y1] = cell({ x: Math.max(...xs) + padding, y: Math.max(...ys) + padding }), cells: [number, number][] = [];
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= options.maxCellsPerPlate) {
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push([x, y]);
      } else for (const point of entry.ends) cells.push(cell(point));
      for (const [x, y] of cells) {
        const bucketKey = key(x, y); if (!grid.has(bucketKey)) grid.set(bucketKey, []);
        const bucket = grid.get(bucketKey)!; if (bucket.length < options.maxBucketEntries) bucket.push(entry);
      }
    }
    const tested = new Set();
    for (const entry of whole) for (const endpoint of entry.ends) {
      const [x, y] = cell(endpoint);
      for (const neighbor of grid.get(key(x, y)) || []) {
        if (entry === neighbor) continue;
        const pair = [Math.min(entry.index, neighbor.index), Math.max(entry.index, neighbor.index)].join(':');
        if (tested.has(pair)) continue;
        tested.add(pair); this.stats.candidatePairs++;
        const distance = Math.min(...entry.ends.map(p => distanceToAxis(p, neighbor)), ...neighbor.ends.map(p => distanceToAxis(p, entry))),
          threshold = (entry.source.definition.thicknessMm + neighbor.source.definition.thicknessMm) / 2000 + options.joinGap;
        if (distance > threshold) continue;
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
          const ea = entry.ends[a]!, eb = neighbor.ends[b]!, endpointDistance = Math.hypot(ea.x - eb.x, ea.y - eb.y),
            facing = Math.cos(entry.localPose.angle - neighbor.localPose.angle) * (a ? 1 : -1) * (b ? 1 : -1);
          if (endpointDistance > EPS || facing > -.999999) continue;
          for (const [part, end] of [[entry, a] as const, [neighbor, b] as const]) {
            if (!straightEnds.has(part.id)) straightEnds.set(part.id, [false, false]);
            straightEnds.get(part.id)![end]! = true;
          }
        }
        for (const [a, b] of [[entry, neighbor] as const, [neighbor, entry] as const]) {
          if (!neighbors.has(a.id)) neighbors.set(a.id, []);
          neighbors.get(a.id)!.push(b);
        }
      }
    }
    const planned = entries.map(entry => {
      const straight = straightEnds.get(entry.id);
      const artGeometry = straight ? beveledPlateGeometry(entry.source, entry.shape.base,
        { ...options, leftBevel: straight[0]! ? 0 : undefined, rightBevel: straight[1]! ? 0 : undefined }) : entry.shape.geometry;
      const artEdges = straight ? localEdges(artGeometry) : entry.shape.edges;
      const artKey = entry.shape.key + (straight ? ':straight:' + straight.join(':') : '');
      const polygons = artGeometry.polygons.map(polygon => polygon.map(p => rotate({ x: Math.fround(p.x), y: Math.fround(p.y) }, entry.localPose)));
      return Object.assign(entry, { artGeometry, artEdges, artKey, polygons });
    });
    const joints = partitionArmorJoints(planned);
    for (const entry of planned) {
      entry.bounds = boundsOf(entry.polygons.flat());
      entry.outlinePolygons = entry.polygons.map(polygon => ({ polygon, bounds: boundsOf(polygon) }));
    }
    const parts = new Map<string, ArmorArtPart>();
    for (const entry of planned) {
      const joint = joints.get(entry.id), adjacent = [...new Set([...(neighbors.get(entry.id) || []), ...(joint?.neighbors || [])])], edges = [],
        geometry = joint?.geometry || entry.artGeometry, shapeKey = entry.artKey + (joint?.key || '');
      if (!adjacent.length) { parts.set(entry.id, { geometry, materialGeometry: entry.shape.base, shapeKey, edges: entry.artEdges }); continue; }
      for (const edge of entry.artEdges) {
        const a = rotate(edge.a, entry.localPose), b = rotate(edge.b, entry.localPose), bounds = boundsOf([a, b]); let visible: [number, number][] = [[0, 1]];
        for (const neighbor of adjacent) {
          if (!touchesBounds(bounds, neighbor.bounds!)) continue;
          for (const candidate of neighbor.outlinePolygons!) {
            if (!touchesBounds(bounds, candidate.bounds)) continue;
            const hidden = hiddenInterval(a, b, candidate.polygon, entry.id, neighbor.id);
            if (hidden) visible = subtract(visible, hidden);
          }
        }
        for (const [start, end] of visible) edges.push({ a: unrotate(mix(a, b, start), entry.localPose), b: unrotate(mix(a, b, end), entry.localPose) });
      }
      parts.set(entry.id, { geometry, materialGeometry: entry.shape.base, shapeKey, edges });
    }
    return parts;
  }
}
