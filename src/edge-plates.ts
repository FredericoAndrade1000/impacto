import { CELL } from './grid.ts';
import { samePlace } from './frame-points.ts';
import type { Point } from './math.ts';

export interface EdgeSpan {
  id: string;
  a: Point;
  b: Point;
  length: number;
  thicknessMm: number;
  normal?: Point | null;
}
export interface PlateEdge { points: Point[]; offsets: number[] }
interface EdgeStep<S extends EdgeSpan> { span: S; to: Point }
interface RunCandidate<S extends EdgeSpan> { span: S; far: Point; e: Point; turn: number }

// The edges new plates are laid along with Shift (or a finger held) dragged along them: the edge of a plate, going on
// over the plates that continue it end to end, and the top of the chassis, along the line of its points. An edge is
// the line it runs along in the field (`points`, from its start) and, for each stretch of it, how far to the left of
// it the new plates stand (`offsets`): their faces against those under them. Frame-editing.js lays the plates.
const NEAR = 1e-6;
const unit = (a: Point, b: Point): Point => { const length = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / length, y: (b.y - a.y) / length }; };
const lengthsOf = (points: readonly Point[]): number[] => points.slice(1).map((point, i) => Math.hypot(point.x - points[i]!.x, point.y - points[i]!.y));
const startsOf = (lengths: readonly number[]): number[] => lengths.map((_, i) => lengths.slice(0, i).reduce((sum, length) => sum + length, 0));

// The plates that go on from the end `at` of a run heading `heading`, end to end, the straightest way at each end; a
// plate already in `used` is not taken again.
function run<S extends EdgeSpan>(spans: readonly S[], at: Point, heading: Point, used: Set<string>): EdgeStep<S>[] {
  const out: EdgeStep<S>[] = [];
  for (let d = heading; ;) {
    let best: RunCandidate<S> | null = null;
    for (const span of spans) {
      if (used.has(span.id) || span.length < NEAR) continue;
      const far = samePlace(span.a, at) ? span.b : samePlace(span.b, at) ? span.a : null;
      if (!far) continue;
      const e = unit(at, far), turn = Math.abs(Math.atan2(d.x * e.y - d.y * e.x, d.x * e.x + d.y * e.y));
      if (turn < Math.PI - 1e-3 && (!best || turn < best.turn)) best = { span, far, e, turn };
    }
    if (!best) return out;
    used.add(best.span.id); out.push({ span: best.span, to: best.far });
    at = best.far; d = best.e;
  }
}
// The edge of the plate `id` (a span of Editor.plateSpans), pressed at `press`, new plates of `thicknessMm` laid on it:
// on the side of it the press was, or on its line the outer side of a wall, or else its left. Around a closed contour
// it goes either way from the plate pressed.
export function plateEdge(spans: readonly EdgeSpan[], id: string, press: Point, thicknessMm: number): PlateEdge | null {
  const first = spans.find(span => span.id === id);
  if (!first || first.length < NEAR) return null;
  const d = unit(first.a, first.b), across = d.x * (press.y - first.a.y) - d.y * (press.x - first.a.x),
    side = Math.abs(across) > 1e-4 ? Math.sign(across) : first.normal ? Math.sign(d.x * first.normal.y - d.y * first.normal.x) || 1 : 1,
    ahead = run(spans, first.b, d, new Set([id])),
    behind = run(spans, first.a, { x: -d.x, y: -d.y }, new Set([id])).reverse(),
    // Behind, each plate was met from its far end: written from the start of the edge, it runs to where it was met.
    points = [...behind.map(step => step.to), first.a, first.b, ...ahead.map(step => step.to)],
    spansAlong = [...behind.map(step => step.span), first, ...ahead.map(step => step.span)];
  return { points, offsets: spansAlong.map(span => side * (span.thicknessMm + thicknessMm) / 2000) };
}
// The top of the chassis, from its front, new plates of `thicknessMm` laid on it (Editor.chassisPoints: `top`).
export function chassisEdge(points: readonly { top: Point }[], thicknessMm: number): PlateEdge | null {
  if (points.length < 2) return null;
  return { points: points.map(point => ({ ...point.top })), offsets: points.slice(1).map(() => thicknessMm / 2000) };
}
// How far along `edge` the place nearest `point` is; where the edge passes there more than once (around a contour, either
// way), the one nearest `previous`.
export function alongEdge(edge: PlateEdge, point: Point, previous: number | null = null): number {
  const lengths = lengthsOf(edge.points), starts = startsOf(lengths);
  let best: { distance: number; u: number } | null = null;
  for (const [i, length] of lengths.entries()) {
    const a = edge.points[i]!, d = unit(a, edge.points[i + 1]!),
      t = Math.max(0, Math.min(length, (point.x - a.x) * d.x + (point.y - a.y) * d.y)),
      distance = Math.hypot(a.x + d.x * t - point.x, a.y + d.y * t - point.y), u = starts[i]! + t;
    if (!best || distance < best.distance - 1e-9 ||
        Math.abs(distance - best.distance) <= 1e-9 && previous !== null && Math.abs(u - previous) < Math.abs(best.u - previous))
      best = { distance, u };
  }
  // Edges returned by plateEdge/chassisEdge have at least one stretch.
  return best!.u;
}
// Where along `edge` a pointer at `u` lays an end: at a bend or an end of the edge within half a cell of it, else whole
// cells along the stretch it is on, from its start.
export function snapAlong(edge: PlateEdge, u: number): number {
  const lengths = lengthsOf(edge.points), starts = startsOf(lengths), corners = [...starts, starts.at(-1)! + lengths.at(-1)!],
    corner = corners.reduce((best, at) => Math.abs(at - u) < Math.abs(best - u) ? at : best);
  if (Math.abs(corner - u) < CELL / 2) return corner;
  const i = Math.max(0, starts.findLastIndex(start => start <= u));
  return Math.min(starts[i]! + lengths[i]!, starts[i]! + Math.round((u - starts[i]!) / CELL) * CELL);
}
// The way the edge runs at `u`, to tell a drag along it from one away from it.
export function headingAt(edge: PlateEdge, u: number): Point {
  const starts = startsOf(lengthsOf(edge.points)), i = Math.max(0, starts.findLastIndex(start => start <= u + NEAR));
  return unit(edge.points[i]!, edge.points[i + 1]!);
}
