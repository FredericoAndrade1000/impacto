import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render.ts';
import { FramePresentation } from '../src/presentation.ts';
import { TAIL_WIDTH, MARKER_RADIUS, GLOW_RADIUS } from '../src/shot-quads.ts';

function painter() {
  const operations = [], g = {};
  for (const method of ['moveTo', 'lineTo', 'poly', 'fill', 'stroke'])
    g[method] = (...args) => { operations.push({ method, args }); return g; };
  const renderer = new Renderer({}); renderer.camera.zoom = 100;
  renderer.trails = g;
  return { renderer, operations };
}
// The corners of every quad of a batch, in the world.
function corners(quads) {
  return Array.from({ length: quads.count * 4 }, (_, i) => ({ x: quads.positions[i * 2] + quads.x, y: quads.positions[i * 2 + 1] + quads.y,
    u: quads.uvs[i * 2], v: quads.uvs[i * 2 + 1] }));
}

test('a fast round that ends between display frames is drawn where it ended on the frame of its end, then leaves only its tracer', () => {
  const playback = new FramePresentation(), frame = time => ({ time, plates: [], modules: [] });
  playback.receive(frame(0), [], { now: 0 });
  const flight = { type: 'flight', id: 'fast', ammo: 'ap', terminal: true,
    points: [{ x: 1, y: 2, time: 0 }, { x: 6, y: 2, time: .005 }] };
  const original = structuredClone(flight);
  playback.receive(frame(1 / 60), [flight], { now: 20 });
  const sample = playback.present(playback.sample(40)), { renderer, operations } = painter();
  assert.equal(sample.shots.length, 1); assert.deepEqual([sample.shots[0].x, sample.shots[0].y], [6, 2], 'with what it met there');
  assert.equal(sample.shotTrails.length, 1);
  renderer.drawProjectiles(sample);
  assert.deepEqual(flight, original, 'presentation does not edit the recorded path');
  assert.equal(renderer.tails.count, 1); assert.equal(renderer.markers.count + renderer.glows.count, 0);
  const body = operations.filter(operation => operation.method === 'poly').flatMap(operation => operation.args[0]);
  assert(body.length > 0); for (let i = 0; i < body.length; i += 2) assert(body[i] <= 6 + 1e-9, 'the body does not pass where the round ended');
  for (const corner of corners(renderer.tails)) {
    assert(corner.x >= 1 - 1e-6 && corner.x <= 6 + 1e-6); assert(Math.abs(corner.y - 2) <= TAIL_WIDTH / 200 + 1e-6);
  }
  const later = playback.present(playback.sample(60)), next = painter();
  assert.equal(later.shots.length, 0); assert.equal(later.shotTrails.length, 1);
  next.renderer.drawProjectiles(later);
  assert.equal(next.renderer.tails.count, 1); assert.equal(next.operations.length, 0, 'a retired round has no phantom body');
});

test('the tails of a dense volley are a quad a chord, with no vector stroke for any shot', () => {
  const { renderer, operations } = painter(), trails = Array.from({ length: 128 }, (_, i) => ({
    id: `round-${i}`, ammo: i % 3 === 0 ? 'he' : 'ap', poweredTrail: i % 3 === 1,
    fade: 1, points: [{ x: i, y: 2, fade: .2 }, { x: i + 1, y: 2, fade: .6 }, { x: i + 2, y: 2, fade: 1 }],
  }));
  Object.assign(renderer.camera, { x: 64, y: 2, zoom: 4 });
  renderer.drawProjectiles({ shotTrails: trails, shots: [], traces: [] });
  assert.equal(renderer.tails.count, 256); assert.equal(operations.length, 0);
  const points = corners(renderer.tails);
  assert(points.every(point => Math.abs(point.y - 2) <= TAIL_WIDTH / 8 + 1e-6), 'a tail is 5.6 px wide');
  // The tail shows less the further it is from the round, and each kind of round has its own band of the texture.
  assert(points[0].u < points[2].u && points[2].u === points[4].u && points[4].u < points[6].u);
  assert.equal(new Set(points.map(point => Math.floor(point.v * 8))).size, 3);
  // A sharp turn starts a new ribbon; a gentle one shares its corners.
  renderer.drawProjectiles({ shotTrails: [{ fade: 1, points: [{ x: 60, y: 2 }, { x: 62, y: 2 }, { x: 64, y: 2.1 }, { x: 64, y: 6 }] }], shots: [], traces: [] });
  const [a, b, c] = [0, 1, 2].map(i => corners(renderer.tails).slice(i * 4, i * 4 + 4));
  assert.deepEqual([a[2], a[3]].map(p => [p.x, p.y]), [b[0], b[1]].map(p => [p.x, p.y]));
  assert.notDeepEqual([b[2].x, b[2].y], [c[0].x, c[0].y]);
  // What the camera does not show is not drawn.
  renderer.camera.zoom = 100;
  renderer.drawProjectiles({ shotTrails: trails, shots: [{ id: 'gone', x: 400, y: 2, vx: 900, vy: 0, ammo: 'ap' }], traces: [] });
  assert(renderer.tails.count > 0 && renderer.tails.count < 30); assert.equal(operations.length, 0);
});

test('a moving primary has an oriented metal body while fragments remain invisible', () => {
  const { renderer, operations } = painter(), shot = { id: 'round', x: 7, y: 3, vx: 1000, vy: 0,
    ammo: 'ap', radius: .012, age: .01 }, original = structuredClone(shot);
  renderer.drawProjectiles({ shots: [shot], traces: [], shotTrails: [] });
  const polygons = operations.filter(op => op.method === 'poly');
  assert(polygons.length >= 3, 'body, nose and metal details are drawn');
  const coordinates = polygons.flatMap(op => op.args[0]);
  assert(coordinates.every(Number.isFinite));
  for (const polygon of polygons) for (let i = 0; i < polygon.args[0].length; i += 2)
    assert(polygon.args[0][i] <= shot.x + 1e-12, 'body does not protrude beyond its current tip');
  assert.equal(renderer.markers.count, 0, 'from near there is no far marker');
  assert.deepEqual(shot, original);
  for (const zoom of [1, 6, 100, 250]) {
    operations.length = 0; renderer.camera.zoom = zoom;
    const fragment = { id: 'chip', fragment: true, x: 8, y: 2, vx: 90, vy: 10, material: 'steel', age: .01 };
    renderer.drawProjectiles({ shots: [fragment], traces: [{ ...fragment, instantaneous: true, trace: true, length: 1 }], shotTrails: [] });
    assert.equal(operations.length, 0, 'neither a fragment body nor a legacy ray is painted');
    assert.equal(renderer.markers.count + renderer.glows.count + renderer.specks.count + renderer.speckGlows.count + renderer.tails.count, 0);
  }
});

test('from afar a round is a bright point with a dark rim, and the last arc of the player stays drawn', () => {
  const { renderer, operations } = painter(); Object.assign(renderer.camera, { x: 700, y: 300, zoom: 1 });
  const shot = { id: 'shell', x: 700, y: 300, vx: 120, vy: -40, ammo: 'he', radius: .04 };
  renderer.drawProjectiles({ shots: [shot], traces: [], shotTrails: [] });
  assert.equal(operations.length, 0, 'a glow and a rimmed core stand for the body');
  assert.deepEqual([renderer.markers.count, renderer.glows.count], [1, 1]); assert.equal(renderer.markers.alpha, .94);
  for (const [quads, half] of [[renderer.markers, MARKER_RADIUS], [renderer.glows, GLOW_RADIUS]])
    assert.deepEqual(corners(quads).map(point => [point.x - 700, point.y - 300]), [[-half, -half], [-half, half], [half, -half], [half, half]]);
  // Half way to the far view the body is still there, fading.
  renderer.camera.zoom = 6;
  renderer.drawProjectiles({ shots: [shot], traces: [], shotTrails: [] });
  assert(operations.filter(op => op.method === 'poly').length >= 3); assert.equal(renderer.markers.count, 1); assert.equal(renderer.markers.alpha, .47);
  operations.length = 0; Object.assign(renderer.camera, { x: 45, y: 15, zoom: 1 });
  const arc = { id: 'old', actorId: 'local', ammo: 'he', fade: .5, x: 90, y: 0, points: [{ x: 0, y: 0 }, { x: 45, y: 30 }, { x: 90, y: 0 }] };
  renderer.drawProjectiles({ state: { controlledActor: 'local' }, shots: [], traces: [], shotTrails: [], fallenArcs: [arc, { ...arc, actorId: 'opponent' }] });
  assert.equal(renderer.tails.count, 2, 'the arc of another gunner is not drawn');
  assert.equal(operations.filter(op => op.method === 'poly').length, 2, 'a ring where it ended');
  assert(operations.filter(op => op.method === 'stroke').every(op => op.args[0].alpha <= .5));
  const live = { fade: 1, points: arc.points.map(point => ({ ...point, fade: 1 })) };
  renderer.drawProjectiles({ shots: [], traces: [], shotTrails: [live] });
  const strong = corners(renderer.tails)[0].u;
  renderer.drawProjectiles({ state: { controlledActor: 'local' }, shots: [], traces: [], shotTrails: [], fallenArcs: [arc] });
  assert(corners(renderer.tails)[0].u < strong * .5, 'the fallen arc is fainter than a live tail');
});

test('of a long volley in view the newest rounds have bodies and the others are points in full strength, at any zoom', () => {
  const { renderer, operations } = painter(); Object.assign(renderer.camera, { x: 100, y: 50, zoom: 20 });
  const round = (i, extra = {}) => ({ id: `shot-${i}`, number: i, x: 90 + i * .1, y: 50, vx: 0, vy: 300, ammo: 'ap', radius: .01, age: 1, ...extra }),
    volley = Array.from({ length: 200 }, (_, i) => round(i)), chip = { id: 'chip', fragment: true, x: 100, y: 51, vx: 30, vy: 5, material: 'steel', age: .01 },
    // The rest of the rounds in view, as the presentation tells them: a place and a kind of the legend each.
    kinds = [{ ammo: 'ap' }, { ammo: 'he' }, { ammo: 'he', poweredTrail: true }],
    specks = { count: 5, x: Float32Array.of(95, 96, 97, 98, 99, 100), y: Float32Array.of(40, 40, 40, 40, 40, 40), kind: Uint32Array.of(0, 1, 2, 0, 1, 0), kinds },
    shells = () => operations.filter(op => op.method === 'poly' && op.args[0].length === 14).map(op => op.args[0]),
    draw = (shots, crowd) => { operations.length = 0; renderer.drawProjectiles({ shots, specks: crowd, traces: [], shotTrails: [] }); return shells(); };
  const bodies = draw([...volley, chip], specks);
  assert.equal(bodies.length, 64, 'no more bodies than a frame can draw');
  assert.deepEqual(bodies.map(shell => Math.round((shell[6] - 90) * 10)), Array.from({ length: 64 }, (_, i) => 136 + i), 'the newest, drawn in the order they are told');
  assert.deepEqual([renderer.specks.count, renderer.speckGlows.count], [141, 141], 'a point and a glow for each of the others, and for each speck of the buffers within their count');
  assert.deepEqual([renderer.specks.alpha, renderer.markers.alpha, renderer.markers.count], [.94, 0, 0], 'in full strength from near, where the far markers of the bodies are gone');
  assert.equal(operations.filter(op => op.method === 'poly' && op.args[0].length === 8).length, 64 * 2, 'only the primary body details are drawn');
  const points = corners(renderer.specks), glows = corners(renderer.speckGlows);
  assert.deepEqual([points[0].x, points[0].y, points[3].x, points[3].y].map(n => +n.toFixed(4)), [90 - MARKER_RADIUS / 20, 50 - MARKER_RADIUS / 20, 90 + MARKER_RADIUS / 20, 50 + MARKER_RADIUS / 20]);
  assert.deepEqual(points.slice(-4).map(p => +p.x.toFixed(4)), [98.7, 98.7, 99.3, 99.3], 'the last speck counted, and none past the count');
  assert.equal(new Set(glows.slice(-20).map(p => p.u)).size, 6, 'each kind of round glows in its own colour');
  assert.deepEqual(glows.slice(-20, -16).map(p => p.u), glows.slice(-8, -4).map(p => p.u), 'two specks of one kind, one colour');
  // Within the bound nothing changes: every round in view has its body, and no point stands for any.
  assert.equal(draw(volley.slice(0, 64)).length, 64); assert.equal(renderer.specks.count, 0);
  // Rounds out of view take no body from those in view.
  assert.equal(draw([...volley.slice(0, 64), ...Array.from({ length: 100 }, (_, i) => round(i, { y: 900 }))]).length, 64); assert.equal(renderer.specks.count, 0);
  // Half way to the far view the bodies fade into their markers; the rounds past the bound are points in full already.
  renderer.camera.zoom = 6;
  assert.equal(draw(volley.slice(0, 80)).length, 64);
  assert.deepEqual([renderer.markers.count, renderer.markers.alpha, renderer.specks.count, renderer.specks.alpha], [64, .47, 16, .94]);
  // From afar there is no body at all: told whole or as specks, every round is the same point.
  renderer.camera.zoom = 2;
  assert.equal(draw(volley.slice(0, 80), specks).length, 0);
  assert.deepEqual([renderer.markers.count, renderer.markers.alpha, renderer.specks.count, renderer.specks.alpha], [64, .94, 16 + 5, .94]);
});

test('the lead on a moving vehicle is where it will be when the round arrives, and holds while the aim is carried to it', () => {
  const renderer = new Renderer({}); renderer.camera.zoom = 4;
  const state = { controlledActor: 'local', actors: [{ id: 'local', vehicle: { x: 0, y: 2, vx: 6, vy: 0 } },
    { id: 'still', vehicle: { x: 300, y: 2, vx: 0, vy: 0 } }, { id: 'runner', vehicle: { x: 500, y: 3, vx: -8, vy: .5 } }, { id: 'bench' }] };
  renderer.aim = { x: 502, y: 4 };
  const lead = renderer.movingTarget(state, 20);
  // It goes from where the frame draws the vehicle: here, with no state before, where its state has it.
  assert.deepEqual(lead.to, { x: 340, y: 13 }); assert.deepEqual([lead.from.x, lead.from.y], [500, 3]);
  renderer.aim = { x: 345, y: 10 }; assert.deepEqual(renderer.movingTarget(state, 20).to, { x: 340, y: 13 }, 'the aim carried to the lead keeps it');
  renderer.aim = { x: 420, y: 5 }; assert.equal(renderer.movingTarget(state, 20), null, 'an aim on neither has no lead');
  renderer.aim = { x: 300, y: 2 }; assert.equal(renderer.movingTarget(state, 20), null, 'a vehicle at rest needs none');
  renderer.aim = { x: 1, y: 2 }; assert.equal(renderer.movingTarget(state, 20), null, 'nor does the gunner');
  // On the shared field neither a construction of the gunner's faction nor a wreck is led.
  const sided = runner => ({ ...state, actors: state.actors.map(actor => actor.id === 'local' ? { ...actor, team: 'green' } : actor.id === 'runner' ? { ...actor, ...runner } : actor) });
  renderer.aim = { x: 502, y: 4 }; assert.equal(renderer.movingTarget(sided({ team: 'green' }), 20), null);
  assert.equal(renderer.movingTarget(sided({ team: 'red', defeated: true }), 20), null);
  assert(renderer.movingTarget(sided({ team: 'red' }), 20));
});
