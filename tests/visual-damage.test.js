import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { designFrame, sampleScene } from '../src/scene-frame.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { paintDamage } from '../src/textures.ts';
import { localToWorld } from '../src/math.ts';
import { Terrain } from '../src/terrain.ts';
import { componentPolygon } from '../src/assembly.ts';
import { countingCanvas } from './scenery-canvas.js';

function context() {
  const ops = [], stack = [];
  const ctx = { canvas: { width: 512, height: 128 }, globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    translate: (...args) => ops.push(['translate', ...args]), scale: (...args) => ops.push(['scale', ...args]),
    rotate: angle => ops.push(['rotate', angle]), createRadialGradient: (...args) => {
      ops.push(['gradient', ...args]); return { addColorStop: (...color) => ops.push(['color', ...color]) };
    }, fillRect() { ops.push(['fill', this.globalAlpha, this.globalCompositeOperation]); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, arc() {}, stroke() {} };
  return { ctx, ops };
}
function presenter(t) {
  countingCanvas(t);
  const renderer = new Renderer({}); renderer.actorLayerRoot = new Container(); renderer.shadows = new Graphics(); renderer.ground = new Terrain('flat');
  renderer.moduleTexture = () => Texture.EMPTY;
  renderer.textures.set('material:steel', { key: 'material:steel', texture: Texture.EMPTY, persistent: true });
  t.after(() => {
    for (const item of renderer.drawables.values()) { item.group.destroy({ children: true }); item.geometry.destroy(); }
    renderer.actorLayerRoot.destroy({ children: true }); renderer.shadows.destroy();
  });
  return renderer;
}
function plateFrame() {
  const definition = { id: 'plate', material: 'steel', x: 10, y: 1, angle: 0, length: 2, thicknessMm: 1000, anchors: [] },
    state = designFrame({ plates: [definition], modules: [] });
  state.plates[0].marks = [{ u: .5, v: .1, kind: 'dent', strength: .2, radius: .07, depth: .003 }];
  state.plates[0].markRevision = 1; return state;
}

test('a surface dent repaints its plate while retaining the adjoining armour geometry and joint plan', t => {
  const renderer = presenter(t), state = plateFrame(), painted = [];
  state.plates.push(designFrame({ plates: [{ ...state.plates[0].definition, id: 'neighbor', x: 11, y: 2, angle: Math.PI / 2 }], modules: [] }).plates[0]);
  renderer.paintedTexture = (key, base, revision, paint) => { const { ctx, ops } = context(); paint(ctx); painted.push({ key, revision, ops }); return base; };
  renderer.scene = sampleScene(state); renderer.syncActorLayers(state); renderer.drawSurfaces();
  const item = renderer.drawables.get('plate'), geometry = item.data, original = Array.from(item.positions),
    artwork = renderer.armorPlan.get('plate'), builds = { ...renderer.armorArt.stats };
  assert(builds.candidatePairs > 0, 'the fixture must exercise adjoining plates');
  const next = structuredClone(state); next.plates[0].marks[0].depth *= 2; next.plates[0].markRevision++;
  renderer.scene = sampleScene(next); renderer.syncActorLayers(next); renderer.drawSurfaces();
  assert.deepEqual(painted.map(p => [p.key, p.revision]), [['damage:plate', 1], ['damage:plate', 2]]);
  const dentScale = paint => paint.ops.filter(op => op[0] === 'scale').at(-1)[1];
  assert(dentScale(painted[1]) > dentScale(painted[0]));
  assert.equal(renderer.drawables.get('plate'), item); assert.deepEqual(Array.from(item.positions), original);
  assert.strictEqual(item.data, geometry); assert.strictEqual(renderer.armorPlan.get('plate'), artwork);
  assert.deepEqual(renderer.armorArt.stats, builds, 'surface damage must not rebuild plate meshes or joint plans');
});

test('destroyed running gear keeps the installed geometry, paint and depth', t => {
  const renderer = presenter(t), state = plateFrame(), module = { id: 'track', actorId: 'local', kind: 'track',
    x: 5, y: .5, angle: 0, width: 3, height: 1, health: 100, maxHealth: 100, attached: true };
  state.modules.push(module); renderer.getTexture = () => Texture.EMPTY;
  renderer.scene = sampleScene(state); renderer.syncActorLayers(state); renderer.drawSurfaces();
  const item = renderer.drawables.get(module.id), shape = Array.from(item.positions);
  assert(item.trackDetails.container.visible);
  const destroyed = structuredClone(state); destroyed.modules[0].health = 0;
  renderer.scene = sampleScene(destroyed); renderer.syncActorLayers(destroyed); renderer.drawSurfaces();
  assert.equal(renderer.drawables.get(module.id), item); assert(item.mesh.visible); assert(item.group.visible);
  assert.equal(item.group.parent, renderer.actorLayer('local', 'runningGearLayer'));
  assert.deepEqual(Array.from(item.positions), shape); assert.notEqual(item.mesh.tint, 0xffffff);
});

test('the painted backing and impact marks use the same rigid sample as the armour', () => {
  const localPoly = [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: -2, y: 1 }],
    frame = pose => {
      const state = designFrame({ plates: [{ id: 'plate', material: 'steel', x: pose.x, y: pose.y, angle: pose.angle,
        length: 4, thicknessMm: 100, anchors: [] }], modules: [], appearance: { paint: '#68765a' } });
      state.actors[0].vehicle = { ...pose, chassisId: 'plate' };
      state.bodyPanels = [{ id: 'panel', actorId: 'local', pose, localPolygon: localPoly }];
      state.plates[0].marks = [{ u: .5, v: 0, kind: 'dent', strength: .5, radius: .06, depth: .005 }];
      return state;
    }, before = frame({ x: 0, y: 0, angle: 0 }), after = frame({ x: 2, y: 1, angle: Math.PI / 2 }),
    scene = sampleScene(after, before, .5), surface = bodyPanelSurfaces(after, null, before, .5, scene)[0],
    pose = scene.actor('local');
  assert.equal(surface.artPose, pose); assert.equal(surface.artPolygon, localPoly);
  assert.equal(surface.marks[0].angle, scene.pose('plate').angle); assert.equal(surface.marks[0].radius, .06);
});

test('cached hull sprites and their fittings follow the sampled pose and retire when the backing is gone', t => {
  const renderer = presenter(t), polygon = [{ x: -2, y: -.5 }, { x: 2, y: -.5 }, { x: 2, y: .5 }, { x: -2, y: .5 }],
    textureKeys = [], frame = pose => {
      const state = designFrame({ preset: 'vehicle', plates: [], modules: [], appearance: { paint: '#68765a' } });
      state.actors[0].vehicle = pose;
      state.bodyPanels = [{ id: 'hull', actorId: 'local', pose, localPolygon: polygon }]; return state;
    }, draw = (state, previous = null, alpha = 1) => {
      // Seen from outside, as the skin carries the layout it was painted with; cut open, the inner wall keeps its fittings
      // apart (selection-art-lifetime.test.js).
      renderer.scene = sampleScene(state, previous, alpha); renderer.syncActorLayers(state); renderer.closed.add('local');
      renderer.drawBodyPanels(state, alpha);
    };
  // The skin as hull-art.ts leaves it in the cache: its picture, and the layout of its fittings on the outline it was
  // painted for — here a lifting eye a metre ahead of its middle.
  const eye = { kind: 'eye', x: 1, y: 0, w: .1, h: .1, flip: false }, entries = renderer.textures;
  renderer.texture = key => {
    textureKeys.push(key);
    if (!entries.has(key)) entries.set(key, { texture: Texture.EMPTY, ...key.startsWith('hull:') && { layout: { fittings: [eye], arches: [], feet: [] }, painted: { left: -2, bottom: -.5, width: 4, height: 1 } } });
    return entries.get(key);
  };
  renderer.view.mode = 'test'; renderer.camera.zoom = 40;
  const before = frame({ x: 12, y: 2, angle: 0, chassisId: 'root' }), after = frame({ x: 15, y: 3, angle: Math.PI / 2, chassisId: 'root' });
  draw(before); const sprite = renderer.hullSprites.get('local:hull'), fittings = sprite.fittings, first = new Set(textureKeys);
  for (const alpha of [0, .5, 1]) {
    draw(after, before, alpha);
    assert.equal(renderer.hullSprites.get('local:hull'), sprite);
    const pose = renderer.scene.actor('local'), expected = localToWorld(pose, -2, .5);
    assert(Math.hypot(sprite.x - expected.x, sprite.y - expected.y) < 1e-12);
    assert.equal(sprite.rotation, pose.angle); assert(sprite.scale.y < 0);
    // The fittings stand in the frame of the hull, where the layout put them.
    assert.equal(sprite.fittings, fittings); assert.equal(fittings.children.length, 1);
    assert.deepEqual([fittings.x, fittings.y, fittings.rotation], [pose.x, pose.y, pose.angle]);
    assert.deepEqual([fittings.children[0].x, fittings.children[0].y], [1, 0]);
  }
  assert.deepEqual(new Set(textureKeys), first, 'moving and rotating a hull do not change the artwork of it or of its fittings');
  assert.equal(first.size, 2);
  assert.equal(sprite.parent, renderer.actorLayer('local', 'outerSkin')); assert.equal(fittings.parent, sprite.parent);
  // From afar the fittings are not shown, and their pictures are kept.
  renderer.camera.zoom = 8; draw(after);
  assert(!fittings.visible); assert(textureKeys.at(-1).startsWith('hull-fitting:'));
  after.bodyPanels = []; draw(after);
  assert.equal(renderer.hullSprites.size, 0); assert(sprite.destroyed); assert(fittings.destroyed);
});

test('a mark of the hull that falls on a fitting is painted on the fitting too, and only on that one', t => {
  const renderer = presenter(t), localPoly = [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: -2, y: 1 }], pose = { x: 5, y: 1, angle: .3 },
    state = designFrame({ plates: [{ id: 'plate', material: 'steel', x: pose.x, y: pose.y, angle: pose.angle, length: 4, thicknessMm: 100, anchors: [] }],
      modules: [], appearance: { paint: '#68765a' } });
  state.actors[0].vehicle = { ...pose, chassisId: 'plate' };
  state.bodyPanels = [{ id: 'panel', actorId: 'local', pose, localPolygon: localPoly }];
  // A dent in the middle of the floor plate, just over the foot of the hull: on the first fitting, far from the second.
  state.plates[0].marks = [{ u: .5, v: 0, kind: 'dent', strength: .5, radius: .06, depth: .005 }]; state.plates[0].markRevision = 1;
  const fittings = [{ kind: 'shackle', x: 0, y: .12, w: .2, h: .2, flip: false }, { kind: 'eye', x: 1.5, y: .8, w: .1, h: .1, flip: false }], painted = [];
  renderer.texture = key => {
    if (!renderer.textures.has(key)) renderer.textures.set(key, { texture: Texture.EMPTY, ...key.startsWith('hull:') && { layout: { fittings, arches: [], feet: [] }, painted: { left: -2, bottom: 0, width: 4, height: 1 } } });
    return renderer.textures.get(key);
  };
  renderer.paintedTexture = (key, base) => { painted.push(key); return base; };
  renderer.view.mode = 'test'; renderer.camera.zoom = 40; renderer.scene = sampleScene(state); renderer.syncActorLayers(state);
  renderer.closed.add('local'); renderer.drawBodyPanels(state, 1);
  assert.deepEqual(painted, ['hull-damage:local:panel', 'hull-fitting-damage:local:panel:0']);
});

test('surface decals shade the measured depth and radius without painting a false aperture', () => {
  const mark = { u: .5, v: .5, kind: 'dent', strength: .5, radius: .02, depth: .001, dx: 0, dy: -1 },
    shallow = context(), deep = context(), wide = context();
  paintDamage(shallow.ctx, [mark], 'steel', 2, .1);
  paintDamage(deep.ctx, [{ ...mark, depth: .005 }], 'steel', 2, .1);
  paintDamage(wide.ctx, [{ ...mark, radius: .04 }], 'steel', 2, .1);
  const scale = record => record.ops.filter(op => op[0] === 'scale').at(-1)[1], radius = record => record.ops.find(op => op[0] === 'gradient').at(-1);
  assert.equal(scale(deep), scale(shallow) * 5); assert.equal(radius(wide), radius(shallow) * 2);
  assert(deep.ops.find(op => op[0] === 'fill')[1] > shallow.ops.find(op => op[0] === 'fill')[1]);
  for (const record of [shallow, deep, wide]) {
    assert.equal(record.ctx.globalCompositeOperation, 'source-over');
    assert(record.ops.filter(op => op[0] === 'fill').every(op => op[2] === 'source-over'));
    assert(record.ops.filter(op => op[0] === 'color').every(op => !op[2].startsWith('#121c16')), 'a decal does not stand in for missing material');
  }
});
