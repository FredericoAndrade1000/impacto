import { context2d } from './canvas-art.ts';
import type { ArtCanvas, ArtContext, CanvasPaint, GradientStop, XY } from './canvas-art.ts';
import type { MachineKit } from './machine-art.ts';
import type { FinishProfile } from './vehicle-art-contract.ts';
import type { WeatheringMaps, WeatheringBounds } from './weathering.ts';
import type { Point, Pose } from './math.ts';
import type { MaterialId, MetalId } from './materials.ts';
import type { ChassisModelId, ChassisPoint, ChassisPartMetadata, WithAbsentSlots } from './construction-contract.ts';
import type { SceneFramePart } from './scene-frame.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { FenderWheel } from './hull-details.ts';

export interface ChassisDimensions { wheelDiameter: number | undefined; deck: number; depth: number }
export type ChassisDimensionOptions = { [Field in keyof ChassisDimensions]?: ChassisDimensions[Field] | undefined };
interface SuspensionBase { axle: number; r: number; depth: number; housing: number }
export type SuspensionRig = SuspensionBase & WithAbsentSlots<
  { kind: 'coil'; top: number; radius: number; wire: number } |
  { kind: 'leaf'; span: number; leaves: number; leaf: number; shackle: number; hanger: number; damper: number;
    over: boolean; block: number; eye: number; arch: number }
>;
export interface ChassisKnee { point: Point; normal: Point; turn: number; seam: number }
export interface ChassisStraight { a: Point; b: Point; angle: number; length: number; part: number;
  piece: [Point, Point, Point, Point]; ahead: ChassisKnee | null; behind: ChassisKnee | null }
interface ChassisRun { from: number; to: number; inner: [boolean, boolean] }
export interface ChassisTrack { width: number; height: number; y: number; middle?: number | undefined; armorMm?: number | undefined; held?: boolean | undefined }
export interface ChassisSkids { front: number; rear: number; y: number; tube: number; legs: { x: number; top: number; foot: number }[] }
export interface ChassisFloor { thicknessMm: number; metal: MaterialId; segments: readonly number[] }
interface FloorBand { segment: number; points: [Point, Point, Point, Point] }
interface LaidFloor { decks: Point[][]; tops: Point[]; bands: FloorBand[] }
interface PartBox extends Point { w: number; h: number }
interface PartLocation { straight?: number; hangs?: Point }
type SimpleKind = 'hole' | 'rivet' | 'bolt' | 'lug' | 'boss' | 'drive' | 'stiffener' | 'saddle';
type SimplePart = { [Kind in SimpleKind]: PartBox & PartLocation & { kind: Kind } }[SimpleKind];
type EndBracket = { end?: number; pinX?: number; bracket?: number };
type HangingPart = PartBox & PartLocation & EndBracket & { pin: number } & (
  { kind: 'hanger'; eye: number } | { kind: 'shackle'; eye: number } | { kind: 'bracket' }
);
type TowerPart = PartBox & PartLocation & { kind: 'tower'; pin: number; bolts: number; axle: number };
type DroppedKind = 'tower' | 'hanger' | 'shackle' | 'bracket';
type DroppedPart = PartBox & PartLocation & { upright: true; pinX: number; pin: number; top: XY[]; low: XY[]; bolts: XY[]; hangs: Point; eye?: number } &
  { [Kind in DroppedKind]: { kind: Kind } }[DroppedKind];
type PartVariants = SimplePart | HangingPart | TowerPart | DroppedPart |
  PartBox & PartLocation & (
    { kind: 'gusset'; bolts: number } | { kind: 'knee'; points: Point[]; bolts: Point[] } |
    { kind: 'fairing'; end: 'front' | 'rear'; r: number } | { kind: 'bay'; up: boolean; corner: number; points: [XY, XY, XY] } |
    { kind: 'skid'; front: number; rear: number; runner: number; tube: number; toe: number } |
    { kind: 'leg'; top: number; foot: number; tube: number } |
    { kind: 'idler'; hub: Point; pivot: Point; brace: Point; size: number }
  );
export type ChassisPart = WithAbsentSlots<PartVariants>;
type PartKind = ChassisPart['kind'];
type DetailsOf<Part> = Part extends unknown ? Omit<Part, 'kind' | keyof PartBox> : never;
type PartDetails<Kind extends PartKind> = DetailsOf<Extract<ChassisPart, { kind: Kind }>>;
interface AddPart {
  <Kind extends SimplePart['kind']>(kind: Kind, x: number, y: number, w: number, h: number, more?: PartDetails<Kind>): Extract<ChassisPart, { kind: Kind }>;
  <Kind extends Exclude<PartKind, SimplePart['kind']>>(kind: Kind, x: number, y: number, w: number, h: number, more: PartDetails<Kind>): Extract<ChassisPart, { kind: Kind }>;
}
export interface ChassisShade { piece: readonly (Point | XY)[]; a: Point; b: Point }
interface GuardBox extends PartBox { shape: number[] }
export interface ChassisSkirt extends GuardBox { kind: 'skirt'; points: XY[]; cuts: number[]; ribbed: boolean; deck: ChassisShade[] }
export interface ChassisMudguard extends GuardBox { kind: 'mudguard'; axle: Point; half: number; axles: number[]; r: number;
  inner: number; outer: number; round: number; feet: [number, number]; stay: number; held: [number | null, number | null] }
export type ChassisGuard = WithAbsentSlots<ChassisSkirt | ChassisMudguard>;
export type KeyedChassisGuard = ChassisGuard & { key: string };
export interface RearMudguardStay { mount: PartBox; tip: Point; points: XY[] }
export interface ChassisLayoutOptions {
  length: number; profile: readonly ChassisPoint[]; outlines: readonly (readonly Point[])[];
  track?: ChassisTrack | null | undefined; sprocketFront?: boolean; axles?: readonly number[] | null | undefined;
  skids?: ChassisSkids | null | undefined; deck?: number | undefined; wheelDiameter?: number | undefined;
  thicknessMm?: number | undefined; metal?: MaterialId | undefined; floor?: ChassisFloor | null | undefined; depth?: number | undefined;
}
export interface ChassisLayout {
  model: ChassisModelId; kind: ChassisModelId; length: number; deck: number; depth: number; wheelDiameter: number | undefined;
  thicknessMm: number; metal: MaterialId; profile: readonly ChassisPoint[]; outlines: readonly (readonly Point[])[];
  straights: ChassisStraight[]; runs: ChassisRun[]; floor: { thicknessMm: number; metal: MaterialId; bands: FloorBand[] } | null;
  decks: readonly (readonly Point[])[]; shades: ChassisShade[]; top: number; bottom: number; key: string;
  axles: FenderWheel[]; parts: ChassisPart[]; guards: KeyedChassisGuard[];
}
export interface ChassisPlacement { origin: Point; along: Point; up: Point; mirrored: boolean }
export interface ChassisArtwork { left: number; top: number; width: number; height: number; layout: ChassisLayout; rearStays: RearMudguardStay[]; key: string }
export interface ChassisImpactMark extends Point { radius: number; angle: number; kind: string; u: number; v: number; strength?: number }
export interface SuspensionShape { points: number[]; fill?: number; line: { color: number; width: number } | null }
type ChassisKit = MachineKit & { weathering: WeatheringMaps | null | undefined; material: MaterialId | MetalId };
type Project = (x: number, y: number) => [number, number];
type Extent = { left: number; right: number; bottom: number; top: number };
type TrackWheel = Point & ({ role: 'road'; pivot: Point } | { role: 'idler' | 'sprocket' });
type DrawingFramePart = SceneFramePart<DrawingScene>;
export type ChassisFramePart<Part extends DrawingFramePart = DrawingFramePart> = Extract<Part, { type: 'plate' }> &
  { data: { definition: { chassis: ChassisPartMetadata & { profile: ChassisPoint[] } } } };
import { SKID_TUBE, chassisSpec } from './chassis.ts';
import { MATERIALS } from './materials.ts';
import { Random, clamp, TAU } from './math.ts';
import { canvas, paintSurfaceMetres, pieceTexture } from './textures.ts';
import { kit, shade } from './machine-art.ts';
import { TRACK_BELT, TRACK_WHEEL, idlerMounts, trackOutline, trackWheels as beltWheels } from './running-gear.ts';
import { paintWeathering } from './weathering.ts';
import { FENDER_SLOPE, fenderAcross, fenderGroups, fenderHeight, fenderLine, fenderOver } from './hull-details.ts';

// The chassis a vehicle is built on, as it is drawn: by the one rule of the art of every piece (machine-art.ts), a side
// elevation seen square on, lit from above, where only what turns across the vehicle shows round.
// - A wheeled one is a ladder frame, and of it the near rail shows: its web between the bends of its flanges, holed in a
//   row to be light, riveted along its edges; the plates the cross members are bolted by, at either end and over each
//   axle; and under it what holds each axle — the hangers of a pack of leaves, its shackle and the bracket of its
//   damper on a medium or a heavy one (the FMTV, the HEMTT, the MAN HX), the tower of a coil spring on a light one (the
//   HMMWV, the JLTV). The springs, the dampers and the end of each axle move with the wheel, and are drawn apart
//   (`suspensionShapes`).
// - An aircraft's is the keel of a light helicopter (the Bell 206, the H125) on its skids: a built-up beam, riveted caps
//   along a web lightened in a truss, faired at its ends (`keelParts`, `paintKeel`); under it at either end the cross
//   tube of the skids, coming out at the viewer, held in a saddle and a strap bolted under the keel, its bent end the leg
//   down to the runner, a tube along the floor bent up at the front into a toe and capped behind, a shoe of steel along
//   its foot (`skidParts`, `paintSkids`).
// - A tracked one is the lower hull, the tub, of its own armour and paint: its side down to the belly, closed ahead by
//   the sloped plate of its nose (the lower glacis) and behind by its rear plate, bolted along its top; on it the bosses
//   the arms of the road wheels turn in, the housing of the final drive the sprocket is on and the crank of the idler
//   with the screw that tensions the belt (the M113, the Bradley, the CV90, the Leopard 2). The track covers most of it,
//   as on those, and shows it where it is gone; those mountings are only painted there (`trackedParts`).
// What a chassis hangs over its running gear, the skirt over a track and the mudguard over a wheel, is over the gear and
// is drawn apart (`guards` of the layout, `paintGuardCanvas`). The chassis is under what stands on its deck, and in its
// shade: where a hull or a body stands on it, its deck is dark under their foot (`chassisSeats`, `createSeatShade`), and
// round each wheel the rail is in the shade of the tyre and of the fender over it.
//
// Everything is placed by rules from the model and the points of the chassis, the same every time, in the frame of the
// picture: from the front end of the chassis (x = 0) to its rear one (x = its length), up from the height of its deck
// (y = 0), where its low stretches are and its raised ones over. Between two points it runs straight, and over a gap
// there is none of it. Nothing stands out of the outline of the chassis but what hangs down to an axle.

// How a wheeled chassis holds its axles, by its size, in metres: where each axle is under the deck when the vehicle
// stands (`axle`), and the wheel's radius `r`. The wheels stand on the ground wherever the chassis is (game_chassis.rs
// `suspension`), so the axle is as far under the rail as the chassis is high over its wheels, and what holds it reaches
// from the rail to it there, longer or shorter, never under it:
// - light: a coil spring over a damper on each wheel, from a seat on the end of the axle up to a pin on the tower of the
//   rail (`top`), as an independent suspension has it; where the axle stands far under the rail the tower reaches down
//   to keep the spring no longer than `COIL`, and under the rail;
// - medium and heavy: a pack of `leaves` leaves, each `leaf` thick, clamped to the axle, its eyes on pins `span` ahead of
//   the axle and behind it, at `eye`, `arch` over the middle of its main leaf (under it where the pack is pressed
//   flatter than straight): the front one in a hanger, the rear one in a shackle that hangs `shackle` from its bracket;
//   a damper from the axle up to a bracket on the web, its pin at `damper`. `housing` is the radius of the end of the
//   axle. The pack sits on the axle (`over`), as on most trucks, its eyes where their hangers hold them under the rail;
//   where the axle stands so far under it that the pack would bend more than it does, on a block (`block`, a lift block)
//   as high as it takes up to `BLOCK`, and on longer hangers beyond that; where the axle stands so close under the rail
//   that the pack on it would come up to the rail, the pack is slung under the axle instead, its eyes over the axle.
const COIL = .34, BLOCK = .15, ARCH_OVER = [-.05, .08] as const, ARCH_UNDER = [0, .12] as const;
export function suspensionRig(model: ChassisModelId, { wheelDiameter = chassisSpec(model).wheel!, deck = chassisSpec(model).deck,
  depth = chassisSpec(model).depth! }: ChassisDimensionOptions = {}): SuspensionRig {
  const r = wheelDiameter / 2, axle = r + .01 - deck, damper = Math.min(-.03, Math.max(-depth * .8, axle + .09));
  if (wheelDiameter < 1.05 && depth < .23) {
    const housing = .06;
    return { kind: 'coil', axle, r, depth, top: Math.min(-.035, axle + housing + .012 + COIL + .02), radius: .055, wire: .014, housing };
  }
  const heavy = wheelDiameter >= 1.2 || depth >= .28, housing = heavy ? .085 : .075, leaves = heavy ? 5 : 4, leaf = heavy ? .02 : .016,
    held = -depth - (heavy ? .085 : .07), base = { kind: 'leaf' as const, axle, r, depth, span: r + (heavy ? .14 : .13), leaves, leaf, housing,
      shackle: .065, hanger: heavy ? .12 : .1, damper },
    // The middle of the main leaf, the top one, of a pack on the axle with no block.
    on = axle + housing + (leaves - .5) * leaf;
  if (held - on >= ARCH_OVER[0]) {
    const block = clamp(held - on - ARCH_OVER[1], 0, BLOCK), eye = Math.min(held, on + block + ARCH_OVER[1]);
    return { ...base, over: true, block, eye, arch: eye - on - block };
  }
  const under = axle - housing, eye = Math.max(clamp(held, under + ARCH_UNDER[0], under + ARCH_UNDER[1]), axle + .012);
  return { ...base, over: false, block: 0, eye, arch: eye - under };
}
// Where the axles of a wheeled chassis are along it, as the construction compiler lays them (game_chassis.rs) where the
// player has not placed them: evenly spaced between its overhangs.
function chassisAxles(model: ChassisModelId, length: number) {
  const { axles, overhang } = chassisSpec(model), [ahead, behind] = overhang!, last = length - behind;
  return Array.from({ length: axles! }, (_, i: number) => ahead + (last - ahead) * i / (axles! - 1));
}
// Where a point of a track `track` (its `width` and `height`), in its own frame, stands in the frame of the picture of
// a chassis, its `middle` where the compiler lays it (from the smaller-x end when it says none). `sprocketFront` selects
// its end in this actual frame; the chassis placement already accounts for which way the vehicle faces in the world.
function onTrack(track: ChassisTrack, sprocketFront: boolean) {
  const middle = track.middle ?? track.width / 2, way = sprocketFront ? 1 : -1, y = track.y;
  return (u: number, v: number) => ({ x: middle + way * u, y: y + v });
}
// The wheels of a track as running-gear.ts lays them out, in the frame of the picture: the sprocket and the idler raised
// at its ends, and the road wheels between them, each with the pivot of its arm.
function trackWheels(track: ChassisTrack, sprocketFront: boolean): TrackWheel[] {
  const { end, road, low } = beltWheels(track.width, track.height), at = onTrack(track, sprocketFront);
  return [{ ...at(-end.x, end.y), role: 'sprocket' },
    ...road.map((u: number) => ({ ...at(u, low), pivot: at(u - .09, track.height * .12), role: 'road' as const })),
    { ...at(end.x, end.y), role: 'idler' }];
}

// The straights of a chassis, as the core lays it out (game_chassis.rs) along its points (`profile`, from its front end
// back, in the frame of its picture, each `gap` that opens one): the chassis runs from point to point but over a gap,
// where there is nothing of it. Between two gaps, or a gap and an end, is a part of it, and each part has its outline
// (`outlines`, in order): along its top its points from the front back, then under each its partner on its foot, from
// the rear forward — `depth` down square to the stretch at each end, where the two lines that far under the stretches
// meet at each knee (and of a tub, the foot of its nose at the front of its first part). Points in line with those either
// side of them are no knee: the chassis runs straight through them. Each straight is from its first point `a` to its last
// `b`, its slope (`angle`) and its `length` along it; the part it is of; its piece of the outline of that part, convex —
// the top of the straight and the foot under it (`piece`); and at each end, ahead and behind, a knee where it meets the
// next straight (`ahead`, `behind`: where it turns, the line through the knee each keeps to, `normal` out of the one it
// is told for, and how far it turns, `turn`), or none where it ends.
function straights(_profile: readonly ChassisPoint[], outlines: readonly (readonly Point[])[]): ChassisStraight[] {
  const all: ChassisStraight[] = [];
  for (const [part, outline] of outlines.entries()) {
    const n = outline.length / 2, foot = (k: number) => outline[2 * n - 1 - k]!, top = outline.slice(0, n);
    let first = 0;
    for (let k = 1; k < n; k++) {
      const a = top[first]!, b = top[k]!, next = top[k + 1];
      // A point in line with the next one runs on into it.
      if (next && Math.abs(Math.atan2(next.y - b.y, next.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)) < 1e-9) continue;
      const dy = b.y - a.y;
      all.push({ a, b, angle: Math.atan2(dy, b.x - a.x), length: dy ? Math.hypot(b.x - a.x, dy) : b.x - a.x, part,
        piece: [a, b, foot(k), foot(first)], ahead: null, behind: null });
      first = k;
    }
  }
  for (let i = 1; i < all.length; i++) {
    const s = all[i - 1]!, t = all[i]!;
    if (s.part !== t.part) continue;
    const ux = Math.cos(s.angle) + Math.cos(t.angle), uy = Math.sin(s.angle) + Math.sin(t.angle), n = Math.hypot(ux, uy), turn = t.angle - s.angle;
    s.behind = { point: s.b, normal: { x: ux / n, y: uy / n }, turn, seam: SEAM };
    t.ahead = { point: t.a, normal: { x: -ux / n, y: -uy / n }, turn, seam: 0 };
  }
  return all;
}
// How far the straight behind a knee paints into the next one over the line they meet on, in metres, for no seam to show.
const SEAM = .002;
// Where a straight is painted along itself, from its first point as it lies level (`onStraight`): from `from` to `to`, its
// far end to the tenth of a millimetre as the length of a chassis is; past each knee as far as its foot reaches, and a
// little more, for the line the two meet on to cut it.
function reach(straight: ChassisStraight, depth: number): [number, number] {
  const past = (knee: ChassisKnee | null) => knee ? depth * Math.tan(Math.abs(knee.turn) / 2) + .05 : 0;
  return [straight.a.x - past(straight.ahead), Math.round((straight.a.x + straight.length) * 1e4) / 1e4 + past(straight.behind)];
}
// The low and level runs of a chassis (`straights`), where its axles go (game_chassis.rs): each the stretch along it from
// `from` to `to` of a straight at the height of its deck, and whether each end of it is a gap or a knee rather than an end
// of the chassis (`inner`).
const levelRuns = (straights: readonly ChassisStraight[], length: number): ChassisRun[] => straights.filter(s => Math.abs(s.a.y) < 1e-9 && Math.abs(s.b.y) < 1e-9)
  .map(s => ({ from: s.a.x, to: s.b.x, inner: [s.a.x > 1e-6, s.b.x < length - 1e-6] }));
const runAt = (runs: readonly ChassisRun[], x: number) => runs.find(run => run.from - 1e-6 <= x && x <= run.to + 1e-6);

// What the picture of a chassis shows and where, in its frame: each part by its kind and its box (`x`, `y` its middle,
// `w`, `h`); one on a straight that slopes is in the frame of that straight (`straight`, its index), as it lies level from
// its first point (`onStraight`); one that hangs out of the outline down to an axle says which (`hangs`, the axle's
// centre); and what it hangs over its running gear (`guards`). The chassis is as long as `length`, along its points
// (`profile`) and the outline of each part of it between gaps (`outlines`), as its frame plate tells them. `track` is the
// track of a tracked one, as wide and as tall as it is, its `y` relative to the deck and its `middle` from the front end, from the front of the chassis
// when it says none, the armour it is of (`armorMm`) and whether the chassis holds it on (`held`), over the mountings of
// its wheels (`trackedParts`); `sprocketFront` where its sprocket is; `axles` where the axles of a wheeled one are from its
// front end, where the model puts them when it says none (the frame plate of a chassis tells both); `skids` the skids of an
// aircraft, as its frame plate tells them (game_chassis.rs `describe`): its runner from its `front` to its `rear`, its
// middle `y` over the deck, as thick as its `tube`, and its legs, each at `x` from the foot of the rail (`top`) down to the
// top of the runner (`foot`).
// `floor` is the floor plate laid over its frame (its `topPlate`), as thick as it is (`thicknessMm`), of its metal, over
// the segments of the profile that still have their piece of it (`segments`): the picture shows it on the frame, under
// what stands on it (`floorBands`), the outline of each part goes round it (`decks`) and the shade of what stands on it
// falls from its top (`shades`: the straights with the floor on them, as `seatShadeGeometry` takes them).
export function chassisLayout(model: ChassisModelId, { length, profile, outlines, track = null, sprocketFront = true, axles: placed = null, skids = null,
  deck = chassisSpec(model).deck, wheelDiameter = chassisSpec(model).wheel,
  thicknessMm = chassisSpec(model).frameMm, metal = 'steel', floor = null,
  depth = chassisSpec(model).depth ?? chassisSpec(model).deck - chassisSpec(model).clearance! }: ChassisLayoutOptions): ChassisLayout {
  const spec = chassisSpec(model), parts: ChassisPart[] = [], lines = straights(profile, outlines), runs = levelRuns(lines, length),
    dimensions = { deck, wheelDiameter, depth },
    add: AddPart = <Kind extends PartKind>(kind: Kind, x: number, y: number, w: number, h: number, more?: PartDetails<Kind>) => {
      // The kind and its matching Omit payload are checked together by AddPart; spreading them loses that correlation.
      const part = { kind, x, y, w, h, ...more } as Extract<ChassisPart, { kind: Kind }>;
      parts.push(part); return part;
    };
  const fix = (v: number) => Math.round(v * 1e4) / 1e4, axles = spec.kind === 'wheeled'
    ? (placed ?? chassisAxles(model, length)).map((x: number) => ({ x, y: suspensionRig(model, dimensions).axle, r: wheelDiameter! / 2 }))
    : track ? trackWheels(track, sprocketFront).map(w => ({ x: w.x, y: w.y, r: track.height * (TRACK_WHEEL - TRACK_BELT) })) : [];
  if (spec.kind === 'wheeled') wheeledParts(model, lines, runs, add, placed ?? chassisAxles(model, length), dimensions);
  else if (spec.kind === 'aircraft') keelParts(lines, add, depth, thicknessMm, skids ? skidParts(skids, add) : []);
  else trackedParts(model, lines, track, sprocketFront, add, dimensions);
  const corners = outlines.flat(), bottom = Math.min(...corners.map(p => p.y), ...parts.map(p => extent(lines, p).bottom)),
    laid = floor && floorBands(profile, outlines, floor.segments, floor.thicknessMm / 1000),
    floorKey = laid ? `floor:${fix(floor.thicknessMm)}/${floor.metal}/${laid.bands.map(band => band.segment).join(',')}` : '',
    decks = laid ? laid.decks : outlines, shades = laid ? floored(lines, profile, laid) : lines, keel = spec.kind === 'aircraft';
  return { model, kind: spec.kind, length: fix(length), deck, depth, wheelDiameter, thicknessMm, metal, profile, outlines, straights: lines, runs,
    floor: laid && { thicknessMm: floor.thicknessMm, metal: floor.metal, bands: laid.bands },
    decks: keel ? fairedDecks(decks, outlines, lines, depth) : decks, shades: keel ? fairedPieces(shades, lines, depth) : shades,
    top: fix(Math.max(...corners.map(p => p.y), ...(laid?.bands ?? []).flatMap(band => band.points.map(p => p.y)))), bottom: fix(bottom - .01),
    key: [model, fix(length), fix(deck), fix(depth), fix(thicknessMm), metal, wheelDiameter === undefined ? '' : fix(wheelDiameter), track ? `${fix(track.width)}x${fix(track.height)}@${fix(track.middle ?? track.width / 2)},${fix(track.y)}/${track.armorMm || 0}${track.held ? '/held' : ''}` : '',
      sprocketFront ? 'ahead' : 'behind', ...(placed ?? []).map(fix), profile.map(p => `${fix(p.x)},${fix(p.y)}${p.gap ? '/gap' : ''}`).join(' '),
      ...skids ? [`skids:${fix(skids.front)},${fix(skids.rear)},${fix(skids.y)},${fix(skids.tube)},${skids.legs.map(leg => `${fix(leg.x)}/${fix(leg.top)}/${fix(leg.foot)}`).join(',')}`] : [],
      ...floorKey ? [floorKey] : []].join(':'),
    axles: axles.map(a => ({ x: fix(a.x), y: fix(a.y), r: fix(a.r) })),
    parts: parts.map(p => ({ ...p, x: fix(p.x), y: fix(p.y), w: fix(p.w), h: fix(p.h) })),
    guards: guards(model, track, sprocketFront, axles, { ...dimensions, runs }).map(keyed) };
}
// The box a part of a chassis (`chassisLayout`) takes in the frame of its picture: turned with the straight it is on.
function extent(lines: readonly ChassisStraight[], part: ChassisPart): Extent {
  const line = part.straight === undefined ? undefined : lines[part.straight], hw = part.w / 2, hh = part.h / 2;
  if (!line?.angle || part.upright) return { left: part.x - hw, right: part.x + hw, bottom: part.y - hh, top: part.y + hh };
  const c = Math.cos(line.angle), s = Math.sin(line.angle), dx = part.x - line.a.x, dy = part.y - line.a.y,
    x = line.a.x + dx * c - dy * s, y = line.a.y + dx * s + dy * c, w = hw * Math.abs(c) + hh * Math.abs(s), h = hw * Math.abs(s) + hh * Math.abs(c);
  return { left: x - w, right: x + w, bottom: y - h, top: y + h };
}
// The floor plate over the frame of a chassis (its `topPlate`, game_chassis.rs), from the side: over each segment of its
// profile that has a frame and still has its piece of floor (`segments`, by their place along the profile), a band from
// the deck up as thick as the plate (`lift`), its ends square to the segment at an end of a part and mitred at a knee, as
// the core lays the plate (`under_way`): its corners from the front of its deck to the rear and back along its top
// (`bands`). And the outline of each part of the chassis between gaps (`outlines`) with the floor on it, its top going up
// round each piece of floor (`decks`), for the edge and the light of the chassis to go round the floor as round the frame.
function floorBands(profile: readonly ChassisPoint[], outlines: readonly (readonly Point[])[], segments: readonly number[], lift: number): LaidFloor {
  const framed = (i: number) => i >= 0 && i < profile.length - 1 && !profile[i]!.gap, fix = (v: number) => Math.round(v * 1e5) / 1e5,
    down = (i: number) => { const a = profile[i]!, b = profile[i + 1]!, d = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.y - a.y) / d, y: -(b.x - a.x) / d }; },
    tops = profile.map((p, k: number) => {
      const before = framed(k - 1) && down(k - 1), after = framed(k) && down(k), s = before && after ? 1 + before.x * after.x + before.y * after.y : 1,
        way = before && after ? { x: (before.x + after.x) / s, y: (before.y + after.y) / s } : before || after || { x: 0, y: -1 };
      return { x: fix(p.x - way.x * lift), y: fix(p.y - way.y * lift) };
    }),
    on = new Set(segments.filter(framed)), deckOf = (p: Point) => ({ x: p.x, y: p.y });
  let first = 0;
  const decks = outlines.map(outline => {
    const n = outline.length / 2, top: Point[] = [];
    for (let k = 0; k < n; k++) {
      const at = first + k, behind = k > 0 && on.has(at - 1), ahead = k < n - 1 && on.has(at);
      if (behind) top.push(tops[at]!);
      if (!(behind && ahead)) top.push(outline[k]!);
      if (ahead && !behind) top.push(tops[at]!);
    }
    first += n;
    return [...top, ...outline.slice(n)];
  });
  return { decks, tops, bands: [...on].sort((i: number, j) => i - j).map((i: number) => ({ segment: i, points: [deckOf(profile[i]!), deckOf(profile[i + 1]!), tops[i + 1]!, tops[i]!] })) };
}
// Each straight of a chassis (`straights`) the floor (`floorBands`) lies on from one end to the other, with it: its deck the
// top of the floor, its piece of the outline up to it. What stands on the floor shades it with the frame under it, and the
// floor is no pale line between them. One the floor is off any of is as it was.
function floored(lines: readonly ChassisStraight[], profile: readonly ChassisPoint[], { tops, bands }: LaidFloor): ChassisStraight[] {
  const index = (p: Point) => profile.findIndex(q => Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9);
  return lines.map(line => {
    let reached = line.a.x;
    for (const { points: [front, rear] } of bands) if (front.x <= reached + 1e-9 && rear.x > reached) reached = rear.x;
    const a = tops[index(line.a)], b = tops[index(line.b)];
    return reached < line.b.x - 1e-9 || !a || !b ? line : { ...line, a, b, piece: [a, b, line.piece[2], line.piece[3]] };
  });
}
// A guard with what its picture is painted for (`key`): its kind and its shape.
const keyed = <Guard extends ChassisGuard>(guard: Guard): Guard & { key: string } => ({ ...guard, key: `${guard.kind}:${guard.kind === 'mudguard' && guard.held?.some(end => end !== null) ? 'rear-stays-v1:' : ''}` + guard.shape.map((v: number) => Math.round(v * 1e4) / 1e4).join(':') });

// Generated frame plates already have the chassis picture: its frame, the plate of its first stretch, tells all of it
// (`profile`). Detached pieces keep their own plate drawing.
export const chassisFrame = <Part extends DrawingFramePart>(parts: readonly Part[]): ChassisFramePart<Part> | undefined => parts.find((part): part is ChassisFramePart<Part> => part.type === 'plate' && Boolean(part.data.definition?.chassis?.profile)
  && part.data.attached !== false && !('detached' in part.data && part.data.detached) && !('fragment' in part.data && part.data.fragment));
// The segment of the profile a piece of the floor plate over a chassis lies on (its `topPlate`, `chassis:top-<segment>`),
// by its definition; `null` for any other plate.
export const floorSegment = (definition: { id?: string } | null | undefined): number | null => { const found = /^chassis:top-(\d+)$/.exec(definition?.id ?? ''); return found ? Number(found[1]) : null; };
// That floor as the picture of the chassis paints it (`floor` of `chassisLayout`), by the parts of its construction: the
// pieces of it still on it, as its frame is, its thickness and its metal; `null` without one. A piece knocked off keeps its
// own plate drawing.
export function chassisFloor<Part extends DrawingFramePart>(parts: readonly Part[]): ChassisFloor | null {
  const pieces = parts.filter((part): part is Extract<Part, { type: 'plate' }> => part.type === 'plate' && floorSegment(part.data.definition) !== null && part.data.attached !== false
    && !('detached' in part.data && part.data.detached) && !('fragment' in part.data && part.data.fragment)).map(part => part.data.definition);
  return pieces.length ? { thicknessMm: pieces[0]!.thicknessMm, metal: pieces[0]!.material, segments: pieces.map(piece => floorSegment(piece)!).sort((i: number, j) => i - j) } : null;
}

// How much of the height of an armoured track its skirt covers: more the thicker the armour, and six tenths at most.
export const skirtCover = (armorMm: number): number => Math.min(.6, .36 + armorMm * .003);
// What a chassis hangs over its running gear, each a picture of its own laid over the gear (`paintGuardCanvas`), by its
// box in the frame of the picture (`x`, `y` its middle, `w`, `h`) and what its picture is drawn by (`shape`):
// - over an armoured track, the skirt: plates in sections bolted along the top of the tub from one end of the track to
//   the other, hung down over its upper run and the tops of its wheels, as far as its armour has it (`skirtCover`),
//   ribbed when they are thick; at either end its foot follows the belt, a little clear of it, round the idler or the
//   sprocket and down the run from it to the last road wheel (the Bradley, the CV90, the Leopard 2). Its outline is
//   `points`. A track without armour has none: its upper run and the rollers it comes back over show (the M60, the
//   BMP-1);
// - over each wheel, or over each group of wheels so close together that their fenders would meet (hull-details.ts
//   `fenderGroups`), its mudguard: a band of steel bent square over the tops of the tyres, clear of them as the wheels
//   rise to their stop (`fenderOver`, `fenderLine`), level from over one end axle to over the other, `half` either way
//   from `axle`, the middle of the two (`axles` are where all of them are along x), down to its foot at the stay bolted
//   to the web of the rail at either end (the HEMTT, the MAN HX, the FMTV; the flares of the JLTV), no lower than the
//   axle and no higher than six tenths of the way to its inner edge (`feet`, back along x, then ahead), and held between
//   each two wheels by a strut up from the rail, as the long fenders over the axles of a heavy truck are held between
//   them. It stands out of neither end of the level run of the rail it is bolted to (`levelRuns`), whether that is an end
//   of the chassis, a gap or a knee, but where its wheels do; there a stay that would be off the end of the rail over a
//   gap or past a knee is bolted to the web at that end, a flat bar out of it up to the foot (`held`, from the axle).
//   It is in front of whatever stands over the wheels, a hull or a body out in the open, whose foot is cut for the well
//   behind it (hull-details.ts, cargo-art.ts `loadArches`); seen cut open, a hull over some of its axles has it hidden,
//   and the wheels under it the hull does not stand over have one of their own (`mudguardsOver`, render.ts).
// The skirt also tells where the shade of what stands on the deck over it falls (`deck`, as `seatShadeGeometry` takes it).
function guards(model: ChassisModelId, track: ChassisTrack | null, sprocketFront: boolean, axles: FenderWheel[], { depth, runs }: { depth: number; runs: ChassisRun[] }): ChassisGuard[] {
  const spec = chassisSpec(model);
  if (spec.kind === 'tracked') {
    if (!track || !(track.armorMm! > 0)) return [];
    // The skirt from the top of the tub, `top` over the middle of the track, down to its foot.
    const { width, height } = track, armorMm = track.armorMm!, at = onTrack(track, sprocketFront), base = track.y, top = -base,
      foot = height / 2 - skirtCover(armorMm) * height, n = Math.max(1, Math.round(width / 1.25)),
      ribbed = armorMm >= 20, points = skirtOutline(width, height, foot, top).map(([u, v]): XY => { const p = at(u, v); return [p.x, p.y]; }),
      x0 = Math.min(...points.map(p => p[0])), x1 = Math.max(...points.map(p => p[0]));
    return [{ kind: 'skirt', x: (x0 + x1) / 2, y: (base + foot) / 2, w: x1 - x0, h: -(base + foot), points,
      cuts: Array.from({ length: n - 1 }, (_, i: number) => (i + 1) * (x1 - x0) / n), ribbed, shape: [x1 - x0, n, ribbed ? 1 : 0, ...points.flat()],
      deck: [{ piece: points, a: { x: x0, y: 0 }, b: { x: x1, y: 0 } }] }];
  }
  return mudguards(axles, depth, runs);
}
// The wheels on `axles` under each level run of a chassis (`runs`), in groups under one fender (hull-details.ts
// `fenderGroups`): a fender is bolted to one run, and never reaches over a gap or a knee to another.
const groupsOn = (runs: readonly ChassisRun[], axles: readonly FenderWheel[]) => runs.flatMap(run => fenderGroups(axles.filter(a => run.from - 1e-6 <= a.x && a.x <= run.to + 1e-6)).map(group => ({ ...group, run })));
// The mudguards over the wheels on `axles` of a wheeled chassis `depth` deep, on its level runs `runs` (`guards`).
function mudguards(axles: readonly FenderWheel[], depth: number, runs: readonly ChassisRun[]): ChassisMudguard[] {
  const stay = -depth / 2;
  return groupsOn(runs, axles).map(({ x, y, r, half, axles: under, run }) => {
    const { inner, outer, round } = fenderOver(r), foot = clamp(stay - y, 0, inner * .6),
      // At an end of its run it would stand out of, its foot is cut higher up its slope, where its outer edge is
      // `ENDS_IN` within that end, and no higher than the most its foot is.
      cut = (room: number) => fenderAcross(outer, foot) > room - ENDS_IN ? clamp(fenderHeight(outer, room - ENDS_IN), foot, inner * .6) : foot,
      feet: [number, number] = [cut(x - half - run.from), cut(run.to - x - half)], plate = stayPlate(outer - inner),
      held = [-1, 1].map((way, i: number) => {
        const end = way < 0 ? run.from : run.to, at = x + way * (half + fenderAcross((inner + outer) / 2, feet[i]!));
        return run.inner[i] && way * (at + way * plate.w / 2 - end) > 0 ? end - x : null;
      }) as [number | null, number | null],
      bottom = Math.min(stay - plate.h / 2, y + foot) - .01, top = y + outer + .01;
    return { kind: 'mudguard', x, y: (top + bottom) / 2, w: 2 * (half + outer) + .02, h: top - bottom, axle: { x, y }, half,
      axles: under.map(a => a.x), r, inner, outer, round, feet, stay, held,
      shape: [r, inner, outer, half, ...feet, stay - y, top - bottom, ...under.map(a => a.x - x), ...held.flatMap((end, i: number) => end === null ? [] : [i, end])] };
  });
}
const ENDS_IN = .005;
// The mudguards a wheeled chassis as laid out (`chassisLayout`) hangs over the wheels on `axles` alone, as it would over
// them were they all it has: seen cut open, over the wheels a hull does not stand over, when it stands over others
// under the same fender (render.ts).
export const mudguardsOver = (layout: Pick<ChassisLayout, 'depth' | 'runs'>, axles: readonly FenderWheel[]) => mudguards(axles, layout.depth, layout.runs).map(keyed);
// The plate of the stay of a mudguard whose band is `band` wide, bolted to the web of the rail.
const stayPlate = (band: number) => ({ w: Math.max(.064, band * .6), h: band * .5 + .05 });

// End stays are bolted to the rail behind the near tyre. Keep their canonical
// paint geometry with the cached chassis picture, also for its ink bounds.
function rearMudguardStays(guard: ChassisGuard): RearMudguardStay[] {
  if (guard.kind !== 'mudguard') return [];
  const band = guard.outer - guard.inner, plate = stayPlate(band), bar = band * .3, stays: RearMudguardStay[] = [];
  for (const [i, way] of [-1, 1].entries()) {
    if (guard.held?.[i] == null) continue;
    const mount = { x: guard.axle.x + guard.held[i]! - way * plate.w / 2, y: guard.stay, ...plate },
      tip = { x: guard.axle.x + way * (guard.half + fenderAcross(guard.inner + band / 2, guard.feet[i]!)), y: guard.axle.y + guard.feet[i]! },
      dx = tip.x - mount.x, dy = tip.y - mount.y, length = Math.hypot(dx, dy), nx = dy / length * bar / 2, ny = -dx / length * bar / 2;
    stays.push({ mount, tip, points: [[mount.x + nx, mount.y + ny], [tip.x + nx, tip.y + ny], [tip.x - nx, tip.y - ny], [mount.x - nx, mount.y - ny]] });
  }
  return stays;
}

// How far clear of the belt the foot of a skirt runs, in metres.
const SKIRT_GAP = .03;
// The outline of the skirt over a track `width` long and `height` high, in the frame of the track: from `top` down to
// `foot` over the whole length of the track, its lower corners where the belt, `SKIRT_GAP` out, rounds the sprocket
// and the idler and runs down from them; above the middles of those it hangs straight. Each point is `[u, v]`.
function skirtOutline(width: number, height: number, foot: number, top: number): XY[] {
  const { end } = beltWheels(width, height), side = width / 2 + SKIRT_GAP,
    belt = trackOutline(width, height, -SKIRT_GAP, 20).filter(p => p.y < end.y - 1e-9);
  // The belt below the middles of its end wheels, closed over them straight up past the top of the skirt: round the way
  // the belt goes, the part ahead of the middle of the track first. Its outermost points, level with those middles,
  // are the corners put in here, so that no edge of it is too short to have a side.
  const right = belt.findLastIndex(p => p.x > 0) + 1, edge = [...belt.slice(0, right),
    { x: side, y: end.y }, { x: side, y: top + 1 }, { x: -side, y: top + 1 }, { x: -side, y: end.y }, ...belt.slice(right)];
  let points: XY[] = [[-width / 2, foot], [width / 2, foot], [width / 2, top], [-width / 2, top]];
  for (let i = 0; i < edge.length; i++) {
    const a = edge[i]!, b = edge[(i + 1) % edge.length]!, side = ([u, v]: XY) => (b.x - a.x) * (v - a.y) - (b.y - a.y) * (u - a.x), kept: XY[] = [];
    for (let j = 0; j < points.length; j++) {
      const p = points[j]!, q = points[(j + 1) % points.length]!, sp = side(p), sq = side(q);
      if (sp >= 0) kept.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); kept.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    points = kept;
  }
  return points;
}
// Things of a pitch along a stretch, the lot in its middle.
const along = (from: number, to: number, pitch: number) => { const n = Math.max(0, Math.floor((to - from) / pitch + 1e-9)), start = from + (to - from - n * pitch) / 2;
  return Array.from({ length: n }, (_, i: number) => start + (i + .5) * pitch); };
const clear = (box: PartBox, others: readonly PartBox[], gap: number) => others.every(o => Math.abs(box.x - o.x) >= (box.w + o.w) / 2 + gap || Math.abs(box.y - o.y) >= (box.h + o.h) / 2 + gap);

// The parts of each straight of the rail (`straights`) are along it as it would lie level from its first point.
function wheeledParts(model: ChassisModelId, lines: readonly ChassisStraight[], runs: readonly ChassisRun[], add: AddPart, axles: readonly number[], dimensions: ChassisDimensions) {
  const { depth } = dimensions, rig = axles.length ? suspensionRig(model, dimensions) : null, fitted: ChassisPart[][] = lines.map(() => []);
  // The plates of the cross members, as tall as the web between its bends: at either end of each part of the rail, and
  // over each axle. A light one's over the axle is the tower its coil spring stands from, and holds its pin.
  const plate = Math.min(.2, depth * .7 + .03), plateH = depth - .03;
  for (const [i, line] of lines.entries())
    for (const x of [!line.ahead && line.a.x + plate / 2 + .02, !line.behind && line.a.x + line.length - plate / 2 - .02])
      if (x !== false) fitted[i]!.push(add('gusset', x, line.a.y - depth / 2, plate, plateH, { bolts: depth >= .22 ? 3 : 2, straight: i }));
  kneePlates(lines, add, fitted, depth, plate, plateH);
  for (const [i, x] of axles.entries()) {
    // The running line is independent of the rail profile: every axle is at the height of the level runs, on the same
    // springs. A level rail adds its local fittings; under a stretch raised or sloping over it, or a gap, each fitting
    // drops from the rail over it to the same pin (`dropped`).
    const axleRig = rig!, run = runAt(runs, x), at = run ? lines.findIndex(line => line.a.x === run.from) : null,
      onRail = at === null ? {} : { straight: at },
      fittedPart = (part: ChassisPart) => { if (at !== null) fitted[at]!.push(part); };
    if (!run) { dropped(axleRig, lines, add, fitted, x, { plate, plateH, depth }); continue; }
    // The tower stands on the web, and reaches under the rail to its pin where the spring would be too long.
    if (axleRig.kind === 'coil') {
      const top = -.015, foot = Math.min(-depth + .005, axleRig.top - .035);
      fittedPart(add('tower', x, (top + foot) / 2, plate, top - foot, { pin: axleRig.top, bolts: 2, axle: i, ...onRail })); continue;
    }
    fittedPart(add('gusset', x, -depth / 2, plate, plateH, { bolts: depth >= .22 ? 3 : 2, ...onRail }));
    // The hangers are bolted to the lower half of the web, and hold the eyes of the spring under it, or on it where the
    // axle stands close under the rail.
    const hangs = { x, y: axleRig.axle };
    for (const [kind, pinX, pin, way] of [['hanger', x - axleRig.span, axleRig.eye, -1], ['shackle', x + axleRig.span, axleRig.eye + axleRig.shackle, 1]] satisfies ['hanger' | 'shackle', number, number, number][]) {
      const top = Math.min(-.02, Math.max(-depth * .52, pin + .05)), foot = Math.min(axleRig.eye, pin) - .034,
        box = run ? held(run, pinX, axleRig.hanger, way) : { x: pinX, w: axleRig.hanger };
      fittedPart(add(kind, box.x, (top + foot) / 2, box.w, top - foot, { pin, eye: axleRig.eye, hangs, ...onRail, ...box.end !== undefined && { end: box.end, pinX, bracket: axleRig.hanger } }));
    }
    const box = run ? held(run, x - .3, .07, -1) : { x: x - .3, w: .07 }, top = Math.min(-.01, axleRig.damper + depth * .2), foot = axleRig.damper - depth * .16;
    fittedPart(add('bracket', box.x, (top + foot) / 2, box.w, top - foot, { pin: axleRig.damper, ...onRail, ...box.end !== undefined && { end: box.end, pinX: x - .3, bracket: .07 } }));
  }
  // The holes in the web, in a row over its middle and over the hangers, and the rivets along both its edges.
  const hole = clamp(depth * .26, .04, .085), wide = hole * 1.5, holeY = -depth * .36;
  for (const [i, line] of lines.entries()) for (const x of along(line.a.x + .05, line.a.x + line.length - .05, wide * 2.4)) {
    const box = { x, y: line.a.y + holeY, w: wide, h: hole };
    if (clear(box, fitted[i]!, .03)) add('hole', x, box.y, wide, hole, { straight: i });
  }
  for (const [i, line] of lines.entries())
    for (const y of [line.a.y - Math.min(.02, depth * .14), line.a.y - depth + Math.min(.02, depth * .14)]) for (const x of along(line.a.x + .03, line.a.x + line.length - .03, .14)) {
      const box = { x, y, w: .014, h: .014 };
      if (clear(box, fitted[i]!, .012)) add('rivet', x, y, .014, .014, { straight: i });
    }
}
// At each knee of a rail or a keel, a plate as tall as theirs over the joint of the two straights, as far along each as a
// cross member's is wide (`plate`): its edges square to each, meeting on the line the two meet on (`knee`), from the
// point to its foot in the outline (`piece`). What else is fitted along either straight keeps clear of it (`fitted`).
function kneePlates(lines: readonly ChassisStraight[], add: AddPart, fitted: PartBox[][], depth: number, plate: number, plateH: number) {
  for (const [i, line] of lines.entries()) if (line.behind) {
    const next = lines[i + 1]!, { point } = line.behind, under = line.piece[2], onLine = (l: ChassisStraight, u: number, v: number) => turned(l, l.a.x + u, l.a.y + v),
      miter = (v: number) => ({ x: point.x + (under.x - point.x) * v / depth, y: point.y + (under.y - point.y) * v / depth }), top = .015, foot = depth - .015,
      points = [onLine(line, line.length - plate, -top), miter(top), onLine(next, plate, -top), onLine(next, plate, -foot), miter(foot), onLine(line, line.length - plate, -foot)],
      rows = depth >= .22 ? 3 : 2, bolts = ([[line, line.length - plate * .5], [next, plate * .5]] satisfies [ChassisStraight, number][])
        .flatMap(([l, u]) => Array.from({ length: rows }, (_, r: number) => onLine(l, u, -top - (foot - top) * (r + .5) / rows))),
      xs = points.map(p => p.x), ys = points.map(p => p.y);
    add('knee', (Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), { points, bolts });
    fitted[i]!.push({ x: line.a.x + line.length - plate / 2, y: line.a.y - depth / 2, w: plate, h: plateH });
    fitted[i + 1]!.push({ x: next.a.x + plate / 2, y: next.a.y - depth / 2, w: plate, h: plateH });
  }
}

// The keel of an aircraft, in place of the ladder rail of a truck: a light built-up beam as the keel beams a light
// helicopter's cabin stands on are (the Bell 206, the H125, the R44), from the side.
// - Its caps, an extruded angle along its top and another along its foot, riveted to its web in a close row each, as deep
//   as `keelCap` (no shallower than the gauge of its frame shows the flanges of a rail).
// - Its web between them lightened by cut-outs in a truss: triangles turned up and down in turn, their edges pressed into
//   a lip, so that what is left of the web runs in diagonals from cap to cap (`bay`); a stiffener, an angle riveted
//   upright on the web, at either end of each run of them and between bays of it no longer than `KEEL_BAY` times its
//   depth (`stiffener`).
// - Each end of each part of it, at an end of the chassis or at a gap, under a fairing: a formed cap of skin in the paint
//   of the vehicle riveted over the end of the beam, its lower corner rounded as `fairing` has it for its straight, so
//   that the outline of the chassis goes round it there (`fairedDecks`).
// - Over each leg of its skids, a doubler riveted to the web (`saddle`), where the saddle of the cross tube under it is
//   bolted (`paintSkids`).
// - At each knee, the plate over the joint a rail has (`kneePlates`).
// Its parts are along each straight as it would lie level from its first point, as a rail's are.
const KEEL_RIVET = .04, KEEL_BAY = 3.2;
const keelCap = (depth: number, thicknessMm: number) => Math.min(depth / 3, Math.max(thicknessMm / 1000 + .004, clamp(depth * .15, .01, .028)));
// The fairing over an end of a straight of a keel: as long as `f` along it, no more than three tenths of it, and its lower
// corner round by `r`.
function fairing(line: ChassisStraight, depth: number) {
  const f = Math.min(depth * 1.3, line.length * .3);
  return { f, r: Math.min(depth * .8, f) };
}
function keelParts(lines: readonly ChassisStraight[], add: AddPart, depth: number, thicknessMm: number, mounts: readonly { x: number; tube: number }[]) {
  const fitted: ChassisPart[][] = lines.map(() => []), cap = keelCap(depth, thicknessMm), web = depth - 2 * cap,
    plate = Math.min(.2, depth * .7 + .03);
  kneePlates(lines, add, fitted, depth, plate, depth - .03);
  for (const [i, line] of lines.entries()) for (const end of ['front', 'rear'] as const) if (!line[end === 'front' ? 'ahead' : 'behind']) {
    const { f, r } = fairing(line, depth), x = end === 'front' ? line.a.x + f / 2 : line.a.x + line.length - f / 2;
    fitted[i]!.push(add('fairing', x, line.a.y - depth / 2, f, depth, { end, r, straight: i }));
  }
  for (const { x, tube } of mounts) {
    const i = lines.findIndex(line => line.a.x - 1e-6 <= x && x <= line.b.x + 1e-6), line = lines[i];
    if (line) fitted[i]!.push(add('saddle', line.a.x + (x - line.a.x) / Math.cos(line.angle || 0), line.a.y - depth / 2,
      Math.max(.07, tube * 2.8), web, { straight: i }));
  }
  // The runs of web between what is fitted on it, each squared off by its stiffeners, with more between bays of it no
  // longer than `KEEL_BAY` times its depth, and each bay lightened from stiffener to stiffener (`lo`, `hi`, their faces).
  const stiff = Math.max(.012, depth * .11), margin = Math.max(.004, web * .12), high = web - 2 * margin, base = high * 1.25,
    strut = Math.max(.01, high * .3), corner = Math.min(.01, high * .14), most = Math.max(.5, depth * KEEL_BAY);
  const bays = (i: number, line: ChassisStraight, lo: number, hi: number) => {
    const room = hi - lo - 2 * strut;
    if (high < .03 || room < base) return;
    const n = Math.floor((room - base) / (base / 2 + strut) + 1e-9) + 1, used = base + (n - 1) * (base / 2 + strut),
      top = line.a.y - cap - margin, foot = top - high;
    for (let k = 0; k < n; k++) {
      const u = lo + strut + (room - used) / 2 + k * (base / 2 + strut), up = k % 2 === 1;
      add('bay', u + base / 2, foot + high / 2, base, high, { straight: i, up, corner,
        points: up ? [[u, foot], [u + base / 2, top], [u + base, foot]] : [[u, top], [u + base, top], [u + base / 2, foot]] });
    }
  };
  for (const [i, line] of lines.entries()) {
    const taken = fitted[i]!.map((box): [number, number] => [box.x - box.w / 2 - .01, box.x + box.w / 2 + .01]).sort((p, q) => p[0] - q[0]), runs: [number, number][] = [];
    let from = line.a.x;
    for (const [lo, hi] of taken) { if (lo > from) runs.push([from, lo]); from = Math.max(from, hi); }
    if (line.a.x + line.length > from) runs.push([from, line.a.x + line.length]);
    for (const [first, last] of runs) {
      if (last - first < 2 * stiff + .02) continue;
      const count = Math.max(1, Math.round((last - first - stiff) / most)),
        centres = Array.from({ length: count + 1 }, (_, j) => first + stiff / 2 + (last - first - stiff) * j / count);
      for (const x of centres) add('stiffener', x, line.a.y - depth / 2, stiff, web, { straight: i });
      for (let j = 0; j < count; j++) bays(i, line, centres[j]! + stiff / 2, centres[j + 1]! - stiff / 2);
    }
    // A close row of rivets along each cap, on over the doublers between them, but where a fairing or a knee plate is.
    const over = fitted[i]!.filter(box => box.kind !== 'saddle');
    for (const y of [line.a.y - cap / 2, line.a.y - depth + cap / 2]) for (const x of along(line.a.x + .02, line.a.x + line.length - .02, KEEL_RIVET)) {
      const box = { x, y, w: .01, h: .01 };
      if (clear(box, over, .006)) add('rivet', x, y, .01, .01, { straight: i });
    }
  }
}
// The outlines of the parts of a keel between gaps (`decks` of a layout, with its floor on them) and the pieces of its
// straights (`shades`, as `floored` gives them), with the lower corner of each end of each part round as its fairing is
// (`fairing`): what outlines the chassis, previews it and takes the shade of what stands on it follows the picture
// round there, and its deck stays as it is. The corners of the pieces stay in order: a piece is still convex.
function fairedCorner(line: ChassisStraight, depth: number, end: 'front' | 'rear') {
  const { r } = fairing(line, depth), bottom = line.a.y - depth, front = end === 'front',
    cx = front ? line.a.x + r : line.a.x + line.length - r, from = front ? -Math.PI / 2 : 0;
  return Array.from({ length: 9 }, (_, k: number) => {
    const angle = from - Math.PI / 2 * k / 8, p = turned(line, cx + r * Math.cos(angle), bottom + r + r * Math.sin(angle));
    return { x: Math.round(p.x * 1e5) / 1e5, y: Math.round(p.y * 1e5) / 1e5 };
  });
}
function fairedDecks(decks: readonly (readonly Point[])[], outlines: readonly (readonly Point[])[], lines: readonly ChassisStraight[], depth: number) {
  return decks.map((deck, part) => {
    const n = outlines[part]!.length / 2, own = lines.filter(line => line.part === part), head = deck.slice(0, deck.length - n), foot = deck.slice(deck.length - n);
    return [...head, ...fairedCorner(own.at(-1)!, depth, 'rear'), ...foot.slice(1, -1), ...fairedCorner(own[0]!, depth, 'front')];
  });
}
function fairedPieces(shades: readonly ChassisStraight[], lines: readonly ChassisStraight[], depth: number): ChassisShade[] {
  return shades.map((shade, i: number) => {
    const line = lines[i]!, [a, b, rear, front] = shade.piece;
    return line.ahead && line.behind ? shade : { ...shade, piece: [a, b, ...line.behind ? [rear] : fairedCorner(line, depth, 'rear'),
      ...line.ahead ? [front] : fairedCorner(line, depth, 'front')] };
  });
}
// The skids of an aircraft (`chassisLayout`), in the frame of the picture and in none of its straights: the runner, its
// box from its foot to the top of its toe, and each leg from the foot of the keel to the top of the runner, the cross
// tube it is the bent end of in a saddle under the keel at its top. Where along the chassis the legs are and how thick
// their tubes are, for the doublers of their saddles on the keel. The toe is bent up as far as `SKID_TOE` for a runner of
// the model's size (`SKID_TUBE`), and as much further or nearer as its tube is larger or slimmer: it is no longer than a
// leg stands in from that end at the nearest (chassis.ts `SKID_END`).
const SKID_TOE = .18, SKID_TOE_TURN = 70 * Math.PI / 180;
function skidParts({ front, rear, y, tube, legs }: ChassisSkids, add: AddPart) {
  const toe = SKID_TOE * tube / SKID_TUBE, rise = toe * (1 - Math.cos(SKID_TOE_TURN)), bottom = y - tube / 2, top = y + tube / 2 + rise;
  add('skid', (front + rear) / 2, (bottom + top) / 2, rear - front, top - bottom, { front, rear, runner: y, tube, toe });
  for (const leg of legs) add('leg', leg.x, (leg.top + leg.foot) / 2, tube * 1.1, leg.top - leg.foot, { top: leg.top, foot: leg.foot, tube });
  return legs.map(leg => ({ x: leg.x, tube }));
}
// A point of a straight of a chassis (`straights`), as it would lie level from its first point, where it is in the frame of
// the picture.
function turned(line: ChassisStraight, x: number, y: number): Point {
  const c = Math.cos(line.angle), s = Math.sin(line.angle), dx = x - line.a.x, dy = y - line.a.y;
  return { x: line.a.x + dx * c - dy * s, y: line.a.y + dx * s + dy * c };
}
// Where a piece of the springs of an axle (`wheeledParts`), `w` wide with its pin at `x`, goes: there, or where that would
// be off the end of the level run of the rail the axle is under (`run`, `levelRuns`) on the way `way` (-1 ahead, 1 behind)
// over a gap or past a knee, held to that end of it (`end`): a plate bolted to the end of the web and an arm out of it
// under the pin. Its box takes both.
function held(run: ChassisRun, x: number, w: number, way: number): { x: number; w: number; end?: number } {
  const end = way < 0 ? run.from : run.to;
  if (!run.inner[way < 0 ? 0 : 1] || (way < 0 ? x - w / 2 >= end : x + w / 2 <= end)) return { x, w };
  const lo = way < 0 ? x - w / 2 : end - w, hi = way < 0 ? end + w : x + w / 2;
  return { x: (lo + hi) / 2, w: hi - lo, end };
}

// The line `k` of the depth of the rail down from its top (0 its top, 1 its foot), as the outline of each straight has it,
// where it passes over `x` along the chassis: its height there, the straight it is of and how far along the chassis that
// line runs (`from`, `to`); none over a gap or beyond the ends of the chassis.
function webAt(lines: readonly ChassisStraight[], x: number, k: number) {
  for (const [straight, { piece: [a, b, footB, footA] }] of lines.entries()) {
    const from = a.x + (footA.x - a.x) * k, to = b.x + (footB.x - b.x) * k;
    if (x < from - 1e-9 || x > to + 1e-9) continue;
    const y0 = a.y + (footA.y - a.y) * k, y1 = b.y + (footB.y - b.y) * k;
    return { y: y0 + (y1 - y0) * (x - from) / (to - from || 1), straight, from, to };
  }
  return null;
}
// Where the straight `line` has, as it would lie level from its first point (`turned`), a point of the picture.
function unturned(line: ChassisStraight, x: number, y: number): Point {
  const c = Math.cos(line.angle), s = Math.sin(line.angle), dx = x - line.a.x, dy = y - line.a.y;
  return { x: line.a.x + dx * c + dy * s, y: line.a.y - dx * s + dy * c };
}
// What holds the springs of an axle that no level run of the rail is over (`wheeledParts`): its springs, its damper and
// its axle are where they would be under a level run, and each fitting that holds them drops to its pin from the web of
// the rail over the pin, a plate bolted along the lower half of the web, as it slopes, and a leg straight down from it.
// One whose pin is over no rail — over a gap, or past an end — is bolted to the end of the rail between it and its
// axle, and its leg reaches out to the pin; one with no rail on its way to its axle, under a gap, to the line of the
// deck, where what is carried over the gap stands. Over the axle a cross member's plate on the rail, as on a level run.
function dropped(rig: SuspensionRig, lines: readonly ChassisStraight[], add: AddPart, fitted: PartBox[][], x: number, { plate, plateH, depth }: { plate: number; plateH: number; depth: number }) {
  const hangs = { x, y: rig.axle }, over = webAt(lines, x, .5);
  if (over) {
    const line = lines[over.straight]!, at = unturned(line, x, over.y);
    fitted[over.straight]!.push(add('gusset', at.x, line.a.y - depth / 2, plate, plateH, { bolts: depth >= .22 ? 3 : 2, straight: over.straight }));
  }
  const pieces: [DroppedKind, number, number, number][] = rig.kind === 'coil' ? [['tower', x, rig.top, plate * .8]]
    : [['hanger', x - rig.span, rig.eye, rig.hanger], ['shackle', x + rig.span, rig.eye + rig.shackle, rig.hanger], ['bracket', x - .3, rig.damper, .07]];
  for (const [kind, pinX, pin, w] of pieces) {
    // Where its plate is along the chassis: over its pin, within the web it is on, or at the end of the web towards the
    // axle; as near the top of the web as the pin needs, when the pin is high on the web itself.
    const toward = Math.sign(x - pinX) || 1, near = (k: number, u: number) => webAt(lines, u, k);
    let middle = pinX, web = near(.75, pinX);
    for (let u = pinX + toward * .01; !web && toward * (x - u) >= 0; u += toward * .01) if (near(.75, u)) { web = near(.75, u); middle = u; }
    if (web) middle = clamp(middle, web.from + w / 2, web.to - w / 2);
    const left = middle - w / 2, right = middle + w / 2, edge = (k: number, bare: number): XY[] => {
      if (!web) return [[left, bare], [right, bare]];
      const xs = [left, ...lines.flatMap(({ piece: [, b, footB] }) => { const u = b.x + (footB.x - b.x) * k; return u > left && u < right ? [u] : []; }), right];
      return xs.map((u: number): XY => [u, (near(k, u) ?? web)!.y]);
    };
    const high = web && near(0, pinX), deep = web && near(1, pinX), wanted = high && deep ? (high.y - pin) / Math.max(1e-6, high.y - deep.y) : 1,
      kTop = clamp(Math.min(.52, wanted - .14), .06, .52), top = edge(kTop, 0), low = edge(.92, -depth * .44),
      foot = Math.min(pin - .026, ...low.map(p => p[1]), kind === 'shackle' ? rig.eye! - .02 : Infinity),
      xs = [left, right, pinX - w * .25, pinX + w * .25], ys = [...top.map(p => p[1]), foot],
      bolts = [left + w * .22, right - w * .22].map((u: number): XY => {
        const a = top.reduce((best, p) => Math.abs(p[0] - u) < Math.abs(best[0] - u) ? p : best), b = low.reduce((best, p) => Math.abs(p[0] - u) < Math.abs(best[0] - u) ? p : best);
        return [u, a[1] + (b[1] - a[1]) * .4];
      }),
      part = add(kind, (Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
        { upright: true, pinX, pin, hangs, top, low, bolts, ...(kind === 'shackle' && { eye: rig.eye! }), ...(web && { straight: web.straight }) });
    if (web) {
      const line = lines[web.straight]!, at = unturned(line, middle, (top[0]![1] + low[0]![1]) / 2);
      fitted[web.straight]!.push({ x: at.x, y: line.a.y - depth * (kTop + .92) / 2, w: w + .02, h: depth * (.92 - kTop) });
    }
    if (part.straight === undefined) delete part.straight;
  }
}

// The parts of each straight of the tub (`straights`) are along it as it would lie level from its first point; its nose
// is at the front of the first, its rear plate at the rear of the last.
function trackedParts(_model: ChassisModelId, lines: readonly ChassisStraight[], track: ChassisTrack | null, sprocketFront: boolean, add: AddPart, { depth }: { depth: number }) {
  const D = depth, scale = track ? track.height / .74 : 1, first = lines[0]!, last = lines.at(-1)!, end = lines.length - 1;
  // The bolts of the deck along the top of the side, from the nose to the rear plate, and those of the rear plate.
  for (const [i, line] of lines.entries())
    for (const x of along(line.a.x + (line === first ? Math.min(D, .06) + .12 : .1), line.a.x + line.length - .1, .24)) add('bolt', x, line.a.y - .048, .018, .018, { straight: i });
  for (const y of along(-D + .07, -.1, .14)) add('bolt', last.a.x + last.length - .05, last.a.y + y, .018, .018, { straight: end });
  // A towing lug welded on the nose low down, and one at the foot of the rear plate.
  add('lug', first.a.x + D * .72 + .07, first.a.y - D * .72 + .02, .12, .1, { straight: 0 });
  add('lug', last.a.x + last.length - .1, last.a.y - D + .08, .12, .1, { straight: end });
  // A track the chassis holds rides on its springs against it, and its own picture is the side of the hull behind its
  // wheels as it goes (gear-art.ts, its bed): what the wheels are mounted by is under it, and would stand out from under
  // its belt as the hull pitches over it. They show where the track is gone.
  if (!track || track.held) return;
  for (const wheel of trackWheels(track, sprocketFront)) {
    const hangs = { x: wheel.x, y: wheel.y };
    // The arm of a road wheel turns in the belly of the tub, however high the tub stands over its wheels.
    if (wheel.role === 'road') { const r = .05 * scale; add('boss', wheel.pivot.x, Math.max(wheel.pivot.y, r + .01 - D), 2 * r, 2 * r, { hangs }); continue; }
    if (wheel.role === 'sprocket') { const r = track.height * (TRACK_WHEEL - TRACK_BELT); add('drive', wheel.x, wheel.y, 2 * r, 2 * r, { hangs }); continue; }
    // The crank of the idler turns on a pivot towards the middle of the chassis, and the screw that tensions the belt
    // pushes it out towards the end from a bracket further in, where the track has them (running-gear.ts `idlerMounts`).
    const size = track.height, at = onTrack(track, sprocketFront), mounts = idlerMounts(track.width, track.height),
      pivot = at(mounts.pivot.x, mounts.pivot.y), brace = at(mounts.anchor.x, mounts.anchor.y), xs = [wheel.x, pivot.x, brace.x], ys = [wheel.y, pivot.y, brace.y],
      x0 = Math.min(...xs) - size * .16, x1 = Math.max(...xs) + size * .16, y0 = Math.min(...ys) - size * .16, y1 = Math.max(...ys) + size * .09;
    add('idler', (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, { hub: { x: wheel.x, y: wheel.y }, pivot, brace, size, hangs });
  }
}

// Where the picture of a chassis stands: the front end of its frame at the height of its deck (`origin`), `along` the way
// from its front to its rear and `up` the way its hull stands up, each a unit vector. Told by the pose of its frame
// (`pose`, of the plate `chassisFrame` finds, as the frame plate `chassis` tells its points), the plate of its first
// stretch, which runs from the rear of that stretch to its front, half its thickness under its points, and the angle of
// the hull (`hullAngle`): a vehicle that faces right is a mirror of one that faces left, and its plates look up the other
// way. `mirrored` says so.
export function chassisPlacement(pose: Pose & { definition: { length: number; thicknessMm: number } }, chassis: { profile: readonly ChassisPoint[] }, hullAngle = 0): ChassisPlacement {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle), ahead = { x: c, y: s }, normal = { x: -s, y: c },
    looks = normal.x * -Math.sin(hullAngle) + normal.y * Math.cos(hullAngle) < 0 ? -1 : 1, side = { x: normal.x * looks, y: normal.y * looks },
    { length, thicknessMm } = pose.definition, half = length / 2, t = thicknessMm / 2000,
    // The stretch rises `slope` from its front to its rear: the frame of the picture is turned back from the plate by that.
    [p, q] = chassis.profile, slope = Math.atan2(q!.y - p!.y, q!.x - p!.x), k = Math.cos(slope), m = Math.sin(slope),
    along = { x: -ahead.x * k - side.x * m, y: -ahead.y * k - side.y * m }, up = { x: -ahead.x * m + side.x * k, y: -ahead.y * m + side.y * k },
    // The first point is half the thickness of the plate over the front end of its middle, square to it: the outline
    // ends square to its stretch there (game_chassis.rs `under_point`).
    front = { x: pose.x + ahead.x * half + side.x * t, y: pose.y + ahead.y * half + side.y * t };
  return { origin: { x: front.x - up.x * p!.y - along.x * p!.x, y: front.y - up.y * p!.y - along.y * p!.x }, along, up, mirrored: looks > 0 };
}
// A point of the frame of the picture where the world has it, and a point of the world in that frame.
export const chassisPoint = ({ origin, along, up }: ChassisPlacement, x: number, y: number) => ({ x: origin.x + along.x * x + up.x * y, y: origin.y + along.y * x + up.y * y });
// The outline of each part of a chassis between gaps where the world has it (`placement`, `chassisPlacement`), as its
// frame plate tells it (`chassis.outlines`, in the frame of its picture): what its picture fills, mitred at each knee.
export const chassisOutlineAt = (placement: ChassisPlacement, { outlines }: { outlines: readonly (readonly Point[])[] }) => outlines.map(outline => outline.map(p => chassisPoint(placement, p.x, p.y)));
export function chassisLocal({ origin, along, up }: ChassisPlacement, point: Point): Point {
  const dx = point.x - origin.x, dy = point.y - origin.y;
  return { x: dx * along.x + dy * along.y, y: dx * up.x + dy * up.y };
}
// Where the track of a chassis (`chassis`, as its frame plate tells it, placed by `placement`) would stand as it was
// built, in the frame of the track as it stands now (`pose`, where the world has it): the origin of that frame and its
// turn. The core carries the track up and down on its springs under the hull; its sprocket, its idler and its upper
// run stay where the hull holds them (running-gear.ts `trackGear`).
export function heldTrack(placement: ChassisPlacement, chassis: { track: { front: number; rear: number; y: number } }, pose: Pose & { mirrored?: boolean | undefined }) {
  const { track } = chassis, way = placement.mirrored ? -1 : 1,
    origin = chassisPoint(placement, (track.front + track.rear) / 2, track.y),
    c = Math.cos(pose.angle), s = Math.sin(pose.angle), dx = origin.x - pose.x, dy = origin.y - pose.y,
    turn = Math.atan2(way * placement.along.y, way * placement.along.x) - pose.angle, mirror = pose.mirrored ? -1 : 1;
  return { x: mirror * (c * dx + s * dy), y: -s * dx + c * dy, angle: mirror * (turn - TAU * Math.round(turn / TAU)) };
}

// Where hulls and bodies out in the open stand on the deck of a chassis (placed by `placement`, laid out as `layout`): of
// their feet (`feet`, each the two ends of one, where the world has them), what of each lies along a straight of its deck
// (`straights`), within `SEATED` of it at either end, as the stretches along it from its front end they stand on, joined
// where they touch, to the centimetre. What was told before (`kept`) is kept while each end stays within a centimetre of
// it, for nothing to be laid out anew for the jitter of a frame. On a chassis with a floor plate (`floor` of its layout),
// what stands on the floor stands on the deck.
const SEATED = .05;
// The height of the deck of a straight (`straights`) at `x` along the chassis, as far as its line goes either way.
const deckAt = ({ a, b }: { a: Point; b: Point }, x: number) => a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
export function chassisSeats(placement: ChassisPlacement, layout: Pick<ChassisLayout, 'floor' | 'straights'>, feet: readonly (readonly [Point, Point])[], kept: [number, number][] = []): [number, number][] {
  const spans: [number, number][] = [], lift = (layout.floor?.thicknessMm ?? 0) / 1000;
  for (const [p, q] of feet) {
    const a = chassisLocal(placement, p), b = chassisLocal(placement, q), height = (x: number) => a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
    for (const line of layout.straights) {
      const x0 = clamp(Math.min(a.x, b.x), line.a.x, line.b.x), x1 = clamp(Math.max(a.x, b.x), line.a.x, line.b.x),
        on = (x: number) => [0, lift / Math.cos(line.angle)].some(up => Math.abs(height(x) - deckAt(line, x) - up) <= SEATED);
      if (x1 - x0 > .02 && [x0, x1].every(on)) spans.push([x0, x1]);
    }
  }
  const joined: [number, number][] = [];
  for (const span of spans.sort((s, t) => s[0] - t[0])) {
    const last = joined.at(-1);
    if (last && span[0] <= last[1] + .02) last[1] = Math.max(last[1], span[1]); else joined.push(span);
  }
  if (joined.length === kept.length && joined.every((span, i: number) => span.every((x: number, k: number) => Math.abs(x - kept[i]![k]!) <= .01))) return kept;
  return joined.map(span => span.map((x: number) => Math.round(x * 100) / 100) as [number, number]);
}
// The outlines of a chassis for the light along its deck (silhouette.ts `upwardRuns`), one for each part of it between
// gaps, with its floor on it (`decks`): its deck, or the top of its floor, broken where something stands on it (`seats`),
// and a box over each such stretch of each straight, along it, which leaves the light out there. The top of a part runs
// from its front to its rear, and its foot back: only its top is broken.
export function deckGlint(layout: Pick<ChassisLayout, 'floor' | 'straights' | 'decks'>, seats: readonly XY[]) {
  const cuts = seats.flat().sort((p, q) => p - q), lift = (layout.floor?.thicknessMm ?? 0) / 1000;
  return { outlines: layout.decks.map(outline => outline.flatMap((p, k: number) => {
    const next = outline[k + 1];
    return next && next.x > p.x + 1e-3 ? [p, ...cuts.filter((x: number) => x > p.x + 1e-3 && x < next.x - 1e-3).map((x: number) => ({ x, y: deckAt({ a: p, b: next }, x) }))] : [p];
  })),
  others: seats.flatMap(([from, to]) => layout.straights.filter(line => line.a.x < to && line.b.x > from).map(line => {
    const x0 = Math.max(from, line.a.x), x1 = Math.min(to, line.b.x), y0 = deckAt(line, x0), y1 = deckAt(line, x1), up = .1 + lift / Math.cos(line.angle);
    return [{ x: x0, y: y0 - .01 }, { x: x1, y: y1 - .01 }, { x: x1, y: y1 + up }, { x: x0, y: y0 + up }];
  })) };
}
// The shade under the foot of what stands on a deck, down a picture from its top: dark right under the foot, gone by its
// foot. One picture for every stretch of every deck, stretched over it (render.ts).
export function createSeatShade() {
  const c = canvas(4, 64), ctx = context2d(c), g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(6,10,8,.86)'); g.addColorStop(.1, 'rgba(6,10,8,.68)'); g.addColorStop(.42, 'rgba(6,10,8,.3)'); g.addColorStop(1, 'rgba(6,10,8,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 64);
  return pieceTexture(c);
}
// Where that shade lies: over each stretch (`seats`), `depth` down from the deck, but only on what it falls on — each
// piece of a straight of the chassis, whose sloped nose falls away under the front of its deck, or a skirt (`pieces`:
// each its outline, convex, in the frame of the picture, as points or as pairs, and the line of the deck over it from
// `a` to `b`, as the `straights` of a layout and the `deck` of a skirt have them) — and never on the air beside it.
// Over a straight that slopes it lies along the slope. One mesh for all the stretches: its corners, where each is down
// the picture of the shade, and its triangles.
export function seatShadeGeometry(seats: readonly XY[], depth: number, pieces: readonly ChassisShade[]) {
  const positions = [], uvs = [], indices = [];
  for (const { piece: outline, a: from, b: to } of pieces) {
    const corners = outline.map(p => isPair(p) ? { x: p[0], y: p[1] } : p), deck = (x: number) => deckAt({ a: from, b: to }, x),
      wound = Math.sign(corners.reduce((sum, a, i: number) => { const b = corners[(i + 1) % corners.length]!; return sum + a.x * b.y - a.y * b.x; }, 0));
    for (const [x0, x1] of seats) {
      let piece = [{ x: x0, y: deck(x0) }, { x: x1, y: deck(x1) }, { x: x1, y: deck(x1) - depth }, { x: x0, y: deck(x0) - depth }];
      for (let i = 0; i < corners.length && piece.length; i++) {
        const a = corners[i]!, b = corners[(i + 1) % corners.length]!, side = (p: Point) => wound * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)), kept: Point[] = [];
        for (let j = 0; j < piece.length; j++) {
          const p = piece[j]!, q = piece[(j + 1) % piece.length]!, sp = side(p), sq = side(q);
          if (sp >= 0) kept.push(p);
          if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); kept.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
        }
        piece = kept.length > 2 ? kept : [];
      }
      const start = positions.length / 2;
      for (const p of piece) { positions.push(p.x, p.y); uvs.push(.5, clamp((deck(p.x) - p.y) / depth, 0, 1)); }
      for (let i = 1; i + 1 < piece.length; i++) indices.push(start, start + i, start + i + 1);
    }
  }
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}
function isPair(point: Point | XY): point is XY { return Array.isArray(point); }

// The picture of a chassis: its layout, its paint, and the key it is told apart by. It holds the outline of each part of
// it and all that is drawn on it.
export function chassisArtwork(layout: ChassisLayout, paint: number): ChassisArtwork {
  const boxes = layout.parts.map(part => extent(layout.straights, part)), xs = layout.outlines.flat().map(p => Math.round(p.x * 1e4) / 1e4),
    rearStays = layout.guards.flatMap(rearMudguardStays), ink = rearStays.flatMap(({ points, mount: m }): XY[] =>
      [...points, [m.x - m.w / 2, m.y - m.h / 2], [m.x + m.w / 2, m.y + m.h / 2]]);
  let left = Math.min(0, ...xs, ...boxes.map(box => box.left)) - .005, right = Math.max(layout.length, ...xs, ...boxes.map(box => box.right)) + .005,
    top = layout.top, bottom = layout.bottom;
  if (ink.length) {
    const x0 = Math.min(...ink.map(p => p[0])), x1 = Math.max(...ink.map(p => p[0])), y0 = Math.min(...ink.map(p => p[1])), y1 = Math.max(...ink.map(p => p[1])),
      // Four reserved pixels allow two on either side after the box grows.
      pixel = Math.max(1 / DENSITY, (Math.max(right, x1) - Math.min(left, x0)) / (LONGEST - 4), (Math.max(top, y1) - Math.min(bottom, y0)) / (TALLEST - 4)), pad = 2 * pixel;
    left = Math.min(left, x0 - pad); right = Math.max(right, x1 + pad);
    top = Math.max(top, y1 + pad); bottom = Math.min(bottom, y0 - pad);
  }
  return { left, top, width: right - left, height: top - bottom, layout, rearStays,
    key: `chassis:${layout.key}:${paint}${rearStays.length ? ':rear-stays-v1' : ''}` };
}
// The marks of the plates of a chassis on its picture (as hull-art.ts lays those of a hull, for `paintHullImpacts`):
// each mark is where the world has it, its radius, its kind, how strongly it was struck and the angle of its plate,
// and is laid in the frame of the picture, a little within the edge of its plate.
export function chassisImpactLayout(placement: ChassisPlacement, shape: ChassisArtwork, marks: readonly ChassisImpactMark[]) {
  const turn = Math.atan2(placement.along.y, placement.along.x), middle = { x: shape.layout.length / 2, y: (shape.layout.top + shape.layout.bottom) / 2 },
    impacts = marks.map(mark => {
      const at = chassisLocal(placement, mark), dx = middle.x - at.x, dy = middle.y - at.y, far = Math.hypot(dx, dy) || 1, inward = mark.radius * .65;
      return { x: at.x + dx / far * inward - shape.left, y: shape.top - (at.y + dy / far * inward), radius: mark.radius,
        angle: (placement.mirrored ? 1 : -1) * (mark.angle - turn), kind: ['hole', 'burn', 'ricochet'].includes(mark.kind) ? mark.kind : 'dent',
        variant: Math.abs(Math.round(mark.u * 91471 + mark.v * 81797)) % 4, opacity: clamp(.42 + Math.sqrt(clamp(mark.strength ?? 1, 0, 3)) * .16, .42, .76) };
    });
  const fixed = (value: number, precision: number) => (Math.round(value * 10 ** precision) / 10 ** precision).toFixed(precision);
  return { impacts, revision: impacts.map(mark => [mark.kind, mark.variant, fixed(mark.x, 4), fixed(mark.y, 4), fixed(mark.angle, 4),
    fixed(mark.radius, 5), fixed(mark.opacity, 3)].join(':')).join(';') };
}

// As fine as a close look at the vehicle needs, within what a texture may hold, and shrunk smoothly from afar.
const DENSITY = 240, LONGEST = 2048, TALLEST = 512;
function chassisCanvasSize({ width, height }: { width: number; height: number }): [number, number] {
  const perMetre = Math.min(DENSITY, LONGEST / width, TALLEST / height);
  return [Math.max(8, Math.ceil(width * perMetre)), Math.max(8, Math.ceil(height * perMetre))];
}
export function paintChassisCanvas(shape: ChassisArtwork, paint: number, surface?: Float32Array | null, weathering?: WeatheringMaps | null): ArtCanvas {
  const c = canvas(...chassisCanvasSize(shape));
  paintChassis(context2d(c), shape, paint, weathering);
  if (surface) paintSurfaceMetres(context2d(c), surface, shape);
  return c;
}
function paintChassis(ctx: ArtContext, shape: ChassisArtwork, paint: number, weathering: WeatheringMaps | null | undefined) {
  const sx = ctx.canvas.width / shape.width, sy = ctx.canvas.height / shape.height, hex = '#' + paint.toString(16).padStart(6, '0');
  ctx.save(); ctx.scale(sx, sy);
  // Painted in metres, down from the top of the picture: a place of the frame of the chassis is (x - left, top - y).
  const layout = shape.layout, a = Object.assign(kit(ctx, Math.min(sx, sy)), { weathering, material: layout.metal }),
    at: Project = (x: number, y: number) => [x - shape.left, shape.top - y];
  const painters: Partial<Record<ChassisModelId, typeof paintRail>> = { tracked: paintTub, aircraft: paintKeel };
  (painters[layout.kind] ?? paintRail)(a, layout, at, hex, new Random(4919), shape.rearStays);
  if (layout.kind === 'aircraft') paintSkids(a, layout, at, hex);
  if (layout.floor) paintFloor(a, layout, at, hex);
  ctx.restore();
}
// The floor plate over the frame (`floor` of a layout, `floorBands`), seen on its edge along the side of the vehicle: a
// strip of plate along each piece of it, as thick as it is, in the paint of the vehicle a shade darker than its body, and
// the shade under it where it lies on the top flange of the rail (or on the deck of the tub). The light along its top is
// the light along the deck (`deckGlint`), out where nothing stands on it; where something does, the floor is in its shade
// with the frame (`shades`). What stands on it stands on a plate, and the plate on the frame, with nothing between.
function paintFloor(a: ChassisKit, layout: ChassisLayout, at: Project, paint: string) {
  const { bands, thicknessMm, metal } = layout.floor!, t = thicknessMm / 1000, bare = '#' + MATERIALS[metal].color.toString(16).padStart(6, '0'),
    contact = Math.max(a.hair(1), .004), fall = Math.max(a.hair(3), .025);
  for (const { points } of bands) {
    const [front, rear, high, low] = points.map(p => at(p.x, p.y)) as [ReturnType<Project>, ReturnType<Project>, ReturnType<Project>, ReturnType<Project>], ys = [front, rear, high, low].map(p => p[1]),
      top = Math.min(...ys), foot = Math.max(...ys), xs = [front, rear, high, low].map(p => p[0]), left = Math.min(...xs),
      // Down the picture, square to the deck under it.
      dx = rear[0] - front[0], dy = rear[1] - front[1], l = Math.hypot(dx, dy), down: XY = [-dy / l, dx / l];
    // Its shade on the frame it lies on, which stands back under its edge: dark along the flange, gone a little down the web.
    a.shape([front, rear, [rear[0] + down[0] * fall, rear[1] + down[1] * fall], [front[0] + down[0] * fall, front[1] + down[1] * fall]]);
    a.fill(a.gradient(front[0], front[1], front[0] + down[0] * fall, front[1] + down[1] * fall, [[0, '#0b130e8c'], [.3, '#0b130e40'], [1, '#0b130e00']]));
    a.line(front[0], front[1] + contact / 2, rear[0], rear[1] + contact / 2, '#0b130e8c', contact);
    a.shape([front, rear, high, low]);
    a.fill(a.gradient(0, top, 0, foot, [[0, shade(paint, -.1)], [1, shade(paint, -.3)]]));
    if (t < .02) continue;
    finishPath(a, { x: left, y: top, width: Math.max(...xs) - left, height: foot - top }, { chips: .1, rust: .04, dirt: .14 });
    // Its cut ends, a shade in the metal under the paint, and its foot a line darker.
    for (const [deck, edge] of [[front, low], [rear, high]] as const) a.line(deck[0], deck[1], edge[0], edge[1], shade(bare, -.3) + 'a0', Math.max(a.hair(1), .003));
    a.line(front[0], front[1] - .0015, rear[0], rear[1] - .0015, '#0b130e70', Math.max(a.hair(1), .003));
  }
}
// The picture of a guard of the layout of a chassis, as large as its box, in the paint `paint` (a number): painted once
// for its shape and its paint, wherever it hangs.
export function paintGuardCanvas(guard: ChassisGuard, paint: number, surface?: Float32Array | null, weathering?: WeatheringMaps | null, material: MaterialId | MetalId = 'steel'): ArtCanvas {
  const c = canvas(...chassisCanvasSize({ width: guard.w, height: guard.h })), ctx = context2d(c),
    sx = c.width / guard.w, sy = c.height / guard.h, left = guard.x - guard.w / 2, top = guard.y + guard.h / 2;
  ctx.scale(sx, sy);
  // In metres down from the top of its box, as the picture of the chassis is.
  const a = Object.assign(kit(ctx, Math.min(sx, sy)), { weathering, material }), at: Project = (x: number, y: number) => [x - left, top - y];
  guard.kind === 'skirt' ? paintSkirt(a, guard, at, '#' + paint.toString(16).padStart(6, '0')) : paintMudguard(a, guard, at, '#' + paint.toString(16).padStart(6, '0'));
  if (surface) paintSurfaceMetres(ctx, surface, { width: guard.w, height: guard.h });
  return c;
}

const OUTLINE = '#111c17', GLINT = '#d6ddbe', HOLLOW = '#0a100d';
// Finish only the named metal face, before its holes, fittings and fasteners.
// The maps repeat in metres, independent of the canvas density or vehicle size.
function finishPath(a: ChassisKit, bounds: WeatheringBounds, profile: FinishProfile = {}) {
  if (a.weathering) paintWeathering(a.ctx, a.weathering, bounds,
    { material: a.material, chips: .12, rust: .04, dirt: .15, period: 1.1, ...profile });
}
function finishFace(a: ChassisKit, x: number, y: number, width: number, height: number, profile: FinishProfile) {
  if (!a.weathering || width <= 0 || height <= 0) return;
  a.path(x, y, width, height, Math.min(.004, width / 6, height / 6));
  finishPath(a, { x, y, width, height }, profile);
}
// Dust settled on the foot of the chassis and mud thrown up by what turns under it, in the frame of the picture, from
// `from` to `to` along it.
function grime(a: ChassisKit, layout: ChassisLayout, at: Project, random: Random, from: number, to: number) {
  const [x0, y0] = at(from, layout.top), [, y1] = at(0, layout.bottom), width = to - from;
  a.ctx.fillStyle = a.gradient(0, y0, 0, y1, [[0, 'rgba(124,104,70,0)'], [.55, 'rgba(124,104,70,.12)'], [1, 'rgba(112,92,60,.3)']]);
  a.ctx.fillRect(x0 - .1, y0, width + .2, y1 - y0);
  const specks: [number, number, number][][] = [[], []];
  for (const { x, r } of layout.axles) for (let i = 0; i < r * 90; i++) {
    const [px, py] = at(x + random.range(-r * 1.5, r * 1.5), layout.top - random.next() ** .6 * (layout.top - layout.bottom));
    specks[i % 2]!.push([px, py, random.range(.002, .008)]);
  }
  for (const [i, group] of specks.entries()) {
    a.ctx.fillStyle = i ? 'rgba(96,84,60,.3)' : 'rgba(118,104,78,.22)'; a.ctx.beginPath();
    for (const [x, y, r] of group) { a.ctx.moveTo(x + r, y); a.ctx.arc(x, y, r, 0, TAU); }
    a.ctx.fill();
  }
}
// Round heads in rows, each its shade, its dome and the light on its top: a path for each, for all of them.
function heads(a: ChassisKit, points: readonly XY[], r: number, base: string) {
  for (const [dx, dy, k, style] of [[.2, .3, 1.35, '#0d1712b0'], [0, 0, 1, shade(base, -.12)], [-.25, -.3, .55, shade(base, .25)], [-.35, -.4, .22, GLINT + 'c0']] as const) {
    a.ctx.beginPath();
    for (const [x, y] of points) { a.ctx.moveTo(x + dx * r + r * k, y + dy * r); a.ctx.arc(x + dx * r, y + dy * r, r * k, 0, TAU); }
    a.fill(style);
  }
}

// A colour gone `k` of the way to the grey of its own brightness.
function muted(hex: string, k: number) {
  const v = parseInt(hex.slice(1), 16), rgb = [v >> 16 & 255, v >> 8 & 255, v & 255] as const, grey = rgb[0] * .3 + rgb[1] * .59 + rgb[2] * .11;
  return '#' + rgb.map(c => Math.round(c + (grey - c) * k).toString(16).padStart(2, '0')).join('');
}
// Paints in the frame of a straight of a chassis (`straights`): along it as it would lie level from its first point,
// turned about that point to its slope; within the line it meets the next straight on at each of its knees (`clipped`).
function onStraight(a: ChassisKit, line: ChassisStraight, at: Project, clipped: boolean, paint: () => void) {
  const ctx = a.ctx;
  ctx.save();
  if (clipped) for (const knee of [line.ahead, line.behind]) if (knee) {
    // The side of that line the straight is on, as far out as the picture goes.
    const { point, normal: n, seam } = knee, c = { x: point.x + n.x * seam, y: point.y + n.y * seam }, far = 50;
    ctx.beginPath();
    for (const [u, v] of [[far, 0], [-far, 0], [-far, -far], [far, -far]] as const) ctx.lineTo(...at(c.x - n.y * u + n.x * v, c.y + n.x * u + n.y * v));
    ctx.closePath(); ctx.clip();
  }
  if (line.angle) { const [x, y] = at(line.a.x, line.a.y); ctx.translate(x, y); ctx.rotate(-line.angle); ctx.translate(-x, -y); }
  paint();
  ctx.restore();
}
// The near rail of a ladder frame: a channel of steel whose web faces out, painted as the vehicle is, a shade darker and
// duller, as what stands back under the vehicle; the bend of its top flange catches the light where nothing stands on
// it (render.ts lays the shade of what does), that of its bottom one is dark. Round the wheels under each fender, where
// it runs through the box the tyres stand in (hull-art.ts), it is in the dark of the box, fading out past its edge. Each
// straight of it (`straights`) is a length of channel along it, its holes and rivets in line with it; two meet at a knee
// mitred and welded, a plate bolted over the joint, and each end of a part of it, at a gap or at an end of the chassis, is
// cut square.
function paintRail(a: ChassisKit, layout: ChassisLayout, at: Project, paint: string, random: Random, rearStays: readonly RearMudguardStay[] = []) {
  const { depth } = layout, frame = shade(muted(paint, .3), -.42), gauge = Math.min(depth / 2, layout.thicknessMm / 1000),
    bare = '#' + MATERIALS[layout.metal].color.toString(16).padStart(6, '0'), end = Math.min(.025, depth * .12);
  for (const [i, line] of layout.straights.entries()) {
    const [from, to] = reach(line, depth), length = to - from, [x0, y0] = at(from, line.a.y), [, y1] = at(0, line.a.y - depth),
      parts = layout.parts.filter(part => part.straight === i);
    onStraight(a, line, at, true, () => {
      a.path(x0, y0, length, depth, .003);
      a.fill(a.gradient(0, y0, 0, y1, [[0, shade(frame, .34)], [.06, shade(frame, .1)], [.16, frame], [.78, shade(frame, -.12)], [.92, shade(frame, -.32)], [1, shade(frame, -.55)]]));
      // The gauge belongs to both flanges inside the same channel, not to a new
      // plate above its deck. Only the cut ends expose the underlying metal.
      a.ctx.fillStyle = a.gradient(0, y0, 0, y0 + gauge, [[0, shade(frame, .3)], [1, shade(frame, -.1)]]);
      a.ctx.fillRect(x0, y0, length, gauge);
      a.ctx.fillStyle = a.gradient(0, y1 - gauge, 0, y1, [[0, shade(frame, -.15)], [1, shade(frame, -.5)]]);
      a.ctx.fillRect(x0, y1 - gauge, length, gauge);
      for (const x of [!line.ahead && x0, !line.behind && x0 + length - end]) if (x !== false) {
        a.ctx.fillStyle = shade(bare, -.35); a.ctx.fillRect(x, y0, end, gauge);
        a.ctx.fillStyle = shade(bare, -.5); a.ctx.fillRect(x, y1 - gauge, end, gauge);
      }
      finishPath(a, { x: x0 + .006, y: y0 + depth * .5, width: length - .012, height: depth * .44 },
        { chips: .1, rust: .05, dirt: .16, oil: .035 });
      a.stroke(OUTLINE, a.edge);
      // The folds delimit the actual thickness, including when two gauges select
      // the same stock height. Draw them after the complete rail's outline.
      a.line(x0, y0 + gauge, x0 + length, y0 + gauge, '#101b1470', a.hair(1));
      a.line(x0, y1 - gauge, x0 + length, y1 - gauge, shade(frame, .25), a.hair(1));
      a.line(x0 + .006, y0 + .005, x0 + length - .006, y0 + .005, GLINT + '60', Math.max(a.hair(1), .0018));
      a.line(x0 + .006, y1 - .007, x0 + length - .006, y1 - .007, '#0b130e70', Math.max(a.hair(1), .003));
      for (const part of parts) {
        const [x, y] = at(part.x, part.y), left = x - part.w / 2, top = y - part.h / 2;
        if (part.kind === 'hole' && part.y + part.h / 2 < line.a.y - gauge && part.y - part.h / 2 > line.a.y - depth + gauge) {
          // A hole through the web: the far rail deep in the shade behind it, the lip pressed round it lit underneath.
          a.ctx.beginPath(); a.ctx.ellipse(x, y, part.w / 2, part.h / 2, 0, 0, TAU); a.fill(a.gradient(0, top, 0, top + part.h, [[0, HOLLOW], [.7, '#18211b'], [1, '#222c25']]));
          a.ctx.beginPath(); a.ctx.ellipse(x, y, part.w / 2 + .003, part.h / 2 + .003, 0, Math.PI * .08, Math.PI * .92); a.stroke(shade(frame, .3), Math.max(a.hair(1.2), .003));
          a.ctx.beginPath(); a.ctx.ellipse(x, y, part.w / 2 + .002, part.h / 2 + .002, 0, Math.PI * 1.08, Math.PI * 1.92); a.stroke('#070c0aa0', Math.max(a.hair(1), .0025));
        } else if ((part.kind === 'gusset' || part.kind === 'tower') && !part.upright) {
          a.housing(left, top, part.w, part.h, shade(frame, .1), .008);
          finishFace(a, left + .008, top + .008, part.w - .016, part.h - .016, { chips: .15, dirt: .14, oil: .025 });
          const rows = part.bolts, ys = Array.from({ length: rows }, (_, i: number) => top + part.h * (i + .5) / rows);
          for (const bx of [x - part.w * .28, x + part.w * .28]) for (const by of ys) a.bolt(bx, by, .0075);
          if (part.pin !== undefined) pin(a, x, at(0, part.pin)[1], .02, frame);
        }
      }
      // The rivets along the edges of the web, and the grime on it.
      heads(a, parts.filter(p => p.kind === 'rivet').map(p => at(p.x, p.y)), .0062, frame);
      a.ctx.save(); a.path(x0, y0, length, depth, .003); a.ctx.clip(); grime(a, layout, at, random, from, to); a.ctx.restore();
    });
    onStraight(a, line, at, false, () => { for (const part of parts) if (!part.upright) hanging(a, part, at, frame); });
    onStraight(a, line, at, true, () => a.wear(x0, y0, length, depth, length * 3));
  }
  for (const part of layout.parts) if (part.kind === 'knee') knee(a, part, at, frame);
  for (const part of layout.parts) if (part.upright) dropFitting(a, part, at, frame);
  for (const stay of rearStays) paintRearMudguardStay(a, stay, at, paint);
  // Only what is painted of the rail and of what hangs from it takes the shade.
  a.ctx.save(); a.ctx.globalCompositeOperation = 'source-atop';
  for (const { x, y, r, half } of groupsOn(layout.runs, layout.axles)) {
    const { inner, band } = fenderOver(r), [cx, cy] = at(x, y), well = inner + band * .4, reach = well + band,
      fade: GradientStop[] = [[0, 'rgba(6,9,7,.5)'], [well / reach, 'rgba(6,9,7,.42)'], [1, 'rgba(6,9,7,0)']];
    // Round each end axle beyond it, and level between the two: as dark as far from the line between them as round the
    // axle of a wheel alone.
    for (const way of [-1, 1]) {
      const ex = cx + way * half;
      a.ctx.save(); a.ctx.beginPath(); a.ctx.rect(way < 0 ? ex - reach : ex, cy - reach, reach, 2 * reach); a.ctx.clip();
      a.ctx.fillStyle = a.radial(ex, cy, reach, fade); a.ctx.fillRect(ex - reach, cy - reach, 2 * reach, 2 * reach);
      a.ctx.restore();
    }
    a.ctx.fillStyle = a.gradient(0, cy - reach, 0, cy + reach, [...fade.map(([t, c]): GradientStop => [(1 - t) / 2, c]), ...fade.map(([t, c]): GradientStop => [(1 + t) / 2, c])]);
    a.ctx.fillRect(cx - half, cy - reach, 2 * half, 2 * reach);
  }
  a.ctx.restore();
}
// The keel of an aircraft (`keelParts`), the side of a built-up beam painted as a rail is, a shade darker and duller than
// the vehicle, as what stands back under it: along each straight its web, its caps over it, lit along the top of the upper
// one and dark along the foot of the lower one, each in its row of rivets; through each cut-out of its truss the dark
// under the vehicle, the lip pressed round it lit along its lower edges and dark along its upper ones; its stiffeners
// and the doublers over its legs riveted on; and over each end of each part its fairing, a cap of skin in the paint of
// the vehicle, darker as it turns away round its end, riveted along its edges. Two straights meet at a knee mitred, a
// plate bolted over the joint, as a rail's.
function paintKeel(a: ChassisKit, layout: ChassisLayout, at: Project, paint: string, random: Random) {
  const { depth } = layout, ctx = a.ctx, frame = shade(muted(paint, .3), -.42), skin = shade(muted(paint, .15), -.12),
    cap = keelCap(depth, layout.thicknessMm), gauge = Math.min(cap / 2, layout.thicknessMm / 1000), rivet = Math.max(a.hair(1.1), .0042);
  for (const [i, line] of layout.straights.entries()) {
    const [from, to] = reach(line, depth), length = to - from, [x0, y0] = at(from, line.a.y), [, y1] = at(0, line.a.y - depth),
      parts = layout.parts.filter(part => part.straight === i), ends = parts.filter(part => part.kind === 'fairing'),
      round = (end: 'front' | 'rear') => ends.find(part => part.end === end)?.r ?? 0,
      side = () => keelSide(ctx, x0, y0, length, depth, round('front'), round('rear')), riveted: XY[] = [];
    onStraight(a, line, at, true, () => {
      side();
      a.fill(a.gradient(0, y0, 0, y1, [[0, shade(frame, .1)], [.25, shade(frame, .03)], [.75, shade(frame, -.08)], [1, shade(frame, -.3)]]));
      ctx.save(); side(); ctx.clip();
      finishPath(a, { x: x0 + .004, y: y0 + cap, width: length - .008, height: depth - 2 * cap }, { chips: .08, rust: .03, dirt: .12, oil: .02 });
      for (const bay of parts.filter(part => part.kind === 'bay')) cutOut(a, bay, at, frame);
      // The stiffeners and the doublers, riveted on in a column, and round their edges.
      for (const part of parts.filter(part => part.kind === 'stiffener' || part.kind === 'saddle')) {
        const [x, y] = at(part.x, part.y), left = x - part.w / 2, top = y - part.h / 2, doubler = part.kind === 'saddle';
        a.line(left + part.w + a.hair(1), top, left + part.w + a.hair(1), top + part.h, '#0b130e60', Math.max(a.hair(1.5), .0025));
        a.path(left, top, part.w, part.h, .002);
        a.fill(doubler ? a.gradient(0, top, 0, top + part.h, [[0, shade(frame, .2)], [.15, shade(frame, .1)], [1, shade(frame, -.12)]])
          : a.gradient(left, 0, left + part.w, 0, [[0, shade(frame, .24)], [.4, shade(frame, .1)], [1, shade(frame, -.18)]]));
        a.stroke(OUTLINE, a.hair(1));
        if (doubler) finishFace(a, left + .004, top + .004, part.w - .008, part.h - .008, { chips: .12, dirt: .14, oil: .03 });
        const inset = Math.min(.008, part.w / 4), columns = doubler ? [left + inset, left + part.w - inset] : [x];
        for (const cx of columns) for (const cy of along(top + inset, top + part.h - inset, .03)) riveted.push([cx, cy]);
        if (doubler) for (const cx of along(left + 2 * inset, left + part.w - 2 * inset, .03)) riveted.push([cx, top + inset], [cx, top + part.h - inset]);
      }
      // The caps: the flange of each riveted to the web, the edge of its other flange along the top or the foot.
      ctx.fillStyle = a.gradient(0, y0, 0, y0 + cap, [[0, shade(frame, .4)], [Math.min(.5, gauge / cap), shade(frame, .2)], [1, shade(frame, .02)]]);
      ctx.fillRect(x0, y0, length, cap);
      ctx.fillStyle = a.gradient(0, y1 - cap, 0, y1, [[0, shade(frame, .12)], [1 - Math.min(.5, gauge / cap), shade(frame, -.12)], [1, shade(frame, -.5)]]);
      ctx.fillRect(x0, y1 - cap, length, cap);
      a.line(x0, y0 + cap + a.hair(.8), x0 + length, y0 + cap + a.hair(.8), '#0b130e80', Math.max(a.hair(1.2), .002));
      a.line(x0, y1 - cap, x0 + length, y1 - cap, shade(frame, .3), a.hair(1));
      a.line(x0 + .004, y0 + .0035, x0 + length - .004, y0 + .0035, GLINT + '60', Math.max(a.hair(1), .0016));
      heads(a, [...riveted, ...parts.filter(part => part.kind === 'rivet').map(part => at(part.x, part.y))], rivet, frame);
      grime(a, layout, at, random, from, to);
      for (const end of ends) paintFairing(a, end, at, x0, length, y0, depth, skin, rivet);
      a.wear(x0, y0, length, depth, length * 3);
      ctx.restore();
      side(); a.stroke(OUTLINE, a.edge);
    });
  }
  for (const part of layout.parts) if (part.kind === 'knee') knee(a, part, at, frame);
}
// The side of a straight of a keel from `x`, `y` (its front end, at its deck), `w` long and `h` deep: its lower corner
// at the front round by `front`, at the rear by `rear`.
function keelSide(ctx: ArtContext, x: number, y: number, w: number, h: number, front: number, rear: number) {
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y);
  if (rear) { ctx.lineTo(x + w, y + h - rear); ctx.arc(x + w - rear, y + h - rear, rear, 0, Math.PI / 2); } else ctx.lineTo(x + w, y + h);
  if (front) { ctx.lineTo(x + front, y + h); ctx.arc(x + front, y + h - front, front, Math.PI / 2, Math.PI); } else ctx.lineTo(x, y + h);
  ctx.closePath();
}
// A cut-out of the truss of a keel (`bay`): a triangle with its corners round, through to the dark under the vehicle, and
// the lip pressed round it, lit where it faces down and dark where it faces up.
function cutOut(a: ChassisKit, bay: Extract<ChassisPart, { kind: 'bay' }>, at: Project, frame: string) {
  const ctx = a.ctx, points = bay.points.map(([x, y]) => at(x, y)), c = points.reduce<[number, number]>((s, p) => [s[0] + p[0] / 3, s[1] + p[1] / 3], [0, 0]),
    r = bay.corner, lip = Math.max(a.hair(1), .0022), top = Math.min(...points.map(p => p[1])), foot = Math.max(...points.map(p => p[1]));
  ctx.beginPath(); ctx.moveTo((points[2]![0] + points[0]![0]) / 2, (points[2]![1] + points[0]![1]) / 2);
  for (let k = 0; k < 3; k++) ctx.arcTo(...points[k]!, ...points[(k + 1) % 3]!, r);
  ctx.closePath();
  a.fill(a.gradient(0, top, 0, foot, [[0, HOLLOW], [.7, '#18211b'], [1, '#222c25']]));
  for (let k = 0; k < 3; k++) {
    const p = points[k]!, q = points[(k + 1) % 3]!, dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy),
      m: XY = [(p[0] + q[0]) / 2 - c[0], (p[1] + q[1]) / 2 - c[1]];
    let n: XY = [dy / l, -dx / l];
    if (n[0] * m[0] + n[1] * m[1] < 0) n = [-n[0], -n[1]];
    if (Math.abs(n[1]) < .2) continue;
    const off = lip * .9, cut = r * 1.6 / l;
    a.line(p[0] + dx * cut + n[0] * off, p[1] + dy * cut + n[1] * off, q[0] - dx * cut + n[0] * off, q[1] - dy * cut + n[1] * off,
      n[1] > 0 ? shade(frame, .26) : '#070c0aa0', lip);
  }
}
// The fairing over an end of a straight of a keel (`fairing` of its parts): from that end `f` along it, as deep as the
// beam, its lower corner round by `r`; skin in the paint of the vehicle, lit along its top, darker down it and towards
// the end it turns away round; the line of its edge over the beam with the shade it casts on it; a row of rivets along
// its free edge and its top, and a column down its edge.
function paintFairing(a: ChassisKit, part: Extract<ChassisPart, { kind: 'fairing' }>, _at: Project, x0: number, length: number, y0: number, depth: number, skin: string, rivet: number) {
  const ctx = a.ctx, front = part.end === 'front', f = part.w, r = part.r, y1 = y0 + depth, end = front ? x0 : x0 + length, edge = front ? x0 + f : x0 + length - f,
    way = front ? 1 : -1, inset = Math.min(.009, f / 6, r / 3);
  const outline = () => {
    ctx.beginPath(); ctx.moveTo(edge, y0); ctx.lineTo(edge, y1); ctx.lineTo(end + way * r, y1);
    ctx.arc(end + way * r, y1 - r, r, Math.PI / 2, front ? Math.PI : 0, !front); ctx.lineTo(end, y0); ctx.closePath();
  };
  // The shade it casts on the beam along its edge.
  a.line(edge + way * .002, y0, edge + way * .002, y1, '#0b130e70', Math.max(a.hair(2), .004));
  outline();
  a.fill(a.gradient(0, y0, 0, y1, [[0, shade(skin, .35)], [Math.min(.2, .006 / depth), shade(skin, .1)], [.5, skin], [1, shade(skin, -.38)]]));
  outline();
  a.fill(a.gradient(end, 0, end + way * f, 0, [[0, '#0b130e66'], [.35, '#0b130e22'], [.8, '#0b130e00']]));
  finishPath(a, { x: Math.min(end, edge), y: y0, width: f, height: depth }, { chips: .1, rust: .02, dirt: .14 });
  outline(); a.stroke(OUTLINE, a.edge);
  a.line(edge, y0 + .003, edge, y1 - .003, GLINT + '40', a.hair(1));
  // Its rivets: along its top, down by its edge, and round its free edge from the foot of its edge to its top at the end.
  const riveted: XY[] = [];
  for (const x of along(Math.min(end, edge) + inset, Math.min(end, edge) + f - inset, .03)) riveted.push([x, y0 + inset]);
  for (const y of along(y0 + 2 * inset, y1 - inset, .03)) riveted.push([edge - way * inset, y]);
  const straight = Math.max(0, f - r - inset), arc = (r - inset) * Math.PI / 2, rise = Math.max(0, depth - r - 2 * inset), total = straight + arc + rise;
  for (const s of along(0, total, .03)) {
    if (s < straight) riveted.push([edge - way * (inset + s), y1 - inset]);
    else if (s < straight + arc) {
      const t = (s - straight) / (r - inset), angle = front ? Math.PI / 2 + t : Math.PI / 2 - t;
      riveted.push([end + way * r + Math.cos(angle) * (r - inset), y1 - r + Math.sin(angle) * (r - inset)]);
    } else riveted.push([end + way * inset, y1 - r - (s - straight - arc)]);
  }
  heads(a, riveted, rivet, skin);
}
// The skids of an aircraft (`skidParts`), under its keel: at the top of each leg the cross tube it is the end of, coming
// out at the viewer and so seen end on, held under the keel in a saddle bolted to it and a strap under it bolted up into
// the saddle either side, a liner of rubber between; the leg its end bent down, lit across as it is round, behind it the
// middle of the strap, down to its clamp round the runner; the runner a tube along the floor in the paint of the frame,
// bent up at the front into its toe, capped behind, with the shoe it wears on along its foot. The saddle, the strap,
// their bolts and the clamp are as large as the tubes they hold. A leg too short for its saddle has its tube higher in it.
function paintSkids(a: ChassisKit, layout: ChassisLayout, at: Project, paint: string) {
  const frame = shade(muted(paint, .3), -.42), steel = '#6f766c', ctx = a.ctx;
  for (const leg of layout.parts.filter(part => part.kind === 'leg')) {
    const [x, top] = at(leg.x, leg.top), [, foot] = at(0, leg.foot), w = leg.w, k = leg.tube / SKID_TUBE, R = w / 2,
      liner = Math.max(a.hair(1), R * .08), strap = R * .3, ear = R * 1.1, block = Math.max(.004, R * .4), hold = .03 * k,
      ring = R + liner + strap, tab = strap * .9,
      cy = top + Math.max(R * .55, Math.min(block + R + liner, foot - top - R - strap - hold)),
      tubeFill = a.gradient(x - R, 0, x + R, 0, [[0, shade(frame, -.5)], [.28, shade(frame, .28)], [.5, shade(frame, .05)], [1, shade(frame, -.55)]]);
    // The saddle, its seat round the top of the tube.
    ctx.beginPath(); ctx.moveTo(x - R - ear, top - .003); ctx.lineTo(x + R + ear, top - .003); ctx.lineTo(x + R + ear, cy);
    ctx.arc(x, cy, R + liner, 0, Math.PI, true); ctx.lineTo(x - R - ear, cy); ctx.closePath();
    a.fill(a.gradient(0, top, 0, cy, [[0, shade(frame, .26)], [.2, shade(frame, .12)], [1, shade(frame, -.22)]])); a.stroke(OUTLINE, a.edge);
    finishPath(a, { x: x - R - ear, y: top, width: 2 * (R + ear), height: cy - top }, { chips: .14, dirt: .14, oil: .03 });
    // The strap round the foot of the tube, its ears flat under the saddle, a bolt up through each.
    ctx.beginPath(); ctx.arc(x, cy, ring, 0, Math.PI); ctx.closePath();
    a.fill(a.gradient(0, cy, 0, cy + ring, [[0, shade(steel, .1)], [.5, shade(steel, -.05)], [1, shade(steel, -.45)]])); a.stroke(OUTLINE, a.hair(1));
    for (const way of [-1, 1]) {
      const outer = x + way * (R + ear), inner = x + way * (ring - strap * .5), bx = (outer + inner) / 2;
      a.path(Math.min(outer, inner), cy, Math.abs(outer - inner), tab, tab * .25);
      a.fill(a.gradient(0, cy, 0, cy + tab, [[0, shade(steel, .3)], [1, shade(steel, -.3)]])); a.stroke(OUTLINE, a.hair(1));
      a.stud(bx, cy + tab + R * .12, R * .26, 'y');
    }
    a.circle(x, cy, R + liner / 2, null, '#1b201c', liner);
    // The leg, from the tube down to the runner, and over it the bend of the tube towards the viewer.
    a.path(x - R, cy, w, foot - cy + .01, 0); a.fill(tubeFill);
    a.line(x - R, cy, x - R, foot + .01, OUTLINE, a.edge); a.line(x + R, cy, x + R, foot + .01, OUTLINE, a.edge);
    a.circle(x, cy, R, tubeFill);
    a.circle(x, cy, R, a.radial(x, cy - R * .2, R * 1.05, [[0, shade(frame, .3) + '90'], [.55, shade(frame, .05) + '30'], [1, '#0b130e00']], x - R * .25, cy - R * .45));
    ctx.beginPath(); ctx.arc(x, cy, R, Math.PI, 0); a.stroke(OUTLINE, a.edge);
    a.housing(x - w * .85, foot - .012 * k, w * 1.7, hold, shade(frame, .05), .008 * k);
  }
  for (const skid of layout.parts.filter(part => part.kind === 'skid')) {
    const { front, rear, runner, tube, toe: bend } = skid, toe = Array.from({ length: 9 }, (_, k: number) => {
      const turn = SKID_TOE_TURN * k / 8;
      return at(front + bend - bend * Math.sin(turn), runner + bend * (1 - Math.cos(turn)));
    }).reverse();
    a.tube([...toe, at(rear - tube / 2, runner)], tube, shade(frame, .06));
    // The cap of its rear end, and the shoe along its foot as far as it lies on the floor.
    const [cx, cy] = at(rear - tube / 2, runner);
    a.circle(cx, cy, tube * .38, a.radial(cx, cy, tube * .38, [[0, shade(frame, .2)], [1, shade(frame, -.45)]]), OUTLINE, a.hair(1));
    const [s0, sy] = at(front + bend, runner - tube / 2), [s1] = at(rear - tube * .8, 0), shoe = Math.max(a.hair(2), tube * .2);
    a.path(s0, sy - shoe, s1 - s0, shoe, shoe / 2);
    a.fill(a.gradient(0, sy - shoe, 0, sy, [[0, shade(steel, .25)], [1, shade(steel, -.4)]])); a.stroke(OUTLINE, a.hair(1));
  }
}
// What holds the springs of an axle under the rail (`wheeledParts`): a bracket cast to hold a pin, bolted to the web by
// its broad top, the hanger ahead of the axle and the shackle behind it, and the bracket the damper hangs from. One held
// to the end of the rail its axle is under (`end`) is bolted to the web there and reaches out under its pin (`pinX`).
function hanging(a: ChassisKit, part: ChassisPart, at: Project, frame: string) {
  if ((part.kind !== 'hanger' && part.kind !== 'shackle' && part.kind !== 'bracket') || part.upright) return;
  const [x, y] = at(part.end === undefined ? part.x : part.pinX!, part.y), top = y - part.h / 2, foot = y + part.h / 2;
  if (part.kind === 'hanger' || part.kind === 'shackle') {
    const [, pinY] = at(0, part.pin);
    if (part.end === undefined) {
      const w = part.w;
      a.shape([[x - w / 2, top], [x + w / 2, top], [x + w / 2, top + part.h * .32], [x + w * .2, pinY + .006], [x + w * .2, Math.min(foot, pinY + .03)],
        [x - w * .2, Math.min(foot, pinY + .03)], [x - w * .2, pinY + .006], [x - w / 2, top + part.h * .32]]);
      a.fill(a.gradient(0, top, 0, foot, [[0, shade(frame, .26)], [.12, shade(frame, .06)], [1, shade(frame, -.3)]])); a.stroke(OUTLINE, a.edge);
      finishPath(a, { x: x - w / 2, y: top, width: w, height: foot - top }, { chips: .16, rust: .055, dirt: .18, oil: .04 });
      a.rib(x, top + part.h * .36, x, pinY - .03, .004);
      for (const bx of [x - w * .3, x + w * .3]) a.bolt(bx, top + part.h * .16, .0072);
    } else {
      // Its top a plate on the web at the end of the rail, the arm out of the foot of the plate down to the boss of the pin.
      const w = part.bracket!, [end] = at(part.end, 0), way = Math.sign(x - end), back = end - way * w, low = Math.min(foot, pinY + .03), mid = top + part.h * .32;
      a.shape([[back, top], [end, top], [x + way * w * .2, pinY - .03], [x + way * w * .2, low], [x - way * w * .2, low], [end, mid], [back, mid]]);
      a.fill(a.gradient(0, top, 0, foot, [[0, shade(frame, .26)], [.12, shade(frame, .06)], [1, shade(frame, -.3)]])); a.stroke(OUTLINE, a.edge);
      finishPath(a, { x: Math.min(back, x - w * .2), y: top, width: Math.abs(x - back) + w * .2, height: foot - top }, { chips: .16, rust: .055, dirt: .18, oil: .04 });
      a.rib(end - way * w / 2, top + part.h * .16, x, pinY - .03, .004);
      for (const bx of [end - way * w * .8, end - way * w * .2]) a.bolt(bx, top + part.h * .16, .0072);
    }
    pin(a, x, pinY, .026, frame);
    if (part.kind === 'shackle') {
      // The shackle: two links from the pin of the bracket down to that of the spring's eye, which swings on them.
      const [, eyeY] = at(0, part.eye);
      a.path(x - .018, pinY - .016, .036, eyeY - pinY + .032, .016); a.fill(a.gradient(x - .018, 0, x + .018, 0, [[0, shade(frame, -.2)], [.4, shade(frame, .2)], [1, shade(frame, -.35)]]));
      a.stroke(OUTLINE, a.edge);
      for (const py of [pinY, eyeY]) a.circle(x, py, .009, a.radial(x, py, .009, [[0, '#a7ad98'], [1, '#3d463b']]), OUTLINE, a.hair(1));
    }
  } else if (part.kind === 'bracket') {
    // The bracket the damper hangs from; held to the end of the rail, a flat bar from it out to the pin.
    const [, pinY] = at(0, part.pin);
    if (part.end !== undefined) {
      const w = part.bracket!, [end] = at(part.end, 0), way = Math.sign(x - end), bar = .024;
      a.path(Math.min(end - way * w / 2, x), pinY - bar / 2, Math.abs(x - end + way * w / 2), bar, .004);
      a.fill(a.gradient(0, pinY - bar / 2, 0, pinY + bar / 2, [[0, shade(frame, .2)], [1, shade(frame, -.3)]])); a.stroke(OUTLINE, a.edge);
      a.housing(Math.min(end, end - way * w), top, w, part.h, shade(frame, .04), .006);
      finishFace(a, Math.min(end, end - way * w) + .006, top + .006, w - .012, part.h - .012, { dirt: .16, oil: .04 });
      a.bolt(end - way * w / 2, top + .014, .0065);
    } else {
      a.housing(x - part.w / 2, top, part.w, part.h, shade(frame, .04), .006);
      finishFace(a, x - part.w / 2 + .006, top + .006, part.w - .012, part.h - .012, { dirt: .16, oil: .04 });
      a.bolt(x, top + .014, .0065);
    }
    pin(a, x, pinY, .014, frame);
  }
}
// The plate bolted over a knee of the rail (`wheeledParts`), on the web of both straights: a housing as the cross members'
// are, its edges square to each straight, and a row of bolts into each.
function knee(a: ChassisKit, part: Extract<ChassisPart, { kind: 'knee' }>, at: Project, frame: string) {
  const points = part.points.map(p => at(p.x, p.y)), ys = points.map(p => p[1]), top = Math.min(...ys), foot = Math.max(...ys),
    xs = points.map(p => p[0]), left = Math.min(...xs);
  a.shape(points);
  a.fill(a.gradient(0, top, 0, foot, [[0, shade(shade(frame, .1), .3)], [Math.min(.3, .012 / (foot - top)), shade(frame, .1)], [.6, shade(frame, .1)], [1, shade(shade(frame, .1), -.4)]]));
  a.stroke(OUTLINE, a.edge);
  finishPath(a, { x: left, y: top, width: Math.max(...xs) - left, height: foot - top }, { chips: .15, dirt: .14, oil: .025 });
  for (const bolt of part.bolts) a.bolt(...at(bolt.x, bolt.y), .0075);
}
// A fitting dropped from the rail to its pin (`dropped`): its plate bolted along the lower half of the web as it slopes,
// a leg from the foot of the plate straight down to the boss of its pin (or out to it from the end of the rail), and of
// a shackle the links from that pin down to the eye of the spring, which swings on them.
function dropFitting(a: ChassisKit, part: Extract<ChassisPart, { upright: true }>, at: Project, frame: string) {
  const top = part.top.map(([x, y]) => at(x, y)), low = part.low.map(([x, y]) => at(x, y)), [px, py] = at(part.pinX, part.pin),
    left = top[0]![0], right = top.at(-1)![0], wide = right - left, y0 = Math.min(...top.map(p => p[1])), y1 = Math.max(...low.map(p => p[1])),
    lit = (from: number, to: number) => a.gradient(0, from, 0, to, [[0, shade(frame, .26)], [.12, shade(frame, .06)], [1, shade(frame, -.3)]]),
    footAt = (u: number) => { const i = low.findIndex(p => p[0] >= u - 1e-9), b = low[Math.max(0, i)]!, q = low[Math.max(0, i - 1)]!; return b[0] - q[0] > 1e-9 ? q[1] + (b[1] - q[1]) * (u - q[0]) / (b[0] - q[0]) : b[1]; },
    mx = (left + right) / 2, my = footAt(mx) - .01, boss = part.kind === 'bracket' ? .014 : part.kind === 'tower' ? .02 : .026;
  // The leg, under the plate: as wide as the boss where it holds the pin, broader where it leaves the plate.
  if (py > my + boss) {
    const reach = Math.hypot(px - mx, py - my), nx = (py - my) / reach, ny = -(px - mx) / reach, root = wide * .3, tip = Math.max(boss, wide * .2);
    a.shape([[mx + nx * root, my + ny * root], [px + nx * tip, py + ny * tip], [px - nx * tip, py - ny * tip], [mx - nx * root, my - ny * root]]);
    a.fill(lit(my, py)); a.stroke(OUTLINE, a.edge);
    finishPath(a, { x: Math.min(mx, px) - root, y: my, width: Math.abs(px - mx) + 2 * root, height: py - my }, { chips: .16, rust: .055, dirt: .18, oil: .04 });
    a.rib(mx + (px - mx) * .08, my + (py - my) * .08, px + (mx - px) * .12, py - boss - .006, .004);
  }
  // The plate along the web, its top and its foot as the rail slopes.
  a.shape([...top, ...[...low].reverse()]);
  a.fill(lit(y0, y1)); a.stroke(OUTLINE, a.edge);
  finishPath(a, { x: left, y: y0, width: wide, height: y1 - y0 }, { chips: .16, rust: .055, dirt: .18, oil: .04 });
  for (const [bx, by] of part.bolts) a.bolt(...at(bx, by), .0072);
  pin(a, px, py, boss, frame);
  if (part.kind === 'shackle') {
    const [, eyeY] = at(0, part.eye!);
    a.path(px - .018, py - .016, .036, eyeY - py + .032, .016); a.fill(a.gradient(px - .018, 0, px + .018, 0, [[0, shade(frame, -.2)], [.4, shade(frame, .2)], [1, shade(frame, -.35)]]));
    a.stroke(OUTLINE, a.edge);
    for (const y of [py, eyeY]) a.circle(px, y, .009, a.radial(px, y, .009, [[0, '#a7ad98'], [1, '#3d463b']]), OUTLINE, a.hair(1));
  }
}
// A pin across the vehicle in its boss, seen end on: the boss, the head of the pin and its grease nipple.
function pin(a: ChassisKit, x: number, y: number, r: number, base: string) {
  a.circle(x + r * .12, y + r * .18, r * 1.1, '#0b130e70');
  a.circle(x, y, r, a.radial(x, y, r, [[0, shade(base, .32)], [.7, shade(base, .02)], [1, shade(base, -.4)]], x - r * .3, y - r * .35), OUTLINE, a.edge);
  a.circle(x, y, r * .45, a.radial(x, y, r * .45, [[0, '#b9bea8'], [1, '#4c5548']], x - r * .12, y - r * .15), OUTLINE, a.hair(1));
  a.circle(x + r * .7, y - r * .7, Math.max(.003, r * .14), '#c9a43a');
}

// The tub of a tracked chassis: its side plate in the paint of the vehicle, dark along its belly; the edge of the nose
// bevelled and welded, the rear plate's edge, the edge of the deck along the top catching the light where nothing stands
// on it (render.ts lays the shade of what does), and the bolts of the deck under it; the lugs it is towed by, and under
// it the mountings of the running gear. Each part of it between gaps is a tub of its own, its side along each straight of
// it (`straights`) and welded where two meet at a knee; its nose is at the front of the first, its rear plate at the rear
// of the last, and each end of a part at a gap is cut square, the edge of its end plate showing as the rear plate's does.
function paintTub(a: ChassisKit, layout: ChassisLayout, at: Project, paint: string, random: Random) {
  const { depth: D, straights: lines } = layout, ctx = a.ctx, bevel = Math.min(D / 2, layout.thicknessMm / 1000), inset = bevel * Math.SQRT2,
    bare = '#' + MATERIALS[layout.metal].color.toString(16).padStart(6, '0'),
    // Where each straight is painted along itself, as it would lie level from its first point.
    laid = lines.map(line => { const [from, to] = reach(line, D), [x0, y0] = at(from, line.a.y), [, y1] = at(0, line.a.y - D); return { x0, y0, y1, length: to - from }; });
  for (const [k, outline] of layout.outlines.entries()) {
    const own = [...lines.keys()].filter((i: number) => lines[i]!.part === k), parts = (i: number) => layout.parts.filter(part => part.straight === i),
      trace = () => { ctx.beginPath(); for (const p of outline) ctx.lineTo(...at(p.x, p.y)); ctx.closePath(); };
    ctx.save(); trace(); ctx.clip();
    for (const i of own) onStraight(a, lines[i]!, at, true, () => {
      const { x0, y0, y1, length } = laid[i]!;
      ctx.fillStyle = a.gradient(0, y0, 0, y1, [[0, shade(paint, .04)], [.35, shade(paint, -.08)], [1, shade(paint, -.3)]]); ctx.fillRect(x0, y0, length, D);
      // Paint gone a shade lighter or darker in broad patches, as on the hull.
      for (let i = 0; i < Math.min(16, length * 2); i++) {
        const x = x0 + random.range(0, length), y = y0 + random.range(0, D), r = random.range(.2, .5), g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, i % 2 ? 'rgba(232,228,196,.05)' : 'rgba(18,24,16,.06)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
      finishPath(a, { x: x0 + .01, y: y0 + D * .5, width: length - .02, height: D * .46 },
        { chips: .11, rust: .05, dirt: .17, oil: .035 });
    });
    // The nose: the edge of the lower glacis, bevelled where it meets the side, lit as it looks up and ahead, and the weld
    // along it.
    if (!k) onStraight(a, lines[0]!, at, false, () => {
      const [nx0, ny0] = at(lines[0]!.a.x, lines[0]!.a.y), [nx1, ny1] = at(lines[0]!.a.x + D, lines[0]!.a.y - D);
      a.shape([[nx0, ny0], [nx1, ny1], [nx1 + inset, ny1], [nx0 + inset, ny0]]);
      a.fill(a.gradient(nx0, ny0, nx0 + inset, ny0, [[0, shade(bare, -.05)], [1, shade(paint, .1)]]));
      weld(a, [nx0 + inset + .01, ny0], [nx1 + inset + .01, ny1], paint);
    });
    // The edge of the plate that closes each end at a gap and of the rear plate, a little in its own shade, the edge of the
    // deck, and the belly: dark where it looks down, a fine light line over it.
    const ends = (i: number) => [!lines[i]!.behind && [laid[i]!.x0 + laid[i]!.length, -1] as const, !lines[i]!.ahead && i > 0 && [laid[i]!.x0, 1] as const].filter(end => end !== false);
    for (const i of own) onStraight(a, lines[i]!, at, false, () => {
      for (const [x, way] of ends(i)) {
        ctx.fillStyle = a.gradient(x + way * bevel, 0, x, 0, [[0, shade(paint, -.08)], [1, shade(paint, -.32)]]); ctx.fillRect(Math.min(x, x + way * bevel), laid[i]!.y0, bevel, D);
      }
    });
    for (const i of own) onStraight(a, lines[i]!, at, true, () => {
      const { x0, y0, length } = laid[i]!;
      ctx.fillStyle = a.gradient(0, y0, 0, y0 + bevel, [[0, shade(bare, -.12)], [1, shade(paint, -.22)]]); ctx.fillRect(x0, y0, length, bevel);
    });
    for (const i of own) onStraight(a, lines[i]!, at, false, () => {
      for (const [x, way] of ends(i)) a.line(x + way * bevel, laid[i]!.y0, x + way * bevel, laid[i]!.y1, '#0b130e60', Math.max(a.hair(1), .0025));
    });
    for (const i of own) onStraight(a, lines[i]!, at, true, () => {
      const { x0, y1, length } = laid[i]!;
      ctx.fillStyle = a.gradient(0, y1 - bevel, 0, y1, [[0, shade(paint, -.25)], [1, shade(paint, -.55)]]); ctx.fillRect(x0, y1 - bevel, length, bevel);
      a.line(x0, y1 - bevel, x0 + length, y1 - bevel, GLINT + '38', Math.max(a.hair(1), .002));
    });
    // Where two straights meet at a knee, the weld of their mitred side plates.
    for (const i of own) if (lines[i]!.behind) weld(a, at(lines[i]!.b.x, lines[i]!.b.y), at(lines[i]!.piece[2].x, lines[i]!.piece[2].y), paint);
    for (const i of own) onStraight(a, lines[i]!, at, false, () => {
      for (const part of parts(i)) if (part.kind === 'bolt') a.bolt(...at(part.x, part.y), .0085);
      for (const part of parts(i)) if (part.kind === 'lug') lug(a, ...at(part.x, part.y), part, paint);
    });
    grime(a, layout, at, random, reach(lines[own[0]!]!, D)[0], reach(lines[own.at(-1)!]!, D)[1]);
    ctx.restore();
    trace(); a.stroke(OUTLINE, a.edge * 1.4);
  }
  // The mountings of the running gear, drawn over the edge of the tub where they hang under it.
  for (const part of layout.parts) {
    const [x, y] = at(part.x, part.y), r = part.w / 2;
    if (part.kind === 'boss') {
      // The boss an arm of a road wheel turns in: a flange bolted round the end of its torsion bar.
      a.circle(x + r * .1, y + r * .15, r * 1.08, '#0b130e60');
      a.circle(x, y, r, a.radial(x, y, r, [[0, shade(paint, .12)], [.75, shade(paint, -.1)], [1, shade(paint, -.42)]], x - r * .3, y - r * .4), OUTLINE, a.edge);
      finishPath(a, { x: x - r, y: y - r, width: r * 2, height: r * 2 }, { chips: .14, dirt: .18, oil: .06, period: .8 });
      for (let i = 0; i < 6; i++) a.bolt(x + Math.cos(i * TAU / 6) * r * .72, y + Math.sin(i * TAU / 6) * r * .72, Math.min(.007, r * .12));
      a.circle(x, y, r * .4, a.radial(x, y, r * .4, [[0, shade(paint, -.05)], [1, shade(paint, -.5)]]), OUTLINE, a.hair(1));
    } else if (part.kind === 'drive') {
      // The housing of the final drive the sprocket turns on: its flange bolted to the tub, the casing ribbed, the hub.
      a.circle(x + r * .06, y + r * .08, r * 1.04, '#0b130e60');
      a.circle(x, y, r, a.radial(x, y, r, [[0, shade(paint, .02)], [.8, shade(paint, -.16)], [1, shade(paint, -.45)]], x - r * .3, y - r * .4), OUTLINE, a.edge);
      finishPath(a, { x: x - r, y: y - r, width: r * 2, height: r * 2 }, { chips: .14, dirt: .18, oil: .075, period: .8 });
      const bolts = Math.max(8, Math.round(TAU * r * .86 / .07));
      for (let i = 0; i < bolts; i++) a.bolt(x + Math.cos(i * TAU / bolts) * r * .86, y + Math.sin(i * TAU / bolts) * r * .86, .0075);
      a.circle(x, y, r * .66, a.radial(x, y, r * .66, [[0, shade(paint, -.05)], [1, shade(paint, -.32)]], x - r * .2, y - r * .25), OUTLINE, a.edge);
      for (let i = 0; i < 8; i++) { const c = Math.cos(i * TAU / 8 + .2), s = Math.sin(i * TAU / 8 + .2); a.rib(x + c * r * .36, y + s * r * .36, x + c * r * .62, y + s * r * .62, .004); }
      a.circle(x, y, r * .3, a.radial(x, y, r * .3, [[0, '#9aa38c'], [1, '#3b453a']], x - r * .1, y - r * .12), OUTLINE, a.edge);
    } else if (part.kind === 'idler') {
      // The crank of the idler from its pivot to the hub, and the screw that pushes it out to tension the belt, from its
      // bracket to the eye on the crank (track-shoe-art.ts `idlerCrank`), with the nut it is turned by.
      const [hx, hy] = at(part.hub.x, part.hub.y), [px, py] = at(part.pivot.x, part.pivot.y), [bx, by] = at(part.brace.x, part.brace.y), size = part.size,
        ex = px + (hx - px) * .4, ey = py + (hy - py) * .4;
      a.tube([[bx, by], [ex, ey]], size * .06, shade(paint, -.22));
      a.housing(bx - size * .06, by - size * .07, size * .12, size * .14, shade(paint, -.1), .006);
      a.housing((bx + ex) / 2 - size * .035, (by + ey) / 2 - size * .045, size * .07, size * .09, '#7b8170', .004);
      a.tube([[px, py], [hx, hy]], size * .13, shade(paint, -.08));
      pin(a, px, py, size * .07, paint);
      a.circle(hx, hy, size * .15, a.radial(hx, hy, size * .15, [[0, shade(paint, .08)], [1, shade(paint, -.4)]], hx - size * .04, hy - size * .05), OUTLINE, a.edge);
      for (let i = 0; i < 6; i++) a.bolt(hx + Math.cos(i * TAU / 6) * size * .1, hy + Math.sin(i * TAU / 6) * size * .1, .0065);
    }
  }
}
// The skirt over a track: its face a shade darker than the hull down to the rubber strip along its foot, dust on its lower
// half, its top edge catching the light; the gap between two sections lit on one side, a row of bolts under its top, the
// rib along the middle of each section of a thick one; its lower corners along the belt.
function paintSkirt(a: ChassisKit, guard: ChassisSkirt, at: Project, paint: string) {
  const { w, h } = guard, [x0, y0] = at(guard.x - w / 2, guard.y + h / 2), ctx = a.ctx, strip = Math.min(.06, h * .16),
    joints = [x0, ...guard.cuts.map((x: number) => x0 + x), x0 + w], sections = joints.slice(1).map((x: number, i: number): XY => [joints[i]!, x]),
    outline = () => a.shape(guard.points.map(([x, y]) => at(x, y)));
  outline(); ctx.save(); ctx.clip();
  ctx.fillStyle = a.gradient(0, y0, 0, y0 + h, [[0, shade(paint, .04)], [.45, shade(paint, -.1)], [1, shade(paint, -.32)]]); ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = a.gradient(0, y0 + h * .3, 0, y0 + h, [[0, 'rgba(124,104,70,0)'], [1, 'rgba(112,92,60,.3)']]); ctx.fillRect(x0, y0, w, h);
  finishPath(a, { x: x0 + .01, y: y0 + h * .5, width: w - .02, height: Math.max(0, h * .5 - strip - .01) },
    { chips: .12, rust: .045, dirt: .19, oil: .015 });
  ctx.fillStyle = shade(paint, .32); ctx.fillRect(x0, y0, w, .016);
  a.line(x0, y0 + .017, x0 + w, y0 + .017, '#0c120e59', Math.max(a.hair(1), .003));
  ctx.fillStyle = '#181b16e6'; ctx.fillRect(x0, y0 + h - strip, w, strip);
  a.line(x0, y0 + h - strip, x0 + w, y0 + h - strip, '#96968240', Math.max(a.hair(1), .003));
  for (const x of joints) {
    a.line(x, y0, x, y0 + h, '#0a0e0b99', .012);
    a.line(x - .011, y0 + .016, x - .011, y0 + h - strip, '#e2e2c41f', Math.max(a.hair(1), .003));
    a.line(x + .011, y0 + .016, x + .011, y0 + h - strip, '#e2e2c438', Math.max(a.hair(1), .003));
  }
  for (const [p, q] of sections) {
    if (guard.ribbed) a.rib(p + .08, y0 + (h - strip) * .55, q - .08, y0 + (h - strip) * .55, .006);
    for (const x of along(p + .06, q - .06, .3)) a.bolt(x, y0 + .05, .012);
  }
  ctx.restore();
  outline(); a.stroke(OUTLINE, a.edge * 1.2);
}
function paintMudguardMount(a: ChassisKit, x: number, y: number, plate: { w: number; h: number }, paint: string) {
  a.housing(x - plate.w / 2, y - plate.h / 2, plate.w, plate.h, shade(paint, -.3), .006);
  a.bolt(x, y - plate.h * .25, .0065); a.bolt(x, y + plate.h * .25, .0065);
}
function paintRearMudguardStay(a: ChassisKit, stay: RearMudguardStay, at: Project, paint: string) {
  const [, from] = at(0, stay.mount.y), [, to] = at(0, stay.tip.y);
  a.shape(stay.points.map(([x, y]) => at(x, y)));
  a.fill(a.gradient(0, Math.min(to, from), 0, Math.max(to, from), [[0, shade(paint, -.5)], [.4, shade(paint, -.34)], [1, shade(paint, -.26)]])); a.stroke(OUTLINE, a.edge);
  paintMudguardMount(a, ...at(stay.mount.x, stay.mount.y), stay.mount, paint);
}
// The mudguard over a wheel or a group of wheels, seen from the side: its band bent square over the tyres
// (hull-details.ts `fenderLine`) and bolted at its foot at either end to a stay on the web of the rail; between each two
// wheels a strut, a flat bar up from a plate on the rail to under the band; its face in the paint of the vehicle, a
// shade darker towards its foot; the flare along its outer edge narrow and only a little lighter, a fine glint along
// its top; its inner edge turned in under it in a light shade, with mud thrown up on it by the tyres, and bolts along
// the band.
function paintMudguard(a: ChassisKit, guard: ChassisMudguard, at: Project, paint: string) {
  const [cx, cy] = at(guard.axle.x, guard.axle.y), { inner, outer, round, half, feet } = guard, ctx = a.ctx, [, stay] = at(0, guard.stay), foot = Math.min(...feet),
    band = outer - inner, lip = band * .2, plate = stayPlate(band), hair = Math.max(a.hair(1), .003),
    // The line of the band `off` out from its inner edge, in the picture, from one foot to the other or back.
    line = (off: number, back = false) => { const points = fenderLine(inner + off, feet, round + off, half).map(([u, v]): XY => [cx + u, cy - v]); return back ? points.reverse() : points; },
    trace = (points: readonly XY[]) => points.forEach(([x, y], i: number) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)),
    strip = (from: number, to: number) => { ctx.beginPath(); trace([...line(to), ...line(from, true)]); ctx.closePath(); },
    edge = (off: number, style: CanvasPaint, width: number) => { ctx.beginPath(); trace(line(off)); a.stroke(style, width); },
    down = (stops: readonly GradientStop[]) => a.gradient(0, cy - outer, 0, cy - foot, stops),
    bolted = (x: number) => paintMudguardMount(a, x, stay, plate, paint);
  for (const [i, way] of [-1, 1].entries()) {
    const x = cx + way * (half + fenderAcross(inner + band / 2, feet[i]!));
    if (guard.held?.[i] == null) bolted(x);
  }
  for (const [i, x] of guard.axles.slice(1).entries()) {
    const [mid] = at((guard.axles[i]! + x) / 2, 0), bar = band * .3, top = cy - inner - band / 2;
    a.path(mid - bar / 2, top, bar, stay - top, .004);
    a.fill(a.gradient(0, top, 0, stay, [[0, shade(paint, -.5)], [.4, shade(paint, -.34)], [1, shade(paint, -.26)]])); a.stroke(OUTLINE, a.edge);
    bolted(mid);
  }
  strip(0, band); a.fill(down([[0, shade(paint, .04)], [1, shade(paint, -.1)]]));
  finishPath(a, { x: cx - half - outer, y: cy - outer, width: 2 * (half + outer), height: outer - foot }, { chips: .14, rust: .045, dirt: .16, oil: .015, period: .8 });
  ctx.save(); strip(0, band); ctx.clip();
  strip(band - lip, band); a.fill(down([[0, shade(paint, .14)], [.5, shade(paint, .07)], [1, shade(paint, .02)]]));
  edge(band - lip, '#0c120e38', hair);
  const flat = half + (inner - round) * Math.tan(FENDER_SLOPE / 2);
  a.line(cx - flat, cy - outer + .003, cx + flat, cy - outer + .003, GLINT + '60', hair);
  edge(band * .05, '#070b0950', band * .1);
  edge(band * .17, '#5a4d3640', band * .1);
  ctx.restore();
  strip(0, band); a.stroke(OUTLINE, a.edge);
  // Bolts spread evenly along the middle of its face, about `BOLT_PITCH` bands apart.
  const middle = line((band - lip) / 2),
    lengths = middle.map((p, i: number) => i ? Math.hypot(p[0] - middle[i - 1]![0], p[1] - middle[i - 1]![1]) : 0), total = lengths.reduce((sum, d: number) => sum + d, 0),
    bolts = Math.round(total / (BOLT_PITCH * band));
  for (let i = 0, k = 1, walked = 0; i < bolts; i++) {
    const want = total * (i + .5) / bolts;
    while (k < middle.length - 1 && walked + lengths[k]! < want) walked += lengths[k++]!;
    const t = (want - walked) / lengths[k]!, [p, q] = [middle[k - 1]!, middle[k]!] as const;
    a.bolt(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, .0065);
  }
}
const BOLT_PITCH = 3;
// A weld bead from one point to another: its groove, the bead with its ripples catching the light, the fine shade it casts.
function weld(a: ChassisKit, from: XY, to: XY, paint: string) {
  a.line(from[0] + .006, from[1], to[0] + .006, to[1], '#0a100c4d', .007);
  a.line(from[0], from[1], to[0], to[1], shade(paint, -.06), .012);
  a.ctx.setLineDash([Math.max(a.hair(1), .003), .01]); a.line(from[0], from[1], to[0], to[1], shade(paint, .3) + '90', .011); a.ctx.setLineDash([]);
}
// A towing lug welded on the tub: its plate and the hole for the shackle's pin, which crosses the vehicle.
function lug(a: ChassisKit, x: number, y: number, part: PartBox, paint: string) {
  a.path(x - part.w / 2 + .004, y - part.h / 2 + .006, part.w, part.h, .03); a.fill('#0b130e50');
  a.path(x - part.w / 2, y - part.h / 2, part.w, part.h, .03);
  a.fill(a.gradient(0, y - part.h / 2, 0, y + part.h / 2, [[0, shade(paint, .28)], [.25, shade(paint, .02)], [1, shade(paint, -.35)]])); a.stroke(OUTLINE, a.edge);
  finishPath(a, { x: x - part.w / 2, y: y - part.h / 2, width: part.w, height: part.h }, { chips: .2, rust: .06, dirt: .18, oil: .025, period: .7 });
  a.circle(x, y - part.h * .05, part.h * .22, HOLLOW, OUTLINE, a.edge);
  a.ctx.beginPath(); a.ctx.arc(x, y - part.h * .05, part.h * .22, Math.PI * .1, Math.PI * .9); a.stroke(GLINT + '50', Math.max(a.hair(1), .002));
  a.line(x - part.w / 2 + .01, y + part.h / 2 - .003, x + part.w / 2 - .01, y + part.h / 2 - .003, '#0f1a1580', Math.max(a.hair(1), .004));
}

// What moves with a wheel of a wheeled chassis, for its axle at `axle` in the frame of the picture, in the paint `paint`
// (a number): the end of the axle, and the spring and the damper between it and the rail. Each shape is its points along
// the frame of the picture and how it is filled or stroked: `round` is a ring of points about a centre, `line` a line
// drawn as thick as `width`.
export function suspensionShapes(model: ChassisModelId, axle: Point, paint: number, dimensions?: ChassisDimensionOptions): SuspensionShape[] {
  const rig = suspensionRig(model, dimensions), shapes: SuspensionShape[] = [], tone = (k: number) => toneOf(paint, k), dark = 0x1d2a22,
    poly = (points: number[], fill: number, line: SuspensionShape['line'] = null) => shapes.push({ points, fill, line }),
    stroke = (points: number[], color: number, width: number) => shapes.push({ points, line: { color, width } }),
    round = (x: number, y: number, r: number, fill: number, line: SuspensionShape['line'] = null, sides = 14) => poly(Array.from({ length: sides }, (_, i: number) => [x + Math.cos(i * TAU / sides) * r, y + Math.sin(i * TAU / sides) * r]).flat(), fill, line),
    bar = (ax: number, ay: number, bx: number, by: number, wide: number) => { const l = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / l * wide / 2, ny = (bx - ax) / l * wide / 2;
      return [ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]; };
  const { x, y } = axle, r = rig.housing;
  if (rig.kind === 'coil') {
    // The coil spring over its damper, from the seat on the end of the axle to the pin of the tower.
    const foot = y + r + .012, head = rig.top - .02, turns = Math.max(3, Math.round((head - foot) / .045)), steps = turns * 8;
    if (head - foot > .08) {
      // The wire of the coil, its turns behind the damper darker than those before it.
      const helix = (front: boolean) => {
        let points: number[] = [];
        const flush = () => { if (points.length >= 4) stroke(points, front ? tone(.95) : tone(.4), rig.wire * (front ? 1 : .8)); points = []; };
        for (let i = 0; i <= steps; i++) {
          const t = i / steps * turns * TAU;
          if (Math.sin(t) > 0 !== front) { flush(); continue; }
          points.push(x + Math.cos(t) * rig.radius, foot + (head - foot) * i / steps);
        }
        flush();
      };
      helix(false);
      poly(bar(x, foot, x, foot + (head - foot) * .5, .016), 0xa7ae96);
      poly(bar(x, foot + (head - foot) * .42, x, head, .045), tone(.55), { color: dark, width: .005 });
      helix(true);
      for (const at of [foot, head]) poly(bar(x - rig.radius * 1.25, at, x + rig.radius * 1.25, at, .012), tone(.5), { color: dark, width: .003 });
    }
    round(x, y, r, tone(.45), { color: dark, width: .006 }); round(x, y, r * .45, tone(.8));
    return shapes;
  }
  // The pack of leaves clamped to the axle, on it (and on its block) or slung under it, its eyes on the pins of the
  // hanger ahead and the shackle behind, arched as the load on the axle bends it: its main leaf on top, the shorter ones
  // under it.
  const seat = rig.over ? y + r + rig.block : y - r, main = rig.over ? seat + (rig.leaves - .5) * rig.leaf : seat,
    sag = main - rig.eye, curve = (k: number, t: number) => rig.eye + sag * (1 - t * t) - k * rig.leaf;
  if (rig.block > .005) poly(bar(x, y + r * .7, x, seat, r * 1.7), tone(.46), { color: dark, width: .004 });
  for (let k = rig.leaves - 1; k >= 0; k--) {
    const reach = rig.span * (1 - k * .19), points = [];
    for (let i = 0; i <= 10; i++) { const t = -1 + 2 * i / 10; points.push(x + t * reach, curve(k, t * reach / rig.span)); }
    stroke(points, k ? tone(.42 - k * .03) : tone(.58), rig.leaf * .92);
    if (!k) stroke(points.map((v: number, i: number) => i % 2 ? v + rig.leaf * .3 : v), tone(.95), rig.leaf * .2);
  }
  for (const side of [-1, 1]) round(x + side * rig.span, rig.eye, rig.leaf * 1.4, tone(.5), { color: dark, width: .005 }, 10);
  // The U-bolts round the axle and the pack, and the plate they clamp: over the pack on the axle, under one slung under it.
  const strap = rig.over ? main + rig.leaf / 2 + .012 : main - rig.leaves * rig.leaf - .012, end = rig.over ? y - r * .55 : y + r * .55,
    way = rig.over ? -1 : 1;
  for (const side of [-1, 1]) stroke([x + side * r * .62, end, x + side * r * .62, strap], tone(.75), .011);
  poly(bar(x - r * 1.05, strap + way * .006, x + r * 1.05, strap + way * .006, .014), tone(.5), { color: dark, width: .004 });
  // The damper, from beside the axle up to its bracket on the rail: its body under, the rod into it.
  const low = { x: x - .15, y: y - .01 }, high = { x: x - .3, y: rig.damper }, mid = { x: low.x + (high.x - low.x) * .55, y: low.y + (high.y - low.y) * .55 };
  poly(bar(mid.x, mid.y, high.x, high.y, .016), 0xa7ae96);
  poly(bar(low.x, low.y, mid.x, mid.y, .042), tone(.5), { color: dark, width: .005 });
  // The end of the axle: its housing, the flange the hub turns on.
  round(x, y, r, tone(.42), { color: dark, width: .006 }); round(x, y, r * .55, tone(.7), { color: dark, width: .004 });
  return shapes;
}
// A colour as a number, `k` times as bright.
const toneOf = (color: number, k: number) => [16, 8, 0].reduce((sum, shift) => sum | Math.round(clamp((color >> shift & 255) * k, 0, 255)) << shift, 0);
