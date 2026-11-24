import test from 'node:test';
import assert from 'node:assert/strict';
import { hullArtwork } from '../src/hull-art.ts';
import { paintSurfaceMetres } from '../src/textures.ts';

const SIZE = 512, material = () => new Float32Array(SIZE * SIZE).fill(1);
const pixel = (ctx, x, y) => Array.from(ctx.data.subarray((y * ctx.canvas.width + x) * 4, (y * ctx.canvas.width + x + 1) * 4));
// Only the canvas pixel I/O is supplied: the pixels are already painted, not rasterized by a test.
function context(width, height, data = new Uint8ClampedArray(width * height * 4)) {
  return { canvas: { width, height }, data, reads: 0, writes: 0,
    getImageData(...args) { assert.deepEqual(args, [0, 0, width, height]); this.reads++; return { data }; },
    putImageData(image, ...args) { assert.equal(image.data, data); assert.deepEqual(args, [0, 0]); this.writes++; } };
}
function painted(width, height) {
  const ctx = context(width, height);
  for (let i = 0; i < ctx.data.length; i += 4) ctx.data.set([100, 120, 80, 255], i);
  return ctx;
}

test('the hull material multiplies only painted RGB and preserves every alpha byte and transparent pixel', () => {
  const ctx = context(4, 1, new Uint8ClampedArray([100, 120, 80, 255, 77, 88, 99, 0, 250, 10, 100, 85, 3, 5, 7, 1])),
    shades = material();
  shades.set([1.25, .5, 1.3, 1]);
  paintSurfaceMetres(ctx, shades, { width: .02, height: .005 });
  assert.deepEqual(Array.from(ctx.data), [125, 150, 100, 255, 77, 88, 99, 0, 255, 13, 130, 85, 3, 5, 7, 1]);
  assert.equal(ctx.reads, 1); assert.equal(ctx.writes, 1, 'one pixel pass is baked before the texture is cached');
});

test('neutral hull material is an identity for opaque, antialiased and transparent pixels', () => {
  const ctx = context(17, 11), shades = material();
  for (let i = 0; i < ctx.data.length; i++) ctx.data[i] = (i * 31 + (i >> 4)) % 256;
  const original = ctx.data.slice();
  paintSurfaceMetres(ctx, shades, { width: 4.5, height: 2.1, left: 87, bottom: -12 });
  assert.deepEqual(ctx.data, original);
  assert.equal(ctx.reads, 1); assert.equal(ctx.writes, 1);
});

test('large hulls reflect the material in both directions, meeting at the turn and repeat', () => {
  const shades = material(), across = painted(2048, 1), upright = painted(1, 2048);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) shades[y * SIZE + x] = .5 + (x + y) / 2048;
  paintSurfaceMetres(across, shades, { width: 10.24, height: .005 });
  paintSurfaceMetres(upright, shades, { width: .005, height: 10.24 });
  for (let i = 0; i < SIZE; i++) {
    assert.deepEqual(pixel(across, i, 0), pixel(across, 1023 - i, 0));
    assert.deepEqual(pixel(across, i, 0), pixel(across, 1024 + i, 0));
    assert.deepEqual(pixel(across, i, 0), pixel(across, 2047 - i, 0));
    assert.deepEqual(pixel(upright, 0, i), pixel(upright, 0, 1023 - i));
    assert.deepEqual(pixel(upright, 0, i), pixel(upright, 0, 1024 + i));
    assert.deepEqual(pixel(upright, 0, i), pixel(upright, 0, 2047 - i));
  }
  for (const boundary of [511, 1023, 1535]) {
    assert.deepEqual(pixel(across, boundary, 0), pixel(across, boundary + 1, 0));
    assert.deepEqual(pixel(upright, 0, boundary), pixel(upright, 0, boundary + 1));
  }
  assert.notDeepEqual(pixel(across, 0, 0), pixel(across, 511, 0), 'the source is read across, not collapsed to one shade');
  assert.notDeepEqual(pixel(upright, 0, 0), pixel(upright, 0, 511), 'the second axis has its own material variation');
});

test('material scale stays fixed in metres across canvas resolutions and hull bounds, anchored at the foot', () => {
  const shades = material(), small = painted(100, 100), fine = painted(300, 300), large = painted(300, 200);
  shades[11 * SIZE + 25] = .75;
  shades[141 * SIZE + 165] = 1.25;
  paintSurfaceMetres(small, shades, { width: 1, height: 1 });
  paintSurfaceMetres(fine, shades, { width: 1, height: 1 });
  paintSurfaceMetres(large, shades, { width: 3, height: 2 });
  // These pixel centres are the same local points: (.125,.055) and (.825,.705) metres.
  for (const [ctx, points] of [[small, [[12, 94], [82, 29]]], [fine, [[37, 283], [247, 88]]], [large, [[12, 194], [82, 129]]]]) {
    assert.deepEqual(pixel(ctx, ...points[0]), [75, 90, 60, 255]);
    assert.deepEqual(pixel(ctx, ...points[1]), [125, 150, 100, 255]);
  }
  assert.deepEqual(pixel(large, 12, 94), [100, 120, 80, 255], 'a taller hull does not stretch the material down from its roof');
});

test('a cropped machine part keeps the grain of the same pixels in its whole picture', () => {
  const shades = material(), whole = painted(128, 80), part = painted(32, 24), x = 37, top = 19;
  for (let i = 0; i < shades.length; i++) shades[i] = .8 + (i * 37 % 103) / 256;
  paintSurfaceMetres(whole, shades, { width: 128 / 200, height: 80 / 200 });
  paintSurfaceMetres(part, shades, { width: 32 / 200, height: 24 / 200 }, { x, y: 80 - top - 24 });
  for (let v = 0; v < 24; v++) for (let u = 0; u < 32; u++)
    assert.deepEqual(pixel(part, u, v), pixel(whole, x + u, top + v));
});

test('the material is deterministic and local to the translation-invariant hull key without mutating inputs', () => {
  const polygon = [{ x: -2, y: 1 }, { x: 2, y: 1 }, { x: 1.5, y: 3 }, { x: -2, y: 3 }],
    shape = hullArtwork(polygon, 0x68765a, 'outside'), moved = hullArtwork(polygon.map(p => ({ x: p.x + 1000, y: p.y - 400 })), 0x68765a, 'outside'),
    shades = material(), originalShape = structuredClone(shape), originalMoved = structuredClone(moved);
  for (let i = 0; i < shades.length; i++) shades[i] = .9 + (i % 117) / 585;
  const source = shades.slice(), first = painted(73, 39), again = painted(73, 39), translated = painted(73, 39);
  paintSurfaceMetres(first, shades, shape); paintSurfaceMetres(again, shades, shape); paintSurfaceMetres(translated, shades, moved);
  assert.equal(shape.key, moved.key);
  assert.deepEqual(first.data, again.data);
  assert.deepEqual(first.data, translated.data, 'world placement never enters the material coordinates');
  assert.deepEqual(shades, source); assert.deepEqual(shape, originalShape); assert.deepEqual(moved, originalMoved);
});
