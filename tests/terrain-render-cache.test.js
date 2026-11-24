import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render.ts';
import { terrainDrawKey } from '../src/terrain-draw-key.ts';

// Renderer.setTerrain on a renderer that only counts drawings: no Pixi
// application, browser, World or native backend. The ground is the real Terrain.
// Everything a map is seen with (ground, sky, ranges, dust) is made by drawTerrain:
// a frame that brings the same ground and weather again makes none of it.
const profile = () => ({ seed: 6173, length: 1000, center: 12, material: 'soil', minX: 0, maxX: 10, spacing: 10,
  points: [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: 1 }],
  sectors: [{ start: -256, end: 5, surface: 'soil' }, { start: 5, end: 266, surface: 'sand' }] });
const renderer = () => ({ effects: {}, terrain: true, redraws: 0,
  drawTerrain() { this.redraws++; },
  groundTrails: { clear() {} } });
const accept = (r, settings, id = 'wet-valley', weather = 'clear') => Renderer.prototype.setTerrain.call(r, id, settings, weather);

test('equal structured-cloned frames reuse the exact cache and existing drawn ground', () => {
  const r = renderer(), p = profile(); accept(r, p); const key = r.terrainKey, ground = r.ground;
  for (let i = 0; i < 100; i++) accept(r, structuredClone(p));
  assert.equal(r.terrainKey, key); assert.equal(r.ground, ground); assert.equal(r.redraws, 1);
  assert.equal(r.effects.terrain, ground);
  // Another weather over the same ground is another scene, made once.
  for (let i = 0; i < 10; i++) accept(r, structuredClone(p), 'wet-valley', 'mist');
  assert.equal(r.redraws, 2); assert.equal(r.weather, 'mist');
});

test('a changed concrete point redraws despite unchanged seed and descriptor', () => {
  // The inner ends stand on minX and maxX: only their heights move alone.
  for (let i = 0; i < 4; i++) for (const axis of i === 0 || i === 3 ? ['x', 'y'] : ['y']) {
    const r = renderer(), p = profile(); accept(r, p); const next = structuredClone(p);
    next.points[i][axis] += .000001; accept(r, next);
    assert.equal(r.redraws, 2); assert.equal(r.ground.points[i][axis], next.points[i][axis]);
  }
});

test('accepted primitive identity detects same-reference mutations too', () => {
  const r = renderer(), p = profile(); accept(r, p); p.points[1].y += .1; accept(r, p);
  p.sectors[0].surface = 'mud'; accept(r, p); assert.equal(r.redraws, 3);
});

test('sector bounds and surface material each invalidate concrete ground', () => {
  for (const field of ['start', 'end', 'surface']) {
    const r = renderer(), p = profile(); accept(r, p); const next = structuredClone(p);
    next.sectors[1][field] = field === 'surface' ? 'rock' : next.sectors[1][field] + .01;
    accept(r, next); assert.equal(r.redraws, 2);
  }
});

test('global material, bounds and spacing invalidate the concrete drawing', () => {
  for (const field of ['material', 'spacing']) {
    const r = renderer(), p = profile(); accept(r, p); const next = structuredClone(p);
    next[field] = field === 'material' ? 'rock' : next[field] + .01;
    accept(r, next); assert.equal(r.redraws, 2);
  }
  // A bound moves with its point, keeping the only interval within its spacing.
  for (const [field, i] of [['minX', 1], ['maxX', 2]]) {
    const r = renderer(), next = profile(); accept(r, profile());
    next[field] += field === 'maxX' ? -.01 : .01;
    next.points[i].x = next[field]; accept(r, next); assert.equal(r.redraws, 2);
  }
});

test('point/sector counts and concrete-versus-generated identity are distinct', () => {
  const p = profile(), key = terrainDrawKey('wet-valley', p);
  for (const array of ['points', 'sectors']) {
    const next = structuredClone(p); next[array].pop();
    assert.notEqual(terrainDrawKey('wet-valley', next, 'clear', key), key);
  }
  assert.notEqual(terrainDrawKey('wet-valley', { seed: p.seed, length: p.length, center: p.center }, 'clear', key), key);
});

test('descriptor and weather changes retain current generated-terrain behavior', () => {
  const p = { seed: 6173, length: 1000, center: 12 }, key = terrainDrawKey('wet-valley', p);
  for (const field of ['seed', 'length', 'center'])
    assert.notEqual(terrainDrawKey('wet-valley', { ...p, [field]: p[field] + 1 }, 'clear', key), key);
  assert.notEqual(terrainDrawKey('rural-ridges', p, 'clear', key), key);
  assert.notEqual(terrainDrawKey('wet-valley', p, 'mist', key), key);
});

test('irrelevant annotations/features do not redraw; concrete materials remain significant', () => {
  const p = profile(), key = terrainDrawKey('wet-valley', p), next = structuredClone(p);
  next.features = [{ decorative: true }]; next.points[0].annotation = 'not consumed by Terrain';
  assert.equal(terrainDrawKey('wet-valley', next, 'clear', key), key);
});

test('unchanged-frame path does not stringify or build a fresh key', () => {
  const p = profile(), key = terrainDrawKey('wet-valley', p), clone = structuredClone(p), stringify = JSON.stringify;
  JSON.stringify = () => { throw new Error('No per-frame JSON fingerprint allowed'); };
  try { assert.equal(terrainDrawKey('wet-valley', clone, 'clear', key), key); }
  finally { JSON.stringify = stringify; }
});

test('rejected profiles do not commit a cache key or replace previously drawn ground', () => {
  const r = renderer(), p = profile(); accept(r, p); const key = r.terrainKey, ground = r.ground;
  const bad = structuredClone(p); bad.points[1].x += .1;
  for (let i = 0; i < 2; i++) assert.throws(() => accept(r, bad), /Projeção de terreno inválida/);
  assert.equal(r.terrainKey, key); assert.equal(r.ground, ground); assert.equal(r.redraws, 1);
});

test('a snapshot with inconsistent spacing cannot replace the accepted ground or poison its drawing key', () => {
  const r = renderer(), p = profile(); p.spacing = 5; p.points.splice(2, 0, { x: 5, y: .5 });
  accept(r, p);
  const key = r.terrainKey, ground = r.ground, before = ground.height(7.5);
  for (const spacing of [2.5, 10]) {
    assert.throws(() => accept(r, { ...p, spacing }), /Projeção de terreno inválida/);
    assert.equal(r.terrainKey, key); assert.equal(r.ground, ground); assert.equal(r.effects.terrain, ground);
    assert.equal(r.ground.height(7.5), before); assert.equal(r.redraws, 1);
  }
  accept(r, structuredClone(p));
  assert.equal(r.terrainKey, key); assert.equal(r.redraws, 1);
});

test('a long cloned profile is unchanged and its final point remains part of identity', () => {
  const p = profile(); p.points = Array.from({ length: 4096 }, (_, i) => ({ x: i, y: i % 7 }));
  const key = terrainDrawKey('wet-valley', p), clone = structuredClone(p);
  assert.equal(terrainDrawKey('wet-valley', clone, 'clear', key), key);
  clone.points.at(-1).y += 1e-10;
  assert.notEqual(terrainDrawKey('wet-valley', clone, 'clear', key), key);
  assert.equal(key.points.length, 8192);
});
