import test from 'node:test';
import assert from 'node:assert/strict';
import { FillGradient, Texture } from 'pixi.js';
import { AIR, recede, hazedStyle, HazedGraphics, hazedPicture } from '../src/haze.ts';

const rgb = color => [color >> 16 & 255, color >> 8 & 255, color & 255];
const saturation = color => { const c = rgb(color); return Math.max(...c) - Math.min(...c); };
const distance = (a, b) => Math.hypot(...rgb(a).map((c, i) => c - rgb(b)[i]));
const luma = color => { const [r, g, b] = rgb(color); return .299 * r + .587 * g + .114 * b; };

test('what stands behind the vehicles is a little greyer and a little nearer the pale of the air', () => {
  for (const color of [0x4f6b32, 0x8a6a3a, 0x3d4a52, 0xb9cc8b]) {
    const far = recede(color);
    assert(saturation(far) < saturation(color), `${color.toString(16)} is greyer`);
    assert(distance(far, AIR) < distance(color, AIR), 'and nearer the air');
    assert(saturation(far) > saturation(color) * .4, 'only a little: its colour is still told');
  }
  assert(Math.abs(luma(recede(0xf2f2f2)) - luma(recede(0x101010))) < .85 * (0xf2 - 0x10), 'its contrast is lower');
  assert.equal(recede(0x4f6b32, 0), 0x4f6b32);
  assert(saturation(recede(0x4f6b32, .5)) > saturation(recede(0x4f6b32)), 'through half the haze, half as grey');
});

test('the works behind the vehicles are drawn in the receded colours, their gradients made once and their pictures kept', () => {
  const works = new HazedGraphics();
  works.rect(0, 0, 1, 1).fill(0x4f6b32).rect(1, 0, 1, 1).fill({ color: 0x8a6a3a, alpha: .5 }).rect(2, 0, 1, 1).stroke({ color: 0x3d4a52, width: .1 });
  const [first, second, line] = works.context.instructions.map(instruction => instruction.data.style);
  assert.deepEqual([first.color, second.color, second.alpha, line.color], [recede(0x4f6b32), recede(0x8a6a3a), .5, recede(0x3d4a52)]);
  const gradient = new FillGradient({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, colorStops: [{ offset: 0, color: 0x4f6b32 }, { offset: 1, color: '#8a6a3a80' }] }),
    hazed = hazedStyle(gradient);
  assert.equal(hazedStyle(gradient), hazed, 'a gradient is receded once');
  assert.deepEqual(hazed.colorStops.map(stop => stop.color), [`#${recede(0x4f6b32).toString(16).padStart(6, '0')}ff`, `#${recede(0x8a6a3a).toString(16).padStart(6, '0')}80`]);
  const painted = { texture: Texture.WHITE, color: 0x4f6b32 };
  assert.equal(hazedStyle(painted), painted, 'a picture keeps the colours and the sharpness it was painted with');
  works.destroy();
});

test('the trees behind are painted once on a picture of their own, their clear pixels left clear', t => {
  const pixels = new Uint8ClampedArray([0x4f, 0x6b, 0x32, 255, 0x4f, 0x6b, 0x32, 0, 0x8a, 0x6a, 0x3a, 128]);
  let put = null;
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: () => ({ getContext: () => ({
    drawImage() {}, getImageData: () => ({ data: pixels }), putImageData: image => { put = image; } }) }) } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  const picture = hazedPicture({ width: 3, height: 1 }, .5);
  assert.deepEqual([picture.width, picture.height], [3, 1]);
  assert.deepEqual([...put.data], [...rgb(recede(0x4f6b32, .5)), 255, 0x4f, 0x6b, 0x32, 0, ...rgb(recede(0x8a6a3a, .5)), 128]);
});
