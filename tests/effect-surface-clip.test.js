import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Mesh, ParticleContainer, Particle, Point, Sprite, Texture } from 'pixi.js';
import { EffectSurfaceClip, effectSurfaceStrip } from '../src/effect-surface-clip.ts';
import { Terrain } from '../src/terrain.ts';
import { Renderer } from '../src/render.ts';
import { Effects } from '../src/effects.ts';
import { ScorchMarks } from '../src/ground-scorch.ts';

const camera = extra => ({ x: 0, y: 2, width: 1280, height: 720, zoom: 65, ...extra });
// The outline is counted from the left end of the stretch it covers: a place of the world is told from there. A mesh of
// the shared geometry, as each mask is, tells what its triangles hold.
const probes = new WeakMap();
const above = (clip, x, y) => {
  if (!probes.has(clip)) probes.set(clip, new Mesh({ geometry: clip.geometry, texture: Texture.WHITE }));
  return probes.get(clip).containsPoint(new Point(x - clip.bounds.left, y));
};
// The places of the outline a strip lays its quads on, counted from where it begins.
const outline = strip => Array.from({ length: strip.count }, (_, i) => ({ x: strip.corners[i * 4], y: strip.corners[i * 4 + 1] }));
function setup(t) {
  const clip = new EffectSurfaceClip();
  t.after(() => clip.destroy()); return clip;
}
function profile(points) {
  return { points, height(x) {
    if (x <= points[0].x) return points[0].y;
    for (let i = 1; i < points.length; i++) if (x <= points[i].x) {
      const a = points[i - 1], b = points[i]; return a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x);
    }
    return points.at(-1).y;
  } };
}

test('the mask preserves every contact sample, including thin peaks and depressed valleys', t => {
  const terrain = profile([{ x: -10, y: 1 }, { x: 0, y: 1 }, { x: 1.999, y: 1 }, { x: 2, y: 4 },
    { x: 2.001, y: 1 }, { x: 3, y: -2 }, { x: 4, y: 1 }, { x: 10, y: 1 }]), before = JSON.stringify(terrain.points),
    strip = effectSurfaceStrip(terrain, { left: -.5, right: 5.5, top: 10 }), clip = setup(t), laid = outline(strip);
  assert.deepEqual(laid.slice(1, -1), terrain.points.filter(p => p.x > -.5 && p.x < 5.5).map(p => ({ x: Math.fround(p.x + .5), y: Math.fround(p.y) })));
  assert.equal(laid[0].y, Math.fround(terrain.height(-.5))); assert.equal(laid.at(-1).y, Math.fround(terrain.height(5.5)));
  assert.deepEqual([laid[0].x, laid.at(-1).x, strip.bounds.top], [0, 6, 10]);
  clip.update(terrain, camera({ x: 2, zoom: 650 }));
  // The corners are kept to a float's precision, as any drawing's are: on the sides of the peak, a thousand metres up
  // to each across, the line between two corners stands where those corners put it.
  const corners = profile(outline({ corners: clip.corners, count: clip.count }));
  for (const x of [-3, .5, 1.9995, 2, 2.0005, 2.7, 3, 3.5, 6]) {
    const y = corners.height(x - clip.bounds.left); assert(Math.abs(y - terrain.height(x)) < .05);
    assert.equal(above(clip, x, y - .00001), false); assert.equal(above(clip, x, y + .00001), true);
  }
  assert.equal(JSON.stringify(terrain.points), before, 'the visual clip cannot change the mechanical outline');
});

test('flat, slope and seeded valley masks reject pixels below the real surface at normal and close zoom', t => {
  const clip = setup(t);
  for (const [id, x] of [['flat', 12], ['hills', 37], ['wet-valley', -121], ['rural-ridges', 12]]) {
    const terrain = new Terrain(id), before = JSON.stringify(terrain.snapshot());
    for (const zoom of [65, 260]) {
      const view = camera({ x, y: terrain.height(x) + 2, zoom }); clip.update(terrain, view);
      for (let pixel = 0; pixel < view.width; pixel++) {
        const worldX = view.x + (pixel + .5 - view.width / 2) / zoom, ground = terrain.height(worldX), halfPixel = .5 / zoom;
        assert.equal(above(clip, worldX, ground - halfPixel), false, `${id} underground column ${pixel}`);
        assert.equal(above(clip, worldX, ground + halfPixel), true, `${id} aboveground column ${pixel}`);
      }
    }
    assert.equal(JSON.stringify(terrain.snapshot()), before);
  }
});

test('all ambient and actor hosts use stencil and share one cached geometry without moving their layers', t => {
  const clip = setup(t), world = new Container(), root = new Container(), ambient = new Container(), hosts = [ambient];
  world.addChild(root, ambient); root.sortableChildren = true;
  for (let i = 0; i < 6; i++) {
    const actor = new Container(), armor = new Container(), fx = new Container(); actor.zIndex = i * 100;
    actor.addChild(armor, fx); root.addChild(actor); hosts.push(fx);
  }
  const parents = hosts.map(host => host.parent), masks = hosts.map(host => clip.attach(host));
  clip.update(new Terrain('flat'), camera());
  for (const [i, host] of hosts.entries()) {
    assert.strictEqual(host.parent, parents[i]); assert.strictEqual(host.mask, masks[i]); assert.strictEqual(masks[i].geometry, clip.geometry);
    assert.equal(host.effects[0].pipe, 'stencilMask', 'the mask must use the stencil pipe rather than a filter alpha mask');
    assert(!host.filters?.length); assert.equal(masks[i].includeInBuild, false); assert.equal(masks[i].measurable, false);
  }
  root.sortChildren(); assert.deepEqual(root.children.map(child => child.zIndex), [0, 100, 200, 300, 400, 500]);
  assert(root.children.every(actor => !actor.mask && !actor.children[0].mask), 'only FX hosts may clip; vehicle and armor depth remain intact');
  clip.clear(); world.destroy({ children: true });
});

test('camera transforms apply once and clip the full glow footprint while its center stays untouched', t => {
  const clip = setup(t), world = new Container(), actor = new Container(), host = new Container(), glows = new Container(),
    flash = new Sprite(Texture.WHITE), terrain = new Terrain('hills'), x = 37, y = terrain.height(x) + .3;
  world.position.set(640 - x * 130, 360 + y * 130); world.scale.set(130, -130);
  world.addChild(actor); actor.addChild(host); host.addChild(glows); glows.addChild(flash);
  flash.position.set(x, y); flash.width = flash.height = 10; flash.alpha = .6;
  const mask = clip.attach(host); clip.update(terrain, camera({ x, y, zoom: 130 })); clip.sync();
  assert.equal(host.visible, true); assert.equal(flash.mask, undefined); assert.equal(glows.mask, undefined);
  for (const worldX of [35, 36, 37, 38, 39]) {
    const ground = terrain.height(worldX);
    for (const [offset, expected] of [[-.02, false], [.02, true]]) {
      const point = new Point(worldX, ground + offset), screen = world.toGlobal(point), local = mask.toLocal(screen);
      // The mask stands at the left end of its outline, and the place of the world is that far from it.
      assert.equal(mask.x, clip.bounds.left); assert.equal(mask.y, 0);
      assert(Math.abs(mask.x + local.x - point.x) < 1e-10 && Math.abs(local.y - point.y) < 1e-10);
      assert.equal(mask.containsPoint(local), expected, 'a sprite centered above ground still loses all pixels below the slope');
    }
  }
  assert.equal(flash.x, x); assert.equal(flash.y, y); assert.equal(flash.width, 10); assert.equal(flash.height, 10);
  clip.clear(); world.destroy({ children: true });
});

test('camera motion inside the cached range and thousands of particles never rebuild or resample the mask', t => {
  const clip = setup(t), host = new Container(), particles = new ParticleContainer({ texture: Texture.EMPTY }), terrain = new Terrain('wet-valley', { length: 2000 });
  host.addChild(particles); clip.attach(host); let queries = 0; const height = terrain.height.bind(terrain);
  terrain.height = x => { queries++; return height(x); };
  clip.update(terrain, camera({ zoom: 16 })); const builds = clip.builds, initialQueries = queries;
  assert(clip.count <= 400, 'a kilometre map must clip a bounded view slice rather than laying out the whole map per actor');
  for (let i = 0; i < 3000; i++) particles.addParticle(new Particle({ texture: Texture.EMPTY }));
  for (let i = 0; i < 120; i++) { clip.update(terrain, camera({ x: i / 10, zoom: 16 })); clip.sync(); }
  assert.equal(clip.builds, builds); assert.equal(queries, initialQueries); assert.equal(initialQueries, 2);
  assert.equal(host.visible, true); particles.removeParticles(); clip.sync(); assert.equal(host.visible, false);
  clip.update(terrain, camera({ x: 400, zoom: 16 })); assert.equal(clip.builds, builds + 1); assert.equal(queries, initialQueries + 2);
  const next = new Terrain('rural-ridges', { length: 2000 }); clip.update(next, camera()); assert.equal(clip.builds, builds + 2);
  clip.clear(); host.destroy({ children: true });
});

test('invisible pooled glows and empty actor containers do not execute stencil passes', t => {
  const clip = setup(t), host = new Container(), glows = new Container(), flash = new Sprite(Texture.WHITE);
  host.addChild(glows); glows.addChild(flash); flash.visible = false; clip.attach(host); clip.update(new Terrain('flat'), camera());
  assert.equal(clip.sync(), false); assert.equal(host.visible, false);
  flash.visible = true; flash.alpha = .3; assert.equal(clip.sync(), true); assert.equal(host.visible, true);
  flash.alpha = 0; assert.equal(clip.sync(), false); assert.equal(host.visible, false);
  clip.detach(host); assert.equal(host.visible, true); assert.equal(host.mask, undefined); host.destroy({ children: true });
});

test('frames without effects leave the ground mask cached and the first returning particle is clipped immediately', t => {
  const r = new Renderer({}), host = new Container(), world = new Container(),
    atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY), spark: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY };
  r.world = world; r.actorLayerRoot = world.addChild(new Container()); r.shadows = world.addChild(new Graphics()); world.addChild(host);
  r.scorchMarks = new ScorchMarks(world.addChild(new Graphics()));
  r.effects = new Effects(host, atlas); r.effectSurfaceClip.attach(host);
  r.ground = new Terrain('flat'); r.ready = true; r.designState = { actors: [], modules: [], plates: [] };
  // Only the other drawing layers are omitted: draw() still samples the real particles and updates their mask before render().
  for (const method of ['syncActorLayers', 'drawScenery', 'cullActors', 'beginFrame', 'drawSurfaces', 'drawStructure', 'drawBodyPanels',
    'drawChassisArt', 'drawGun', 'drawWorkArms', 'drawProjectiles', 'drawOverlay', 'drawBoard', 'drawSites', 'releaseTextures', 'pruneActorLayers']) r[method] = () => {};
  r.terrainScene = { rebuild() {} }; r.backdrop = r.dust = { setScene() {} }; r.mist = { update() {} };
  let particle = null;
  r.app = { stage: world, renderer: { render() {
    assert.equal(host.visible, Boolean(particle), 'visibility is settled before this frame is submitted');
    if (particle) {
      assert(r.effectSurfaceClip.bounds.left < r.camera.x && r.effectSurfaceClip.bounds.right > r.camera.x);
      assert.equal(above(r.effectSurfaceClip, particle.x, r.ground.height(particle.x) - .01), false);
      assert.equal(above(r.effectSurfaceClip, particle.x, r.ground.height(particle.x) + .01), true);
    }
  } } };
  t.after(() => { r.effects.clear(); r.effectSurfaceClip.destroy(); r.heatHaze.destroy(); world.destroy({ children: true, context: true }); });
  // drawTerrain initializes the shared contour even when the first frame has no effects.
  r.drawTerrain(); const initial = r.effectSurfaceClip.builds; r.camera.limits = null;
  Object.assign(r.camera, camera({ zoom: .02 }));
  for (let i = 0; i < 10; i++) { r.camera.x += 1000; r.draw(); }
  assert.equal(r.effectSurfaceClip.builds, initial, 'panning through empty scenery must not rebuild an unused stencil');
  particle = r.effects.add('smoke', { x: r.camera.x, y: -.1, life: 2 }); r.draw();
  assert.equal(r.effectSurfaceClip.builds, initial + 1, 'activation refreshes the whole current view in its first frame');
  r.effects.clear(); particle = null; r.camera.x += 100000; r.draw();
  assert.equal(r.effectSurfaceClip.builds, initial + 1);
  r.ground = new Terrain('hills'); r.drawTerrain(); const changed = r.effectSurfaceClip.builds; r.camera.limits = null;
  r.camera.x += 100000; r.draw(); assert.equal(r.effectSurfaceClip.builds, changed);
  particle = r.effects.add('smoke', { x: r.camera.x, y: r.ground.height(r.camera.x) - .1, life: 2 }); r.draw();
  assert.equal(r.effectSurfaceClip.builds, changed + 1, 'returning effects use the new terrain and current camera without an unclipped frame');
});

test('removing one actor destroys only its mask clone and preserves shared ground geometry for remaining hosts', t => {
  const clip = setup(t), a = new Container(), b = new Container(), ma = clip.attach(a), mb = clip.attach(b);
  clip.update(new Terrain('flat'), camera()); const geometry = clip.geometry, positions = geometry.positions;
  clip.detach(a); a.destroy({ children: true });
  assert.equal(ma.destroyed, true); assert(geometry.attributes, 'the shared geometry stands'); assert.strictEqual(mb.geometry, geometry);
  assert.strictEqual(geometry.positions, positions); assert.equal(above(clip, 0, -.01), false); assert.equal(above(clip, 0, .01), true);
  clip.detach(b); b.destroy({ children: true }); assert.equal(clip.hosts.size, 0);
});

test('renderer integration clips ambient and actor FX ancestors and releases masks before actor pruning', t => {
  const r = new Renderer({}), state = { actors: [{ id: 'rear' }, { id: 'front' }], plates: [], modules: [] },
    atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY), spark: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY };
  r.actorLayerRoot = new Container(); r.actorLayerRoot.sortableChildren = true; r.fxLayer = new Container();
  r.syncActorLayers(state); r.effects = new Effects(r.fxLayer, atlas); r.effects.actorLayer = id => r.actorLayer(id, 'fxLayer');
  r.effects.setActors(state.actors); const smoke = r.effects.add('smoke', { x: 0, y: -.1, actorId: 'rear', life: 2 }),
    layers = r.effects.actorLayers.get('rear'), rear = r.actorLayers.get('rear'), front = r.actorLayers.get('front');
  r.effectSurfaceClip.update(new Terrain('flat'), r.camera); r.effects.sample(1); r.effectSurfaceClip.sync();
  assert(rear.fxLayer.mask && r.fxLayer.mask); assert.equal(layers.group.mask, undefined);
  assert.strictEqual(layers.group.parent, rear.fxLayer); assert(rear.container.zIndex < front.container.zIndex);
  assert.equal(smoke.y, -.1, 'clipping is a pixel operation and must not translate particle centers');
  assert.equal(above(r.effectSurfaceClip, 0, smoke.y), false);
  const mask = rear.fxLayer.mask; r.effects.setActors([state.actors[1]]); r.pruneActorLayers({ actors: [state.actors[1]] });
  assert.equal(mask.destroyed, true); assert(r.effectSurfaceClip.geometry.attributes, 'the shared geometry stands'); assert.equal(r.effectSurfaceClip.hosts.size, 2);
  t.after(() => { r.effects.clear(); r.effectSurfaceClip.destroy(); r.actorLayerRoot.destroy({ children: true }); r.fxLayer.destroy({ children: true }); });
});
