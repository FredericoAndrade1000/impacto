import { clamp, segmentInBox } from './math.ts';
import { SENSOR_MODES } from './combat-sensors.ts';
import { standing } from './faction-ui.ts';
import { depositLabelLayout } from './deposit-labels.ts';
import { SIGHT_STEP, EYE_SLACK, EYE_RISE } from './ground-sight.ts';
import type { Point } from './math.ts';
import type { CameraFrame, CameraGround } from './camera.ts';
import type { FieldView } from './faction-ui.ts';
import type { SceneFrame, FramePart } from './scene-frame.ts';
import type { DepositLabelData, DepositLabelItem, DepositLabelPlacement } from './deposit-labels.ts';
import type { EncounterBand } from './encounter-bands.ts';
import type { CargoKind } from './economy-contract.ts';

export type SquadMarkCamera = Pick<CameraFrame, 'toScreen' | 'width' | 'height' | 'y'>;
export interface RadarReading extends Point { id: string; range: number }
export interface RadarGround extends CameraGround { minX?: number; points?: readonly Point[] }
export interface RadarScene { frame: SceneFrame<FieldView>; pose(id: string): Point | null }
export interface SquadDepositMark extends DepositLabelData {
  material?: CargoKind | undefined; supplied?: boolean | undefined; active?: boolean | undefined;
  action?: DepositLabelItem['action'];
}
type AngleSpan = [number, number];
interface RadarProfile { first: number; heights: number[] }
interface RadarHorizon { crests: number[]; first?: number; last?: number }
interface RadarGroundRay extends Point { blocked: boolean }
interface RadarFigure extends RadarReading {
  ends: [RadarGroundRay, RadarGroundRay]; limits: [number, number]; below: [AngleSpan[], AngleSpan[]];
  bottom: RadarGroundRay | null; paths: RadarGroundRay[][];
}
interface RadarCache extends RadarReading {
  reach: number; ground: RadarGround; points: RadarGround['points']; profiles: { left: RadarProfile; right: RadarProfile };
  current?: { left: RadarHorizon; right: RadarHorizon }; figure?: RadarFigure;
}
type MarkAttributes = Readonly<Record<string, string | number | boolean | null | undefined>>;
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing squad mark geometry'); return value; };
function pair<T>(values: T[]): asserts values is [T, T] { if (values.length !== 2) throw new Error('Missing squad mark side'); }

export const MARK_MARGIN = 40;
export const markInView = (camera: Pick<SquadMarkCamera, 'width' | 'height'>, point: Point) => point.x >= -MARK_MARGIN && point.x <= camera.width + MARK_MARGIN &&
  point.y >= -MARK_MARGIN && point.y <= camera.height + MARK_MARGIN;
const decimal = (value: number) => value.toFixed(1), translate = (point: Point) => `translate(${decimal(point.x)} ${decimal(point.y)})`;

// Split the range circle at viewport crossings before drawing it: the arcs of it the ground leaves open (`open`, each from
// an angle to a greater one, counted round from the right as the field has it, from straight down at -π/2 to straight
// down again at 3π/2). Only the visible arcs become short screen-space chords: no giant SVG circle, off-screen dashes or
// work per metre.
const QUARTERS = [-Math.PI / 2, 0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
function radarArc(origin: Point, radius: number, width: number, height: number, open: readonly AngleSpan[] = [[-Math.PI / 2, 3 * Math.PI / 2]]): string {
  const spans: { from: number; to: number; steps: number }[] = [], point = (angle: number) => ({ x: origin.x + radius * Math.cos(angle), y: origin.y - radius * Math.sin(angle) }),
    visible = (p: Point) => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height, crossings = [...QUARTERS];
  for (const x of [0, width]) {
    const side = (x - origin.x) / radius;
    if (side > -1 && side < 1) { const angle = Math.acos(side); crossings.push(angle, angle > Math.PI / 2 ? 2 * Math.PI - angle : -angle); }
  }
  for (const y of [0, height]) {
    const rise = (origin.y - y) / radius;
    if (rise > -1 && rise < 1) crossings.push(Math.asin(rise), Math.PI - Math.asin(rise));
  }
  let total = 0;
  // A chord is within roughly half a pixel of the circle, subject to the fixed frame budget.
  const step = Math.min(Math.PI / 12, 2 / Math.sqrt(radius));
  for (const [first, last] of open) {
    const angles = [first, last, ...crossings.filter(angle => angle > first && angle < last)].sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) {
      const from = required(angles[i - 1]), to = required(angles[i]);
      if (to - from < 1e-10 || !visible(point((from + to) / 2))) continue;
      const steps = Math.max(1, Math.ceil((to - from) / step));
      spans.push({ from, to, steps }); total += steps;
    }
  }
  let path = '', remaining = 96, previous = NaN;
  for (const [index, span] of spans.entries()) {
    const steps = Math.min(span.steps, Math.max(1, Math.floor(96 * span.steps / total)), remaining - (spans.length - index - 1));
    remaining -= steps;
    for (let i = previous === span.from ? 1 : 0; i <= steps; i++) {
      const p = point(span.from + (span.to - span.from) * i / steps);
      path += `${i ? 'L' : 'M'}${decimal(clamp(p.x, 0, width))} ${decimal(clamp(p.y, 0, height))}`;
    }
    previous = span.to;
  }
  return path;
}

// The heights of the ground at the points the cameras' fog reads to one side of a place (ground-sight.ts), as far as
// `reach`: how far from the place the first of them stands (`first`), and all of them, one every `SIGHT_STEP`.
function radarProfile(ground: RadarGround, x: number, side: number, reach: number): RadarProfile {
  const origin = typeof ground.minX === 'number' && Number.isFinite(ground.minX) ? ground.minX : 0, line = (x - origin) / SIGHT_STEP, heights: number[] = [];
  let first: number | null = null;
  for (let k = side > 0 ? Math.floor(line) + 1 : Math.ceil(line) - 1, last = false; !last; k += side) {
    let far = side * (origin + k * SIGHT_STEP - x);
    if (far >= reach) { far = reach; last = true; }
    first ??= far; heights.push(ground.height(x + side * far));
  }
  return { first: required(first), heights };
}

// The same four-metre horizon used by the cameras' fog locates the first ground a ray meets, at an angle over the level
// (`angle`, from straight down at -π/2 to straight up). Search the monotone crest slopes, then intersect just that ground
// segment: no repeated full-distance raycasts or coarse per-ray marching over a long landscape.
function radarGroundRay(eye: RadarReading & { horizon: { left: RadarHorizon; right: RadarHorizon } }, ground: RadarGround, side: number, angle: number): RadarGroundRay {
  const cos = Math.cos(angle), sin = Math.sin(angle), horizon = side < 0 ? eye.horizon.left : eye.horizon.right;
  let low = 0, high = horizon.crests.length / 2;
  while (low < high) {
    const mid = low + high >>> 1;
    if (required(horizon.crests[2 * mid + 1]) * cos > sin * required(horizon.crests[2 * mid]) + 1e-8) high = mid; else low = mid + 1;
  }
  if (low < horizon.crests.length / 2) {
    const far = Math.min(required(horizon.last), required(horizon.first) + low * SIGHT_STEP), near = low ? required(horizon.first) + (low - 1) * SIGHT_STEP : 0,
      below = ground.height(eye.x + side * near) - eye.y, above = ground.height(eye.x + side * far) - eye.y,
      length = far - near, along = (below * length - (above - below) * near) / (sin * length - (above - below) * cos);
    if (along >= 0 && along < eye.range) return { x: eye.x + side * along * cos, y: eye.y + along * sin, blocked: true };
  }
  return { x: eye.x + side * eye.range * cos, y: eye.y + eye.range * sin, blocked: false };
}

// Below the level a ray is looked along at this many angles to each side, down to straight down, for where the ground
// leaves the circle open; and where two of them differ, the angle between them is found to this many halvings.
const RADAR_BELOW = 24, RADAR_HALVINGS = 24;
function radarGroundFigure(reading: RadarReading, ground: RadarGround, saw: RadarCache): RadarFigure {
  const paths: RadarGroundRay[][] = [], ends: RadarGroundRay[] = [], limits: number[] = [], below: AngleSpan[][] = [], horizon = saw.current ??= { left: { crests: [] }, right: { crests: [] } };
  let bottom: RadarGroundRay | null = null;
  // Moving the eye can change which nearby crest comes first. Refit the monotone
  // horizon from the cached heights, rather than searching old crest angles.
  for (const [name, side] of [['left', -1], ['right', 1]] as const) {
    const profile = saw.profiles[name], into = horizon[name], shift = side * (saw.x - reading.x),
      first = Math.max(0, Math.floor((-shift - profile.first) / SIGHT_STEP) + 1);
    let steepest = -Infinity, crest = 0, top = 0;
    into.first = shift + profile.first + first * SIGHT_STEP; into.last = shift + saw.reach; into.crests.length = 0;
    for (let k = first; k < profile.heights.length; k++) {
      const far = shift + Math.min(saw.reach, profile.first + k * SIGHT_STEP), rise = required(profile.heights[k]) - reading.y, slope = rise / far;
      if (slope >= steepest) { steepest = slope; crest = far; top = rise; }
      into.crests.push(crest, top);
    }
  }
  const eye = { ...reading, horizon };
  for (const side of [-1, 1]) {
    const ray = (angle: number) => radarGroundRay(eye, ground, side, angle), end = ray(0), open: AngleSpan[] = [];
    ends.push(end);
    // Under the level: the arcs of the circle the ground leaves open, found between angles that differ.
    const edge = (low: number, high: number, was: boolean) => { for (let i = 0; i < RADAR_HALVINGS; i++) { const middle = (low + high) / 2; if (ray(middle).blocked === was) low = middle; else high = middle; } return (low + high) / 2; };
    const down = ray(-Math.PI / 2);
    let from = -Math.PI / 2, shut = down.blocked;
    if (side > 0) bottom = down;
    for (let i = 1; i <= RADAR_BELOW; i++) {
      const angle = -Math.PI / 2 * (1 - i / RADAR_BELOW), blocked = i === RADAR_BELOW ? end.blocked : ray(angle).blocked;
      if (blocked === shut) continue;
      const at = edge(-Math.PI / 2 * (1 - (i - 1) / RADAR_BELOW), angle, shut);
      if (shut) from = at; else open.push([from, at]);
      shut = blocked;
    }
    if (!shut) open.push([from, 0]);
    below.push(open);
    if (!end.blocked) { limits.push(0); continue; }
    // Above this elevation a ray reaches the nominal circle. The intervening ridge's
    // shadow runs out to that circle, rather than closing visibility at ground level.
    let low = 0, high = Math.PI / 2;
    for (let i = 0; i < RADAR_HALVINGS; i++) { const middle = (low + high) / 2; if (ray(middle).blocked) low = middle; else high = middle; }
    limits.push(high);
    const points = [end];
    for (let i = 1; i <= 48; i++) points.push(ray(low * i / 48));
    points.push(ray(high)); paths.push(points);
  }
  pair(ends); pair(limits); pair(below);
  return { ...reading, ends, limits, below, bottom, paths };
}

function radarGroundPath(paths: readonly (readonly Point[])[], camera: SquadMarkCamera): string {
  let path = '', previous = '';
  for (const points of paths) {
    previous = '';
    for (let i = 1; i < points.length; i++) {
      const a = required(points[i - 1]), b = required(points[i]),
        cut = segmentInBox(camera.toScreen(a.x, a.y), camera.toScreen(b.x, b.y), camera.width, camera.height);
      if (!cut) { previous = ''; continue; }
      const from = `${decimal(cut[0].x)} ${decimal(cut[0].y)}`, to = `${decimal(cut[1].x)} ${decimal(cut[1].y)}`;
      path += `${previous === from ? '' : 'M' + from}L${to}`; previous = to;
    }
  }
  return path;
}

// A nominal instrument limit, never a claim about contacts or visible terrain, of the one vehicle picked while the player
// commands the squad. The one in the player's hands has none: driven, it is seen close, where its limit is no more
// than a dotted line across the view.
// The displayed module pose follows the same interpolation as the vehicle.
export function selectedRadar(state: FieldView | null | undefined, scene: RadarScene | null | undefined, selection: ReadonlySet<string> | null | undefined): RadarReading | null {
  const id = !state?.squad?.manual && selection?.size === 1 ? selection.values().next().value : null,
    actor = id && scene?.frame?.actors.get(id);
  if (!state?.shared || !scene || !id || !actor || standing(actor, state) !== 'own' || actor.ghost || actor.defeated || state.squad?.out?.includes(id)) return null;
  const parts = scene.frame.actorParts.get(id) || [],
    active = (part: FramePart<FieldView>): part is Extract<FramePart<FieldView>, { type: 'module' }> => part.type === 'module' && Number(part.data.health) > 0 && part.data.attached !== false && !part.data.detonated;
  if (!parts.some(part => active(part) && part.data.kind === 'command')) return null;
  let reading: RadarReading | null = null;
  for (const part of parts) {
    if (!active(part) || part.data.kind !== 'sensor' || part.data.sensorMode !== 'radar') continue;
    const reportedRange = 'range' in part.data ? part.data.range : undefined,
      range = typeof reportedRange === 'number' && reportedRange > 0 && Number.isFinite(reportedRange) ? Math.min(reportedRange, SENSOR_MODES.radar.range) : SENSOR_MODES.radar.range,
      pose = scene.pose(part.id);
    if (pose && Number.isFinite(pose.x) && Number.isFinite(pose.y) && (!reading || range > reading.range)) reading = { id: part.id, x: pose.x, y: pose.y, range };
  }
  return reading;
}

// The identity and lettering of a mark survive a pan. Only its placement or its clipped line changes;
// rebuilding a whole SVG would make the browser parse and paint the same labels on every frame.
class Mark {
  declare readonly node: SVGElement;
  declare readonly attributes: Record<string, string>;
  declare readonly parts: Map<string, Mark>;
  declare text?: string | null;
  declare frame?: number;
  declare widths?: Record<string, { text: string | null; width: number }>;
  constructor(tag: keyof SVGElementTagNameMap, parent: SVGElement) {
    this.node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    this.attributes = {}; this.parts = new Map(); parent.append(this.node);
  }
  set(attributes: MarkAttributes): this {
    for (const [key, raw] of Object.entries(attributes)) {
      const value = String(raw);
      if (this.attributes[key] !== value) { this.attributes[key] = value; this.node.setAttribute(key, value); }
    }
    return this;
  }
  part(name: string, tag: keyof SVGElementTagNameMap, attributes: MarkAttributes, text?: string | null): Mark {
    let part = this.parts.get(name);
    if (!part) { part = new Mark(tag, this.node); this.parts.set(name, part); }
    part.set(attributes);
    if (text !== undefined && part.text !== text) { part.text = text; part.node.textContent = text; }
    return part;
  }
}

export class SquadMarks {
  declare readonly root: SVGSVGElement;
  declare readonly marks: Map<string, Mark>;
  declare frame: number;
  declare measure: ((text: string) => number) | null;
  declare camera: SquadMarkCamera;
  declare radarGround?: RadarCache;
  constructor(root: SVGSVGElement, measure: ((text: string) => number) | null = null) { this.root = root; this.marks = new Map(); this.frame = 0; this.measure = measure; }
  begin(camera: SquadMarkCamera): void { this.camera = camera; this.frame++; }
  mark(kind: string, id: string, attributes: MarkAttributes): Mark {
    const key = kind + '\0' + id;
    let mark = this.marks.get(key);
    if (!mark) { mark = new Mark('g', this.root); this.marks.set(key, mark); }
    mark.frame = this.frame; return mark.set(attributes);
  }
  end() {
    for (const [key, mark] of this.marks) if (mark.frame !== this.frame) { mark.node.remove(); this.marks.delete(key); }
  }
  radar(reading: RadarReading, camera: SquadMarkCamera, ground: RadarGround | null = null): void {
    if (![reading.x, reading.y, reading.range, camera.width, camera.height].every(Number.isFinite) || !(reading.range > 0 && camera.width > 0 && camera.height > 0)) return;
    let contour: RadarFigure | null = null;
    if (typeof ground?.height === 'function') {
      if (reading.y <= ground.height(reading.x)) return;
      let kept = this.radarGround;
      if (!kept || kept.id !== reading.id || kept.ground !== ground || kept.points !== ground.points || kept.range !== reading.range ||
          Math.abs(reading.x - kept.x) > EYE_SLACK || Math.abs(reading.y - kept.y) > EYE_RISE) {
        const reach = reading.range + EYE_SLACK;
        kept = this.radarGround = { ...reading, reach, ground, points: ground.points,
          profiles: { left: radarProfile(ground, reading.x, -1, reach), right: radarProfile(ground, reading.x, 1, reach) } };
      }
      // The long terrain sweep is cached, not the displayed pose. Camera motion
      // only reprojects; vehicle motion refits cached heights and short local rays.
      if (!kept.figure || kept.figure.x !== reading.x || kept.figure.y !== reading.y) kept.figure = radarGroundFigure(reading, ground, kept);
      contour = kept.figure;
    }
    const origin = camera.toScreen(reading.x, reading.y), leftEnd = contour?.ends[0], rightEnd = contour?.ends[1], foot = contour?.bottom,
      left = camera.toScreen(leftEnd?.blocked ? leftEnd.x : reading.x - reading.range, leftEnd?.blocked ? leftEnd.y : reading.y),
      right = camera.toScreen(rightEnd?.blocked ? rightEnd.x : reading.x + reading.range, rightEnd?.blocked ? rightEnd.y : reading.y),
      up = camera.toScreen(reading.x, reading.y + reading.range), down = camera.toScreen(reading.x, foot?.blocked ? foot.y : reading.y - reading.range);
    if (![origin.x, origin.y, left.x, left.y, right.x, right.y, up.x, up.y, down.x, down.y].every(Number.isFinite)) return;
    const radius = Math.abs(camera.toScreen(reading.x + reading.range, reading.y).x - origin.x);
    if (!Number.isFinite(radius) || !(radius > 0)) return;
    // The circle all round where the ground leaves it open: over the level from where a crest no longer stands in the way,
    // under it the arcs found to each side; counted round from the right, from straight down to straight down again.
    let open: AngleSpan[] = [[-Math.PI / 2, 3 * Math.PI / 2]];
    if (contour) {
      const [leftBelow, rightBelow] = contour.below, arcs: AngleSpan[] = [[contour.limits[1], Math.PI - contour.limits[0]],
        ...rightBelow, ...leftBelow.map(([from, to]): AngleSpan => [Math.PI - to, Math.PI - from])];
      arcs.sort((a, b) => a[0] - b[0]);
      open = [];
      for (const [from, to] of arcs) { const last = open.at(-1); if (last && from <= last[1] + 1e-12) last[1] = Math.max(last[1], to); else open.push([from, to]); }
    }
    const arc = radarArc(origin, radius, camera.width, camera.height, open),
      terrain = contour ? radarGroundPath(contour.paths, camera) : '',
      visible = (point: Point) => point.x >= 0 && point.x <= camera.width && point.y >= 0 && point.y <= camera.height,
      edges = [left, right].filter(visible), bottom = !foot?.blocked && visible(down),
      compact = !edges.length && !visible(up) && !bottom && !arc && !terrain;
    const cut = segmentInBox(compact ? { x: origin.x - 18, y: origin.y } : left,
      compact ? { x: origin.x + 18, y: origin.y } : right, camera.width, camera.height),
      rise = segmentInBox(down, up, camera.width, camera.height),
      line = (points: readonly [Point, Point] | null) => points ? `M${decimal(points[0].x)} ${decimal(points[0].y)}L${decimal(points[1].x)} ${decimal(points[1].y)}` : '',
      tick = (point: Point) => line(segmentInBox({ x: point.x - 5, y: point.y }, { x: point.x + 5, y: point.y }, camera.width, camera.height));
    if (!cut && !rise && !arc && !terrain) return;
    const mark = this.mark('radar', reading.id, { class: 'radar-range', 'data-radar': reading.id, 'data-compact': compact,
      'data-terrain': Boolean(contour), fill: 'none', 'aria-label': contour ? 'Cobertura aproximada do radar pelo relevo' : 'Limite nominal do radar' });
    mark.part('reach', 'path', { class: 'reach', d: line(cut) });
    mark.part('limits', 'path', { class: 'limits', d: edges.map(point => line(segmentInBox({ x: point.x, y: point.y - 5 }, { x: point.x, y: point.y + 5 }, camera.width, camera.height))).join('')
      + (visible(up) ? tick(up) : '') + (bottom ? tick(down) : '') });
    mark.part('origin', 'circle', { class: 'origin', r: 3, display: visible(origin) ? 'inline' : 'none',
      ...(visible(origin) ? { cx: decimal(origin.x), cy: decimal(origin.y) } : {}) });
    mark.part('arc', 'path', { class: 'arc', d: arc });
    mark.part('rise', 'path', { class: 'rise', d: line(rise) });
    if (contour || mark.parts.has('terrain')) mark.part('terrain', 'path', { class: 'arc', d: terrain });
  }
  encounter(band: EncounterBand, camera: SquadMarkCamera): void {
    if (!Number.isFinite(band.x) || !(band.alpha > 0) || !(camera.width > 0 && camera.height > 0)) return;
    const x = camera.toScreen(band.x, camera.y).x;
    if (!Number.isFinite(x) || x < 0 || x > camera.width) return;
    const half = band.approximate ? 38 : 22, left = Math.max(0, x - half), right = Math.min(camera.width, x + half),
      labelWidth = band.approximate ? 150 : 62,
      mark = this.mark('encounter', band.id, { class: 'encounter-band', 'data-encounter': band.id,
        'data-approximate': Boolean(band.approximate), opacity: clamp(band.alpha, 0, 1).toFixed(2) });
    mark.part('band', 'rect', { x: decimal(left), y: .5, width: decimal(right - left), height: decimal(Math.max(0, camera.height - 1)) });
    mark.part('label', 'text', { x: decimal(Math.max(8, Math.min(x + 8, camera.width - labelWidth - 8))), y: decimal(camera.height / 2) },
      band.approximate ? 'Encontro · proximidades' : 'Encontro');
  }
  depositWidth(mark: Mark, slot: string, text: string | null = ''): number {
    const widths = mark.widths ??= {}, kept = widths[slot];
    if (kept?.text === text) return kept.width;
    if (!this.measure) {
      const pen = document.createElement('canvas').getContext('2d');
      if (!pen) throw new Error('Missing deposit label drawing context');
      // Match the deposit text font in ui.css without SVG layout reads during a frame.
      pen.font = '600 12.5px system-ui, sans-serif'; this.measure = words => pen.measureText(words).width;
    }
    const width = text ? this.measure(text) : 0; widths[slot] = { text, width }; return width;
  }
  // The marks of the deposits in view, with their words laid out clear of one another; a deposit with a button over its
  // words says how big it is (`action`). What each mark is, where it stands and where its words went, for what stands by them.
  deposits<Deposit extends SquadDepositMark>(deposits: readonly Deposit[], project: (deposit: Deposit) => Point) {
    const items: (DepositLabelItem & { deposit: Deposit })[] = [];
    for (const deposit of deposits) {
      const at = project(deposit);
      if (!markInView(this.camera, at)) continue;
      const mark = this.mark('deposit', deposit.id, {}), wide = (slot: string, text: string | null | undefined) => this.depositWidth(mark, slot, text);
      items.push({ deposit, at, action: deposit.action, width: Math.max(wide('text', deposit.text), wide('detail', deposit.detail)),
        shortWidth: Math.max(wide('shortText', deposit.shortText ?? deposit.text), wide('shortDetail', deposit.shortDetail ?? deposit.detail)) });
    }
    const layout = depositLabelLayout(items, this.camera.width, this.camera.height);
    for (const { deposit, at } of items) this.deposit(deposit, at, layout.get(deposit.id));
    return items.map(({ deposit, at }) => ({ deposit, at, layout: layout.get(deposit.id) }));
  }
  deposit(deposit: SquadDepositMark, at: Point, layout: DepositLabelPlacement | null | undefined = null): void {
    if (!markInView(this.camera, at)) return;
    const mode = layout?.mode ?? 'full', shown = mode !== 'hidden', x = layout?.x ?? 0, lift = layout?.lift ?? 0,
      text = layout?.text ?? deposit.text, detail = layout?.detail ?? deposit.detail;
    const mark = this.mark('deposit', deposit.id, { class: 'deposit', 'data-material': deposit.material, 'data-supplied': deposit.supplied,
      'data-deposit': deposit.id, 'data-active': deposit.active, 'data-label': mode, 'data-lane': layout?.lane ?? 0, transform: translate(at) });
    mark.part('body', 'path', { d: 'M0 -9l7 9-7 9-7-9z' });
    mark.part('label', 'text', { x: decimal(x), y: (detail ? -30 : -14) - lift, display: shown ? 'inline' : 'none' }, text);
    mark.part('detail', 'text', { x: decimal(x), y: -14 - lift, display: shown && detail ? 'inline' : 'none' }, detail || '');
    if (layout) mark.part('link', 'line', { x1: 0, y1: -9, x2: decimal(x), y2: -10 - lift,
      display: shown && layout.link ? 'inline' : 'none' });
  }
  heard(id: string, at: Point, placed: boolean): void {
    if (!markInView(this.camera, at)) return;
    const mark = this.mark('heard', id, { class: 'heard', transform: translate({ x: at.x, y: at.y - 30 }) });
    mark.part('stem', 'path', { d: 'M0 30V10', display: placed ? 'inline' : 'none' });
    mark.part('ring', 'circle', { cx: 0, cy: 0, r: 10 });
    mark.part('question', 'path', { d: 'M-3 -2.5a3 3 0 1 1 3 3v2.5m0 3.5v.1' });
  }
  line(kind: string, id: string, from: Point, to: Point, opacity: number, target: 'flag' | 'vehicle' | 'point' | null = null, label = ''): void {
    // Keeping an off-screen destination is useful; tessellating its entire dashed line is not.
    const cut = segmentInBox(from, to, this.camera.width, this.camera.height, MARK_MARGIN), visible = Boolean(target) && markInView(this.camera, to);
    if (!cut && !visible) return;
    const mark = this.mark(kind, id, { opacity }),
      path = cut ? `M${decimal(cut[0].x)} ${decimal(cut[0].y)}L${decimal(cut[1].x)} ${decimal(cut[1].y)}` : '';
    mark.part('line', 'path', { class: kind, d: path, display: cut ? 'inline' : 'none' });
    if (!target) return;
    if (!visible && !mark.parts.has('target')) return;
    const spot = mark.part('target', 'g', { display: visible ? 'inline' : 'none', ...(visible ? { transform: translate(to) } : {}) });
    if (target === 'flag') {
      spot.part('flag', 'path', { class: 'flag', d: 'M0 0v-22l13 5-13 5' });
      if (label || spot.parts.has('label')) spot.part('label', 'text', { class: 'flag-label', x: 16, y: -12, display: label ? 'inline' : 'none' }, label);
    } else {
      const radius = target === 'vehicle' ? 16 : 9;
      spot.part('ring', 'circle', { class: 'target', cx: 0, cy: 0, r: radius });
      spot.part('cross', 'path', { class: 'target', d: `M${-radius - 5} 0h10m${2 * radius - 10} 0h10M0 ${-radius - 5}v10m0 ${2 * radius - 10}v10` });
    }
  }
}

// A tag is a pixel-size box around a projected vehicle; a vehicle has no number on it, only a dot over it for a fresh
// contact of its senses or a hit.
export function squadTagBox(camera: SquadMarkCamera, bounds: { minX: number; maxX: number; minY: number; maxY: number }) {
  const a = camera.toScreen(bounds.minX, bounds.maxY), z = camera.toScreen(bounds.maxX, bounds.minY),
    width = Math.max(30, z.x - a.x + 10), height = Math.max(22, z.y - a.y + 8), cx = (a.x + z.x) / 2, cy = (a.y + z.y) / 2,
    left = Math.round(cx - width / 2), top = Math.round(cy - height / 2);
  return { width, height, cx, cy, left, top, visible: left + width >= -MARK_MARGIN && left <= camera.width + MARK_MARGIN &&
    top + height >= -MARK_MARGIN && top - 9 <= camera.height + MARK_MARGIN };
}

const tagStyles = new WeakMap<HTMLElement, Partial<Record<'transform' | 'width' | 'height', string>>>();
export function updateSquadTag(tag: HTMLElement, box: ReturnType<typeof squadTagBox> | null | undefined,
  { selected, manual, alert, heard }: { selected: boolean; manual: boolean; alert: boolean; heard: boolean }): void {
  const visible = Boolean(box?.visible);
  if (tag.hidden === visible) tag.hidden = !visible;
  if (!visible || !box) return;
  let kept = tagStyles.get(tag);
  if (!kept) { kept = {}; tagStyles.set(tag, kept); }
  const style = { transform: `translate(${box.left}px,${box.top}px)`, width: Math.round(box.width) + 'px', height: Math.round(box.height) + 'px' };
  // CSSOM may return a differently spaced transform from the one assigned. Keep our own last
  // values so a stationary box does not rewrite it merely because the browser normalised it.
  for (const key of ['transform', 'width', 'height'] as const) { const value = style[key]; if (kept[key] !== value) { kept[key] = value; tag.style[key] = value; } }
  for (const [key, raw] of Object.entries({ selected, manual, alert, heard })) {
    const value = String(raw);
    if (tag.dataset[key] !== value) tag.dataset[key] = value;
  }
}
