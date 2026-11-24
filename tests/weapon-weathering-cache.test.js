import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { WeaponSprites } from '../src/weapon-sprites.ts';

const rectangle = (left, bottom, right, top) => [
  { x: left, y: bottom }, { x: right, y: bottom },
  { x: right, y: top }, { x: left, y: top },
];
const polar = (radius, angle) => ({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
function fixture() {
  const facets = [];
  for (const [start, end] of [[-.9, -.15], [.15, .9]]) for (let i = 0; i < 8; i++) {
    const from = start + (end - start) * i / 8, to = start + (end - start) * (i + 1) / 8;
    facets.push([polar(.9, from), polar(.95, from), polar(.95, to), polar(.9, to)]);
  }
  return { id: 'gun', kind: 'weapon', weaponPreset: 'm777', x: 3, y: 2,
    angle: Math.PI, barrelAngle: Math.PI + .12, targetBarrelAngle: Math.PI + .3,
    weaponMount: { version: 2, exposed: false, recoil: 1.4, min: -.6, max: .6,
      shield: { radius: .9, thickness: .05, halfAngle: .9, opening: .9 * Math.sin(.15) } },
    materialPolygons: [rectangle(-.5, -.225, 0, .225), rectangle(0, -.12, 6.8, .12), ...facets] };
}

function harness(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { createElement() { assert.fail('placing cached weapon artwork cannot paint a canvas'); } };
  const layer = new Container(), cache = new Map(), requests = [], retained = [],
    art = { canvas: { width: 800, height: 300 }, originX: 200, originY: 150, scale: 100 },
    pictures = new WeaponSprites((key, create, place) => {
      requests.push({ key, create, place });
      if (!cache.has(key)) cache.set(key, { key, texture: Texture.WHITE, art });
      return cache.get(key);
    }, entry => retained.push(entry));
  t.after(() => {
    pictures.clear(); layer.destroy({ children: true });
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
  });
  const place = (module, options = {}) => {
    const start = requests.length, before = structuredClone(module), recoil = options.recoil ?? 0;
    pictures.begin(); pictures.place(module.id, layer, module, module.barrelAngle, module.weaponPreset, options); pictures.end();
    const item = pictures.items.get(module.id), calls = requests.slice(start);
    assert.equal(item.parts.length, 3); assert.equal(calls.length, 3);
    assert.equal(item.sprites.filter(sprite => sprite.visible).length, 3);
    const [receiver, tube, mask] = item.sprites;
    assert.deepEqual([mask.x, mask.y, mask.rotation], [module.x, module.y, module.barrelAngle], 'the weathered mask remains on the trunnion');
    for (const sprite of [receiver, tube]) {
      assert.equal(sprite.x, module.x - Math.cos(module.barrelAngle) * recoil);
      assert.equal(sprite.y, module.y - Math.sin(module.barrelAngle) * recoil);
    }
    assert.deepEqual(module, before, 'cosmetic cache placement leaves the physical snapshot unchanged');
    return { item, calls };
  };
  return { place, pictures, layer, cache, requests, retained };
}

const identity = ({ item, calls }) => ({ sprites: item.sprites.slice(), parts: item.parts,
  textures: item.textures.slice(), calls });
function sameArtwork(actual, expected) {
  assert.equal(actual.item.parts, expected.parts, 'motion and equal material IDs keep the artwork descriptors');
  for (let part = 0; part < 3; part++) {
    assert.equal(actual.item.sprites[part], expected.sprites[part], 'the scene sprite is retained');
    assert.equal(actual.item.textures[part], expected.textures[part], 'the cached texture entry is retained');
    assert.equal(actual.calls[part].key, expected.calls[part].key);
    assert.equal(actual.calls[part].create, expected.calls[part].create, 'the painter closure is retained');
    assert.equal(actual.calls[part].place, expected.calls[part].place);
  }
}

for (const weathering of [null, Object.freeze({ id: 11 })]) {
  test(`${weathering ? 'weathered' : 'plain'} curved guns retain artwork through snapshot replacement, aiming, recoil and facing changes`, t => {
    const { place, cache } = harness(t), source = fixture(), before = structuredClone(source),
      initial = identity(place(source, { weathering }));
    for (let frame = 1; frame <= 240; frame++) {
      const snapshot = { ...structuredClone(source), x: source.x + frame / 30, y: source.y + Math.sin(frame / 10),
        angle: frame / 17, barrelAngle: -Math.PI * 2 + frame / 23, targetBarrelAngle: frame / 7 };
      sameArtwork(place(snapshot, { weathering, recoil: frame % 12 / 20, alpha: .4 + frame % 6 / 10,
        tint: frame % 2 ? 0xffffff : 0xb9b7a9 }), initial);
    }
    assert.equal(cache.size, 3, '240 replacement snapshots need only the three initial texture keys');
    assert.deepEqual(source, before);
  });
}

test('only a changed weathering map ID invalidates the three artwork descriptors and null recovers plain cached entries', t => {
  const { place, cache } = harness(t), gun = fixture(), plain = identity(place(gun)),
    maps11 = Object.freeze({ id: 11 }), weathered = identity(place(gun, { weathering: maps11, recoil: .3 }));
  assert.equal(cache.size, 6);
  for (let part = 0; part < 3; part++) {
    assert.equal(weathered.sprites[part], plain.sprites[part]);
    assert.notEqual(weathered.calls[part].key, plain.calls[part].key);
    assert.notEqual(weathered.calls[part].create, plain.calls[part].create);
    assert.equal(weathered.calls[part].place, plain.calls[part].place, 'the transient cache still names the same physical part');
  }
  for (let frame = 0; frame < 60; frame++) {
    sameArtwork(place(structuredClone(gun), { weathering: Object.freeze({ id: 11 }), recoil: frame / 100 }), weathered);
  }
  assert.equal(cache.size, 6, 'new immutable map objects with the same ID do not invalidate textures');
  const replacement = identity(place(gun, { weathering: Object.freeze({ id: 12 }), recoil: .4 }));
  assert.equal(cache.size, 9, 'a new map ID requests one new texture per artwork part');
  for (let part = 0; part < 3; part++) {
    assert.equal(replacement.sprites[part], plain.sprites[part]);
    assert.notEqual(replacement.calls[part].key, weathered.calls[part].key);
    assert.notEqual(replacement.calls[part].create, weathered.calls[part].create);
  }
  sameArtwork(place(structuredClone(gun), { weathering: Object.freeze({ id: 12 }), recoil: .2 }), replacement);
  const restored = identity(place(gun, { weathering: null, recoil: .1 }));
  assert.deepEqual(restored.calls.map(call => call.key), plain.calls.map(call => call.key));
  assert.equal(cache.size, 9, 'returning to plain material reuses its existing cache keys');
  for (let part = 0; part < 3; part++) {
    assert.equal(restored.sprites[part], plain.sprites[part]);
    assert.equal(restored.textures[part], plain.textures[part]);
  }
  sameArtwork(place(structuredClone(gun), { recoil: .15 }), restored);
});

test('offscreen retention keeps all three weathered cache entries without requesting painters', t => {
  const { place, pictures, cache, requests, retained } = harness(t), gun = fixture(),
    initial = identity(place(gun, { weathering: Object.freeze({ id: 11 }), recoil: .2 })), calls = requests.length;
  for (let frame = 0; frame < 120; frame++) {
    retained.length = 0; pictures.begin(); pictures.retain(gun.id); pictures.end();
    assert.deepEqual(retained, initial.textures);
    assert.equal(requests.length, calls, 'retaining a hidden gun cannot request another painter');
    for (const [part, sprite] of initial.sprites.entries()) {
      assert.equal(pictures.items.get(gun.id).sprites[part], sprite); assert.equal(sprite.destroyed, false);
    }
  }
  assert.equal(cache.size, 3);
  sameArtwork(place(structuredClone(gun), { weathering: Object.freeze({ id: 11 }), recoil: .1 }), initial);
  pictures.begin(); pictures.end();
  assert.equal(pictures.items.size, 0); assert(initial.sprites.every(sprite => sprite.destroyed));
});
