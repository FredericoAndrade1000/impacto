import { pointInTriangle, closestSegment, clamp, angleDifference } from './math.ts';
import { mountedWeaponPolygons, weaponAngle } from './weapon-geometry.ts';
import { WEAPON_PRESETS, STROKE_STEP, recoilSteps, weaponOf } from './weapons.ts';
import { weaponLayout } from './weapon-paint.ts';
import { TUBE_FITTINGS, tubeFittings } from './weapon-fittings.ts';
import type { Graphics } from 'pixi.js';
import type { Point, Pose } from './math.ts';
import type { WeaponGeometry } from './weapon-geometry.ts';
import type { WeaponMountProjection } from './construction-contract.ts';
import type { WeaponId } from './weapons.ts';
export type WeaponArtSource = (Point & { angle?: number | undefined; barrelAngle?: number | undefined; weaponPreset?: WeaponId | undefined;
  weaponMount?: null | undefined; materialPolygons?: readonly (readonly Point[])[] | undefined })
  | WeaponGeometry & { weaponMount: WeaponMountProjection };
type RecoilStep = ReturnType<typeof recoilSteps>[number];
interface RecoilReserve { preset: WeaponId | undefined; min: number; max: number; axis: number; recoil: number;
  steps: readonly RecoilStep[]; drawn: readonly RecoilStep[]; sweep: Point[] | null | undefined }
export interface WeaponRecoilGuide extends Pose { axis: number; minX: number; maxX: number; minY: number; maxY: number; stroke: number; sweep?: Point[] | null }
export interface WeaponShape { type: 'poly'; materialIndex?: number; points: number[]; color: string; alpha: number }


// The space behind the real mechanism, as long as the gun recoils with its bore
// where it is laid: a howitzer raised high recoils less, and its breech is
// reserved less room there (weapons.ts `recoilSteps`). It is a workshop guide,
// never another material or hitbox.
const recoilReserves = new WeakMap<readonly (readonly Point[])[], RecoilReserve>();
// The steps of its sector a mounted gun's breech is reserved over, kept with the
// contour they sweep until its geometry, sector, axis or stroke is edited.
function recoilReserve(weapon: WeaponArtSource, mount: WeaponMountProjection, polygons: readonly (readonly Point[])[]) {
  const preset = weapon.weaponPreset;
  let cached = recoilReserves.get(polygons);
  if (!cached || cached.preset !== preset || cached.min !== mount.min || cached.max !== mount.max ||
    cached.axis !== mount.hullAxis || cached.recoil !== mount.recoil) {
    const steps = preset && weaponOf(preset) ? recoilSteps(preset, mount.hullAxis, mount.min, mount.max)
      : [{ min: mount.min, max: mount.max, stroke: mount.recoil }],
      // Drawn, the stroke changes smoothly, by tenths of a degree, as long about each angle as the core holds it
      // within a step of that: the sweep shows no teeth of its steps, and is no shorter than they are.
      width = (mount.max - mount.min) / Math.max(1, Math.ceil((mount.max - mount.min) / STROKE_STEP)),
      drawn = steps.length > 1 ? recoilSteps(preset, mount.hullAxis, mount.min, mount.max, { step: STROKE_STEP / 10, margin: width }) : steps;
    cached = { preset, min: mount.min, max: mount.max, axis: mount.hullAxis, recoil: mount.recoil, steps, drawn, sweep: undefined };
    recoilReserves.set(polygons, cached);
  }
  return cached;
}
// How far a mounted gun recoils with its bore laid at `angle`: the longest step of
// its sector that holds that angle (game_construction.rs `breech_at`), off the
// sector its nearest end's.
export function weaponRecoilStroke(weapon: WeaponArtSource, angle = weaponAngle(weapon)) {
  const mount = weapon.weaponMount, polygons = weapon.materialPolygons;
  if (!mount || !(mount.recoil > 0) || !Array.isArray(polygons)) return 0;
  const { steps } = recoilReserve(weapon, mount, polygons);
  if (steps.length === 1) return steps[0]!.stroke;
  const at = clamp(angleDifference(angle, weapon.angle || 0), steps[0]!.min, steps.at(-1)!.max);
  let stroke = 0;
  for (const step of steps) if (step.min <= at && at <= step.max) stroke = Math.max(stroke, step.stroke);
  return stroke;
}
export function weaponRecoilGuide(weapon: WeaponArtSource): WeaponRecoilGuide | null {
  const mount = weapon.weaponMount, polygons = weapon.materialPolygons;
  if (!mount || !(mount.recoil > 0) || !Array.isArray(polygons) || polygons.length < 2) return null;
  const receiver = mount.exposed ? polygons[2]! : polygons[0]!, angle = weaponAngle(weapon), stroke = weaponRecoilStroke(weapon, angle);
  let back = Infinity, bottom = Infinity, top = -Infinity;
  for (const p of receiver) { back = Math.min(back, p.x); bottom = Math.min(bottom, p.y); top = Math.max(top, p.y); }
  const guide: WeaponRecoilGuide = { x: weapon.x, y: weapon.y, angle, axis: weapon.angle || 0,
    minX: back - stroke, maxX: back, minY: bottom, maxY: top, stroke };
  if (Number.isFinite(mount.min) && Number.isFinite(mount.max) && mount.max > mount.min) {
    const reserve = recoilReserve(weapon, mount, polygons);
    if (reserve.sweep === undefined) reserve.sweep = recoilSweep(guide, reserve.drawn, reserve.steps);
    guide.sweep = reserve.sweep;
  }
  return guide;
}

// Sweep the reservation around the admitted axis, each step of the sector as far
// as the gun recoils there, retaining the empty space near the pivot; the edges
// of the steps of the core (`marks`) are sampled exactly. Only an edit to the
// immutable geometry, sector or stroke rebuilds this contour; aiming and drawing
// reuse it.
function recoilSweep(box: Pick<WeaponRecoilGuide, 'maxX' | 'maxY' | 'minY'>, steps: readonly RecoilStep[], marks = steps) {
  const a = -box.maxX, c = -box.maxY, d = -box.minY;
  if (!(a > 0)) return null;
  const shape = (step: RecoilStep) => {
      const b = a + step.stroke, corners = ([Math.atan2(c, a), Math.atan2(c, b), Math.atan2(d, a), Math.atan2(d, b)] as const);
      return { min: step.min, max: step.max, b, corners, far: ([corners[1]!, corners[3]!] as const), lo: Math.min(...corners), hi: Math.max(...corners) };
    },
    parts = steps.filter(step => step.stroke > 0).map(shape),
    edges = marks === steps ? parts : marks.filter(step => step.stroke > 0).map(shape);
  if (!parts.length) return null;
  const nearest = Math.atan2(clamp(0, c, d), a),
    start = Math.min(...parts.map(part => part.min + part.lo)), end = Math.max(...parts.map(part => part.max + part.hi)),
    count = Math.min(128, Math.max(1, Math.ceil((end - start) / (Math.PI / 64)))),
    angles = Array.from({ length: count + 1 }, (_, i) => start + (end - start) * i / count);
  // Exact changes of edge/corner keep the ends, the steps and narrow sectors readable.
  for (const part of edges) for (const limit of ([part.min, part.max] as const)) for (const angle of [...part.corners, nearest, 0]) {
    const value = limit + angle;
    if (value > start && value < end) angles.push(value);
  }
  angles.sort((a, b) => a - b);
  const inner = [], outer = [], pad = 1 / Math.cos((end - start) / count / 2),
    radii = (angle: number, b: number): [number, number] => {
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      let near = a / cosine, far = b / cosine;
      if (Math.abs(sine) > 1e-12) {
        const one = c / sine, two = d / sine;
        near = Math.max(near, Math.min(one, two)); far = Math.min(far, Math.max(one, two));
      }
      return ([near, far] as const);
    };
  for (const angle of angles) {
    let near = Infinity, reach = 0;
    for (const part of parts) {
      const from = Math.max(part.lo, angle - part.max), to = Math.min(part.hi, angle - part.min);
      // The ends of the sweep fall on its own limits but for rounding.
      if (from > to + 1e-9) continue;
      const first = radii(from, part.b), last = radii(to, part.b);
      near = Math.min(near, first[0]!, last[0]!); reach = Math.max(reach, first[1]!, last[1]!);
      if (nearest >= from && nearest <= to) near = Math.min(near, radii(nearest, part.b)[0]!);
      for (const corner of part.far) if (corner >= from && corner <= to) reach = Math.max(reach, radii(corner, part.b)[1]!);
    }
    if (near === Infinity) continue;
    const x = -Math.cos(angle), y = -Math.sin(angle);
    inner.push({ x: x * near, y: y * near });
    // Circumscribe the sampled arcs: the visual guide must not trim the
    // reservation between samples. At this resolution the pad is below 0.1%.
    outer.push({ x: x * reach * pad, y: y * reach * pad });
  }
  return [...outer, ...inner.reverse()];
}

export function drawWeaponRecoilGuide(g: Graphics, guide: WeaponRecoilGuide, pixel: number) {
  if (guide.sweep?.length) {
    const c = Math.cos(guide.axis), s = Math.sin(guide.axis);
    for (let i = 0; i < guide.sweep.length; i++) {
      const p = guide.sweep[i]!;
      const x = guide.x + c * p.x - s * p.y, y = guide.y + s * p.x + c * p.y;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath().fill({ color: 0xf2c985, alpha: .055 })
      .stroke({ color: 0xf2c985, width: pixel, alpha: .38, join: 'round' });
  }
  const { x, y, angle, minX, maxX, minY, maxY } = guide, c = Math.cos(angle), s = Math.sin(angle),
    xs = ([minX, maxX, maxX, minX] as const), ys = ([minY, minY, maxY, maxY] as const);
  g.moveTo(x + c * minX - s * minY, y + s * minX + c * minY);
  for (let i = 1; i < 4; i++) g.lineTo(x + c * xs[i]! - s * ys[i]!, y + s * xs[i]! + c * ys[i]!);
  g.closePath().fill({ color: 0xf2c985, alpha: .075 });
  for (let edge = 0; edge < 4; edge++) {
    const next = (edge + 1) % 4, dx = xs[next]! - xs[edge]!, dy = ys[next]! - ys[edge]!,
      steps = Math.max(1, Math.min(96, Math.ceil(Math.hypot(dx, dy) / (pixel * 8))));
    for (let i = 0; i < steps; i++) {
      const lo = i / steps, hi = (i + .55) / steps,
        ax = xs[edge]! + dx * lo, ay = ys[edge]! + dy * lo,
        bx = xs[edge]! + dx * hi, by = ys[edge]! + dy * hi;
      g.moveTo(x + c * ax - s * ay, y + s * ax + c * ay).lineTo(x + c * bx - s * by, y + s * bx + c * by);
    }
  }
  g.stroke({ color: 0xf2c985, width: pixel * 1.25, alpha: .8 });
}

// Picking follows the native receiver, barrel and mantlet projection.
export function weaponContains(weapon: WeaponArtSource, point: Point, tolerance = 0, angle = Math.PI) {
  if (weapon.weaponMount) return mountedWeaponPolygons(weapon).some(poly => {
    for (let i = 1; i < poly.length - 1; i++) if (pointInTriangle(point, poly[0]!, poly[i]!, poly[i + 1]!)) return true;
    return tolerance > 0 && poly.some((a, i) => {
      const q = closestSegment(point, a, poly[(i + 1) % poly.length]!);
      return Math.hypot(q.x - point.x, q.y - point.y) <= tolerance;
    });
  });
  const dx = point.x - weapon.x, dy = point.y - weapon.y,
    c = Math.cos(angle), s = Math.sin(angle), local = { x: dx * c + dy * s, y: -dx * s + dy * c };
  return installedWeaponShapes(weapon).some(shape => {
    const poly: Point[] = [];
    for (let i = 0; i < shape.points.length; i += 2) poly.push({ x: shape.points[i]!, y: shape.points[i + 1]! });
    for (let i = 1; i < poly.length - 1; i++) if (pointInTriangle(local, poly[0]!, poly[i]!, poly[i + 1]!)) return true;
    return tolerance > 0 && poly.some((a, i) => {
      const q = closestSegment(local, a, poly[(i + 1) % poly.length]!);
      return Math.hypot(q.x - local.x, q.y - local.y) <= tolerance;
    });
  });
}

// Mounted geometry is a read-only native projection, including the internal
// mechanism and the surviving curved shield facets. Catalogue artwork has no mechanical role.
export function installedWeaponShapes(weapon: WeaponArtSource): WeaponShape[] {
  if (!weapon.weaponMount) return weaponShapes(weapon.weaponPreset);
  if (!Array.isArray(weapon.materialPolygons) || weapon.materialPolygons.length < 2)
    throw new Error('A projeção da montagem nativa está incompleta.');
  const colors = ['#53655c', '#26352f'];
  return weapon.materialPolygons.map((poly: readonly Point[], index) => ({ type: 'poly', materialIndex: index,
    points: poly.flatMap(point => ([point.x, point.y] as const)), color: colors[index] || '#839080', alpha: 1 }));
}

// Metre-based outline of a weapon off any mount: what picks it and what draws it in the picture of a design
// (construction-preview.ts). It is the bench picture's own layout (weapon-paint.ts): the receiver behind the trunnion,
// the tube to the muzzle, and each fitting and the muzzle device where the picture stands them, so a click finds the gun
// wherever it is painted. Mounted weapons use the native polygons above; no outline feeds admission or the solver.
const shapeCache = new Map<WeaponId | undefined, WeaponShape[]>();
export function weaponShapes(presetId: WeaponId | undefined) {
  if (shapeCache.has(presetId)) return shapeCache.get(presetId)!;
  const L = weaponLayout(presetId), table = TUBE_FITTINGS[L.preset]!, k = L.r / table.radius, { muzzle, fittings } = tubeFittings(L.preset, L.b, 0);
  const rect = (x0: number, x1: number, y0: number, y1: number, color: string): WeaponShape => ({ type: 'poly', points: [x0, y0, x1, y0, x1, y1, x0, y1], color, alpha: 1 });
  // A fitting stands about its own axis, and as far above the bore as it reaches (below it, for a grip).
  const span = (f: { kind: string; d: number; y?: number; reach?: number }): [number, number] => {
    const y = (f.y || 0) * k, half = f.d * k / 2, reach = (f.reach || 0) * k;
    return f.kind === 'grip' ? ([-reach, y + half] as const) : ([y - half, f.reach ? reach : y + half] as const);
  };
  const shapes = [rect(L.receiver.x0, L.receiver.x1, L.receiver.y0, L.receiver.y1, '#3f4a45'), rect(L.tube.x0, L.tube.x1, L.tube.y0, L.tube.y1, '#47524c'),
    ...[...fittings, muzzle].map(f => rect(f.from, f.to, ...span(f), '#56635c'))];
  shapeCache.set(presetId, shapes); return shapes;
}
