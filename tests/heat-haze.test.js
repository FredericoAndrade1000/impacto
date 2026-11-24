import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, DOMAdapter, Texture } from 'pixi.js';
import { HeatHaze } from '../src/heat-haze.ts';
import { BlastWaves } from '../src/blast-waves.ts';
import { EffectSurfaceClip } from '../src/effect-surface-clip.ts';
import { Effects } from '../src/effects.ts';
import { Renderer } from '../src/render.ts';
import { Terrain } from '../src/terrain.ts';

const camera = { x: 10, y: 2, width: 1280, height: 720, zoom: 130 };
const burn = (x = 10, actorId = 'rear') => ({ key: 'burn:' + actorId + ':' + x, x, y: .7,
  size: 1.25, age: .04, life: .16, strength: .22, effectActorId: actorId });
const wave = (x = 10) => ({ actorId: 'rear', age: .08, displayAge: .075, life: .2, frontRadius: 2.1, opacity: .18, refraction: 1, displayAlpha: .17,
  sprite: { visible: true, x, y: .5, width: 5.25, height: .735, alpha: .17, rotation: -.22 } });

// The tube of an M2 lying level along its top, as the renderer tells it (render.ts `drawArmament`).
const barrel = (temperature, motion = {}) => ({ id: 'b1:gun', actorId: 'rear', x0: 9.5, y0: 1.2, x1: 10.64, y1: 1.2, diameter: .06, temperature, air: 15, vx: 0, vy: 0, ...motion });

function haze(t, initialize = false) {
  const effect = new HeatHaze();
  if (initialize) {
    const previous = DOMAdapter.get();
    DOMAdapter.set({ ...previous, createCanvas: () => ({ getContext: () => null }) });
    try { effect.init(); } finally { DOMAdapter.set(previous); }
  }
  t.after(() => effect.destroy()); return effect;
}

test('heat columns begin above the flames and never mutate presentation sources', t => {
  const air = haze(t), lights = [burn()], waves = [wave()], input = structuredClone({ lights, waves });
  air.update(.25);
  const sources = air.collect({ lights, blastWaves: { waves } }, camera);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].actorId, 'rear'); assert.equal(sources[0].mode, 0);
  assert(sources[0].y - sources[0].ry > lights[0].y + .3, 'refraction must not replace the root of the flame');
  assert.equal(sources[0].phase, .25);
  assert.deepEqual({ lights, waves }, input, 'optical presentation must not move, age, or edit engine effects');
});

test('the air over a barrel shimmers from 150 °C in columns along its top, the more the hotter it is, and streams back fainter over a gun that moves', t => {
  const air = haze(t), at = (temperature, motion) => air.collect({}, camera, [barrel(temperature, motion)]).map(source => ({ ...source }));
  assert.deepEqual(at(149), []);
  const faint = at(160), warm = at(300), hot = at(700);
  assert.equal(warm.length, 3, 'a long tube across the rising air has three columns over it');
  for (const source of warm) {
    assert.equal(source.mode, 0); assert.equal(source.rotation, 0, 'in still air it rises straight up');
    assert(source.y - source.ry > 1.2 - .06 && source.y - source.ry < 1.2, `it rises off the top of the tube: ${source.y - source.ry}`);
    assert(source.x > 9.5 && source.x < 10.64 && source.ry > .3, JSON.stringify(source));
  }
  assert(faint[0].strength > 0 && faint[0].strength < warm[0].strength && warm[0].strength < hot[0].strength,
    `${faint[0].strength} at 160 °C, ${warm[0].strength} at 300, ${hot[0].strength} at 700`);
  // A gun going ahead at 8 m/s leaves its hot air behind it, lying back, and it carries the heat off into more air.
  const moving = at(300, { vx: 8 });
  assert(moving[0].rotation > 1.4 && moving[0].x < (9.5 + 10.64) / 2 - .2, `it streams back: ${moving[0].rotation}, ${moving[0].x}`);
  assert(moving[0].strength < warm[0].strength / 4, `${moving[0].strength} going, ${warm[0].strength} standing`);
  // On the lowest quality a barrel, hot for minutes, does not keep the pass running.
  assert.deepEqual(air.collect({ quality: 'low' }, camera, [barrel(700)]), []);
});

test('the shimmer over a barrel runs up as fast as the air rises off it, and carries on as the barrel heats', t => {
  const air = haze(t), rise = temperature => Math.sqrt(9.81 * .06 * (temperature - 15) / 288.15), ry = .36;
  air.collect({}, camera, [barrel(300)]); air.update(.5);
  const [first] = air.collect({}, camera, [barrel(300)]);
  assert(Math.abs(first.phase - .5 * rise(300) * 11 / (9 * ry)) < 1e-9, `${first.phase}`);
  air.update(.25);
  const [then] = air.collect({}, camera, [barrel(310)]);
  assert(Math.abs(then.phase - first.phase - .25 * rise(310) * 11 / (9 * ry)) < 1e-9, 'it goes on from where it was, faster');
});

test('pressure refraction follows the visible front and rotated ground ellipse', t => {
  const air = haze(t), original = wave(), source = air.collect({ blastWaves: { waves: [original] } }, camera)[0];
  assert.equal(source.mode, 1);
  assert(Math.abs(source.rx * .82 - original.frontRadius) < 1e-10);
  assert(Math.abs(source.ry / source.rx - original.sprite.height / original.sprite.width) < 1e-10);
  assert.equal(source.rotation, original.sprite.rotation);
  assert.equal(source.x, original.sprite.x); assert.equal(source.y, original.sprite.y);
  assert.equal(source.phase, original.displayAge); assert(source.band < .18);
  original.frontRadius = 4.7; original.sprite.x += .25; original.sprite.y += .5;
  const next = air.collect({ blastWaves: { waves: [original] } }, camera)[0];
  assert(Math.abs(next.rx * .82 - 4.7) < 1e-10); assert.equal(next.x, original.sprite.x); assert.equal(next.y, original.sprite.y);
});

function sampledWaves(t) {
  const layer = new Container(), waves = new BlastWaves({ shockwave: Texture.WHITE }, () => layer);
  t.after(() => { waves.clear(); for (const sprite of waves.sprites) sprite.destroy(); layer.destroy(); });
  return waves;
}

test('pressure refraction fades with sampled wave alpha, including interpolated time', t => {
  const air = haze(t), waves = sampledWaves(t), event = { x: 10, y: .5, radius: 5.2, actorId: 'rear' },
    front = waves.emit(event, { ground: { y: .5, nx: -.6, ny: .8 } }), effects = { blastWaves: waves }, samples = [];
  const snapshot = () => [front.age, front.previousAge, front.displayAge, front.frontRadius, front.displayAlpha,
    front.sprite.x, front.sprite.y, front.sprite.width, front.sprite.height, front.sprite.rotation, front.sprite.alpha];
  for (const age of [.02, .08, .12]) {
    waves.update(age - front.age); waves.sample();
    const before = snapshot(), source = air.collect(effects, camera)[0];
    assert(source, 'a still visible front must retain a bounded refraction source');
    samples.push({ strength: source.strength, alpha: front.displayAlpha });
    assert.deepEqual(snapshot(), before, 'collecting refraction must not change wave time, radius or placement');
    assert(Math.abs(source.rx * .82 - front.frontRadius) < 1e-12);
  }
  for (const sample of samples.slice(1)) {
    assert(Math.abs(sample.strength / samples[0].strength - sample.alpha / samples[0].alpha) < 1e-12,
      'a nearly transparent front must not retain the old slow refraction tail');
  }
  assert(samples[2].strength < samples[0].strength * .1);
  waves.sample(.5);
  const interpolated = air.collect(effects, camera)[0];
  assert(interpolated.strength > samples[2].strength, 'use the interpolated alpha rather than the later simulation age');
  assert(Math.abs(interpolated.strength / samples[0].strength - front.displayAlpha / samples[0].alpha) < 1e-12);
  waves.update(.04); waves.sample();
  assert.equal(front.sprite.visible, false); assert.equal(front.displayAlpha, 0);
  assert.equal(air.collect(effects, camera).length, 0, 'an extinguished front must stop contributing refraction');
});

test('sampled wave quality attenuates refraction once without changing its footprint or buffers', t => {
  const air = haze(t), waves = sampledWaves(t), front = waves.emit({ x: 10, y: .5, radius: 5.2 }),
    buffers = [air.positions, air.coords, air.params, air.basis, air.indices];
  waves.update(.02); waves.sample();
  const first = { ...air.collect({ quality: 'high', blastWaves: waves }, camera)[0] };
  for (const [quality, factor] of [['balanced', .8], ['low', .6], ['high', 1]]) {
    waves.setQuality(quality); waves.sample();
    const source = air.collect({ quality, blastWaves: waves }, camera)[0];
    assert(Math.abs(source.strength / first.strength - factor) < 1e-12,
      'sampled alpha already contains the quality multiplier');
    for (const key of ['x', 'y', 'rx', 'ry', 'rotation', 'band', 'phase']) assert.equal(source[key], first[key]);
    air.writeGeometry();
    assert.deepEqual([air.positions, air.coords, air.params, air.basis, air.indices].map((buffer, i) => buffer === buffers[i]),
      [true, true, true, true, true]);
    assert.equal(waves.waves[0], front); assert.equal(waves.sprites.length, 1);
  }
});

test('pressure refraction refuses missing or invalid sampled-wave fields instead of guessing them', t => {
  const air = haze(t);
  for (const field of ['frontRadius', 'displayAge', 'displayAlpha', 'opacity', 'refraction']) for (const value of [undefined, NaN, Infinity]) {
    const original = { ...wave(), [field]: value };
    assert.throws(() => air.collect({ blastWaves: { waves: [original] } }, camera), /requires a sampled blast wave/, `${field}: ${value}`);
  }
  assert.throws(() => air.collect({ blastWaves: { waves: [{ ...wave(), opacity: 0 }] } }, camera), /requires a sampled blast wave/);
  assert.throws(() => air.collect({ blastWaves: { waves: [{ ...wave(), sprite: undefined }] } }, camera), /requires a sampled blast wave/);
  assert.throws(() => air.collect({ blastWaves: { waves: [{ ...wave(), sprite: { ...wave().sprite, rotation: undefined } }] } }, camera), /requires a sampled blast wave/);
});

test('a burst too small for a front bends the air only over its fire, and a weaker front bends it less', t => {
  const air = haze(t), parent = new Container(), view = { ...camera, zoom: 40 }, fx = new Effects(parent, { smoke: Array(8).fill(Texture.EMPTY),
    fire: Array(4).fill(Texture.EMPTY), spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY });
  t.after(() => { fx.clear(); parent.destroy({ children: true }); });
  const burst = radius => { fx.clear(); fx.consume([{ type: 'explosion', x: 10, y: 3, power: 400, radius }]); fx.update(.02); fx.sample(1); return air.collect(fx, view); };
  for (const radius of [.7, .95, 1.75, 2.6]) {
    const sources = burst(radius);
    assert.equal(fx.blastWaves.waves.length, 0); assert(sources.length > 0 && sources.every(source => source.mode === 0), `${radius} m`);
  }
  const fronts = [3.5, 5.2, 7.2].map(radius => burst(radius).filter(source => source.mode === 1));
  assert(fronts.every(found => found.length === 1));
  const [mortar, light, heavy] = fronts.map(([source]) => source.strength);
  assert(mortar < light && light < heavy && mortar < heavy * .6, 'an 81 mm bomb bends the air faintly, a 155 mm shell fully');
});

test('offscreen, expired, invalid and unrelated lights spend no source budget', t => {
  const air = haze(t), lights = [burn(-200), { ...burn(), age: .16 }, { ...burn(), x: NaN },
    { ...burn(), key: 'muzzle' }, { ...burn(), life: 0 }, { ...burn(), y: Infinity }, burn()];
  const sources = air.collect({ lights, blastWaves: { waves: [wave(200), { ...wave(), sprite: { ...wave().sprite, visible: false } }] } }, camera);
  assert.equal(sources.length, 1); assert.equal(sources[0].x, 10);
  assert.equal(air.collect({ lights }, { ...camera, zoom: 0 }).length, 0);
  assert.equal(air.collect({ lights }, { ...camera, width: Infinity }).length, 0);
});

test('six actors and arbitrarily many explosions share fixed high/balanced/low budgets', t => {
  const air = haze(t), lights = Array.from({ length: 400 }, (_, index) => burn(7 + index % 7, 'actor:' + index % 6)),
    waves = Array.from({ length: 200 }, (_, index) => wave(8 + index % 4));
  for (const [quality, heatCount, waveCount] of [['high', 24, 8], ['balanced', 16, 6], ['low', 8, 3]]) {
    const sources = air.collect({ quality, lights, blastWaves: { waves } }, camera);
    assert.equal(sources.filter(s => s.mode === 0).length, heatCount);
    assert.equal(sources.filter(s => s.mode === 1).length, waveCount);
    air.writeGeometry(); assert.equal(air.count, heatCount + waveCount);
    assert(air.positions.every(Number.isFinite)); assert(air.params.every(Number.isFinite)); assert(air.basis.every(Number.isFinite));
  }
  assert.equal(air.positions.length, 32 * 8); assert.equal(air.indices.length, 32 * 6);
});

test('one filter and fixed buffers survive changing sources, quality, and empty frames', t => {
  const air = haze(t, true), renderer = { backBuffer: { useBackBuffer: false } }, first = {
    mesh: air.mesh, filter: air.filter, geometry: air.geometry,
    positions: air.positions, indexBuffer: air.geometry.getIndex(), positionBuffer: air.geometry.getBuffer('aPosition'),
  };
  for (let frame = 0; frame < 50; frame++) {
    air.update(.016); air.sample({ quality: frame % 2 ? 'low' : 'high', lights: [burn(), burn(11)] }, camera, renderer);
    assert.equal(renderer.backBuffer.useBackBuffer, true); assert.equal(air.host.filters.length, 1);
    assert.equal(air.host.filters[0], first.filter); assert.equal(air.mesh, first.mesh); assert.equal(air.geometry, first.geometry);
    assert.equal(air.positions, first.positions); assert.equal(air.geometry.getIndex(), first.indexBuffer);
    assert.equal(air.geometry.getBuffer('aPosition'), first.positionBuffer); assert.equal(air.geometry.indexCount, 12);
    assert.equal(air.filter.resolution, frame % 2 ? .35 : .55);
  }
  air.sample({ lights: [], blastWaves: { waves: [] } }, camera, renderer);
  assert.equal(air.host.visible, false); assert.equal(air.mesh.visible, false); assert.equal(renderer.backBuffer.useBackBuffer, false);
  assert.equal(air.host.filters[0], first.filter, 'a dormant filter is retained without executing a pass');
});

test('background and low resolution field use independent pooled texture dimensions', t => {
  const air = haze(t, true), calls = [];
  assert.equal(air.filter.blendRequired, true); assert.equal(air.filter.padding, 7);
  const manager = { activeBackTexture: { source: { width: 1024, height: 512 } }, applyFilter: (...args) => calls.push(args) },
    input = { source: { width: 256, height: 128 } }, output = {};
  air.filter.apply(manager, input, output, false);
  assert.deepEqual([...air.filter.resources.airUniforms.uniforms.uBackSize], [1024, 512, 1 / 1024, 1 / 512]);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], [air.filter, input, output, false]);
  assert(air.filter.glProgram.fragment.includes('texture(uBackTexture, clamp(uv + shift'),
    'the shader must actually sample displaced background pixels');
  assert(!air.filter.glProgram.fragment.includes('for ('), 'fragment cost must not loop over 32 sources at every pixel');
});

test('pausing does not advance heat phase or alter wave sampling; reset releases optical state', t => {
  const air = haze(t), effects = { lights: [burn()], blastWaves: { waves: [wave()] } };
  air.update(.1); const first = structuredClone(air.collect(effects, camera));
  for (let i = 0; i < 20; i++) { air.update(0); air.update(NaN); air.update(-.1); assert.deepEqual(air.collect(effects, camera), first); }
  const renderer = { backBuffer: { useBackBuffer: true } };
  air.clear(renderer); assert.equal(air.time, 0); assert.equal(air.count, 0); assert.equal(air.sources.length, 0);
  assert.equal(renderer.backBuffer.useBackBuffer, false); assert.equal(air.host.visible, false);
});

test('same paused frame toggles refraction without resetting time or the faint sampled envelope', t => {
  const air = haze(t, true), renderer = { backBuffer: { useBackBuffer: false } }, original = wave(),
    effects = { lights: [burn()], blastWaves: { waves: [original] } };
  original.opacity = .18; original.displayAlpha = .004; original.sprite.alpha = .004;
  air.update(.123); air.sample(effects, camera, renderer);
  const sources = structuredClone(air.sources), geometry = [...air.positions];
  assert(sources[1].strength > 0 && sources[1].strength < .02, 'a faint front must also have faint refraction');
  air.setEnabled(false); assert.equal(renderer.backBuffer.useBackBuffer, false); assert.equal(air.count, 0);
  air.sample(effects, camera, renderer); assert.equal(air.host.visible, false); assert.equal(air.time, .123);
  air.setEnabled(true); air.sample(effects, camera, renderer);
  assert.deepEqual(air.sources, sources); assert.deepEqual([...air.positions], geometry); assert.equal(renderer.backBuffer.useBackBuffer, true);
});

test('aggregate filter area tracks world coordinates while the shared terrain stencil clips its output', t => {
  const air = haze(t, true), clip = new EffectSurfaceClip(), world = new Container(), renderer = { backBuffer: { useBackBuffer: false } };
  t.after(() => { clip.detach(air.host); clip.destroy(); world.destroy(); });
  world.position.set(camera.width / 2 - camera.x * camera.zoom, camera.height / 2 + camera.y * camera.zoom);
  world.scale.set(camera.zoom, -camera.zoom); world.addChild(air.host);
  clip.attach(air.host); clip.update(new Terrain('hills'), camera);
  air.sample({ lights: [burn()] }, camera, renderer); clip.sync();
  assert.equal(air.host.mask.context, clip.context); assert.equal(air.host.effects[0].pipe, 'stencilMask');
  assert.equal(air.host.effects[1].pipe, 'filter', 'the original framebuffer stencil must contain the final filtered quad');
  assert.equal(air.area.x, air.bounds.left); assert.equal(air.area.y, air.bounds.bottom);
  assert.equal(air.area.width, air.bounds.right - air.bounds.left);
  const bounds = air.host.getBounds(); assert(bounds.width < camera.width);
  assert(air.positions.every(Number.isFinite));
});

test('Renderer owns one optical host without moving actor geometry or Effects groups', t => {
  const r = new Renderer({}), world = new Container(); r.world = world; r.fxLayer = new Container(); r.actorLayerRoot = new Container();
  r.actorLayerRoot.sortableChildren = true; world.addChild(r.actorLayerRoot, r.fxLayer, r.heatHaze.host);
  const actors = [{ id: 'rear' }, { id: 'front' }]; r.syncActorLayers({ actors });
  const atlas = { smoke: Array(3).fill(Texture.EMPTY), fire: Array(3).fill(Texture.EMPTY), spark: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY };
  r.effects = new Effects(r.fxLayer, atlas); r.effects.actorLayer = id => r.actorLayers.get(id)?.fxLayer;
  const fire = r.effects.add('fire', { priority: true, flame: true, x: 10, y: .4, life: .8, actorId: 'rear' });
  r.effects.light(burn()); r.advanceEffects(.05); r.effects.sample(1);
  r.heatHaze.collect(r.effects, camera); r.heatHaze.writeGeometry();
  assert.equal(r.heatHaze.time, .05); assert(r.heatHaze.count > 0);
  assert.equal(fire.layer.parent.parent, r.actorLayers.get('rear').fxLayer);
  assert(!r.effects.actorLayers.get('rear').group.mask);
  assert(r.actorLayers.get('rear').container.zIndex < r.actorLayers.get('front').container.zIndex);
  assert.deepEqual(world.children, [r.actorLayerRoot, r.fxLayer, r.heatHaze.host]);
  t.after(() => { r.effects.clear(); r.effectSurfaceClip.destroy(); r.heatHaze.destroy(); world.destroy({ children: true }); });
});
