import { tr } from './i18n.ts';
import { weaponAngle } from './weapon-geometry.ts';
import { angleDifference, clamp, lerp, smoothstep } from './math.ts';
import { weaponOf, recoilAt, isWeaponId } from './weapons.ts';
import type { WeaponPresetId, WeaponFamilyId } from './weapons.ts';
import type { Point } from './math.ts';
import type { Camera } from './camera.ts';
import type { ImpactPrediction } from './impact-preview.ts';

interface RecoilProfile { attack: number; returnRate: number }
export interface RecoilMotion extends RecoilProfile { preset: unknown; from: number; stroke: number; age: number; value: number }
export interface PivotBody extends Point { angle: number; vx?: number | undefined; vy?: number | undefined; omega?: number | undefined; carrierCenter?: Point | undefined }
export interface ServoModule { angle: number; barrelAngle?: number | undefined; targetBarrelAngle?: number | undefined; elevationDisabled?: boolean | undefined;
  weaponMount: { min: number; max: number; maxSpeed: number; fireTolerance: number } }
export interface ForecastPoint extends Point { time?: number | undefined }
export interface ForecastShift { from: Point; to: Point }
export interface PathForecast { key: string; state: { time: number }; path: ForecastPoint[]; flight: number; impact: ImpactPrediction | null; terrain: unknown; roads: unknown }
interface PathCursor { i: number; x?: number; y?: number }
interface AimCursor { key: unknown; now: number; started: number; from: Point; to: Point; at: Point }
interface TimedForecast<T> { state: { time: number }; made: number; raw: T }
interface ForecastPair<T> { from: TimedForecast<T> | null; current: TimedForecast<T> }

// A quick rearward stroke followed by a damped return to battery. Automatic
// weapons settle between rounds; heavy guns return under their recuperator.
const RECOIL: Partial<Record<WeaponFamilyId, RecoilProfile>> = {
  machinegun: { attack: .012, returnRate: 60 },
  autocannon: { attack: .018, returnRate: 38 },
  grenade: { attack: .018, returnRate: 34 },
  cannon: { attack: .025, returnRate: 12 },
  mortar: { attack: .02, returnRate: 22 },
  howitzer: { attack: .03, returnRate: 9 },
};

// A rigid-barrel machine gun still moves a little in its mount when it fires.
// This is presentation only; the admitted recoil reserve and collision solids
// keep the weapon's physical measurements, including recoilless launchers.
export function visualRecoilStroke(preset: unknown, elevation = 0) {
  const model = isWeaponId(preset) ? weaponOf(preset) : undefined;
  if (!isWeaponId(preset) || !model) return 0;
  return recoilAt(preset, elevation) || (model.family === 'machinegun' ? Math.min(.02, model.caliberMm * .002) : 0);
}

function recoilValue(motion: RecoilMotion, age: number) {
  if (age < motion.attack) {
    const remaining = 1 - Math.max(0, age) / motion.attack;
    return motion.from + (motion.stroke - motion.from) * (1 - remaining * remaining * remaining);
  }
  const elapsed = (age - motion.attack) * motion.returnRate;
  return motion.stroke * (1 + elapsed) * Math.exp(-elapsed);
}

// `ahead` is the event's offset into the one effects step that follows it.
// A record is allocated on a shot, reused through a burst and updated in place.
export function startWeaponRecoil(motion: RecoilMotion | null | undefined, stroke: number, preset: unknown, ahead = 0) {
  const model = isWeaponId(preset) ? weaponOf(preset) : undefined, profile = RECOIL[model?.family!] || RECOIL.cannon!,
    from = motion?.preset === preset ? recoilValue(motion!, motion!.age + ahead) : 0;
  motion ||= { preset, from, stroke, attack: Math.min(profile.attack, 12 / (model?.rate || 6)),
    returnRate: Math.max(profile.returnRate, (model?.rate || 6) / 15), age: -ahead, value: from };
  motion.preset = preset;
  motion.from = Math.min(stroke, from);
  motion.stroke = stroke;
  motion.attack = Math.min(profile.attack, 12 / (model?.rate || 6));
  motion.returnRate = Math.max(profile.returnRate, (model?.rate || 6) / 15);
  motion.age = -ahead;
  motion.value = motion.from;
  return motion;
}

export function advanceWeaponRecoil(motion: RecoilMotion, dt: number) {
  motion.age += dt;
  motion.value = recoilValue(motion, motion.age);
  return motion.age <= motion.attack || motion.value >= .0005;
}

// The barrels of a rotary gun come up to their rate, `rate / barrels` turns a minute, in its `spinUp` with each shot it fires
// (its muzzle events), and stop in SPIN_DOWN once its shots stop (game_variant.rs `SPIN_UP`, `SPIN_DOWN`): its shots stop
// when none came for `hold`, a little over the time between two. Drawn, they turn no further between two frames of a
// sixtieth of a second than STROBE of the angle between two barrels, where faster turning would seem to stand or run back
// (`angle`); from a quarter of that angle a frame they run together into a blur (`blur`, 0 to 1).
export const SPIN_DOWN = .25;
const FRAME = 1 / 60, SPIN_STROBE = .3;
export interface SpinMotion { preset: unknown; barrels: number; top: number; up: number; hold: number; idle: number; speed: number; angle: number; blur: number }
export function startWeaponSpin(motion: SpinMotion | null | undefined, preset: unknown, ahead = 0): SpinMotion | null {
  const model = isWeaponId(preset) ? weaponOf(preset) : undefined, barrels = model?.steel?.barrels ?? 1;
  if (!model || barrels < 2 || !(model.rate > 0)) return null;
  motion ||= { preset, barrels, top: 0, up: 0, hold: 0, idle: 0, speed: 0, angle: 0, blur: 0 };
  motion.preset = preset; motion.barrels = barrels; motion.top = model.rate / 60 / barrels;
  motion.up = model.spinUp || .4; motion.hold = Math.max(.08, 2.5 * 60 / model.rate); motion.idle = -ahead;
  return motion;
}
// Whether it still turns.
export function advanceWeaponSpin(motion: SpinMotion, dt: number) {
  motion.idle += dt;
  const firing = motion.idle < motion.hold, spacing = 2 * Math.PI / motion.barrels;
  motion.speed = firing ? Math.min(motion.top, motion.speed + motion.top * dt / motion.up) : Math.max(0, motion.speed - motion.top * dt / SPIN_DOWN);
  motion.angle = (motion.angle + Math.min(motion.speed * 2 * Math.PI * dt, SPIN_STROBE * spacing * dt / FRAME)) % (2 * Math.PI);
  motion.blur = clamp((motion.speed * motion.barrels * FRAME - .25) / .5, 0, 1);
  return firing || motion.speed > 0;
}

// The ready rounds of a gun as its frames tell them (`loaded`, scene-contract.ts), turned into what moves in its
// compartment: the places its magazine's drum, or its belt, has gone forward (`places`, a whole number), as many as the
// rounds fed, fired or put back — a refill turns the drum forward too, and runs a new belt in, as far as is seen of it
// (BELT_RUN) — and how far the drawing has come towards that (`turned`). Of a drum of `chambers`, which hold a round:
// fired, the chamber at the rammer is emptied and the next turned to it; refilled, the drum turns and the chamber that
// last left the rammer empty is filled; a magazine of more rounds than go round its drum keeps it full from the rings
// within. Chamber `j` stands at the rammer when `turned` is `j` (mod `chambers`).
const BELT_RUN = 6;
export interface FeedMotion { places: number; turned: number; loaded: number; chambers: boolean[] | null; seen: number }
const mod = (n: number, m: number) => ((n % m) + m) % m;
export function followFeed(motion: FeedMotion | null | undefined, loaded: number | null | undefined, { kind, rounds, chambers = 0 }: { kind: 'belt' | 'magazine'; rounds: number; chambers?: number }): FeedMotion {
  const n = Math.max(0, Math.round(Number.isFinite(loaded) ? loaded! : rounds)), m = kind === 'magazine' ? Math.max(1, chambers) : 0;
  if (!motion || (m ? motion.chambers?.length !== m : motion.chambers)) {
    const places = motion?.places ?? 0, fill = m ? Array.from({ length: m }, (_, j) => mod(j - places, m) < Math.min(n, m)) : null;
    return { places, turned: motion?.turned ?? 0, loaded: n, chambers: fill, seen: motion?.seen ?? 0 };
  }
  const change = n - motion.loaded;
  if (!change) return motion;
  if (!m) motion.places += change < 0 ? -change : Math.min(change, BELT_RUN);
  else {
    const fill = motion.chambers!, count = () => fill.reduce((sum, full) => sum + (full ? 1 : 0), 0);
    let have = motion.loaded;
    const steps = Math.min(Math.abs(change), 2 * m);
    for (let i = 0; i < steps; i++) {
      if (change < 0) {
        have--;
        if (have < m) fill[mod(motion.places, m)] = false;
        motion.places++;
      } else {
        have++; motion.places++;
        if (count() < Math.min(have, m)) for (let k = 1; k <= m; k++) {
          const j = mod(motion.places - k, m);
          if (!fill[j]) { fill[j] = true; break; }
        }
      }
    }
    motion.places += Math.abs(change) - steps;
    // Whatever else was missed is made good: the chambers last to come to the rammer emptied, the next to come filled.
    const want = Math.min(n, m);
    for (let k = 1; k <= m && count() > want; k++) fill[mod(motion.places - k, m)] = false;
    for (let k = 0; k < m && count() < want; k++) fill[mod(motion.places + k, m)] = true;
  }
  motion.loaded = n;
  return motion;
}
// The drawing goes the rest of the way (`places - turned`) quickly, and no faster between two frames than FEED_STROBE
// of a place; what is a whole turn of a drum (`chambers`), or more than a belt's run behind, it skips, unchanged to see.
const FEED_STROBE = .35;
export function advanceFeed(motion: FeedMotion, dt: number) {
  let behind = motion.places - motion.turned;
  if (behind <= 1e-6) { motion.turned = motion.places; return; }
  const cycle = motion.chambers?.length || 1, most = motion.chambers ? cycle : BELT_RUN;
  if (behind > most) { const skip = Math.ceil((behind - most) / cycle) * cycle; motion.turned += skip; behind -= skip; }
  motion.turned += Math.min(behind, dt * Math.min(FEED_STROBE / FRAME, Math.max(3, behind * 12)));
}

// Drive velocity is measured at the admitted COM. The flight instrument takes
// pivot velocity and adds angular muzzle motion at its own physical barrel.
export function presentedPivotVelocity(body: PivotBody | null | undefined, pivot: Point) {
  if (!body) return undefined;
  const local = body.carrierCenter || { x: 0, y: 0 }, c = Math.cos(body.angle), s = Math.sin(body.angle),
    centerX = body.x + c * local.x - s * local.y,
    centerY = body.y + s * local.x + c * local.y;
  return { x: Number(body.vx) - Number(body.omega) * (pivot.y - centerY),
    y: Number(body.vy) + Number(body.omega) * (pivot.x - centerX), omega: body.omega };
}

// The native mount exports limits relative to its admitted world axis.
// This is a read-only drawing envelope; the actuator remains in Rust.
export function presentedMountSector(module: Pick<ServoModule, 'angle' | 'barrelAngle'> & {weaponMount?: ServoModule['weaponMount'] | undefined} | null | undefined) {
  const mount = module?.weaponMount;
  if (!mount) return null;
  return { min: module!.angle + mount.min, max: module!.angle + mount.max,
    current: weaponAngle(module!), maxSpeed: mount.maxSpeed };
}

// The guide drawn while a gun swings to its aim: the dashed line along the aim runs past the muzzle of a gun of any
// length, and the arc of the swing stays by the pivot, where it reads at any zoom.
export const servoGuide = (barrel: number) => ({ extent: barrel + .8, radius: Math.max(.25, Math.min(.65, barrel * .45)) });

// What keeps a gun from the aim it was given, as the player reads it: the travel of its mount, an aim nearer than
// the steepest arc it rises to comes down (`near`), or one further than its rounds carry.
const AIM_LIMITS = Object.freeze({ sector: tr('Fora do setor da montagem'), near: tr('Perto demais para o arco') });
export const aimLimitText = (solution: { limit: string | null }) => (solution.limit === 'sector' || solution.limit === 'near' ? AIM_LIMITS[solution.limit] : undefined) || tr('Fora do alcance');

// The servo guide uses the sampled physical pose. A target angle is a goal for
// the actuator, never a substitute for its current angle.
export function servoStatus(module: ServoModule | null | undefined, target = module?.targetBarrelAngle) {
  if (!module) return { aligning: false, errorDegrees: 0, disabled: false };
  const error = angleDifference(target ?? weaponAngle(module), weaponAngle(module)), disabled = Boolean(module.elevationDisabled);
  return { aligning: !disabled && Math.abs(error) > module.weaponMount.fireTolerance, disabled, errorDegrees: Math.abs(error) * 180 / Math.PI, error };
}

// Where a point carried by a piece goes as the piece goes from one pose to another: along with it, turned about its place
// as the piece turned (`angle` reads how a pose is turned: a gun by its barrel).
interface CarrierPose extends Point { angle?: number | undefined; barrelAngle?: number | undefined }
export function carried(point: Point, from: CarrierPose, to: CarrierPose, angle: (pose: CarrierPose) => number = pose => pose.angle || 0) {
  const turn = angle(to) - angle(from), c = Math.cos(turn), s = Math.sin(turn), dx = point.x - from.x, dy = point.y - from.y;
  return { x: to.x + c * dx - s * dy, y: to.y + s * dx + c * dy };
}
// A path of a flight with its start moved by `from` and its end by `to`, and each point between by both, as far as it is
// along the time of the flight (`flight`; the end of a path may hold no time, and is there at the end of it): two arcs
// that leave a place and its neighbour with one velocity and come down at the same time differ by just that. The points
// are written into `into`, and keep their times.
export function movedPath(path: readonly ForecastPoint[], flight: number, from: Point, to: Point, into: ForecastPoint[] = []) {
  into.length = path.length;
  for (let i = 0; i < path.length; i++) {
    const point = path[i]!, share = i === path.length - 1 ? 1 : flight > 0 ? clamp(point.time! / flight, 0, 1) : 0, moved = into[i] ||= { x: point.x, y: point.y };
    moved.x = point.x + from.x * (1 - share) + to.x * share; moved.y = point.y + from.y * (1 - share) + to.y * share;
    moved.time = i === path.length - 1 ? flight : point.time;
  }
  return into;
}

// Only the drawing blends forecasts. Each end was solved against one complete snapshot;
// neither a displayed muzzle nor a displayed contact is fed back into a physical query.
// The frame draws the field between two snapshots, behind the newest (presentation.ts), and a gun that moves fast is
// drawn far from where the snapshot of its forecast has it: 18 m between two deliveries at 360 m/s. The renderer says by
// how much (`shift`: from the place its muzzle is in the snapshot of a forecast to where the frame draws that muzzle, and
// from its contact to where the frame draws what is met there), and every forecast is drawn moved so (`movedPath`)
// before it is compared or blended: two forecasts of a gun going by are then told apart only by what changed in them.
const PREVIEW_PAIR_MS = 75, CURSOR_MS = 35, PREVIEW_STEPS = 512, ARC_JUMP = 4;
const previewError = (zoom: number) => Math.min(.5, 16 / zoom);
const cursorJump = (zoom: number) => Math.min(4, 96 / zoom);
function pathPoint(forecast: PathForecast, share: number, cursor: PathCursor, moved: ForecastShift | null = null): Point & PathCursor {
  const path = forecast.path, time = share * forecast.flight,
    at = (i: number) => i === path.length - 1 ? forecast.flight : path[i]!.time!;
  while (cursor.i < path.length - 2 && at(cursor.i + 1) < time) cursor.i++;
  const a = path[cursor.i]!, b = path[Math.min(cursor.i + 1, path.length - 1)]!,
    duration = at(Math.min(cursor.i + 1, path.length - 1)) - at(cursor.i),
    t = duration > 0 ? clamp((time - at(cursor.i)) / duration, 0, 1) : share;
  cursor.x = lerp(a.x, b.x, t); cursor.y = lerp(a.y, b.y, t);
  if (moved) { cursor.x += moved.from.x * (1 - share) + moved.to.x * share; cursor.y += moved.from.y * (1 - share) + moved.to.y * share; }
  // The reusable cursor acquires its two coordinates in this sample.
  return cursor as PathCursor & Point;
}

export class AimPresentation<T extends PathForecast = PathForecast> {
  declare pair: ForecastPair<T> | null | undefined;
  declare cursor: AimCursor | null | undefined;
  declare placedPath?: ForecastPoint[];
  declare path?: ForecastPoint[];
  declare points?: Point[];
  clear() { this.pair = this.cursor = null; }
  // A forecast drawn where the frame shows its gun and what it meets (`moved`, from `shift`), or as it was solved.
  placed(forecast: T, moved: ForecastShift | null) {
    if (!moved) return forecast;
    const path = this.placedPath = movedPath(forecast.path, forecast.flight, moved.from, moved.to, this.placedPath), end = path.at(-1)!;
    return { ...forecast, path, impact: forecast.impact && { ...forecast.impact, x: end.x, y: end.y } };
  }
  sample(raw: T, { state, previous, alpha, now, zoom, reset = false, shift = () => null }: {
    state: { time: number }; previous: { time: number } | null | undefined; alpha: number; now: number; zoom: number; reset?: boolean;
    shift?: (forecast: T) => ForecastShift | null;
  }) {
    const moved = shift(raw);
    if (reset) { this.clear(); return this.placed(raw, moved); }
    if (this.pair?.current.state !== state) {
      const from = this.pair?.current;
      this.pair = { from: from && previous && from.state === previous && state.time > previous.time && now >= from.made &&
          now - from.made <= PREVIEW_PAIR_MS ? from : null,
        current: { state, made: now, raw } };
    } else this.pair.current.raw = raw;
    const pair = this.pair, before = pair.from?.raw;
    if (!before || before.key !== raw.key || Boolean(before.impact) !== Boolean(raw.impact) ||
        Boolean(before.impact?.bounce) !== Boolean(raw.impact?.bounce) ||
        before.terrain !== raw.terrain || before.roads !== raw.roads ||
        now < pair.current.made || now - pair.current.made > PREVIEW_PAIR_MS) { pair.from = null; return this.placed(raw, moved); }
    const was = shift(before), end = (forecast: T, by: ForecastShift | null) => by ? { x: forecast.path.at(-1)!.x + by.to.x, y: forecast.path.at(-1)!.y + by.to.y } : forecast.path.at(-1)!,
      last = end(raw, moved), old = end(before, was), distance = Math.hypot(last.x - old.x, last.y - old.y),
      jump = ARC_JUMP;
    if (distance > jump || before.impact && before.impact.nx * raw.impact!.nx + before.impact.ny * raw.impact!.ny <= 0) {
      pair.from = null; return this.placed(raw, moved);
    }
    const sceneBlend = clamp(alpha, 0, 1), blend = Math.max(sceneBlend, distance > 0 ? 1 - previewError(zoom) / distance : 0);
    if (sceneBlend >= 1) return this.placed(raw, moved);
    const count = Math.min(PREVIEW_STEPS, Math.max(before.path.length, raw.path.length) - 1),
      path = this.path ||= [], a = { i: 0 }, b = { i: 0 }, flight = lerp(before.flight, raw.flight, blend);
    path.length = count + 1;
    for (let i = 0; i <= count; i++) {
      const share = count ? i / count : 0, from = pathPoint(before, share, a, was), to = pathPoint(raw, share, b, moved);
      if (Math.hypot(from.x - to.x, from.y - to.y) > jump) { pair.from = null; return this.placed(raw, moved); }
      // The muzzle stays with the scene. Only towards the contact does the
      // drawing approach its tighter error bound, with zero correction slope at the muzzle.
      const point = path[i] ||= { x: from.x, y: from.y }, along = sceneBlend + (blend - sceneBlend) * smoothstep(share);
      point.x = lerp(from.x, to.x, along); point.y = lerp(from.y, to.y, along); point.time = share * flight;
    }
    let impact = raw.impact;
    if (impact) {
      const nx = lerp(before.impact!.nx, impact.nx, blend), ny = lerp(before.impact!.ny, impact.ny, blend),
        normal = Math.hypot(nx, ny), end = path.at(-1)!;
      const shown = { ...impact, x: end.x, y: end.y, nx: nx / normal, ny: ny / normal, time: flight,
        angleDegrees: lerp(before.impact!.angleDegrees, impact.angleDegrees, blend) };
      if (shown.bounce) shown.bounce = { ...shown.bounce,
        vx: lerp(before.impact!.bounce!.vx, shown.bounce.vx, blend),
        vy: lerp(before.impact!.bounce!.vy, shown.bounce.vy, blend) };
      impact = shown;
    }
    return { ...raw, path, flight, impact };
  }
  // This is a short screen-space filter of the existing world aim, not an input
  // tracker: a still pointer never sends a new aim as the camera follows a vehicle.
  point(aim: Point, camera: Pick<Camera, 'toScreen' | 'toWorld' | 'zoom'>, now: number, key: unknown, reset = false) {
    const target = camera.toScreen(aim.x, aim.y), cursor = this.cursor, jump = cursorJump(camera.zoom) * camera.zoom;
    if (reset || !cursor || cursor.key !== key || now < cursor.now || now - cursor.now > PREVIEW_PAIR_MS ||
        Math.hypot(target.x - cursor.to.x, target.y - cursor.to.y) > jump) {
      this.cursor = { key, now, started: now, from: target, to: target, at: target }; return aim;
    }
    // Advance the last transition before accepting a newer target. Restarting
    // first would hold the cursor still during a continuous stream of moves.
    const blend = clamp((now - cursor.started) / CURSOR_MS, 0, 1);
    let at = blend >= 1 ? cursor.to : { x: lerp(cursor.from.x, cursor.to.x, blend), y: lerp(cursor.from.y, cursor.to.y, blend) };
    if (target.x !== cursor.to.x || target.y !== cursor.to.y) {
      cursor.from = at; cursor.to = target; cursor.started = now;
    }
    const distance = Math.hypot(target.x - at.x, target.y - at.y), error = previewError(camera.zoom) * camera.zoom;
    if (distance > error) {
      const keep = error / distance;
      at = { x: target.x + (at.x - target.x) * keep, y: target.y + (at.y - target.y) * keep };
      cursor.from = at; cursor.started = now;
    }
    cursor.now = now; cursor.at = at;
    return cursor.at.x === target.x && cursor.at.y === target.y ? aim : camera.toWorld(cursor.at.x, cursor.at.y);
  }
  marks(forecast: T) {
    const points = this.points ||= [], cursor = { i: 0 }; let count = 0;
    for (let time = 5; time < forecast.flight - 1e-9; time += 5) {
      const at = pathPoint(forecast, time / forecast.flight, cursor), point = points[count++] ||= { x: at.x, y: at.y };
      point.x = at.x; point.y = at.y;
    }
    points.length = count;
    return points;
  }
}
