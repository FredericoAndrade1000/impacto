import type { LocalPoint, Point, Pose } from './math.ts';
import type { GridBounds } from './armor-grid.ts';

export interface JointBuffers {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  edges: readonly { a: number; b: number }[];
  polygons: readonly (readonly Point[])[];
  artJoint?: boolean;
}
interface JointDefinition { length: number; thicknessMm: number; anchors?: readonly LocalPoint[] | undefined }
export interface ArmorJointEntry<G extends JointBuffers = JointBuffers> {
  id: string;
  source: { definition?: JointDefinition | undefined; attached?: boolean | undefined; detached?: boolean | undefined; fragment?: boolean | undefined };
  localPose: Pose;
  polygons: Point[][];
  bounds?: GridBounds;
  artGeometry: G;
}
type RebuiltGeometry<G extends JointBuffers> = Omit<G, keyof JointBuffers> & JointBuffers & { artJoint: true };
export interface ArmorJointResult<E extends ArmorJointEntry> {
  geometry: E['artGeometry'] | RebuiltGeometry<E['artGeometry']>;
  neighbors: E[];
  key: string;
}
interface JointMember<E extends ArmorJointEntry> { entry: E; point: Point; away: Point; half: number; continuous: boolean }
interface Participant<E extends ArmorJointEntry> {
  entry: E;
  masks: Point[][];
  neighbors: Set<E>;
  joints: Set<string>;
  polygons: Point[][];
  changed: boolean;
  removed: Point[][];
}
type Side = [Point, Point];
interface AlongPoint { t: number; point: Point }

// The physical plates overlap at their joints. Their visible faces share that
// overlap locally, rather than letting the order of the draw calls choose it.
const EPS = 1e-8;
const cross = (a: Point, b: Point, p: Point): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const area = (polygon: readonly Point[]): number => Math.abs(polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]!; return sum + a.x * b.y - a.y * b.x; }, 0)) / 2;
const boxes = new WeakMap<readonly Point[], GridBounds>();
const bounds = (polygon: readonly Point[]): GridBounds => {
  let box = boxes.get(polygon);
  if (!box) { box = { minX: Math.min(...polygon.map(p => p.x)), maxX: Math.max(...polygon.map(p => p.x)), minY: Math.min(...polygon.map(p => p.y)), maxY: Math.max(...polygon.map(p => p.y)) }; boxes.set(polygon, box); }
  return box;
};
const overlaps = (a: GridBounds, b: GridBounds): boolean => a.maxX > b.minX + EPS && b.maxX > a.minX + EPS && a.maxY > b.minY + EPS && b.maxY > a.minY + EPS;
function compact(polygon: readonly Point[]): Point[] {
  const clean: Point[] = [];
  for (const point of polygon) if (!clean.length || Math.hypot(point.x - clean.at(-1)!.x, point.y - clean.at(-1)!.y) > EPS) clean.push(point);
  if (clean.length > 1 && Math.hypot(clean[0]!.x - clean.at(-1)!.x, clean[0]!.y - clean.at(-1)!.y) <= EPS) clean.pop();
  for (let i = clean.length - 1; i >= 0 && clean.length > 2; i--) if (Math.abs(cross(clean[(i + clean.length - 1) % clean.length]!, clean[i]!, clean[(i + 1) % clean.length]!)) < EPS) clean.splice(i, 1);
  return clean.length > 2 && area(clean) > EPS ? clean : [];
}
const moved = (point: Point, pose: Pose, back = false): Point => {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle), x = point.x - (back ? pose.x : 0), y = point.y - (back ? pose.y : 0);
  return back ? { x: x * c + y * s, y: -x * s + y * c } : { x: pose.x + x * c - y * s, y: pose.y + x * s + y * c };
};
function clip(polygon: readonly Point[], side: (point: Point) => number): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, da = side(a), db = side(b);
    if (da >= 0) result.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return compact(result);
}
// Subtract a convex mask as disjoint convex pieces. Each mask is an existing
// material polygon, so a hole or a mounting port can never become a cover.
function subtract(polygon: Point[], mask: readonly Point[]): Point[][] {
  if (!overlaps(bounds(polygon), bounds(mask))) return [polygon];
  let intersection = polygon;
  for (let i = 0; i < mask.length && intersection.length; i++) intersection = clip(intersection, p => cross(mask[i]!, mask[(i + 1) % mask.length]!, p));
  if (!intersection.length) return [polygon];
  const result: Point[][] = []; let rest = polygon;
  for (let i = 0; i < mask.length && rest.length; i++) {
    const side = (p: Point) => cross(mask[i]!, mask[(i + 1) % mask.length]!, p), outside = clip(rest, p => -side(p));
    if (outside.length) result.push(outside);
    rest = clip(rest, side);
  }
  return result;
}
// The outline of convex pieces that tile one face: the stretches of their sides that no other piece has
// against them. A side cut where two pieces meet is no edge of the face; it ends at corners of the pieces.
const SEAM = 1e-5;
function outline(polygons: readonly (readonly Point[])[]): Side[] {
  const sides = polygons.flatMap(polygon => polygon.map((a, i): Side => [a, polygon[(i + 1) % polygon.length]!])), result: Side[] = [];
  for (const [a, b] of sides) {
    const length = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / length, uy = (b.y - a.y) / length,
      along = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy, off = (p: Point) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
    let open: [AlongPoint, AlongPoint][] = [[{ t: 0, point: a }, { t: length, point: b }]];
    for (const [c, d] of sides) {
      const from = along(d), to = along(c);
      if (from >= to || off(c) > SEAM || off(d) > SEAM) continue;
      open = open.flatMap(([start, end]): [AlongPoint, AlongPoint][] => {
        if (to <= start.t + SEAM || from >= end.t - SEAM) return [[start, end]];
        const remaining: [AlongPoint, AlongPoint][] = [];
        if (from > start.t + SEAM) remaining.push([start, { t: from, point: d }]);
        if (to < end.t - SEAM) remaining.push([{ t: to, point: c }, end]);
        return remaining;
      });
    }
    for (const [start, end] of open) result.push([start.point, end.point]);
  }
  return result;
}
function geometryOf<G extends JointBuffers>(polygons: readonly (readonly Point[])[], entry: ArmorJointEntry<G>): RebuiltGeometry<G> {
  const definition = entry.source.definition!, points: Point[] = [], indices: number[] = [], local: Point[][] = [];
  for (const polygon of polygons) {
    const clean = compact(polygon.map(p => { const q = moved(p, entry.localPose, true); return { x: Math.fround(q.x), y: Math.fround(q.y) }; }));
    if (clean.length) local.push(clean);
  }
  for (const polygon of local) {
    const start = points.length; points.push(...polygon);
    for (let i = 1; i < polygon.length - 1; i++) indices.push(start, start + i, start + i + 1);
  }
  const index = new Map(points.map((point, i) => [point, i])), edges = outline(local).map(([a, b]) => ({ a: index.get(a)!, b: index.get(b)! }));
  return { ...entry.artGeometry, positions: new Float32Array(points.flatMap(p => [p.x, p.y])),
    uvs: new Float32Array(points.flatMap(p => [p.x / definition.length + .5, .5 - p.y * 1000 / definition.thicknessMm])),
    indices: new Uint32Array(indices), edges, polygons: local, artJoint: true };
}

export function partitionArmorJoints<E extends ArmorJointEntry>(entries: readonly E[]): Map<string, ArmorJointResult<E>> {
  const groups = new Map<string, JointMember<E>[]>(), participants = new Map<string, Participant<E>>(), result = new Map<string, ArmorJointResult<E>>();
  for (const entry of entries) {
    if (!entry.source.definition || entry.source.attached === false || entry.source.detached || entry.source.fragment) continue;
    entry.polygons = entry.polygons.map(compact).filter(polygon => polygon.length);
    entry.bounds = bounds(entry.polygons.flat());
    const definition = entry.source.definition, anchors = definition.anchors?.length === 2 ? definition.anchors : [{ u: -.5, v: 0 }, { u: .5, v: 0 }],
      ends = anchors.map(a => moved({ x: a.u * definition.length, y: a.v * definition.thicknessMm / 1000 }, entry.localPose));
    for (let i = 0; i < 2; i++) {
      const point = ends[i]!, opposite = ends[1 - i]!, length = Math.hypot(opposite.x - point.x, opposite.y - point.y);
      if (length < EPS) continue;
      const key = [point.x, point.y].map(n => Math.round(n * 1e6)).join(':');
      let group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push({ entry, point, away: { x: (opposite.x - point.x) / length, y: (opposite.y - point.y) / length }, half: definition.thicknessMm / 2000, continuous: false });
    }
    participants.set(entry.id, { entry, masks: [], neighbors: new Set(), joints: new Set(), polygons: entry.polygons, changed: false, removed: [] });
  }
  for (const [joint, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    members.sort((a, b) => a.entry.id.localeCompare(b.entry.id));
    for (const member of members) member.continuous = members.some(other => other !== member && member.away.x * other.away.x + member.away.y * other.away.y < -.999999);
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!, b = members[j]!; if (a.entry === b.entry) continue;
      const normal = { x: a.away.x * a.half - b.away.x * b.half, y: a.away.y * a.half - b.away.y * b.half },
        point = { x: (a.point.x + b.point.x) / 2, y: (a.point.y + b.point.y) / 2 }, tie = Math.hypot(normal.x, normal.y) < EPS;
      // A continuing wall owns the overlap with a branch that ends on it.
      // Other joints share it along a thickness-weighted local bisector.
      const pairings: [JointMember<E>, JointMember<E>, number][] = [[a, b, 1], [b, a, -1]];
      for (const [own, other, sign] of pairings) {
        const participant = participants.get(own.entry.id)!; participant.neighbors.add(other.entry); participant.joints.add(joint);
        if ((own.continuous !== other.continuous && own.continuous) || (tie && own === a)) continue;
        for (const polygon of other.entry.polygons) {
          if (!overlaps(own.entry.bounds!, bounds(polygon))) continue;
          const mask = own.continuous !== other.continuous || tie ? polygon : clip(polygon, p => -sign * ((p.x - point.x) * normal.x + (p.y - point.y) * normal.y));
          if (mask.length) participant.masks.push(mask);
        }
      }
    }
  }
  for (const participant of participants.values()) {
    const { entry, masks } = participant;
    let polygons = entry.polygons, changed = false;
    for (const mask of masks) {
      const next = polygons.flatMap(polygon => subtract(polygon, mask));
      changed ||= next.length !== polygons.length || next.some((polygon, i) => polygon !== polygons[i]); polygons = next;
      if (!polygons.length) break;
    }
    const retained = new Set(polygons);
    Object.assign(participant, { polygons, changed, removed: changed ? entry.polygons.filter(polygon => !retained.has(polygon)) : [] });
  }
  // Very thick corners at different joints can overlap each other in a cycle.
  // Keep the original union: any face left unclaimed belongs to the first real
  // plate containing it, by stable identity. This never uses a hole's envelope.
  const visited = new Set<Participant<E>>();
  for (const first of participants.values()) {
    if (visited.has(first)) continue;
    const component: Participant<E>[] = [], pending = [first], joints = new Set<string>();
    while (pending.length) {
      const part = pending.pop()!; if (visited.has(part)) continue;
      visited.add(part); component.push(part); part.joints.forEach(joint => joints.add(joint));
      for (const neighbor of part.neighbors) pending.push(participants.get(neighbor.id)!);
    }
    if (component.length < 3 || joints.size < 2 || !component.some(part => part.changed)) continue;
    component.sort((a, b) => a.entry.id.localeCompare(b.entry.id));
    for (const part of component) for (const original of part.removed) {
      let unclaimed = [original];
      for (const owner of component) {
        if (!overlaps(bounds(original), owner.entry.bounds!)) continue;
        for (const polygon of owner.polygons) {
          unclaimed = unclaimed.flatMap(piece => subtract(piece, polygon));
          if (!unclaimed.length) break;
        }
        if (!unclaimed.length) break;
      }
      if (unclaimed.length) { part.polygons = [...part.polygons, ...unclaimed]; part.changed = true; }
    }
  }
  for (const { entry, polygons, changed, neighbors } of participants.values()) {
    const geometry = changed ? geometryOf<E['artGeometry']>(polygons, entry) : entry.artGeometry;
    result.set(entry.id, { geometry, neighbors: [...neighbors], key: changed ? ':joint:' + geometry.positions.join(',') : '' });
  }
  return result;
}
