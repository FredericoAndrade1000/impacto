import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Mesh, Texture } from 'pixi.js';
import { Terrain, BIOME_IDS } from '../src/terrain.ts';
import { plantFlora, plantCover, splitFlora, FOREGROUND_MAX_HEIGHT } from '../src/flora-art.ts';
import { chassisSpec, CHASSIS_GEAR_SCALE } from '../src/chassis.ts';
import { TerrainScene } from '../src/terrain-scene.ts';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();

const walk = root => [root, ...root.children.flatMap(walk)];
const quads = mesh => (mesh?.geometry.indices.length || 0) / 6;
function scene(t, terrain) {
  const earth = new Container(), props = new Container(), art = new TerrainScene(earth, props, { flora: Texture.WHITE });
  art.rebuild(terrain);
  t.after(() => { art.clear(); earth.destroy(); props.destroy(); art.foreground.destroy({ children: true }); });
  return art;
}

test('physical height alone gives every object a stable depth and preserves even small wheel hubs', () => {
  const kinds = ['shrub', 'scrub', 'grass', 'dryGrass', 'greyPebbles', 'ochrePebbles', 'oak', 'snag', 'rock'],
    heights = [.06, .15, .25, .250001, .65, 1.25, 8],
    plants = kinds.flatMap((kind, k) => heights.flatMap((height, i) => [false, true].map(back =>
      ({ kind, x: -70 + k * 4 + i * .5, height, back })))),
    original = structuredClone(plants), { behind, front } = splitFlora(plants);
  assert(front.length > 0 && behind.length > 0);
  assert(front.every(p => p.height <= .25) && behind.every(p => p.height > .25));
  assert.equal(front.length, kinds.length * 3 * 2, 'all low objects go forward, regardless of species or distant-row flag');
  assert(front.some(p => p.height === .25) && behind.some(p => p.height === .250001), 'one physical threshold includes its exact endpoint');
  assert.equal(new Set([...behind, ...front]).size, plants.length, 'each element is drawn in exactly one row');
  assert.equal(behind.length + front.length, plants.length);
  assert.deepEqual(plants, original, 'moving to the foreground changes no size, foot, tint or alpha');
  assert.deepEqual(splitFlora([...plants].reverse()).front, [...front].reverse());
  assert.deepEqual(splitFlora(structuredClone(plants)).front, front);
  assert.deepEqual(splitFlora(plants.map(p => ({ ...p, x: p.x + 120000, seed: 930222, zoom: 200 }))).front.map(p => p.height), front.map(p => p.height),
    'position, map seed and camera annotations cannot change depth');
  const smallestWheel = chassisSpec('wheeled').wheel * CHASSIS_GEAR_SCALE.min;
  assert(FOREGROUND_MAX_HEIGHT < smallestWheel / 2, 'cover cannot reach the hub of the smallest chassis wheel');
});

test('every biome keeps the same plants and small objects, each represented by just one quad', t => {
  for (const id of BIOME_IDS) {
    const terrain = new Terrain(id, { seed: 6173, length: 2000 }), before = terrain.snapshot(), art = scene(t, terrain),
      chunk = art.chunks[Math.floor(art.chunks.length / 2)], index = art.chunks.indexOf(chunk);
    art.paint(chunk); art.plant(chunk); art.detail(chunk);
    const flora = plantFlora(terrain, chunk.left, chunk.right, chunk.biome, index), expected = splitFlora(flora);
    assert.equal(quads(chunk.flora), expected.behind.length);
    assert.equal(quads(chunk.frontFlora), expected.front.length);
    assert.equal(quads(chunk.flora) + quads(chunk.frontFlora), flora.length);
    let front = expected.front.length;
    for (const [i, part] of chunk.details.entries()) {
      const cover = plantCover(art.local(part), part.left, part.right, index * 32 + i), rows = splitFlora(cover);
      assert.equal(quads(part.cover), rows.behind.length);
      assert.equal(quads(part.frontCover), rows.front.length);
      assert.equal(quads(part.cover) + quads(part.frontCover), cover.length);
      if (part.frontCover) assert.equal(part.frontCover.parent, chunk.frontCover);
      front += rows.front.length;
      assert(rows.front.every(p => p.height <= FOREGROUND_MAX_HEIGHT));
      assert(rows.behind.every(p => p.height > FOREGROUND_MAX_HEIGHT));
    }
    assert(front > 5, `${id} has foreground dressing`);
    assert.deepEqual(terrain.snapshot(), before, 'presentation changes no terrain or physical rocks');
  }
});

test('foreground follows chunk and detail culling without rebuilding, then releases all of its buffers', t => {
  const terrain = new Terrain('plateau', { seed: 6173, length: 4000 }), art = scene(t, terrain),
    chunk = art.chunks[Math.floor(art.chunks.length / 2)], x = (chunk.left + chunk.right) / 2,
    camera = { x, y: terrain.height(x) + 2, width: 400, height: 300, zoom: 12 };
  art.paint(chunk); art.plant(chunk); art.detail(chunk);
  art.update(camera, 0);
  assert(chunk.frontCover?.visible);
  const nodes = walk(chunk.frontCover).concat(chunk.frontFlora ? [chunk.frontFlora] : []),
    meshes = nodes.filter(n => n instanceof Mesh), geometries = meshes.map(n => n.geometry),
    buffers = geometries.flatMap(g => g.buffers), versions = buffers.map(b => b._updateID);
  assert(meshes.length > 1);
  for (const [i, offset] of [0, 1, -1, 0].entries()) {
    art.update({ ...camera, x: x + offset }, 100 + i * 100);
    assert.deepEqual(walk(chunk.frontCover).concat(chunk.frontFlora ? [chunk.frontFlora] : []), nodes);
    assert.deepEqual(buffers.map(b => b._updateID), versions, 'panning writes no foreground vertices');
    const half = camera.width / (2 * camera.zoom) + 24;
    for (const part of chunk.details) if (part.frontCover)
      assert.equal(part.frontCover.visible, part.left <= x + offset + half && part.right >= x + offset - half);
  }
  art.update({ ...camera, y: chunk.top + 1000 }, 600);
  assert(!chunk.frontCover.visible && !chunk.frontFlora?.visible, 'vertical culling leaves no foreground ghost');
  art.update({ ...camera, zoom: .08 }, 700);
  assert(!chunk.frontCover.visible && !chunk.frontFlora?.visible, 'switching to overview hides both rows');
  art.update(camera, 800);
  assert(chunk.frontCover.visible);
  assert.deepEqual(walk(chunk.frontCover).concat(chunk.frontFlora ? [chunk.frontFlora] : []), nodes);
  art.forget(chunk);
  assert(nodes.every(n => n.destroyed));
  assert(geometries.every(g => g.buffers === null)); assert(buffers.every(b => b.destroyed));
  assert.equal(Texture.WHITE.destroyed, false, 'shared atlas belongs to the renderer');
  assert.equal(art.layers.frontCover.children.length, 0);
});
