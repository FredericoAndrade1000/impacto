import test from 'node:test';
import assert from 'node:assert/strict';
import { Graphics, Texture } from 'pixi.js';
import { surfaceGeometry, groundPlaces, PIGMENT_CELLS, PIGMENT_PATCHES, PIGMENT_REPEAT } from '../src/terrain-surface.ts';
import { anchorGraphics } from '../src/world-anchor.ts';

test('solid terrain preserves triangle order, local positions and Graphics alpha quantization in separate buffers', () => {
  const x = 162085.10979027036, drawing = anchorGraphics(new Graphics(), x, 0);
  drawing.rect(x, 253, 2, 1).fill({ color: 0x123456, alpha: .16 });
  drawing.rect(x + .5, 253.5, 1, 2).fill({ color: 0xabcdef, alpha: .84 });
  const geometry = surfaceGeometry(drawing.context);
  try {
    const positions = geometry.attributes.aPosition.buffer.data, colors = geometry.attributes.aColor.buffer.data;
    assert.deepEqual(positions, new Float32Array([0, 253, 2, 253, 0, 254, 2, 254, .5, 253.5, 1.5, 253.5, .5, 255.5, 1.5, 255.5]));
    assert.deepEqual(geometry.indexBuffer.data, new Uint32Array([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]));
    assert.deepEqual(colors, new Float32Array([
      ...Array.from({ length: 4 }, () => [0x12 / 255, 0x34 / 255, 0x56 / 255, 40 / 255]).flat(),
      ...Array.from({ length: 4 }, () => [0xab / 255, 0xcd / 255, 0xef / 255, 214 / 255]).flat(),
    ]));
    assert.notEqual(positions.buffer, colors.buffer);
    assert.notEqual(positions.buffer, geometry.indexBuffer.data.buffer);
    assert.deepEqual(Object.keys(geometry.attributes), ['aPosition', 'aColor', 'aPlace']);
    assert.equal(geometry.attributes.aPosition.stride, 8); assert.equal(geometry.attributes.aColor.stride, 16);
    // Drawn with no map, it has no pigment.
    assert.deepEqual(geometry.attributes.aPlace.buffer.data, new Float32Array(32));
    assert.equal(Texture.WHITE.destroyed, false);
  } finally { geometry.destroy(true); drawing.destroy({ context: true }); }
});

test('large surfaces retain indices beyond 16 bits instead of wrapping into unrelated vertices', () => {
  const drawing = new Graphics();
  for (let i = 0; i < 16385; i++) drawing.rect(i * 2, 0, 1, 1).fill(i % 2 ? 0x123456 : 0xabcdef);
  const geometry = surfaceGeometry(drawing.context);
  try {
    assert(geometry.indexBuffer.data instanceof Uint32Array);
    assert.equal(geometry.attributes.aPosition.buffer.data.length, 65540 * 2);
    assert.deepEqual(geometry.indexBuffer.data.slice(-6), new Uint32Array([65536, 65537, 65538, 65537, 65539, 65538]));
  } finally { geometry.destroy(true); drawing.destroy({ context: true }); }
});

test('the solid surface path rejects a pixel-line instruction instead of silently changing its rendering', () => {
  const drawing = new Graphics().moveTo(0, 0).lineTo(1, 0).stroke({ width: 1, pixelLine: true });
  try { assert.throws(() => surfaceGeometry(drawing.context), /solid triangles only/); }
  finally { drawing.destroy({ context: true }); }
});

test('a map point reads the same pigment from either chunk, with small numbers far from the origin', () => {
  // Every lattice repeats a whole number of times in the span a chunk counts its places from.
  for (const [across] of PIGMENT_PATCHES) assert.equal(PIGMENT_REPEAT % (PIGMENT_CELLS * across), 0);
  const terrain = { seed: 6173, height: () => 253, materialAt: () => 'soil' };
  const at = (left, local, y) => groundPlaces(new Float32Array([local, y]), terrain, left);
  for (const x of [-250934, -12, 0, 39736, 162085, 206402]) for (const y of [252, 247, 224]) {
    const a = at(x - 8, 8, y), b = at(x, 0, y), repeats = (a[0] - b[0]) / PIGMENT_REPEAT;
    assert(Math.abs(repeats - Math.round(repeats)) < 1e-6, 'the same map point, up to whole repeats of the lattices');
    assert(b[0] >= 0 && b[0] < PIGMENT_REPEAT && a[0] < PIGMENT_REPEAT + 8);
    assert.deepEqual([...a.slice(1)], [y, 253 - y, 1]);
  }
});

test('concrete near the surface keeps its own colour; under it the earth has pigment again', () => {
  const terrain = { seed: 6173, height: () => 253, materialAt: () => 'concrete' };
  for (const [y, weight] of [[253, 0], [252, 0], [250.8, 1], [151, 1]])
    assert.equal(groundPlaces(new Float32Array([0, y]), terrain, 39736)[3], weight);
});
