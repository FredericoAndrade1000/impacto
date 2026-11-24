import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { pointInTriangle } from '../src/math.ts';
import { sampleScene, designFrame, regionContains } from '../src/scene-frame.ts';
import { pickPiece } from '../src/editor.ts';
import { countingCanvas } from './scenery-canvas.js';

function snapshot(revision = 0) {
  const id = name => `unit:${revision}:${name}`, pose = { x: 0, y: 1, angle: 0 },
    module = (name, kind, x, width, height, extra = {}) => ({ id: id(name), actorId: 'unit', kind, x, y: 1, angle: 0,
      width, height, health: 100, maxHealth: 100, attached: true, marks: [], markRevision: 0, ...extra });
  return { time: 0, shared: true, localPlayerId: 'player', controlledActor: null,
    actors: [{ id: 'unit', revision, ownerId: 'player', team: 'own', preset: 'vehicle', appearance: { paint: '#68765a' },
      x: 0, facing: -1, vehicle: pose }],
    plates: [],
    modules: [module('fuel', 'fuel', 0, .3, .25),
      module('cargo', 'hopper', 1.2, .5, .4, { exposed: true, capacityM3: .1, cargo: { ferro: 240 } })],
    bodyPanels: [{ id: id('hull'), actorId: 'unit', pose,
      localPolygon: [{ x: -.8, y: -.4 }, { x: .8, y: -.4 }, { x: .8, y: .4 }, { x: -.8, y: .4 }] }] };
}

function fixture(t) {
  const { counters } = countingCanvas(t), create = document.createElement;
  // Extend the existing counting canvas only with methods the hull/cargo painters need.
  document.createElement = type => {
    const picture = create(type), ctx = picture.getContext('2d'); ctx.canvas = picture;
    for (const method of ['roundRect', 'setTransform', 'clearRect', 'fillText', 'strokeRect', 'transform', 'setLineDash', 'rotate', 'putImageData'])
      ctx[method] = () => { counters.paints++; };
    ctx.createImageData = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
    ctx.measureText = text => ({ width: text.length * 6 });
    return picture;
  };
  const renderer = new Renderer({}, { mode: 'test' });
  renderer.actorLayerRoot = new Container(); renderer.shadows = new Graphics();
  Object.assign(renderer.camera, { x: 0, y: 1, zoom: 40, width: 600, height: 400 });
  const state = snapshot(), draw = (next = state, open = false, unseen = false, holdArt = false) => {
    renderer.frameNow += 16; renderer.holdArt = holdArt; renderer.usedTextures.clear(); renderer.scene = sampleScene(next);
    renderer.opened = new Set(open ? ['unit'] : []); renderer.syncActorLayers(next); renderer.cullActors(next);
    if (unseen) renderer.unseen.add('unit');
    renderer.drawSurfaces(); renderer.drawBodyPanels(next, 1); renderer.releaseTextures(); renderer.pruneActorLayers(next);
  };
  t.after(() => { renderer.clearParts(); renderer.clearLayers(); renderer.releaseTextures(true); renderer.shadows.destroy(); });
  return { renderer, counters, state, draw };
}

test('an asymmetric retained shadow follows component reflection at the same pose, near and far from the origin', t => {
  const { renderer, state } = fixture(t), group = new Container(),
    positions = new Float32Array([-1, -.4, 2, -.4, .25, .8]),
    item = { group, positions, data: { positions }, edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 0 }] };
  renderer.ground = { height: () => 0 }; renderer.syncActorLayers(state);
  t.after(() => group.destroy());
  for (const x of [12, 125000.375]) for (const angle of [0, .37]) {
    group.position.set(x, 1.5); group.rotation = angle;
    let previous;
    for (const mirror of [1, -1, 1]) {
      group.scale.x = mirror; item.outline = null;
      renderer.drawShade(item, 'unit', 'under', .14);
      assert.notEqual(item.under.cast, previous, 'changing parity invalidates the retained cast at unchanged pose');
      const c = Math.cos(angle), s = Math.sin(angle);
      for (let i = 0; i < positions.length / 2; i++) {
        const u = positions[i * 2] * mirror, v = positions[i * 2 + 1], point = item.outline[i];
        assert(Math.abs(point.x - (x + c * u - s * v)) < 1e-8);
        assert(Math.abs(point.y - (1.5 + s * u + c * v)) < 1e-8);
      }
      previous = item.under.cast; item.outline = null;
      renderer.drawShade(item, 'unit', 'under', .14);
      assert.equal(item.under.cast, previous, 'unchanged reflected geometry reuses the cast without projection');
      assert.equal(item.outline, null);
    }
  }
});

function pendingHull(t, { damaged = false, edit = false } = {}) {
  const f = fixture(t), { renderer, state, draw } = f;
  Object.assign(state.modules[0], { kind: 'command', x: -.3, y: .85, width: .44, height: .28 });
  const roof = designFrame({ modules: [], plates: [{ id: 'unit:roof', x: 0, y: 1.4, angle: 0,
    length: 1.6, thicknessMm: 20, material: 'concrete', anchors: [] }] }).plates[0];
  state.plates.push({ ...roof, actorId: 'unit', attached: true });
  if (damaged) {
    state.plates[0].markRevision = 1;
    state.plates[0].marks = [{ u: .5, v: 0, kind: 'dent', radius: .02, strength: .7 }];
    const stamp = document.createElement('canvas'); renderer.impactSources = () => stamp;
  }
  renderer.view.mode = edit ? 'edit' : 'test'; draw(state, true);
  let resolve;
  const result = new Promise(done => { resolve = done; }), painter = renderer.texturePainter = {
    available: true, busy: false, request: null,
    paint(request) { assert.equal(request.type, 'hull'); this.request = request; this.busy = true; return result; },
    async complete(picture) { this.busy = false; resolve(picture); await result; },
  };
  const next = structuredClone(state); next.bodyPanels[0].localPolygon[1].x += .3;
  renderer.frameNow += 100; draw(next, true);
  const entry = renderer.nextTexturePaint, hull = renderer.hullSprites.values().next().value;
  assert.equal(entry?.paint?.type, 'hull', 'the settled new outline asks the shared painter for its own backing');
  assert(entry.layout.cast, 'the real concrete majority keeps this interior on the progressive path');
  return { ...f, next, painter, entry, hull };
}
const hullReply = () => Object.assign(document.createElement('canvas'), {
  width: 384, height: 192, closes: 0, close() { this.closes++; },
});

// Whether the rim of a hull covers a place of the world (that of its layer, which stands as the world does here).
const rimCovers = (hull, point) => hull.rim.containsPoint(hull.rim.toLocal(point, hull.rim.parent));

// MeshGeometry submits separate indexed triangle triples; inspect those drawing buffers directly.
function triangleMeshContains(mesh, point) {
  const geometry = mesh.geometry, positions = geometry.getBuffer('aPosition').data, indices = geometry.getIndex().data,
    vertex = i => ({ x: positions[indices[i] * 2], y: positions[indices[i] * 2 + 1] });
  assert.equal(geometry.topology, 'triangle-list');
  for (let i = 0; i + 2 < indices.length; i += 3)
    if (pointInTriangle(point, vertex(i), vertex(i + 1), vertex(i + 2))) return true;
  return false;
}

test('distant field selection keeps its skin and opens the retained interior only when approaching', t => {
  const { renderer, counters, state, draw } = fixture(t), id = state.modules[0].id;
  renderer.camera.zoom = 3.2;
  renderer.marked = new Map([['unit', 'selected']]);
  draw(); const outside = renderer.hullSprites.values().next().value.texture, closedPaints = { ...counters };
  draw(state, true);
  assert(renderer.opened.has('unit') && renderer.marked.has('unit'), 'the vehicle stays selected for commands');
  assert(renderer.closed.has('unit')); assert(!renderer.drawables.has(id));
  assert.deepEqual(counters, closedPaints, 'a distant click paints no unreadable interior');
  renderer.camera.zoom = 8; draw(state, true);
  assert(!renderer.closed.has('unit')); assert(renderer.drawables.get(id).group.visible);
  const inside = renderer.hullSprites.values().next().value.texture;
  assert.notEqual(inside, outside); const warmed = { ...counters };
  renderer.camera.zoom = 3.2; draw(state, true);
  assert.equal(renderer.hullSprites.values().next().value.texture, outside);
  renderer.camera.zoom = 8; draw(state, true);
  assert.equal(renderer.hullSprites.values().next().value.texture, inside);
  assert.deepEqual(counters, warmed, 'returning to a legible view reuses both sides');
  renderer.camera.zoom = 3.2;
  draw({ ...state, shared: false }, true);
  assert(!renderer.closed.has('unit'), 'private tests retain their cutaway at any zoom');
  renderer.camera.zoom = 26; draw({ ...state, shared: false });
  assert(renderer.closed.has('unit'), 'driven on the proving ground, unopened, the design is seen from outside as on the field');
  renderer.view.mode = 'edit'; draw(state, true);
  assert(!renderer.closed.has('unit'), 'the workshop still shows the design while editing');
});

test('the vehicle in the player\'s hands is drawn from outside, close up, with the dark edge of every vehicle; let go, picked, it opens again', t => {
  const { renderer, state, draw } = fixture(t), id = state.modules[0].id, hullId = 'unit:' + state.bodyPanels[0].id,
    hull = () => renderer.hullSprites.get(hullId),
    edge = () => [...renderer.silhouettes.made].find(([, made]) => made === hull().silhouette.made)[0].split('|')[0];
  // As close as taking a vehicle in hand brings the camera (squad-ux.ts `focus`).
  renderer.camera.zoom = 26;
  renderer.marked = new Map([['unit', 'selected']]); draw(state, true);
  const inside = hull().texture;
  assert(!renderer.closed.has('unit') && renderer.drawables.get(id).group.visible); assert.equal(edge(), 'selected');
  // In hand the page opens and edges nothing (squad-ux.ts `opened` and `marked`): the frame says who is in hand.
  const driven = { ...state, controlledActor: 'unit', squad: { manual: 'unit', out: [], units: [{ id: 'unit' }] } };
  renderer.marked = new Map(); draw(driven, false);
  assert(renderer.closed.has('unit'), 'the skin of the hull covers what it carries');
  assert(!renderer.drawables.get(id).group.visible, 'the fuel tank within is not drawn');
  assert.notEqual(hull().texture, inside); assert.equal(hull().parent, renderer.actorLayer('unit', 'outerSkin'));
  assert.equal(edge(), 'dark', 'no edge of a selection, nor any dashed one, round the vehicle in hand');
  assert(hull().glint?.parent, 'close up, the light along its roof shows as on any vehicle seen from outside');
  // Let go (Esc), the vehicle stays picked: it opens and wears the olive again.
  renderer.marked = new Map([['unit', 'selected']]); draw(state, true);
  assert(!renderer.closed.has('unit')); assert.equal(hull().texture, inside); assert.equal(edge(), 'selected');
});

test('a moving exterior reuses its artwork but paint and an in-place contour edit update it without changing retained artwork', t => {
  const { renderer, state, draw } = fixture(t);
  draw();
  const hull = renderer.hullSprites.values().next().value, shape = hull.fitted.outside.shape,
    original = structuredClone(shape), texture = hull.texture, position = { x: hull.x, y: hull.y }, moved = structuredClone(state);
  moved.actors[0].vehicle.x += .5; moved.actors[0].vehicle.angle += .1;
  moved.bodyPanels[0].pose = moved.actors[0].vehicle;
  draw(moved);
  assert.equal(hull.fitted.outside.shape, shape, 'rigid movement does not rebuild normalized artwork');
  assert.equal(hull.texture, texture); assert.notDeepEqual({ x: hull.x, y: hull.y }, position);
  draw(moved, true); draw(moved);
  assert.equal(hull.fitted.outside.shape, shape, 'returning from the interior retains the exterior');
  moved.actors[0].appearance.paint = '#91816a';
  for (let i = 0; i < 8; i++) draw(moved);
  const painted = hull.fitted.outside.shape;
  assert.notEqual(hull.texture, texture); assert.notEqual(painted.key, shape.key);
  const polygon = moved.bodyPanels[0].localPolygon, width = hull.width;
  polygon[1].x += .2; polygon[2].x += .2;
  draw(moved);
  assert.equal(moved.bodyPanels[0].localPolygon, polygon, 'the source array keeps its identity');
  assert(Math.abs(hull.width - width - .2) < 1e-8, 'current geometry reaches the newly moved edge');
  assert.notEqual(hull.fitted.outside.shape.key, painted.key);
  assert.deepEqual(shape, original, 'a retained bitmap keeps its original bounds and metadata');
});

test('cold covered components allocate nothing and repeated selection reuses warmed meshes and textures', t => {
  const { renderer, counters, state, draw } = fixture(t), id = state.modules[0].id;
  draw(); assert(!renderer.drawables.has(id), 'a closed hull never creates its unseen fuel tank');
  draw(state, true);
  const item = renderer.drawables.get(id), geometry = item.geometry, texture = item.mesh.texture;
  // These optional layers are outside the component group and must disappear with it.
  for (const slot of ['rim', 'shade', 'heap', 'silhouette', 'glint'])
    item[slot] = renderer.actorLayer('unit', 'edges').addChild(new Graphics());
  draw();
  assert.equal(renderer.drawables.get(id), item); assert(!item.group.visible);
  for (const slot of ['rim', 'shade', 'heap']) assert(!item[slot].visible, slot);
  for (const slot of ['silhouette', 'glint']) assert.equal(item[slot].parent, null, slot);
  assert(!texture.source.destroyed);
  draw(state, true); const warm = { ...counters };
  for (let i = 0; i < 20; i++) {
    draw(state, i % 2 === 0);
    assert.equal(renderer.drawables.get(id), item); assert.equal(item.geometry, geometry);
    assert.equal(item.mesh.texture, texture);
  }
  assert.deepEqual(counters, warm, 'selection does not repaint already known sides or components');
  draw(state, false, true); draw(state, true);
  assert.equal(item.mesh.texture, texture); assert.deepEqual(counters, warm, 'offscreen retention preserves both sides');
});

test('edited engine art releases its old size and retains the current picture through selection and culling', t => {
  const { renderer, counters, state, draw } = fixture(t);
  state.modules = [{ ...state.modules[0], kind: 'engine', width: .4, height: .3 }];
  const id = state.modules[0].id;
  draw(state, true);
  const initial = renderer.drawables.get(id), original = initial.mesh.texture, originalSource = original.source,
    originalKey = initial.textureKeys.find(key => key.startsWith('component:engine:')),
    originalPositions = [...initial.positions];
  assert(originalKey);

  const edited = structuredClone(state); edited.modules[0].width = .6;
  draw(edited, true);
  const current = renderer.drawables.get(id), texture = current.mesh.texture,
    currentKey = current.textureKeys.find(key => key.startsWith('component:engine:'));
  assert.notEqual(texture, original);
  assert.notDeepEqual([...current.positions], originalPositions, 'the edited geometry changes in the first frame');
  assert(originalSource.destroyed, 'an old dimension unused by any drawing is released by the sweep');
  assert(!renderer.textures.has(originalKey)); assert(renderer.textures.has(currentKey));

  draw(edited); draw(edited, true);
  const warm = { ...counters };
  for (const [open, unseen] of [[false, false], [true, false], [false, true], [true, false]]) {
    draw(edited, open, unseen);
    assert.equal(renderer.drawables.get(id), current);
    assert.equal(current.mesh.texture, texture);
    assert(!texture.source.destroyed); assert(renderer.textures.has(currentKey));
  }
  assert.deepEqual(counters, warm, 'closing, culling and reopening reuse the current picture without repainting');
});

test('two actors share engine art until one is edited, and the last owner determines its lifetime', t => {
  const { renderer, state, draw } = fixture(t), engine = { ...state.modules[0], kind: 'engine', width: .4, height: .3 },
    other = { ...engine, id: 'other:engine', actorId: 'other', x: 3 };
  state.modules = [engine, other];
  state.actors.push({ ...structuredClone(state.actors[0]), id: 'other', x: 3,
    vehicle: { ...state.actors[0].vehicle, x: 3 } });
  draw(state, true);
  const first = renderer.drawables.get(engine.id), second = renderer.drawables.get(other.id),
    shared = first.mesh.texture, sharedSource = shared.source,
    sharedKey = first.textureKeys.find(key => key.startsWith('component:engine:'));
  assert(sharedKey); assert.equal(second.mesh.texture, shared);

  const edited = structuredClone(state); edited.modules[0].width = .6;
  draw(edited, true);
  const changed = renderer.drawables.get(engine.id).mesh.texture;
  assert.notEqual(changed, shared); assert.equal(renderer.drawables.get(other.id).mesh.texture, shared);
  assert(!sharedSource.destroyed); assert(renderer.textures.has(sharedKey), 'the unchanged actor still owns the old dimensions');

  const alone = { ...edited, actors: edited.actors.filter(actor => actor.id === 'unit'),
    modules: edited.modules.filter(module => module.actorId === 'unit') };
  draw(alone, true);
  assert(sharedSource.destroyed, 'removing the last drawing releases the shared old picture');
  assert(!renderer.textures.has(sharedKey)); assert(!renderer.drawables.has(other.id));
  assert.equal(renderer.drawables.get(engine.id).mesh.texture, changed); assert(!changed.source.destroyed);
});

test('hull and cargo retain two rapid side variants without accumulating old load textures', t => {
  const { renderer, counters, state, draw } = fixture(t), cargoId = state.modules[1].id, hullId = 'unit:' + state.bodyPanels[0].id;
  draw(); const outside = renderer.hullSprites.get(hullId).texture, cargoOutside = renderer.drawables.get(cargoId).mesh.texture;
  draw(state, true); const inside = renderer.hullSprites.get(hullId).texture, cargoInside = renderer.drawables.get(cargoId).mesh.texture;
  assert.notEqual(inside, outside); assert.notEqual(cargoInside, cargoOutside);
  const warm = { ...counters };
  for (let i = 0; i < 10; i++) {
    const open = Boolean(i % 2); draw(state, open);
    assert.equal(renderer.hullSprites.get(hullId).texture, open ? inside : outside);
    assert.equal(renderer.drawables.get(cargoId).mesh.texture, open ? cargoInside : cargoOutside);
  }
  assert.deepEqual(counters, warm, 'rapid switching still uses the requested side');
  const previous = new Set();
  for (const amount of [0, 60, 120, 180, 240]) {
    const next = structuredClone(state); next.modules[1].cargo.ferro = amount;
    draw(next); draw(next, true);
    const retained = renderer.drawables.get(cargoId).textureKeys.filter(key => key.startsWith('component:hopper:'));
    assert.equal(retained.length, 2, 'one current cargo texture per side');
    for (const key of previous) if (!retained.includes(key)) assert(!renderer.textures.has(key), 'old load variant was released');
    previous.clear(); for (const key of retained) previous.add(key);
    assert.equal(renderer.hullSprites.get(hullId).texture, inside, 'cargo quantity does not repaint the hull');
  }
});

test('closed supplies keep their panel while unloading and retain both sides through selection and culling', t => {
  const { renderer, counters, state, draw } = fixture(t), module = state.modules[1];
  module.kind = 'supply'; module.cargo.petroleo = 25;
  draw(); const item = renderer.drawables.get(module.id), outside = item.mesh.texture, source = outside.source;
  draw(state, true); const inside = item.mesh.texture;
  assert.notEqual(inside, outside);
  const warm = { ...counters };
  for (let i = 0; i < 6; i++) {
    draw(state, false, true); draw(state, false); assert.equal(item.mesh.texture, outside);
    draw(state, true); assert.equal(item.mesh.texture, inside);
  }
  assert.deepEqual(counters, warm, 'opening, closing and returning to view reuse both pictures');
  const empty = structuredClone(state); empty.modules[1].cargo = {};
  draw(empty);
  assert.equal(item.mesh.texture, outside); assert.equal(item.mesh.texture.source, source);
  assert.deepEqual(counters, warm, 'a hidden load change does not repaint the closed side');
  draw(empty, true); assert.notEqual(item.mesh.texture, inside, 'the inside still shows the current load');
});

test('covered damage refreshes on opening and removed actor generations release their retained art', t => {
  const { renderer, state, draw } = fixture(t), id = state.modules[0].id;
  draw(state, true); const item = renderer.drawables.get(id), geometry = item.geometry, base = item.mesh.texture, tint = item.mesh.tint;
  draw();
  const damaged = structuredClone(state), fuel = damaged.modules[0];
  fuel.health = 0; fuel.markRevision = 1;
  fuel.marks = [{ u: .5, v: .5, kind: 'dent', strength: .5, radius: .02, depth: .005 }];
  draw(damaged); assert.equal(item.mesh.texture, base, 'covered damage is not painted eagerly');
  draw(damaged, true);
  assert.equal(renderer.drawables.get(id), item); assert.equal(item.geometry, geometry);
  assert.notEqual(item.mesh.texture, base); assert.notEqual(item.mesh.tint, tint);
  const damageKey = item.textureKeys.find(key => key.startsWith('damage:' + id + ':')),
    damageTexture = item.mesh.texture;
  assert.equal(renderer.textures.get(damageKey).texture, damageTexture);
  draw(damaged, true); assert.equal(item.mesh.texture, damageTexture, 'unchanged damage reuses the painted texture');
  const hull = renderer.hullSprites.values().next().value;
  draw(snapshot(1));
  assert(!renderer.drawables.has(id)); assert(item.group.destroyed); assert(hull.destroyed);
  assert(!renderer.textures.has(damageKey), 'the previous generation no longer owns its damage source');
  const empty = { ...state, actors: [], plates: [], modules: [], bodyPanels: [] };
  draw(empty);
  assert.equal(renderer.drawables.size, 0); assert.equal(renderer.hullSprites.size, 0); assert.equal(renderer.actorLayers.size, 0);
  assert.equal([...renderer.textures.values()].filter(entry => !entry.persistent).length, 0);
  assert.equal(renderer.resting.places.size, 0);
});

test('selecting a cold metal interior shows its finished backing and fittings without a painting job', t => {
  const { renderer, state, draw } = fixture(t);
  Object.assign(state.modules[0], { kind: 'command', x: -.3, y: .85, width: .44, height: .28 });
  const roof = designFrame({ modules: [], plates: [{ id: 'unit:roof', x: 0, y: 1.4, angle: 0,
    length: 1.6, thicknessMm: 20, material: 'steel', anchors: [] }] }).plates[0];
  state.plates.push({ ...roof, actorId: 'unit', attached: true });
  // Prepare the equipment and outside, leaving the inner wall unseen until the actual selection.
  draw({ ...state, bodyPanels: [] }, true); draw(state);
  const item = renderer.drawables.get(state.modules[0].id), geometry = item.geometry, positions = [...geometry.positions],
    before = structuredClone(state), hull = renderer.hullSprites.values().next().value, outside = hull.texture;
  renderer.texturePainter = { available: true, busy: false, paint() { assert.fail('the ready metal interior must not wait for the worker'); } };
  draw(state, true); renderer.paintNextTexture();
  const texture = hull.texture, source = texture.source, picture = source.resource, fittings = hull.fittings,
    layout = fittings.layout, children = [...fittings.children],
    looks = () => fittings.children.map(child => [child.fitting.kind, child.x, child.y, child.texture]);
  assert.notEqual(texture, outside); assert(picture.width > 96 && picture.height > 96);
  assert(hull.visible && fittings.visible && children.length > 0); assert(!layout.cast);
  assert(!renderer.nextTexturePaint && !renderer.texturePainter.busy);
  assert(item.group.visible); assert.equal(item.geometry, geometry); assert.deepEqual([...geometry.positions], positions);
  const current = looks(); draw(state, true); renderer.paintNextTexture();
  assert.equal(hull.texture, texture); assert.equal(hull.fittings, fittings); assert.equal(fittings.layout, layout);
  assert.deepEqual(fittings.children, children); assert.deepEqual(looks(), current);
  draw(state); draw(state, true); renderer.paintNextTexture();
  assert.equal(hull.texture, texture); assert.equal(texture.source, source); assert.equal(source.resource, picture);
  assert.equal(hull.fittings.layout, layout); assert.deepEqual(looks(), current); assert.deepEqual(state, before);
});

test('a damaged progressive concrete hull finishes offscreen and refreshes its retained damage once on return', async t => {
  const { renderer, next, painter, entry, hull, draw } = pendingHull(t, { damaged: true }), before = structuredClone(next),
    base = entry.texture, baseSource = base.source, baseCanvas = baseSource.resource,
    damaged = hull.texture, source = damaged.source, picture = source.resource,
    layout = entry.layout, painted = entry.painted, fittings = hull.fittings,
    children = [...fittings.children],
    item = renderer.drawables.get(next.modules[0].id), geometry = item.geometry, positions = [...geometry.positions],
    pose = [hull.x, hull.y, hull.rotation, hull.width, hull.height];
  assert.notEqual(damaged, base, 'the real marked plate supplies a damaged hull copy');
  assert(picture.width <= 96 && picture.height <= 96); assert(layout.cast); assert.equal(children.length, 0, 'concrete has no metal fittings');
  let uploads = 0; source.on('update', () => uploads++);
  renderer.paintNextTexture();
  renderer.camera.x = 2000; draw(next, true);
  assert(renderer.unseen.has('unit')); assert(!renderer.actorLayers.get('unit').container.visible);
  const reply = hullReply(); await painter.complete(reply);
  assert.equal(reply.closes, 1); assert.equal(entry.texture, base); assert.equal(base.source, baseSource); assert.equal(baseSource.resource, baseCanvas);
  assert.deepEqual([baseCanvas.width, baseCanvas.height], [reply.width, reply.height]);
  draw(next, true); assert.equal(uploads, 0, 'a hidden actor need not repaint its damaged copy');
  assert(!renderer.actorLayers.get('unit').container.visible);
  renderer.camera.x = 0; draw(next, true);
  assert.equal(hull.texture, damaged); assert.equal(damaged.source, source); assert.equal(source.resource, picture);
  assert.deepEqual([picture.width, picture.height], [reply.width, reply.height]); assert.equal(uploads, 1);
  assert.equal(entry.layout, layout); assert.equal(entry.painted, painted); assert.equal(hull.fittings, fittings); assert.equal(fittings.layout, layout);
  assert.deepEqual(fittings.children, children);
  assert.equal(item.geometry, geometry); assert.deepEqual([...geometry.positions], positions);
  assert.deepEqual([hull.x, hull.y, hull.rotation], pose.slice(0, 3));
  assert(Math.abs(hull.width - pose[3]) < 1e-9 && Math.abs(hull.height - pose[4]) < 1e-9);
  assert(hull.visible && renderer.actorLayers.get('unit').container.visible); assert.deepEqual(next, before);
  draw(next, true); assert.equal(uploads, 1, 'unchanged impact records do not upload again');
});

test('finishing an older hull during a drag keeps the current outline and undo restores its finished backing', async t => {
  const { renderer, next, painter, entry, hull, draw } = pendingHull(t, { edit: true }), base = entry.texture,
    source = base.source, picture = source.resource, dragged = structuredClone(next);
  renderer.paintNextTexture(); dragged.bodyPanels[0].localPolygon[1].x += .4;
  draw(dragged, true, false, true);
  const layout = hull.fittings.layout, feet = structuredClone(renderer.hullFeet.get('unit'));
  assert.equal(hull.texture, base); assert(!hull.visible && hull.rim.visible);
  assert(rimCovers(hull, { x: 1.25, y: .62 }), 'the fill follows the dragged corner while its backing is pending');
  const reply = hullReply(); await painter.complete(reply); draw(dragged, true, false, true);
  assert.equal(reply.closes, 1); assert.equal(hull.texture, base); assert.equal(base.source, source); assert.equal(source.resource, picture);
  assert(!hull.visible && hull.rim.visible); assert(rimCovers(hull, { x: 1.25, y: .62 }));
  assert.equal(hull.fittings.layout, layout); assert.deepEqual(renderer.hullFeet.get('unit'), feet);
  draw(next, true, false, true);
  assert(hull.visible && hull.fittings.visible, 'restoring the pre-drag source uses its now-current picture immediately');
  assert.equal(hull.texture, base); assert.deepEqual([picture.width, picture.height], [reply.width, reply.height]);
  assert(!rimCovers(hull, { x: 1.25, y: .62 }), 'the restored outline does not retain the cancelled corner');
});

test('an evicted hull result cannot revive or overwrite the same key recreated by undo', async t => {
  const { renderer, next, painter, entry, hull, draw } = pendingHull(t, { edit: true }), old = entry.texture, oldSource = old.source,
    further = structuredClone(next);
  renderer.paintNextTexture(); further.bodyPanels[0].localPolygon[1].x += .4;
  renderer.frameNow += 100; draw(further, true);
  assert(oldSource.destroyed); assert(!renderer.textures.has(entry.key));
  renderer.frameNow += 100; draw(next, true);
  const restored = hull.texture, source = restored.source, picture = source.resource, layout = hull.fittings.layout,
    current = renderer.textures.get(entry.key), size = [picture.width, picture.height];
  assert(current && current !== entry); assert.equal(current.texture, restored); assert.notEqual(restored, old);
  assert(picture.width <= 96 && picture.height <= 96);
  const reply = hullReply(); await painter.complete(reply); draw(next, true);
  assert.equal(reply.closes, 1); assert(oldSource.destroyed); assert.equal(renderer.textures.get(entry.key), current);
  assert.equal(hull.texture, restored); assert.equal(restored.source, source); assert.equal(source.resource, picture);
  assert.deepEqual([picture.width, picture.height], size); assert.equal(hull.fittings.layout, layout);
  assert(hull.visible && hull.fittings.visible); assert(!rimCovers(hull, { x: 1.25, y: .62 }));
});

test('moving equipment updates inner fittings without repainting the wall, including a translated room', t => {
  const { renderer, state, draw } = fixture(t), next = structuredClone(state);
  renderer.view.mode = 'edit';
  next.actors[0].id = 'local';
  next.modules = [{ ...next.modules[0], actorId: 'local', kind: 'command', x: -.5, y: 1.3, width: .44, height: .28 }];
  next.bodyPanels = [{ id: 'room', actorId: 'local', poly: [
    { x: -2, y: .5 }, { x: 2, y: .5 }, { x: 2, y: 2.5 }, { x: -2, y: 2.5 },
  ] }];
  draw(next);
  const hull = renderer.hullSprites.get('local:room'), wall = hull.texture,
    junction = () => hull.fittings.children.find(child => child.fitting.kind === 'junction');
  assert(junction(), 'the crew has a junction on the inner wall');
  const before = { x: junction().x, y: junction().y }, moved = structuredClone(next);
  moved.modules[0].x += .3; draw(moved);
  assert.equal(hull.texture, wall, 'equipment does not belong to the inner wall bitmap');
  assert(Math.abs(junction().x - before.x - .3) < 1e-8);
  assert.equal(junction().y, before.y);

  const position = { x: junction().x, y: junction().y }, translated = structuredClone(moved);
  translated.modules[0].x += 4; translated.modules[0].y += 3;
  for (const point of translated.bodyPanels[0].poly) { point.x += 4; point.y += 3; }
  // Along the floor of the room: Pixi does not hit-test the edge that closes a stroked polygon.
  assert(rimCovers(hull, { x: 0, y: .5 }), 'the cut-open room has its rim');
  const redrawn = t.mock.method(hull.rim, 'clear');
  draw(translated);
  assert.equal(hull.texture, wall, 'translation retains the normalized backing');
  assert(Math.abs(junction().x - position.x - 4) < 1e-8);
  assert(Math.abs(junction().y - position.y - 3) < 1e-8, 'room translation is applied once');
  assert(rimCovers(hull, { x: 4, y: 3.5 }), 'the rim stands on the translated outline');
  assert(!rimCovers(hull, { x: 0, y: .5 }), 'no rim is left where the room stood');
  assert.equal(redrawn.mock.callCount(), 0, 'the rim of an outline only moved is not drawn again');

  const painted = structuredClone(translated); painted.actors[0].appearance.paint = '#91816a';
  for (let frame = 0; frame < 8; frame++) draw(painted);
  assert.notEqual(hull.texture, wall, 'changing paint still repaints the wall');
  assert(junction().key.includes(String(0x91816a)), 'fittings get the current paint too');
});

test('identical inner walls share their bitmap while keeping each room fittings independent', t => {
  const { renderer, state, draw } = fixture(t), next = structuredClone(state);
  renderer.view.mode = 'edit';
  const room = [{ x: -2, y: .5 }, { x: 2, y: .5 }, { x: 2, y: 2.5 }, { x: -2, y: 2.5 }];
  next.actors.push({ ...next.actors[0], id: 'other', x: 4, vehicle: { x: 4, y: 1, angle: 0 } });
  const command = { ...next.modules[0], kind: 'command', x: -.5, y: 1.3, width: .44, height: .28 };
  next.modules = [command, { ...command, id: 'other:command', actorId: 'other', x: 4.5 }];
  next.bodyPanels = [{ id: 'room', actorId: 'unit', poly: room },
    { id: 'room', actorId: 'other', poly: room.map(p => ({ x: p.x + 4, y: p.y })) }];
  draw(next);
  const first = renderer.hullSprites.get('unit:room'), other = renderer.hullSprites.get('other:room'),
    junction = hull => hull.fittings.children.find(child => child.fitting.kind === 'junction');
  assert.equal(first.texture, other.texture);
  assert(junction(first) && junction(other));
  const before = [junction(first).x, junction(other).x], moved = structuredClone(next);
  assert(Math.abs(before[1] - before[0] - 5) < 1e-8);
  moved.modules[0].x += .3; draw(moved);
  assert.equal(first.texture, other.texture);
  assert(Math.abs(junction(first).x - before[0] - .3) < 1e-8);
  assert.equal(junction(other).x, before[1], 'sharing a wall does not overwrite another room layout');
});

test('a short editing drag keeps the current filled outline until its backing is ready after release', t => {
  const { renderer, state, draw } = fixture(t);
  renderer.view.mode = 'edit'; draw(state, true);
  const hull = renderer.hullSprites.values().next().value, original = hull.texture, next = structuredClone(state);
  next.bodyPanels[0].localPolygon[1].x += .3;
  draw(next, true, false, true);
  assert(hull.texture === original, 'the hot backing stays retained'); assert(!hull.visible && hull.rim.visible);
  assert(rimCovers(hull, { x: 1, y: .7 }), 'the fill reaches the newly moved corner');
  assert(hull.fittings.visible); assert(renderer.drawables.get(state.modules[0].id).group.visible);
  assert(hull.rim.parent === hull.fittings.parent, 'the preview and fittings share their backing layer');
  assert(hull.rim.parent.getChildIndex(hull.rim) < hull.rim.parent.getChildIndex(hull.fittings), 'the fill stays behind current fittings');
  assert(Math.abs(renderer.hullFeet.get('unit')[0][1].x - 1.1) < 1e-8, 'feet follow the current outline');
  draw(next, true);
  assert(!hull.visible && rimCovers(hull, { x: 0, y: 1 }), 'release does not remove the preview before the bitmap is current');
  while (renderer.frameNow < 96) draw(next, true);
  assert(hull.visible && hull.fittings.visible); assert(hull.texture !== original, 'the current backing replaces the retained bitmap');
  assert(!rimCovers(hull, { x: 0, y: 1 }), 'the normal cutaway returns to its unfilled rim');
  assert(original.destroyed, 'the obsolete backing is released when the final outline is painted');
});

test('an exterior editing preview holds its backing while keeping fittings and feet current, then cancels or releases cleanly', t => {
  const { renderer, state, draw } = fixture(t);
  // The editor's exterior toggle applies to its design, whose actor is local, rather than a selected field vehicle.
  state.actors[0].id = 'local';
  for (const part of [...state.modules, ...state.bodyPanels]) part.actorId = 'local';
  renderer.view.mode = 'edit'; renderer.view.exterior = true; draw();
  const hull = renderer.hullSprites.values().next().value, original = hull.texture;
  assert(hull.fittings.children.length, 'the warmed exterior has real fitting sprites and textures');
  for (let frame = 0; frame < 12; frame++) {
    const next = structuredClone(state); next.bodyPanels[0].localPolygon[1].x += .1 * (frame + 1);
    draw(next, false, false, true);
    assert(hull.texture === original, 'the exterior backing stays retained'); assert(!hull.visible && hull.fittings.visible);
    assert(hull.rim.parent === renderer.actorLayer('local', 'outerSkin'), 'the exterior preview belongs over the enclosed pieces');
    assert.equal(hull.fittings.layout, hull.fitted.outside.art.layout, 'fittings follow the current layout');
    assert(hull.rim.parent.getChildIndex(hull.rim) < hull.rim.parent.getChildIndex(hull.fittings));
    assert.equal([...renderer.textures.keys()].filter(key => key.startsWith('hull:outside:')).length, 1, 'intermediate backing shapes are not retained');
    assert(Math.abs(renderer.hullFeet.get('local')[0][1].x - (.9 + .1 * frame)) < 1e-8);
  }
  draw(state, false, false, true);
  assert(hull.visible && !hull.rim.visible, 'returning to cached artwork is immediate even during a drag');
  const retained = hull.fittings.children.map(child => child.texture);
  const empty = { ...state, actors: [], plates: [], modules: [], bodyPanels: [] };
  draw(empty);
  assert(hull.destroyed && original.destroyed); assert(retained.every(texture => texture.destroyed));
  assert.equal([...renderer.textures.values()].filter(entry => !entry.persistent).length, 0);
});

test('a held opening follows current material and picking at unchanged identity and dimensions, including release and cancel', t => {
  const { renderer, draw } = fixture(t);
  renderer.view.mode = 'edit';
  renderer.textures.set('material:steel', { key: 'material:steel', texture: Texture.WHITE, persistent: true });
  const definition = { id: 'port', x: 0, y: 1, angle: 0, length: 4, thicknessMm: 100, material: 'steel', anchors: [] },
    opened = gap => {
      const state = designFrame({ plates: [definition], modules: [] });
      state.plates[0].solidRegions = [{ minX: -2, maxX: gap - .25, minY: -.05, maxY: .05 },
        { minX: gap + .25, maxX: 2, minY: -.05, maxY: .05 }];
      return state;
    }, left = opened(-.5), right = opened(.5), middle = opened(0);
  assert.deepEqual([left, right, middle].map(state => {
    const p = state.plates[0]; return [p.id, p.revision, p.definition.length, p.definition.thicknessMm];
  }), Array.from({ length: 3 }, () => ['port', 0, 4, 100]));
  // The last two settled draws model committing the current preview and cancelling back to that committed state.
  for (const [state, gap, hold] of [[left, -.5, false], [left, -.5, true], [right, .5, true], [middle, 0, true],
    [middle, 0, false], [right, .5, true], [middle, 0, false]]) {
    const before = structuredClone(state);
    draw(state, false, false, hold);
    const item = renderer.drawables.get('port');
    for (const x of [-.5, 0, .5]) {
      const point = { x, y: 0 }, world = { x, y: 1 }, material = x !== gap;
      assert.equal(triangleMeshContains(item.mesh, point), material, 'the displayed opening follows this preview');
      assert.equal(pickPiece(state.plates, [], world, 0, plate => regionContains(plate, world)),
        material ? 'port' : null, 'the real clipped-material picker agrees with the displayed material');
    }
    assert(item.rim.containsPoint({ x: gap - .25, y: 0 }), 'the current opening has its cut edge');
    assert(!item.rim.containsPoint({ x: (gap === -.5 ? .5 : -.5) - .25, y: 0 }), 'an old opening leaves no stray edge');
    assert.deepEqual(state, before, 'drawing and picking leave the source intact');
  }
});

test('release and cancel restore current beveled faces and joined outlines after a held reshape', t => {
  const { renderer, draw } = fixture(t), reference = new Renderer({}, { mode: 'edit' });
  renderer.view.mode = 'edit';
  reference.actorLayerRoot = new Container(); reference.shadows = new Graphics();
  Object.assign(reference.camera, { x: 0, y: 1, zoom: 40, width: 600, height: 400 });
  for (const r of [renderer, reference]) r.textures.set('material:steel', { key: 'material:steel', texture: Texture.WHITE, persistent: true });
  t.after(() => { reference.clearParts(); reference.clearLayers(); reference.releaseTextures(true); reference.actorLayerRoot.destroy({ children: true }); reference.shadows.destroy(); });
  const stateAt = length => designFrame({ modules: [], plates: [
    { id: 'floor', x: 0, y: 1, angle: 0, length, thicknessMm: 100, material: 'steel', anchors: [] },
    { id: 'wall', x: length / 2, y: 2, angle: Math.PI / 2, length: 2, thicknessMm: 100, material: 'steel', anchors: [] },
  ] }), initial = stateAt(2), current = stateAt(2.4);
  reference.scene = sampleScene(current); reference.syncActorLayers(current); reference.drawSurfaces();
  assert(!triangleMeshContains(reference.drawables.get('floor').mesh, { x: -1.199, y: -.049 }), 'normal artwork bevels the free corner');
  draw(initial);
  for (const [action, temporary] of [['release', current], ['cancel', initial]]) {
    draw(temporary, false, false, true);
    assert(triangleMeshContains(renderer.drawables.get('floor').mesh, { x: 0, y: 0 }), 'the held preview keeps the current plate visible');
    draw(current);
    for (const source of current.plates) {
      const actual = renderer.drawables.get(source.id), expected = reference.drawables.get(source.id), l = source.definition.length / 2;
      assert(actual.mesh.visible && actual.rim.visible);
      for (const point of [{ x: -l + .001, y: -.049 }, { x: l - .001, y: .049 },
        { x: -l, y: 0 }, { x: l, y: 0 }, { x: 0, y: .05 }]) {
        assert.equal(triangleMeshContains(actual.mesh, point), triangleMeshContains(expected.mesh, point), action + ' restores the current face');
        assert.equal(actual.rim.containsPoint(point), expected.rim.containsPoint(point), action + ' restores the current joined outline');
      }
    }
  }
});
