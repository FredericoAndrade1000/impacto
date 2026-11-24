import { grainTextures } from '../../src/strata-art.ts';
import { Graphics, Mesh } from 'pixi.js';
import assert from 'node:assert/strict';
import { drawGroundSurface } from '../../src/terrain-art.ts';
import { surfaceGeometry } from '../../src/terrain-surface.ts';
import { anchorGraphics } from '../../src/world-anchor.ts';
import { simplifyGround, outlineError } from '../../src/terrain-lod.ts';
import { headlessPixi } from './headless-pixi.js';
import { RoughGround } from '../../src/terrain.ts';

headlessPixi();

// Check the delivered triangles/colours against an independently drawn source,
// then expose its paint commands for tests of materials and biome transitions.
export function groundInstructions(scene, chunk) {
  const original = scene.local(chunk), step = chunk.step || 0,
    local = step > 0 ? { ...original, points: simplifyGround(original.points, outlineError(step)),
      height: x => scene.terrain.height(x), surface: x => scene.terrain.surface(x), materialAt: x => scene.terrain.materialAt(x) } : original,
    drawing = anchorGraphics(new Graphics(), chunk.left, 0);
  let geometry;
  try {
    drawGroundSurface(local, drawing, step > 0, chunk.overview, step < 0 ? new RoughGround(scene.terrain, chunk.left, chunk.right) : null);
    geometry = surfaceGeometry(drawing.context, scene.terrain, chunk.left);
    assert(chunk.earth instanceof Mesh && !chunk.earth.batched);
    for (const name of ['aPosition', 'aColor', 'aPlace']) assert.deepEqual(chunk.earth.geometry.attributes[name].buffer.data, geometry.attributes[name].buffer.data);
    assert.deepEqual(chunk.earth.geometry.indexBuffer.data, geometry.indexBuffer.data);
    return drawing.context.instructions.slice();
  } finally { geometry?.destroy(true); drawing.destroy({ context: true }); }
}

// Headless scenes supply the same three material inputs as the image loader.
// Neutral samples isolate geometry and lifecycle without a canvas or image file.
export const groundSurfaces = () => Object.fromEntries(['soil', 'rock', 'concrete']
  .map(kind => [kind, new Float32Array(512 * 512).fill(1)]));
export const groundGrains = () => grainTextures(groundSurfaces());
