import { CHASSIS_MODELS } from './chassis.ts';
import { clamp, rectangle, segmentInBox } from './math.ts';
import type { Point } from './math.ts';
import type { ModuleKind } from './materials.ts';
import type { DetailKind } from './vehicle-details.ts';
import type { AuthoredDetail } from './construction-contract.ts';

export interface HullBox extends Point { w: number; h: number }
export interface HullPiece extends HullBox { kind: ModuleKind; angle?: number; exposed?: boolean }
export type HullDetail = Pick<AuthoredDetail, 'kind' | 'x' | 'y' | 'angle' | 'width' | 'height'> &
  { mirrored?: boolean | undefined; text?: string | undefined };
export interface HullScene {
  front?: number; rooms?: readonly (readonly Point[])[]; pieces?: readonly HullPiece[];
  vehicle?: boolean; cast?: boolean; side?: 'inside' | 'outside'; seed?: string;
  automaticDetails?: boolean; manualDetails?: boolean; details?: readonly HullDetail[];
}
export type HullFittingKind = DetailKind | 'lamp' | 'conduit' | 'junction' | 'extinguisher';
export interface HullFitting extends HullBox { kind: HullFittingKind; text?: string; count?: number; flip?: boolean }
export interface HullSeam { a: Point; b: Point }
export interface HullEdge extends HullSeam { length: number; normal: Point }
interface Roof { x0: number; x1: number; y: number }
export interface FenderWheel extends Point { r: number }
export interface FenderGroup<Wheel extends FenderWheel = FenderWheel> extends FenderWheel { half: number; axles: Wheel[] }
export interface HullLayout<Kind extends HullFittingKind = HullFittingKind> {
  side: 'inside' | 'outside'; cast: boolean; vehicle: boolean; details: readonly HullDetail[];
  fittings: (Omit<HullFitting, 'kind'> & { kind: Kind })[]; seams: HullSeam[]; tracks: { x0: number; x1: number }[];
  arches: { x: number; y: number; r: number; half: number; axles: number[]; over: number[] }[];
  feet: Roof[]; shadows: (HullSeam & { depth: number })[];
}
type Pair = [number, number];

// Where the fittings of a hull stand, worked out from what the hull is: the outline of the room its skin covers, the
// other rooms of the construction, the way it faces and the pieces it carries. Nothing here is drawn, and nothing of it
// is armour: a fitting is a picture laid on the skin, which no shot meets and which weighs nothing.
//
// Every fitting is seen square from the side, as a drawing of the side of the vehicle shows it, and stands within the
// outline, clear of its bevelled rim. It keeps the size it has on a real vehicle: a bigger hull carries more of them,
// not bigger ones. Each has its place by a rule a real vehicle follows — a headlight at the front of the hull, the
// tail lights at its back, the shackles at its lowest corners, a lifting eye at the corners of a roof, a hatch on the
// roof where nothing stands on it, a decorative vent and service cap at the rear — and none stands over a weapon,
// where it goes out through the armour, nor under a sensor or over a piece carried out in the open. Exterior fittings
// use the public hull and visible pieces; they do not locate an engine, tank or crew hidden by the skin.

// Whether a point is within an outline.
export function within(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < a.x + (point.y - a.y) / (b.y - a.y) * (b.x - a.x)) inside = !inside;
  }
  return inside;
}
// The edges of an outline, each with the normal that points out of it: told by which side of the edge is within, so
// it holds for an outline wound either way and along the steps of a hull that is not convex.
export function outlineEdges(points: readonly Point[]): HullEdge[] {
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length]!, length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) return null;
    const normal = { x: (b.y - a.y) / length, y: -(b.x - a.x) / length }, probe = Math.max(1e-4, length * 1e-3),
      out = !within({ x: (a.x + b.x) / 2 + normal.x * probe, y: (a.y + b.y) / 2 + normal.y * probe }, points);
    return { a, b, length, normal: out ? normal : { x: -normal.x, y: -normal.y } };
  }).filter((edge): edge is HullEdge => Boolean(edge));
}
// The outline of a room runs along the middle of its plates. Seen from outside, its skin reaches the outer face of each:
// every edge with a plate along it (`plates`, each the two ends of its middle line and half its thickness, in the frame
// of the outline) is moved out by half the plate, and its corners are where the moved edges meet, cut `MITRE` halves
// out at the sharpest. Where two faces moved out by unlike halves would meet only past the corner along both edges — as
// two plates of unlike thickness end to end in one line do, a vision block in a glacis, or nearly so on a vehicle whose
// outline is rounded — the face before ends at the corner and steps square across to the next there. An edge another
// room stands against anywhere along it (`rooms`) stays where it is, the two skins meeting there, as does one along
// which no plate lies.
const ALONG = .01, MITRE_OUT = 4, PAST = 1e-6;
export function outerFace(points: readonly Point[], plates: readonly (HullSeam & { half: number })[], rooms: readonly (readonly Point[])[] = []): readonly Point[] {
  const edges = outlineEdges(points).map(edge => {
    const { a, b, length, normal } = edge, along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length },
      at = (t: number): Point => ({ x: a.x + (b.x - a.x) * t + normal.x * 1e-3, y: a.y + (b.y - a.y) * t + normal.y * 1e-3 }),
      shared = rooms.some(room => [.05, .25, .5, .75, .95].some(t => within(at(t), room))),
      middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      plate = shared ? null : plates.find(({ a: p, b: q }) => {
        const l = Math.hypot(q.x - p.x, q.y - p.y);
        if (l < 1e-6 || Math.abs(((q.x - p.x) * along.y - (q.y - p.y) * along.x) / l) > .02) return false;
        const t = clamp(((middle.x - p.x) * (q.x - p.x) + (middle.y - p.y) * (q.y - p.y)) / (l * l), 0, 1);
        return Math.hypot(p.x + (q.x - p.x) * t - middle.x, p.y + (q.y - p.y) * t - middle.y) < ALONG;
      });
    return { ...edge, along, out: plate ? plate.half : 0 };
  });
  if (edges.every(edge => !edge.out)) return points;
  return edges.flatMap((edge, i) => {
    const before = edges[(i + edges.length - 1) % edges.length]!, corner = edge.a,
      p = { x: before.a.x + before.normal.x * before.out, y: before.a.y + before.normal.y * before.out },
      q = { x: edge.a.x + edge.normal.x * edge.out, y: edge.a.y + edge.normal.y * edge.out },
      end = { x: corner.x + before.normal.x * before.out, y: corner.y + before.normal.y * before.out },
      step = Math.hypot(q.x - end.x, q.y - end.y) > 1e-9 ? [end, q] : [q],
      turn = before.along.x * edge.along.y - before.along.y * edge.along.x;
    if (Math.abs(turn) < 1e-6) return step;
    const t = ((q.x - p.x) * edge.along.y - (q.y - p.y) * edge.along.x) / turn, meet = { x: p.x + before.along.x * t, y: p.y + before.along.y * t },
      // How far past the corner the meeting is along the edge before, and along the next: at a corner the faces meet
      // across, past it along one and short of it along the other.
      ahead = (meet.x - corner.x) * before.along.x + (meet.y - corner.y) * before.along.y,
      beyond = (meet.x - corner.x) * edge.along.x + (meet.y - corner.y) * edge.along.y;
    if (Math.sign(ahead) === Math.sign(beyond) && Math.min(Math.abs(ahead), Math.abs(beyond)) > PAST) return step;
    const far = Math.hypot(meet.x - corner.x, meet.y - corner.y), most = MITRE_OUT * Math.max(before.out, edge.out);
    return [far <= most ? meet : { x: corner.x + (meet.x - corner.x) * most / far, y: corner.y + (meet.y - corner.y) * most / far }];
  });
}
// Where a level line at `y` crosses the outline, and where an upright one at `x` does: from the least to the most.
function across(points: readonly Point[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if (a.y > y !== b.y > y) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
  }
  return xs.sort((p, q) => p - q);
}
function upright(points: readonly Point[], x: number): number[] {
  const ys: number[] = [];
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if (a.x > x !== b.x > x) ys.push(a.y + (x - a.x) / (b.x - a.x) * (b.y - a.y));
  }
  return ys.sort((p, q) => p - q);
}
// Whether a box — its middle at (x, y), `w` long and `h` tall — stands within an outline, `margin` clear of its edges.
export function boxWithin(box: HullBox, points: readonly Point[], margin = 0): boolean {
  const x0 = box.x - box.w / 2 - margin, y0 = box.y - box.h / 2 - margin, w = box.w + 2 * margin, h = box.h + 2 * margin;
  if (!within(box, points)) return false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    if (segmentInBox({ x: a.x - x0, y: a.y - y0 }, { x: b.x - x0, y: b.y - y0 }, w, h)) return false;
  }
  return true;
}
const overlap = (a: HullBox, b: HullBox, gap = 0): boolean => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;
const bounds = (points: readonly Point[]) => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
const boxOf = (points: readonly Point[], grow = 0): HullBox => {
  const r = bounds(points);
  return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2, w: r.maxX - r.minX + 2 * grow, h: r.maxY - r.minY + 2 * grow };
};
// A number of a string, the same every time: what the fittings of one hull choose among their looks by.
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
// The same, written short: what a picture is told apart by.
export const hashText = (text: string): string => hash(text).toString(36);

// The edges of a room in stretches: those that are its own skin, out in the open (`open`), and those another room of the
// construction lies against, each with its outward normal.
function stretchesOf(points: readonly Point[], rooms: readonly (readonly Point[])[]) {
  const others = rooms.flatMap(room => room.map((a, i): [Point, Point] => [a, room[(i + 1) % room.length]!]));
  return outlineEdges(points).flatMap(edge => {
    const { a, b, length } = edge, ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    let open: Pair[] = [[0, length]];
    for (const [p, q] of others) {
      // Another room's edge along the same line, within a centimetre of it, takes away the stretch it covers.
      const off = (point: Point): number => Math.abs((point.x - a.x) * uy - (point.y - a.y) * ux);
      if (off(p) > .01 || off(q) > .01) continue;
      const s = (p.x - a.x) * ux + (p.y - a.y) * uy, t = (q.x - a.x) * ux + (q.y - a.y) * uy, lo = Math.min(s, t), hi = Math.max(s, t);
      open = open.flatMap(([from, to]): Pair[] => hi <= from || lo >= to ? [[from, to]] : [...(lo > from ? [[from, lo] satisfies Pair] : []), ...(hi < to ? [[hi, to] satisfies Pair] : [])]);
    }
    const cuts = [0, ...open.flat(), length], all: { from: number; to: number; open: boolean }[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1]! - cuts[i]! > .05) all.push({ from: cuts[i]!, to: cuts[i + 1]!, open: i % 2 === 1 });
    return all.map(({ from, to, open }) => ({ normal: edge.normal, open,
      a: { x: a.x + ux * from, y: a.y + uy * from }, b: { x: a.x + ux * to, y: a.y + uy * to } }));
  });
}

// The rim of the skin is bevelled this deep (hull-art.ts), and a fitting stands this far within it.
export const BEVEL = .03, CLEAR = .055;

// How far a wheel rises on its springs to its stop from where it stands as built, at the axle the fender is hung
// round: the springs take a third of the travel of the wheeled chassis under the vehicle as built (game_motion.rs
// `SPRING_REST`), and the rest of it is left above.
export const WHEEL_RISE = CHASSIS_MODELS.wheeled.travel * 2 / 3;
// The fender over a wheel, as the chassis hangs it in front of whatever stands over the wheel (chassis-art.ts `guards`)
// and as the foot of a hull or of a body out in the open is cut for the well behind it (hull-art.ts, cargo-art.ts): a
// band bent square over the tyre of radius `r` (`fenderLine`), `gap` clear of it and `band` wide, its inner edge
// `inner` off the axle, its outer edge `outer`, the corners of its inner edge rounded `round`. The gap is as far as the
// wheel rises to its stop (`WHEEL_RISE`), as a fender is hung on a truck: the tyre meets it only at the stop, and as
// built stands under it by about a third of the radius of the wheel the wheeled chassis is built with. The band is
// about a quarter of the radius, the same over wheels close together (`fenderGroups`) as over one alone.
export function fenderOver(r: number) {
  const gap = WHEEL_RISE, band = .26 * r;
  return { gap, band, inner: r + gap, outer: r + gap + band, round: band * .3 };
}
// The wheels of a row that have one fender over them all (chassis-art.ts `guards`), as the axles close together of the
// HEMTT and the MAN HX have: those whose fenders, each alone, would meet or leave less than a band between them, a strip
// too narrow to be anything but a trap for mud. Each group by the middle of its end axles (`x`), half the way between
// them (`half`), as high and as large as the highest and the largest of its wheels (`y`, `r`), and its axles (`axles`,
// along x); a wheel no other is so close to is a group of its own.
export function fenderGroups<Wheel extends FenderWheel>(wheels: readonly Wheel[]): FenderGroup<Wheel>[] {
  const groups: Wheel[][] = [];
  for (const wheel of [...wheels].sort((a, b) => a.x - b.x)) {
    const group = groups.findLast(g => Math.abs(g.at(-1)!.y - wheel.y) <= wheel.r), last = group?.at(-1),
      mine = fenderOver(wheel.r), theirs = fenderOver((last ?? wheel).r);
    if (last && wheel.x - last.x - mine.outer - theirs.outer < Math.max(mine.band, theirs.band)) group!.push(wheel);
    else groups.push([wheel]);
  }
  return groups.map(axles => ({ x: (axles[0]!.x + axles.at(-1)!.x) / 2, half: (axles.at(-1)!.x - axles[0]!.x) / 2,
    y: Math.max(...axles.map(a => a.y)), r: Math.max(...axles.map(a => a.r)), axles }));
}
// The line a fender is bent to, as the flares of the JLTV are: level over the top of the wheel, down at `FENDER_SLOPE`
// from the level at either end, and straight down from there to its foot, `foot` over the axle, where it is cut level.
// Every straight of it stands `R` off the axle, its corners are rounded `round` (as far as the straights either side
// of each let them be), and it runs as points from one foot over the top to the other, along x from the axle and up
// from it. However round its corners, it is nowhere nearer the axle than `R`, nor further along from it: a fender is
// clear of its tyre by its gap, and as wide as its outer edge stands off the axle. Over a group of wheels it is level
// from over one end axle to over the other, `half` either way from the middle of the two (along x from there), and
// slopes down only at its ends, `R` off the line between those axles. The edges of the band and the well behind it
// (hull-art.ts, cargo-art.ts) are each such a line, their corners rounded about the same centres.
export const FENDER_SLOPE = 60 * Math.PI / 180;
const SLOPE_SIN = Math.sin(FENDER_SLOPE), SLOPE_COS = Math.cos(FENDER_SLOPE), ROUNDING = 6;
// How far along from its end axle the line of a fender `R` off it stands at `v` over the axle: at its side, then up its
// slope to the top.
export const fenderAcross = (R: number, v: number): number => v <= R * Math.tan((Math.PI / 2 - FENDER_SLOPE) / 2) ? R : Math.max(0, (R - v * SLOPE_COS) / SLOPE_SIN);
// How high over its end axle the line of a fender `R` off it stands at `u` along from the axle, as far as it is level or
// sloped: no further along than `R`.
export const fenderHeight = (R: number, u: number): number => Math.abs(u) <= R * Math.tan(FENDER_SLOPE / 2) ? R : (R - Math.abs(u) * SLOPE_SIN) / SLOPE_COS;
// The foot of a fender may be cut at a height of its own at either end (`foot` two heights, back along x, then ahead).
export function fenderLine(R: number, foot: number | Pair, round = 0, half = 0): Pair[] {
  const low = R * Math.tan((Math.PI / 2 - FENDER_SLOPE) / 2), [back, ahead] = Array.isArray(foot) ? foot : [foot, foot],
    side = (f: number): Pair[] => [[fenderAcross(R, f), f], ...(f < low ? [[R, low] satisfies Pair] : []), [R * Math.tan(FENDER_SLOPE / 2), R]],
    corners = [...side(back).map(([u, v]): Pair => [-u - half, v]), ...side(ahead).reverse().map(([u, v]): Pair => [u + half, v])], line: Pair[] = [corners[0]!], last = corners.length - 1;
  for (let i = 1; i < last; i++) {
    // A corner turned to the right, the axle being on the right of the way the line runs: its round from where it
    // leaves the straight before it to where it meets the next, about a centre towards the axle.
    const p = corners[i - 1]!, q = corners[i]!, s = corners[i + 1]!, before = Math.hypot(q[0] - p[0], q[1] - p[1]), after = Math.hypot(s[0] - q[0], s[1] - q[1]),
      d: Pair = [(q[0] - p[0]) / before, (q[1] - p[1]) / before], e: Pair = [(s[0] - q[0]) / after, (s[1] - q[1]) / after],
      turn = Math.acos(clamp(d[0] * e[0] + d[1] * e[1], -1, 1)), tangent = Math.tan(turn / 2),
      along = Math.min(round * tangent, i === 1 ? before : before / 2, i === last - 1 ? after : after / 2), radius = along / tangent;
    if (!(radius > 0)) { line.push(q); continue; }
    const centre: Pair = [q[0] - d[0] * along + d[1] * radius, q[1] - d[1] * along - d[0] * radius], from = Math.atan2(d[0], -d[1]);
    for (let k = 0; k <= ROUNDING; k++) { const angle = from - turn * k / ROUNDING; line.push([centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius]); }
  }
  line.push(corners[last]!);
  return line;
}

// What stands in the way of a fitting, of the pieces a construction carries: a weapon, from its box to where it goes
// out through the armour; a sensor, and the stretch of roof under it; a piece carried out in the open. Seen from inside,
// every piece in the room is in the way too, for a fitting on the far wall to show between them.
function obstacles(points: readonly Point[], pieces: readonly HullPiece[], inside: boolean): HullBox[] {
  const boxes: HullBox[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'weapon') {
      const corners = rectangle(piece.x, piece.y, piece.w, piece.h, piece.angle || 0);
      boxes.push(boxOf(corners, .06));
      // Where the barrel leaves the room: the port, and the mantlet about it.
      const c = Math.cos(piece.angle || 0), s = Math.sin(piece.angle || 0);
      if (within(piece, points)) for (let d = 0; d < 4; d += .02) {
        const at = { x: piece.x + c * d, y: piece.y + s * d };
        if (!within(at, points)) { boxes.push({ x: at.x, y: at.y, w: .56, h: .56 }); break; }
      }
    } else if (piece.kind === 'sensor') {
      const box = boxOf(rectangle(piece.x, piece.y, piece.w, piece.h, piece.angle || 0), .08);
      boxes.push({ ...box, y: box.y - .14, h: box.h + .28 });
    } else if (piece.exposed || inside && !['wheel', 'track'].includes(piece.kind))
      boxes.push(boxOf(rectangle(piece.x, piece.y, piece.w, piece.h, piece.angle || 0), inside ? .03 : .05));
  }
  return boxes;
}

// The fittings cut into the skin rather than fitted on it, which a weld goes round.
const CUT_INTO = new Set(['cab-door', 'armour-door', 'industrial-door', 'access-hatch', 'service-panel', 'hatch']);
// What of a seam from `a` to `b` lies out of a box (its middle at (x, y), `w` long and `h` tall): none, one or two pieces
// of it, each longer than a weld is drawn.
function clear(seam: HullSeam, box: HullBox): HullSeam[] {
  const { a, b } = seam, d = { x: b.x - a.x, y: b.y - a.y };
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-d.x, a.x - (box.x - box.w / 2)], [d.x, box.x + box.w / 2 - a.x], [-d.y, a.y - (box.y - box.h / 2)], [d.y, box.y + box.h / 2 - a.y]] satisfies Pair[]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return [seam]; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
  }
  if (t0 >= t1) return [seam];
  const at = (t: number): Point => ({ x: a.x + d.x * t, y: a.y + d.y * t }), long = (p: Point, q: Point): boolean => Math.hypot(q.x - p.x, q.y - p.y) > .05;
  return ([[a, at(t0)], [at(t1), b]] satisfies [Point, Point][]).filter(([p, q]) => long(p, q)).map(([p, q]) => ({ a: p, b: q }));
}

// The fittings of the skin of one room and the lines its plates are joined along, in the frame of its outline (metres,
// up is up). `scene` tells of the construction:
// - `front`: the way it faces along x, -1 or 1;
// - `rooms`: the outlines of its other rooms, in the same frame;
// - `pieces`: what it carries, each by its kind and its box (`x`, `y`, `w`, `h`, `angle`), whether it stands
//   `exposed`, and of a sensor its `mode`;
// - `vehicle`: whether it drives (a fixed structure has no lights, no shackles, nothing to stow);
// - `cast`: whether it is cast concrete, a work of formwork and not of plates;
// - `side`: 'outside' or 'inside';
// - `seed`: a name it is told apart by, for the looks it chooses among.
export function hullLayout(points: readonly Point[], scene: HullScene & { side?: 'outside' }): HullLayout<DetailKind>;
export function hullLayout(points: readonly Point[], scene: HullScene): HullLayout;
export function hullLayout(points: readonly Point[], scene: HullScene): HullLayout {
  const { front = -1, rooms = [], pieces = [], vehicle = true, cast = false, side = 'outside', seed = '' } = scene,
    inside = side === 'inside', r = bounds(points), width = r.maxX - r.minX, height = r.maxY - r.minY,
    all = [points, ...rooms].map(bounds), lowest = Math.min(...all.map(b => b.minY)), highest = Math.max(...all.map(b => b.maxY)),
    base = r.minY <= lowest + .05, bases = all.filter(b => b.minY <= lowest + .05),
    foremost = base && (front < 0 ? r.minX <= Math.min(...bases.map(b => b.minX)) + .05 : r.maxX >= Math.max(...bases.map(b => b.maxX)) - .05),
    rearmost = base && (front < 0 ? r.maxX >= Math.max(...bases.map(b => b.maxX)) - .05 : r.minX <= Math.min(...bases.map(b => b.minX)) + .05),
    topmost = r.maxY >= highest - .05, stretches = stretchesOf(points, rooms),
    roofs = stretches.filter(s => s.open && s.normal.y > .9 && Math.abs(s.b.x - s.a.x) > .3).map(s => ({ x0: Math.min(s.a.x, s.b.x), x1: Math.max(s.a.x, s.b.x), y: (s.a.y + s.b.y) / 2 }))
      .sort((a, b) => a.x0 - b.x0), longest = roofs.slice().sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0],
    floors = stretches.filter(s => s.open && s.normal.y < -.7).map(s => ({ x0: Math.min(s.a.x, s.b.x), x1: Math.max(s.a.x, s.b.x), y: (s.a.y + s.b.y) / 2 })),
    blocked = obstacles(points, pieces, inside), fittings: HullFitting[] = [], number = hash(seed + ':' + points.map(p => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join(';'));
  // Authored fittings keep their space and identity. Automatic finish fills the remaining room, without adding
  // another door, number or hatch beside the player's own one. Off-surface stamps reserve no visible area.
  const custom = (inside ? [] : scene.details || []).map(detail => {
    const c = Math.abs(Math.cos(detail.angle || 0)), s = Math.abs(Math.sin(detail.angle || 0));
    return { kind: detail.kind, x: detail.x, y: detail.y, w: c * detail.width + s * detail.height, h: s * detail.width + c * detail.height };
  }).filter(box => box.x + box.w / 2 > r.minX && box.x - box.w / 2 < r.maxX && box.y + box.h / 2 > r.minY && box.y - box.h / 2 < r.maxY);
  blocked.push(...custom);
  const customKinds = new Set<HullFittingKind>(custom.map(detail => detail.kind));
  const inRoom = (piece: Point): boolean => within(piece, points);
  // Where the outline is at the front or the back over the height of a box, and where its top and its foot are over
  // its length: the stretch of the outline the box must keep within.
  const end = (y: number, h: number, way: number): number | null => {
    const at = [y - h / 2 - CLEAR, y, y + h / 2 + CLEAR].map(v => across(points, v)).filter(xs => xs.length);
    if (at.length < 3) return null;
    return way < 0 ? Math.max(...at.map(xs => xs[0]!)) : Math.min(...at.map(xs => xs.at(-1)!));
  };
  const top = (x: number, w: number): number | null => {
    const at = [x - w / 2 - CLEAR, x, x + w / 2 + CLEAR].map(v => upright(points, v)).filter(ys => ys.length);
    return at.length < 3 ? null : Math.min(...at.map(ys => ys.at(-1)!));
  };
  const foot = (x: number, w: number): number | null => {
    const at = [x - w / 2 - CLEAR, x, x + w / 2 + CLEAR].map(v => upright(points, v)).filter(ys => ys.length);
    return at.length < 3 ? null : Math.max(...at.map(ys => ys[0]!));
  };
  // A fitting at the first of its places that is free: within the outline, `margin` clear of its rim, clear of what
  // stands in the way — but for what runs `behind` the pieces, seen from inside — and of the fittings already placed.
  const place = (kind: HullFittingKind, w: number, h: number, places: readonly (Point | null)[],
    { margin = CLEAR, behind = false, apart = [], ...more }: { margin?: number; behind?: boolean; apart?: readonly HullBox[]; count?: number; text?: string } = {}): HullFitting | null => {
    if (customKinds.has(kind) || kind === 'cab-door' && (customKinds.has('armour-door') || customKinds.has('industrial-door'))) return null;
    for (const at of places) {
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
      const box = { kind, x: at.x, y: at.y, w, h, ...more };
      if (!boxWithin(box, points, margin) || !behind && blocked.some(other => overlap(box, other)) || fittings.some(other => overlap(box, other, .04))
        || apart.some(other => overlap(box, other))) continue;
      fittings.push(box); return box;
    }
    return null;
  };
  // Places along a span, from its middle out or from one end to the other.
  const steps = (from: number, to: number, step = .05): number[] => { const out: number[] = []; for (let v = from; v <= to + 1e-9; v += step) out.push(v); return out; };
  const outward = (middle: number, half: number, step = .05): number[] => { const out = [middle]; for (let d = step; d <= half + 1e-9; d += step) out.push(middle - d, middle + d); return out; };
  // At an end of the room (`way` along x), at the heights given: the box with its end against the rim.
  const atEnd = (way: number, w: number, h: number, ys: readonly number[]): (Point | null)[] => ys.map(y => { const x = end(y, h, way); return x === null ? null : { x: x - way * (w / 2 + CLEAR + .005), y }; });
  // On the roof: under it, as close as `margin` lets a fitting stand.
  const underRoof = (xs: readonly number[], w: number, h: number, margin: number): (Point | null)[] => xs.map(x => { const y = top(x, w); return y === null ? null : { x, y: y - margin - h / 2 - .002 }; });
  const gear = pieces.filter(p => (p.kind === 'wheel' || p.kind === 'track') && base &&
      floors.some(f => p.x + p.w / 2 > f.x0 && p.x - p.w / 2 < f.x1 && Math.abs(p.y + p.h / 2 - f.y) < .35));
  const H = height, low = r.minY, rearWay = -front;
  // A low bonnet followed by a taller cab tells a truck by its public outline, on wheels or on a track. This also
  // follows an edited or reflected body, without a template tag or knowledge of the equipment hidden inside it.
  const ahead = (roof: Roof, way: number): number => way < 0 ? roof.x0 - r.minX : r.maxX - roof.x1,
    cab = vehicle && base && gear.length > 0 && [front, -front].map(way => {
      const bonnet = roofs.find(roof => ahead(roof, way) < .3 && roof.x1 - roof.x0 > .7 && roof.y < low + H - .4),
        roof = bonnet && roofs.find(roof => roof !== bonnet && ahead(roof, way) > ahead(bonnet, way) &&
          ahead(roof, way) < ahead(bonnet, way) + (bonnet.x1 - bonnet.x0) + .8 &&
          roof.y > bonnet.y + .4 && roof.x1 - roof.x0 > .9);
      return roof ? { bonnet: bonnet!, roof, front: way } : null;
    }).find((cab): cab is { bonnet: Roof; roof: Roof; front: number } => Boolean(cab)),
    bonnet = cab ? cab.bonnet : undefined, cabRoof = cab ? cab.roof : undefined,
    machineCab = (scene.details || []).some(detail => detail.kind === 'industrial-door'),
    roadCab = Boolean(cab) || machineCab, artFront = cab ? cab.front : front;

  const seams: HullSeam[] = [], tracks: { x0: number; x1: number }[] = [],
    arches: { x: number; y: number; r: number; half: number; axles: number[]; over: number[] }[] = [],
    shadows: (HullSeam & { depth: number })[] = [];
  if (!inside) {
    // Where another room stands on this one, or this one on another, the face is in the shade of the joint: deep under
    // a room that stands over it, a little at the foot of one that stands on another.
    for (const s of stretches) if (!s.open && Math.abs(s.normal.y) > .7) shadows.push({ a: s.a, b: s.b, depth: s.normal.y > 0 ? -.12 : .07 });
    // The plates of the side, welded at their joints: upright, a plate as long as a sheet of armour is, at the corners of
    // the roof and of the floor where there are any near; level, at the knee of the front where the side is tall.
    const corners = points.filter(p => p.y > r.maxY - .05 || p.y < r.minY + .05).map(p => p.x),
      count = Math.max(0, Math.round(width / (cast ? 1.2 : 1.9)) - 1);
    for (let i = 1; i <= count; i++) {
      let x = r.minX + i * width / (count + 1);
      const near = corners.filter(c => Math.abs(c - x) < .35 && c - r.minX > .3 && r.maxX - c > .3).sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0];
      if (near !== undefined && !cast) x = near;
      const ys = upright(points, x);
      for (let k = 0; k + 1 < ys.length; k += 2) if (ys[k + 1]! - ys[k]! > .2) seams.push({ a: { x, y: ys[k]! + BEVEL }, b: { x, y: ys[k + 1]! - BEVEL } });
    }
    const knees = points.filter(p => p.y > r.minY + .3 && p.y < r.maxY - .2 && (artFront < 0 ? p.x < r.minX + width * .25 : p.x > r.maxX - width * .25)),
      level = cast ? steps(r.minY + .6, r.maxY - .3, .6) : H > 1 ? [knees.length ? Math.max(...knees.map(p => p.y)) : r.minY + H * .45] : [];
    for (const y of level) {
      const xs = across(points, y);
      for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1]! - xs[k]! > .2) seams.push({ a: { x: xs[k]! + BEVEL, y }, b: { x: xs[k + 1]! - BEVEL, y } });
    }
  }
  // Over the running gear: the stretches of the foot over a track, under which the chassis hangs its skirt
  // (chassis-art.ts); over wheels, an arch round the axles of each group of wheels under one fender (`fenderGroups`,
  // `fenderOver`) the well behind it reaches the foot of, which only the outside shows: the well cut into the foot, behind
  // the fender the chassis hangs in front of it. The axles of it the foot stands over (`over`) have their well in the
  // hull, and seen cut open no fender: the wheels under the same fender the foot does not stand over have one of their
  // own then, over them alone (render.ts).
  for (const piece of gear) if (piece.kind === 'track') for (const f of floors) {
    const x0 = Math.max(f.x0, piece.x - piece.w / 2 - .1), x1 = Math.min(f.x1, piece.x + piece.w / 2 + .1);
    if (x1 - x0 > .1) tracks.push({ x0, x1 });
  }
  const wheels = base ? pieces.filter(p => p.kind === 'wheel').map(p => ({ x: p.x, y: p.y, r: p.w / 2 })) : [], stood: FenderWheel[] = [],
    under = ({ x, y, half = 0 }: Point & { half?: number }, reach: number): Roof[] => floors.filter(f => x + half + reach > f.x0 && x - half - reach < f.x1 && f.y > y && f.y < y + reach);
  // A neighbouring wheel only shares this skin's well when its own envelope reaches the floor.
  for (const group of fenderGroups(wheels.filter(wheel => under(wheel, fenderOver(wheel.r).inner).length))) {
    const { x, y, r, half, axles } = group, well = under(group, fenderOver(r).inner), over = axles.filter(a => well.some(f => a.x > f.x0 && a.x < f.x1));
    if (well.length) arches.push({ x, y, r, half, axles: axles.map(a => a.x), over: over.map(a => a.x) });
    stood.push(...over);
  }
  // Nothing is fitted where a fender stands in front of the foot: seen cut open, where one stands over the wheels the
  // foot does not stand over.
  for (const group of fenderGroups(inside ? wheels.filter(wheel => !stood.includes(wheel)) : wheels)) {
    const { x, y, r, half } = group, { outer } = fenderOver(r);
    if (under(group, outer).length) blocked.push({ x, y: y + outer / 2, w: 2 * (outer + half) + .04, h: outer + .04 });
  }
  // The joints of the plates, as boxes a painted mark keeps off.
  const joints = seams.map(s => ({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2, w: Math.abs(s.b.x - s.a.x) + .03, h: Math.abs(s.b.y - s.a.y) + .03 }));

  if (inside && !cast) {
    // Seen cut open: under the roof a lamp, along the wall a conduit with its clamps, by the crew the box the wiring
    // meets in, and at the foot of the wall of the hull an extinguisher where the crew reaches it.
    place('lamp', .2, .08, underRoof(outward((r.minX + r.maxX) / 2, width / 2 - .3, .1), .2, .08, CLEAR + .02));
    if (longest) {
      const length = Math.min(longest.x1 - longest.x0 - .5, 6);
      // The conduit runs behind the pieces: they are drawn over it.
      if (length > .6) place('conduit', length, .05, underRoof(outward((longest.x0 + longest.x1) / 2, .3, .05), length, .05, CLEAR + .14), { behind: true });
    }
    for (const command of pieces.filter(p => p.kind === 'command' && inRoom(p))) place('junction', .2, .16, outward(command.x, 1, .1).map(x => ({ x, y: command.y + command.h / 2 + .16 })));
    if (base && vehicle) place('extinguisher', .13, .46, outward(r.minX + width * (front < 0 ? .3 : .7), width / 2, .1).map(x => ({ x, y: (foot(x, .13) ?? low) + CLEAR + .24 })));
  } else if (!cast && scene.automaticDetails !== false) {
    if (cab) {
      const w = Math.min(1.12, cabRoof!.x1 - cabRoof!.x0 - .22), x = (cabRoof!.x0 + cabRoof!.x1) / 2;
      const door = place('cab-door', w, 1, underRoof([x], w, 1, .38));
      if (door) place('cab-step', .62, .14, [{ x, y: door.y - door.h / 2 - .16 }]);
      const ventWidth = Math.min(.8, bonnet!.x1 - bonnet!.x0 - .3);
      place('engine', ventWidth, .18, underRoof([(bonnet!.x0 + bonnet!.x1) / 2], ventWidth, .18, .08));
    }
    if (vehicle && foremost) {
      // The lights at the front: high on its plate, where the driver's view of the road is not blocked.
      const lightHeights = cab ? steps(low + .35, bonnet!.y - .12) : steps(low + .3, r.maxY - .2);
      place('headlight', .3, .17, atEnd(artFront, .3, .17, lightHeights.sort((a, b) => Math.abs(a - (low + (roadCab ? .55 : .62 * H))) - Math.abs(b - (low + (roadCab ? .55 : .62 * H))))));
      place('shackle', .2, .2, atEnd(front, .2, .2, steps(low + CLEAR + .1, low + .45)));
    }
    if (vehicle && rearmost && !roadCab) {
      place('taillight', .16, .12, atEnd(rearWay, .16, .12, steps(low + .3, r.maxY - .2).sort((a, b) => Math.abs(a - (low + .66 * H)) - Math.abs(b - (low + .66 * H)))));
      place('shackle', .2, .2, atEnd(rearWay, .2, .2, steps(low + CLEAR + .1, low + .45)));
    }
    // A wheeled vehicle drives on roads: an amber reflector low at either end of its side, over the fender there, as
    // much a light as the others and fitted with them, before a grille or a can takes its corner.
    if (vehicle && base && gear.some(p => p.kind === 'wheel'))
      for (const way of [front, rearWay]) place('marker', .07, .04, atEnd(way, .07, .04, steps(low + .22, low + .6)).map(at => at && { ...at, x: at.x - way * .25 }));
    // A vent and service cap decorate the rear of the hull, without revealing its private equipment.
    if (vehicle && rearmost && !roadCab) {
      const w = Math.min(1.6, Math.max(.4, width * .3)), h = Math.min(.42, Math.max(.2, H * .2));
      place('engine', w, h, atEnd(rearWay, w, h, steps(low + h / 2 + CLEAR, r.maxY - h / 2 - CLEAR)
        .sort((a, b) => Math.abs(a - (low + H * .55)) - Math.abs(b - (low + H * .55)))));
      if (longest) place('filler', .14, .12, underRoof(outward((longest.x0 + longest.x1) / 2 - front * (longest.x1 - longest.x0) * .25, .3), .14, .12, CLEAR + .06));
    }
    // Hatches on a roof nobody stands on, seen edge-on: the driver's at the front of the hull, the commander's on the
    // room at the top, placed by its public outline. A periscope looks out ahead of each, a handle is under it.
    const hatch = (roof: Roof, at: number): void => {
      const box = place('hatch', .62, .085, underRoof(outward(at, Math.max(.2, (roof.x1 - roof.x0) / 2), .05)
        .filter(x => x - .31 > roof.x0 + .2 && x + .31 < roof.x1 - .2), .62, .085, .01), { margin: .008 });
      if (!box) return;
      place('periscope', .15, .085, underRoof([box.x + front * .43, box.x + front * .5], .15, .085, .01), { margin: .008 });
      place('handle', .26, .07, [{ x: box.x - front * .05, y: box.y - .17 }, { x: box.x, y: box.y - .22 }]);
    };
    if (vehicle && roofs.length && !roadCab) {
      const ahead = (front < 0 ? roofs[0] : roofs.at(-1))!;
      if (base && foremost) hatch(ahead, front < 0 ? ahead.x0 + .55 : ahead.x1 - .55);
      if (topmost) hatch(longest!, (longest!.x0 + longest!.x1) / 2 - front * .2 * (longest!.x1 - longest!.x0));
    }
    // A lifting eye at either end of the roof, by its corner.
    if (roofs.length && !roadCab) for (const [x, way] of [[roofs[0]!.x0 + .22, 1], [roofs.at(-1)!.x1 - .22, -1]] satisfies Pair[])
      place('eye', .1, .1, underRoof([x, x + way * .1, x + way * .2], .1, .1, .025), { margin: .02 });
    if (vehicle && base && !roadCab) {
      // Along the hull: the tow cable high on its side, the tools low on it, the jerry cans at its back, and where there
      // is no skirt the rings the load is lashed to over its foot.
      for (const length of [Math.min(3, Math.max(1.2, width * .45)), 1.2, .9]) {
        if (place('cable', length, .08, outward(r.minX + width / 2, width / 2, .1).map(x => { const y = top(x, length); return y === null ? null : { x, y: y - .3 }; }))) break;
      }
      place('tools', 1.1, .15, outward(r.minX + width / 2, width / 2, .1).map(x => { const y = foot(x, 1.1); return y === null ? null : { x, y: y + .3 }; }));
      if (rearmost) for (const count of [2, 1]) if (place('cans', count * .36 + .06, .52, atEnd(rearWay, count * .36 + .06, .52, steps(low + .36, r.maxY - .4)), { count })) break;
      const rings = tracks.length ? 0 : Math.floor(width / 1.6);
      for (let i = 0; i < rings; i++) {
        const x = r.minX + (i + .5) * width / rings;
        place('ring', .08, .08, [x, x + .15, x - .15].map(x => { const y = foot(x, .08); return y === null ? null : { x, y: y + CLEAR + .1 }; }));
      }
    }
    if (vehicle && topmost && !roadCab && (!base || rooms.length === 0)) {
      // The bin at the back of the room at the top, as on the bustle of a turret.
      const w = Math.min(.8, Math.max(.4, width * .3)), h = Math.min(.4, Math.max(.22, H * .4));
      if (H > h + .25) place('bin', w, h, atEnd(rearWay, w, h, steps(low + h / 2 + .1, r.maxY - h / 2 - .12).reverse()));
    }
    // The number of the vehicle, stencilled on the side of the room at the top, on a plate and not across its joints.
    if (vehicle && topmost && H > .45) {
      const text = String(1 + number % 4) + String(1 + (number >>> 3) % 4);
      place('number', .34, .2, [.5, .6, .4, .7, .3].flatMap(k => outward(r.minX + width / 2, width / 2 - .3, .05).map(x => ({ x, y: low + H * k }))),
        { text, apart: joints });
    }
  }
  // A door, a hatch or a cover is cut into the skin, its seam round it: no weld of the plates runs across it, nor across
  // the gutter over a door.
  const covers = [...custom, ...fittings].filter(box => CUT_INTO.has(box.kind)), welds = seams.flatMap(s => covers.reduce((pieces, box) =>
    pieces.flatMap(piece => clear(piece, { ...box, y: box.y + .015, w: box.w + .03, h: box.h + .06 })), [s]));
  // To the millimetre, as the pictures of the fittings are told apart. A fitting that has a front is drawn facing left,
  // and turned about (`flip`) on a hull that faces right; the number reads the same either way.
  const fix = (v: number): number => Math.round(v * 1000) / 1000, point = (p: Point): Point => ({ x: fix(p.x), y: fix(p.y) });
  return { side, cast, vehicle,
    details: inside ? [] : scene.details || [],
    fittings: fittings.map(f => ({ ...f, x: fix(f.x), y: fix(f.y), w: fix(f.w), h: fix(f.h), flip: f.kind !== 'number' && artFront > 0 })),
    seams: welds.map(s => ({ a: point(s.a), b: point(s.b) })), tracks: tracks.map(t => ({ x0: fix(t.x0), x1: fix(t.x1) })),
    arches: arches.map(a => ({ x: fix(a.x), y: fix(a.y), r: fix(a.r), half: fix(a.half), axles: a.axles.map(fix), over: a.over.map(fix) })),
    feet: floors.map(f => ({ x0: fix(f.x0), x1: fix(f.x1), y: fix(f.y) })), shadows: shadows.map(s => ({ a: point(s.a), b: point(s.b), depth: s.depth })) };
}
