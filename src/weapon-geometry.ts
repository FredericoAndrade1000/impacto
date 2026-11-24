import { WEAPON_PRESETS, weaponSettings, weaponOf } from './weapons.ts';
import { rectangle } from './math.ts';
import type { Point, Pose } from './math.ts';
import type { WeaponId } from './weapons.ts';

export interface WeaponMountGeometry { exposed?: boolean | undefined }
export interface WeaponGeometry extends Pose {
  weaponPreset?: WeaponId | undefined;
  barrelAngle?: number | undefined;
  weaponMount?: WeaponMountGeometry | null | undefined;
  materialPolygons?: readonly (readonly Point[])[] | undefined;
}
export interface RaycastPort<Hit> {
  raycast(start: Point, end: Point, options: { ignoreIds: ReadonlySet<string | undefined>; projectile: true }): Hit | null;
}
export interface MuzzleTerrain<Hit> { raycast(start: Point, end: Point): Hit | null; height(x: number): number }

// The barrel's catalogue dimensions, shared by the instrument and the artwork.
// Decoration is kept separate; bolt heads never become collision objects.
export function weaponBarrelProfile(module: Pick<WeaponGeometry, 'weaponPreset'>): { start: number; end: number; radius: number } {
  const preset = module.weaponPreset || 'rh120', model = weaponOf(preset) || WEAPON_PRESETS.rh120;
  return { start: .10, end: weaponSettings(model.family, { preset }).barrel, radius: model.barrelRadius };
}
export const weaponAngle = (module: { barrelAngle?: number | undefined; angle?: number | undefined }): number => module.barrelAngle ?? Math.PI + (module.angle || 0);
// Native role order; the projectile projection omits only the tube at index1.
export function weaponMaterialRole(exposed: boolean | undefined, index: number, projectile = false): 'post' | 'receiver' | 'tube' | 'carried' | 'base' | 'shield' {
  if (projectile && index > 0) index++;
  return index === 0 ? exposed ? 'post' : 'receiver' : index === 1 ? 'tube'
    : exposed ? 'carried' : index < 4 ? 'base' : 'shield';
}
export function fixedWeaponMaterial(exposed: boolean | undefined, index: number): boolean {
  const role = weaponMaterialRole(exposed, index); return role === 'post' || role === 'base';
}
// The receiver of an enclosed gun turns with its tube and mantlet as the servo lays them; only the post an exposed
// mount carries its gun on stands still, on the host axis (game_geometry.rs `material_pose`). Local material polygons
// retain their native role order.
export function mountedWeaponPolygons(module: WeaponGeometry & { weaponMount: WeaponMountGeometry }): Point[][];
export function mountedWeaponPolygons(module: WeaponGeometry): Point[][] | null;
export function mountedWeaponPolygons(module: WeaponGeometry): Point[][] | null {
  if (!module.weaponMount) return null;
  if (!Array.isArray(module.materialPolygons) || module.materialPolygons.length < 2)
    throw new Error('A arma não pôde ser desenhada.');
  const fixed = module.angle, moving = weaponAngle(module), post = module.weaponMount.exposed,
    fixedCos = Math.cos(fixed), fixedSin = Math.sin(fixed), movingCos = Math.cos(moving), movingSin = Math.sin(moving);
  return module.materialPolygons.map((poly: readonly Point[], index: number) => {
    const still = fixedWeaponMaterial(post, index), c = still ? fixedCos : movingCos, s = still ? fixedSin : movingSin;
    return poly.map(p => ({ x: module.x + c * p.x - s * p.y, y: module.y + s * p.x + c * p.y }));
  });
}
export function weaponBarrelPolygon(module: WeaponGeometry): Point[] {
  if (module.weaponMount) return mountedWeaponPolygons(module)![1]!;
  const { start, end, radius } = weaponBarrelProfile(module), angle = weaponAngle(module), mid = (start + end) / 2;
  return rectangle(module.x + Math.cos(angle) * mid, module.y + Math.sin(angle) * mid, end - start, radius * 2, angle);
}

export function muzzleObstruction<Hit extends object, GroundHit extends object>(index: RaycastPort<Hit>, terrain: MuzzleTerrain<GroundHit>, launcher: { id?: string }, solution: Pose, radius = .01):
  (Hit & { reason: string }) | ((GroundHit | Point) & { owner: { type: 'ground'; id: 'ground' }; reason: string }) | null {
  const dir = { x: Math.cos(solution.angle), y: Math.sin(solution.angle) },
    tip = { x: solution.x, y: solution.y }, pad = Math.max(.006, radius * 1.1),
    ignoreIds = new Set([launcher.id]);
  // Check the mouth and a short clearance, including the projectile's radius.
  // The gun's own bore is the only excluded object. Armour is never excluded.
  for (const offset of [0, -radius, radius]) {
    const start = { x: tip.x - dir.x * pad - dir.y * offset, y: tip.y - dir.y * pad + dir.x * offset },
      end = { x: tip.x + dir.x * pad - dir.y * offset, y: tip.y + dir.y * pad + dir.x * offset };
    const hit = index.raycast(start, end, { ignoreIds, projectile: true });
    if (hit) return { ...hit, reason: 'Cano obstruído por outra peça' };
    const ground = terrain.raycast(start, end);
    if (ground || start.y <= terrain.height(start.x) || end.y <= terrain.height(end.x))
      return { ...(ground || tip), owner: { type: 'ground', id: 'ground' }, reason: 'Cano encostado no terreno' };
  }
  return null;
}
