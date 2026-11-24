import { CanvasSource, Matrix, Texture } from 'pixi.js';
import { WEATHERING_SIZE, finishWeathering, paintWeatheringTile, releaseWeathering } from './weathering.ts';
import type { WeatheringMaps, WeatheringProfile } from './weathering.ts';

// The weathered fills a renderer draws with, kept apart from weathering.ts so that painting
// a finish on a canvas does not load Pixi.
export interface WeatheredFill { texture: Texture; color: number; textureSpace: 'global'; matrix: Matrix }
interface WeatheringFamily extends WeatheringProfile { id: string; color: number }

const MAX_FAMILIES = 4;
const families = new WeakMap<WeatheringMaps, Map<string, { key: string; style: WeatheredFill }>>();

// A handful of fixed rigid-part families can use one opaque, precomposed fill
// each. Do not call this in drawWorkArm or key a family by pose, size or actor.
// Graphics coordinates own the physical repeat (Pixi's global texture space),
// rather than stretching it to each polygon's bounding box. Treat the returned
// style and matrix as shared; a moving segment owns its own matrix copy.
export function weatheredFill(maps: WeatheringMaps, family: WeatheringFamily): WeatheredFill {
  const surface = finishWeathering(maps, family), { id, color } = family;
  if (typeof id !== 'string' || !id) throw Error('Weathering fill requires a fixed family id.');
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) throw Error('Weathering fill requires an RGB colour.');
  let fills = families.get(maps);
  if (!fills) families.set(maps, fills = new Map());
  const key = JSON.stringify([color, surface.material, surface.period, surface.weights]), cached = fills.get(id);
  if (cached) {
    if (cached.key !== key) throw Error(`Weathering family ${id} cannot change its finish.`);
    return cached.style;
  }
  if (fills.size >= MAX_FAMILIES) throw Error(`Weathering supports at most ${MAX_FAMILIES} shared fill families.`);
  const canvas = paintWeatheringTile(maps, '#' + color.toString(16).padStart(6, '0'), surface),
    texture = new Texture({ source: new CanvasSource({ resource: canvas, alphaMode: 'premultiply-alpha-on-upload',
      addressMode: 'repeat', scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true }) }),
    style: WeatheredFill = { texture, color: 0xffffff, textureSpace: 'global',
      matrix: new Matrix().scale(surface.period[0] / WEATHERING_SIZE, surface.period[1] / WEATHERING_SIZE) };
  fills.set(id, { key, style });
  return style;
}

// The renderer owns these fills, including when another view borrows them.
// Release its samplers first. Input images belong to the asset loader.
export function destroyWeathering(maps: WeatheringMaps) {
  for (const { style } of families.get(maps)?.values() ?? []) style.texture.destroy(true);
  families.delete(maps); releaseWeathering(maps);
}
