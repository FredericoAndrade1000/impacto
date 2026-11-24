import type { Point } from './math.ts';
import type { GridBounds } from './armor-grid.ts';

// Intersections retain the numeric texture/velocity channels supported by the material projection.
export interface ClipVertex extends Point { u?: number; v?: number; vx?: number; vy?: number }
export interface PolygonProperties { area: number; x: number; y: number; second: number }

// Damage is a bounded set of remaining material regions. The rigid outline
// never acquires vertices from a hit. Ballistics and presentation both clip
// that same outline against these regions; a visible opening is a real one.
const EPS = 1e-12;

function clipRegion(polygon: ClipVertex[], box: GridBounds): ClipVertex[] {
  let points = polygon;
  const sides: ['x' | 'y', number, number][] = [['x', box.minX, 1], ['x', box.maxX, -1], ['y', box.minY, 1], ['y', box.maxY, -1]];
  for (const [axis, edge, sign] of sides) {
    const next: ClipVertex[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!,
        da = sign * (a[axis] - edge), db = sign * (b[axis] - edge);
      if (da >= -EPS) next.push(a);
      if ((da >= -EPS) !== (db >= -EPS)) {
        const t = da / (da - db), p: ClipVertex = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        for (const key of ['u', 'v', 'vx', 'vy'] satisfies (keyof ClipVertex)[]) {
          const from = a[key], to = b[key];
          if (typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to)) p[key] = from + (to - from) * t;
        }
        p[axis] = edge; next.push(p);
      }
    }
    points = next;
    if (points.length < 3) return [];
  }
  return points;
}

export function polygonProperties(points: readonly Point[]): PolygonProperties {
  let area = 0, x = 0, y = 0, second = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[0]!, b = points[i]!, c = points[i + 1]!,
      m = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    area += m; x += m * (a.x + b.x + c.x) / 3; y += m * (a.y + b.y + c.y) / 3;
    second += m / 6 * (a.x*a.x + b.x*b.x + c.x*c.x + a.x*b.x + b.x*c.x + c.x*a.x +
      a.y*a.y + b.y*b.y + c.y*c.y + a.y*b.y + b.y*c.y + c.y*a.y);
  }
  return { area, x: area ? x / area : 0, y: area ? y / area : 0, second };
}

export function regionPolygons(nodes: readonly ClipVertex[], indices: ArrayLike<number>, regions: readonly GridBounds[]): ClipVertex[][] {
  const polygons: ClipVertex[][] = [];
  for (const region of regions) for (let i = 0; i < indices.length; i += 3) {
    const polygon = clipRegion([nodes[indices[i]!]!, nodes[indices[i+1]!]!, nodes[indices[i+2]!]!], region);
    if (polygon.length >= 3 && polygonProperties(polygon).area > EPS) polygons.push(polygon);
  }
  return polygons;
}

export class DamageRegions {
  nodes: readonly ClipVertex[];
  indices: ArrayLike<number>;
  bounds: GridBounds;
  regions: GridBounds[];
  // refresh() establishes these properties before construction returns.
  properties!: PolygonProperties;
  originalArea: number;
  constructor(nodes: readonly ClipVertex[], indices: ArrayLike<number>) {
    this.nodes = nodes; this.indices = indices;
    this.bounds = { minX: Math.min(...nodes.map(p => p.x)), minY: Math.min(...nodes.map(p => p.y)),
      maxX: Math.max(...nodes.map(p => p.x)), maxY: Math.max(...nodes.map(p => p.y)) };
    this.regions = [{ ...this.bounds }];
    this.refresh(); this.originalArea = this.properties.area;
  }
  polygons(region?: GridBounds): ClipVertex[][] { return regionPolygons(this.nodes, this.indices, region ? [region] : this.regions); }
  refresh(): void {
    let area = 0, x = 0, y = 0, second = 0;
    for (const polygon of this.polygons()) {
      const p = polygonProperties(polygon); area += p.area; x += p.x*p.area; y += p.y*p.area; second += p.second;
    }
    this.properties = { area, x: area ? x/area : 0, y: area ? y/area : 0, second };
  }
}
