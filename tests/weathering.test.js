import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWeathering, paintWeathering } from '../src/weathering.ts';
import { weatheredFill, destroyWeathering } from '../src/weathered-fill.ts';

// Only rectangle coverage and the Canvas compositing equations are supplied.
// The helper chooses the material, repeat, clip, order and cached Pixi resources.
// Images have deliberately different RGB/alpha so a brightness-only treatment,
// source-over, a missing mask, or an opaque whole-piece finish all fail.
function canvas(width, height) {
  const c = { width, height, pixels: new Uint8ClampedArray(width * height * 4) }, stack = [];
  const ctx = { canvas: c, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000000', path: [],
    coverage: () => true, patterns: 0, paints: 0,
    save() { stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, fillStyle: this.fillStyle, coverage: this.coverage }); },
    restore() { Object.assign(this, stack.pop()); },
    beginPath() { this.path = []; },
    rect(x, y, width, height) { this.path.push({ x, y, width, height }); },
    clip() {
      const before = this.coverage, path = this.path.slice();
      this.coverage = (x, y) => before(x, y) && path.some(r => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
    },
    createPattern(image, repeat) {
      assert.equal(repeat, 'repeat'); this.patterns++;
      return { image, matrix: null, setTransform(matrix) { this.matrix = matrix; } };
    },
    drawImage(image, x, y) {
      assert.equal(x, 0); assert.equal(y, 0); this.paints++;
      for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) c.pixels.set(image.pixel(px, py), (py * width + px) * 4);
    },
    fillRect(x, y, w, h) {
      this.paints++;
      for (let py = Math.max(0, Math.floor(y)); py < Math.min(height, y + h); py++) for (let px = Math.max(0, Math.floor(x)); px < Math.min(width, x + w); px++) {
        if (!this.coverage(px + .5, py + .5)) continue;
        const style = this.fillStyle, at = (py * width + px) * 4;
        let source;
        if (typeof style === 'string') source = [1, 3, 5].map(i => parseInt(style.slice(i, i + 2), 16)).concat(255);
        else {
          const { a, d } = style.matrix, u = ((Math.floor((px + .5) / a) % 512) + 512) % 512, v = ((Math.floor((py + .5) / d) % 512) + 512) % 512;
          source = style.image.pixel(u, v);
        }
        const sa = source[3] / 255 * this.globalAlpha, da = c.pixels[at + 3] / 255,
          alpha = this.globalCompositeOperation === 'source-atop' ? da : sa + da * (1 - sa),
          factor = this.globalCompositeOperation === 'source-atop' ? da : 1;
        if (!alpha) continue;
        for (let channel = 0; channel < 3; channel++) c.pixels[at + channel] =
          (source[channel] * sa * factor + c.pixels[at + channel] * da * (1 - sa)) / alpha;
        c.pixels[at + 3] = alpha * 255;
      }
    } };
  c.getContext = type => { assert.equal(type, '2d'); return ctx; };
  c.pixel = (x, y) => Array.from(c.pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4));
  return c;
}
const image = rgba => ({ width: 512, height: 512, pixel: typeof rgba === 'function' ? rgba : () => rgba });
const images = () => ({ scuffs: image([198, 206, 211, 128]), oxide: image([130, 53, 24, 192]), earth: image([113, 89, 53, 160]), oil: image([29, 25, 18, 128]) });
function mapsFor(t, source = images()) {
  const made = [], maps = prepareWeathering(source, { createCanvas(w, h) { const c = canvas(w, h); made.push(c); return c; } });
  t.after(() => destroyWeathering(maps));
  return { maps, made, source };
}
const pixel = (c, x, y = 0) => Array.from(c.pixels.slice((y * c.width + x) * 4, (y * c.width + x + 1) * 4));
const profile = more => ({ material: 'steel', chips: 0, rust: 0, dirt: 0, oil: 0, period: 2, ...more });

test('transparent weathering respects native regions, holes, antialiased alpha and the caller state', t => {
  const { maps } = mapsFor(t), c = canvas(6, 1), ctx = c.getContext('2d');
  for (let x = 0; x < c.width; x++) c.pixels.set([80, 100, 120, [255, 96, 0, 255, 1, 255][x]], x * 4);
  ctx.rect(0, 0, 5, 1); const path = ctx.path, before = c.pixels.slice();
  // A previously established geometric exclusion protects an optical window.
  ctx.coverage = x => x < 3; ctx.globalAlpha = .5; ctx.fillStyle = '#abcdef';
  assert(paintWeathering(ctx, maps, { x: 0, y: 0, width: 6, height: 1 }, profile({ rust: .5 })));
  assert.deepEqual(Array.from(c.pixels.filter((_, i) => i % 4 === 3)), [255, 96, 0, 255, 1, 255]);
  assert.deepEqual(pixel(c, 0), [89, 91, 102, 255]);
  assert.deepEqual(pixel(c, 1), [89, 91, 102, 96]);
  for (const x of [2, 3, 4, 5]) assert.deepEqual(pixel(c, x), Array.from(before.slice(x * 4, x * 4 + 4)));
  assert.equal(ctx.globalAlpha, .5); assert.equal(ctx.globalCompositeOperation, 'source-over'); assert.equal(ctx.fillStyle, '#abcdef');
  assert.equal(ctx.path, path, 'the native path remains available for the painter to stroke');
  assert(ctx.coverage(1) && !ctx.coverage(4), 'the caller clip is restored');
});

test('only ferrous surfaces receive oxide, while dirt keeps its authored colour on every material', t => {
  const { maps } = mapsFor(t);
  for (const material of ['steel', 'hha', 'aluminum', 'titanium', 'concrete', 'rubber', 'glass', 'fiberglass', 'ceramic']) {
    const c = canvas(1, 1), ctx = c.getContext('2d'); c.pixels.set([80, 100, 120, 255]); ctx.rect(0, 0, 1, 1);
    const ferrous = ['steel', 'hha'].includes(material);
    assert.equal(paintWeathering(ctx, maps, { x: 0, y: 0, width: 1, height: 1 }, profile({ material, rust: .6 })), ferrous);
    assert.equal(ctx.patterns, ferrous ? 1 : 0);
    assert.equal(pixel(c, 0)[3], 255);
    if (!ferrous) assert.deepEqual(pixel(c, 0), [80, 100, 120, 255]);
    c.pixels.set([80, 100, 120, 255]);
    paintWeathering(ctx, maps, { x: 0, y: 0, width: 1, height: 1 }, profile({ material, dirt: .5 }));
    assert.deepEqual(pixel(c, 0), [90, 97, 99, 255], material);
  }
});

test('each context reuses four patterns with an explicit physical repeat and no new canvases', t => {
  const source = images(); source.scuffs = image((x, y) => [x < 256 ? 220 : 40, y < 256 ? 60 : 180, 90, 255]);
  const { maps, made } = mapsFor(t, source), c = canvas(5, 1), ctx = c.getContext('2d');
  for (let x = 0; x < 5; x++) c.pixels.set([80, 100, 120, 255], x * 4);
  ctx.rect(0, 0, 5, 1);
  paintWeathering(ctx, maps, { x: 0, y: 0, width: 5, height: 1 }, profile({ chips: 1, period: [4, 2] }));
  assert.deepEqual([0, 1, 2, 3, 4].map(x => pixel(c, x)), [[220, 60, 90, 255], [220, 60, 90, 255], [40, 60, 90, 255], [40, 60, 90, 255], [220, 60, 90, 255]]);
  const all = profile({ chips: .1, rust: .1, dirt: .1, oil: .1, period: [8, 3] });
  for (let i = 0; i < 100; i++) paintWeathering(ctx, maps, { x: 0, y: 0, width: 5, height: 1 }, all);
  assert.equal(ctx.patterns, 4); assert.equal(made.length, 4, 'only preparation allocates the four source canvases');
  assert.equal(Object.isFrozen(maps), true); assert.notEqual(maps.scuffs, source.scuffs);
  assert.deepEqual(made, ['scuffs', 'oxide', 'earth', 'oil'].map(name => maps[name]), 'all pattern sources are normalized canvas copies');
  for (const c of made) assert.equal(c.getContext('2d').paints, 1, 'each input is copied once at native size');
  const fresh = canvas(1, 1).getContext('2d'); fresh.rect(0, 0, 1, 1);
  paintWeathering(fresh, maps, { x: 0, y: 0, width: 1, height: 1 }, all);
  assert.equal(fresh.patterns, 4, 'a pattern belongs to its rendering context');
});

test('rigid part families compose once into opaque shared mipmapped fills and release their own textures', t => {
  const { maps, made, source } = mapsFor(t), family = { id: 'arm', color: 0xb19a55, ...profile({ chips: .12, dirt: .3, oil: .05, period: [1.6, .8] }) },
    fill = weatheredFill(maps, family), texture = fill.texture, textureSource = texture.source, c = textureSource.resource;
  assert.deepEqual([c.width, c.height], [512, 512]);
  assert.equal(fill.textureSpace, 'global'); assert.equal(fill.color, 0xffffff);
  assert.equal(fill.matrix.a, 1.6 / 512); assert.equal(fill.matrix.d, .8 / 512);
  assert.equal(textureSource.alphaMode, 'premultiply-alpha-on-upload'); assert(textureSource.autoGenerateMipmaps);
  assert.equal(textureSource.style.addressModeU, 'repeat'); assert.equal(textureSource.style.mipmapFilter, 'linear');
  assert(c.pixels.filter((_, i) => i % 4 === 3).every(alpha => alpha === 255), 'a fill cannot make pinholes in its native polygon');
  assert.notDeepEqual(pixel(c, 0).slice(0, 3), [177, 154, 85]);
  const paints = c.getContext('2d').paints;
  for (let i = 0; i < 100; i++) assert.equal(weatheredFill(maps, { ...family }), fill);
  assert.equal(made.length, 5); assert.equal(c.getContext('2d').paints, paints, 'reuse never composites another canvas');
  assert.throws(() => weatheredFill(maps, { ...family, dirt: .6 }), /cannot change/);
  for (const id of ['bucket', 'mast', 'fourth']) weatheredFill(maps, { ...family, id });
  assert.equal(made.length, 8, 'four setup source canvases plus four fixed family canvases');
  assert.throws(() => weatheredFill(maps, { ...family, id: 'fifth' }), /at most 4/);
  let destroyed = 0; texture.on('destroy', () => destroyed++);
  destroyWeathering(maps); destroyWeathering(maps);
  assert.equal(destroyed, 1); assert.equal(textureSource.resource, null);
  assert.equal(source.scuffs.width, 512, 'asset-loader images are borrowed, not destroyed');
  assert.throws(() => paintWeathering(c.getContext('2d'), maps, { x: 0, y: 0, width: 1, height: 1 }, profile()), /destroyed/);
});

test('preparation identity and explicit input limits prevent accidental stale caches and invalid coordinates', t => {
  const one = mapsFor(t), two = mapsFor(t, one.source);
  assert.notEqual(one.maps.id, two.maps.id);
  assert.throws(() => prepareWeathering({ ...images(), earth: image([0, 0, 0, 0]), scuffs: { width: 256, height: 512 } }), /512/);
  const c = canvas(1, 1), ctx = c.getContext('2d'), bounds = { x: 0, y: 0, width: 1, height: 1 };
  for (const invalid of [undefined, 0, -1, NaN, [1, 0], [1, 2, 3]])
    assert.throws(() => paintWeathering(ctx, one.maps, bounds, profile({ period: invalid })), /period/);
  assert.throws(() => paintWeathering(ctx, one.maps, bounds, profile({ chips: 2 })), /chips/);
  assert.throws(() => paintWeathering(ctx, one.maps, bounds, profile({ material: '' })), /material/);
  assert.throws(() => paintWeathering(ctx, one.maps, { ...bounds, x: NaN }, profile()), /bounds/);
  assert.equal(paintWeathering(ctx, one.maps, bounds, profile()), false); assert.equal(ctx.patterns, 0);
});
