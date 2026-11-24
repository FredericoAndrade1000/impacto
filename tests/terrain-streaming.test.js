import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Mesh, Texture, GpuGraphicsContext, buildContextBatches } from 'pixi.js';
import { Terrain } from '../src/terrain.ts';
import { TerrainScene, ROUGH, BUMPS_ZOOM, WIDE_ZOOM, WIDE_EXIT_ZOOM } from '../src/terrain-scene.ts';
import { simplifyGround, terrainStep } from '../src/terrain-lod.ts';
import { buildSoilGrain, buildStrata } from '../src/strata-art.ts';
import { groundGrains } from './helpers/ground-art.js';

// The farthest view the short stretches draw, at LOD8: zoomed out from nearer, under where the whole outline ends and over
// where the stretches of a kilometre take over.
const FAR = (WIDE_ZOOM + WIDE_EXIT_ZOOM) / 2;
// A screen wide enough for that view to hold more short stretches than are kept out of view.
const WIDEST = 6400;

function scene(t, terrain = new Terrain('world', { seed: 6173, length: 64000 })) {
  const roots = [new Container(), new Container()], grains = groundGrains(),
    scene = new TerrainScene(...roots, { grains, flora: Texture.WHITE });
  scene.rebuild(terrain);
  t.after(() => {
    scene.clear(); for (const root of roots) root.destroy();
    for (const texture of Object.values(grains)) { assert.equal(texture.destroyed, false); texture.destroy(true); }
  });
  return scene;
}
const tiles = scene => scene.chunks.flatMap(chunk => chunk.details || []).filter(tile => tile.fine);
const meshes = part => part ? [...(part instanceof Mesh ? [part] : []), ...part.children.flatMap(meshes)] : [];
const grainBinding = (group, parts, textures) => {
  const used = Object.entries(parts).filter(([, part]) => part.indices.length);
  assert.equal(group.children.length, used.length);
  for (const [i, [kind, part]] of used.entries()) {
    const mesh = group.children[i];
    assert(mesh instanceof Mesh); assert.equal(mesh.texture, textures[kind]);
    assert.equal(mesh.geometry.batchMode, 'no-batch');
    assert.deepEqual(mesh.geometry.positions, part.positions); assert.deepEqual(mesh.geometry.uvs, part.uvs);
    assert.deepEqual(mesh.geometry.indices, part.indices); assert.deepEqual([mesh.x, mesh.y], [0, 0]);
  }
};
const resources = scene => {
  const parts = [], visit = part => { parts.push(part); for (const child of part.children) visit(child); };
  visit(scene.earth); visit(scene.props);
  const geometries = parts.filter(part => part.geometry).map(part => part.geometry);
  return { parts, geometries, buffers: geometries.flatMap(geometry => geometry.buffers) };
};

test('distant silhouettes keep every crest within a quarter of a pixel and retain exact seam endpoints', () => {
  for (const id of ['highlands', 'plateau', 'world']) {
    const ground = new Terrain(id, { seed: 6173, length: 16000 }), original = structuredClone(ground.points);
    for (const zoom of [.1249, .4999]) {
      const error = terrainStep(zoom) / 16, points = simplifyGround(ground.points, error);
      assert(points.length < ground.points.length / 2);
      assert.equal(points[0], ground.points[0]); assert.equal(points.at(-1), ground.points.at(-1));
      let at = 0;
      for (const point of ground.points) {
        while (at < points.length - 2 && points[at + 1].x < point.x) at++;
        const a = points[at], b = points[at + 1], y = a.y + (point.x - a.x) * (b.y - a.y) / (b.x - a.x);
        assert(Math.abs(y - point.y) * zoom <= .25 + 1e-8);
      }
    }
    assert.deepEqual(ground.points, original);
  }
  const peak = [{ x: 0, y: 0 }, { x: 1, y: 8 }, { x: 2, y: 0 }];
  assert.deepEqual(simplifyGround(peak, 1), peak);
});

test('a cold nearby view prepares one detail tile per frame, waits during a fast drag and finishes after it stops', t => {
  const ground = new Terrain('world', { seed: 6173, length: 64000 }), art = scene(t, ground),
    camera = { x: 12, y: ground.height(12) + 20, width: 1400, height: 900, zoom: 3 };
  let count = 0;
  for (let frame = 0; frame < 18; frame++) {
    art.update(camera, frame * 16);
    const made = tiles(art).length;
    assert(made >= count && made - count <= 1); count = made;
  }
  assert(count > 5);
  for (let frame = 0; frame < 6; frame++) {
    camera.x += 260; camera.y = ground.height(camera.x) + 20; art.update(camera, 300 + frame * 16);
    assert.equal(tiles(art).length, count, 'a rapidly passing tile is not prepared');
  }
  art.update(camera, 440); assert.equal(tiles(art).length, count);
  art.update(camera, 451); assert.equal(tiles(art).length, count + 1);
  for (let frame = 0; frame < 20; frame++) art.update(camera, 470 + frame * 16);
  const half = camera.width / (2 * camera.zoom) + 24;
  for (const chunk of art.chunks.filter(chunk => chunk.earth?.visible))
    assert(chunk.details.every(tile => tile.right < camera.x - half || tile.left > camera.x + half || tile.fine));
});

test('crossing a real biome border keeps continuous local base meshes and reuses them on return', t => {
  const ground = new Terrain('world', { seed: 6173, length: 64000, center: 99999.5 }), art = scene(t, ground),
    border = ground.biomes.filter(region => region.end > ground.minX + 1000 && region.end < ground.maxX - 1000).at(-1).end,
    before = structuredClone(ground.descriptor()), kept = new Map(), paint = art.paint.bind(art);
  let longestPrepared = 0;
  art.paint = (chunk, ...args) => {
    if (!chunk.earth) longestPrepared = Math.max(longestPrepared, chunk.right - chunk.left);
    return paint(chunk, ...args);
  };
  for (const [frame, offset] of [-240, -90, -2, 0, 2, 90, 240, 0, -240].entries()) {
    const x = border + offset, camera = { x, y: ground.height(x) + 6, width: 936, height: 618, zoom: 24 };
    art.update(camera, frame * 16);
    const visible = art.chunks.filter(chunk => chunk.earth?.visible), half = camera.width / camera.zoom / 2;
    assert(visible.length > 0 && visible[0].left <= x - half && visible.at(-1).right >= x + half, 'the complete view has a base immediately, even during the drag');
    for (const [i, chunk] of visible.entries()) {
      if (i) assert.equal(visible[i - 1].right, chunk.left, 'neighbouring bases leave no gap');
      assert.equal(chunk.biome, ground.biomeAt((chunk.left + chunk.right) / 2));
      assert.equal(chunk.strata.geometry.batchMode, 'no-batch');
      assert.deepEqual([chunk.earth.x, chunk.strata.x], [chunk.left, chunk.left]);
      const points = chunk.earth.geometry.attributes.aPosition.buffer.data;
      assert(points.filter((_, at) => !(at % 2)).every(localX => Math.abs(localX) < 160), 'the GPU keeps short local coordinates far from the world origin');
      const meshes = [chunk.earth, chunk.strata];
      if (kept.has(chunk)) assert.deepEqual(meshes, kept.get(chunk)); else kept.set(chunk, meshes);
    }
  }
  assert(longestPrepared > 0 && longestPrepared < 160, 'a cold entry prepares a short base rather than half a kilometre');
  assert.deepEqual(ground.descriptor(), before);
});

test('far and near ground keep their own buffers and switch immediately after warming', t => {
  const art = scene(t), ground = art.terrain, before = ground.snapshot(), camera = { x: 12, width: 1000, zoom: FAR };
  art.update(camera, 0);
  const chunk = art.chunks.find(chunk => chunk.left <= 12 && chunk.right >= 12), mesh = chunk.strata,
    corners = mesh.geometry.positions.length, buffers = [...mesh.geometry.buffers];
  art.update({ ...camera, zoom: 16 }, 100);
  for (let frame = 0; frame < 3; frame++) art.update({ ...camera, zoom: 16 }, 171 + frame * 16);
  assert(chunk.strata.geometry.positions.length > corners * 1.5); assert(!mesh.destroyed);
  assert(buffers.every(buffer => !buffer.destroyed)); assert.equal(chunk.step, ROUGH, 'so near, the ground is drawn with its bumps');
  const kept = chunk.strata;
  art.update(camera, 240); assert.equal(chunk.strata, mesh); assert.equal(chunk.step, 8);
  art.update({ ...camera, zoom: 16 }, 241); assert.equal(chunk.strata, kept);
  art.update(camera, 242); assert.equal(chunk.strata, mesh);
  assert.equal(chunk.bases.size, 2); assert.deepEqual(ground.snapshot(), before);
});

test('missing terrain scales share a one-chunk budget after zooming stops, then cached scales switch during motion', t => {
  const art = scene(t), camera = { x: 12, width: 1000, zoom: FAR },
    count = () => art.chunks.reduce((sum, chunk) => sum + (chunk.bases?.size || 0), 0);
  art.update(camera, 0);
  camera.zoom = .6; art.update(camera, 100);
  let previous = count();
  art.update(camera, 169); assert.equal(count(), previous, 'a fast zoom waits before preparing another scale');
  for (let frame = 0; frame < 32; frame++) {
    art.update(camera, 171 + frame * 16);
    const made = count(); assert(made - previous <= 1); previous = made;
  }
  assert(art.chunks.filter(chunk => chunk.earth?.visible).every(chunk => chunk.step === 0));
  const warmed = count();
  for (let frame = 0; frame < 10; frame++) {
    camera.zoom = frame % 2 ? .6 : FAR; art.update(camera, 800 + frame);
    assert.equal(count(), warmed);
    assert(art.chunks.filter(chunk => chunk.earth?.visible).every(chunk => chunk.step === terrainStep(camera.zoom)));
  }
});

test('near, far, pan and return reuse all three scales without duplicating grain, flora or detail, and release every scale', t => {
  const art = scene(t), ground = art.terrain,
    chunk = art.chunks.find(chunk => chunk.left > ground.minX + 1000 && ground.materialAt((chunk.left + chunk.right) / 2) === 'soil'),
    x = (chunk.left + chunk.right) / 2, camera = { x, width: 40, zoom: 16 };
  art.update(camera, 0);
  const close = chunk.strata, grain = chunk.grain, flora = chunk.flora, detail = chunk.fine;
  const stones = chunk.stones;
  assert(stones?.children.length === 2, 'native stones and their finish are separate compact meshes');
  assert.equal(stones.parent, art.layers.surface);
  assert.equal(stones.parent.getChildIndex(stones), stones.parent.getChildIndex(chunk.earth) + 1,
    'shallow stones are drawn after the soil bands that previously hid them');
  assert.equal(stones.children[0].texture, art.tones); assert.equal(stones.children[1].texture, art.art.grains.rock);
  assert.deepEqual([stones.x, stones.y], [chunk.left, 0]);
  camera.zoom = FAR; art.update(camera, 100); art.update(camera, 171);
  const far = chunk.strata; assert.equal(chunk.step, 8);
  assert(far.geometry.positions.length < close.geometry.positions.length / 1.5);
  camera.x += 60; art.update(camera, 200); assert.equal(chunk.strata, far);
  camera.x = x; camera.zoom = 16; art.update(camera, 201); assert.equal(chunk.strata, close);
  assert.equal(chunk.stones, stones, 'returning to the prepared scale restores its original stones');
  // The whole outline lies over the same strata as the surface with its bumps, on an earth of its own.
  camera.zoom = 1; art.update(camera, 300); art.update(camera, 371);
  assert.equal(chunk.step, 0); const middle = chunk.strata; assert.equal(middle, close); assert.notEqual(chunk.earth, chunk.bases.get(ROUGH).earth);
  for (let frame = 0; frame < 12; frame++) {
    camera.zoom = [16, FAR, 1][frame % 3]; art.update(camera, 400 + frame);
    assert.equal(chunk.strata, [close, far, middle][frame % 3]);
    assert.equal([...chunk.bases.values()].filter(base => base.earth.visible).length, 1);
    assert.equal(new Set([...chunk.bases.values()].filter(base => base.strata.visible).map(base => base.strata)).size, 1);
    assert.equal(chunk.grain, grain); assert.equal(chunk.flora, flora); assert.equal(chunk.fine, detail);
  }
  assert.equal(chunk.bases.size, 3); assert.equal(art.layers.grain.children.length, art.painted);
  art.detail(chunk);
  assert(chunk.soil.children.length > 1, 'multiple tiles own separate material containers');
  grainBinding(grain, buildStrata(art.plan, chunk.left, chunk.right, art.floor).grain, art.art.grains);
  for (const part of chunk.details.filter(part => part.soil)) {
    assert.deepEqual([part.soil.x, part.soil.y], [part.left - chunk.left, 0]);
    grainBinding(part.soil, buildSoilGrain(art.local(part, true), part.left, part.right), art.art.grains);
  }
  const bases = [...chunk.bases.values()], owned = [...bases.map(base => base.strata), ...bases.flatMap(base => meshes(base.stones)),
    ...[grain, chunk.soil, chunk.flora, chunk.frontFlora, chunk.frontCover, chunk.props].flatMap(meshes)],
    geometries = owned.map(mesh => mesh.geometry), buffers = geometries.flatMap(geometry => geometry.buffers);
  art.forget(chunk);
  assert(bases.every(base => !base.earth && !base.strata)); assert(owned.every(mesh => mesh.destroyed));
  assert(geometries.every(geometry => geometry.buffers === null)); assert(buffers.every(buffer => buffer.destroyed));
  assert(detail.destroyed); assert(!flora || flora.destroyed); assert.equal(Texture.WHITE.destroyed, false);
});

test('coarsening takes the single optional preparation slot and progresses during a continuous fast drag', t => {
  const art = scene(t), camera = { x: 12, width: 1600, zoom: FAR };
  art.update(camera, 0);
  const initial = art.chunks.filter(chunk => chunk.earth?.visible);
  for (const chunk of initial) art.paint(chunk, 0);
  // Only full-resolution bases remain cached, as after arriving nearby without visiting this scale.
  for (const chunk of initial) {
    const coarse = chunk.bases.get(8);
    art.release(coarse, 'earth'); art.release(coarse, 'strata'); chunk.bases.delete(8);
  }
  const added = [], paint = art.paint.bind(art);
  art.paint = (chunk, step) => {
    if (chunk.earth && !chunk.bases.has(step)) added.push(step);
    return paint(chunk, step);
  };
  let previous = 0;
  for (let frame = 0; frame < 6; frame++) {
    camera.x = frame % 2 ? 12 : 1012;
    art.update(camera, 100 + frame * 16);
    assert(art.refineAfter > 100 + frame * 16, 'the camera remains in the fast-drag cooldown');
    assert.equal(added.length - previous, 1); assert.equal(added.at(-1), 8); previous = added.length;
    assert.equal(tiles(art).length, 0);
  }
  assert(added.length > 1);
  for (let frame = 0; frame < 6; frame++) {
    art.update(camera, 300 + frame * 16);
    assert.equal(added.length - previous, 1, 'settling does not grant a second optional preparation'); previous = added.length;
  }
  assert(initial.some(chunk => chunk.earth && chunk.step === 8 && chunk.bases.has(0) &&
    chunk.strata.geometry.positions.length < chunk.bases.get(0).strata.geometry.positions.length / 1.5));
});

test('every cached terrain scale keeps its coordinates near the chunk anchor far from the world origin', t => {
  const ground = new Terrain('world', { seed: 6173, length: 64000, center: 99999.5 }), art = scene(t, ground),
    chunk = art.chunks.find(chunk => chunk.left <= 127000.375 && chunk.right >= 127000.375);
  for (const step of [0, 8, 32]) {
    art.paint(chunk, step);
    assert.equal(chunk.earth.x, chunk.left); assert.equal(chunk.strata.x, chunk.left);
    const xs = chunk.earth.geometry.attributes.aPosition.buffer.data.filter((_, i) => i % 2 === 0);
    assert(xs.length > 0 && xs.every(x => Math.abs(x) < 520));
    assert(chunk.strata.geometry.positions.filter((_, i) => i % 2 === 0).every(x => Math.abs(x) < 520));
  }
  assert.equal(chunk.bases.size, 3);
});

test('a far view wider than the twelve kilometres kept finds the ground it showed a moment ago painted when dragged back', t => {
  const art = scene(t, new Terrain('world', { seed: 6173, length: 128000 })), camera = { x: 12, width: WIDEST, zoom: FAR };
  art.update(camera, 0);
  const shown = art.chunks.filter(chunk => chunk.earth?.visible), meshes = shown.map(chunk => chunk.strata), paint = art.paint.bind(art);
  assert(shown.length > 96);
  let paints = 0;
  art.paint = (...args) => { paints++; return paint(...args); };
  camera.x += camera.width / camera.zoom; art.update(camera, 16);
  assert(paints >= shown.length / 2, 'the ground of the next view is painted');
  paints = 0; camera.x = 12; art.update(camera, 32);
  assert.equal(paints, 0, 'nothing of the first view was let go');
  assert.deepEqual(shown.map(chunk => chunk.strata), meshes); assert(shown.every(chunk => chunk.earth.visible));
});

test('closing a view wider than the cache releases hidden chunks even when the near ground was already painted', t => {
  const art = scene(t), camera = { x: 12, width: WIDEST, zoom: FAR };
  art.update(camera, 0);
  assert(art.painted > 96);
  const meshes = art.chunks.filter(chunk => chunk.earth).map(chunk => chunk.strata),
    geometries = meshes.map(mesh => mesh.geometry), buffers = geometries.map(geometry => [...geometry.buffers]);
  art.update({ ...camera, zoom: 16 }, 100);
  assert(art.painted <= 96); assert(meshes.some(mesh => mesh.destroyed));
  for (const [i, mesh] of meshes.entries()) if (mesh.destroyed) {
    assert.equal(geometries[i].buffers, null); assert(buffers[i].every(buffer => buffer.destroyed));
  }
  assert.equal(Texture.WHITE.destroyed, false);
});

test('forgetting and clearing terrain unload every owned drawing context and its cached graphics data immediately', t => {
  for (const release of ['forget', 'clear']) {
    const art = scene(t), chunk = art.chunks.find(chunk => chunk.left <= 12 && chunk.right > 12), contexts = [], gpuData = [];
    for (const step of [0, 8, 32]) art.paint(chunk, step);
    const surfaces = [...chunk.bases.values()].map(base => ({ mesh: base.earth, geometry: base.earth.geometry, buffers: [...base.earth.geometry.buffers] }));
    art.plant(chunk);
    art.detail(chunk, chunk.left, chunk.left + 60, 1);
    const visit = part => {
      if (!part) return;
      if (part instanceof Graphics) {
        const context = part.context, gpu = new GpuGraphicsContext(); buildContextBatches(context, gpu);
        context._gpuData.terrainReview = gpu; contexts.push(context); gpuData.push(gpu);
      }
      for (const child of part.children) visit(child);
    };
    for (const part of [...chunk.bases.values()].map(base => base.earth).concat(chunk.fine, chunk.props, chunk.ruins, chunk.signs)) visit(part);
    let unloaded = 0;
    for (const context of contexts) context.on('unload', () => { unloaded++; });
    if (release === 'forget') art.forget(chunk); else art.clear();
    assert(contexts.length >= 2); assert.equal(unloaded, contexts.length);
    assert.equal(surfaces.length, 3);
    assert(surfaces.every(({ mesh, geometry, buffers }) => mesh.destroyed && geometry.buffers === null && buffers.every(buffer => buffer.destroyed)));
    assert(contexts.every(context => context.destroyed && context.instructions === null && Object.keys(context._gpuData).length === 0));
    assert(gpuData.every(gpu => gpu.geometryData === null && gpu.batches === null));
    assert.equal(Texture.WHITE.destroyed, false);
  }
});

test('a camera above the scenery prepares no invisible ground and restores it when returning', t => {
  const art = scene(t), ground = art.terrain, high = Math.max(...ground.points.map(point => point.y)),
    camera = { x: 12, y: high + 1000, width: 1000, height: 600, zoom: 3 };
  art.update(camera, 0); assert.equal(art.painted, 0);
  art.update({ ...camera, y: ground.height(12) + 10 }, 100); assert(art.painted > 0);
  art.update(camera, 200); assert(art.chunks.every(chunk => !chunk.earth?.visible));
});

test('near grain fades through the detail threshold and reaches full strength without rebuilding warm terrain', t => {
  const ground = new Terrain('highlands', { seed: 6173, length: 2000 }), art = scene(t, ground),
    chunk = art.chunks.find(chunk => chunk.left <= 12 && chunk.right > 12), x = (chunk.left + chunk.right) / 2,
    camera = { x, y: ground.height(x) + 10, width: 600, height: 400, zoom: 3 };
  // Warm: the ground near enough to be drawn with its bumps too (`BUMPS_ZOOM`), and back.
  for (const [i, zoom] of [BUMPS_ZOOM, 3].entries()) for (let frame = 0; frame < 20; frame++) { camera.zoom = zoom; art.update(camera, (i * 20 + frame) * 8); }
  assert(chunk.grain && chunk.soil?.children.length > 0, 'the actual scene has both cached grain meshes');
  assert.equal(chunk.stones?.children.length, 2, 'native clasts and their finish are separate meshes');
  assert.equal(chunk.step, 0);
  const stones = chunk.stones, [native, finish] = stones.children,
    cached = resources(art), painted = art.painted, detailCount = tiles(art).length,
    baseCount = art.chunks.reduce((sum, chunk) => sum + (chunk.bases?.size || 0), 0),
    revisions = cached.buffers.map(buffer => buffer._updateID),
    sources = [...new Set([art.tones.source, ...Object.values(art.art.grains).map(texture => texture.source), art.art.flora.source])];
  let uploadRequests = 0;
  const requested = () => { uploadRequests++; };
  // These are real Pixi buffer/texture invalidations; no GPU is created by this test.
  for (const buffer of cached.buffers) buffer.on('update', requested);
  for (const source of sources) source.on('update', requested);
  t.after(() => {
    for (const buffer of cached.buffers) buffer.off('update', requested);
    for (const source of sources) source.off('update', requested);
  });
  let previous = -1, atThreshold, justAbove;
  for (const [i, zoom] of [2.9, 2.9999, 3, 3.0001, 3.1, 4, 6, 9, 11.9999, 12, 15].entries()) {
    camera.zoom = zoom; art.update(camera, 400 + i * 100);
    const alpha = art.layers.grain.alpha;
    assert.equal(alpha, art.layers.soil.alpha, 'surface and deeper grain use the same fade');
    assert(alpha >= previous && alpha >= 0 && alpha <= 1, 'approaching the ground increases grain monotonically');
    if (zoom > 3 && zoom <= 12) assert(alpha > previous, 'every sampled approach through the fade reveals more grain');
    if (zoom <= 3) assert.equal(alpha, 0, 'grain is already clear when detail is hidden');
    if (zoom === 3) atThreshold = alpha;
    if (zoom === 3.0001) { justAbove = alpha; assert(alpha > 0 && alpha - atThreshold < 1e-6, 'crossing the threshold cannot pop grain into view'); }
    if (zoom === 6 || zoom === 9) assert(alpha > justAbove && alpha < 1, 'intermediate views keep a gradual, incomplete finish');
    if (zoom === 11.9999) assert(1 - alpha < 1e-6, 'the finish also approaches its full strength continuously');
    if (zoom >= 12) assert.equal(alpha, 1, 'inspection views retain the full finish');
    assert(chunk.earth.visible && chunk.strata.visible);
    assert.equal(chunk.grain.visible, zoom >= 3); assert.equal(chunk.soil.visible, zoom >= 3);
    assert.equal(chunk.grain.alpha, .6); assert(chunk.soil.children.every(mesh => mesh.alpha === .55));
    assert.equal(chunk.stones, stones); assert.deepEqual(stones.children, [native, finish]);
    assert(stones.visible && native.visible, 'native clasts stay visible while their finish fades');
    assert.equal(native.alpha, 1); assert.equal(finish.alpha, .6 * alpha);
    assert.equal(art.painted, painted); assert.equal(tiles(art).length, detailCount);
    assert.equal(art.chunks.reduce((sum, chunk) => sum + (chunk.bases?.size || 0), 0), baseCount);
    const current = resources(art);
    assert.deepEqual(current.parts, cached.parts); assert.deepEqual(current.geometries, cached.geometries);
    assert.deepEqual(current.buffers, cached.buffers); assert.deepEqual(cached.buffers.map(buffer => buffer._updateID), revisions);
    assert.equal(uploadRequests, 0, 'zooming the shared alpha does not invalidate cached texture or vertex data');
    previous = alpha;
  }
});

test('vertical panning at fixed zoom leaves visible terrain grain and cached geometry unchanged', t => {
  const ground = new Terrain('highlands', { seed: 6173, length: 2000 }), art = scene(t, ground),
    chunk = art.chunks.find(chunk => chunk.left <= 12 && chunk.right > 12), x = (chunk.left + chunk.right) / 2,
    y = ground.height(x) + 10, camera = { x, y, width: 600, height: 400, zoom: 7 };
  for (let frame = 0; frame < 20; frame++) art.update(camera, frame * 16);
  assert(chunk.grain && chunk.soil?.children.length > 0);
  const cached = resources(art), alpha = art.layers.grain.alpha, soilAlpha = art.layers.soil.alpha,
    earth = chunk.earth, strata = chunk.strata, grain = chunk.grain, soil = chunk.soil,
    revisions = cached.buffers.map(buffer => buffer._updateID), painted = art.painted;
  assert(alpha > 0 && alpha < 1, 'the fixed view lies within the fade range');
  for (const [i, offset] of [12, -24, 32, -48, 0].entries()) {
    camera.y = y + offset; art.update(camera, 400 + i * 16);
    assert(chunk.earth.visible && chunk.strata.visible && chunk.grain.visible && chunk.soil.visible, 'the ground stays inside the visible vertical range');
    assert.equal(art.layers.grain.alpha, alpha); assert.equal(art.layers.soil.alpha, soilAlpha);
    assert.equal(chunk.earth, earth); assert.equal(chunk.strata, strata); assert.equal(chunk.grain, grain); assert.equal(chunk.soil, soil);
    assert.equal(art.painted, painted); assert.deepEqual(resources(art), cached);
    assert.deepEqual(cached.buffers.map(buffer => buffer._updateID), revisions);
  }
});

test('a cold full-world overview and its LOD/regeneration return keep the same valid terrain buffers', t => {
  const ground = new Terrain('world', { seed: 6173, length: 512000, center: 12 }), art = scene(t, ground),
    x = 125000, camera = { x, y: ground.height(x) - 1600, width: 936, height: 618, zoom: .09 },
    before = structuredClone(ground.descriptor());
  const drawn = () => art.activeChunks.filter(chunk => chunk.strata?.visible).map(chunk => {
    const { positions, indices } = chunk.strata.geometry, expected = buildStrata(art.plan, chunk.left, chunk.right, art.floor, chunk.step);
    assert.equal(chunk.strata.texture, art.tones); assert.equal(art.tones.destroyed, false);
    assert.deepEqual([chunk.strata.x, chunk.strata.y], [chunk.left, 0]);
    assert.deepEqual(positions, expected.positions.subarray(0, expected.bedVertices * 2));
    assert.deepEqual(indices, expected.indices.subarray(0, expected.bedIndices));
    for (const value of positions) assert(Number.isFinite(value));
    for (const index of indices) assert(index < positions.length / 2);
    const local = art.local(chunk);
    assert.equal(local.points[0].y, ground.height(chunk.left));
    assert.equal(local.points.at(-1).y, ground.height(chunk.right));
    return { left: chunk.left, right: chunk.right, positions: positions.slice(), indices: indices.slice() };
  });
  art.update(camera, 0);
  const cold = drawn(); assert(cold.length > 1);
  let now = 100;
  for (const zoom of [.2, .6, 32, .09]) {
    camera.zoom = zoom;
    for (let frame = 0; frame < 20; frame++) art.update(camera, now += 16);
    assert(drawn().length > 0); assert.deepEqual(ground.descriptor(), before);
  }
  assert.deepEqual(drawn(), cold, 'returning to the overview has no stale scale or chunk data');
  const old = art.allChunks.flatMap(chunk => [...chunk.bases?.values() || []].map(base => base.strata)), tones = art.tones;
  art.rebuild(new Terrain('world', ground.reference()));
  assert(old.every(mesh => mesh.destroyed)); assert.equal(tones.destroyed, true);
  art.update(camera, now + 100);
  assert.deepEqual(drawn(), cold, 'a new instance of the same world draws the exact cold buffers again');
  assert.deepEqual(art.terrain.descriptor(), before);
});
