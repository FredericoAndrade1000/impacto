import { context2d } from './canvas-art.ts';
import type { ArtCanvas } from './canvas-art.ts';
// A soft, fixed daylight shared by the cached paint and its ground contact.
// The finish is painted once by the existing worker (or its synchronous path),
// on the same canvas. It adds no texture, filter, light list or render pass.
export const MAIN_LIGHT = Object.freeze({
  color: 0xffefcf,
  shadow: 0x18232e,
  contactPixels: 7,
  contactDepth: .08,
  contactAlpha: .58,
  contactSoftness: .4,
  contactCore: .32,
});

const rgba = (color: number, alpha: number) => `rgba(${color >> 16 & 255},${color >> 8 & 255},${color & 255},${alpha})`;

// The upper surface receives warm daylight; the lower surface keeps a little
// of the cool ambient shade. source-atop preserves holes and antialiased edges.
// Wheel paint is excluded: its existing stationary shade must not rotate with it.
export function paintMainLight<T extends ArtCanvas>(canvas: T): T {
  const ctx = context2d(canvas), { width, height } = canvas;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  const light = ctx.createLinearGradient(0, 0, 0, height);
  light.addColorStop(0, rgba(MAIN_LIGHT.color, .24));
  light.addColorStop(.2, rgba(MAIN_LIGHT.color, .12));
  light.addColorStop(.45, rgba(MAIN_LIGHT.color, 0));
  light.addColorStop(.7, rgba(MAIN_LIGHT.shadow, .14));
  light.addColorStop(1, rgba(MAIN_LIGHT.shadow, .4));
  ctx.fillStyle = light; ctx.fillRect(0, 0, width, height); ctx.restore();
  return canvas;
}
