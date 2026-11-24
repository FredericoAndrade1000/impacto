import { BufferImageSource, Matrix, Texture } from 'pixi.js';
import { context2d } from './canvas-art.ts';
export interface BaseMaterialFill { texture: Texture; matrix: Matrix; textureSpace: 'global' }
export type BaseMaterialKind = keyof typeof MAPS;
export type BaseMaterials = Record<BaseMaterialKind, BaseMaterialFill>;

// Five small shared materials, extracted from individual structure studies.
// The renderer still owns every silhouette, opening, seam and light gradient.
const MAPS = {
  paint: new URL('./assets/base-paint-grain.webp', import.meta.url).href,
  concrete: new URL('./assets/base-concrete-grain.webp', import.meta.url).href,
  canvas: new URL('./assets/base-canvas-grain.webp', import.meta.url).href,
  rubber: new URL('./assets/base-rubber-grain.webp', import.meta.url).href,
  earth: new URL('./assets/base-earth-grain.webp', import.meta.url).href,
};
const SIZE = 256, PERIOD = { paint: 2.4, concrete: 3.2, canvas: 1.8, rubber: 1.6, earth: 4 };

// A signed, quiet grain around the face beneath it. Reflection makes both repeat
// boundaries continuous. Reading and packing happen once, never during drawing.
export function baseMaterialTexture(image: CanvasImageSource) {
  const canvas = Object.assign(document.createElement('canvas'), { width: SIZE / 2, height: SIZE / 2 }),
    ctx = context2d(canvas);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    shades = new Float32Array(pixels.length / 4);
  let mean = 0, variance = 0;
  for (let i = 0; i < shades.length; i++) mean += shades[i] = (pixels[i * 4]! + pixels[i * 4 + 1]! + pixels[i * 4 + 2]!) / 3;
  mean /= shades.length;
  for (const value of shades) variance += (value - mean) ** 2;
  const spread = Math.max(1, Math.sqrt(variance / shades.length)), data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const u = x < SIZE / 2 ? x : SIZE - 1 - x, v = y < SIZE / 2 ? y : SIZE - 1 - y,
      grain = Math.max(-.12, Math.min(.12, (shades[v * SIZE / 2 + u]! - mean) / spread * .035)),
      alpha = Math.round(Math.abs(grain) * 255), color = grain > 0 ? alpha : 0;
    data.set([color, color, color, alpha], (y * SIZE + x) * 4);
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: SIZE, height: SIZE,
    format: 'rgba8unorm', alphaMode: 'premultiplied-alpha', addressMode: 'repeat',
    scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true }) });
}

export async function loadBaseMaterials(): Promise<BaseMaterials> {
  const image = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); return image; };
  const [paint, concrete, canvas, rubber, earth] = await Promise.all([
    image(MAPS.paint), image(MAPS.concrete), image(MAPS.canvas), image(MAPS.rubber), image(MAPS.earth),
  ]);
  const material = (image: CanvasImageSource, period: number): BaseMaterialFill => ({ texture: baseMaterialTexture(image),
    matrix: new Matrix().scale(period / SIZE, period / SIZE), textureSpace: 'global' });
  return { paint: material(paint, PERIOD.paint), concrete: material(concrete, PERIOD.concrete), canvas: material(canvas, PERIOD.canvas),
    rubber: material(rubber, PERIOD.rubber), earth: material(earth, PERIOD.earth) };
}

export function destroyBaseMaterials(materials: BaseMaterials | null | undefined) {
  for (const material of Object.values(materials || {})) material.texture.destroy(true);
}
