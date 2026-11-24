import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Sprite } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { radarAerial, aerialView } from '../src/machine-art.ts';
import { AERIAL_TURN } from '../src/base-art.ts';
import { componentTint } from '../src/impact-damage.ts';
import { paintTextureCanvas } from '../src/texture-paint.ts';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();

// Observe distinct pictures while using the real module painter and canonical texture cache.
function aerials(t) {
  const renderer = new Renderer({}, { mode: 'test' }), asked = [], item = { group: new Container() },
    moduleTexture = renderer.moduleTexture.bind(renderer);
  renderer.moduleTexture = look => {
    const texture = moduleTexture(look);
    if (!asked.some(picture => picture.texture === texture)) asked.push({ ...look, texture });
    return texture;
  };
  t.after(() => {
    item.group.destroy({ children: true });
    for (const { texture } of renderer.textures.values()) texture.destroy(true);
    renderer.textures.clear();
  });
  // The aerial of `module` as a frame `now` milliseconds in draws it.
  const frame = (module, now) => { renderer.frameNow = now; renderer.drawAerial(item, module); return item.aerial; };
  return { renderer, asked, item, frame };
}
const RADAR = { kind: 'sensor', sensorMode: 'radar', width: 1, height: .84, health: 35, maxHealth: 35, attached: true, actorId: 'a', id: 'a:radar' };
// A colour as lit as `light`, channel by channel.
const lit = (color, light) => [16, 8, 0].reduce((sum, shift) => sum | Math.round((color >> shift & 255) * light) << shift, 0);
// Where each side of an aerial is laid, or false for one not shown.
const laid = aerial => aerial.children.map(side => side.visible && [side.x, side.y, side.scale.x, side.scale.y]);

test('a turning radar reuses two flat sprites and the canonical texture of each face', t => {
  const { renderer, asked, item, frame } = aerials(t), aerial = frame(RADAR, 0), sides = [...aerial.children], shape = radarAerial(RADAR.width, RADAR.height);
  assert(sides.length === 2 && sides.every(side => side instanceof Sprite));
  assert.deepEqual([aerial.x, aerial.y], [0, shape.y], 'its middle over the middle of the box, by the turntable at its foot');
  const shown = new Set();
  for (let now = 0; now < 3000; now += 25) {
    assert.equal(frame(RADAR, now), aerial); assert.deepEqual(aerial.children, sides);
    const view = aerialView(shape, aerial.radar.bearing + now / 1000 * AERIAL_TURN);
    sides.forEach((side, i) => {
      assert.equal(side.visible, i < view.count);
      if (!side.visible) return;
      const face = view.faces[i];
      const c = face.corners;
      assert.equal(side.x, (c[0] + c[2]) / 2); assert.equal(side.y, 0);
      assert.equal(side.scale.x, (c[2] - c[0]) / side.texture.width);
      assert.equal(side.scale.y, -shape.height / side.texture.height);
      assert.deepEqual([side.anchor.x, side.anchor.y], [.5, .5]);
      assert.equal(asked.find(picture => picture.texture === side.texture).style, face.style); assert.equal(side.tint, lit(0xffffff, face.light));
      shown.add(face.style);
    });
    // Adjacent sides share an upright without overlap or a gap.
    if (view.count === 2) {
      const ends = sides.map(side => [side.x - side.scale.x * side.texture.width / 2, side.x + side.scale.x * side.texture.width / 2]);
      assert(ends[0].some(a => ends[1].some(b => Math.abs(a - b) < 1e-12)), `${now}: the two sides part`);
    }
  }
  assert.deepEqual([...shown].sort(), ['back', 'edge', 'face']);
  assert.equal(renderer.textures.size, 3, 'a full turn retains just the three canonical face pictures');
  assert.deepEqual(asked.map(look => [look.kind, look.sensorMode, look.style, look.width, look.height]).sort(),
    [['sensor', 'radar', 'back', 1, shape.height], ['sensor', 'radar', 'edge', shape.depth, shape.height], ['sensor', 'radar', 'face', 1, shape.height]]);
  // The cache owns released pictures; a radar of another size has its aerial made anew.
  for (const entry of renderer.textures.values()) entry.texture.destroy(true);
  renderer.textures.clear();
  asked.length = 0; frame(RADAR, 0);
  assert.deepEqual(asked.map(look => look.style), sides.filter(side => side.visible).map(side => asked.find(picture => picture.texture === side.texture).style));
  const bigger = frame({ ...RADAR, width: 1.6 }, 0);
  assert(bigger !== aerial && aerial.destroyed && item.aerial === bigger && bigger.radar.shape.width === 1.6);
});

test('faces first seen while the painter is busy become ready on ordinary cache lookups without replacing their sprites or sources', async t => {
  const { renderer, item, frame } = aerials(t);
  let resolve;
  const painter = renderer.texturePainter = { available: true, busy: true, request: null,
    paint(request) {
      assert.equal(this.busy, false); this.busy = true; this.request = request;
      return new Promise(done => { resolve = done; });
    } };
  const aerial = frame(RADAR, 0), turn = Math.PI / 4,
    now = ((turn - aerial.radar.bearing + 2 * Math.PI) % (2 * Math.PI)) / AERIAL_TURN * 1000;
  frame(RADAR, now);
  const sides = [...aerial.children], visible = sides.filter(side => side.visible),
    retained = visible.map(side => ({ side, texture: side.texture, source: side.texture.source, picture: side.texture.source.resource }));
  assert.equal(visible.length, 2, 'exercise two adjacent faces born while no painting slot is free');
  renderer.paintNextTexture(); assert.equal(painter.request, null);
  for (const entry of renderer.textures.values()) assert(entry.paint, 'busy faces retain their pending description');
  for (const { picture } of retained) assert(picture.width <= 96 && picture.height <= 96);
  const completed = new Set(), finish = async () => {
    const request = painter.request;
    assert.equal(request.kind, 'sensor'); assert.equal(request.options.sensorMode, 'radar');
    assert(!completed.has(request.options.style), 'a completed canonical face is reused');
    const picture = paintTextureCanvas(request, renderer.paintingMaterials());
    picture.closes = 0; picture.close = () => { picture.closes++; };
    painter.busy = false; resolve(picture); await Promise.resolve();
    assert.equal(picture.closes, 1); completed.add(request.options.style);
  };
  painter.busy = false;
  for (const unused of visible) {
    frame(RADAR, now); renderer.paintNextTexture(); await finish();
  }
  frame(RADAR, now);
  const view = aerialView(aerial.radar.shape, aerial.radar.bearing + now / 1000 * AERIAL_TURN);
  assert.deepEqual(aerial.children, sides);
  for (const [i, { side, texture, source, picture }] of retained.entries()) {
    assert.equal(side.parent, aerial); assert.equal(side.texture, texture); assert.equal(texture.source, source); assert.equal(source.resource, picture);
    assert(picture.width > 96 || picture.height > 96);
    assert.equal(side.x, (view.faces[i].corners[0] + view.faces[i].corners[2]) / 2);
    assert.equal(side.scale.x, (view.faces[i].corners[2] - view.faces[i].corners[0]) / texture.width);
    assert.equal(side.scale.y, -aerial.radar.shape.height / texture.height);
  }
  // Turning to the other broad face also drains a previously hidden pending picture.
  frame(RADAR, now + Math.PI / AERIAL_TURN * 1000); renderer.paintNextTexture(); await finish();
  frame(RADAR, now + Math.PI / AERIAL_TURN * 1000);
  assert.equal(completed.size, 3); assert.equal(renderer.textures.size, 3);
  assert([...renderer.textures.values()].every(entry => !entry.paint));
  const cached = new Set([...renderer.textures.values()].map(entry => entry.texture)), other = { group: item.group.addChild(new Container()) };
  renderer.drawAerial(other, { ...RADAR, id: 'b:radar', actorId: 'b' });
  assert.equal(renderer.textures.size, 3);
  for (const side of other.aerial.children) if (side.visible) assert(cached.has(side.texture), 'another actor borrows the same finished picture');
});

test('a radar points its own way, and one out of order, loose, wrecked or a ghost stands still in its colour', t => {
  const { renderer, frame } = aerials(t), still = module => [0, 700, 1900].map(now => laid(frame(module, now)));
  const turning = still(RADAR);
  assert.notDeepEqual(turning[0], turning[1]); assert.notDeepEqual(turning[1], turning[2]);
  assert.notDeepEqual(laid(frame({ ...RADAR, id: 'a:other' }, 0)), laid(frame(RADAR, 0)), 'another radar points elsewhere');
  const broken = { ...RADAR, health: 0 }, loose = { ...RADAR, attached: false };
  for (const module of [broken, loose]) {
    const [first, ...rest] = still(module);
    for (const later of rest) assert.deepEqual(later, first);
  }
  // A wreck and a ghost: the layer of their construction stands still.
  renderer.actorLayers.set(RADAR.actorId, { still: true });
  const [first, ...rest] = still(RADAR);
  for (const later of rest) assert.deepEqual(later, first);
  renderer.actorLayers.delete(RADAR.actorId);
  // Each side is the colour of the radar, as lit as it faces the view.
  const aerial = frame(broken, 0), view = aerialView(aerial.radar.shape, aerial.radar.bearing);
  aerial.children.forEach((side, i) => { if (side.visible) assert.equal(side.tint, lit(componentTint(broken), view.faces[i].light)); });
  assert.notEqual(componentTint(broken), 0xffffff);
});
