import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Effects } from '../src/effects.ts';
import { Renderer } from '../src/render.ts';
import { Terrain } from '../src/terrain.ts';

function renderer(t) {
  const r = new Renderer({}, { mode: 'test' }), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
    spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY };
  r.world = new Container(); r.actorLayerRoot = r.world.addChild(new Container()); r.fxLayer = r.world.addChild(new Container());
  r.effects = new Effects(r.fxLayer, atlas); r.effects.actorLayer = id => r.actorLayer(id, 'fxLayer');
  t.after(() => { r.effects.clear(); r.effectSurfaceClip.destroy(); r.heatHaze.destroy(); r.world.destroy({ children: true, context: true }); });
  return r;
}

test('mounted muzzle effects retain their vehicle depth and reset with that vehicle', t => {
  const r = renderer(t), state = { actors: [{ id: 'tank', revision: 0 }], modules: [], plates: [] };
  r.syncActorLayers(state); r.effects.setActors(state.actors);
  r.effects.consume([{ type: 'muzzle', platform: 'vehicle', actorId: 'tank', weapon: 'cannon', caliberMm: 120, x: 12, y: 2, angle: .2 }]);
  const fx = r.effects, layers = fx.actorLayers.get('tank');
  assert.equal(layers.group.parent, r.actorLayer('tank', 'fxLayer'));
  assert(fx.particles.every(p => p.effectActorId === 'tank')); assert.equal(fx.lights[0].effectActorId, 'tank');
  assert.equal(fx.blastWaves.waves[0].actorId, 'tank');
  fx.setActors([{ id: 'tank', revision: 1 }]);
  assert.equal(fx.particles.length, 0); assert.equal(fx.lights.length, 0); assert.equal(fx.blastWaves.waves.length, 0);
});

test('camera zoom admits fresh smoke nearby and lets distant FX hosts empty without removing their ground mask', t => {
  const r = renderer(t), fx = r.effects, state = { actors: [{ id: 'tank' }], modules: [], plates: [] },
    event = { type: 'muzzle', actorId: 'tank', weapon: 'machinegun', caliberMm: 5.56, x: 0, y: 2, angle: 0 };
  r.syncActorLayers(state); fx.setActors(state.actors); r.effectSurfaceClip.update(new Terrain('flat'), r.camera);
  const host = r.actorLayer('tank', 'fxLayer'), mask = host.mask;
  r.camera.zoom = 1.5; fx.view = r.shotView(); fx.consume([event]); fx.sample(1); r.effectSurfaceClip.sync();
  assert.equal(fx.view.zoom, 1.5); assert(host.visible); assert.strictEqual(host.mask, mask);
  fx.update(.2); fx.sample(1); r.effectSurfaceClip.sync();
  assert.equal(fx.particles.length, 0); assert.equal(host.visible, false);
  r.camera.zoom = 65; fx.view = r.shotView(); fx.consume([event]); fx.sample(1); r.effectSurfaceClip.sync();
  const smoke = fx.particles.filter(p => p.kind === 'smoke'); assert(smoke.length > 0);
  fx.update(.1); const ages = smoke.map(p => p.age);
  r.camera.zoom = 1.5; fx.view = r.shotView(); fx.sample(1); r.effectSurfaceClip.sync();
  assert.deepEqual(smoke.map(p => p.age), ages, 'changing zoom must not restart or age existing smoke');
  assert(smoke.every(p => fx.particles.includes(p))); assert(host.visible); assert.strictEqual(host.mask, mask);
  fx.update(4); fx.sample(1); r.effectSurfaceClip.sync(); assert.equal(host.visible, false);
});

test('far effects retain important flashes and growing clouds while thinning only fresh small particles', t => {
  const nearby = renderer(t).effects, far = renderer(t).effects;
  nearby.view = { zoom: 65 }; far.view = { zoom: 1 };
  const puff = { x: 0, y: 2, size: 1, life: 1, grow: 0 };
  for (let n = 0; n < 100; n++) { nearby.add('smoke', puff); far.add('smoke', puff); }
  assert.equal(nearby.particles.length, 100);
  assert(far.particles.length > 0 && far.particles.length < 50, 'small far smoke still signals the event with fewer particles');
  const kept = [...far.particles]; far.view.zoom = 65; far.sample(1);
  assert(kept.every(p => far.particles.includes(p) && p.age === 0), 'zoom does not clear or restart existing effects');
  far.view.zoom = 1; const before = far.particles.length;
  for (let n = 0; n < 20; n++) {
    far.flash({ ...puff, size: .01 });
    far.add('smoke', { ...puff, size: .01, priority: true });
    far.add('smoke', { ...puff, size: .01, grow: 5 });
    far.add('smoke', { ...puff, size: .01 });
  }
  assert.equal(far.particles.length, before + 60, 'flash, priority and large eventual clouds survive; unreadable puffs are not made');
});

test('the gun in the player\'s hands shakes the view, not a gun of another nor one over ground out of sight; the camera stays put', t => {
  const r = renderer(t), state = { actors: [{ id: 'tank', revision: 0 }, { id: 'other', revision: 0 }], modules: [], plates: [], controlledActor: 'tank' };
  r.playback.state = state; r.syncActorLayers(state); r.effects.setActors(state.actors);
  r.camera.x = 12; r.camera.y = 2; r.camera.zoom = 65;
  const shot = (actorId, x) => ({ type: 'muzzle', platform: 'vehicle', actorId, weapon: 'cannon', caliberMm: 120, x, y: 2, angle: 0 }),
    pointer = r.camera.toWorld(300, 200);
  r.consumeEffect(shot('other', 14)); assert.equal(r.screenShake.trauma, 0, 'the gun of another');
  r.fog = { seen: [[-50, 50]] }; r.consumeEffect(shot('tank', 400)); assert.equal(r.screenShake.trauma, 0, 'what the fog hides');
  r.consumeEffect(shot('tank', 12)); assert(r.screenShake.trauma > .5, 'its own 120 mm');
  const thrown = r.screenShake.offset(r.camera.zoom, r.mode);
  r.screenShake.update(.01); assert(Math.hypot(thrown.x, thrown.y) > 0, 'the drawing is thrown');
  assert.deepEqual(r.camera.toWorld(300, 200), pointer, 'and where the pointer is in the world is not');
});
