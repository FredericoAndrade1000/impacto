import test from 'node:test';
import assert from 'node:assert/strict';
import { BatcherPipe, BlendModePipe, ColorMaskPipe, Container, Graphics, MeshPipe, RenderGroupSystem, Sprite, Texture, TextureSource } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { TyreShade } from '../src/tyre-shade.ts';
import { designFrame, sampleScene } from '../src/scene-frame.ts';
import { Terrain } from '../src/terrain.ts';
import { countingCanvas } from './scenery-canvas.js';

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
// The picture of a wheel and the still shade over it, told apart.
const picture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) }), shade = Texture.WHITE;
const wheel = (id, x, spin) => ({ id, kind: 'wheel', x, y: .5, angle: 0, width: 1, height: 1, health: 80, maxHealth: 80, attached: true, wheelSpin: spin, wheelAngularSpeed: 0 });
function frame(modules) {
  const state = designFrame({ plates: [], modules });
  state.actors[0].vehicle = { x: 12, y: 1.3, angle: 0, chassisId: 'root', travel: 0 };
  return state;
}
function presenter(t) {
  countingCanvas(t);
  const renderer = new Renderer({}); renderer.actorLayerRoot = new Container();
  renderer.shadows = new Graphics(); renderer.ground = new Terrain('flat');
  renderer.moduleTexture = module => module.style === 'shade' ? shade : picture;
  t.after(() => {
    for (const item of renderer.drawables.values()) { item.group.destroy({ children: true }); item.geometry.destroy(); }
    renderer.actorLayerRoot.destroy({ children: true }); renderer.shadows.destroy();
  });
  return renderer;
}
const draw = (renderer, state) => { renderer.scene = sampleScene(state, null, 1); renderer.syncActorLayers(state); renderer.drawSurfaces(); };

test('a tyre wears the light of the sky and its own shade on its picture alone, still while it turns', t => {
  const renderer = presenter(t), turned = spin => frame([wheel('front', 13.5, spin), wheel('back', 10.5, spin + 1)]);
  draw(renderer, turned(.7));
  const [front, back] = ['front', 'back'].map(id => renderer.drawables.get(id)), shader = front.mesh.shader;
  assert(shader instanceof TyreShade, 'a wheel 65 pixels high is drawn with the shade of a tyre');
  assert.notEqual(back.mesh.shader, shader); assert.equal(back.mesh.shader.glProgram, shader.glProgram, 'each its own, one program for all');
  assert.equal(front.mesh.batched, false);
  assert.equal(shader.resources.uTexture, picture.source); assert.equal(shader.resources.uShade, shade.source);
  // The picture turns with the wheel; the shade is read where each place of it stands once turned.
  near(front.mesh.rotation, .7); assert.equal(shader.spin, front.mesh.rotation); near(back.mesh.shader.spin, 1.7);
  // The drum belongs to the same picture: no extra layer is laid over the wheel or between its tread blocks.
  for (const item of [front, back]) assert.deepEqual(item.group.children, [item.mesh]);
  assert(!renderer.actorLayerRoot.children.some(function holds(node) { return node instanceof Sprite || node.children.some(holds); }));
  draw(renderer, turned(2.1));
  assert.equal(front.mesh.shader, shader); near(shader.spin, 2.1);
  // A wheel a few pixels high is part of the speck its construction is, unlit and drawn in one go with the rest of it.
  renderer.camera.zoom = 2; draw(renderer, turned(2.4));
  for (const item of [front, back]) { assert.equal(item.mesh.shader, null); assert.equal(item.mesh.batched, true); }
  renderer.camera.zoom = 65; draw(renderer, turned(2.6));
  assert.equal(front.mesh.shader, shader); near(shader.spin, 2.6);
  // A wheel that goes takes its shader with it.
  let gone = 0; for (const item of [front, back]) item.mesh.shader.once('destroy', () => gone++);
  draw(renderer, frame([]));
  assert.equal(gone, 2); assert.equal(renderer.drawables.size, 0);
  picture.destroy(true);
});

test('a tyre held on the rail of a wheeled chassis wears the shade of the fender over it, and loses it off the rail', t => {
  const renderer = presenter(t), own = () => new Texture({ source: new TextureSource({ width: 8, height: 8 }) }), [tyre, open, fendered] = [own(), own(), own()];
  renderer.moduleTexture = module => ({ shade: open, fendered })[module.style] || tyre;
  // The rail is drawn as a plate of its own: any picture will do for it.
  renderer.getTexture = () => tyre;
  const rail = { id: 'rail', x: 12, y: 1.05, angle: 0, length: 4, thicknessMm: 8, widthM: 2.4, material: 'steel', chassis: { kind: 'wheeled', model: 'wheeled', part: 'rail', depth: .18 } },
    held = (attached = true) => { const state = frame([{ ...wheel('held', 13.5, 0), mountId: 'rail', attached }, wheel('loose', 10.5, 0)]);
      return { ...state, plates: designFrame({ plates: [rail], modules: [] }).plates }; };
  draw(renderer, held());
  const [onRail, loose] = ['held', 'loose'].map(id => renderer.drawables.get(id).mesh.shader);
  assert.equal(onRail.resources.uShade, fendered.source); assert.equal(loose.resources.uShade, open.source);
  // Torn off its rail it is out in the open, with the same shader.
  draw(renderer, held(false));
  assert.equal(renderer.drawables.get('held').mesh.shader, onRail); assert.equal(onRail.resources.uShade, open.source);
  for (const texture of [tyre, open, fendered]) texture.destroy(true);
});

// Pixi's own way from a stage to what it draws: its render groups, the pipe of meshes and the batcher, with nothing sent
// to a GPU. Every other pipe takes what it is given and does nothing with it.
function scenePipeline() {
  const idle = new Proxy({}, { get: () => () => false }), adaptor = { init() {}, start() {}, execute() {}, destroy() {} },
    renderer = { uid: 1, _roundPixels: 0, limits: { maxBatchableTextures: 16 }, runners: { prerender: { add() {} } }, globalUniforms: { start() {} } },
    own = { batch: new BatcherPipe(renderer, adaptor), mesh: new MeshPipe(renderer, adaptor), blendMode: new BlendModePipe(renderer), colorMask: new ColorMaskPipe(renderer) };
  renderer.renderPipes = new Proxy(own, { get: (pipes, name) => pipes[name] ?? idle });
  const system = new RenderGroupSystem(renderer);
  return stage => {
    system.render({ container: stage });
    const { instructions, instructionSize } = stage.renderGroup.instructionSet;
    return instructions.slice(0, instructionSize);
  };
}

test('a tyre that gains or loses its shade as the stage changes is drawn as it is now, and turns on the next frame', t => {
  const renderer = presenter(t), stage = new Container({ isRenderGroup: true }), render = scenePipeline(),
    tyre = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
  renderer.moduleTexture = module => module.style === 'shade' ? shade : tyre;
  stage.addChild(renderer.actorLayerRoot); t.after(() => stage.destroy());
  // Below six pixels the outline of a wheel leaves the stage on the frame its shade does: Pixi builds the stage anew
  // then, and the next frames only move what it built.
  const worn = new Set();
  for (const [zoom, spin] of [[65, .7], [65, .9], [2, 1.1], [2, 1.3], [2, 1.5], [65, 1.7], [65, 1.9], [2, 2.1], [2, 2.3]]) {
    renderer.camera.zoom = zoom; draw(renderer, frame([wheel('front', 13.5, spin)]));
    const drawn = render(stage), { mesh } = renderer.drawables.get('front'), lit = zoom === 65;
    worn.add(mesh); assert.equal(Boolean(mesh.shader), lit); near(mesh.rotation, spin);
    assert.equal(drawn.includes(mesh), lit, lit ? 'a lit tyre is drawn on its own, with its shade' : 'an unlit one is drawn in a batch');
  }
  assert.equal([...worn].filter(mesh => !mesh.destroyed).length, 1, 'a mesh the wheel no longer wears is let go');
  // A wheel that goes takes its shader with it, and leaves the stage drawing without it.
  draw(renderer, frame([])); assert.deepEqual(render(stage).filter(drawn => worn.has(drawn)), []);
  tyre.destroy(true);
});
