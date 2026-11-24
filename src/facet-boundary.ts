import type { Point } from './math.ts';

// Boundary of non-overlapping convex facets joined along complete edges.
// Kept as point references: moving the facets moves the boundary with them.
// Counter-clockwise edges put their outward normal on the right-hand side.
export function facetBoundary<P extends Point>(polygons: readonly (readonly P[])[]): [P, P][] {
  const edges = new Map<string, [P, P]>(), key = (point: Point) => `${Math.round(point.x * 1e9)},${Math.round(point.y * 1e9)}`;
  for (const poly of polygons) {
    let area = 0;
    for (let i = 1; i < poly.length - 1; i++) area += (poly[i]!.x - poly[0]!.x) * (poly[i + 1]!.y - poly[0]!.y) -
      (poly[i]!.y - poly[0]!.y) * (poly[i + 1]!.x - poly[0]!.x);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[area >= 0 ? i : (i + 1) % poly.length]!, b = poly[area >= 0 ? (i + 1) % poly.length : i]!,
        ka = key(a), kb = key(b), id = ka < kb ? ka + ':' + kb : kb + ':' + ka;
      if (edges.has(id)) edges.delete(id); else edges.set(id, [a, b]);
    }
  }
  return [...edges.values()];
}
