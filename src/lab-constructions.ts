import { DESIGN_VERSION } from './persistence.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';
import { cellOf } from './grid.ts';
import type { AuthoredComponent, AuthoredConstruction, AuthoredPlate, ConstructionNode } from './construction-contract.ts';
import type { MaterialId } from './materials.ts';
import type { Point } from './math.ts';
import type { TerrainId } from './terrain.ts';

export interface LabConstructionOptions {
  name?: string; length?: number; height?: number; material?: MaterialId; thicknessMm?: number; otherThicknessMm?: number;
  rideHeight?: number; components?: readonly AuthoredComponent[]; seed?: number; terrain?: TerrainId; launcher?: Point;
}

// A closed outline as a frame: its corners in order, counter-clockwise from
// the lower front one, in metres, each written on the cell nearest to it (grid.ts), and a plate from each to the next
// named for its side.
export function closedFrame<Side extends string, Armour extends Pick<AuthoredPlate, 'material' | 'thicknessMm'>>(
  points: readonly (readonly [number, number])[], sides: readonly Side[], armour: (side: Side, index: number) => Armour,
): { nodes: ConstructionNode[]; plates: (Armour & { id: string; a: string; b: string })[] } {
  return { nodes: points.map(([x, y], i) => ({ id: 'hull-' + i, x: cellOf(x), y: cellOf(y) })),
    plates: sides.map((side, i) => ({ id: 'hull:' + side, a: 'hull-' + i, b: 'hull-' + (i + 1) % sides.length, ...armour(side, i) })) };
}
// A lab fixture is authored directly as a closed construction that stands where it is, laid out in metres and written
// on the cells nearest, its components where their poses fall. This helper neither reshapes geometry nor derives
// admitted rooms/components in JS.
export function labConstruction({ name = 'Ensaio de material', length = 3, height = 2.4,
  material = 'steel', thicknessMm = 100, otherThicknessMm = 5,
  rideHeight = .15, components = [], seed = 6173, terrain = 'flat',
  launcher = { x: 7, y: 1.7 } }: LabConstructionOptions = {}): AuthoredConstruction {
  const floor = rideHeight - VEHICLE_ORIGIN.y;
  return { version: DESIGN_VERSION, preset: 'bunker', name, seed, terrain, launcher,
    ...closedFrame([[-length / 2, floor], [length / 2, floor], [length / 2, floor + height], [-length / 2, floor + height]], ['floor', 'rear', 'roof', 'front'],
      side => side === 'front' ? { material, thicknessMm } : { material: 'steel', thicknessMm: otherThicknessMm }),
    components: structuredClone(components).map(part => part.pose
      ? { ...part, pose: { ...part.pose, x: cellOf(part.pose.x), y: cellOf(part.pose.y) } } : part) };
}
