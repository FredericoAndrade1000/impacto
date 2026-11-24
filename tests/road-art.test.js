import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Terrain } from '../src/terrain.ts';
import { plantCover } from '../src/flora-art.ts';
import { TerrainScene } from '../src/terrain-scene.ts';
import { paved, unlike, NO_ROADS } from '../src/roads.ts';
import { headlessPixi } from './helpers/headless-pixi.js';
import { drawRoads } from '../src/road-art.ts';
import { GraphicsRecorder } from './scenery-canvas.js';

headlessPixi();

test('road finish belongs to the static nearby drawing, while working machines and distant roads keep simple bands', () => {
  const terrain = new Terrain('mixed'), before = terrain.snapshot(), roads = paved(NO_ROADS, -15, 15, 'graded'),
    near = new GraphicsRecorder(), working = new GraphicsRecorder(), distant = new GraphicsRecorder();
  drawRoads(near, terrain, roads, -20, 20);
  drawRoads(working, terrain, roads, -20, 20, 0, false);
  drawRoads(distant, terrain, roads, -20, 20, 8);
  assert(near.fills().length > working.fills().length, 'nearby confirmed roads have their sparse finish');
  assert.equal(working.fills().length, distant.fills().length, 'the per-frame work preview has only the base layers');
  assert.deepEqual(terrain.snapshot(), before);
});

test('nothing grows on a road the field lays, and the ground under a new road is drawn again with the road over it', t => {
  const terrain = new Terrain('rural-ridges', { seed: 6173, length: 4000 }), road = paved(NO_ROADS, -50, 50, 'graded');
  assert(plantCover(terrain, -200, 200, 2).some(plant => plant.x >= -50 && plant.x < 50), 'the stretch has its cover before');
  terrain.roads = road;
  const laid = plantCover(terrain, -200, 200, 2);
  assert(laid.length && laid.every(plant => plant.x < -50 || plant.x >= 50), 'and none of it on the road');
  terrain.roads = NO_ROADS;
  const earth = new Container(), props = new Container(), scene = new TerrainScene(earth, props, { flora: Texture.WHITE });
  t.after(() => { scene.clear(); earth.destroy(); props.destroy(); scene.foreground.destroy({ children: true }); });
  scene.rebuild(terrain);
  const camera = { x: 0, y: terrain.height(0), zoom: 20, width: 800, height: 600 }, chunk = scene.chunks.find(c => c.left <= 0 && c.right > 0);
  let now = 1e6;
  const settle = () => { for (let i = 0; i < 40; i++) scene.update(camera, now += 100); };
  settle();
  assert(chunk.details?.some(part => part.fine), 'a near view builds the detail of the ground');
  assert.equal(scene.layers.roads.children.length, 0, 'ground with no road has no drawing of roads');
  // A road is laid: the detail it lies over is built again when seen, and what it had let go only then, nothing of it
  // missing for a frame; the road is drawn over the ground.
  const over = chunk.details.filter(part => part.fine && part.left < 50 && part.right > -50), before = over.map(part => part.fine);
  assert(over.length, 'the road lies over detail built');
  scene.repaved(unlike(terrain.roads, road)); terrain.roads = road;
  assert(over.every((part, i) => part.stale && part.fine === before[i] && !before[i].destroyed), 'kept till it is built again');
  settle();
  assert(over.every((part, i) => !part.stale && part.fine && part.fine !== before[i] && before[i].destroyed), 'the detail is built again');
  assert.equal(scene.layers.roads.children.length, 1); assert(scene.roadArt.context.instructions.length >= 3, 'its two layers and its edge');
  // One laid far off, out of view, is not drawn with it.
  const nearInstructions = scene.roadArt.context.instructions.length;
  const far = paved(road, 3000, 3200, 'asphalt'); scene.repaved(unlike(road, far)); terrain.roads = far;
  settle();
  assert.equal(scene.roadArt.context.instructions.length, nearInstructions, 'a road outside the view adds no drawing or detail');
});
