import { Random, TAU, smoothstep } from './math.ts';
import { WEAPONS, WEAPON_PRESETS, weaponOf, isWeaponId } from './weapons.ts';

// The view is jolted by what would jolt someone standing where it stands: the big gun of the vehicle in the player's
// hands going off, a burst about the middle of the screen, a round striking that vehicle. Only the drawing of the
// world is thrown, by a few pixels of the screen (`offset`): where the pointer is in the world, the aim and all the
// rest go on by the camera, which never shakes. Nothing shakes in the Workshop, nor for what the fog hides.
//
// Every jolt adds to one trauma, from none to TRAUMA_CAP, which falls back to exactly none at TRAUMA_DECAY a second of
// the world: slowed, the shake is slowed with the world, and paused it stands. The view is thrown as the square of the
// trauma, so that a small jolt is hardly seen and one on top of another tells; and along a smooth wave of the time of
// the shake (WAVE_HERTZ), not to a new place at random each frame, so that it reads as a shake at any rate of frames.
// The numbers below are the whole of its tuning.

// The most pixels of the screen the view is thrown, either way, at each level of the setting (`setLevel`).
export const SHAKE_LEVELS = Object.freeze({ off: 0, soft: 7, normal: 14 });
export type ShakeLevel = keyof typeof SHAKE_LEVELS;
export interface ShakeView { readonly x: number; readonly y: number; readonly zoom: number; readonly width: number; readonly height: number }
export interface ShakeEvent {
  readonly type: string;
  readonly actorId?: string | null | undefined;
  readonly targetActorId?: string | null | undefined;
  readonly preset?: string | null | undefined;
  readonly weapon?: string | null | undefined;
  readonly ground?: boolean | undefined;
  readonly power?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}
export interface ShakeContext { own?: string | null; view: ShakeView; seen?: boolean; mode?: string }
interface RecoilGun { readonly family?: string; readonly mass?: number; readonly speed?: number }
// Trauma lost in a second of the world: the strongest shake is over in half a second, that of a 120 mm shot in a third.
const TRAUMA_CAP = 1, TRAUMA_DECAY = 2;
// What comes on top of a shake adds to it, but no jolt raises it past PILE_UP times what it gives alone: a burst of an
// autocannon stays the faint shake of one round, two blasts at once shake more than one, and a barrage stops at the cap.
const PILE_UP = 1.5;
// The gun of the player's vehicle firing kicks it back by what the round carries away, its mass by its speed (`kick`):
// MUZZLE_TRAUMA for the kick of the 120 mm (MUZZLE_KICK), and for another gun as the cube root of what it kicks over
// MUZZLE_FLOOR against what the 120 mm does. A 25 mm about 0.2, a 105 mm howitzer 0.55, a 155 mm 0.75; a machine gun
// nothing and a grenade launcher, whose grenades leave slowly, hardly anything. A rocket or a recoilless gun lets its
// gases out behind as fast as its round leaves ahead: it kicks nothing.
const kick = (gun: RecoilGun | undefined): number => gun?.family === 'rocket' ? 0 : (gun?.mass || 0) * (gun?.speed || 0);
const MUZZLE_TRAUMA = .7, MUZZLE_KICK = kick(WEAPON_PRESETS.rh120), MUZZLE_FLOOR = 50;
// A burst: BLAST_TRAUMA for the power of a 120 mm high-explosive shell (BLAST_POWER), as the 2/3 power of its own: the
// ground a blast shakes as hard is as far across as the cube root of its charge, and so as wide as its 2/3 power. A
// 40 mm grenade about a third of it, a 30 mm shell 0.6, a 155 mm 1.2 times; whole
// out to NEAR_WHOLE from the middle of the screen and nothing from NEAR_NONE on, in halves of the screen (1 at its
// edge). A burst against the player's vehicle is whole wherever it is.
const BLAST_TRAUMA = .75, BLAST_POWER = 430, NEAR_WHOLE = .3, NEAR_NONE = 2.5;
// A round striking the player's vehicle, by what it does there: so much for the power of a 120 mm round (HIT_POWER), as
// the square root of its power and HIT_MOST times that at most; one through the armour PENETRATION_LEAST at the least.
const HIT_TRAUMA = Object.freeze({ penetration: .8, blocked: .45, module: .3, ricochet: .25, spall: .15 }),
  HIT_POWER = 430, HIT_MOST = 1.2, PENETRATION_LEAST = .45;
// Thrown whole from ZOOM_WHOLE pixels a metre in, not at all from ZOOM_NONE out, and smoothly between them as the zoom
// goes by its logarithm: about 70 % at 30 px/m, a quarter at 16 px/m. A view of a whole battle does not tremble.
const ZOOM_WHOLE = 60, ZOOM_NONE = 8;
// The wave: three of so many hertz along each axis, of these weights, which add to one.
const WAVE_HERTZ = Object.freeze([10.3, 16.1, 23.7, 11.3, 17.9, 26.3] as const), WAVE_WEIGHTS = Object.freeze([.6, .28, .12] as const);
const WAVE_AXES = [[0, 3], [1, 4], [2, 5]] as const;
const knownFamily = (id: unknown): id is keyof typeof WEAPONS => typeof id === 'string' && Object.hasOwn(WEAPONS, id);
const knownHit = (type: string): type is keyof typeof HIT_TRAUMA => Object.hasOwn(HIT_TRAUMA, type);
const knownLevel = (level: unknown): level is ShakeLevel => typeof level === 'string' && Object.hasOwn(SHAKE_LEVELS, level);

// How much of its shake the view is thrown at a zoom.
const zoomShare = (zoom: number): number => zoom > 0 ? smoothstep(Math.log(zoom / ZOOM_NONE) / Math.log(ZOOM_WHOLE / ZOOM_NONE)) : 0;
// How much a burst tells by how far from the middle of the view it is, measured on the screen: zoomed out, a place
// stands nearer the middle, and every shake is thrown fewer pixels (`zoomShare`).
function nearness(e: ShakeEvent, view: ShakeView): number {
  const far = Math.hypot(2 * (Number(e.x) - view.x) * view.zoom / view.width, 2 * (Number(e.y) - view.y) * view.zoom / view.height);
  return Number.isFinite(far) ? 1 - smoothstep((far - NEAR_WHOLE) / (NEAR_NONE - NEAR_WHOLE)) : 0;
}
// The trauma a thing that happened gives the view: a shot only when the player's vehicle fires it, a strike only on it.
function jolt(e: ShakeEvent, own: string | null, view: ShakeView): number {
  const mine = own != null && e.actorId === own;
  if (e.type === 'muzzle') {
    if (!mine) return 0;
    const gun = isWeaponId(e.preset) ? weaponOf(e.preset) : knownFamily(e.weapon) ? WEAPONS[e.weapon] : undefined;
    return MUZZLE_TRAUMA * Math.cbrt(Math.max(0, kick(gun) - MUZZLE_FLOOR) / (MUZZLE_KICK - MUZZLE_FLOOR));
  }
  if (e.type === 'explosion')
    return BLAST_TRAUMA * ((Math.max(0, Number(e.power)) || 0) / BLAST_POWER) ** (2 / 3) * (own != null && e.targetActorId === own ? 1 : nearness(e, view));
  if (!mine || e.ground || !knownHit(e.type)) return 0;
  const told = HIT_TRAUMA[e.type] * Math.min(HIT_MOST, Math.sqrt((Math.max(0, Number(e.power)) || 0) / HIT_POWER));
  return e.type === 'penetration' ? Math.max(PENETRATION_LEAST, told) : told;
}

export class ScreenShake {
  readonly phases: readonly [number, number, number, number, number, number];
  level: ShakeLevel = 'normal';
  trauma = 0;
  time = 0;
  readonly shift = { x: 0, y: 0 };
  // The phases of the wave are drawn from `seed`, so that the same jolts shake the same way.
  constructor(seed = 1) {
    const random = new Random(seed);
    const phase = () => random.range(0, TAU);
    this.phases = [phase(), phase(), phase(), phase(), phase(), phase()];
  }
  // 'off', 'soft' or 'normal', as the player set it, and anything else 'normal'. Turned off, what shook stops.
  setLevel(level: unknown): void {
    this.level = knownLevel(level) ? level : 'normal';
    if (!SHAKE_LEVELS[this.level]) this.trauma = 0;
  }
  // A thing that happened, `e` as the effects are told of it (effects.ts). `own` is the id of the vehicle in the
  // player's hands, if any; `view` the camera, its middle in metres of the world, its zoom in pixels a metre and its
  // size in pixels; `seen` whether the player sees where it happened, and `mode` the renderer's: what is not seen
  // shakes nothing, and nothing does in the Workshop.
  event(e: ShakeEvent, { own = null, view, seen = false, mode }: ShakeContext): void {
    if (!seen || mode === 'edit' || !SHAKE_LEVELS[this.level]) return;
    const amount = jolt(e, own, view);
    if (amount > 0) this.trauma = Math.min(TRAUMA_CAP, Math.max(this.trauma, Math.min(this.trauma + amount, amount * PILE_UP)));
  }
  // `dt` seconds of the world go by: the trauma falls and the wave goes on, both by the time of the world.
  update(dt: number): void {
    if (!(dt > 0) || !this.trauma) return;
    this.time += dt; this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
  }
  // Where the drawing of the world is thrown this frame, in pixels of the screen, at `zoom`: one object, written anew
  // each time. In the Workshop nowhere, and what shook the field before it is let go of, not kept for the return.
  offset(zoom: number, mode?: string): { x: number; y: number } {
    const shift = this.shift;
    if (mode === 'edit') this.trauma = 0;
    const reach = SHAKE_LEVELS[this.level] * this.trauma * this.trauma * zoomShare(zoom);
    shift.x = shift.y = 0;
    if (reach > 0) for (const [x, y] of WAVE_AXES) {
      shift.x += reach * WAVE_WEIGHTS[x] * Math.sin(TAU * WAVE_HERTZ[x] * this.time + this.phases[x]);
      shift.y += reach * WAVE_WEIGHTS[x] * Math.sin(TAU * WAVE_HERTZ[y] * this.time + this.phases[y]);
    }
    return shift;
  }
  clear(): void { this.trauma = 0; }
}
