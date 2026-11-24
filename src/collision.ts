import { segmentConvex } from './math.ts';
import type { Point, ConvexIntersection } from './math.ts';
import { facetBoundary } from './facet-boundary.ts';
import { weaponMaterialRole } from './weapon-geometry.ts';
import type { WeaponMountGeometry } from './weapon-geometry.ts';

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface CollisionOwner {
  type: string; id: string;
  object?: { id?: string | undefined; kind?: string | undefined; weaponMount?: WeaponMountGeometry | null | undefined } | undefined;
}
interface EntryDraft<Owner extends CollisionOwner> { owner: Owner; vertices: readonly Point[]; order: number }
export interface CollisionEntry<Owner extends CollisionOwner = CollisionOwner> extends EntryDraft<Owner>, Bounds {}
interface GroupDraft<Owner extends CollisionOwner> {
  entries: EntryDraft<Owner>[];
  normalEdges?: readonly (readonly [Point, Point])[];
}
export interface CollisionGroup<Owner extends CollisionOwner = CollisionOwner> extends GroupDraft<Owner>, Bounds {
  entries: CollisionEntry<Owner>[];
}
type Hierarchy<Owner extends CollisionOwner> = Bounds & (
  { groups: CollisionGroup<Owner>[]; left?: never; right?: never } |
  { groups?: never; left: Hierarchy<Owner>; right: Hierarchy<Owner> }
);
export interface RaycastOptions { ignoreIds?: ReadonlySet<string | undefined>; completeExit?: boolean; projectile?: boolean }
export interface CollisionHit<Owner extends CollisionOwner = CollisionOwner> extends ConvexIntersection, Point {
  owner: Owner; exitX: number; exitY: number; depth: number;
}

const overlaps = (entry: Bounds, box: Bounds): boolean => entry.maxX >= box.minX && entry.minX <= box.maxX &&
  entry.maxY >= box.minY && entry.minY <= box.maxY;
function bounds(items: readonly Bounds[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.minX); minY = Math.min(minY, item.minY);
    maxX = Math.max(maxX, item.maxX); maxY = Math.max(maxY, item.maxY);
  }
  return { minX, minY, maxX, maxY };
}
function refitGroup<Owner extends CollisionOwner>(group: GroupDraft<Owner>): asserts group is CollisionGroup<Owner> {
  let groupMinX = Infinity, groupMinY = Infinity, groupMaxX = -Infinity, groupMaxY = -Infinity;
  for (const entry of group.entries) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of entry.vertices) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    Object.assign(entry, { minX, minY, maxX, maxY });
    groupMinX = Math.min(groupMinX, minX); groupMinY = Math.min(groupMinY, minY);
    groupMaxX = Math.max(groupMaxX, maxX); groupMaxY = Math.max(groupMaxY, maxY);
  }
  Object.assign(group, { minX: groupMinX, minY: groupMinY, maxX: groupMaxX, maxY: groupMaxY });
}
function hierarchy<Owner extends CollisionOwner>(groups: CollisionGroup<Owner>[]): Hierarchy<Owner> | null {
  if (!groups.length) return null;
  const node = bounds(groups);
  if (groups.length <= 4) return Object.assign(node, { groups });
  const axis = node.maxX - node.minX >= node.maxY - node.minY ? 'X' : 'Y',
    min = axis === 'X' ? 'minX' : 'minY', max = axis === 'X' ? 'maxX' : 'maxY';
  groups.sort((a, b) => a[min] + a[max] - b[min] - b[max]);
  const middle = groups.length >> 1;
  return Object.assign(node, { left: hierarchy(groups.slice(0, middle))!, right: hierarchy(groups.slice(middle))! });
}
function refit<Owner extends CollisionOwner>(node: Hierarchy<Owner>): Hierarchy<Owner> {
  Object.assign(node, bounds(node.groups || [refit(node.left), refit(node.right)]));
  return node;
}
function interval(entries: readonly CollisionEntry[], start: Point, end: Point): ConvexIntersection | null {
  const hits = entries.map(entry => segmentConvex(start, end, entry.vertices))
    .filter((hit): hit is ConvexIntersection => hit !== null && hit.exit - hit.enter > 1e-10).sort((a, b) => a.enter - b.enter);
  if (!hits.length) return null;
  const first = hits[0]!;
  for (let i = 1; i < hits.length; i++) {
    const hit = hits[i]!;
    if (hit.enter > first.exit + 1e-6) break;
    first.exit = Math.max(first.exit, hit.exit);
  }
  return first;
}

// At a shared vertex, convex clipping may name a radial seam as the entering
// face. Only an exposed metal edge supplies a surface normal for the forecast.
function exposedNormal(hit: ConvexIntersection, edges: readonly (readonly [Point, Point])[], start: Point, end: Point): ConvexIntersection {
  const dx = end.x - start.x, dy = end.y - start.y,
    x = start.x + dx * hit.enter, y = start.y + dy * hit.enter;
  let best = 0;
  for (const [a, b] of edges) {
    const ex = b.x - a.x, ey = b.y - a.y, size = Math.hypot(ex, ey);
    if (size < 1e-12) continue;
    const along = ((x - a.x) * ex + (y - a.y) * ey) / (size * size),
      across = Math.abs(ex * (y - a.y) - ey * (x - a.x)) / size;
    if (across > 1e-7 || along < -1e-7 || along > 1 + 1e-7) continue;
    const nx = ey / size, ny = -ex / size, opposition = -(nx * dx + ny * dy);
    if (opposition > best) { best = opposition; hit.nx = nx; hit.ny = ny; }
  }
  return hit;
}

// A static view of immutable scene snapshots. Rust owns all live collisions;
// this index only answers the ballistic preview shown by the renderer.
export class CollisionIndex<Owner extends CollisionOwner = CollisionOwner> {
  declare entries: CollisionEntry<Owner>[];
  declare ownerEntries: Map<string, CollisionEntry<Owner>[]>;
  declare groups: Map<string, CollisionGroup<Owner>>;
  declare root: Hierarchy<Owner> | null;
  declare hierarchyDirty?: boolean;
  declare groupOrder?: CollisionGroup<Owner>[];

  constructor() {
    this.entries = []; this.ownerEntries = new Map(); this.groups = new Map(); this.root = null;
  }
  clear(): void { this.entries.length = 0; this.ownerEntries.clear(); this.groups.clear(); }
  add(owner: Owner, vertices: readonly Point[]): CollisionEntry<Owner> {
    const key = `${owner.type}:${owner.id}`, entry = { owner, vertices, order: this.entries.length },
      previous = this.groups.get(key), group: GroupDraft<Owner> = previous || { entries: [] };
    group.entries.push(entry); refitGroup(group);
    if (!previous) { this.groups.set(key, group); this.ownerEntries.set(key, group.entries); }
    // refitGroup gave the same entry its bounds before it enters the query index.
    const bounded = group.entries[group.entries.length - 1]!;
    this.entries.push(bounded); this.hierarchyDirty = true;
    return bounded;
  }
  include(owner: Owner, polygons: readonly (readonly Point[])[], previous: CollisionGroup<Owner> | null = null): CollisionGroup<Owner> | null {
    if (!previous) {
      for (const polygon of polygons) this.add(owner, polygon);
      const group = this.groups.get(`${owner.type}:${owner.id}`) || null;
      if (group && owner.object?.kind === 'weapon' && owner.object.weaponMount && !owner.object.weaponMount.exposed)
        // Fixed feet retain their own planar normals; only mask facets join.
        group.normalEdges = facetBoundary(polygons.filter((_, i) => weaponMaterialRole(false, i, true) === 'shield'));
      return group;
    }
    const key = `${owner.type}:${owner.id}`;
    this.groups.set(key, previous); this.ownerEntries.set(key, previous.entries);
    for (const entry of previous.entries) { entry.order = this.entries.length; this.entries.push(entry); }
    refitGroup(previous); this.hierarchyDirty = true;
    return previous;
  }
  refreshHierarchy(): void {
    const groups = [...this.groups.values()];
    if (this.root && this.groupOrder?.length === groups.length && groups.every((group, i) => group === this.groupOrder![i])) refit(this.root);
    else { this.groupOrder = groups; this.root = hierarchy([...groups]); }
    this.hierarchyDirty = false;
  }
  query(box: Bounds): CollisionEntry<Owner>[] {
    if (this.hierarchyDirty) this.refreshHierarchy();
    const entries: CollisionEntry<Owner>[] = [], stack = this.root ? [this.root] : [];
    while (stack.length) {
      const node = stack.pop()!;
      if (!overlaps(node, box)) continue;
      if (node.groups) {
        for (const group of node.groups) if (overlaps(group, box))
          for (const entry of group.entries) if (overlaps(entry, box)) entries.push(entry);
      } else stack.push(node.right, node.left);
    }
    return entries.sort((a, b) => a.order - b.order);
  }
  raycast(start: Point, end: Point, options: RaycastOptions = {}): CollisionHit<Owner> | null {
    const entries = this.query({ minX: Math.min(start.x, end.x) - 1e-5, minY: Math.min(start.y, end.y) - 1e-5,
      maxX: Math.max(start.x, end.x) + 1e-5, maxY: Math.max(start.y, end.y) + 1e-5 }), groups = new Map<Owner, CollisionEntry<Owner>[]>();
    for (const entry of entries) {
      const owner = entry.owner;
      if (options.ignoreIds?.has(owner.id)) continue;
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner)!.push(entry);
    }
    let first: (ConvexIntersection & { owner: Owner }) | null = null;
    for (const [owner, material] of groups) {
      const hit = interval(material, start, end);
      const edges = this.groups.get(`${owner.type}:${owner.id}`)?.normalEdges;
      if (hit && edges) exposedNormal(hit, edges, start, end);
      if (hit && (!first || hit.enter < first.enter)) first = { ...hit, owner };
    }
    if (!first) return null;
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
    if (options.completeExit && first.exit >= 1 - 1e-8 && length > 1e-10) {
      const material = this.ownerEntries.get(`${first.owner.type}:${first.owner.id}`)!, ux = dx / length, uy = dy / length;
      let reach = length;
      for (const entry of material) reach = Math.max(reach,
        ((ux >= 0 ? entry.maxX : entry.minX) - start.x) * ux +
        ((uy >= 0 ? entry.maxY : entry.minY) - start.y) * uy + .006);
      const extended = interval(material, start, { x: start.x + ux * reach, y: start.y + uy * reach });
      if (extended) first.exit = extended.exit * reach / length;
    }
    return { ...first, x: start.x + dx * first.enter, y: start.y + dy * first.enter,
      exitX: start.x + dx * first.exit, exitY: start.y + dy * first.exit, depth: length * (first.exit - first.enter) };
  }
}
