import type { MessageKey } from './message-contract.ts';
import type { Point, Pose } from './math.ts';
import type { AuthoredDetail } from './construction-contract.ts';
import type { DetailKind, DetailHost, DetailHosts } from './vehicle-details.ts';
export interface DetailSize { width: number; height: number }
export interface DetailBox { minX: number; maxX: number; minY: number; maxY: number }
export interface DetailDrag { detail: AuthoredDetail; host: DetailHost; pose: Pose & { mirrored: boolean }; point: Point }
export interface SnapGuide { shift: number; at: number; target: DetailBox }
import { worldToLocal, rectangle } from './math.ts';
import { within } from './hull-details.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';
import { VEHICLE_DETAILS, detailAngle, detailAt, detailPose, detailCorners, detailHostAt, hostForDetail, pickDetail } from './vehicle-details.ts';

// What the player does to the details of a project, as plain arithmetic: the detail editor (detail-editor.ts) turns
// presses, handles and keys into these, and stores what they return. Nothing here changes the format of a detail.

// The catalogue by what the pieces are, in the order the player looks for them. Every kind is in one group.
export const DETAIL_GROUPS = Object.freeze(([
  ['Portas e escotilhas', ['cab-door', 'industrial-door', 'armour-door', 'access-hatch', 'hatch', 'service-panel']],
  ['Luzes e óptica', ['headlight', 'taillight', 'marker', 'periscope']],
  ['Motor', ['engine', 'exhaust', 'filler']],
  ['Carga e ferramentas', ['tools', 'cable', 'cans', 'bin', 'cab-step']],
  ['Ferragens e marcas', ['handle', 'eye', 'ring', 'shackle', 'number']],
] satisfies [MessageKey, DetailKind[]][]).map(([name, kinds]) => Object.freeze({ name, kinds: Object.freeze(kinds) })));

// A turn of the handle settles on these steps; with Shift it is free.
export const TURN_STEP = Math.PI / 12;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// What the catalogue allows each side of a kind, as reference × scale.
export const detailRange = (kind: DetailKind): { width: [number, number]; height: [number, number] } => {
  const spec = VEHICLE_DETAILS[kind];
  return { width: [spec.width * spec.minScale, spec.width * spec.maxScale], height: [spec.height * spec.minScale, spec.height * spec.maxScale] };
};

// A detail drawn at a new place of the world (x, y), turned to `angle` and of a new size, said in the terms of the
// surface it stands on: fixed project space for the hull and the chassis, the frame of a component for a part. What
// the player changes is the player's: it is no longer automatic.
export function placedDetail(detail: AuthoredDetail, host: DetailHost, { x, y, angle, width = detail.width, height = detail.height }: Pose & Partial<DetailSize>): AuthoredDetail {
  const next = { ...detail, width, height };
  delete next.automatic;
  if (detail.space === 'project') {
    const origin = host.origin || VEHICLE_ORIGIN;
    return { ...next, x: x - origin.x, y: y - origin.y, angle: detailAngle(angle) };
  }
  const sign = host.mirrored ? -1 : 1, local = worldToLocal(host.pose, { x, y });
  return { ...next, x: sign * local.u, y: local.v, angle: detailAngle(sign * (angle - host.pose.angle)) };
}

// A corner (0–3, in the order of detailCorners) taken to `point`, the opposite corner staying where it is. Both sides
// grow together unless `free`; each stays in its catalogue range, and a corner taken past the opposite one stops at
// the smallest size rather than turning the detail inside out.
export function resizedPose(pose: Pose, size: DetailSize, corner: number, point: Point, kind: DetailKind, free = false) {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle), [su, sv] = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const)[corner]!,
    anchor = { x: pose.x - c * su * size.width / 2 + s * sv * size.height / 2, y: pose.y - s * su * size.width / 2 - c * sv * size.height / 2 },
    dx = point.x - anchor.x, dy = point.y - anchor.y, u = su * (c * dx + s * dy), v = sv * (-s * dx + c * dy),
    range = detailRange(kind);
  let width, height;
  if (free) { width = clamp(u, ...range.width); height = clamp(v, ...range.height); }
  else {
    const low = Math.max(range.width[0] / size.width, range.height[0] / size.height),
      high = Math.min(range.width[1] / size.width, range.height[1] / size.height),
      scale = low > high ? 1 : clamp((u * size.width + v * size.height) / (size.width ** 2 + size.height ** 2), low, high);
    width = clamp(size.width * scale, ...range.width); height = clamp(size.height * scale, ...range.height);
  }
  const hu = su * width / 2, hv = sv * height / 2;
  return { x: anchor.x + c * hu - s * hv, y: anchor.y + s * hu + c * hv, angle: pose.angle, width, height };
}

// The handle of the turn stands above the detail: the angle that puts it under `point`, in steps of TURN_STEP unless
// `free`.
export function turnedAngle(centre: Point, point: Point, free = false) {
  const angle = Math.atan2(point.y - centre.y, point.x - centre.x) - Math.PI / 2;
  return detailAngle(free ? angle : Math.round(angle / TURN_STEP) * TURN_STEP);
}

const box = (points: readonly Point[]): DetailBox => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
// The nearest of the lines of the targets to one of the moving box's, along one axis, within `reach`.
function nearestLine(moving: DetailBox, targets: readonly DetailBox[], reach: number, [min, max]: ['minX', 'maxX'] | ['minY', 'maxY']): SnapGuide | null {
  let best: SnapGuide | null = null;
  const lines = (b: DetailBox) => [b[min], (b[min] + b[max]) / 2, b[max]];
  for (const target of targets) {
    const ours = lines(moving), theirs = lines(target);
    for (let i = 0; i < 3; i++) {
      const shift = theirs[i]! - ours[i]!;
      if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, at: theirs[i]!, target };
    }
  }
  return best;
}
// A detail held at `point` settles with its middle or its sides on the middle or the sides of the surface under it,
// or of another detail that shows, when one is within `reach`; `guides` are the lines that show the player where.
export function snappedPoint(point: Point, size: DetailSize, angle: number, surface: readonly Point[] | undefined, others: readonly (readonly Point[])[], reach: number) {
  const moving = box(rectangle(point.x, point.y, size.width, size.height, angle)),
    targets = [...(surface && surface.length >= 3 ? [box(surface)] : []), ...others.map(box)],
    x = nearestLine(moving, targets, reach, ['minX', 'maxX']), y = nearestLine(moving, targets, reach, ['minY', 'maxY']),
    at = { x: point.x + (x?.shift ?? 0), y: point.y + (y?.shift ?? 0) }, guides: Point[][] = [];
  if (x) guides.push([{ x: x.at, y: Math.min(moving.minY + (y?.shift ?? 0), x.target.minY) }, { x: x.at, y: Math.max(moving.maxY + (y?.shift ?? 0), x.target.maxY) }]);
  if (y) guides.push([{ x: Math.min(moving.minX + (x?.shift ?? 0), y.target.minX), y: y.at }, { x: Math.max(moving.maxX + (x?.shift ?? 0), y.target.maxX), y: y.at }]);
  return { point: at, guides };
}

// A detail moved with the pointer, `drag` holding where it was taken (`pose`, `point`, `host`, `detail`): it goes onto
// the surface under it, keeping its size, number, turn and reflection as seen; unless `free`, it settles on the lines
// of its surface and of the other details within `reach`.
export function movedDetail(hosts: DetailHosts, details: readonly AuthoredDetail[], drag: DetailDrag, at: Point, { reach = 0, free = false } = {}) {
  let point = { x: drag.pose.x + at.x - drag.point.x, y: drag.pose.y + at.y - drag.point.y }, guides: Point[][] = [];
  const original = drag.detail;
  if (!free && reach > 0) {
    const under = detailHostAt(hosts, point) || drag.host,
      others = details.filter(d => d.id !== original.id).flatMap(d => {
        const host = hostForDetail(hosts, d);
        return host && !hiddenDetail(host, d) ? [detailCorners(host, d)] : [];
      });
    ({ point, guides } = snappedPoint(point, original, drag.pose.angle, under?.polygon, others, reach));
  }
  const host = detailHostAt(hosts, point) || drag.host, target = detailAt(host, point, original.kind, original.id),
    project = target.space === 'project', sign = project ? 1 : host.mirrored ? -1 : 1,
    mirrored = project ? drag.pose.mirrored : drag.pose.mirrored !== Boolean(host.mirrored),
    next = { ...target, width: original.width, height: original.height, ...(original.text ? { text: original.text } : {}),
      angle: project ? drag.pose.angle : detailAngle(sign * (drag.pose.angle - host.pose.angle)) };
  if (mirrored) next.mirrored = true; else delete next.mirrored;
  return { detail: next, guides };
}

// The distance from a point to a polygon's outline, 0 within it.
function gapTo(point: Point, polygon: readonly Point[]) {
  if (within(point, polygon)) return 0;
  let gap = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!, dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy,
      t = length ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1) : 0;
    gap = Math.min(gap, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return gap;
}
// A detail of which nothing shows: off its surface entirely, or with no surface where it stands. The editor draws it
// as an outline the player can take hold of.
export function hiddenDetail(host: DetailHost | null | undefined, detail: AuthoredDetail) {
  if (!host?.polygon?.length) return true;
  const corners = detailCorners(host, detail);
  return ![detailPose(host, detail), ...corners].some(p => within(p, host.polygon)) && !host.polygon.some(p => within(p, corners));
}
// Details stored on a component the project no longer has: nothing to draw them on, nowhere to put them.
export const strayDetails = (hosts: DetailHosts, details: readonly AuthoredDetail[]) => details.filter(detail => !hostForDetail(hosts, detail));
// What a press at `point` takes: a detail it lands on where the detail shows, else the outline of a hidden one, else
// the nearest within `reach` — a reflector is a few pixels across.
export function detailUnder(hosts: DetailHosts, details: readonly AuthoredDetail[], point: Point, reach = 0): AuthoredDetail | null {
  const shown = pickDetail(hosts, details, point);
  if (shown) return shown;
  let nearest: AuthoredDetail | null = null, gap = reach;
  for (const detail of [...details].reverse()) {
    const host = hostForDetail(hosts, detail);
    if (!host) continue;
    const corners = detailCorners(host, detail), hidden = hiddenDetail(host, detail);
    if (hidden && within(point, corners)) return detail;
    const away = gapTo(point, corners);
    if (away > 0 && away < gap) { gap = away; nearest = detail; }
  }
  return nearest;
}

// A point well within a polygon: its centroid, or the middle of the widest span across it at that height.
export function innerPoint(polygon: readonly Point[]): Point {
  let area = 0, x = 0, y = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!, cross = a.x * b.y - b.x * a.y;
    area += cross; x += (a.x + b.x) * cross; y += (a.y + b.y) * cross;
  }
  const centroid = area ? { x: x / (3 * area), y: y / (3 * area) } : polygon[0]!;
  if (within(centroid, polygon)) return centroid;
  const crossings = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!;
    if (a.y > centroid.y !== b.y > centroid.y) crossings.push(a.x + (centroid.y - a.y) / (b.y - a.y) * (b.x - a.x));
  }
  crossings.sort((a, b) => a - b);
  let best = centroid, widest = 0;
  for (let i = 0; i + 1 < crossings.length; i += 2) if (crossings[i + 1]! - crossings[i]! > widest) {
    widest = crossings[i + 1]! - crossings[i]!; best = { x: (crossings[i]! + crossings[i + 1]!) / 2, y: centroid.y };
  }
  return best;
}
// Where a detail taken from the catalogue goes when `point` is the middle of the view: there when a surface is, else
// within the surface nearest to it.
export function additionSpot(hosts: DetailHosts, point: Point) {
  const host = detailHostAt(hosts, point);
  if (host) return { host, point };
  let nearest: DetailHost | null = null, gap = Infinity;
  for (const candidate of hosts) {
    if (candidate.polygon?.length < 3) continue;
    const away = gapTo(point, candidate.polygon);
    if (away < gap) { gap = away; nearest = candidate; }
  }
  if (!nearest) return null;
  const inner = innerPoint(nearest.polygon);
  // The point found is the one of that surface: the topmost surface there may be another.
  return { host: detailHostAt(hosts, inner) || nearest, point: inner };
}

// The detail turned over as in a mirror, in its place.
export function mirroredDetail(detail: AuthoredDetail) {
  const next = { ...detail };
  delete next.automatic;
  if (detail.mirrored) delete next.mirrored; else next.mirrored = true;
  return next;
}
// A copy of a detail beside it, with an identity of its own.
export function copiedDetail(detail: AuthoredDetail, id: string, offset = .12) {
  const next = { ...detail, id, x: detail.x + offset };
  delete next.automatic;
  return next;
}
