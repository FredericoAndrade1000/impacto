import { clamp, lerp } from './math.ts';
import { MODULES } from './materials.ts';
import { cargoSpace } from './component-volume.ts';
import type { Point } from './math.ts';
import type { ModuleKind } from './materials.ts';
import type { CargoKind, CargoLoad } from './economy-contract.ts';
import type { DispatchView, JobKind } from './automatic-jobs.ts';

export type HeightAt = (x: number) => number;
export interface WorkFrame { left: number; right: number; bottom: number }
// A query port shared by posed scene parts and the pieces of an unbuilt project.
// A plate may carry its geometry in definition; components carry it directly.
interface WorkGeometry {
  x?: number | undefined; y?: number | undefined; angle?: number | undefined;
  length?: number | undefined; thicknessMm?: number | undefined; width?: number | undefined; height?: number | undefined;
}
export interface WorkPart extends WorkGeometry {
  id: string; kind?: ModuleKind | undefined; definition?: WorkGeometry | undefined;
  attached?: boolean | undefined; health?: number | undefined; mirrored?: boolean | undefined;
  capacityM3?: number | undefined; cargo?: CargoLoad | undefined;
}
export interface WorkTool extends Point { kind: ModuleKind; width: number; height: number; angle?: number | undefined; mirrored?: boolean | undefined }
export interface WorkBox { lo: number; hi: number; top: number }
export interface WorkSite { x: number; material?: CargoKind }
type ExtractorKind = 'excavator' | 'drill';
export interface WorkLayout {
  kind: ExtractorKind; rig: boolean; side: number; mount: Point; base: Point; tilt: number;
  size: number; inward: number; out: number; drop: number; bucket: number; mast: number;
  length: number; boom: number; stick: number;
}
interface DeliveryPlan { x: number; y: number; floor: number; lift: number; partId: string | null }
export interface WorkDelivery extends DeliveryPlan { branch: number }
interface DeliveryChoice { cycle: number; partId: string | null; mouth: number; site: WorkSite | null | undefined; branch: number }
export interface WorkArmState {
  time?: number; working?: boolean; deployed?: number; cycle?: number; sunk?: number; delivery?: DeliveryChoice;
}
interface AngularPose { boom: number; stick: number; tool: number }
interface WorkMotion extends AngularPose { load: number; spill: number | null; dust: number | null }
interface WorkFigureBase {
  kind: ExtractorKind; side: number; size: number; mount: Point; base: Point;
  elbow: Point; wrist: Point; tip: Point; length: number; open: Point;
}
export type WorkFigure = WorkFigureBase & (
  | { rig: true; sunk: number; head: Point; bit: Point; collar: Point | null; turn: number; flow: number | undefined | null }
  | ({ rig: false; load: number; floor: number | null; dust: number | null; dig: Point | null } & (
      | { spill: null; spillOrigin: null }
      | { spill: number; spillOrigin: Point }
    ))
);
export interface CraneLayout {
  kind: 'builder'; side: number; mount: Point; base: Point; pivot: Point; rest: { foot: Point; head: Point };
  tilt: number; size: number; boom: number; jib: number; telescope: number; clearance: number;
}
interface StandbyTarget { id: string; lo: number; hi: number; gather?: boolean }
export interface CraneTarget extends StandbyTarget { boxes: readonly WorkBox[]; down?: boolean }
export type CraneGeometryTarget = Omit<CraneTarget, 'id'>;
export interface CraneArmState extends WorkArmState { carrying?: boolean; finishing?: boolean | undefined; pace?: number }
interface LoadPlace { x: number; floor: number }
export interface CraneRoute { from: LoadPlace; to: LoadPlace; lift: number; reach: number; short: boolean }
export interface CraneFigure {
  kind: 'builder'; side: number; size: number; base: Point; mount: Point; pivot: Point; knuckle: Point; sleeve: Point;
  tip: Point; run: number; hook: Point; rest: { foot: Point; head: Point }; block: number; crook: number; slings: number;
  load: (Point & { shown: number; hung: boolean; width: number; height: number }) | null;
}
function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new TypeError('Missing work-arm motion mark.');
  return value;
}
function groundAt(ground: HeightAt | null, x: number): number {
  if (!ground) throw new TypeError('An unfolded work arm requires ground.');
  return ground(x);
}

// One installed extractor owns the complete arm. Its fixed base has the mass, attachment and damage of a
// normal component; these articulated drawings never create another body or produce material themselves.
export const WORK_HOLD = 1.5;      // the existing ore-loading sound's tail, independent of arm activity
export const DEPLOY_SECONDS = 1.2; // from folded to its first reach
export const STOW_SECONDS = 1;     // and back
export const SCOOP_SECONDS = 5.6;  // the excavator, from one reach to the next
export const SINK_SECONDS = 2.4;   // the drill string, from the foot of its mast to its depth
export const LIFT_SECONDS = 7.2;   // the builder's crane, from one load to the next
// How long a crane stays out after the field last said its construction builds, when nothing it is told of keeps it out
// (`craneStandby`): it does not fold between deliveries when material arrives slower than the builder puts it up.
export const LIFT_HOLD = 1.5;
const CLEAR = 1.2;                 // clearance past the construction, scaled with an excavator's bucket
const ARMS = Object.freeze({ excavator: { length: 4.2, bucket: .42, mast: 0 }, drill: { length: 3.8, bucket: 0, mast: 1.45 } });
// The loader crane of a builder at the reference size, in metres: its column over the slewing base, its main boom, the
// outer boom and the run of the three sections that slide out of it — enough to reach over a lorry from a crane behind
// its cab; the hook block and the hook under it, the slings, a load on its pallet (wide and high), the shortest cable the
// hook hangs on and what a load carried keeps clear of; where a load is taken from (`bed`, out of the column: nearer, the
// main boom would have to lean back over it), how far a load is set into what it is put on (`inset`) and, with nothing
// known to put it on, how far past the end of its construction (`past`).
const CRANE = Object.freeze({ column: .3, boom: 1.75, jib: 1.45, telescope: 3.6, block: .2, hook: .12, slings: .32, load: Object.freeze([1, .44] satisfies [number, number]),
  cable: .25, clear: .16, bed: 1.9, inset: .6, past: 1.2 });
// How far that crane reaches out of its column with its booms straight and its sections all out, in metres: 6.8 m. Its
// column stands on its construction, so nothing further than that past the end of the construction is in its reach.
export const CRANE_REACH = CRANE.boom + CRANE.jib + CRANE.telescope;
// Folded for the road, as a loader crane lies over a lorry's bed: its main boom level over its piece, the outer boom
// tucked under it back to the column, their faces meeting at its end, both laid on a boom rest standing on the casing at
// the far end of the piece (`REST` in from it), and the hook let down beside the column onto the casing, where it is made
// fast. Their angles are in radians from the piece. Unfolding raises the main boom off the rest first and then opens the
// knuckle (`RAISE`, of the way out); folding closes the knuckle and lays them back on it.
const FOLDED = Object.freeze({ boom: 0, jib: .102 - Math.PI }), RAISE = .6, REST = .1;
// Of the height of each piece, how far under its top the casing of its base begins (component-art.ts paints it from
// there): what the seat of an arm and the slewing base of a crane's column stand on.
export const CASING = Object.freeze({ excavator: .185, drill: .185, builder: .293 });
const FOOT = .22;                  // metres the foot of a mast stands over the ground
const DEPTH = .9;                  // metres of ground a string goes into
const LIE = .06, WRIST = .16;      // of the height of the piece, the end of a folded boom and its wrist over the seat
const rad = (degrees: number): number => degrees * Math.PI / 180, ease = (t: number): number => t * t * (3 - 2 * t);

// The same hull clearance is used to park a hauler and to draw its working arm.
export function workFrame(piece: Point & { angle?: number | undefined }, parts: readonly (WorkPart | null | undefined)[]): WorkFrame {
  const turned = piece.angle || 0,
    c = Math.cos(turned), s = Math.sin(turned), frame = { left: 0, right: 0, bottom: 0 };
  for (const part of parts) {
    if (!part || part.attached === false) continue;
    const shape = part.definition || part, long = Number(shape.length ?? shape.width) / 2,
      thick = shape.length ? Number(shape.thicknessMm) / 2000 : Number(shape.height) / 2,
      lean = (part.angle ?? shape.angle ?? 0) - turned, ca = Math.abs(Math.cos(lean)), sa = Math.abs(Math.sin(lean)),
      dx = Number(part.x ?? shape.x) - piece.x, dy = Number(part.y ?? shape.y) - piece.y, along = c * dx + s * dy, up = c * dy - s * dx;
    frame.left = Math.min(frame.left, along - ca * long - sa * thick); frame.right = Math.max(frame.right, along + ca * long + sa * thick);
    frame.bottom = Math.min(frame.bottom, up - sa * long - ca * thick);
  }
  return frame;
}

// The end of its construction a piece works past: the nearer one. `frame` is how far the construction
// reaches from the middle of the piece along the piece: to its left (a negative number), to its right
// and below. The end chosen before is kept until the other is nearer by a hand.
// Equal clearance follows the component's reflection, including a tool standing on its own.
export function workSide(frame: WorkFrame, before = 0, mirrored = false): number {
  const nearer = frame.right + frame.left;
  if (before && Math.abs(nearer) < .3) return before;
  return Math.abs(nearer) < 1e-9 ? mirrored ? -1 : 1 : nearer > 0 ? -1 : 1;
}

// The actual arm length follows the installed scale, never the length of the chassis or the terrain below.
// The server uses this same plan to admit reach: placing a small tool in the middle of a long vehicle cannot
// quietly give it a longer arm. Both the server and the drawing use this same plan.
export function workLayout(piece: WorkTool, frame: WorkFrame, side: number, ground: HeightAt | null = null): WorkLayout {
  if (piece.kind !== 'excavator' && piece.kind !== 'drill') throw new Error('Esta peça não tem equipamento de extração.');
  const kind = piece.kind, spec = ARMS[kind];
  const angle = piece.angle || 0, { width, height } = piece, rig = piece.kind === 'drill', c = Math.cos(angle), s = Math.sin(angle),
    scale = width / MODULES[kind].width,
    inward = .34 * width, seat = { x: side * inward, y: .5 * height }, place = (u: number, v: number): Point => ({ x: piece.x + c * u - s * v, y: piece.y + s * u + c * v }),
    mount = place(seat.x, seat.y), base = place(seat.x, (.5 - CASING[kind]) * height),
    bucket = spec.bucket * scale, mast = spec.mast * scale, length = spec.length * scale, drop = seat.y - frame.bottom,
    clearance = (side > 0 ? frame.right : -frame.left) - inward + CLEAR * (rig ? 1 : scale),
    // Work with the arm extended, rather than folding a long boom almost vertically next to its seat.
    // A high mounting leaves less horizontal reach; the actual terrain is checked before collection.
    reach = Math.sqrt(Math.max(0, (length - .25 * scale) ** 2 - (drop - bucket * .6) ** 2)),
    out = rig ? clearance : Math.max(clearance, Math.min(length * .75, reach - .2 * scale));
  // `tilt` is the lean of the piece as the arm has it: the arm counts its places outwards from the seat. `base` is the
  // place on the casing under the seat, what the seat stands on.
  const layout: WorkLayout = { kind, rig, side, mount, base, tilt: side * Math.atan2(s, c), size: scale, inward, out, drop, bucket, mast,
    length, boom: length * .54, stick: length * .46 };
  // On a descending slope, bring the work point closer if necessary, while keeping it outside the hull.
  // Four bounded refinements suffice for parking; no terrain search or longer arm is introduced.
  if (!rig && ground && !workReachable(layout, ground)) {
    layout.out = clearance;
    if (workReachable(layout, ground)) {
      let near = clearance, far = out;
      for (let i = 0; i < 4; i++) {
        layout.out = (near + far) / 2;
        if (workReachable(layout, ground)) near = layout.out; else far = layout.out;
      }
      layout.out = near;
    }
  }
  return layout;
}

// Only authoritative extraction activity starts work. Filling, unloading or owning a full reservoir does not.
// Stopping freezes the work cycle; a drill brings its string up before folding. Time is the displayed world's clock.
// `pace` is its engines' share.
export function workStep(arm: WorkArmState, rig: boolean, active: unknown, time: number, pace = 1): WorkArmState {
  const dt = arm.time === undefined || time < arm.time ? 0 : Math.min(time - arm.time, .25);
  if (arm.time !== undefined && time < arm.time) { Object.assign(arm, { deployed: 0, cycle: 0, sunk: 0 }); delete arm.delivery; }
  arm.time = time; arm.working = active === true;
  arm.deployed ??= 0; arm.cycle ??= 0; arm.sunk ??= 0;
  if (arm.working) {
    if (arm.deployed < 1) arm.deployed = Math.min(1, arm.deployed + dt / DEPLOY_SECONDS);
    else { arm.cycle += dt * pace; if (rig) arm.sunk = Math.min(1, arm.sunk + dt / SINK_SECONDS); }
  } else if (arm.sunk > 0) arm.sunk = Math.max(0, arm.sunk - dt / (SINK_SECONDS * .6));
  else { arm.deployed = Math.max(0, arm.deployed - dt / STOW_SECONDS); if (!arm.deployed) { arm.cycle = 0; delete arm.delivery; } }
  return arm;
}

// Joint lengths stay fixed. Digging bends outwards; carrying keeps the chosen
// bend until the arm is straight above its base, where the two solutions meet.
function solve(layout: { boom: number; stick: number }, x: number, y: number, branch = 1, straight = false): { boom: number; stick: number } {
  const { boom, stick } = layout, far = clamp(Math.hypot(x, y), Math.abs(boom - stick) + .02, boom + stick - (straight ? 0 : .02)),
    base = Math.atan2(y, x), bend = Math.acos(clamp((boom * boom + far * far - stick * stick) / (2 * boom * far), -1, 1)),
    angle = base + branch * bend,
    turned = Math.atan2(far * Math.sin(base) - boom * Math.sin(angle), far * Math.cos(base) - boom * Math.cos(angle));
  // The stick hangs from the elbow: its angle is kept below the horizon, where no two of them are a turn apart.
  return { boom: angle, stick: turned > Math.PI / 2 ? turned - 2 * Math.PI : turned };
}

// Each mark gives the share of a scoop, the teeth's offset from the work point, their clearance over
// the ground and the bucket angle in degrees. Offsets and clearances follow the installed scale.
// The wrist follows the teeth, so the digging stroke stays on the actual terrain between marks too.
const SCOOP: readonly (readonly [number, number, number, number])[] = [[0, .16, .8, 285], [.11, .16, 0, 262], [.27, -.35, 0, 205], [.36, -.38, .45, 165],
  [.52, -.25, .8, 165], [.68, -.05, .75, 165], [.76, -.05, .75, 265], [.84, -.05, .75, 265], [1, .16, .8, 285]];
const FILLS: readonly [number, number] = [.11, .27], POURS: readonly [number, number] = [.69, .8], DUST: readonly [number, number] = [.09, .34];
// The carry stays above the construction until it reaches the open container. Returning empty follows
// the same clearance, rather than dragging the stick through the body. These marks are presentation only:
// the complete ground stroke checked by collection remains SCOOP, with exactly its existing reach.
type CarryMark = 'dug' | 'up' | 'over' | 'pour' | 'back' | 'ready';
const CARRY: readonly (readonly [number, CarryMark])[] = [[.27, 'dug'], [.4, 'up'], [.56, 'over'], [.68, 'pour'], [.8, 'pour'], [.84, 'over'], [.96, 'back'], [1, 'ready']];
function scoopWrist(layout: WorkLayout, offset: number, rise: number, degrees: number, ground: HeightAt): Point & { tool: number } {
  const x = layout.out + offset * layout.size, tool = rad(degrees);
  return { x: x - Math.cos(tool) * layout.bucket,
    y: ground(x) + rise * layout.size - Math.sin(tool) * layout.bucket, tool };
}

// Of each attached part of a construction (its plates and its pieces, as a scene poses them), the stretch of the field
// it takes up and the height of its top.
export function boxesOf(parts: readonly (WorkPart | null | undefined)[]): WorkBox[] {
  return parts.filter((part): part is WorkPart => Boolean(part && part.attached !== false)).map(part => {
    const shape = part.definition || part, angle = part.angle ?? shape.angle ?? 0, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle)),
      wide = Number(shape.length ?? shape.width) / 2, high = shape.length ? Number(shape.thicknessMm) / 2000 : Number(shape.height) / 2,
      x = Number(part.x ?? shape.x), y = Number(part.y ?? shape.y);
    return { lo: x - c * wide - s * high, hi: x + c * wide + s * high, top: y + s * wide + c * high };
  });
}

// An open hopper's centre is preferred. A reachable point inside its mouth is enough when the centre
// is too far; otherwise the real public pile remains the destination. No contents or transfer are invented.
// What goes into one hopper fills the others of the construction (loading-area.ts): a full one the arm reaches is
// still a mouth while another has room, after those with room of their own.
export function workDelivery(layout: WorkLayout, parts: readonly WorkPart[], site: WorkSite | null | undefined, ground: HeightAt, arm: WorkArmState | null = null): WorkDelivery | null {
  if (layout.rig) return null;
  const cycle = Math.floor((arm?.cycle || 0) / SCOOP_SECONDS), kept = arm?.delivery?.cycle === cycle ? arm.delivery : null;
  site ||= kept?.site;
  const remember = (delivery: DeliveryPlan | null, mouth = 0): WorkDelivery | null => {
    // Keep the mouth and joint bend; positions still follow the current pieces.
    // A full container is reconsidered on the next scoop, never halfway across the construction.
    if (delivery) {
      const result = Object.assign(delivery, { branch: kept?.partId === delivery.partId && kept ? kept.branch : side * (delivery.x - mount.x) < 0 ? -1 : 1 });
      if (arm) arm.delivery = { cycle, partId: result.partId, mouth, site, branch: result.branch };
      return result;
    }
    return delivery;
  },
    { mount, side, size, bucket, out, length } = layout, start = mount.x + side * (out - .38 * size),
    bounds = boxesOf(parts),
    plan = (x: number, floor: number, partId: string | null = null): DeliveryPlan | null => {
      const lo = Math.min(start, x), hi = Math.max(start, x), y = floor + .75 * size,
        lift = Math.max(y, ...bounds.filter(box => box.hi >= lo && box.lo <= hi).map(box => box.top + bucket)),
        delivery = { x, y, floor, lift, partId };
      // The path's endpoints and bucket radius bound every intermediate position without a search.
      return [start, x, mount.x + side * (out + .16 * size)].every(at => [y, lift].every(up =>
        Math.hypot(at - mount.x, up - mount.y) + bucket < length - .02)) ? delivery : null;
    },
    material = site?.material || 'ferro', whole = parts.filter(part => part?.kind === 'hopper' && part.attached !== false && !(Number(part.health) <= 0)),
    room = (part: WorkPart): boolean => cargoSpace({ kind: 'hopper', capacityM3: Number(part.capacityM3), cargo: part.cargo }, material) > 1e-6,
    hoppers = whole.filter(part => kept ? part.id === kept.partId : whole.some(room))
      .sort((a, b) => Number(room(b)) - Number(room(a)) || Math.abs(Number(a.x) - mount.x) - Math.abs(Number(b.x) - mount.x));
  for (const hopper of hoppers) {
    const angle = hopper.angle || 0, sign = hopper.mirrored ? -1 : 1,
      c = Math.cos(angle), s = Math.sin(angle), centre = Number(hopper.x) - s * Number(hopper.height) / 2,
      near = sign * Math.sign(mount.x - centre) * Number(hopper.width) * .32;
    for (const u of kept ? [kept.mouth * Number(hopper.width)] : [0, near]) {
      const delivery = plan(centre + sign * c * u, Number(hopper.y) + c * Number(hopper.height) / 2 + sign * s * u, hopper.id);
      if (delivery) return remember(delivery, u / Number(hopper.width));
    }
  }
  // A vehicle parked elsewhere along the deposit must not drop its pile through its own hull.
  if (site && !bounds.some(box => site.x > box.lo && site.x < box.hi)) return remember(plan(site.x, ground(site.x)));
  return null;
}

function carryPoint(layout: WorkLayout, mark: CarryMark, ground: HeightAt, delivery: WorkDelivery): Point {
  const { out, size, mount, side } = layout, x = mark === 'dug' ? out - .35 * size : out + (mark === 'up' ? -.38 : .16) * size;
  if (mark === 'pour' || mark === 'over') return { x: side * (delivery.x - mount.x), y: (mark === 'pour' ? delivery.y : delivery.lift) - mount.y };
  return { x, y: mark === 'dug' ? ground(x) : mark === 'ready' ? ground(x) + .8 * size : delivery.lift - mount.y };
}

// Collection and drawing share the complete stroke, not just a nominal point under the wrist.
export function workReachable(layout: WorkLayout, ground: HeightAt): boolean {
  const level = (x: number): number => ground(layout.mount.x + layout.side * x) - layout.mount.y;
  if (layout.rig) return Math.hypot(layout.out, level(layout.out) + layout.mast + FOOT) < layout.length - .02;
  return SCOOP.every(([, offset, rise, tool]) => {
    const wrist = scoopWrist(layout, offset, rise, tool, level);
    return Math.hypot(wrist.x, wrist.y) < layout.length - .02;
  });
}
function scoopPose(layout: WorkLayout, share: number, ground: HeightAt, delivery: WorkDelivery | null): WorkMotion {
  const next = SCOOP.findIndex(([at]) => at > share), a = item(SCOOP, next - 1), b = item(SCOOP, next), t = ease((share - a[0]) / (b[0] - a[0])),
    wrist = scoopWrist(layout, lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t), ground);
  let branch = 1, straight = false;
  if (delivery && share > item(CARRY, 0)[0]) {
    const next = CARRY.findIndex(([at]) => at > share), a = item(CARRY, next - 1), b = item(CARRY, next), t = ease((share - a[0]) / (b[0] - a[0])),
      from = carryPoint(layout, a[1], ground, delivery), to = carryPoint(layout, b[1], ground, delivery),
      fromBranch = a[1] === 'over' || a[1] === 'pour' ? delivery.branch : 1,
      toBranch = b[1] === 'over' || b[1] === 'pour' ? delivery.branch : 1,
      bx = Math.cos(wrist.tool) * layout.bucket, by = Math.sin(wrist.tool) * layout.bucket;
    branch = fromBranch;
    if (fromBranch !== toBranch) {
      // Cross above the pivot with both links extended, then bend towards the
      // destination. This also clears containers mounted above the tool.
      const raw = (share - a[0]) / (b[0] - a[0]), first = raw < .5,
        phase = ease(first ? raw * 2 : raw * 2 - 1), top = layout.boom + layout.stick;
      wrist.x = first ? lerp(from.x - bx, 0, phase) : lerp(0, to.x - bx, phase);
      wrist.y = first ? lerp(from.y - by, top, phase) : lerp(top, to.y - by, phase);
      branch = first ? fromBranch : toBranch; straight = true;
    } else {
      wrist.x = lerp(from.x, to.x, t) - bx;
      wrist.y = lerp(from.y, to.y, t) - by;
    }
  }
  return { ...solve(layout, wrist.x, wrist.y, branch, straight), tool: wrist.tool,
    load: clamp((share - FILLS[0]) / (FILLS[1] - FILLS[0]), 0, 1) * (1 - clamp((share - POURS[0]) / (POURS[1] - POURS[0]), 0, 1)),
    spill: share >= POURS[0] && share < .84 ? (share - POURS[0]) * SCOOP_SECONDS : null,
    dust: share >= DUST[0] && share < DUST[1] ? (share - DUST[0]) / (DUST[1] - DUST[0]) : null };
}

// What is drawn of the arm of a piece, in places of the world: its seat on the casing, elbow and wrist, and the tool
// at the wrist, a bucket or a mast, with where it ends. `ground` is the height of the ground at a place.
// A folded arm asks nothing of the ground.
export function workFigure(layout: WorkLayout, arm: WorkArmState = {}, ground: HeightAt | null = null, delivery: WorkDelivery | null = null): WorkFigure {
  const { side, mount, tilt, rig, boom, stick, size } = layout, open = ease(clamp(arm.deployed || 0, 0, 1)),
    level = (x: number): number => groundAt(ground, mount.x + side * x) - mount.y, at = (x: number, y: number): Point => ({ x: mount.x + side * x, y: mount.y + y }),
    turn = (angle: number, length: number): [number, number] => [Math.cos(angle) * length, Math.sin(angle) * length],
    // Folded, it lies low over its base: the boom along the top, its end
    // risen over the seat by `LIE` of the height of the piece, the stick back over the boom with the wrist by the seat,
    // `WRIST` over it, and the bucket curled below the wrist or the mast laid back along the stick.
    lie = Math.asin(Math.min(LIE * size / boom, .2)), back = Math.asin(Math.min((WRIST - LIE) * size / stick, .3));
  let pose: AngularPose = { boom: Math.PI - lie + tilt, stick: back + tilt, tool: (rig ? Math.PI + back : rad(270)) + tilt }, work: WorkMotion | null = null;
  if (open > 0) {
    work = rig ? { ...solve(layout, layout.out, level(layout.out) + layout.mast + FOOT), tool: rad(270), load: 0, spill: null, dust: null }
      : scoopPose(layout, (arm.cycle || 0) / SCOOP_SECONDS % 1, level, delivery);
    pose = { boom: lerp(pose.boom, work.boom, open), stick: lerp(pose.stick, work.stick, open), tool: lerp(pose.tool, work.tool, open) };
  }
  const [ex, ey] = turn(pose.boom, boom), [sx, sy] = turn(pose.stick, stick), wx = ex + sx, wy = ey + sy,
    length = rig ? layout.mast : layout.bucket, [tx, ty] = turn(pose.tool, length), out = open >= 1,
    figure = { kind: layout.kind, rig, side, size: layout.size, mount, base: layout.base, elbow: at(ex, ey), wrist: at(wx, wy), tip: at(wx + tx, wy + ty), length,
      // The side a bucket is open on: a quarter turn from where its teeth point, towards the construction as it digs.
      open: { x: side * Math.sin(pose.tool), y: -Math.cos(pose.tool) } };
  if (rig) {
    // The string is as long as the mast. Its head rides down the mast as its bit goes into the ground:
    // what is drawn of it ends at the ground, where a collar of spoil stands around it.
    const sunk = out ? arm.sunk || 0 : 0, travel = sunk * Math.min(FOOT + DEPTH, .8 * length), floor = out ? level(layout.out) : -Infinity,
      bit: [number, number] = [wx + tx * (1 + travel / length), wy + ty * (1 + travel / length)];
    return { ...figure, rig: true, sunk, head: at(bit[0] - tx * .92, bit[1] - ty * .92), bit: at(bit[0], Math.max(bit[1], floor)),
      collar: sunk > 0 ? at(layout.out, floor) : null, turn: arm.cycle || 0, flow: sunk >= 1 && arm.working ? arm.cycle : null };
  }
  const raised = out && work, floor = raised ? delivery && raised.spill !== null ? delivery.floor : groundAt(ground, figure.tip.x) : null,
    touching = raised && arm.working && raised.dust !== null && Math.abs(figure.tip.y - Number(floor)) < .08 * size,
    spill = raised && arm.working ? raised.spill : null;
  const load = raised && arm.working ? raised.load : 0, dust = touching && raised ? raised.dust : null,
    dig = touching ? { x: figure.tip.x, y: Number(floor) } : null;
  return spill === null ? { ...figure, rig: false, load, spill: null, spillOrigin: null, floor, dust, dig } :
    { ...figure, rig: false, load, spill, spillOrigin: delivery || figure.tip, floor, dust, dig };
}

// The builder's loader crane, of the kind lorries carry, seen square from the side: a column on its piece at the end away
// from where it works, the main boom on the column, the outer boom on the knuckle at its end with three sections that run
// out of it, and the hook on a cable from the end of those. `side` is the way it works. Its size follows the installed
// scale; how far it reaches is only how far it is drawn: the field admits a builder by its construction standing beside
// what it works at (construction-site.ts `BUILD_REACH`, as far as a crane of the reference size reaches).
export function craneLayout(piece: Point & { width: number; height: number; angle?: number | undefined }, frame: WorkFrame, side: number): CraneLayout {
  const angle = piece.angle || 0, { width, height } = piece, c = Math.cos(angle), s = Math.sin(angle), size = width / MODULES.builder.width,
    inward = .34 * width, column = CRANE.column * size, top = (.5 - CASING.builder) * height, boom = CRANE.boom * size,
    place = (u: number, v: number): Point => ({ x: piece.x + c * u - s * v, y: piece.y + s * u + c * v }),
    mount = place(-side * inward, .5 * height), pivot = place(-side * inward, .5 * height + column),
    end = piece.x + c * (side > 0 ? frame.right : frame.left),
    // The boom rest, from its foot on the casing up to the middle of the folded outer boom lying on it.
    far = .5 * width - REST * size, lies = (inward + far - boom * Math.cos(FOLDED.boom)) / Math.cos(FOLDED.jib),
    rest = { foot: place(side * far, top), head: place(side * far, .5 * height + column + boom * Math.sin(FOLDED.boom) + lies * Math.sin(FOLDED.jib)) };
  // `base` is where its slewing base stands on the casing under the column, `rest` the boom rest from its foot on the
  // casing; `clearance` is how far out of the column its construction ends on that side.
  return { kind: 'builder', side, mount, base: place(-side * inward, top), pivot, rest, tilt: side * Math.atan2(s, c), size,
    boom, jib: CRANE.jib * size, telescope: CRANE.telescope * size, clearance: side * (end - pivot.x) };
}
// The way a crane works, before it unfolds: towards the middle of what it is at.
export const craneSide = (piece: Pick<Point, 'x'>, target: Pick<StandbyTarget, 'lo' | 'hi'>): number => (target.lo + target.hi) / 2 >= piece.x ? 1 : -1;

// The jobs of a builder in automatic (supply-dispatch.ts), by their phase, at which it stands by what it was sent to — to
// put it up or take it down, or to bring it its material (`sent`) —, or loads a heap: the one it was sent to, or that of the
// structure it took down (`heap`), or the one it brings a works from, which it is not told (`heaps`).
type StandbyMode = 'sent' | 'heap' | 'heaps';
const STANDING: Readonly<Partial<Record<JobKind, Partial<Record<DispatchView['phase'], StandbyMode>>>>> = Object.freeze({ build: { work: 'sent' }, dismantle: { work: 'sent', load: 'heap' }, work: { deliver: 'sent', fetch: 'heaps' },
  heap: { fetch: 'heap' } });
// What a builder standing still and told to work at nothing is at, its crane out over it: of what there is to put up or take
// down, and of the heaps it loads (`targets`, each with its name and the stretch of the field it takes up, a heap `gather`),
// the nearest of those its construction (the `boxes` of its parts) stands beside — no further from it than `reach` —, as the
// field takes a builder up (field-construction.ts `attend`). One with no job stands by the nearest works or structure taken
// down; one sent by its `job` is at what that sends it to alone, and one on its way to anything or at another job is at
// nothing. Nothing when it is at none.
export function craneStandby<Target extends StandbyTarget>(boxes: readonly WorkBox[], targets: readonly Target[], job: Pick<DispatchView, 'kind' | 'phase' | 'targetId'> | null = null, reach = CRANE_REACH): Target | null {
  const how = job?.kind ? STANDING[job.kind]?.[job.phase] : 'any';
  if (!how || !boxes.length) return null;
  const lo = Math.min(...boxes.map(box => box.lo)), hi = Math.max(...boxes.map(box => box.hi)), gap = (target: Target): number => Math.max(0, target.lo - hi, lo - target.hi),
    ours = (target: Target): boolean | undefined => how === 'any' ? !target.gather : how === 'sent' ? !target.gather && target.id === job?.targetId :
      how === 'heap' ? target.gather && target.id === job?.targetId : target.gather;
  return targets.filter(target => ours(target) && gap(target) <= reach)
    .reduce<Target | null>((best, target) => !best || gap(target) < gap(best) ? target : best, null);
}

// What a crane does from one look to the next, by its `duty`: at 'work' it unfolds and works its lifts at `pace`, the share of
// its pace its engines give it; at 'rest' it unfolds, sets down the load it was lifting, at the pace it lifted it, and rests
// with its hook up where it takes its loads from, ready for the next; at 'fold' it lies back on its rest, its cycle stopped
// where it was and no load on its hook. One seen for the first time at work or at rest is out already: it did not unfold
// just as it came into view. Time is the displayed world's clock.
export function craneStep(arm: CraneArmState, duty: 'work' | 'rest' | 'fold', time: number, pace = 1): CraneArmState {
  const before = arm.time, first = before === undefined, dt = before === undefined || time < before ? 0 : Math.min(time - before, .25);
  if (arm.time !== undefined && time < arm.time) Object.assign(arm, { deployed: 0, cycle: 0, carrying: false });
  arm.time = time; arm.working = duty === 'work'; arm.finishing = false;
  arm.deployed ??= first && duty !== 'fold' ? 1 : 0; arm.cycle ??= 0;
  if (duty === 'fold') {
    arm.carrying = false; arm.deployed = Math.max(0, arm.deployed - dt / STOW_SECONDS);
    if (!arm.deployed) arm.cycle = 0;
    return arm;
  }
  if (arm.deployed < 1) { arm.deployed = Math.min(1, arm.deployed + dt / DEPLOY_SECONDS); return arm; }
  if (arm.working) { arm.pace = pace; arm.carrying = true; arm.cycle += dt * pace; return arm; }
  const end = Math.max(0, Math.ceil(arm.cycle / LIFT_SECONDS - 1e-9)) * LIFT_SECONDS;
  arm.cycle = Math.min(end, arm.cycle + dt * (arm.pace ?? 1));
  arm.carrying &&= arm.cycle < end; arm.finishing = arm.carrying;
  return arm;
}

// Where a crane takes its loads up and where it sets them down, each a place of the field (`x`) with the height a load
// stands at there (`floor`), and the height its tip carries them at (`lift`), clear over everything between. A works it
// puts up (`target`: the stretch it takes up and the boxes of what of it there is to set a load on) it brings from its
// own construction — the top of a supply piece of it not too near the column, or else whatever lies `bed` out of the
// column — onto the works; a structure it takes down (`target.down`, the boxes of its parts) it takes off onto the ground
// before it, where its heap will lie; and a heap it loads (`target.gather`) it takes up from where it lies onto its own
// construction, as it would bring a works its loads. What is past its reach it works towards, as far as it goes — but a
// works it falls short of over its own construction, where it has nothing to set a load on, and a heap it falls short of,
// it only reaches out to, its hook up there, and lifts nothing (`short`) —; and with nothing known to work at (`target`
// null: the works of another faction is not told to a page), a little past the end of its construction.
export function craneRoute(layout: CraneLayout, parts: readonly WorkPart[], ground: HeightAt, target: CraneGeometryTarget | null = null): CraneRoute {
  const { pivot, side, size } = layout, own = boxesOf(parts), boxes = target ? [...own, ...target.boxes] : own,
    out = (x: number): number => side * (x - pivot.x), at = (d: number): number => pivot.x + side * d,
    floor = (x: number): number => boxes.reduce((top, box) => box.lo <= x && box.hi >= x ? Math.max(top, box.top) : top, ground(x)),
    supply = parts.filter(part => part?.kind === 'supply' && part.attached !== false && !(Number(part.health) <= 0) &&
      out(Number(part.x)) >= .75 * CRANE.bed * size && out(Number(part.x)) <= layout.boom + layout.jib).sort((a, b) => out(Number(a.x)) - out(Number(b.x)))[0],
    near = supply ? out(Number(supply.x)) : CRANE.bed * size, apart = 1.2 * size,
    edge = target ? out(clamp(pivot.x, target.lo, target.hi)) : 0, inset = target ? Math.min(CRANE.inset * size, (target.hi - target.lo) / 2) : 0,
    goal = Math.max(near + apart, target ? edge + inset : layout.clearance + CRANE.past * size),
    lo = Math.min(at(near), at(goal)), hi = Math.max(at(near), at(goal)),
    top = boxes.reduce((most, box) => box.hi >= lo && box.lo <= hi ? Math.max(most, box.top) : most, Math.max(ground(lo), ground(hi), ground((lo + hi) / 2))),
    lift = top + (CRANE.clear + CRANE.load[1] + CRANE.slings + CRANE.block + CRANE.cable) * size,
    // As far out as its tip reaches at that height, with a little to spare.
    most = .96 * (layout.boom + layout.jib + layout.telescope), reach = Math.sqrt(Math.max(0, most * most - (lift - pivot.y) ** 2)),
    far = Math.min(goal, Math.max(near + apart, reach)), stand = (d: number): LoadPlace => ({ x: at(d), floor: floor(at(d)) });
  if (target?.down) return { from: stand(far), to: stand(Math.max(near, Math.min(edge - .7 * size, far - apart))), lift, reach, short: false };
  const end = stand(far), short = target !== null && far < goal - 1e-9 && (target.gather || own.some(box => box.lo <= end.x && box.hi >= end.x));
  if (target?.gather) return { from: end, to: short ? end : stand(near), lift, reach, short };
  return { from: short ? end : stand(near), to: end, lift, reach, short };
}

// A preferred stop for the crane as installed now. It never changes the field's BUILD_REACH permission.
// The ordinary driver may still be stopped or turned by the real field; its dispatcher tries this only once per trip.
export function craneParking(parts: readonly WorkPart[], target: CraneGeometryTarget, ground: HeightAt,
  { x, arrival, clearance }: { x: number; arrival: number; clearance: number }): number | null {
  const bounds = boxesOf(parts);
  if (!bounds.length) return null;
  const lo = Math.min(...bounds.map(box => box.lo)), hi = Math.max(...bounds.map(box => box.hi)),
    shift = (at: number): WorkPart[] => {
      const dx = at - x, dy = ground(at) - ground(x);
      return parts.map(part => { const shape = part.definition || part;
        return { ...part, x: Number(part.x ?? shape.x) + dx, y: Number(part.y ?? shape.y) + dy }; });
    },
    reaches = (at: number): boolean => {
      const posed = shift(at), boxes = boxesOf(posed);
      if (!(Math.max(...boxes.map(box => box.hi)) <= target.lo - clearance + 1e-9 ||
        Math.min(...boxes.map(box => box.lo)) >= target.hi + clearance - 1e-9)) return false;
      return posed.some(piece => {
        if (piece.kind !== 'builder' || piece.attached === false || !(Number(piece.health) > 0)) return false;
        const tool = { x: Number(piece.x), y: Number(piece.y), width: Number(piece.width), height: Number(piece.height), angle: piece.angle },
          layout = craneLayout(tool, workFrame(tool, posed), craneSide(tool, target)), route = craneRoute(layout, posed, ground, target),
          end = target.down ? route.from : route.to;
        return end.x >= target.lo - 1e-9 && end.x <= target.hi + 1e-9 &&
          [route.from, route.to].every(point => Math.abs(point.x - layout.pivot.x) <= route.reach + 1e-9);
      });
    };
  if (reaches(x)) return x;
  // A standing structure is never crossed to put a rear-mounted crane on its other side.
  const side = hi <= target.lo ? -1 : lo >= target.hi ? 1 : 0;
  if (target.down && !side) return null;
  const places = [
    { side: -1, x: target.lo - clearance - arrival - (hi - x) },
    { side: 1, x: target.hi + clearance + arrival - (lo - x) }
  ].filter(place => !target.down || place.side === side).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
  return places.find(place => [place.x - arrival, place.x, place.x + arrival].every(reaches))?.x ?? null;
}

// Each mark gives the share of a lift, the end of the route the tip is over and how far the hook is let down there, to
// the load. A load is on the hook between the shares `HOOKED`; before, it stands where it is taken from, coming to be
// there (`COMES`), and after, where it was set down, going into what it is set on (`GOES`).
const LIFT: readonly (readonly [number, 'from' | 'to', number])[] = [[0, 'from', 0], [.1, 'from', 1], [.2, 'from', 1], [.3, 'from', 0], [.56, 'to', 0], [.66, 'to', 1], [.76, 'to', 1], [.86, 'to', 0], [1, 'from', 0]];
const HOOKED: readonly [number, number] = [.15, .71], COMES = .1, GOES = .86;
// The angles of the main boom and of the outer boom, and how far its sections run out, that put the tip at a place.
// Of the two ways to bend, the knuckle above the line to the tip, as the outer boom folds down from the main one: the
// tip is always out of the column, so the way does not change through a lift. The sections run out only as far as the
// two booms would have to straighten.
function craneReach(layout: CraneLayout, x: number, y: number): { boom: number; bend: number; run: number } {
  const { pivot, side, boom, jib, telescope } = layout, along = side * (x - pivot.x), up = y - pivot.y,
    run = clamp(Math.hypot(along, up) - .82 * (boom + jib), 0, telescope), angles = solve({ boom, stick: jib + run }, along, up);
  return { boom: angles.boom, bend: angles.stick - angles.boom - 2 * Math.PI * Math.round((angles.stick - angles.boom) / (2 * Math.PI)), run };
}
function cranePose(layout: CraneLayout, share: number, route: CraneRoute) {
  const next = LIFT.findIndex(([at]) => at > share), a = item(LIFT, next - 1), b = item(LIFT, next), t = ease((share - a[0]) / (b[0] - a[0]));
  return { ...craneReach(layout, lerp(route[a[1]].x, route[b[1]].x, t), route.lift), down: lerp(a[2], b[2], t), over: route[a[1]] };
}

// What is drawn of a crane, in places of the world: its slewing base on the casing (`base`) and the foot of its column on
// that (`mount`), the pivot on its column, the knuckle, the end of the outer boom (`sleeve`) and the tip its sections run
// out to, the hook block hung from the tip, the boom rest (`rest`) and the load (`load`: where its pallet stands, how far
// it has come to be or gone, and whether it hangs), with their sizes. Only a crane at work, or setting down what it lifted
// before it rests (`craneStep`), carries a load. A folded crane asks nothing of the ground, and has no route.
export function craneFigure(layout: CraneLayout, arm: CraneArmState = {}, route: CraneRoute | null = null): CraneFigure {
  const { side, pivot, base, tilt, size, boom, jib } = layout, open = clamp(arm.deployed || 0, 0, 1),
    rise = ease(clamp(open / RAISE, 0, 1)), unfold = ease(clamp((open - 1 + RAISE) / RAISE, 0, 1)),
    at = (x: number, y: number): Point => ({ x: pivot.x + side * x, y: pivot.y + y }), turn = (angle: number, length: number): [number, number] => [Math.cos(angle) * length, Math.sin(angle) * length],
    share = (arm.cycle || 0) / LIFT_SECONDS % 1, work = open > 0 && route ? cranePose(layout, share, route) : null,
    lean = lerp(FOLDED.boom + tilt, work ? work.boom : FOLDED.boom + tilt, rise),
    bend = lerp(FOLDED.jib - FOLDED.boom, work ? work.bend : FOLDED.jib - FOLDED.boom, unfold), run = work ? work.run * unfold : 0,
    [kx, ky] = turn(lean, boom), [jx, jy] = turn(lean + bend, jib), [tx, ty] = turn(lean + bend, jib + run), tip = at(kx + tx, ky + ty),
    [width, high] = CRANE.load, stack = (CRANE.block + CRANE.slings + high) * size, shortest = CRANE.cable * size,
    reaching = work ? Math.max(shortest, lerp(shortest, tip.y - work.over.floor - stack, work.down)) : 0,
    // Folded, the cable lets the hook down from the tip of the outer boom onto the casing, as it is on its piece — no further
    // than the tip stands off the foot of its slewing base: a piece turned on end has its casing run by under the tip.
    [fx, fy] = turn(FOLDED.boom + tilt, boom), [gx, gy] = turn(FOLDED.jib + tilt, jib),
    folded: [number, number] = [fx + gx - side * (base.x - pivot.x), fy + gy - (base.y - pivot.y)],
    stowed = clamp(folded[1] - folded[0] * Math.tan(tilt) - (CRANE.block + CRANE.hook) * size, 0, Math.hypot(...folded)),
    cable = lerp(stowed, reaching, unfold), hook = { x: tip.x, y: tip.y - cable };
  let load: (Point & { shown: number; hung: boolean }) | null = null;
  if (open >= 1 && (arm.working || arm.finishing) && work && route) {
    if (share < HOOKED[0]) load = { x: route.from.x, y: route.from.floor, shown: clamp(share / COMES, 0, 1), hung: false };
    else if (share < HOOKED[1]) load = { x: hook.x, y: hook.y - stack, shown: 1, hung: true };
    else load = { x: route.to.x, y: route.to.floor, shown: 1 - clamp((share - GOES) / (1 - GOES), 0, 1), hung: false };
  }
  return { kind: 'builder', side, size, base, mount: layout.mount, pivot, knuckle: at(kx, ky), sleeve: at(kx + jx, ky + jy), tip, run, hook,
    rest: layout.rest, block: CRANE.block * size, crook: CRANE.hook * size, slings: CRANE.slings * size,
    load: load && { ...load, width: width * size, height: high * size } };
}
