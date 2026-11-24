import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { Effects } from '../src/effects.ts';

function scene(t) {
  const r = new Renderer({}); r.actorLayerRoot = new Container(); r.actorLayerRoot.sortableChildren = true;
  r.moduleLayer = new Container(); r.plateLayer = new Container();
  r.fxLayer = new Container();
  const state = { shared: true, actors: [{ id: 'rear' }, { id: 'front' }], plates: [], modules: [] };
  r.syncActorLayers(state);
  t.after(() => { r.effects?.clear(); r.actorLayerRoot.destroy({ children: true }); r.fxLayer.destroy({ children: true }); });
  return { r, state };
}

test('whole vehicles keep their depth when actor order and intact casing geometry change', t => {
  const { r, state } = scene(t), rear = r.actorLayers.get('rear'), front = r.actorLayers.get('front'),
    rearMotor = new Container(), frontPlate = new Container(), casing = new Container();
  r.actorLayer('rear', 'moduleLayer').addChild(rearMotor);
  r.actorLayer('front', 'plateLayer').addChild(frontPlate); r.actorLayer('rear', 'moduleLayer').addChild(casing);
  const depth = [rear.container.zIndex, front.container.zIndex];
  r.syncActorLayers({ ...state, actors: [...state.actors].reverse() }); r.actorLayerRoot.sortChildren();
  assert.deepEqual([rear.container.zIndex, front.container.zIndex], depth);
  assert(depth[1] - depth[0] >= 100);
  assert.deepEqual(r.actorLayerRoot.children, [rear.container, front.container]);
  for (const piece of [rearMotor, casing]) assert.equal(piece.parent.parent, rear.body);
  assert.equal(rear.body.parent, rear.container); assert.equal(front.body.parent, front.container);
  assert.equal(r.actorLayer('rear', 'gun').parent, rear.body);
  assert.equal(rear.fxLayer.parent,rear.container,'flames and smoke stay outside the material lighting capture');
  assert.equal(frontPlate.parent.parent, front.body, 'front armour cannot be drawn between a rear motor and rear gun');
  r.syncActorLayers({ ...state, actors: [...state.actors, { id: 'new' }] });
  assert(r.actorLayers.get('new').container.zIndex > front.container.zIndex);
  r.pruneActorLayers({ ...state, actors: [state.actors[1], { id: 'new' }] });
  assert(!r.actorLayers.has('rear')); assert.equal(frontPlate.parent.parent, front.body);
});

test('a vehicle that leaves takes its depth with its layers, and one that comes after it is drawn over every vehicle still there', t => {
  const { r, state } = scene(t), depth = id => r.actorLayers.get(id).container.zIndex;
  // Vehicles come and go over a long battle: nothing of one that went stays behind in the renderer.
  let actors = state.actors;
  for (let i = 0; i < 50; i++) {
    actors = [...actors.slice(1), { id: 'wave-' + i }];
    r.syncActorLayers({ ...state, actors }); r.pruneActorLayers({ ...state, actors });
  }
  const gone = new Set(['rear', 'front', ...Array.from({ length: 48 }, (_, i) => 'wave-' + i)]);
  assert.deepEqual([...r.actorLayers.keys()], ['wave-48', 'wave-49']);
  for (const kept of Object.values(r)) if (kept instanceof Map || kept instanceof Set)
    assert(![...kept.keys()].some(id => gone.has(id)), 'what the renderer keeps of vehicles is of those still there');
  // With some gone, the next one does not take the depth of one still standing: it goes over them all.
  const [older, newer] = [...r.actorLayers.keys()];
  actors = [...actors, { id: 'late' }]; r.syncActorLayers({ ...state, actors });
  assert(depth('late') > depth(newer) && depth(newer) > depth(older));
  assert.equal(new Set([...r.actorLayers.values()].map(layers => layers.container.zIndex)).size, r.actorLayers.size, 'no two vehicles share a depth');
});

test('event-driven smoke and flash share vehicle depth without masks or pressure cells', t => {
  const { r, state } = scene(t), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
    spark: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY };
  r.effects = new Effects(r.fxLayer, atlas); r.effects.actorLayer = id => r.actorLayers.get(id)?.fxLayer;
  r.effects.setActors(state.actors);
  const particle = r.effects.add('smoke', { x: 1, y: .5, actorId: 'rear' }); assert(particle);
  const layers = r.effects.actorLayers.get('rear');
  assert.equal(layers.group.parent, r.actorLayers.get('rear').fxLayer); assert(!layers.group.mask);
  r.effects.lights.push({ effectActorId: 'rear', x: 1, y: .5, size: 1, strength: 1, age: 0, life: 1 });
  r.effects.sample(1);
  assert.equal(r.effects.lightSprites[0].parent, layers.glows);
  assert.equal(layers.glows.parent, layers.group);
  assert(r.actorLayers.get('rear').container.zIndex < r.actorLayers.get('front').container.zIndex);
  r.effects.setActors([state.actors[1]]); r.effects.sample(1);
  assert.equal(r.effects.actorLayers.size, 0); assert.equal(r.effects.particles.length, 0);
});
