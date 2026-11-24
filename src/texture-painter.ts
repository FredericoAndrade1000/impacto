import type { TexturePaintRequest, TextureMaterials } from './texture-paint.ts';
import type { WeatheringLayer } from './weathering.ts';
export type TextureWorkerMessage = (Omit<TextureMaterials, 'weathering'> & { type: 'init'; weathering: Record<WeatheringLayer, ImageBitmap> })
  | { type: 'paint'; request: TexturePaintRequest };
export type TextureWorkerReply = { type: 'painted'; bitmap: ImageBitmap } | { type: 'error'; message: string; bitmap?: ImageBitmap };
interface PendingPaint { resolve(bitmap: ImageBitmap | null): void; request: TexturePaintRequest; images: ImageBitmap[] }
// One painting at a time, asked for by a visible piece. The renderer owns the
// cache and the decision to keep a result; the worker owns no queue of pieces.
export class TexturePainter {
  declare materials: TextureMaterials | null; declare worker: Worker | null; declare pending: PendingPaint | null; declare available: boolean;
  constructor({ frameSurface, hullSurfaces, wheelSurface, trackSurfaces, radarSurface, weathering }: TextureMaterials = {}) {
    this.materials = { frameSurface, hullSurfaces, wheelSurface, trackSurfaces, radarSurface, weathering };
    this.worker = null; this.pending = null;
    this.available = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
  }
  get busy() { return this.pending !== null; }

  paint(description: TexturePaintRequest): Promise<ImageBitmap | null> {
    if (!this.available || this.busy) return Promise.resolve(null);
    // Snapshot before asynchronous setup; later requests are copied synchronously
    // by postMessage. Requests contain no Pixi objects.
    const request = this.worker ? description : structuredClone(description);
    return new Promise<ImageBitmap | null>(resolve => {
      const pending = this.pending = { resolve, request, images: [] };
      if (!this.worker) void this.start(pending);
      else {
        try { this.worker.postMessage({ type: 'paint', request } satisfies TextureWorkerMessage); }
        catch { this.destroy(); }
      }
    });
  }

  async start(pending: PendingPaint) {
    try {
      const worker = this.worker = new Worker(new URL('./texture-painter-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<TextureWorkerReply>) => {
        if (this.worker !== worker || !this.pending) { data?.bitmap?.close?.(); return; }
        if (data?.type !== 'painted' || !data.bitmap) { data?.bitmap?.close?.(); this.destroy(); return; }
        const done = this.pending; this.pending = null; done.resolve(data.bitmap);
      };
      worker.onerror = worker.onmessageerror = () => { if (this.worker === worker) this.destroy(); };
      const { frameSurface, hullSurfaces, wheelSurface, trackSurfaces, radarSurface, weathering } = this.materials!, images: Partial<Record<WeatheringLayer, ImageBitmap>> = {};
      for (const name of ['scuffs', 'oxide', 'earth', 'oil'] as const) {
        const image = await createImageBitmap(weathering![name]);
        if (this.pending !== pending || this.worker !== worker) { image.close(); return; }
        pending.images.push(image); images[name] = image;
      }
      // The grains are cloned once. Only our four new bitmaps are transferred;
      // the renderer keeps its own canvases and Float32Arrays for the workshop.
      worker.postMessage({ type: 'init', frameSurface, hullSurfaces, wheelSurface, trackSurfaces, radarSurface,
        weathering: { scuffs: images.scuffs!, oxide: images.oxide!, earth: images.earth!, oil: images.oil! } } satisfies TextureWorkerMessage, pending.images);
      pending.images.length = 0; this.materials = null;
      worker.postMessage({ type: 'paint', request: pending.request } satisfies TextureWorkerMessage);
    } catch { if (this.pending === pending) this.destroy(); }
  }

  destroy() {
    this.available = false; this.worker?.terminate(); this.worker = null; this.materials = null;
    const pending = this.pending; this.pending = null;
    if (pending) { for (const image of pending.images) image.close(); pending.images.length = 0; pending.resolve(null); }
  }
}
