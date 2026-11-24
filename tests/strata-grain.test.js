import test from 'node:test';
import assert from 'node:assert/strict';
import { grainTextures, GRAIN_PERIODS } from '../src/strata-art.ts';

const SIZE = 512, source = () => new Float32Array(SIZE * SIZE).fill(1),
  surfaces = () => ({ soil: source(), rock: source(), concrete: source() }),
  pixel = (texture, x, y) => Array.from(texture.source.resource.slice((y * SIZE + x) * 4, (y * SIZE + x + 1) * 4));
function materials(t, inputs) {
  const textures = grainTextures(inputs);
  t.after(() => { for (const texture of Object.values(textures)) texture.destroy(true); });
  return textures;
}

test('three shared 512px materials repeat on both axes with correct premultiplied mipmaps', t => {
  const inputs = surfaces(), textures = materials(t, inputs);
  assert.deepEqual(Object.keys(textures), ['soil', 'rock', 'concrete']);
  assert.deepEqual(GRAIN_PERIODS, { soil: 3.2, rock: 4.8, concrete: 2.4 });
  let bytes = 0;
  for (const texture of Object.values(textures)) {
    const source = texture.source; bytes += source.resource.byteLength;
    assert.deepEqual([source.pixelWidth, source.pixelHeight], [512, 512]);
    assert.equal(source.alphaMode, 'premultiplied-alpha'); assert.equal(source.autoGenerateMipmaps, true);
    assert.equal(source.style.addressModeU, 'repeat'); assert.equal(source.style.addressModeV, 'repeat');
    assert.equal(source.style.scaleMode, 'linear'); assert.equal(source.style.mipmapFilter, 'linear');
    assert(source.resource.every(value => value === 0), 'a neutral source leaves the native earth colour unchanged');
  }
  assert.equal(bytes, 3 * 512 * 512 * 4);
  assert(bytes < 1024 * 1024 * 4, 'three square materials use fewer texels than the former depth-scaled atlas');
});

test('source brightness becomes a quiet signed finish without borrowing colour or changing its physical size', t => {
  const inputs = surfaces();
  for (const image of Object.values(inputs)) {
    image[12 * SIZE + 17] = .95; image[13 * SIZE + 17] = 1.05;
    image[14 * SIZE + 17] = .2; image[15 * SIZE + 17] = 1.8;
  }
  const before = structuredClone(inputs), textures = materials(t, inputs);
  for (const kind of ['soil', 'rock']) {
    assert.deepEqual(pixel(textures[kind], 17, 12), [1, 1, 1, 9]);
    assert.deepEqual(pixel(textures[kind], 17, 13), [8, 7, 6, 9]);
    assert.deepEqual(pixel(textures[kind], 17, 14), [2, 3, 3, 26]);
    assert.deepEqual(pixel(textures[kind], 17, 15), [23, 22, 18, 26]);
  }
  assert.deepEqual(pixel(textures.concrete, 17, 12), [1, 1, 1, 9]);
  assert.deepEqual(pixel(textures.concrete, 17, 13), [8, 8, 8, 9]);
  assert.deepEqual(pixel(textures.soil, 18, 12), [0, 0, 0, 0], 'one source texel stays one tile texel');
  assert.deepEqual(inputs, before, 'the original materials remain available to other caches');
  for (const texture of Object.values(textures)) {
    const pixels = texture.source.resource;
    for (let i = 0; i < pixels.length; i += 4) {
      assert(pixels[i + 3] <= 26);
      assert(pixels[i] <= pixels[i + 3] && pixels[i + 1] <= pixels[i + 3] && pixels[i + 2] <= pixels[i + 3], 'every stored channel is premultiplied');
    }
  }
});

test('each material reads its complete square independently and keeps supplied repeat edges continuous', t => {
  const inputs = surfaces();
  for (const [index, image] of Object.values(inputs).entries()) {
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++)
      image[y * SIZE + x] = 1 + Math.sin(x / (SIZE - 1) * Math.PI * 2) * Math.sin(y / (SIZE - 1) * Math.PI * 2) * (.04 + index * .02);
  }
  const first = materials(t, inputs), again = materials(t, inputs);
  for (const kind of Object.keys(inputs)) {
    assert.deepEqual(first[kind].source.resource, again[kind].source.resource);
    for (let i = 0; i < SIZE; i++) {
      assert.deepEqual(pixel(first[kind], i, 0), pixel(first[kind], i, SIZE - 1));
      assert.deepEqual(pixel(first[kind], 0, i), pixel(first[kind], SIZE - 1, i));
    }
  }
  inputs.soil.fill(.9);
  const changed = materials(t, inputs);
  assert.notDeepEqual(changed.soil.source.resource, first.soil.source.resource);
  assert.deepEqual(changed.rock.source.resource, first.rock.source.resource);
  assert.deepEqual(changed.concrete.source.resource, first.concrete.source.resource);
});

test('materials need no Canvas or draw-time preparation and own exactly their three GPU sources', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() { throw Error('unexpected Canvas'); } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  const textures = grainTextures(surfaces()), sources = Object.values(textures).map(texture => texture.source);
  let destroyed = 0;
  for (const source of sources) source.on('destroy', () => destroyed++);
  for (const texture of Object.values(textures)) texture.destroy(true);
  assert.equal(destroyed, 3); assert(sources.every(source => source.resource === null));
  assert.throws(() => grainTextures({ ...surfaces(), soil: new Float32Array(512 * 256) }), /512/);
});
