import type { Point } from './math.ts';
import type { MaterialId, MetalId } from './materials.ts';
import type { AuthoredConstruction, AuthoredChassis, CompiledConstruction, CompiledFrame, ChassisModelId, ConstructionSource } from './construction-contract.ts';
import type { ChassisMetalId } from './chassis.ts';
import type { RoomWall } from './frame-editing.ts';
export type ConstructionKind = ChassisModelId | 'fixed';
type HeldBound = 'reach' | 'order' | 'length' | 'below' | 'above';
interface PointRange { minX:number; maxX:number; minY:number; maxY:number; held: { minX:HeldBound; maxX:HeldBound; minY:HeldBound; maxY:HeldBound } }
import { chassisSpec, chassisGearSize, chassisLengthRange, chassisFront, chassisRear, frameThicknessMm, straightChassis,
  chassisTrack, skidRange, suspensionHeight, suspensionZero, trackFloorY, withAxle, withAxleCount, withChassisMetal, withFrameThickness, withGap, withGearScale, withGearWritten,
  withPoint, withPointAdded, withPointRemoved, withSkidEnd, withSkidLeg, withSkidsMoved, withTrackEnd, withTrackSpan, withTrackPosition, withTrackHeight } from './chassis.ts';
import { closestSegment } from './math.ts';
import { CELL, cellOf, unitsOf } from './grid.ts';
import { REACH_CELLS, SMALLEST_ROOM } from './frame-editing.ts';
import { MATERIALS } from './materials.ts';

// Editing the chassis of a vehicle: its model, the line of points it runs along from its front to its rear
// (`chassis.points`, along the design as its nodes are written, in cells; the stretch from a point to the next is a gap, with no
// chassis, where that point says so), the metal of its frame, its axles or its track, and the armour of the running
// gear that comes with it. As in the editing of the frame (frame-editing.ts), every function takes the authoring and
// returns a new one, and none decides what is admitted: the editor proposes the result and the compiler answers.
//
// The chassis is one piece to the player. Its frame, the rails or the nose under it and the wheels or the track it
// comes with are all its parts (`chassis:…`), and the root plate of its frame, that of its first stretch, stands for
// the whole of it.
export const CHASSIS_ID = 'chassis:frame-0';
export const chassisTopPlate = (id: unknown): boolean => typeof id === 'string' && /^chassis:top-\d+$/.test(id);
export const chassisPart = (id: unknown): boolean => typeof id === 'string' && id.startsWith('chassis:') && !chassisTopPlate(id);
// The plate of the frame over the stretch from point `i`, `chassis:frame-<i>`, carries the bed of that stretch.
const FRAME = /^chassis:frame-(\d+)$/;
export const framePlate = (id: unknown): boolean => typeof id === 'string' && FRAME.test(id);
const round = (value: number) => Number(value.toFixed(9));
const NEAR = 1e-6;
// How near the next point of a chassis stands to one at the nearest, in cells (game_chassis.rs `POINT_SPACING`).
export const POINT_SPACING = 2;

// The chassis with its running gear written where it stands: moving its points cannot silently redistribute it.
const explicit = withGearWritten;
// The design on a chassis of other points, what stands on its bed where it stood. Nothing changes for no chassis.
const reshaped = (source: AuthoredConstruction, chassis: AuthoredChassis | null): AuthoredConstruction => chassis && chassis !== source.chassis ? { ...source, preset: 'vehicle', chassis } : source;
// The chassis with its point `index` at `at` along the design (in cells), the others where they were.
export function withChassisPoint(source: AuthoredConstruction, index: number, at: Point): AuthoredConstruction {
  const point = source.chassis!.points[index];
  if (!point) return source;
  if (at.x === point.x && at.y === point.y) return source;
  return reshaped(source, withPoint(explicit(source.chassis!), index, { x: at.x, y: at.y }));
}
// The chassis with its points `indices` each moved by (dx, dy) cells, as a selection moves, the others where they were.
export function withChassisPointsMoved(source: AuthoredConstruction, indices: readonly number[], dx: number, dy: number): AuthoredConstruction {
  if (!source.chassis || !indices.length || !dx && !dy) return source;
  let chassis = explicit(source.chassis!);
  for (const index of new Set(indices)) {
    const point = chassis.points[index];
    if (point) chassis = withPoint(chassis, index, { x: point.x + dx, y: point.y + dy });
  }
  return reshaped(source, chassis);
}
// The chassis with a new point at `x` (in cells), on the line it ran along there, written as the others are.
export function withChassisPointAdded(source: AuthoredConstruction, x: number): AuthoredConstruction {
  const chassis = withPointAdded(explicit(source.chassis!), x);
  return reshaped(source, chassis);
}
// The chassis without its point `index`, the line running straight from the point before it to the point after. Its
// ends stay: a chassis runs from its first point to its last.
export function withChassisPointRemoved(source: AuthoredConstruction, index: number): AuthoredConstruction {
  if (!(index > 0 && index < source.chassis!.points.length - 1)) return source;
  return reshaped(source, withPointRemoved(explicit(source.chassis!), index));
}
// The chassis with the stretch from its point `index` a gap, or chassis again.
export function withChassisGap(source: AuthoredConstruction, index: number, gap: boolean): AuthoredConstruction {
  if (Boolean(source.chassis!.points[index]?.gap) === gap) return source;
  return reshaped(source, withGap(explicit(source.chassis!), index, gap));
}
// Where the point `index` of the chassis may go, in cells, the others staying: along the design, at least
// `POINT_SPACING` from the points beside it; an end as far as its model is made long or short, and no farther than the
// limit of construction; up and down, within the construction box. Each bound says what holds the point there: the 'order' of the points, the
// 'length' of the model, the 'reach' of construction to either side, its floor ('below') or its top ('above'). What
// hangs under the line, its rails or its tub, the compiler keeps off the floor too.
export function chassisPointRange(source: AuthoredConstruction, index: number): PointRange {
  const { model, points } = source.chassis!, [least, most] = chassisLengthRange(model), front = points[0].x, rear = points.at(-1)!.x,
    // The lengths of the model in whole cells, within them.
    shortest = Math.ceil(least / CELL - 1e-9), longest = Math.floor(most / CELL + 1e-9), before = points[index - 1], after = points[index + 1],
    // Of the bounds on one side, the one that holds the point first: the highest of those below it (`way` 1), the
    // lowest of those above it (-1).
    tightest = (way: number, ...bounds: [number, HeldBound][]): [number,HeldBound] => bounds.filter(([value]) => Number.isFinite(value))
      .reduce((best, bound) => way * (bound[0] - best[0]) > NEAR ? bound : best),
    [minX, low] = tightest(1, [REACH_CELLS.minX, 'reach'], [before ? before.x + POINT_SPACING : rear - longest, before ? 'order' : 'length'],
      [after ? -Infinity : front + shortest, 'length']),
    [maxX, high] = tightest(-1, [REACH_CELLS.maxX, 'reach'], [after ? after.x - POINT_SPACING : front + longest, after ? 'order' : 'length'],
      [before ? Infinity : rear - shortest, 'length']);
  return { minX, maxX, minY: REACH_CELLS.minY, maxY: REACH_CELLS.maxY,
    held: { minX: low, maxX: high, minY: 'below', maxY: 'above' } };
}
// The whole construction `dy` cells up, or down: its nodes, the points of its chassis and its components, each on the
// same coordinate units as before, including fractions. Its gear stays on the floor (game_chassis.rs `gear`; the centre
// of a track as written), and the chassis stands that much higher or lower over it.
function raised(source: AuthoredConstruction, dy: number): AuthoredConstruction;
function raised(source: ConstructionSource, dy: number): ConstructionSource;
function raised(source: ConstructionSource, dy: number): ConstructionSource { return !Number.isFinite(dy) || dy === 0 ? source : { ...source,
  nodes: source.nodes.map(node => ({ ...node, y: node.y + dy })),
  preset: 'vehicle', chassis: { ...source.chassis!, points: [ { ...source.chassis!.points[0], y: source.chassis!.points[0].y + dy }, { ...source.chassis!.points[1], y: source.chassis!.points[1].y + dy }, ...source.chassis!.points.slice(2).map(point => ({ ...point, y: point.y + dy })) ] },
  components: source.components.map(part => ({ ...part, pose: { ...part.pose, y: part.pose.y + dy } })) }; }
// The construction on `chassis`, a change of the chassis it had, with its suspension as high as it was (chassis.ts
// `suspensionHeight`): where its model hangs gear of another size or under another frame, all of it goes with that.
const keepingSuspension = (source: AuthoredConstruction, chassis: AuthoredChassis): AuthoredConstruction => raised({ ...source, preset: 'vehicle', chassis }, suspensionZero(chassis) - suspensionZero(source.chassis!));
// Wheels and tracks remain on the ground: the suspension moves the hull and its equipment over them.
export const withChassisSuspension = (source: AuthoredConstruction, height: number) => raised(source, height - suspensionHeight(source.chassis!));
// A design whose track does not rest on the floor, as one written so elsewhere may (a file, an older garage), with its
// track on it and the rest of it as much lower or higher, to the nearest cell: the hull rides over the track as high
// as it did, within half a cell, and stands where the Oficina keeps every track. Any other design is as it was.
export function withTrackOnFloor(source: AuthoredConstruction): AuthoredConstruction;
export function withTrackOnFloor(source: ConstructionSource): ConstructionSource;
export function withTrackOnFloor(source: ConstructionSource): ConstructionSource {
  const track = source.chassis?.track;
  if (!track || chassisSpec(source.chassis!.model)?.kind !== 'tracked') return source;
  const floor = unitsOf(trackFloorY(chassisTrack(source.chassis!).height)), off = floor - track.y;
  if (!Number.isFinite(off) || Math.abs(off) < 1e-9) return source;
  const lifted = raised(source, Math.round(off));
  return { ...lifted, preset: 'vehicle', chassis: { ...lifted.chassis!, track: { ...track, y: floor } } };
}
// Changing running kind keeps physical dimensions, gauge, material, armour, the size of the gear and the height of the
// suspension. Only the incompatible running-gear field is removed. The compiler diagnoses
// geometry and capacity without changing other physical choices.
export function withChassisModel(source: AuthoredConstruction, model: ChassisModelId): AuthoredConstruction {
  if (model === source.chassis!.model) return source;
  const before = source.chassis!, { axles, track, skids, armorMm, ...shape } = before,
    kind = chassisSpec(model)?.kind, thickness = frameThicknessMm(before),
    chassis = { ...shape, model, ...(kind === 'wheeled' && axles ? { axles } : {}), ...(kind === 'tracked' && track ? { track } : {}),
      ...(kind === 'aircraft' && skids ? { skids } : {}), ...(kind !== 'aircraft' && armorMm !== undefined ? { armorMm } : {}) };
  if (!kind) return { ...source, preset: 'vehicle', chassis };
  // Skids take no armour, and stand the hull over them no lower than their legs let it.
  const kept = keepingSuspension(source, withFrameThickness(chassis, thickness));
  return kind === 'aircraft' ? onLegs(kept) : kept;
}
// An aircraft stood over its skids no lower than their legs let it (chassis.ts `skidRange`), and as high as it was if
// that is higher.
const onLegs = (source: AuthoredConstruction): AuthoredConstruction => raised(source, Math.max(0, skidRange(source.chassis!).min - suspensionHeight(source.chassis!)));
// What a construction is: on a chassis of one of its models, or fixed in its place.
export const FIXED = 'fixed';
export const constructionKind = (source: AuthoredConstruction): ConstructionKind => source.chassis?.model ?? FIXED;
// Changing kind never moves the authored geometry or equipment. A new chassis
// starts under the horizontal span, where its model hangs its gear; its structural and material limits remain.
export function withConstructionKind(source: AuthoredConstruction, kind: ConstructionKind): AuthoredConstruction {
  if (kind === constructionKind(source)) return source;
  if (kind === FIXED) {
    const { chassis, ...rest } = source;
    return { ...rest, preset: 'bunker' };
  }
  if (source.chassis!) return withChassisModel(source, kind);
  const xs = source.nodes.map(node => node.x), shortest = Math.ceil(chassisLengthRange(kind)[0] / CELL - 1e-9),
    front = xs.length ? Math.min(...xs) : -shortest / 2, rear = xs.length ? Math.max(...xs) : shortest / 2,
    middle = (front + rear) / 2, half = Math.max(rear - front, shortest) / 2,
    shift = Math.max(0, REACH_CELLS.minX - (middle - half)) - Math.max(0, middle + half - REACH_CELLS.maxX);
  const chassis = straightChassis(kind,
    Math.max(REACH_CELLS.minX, Math.floor(middle - half + shift)), Math.min(REACH_CELLS.maxX, Math.ceil(middle + half + shift))),
    y = suspensionZero(chassis);
  return { ...source, preset: 'vehicle', chassis: { ...chassis, points: [{ ...chassis.points[0], y }, { ...chassis.points[1], y }, ...chassis.points.slice(2).map(point => ({ ...point, y }))] } };
}
// The design on another chassis.
const geared = (source: AuthoredConstruction, chassis: AuthoredChassis): AuthoredConstruction => ({ ...source, preset: 'vehicle', chassis });
// The chassis with one of its axles, `index` from the front, moved towards `x` metres along the design as far as the
// frame and the axles beside it let it (chassis.ts withAxle); the editor chooses whether to assist with the grid.
export const withChassisAxle = (source: AuthoredConstruction, index: number, x: number) => geared(source, withAxle(source.chassis!, index, x));
// Track coordinates and dimensions are metres in the stable local frame. Its ends and its place along the design change
// only the running gear; its height is its size, as gear scale.
export const withChassisTrackEnd = (source: AuthoredConstruction, end: 'front' | 'rear', x: number) => geared(source, withTrackEnd(source.chassis!, end, x));
export const withChassisTrackSpan = (source: AuthoredConstruction, front: number, rear: number) => geared(source, withTrackSpan(source.chassis!, front, rear));
export const withChassisTrackPosition = (source: AuthoredConstruction, x: number) => geared(source, withTrackPosition(source.chassis!, x));
export const withChassisTrackHeight = (source: AuthoredConstruction, height: number) => keepingSuspension(source, withTrackHeight(source.chassis!, height));
// The skids of an aircraft are edited as a track is: an end of their runner, the runner with both legs along the design
// (`dx` metres), or one leg, `index` from the front, in metres in the stable local frame. They stay on the floor and
// nothing else moves.
export const withChassisSkidEnd = (source: AuthoredConstruction, end: 'front' | 'rear', x: number) => geared(source, withSkidEnd(source.chassis!, end, x));
export const withChassisSkidsMoved = (source: AuthoredConstruction, dx: number) => geared(source, withSkidsMoved(source.chassis!, dx));
export const withChassisSkidLeg = (source: AuthoredConstruction, index: number, x: number) => geared(source, withSkidLeg(source.chassis!, index, x));
export function withChassisTrackLength(source: AuthoredConstruction, length: number) {
  const { front, rear } = chassisTrack(source.chassis!), middle = (front + rear) / 2;
  return withChassisTrackSpan(source, middle - length / 2, middle + length / 2);
}
// The chassis on `count` axles, evenly spaced (chassis.ts withAxleCount). A count its model is not made with is
// written all the same, spread over the frame, for the compiler to say so.
export function withChassisAxleCount(source: AuthoredConstruction, count: number) {
  const front = chassisFront(source.chassis!), rear = chassisRear(source.chassis!), half = chassisGearSize(source.chassis!) / 2;
  return geared(source, withAxleCount(source.chassis!, count) ?? { ...source.chassis!,
    axles: Array.from({ length: count }, (_, i) => cellOf(front + half + (rear - front - 2 * half) * i / Math.max(1, count - 1))) });
}
// The frame of the chassis in another metal (chassis.ts withChassisMetal). One no frame is made of is written all the
// same, for the compiler to refuse it.
export const withFrameMetal = (source: AuthoredConstruction, metal: ChassisMetalId): AuthoredConstruction => ({ ...source, preset: 'vehicle', chassis: withChassisMetal(source.chassis!, metal) ?? { ...source.chassis!, metal } });
// Frame gauge and gear size keep the suspension offset. Wheel sizing keeps the existing level running line; a track
// keeps its span and grows up from the floor, and the construction rises with what its model hangs higher. Skids grow up
// from the floor too, and an aircraft stands as high over them as it did, or as much higher as their legs need to stay
// long enough.
export const withChassisThickness = (source: AuthoredConstruction, thicknessMm: number) => keepingSuspension(source, withFrameThickness(source.chassis!, thicknessMm));
export function withChassisGearScale(source: AuthoredConstruction, gearScale: number) {
  const kept = keepingSuspension(source, withGearScale(source.chassis!, gearScale));
  return chassisSpec(source.chassis!.model).kind === 'aircraft' ? onLegs(kept) : kept;
}
// The optional extra plate is described only by its stock. Rust derives it from the current profile on every compile.
export function withChassisTopMaterial(source: AuthoredConstruction, material: MaterialId | 'none'): AuthoredConstruction {
  const { topPlate, ...chassis } = source.chassis!;
  if (material === 'none') return { ...source, preset: 'vehicle', chassis };
  const thicknessMm = Math.max(topPlate?.thicknessMm ?? 5, MATERIALS[material]?.minThicknessMm ?? 5);
  return { ...source, preset: 'vehicle', chassis: { ...chassis, topPlate: { material, thicknessMm } } };
}
export const withChassisTopThickness = (source: AuthoredConstruction, thicknessMm: number): AuthoredConstruction => source.chassis!.topPlate
  ? { ...source, preset: 'vehicle', chassis: { ...source.chassis!, topPlate: { ...source.chassis!.topPlate, thicknessMm } } } : source;
// The armour the chassis gives all of its running gear; none is not written.
export function withChassisArmour(source: AuthoredConstruction, armorMm: number): AuthoredConstruction {
  const { armorMm: _, ...chassis } = source.chassis!;
  return { ...source, preset: 'vehicle', chassis: { ...chassis, ...(armorMm ? { armorMm } : {}) } };
}

// The beds of the chassis a room may be drawn out of, in the field: those that lie level, each with the height `y` the
// nodes of the hull resting on it stand at.
function levelBeds(compiled: CompiledConstruction) {
  const chassis = compiled.chassis;
  return (chassis ? compiled.beds : []).filter(bed => framePlate(bed.id) && Math.abs(bed.a.y - bed.b.y) < NEAR).map(bed => {
    return { bed, y: round(bed.a.y + bed.thicknessMm / 2000) };
  });
}
// Level bed spans follow their real faces, including a fractional chassis
// endpoint. Grid assistance belongs to the subsequent drawing gesture.
export function bedStretches(compiled: CompiledConstruction) {
  return levelBeds(compiled).map(({ bed, y }) => ({ id: bed.id, x0: bed.b.x, x1: bed.a.x, y }))
    .filter(({ x0, x1 }) => x1 - x0 >= SMALLEST_ROOM - 1e-9);
}
// A room may start on any free level stretch, including one apart from the
// existing hull. This is a drawing convenience, not a support requirement.
export function bedStretchAt(compiled: CompiledConstruction, point: Point, tolerance = 0): (RoomWall & { id: string; bed: true }) | null {
  const chassis = compiled.chassis;
  if (!chassis) return null;
  const free = bedStretches(compiled).filter(({ x0, x1, y }) => point.x >= x0 - tolerance && point.x <= x1 + tolerance &&
      point.y <= y + tolerance && point.y >= y - chassis.depth - tolerance)
      .sort((one, other) => Math.abs(one.y - point.y) - Math.abs(other.y - point.y))[0];
  if (!free) return null;
  const at = new Map(compiled.frame.nodes.map(node => [node.id, node])),
    middle = { x: (free.x0 + free.x1) / 2, y: free.y },
    distance = (span: CompiledFrame['plates'][number]) => { const near = closestSegment(middle, at.get(span.a)!, at.get(span.b)!); return Math.hypot(near.x - middle.x, near.y - middle.y); },
    authored = compiled.frame.plates.filter(span => !chassisPart(span.id)),
    span = authored.reduce<CompiledFrame['plates'][number] | null>((best, other) => !best || distance(other) < distance(best) ? other : best, null),
    armour = span && compiled.plates.find(plate => plate.id === span.id),
    { material = 'steel', thicknessMm = 20 } = armour || {}, y = round(free.y + thicknessMm / 2000);
  return { id: free.id, bed: true, a: { x: free.x1, y }, b: { x: free.x0, y }, normal: { x: 0, y: 1 },
    length: round(free.x1 - free.x0), material, thicknessMm };
}
