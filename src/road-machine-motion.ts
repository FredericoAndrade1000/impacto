import type { Point } from './math.ts';
import type { BladeRig, PaverRig, RamStages } from './machine-art.ts';
import type { RoadPlace, SectionGround, EdgePoint } from './road-tools.ts';
import type { ModuleSupport } from './construction-contract.ts';
import type { ModuleKind } from './materials.ts';
import type { MetalLook } from './vehicle-art-contract.ts';
import type { GroundSurface } from './ground-impact.ts';
import type { Texture, GraphicsContext, FillInput, StrokeInput } from 'pixi.js';
export interface MotionBox extends Point { w:number;h:number }
export interface BladeHang { y:number;slope:number;half:number }
export type MotionBladeRig = BladeRig & {reach:number};
export type MotionPaverRig = PaverRig & {reach:number;arm:PaverRig['arm'] & {hidden?:number}};
export type MachineRig = MotionBladeRig | MotionPaverRig;
export type MotionPart = 'neck'|'assembly'|'screed'|'auger'|'slide'|'arm';
export interface BladeSurface extends Point {u:number;gap:number;under:number;low:number}
export interface BladePose {drop:number;dx:number;dy:number;stretch:number;shear:number;surface:readonly BladeSurface[]|undefined;down:Point}
export interface ScreedPose {drop:number;dx:number;dy:number;tilt:number}
interface RoadSaying {tool:string;from:number;to:number;idle?:boolean|undefined;short?:boolean|undefined}
interface RoadLaneSource extends RoadSaying {tool:RoadToolKind}
const isToolRoad = (road:RoadSaying|null|undefined,kind:RoadToolKind):road is RoadLaneSource => road?.tool === kind;
export interface RoadLane extends RoadLaneSource {dir:number;done:number|null;movedAt:number}
export interface MachineWorkState {
 time?:number;lanes?:RoadLane[];making?:boolean;working?:boolean;road?:RoadLaneSource;
 toldAt?:number|undefined;lowered?:number;lane?:RoadLane|null|undefined;toolsWere?:readonly number[];run?:number;turn?:number;
}
interface WorkActor {ghost?:unknown;field?:{road?:RoadSaying|null|undefined}|null|undefined}
interface ShapeInk {poly(points:number[]):ShapeInk;fill(style:FillInput):ShapeInk;stroke(style:StrokeInput):ShapeInk;clear():ShapeInk}
export type MetalPaint = (color:string)=>{color:number;alpha:number};
type EarthTone = (typeof GROUND_SURFACES)[GroundSurface];
type PaintedParts<Part extends MotionPart> = {textures:Partial<Record<Part,Texture>>;boxes:Partial<Record<Part,MotionBox>>};
import type { Road, RoadKind, RoadSpan } from './roads.ts';
import type { RoadToolKind } from './road-tools.ts';
export interface RoadWork { tool:RoadToolKind; from:number; to:number; at:number }
export interface RoadsAtWork { roads:readonly Road[]; windows:RoadSpan[]; key:string }
import { Container, Graphics, Sprite } from 'pixi.js';
import { bladeRig, paverRig, moldboard, conveyorSlats, ramStages, stageWidths, machineFineness, RAM, OUTLINE, RECESS, GLINT } from './machine-art.ts';
import { metalColor } from './component-art.ts';
import { NO_ROADS, paved, stretches } from './roads.ts';
import { GROUND_SURFACES } from './ground-impact.ts';
import { TOOL_CONTACT, TOOL_POINT, edgeNeed, outline, reaches, toolNeed } from './road-tools.ts';
import { clamp, smoothstep, TAU } from './math.ts';

// The road machines at work, as the screen shows them (machine-art.ts paints them; server/room.ts tells which work, and
// on what lane of a road): the blade of a grader lowered until its cutting edge meets the ground it leaves graded, cutting
// the bumps over it, with a roll of earth along its face; the screed of a paver set down on the ground under the rear end
// of its piece and seated on it, its auger with it and its tow arm drawn out, shaking a little, its conveyor running and its
// auger turning, the hot mix steaming behind it. Each goes down plumb, whatever the slope its vehicle stands on, and so
// meets the ground straight under where it travels (road-tools.ts), as far as it reaches (its piece's `toolReach`): one
// that does not reach the ground hangs over it as low as it goes, and the field makes no road with it (server/road-works.ts).
// They go down and up again in a second as their work begins and ends. What moves is drawn on every frame only for a
// machine on the screen near enough to see it
// (`ROAD_MOTION_ZOOM`), out of pictures of its parts painted once; the rest of it is the picture it travels with, and a
// machine at rest retains its complete picture; the column a blade hangs by is drawn with it (`drawBladeSupports`).
//
// The field lays the road a machine makes ten metres at a time (server/road-works.ts), as far as its tools reach, a little
// ahead of where they work; the screen shows it made as far as they have gone over the lane it is on — the middle of the
// cutting edge of a blade, the trailing edge of the screed of a paver (`toolAt`) — and the lane ahead of them as it was
// (`roadsAtWork`), so the road comes out from under the blade and from behind the screed as they go.
export const ROAD_MOTION_ZOOM = 4;
// Closer than this, the earth, the dust and the steam they raise, and the shaking of the screed.
export const ROAD_DETAIL_ZOOM = 14;
// How long the tool takes to go down or up, and how long its last lane remains available for presentation.
// Work cycles stop as soon as the current field frame reports no work.
export const LOWER_SECONDS = 1, ROAD_HOLD = 1.5;
// What each tool makes of the ground of its lane, and what that ground was before.
const ROAD_MADE = Object.freeze({ blade: 'graded', paver: 'asphalt' } as const), ROAD_UNDER = Object.freeze({ blade: null, paver: 'graded' } as const);
// How fast the road shown made catches up with a tool ahead of it — gone down past where its lane begins, or on into a lane
// the field had not told yet —, or with what the field laid of a lane: as fast as the tool goes along it, and faster than
// that by `SWEEP` metres a second and by `CATCH` of its own pace, so that it catches up with one however fast; and how
// long a lane the machine is no longer on stays shown once it comes no further.
const SWEEP = 3, CATCH = .5, LANE_STALL = 3;
// The pace of the paver's conveyor, in metres a second, and of its auger, in turns a second; how far its screed shakes, and how often.
const SLAT_SPEED = .25, AUGER_TURNS = 1, SHAKE = .0025, SHAKE_HZ = 15;

const rigs = new Map<string,MachineRig>(), hangs = new WeakMap<ModuleSupport,{mirrored:boolean;W:number;H:number;hang:BladeHang|null}>();
// The places of the parts of a machine of a size (machine-art.ts), a blade as it hangs (`bladeHang`), its tool going down
// `reach` metres at the most (its piece's `toolReach`), worked out once: its rams, and the tow arm of a paver, reach as far.
export function machineRig(kind:'blade',W:number,H:number,hang?:BladeHang|null,reach?:number):MotionBladeRig;
export function machineRig(kind:'paver',W:number,H:number,hang?:BladeHang|null,reach?:number):MotionPaverRig;
export function machineRig(kind:RoadToolKind,W:number,H:number,hang?:BladeHang|null,reach?:number):MachineRig;
export function machineRig(kind:RoadToolKind, W:number, H:number, hang:BladeHang|null = null, reach = 0):MachineRig {
  const key = `${kind}:${W.toFixed(4)}:${H.toFixed(4)}:${hang ? [hang.y, hang.slope, hang.half].join(',') : ''}:${reach.toFixed(4)}`;
  if (!rigs.has(key)) rigs.set(key, kind === 'blade' ? bladeReach(bladeRig(W, H, hang), reach) : paverReach(paverRig(W, H), reach));
  return rigs.get(key)!;
}
// How far either way of upright the vehicle of a road machine leans at the most where it works, for what holds its tool to
// reach as far as it goes down there: what it leans further it may go down as far, its rams drawn out further.
const LEAN = Math.PI / 6;
// How far a place `p` of a machine's picture goes from `from` at the most, `reach` metres down plumb from it on any slope
// within `LEAN`.
function farthest(from:Point,p:Point,reach:number) {
  const ax = p.x - from.x, ay = p.y - from.y, turn = clamp(Math.atan2(-ax, ay), -LEAN, LEAN);
  return Math.hypot(ax - reach * Math.sin(turn), ay + reach * Math.cos(turn));
}
// How many tubes a ram has at the most (machine-art.ts `ramStages`): one that must draw out further than that many reach,
// as one under the metal right over its tool, draws out each of them further.
const STAGES = 7;
// A ram that draws out to `longest`: with as many stages hidden in it as it takes, beyond those it shows.
function stagedTo<R extends RamStages>(ram:R,longest:number) {
  const shown = ram.shown.length, past = longest - ram.barrel - shown * ram.most;
  let hidden = past > 1e-9 ? Math.ceil(past / ram.most - 1e-9) : 0, most = ram.most;
  if (!(shown + hidden <= STAGES - 1)) { hidden = STAGES - 1 - shown; most = (longest - ram.barrel) / (STAGES - 1); }
  return Object.assign(ram, { hidden, most });
}
// A blade whose rams draw out as far as it goes down. One that hangs from metal draws them out of its clevises, its rams
// drawn out of more stages than they show as it travels, as far as it needs; held otherwise, each comes down from further
// up out of its picture, its barrel the longer, as long as its rod needs to draw out of it.
function bladeReach(rig:BladeRig,reach:number):MotionBladeRig {
  const completed = Object.assign(rig,{reach});
  for (const name of ['lift', 'shift'] as const) {
    const ram = rig[name], longest = farthest(ram.top, ram.foot, reach), rod = ram.shown[0]!;
    if (rig.hang) { stagedTo(ram, longest); continue; }
    const up = Math.max(0, longest - 2 * ram.barrel + rod), length = Math.hypot(ram.foot.x - ram.top.x, ram.foot.y - ram.top.y);
    ram.top = { x: ram.top.x - (ram.foot.x - ram.top.x) * up / length, y: ram.top.y - (ram.foot.y - ram.top.y) * up / length };
    ram.barrel += up; ram.most = ram.barrel - rod; ram.hidden = 0;
  }
  return completed;
}
// How far either way a screed turns at most about its trailing edge to sit on the ground (`SEAT`), read at as many turns.
const SEATS = 8;
// A paver whose lift ram and tow arm draw out as far as its screed goes down, turned as it sits: the ram out of more stages
// than it shows as it travels, and the arm out of more beams, hidden in the one pinned to the tow point as it travels
// (`arm.hidden`), as far as each needs.
function paverReach(rig:PaverRig,reach:number):MotionPaverRig {
  const completed = Object.assign(rig,{reach});
  const turns = Array.from({ length: SEATS * 2 + 1 }, (_, i) => SEAT * (i / SEATS - 1)),
    most = (from:Point,p:Point) => Math.max(...turns.map(tilt => farthest(from, screedPoint(rig, { dx: 0, dy: 0, tilt }, p), reach))),
    { arm } = rig, beam = arm.inner - arm.overlap, past = most(rig.tow, rig.pin) - (arm.outer + arm.inner - arm.overlap);
  stagedTo(rig.lift, most(rig.lift.top, rig.lift.foot));
  return Object.assign(completed,{arm:Object.assign(arm,{hidden:past > 1e-9 ? Math.ceil(past / beam - 1e-9) : 0})});
}
// What a blade hangs from, as the core admitted it (game_construction.rs `standoff`: the `support` of the piece), in its
// picture (road-tools.ts `placeOf`): the underside of the metal over it `y` over the middle of its box, rising by `slope` towards the
// front of the picture, and how far either way of that middle the column it hangs by reaches (`half`). None for a blade
// held otherwise, by metal beside it.
export function bladeHang(module: {kind:ModuleKind;width:number;height:number;mirrored?:boolean|undefined;support?:ModuleSupport|undefined} | null | undefined):BladeHang|null {
  const support = module?.kind === 'blade' ? module.support : null;
  if (!(support && support.reach !== undefined && support.reach >= 0)) return null;
  const mirrored = Boolean(module!.mirrored), W = module!.width, H = module!.height, kept = hangs.get(support);
  if (kept?.mirrored === mirrored && kept.W === W && kept.H === H) return kept.hang;
  const m = mirrored ? -1 : 1, feet = support.foot.map(p => ({ X: W / 2 + m * p.x, Y: H / 2 - p.y })), a = feet[0]!, b = feet[1]!, run = b.X - a.X,
    round = (value:number) => Math.round(value * 1e4) / 1e4,
    hang = Math.abs(run) > 1e-9 ? { y: round(a.Y + (b.Y - a.Y) * (W / 2 - a.X) / run), slope: round((b.Y - a.Y) / run), half: round(Math.abs(run) / 2) } : null;
  hangs.set(support, { mirrored, W, H, hang });
  return hang;
}
// What the frame at `time` tells of a road machine (`field.road`): none for a broken tool or one of another kind.
// The lane is retained briefly (`ROAD_HOLD`), but cycles run only while the current frame says its tool worked (no `idle`),
// on the lane it is told (`machine.lane`), and makes the road of it only while this frame says
// so (`machine.making`); the screen keeps the lanes it was on till the road shown on them comes no further
// (`machine.lanes`), and how far it has come along each is for `advanceLanes` to say. A machine whose tools do not reach
// the ground (`short`) makes none, its tool down as far as it goes. A ghost stands as it was last seen, its lanes gone.
// Returns the seconds since the frame before, none when the frames went back.
export function followWork(machine:MachineWorkState,actor:WorkActor|null|undefined,module:{kind:RoadToolKind;health?:number|undefined},time:number):number {
  const said = !actor?.ghost && module.health! > 0 ? actor?.field?.road : null,
    told = isToolRoad(said,module.kind) ? said : null,
    back = time < machine.time!, dt = machine.time === undefined || back || actor?.ghost ? 0 : Math.min(time - machine.time, .25);
  if (back) Object.assign(machine, { lanes: [], toldAt: undefined, lowered: 0 });
  machine.time = time; machine.lanes ??= []; machine.making = Boolean(told && !told.idle && !told.short);
  if (actor?.ghost) machine.lanes.length = 0;
  if (told) { machine.road = told; machine.toldAt = time; }
  const road = !actor?.ghost && time - (machine.toldAt ?? -Infinity) < ROAD_HOLD ? machine.road : null;
  machine.working = machine.making || Boolean(told?.short);
  machine.lane = road && machine.lanes.find(lane => lane.from === road.from && lane.to === road.to);
  if (road && !machine.lane)
    machine.lanes.push(machine.lane = { tool: road.tool, from: road.from, to: road.to, dir: Math.sign(road.to - road.from) || 1, done: null, movedAt: time });
  return dt;
}
// The tool goes down while the machine works and up when it stops, over `LOWER_SECONDS`; the conveyor and the auger of a
// paver run while it makes road.
export function lower(machine:MachineWorkState,dt:number) {
  machine.lowered = clamp((machine.lowered ?? 0) + (machine.working ? dt : -dt) / LOWER_SECONDS, 0, 1);
  if (machine.making) { machine.run = (machine.run ?? 0) + dt * SLAT_SPEED; machine.turn = ((machine.turn ?? 0) + dt * AUGER_TURNS * TAU) % TAU; }
}
// How far the road the machine makes has come along each of its lanes, with its vehicle's tools of its kind where they work
// along the ground now (`tools`, `toolAt`): on the lane it makes with its tool down, as far as the hindmost of them along
// it, behind which the field makes the road; on any other, and while its tool is up or the field says it makes none, as far
// as the field laid it (`roads`). It begins as far as the field laid it — a machine takes a lane up again where it left it,
// after going for fuel or for more of what it lays —, and comes no further back than it had come, no further than the end
// of its lane; on as far as the tools went along it since the frame before (`toolsWere`), and on from there to catch up
// (`SWEEP`, `CATCH`). A lane the machine is no longer on goes once the road shown on it is at its end, or comes no further.
export function advanceLanes(machine:MachineWorkState,tools:readonly number[],dt:number,roads:readonly Road[] = NO_ROADS) {
  const lanes = machine.lanes!, on = machine.making && machine.lowered! >= 1 ? machine.lane : null, were = machine.toolsWere ?? tools;
  for (const lane of lanes) {
    const length = Math.abs(lane.to - lane.from), laid = laidAlong(roads, lane), hindmost = (at:readonly number[]) => lane.dir > 0 ? Math.min(...at) : Math.max(...at),
      hind = hindmost(tools), went = Math.max(0, (hind - hindmost(were)) * lane.dir),
      goal = lane === on ? clamp((hind - lane.from) * lane.dir, 0, length) : laid;
    lane.done ??= laid;
    if (goal > lane.done) { lane.done = Math.min(goal, lane.done + (1 + CATCH) * went + SWEEP * dt); lane.movedAt = machine.time!; }
  }
  machine.toolsWere = tools;
  machine.lanes = lanes.filter(lane => lane === machine.lane || lane.done! < Math.abs(lane.to - lane.from) && machine.time! - lane.movedAt < LANE_STALL);
}
// How far along a lane, from where it begins, the field has laid what its tool makes, with nothing else between.
function laidAlong(roads:readonly Road[],lane:RoadLane) {
  const [a, b] = lane.dir > 0 ? [lane.from, lane.to] : [lane.to, lane.from], spans = stretches(roads, a, b, ROAD_MADE[lane.tool]),
    run = lane.dir > 0 ? spans[0]?.[0]! <= a + .01 && spans[0] : spans.at(-1)?.[1]! >= b - .01 && spans.at(-1);
  return run ? run[1] - run[0] : 0;
}
// What the machine makes on the screen, for `roadsAtWork`: each of its lanes, and how far along it the road has come.
export const worksOf = (machine:MachineWorkState,tool:RoadToolKind):RoadWork[] => machine.lanes!.map(lane => ({ tool, from: lane.from, to: lane.to, at: lane.from + lane.dir * lane.done! }));

// The column a blade hangs by (`bladeRig` `hang`), from its saddle up to the underside of the metal over it, and its rams
// from their clevises under that down to the top of its box, where its picture takes them up: drawn for one on the screen
// near enough, as it travels or `pose` down (`bladePose`). The column is a box of steel with a flange bolted up under the
// metal and a shoe bolted down on the saddle, stayed by gussets at either end; each ram hangs from a clevis under the flange,
// as many of its stages as are drawn out over the box (`ramStages`).
export function drawBladeSupports(g:Graphics|GraphicsContext,rig:MotionBladeRig,place:RoadPlace,{pose = null,pixel,look}:{pose?:Pick<BladePose,'dx'|'dy'>|null;pixel:number;look:MetalLook|null|undefined}) {
  const hang = rig.hang;
  if (!hang) return;
  const origin = place.world(0, 0), xAxis = place.world(1, 0), yAxis = place.world(0, 1), context = 'context' in g ? g.context : g,
    paint = (text:string) => ({ color: metalColor(parseInt(text.slice(1, 7), 16), look), alpha: text.length > 7 ? parseInt(text.slice(7), 16) / 255 : 1 }),
    plate = (points:readonly Point[],color:string,edge=true) => {
      context.poly(points.flatMap(p => [p.x, p.y])).fill(paint(color));
      if (edge) context.stroke({ width: pixel, ...paint(OUTLINE) });
    },
    pin = (p:Point,width:number) => {
      const r = Math.max(pixel, width) * .65;
      disc(context,p.x,p.y,r,12).fill(paint(OUTLINE));
      disc(context,p.x,p.y,r*.82,12).fill(paint(RAM.eye));
      disc(context,p.x,p.y,r*.43,10).fill(paint(RAM.pin));
    },
    nut = (x:number,y:number,w:number,down:number) => {
      plate([{ x: x - w * .6, y }, { x: x + w * .6, y }, { x: x + w * .6, y: y + down * w * .16 }, { x: x - w * .6, y: y + down * w * .16 }], RAM.pin);
      plate([{ x: x - w / 2, y: y + down * w * .16 }, { x: x + w / 2, y: y + down * w * .16 }, { x: x + w / 2, y: y + down * w * .75 }, { x: x - w / 2, y: y + down * w * .75 }], '#9aa38b');
    };
  const { under, middle, clevis } = hang, half = hang.half!, { d, s } = rig, reach = -under(middle), x0 = middle - half, x1 = middle + half,
    mast = half * .45, flange = Math.min(.02 * s, reach * .2), shoe = Math.min(.016 * s, reach * .15), bolt = Math.min(.014 * s, half * .12),
    top = (x:number) => under(x) + flange, room = Math.min(-shoe - top(middle - mast), -shoe - top(middle + mast));
  context.save().transform(xAxis.x - origin.x, xAxis.y - origin.y, yAxis.x - origin.x, yAxis.y - origin.y, origin.x, origin.y);
  if (reach > 0) {
    if (room > d) {
      for (const side of [-1, 1]) {
        // Gussets from the flange and the shoe to the box of the column, as far as they fit.
        const edge = middle + side * half * .9, at = middle + side * mast, high = Math.min(half * 1.2, room * .3), low = Math.min(half, room * .25),
          tone = side < 0 ? '#56614c' : '#3f4a38';
        plate([{ x: edge, y: top(edge) }, { x: at, y: top(at) }, { x: at, y: top(at) + high }], tone);
        plate([{ x: edge, y: -shoe }, { x: at, y: -shoe }, { x: at, y: -shoe - low }], tone);
      }
      const box = [{ x: middle - mast, y: top(middle - mast) }, { x: middle + mast, y: top(middle + mast) }, { x: middle + mast, y: -shoe }, { x: middle - mast, y: -shoe }];
      plate(box, '#4b5742');
      plate([box[0]!, { x: middle - mast * .45, y: top(middle - mast * .45) }, { x: middle - mast * .45, y: -shoe }, box[3]!], GLINT + '30', false);
      plate([{ x: middle + mast * .5, y: top(middle + mast * .5) }, box[1]!, box[2]!, { x: middle + mast * .5, y: -shoe }], OUTLINE + '50', false);
    }
    plate([{ x: x0, y: under(x0) }, { x: x1, y: under(x1) }, { x: x1, y: top(x1) }, { x: x0, y: top(x0) }], '#46513f');
    plate([{ x: x0, y: -shoe }, { x: x1, y: -shoe }, { x: x1, y: 0 }, { x: x0, y: 0 }], '#46513f');
    for (const x of [x0 + half * .22, x1 - half * .22]) { nut(x, top(x), bolt, 1); nut(x, -shoe, bolt, -1); }
  }
  for (const name of ['shift', 'lift'] as const) {
    const ram = rig[name], { top: hung, foot } = ram;
    if (!(hung.y < 0)) continue;
    // The clevis down from the flange to the pin.
    const lug = d * .75;
    plate([{ x: hung.x - lug, y: top(hung.x - lug) }, { x: hung.x + lug, y: top(hung.x + lug) }, { x: hung.x + lug, y: hung.y }, { x: hung.x - lug, y: hung.y }], '#46513f');
    disc(context, hung.x, hung.y, lug, 16).fill(paint('#46513f')).stroke({ width: pixel, ...paint(OUTLINE) });
    // The true top is fixed above the texture. Show only the ram stretch clipped above Y=0, its stages as it is drawn out.
    const lower = { x: foot.x + (pose?.dx ?? 0), y: foot.y + (pose?.dy ?? 0) }, length = Math.hypot(lower.x - hung.x, lower.y - hung.y);
    if (!(length > 0)) continue;
    const upper = lower.y > 0 ? length * -hung.y / (lower.y - hung.y) : length,
      at = (k:number) => ({ x: hung.x + (lower.x - hung.x) * k / length, y: hung.y + (lower.y - hung.y) * k / length }),
      stages = ramStages(ram, length), widths = stageWidths(ram);
    for (let i = stages.length - 1; i >= 0; i--) {
      const [from, to] = stages[i]!, end = Math.min(to, upper);
      if (end > from) bar(context, at(from), at(end), d * widths[i]!, i ? RAM.rod : RAM.barrel, pixel, paint);
    }
    pin(hung, d * 1.2);
  }
  context.restore();
}

// The cutting edge painted on the moldboard (machine-art.ts `moldboard`), from its heel at the near end to its toe at the
// far one. It cuts level across the way, along the foot of its box (road-tools.ts `bladeEdge`): on the picture it rises
// towards its toe by `rise`, as the ground does going away from the eye, and that rise is how far off it is, not how high.
export const cuttingEdge = (rig:BladeRig) => { const { foot } = moldboard(rig), heel = foot(0), toe = foot(1); return { heel, toe, rise: heel.y - toe.y }; };
// How steep the earth a blade pushes stands at the ends of where it bites, as loose earth does: some 35°.
const REPOSE = Math.tan(35 * Math.PI / 180);
// How high an outline (`outline`) is at a share `u` of its edge.
function heightAt(points:readonly EdgePoint[],u:number) {
  let low = 1, high = points.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle]!.u < u) low = middle + 1; else high = middle; }
  const a = points[low - 1]!, b = points[low]!;
  return b.u === u || b.u === a.u ? b.y : a.y + (b.y - a.y) * (u - a.u) / (b.u - a.u);
}
// How far a blade goes down plumb for its cutting edge, level across the way (`cuttingEdge`), to meet the ground it leaves
// graded (`graded`, road-tools.ts `gradedGround`) where that is highest under it (road-tools.ts `toolNeed`), as far as it
// reaches (`drop`, `machineRig`), and whether it does meet it (road-tools.ts `reaches`: `contact`). It rests on the line
// of the ground, its ramps and its steps, as graded earth lies on it, and cuts what of the
// ground as it lies (`ground`) stands over that: the bumps of natural ground. Along its edge (`surface`), from its heel to
// its toe, at every corner of the ground under it and wherever the two grounds cross: where on the picture its foot is
// (`x`, `y`); how far plumb under the edge as it travels the ground it leaves lies (`gap`), and the ground as it lies
// (`under`); and how far plumb under its foot as painted the ground as it lies is drawn (`low`), where its earth lies.
export function bladeDrop(rig:MotionBladeRig,place:RoadPlace,graded:SectionGround,ground:SectionGround=graded) {
  const { heel, toe } = cuttingEdge(rig), from = place.world(heel.x, heel.y), to = place.world(toe.x, heel.y), foot = place.world(toe.x, toe.y),
    lines = [outline(graded, from, to), graded === ground ? null : outline(ground, from, to), outline(ground, from, foot)],
    level = (u:number) => from.y + (to.y - from.y) * u, painted = (u:number) => from.y + (foot.y - from.y) * u,
    read = (u:number):BladeSurface => {
      const [made, lies, drawn] = lines.map(line => line && heightAt(line, u));
      return { u, x: heel.x + (toe.x - heel.x) * u, y: heel.y + (toe.y - heel.y) * u,
        gap: level(u) - made!, under: level(u) - (lies ?? made!), low: painted(u) - drawn! };
    },
    us = [...new Set(lines.flatMap(line => line ? line.map(p => p.u) : []))].sort((a, b) => a - b), surface:BladeSurface[] = [];
  // Between two places of it each ground is straight, and so is the nearer of the two where they cross.
  for (const u of us) {
    const p = read(u), last = surface.at(-1);
    if (last && (last.gap - last.under) * (p.gap - p.under) < 0) surface.push(read(last.u + (u - last.u) * (last.gap - last.under) / (last.gap - last.under - p.gap + p.under)));
    surface.push(p);
  }
  // Its edge, and the ground it leaves under it, are road-tools.ts `toolNeed`'s, read once.
  const need = edgeNeed(lines[0]!, from, to);
  return { drop: clamp(need, 0, rig.reach), contact: reaches('blade', need, rig.reach), surface };
}
// Whether a blade `pose` down bites at a place along its edge (`bladeDrop`): the ground it leaves, or the ground as it
// lies, is no further under its edge than it may stand and bite (road-tools.ts `TOOL_CONTACT`), or stands over it.
export const biting = (pose:Pick<BladePose,'drop'>,p:Pick<BladeSurface,'gap'|'under'>) => Math.min(p.gap, p.under) - pose.drop <= TOOL_CONTACT.blade;
// Where the earth a blade `pose` down pushes lies at a place along its edge (`bladeDrop`), on its picture: on the foot of
// the moldboard, or plumb under it on the ground drawn there, where that is lower; nothing of it stands in the air.
export function earthFoot(pose:Pick<BladePose,'drop'|'down'>,p:Point & {low:number}) {
  const h = Math.max(pose.drop, p.low);
  return { x: p.x + pose.down.x * h, y: p.y + pose.down.y * h };
}
// The circle and the moldboard of a blade `drop` metres plumb lower than it travels (`down`), `dx` and `dy` in its
// picture: they go down with the yoke, and the neck of the drawbar from the ball to the yoke reaches it, drawn out or in
// along it by `stretch` and leant down by `shear`, the drop of its rear for each metre back.
export function bladePose(rig:BladeRig,down:Point,drop:number,surface:readonly BladeSurface[]|undefined):BladePose {
  const dx = down.x * drop, dy = down.y * drop, back = rig.pin.x - rig.ball.x;
  return { drop, dx, dy, stretch: (back + dx) / back, shear: dy / (back + dx), surface, down };
}
// How far the screed of a paver turns at most about its trailing edge, either way, to sit on the ground under it.
const SEAT = .2;
// The screed of a paver set down `drop` metres plumb from where it travels (`down`), no further than it reaches
// (`machineRig`), `dx` and `dy` in its picture, and turned by `tilt` about its trailing edge, where the field lays the
// asphalt behind it (`toolAt`): the ram it hangs from and the tow arm draw out as far, as they hold it turned.
export function screedPose(rig:MotionPaverRig,down:Point,drop:number,tilt=0):ScreedPose {
  const d = clamp(drop, 0, rig.reach);
  return { drop: d, dx: down.x * d, dy: down.y * d, tilt };
}
// Where a place of the screed as it travels (`p`) stands with the screed set as `pose`.
export function screedPoint(rig:PaverRig,pose:Pick<ScreedPose,'tilt'|'dx'|'dy'>,p:Point) {
  const { x0, foot } = rig.screed, c = Math.cos(pose.tilt), s = Math.sin(pose.tilt), u = p.x - x0, v = p.y - foot;
  return { x: x0 + c * u - s * v + pose.dx, y: foot + s * u + c * v + pose.dy };
}
// The tow arm of a paver with its screed set as `pose`: from the tow point back and down to the pin on the screed, turned
// down about the tow point by `turn` and `reach` long.
export function towArm(rig:PaverRig,pose:ScreedPose) {
  const { tow, pin } = rig, to = screedPoint(rig, pose, pin);
  return { turn: Math.atan2(to.y - tow.y, to.x - tow.x) - Math.atan2(pin.y - tow.y, pin.x - tow.x), reach: Math.hypot(to.x - tow.x, to.y - tow.y) };
}
// How a screed is set down on the ground: plumb, for its trailing edge to meet the ground under it (`drop`) as far as it
// goes, and turned about that edge as the ground lies under its skid (`tilt`), as far as it turns, for the skid to sit on
// it — a screed is towed, and floats on the mix it lays, level with the ground behind its tractor however that leans —;
// its nose no higher than it travels. Whether it meets the ground (road-tools.ts `reaches`: `contact`).
export function screedDrop(rig:MotionPaverRig,place:RoadPlace,ground:SectionGround) {
  const { screed } = rig, edge = place.world(screed.x0, screed.foot), front = place.world(screed.x0 + screed.skid, screed.foot).x,
    need = toolNeed('paver', place, ground), lie = place.along(front - edge.x, ground.height(front) - ground.height(edge.x)),
    up = Math.min(SEAT, Math.asin(Math.min(1, place.down.y * Math.max(0, need) / rig.parts.screed.w))),
    tilt = clamp(Math.atan2(lie.y, lie.x), -up, SEAT), set = screedPose(rig, place.down, need, tilt);
  return { drop: set.drop, tilt, contact: reaches('paver', need, rig.reach) };
}
// Where along the ground a machine's tool works, as the field has it (road-tools.ts, server/road-works.ts `at`): plumb
// under its point as it travels. `place` lays its box, `W` by `H`.
export const toolAt = (kind:RoadToolKind,place:RoadPlace,W:number,H:number) => place.world(TOOL_POINT[kind].x * W, TOOL_POINT[kind].y * H).x;

const centimetre = (x: number) => Math.round(x * 100) / 100;
// The roads with the ground between two places that is of `from` — a kind of road, or null for none — made `to`.
function relaid(roads: readonly Road[], a: number, b: number, from: RoadKind | null, to: RoadKind | null): readonly Road[] {
  for (const [x0, x1] of stretches(roads, centimetre(a), centimetre(b), from)) {
    if (!(x1 - x0 >= .01)) continue;
    roads = to ? paved(roads, x0, x1, to) : Object.freeze(roads.flatMap(road => road.x1 <= x0 || road.x0 >= x1 ? [road]
      : [road.x0 < x0 ? Object.freeze({ ...road, x1: x0 }) : null, road.x1 > x1 ? Object.freeze({ ...road, x0: x1 }) : null].filter((road): road is Road => Boolean(road))));
  }
  return roads;
}
// The roads of the field as the screen shows them where machines work (`works`, each its tool, the lane it makes from
// `from` to `to`, and where along it the road has come, `at`): on the lane, what was made of it up to there, and ahead of
// it the ground as it was. Returns them, the stretches of ground they differ there (`windows`, in order, none touching), and
// what tells apart how the roads are drawn outside those (`key`): the stretches, and the roads that cross their ends.
export function roadsAtWork(roads: readonly Road[], works: readonly RoadWork[]): RoadsAtWork {
  const spans: RoadSpan[] = [];
  for (const { tool, from, to, at } of works) {
    const dir = Math.sign(to - from) || 1, tip = from + dir * clamp((at - from) * dir, 0, (to - from) * dir);
    roads = relaid(roads, Math.min(from, tip), Math.max(from, tip), ROAD_UNDER[tool], ROAD_MADE[tool]);
    if ((to - tip) * dir > 0) roads = relaid(roads, Math.min(tip, to), Math.max(tip, to), ROAD_MADE[tool], ROAD_UNDER[tool]);
    spans.push([Math.min(from, to), Math.max(from, to)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const windows: RoadSpan[] = [];
  for (const [a, b] of spans) { const last = windows.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else windows.push([a, b]); }
  const crossing = (x: number) => roads.find(road => road.x0 < x && road.x1 > x)?.kind ?? '';
  return { roads, windows, key: windows.map(([a, b]) => `${a}:${b}:${crossing(a)}:${crossing(b)}`).join('|') };
}

// What is painted of each machine apart from what stays with the vehicle, as the rig names it.
export const MOTION_PARTS = Object.freeze({ blade: ['neck', 'assembly'] as const, paver: ['screed', 'auger', 'slide', 'arm'] as const });
// The box of a part's picture, as its rig has it, set on the pixels of the picture of the whole box: the two are painted
// at one fineness (machine-art.ts `machineCanvas`), and a part shows as the whole did.
export function partBox(rig:{parts:Partial<Record<MotionPart,MotionBox>>},part:MotionPart,W:number,H:number):MotionBox {
  const box = rig.parts[part]!, perMetre = machineFineness(W, H), snap = (v:number) => Math.round(v * perMetre) / perMetre,
    x = snap(box.x), y = snap(box.y);
  return { x, y, w: snap(box.x + box.w) - x, h: snap(box.y + box.h) - y };
}
// The marks of the hits a piece took (textures.ts `paintComponentDamage`) that fall on the picture of one of its parts:
// Native marks use the rotational frame of the piece. Unreflect that frame before cropping its canonical picture.
export function partMarks<Mark extends {u:number;v:number;radiusU?:number;dx?:number}>(marks:readonly Mark[],box:MotionBox,W:number,H:number,mirrored=false) {
  return marks.flatMap(mark => {
    const u = ((mirrored ? 1 - mark.u : mark.u) * W - box.x) / box.w, v = (mark.v * H - box.y) / box.h;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [{ ...mark, u, v, ...(mark.radiusU ? { radiusU: mark.radiusU * W / box.w } : {}),
      ...(mirrored && mark.dx !== undefined ? { dx: -mark.dx } : {}) }] : [];
  });
}

// The colours of the machine as its metal shows them (component-art.ts `metalColor`), for each colour told as text.
export function metalPaint(look:MetalLook|null|undefined):MetalPaint {
  const known = new Map<string,{color:number;alpha:number}>();
  return (text:string) => {
    if (!known.has(text)) known.set(text, { color: metalColor(parseInt(text.slice(1, 7), 16), look), alpha: text.length > 7 ? parseInt(text.slice(7), 16) / 255 : 1 });
    return known.get(text)!;
  };
}
// Pixi lays out the curves it draws by their size in the units they are drawn in, and these are drawn in metres: a round
// of a few centimetres would be a square. Each is laid out here instead, in as many corners as a close view needs.
// A disc about (x, y), its corners turned by `turn` and moved in or out by `rough` (a share of the radius at each).
function disc(g:ShapeInk,x:number,y:number,r:number,corners=20,turn=0,rough:readonly number[]|null=null) {
  const points = [];
  for (let i = 0; i < corners; i++) { const a = turn + i * TAU / corners, k = rough ? 1 + rough[i % rough.length]! : 1; points.push(x + Math.cos(a) * r * k, y + Math.sin(a) * r * k); }
  return g.poly(points);
}
// A bar `w` wide from `a` to `b`, round at either end.
function capsule(g:ShapeInk,a:Point,b:Point,w:number) {
  const turn = Math.atan2(b.y - a.y, b.x - a.x), h = w / 2, points = [];
  for (const [p, from] of ([[a, turn + Math.PI / 2], [b, turn - Math.PI / 2]] satisfies [Point,number][]))
    for (let i = 0; i <= 8; i++) { const t = from + Math.PI * i / 8; points.push(p.x + Math.cos(t) * h, p.y + Math.sin(t) * h); }
  return g.poly(points);
}
// A box with its corners rounded by `r`.
function roundBox(g:ShapeInk,x:number,y:number,w:number,h:number,r:number) {
  const points = [];
  for (const [cx, cy, from] of ([[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]] satisfies [number,number,number][]))
    for (let i = 0; i <= 6; i++) { const t = from + Math.PI / 2 * i / 6; points.push(cx + Math.cos(t) * r, cy + Math.sin(t) * r); }
  return g.poly(points);
}
// The ground a picture with recesses is painted on (machine-art.ts `underlay`), as solid as `alpha`.
function backing(g:ShapeInk,W:number,H:number,alpha:number) {
  g.clear();
  if (alpha > 0) roundBox(g, 0, 0, W, H, Math.min(.012, W * .04, H * .04)).fill({ color: parseInt(RECESS.slice(1), 16), alpha });
}
// A bar of steel `width` wide from `a` to `b`, square at its ends, outlined and lit along its upper side, `pixel` metres to
// a pixel of the screen; `paint` tells its colours (`metalPaint`).
function bar(g:ShapeInk,a:Point,b:Point,width:number,color:string,pixel:number,paint:MetalPaint) {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (!(length > 1e-10)) return;
  const half = Math.max(pixel, width) / 2, nx = -dy / length, ny = dx / length,
    strip = (left:number,right:number,shade:string) => g.poly([a.x + nx*left, a.y + ny*left, b.x + nx*left, b.y + ny*left,
      b.x + nx*right, b.y + ny*right, a.x + nx*right, a.y + ny*right]).fill(paint(shade));
  strip(-half-pixel, half+pixel, OUTLINE); strip(-half, half, color);
  strip(-half*.8, -half*.1, GLINT+'50'); strip(half*.55, half, OUTLINE+'70');
}
// A tube drawn as machine-art.ts paints one (its `tube`), `pixel` metres to a pixel of the screen.
function tube(g:ShapeInk,a:Point,b:Point,d:number,color:string,pixel:number,paint:MetalPaint) {
  const edge = Math.max(pixel * 1.2, .0028), lit = { x: 0, y: -d * .24 };
  capsule(g, a, b, d + edge * 1.4).fill(paint(OUTLINE)); capsule(g, a, b, d).fill(paint(color));
  capsule(g, { x: a.x + lit.x, y: a.y + lit.y }, { x: b.x + lit.x, y: b.y + lit.y }, Math.max(pixel, d * .2)).fill(paint(GLINT + '50'));
}
function eye(g:ShapeInk,p:Point,d:number,pixel:number,paint:MetalPaint) {
  disc(g, p.x, p.y, d * .6).fill(paint(RAM.eye)).stroke({ width: pixel, ...paint(OUTLINE) });
  disc(g, p.x, p.y, d * .24, 12).fill(paint(RAM.pin));
}
// A ram from the pin of its barrel at `top` to the pin of its last stage at `foot`, its tubes where `ramStages` lays them
// out for `ram` (its rig's), each as thick as `stageWidths` has it: a stage drawn out no way at all shows nothing. One whose
// barrel comes down into the box from above `clip`, out of what hangs it, starts just under that edge, where what it hangs
// from hides its end, and shows no eye there.
function drawRam(g:ShapeInk,top:Point,foot:Point,d:number,ram:BladeRig['lift'],pixel:number,paint:MetalPaint,clip=-Infinity) {
  const length = Math.hypot(foot.x - top.x, foot.y - top.y), ux = (foot.x - top.x) / length, uy = (foot.y - top.y) / length,
    at = (k:number) => ({ x: top.x + ux * k, y: top.y + uy * k }), cut = top.y < clip && uy > 0 ? (clip + d * .6 - top.y) / uy : 0,
    stages = ramStages(ram, length), widths = stageWidths(ram), last = stages.length - 1;
  for (let i = last; i >= 0; i--) {
    const from = Math.max(cut, Math.min(stages[i]![0], length)), to = i === last ? length : Math.min(stages[i]![1], length);
    if (to > from || i === last) tube(g, at(from), at(to), d * widths[i]!, i ? RAM.rod : RAM.barrel, pixel, paint);
  }
  for (const p of cut ? [foot] : [top, foot]) eye(g, p, d, pixel, paint);
}
// The beams of the tow arm of a paver drawn `reach` long (`towArm`) that it hides as it travels (`arm.hidden`), out of the
// beam pinned to the tow point: none till the beam out of them is drawn out of it as far as it goes, keeping its overlap,
// and then each as far as the others. Each [from, to] along the arm from the tow point, the outermost first, from as far
// inside the one it comes out of as they overlap.
export function armBeams(rig:MotionPaverRig,reach:number):[number,number][] {
  const { outer, inner, overlap, hidden } = rig.arm, out = hidden ? Math.max(0, reach - (outer + inner - overlap)) / hidden : 0;
  return out > 1e-9 ? Array.from({ length: hidden! }, (_, i) => [outer - overlap + i * out, outer + (i + 1) * out]) : [];
}
// The earth a blade moves as it grades, in its box, `amount` of it as it bites, drawn as its moldboard is (machine-art.ts
// `moldboard`), further off towards the far end: along each stretch of its edge that bites (`biting`), a roll before its
// face, turning as it is pushed along to the heel and the deeper there, over the foot of the moldboard and down to the
// ground drawn plumb under it (`earthFoot`), with the low ridge it leaves off its heel; a heap of loose earth, no steeper at
// its ends than earth stands (`REPOSE`), however short the stretch. `phase` is how far it has rolled, `pose` how
// far the blade is down (`bladePose`), `tone` the ground's colours (ground-impact.ts): the earth turned over is the pale of
// its dust where the light takes it, and its own colour in the shade at its foot.
export function drawEarth(g:ShapeInk,rig:BladeRig,pose:BladePose,phase:number,tone:EarthTone,pixel:number,amount=1) {
  // `u` is the share of the edge along the ground; the scale of the picture goes from end to end as it does.
  const { board, s } = rig, { k: nearness } = moldboard(rig), near = nearness(0), far = nearness(1), k = (u:number) => near + (far - near) * u,
    { heel, toe } = cuttingEdge(rig), length = Math.hypot(toe.x - heel.x, toe.y - heel.y), tall = board.plate * .45, lumps = 16,
    line = pose.surface, down = pose.down, horizontal = (p:Point) => down.y * p.x - down.x * p.y, width = Math.abs(horizontal(toe) - horizontal(heel));
  if (!(tall * amount * k(1) > pixel) || !(width > pixel) || !line?.length) return;
  const surface = (u:number) => {
    let low = 1, high = line.length - 1;
    while (low < high) { const middle = (low + high) >>> 1; if (line[middle]!.u <= u) low = middle + 1; else high = middle; }
    const a = line[low - 1]!, b = line[low]!, f = (u - a.u) / (b.u - a.u);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, gap: a.gap + (b.gap - a.gap) * f, under: a.under + (b.under - a.under) * f, low: a.low + (b.low - a.low) * f };
  },
    // How thick it stands at `u`, of a stretch that bites from `from` to `to`: the roll, and under it down to the ground.
    thickness = (u:number,from:number,to:number) => {
      const roll = tall * k(u) * (.5 + .5 * (1 - u)) * (1 + .12 * Math.sin(u * lumps * 2.7 + phase * 3.1) + .06 * Math.sin(u * lumps * 5.3 - phase * 1.7));
      return amount * Math.min(Math.max(0, surface(u).low - pose.drop) + roll, REPOSE * length * Math.min(u - from, to - u));
    },
    at = (u:number,from:number,to:number,share:number):[number,number] => { const p = earthFoot(pose, surface(u)), h = thickness(u, from, to) * share; return [p.x - down.x * h, p.y - down.y * h]; };
  // Where it bites: between the samples of the surface the nearer of the two grounds is straight (`bladeDrop`).
  const spans:[number,number][] = [], bite = (p:Pick<BladeSurface,'gap'|'under'>) => Math.min(p.gap, p.under) - pose.drop - TOOL_CONTACT.blade;
  let start = bite(line[0]!) <= 0 ? line[0]!.u : null;
  for (let i = 1; i < line.length; i++) {
    const a = bite(line[i - 1]!), b = bite(line[i]!);
    if ((a <= 0) === (b <= 0)) continue;
    const u = line[i - 1]!.u + (line[i]!.u - line[i - 1]!.u) * a / (a - b);
    if (b <= 0) start = u; else { spans.push([start!, u]); start = null; }
  }
  if (start !== null) spans.push([start, line.at(-1)!.u]);
  // Where the ground drawn under the foot comes up to it, its foot turns from the one to the other.
  const turns = line.slice(1).flatMap((q, i) => {
    const p = line[i]!, a = p.low - pose.drop, b = q.low - pose.drop;
    return a * b < 0 ? [p.u + (q.u - p.u) * a / (a - b)] : [];
  }), samples = [...new Set([...line.map(p => p.u), ...turns, ...Array.from({ length: lumps + 1 }, (_, i) => i / lumps)])].sort((a, b) => a - b);
  for (const [from, to] of spans) {
    // Its slopes come up to a whole roll, or meet in the middle of a short stretch.
    const slope = Math.min((to - from) / 2, tall / (REPOSE * length)),
      us = [...new Set([from, from + slope, (from + to) / 2, to - slope, ...samples.filter(u => u > from && u < to), to])].sort((a, b) => a - b);
    if (!(Math.max(...us.map(u => thickness(u, from, to))) > pixel)) continue;
    const base = us.map(u => at(u, from, to, 0)).reverse().flat(), crest = us.map(u => at(u, from, to, 1));
    // Each stretch that bites is its own heap. A valley never becomes a long, self-touching strip.
    g.poly([...base, ...crest.flat()]).fill(tone.top);
    g.poly([...base, ...us.map(u => at(u, from, to, .4)).flat()]).fill({ color: tone.color, alpha: .35 });
    g.poly([...crest.flat(), ...us.map(u => at(u, from, to, .7)).reverse().flat()]).fill({ color: tone.dust, alpha: .6 });
    // The short ridge at the heel lies on the same foot as the roll.
    const ridge = Math.min(.25, .3 * s / length), hi = Math.min(ridge, to);
    if (hi > from && thickness((from + hi) / 2, from, to) * .6 > pixel) {
      const rs = [...new Set([from, hi, ridge * .2, ridge * .45, ridge * .7, ...us])].filter(u => u >= from && u <= hi).sort((a, b) => a - b),
        crestAt = (u:number,share=1) => at(u, from, to, .6 * Math.sin(Math.PI * u / ridge) * share),
        crest = rs.map(u => crestAt(u));
      g.poly([...rs.map(u => at(u, from, to, 0)).reverse().flat(), ...crest.flat()]).fill(tone.top);
      g.poly([...crest.flat(), ...rs.map(u => crestAt(u, .7)).reverse().flat()]).fill({ color: tone.dust, alpha: .6 });
    }
  }
  // Clods stay within the stretch whose earth carries them; no new ground reads.
  for (let i = 0; i < 9; i++) {
    const u = ((i / 9 - phase * .12) % 1 + 1) % 1, span = spans.find(([from, to]) => u >= from && u <= to);
    if (!span) continue;
    // Its earth lies plumb under the foot of the moldboard: as far across the view along the edge as that.
    const [x, y] = at(u, ...span, .8), size = .1 * thickness(u, ...span) * (1 + (i % 3) * .3), reach = 1.18 * size + pixel,
      left = u - reach / width, right = u + reach / width;
    if (size < pixel || left < span[0] || right > span[1]) continue;
    // Keep the whole stroked clod above every corner under its footprint, not just its centre.
    const clear = (p:Point & {low:number}) => { const q = earthFoot(pose, p); return (q.x - x) * down.x + (q.y - y) * down.y >= reach; };
    if (!clear(surface(left)) || !clear(surface(right)) || line.some(p => p.u > left && p.u < right && !clear(p))) continue;
    disc(g, x, y, size, 7, i + phase * 4, [.18, -.1, .06, -.16, .12, -.04, .08])
      .fill(i % 3 ? tone.top : tone.dust).stroke({ width: pixel, color: tone.color, alpha: .5 });
  }
}
// The colours of the ground a blade cuts.
const earthTones:Readonly<Record<string,EarthTone>> = GROUND_SURFACES;
export const earthTone = (surface:string):EarthTone => earthTones[surface] ?? GROUND_SURFACES.soil;
// How far the screed of a machine of `s` times the size is shaken up or down at a moment.
export const shake = (time:number,s:number) => SHAKE * s * Math.sin(time * TAU * SHAKE_HZ) * (.6 + .4 * Math.sin(time * 7.3));

// The drawing of one machine at work on the screen: under the picture it travels with, in the group of that picture, of a
// blade all that goes down, out in the open as its picture is, with the earth before its moldboard, and of a paver the
// ground of its box (`under`); of a paver, what moves over the rest of its vehicle (`over`, as the screed stands out of it
// over its running gear). Each is laid as the picture is, and its parts are sprites of their own pictures, moved as the
// tool goes down; what joins them is drawn anew on every frame.
export class RoadMachineView {
  declare kind:RoadToolKind;declare under:Container;declare underBox:Container;declare over:Container|undefined;declare overBox:Container|undefined;
  declare sprites:Partial<Record<MotionPart,Sprite>>;declare earth:Graphics|undefined;declare joints:Graphics;declare backing:Graphics|undefined;declare slats:Graphics|undefined;declare beams:Graphics|undefined;
  constructor(kind:RoadToolKind) {
    this.kind = kind; this.under = new Container(); this.underBox = this.under.addChild(new Container());
    this.sprites = Object.fromEntries(MOTION_PARTS[kind].map(part => [part, new Sprite()]));
    if (kind === 'blade') {
      this.underBox.addChild(this.sprites.neck!, this.sprites.assembly!);
      this.earth = this.underBox.addChild(new Graphics());
      this.joints = this.underBox.addChild(new Graphics());
    } else {
      this.backing = this.underBox.addChild(new Graphics());
      this.over = new Container(); this.overBox = this.over.addChild(new Container());
      this.slats = this.overBox.addChild(new Graphics());
      this.overBox.addChild(this.sprites.screed!, this.sprites.auger!, this.sprites.slide!);
      this.beams = this.overBox.addChild(new Graphics());
      this.overBox.addChild(this.sprites.arm!);
      this.joints = this.overBox.addChild(new Graphics());
    }
  }
  get destroyed() { return this.under.destroyed || Boolean(this.over?.destroyed); }
  destroy() { for (const root of [this.under, this.over]) if (root && !root.destroyed) root.destroy({ children: true, context: true }); }
  set visible(shown:boolean) { this.under.visible = shown; if (this.over) this.over.visible = shown; }
  // Lays both over the canonical picture of the piece, `W` by `H`; `group` is where the
  // picture stands, and `tint` how it is tinted.
  lay(W:number,H:number,group:Pick<Container,'position'|'rotation'|'scale'>,tint:number) {
    for (const box of [this.underBox, this.overBox]) if (box) { box.scale.set(1, -1); box.position.set(-W / 2, H / 2); }
    this.under.tint = tint;
    if (this.over) { this.over.position.copyFrom(group.position); this.over.rotation = group.rotation; this.over.scale.copyFrom(group.scale); this.over.tint = tint; }
  }
  // A part's picture where it stands as the machine travels (`box`), moved by `dx`, `dy`, turned by `turn` about `pivot`,
  // drawn out along its width from it by `stretch` and leant down by `shear` as far back of it as it goes.
  place(part:MotionPart,texture:Texture,box:MotionBox,{dx=0,dy=0,turn=0,pivot=null,shear=0,stretch=1}:{dx?:number;dy?:number;turn?:number;pivot?:Point|null;shear?:number;stretch?:number}={}) {
    const sprite = this.sprites[part]!, p = pivot ?? box;
    if (sprite.texture !== texture) sprite.texture = texture;
    sprite.anchor.set((p.x - box.x) / box.w, (p.y - box.y) / box.h);
    sprite.position.set(p.x + dx, p.y + dy); sprite.rotation = turn; sprite.skew.set(0, Math.atan(shear));
    sprite.scale.set(box.w / texture.width * Math.hypot(1, shear) * stretch, box.h / texture.height);
  }
  // A blade `pose` down (`bladePose`), `earth` of the roll of earth ahead of it as it bites.
  blade(rig:MotionBladeRig,W:number,H:number,{textures,boxes,pose,earth,phase,tone,pixel,paint}:PaintedParts<'neck'|'assembly'> & {pose:BladePose;earth:number;phase:number;tone:EarthTone;pixel:number;paint:MetalPaint}) {
    this.earth!.clear(); if (earth > 0) drawEarth(this.earth!, rig, pose, phase, tone, pixel, earth);
    this.place('neck', textures.neck!, boxes.neck!, { pivot: rig.ball, shear: pose.shear, stretch: pose.stretch });
    this.place('assembly', textures.assembly!, boxes.assembly!, { dx: pose.dx, dy: pose.dy });
    this.joints.clear();
    for (const name of ['shift', 'lift'] as const) {
      const ram = rig[name], { top, foot } = ram;
      drawRam(this.joints, top, { x: foot.x + pose.dx, y: foot.y + pose.dy }, rig.d, ram, pixel, paint, 0);
    }
  }
  // A paver with its screed set as `pose` (`screedPose`), its conveyor `run` metres on and its auger turned by `turn`: the
  // screed and the auger it carries down and turned with it, the beam out of the tow arm pinned to it, the arm turned about
  // the tow point and the beams it hides drawn out of it as far as it reaches (`armBeams`), and the ram it hangs from drawn
  // out to it.
  paver(rig:MotionPaverRig,W:number,H:number,{textures,boxes,pose,run,turn,pixel,paint}:PaintedParts<'screed'|'auger'|'slide'|'arm'> & {pose:ScreedPose;run:number;turn:number;pixel:number;paint:MetalPaint}) {
    backing(this.backing!, W, H, 1 - smoothstep(pose.drop / (.04 * rig.s)));
    this.slats!.clear();
    for (const [x, y, w, h, color] of conveyorSlats(rig, run)) this.slats!.rect(x, y, w, h).fill(paint(color));
    const { screed, auger, pin, tow, lift } = rig, edge = { x: screed.x0, y: screed.foot }, at = (p:Point) => screedPoint(rig, pose, p),
      moved = (p:Point) => { const q = at(p); return { dx: q.x - p.x, dy: q.y - p.y }; }, arm = towArm(rig, pose), foot = at(lift.foot);
    this.place('screed', textures.screed!, boxes.screed!, { pivot: edge, ...moved(edge), turn: pose.tilt });
    this.place('auger', textures.auger!, boxes.auger!, { pivot: auger, ...moved(auger), turn });
    this.place('slide', textures.slide!, boxes.slide!, { pivot: pin, ...moved(pin), turn: arm.turn });
    this.place('arm', textures.arm!, boxes.arm!, { pivot: tow, turn: arm.turn });
    this.beams!.clear();
    const beams = armBeams(rig, arm.reach), way = Math.atan2(pin.y - tow.y, pin.x - tow.x) + arm.turn, ux = Math.cos(way), uy = Math.sin(way),
      along = (k:number) => ({ x: tow.x + ux * k, y: tow.y + uy * k });
    // Each a box beam as the arm's are (machine-art.ts `paverArm`), between the depth of the arm's mouth and of the beam out
    // of it; the innermost drawn first, each further out over it.
    for (let i = beams.length - 1; i >= 0; i--)
      bar(this.beams!, along(beams[i]![0]), along(beams[i]![1]), rig.armDepth * .9 * (.66 / .9) ** ((i + 1) / (beams.length + 1)), '#5d6753', pixel, paint);
    this.joints.clear();
    drawRam(this.joints, lift.top, foot, rig.d, lift, pixel, paint);
  }
}
