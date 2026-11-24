import { clamp } from './math.ts';
import { NO_ROADS, roadAt } from './roads.ts';
import type { Point } from './math.ts';
import type { Road } from './roads.ts';

interface TerrainProfile { surface: string; battle?: boolean; relief?: boolean }
const terrainProfiles = {
  'wet-valley': { surface: 'soil', battle: true },
  'arid-basin': { surface: 'sand', battle: true },
  'rural-ridges': { surface: 'soil', battle: true },
  highlands: { surface: 'soil', battle: true, relief: true },
  plateau: { surface: 'rock', battle: true, relief: true },
  world: { surface: 'soil', battle: true },
  mixed: { surface: 'soil' },
  mud: { surface: 'mud' },
  sand: { surface: 'sand' },
  flat: { surface: 'concrete' },
  hills: { surface: 'soil' },
  rough: { surface: 'rock' },
};
export type TerrainId = keyof typeof terrainProfiles;
export const isTerrainId = (id: unknown): id is TerrainId => typeof id === 'string' && Object.hasOwn(terrainProfiles, id);
export const TERRAIN_PROFILES: Readonly<Record<TerrainId, TerrainProfile>> = Object.freeze(terrainProfiles);
export type TerrainFeatureKind = 'plateau' | 'ridge' | 'scarp' | 'outcrop' | 'talus' | 'drywash' | 'lowland' | 'road' | 'dune' | 'embankment' | 'ruins';
interface TerrainFeatureBase { start: number; peak: number; end: number; height: number; surface: string }
export type TerrainFeature = TerrainFeatureBase & (
  | { kind: 'plateau'; crest: number }
  | { kind: Exclude<TerrainFeatureKind, 'plateau'>; crest?: never }
);
export interface TerrainSector { start: number; end: number; surface: string; label?: string }
export interface TerrainRegion { id: TerrainId; start: number; end: number }
export interface TerrainSurface extends Point { slope: number; nx: number; ny: number; tx: number; ty: number; surface: string }
export interface TerrainRaycast extends Point { enter: number; nx: number; ny: number; surface: string }
export interface TerrainRock { start: number; peak: number; end: number; height: number }
export interface TerrainSnapshot {
  id: TerrainId; seed: number; length: number; center: number; spacing: number; material: string;
  minX: number; maxX: number; points: Point[]; sectors: TerrainSector[]; features?: TerrainFeature[]; rocks?: TerrainRock[];
}
export interface TerrainOptions {
  id?: TerrainId; seed?: number; length?: number; center?: number; spacing?: number; material?: string;
  minX?: number; maxX?: number; points?: Point[]; sectors?: TerrainSector[];
}
interface SegmentProfile { a: Point; b: Point; ay: number; by: number; slope: number; nx: number; ny: number }
type HeightAt = (x: number) => number;
interface WorldRegion extends TerrainRegion { id: BiomeId; offset: number }
interface WorldPlan {
  regions: WorldRegion[]; features: TerrainFeature[]; biome(u: number): BiomeId;
  height(u: number, active: readonly TerrainFeature[], guards: readonly TerrainFeature[]): number;
}
type Landscape = Omit<TerrainSnapshot, 'id'> & { features: TerrainFeature[]; rocks: TerrainRock[]; biomes?: TerrainRegion[] };
function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new TypeError('Missing terrain geometry.');
  return value;
}
// The biomes, and the landscapes drawn from a seed: each biome alone, or the world that has them all.
export const BIOME_IDS = Object.freeze(['wet-valley', 'arid-basin', 'rural-ridges', 'highlands', 'plateau'] satisfies TerrainId[]);
export type BiomeId = (typeof BIOME_IDS)[number];
export const BATTLE_TERRAIN_IDS: readonly TerrainId[] = Object.freeze([...BIOME_IDS, 'world']);
const MIN_LANDSCAPE_LENGTH = 1000;
const MAX_LANDSCAPE_LENGTH = 512000;
// Bound the polyline; only the final segment may be shorter than this spacing.
const landscapeSpacing = (length: number): number => length <= 4096 ? 1 : length <= 8192 ? 2 : 4;
const smooth = (x: number): number => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const mound = (x: number, a: number, b: number, c: number, d: number, height: number): number => height * smooth((x - a) / (b - a)) * (1 - smooth((x - c) / (d - c)));
const lowest = (points: readonly Point[]): number => { let low = Infinity; for (const p of points) if (p.y < low) low = p.y; return low; };
const MIXED_SECTORS = Object.freeze([
  { start: -1600, end: -30, surface: 'soil', label: 'Terra' },
  { start: -30, end: -20, surface: 'rock', label: 'Rocha' },
  { start: -20, end: -11, surface: 'sand', label: 'Areia' },
  { start: -11, end: -3, surface: 'mud', label: 'Lama' },
  { start: -3, end: 16, surface: 'concrete', label: 'Oficina' },
  { start: 16, end: 28, surface: 'soil', label: 'Estrada de terra' },
  { start: 28, end: 34, surface: 'gravel', label: 'Cascalho' },
  { start: 34, end: 45, surface: 'mud', label: 'Baixada de lama' },
  { start: 45, end: 65, surface: 'sand', label: 'Dunas' },
  { start: 65, end: 82, surface: 'rock', label: 'Subida rochosa' },
  { start: 82, end: 1600, surface: 'soil', label: 'Terra' },
]);
const MIXED_ROCKS = Object.freeze([
  { start: -27, peak: -25.5, end: -24, height: .42 },
  { start: 68, peak: 69.5, end: 71, height: .36 },
  { start: 75, peak: 76.5, end: 78, height: .48 },
]);
function rockHeight(x: number, rock: TerrainRock): number {
  if (x <= rock.start || x >= rock.end) return 0;
  return rock.height * (x <= rock.peak ? (x - rock.start) / (rock.peak - rock.start) : (rock.end - x) / (rock.end - rock.peak));
}

// Continue the proving ground beyond the workshop instead of spawning distant
// opponents on an empty plane. Each 64 m section has gentle approach ramps;
// the same outline drives contacts, sensors, blast shielding and rendering.
const FAR_MIN = -384, FAR_MAX = 408;
function farSections(): { start: number; index: number }[] {
  const sections: { start: number; index: number }[] = [];
  for (let start = FAR_MIN; start < -64; start += 64) sections.push({ start, index: sections.length });
  for (let start = 96; start < FAR_MAX; start += 64) sections.push({ start, index: sections.length });
  return sections;
}
const FAR_SECTIONS = farSections();
const FAR_SURFACES = [
  { offset: 0, end: 18, surface: 'soil', label: 'Terra' },
  { offset: 18, end: 30, surface: 'mud', label: 'Lama' },
  { offset: 30, end: 46, surface: 'sand', label: 'Dunas' },
  { offset: 46, end: 54, surface: 'gravel', label: 'Cascalho' },
  { offset: 54, end: 64, surface: 'rock', label: 'Rocha' },
];
function farHeight(id: TerrainId, x: number): number {
  const section = FAR_SECTIONS.find(s => x >= s.start && x < s.start + 64);
  if (!section || id === 'flat') return 0;
  const t = x - section.start, scale = .85 + (section.index % 3) * .15;
  let y;
  if (id === 'mud') y = -.28 * mound(t, 6, 14, 30, 39, scale) + mound(t, 41, 48, 51, 62, .35);
  else if (id === 'sand') y = mound(t, 2, 12, 15, 28, 1.45 * scale) + mound(t, 30, 42, 45, 62, .95 * scale);
  else if (id === 'mixed') y = mound(t, 1, 9, 10, 18, .7 * scale) - mound(t, 18, 22, 26, 30, .24) +
    mound(t, 30, 36, 38, 46, 1.15 * scale) + mound(t, 49, 57, 58, 64, 1.35 * scale);
  else y = mound(t, 1, 15, 19, 37, 2.6 * scale) + mound(t, 39, 48, 51, 63, 1.25 * scale);
  // Finish on a level approach at the map boundary, with no discontinuity to
  // the outer support plane or discrepancy between height() and the polyline.
  return y * smooth((x - FAR_MIN) / 8) * smooth((FAR_MAX - x) / 8);
}

// Integer hash and polynomial interpolation are shared with game_terrain.rs.
// No platform trigonometry or per-sample RNG determines the mechanical map.
function terrainRandom(seed: number, channel: number, cell = 0): number {
  let n = (seed ^ Math.imul(channel + 1, 0x9e3779b9) ^ Math.imul(cell, 0x85ebca6b)) >>> 0;
  n = Math.imul(n ^ n >>> 16, 0x7feb352d); n = Math.imul(n ^ n >>> 15, 0x846ca68b);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
function terrainNoise(seed: number, channel: number, x: number, scale: number): number {
  const cell = Math.floor(x / scale), t = smooth(x / scale - cell),
    a = terrainRandom(seed, channel, cell) * 2 - 1, b = terrainRandom(seed, channel, cell + 1) * 2 - 1;
  return a + (b - a) * t;
}
// Broad landforms keep their altitude and spacing. These smaller, correlated
// folds add real suspension-scale relief, never independent noise per vertex.
// Even the shortest cell spans four contacts on a long map's 4 m contour.
const LOCAL_RELIEF: Readonly<Partial<Record<TerrainId, readonly [number, number, number]>>> = Object.freeze({
  'wet-valley': [1.4, .8, .2],
  'arid-basin': [1.8, 1, .18],
  'rural-ridges': [1.2, .9, .22],
  highlands: [1.2, .9, .24],
  plateau: [1.5, .9, .22],
});
const RELIEF_MARGIN = 32;
function localRelief(id: TerrainId, seed: number, u: number): number {
  const amplitudes = LOCAL_RELIEF[id];
  if (!amplitudes) throw new TypeError('Missing biome relief.');
  return amplitudes[0] * terrainNoise(seed, 401, u, 112) +
    amplitudes[1] * terrainNoise(seed, 402, u, 40) + amplitudes[2] * terrainNoise(seed, 403, u, 16);
}
// A road or slab keeps its accepted profile; folds fade out before reaching
// it, rather than ending in a ledge at the change of material.
const reliefGuards = (features: readonly TerrainFeature[]): TerrainFeature[] => features.filter(f => f.kind === 'road' || f.kind === 'ruins')
  .map(f => ({ ...f, start: f.start - RELIEF_MARGIN, end: f.end + RELIEF_MARGIN }));
function reliefMask(u: number, active: readonly TerrainFeature[], guards: readonly TerrainFeature[]): number {
  let gain = 1;
  for (const f of active) if (f.kind === 'plateau')
    gain *= 1 - .8 * mound(u, f.start, f.peak - f.crest / 2, f.peak + f.crest / 2, f.end, 1);
  for (const f of guards)
    gain *= 1 - mound(u, f.start, f.start + RELIEF_MARGIN, f.end - RELIEF_MARGIN, f.end, 1);
  return gain;
}
const landformHeight = (x: number, f: TerrainFeature): number => x <= f.start || x >= f.end || !f.height ? 0 : f.kind === 'plateau' ?
  mound(x, f.start, f.peak - f.crest / 2, f.peak + f.crest / 2, f.end, f.height) :
  f.height * (x <= f.peak ? smooth((x - f.start) / (f.peak - f.start)) : 1 - smooth((x - f.peak) / (f.end - f.peak)));
function landscapeFeatures(id: TerrainId, seed: number, length: number): TerrainFeature[] {
  const half = length / 2, forms: TerrainFeature[] = [], add = (kind: Exclude<TerrainFeatureKind, 'plateau'>, start: number, peak: number, end: number, height: number, surface: string): void => {
    if (start > -half + 45 && end < half - 45) forms.push({ kind, start, peak, end, height, surface });
  }, basin = terrainRandom(seed, 100) * 120 - 60;
  if (id === 'highlands' || id === 'plateau') {
    const plateau = id === 'plateau', period = plateau ? 500 : 320;
    for (let cell = Math.ceil((-half + 100) / period); cell <= Math.floor((half - 100) / period); cell++) {
      const x = cell * period + (terrainRandom(seed, 201, cell) - .5) * 48,
        height = (plateau ? 26 : 22) + terrainRandom(seed, 202, cell) * (plateau ? 16 : 24),
        crest = plateau ? 70 + terrainRandom(seed, 203, cell) * 56 : 0,
        width = height * (8 + terrainRandom(seed, 204, cell) * 1.2),
        left = plateau ? height * (3.9 + terrainRandom(seed, 205, cell)) + crest / 2 : width * (.48 + terrainRandom(seed, 205, cell) * .04),
        right = plateau ? height * (3.8 + terrainRandom(seed, 206, cell)) + crest / 2 : width - left;
      if (x - left <= -half + 45 || x + right >= half - 45) continue;
      forms.push(plateau ? { kind: 'plateau', start: x - left, peak: x, end: x + right, height, surface: 'rock', crest } :
        { kind: 'ridge', start: x - left, peak: x, end: x + right, height, surface: 'soil' });
      if (plateau) {
        add('scarp', x - left, x - crest / 2 - height, x - crest / 2, 0, 'rock');
        add('scarp', x + crest / 2, x + crest / 2 + height, x + right, 0, 'rock');
      } else add('outcrop', x - 9, x, x + 9, .18, 'rock');
      add('talus', x - left - 10, x - left + 2, x - left + 14, 0, 'gravel');
      add('talus', x + right - 14, x + right - 2, x + right + 10, 0, 'gravel');
      const valley = x + period / 2;
      add('drywash', valley - 22, valley, valley + 22, -.65, 'gravel');
    }
    return forms;
  }
  if (id === 'wet-valley') {
    forms.push({ kind: 'lowland', start: basin - 300, peak: basin, end: basin + 300, height: -6, surface: 'mud' });
    add('road', basin - 290, basin - 235, basin - 180, 0, 'gravel');
    add('road', basin + 180, basin + 235, basin + 290, 0, 'gravel');
  } else if (id === 'arid-basin') {
    add('drywash', basin - 65, basin, basin + 65, -1, 'gravel');
  }
  for (let cell = Math.ceil((-half + 100) / 180); cell <= Math.floor((half - 100) / 180); cell++) {
    const x = cell * 180 + (terrainRandom(seed, 101, cell) - .5) * 50,
      width = 100 + terrainRandom(seed, 102, cell) * 30;
    if (id === 'arid-basin') add('dune', x - width / 2, x - width * .08, x + width / 2,
      1.8 + terrainRandom(seed, 103, cell) * 1.4, 'sand');
    else if (id === 'rural-ridges') {
      add('embankment', x - 40, x, x + 40, 1.4 + terrainRandom(seed, 103, cell), 'soil');
      if (Math.abs(cell) % 2 === 0) add('ruins', x - 10, x, x + 10, .3, 'concrete');
      else add('road', x - 48, x, x + 48, 0, 'gravel');
    } else if (Math.abs(cell) % 2 === 0)
      add('lowland', x - 65, x, x + 65, -1.2, 'mud');
    if (Math.abs(cell) % 3 === 1) add('outcrop', x + 46, x + 56, x + 66, .35, 'rock');
  }
  return forms;
}
// Sample only overlapping features, retaining the original summation order.
// This avoids scanning every hill for every metre of a multi-kilometre map.
function featureSweep(features: readonly TerrainFeature[]): (x: number) => TerrainFeature[] {
  const order = features.map((f, index) => ({ f, index })).sort((a, b) => a.f.start - b.f.start || a.index - b.index);
  const active: { f: TerrainFeature; index: number }[] = []; let cursor = 0;
  return (x: number): TerrainFeature[] => {
    for (let i = active.length - 1; i >= 0; i--) if (item(active,i).f.end < x) active.splice(i, 1);
    let added = false;
    while (cursor < order.length && item(order,cursor).f.start <= x) {
      const next = item(order,cursor++); if (next.f.end >= x) { active.push(next); added = true; }
    }
    if (added) active.sort((a, b) => a.index - b.index);
    return active.map(item => item.f);
  };
}
// Correlated elevation increments create persistent watersheds and terraces.
// Each node has its own altitude, rather than returning every hill to a floor.
// Anchoring cell zero makes extending a map preserve its existing geography.
function regionalElevation(id: TerrainId, seed: number, length: number): HeightAt | null {
  if (!TERRAIN_PROFILES[id].relief) return null;
  const period = id === 'plateau' ? 500 : 320, lo = Math.floor(-length / 2 / period) - 2,
    hi = Math.ceil(length / 2 / period) + 2, levels = new Float64Array(hi - lo + 1),
    step = (cell: number): number => 28 * (.65 * terrainNoise(seed, 220, cell * period, period * 7) +
      .35 * (terrainRandom(seed, 221, cell) * 2 - 1));
  levels[-lo] = 90 + terrainRandom(seed, 222) * 40;
  for (let cell = 1; cell <= hi; cell++) levels[cell - lo] = Number(levels[cell - lo - 1]) + step(cell - 1);
  for (let cell = -1; cell >= lo; cell--) levels[cell - lo] = Number(levels[cell - lo + 1]) - step(cell);
  return (x: number): number => {
    const cell = Math.floor(x / period), t = smooth(x / period - cell), index = cell - lo;
    return Number(levels[index]) + (Number(levels[index + 1]) - Number(levels[index])) * t;
  };
}
// The level ground of a biome before its landforms. Serras and chapadas follow their regional altitude.
function biomeBase(id: TerrainId, seed: number, u: number, active: readonly TerrainFeature[], elevation: HeightAt | null): number {
  const a = elevation ? 0 : terrainNoise(seed, 11, u, 420),
    b = elevation ? 0 : terrainNoise(seed, 12, u, 160), c = terrainNoise(seed, 13, u, 48);
  let regionalX = u;
  if (id === 'plateau') for (const f of active) if (f.kind === 'plateau') {
    const influence = mound(u, f.start, f.peak - f.crest / 2, f.peak + f.crest / 2, f.end, 1);
    regionalX += (f.peak - u) * influence;
  }
  return id === 'wet-valley' ? 14 + 12 * a + 3 * b + .35 * c :
    id === 'arid-basin' ? 10 + 8 * a + 2.8 * b + .25 * c :
    elevation ? elevation(regionalX) + .08 * c : 12 + 10 * a + 3 * b + .3 * c;
}
// The world is a row of biomes a few kilometres long each. Everything about a
// region follows from the number of its cell, counted from the middle of the
// map, so a longer map keeps the geography of a shorter one and adds to it.
// game_terrain.rs grows the same world; the parity fixture holds both to it.
const WORLD_CELL = 3200, WORLD_JITTER = 600, WORLD_MARGIN = 160, WORLD_FLOOR = 20;
// Either side of a border, the stretch over which two grounds are faded into each other. The art fades its colours over the same.
export const WORLD_BLEND = 120;
const worldBorder = (seed: number, cell: number): number => (cell - .5) * WORLD_CELL + (terrainRandom(seed, 301, cell) * 2 - 1) * WORLD_JITTER;
// Every five cells in a row hold the five biomes, in an order of their own.
function worldBiome(seed: number, cell: number): BiomeId {
  const block = Math.floor(cell / 5), order = [0, 1, 2, 3, 4];
  for (let j = 4; j > 0; j--) {
    const r = Math.floor(terrainRandom(seed, 300, block * 8 + j) * (j + 1)), swap = item(order,j);
    order[j] = item(order,r); order[r] = swap;
  }
  return item(BIOME_IDS,item(order,cell - block * 5));
}
function worldPlan(seed: number, length: number): WorldPlan {
  const half = length / 2, cells = Math.ceil(half / WORLD_CELL) + 1, all: WorldRegion[] = [];
  for (let cell = -cells; cell <= cells; cell++) {
    const id = worldBiome(seed, cell), end = worldBorder(seed, cell + 1), previous = all.at(-1);
    if (previous?.id === id) previous.end = end;
    else all.push({ id, start: worldBorder(seed, cell), end, offset: 0 });
  }
  const regions = all.filter(r => r.end > -half && r.start < half),
    elevations: Partial<Record<BiomeId, HeightAt | null>> = { highlands: regionalElevation('highlands', seed, length), plateau: regionalElevation('plateau', seed, length) },
    base = (i: number, u: number, active: readonly TerrainFeature[]): number => biomeBase(item(regions,i).id, seed, u, active, elevations[item(regions,i).id] || null),
    at = (u: number): number => { let i = 0; while (i < regions.length - 1 && item(regions,i).end <= u) i++; return i; };
  // The middle region keeps the altitude of its biome; each neighbour is raised
  // or lowered to meet the one before it at their border.
  const home = at(0);
  for (let i = home + 1; i < regions.length; i++) {
    const region = item(regions,i), x = region.start; region.offset = base(i - 1, x, []) + item(regions,i - 1).offset - base(i, x, []);
  }
  for (let i = home - 1; i >= 0; i--) {
    const region = item(regions,i), x = region.end; region.offset = base(i + 1, x, []) + item(regions,i + 1).offset - base(i, x, []);
  }
  // A landform belongs to the world only well inside a region of its own biome.
  const features = BIOME_IDS.flatMap(id => landscapeFeatures(id, seed, length).filter(f =>
    regions.some(r => r.id === id && f.start >= r.start + WORLD_MARGIN && f.end <= r.end - WORLD_MARGIN)));
  return { regions, features, biome: (u: number): BiomeId => item(regions,at(u)).id,
    // Near a border the two grounds are faded into each other.
    height(u: number, active: readonly TerrainFeature[], guards: readonly TerrainFeature[]): number {
      const i = at(u), r = item(regions,i); let y = base(i, u, active) + r.offset,
        detail = localRelief(r.id, seed, u);
      if (i > 0 && u - r.start < WORLD_BLEND) {
        const other = base(i - 1, u, active) + item(regions,i - 1).offset,
          otherDetail = localRelief(item(regions,i - 1).id, seed, u), t = smooth((u - r.start + WORLD_BLEND) / (2 * WORLD_BLEND));
        y = other + (y - other) * t; detail = otherDetail + (detail - otherDetail) * t;
      } else if (i < regions.length - 1 && r.end - u < WORLD_BLEND) {
        const other = base(i + 1, u, active) + item(regions,i + 1).offset,
          otherDetail = localRelief(item(regions,i + 1).id, seed, u), t = smooth((u - r.end + WORLD_BLEND) / (2 * WORLD_BLEND));
        y = y + (other - y) * t; detail = detail + (otherDetail - detail) * t;
      }
      for (const f of active) y += landformHeight(u, f);
      // Local folds do not enter the offsets that align whole regions.
      return y + detail * reliefMask(u, active, guards);
    } };
}
// What decorates a landscape and names its regions, without taking part in contacts.
function landscapeLayout(id: TerrainId, seed: number, length: number): { features: TerrainFeature[]; regions: WorldRegion[] | null } {
  if (id !== 'world') return { features: landscapeFeatures(id, seed, length), regions: null };
  const world = worldPlan(seed, length); return { features: world.features, regions: world.regions };
}
const placedBiomes = (regions: readonly WorldRegion[], center: number): TerrainRegion[] => regions.map(r => ({ id: r.id, start: r.start + center, end: r.end + center }));
// A landscape is drawn once for the same seed, length and centre, and each ground made of it gets a copy of its own:
// drawing the world (128 thousand points) costs as much as making the rest of a field.
const drawn = new Map<string, Landscape>(), KEPT_LANDSCAPES = 4;
function landscape(id: TerrainId, options: TerrainOptions): Landscape {
  const key = `${id}:${options.seed}:${options.length}:${options.center}`;
  let kept = drawn.get(key);
  if (!kept) {
    kept = drawLandscape(id, options);
    if (drawn.size >= KEPT_LANDSCAPES) drawn.delete(drawn.keys().next().value!);
    drawn.set(key, kept);
  }
  const features = kept.features.map(f => ({ ...f }));
  return { ...kept, points: kept.points.map(({ x, y }) => ({ x, y })), sectors: kept.sectors.map(s => ({ ...s })), features,
    rocks: features.filter(f => f.kind === 'outcrop'), ...(kept.biomes ? { biomes: kept.biomes.map(b => ({ ...b })) } : {}) };
}
function drawLandscape(id: TerrainId, options: TerrainOptions): Landscape {
  const seed = options.seed ?? 6173, requestedLength = options.length ?? 1600, requestedCenter = options.center ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(requestedLength) ||
      requestedLength < MIN_LANDSCAPE_LENGTH || requestedLength > MAX_LANDSCAPE_LENGTH || !Number.isFinite(requestedCenter) || Math.abs(requestedCenter) > 100000)
    throw new Error('Parâmetros de paisagem inválidos.');
  const length = Math.round(requestedLength), center = Math.round(requestedCenter * 2) / 2,
    minX = center - length / 2, maxX = center + length / 2, world = id === 'world' ? worldPlan(seed, length) : null,
    features = world ? world.features : landscapeFeatures(id, seed, length),
    material = TERRAIN_PROFILES[id].surface, points: Point[] = [], sectors: TerrainSector[] = [], half = length / 2,
    spacing = landscapeSpacing(length), heights = featureSweep(features), regions = featureSweep(features),
    protection = featureSweep(reliefGuards(features)),
    elevation = world ? null : regionalElevation(id, seed, length);
  // Ease the grade to zero at the edge while retaining its natural altitude.
  const eased = (u: number): number => {
    if (u < -half + 40) { const t = (u + half) / 40; return -half + 40 * (2 * t * t - t * t * t); }
    if (u > half - 40) { const t = (half - u) / 40; return half - 40 * (2 * t * t - t * t * t); }
    return u;
  };
  const height = (u: number, active: readonly TerrainFeature[], guards: readonly TerrainFeature[] = []): number => {
    u = eased(u);
    if (world) return world.height(u, active, guards);
    let y = biomeBase(id, seed, u, active, elevation);
    for (const f of active) y += landformHeight(u, f);
    return Math.fround(y + localRelief(id, seed, u) * reliefMask(u, active, guards));
  }, surface = (u: number, active: readonly TerrainFeature[]): string => {
    const biome = world ? world.biome(u) : id;
    for (const kind of ['outcrop', 'scarp', 'talus', 'ruins', 'road', 'drywash']) {
      const f = active.find(f => f.kind === kind && u >= f.start && u < f.end); if (f) return f.surface;
    }
    if (biome === 'wet-valley' && active.some(f => f.kind === 'lowland' && landformHeight(u, f) < f.height * .65)) return 'mud';
    if (biome === 'arid-basin' && terrainNoise(seed, 11, u, 420) < -.15 && terrainNoise(seed, 12, u, 160) < .2) return 'gravel';
    return world ? TERRAIN_PROFILES[biome].surface : material;
  };
  points.push({ x: minX - 256, y: height(-half, []) });
  for (let i = 0; i < length; i += spacing) points.push({ x: minX + i, y: height(i - half, heights(i - half), protection(i - half)) });
  points.push({ x: maxX, y: height(half, []) });
  points.push({ x: maxX + 256, y: item(points,points.length - 1).y });
  if (world) {
    // The whole world is raised until its lowest ground stands clear of zero.
    const lift = Math.max(0, WORLD_FLOOR - lowest(points));
    for (const p of points) p.y = Math.fround(p.y + lift);
  }
  for (let i = 0; i < length; i += spacing) {
    const x = minX + i, end = minX + Math.min(length, i + spacing), u = (x + end) / 2 - center,
      ground = surface(u, regions(u)), previous = sectors.at(-1);
    if (previous?.surface === ground) previous.end = end;
    else sectors.push({ start: x, end, surface: ground });
  }
  item(sectors,0).start = minX - 256; item(sectors,sectors.length - 1).end = maxX + 256;
  for (const f of features) { f.start += center; f.peak += center; f.end += center; }
  return { seed, length, center, minX, maxX, material, points, sectors, features,
    rocks: features.filter(f => f.kind === 'outcrop'), spacing, ...(world ? { biomes: placedBiomes(world.regions, center) } : {}) };
}

// Samplers index this grid directly. Only the last interval may be shorter;
// accepting another spacing would extrapolate heights from unrelated segments.
function sampledGrid(points: readonly Point[], minX: number, spacing: number): boolean {
  for (let i = 2; i < points.length - 2; i++)
    if (item(points,i).x !== minX + (i - 1) * spacing) return false;
  return item(points,points.length - 2).x <= minX + (points.length - 3) * spacing;
}

// The ground is not as smooth to a running gear as its line: over the line lie bumps, which only the wheels and the
// tracks stand on (game_terrain.rs `Bumps`, of which this is the mirror), and which the rounds, the sight and the rest of
// the field know nothing of. A close view draws the line with them (`RoughGround`). They rise and fall from one knot to the
// next, a knot about every `pitch` metres along a ground, each where the ground has it within its own stretch of `pitch`:
// as waves, a knot `low` to `high` over the one before and the next under it, or as stones, a share `stones` of the knots
// a stone `low` to `high` high and the rest at the ground. They are of the place and the seed of the field alone, drawn by
// `channel`, and a stretch of one ground starts and ends level with the line, wherever another meets it. Concrete and
// asphalt have none.
interface BumpSpec { pitch: number; low: number; high: number; stones: number; channel: number }
const BUMPS: Readonly<Record<string, BumpSpec | undefined>> = Object.freeze({
  soil: { pitch: 1.4, low: .03, high: .07, stones: 0, channel: 600 },
  rock: { pitch: .7, low: .08, high: .15, stones: .12, channel: 604 },
  gravel: { pitch: .2, low: .02, high: .035, stones: 0, channel: 612 },
  sand: { pitch: 2.6, low: .04, high: .06, stones: 0, channel: 616 },
  mud: { pitch: 1.2, low: .07, high: .13, stones: 0, channel: 620 },
  graded: { pitch: 1.5, low: .005, high: .015, stones: 0, channel: 624 },
});
// The most a knot of any ground stands over the line, and under it, in metres: a stone of rock, and the trough of mud.
export const BUMPS_REACH = .15, BUMPS_DEPTH = .065;
// What is read of the bumps from `lo` to `hi` (`Terrain.underfoot`, as the core reads them under a running gear) is
// those of the whole ground there. A stretch of them drawn (`RoughGround`) is read from as far again as two of the
// longest pitches before it to as far past it, so that a place just outside it is read as the whole ground has it too.
const BUMPS_MARGIN = 5.2;
// The bumps a ground is asked for place by place (`Terrain.bump`) are read once for each `BUMPS_CELL` metres of it, while
// its roads and grounds stay the same, and no more than `BUMPS_CELLS` such stretches are kept for each ground.
interface BumpCells { roads: readonly Road[]; sectors: TerrainSector[]; cells: Map<number, RoughGround> }
const BUMPS_CELL = 32, BUMPS_CELLS = 64, bumpCells = new WeakMap<Terrain, BumpCells>();
// The knot of the stretch `cell` of a ground, in a field of `seed`, as [along, up].
function knot(bumps: BumpSpec, seed: number, cell: number): [number, number] {
  const x = (cell + .25 + .5 * terrainRandom(seed, bumps.channel, cell)) * bumps.pitch,
    size = bumps.low + (bumps.high - bumps.low) * terrainRandom(seed, bumps.channel + 1, cell);
  return [x, bumps.stones > 0 ? terrainRandom(seed, bumps.channel + 2, cell) < bumps.stones ? size : 0 : cell & 1 ? -size / 2 : size / 2];
}
// How far the bumps stand over the line at `x`, of `knots` (`Terrain.underfoot`): straight between two knots, and none
// before the first or past the last.
function bumpAt(knots: readonly number[], x: number): number {
  let low = 0, high = knots.length / 2;
  while (low < high) { const middle = (low + high) >>> 1; if (Number(knots[2 * middle]) <= x) low = middle + 1; else high = middle; }
  if (low === 0 || 2 * low >= knots.length) return 0;
  const ax = Number(knots[2 * low - 2]), ay = Number(knots[2 * low - 1]);
  return ay + (Number(knots[2 * low + 1]) - ay) * (x - ax) / (Number(knots[2 * low]) - ax);
}
// Share the same bounded stretches for a height and for an outline read under a tool.
function underfootCell(terrain: Terrain, x: number): RoughGround {
  let read = bumpCells.get(terrain);
  if (!read || read.roads !== terrain.roads || read.sectors !== terrain.sectors)
    bumpCells.set(terrain, read = { roads: terrain.roads, sectors: terrain.sectors, cells: new Map<number, RoughGround>() });
  const cell = Math.floor(x / BUMPS_CELL);
  let rough = read.cells.get(cell);
  if (!rough) {
    if (read.cells.size >= BUMPS_CELLS) read.cells.clear();
    read.cells.set(cell, rough = new RoughGround(terrain, cell * BUMPS_CELL, (cell + 1) * BUMPS_CELL));
  }
  return rough;
}
// Every change of slope of the line and its bumps, including the two requested ends.
function groundSection(terrain: Pick<Terrain, 'points'>, knots: readonly number[], a: number, b: number, height: HeightAt): Point[] {
  const points = terrain.points, out = [{ x: a, y: height(a) }];
  let p = 0, high = points.length;
  while (p < high) { const middle = (p + high) >>> 1; if (item(points,middle).x <= a) p = middle + 1; else high = middle; }
  let k = 0; high = knots.length / 2;
  while (k < high) { const middle = (k + high) >>> 1; if (Number(knots[2 * middle]) <= a) k = middle + 1; else high = middle; }
  for (;;) {
    const corner = p < points.length ? item(points,p).x : Infinity, knot = 2 * k < knots.length ? Number(knots[2 * k]) : Infinity, x = Math.min(corner, knot);
    if (!(x < b)) break;
    out.push({ x, y: height(x) });
    if (corner === x) p++;
    if (knot === x) k++;
  }
  out.push({ x: b, y: height(b) });
  return out;
}
// The ground as a running gear stands on it, read wherever it is asked: `terrain` with the bumps over its line
// (`Terrain.bump`). What a near view stands on the ground stands on that: the shadow of a gear, its road wheels, its marks.
export function underfootGround(terrain: Terrain): Terrain {
  const ground: Terrain = Object.create(terrain, {
    height: { value: (x: number): number => terrain.height(x) + terrain.bump(x) },
    surface: { value: (x: number): TerrainSurface => { const surface = terrain.surface(x); surface.y += terrain.bump(x); return surface; } },
    section: { value: (a: number, b: number): Point[] => {
      const out: Point[] = [];
      let from = a;
      do {
        const to = Math.min(b, (Math.floor(from / BUMPS_CELL) + 1) * BUMPS_CELL),
          section = underfootCell(terrain, from).section(from, to);
        out.push(...(out.length ? section.slice(1) : section));
        from = to;
      } while (from < b);
      return out;
    } },
  });
  return ground;
}
// The ground between two places as a running gear stands on it, and a near view draws it: the line of `terrain` with the
// bumps over it (`Terrain.underfoot`), read once for the whole stretch.
export class RoughGround {
  declare terrain: Terrain;
  declare knots: number[];
  constructor(terrain: Terrain, left: number, right: number) { this.terrain = terrain; this.knots = terrain.underfoot(left - BUMPS_MARGIN, right + BUMPS_MARGIN); }
  bump(x: number): number { return bumpAt(this.knots, x); }
  // As high as the line is drawn at a place (`Terrain.surface`), and its bumps over it.
  height(x: number): number {
    const points = this.terrain.points, i = this.terrain.segmentIndex(x), a = item(points,i), b = item(points,i + 1);
    return a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x) + bumpAt(this.knots, x);
  }
  // Its outline from `a` to `b`: the two ends, and every corner of the line and knot of the bumps between them, each as
  // high as the ground is there.
  section(a: number, b: number): Point[] {
    return groundSection(this.terrain, this.knots, a, b, x => this.height(x));
  }
}

// The existing projection gate also admits explicit profiles supplied to the constructor.
function acceptedSnapshot(snapshot: TerrainSnapshot | TerrainOptions | null | undefined): snapshot is TerrainSnapshot {
  if (!snapshot || !snapshot.id || !Object.hasOwn(TERRAIN_PROFILES, snapshot.id) || !Array.isArray(snapshot.points) ||
      snapshot.points.length < 3 || !Array.isArray(snapshot.sectors) || !snapshot.sectors.length ||
      !(['seed', 'length', 'center', 'spacing', 'minX', 'maxX'] satisfies (keyof TerrainSnapshot)[]).every(k => Number.isFinite(snapshot[k])) ||
      !(Number(snapshot.spacing) > 0 && Number(snapshot.maxX) > Number(snapshot.minX)) ||
      item(snapshot.points,1).x !== snapshot.minX || item(snapshot.points,snapshot.points.length - 2).x !== snapshot.maxX ||
      snapshot.points.some((p, i, a) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || i > 0 && p.x <= item(a,i - 1).x) ||
      !sampledGrid(snapshot.points, Number(snapshot.minX), Number(snapshot.spacing)) ||
      snapshot.sectors.some((s, i, a) => !Number.isFinite(s.start) || !Number.isFinite(s.end) || !(s.end > s.start) ||
        typeof s.surface !== 'string' || i > 0 && s.end < item(a,i - 1).end)) return false;
  return true;
}

// One shared piecewise-linear surface for native contacts, projectile CCD,
// trajectory previews, traction and drawing. The workshop/spawn pad stays flat.
export class Terrain {
  declare id: TerrainId;
  declare material: string;
  declare seed: number;
  declare length: number;
  declare center: number;
  declare spacing: number;
  declare minX: number;
  declare maxX: number;
  declare minHeight: number;
  declare points: Point[];
  declare sectors: TerrainSector[];
  declare features: TerrainFeature[];
  declare rocks: TerrainRock[];
  declare roads: readonly Road[];
  declare profiles: (SegmentProfile | undefined)[];
  declare biomes?: TerrainRegion[];
  declare whole?: TerrainRegion;
  static fromSnapshot(snapshot: TerrainSnapshot | TerrainOptions | null | undefined): Terrain {
    if (!acceptedSnapshot(snapshot)) throw new Error('Projeção de terreno inválida.');
    // Hydrate the already admitted projection without constructing another map.
    const terrain: Terrain = Object.assign(Object.create(Terrain.prototype), snapshot, { profiles: [], roads: NO_ROADS });
    terrain.minHeight = lowest(terrain.points);
    // These features only decorate the already accepted polyline. They never
    // participate in admission, height sampling or physical contacts.
    const layout = BATTLE_TERRAIN_IDS.includes(terrain.id) ? landscapeLayout(terrain.id, terrain.seed, terrain.length) : null;
    terrain.features = layout ? layout.features
      .map(f => ({ ...f, start: f.start + terrain.center, peak: f.peak + terrain.center, end: f.end + terrain.center })) : [];
    if (layout?.regions) terrain.biomes = placedBiomes(layout.regions, terrain.center);
    terrain.rocks = BATTLE_TERRAIN_IDS.includes(terrain.id) ? terrain.features.filter(f => f.kind === 'outcrop') : [
      ...(terrain.id === 'mixed' ? MIXED_ROCKS : []),
      ...(['mixed', 'rough'].includes(terrain.id) ? FAR_SECTIONS.flatMap(s => (terrain.id === 'mixed' ? [57] : [24, 56]).map(offset => ({
        start: s.start + offset, peak: s.start + offset + 1.5, end: s.start + offset + 3, height: .24 + (s.index % 3) * .07,
      }))).filter(r => r.end < FAR_MAX - 8) : []),
    ];
    return terrain;
  }
  constructor(id?: string | TerrainOptions, options?: TerrainOptions);
  constructor(id: string | TerrainOptions = 'flat', options: TerrainOptions = {}) {
    if (typeof id === 'object' && id) { options = id; id = options.id || 'flat'; }
    if (!isTerrainId(id)) throw new Error('Terreno desconhecido.');
    // The roads a field lays over this ground (roads.ts): none until it lays some.
    this.roads = NO_ROADS;
    if (options.points) { Object.assign(this, Terrain.fromSnapshot({ ...options, id })); return; }
    this.id = id; this.material = TERRAIN_PROFILES[id].surface;
    if (TERRAIN_PROFILES[id].battle) {
      Object.assign(this, landscape(id, options));
      this.minHeight = lowest(this.points); this.profiles = []; return;
    }
    this.seed = 0; this.length = FAR_MAX - FAR_MIN; this.center = (FAR_MAX + FAR_MIN) / 2; this.features = [];
    this.minX = FAR_MIN; this.maxX = FAR_MAX; this.spacing = .5;
    this.sectors = id === 'mixed' ? [
      { start: -1600, end: FAR_MIN, surface: 'soil' },
      ...MIXED_SECTORS.map(s => ({ ...s, start: Math.max(-64, s.start), end: Math.min(96, s.end) })).filter(s => s.start < s.end),
      ...FAR_SECTIONS.flatMap(s => FAR_SURFACES.map(part => ({ ...part,
        start: s.start + part.offset, end: Math.min(FAR_MAX, s.start + part.end) }))).filter(s => s.start < s.end),
      { start: FAR_MAX, end: 1600, surface: 'soil' },
    ].sort((a, b) => a.start - b.start) : [{ start: -1600, end: 1600, surface: this.material }];
    this.rocks = [ ...(id === 'mixed' ? MIXED_ROCKS : []),
      ...(['mixed', 'rough'].includes(id) ? FAR_SECTIONS.flatMap(s => (id === 'mixed' ? [57] : [24, 56]).map(offset => ({
        start: s.start + offset, peak: s.start + offset + 1.5, end: s.start + offset + 3,
        height: .24 + (s.index % 3) * .07,
      }))).filter(r => r.end < FAR_MAX - 8) : []),
    ];
    this.points = [{ x: -1600, y: 0 }];
    for (let x = this.minX; x <= this.maxX; x += this.spacing) {
      let y = 0;
      if (id === 'mixed') {
        y = mound(x, 16, 22, 24, 28, .45) - mound(x, 34, 37, 42, 45, .22) +
          mound(x, 45, 50, 51, 56, .58) + mound(x, 56, 61, 62, 67, .85) +
          mound(x, 65, 72, 76, 84, 1.6) - mound(x, -11, -9, -6, -3, .16) +
          mound(x, -22, -18, -17, -12, .5) + mound(x, -33, -28, -26, -20, 1.2);
        y += mound(x, 28, 30, 30.5, 33, .10);
      } else if (id === 'sand') {
        y = mound(x, 18, 24, 25, 31, .52) + mound(x, 33, 39, 40, 47, .75) +
          mound(x, -30, -24, -23, -16, .5);
      } else if (id !== 'flat' && id !== 'mud') {
        y = mound(x, 17, 28, 32, 44, 1.8) + mound(x, 46, 55, 57, 68, 1.15) +
          mound(x, -29, -21, -17, -7, 1.4) + mound(x, 73, 79, 80, 89, .7);
        if (id === 'rough') y += mound(x, 18, 20.5, 21, 23.5, .4) +
          mound(x, 29, 31, 32, 34, .3) + mound(x, 48, 50, 50.5, 52.5, .3);
      }
      // The original workshop section and its regression fixtures stay exact.
      if (x < -64 || x >= 96) y = farHeight(id, x);
      for (const rock of this.rocks) y += rockHeight(x, rock);
      // A height is a single-precision number: the surface the core grows too, and the one the fixtures hold.
      this.points.push({ x, y: Math.fround(y) });
    }
    this.points.push({ x: 1600, y: 0 });
    this.minHeight = lowest(this.points);
    this.profiles=[];
  }
  descriptor(): Omit<TerrainSnapshot, 'features' | 'rocks'> { return { id: this.id, seed: this.seed, length: this.length, center: this.center, spacing: this.spacing,
    material: this.material, points: this.points, sectors: this.sectors, minX: this.minX, maxX: this.maxX }; }
  snapshot(): TerrainSnapshot { return { ...this.descriptor(), features: this.features, rocks: this.rocks }; }
  // A landscape is its seed, length and centre; a laboratory track is its explicit outline.
  reference(): Pick<TerrainSnapshot, 'seed' | 'length' | 'center'> | TerrainSnapshot {
    const profile = TERRAIN_PROFILES[this.id];
    return profile.battle ? { seed: this.seed, length: this.length, center: this.center } : this.snapshot();
  }
  // The stretch of one biome the ground at x lies in: the whole landscape, or a region of the world.
  regionAt(x: number): TerrainRegion {
    if (!this.biomes) return this.whole ||= { id: this.id, start: item(this.points, 0).x, end: item(this.points, this.points.length - 1).x };
    let i = 0; while (i < this.biomes.length - 1 && item(this.biomes, i).end <= x) i++;
    return item(this.biomes, i);
  }
  biomeAt(x: number): TerrainId { return this.regionAt(x).id; }
  // The ground itself at a place, as it lies: what it is painted as.
  materialAt(x: number): string {
    let lo=0,hi=this.sectors.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(item(this.sectors,mid).end<=x)lo=mid+1;else hi=mid;}
    const sector=this.sectors[lo];return sector&&x>=sector.start?sector.surface:this.material;
  }
  // What a running gear, a round and a burst meet at a place: the road laid there, or the ground itself (game_terrain.rs `material_at`).
  groundAt(x: number): string { return roadAt(this.roads, x) ?? this.materialAt(x); }
  // The stretch of one ground a place lies in (`groundAt`, game_terrain.rs `stretch`): [where it starts, where it ends, of what].
  stretch(x: number): [number, number, string] {
    const roads = this.roads, sectors = this.sectors;
    let r = 0, high = roads.length;
    while (r < high) { const middle = (r + high) >>> 1; if (item(roads,middle).x1 <= x) r = middle + 1; else high = middle; }
    const road = roads[r];
    if (road && x >= road.x0) return [road.x0, road.x1, road.kind];
    const before = r > 0 ? item(roads,r - 1).x1 : -Infinity, after = roads[r]?.x0 ?? Infinity;
    let i = 0; high = sectors.length;
    while (i < high) { const middle = (i + high) >>> 1; if (item(sectors,middle).end <= x) i = middle + 1; else high = middle; }
    const sector = sectors[i], interval: [number, number, string] = sector && x >= sector.start ? [sector.start, sector.end, sector.surface] :
      [i > 0 ? item(sectors,i - 1).end : -Infinity, sector?.start ?? Infinity, this.material], [start, end, ground] = interval;
    return [Math.max(start, before), Math.min(end, after), ground];
  }
  // The bumps of the ground (`BUMPS`) under a running gear standing on it from `lo` to `hi` (game_terrain.rs `underfoot`):
  // the knots of each ground with them there, in order along it, and one on the line where each such ground starts and
  // ends, as [along, up, along, up, ...].
  underfoot(lo: number, hi: number): number[] {
    const knots: number[] = [], push = (x: number, y: number): void => { if (!knots.length || x > Number(knots[knots.length - 2])) knots.push(x, y); };
    for (let from = lo; ;) {
      const [start, end, ground] = this.stretch(from), bumps = BUMPS[ground];
      if (bumps) {
        if (Number.isFinite(start)) push(start, 0);
        // The knot of a stretch of `pitch` lies within it: from the last knot before `lo` to the first past `hi`. Those
        // within half a pitch of an end of the ground are left out, so by its end the last knot before `lo` may be two
        // stretches back, and by its start the first past `hi` two on.
        for (let cell = Math.floor(from / bumps.pitch) - 2, last = Math.floor(Math.min(hi, end) / bumps.pitch) + 2; cell <= last; cell++) {
          const [x, y] = knot(bumps, this.seed, cell);
          if (x > start + .5 * bumps.pitch && x < end - .5 * bumps.pitch) push(x, y);
        }
        if (Number.isFinite(end)) push(end, 0);
      }
      if (end >= hi) break;
      from = end;
    }
    return knots;
  }
  // How far the bumps of the ground stand over its line at a place: those of the stretch of `BUMPS_CELL` it lies in.
  bump(x: number): number {
    return underfootCell(this, x).bump(x);
  }
  section(a: number, b: number): Point[] { return groundSection(this, [], a, b, x => this.height(x)); }
  segmentIndex(x: number): number {return x<this.minX?0:x>=this.maxX?this.points.length-2:1+Math.floor((x-this.minX)/this.spacing);}
  segment(x: number): [Point, Point] {const i=this.segmentIndex(x);return [item(this.points,i),item(this.points,i+1)];}
  profile(x: number): SegmentProfile {
    const i=this.segmentIndex(x),a=item(this.points,i),b=item(this.points,i+1);let p=this.profiles[i];
    // Terrain normals are derived from immutable map segments. Comparing the
    // endpoints also keeps edited test/custom terrain exact, without stale LOS.
    if(!p||p.a!==a||p.b!==b||p.ay!==a.y||p.by!==b.y) {
      const slope=(b.y-a.y)/(b.x-a.x),scale=Math.hypot(1,slope);
      this.profiles[i]=p={a,b,ay:a.y,by:b.y,slope,nx:-slope/scale,ny:1/scale};
    }
    return p;
  }
  surface(x: number): TerrainSurface {
    const p=this.profile(x);
    return {x,y:p.a.y+(x-p.a.x)*p.slope,slope:p.slope,nx:p.nx,ny:p.ny,
      tx:p.ny,ty:-p.nx,surface:this.groundAt(x)};
  }
  height(x: number): number {
    if (x <= this.minX) return item(this.points,1).y;
    if (x >= this.maxX) return item(this.points,this.points.length - 2).y;
    const index = 1 + Math.floor((x - this.minX) / this.spacing), a = item(this.points,index), b = item(this.points,index + 1);
    return a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x);
  }
  raycast(start: Point, end: Point): TerrainRaycast | null {
    const dx = end.x - start.x, dy = end.y - start.y;
    if (start.y < this.height(start.x) - 1e-6) {
      const surface = this.surface(start.x);
      return { enter: 0, x: start.x, y: surface.y, nx: surface.nx, ny: surface.ny, surface: surface.surface };
    }
    if (this.id === 'flat') {
      if (dy >= 0 || end.y > 1e-8) return null;
      const t = -start.y / dy;
      return t >= -1e-8 && t <= 1 + 1e-8 ?
        { enter: clamp(t, 0, 1), x: start.x + dx * t, y: 0, nx: 0, ny: 1, surface: this.groundAt(start.x + dx * t) } : null;
    }
    let first: TerrainRaycast | null = null;
    const low = Math.min(start.x, end.x), high = Math.max(start.x, end.x);
    const indexAt = (x: number): number => x < this.minX ? 0 : x >= this.maxX ? this.points.length - 2 :
      1 + Math.floor((x - this.minX) / this.spacing);
    for (let i = Math.max(0, indexAt(low) - 1); i <= indexAt(high); i++) {
      const a = item(this.points,i), b = item(this.points,i + 1);
      if (a.x > high || b.x < low) continue;
      const sx = b.x - a.x, sy = b.y - a.y, den = dx * sy - dy * sx;
      if (Math.abs(den) < 1e-14) continue;
      const t = ((a.x - start.x) * sy - (a.y - start.y) * sx) / den,
        u = ((a.x - start.x) * dy - (a.y - start.y) * dx) / den;
      if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8 || first && t >= first.enter) continue;
      const scale = Math.hypot(sx, sy), nx = -sy / scale, ny = sx / scale;
      if (dx * nx + dy * ny >= 0) continue;
      const x = start.x + dx * t;
      first = { enter: clamp(t, 0, 1), x, y: start.y + dy * t, nx, ny, surface: this.groundAt(x) };
    }
    return first;
  }
}
