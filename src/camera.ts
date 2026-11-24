import { clamp, plateCorners } from './math.ts';
import type { Point, PlateGeometry } from './math.ts';
export interface CameraCover { top: number; bottom: number; left: number; right: number }
export type CameraShape = Point & { angle?: number } &
  ({ length: number; width?: number; height?: number } | { length?: undefined; width: number; height: number });
export interface CameraTarget { readonly plates: readonly CameraShape[]; readonly modules: readonly CameraShape[] }
export interface CameraFlightTarget { readonly plates: readonly PlateGeometry[]; readonly modules: readonly { x: number; y: number; width: number; height: number }[] }
export interface CameraGround { height(x: number): number }
export interface CameraFollowPose extends Point { id: string; time: number; flying?: boolean }
interface FollowedPose extends CameraFollowPose { height: number; lift: number; rise: number }
export interface CameraLimits { minX: number; maxX: number; minY: number }
export interface CameraOrigin extends Point { mirror?: boolean }



// Compose a part/project reflection with the camera's horizontal orientation.
export const screenMirrored = (mirrored: unknown, turn = 1) => Boolean(mirrored) !== (turn < 0);

// `cover` says how many pixels of each side of the view the panels over the field hide: a framing puts what it
// frames in the part they leave. Nothing is hidden unless the page says so.
const UNCOVERED = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
// The part of the view a framing has: what the panels leave, and a third of the view at least.
function free(camera: CameraFrame) {
  const { top, bottom, left, right } = camera.cover();
  return { top, bottom, left, right, width: Math.max(camera.width / 3, camera.width - left - right), height: Math.max(camera.height / 3, camera.height - top - bottom) };
}

// The view goes with a vehicle as a camera on a car alongside it would. Along the ground it goes with the vehicle at
// once. Up and down it goes with the ground under the vehicle at once too (`groundUnder`), so that a slope, a crest or
// a ditch takes the view with it without lagging; and with the height of the vehicle over that ground only as a
// critically damped spring of FOLLOW_EASE seconds of the world takes it: the hull rocks on its springs over the bumps of
// the ground in a view that holds still, and the view comes after a vehicle that leaves the ground, or sinks into it,
// without a jolt. Paused, the spring stands; slowed, it is slowed with the world. A vehicle in the air rocks on no
// springs: the view takes its climb or its descent along at once, and the spring eases only how far it stands from it,
// so that a steady climb keeps it where it was in the view instead of a spring's lag of twice FOLLOW_EASE behind.
const FOLLOW_EASE = .3;
// The ground the view goes along is its mean over GROUND_REACH metres to either side of the vehicle, in so many
// stretches: a step or a ditch the vehicle crosses moves the view over the time it takes to cross them, not at once.
const GROUND_REACH = 2, GROUND_STRETCHES = 16;
const LEVEL = { height: () => 0 };
function groundUnder(ground: CameraGround, x: number) {
  let sum = 0;
  for (let i = 0; i <= GROUND_STRETCHES; i++)
    sum += ground.height(x + GROUND_REACH * (2 * i / GROUND_STRETCHES - 1)) * (i === 0 || i === GROUND_STRETCHES ? .5 : 1);
  return sum / GROUND_STRETCHES;
}
// Where the spring of FOLLOW_EASE seconds is `after` seconds on, from `at` going at `speed` towards `goal`.
function eased(at: number, speed: number, goal: number, after: number) {
  const rate = 1 / FOLLOW_EASE, off = at - goal, decay = Math.exp(-rate * after), pull = speed + rate * off;
  return { at: goal + (off + pull * after) * decay, speed: (speed - rate * pull * after) * decay };
}

// The camera is asked for a view and shows the nearest one inside the world. `limits` are the two ends of
// the ground and the foot of the earth drawn under it: a view is as wide as the ground at most, stops at
// its ends and never goes under that foot. Whoever moves the camera reads back the view that is shown.
export abstract class CameraFrame {
  abstract x: number;
  abstract y: number;
  abstract zoom: number;
  abstract readonly turn: number;
  abstract readonly minZoom: number;
  abstract readonly width: number;
  abstract readonly height: number;
  abstract readonly cover: () => CameraCover;
  toWorld(x: number, y: number) { return { x: this.turn * (x - this.width / 2) / this.zoom + this.x, y: (this.height / 2 - y) / this.zoom + this.y }; }
  toScreen(x: number, y: number) { return { x: this.turn * (x - this.x) * this.zoom + this.width / 2, y: this.height / 2 - (y - this.y) * this.zoom }; }
  pan(dx: number, dy: number) { this.x -= this.turn * dx / this.zoom; this.y += dy / this.zoom; }
  zoomAt(factor: number, x = this.width / 2, y = this.height / 2) {
    const before = this.toWorld(x, y); this.zoom = clamp(this.zoom * factor, this.minZoom, 650);
    const after = this.toWorld(x, y); this.x += before.x - after.x; this.y += before.y - after.y;
  }
  reveal(points: readonly Point[], margin = 12) {
    if (!points.length) return;
    const cover = this.cover(), left = cover.left + margin, right = this.width - cover.right - margin,
      top = cover.top + margin, bottom = this.height - cover.bottom - margin;
    if (right <= left || bottom <= top) return;
    const shown = points.map(p => this.toScreen(p.x, p.y)),
      shift = (low: number, high: number, start: number, end: number) => high - low > end - start ? (start + end - low - high) / 2 :
        low < start ? start - low : high > end ? end - high : 0,
      dx = shift(Math.min(...shown.map(p => p.x)), Math.max(...shown.map(p => p.x)), left, right),
      dy = shift(Math.min(...shown.map(p => p.y)), Math.max(...shown.map(p => p.y)), top, bottom);
    if (dx || dy) this.pan(dx, dy);
  }
  fit(blueprint: CameraTarget, targetOnly = false, floor = 0) {
    const objects = [...blueprint.plates, ...blueprint.modules];
    let minX = Infinity, maxX = -Infinity, minY = targetOnly ? Infinity : floor, maxY = targetOnly ? -Infinity : floor + 3.2;
    for (const object of objects) {
      const angle = object.angle || 0, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle)),
        hx = object.length ? object.length * c / 2 : ((object.width ?? NaN) * c + (object.height ?? NaN) * s) / 2,
        hy = object.length ? object.length * s / 2 : ((object.width ?? NaN) * s + (object.height ?? NaN) * c) / 2;
      minX = Math.min(minX, object.x - hx); maxX = Math.max(maxX, object.x + hx);
      minY = Math.min(minY, object.y - hy); maxY = Math.max(maxY, object.y + hy);
    }
    if (!Number.isFinite(maxX)) { minX = 0; maxX = 14; minY = 0; maxY = 3.2; }
    const view = free(this);
    this.zoom = clamp(Math.min(view.width / (maxX - minX + (targetOnly ? 1.3 : 2.8)), view.height / (maxY - minY + 2.0)), this.minZoom, targetOnly ? 260 : 180);
    this.x = (minX + maxX) / 2 - this.turn * (view.left - view.right) / 2 / this.zoom; this.y = (minY + maxY) * 0.5 - 0.18 + (view.top - view.bottom) / 2 / this.zoom;
  }
}

export class Camera extends CameraFrame {
  declare width: number;
  declare height: number;
  declare asked: { x: number; y: number; zoom: number; };
  declare farthest: number;
  declare limits: CameraLimits | null;
  declare cover: () => { top: number; bottom: number; left: number; right: number; };
  declare followed: FollowedPose | null | undefined;
  constructor(width = 900, height = 550) { super(); this.width = width; this.height = height; this.asked = { x: 8, y: 1.7, zoom: 65 }; this.farthest = 16; this.limits = null; this.cover = UNCOVERED; }
  get zoom() { const world = this.limits; return world ? Math.max(this.asked.zoom, this.width / (world.maxX - world.minX)) : this.asked.zoom; }
  set zoom(value: number) { this.asked.zoom = value; }
  get x() {
    const world = this.limits; if (!world) return this.asked.x;
    const half = this.width / this.zoom / 2; return clamp(this.asked.x, world.minX + half, world.maxX - half);
  }
  set x(value: number) { this.asked.x = value; }
  get y() { const world = this.limits; return world ? Math.max(this.asked.y, world.minY + this.height / this.zoom / 2) : this.asked.y; }
  set y(value: number) { this.asked.y = value; }
  // A camera of the world sees it the right way round; a frame drawn turned about (`FramedCamera`) the other way:
  // what goes right on the screen goes left in it.
  get turn() { return 1; }
  // The farthest view a zoom or a framing may ask for: what the mode allows, and the whole ground at most.
  get minZoom() { const world = this.limits; return world ? Math.max(this.farthest, this.width / (world.maxX - world.minX)) : this.farthest; }
  set minZoom(value: number) { this.farthest = value; }



  // `followed` is the place the view goes with: where the vehicle is along the ground, and over the ground under it
  // (`ground`) as high as the spring has taken it (`lift`), with the vehicle `height` over it and the spring closing
  // on it at `rise`.
  follow(pose: CameraFollowPose | null, ground: CameraGround = LEVEL) {
    if (!pose) { this.followed = null; return; }
    const old = this.followed, under = groundUnder(ground, pose.x), height = pose.y - under;
    // Move with the displayed pose, preserving the player's pan/zoom offset.
    // A reset or a different target starts a new baseline without a jump.
    // The view asked for goes on past an end of the world: held there, the camera
    // waits for the vehicle to come back to its place in the view.
    const held = old?.id === pose.id && pose.time >= old.time, after = held ? pose.time - old.time : 0,
      // In the air the spring goes after a height that climbs as the vehicle did between the two poses; on the
      // ground, after where the vehicle is now.
      climb = pose.flying && after > 0 && old ? (height - old.height) / after : 0,
      rest = held ? eased(old.lift - height + climb * after, old.rise, 0, after) : { at: 0, speed: 0 },
      lift = height + rest.at, y = under + lift;
    if (held) {
      this.asked.x += pose.x - old.x;
      this.asked.y += y - old.y;
    }
    this.followed = { ...pose, y, height, lift, rise: rest.speed };
  }

  // The wheel and two fingers zoom about their place in the view. Following preserves that offset as the vehicle moves.
  zoomBy(factor: number, x?: number, y?: number) { this.zoomAt(factor, x, y); }
  // Bring an object clear of panels with the smallest pan at the current zoom.
  // An object larger than the free span is centered on that axis, without zooming out.

  // The view of a design, with the ground under it unless `targetOnly`: `floor` is the height of the ground the
  // construction stands on in a test; the drawing board is at zero.

  fitFlight(path: readonly Point[] | null | undefined, target: CameraFlightTarget | null = null) {
    if (!path?.length) return;
    const points = [...path];
    for (const plate of target?.plates || []) points.push(...plateCorners(plate));
    for (const module of target?.modules || []) points.push(
      { x: module.x - module.width / 2, y: module.y - module.height / 2 },
      { x: module.x + module.width / 2, y: module.y + module.height / 2 });
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const view = free(this);
    this.zoom = clamp(Math.min(view.width / (maxX - minX + 8), view.height / (maxY - minY + 6)), this.minZoom, 180);
    this.x = (minX + maxX) / 2 - this.turn * (view.left - view.right) / 2 / this.zoom; this.y = (minY + maxY) / 2 - 0.2 + (view.top - view.bottom) / 2 / this.zoom;
  }
}

// A camera as a frame standing somewhere in its world has it: the same view, with every place counted
// from where the frame stands. `origin` tells that place each time it is asked, and whether the frame
// stands there turned about its `middle` (`mirror`): a design that will face the other way is drawn so.
// The frame is far from the middle of the world and what is in it is near its own: the two are taken
// apart here, in double precision, and nobody after this holds a place of the frame as a place of the
// world. Moved, zoomed or framed, it is the camera that moves.
export class FramedCamera extends CameraFrame {
  declare camera: Camera;
  declare origin: () => CameraOrigin;
  declare middle: number;
  constructor(camera: Camera, origin: () => CameraOrigin, middle = 0) { super(); this.camera = camera; this.origin = origin; this.middle = middle; }
  get turn() { return this.origin().mirror ? -1 : 1; }
  // The place of the world a place of the frame is. Turned about, the sum is the same the other way.
  world(x: number) { const origin = this.origin(); return origin.mirror ? origin.x + 2 * this.middle - x : origin.x + x; }
  get x() { const origin = this.origin(); return origin.mirror ? origin.x + 2 * this.middle - this.camera.x : this.camera.x - origin.x; }
  set x(value: number) { this.camera.x = this.world(value); }
  get y() { return this.camera.y - this.origin().y; }
  set y(value: number) { this.camera.y = value + this.origin().y; }
  get zoom() { return this.camera.zoom; }
  set zoom(value: number) { this.camera.zoom = value; }
  get minZoom() { return this.camera.minZoom; }
  get width() { return this.camera.width; }
  get height() { return this.camera.height; }
  get cover() { return this.camera.cover; }
}
