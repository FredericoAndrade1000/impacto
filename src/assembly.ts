import { plateCorners, pointInTriangle, rectangle } from './math.ts';
import { weaponBarrelPolygon, mountedWeaponPolygons, fixedWeaponMaterial } from './weapon-geometry.ts';
import { trackOutline } from './running-gear.ts';
import type { Point, PlateGeometry } from './math.ts';
import type { ModuleKind, MaterialId } from './materials.ts';
import type { WeaponGeometry } from './weapon-geometry.ts';

export interface ComponentGeometry extends WeaponGeometry {
  kind: ModuleKind;
  width: number; height: number;
  mirrored?: boolean | undefined; attached?: boolean | undefined;
  material?: never;
}
export type PieceGeometry = (PlateGeometry & { material: MaterialId }) | ComponentGeometry;

export const isRunningGear = (piece: Pick<ComponentGeometry, 'kind'>): boolean => piece.kind === 'wheel' || piece.kind === 'track';
export function componentPolygon(m: ComponentGeometry): Point[] {
  if (m.kind === 'weapon' && m.weaponMount) return mountedWeaponPolygons(m)![0]!;
  if (!isRunningGear(m)) return rectangle(m.x, m.y, m.width, m.height, m.angle || 0);
  const radius = m.height / 2, c = Math.cos(m.angle || 0), s = Math.sin(m.angle || 0),
    points = m.kind === 'wheel' ? Array.from({ length: 48 }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 24;
      return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
    }) : trackOutline(m.width, m.height);
  const sign = m.mirrored ? -1 : 1;
  return points.map((p: Point) => ({ x: m.x + sign * p.x * c - p.y * s, y: m.y + sign * p.x * s + p.y * c }));
}
export const polygonTriangles = <P extends Point>(poly: readonly P[]): [P, P, P][] => poly.slice(1, -1).map((p, i) => [poly[0]!, p, poly[i + 2]!]);
// The receiver stays on its host; the barrel and mantlet follow servo elevation.
export const componentPolygons = (m: ComponentGeometry): Point[][] => m.kind === 'weapon'
  ? mountedWeaponPolygons(m) || [componentPolygon(m), weaponBarrelPolygon(m)]
  : [componentPolygon(m)];
export const piecePolygon = (p: PieceGeometry): Point[] => p.material ? plateCorners(p) : componentPolygon(p);
// Preserve the receiver/post footprint and add real fixed feet, leaving their gap empty.
export function componentFootprintPolygons(module: ComponentGeometry): Point[][] {
  if (module.kind !== 'weapon' || !module.weaponMount) return [componentPolygon(module)];
  return mountedWeaponPolygons(module)!.filter((_, index) => index === 0 || fixedWeaponMaterial(module.weaponMount!.exposed, index));
}
export function containsPoint(piece: PieceGeometry, point: Point): boolean {
  return (piece.material ? [plateCorners(piece)] : componentFootprintPolygons(piece))
    .some(poly => polygonTriangles(poly).some(t => pointInTriangle(point, ...t)));
}

export function foregroundGearAt<M extends ComponentGeometry>(modules: readonly M[], point: Point): M | null {
  for (let i = modules.length - 1; i >= 0; i--) {
    const module = modules[i]!;
    if (!isRunningGear(module)) continue;
    const c = Math.cos(module.angle || 0), s = Math.sin(module.angle || 0),
      dx = point.x - module.x, dy = point.y - module.y,
      local = { u: c * dx + s * dy, v: -s * dx + c * dy }, radius = module.height / 2;
    if ((module.kind === 'track' || local.u * local.u + local.v * local.v <= radius * radius) && containsPoint(module, point)) return module;
  }
  return null;
}
