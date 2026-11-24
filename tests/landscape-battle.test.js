import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { Renderer } from '../src/render.ts';
import { BATTLE_TERRAIN_IDS, Terrain } from '../src/terrain.ts';
import { predictImpact, snapshotCollisionIndex } from '../src/impact-preview.ts';
import { duel } from './helpers/duel.js';

for (const terrain of BATTLE_TERRAIN_IDS) test(`${terrain}: two distant vehicles settle on its seeded physical surface`, t => {
  const world = duel(t, createConstruction('heavy'), { terrain, mapLength: 2000, seed: 930222, separation: 600, weather: 'mist', visualEvents: false });
  assert.deepEqual([world.terrain.minX, world.terrain.maxX], [-988, 1012]);
  const state = world.snapshot(), ground = new Terrain(state.terrain, state.terrainSettings);
  assert.deepEqual(ground.points, world.terrain.points);
  assert.equal(state.weather, 'mist');
  assert.equal(world.actor('local').facing, 1); assert.equal(world.actor('opponent').facing, -1);
  for (let i = 0; i < 60; i++) world.step();
  assert.equal(world.dynamics.recoveries || 0, 0);
  for (const actor of world.actors) {
    const v = actor.vehicle;
    assert(Number.isFinite(v.x + v.y + v.angle + v.vx + v.vy));
    assert(Math.hypot(v.vx, v.vy) < 5, 'an undriven vehicle must not launch from the initial terrain');
    assert(v.y - ground.height(v.x) < 5);
  }
});

test('terrain presentation is cached by seed, extent and climate instead of being regenerated each frame', () => {
  // The ground, the sky and the ranges behind it are all made by drawTerrain, once for a map and a weather.
  const calls = { terrain: 0, trails: 0 }, renderer = {
    effects: {}, terrain: {}, ready: true,
    drawTerrain() { calls.terrain++; },
    groundTrails: { clear() { calls.trails++; } },
  }, settings = { seed: 6173, length: 1600, center: 12 };
  const set = (s = settings, weather = 'clear') => Renderer.prototype.setTerrain.call(renderer, 'wet-valley', s, weather);
  set(); const first = renderer.ground;
  for (let i = 0; i < 100; i++) set({ ...settings });
  assert.equal(renderer.ground, first); assert.deepEqual(calls, { terrain: 1, trails: 1 });
  set({ ...settings, seed: 930222 }); assert.notDeepEqual(renderer.ground.points, first.points);
  set({ ...settings, seed: 930222, length: 2000 }, 'mist');
  assert.equal(renderer.ground.length, 2000); assert.equal(renderer.weather, 'mist');
  assert.equal(renderer.effects.terrain, renderer.ground);
  assert.deepEqual(calls, { terrain: 3, trails: 3 });
});

test('shot previews hit the active seeded landscape and update after a seed change', () => {
  let index;
  for (const seed of [6173, 930222]) {
    const terrainSettings = { seed, length: 2000, center: 12 }, terrain = 'rural-ridges',
      state = { terrain, terrainSettings, plates: [], modules: [], fragments: [] },
      ground = new Terrain(terrain, terrainSettings), x = 413.2,
      solution = { flightLimit: 45, flight: { model: 'quadratic-drag-v2', mass: .1, caliberMm: 10, family: 'machinegun', dragCoefficient: .30, airDensity: 1.225, scaleHeight: 8500 }, reachable: true, x, y: ground.height(x) + 5, vx: 0, vy: -10, time: 3 };
    index = snapshotCollisionIndex(state, index);
    const hit = predictImpact(state, solution, {}, index);
    assert(hit); assert.equal(hit.owner.type, 'ground');
    assert(Math.abs(hit.y - ground.height(x)) < 1e-8);
    assert.equal(hit.surface, ground.materialAt(x));
  }
});
