import type { Point } from './math.ts';

export type SightSpan = [number, number];
export type Spans = readonly (readonly [number, number])[];
export interface SightGround { minX?: number; maxX?: number; height(x: number): number }
export interface SightEye extends Point { left: number; right: number }
export interface EyeHorizon { first: number | null; crests: number[] }
export interface EyeHorizons { left: EyeHorizon; right: EyeHorizon }
export interface SweptEye extends SightEye { sure: SightSpan[]; rim: number[]; horizon?: EyeHorizons }
export type SweptHorizon = Pick<SweptEye, 'x' | 'y' | 'horizon'>;
export interface LookingEye { eye: SightEye; saw: SweptHorizon }
export interface SightFog { seen: Spans; eyes?: readonly LookingEye[]; domes?: readonly (Point & { reach: number })[] }

// The ground a side sees, and the ground it has seen. An eye of a construction, as the core tells it — where it is
// and how far it reaches to the left and to the right — sees what lies within the circle of that reach about it, up
// and down alike, as the sensors of the core see a construction (game_sensors.rs `in_view`): a place in that circle,
// when the straight line to it clears the ground in between. From a crest it sees far and from the bottom of a valley
// as far as the next crest; of what lies beyond a crest it sees the slope that faces it, and not the dead ground
// behind. An eye high over the ground sees a narrower stretch of it, and one higher over it than it reaches sees none.
// A construction with no eye that sees out sees no ground at all, not even what it stands on: the ground in sight is
// where the sensors of the core see a construction of another, and nowhere else. The field keeps of this what each
// faction has explored, and the page draws its mist by it: each on the ground it grew from the seed, the same ground.
// The page sees the air the same way (`ViewSight`): an eye sees a place over the ground when the place is within its
// circle and the straight line to it clears the ground.
//
// Stretches of ground are spans: a list of [from, to] along the world, sorted, none of them touching the next.

// An eye is swept over heights of the ground this far apart, on the lines the outline of a long landscape has its
// own points on: between two of them that ground is straight, and the sweep is exact.
export const SIGHT_STEP = 4;
// An eye that has gone no farther than this along the ground, nor this much up or down, sees what it saw.
export const EYE_SLACK = 2, EYE_RISE = .5;

// Any stretches as spans: sorted, those that touch or overlap made one, and none of no length.
export function merged(stretches: Spans): SightSpan[] {
  const spans: SightSpan[] = [];
  for (const [from, to] of stretches.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0])) {
    const last = spans.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to); else spans.push([from, to]);
  }
  return spans;
}
// The span a place lies in, or none.
function holding(spans: Spans, x: number): readonly [number, number] | null {
  let low = 0, high = spans.length;
  while (low < high) { const mid = low + high >>> 1, span = spans[mid]; if (!span) throw new TypeError('Missing sight span.'); if (span[1] < x) low = mid + 1; else high = mid; }
  const span = spans[low];
  return span && span[0] <= x ? span : null;
}
export const contains = (spans: Spans, x: number): boolean => holding(spans, x) !== null;
// Whether a whole stretch lies in one span.
export const within = (spans: Spans, from: number, to: number): boolean => (holding(spans, from)?.[1] ?? -Infinity) >= to;
// How far a place is from the nearest of the spans: nothing in one of them, and without end where there is none.
export function apart(spans: Spans, x: number): number {
  let low = 0, high = spans.length;
  while (low < high) { const mid = low + high >>> 1, span = spans[mid]; if (!span) throw new TypeError('Missing sight span.'); if (span[1] < x) low = mid + 1; else high = mid; }
  const after = spans[low], before = spans[low - 1];
  return Math.min(after ? Math.max(0, after[0] - x) : Infinity, before ? x - before[1] : Infinity);
}
// Spans and more spans as one list. Spans that the others add nothing to are handed back as they are, the very
// list: whoever keeps them tells by that that nothing changed.
export function unite<S extends Spans>(spans: S, more: Spans): S | SightSpan[] {
  return more.every(([from, to]) => within(spans, from, to)) ? spans : merged([...spans, ...more]);
}
// Spans with every gap between two of them no wider than `gap` closed: one span over both and the gap. A new list.
export function bridged(spans: Spans, gap: number): SightSpan[] {
  const joined: SightSpan[] = [];
  for (const [from, to] of spans) { const last = joined.at(-1); if (last && from - last[1] <= gap) last[1] = to; else joined.push([from, to]); }
  return joined;
}
// What of the spans lies within a stretch.
export function clip(spans: Spans, from: number, to: number): SightSpan[] {
  const cut: SightSpan[] = [];
  let low = 0, high = spans.length;
  while (low < high) { const mid = low + high >>> 1, span = spans[mid]; if (!span) throw new TypeError('Missing sight span.'); if (span[1] <= from) low = mid + 1; else high = mid; }
  for (let i = low; i < spans.length; i++) { const span = spans[i]; if (!span) throw new TypeError('Missing sight span.'); if (!(span[0] < to)) break; cut.push([Math.max(span[0], from), Math.min(span[1], to)]); }
  return cut;
}
// Spans on a grid: of each, the cells whose middle it covers. A cell is taken once its middle was seen, however
// thin the stretches that came over it, and a stretch that covers the middle of none leaves nothing.
export function quantise(spans: Spans, grid: number): SightSpan[] {
  // Counted from a cell and not from zero, where a cell that begins there would begin at a zero of its own sign.
  return merged(spans.map(([from, to]) => [(Math.ceil(from / grid - .5) + 1) * grid - grid, (Math.floor(to / grid - .5) + 1) * grid]));
}

// Where a straight piece of ground lies within a circle of radius `reach`: the piece from `from` along and `a` up to
// `to` along and `b` up, from the middle of the circle. What of it lies within goes in `CUT`, as how far along it
// comes in and goes out — the ends of the piece themselves when all of it lies within —, and whether any does.
const CUT = new Float64Array(2);
function cut(from: number, a: number, to: number, b: number, reach: number): boolean {
  const r2 = reach * reach;
  if (from * from + a * a <= r2 && to * to + b * b <= r2) { CUT[0] = from; CUT[1] = to; return true; }
  const run = to - from, rise = b - a, length = run * run + rise * rise, half = from * run + a * rise, d = half * half - length * (from * from + a * a - r2);
  if (!(length > 0) || d < 0) return false;
  const root = Math.sqrt(d), enter = Math.max(0, (-half - root) / length), leave = Math.min(1, (-half + root) / length);
  if (!(enter < leave)) return false;
  CUT[0] = from + run * enter; CUT[1] = from + run * leave;
  return true;
}
// The ground within the circle of radius `reach` about a place (x, y) — a gun that reaches so far from there reaches it,
// whatever stands in between —, as spans: of the ground straight between its heights read every `SIGHT_STEP` metres, on
// the lines an eye is swept on, what lies within the circle (`cut`). A place high over the ground has a narrower stretch of
// it within its reach, and one higher over it than it reaches none.
export function groundWithin(ground: SightGround, x: number, y: number, reach: number): SightSpan[] {
  const spans: SightSpan[] = [];
  if (!(reach > 0)) return spans;
  const origin = typeof ground.minX === 'number' && Number.isFinite(ground.minX) ? ground.minX : 0, last = x + reach;
  let from = x - reach, low = ground.height(from) - y;
  for (let k = Math.floor((from - origin) / SIGHT_STEP) + 1; from < last; k++) {
    const to = Math.min(origin + k * SIGHT_STEP, last), high = ground.height(to) - y;
    if (cut(from - x, low, to - x, high, reach)) {
      const enter = x + Number(CUT[0]), leave = x + Number(CUT[1]), end = spans.at(-1);
      if (end && enter <= end[1]) end[1] = leave; else spans.push([enter, leave]);
    }
    from = to; low = high;
  }
  return spans;
}

// What an eye at (x, y) sees of the ground to one side (`side`, -1 for the left), swept as far along as `beyond`: of
// the ground in sight, what lies within the circle of radius `within` about it goes onto `spans`, as places of the
// world, and with `rim` each straight piece of it between two heights read that lies within the circle of `beyond`
// but not all of it within that of `within`, as four numbers: from where to where, the nearer place to the left first.
// `foot` is how high the ground under the eye stands over it. The line to a place clears the ground when no place
// before it stood steeper from the eye: the steepest so far is its horizon. The ground is lost at the height it last
// stood on the horizon, and found again where it rises through the line of the horizon, between two heights, on the
// straight ground there.
// Asked for them (`horizon`), it keeps where it read its first height (`first`, how far from the eye; the others
// are every `SIGHT_STEP` on) and, at each height read, the place that made the horizon there (`crests`: how far
// it is from the eye and how high over it, two numbers a height).
function sweep(ground: SightGround, x: number, y: number, side: number, within: number, beyond: number, foot: number,
  spans: SightSpan[], rim: number[] | null = null, horizon: EyeHorizon | null = null): void {
  const origin = typeof ground.minX === 'number' && Number.isFinite(ground.minX) ? ground.minX : 0, line = (x - origin) / SIGHT_STEP, inner = within > 0 ? within * within : -1;
  if (!(beyond > 0)) return;
  // `begin` and `end`: the stretch in sight gathered so far, how far from the eye; one that begins where it ends goes on with it.
  let steepest = -Infinity, near = 0, low = foot, clear = true, crest = 0, top = 0, begin = 0, end = -1;
  for (let k = side > 0 ? Math.floor(line) + 1 : Math.ceil(line) - 1, last = false; !last; k += side) {
    let far = side * (origin + k * SIGHT_STEP - x);
    if (far >= beyond) { far = beyond; last = true; }
    const height = ground.height(x + side * far) - y, slope = height / far;
    if (slope >= steepest) {
      // In sight to its far end: all of it, or from where it rises through the line of the horizon.
      let from = near, rise = low;
      if (!clear) { from = near + (far - near) * (steepest * near - low) / (height - low - steepest * (far - near)); rise = steepest * from; }
      let start = from, stop = far, kept = far * far + height * height <= inner && from * from + rise * rise <= inner;
      if (!kept && cut(from, rise, far, height, beyond)) {
        if (rim) { if (side < 0) rim.push(x - far, y + height, x - from, y + rise); else rim.push(x + from, y + rise, x + far, y + height); }
        if (inner > 0 && cut(from, rise, far, height, within)) { start = Number(CUT[0]); stop = Number(CUT[1]); kept = true; }
      }
      if (kept) {
        if (start === end) end = stop;
        else { if (end > begin) spans.push(side < 0 ? [x - end, x - begin] : [x + begin, x + end]); begin = start; end = stop; }
      }
      steepest = slope; clear = true; crest = far; top = height;
    } else clear = false;
    if (horizon) { horizon.first ??= far; horizon.crests.push(crest, top); }
    near = far; low = height;
  }
  if (end > begin) spans.push(side < 0 ? [x - end, x - begin] : [x + begin, x + end]);
}
// What an eye sees of the ground, as spans: to each side, what is in sight of the ground within the circle of the
// reach it has there, and nothing to a side its own hull hides (a reach of 0); with `horizon`, also the horizon it
// has to each side (`left` and `right`; see `sweep`).
export function eyeSweep(ground: SightGround, eye: SightEye, horizon = true): { spans: SightSpan[]; horizon?: EyeHorizons } {
  const left: EyeHorizon | null = horizon ? { first: null, crests: [] } : null, right: EyeHorizon | null = horizon ? { first: null, crests: [] } : null, spans: SightSpan[] = [],
    foot = eye.left > 0 || eye.right > 0 ? ground.height(eye.x) - eye.y : 0;
  sweep(ground, eye.x, eye.y, -1, eye.left, eye.left, foot, spans, null, left);
  sweep(ground, eye.x, eye.y, 1, eye.right, eye.right, foot, spans, null, right);
  return left && right ? { spans: merged(spans), horizon: { left, right } } : { spans: merged(spans) };
}
// How high over a place an eye sees, as it now stands (`eye`: where, and its reach to each side) by what was swept
// from where it stood (`saw`, an `eyeSweep` with where it was then), over ground that stands as high as `line` there:
// from the line over the crest that stands steepest before the place, or from the foot of its circle where the ground
// lies under that, up to the top of its circle — it sees as far up and down as along. Where the ground there is in
// sight — within the circle and clear of the line over the crest —, from under the ground. Nothing past its reach, or
// where all of the circle there is hidden.
export function eyeColumn(eye: SightEye, saw: SweptHorizon, x: number, line: number): SightSpan | null {
  const away = x - eye.x, side = away < 0 ? -1 : 1, far = Math.abs(away), reach = side < 0 ? eye.left : eye.right;
  if (!(far <= reach)) return null;
  if (!saw.horizon) throw new TypeError('Eye horizon is unavailable.');
  const half = Math.sqrt(reach * reach - far * far), top = eye.y + half, bottom = eye.y - half,
    swept = side < 0 ? saw.horizon.left : saw.horizon.right, from = side * (x - saw.x),
    k = Math.min(swept.crests.length / 2 - 1, Math.floor((from - Number(swept.first)) / SIGHT_STEP + 1e-9));
  let shadow = -Infinity;
  if (k >= 0) {
    // The crest from where the eye is now; one it stands on or has gone past, from where it was swept.
    const crest = Number(swept.crests[2 * k]), rise = Number(swept.crests[2 * k + 1]), run = side * (saw.x + side * crest - eye.x);
    shadow = run > 1 ? eye.y + (saw.y + rise - eye.y) * far / run : saw.y + rise * from / crest;
  }
  if (line >= shadow - 1e-6 && line >= bottom && line <= top) return [-Infinity, Math.max(top, line + GROUND_AIR)];
  const low = Math.max(shadow, bottom, line);
  return low < top ? [low, top] : null;
}
// Over ground in sight, this many metres of air are in sight whatever the reach.
export const GROUND_AIR = 2;

// How far an eye may go from where it was swept, up and down and along at once, and see what it saw.
const SLACK = Math.hypot(EYE_SLACK, EYE_RISE);
// The ground the constructions of one side see, on one ground. What each eye saw is kept while it stands about
// where it stood, with the reach it had: a field at rest is swept once. An eye is swept as far as it reaches and
// `SLACK` more, and what it has in sight is kept as two things (`sure`, `rim`): the spans within its circle shrunk by
// `SLACK`, which it sees from anywhere it may go before it is swept again, and the pieces of ground in sight about the
// edge of its circle, out to `SLACK` past it, each a straight piece from one place to another — what of them is in its
// circle is told again, as it stands, whenever it is asked. So the edges of what an eye sees go with the eye as it
// moves, and what a crest hides from it is found again when it has gone `EYE_SLACK`, or `EYE_RISE` up or down.
// Told to (`horizon`), it keeps the crests of each eye's horizon too, and `looking` has after each look the eyes
// as they stood, each with what was swept from it (`saw`): a page sees the air by them (`ViewSight`).
export class GroundSight {
  declare ground: SightGround;
  declare horizon: boolean;
  declare kept: Map<string, SweptEye>;
  declare asked: number[];
  declare answer: SightSpan[];
  declare looking: LookingEye[];
  constructor(ground: SightGround, { horizon = false }: { horizon?: boolean } = {}) { this.ground = ground; this.horizon = horizon; this.kept = new Map(); this.asked = []; this.answer = []; this.looking = []; }
  // What an eye sees, swept from where it stands (see above).
  sweep(eye: SightEye): SweptEye {
    const ground = this.ground, sure: SightSpan[] = [], rim: number[] = [], left: EyeHorizon | null = this.horizon ? { first: null, crests: [] } : null, right: EyeHorizon | null = this.horizon ? { first: null, crests: [] } : null,
      foot = eye.left > 0 || eye.right > 0 ? ground.height(eye.x) - eye.y : 0;
    sweep(ground, eye.x, eye.y, -1, eye.left - SLACK, eye.left && eye.left + SLACK, foot, sure, rim, left);
    sweep(ground, eye.x, eye.y, 1, eye.right - SLACK, eye.right && eye.right + SLACK, foot, sure, rim, right);
    return { x: eye.x, y: eye.y, left: eye.left, right: eye.right, sure: merged(sure), rim, ...left && right ? { horizon: { left, right } } : {} };
  }
  // `standing` are the constructions that stand: of each its `id` and its `eyes`. With nothing of that another
  // than when last asked, the answer is the very list given then; and so it is when it comes to the same spans.
  seen(standing: readonly { id: string; eyes?: readonly SightEye[] }[]): SightSpan[] {
    const { ground, kept } = this, asked: number[] = [], held = new Set<string>(), found: SightSpan[] = [], looking: LookingEye[] = this.looking = [];
    let swept = false;
    for (const { id, eyes = [] } of standing) {
      for (const [index, eye] of eyes.entries()) {
        const key = id + ':' + index; let saw = kept.get(key);
        asked.push(eye.x, eye.y, eye.left, eye.right); held.add(key);
        if (!saw || saw.left !== eye.left || saw.right !== eye.right || Math.abs(eye.x - saw.x) > EYE_SLACK || Math.abs(eye.y - saw.y) > EYE_RISE) {
          kept.set(key, saw = this.sweep(eye)); swept = true;
        }
        found.push(...clip(saw.sure, eye.x - eye.left, eye.x + eye.right));
        const rim = saw.rim;
        for (let i = 0; i < rim.length; i += 4) {
          // A piece about the edge of its circle, as the eye stands: to each side of it, within the reach it has there.
          const x0 = Number(rim[i]) - eye.x, y0 = Number(rim[i + 1]) - eye.y, x1 = Number(rim[i + 2]) - eye.x, y1 = Number(rim[i + 3]) - eye.y,
            under = x0 < 0 && x1 > 0 ? y0 + (y1 - y0) * -x0 / (x1 - x0) : 0;
          if (x0 < 0 && cut(x0, y0, Math.min(x1, 0), x1 > 0 ? under : y1, eye.left)) found.push([eye.x + Number(CUT[0]), eye.x + Number(CUT[1])]);
          if (x1 > 0 && cut(Math.max(x0, 0), x0 < 0 ? under : y0, x1, y1, eye.right)) found.push([eye.x + Number(CUT[0]), eye.x + Number(CUT[1])]);
        }
        if (this.horizon) looking.push({ eye, saw });
      }
    }
    for (const key of kept.keys()) if (!held.has(key)) kept.delete(key);
    if (!swept && asked.length === this.asked.length && asked.every((value, i) => value === this.asked[i])) return this.answer;
    this.asked = asked;
    const answer = clip(merged(found), ground.minX ?? -Infinity, ground.maxX ?? Infinity), last = this.answer;
    return answer.length === last.length && answer.every(([from, to], i) => { const span = last[i]; return span && from === span[0] && to === span[1]; }) ? last : this.answer = answer;
  }
}

// The sight of a faction over a view, by cells `SIGHT_CELL` pixels wide and tall laid on the world, the same ones
// wherever the view stands: by columns of them, the heights at which the faction sees over each (`runs`, two
// numbers each, from the lowest). It sees from under the ground in sight (`seen`) to the air just over it, by its
// eyes (`eyeColumn`), and in circles of air without them (`domes`: of each its middle and how far about): over its
// base and about what it sees of others.
export const SIGHT_CELL = 8;
export class ViewSight {
  declare columns: number; declare rows: number; declare cell: number; declare first: number; declare bottom: number;
  declare runs: number[][];
  declare found: SightSpan[];
  constructor() { this.columns = 0; this.rows = 0; this.cell = 1; this.first = 0; this.bottom = 0; this.runs = []; this.found = []; }
  // Over the view of a camera, from a frame's fog (`fieldFog`, ground-mist.ts) on a ground: the cells of the screen
  // and one more past each edge, and one more again on the side the cells begin on.
  frame(camera: Point & { zoom: number; width: number; height: number }, fog: SightFog, ground: SightGround): this {
    const { zoom, width, height } = camera, cell = this.cell = SIGHT_CELL / zoom, found = this.found,
      columns = this.columns = Math.ceil(width / SIGHT_CELL) + 3, rows = this.rows = Math.ceil(height / SIGHT_CELL) + 3;
    this.first = Math.floor((camera.x - width / zoom / 2) / cell) - 1; this.bottom = Math.floor((camera.y - height / zoom / 2) / cell) - 1;
    const left = this.first * cell, right = left + columns * cell,
      eyes = (fog.eyes || []).filter(({ eye }) => eye.x - eye.left <= right && eye.x + eye.right >= left),
      domes = (fog.domes || []).filter(dome => dome.x - dome.reach <= right && dome.x + dome.reach >= left);
    while (this.runs.length < columns) this.runs.push([]);
    for (let column = 0; column < columns; column++) {
      const x = (this.first + column + .5) * cell, line = ground.height(x), runs = this.runs[column];
      if (!runs) throw new TypeError('Missing sight column.');
      found.length = 0; runs.length = 0;
      if (contains(fog.seen, x)) found.push([-Infinity, line + GROUND_AIR]);
      for (const { eye, saw } of eyes) { const run = eyeColumn(eye, saw, x, line); if (run) found.push(run); }
      for (const dome of domes) { const far = Math.abs(x - dome.x), half = far <= dome.reach && Math.sqrt(dome.reach ** 2 - far ** 2); if (half !== false) found.push([dome.y - half, dome.y + half]); }
      found.sort((a, b) => a[0] - b[0]);
      for (const [low, high] of found) if (runs.length && low <= Number(runs[runs.length - 1])) runs[runs.length - 1] = Math.max(Number(runs[runs.length - 1]), high); else runs.push(low, high);
    }
    return this;
  }
  // Whether the faction sees a place: by the column it is over, or the nearest of them.
  sees(x: number, y: number): boolean {
    const runs = this.runs[Math.min(this.columns - 1, Math.max(0, Math.floor(x / this.cell) - this.first))];
    if (!runs) throw new TypeError('Missing sight column.');
    for (let i = 0; i < runs.length; i += 2) if (y >= Number(runs[i]) && y <= Number(runs[i + 1])) return true;
    return false;
  }
  // Of each cell, from the lowest row and the left of each, 1 where the faction does not see its middle and 0 where it does.
  cover<Buffer extends { [index: number]: number }>(into: Buffer): Buffer {
    const { columns, rows, cell, bottom } = this;
    for (let column = 0; column < columns; column++) {
      const runs = this.runs[column];
      if (!runs) throw new TypeError('Missing sight column.');
      for (let row = 0, i = 0; row < rows; row++) {
        const y = (bottom + row + .5) * cell;
        while (i < runs.length && Number(runs[i + 1]) < y) i += 2;
        into[row * columns + column] = i < runs.length && Number(runs[i]) <= y ? 0 : 1;
      }
    }
    return into;
  }
}
