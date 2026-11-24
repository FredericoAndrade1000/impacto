import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, GpuGraphicsContext, Matrix, buildContextBatches } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { MAIN_WORLD, GHOST_SECONDS, BLIP_SECONDS, SOUND_SECONDS, BATTERY_SECONDS } from '../src/battle-rules.ts';
import { ghostFade, ghostText, contactMarks, watchPulses, batteryText, wreckFade, GHOST_TINT, WATCH_PULSE } from '../src/faction-ui.ts';
import { groundSurfaces } from './helpers/ground-art.js';

test('a ghost is pale and paler with time, and says how long ago it was seen', () => {
  const live = { id: 'a' }, ghost = { id: 'b', ghost: { since: 10 } };
  assert.equal(ghostFade(live, 50), 1); assert.equal(ghostText(live, 50), '');
  assert.equal(ghostFade(ghost, 10), .6); assert(Math.abs(ghostFade(ghost, 10 + GHOST_SECONDS / 2) - .425) < 1e-9);
  assert(Math.abs(ghostFade(ghost, 10 + GHOST_SECONDS) - .25) < 1e-9); assert(Math.abs(ghostFade(ghost, 500) - .25) < 1e-9, 'it never goes out before it is taken away');
  assert.equal(ghostText(ghost, 10.4), ' · visto há 0 s'); assert.equal(ghostText(ghost, 22.9), ' · visto há 12 s'); assert.equal(ghostText(ghost, 9), ' · visto há 0 s');
});

test('what a radar holds and what was heard are marks of the view that go out as they get old', () => {
  const state = { time: 20, actors: [{ id: 'mine', x: 100, vehicle: { x: 104, y: 7 } }, { id: 'post', x: 300, vehicle: null }],
    contacts: [{ id: 'theirs', kind: 'radar', x: 900, y: 12, error: 14, at: 18 }, { kind: 'sound', by: 'mine', side: -1, at: 20 },
      { kind: 'sound', by: 'post', side: 1, at: 18.5 }, { kind: 'sound', by: 'gone', side: 1, at: 20 }, { id: 'near', kind: 'radar', x: 50, y: 3, error: .2, at: 20 - BLIP_SECONDS - 1 }] };
  assert.deepEqual(contactMarks(state), [
    { kind: 'radar', id: 'theirs', x: 900, y: 12, radius: 14, alpha: 1 - 2 / BLIP_SECONDS },
    { kind: 'sound', x: 104, y: 7, side: -1, alpha: 1 },
    { kind: 'sound', x: 300, y: null, side: 1, alpha: 1 - 1.5 / SOUND_SECONDS },
    { kind: 'radar', id: 'near', x: 50, y: 3, radius: 1, alpha: 0 }]);
  assert.deepEqual(contactMarks({ time: 0, actors: [] }), []);
});

test('a gun the base placed by its fire is a mark for as long as it is held, and each word of it shows for a moment, on the mark and on the base', () => {
  const state = { time: 30, actors: [], contacts: [{ id: 'gun', kind: 'battery', x: 6100, error: 92, at: 29.5, by: 'radar' }, { id: 'old', kind: 'battery', x: -4000, error: .4, at: 30 - BATTERY_SECONDS, by: 'sound' }] };
  assert.deepEqual(contactMarks(state), [
    { kind: 'battery', id: 'gun', x: 6100, y: null, radius: 92, alpha: .4 + .6 * (1 - .5 / BATTERY_SECONDS), pulse: .5 / WATCH_PULSE, by: 'radar' },
    { kind: 'battery', id: 'old', x: -4000, y: null, radius: 1, alpha: .4, pulse: 1, by: 'sound' }]);
  // The frame shows a time a little behind that of its state: the mark is as old as the frame has it, and never younger than new.
  assert.deepEqual(contactMarks(state, 29.5).map(mark => [mark.alpha, mark.pulse]), [[1, 0], [.4 + .6 * .5 / BATTERY_SECONDS, 1]]);
  assert.deepEqual(contactMarks(state, 29).map(mark => mark.pulse), [0, 1]);
  // A gun placed firing from the air is marked as high as it was placed, not over the ground under it.
  assert.equal(contactMarks({ time: 30, actors: [], contacts: [{ id: 'air', kind: 'battery', x: 500, y: 1800, error: 40, at: 30, by: 'radar' }] })[0].y, 1800);
  // On the base: the words it has just had, each with the side the gun is on.
  assert.deepEqual(watchPulses(state, 500), [{ by: 'radar', side: 1, age: .5 / WATCH_PULSE }]); assert.deepEqual(watchPulses(state, 9000, 29.5), [{ by: 'radar', side: -1, age: 0 }]);
  assert.deepEqual(watchPulses(state, 500, 29.5 + WATCH_PULSE + .01), []); assert.deepEqual(watchPulses({ time: 0, actors: [] }, 0), []);
  assert.deepEqual(watchPulses({ time: 30 - BATTERY_SECONDS + .7, actors: [], contacts: state.contacts.slice(1) }, -5000).map(pulse => [pulse.by, pulse.side]), [['sound', 1]]);
  assert.equal(batteryText({ x: 6100, error: 92 }, 0), 'a 6,1 km → da base (±92 m)'); assert.equal(batteryText({ x: -310, error: 60 }, 500), 'a 810 m ← da base (±60 m)');
});

// Where a drawing shows its numbers, in the frame of the world: each taken through the place of the drawing.
function places(node, root) {
  const gpu = new GpuGraphicsContext(), matrix = new Matrix(), out = []; buildContextBatches(node.context, gpu);
  for (let at = node; at && at !== root; at = at.parent) { at.updateLocalTransform(); matrix.prepend(at.localTransform); }
  const numbers = gpu.geometryData.vertices;
  for (let i = 0; i < numbers.length; i += 2) out.push({ x: matrix.a * numbers[i] + matrix.c * numbers[i + 1] + matrix.tx, y: matrix.b * numbers[i] + matrix.d * numbers[i + 1] + matrix.ty, own: Math.max(Math.abs(numbers[i]), Math.abs(numbers[i + 1])) });
  return out;
}

test('the renderer draws a ghost pale where it stands, and the marks of the view from its camera', async t => {
  await initNativeDynamics();
  const SITE = 125000, ZOOM = 6, WIDTH = 1280, HEIGHT = 720, blueprint = createConstruction('recon'); blueprint.terrain = MAIN_WORLD.terrain;
  const world = new World(blueprint, { scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } }); t.after(() => world.dispose());
  world.replaceActor(world.construction, { id: 'local', ownerId: 'me', team: 'mine', x: SITE, facing: -1 });
  world.addActor(world.construction, { id: 'seen', ownerId: 'you', team: 'yours', x: SITE - 40, facing: 1, playerName: 'Bob' });
  world.addActor(world.construction, { id: 'lost', ownerId: 'you', team: 'yours', x: SITE - 70, facing: 1, playerName: 'Bob' });
  const view = { mode: 'test', testTool: 'fire', weapon: { platform: 'vehicle' }, aim: { x: SITE - 30, y: world.terrain.height(SITE - 30) + 5 } },
    renderer = new Renderer({ clientWidth: WIDTH, clientHeight: HEIGHT }, view), camera = renderer.camera;
  renderer.app = { stage: new Container(), renderer: { render() {}, resize() {}, backBuffer: { useBackBuffer: false } } };
  renderer.buildScene(groundSurfaces());
  let now = 0;
  const MINE = { field: 'cross', colours: [4, 0, 8], emblem: 'ring' }, YOURS = { field: 'canton', colours: [7, 2, 0], emblem: 'star' };
  const frame = contacts => {
    world.step();
    const state = world.snapshot(), time = state.time;
    Object.assign(state, { shared: true, localPlayerId: 'me', controlledActor: 'local', faction: { id: 'mine', flag: MINE, known: [{ id: 'yours', flag: YOURS }], base: { x: SITE + 60, radius: 100, facing: 1 } },
      players: [{ id: 'me', connected: true, factionId: 'mine' }, { id: 'you', connected: true, factionId: 'yours' }], contacts: contacts(time) });
    // The construction that was lost is told as a ghost, seen twelve seconds ago.
    state.actors = state.actors.map(a => a.id === 'lost' ? { ...a, ghost: { since: time - 12.3 } } : a);
    Object.assign(camera, { x: world.actor('local').vehicle.x - 30, y: world.actor('local').vehicle.y + 6, zoom: ZOOM });
    renderer.receive(state, world.drainEvents(), { now }); renderer.draw({ now }); now += 1000 / 60;
    return state;
  };
  const height = x => world.terrain.height(x) + 4, blip = { id: 'far', kind: 'radar', x: SITE - 90, y: height(SITE - 90), error: 9 }, away = { id: 'away', kind: 'radar', x: SITE - 1200, y: height(SITE - 1200), error: 15 };
  let state;
  for (let i = 0; i < 20; i++) state = frame(() => []);
  const before = places(renderer.overlay, renderer.world).length;
  // Contacts enter and leave on the same buffered remote clock as the constructions.
  for (let i = 0; i < 8; i++) state = frame(time => [{ ...blip, at: time - 1 }, { ...away, at: time }, { kind: 'sound', by: 'local', side: -1, at: time }]);
  // The ghost is its construction, pale and of another colour; the one in sight is whole. The label of the ghost says since when.
  const layers = id => renderer.actorLayers.get(id), ghost = state.actors.find(a => a.id === 'lost');
  assert.equal(layers('lost').container.alpha, ghostFade(ghost, state.time)); assert(layers('lost').container.alpha < .6 && layers('lost').container.alpha > .4);
  assert.equal(layers('lost').chassis.tint, GHOST_TINT); assert.equal(layers('seen').container.alpha, 1); assert.equal(layers('seen').chassis.tint, 0xffffff);
  assert.equal(layers('lost').label.text, 'Bob\nvisto há 12 s'); assert.equal(layers('seen').label.text, 'Bob');
  assert(layers('lost').label.content.chips.length > 0 && layers('seen').label.content.chips.length > 0, 'public pieces supply compact role icons without repeating full design names');
  assert(layers('lost').label.alpha < layers('seen').label.alpha); assert.equal(wreckFade(ghost, state.time), 1);
  // Over its label each flies the flag of its faction — one drawing for all of a faction's —, fifteen pixels wide, as pale as the label under it.
  assert.equal(layers('local').flag.context, renderer.flagArt(MINE)); assert.notEqual(renderer.flagArt(MINE), renderer.flagArt(YOURS));
  for (const id of ['seen', 'lost']) {
    const { flag, label } = layers(id);
    assert.equal(flag.context, renderer.flagArt(YOURS)); assert.deepEqual([flag.visible, flag.alpha, flag.x], [label.visible, label.alpha, label.x]);
    assert(Math.abs(flag.scale.x * ZOOM - 15) < 1e-9 && flag.scale.y === flag.scale.x); assert(Math.abs((flag.y - label.y) * ZOOM - 11) < 1e-9, 'just over the compact label and role icon');
  }
  assert.equal(renderer.labels.children.filter(child => child instanceof Graphics).length, 3);
  // The marks: a ring as wide as the radar may be off about its place, and arcs to the left of the construction that heard.
  const drawn = places(renderer.overlay, renderer.world), near = (x, y, reach) => drawn.filter(p => Math.hypot(p.x - x, p.y - y) <= reach);
  assert(drawn.length > before + 100, `${drawn.length - before} vertices of marks`);
  assert(drawn.some(p => Math.abs(Math.hypot(p.x - blip.x, p.y - blip.y) - blip.error) < .3), 'the ring of the radar mark');
  assert(near(blip.x, blip.y, 1.5).length > 3, 'and its lozenge');
  const self = world.actor('local').vehicle, arcs = drawn.filter(p => p.x < self.x - 4 && p.x > self.x - 12 && Math.abs(p.y - self.y - 1.5) < 5);
  assert(arcs.length > 20 && !drawn.some(p => p.x > self.x + 4.5 && p.x < self.x + 12 && Math.abs(p.y - self.y - 1.5) < 3 && Math.hypot(p.x - view.aim.x, p.y - view.aim.y) > 20), 'the arcs are on the side the sound came from');
  // A mark out of the view is not drawn: nothing of the drawing is a number of more than the view and the aim.
  assert.equal(near(away.x, away.y, 60).length, 0);
  assert(Math.max(...drawn.map(p => p.own)) < 300 + WIDTH / ZOOM, 'the drawing is counted from its camera');
  // With nothing held, nothing is drawn of it.
  for (let i = 0; i < 8; i++) frame(() => []);
  assert(places(renderer.overlay, renderer.world).length < drawn.length - 100);
});
