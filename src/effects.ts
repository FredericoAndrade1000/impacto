import { Container, ParticleContainer, Particle, Sprite } from 'pixi.js';
import type { Texture, BLEND_MODES } from 'pixi.js';
import type { Point } from './math.ts';
import type { AmmoId } from './weapons.ts';
import type { Terrain } from './terrain.ts';
import type { Spans } from './ground-sight.ts';
import type { SceneEventBase } from './scene-contract.ts';
import type { EffectQuality, EffectView, EffectLight, LightSite } from './effect-types.ts';
import type { FirePose, FirePiece, FireSurface, FireProfile } from './fire-surface.ts';
import type { DrawingActor, DrawingModule } from './scene-drawing-contract.ts';
import type { Scorch } from './ground-scorch.ts';

export type ParticleKind = 'smoke' | 'fire' | 'spark' | 'dust' | 'flash';
export interface ParticleAtlas {
  smoke: readonly Texture[]; denseSmoke?: readonly Texture[]; fire: readonly Texture[]; flame?: readonly Texture[];
  glow: ReturnType<typeof createParticleAtlas>['glow']; spark: Texture; dust: Texture; muzzle: Texture; shockwave: Texture;
  flash?: Texture; jet?: readonly Texture[]; plume: readonly Texture[]; jetcore: Texture;
}
type ParticleArt = keyof ParticleAtlas;
type EffectEvent = SceneEventBase & Point;
type ParticleLayer = ParticleContainer<EffectSprite>;
interface ParticleLayers { smoke: ParticleLayer; fire: ParticleLayer; veil: ParticleLayer; sparks: ParticleLayer }
interface ActorParticleLayers extends ParticleLayers { group: Container; glows: Container }
interface EffectSprite extends Particle { home: ParticleLayer | null; left: number; kept: number }
export type EffectsTerrain = Pick<Terrain, 'points' | 'height' | 'segment' | 'surface' | 'groundAt'>;
interface DustSurface {
  terrain: EffectsTerrain; points: readonly Point[]; a: Point; b: Point;
  left: number; right: number; ay: number; by: number; slope: number;
}
interface BurnSource extends Point {
  key: string; actorId: string | null | undefined; componentId: string | undefined;
  strength: number; ttl: number; wait: number; fireClock: number; smokeClock: number;
  site: number; phase: number; flames: (EffectParticle | null | undefined)[];
  exterior?: boolean; spread?: number; radius?: number | undefined;
  flameCount?: number; scale?: number; heat?: number; lean?: number;
}
export interface EffectParticle extends Point {
  kind: ParticleKind; age: number; wait: number; life: number;
  vx: number; vy: number; size: number; grow: number; drag: number;
  rotation: number; spin: number; opacity: number; tint: number; aspectX: number; aspectY: number;
  lift: number | undefined; fade: number | undefined; fadeIn: number | undefined;
  hotSmoke: number | undefined; smokeTint: number; flame: boolean | undefined; ember: boolean | undefined;
  burnSource: BurnSource | undefined; burnSlot: number; burnSize: number; burnTurn: number; burnProfile: FireProfile | null | undefined;
  priority: boolean | undefined; additive: boolean | undefined; external: boolean | undefined;
  actorId: string | null | undefined; art: ParticleArt | undefined; anchorX: number | undefined;
  groundDust: boolean | undefined; dustDelay: number | undefined; dustLift: number; dustSurface: DustSurface | null | undefined;
  sprite: EffectSprite; phase: number; textureVariant: number; effectActorId: string | null; layer: ParticleLayer | null;
  previousX: number; previousY: number; floorTerrain: EffectsTerrain | null | undefined; floorX: number; floorHeight: number;
  carrier: string | undefined; carryX: number; carryY: number;
}
export type ParticleOptions = Partial<Omit<EffectParticle, 'kind' | 'sprite' | 'layer' | 'effectActorId' | 'textureVariant'>>;
interface LearnedRound extends Point { ammo: AmmoId | undefined; calibre: number | undefined; vx: number; vy: number }
interface FaceContact extends Point { nx: number; ny: number }
interface RayContact extends Point { id: string }
interface FragmentCone extends Point { time: number | undefined }
interface MuzzleProfile { reach: number; smoke: number; sparks?: number; brake?: number; fire?: number; dust?: number; wave?: boolean; back?: number }
export interface SurfaceTrail extends Point { surface: string; speed: number; seconds: number; direction: number; track?: boolean }
export interface SurfaceSpray extends Point { surface: string; slip: number; seconds: number; track?: boolean }
interface DustSkirt { count: number; speed: number; reach: number; opacity?: number }
type ThrusterModule = Pick<DrawingModule, 'kind' | 'thrust' | 'health' | 'attached' | 'width' | 'height' | 'x' | 'y' | 'angle'>;
export interface ThrusterJet extends Point {
  dx: number; dy: number; angle: number; thrust: number; nozzle: number; reach: number; length: number; core: number;
  contact: { distance: number; x: number; y: number; slope: number } | null; seed?: number;
}
interface JetEntry { group: Container; plume: Sprite; plumeNext: Sprite; core: Sprite; glow: Sprite; splash: Sprite; phase: number; round: number }
import { Random, clamp, smoothstep, lineNoise, TAU } from './math.ts';
import { createParticleAtlas } from './textures.ts';
import { GROUND_SURFACES } from './ground-impact.ts';
import { BlastWaves, muzzleFront } from './blast-waves.ts';
import { MUZZLE_JET_ROOT, JET_ROOT, PLUME_RADIUS, CORE_RADIUS, FLAME_FRAMES, FLAME_ROOT } from './effect-art.ts';
import { brittleMaterial, MODULES } from './materials.ts';
import { contains } from './ground-sight.ts';
import { VegetationMotion } from './vegetation-motion.ts';
import { firePoint, componentFirePoint } from './fire-surface.ts';
import { THRUSTER_NOZZLE } from './machine-art.ts';

const groundLooks: Readonly<Record<string, typeof GROUND_SURFACES[keyof typeof GROUND_SURFACES] | undefined>> = GROUND_SURFACES;
const textureArray = (art: Texture | readonly Texture[] | undefined): art is readonly Texture[] => Array.isArray(art);
function isPositioned(event: SceneEventBase): event is EffectEvent {
  return typeof event.x === 'number' && typeof event.y === 'number';
}
function assignParticleOptions<ParticleState extends object>(p: ParticleState, options: Partial<ParticleState>) {
  for (const key in options) p[key] = options[key]!;
}

function colorRamp(stops: readonly number[]) {
  return Array.from({ length: 32 }, (_, index) => {
    const t = index / 31 * (stops.length - 1), slot = Math.min(stops.length - 2, Math.floor(t)),
      mix = t - slot, a = stops[slot]!, b = stops[slot + 1]!;
    return [16, 8, 0].reduce((color, shift) => color | Math.round((a >>> shift & 255) * (1 - mix) + (b >>> shift & 255) * mix) << shift, 0);
  });
}
const FIRE_TINTS = colorRamp([0xffffff, 0xffedd6, 0xffc09b, 0xbf795d, 0x634945]);
const FLAME_TINTS = colorRamp([0xffffff,0xfff8eb,0xffe3b0,0xe8ba82]);
const BURN_FADE = .28;
// Three shades of blast smoke, hot to soot, and the pale smoke of burnt propellant.
const HOT_SMOKE_TINTS = [colorRamp([0xa49a89, 0x737971]), colorRamp([0xd0c9bb, 0xaeb5ad]), colorRamp([0xe9e7dd, 0xcdd2c9]),
  colorRamp([0xf3edde, 0xd8dcd5, 0xc1c8c0, 0xc1c8c0]), colorRamp([0x5d5b52,0x292e2b,0x626a62])];
const POWDER_SMOKE = 4;
// Road dust spreads low behind the running gear. The same smoke frames and emission budget
// cover slightly less screen area, with no extra layer, terrain query or per-frame artwork.
const DRIVING_DUST = { aspectX: 1.65, aspectY: .58, rotation: 0, spin: .06 };
// How each family shows a shot: flame length per unit of bore, its share of
// smoke, sparks and rolling fire, the side jets of a muzzle brake, the dust it
// raises, its pressure ring, and the rearward blast of a recoilless launcher.
const MUZZLES: Readonly<Record<string, MuzzleProfile | undefined>> = {
  machinegun: { reach: 2.2, smoke: .5 },
  autocannon: { reach: 2.6, smoke: .8, sparks: .4, brake: .5 },
  cannon: { reach: 3.2, smoke: 1.3, sparks: 1, fire: 6, dust: 1, wave: true },
  howitzer: { reach: 3, smoke: 1.5, sparks: .8, fire: 5, brake: .8, dust: 1, wave: true },
  mortar: { reach: 1.6, smoke: 1.1, sparks: .3, fire: 2, dust: .6 },
  grenade: { reach: 1, smoke: .6 },
  rocket: { reach: 1.1, smoke: .5, sparks: .3, back: 2.2 },
};
// How big a burst is drawn, by its power against that of a burst of 240, and how far it reaches, in metres.
const blastScale = (e: Pick<SceneEventBase, 'power'>) => clamp(Math.sqrt(Math.max(0, e.power || 240) / 240), .65, 1.7);
const blastRadius = (e: Pick<SceneEventBase, 'power' | 'radius'>) => clamp(e.radius || blastScale(e), .2, 6);
// Whether a particle, or what is about to be made, is off the screen, when the screen is known.
const outside = (view: EffectView | null, p: Partial<Point>) => !!view && (p.x! < view.left || p.x! > view.right || p.y! < view.bottom || p.y! > view.top);
// The zoom a size in pixels is reckoned at while the screen has not told its own: that of a camera at rest.
const RESTING_ZOOM = 65;
// What a round makes where it strikes goes with its bore: the square root of its calibre against 120 mm, or, where the
// calibre is not told (a contact under the hull of another faction), of its power against that of such a round.
const boreOf = (e: Pick<SceneEventBase, 'caliberMm' | 'power'>) => clamp(Math.sqrt((e.caliberMm ?? 0) > 0 ? e.caliberMm! / 120 : Math.max(0, e.power ?? 80) / 600), .25, 1.25);
// The normal an event tells of a face, made a unit; it points to the side the round came from. Untold, it looks back along x.
function faceNormal(e: Pick<SceneEventBase, 'nx' | 'ny'>): [number, number] {
  const length = Math.hypot(e.nx || 0, e.ny || 0);
  return length > 1e-9 ? [e.nx! / length, e.ny! / length] : [-1, 0];
}
// What a strike of a 120 mm round throws back out of the face: a splash `splash` metres across, drawn within `pixels`
// of the screen (both shrink with the bore), so that it still shows over a whole field and never covers the plate in a
// close view. A round that goes through throws back `through` of it. One that stops leaves the plate glowing where it
// struck for `glow` seconds, a spot `spot` metres across within `spotPixels`.
const STRIKE = { splash: .9, pixels: [26, 110], through: .55, glow: .4, spot: .16, spotPixels: [12, 40] };
// A fragment ray that ends more than RAY_FLEW_ON metres past its last contact got out of what it went through and flew
// on; one with no contact at all did so only if it flew as far as a fragment flies (FRAGMENT_FLIGHT in the core).
const RAY_FLEW_ON = .25, FREE_FLIGHT = 11.9;
// An HE round bursting on a face is a half dome on its outer side, its fireball DOME_PIXELS across at most.
const DOME_PIXELS = 240;
// How many rounds the effects keep what their paths told of (`learn`): more than strike within a few frames.
const ROUNDS_KEPT = 512;

// Only the thin blast dust follows the ground. Reuse its exact local segment
// while it remains inside that segment; rising smoke takes its existing path.
function groundDustHeight(p: EffectParticle, terrain: EffectsTerrain | null | undefined, x = p.x): number {
  const surface = p.dustSurface;
  if (surface && surface.terrain === terrain && surface.points === terrain?.points &&
      x >= surface.left && x <= surface.right && surface.a.x === surface.left && surface.b.x === surface.right &&
      surface.a.y === surface.ay && surface.b.y === surface.by)
    return surface.ay + (x - surface.left) * surface.slope;
  const segment = terrain?.segment?.(x), a = segment?.[0], b = segment?.[1];
  if (a && b && b.x > a.x) {
    p.dustSurface = { terrain: terrain!, points: terrain!.points, a, b, left: a.x, right: b.x, ay: a.y, by: b.y,
      slope: (b.y - a.y) / (b.x - a.x) };
    return a.y + (x - a.x) * p.dustSurface.slope;
  }
  p.dustSurface = null;
  return terrain?.height?.(x) || 0;
}

function updateGroundDust(p: EffectParticle, dt: number, terrain: EffectsTerrain | null | undefined, origin: Point) {
  const delay = p.dustDelay || 0, active = Math.max(0, p.age - delay), moving = Math.max(0, Math.min(dt, p.age - delay)),
    t = clamp(active / Math.max(.01, p.life - delay), 0, 1);
  p.vx *= Math.exp(-p.drag * moving); p.x += p.vx * moving; p.vy = 0;
  p.dustLift = .04 + Math.sin(Math.min(1, active) * Math.PI) * .025;
  p.y = groundDustHeight(p, terrain) + p.dustLift;
  const size = p.size + p.grow * active, sprite = p.sprite;
  sprite.x = p.x - origin.x; sprite.y = p.y - origin.y;
  sprite.scaleX = size * p.aspectX / 128; sprite.scaleY = size * p.aspectY / 128;
  sprite.rotation = Math.atan(p.dustSurface?.slope || 0);
  sprite.alpha = p.opacity * Math.min(1, active / .10) * (1 - t) ** (p.fade ?? 1.25);
}

// A particle hands Pixi its place in single precision, however few there are. So the particles of every
// layer are counted from one place near what the frame shows, the `origin`, and their containers stand there.
function particleLayers(parent: Container, atlas: ParticleAtlas, origin: Point): ParticleLayers {
  const layer = (texture: Texture, fire = false, sparks = false) => new ParticleContainer<EffectSprite>({ texture,
    dynamicProperties: { position: true, rotation: true, color: true, vertex: true, uvs: fire },
    blendMode: sparks ? 'add' : 'normal' }),
    layers = { smoke: layer(atlas.smoke[0]!), fire: layer(atlas.fire[0]!, true), veil: layer(atlas.smoke[0]!), sparks: layer(atlas.spark, false, true) };
  anchorParticleLayers(layers, origin.x, origin.y);
  parent.addChild(layers.smoke, layers.fire, layers.veil, layers.sparks); return layers;
}
function anchorParticleLayers(layers: ParticleLayers, x: number, y: number) {
  layers.smoke.position.set(x, y); layers.fire.position.set(x, y); layers.veil.position.set(x, y); layers.sparks.position.set(x, y);
}
// Particle.tint runs Pixi's colour conversion even when the palette entry has
// not changed. Alpha keeps updating independently on every simulation step.
function tintParticle(sprite: Particle, tint: number) {
  if (sprite.tint !== tint) sprite.tint = tint;
}

// The jet of a thruster (machine-art.ts `paintThruster`) at full thrust, in diameters of its nozzle: the hot plume
// (`plume`), the bright cone of gas still as fast as it left (`core`) and the glow round the exit (`glow`); and how many
// puffs of dust a second the jet of a thruster of the catalogue's size (`NOZZLE`) blows out of the ground it meets right
// under its nozzle (`dust`), fewer off a hard one (`HARD`).
const JET = Object.freeze({ plume: 6.5, core: .8, glow: 1.2, dust: 14 }), HARD = new Set(['concrete', 'asphalt', 'rock']),
  NOZZLE = MODULES.thruster.width * THRUSTER_NOZZLE;
// How a jet looks for the ground ahead of it: at so many places along it, then halving the step between the last two so
// many times.
const JET_PROBES = 8, JET_HALVINGS = 4;
// Where the jet of a thruster is and how far it reaches on this frame: out of the middle of the foot of the piece where
// `place` has it, along the piece's own downward axis, turned with it — upright, aslant or upside down —, as long and as
// bright as the share of its full thrust the flight computer gave it on the last step (`thrust`); none from one stopped,
// destroyed or torn off. Where it meets the `ground` it stops, and tells where (`contact`).
export function thrusterJet(module: ThrusterModule, place: FirePose = module, ground: Pick<Terrain, 'height'> | null = null): ThrusterJet | null {
  const thrust = clamp(module.thrust || 0, 0, 1);
  if (module.kind !== 'thruster' || !(thrust > 0) || module.health !== undefined && module.health <= 0 || module.attached === false) return null;
  const angle = place.angle || 0, dx = Math.sin(angle), dy = -Math.cos(angle), half = module.height / 2,
    x = place.x + dx * half, y = place.y + dy * half, nozzle = module.width * THRUSTER_NOZZLE, reach = nozzle * JET.plume * thrust,
    under = (d: number) => y + dy * d < ground!.height(x + dx * d);
  let met: number | null = null;
  if (ground?.height) {
    if (under(0)) met = 0;
    else for (let i = 1; i <= JET_PROBES && met === null; i++) if (under(reach * i / JET_PROBES)) {
      let clear = reach * (i - 1) / JET_PROBES, buried = reach * i / JET_PROBES;
      for (let k = 0; k < JET_HALVINGS; k++) { const mid = (clear + buried) / 2; if (under(mid)) buried = mid; else clear = mid; }
      met = (clear + buried) / 2;
    }
  }
  const length = met ?? reach, at = met === null ? null : x + dx * met;
  return { x, y, dx, dy, angle: Math.atan2(dy, dx), thrust, nozzle, reach, length, core: Math.min(length, nozzle * JET.core * thrust),
    contact: met === null ? null : { distance: met, x: at!, y: y + dy * met, slope: Math.atan2(ground!.height(at! + .2) - ground!.height(at! - .2), .4) } };
}

// The jets of the thrusters a frame shows (`thrusterJet`), each a group of a few sprites of the effects' atlas at its
// nozzle, turned along it: its plume, the core over it and the glow of the nozzle adding their light, and where it meets
// the ground the splash of it there, with the dust it blows out (`Effects.skirt`, within the budget of the particles).
// Each group goes in the layer it is given — whoever draws gives the thruster's own, for the skin of a hull to hide what
// of it is within —, and goes away with its jet: what is neither drawn nor kept between `begin` and `end` is gone. They
// flicker by the time of the effects (`update`), never by a clock of the world. The jets drawn are told the air over
// them as well (`heat`, heat-haze.ts).
export class ThrusterJets {
  declare effects: Effects; declare jets: Map<string, JetEntry>; declare time: number; declare seconds: number; declare round: number; declare heat: ThrusterJet[];
  constructor(effects: Effects) {
    this.effects = effects; this.jets = new Map(); this.time = 0; this.seconds = 0; this.round = 0; this.heat = [];
  }
  update(dt: number) { if (dt > 0) { this.time += dt; this.seconds += dt; } }
  begin() { this.round++; this.heat.length = 0; }
  // A jet its construction does not draw on this frame, kept as it was.
  keep(id: string) { const entry = this.jets.get(id); if (entry) entry.round = this.round; }
  draw(id: string, layer: Container | null | undefined, jet: ThrusterJet | null, zoom = Infinity) {
    let entry = this.jets.get(id);
    if (!jet || !layer || layer.destroyed || jet.nozzle * zoom < 1) {
      if (entry) { entry.round = this.round; if (!entry.group.destroyed) entry.group.visible = false; }
      return;
    }
    const atlas = this.effects.atlas;
    if (!entry || entry.group.destroyed) {
      const group = new Container(), sprite = (texture: Texture, blendMode: BLEND_MODES, tint: number, anchor = .5) => {
        const made = group.addChild(new Sprite(texture)); made.anchor.set(anchor, .5); made.blendMode = blendMode; made.tint = tint; return made;
      };
      // Each jet flickers on a time of its own, from its name.
      let seed = 0;
      for (const c of String(id)) seed = Math.imul(seed, 31) + c.charCodeAt(0) | 0;
      entry = { group, plume: sprite(atlas.plume[0]!, 'normal', 0xffffff, JET_ROOT), plumeNext: sprite(atlas.plume[1]!, 'normal', 0xffffff, JET_ROOT),
        core: sprite(atlas.jetcore, 'add', 0xe6eaff, JET_ROOT), glow: sprite(atlas.glow, 'add', 0xffbd91),
        splash: sprite(atlas.glow, 'add', 0xd0c9bd), phase: (seed >>> 0) / 4294967296 * 97, round: 0 };
      this.jets.set(id, entry);
    }
    const { group, plume, plumeNext, core, glow, splash } = entry, t = this.time + entry.phase, power = jet.thrust,
      flicker = .94 + .04 * Math.sin(t * 19) + .02 * Math.sin(t * 11.3),
      detailed = this.effects.quality !== 'low' && jet.nozzle * zoom >= 3, frame = t * 10, mix = detailed ? frame - Math.floor(frame) : 0;
    entry.round = this.round;
    if (group.parent !== layer) layer.addChild(group);
    group.visible = true; group.position.set(jet.x, jet.y); group.rotation = jet.angle;
    // Crossfade two cached frames instead of stepping through three silhouettes.
    // The extra quad shares the atlas/batch and disappears on low quality or afar.
    plume.texture = atlas.plume[detailed ? Math.floor(frame) % atlas.plume.length : 0]!;
    plumeNext.texture = atlas.plume[(Math.floor(frame) + 1) % atlas.plume.length]!; plumeNext.visible = detailed;
    plume.width = jet.length * (.97 + .03 * Math.sin(t * 29)); plume.height = jet.nozzle / PLUME_RADIUS;
    plumeNext.width = plume.width; plumeNext.height = plume.height;
    plume.alpha = .24 * power * flicker * (1 - mix); plumeNext.alpha = .24 * power * flicker * mix;
    core.width = jet.core; core.height = jet.nozzle / CORE_RADIUS; core.alpha = .4 * power * flicker;
    glow.position.set(-jet.nozzle * .06, 0); glow.width = glow.height = jet.nozzle * JET.glow; glow.alpha = .14 * power;
    // The harder and the nearer the jet meets the ground, the more it splashes and blows there.
    const contact = jet.contact, blow = contact ? power * (1 - contact.distance / Math.max(jet.reach, 1e-9)) : 0;
    splash.visible = blow > .02;
    if (contact && splash.visible) {
      splash.position.set(contact.distance, 0); splash.rotation = contact.slope - jet.angle;
      splash.width = jet.nozzle * (2.2 + 2.5 * blow); splash.height = jet.nozzle * (.2 + .2 * blow); splash.alpha = .08 * blow * flicker;
      const fx = this.effects, loose = HARD.has(fx.terrain?.groundAt?.(contact.x) ?? '') ? .35 : 1,
        due = this.seconds * JET.dust * blow * loose * clamp(jet.nozzle / NOZZLE, .4, 3), count = Math.floor(due) + (fx.random.next() < due % 1 ? 1 : 0);
      if (count) fx.skirt(contact.x, { count, speed: .4 + .8 * blow, reach: jet.nozzle * 4, opacity: .5 + .6 * blow });
    }
    if (detailed) { jet.seed = entry.phase; this.heat.push(jet); }
  }
  end() {
    for (const [id, entry] of this.jets) if (entry.round !== this.round) {
      if (!entry.group.destroyed) entry.group.destroy({ children: true });
      this.jets.delete(id);
    }
    this.seconds = 0;
  }
  clear() {
    for (const entry of this.jets.values()) if (!entry.group.destroyed) entry.group.destroy({ children: true });
    this.jets.clear(); this.heat.length = 0; this.seconds = 0;
  }
}

export class Effects implements ParticleLayers {
  declare parent: Container; declare atlas: ParticleAtlas; declare random: Random; declare particles: EffectParticle[]; declare pool: EffectSprite[];
  declare lights: EffectLight[]; declare scorches: Scorch[]; declare actorLayers: Map<string, ActorParticleLayers>; declare actorRevisions: Map<string, number>;
  declare burningSources: Map<string, BurnSource>; declare fireCount: number; declare cloudCount: number; declare vacated: Set<ParticleLayer>; declare settled: number; declare evictionCursor: number;
  declare rounds: Map<string, LearnedRound>; declare faces: Map<string, FaceContact>; declare rayContact: RayContact | null; declare cone: FragmentCone | null;
  declare pose: ((id: string | null | undefined) => (FirePose & FirePiece) | null | undefined) | null;
  declare velocity: ((id: string | null | undefined) => { vx?: number | undefined; vy?: number | undefined } | null | undefined) | null;
  declare fireProfile: ((id: string | undefined) => FireProfile | null | undefined) | null;
  declare fireSurface?: (id: string | null | undefined) => FireSurface | null | undefined;
  declare actorLayer?: (id: string) => Container | null | undefined;
  declare terrain?: EffectsTerrain | null;
  declare emitterActorId?: string | null;
  declare ahead: number; declare origin: Point; declare sight: Spans | null; declare view: (EffectView & { zoom: number }) | null; declare offView: number;
  declare smoke: ParticleLayer; declare fire: ParticleLayer; declare veil: ParticleLayer; declare sparks: ParticleLayer;
  declare limit: number; declare glows: Container; declare lightSprites: Sprite[]; declare blastWaves: BlastWaves; declare vegetation: VegetationMotion; declare jets: ThrusterJets;
  declare quality: EffectQuality; declare density: number; declare time: number;
  constructor(parent: Container, atlas: ParticleAtlas = createParticleAtlas()) {
    this.parent = parent; this.atlas = atlas; this.random = new Random(9247); this.particles = []; this.pool = []; this.lights = []; this.scorches = [];
    this.actorLayers = new Map();
    this.actorRevisions = new Map();
    this.burningSources = new Map();
    // How many of the particles are fire, and smoke or dust (`cloudCount`): only a kind there is any of is looked for
    // to make room. The layers sprites left since they were last settled, and how many times they were (`retire`).
    this.fireCount = 0; this.cloudCount = 0; this.vacated = new Set(); this.settled = 0;
    this.evictionCursor = 0;
    // What the paths of the rounds told of each (`learn`); where an HE round met a face before it burst (`face`); the
    // last contact of a fragment ray (`secondaryImpact`) and the place the last rays were thrown from (`cone`): a strike
    // is drawn by what came before it in the same instant.
    this.rounds = new Map(); this.faces = new Map(); this.rayContact = null; this.cone = null;
    // Where a part of a construction is shown on this frame, by its name, when whoever draws says so: a spot on a plate goes with it.
    this.pose = null; this.velocity = null; this.fireProfile = null;
    // How long after the last update the events being shown came: what they make waits that much of the next one.
    this.ahead = 0;
    this.origin = { x: 0, y: 0 };
    // On a field with fog, the spans of ground in sight (ground-sight.ts): what is over other ground is not kept.
    this.sight = null;
    // What the screen shows, as its left, right, bottom and top in the world, when whoever draws says so, and how many
    // particles were off it as last counted (`offView`): with the budget full, what is made on the screen takes their place.
    this.view = null; this.offView = 0;
    Object.assign(this, particleLayers(parent, atlas, this.origin)); this.limit = 3000;
    this.glows = new Container(); parent.addChild(this.glows); this.lightSprites = [];
    this.blastWaves = new BlastWaves(atlas, id => this.layersFor(id).glows);
    this.vegetation = new VegetationMotion();
    this.jets = new ThrusterJets(this);
    this.quality = 'high'; this.density = 1; this.time = 0;
  }
  setQuality(quality: string) {
    this.quality = quality === 'balanced' || quality === 'low' ? quality : 'high';
    this.density = { high: 1, balanced: 0.65, low: 0.35 }[this.quality];
    this.limit = { high: 3000, balanced: 1800, low: 800 }[this.quality];
    this.blastWaves.setQuality(this.quality);
    this.vegetation.setQuality(this.quality);
    while (this.particles.length > this.limit) this.retire(this.particles.pop()!);
    this.settle();
  }
  clear() {
    this.blastWaves.clear(); this.jets.clear();
    this.vegetation.clear();
    this.burningSources.clear();
    this.smoke.removeParticles(); this.fire.removeParticles(); this.veil.removeParticles(); this.sparks.removeParticles();
    for (const [id, layers] of this.actorLayers) {
      layers.smoke.removeParticles(); layers.fire.removeParticles(); layers.veil.removeParticles(); layers.sparks.removeParticles(); this.dropLayers(id);
    }
    for (const light of this.lights) this.retireLight(light);
    for (const sprite of this.lightSprites) sprite.destroy(); this.lightSprites.length = 0;
    this.actorLayers.clear(); this.actorRevisions.clear();
    this.fireCount = this.cloudCount = 0; this.evictionCursor = 0; this.offView = 0; this.vacated.clear();
    for (const p of this.particles) { p.sprite.home = null; this.pool.push(p.sprite); }
    this.rounds.clear(); this.faces.clear(); this.rayContact = this.cone = null;
    this.particles = []; this.lights = []; this.scorches = []; this.random = new Random(9247); this.time = 0;
  }
  layersFor(actorId: string | null | undefined): ParticleLayers & { glows: Container } {
    if (!actorId) return this;
    let layers = this.actorLayers.get(actorId);
    if (!layers) {
      const group = new Container(), particles = particleLayers(group, this.atlas, this.origin), glows = new Container();
      group.addChild(glows); (this.actorLayer?.(actorId) || this.parent).addChild(group);
      layers = { group, glows, ...particles }; this.actorLayers.set(actorId, layers);
    }
    return layers;
  }
  // Moves the place the particles are counted from. `sample` lays every one of them out from it again.
  anchor(x: number, y: number) {
    if (this.origin.x === x && this.origin.y === y) return;
    this.origin.x = x; this.origin.y = y;
    anchorParticleLayers(this, x, y);
    for (const layers of this.actorLayers.values()) anchorParticleLayers(layers, x, y);
  }
  particleLayer(kind: ParticleKind, actorId: string | null | undefined, veil = false) {
    const layers = this.layersFor(actorId);
    return veil ? layers.veil : kind === 'smoke' || kind === 'dust' ? layers.smoke : kind === 'fire' ? layers.fire : layers.sparks;
  }
  // A flash is one sprite and the whole point of its event: quality thins the
  // smoke around it, never the flash. Opaque ones lie with the fire; the rest add light.
  flash(options: ParticleOptions) {
    return this.add('flash', { priority: true, spin: 0, ...options });
  }
  dropLayers(id: string) {
    const layers = this.actorLayers.get(id)!;
    for (const sprite of [...layers.glows.children]) this.glows.addChild(sprite);
    layers.group.destroy({ children: true }); this.actorLayers.delete(id);
  }
  setActors(actors: readonly Pick<DrawingActor, 'id' | 'revision'>[] = []) {
    let same = actors.length === this.actorRevisions.size, index = 0;
    if (same) for (const [id, revision] of this.actorRevisions) {
      const actor = actors[index++]!;
      if (actor.id !== id || (actor.revision ?? 0) !== revision) { same = false; break; }
    }
    if (same) return;
    const revisions = new Map(actors.map(actor => [actor.id, actor.revision ?? 0])),
      reset = new Set([...this.actorRevisions].filter(([id, revision]) => revisions.get(id) !== revision).map(([id]) => id));
    this.actorRevisions = revisions;
    if (!reset.size) return;
    for (const [key, source] of this.burningSources) if (reset.has(source.actorId!)) this.burningSources.delete(key);
    let write = 0;
    for (const p of this.particles) {
      if (reset.has(p.effectActorId!)) this.retire(p);
      else this.particles[write++] = p;
    }
    this.particles.length = write;
    this.lights = this.lights.filter(light => {
      if (!reset.has(light.effectActorId!)) return true;
      this.retireLight(light); return false;
    });
    this.blastWaves.resetActors(reset);
    for (const id of reset) if (this.actorLayers.has(id)) this.dropLayers(id);
    this.settle();
  }
  add(kind: ParticleKind, options: ParticleOptions, keepAtDistance = false): EffectParticle | undefined {
    let density = this.density;
    const zoom = this.view?.zoom;
    // Thin only new, secondary particles in the far view. Important flashes and priority effects keep their
    // quality budget; existing smoke finishes normally. The largest rotated quad over its life bounds its size.
    if (kind !== 'flash' && !options.priority && !keepAtDistance && zoom !== undefined && zoom > 0 && zoom < 8) {
      const across = Math.SQRT2 * ((options.size ?? .1) + Math.max(0, options.grow ?? 0) * (options.life ?? 1))
        * Math.max(Math.abs(options.aspectX ?? 1), Math.abs(options.aspectY ?? 1)) * zoom;
      if (across < 1) return;
      density *= clamp(across / 6, .25, 1);
    }
    // Stable flame slots already apply the quality quota. Do not randomly
    // discard their replacement and leave the burning bed empty.
    if (kind !== 'flash' && this.random.next() > density && !options.burnSource) return;
    let slot = -1;
    if (this.particles.length >= this.limit) {
      // What is made on the screen takes the place of anything off it: what goes on out of view never starves
      // what the player looks at. A count that finds none off it any more is put right.
      if (this.offView > 0 && !outside(this.view, options)) {
        slot = this.evict(p => outside(this.view, p));
        this.offView = slot < 0 ? 0 : this.offView - 1;
      }
      if (slot < 0) {
        if (!options.priority) return;
        // Fresh fire replaces smoke in place when the cloud is full. Once fire
        // occupies 35% of the budget, recycle older fire so smoke can outlive the
        // blast. A budget with no smoke in it is not gone through for some.
        const replaceFire = kind === 'fire' && this.fireCount >= Math.ceil(this.limit * .35);
        if (replaceFire || this.cloudCount > 0) slot = this.evict(replaceFire ? p => p.kind === 'fire' : p => p.kind === 'smoke' || p.kind === 'dust');
        if (slot < 0) return;
      }
    }
    const r = this.random, art = options.art && this.atlas[options.art], variants = kind === 'smoke' ?
      textureArray(art) ? art : options.hotSmoke && options.hotSmoke !== POWDER_SMOKE ? this.atlas.denseSmoke || this.atlas.smoke : this.atlas.smoke : kind === 'fire' ?
      options.flame && this.atlas.flame || this.atlas.fire : textureArray(art) ? art : null,
      variant = variants ? Math.floor(r.next() * variants.length) : 0,
      texture = variants ? variants[variant]! : art && !textureArray(art) ? art :
        (kind === 'dust' ? this.atlas.dust : kind === 'flash' ? this.atlas.flash : this.atlas.spark) || this.atlas.spark;
    let sprite = this.pool.pop();
    if (!sprite) sprite = Object.assign(new Particle({ texture }), { home: null, kept: -1, left: -1 });
    sprite.texture = texture;
    sprite.anchorX = options.anchorX ?? .5; sprite.anchorY = options.flame ? FLAME_ROOT : .5;
    // Every particle is a record of the same fields in the same order, whatever its event stated of it: the
    // loop that steps thousands of them on every frame reads one shape of record, not one for each kind of effect.
    const p: EffectParticle = { kind, age: 0, wait: this.ahead, life: 1, x: 0, y: 0, vx: 0, vy: 0, size: 0.1, grow: 0, drag: 1,
      rotation: r.range(0, TAU), spin: r.range(-0.5, 0.5), opacity: 1, tint: 0xffffff, aspectX: 1, aspectY: 1,
      lift: undefined, fade: undefined, fadeIn: undefined, hotSmoke: undefined, smokeTint: 0, flame: undefined, ember: undefined,
      burnSource: undefined, burnSlot: 0, burnSize: 0, burnTurn: 0, burnProfile: undefined,
      priority: undefined, additive: undefined, external: undefined,
      actorId: undefined, art: undefined, anchorX: undefined, groundDust: undefined, dustDelay: undefined,
      dustLift: 0, dustSurface: undefined, sprite, phase: 0, textureVariant: variant, effectActorId: null, layer: null,
      previousX: 0, previousY: 0, floorTerrain: undefined, floorX: 0, floorHeight: NaN, carrier: undefined, carryX: 0, carryY: 0 };
    assignParticleOptions(p, options);
    p.previousX = p.x; p.previousY = p.y;
    // A particle made on a part (`carrier`) keeps its place on it, counted in the part's own frame (`carry`).
    if (p.carrier !== undefined) {
      const pose = this.pose?.(p.carrier);
      if (pose) {
        const c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0), dx = p.x - pose.x, dy = p.y - pose.y;
        p.carryX = c * dx + s * dy; p.carryY = c * dy - s * dx;
      } else p.carrier = undefined;
    }
    p.phase = kind === 'fire' ? r.range(0, TAU) : p.rotation * 3 + p.x * 1.7;
    p.effectActorId = p.actorId || this.emitterActorId || null;
    // Some existing continuous-fire smoke crosses the flames. Short blast and
    // powder clouds retain their order; all layers use the same atlas source.
    const layer = this.particleLayer(kind === 'flash' && !p.additive ? 'fire' : kind, p.effectActorId,
      kind === 'smoke' && p.hotSmoke === 5 && variant % 3 === 0); p.layer = layer;
    sprite.x = p.x - this.origin.x; sprite.y = p.y - this.origin.y; sprite.scaleX = p.size * p.aspectX / 128; sprite.scaleY = p.size * p.aspectY / 128;
    sprite.rotation = p.rotation; sprite.alpha = kind === 'smoke' || p.burnSource ? 0 : p.flame ? p.opacity * .25 : p.opacity; sprite.tint = p.tint;
    // A sprite that left a layer since the layers were last settled may still be in this one: settling keeps it once.
    if (sprite.left === this.settled) this.vacated.add(layer);
    sprite.home = layer; layer.addParticle(sprite);
    if (slot < 0) this.particles.push(p); else this.particles[slot] = p;
    if (kind === 'fire') this.fireCount++; else if (kind === 'smoke' || kind === 'dust') this.cloudCount++;
    if (outside(this.view, p)) this.offView++; return p;
  }
  // Retires the first particle from the rotating cursor on that `test` takes, and returns its slot, or -1 for none:
  // the cursor keeps the particle array from being shifted or grown.
  evict(test: (p: EffectParticle) => boolean) {
    const count = this.particles.length;
    for (let offset = 0; offset < count; offset++) {
      const index = (this.evictionCursor + offset) % count, candidate = this.particles[index]!;
      if (!test(candidate)) continue;
      this.retire(candidate); this.evictionCursor = (index + 1) % count; return index;
    }
    return -1;
  }
  // A retired particle's sprite is back in the pool at once, for what is made next; the layers it left are rid of it
  // all at once (`settle`, before anything is drawn): a layer of thousands is gone through once a step, not once for
  // every particle that leaves it. Until then it stays there undrawn, or drawn as what it was made into, where that is.
  retire(p: EffectParticle) {
    if (p.burnSource?.flames[p.burnSlot] === p) p.burnSource.flames[p.burnSlot] = null;
    const sprite = p.sprite; sprite.alpha = 0; sprite.home = null; sprite.left = this.settled; this.pool.push(sprite); this.vacated.add(p.layer!);
    if (p.kind === 'fire') this.fireCount--; else if (p.kind === 'smoke' || p.kind === 'dust') this.cloudCount--;
  }
  settle() {
    if (!this.vacated.size) return;
    const stamp = ++this.settled;
    for (const layer of this.vacated) {
      if (layer.destroyed) continue;
      const list = layer.particleChildren; let write = 0;
      for (let i = 0; i < list.length; i++) {
        const sprite = list[i]!;
        if (sprite.home === layer && sprite.kept !== stamp) { sprite.kept = stamp; list[write++] = sprite; }
      }
      list.length = write; layer['onViewUpdate']();
    }
    this.vacated.clear();
  }
  retireLight(light: EffectLight) { if (light.sprite) { light.sprite.visible = false; light.sprite = null; } }
  light(options: EffectLight) {
    // A burning module refreshes one small glow instead of stacking a flash
    // for every burn event. It stops naturally when native burn events stop.
    options.wait = this.ahead;
    // Preserve the actual emitting point, including a roof root away from the
    // carrier's centre, while its interpolated pose moves and turns.
    const anchor = (spot: LightSite) => { if (spot.carrier !== undefined) {
      const pose = this.pose?.(spot.carrier);
      if (pose) {
        const c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0), dx = spot.x-pose.x, dy = spot.y-pose.y;
        spot.carryX = c*dx+s*dy; spot.carryY = c*dy-s*dx;
      } else spot.carrier = undefined;
    } };
    anchor(options); for (const spot of options.sites || []) anchor(spot);
    if (options.key) {
      const existing = this.lights.find(light => light.key === options.key);
      if (existing) { Object.assign(existing, options); return; }
    }
    // Simultaneous flashes remain bounded independently of the smoke budget.
    if (this.lights.length >= 64) this.retireLight(this.lights.shift()!);
    this.lights.push(options);
  }
  // `ahead` is how long after the last update the events came. The update that follows covers that time too,
  // and what they make is not aged by it.
  consume(events: readonly SceneEventBase[], ahead = 0) {
    this.ahead = ahead;
    for (const e of events) {
      if (!isPositioned(e)) continue;
      // What happens on a construction is drawn with it, among the constructions as they stand. A burst and a round
      // into the ground are drawn over the field, or with the construction a round burst on: not with the gun that
      // sent them, which may be far away and out of view, and its layers hidden with it.
      this.emitterActorId = e.type === 'explosion' ? e.targetActorId || null : e.type === 'ground' || e.ground ? null : e.actorId || null;
      switch (e.type) {
        case 'muzzle': this.muzzle(e); break;
        case 'blocked': case 'penetration': case 'module': case 'ricochet': {
          if (e.ground) { if (e.type === 'ricochet') this.ground(e); break; }
          // The calibre a round shows at a face is kept with it, for the burst of its shaped charge (`shapedBurst`).
          const round = e.projectileId != null ? this.rounds.get(e.projectileId) : undefined;
          if (round && (e.caliberMm ?? 0) > 0) round.calibre = e.caliberMm;
          if (round?.ammo === 'heat') this.jet(e, round); else this.strike(e, round);
          break;
        }
        case 'spall': if (!e.ground) this.scab(e); break;
        case 'primary-contact': this.face(e); break;
        case 'explosion': if (e.shaped) this.shapedBurst(e); else this.explosion(e); break;
        case 'burn': this.burn(e); break;
        case 'ground': this.ground(e); break;
        case 'debris': this.debris(e); break;
        case 'secondary-impact': this.secondaryImpact(e); break;
        case 'secondary-ray': this.secondaryRay(e); break;
      }
    }
    this.emitterActorId = null; this.ahead = 0;
  }
  // What the paths of the rounds (flight events) last told of each, by its name: its ammunition, where its path ends
  // and which way it was going there. They come before what the round met is shown, and a strike is drawn by the
  // round that made it: the jet of a shaped charge goes on from where it burst to where its path ends.
  learn(events: readonly SceneEventBase[]) {
    for (const e of events) {
      if (e.type !== 'flight' || e.fragment || e.id == null || !e.points?.length) continue;
      const points = e.points, last = points.at(-1)!, kept = this.rounds.get(e.id);
      let vx = 0, vy = 0;
      for (let i = points.length - 1; i >= 0; i--) if (Math.hypot(points[i]!.vx!, points[i]!.vy!) > 1) { vx = points[i]!.vx!; vy = points[i]!.vy!; break; }
      if (kept) this.rounds.delete(e.id);
      this.rounds.set(e.id, { ammo: e.ammo ?? kept?.ammo, calibre: kept?.calibre, x: last.x, y: last.y, vx, vy });
      if (this.rounds.size > ROUNDS_KEPT) this.rounds.delete(this.rounds.keys().next().value!);
    }
  }
  // `metres` as the screen draws them, held between `least` and `most` of its pixels; and `count` pixels, in metres.
  drawn(metres: number, least: number, most: number) { const zoom = this.view && this.view.zoom > 0 ? this.view.zoom : RESTING_ZOOM; return clamp(metres * zoom, least, most) / zoom; }
  pixels(count: number) { return count / (this.view && this.view.zoom > 0 ? this.view.zoom : RESTING_ZOOM); }
  muzzle(e: EffectEvent) {
    this.vegetation.emit(e,this.ahead);
    // The bore sets the size of everything; a 120 mm gun is the unit.
    const angle = Number(e.angle), r = this.random, profile = MUZZLES[e.weapon ?? ''] || MUZZLES.autocannon!,
      bore = clamp(Math.sqrt((e.caliberMm || 30) / 120), .2, 1.2), reach = bore ** 1.3 * profile.reach,
      cos = Math.cos(angle), sin = Math.sin(angle), life = .05 + .05 * bore,
      // One tongue of flame along `angle`, born at the muzzle and still lengthening as it dims.
      jet = (angle: number, length: number, width = 1) => this.flash({ art: 'jet', anchorX: MUZZLE_JET_ROOT, x: e.x, y: e.y, rotation: angle,
        size: length, grow: length * 3, aspectY: (r.next() < .5 ? -1 : 1) * width * r.range(.85, 1.1), life, fade: 1.3 }),
      // Propellant smoke thrown along `angle`: fast out of the bore, stopped by the air within
      // `travel`. Most of it stays as one cloud before the muzzle; the rest runs ahead.
      smoke = (count: number, angle: number, travel: number, cone = .28) => {
        const c = Math.cos(angle), s = Math.sin(angle);
        let kept = false;
        for (let i = 0; i < count; i++) {
          const a = angle + r.range(-cone, cone), speed = r.range(.1, i % 3 ? .65 : 1.3) * travel * 4.5, start = r.range(0, .18) * travel;
          const puff = { x: e.x + c * start, y: e.y + s * start,
            vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, drag: 4.5, lift: .3,
            size: r.range(.18, .36) * travel, grow: r.range(.10, .22) * travel, life: r.range(.9, 2.2) * (.55 + bore * .9),
            spin: r.range(-.4, .4), opacity: r.range(.36, .6) * (.8 + bore * .35), hotSmoke: POWDER_SMOKE, tint: HOT_SMOKE_TINTS[POWDER_SMOKE - 1]![0]!, fadeIn: .04 };
          // Skip only puffs whose rotated quad stays below one CSS pixel for their whole life.
          // Existing smoke finishes normally when the camera moves; no per-gun LOD state is kept.
          if (this.view && this.view.zoom > 0 && Math.SQRT2 * (puff.size + puff.grow * puff.life) * this.view.zoom < 1) continue;
          // Keep the first readable puff of a burst; distance thins only its secondary cloud.
          if (this.add('smoke', puff, !kept)) kept = true;
        }
      };
    jet(angle, reach);
    if (profile.brake) for (const side of [-1, 1]) jet(angle + side * 1.75, reach * profile.brake * .45);
    if (profile.back) jet(angle + Math.PI, reach * profile.back, .8);
    this.flash({ additive: true, art: 'flash', x: e.x + cos * reach * .06, y: e.y + sin * reach * .06, rotation: r.range(0, TAU),
      size: reach * (.55 + .5 / profile.reach), grow: reach * 3, life: life * .6, tint: 0xffe6b0, opacity: .9, fade: 1.2 });
    this.light({ x: e.x + cos * reach * .25, y: e.y + sin * reach * .25, age: 0, life: .07 + .07 * bore, size: reach * 2.6,
      strength: .5, effectActorId: this.emitterActorId });
    // A large charge rolls out of the bore as a short-lived ball of fire.
    for (let i = 0; i < (profile.fire || 0); i++) {
      const a = angle + r.range(-.35, .35), speed = r.range(2, 9) * bore;
      this.add('fire', { priority: true, x: e.x + cos * r.range(.05, .3) * reach, y: e.y + sin * r.range(.05, .3) * reach,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: r.range(.12, .26), size: r.range(.32, .55) * reach * .5,
        grow: r.range(.8, 1.6) * bore, drag: 4.5, rotation: a, spin: r.range(-.35, .35), opacity: .8 });
    }
    const puffs = Math.round(profile.smoke * (3 + 12 * bore));
    smoke(puffs, angle, reach);
    if (profile.brake) for (const side of [-1, 1]) smoke(Math.ceil(puffs * profile.brake * .4), angle + side * 1.75, reach * profile.brake * .7, .4);
    if (profile.back) smoke(puffs * 2, angle + Math.PI, reach * profile.back * 1.3, .22);
    for (let i = 0, count = Math.round((profile.sparks || 0) * 11 * bore); i < count; i++) {
      const a = angle + (profile.back && i % 2 ? Math.PI : 0) + r.range(-.32, .32), speed = r.range(8, 34) * bore;
      this.add('spark', { ember: true, x: e.x, y: e.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: r.range(.12, .5), size: r.range(.04, .12), drag: 1.6, tint: 0xffdd9d });
    }
    if (profile.wave) this.blastWaves.emit({ actorId: this.emitterActorId ?? null, x: e.x + cos * reach * .15, y: e.y + sin * reach * .15 },
      { quality: this.quality, ahead: this.ahead, front: muzzleFront(bore, reach) });
    // The blast of a big gun sweeps the ground beneath its muzzle.
    if (profile.dust && this.terrain) {
      const x = e.x + cos * reach * .4, clearance = e.y + sin * reach * .4 - this.terrain.height(x), near = 1 - clearance / (1 + 2.4 * bore);
      if (near > 0) this.skirt(x, { count: Math.round(10 * profile.dust * near), speed: .7 * bore, reach: reach * 2, opacity: .7 + near * .5 });
    }
  }
  // Dust that a pressure front drives along the ground, to both sides of `x`.
  skirt(x: number, { count, speed, reach, opacity = 1 }: DustSkirt) {
    const r = this.random, ground = this.terrain?.height(x) || 0,
      material = groundLooks[this.terrain?.groundAt?.(x) || 'soil'] || GROUND_SURFACES.soil;
    for (let i = 0; i < count; i++) {
      const delay = r.range(.08, .13), p = this.add('smoke', { groundDust: true,
        x: x + r.range(-.15, .15) * reach, y: ground + .04,
        vx: (i % 2 ? 1 : -1) * r.range(4, 8) * speed, vy: 0,
        size: r.range(.25, .42), grow: r.range(.25, .40), aspectX: r.range(2.2, 3.2), aspectY: r.range(.25, .38),
        dustDelay: delay, life: delay + r.range(1.05, 1.75), drag: 1.65,
        rotation: 0, spin: 0, fade: .9, tint: material.dust, opacity: r.range(.18, .27) * opacity });
      if (p) { p.dustLift = .04; p.y = groundDustHeight(p, this.terrain) + p.dustLift; p.sprite.y = p.y - this.origin.y; }
    }
  }
  debris(e: EffectEvent) {
    const r = this.random, brittle = brittleMaterial(e.material);
    for (let i = 0; i < Number(e.count); i++) this.add('dust', { x: e.x, y: e.y,
      vx: (e.vx || 0) + r.range(-.7, .7), vy: (e.vy || 0) + r.range(0, .8),
      life: r.range(.35, 1), size: r.range(.01, .035), drag: .2,
      tint: brittle ? 0xaaa28b : 0x5d685c, opacity: .8, external: true });
  }
  // A round at a face (`blocked`, `penetration`, `ricochet`), or at a piece within (`module`). What shows outside is the
  // splash it throws back out of the face (STRIKE), sized by its bore and flattened along the normal as obliquely as it
  // struck, and its sparks fanned back about the normal, wider on an oblique face. A round stopped there leaves the plate
  // glowing where it struck; one that goes through throws back less, its energy being spent behind the plate, where its
  // fragments show (`secondaryRay`). A brittle face throws chips and dust and no light; a piece within, no splash, and
  // whether the round went on through it the core says (`penetrated`). How squarely it struck is the way the path of its
  // round went; a round whose path the page was not told struck square.
  strike(e: EffectEvent, round: LearnedRound | undefined) {
    const r = this.random, bore = boreOf(e), heavy = clamp((bore - .3) / .7, 0, 1), brittle = brittleMaterial(e.material),
      inside = e.type === 'module', through = e.type === 'penetration' || inside && e.penetrated === true, share = through ? STRIKE.through : 1,
      [nx, ny] = faceNormal(e), normal = Math.atan2(ny, nx), speed = round ? Math.hypot(round.vx, round.vy) : 0,
      square = clamp(speed > 1 ? Math.abs(round!.vx * nx + round!.vy * ny) / speed : 1, .15, 1),
      fan = 1.05 + .45 * (1 - square);
    if (!inside && !brittle) {
      const across = this.drawn(STRIKE.splash * bore * share, STRIKE.pixels[0]! * bore * share, STRIKE.pixels[1]! * bore * share);
      this.flash({ additive: true, art: 'flash', x: e.x + nx * across * .2, y: e.y + ny * across * .2, rotation: normal + r.range(-.15, .15),
        size: across, grow: across * 2, aspectX: .35 + .65 * square, aspectY: r.next() < .5 ? -1 : 1, life: through ? .05 : .065,
        fade: 1.5, tint: 0xffdcaa, opacity: .85 });
    }
    // The spot is on the part it struck, and goes with it.
    if (!through && !brittle && e.type !== 'ricochet') {
      const spot = this.drawn(STRIKE.spot * bore, STRIKE.spotPixels[0]! * bore, STRIKE.spotPixels[1]! * bore), carrier = e.id ?? undefined;
      this.flash({ additive: true, art: 'glow', x: e.x, y: e.y, size: spot, life: STRIKE.glow, fade: 1.1, tint: 0xff7f36, opacity: .9, carrier });
      this.flash({ additive: true, art: 'glow', x: e.x, y: e.y, size: spot * .5, life: STRIKE.glow * .4, fade: 1.4, tint: 0xffe2a4, carrier });
    }
    const count = brittle ? Math.round(3 + 5 * heavy) : Math.round(through ? 3 + 3 * heavy : 4 + 10 * heavy);
    for (let i = 0; i < count; i++) {
      const a = normal + r.range(-fan, fan), speed = r.range(3, 15) * (.55 + .45 * bore);
      this.add(brittle ? 'dust' : 'spark', { x: e.x, y: e.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed + 1.2, life: r.range(.1, .45),
        size: brittle ? r.range(.02, .06) : r.range(.04, .14) * (.6 + .4 * bore), drag: .65, ember: !brittle && heavy > .5,
        tint: brittle ? 0xc5b9a0 : 0xffd18c, opacity: .9 });
    }
    const puffs = brittle ? Math.round(3 + 7 * heavy * share) : Math.round(1 + (through ? 1 : 3) * heavy);
    for (let i = 0; i < puffs; i++) this.add('smoke', { x: e.x + nx * r.range(0, .04), y: e.y + ny * r.range(0, .04),
      vx: nx * r.range(.3, 1.3), vy: ny * r.range(.3, 1.3) + r.range(.1, .5), life: r.range(.8, 2.4), size: r.range(.08, .19) * (.5 + .5 * bore),
      grow: brittle ? .31 : .14, opacity: brittle ? .42 : .25, tint: brittle ? 0xb3a999 : 0x7f8274 });
  }
  // The jet of a shaped charge at a face on its way (`shapedBurst` drew where it was formed): where it gets through, a
  // short spray of the liner's metal, incandescent, out of the back of the plate along the jet; where it stops, a white
  // point where it spent itself, on the part it stopped in. A larger charge sprays more.
  jet(e: EffectEvent, round: LearnedRound) {
    const r = this.random, charge = clamp(((e.caliberMm ?? 0) > 0 ? e.caliberMm! : round.calibre ?? 100) / 120, .4, 1.3),
      speed = Math.hypot(round!.vx, round!.vy), [nx, ny] = faceNormal(e),
      dx = speed > 1 ? round!.vx / speed : -nx, dy = speed > 1 ? round!.vy / speed : -ny, angle = Math.atan2(dy, dx);
    if (e.type === 'penetration' || e.type === 'module' && e.penetrated === true) {
      for (let i = 0, count = Math.round(3 + 5 * charge * clamp(Number(e.power) / 450, .3, 1)); i < count; i++) {
        const a = angle + r.range(-.3, .3), v = r.range(12, 45);
        this.add('spark', { ember: true, x: e.x + dx * .04, y: e.y + dy * .04, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          life: r.range(.06, .22), size: r.range(.03, .08), drag: 2.4, tint: 0xfff2d0, opacity: 1 });
      }
    } else this.flash({ additive: true, art: 'glow', x: e.x, y: e.y, size: this.drawn(.1 * charge, 6, 24), life: .15, fade: 1.3,
      tint: 0xfff0d0, opacity: .9, carrier: e.id ?? undefined });
  }
  // Where an HE round met a face, just before it burst there: the burst is drawn outside that face (`explosion`).
  face(e: EffectEvent) {
    const nx = Number(e.nx), ny = Number(e.ny);
    if (e.projectileId == null || !Number.isFinite(e.x + e.y + nx + ny)) return;
    this.faces.delete(e.projectileId); this.faces.set(e.projectileId, { x: e.x, y: e.y, nx, ny });
    if (this.faces.size > 32) this.faces.delete(this.faces.keys().next().value!);
  }
  // The back of a face a blast broke without going through it (`spall`): chips of the plate and their dust, thrown
  // inward, cold, with no fire.
  scab(e: EffectEvent) {
    const r = this.random, told = Math.hypot(e.nx || 0, e.ny || 0) > 1e-9, angle = told ? Math.atan2(Number(e.ny), Number(e.nx)) : Math.PI / 2,
      count = clamp(Math.round(3 + Math.sqrt(Math.max(0, e.power || 0))), 3, 8);
    for (let i = 0; i < count; i++) {
      const a = angle + r.range(-.7, .7) * (told ? 1 : 4), speed = r.range(2, 8);
      this.add('dust', { x: e.x, y: e.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, drag: .6, life: r.range(.3, .8),
        size: r.range(.012, .035), spin: r.range(-6, 6), tint: i % 2 ? 0x8f948a : 0x6d726b, opacity: .9 });
    }
    for (let i = 0; i < 2; i++) this.add('smoke', { x: e.x, y: e.y, vx: Math.cos(angle) * r.range(.3, 1), vy: Math.sin(angle) * r.range(.3, 1),
      life: r.range(1, 2.2), size: r.range(.1, .2), grow: .3, opacity: .3, tint: 0xa49d8e });
  }
  // What a fragment ray (`secondary-ray`, as the core traced it) shows: a hot streak from where it starts to where it
  // stopped, for an instant, and sparks that run along it and die at its end. Where it got out of what it went through
  // and flew on, the streak ends there and a plume comes out of the back. The rays thrown from one place at once (a
  // round out of the back of a plate) light that exit and raise a little dust there, once. How much each shows goes with
  // what it was given.
  secondaryRay(e: EffectEvent) {
    const endX = Number(e.endX), endY = Number(e.endY);
    if (!Number.isFinite(e.x + e.y + endX + endY)) return;
    const length = Math.hypot(endX - e.x, endY - e.y);
    if (!(length > .01)) return;
    const r = this.random, dx = (endX - e.x) / length, dy = (endY - e.y) / length, angle = Math.atan2(dy, dx),
      strength = clamp(Math.sqrt((e.powerBudget ?? 4) / 4), .35, 1.4),
      contact = e.projectileId != null && this.rayContact?.id === e.projectileId ? this.rayContact : null,
      reached = contact ? clamp((contact.x - e.x) * dx + (contact.y - e.y) * dy, 0, length) : 0,
      out = contact ? length - reached > RAY_FLEW_ON : length > FREE_FLIGHT, span = out ? reached : length,
      first = !(this.cone && this.cone.time === e.time && Math.abs(this.cone.x - e.x) + Math.abs(this.cone.y - e.y) < .02);
    if (first) this.cone = { x: e.x, y: e.y, time: e.time };
    if (span > .01) {
      const width = Math.max(.006, this.pixels(1.2 + .6 * strength));
      this.add('flash', { additive: true, art: 'spark', x: e.x + dx * span / 2, y: e.y + dy * span / 2, rotation: angle, spin: 0,
        size: span, aspectY: 8 * width / span, life: r.range(.06, .12), fade: 1.2, tint: 0xffd38a, opacity: .95 * Math.min(1, strength) });
    }
    const run = out ? Math.min(length, span + 1.2) : span;
    for (let i = 0, count = Math.round(clamp(2 * strength, 1, 3)); i < count; i++) {
      const a = angle + r.range(-.1, .1), speed = r.range(25, 60);
      this.add('spark', { ember: true, x: e.x, y: e.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, drag: .3,
        life: clamp(run / speed * r.range(.7, 1), .02, .3), size: r.range(.04, .1), tint: 0xffdd9d, opacity: .9 });
    }
    if (first && e.internal === true) {
      this.flash({ additive: true, art: 'glow', x: e.x, y: e.y, size: this.drawn(.14 * strength, 8, 28), life: .12, fade: 1.4, tint: 0xffb060, opacity: .8 });
      for (let i = 0; i < (strength < .6 ? 1 : 2); i++) this.add('smoke', { x: e.x, y: e.y, vx: dx * r.range(.3, .9), vy: dy * r.range(.3, .9),
        life: r.range(.9, 1.8), size: r.range(.1, .2), grow: .25, opacity: .28, tint: 0x8d8c80 });
    }
    if (out) {
      const x = e.x + dx * span, y = e.y + dy * span;
      this.flash({ additive: true, art: 'glow', x, y, size: this.drawn(.12 * strength, 6, 22), life: .08, fade: 1.4, tint: 0xffc070, opacity: .7 });
      for (let i = 0; i < 2; i++) this.add('smoke', { x, y, vx: dx * r.range(2, 6) * strength, vy: dy * r.range(2, 6) * strength, drag: 2.2,
        life: r.range(1, 2), size: r.range(.12, .24), grow: .45, opacity: .34, tint: 0x6f716a });
    }
  }
  // A shaped charge bursts small where it strikes: little of its explosive goes into the blast, the rest into the jet
  // of its liner, which goes on through what it struck as a thin white line to where it stopped (where the path of its
  // round ends, `learn`). A larger charge bursts larger: a 120 mm round's more than the 84 mm of a launcher.
  shapedBurst(e: EffectEvent) {
    const r = this.random, round = e.projectileId != null ? this.rounds.get(e.projectileId) : null,
      charge = clamp((round?.calibre ?? 100) / 120, .4, 1.3), reach = round ? Math.hypot(round!.x - e.x, round!.y - e.y) : 0,
      speed = round ? Math.hypot(round!.vx, round!.vy) : 0,
      dx = reach > .01 ? (round!.x - e.x) / reach : speed > 1 ? round!.vx / speed : 1, dy = reach > .01 ? (round!.y - e.y) / reach : speed > 1 ? round!.vy / speed : 0,
      back = Math.atan2(-dy, -dx), across = this.drawn(.6 * charge, 16 * charge, 70 * charge);
    this.light({ x: e.x, y: e.y, age: 0, life: .1, size: this.drawn(1.6 * charge, 0, 320), strength: .7, effectActorId: this.emitterActorId });
    this.scorch(e);
    this.flash({ additive: true, art: 'flash', x: e.x - dx * across * .2, y: e.y - dy * across * .2, rotation: r.range(0, TAU),
      size: across, grow: across * 2, life: .06, tint: 0xfff2d6, opacity: .9, fade: 1.5 });
    this.flash({ additive: true, art: 'glow', x: e.x - dx * across * .15, y: e.y - dy * across * .15, size: across * 1.4, grow: across,
      life: .22, tint: 0xff9a4a, opacity: .35, fade: 1.3 });
    if (reach > .01) {
      const line = (pixels: number, tint: number, opacity: number, life: number) => this.add('flash', { additive: true, art: 'spark', x: (e.x + round!.x) / 2, y: (e.y + round!.y) / 2,
        rotation: Math.atan2(dy, dx), spin: 0, size: reach, aspectY: 8 * Math.max(.004 * charge, this.pixels(pixels)) / reach, life, fade: 1.2, tint, opacity });
      line(1.8, 0xffffff, 1, .09); line(5, 0xffd7a0, .35, .12);
    }
    for (let i = 0, count = Math.round(6 + 4 * charge); i < count; i++) {
      const a = back + r.range(-1.2, 1.2), v = r.range(4, 16) * charge;
      this.add('spark', { ember: true, x: e.x, y: e.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 1, life: r.range(.12, .4),
        size: r.range(.04, .12), drag: .9, tint: 0xffdd9d });
    }
    for (let i = 0, count = Math.round(2 + 2 * charge); i < count; i++) {
      const a = back + r.range(-.8, .8), v = r.range(.4, 1.6) * charge;
      this.add('smoke', { x: e.x - dx * .05, y: e.y - dy * .05, vx: Math.cos(a) * v, vy: Math.sin(a) * v + .3, life: r.range(1.4, 2.8),
        size: r.range(.18, .32) * charge, grow: .3, drag: 1.4, opacity: .42, hotSmoke: 1, tint: HOT_SMOKE_TINTS[0]![31]!, fadeIn: .06 });
    }
  }
  secondaryImpact(e: EffectEvent) {
    // The last contact of a ray, for the ray itself, which comes after it (`secondaryRay`).
    if (e.projectileId != null) this.rayContact = { id: e.projectileId, x: e.x, y: e.y };
    const power = Number(e.power), r = this.random, brittle = brittleMaterial(e.material),
      scale = clamp(Math.sqrt(Math.max(0, power)) / 8, .15, .65),
      angle = Math.atan2(e.ny || 0, e.nx || -1),
      count = power < .5 ? 1 : power < 8 ? 2 : 3;
    for (let i = 0; i < count; i++) {
      const a = angle + r.range(-1.1, 1.1), speed = r.range(1, 5) * scale;
      this.add(brittle ? 'dust' : 'spark', { x: e.x, y: e.y,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: r.range(.07, .18),
        size: r.range(.016, .035) * (.6 + scale), drag: .8, opacity: .8,
        tint: brittle ? 0xb7aa8b : 0xd9c396 });
    }
  }
  // The mark a burst near the ground burns into it: what stays of the burst once its fire and smoke are gone, and
  // made of a burst wherever it was, on the screen or far from it. The last forty are kept.
  scorch(e: SceneEventBase) {
    if (!isPositioned(e)) return;
    const radius = blastRadius(e), height = e.y - (this.terrain?.height(e.x) || 0);
    if (height < 2) this.scorches.push({ x: e.x, width: clamp(radius * .62, .35, 3.6) * (1 - Math.max(0, height) / 4),
      depth: clamp(radius * .028, .05, .14), strength: .5 - Math.max(0, height) * .1, seed: e.x * 7.3 });
    if (this.scorches.length > 40) this.scorches.shift();
  }
  // A burst. Against a face (an HE round bursting where it met armour, `face`), a half dome on the outer side of that
  // face: what it throws goes out within a quarter turn either side of the normal, from a fireball off the face, and the
  // whole dome is drawn DOME_PIXELS across at most (`fit`), so that neither the inside the face keeps nor a close view
  // is lost in its fire. Rounds that go off through the blow-out panels of their compartment (`vented`) burst so out of
  // its roof, the way its panels give.
  explosion(e: EffectEvent) {
    this.vegetation.emit(e,this.ahead);
    const contact = e.projectileId != null ? this.faces.get(e.projectileId) : null;
    if (contact) this.faces.delete(e.projectileId!);
    const face = e.vented ? faceNormal(e) : contact && Math.abs(contact.x - e.x) + Math.abs(contact.y - e.y) < .05 ? faceNormal(contact) : null;
    // `ball` is the fireball's radius; `dig` is how deeply the burst reaches into the ground; (`bx`, `by`) is where it
    // throws from: the burst, or off the face it burst on.
    const r = this.random, scale = blastScale(e), radius = blastRadius(e), ground = this.terrain?.height(e.x) || 0, height = e.y - ground,
      whole = clamp(radius * .34, .3, 2.2), fit = face ? this.drawn(whole * 2, 0, DOME_PIXELS) / (whole * 2) : 1, ball = whole * fit,
      dig = clamp(1 - height / (radius * .5), 0, 1), [nx, ny] = face || [0, 0],
      bx = e.x + nx * ball * .7, by = e.y + ny * ball * .7, centre = Math.max(ground + .05, by), share = face ? .7 : 1,
      turn = Math.atan2(ny, nx) - Math.PI / 2,
      // Which way the `i`th of `count` goes: round the whole turn, or across the half of it that faces out.
      around = (i: number, count: number, jitter: number) => face ? turn + clamp((i + .5) / count * Math.PI + r.range(-jitter, jitter) * .5, 0, Math.PI) : i / count * TAU + r.range(-jitter, jitter);
    this.light({ x: bx, y: by, age: 0, life: .18, size: radius * 2.5 * fit, strength: 1,
      blast: true, effectActorId: this.emitterActorId });
    // Only a burst of some kilograms of explosive throws a front the eye can catch (`burstFront`).
    this.blastWaves.emit({ ...e, actorId: this.emitterActorId ?? null }, { ground: this.terrain?.surface?.(e.x) || ground, quality: this.quality, ahead: this.ahead });
    this.scorch(e);
    // The instant of detonation: a short burst of light, a white-hot core over
    // the fire, and a warm glow that outlasts both on the smoke. The burst stays
    // within the fireball: spikes that reach out past it, each burst turned its
    // own way, read as lightning when bursts follow one another.
    this.flash({ additive: true, art: 'flash', x: bx, y: centre, rotation: r.range(0, TAU), size: ball * 2.2, grow: ball * 3,
      life: .065, tint: 0xfff0cb, opacity: .70, fade: 1.5 });
    this.flash({ art: 'glow', x: bx, y: centre, size: ball * 2.4, grow: ball * 6, life: .1, tint: 0xfff6d8, opacity: .95, fade: 1 });
    this.flash({ additive: true, art: 'glow', x: bx, y: centre + ball * .3, size: ball * 4.5, grow: ball, life: .55,
      tint: 0xff8f3d, opacity: .32, fade: 1.3 });
    // Fewer overlapping hot puffs and embers leave room for the cloud. Its
    // denser middle fades within a shorter lifetime, limiting sustained blasts.
    const fireCount = Math.round(20 * scale * share), smokeCount = Math.round(18 * scale * share);
    for (let i = 0; i < fireCount; i++) {
      const core = i < 5, angle = around(i, fireCount, .24), speed = r.range(core ? .5 : .9, core ? 1.7 : 4.6) * scale * fit,
        offset = r.range(0, radius * (core ? .025 : .075)) * fit, c = Math.cos(angle), s = Math.sin(angle),
        size = core ? clamp(radius * .72, .45, 3.1) * r.range(.80, 1.05) : r.range(.36, .70) * scale + radius * .075;
      this.add('fire', { priority: true, x: bx + c * offset, y: Math.max(ground + .02, by + s * offset),
        vx: c * speed, vy: s * speed + .8, life: r.range(core ? .11 : .18, core ? .22 : .38),
        size: face ? Math.min(size * fit, ball * (core ? 1.5 : 1.1)) : size,
        grow: r.range(.30, .68) * scale * fit, drag: core ? 5.5 : 3.9, rotation: angle, spin: r.range(-.35, .35), opacity: core ? .94 : .70 });
    }
    for (let i = 0; i < smokeCount; i++) {
      const angle = around(i, smokeCount, .24), speed = r.range(.45, 2.5) * scale * fit,
        offset = r.range(0, radius * .065) * fit, shade = i % 5 === 0 ? 0 : i % 2 === 0 ? 1 : 2, c = Math.cos(angle), s = Math.sin(angle);
      this.add('smoke', { x: bx + c * offset, y: Math.max(ground + .06, by + s * offset),
        vx: c * speed, vy: s * speed + .9, life: r.range(2.8, 4.8),
        size: (r.range(.55, .85) * scale + radius * .05) * fit, grow: r.range(.18, .28), drag: 1.3, lift: .65,
        aspectX: r.range(.95, 1.25), aspectY: r.range(.8, 1.15), spin: r.range(-.12, .12),
        hotSmoke: shade + 1, tint: HOT_SMOKE_TINTS[shade]![31]!, opacity: r.range(.78, .94), fadeIn: .12, fade: .25 });
    }
    // The hot gas keeps rising after the fire is spent: fire that climbs out of
    // the ball, then dark smoke that follows it up as a column; off a face, away from it.
    for (let i = 0; i < Math.round(3 * scale * share); i++) this.add('fire', { priority: true,
      x: bx + r.range(-.3, .3) * ball, y: centre + r.range(0, .3) * ball, vx: (face ? nx * r.range(0, .8) : r.range(-.8, .8)) * scale * fit, vy: r.range(1.6, 3.6) * scale * fit,
      life: r.range(.42, .66), size: r.range(.55, .95) * ball, grow: r.range(.5, 1) * scale * fit, drag: 3, rotation: r.range(0, TAU),
      spin: r.range(-.35, .35), opacity: .78 });
    for (let i = 0; i < Math.round(5 * scale * share); i++) this.add('smoke', {
      x: bx + r.range(-.3, .3) * ball, y: Math.max(ground + .06, by + r.range(0, radius * .065) * fit),
      vx: (face ? nx * r.range(0, .6) : r.range(-.6, .6)) * scale * fit, vy: r.range(2.2, 5.2) * scale * fit, life: r.range(3.2, 5.2),
      size: (r.range(.55, .9) * scale + radius * .06) * fit, grow: r.range(.22, .32), drag: 1.5, lift: 1.25,
      aspectX: r.range(.95, 1.2), aspectY: r.range(.85, 1.15), spin: r.range(-.15, .15),
      hotSmoke: 2, tint: HOT_SMOKE_TINTS[1]![31]!, opacity: r.range(.82, .97), fadeIn: .22, fade: .25 });
    for (let i = 0; i < Math.round(18 * scale * share); i++) {
      const angle = face ? turn + r.range(0, Math.PI) : r.range(0, TAU), speed = r.range(3, 21) * scale * fit;
      this.add('spark', { ember: true, x: e.x + nx * .02, y: e.y + ny * .02, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: r.range(.25, 1.3), size: r.range(.04, .16), drag: .6, tint: 0xffdd9d });
    }
    if (height < radius) this.skirt(e.x, { count: 12, speed: scale, reach: radius });
    if (dig > 0) {
      // Fine soil stays with the rising cloud. Only the small solid fragments
      // follow gravity; they disappear early within the opaque plume.
      const material = groundLooks[this.terrain?.groundAt?.(e.x) || 'soil'] || GROUND_SURFACES.soil,
        rest = (x: number) => (this.terrain?.height(x) || 0) + .05;
      for (let finger = 0; finger < Math.round(4 * scale * dig); finger++) {
        const angle = Math.PI / 2 + r.range(-.85, .85), reach = r.range(5, 8) * scale, x = e.x + r.range(-.1, .1) * radius;
        for (let i = 1; i <= 2; i++) {
          const speed = reach * i / 2 * r.range(.85, 1.1);
          this.add('smoke', { art:'denseSmoke', x, y: rest(x), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, drag: 2.3, lift: .9,
            life: r.range(5, 6), size: (r.range(.3, .5) * scale + radius * .05) * (1.2 - i * .15), grow: r.range(.10, .16),
            aspectX: r.range(.9, 1.2), aspectY: r.range(1.25, 1.6), rotation: 0, spin: r.range(-.06,.06),
            tint: material.dust, opacity: r.range(.82, .96), fadeIn: .04, fade: .25 });
        }
      }
      for (let i = 0; i < Math.round(8 * scale * dig); i++) {
        const angle = Math.PI / 2 + r.range(-1.1, 1.1), speed = r.range(4, 15) * scale ** .7, x = e.x + r.range(-.1, .1) * radius;
        this.add('dust', { x, y: rest(x), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, drag: .5,
          life: r.range(.18, .55), size: r.range(.025, .075), spin: r.range(-6, 6), tint: i % 2 ? material.color : material.top, opacity: .7 });
      }
    }
  }
  // A fire with little fuel left flares with one small flame under more of its smoke.
  burn(e: EffectEvent) {
    const actor = e.actorId || '', location = e.componentId || Math.round(e.x * 4) + ',' + Math.round(e.y * 4),
      key = e.exterior ? 'burn:' + actor + ':outside:' + location : 'burn:' + (actor || location);
    let source = this.burningSources.get(key); const fresh = !source;
    if (!source) {
      if (this.burningSources.size >= 64) {
        const oldest = this.burningSources.keys().next().value;
        this.burningSources.get(oldest!)!.ttl = 0; this.burningSources.delete(oldest!);
      }
      source = { key, actorId: e.actorId, componentId: e.componentId, x: e.x, y: e.y, strength: e.strength ?? .65,
        ttl: 0, wait: this.ahead, fireClock: 0, smokeClock: 0, site: 0, phase: this.random.range(0,TAU), flames: [] };
      this.burningSources.set(key, source);
    }
    source.x = e.x; source.y = e.y; source.strength = e.strength ?? .65;
    source.exterior = e.exterior === true;
    source.spread = source.exterior ? 0 : clamp(e.spread ?? 0, 0, 1);
    source.radius = Number.isFinite(e.radius) ? Math.max(.05, e.radius!) : undefined;
    source.componentId = e.componentId;
    source.ttl = .2 + this.ahead;
    this.emitBurn(source, fresh ? (source.strength < .35 ? 1 : 2) : 0, fresh ? 1 : 0);
  }
  // Native messages refresh the source; the presentation clock controls its bounded emission rate.
  emitBurn(e: BurnSource, fires: number, smoke: number) {
    const r = this.random, strength = e.strength, heat = Math.sqrt(clamp(strength / 1.15, 0, 1)), dying = strength < .35, scale = .2 + 1.25 * heat,
      source = this.pose?.(e.componentId), origin = { x: source?.x ?? e.x, y: source?.y ?? e.y, angle: source?.angle || 0, carrier: e.componentId },
      surface = e.exterior ? null : this.fireSurface?.(e.actorId),
      point = (random: number) => {
        const root = e.exterior && source ? componentFirePoint(source, origin, random, this.fireProfile?.(e.componentId)) : firePoint(surface, origin, e.spread!, random, e.radius),
          floor = this.terrain?.height?.(root.x);
        return Number.isFinite(floor) && root.y < floor! + .025 ? { ...root, y: floor! + .025 } : root;
      }, glow = point(.5),
      motion = this.velocity?.(e.actorId), lean = clamp((motion?.vx || 0) * .008, -.35, .35);
    const quotas: Record<EffectQuality, readonly [number, number]> = {high:[4,16],balanced:[3,10],low:[2,4]}, quota=quotas[this.quality],
      pieces=surface?.opened?surface.burning?.length||0:0;
    // Open fires use the same batched tongues to cover their visible fuel.
    // The roots turn with it; the full plume stays upright and may leave it.
    e.flameCount = dying ? 1 : Math.min(quota[1],Math.max(quota[0],Math.ceil(pieces*1.5))); e.scale = scale; e.heat = heat; e.lean = lean;
    this.light({ key: e.key, x: glow.x, y: glow.y + .15 * scale, carrier: glow.carrier, lift: .15 * scale, age: 0, life: .16,
      size: 1.25 * scale + Math.min((surface?.width || 0) * e.spread!, e.radius ?? Infinity) * .25,
      strength: .08 + .2 * heat, tint: 0xffad58, phase: e.phase, effectActorId: e.actorId,
      sites: (surface?.burning?.length ?? 0) > 1 ? [point(.05),point(.95)] : undefined });
    for (let i = 0; i < fires; i++) {
      // Give each visible fuel a main tongue before scattering smaller
      // offshoots. Seeded offsets stay on the material instead of sliding as
      // they animate; identical parts do not all acquire the same pair.
      const slot = e.site % e.flameCount, seed=Math.floor(e.phase*1e6),jitter=lineNoise(seed,0,slot),
        main=Math.min(pieces,e.flameCount),primary=slot<main,
        part=primary?Math.floor((slot+.5)*pieces/main):Math.min(pieces-1,Math.floor(lineNoise(seed,1,slot)*pieces)),
        at=pieces?(part+(primary?.24+.52*jitter:.06+.88*jitter))/pieces:
          e.flameCount===1?.5:.05+slot/(e.flameCount-1)*.9+Math.sin(e.phase+slot*2.4)*.015,
        root = point(at),
        previous = e.flames[slot], pose = this.pose?.(root.carrier), c = Math.cos(pose?.angle || 0), s = Math.sin(pose?.angle || 0),
        dx = root.x - (pose?.x || 0), dy = root.y - (pose?.y || 0),
        x = pose ? c*dx+s*dy : root.x, y = pose ? c*dy-s*dx : root.y;
      e.site = (slot + 1) % e.flameCount;
      if (previous && previous.carrier === (pose ? root.carrier : undefined) &&
        (pose&&root.profile!==undefined&&previous.burnProfile===root.profile||Math.hypot(x-(pose?previous.carryX:previous.x),y-(pose?previous.carryY:previous.y)) < .1)) continue;
      // Let the previous contact finish its fade if the cutaway, burning part
      // or hull changed; moving a live root would make the flame teleport.
      e.flames[slot] = null;
      const size = r.range(.42, .68)*(root.span?root.span*1.35:1)*(pieces&&!primary?.6:1), turn = r.range(-.09,.09);
      const flame = this.add('fire', { priority: true, flame: true, actorId: e.actorId, carrier: root.carrier,
      burnSource: e, burnSlot: slot, burnSize: size, burnTurn: turn, burnProfile:root.profile,
      x: root.x, y: root.y,
      size: size * scale,
      life: e.ttl + BURN_FADE, grow: 0, drag: 0, rotation: turn + lean, spin: 0,
      aspectX: r.range(1.5, 2.1) * (r.next()<.5?-1:1), aspectY: r.range(1.2, 1.8), opacity: .44 + .28 * heat });
      if (flame) e.flames[slot] = flame;
    }
    for (let i = 0; i < smoke; i++) {
      const root = point(r.next());
      this.add('smoke', { actorId: e.actorId, x: root.x, y: root.y + .10 * scale,
      vx: r.range(-.16, .35) + clamp(motion?.vx || 0, -50, 50) * .4, vy: .65 + .45 * heat + clamp(motion?.vy || 0, -10, 10) * .15,
      size: r.range(.42, .62) * scale, life: r.range(4, 5.5), grow: .28, lift: .35 + .7 * heat,
      aspectX: r.range(1.05, 1.6), aspectY: r.range(.85, 1.25), spin: r.range(-.10, .10),
      // A small fuel fire can still leave a substantial soot trail. Its flame
      // quota stays low; combustion colour is distinct from white propellant.
      hotSmoke: 5, tint: HOT_SMOKE_TINTS[4]![31]!,
      opacity: dying ? .24 + .42 * clamp(strength/.35,0,1) : .68 + .18 * heat, fadeIn: .15, fade: dying ? .8 : .45 });
    }
    if (fires && !dying && r.next() < .035) this.add('spark', { actorId: e.actorId, ember: true, x: glow.x, y: glow.y + .2 * scale,
      vx: r.range(-.3, .3), vy: r.range(.7, 1.5), life: r.range(.35, .7), size: .018, drag: 1.5, tint: 0xffb65c, opacity: .6 });
  }
  ground(e: EffectEvent) {
    // Native collision energy sizes a wreck's impact cloud. Keep the same
    // twenty-particle contact budget; a heavy hit trades clods for low dust.
    const r = this.random, scale = e.power === undefined ? clamp(Math.sqrt(Math.max(0,e.impactEnergy ?? 0)/24000),.3,1.6) : clamp(Math.sqrt(Math.max(0,e.power))/16,.3,1.6),
      surface = e.surface || this.terrain?.groundAt?.(e.x) || 'soil', material = groundLooks[surface] || GROUND_SURFACES.soil, mud = surface === 'mud',
      heavy = (e.impactEnergy ?? 0) > 6000, clods = heavy && !mud ? 8 : 12, loose = !HARD.has(surface);
    for (let i = 0; i < clods; i++) this.add('dust', { external: true, x: e.x, y: e.y + .025,
      vx: r.range(-3, 3) * scale, vy: r.range(1, mud ? 3 : 5) * scale,
      size: r.range(.02, mud ? .065 : .055), life: r.range(.3, mud ? .6 : .8), tint: material.dust, opacity: mud ? .8 : .7 });
    if (!mud) for (let i = 0; i < 20-clods; i++) this.add('smoke', { external: true, x: e.x, y: e.y + .03,
      vx: r.range(-1.3, 1.3)*scale, vy: r.range(.1, heavy ? 1 : .5)*scale, size: r.range(.1, .18)*(heavy ? 1+scale : 1),
      aspectX: heavy ? 2 : 1, aspectY: heavy ? .6 : 1, lift: heavy ? .08 : .35,
      life: r.range(.7, 2), grow: .25, tint: material.dust, opacity: (heavy ? .55 : .3)*(loose ? 1 : .5), fade: heavy ? .6 : 1.4 });
  }
  surfaceTrail(e: SurfaceTrail) {
    if (!['soil', 'sand', 'gravel', 'mud', 'graded'].includes(e.surface) || !(e.speed > .75) || !(e.seconds > 0)) return;
    const r = this.random, material = groundLooks[e.surface] || GROUND_SURFACES.soil,
      mud = e.surface === 'mud', strength = clamp((e.speed - .75) / 20, 0, 1),
      due = Math.min(.1, e.seconds) * (mud ? 18 : 36) * (e.track ? 1.2 : 1) * strength,
      count = Math.floor(due) + (r.next() < due % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) this.add(mud ? 'dust' : 'smoke', { external: true,
      x: e.x + r.range(-.08, .08), y: e.y + .035,
      vx: -e.direction * r.range(.4, 1.5) * (.35 + strength),
      vy: mud ? r.range(.4, 1.4) * strength : r.range(.08, .28) + strength * .16,
      size: mud ? r.range(.025, .055) : r.range(.16, .28) + strength * .22,
      life: mud ? .45 : r.range(.9, 1.45) + strength * .35,
      grow: mud ? 0 : .25 + strength * .30, drag: mud ? 1.7 : 1.8, lift: .16,
      fadeIn: .1, fade: mud ? undefined : .9, opacity: mud ? .75 : .18 + .16 * strength, tint: material.dust,
      ...(mud ? {} : DRIVING_DUST) });
  }
  // What a gear that slips throws out behind it in `seconds`: clods of the ground it stands on, faster and
  // further the faster it slips, and over dry ground the dust of it.
  surfaceSpray(e: SurfaceSpray) {
    if (!['soil', 'sand', 'gravel', 'mud', 'graded'].includes(e.surface) || !(Math.abs(e.slip) > .5) || !(e.seconds > 0)) return;
    const r = this.random, material = groundLooks[e.surface] || GROUND_SURFACES.soil, mud = e.surface === 'mud',
      speed = Math.abs(e.slip), back = -Math.sign(e.slip), reach = clamp(speed / 5, .35, 1.6), due = Math.min(.1, e.seconds) * (e.track ? 60 : 40) * reach,
      count = Math.floor(due) + (r.next() < due % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      this.add('dust', { external: true, x: e.x + back * r.range(0, .15), y: e.y + .04,
        vx: back * r.range(1.2, 4.2) * reach, vy: r.range(1.4, mud ? 3.6 : 4.6) * reach,
        size: r.range(.04, mud ? .11 : .08), life: r.range(.4, .9), tint: i % 2 ? material.color : material.top, opacity: .95 });
      if (!mud && i % 2 === 0) this.add('smoke', { external: true, x: e.x + back * r.range(.1, .5), y: e.y + .12,
        vx: back * r.range(.6, 2.2) * reach, vy: r.range(.2, .7), size: r.range(.28, .5), life: r.range(1, 2),
        grow: .5, drag: 2, lift: .18, opacity: .4, tint: material.dust, ...DRIVING_DUST });
    }
  }
  rocketTrail(shot: Point, previous?: Point | null) {
    const start = previous || shot, distance = Math.hypot(shot.x - start.x, shot.y - start.y), count = clamp(Math.ceil(distance / 0.12), 1, 36);
    // The burning motor glows at the head of its own smoke.
    this.add('flash', { additive: true, art: 'glow', x: shot.x, y: shot.y, spin: 0, size: .45, life: .06, tint: 0xffb25e, opacity: .85 });
    for (let i = 0; i < count; i++) {
      const t = i / count;
      this.add('smoke', { x: start.x + (shot.x - start.x) * t, y: start.y + (shot.y - start.y) * t, size: 0.08, life: 1.8, grow: 0.14, opacity: 0.34, tint: 0xc1bdad }, true);
    }
  }
  // `elapsed` is the time since the last update. What an event made on the way has lived only since the event.
  update(elapsed: number) {
    if (elapsed <= 0) return;
    this.time += elapsed;
    for (const [key, source] of this.burningSources) {
      const dt = Math.max(0, elapsed - source.wait); source.wait = Math.max(0, source.wait - elapsed); source.ttl -= elapsed;
      if (source.ttl <= 0) { this.burningSources.delete(key); continue; }
      const heat = Math.sqrt(clamp(source.strength / 1.15, 0, 1)), speed = Math.abs(this.velocity?.(source.actorId)?.vx || 0);
      source.fireClock += dt * (1.5 + 6.5 * heat);
      source.smokeClock += dt * (4 + 10 * heat + Math.min(6, speed * .25) * heat) * (1 + Math.sin(this.time*1.7+source.phase)*.10);
      const fire = Math.min(2, Math.floor(source.fireClock)), smoke = Math.min(2, Math.floor(source.smokeClock));
      // A slow frame drops emissions above its cap; only the fraction carries into the next frame.
      source.fireClock %= 1; source.smokeClock %= 1;
      if (fire || smoke) {
        const ahead = this.ahead; this.ahead = elapsed; this.emitBurn(source, fire, smoke); this.ahead = ahead;
      }
    }
    this.jets.update(elapsed);
    const origin = this.origin, sight = this.sight, view = this.view;
    let write = 0, offView = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!, dt = p.wait > 0 ? Math.max(0, elapsed - p.wait) : elapsed;
      p.wait = 0; p.previousX = p.x; p.previousY = p.y; p.age += dt;
      const burn = p.burnSource;
      if (burn) {
        if (burn.ttl > 0 && burn.flames[p.burnSlot] === p && p.burnSlot < burn.flameCount!) {
          p.life = p.age + burn.ttl + BURN_FADE;
          const blend = 1 - Math.exp(-dt*6);
          p.size += (p.burnSize*burn.scale!-p.size)*blend;
          p.opacity += (.44+.28*burn.heat!-p.opacity)*blend;
          p.rotation += (p.burnTurn+burn.lean!-p.rotation)*blend;
        } else p.life = Math.min(p.life,p.age+BURN_FADE);
      }
      // Smoke that drifted out of sight, or that the sight left behind, is gone with it.
      if (p.age >= p.life || sight && !contains(sight, p.x)) { this.retire(p); continue; }
      if (outside(view, p)) offView++;
      if (p.groundDust) { updateGroundDust(p, dt, this.terrain, origin); this.particles[write++] = p; continue; }
      const t = burn ? 1-clamp((p.life-p.age)/BURN_FADE,0,1) : p.age / p.life,
        drag = Math.exp(-p.drag * dt); p.vx *= drag; p.vy *= drag;
      if (p.kind === 'smoke') {
        p.vx += (0.27 + Math.sin(p.age * 1.8 + p.y * 3) * 0.09 - p.vx) * dt * 0.5;
        p.vy += ((p.lift ?? .35) * (1 - t) - p.vy * .04) * dt;
        p.sprite.alpha = p.opacity * Math.min(1, p.age / (p.fadeIn || .16)) * (1 - t) ** (p.fade ?? 1.4);
        if (p.hotSmoke) {
          p.smokeTint = HOT_SMOKE_TINTS[p.hotSmoke - 1]![Math.min(31, Math.floor(p.age / (p.hotSmoke === 5 ? p.life : .65) * 31))]!;
          tintParticle(p.sprite,p.smokeTint);
        }
      } else if (p.kind === 'fire') {
        if (!p.flame) { p.vy += 1.6 * dt; p.vx += Math.sin(p.age * 11 + p.phase) * dt * .5; }
        tintParticle(p.sprite, (p.flame ? FLAME_TINTS : FIRE_TINTS)[Math.min(31, Math.floor(t * 31))]!);
        p.sprite.alpha = burn ? p.opacity * smoothstep(p.age/.16) * smoothstep(1-t) *
          (.94+Math.sin(p.age*11+p.phase)*.04+Math.sin(p.age*6.7+p.phase*2)*.02) :
          p.opacity * (1 - t) ** (p.flame ? .55 : 1.1) *
          (p.flame ? Math.min(1, p.age / .035) * (.90 + Math.sin(p.age * 21 + p.phase) * .10) : 1);
        const frames = p.flame && this.atlas.flame || this.atlas.fire,
          cycle = p.flame ? Math.min(FLAME_FRAMES,frames.length) : frames.length,
          family = Math.floor(p.textureVariant/cycle)*cycle,
          frame = family + (p.textureVariant%cycle + Math.floor(p.age * (p.flame ? 32 + p.phase*.6 : 8))) % cycle;
        if (p.sprite.texture !== frames[frame]!) p.sprite.texture = frames[frame]!;
      } else if (p.kind === 'spark' || p.kind === 'dust') {
        p.vy -= 9.81 * dt; p.sprite.alpha = p.opacity * (1 - t);
        if (p.ember) tintParticle(p.sprite, t < .3 ? 0xffe9b1 : t < .65 ? 0xffb968 : 0xe2753f);
      }
      else p.sprite.alpha = p.kind === 'flash' ? p.opacity * (1 - t) ** (p.fade ?? 1.6) : (1 - t) ** 1.3;
      p.x += p.vx * dt; p.y += p.vy * dt;
      // Slow smoke high above the ground reuses its local height sample.
      // Near contact and fast debris still read the exact current contour.
      // Flashes follow their emitter and never collide with the ground.
      if (p.kind !== 'flash') {
        if (p.floorTerrain !== this.terrain || !Number.isFinite(p.floorHeight) ||
            p.kind !== 'smoke' && p.kind !== 'fire' || Math.abs(p.x - p.floorX) > .1 || p.y < p.floorHeight + .08) {
          p.floorTerrain = this.terrain; p.floorX = p.x;
          p.floorHeight = (this.terrain?.height(p.x) || 0) + .005;
        }
        const floor = p.floorHeight;
        if (p.y < floor) {
          p.y = floor;
          if (p.kind !== 'smoke') p.age = p.life; else { p.vy = Math.abs(p.vy) * 0.1; p.vx *= 0.97; }
        }
      }
      const size = p.size + p.grow * p.age;
      p.sprite.x = p.x - origin.x; p.sprite.y = p.y - origin.y; p.sprite.rotation = p.rotation + p.spin * p.age;
      p.sprite.scaleX = size * p.aspectX / 128; p.sprite.scaleY = size * p.aspectY / 128;
      if (p.kind === 'smoke' && p.hotSmoke === 5) {
        // Rising combustion smoke opens into broad, slowly rolling veils.
        // Keep the same particles instead of adding layers to hide round puffs.
        p.sprite.rotation += Math.sin(p.age*1.8+p.phase)*.14;
        p.sprite.scaleX *= 1+t*.28+Math.sin(p.age*2.1+p.phase)*.10;
        p.sprite.scaleY *= 1-t*.08+Math.cos(p.age*1.7+p.phase)*.07;
      }
      if (p.flame) {
        p.sprite.rotation = p.rotation + Math.sin(p.age * 7 + p.phase) * .05;
        p.sprite.scaleX *= (1 - t * .28) * (1 + Math.sin(p.age * 9 + p.phase) * .05);
        p.sprite.scaleY *= (1 + (burn ? .18*(1-Math.exp(-p.age*4))*(1-t*.5) : t*.38)) * (1 + Math.sin(p.age * 12 + p.phase) * .045);
      }
      if (p.kind === 'spark') { p.sprite.rotation = Math.atan2(p.vy, p.vx); p.sprite.scaleX = Math.max(p.size, Math.hypot(p.vx, p.vy) * 0.012) / 128; p.sprite.scaleY = 0.025 / 128; }
      this.particles[write++] = p;
    }
    this.particles.length = write; this.offView = offView; this.settle();
    write = 0;
    for (const light of this.lights) {
      light.age += light.wait! > 0 ? Math.max(0, elapsed - light.wait!) : elapsed; light.wait = 0;
      if (light.age < light.life) this.lights[write++] = light; else this.retireLight(light);
    }
    this.lights.length = write;
    this.blastWaves.update(elapsed);
    this.vegetation.update(elapsed);
  }
  // A particle made on a part stays where it was made on it, wherever the part is shown: a spot on a plate goes with the plate.
  carry(p: EffectParticle) {
    const pose = this.pose?.(p.carrier);
    if (!pose) return;
    const c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0);
    p.x = p.previousX = pose.x + c * p.carryX - s * p.carryY; p.y = p.previousY = pose.y + s * p.carryX + c * p.carryY;
  }
  sample(alpha: number) {
    // A halo keeps its sprite until it expires: compacting the light records must not move
    // surviving halos between actors and rebuild their Pixi draw instructions.
    for (const light of this.lights) {
      let sprite = light.sprite;
      if (!sprite) {
        sprite = this.lightSprites.find(candidate => !candidate.visible);
        if (!sprite) { sprite = new Sprite(this.atlas.glow); sprite.anchor.set(.5); sprite.blendMode = 'add'; this.lightSprites.push(sprite); }
        light.sprite = sprite;
      }
      const target = this.layersFor(light.effectActorId).glows;
      if (sprite.parent !== target) target.addChild(sprite);
      const t = light.age / light.life, place = (spot: LightSite) => {
        const carrier = spot.carrier !== undefined ? this.pose?.(spot.carrier) : null, c = Math.cos(carrier?.angle || 0), s = Math.sin(carrier?.angle || 0);
        spot.displayX = carrier ? carrier.x+c*(spot.carryX||0)-s*(spot.carryY||0) : spot.x;
        spot.displayY = carrier ? carrier.y+s*(spot.carryX||0)+c*(spot.carryY||0) : spot.y;
      };
      place(light); for (const spot of light.sites || []) place(spot);
      light.displayStrength = light.strength * (light.key ? .94 + Math.sin(this.time*6.7+(light.phase||0))*.04 +
        Math.sin(this.time*13.1+(light.phase||0)*2.3)*.02 : (1-t)**2.4);
      sprite.visible = true; sprite.position.set(light.displayX,light.displayY);
      sprite.width = sprite.height = light.size * (light.blast ? .75 + t * .65 : 1);
      light.displayTint = light.tint || (light.blast && t < .3 ? 0xfff0cb : 0xffb36a); sprite.tint = light.displayTint;
      sprite.alpha = light.displayStrength * (light.key ? .22 : light.blast ? .8 : .6);
    }
    this.blastWaves.sample(alpha);
    const origin = this.origin;
    this.settle();
    for (const p of this.particles) {
      if (p.carrier !== undefined) this.carry(p);
      const x = p.previousX + (p.x - p.previousX) * alpha;
      p.sprite.x = x - origin.x;
      p.sprite.y = p.previousY + (p.y - p.previousY) * alpha - origin.y;
      // Flame roots remain on the material. Upward motion lives inside their
      // cached artwork, so the entire burning bed never floats off the part.
      if (p.groundDust) {
        p.sprite.y = groundDustHeight(p, this.terrain, x) + p.dustLift - origin.y;
        p.sprite.rotation = Math.atan(p.dustSurface?.slope || 0);
      }
    }
  }
}
