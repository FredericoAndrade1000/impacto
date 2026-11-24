import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { chassisPlacement, chassisPoint } from '../src/chassis-art.ts';

function stateAt({ x = 12, y = .36, angle = 0, mirrored = false, length = 4, attached = true } = {}) {
  // A straight chassis: its frame plate from its rear end to its front, its points and its outline in its definition.
  const definition = { id: 'chassis:frame-0', x, y, angle: angle + (mirrored ? Math.PI : 0), length, thicknessMm: 8, material: 'steel',
    chassis: { part: 'frame', segment: 0, model: 'wheeled', kind: 'wheeled', deck: .9, depth: .25, wheelDiameter: 1.1, length,
      profile: [{ x: 0, y: 0 }, { x: length, y: 0 }], outlines: [[{ x: 0, y: 0 }, { x: length, y: 0 }, { x: length, y: -.25 }, { x: 0, y: -.25 }]] } };
  return { time: 0, actors: [{ id: 'unit', preset: 'vehicle', vehicle: { x, y, angle } }],
    plates: [{ id: 'chassis:frame-0', actorId: 'unit', definition, attached, marks: [] }], modules: [], attachments: [] };
}

function fixture(t) {
  const renderer = new Renderer({}, { mode: 'test' }); renderer.actorLayerRoot = new Container();
  renderer.ground = { height: () => 0 }; renderer.camera.zoom = 3.2;
  // These tests exercise the real placement, retained Graphics and cast; their paint is unrelated.
  renderer.texture = key => { renderer.asked?.push(key); return { texture: Texture.WHITE }; };
  const draw = state => {
    renderer.scene = sampleScene(state); renderer.syncActorLayers(state); renderer.drawChassisArt(state);
    return renderer.actorLayers.get('unit');
  };
  t.after(() => { renderer.actorLayerRoot.destroy({ children: true, context: true }); renderer.silhouettes.sweep(); });
  return { renderer, draw };
}

test('a warm chassis shadow reuses its edges and projects no contour until its cast needs rebuilding', t => {
  const { draw } = fixture(t), layers = draw(stateAt()), shadow = layers.chassisShadow,
    cast = shadow.under.cast, context = shadow.under.context, instructions = [...context.instructions], edges = shadow.edges,
    outline = shadow.data.outline, map = outline.map;
  let projections = 0;
  outline.map = function (...args) { projections++; return map.apply(this, args); };
  draw(stateAt()); draw(stateAt({ x: 12.01 }));
  assert.equal(projections, 0, 'a retained cast does not need another world-space contour or edge list');
  assert.equal(shadow.edges, edges); assert.equal(shadow.under.cast, cast);
  assert.equal(shadow.under.context, context); assert.deepEqual(context.instructions, instructions);
  draw(stateAt({ x: 12.2 }));
  assert.equal(projections, 1, 'only a new projection is needed when the unchanged local shape moves');
  assert.equal(shadow.edges, edges); assert.notEqual(shadow.under.cast, cast);
});

test('chassis shadows retain exact rotated and mirrored placement near the origin and 125 km away', t => {
  for (const x of [12, 125000.375]) for (const mirrored of [false, true]) {
    const { renderer, draw } = fixture(t), state = stateAt({ x, mirrored, angle: .21 }), layers = draw(state),
      layout = layers.chassisShape.layout, definition = state.plates[0].definition,
      place = chassisPlacement(renderer.scene.pose('chassis:frame-0'), definition.chassis, state.actors[0].vehicle.angle),
      [outline] = layout.outlines, expected = outline.map(p => chassisPoint(place, p.x, p.y)), shadow = layers.chassisShadow;
    assert.deepEqual(shadow.outline, expected);
    assert.deepEqual(shadow.edges, outline.map((_, i, all) => ({ a: i, b: (i + 1) % all.length })));
    assert.deepEqual([shadow.under.cast.x, shadow.under.cast.y], [place.origin.x, place.origin.y]);
    const before = shadow.under.cast, edges = shadow.edges;
    draw(stateAt({ x: x + .2, mirrored, angle: .28, length: 4.5 }));
    assert.notEqual(shadow.layout, layout); assert.notEqual(shadow.edges, edges); assert.notEqual(shadow.under.cast, before);
    assert.deepEqual(shadow.outline, shadow.data.outline.map(p => chassisPoint(shadow.placement, p.x, p.y)));
  }
});

test('losing a chassis hides its retained shadow and restoring it preserves the warmed cast', t => {
  const { draw } = fixture(t), layers = draw(stateAt()), shadow = layers.chassisShadow, under = shadow.under, cast = under.cast;
  draw(stateAt({ attached: false }));
  assert.equal(under.visible, false);
  draw(stateAt());
  assert.equal(shadow.under, under); assert.equal(under.visible, true); assert.equal(under.cast, cast);
});
