import type { Point } from './math.ts';

// Authoring coordinates use units of 5 cm (game_construction.rs CELL). Plate
// endpoints may use fractional units; the grid is an optional drawing aid.
// Nodes, chassis, running gear and equipment accept fractional units; snapping is optional.
export const CELL = .05;
const PER_METRE = 1 / CELL;
// So many cells in metres: the nearest double to the decimal they make, as the compiler reads them.
export const metresOf = (cells: number): number => cells / PER_METRE;
// Metres in authoring units, without imposing a grid on the geometry.
export function unitsOf(metres: number): number {
  const units = metres * PER_METRE, whole = Math.round(units);
  // Subtracting the compiled world origin may leave a few ulps around an
  // existing integral coordinate. This does not snap a free point to the grid.
  return Math.abs(units - whole) < 1e-9 ? whole : units;
}
// The cell nearest to so many metres; halfway, the one further from zero, as the compiler rounds.
export function cellOf(metres: number): number {
  const cells = metres / CELL;
  return Math.sign(cells) * Math.round(Math.abs(cells)) || 0;
}
// A point in cells, in metres; and the cell nearest to a point in metres.
export const pointMetres = ({ x, y }: Point): Point => ({ x: metresOf(x), y: metresOf(y) });
export const pointCells = ({ x, y }: Point): Point => ({ x: cellOf(x), y: cellOf(y) });
// Whether a value is a position the grid writes.
export const isCell = (value: unknown): value is number => Number.isInteger(value);
// Of the cells around `point` (in cells, not necessarily whole), the nearest that stands no nearer than it to what lies
// against any of `ways`, the way out of each face it is against: a plate laid on a face stands on the first cell clear of
// it, never sunk into what is under it, and at a bend clear of both faces. Where none of the cells about it is, the next
// ring of cells is looked at.
export function cellClear(point: Point, ways: readonly Point[]): Point {
  for (let ring = 1; ring <= 4; ring++) {
    let best: (Point & { distance: number }) | null = null;
    for (let x = Math.ceil(point.x) - ring; x <= Math.floor(point.x) + ring; x++) for (let y = Math.ceil(point.y) - ring; y <= Math.floor(point.y) + ring; y++) {
      if (ways.some(way => (x - point.x) * way.x + (y - point.y) * way.y < -1e-9)) continue;
      const distance = Math.hypot(x - point.x, y - point.y);
      if (!best || distance < best.distance - 1e-12) best = { x: x || 0, y: y || 0, distance };
    }
    if (best) return { x: best.x, y: best.y };
  }
  return { x: Math.round(point.x) || 0, y: Math.round(point.y) || 0 };
}
