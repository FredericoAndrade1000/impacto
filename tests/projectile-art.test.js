import test from 'node:test';
import assert from 'node:assert/strict';
import { projectileAppearance, projectileBodyGeometry } from '../src/projectile-visual.ts';
import { FramePresentation } from '../src/presentation.ts';

const state = time => ({ time, modules: [], plates: [], actors: [], stats: { hits: 0 } });
const flight = (id = 'round', options = {}) => ({ type: 'flight', id, ammo: 'ap', weapon: 'cannon', radius: .04,
  terminal: true, points: [{ time: .002, x: 0, y: 2 }, { time: .004, x: 2, y: 2 }, { time: .006, x: 4, y: 1 }], ...options });

test('primary bodies point along recorded velocity, retain pixel contrast and never alter ballistics', () => {
  for (const velocity of [[1000, 0], [-300, 400], [0, -150]]) for (const zoom of [12, 65, 250]) {
    const shot = { x: 12, y: 4, vx: velocity[0], vy: velocity[1], ammo: 'ap', radius: .004 }, original = { ...shot },
      visual = projectileAppearance(shot, zoom), body = projectileBodyGeometry(shot, visual);
    assert(visual.bodyLength * zoom >= 9); assert(visual.bodyWidth * zoom >= 2.8);
    assert(visual.outlineWidth * zoom >= .8 - 1e-10); assert.notEqual(visual.bodyColor, visual.outline);
    const tip = { x: body.shell[6], y: body.shell[7] }, direction = visual.direction;
    assert(Math.abs(direction.x * velocity[1] - direction.y * velocity[0]) < 1e-10);
    assert.equal(tip.x, shot.x); assert.equal(tip.y, shot.y);
    assert(Math.abs((tip.x - shot.x) * direction.y - (tip.y - shot.y) * direction.x) < 1e-10);
    for (const poly of Object.values(body)) for (let i = 0; i < poly.length; i += 2)
      assert((poly[i] - shot.x) * direction.x + (poly[i + 1] - shot.y) * direction.y <= 1e-10,
        'painted projectile vertices cannot advance beyond the real flight point');
    assert(body.shell.every(Number.isFinite)); assert.deepEqual(shot, original);
  }
});

test('AP, HE and rocket bodies have distinct finishes and rockets alone receive fins', () => {
  const base = { x: 2, y: 3, vx: 160, vy: -25, radius: .035 };
  const ap = projectileAppearance({ ...base, ammo: 'ap' }, 65),
    he = projectileAppearance({ ...base, ammo: 'he' }, 65),
    rocketShot = { ...base, ammo: 'he', weapon: 'rocket' }, rocket = projectileAppearance(rocketShot, 65);
  assert.deepEqual([ap.bodyKind, he.bodyKind, rocket.bodyKind], ['ap', 'he', 'rocket']);
  assert.notEqual(ap.bodyColor, he.bodyColor); assert.notEqual(he.bodyColor, rocket.bodyColor);
  assert(rocket.bodyLength > he.bodyLength);
  assert.equal(projectileBodyGeometry({ ...base, ammo: 'ap' }, ap).fins.length, 0);
  assert(projectileBodyGeometry(rocketShot, rocket).fins.length > 0);
  assert.equal(projectileAppearance({ ...base, poweredTrail: true }, 65).bodyKind, 'rocket');
  assert.equal(projectileBodyGeometry({ ...base, trace: true }, ap).shell.length, 0);
  const stopped = { ...base, vx: 0, vy: 0 };
  assert.equal(projectileBodyGeometry(stopped, projectileAppearance(stopped, 65)).shell.length, 0);
});

test('a fin-stabilised round flies as its long dart with fins, its sabot gone, and every other round keeps its body', () => {
  for (const zoom of [12, 30, 65, 450]) {
    const shot = { x: 3, y: 2, vx: 1650, vy: -20, ammo: 'apfsds', radius: .058 }, original = { ...shot },
      dart = projectileAppearance(shot, zoom), body = projectileBodyGeometry(shot, dart), ap = projectileAppearance({ ...shot, ammo: 'ap' }, zoom);
    assert.equal(dart.bodyKind, 'dart');
    assert(dart.bodyLength > ap.bodyLength && dart.bodyLength / dart.bodyWidth >= 8, 'longer and far thinner than a shell');
    assert(dart.bodyLength * zoom >= 16 && dart.bodyWidth * zoom >= 1.6 - 1e-9 && dart.finSpan > dart.bodyWidth * 2);
    assert(body.fins.length > 0 && body.band.length === 0, 'fins, and no driving band: the sabot is gone');
    assert.deepEqual([body.shell[4], body.shell[5]], [shot.x, shot.y], 'its tip is the flight point');
    const direction = dart.direction;
    for (const poly of Object.values(body)) for (let i = 0; i < poly.length; i += 2)
      assert((poly[i] - shot.x) * direction.x + (poly[i + 1] - shot.y) * direction.y <= 1e-10);
    // Seen side on, the fins stand above and below the rod at its tail.
    const across = Array.from({ length: body.fins.length / 2 }, (_, i) => (body.fins[i * 2 + 1] - shot.y) * direction.x - (body.fins[i * 2] - shot.x) * direction.y);
    assert(Math.max(...across) > dart.bodyWidth && Math.min(...across) < -dart.bodyWidth);
    assert.deepEqual(shot, original);
  }
  const base = { x: 2, y: 3, vx: 160, vy: -25, radius: .035 };
  assert.deepEqual(['ap', 'he', 'heat'].map(ammo => projectileAppearance({ ...base, ammo }, 65).bodyKind), ['ap', 'he', 'he']);
  assert.equal(projectileAppearance({ ...base, ammo: 'heat', weapon: 'rocket' }, 65).bodyKind, 'rocket');
});

test('fragment records have no tracer appearance or body at any zoom, speed or age', () => {
  for (const zoom of [1, 12, 65, 250]) for (const age of [.01, .5]) for (const speed of [2, 90]) {
    const shot = { fragment: true, spall: true, material: 'steel', x: 2, y: 3, vx: speed, vy: -4, age }, original = structuredClone(shot),
      visual = projectileAppearance(shot, zoom);
    assert.equal(visual, null);
    assert(Object.values(projectileBodyGeometry(shot, visual)).every(points => points.length === 0));
    assert.deepEqual(shot, original);
  }
});

test('a round born and stopped between snapshots leaves only its past path ending exactly at contact', () => {
  const p = new FramePresentation(), path = flight(), before = state(0), after = state(.02),
    events = [path, { type: 'blocked', time: .006, x: 4, y: 1 }], original = structuredClone({ path, before, after });
  const consumed = [], callbacks = { consume: event => consumed.push(event) };
  p.receive(before, [], { now: 0 }); p.receive(after, events, { now: 0 });
  const notBorn = p.present(p.sample(1), callbacks);
  assert.equal(notBorn.shots.length, 0); assert.equal(notBorn.shotTrails.length, 0);
  const moving = p.present(p.sample(4.5), callbacks), tail = moving.shotTrails[0];
  assert.equal(moving.shots.length, 1); assert.equal(tail.terminal, false);
  assert(tail.points.every(point => point.time <= moving.time + 1e-10));
  assert(Math.abs(tail.points.at(-1).x - 2.5) < 1e-10); assert(Math.abs(tail.points.at(-1).y - 1.75) < 1e-10);
  assert.equal(consumed.length, 0, 'the trail cannot trigger an early impact or effect');
  const contact = p.present(p.sample(6.001), callbacks), stopped = contact.shotTrails[0];
  assert.equal(contact.shots.length, 1, 'the frame of the contact shows the round where it stopped');
  assert.deepEqual([contact.shots[0].x, contact.shots[0].y], [4, 1]); assert.equal(stopped.terminal, true);
  assert.equal(stopped.points.at(-1).x, 4); assert.equal(stopped.points.at(-1).y, 1);
  assert.equal(stopped.points.at(-1).time, .006);
  assert.equal(consumed.filter(event => event.type === 'blocked').length, 1);
  assert.equal(p.present(p.sample(12), callbacks).shots.length, 0, 'and the next one no longer');
  assert.equal(consumed.filter(event => event.type === 'blocked').length, 1);
  assert.deepEqual({ path, before, after }, original);
});

test('the real terminal path fades on simulation time across snapshots, pause and reset', () => {
  const p = new FramePresentation(); p.receive(state(0)); p.receive(state(.02), [flight()], { paused: true });
  const initial = p.present(p.sample(0)).shotTrails[0];
  p.receive(state(.08), [], { now: 100, paused: true });
  const faded = p.present(p.sample(100)).shotTrails[0];
  assert(faded.fade < initial.fade); assert.equal(faded.points.at(-1).x, 4);
  const paused = p.present(p.sample(90000)); assert.equal(paused.time, .08); assert.equal(paused.shotTrails[0], faded);
  p.receive(state(.20), [], { paused: true }); assert.equal(p.present(p.sample(0)).shotTrails.length, 0);
  p.receive(state(.22), [], { paused: true }); assert.equal(p.shotTrailHistory.size, 0);
  p.receive(state(0), [flight()], { paused: true }); p.clear();
  assert.equal(p.shotTrailsAt(.01).length, 0); assert.equal(p.shotTrailHistory.size, 0);
});

test('consecutive primary packets share a short continuous tail without duplicating their junction', () => {
  const p = new FramePresentation(), first = flight('rocket', { weapon: 'rocket', ammo: 'he', poweredTrail: true, terminal: false,
    points: [{ time: 0, x: 0, y: 0 }, { time: .04, x: 4, y: 1 }] }),
    next = { type: 'flight', id: 'rocket', terminal: false, points: [{ time: .04, x: 4, y: 1 }, { time: .08, x: 8, y: 3 }] };
  p.receive(state(0)); p.receive(state(.04), [first], { paused: true }); p.receive(state(.08), [next], { paused: true });
  const trail = p.present(p.sample(0)).shotTrails[0];
  assert.equal(trail.weapon, 'rocket'); assert.equal(trail.ammo, 'he'); assert.equal(trail.poweredTrail, true);
  assert.deepEqual(trail.points.map(({ x, y }) => [x, y]), [[0, 0], [4, 1], [8, 3]]);
  assert.equal(trail.terminal, false); assert.equal(trail.fade, 1);
});

test('primary tails preserve ricochet corners and have bounded point and burst counts', () => {
  const p = new FramePresentation(), points = Array.from({ length: 65 }, (_, i) => ({ time: i * .001,
    x: Math.min(i, 32) * .1, y: Math.max(0, i - 32) * .1 }));
  p.receive(state(0)); p.receive(state(.08), [flight('ricochet', { points })], { paused: true });
  const corner = p.present(p.sample(0)).shotTrails[0];
  assert(corner.points.length <= 40); assert.equal(corner.points[0].x, 0);
  assert(corner.points.some(point => point.x === 3.2 && point.y === 0));
  assert.equal(corner.points.at(-1).x, 3.2); assert.equal(corner.points.at(-1).y, 3.2);
  for (const recent of points.slice(-8)) assert(corner.points.some(point => point.time === recent.time &&
    Math.hypot(point.x - recent.x, point.y - recent.y) < 1e-10), 'recent real substeps stay exact at the tracer head');
  // A dense burst: four hundred tails, and the rays of ten fragments thrown where the last of them ended.
  const dense = new FramePresentation(), flights = Array.from({ length: 400 }, (_, i) => flight(`round-${i}`, { points })),
    rays = Array.from({ length: 10 }, (_, i) => ({ type: 'secondary-ray', projectileId: `ejecta-${i}`, x: 3.2, y: 3.2,
      endX: 3.2 + i * .1, endY: 3.7, time: points.at(-1).time })), original = structuredClone(flights);
  dense.receive(state(0)); dense.receive(state(.08), [...flights, ...rays], { paused: true });
  const shown = dense.present(dense.sample(0));
  assert.equal(shown.shotTrails.length, 128); assert.equal(dense.shotTrailHistory.size, 128);
  assert(shown.shotTrails.every(trail => trail.points.length <= 40));
  assert.equal(new Set(shown.shotTrails.map(trail => trail.id)).size, 128);
  assert(!Object.hasOwn(shown, 'traces'), 'fragment evidence adds no visual segments beside the primary tails');
  assert.deepEqual(flights, original);
});

test('future and malformed flight records never create a current primary tail', () => {
  const p = new FramePresentation(), malformed = flight('bad', { points: [{ time: 0, x: NaN, y: 0 }, { time: .01, x: 1, y: 0 }] }),
    future = flight('future', { points: [{ time: .2, x: 5, y: 5 }, { time: .3, x: 15, y: 5 }] });
  p.receive(state(0)); p.receive(state(.1), [malformed, future], { paused: true });
  assert.equal(p.shotTrailsAt(.1).length, 0);
});

test('the tail reaches back a stated length of flight: a streak from near, the arc itself from afar', () => {
  const p = new FramePresentation(), points = Array.from({ length: 41 }, (_, i) => ({ time: i * .1, x: i * 10, y: 4 * i - 4.905 * (i * .1) ** 2 })),
    length = trail => trail.points.slice(1).reduce((sum, b, i) => sum + Math.hypot(b.x - trail.points[i].x, b.y - trail.points[i].y), 0);
  p.receive(state(0)); p.receive(state(4), [flight('shell', { ammo: 'he', weapon: 'mortar', terminal: false, points })], { paused: true });
  const near = p.shotTrailsAt(4, 3)[0], far = p.shotTrailsAt(4, 250)[0], whole = p.shotTrailsAt(4)[0];
  assert(Math.abs(length(near) - 3) < 1e-6); assert(Math.abs(length(far) - 250) < 1e-6);
  for (const trail of [near, far, whole]) {
    assert.deepEqual([trail.x, trail.y, trail.points.at(-1).fade], [400, points.at(-1).y, 1], 'the head is the round');
    assert(trail.points.every((point, i) => !i || point.fade >= trail.points[i - 1].fade), 'the tail fades away from the head');
  }
  assert(near.points[0].fade < 1e-9 && far.points[0].fade < 1e-9); assert(far.points.length > near.points.length);
  assert.equal(whole.points[0].x, 0, 'with no bound the tail goes back to the muzzle');
  assert.equal(p.shotTrailsAt(4)[0], whole, 'the same view is not worked out twice');
  // Past a few seconds of flight the far end of a tail is let go, whatever its length.
  const old = Array.from({ length: 21 }, (_, i) => ({ time: i, x: i * 5, y: 0 }));
  p.receive(state(20), [flight('slow', { terminal: false, points: old })], { paused: true });
  assert.equal(p.shotTrailsAt(20).find(trail => trail.id === 'slow').points[0].x, 60);
});

test('the last long flight of each gun leaves its whole arc where it ended, for a few seconds', () => {
  const p = new FramePresentation(), arc = (id, start, extra = {}) => flight(id, { ammo: 'he', weapon: 'mortar', preset: 'm252', actorId: 'local',
    points: Array.from({ length: 31 }, (_, i) => ({ time: start + i * .1, x: i * 6, y: 1.5 * i - 4.905 * (i * .1) ** 2 })), ...extra });
  p.receive(state(0)); p.receive(state(3), [arc('first', 0), flight('burst', { actorId: 'local', preset: 'm2hb' })], { paused: true });
  const [fallen, ...others] = p.fallenArcsAt(3.5);
  assert.equal(others.length, 0, 'a round that flew a blink leaves none');
  assert.deepEqual([fallen.id, fallen.points[0].x, fallen.x, fallen.flight], ['first', 0, 180, 3]); assert(Math.abs(fallen.fade - .9) < 1e-9);
  // The arc is drawn from where it fell: nothing near the gun, all of it over the last part of the flight.
  const drawn = share => fallen.points[Math.round(share * 30)].fade;
  assert.deepEqual([0, .3, .7, 1].map(drawn), [0, 0, 1, 1]); assert(Math.abs(drawn(.5) - .5) < 1e-9);
  assert.equal(p.fallenArcsAt(2.9).length, 0, 'not before the round has ended');
  p.receive(state(6), [arc('second', 3), arc('other', 3, { preset: 'm119' })], { paused: true });
  assert.deepEqual(p.fallenArcsAt(6.2).map(a => a.id), ['second', 'other'], 'one arc for each gun');
  p.receive(state(12), [], { paused: true }); assert.equal(p.present(p.sample(0)).fallenArcs.length, 0);
  p.receive(state(18), [], { paused: true }); assert.equal(p.fallenArcs.size, 0);
  p.receive(state(21), [arc('third', 18)], { paused: true }); p.clear(); assert.equal(p.fallenArcs.size, 0);
});
