// The roads a field lays over its ground: stretches from `x0` up to `x1` of earth graded and rolled firm, or of asphalt.
// Over a road the ground is the road's, for grip, rolling and bumps (game_terrain.rs `Terrain::roads`); its height
// is the ground's. A list of them is kept in order along the ground, none over another,
// and none touching one of its own kind: those are one road. Every list here is such a list, and nobody's to write into.
export const ROAD_KINDS = Object.freeze(['graded', 'asphalt'] as const);
export type RoadKind = (typeof ROAD_KINDS)[number];
export interface Road { readonly x0: number; readonly x1: number; readonly kind: RoadKind }
export type RoadSpan = [number, number];
export const NO_ROADS: readonly Road[] = Object.freeze([]);
// The ends of a road are kept to the centimetre: an end two roads share is the same number wherever it is worked out.
const centimetre = (x: number): number => Math.round(x * 100) / 100;
export const isRoadKind = (kind: unknown): kind is RoadKind => ROAD_KINDS.some(known => known === kind);
function firstRoad(roads: readonly Road[], x: number): number {
  let lo = 0, hi = roads.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1, road = roads[mid];
    if (!road) throw new TypeError('Missing road.');
    if (road.x1 <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// The roads with one more laid from `x0` up to `x1` as `kind`, over whatever was there: what it covers of the others is
// its own, what is left of them on either side stays theirs, and it is one road with any of its kind it touches.
export function paved(roads: readonly Road[], x0: number, x1: number, kind: unknown): readonly Road[] {
  const from = centimetre(x0), to = centimetre(x1);
  if (!isRoadKind(kind) || !Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw new Error('Trecho de estrada inválido.');
  const laid: Road[] = [];
  for (const road of roads) {
    if (road.x1 <= from || road.x0 >= to) { laid.push(road); continue; }
    if (road.x0 < from) laid.push({ x0: road.x0, x1: from, kind: road.kind });
    if (road.x1 > to) laid.push({ x0: to, x1: road.x1, kind: road.kind });
  }
  laid.push({ x0: from, x1: to, kind });
  laid.sort((a, b) => a.x0 - b.x0);
  const joined: Road[] = [];
  for (const road of laid) {
    const last = joined.at(-1);
    if (last?.kind === road.kind && last.x1 >= road.x0) joined[joined.length - 1] = { ...last, x1: Math.max(last.x1, road.x1) };
    else joined.push(road);
  }
  return Object.freeze(joined.map(road => Object.freeze(road)));
}

// A list of roads as the field keeps it, from what was said of them: each laid in its turn (`paved`), a later one over an
// earlier where they meet. Refuses what is no road.
export function normalRoads(list: unknown): readonly Road[] {
  if (!Array.isArray(list)) throw new Error('Estradas inválidas.');
  let roads = NO_ROADS;
  const entries: readonly unknown[] = list;
  for (const entry of entries) {
    const road = entry !== null && typeof entry === 'object' ? entry : null;
    roads = paved(roads, Number(road && 'x0' in road ? road.x0 : undefined), Number(road && 'x1' in road ? road.x1 : undefined), road && 'kind' in road ? road.kind : undefined);
  }
  return roads;
}

// The kind of road at a place, or null where none is laid.
export function roadAt(roads: readonly Road[], x: number): RoadKind | null {
  const lo = firstRoad(roads, x);
  const road = roads[lo];
  return road && x >= road.x0 ? road.kind : null;
}

// Whether a road is laid anywhere between two places.
export function laidOver(roads: readonly Road[], a: number, b: number): boolean {
  const road = roads[firstRoad(roads, a)];
  return Boolean(road && road.x0 < b);
}

// The stretches between two places whose ground is of `kind` — a kind of road, or null for the ground no road is laid on —,
// as [from, to] in order, none of them touching the next.
export function stretches(roads: readonly Road[], a: number, b: number, kind: RoadKind | null): RoadSpan[] {
  const spans: RoadSpan[] = [], take = (from: number, to: number): void => {
    if (!(to > from)) return;
    const last = spans.at(-1);
    if (last && last[1] >= from) last[1] = to; else spans.push([from, to]);
  };
  let at = a;
  for (let i = firstRoad(roads, a); i < roads.length; i++) {
    const road = roads[i];
    if (!road) throw new TypeError('Missing road.');
    if (!(road.x0 < b)) break;
    const from = Math.max(a, road.x0), to = Math.min(b, road.x1);
    if (kind === null) take(at, from); else if (road.kind === kind) take(from, to);
    at = Math.max(at, to);
  }
  if (kind === null) take(at, b);
  return spans;
}
// How long stretches are in all.
export const length = (spans: readonly (readonly [number, number])[]): number => spans.reduce((sum, [from, to]) => sum + to - from, 0);

// Where two lists of roads differ: the stretches the ground of one is not that of the other, as [from, to] in order.
export function unlike(before: readonly Road[], after: readonly Road[]): RoadSpan[] {
  const ends = [...new Set([...before, ...after].flatMap(road => [road.x0, road.x1]))].sort((a, b) => a - b), spans: RoadSpan[] = [];
  for (let i = 1; i < ends.length; i++) {
    const a = Number(ends[i - 1]), b = Number(ends[i]), middle = (a + b) / 2;
    if (roadAt(before, middle) === roadAt(after, middle)) continue;
    const last = spans.at(-1);
    if (last && last[1] === a) last[1] = b; else spans.push([a, b]);
  }
  return spans;
}
