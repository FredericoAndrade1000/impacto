import assert from 'node:assert/strict';
import { after } from 'node:test';
import { DOMAdapter } from 'pixi.js';

// These tests inspect real Pixi scene objects and tessellated geometry, not
// raster pixels. Both Pixi's adapter and the application's document must use
// the same Canvas fixture. WebGL stays unavailable, so Pixi's precision probe
// follows its normal no-context path rather than pretending to compile a GPU.
export function headlessPixi() {
  class Context2D {
    constructor(canvas) {
      this.canvas = canvas;
      return new Proxy(this, { get: (target, key) => key in target ? target[key] : () => {} });
    }
    measureText() { return { width: 10, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 }; }
    createLinearGradient() { return { addColorStop() {} }; }
    createRadialGradient() { return { addColorStop() {} }; }
    createPattern() { return { setTransform() {} }; }
    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; }
    getImageData(x, y, width, height) { return this.createImageData(width, height); }
  }
  class Canvas {
    constructor(width = 1, height = 1) { this.width = width; this.height = height; }
    getContext(type) {
      if (type === 'webgl' || type === 'webgl2') return null;
      assert.equal(type, '2d');
      return this.context ??= new Context2D(this);
    }
  }
  const adapter = DOMAdapter.get(), names = ['document', 'HTMLCanvasElement', 'CanvasRenderingContext2D', 'devicePixelRatio'],
    previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    createCanvas = (width, height) => new Canvas(width, height);
  const globals = { HTMLCanvasElement: Canvas, CanvasRenderingContext2D: Context2D, devicePixelRatio: 1,
    document: { createElement(type) { assert.equal(type, 'canvas'); return createCanvas(); } } };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  // Keep a test's specialised Canvas (for example, one recording paint calls)
  // shared by the application and Pixi instead of capturing a second factory.
  DOMAdapter.set({ ...adapter, createCanvas: (width = 1, height = 1) => {
    const canvas = Object.assign(document.createElement('canvas'), { width, height }), getContext = canvas.getContext.bind(canvas);
    canvas.getContext = (type, ...options) => ['webgl', 'webgl2', 'experimental-webgl'].includes(type) ? null : getContext(type, ...options);
    return canvas;
  },
    getCanvasRenderingContext2D: () => CanvasRenderingContext2D });
  after(() => {
    DOMAdapter.set(adapter);
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  });
}
