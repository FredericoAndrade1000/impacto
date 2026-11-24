import { context2d } from './canvas-art.ts';
import type { ArtCanvas, ArtContext, CanvasFactory } from './canvas-art.ts';

export type WeatheringLayer = 'scuffs' | 'oxide' | 'earth' | 'oil';
export type WeatheringImages = Record<WeatheringLayer, CanvasImageSource & { readonly width: number; readonly height: number }>;
export type WeatheringMaps = Readonly<Record<WeatheringLayer, ArtCanvas> & { id: number }>;
export interface WeatheringProfile { material: string; period: number | readonly [number, number]; chips?: number; rust?: number; dirt?: number; oil?: number }
export interface WeatheringBounds { x: number; y: number; width: number; height: number }
interface PreparedWeathering { createCanvas: CanvasFactory; patterns: WeakMap<ArtContext, Map<WeatheringLayer, CanvasPattern>> }
export interface FinishedSurface { material: string; period: readonly [number, number]; weights: number[] }

// The side of the square source maps, and of a tile painted from them.
export const WEATHERING_SIZE = 512;
const SIZE = WEATHERING_SIZE;
const LAYERS = [['scuffs', 'chips'], ['oxide', 'rust'], ['earth', 'dirt'], ['oil', 'oil']] as const;
const prepared = new WeakMap<WeatheringMaps, PreparedWeathering>();
let identity = 0;
const domCanvas = (width: number, height: number) => Object.assign(document.createElement('canvas'), { width, height });

// The four Imagegen extractions are colour and transparent coverage, not a
// source of geometry or a way to recognise materials from painted pixels.
// Preparing them belongs to renderer setup, never to a moving piece's draw.
export function prepareWeathering(images: WeatheringImages, { createCanvas = domCanvas }: { createCanvas?: CanvasFactory } = {}): WeatheringMaps {
  for (const [name] of LAYERS) {
    const image = images[name];
    if (image?.width !== SIZE || image?.height !== SIZE) throw Error(`Weathering ${name} must be ${SIZE}×${SIZE}.`);
  }
  // HTMLImageElement patterns can switch Chromium's destination canvas to a
  // different raster backend, changing later native AA even outside our clip.
  // Copy once at setup: every painter uses the same canvas-backed pattern path.
  const copy = (name: WeatheringLayer) => {
    const canvas = createCanvas(SIZE, SIZE);
    context2d(canvas).drawImage(images[name], 0, 0);
    return canvas;
  };
  const maps = Object.freeze({ id: ++identity, scuffs: copy('scuffs'), oxide: copy('oxide'), earth: copy('earth'), oil: copy('oil') });
  prepared.set(maps, { createCanvas, patterns: new WeakMap() });
  return maps;
}

function stateOf(maps: WeatheringMaps) {
  const state = prepared.get(maps);
  if (!state) throw Error('Weathering maps were not prepared or have been destroyed.');
  return state;
}

const periodPair = (value: WeatheringProfile['period']): value is readonly [number, number] => Array.isArray(value);
function finish(profile: WeatheringProfile): FinishedSurface {
  if (typeof profile.material !== 'string' || !profile.material) throw Error('Weathering requires an explicit material.');
  const period: readonly [number, number] = periodPair(profile.period) ? profile.period : [profile.period, profile.period];
  if (period.length !== 2 || period.some(value => !Number.isFinite(value) || value <= 0))
    throw Error('Weathering period must be a positive size in painter coordinates.');
  const weights = LAYERS.map(([, field]) => {
    const weight = profile[field] ?? 0;
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw Error(`Weathering ${field} must be between zero and one.`);
    return field === 'rust' && profile.material !== 'steel' && profile.material !== 'hha' ? 0 : weight;
  });
  return { material: profile.material, period, weights };
}

function paint(ctx: ArtContext, maps: WeatheringMaps, state: PreparedWeathering, bounds: WeatheringBounds, { period, weights }: FinishedSurface) {
  if (!weights.some(Boolean) || !bounds.width || !bounds.height) return false;
  let patterns = state.patterns.get(ctx);
  if (!patterns) state.patterns.set(ctx, patterns = new Map());
  ctx.save();
  try {
    // The current native path is already filled. Its existing clip and every
    // transparent opening remain authoritative; source-atop keeps its alpha.
    ctx.clip(); ctx.globalCompositeOperation = 'source-atop';
    const alpha = ctx.globalAlpha;
    for (const [index, [name]] of LAYERS.entries()) {
      if (!weights[index]) continue;
      let pattern: CanvasPattern | null | undefined = patterns.get(name);
      if (!pattern) {
        pattern = ctx.createPattern(maps[name], 'repeat');
        if (!pattern) throw Error(`Weathering ${name} is not ready to paint.`);
        patterns.set(name, pattern);
      }
      pattern.setTransform({ a: period[0] / SIZE, b: 0, c: 0, d: period[1] / SIZE, e: 0, f: 0 });
      ctx.globalAlpha = alpha * weights[index]!; ctx.fillStyle = pattern;
      ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
  } finally { ctx.restore(); }
  return true;
}

// Bounds and period use the current painter's coordinates, normally metres.
// A number gives a square repeat; [width, height] also supports painters whose
// two axes use different units. Patterns stay anchored at the painter's origin.
// Call after material colour and before lenses, labels, cavities and fittings;
// a later whole-image recolour would also recolour this generated finish.
export function paintWeathering(ctx: ArtContext, maps: WeatheringMaps, bounds: WeatheringBounds, profile: WeatheringProfile) {
  const state = stateOf(maps), surface = finish(profile);
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0)
    throw Error('Weathering bounds must be a finite rectangle.');
  return paint(ctx, maps, state, bounds, surface);
}

// The finish a profile gives on prepared maps, checked: what a shared fill is keyed by (weathered-fill.ts).
export function finishWeathering(maps: WeatheringMaps, profile: WeatheringProfile): FinishedSurface {
  stateOf(maps);
  return finish(profile);
}

// One opaque square of a finish over a colour, the size of the maps and repeating at that size,
// for a renderer that repeats it as a texture (weathered-fill.ts).
export function paintWeatheringTile(maps: WeatheringMaps, color: string, surface: FinishedSurface): ArtCanvas {
  const state = stateOf(maps), canvas = state.createCanvas(SIZE, SIZE), ctx = context2d(canvas);
  ctx.fillStyle = color; ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.beginPath(); ctx.rect(0, 0, SIZE, SIZE);
  paint(ctx, maps, state, { x: 0, y: 0, width: SIZE, height: SIZE }, { ...surface, period: [SIZE, SIZE] });
  return canvas;
}

// Prepared maps are forgotten: painting with them again is refused.
export function releaseWeathering(maps: WeatheringMaps): void {
  prepared.delete(maps);
}
