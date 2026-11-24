import assert from 'node:assert/strict';

// A canvas that only counts what is asked of it, standing in for the browser's while a test runs.
// Textures, meshes and sprites made over it are real Pixi objects, so the tests of the scenery cover
// when something is painted and when its source is released, without drawing a pixel.
export function countingCanvas(t) {
  const counters = { canvases: 0, paints: 0 }, paint = () => { counters.paints++; },
    gradient = () => { paint(); return { addColorStop: paint }; };
  const context = () => {
    const ctx = { createLinearGradient: gradient, createRadialGradient: gradient };
    for (const method of ['save', 'restore', 'translate', 'scale', 'rect', 'fillRect', 'beginPath', 'moveTo', 'lineTo',
      'quadraticCurveTo', 'bezierCurveTo', 'closePath', 'fill', 'clip', 'stroke', 'ellipse', 'arc', 'drawImage', 'roundRect', 'fillText']) ctx[method] = paint;
    ctx.measureText = text => ({ width: String(text).length * 60 });
    return ctx;
  };
  class Canvas {
    width = 1; height = 1;
    getContext(type) {
      // Pixi probes shader precision once. This fixture has no GPU; its canvas
      // allocation is still counted, separately from actual 2D raster work.
      if (type === 'webgl') return null;
      assert.equal(type, '2d'); return this.context ??= { ...context(), canvas: this };
    }
  }
  const create = () => { counters.canvases++; return new Canvas(); },
    old = ['document', 'HTMLCanvasElement'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'HTMLCanvasElement', { value: Canvas, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true,
    value: { createElement(type) { assert.equal(type, 'canvas'); return create(); } } });
  t.after(() => { for (const [name, descriptor] of old) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  return { counters, canvas: create };
}

// Graphics as a list of what was asked of it, for art that is drawn as paths: and, of a batch of quads
// (shot-quads.ts), the corners and the places in its texture of each quad asked of it.
export class GraphicsRecorder {
  constructor() { this.calls = []; }
  clear() { this.calls = []; return this; }
  // Every outline filled, with the fill that followed it.
  fills() {
    return this.calls.flatMap((call, i) => call[0] === 'poly' && this.calls[i + 1]?.[0] === 'fill' ? [{ points: call[1], style: this.calls[i + 1][1] }] : []);
  }
}
for (const name of ['poly', 'fill', 'stroke', 'moveTo', 'lineTo', 'ellipse', 'rect', 'roundRect', 'circle', 'quadraticCurveTo', 'quad', 'save', 'restore', 'transform', 'texture'])
  GraphicsRecorder.prototype[name] = function (...args) { this.calls.push([name, ...args]); return this; };
