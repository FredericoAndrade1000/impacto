import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanvasControls } from '../src/canvas-controls.ts';
import { Camera, FramedCamera } from '../src/camera.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { FramePresentation } from '../src/presentation.ts';
import { FrameBudget } from '../src/performance.ts';
import { sceneFrame, sampleScene, designFrame } from '../src/scene-frame.ts';
import { Terrain } from '../src/terrain.ts';
import { groundView } from '../src/terrain-art.ts';
import { Container, Graphics, Texture } from 'pixi.js';
import { countingCanvas } from './scenery-canvas.js';

test('revealing an occluded selection preserves zoom, mirrors the pan and leaves an already clear view alone', () => {
  for (const mirror of [false, true]) {
    const world = new Camera(1000, 600), camera = new FramedCamera(world, () => ({ x: -100519, y: 550, mirror }), 12),
      cover = { left: 160, right: 300, top: 80, bottom: 50 };
    world.cover = () => cover; camera.x = 12; camera.y = 2; camera.zoom = 100;
    const points = [[780, 120], [900, 120], [900, 210], [780, 210]].map(([x, y]) => camera.toWorld(x, y)), zoom = camera.zoom;
    camera.reveal(points);
    for (const point of points) {
      const p = camera.toScreen(point.x, point.y);
      assert(p.x >= cover.left + 12 - 1e-6 && p.x <= camera.width - cover.right - 12 + 1e-6);
      assert(p.y >= cover.top + 12 - 1e-6 && p.y <= camera.height - cover.bottom - 12 + 1e-6);
    }
    assert.equal(camera.zoom, zoom);
    const still = { ...world.asked }; camera.reveal(points); assert.deepEqual(world.asked, still);
    const oversized = [[-300, 240], [1300, 300]].map(([x, y]) => camera.toWorld(x, y));
    camera.reveal(oversized);
    const ends = oversized.map(p => camera.toScreen(p.x, p.y)), center = (ends[0].x + ends[1].x) / 2;
    assert(Math.abs(center - (cover.left + camera.width - cover.right) / 2) < 1e-6);
    assert.equal(camera.zoom, zoom, 'oversized selection stays detailed instead of silently zooming out');
  }
});

test('zoom and pan preserve accurate editor coordinates', () => {
  const camera = new Camera(1000, 650), before = camera.toWorld(260, 350);
  camera.zoomAt(2.7, 260, 350); const after = camera.toWorld(260, 350);
  assert(Math.hypot(before.x - after.x, before.y - after.y) < 1e-10);
  camera.pan(80, -60); const screen = camera.toScreen(12.2, 1.25), point = camera.toWorld(screen.x, screen.y);
  assert(Math.hypot(point.x - 12.2, point.y - 1.25) < 1e-10);
});
test('fit puts the complete target and the ground under it inside the field', async () => {
  await initNativeDynamics();
  const { createConstruction } = await import('../src/construction-templates.ts');
  const camera = new Camera(1000, 600), blueprint = compileBlueprint(createConstruction('heavy')); camera.fit(blueprint);
  for (const point of [...blueprint.plates, ...blueprint.plates.map(plate => ({ x: plate.x, y: 0 }))]) { const p = camera.toScreen(point.x, point.y); assert(p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 600); }
});

test('a framing keeps clear of what the panels over the field cover of each of its sides', async () => {
  await initNativeDynamics();
  const { createConstruction } = await import('../src/construction-templates.ts');
  const open = new Camera(1000, 600), covered = new Camera(1000, 600), blueprint = compileBlueprint(createConstruction('heavy'));
  covered.cover = () => ({ top: 180, bottom: 90, left: 300, right: 0 });
  open.fit(blueprint, true); covered.fit(blueprint, true);
  const span = camera => blueprint.plates.map(p => camera.toScreen(p.x, p.y).y), wide = camera => blueprint.plates.map(p => camera.toScreen(p.x, p.y).x);
  assert(covered.zoom < open.zoom, 'the band left free is lower than the view');
  assert(Math.min(...span(covered)) > 180 && Math.max(...span(covered)) < 600 - 90, 'the target stands between the two');
  assert(Math.min(...wide(covered)) > 300, 'and beside the side panel');
  // In the middle of that band, as it stands in the middle of an open view.
  const middle = camera => (Math.min(...span(camera)) + Math.max(...span(camera))) / 2;
  assert(Math.abs(middle(covered) - (180 + 600 - 90) / 2 - (middle(open) - 300) * covered.zoom / open.zoom) < 1e-6);
  const centre = camera => (Math.min(...wide(camera)) + Math.max(...wide(camera))) / 2;
  assert(Math.abs(centre(covered) - (300 + 1000) / 2 - (centre(open) - 500) * covered.zoom / open.zoom) < 1e-6);
  covered.minZoom = .4; covered.fitFlight([{ x: -100, y: 2 }, { x: -40, y: 35 }, { x: 12, y: 2 }]);
  assert(covered.toScreen(-40, 35).y > 180 && covered.toScreen(-100, 2).x > 300, 'a flight framed keeps clear of them as well');
});

// A world 2 km long whose earth goes 300 m down, seen through a view of 1000 × 500 pixels.
function confined() {
  const camera = new Camera(1000, 500); camera.minZoom = .4; camera.limits = { minX: -500, maxX: 1500, minY: -300 };
  return { camera, seen: () => ({ left: camera.toWorld(0, 0).x, right: camera.toWorld(1000, 0).x, bottom: camera.toWorld(0, 500).y }) };
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a pan or a camera sent anywhere stops at the ends of the ground and at the foot of the earth', () => {
  const { camera, seen } = confined();
  camera.zoom = 10; camera.x = 1400; camera.y = 20;
  assert.equal(camera.x, 1400, 'a view inside the world is the one asked for');
  camera.pan(-100000, 0); assert(near(seen().right, 1500)); assert.equal(camera.x, 1450);
  camera.pan(100, 0); assert.equal(camera.x, 1440, 'a pan starts from the view that is shown, not from the one that was refused');
  camera.pan(100000, -100000); assert(near(seen().left, -500)); assert(near(seen().bottom, -300));
  const screen = camera.toScreen(-480, -290), point = camera.toWorld(screen.x, screen.y);
  assert(Math.hypot(point.x + 480, point.y + 290) < 1e-9, 'the pointer still names the place under it');
  // Whichever of place and zoom is written first, the view is the nearest one to both.
  for (const write of [c => { c.x = 5000; c.y = -5000; c.zoom = 20; }, c => { c.zoom = 20; c.y = -5000; c.x = 5000; }]) {
    const { camera, seen } = confined(); write(camera);
    assert.equal(camera.zoom, 20); assert(near(seen().right, 1500)); assert(near(seen().bottom, -300));
    camera.zoom = 100; camera.x = 700; camera.y = 3;
    assert.deepEqual([camera.x, camera.y, camera.zoom], [700, 3, 100], 'a view refused earlier does not hold a later one back');
  }
  camera.y = 1e6; assert.equal(camera.y, 1e6, 'the sky has no end');
});

test('the view is never wider than the ground: zooming out stops at the whole world, in the middle of it', () => {
  const { camera, seen } = confined();
  camera.zoom = 10; camera.x = 1200; camera.y = 40;
  for (let i = 0; i < 80; i++) camera.zoomAt(1 / 1.3, 900, 100);
  assert.equal(camera.zoom, .5); assert.equal(camera.minZoom, .5); assert.equal(camera.x, 500);
  assert(near(seen().left, -500) && near(seen().right, 1500));
  camera.zoom = .01; assert.equal(camera.zoom, .5, 'a zoom written directly is held the same way');
  // A framing asks for no more than the world has, and a wider window sees no farther.
  camera.fitFlight([{ x: -400, y: 0 }, { x: 500, y: 2500 }, { x: 1400, y: 0 }]);
  assert.equal(camera.zoom, .5);
  camera.fitFlight([{ x: 1300, y: 0 }, { x: 1900, y: 120 }, { x: 2500, y: 0 }]);
  assert(near(seen().right, 1500), 'what lies past the end is not shown');
  camera.zoom = .5; camera.width = 1600; assert.equal(camera.minZoom, .8); assert.equal(camera.zoom, .8);
  // A long world leaves the mode its own limit; no world, no limit but the mode's.
  camera.width = 1000; camera.limits = { minX: -32000, maxX: 32000, minY: -4060 }; assert.equal(camera.minZoom, .4);
  camera.limits = null; camera.zoom = .01; camera.x = 1e7; assert.deepEqual([camera.x, camera.zoom, camera.minZoom], [1e7, .01, .4]);
});

test('a followed vehicle that drives to the end of the world comes back to its place in the view', () => {
  const { camera, seen } = confined(); let time = 0;
  const drive = x => { camera.follow({ id: 'a', x, y: 1, time: time++ }); return camera.x; };
  camera.zoom = 10; camera.x = 1300; camera.y = 5; drive(1300);
  assert.equal(drive(1400), 1400, 'the vehicle stays in the middle while there is ground to show');
  assert.equal(drive(1480), 1450); assert(near(seen().right, 1500));
  assert.equal(drive(1460), 1450, 'held at the end, the camera waits for the vehicle');
  assert.equal(drive(1440), 1440); assert.equal(drive(1300), 1300);
  // A pan made while held is kept from there on, like any other.
  drive(1490); camera.pan(200, 0); assert.equal(camera.x, 1430);
  assert.equal(drive(1480), 1420); assert.equal(drive(1390), 1330);
});

test('a view may show a landscape between its ends, a test track as far as its ground is drawn, and the earth to its foot', async () => {
  await initNativeDynamics();
  const { createConstruction } = await import('../src/construction-templates.ts');
  const world = new Terrain('world', { length: 16000, center: 12 }), flat = new Terrain('flat'), bench = new Camera(1400, 650);
  assert.deepEqual(groundView(world), { minX: world.minX, maxX: world.maxX, minY: -4060 });
  assert.deepEqual(groundView(flat), { minX: -1600, maxX: 1600, minY: -4060 });
  // The bench frames its longest range, and a flight to the ceiling of its rounds, as it does with no limits.
  const free = new Camera(1400, 650), flight = [{ x: -238, y: 1.4 }, { x: -110, y: 1000 }, { x: 12, y: 1 }],
    target = compileBlueprint(createConstruction('heavy'));
  bench.limits = groundView(flat);
  for (const camera of [bench, free]) { camera.minZoom = .4; camera.fitFlight(flight, target); camera.zoomAt(1 / 1.3); camera.pan(-100, 120); }
  assert(bench.zoom < .5); assert.deepEqual([bench.x, bench.y, bench.zoom], [free.x, free.y, free.zoom]);
});

test('fitting a battle on elevated ground keeps the same framing after a rigid scene translation', async () => {
  await initNativeDynamics();
  const { createConstruction } = await import('../src/construction-templates.ts');
  const original = compileBlueprint(createConstruction('heavy')), shifted = structuredClone(original);
  for (const object of [...shifted.plates, ...shifted.modules, shifted.launcher]) { object.x += 450; object.y += 25; }
  const a = new Camera(1000, 600), b = new Camera(1000, 600);
  a.fit(original, true); b.fit(shifted, true);
  assert(Math.abs(a.zoom - b.zoom) < 1e-12);
  assert(Math.abs(b.x - a.x - 450) < 1e-12); assert(Math.abs(b.y - a.y - 25) < 1e-12);
  for (const point of shifted.plates.flatMap(p => [
    { x: p.x - Math.cos(p.angle) * p.length / 2, y: p.y - Math.sin(p.angle) * p.length / 2 },
    { x: p.x + Math.cos(p.angle) * p.length / 2, y: p.y + Math.sin(p.angle) * p.length / 2 },
  ])) {
    const screen = b.toScreen(point.x, point.y);
    assert(screen.x >= 0 && screen.x <= b.width && screen.y >= 0 && screen.y <= b.height);
  }
  const path = [{ x: -100, y: 2 }, { x: -40, y: 35 }, { x: 12, y: 2 }];
  a.minZoom = b.minZoom = .4; a.fitFlight(path, original);
  b.fitFlight(path.map(p => ({ x: p.x + 450, y: p.y + 25 })), shifted);
  assert(Math.abs(a.zoom - b.zoom) < 1e-12); assert(Math.abs(b.y - a.y - 25) < 1e-12);
});

test('scene admission shares identities and one pose without copying or changing a physical frame', () => {
  const gun = { id: 'gun', actorId: 'local', kind: 'weapon', x: 5, y: 2, angle: 0, barrelAngle: Math.PI - .1 },
    before = { time: 0, actors: [{ id: 'local', vehicle: { x: 2, y: 1, travel: 0, chassisId: 'chassis' } }], modules: [gun] },
    after = { time: .1, actors: [{ id: 'local', vehicle: { x: 4, y: 1, travel: 2, chassisId: 'chassis' } }],
      modules: [{ ...gun, x: 7, barrelAngle: -Math.PI + .1 }] };
  const original = JSON.stringify(after), frame = sceneFrame(after), sample = sampleScene(after, before, .5);
  assert.equal(sceneFrame(after), frame); assert.equal(frame.get('gun'), after.modules[0]);
  assert.equal(sample.pose('gun'), sample.pose('gun')); assert.equal(sample.pose('gun').x, 6);
  assert(Math.abs(sample.pose('gun').barrelAngle - Math.PI) < 1e-10);
  assert.equal(sample.actor('local').x, 3); assert.equal(sample.actor('local').travel, 1);
  assert.equal(JSON.stringify(after), original, 'admission and sampling never mutate solver records');
});

test('one drawable registry presents editor, installed running gear and region damage without changing the base mesh', async t => {
  await initNativeDynamics();
  const [{ createConstruction }, { World }, { Renderer }] = await Promise.all([
    import('../src/construction-templates.ts'), import('../src/physics.ts'), import('../src/render.ts'),
  ]);
  countingCanvas(t);
  const blueprint = createConstruction('heavy'), world = new World(blueprint), renderer = new Renderer({});
  renderer.actorLayerRoot = new Container(); renderer.shadows = new Graphics(); renderer.ground = new Terrain('flat');
  renderer.moduleTexture = renderer.getTexture = () => Texture.EMPTY;
  t.after(() => { for (const item of renderer.drawables.values()) { item.group.destroy({ children: true }); item.geometry.destroy(); }
    renderer.actorLayerRoot.destroy({ children: true }); renderer.shadows.destroy(); world.dispose(); });
  function draw(state, previous = null, alpha = 1) {
    renderer.scene = sampleScene(state, previous, alpha); renderer.syncActorLayers(state); renderer.drawSurfaces();
  }
  const design = designFrame(compileBlueprint(blueprint)); draw(design);
  const designTrack = design.modules.find(module => module.kind === 'track'), editorItem = renderer.drawables.get(designTrack.id);
  assert(editorItem.trackDetails.wheels.length > 2);
  // The floor over the frame (`chassis:top-*`) is painted with it too.
  const framePlates = design.plates.filter(plate => plate.definition.chassis),
    frameIds = new Set([...framePlates, ...design.plates.filter(plate => /^chassis:top-\d+$/.test(plate.id))].map(plate => plate.id));
  assert(framePlates.length >= 2, 'generated chassis plates remain in the physical frame');
  for (const plate of framePlates) {
    assert.equal(renderer.scene.frame.byId.get(plate.id).data, plate);
    assert(!renderer.drawables.has(plate.id), 'the dedicated chassis picture replaces only its second material mesh');
  }
  assert.deepEqual([...renderer.drawables.keys()].sort(), renderer.scene.frame.surfaces.filter(surface => !frameIds.has(surface.id)).map(surface => surface.id).sort());
  const state = world.snapshot(); draw(state);
  assert.equal(editorItem.group.destroyed, false, 'installed gear retains the same identity and registry');
  const module = state.modules.find(module => module.kind === 'track'), casing = renderer.drawables.get(module.id);
  assert(casing.trackDetails.wheels.length > 2, 'native and editor tracks use the same presenter');
  assert.equal(casing.group.x, module.x); assert.equal(casing.group.y, module.y);
  assert.equal(renderer.scene.frame.byId.get(module.id).type, 'module');
  assert.equal(casing.group.parent, renderer.actorLayer(module.actorId, 'runningGearLayer'));
  const damaged = structuredClone(state); damaged.modules.find(m => m.id === module.id).health = 0;
  draw(damaged); assert.equal(casing.group.destroyed, false, 'functional damage preserves the same casing drawable');
  assert.equal(casing.group.parent, renderer.actorLayer(module.actorId, 'runningGearLayer'));
  const cut = structuredClone(state), plate = cut.plates.find(plate => !plate.definition.chassis),
    originalPlate = state.plates.find(original => original.id === plate.id), oldShape = renderer.drawables.get(plate.id).data;
  plate.solidRegions = plate.solidRegions.map(r => ({ ...r, maxX: (r.minX + r.maxX) / 2 })); plate.revision++;
  draw(cut, state, .5);
  const drawable = renderer.drawables.get(plate.id), clipped = renderer.armorPlan.get(plate.id).geometry;
  assert.notEqual(drawable.data, oldShape); assert.deepEqual(drawable.positions, clipped.positions);
  assert.deepEqual(drawable.geometry.uvs, clipped.uvs); assert.deepEqual(plate.definition, originalPlate.definition);
  const empty = { ...cut, plates: [], modules: [] }; draw(empty);
  assert.equal(renderer.drawables.size, 0, 'removed geometry has no second sprite or gear registry to retain it');
});

// A vehicle driven at `speedKmh` over `ground`, its chassis `over(t)` above it, told in states of `stateHz` (with
// jitter) to a 165 Hz display, the camera following it. Each frame drawn: where the chassis and the ground under it are
// on the screen, and how high the chassis is in the world.
function followDrive({ stateHz, speedKmh, ground, over, seconds = 2 }) {
  const camera = new Camera(1000, 650), playback = new FramePresentation(), budget = new FrameBudget(), frames = [];
  camera.zoom = 250;
  const state = tick => {
    const time = tick / stateHz, x = 12 - speedKmh / 3.6 * time;
    return { time, tick, actors: [{ id: 'local', vehicle: { chassisId: 'chassis', x, y: ground.height(x) + over(time) } }] };
  };
  playback.receive(state(0), [], { now: 0 });
  camera.x = 12; camera.y = ground.height(12) + over(0); camera.follow(playback.vehicleAt(playback.sample(0)), ground);
  let tick = 0, nextReceive = 1000 / stateHz;
  for (let i = 1; i <= seconds * 165; i++) {
    const now = i * 1000 / 165;
    if (now >= nextReceive) {
      playback.receive(state(++tick), [], { now });
      // Include delivery jitter instead of assuming perfectly spaced snapshots.
      nextReceive += 1000 / stateHz + (tick % 2 ? 5 : -5);
    }
    if (!budget.take(now)) continue;
    // The chassis as the frame draws it, by the pose of the frame.
    const sample = playback.sample(now), body = sample.scene.actor('local');
    camera.follow(playback.vehicleAt(sample), ground);
    const chassis = camera.toScreen(body.x, body.y);
    frames.push({ now, x: chassis.x, y: chassis.y, ground: camera.toScreen(body.x, ground.height(body.x)).y, height: body.y });
  }
  assert(frames.length >= seconds * 59 && tick > seconds * stateHz - 2);
  return frames;
}
const spread = values => Math.max(...values) - Math.min(...values);

for (const stateHz of [20, 60]) for (const speedKmh of [50, 100]) {
  test(`following at ${speedKmh} km/h with ${stateHz} Hz states and a 165 Hz display, the chassis rocks over a ground that holds still`, () => {
    // The hull bounces on its springs at about 1 Hz and the bumps under the wheels shake it at 6 Hz (2–15 cm, rock the
    // most): neither is the view's to follow. Along the ground the chassis keeps its place in the view.
    const frames = followDrive({ stateHz, speedKmh, ground: { height: () => 0 },
      over: t => 1.3 + .03 * Math.sin(2 * Math.PI * .9 * t) + .01 * Math.sin(2 * Math.PI * 6 * t) });
    for (const frame of frames) assert(Math.abs(frame.x - 500) < 1e-8, 'along the ground the view goes with the chassis as it is');
    const rocks = spread(frames.map(f => f.height)) * 250, shown = spread(frames.map(f => f.y)), ground = spread(frames.map(f => f.ground));
    assert(shown > .6 * rocks, `the chassis rocks ${shown.toFixed(1)} px on the screen of ${rocks.toFixed(1)} px`);
    assert(ground < .3 * rocks, `the ground moves ${ground.toFixed(1)} px on the screen as the chassis rocks ${rocks.toFixed(1)} px`);
    // The view goes on smoothly across the states: no jolt of the ground where one state takes over from another.
    const speed = (a, b) => (b.ground - a.ground) / (b.now - a.now) * 1000,
      jolts = frames.slice(2).map((f, i) => Math.abs(speed(frames[i + 1], f) - speed(frames[i], frames[i + 1])));
    assert(Math.max(...jolts) < 10, `the ground jolts by ${Math.max(...jolts).toFixed(2)} px/s from one frame to the next`);
  });
}

test('up a slope and over its crest the view goes with the ground at once: the chassis keeps its place in the view', () => {
  // Level to x = 0, 8 m easing into a grade of 20 % towards −X for 30 m, 8 m easing onto a level top.
  const grade = .2, ease = 8, run = 30,
    rise = u => u <= 0 ? 0 : u < ease ? grade * u * u / (2 * ease) : u < ease + run ? grade * (u - ease / 2) :
      u < 2 * ease + run ? grade * (ease / 2 + run + (u - ease - run) - (u - ease - run) ** 2 / (2 * ease)) : grade * (ease + run),
    ground = { height: x => rise(-x) };
  for (const stateHz of [20, 60]) {
    const frames = followDrive({ stateHz, speedKmh: 60, ground, over: t => 1.3 + .01 * Math.sin(2 * Math.PI * 6 * t), seconds: 4 });
    assert(spread(frames.map(f => f.height)) > 7.5, 'the vehicle climbed the whole slope');
    // Followed by a spring alone, the view would come 2 m behind at 60 km/h up a grade of 20 %.
    const off = Math.max(...frames.map(f => Math.abs(f.y - frames[0].y))) / 250;
    assert(off < .04, `the chassis left its place in the view by ${(off * 100).toFixed(1)} cm`);
  }
});

test('a vehicle that climbs or sinks in the air keeps its place in the view; the same climb on wheels is eased', () => {
  // Level ground; at 60 Hz the vehicle climbs at 6 m/s for 3 s, holds 1 s and sinks at 3 m/s for 2 s.
  const height = t => 2 + 6 * Math.min(t, 3) - 3 * Math.max(0, Math.min(t - 4, 2)),
    off = flying => {
      const camera = new Camera(1000, 800); camera.zoom = 150; camera.y = height(0);
      let most = 0;
      for (let i = 0; i <= 6 * 60; i++) {
        const t = i / 60; camera.follow({ id: 'a', x: 0, y: height(t), time: t, flying }, { height: () => 0 });
        most = Math.max(most, Math.abs(camera.y - height(t)));
      }
      return most;
    };
  // A spring alone lags twice its ease behind a steady climb: 3.6 m at 6 m/s, out of a view 5.3 m high at this zoom.
  assert(off(false) > 3, `on wheels the view came ${off(false).toFixed(2)} m behind`);
  assert(off(true) < .05, `in the air the vehicle left its place in the view by ${(off(true) * 100).toFixed(1)} cm`);
});

test('following preserves manual pan/zoom and restarts cleanly after deselection, reset and target changes', () => {
  const camera = new Camera(), pose = (x, id = 'a', time = x) => ({ x, y: 1.3, id, time });
  camera.follow(pose(12)); camera.follow(pose(13)); camera.pan(90, -40); camera.zoomAt(1.8, 200, 260);
  const before = camera.toScreen(13, 1.3);
  camera.follow(pose(14)); const after = camera.toScreen(14, 1.3);
  assert(Math.hypot(after.x - before.x, after.y - before.y) < 1e-10);
  for (const action of [() => { camera.follow(null); camera.follow(pose(100)); },
    () => camera.follow(pose(-50, 'b', 101)), () => camera.follow(pose(12, 'b', 0))]) {
    const x = camera.x, y = camera.y; action(); assert.equal(camera.x, x); assert.equal(camera.y, y);
  }
});

test('following keeps a wheel close-up moving even with the vehicle centre outside the view', () => {
  const camera = new Camera(1000, 500); camera.zoom = 65; camera.x = 100; camera.y = 4;
  const pose = (x, time) => ({ id: 'a', x, y: 4, time });
  camera.follow(pose(100, 0));
  const wheel = { x: 103, y: 1 }, cursor = camera.toScreen(wheel.x, wheel.y),
    still = point => Math.hypot(point.x - cursor.x, point.y - cursor.y) < 1e-6;
  camera.zoomBy(100, cursor.x, cursor.y);
  assert.equal(camera.zoom, 650, 'the normal zoom ceiling still applies');
  assert(still(camera.toScreen(wheel.x, wheel.y)));
  const centre = camera.toScreen(100, 4);
  assert(centre.x < 0 && centre.y < 0, 'the centre is outside both axes of the close-up');
  for (let step = 1; step <= 30; step++) {
    const dx = step * .5;
    camera.follow(pose(100 + dx, step / 60));
    assert(still(camera.toScreen(wheel.x + dx, wheel.y)), 'each moving frame holds the wheel under the cursor');
  }
  camera.pan(10000, -5000); const panned = { x: camera.x, y: camera.y };
  camera.follow(pose(116, 1));
  assert(Math.abs(camera.x - panned.x - 1) < 1e-9); assert.equal(camera.y, panned.y);
  camera.follow(null); const released = { ...camera.asked };
  camera.follow(pose(500, 2));
  assert.deepEqual(camera.asked, released, 'an explicit release starts a new baseline without a jump');
});

test('a followed camera zooms about the cursor and keeps that offset as the vehicle moves', () => {
  const camera = new Camera(1000, 500); camera.zoom = 20; camera.x = 100; camera.y = 5;
  let time = 0; const drive = x => camera.follow({ id: 'a', x, y: 4, time: time++ });
  drive(100); camera.pan(-180, 60); drive(100);
  const cursor = { x: 280, y: 350 }, detail = camera.toWorld(cursor.x, cursor.y), before = camera.toScreen(100, 4),
    still = point => Math.hypot(point.x - cursor.x, point.y - cursor.y) < 1e-6;
  for (let i = 0; i < 4; i++) {
    camera.zoomBy(1.6, cursor.x, cursor.y);
    assert(still(camera.toScreen(detail.x, detail.y)), 'the detail under the cursor stays there');
  }
  const place = camera.toScreen(100, 4);
  assert(camera.zoom > 130);
  assert(Math.hypot(place.x - before.x, place.y - before.y) > 100, 'zoom no longer anchors the vehicle centre');
  drive(103);
  assert(still(camera.toScreen(detail.x + 3, detail.y)), 'following translates the detail with the vehicle');
  assert(Math.hypot(camera.toScreen(103, 4).x - place.x, camera.toScreen(103, 4).y - place.y) < 1e-6);
  for (let i = 0; i < 12; i++) camera.zoomBy(1 / 1.6, cursor.x, cursor.y);
  assert.equal(camera.zoom, camera.minZoom); assert(still(camera.toScreen(detail.x + 3, detail.y)));
  camera.follow(null); const under = camera.toWorld(990, 490);
  camera.zoomBy(1.6, 990, 490); const after = camera.toWorld(990, 490);
  assert(Math.hypot(after.x - under.x, after.y - under.y) < 1e-9, 'a free camera keeps the same cursor behavior');
});

test('the wheel and two fingers zoom the followed field about the cursor and touch midpoint (main.ts)', async () => {
  const camera = new Camera(1000, 500), listeners = {}, touch = {};
  const canvas = { addEventListener: (type, listener) => { listeners[type] = listener; }, getBoundingClientRect: () => ({ left: 20, top: 30 }) };
  const document = { querySelector: selector => { assert.equal(selector, '#new-module-settings'); return { addEventListener() {} }; } };
  createCanvasControls({ document, renderer: { canvas, camera, board: { camera } },
    touch: options => Object.assign(touch, options), effects: {} }).install();
  camera.zoom = 20; camera.x = 100; camera.y = 5; camera.follow({ id: 'a', x: 96, y: 4, time: 0 });
  const cursor = { x: 420, y: 290 }, detail = camera.toWorld(cursor.x, cursor.y),
    still = (point, at) => Math.hypot(point.x - at.x, point.y - at.y) < 1e-6;
  for (let i = 0; i < 4; i++) {
    listeners.wheel({ deltaY: -400, clientX: cursor.x + 20, clientY: cursor.y + 30, preventDefault() {} });
    assert(still(camera.toScreen(detail.x, detail.y), cursor), 'wheel coordinates are relative to the canvas');
  }
  assert(camera.zoom > 200);
  const fingers = { x: 440, y: 280 }, under = camera.toWorld(fingers.x, fingers.y);
  touch.zoom(1 / 3, fingers.x, fingers.y);
  assert(still(camera.toScreen(under.x, under.y), fingers), 'pinch holds its own midpoint');
  const place = camera.toScreen(96, 4);
  camera.follow({ id: 'a', x: 99, y: 4, time: 1 });
  assert(still(camera.toScreen(99, 4), place), 'touch zoom preserves the following offset');
  camera.follow(null); const free = camera.toWorld(900, 50); touch.zoom(1 / 2, 900, 50);
  assert(still(camera.toScreen(free.x, free.y), { x: 900, y: 50 }), 'free, about the fingers');
});

test('the follow pose respects damage playback, pause and selected actor changes', () => {
  const p = new FramePresentation(), state = (time, x, controlledActor = 'a', chassisId = 'a:0:chassis') =>
    ({ time, controlledActor, actors: [{ id: controlledActor, vehicle: { x, y: 1.3, chassisId } }] });
  const a = state(0, 12), b = state(.1, 14);
  p.receive(a, [], { now: 0 });
  p.receive(b, [{ type: 'blocked', time: .075 }], { now: 0 });
  assert.equal(p.vehicleAt(p.sample(50)).x, 12, 'the visible old chassis stays put until the damage event');
  assert.equal(p.vehicleAt(p.sample(80)).x, 13.6, 'camera and mesh use the same interpolation');
  p.receive(state(.2, 16), [], { now: 1000, paused: true });
  assert.equal(p.vehicleAt(p.sample(1000)).x, 16, 'pausing exposes the final displayed pose immediately');
  p.receive(state(.3, -25, 'b', 'b:0:chassis'), [], { now: 1100 });
  assert.equal(p.vehicleAt(p.sample(1150)).x, -25, 'a new actor never blends with the previously selected vehicle');
  assert.equal(p.vehicleAt(p.sample(1150), 'nobody'), null, 'a vehicle asked for that the field does not tell of is not followed');
  p.receive(state(.4, -30, 'b', 'b:1:chassis'), [], { now: 1200 });
  assert.equal(p.vehicleAt(p.sample(1250)).x, -30, 'restoring a network actor starts a new chassis baseline');
  p.receive(state(0, 12), [], { now: 1300 });
  assert.equal(p.vehicleAt(p.sample(1300)).x, 12);
  p.receive({ time: .1, controlledActor: null, actors: [] }, [], { now: 1400 });
  assert.equal(p.vehicleAt(p.sample(1450)), null);
});

test('clearing manual control never follows the local actor while an explicit remote target remains available', () => {
  const playback = new FramePresentation(), actors = [
    { id: 'local', vehicle: { chassisId: 'local:0', x: 12, y: 1 } },
    { id: 'remote', vehicle: { chassisId: 'remote:2', x: 80, y: 4 } },
    { id: 'fixed', vehicle: null },
  ];
  playback.receive({ time: 0, controlledActor: null, actors }, [], { now: 0 });
  const commanding = playback.sample(0);
  assert.equal(playback.vehicleAt(commanding), null);
  assert.deepEqual(playback.vehicleAt(commanding, 'remote'), { id: 'remote:remote:2', time: 0, x: 80, y: 4, flying: false });
  // An aircraft that coasts up or falls, its thrusters stopped, is in the air until it stands on something.
  for (const [vehicle, flying] of [[{ flying: false, thrustN: 9e4, vy: -20 }, true], [{ flying: false, thrustN: 9e4, vy: 30 }, true], [{ flying: false, thrustN: 9e4, vy: -.3 }, false],
    [{ flying: false, thrustN: 0, vy: -20 }, false]]) {
    const falling = new FramePresentation();
    falling.receive({ time: 0, controlledActor: 'heli', actors: [{ id: 'heli', vehicle: { chassisId: 'heli:0', x: 0, y: 90, ...vehicle } }] }, [], { now: 0 });
    assert.equal(falling.vehicleAt(falling.sample(0)).flying, flying, JSON.stringify(vehicle));
  }
  assert.equal(playback.vehicleAt(commanding, 'fixed'), null);
  assert.equal(playback.vehicleAt(commanding, 'missing'), null);
  assert.equal(playback.vehicleAt(null), null);
  playback.receive({ time: .1, controlledActor: 'remote', actors }, [], { now: 100, paused: true });
  assert.equal(playback.vehicleAt(playback.sample(100)).id, 'remote:remote:2');
});

test('one presented frame schedules effects and audio cues at contact and retains only the previous display', () => {
  const p = new FramePresentation(), operations = [], state = time => ({ time, modules: [], plates: [] });
  const callbacks = { prepare: snapshot => operations.push(['source', snapshot.time]),
    update: dt => { if (dt > 1e-10) operations.push(['advance', dt]); }, consume: (e, ahead) => operations.push(['event', e.type, ahead]) };
  p.receive(state(0), [], { now: 0 }); const initial = p.present(p.sample(0), callbacks);
  p.receive(state(.1), [{ type: 'explosion', time: .08 }], { now: 0 });
  const beforeContact = p.present(p.sample(50), callbacks);
  assert.equal(beforeContact.state, initial.state); assert.deepEqual(beforeContact.events, []);
  const beforeRecord = p.display, contact = p.present(p.sample(80), callbacks);
  assert.equal(contact.state.time, .1); assert.deepEqual(contact.events.map(e => e.type), ['explosion']);
  assert.equal(contact.previousDisplay, beforeRecord);
  // The effects are stepped once, after the event is shown, and the event says how far into that step it came.
  assert.deepEqual(operations.map(op => op[0]), ['source', 'advance', 'source', 'event', 'advance']);
  assert(Math.abs(operations.at(-2)[2] - .03) < 1e-12); assert(Math.abs(operations.at(-1)[1] - .03) < 1e-12);
  const retained = p.display, repeated = p.present(p.sample(80), callbacks);
  assert.deepEqual(repeated.events, []); assert.equal(repeated.previousDisplay, retained);
  assert.equal(p.display.previousDisplay, undefined, 'the display must not retain an unbounded linked history');
  p.receive(state(0), [], { now: 100 });
  assert.equal(p.display, null, 'restoration discards the old display and scheduled cues');
});

