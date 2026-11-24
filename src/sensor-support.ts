import { clamp, localToWorld } from './math.ts';
import { RADAR_PEDESTAL_SHARE } from './combat-sensors.ts';
import type { Graphics } from 'pixi.js';
import type { Point, Pose } from './math.ts';
import type { SensorMode } from './combat-sensors.ts';

export interface MaterialGeometry {
  polygons: readonly (readonly Point[])[]; vertices: readonly Point[];
  edges: readonly { a: number; b: number }[];
}
export interface MaterialPlate { id: string; pose: Pose; geometry: MaterialGeometry }
export interface SensorPhysicalSupport { foot: readonly Point[]; normal: Point; reach?: number | undefined; polygon?: readonly Point[] | undefined }
export interface SensorSupportPiece {
  kind: string; width: number; height: number; mirrored?: boolean | undefined;
  sensorMode?: SensorMode | undefined; support?: SensorPhysicalSupport | null | undefined;
}
interface SeatCommon { separate: boolean; foot: readonly [Point, Point]; normal: Point; reach: number; width: number; height: number; sensorMode: SensorMode; mirrored: boolean; key: string }
export type SensorSeat = SeatCommon & ({ mode: 'column'; polygon: readonly Point[] } | { mode: 'bracket'; polygon: null });
type MaterialNormal = { a: Point; b: Point; normal: Point };
type Shape = (points: readonly Point[], color: number, edge?: boolean) => void;
type Nut = (at: Point, up: Point, width: number) => void;

// Gesture intent only (frame-editing.ts): a contact never creates a joint, a solid or manufacturing support. This is
// the compiler's numerical contact margin in metres.
export const MATERIAL_CONTACT_EPS = 1e-7;
const normals = new WeakMap<MaterialGeometry, MaterialNormal[]>(), seats = new WeakMap<SensorPhysicalSupport, { mirrored: boolean; sensorMode: SensorMode; width: number; height: number; seat: SensorSeat | null }>();
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const minus = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const along = (point: Point, direction: Point, amount: number) => ({ x: point.x + direction.x * amount, y: point.y + direction.y * amount });
const finite = (point: Point | null | undefined): point is Point => Number.isFinite(point?.x) && Number.isFinite(point?.y);

function materialNormals(geometry: MaterialGeometry): MaterialNormal[] {
  const cached = normals.get(geometry); if (cached) return cached;
  // The probe is deliberately inside a finite face. A picking tolerance in
  // squared metres would reverse the normal of very short or thin edges.
  const inside = (point: Point) => geometry.polygons.some(poly => {
    const turns = poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length]!; return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    });
    return turns.some(value => value !== 0) && (turns.every(value => value >= 0) || turns.every(value => value <= 0));
  });
  const result = geometry.edges.map(edge => {
    const a = geometry.vertices[edge.a]!, b = geometry.vertices[edge.b]!,
      length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(length > MATERIAL_CONTACT_EPS)) return null;
    const left = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length },
      middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      sign = inside(along(middle, left, Math.min(1e-6, length / 4))) ? -1 : 1;
    return { a, b, normal: { x: left.x * sign, y: left.y * sign } };
  }).filter((edge): edge is MaterialNormal => edge !== null);
  normals.set(geometry, result); return result;
}

// Convex polygons and plate poses use the same coordinate space. Each plate is
// { id, pose, geometry }, where geometry is the remaining regionGeometry, not
// its stock envelope. Callers select the actor and attached material themselves.
// span > EPS is a genuine line contact; zero span is a corner, never an inferred
// platform attachment.
export function polygonMaterialContacts(polygons: readonly (readonly Point[])[], plates: readonly MaterialPlate[]) {
  const contacts: { plateId: string; span: number }[] = [], epsilon = MATERIAL_CONTACT_EPS;
  for (const plate of plates) {
    const pose = plate.pose, geometry = plate.geometry;
    if (!finite(pose) || !Number.isFinite(pose.angle) || !geometry?.polygons?.length) continue;
    const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
    for (const edge of materialNormals(geometry)) {
      const a = localToWorld(pose, edge.a.x, edge.a.y), b = localToWorld(pose, edge.b.x, edge.b.y),
        length = Math.hypot(b.x - a.x, b.y - a.y), tangent = { x: (b.x - a.x) / length, y: (b.y - a.y) / length },
        normal = { x: c * edge.normal.x - s * edge.normal.y, y: s * edge.normal.x + c * edge.normal.y };
      for (const polygon of polygons) {
        if (polygon.length < 3 || !polygon.every(finite)) continue;
        const depths = polygon.map(point => dot(minus(point, a), normal)), least = Math.min(...depths);
        if (least < -epsilon || least > epsilon) continue;
        const positions = polygon.filter((_, i) => depths[i]! <= least + epsilon).map(point => dot(minus(point, a), tangent)),
          lo = Math.max(0, Math.min(...positions)), hi = Math.min(length, Math.max(...positions));
        // Contact with the infinite plane beyond the real edge is no seat.
        if (lo > hi + epsilon) continue;
        const from = clamp(lo, 0, length);
        contacts.push({ plateId: plate.id, span: clamp(hi, from, length) - from });
      }
    }
  }
  return contacts;
}

// What a sensor out in the open stands on, as the core admitted it (game_construction.rs `standoff`: the `support` of
// the piece), to be drawn with it; none for one standing right on a level face, which is painted with its own foot. On
// a column down to the first metal under it (`column`), whose foot lies along that face at whatever angle it lies: a
// flange bolted to the face, a mast — or, short, a fabricated wedge — up to the cradle its own foot is bolted to. Held by
// metal beside it (`bracket`): a flange on that face and a bracket in its box up to its casing, whose foot is painted
// apart (`separate`). Everything is in the sensor's physical frame, before its artwork is mirrored; its head stays as
// the piece stands, never turned to the face.
export function sensorSupport(module: SensorSupportPiece | null | undefined): SensorSeat | null {
  const support = module?.kind === 'sensor' ? module.support : null;
  if (!module || !support || !(module.width > 0) || !(module.height > 0)) return null;
  const mirrored = Boolean(module.mirrored), sensorMode = module.sensorMode || 'visual', { width, height } = module,
    kept = seats.get(support);
  if (kept?.mirrored === mirrored && kept.sensorMode === sensorMode && kept.width === width && kept.height === height) return kept.seat;
  const seat = describe(support, width, height, sensorMode, mirrored);
  seats.set(support, { mirrored, sensorMode, width, height, seat });
  return seat;
}

function describe(support: SensorPhysicalSupport, width: number, height: number, sensorMode: SensorMode, mirrored: boolean): SensorSeat | null {
  const { foot, normal, reach, polygon } = support;
  if (!Array.isArray(foot) || foot.length !== 2 || !foot.every(finite) || !finite(normal)) return null;
  const level = normal.y > Math.abs(normal.x) && Math.abs(normal.x) <= .001,
    mode = reach !== undefined && reach > 0 && polygon && polygon.length >= 3 && polygon.every(finite) ? 'column' : reach === undefined && !level ? 'bracket' : null;
  if (!mode) return null;
  const key = [mode, sensorMode, mirrored, width, height, reach ?? -1, ...[...foot, normal].flatMap(point => [point.x, point.y])]
    .map(value => typeof value === 'number' ? Math.round(value * 1e5) : value).join(':');
  const common = { separate: mode === 'bracket', foot: [foot[0]!, foot[1]!] satisfies [Point, Point], normal, reach: reach ?? 0, width, height, sensorMode, mirrored, key };
  return mode === 'column' && polygon ? { ...common, mode, polygon } : { ...common, mode: 'bracket', polygon: null };
}

// What of a convex polygon lies inside another, counter-clockwise one.
function clip(points: readonly Point[], convex: readonly Point[]): readonly Point[] {
  let kept = points;
  for (let i = 0; i < convex.length && kept.length; i++) {
    const a = convex[i]!, b = convex[(i + 1) % convex.length]!, next: Point[] = [],
      side = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    for (let j = 0; j < kept.length; j++) {
      const p = kept[j]!, q = kept[(j + 1) % kept.length]!, sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const k = sp / (sp - sq); next.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k }); }
    }
    kept = next;
  }
  return kept;
}

// The casing that stays painted when its bolt-on foot is drawn separately.
// Its nearby face, rather than the sensor's centre, ends the small bracket.
function bodyBounds({ width: W, height: H, sensorMode }: Pick<SensorSeat, 'width' | 'height' | 'sensorMode'>) {
  if (sensorMode === 'radar') {
    const turn = H * RADAR_PEDESTAL_SHARE, flange = Math.min(.022, turn * .16);
    return { minX: -W * .19, maxX: W * .19, minY: -H / 2 + flange, maxY: -H / 2 + turn };
  }
  if (sensorMode === 'sound') {
    const post = Math.min(.024, W * .075), foot = Math.min(.034, H * .15), top = Math.min(.074, H * .31) * 1.2 * .8;
    return { minX: -post / 2, maxX: post / 2, minY: -H / 2 + foot, maxY: H / 2 - top };
  }
  const ring = Math.min(.026, H * .11), pan = Math.min(.05, H * .21);
  return { minX: -W * .47, maxX: W * .47, minY: -H / 2 + ring + pan - .004, maxY: H / 2 };
}

const PAINT = { steel: 0x4b5742, lit: 0x6d7b61, shade: 0x2c372f, flange: 0x3b4640, bolt: 0x9aa38b, outline: 0x141c17 };

// Draw into a Graphics belonging to the sensor's group, behind its picture. That group may mirror the bitmap:
// compensate here so the mount still meets the physical face. A column stays inside the solid the core admitted
// (`polygon`) and the box of the sensor; a bracket inside the box alone. Drawn once for each seat (`key`).
export function drawSensorSupport(g: Graphics, seat: SensorSeat | null | undefined) {
  if (!seat) return;
  const size = Math.min(seat.width, seat.height), line = Math.min(.0016, size * .008),
    shape: Shape = (points, color, edge = true) => {
      if (points.length < 3) return;
      g.poly(points.flatMap(p => [seat.mirrored ? -p.x : p.x, p.y])).fill(color);
      if (edge) g.stroke({ width: line, color: PAINT.outline });
    },
    // A nut on its washer, standing on a face at `at` whose normal is `up`.
    nut: Nut = (at, up, w) => {
      const across = { x: up.y, y: -up.x }, h = w * .62, washer = w * .16;
      shape([along(at, across, -w * .62), along(at, across, w * .62), along(along(at, across, w * .62), up, washer), along(along(at, across, -w * .62), up, washer)], PAINT.lit);
      const foot = along(at, up, washer);
      shape([along(foot, across, -w / 2), along(foot, across, w / 2), along(along(foot, across, w / 2), up, h), along(along(foot, across, -w / 2), up, h)], PAINT.bolt);
    };
  if (seat.mode === 'column') drawColumn(seat, shape, nut);
  else drawBracket(seat, shape, nut);
}

// A column from the face under a sensor up to its foot: the flange laid along the face and bolted to it, the cradle its
// foot is bolted to, and between them a square mast stayed by gussets at either end — or, too short for one, a wedge.
function drawColumn(seat: Extract<SensorSeat, { mode: 'column' }>, shape: Shape, nut: Nut) {
  const { foot: [rear, front], normal: n, reach, height, polygon } = seat, base = -height / 2, half = (front.x - rear.x) / 2,
    face = (x: number) => rear.y + (front.y - rear.y) * (x - rear.x) / (front.x - rear.x),
    gauge = clamp(half * .18, .004, .014), t = Math.min(gauge, reach * .3), tc = Math.min(gauge * .9, reach * .3),
    // The top of the flange, plumb over the face, and the foot of the cradle.
    seatOn = (x: number) => face(x) + t / Math.max(n.y, .2), under = base - tc, mast = half * .45,
    room = Math.min(under - seatOn(-mast), under - seatOn(mast)), low = Math.min(rear.y, front.y) - 1,
    strip = (x0: number, x1: number, y0: number, y1: number) => clip([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], polygon),
    flange = clip([rear, front, along(front, n, t), along(rear, n, t)], polygon), cradle = strip(-half, half, under, base);
  if (reach < half * 1.2 || !(room > gauge * 2)) {
    // A wedge: the plates of a fabricated block, its web down its middle and its lit edge to the rear.
    shape(polygon, PAINT.steel);
    shape(strip(-half, -half * .8, low, under), PAINT.lit, false);
    shape(strip(half * .8, half, low, under), PAINT.shade, false);
    shape(strip(-gauge * .15, gauge * .15, low, under), PAINT.shade, false);
  } else {
    for (const side of [-1, 1]) {
      // Gussets from the flange and from the cradle to the mast, as far as they fit.
      const edge = side * half * .9, at = side * mast, rise = Math.min(reach * .35, half * 1.4, room * .4), drop = Math.min(reach * .25, half * 1.1, room * .3);
      shape(clip([{ x: edge, y: seatOn(edge) }, { x: at, y: seatOn(at) }, { x: at, y: seatOn(at) + rise }], polygon), side < 0 ? PAINT.lit : PAINT.shade);
      shape(clip([{ x: edge, y: under }, { x: at, y: under }, { x: at, y: under - drop }], polygon), side < 0 ? PAINT.lit : PAINT.shade);
    }
    shape([{ x: -mast, y: seatOn(-mast) }, { x: mast, y: seatOn(mast) }, { x: mast, y: under }, { x: -mast, y: under }], PAINT.steel);
    shape([{ x: -mast, y: seatOn(-mast) }, { x: -mast * .45, y: seatOn(-mast * .45) }, { x: -mast * .45, y: under }, { x: -mast, y: under }], PAINT.lit, false);
    shape([{ x: mast * .5, y: seatOn(mast * .5) }, { x: mast, y: seatOn(mast) }, { x: mast, y: under }, { x: mast * .5, y: under }], PAINT.shade, false);
  }
  shape(flange, PAINT.flange);
  shape(cradle, PAINT.flange);
  const bolt = Math.min(gauge, half * .2);
  if (t > gauge * .5) for (const side of [-1, 1]) nut(along({ x: side * half * .72, y: face(side * half * .72) }, n, t), n, bolt);
}

// A bracket from metal beside a sensor to its casing, inside its box: a flange on the face, an arm to the casing and a
// gusset under the arm, the flange bolted to the face.
function drawBracket(seat: Extract<SensorSeat, { mode: 'bracket' }>, shape: Shape, nut: Nut) {
  const { width, height, foot: [a, b], normal } = seat, tangent = { x: -normal.y, y: normal.x }, box = [
      { x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 }, { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }],
    point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, size = Math.min(width, height), gauge = Math.min(.012, size * .07),
    half = Math.min(.065, size * .22, Math.max(Math.hypot(b.x - a.x, b.y - a.y) / 2, gauge * 1.5)),
    body = bodyBounds(seat), inset = Math.min(gauge, (body.maxX - body.minX) / 4, (body.maxY - body.minY) / 4),
    end = { x: clamp(point.x, body.minX + inset, body.maxX - inset), y: clamp(point.y, body.minY + inset, body.maxY - inset) },
    start = along(point, normal, gauge * .6), distance = Math.hypot(end.x - start.x, end.y - start.y),
    across = distance > MATERIAL_CONTACT_EPS ? { x: -(end.y - start.y) / distance, y: (end.x - start.x) / distance } : tangent,
    boxed = (points: readonly Point[], color: number) => shape(clip(points, box), color);
  boxed([along(start, tangent, -half * .55), along(start, tangent, half * .55), end], PAINT.lit);
  boxed([along(start, across, -gauge), along(start, across, gauge), along(end, across, gauge * .65), along(end, across, -gauge * .65)], PAINT.steel);
  boxed([along(point, tangent, -half), along(point, tangent, half), along(along(point, tangent, half), normal, gauge), along(along(point, tangent, -half), normal, gauge)], PAINT.flange);
  for (const side of [-1, 1]) {
    const at = along(along(point, normal, gauge), tangent, half * side * .7);
    if (clip([at, along(at, tangent, gauge * .1), along(at, normal, gauge * .1)], box).length === 3) nut(at, normal, Math.min(gauge * .8, half * .3));
  }
}
