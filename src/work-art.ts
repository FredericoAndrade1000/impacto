import { plateCorners, clamp } from './math.ts';
import { componentFootprintPolygons } from './assembly.ts';
import { constructionPlacement } from './construction-placement.ts';
import { fixedFooting, footingShape } from './fixed-footing.ts';
import type { Point } from './math.ts';
import type { HeightTerrain } from './running-gear.ts';
import type { CompiledConstruction } from './construction-contract.ts';
import type { Graphics } from 'pixi.js';

export interface WorkShape {
  faces: Point[][]; parts: Point[][]; minX: number; maxX: number; minY: number; maxY: number;
}

// A works of the shared field (server/field-construction.ts) is drawn where the structure it becomes will stand, standing
// as the field will stand it (physics.ts: a fixed construction on the ground of the field, a little clear of it and let
// down into a hollow): the faces of its hull, its plates and its pieces pale and outlined, and as much of it as is put up
// (`progress`, from its foot up) filled in, under a line at the height it has come to. A side elevation, square on, as
// every drawing of the field.
const GHOST = 0xdfe8cc, OUTLINE = 0xe7efd6, BUILT_FACE = 0xa7ad95, BUILT_PART = 0x8b927f, LEVEL = 0xf2e3a0;

// The shape of a works in the world: the faces of its hull and its parts (`faces`, `parts`), each a polygon of points of
// the world, and the box they stand in. `blueprint` is the compiled structure. The footing it will stand on over a slope
// (fixed-footing.ts), which it pays for, is among its faces: it is put up first, from the ground.
export function workShape(blueprint: CompiledConstruction, ground: HeightTerrain, x: number, facing: number): WorkShape {
  const { point } = constructionPlacement(blueprint, ground, { x, facing, clearance: .04, allowDownward: true }), laid = (poly: readonly Point[]): Point[] => poly.map(point),
    parts = [...blueprint.plates.map(plate => laid(plateCorners(plate))), ...blueprint.modules.flatMap(componentFootprintPolygons).map(laid)],
    faces = [...fixedFooting(parts, ground).map(footingShape), ...blueprint.plates.length >= 3 ? blueprint.bodyPanels.map(face => laid(face.poly)) : []],
    points = [...faces, ...parts].flat(), xs = points.map(p => p.x), ys = points.map(p => p.y);
  return points.length ? { faces, parts, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    : { faces, parts, minX: x - .5, maxX: x + .5, minY: ground.height(x), maxY: ground.height(x) + 1 };
}

// What of a polygon lies at or under a height: the polygon cut along it.
export function under(poly: readonly Point[], level: number): Point[] {
  const kept: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (!a || !b) throw new TypeError('Work outline has a missing corner.');
    const inA = a.y <= level, inB = b.y <= level;
    if (inA) kept.push(a);
    if (inA !== inB) { const t = (level - a.y) / (b.y - a.y); kept.push({ x: a.x + (b.x - a.x) * t, y: level }); }
  }
  return kept;
}

// A works into a drawing its owner has emptied and stood at its anchor, its lines `pixel` metres wide (a pixel of the view).
export function drawWork(g: Graphics, shape: WorkShape, progress: number, pixel: number): void {
  const flat = (poly: readonly Point[]): number[] => poly.flatMap(p => [p.x, p.y]), share = clamp(progress, 0, 1), level = shape.minY + (shape.maxY - shape.minY) * share;
  for (const face of shape.faces) g.poly(flat(face)).fill({ color: GHOST, alpha: .14 });
  if (share > 0) {
    const layers: readonly (readonly [readonly Point[][], number, number])[] = [[shape.faces, BUILT_FACE, .78], [shape.parts, BUILT_PART, .88]];
    for (const [polys, color, alpha] of layers) for (const poly of polys) {
      const built = under(poly, level);
      if (built.length >= 3) g.poly(flat(built)).fill({ color, alpha });
    }
  }
  for (const face of shape.faces) g.poly(flat(face)).stroke({ color: OUTLINE, width: pixel, alpha: .45 });
  for (const part of shape.parts) g.poly(flat(part)).stroke({ color: OUTLINE, width: 1.3 * pixel, alpha: .8 });
  if (share > 0 && share < 1) g.moveTo(shape.minX - .25, level).lineTo(shape.maxX + .25, level).stroke({ color: LEVEL, width: 1.6 * pixel, alpha: .85 });
}
