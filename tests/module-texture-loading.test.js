import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { FramedCamera } from '../src/camera.ts';
import { paintComponent } from '../src/component-art.ts';
import { MODULES } from '../src/materials.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { partMarks } from '../src/road-machine-motion.ts';
import { hullArtwork } from '../src/hull-art.ts';
import { hullLayout } from '../src/hull-details.ts';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();

function pendingPainter(available = true) {
  let resolve;
  const result = new Promise(done => { resolve = done; });
  return { available, busy: false, request: null,
    paint(request) {
      assert.equal(this.request, null, 'this fixture permits just one pending painting');
      this.request = request; this.busy = true; return result;
    },
    async complete(picture) { this.busy = false; resolve(picture); await result; },
  };
}

function fixture(t, { kind = 'engine', available = true, marks = [] } = {}) {
  const view = { mode: 'test' }, renderer = new Renderer({}, view), painter = pendingPainter(available), layer = new Container(),
    module = { ...MODULES[kind], kind, id: 'a:' + kind, actorId: 'a', x: 125000.375, y: 2, angle: .2,
      health: 100, maxHealth: 100, attached: true, marks, markRevision: 7 },
    state = { time: 0, shared: true, actors: [{ id: 'a', revision: 0 }], plates: [], modules: [module], attachments: [] };
  renderer.texturePainter = painter; renderer.opened = new Set(['a', 'b']); renderer.playback.receive(state);
  renderer.scene = sampleScene(state);
  t.after(() => {
    renderer.clearParts(); layer.destroy({ children: true });
    for (const { texture } of renderer.textures.values()) texture.destroy(true);
    renderer.textures.clear();
  });
  return { renderer, painter, module, state, view, layer };
}

function bitmap(width = 400, height = 260) {
  return Object.assign(document.createElement('canvas'), { width, height, closes: 0, close() { this.closes++; } });
}

test('fire contacts sample a small painted profile once and invalidate it after completed artwork',t=>{
  const {renderer,module,layer}=fixture(t,{kind:'fuel',available:false}),texture=renderer.moduleTexture(module),
    surface=renderer.scene.frame.surfaces[0];renderer.geometry(surface,layer,texture);
  const probe=bitmap(32,32),ctx=probe.getContext('2d'),pixels=new Uint8ClampedArray(32*32*4);let reads=0;
  for(let y=4;y<29;y++)for(let x=3;x<28;x++)pixels[(y*32+x)*4+3]=255;
  ctx.getImageData=()=>{reads++;return {data:pixels};};renderer.fireProbe=probe;
  const initial=renderer.componentFireProfile(module.id);
  for(let i=0;i<40;i++)assert.equal(renderer.componentFireProfile(module.id),initial);
  assert.equal(reads,1);
  const entry=[...renderer.textures.values()].find(value=>value.texture===texture);
  renderer.finishTexturePaint(entry,bitmap());
  assert.notEqual(renderer.componentFireProfile(module.id),initial);assert.equal(reads,2);
  for(let i=0;i<40;i++)renderer.componentFireProfile(module.id);
  assert.equal(reads,2);assert.equal(renderer.componentFireProfile('hidden'),null);
});

test('soot reuses one damage texture across three cached stages and persists after extinguishing',t=>{
  const {renderer,module}=fixture(t,{kind:'fuel',available:false});
  module.burnAge=1;module.burning=true;
  const texture=renderer.moduleTexture(module),picture=texture.source.resource;let uploads=0;
  texture.source.on('update',()=>uploads++);
  for(const age of [2,12,29,30]){module.burnAge=age;assert.equal(renderer.moduleTexture(module),texture);}
  assert.equal(uploads,0);
  for(const age of [31,61]){module.burnAge=age;assert.equal(renderer.moduleTexture(module),texture);}
  assert.equal(uploads,2);assert.equal(texture.source.resource,picture);
  module.burning=false;assert.equal(renderer.moduleTexture(module),texture);assert.equal(uploads,2);
  assert.deepEqual(module.marks,[],'visual soot does not create authoritative damage marks');
});
const dimensions = picture => [picture.width, picture.height];

test('a pending concrete hull uses its cast base tint without changing the detailed paint request', t => {
  const { renderer, painter } = fixture(t), paint = 0x68765a,
    polygon = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }],
    request = { type: 'hull', shape: hullArtwork(polygon, paint, 'inside'),
      layout: hullLayout(polygon, { vehicle: false, cast: true }), options: { paint } },
    original = structuredClone(request), entry = renderer.progressiveTexture('hull:pending-cast', () => request);
  assert.equal(entry.texture.source.resource.getContext('2d').fillStyle, '#8b8f83');
  assert.equal(entry.paint, request, 'the detailed painter still receives the original description');
  assert.equal(renderer.nextTexturePaint, entry, 'normal worker scheduling remains pending');
  assert.equal(painter.request, null, 'the preview does not run the detailed painter synchronously');
  assert.deepEqual(request, original);
  const metal = renderer.progressiveTexture('hull:pending-metal', () => ({
    ...request, layout: { ...request.layout, cast: false },
  }));
  assert.equal(metal.texture.source.resource.getContext('2d').fillStyle, '#68765a');
});

test('cargo artwork composes piece and board parity without mirroring letters on screen', t => {
  for (const kind of ['hopper', 'cistern', 'supply']) {
    const { renderer, module } = fixture(t, { kind }), camera = renderer.camera, pictures = new Map();
    module.capacityM3 = 1; module.cargo = { ferro: 100, petroleo: 100 };
    for (const mirrored of [false, true]) for (const turn of [1, -1]) {
      module.mirrored = mirrored;
      renderer.camera = turn === 1 ? camera : new FramedCamera(camera, () => ({ x: 0, y: 0, mirror: true }));
      const before = structuredClone(module), body = renderer.loadBody(module),
        parity = (mirrored ? -1 : 1) * turn, picture = renderer.moduleTexture(module, body),
        request = [...renderer.textures.values()].find(entry => entry.texture === picture).paint;
      assert.equal(body.mirror, mirrored ? -1 : 1, 'arch coordinates retain the piece parity');
      assert.equal(request.options.mirror, parity, 'the lazy and synchronous painters receive final art parity');
      if (pictures.has(parity)) assert.equal(picture, pictures.get(parity), 'equal art parity shares the cached picture');
      else pictures.set(parity, picture);
      assert.deepEqual(module, before, 'the art request does not edit the physical component');
      const ctx = Object.assign(document.createElement('canvas'), { width: 640, height: 360 }).getContext('2d'),
        stack = [], letters = [];
      let direction = parity;
      ctx.save = () => stack.push(direction); ctx.restore = () => { direction = stack.pop(); };
      ctx.scale = sx => { direction *= Math.sign(sx); }; ctx.fillText = () => letters.push(direction);
      paintComponent(ctx, kind, module.width, module.height, request.options);
      if (kind !== 'hopper') assert(letters.length > 0, 'the cistern and supply retain their signs');
      assert(letters.every(direction => direction === 1), 'glyphs read left to right after the existing group/board reflection');
    }
    assert.equal(pictures.size, 2, 'the cache has two parity pictures, with no actor or facing duplication');
    assert.notEqual(pictures.get(1), pictures.get(-1));
  }
});

test('mirrored component damage stays on the physical hit and invalidates its retained paint when parity changes', t => {
  const mark = { u: .7, v: .5, radius: .03, kind: 'ricochet', dx: 1, dy: 0 },
    { renderer, module } = fixture(t, { marks: [mark] }), before = structuredClone(module.marks), paints = [];
  renderer.paintedTexture = (key, base, revision, paint) => {
    const ctx = Object.assign(document.createElement('canvas'), { width: 200, height: 100 }).getContext('2d'), stack = [];
    let matrix = [1, 0, 0, 1, 0, 0], sample;
    ctx.save = () => stack.push([...matrix]); ctx.restore = () => { matrix = stack.pop(); };
    ctx.translate = (x, y) => { matrix[4] += matrix[0] * x + matrix[2] * y; matrix[5] += matrix[1] * x + matrix[3] * y; };
    ctx.scale = (x, y) => { matrix[0] *= x; matrix[1] *= x; matrix[2] *= y; matrix[3] *= y; };
    ctx.rotate = angle => { const [a, b, c, d] = matrix, co = Math.cos(angle), si = Math.sin(angle);
      matrix.splice(0, 4, a * co + c * si, b * co + d * si, c * co - a * si, d * co - b * si); };
    ctx.createRadialGradient = () => { sample ??= [...matrix]; return { addColorStop() {} }; };
    paint(ctx); paints.push({ key, revision, matrix: sample }); return base;
  };
  module.angle = 0;
  for (const mirrored of [false, true, false]) {
    module.mirrored = mirrored;
    renderer.moduleTexture(module);
    const { matrix } = paints.at(-1), sign = mirrored ? -1 : 1,
      hitX = module.x + sign * (matrix[4] / 200 - .5) * module.width;
    assert(Math.abs(hitX - (module.x + .2 * module.width)) < 1e-9);
    assert(sign * matrix[0] > 0, 'the scrape still follows the physical incoming direction');
  }
  assert.notEqual(paints[0].revision, paints[1].revision); assert.equal(paints[0].revision, paints[2].revision);
  assert.equal(new Set(paints.map(paint => paint.key)).size, 1, 'orientation reuses the retained damage entry');
  const box = { x: 0, y: 0, w: module.width / 2, h: module.height };
  renderer.moduleTexture({ ...module, mirrored: true, crop: { ...box, W: module.width, H: module.height },
    width: box.w, marks: partMarks(module.marks, box, module.width, module.height, true) });
  assert(Math.abs(paints.at(-1).matrix[4] / 200 - .6) < 1e-9, 'a canonical crop is not reflected a second time');
  assert.deepEqual(module.marks, before, 'native and saved UVs remain untouched');
});

for (const look of [{ kind: 'engine' }, { kind: 'wheel' }, { kind: 'command' }, { kind: 'ammo' },
  ...['visual', 'sound', 'radar'].map(sensorMode => ({ kind: 'sensor', sensorMode }))])
test(`a field ${look.kind} ${look.sensorMode || ''} is visible immediately and its painting changes only retained pixels`, async t => {
  const { renderer, painter, module, state, layer } = fixture(t, { kind: look.kind });
  Object.assign(module, look);
  const before = structuredClone(state),
    texture = renderer.moduleTexture(module), source = texture.source, picture = source.resource,
    surface = renderer.scene.frame.surfaces[0], item = renderer.geometry(surface, layer, texture), geometry = item.geometry,
    positions = [...geometry.positions], uvs = [...geometry.uvs], indices = [...geometry.indices],
    pose = [item.group.x, item.group.y, item.group.rotation];
  assert(picture.width <= 96 && picture.height <= 96, 'the first picture is small enough to paint immediately');
  assert(item.mesh.visible && geometry.indices.length > 0); assert.equal(painter.request, null);
  let copied, uploads = 0;
  picture.getContext('2d').drawImage = image => { copied = image; };
  source.on('update', () => uploads++);
  renderer.paintNextTexture(); assert(painter.busy);
  assert.deepEqual([painter.request.kind, painter.request.width, painter.request.height], [module.kind, module.width, module.height]);
  const painted = bitmap(); await painter.complete(painted);
  assert.equal(copied, painted); assert.equal(painted.closes, 1); assert.equal(uploads, 1);
  assert.equal(renderer.moduleTexture(module), texture); assert.equal(texture.source, source); assert.equal(source.resource, picture);
  assert.deepEqual(dimensions(picture), dimensions(painted));
  assert.equal(renderer.geometry(surface, layer, texture), item); assert.equal(item.geometry, geometry);
  assert.deepEqual([...geometry.positions], positions); assert.deepEqual([...geometry.uvs], uvs); assert.deepEqual([...geometry.indices], indices);
  assert.deepEqual([item.group.x, item.group.y, item.group.rotation], pose); assert.deepEqual(state, before);
});

test('wheel light masks, single-request track wheels and track overlays keep their full synchronous pictures', t => {
  const { renderer, painter, module } = fixture(t, { kind: 'wheel' });
  for (const style of ['shade', 'fendered', 'road', 'sprocket', 'idler', 'roller', 'guard']) {
    const texture = renderer.moduleTexture({ ...module, style });
    assert.deepEqual(dimensions(texture.source.resource), [400, 400], style);
  }
  const overlay = renderer.moduleTexture({ ...MODULES.track, kind: 'track', overlay: true });
  assert(overlay.source.resource.width > 96 && overlay.source.resource.height > 96);
  renderer.paintNextTexture(); assert.equal(painter.request, null, 'mask-only and retained sprite requests leave no deferred job');
});

test('identical modules on different actors share both the pending picture and its finished texture', async t => {
  const { renderer, painter, module } = fixture(t), other = { ...module, actorId: 'b', id: 'b:engine' },
    texture = renderer.moduleTexture(module), cache = renderer.textures;
  assert.equal(renderer.moduleTexture(other), texture); assert.equal(cache.size, 1);
  renderer.paintNextTexture(); renderer.paintNextTexture();
  await painter.complete(bitmap());
  assert.equal(renderer.moduleTexture(other), texture); assert.equal(renderer.moduleTexture(module), texture);
  assert.equal(renderer.textures, cache); assert.equal(cache.size, 1);
});

test('unselected external components stay progressive through selection, deselection and a private test', async t => {
  const { renderer, painter, module, state } = fixture(t);
  module.exposed = true; renderer.opened.clear(); state.shared = false;
  const texture = renderer.moduleTexture(module), picture = texture.source.resource, previewSize = dimensions(picture);
  assert(picture.width <= 96 && picture.height <= 96, 'an exposed engine does not block the first exterior draw');
  renderer.paintNextTexture(); assert(painter.busy);
  renderer.opened.add(module.actorId); assert.equal(renderer.moduleTexture(module), texture);
  renderer.opened.clear(); assert.equal(renderer.moduleTexture(module), texture);
  assert.deepEqual(dimensions(picture), previewSize, 'closing does not force the pending painting onto the main thread');
  const finished = bitmap(); await painter.complete(finished);
  assert.equal(renderer.moduleTexture(module), texture); assert.deepEqual(dimensions(picture), dimensions(finished));
  assert.equal(finished.closes, 1);
});

test('existing damage is repainted once at full size even when its mark revision has not changed', async t => {
  const mark = { u: .4, v: .5, radius: .02, depth: .005, strength: .7, dx: 1, dy: 0 },
    { renderer, painter, module } = fixture(t, { marks: [mark] }), before = structuredClone(module),
    damaged = renderer.moduleTexture(module), source = damaged.source, picture = source.resource,
    base = renderer.moduleTexture({ ...module, marks: [] }), initialSize = dimensions(picture);
  let uploads = 0, copied;
  source.on('update', () => uploads++);
  picture.getContext('2d').drawImage = image => { copied = image; };
  assert.equal(renderer.moduleTexture(module), damaged); assert.equal(uploads, 0);
  renderer.paintNextTexture(); const painted = bitmap(); await painter.complete(painted);
  assert.equal(uploads, 0, 'the damaged picture refreshes when the next draw asks for it');
  assert.equal(renderer.moduleTexture(module), damaged); assert.equal(damaged.source, source); assert.equal(source.resource, picture);
  assert.equal(copied, base.source.resource); assert.equal(uploads, 1);
  assert(picture.width > initialSize[0] && picture.height > initialSize[1]); assert.deepEqual(dimensions(picture), dimensions(painted));
  renderer.moduleTexture(module); renderer.moduleTexture(module);
  assert.equal(uploads, 1); assert.deepEqual(module, before);
});

test('a marked glass plate keeps its texture and filtering when its solid material finishes painting', async t => {
  const { renderer, painter } = fixture(t),
    part = { id: 'a:plate', material: 'glass', markRevision: 7,
      definition: { length: 2, thicknessMm: 20 },
      marks: [{ u: .4, v: .5, radius: .02, depth: .005, strength: .7, dx: 1, dy: 0 }] },
    before = structuredClone(part), damaged = renderer.getTexture(part), source = damaged.source, picture = source.resource,
    base = renderer.getTexture({ ...part, marks: [] }), baseSource = base.source, basePicture = baseSource.resource,
    initialSize = dimensions(picture);
  assert.equal(source.autoGenerateMipmaps, false); assert.equal(baseSource.autoGenerateMipmaps, false);
  let uploads = 0, copied;
  source.on('update', () => uploads++);
  picture.getContext('2d').drawImage = image => { copied = image; };
  renderer.paintNextTexture();
  assert.equal(painter.request.type, 'material'); assert.equal(painter.request.options.material, 'glass');
  const painted = bitmap(512, 512); await painter.complete(painted);
  assert.equal(uploads, 0, 'a hidden damaged plate is refreshed only when it is requested again');
  assert.equal(renderer.getTexture(part), damaged); assert.equal(damaged.source, source); assert.equal(source.resource, picture);
  assert.equal(renderer.getTexture({ ...part, marks: [] }), base); assert.equal(base.source, baseSource); assert.equal(baseSource.resource, basePicture);
  assert.equal(copied, basePicture); assert.equal(uploads, 1); assert.equal(painted.closes, 1);
  assert(picture.width > initialSize[0] && picture.height > initialSize[1]); assert.deepEqual(dimensions(picture), dimensions(painted));
  assert.equal(source.autoGenerateMipmaps, false); assert.equal(baseSource.autoGenerateMipmaps, false);
  renderer.getTexture(part); renderer.getTexture(part);
  assert.equal(uploads, 1); assert.deepEqual(part, before);
});

test('the workshop shares a pending field painting instead of blocking to paint it again', async t => {
  const { renderer, painter, module, view } = fixture(t), texture = renderer.moduleTexture(module), source = texture.source,
    picture = source.resource, previewSize = dimensions(picture);
  renderer.paintNextTexture(); let uploads = 0, copied;
  source.on('update', () => uploads++);
  picture.getContext('2d').drawImage = image => { copied = image; };
  view.mode = 'edit';
  assert.equal(renderer.moduleTexture(module), texture); assert.equal(texture.source, source); assert.equal(source.resource, picture);
  assert.deepEqual(dimensions(picture), previewSize); assert.equal(uploads, 0); assert.equal(copied, undefined);
  const finished = bitmap(512, 384); await painter.complete(finished);
  assert.equal(finished.closes, 1); assert.equal(copied, finished); assert.deepEqual(dimensions(picture), dimensions(finished));
  assert.equal(renderer.moduleTexture(module), texture); assert.equal(uploads, 1);
});

test('the workshop board keeps a simple painting through a drag and asks its host to finish it after release', async t => {
  const { renderer, painter, module, view } = fixture(t); view.mode = 'edit';
  const board = Object.assign(Object.create(renderer), { host: renderer, holdArt: true }), texture = board.moduleTexture(module),
    source = texture.source, picture = source.resource, initialSize = dimensions(picture);
  assert(picture.width <= 96 && picture.height <= 96);
  renderer.paintNextTexture(); assert.equal(painter.request, null, 'dragging does not start a painting');
  assert.equal(board.moduleTexture(module), texture); assert.deepEqual(dimensions(picture), initialSize);
  board.holdArt = false; board.moduleTexture(module);
  renderer.paintNextTexture(); assert(painter.busy);
  const finished = bitmap(); await painter.complete(finished);
  assert.equal(board.moduleTexture(module), texture); assert.equal(texture.source, source); assert.equal(source.resource, picture);
  assert.deepEqual(dimensions(picture), dimensions(finished)); assert.equal(finished.closes, 1);
});

test('resizing and changing metal during painting cannot put the older pixels on the edited piece', async t => {
  const { renderer, painter, module, view } = fixture(t); view.mode = 'edit';
  const original = renderer.moduleTexture(module); renderer.paintNextTexture();
  const changed = { ...module, width: module.width * 1.3, metal: 'aluminum' }, next = renderer.moduleTexture(changed),
    picture = next.source.resource, previewSize = dimensions(picture);
  assert.notEqual(next, original);
  const oldPicture = bitmap(); await painter.complete(oldPicture);
  assert.equal(renderer.moduleTexture(changed), next); assert.deepEqual(dimensions(picture), previewSize);
  assert.equal(renderer.moduleTexture(module), original, 'undo reuses the completed painting');
  assert.deepEqual(dimensions(original.source.resource), dimensions(oldPicture)); assert.equal(oldPicture.closes, 1);
});

test('a result for an evicted module is closed without reviving its texture cache entry', async t => {
  const { renderer, painter, module } = fixture(t, { kind: 'fuel' }), texture = renderer.moduleTexture(module), source = texture.source;
  renderer.paintNextTexture(); renderer.usedTextures.clear(); renderer.releaseTextures();
  assert.equal(renderer.textures.size, 0); assert(source.destroyed);
  const late = bitmap(); await painter.complete(late);
  assert.equal(late.closes, 1); assert.equal(renderer.textures.size, 0); assert(source.destroyed);
});

test('crossing track detail while painting discards the evicted key; close up the belt asks for no picture, and keeps its phase', async t => {
  const { renderer, painter, module } = fixture(t, { kind: 'track' });
  module.wheelSpin = 1.25;
  const before = structuredClone(module);
  renderer.camera.zoom = 1;
  assert.equal(renderer.detailedTrack(module), false);
  const distant = renderer.moduleTexture(module), oldSource = distant.source;
  renderer.paintNextTexture();
  assert.equal(painter.request.kind, 'track');
  renderer.usedTextures.clear(); renderer.camera.zoom = 100;
  assert.equal(renderer.detailedTrack(module), true);
  // Close up its wheels, its links and what stands behind them are drawn on their own (track-links.ts).
  assert.equal(renderer.moduleTexture(module), Texture.EMPTY);
  renderer.releaseTextures(); assert(oldSource.destroyed);
  const late = bitmap(); await painter.complete(late);
  assert.equal(late.closes, 1);
  assert(oldSource.destroyed, 'a late distant belt cannot revive the evicted source');
  const nextPainter = pendingPainter(); renderer.texturePainter = nextPainter;
  assert.equal(renderer.moduleTexture(module), Texture.EMPTY); renderer.paintNextTexture();
  assert.equal(nextPainter.request, null, 'nothing is painted for a belt drawn close up');
  renderer.camera.zoom = 1;
  assert.equal(renderer.detailedTrack(module), false);
  assert.notEqual(renderer.moduleTexture(module), distant, 'returning creates a new entry rather than using the evicted source');
  assert.deepEqual(module, before, 'painting and LOD changes do not reset native belt phase or geometry');
});

for (const unavailable of ['unsupported', 'failed']) test(`${unavailable === 'unsupported' ? 'an' : 'a'} ${unavailable} painter uses and retains the synchronous full picture`, async t => {
  const { renderer, painter, module } = fixture(t, { available: unavailable !== 'unsupported' });
  let texture, previewSize;
  if (unavailable === 'failed') {
    texture = renderer.moduleTexture(module); previewSize = dimensions(texture.source.resource);
    renderer.paintNextTexture(); painter.available = false; await painter.complete(null);
  }
  const full = renderer.moduleTexture(module), source = full.source, picture = source.resource;
  if (texture) assert.equal(full, texture);
  assert(picture.width > (previewSize?.[0] || 96) && picture.height > (previewSize?.[1] || 96));
  let uploads = 0; source.on('update', () => uploads++);
  renderer.paintNextTexture();
  assert.equal(renderer.moduleTexture(module), full); assert.equal(renderer.moduleTexture(module), full);
  assert.equal(full.source, source); assert.equal(source.resource, picture); assert.equal(uploads, 0);
  assert.equal(renderer.textures.size, 1); assert.equal(painter.available, false);
});
