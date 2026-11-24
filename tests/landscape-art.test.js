import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, WORLD_BLEND } from '../src/terrain.ts';
import { Backdrop, AmbientDust, skyTones, paintRange, rangeScale, rangeResolution } from '../src/landscape-art.ts';
import { countingCanvas } from './scenery-canvas.js';

// Canvas is only an allocation/paint counter here. Meshes, sprites and textures remain
// real Pixi objects so these tests cover the resource lifecycle and what a frame touches.
function scene(t, release = null) {
  // The hook of a test watches what a scene replaces; tearing the scene down afterwards is not its business.
  let closing = false;
  const { counters, canvas } = countingCanvas(t), backdrop = new Backdrop(release && (() => { if (!closing) release(); }), {
    clouds: { width: 1024, height: 512 }, ranges: { width: 2048, height: 2560 } });
  t.after(() => { closing = true; backdrop.destroy(); });
  backdrop.resize(900, 550);
  return { backdrop, counters, canvas };
}
const valley = (seed = 6173, id = 'wet-valley') => new Terrain(id, { seed, length: 2000 });
const view = (ground, x, zoom = 12, lift = 4) => ({ x, y: ground.height(x) + lift, zoom, width: 900, height: 550 });
const rangeTextures = backdrop => backdrop.cache.flatMap(entry => entry.texture ? [entry.texture] : []);
// Resolve sampler identities back to physical regions, independently of which
// cache entry or shader input holds them.
function rangeWeights(backdrop) {
  const { uFirst, uSecond, blendUniforms } = backdrop.range.shader.resources,
    share = blendUniforms.uniforms.uShare, weights = new Map();
  for (const [source, weight] of [[uFirst, 1 - share], [uSecond, share]]) {
    const entry = backdrop.cache.find(entry => entry.texture?.source === source);
    assert(entry?.place, 'every sampler points to a current cached region');
    if (weight > 0) weights.set(entry.place, (weights.get(entry.place) || 0) + weight);
  }
  return [...weights].sort(([a], [b]) => a.start - b.start);
}
function assertRangeWeights(backdrop, expected, tolerance = 1e-9) {
  const sorted = [...expected].sort(([a], [b]) => a.start - b.start);
  const actual = rangeWeights(backdrop);
  assert.deepEqual(actual.map(([place]) => place), sorted.map(([place]) => place));
  actual.forEach(([, weight], i) => assert(Math.abs(weight - sorted[i][1]) <= tolerance, `weight ${i}: ${weight} versus ${sorted[i][1]}`));
  assert.equal(backdrop.range.texture.source, backdrop.range.shader.resources.uFirst);
}
function assertNotSampled(backdrop, texture) {
  assert.notEqual(backdrop.range.texture, texture, 'the mesh no longer keeps the retiring texture');
  assert.notEqual(backdrop.range.shader.resources.uFirst, texture.source, 'the first sampler no longer keeps its source');
  assert.notEqual(backdrop.range.shader.resources.uSecond, texture.source, 'the second sampler no longer keeps its source');
}
// Where everything of the backdrop stands: what a frame may change, and all it may change.
const placed = backdrop => [backdrop.sky, backdrop.sun, ...backdrop.clouds.map(c => c.sprite), backdrop.range]
  .map(part => [part.position.x, part.position.y, part.scale.x, part.scale.y, part.alpha, part.visible]);

test('panning across biomes at overview zoom paints no invisible range textures', t => {
  const {backdrop,counters} = scene(t), ground = new Terrain('world',{seed:6173,length:64000});
  backdrop.setScene(ground,'clear');
  const made = {...counters};
  for (const region of ground.biomes) backdrop.update(view(ground,(region.start+region.end)/2,.1),0);
  assert.equal(backdrop.paints,0); assert.equal(rangeTextures(backdrop).length,0);
  assert.deepEqual(counters,made); assert(!backdrop.range.visible);
  const region = ground.biomes[Math.floor(ground.biomes.length/2)], x = (region.start+region.end)/2;
  backdrop.update(view(ground,x,6),0); assert.equal(backdrop.paints,1); assert.equal(rangeTextures(backdrop).length,1);
  const textures=rangeTextures(backdrop), painted={...counters};
  for (const region of ground.biomes) backdrop.update(view(ground,(region.start+region.end)/2,.1),0);
  assert.deepEqual(counters,painted); assert.deepEqual(rangeTextures(backdrop),textures);
  backdrop.update(view(ground,x,6),0); assert.equal(backdrop.paints,1); assert(backdrop.range.visible);
});

test('range resolution follows projected device pixels, including tall views and dense phone screens', () => {
  assert.equal(rangeResolution(2, 300), .25);
  assert.equal(rangeResolution(2, 600), .5);
  assert.equal(rangeResolution(2, 1200), 1);
  assert.equal(rangeResolution(2, 600, 2), 1);
  assert.equal(rangeResolution(12, 412), 1);
  assert.equal(rangeResolution(12, 412, 2), 1);
  assert.equal(rangeResolution(650, 900, 2), 1, 'source resolution bounds the maximum');
});

test('the panorama preserves native texel phase independently of its proportional projection', t => {
  const { backdrop, canvas } = scene(t), ground = valley(), image = backdrop.art.ranges;
  backdrop.setScene(ground); backdrop.update(view(ground, 8, 28));
  const { positions, uvs } = backdrop.range.geometry, logicalWidth = positions[2] / uvs[2], logicalHeight = -positions[1];
  assert.deepEqual([logicalWidth, logicalHeight], [1536, 384]);
  assert.equal(logicalWidth / logicalHeight, image.width / (image.height / 5), 'source and projected pixels have the same proportions');
  assert.deepEqual(rangeTextures(backdrop).map(texture => [texture.source.pixelWidth, texture.source.pixelHeight]), [[2048, 512]]);
  for (const [row, biome] of ['highlands', 'wet-valley', 'rural-ridges', 'arid-basin', 'plateau'].entries()) {
    for (const resolution of [.25, .5, 1]) {
      const target = canvas(), context = target.getContext('2d'), draw = t.mock.method(context, 'drawImage'), scale = t.mock.method(context, 'scale');
      paintRange(target, biome, 'clear', 37, resolution, { ranges: image });
      assert.deepEqual(scale.mock.calls[0].arguments, [Math.min(1, resolution * 2), resolution]);
      assert.equal(draw.mock.callCount(), 2);
      for (const [index, call] of draw.mock.calls.entries()) {
        assert.deepEqual(call.arguments, [image, 0, row * 512, 2048, 512, index * 2048 - 37, 0, 2048, 512],
          'the cache wraps at integer source texels before any resolution reduction');
      }
    }
  }
});

test('new distant backdrops promote through three bounded grades and reuse their larger cached panorama', t => {
  const { backdrop, counters } = scene(t), ground = valley();
  backdrop.setScene(ground, 'clear'); backdrop.update(view(ground, 8, .18));
  const small = rangeTextures(backdrop), painted = { ...counters };
  assert.equal(small.length, 1);
  assert(small.every(texture => texture.source.pixelWidth === 1024 && texture.source.pixelHeight === 128));
  backdrop.update(view(ground, 18, .25)); assert.deepEqual(counters, painted);
  backdrop.update(view(ground, 18, 3));
  const normal = rangeTextures(backdrop);
  assert(small.every(texture => texture.destroyed));
  assert(normal.every(texture => texture.source.pixelWidth === 2048 && texture.source.pixelHeight === 256));
  backdrop.update(view(ground, 18, 28));
  const full = rangeTextures(backdrop), promoted = { ...counters };
  assert(normal.every(texture => texture.destroyed));
  assert(full.every(texture => texture.source.pixelWidth === 2048 && texture.source.pixelHeight === 512));
  backdrop.update(view(ground, 18, .18)); backdrop.update(view(ground, 18, 3));
  assert.deepEqual(counters, promoted); assert.deepEqual(rangeTextures(backdrop), full);
});

test('resizing or changing pixel density promotes the same panorama without changing its corners', t => {
  const { backdrop, counters } = scene(t), ground = valley(), camera = view(ground, 8, 2);
  backdrop.resize(900, 300); backdrop.setScene(ground); backdrop.update(camera);
  const mesh = backdrop.range, corners = [...mesh.geometry.positions],
    small = rangeTextures(backdrop);
  backdrop.resize(900, 600); backdrop.update(camera);
  const normal = rangeTextures(backdrop);
  assert(small.every(texture => texture.destroyed));
  assert(normal.every(texture => texture.source.pixelHeight === 256));
  backdrop.resize(900, 600, 2); backdrop.update(camera);
  const full = rangeTextures(backdrop), painted = { ...counters };
  assert(normal.every(texture => texture.destroyed));
  assert(full.every(texture => texture.source.pixelHeight === 512));
  for (const [width, height, ratio] of [[390, 844, 2], [915, 412, 1], [900, 300, 1], [900, 600, 2]]) {
    backdrop.resize(width, height, ratio); backdrop.update(camera);
    assert.equal(backdrop.range, mesh); assert.deepEqual([...mesh.geometry.positions], corners);
    assert.deepEqual(rangeTextures(backdrop), full); assert.deepEqual(counters, painted);
  }
});

test('crossing biomes above the panorama paints nothing and preserves cached images until reentry', t => {
  const { backdrop, counters } = scene(t), ground = new Terrain('world', { seed: 6173, length: 64000 }), zoom = .18,
    regions = ground.biomes.filter(region => region.start > ground.minX && region.end < ground.maxX).slice(0, 10),
    at = (region, lift) => {
      const x = (region.start + region.end) / 2, y = backdrop.relief.low(x, 512) + lift;
      backdrop.update({ x, y, zoom, width: backdrop.width, height: backdrop.height });
    }, high = 100000;
  backdrop.setScene(ground); const prepared = { ...counters };
  for (const region of regions) at(region, high);
  assert.equal(backdrop.paints, 0); assert.deepEqual(counters, prepared);
  assert.equal(rangeTextures(backdrop).length, 0); assert(!backdrop.range.visible);
  assert(backdrop.sky.visible && backdrop.sun.visible && backdrop.cloudHost.visible);
  assert(placed(backdrop).every(row => row.slice(0, 5).every(Number.isFinite)));
  at(regions[0], 4); assert.equal(backdrop.paints, 1);
  const first = rangeTextures(backdrop), painted = { ...counters }, used = backdrop.cache.map(entry => entry.used);
  for (const region of regions) at(region, high);
  assert.deepEqual(counters, painted); assert.deepEqual(rangeTextures(backdrop), first);
  assert.deepEqual(backdrop.cache.map(entry => entry.used), used); assert(!backdrop.range.visible);
  at(regions[1], 4); assert.equal(backdrop.paints, 2);
  const warmed = { ...counters };
  at(regions[0], 4); assert.equal(backdrop.paints, 2); assert.deepEqual(counters, warmed);
  assert(backdrop.range.visible);
});

test('range culling uses the full quad envelope with a pixel margin and handles resizing and reentry', t => {
  const { backdrop, counters } = scene(t), ground = valley(), zoom = .18,
    at = lift => {
      const x = 8, y = backdrop.relief.low(x, 512) + lift;
      backdrop.update({ x, y, zoom, width: backdrop.width, height: backdrop.height });
    };
  backdrop.setScene(ground);
  // Warm the highest raster grade first: this case isolates culling from quality promotion on resize.
  backdrop.update({ ...view(ground, 8, 650), y: backdrop.relief.low(8, 512) }); at(0);
  const plane = backdrop.range, base = plane.y, top = plane.y + plane.scale.y * plane.geometry.positions[1];
  at(1);
  const depth = plane.y - base, above = (backdrop.height + 2 - top) / depth, below = (-2 - base) / depth;
  const textures = rangeTextures(backdrop), painted = { ...counters };
  at(above + .01); assert(!backdrop.range.visible);
  at(above - .01); assert(backdrop.range.visible);
  at(below - .01); assert(!backdrop.range.visible);
  at(below + .01); assert(backdrop.range.visible);
  backdrop.resize(900, 8000); at(0); assert(backdrop.range.visible);
  backdrop.resize(900, 550); at(0); assert(backdrop.range.visible);
  assert.equal(backdrop.paints, 1); assert.deepEqual(rangeTextures(backdrop), textures); assert.deepEqual(counters, painted);
});

test('one thousand moving camera frames place the backdrop without canvas work, a new texture or a rewritten corner', t => {
  let releases = 0;
  const { backdrop, counters } = scene(t, () => { releases++; }), ground = valley();
  backdrop.setScene(ground, 'clear'); backdrop.update(view(ground, 8), 0);
  // The clouds are one sheet and the range of a biome one strip.
  assert.deepEqual(counters.canvases, 1, 'only the range strip need canvases'); assert.equal(backdrop.paints, 1);
  const made = { ...counters }, textures = rangeTextures(backdrop), sky = backdrop.sky.texture, parts = backdrop.root.children.length,
    corners = Array.from(backdrop.range.geometry.positions), before = placed(backdrop);
  assert.equal(textures.length, 1);
  for (let i = 0; i < 1000; i++)
    backdrop.update({ x: -900 + i * 1.8, y: ground.height(-900 + i * 1.8) + (i % 90), zoom: .07 * 1.0092 ** i, width: 900, height: 550 }, i / 60);
  assert.deepEqual(counters, made, 'camera movement must not allocate or repaint any canvas');
  assert.deepEqual(rangeTextures(backdrop), textures); assert.equal(backdrop.sky.texture, sky); assert.equal(backdrop.paints, 1);
  assert.equal(backdrop.root.children.length, parts); assert.equal(releases, 0);
  assert.deepEqual(Array.from(backdrop.range.geometry.positions), corners, 'a frame moves and scales a range: it rewrites no corner');
  assert.notDeepEqual(placed(backdrop), before);
  for (const texture of [...textures, sky]) assert.equal(texture.destroyed, false);
  for (const row of placed(backdrop)) assert(row.slice(0, 5).every(Number.isFinite));
});

test('the ranges and the clouds, drawn smaller than they are painted, are read from levels of their own size', t => {
  const { backdrop } = scene(t), ground = valley();
  backdrop.setScene(ground, 'clear');
  // From afar, on a phone held sideways and on a large screen, a range is drawn at a fraction of its strip and a low
  // cloud at a fraction of its sheet: read from the strip itself, the trees along a crest and the edges of a cloud
  // would shimmer as they slide. Each asks for its mipmaps, read between levels as well as within one.
  let least = Infinity;
  for (const [width, height] of [[812, 375], [900, 550], [1920, 1140]]) {
    backdrop.resize(width, height);
    for (let zoom = .1; zoom < 400; zoom *= 1.7) {
      backdrop.update({ ...view(ground, 8, zoom), width, height }, 0);
      least = Math.min(least, backdrop.range.scale.x, ...backdrop.clouds.map(cloud => Math.abs(cloud.sprite.scale.x)));
    }
  }
  assert(least < .5, `drawn at ${least} of their size`);
  for (const source of [...rangeTextures(backdrop).map(texture => texture.source), backdrop.cloudSource])
    assert.deepEqual([source.autoGenerateMipmaps, source.scaleMode, source.style.mipmapFilter], [true, 'linear', 'linear']);
});

test('cloud selection updates its sampled frame without reversing the sunlight', t => {
  const { backdrop } = scene(t); backdrop.setScene(valley(), 'clear');
  for (const { sprite } of backdrop.clouds) {
    const texture = sprite.texture;
    assert.equal(texture.uvs.x0, texture.frame.x / 1024);
    assert.equal(texture.uvs.x2, (texture.frame.x + 512) / 1024);
    assert.equal(texture.uvs.y0, texture.frame.y / 512);
    assert.equal(texture.uvs.y2, (texture.frame.y + 128) / 512);
  }
  for (const weather of ['clear', 'mist', 'haze']) for (const seed of [1, 6173, 930222]) {
    const ground = valley(seed); backdrop.setScene(ground, weather); backdrop.update(view(ground, 140, 20), 37.5);
    assert(backdrop.clouds.every(c => c.sprite.scale.x > 0 && c.sprite.scale.x === c.sprite.scale.y));
    assert.equal(new Set(backdrop.clouds.map(c => c.sprite.texture.frame.y)).size, 4);
    assert.equal(new Set(backdrop.clouds.map(c => `${c.sprite.texture.frame.x},${c.sprite.texture.frame.y}`)).size, 7,
      'clouds of the same type have distinct silhouettes in the same scene');
  }
});

test('where everything stands follows from the map, the camera and the time of the battle alone', t => {
  const { backdrop } = scene(t), other = new Backdrop(); t.after(() => other.destroy());
  const ground = valley(), camera = view(ground, 140, 20);
  other.resize(900, 550);
  for (const b of [backdrop, other]) { b.setScene(ground, 'clear'); b.update(camera, 37.5); }
  assert.deepEqual(placed(backdrop), placed(other));
  const cloud = () => backdrop.clouds.map(c => c.sprite.position.x), range = () => backdrop.range.position.x;
  // The wind carries the clouds and nothing else; the panorama slides less than the field.
  let clouds = cloud(), ranges = range(); backdrop.update(camera, 38.5);
  assert(cloud().every((x, i) => x !== clouds[i])); assert.deepEqual(range(), ranges);
  backdrop.update({ ...camera, x: camera.x + 10 }, 38.5);
  const slid = Math.abs(range() - ranges);
  assert(slid > 0 && slid < 10 * camera.zoom, 'the panorama slides less than the field');
  // The panorama has the same depth in both axes. Sky light is at infinity.
  backdrop.update(camera, 38.5); const sky = backdrop.sky.position.y, height = backdrop.range.y;
  backdrop.update({ ...camera, y: camera.y + 10 }, 38.5);
  assert(Math.abs(backdrop.range.y - height - slid) < 1e-6);
  assert.equal(backdrop.sky.position.y, sky); assert(backdrop.sun.position.y < sky);
  // Another map of the same biome has other clouds and other ranges.
  other.setScene(valley(6174), 'clear'); other.update(camera, 38.5); backdrop.update(camera, 38.5);
  assert.notDeepEqual(placed(other), placed(backdrop));
  // From so far that the field is a line, the ranges are gone and only the sky is left.
  backdrop.update({ ...camera, zoom: .08 }, 0); assert(!backdrop.range.visible);
  backdrop.update({ ...camera, zoom: .5 }, 0); assert(backdrop.range.visible && backdrop.range.alpha === 1);
});

test('vertical camera movement preserves cloud size and horizontal position, including hours into a distant battle', t => {
  const { backdrop } = scene(t), ground = valley(), far = 128000, camera = { ...view(ground, 140, 20), x: far },
    clouds = () => backdrop.clouds.map(c => ({ x: c.sprite.position.x, wide: c.sprite.width, tall: c.sprite.height }));
  backdrop.setScene(ground, 'clear');
  for (const [width, height] of [[1600, 900], [915, 412], [390, 844]]) for (const time of [0, 600, 3600, 36000]) {
    backdrop.resize(width, height);
    backdrop.update(camera, time); const before = clouds(), sky = backdrop.sky.position.y,
      heights = backdrop.clouds.map(c => c.sprite.y);
    backdrop.update({ ...camera, y: camera.y + 1 }, time); const after = clouds();
    assert.equal(backdrop.sky.position.y, sky); assert.deepEqual(after, before);
    for (const [i, cloud] of backdrop.clouds.entries()) assert(cloud.sprite.y > heights[i] && cloud.sprite.y - heights[i] < .1);
    for (const lift of [-10000, -30, 0, 30, 10000]) {
      backdrop.update({ ...camera, y: camera.y + lift }, time);
      assert.deepEqual(clouds(), before, 'stable dimensions and x at every camera altitude');
    }
    // And a camera that goes ten metres along the field moves them far less than it moves the field.
    backdrop.update({ ...camera, x: far + 10 }, time);
    for (const [i, cloud] of clouds().entries()) assert(Math.abs(cloud.x - before[i].x) < 10, 'the clouds are far away');
    for (const cloud of after) assert(cloud.x > -cloud.wide / 2 - 1e-6 && cloud.x < width + cloud.wide / 2 + 1e-6, 'a cloud goes round from one edge of the screen to the other');
  }
});

test('valley scenery has immutable geometry and a textured foot below the viewport, independently of pan and zoom', t => {
  const { backdrop, counters } = scene(t), ground = new Terrain('plateau', { seed: 6173, length: 4000 }),
    camera = { x: -1160, y: ground.height(-1160) + 7, zoom: 12, width: 1465, height: 427 };
  backdrop.resize(camera.width, camera.height); backdrop.setScene(ground, 'clear'); backdrop.update(camera, 1);
  const near = backdrop.range, positions = near.geometry.positions,
    textures = rangeTextures(backdrop), painted = { ...counters }, uvs = Array.from(near.geometry.uvs), foot = positions[5],
    updates = t.mock.method(near.geometry.getBuffer('aPosition'), 'update');
  assert.equal(positions.length, 8, 'one quad with no solid skirt'); assert.equal(foot, 0);
  assert(near.y > camera.height + 4, 'the image itself extends below the view');
  const before = Array.from(positions);
  for (const lift of [-10000, -30, 0, 30, 10000, 0]) backdrop.update({ ...camera, y: camera.y + lift }, 1);
  assert.deepEqual(Array.from(positions), before); assert.equal(updates.mock.callCount(), 0);
  assert.deepEqual(rangeTextures(backdrop), textures); assert.deepEqual(counters, painted);
  const close = { ...camera, zoom: 650, y: ground.height(camera.x) + .02 };
  backdrop.update(close, 1);
  assert.deepEqual(Array.from(positions), before, 'zoom also leaves every corner unchanged');
  assert(near.y > camera.height + 4); assert.equal(updates.mock.callCount(), 0);
  backdrop.update(close, 1); assert.equal(updates.mock.callCount(), 0);
  assert.deepEqual(Array.from(near.geometry.uvs), uvs);
});

test('a border of the world paints each of its two biomes once, however often the camera crosses it', t => {
  let releases = 0, retiring = [];
  const { backdrop, counters } = scene(t, () => {
    releases++; assert(retiring.length, 'nothing is released before something is replaced');
    for (const texture of retiring) {
      assert.equal(texture.destroyed, false); assert.equal(texture.source.destroyed, false);
      assert(!rangeTextures(backdrop).includes(texture), 'replace what a range draws before releasing its old sampler');
      assertNotSampled(backdrop, texture);
    }
  });
  const world = new Terrain('world', { seed: 6173, length: 64000 }), i = world.biomes.findIndex(r => r.start > world.minX + 2000 && r.end < world.maxX - 2000),
    border = world.biomes[i].start, next = world.biomes[i].end, at = x => backdrop.update(view(world, x, 6), 0);
  backdrop.setScene(world, 'clear');
  at(border - 2 * WORLD_BLEND); assert.equal(backdrop.paints, 1);
  assert(backdrop.range.visible);
  assertRangeWeights(backdrop, [[world.biomes[i - 1], 1]]);
  at(border - WORLD_BLEND / 2); assert.equal(backdrop.paints, 2);
  assert(backdrop.range.visible && backdrop.range.alpha === 1);
  assertRangeWeights(backdrop, [[world.biomes[i - 1], .84375], [world.biomes[i], .15625]]);
  const canvases = counters.canvases, textures = rangeTextures(backdrop); let share = 0;
  for (let k = 0; k < 40; k++) for (const x of [border - 90, border - 30, border - 1e-6, border, border + 30, border + 90, border + 2 * WORLD_BLEND, border - 2 * WORLD_BLEND]) {
    at(x); if (Math.abs(x - border) < 1e-3) { assertRangeWeights(backdrop, [[world.biomes[i - 1], .5], [world.biomes[i], .5]], 1e-6); share++; }
  }
  assert.equal(share, 80); assert.equal(backdrop.paints, 2); assert.equal(counters.canvases, canvases); assert.equal(releases, 0);
  assert.deepEqual(rangeTextures(backdrop), textures);
  // A third biome takes the place of the one left behind, whose image is freed after the renderer lets go of them.
  at(border + 2 * WORLD_BLEND); retiring = [backdrop.cache.find(entry => entry.place === world.biomes[i - 1]).texture];
  assert.equal(retiring.length, 1);
  at(next - WORLD_BLEND / 2);
  assert.equal(backdrop.paints, 3); assert.equal(releases, 1); assert.equal(counters.canvases, canvases + 1);
  for (const texture of retiring) { assert.equal(texture.destroyed, true); assert.equal(texture.source, null); }
  assert.equal(rangeTextures(backdrop).length, 2);
});

test('jumps between biome centres keep both cached ranges and replace the least recently used one', t => {
  let releases = 0;
  const { backdrop, counters } = scene(t, () => { releases++; }), world = new Terrain('world', { seed: 6173, length: 64000 }),
    [a, b, c] = world.biomes.filter(region => region.start > world.minX && region.end < world.maxX),
    at = region => backdrop.update(view(world, (region.start + region.end) / 2, 6)),
    textures = region => [backdrop.cache.find(entry => entry.place === region).texture];
  backdrop.setScene(world); at(a); at(b);
  assert.equal(backdrop.paints, 2); assert.equal(backdrop.cache.filter(entry => entry.place).length, 2);
  const first = textures(a), second = textures(b), painted = { ...counters };
  for (let i = 0; i < 20; i++) { at(a); at(b); }
  assert.equal(backdrop.paints, 2); assert.equal(releases, 0); assert.deepEqual(counters, painted);
  assert.deepEqual(textures(a), first); assert.deepEqual(textures(b), second);
  // A was just shown: C replaces B, even though A occupies the first cache entry.
  at(a); at(c);
  assert.equal(backdrop.paints, 3); assert.equal(releases, 1);
  assert.deepEqual(textures(a), first); assert(first.every(texture => !texture.destroyed));
  assert(second.every(texture => texture.destroyed)); assert(backdrop.cache.some(entry => entry.place === c));
  assert.equal(backdrop.cache.length, 2); assert.equal(rangeTextures(backdrop).length, 2);
});

test('a jump into a reverse border reserves the cached neighbour before replacing a range', t => {
  const { backdrop, counters } = scene(t), world = new Terrain('world', { seed: 6173, length: 64000 }),
    [a, b, c] = world.biomes.filter(region => region.start > world.minX && region.end < world.maxX),
    at = x => backdrop.update(view(world, x, 6));
  backdrop.setScene(world); at((b.start + b.end) / 2); at((c.start + c.end) / 2);
  const neighbour = backdrop.cache.find(entry => entry.place === b), kept = [neighbour.texture],
    retired = [backdrop.cache.find(entry => entry.place === c).texture];
  at(a.end - WORLD_BLEND / 2);
  assert.equal(backdrop.paints, 3); assert.deepEqual([neighbour.texture], kept);
  assert(kept.every(texture => !texture.destroyed)); assert(retired.every(texture => texture.destroyed));
  assert(backdrop.range.visible);
  assertRangeWeights(backdrop, [[a, .84375], [b, .15625]]);
  const painted = { ...counters }, textures = rangeTextures(backdrop);
  at(b.start + WORLD_BLEND / 2); assertRangeWeights(backdrop, [[a, .15625], [b, .84375]]);
  at(b.start); assertRangeWeights(backdrop, [[a, .5], [b, .5]]);
  for (let i = 0; i < 20; i++) { at(a.end - WORLD_BLEND / 2); at(b.start + WORLD_BLEND / 2); }
  assert.equal(backdrop.paints, 3); assert.deepEqual(counters, painted); assert.deepEqual(rangeTextures(backdrop), textures);
});

test('biome weights are continuous in both directions with reversed cache order and different raster grades', t => {
  const { backdrop, counters } = scene(t), other = new Backdrop(null, backdrop.art),
    world = new Terrain('world', { seed: 6173, length: 64000 }),
    [a, b] = world.biomes.filter(region => region.start > world.minX && region.end < world.maxX),
    centre = region => (region.start + region.end) / 2,
    warm = (target, region, zoom) => target.update(view(world, centre(region), zoom)),
    camera = view(world, a.end, .18), border = a.end,
    offsets = [-WORLD_BLEND - 1e-6, -WORLD_BLEND, -WORLD_BLEND + 1e-6,
      -WORLD_BLEND / 2, -1e-6, 0, 1e-6, WORLD_BLEND / 2,
      WORLD_BLEND - 1e-6, WORLD_BLEND, WORLD_BLEND + 1e-6];
  t.after(() => other.destroy()); other.resize(900, 550);
  for (const target of [backdrop, other]) target.setScene(world, 'clear');
  warm(backdrop, a, 28); warm(backdrop, b, .18);
  warm(other, b, .18); warm(other, a, 28);
  assert.deepEqual(backdrop.cache.map(entry => entry.place), [a, b]);
  assert.deepEqual(other.cache.map(entry => entry.place), [b, a]);
  for (const target of [backdrop, other]) {
    assert.equal(target.cache.find(entry => entry.place === a).resolution, 1);
    assert.equal(target.cache.find(entry => entry.place === b).resolution, .25);
    assert.equal(target.root.children.at(-1), target.range, 'one panorama follows the sky and clouds');
    assert.equal(target.root.children.filter(part => part.shader).length, 1, 'no duplicate panoramas remain');
    assert(target.cache.every(entry => !('host' in entry) && !('meshes' in entry) && !('textures' in entry)), 'the cache keeps one image per region, without display objects');
  }
  const made = { ...counters }, originals = [rangeTextures(backdrop), rangeTextures(other)],
    ranges = [backdrop.range, other.range],
    geometry = ranges.map(mesh => t.mock.method(mesh.geometry.getBuffer('aPosition'), 'update')),
    uvs = ranges.map(mesh => t.mock.method(mesh.geometry.getBuffer('aUV'), 'update'));
  for (let lap = 0; lap < 10; lap++) for (const offset of [...offsets, ...offsets.toReversed()]) {
    const x = border + offset, u = Math.max(0, Math.min(1, (offset + WORLD_BLEND) / (2 * WORLD_BLEND))),
      right = u * u * (3 - 2 * u), expected = [[a, 1 - right], [b, right]].filter(([, weight]) => weight > 0);
    for (const target of [backdrop, other]) {
      // Keep the camera fixed: only the region shown changes. This isolates the
      // blend from pan, parallax, culling and knowledge of unseen ground.
      target.update(camera, 0, x); assertRangeWeights(target, expected);
      assert(Math.abs(target.range.alpha - (.18 - .1) / .3) < 1e-12, 'zoom fades the composed panorama equally for both regions');
    }
    assert.deepEqual(rangeWeights(backdrop), rangeWeights(other));
  }
  // The inputs swap at the border; their physical weights have no jump there,
  // or where a neighbour starts or stops being needed at either fade endpoint.
  for (const at of [-WORLD_BLEND, 0, WORLD_BLEND]) {
    const weights = [];
    for (const side of [-1e-6, 1e-6]) {
      backdrop.update(camera, 0, border + at + side);
      weights.push(new Map(rangeWeights(backdrop)).get(b) || 0);
    }
    assert(Math.abs(weights[0] - weights[1]) < 1e-7);
  }
  assert.deepEqual(counters, made, 'a transition writes no raster, even with different source resolutions');
  for (const [i, target] of [backdrop, other].entries()) {
    assert.equal(target.paints, 2); assert.equal(target.range, ranges[i]);
    assert.deepEqual(rangeTextures(target), originals[i]);
  }
  assert(geometry.every(mock => mock.mock.callCount() === 0));
  assert(uvs.every(mock => mock.mock.callCount() === 0));
});

test('evicting a biome and promoting both inputs detaches every retiring sampler before release', t => {
  let retiring = [], releases = 0;
  const { backdrop } = scene(t, () => {
    releases++;
    assert(retiring.length);
    for (const texture of retiring) {
      assert.equal(texture.destroyed, false); assert.equal(texture.source.destroyed, false);
      assert(!rangeTextures(backdrop).includes(texture)); assertNotSampled(backdrop, texture);
    }
  }), world = new Terrain('world', { seed: 6173, length: 64000 }),
    [a, b, c] = world.biomes.filter(region => region.start > world.minX && region.end < world.maxX),
    at = (x, zoom = .18) => backdrop.update(view(world, x, zoom)),
    textures = region => [backdrop.cache.find(entry => entry.place === region).texture];
  backdrop.setScene(world); at(a.end);
  assertRangeWeights(backdrop, [[a, .5], [b, .5]]);
  retiring = [...textures(a), ...textures(b)];
  at(a.end, 28); assert.equal(releases, 1);
  assert(retiring.every(texture => texture.destroyed));
  assertRangeWeights(backdrop, [[a, .5], [b, .5]]);
  retiring = textures(a);
  at(b.end - WORLD_BLEND / 2, 28); assert.equal(releases, 2);
  assert(retiring.every(texture => texture.destroyed));
  assertRangeWeights(backdrop, [[b, .84375], [c, .15625]]);
  // A sole region must occupy both inputs, rather than leave the outgoing
  // region attached to a sampler whose present weight happens to be zero.
  retiring = textures(b);
  at(c.end + 2 * WORLD_BLEND, 28); assert.equal(releases, 3);
  assert(retiring.every(texture => texture.destroyed));
  assert.equal(backdrop.range.shader.resources.uFirst, backdrop.range.shader.resources.uSecond);
  assert.equal(backdrop.range.shader.resources.blendUniforms.uniforms.uShare, 0);
});

test('each cached biome promotes its panorama once without evicting its neighbour', t => {
  const { backdrop, counters } = scene(t), world = new Terrain('world', { seed: 6173, length: 64000 }),
    [a, b] = world.biomes.filter(region => region.start > world.minX && region.end < world.maxX),
    at = (region, zoom) => backdrop.update(view(world, (region.start + region.end) / 2, zoom)),
    textures = region => [backdrop.cache.find(entry => entry.place === region).texture];
  backdrop.setScene(world); at(a, .18); at(b, .18);
  const smallA = textures(a), smallB = textures(b);
  at(a, 6); assert.equal(backdrop.paints, 3);
  assert(smallA.every(texture => texture.destroyed)); assert.deepEqual(textures(b), smallB);
  at(b, 6); assert.equal(backdrop.paints, 4); assert(smallB.every(texture => texture.destroyed));
  const full = rangeTextures(backdrop), painted = { ...counters };
  assert(full.every(texture => texture.source.pixelWidth === 2048));
  for (let i = 0; i < 10; i++) for (const zoom of [.18, 6]) { at(a, zoom); at(b, zoom); }
  assert.equal(backdrop.paints, 4); assert.deepEqual(counters, painted); assert.deepEqual(rangeTextures(backdrop), full);
});

test('the ranges are those of the biome at the place told, when it is not where the camera is', t => {
  const { backdrop } = scene(t), world = new Terrain('world', { seed: 6173, length: 64000 }),
    i = world.biomes.findIndex((region, k) => k && region.id !== world.biomes[k - 1].id && region.start > world.minX + 2000 && region.end - region.start > 4 * WORLD_BLEND),
    there = world.biomes[i], here = world.biomes[i - 1], camera = view(world, there.start + 2 * WORLD_BLEND, 6);
  backdrop.setScene(world, 'clear');
  backdrop.update(camera, 0); assertRangeWeights(backdrop, [[there, 1]]);
  // The camera has not moved: whoever looks is told the ground of the region before it, and sees its hills.
  backdrop.update(camera, 0, here.end - 2 * WORLD_BLEND); assertRangeWeights(backdrop, [[here, 1]]);
});

test('weather, seed and map replacements release the previous textures after the sampler hook', t => {
  let releases = 0, retiring = [];
  const { backdrop } = scene(t, () => {
    releases++; assert(retiring.length, 'the first scene must not invoke the release hook');
    for (const texture of retiring) {
      assert.equal(texture.destroyed, false); assert.notEqual(backdrop.sky.texture, texture);
      assert(!rangeTextures(backdrop).includes(texture)); assertNotSampled(backdrop, texture);
    }
  });
  let ground = valley(); const show = () => backdrop.update(view(ground, 8), 0);
  backdrop.setScene(ground, 'clear'); show(); assert.equal(releases, 0);
  const variants = [[ground, 'mist', 2], [ground, 'haze', 2], [valley(6174), 'haze', 1], [valley(6174, 'arid-basin'), 'haze', 1], [new Terrain('sand'), 'haze', 1]];
  for (const [i, [next, weather, hooks]] of variants.entries()) {
    const sky = backdrop.sky.texture, strips = rangeTextures(backdrop), before = releases, paints = backdrop.paints;
    // Another weather is another sky at once; the ranges are repainted when the camera next shows them.
    retiring = hooks === 2 ? [sky] : []; ground = next; backdrop.setScene(ground, weather);
    assert.equal(sky.destroyed, hooks === 2); assert.equal(backdrop.sky.texture === sky, hooks === 1);
    retiring = strips; show();
    assert.equal(releases, before + hooks, `replacement ${i}`); assert.equal(backdrop.paints, paints + 1);
    for (const texture of strips) assert.equal(texture.destroyed, true);
    assert.equal(rangeTextures(backdrop).length, 1);
    // The same scene again makes nothing and frees nothing.
    const kept = rangeTextures(backdrop); retiring = [];
    backdrop.setScene(ground, weather); show(); show();
    assert.equal(releases, before + hooks); assert.equal(backdrop.paints, paints + 1); assert.deepEqual(rangeTextures(backdrop), kept);
  }
});

test('the fully prepared backdrop keeps bounded rasters even on unusually large views', t => {
  const { backdrop, canvas } = scene(t), ground = valley();
  backdrop.setScene(ground, 'clear'); backdrop.update(view(ground, 8, 80));
  for (const [width, height] of [[300, 280], [900, 550], [3500, 2200], [8000, 600], [500, 8000]]) {
    backdrop.resize(width, height);
    for (const zoom of [.07, 4, 80, 650]) for (const lift of [-200, 0, 30, 900]) {
      backdrop.update({ x: 8, y: ground.height(8) + lift, zoom, width, height }, 12);
      for (const row of placed(backdrop)) assert(row.slice(0, 5).every(Number.isFinite));
      // The sky covers the whole view whatever the camera frames.
      assert.equal(backdrop.sky.position.x, 0); assert.equal(backdrop.sky.scale.x, width);
      assert(backdrop.sky.scale.y >= .45 * height, 'the dome is never so low that the sun leaves a view of the sky');
    }
    assert.equal(backdrop.paints, 1);
    for (const texture of rangeTextures(backdrop)) assert.deepEqual([texture.source.pixelWidth, texture.source.pixelHeight], [2048, 512]);
    assert.deepEqual([backdrop.sky.texture.source.pixelWidth, backdrop.sky.texture.source.pixelHeight], [2, 256]);
    assert.deepEqual([backdrop.cloudSource.pixelWidth, backdrop.cloudSource.pixelHeight], [1024, 512]);
    assert.equal(backdrop.sunTexture.source.pixelWidth, 128);
  }
  assert.equal(backdrop.clouds.length, 7, 'a handful of clouds, each one sprite');
  // What is painted is the same every time: a strip for a range, a sheet of clouds.
  const strip = paintRange(canvas(), 'highlands', 'clear', 6173);
  assert.deepEqual([strip.canvas.width, strip.canvas.height], [2048, 512]);
  assert.equal(backdrop.cloudSource.uploadMethodId, 'image', 'clouds use their prepared image directly');
});


test('teardown frees every texture once', t => {
  let releases = 0;
  countingCanvas(t);
  const backdrop = new Backdrop(() => { releases++; }), ground = new Terrain('world', { seed: 6173, length: 64000 }),
    region = ground.biomes.find(region => region.start > ground.minX && region.end < ground.maxX);
  backdrop.resize(900, 550); backdrop.setScene(ground, 'mist'); backdrop.update(view(ground, region.end), 0);
  const textures = [...rangeTextures(backdrop), backdrop.sky.texture, backdrop.sunTexture], clouds = backdrop.cloudSource,
    textureDestruction = textures.map(texture => t.mock.method(texture, 'destroy')),
    sourceDestruction = textures.map(texture => t.mock.method(texture.source, 'destroy')),
    layers = [backdrop.range], programs = layers.map(mesh => mesh.shader.glProgram),
    geometryDestruction = layers.map(mesh => t.mock.method(mesh.geometry, 'destroy')),
    shaderDestruction = layers.map(mesh => t.mock.method(mesh.shader, 'destroy'));
  assert.equal(rangeTextures(backdrop).length, 2, 'each cache entry holds one panorama');
  backdrop.destroy();
  assert.equal(releases, 1); assert(textures.every(texture => texture.destroyed)); assert.equal(clouds.destroyed, true);
  assert(textureDestruction.every(mock => mock.mock.callCount() === 1));
  assert(sourceDestruction.every(mock => mock.mock.callCount() === 1));
  assert(geometryDestruction.every(mock => mock.mock.callCount() === 1));
  assert(shaderDestruction.every(mock => mock.mock.callCount() === 1));
  assert(programs.every(program => typeof program.vertex === 'string' && typeof program.fragment === 'string'), 'the cached shader program remains available to other backdrops');
  assert.equal(backdrop.root.destroyed, true); assert(layers.every(mesh => mesh.destroyed));
  assert.deepEqual(backdrop.cache, []); assert.equal(backdrop.range, null);
  // A renderer that never drew a scene has nothing to free.
  new Backdrop().destroy();
});

test('the sky is a gradient for each weather, lightest at the horizon', () => {
  const tone = (data, row) => [data[row * 8], data[row * 8 + 1], data[row * 8 + 2]], light = c => c[0] + c[1] + c[2];
  for (const weather of ['clear', 'haze', 'mist']) {
    const data = skyTones(weather);
    assert.equal(data.length, 2 * 256 * 4); assert.deepEqual(skyTones(weather), data);
    for (let row = 0; row < 256; row++) { assert.equal(data[row * 8 + 3], 255); assert.deepEqual(tone(data, row), [data[row * 8 + 4], data[row * 8 + 5], data[row * 8 + 6]]); }
    for (let row = 8; row < 256; row += 8) assert(light(tone(data, row)) >= light(tone(data, row - 8)), 'the sky pales towards the horizon');
    assert(light(tone(data, 255)) - light(tone(data, 0)) > 100);
  }
  // A clear sky is blue overhead; haze warms it and mist greys it.
  const [clear, haze, mist] = ['clear', 'haze', 'mist'].map(weather => tone(skyTones(weather), 0));
  assert(clear[2] - clear[0] > 40 && haze[2] - haze[0] < 20 && light(mist) > light(clear));
  assert.deepEqual(skyTones('snow'), skyTones('clear'));
});

test('ranges grow far less than the field as the camera closes in', () => {
  let previous = 0;
  for (let zoom = .07; zoom <= 650; zoom *= 1.3) {
    const scale = rangeScale(zoom); assert(scale >= .3 && scale <= 1.5 && scale >= previous); previous = scale;
  }
  assert(rangeScale(80) / rangeScale(4) < 3, 'twenty times nearer, the ranges are under three times as large');
});

test('dust is six wisps over dry ground near the camera, and none from afar or over wet ground', t => {
  countingCanvas(t);
  const dust = new AmbientDust(), twin = new AmbientDust(); t.after(() => { dust.destroy(); twin.destroy(); });
  const dry = valley(6173, 'arid-basin'), wet = valley(), shown = () => dust.host.children.map(s => [s.position.x, s.position.y, s.scale.x, s.scale.y, s.alpha, s.tint]);
  assert.equal(dust.host.visible, false); dust.update(view(dry, 8, 30), 0); assert.equal(dust.host.visible, false, 'no scene, no dust');
  dust.setScene(dry, 'clear'); twin.setScene(dry, 'clear');
  assert.equal(dust.host.children.length, 6);
  const texture = dust.texture, before = dry.snapshot();
  for (let i = 0; i < 1000; i++) {
    const camera = view(dry, -700 + i * 1.3, 30, 2), time = i / 60;
    dust.update(camera, time); assert.equal(dust.host.visible, true);
    for (const sprite of dust.host.children) {
      assert(Math.abs(sprite.position.x - camera.x) <= 48 + 1e-6, 'wisps keep to a lap round the camera');
      const over = sprite.position.y - dry.height(sprite.position.x);
      assert(over > .1 && over < .7, 'they stay within the first metre above the ground');
      assert(Math.abs(Math.tan(sprite.rotation) - (dry.height(sprite.position.x + 4) - dry.height(sprite.position.x - 4)) / 8) < 1e-9, 'and lie along it');
      assert(sprite.alpha >= 0 && sprite.alpha <= .22 + 1e-9, 'and stay thin');
    }
  }
  assert.equal(dust.host.children.length, 6); assert.equal(dust.texture, texture);
  assert(dust.host.children.some(sprite => sprite.alpha > .1), 'some of it is seen');
  twin.update(view(dry, 120, 30, 2), 9); dust.update(view(dry, 120, 30, 2), 9); assert.deepEqual(shown(), twin.host.children.map(s => [s.position.x, s.position.y, s.scale.x, s.scale.y, s.alpha, s.tint]));
  // Seen whole from afar a wisp is under a pixel, and one that filled the screen would be a veil.
  for (const zoom of [.07, 1, 4.9, 270, 650]) { dust.update(view(dry, 120, zoom), 9); assert.equal(dust.host.visible, false, `dust at ${zoom} px/m`); }
  // Mist lays it, haze raises it.
  const strength = weather => { dust.setScene(dry, weather); return dust.amount(120).strength; };
  assert(strength('mist') < strength('clear') && strength('clear') < strength('haze'));
  dust.setScene(wet, 'clear'); dust.update(view(wet, 8, 30), 3); assert.equal(dust.host.visible, false, 'wet ground raises none');
  for (const [id, some] of [['sand', true], ['flat', false], ['mud', false]]) {
    const track = new Terrain(id); dust.setScene(track, 'clear'); dust.update(view(track, 12, 30), 3); assert.equal(dust.host.visible, some, id);
  }
  assert.deepEqual(dry.snapshot(), before);
});
