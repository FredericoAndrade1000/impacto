import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { Terrain } from '../src/terrain.ts';
import { POST_RADIUS } from '../src/territory.ts';
import { countingCanvas } from './scenery-canvas.js';

const flag = { field: 'plain', colours: [4, 0, 8], emblem: 'ring' };
// A renderer of the field with the layers the places of the field are drawn in, over level ground, its view 90 m across.
// Its words are measured on the counting canvas (scenery-canvas.js), which knows no spacing of letters.
function scene(t) {
  countingCanvas(t);
  if (!Object.hasOwn(globalThis, 'CanvasRenderingContext2D')) {
    globalThis.CanvasRenderingContext2D = class {}; t.after(() => { delete globalThis.CanvasRenderingContext2D; });
  }
  const renderer = new Renderer({}, { mode: 'test' }), stage = new Container({ isRenderGroup: true });
  renderer.app = { stage }; renderer.world = stage.addChild(new Container());
  renderer.labels = renderer.world.addChild(new Container()); renderer.shadows = renderer.world.addChild(new Graphics());
  renderer.terrainScene = { layers: { works: renderer.world.addChild(new Container()) } };
  renderer.ground = new Terrain('flat'); renderer.flagTexture = () => null;
  Object.assign(renderer.camera, { x: 0, y: 0, zoom: 10, width: 900, height: 550 });
  t.after(() => { renderer.effectSurfaceClip.destroy(); stage.destroy({ children: true, context: true }); });
  return renderer;
}
const post = (id, x, more = {}) => ({ id, x, facing: 1, radius: POST_RADIUS, eye: 9, sight: 4000, takedown: null, siege: null, ...more });

test('field marker resources are released with a scene and can be rebuilt without stale hitboxes', t => {
  const renderer = scene(t), faction = { id: 'f1', flag, posts: [post('p1', 0)], works: [], heaps: [], roadworks: [] };
  renderer.drawSites(faction, []);
  const markers = renderer.siteMarkers, previous = markers.posts.get('own:p1');
  markers.previewPost({ x: 0 }); markers.previewRoad({ x0: 0, x1: 1 });
  markers.clear(); markers.clear();
  assert(previous.works.destroyed && previous.front.destroyed && previous.label.destroyed);
  assert.equal(markers.posts.size + markers.marks.size + markers.boxes.size, 0);
  assert.equal(markers.postAsked, null); assert.equal(markers.roadAsked, null);
  renderer.drawSites(faction, []);
  assert.notEqual(markers.posts.get('own:p1'), previous);
  assert(!markers.posts.get('own:p1').front.destroyed);
});

test('the posts of the faction and those of others it knows are places drawn behind the field under their labels, drawn again only when they change', t => {
  const renderer = scene(t), other = { id: 'q1', of: 'f2', name: 'Bia', nation: null, flag, x: 100, facing: -1, radius: POST_RADIUS, seen: false, at: 3, sheltered: false },
    faction = { id: 'f1', flag, posts: [post('p1', 0)], outposts: [other] }, draw = () => { const obstacles = []; renderer.drawSites(faction, obstacles); return obstacles; };
  const obstacles = draw(), own = renderer.siteMarkers.posts.get('own:p1'), theirs = renderer.siteMarkers.posts.get('other:q1');
  assert.deepEqual([own.label.text, theirs.label.text], ['Posto', 'Posto · Facção de Bia']);
  assert.deepEqual([own.works.alpha, theirs.works.alpha, theirs.label.alpha], [1, .6, .6], 'another’s out of sight is paler');
  assert.equal(obstacles.length, 2, 'their labels are kept clear of');
  assert.equal(renderer.siteBoxes.get('post:p1')?.kind, 'post', 'the post of the faction has its mark on the panels');
  assert(!renderer.siteBoxes.has('post:q1'));
  assert(own.drawn.flag.y > renderer.ground.height(0) + 8 && Math.abs(own.drawn.flag.x) < 1, 'the label stands over the flag, up its mast in the middle');
  const drawn = own.drawn;
  draw(); assert.equal(own.drawn, drawn, 'unchanged, not drawn again');
  faction.posts = [post('p1', 0, { takedown: { progress: .4, seconds: 60 } })]; other.sheltered = true; other.seen = true; draw();
  assert.deepEqual([own.label.text, theirs.label.text, theirs.works.alpha], ['Posto · desmontando 40%', 'Posto · Facção de Bia · protegido', 1]);
  assert.equal(own.drawn, drawn, 'a label that changes does not draw the post again');
  // The place being chosen for one is a post not begun, in another colour while it would be refused, under no label.
  renderer.previewPost({ x: -40, facing: 1, refused: true }); draw();
  const asked = renderer.siteMarkers.posts.get('asked');
  assert.deepEqual([asked.label.visible, asked.drawn.built, asked.drawn.color], [false, 0, 0xe0806e]);
  renderer.previewPost({ x: -40, facing: 1, refused: false }); draw();
  assert.equal(asked.drawn.color, undefined, 'in the colour of the faction where it may stand');
  renderer.previewPost(null); faction.outposts = []; draw();
  assert.deepEqual([...renderer.siteMarkers.posts.keys()], ['own:p1'], 'what is no longer told of is let go');
  assert(asked.works.destroyed && theirs.label.destroyed);
  renderer.camera.x = 5000; draw();
  assert.equal(own.works.visible, false, 'one away from the view is not shown');
});

test('the works of a post is the post it becomes as far as it has come, drawn again at each step of it, labelled where its flag will fly', t => {
  const renderer = scene(t), work = { id: 'w1', post: true, name: 'Posto', x: 0, facing: 1, progress: .301, cost: { ferro: 22500, ligas: 2500, silica: 2500, combustivel: 0 } },
    faction = { id: 'f1', flag, works: [work], heaps: [], roadworks: [] }, draw = () => renderer.drawSites(faction, []);
  draw();
  const made = renderer.siteMarkers.marks.get('work:w1'), drawn = made.drawn;
  assert.deepEqual([made.label.text, drawn.built], ['Obra · Posto · 30%', .3]);
  assert(made.back && made.back.visible, 'its works behind the ground line, as a post’s');
  assert.equal(made.label.x, drawn.flag.x);
  work.progress = .315; draw();
  assert.equal(made.drawn, drawn, 'within a step it is not drawn again');
  assert.equal(made.label.text, 'Obra · Posto · 31%', 'its label says how far it has come');
  work.progress = .321; draw();
  assert.notEqual(made.drawn, drawn); assert.equal(made.drawn.built, .32);
  // A builder works at it over its ground, up to the eye of the post as it is put up.
  const target = renderer.craneTarget({ faction }, 'w1');
  assert.deepEqual([target.lo, target.hi], [-POST_RADIUS, POST_RADIUS]);
  faction.works = []; draw();
  assert(made.art.destroyed && made.back.destroyed, 'a works no longer told of is let go');
});
