import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, GraphicsContext, Texture } from 'pixi.js';
import { STYLES, SilhouetteArt, Silhouette, silhouette, drop, drawOutline, upwardRuns, lineAt } from '../src/silhouette.ts';
import { within } from '../src/hull-details.ts';
import { Renderer } from '../src/render.ts';
import { TREAD } from '../src/gear-art.ts';
import { designFrame, sampleScene } from '../src/scene-frame.ts';
import { Terrain } from '../src/terrain.ts';
import { countingCanvas } from './scenery-canvas.js';

const near = (actual, expected, tolerance = 1e-9) => assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
// A hull in side elevation: its belly, its back, a glacis and its roof.
const hull = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: .6 }, { x: 3, y: 1 }, { x: 0, y: 1 }];
const strokes = context => context.instructions.filter(instruction => instruction.action === 'stroke').map(({ data }) => data.style);

test('a line is as wide on the screen at any zoom, stepping only by quarters of an octave', () => {
  for (const zoom of [1.2, 4, 12, 30, 60, 140]) for (const pixels of [1, 3]) {
    const width = lineAt(pixels, zoom) * zoom / pixels;
    assert(width > 2 ** -.13 && width < 2 ** .13, `${pixels} pixels at zoom ${zoom} are ${width * pixels} pixels`);
  }
  assert.equal(lineAt(1, 12), lineAt(1, 12.3), 'a small change of zoom keeps the drawing of every outline');
});

test('the light edge runs just inside the edges that look up, and not along one another part stands on', () => {
  const inset = .02, [run] = upwardRuns(hull, inset);
  assert.equal(upwardRuns(hull, inset).length, 1, 'the glacis and the roof are one run, the belly and the back none');
  assert.equal(run.length, 3);
  near(run[0].x, 4 - inset * .4 / Math.hypot(1, .4)); near(run.at(-1).x, 0); near(run.at(-1).y, 1 - inset);
  for (const point of run) assert(within(point, hull), 'the light edge lies within the part');
  // The corner of the glacis and the roof is moved in along both.
  const corner = run[1], roofGap = 1 - corner.y, glacisGap = (corner.x - 4) * .4 / Math.hypot(1, .4) + (corner.y - .6) / Math.hypot(1, .4);
  near(roofGap, inset); near(-glacisGap, inset);
  // A turret standing on the middle of the roof: the roof is within the construction, the glacis still looks up.
  const turret = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 1.6 }, { x: 1, y: 1.6 }];
  assert.deepEqual(upwardRuns(hull, inset, [turret]).map(found => found.length), [2]);
  assert.deepEqual(upwardRuns(hull.map(p => ({ x: p.x, y: -p.y })), inset).map(found => found.length), [2],
    'turned over, only the belly looks up');
});

test('each style is drawn outside the shape: the dark of every vehicle, the vehicle in hand among them, the selection in olive and what Rebocar can take in amber', () => {
  const draw = style => { const context = new GraphicsContext(); drawOutline(context, hull, style, .1); return context; };
  const [dark] = strokes(draw('dark'));
  assert.deepEqual([dark.color, dark.alpha, dark.width, dark.alignment], [STYLES.dark.color, STYLES.dark.alpha, .1, 0]);
  const [halo, olive] = strokes(draw('selected'));
  assert.deepEqual([olive.color, olive.alignment, halo.color, halo.alignment], [0xb9cc8b, 0, STYLES.dark.color, 0]);
  near(olive.width, .2); near(halo.width, .3);
  const [rim, amber] = strokes(draw('towable'));
  assert.deepEqual([amber.color, amber.alignment, rim.color], [0xf0b874, 0, STYLES.dark.color]); near(amber.width, .2);
  assert.deepEqual(Object.keys(STYLES), ['dark', 'selected', 'towable', 'glint'], 'no style of its own for the vehicle in hand, and no dashed line');
  const glint = strokes(draw('glint'));
  assert.equal(glint.length, 1); assert.equal(glint[0].color, STYLES.glint.color);
});

test('a drawing is made once for a shape and a style, shared by every part of that shape, and redrawn only for another width', t => {
  const art = new SilhouetteArt();
  let asked = 0;
  const shape = () => { asked++; return { points: hull }; };
  const made = art.wanted('hull:a', shape, 'dark', .1);
  assert.equal(art.wanted('hull:a', shape, 'dark', .1), made); assert.equal(asked, 1);
  const parts = [new Silhouette(made), new Silhouette(made), new Silhouette(made)];
  assert(parts.every(part => part.context === made.context)); assert.equal(made.users, 3);
  const context = made.context, drawn = context.instructions.length;
  assert.equal(art.wanted('hull:a', shape, 'dark', .2), made); assert.equal(asked, 2);
  assert.equal(made.context, context); assert.equal(context.instructions.length, drawn, 'redrawn in place, not added to');
  const selected = art.wanted('hull:a', shape, 'selected', .2);
  assert.notEqual(selected, made); parts[0].wear(selected);
  assert.deepEqual([made.users, selected.users, parts[0].context === selected.context], [2, 1, true]);
  parts[1].destroy({ children: true, context: true });
  assert.equal(context.destroyed, false, 'destroying a part keeps the drawing the others wear');
  art.sweep(); assert(art.made.has('dark|hull:a'));
  parts[2].destroy(); parts[0].destroy();
  art.sweep();
  assert.equal(art.made.size, 0); assert(context.destroyed && selected.context.destroyed);
  t.after(() => { for (const part of parts) part.destroy(); });
});

test('a silhouette is laid in its layer once and only moved as its part moves, and taken out while the part is not drawn', () => {
  const art = new SilhouetteArt(), layer = new Container(), holder = {}, shape = () => ({ points: hull });
  const line = silhouette(art, holder, 'silhouette', layer, 'k', shape, 'dark', .1, { x: 3, y: 2, angle: .3 });
  assert.equal(line.parent, layer); assert.deepEqual([line.x, line.y, line.rotation], [3, 2, .3]);
  const group = new Container(); group.position.set(5, 1); group.rotation = -.2; group.scale.set(1, -1);
  assert.equal(silhouette(art, holder, 'silhouette', layer, 'k', shape, 'dark', .1, group), line);
  assert.deepEqual([line.x, line.y, line.rotation, line.scale.y], [5, 1, -.2, -1]);
  assert.equal(layer.children.length, 1);
  drop(holder, 'silhouette'); assert.equal(line.parent, null); assert.equal(line.destroyed, false);
  layer.destroy({ children: true }); line.destroy(); group.destroy();
});

function frame(modules) {
  const state = designFrame({ plates: [], modules });
  state.actors[0].vehicle = { x: 12, y: 1.3, angle: 0, chassisId: 'root', travel: 0 };
  return state;
}
function presenter(t) {
  countingCanvas(t);
  const renderer = new Renderer({}); renderer.actorLayerRoot = new Container();
  renderer.shadows = new Graphics(); renderer.ground = new Terrain('flat');
  renderer.moduleTexture = () => Texture.EMPTY;
  t.after(() => {
    for (const item of renderer.drawables.values()) { item.group.destroy({ children: true }); item.geometry.destroy(); }
    renderer.actorLayerRoot.destroy({ children: true }); renderer.shadows.destroy();
  });
  return renderer;
}
const draw = (renderer, state) => { renderer.scene = sampleScene(state, null, 1); renderer.syncActorLayers(state); renderer.drawSurfaces(); };

test('the wheels of a construction are outlined under the whole of it, all of one size wearing one drawing', t => {
  const renderer = presenter(t), wheel = (id, x) => ({ id, kind: 'wheel', x, y: .5, angle: 0, width: 1, height: 1, health: 80, maxHealth: 80, attached: true, wheelSpin: 0, wheelAngularSpeed: 0 }),
    state = frame([wheel('front', 13.5), wheel('back', 10.5)]);
  draw(renderer, state);
  const layers = renderer.actorLayers.get('local'), [front, back] = ['front', 'back'].map(id => renderer.drawables.get(id));
  assert.equal(front.silhouette.parent, layers.outline); assert.equal(back.silhouette.parent, layers.outline);
  assert.equal(front.silhouette.context, back.silhouette.context);
  assert.equal(renderer.silhouettes.made.size, 1);
  assert.deepEqual([front.silhouette.x, front.silhouette.y], [front.group.x, front.group.y]);
  const actor = layers.outline.parent;
  assert(actor.getChildIndex(layers.outline) < actor.getChildIndex(layers.body), 'the outline lies under the material body');
  assert.equal(layers.runningGearLayer.parent,layers.body,'the wheels stay in that body');
  assert(actor.getChildIndex(layers.shade) < actor.getChildIndex(layers.outline), 'and over their shadow');
  assert.equal(front.glint, undefined, 'a wheel has no light edge');
  // Picked, the construction wears the olive of the selection; the dark drawing is let go of when the scene is swept.
  renderer.marked = new Map([['local', 'selected']]); draw(renderer, state);
  assert.equal(front.silhouette.made, renderer.silhouettes.made.get('selected|part:' + front.data.revision));
  assert.equal(renderer.silhouettes.made.get('dark|part:' + front.data.revision).users, 0);
  renderer.silhouettes.sweep(); assert.deepEqual([...renderer.silhouettes.made.keys()], ['selected|part:' + front.data.revision]);
  // A wheel a few pixels high is part of the speck its construction is.
  renderer.marked = null; renderer.camera.zoom = 2; draw(renderer, state);
  assert.equal(front.silhouette.parent, null); assert.equal(back.silhouette.parent, null);
});

test('a tyre is outlined round its tread blocks and down on its carcass between them, the line turning with its picture', t => {
  const renderer = presenter(t), wheel = (id, x, wheelSpin) => ({ id, kind: 'wheel', x, y: .5, angle: .1, width: 1, height: 1, health: 80, maxHealth: 80, attached: true, wheelSpin, wheelAngularSpeed: 0 }),
    radii = line => { const points = line.context.instructions[0].data.path.shapePath.shapePrimitives[0].shape.points;
      return Array.from({ length: points.length / 2 }, (_, i) => Math.hypot(points[2 * i], points[2 * i + 1])); };
  renderer.camera.zoom = 300;
  let drawing = null;
  for (const spin of [0, .7, -2.4]) {
    draw(renderer, frame([wheel('front', 13.5, spin), wheel('back', 10.5, spin / 2)]));
    const front = renderer.drawables.get('front'), back = renderer.drawables.get('back');
    near(front.mesh.rotation, spin); near(back.mesh.rotation, spin / 2);
    for (const item of [front, back]) {
      // Where the wheel stands, turned as far as its picture is: the line keeps to its blocks however it turns.
      assert.deepEqual([item.silhouette.x, item.silhouette.y], [item.group.x, item.group.y]);
      near(item.silhouette.rotation, item.group.rotation + item.mesh.rotation);
    }
    // One drawing for both, made once, whatever they have turned.
    assert.equal(front.silhouette.context, back.silhouette.context);
    drawing ??= front.silhouette.context; assert.equal(front.silhouette.context, drawing);
  }
  const close = radii(renderer.drawables.get('front').silhouette);
  near(Math.min(...close), TREAD.carcass / 2, 1e-6);
  assert(Math.max(...close) <= Math.cos(Math.PI / 48) / 2 + 1e-9 && Math.max(...close) > TREAD.carcass / 2 + .01, 'out round its blocks, no farther than its picture');
  // Farther off, its blocks are a fringe of a pixel or so: the line goes round the carcass.
  renderer.camera.zoom = 65; draw(renderer, frame([wheel('front', 13.5, .3), wheel('back', 10.5, .3)]));
  for (const radius of radii(renderer.drawables.get('front').silhouette)) near(radius, TREAD.carcass / 2, 1e-6);
});

test('the outline of a tyre on a construction turned the other way keeps to its blocks as its picture turns', t => {
  const renderer = presenter(t), wheel = (id, x, wheelSpin) => ({ id, kind: 'wheel', x, y: .5, angle: .1, width: 1, height: 1, health: 80, maxHealth: 80,
    attached: true, mirrored: true, wheelSpin, wheelAngularSpeed: 0 });
  renderer.camera.zoom = 300;
  for (const spin of [.05, .7, -2.4]) {
    draw(renderer, frame([wheel('front', 13.5, spin)]));
    const item = renderer.drawables.get('front');
    assert.equal(item.group.scale.x, -1, 'the picture of the tyre is turned about with its construction');
    // Each place of the picture, the tips of its blocks among them, is where the line has it.
    for (const at of [{ x: .5, y: 0 }, { x: 0, y: .5 }, { x: .3, y: -.35 }]) {
      const picture = item.mesh.toGlobal(at), line = item.silhouette.toGlobal(at);
      near(line.x, picture.x, 1e-9); near(line.y, picture.y, 1e-9);
    }
  }
});
