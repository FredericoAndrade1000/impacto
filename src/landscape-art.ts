import type { ImageResource } from 'pixi.js';
import type { Terrain, TerrainId } from './terrain.ts';
import type { EffectCamera } from './effect-types.ts';
type RGB = readonly [number, number, number];
interface Sky { stops: [number, RGB][]; light: RGB; fog: RGB; sun: number; clouds: number; veil: number }
export interface BackdropArt { clouds?: ImageResource; ranges?: CanvasImageSource }
interface RangePlace { id: TerrainId; start?: number }
interface RangeEntry { place: RangePlace | null; key: string | null; used: number; texture: Texture | null; resolution: number }
interface Cloud { sprite: Sprite; high?: number; size?: number; start?: number; speed?: number }
interface Mote { sprite: Sprite; start: number; speed: number; lift: number; long: number; tall: number; sway: number; strength: number }
import { BufferImageSource, CanvasSource, Container, ImageSource, Mesh, MeshGeometry, Rectangle, Sprite, Texture } from 'pixi.js';
import { Random, clamp, lerp, TAU, smoothstep } from './math.ts';
import { biomeFade } from './terrain-art.ts';
import { GroundRelief } from './strata-art.ts';
import { TERRAIN_PROFILES } from './terrain.ts';
import { RangeBlend } from './range-blend.ts';

// Distant scenery uses its own depth, in both camera axes. Its reference ground is a fixed kilometre
// of the map, independent of the viewport and zoom. The sky and sun are infinitely far away; clouds
// and ranges translate at their own depth. Camera movement never changes their shape or spacing.
const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
const rgba = (c: RGB, alpha = 1) => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
const hex = (c: RGB) => c[0] << 16 | c[1] << 8 | c[2];

// The sky from the horizon (0) to overhead (1), and the light of each weather.
const SKIES: Readonly<Record<string, Sky>> = Object.freeze({
  clear: { stops: [[0, [229, 214, 178]], [.07, [216, 211, 184]], [.2, [186, 197, 188]], [.42, [135, 166, 185]], [.7, [91, 133, 162]], [1, [63, 104, 136]]],
    light: [255, 240, 200], fog: [204, 209, 186], sun: .95, clouds: .9, veil: 0 },
  haze: { stops: [[0, [227, 203, 161]], [.07, [220, 199, 159]], [.2, [204, 189, 155]], [.42, [177, 171, 147]], [.7, [141, 147, 137]], [1, [112, 124, 122]]],
    light: [255, 228, 180], fog: [222, 201, 163], sun: .7, clouds: .5, veil: .16 },
  mist: { stops: [[0, [208, 213, 205]], [.07, [204, 211, 204]], [.2, [192, 202, 198]], [.42, [170, 184, 184]], [.7, [140, 158, 162]], [1, [112, 134, 142]]],
    light: [236, 236, 222], fog: [202, 214, 211], sun: .34, clouds: .6, veil: .3 },
});
const SKY_ROWS = 256;
export function skyTones(weather = 'clear') {
  const stops = (SKIES[weather] || SKIES.clear!).stops, data = new Uint8Array(2 * SKY_ROWS * 4);
  for (let row = 0; row < SKY_ROWS; row++) {
    const height = 1 - row / (SKY_ROWS - 1); let i = 1; while (i < stops.length - 1 && stops[i]![0] < height) i++;
    const [from, a] = stops[i - 1]!, [to, b] = stops[i]!, tone = mix(a, b, smoothstep((height - from) / (to - from)));
    for (let column = 0; column < 2; column++) data.set([...tone, 255], (row * 2 + column) * 4);
  }
  return data;
}
// A soft disc with no edge: the sun is a glow, and so is a wisp of dust.
function glowTones(size: number, falloff: (r: number) => number) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.min(1, Math.hypot(x + .5 - size / 2, y + .5 - size / 2) / (size / 2));
    data.set([255, 255, 255, Math.round(255 * clamp(falloff(r), 0, 1) * (1 - smoothstep((r - .8) / .2)))], (y * size + x) * 4);
  }
  return data;
}
export const bufferTexture = (data: Uint8Array, width: number, height: number) => new Texture({ source: new BufferImageSource({ resource: data, width, height,
  format: 'rgba8unorm', alphaMode: 'premultiply-alpha-on-upload', scaleMode: 'linear', addressMode: 'clamp-to-edge' }) });
// The mist over ground a faction does not see (ground-mist.ts) is of the sky it lies under: the haze of that
// weather with some of the sky well above the horizon in it, a little darker than the horizon it stands against,
// and for its wisps the same gone paler.
export function mistTones(weather = 'clear') {
  const sky = SKIES[weather] || SKIES.clear!, bank = mix(sky.stops[4]![1], sky.fog, .4);
  // The haze over ground that is known and out of sight is the shade of the bank, not its pallor: it dims what it covers.
  return { bank: hex(bank), wisp: hex(mix(bank, [255, 255, 255], .35)), veil: hex(mix(bank, [14, 22, 26], .7)) };
}

// Two silhouettes of each cloud type share one atlas; a scene still draws seven sprites.
const CLOUD_SHEET = 512, CLOUD_ROW = 128;

// Each biome owns one continuous panorama. The approved art already contains
// near and distant ridges: repeating it at several depths creates extra peaks
// and abrupt bands of haze where the copies cover one another.
const RANGES: Readonly<Record<string, { row: number } | undefined>> = Object.freeze({
  highlands: { row: 0 },
  'wet-valley': { row: 1 },
  'rural-ridges': { row: 2 },
  'arid-basin': { row: 3 },
  plateau: { row: 4 },
});
const TRACK_RANGES: Record<string, string | undefined> = { sand: 'arid-basin', rock: 'highlands', mud: 'wet-valley' };
const rangesOf = (id: TerrainId) => RANGES[id] || RANGES[TRACK_RANGES[TERRAIN_PROFILES[id]?.surface] || 'rural-ridges']!;
// Projection and raster dimensions have separate jobs. The 4:1 projection
// preserves the source's proportions; painting keeps its native texel grid.
// Its complete foot stays below a valley view, independently of camera height.
const STRIP_WIDTH = 1536, STRIP_HEIGHT = 384, RANGE_ROW_WIDTH = 2048, RANGE_ROW_HEIGHT = 512;
const RANGE = Object.freeze({ air: .29, slide: .25, foot: 1.08 });
export function paintRange(canvas: HTMLCanvasElement, biome: TerrainId, weather: string, seed: number, resolution = 1, art: BackdropArt = {}) {
  canvas.width = RANGE_ROW_WIDTH * Math.min(1, resolution * 2); canvas.height = RANGE_ROW_HEIGHT * resolution;
  const ctx = canvas.getContext('2d')!, look = rangesOf(biome), sky = SKIES[weather] || SKIES.clear!,
    { air } = RANGE, atmosphere = mix(sky.stops[3]![1], sky.fog, .38),
    veil = clamp(air + sky.veil * 1.4, 0, .94);
  ctx.scale(canvas.width / RANGE_ROW_WIDTH, canvas.height / RANGE_ROW_HEIGHT);
  if (art.ranges) {
    const shift = (seed >>> 0) % RANGE_ROW_WIDTH;
    for (const x of [-shift, RANGE_ROW_WIDTH - shift])
      ctx.drawImage(art.ranges, 0, look.row * RANGE_ROW_HEIGHT, RANGE_ROW_WIDTH, RANGE_ROW_HEIGHT, x, 0, RANGE_ROW_WIDTH, RANGE_ROW_HEIGHT);
    ctx.save(); ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = rgba(atmosphere, veil); ctx.fillRect(0, 0, RANGE_ROW_WIDTH, RANGE_ROW_HEIGHT); ctx.restore();
  }
  return { canvas };
}

const newCanvas = () => document.createElement('canvas');
const stripTexture = (canvas: HTMLCanvasElement) => new Texture({ source: new CanvasSource({ resource: canvas, addressModeU: 'repeat', addressModeV: 'clamp-to-edge',
  alphaMode: 'premultiply-alpha-on-upload', scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true }) });
// Each range is a single immutable image plane. There is no solid-colour extension or movable foot.
const TURNS = 48;
function rangeMesh() {
  const wide = TURNS * STRIP_WIDTH, low = 1 - 2 / RANGE_ROW_HEIGHT,
    geometry = new MeshGeometry({ positions: new Float32Array([0, -STRIP_HEIGHT, wide, -STRIP_HEIGHT, 0, 0, wide, 0]),
      uvs: new Float32Array([0, 0, TURNS, 0, 0, low, TURNS, low]), indices: new Uint32Array([0, 1, 2, 2, 1, 3]) });
  return new RangeBlend(geometry);
}
// The sky: flat overhead colour above, the gradient over one unit of height, the horizon's tone below.
function skyMesh(texture: Texture) {
  const far = 400, top = .5 / SKY_ROWS, low = 1 - .5 / SKY_ROWS,
    geometry = new MeshGeometry({ positions: new Float32Array([0, -far, 1, -far, 0, -1, 1, -1, 0, 0, 1, 0, 0, far, 1, far]),
      uvs: new Float32Array([.5, top, .5, top, .5, top, .5, top, .5, low, .5, low, .5, low, .5, low]), indices: new Uint32Array([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6, 6, 5, 7]) });
  return new Mesh({ geometry, texture });
}

// How large the ranges are drawn at a zoom: they grow as the camera closes in, far less than the field does.
export const rangeScale = (zoom: number) => clamp(.5 * zoom ** .32, .3, 1.5);
// Match the projected height in device pixels. Cached planes only promote; panning and
// shrinking a view reuse them. Horizontal resolution stays native in normal views.
export function rangeResolution(zoom: number, height: number, pixelRatio = 1) {
  const projected = STRIP_HEIGHT * rangeScale(zoom) * height / 600 * pixelRatio;
  return projected <= 128 ? .25 : projected <= 256 ? .5 : 1;
}
const CLOUDS = Object.freeze([
  { kind: 0, start: .08 }, { kind: 2, start: .43 }, { kind: 3, start: .79 },
  { kind: 0, start: .21, alternate: true }, { kind: 3, start: .64, alternate: true }, { kind: 2, start: .95, alternate: true }, { kind: 1, start: .38 },
]);
// Keep both images of a transition. Cache positions never determine draw order.
// Otherwise reuse an empty entry first, then the least recently shown one.
function rangeEntry(cache: readonly RangeEntry[], place: RangePlace, reserved: RangeEntry | null | undefined) {
  let available;
  for (const entry of cache) {
    if (entry.place === place) return entry;
    if (entry === reserved) continue;
    if (!available || available.place && (!entry.place || entry.used < available.used)) available = entry;
  }
  return available!;
}

export class Backdrop {
  declare art: BackdropArt | null; declare root: Container; declare release: (() => void) | null; declare width: number; declare height: number; declare pixelRatio: number; declare weather: string | null; declare ground: Terrain | null;
  declare cache: RangeEntry[]; declare range: RangeBlend | null; declare clouds: Cloud[]; declare cloudHost: Container; declare paints: number; declare rangeUse: number;
  declare sky?: ReturnType<typeof skyMesh> | null; declare sun: Sprite; declare sunTexture?: Texture; declare cloudSource?: ImageSource; declare skyTexture?: Texture; declare relief: GroundRelief;
  constructor(release: (() => void) | null = null, art: BackdropArt = {}) {
    this.art = art;
    this.root = new Container(); this.release = release; this.width = 900; this.height = 550; this.pixelRatio = 1; this.weather = null; this.ground = null;
    this.cache = Array.from({ length: 2 }, () => ({ place: null, key: null, used: 0, texture: null, resolution: 0 }));
    this.range = null;
    this.clouds = []; this.cloudHost = new Container(); this.paints = 0; this.rangeUse = 0;
  }
  // The textures every map shares are made with the first scene: tests of the renderer never need a canvas.
  prepare() {
    if (this.sky) return;
    this.sunTexture = bufferTexture(glowTones(128, r => .95 * Math.exp(-((r / .085) ** 2)) + .5 * Math.exp(-((r / .3) ** 2)) + .16 * (1 - r) ** 2), 128, 128);
    this.cloudSource = new ImageSource({ resource: this.art!.clouds!, width: CLOUD_SHEET * 2, height: CLOUD_ROW * 4, scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true });
    this.sky = skyMesh(Texture.EMPTY); this.sun = new Sprite(this.sunTexture); this.sun.anchor.set(.5);
    for (const { kind } of CLOUDS) {
      const sprite = new Sprite(new Texture({ source: this.cloudSource, frame: new Rectangle(0, kind * CLOUD_ROW, CLOUD_SHEET, CLOUD_ROW) }));
      sprite.anchor.set(.5); this.clouds.push({ sprite }); this.cloudHost.addChild(sprite);
    }
    this.range = rangeMesh();
    this.root.addChild(this.sky, this.sun, this.cloudHost, this.range);
  }
  resize(width: number, height: number, pixelRatio = 1) { this.width = width; this.height = height; this.pixelRatio = pixelRatio; }
  // A new map or weather: another sky, the clouds where the seed of the map puts them, and no range kept.
  setScene(ground: Terrain, weather = 'clear') {
    this.prepare();
    const sky = SKIES[weather] || SKIES.clear!;
    if (weather !== this.weather) {
      const old = this.skyTexture; this.skyTexture = bufferTexture(skyTones(weather), 2, SKY_ROWS); this.sky!.texture = this.skyTexture;
      if (old) { this.release?.(); old.destroy(true); }
    }
    this.weather = weather; this.ground = ground; this.relief = new GroundRelief(ground);
    for (const entry of this.cache) entry.place = null;
    const random = new Random((ground.seed ^ 0x28ad) >>> 0 || 581);
    this.sun.tint = hex(sky.light); this.sun.alpha = sky.sun;
    this.clouds.forEach((cloud, i) => {
      // Low clouds are far: small, slow and many. The few high ones are near and large.
      const high = (i + random.range(.05, .95)) / CLOUDS.length, { kind, start, alternate } = CLOUDS[i]!,
        column = ((ground.seed >>> kind) ^ Number(!!alternate)) & 1;
      cloud.sprite.texture.frame.copyFrom(new Rectangle(column * CLOUD_SHEET, kind * CLOUD_ROW, CLOUD_SHEET, CLOUD_ROW));
      cloud.sprite.texture.update();
      Object.assign(cloud, { high: .08 + .71 * high ** 1.05, size: lerp(.36, 1.35, high) * random.range(.88, 1.15), start: start + random.range(-.045, .045), speed: lerp(3, 11, high) });
      cloud.sprite.alpha = sky.clouds * lerp(.62, 1, high); cloud.sprite.tint = hex(mix([255, 255, 255], sky.fog, weather === 'clear' ? .12 * (1 - high) : .35));
    });
  }
  // The ranges kept are painted again, on canvases of their own, the next time they are shown (Renderer.repaint).
  repaint() { for (const entry of this.cache) entry.place = entry.key = null; }
  // Cache only the images. Return retired textures so the caller can first
  // replace every sampler, then let the renderer release them.
  cacheRange(entry: RangeEntry, place: RangePlace, resolution: number) {
    const ground = this.ground!, own = place === ground, id = place.id,
      seed = own ? (ground.seed ^ 0x28ad) >>> 0 : (ground.seed ^ Math.imul(Math.round(place.start! - ground.center), 0x9e3779b1)) >>> 0,
      key = [id, seed, this.weather, resolution].join(':');
    entry.place = place;
    if (entry.key === key) return null;
    const retired = entry.texture;
    entry.key = key; entry.resolution = resolution; this.paints++;
    entry.texture = stripTexture(paintRange(newCanvas(), id, this.weather!, seed, resolution, this.art!).canvas);
    return retired;
  }
  // Called on every frame: it places and scales what exists, and paints only when a biome first comes into view.
  // The ranges are those of the biome at `place`: where the camera is, unless whoever looks may not know what lies there.
  update(camera: EffectCamera, time = 0, place = camera.x) {
    const ground = this.ground; if (!ground || !this.sky) return;
    const { width, height } = this, zoom = camera.zoom,
      seen = clamp((zoom - .1) / .3, 0, 1),
      scale = rangeScale(zoom) * height / 600,
      // This is a spatial property of the map, not the terrain currently framed on screen.
      // Keeping the image foot below this datum gives valleys a full landscape behind them.
      elevation = camera.y - this.relief.low(camera.x, 512),
      y = height * RANGE.foot + elevation * RANGE.slide * scale,
      rangesVisible = seen > 0 && y - STRIP_HEIGHT * scale < height + 2 && y > -2,
      fade = ground.biomes ? biomeFade(ground.biomes, place) : { here: ground, other: null, share: 0 };
    // Moving above the mountains does not prepare textures that are wholly below the screen. Keep
    // their images cached until they return; the sun and clouds can still be in view.
    this.range!.visible = rangesVisible; this.range!.alpha = seen;
    if (rangesVisible) {
      const resolution = rangeResolution(zoom, height, this.pixelRatio), used = ++this.rangeUse,
        neighbour = fade.other && this.cache.find(entry => entry.place === fade.other),
        here = rangeEntry(this.cache, fade.here, neighbour),
        there = fade.other ? rangeEntry(this.cache, fade.other, here) : here, retired = [];
      if (here.place !== fade.here || here.resolution < resolution) retired.push(this.cacheRange(here, fade.here, resolution));
      here.used = used;
      if (fade.other) {
        if (there.place !== fade.other || there.resolution < resolution) retired.push(this.cacheRange(there, fade.other, resolution));
        there.used = used;
      }
      this.range!.blend(here.texture!, there.texture!, fade.share);
      const along = camera.x * RANGE.slide;
      this.range!.scale.set(scale); this.range!.position.set(width / 2 - ((((along % STRIP_WIDTH) + STRIP_WIDTH) % STRIP_WIDTH) + 8 * STRIP_WIDTH) * scale, y);
      if (retired.some(Boolean)) { this.release?.(); for (const texture of retired) texture?.destroy(true); }
    }
    // Sky light has no camera-relative horizon. A cloud has a fixed altitude and size;
    // its small translation cannot stretch the sky or carry another cloud with it.
    this.sky.position.set(0, height); this.sky.scale.set(width, height);
    this.sun.position.set(width * .77, height * .18); this.sun.scale.set(height * .0074 * (this.weather === 'clear' ? 1 : 1.3));
    const cloudScale = height / 900, cloudElevation = camera.y - this.relief.at(ground.center);
    for (const cloud of this.clouds) {
      const sprite = cloud.sprite, wide = CLOUD_SHEET * cloud.size! * cloudScale, lap = width + wide,
        depth = .012 * (1 + cloud.high!) * cloudScale,
        phase = cloud.start! * lap + time * cloud.speed! * cloudScale - camera.x * depth;
      sprite.scale.set(cloud.size! * cloudScale);
      sprite.position.set(((phase % lap) + lap) % lap - wide / 2,
        height * (.72 - .8 * cloud.high!) + cloudElevation * depth);
    }
  }
  destroy() {
    this.release?.();
    this.range?.destroy();
    for (const entry of this.cache) entry.texture?.destroy(true);
    this.root.destroy({ children: true }); this.skyTexture?.destroy(true); this.sunTexture?.destroy(true); this.cloudSource?.destroy();
    this.cache = []; this.range = null; this.clouds = []; this.sky = null; this.art = null;
  }
}

// How much dust hangs over each ground, and its tone: lit dust is paler than the ground it rose from.
// Wet ground raises none.
const DUST: Readonly<Record<string, [number, number] | undefined>> = Object.freeze({ 'arid-basin': [1, 0xf0e2bd], plateau: [.8, 0xecd6b4], 'rural-ridges': [.25, 0xe2dac2], highlands: [.14, 0xdddcd0], 'wet-valley': [0, 0xe2dac2] });
const TRACK_DUST: Record<string, string | undefined> = { sand: 'arid-basin', soil: 'rural-ridges', rock: 'highlands' };
const MOTES = 6, MOTE_LAP = 96;
const DUST_WIDTH = 128, DUST_HEIGHT = 64;
// Ground dust is broken into thin overlapping wisps. A radial glow stretched
// into a large ellipse reads as a floating cloud rather than dust on the road.
function dustTones() {
  const data = new Uint8Array(DUST_WIDTH * DUST_HEIGHT * 4);
  for (let y = 0; y < DUST_HEIGHT; y++) for (let x = 0; x < DUST_WIDTH; x++) {
    const u = (x + .5) / DUST_WIDTH, v = (y + .5) / DUST_HEIGHT,
      spine = .5 + .06 * Math.sin(u * 15) + .025 * Math.sin(u * 31),
      side = Math.sin(Math.PI * u) ** 1.4,
      body = Math.exp(-(((v - spine) / (.095 + .06 * Math.sin(u * 8) ** 2)) ** 2)),
      broken = .48 + .3 * Math.sin(u * 19) ** 2 + .18 * Math.sin(u * 37 + v * 8) ** 2;
    data.set([255, 255, 255, Math.round(255 * side * body * broken)], (y * DUST_WIDTH + x) * 4);
  }
  return data;
}
// A few wisps of dust drifting low over dry ground, each one sprite. They are no part of the effects and
// take nothing from their budget; where they are follows from the time of the world and the place of
// the camera alone. From afar, and over wet ground, there are none. The renderer lays them behind the
// ground line, with the trees: they veil the scenery, never the earth or what is fought over, and on a
// slope the ground hides the end of a wisp that would lie in it.
export class AmbientDust {
  declare host: Container; declare motes: Mote[]; declare texture?: Texture; declare ground?: Terrain; declare weather?: string;
  constructor() {
    this.host = new Container(); this.host.visible = false; this.motes = [];
  }
  prepare() {
    if (this.texture) return;
    this.texture = bufferTexture(dustTones(), DUST_WIDTH, DUST_HEIGHT);
    const random = new Random(0xd057);
    for (let i = 0; i < MOTES; i++) {
      const sprite = this.host.addChild(new Sprite(this.texture)); sprite.anchor.set(.5);
      this.motes.push({ sprite, start: (i + random.range(0, .8)) / MOTES * MOTE_LAP, speed: random.range(1.1, 2.8), lift: random.range(.18, .55),
        long: random.range(5, 12), tall: random.range(.4, .9), sway: random.range(0, TAU), strength: random.range(.6, 1) });
    }
  }
  setScene(ground: Terrain, weather = 'clear') { this.prepare(); this.ground = ground; this.weather = weather; }
  amount(x: number) {
    const ground = this.ground!, of = (id: TerrainId): [number, number] => DUST[id] || DUST[TRACK_DUST[TERRAIN_PROFILES[id]?.surface] ?? ''] || [0, 0xb5ab8c],
      fade = ground.biomes ? biomeFade(ground.biomes, x) : { here: ground, other: null, share: 0 }, here = of(fade.here.id), there = fade.other ? of(fade.other.id) : here,
      dry = lerp(here[0], there[0], fade.share);
    return { strength: this.weather === 'mist' ? dry * .3 : this.weather === 'haze' ? Math.min(1.3, dry * 1.4 + .3) : dry, tint: fade.share > .25 ? there[1] : here[1] };
  }
  update(camera: EffectCamera, time = 0) {
    const ground = this.ground; if (!ground || !this.texture) return;
    // Wisps a few metres long are seen between a view that holds a lap of them and one a single wisp fills.
    const zoom = camera.zoom, near = clamp((zoom - 5) / 4, 0, 1) * clamp((260 - zoom) / 120, 0, 1), { strength, tint } = near > 0 ? this.amount(camera.x) : { strength: 0 };
    this.host.visible = near * strength > .01;
    if (!this.host.visible) return;
    for (const mote of this.motes) {
      const away = ((((mote.start + time * mote.speed - camera.x) % MOTE_LAP) + MOTE_LAP) % MOTE_LAP) - MOTE_LAP / 2, x = camera.x + away, sprite = mote.sprite,
        edge = 1 - smoothstep((Math.abs(away) - MOTE_LAP * .32) / (MOTE_LAP * .16));
      sprite.position.set(x, ground.height(x) + mote.lift + .06 * Math.sin(time * .5 + mote.sway));
      // A wisp lies along the ground under it.
      sprite.rotation = Math.atan((ground.height(x + 4) - ground.height(x - 4)) / 8);
      sprite.scale.set(mote.long / DUST_WIDTH, mote.tall / DUST_HEIGHT); sprite.tint = tint!; sprite.alpha = Math.min(.22, .22 * near * strength * mote.strength * edge);
    }
  }
  destroy() { this.host.destroy({ children: true }); this.texture?.destroy(true); this.motes = []; }
}
