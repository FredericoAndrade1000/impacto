import test from 'node:test';
import assert from 'node:assert/strict';
import { Texture } from 'pixi.js';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponSettings, WEAPON_PRESETS, MAX_RATE } from '../src/weapons.ts';
import { FramePresentation } from '../src/presentation.ts';
import { ShotQuads } from '../src/shot-quads.ts';
import { packShots, shotAt, shotCount } from '../src/shots.ts';

// The rounds of a hand-made state are packed as the core packs them: single precision, so the figures here are ones it holds exactly.
const state = (time, ...rounds) => ({ time, shots: packShots(rounds), modules: [], plates: [], actors: [] });
const shell = (x, y, extra = {}) => ({ id: 'shell', number: 7, x, y, vx: 100, vy: 0, age: 1, ammo: 'he', weapon: 'mortar', preset: 'm252', actorId: 'local', radius: .04, ...extra });
const path = (points, extra = {}) => ({ type: 'flight', id: 'shell', n: 7, ammo: 'he', weapon: 'mortar', terminal: false, points, ...extra });
// What a frame shows at a moment of the wall clock, within `view` when one is stated.
const shown = (p, now, view) => { const sample = p.sample(now); if (view) sample.view = view; return p.present(sample); };

test('a round in flight sends a path for its first step and its last, and the snapshots tell the rest', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  const config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 }), gun = w.launcher(config), playback = new FramePresentation();
  playback.receive(w.snapshot(), w.drainEvents(), { paused: true });
  assert(w.fire({ x: gun.x + 60, y: gun.y + 12 }, config, true));
  const flights = [], positions = [];
  for (let step = 0; step < 90; step++) {
    w.step(); const events = w.drainEvents(), snapshot = w.snapshot();
    flights.push(...events.filter(event => event.type === 'flight').map(event => ({ step, event })));
    assert.equal(shotCount(snapshot.shots), 1); assert(flights.every(flight => flight.event.n === snapshot.shots.data[0]), 'a path carries the number of its round');
    positions.push(shotAt(snapshot.shots, 0)); playback.receive(snapshot, events, { paused: true });
  }
  assert.equal(w.projectiles.length, 1, 'still in the air after a second and a half');
  assert.deepEqual(flights.map(flight => flight.step), [0], 'only the step that left the muzzle sent a path');
  assert.equal(flights[0].event.points[0].time, 0); assert(Math.hypot(flights[0].event.points[0].x - gun.x, flights[0].event.points[0].y - gun.y) < 2);
  const tail = playback.shotTrailsAt(w.time)[0];
  assert.equal(tail.points[0].time, 0, 'the tail goes back to the muzzle');
  assert.deepEqual([tail.x, tail.y], [positions.at(-1).x, positions.at(-1).y]); assert.equal(tail.terminal, false);
  assert.deepEqual(playback.present(playback.sample(0)).shots.map(shot => [shot.id, shot.x, shot.y]), [[positions.at(-1).id, positions.at(-1).x, positions.at(-1).y]]);
  for (let step = 90; w.projectiles.length && step < 2000; step++) {
    w.step(); const events = w.drainEvents();
    flights.push(...events.filter(event => event.type === 'flight').map(event => ({ step, event })));
    playback.receive(w.snapshot(), events, { paused: true });
  }
  assert.equal(w.projectiles.length, 0); assert(flights.length >= 2 && flights.length <= 6, 'a path a contact, none for the flight between');
  const last = flights.at(-1).event, ended = playback.shotTrailsAt(w.time)[0];
  assert.equal(last.terminal, true); assert(flights.slice(1).every(flight => flight.event.terminal || flight.event.points.length > 2));
  assert.deepEqual([ended.x, ended.y, ended.terminal], [last.points.at(-1).x, last.points.at(-1).y, true]);
});

test('the fastest gun of the catalogue fires its thousand rounds a minute with the trigger held', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  const config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 });
  assert.equal(config.rate, 1000); assert.equal(WEAPON_PRESETS.rh202.rate, 1000);
  assert.equal(weaponSettings('autocannon', { preset: 'rh202', rate: 9000 }).rate, MAX_RATE);
  w.setTrigger(true, { x: 60, y: 40 }, config);
  for (let i = 0; i < 360; i++) { w.step(); w.drainEvents(); }
  assert.equal(w.stats.shots, 100, 'a hundred rounds in six seconds');
});

test('a round that only flies on needs no path: its tail grows from where each snapshot has it', () => {
  const p = new FramePresentation(), hear = (time, events, ...rounds) => p.receive(state(time, ...rounds), events, { paused: true });
  hear(0, []);
  hear(.1, [path([{ time: 0, x: 0, y: 0 }, { time: .1, x: 10, y: 1 }])], shell(10, 1));
  hear(.2, [], shell(20, 1.5)); hear(.3, [], shell(30, 1.5));
  const trail = p.present(p.sample(0)).shotTrails[0];
  assert.deepEqual(trail.points.map(({ x, y }) => [x, y]), [[0, 0], [10, 1], [20, 1.5], [30, 1.5]]);
  assert.deepEqual([trail.id, trail.preset, trail.actorId, trail.terminal], ['shell', 'm252', 'local', false]);
  hear(.3, [], shell(30, 1.5)); assert.equal(p.shotTrailHistory.get(7).points.length, 4, 'the same snapshot heard twice adds nothing');
  // The path of its last step closes the tail where the round ended.
  hear(.4, [path([{ time: .3, x: 30, y: 1.5 }, { time: .35, x: 35, y: 0 }], { terminal: true })]);
  const ended = p.shotTrailsAt(.4)[0];
  assert.deepEqual([ended.x, ended.y, ended.terminal, ended.points.length], [35, 0, true, 5]);
  // A round first met in mid flight has a tail from there on.
  const late = new FramePresentation();
  late.receive(state(5, shell(400, 90)), [], { paused: true }); assert.equal(late.shotTrailsAt(5).length, 0);
  late.receive(state(5.1, shell(410, 89)), [], { paused: true });
  assert.deepEqual(late.shotTrailsAt(5.1)[0].points.map(({ x, y }) => [x, y]), [[400, 90], [410, 89]]);
});

test('of a volley too long to draw whole, the newest rounds have the tails', () => {
  const p = new FramePresentation(), volley = (time, count, extra = []) => state(time, ...Array.from({ length: count }, (_, i) =>
    ({ id: `shot-${i}`, x: i, y: time * 100, vx: 0, vy: 100, age: 1, ammo: 'ap' })), ...extra);
  p.receive(volley(0, 300), [], { paused: true }); p.receive(volley(.1, 300), [], { paused: true });
  assert.equal(p.shotTrailHistory.size, 128); assert(p.shotTrailHistory.has(299) && p.shotTrailHistory.has(172) && !p.shotTrailHistory.has(171));
  assert.equal(p.shotTrailsAt(.1).length, 128); assert.equal(p.present(p.sample(0)).shots.length, 300, 'every round is still shown');
  // When the newer ones are gone an older round is among the newest again: its tail starts over, with no chord across the gap.
  p.receive(volley(.2, 150), [], { paused: true }); p.receive(volley(.3, 150), [], { paused: true });
  assert.deepEqual(p.shotTrailsAt(.3).find(trail => trail.id === 'shot-30').points.map(point => point.y), [20, 30]);
  for (let i = 4; i < 60; i++) p.receive(volley(i / 10, 150), [], { paused: true });
  assert(p.shotTrailHistory.get(149).points.length <= 40, 'a long flight stays a bounded number of points');
  // The newest are counted back from the end of the block: a round that is nowhere does not count, and an older
  // round has no tail even in the delivery it met something.
  const lost = { id: 'shot-990', x: NaN, y: 2, vx: 0, vy: 100, age: 1, ammo: 'ap' },
    ricochet = n => ({ type: 'flight', id: `shot-${n}`, n, ammo: 'ap', terminal: false, points: [{ time: 5.9, x: n, y: 590 }, { time: 5.95, x: n - 1, y: 595 }, { time: 6, x: n, y: 600 }] });
  p.receive(volley(6, 150, [lost]), [ricochet(5), ricochet(140)], { paused: true });
  assert.equal(p.shotTrailHistory.size, 128); assert(p.shotTrailHistory.has(22) && !p.shotTrailHistory.has(21) && !p.shotTrailHistory.has(5) && !p.shotTrailHistory.has(990));
  assert.deepEqual(p.shotTrailHistory.get(140).points.slice(-3).map(point => point.x), [140, 139, 140], 'one of the newest keeps the corner its path told');
  assert.equal(p.present(p.sample(0)).shots.length, 150 - 2 + 2, 'the two that met something are told by their paths, and the lost one is nowhere');
});

test('a round that only flew on is shown back along its velocity from the latest snapshot, and not before it was born', () => {
  // The far round has flown for a second; the young one was fired two thousandths before the snapshot.
  const p = new FramePresentation(), far = x => ({ id: 'far', number: 3, x, y: 5, vx: 600, vy: 0, age: 1, ammo: 'ap' }),
    after = state(.01, far(6), { id: 'young', number: 4, x: 3, y: 1, vx: 50, vy: 25, age: .002, ammo: 'ap' });
  p.receive(state(0, far(0)), [], { now: 0 }); p.receive(after, [{ type: 'blocked', time: .008, x: 3, y: 1 }], { now: 0 });
  const held = p.present(p.sample(5));
  assert.equal(held.state.time, 0, 'the display is still before the contact, and the rounds fly on the visual clock');
  assert.deepEqual(held.shots.map(shot => [shot.id, shot.number, shot.x, shot.y]), [['far', 3, 3, 5]], 'the round is half way, and the young one is not there yet');
  assert.equal(p.present(p.sample(7.9)).shots.length, 1, 'nor a moment before it was born');
  const born = p.present(p.sample(8)).shots;
  assert.deepEqual(born.map(shot => shot.id), ['far', 'young']); assert(Math.abs(born[1].x - 2.9) < 1e-6 && Math.abs(born[1].y - .95) < 1e-6, 'it starts where it was fired from');
  const late = p.present(p.sample(9));
  assert.equal(late.state, after); assert.deepEqual(late.shots.map(shot => shot.id), ['far', 'young']);
  assert(Math.abs(late.shots[0].x - 5.4) < 1e-9); assert(Math.abs(late.shots[1].x - 2.95) < 1e-6 && Math.abs(late.shots[1].age - .001) < 1e-6);
  const last = p.present(p.sample(10));
  assert.deepEqual(last.shots.map(shot => [shot.x, shot.y]), [[6, 5], [3, 1]], 'at its own time a snapshot is shown as it is');
  // No snapshot is matched against the one before: a round the first never had is shown all the same.
  p.receive(state(.02, far(12), { id: 'new', number: 9, x: 40, y: 2, vx: -200, vy: 0, age: 5, ammo: 'he' }), [], { now: 10 });
  assert.deepEqual(p.present(p.sample(15)).shots.map(shot => [shot.id, +shot.x.toFixed(9)]), [['far', 9], ['new', 41]]);
});

test('a round with a path this delivery is drawn once: along the path while that lasts, from the block after', () => {
  // Three steps of the core to a delivery: the path of a new round tells its first step only.
  const p = new FramePresentation(), round = (x, age) => shell(x, 1, { age }),
    muzzle = path([{ time: 0, x: 0, y: 0 }, { time: .05, x: 5, y: 1 }]);
  p.receive(state(0), [], { now: 0 }); p.receive(state(.15, round(15, .15)), [muzzle], { now: 0 });
  const along = shown(p, 25);
  assert.equal(along.shots.length, 1); assert.equal(along.shots[0].points, muzzle.points, 'the path tells where it is');
  assert.deepEqual([+along.shots[0].x.toFixed(9), +along.shots[0].y.toFixed(9), along.shots[0].number, along.shots[0].preset], [2.5, .5, 7, 'm252'], 'and the block of which kind it is');
  assert(Math.abs(along.shots[0].age - .025) < 1e-6);
  const after = shown(p, 100);
  assert.deepEqual(after.shots.map(shot => [+shot.x.toFixed(9), shot.y, shot.points]), [[10, 1, undefined]], 'past the end of its path it only flew on');
  assert.equal(shown(p, 50).shots.length, 1, 'never both, and never neither');
  p.receive(state(.3, round(30, .3)), [], { now: 150 });
  assert.deepEqual(shown(p, 225).shots.map(shot => +shot.x.toFixed(9)), [22.5]); assert.equal(shown(p, 150).shots.length, 1);
  // A round that ends is drawn along its last path up to where it ended — there on the frame that shows its end —, and
  // is in no block after.
  p.receive(state(.45), [path([{ time: .3, x: 30, y: 1 }, { time: .35, x: 35, y: 0 }], { terminal: true })], { now: 300 });
  assert.deepEqual(shown(p, 325).shots.map(shot => +shot.x.toFixed(9)), [32.5]);
  assert.deepEqual(shown(p, 360).shots.map(shot => [shot.x, shot.y]), [[35, 0]]); assert.equal(shown(p, 380).shots.length, 0);
  // A path that ends with its delivery is still held through the next: the round is not hidden behind it.
  const r = new FramePresentation();
  r.receive(state(0), [], { now: 0 }); r.receive(state(.1, round(10, .1)), [path([{ time: 0, x: 0, y: 0 }, { time: .1, x: 10, y: 1 }])], { now: 0 });
  assert.deepEqual(shown(r, 50).shots.map(shot => [+shot.x.toFixed(9), shot.points.length]), [[5, 2]]);
  r.receive(state(.2, round(20, .2)), [], { now: 100 });
  assert.equal(r.paths.length, 1); assert.equal(shown(r, 100).shots.length, 1);
  assert.deepEqual(shown(r, 150).shots.map(shot => [+shot.x.toFixed(9), shot.points]), [[15, undefined]], 'shown throughout the delivery after the one it was fired in');
  // A path with no number is that of no round of the block.
  const q = new FramePresentation();
  q.receive(state(0), [], { now: 0 }); q.receive(state(.1, round(10, 1)), [{ ...muzzle, n: undefined, id: 'other', points: [{ time: 0, x: 0, y: 9 }, { time: .1, x: 1, y: 9 }] }], { now: 0 });
  assert.deepEqual(shown(q, 50).shots.map(shot => [shot.id, +shot.x.toFixed(9)]), [['shell', 5], ['other', .5]]);
});

test('nothing is made of a round the camera does not show, and of those it shows only the newest are told whole', () => {
  // A thousand rounds in a row, one a metre, all flying up; number 0 is the oldest.
  const p = new FramePresentation(), row = time => state(time, ...Array.from({ length: 1000 }, (_, i) =>
      ({ id: `shot-${i}`, x: i, y: 50 + time * 100, vx: 0, vy: 100, age: 2, ammo: i % 2 ? 'he' : 'ap', actorId: i % 2 ? 'b' : 'a' })));
  p.receive(row(0), [], { now: 0 }); p.receive(row(.1), [], { now: 0 });
  const view = { left: 299.5, right: 400.5, bottom: 50, top: 70 }, all = shown(p, 100, view);
  assert.deepEqual(all.shots.map(shot => shot.number), Array.from({ length: 101 }, (_, i) => 300 + i), 'those within the view, oldest first');
  assert.equal(all.specks.count, 0);
  assert.equal(shown(p, 100, { ...view, bottom: 61 }).shots.length, 0); assert.equal(shown(p, 0, { ...view, bottom: 61 }).shots.length, 0);
  assert.equal(shown(p, 50, { ...view, bottom: 54, top: 56 }).shots.length, 101, 'a round is in view where the display has it, not where the snapshot does');
  // Told to tell eight whole, it tells the newest eight in view; the others are a place and a kind each.
  const some = shown(p, 100, { ...view, whole: 8 }), specks = some.specks;
  assert.deepEqual(some.shots.map(shot => shot.number), [393, 394, 395, 396, 397, 398, 399, 400]);
  assert.equal(specks.count, 93); assert.equal(specks.kinds, p.state.shots.kinds);
  const places = Array.from({ length: specks.count }, (_, i) => [specks.x[i], specks.y[i], specks.kinds[specks.kind[i]].ammo]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(places[0], [300, 60, 'ap']); assert.deepEqual(places.at(-1), [392, 60, 'ap']); assert.deepEqual(places[1], [301, 60, 'he']);
  assert.equal(shown(p, 100, { ...view, whole: 0 }).shots.length, 0, 'asked for none whole, none is');
  // The buffers of the specks are kept from frame to frame and grow with the densest view.
  const wide = shown(p, 100, { left: -1, right: 2000, bottom: 0, top: 100, whole: 0 });
  assert.equal(wide.specks.count, 1000); assert.equal(wide.specks, specks); assert(specks.x.length >= 1000 && specks.x.length === specks.kind.length);
  assert.equal(wide.shots.length, 0); assert.equal(shown(p, 100, view).specks.count, 0);
  // A round a path tells of is culled by where the path has it.
  p.receive(row(.2), [{ type: 'flight', id: 'shot-350', n: 350, ammo: 'ap', terminal: false, points: [{ time: .1, x: 350, y: 60 }, { time: .2, x: 500, y: 70 }] }], { now: 100 });
  assert(!shown(p, 200, { ...view, top: 80 }).shots.some(shot => shot.number === 350), 'its path took it out of view');
  assert.deepEqual(shown(p, 200, { left: 499.5, right: 500.5, bottom: 0, top: 100 }).shots.map(shot => [shot.number, shot.x]), [[500, 500], [350, 500]], 'and into another');
});

test('the camera follows a round by its number and otherwise takes the newest whole round of its actor, with no list made', () => {
  const p = new FramePresentation(), rounds = (time, count) => [...Array.from({ length: count }, (_, i) =>
      ({ id: `shot-${i}`, x: i * 10 + time * 100, y: 5, vx: 100, vy: 0, age: 1 + time, ammo: 'ap', actorId: i % 3 ? 'other' : 'mine' }))];
  p.receive(state(0, ...rounds(0, 20)), [], { now: 0 }); p.receive(state(.1, ...rounds(.1, 20)), [], { now: 0 });
  const mine = actorId => actorId === 'mine', at = now => p.sample(now);
  assert.deepEqual([p.shotToFollow(at(100)).number, p.shotToFollow(at(100), null, mine).number], [19, 18], 'the newest of anyone, the newest of the actor');
  const followed = p.shotToFollow(at(50), 6, mine);
  assert.deepEqual([followed.id, followed.number, followed.x, followed.actorId], ['shot-6', 6, 65, 'mine'], 'the one it follows, where the display has it');
  assert(Math.abs(followed.age - 1.05) < 1e-6); assert.equal(p.shotToFollow(at(50), 7, mine).number, 7, 'the round followed is kept whoever fired it');
  assert.equal(p.shotToFollow(at(50), 555, mine).number, 18, 'when it is gone the camera takes the newest');
  assert.equal(p.shotToFollow(at(50), null, actorId => actorId === 'nobody'), null); assert.equal(p.shotToFollow(null), null);
  // A round just fired is told by its path: it is the newest, and is followed along the path.
  const fresh = { id: 'shot-30', number: 30, x: 4, y: 5, vx: 100, vy: 0, age: .04, ammo: 'ap', actorId: 'mine' };
  p.receive(state(.2, ...rounds(.2, 20), fresh), [{ type: 'flight', id: 'shot-30', n: 30, actorId: 'mine', ammo: 'ap', terminal: false,
    points: [{ time: .16, x: 0, y: 5 }, { time: .2, x: 4, y: 5 }] }], { now: 100 });
  const newest = p.shotToFollow(at(180), null, mine);
  assert.deepEqual([newest.number, newest.id], [30, 'shot-30']); assert(Math.abs(newest.x - 2) < 1e-9 && Math.abs(newest.age - .02) < 1e-6);
  assert.equal(p.shotToFollow(at(180), 30).points.length, 2); assert.equal(p.shotToFollow(at(150), null, mine).number, 18, 'before it was fired the newest is another');
  assert.equal(p.shotToFollow(at(150), 30, mine).number, 18);
  const empty = new FramePresentation(); empty.receive({ time: 0 }, [], { paused: true }); assert.equal(empty.shotToFollow(empty.sample(0)), null);
});

test('the motor of a rocket lays smoke wherever it burns, from where the round was a frame before', () => {
  const p = new FramePresentation(), rocket = (number, x, age, extra = {}) => ({ id: `shot-${number}`, number, x, y: 10, vx: 200, vy: 0, age, ammo: 'he', weapon: 'rocket', poweredTrail: true, ...extra });
  p.receive(state(0, shell(0, 1)), [], { now: 0 });
  assert.deepEqual(p.burningAt(p.sample(0), .016), [], 'no round of the legend has a motor');
  p.receive(state(.1, shell(10, 1), rocket(1, 100, .5), rocket(2, 5000, 3), rocket(3, 6, .03)), [], { now: 0 });
  const burning = p.burningAt(p.sample(50), .02);
  assert.equal(burning.length, 1, 'one burns and was born; another burnt out, another is not fired yet');
  assert.deepEqual([burning[0].x, burning[0].y, burning[0].from.y], [90, 10, 10]); assert(Math.abs(burning[0].from.x - 86) < 1e-9);
  const young = p.burningAt(p.sample(90), .05).find(shot => shot.x < 10);
  assert(Math.abs(young.x - 4) < 1e-5 && Math.abs(young.from.x - 0) < 1e-5, 'its smoke starts at the muzzle, not before it');
});

test('a burst of the core told three steps to a delivery: every round is shown once, from the frame after its muzzle on', t => {
  const w = new World(createConstruction('empty')); t.after(() => w.dispose());
  const config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 }), gun = w.launcher(config), p = new FramePresentation();
  w.setTrigger(true, { x: gun.x + 40, y: gun.y + 30 }, config); p.receive(w.snapshot(), w.drainEvents(), { now: 0 });
  let most = 0, along = 0;
  for (let delivery = 1; delivery <= 40; delivery++) {
    for (let step = 0; step < 3; step++) w.step();
    const state = w.snapshot(), flying = Array.from({ length: shotCount(state.shots) }, (_, i) => shotAt(state.shots, i));
    p.receive(state, w.drainEvents(), { now: delivery * 50 }); most = Math.max(most, flying.length);
    for (const frame of [1, 17, 34, 50]) {
      const shots = shown(p, delivery * 50 + frame).shots, numbers = shots.map(shot => shot.number);
      assert.equal(new Set(numbers).size, numbers.length, 'no round twice');
      along += shots.filter(shot => shot.points).length;
      // A round fired before this delivery only flies on through it: it is there at every frame, not only at the snapshot.
      for (const round of flying) assert(numbers.includes(round.number) || frame < 50 && round.age < .05 + 1e-6, `round ${round.number} at frame ${frame} of delivery ${delivery}`);
    }
  }
  assert(most >= 20 && along > 20, 'a burst was in the air, and rounds were drawn along their paths too');
});

test('the quads of a frame grow with the volley and keep their place in the world', () => {
  const quads = new ShotQuads(2); quads.clear(30000, 150);
  for (let i = 0; i < 5; i++) quads.marker(30000 + i, 150, .5);
  assert.equal(quads.count, 5); assert(quads.positions.length >= 40 && quads.uvs.length === quads.positions.length);
  assert.deepEqual([...quads.positions.slice(0, 8)], [-.5, -.5, -.5, .5, .5, -.5, .5, .5], 'corners are kept near the camera, where single precision is fine');
  assert.deepEqual([...quads.positions.slice(32, 40)], [3.5, -.5, 3.5, .5, 4.5, -.5, 4.5, .5]);
  // A tail drawn nowhere in view, or too faint to show, writes nothing.
  quads.clear(0, 0); const view = { left: -10, right: 10, bottom: -10, top: 10 };
  quads.tail([{ x: 50, y: 0, fade: 1 }, { x: 60, y: 0, fade: 1 }], 0, .1, 1, view); quads.tail([{ x: 0, y: 0, fade: .01 }, { x: 5, y: 0, fade: .01 }], 0, .1, 1, view);
  quads.tail([{ x: 0, y: 0 }, { x: 0, y: 0 }], 0, .1); assert.equal(quads.count, 0);
  quads.tail([{ x: -20, y: 0, fade: 0 }, { x: 20, y: 0, fade: 1 }], 1, .1, 1, view); assert.equal(quads.count, 1);
  quads.sync();
});

test('the quads of the last frame drawn are folded on the GPU, whatever frames with nothing to draw came between', () => {
  // A mesh and its buffers as the renderer has them: what is asked to travel goes when the mesh is drawn, as much
  // of it as the last request said, and nothing goes for a mesh that is hidden.
  const quads = new ShotQuads(8), asked = { bytes: 0 }, buffer = { update(bytes) { asked.bytes = bytes; } },
    geometry = { positions: quads.positions, uvs: quads.uvs, indices: null, getBuffer: () => buffer },
    mesh = quads.mesh = { geometry, position: { set() {} }, alpha: 1, visible: true };
  let gpu = new Float32Array(0);
  const frame = (count, alpha = 1) => {
      quads.clear(0, 0); quads.alpha = alpha;
      for (let i = 0; i < count; i++) quads.marker(i, 0, .5);
      quads.sync();
      if (!mesh.visible || !(mesh.alpha > 0)) return;
      if (gpu.length !== geometry.positions.length) gpu = geometry.positions.slice(); else gpu.set(geometry.positions.subarray(0, asked.bytes / 4));
    },
    shown = () => { let n = 0; for (let at = 0; at < gpu.length; at += 8) if (gpu.subarray(at, at + 8).some(Boolean)) n++; return n; };
  frame(6); assert.equal(shown(), 6);
  frame(2); assert.equal(shown(), 2, 'the quads the frame before had and this one has not are nothing');
  // The field is left for the workshop with rounds in the air, or the last of them go out of view at once.
  frame(6); frame(0); frame(0); assert.equal(mesh.visible, false, 'a batch with nothing in it is not drawn');
  frame(2); assert.equal(mesh.visible, true); assert.equal(shown(), 2, 'no quad of the frame drawn before the empty ones is left on the screen');
  // The same of a batch faded to nothing with quads still in it.
  frame(6); frame(3, 0); assert.equal(mesh.visible, false); frame(1); assert.equal(shown(), 1);
  // And of one that grew while it was not drawn.
  frame(5); frame(0); frame(20); assert.equal(shown(), 20); frame(0); frame(4); assert.equal(shown(), 4);
});

test('pooled quad meshes draw only the active prefix through growth, culling and reactivation', t => {
  const quads = new ShotQuads(8), mesh = quads.attach(Texture.EMPTY), geometry = mesh.geometry;
  t.after(() => { mesh.destroy(); geometry.destroy(true); });
  const frame = (count, alpha = 1) => {
    quads.clear(125000, 50); quads.alpha = alpha;
    for (let i = 0; i < count; i++) quads.marker(125000 + i, 50, .5);
    quads.sync();
    assert.equal(geometry.indexCount, count * 6);
    assert.equal(mesh.visible, count > 0 && alpha > 0);
    if (mesh.visible) {
      assert(geometry.indexCount <= geometry.indices.length);
      assert.deepEqual([...geometry.positions.subarray(0, 8)], [-.5, -.5, -.5, .5, .5, -.5, .5, .5]);
    }
  };
  frame(1); assert.equal(geometry.indices.length, 48, 'unused pool capacity stays allocated but is outside the draw range');
  frame(20); assert.equal(geometry.indexCount, 120); assert(geometry.indices.length > geometry.indexCount);
  frame(2); assert.equal(geometry.indexCount, 12, 'shrinking a volley must also shrink its GPU draw');
  frame(0); frame(0); frame(1);
  frame(3, 0); frame(2);
  frame(40, 0); frame(40); frame(0); frame(4);
});

test('the tail of a round that was turned on its way to where it stopped goes back through every turn', () => {
  // Along the ground to a plate, up off it, off another and on to where it stops: all of it within a step.
  const way = [{ time: 0, x: 0, y: 0 }, { time: .010, x: 10, y: 0 }, { time: .014, x: 10, y: 4 }, { time: .016, x: 12, y: 4 }],
    told = (points, terminal) => { const p = new FramePresentation(); p.receive(state(0), [], { paused: true }); p.receive(state(1 / 60), [path(points, { terminal })], { paused: true }); return p; },
    drawn = (p, reach) => p.shotTrailsAt(1 / 60, reach)[0].points.map(({ x, y, fade }) => [+x.toFixed(9), +y.toFixed(9), +fade.toFixed(4)]);
  // Six metres from the first turn to the stop, in more than half strength; before the first turn, the three metres a tail has.
  assert.deepEqual(drawn(told(way, true), 3), [[7, 0, 0], [10, 0, .6], [10, 4, .8667], [12, 4, 1]]);
  // A round that stopped where it first struck has the tail it always had, and so has one that was turned and flies on.
  assert.deepEqual(drawn(told(way.slice(0, 2), true), 3), [[7, 0, 0], [10, 0, 1]]);
  assert.deepEqual(drawn(told(way, false), 3), [[10, 3, 0], [10, 4, .3333], [12, 4, 1]]);
  // A turn long before the stop is part of the flight, not of how the round came to rest.
  const far = [{ time: 0, x: 0, y: 0 }, { time: .5, x: 10, y: 0 }, { time: 1, x: 10, y: 400 }],
    late = new FramePresentation(); late.receive(state(0), [], { paused: true }); late.receive(state(1), [path(far, { terminal: true })], { paused: true });
  assert.deepEqual(late.shotTrailsAt(1, 3)[0].points.map(({ x, y }) => [x, y]), [[10, 397], [10, 400]]);
});
