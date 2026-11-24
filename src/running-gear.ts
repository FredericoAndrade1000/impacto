import { TAU, clamp, lerp } from './math.ts';
import type { Point, Pose } from './math.ts';

export interface HeightTerrain { height(x: number): number }
export interface TrackTerrain { surface(x: number): { y: number; nx: number; ny: number } }
export interface TrackComponent extends Point {
  width: number; height: number; angle?: number | undefined; mirrored?: boolean | undefined; suspension?: { travel?: number | undefined } | null | undefined;
}
type Edge = readonly [Point, Point];
type NumericBuffer = number[] | Float32Array | Float64Array;
export interface ShadowPatch {
  left: number; right: number; topLeft: number; topRight: number; depthLeft: number; depthRight: number; alpha?: number;
}
interface WheelSet { radius: number; size: number; end: Point; low: number; road: number[]; rows: 1 | 2 }
interface Roller extends Point { radius: number }
interface BeltArc { start: number; span: number; centre: Point; from: number; x?: never; y?: never; c?: never; s?: never }
interface BeltLine { start: number; span: number; x: number; y: number; c: number; s: number; centre?: never; from?: never }
type BeltPiece = BeltArc | BeltLine;
export interface BeltGeometry {
  length: number; r: number;
  at(distance: number): Pose;
  sample<Out extends NumericBuffer>(count: number, start: number, step: number, out: Out): Out;
  arc(i: number): { start: number; from: number; turn: number };
  outline(bend?: number): number[];
}
interface TrackBelt extends BeltGeometry { sprocket: number }
interface BuiltTrack {
  width: number; height: number; wheels: WheelSet; rollers: Roller[];
  crank: { pivot: Point; anchor: Point }; supports: Point[]; rest: number; most: number; taut: number | null;
}
interface RoadWheel extends Point { row: number; pivot: Point }
export interface TrackGear {
  built: BuiltTrack; hold: Pose | null; road: RoadWheel[]; sprocket: Point; idler: Point;
  rollers: (Roller & { foot: Point })[]; side: Pose & { width: number; height: number };
  drawn: (Roller & { role: 'roller' | 'road' | 'sprocket' | 'idler'; rolls: number; shade: number })[];
  crank: { pivot: Point; anchor: Point }; pin: number; sag: number; settled: number; time: number | null;
  readonly belt: TrackBelt; readonly edge: TrackBelt;
}

// The geometry loops below create dense arrays and address only their existing members.
function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new TypeError('Missing running-gear geometry.');
  return value;
}

// Cuts are ordered: each edge visits only the cuts within its horizontal span.
// Every cut still receives its edges in the original order, with the same interpolation.
function lowOutline(cuts: readonly number[], sides: readonly Edge[], verticalMin = false): number[] {
  const lows: number[] = new Array<number>(cuts.length).fill(Infinity);
  for (const [a, b] of sides) {
    const left = Math.min(a.x, b.x) - 1e-8, right = Math.max(a.x, b.x) + 1e-8,
      dx = b.x - a.x, vertical = Math.abs(dx) < 1e-8;
    let first = 0, end = cuts.length;
    while (first < end) {
      const middle = (first + end) >>> 1;
      if (Number(cuts[middle]) < left) first = middle + 1; else end = middle;
    }
    for (let i = first; i < cuts.length && Number(cuts[i]) <= right; i++) {
      const fraction = vertical ? 0 : (Number(cuts[i]) - a.x) / dx,
        y = vertical && verticalMin ? Math.min(a.y, b.y) : lerp(a.y, b.y, fraction);
      lows[i] = Math.min(Number(lows[i]), y);
    }
  }
  return lows;
}

// Ground projection follows the exact terrain profile and uses the clearance
// of each section, instead of a horizontal ellipse at the chassis origin.
// `strip` is the narrowest a section of it is worth being, in metres.
//
// The shadow is one tone throughout, and it is its depth that says how near the part is to the
// ground: a sliver along the ground, thickest under what touches it and thinning to nothing under
// what is lifted and towards both ends. Sections of different tones would show their seams, and
// sections counted from the part would crawl along the ground as it moves: these are cut at
// places of the ground itself, so only the two ends move with the part.
export function terrainShadow(polygon: readonly Point[] | null | undefined, terrain: HeightTerrain, opacity = .28, edges: readonly Edge[] | null = null, strip = .18): ShadowPatch[] {
  if (!polygon?.length) return [];
  const minX = Math.min(...polygon.map(p => p.x)), maxX = Math.max(...polygon.map(p => p.x)),
    width = maxX - minX;
  if (width < .005) return [];
  const sides = edges || polygon.map((p, j): Edge => [p, item(polygon, (j + 1) % polygon.length)]),
    step = Math.max(.18, strip, width / 36), cuts = [minX];
  for (let x = Math.ceil((minX + step * .25) / step) * step; x < maxX - step * .25; x += step) cuts.push(x);
  cuts.push(maxX);
  // How deep the shadow is at a place: by the clearance of the lowest of the part over it.
  const heights = cuts.map(x => terrain.height(x)), lows = lowOutline(cuts, sides), depths = cuts.map((x, i) => {
    const gap = Math.max(0, Number(lows[i]) - Number(heights[i]));
    if (!Number.isFinite(gap)) return 0;
    return (.034 + Math.min(.05, gap * .03)) * Math.exp(-gap * 2.5) * Math.sin(Math.PI * clamp((x - minX) / width, 0, 1)) ** .4;
  });
  const patches: ShadowPatch[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const left = Number(cuts[i]), right = Number(cuts[i + 1]), depthLeft = Number(depths[i]), depthRight = Number(depths[i + 1]);
    if (Math.max(depthLeft, depthRight) < .0015) continue;
    patches.push({ left, right, topLeft: Number(heights[i]) + .003, topRight: Number(heights[i + 1]) + .003,
      depthLeft, depthRight, alpha: opacity });
  }
  return patches;
}

// The shadow a wheel or a track casts where it bears on the ground: a short smudge on the ground line, as deep as
// `deep` metres under where it touches (a few pixels at any zoom) and rising `lift` over the line there, and gone
// where it stands more than a few centimetres clear (`CONTACT_FADE`), so that it lies under the bottom of a tyre and
// along the run of a track on the ground, and under nothing that is lifted. As `terrainShadow`, it is cut at places of
// the ground `step` apart, and follows it.
export const CONTACT_FADE = .07;
export function contactShadow(polygon: readonly Point[] | null | undefined, terrain: HeightTerrain, edges: readonly Edge[] | null = null, step = .1, deep = .06, lift = 0): ShadowPatch[] {
  if (!polygon?.length) return [];
  const minX = Math.min(...polygon.map(p => p.x)), maxX = Math.max(...polygon.map(p => p.x)), width = maxX - minX;
  if (width < .005) return [];
  const sides = edges || polygon.map((p, j): Edge => [p, item(polygon, (j + 1) % polygon.length)]), cuts = [minX];
  for (let x = Math.ceil((minX + step * .25) / step) * step; x < maxX - step * .25; x += step) cuts.push(x);
  cuts.push(maxX);
  const heights = cuts.map(x => terrain.height(x)), lows = lowOutline(cuts, sides, true), depths = cuts.map((x, i) => {
    const gap = Math.max(0, Number(lows[i]) - Number(heights[i]));
    return Number.isFinite(gap) ? deep * Math.exp(-gap / CONTACT_FADE) : 0;
  });
  const patches: ShadowPatch[] = [], over = (i: number): number => .003 + lift * Number(depths[i]) / deep;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const left = Number(cuts[i]), right = Number(cuts[i + 1]);
    if (Math.max(Number(depths[i]), Number(depths[i + 1])) < deep * .05) continue;
    patches.push({ left, right, topLeft: Number(heights[i]) + over(i), topRight: Number(heights[i + 1]) + over(i + 1),
      depthLeft: Number(depths[i]) + over(i), depthRight: Number(depths[i + 1]) + over(i + 1) });
  }
  return patches;
}

// How far out from the middle of each wheel of a track its belt runs, over the height of the track: its road wheels,
// its sprocket and its idler are all as large (game_geometry.rs `TRACK_WHEEL`). The belt is its shoes: out from the
// body of each the grouser it bites the ground with (`TRACK_GROUSER` high), the body `TRACK_SHOE_HALF_THICKNESS` either
// side of the line of the pins its links turn on (`TRACK_PIN` out from the middle of a wheel), and in from it, between
// the two halves of each road wheel, its guide horn (`TRACK_HORN`). Each wheel is drawn as large as the belt leaves it,
// `TRACK_BELT` of the height of the track in from its outline, its rim on the bodies of the shoes.
export const TRACK_WHEEL = .36, TRACK_GROUSER = .025, TRACK_SHOE_HALF_THICKNESS = .035, TRACK_HORN = .065,
  TRACK_BELT = TRACK_GROUSER + 2 * TRACK_SHOE_HALF_THICKNESS, TRACK_PIN = TRACK_WHEEL - TRACK_GROUSER - TRACK_SHOE_HALF_THICKNESS;
// How large the rollers the upper run comes back over are, how much of the light of the outer row the inner row of
// road wheels has, behind it, and how far apart the tyres of two road wheels side by side are at least, over the height
// of the track: any closer and they would seem to touch.
const TRACK_ROLLER = .09, INNER_ROW = .7, ROW_GAP = .05;
// How far the upper run sags between two of what it rests on, a span `l` apart, on a track `h` high as built: `SAG` of
// l² / h, as a chain as taut on a track of any size; and never further than `SAG_MOST` of the height, however slack.
// As the track rides over the ground, its belt round its wheels with its upper run taut is the shorter or the longer
// than as built, and its tensioner takes up most of that: the upper run sags the more or the less than as built, by
// `SAG_RANGE` of that at most, three quarters of the way there once the belt is `SAG_GIVE` of the height of the track
// shorter or longer; and it goes over to that in about `SAG_TURN` seconds.
const SAG = .007, SAG_MOST = .04, SAG_RANGE = .6, SAG_GIVE = .03, SAG_TURN = .15;
// How far below where the track was built a road wheel goes down into a hollow, over the height of the track.
const ROAD_DROP = .03;
// The side of the hull behind the wheels of a track, over the height of the track from its middle: in shadow from `top`
// down to the plate along its foot, from `plate` down to `bottom`, which the arms of the road wheels turn in and the
// brackets of the rollers stand on (track-shoe-art.ts `paintTrackSide`).
export const TRACK_SIDE = Object.freeze({ top: .3, plate: .18, bottom: -.03 });
// How far out the tips of the teeth of a sprocket stand in its picture: on the line of the pins of the belt round it.
export const SPROCKET_TIP = .985;
// The road wheels a track of these dimensions runs on (game_geometry.rs `ComponentKind::road_wheels`).
const trackRoadWheels = (width: number, height: number): number => clamp(Math.round(7 * (width / 5.04) / (height / .74)), 3, 14);
// The wheels a track `width` long and `height` high turns its belt round, in its own frame, its middle at the origin
// (game_geometry.rs `track_wheels`): each `radius` round with the belt on it and all evenly along it, drawn `size` round.
// Its road wheels carry it on the lower run, their middles `low` over its middle, at each of `road`; the sprocket and
// the idler stand one road wheel further on at either end, at `±end.x`, with the upper run over them, raised off the
// ground so that the belt runs up to each from the last road wheel. Road wheels too large to stand side by side, `ROW_GAP`
// apart, are drawn in two rows (`rows`), interleaved as on the Tiger and the Panther: the first, the third and so on in
// the outer row, those between them in the inner one.
export function trackWheels(width: number, height: number): WheelSet {
  const radius = TRACK_WHEEL * height, size = radius - TRACK_BELT * height, end = width / 2 - radius,
    count = trackRoadWheels(width, height), pitch = 2 * end / (count + 1);
  return { radius, size, end: { x: end, y: height / 2 - radius }, low: radius - height / 2,
    road: Array.from({ length: count }, (_, i) => pitch * (i + 1) - end), rows: 2 * size + ROW_GAP * height > pitch ? 2 : 1 };
}
// Where the crank of the idler of a track of these dimensions turns, and where the screw that holds the belt taut by it
// stands, in its own frame as built (`trackWheels`): its pivot on the side of the hull in from the idler and a little
// under its middle, clear of it and of the last road wheel, and the bracket of the screw further in and higher up.
export function idlerMounts(width: number, height: number): { pivot: Point; anchor: Point } {
  const { end } = trackWheels(width, height);
  return { pivot: { x: end.x - .4 * height, y: end.y - .02 * height }, anchor: { x: end.x - .62 * height, y: end.y + .1 * height } };
}
// The rollers the upper run of a track comes back over, in its own frame, `radius` round: about half as many as its road
// wheels less one, two at least, each over the gap between two of them, spread evenly along it, and under the bodies of
// the shoes of the belt as built, which rest on them.
export function trackRollers(width: number, height: number): Roller[] {
  const { end, road } = trackWheels(width, height), size = TRACK_ROLLER * height, gaps = road.length - 1,
    count = Math.max(2, Math.round(road.length / 2) - 1), y = end.y + (TRACK_PIN - TRACK_SHOE_HALF_THICKNESS) * height - size;
  return Array.from({ length: count }, (_, i) => {
    const gap = Math.min(gaps - 1, Math.floor((i + .5) * gaps / count));
    return { x: (Number(road[gap]) + Number(road[gap + 1])) / 2, y, radius: size };
  });
}

// A belt round circles all `r` round, about `centres` in the order it goes round them, counterclockwise from the first,
// with its outside on its right: from each to the next it runs straight, `r` out from the line between them. Round
// each it bends out over, round an end wheel or under a road wheel let down below the line of its neighbours, it
// follows the circle between the two straights; where it bends in, under a road wheel pressed up over that line, it
// does at the corner where the two straights meet, under the wheel. Each turns it by no more than half a turn either
// way, but those it goes round outside (`ends`, by their places in `centres`): round one of them it bends out as far
// as three quarters of a turn, so that a road wheel pressed up level with an end wheel, or over it, has the belt come
// off under that and up to its own underside, and never turns it inside out. Its `length`, and from where it comes onto
// the first, the place and the way it runs at each distance along it (`at`), or at each of `count` distances `step`
// apart back from `start` (`sample`: x, y and the cosine and the sine of the way it runs, four numbers for each, into
// `out`); where along it its arc round each circle begins (`arc`), at what angle round it, and how far it turns; and
// its outline (`outline`), each arc in straight pieces of no more than `bend` of a turn, x and y one after another.
export function beltAround(centres: readonly Point[], r: number, ends: readonly number[] = []): BeltGeometry {
  const n = centres.length, ways: number[] = [], normals: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = item(centres, i), b = item(centres, (i + 1) % n), way = Math.atan2(b.y - a.y, b.x - a.x);
    ways.push(way); normals.push({ x: Math.sin(way), y: -Math.cos(way) });
  }
  const arcs = centres.map((c, i) => {
    const before = item(normals, (i + n - 1) % n), after = item(normals, i), least = ends.includes(i) ? -Math.PI / 2 : -Math.PI;
    let turn = Number(ways[i]) - Number(ways[(i + n - 1) % n]);
    turn -= TAU * Math.floor((turn - least) / TAU);
    if (turn >= 0) return { centre: c, from: Math.atan2(before.y, before.x), turn,
      on: { x: c.x + r * before.x, y: c.y + r * before.y }, off: { x: c.x + r * after.x, y: c.y + r * after.y } };
    const k = r / (1 + before.x * after.x + before.y * after.y), corner = { x: c.x + k * (before.x + after.x), y: c.y + k * (before.y + after.y) };
    return { centre: c, from: Math.atan2(before.y, before.x), turn: 0, on: corner, off: corner };
  });
  // Its pieces in turn, each an arc round a circle (`centre`) or a straight from one to the next.
  const pieces: BeltPiece[] = [];
  let length = 0;
  for (let i = 0; i < n; i++) {
    const arc = item(arcs, i), next = item(arcs, (i + 1) % n), c = Math.cos(Number(ways[i])), s = Math.sin(Number(ways[i]));
    pieces.push({ start: length, span: r * arc.turn, centre: arc.centre, from: arc.from });
    length += r * arc.turn;
    const span = Math.max(0, (next.on.x - arc.off.x) * c + (next.on.y - arc.off.y) * s);
    pieces.push({ start: length, span, x: arc.off.x, y: arc.off.y, c, s });
    length += span;
  }
  const locate = (d: number): number => { let k = pieces.length - 1; while (k > 0 && d < item(pieces, k).start) k--; return k; },
    place = (piece: BeltPiece, along: number, out: NumericBuffer, at: number): void => {
      if (piece.centre) {
        const a = piece.from + along / r, c = Math.cos(a), s = Math.sin(a);
        out[at] = piece.centre.x + r * c; out[at + 1] = piece.centre.y + r * s; out[at + 2] = -s; out[at + 3] = c;
      } else {
        out[at] = piece.x + piece.c * along; out[at + 1] = piece.y + piece.s * along; out[at + 2] = piece.c; out[at + 3] = piece.s;
      }
    }, one = new Float64Array(4);
  return { length, r,
    at(distance: number): Pose {
      const d = (distance % length + length) % length, piece = item(pieces, locate(d));
      place(piece, d - piece.start, one, 0);
      return { x: Number(one[0]), y: Number(one[1]), angle: Math.atan2(Number(one[3]), Number(one[2])) };
    },
    sample<Out extends NumericBuffer>(count: number, start: number, step: number, out: Out): Out {
      let k = -1, before = Infinity;
      for (let i = 0; i < count; i++) {
        let d = ((start - i * step) % length + length) % length;
        if (d >= length) d = 0;
        if (d > before) k = -1;
        if (k < 0) k = locate(d); else while (k > 0 && d < item(pieces, k).start) k--;
        const piece = item(pieces, k);
        place(piece, d - piece.start, out, i * 4); before = d;
      }
      return out;
    },
    arc(i: number) { const piece = item(pieces, 2 * i); return { start: piece.start, from: Number(piece.from), turn: piece.span / r }; },
    outline(bend = Math.PI / 16) {
      const points: number[] = [], add = (x: number, y: number): void => {
        const n = points.length;
        if (!n || Math.abs(Number(points[n - 2]) - x) + Math.abs(Number(points[n - 1]) - y) > 1e-9) points.push(x, y);
      };
      for (const piece of pieces) {
        if (!piece.centre) { add(piece.x, piece.y); add(piece.x + piece.c * piece.span, piece.y + piece.s * piece.span); continue; }
        const turn = piece.span / r, steps = Math.ceil(turn / bend);
        for (let i = 1; i < steps; i++) {
          const a = piece.from + turn * i / steps;
          add(piece.centre.x + r * Math.cos(a), piece.centre.y + r * Math.sin(a));
        }
      }
      return points;
    } };
}
// The belt of a track `r` out from the middles of its wheels where they are drawn (`road` and the two at its ends) and of
// the circles of the line of the pins of its upper run (`run`, `upperRun`), as it goes round them: from the last road
// wheel ahead up round the idler, back along the upper run, down round the sprocket and along under the road wheels. It
// goes round the idler, the second, and the sprocket outside; where the sprocket is among them (`sprocket`).
const IDLER = 1;
function beltOver(road: readonly Point[], idler: Point, run: readonly Point[], sprocket: Point, r: number): TrackBelt {
  const at = IDLER + run.length + 1, belt = beltAround([item(road, road.length - 1), idler, ...run, sprocket, ...road.slice(0, -1)], r, [IDLER, at]);
  return Object.assign(belt, { sprocket: at });
}
// Where the upper run of a track as built (`trackWheels`, `trackRollers`) rests, on the line of the pins of its links:
// over the idler, over each roller, the bodies of its shoes on it, and over the sprocket, from the idler back.
function upperSupports({ end }: Pick<WheelSet, 'end'>, rollers: readonly Roller[], height: number): Point[] {
  const top = end.y + TRACK_PIN * height;
  return [{ x: end.x, y: top }, ...rollers.toReversed().map(({ x, y, radius }) => ({ x, y: y + radius + TRACK_SHOE_HALF_THICKNESS * height })), { x: -end.x, y: top }];
}
// The upper run of a track as built between its supports (`upperSupports`), sagging under the line between each two by
// `sag` of the square of the span: in the frame of the track, as the middles of circles of `pin` under the line of its
// pins (`beltOver`), one under each roller, round which it bends out, and in each span one under each of three places
// a quarter of it apart, on a parabola through the two supports, at each of which it bends in.
function upperRun(supports: readonly Point[], pin: number, sag: number): Point[] {
  const run: Point[] = [];
  for (let i = 0; i + 1 < supports.length; i++) {
    const a = item(supports, i), b = item(supports, i + 1), dip = sag * ((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (i) run.push({ x: a.x, y: a.y - pin });
    for (const f of [.25, .5, .75]) run.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f - 4 * f * (1 - f) * dip - pin });
  }
  return run;
}
// How long the belt of a track round `road`, `idler` and `sprocket` would be with its upper run taut over its supports
// (`upperSupports`, where the hull holds them, `hold`), `pin` out from their middles: round the rollers alone, as the
// places of a run that sags none between them stand in line with them.
const tautLength = (road: readonly Point[], idler: Point, sprocket: Point, supports: readonly Point[], hold: Pose | null, pin: number): number =>
  beltOver(road, idler, supports.slice(1, -1).map(({ x, y }) => held(hold, x, y - pin)), sprocket, pin).length;
// The links of the belt of a track of these dimensions and the teeth of its sprocket: one tooth to a link round the line
// of their pins, for each tooth to stand between the joints of two links as the belt comes round it (`teeth`, `pitch`
// apart along that line). As near `LINK_PITCH` long as that has them, and no fewer than 24 nor more than 180 round it
// (`count`), round the belt as built (`builtGear`).
export const LINK_PITCH = .14;
export function trackLinks(width: number, height: number): { count: number; pitch: number; teeth: number } {
  const { length } = builtGear(width, height).belt, round = TAU * TRACK_PIN * height,
    teeth = Math.max(6, Math.round(round / clamp(LINK_PITCH, length / 180, length / 24))), pitch = round / teeth;
  return { count: clamp(Math.round(length / pitch), 24, 180), pitch, teeth };
}
// The outline of a track (game_geometry.rs `track_outline`), or `inset` inside it: each turn of it straight pieces of no
// more than `1 / pieces` of a half turn, a tenth as the core has it.
export function trackOutline(width: number, height: number, inset = 0, pieces = 10): Point[] {
  const { radius: r, end, road, low } = trackWheels(width, height), radius = r - inset, last = Number(road.at(-1)),
    run = Math.atan2(last - end.x, end.y - low), back = { x: -end.x, y: end.y }, points: Point[] = [];
  // The turn round an end wheel is in two, at its outermost point, which the outline passes once.
  const turns: readonly (readonly [Point, number, number, number])[] = [[{ x: last, y: low }, -Math.PI / 2, run, 0], [end, run, 0, 0], [end, 0, Math.PI / 2, 1],
    [back, Math.PI / 2, Math.PI, 0], [back, Math.PI, Math.PI - run, 1], [{ x: -last, y: low }, Math.PI - run, 1.5 * Math.PI, 0]];
  for (const [middle, from, to, first] of turns) {
    const steps = Math.max(1, Math.ceil((to - from) / (Math.PI / pieces)));
    for (let i = first; i <= steps; i++) {
      const a = from + (to - from) * i / steps;
      points.push({ x: middle.x + radius * Math.cos(a), y: middle.y + radius * Math.sin(a) });
    }
  }
  return points;
}

// A point of a track as built where it is as the track stands now: `hold` is where the frame of the track as built is
// in its frame now (its origin and its turn), as the hull holds it (chassis-art.ts `heldTrack`); with none, where it is.
function held(hold: Pose | null, x: number, y: number): Point {
  if (!hold) return { x, y };
  const c = Math.cos(hold.angle), s = Math.sin(hold.angle);
  return { x: hold.x + c * x - s * y, y: hold.y + s * x + c * y };
}
// The share of its travel a spring of the gear is pressed in by the vehicle as built (game_motion.rs `SPRING_REST`): the
// rest of it is left above, to its stop.
export const SPRING_REST = 1 / 3;
// The running gear of a track as it is drawn, in its own frame, the track (`module`) where it stands on `terrain`:
// - each road wheel (`road`) where its arm has it as the ground under it is, pressed up over a bump by as far as its
//   stroke goes, and where the hull holds the track (`hold`) no further than to the stop of its spring over where it
//   was built (game_motion.rs `carry`, the `travel` of the `suspension` of the track), or lowered into a hollow by
//   `ROAD_DROP` of the height of the track, for the belt under it to follow the ground a little way into it; in its row
//   (`trackWheels`), its arm on a pivot on the hull;
// - its sprocket, its idler and the rollers its upper run comes back over where the hull holds them (`hold`, as
//   `held`), while the track rides up and down on its springs under it, as the core has it; each roller on a bracket
//   from the plate along the foot of the side of the hull (`foot`), and that side behind them all (`side`: its middle,
//   its turn and its size, `TRACK_SIDE`), from over the middle of the sprocket to over that of the idler; the idler on
//   a crank from a pivot on that side, which a screw from a bracket on it holds (`crank`, `idlerMounts`);
// - the belt round them (`belt`, along the line of the pins of its links), under each road wheel where it is, and its
//   outer edge (`edge`), the tips of the grousers of its links: its upper run resting on the rollers and sagging between
//   them (`upperRun`) by `sag` of the square of each span. At `now`, in seconds, it sags as the road wheels and the hull
//   leave the belt slack: as built, and the more or the less as the belt round them with its upper run taut is the
//   shorter or the longer than as built (`settled`, `SAG_RANGE`), going over to that from how it sagged in the gear
//   drawn before (`last`, `SAG_TURN`); with no time (the workshop, `builtGear`), as built.
// Each wheel as it is drawn, in the order it is (`drawn`): the rollers, the inner row of road wheels, a shade darker,
// the sprocket and the idler, and the outer row; how large (`radius`) and how far from its middle it bears on the belt,
// which turns it (`rolls`). The gear drawn before is kept while the hull holds the track the same way, its road wheels
// stay where they were, to the tenth of a millimetre, and its upper run sags as it settles.
export function trackGear(module: TrackComponent, terrain: TrackTerrain, hold: Pose | null = null, last: TrackGear | null = null, now: number | null = null): TrackGear {
  const { width, height } = module, built = last?.built.width === width && last.built.height === height ? last.built : builtTrack(width, height),
    { radius, size, end, road: along, low, rows } = built.wheels,
    angle = module.angle || 0, c = Math.cos(angle), s = Math.sin(angle), sign = module.mirrored ? -1 : 1, pin = TRACK_PIN * height,
    stroke = Math.min(height * .09, .06), drop = ROAD_DROP * height, ys: number[] = [], travel = module.suspension?.travel,
    // How far up the road wheel at `x` can still be pressed in the frame of the track: its stroke, and with the hull
    // holding the track, no further than where its spring meets its stop, which the track may stand at or past already.
    hc = hold ? Math.cos(hold.angle) : 0, hs = hold ? Math.sin(hold.angle) : 0,
    room = hold && travel !== undefined && travel > 0 ? (x: number): number => clamp(hold.y + (low + travel * (1 - SPRING_REST) + hs * (x - hold.x)) / hc - low, 0, stroke) : () => stroke;
  for (const x of along) {
    const worldX = module.x + sign * c * x - s * low, worldY = module.y + sign * s * x + c * low,
      surface = terrain.surface(worldX), normal = Math.max(.4, c * surface.ny - s * surface.nx),
      gap = (worldY - surface.y) * surface.ny - radius;
    ys.push(low + clamp(-gap / normal, -drop, room(x)));
  }
  const still = last?.built === built && unmoved(last, hold, ys);
  if (still && last.sag === last.settled) return last;
  const road: RoadWheel[] = [], rollers: TrackGear['rollers'] = [], drawn: TrackGear['drawn'] = [], sprocket = held(hold, -end.x, end.y), idler = held(hold, end.x, end.y);
  for (let i = 0; i < along.length; i++)
    road.push({ x: Number(along[i]), y: Number(ys[i]), row: rows > 1 ? i % 2 : 0, pivot: held(hold, Number(along[i]) - .09, height * .12) });
  for (const roller of built.rollers) {
    const { x, y } = held(hold, roller.x, roller.y);
    rollers.push({ x, y, radius: roller.radius, foot: held(hold, roller.x, TRACK_SIDE.plate * height) });
    drawn.push({ role: 'roller', x, y, radius: roller.radius, rolls: roller.radius, shade: 1 });
  }
  const middle = held(hold, 0, (TRACK_SIDE.top + TRACK_SIDE.bottom) / 2 * height),
    side = { x: middle.x, y: middle.y, angle: hold?.angle ?? 0, width: 2 * end.x, height: (TRACK_SIDE.top - TRACK_SIDE.bottom) * height };
  for (const { x, y, row } of road) if (row) drawn.push({ role: 'road', x, y, radius: size, rolls: size, shade: INNER_ROW });
  drawn.push({ role: 'sprocket', x: sprocket.x, y: sprocket.y, radius: pin / SPROCKET_TIP, rolls: pin, shade: 1 },
    { role: 'idler', x: idler.x, y: idler.y, radius: size, rolls: pin, shade: 1 });
  for (const { x, y, row } of road) if (!row) drawn.push({ role: 'road', x, y, radius: size, rolls: size, shade: 1 });
  const crank = { pivot: held(hold, built.crank.pivot.x, built.crank.pivot.y), anchor: held(hold, built.crank.anchor.x, built.crank.anchor.y) };
  // How far the upper run sags: as built, and the more or the less, smoothly and within its range, by how much shorter
  // the belt round the wheels where they are would be than as built with its upper run taut; from how far it sagged in
  // the gear before, no more of the way over to that than the time since lets it, and all of it once nearly there.
  const { rest } = built, timed = now !== null,
    settled = !timed ? rest : still && last ? last.settled
      : Math.min(rest * (1 + SAG_RANGE * Math.tanh((builtTaut(built) - tautLength(road, idler, sprocket, built.supports, hold, pin)) / (SAG_GIVE * height))), built.most),
    ease = now !== null && last?.built === built && last.time !== null ? 1 - Math.exp(-clamp(now - last.time, 0, .25) / SAG_TURN) : 1,
    eased = ease === 1 || !last ? settled : last.sag + (settled - last.sag) * ease,
    sag = Math.abs(eased - settled) < 1e-3 * rest ? settled : eased;
  let run: Point[] | null = null, belt: TrackBelt | null = null, edge: TrackBelt | null = null;
  const upper = () => run ??= upperRun(built.supports, pin, sag).map(p => held(hold, p.x, p.y));
  return { built, hold, road, sprocket, idler, rollers, side, drawn, crank, pin, sag, settled, time: timed ? now : null,
    get belt() { return belt ??= beltOver(road, idler, upper(), sprocket, pin); },
    get edge() { return edge ??= beltOver(road, idler, upper(), sprocket, radius); } };
}
// What a track of these dimensions is built with (`trackGear`): its wheels, its rollers and the mounts of the crank of its
// idler, where its upper run rests (`supports`), how far it sags as built (`rest`, `SAG` of the square of each span over
// its height) and at most (`most`).
function builtTrack(width: number, height: number): BuiltTrack {
  const wheels = trackWheels(width, height), rollers = trackRollers(width, height), supports = upperSupports(wheels, rollers, height),
    longest = Math.max(...supports.slice(1).map((b, i) => Math.hypot(b.x - item(supports, i).x, b.y - item(supports, i).y))), most = SAG_MOST * height / longest ** 2;
  return { width, height, wheels, rollers, crank: idlerMounts(width, height), supports, rest: Math.min(SAG / height, most), most, taut: null };
}
// How long the belt of a track as built (`builtTrack`) would be round its wheels on level ground with its upper run taut
// (`tautLength`).
function builtTaut(built: BuiltTrack): number {
  const { wheels: { end, road, low }, supports, height } = built;
  return built.taut ??= tautLength(road.map(x => ({ x, y: low })), end, { x: -end.x, y: end.y }, supports, null, TRACK_PIN * height);
}
// Whether the gear drawn before (`trackGear`) is held as `hold` has it and its road wheels stand at `ys`, to the tenth of a
// millimetre. Out of `trackGear`, for the gear it makes not to hold on to the one before (the belt it lays out later
// would keep all that `trackGear` keeps in a closure).
function unmoved(last: TrackGear, hold: Pose | null, ys: readonly number[]): boolean {
  if (last.hold !== hold) return false;
  for (let i = 0; i < ys.length; i++) if (Math.round(Number(ys[i]) * 1e4) !== Math.round(item(last.road, i).y * 1e4)) return false;
  return true;
}
// The running gear of a track as built, on level ground.
export const builtGear = (width: number, height: number): TrackGear => trackGear({ x: 0, y: 0, angle: 0, width, height }, { surface: () => ({ y: -height / 2, nx: 0, ny: 1 }) });
// Where along the belt of a track (`trackGear`) the pins of its `count` links are, as its sprocket of `teeth` stands
// turned `turn`, the gaps between its teeth at that angle and every `TAU / teeth` on from it: the first pin there, and
// each of the others a share of the belt back from the one before (track-links.ts), one at each gap where the belt comes
// round it, so that each tooth, half a gap on (`SPROCKET_TEETH`), stands between the joints over two pins. The sprocket
// drives the belt, and its turn alone moves the links round: as the hull and the road wheels shape the belt, those round
// the sprocket stay at its teeth, exactly in the middle of its arc and, links and teeth not quite as far apart, within a
// little of a tooth at its ends; the upper run sags the more as the belt is slack, and the far side of the belt takes up
// what it is still longer or shorter.
export const SPROCKET_TEETH = .5;
export function linkStart(gear: Pick<TrackGear, 'belt'>, count: number, teeth: number, turn: number): number {
  const belt = gear.belt, { start, from, turn: arc } = belt.arc(belt.sprocket), tooth = TAU / teeth,
    ratio = belt.length / count / (tooth * belt.r), on = ((turn - from) % tooth + tooth) % tooth;
  return start + arc * belt.r / 2 * (1 - ratio) + on * belt.r * ratio;
}
// The joint over a pin of a belt at `x`, `y` (track-links.ts `TrackLinks`), between the link behind it, running the way
// `c`, `s`, and the one ahead, `kc`, `ks`, each `half` thick either side of the line of their pins: along the way between
// them, `length` either way from the pin, as thick as they are. Where the belt bends in under a wheel, it covers where
// the insides of the two links open, and the edge of the belt over the pin is where their outsides cross. Where it bends
// out over one, it covers where their outsides open, as far out as they are over the pin, from where its outer face
// meets the one to where it meets the other (`face` either way along it); their outsides cut its outer corners (`cut`
// out from the pin at its ends), which would stand out of the belt, and its outer face is the edge there. Into `out`, x
// and y one after another: its corners, inner behind and ahead, outer ahead, where its outer face begins ahead and ends
// behind, and outer behind; the edge over the pin, from the link ahead to the one behind, two places; then `face` of
// `length` and `cut` of `half`.
export function beltJoint<Out extends NumericBuffer>(x: number, y: number, c: number, s: number, kc: number, ks: number, half: number, length: number, out: Out): Out {
  const jx = c + kc, jy = s + ks, across = Math.hypot(jx, jy) || 1, jc = jx / across, js = jy / across,
    cos = jc * c + js * s, bend = c * js - s * jc, face = bend > 0 ? half * bend / (1 + cos) : 0, cut = bend > 0 ? (half - length * bend) / cos : half;
  put(out, 0, x, y, jc, js, -length, -half); put(out, 2, x, y, jc, js, length, -half); put(out, 4, x, y, jc, js, length, cut);
  put(out, 6, x, y, jc, js, face, half); put(out, 8, x, y, jc, js, -face, half); put(out, 10, x, y, jc, js, -length, cut);
  if (bend > 0) { out[12] = Number(out[6]); out[13] = Number(out[7]); out[14] = Number(out[8]); out[15] = Number(out[9]); }
  else {
    const scale = half / (1 + c * kc + s * ks);
    out[12] = out[14] = x + (s + ks) * scale; out[13] = out[15] = y - (c + kc) * scale;
  }
  out[16] = face / length; out[17] = cut / half;
  return out;
}
// The place `along` the way `c`, `s` from `x`, `y` and `outward` out from it, on the right, into `out` from `at`.
function put(out: NumericBuffer, at: number, x: number, y: number, c: number, s: number, along: number, outward: number): void { out[at] = x + along * c + outward * s; out[at + 1] = y + along * s - outward * c; }
// The outline of a track (`source`, its points one after another along a flat array, as componentPolygon has them) as
// it is drawn while it rides on its springs under the hull (`hold`, as `trackGear`): its lower run where the track is,
// round its sprocket and its idler and along its upper run where the hull holds them, and between the two along the
// runs up to them. Into `out`.
export function holdTrackShape<Out extends NumericBuffer>(source: readonly number[] | Float32Array | Float64Array, out: Out, width: number, height: number, hold: Pose | null | undefined): Out {
  const { radius, end, road, low } = trackWheels(width, height), sink = radius * Math.sin(Math.atan2(Number(road.at(-1)) - end.x, end.y - low)),
    foot = low + sink, top = end.y + sink, { x: dx, y: dy, angle } = hold ?? { x: 0, y: 0, angle: 0 }, c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < source.length; i += 2) {
    const x = Number(source[i]), y = Number(source[i + 1]), w = clamp((y - foot) / (top - foot), 0, 1);
    out[i] = x + (dx + c * x - s * y - x) * w; out[i + 1] = y + (dy + s * x + c * y - y) * w;
  }
  return out;
}
