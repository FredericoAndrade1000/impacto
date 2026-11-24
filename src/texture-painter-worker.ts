/// <reference lib="webworker" />
import type { TextureMaterials } from './texture-paint.ts';
import type { TextureWorkerMessage, TextureWorkerReply } from './texture-painter.ts';
declare const self: DedicatedWorkerGlobalScope;
import { paintTextureCanvas } from './texture-paint.ts';
import { prepareWeathering } from './weathering.ts';

let materials: TextureMaterials | null = null;
self.onmessage = ({ data }: MessageEvent<TextureWorkerMessage>) => {
  let bitmap: ImageBitmap | null = null;
  try {
    if (data.type === 'init') {
      try {
        materials = { frameSurface: data.frameSurface, hullSurfaces: data.hullSurfaces, wheelSurface: data.wheelSurface, trackSurfaces: data.trackSurfaces, radarSurface: data.radarSurface,
          weathering: prepareWeathering(data.weathering, { createCanvas: (width, height) => new OffscreenCanvas(width, height) }) };
      } finally {
        for (const image of Object.values(data.weathering)) image.close();
      }
      return;
    }
    if (data.type !== 'paint' || !materials) throw Error('Texture painter is not initialized.');
    const picture = paintTextureCanvas(data.request, materials);
    if (!('transferToImageBitmap' in picture)) throw Error('Texture worker requires an OffscreenCanvas.');
    bitmap = picture.transferToImageBitmap();
    self.postMessage({ type: 'painted', bitmap } satisfies TextureWorkerReply, [bitmap]);
    bitmap = null;
  } catch (error) {
    bitmap?.close();
    const message = error != null && (typeof error === 'object' || typeof error === 'function') && 'message' in error ? error.message : error;
    self.postMessage({ type: 'error', message: String(message || error) } satisfies TextureWorkerReply);
  }
};
