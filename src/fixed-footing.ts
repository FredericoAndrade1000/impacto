import { plateCorners } from './math.ts';
import { componentFootprintPolygons } from './assembly.ts';
import { constructionPlacement } from './construction-placement.ts';
import { BODY_WIDTH } from './component-size.ts';
import { castBill } from './economy.ts';
import type { FillInput, StrokeInput } from 'pixi.js';
import type { PlateGeometry, Point } from './math.ts';
import type { ComponentGeometry } from './assembly.ts';

interface AttachmentFlags { attached?: boolean | undefined; detached?: boolean | undefined; fragment?: boolean | undefined }
interface FootingModule extends ComponentGeometry, AttachmentFlags {}
type FootingPart = { type: 'plate'; data: AttachmentFlags & { definition: PlateGeometry } }
  | { type: 'module'; data: FootingModule };
interface FootingBlueprint { plates: readonly PlateGeometry[]; modules: readonly FootingModule[] }
interface GroundProfile { height(x: number): number }
interface FootingPlace { x: number; facing: number }
type Edge = readonly [Point, Point];
export interface Footing { top: Point[]; ground: Point[]; foot: Point[] }
interface FootingPainter {
  poly(points: number[]): { fill(style: FillInput): unknown };
  moveTo(x: number, y: number): { lineTo(x: number, y: number): unknown };
  stroke(style: StrokeInput): unknown;
}

// The footing of a construction that stands fixed. Such a construction rests on the relief by the lower edge of its
// design, level, over the highest point of the ground under its base, and the ground is not levelled for it
// (construction-placement.ts): over a slope, or a hollow, there is room under the rest of its base. A footing cast
// under the whole plan of that base fills it: from one end of the base to the other, from the lower contour of the
// construction down to the ground under each point of it, and a little into the ground, where the contact shadow of the
// construction darkens it as the one of a wheel darkens the ground (render.ts). Under a floor that spans between feet
// or walls going lower than it, it goes on up to the floor, as the foundation wall along the near face of a building
// stands under all of it, seen side on: a construction never shows sky under its base, whatever its feet are. It is
// paint, as the works of a base are (base-art.ts): no round, vehicle or sensor meets it, it weighs nothing, and neither
// the design nor the core knows of it. What of it a slope asks for past the first metres under the base is paid for
// with the works of the structure, as concrete (`footingBill`), and given back by nothing. A construction whose base
// comes nowhere near the ground — an authored scene of the laboratory, standing where it was put — has none.

// The base of a construction is what of its lower contour lies within this many metres of its lowest point: its floor
// and the feet of its walls, not the roof that reaches past them or a gun laid out of an embrasure. The plan of the
// footing runs from the first point of the base to the last, under whatever of the construction is lowest between them.
export const FOOTING_REACH = .3;
// A construction whose base comes no nearer the ground than this many metres anywhere stands on nothing.
export const FOOTING_SEATED = .12;
// How far into the ground a footing goes, in metres: as deep as the contact shadow over it is at the least.
export const FOOTING_EMBED = .05;
// The ground under a footing is read at its ends and every this many metres between them.
const GROUND_STEP = .1;
// A run of the base narrower than this, in metres, is a corner of a part, not something to stand on.
const NARROWEST = .02;

// The outlines of the parts of a construction that make its shape where they stand: what has come off it has none.
export function footingOutlines(parts: readonly FootingPart[]): Point[][] {
  const outlines: Point[][] = [];
  for (const part of parts) {
    const data = part.data;
    if (data.attached === false || data.detached || data.fragment) continue;
    if (part.type === 'plate') outlines.push(plateCorners(part.data.definition));
    else outlines.push(...componentFootprintPolygons(part.data));
  }
  return outlines;
}

// The height of a non-vertical edge (`[a, b]`, `a` to the left) at `x`.
const along = ([a, b]: Edge, x: number): number => a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
// Where two edges cross strictly between the ends of both along the ground, or null.
function crossing(e: Edge, f: Edge): number | null {
  const left = Math.max(e[0].x, f[0].x), right = Math.min(e[1].x, f[1].x);
  if (right - left < 1e-9) return null;
  const at = along(e, left) - along(f, left), to = along(e, right) - along(f, right);
  if (at * to >= 0) return null;
  return left + (right - left) * at / (at - to);
}

// The lower contour of the outlines, as far as it lies no higher than `limit`: runs of points from left to right,
// one wherever the outlines stand unbroken over the ground, with a pair of points at one place where the contour
// steps up or down. Only an edge that comes under the limit can be the contour there.
export function lowerContour(outlines: readonly (readonly Point[])[], limit = Infinity): Point[][] {
  const edges: Edge[] = [], xs: number[] = [];
  for (const outline of outlines) for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    if (Math.abs(b.x - a.x) < 1e-9 || Math.min(a.y, b.y) > limit) continue;
    edges.push(a.x < b.x ? [a, b] : [b, a]); xs.push(a.x, b.x);
  }
  // Between two of these places one edge is the lowest throughout.
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const x = crossing(edges[i]!, edges[j]!); if (x !== null) xs.push(x);
  }
  xs.sort((m, n) => m - n);
  const runs: Point[][] = [];
  let run: Point[] | null = null;
  // A point at the place of the last one goes on from it, or steps from it to another height.
  const add = (p: Point): void => {
    const last = run?.at(-1);
    if (!last) runs.push(run = [p]);
    else if (Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) run!.push(p);
  };
  for (let i = 0; i + 1 < xs.length; i++) {
    const left = xs[i]!, right = xs[i + 1]!, middle = (left + right) / 2;
    if (right - left < 1e-9) continue;
    let lowest: Edge | null = null, low = Infinity;
    for (const edge of edges) if (edge[0].x <= middle && edge[1].x >= middle) {
      const y = along(edge, middle); if (y < low) { low = y; lowest = edge; }
    }
    if (!lowest) { run = null; continue; }
    const from = { x: left, y: along(lowest, left) }, to = { x: right, y: along(lowest, right) },
      cut = () => ({ x: left + (right - left) * (limit - from.y) / (to.y - from.y), y: limit });
    // Where the contour comes over the limit the run ends, at the place it crosses it, and begins again where it comes back.
    if (from.y > limit && to.y > limit) { run = null; continue; }
    if (from.y > limit) { run = null; add(cut()); add(to); continue; }
    add(from);
    if (to.y > limit) { add(cut()); run = null; continue; }
    add(to);
  }
  // A point in the middle of a straight stretch tells nothing.
  return runs.filter(points => points.at(-1)!.x - points[0]!.x >= NARROWEST).map(points => points.filter((p, i) => {
    if (!i || i === points.length - 1) return true;
    const a = points[i - 1]!, b = points[i + 1]!;
    return Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) > 1e-12;
  }));
}

// The height of a line of points from left to right (a run of the contour) at `x`: at a step, the lower of its two.
function contourAt(line: readonly Point[], x: number): number {
  let y = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!, b = line[i + 1]!;
    if (x < a.x - 1e-9 || x > b.x + 1e-9) continue;
    y = Math.min(y, b.x - a.x < 1e-9 ? Math.min(a.y, b.y) : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x));
  }
  return y;
}

// The part of a run of the contour (`lowerContour`) from `left` to `right` along the ground, or nothing where it has none
// as wide as `NARROWEST` there. A step the contour takes right at either end is left out: the run starts and ends on
// the side of it that lies between them.
function between(run: readonly Point[], left: number, right: number): Point[] | null {
  const out: Point[] = [], add = (p: Point): void => { const last = out.at(-1); if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) out.push(p); };
  for (let i = 0; i + 1 < run.length; i++) {
    const a = run[i]!, b = run[i + 1]!;
    if (b.x - a.x < 1e-9) { if (a.x > left + 1e-9 && a.x < right - 1e-9) { add(a); add(b); } continue; }
    const from = Math.max(a.x, left), to = Math.min(b.x, right), at = (x: number): Point => x === a.x ? a : x === b.x ? b : { x, y: along([a, b], x) };
    if (to - from >= 1e-9) { add(at(from)); add(at(to)); }
  }
  return out.length && out.at(-1)!.x - out[0]!.x >= NARROWEST ? out : null;
}

// The footing of a construction (its `outlines`, in the frame `ground` is read in): for each run of the lower contour
// within the plan of its base, the contour it holds up (`top`), the ground under it (`ground`), read at the ends of the
// run and every tenth of a metre between them, and its foot (`foot`), `FOOTING_EMBED` into that ground, from left to
// right as well. None for a construction that stands on nothing.
export function fixedFooting(outlines: readonly (readonly Point[])[], ground: GroundProfile): Footing[] {
  if (!outlines.length) return [];
  let floor = Infinity;
  for (const outline of outlines) for (const p of outline) floor = Math.min(floor, p.y);
  const base = lowerContour(outlines, floor + FOOTING_REACH);
  if (!base.length) return [];
  const first = Math.min(...base.map(run => run[0]!.x)), last = Math.max(...base.map(run => run.at(-1)!.x));
  const footings = lowerContour(outlines).map(run => between(run, first, last)).filter((top): top is Point[] => top !== null).map(top => {
    const left = top[0]!.x, right = top.at(-1)!.x, count = Math.max(1, Math.ceil((right - left) / GROUND_STEP - 1e-9)),
      under = Array.from({ length: count + 1 }, (_, i) => { const x = i === count ? right : left + (right - left) * i / count; return { x, y: ground.height(x) }; });
    return { top, ground: under, foot: under.map(p => ({ x: p.x, y: Math.min(p.y - FOOTING_EMBED, contourAt(top, p.x)) })) };
  });
  return footings.some(footing => footing.ground.some(p => contourAt(footing.top, p.x) - p.y <= FOOTING_SEATED)) ? footings : [];
}
// The whole shape of a footing: along its contour and back along its foot.
export const footingShape = (footing: Pick<Footing, 'top' | 'foot'>): Point[] => [...footing.top, ...[...footing.foot].reverse()];

// How many metres of room under the base a footing fills for nothing: what it fills below them is paid for. Of what a
// footing fills, this share is concrete: it is cast hollow, its walls and piers holding back the earth inside them.
export const FOOTING_FREE = .7, FOOTING_SOLID = .2;
// The cubic metres of concrete paid for in the footing a structure (`blueprint`, as compiled) needs where it would stand,
// at `x` facing as `facing` says, over `ground`: of the room under its base, down from it resting on the relief with nothing
// between them, what lies past the free metres, as deep across as every construction is (`BODY_WIDTH`). The ground is
// straight between two of its readings.
export function footingVolume(blueprint: FootingBlueprint, ground: GroundProfile, { x, facing }: FootingPlace): number {
  const { point } = constructionPlacement(blueprint, ground, { x, facing, clearance: 0, allowDownward: true }),
    outlines = [...blueprint.plates.map(plate => plateCorners(plate).map(point)), ...blueprint.modules.flatMap(componentFootprintPolygons).map(poly => poly.map(point))];
  let area = 0;
  for (const { top, ground: under } of fixedFooting(outlines, ground)) for (let i = 1; i < under.length; i++) {
    const from = under[i - 1]!, to = under[i]!, width = to.x - from.x,
      a = contourAt(top, from.x) - from.y - FOOTING_FREE, b = contourAt(top, to.x) - to.y - FOOTING_FREE;
    // Where the room comes past the free metres between two readings, only what lies past them.
    area += a >= 0 && b >= 0 ? width * (a + b) / 2 : a > 0 || b > 0 ? width * Math.max(a, b) ** 2 / (2 * Math.abs(a - b)) : 0;
  }
  return area * BODY_WIDTH * FOOTING_SOLID;
}
// What that footing costs (economy.ts `castBill`): nothing on ground that leaves no more room under the base than the free metres.
export const footingBill = (blueprint: FootingBlueprint, ground: GroundProfile, place: FootingPlace) => castBill(footingVolume(blueprint, ground, place));

// The tones of a footing: its concrete, a little darker and rougher than the cast walls it holds up; the earth that
// stains its foot; the shade under the contour it holds, and the line of its ends.
const CONCRETE = 0x85877b, STAIN = 0x3a3829, UNDER = 0x1c241f, EDGE = 0x1b2721;
// The earth on its foot, in bands from the ground up, each this many metres high and this dark, one over the other.
const STAINS: readonly (readonly [number, number])[] = [[.2, .05], [.15, .05], [.1, .06], [.06, .07], [.03, .08]];
// The shade under the contour is this many metres deep; the line of each end is this wide.
const SHADE = .025, END = .012;

// Draws footings (`fixedFooting`) into `g`, which is anchored for the places they are told in, with the grain of
// concrete laid over them where the base materials are at hand (base-materials.ts).
export function paintFooting<G extends FootingPainter>(g: G, footings: readonly Footing[], materials: { concrete?: FillInput } | null = null): G {
  const flat = (points: readonly Point[]): number[] => points.flatMap(p => [p.x, p.y]);
  for (const footing of footings) {
    const { top, ground, foot } = footing, shape = flat(footingShape(footing)), back = [...foot].reverse();
    g.poly(shape).fill(CONCRETE);
    if (materials?.concrete) g.poly(shape).fill(materials.concrete);
    // From its foot up, and no higher than the contour where that comes lower.
    for (const [high, alpha] of STAINS)
      g.poly(flat([...ground.map(p => ({ x: p.x, y: Math.min(p.y + high, contourAt(top, p.x)) })), ...back])).fill({ color: STAIN, alpha });
    // Down from the contour, and no lower than its foot.
    g.poly(flat([...top, ...[...top].reverse().map(p => ({ x: p.x, y: Math.max(p.y - SHADE, contourAt(foot, p.x)) }))])).fill({ color: UNDER, alpha: .22 });
    const ends: [Point, Point][] = [[top[0]!, foot[0]!], [top.at(-1)!, foot.at(-1)!]];
    for (const [high, low] of ends) g.moveTo(high.x, high.y).lineTo(low.x, low.y);
    g.stroke({ color: EDGE, width: END, alpha: .55 });
  }
  return g;
}
