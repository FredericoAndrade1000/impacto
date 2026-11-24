import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Terrain } from '../src/terrain.ts';
import { TerrainScene, FLORA_ZOOM, OVERVIEW_ZOOM, OVERVIEW_EXIT_ZOOM, WIDE_ZOOM, WIDE_EXIT_ZOOM, ROUGH } from '../src/terrain-scene.ts';
import { plantFlora } from '../src/flora-art.ts';
import { drawGroundSurface } from '../src/terrain-art.ts';
import { simplifyGround, terrainStep } from '../src/terrain-lod.ts';
import { drawRuins, RUIN_TONES } from '../src/ruins-art.ts';
import { GraphicsRecorder } from './scenery-canvas.js';
import { groundGrains, groundInstructions } from './helpers/ground-art.js';

function scene(t, terrain = new Terrain('world', { seed: 6173, length: 64000 })) {
  const roots = [new Container(), new Container()], grains = groundGrains(),
    art = new TerrainScene(...roots, { grains, flora: Texture.WHITE });
  art.rebuild(terrain);
  t.after(() => {
    art.clear(); for (const root of roots) root.destroy({ children: true });
    for (const texture of Object.values(grains)) { assert.equal(texture.destroyed, false); texture.destroy(true); }
  });
  return art;
}
const drawn = art => art.activeChunks.filter(chunk => chunk.earth?.visible);
// The view updated until the partition asked for (`target`) takes over from the one shown (terrain-scene.ts `handOver`):
// how many frames it took.
function handOver(art, camera, now, target) {
  let frames = 0;
  for (; art.activeChunks !== target; frames++) {
    assert(frames < 80, 'the partition asked for takes over'); art.update(camera, now + frames);
  }
  return frames;
}

test('overview keeps each surface slice, silhouette, biome fade and plateau band while omitting subpixel layers', t => {
  const art = scene(t), before = art.terrain.snapshot();
  const top = (points, terrain) => points.flatMap((x, i) => i % 2 || Math.abs(points[i + 1] - terrain.height(x)) > 1e-8 ? [] : [x, points[i + 1]]);
  let slices = 0, concrete = 0;
  for (const chunk of art.overviewChunks) {
    const original = art.local(chunk), local = { ...original, points: simplifyGround(original.points, 2) },
      full = new GraphicsRecorder(), overview = new GraphicsRecorder();
    drawGroundSurface(local, full, true); drawGroundSurface(local, overview, true, true);
    const fullFills = full.fills(), surface = overview.fills().filter(fill => typeof fill.style === 'number');
    for (const [i, fill] of surface.entries()) {
      const outline = top(fill.points, local);
      assert.deepEqual(outline, top(fullFills[i * 3].points, local), 'one skin retains the same upper contact edge');
      const material = local.materialAt((outline[0] + outline.at(-2)) / 2);
      if (material === 'concrete') concrete++;
      else assert.equal(fill.style, fullFills[i * 3 + 2].style, 'surface and biome fade retain their top tone');
      slices++;
    }
    assert.deepEqual(overview.fills().filter(fill => typeof fill.style !== 'number'),
      fullFills.filter(fill => typeof fill.style !== 'number'), 'the broad plateau bands remain unchanged');
    assert(!overview.calls.some(([method]) => method === 'stroke'), 'overview prepares no slab rims or narrow plateau cracks');
    art.paint(chunk);
    assert.equal(groundInstructions(art, chunk).filter(instruction => instruction.action === 'fill').length, overview.fills().length);
  }
  assert(slices > 100 && concrete > 0, 'the check covers material slices, biome fades and ruin slabs');
  assert.deepEqual(art.terrain.snapshot(), before);
});

test('overview ruins retain the exact walls and rubble masses and restore detailed art independently', t => {
  const art = scene(t); let ruins = 0;
  for (const chunk of art.overviewChunks) {
    const local = art.local(chunk);
    if (!local.features.some(feature => feature.kind === 'ruins')) continue;
    const full = new GraphicsRecorder(), overview = new GraphicsRecorder(), again = new GraphicsRecorder();
    drawRuins(local, full); drawRuins(local, overview, true); drawRuins(local, again);
    assert.deepEqual(overview.fills(), full.fills().filter(fill => fill.style === RUIN_TONES.render || fill.style === RUIN_TONES.rubble));
    assert(overview.calls.length < full.calls.length / 10, 'tiny bars, scars, windows and individual stones are not prepared');
    assert.deepEqual(again.calls, full.calls, 'an overview does not change subsequent detailed art');
    if (++ruins === 5) break;
  }
  assert(ruins >= 3);
});

test('overview partitions the same contact outline into contiguous, biome-bound stretches without changing near chunks', t => {
  const art = scene(t), ground = art.terrain, before = ground.snapshot();
  for (const [chunks, width] of [[art.chunks, 160], [art.overviewChunks, 4096]]) {
    assert.equal(chunks[0].left, ground.points[0].x); assert.equal(chunks.at(-1).right, ground.points.at(-1).x);
    for (const [i, chunk] of chunks.entries()) {
      assert(chunk.right > chunk.left && chunk.right - chunk.left <= width + 1e-8);
      if (i) assert.equal(chunk.left, chunks[i - 1].right);
      assert.equal(ground.biomeAt(chunk.left + 1e-6), chunk.biome);
      assert.equal(ground.biomeAt(chunk.right - 1e-6), chunk.biome);
      const local = art.local(chunk);
      assert.deepEqual(local.points[0], { x: chunk.left, y: ground.height(chunk.left) });
      assert.deepEqual(local.points.at(-1), { x: chunk.right, y: ground.height(chunk.right) });
    }
  }
  assert(art.overviewChunks.length < art.chunks.length / 4);
  assert.equal(art.painted, 0); assert.deepEqual(ground.snapshot(), before);
});

test('a map-wide overview uses fewer static anchored meshes and prepares no grain, flora or near detail', t => {
  const art = scene(t), camera = { x: 12, width: 1600, zoom: .02 }, regular = art.chunks;
  art.update(camera, 0);
  const overview = drawn(art), kept = overview.map(chunk => chunk.strata), buffers = kept.map(mesh => [...mesh.geometry.buffers]);
  assert.equal(art.activeChunks, art.overviewChunks); assert.equal(art.chunks, regular);
  assert(overview.length < regular.length / 4);
  for (const chunk of overview) {
    assert.equal(chunk.step, 32); assert.equal(chunk.bases.size, 1);
    assert.equal(chunk.strata.geometry.batchMode, 'no-batch');
    assert.equal(chunk.strata.x, chunk.left); assert.equal(chunk.earth.x, chunk.left);
    assert(chunk.strata.geometry.positions.filter((_, i) => !(i % 2)).every(x => Math.abs(x) < 4100));
    for (const name of ['grain', 'flora', 'fine', 'props', 'soil', 'details']) assert(!chunk[name]);
  }
  // A warm pan does not join or replace buffers; only the anchors move with their world container.
  for (let frame = 1; frame < 6; frame++) art.update({ ...camera, x: 12 + frame }, frame * 16);
  assert.deepEqual(drawn(art).map(chunk => chunk.strata), kept);
  assert(kept.every((mesh, i) => mesh.geometry.buffers.every((buffer, j) => buffer === buffers[i][j])));
});

test('crossing the overview threshold hides the previous partition immediately and reuses warm near and overview buffers', t => {
  const art = scene(t), ground = art.terrain, near = { x: 12, y: ground.height(12) + 10, width: 240, height: 200, zoom: 22 },
    work = art.layers.works.addChild(new Container());
  art.update(near, 0); art.update(near, 100);
  const closeChunks = drawn(art), close = closeChunks.map(chunk => chunk.strata), flora = closeChunks.map(chunk => chunk.flora),
    fine = closeChunks.map(chunk => chunk.fine);
  art.update({ ...near, zoom: .02 }, 200);
  const overview = drawn(art), wide = overview.map(chunk => chunk.strata);
  assert(overview.length > 1 && close.length > 0);
  for (const chunk of closeChunks) for (const name of ['earth', 'strata', 'grain', 'flora', 'fine', 'props', 'soil'])
    assert(!chunk[name]?.visible, name);
  for (let turn = 0; turn < 6; turn++) {
    art.update(near, 300 + turn * 2);
    assert.equal(art.activeChunks, art.chunks); assert.deepEqual(drawn(art).map(chunk => chunk.strata), close);
    assert(closeChunks.every((chunk, i) => chunk.flora === flora[i] && chunk.fine === fine[i]));
    assert(overview.every(chunk => !chunk.earth.visible && !chunk.strata.visible && !chunk.ruins?.visible));
    art.update({ ...near, zoom: .02 }, 301 + turn * 2);
    assert.deepEqual(drawn(art).map(chunk => chunk.strata), wide);
    assert.equal(work.parent, art.layers.works); assert.equal(work.visible, true);
  }
  handOver(art, { ...near, zoom: OVERVIEW_EXIT_ZOOM }, 400, art.wideChunks); // out of the overview, the kilometre stretches
  assert(art.activeChunks.every(chunk => chunk.right - chunk.left <= 1024 + 1e-8));
  handOver(art, { ...near, zoom: WIDE_EXIT_ZOOM }, 500, art.chunks); // and from the whole outline on, the near ones
  assert(art.activeChunks.every(chunk => chunk.right - chunk.left <= 160 + 1e-8));
});

test('a desktop pinch around the overview entry threshold retains its partition and buffers until the exit threshold', t => {
  const art = scene(t, new Terrain('world', { seed: 6173, length: 128000 })), camera = { x: 12, width: 1600, zoom: OVERVIEW_ZOOM };
  art.update(camera, 0); assert(art.activeChunks === art.wideChunks); assert(drawn(art).length > 10);
  handOver(art, { ...camera, zoom: OVERVIEW_ZOOM - .001 }, 100, art.overviewChunks);
  const kept = drawn(art).map(chunk => ({ chunk, mesh: chunk.strata, geometry: chunk.strata.geometry,
    buffers: [...chunk.strata.geometry.buffers] })), paint = art.paint.bind(art);
  let paints = 0;
  art.paint = (...args) => { paints++; return paint(...args); };
  for (let frame = 0; frame < 20; frame++) {
    art.update({ ...camera, zoom: frame % 2 ? OVERVIEW_ZOOM - .001 : OVERVIEW_ZOOM + .001 }, 200 + frame * 16);
    assert(art.activeChunks === art.overviewChunks);
    assert.equal(paints, 0, 'small pinch oscillations prepare no replacement geometry');
    for (const { chunk, mesh, geometry, buffers } of kept) {
      assert.equal(chunk.strata, mesh); assert.equal(mesh.geometry, geometry);
      assert(geometry.buffers.every((buffer, i) => buffer === buffers[i]));
    }
  }
  art.update(camera, 550); assert(art.activeChunks === art.overviewChunks); assert.equal(paints, 0);
  assert.equal(terrainStep(OVERVIEW_EXIT_ZOOM - 1e-6), 32); assert.equal(terrainStep(OVERVIEW_EXIT_ZOOM), 8);
  assert(OVERVIEW_EXIT_ZOOM < FLORA_ZOOM);
  art.update({ ...camera, zoom: OVERVIEW_EXIT_ZOOM }, 600);
  assert(art.activeChunks === art.wideChunks); assert(drawn(art).length > 10); assert(paints > 0);
  assert(art.overviewChunks.every(chunk => !chunk.earth?.visible && !chunk.strata?.visible));
});

test('both terrain partitions share the hidden-cache limit and unload every owned buffer when cleared', t => {
  const art = scene(t, new Terrain('world', { seed: 6173, length: 512000 })),
    camera = { x: 12, width: 12000, zoom: .02 }, work = art.layers.works.addChild(new Container());
  art.update(camera, 0); assert(art.painted > 96);
  const cached = drawn(art).map(chunk => ({ mesh: chunk.strata, geometry: chunk.strata.geometry,
    buffers: [...chunk.strata.geometry.buffers, ...chunk.earth.geometry.buffers], surface: chunk.earth, surfaceGeometry: chunk.earth.geometry }));
  art.update({ ...camera, zoom: 22 }, 100);
  assert(art.painted <= 96); assert(cached.some(part => part.mesh.destroyed));
  assert.equal(art.painted, art.allChunks.filter(chunk => chunk.earth).length);
  const close = drawn(art).map(chunk => ({ mesh: chunk.strata, geometry: chunk.strata.geometry,
    buffers: [...chunk.strata.geometry.buffers, ...chunk.earth.geometry.buffers], surface: chunk.earth, surfaceGeometry: chunk.earth.geometry }));
  art.clear();
  for (const part of [...cached, ...close]) {
    assert(part.mesh.destroyed && part.surface.destroyed); assert.equal(part.geometry.buffers, null); assert.equal(part.surfaceGeometry.buffers, null);
    assert(part.buffers.every(buffer => buffer.destroyed));
  }
  assert.equal(art.painted, 0); assert.equal(art.allChunks.length, 0); assert.equal(art.overviewChunks.length, 0);
  assert.equal(work.parent, art.layers.works); assert(!work.destroyed); assert.equal(Texture.WHITE.destroyed, false);
});

test('returning from overview restores the short close-view anchors far from the world origin', t => {
  const ground = new Terrain('world', { seed: 6173, length: 64000, center: 99999.5 }), art = scene(t, ground),
    camera = { x: 127000.375, width: 240, zoom: .02 };
  art.update(camera, 0); const overview = drawn(art);
  art.update({ ...camera, zoom: 650 }, 100);
  assert(overview.every(chunk => !chunk.strata?.visible));
  const close = drawn(art); assert(close.length > 0);
  for (const chunk of close) {
    assert.equal(chunk.step, ROUGH); assert.equal(chunk.strata.x, chunk.left); assert.equal(chunk.earth.x, chunk.left);
    assert(chunk.earth.geometry.attributes.aPosition.buffer.data.filter((_, i) => !(i % 2)).every(x => Math.abs(x) < 520));
    assert(chunk.strata.geometry.positions.filter((_, i) => !(i % 2)).every(x => Math.abs(x) < 520));
  }
});

test('the workshop keeps its existing single ground partition at overview zoom', t => {
  const art = scene(t, new Terrain('mixed'));
  art.update({ x: 12, width: 1600, zoom: .02 }, 0);
  assert.equal(art.overviewChunks.length, 0); assert.equal(art.activeChunks, art.chunks);
  assert.equal(art.chunks.length, 1); assert.equal(art.allChunks.length, 1); assert.equal(art.painted, 1);
});

// From the overview to the whole outline a wide screen held a hundred near stretches and more, each drawn in pieces of its
// own: the same ground is drawn there in stretches of a kilometre, as many pieces as a dozen of them make, with the trees
// of the near stretches they cover, and no grain or near detail, which no view there shows.
test('between the overview and the whole outline the ground is drawn in kilometre stretches, with the trees of the near ones', t => {
  const art = scene(t, new Terrain('world', { seed: 6173, length: 128000 })), ground = art.terrain, camera = { x: 9000, width: 1920, zoom: .2 };
  assert(OVERVIEW_EXIT_ZOOM < FLORA_ZOOM && FLORA_ZOOM < WIDE_ZOOM && WIDE_ZOOM < WIDE_EXIT_ZOOM && terrainStep(WIDE_ZOOM) === 8 && terrainStep(WIDE_EXIT_ZOOM) === 0);
  assert.equal(art.wideChunks[0].left, ground.points[0].x); assert.equal(art.wideChunks.at(-1).right, ground.points.at(-1).x);
  for (const [i, chunk] of art.wideChunks.entries()) {
    assert(chunk.wide && !chunk.overview && chunk.right - chunk.left <= 1024 + 1e-8);
    if (i) assert.equal(chunk.left, art.wideChunks[i - 1].right);
    assert.equal(ground.biomeAt(chunk.left + 1e-6), chunk.biome); assert.equal(ground.biomeAt(chunk.right - 1e-6), chunk.biome);
  }
  art.update(camera, 0);
  const wide = drawn(art), seen = 1920 / .2;
  // A cold wood is prepared one chunk per frame; compare its trees after that bounded preparation finishes.
  for (let frame = 1; wide.some(chunk => !chunk.plants); frame++) {
    assert(frame < 80); art.update(camera, frame * 16);
  }
  assert(art.activeChunks === art.wideChunks && wide.length >= seen / 1024 && wide.length < seen / 512);
  for (const chunk of wide) {
    assert.equal(chunk.step, 8);
    for (const name of ['grain', 'fine', 'props', 'soil', 'details']) assert(!chunk[name], name);
    // The trees of a wide stretch are those its near stretches grow, every one of them and no other.
    const near = art.chunks.filter(close => close.right > chunk.left && close.left < chunk.right),
      grown = near.flatMap(close => plantFlora(ground, close.left, close.right, close.biome, art.chunks.indexOf(close))).filter(plant => plant.x >= chunk.left && plant.x < chunk.right);
    assert.deepEqual(chunk.plants, grown);
  }
  assert(wide.some(chunk => chunk.plants.length > 20 && chunk.flora), 'the stretches in view are wooded');
  // The trees of the near stretches, drawn up close, are the same: the same places, heights and kinds.
  const shown = wide.find(chunk => chunk.plants.length > 20), key = plant => [plant.x, plant.y, plant.height, plant.kind, plant.back].join();
  const nearCamera = { ...camera, x: (shown.left + shown.right) / 2, zoom: 1, width: (shown.right - shown.left) * 1 };
  handOver(art, nearCamera, 100, art.chunks);
  // This edge chunk's new view reaches beyond the previous partition's painted coverage: it enters cold.
  for (let frame = 1; drawn(art).some(chunk => !chunk.plants); frame++) {
    assert(frame < 80); art.update(nearCamera, 100 + frame * 16);
  }
  const close = drawn(art).filter(chunk => chunk.left < shown.right && chunk.right > shown.left);
  assert(close.every(chunk => chunk.plants), JSON.stringify(close.map(c => ({left:c.left,earth:Boolean(c.earth),plants:Boolean(c.plants)}))));
  assert.deepEqual(close.flatMap(chunk => chunk.plants).filter(plant => plant.x >= shown.left && plant.x < shown.right).map(key).sort(), shown.plants.map(key).sort());
  // A pinch about the way in keeps the kilometre stretches, and the near ones come back from the way out.
  art.update(camera, 200);
  for (let frame = 0; frame < 10; frame++) { art.update({ ...camera, zoom: frame % 2 ? WIDE_ZOOM + .005 : WIDE_ZOOM - .005 }, 300 + frame * 16); assert(art.activeChunks === art.wideChunks); }
  handOver(art, { ...camera, zoom: WIDE_EXIT_ZOOM }, 600, art.chunks);
  assert(art.wideChunks.every(chunk => !chunk.earth?.visible && !chunk.strata?.visible && !chunk.flora?.visible));
});

// Painting all the stretches of a view at once, some thirty near ones to a wide screen, held one frame up for some seventy
// milliseconds when a zoom crossed the limit of a partition: over ground the partition shown has painted, it stays on the
// screen as it is while one stretch of the other a frame is painted out of sight, and the other takes over once the view
// is painted in it. Over ground it has not painted, the other takes over at once.
test('a zoom across the limit of a partition paints one stretch of the other a frame, the one shown kept until the view is painted', t => {
  const art = scene(t, new Terrain('world', { seed: 6173, length: 128000 })), camera = { x: 9000, width: 1920, zoom: .3 }, paint = art.paint.bind(art);
  art.update(camera, 0);
  const shown = drawn(art), strata = shown.map(chunk => chunk.strata);
  assert(art.activeChunks === art.wideChunks && shown.length > 3 && shown.every(chunk => chunk.step === 8));
  let paints = [];
  art.paint = (chunk, step) => { paints.push({ chunk, step }); return paint(chunk, step); };
  const near = { ...camera, zoom: .6 }, half = near.width / (2 * near.zoom) + 24,
    view = art.chunks.filter(chunk => chunk.right > near.x - half && chunk.left < near.x + half);
  assert(view.length > 20 && view.every(chunk => !chunk.earth));
  for (let frame = 0; ; frame++) {
    paints = []; art.update(near, 100 + frame);
    if (art.activeChunks === art.chunks) { assert(paints.length <= 1); assert.equal(frame, view.length - 1); break; }
    assert(paints.length === 1 && paints[0].step === 0 && art.chunks.includes(paints[0].chunk), 'one near stretch a frame, at the scale asked for');
    assert(!paints[0].chunk.earth.visible && !paints[0].chunk.strata.visible, 'painted out of sight');
    // The kilometre stretches stay as they were, at their scale, with nothing of them painted anew.
    assert(drawn(art).every(chunk => chunk.step === 8 && chunk.bases.size === 1));
    assert(drawn(art).every(chunk => strata.includes(chunk.strata)));
    assert(art.chunks.every(chunk => !chunk.earth?.visible));
  }
  assert(view.every(chunk => chunk.earth.visible && chunk.step === 0));
  assert(art.wideChunks.every(chunk => !chunk.earth?.visible && !chunk.flora?.visible));
  // Back out over what both have painted, the kilometre stretches come back at once, as they were.
  paints = []; art.update(camera, 300);
  assert(art.activeChunks === art.wideChunks && paints.length === 0);
  assert.deepEqual(drawn(art).map(chunk => chunk.strata), strata);
  // Over ground the kilometre stretches have not painted, the near ones take over at once.
  const far = { ...near, x: 60000 };
  art.update({ ...camera, x: 40000 }, 400); art.update(far, 500);
  assert(art.activeChunks === art.chunks && drawn(art).length > 20);
});
