import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { laboratoryCourse } from './helpers/laboratory-course.js';

test('snapshot spacing must describe the actual grid used by all terrain samplers', () => {
  const terrain = new Terrain('world', { seed: 6173, length: 64000 }), original = terrain.descriptor();
  for (const spacing of [terrain.spacing / 2, terrain.spacing * 2])
    assert.throws(() => Terrain.fromSnapshot({ ...original, spacing }), /Projeção de terreno inválida/);
  for (const change of [
    points => { points[20].x += .01; },
    points => { points.splice(20, 1); },
    points => { points.splice(20, 0, { x: points[20].x - 1, y: points[20].y }); },
  ]) {
    const snapshot = structuredClone(original); change(snapshot.points);
    assert.throws(() => Terrain.fromSnapshot(snapshot), /Projeção de terreno inválida/);
  }
});

test('a final partial interval remains exact when a generated map is restored', () => {
  for (const length of [4097, 8193]) {
    const terrain = new Terrain('world', { seed: 6173, length, center: 12.5 }),
      restored = Terrain.fromSnapshot(structuredClone(terrain.descriptor()));
    assert(terrain.maxX - terrain.points.at(-3).x < terrain.spacing);
    assert.deepEqual(restored.points, terrain.points);
    for (const x of [terrain.minX, terrain.minX + .1, 12.5, terrain.maxX - .1, terrain.maxX]) {
      assert.equal(restored.height(x), terrain.height(x));
      assert.deepEqual(restored.surface(x), terrain.surface(x));
      const start = { x, y: terrain.height(x) + 10 }, end = { x, y: terrain.height(x) - 2 };
      assert.deepEqual(restored.raycast(start, end), terrain.raycast(start, end));
    }
  }
});

test('a last interval longer than its spacing is rejected before sampling it', () => {
  const snapshot = structuredClone(new Terrain('world', { seed: 6173, length: 8193 }).descriptor());
  snapshot.maxX += snapshot.spacing;
  snapshot.points.at(-2).x = snapshot.maxX;
  assert.throws(() => Terrain.fromSnapshot(snapshot), /Projeção de terreno inválida/);
});

test('the exterior support intervals do not have to use the interior sampling grid', () => {
  for (const terrain of [...['flat', 'mixed', 'world'].map(id => new Terrain(id, { seed: 6173, length: 4097 })), laboratoryCourse()]) {
    const snapshot = structuredClone(terrain.descriptor());
    snapshot.points[0].x -= 17.25; snapshot.points.at(-1).x += 31.5;
    const restored = Terrain.fromSnapshot(snapshot);
    assert.equal(restored.height(terrain.minX - 10), terrain.height(terrain.minX - 10));
    assert.equal(restored.height(terrain.maxX + 10), terrain.height(terrain.maxX + 10));
  }
});
