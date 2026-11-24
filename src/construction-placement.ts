import { plateCorners } from './math.ts';
import { componentFootprintPolygons } from './assembly.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';
import { BATTLE_TERRAIN_IDS } from './terrain.ts';
import type { PlateGeometry, Point } from './math.ts';
import type { ComponentGeometry } from './assembly.ts';

export interface PlacementConstruction { plates: readonly PlateGeometry[]; modules: readonly ComponentGeometry[]; preset?: 'vehicle' | 'bunker' | undefined }
export interface PlacementGround { id?: string | undefined; height(x: number): number }
export interface PlacementOptions { x?: number; facing?: number; angle?: number; clearance?: number; allowDownward?: boolean; lift?: number | null }

// The same physical outline gates knowledge, reserves ground and positions the
// preview. Rotated equipment must not reach beyond a span measured by width alone.
export function constructionSpan(blueprint: PlacementConstruction, { x = 12, facing = -1 }: Pick<PlacementOptions, 'x' | 'facing'> = {}) {
  const xs = [...blueprint.plates.flatMap(plateCorners), ...blueprint.modules.flatMap(componentFootprintPolygons).flat()]
    .map(point => x - facing * (point.x - 12));
  return { minX: xs.length ? Math.min(...xs) : x, maxX: xs.length ? Math.max(...xs) : x };
}

// Cold placement only: follow the actual outline, including mounts and running
// gear, without changing the design or a body's pose during the simulation.
// One laid in the air is raised by `lift` as given, whatever ground is under it.
export function constructionPlacement(blueprint: PlacementConstruction, ground: PlacementGround,
  { x = 12, facing = -1, angle = 0, clearance = .02, allowDownward = false, lift: aloft = null }: PlacementOptions = {}) {
  const mirror = -facing, c = Math.cos(angle), s = Math.sin(angle),
    laid = (p: Point) => {
      const dx = mirror * (p.x - 12), dy = p.y - VEHICLE_ORIGIN.y;
      return { x: x + c * dx - s * dy, y: VEHICLE_ORIGIN.y + s * dx + c * dy };
    },
    footprint = () => [...blueprint.plates.map(plateCorners), ...blueprint.modules.flatMap(componentFootprintPolygons)].flatMap(poly =>
      poly.flatMap((a, i) => {
        const b = poly[(i + 1) % poly.length];
        if (!b) throw new RangeError('O contorno da construção não contém o próximo ponto.');
        const count = Math.max(1, Math.ceil(Math.abs(b.x - a.x) / .25));
        return Array.from({ length: count }, (_, k) => ({ x: a.x + (b.x - a.x) * k / count, y: a.y + (b.y - a.y) * k / count }));
      })),
    lift = aloft ?? Math.max(allowDownward ? -Infinity : 0,
      ...footprint().map(laid).map(p => ground.height(p.x) - p.y + clearance));
  return { mirror, lift, point: (p: Point) => { const at = laid(p); return { x: at.x, y: at.y + lift }; } };
}

// The pose and real contact skin used on cold admission. This chooses no support
// roots and never changes a moving actor. Site review and admission use it alike.
export function coldConstructionPlacement(blueprint: PlacementConstruction, ground: PlacementGround,
  { x = 12, facing = -1, angle = 0, settle = false, lift = null }: Pick<PlacementOptions, 'x' | 'facing' | 'angle' | 'lift'> & { settle?: boolean } = {}) {
  const scenic = BATTLE_TERRAIN_IDS.some(id => id === ground.id), clearance = scenic ? .04 : .02,
    placed = constructionPlacement(blueprint, ground, { x, facing, angle, lift,
      clearance, allowDownward: scenic || settle && blueprint.preset !== 'vehicle' });
  return { ...placed, pose: { x, y: VEHICLE_ORIGIN.y + placed.lift, angle }, facing, clearance };
}
