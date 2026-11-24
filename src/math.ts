export interface Point { x: number; y: number }
export interface Pose extends Point { angle: number }
export interface Basis { c: number; s: number }
export interface LocalPoint { u: number; v: number }
export interface PlateGeometry extends Pose { thicknessMm: number; length: number }
export interface SegmentPoint extends Point { t: number }
export interface ConvexIntersection { enter: number; exit: number; nx: number; ny: number }

export const TAU = Math.PI * 2;
export const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;
// An angle as the same one between -π and π, and the turn from `b` to `a` the short way round.
export const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
export const angleDifference = (a: number, b: number): number => wrapAngle(a - b);
// A step eased at both ends, from 0 at or below 0 to 1 at or above 1.
export const smoothstep = (x: number): number => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
// Noise along a line, from 0 to 1: a value at each whole number, the same for the same `seed` and `channel`,
// eased between them. With a `period` the values come round again after that many.
export function lineNoise(seed: number, channel: number, x: number, period = 0): number {
  const value = (cell: number): number => {
    if (period) cell = ((cell % period) + period) % period;
    let h = Math.imul(cell, 374761393) ^ Math.imul(seed + channel * 101, 668265263);
    h = Math.imul(h ^ h >>> 13, 1274126177);
    return ((h ^ h >>> 16) >>> 0) / 4294967295;
  };
  const cell = Math.floor(x);
  return lerp(value(cell), value(cell + 1), smoothstep(x - cell));
}

export class Random {
  declare state: number;
  constructor(seed = 6173) { this.state = seed >>> 0 || 1; }
  next() {
    let t = this.state += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  normal() { return Math.sqrt(-2 * Math.log(Math.max(1e-9, this.next()))) * Math.cos(TAU * this.next()); }
}

export const rotationBasis = (angle: number): Basis => ({ c: Math.cos(angle), s: Math.sin(angle) });
export function localToWorld(plate: Pose, u: number, v: number, basis?: Basis): Point {
  const c = basis ? basis.c : Math.cos(plate.angle), s = basis ? basis.s : Math.sin(plate.angle);
  return { x: plate.x + c * u - s * v, y: plate.y + s * u + c * v };
}
export function worldToLocal(plate: Pose, point: Point, basis?: Basis): LocalPoint {
  const c = basis ? basis.c : Math.cos(plate.angle), s = basis ? basis.s : Math.sin(plate.angle), dx = point.x - plate.x, dy = point.y - plate.y;
  return { u: c * dx + s * dy, v: -s * dx + c * dy };
}
export function plateCorners(plate: PlateGeometry): [Point, Point, Point, Point] {
  const h = plate.thicknessMm / 2000, l = plate.length / 2;
  return [localToWorld(plate, -l, -h), localToWorld(plate, l, -h), localToWorld(plate, l, h), localToWorld(plate, -l, h)];
}
export function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const s1 = cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y);
  const s2 = cross(c.x - b.x, c.y - b.y, p.x - b.x, p.y - b.y);
  const s3 = cross(a.x - c.x, a.y - c.y, p.x - c.x, p.y - c.y);
  return (s1 >= -1e-9 && s2 >= -1e-9 && s3 >= -1e-9) || (s1 <= 1e-9 && s2 <= 1e-9 && s3 <= 1e-9);
}
export function closestSegment(p: Point, a: Point, b: Point): SegmentPoint {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return { x: a.x + dx * t, y: a.y + dy * t, t };
}
// The stretch of the segment from `a` to `b` that lies in the box from the origin to (`width`, `height`), `margin`
// past each of its edges: its two ends, or nothing when the segment passes outside the box.
export function segmentInBox(a: Point, b: Point, width: number, height: number, margin = 0): [Point, Point] | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  let from = 0, to = 1;
  const faces: [number, number][] = [[-dx, a.x + margin], [dx, width + margin - a.x], [-dy, a.y + margin], [dy, height + margin - a.y]];
  for (const [step, room] of faces) {
    if (!step) { if (room < 0) return null; continue; }
    const t = room / step;
    if (step < 0) from = Math.max(from, t); else to = Math.min(to, t);
    if (from > to) return null;
  }
  return [{ x: a.x + dx * from, y: a.y + dy * from }, { x: a.x + dx * to, y: a.y + dy * to }];
}

// Convex half-plane clipping returns the complete interval, even when a fast
// projectile crosses a plate between ticks or starts inside a triangle.
export function segmentConvex(a: Point, b: Point, vertices: readonly Point[]): ConvexIntersection | null {
  let lo = 0, hi = 1, nx = 0, ny = 0;
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]!, q = vertices[(i + 1) % vertices.length]!; area += cross(p.x, p.y, q.x, q.y);
  }
  const sign = area >= 0 ? 1 : -1, dx = b.x - a.x, dy = b.y - a.y;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]!, q = vertices[(i + 1) % vertices.length]!;
    const ex = q.x - p.x, ey = q.y - p.y;
    const d0 = sign * cross(ex, ey, a.x - p.x, a.y - p.y);
    const dv = sign * cross(ex, ey, dx, dy);
    if (Math.abs(dv) < 1e-12) { if (d0 < -1e-9) return null; continue; }
    const t = -d0 / dv;
    if (dv > 0) {
      if (t > lo) { lo = t; const len = Math.hypot(ex, ey) || 1; nx = sign * ey / len; ny = -sign * ex / len; }
    } else hi = Math.min(hi, t);
    if (lo > hi + 1e-10) return null;
  }
  if (hi < 0 || lo > 1) return null;
  if (!nx && !ny) { const len = Math.hypot(dx, dy) || 1; nx = -dx / len; ny = -dy / len; }
  return { enter: clamp(lo, 0, 1), exit: clamp(hi, 0, 1), nx, ny };
}

export function rectangle(x: number, y: number, w: number, h: number, angle = 0): Point[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  const corners: [number, number][] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return corners.map(([u, v]) => ({ x: x + c * u - s * v, y: y + s * u + c * v }));
}

