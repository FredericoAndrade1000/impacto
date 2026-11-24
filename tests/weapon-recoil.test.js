import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { FramePresentation } from '../src/presentation.ts';
import { visualRecoilStroke, startWeaponRecoil, advanceWeaponRecoil } from '../src/weapon-presentation.ts';
import { WeaponSprites } from '../src/weapon-sprites.ts';
import { weaponRecoilGuide, drawWeaponRecoilGuide } from '../src/weapon-art.ts';
import { weaponLayout, weaponPartBounds, recoilFrameBounds } from '../src/weapon-paint.ts';
import { WEAPON_PRESETS, recoilAt } from '../src/weapons.ts';

const gun = { id: 'local:gun', kind: 'weapon', weaponPreset: 'rh202', actorId: 'local',
  x: 2, y: 1, angle: 0, barrelAngle: 0, weaponMount: { hullAxis: 0 }, health: 100 };
const state = time => ({ time, actors: [], plates: [], modules: [gun], stats: {}, launcher: null });
const muzzle = (time, changes = {}) => ({ type: 'muzzle', time, platform: 'vehicle',
  componentId: gun.id, preset: gun.weaponPreset, angle: 0, x: 3.9, y: 1, ...changes });
function renderer() {
  const r = new Renderer({}, { mode: 'test' });
  r.effects = { consume() {}, update() {} };
  r.heatHaze = { update() {} };
  return r;
}

test('visual strokes distinguish heavy guns, rigid-barrel machine guns and recoilless launchers without changing admission', () => {
  const before = structuredClone(WEAPON_PRESETS);
  for (const preset of ['rh120', 'm119', 'm777', 'm242'])
    assert.equal(visualRecoilStroke(preset), recoilAt(preset, 0));
  for (const preset of ['minimi', 'fnmag']) {
    assert.equal(recoilAt(preset, 0), 0, 'the admitted physical stroke stays zero');
    assert(visualRecoilStroke(preset) > 0 && visualRecoilStroke(preset) < visualRecoilStroke('m2hb'));
  }
  for (const preset of ['at4', 'carlgustaf', 'hydra70', 'unknown']) assert.equal(visualRecoilStroke(preset), 0);
  assert(visualRecoilStroke('rh120') > visualRecoilStroke('m2hb') * 5);
  assert.equal(visualRecoilStroke('m777', 70 * Math.PI / 180), .84);
  assert.deepEqual(WEAPON_PRESETS, before);
});

test('a heavy gun moves back quickly and returns monotonically to battery without exceeding its stroke', () => {
  const motion = startWeaponRecoil(null, .3, 'rh120');
  assert.equal(motion.value, 0);
  advanceWeaponRecoil(motion, .012);
  assert(motion.value > .2 && motion.value < .3);
  advanceWeaponRecoil(motion, .013);
  assert.equal(motion.value, .3);
  let previous = motion.value;
  for (let frame = 0; frame < 120; frame++) {
    advanceWeaponRecoil(motion, 1 / 60);
    assert(motion.value >= 0 && motion.value <= previous);
    previous = motion.value;
  }
  assert(motion.value < .0005);
  assert.equal(advanceWeaponRecoil(motion, 0), false, 'the renderer can retire the finished motion');
});

test('rounds in one delivery animate at their recorded time, independently of rendering cadence, and pause with the world', () => {
  const original = state(.18), before = structuredClone(original), events = [.01, .07, .13].map(time => muzzle(time));
  const play = steps => {
    const r = renderer(), playback = new FramePresentation();
    playback.receive(state(0), [], { now: 0 });
    playback.receive(original, events, { now: 100 });
    for (const elapsed of steps) {
      const sample = playback.sample(100 + elapsed);
      r.scene = sample.scene;
      playback.present(sample, { consume: (event, ahead) => r.consumeEffect(event, ahead), update: dt => r.advanceEffects(dt) });
    }
    const motion = r.weaponRecoil.get(gun.id), value = motion.value;
    assert(value > 0 && value < .02);
    playback.paused = true;
    for (const now of [1000, 2000, 10000]) {
      const sample = playback.sample(now);
      playback.present(sample, { consume: (event, ahead) => r.consumeEffect(event, ahead), update: dt => r.advanceEffects(dt) });
      assert.equal(motion.value, value);
    }
    return value;
  };
  const coarse = play([180]), sixty = play([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 180]);
  assert(Math.abs(coarse - sixty) < 1e-12, `${coarse} versus ${sixty}`);
  assert.deepEqual(original, before);
});

test('automatic fire reuses its animation and smoothly restarts from the current position', () => {
  const stroke = visualRecoilStroke('rh202'), motion = startWeaponRecoil(null, stroke, 'rh202');
  advanceWeaponRecoil(motion, .06);
  const before = motion.value;
  assert(before > 0 && before < stroke * .5, 'the gun has time to return between rounds');
  assert.equal(startWeaponRecoil(motion, stroke, 'rh202'), motion);
  assert.equal(motion.value, before, 'a new shot does not teleport the tube forward');
  advanceWeaponRecoil(motion, .012);
  assert.equal(motion.value, stroke);
});

test('a first muzzle can animate before the previous scene contains its gun; a muzzle of no gun drawn shakes nothing', () => {
  const r = renderer();
  r.consumeEffect(muzzle(0, { preset: 'rh120' }));
  r.advanceEffects(.025);
  assert.equal(r.weaponRecoil.get(gun.id).value, .3);
  const keys = [...r.weaponRecoil.keys()];
  // An unseen gun may report its muzzle without its identity, as a gun of the core's own tests on no construction does.
  r.consumeEffect(muzzle(.1, { componentId: undefined }));
  r.consumeEffect(muzzle(.1, { platform: 'ground', componentId: undefined, preset: 'm777', angle: Math.PI }));
  assert.deepEqual([...r.weaponRecoil.keys()], keys);
  r.consumeEffect(muzzle(.2, { componentId: 'rocket', preset: 'at4' }));
  assert.deepEqual([...r.weaponRecoil.keys()], keys, 'a recoilless launcher stays still');
});

test('a recoil motion given another weapon starts from the battery position of that weapon', () => {
  const motion = startWeaponRecoil(null, visualRecoilStroke('m777'), 'm777');
  advanceWeaponRecoil(motion, .03); assert.equal(motion.value, 1.4);
  startWeaponRecoil(motion, visualRecoilStroke('minimi'), 'minimi');
  assert.equal(motion.value, 0, 'another weapon starts from its own battery position');
});

test('recoil and servo motion reuse the same sprites, texture keys and painters through a sustained burst', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    module = { ...gun, weaponPreset: 'rh120', materialPolygons: [rect(-1.1, -.26, 0, .26), rect(0, -.078, 1.8, .078),
      rect(-.4,-.4,.1,-.3), rect(-.4,.3,.1,.4), rect(.1, -.32, .4, -.08), rect(.1, .08, .4, .32)] },
    art = { canvas: { width: 100, height: 40 }, originX: 20, originY: 20, scale: 40 },
    keys = new Map(), entry = { texture: Texture.WHITE, art }, layer = new Container(),
    sprites = new WeaponSprites((key, create) => {
      if (keys.has(key)) assert.equal(create, keys.get(key), 'the retained painter does not allocate a closure per frame');
      else keys.set(key, create);
      return entry;
    }), paint = { recoil: 0 }, original = structuredClone(module);
  t.after(() => { sprites.clear(); layer.destroy({ children: true }); });
  const place = frame => {
    paint.recoil = Math.abs(Math.sin(frame * .3)) * .3;
    sprites.begin(); sprites.place(module.id, layer, module, frame * .003, module.weaponPreset, paint); sprites.end();
  };
  place(0);
  const receiver = layer.children[0], moving = layer.children[1];
  for (let frame = 1; frame < 240; frame++) {
    place(frame);
    assert.equal(layer.children[0], receiver); assert.equal(layer.children[1], moving);
    assert.equal(receiver.x, moving.x); assert.equal(receiver.y, moving.y);
  }
  assert.equal(keys.size, 3, 'the curved shield retains a separate picture even without a physical recoil reserve');
  assert.deepEqual(module, original);
});

test('the rear reservation box measures the exported full stroke alone, independently of current elevation', () => {
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    module = { ...gun, weaponPreset: 'm777', barrelAngle: 1.3,
      weaponMount: { ...gun.weaponMount, recoil: 1.4 },
      materialPolygons: [rect(-.5, -.225, 0, .225), rect(0, -.12, 6.8, .12),
        rect(.1, -.32, .4, -.12), rect(.1, .12, .4, .32)] }, before = structuredClone(module),
    guide = weaponRecoilGuide(module);
  assert.equal(guide.stroke, 1.4);
  assert.equal(guide.maxX, -.5, 'the air reserve starts behind the actual mechanism');
  assert.equal(guide.minX, -1.9);
  assert(Math.abs(guide.maxX - guide.minX - 1.4) < 1e-12, 'the box does not add the receiver length to its stated stroke');
  assert(recoilAt(module.weaponPreset, module.barrelAngle) < guide.stroke);
  assert.equal(weaponRecoilGuide({ ...module, barrelAngle: 0 }).minX, guide.minX);
  assert.equal(weaponRecoilGuide({ ...module, weaponMount: { recoil: 0 } }), null);
  assert.deepEqual(module, before);
});

test('the recoil reservation follows the bore and its drawing stays a guide outside the native solids', () => {
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    module = { ...gun, angle: -.3, barrelAngle: .6, weaponMount: { recoil: .03, exposed: true },
      materialPolygons: [rect(-.1, -.5, .1, 0), rect(0, -.03, .88, .03),
        rect(-.77, -.1, 0, .1), rect(.1, -.06, .2, .06)] },
    before = structuredClone(module), guide = weaponRecoilGuide(module), points = [],
    graphics = { moveTo(x, y) { points.push({ x, y }); return this; },
      lineTo(x, y) { points.push({ x, y }); return this; }, closePath() { return this; },
      fill(style) { assert(style.alpha < .1); return this; }, stroke() { return this; } };
  assert.equal(guide.angle, module.barrelAngle);
  assert.equal(guide.maxX, -.77, 'the post is not mistaken for the receiver');
  drawWeaponRecoilGuide(graphics, guide, .01);
  const first = points[0], c = Math.cos(guide.angle), s = Math.sin(guide.angle);
  assert(Math.abs((first.x - module.x) * c + (first.y - module.y) * s - guide.minX) < 1e-12);
  assert(Math.abs(-(first.x - module.x) * s + (first.y - module.y) * c - guide.minY) < 1e-12);
  assert.deepEqual(module, before, 'no material, collision polygon or placement is changed');
});

test('an open recoil cradle stays at the pivot while the breech and tube slide through its exact full travel', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    module = { ...gun, weaponPreset: 'm777', weaponMount: { recoil: 1.4 },
      materialPolygons: [rect(-.5, -.225, 0, .225), rect(0, -.12, 6.8, .12),
        rect(.1, -.32, .4, -.12), rect(.1, .12, .4, .32)] }, original = structuredClone(module),
    L = weaponLayout(module.weaponPreset, module.materialPolygons, 1, module.weaponMount.recoil),
    guide = weaponRecoilGuide(module), frame = recoilFrameBounds(L),
    art = { canvas: { width: 100, height: 40 }, originX: 20, originY: 20, scale: 40 },
    keys = new Map(), layer = new Container(), sprites = new WeaponSprites((key, create) => {
      if (keys.has(key)) assert.equal(create, keys.get(key));
      else keys.set(key, create);
      return { texture: Texture.WHITE, art };
    });
  t.after(() => { sprites.clear(); layer.destroy({ children: true }); });
  assert.equal(frame.x0, guide.minX); assert.equal(frame.x1, guide.maxX);
  assert(Math.abs(frame.x1 - frame.x0 - 1.4) < 1e-12);
  assert.deepEqual(weaponPartBounds(L, 'moving'), L.tube, 'the shield stays with the cradle instead of flying backwards');
  assert(weaponPartBounds(L, 'cradle').x0 <= frame.x0);
  for (const angle of [0, .6, Math.PI - .6]) for (const recoil of [0, .3, 1.4, .1, 0]) {
    sprites.begin(); sprites.place(module.id, layer, module, angle, module.weaponPreset, { recoil }); sprites.end();
    const [receiver, moving, cradle] = layer.children;
    assert.equal(cradle.x, module.x); assert.equal(cradle.y, module.y);
    assert.equal(cradle.rotation, angle);
    for (const sprite of [receiver, moving]) {
      assert.equal(sprite.x, module.x - Math.cos(angle) * recoil);
      assert.equal(sprite.y, module.y - Math.sin(angle) * recoil);
    }
  }
  assert.equal(keys.size, 3, 'the fixed support needs one cached texture, not a new one per shot');
  assert.deepEqual(module, original);
});
