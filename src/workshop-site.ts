import { plateCorners } from './math.ts';
import { componentFootprintPolygons } from './assembly.ts';
import { coldConstructionPlacement, constructionSpan } from './construction-placement.ts';
import { FRAME_HEIGHT } from './frame-editing.ts';
import type { Graphics } from 'pixi.js';
import type { Point } from './math.ts';
import type { CompiledConstruction } from './construction-contract.ts';
import type { DrawingModule, DrawingPlate } from './scene-drawing-contract.ts';

export interface WorkshopGround { height(x: number): number; id?: string | undefined }
export interface WorkshopBase { x: number; radius: number; y?: number | null | undefined }
export interface BoardSite extends Point { mirror: boolean }
export interface WorkshopState {
  plates?: readonly Pick<DrawingPlate, 'actorId' | 'definition'>[] | null | undefined;
  modules?: readonly DrawingModule[] | null | undefined;
}

// On the shared field the workshop is a place of the base: the drawing board stands there, on the
// ground, with the field going on about it. The board keeps its own frame, the one a design is made
// in on a bench of its own: its floor at zero and the middle a construction is placed by at 12.
// The site is where the origin of that frame stands in the field. Nothing of the design is ever
// stated in places of the field: whoever draws it stands its layers at the site, and whoever points
// at it takes the site away from the place pointed at.
//
// What the field takes of a construction, in the frame of the board (`validateDesign`, server/room.ts).
// Its floor is the floor of the construction box, and it is as tall as the box (`FRAME_REACH`, frame-editing.ts).
export const BOARD = Object.freeze({ minX: 5, maxX: 19, minY: 0, maxY: FRAME_HEIGHT, middle: 12 });
// A construction comes into the field at the first free place of a row about the middle of its base,
// this far from one place to the next and this clear of whatever stands there (`placement`, server/room.ts).
// The page is told the base and not the row, so the row is told again here.
const ROW_SPACING = 12, CLEARANCE = .8;

// The stretch of ground each construction of a frame stands over.
function stretches(state: WorkshopState): { min: number; max: number }[] {
  const taken = new Map<string | undefined, { min: number; max: number }>(), reach = (id: string | undefined, x: number): void => {
    const stretch = taken.get(id);
    if (!stretch) taken.set(id, { min: x, max: x }); else { stretch.min = Math.min(stretch.min, x); stretch.max = Math.max(stretch.max, x); }
  };
  for (const plate of state.plates || []) for (const corner of plateCorners(plate.definition)) reach(plate.actorId, corner.x);
  for (const module of state.modules || []) for (const polygon of componentFootprintPolygons(module)) for (const corner of polygon) reach(module.actorId, corner.x);
  return [...taken.values()];
}

// The workshop shows every design with its front to the right, however it is to face on the field (chosen when it is
// made, `#deploy-facing`, and turned there with Virar): as a construction that faces right stands, its design (written
// with the front at its first point, on the left) turned about its middle (`mirror`).
export const BOARD_FACING = 1;
// Where the board stands in the field: at the place its design would come into it facing right, the first place of
// the row that the frame last shown has free, with the stretch of the row it has then. Its height is `boardHeight`'s;
// until the page has the ground, the height told of the base supplies a level surface.
export function boardSite(base: WorkshopBase, blueprint: CompiledConstruction,
  { ground = null, state = null }: { ground?: WorkshopGround | null | undefined; state?: WorkshopState | null | undefined } = {}): BoardSite {
  const { minX: low, maxX: high } = constructionSpan(blueprint, { x: 0, facing: BOARD_FACING }), taken = state ? stretches(state) : [],
    free = (place: number): boolean => taken.every(stretch => place + high + CLEARANCE < stretch.min || place + low - CLEARANCE > stretch.max),
    row = Array.from({ length: 2 * Math.floor(base.radius / ROW_SPACING) + 1 }, (_, i) => base.x + (i % 2 ? -1 : 1) * Math.ceil(i / 2) * ROW_SPACING),
    place = row.find(free) ?? base.x;
  return { x: place - BOARD.middle, y: boardHeight(blueprint, place, ground || { height: () => base.y ?? 0 }), mirror: true };
}
// How high the board stands over `place`: a vehicle's is level, at the highest ground under it; a fixed
// construction rests on the actual ground, with the same rigid placement as admission.
export function boardHeight(blueprint: CompiledConstruction, place: number, ground: WorkshopGround): number {
  if (blueprint.preset === 'bunker') return coldConstructionPlacement(blueprint, ground, { x: place, facing: BOARD_FACING }).lift;
  let y = -Infinity;
  for (let u = BOARD.minX; u <= BOARD.maxX; u += .25) y = Math.max(y, ground.height(place + u - BOARD.middle));
  return y;
}
// The place of the field a place of the board stands over: turned about its middle, for a design that will face right.
export const fieldX = (site: { x: number; mirror?: boolean | null | undefined }, u: number): number => site.mirror ? site.x + 2 * BOARD.middle - u : site.x + u;

// The floor the board is given in the field: a level deck from one end of the board to the other, its
// top where the design stands and its body down to the ground, which a slope leaves lower at one end.
// It is drawn in the frame of the board, into a drawing its owner has emptied and stood at its anchor.
export function drawBoardFloor(g: Graphics, site: BoardSite, ground: WorkshopGround): void {
  const from = BOARD.minX - .6, to = BOARD.maxX + .6, sunk = .14, foot: number[] = [],
    under = (u: number): number => Math.min(0, ground.height(fieldX(site, u)) - site.y) - sunk;
  for (let u = to; u > from; u -= .5) foot.push(u, under(u));
  foot.push(from, under(from));
  g.poly([from, 0, to, 0, ...foot]).fill({ color: 0xa5a28c, alpha: .94 });
  g.rect(from, -.045, to - from, .045).fill({ color: 0xc4c2aa, alpha: .85 });
  for (let u = Math.ceil(from / 2) * 2; u < to; u += 2) g.moveTo(u, -.045).lineTo(u, under(u));
  g.stroke({ color: 0x4f5a4f, width: .02, alpha: .3 });
}
