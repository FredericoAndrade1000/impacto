import test from 'node:test';
import assert from 'node:assert/strict';
import { Container } from 'pixi.js';
import { groundSurfaces } from './helpers/ground-art.js';
import { Renderer } from '../src/render.ts';
import { TexturePainter } from '../src/texture-painter.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { watchContext, CONTEXT_WAIT } from '../src/context-loss.ts';

await initNativeDynamics();

// The renderer as the page has it once started (Renderer.init), drawing a design on its bench: what it paints is painted
// on the canvases of the headless fixture (helpers/headless-pixi.js), and nothing is shown. A builder, for the wear of its
// crane too.
function bench(t) {
  const blueprint = compileBlueprint(createConstruction('construction-truck')),
    view = { mode: 'edit', exterior: false, weapon: { platform: 'vehicle' }, buildTool: 'select' },
    renderer = new Renderer({ clientWidth: 1280, clientHeight: 720 }, view), image = { width: 512, height: 512 };
  renderer.app = { stage: new Container(), renderer: { render() {}, resize() {}, backBuffer: { useBackBuffer: false } } };
  renderer.wearImages = { scuffs: image, oxide: image, earth: image, oil: image }; renderer.wear();
  renderer.buildScene(groundSurfaces()); renderer.texturePainter = new TexturePainter(renderer.paintingMaterials());
  renderer.design(blueprint); view.editor = { blueprint, revision: 1, selectionIds: [] };
  Object.assign(renderer.camera, { x: 12, y: 1.5, zoom: 40 });
  t.after(() => {
    renderer.board.clearConstructions();
    for (const { texture } of renderer.textures.values()) texture.destroy(true);
    renderer.app.stage.destroy({ children: true });
  });
  return renderer;
}

test('a context given back paints every picture again on canvases of its own, and the next frame draws the design with them', t => {
  const renderer = bench(t);
  renderer.draw({ now: 0 });
  const board = renderer.board, entries = [...renderer.textures.values()], canvases = new Set(entries.map(entry => entry.texture.source.resource)),
    wear = renderer.weatheringMaps, fills = Object.values(renderer.weatheringFills.workArm), painter = renderer.texturePainter,
    arms = [...board.workArms.values()], atlases = [renderer.shotAtlas, renderer.effects.atlas.glow], sheets = atlases.map(atlas => atlas.source.resource),
    ranges = renderer.backdrop.cache.filter(entry => entry.key);
  assert(board.actorLayers.has('local') && board.drawables.size && board.hullSprites.size, 'the design is drawn');
  assert(entries.some(entry => entry.persistent) && entries.some(entry => !entry.persistent));
  assert(arms.length && arms.every(arm => arm.weathering), 'its crane is drawn with the wear');
  assert(ranges.length, 'the ranges behind are painted');

  renderer.repaint();
  assert.equal(renderer.textures.size, 0, 'no picture is kept, not even those kept for the whole game');
  assert(entries.every(entry => entry.texture.destroyed));
  assert.equal(board.actorLayers.size + board.drawables.size + board.hullSprites.size, 0, 'the drawings that held them go with them');
  assert(arms.every(arm => arm.weathering === null));
  assert.notEqual(renderer.weatheringMaps.id, wear.id, 'the wear is made again from its images');
  assert(fills.every(fill => fill.texture.destroyed));
  assert.notEqual(renderer.texturePainter, painter); assert.equal(painter.available, false, 'the painter of the lost canvases is let go');
  atlases.forEach((atlas, i) => {
    assert(!atlas.destroyed, 'the rounds and the effects keep their atlas');
    assert.notEqual(atlas.source.resource, sheets[i], 'painted again on a canvas of its own');
  });
  assert(ranges.every(entry => entry.key === null && entry.place === null), 'the ranges are painted again when next shown');

  renderer.draw({ now: 20 });
  const again = [...renderer.textures.values()], current = new Set(Object.values(renderer.weatheringFills.workArm).map(fill => fill.texture));
  assert(board.actorLayers.has('local') && board.drawables.size && board.hullSprites.size, 'the next frame draws the design again');
  assert.equal(again.length, entries.length, 'with as many pictures as before');
  assert(again.every(entry => !entry.texture.destroyed && !canvases.has(entry.texture.source.resource)), 'each on a canvas of its own');
  assert(arms.every(arm => Object.values(arm.weathering).every(face => current.has(face.fill.texture))), 'the crane with the new wear');
  assert(renderer.backdrop.cache.some(entry => entry.key), 'and the ranges');
});

test('a context not given back in time is told gone once, and one given back is told restored', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const canvas = new EventTarget(), told = [], event = type => canvas.dispatchEvent(new Event(type));
  watchContext(canvas, { gone: () => told.push('gone'), restored: () => told.push('restored') });
  event('webglcontextlost'); t.mock.timers.tick(CONTEXT_WAIT - 1); event('webglcontextrestored'); t.mock.timers.tick(CONTEXT_WAIT);
  assert.deepEqual(told, ['restored'], 'given back in time, it is not gone');
  event('webglcontextlost'); t.mock.timers.tick(CONTEXT_WAIT); t.mock.timers.tick(CONTEXT_WAIT);
  assert.deepEqual(told, ['restored', 'gone']);
  event('webglcontextrestored');
  assert.deepEqual(told, ['restored', 'gone', 'restored'], 'given back after all, the page is told so');
});
