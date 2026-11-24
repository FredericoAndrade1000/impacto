import { nodeKey, vertexKey, stretchKey, pointOf, samePlace } from './frame-points.ts';
import type { Point } from './math.ts';
import type { AuthoredConstruction, ChassisPoint } from './construction-contract.ts';

type SymmetricFrame = Pick<AuthoredConstruction, 'nodes' | 'plates' | 'chassis'>;

// Symmetric editing (the workshop's ▷|◁): what is done on one side of the axis of the construction, x = 0 as its nodes
// are written, is done on the other side too, mirrored. What stands across the axis from a thing is found by where it
// stands: at its mirrored coordinates (frame-points.ts samePlace); what
// stands on the axis is its own mirror, and stays on it. Equipment is no part of it: moving or removing one piece of
// equipment does nothing to another.
const SAME = 1e-6;
export const mirrored = ({ x, y }: Point): Point => ({ x: x ? -x : 0, y });
// On the axis, a place is where its mirror is.
export const onAxis = (x: number): boolean => x === 0;
const facing = (a: Point, b: Point): boolean => samePlace(mirrored(a), b);
const nearest = <P extends Point>(candidates: readonly P[], point: Point): P | null => candidates.find(other => facing(other, point)) ?? null;
const nodeOf = (source: SymmetricFrame, id: string) => source.nodes.find(node => node.id === id);

// The end of plates across the axis from the end `id`: itself on the axis, else the nearest end standing mirrored.
export function nodeAcross(source: SymmetricFrame, id: string): string | null {
  const node = nodeOf(source, id);
  if (!node) return null;
  if (onAxis(node.x)) return id;
  const ends = new Set(source.plates.flatMap(plate => [plate.a, plate.b]));
  return nearest(source.nodes.filter(other => other.id !== id && ends.has(other.id)), node)?.id ?? null;
}
// The plate across the axis from the plate `id`: the one whose ends stand where its own would mirrored; itself when its
// ends mirror each other.
export function plateAcross(source: SymmetricFrame, id: string): string | null {
  const plate = source.plates.find(plate => plate.id === id);
  if (!plate) return null;
  const a = nodeOf(source, plate.a), b = nodeOf(source, plate.b);
  if (facing(a!, b!)) return id;
  return source.plates.find(other => {
    if (other.id === id) return false;
    const c = nodeOf(source, other.a), d = nodeOf(source, other.b);
    return facing(a!, c!) && facing(b!, d!) || facing(a!, d!) && facing(b!, c!);
  })?.id ?? null;
}
// The point of the chassis across the axis from the point `index`.
export function vertexAcross(source: SymmetricFrame, index: number): number | null {
  const points: readonly ChassisPoint[] = source.chassis?.points || [], point = points[index];
  if (!point) return null;
  if (onAxis(point.x)) return index;
  const other = nearest(points.filter((_, i) => i !== index), point);
  return other ? points.indexOf(other) : null;
}
// The stretch of the chassis across the axis from the stretch `index`, between the points across from its own.
export function stretchAcross(source: SymmetricFrame, index: number): number | null {
  const from = vertexAcross(source, index), to = vertexAcross(source, index + 1);
  return from !== null && to !== null && Math.abs(from - to) === 1 ? Math.min(from, to) : null;
}
// What of the frame stands across the axis from what the selection key `key` names: a plate, an end of plates, a point
// or a stretch of the chassis; null for equipment and for what has none.
function keyAcross(source: SymmetricFrame, key: string): string | null {
  const point = pointOf(key);
  if (point?.kind === 'node') { const id = nodeAcross(source, point.id); return id && nodeKey(id); }
  if (point?.kind === 'vertex') { const index = vertexAcross(source, point.index); return index === null ? null : vertexKey(index); }
  if (point?.kind === 'stretch') { const index = stretchAcross(source, point.index); return index === null ? null : stretchKey(index); }
  return source.plates.some(plate => plate.id === key) ? plateAcross(source, key) : null;
}
// The keys `keys` and what stands across the axis from each, each once.
export function withAcross(source: SymmetricFrame, keys: readonly string[]): string[] {
  return [...new Set(keys.flatMap(key => [key, keyAcross(source, key)].filter((key): key is string => Boolean(key))))];
}

// A selection `keys` moved in symmetric editing: what goes the other way (`turned`) — the plates, the ends of plates and
// the points of the chassis across the axis from those chosen, unless chosen themselves — and how far across each point
// of the chassis goes (`ways`: 1 with the pointer, -1 the other way, 0 on the axis, only up or down).
export function symmetricMove(source: SymmetricFrame, keys: readonly string[]) {
  const chosen = new Set(keys), turned = { plates: new Set<string>(), nodes: new Set<string>() }, ways = new Map<number, number>(),
    way = (index: number, value: number) => ways.set(index, Math.max(ways.get(index) ?? -1, value));
  for (const key of keys) {
    const point = pointOf(key), other = keyAcross(source, key);
    if (point?.kind === 'vertex' || point?.kind === 'stretch') {
      const indices = point.kind === 'vertex' ? [point.index] : [point.index, point.index + 1], across = pointOf(other ?? '');
      if (other === key) { for (const index of indices) way(index, 0); continue; }
      for (const index of indices) way(index, 1);
      if (across && across.kind !== 'node' && !chosen.has(other!)) for (const index of across.kind === 'vertex' ? [across.index] : [across.index, across.index + 1]) way(index, -1);
    } else if (other && other !== key && !chosen.has(other)) {
      if (point?.kind === 'node') { const across = pointOf(other); if (across?.kind === 'node') turned.nodes.add(across.id); } else turned.plates.add(other);
    }
  }
  return { turned, ways };
}

// How far along a line `points` (as nodes are written) from `from` towards `to` it first meets the axis, past `from`;
// `to` when it does not before.
export function untilAxis(points: readonly Point[], from: number, to: number): number {
  const way = Math.sign(to - from);
  if (!way) return to;
  let start = 0, met: number | null = null;
  points.slice(1).forEach((point, i) => {
    const a = points[i]!, length = Math.hypot(point.x - a.x, point.y - a.y);
    if ((a.x < 0) !== (point.x < 0) && a.x !== point.x) {
      const u = start + length * (-a.x / (point.x - a.x));
      if (way * (u - from) > SAME && way * (to - u) > -SAME && (met === null || way * (met - u) > 0)) met = u;
    }
    start += length;
  });
  return met ?? to;
}
