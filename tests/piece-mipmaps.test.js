import test from 'node:test';
import assert from 'node:assert/strict';
import { Container } from 'pixi.js';
import { MODULES } from '../src/materials.ts';
import { Renderer } from '../src/render.ts';
import { WeaponSprites } from '../src/weapon-sprites.ts';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();

// Read between the two levels nearest the size it is shown at, each of them read smooth.
function assertTrilinear(texture, what) {
  const { source } = texture;
  assert.equal(source.autoGenerateMipmaps, true, what + ' keeps its smaller levels');
  assert.deepEqual([source.style.minFilter, source.style.magFilter, source.style.mipmapFilter], ['linear', 'linear', 'linear'], what);
}

test('the picture of every piece is read through its mipmaps, between the two nearest levels', t => {
  const renderer = new Renderer({});
  t.after(() => { for (const { texture } of renderer.textures.values()) texture.destroy(true); });
  const pieces = [['engine'], ['ammo', { ammoPreset: '' }], ['command'], ['fuel'],
    ['hopper', { capacityM3: 1 }], ['cistern', { capacityM3: 1 }], ['supply', { capacityM3: 1 }],
    ['sensor', { sensorMode: 'visual' }], ['sensor', { sensorMode: 'sound' }], ['sensor', { sensorMode: 'radar' }],
    ...['face', 'back', 'edge'].map(style => ['sensor', { sensorMode: 'radar', style }]),
    ...['road', 'sprocket', 'idler', 'roller', 'shade'].map(style => ['wheel', { style }]),
    ['track', { overlay: true }], ['engine', { metal: 'titanium' }]];
  for (const [kind, options = {}] of pieces) {
    const texture = renderer.moduleTexture({ ...MODULES[kind], kind, ...options });
    assertTrilinear(texture, `${kind} ${JSON.stringify(options)}`);
  }
});

test('a damaged piece keeps the mipmaps of its picture, and each repaint is uploaded again for them to be made anew', t => {
  const renderer = new Renderer({}), mark = u => ({ u, v: .5, radius: .1, depth: .01, strength: 1, dx: 1, dy: 0 });
  t.after(() => { for (const { texture } of renderer.textures.values()) texture.destroy(true); });
  for (const look of [{ kind: 'engine', ...MODULES.engine }, { kind: 'sensor', sensorMode: 'radar', style: 'back', width: 1, height: .7 }]) {
    const module = { ...look, id: 'piece-' + look.kind, marks: [mark(.3)], markRevision: 1 },
      base = renderer.moduleTexture({ ...module, marks: [] }), damaged = renderer.moduleTexture(module);
    assert.notEqual(damaged, base); assertTrilinear(damaged, 'a damaged ' + look.kind);
    let uploads = 0; damaged.source.on('update', () => uploads++);
    assert.equal(renderer.moduleTexture(module), damaged); assert.equal(uploads, 0, 'nothing new to paint, nothing sent');
    module.marks = [...module.marks, mark(.6)]; module.markRevision = 2;
    assert.equal(renderer.moduleTexture(module), damaged); assert.equal(uploads, 1, 'a new mark is sent once, its levels made from it');
  }
  // The armour is sampled as before, and its damaged copy as its base is.
  const plate = { id: 'plate', material: 'steel', marks: [mark(.4)], markRevision: 1, definition: { length: 2, thicknessMm: 40 } },
    material = renderer.getTexture({ ...plate, marks: [] }), damaged = renderer.getTexture(plate);
  assert.notEqual(damaged, material); assert.equal(damaged.source.autoGenerateMipmaps, material.source.autoGenerateMipmaps);
});

test('the picture of a weapon is read through its mipmaps too', t => {
  const cache = new Map(), layer = new Container(),
    sprites = new WeaponSprites((key, create) => { if (!cache.has(key)) cache.set(key, { texture: create() }); return cache.get(key); });
  t.after(() => { layer.destroy({ children: true }); for (const { texture } of cache.values()) texture.destroy(true); });
  sprites.place('gun', layer, { x: 0, y: 0 }, .2, 'rh120');
  assert(cache.size > 0);
  for (const { texture } of cache.values()) assertTrilinear(texture, 'the gun');
});
