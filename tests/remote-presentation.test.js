import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePresentation } from '../src/presentation.ts';
import { Camera } from '../src/camera.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { packShots } from '../src/shots.ts';
import { PhysicsMetrics } from '../src/performance.ts';

function state(time, { shared = true, revision = 0, chassisId = 'body' } = {}) {
  const vehicle = { chassisId, x: time * 10, y: 2, angle: 0, vx: 10, vy: 0 };
  return { time, shared, controlledActor: 'a', shots: packShots([]),
    actors: [{ id: 'a', vehicle }], modules: [], attachments: [],
    plates: [{ id: 'roof', actorId: 'a', revision, definition: { x: vehicle.x, y: 5, angle: 0, length: 4, thicknessMm: 20 } }],
    bodyPanels: [{ id: 'skin', actorId: 'a', pose: vehicle,
      localPolygon: [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }, { x: -2, y: 3 }] }] };
}

function drive(arrival, { until = 5000, after = 500, onFrame = () => {}, pace = () => 1, maxPace = () => 1 } = {}) {
  const playback = new FramePresentation(), metrics = new PhysicsMetrics(), speeds = [];
  let next = 0, previous, maximumHistory = 0, time = 0;
  for (let now = 0; now <= until; now += 1000 / 120) {
    while (arrival(next) <= now + 1e-8) {
      const at = arrival(next), before = playback.sample(at), buffered = playback.history.map(e => [e.state.time, e.maxPace, e.pace]);
      const speed = pace(next);
      if (next) time += .05 * speed;
      const { measured, simRatio } = metrics.read(next * 50, time, 1, false, 0, 0);
      playback.receive({ ...state(time), pace: measured ? Math.round(simRatio * 100) / 100 : undefined }, [], { now: at, maxPace: maxPace(next) });
      const received = playback.sample(at);
      if (before) assert.equal(received.time, before.time, `receiving state${next} at${at} cannot move the displayed clock; history${JSON.stringify(buffered)}`);
      maximumHistory = Math.max(maximumHistory, playback.history.length); next++;
    }
    const sample = playback.sample(now), repeated = playback.sample(now), backwards = playback.sample(now - 1);
    assert.equal(sample.time, repeated.time, 'two consumers of one display frame advance once');
    assert.equal(sample.time, backwards.time, 'a stale animation stamp cannot rewind');
    assert(sample.time <= playback.state.time, 'no pose or event is predicted beyond the authoritative state');
    const x = sample.scene.actor('a').x;
    if (previous && now > after) speeds.push((x - previous.x) / (now - previous.now) * 1000);
    onFrame(sample, playback, now); previous = { x, now };
  }
  return { playback, speeds, maximumHistory };
}

test('the remote reserve keeps regular motion exact and absorbs alternating 40/60 ms deliveries', () => {
  for (const jitter of [0, 10]) {
    const { speeds, maximumHistory } = drive(i => i * 50 + (i % 2 ? jitter : 0));
    assert(Math.min(...speeds) > 9.5); assert(Math.max(...speeds) < 10.5);
    assert(maximumHistory <= 3, 'ordinary jitter needs only three immutable states');
    if (!jitter) for (const speed of speeds) assert(Math.abs(speed - 10) < 1e-8);
  }
});

test('a 120 ms delivery gap followed by queued callbacks resumes without a position jump', () => {
  const { speeds, maximumHistory } = drive(i => i === 21 ? 1120 : i === 22 ? 1121 : i * 50);
  assert(Math.min(...speeds) >= -1e-8);
  assert(Math.max(...speeds) < 11, 'recovery must not compress a missed interval into one frame');
  assert(speeds.filter(speed => speed < 1e-8).length <= 6, 'a finite reserve may empty during a larger gap');
  assert(maximumHistory <= 4);
});

test('the visual clock follows slower source delivery and measures batched callbacks across a time window', () => {
  const slow = drive(i => i * 50 / .88, { after: 2000 });
  assert(Math.abs(slow.playback.clock.pace - .88) < .01);
  assert(Math.min(...slow.speeds) > 8.5); assert(Math.max(...slow.speeds) < 9.1);
  const batched = drive(i => Math.ceil(i / 2) * 100, { after: 2000 });
  assert(batched.playback.clock.pace > .99, 'two callbacks in one turn still carry the whole interval of source time');
  assert(Math.min(...batched.speeds) >= -1e-8); assert(Math.max(...batched.speeds) < 11);
  const average = batched.speeds.reduce((sum, speed) => sum + speed, 0) / batched.speeds.length;
  assert(Math.abs(average - 10) < .2, 'batching must not make the visual clock drift behind the world');
  assert(batched.maximumHistory <= 4);
});

test('an explicit test-server pace supports acceleration, transitions and buffered event order without lifting normal limits', () => {
  const normal = new FramePresentation();
  normal.receive({ ...state(0), pace: 8 }, [], { now: 0 });
  assert.equal(normal.clock.pace, 1.1, 'the normal field retains its existing ceiling');
  for (const speed of [2, 4, 8]) {
    const { speeds, playback, maximumHistory } = drive(i => i * 50 + (i % 2 ? 10 : 0), {
      pace: () => speed, maxPace: () => speed,
    });
    assert(Math.min(...speeds) > 9.5 * speed, `${speed}x minimum ${Math.min(...speeds)}, maximum ${Math.max(...speeds)}`);
    assert(Math.max(...speeds) < 10.5 * speed, `${speed}x maximum ${Math.max(...speeds)}`);
    assert(Math.abs(playback.clock.pace - speed) < .02 * speed);
    assert(maximumHistory <= 3);
  }
  const factor = i => i < 20 ? 1 : i < 40 ? 4 : i < 60 ? 8 : 1;
  // The first snapshot after slowing can still contain the old fast interval; its metric refreshes only every 500 ms.
  const changed = drive(i => Math.ceil(i / 2) * 100, { pace: i => i === 60 ? 8 : factor(i), maxPace: factor, after: 0 });
  assert(Math.min(...changed.speeds) >= -1e-8);
  assert(Math.max(...changed.speeds) <= 10 * 8 * 1.1 * 1.15 + 1e-6, 'transition uses the existing bounded clock correction');
  assert(changed.maximumHistory <= 6); assert(changed.playback.clock.pace <= 1.1, 'returning to 1x restores the normal ceiling');

  const playback = new FramePresentation(), events = [
    { type: 'muzzle', time: .32, id: 'shot' }, { type: 'blocked', time: .32, id: 'shot' },
  ];
  for (const [time, now, news] of [[0, 0, []], [.4, 50, events], [.8, 100, []]])
    playback.receive({ ...state(time), pace: 8 }, news, { now, maxPace: 8 });
  assert.deepEqual(playback.present(playback.sample(100)).events, []);
  const contact = playback.present(playback.sample(116));
  assert(contact.time >= .32); assert.deepEqual(contact.events, events, 'events retain their real world times and order');
  assert.deepEqual(playback.present(playback.sample(116)).events, [], 'one frame cannot repeat the accelerated cues');
  playback.rest(116);
  playback.receive({ ...state(80), pace: 8 }, events, { now: 20000, maxPace: 8, visible: false });
  playback.rest(20000);
  const returned = playback.present(playback.sample(20000));
  assert.equal(returned.time, 80); assert.deepEqual(returned.events, []);
  assert.equal(playback.history.length, 0); assert.equal(playback.paths.length, 0);
});

test('buffered poses share the same interpolation pair with the camera, roof and outer skin', () => {
  const camera = new Camera(1000, 650); camera.zoom = 100;
  let origin;
  drive(i => i * 50 + (i % 2 ? 10 : 0), { until: 1000, onFrame(sample, playback) {
    const body = sample.scene.actor('a'), roof = sample.scene.pose('roof');
    camera.follow(playback.vehicleAt(sample));
    const screen = camera.toScreen(body.x, body.y);
    origin ||= screen;
    assert(Math.hypot(screen.x - origin.x, screen.y - origin.y) < 1e-8);
    assert(Math.abs(roof.x - body.x) < 1e-10); assert.equal(roof.y - body.y, 3);
    const skin = bodyPanelSurfaces(sample.state, null, sample.previous, sample.alpha, sample.scene)[0];
    assert.equal(skin.artPose, body, 'the skin is placed by the exact pose used by the camera and parts');
    assert.equal(skin.artPolygon, sample.state.bodyPanels[0].localPolygon);
  } });
});

test('terminal flights, damage and instantaneous rays wait for the buffered contact time', () => {
  const playback = new FramePresentation(), before = state(0), damaged = state(.05, { revision: 1 }), later = state(.1, { revision: 1 }),
    flight = { type: 'flight', id: 'shell', n: 7, ammo: 'ap', weapon: 'cannon', terminal: true,
      points: [{ x: 0, y: 3, time: 0 }, { x: 4, y: 3, time: .04 }] },
    blocked = { type: 'blocked', id: 'shell', time: .04, x: 4, y: 3 },
    ray = { type: 'secondary-ray', projectileId: 'fragment', time: .04, x: 4, y: 3, endX: 5, endY: 3, internal: true };
  playback.receive(before, [], { now: 0 }); playback.present(playback.sample(0));
  playback.receive(damaged, [flight, blocked, ray], { now: 50 });
  playback.receive(later, [], { now: 100 });
  const approaching = playback.present(playback.sample(100));
  assert.equal(approaching.time, .025); assert.equal(approaching.state, before);
  assert.equal(approaching.previous, before); assert.equal(approaching.events.length, 0);
  assert.equal(approaching.shots.length, 1, 'a subsequent snapshot cannot discard the unseen terminal path');
  assert.equal(approaching.shots[0].x, 2.5); assert(!Object.hasOwn(approaching, 'traces'));
  const contact = playback.present(playback.sample(116));
  assert(contact.time > .04); assert.equal(contact.state, damaged); assert.equal(contact.previous, before);
  assert.equal(contact.shots.length, 1, 'the frame of the contact shows the round there');
  assert.deepEqual([contact.shots[0].x, contact.shots[0].y], [4, 3]); assert(!Object.hasOwn(contact, 'traces'));
  assert.equal(contact.events.filter(event => event === ray).length, 1, 'native fragment evidence retains its recorded contact time');
  assert.equal(contact.events.filter(event => event === blocked).length, 1);
  const after = playback.present(playback.sample(116));
  assert.equal(after.events.length, 0, 'one contact produces one set of cues'); assert.equal(after.shots.length, 0);
});

test('same-time metadata updates retain a pending damage boundary without duplicate history entries', () => {
  const playback = new FramePresentation(), before = state(0), damaged = state(.05, { revision: 1 });
  playback.receive(before, [], { now: 0 });
  playback.receive(damaged, [{ type: 'blocked', time: .04 }], { now: 50 });
  const metadata = { ...damaged, marker: 'new metadata' };
  playback.receive(metadata, [], { now: 51 });
  assert.equal(playback.history.length, 2);
  assert.equal(playback.sample(100).state, before, 'metadata cannot remove a contact that has not been shown');
  assert.equal(playback.sample(120).state, metadata);
});

test('the reserve shares immutable states and remains bounded through long pauses and callback bursts', () => {
  const playback = new FramePresentation(), first = state(0), original = structuredClone(first);
  Object.freeze(first); Object.freeze(first.actors[0].vehicle); Object.freeze(first.actors); Object.freeze(first.plates);
  playback.receive(first, [], { now: 0 });
  assert.equal(playback.history[0].state, first); assert.equal(playback.sample(0).state, first);
  assert.equal(playback.sample(74).time, 0, 'sampling during startup does not consume the 75 ms reserve');
  playback.receive(state(.05), [], { now: 50 });
  assert.equal(playback.sample(75).time, 0); assert(Math.abs(playback.sample(100).time - .025) < 1e-12);
  let shown = playback.sample(100).time;
  for (let i = 2; i < 50; i++) {
    playback.receive(state(i * .05), [], { now: 100 });
    assert(playback.history.length <= 6); assert(playback.clock.time >= shown); shown = playback.clock.time;
  }
  const returned = playback.sample(2000);
  assert(returned.time >= shown); assert(returned.time <= playback.state.time);
  assert(playback.history.length <= 3); assert.equal(playback.sample(2000).time, returned.time);
  assert.deepEqual(first, original, 'sampling and catch-up never write into a source state');
});

const volley = (time, number) => [{ type: 'muzzle', time: time - .025, x: 4, y: 3, id: `shell-${number}` },
  { type: 'flight', id: `shell-${number}`, n: number, ammo: 'ap', weapon: 'cannon', terminal: true,
    points: [{ x: 4, y: 3, time: time - .025 }, { x: 8, y: 3, time: time - .01 }] }];

test('an unseen shared field retains its current state without queuing old effects, sounds or flight paths', () => {
  const playback = new FramePresentation(), consumed = [], updates = [];
  playback.receive(state(0), [], { now: 0 }); playback.present(playback.sample(0));
  playback.receive(state(.05), volley(.05, 1), { now: 50 });
  playback.rest(50, dt => updates.push(dt));
  assert.equal(playback.pending.length, 0, 'hiding drops cues that were still in the visual reserve');
  assert.equal(playback.display, null, 'returning cannot bridge a rocket trail across the unseen interval');
  let latest;
  for (let i = 2; i <= 1200; i++) {
    latest = { ...state(i * .05), squad: { orders: [`order-${i}`] }, faction: { stock: { steel: i } } };
    playback.receive(latest, volley(latest.time, i), { now: i * 50, visible: false });
    assert.equal(playback.pending.length, 0); assert.equal(playback.paths.length, 0);
    assert.equal(playback.shotTrailHistory.size, 0); assert.equal(playback.history.length, 0);
  }
  assert.equal(playback.state, latest, 'network state keeps advancing while presentation sleeps');
  assert.deepEqual(playback.state.squad.orders, ['order-1200']); assert.equal(playback.state.faction.stock.steel, 1200);
  playback.rest(60000, dt => updates.push(dt));
  const shown = playback.present(playback.sample(60000), { consume: event => consumed.push(event) });
  assert.equal(shown.state, latest); assert.equal(shown.time, 60);
  assert.equal(shown.previousDisplay, null); assert.equal(shown.shots.length, 0);
  assert.deepEqual(consumed, []); assert.deepEqual(shown.events, [], 'no obsolete cue reaches audio or notices');
  assert(Math.abs(updates.reduce((sum, dt) => sum + dt, 0) - 60) < 1e-10, 'existing particles age once, without simulation substeps');
  const next = state(60.05), events = volley(60.05, 1201);
  playback.receive(next, events, { now: 60050 });
  const resumed = playback.present(playback.sample(60150), { consume: event => consumed.push(event) });
  assert.deepEqual(resumed.events, [events[0]], 'new foreground events still play once');
  assert.deepEqual(consumed, [events[0]]);
});

test('a suspended browser delivering sixty seconds of callbacks keeps only the current visual reserve', () => {
  const playback = new FramePresentation(), consumed = [];
  playback.receive(state(0), [], { now: 0 }); playback.present(playback.sample(0));
  let mostPending = 0, mostPaths = 0;
  for (let i = 1; i <= 1200; i++) {
    const time = i * .05;
    playback.receive(state(time), volley(time, i), { now: 60000 });
    mostPending = Math.max(mostPending, playback.pending.length); mostPaths = Math.max(mostPaths, playback.paths.length);
  }
  assert(mostPending <= 6, `events must follow the six-state reserve, got ${mostPending}`);
  assert(mostPaths <= 6, `flight paths must follow the six-state reserve, got ${mostPaths}`);
  const shown = playback.present(playback.sample(60001), { consume: event => consumed.push(event) });
  assert(shown.time > 59.8); assert(consumed.length <= 2);
  assert(consumed.every(event => event.time >= 59.8), 'discarded history must not be recreated or sent to audio');
});

test('a long gap after the last delivery skips obsolete cues when the remote visual clock catches up', () => {
  const playback = new FramePresentation(), consumed = [];
  playback.receive(state(0), [], { now: 0 }); playback.present(playback.sample(0));
  playback.receive(state(.5), volley(.25, 1), { now: 50 });
  const shown = playback.present(playback.sample(60000), { consume: event => consumed.push(event) });
  assert(shown.time > .4); assert.deepEqual(shown.events, []); assert.deepEqual(consumed, []);
  assert.equal(shown.shots.length, 0, 'an old terminal round is not shown striking again');
  assert.equal(playback.paths.length, 0);
});

test('pause, local tests, clock reset and a replacement chassis preserve their existing presentation rules', () => {
  const playback = new FramePresentation();
  playback.receive(state(0), [], { now: 0 }); playback.receive(state(.05), [], { now: 50 });
  playback.sample(100);
  playback.receive(state(.1), [], { now: 100, paused: true });
  assert.equal(playback.clock, null); assert.equal(playback.history.length, 0); assert.equal(playback.sample(100).time, .1);
  playback.receive(state(.15), [], { now: 150 });
  assert.equal(playback.sample(150).time, .15, 'resuming starts a fresh reserve from the resumed pose');
  playback.receive(state(0), [], { now: 200 });
  assert.equal(playback.sample(200).time, 0); assert.equal(playback.history.length, 1); assert.equal(playback.display, null);
  playback.receive(state(.05, { chassisId: 'replacement' }), [], { now: 250 });
  const replaced = playback.sample(300);
  assert.equal(replaced.scene.actor('a').x, .5, 'a replacement chassis never blends with the old body');
  playback.receive(state(0, { shared: false }), [], { now: 400 });
  playback.receive(state(.05, { shared: false }), [], { now: 400 });
  assert.equal(playback.clock, null); assert.equal(playback.sample(425).time, .025, 'the lab retains its original interpolation');
  playback.clear(); assert.equal(playback.sample(500), null); assert.equal(playback.history.length, 0); assert.equal(playback.clock, null);
});

test('background delivery leaves the paused local lab and its deliberate stepping unchanged', () => {
  const playback = new FramePresentation(), initial = state(0, { shared: false }), stepped = state(1 / 60, { shared: false }),
    event = { type: 'muzzle', time: 1 / 60, x: 4, y: 3 };
  playback.receive(initial, [], { now: 0, paused: true });
  playback.receive(stepped, [event], { now: 60000, paused: true, visible: false });
  const shown = playback.present(playback.sample(60000));
  assert.equal(shown.time, stepped.time); assert.equal(shown.state, stepped); assert.deepEqual(shown.events, [event]);
  assert.equal(playback.clock, null);
});
