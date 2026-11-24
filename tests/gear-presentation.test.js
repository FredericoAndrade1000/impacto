import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, GraphicsContext, Texture } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { designFrame, sampleScene, regionGeometry } from '../src/scene-frame.ts';
import { Terrain } from '../src/terrain.ts';
import { linkStart, trackGear, trackLinks } from '../src/running-gear.ts';
import { componentPolygon } from '../src/assembly.ts';
import { MAIN_LIGHT } from '../src/main-light.ts';
import { countingCanvas } from './scenery-canvas.js';

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-11, `${actual} != ${expected}`);
function frame(kind = 'wheel', wheelSpin = 0) {
  const health = kind === 'wheel' ? 80 : 160;
  const state = designFrame({ plates: [], modules: [{ id: 'gear', kind, x: 12, y: .5, angle: .2,
    width: kind === 'wheel' ? 1 : 3, height: 1, health, maxHealth: health, attached: true, wheelSpin, wheelAngularSpeed: 0 }] });
  state.actors[0].vehicle = { x: 12, y: 1.3, angle: .2, chassisId: 'root', travel: 1000 };
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
function draw(renderer, state, previous = null, alpha = 1) {
  renderer.scene = sampleScene(state, previous, alpha); renderer.syncActorLayers(state); renderer.drawSurfaces();
  return renderer.drawables.get('gear');
}

for (const direction of [-1, 1]) test(`unwrapped wheel phase crosses a full turn continuously in direction ${direction}`, () => {
  const a = direction * (2 * Math.PI - .2), b = direction * (2 * Math.PI + .2),
    before = frame('wheel', a), after = frame('wheel', b), source = JSON.stringify(after);
  for (const alpha of [0, .25, .5, .75, 1]) {
    const sampled = sampleScene(after, before, alpha).pose('gear');
    near(sampled.wheelSpin, a + (b - a) * alpha); near(sampled.angle, .2);
  }
  assert.equal(JSON.stringify(after), source, 'sampling cannot write its display phase back into the simulation');
});

test('fast wheels retain complete turns between snapshots instead of taking the shortest angular path', () => {
  for (const direction of [-1, 1]) {
    const before = frame(), after = frame('wheel', direction * (4 * Math.PI + .6));
    after.modules[0].wheelAngularSpeed = direction * (4 * Math.PI + .6) / .1;
    const pose = sampleScene(after, before, .5).pose('gear');
    near(pose.wheelSpin, direction * (2 * Math.PI + .3));
    assert.equal(Math.sign(pose.wheelAngularSpeed), direction);
  }
});

test('wheel artwork rotates independently of the rigid module pose, suspension and hitbox', t => {
  const renderer = presenter(t), before = frame(), item = draw(renderer, before),
    positions = [...item.positions], geometry = item.geometry, outline = componentPolygon(before.modules[0]);
  for (const spin of [-4, 3]) {
    const after = frame('wheel', spin), source = JSON.stringify(after), current = draw(renderer, after, before, .5);
    assert.equal(current, item); assert.equal(item.geometry, geometry); near(item.mesh.rotation, spin / 2);
    near(item.group.rotation, .2); near(item.group.x, 12); near(item.group.y, .5);
    assert.deepEqual([...item.positions], positions); assert.deepEqual(componentPolygon(after.modules[0]), outline);
    assert.equal(JSON.stringify(after), source);
  }
});

test('track wheels and belt use sampled native phase, including reverse and stopped phase during carrier travel', t => {
  const renderer = presenter(t), before = frame('track'), after = frame('track', .8);
  after.actors[0].vehicle.travel = 2000;
  const item = draw(renderer, after, before, .5), pose = renderer.scene.pose('gear'),
    travel = -.4 * pose.height / 2, gear = trackGear(pose, renderer.ground), { count, teeth } = trackLinks(pose.width, pose.height),
    turn = -travel / gear.pin;
  // The sprocket turns as far as the belt goes on the line of its pins, and the links go round with it, at its teeth;
  // every other wheel rolls on the belt as far as it goes.
  assert.equal(item.trackDetails.wheels.length, gear.drawn.length);
  item.trackDetails.wheels.forEach((sprite, i) => near(sprite.rotation, gear.drawn[i].role === 'sprocket' ? turn : -travel / gear.drawn[i].rolls));
  near(item.trackDetails.links.start, linkStart(gear, count, teeth, turn)); near(item.group.rotation, .2);
  const stopped = frame('track', .8); stopped.actors[0].vehicle.travel = 4000;
  draw(renderer, stopped, after, .5);
  const held = item.trackDetails.links.start, rotations = item.trackDetails.wheels.map(wheel => wheel.rotation);
  draw(renderer, stopped, after, 1);
  near(item.trackDetails.links.start, held); assert.deepEqual(item.trackDetails.wheels.map(wheel => wheel.rotation), rotations);
});

test('over rough ground and as it stops, the sprocket only ever turns the way the belt goes, and everything of the track stays with its wheels', t => {
  const renderer = presenter(t); renderer.view.mode = 'test'; renderer.camera.zoom = 120; renderer.ground = new Terrain('rough');
  // Ahead, then slowing to a stop and back a little: the belt going round, the hull bobbing over the bumps.
  let spin = 0, lastSpin = null, lastTurn = null, side = null, item = null;
  for (let n = 0; n < 160; n++) {
    const speed = n < 100 ? -.35 : n < 130 ? -.35 * (130 - n) / 30 : .05 * (n - 130) / 30;
    spin += speed;
    const state = frame('track', spin), x = 12 + n * .09, ground = renderer.ground.height(x);
    Object.assign(state.modules[0], { x, y: ground + .5 + .04 * Math.sin(n * .7), angle: .08 * Math.sin(n * .3) });
    Object.assign(state.actors[0].vehicle, { x, y: ground + 1.3, angle: state.modules[0].angle });
    item = draw(renderer, state);
    const details = item.trackDetails, gear = details.gear, pose = renderer.scene.pose('gear'), travel = -pose.wheelSpin * pose.height / 2,
      sprocket = details.wheels[gear.drawn.findIndex(wheel => wheel.role === 'sprocket')], turn = sprocket.rotation;
    near(turn, -travel / gear.pin);
    if (lastTurn !== null && pose.wheelSpin !== lastSpin) assert.equal(Math.sign(turn - lastTurn), Math.sign(pose.wheelSpin - lastSpin), 'the sprocket turned back');
    lastTurn = turn; lastSpin = pose.wheelSpin;
    // Each wheel where the running gear has it this frame, the arms and the brackets drawn for it, the links round its
    // belt, the side of the hull the same size, and the outline round the links as they are drawn.
    gear.drawn.forEach((wheel, i) => { near(details.wheels[i].x, wheel.x); near(details.wheels[i].y, wheel.y); });
    assert.equal(details.frameGear, gear); assert.equal(details.links.belt, gear.belt); assert(details.links.visible);
    const size = [details.side.width, details.side.height];
    if (side) { near(size[0], side[0]); near(size[1], side[1]); } else side = size;
    assert.equal(details.outline, details.links.outline); assert.equal(item.silhouette.drawnFor.shape, details.outline);
    assert.equal(details.cover.outline, details.outline); assert.equal(details.dirt.outline, details.links.tread);
    assert.deepEqual(details.container.children.slice(-2), [details.dirt, details.cover]);
    for (const key of ['x', 'y', 'rotation']) assert.equal(item.silhouette[key], item.group[key]);
  }
});

test('track detail stays in its parent frame when the vehicle, an ancestor and the distant camera turn', t => {
  const renderer = presenter(t), world = new Container(); world.addChild(renderer.actorLayerRoot);
  renderer.actorLayerRoot.rotation = .17; t.after(() => world.destroy());
  let details = null;
  for (const [x, y, angle, zoom, spin] of [[12, .5, .4, 22, .2], [125000.375, 36, -.63, 80, .8], [125003.125, 37, .29, 12, -.5]]) {
    const state = frame('track', spin);
    Object.assign(state.modules[0], { x, y, angle }); Object.assign(state.actors[0].vehicle, { x, y: y + .8, angle });
    Object.assign(renderer.camera, { x: x + .25, y: y + 1, zoom });
    world.position.set(450 - renderer.camera.x * zoom, 275 + renderer.camera.y * zoom); world.scale.set(zoom, -zoom);
    const item = draw(renderer, state), current = item.trackDetails.container;
    if (details) assert.equal(current, details); else details = current;
    assert.equal(current.parent, item.group); assert.equal(item.group.rotation, angle);
    current.updateLocalTransform();
    const m = current.localTransform;
    assert.deepEqual([m.a, m.b, m.c, m.d, m.tx, m.ty], [1, 0, 0, 1, 0, 0]);
    for (const point of [{ x: 0, y: 0 }, { x: -1.2, y: .3 }, { x: 1.2, y: -.3 }]) {
      const actual = current.toGlobal(point), expected = item.group.toGlobal(point);
      near(actual.x, expected.x); near(actual.y, expected.y);
    }
  }
});

test('editor running gear without a native phase remains stationary without another spin accumulator', t => {
  const renderer = presenter(t), state = frame(); delete state.modules[0].wheelSpin;
  const item = draw(renderer, state);
  assert.equal(item.mesh.rotation, 0); assert(!Object.hasOwn(state.modules[0], 'wheelSpin'));
});

test('distant tracks retain their silhouette without animating fine detail and resume from the current native phase', t => {
  const renderer = presenter(t), state = frame('track');
  renderer.view.mode = 'test'; renderer.camera.zoom = 10;
  const original = JSON.stringify(state), item = draw(renderer, state);
  assert.equal(item.trackDetails, undefined, 'a distant track builds no wheel sprites or suspension');
  assert(item.mesh.visible && item.positions.length, 'the full track silhouette remains drawn');
  renderer.camera.zoom = 22; draw(renderer, state);
  const details = item.trackDetails, rotations = details.wheels.map(wheel => wheel.rotation);
  assert(details.container.visible);
  renderer.camera.zoom = 10;
  const moving = frame('track', 4); draw(renderer, moving);
  assert.equal(item.trackDetails, details); assert.equal(details.container.visible, false);
  assert.deepEqual(details.wheels.map(wheel => wheel.rotation), rotations, 'hidden wheels perform no animation work');
  renderer.camera.zoom = 22; draw(renderer, moving);
  assert(details.container.visible); assert.notDeepEqual(details.wheels.map(wheel => wheel.rotation), rotations);
  assert.equal(JSON.stringify(state), original);
});

test('the workshop keeps detailed tracks at any zoom', t => {
  const renderer = presenter(t); renderer.camera.zoom = .1;
  assert(draw(renderer, frame('track')).trackDetails.container.visible);
});

test('distant contact shadows reuse subpixel travel, stay on the ground and keep following a moving track', t => {
  const renderer = presenter(t), zoom = renderer.camera.zoom = 3.2;
  renderer.view.mode = 'test';
  const at = pixels => {
    const state = frame('track'); Object.assign(state.modules[0], { x: 12 + pixels / zoom, y: .5, angle: 0 });
    return draw(renderer, state).shade;
  }, shade = at(0), first = shade.context.instructions[0], start = shade.getBounds().minX;
  assert(first);
  for (const pixels of [.3, .6, .9]) {
    at(pixels); assert.equal(shade.context.instructions[0], first, 'subpixel horizontal motion retains the ground drawing');
  }
  for (const pixels of [1.2, 1.5, 2.1, 2.7, 3.3, 4.2, 7.8]) {
    at(pixels);
    const bounds = shade.getBounds();
    assert(Math.abs(bounds.minX - start - pixels / zoom) * zoom <= 1 + 1e-8, 'the visible shadow never trails its moving track by more than a pixel');
    assert(bounds.minY < 0 && bounds.maxY > 0, 'the reused drawing straddles the ground, rather than following the track into the air');
  }
  assert.notEqual(shade.context.instructions[0], first, 'continuous travel does not freeze the shadow');
  const beforePan = shade.context.instructions[0]; renderer.camera.x += 100; at(7.8);
  assert.equal(shade.context.instructions[0], beforePan, 'panning alone does not reconstruct the world drawing');
});

test('contact shadows retain inspection precision in the workshop, nearby and with custom ground samplers', t => {
  const renderer = presenter(t);
  for (const [mode, zoom, custom] of [['edit', 3.2, false], ['test', 22, false], ['test', 3.2, true]]) {
    renderer.view.mode = mode; renderer.camera.zoom = zoom;
    renderer.ground = custom ? { height: () => 0 } : new Terrain('flat');
    const before = frame('track'); Object.assign(before.modules[0], { y: .5, angle: 0 });
    const shade = draw(renderer, before).shade, first = shade.context.instructions[0], after = frame('track');
    assert(first);
    Object.assign(after.modules[0], { x: 12 + .5 / zoom, y: .5, angle: 0 }); draw(renderer, after);
    assert.notEqual(shade.context.instructions[0], first, 'half a pixel of motion is already redrawn when inspecting or sampling custom ground');
  }
});

test('distant shadows respond to steep relief, lift, zoom, long-part rotation and combined movement', t => {
  const renderer = presenter(t), zoom = renderer.camera.zoom = 3.2;
  renderer.view.mode = 'test';
  // A steep rise just beyond the track is part of the real terrain before its next subpixel step reaches it.
  const ground = renderer.ground;
  ground.points[ground.segmentIndex(14)].y = 1;
  const before = frame('track'); Object.assign(before.modules[0], { y: .5, angle: 0 });
  const shade = draw(renderer, before).shade, first = shade.context.instructions[0], moved = frame('track');
  assert(first);
  Object.assign(moved.modules[0], { x: 12 + .5 / zoom, y: .5, angle: 0 }); draw(renderer, moved);
  assert.notEqual(shade.context.instructions[0], first, 'the extra horizontal allowance cannot skip a steep rise');
  const lifted = frame('track'); Object.assign(lifted.modules[0], { y: 2, angle: 0 }); draw(renderer, lifted);
  assert.equal(shade.context.instructions.length, 0, 'lifting clear of the terrain removes the contact shadow');
  renderer.ground = new Terrain('flat'); draw(renderer, before);
  const distantDepth = shade.getBounds().height;
  renderer.camera.zoom = 22; draw(renderer, before);
  assert(shade.getBounds().height < distantDepth / 2, 'approaching reduces the world depth to keep the contact shadow only a few pixels deep');
  assert(shade.getBounds().height * 22 < MAIN_LIGHT.contactPixels + 1.5,
    'the soft contact and its one-pixel overlap stay within the configured lighting footprint');
  renderer.camera.zoom = zoom;
  const long = frame('track'); Object.assign(long.modules[0], { width: 20, y: .5, angle: 0 });
  draw(renderer, long); const straight = shade.context.instructions[0];
  const turned = frame('track'); Object.assign(turned.modules[0], { width: 20, y: .5, angle: .01 }); draw(renderer, turned);
  assert.notEqual(shade.context.instructions[0], straight, 'the distant end of a long part retains the quarter-pixel rotation precision');
  draw(renderer, long); const unshifted = shade.context.instructions[0], combined = frame('track');
  Object.assign(combined.modules[0], { width: 20, x: 12 + .9 / zoom, y: .5, angle: .005 }); draw(renderer, combined);
  assert.notEqual(shade.context.instructions[0], unshifted, 'translation and rotation share the same one-pixel movement allowance');
});

test('detailed tracks keep final visibility across parked, moving and camera-only frames without invalidating stage structure', t => {
  const renderer = presenter(t), stage = new Container({ isRenderGroup: true }), state = frame('track', .3);
  renderer.view.mode = 'test'; renderer.camera.zoom = 22; stage.addChild(renderer.actorLayerRoot);
  t.after(() => stage.destroy());
  const item = draw(renderer, state), details = item.trackDetails, changes = [];
  details.container.on('visibleChanged', visible => changes.push(visible));
  for (const [x, phase] of [[12, .3], [12, .3], [12.25, .3], [12.5, .6], [125000.375, .9]]) {
    renderer.camera.x = x; stage.renderGroup.structureDidChange = false;
    draw(renderer, phase === .3 ? state : frame('track', phase));
    assert.equal(item.trackDetails, details); assert.equal(details.container.visible, true);
    assert.equal(stage.renderGroup.structureDidChange, false, 'a belt that remains visible does not rebuild all vehicle batches');
  }
  assert.deepEqual(changes, []);
  renderer.camera.zoom = 1; draw(renderer, state);
  assert.deepEqual(changes, [false]); assert.equal(details.container.visible, false);
  stage.renderGroup.structureDidChange = false; draw(renderer, state);
  assert.equal(stage.renderGroup.structureDidChange, false); assert.deepEqual(changes, [false]);
  renderer.camera.zoom = 22; draw(renderer, state);
  assert.equal(details.container.visible, true); assert.deepEqual(changes, [false, true]);
});

test('cut or detached belts hide retained detail and restore it only when the belt can be drawn again', t => {
  const renderer = presenter(t), state = frame('track', .3);
  renderer.view.mode = 'test'; renderer.camera.zoom = 22;
  const item = draw(renderer, state), details = item.trackDetails;
  for (const change of [{ beltCut: true }, { attached: false }, { beltCut: true, attached: false }]) {
    const damaged = frame('track', .4); Object.assign(damaged.modules[0], change);
    draw(renderer, damaged); assert.equal(item.trackDetails, details); assert.equal(details.container.visible, false);
    draw(renderer, state); assert.equal(item.trackDetails, details); assert.equal(details.container.visible, true);
  }
  const empty = { ...state, modules: [] }; draw(renderer, empty);
  assert.equal(renderer.drawables.has('gear'), false); assert.equal(details.container.destroyed, true);
});

test('retiring a track unloads its own vector contexts and buffers while actor pruning keeps shared flag and mask contexts', t => {
  const renderer = presenter(t), state = frame('track', .3), item = draw(renderer, state), layers = renderer.actorLayers.get('local'),
    own = [item.trackDetails.frame.context, item.shade.context, item.silhouette.context], actorContexts = [layers.suspensionArms.context, layers.gun.context],
    buffers = [item.trackDetails.links, item.trackDetails.dirt, item.trackDetails.cover].flatMap(mesh => mesh.geometry.buffers), unloaded = new Set(), flagContext = new GraphicsContext(), flagHost = new Container();
  for (const context of [...own, ...actorContexts]) context.on('unload', () => unloaded.add(context));
  layers.flag = flagHost.addChild(new Graphics(flagContext));
  const sharedMask = renderer.effectSurfaceClip.geometry.getBuffer('aPosition'), empty = { ...state, actors: [], modules: [], plates: [] };
  draw(renderer, empty);
  assert(own.every(context => context.destroyed && unloaded.has(context)));
  assert(buffers.every(buffer => buffer.destroyed));
  assert(actorContexts.every(context => !context.destroyed));
  renderer.pruneActorLayers(empty);
  assert(actorContexts.every(context => context.destroyed && unloaded.has(context)));
  assert.equal(flagContext.destroyed, false, 'flag artwork is shared by other vehicles');
  assert.equal(sharedMask.destroyed, false, 'the ground clip is shared by all effects');
  flagHost.destroy({ children: true }); flagContext.destroy(); renderer.effectSurfaceClip.destroy();
});

test('distant armour retains damage openings and restores cached close-up joins when approaching', t => {
  const renderer = presenter(t), state = designFrame({ modules: [], plates: [
    { id: 'panel', x: 12, y: 2, angle: 0, material: 'steel', length: 4, thicknessMm: 100, anchors: [] },
  ] });
  renderer.view.mode = 'test'; renderer.getTexture = () => Texture.EMPTY;
  const plate = state.plates[0];
  plate.solidRegions = [{ minX: -2, maxX: -.25, minY: -.05, maxY: .05 }, { minX: .25, maxX: 2, minY: -.05, maxY: .05 }];
  plate.revision++;
  draw(renderer, state);
  const built = { ...renderer.armorArt.stats };
  assert(built.shapeBuilds > 0);
  renderer.camera.zoom = 1; draw(renderer, state);
  assert.equal(renderer.armorPlan, null); assert.deepEqual(renderer.armorArt.stats, built, 'zoomed-out frames build no bevels or joins');
  assert.equal(renderer.drawables.get('panel').data, regionGeometry(plate), 'the silhouette uses the original damaged mesh');
  // Under 12 px/m the widest bevel is two thirds of a pixel: no join is laid out either.
  renderer.camera.zoom = 11.9; draw(renderer, state);
  assert.equal(renderer.armorPlan, null); assert.deepEqual(renderer.armorArt.stats, built);
  renderer.camera.zoom = 80; draw(renderer, state);
  assert(renderer.armorPlan.has('panel')); assert.deepEqual(renderer.armorArt.stats, built, 'approaching reuses the close-up art');
});
