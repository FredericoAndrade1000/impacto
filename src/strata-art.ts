import type { TerrainPaintGround } from './terrain-art.ts';
import type { Point } from './math.ts';
import type { Terrain, TerrainId, TerrainRegion } from './terrain.ts';
import type { XY } from './canvas-art.ts';
interface EarthLook { span: number; wave: number; bands: number; beds: [number, number][] }
type GrainKind = 'soil' | 'rock' | 'concrete';
interface MaterialPart { x: number; y: number; positions: number[]; uvs: number[]; indices: number[] }
export interface MaterialMesh { x: number; y: number; positions: Float32Array; uvs: Float32Array; indices: Uint32Array }
export interface StrataPlan { terrain: TerrainPaintGround; regions: readonly TerrainRegion[]; looks: EarthLook[]; coordinate(x: number): number; look(x: number, field: 'span' | 'wave'): number; relief: GroundRelief; width: number; height: number }
import { BufferImageSource, Texture } from 'pixi.js';
import { Random, clamp, lerp, smoothstep, lineNoise } from './math.ts';
import { TERRAIN_PROFILES, WORLD_BLEND } from './terrain.ts';
import { SLAB, ruinFloor, ruinEarth } from './ruins-art.ts';
import { simplifyGround, outlineError } from './terrain-lod.ts';

// The earth under the ground, seen in cross-section. It is beds that follow the surface, each about two
// and a half times as deep as the one above it: whatever the scale of the view, a few of them cross the
// screen, and the deeper a bed lies the less of the relief above it shows in it. The native colour mesh
// owns the beds and buried clasts; compact material meshes repeat their grain in metres, independently
// of bed thickness. Nothing here is geometry a vehicle, a sensor or a round ever meets.
export const BED_TOPS = Object.freeze([0, 2.4, 6, 15, 38, 95, 240, 600, 1500]);
const BEDS = BED_TOPS.length;
// Metres between the columns of each bed: a deep one needs few.
const BED_STEPS = [2, 2, 4, 8, 16, 32, 64, 128, 256];
// A bed is never squeezed under this share of its thickness, and reaches this share of it under the top
// of the next: beds of different columns then leave no slit between them.
const PINCH = .3, UNDERLAP = .15;
// The top bed hangs this far under the outline the surface is drawn with, and strays from that outline by
// no more than the other: well inside the first two metres painted over it (terrain-art.ts), however
// steep the ground, so that no sky shows between them.
const TOP = .35, TOP_ERROR = .1;
// Each stretch reaches this far under the next one: two meshes that only shared an edge could let the sky through.
export const STRATA_LAP = .05;
// How far along the ground the undulation of a bed runs, in depths of the bed.
const WAVE_REACH = 6;
const ROWS = 128;
const ROCK_ROWS = 3;
export const GRAIN_PERIODS = Object.freeze({ soil: 3.2, rock: 4.8, concrete: 2.4 });

// What the earth of a biome is made of, from the surface down: the tone at the top and at the foot of each
// bed. `span` is how far around a place a bed averages the relief, in depths of the bed, and `wave` how
// much it undulates of its own: folded in the serras, flat under the chapadas. `bands` is how many thin
// beds of another tone run inside each.
const EARTH: Readonly<Record<string, EarthLook | undefined>> = Object.freeze({
  'wet-valley': { span: 2.5, wave: .16, bands: 2, beds: [[0x4f5443, 0x4a4f40], [0x5f5a47, 0x565240], [0x6c6652, 0x5f5b4a], [0x55594d, 0x4a4f46], [0x4d5550, 0x454c48]] },
  'rural-ridges': { span: 3, wave: .14, bands: 2, beds: [[0x565441, 0x504e3e], [0x665d47, 0x5c5541], [0x787059, 0x6a644f], [0x6a6858, 0x5c5b4e], [0x595b50, 0x4e5049]] },
  highlands: { span: 2, wave: .3, bands: 1, beds: [[0x525545, 0x4c4f42], [0x5d5e50, 0x55574b], [0x62665d, 0x565b53], [0x565c57, 0x4b514d], [0x4d5351, 0x454b49]] },
  'arid-basin': { span: 6, wave: .1, bands: 3, beds: [[0x8a7a56, 0x7f704f], [0x8b7b5a, 0x7d6f52], [0x968667, 0x85775b], [0x7c6e55, 0x6c604b], [0x6d6150, 0x5a5348]] },
  plateau: { span: 30, wave: .05, bands: 5, beds: [[0x6b624d, 0x645b48], [0x7a6a50, 0x6f6049], [0x8a7558, 0x7b694f], [0x77614a, 0x6a5743], [0x6c5a48, 0x594f45]] },
  // The bench is made ground: a bed of gravel and compacted fill under the slab, the country's own earth below.
  concrete: { span: 4, wave: .08, bands: 1, beds: [[0x6a6a5c, 0x626255], [0x5f5c4b, 0x565443], [0x6f6954, 0x625d4b], [0x64635a, 0x58574d], [0x565950, 0x4c4f49]] },
});
// Under the first hundred metres every biome stands on the same rock: seen from far above, the deep earth
// is one mass with its own beds, not a column for each region.
const BASEMENT = Object.freeze([[0x525651, 0x484c49], [0x4a4e4b, 0x404443], [0x424645, 0x383c3c], [0x3a3e3e, 0x2e3232]] satisfies [number, number][]);
const OWN_BEDS = BED_TOPS.length - BASEMENT.length;
// It lies the same way under all of them too: a deep bed does not turn where one biome gives way to the next.
const BASEMENT_SPAN = 4, BASEMENT_WAVE = .12;
const SURFACE_EARTH: Record<string, string | undefined> = { soil: 'rural-ridges', mud: 'wet-valley', sand: 'arid-basin', rock: 'highlands', gravel: 'rural-ridges', concrete: 'concrete' };
const earthOf = (id: TerrainId): EarthLook => EARTH[id] || EARTH[SURFACE_EARTH[TERRAIN_PROFILES[id]?.surface] || 'rural-ridges']!;
// How deep the first beds lie under each ground: rock comes up to an outcrop, mud and sand lie thick.
const COVER: Record<string, number | undefined> = { rock: .3, concrete: .85, gravel: .9, soil: 1, mud: 1.25, sand: 1.35 };

const noise = (seed: number, channel: number, x: number) => lineNoise(seed, channel, x) * 2 - 1;

// Only buried boundaries use this depth. The shared disturbance is continuous
// in world coordinates and smaller than .22 of a shallow band, so bands cannot
// cross. A contact depth of zero stays exactly zero.
export const groundBandWave = (seed: number, x: number) => .68 * noise(seed, 141, x / 8.4) + .32 * noise(seed, 142, x / 2.6);
export function groundBandDepth(seed: number, x: number, depth: number, wave = groundBandWave(seed, x)) {
  return depth + Math.min(.28, depth * .22) * wave;
}

// The relief of a map as the beds read it: the mean height of the ground over any stretch, from one sum
// kept along the outline, and its lowest point over a short one.
export class GroundRelief {
  declare terrain: TerrainPaintGround; declare points: Point[]; declare sums: Float64Array;
  constructor(terrain: TerrainPaintGround) {
    const points = terrain.points, sums = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++)
      sums[i] = sums[i - 1]! + (points[i]!.x - points[i - 1]!.x) * (points[i]!.y + points[i - 1]!.y) / 2;
    this.terrain = terrain; this.points = points; this.sums = sums;
  }
  index(x: number) {
    const terrain = this.terrain, last = this.points.length - 2;
    return x < terrain.minX ? 0 : x >= terrain.maxX ? last : clamp(1 + Math.floor((x - terrain.minX) / terrain.spacing), 1, last - 1);
  }
  at(x: number) {
    const points = this.points, first = points[0]!, last = points.at(-1)!;
    if (x <= first.x) return first.y;
    if (x >= last.x) return last.y;
    const i = this.index(x), a = points[i]!, b = points[i + 1]!;
    return a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x);
  }
  // The area under the outline from its first point to x; past either end the ground goes on level.
  area(x: number) {
    const points = this.points, first = points[0]!, last = points.at(-1)!;
    if (x <= first.x) return (x - first.x) * first.y;
    if (x >= last.x) return this.sums.at(-1)! + (x - last.x) * last.y;
    const i = this.index(x), a = points[i]!, b = points[i + 1]!, y = a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x);
    return this.sums[i]! + (x - a.x) * (a.y + y) / 2;
  }
  mean(x: number, half: number) { return half > 0 ? (this.area(x + half) - this.area(x - half)) / (2 * half) : this.at(x); }
  // The corners of the ground from left to right, both ends included.
  outline(left: number, right: number) {
    const points = this.points, corners = [{ x: left, y: this.at(left) }];
    for (let i = this.index(left); i < points.length && points[i]!.x < right; i++) if (points[i]!.x > left) corners.push(points[i]!);
    corners.push({ x: right, y: this.at(right) });
    return corners;
  }
  low(x: number, half: number) {
    const points = this.points; let low = Math.min(this.at(x - half), this.at(x + half));
    for (let i = this.index(x - half) + 1; i < points.length && points[i]!.x < x + half; i++) if (points[i]!.y < low) low = points[i]!.y;
    return low;
  }
}

const channels = (color: number): [number, number, number] => [color >> 16 & 255, color >> 8 & 255, color & 255];

// Where a map is one biome it has one column of tones; the world has one for each of its regions, each
// with thin beds of its own, and across a border the ground reads between the two columns over the
// stretch the surface is faded over. `coordinate` is the column the ground at x reads, a region and a
// part of the way to its neighbour: the same number tells how much of each biome's earth is there.
export function strataPlan(terrain: TerrainPaintGround): StrataPlan {
  const regions = terrain.biomes?.length ? terrain.biomes : [{ id: terrain.id, start: -Infinity, end: Infinity }],
    looks = regions.map(region => earthOf(region.id)), last = regions.length - 1;
  const coordinate = (x: number) => {
    let i = 0, high = last;
    while (i < high) {
      const middle = (i + high) >>> 1;
      if (regions[middle]!.end <= x) i = middle + 1; else high = middle;
    }
    const here = regions[i]!;
    if (i > 0 && x - here.start < WORLD_BLEND) return i - 1 + smoothstep((x - here.start + WORLD_BLEND) / (2 * WORLD_BLEND));
    if (i < last && here.end - x < WORLD_BLEND) return i + smoothstep((x - here.end + WORLD_BLEND) / (2 * WORLD_BLEND));
    return i;
  };
  const look = (x: number, field: 'span' | 'wave') => {
    const at = coordinate(x), i = Math.min(last, Math.floor(at)), next = Math.min(last, i + 1);
    return lerp(looks[i]![field], looks[next]![field], at - i);
  };
  return { terrain, regions, looks, coordinate, look, relief: new GroundRelief(terrain), width: Math.max(2, regions.length), height: BEDS * ROWS + ROCK_ROWS };
}

// The tones of a plan as texels: a column for each region, a run of rows for each bed, darker downwards.
export function strataTones(plan: StrataPlan) {
  const { width, height, looks, terrain } = plan, data = new Uint8Array(width * height * 4);
  for (let column = 0; column < width; column++) {
    // A map of one biome has a second column only because a texture is two texels wide: it is the first again.
    const region = Math.min(column, looks.length - 1), look = looks[region]!, local = new Random((terrain.seed ^ 0x51ed270b ^ Math.imul(region + 1, 0x9e3779b1)) >>> 0),
      shared = new Random((terrain.seed ^ 0x2f6b3a1d) >>> 0),
      // No two regions of one biome are quite the same earth.
      cast = looks.length > 1 ? local.range(-.035, .035) : 0;
    for (let bed = 0; bed < BEDS; bed++) {
      const own = bed < OWN_BEDS, random = own ? local : shared, [top, foot] = (own ? look!.beds[bed]! : BASEMENT[bed - OWN_BEDS]!).map(channels), bands = [];
      for (let i = 0; i < (own ? look.bands : 5); i++) {
        const at = random.range(.08, .92), thick = random.range(.012, own ? .05 : .07), shift = random.range(.05, own ? .1 : .13) * (random.next() < .5 ? -1 : 1);
        bands.push({ from: at - thick, to: at + thick, shift });
      }
      const below = bed === BEDS - 1 ? (BASEMENT.at(-1)![1]) : bed + 1 < OWN_BEDS ? look!.beds[bed + 1]![0] : BASEMENT[bed + 1 - OWN_BEDS]![0],
        next = channels(below);
      for (let row = 0; row < ROWS; row++) {
        const t = row / (ROWS - 1), band = bands.reduce((sum, b) => {
          const soft = (b.to - b.from) * .45;
          return sum + b.shift * .55 * smoothstep((t - b.from) / soft) * smoothstep((b.to - t) / soft);
        }, 0), gain = 1 + (own ? cast : 0) + band,
          join = smoothstep((t - .82) / .18),
          at = ((bed * ROWS + row) * width + column) * 4;
        for (let k = 0; k < 3; k++) data[at + k] = clamp(Math.round(lerp(lerp(top![k]!, foot![k]!, t) * gain, next[k]! * (1 + (bed + 1 < OWN_BEDS ? cast : 0)), join)), 0, 255);
        data[at + 3] = 255;
      }
    }
    const stone = channels(look!.beds[2]![0]);
    for (let row = 0; row < ROCK_ROWS; row++) {
      const at = ((BEDS * ROWS + row) * width + column) * 4, gain = [.86, .99, 1.06][row]!;
      for (let k = 0; k < 3; k++) data[at + k] = Math.round(stone[k]! * gain);
      data[at + 3] = 255;
    }
  }
  return data;
}
export function strataTexture(plan: StrataPlan) {
  return new Texture({ source: new BufferImageSource({ resource: strataTones(plan), width: plan.width, height: plan.height,
    format: 'rgba8unorm', alphaMode: 'no-premultiply-alpha', scaleMode: 'linear', addressMode: 'clamp-to-edge' }) });
}

// The top of every bed at x, from the surface down, into `lines`; one more entry is the foot of the earth.
// The first lies just under the ground. Each under it is the ground averaged over a stretch that grows
// with its depth, lowered by that depth and by a slow undulation, and never nearer the one above than a
// bed may be squeezed; the second is reckoned from the lowest ground about its column, so that a straight
// run between two columns never comes up out of the ground. A bed asks for no more than its own top and
// the next: `last` is the deepest line wanted.
export function bedLines(plan: StrataPlan, x: number, floor: number, lines: Float64Array = new Float64Array(BEDS + 1), last = BEDS) {
  const { relief, terrain } = plan, span = plan.look(x, 'span'), wave = plan.look(x, 'wave');
  // A shared world grid turns the old seven abrupt material probes into a
  // continuous cover estimate, including at biome and sector boundaries.
  const base = Math.floor(x / 2) * 2, phase = smoothstep((x - base) / 2);
  let cover = 0;
  for (let k = -2; k <= 3; k++) cover += COVER[terrain.materialAt(base + k * 2)] ?? 1;
  cover += (COVER[terrain.materialAt(base - 6)] ?? 1) * (1 - phase) + (COVER[terrain.materialAt(base + 8)] ?? 1) * phase;
  cover /= 7;
  lines[0] = relief.at(x) - TOP;
  let above = relief.low(x, BED_STEPS[0]!) - TOP;
  for (let bed = 1; bed < BEDS && bed <= last; bed++) {
    const depth = BED_TOPS[bed]!, share = bed < 4 ? lerp(cover, 1, (bed - 1) / 3) : 1, own = bed < OWN_BEDS,
      fold = own ? Math.min(1.1, depth * .14) * (.7 * noise(terrain.seed, 91 + bed, x / (7 + depth * 1.3)) +
        .3 * noise(terrain.seed, 111 + bed, x / (2.5 + depth * .45))) : 0,
      sheet = relief.mean(x, (own ? span : BASEMENT_SPAN) * depth) - depth * share + fold +
        (own ? wave : BASEMENT_WAVE) * depth * share * noise(terrain.seed, 60 + bed, x / (WAVE_REACH * depth));
    above = lines[bed] = Math.min(sheet, above - PINCH * (depth - BED_TOPS[bed - 1]!) * Math.min(1, share));
  }
  if (last >= BEDS) lines[BEDS] = Math.min(floor, lines[BEDS - 1]! - 100);
  return lines;
}

// Natural grain is oblique to the map axes, so its square tile does not form
// obvious horizontal rows. This rotation keeps its physical scale exactly and
// is prepared in the UVs, with no extra samples or frame-time work.
const GRAIN_AXES: Record<string, [number, number]> = Object.fromEntries(Object.entries({ soil: .43, rock: -.61, concrete: 0 })
  .map(([kind, angle]) => [kind, [Math.cos(angle), Math.sin(angle)] satisfies [number, number]]));
// Both UV axes keep a small phase at the chunk anchor, even far from the origin.
const phaseAt = (x: number, period: number) => ((x % period) + period) % period / period;
const materialGeometry = (x: number): MaterialPart => ({ x, y: 0, positions: [], uvs: [], indices: [] });
function materialVertex(part: MaterialPart, kind: GrainKind, x: number, y: number) {
  const period = GRAIN_PERIODS[kind], [c, s] = GRAIN_AXES[kind]!, local = x - part.x;
  part.positions.push(x - part.x, y);
  part.uvs.push(phaseAt(part.x * c, period) + (local * c + y * s) / period,
    phaseAt(part.x * s, period) + (local * s - y * c) / period);
}
function completed(part: MaterialPart): MaterialMesh {
  return { ...part, positions: new Float32Array(part.positions), uvs: new Float32Array(part.uvs), indices: new Uint32Array(part.indices) };
}
function columns(left: number, right: number, step: number) {
  const xs = [left];
  for (let x = (Math.floor(left / step) + 1) * step; x < right; x += step) xs.push(x);
  xs.push(right);
  return xs;
}

// Both boundaries retain their actual piecewise-linear shape. Their union of
// x coordinates gives simple vertical quads, including on steep valley walls;
// reusing the next bed's top leaves no grain overlap or crack.
function materialBand(part: MaterialPart, kind: GrainKind, top: readonly XY[], foot: readonly XY[]) {
  const xs = [...new Set([...top, ...foot].map(p => p[0]))].sort((a, b) => a - b), first = part.positions.length / 2;
  let a = 0, b = 0;
  for (const [i, x] of xs.entries()) {
    while (a + 2 < top.length && top[a + 1]![0] < x) a++;
    while (b + 2 < foot.length && foot[b + 1]![0] < x) b++;
    const high = lerp(top[a]![1], top[a + 1]![1], (x - top[a]![0]) / (top[a + 1]![0] - top[a]![0])),
      low = lerp(foot[b]![1], foot[b + 1]![1], (x - foot[b]![0]) / (foot[b + 1]![0] - foot[b]![0]));
    materialVertex(part, kind, x, high); materialVertex(part, kind, x, low);
    if (i) {
      const k = first + (i - 1) * 2;
      part.indices.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
    }
  }
}

function clippedRock(points: XY[], left: number, right: number): XY[] {
  for (const [edge, sign] of [[left, 1], [right, -1]] satisfies XY[]) {
    const next: XY[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!, inside = (a[0] - edge) * sign >= 0,
        after = (b[0] - edge) * sign >= 0;
      if (inside) next.push(a);
      if (inside !== after) {
        const t = (edge - a[0]) / (b[0] - a[0]);
        next.push([edge, lerp(a[1], b[1], t)]);
      }
    }
    points = next;
  }
  return points;
}

// Clasts belong to metre cells of the map, not to chunks or LODs. A chunk clips
// only the part it owns, so a pebble straddling its edge remains one pebble.
// The coarse view retains only large clasts, then omits subpixel detail.
function buriedRocks(plan: StrataPlan, left: number, right: number, minStep: number, positions: number[], tones: number[], indices: number[], grain: MaterialPart | null) {
  if (minStep >= 32) return 0;
  let count = 0;
  for (let cell = Math.floor(left - .6); cell <= Math.ceil(right + .6); cell++) {
    const random = new Random((plan.terrain.seed ^ 0x3c6ef372 ^ Math.imul(cell, 0x85ebca6b)) >>> 0),
      stones = 1 + Number(random.next() < .6) + Number(random.next() < .04);
    for (let k = 0; k < stones; k++) {
      const x = cell + random.range(.04, .96), width = .1 + .7 * random.next() ** 2.2,
        aspect = random.range(.45, .95), angle = random.range(-.9, .9), depth = .3 + 14 * random.next() ** 1.8,
        reach = width * .56, y = plan.relief.low(x, reach) - depth - reach, corners = 6 + Number(random.next() < .55),
        cs = Math.cos(angle), sn = Math.sin(angle), outline: XY[] = [];
      for (let i = 0; i < corners; i++) {
        const theta = i / corners * Math.PI * 2, radius = random.range(.88, 1.08),
          u = Math.cos(theta) * width * .5 * radius, v = Math.sin(theta) * width * .5 * aspect * radius;
        outline.push([x + cs * u - sn * v, y + sn * u + cs * v]);
      }
      if (minStep > 0 && width < .6 || x + reach <= left || x - reach >= right) continue;
      const polygon = x - reach >= left && x + reach <= right ? outline : clippedRock(outline, left, right);
      if (polygon.length < 3) continue;
      const center = polygon.reduce<XY>((sum, p) => [sum[0] + p[0] / polygon.length, sum[1] + p[1] / polygon.length], [0, 0]),
        points = [center, ...polygon], first = positions.length / 2, materialFirst = grain ? grain.positions.length / 2 : 0,
        u = (plan.coordinate(x) + .5) / plan.width;
      for (const [i, p] of points.entries()) {
        const tone = i ? p[1] > y ? 2 : 0 : 1;
        positions.push(p[0] - left, p[1]);
        tones.push(u, (BEDS * ROWS + tone + .5) / plan.height);
        if (grain) materialVertex(grain, 'rock', p[0], p[1]);
      }
      for (let i = 1; i <= polygon.length; i++) {
        const next = i === polygon.length ? 1 : i + 1;
        indices.push(first, first + i, first + next);
        if (grain) grain.indices.push(materialFirst, materialFirst + i, materialFirst + next);
      }
      count++;
    }
  }
  return count;
}

// Native beds retain a tiny opaque underlap to cover raster edge precision.
// Material boundaries instead share their exact polylines: the physical grain
// neither stretches with a bed nor paints its underlap twice. Nothing of another
// tone lies behind the beds: a GPU may rasterise the seam of two stretches a hair
// differently for a backing than for the bed over it, and the backing then shows
// through as a thin pale line down the earth.
export function buildStrata(plan: StrataPlan, left: number, right: number, floor: number, minStep = 0, withGrain = true) {
  // Native geometry is always complete; material meshes are prepared only for a caller that draws them.
  const positions: number[] = [], tones: number[] = [], indices: number[] = [], samples = new Map<number, { lines: Float64Array; u: number }>(), boundaries: XY[][] | null = withGrain ? new Array(BEDS + 1) : null,
    grain = withGrain ? { soil: materialGeometry(left), rock: materialGeometry(left) } : null,
    clastGrain = withGrain ? materialGeometry(left) : null,
    { width, height } = plan, column = (x: number) => (plan.coordinate(x) + .5) / width;
  const sampled = (x: number, last: number) => {
    let value = samples.get(x);
    if (!value) {
      value = { lines: bedLines(plan, x, floor, new Float64Array(BEDS + 1), last), u: column(x) };
      samples.set(x, value);
    }
    return value;
  };
  const strip = (xs: readonly number[], corner: (x: number) => void) => {
    const first = positions.length / 2;
    for (const x of [...xs, right + STRATA_LAP]) corner(x);
    for (let i = 0; i < xs.length; i++) {
      const a = first + i * 2;
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  };
  // The top bed hangs from the outline the surface is drawn with, at every corner of it. Under it, it meets
  // the next bed on the straight runs between that bed's columns, as each bed meets the one below.
  const outline = simplifyGround(plan.relief.outline(left, right), Math.max(outlineError(minStep), TOP_ERROR));
  const topBed = (grid: readonly number[], thick: number) => {
    let g = 0, o = 0;
    return (x: number): [number, number, number] => {
      if (x > right) return [plan.relief.at(x) - TOP, sampled(x, 1).lines[1]! - UNDERLAP * thick, column(x)];
      while (grid[g + 1]! < x) g++;
      while (outline[o + 1]!.x < x) o++;
      const a = outline[o]!, b = outline[o + 1]!, before = sampled(grid[g]!, 1).lines[1]!, after = sampled(grid[g + 1]!, 1).lines[1]!;
      return [lerp(a.y, b.y, (x - a.x) / (b.x - a.x)) - TOP, lerp(before, after, (x - grid[g]!) / (grid[g + 1]! - grid[g]!)) - UNDERLAP * thick, column(x)];
    };
  };
  for (let bed = BEDS - 1; bed >= 0; bed--) {
    const grid = columns(left, right, Math.max(BED_STEPS[bed]!, minStep)),
      thick = (BED_TOPS[bed + 1]! ?? Infinity) - BED_TOPS[bed]!,
      top = (bed * ROWS + .5) / height, foot = ((bed + 1) * ROWS - .5) / height,
      boundary: XY[] | null = withGrain ? (boundaries![bed] = []) : null,
      corner = bed ? (x: number): [number, number, number] => {
        const { lines, u } = sampled(x, bed + 1);
        return [lines[bed]!, bed === BEDS - 1 ? lines[BEDS]! : lines[bed + 1]! - UNDERLAP * thick, u];
      } : topBed(grid, thick);
    if (withGrain && bed === BEDS - 1) boundaries![BEDS] = [];
    strip(bed ? grid : [...new Set([...grid, ...outline.map(p => p.x)])].sort((a, b) => a - b), x => {
      const [high, low, u] = corner(x);
      positions.push(x - left, high, x - left, low);
      tones.push(u, top, u, foot);
      if (boundary && x <= right) {
        boundary.push([x, high]);
        if (bed === BEDS - 1) boundaries![BEDS]!.push([x, low]);
      }
    });
  }
  if (withGrain) for (let bed = 0; bed < BEDS; bed++) {
    const kind = bed < 2 ? 'soil' : 'rock';
    materialBand(grain![kind], kind, boundaries![bed]!, boundaries![bed + 1]!);
  }
  const bedVertices = positions.length / 2, bedIndices = indices.length,
    clasts = buriedRocks(plan, left, right, minStep, positions, tones, indices, clastGrain);
  return { x: left, y: 0, positions: new Float32Array(positions), tones: new Float32Array(tones), indices: new Uint32Array(indices),
    bedVertices, bedIndices, clasts, clastGrain: withGrain ? completed(clastGrain!) : null,
    grain: withGrain ? Object.fromEntries(Object.entries(grain!).map(([kind, part]) => [kind, completed(part)])) : null };
}

const SOIL_GRAIN: Record<string, GrainKind | undefined> = { soil: 'soil', mud: 'soil', sand: 'soil', gravel: 'rock', rock: 'rock', concrete: 'concrete' };
export function buildSoilGrain(terrain: TerrainPaintGround, left: number, right: number) {
  const parts = { soil: materialGeometry(left), rock: materialGeometry(left), concrete: materialGeometry(left) };
  for (const sector of terrain.sectors) {
    const floor = ruinFloor(terrain, sector.surface), kind = SOIL_GRAIN[floor ? ruinEarth(terrain) : sector.surface],
      under = floor ? SLAB + .01 : .03, a = Math.max(left, sector.start), b = Math.min(right, sector.end);
    if (!kind || a >= b) continue;
    const part = parts[kind], first = part.positions.length / 2;
    let count = 0;
    for (const x of [a, ...terrain.points.filter(p => p.x > a && p.x < b).map(p => p.x), b]) {
      const y = terrain.height(x);
      materialVertex(part, kind, x, y - under);
      materialVertex(part, kind, x, y - (kind === 'concrete' ? 2.1 : groundBandDepth(terrain.seed, x, 2.1)));
      count++;
    }
    for (let i = 0; i < count - 1; i++) {
      const k = first + i * 2;
      part.indices.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
    }
  }
  return Object.fromEntries(Object.entries(parts).map(([kind, part]) => [kind, completed(part)]));
}

// Three small shared materials replace the depth-scaled strip atlas. Brightness
// from the approved extraction supplies a quiet, premultiplied light/dark finish;
// palette, buried rock geometry, contact, and native openings remain the game's.
export function grainTextures(surfaces: Readonly<Record<GrainKind, Float32Array | Uint8Array | readonly number[]>>) {
  const size = 512, kinds: GrainKind[] = ['soil', 'rock', 'concrete'];
  for (const kind of kinds) if (surfaces[kind]?.length !== size * size) throw Error('Ground material ' + kind + ' must be 512×512.');
  return Object.fromEntries(kinds.map(kind => {
    const shades = surfaces[kind];
    const data = new Uint8Array(size * size * 4), concrete = kind === 'concrete',
      dark = concrete ? [30, 30, 30] : [24, 30, 26], pale = concrete ? [222, 222, 222] : [222, 212, 178];
    for (let i = 0; i < shades.length; i++) {
      const delta = shades[i]! - 1, alpha = Math.round(Math.min(.10, Math.abs(delta) * .7) * 255), a = alpha / 255,
        color = delta < 0 ? dark : pale, at = i * 4;
      data[at] = Math.round(color[0]! * a); data[at + 1] = Math.round(color[1]! * a);
      data[at + 2] = Math.round(color[2]! * a); data[at + 3] = alpha;
    }
    return [kind, new Texture({ source: new BufferImageSource({ resource: data, width: size, height: size,
      format: 'rgba8unorm', alphaMode: 'premultiplied-alpha', addressMode: 'repeat',
      scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true }) })];
  }));
}
