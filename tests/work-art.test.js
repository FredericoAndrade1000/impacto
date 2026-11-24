import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, GpuGraphicsContext, Matrix, Sprite, buildContextBatches } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionPlacement } from '../src/construction-placement.ts';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { workShape, under, drawWork } from '../src/work-art.ts';
import { fixedFooting, footingShape } from '../src/fixed-footing.ts';
import { anchorGraphics } from '../src/world-anchor.ts';
import { groundSurfaces } from './helpers/ground-art.js';

// Where a drawing shows its numbers, in the frame of the world.
function places(node, root = null) {
  const gpu = new GpuGraphicsContext(), matrix = new Matrix(), out = []; buildContextBatches(node.context, gpu);
  for (let at = node; at && at !== root; at = at.parent) { at.updateLocalTransform(); matrix.prepend(at.localTransform); }
  const numbers = gpu.geometryData.vertices;
  for (let i = 0; i < numbers.length; i += 2) out.push({ x: matrix.a * numbers[i] + matrix.c * numbers[i + 1] + matrix.tx, y: matrix.b * numbers[i] + matrix.d * numbers[i + 1] + matrix.ty });
  gpu.destroy();
  return out;
}
const flat = { height: x => .1 * Math.sin(x / 7) };

test('a works stands where its structure will, and what of it is put up is cut from its foot at the height it has come to', async () => {
  await initNativeDynamics();
  const blueprint = compileStructuredConstruction(createStructuredTemplate('guard-post')), at = 4012.5;
  for (const facing of [-1, 1]) {
    const shape = workShape(blueprint, flat, at, facing), placed = constructionPlacement(blueprint, flat, { x: at, facing, clearance: .04, allowDownward: true });
    assert(shape.parts.every(part => part.length >= 3 && part.every(p => Number.isFinite(p.x + p.y))), 'its parts are polygons of the world');
    assert(shape.faces.length > 0);
    const feet = blueprint.modules.filter(module => module.weaponMount && !module.weaponMount.exposed)
      .flatMap(module => mountedWeaponPolygons(module).slice(2, 4)).map(poly => poly.map(placed.point));
    assert(feet.length > 0, 'the real fixture includes integrated feet');
    for (const foot of feet) assert(shape.parts.some(part => part.length === foot.length &&
      part.every((point, i) => point.x === foot[i].x && point.y === foot[i].y)), 'each real fixed contour is built at its admitted place');
    for (const point of [...shape.faces, ...shape.parts].flat()) {
      assert(point.x >= shape.minX && point.x <= shape.maxX && point.y >= shape.minY && point.y <= shape.maxY);
    }
    const first = blueprint.plates[0], middle = placed.point({ x: first.x, y: first.y });
    assert(Math.abs((shape.parts[0][0].x + shape.parts[0][2].x) / 2 - middle.x) < 1e-9, 'as the field places a fixed construction');
    assert(Math.abs(shape.minY - Math.min(...[...shape.faces, ...shape.parts].flat().map(p => flat.height(p.x)))) < .2, 'on the ground');
  }
  const square = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  assert.deepEqual(under(square, .5), [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: .5 }, { x: 0, y: .5 }]);
  assert.deepEqual(under(square, -1), []); assert.deepEqual(under(square, 3), square);
  const shape = workShape(blueprint, flat, at, 1), drawn = progress => {
    const g = anchorGraphics(new Graphics(), at, shape.minY);
    drawWork(g, shape, progress, .05);
    const fills = g.context.instructions.filter(one => one.action === 'fill' && one.data.style.alpha > .5),
      points = fills.flatMap(one => one.data.path.shapePath.shapePrimitives.flatMap(primitive => {
        const numbers = primitive.shape.points; return Array.from({ length: numbers.length / 2 }, (_, i) => numbers[2 * i + 1]);
      }));
    const all = places(g); g.destroy();
    return { fills: fills.length, top: points.length ? Math.max(...points) : -Infinity, all };
  };
  assert.equal(drawn(0).fills, 0, 'nothing is put up of a works just opened');
  const half = drawn(.5), level = shape.minY + (shape.maxY - shape.minY) * .5;
  assert(half.fills > 0 && half.top <= level + 1e-9, 'half of it is filled in, from its foot up');
  assert(drawn(1).top > level && drawn(1).top <= shape.maxY + 1e-9);
  assert(half.all.every(p => Number.isFinite(p.x + p.y)) && half.all.every(p => p.x > shape.minX - 1 && p.x < shape.maxX + 1));
});

test('a works over a slope has the footing it will stand on among its faces, put up first from the ground under it', () => {
  const blueprint = compileStructuredConstruction(createStructuredTemplate('bunker')), at = 400.25, ground = { height: x => 50 - Math.tan(20 * Math.PI / 180) * (x - at) },
    shape = workShape(blueprint, ground, at, 1), [footing, ...more] = fixedFooting(shape.parts, ground);
  assert.equal(more.length, 0);
  assert.deepEqual(shape.faces[0], footingShape(footing));
  const foot = Math.min(...footing.foot.map(p => p.y)), floor = Math.min(...shape.parts.flat().map(p => p.y));
  assert.equal(shape.minY, foot, 'what is put up of it rises from the foot of its footing');
  assert(floor - foot > 0, `the room under the low end of its base is filled: ${floor - foot} m`);
});

test('the renderer draws the works and the heaps of the faction about the view, labelled, and says where they are on the screen', async t => {
  await initNativeDynamics();
  const SITE = 125000, ZOOM = 6, WIDTH = 1280, HEIGHT = 720, blueprint = createConstruction('recon'); blueprint.terrain = MAIN_WORLD.terrain;
  const world = new World(blueprint, { scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } }); t.after(() => world.dispose());
  world.replaceActor(world.construction, { id: 'local', ownerId: 'me', team: 'mine', x: SITE, facing: -1 });
  const view = { mode: 'test', testTool: 'fire', weapon: { platform: 'vehicle' }, aim: { x: SITE - 30, y: world.terrain.height(SITE - 30) + 5 } },
    renderer = new Renderer({ clientWidth: WIDTH, clientHeight: HEIGHT }, view), camera = renderer.camera;
  renderer.app = { stage: new Container(), renderer: { render() {}, resize() {}, backBuffer: { useBackBuffer: false } } };
  renderer.buildScene(groundSurfaces());
  const post = createStructuredTemplate('guard-post');
  let now = 0, works = [{ id: 'c7', name: 'Posto de defesa leve', blueprint: post, x: SITE + 25, facing: 1, progress: .421, share: .6 }],
    heaps = [{ id: 'c3', x: SITE - 22, stock: { ferro: 4216, ligas: 0, silica: 0, combustivel: 0 } }], shared = true;
  const frame = (x = SITE) => {
    world.step();
    const state = world.snapshot();
    Object.assign(state, { shared, localPlayerId: 'me', controlledActor: 'local', faction: { id: 'mine', flag: { field: 'cross', colours: [4, 0, 8], emblem: 'ring' }, known: [], works, heaps, base: { x: SITE + 900, radius: 100, facing: 1 } },
      players: [{ id: 'me', connected: true, factionId: 'mine' }] });
    Object.assign(camera, { x, y: world.terrain.height(x) + 4, zoom: ZOOM });
    renderer.receive(state, world.drainEvents(), { now }); renderer.draw({ now }); now += 1000 / 60;
  };
  // What the field tells is shown a little after it comes (presentation.ts): a change is looked at some frames later.
  const frames = (x = SITE) => { for (let i = 0; i < 8; i++) frame(x); };
  frames(); frames();
  const work = renderer.siteMarkers.marks.get('work:c7'), heap = renderer.siteMarkers.marks.get('heap:c3');
  assert.equal(work.label.text, 'Obra · Posto de defesa leve · 42%'); assert.equal(heap.label.text, 'Material');
  assert(work.art instanceof Graphics && heap.art instanceof Sprite && work.art.visible && heap.art.visible);
  assert(renderer.labels.children.includes(work.label) && renderer.labels.children.includes(heap.label));
  // Repeated site drawing must not allocate throwaway display objects on cache hits.
  // Count actual Pixi object admission, without replacing the renderer or artwork.
  const sites = { works, heaps, roadworks: [{ id: 'r1', x0: SITE - 80, x1: SITE + 80, kind: 'graded', graded: .25 }] };
  renderer.drawSites(sites, []); renderer.drawSites(sites, []);
  const allocated = { graphics: 0, sprites: 0 },
    context = Object.getOwnPropertyDescriptor(Graphics.prototype, 'context').set,
    texture = Object.getOwnPropertyDescriptor(Sprite.prototype, 'texture').set,
    contexts = t.mock.setter(Graphics.prototype, 'context', function (value) {
      if (!this.context) allocated.graphics++; context.call(this, value);
    }),
    textures = t.mock.setter(Sprite.prototype, 'texture', function (value) {
      if (!this.texture) allocated.sprites++; texture.call(this, value);
    });
  try { for (let i = 0; i < 100; i++) renderer.drawSites(sites, []); }
  finally { contexts.mock.restore(); textures.mock.restore(); }
  assert.deepEqual(allocated, { graphics: 0, sprites: 0 }, '100 frames reuse the work, heap and road drawings');
  renderer.drawSites({ works, heaps }, []);
  // The pale structure stands where the structure will, by the works, and the pile of crates on the ground at the heap.
  const drawn = places(work.art, renderer.world), shape = work.shape;
  assert(drawn.length > 50 && drawn.every(p => p.x >= shape.minX - .3 && p.x <= shape.maxX + .3 && p.y >= shape.minY - .25 && p.y <= shape.maxY + .25));
  assert(shape.minX < SITE + 25 && shape.maxX > SITE + 25);
  const ground = world.terrain.height(SITE - 22);
  assert(Math.abs(heap.art.x - (SITE - 22)) < 1e-9 && Math.abs(heap.art.y - ground) < .05 && heap.art.scale.y < 0, 'the pile stands on the ground, the right way up');
  // Each says where it is on the screen: its label, and what it marks with what it labels.
  assert.deepEqual([...renderer.siteBoxes.keys()].sort(), ['heap:c3', 'work:c7']);
  for (const [key, made, area] of [['work:c7', work, shape], ['heap:c3', heap, { minX: SITE - 22 - heap.size.width / 2, maxX: SITE - 22 + heap.size.width / 2, minY: ground, maxY: ground + heap.size.height }]]) {
    const box = renderer.siteBoxes.get(key), bounds = made.label.getBounds(), corner = camera.toScreen(area.minX, area.maxY), end = camera.toScreen(area.maxX, area.minY);
    assert.deepEqual([box.kind, box.id], key.split(':'));
    assert.deepEqual(box.label, { x: (bounds.minX + bounds.maxX) / 2, left: bounds.minX, right: bounds.maxX, top: bounds.minY, bottom: bounds.maxY });
    assert(box.area.left <= Math.min(box.label.left, corner.x) + 1e-9 && box.area.right >= Math.max(box.label.right, end.x) - 1e-9);
    assert(box.area.top <= box.label.top && box.area.bottom >= end.y - 1e-9 && box.label.bottom <= corner.y + 1e-9, 'the label stands over what it labels');
  }
  // Drawn again only when how far it has come is another, to the percent.
  const made = work.drawn;
  works = [{ ...works[0], progress: .428 }]; frames();
  assert.equal(work.drawn, made); assert.equal(work.label.text, 'Obra · Posto de defesa leve · 42%');
  works = [{ ...works[0], progress: .43 }]; frames();
  assert.notEqual(work.drawn, made); assert.equal(work.label.text, 'Obra · Posto de defesa leve · 43%');
  // Away from the view nothing of them is shown, nor said to be on the screen.
  frames(SITE + 4000);
  assert(!work.art.visible && !work.label.visible && !heap.art.visible && renderer.siteBoxes.size === 0);
  frames();
  assert(work.art.visible && renderer.siteBoxes.size === 2);
  // Off the shared field none is shown; one the faction is no longer told of is let go.
  shared = false; frames();
  assert(!work.art.visible && !heap.label.visible && renderer.siteBoxes.size === 0);
  shared = true; works = []; frames();
  assert(work.art.destroyed && work.label.destroyed && !renderer.siteMarkers.marks.has('work:c7') && renderer.siteBoxes.has('heap:c3'));
  heaps = [{ ...heaps[0], stock: { ferro: 46784, ligas: 3000, silica: 900, combustivel: 0 } }]; frames();
  assert.deepEqual(heap.look.crates.length, 6, 'a heap that grows is a taller pile');
});
