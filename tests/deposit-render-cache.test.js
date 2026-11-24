import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, GpuGraphicsContext, buildContextBatches } from 'pixi.js';
import { Terrain } from '../src/terrain.ts';
import { Renderer } from '../src/render.ts';
import { depositsOf, depositsNear } from '../src/deposits.ts';
import { strataPlan } from '../src/strata-art.ts';
import { drawSite } from '../src/deposit-art.ts';
import { anchorGraphics } from '../src/world-anchor.ts';
import { countingCanvas } from './scenery-canvas.js';

// The live field's generated sites. Several petroleum pools, including the
// one near x=6832, used to hand a NaN end corner to Pixi's triangulator. `pool`
// is the petroleum site nearest there.
const ground = new Terrain('world', { seed: 6173, length: 512000, center: 12 }), sites = depositsOf(ground),
  pool = sites.filter(site => site.feature === 'lowland').reduce((a, b) => Math.abs(a.x - 6832) < Math.abs(b.x - 6832) ? a : b);
function geometry(graphic) {
  const built = new GpuGraphicsContext();
  try {
    buildContextBatches(graphic.context, built);
    const { vertices, indices } = built.geometryData;
    assert(vertices.every(Number.isFinite), 'every tessellated vertex must be finite');
    assert(indices.every(index => Number.isInteger(index) && index >= 0 && index < vertices.length / 2));
    return { vertices: [...vertices], indices: [...indices] };
  } finally { built.destroy(); }
}
function renderer(t) {
  const world = new Container(), terrain = world.addChild(new Container()), soil = terrain.addChild(new Container()),
    works = terrain.addChild(new Container()), shadows = world.addChild(new Graphics()),
    r = { ground, terrain, world, shadows, camera: { x: 6832, width: 859, height: 742, zoom: .18 },
      terrainScene: { layers: { soil, works }, plan: strataPlan(ground) } };
  t.after(() => world.destroy({ children: true, context: true }));
  return r;
}
const draw = (r, veins, now) => Renderer.prototype.drawDeposits.call(r, veins, now);
// How many posts a drawing of them holds: the poles of all of them are the shapes of its first fill.
const drawnPosts = graphic => graphic.context.instructions[0]?.data.path.shapePath.shapePrimitives.length ?? 0;
function drawings(r, id) {
  const art = r.depositSites.get(id);
  assert(art);
  const point = depositsOf(r.ground).find(site => site.id === id), anchor = [point.x, r.ground.height(point.x)];
  return Object.fromEntries([['siteWorks', art.works], ['siteFront', art.front], ...Object.entries(art.vein || {})].map(([name, graphic]) => {
    assert.deepEqual([graphic.x, graphic.y], anchor);
    return [name, geometry(graphic)];
  }));
}

test('all natural petroleum pools keep finite tessellated corners at near and overview scales', () => {
  // Every low wet ground of the world drawn as a site of petroleum, those that are none too: the one at x=6832 among them.
  const pools = ground.features.filter(feature => feature.kind === 'lowland')
    .map(feature => ({ id: 'petroleo:' + feature.peak, x: feature.peak, material: 'petroleo', feature: 'lowland', reserve: 60000 }));
  assert(pools.some(site => Math.round(site.x) === 6832));
  for (const site of pools) for (const pixel of [50, 10, 1 / .18, .25, 1 / 80]) {
    const parts = Object.fromEntries(['works', 'front'].map(name => [name, anchorGraphics(new Graphics(), site.x, ground.height(site.x))]));
    try {
      drawSite(parts, site, ground, pixel);
      for (const graphic of Object.values(parts)) geometry(graphic);
    } finally { for (const graphic of Object.values(parts)) graphic.destroy({ context: true }); }
  }
});

test('deposit drawings remain anchored and identical after panning out, returning and changing known reserve', t => {
  const r = renderer(t), site = pool;
  let now = 100;
  for (const zoom of [.18, 1, 20, 80]) for (const share of [1, .55, .05, 0, null, .55]) {
    r.camera.x = site.x; r.camera.zoom = zoom;
    const veins = share === null ? [] : [{ ...site, left: site.reserve * share, stock: share === .55 ? 12000 : 0,
      loading: share === .55, extracting: share === .05 }];
    draw(r, veins, now += 2);
    const before = drawings(r, site.id);
    r.camera.x = site.x + 40000;
    draw(r, veins, now += 2); assert(!r.depositSites.has(site.id));
    r.camera.x = site.x;
    draw(r, veins, now += 2);
    assert.deepEqual(drawings(r, site.id), before, 'reentering a site cannot retain corrupted or displaced geometry');
    for (const fading of r.depositFading) for (const graphic of fading.parts) geometry(graphic);
  }
});

test('from afar the sites are not drawn one by one: the posts of the veins known are one drawing, the same on return', t => {
  const r = renderer(t), site = pool, around = depositsNear(sites, site.x, 6000),
    veins = around.filter((_, i) => i % 2).map(point => ({ ...point, left: point.reserve * .5, stock: 0 }));
  r.camera.x = site.x; r.camera.zoom = .18; draw(r, veins, 100);
  assert(r.depositSites.size > 0, 'near, every site is a drawing of its own');
  for (const zoom of [.1, .02]) {
    r.camera.x = site.x; r.camera.zoom = zoom; draw(r, veins, 102);
    assert.equal(r.depositSites.size, 0, 'from afar no site is'); assert(r.depositPosts.visible);
    const posts = geometry(r.depositPosts), told = drawnPosts(r.depositPosts);
    assert(told >= veins.filter(vein => Math.abs(vein.x - site.x) < r.camera.width / zoom).length, 'a post for every vein known about the view');
    // Panning within the stretch laid out draws nothing again; away and back, the posts are as they were.
    const context = r.depositPosts.context, instructions = context.instructions.length;
    r.camera.x = site.x + r.camera.width / zoom / 4; draw(r, veins, 104); assert.equal(context.instructions.length, instructions);
    r.camera.x = site.x + 200000; draw(r, veins, 106); r.camera.x = site.x; draw(r, veins, 108);
    assert.deepEqual(geometry(r.depositPosts), posts);
  }
  // Without a vein known about the view there is no post, and near again the sites are drawn one by one.
  r.camera.zoom = .1; draw(r, [], 110); assert.equal(drawnPosts(r.depositPosts), 0);
  r.camera.zoom = .18; draw(r, veins, 112); assert(!r.depositPosts.visible && r.depositSites.size > 0);
});

test('a renewed terrain redraws deposits even when the new field reuses their IDs', t => {
  const r = renderer(t), site = pool, veins = [{ ...site, left: site.reserve * .5 }];
  r.camera.x = site.x; draw(r, veins, 100);
  const before = drawings(r, site.id), art = r.depositSites.get(site.id);
  r.ground = new Terrain('world', ground.reference());
  r.terrainScene.plan = strataPlan(r.ground);
  draw(r, veins, 102);
  assert.equal(r.depositSites.get(site.id), art);
  assert.equal(art.laid.ground, r.ground);
  assert.deepEqual(drawings(r, site.id), before);
  r.ground = new Terrain('world', { ...ground.reference(), center: ground.center + 1000 });
  r.terrainScene.plan = strataPlan(r.ground);
  const moved = depositsOf(r.ground).find(point => point.id === site.id);
  r.camera.x = moved.x;
  draw(r, [{ ...moved, left: moved.reserve * .5 }], 104);
  assert.equal(r.depositSites.get(site.id), art);
  assert.equal(art.laid.ground, r.ground);
  assert.equal(art.works.x, moved.x);
  assert.equal(art.works.y, r.ground.height(moved.x));
  drawings(r, site.id);
});

test('a discovered refined drop descends on field time through cached deposit frames and releases its one drawing', t => {
  const { counters } = countingCanvas(t), r = renderer(t), drop = { id: 'airdrop:1', type: 'airdrop', feature: 'airdrop',
    refined: true, x: 128012, supplies: { ferro: 48000, ligas: 16000, silica: 12000, combustivel: 4000 },
    arrivesAt: 1060, expiresAt: 2000, phase: 'announcement', active: false }, veins = [drop];
  Object.assign(r, { textures: new Map(), usedTextures: new Set(), texture: Renderer.prototype.texture,
    pilePicture: Renderer.prototype.pilePicture, releaseSamplers() {} });
  t.after(() => { for (const { texture } of r.textures.values()) texture.destroy(true); });
  r.camera.x = drop.x; r.camera.y = ground.height(drop.x) + 140; r.camera.zoom = 2;
  const frame = (time, now = 100) => Renderer.prototype.drawDeposits.call(r, veins, now, time);
  frame(999); assert.equal(r.airdropDescent, null, 'no load is drawn before the final minute');
  frame(1000);
  const graphic = r.airdropDescent.graphic, canopy = r.airdropDescent.canopy, context = canopy.context, mesh = geometry(canopy), first = { x: graphic.x, y: graphic.y },
    load = r.airdropDescent.load, packageSize = [load.width, load.height];
  let packageTexture = load.texture, painted = { ...counters };
  assert(graphic.visible); assert(mesh.indices.length > 0);
  frame(1020);
  assert.equal(r.airdropDescent.graphic, graphic); assert.equal(canopy.context, context);
  assert(graphic.y < first.y, 'the animation advances even when the static deposit cache returns early');
  assert.deepEqual(geometry(canopy), mesh, 'descent changes the transform, not the geometry');
  assert.deepEqual(counters, painted, 'moving the package never repaints its cached crates and cans');
  const paused = [graphic.x, graphic.y, graphic.rotation];
  frame(1020, 600); assert.deepEqual([graphic.x, graphic.y, graphic.rotation], paused, 'a field pause does not use the presentation wall clock');
  r.camera.x += 40000; frame(1021); assert.equal(graphic.visible, false, 'outside the camera the cached drawing is culled');
  Renderer.prototype.releaseTextures.call(r, true);
  assert(packageTexture.destroyed, 'ordinary texture eviction can release an offscreen load');
  r.camera.x = drop.x; frame(1059.9);
  assert.equal(r.airdropDescent.graphic, graphic); assert(graphic.visible);
  assert.notEqual(load.texture, packageTexture, 'the returning sprite rebinds its released picture');
  packageTexture = load.texture; painted = { ...counters };
  assert(Math.abs(graphic.y - r.airdropDescent.foot - .4) < 1e-9, 'the load approaches the same ground footing as the landed pallet');
  frame(1060); assert(graphic.destroyed && load.destroyed); assert.equal(r.airdropDescent, null, 'arrival releases the descending load and sprite');
  assert.equal(packageTexture.destroyed, false, 'the shared package texture belongs to the renderer');
  Renderer.prototype.drawDeposits.call(r, [{ ...drop, phase: 'collection', active: true }], 601, 1060);
  assert(geometry(r.depositSites.get(drop.id).vein.front).indices.length > 0, 'the pickup band has finite tessellated geometry');
  const landed = r.depositSites.get(drop.id).load;
  assert([landed.width, landed.height].every(n => Number.isFinite(n) && n > 0), 'the shared package sprite has finite dimensions');
  assert(Renderer.prototype.markHeight.call(r, drop.x, drop.id) >= landed.y + landed.height, 'the label stands above the visible package');
  assert.equal(Renderer.prototype.markHeight.call(r, drop.x), ground.height(drop.x), 'ordinary terrain markers keep their height');
  assert.equal(landed.texture, packageTexture, 'the descending and landed package share the same cached picture');
  assert.deepEqual([landed.width, landed.height], packageSize);
  assert.deepEqual(counters, painted, 'landing does not raster the same stock a second time');
  const almostSame = { ...drop, phase: 'collection', active: true,
    supplies: { ferro: 47999, ligas: 16000, silica: 12000, combustivel: 4000 } };
  Renderer.prototype.drawDeposits.call(r, [almostSame], 602, 1061);
  assert.equal(r.depositSites.get(drop.id).load, landed);
  assert.deepEqual(counters, painted, 'a remaining balance within the same picture category retains the sprite and texture');
  Renderer.prototype.drawDeposits.call(r, [{ ...almostSame, supplies: { ferro: 1000, ligas: 0, silica: 0, combustivel: 0 } }], 603, 1062);
  assert.notEqual(landed.texture, packageTexture, 'a real package-category change paints a new bounded picture');
  const partial = { ...counters };
  Renderer.prototype.drawDeposits.call(r, [{ ...almostSame, supplies: { ferro: 999, ligas: 0, silica: 0, combustivel: 0 } }], 604, 1063);
  assert.deepEqual(counters, partial);
  Renderer.prototype.drawDeposits.call(r, null, 605, 1063);
  Renderer.prototype.releaseTextures.call(r, true);
  assert(landed.texture.destroyed);
  Renderer.prototype.drawDeposits.call(r, [{ ...almostSame, supplies: { ferro: 999, ligas: 0, silica: 0, combustivel: 0 } }], 606, 1063);
  assert.equal(r.depositSites.get(drop.id).load, landed);
  assert.equal(landed.texture.destroyed, false, 'the early deposit cache cannot retain a destroyed package texture after hiding');
  frame(1030); const recreated = r.airdropDescent.graphic;
  Renderer.prototype.drawDeposits.call(r, null, 700, 1030);
  assert(recreated.destroyed); assert.equal(r.airdropDescent, null, 'leaving the shared faction view releases the load');
});
