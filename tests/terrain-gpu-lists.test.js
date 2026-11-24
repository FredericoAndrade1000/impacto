import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Mesh, Texture } from 'pixi.js';
import { Terrain } from '../src/terrain.ts';
import { TerrainScene, BUMPS_ZOOM } from '../src/terrain-scene.ts';
import { paved, NO_ROADS } from '../src/roads.ts';
import { groundGrains } from './helpers/ground-art.js';

// What the earth hands the GPU is to be read the same by every make of GPU: corners that are all finite numbers, and
// lists of 32-bit indices, each within the corners of its mesh. A 16-bit list of the surface held an odd number of
// indices in most chunks, its size no whole number of 4-byte words; on a Radeon the surface showed as fans from the
// ground down to sea level under the left end of a chunk, the look of corners read past the end of their list.
test('every mesh of the earth hands the GPU finite corners and 32-bit lists within them, at every scale of the view', t => {
  const terrain = new Terrain('world', { seed: 6173, length: 64000 }), from = terrain.minX + 1000;
  terrain.roads = paved(paved(NO_ROADS, from + 300, from + 2300, 'graded'), from + 2300, from + 6000, 'asphalt');
  const roots = [new Container(), new Container()], grains = groundGrains(),
    scene = new TerrainScene(...roots, { grains, flora: Texture.WHITE });
  scene.rebuild(terrain);
  t.after(() => { scene.clear(); for (const root of roots) root.destroy(); for (const texture of Object.values(grains)) texture.destroy(true); });
  const meshes = node => [...(node instanceof Mesh ? [node] : []), ...node.children.flatMap(meshes)];
  let surfaces = 0, odd = 0;
  for (const zoom of [.05, .11, .3, 1, 4, BUMPS_ZOOM * 1.5]) for (const x of [from + 400, from + 2300, from + 5000]) {
    const camera = { x, y: terrain.height(x) + 20, width: 1600, height: 518, zoom };
    // Enough frames for the view to settle on its scale and its detail.
    for (let frame = 0; frame < 60; frame++) scene.update(camera, frame * 100);
    for (const mesh of roots.flatMap(meshes).filter(mesh => mesh.visible && mesh.geometry.indexBuffer)) {
      const positions = mesh.geometry.getBuffer('aPosition').data, indices = mesh.geometry.indexBuffer.data, corners = positions.length / 2;
      assert(indices instanceof Uint32Array, `${mesh.label}: a list of ${indices.constructor.name}`);
      assert(positions.every(Number.isFinite), `${mesh.label}: a corner that is not finite`);
      let top = 0; for (const k of indices) if (k > top) top = k;
      assert(top < corners, `${mesh.label}: index ${top} past ${corners} corners`);
      if (mesh.label === 'Ground surface') { surfaces++; if (indices.length % 2) odd++; }
    }
  }
  // The surfaces the lists of odd length were drawn for are still there, and drawn by 32-bit lists.
  assert(surfaces > 50 && odd > 10, `${odd} of ${surfaces} surfaces with an odd number of indices`);
});
