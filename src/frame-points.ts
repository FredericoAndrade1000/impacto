import type { Point } from './math.ts';

export interface FrameNode extends Point { id: string }
export interface FrameSpan { a: string; b: string }
export type FramePoint = { kind: 'node'; id: string } | { kind: 'vertex' | 'stretch'; index: number };
export interface SelectedFramePoints { nodes: string[]; vertices: number[]; stretches: number[] }

// Whether two points of the frame stand in one place. Where points stand is compared here alone: every point of the
// frame is written on a whole cell (grid.ts), and one place is the same cell; two points of the compiled frame, each
// reckoned in metres from its cell, are as equal.
export function samePlace(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

// The ends of plates (`nodes`, as a compiled frame has them, with its `plates` between them) that stand within `near` of
// another end, so near they look one, without being in one place with it: apart, though they seem joined. The two ends
// of one plate are not counted.
export function looseEnds(nodes: readonly FrameNode[], plates: readonly FrameSpan[], near: number): Set<string> {
  const spanned = new Set(plates.flatMap(plate => [plate.a + '|' + plate.b, plate.b + '|' + plate.a])), loose = new Set<string>();
  nodes.forEach((a, i) => {
    for (const b of nodes.slice(i + 1)) if (!samePlace(a, b) && Math.hypot(a.x - b.x, a.y - b.y) <= near && !spanned.has(a.id + '|' + b.id)) {
      loose.add(a.id); loose.add(b.id);
    }
  });
  return loose;
}

// Points of the frame are selected as pieces are: an end of plates (a node of the hull, which every plate ending there
// shares), a point of the chassis, and a stretch of the chassis from one of its points to the next. Each has a key in
// the same selection as the pieces; none starts with "chassis:", which names the pieces of the chassis.
export const nodeKey = (id: string): string => 'node:' + id;
export const vertexKey = (index: number): string => 'vertex:' + index;
export const stretchKey = (index: number): string => 'stretch:' + index;
// What a key of the selection names: `{ kind: 'node', id }`, `{ kind: 'vertex', index }`, `{ kind: 'stretch', index }`,
// or null for a piece.
export function pointOf(key: unknown): FramePoint | null {
  if (typeof key !== 'string') return null;
  if (key.startsWith('node:')) return { kind: 'node', id: key.slice(5) };
  const [, kind, index] = /^(vertex|stretch):(\d+)$/.exec(key) || [];
  return kind === 'vertex' || kind === 'stretch' ? { kind, index: Number(index) } : null;
}
// The points a selection names, by kind: node ids, and the indices of chassis points and stretches, in the order chosen.
export function selectedPoints(ids: Iterable<string>): SelectedFramePoints {
  const points: SelectedFramePoints = { nodes: [], vertices: [], stretches: [] };
  for (const key of ids) {
    const point = pointOf(key);
    if (point) point.kind === 'node' ? points.nodes.push(point.id) : (point.kind === 'vertex' ? points.vertices : points.stretches).push(point.index);
  }
  return points;
}
