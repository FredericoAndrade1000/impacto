import test from 'node:test';
import assert from 'node:assert/strict';
import { baseMaterialTexture, destroyBaseMaterials } from '../src/base-materials.ts';

test('base grain has premultiplied low contrast pixels and continuous repeat boundaries', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), pixels = new Uint8ClampedArray(128 * 128 * 4);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const value = Math.round(128 + Math.sin(x * .43) * 20 + Math.cos(y * .31) * 15);
    pixels.set([value, value, value, 255], (y * 128 + x) * 4);
  }
  let reads = 0;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({
    getContext: () => ({ drawImage() {}, getImageData() { reads++; return { data: pixels }; } }),
  }) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  const texture = baseMaterialTexture({}), data = texture.source.resource, point = (x, y) => [...data.slice((y * 256 + x) * 4, (y * 256 + x + 1) * 4)];
  assert.equal(reads, 1);
  assert.equal(texture.source.alphaMode, 'premultiplied-alpha');
  assert.equal(texture.source.autoGenerateMipmaps, true);
  let changes = 0;
  for (let i = 0; i < data.length; i += 4) {
    assert(data[i] <= data[i + 3] && data[i + 1] <= data[i + 3] && data[i + 2] <= data[i + 3]);
    assert(data[i + 3] <= 31); if (data[i + 3]) changes++;
  }
  assert(changes > 50000);
  for (let i = 0; i < 256; i++) { assert.deepEqual(point(0, i), point(255, i)); assert.deepEqual(point(i, 0), point(i, 255)); }
  destroyBaseMaterials({ paint: { texture } }); assert.equal(texture.destroyed, true);
});
