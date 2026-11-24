import { NO_ROADS, paved } from './roads.ts';
import { RoughGround } from './terrain.ts';
import type { Terrain } from './terrain.ts';
import type { Point, Pose } from './math.ts';

export type RoadToolKind = keyof typeof TOOL_POINT;
export interface ToolPose extends Pose { mirrored?: boolean | undefined }
export interface RoadPlace {
  c: number; s: number; width: number; height: number; down: Point;
  along(dx: number, dy: number): Point; world(x: number, y: number): Point;
}
export interface SectionGround { height(x: number): number; section(a: number, b: number): Point[] }
export interface EdgePoint { u: number; y: number }

// Where along the ground a road machine's tool works: the same on the field (server/road-works.ts `at`), which makes the
// road behind it, and on the screen (road-machine-motion.ts `toolAt`), which shows the road coming out from under it. It is
// a point of the box of its piece, as a share of its width from its rear end and of its height from its top: the middle
// of the cutting edge of a blade, at the foot of its box, and the trailing edge of the screed of a paver, at its rear end
// (machine-art.ts lays their rigs on these). A tool goes down plumb from where it travels to meet the ground
// (road-machine-motion.ts), on the level as on a slope, and so meets it straight under that point: it works where that
// point stands along the ground, however its piece is tilted and however far below it the ground is.
export const TOOL_POINT = Object.freeze({ blade: Object.freeze({ x: .5, y: 1 }), paver: Object.freeze({ x: 0, y: .9 }) });
// How far along the ground that point stands from the middle of a piece of its kind, `width` by `height` and turned by
// `angle`, with the same local-X reflection as its geometry and painting.
export function toolOffset(kind: RoadToolKind, { width, height, angle, mirrored }: { width: number; height: number; angle: number; mirrored?: boolean | undefined }): number {
  const { x, y } = TOOL_POINT[kind];
  return (mirrored ? -1 : 1) * Math.cos(angle) * (x - .5) * width + Math.sin(angle) * (y - .5) * height;
}

// Where a place of a road machine's box is in the world, its box `W` by `H` (`width`, `height`) where `pose` lays it.
// Its places are counted as its rig has them (machine-art.ts): in metres from the upper rear corner of its box, its front
// at the right. The pose carries the same local-X reflection used by its geometry; camera direction does not change where
// a tool works. `along` turns a way in the world into the picture, and `down` is the way plumb down in it.
export function placeOf(pose: ToolPose, W: number, H: number): RoadPlace {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle), m = pose.mirrored ? -1 : 1;
  return { c, s, width: W, height: H, down: { x: -m * s, y: c }, along: (dx, dy) => ({ x: m * (c * dx + s * dy), y: s * dx - c * dy }),
    world: (X, Y) => { const u = m * (X - W / 2), v = H / 2 - Y; return { x: pose.x + c * u - s * v, y: pose.y + s * u + c * v }; } };
}
// The moldboard of a blade works turned aslant across the way, and the side of the vehicle shows its far end, the toe,
// smaller than its near one, the heel, by this (machine-art.ts `moldboard`), and as much further along the picture.
export const FAR = .8;
// The cutting edge of a blade `W` by `H` as it works, level across the way at the foot of its box (`TOOL_POINT`), from its
// heel to its toe, as places along its box from its rear end: its heel a little in from the rear, and its toe past the
// middle by as far again as the far half of the moldboard shows (`FAR`).
export function bladeEdge(W: number, H: number): [number, number] {
  const heel = .13 * H / .45;
  return [heel, heel + (W * TOOL_POINT.blade.x - heel) * (1 + FAR)];
}
// How far over the ground a tool may stand and still work: a blade as rough as graded earth is and a little more, the
// earth it pushes filling the rest; a screed, which sits on the mix it lays, hardly any.
export const TOOL_CONTACT = Object.freeze({ blade: .02, paver: .005 });

// How far past a stretch of it asked for the graded earth a blade leaves is laid, to be read (`gradedGround`): further than
// its bumps are read past the ends of a stretch (terrain.ts `BUMPS_MARGIN`), so that where they come down to the line at its
// ends is out of their reach.
const GRADED_MARGIN = 6;
// The ground a blade leaves behind it, which it rests on: the line of `terrain` with the bumps graded earth has over it
// (terrain.ts `RoughGround`), wherever it is asked and whatever lies there now, as the field has it once it lays what the
// blade did.
export function gradedGround(terrain: Terrain): SectionGround {
  const graded = (a: number, b: number): RoughGround => new RoughGround(Object.create(terrain,
    { roads: { value: paved(NO_ROADS, a - GRADED_MARGIN, b + GRADED_MARGIN, 'graded') } }), a, b);
  return { height: x => graded(x, x).height(x), section: (a, b) => graded(a, b).section(a, b) };
}
// The outline of a ground under a straight edge from `from` to `to`, by the share `u` of the edge each corner of it is at,
// in order from `from`: how high the ground is there (`y`). A ground tells how high it is at a place (`height`), and its
// corners between two (`section`).
export function outline(ground: SectionGround, from: Point, to: Point): EdgePoint[] {
  const dx = to.x - from.x;
  if (Math.abs(dx) < 1e-9) return [from, to].map((p, u) => ({ u, y: ground.height(p.x) }));
  const points = ground.section(Math.min(from.x, to.x), Math.max(from.x, to.x)).map(p => ({ u: Math.min(1, Math.max(0, (p.x - from.x) / dx)), y: p.y }));
  return dx < 0 ? points.reverse() : points;
}
// How far a straight edge from `from` to `to` goes down plumb to meet a ground, as it lies under it (`outline`): to where
// that ground stands nearest under it.
export const edgeNeed = (points: readonly EdgePoint[], from: Point, to: Point): number => Math.min(...points.map(p => from.y + (to.y - from.y) * p.u - p.y));
// How far down plumb from where it travels the tool of a road machine of `kind`, its box laid by `place` (`placeOf`), goes
// to meet `ground` (`outline`): a blade its cutting edge, level across the way (`bladeEdge`), to where that ground is highest
// under it — the ground it leaves graded (`gradedGround`) —, and a paver the trailing edge of its screed, to the ground under
// it. The screen sets them down so (road-machine-motion.ts `bladeDrop`, `screedDrop`), and the field makes road only while
// they meet it (server/road-works.ts).
export function toolNeed(kind: RoadToolKind, place: RoadPlace, ground: SectionGround): number {
  const W = place.width, H = place.height;
  if (kind === 'paver') { const edge = place.world(TOOL_POINT.paver.x * W, TOOL_POINT.paver.y * H); return edge.y - ground.height(edge.x); }
  const [heel, toe] = bladeEdge(W, H), y = TOOL_POINT.blade.y * H, from = place.world(heel, y), to = place.world(toe, y);
  return edgeNeed(outline(ground, from, to), from, to);
}
// Whether a tool of `kind` that goes down `reach` metres at the most (its piece's `toolReach`, game_construction.rs) meets a
// ground it goes down `need` metres to (`toolNeed`).
export const reaches = (kind: RoadToolKind, need: number, reach: number): boolean => need <= reach + TOOL_CONTACT[kind];
