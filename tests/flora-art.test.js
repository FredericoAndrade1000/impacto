import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, TERRAIN_PROFILES, BIOME_IDS } from '../src/terrain.ts';
import { plantFlora, plantCover, floraGeometry, floraTexture, drawFloraFeet, FLORA_FRAMES, FLORA_SIZE } from '../src/flora-art.ts';
import { NO_ROADS, paved } from '../src/roads.ts';
import { GraphicsRecorder } from './scenery-canvas.js';

// What grows where: the ground a biome plants on, and the kinds it may hold.
const GROWS = { 'wet-valley': ['soil', ['oak', 'alder', 'spruce', 'shrub']], 'rural-ridges': ['soil', ['oak', 'alder', 'poplar', 'shrub']],
  highlands: ['soil', ['spruce', 'pine', 'snag', 'shrub']], 'arid-basin': ['sand', ['scrub', 'shrub', 'snag']], plateau: ['rock', ['scrub', 'shrub', 'snag']] };

for (const id of BIOME_IDS) test(`${id}: its plants follow from the map, stand on its own ground and are footed in it`, () => {
  for (const seed of [0, 6173, 930222]) {
    const terrain = new Terrain(id, { seed, length: 4000 }), before = terrain.snapshot(), [soil, kinds] = GROWS[id];
    let total = 0;
    for (let left = terrain.minX, chunk = 0; left < terrain.maxX; left += 500, chunk++) {
      const right = Math.min(terrain.maxX, left + 500), plants = plantFlora(terrain, left, right, id, chunk);
      assert.deepEqual(plantFlora(terrain, left, right, id, chunk), plants, 'the same stretch grows the same wood');
      assert(plants.length <= 160, 'a stretch of wood is a few dozen quads');
      total += plants.length;
      let front = false;
      for (const plant of plants) {
        assert(plant.x >= left && plant.x < right && plant.x > terrain.minX + 6 && plant.x < terrain.maxX - 6);
        assert.equal(terrain.materialAt(plant.x), soil); assert(kinds.includes(plant.kind), plant.kind);
        assert(plant.height > .4 && plant.height <= 10.01);
        // The ground line is drawn over a plant: no foot shows above it, and none is buried by more than a slope hides.
        assert(plant.y <= terrain.height(plant.x) && plant.y > terrain.height(plant.x) - 1.2, `foot at ${plant.x}`);
        assert(Math.abs(terrain.surface(plant.x).slope) < .5);
        // The row behind is laid first.
        if (!plant.back) front = true; else assert.equal(front, false);
      }
      if (plants.length > 3) assert.notDeepEqual(plantFlora(terrain, left, right, id, chunk + 1).map(p => p.x), plants.map(p => p.x));
    }
    assert(total > 8 && total < 500, `${total} plants on four kilometres`);
    assert.deepEqual(terrain.snapshot(), before, 'plants are paint: the ground is as it was');
  }
});

test('wet and high ground is wooded, dry ground carries scrub, and a test track keeps a pale row behind its lane', () => {
  const count = id => plantFlora(new Terrain(id, { seed: 6173, length: 4000 }), -2000, 2000, id).filter(p => !['shrub', 'scrub'].includes(p.kind)).length;
  assert(count('wet-valley') > 3 * count('arid-basin')); assert(count('highlands') > 3 * count('plateau'));
  for (const id of ['hills', 'mixed', 'sand']) {
    const track = new Terrain(id), plants = plantFlora(track, track.points[0].x, track.points.at(-1).x);
    assert(plants.length > 5 && plants.length < 80);
    assert(plants.every(p => p.back && p.y <= track.height(p.x)), 'what stands by a track is far and pale');
    assert.equal(TERRAIN_PROFILES[id].battle, undefined);
  }
  // Nothing grows on a slab, in mud or on bare rock.
  for (const id of ['flat', 'mud', 'rough']) { const track = new Terrain(id); assert.equal(plantFlora(track, track.points[0].x, track.points.at(-1).x).length, 0); }
});

test('either side of a border of the world the growth of each biome thins out', () => {
  let near = 0, far = 0;
  for (const seed of [1, 6173, 930222]) {
    const world = new Terrain('world', { seed, length: 64000 });
    for (const region of world.biomes.slice(1)) {
      const border = region.start; if (border < world.minX + 200 || border > world.maxX - 200) continue;
      for (const left of [border - 120, border]) for (const plant of plantFlora(world, left, left + 120, world.regionAt(left + 60).id, 3)) {
        const away = Math.abs(plant.x - border);
        if (away < 40) near++; else if (away >= 80) far++;
      }
    }
  }
  assert(far > 40 && near < far / 2, `${near} plants by the borders, ${far} further in`);
});

test('a wood is one quad for each plant, read from its cell of the sheet and measured from the stretch', () => {
  const terrain = new Terrain('highlands', { seed: 6173, length: 4000 }), plants = plantFlora(terrain, 0, 500, 'highlands', 2),
    origin = { x: 0, y: Math.round(terrain.height(0)) }, quads = floraGeometry(plants, origin, terrain.seed),
    rise = { spruce: 236, pine: 236, oak: 226, alder: 236, poplar: 238, shrub: 118, scrub: 124, snag: 226 };
  assert(plants.length > 10);
  assert.equal(quads.positions.length, plants.length * 8); assert.equal(quads.uvs.length, plants.length * 8); assert.equal(quads.indices.length, plants.length * 6);
  for (const [i, plant] of plants.entries()) {
    const p = quads.positions.subarray(i * 8, i * 8 + 8), uv = quads.uvs.subarray(i * 8, i * 8 + 8), size = p[5] - p[1];
    assert(Math.abs((p[0] + p[2]) / 2 - (plant.x - origin.x)) < 1e-3, 'a plant is centred on its foot');
    assert((p[2] - p[0]) / size >= .83 && (p[2] - p[0]) / size <= 1.17, 'proportions vary without extreme stretching');
    assert(Math.abs(p[4] - p[0]) <= plant.height * .036, 'the crown leans only slightly');
    // The figure in the cell is as tall as the plant, standing a few rows above the foot of the cell.
    assert(Math.abs(size * rise[plant.kind] / 256 - plant.height) < 1e-3);
    assert(Math.abs(p[1] + origin.y + size * 6 / 256 - plant.y) < 1e-3);
    const tile = FLORA_FRAMES[plant.kind + (plant.back ? '-far' : '')], us = [uv[0], uv[2]].sort((a, b) => a - b);
    assert(us[0] > tile.x / FLORA_SIZE.width && us[1] < (tile.x + tile.size) / FLORA_SIZE.width &&
      uv[5] > tile.y / FLORA_SIZE.height && uv[1] < (tile.y + tile.size) / FLORA_SIZE.height, 'no texel of a neighbouring frame is read');
    assert.equal(uv[0] > uv[2], plant.flip); assert(uv[1] > uv[5], 'the foot of the cell is at the foot of the quad');
    assert.equal(tile.size, plant.back ? 128 : ['shrub', 'scrub'].includes(plant.kind) ? 256 : 512);
    assert.deepEqual(Array.from(quads.indices.subarray(i * 6, i * 6 + 6)), [0, 1, 2, 2, 1, 3].map(k => i * 4 + k));
  }
  assert(quads.positions.every(v => Number.isFinite(v) && Math.abs(v) < 1000), 'corners stay small numbers anywhere on a long map');
  assert.deepEqual(floraGeometry([], origin, terrain.seed).indices.length, 0);
});

test('plant shape and light stay anchored to the world with the same atlas, height and four corners', () => {
  const plants = ['oak', 'grass', 'greyPebbles'].map((kind, i) => ({ kind, x: -94071.5 + i, y: 73, height: i ? .2 : 7, back: false, flip: false })),
    a = floraGeometry(plants, { x: -94100, y: 70 }, 6173), b = floraGeometry(plants, { x: -94000, y: 70 }, 6173);
  assert.deepEqual(a.uvs, b.uvs); assert.deepEqual(a.colors, b.colors); assert.deepEqual(a.indices, b.indices);
  assert.equal(a.positions.length, plants.length * 8); assert.equal(a.colors.length, plants.length * 16);
  for (let i = 0; i < a.positions.length; i += 2) assert(Math.abs(a.positions[i] - b.positions[i] - 100) < 1e-4);
  for (let i = 0; i < a.colors.length; i += 4) {
    assert.equal(a.colors[i + 3], 1, 'atlas alpha is preserved');
    for (let channel = 0; channel < 3; channel++) assert(a.colors[i + channel] >= .8 && a.colors[i + channel] <= 1.11);
  }
  assert.notDeepEqual(a.colors, floraGeometry(plants, { x: -94100, y: 70 }, 930222).colors);
});

test('every plant uses the same prepared image, with mipmaps and no canvas repaint', () => {
  const image = { width: 2048, height: 1024 }, texture = floraTexture(image);
  try {
    assert.equal(texture.source.resource, image, 'the admitted atlas is used directly');
    assert.equal(texture.source.uploadMethodId, 'image');
    assert.deepEqual([texture.source.pixelWidth, texture.source.pixelHeight], [2048, 1024]);
    assert.equal(texture.source.autoGenerateMipmaps, true, 'distant foliage reads the correct mip level');
    assert.equal(texture.source.scaleMode, 'linear');
    assert.equal(texture.source.style.mipmapFilter, 'linear');
  } finally { texture.destroy(true); }
});

test('plant contact shade stays shallow and below the ground without modifying the plants or terrain', () => {
  const terrain = new Terrain('highlands', { seed: 6173, length: 2000 }), before = terrain.snapshot(),
    plants = ['oak', 'grass', 'greyPebbles'].map((kind, i) => ({ kind, x: 12 + i * 4, y: terrain.height(12 + i * 4), height: i ? .2 : 7 })),
    original = structuredClone(plants), g = new GraphicsRecorder();
  drawFloraFeet(g, plants, terrain);
  assert(g.fills().length > 0);
  for (const { points, style } of g.fills()) {
    assert(style.alpha <= .2 && !style.texture, 'contact is quiet solid paint in the existing drawing');
    for (let i = 0; i < points.length; i += 2) {
      const depth = terrain.height(points[i]) - points[i + 1];
      assert(depth >= 0 && depth <= .08, 'contact shade does not cover the scenery or vehicles');
    }
  }
  assert.deepEqual(plants, original); assert.deepEqual(terrain.snapshot(), before);
});

test('ground cover is seeded, footed on each surface and absent from roads and concrete', () => {
  for (const id of BIOME_IDS) {
    const terrain = new Terrain(id, { seed: 6173, length: 4000 }), before = terrain.snapshot(), plants = plantCover(terrain, -200, 200, 2);
    assert.deepEqual(plantCover(terrain, -200, 200, 2), plants); assert(plants.length > 5 && plants.length < 1200);
    for (const plant of plants) {
      assert(plant.height <= .9 && plant.height >= .06); assert(plant.y <= terrain.height(plant.x));
      assert.notEqual(terrain.materialAt(plant.x), 'concrete');
      assert(!terrain.features.some(f => f.kind === 'road' && plant.x >= f.start && plant.x < f.end));
      if (id === 'arid-basin' || id === 'plateau') assert(['dryGrass', 'ochrePebbles', 'scrub'].includes(plant.kind));
    }
    assert.deepEqual(terrain.snapshot(), before);
  }
  const concrete = new Terrain('flat'); assert.equal(plantCover(concrete, -10, 10).length, 0);
});

// A machine making a road shows it made ahead of what the field laid (road-machine-motion.ts): what stood there goes as
// it comes, and nothing else may move.
test('a road laid later takes the cover that stood on it, and moves none of what stands beside it', () => {
  for (const id of BIOME_IDS) {
    const terrain = new Terrain(id, { seed: 6173, length: 4000 }), plants = plantCover(terrain, -200, 200, 2);
    terrain.roads = paved(paved(NO_ROADS, -60, -20, 'graded'), 30, 95.5, 'asphalt');
    const off = plants.filter(plant => !(plant.x >= -60 && plant.x < -20) && !(plant.x >= 30 && plant.x < 95.5));
    assert(off.length < plants.length, id);
    assert.deepEqual(plantCover(terrain, -200, 200, 2), off, id);
    terrain.roads = NO_ROADS;
  }
});

test('low cover keeps dry biomes dry in a mixed world, including plants among plateau rocks', () => {
  const world = new Terrain('world', { seed: 6173, length: 64000 }), before = world.snapshot();
  for (const id of ['arid-basin', 'plateau']) {
    const region = world.biomes.find(r => r.id === id && r.start > world.minX && r.end < world.maxX),
      x = (region.start + region.end) / 2, plants = plantCover(world, x - 100, x + 100, 7);
    assert(plants.length > 10);
    assert(plants.every(p => ['dryGrass', 'ochrePebbles', 'scrub'].includes(p.kind)));
    assert(plants.some(p => p.kind === 'dryGrass'), id + ' needs low plants as well as stones');
  }
  assert.deepEqual(world.snapshot(), before);
});
