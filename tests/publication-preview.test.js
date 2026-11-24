import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { boardHeight, fieldX } from '../src/workshop-site.ts';
import { weaponAngle, weaponBarrelProfile } from '../src/weapon-geometry.ts';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();
const post = compileBlueprint(createStructuredTemplate('guard-post'));
const bunker = compileBlueprint(createStructuredTemplate('bunker'));
function fixture(t) {
  const renderer = new Renderer({}, { mode: 'test' });
  renderer.world = new Container(); renderer.benchArt = renderer.world.addChild(new Container());
  renderer.ground = { height: x => 100 + (x - 125300) * .18 };
  Object.assign(renderer.camera, { x: 125300, y: 102, zoom: 36, width: 844, height: 390 });
  t.after(() => {
    renderer.previewConstruction(null); renderer.usedTextures.clear(); renderer.releaseTextures(true);
    renderer.effectSurfaceClip.destroy(); renderer.world.destroy({ children: true, context: true });
  });
  return renderer;
}
const siteAt = (renderer, blueprint, x, facing) => ({ x: x - 12, y: boardHeight(blueprint, x, renderer.ground, facing), mirror: facing > 0 });

test('placement draws the real external hull and weapon in either facing on the actual ground, sharing the field cache', t => {
  const renderer = fixture(t), before = JSON.stringify(post), rootDesign = renderer.designState = {}, rootBlueprint = renderer.blueprint = post;
  for (const facing of [-1, 1]) {
    const site = siteAt(renderer, post, 125300, facing);
    renderer.usedTextures.clear(); renderer.previewConstruction(post, site); renderer.drawConstructionPreview();
    const preview = renderer.constructionPreview, gun = preview.designState.modules.find(module => module.kind === 'weapon'),
      drawn = preview.weaponArt.items.get(gun.id), barrel = drawn.sprites[1], tipX = gun.x + Math.cos(weaponAngle(gun)) * weaponBarrelProfile(gun).end;
    assert.equal(preview.host, renderer); assert.equal(preview.textures, renderer.textures);
    assert.equal(preview.closed.has('local'), true, 'placement shows the same closed side as the field');
    assert([...preview.hullSprites.values()].some(sprite => sprite.visible && sprite.texture !== Texture.WHITE), 'the exterior is painted, not boxes alone');
    assert(barrel.visible && barrel.width > 0 && barrel.height > 0, 'the real barrel artwork must be visible');
    assert.equal(barrel.rotation, weaponAngle(gun)); assert.equal(barrel.x, gun.x); assert.equal(barrel.y, gun.y);
    assert.equal(Math.sign(fieldX(site, tipX) - fieldX(site, gun.x)), facing, 'the barrel points to the chosen side');
    assert.equal(preview.body.x, site.mirror ? site.x + 24 : site.x); assert.equal(preview.body.y, site.y);
    assert.equal(preview.body.scale.x, site.mirror ? -1 : 1); assert.equal(preview.body.alpha, .68);
    assert.equal(preview.ground.height(11), renderer.ground.height(fieldX(site, 11)) - site.y);
    assert.equal(renderer.blueprint, rootBlueprint); assert.equal(renderer.designState, rootDesign);
    assert.equal(JSON.stringify(post), before, 'drawing cannot change the compiled project');
  }
});

test('moving keeps the appearance, changing models retires old drawables, and cancel/entering the workshop hide the preview', t => {
  const renderer = fixture(t);
  renderer.previewConstruction(post, siteAt(renderer, post, 125300, -1)); renderer.drawConstructionPreview();
  const preview = renderer.constructionPreview, gun = preview.designState.modules.find(module => module.kind === 'weapon'),
    first = preview.weaponArt.items.get(gun.id), texture = first.sprites[1].texture, ground = preview.ground;
  renderer.previewConstruction(post, siteAt(renderer, post, 125320, -1)); renderer.drawConstructionPreview();
  assert.equal(preview.weaponArt.items.get(gun.id).sprites[1].texture, texture, 'moving the hover reuses the same artwork');
  assert.notEqual(preview.ground, ground, 'the footing follows the ground of the new place');
  renderer.previewConstruction(bunker, siteAt(renderer, bunker, 125320, 1)); renderer.drawConstructionPreview();
  assert(first.sprites.every(sprite => sprite.destroyed), 'changing the design retires the old weapon drawing');
  assert.equal(preview.designState.modules.filter(module => module.kind === 'weapon').length, preview.weaponArt.items.size);
  renderer.previewConstruction(bunker, null); renderer.drawConstructionPreview(); assert.equal(preview.body.visible, false);
  renderer.previewConstruction(bunker, siteAt(renderer, bunker, 125320, 1));
  renderer.view.mode = 'edit'; renderer.drawConstructionPreview(); assert.equal(preview.body.visible, false);
  renderer.previewConstruction(null);
  assert.equal(renderer.constructionPreview, null); assert.equal(preview.body.destroyed, true); assert.equal(preview.marks.destroyed, true);
  assert.equal(preview.drawables.size + preview.hullSprites.size + preview.weaponArt.items.size, 0);
  assert.equal(renderer.world.children.length, 1, 'only the original field layer remains');
});

test('a placement over unknown ground prepares neither a board nor textures', t => {
  const renderer = fixture(t); renderer.ground.height = () => { throw Error('Unknown relief must not be read.'); };
  renderer.previewConstruction(post, null); renderer.drawConstructionPreview();
  assert.equal(renderer.constructionPreview, undefined); assert.equal(renderer.textures.size, 0);
});
