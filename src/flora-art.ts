import type { TerrainPaintGround } from './terrain-art.ts';
import type { Graphics, ImageResource } from 'pixi.js';
import type { Point } from './math.ts';
import type { Terrain } from './terrain.ts';
interface FloraFrame { x: number; y: number; size: number; rise: number; foot: number }
export interface Plant extends Point { height: number; kind: string; back: boolean; flip: boolean }
interface Growth { ground: string[]; wooded: number; gap: [number, number]; open: [number, number]; tall: [number, number]; kinds: [string, number][] }
import { ImageSource, Texture } from 'pixi.js';
import { Random, lineNoise } from './math.ts';
import { TERRAIN_PROFILES, WORLD_BLEND } from './terrain.ts';
import { roadAt } from './roads.ts';

// One atlas: six 512px trees, two 256px shrubs, eight small hazed copies,
// and four ground-cover sprites. Large originals keep their detail nearby;
// their distant copies and the low plants fit in the same 2048×1024 image.
export const FLORA_SIZE = Object.freeze({ width: 2048, height: 1024 });
const rises: Record<string, number> = { spruce: 236, pine: 236, oak: 226, alder: 236, poplar: 238, shrub: 118, scrub: 124, snag: 226 }, frames: Record<string, FloraFrame> = {};
const frame = (x: number, y: number, size: number, rise: number) => Object.freeze({ x, y, size, rise: rise * size / 256, foot: 250 * size / 256 });
['spruce', 'pine', 'oak', 'alder', 'poplar', 'snag'].forEach((kind, i) => { frames[kind] = frame(i % 3 * 512, Math.floor(i / 3) * 512, 512, rises[kind]!); });
frames.shrub = frame(1536, 0, 256, rises.shrub!); frames.scrub = frame(1792, 0, 256, rises.scrub!);
Object.keys(rises).forEach((kind, i) => { frames[kind + '-far'] = frame(1536 + i % 4 * 128, 256 + Math.floor(i / 4) * 128, 128, rises[kind]!); });
['grass', 'dryGrass', 'greyPebbles', 'ochrePebbles'].forEach((kind, i) => { frames[kind] = frame(1536 + i % 2 * 256, 512 + Math.floor(i / 2) * 256, 256, i < 2 ? 112 : 64); });
export const FLORA_FRAMES = Object.freeze(frames);

export function floraTexture(image?: ImageResource) {
  return new Texture({ source: new ImageSource({ ...(image === undefined ? {} : { resource: image }), ...FLORA_SIZE,
    scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true }) });
}

// Cover up to 25 cm stands in front of the lane; anything taller stays behind.
// This is below the axle of the smallest chassis wheel. Depth follows only the
// object's physical height, and is decided once when its stretch is prepared.
export const FOREGROUND_MAX_HEIGHT = .25;
export function splitFlora<T extends Pick<Plant, 'height'>>(plants: readonly T[]) {
  const behind: T[] = [], front: T[] = [];
  for (const plant of plants) (plant.height <= FOREGROUND_MAX_HEIGHT ? front : behind).push(plant);
  return { behind, front };
}

// Low dressing follows the actual surface and never grows across a road, one
// the field has laid or not, or a slab. It is prepared with each visible detail section, on the plant atlas. What would
// grow at each place is worked out whether it grows there or not: a road laid later takes what stood on it, and moves
// nothing that stands beside it.
export function plantCover(terrain: TerrainPaintGround, left: number, right: number, salt = 0): Plant[] {
  const random = new Random((terrain.seed ^ 0x51ed270b ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0), plants: Plant[] = [];
  for (let x = left + random.range(.1, .6), gap = 1; x < right; x += gap) {
    const biome = terrain.regionAt?.(x)?.id || terrain.id, dry = biome === 'arid-basin' || biome === 'plateau',
      material = terrain.materialAt(x), road = terrain.features?.some(f => f.kind === 'road' && x >= f.start && x < f.end) ||
        terrain.roads && roadAt(terrain.roads, x);
    gap = random.range(dry ? .55 : .3, dry ? 1.65 : .95);
    const patch = .7 * lineNoise(terrain.seed, 91, x / 9) + .3 * lineNoise(terrain.seed, 92, x / 2),
      bare = random.next() > (dry ? .3 : .6) + patch * .6,
      stone = random.next() < (material === 'rock' || material === 'gravel' ? .6 : dry ? .28 : .08),
      shrub = !stone && random.next() < (dry ? .12 : .2),
      kind = stone ? (dry || material === 'sand' ? 'ochrePebbles' : 'greyPebbles') : shrub ? (dry ? 'scrub' : 'shrub') : dry || material === 'sand' ? 'dryGrass' : 'grass',
      height = stone ? random.range(.06, .15) : shrub ? random.range(.3, dry ? .65 : .9) : random.range(.15, dry ? .42 : .65),
      sparse = !stone && material === 'sand' && random.next() > .65, flip = random.next() < .5;
    if (material === 'concrete' || road || bare || sparse) continue;
    const half = height * (stone ? 1.8 : 1),
      y = Math.min(terrain.height(x - half), terrain.height(x), terrain.height(x + half)) - height * (stone ? .56 : .09);
    plants.push({ x, y, height, kind, back: false, flip });
  }
  return plants;
}

// A little shade in the earth anchors a plant without a sprite, blur or extra
// layer. Roads are painted above this existing detail drawing, including the
// temporary surface under a working machine, so no separate invalidation is needed.
export function drawFloraFeet(g: Graphics, plants: readonly Plant[], terrain: Pick<TerrainPaintGround, 'height'>) {
  for (const plant of plants) {
    // The grass atlas already shades its buried base. Another subpixel patch
    // under every blade adds preparation cost without a useful visible footprint.
    if (plant.kind === 'grass' || plant.kind === 'dryGrass') continue;
    const stone = plant.kind.endsWith('Pebbles'), wide = Math.min(.62, Math.max(.045, plant.height * (stone ? .95 : plant.height > 1 ? .09 : .25))),
      depth = Math.min(.075, wide * .22), x = plant.x,
      at = (dx: number, down: number): [number, number] => [x + dx, terrain.height(x + dx) - down];
    g.poly([...at(-wide, .012), ...at(-wide * .18, .004), ...at(wide * .85, .009),
      ...at(wide, depth * .45), ...at(wide * .2, depth), ...at(-wide * .72, depth * .7)])
      .fill({ color: 0x27362b, alpha: stone || plant.height > 1 ? .2 : .12 });
  }
}

// What grows in each biome: on which ground, how much of it is wooded, how far apart the plants stand in
// a wood and in the open, how tall the trees are, and the share of each kind.
const GROWTH: Readonly<Record<string, Growth | undefined>> = Object.freeze({
  'wet-valley': { ground: ['soil'], wooded: .6, gap: [3.5, 8], open: [26, 60], tall: [4.5, 8.5], kinds: [['oak', .34], ['alder', .34], ['spruce', .14], ['shrub', .18]] },
  'rural-ridges': { ground: ['soil'], wooded: .32, gap: [5, 11], open: [22, 52], tall: [4.5, 8], kinds: [['oak', .44], ['alder', .16], ['poplar', .24], ['shrub', .16]] },
  highlands: { ground: ['soil'], wooded: .52, gap: [3.5, 7.5], open: [30, 70], tall: [5.5, 10], kinds: [['spruce', .5], ['pine', .32], ['snag', .06], ['shrub', .12]] },
  'arid-basin': { ground: ['sand'], wooded: .2, gap: [9, 22], open: [40, 110], tall: [3, 4.5], kinds: [['scrub', .8], ['shrub', .12], ['snag', .08]] },
  plateau: { ground: ['rock'], wooded: .26, gap: [9, 24], open: [36, 90], tall: [3, 4.5], kinds: [['scrub', .56], ['shrub', .38], ['snag', .06]] },
});
const TRACK_GROWTH: Record<string, string | undefined> = { soil: 'rural-ridges', rock: 'highlands', mud: 'wet-valley', sand: 'arid-basin' };
const LOW: Record<string, [number, number] | undefined> = { shrub: [.8, 1.7], scrub: [.6, 1.4] };

// The plants of a stretch of ground: where each stands, how tall, of which kind, and whether in the row
// behind. It follows from the map and the stretch alone, so every player sees the same wood.
export function plantFlora(terrain: TerrainPaintGround, left: number, right: number, biome = terrain.id, salt = 0): Plant[] {
  const scenic = TERRAIN_PROFILES[terrain.id]?.battle, growth = GROWTH[scenic ? biome : TRACK_GROWTH[TERRAIN_PROFILES[terrain.id]?.surface] ?? ''];
  if (!growth) return [];
  const random = new Random((terrain.seed ^ 0x3c6ef372 ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0), plants: Plant[] = [],
    region = scenic && terrain.biomes ? terrain.regionAt!((left + right) / 2) : null,
    fits = (x: number) => growth.ground.includes(terrain.materialAt(x)) && Math.abs(terrain.surface(x).slope) < .5 && x > terrain.minX + 6 && x < terrain.maxX - 6,
    pick = () => { let at = random.next(); for (const [kind, share] of growth.kinds) if ((at -= share) < 0) return kind; return growth.kinds[0]![0]; },
    plant = (x: number, back: boolean, tall: number) => {
      // Smoothly gather existing slots into stands and open the spaces between.
      // The displacement fades at chunk ends and never moves a plant onto unsuitable ground.
      const shifted = x + (scenic ? 9 * (2 * lineNoise(terrain.seed, 74, x / 31) - 1) * Math.min(1, (x - left) / 16, (right - x) / 16) : 0);
      if (scenic && fits(shifted)) x = shifted;
      const kind = pick(), low = LOW[kind], stature = scenic ? .88 + .12 * lineNoise(terrain.seed, 75, x / 37) : 1,
        height = (low ? random.range(...low) : tall) * (back ? .8 : 1) * stature, half = height * (low ? .5 : .12),
        // A foot on the lower side of a slope, and a little under it: the ground line hides the rest.
        y = Math.min(terrain.height(x - half), terrain.height(x), terrain.height(x + half)) - height * .03;
      plants.push({ x, y, height, kind, back, flip: random.next() < .5 });
    };
  if (!scenic) {
    // A test track keeps the sparse row it always had behind its lane and beyond its ends, all of it pale.
    const spots = [-42, -36, -32, 18, 25.5, 29, 32, 43.5, 80.5, 85, 89, 93];
    for (let x = terrain.minX + 14; x < terrain.maxX - 4; x += 24) if (x < -64 || x > 96) spots.push(x);
    for (const x of spots) if (x >= left && x < right && growth.ground.includes(terrain.materialAt(x))) plant(x, true, random.range(3.2, 5.6));
    return plants;
  }
  for (let x = left + random.range(0, growth.gap[1]); x < right;) {
    const wooded = .5 * lineNoise(terrain.seed, 71, x / 170) + .35 * lineNoise(terrain.seed, 72, x / 47) + .15 * lineNoise(terrain.seed, 73, x / 13) > 1 - growth.wooded * .5 - .27,
      // Either side of a border of the world the growth of each biome thins out to nothing.
      own = region ? Math.min(1, (x - region.start) / WORLD_BLEND, (region.end - x) / WORLD_BLEND) : 1;
    if (fits(x) && random.next() < own) plant(x, random.next() < .45, random.range(...growth.tall));
    x += random.range(...(wooded ? growth.gap : growth.open));
  }
  // The row behind is laid first, so the nearer trees stand over it.
  return plants.sort((a, b) => Number(b.back) - Number(a.back));
}

// The quads of those plants, measured from `origin` so single precision holds them anywhere on a long map.
export function floraGeometry(plants: readonly Plant[], origin: Point, seed: number) {
  const positions = new Float32Array(plants.length * 8), uvs = new Float32Array(plants.length * 8),
    colors = new Float32Array(plants.length * 16), roots = new Float32Array(plants.length * 16), indices = new Uint32Array(plants.length * 6), { width, height } = FLORA_SIZE;
  plants.forEach((plant, i) => {
    const kind = FLORA_FRAMES[plant.kind + (plant.back ? '-far' : '')]!, size = plant.height * kind.size / kind.rise,
      stone = plant.kind.endsWith('Pebbles'), shape = lineNoise(seed, 181, plant.x * 3.7) * 2 - 1,
      tone = lineNoise(seed, 182, plant.x / 13) * 2 - 1,
      half = size * (1 + shape * (stone ? .24 : .16)) / 2,
      lean = stone ? 0 : plant.height * .035 * (lineNoise(seed, 183, plant.x * 2.1) * 2 - 1),
      foot = plant.y - size * (kind.size - kind.foot) / kind.size, x = plant.x - origin.x, y = foot - origin.y,
      u0 = (kind.x + 1.5) / width, u1 = (kind.x + kind.size - 1.5) / width,
      v0 = (kind.y + 1.5) / height, v1 = (kind.y + kind.size - 1.5) / height,
      near = plant.flip ? u1 : u0, far = plant.flip ? u0 : u1,
      flex = stone ? 0 : plant.kind === 'grass' || plant.kind === 'dryGrass' ? .65 : plant.height < 2 ? .28 : .035,
      phase = lineNoise(seed, 184, plant.x) * Math.PI * 2;
    // Shape and light are prepared once, on the same four corners. The foot,
    // height, atlas cell and plant count stay put; moving the camera does no work.
    positions.set([x - half, y, x + half, y, x - half + lean, y + size, x + half + lean, y + size], i * 8);
    for (let corner = 0; corner < 4; corner++) {
      const light = (corner < 2 ? .88 : 1.03) + tone * .045, warm = tone * .025;
      colors.set([light + warm, light, light - warm, 1], i * 16 + corner * 4);
      roots.set([x, y, corner < 2 ? 0 : plant.height * flex, phase], i * 16 + corner * 4);
    }
    uvs.set([near, v1, far, v1, near, v0, far, v0], i * 8);
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  });
  return { positions, uvs, colors, roots, indices };
}

// At a distant scale neighbouring crowns overlap within a couple of pixels. Keep the highest crown of each
// eight-metre cell in each depth row, in its original order and place; isolated shrubs remain represented too.
export function coarseFloraIndices(plants: readonly Plant[]) {
  const tops = new Map<string, number>();
  plants.forEach((plant, i) => {
    const cell = `${Math.floor(plant.x / 8)}:${Number(plant.back)}`, previous = tops.get(cell);
    if (previous === undefined || plant.y + plant.height > plants[previous]!.y + plants[previous]!.height) tops.set(cell, i);
  });
  const kept = new Set(tops.values()), indices = new Uint32Array(kept.size * 6);
  let at = 0;
  plants.forEach((_, i) => { if (kept.has(i)) { indices.set([i*4,i*4+1,i*4+2,i*4+2,i*4+1,i*4+3], at); at += 6; } });
  return indices;
}
