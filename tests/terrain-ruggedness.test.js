import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Terrain, BIOME_IDS } from '../src/terrain.ts';

test('quiet valleys contain resolved local folds instead of only kilometre-scale hills', () => {
  for (const seed of [0, 1, 6173, 0xffffffff]) {
    const terrain = new Terrain('wet-valley', { seed, length: 16000 }), deviations = [];
    for (let x = terrain.minX + 32; x < terrain.maxX - 32; x += terrain.spacing)
      deviations.push(Math.abs(terrain.height(x) - (terrain.height(x - 16) + terrain.height(x + 16)) / 2));
    deviations.sort((a, b) => a - b);
    const p95 = deviations[Math.floor(deviations.length * .95)];
    assert(p95 > .35 && p95 < .7, `seed ${seed}: local relief ${p95} m must be noticeable without becoming a row of steps`);
  }
});

test('local relief remains smooth enough for contacts at the coarse sampling budget', () => {
  for (const id of BIOME_IDS) for (const seed of [0, 1, 6173, 0xffffffff]) {
    const terrain = new Terrain(id, { seed, length: 16000 });
    let previous = (terrain.points[2].y - terrain.points[1].y) / terrain.spacing;
    for (let i = 2; i < terrain.points.length - 2; i++) {
      const a = terrain.points[i], b = terrain.points[i + 1], grade = (b.y - a.y) / (b.x - a.x);
      assert(Math.abs(grade) < Math.tan(Math.PI / 6), `${id}/${seed}: impassable grade`);
      assert(Math.abs(grade - previous) / terrain.spacing < .04, `${id}/${seed}: a numerical corner replaced the ground`);
      previous = grade;
    }
  }
});

test('roads and concrete slabs retain the physical heights accepted before local relief', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/terrain-protected-sites.json', import.meta.url)));
  let checked = 0;
  for (const row of fixture.cases) {
    const terrain = new Terrain(row.id, { seed: row.seed, length: row.length, center: row.center });
    for (const point of row.points) {
      assert.equal(terrain.height(point.x), point.y, `${row.id}/${row.seed}/${point.kind}`);
      checked++;
    }
  }
  assert(checked >= 50, 'keep independent samples from both kinds of protected ground');
});

test('broad mesa summits remain useful while retaining small physical folds', () => {
  for (const seed of [0, 1, 6173, 0xffffffff]) {
    const terrain = new Terrain('plateau', { seed, length: 16000 }); let fold = 0;
    for (const form of terrain.features.filter(f => f.kind === 'plateau'))
      for (let x = form.peak - form.crest / 2 + 10; x < form.peak + form.crest / 2 - 10; x += 2) {
        assert(Math.abs(terrain.surface(x).slope) < .065);
        fold = Math.max(fold, Math.abs(terrain.height(x) - (terrain.height(x - 8) + terrain.height(x + 8)) / 2));
      }
    assert(fold > .025 && fold < .08, `seed ${seed}: a summit must be neither perfectly flat nor littered with sharp bumps`);
  }
});

test('an explicitly supplied contour remains authoritative over regeneration from its seed', () => {
  const descriptor = new Terrain('world', { seed: 6173, length: 1000, center: 12 }).descriptor(),
    stored = { ...descriptor, points: descriptor.points.map(p => ({ x: p.x, y: Math.fround(p.y + 3) })) },
    imported = Terrain.fromSnapshot(stored);
  assert.deepEqual(imported.points, stored.points);
  assert.deepEqual(imported.sectors, stored.sectors);
  assert.equal(imported.height(stored.points[120].x), stored.points[120].y);
});
