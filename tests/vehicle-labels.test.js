import test from 'node:test';
import assert from 'node:assert/strict';
import { Container } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { localToWorld } from '../src/math.ts';
import { sampleScene } from '../src/scene-frame.ts';

function drawing(t) {
  const renderer = new Renderer({}, { mode: 'test' });
  renderer.actorLayerRoot = new Container(); renderer.labels = new Container(); renderer.fxLayer = new Container();
  renderer.labelWidth = () => 180;
  Object.assign(renderer.camera, { width: 1280, height: 720, zoom: 80 });
  t.after(() => {
    renderer.actorLayerRoot.destroy({ children: true }); renderer.labels.destroy({ children: true }); renderer.fxLayer.destroy({ children: true });
    renderer.labelIcons.clear();
  });
  return renderer;
}

function snapshot(time, { speed = 100, angle = 0, elevation = 50 } = {}) {
  const vehicle = { chassisId: 'frame', x: 12 + speed / 3.6 * time, y: elevation + 40 * time - 4.9 * time ** 2, angle },
    roof = localToWorld(vehicle, 0, 3);
  return { time, shared: true, localPlayerId: 'me', controlledActor: 'a',
    faction: { id: 'mine', flag: { field: 'cross', colours: [4, 0, 8], emblem: 'ring' }, known: [] },
    actors: [{ id: 'a', name: 'Blindado', playerName: 'Jogador', color: 0xc7d0a4, team: 'mine', ownerId: 'me', vehicle }],
    plates: [{ id: 'roof', actorId: 'a', definition: { ...roof, angle, length: 6, thicknessMm: 20 } }], modules: [], attachments: [] };
}

function draw(renderer, sample) {
  renderer.scene = sample.scene; renderer.syncActorLayers(sample.state); renderer.drawStructure(sample.state);
  return renderer.actorLayers.get('a');
}

for (const stateHz of [20, 60]) for (const speed of [50, 300]) {
  test(`vehicle names and flags stay with an airborne vehicle at ${speed} km/h with ${stateHz} Hz states`, t => {
    const renderer = drawing(t), playback = renderer.playback, camera = renderer.camera;
    playback.receive(snapshot(0, { speed }), [], { now: 0 });
    const initial = playback.sample(0);
    Object.assign(camera, { x: initial.scene.actor('a').x, y: initial.scene.actor('a').y });
    camera.follow(playback.vehicleAt(initial, 'a'));
    // The name and the flag keep their place over the vehicle on the screen, wherever the view takes it.
    const over = (sample, point) => { const body = sample.scene.actor('a'), at = camera.toScreen(point.x, point.y), under = camera.toScreen(body.x, body.y);
      return { x: at.x - under.x, y: at.y - under.y }; };
    const { label, flag } = draw(renderer, initial), origin = over(initial, label), flown = over(initial, flag);
    let tick = 0, nextReceive = 1000 / stateHz;
    for (let frame = 1; frame <= 330; frame++) {
      const now = frame * 1000 / 165;
      if (now >= nextReceive) {
        playback.receive(snapshot(++tick / stateHz, { speed }), [], { now });
        nextReceive += 1000 / stateHz + (tick % 2 ? 5 : -5);
      }
      const sample = playback.sample(now);
      camera.follow(playback.vehicleAt(sample, 'a')); draw(renderer, sample);
      const text = over(sample, label), banner = over(sample, flag);
      assert(Math.hypot(text.x - origin.x, text.y - origin.y) < 1e-7, `name jumped at display frame ${frame}`);
      assert(Math.hypot(banner.x - flown.x, banner.y - flown.y) < 1e-7, `flag jumped at display frame ${frame}`);
    }
    assert(tick > 30);
  });
}

test('names clear the displayed roof while rotating, including angle wraparound and a free camera', t => {
  const renderer = drawing(t);
  for (const [from, to] of [[-.4, .6], [Math.PI - .05, -Math.PI + .05]]) {
    const before = snapshot(0, { angle: from }), after = snapshot(.05, { angle: to }), original = JSON.stringify(after);
    Object.assign(renderer.camera, { x: after.actors[0].vehicle.x, y: after.actors[0].vehicle.y });
    for (const alpha of [0, .2, .5, .8, 1]) {
      const scene = sampleScene(after, before, alpha), { label, flag } = draw(renderer, { state: after, scene }), roof = scene.pose('roof'),
        top = roof.y + Math.abs(Math.sin(roof.angle)) * 3 + Math.abs(Math.cos(roof.angle)) * .01;
      assert(Math.abs(label.y - Math.max(scene.actor('a').y + 1.9, top) - .45) < 1e-9);
      assert.equal(label.x, scene.actor('a').x);
      assert.equal(flag.x, label.x); assert(Math.abs((flag.y - label.y) * renderer.camera.zoom - 11) < 1e-9);
    }
    assert.equal(JSON.stringify(after), original, 'presentation must not change the simulation snapshot');
  }
});

test('a vehicle below world zero keeps its name above its hull instead of at a fixed altitude', t => {
  const renderer = drawing(t), state = snapshot(0, { elevation: -80 }), scene = sampleScene(state);
  Object.assign(renderer.camera, { x: 12, y: -80 });
  const { label } = draw(renderer, { state, scene });
  assert(label.y < -70 && label.y > -77, 'the name follows the vehicle into a depression');
});
