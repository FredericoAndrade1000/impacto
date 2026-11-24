import type { TerrainPaintGround } from './terrain-art.ts';
import type { Graphics, StrokeInput, Texture } from 'pixi.js';
import type { Terrain, TerrainFeature, TerrainSector } from './terrain.ts';
import type { XY } from './canvas-art.ts';
interface Pier { a: number; b: number; top: number }
interface Opening { a: number; b: number; sill: number; head: number }
interface StandingWall { line: XY[]; openings: Opening[]; piers: Pier[] }
interface RuinWall { framed: boolean; west: number; east: number; floor: number; foot: number; line: XY[]; openings: { span: XY; sill: number; head: number }[]; piers: { span: XY; top: number }[] }
interface RuinHeap { west: number; east: number; peak: number; tall: number; top: XY[]; foot: number; order: number }
export interface RuinPlan { slab: TerrainSector; walls: RuinWall[]; heaps: RuinHeap[] }
interface SlabTones { body: number; top: number; deep: number; rim: number }
import { Random } from './math.ts';
import { TERRAIN_PROFILES } from './terrain.ts';
import { mineralFill } from './textures.ts';

// The ruins of a landscape (terrain.ts): what is left of a building framed in concrete and filled in with brick, on the
// crown of a bank. Like everything else they are seen square on from the side and lit from above: a facade with its
// columns, the edges of its floors and its windows, broken off along the courses of its brick and bared to the bars of
// its concrete; the rubble it fell into, heaped at its foot; and the slab of its floor, which is the ground there. A
// vehicle drives on the slab and meets nothing else of a ruin. What stands is drawn behind the ground line, in the row
// of the trees (terrain-scene.ts), and reaches under the ground beneath it: the earth hides its foot, so that it stands
// on the ground line whatever the slope. The slab is drawn with the ground (terrain-art.ts), over the earth the ruin
// was built on. Where a ruin is a site of the shared field its steel is drawn besides (deposit-art.js), jutting from the
// heaps laid out here. All of it follows from the seed and the place of the ruin, the same for whoever draws it.

// The slab of the floor: how deep it is, its pale wearing course and the dark of its foot.
export const SLAB = .3;
const SLAB_TOP = .07, SLAB_FOOT = .04;
// A stretch of slab is drawn this far past the east end of the stretch of ground being drawn, over the earth that
// stretch leans under the next (terrain-art.ts), whichever of the two lies over the other.
const SLAB_LAP = .2;
// How far under the lowest ground beneath it what stands on the slab reaches down.
export const RUIN_SINK = .4;
// A storey of the building: its height, the sill and the head of its windows over its floor, the depth of the edge of
// a floor, and the width of a column and of a pier of brick.
const STOREY = 3.1, SILL = .9, HEAD = 2.25, FLOOR = .3, COLUMN = .4, PIER = .55;
// The tones of a ruin, as muted as the trees beside it: the render of its walls, the concrete of its frame, the brick
// bared where the render fell, the dark inside a window and under its head, cracks and the scars of shells, its bars,
// and its rubble.
export const RUIN_TONES = Object.freeze({ render: 0x8c9387, frame: 0x979d90, brick: 0x8d7f71, shade: 0x515a53, deep: 0x434b45,
  line: 0x5a625a, steel: 0x6a4a3c, rubble: 0x7b8075, light: 0x989c8e, dark: 0x5f665d });

// The same draws for the same place of the same ground, whoever draws it and in whichever stretch of it.
const drawsAt = (terrain: TerrainPaintGround, x: number, channel: number) => new Random((terrain.seed ^ Math.imul(channel, 0x9e3779b9) ^ Math.imul(Math.round(x * 4), 0x85ebca6b)) >>> 0);
// Concrete in a landscape is the floor of a ruin. The ground the ruin was built on is the biome's own.
export const ruinFloor = (terrain: Pick<Terrain, 'id'>, surface: string) => surface === 'concrete' && Boolean(TERRAIN_PROFILES[terrain.id]?.battle);
export const ruinEarth = (terrain: Pick<Terrain, 'id'>) => TERRAIN_PROFILES[terrain.id].surface;
// The stretch of slab a ruin stands on: the concrete of the ground about its middle.
const slabOf = (terrain: TerrainPaintGround, f: TerrainFeature) => terrain.sectors.find(s => s.surface === 'concrete' && s.start <= f.peak && f.peak < s.end);
// The ground between two places: the two places on it and the corners of the outline between them. The corners of a
// landscape lie every `spacing` metres from its west end, and a stretch of it may hold only some of them.
function groundBetween(terrain: TerrainPaintGround, a: number, b: number) {
  const origin = terrain.center - terrain.length / 2, step = terrain.spacing, out: XY[] = [[a, terrain.height(a)]];
  for (let k = Math.floor((a - origin) / step) + 1, x = origin + k * step; x < b; k++, x = origin + k * step) if (x > a) out.push([x, terrain.height(x)]);
  out.push([b, terrain.height(b)]);
  return out;
}
const lowest = (terrain: TerrainPaintGround, a: number, b: number) => Math.min(...groundBetween(terrain, a, b).map(p => p[1]));
const highest = (terrain: TerrainPaintGround, a: number, b: number) => Math.max(...groundBetween(terrain, a, b).map(p => p[1]));
// Where a line running from west to east is at x.
export function lineAt(line: readonly XY[], x: number) {
  let i = 1; while (i < line.length - 1 && line[i]![0] < x) i++;
  const [x0, y0] = line[i - 1]!, [x1, y1] = line[i]!;
  return x1 > x0 ? y0 + (y1 - y0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : y1;
}
// The stretches along which a line running from west to east is at or over a level.
function above(line: readonly XY[], level: number) {
  const out: XY[] = []; let from = line[0]![1] >= level ? line[0]![0] : null;
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1]!, [x1, y1] = line[i]!;
    if (y0 >= level === y1 >= level) continue;
    const cross = x0 + (x1 - x0) * (level - y0) / (y1 - y0);
    if (y1 >= level) from = cross; else { out.push([from!, cross]); from = null; }
  }
  if (from !== null) out.push([from, line.at(-1)![0]]);
  return out;
}
// The part of an outline on one side of an upright line, by Sutherland and Hodgman's clip.
function clipped(points: readonly XY[], level: number, side: number): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, fa = (a[0] - level) * side, fb = (b[0] - level) * side;
    if (fa >= 0) out.push(a);
    if (fa > 0 && fb < 0 || fa < 0 && fb > 0) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}

// The broken end of a slab at `end`: how far in from there the break runs at each depth, from the top of the slab to
// its foot. The bars of the slab are bared across it.
function slabBreak(terrain: TerrainPaintGround, end: number) {
  const random = drawsAt(terrain, end, 5), cuts: XY[] = [[0, random.range(0, .18)]];
  for (const depth of [.06, .13, .2, .26]) cuts.push([depth + random.range(-.02, .02), random.range(.04, .55)]);
  cuts.push([SLAB, random.range(.02, .4)]);
  return cuts;
}
const insetAt = (cuts: readonly XY[], depth: number) => {
  let i = 1; while (i < cuts.length - 1 && cuts[i]![0] < depth) i++;
  const [d0, a] = cuts[i - 1]!, [d1, b] = cuts[i]!;
  return a + (b - a) * Math.min(1, Math.max(0, (depth - d0) / (d1 - d0)));
};
// Whether the place `depth` under the ground at x is in the slab of a ruin, inside its broken ends.
export function inSlab(terrain: TerrainPaintGround, x: number, depth: number) {
  const sector = terrain.sectors.find(s => s.start <= x && x < s.end);
  return sector !== undefined && ruinFloor(terrain, sector.surface) && depth >= 0 && depth <= SLAB &&
    x > sector.start + insetAt(slabBreak(terrain, sector.start), depth) && x < sector.end - insetAt(slabBreak(terrain, sector.end), depth);
}
// The slab between two depths under the ground, from its broken end at `start` to the one at `end`: an outline in the world.
function slabBand(terrain: TerrainPaintGround, start: number, end: number, from: number, to: number) {
  const west = slabBreak(terrain, start), east = slabBreak(terrain, end), at = (x: number, depth: number): XY => [x, terrain.height(x) - depth],
    between = (cuts: readonly XY[]) => cuts.filter(([depth]) => depth > from && depth < to),
    along = (a: number, b: number, depth: number) => groundBetween(terrain, a, b).map(([x, y]): XY => [x, y - depth]);
  return [...along(start + insetAt(west, from), end - insetAt(east, from), from), ...between(east).map(([depth, inset]) => at(end - inset, depth)),
    ...along(start + insetAt(west, to), end - insetAt(east, to), to).reverse(), ...between(west).reverse().map(([depth, inset]) => at(start + inset, depth))];
}
// Draws the slab of `sector`, the floor of a ruin, as far as it lies over the stretch of ground being drawn, from `left`
// to a little past `right`, in the tones of concrete `tones`: its body, its wearing course, the dark of its foot and the lit edge
// of its top.
export function drawSlab(g: Graphics, terrain: TerrainPaintGround, sector: TerrainSector, left: number, right: number, tones: SlabTones) {
  for (const [from, to, color] of [[0, SLAB, tones.body], [0, SLAB_TOP, tones.top], [SLAB - SLAB_FOOT, SLAB, tones.deep]] satisfies [number, number, number][]) {
    const outline = clipped(clipped(slabBand(terrain, sector.start, sector.end, from, to), left, 1), right + SLAB_LAP, -1);
    if (outline.length > 2) g.poly(outline.flat()).fill(color);
  }
  const a = Math.max(left, sector.start + insetAt(slabBreak(terrain, sector.start), 0)), b = Math.min(right, sector.end - insetAt(slabBreak(terrain, sector.end), 0));
  if (a >= b) return;
  for (const [i, [x, y]] of groundBetween(terrain, a, b).entries()) i ? g.lineTo(x, y) : g.moveTo(x, y);
  g.stroke({ color: tones.rim, width: .018, alpha: .84 });
}
// What a near view shows of the slab of a ruin: cracks through it, and its bars bared across the breaks at its ends.
export function drawSlabDetail(g: Graphics, terrain: TerrainPaintGround, f: TerrainFeature) {
  const slab = slabOf(terrain, f), random = drawsAt(terrain, f.peak, 17), at = (x: number, depth: number): XY => [x, terrain.height(x) - depth], cracks: XY[][] = [], bars: XY[][] = [];
  if (!slab) return;
  for (let x = slab.start + random.range(1, 2.5); x < slab.end - 1.2; x += random.range(2.2, 4.8)) {
    const lean = random.range(-.08, .08);
    cracks.push([at(x, .004), at(x + lean, SLAB * .4), at(x - lean * .5, SLAB * .7), at(x + lean * .3, SLAB - .006)]);
  }
  for (const [end, side] of [[slab.start, 1], [slab.end, -1]] satisfies XY[]) {
    const cuts = slabBreak(terrain, end);
    for (const depth of [.1, .21]) {
      const inset = insetAt(cuts, depth), from = end + side * (inset + .12), to = end + side * .02, [mx, my] = at((from + to) / 2, depth);
      if (inset >= .12) bars.push([at(from, depth), [mx, my + .02], at(to, depth + .03)]);
    }
  }
  paths(g, cracks, { color: 0x3d534b, width: .012, alpha: .55 });
  paths(g, bars, { color: RUIN_TONES.steel, width: .02, alpha: .85 }, true);
}
// Strokes lines through the corners of each of `lines`, or curves through each three of them with `curved`; nothing
// when there are none, for a stroke with no path of its own would draw round the last outline filled.
function paths(g: Graphics, lines: readonly (readonly XY[])[], style: StrokeInput, curved = false) {
  if (!lines.length) return;
  for (const [first, ...rest] of lines) {
    g.moveTo(...first!);
    if (curved) g.quadraticCurveTo(...rest[0]!, ...rest[1]!); else for (const p of rest) g.lineTo(...p);
  }
  g.stroke(style);
}

// A wall from `u0`: piers of `pier` metres with their tops at `tops`, and between each two a bay of `bay` metres
// broken down to its level in `levels`; it starts `lead` metres before its first pier at `start` over its floor and
// ends `tail` metres past its last at `end`. It breaks along the courses of its brick, in steps, and down to the sill
// of a window whose head it lost. Its line is in places along the wall and heights over its floor.
function standing(random: Random, u0: number, pier: number, bay: number, tops: readonly number[], levels: readonly number[], lead: number, start: number, tail: number, end: number): StandingWall {
  const line: XY[] = [], openings: Opening[] = [], piers: Pier[] = [],
    put = (u: number, h: number) => { if (!line.length || u > line.at(-1)![0] + 1e-6) line.push([u, h]); },
    steps = (u: number, h: number) => {
      const [from, level] = line.at(-1)!, run = u - from, n = Math.max(1, Math.min(6, Math.round(run / random.range(.2, .36))));
      let was = level;
      for (let k = 1; k <= n; k++) {
        const at = from + run * k / n, next = k === n ? h : level + (h - level) * Math.min(1, k / n * random.range(.8, 1.2));
        put(at - Math.min(.05, run / n * .35), was); put(at, next); was = next;
      }
    };
  if (lead > 0) put(u0 - lead, start);
  for (let i = 0; i < tops.length; i++) {
    const a = u0 + i * bay, b = a + pier;
    if (line.length) steps(a, tops[i]!); else put(a, tops[i]!);
    put(b, tops[i]!); piers.push({ a, b, top: tops[i]! });
    if (i === tops.length - 1) break;
    const span = bay - pier, wide = Math.min(1.5, span - 1.1), o0 = b + (span - wide) / 2, o1 = o0 + wide, level = levels[i]!,
      storey = [0, 1, 2].find(k => level > k * STOREY + SILL + .15 && level < k * STOREY + HEAD + .25);
    // A bay too narrow for a window is only broken down to its level.
    if (wide < .6) { steps(b + span / 2, level); continue; }
    for (let k = 0; k < 3; k++) if (k * STOREY + HEAD + .25 <= level) openings.push({ a: o0, b: o1, sill: k * STOREY + SILL, head: k * STOREY + HEAD });
    steps(o0, level);
    if (storey === undefined) { put((o0 + o1) / 2, level + random.range(-.12, .12)); put(o1, level + random.range(-.12, .12)); } else {
      const sill = storey * STOREY + SILL;
      put(o0 + .05, sill); put(o1 - .05, sill); put(o1, Math.max(sill + .2, level + random.range(-.35, .35)));
    }
  }
  if (tail > 0) steps(line.at(-1)![0] + tail, end);
  return { line, openings, piers };
}
// The level a bay of a wall is broken down to, under the lower of the piers beside it: below its windows, down into
// one of them, or over one or two storeys.
function brokenTo(random: Random, cap: number) {
  const kind = random.next(), level = kind < .22 ? random.range(.5, SILL - .1) : kind < .48 ? random.range(SILL + .35, HEAD + .1)
    : kind < .76 ? random.range(HEAD + .35, STOREY + SILL) : random.range(STOREY + SILL + .35, STOREY + HEAD + .6);
  return Math.min(level, cap);
}

const plans = new WeakMap<TerrainFeature, RuinPlan>();
// What is left of a ruin: its slab; its walls, the larger with a frame of concrete, each with the line it is broken
// off along and its windows, as places in the world; and the three heaps of its rubble, against the walls and between
// them, each with the line of its top. They stand on the slab clear of its broken ends.
export function ruinPlan(terrain: TerrainPaintGround, f: TerrainFeature): RuinPlan {
  let plan = plans.get(f);
  if (plan) return plan;
  const slab = slabOf(terrain, f)!, random = drawsAt(terrain, f.peak, 11), turn = random.next() < .5 ? 1 : -1,
    from = slab.start + 1.1, to = slab.end - 1.1, room = to - from, place = (u: number) => turn > 0 ? from + u : to - u,
    bays = room > 15 ? 3 : room > 10 ? 2 : 1, bay = Math.min(random.range(2.9, 3.4), (room * .62 - COLUMN) / bays),
    tops = Array.from({ length: bays + 1 }, (_, i) => i === bays ? random.range(1.6, STOREY + .8) : random.range(2.2, STOREY + 2)),
    tall = Math.floor(random.next() * bays);
  tops[tall] = random.range(STOREY + 1.6, 2 * STOREY + .4);
  const levels = Array.from({ length: bays }, (_, i) => brokenTo(random, Math.min(tops[i]!, tops[i + 1]!) - .15)),
    main = { framed: true, ...standing(random, 0, COLUMN, bay, tops, levels, 0, 0, random.range(.5, 1.2), random.range(.25, .8)) },
    used = main.line.at(-1)![0], walls = [main], left = room - used;
  // A stub of brick wall at the other end when there is room for it beyond a heap.
  if (left > 5.6) {
    const wide = random.range(2.2, Math.min(3.6, left - 3.4)), u0 = room - wide + .5, pierTops = [random.range(1.3, 2.9), random.range(1.1, 2.6)];
    walls.push({ framed: false, ...standing(random, u0, PIER, wide - 1 - PIER, pierTops, [brokenTo(random, Math.min(...pierTops) - .1)], .5, random.range(.2, .7), .5, random.range(.15, .5)) });
  }
  const second = walls[1], gap = second ? [used, second.line[0]![0]] : [used, room],
    heaps: [number, number, number][] = [[(main.piers[0]!.b + main.piers.at(-1)!.a) / 2 + random.range(-1, 1) * bay * .4, random.range(2.2, 3.2), random.range(.6, 1.05)],
      [(gap[0]! + gap[1]!) / 2, Math.min(gap[1]! - gap[0]! + 1.4, random.range(3.2, 4.6)), random.range(1, 1.55)],
      [second ? (second.line[0]![0] + second.line.at(-1)![0]) / 2 + random.range(-.5, .5) : room - 1, random.range(1.8, 2.7), random.range(.45, .85)]];
  plan = {
    slab,
    walls: walls.map(wall => {
      const line = wall.line.map(([u, h]): XY => [place(u), h]).sort((a, b) => a[0] - b[0]), west = line[0]![0], east = line.at(-1)![0],
        floor = highest(terrain, west, east), span = (a: number, b: number): XY => [Math.min(place(a), place(b)), Math.max(place(a), place(b))];
      return { framed: wall.framed, west, east, floor, foot: lowest(terrain, west, east) - RUIN_SINK, line: line.map(([x, h]): XY => [x, floor + h]),
        openings: wall.openings.map(o => ({ span: span(o.a, o.b), sill: floor + o.sill, head: floor + o.head })),
        piers: wall.piers.map(p => ({ span: span(p.a, p.b), top: floor + p.top })) };
    }),
    heaps: heaps.map(([middle, wide, tall], i) => {
      const at = place(middle), west = Math.max(slab.start + .4, at - wide / 2), east = Math.min(slab.end - .4, at + wide / 2), top: XY[] = [],
        peak = west + (east - west) * random.range(.38, .62), n = Math.max(8, Math.round((east - west) / .22));
      tall = Math.min(tall, (east - west) * .36);
      for (let k = 0; k <= n; k++) {
        const x = west + (east - west) * k / n, rise = x < peak ? (x - west) / (peak - west) : (east - x) / (east - peak);
        top.push([x, terrain.height(x) + (k === 0 || k === n ? 0 : Math.max(.02, tall * Math.min(1, rise * 1.3) ** .75 + random.range(-.05, .05)))]);
      }
      return { west, east, peak, tall, top, foot: lowest(terrain, west, east) - RUIN_SINK, order: i };
    }),
  };
  plans.set(f, plan);
  return plan;
}

// The top of the rubble of a ruin at x, of whichever of its heaps stands highest there, or the ground between them.
export function rubbleAt(plan: RuinPlan, terrain: TerrainPaintGround, x: number) {
  let y = terrain.height(x);
  for (const heap of plan.heaps) if (x > heap.west && x < heap.east) y = Math.max(y, lineAt(heap.top, x));
  return y;
}
// A block of rubble about (x, y), `size` across, turned by `angle`, its underside in shade.
function block(g: Graphics, random: Random, x: number, y: number, size: number, angle: number, color: number) {
  const c = Math.cos(angle), s = Math.sin(angle), w = size * random.range(.7, 1.1), h = size * random.range(.45, .8),
    corner = (u: number, v: number): XY => [x + u * c - v * s, y + u * s + v * c];
  g.poly([...corner(-w / 2, -h / 2), ...corner(w / 2, -h * .4), ...corner(w * .45, h / 2), ...corner(-w * .5, h * .45)]).fill(color);
  if (size > .2) g.poly([...corner(-w / 2, -h / 2), ...corner(w / 2, -h * .4), ...corner(w * .48, -h * .18), ...corner(-w / 2, -h * .25)]).fill({ color: RUIN_TONES.dark, alpha: .55 });
}
// Draws a wall of a ruin: its face, the brick bared along its break, its frame of columns and floors, the dirt about its
// foot, its windows dark within, the scars of shells and the cracks from the corners of its windows, and the bars of its
// broken concrete.
function drawWall(g: Graphics, terrain: TerrainPaintGround, wall: RuinWall, random: Random, overview: boolean, texture: Texture | null) {
  const { line, foot, floor, west, east } = wall, tones = RUIN_TONES, inside = (x: number, y: number, margin: number) => y < lineAt(line, x) - margin,
    window = (x: number, y: number, margin = .04) => wall.openings.some(o => x > o.span[0] - margin && x < o.span[1] + margin && y > o.sill - margin && y < o.head + margin);
  g.poly([west, foot, east, foot, ...[...line].reverse().flat()]).fill(mineralFill(tones.render, texture));
  if (overview) return;
  // Along its break the render is gone in places, and the brick shows.
  for (let i = 0; i < line.length - 1;) {
    const run = line.slice(i, i + 3 + Math.floor(random.next() * 5));
    if (random.next() < .55 && run.length > 1) g.poly([...run.flat(), ...run.map(([x, y]) => [x, Math.max(foot, y - random.range(.18, .55))]).reverse().flat()]).fill(tones.brick);
    i += run.length - 1;
  }
  const bars: XY[][] = [];
  if (wall.framed) {
    for (const { span: [a, b], top } of wall.piers) g.poly([a, foot, b, foot, b, top, a, top]).fill(mineralFill(tones.frame, texture));
    for (const level of [floor + STOREY, floor + 2 * STOREY]) for (const [a, b] of above(line, level)) {
      if (b - a < .05) continue;
      g.poly([a, level - FLOOR, b, level - FLOOR, b, level, a, level]).fill(tones.frame);
      g.poly([a, level - FLOOR - .07, b, level - FLOOR - .07, b, level - FLOOR, a, level - FLOOR]).fill({ color: tones.deep, alpha: .35 });
      // Where a floor broke off between two columns its bars hang out of it.
      for (const [end, side] of [[a, -1], [b, 1]] satisfies XY[]) if (!wall.piers.some(p => end > p.span[0] - .05 && end < p.span[1] + .05))
        for (const depth of [.08, .2]) bars.push([[end - side * .06, level - depth], [end + side * .25, level - depth], [end + side * random.range(.3, .55), level - depth - random.range(.1, .35)]]);
    }
    // And out of the top of each column, where it snapped.
    for (const { span: [a, b], top } of wall.piers) for (const k of [.2, .5, .8]) {
      const x = a + (b - a) * k, rise = random.range(.25, .75), bend = random.range(-.35, .35);
      bars.push([[x, top - .08], [x + bend * .25, top + rise * .65], [x + bend, top + rise]]);
    }
  }
  // Splashed and dirtied where it meets the ground and the rubble.
  g.poly([west, foot, east, foot, ...[...line].reverse().map(([x, y]) => [x, Math.min(y, terrain.height(x) + .45)]).flat()]).fill({ color: tones.deep, alpha: .2 });
  for (const o of wall.openings) {
    const [a, b] = o.span;
    g.poly([a, o.sill, b, o.sill, b, o.head, a, o.head]).fill(tones.shade);
    g.poly([a, o.head - .32, b, o.head - .32, b, o.head, a, o.head]).fill({ color: tones.deep, alpha: .6 });
  }
  const area = (east - west) * (line.reduce((sum, [, y]) => sum + y, 0) / line.length - floor);
  for (let i = 0; i < Math.round(area * .8); i++) {
    const x = random.range(west + .15, east - .15), y = floor + random.range(.25, Math.max(.3, lineAt(line, x) - floor - .2)), r = random.range(.035, .1),
      scar = Array.from({ length: 5 }, (_, k): XY => { const angle = k / 5 * Math.PI * 2, reach = r * random.range(.6, 1.1); return [x + Math.cos(angle) * reach, y + Math.sin(angle) * reach]; });
    // A scar is wholly on the face, clear of its break and of its windows, wherever the break steps down beside it.
    if (scar.some(([u, v]) => !inside(u, v, .04) || window(u, v, .02))) continue;
    g.poly(scar.flat()).fill({ color: tones.line, alpha: .45 });
  }
  const cracks: XY[][] = [];
  for (const o of wall.openings) for (const [x, y, rise] of [[o.span[0], o.head, 1], [o.span[1], o.head, 1], [o.span[0], o.sill, -1], [o.span[1], o.sill, -1]] satisfies [number, number, number][]) {
    if (random.next() < .45) continue;
    const side = x === o.span[0] ? -1 : 1, mid: XY = [x + side * random.range(.05, .2), y + rise * random.range(.2, .4)], end: XY = [mid[0] + side * random.range(.05, .2), mid[1] + rise * random.range(.2, .4)];
    if (inside(...end, .1) && !window(...end, .02) && end[1] > floor + .1) cracks.push([[x, y], mid, end]);
  }
  paths(g, cracks, { color: tones.line, width: .018, alpha: .6 });
  paths(g, bars, { color: tones.steel, width: .028, alpha: .9 }, true);
}
// Draws a heap of rubble: its mass, the crest the light falls on, and the blocks and broken slabs it is made of.
function drawHeap(g: Graphics, terrain: TerrainPaintGround, heap: RuinHeap, random: Random, overview: boolean, texture: Texture | null) {
  const { top, foot, west, east, peak } = heap, tones = RUIN_TONES;
  g.poly([west, foot, east, foot, ...[...top].reverse().flat()]).fill(mineralFill(tones.rubble, texture));
  if (overview) return;
  g.poly([...top.flat(), ...[...top].reverse().map(([x, y]) => [x, Math.max(terrain.height(x), y - .14)]).flat()]).fill({ color: tones.light, alpha: .35 });
  for (let i = 0; i < Math.round((east - west) * 5); i++) {
    const x = random.range(west + .2, east - .2), size = random.range(.1, .32), surface = lineAt(top, x), ground = terrain.height(x),
      y = ground + random.range(.05, Math.max(.06, surface - ground - size * .3)), pick = random.next();
    block(g, random, x, y, size, random.range(-.6, .6), pick < .45 ? tones.light : pick < .75 ? tones.brick : tones.dark);
  }
  for (let i = 0; i < 2; i++) {
    const x = peak + random.range(-.6, .6), long = random.range(.7, 1.2), thick = random.range(.16, .24), angle = random.range(.25, .7) * (random.next() < .5 ? -1 : 1),
      c = Math.cos(angle), s = Math.sin(angle), y = lineAt(top, x) - .08, corner = (u: number, v: number): XY => [x + u * c - v * s, y + u * s + v * c];
    g.poly([...corner(-long / 2, -thick / 2), ...corner(long / 2, -thick / 2), ...corner(long / 2, thick / 2), ...corner(-long / 2, thick / 2)]).fill(tones.frame);
    g.poly([...corner(-long / 2, -thick / 2), ...corner(long / 2, -thick / 2), ...corner(long / 2, -thick * .15), ...corner(-long / 2, -thick * .15)]).fill({ color: tones.dark, alpha: .5 });
  }
}
// Draws the ruins of a stretch of ground into `g`, which stands behind the ground line: the walls of each, its heaps
// of rubble against them, and the broken pieces lying about its slab.
export function drawRuins(terrain: TerrainPaintGround, g: Graphics, overview = false, texture: Texture | null = null) {
  for (const f of terrain.features) {
    if (f.kind !== 'ruins' || !slabOf(terrain, f)) continue;
    const plan = ruinPlan(terrain, f), random = drawsAt(terrain, f.peak, 13);
    for (const wall of plan.walls) drawWall(g, terrain, wall, random, overview, overview ? null : texture);
    for (const heap of plan.heaps) drawHeap(g, terrain, heap, random, overview, overview ? null : texture);
    if (overview) continue;
    for (let i = 0; i < 9; i++) {
      const x = random.range(plan.slab.start + 1, plan.slab.end - 1), size = random.range(.08, .24), ground = terrain.height(x);
      block(g, random, x, ground, size, random.range(-.3, .3), random.next() < .6 ? RUIN_TONES.light : RUIN_TONES.brick);
    }
  }
}
