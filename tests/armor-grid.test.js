import test from 'node:test';
import assert from 'node:assert/strict';
import { gridRegions } from '../src/armor-grid.ts';

const grid = bits => ({ version: 1, nx: 4, ny: 2,
  bounds: { minX: -2, maxX: 2, minY: -.0025, maxY: .0025 }, bits });
test('native little-endian occupancy projects exact five millimetre material and a through hole', () => {
  const data = grid('bb'), regions = gridRegions(data);
  assert.deepEqual(regions, [
    { minX: -2, maxX: 0, minY: -.0025, maxY: .0025 },
    { minX: 1, maxX: 2, minY: -.0025, maxY: .0025 },
  ]);
  assert.equal(gridRegions(data), regions, 'one derived drawing per immutable grid packet');
});
test('partial thickness remains visible without restoring removed cells', () => {
  const boxes = gridRegions(grid('b3'));
  assert.equal(boxes.reduce((sum, b) => sum + (b.maxX - b.minX) * (b.maxY - b.minY), 0), .0125);
  assert.equal(boxes.filter(b => b.minX <= 1.5 && b.maxX >= 1.5 && b.minY <= -.001 && b.maxY >= -.001).length, 0);
});
test('empty and maximum grids have bounded transport and drawing projections', () => {
  assert.deepEqual(gridRegions(grid('00')), []);
  const data = { ...grid(''), nx: 256, ny: 16, bits: 'ff'.repeat(512) };
  assert.equal(data.bits.length, 1024);
  assert.deepEqual(gridRegions(data), [data.bounds]);
  assert.throws(() => gridRegions({ ...data, nx: 257 }), /inválida/);
});
