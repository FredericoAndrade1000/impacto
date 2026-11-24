import { clamp, smoothstep } from './math.ts';
import { REVERSE_SHARE } from './battle-rules.ts';
export { REVERSE_SHARE };

// The gearbox of an engine as it is heard (audio.ts, `updateEngines`): the sound's alone. The field drives a vehicle
// with no gears, and a shift heard takes nothing from its push. It turns how fast the vehicle goes into how fast its
// engine turns, as a share of its rated speed: an automatic box of four gears under a track, as those of the Abrams and
// the Leopard 2, and of six on wheels. Each of GEARS turns the engine so many times faster than the top one, each step
// a little shorter than the one below it, and the top one turns it at its rated speed at the vehicle's top speed. One
// gear backs: the engine turns at its rated speed as fast as a vehicle backs (REVERSE_SHARE of its top speed, game_motion.rs).
export const GEARS = Object.freeze({ track: Object.freeze([3.2, 1.9, 1.35, 1]), wheel: Object.freeze([4, 2.6, 1.85, 1.4, 1.15, 1]) });
// The engine idles at ENGINE_IDLE of its rated speed. Pressed on in the first gear or backing, its converter lets it
// run up to ENGINE_STALL before the vehicle goes — standing, or slipping where it stands. Run downhill past its rated
// speed, it turns no faster than ENGINE_OVERRUN.
export const ENGINE_IDLE = .3, ENGINE_STALL = .6, ENGINE_OVERRUN = 1.1;
// It goes up a gear near its rated speed, the sooner the less it is pressed on (`upshift`), and down one as it falls
// low (`downshift`). Braking, it only goes down, at BRAKING_DOWN. Climbing, both come up by as much as the slope is
// steep, up to CLIMB_LIFT, and it goes up at its rated speed at the latest. The two lie further apart than the longest
// step of a gear, so that a shift lands between them and never calls the other one. Slower than CRAWL metres a second
// it is in the first gear.
export const upshift = (pull: number): number => .72 + .22 * pull, downshift = (pull: number): number => .36 + .1 * pull;
export const BRAKING_DOWN = .5, CLIMB_LIFT = .2, CRAWL = .5;
// A shift takes SHIFT_TIME seconds: over them the engine falls (or rises) to its speed in the new gear, eased at both
// ends, and the sound dips by SHIFT_DIP in the middle. No shift follows another sooner than SHIFT_HOLD seconds.
export const SHIFT_TIME = .25, SHIFT_DIP = .25, SHIFT_HOLD = .6;

// How fast the engine turns in a gear (-1 backing) at a speed of the vehicle, in metres a second, for its top speed.
export const engineTurning = (gears: readonly number[], gear: number, speed: number, top: number): number =>
  speed * (gear < 0 ? 1 / REVERSE_SHARE : gears[gear] ?? NaN) / top;
// The gear a vehicle going at `speed` is in, pressed on as `pull`: the lowest one not yet due to go up.
export function gearFor(gears: readonly number[], speed: number, top: number, pull: number): number {
  const gear = gears.findIndex((_, i) => engineTurning(gears, i, speed, top) < upshift(pull));
  return gear < 0 ? gears.length - 1 : gear;
}

export class Gearbox {
  gears: readonly number[];
  gear: number | null = null;
  turning = ENGINE_IDLE;
  shift: { at: number; from: number } | null = null;
  constructor(tracked?: boolean) { this.gears = GEARS[tracked ? 'track' : 'wheel']; }
  // The engine at `time`, in seconds, as the vehicle goes: `speed` along its way, in metres a second, and its `top`
  // speed; how hard it is pressed on (`pull`, 0 to 1); whether it brakes or backs; and how steep the ground it climbs
  // is (`climb`, the sine of the slope, uphill along its way). Says the gear, how fast the engine turns and how much of
  // its sound a shift takes away (`dip`). It starts in the gear its speed calls for.
  update({ speed, top, pull = 0, braking = false, backing = false, climb = 0 }: {
    speed: number; top: number; pull?: number; braking?: boolean; backing?: boolean; climb?: number;
  }, time: number): { gear: number; turning: number; dip: number } {
    const gears = this.gears, lift = 1 + clamp(climb, 0, CLIMB_LIFT);
    let gear = this.gear;
    if (backing) gear = -1;
    else if (gear === null) gear = gearFor(gears, speed, top, pull);
    else if (gear < 0 || speed < CRAWL) gear = 0;
    else if (!(this.shift && time < this.shift.at + SHIFT_HOLD)) {
      const turning = engineTurning(gears, gear, speed, top);
      if (!braking && gear < gears.length - 1 && turning >= Math.min(1, upshift(pull) * lift)) gear++;
      else if (gear > 0 && turning <= (braking ? BRAKING_DOWN : downshift(pull) * lift)) gear--;
    }
    if (this.gear !== null && gear !== this.gear) this.shift = { at: time, from: this.turning };
    this.gear = gear;
    const least = gear > 0 ? ENGINE_IDLE : ENGINE_IDLE + (ENGINE_STALL - ENGINE_IDLE) * pull,
      target = clamp(engineTurning(gears, gear, speed, top), least, ENGINE_OVERRUN), shift = this.shift,
      into = shift ? clamp((time - shift.at) / SHIFT_TIME, 0, 1) : 1;
    this.turning = into < 1 && shift ? shift.from + (target - shift.from) * smoothstep(into) : target;
    return { gear, turning: this.turning, dip: into < 1 ? SHIFT_DIP * Math.sin(Math.PI * into) : 0 };
  }
}
