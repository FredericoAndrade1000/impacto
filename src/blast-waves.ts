import { Sprite } from 'pixi.js';
import type { Container, Texture } from 'pixi.js';
import { clamp } from './math.ts';
import type { Point } from './math.ts';
import { SHOCKWAVE_RING_RADIUS } from './effect-art.ts';

const budgets = Object.freeze({ high: 24, balanced: 16, low: 8 });
const opacity = Object.freeze({ high: 1, balanced: .8, low: .6 });

export type BlastWaveQuality = keyof typeof budgets;
export interface BlastWaveFront {
  startRadius: number; endRadius: number; opacity: number; refraction: number; life: number; travelTime: number;
}
export interface BlastWave extends BlastWaveFront, Point {
  actorId: string | null; age: number; previousAge: number; wait: number; travelScale: number;
  grounded: boolean; nx: number; ny: number; aspect: number;
  displayAge: number; displayRadius: number; frontRadius: number; displayAlpha: number;
  displayX: number; displayY: number; displayRotation: number; tint: number; sprite: Sprite;
}
export interface BlastWaveEvent extends Point { actorId?: string | null; radius?: number; ground?: boolean }
export interface BlastWaveOptions {
  ground?: number | { y: number; nx?: number; ny?: number } | null;
  quality?: string; ahead?: number; front?: BlastWaveFront | null;
}
type WaveTarget = Container & { glows?: Container };
type TargetForActor = (id: string | null) => WaveTarget | null | undefined;

// Quad half-width and the nominal visible front are distinct: the atlas keeps
// transparent padding outside its thin edge. These pure queries also serve the
// optical layer; age is presentation time in seconds, never simulation damage.
export function blastWaveRadius(wave: Pick<BlastWave, 'age' | 'life' | 'travelTime' | 'travelScale' | 'startRadius' | 'endRadius'>, age = wave.age): number {
  const elapsed = Number.isFinite(age) ? clamp(age, 0, wave.life) : 0,
    expansion = -Math.expm1(-elapsed / wave.travelTime) * wave.travelScale;
  return wave.startRadius + (wave.endRadius - wave.startRadius) * expansion;
}

// The eye catches the pressure front of a burst only from a few kilograms of
// explosive up, an 81 mm bomb's: below this radius, in metres, a burst is its
// flash, fire, smoke and dust alone. The radius already grows as the cube root
// of the charge, as the reach of the front does; a 155 mm shell's is the full one.
const FRONT_CUT = 3, FULL_FRONT = 7.2;

// How a front looks: where it starts and how far it runs (metres), how bright
// its edge is, how strongly it bends the air (1 is a 155 mm shell's), how long
// it lasts and how soon it slows (seconds). A burst's grows with its radius,
// in reach and in light alike; a burst too small for a front has none.
export function burstFront(radius: number | undefined): BlastWaveFront | null {
  if (radius === undefined || !(radius >= FRONT_CUT)) return null;
  const strength = Math.min(1, radius / FULL_FRONT);
  return { startRadius: .22, endRadius: Math.min(12, radius * 1.363), opacity: .207 * strength, refraction: strength,
    life: .15 + .048 * strength, travelTime: .014 + .0046 * strength };
}
// The faint front of a gun's own blast, by its bore against a 120 mm one and
// the length of its flame. It is the propellant's, not a burst's: no cut applies.
export function muzzleFront(bore: number, flame: number): BlastWaveFront {
  const strength = bore * .54, radius = flame * .45;
  return { startRadius: radius * .07, endRadius: radius * (1.21 + strength * .1), opacity: .18 * Math.max(.6, strength),
    refraction: 1, life: .155 + .028 * strength, travelTime: .016 + .004 / strength };
}

// A short pressure front is entirely presentation state. It shares the cached
// particle atlas, advances only in simulation time, and owns at most one quad
// per wave. There are no terrain queries, filters or render textures here.
export class BlastWaves {
  declare texture: Texture;
  declare targetForActor: TargetForActor | undefined;
  declare waves: BlastWave[];
  declare sprites: Sprite[];
  declare pool: Sprite[];
  declare quality: BlastWaveQuality;
  declare limit: number;

  constructor(atlas: { shockwave?: Texture | null }, targetForActor?: TargetForActor) {
    if (!atlas.shockwave) throw new TypeError('The particle atlas requires a shockwave texture.');
    this.texture = atlas.shockwave;
    this.targetForActor = targetForActor;
    this.waves = []; this.sprites = []; this.pool = [];
    this.quality = 'high'; this.limit = budgets.high;
  }
  setQuality(quality: unknown): void {
    this.quality = quality === 'balanced' || quality === 'low' ? quality : 'high'; this.limit = budgets[this.quality];
    // Preserve recent fronts when quality drops. Unused sprite slots are also
    // trimmed, so low quality cannot retain a large dormant pool.
    while (this.waves.length > this.limit) this.retire(this.waves.shift()!);
    while (this.sprites.length > this.limit) {
      const sprite = this.pool.pop()!;
      this.sprites.splice(this.sprites.indexOf(sprite), 1); sprite.destroy();
    }
  }
  acquire(): Sprite {
    let sprite = this.pool.pop();
    if (!sprite) {
      sprite = new Sprite(this.texture); sprite.anchor.set(.5); sprite.blendMode = 'add';
      this.sprites.push(sprite);
    }
    sprite.visible = false; sprite.alpha = 0; return sprite;
  }
  retire(wave: BlastWave): void {
    const sprite = wave.sprite;
    sprite.visible = false; sprite.alpha = 0;
    // Detaching before Effects destroys an actor layer protects pooled sprites
    // regardless of whether dropLayers reparents its remaining glow children.
    if (sprite.parent) sprite.parent.removeChild(sprite);
    this.pool.push(sprite);
  }
  // `front` is how the wave looks: a burst's, by its radius, unless stated, and none for a burst too small for one.
  // `ahead` is how long after the last update the blast came: the front waits that much of the next one.
  emit(event: BlastWaveEvent | null | undefined, { ground, quality, ahead = 0, front = burstFront(event?.radius) }: BlastWaveOptions = {}): BlastWave | null {
    if (!front || !event || ![event.x, event.y].every(Number.isFinite) || Math.abs(event.x) > 1e7 || Math.abs(event.y) > 1e7) return null;
    if (quality !== undefined && quality !== this.quality) this.setQuality(quality);
    const surface = typeof ground === 'number' ? undefined : ground,
      groundY = typeof ground === 'number' ? ground : ground?.y,
      grounded = Number.isFinite(groundY) && (event.ground === true || Math.abs(event.y - groundY!) <= .32),
      nx = grounded && Number.isFinite(surface?.nx) ? surface!.nx! : 0,
      ny = grounded && Number.isFinite(surface?.ny) ? surface!.ny! : 1,
      normalScale = Math.max(Math.abs(nx), Math.abs(ny)),
      normalLength = normalScale > 0 ? Math.hypot(nx / normalScale, ny / normalScale) : 0;
    if (this.waves.length >= this.limit) this.retire(this.waves.shift()!);
    const { life, travelTime, startRadius } = front;
    const wave: BlastWave = { actorId: event.actorId ?? null, age: 0, previousAge: 0, wait: ahead,
      life, travelTime, travelScale: 1 / -Math.expm1(-life / travelTime),
      x: event.x, y: grounded ? groundY! + .014 : event.y,
      grounded, nx: normalLength ? nx / normalScale / normalLength : 0,
      ny: normalLength ? ny / normalScale / normalLength : 1, aspect: grounded ? .14 : 1,
      startRadius, endRadius: front.endRadius, opacity: front.opacity, refraction: front.refraction,
      displayAge: 0, displayRadius: startRadius, frontRadius: startRadius * SHOCKWAVE_RING_RADIUS,
      displayAlpha: 0, displayX: event.x, displayY: grounded ? groundY! + .014 : event.y, displayRotation: 0,
      tint: grounded ? 0xe4c69c : 0xf2dfbd, sprite: this.acquire() };
    this.waves.push(wave); return wave;
  }
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    let write = 0;
    for (const wave of this.waves) {
      wave.previousAge = wave.age; wave.age += wave.wait > 0 ? Math.max(0, dt - wave.wait) : dt; wave.wait = 0;
      if (wave.age >= wave.life) this.retire(wave);
      else this.waves[write++] = wave;
    }
    this.waves.length = write;
  }
  sample(alpha = 1): void {
    const interpolation = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    for (const wave of this.waves) {
      const age = wave.previousAge + (wave.age - wave.previousAge) * interpolation,
        t = clamp(age / wave.life, 0, 1), radius = blastWaveRadius(wave, age),
        light = wave.opacity * opacity[this.quality] * Math.pow(1 - t, 3.15) * (.82 + .18 * Math.min(1, age / .008)),
        // Lift a ground ellipse along the surface normal so its bottom remains
        // on the ground instead of glowing through the soil cutaway.
        lift = wave.grounded ? radius * wave.aspect : 0,
        sprite = wave.sprite, target = this.targetForActor?.(wave.actorId), layer = target?.glows || target;
      // Record the exact interpolated geometry, including terrain lift, once.
      // Heat haze can reuse it without allocating or guessing a second radius.
      wave.displayAge = age; wave.displayRadius = radius; wave.frontRadius = radius * SHOCKWAVE_RING_RADIUS;
      wave.displayX = wave.x + wave.nx * lift; wave.displayY = wave.y + wave.ny * lift;
      wave.displayRotation = wave.grounded ? Math.atan2(-wave.nx, wave.ny) : 0;
      sprite.visible = Boolean(layer && !layer.destroyed && light > .003);
      wave.displayAlpha = sprite.visible ? light : 0;
      if (!sprite.visible) { sprite.alpha = 0; continue; }
      if (sprite.parent !== layer) layer!.addChild(sprite);
      sprite.position.set(wave.displayX, wave.displayY);
      sprite.width = radius * 2; sprite.height = radius * 2 * wave.aspect;
      sprite.rotation = wave.displayRotation;
      sprite.tint = wave.tint; sprite.alpha = light;
    }
  }
  resetActors(resetSet?: ReadonlySet<string | null> | null): void {
    if (!resetSet?.size) return;
    let write = 0;
    for (const wave of this.waves) {
      if (resetSet.has(wave.actorId)) this.retire(wave);
      else this.waves[write++] = wave;
    }
    this.waves.length = write;
  }
  clear(): void {
    for (const wave of this.waves) this.retire(wave);
    this.waves.length = 0;
  }
}
