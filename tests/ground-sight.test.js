import test from 'node:test';
import assert from 'node:assert/strict';
import { GroundSight, ViewSight, eyeSweep, eyeColumn, merged, unite, contains, within, clip, quantise, apart, SIGHT_STEP, SIGHT_CELL, EYE_SLACK, EYE_RISE, GROUND_AIR } from '../src/ground-sight.ts';
import { Terrain } from '../src/terrain.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';

const eyeGround = (ground, eye) => eyeSweep(ground, eye, false).spans;

// A ground of straight stretches between corners, each on a line the sweep reads a height on, with every height read counted.
function ground(corners, ends = {}) {
  const made = { reads: [], ...ends, height(x) {
    made.reads.push(x);
    if (x <= corners[0][0]) return corners[0][1];
    for (let i = 1; i < corners.length; i++) if (x <= corners[i][0]) {
      const [ax, ay] = corners[i - 1], [bx, by] = corners[i]; return ay + (by - ay) * (x - ax) / (bx - ax);
    }
    return corners.at(-1)[1];
  } };
  return made;
}
const level = () => ground([[0, 0]]);
// Where straight ground from (ax, ay) to (bx, by) goes out of the circle of `reach` about an eye.
const leaves = (eye, reach, [ax, ay], [bx, by]) => { const dx = bx - ax, dy = by - ay, fx = ax - eye.x, fy = ay - eye.y,
  a = dx * dx + dy * dy, b = fx * dx + fy * dy, c = fx * fx + fy * fy - reach * reach; return ax + dx * (-b + Math.sqrt(b * b - a * c)) / a; };
// How far along level ground an eye `up` metres over it sees, to a reach: where its circle meets the ground.
const along = (reach, up) => Math.sqrt(reach * reach - up * up);
const near = (spans, wanted, slack = 1e-9) => { assert.equal(spans.length, wanted.length, JSON.stringify(spans));
  for (const [i, span] of spans.entries()) for (const end of [0, 1]) assert(Math.abs(span[end] - wanted[i][end]) <= slack, `${JSON.stringify(spans)} against ${JSON.stringify(wanted)}`); };

test('stretches of ground are kept as spans: sorted, joined where they touch, cut, told apart and put on a grid', () => {
  assert.deepEqual(merged([[30, 40], [0, 10], [10, 12], [5, 8], [50, 50], [39, 45], [70, 60]]), [[0, 12], [30, 45]]);
  assert.deepEqual(merged([]), []);
  const spans = [[0, 12], [30, 45]];
  // A place is in a span from its one end to its other, and a stretch only when all of it is in one of them.
  for (const [x, held] of [[-1, false], [0, true], [6, true], [12, true], [12.01, false], [30, true], [45, true], [46, false]]) assert.equal(contains(spans, x), held, String(x));
  assert.equal(contains([], 3), false);
  assert.deepEqual([within(spans, 2, 12), within(spans, 2, 13), within(spans, 10, 32), within(spans, 31, 44), within(spans, 20, 21)], [true, false, false, true, false]);
  // Spans that are added nothing are the very list they were: whoever keeps them knows nothing changed.
  assert.equal(unite(spans, [[1, 2], [30, 45]]), spans); assert.equal(unite(spans, []), spans);
  const grown = unite(spans, [[11, 31], [60, 70]]);
  assert.deepEqual(grown, [[0, 45], [60, 70]]); assert.deepEqual(spans, [[0, 12], [30, 45]], 'what was united is left as it was');
  assert.deepEqual(clip([[0, 12], [30, 45], [60, 70]], 10, 65), [[10, 12], [30, 45], [60, 65]]);
  assert.deepEqual([clip(spans, 12, 30), clip(spans, -5, 100), clip(spans, 46, 100)], [[], spans, []]);
  // How far a place is from the nearest of them: nothing in one, and without end where there is none.
  assert.deepEqual([-7, 0, 6, 12, 15, 21, 27, 30, 45, 50].map(x => apart(spans, x)), [7, 0, 0, 0, 3, 9, 3, 0, 0, 5]); assert.equal(apart([], 3), Infinity);
  // On a grid a span is the cells whose middle it covers: the eight metres about 4 once 4 itself was seen.
  assert.deepEqual(quantise([[-1000, 1000]], 8), [[-1000, 1000]]); assert.deepEqual(quantise([[-1213, 787]], 8), [[-1216, 784]]);
  assert.deepEqual(quantise([[3.9, 4.1], [11, 11.9], [100, 115]], 8), [[0, 8], [96, 112]]);
  assert.deepEqual(quantise([[3.9, 4.1], [12, 12.1]], 8), [[0, 16]], 'cells that touch are one span');
  assert.deepEqual(quantise([[4.1, 11.9], [-3, 3.9]], 8), [], 'a stretch that covers the middle of no cell leaves nothing');
  assert.deepEqual(quantise([[-3, 5]], 8), [[0, 8]]);
  // Thin stretches that come over a cell one after another take it once one of them has its middle.
  let kept = [];
  for (let at = 0; at < 8; at += 1.5) kept = unite(kept, quantise([[at, at + 1.5]], 8));
  assert.deepEqual(kept, [[0, 8]]);
});

test('on level ground an eye sees to each side as far as its circle meets the ground', () => {
  const flat = level();
  assert.deepEqual(eyeGround(flat, { x: 10, y: 3, left: 400, right: 1000 }), [[10 - along(400, 3), 10 + along(1000, 3)]]);
  assert(flat.reads.length <= 1400 / SIGHT_STEP + 3 && flat.reads.length >= 1400 / SIGHT_STEP - 2, `${flat.reads.length} heights, one every ${SIGHT_STEP} m and the one under it`);
  assert(flat.reads.every(x => x >= -390 && x <= 1010), 'and none past its reach');
  // An eye that stands on a line a height is read on, or between two.
  near(eyeGround(level(), { x: 8, y: .5, left: 6, right: 6 }), [[8 - along(6, .5), 8 + along(6, .5)]]);
  near(eyeGround(level(), { x: 9.3, y: .5, left: 2, right: 31 }), [[9.3 - along(2, .5), 9.3 + along(31, .5)]]);
  // Two metres up the circle meets the ground some millimetres short of the reach: the stretch along it is as it was.
  assert(4000 - along(4000, 2) < 1e-3);
});

test('an eye high over the ground sees a narrower stretch of it, and none from higher than it reaches', () => {
  // An aircraft 2 km up with an optic of 4 km sees the ground within its circle: the square root of 4 squared less 2 squared
  // km to each side.
  const flat = level(), aloft = { x: 500, y: 2000, left: 4000, right: 4000 };
  near(eyeGround(flat, aloft), [[500 - along(4000, 2000), 500 + along(4000, 2000)]], 1e-6);
  assert(Math.abs(along(4000, 2000) - 3464.1016) < 1e-4);
  // 5 km up it sees no ground at all, under it or anywhere; just under its reach, a little under it.
  assert.deepEqual(eyeGround(level(), { ...aloft, y: 5000 }), []);
  near(eyeGround(level(), { ...aloft, y: 3999 }), [[500 - along(4000, 3999), 500 + along(4000, 3999)]], 1e-6);
  // A crest still hides what lies behind it from up there: a ridge a kilometre off, 1.5 km high, hides the ground past it
  // down to the line from the eye over its top, which meets the ground again at 6 km, far past the circle.
  const ridge = ground([[-10000, 0], [1000, 0], [1500, 1500], [2000, 0], [10000, 0]]), eye = { x: 0, y: 2000, left: 4000, right: 4000 };
  near(eyeGround(ridge, eye), [[-along(4000, 2000), 1500]], 1e-6);
});

test('a side the hull hides is not looked at, and a blind eye sees nothing', () => {
  const flat = level();
  assert.deepEqual(eyeGround(flat, { x: 100, y: 3, left: 0, right: 650 }), [[100, 100 + along(650, 3)]]);
  assert(flat.reads.every(x => x >= 100), 'no height is read behind it, but for the ground under it');
  assert.deepEqual(eyeGround(level(), { x: 100, y: 3, left: 650, right: 0 }), [[100 - along(650, 3), 100]]);
  assert.deepEqual(eyeGround(level(), { x: 100, y: 3, left: 0, right: 0 }), []);
});

test('a hill hides the valley behind it and shows the far slope that faces the eye', () => {
  // Level ground, a hill 20 m high with its top 200 m ahead, a valley, and a long slope that climbs half a metre a metre.
  const land = ground([[0, 0], [100, 0], [200, 20], [300, 0], [600, 0], [1000, 200]]), eye = { x: 0, y: 3, left: 0, right: 1000 };
  // The horizon is the top of the hill, 17 m over the eye at 200 m. The slope beyond comes over it where it stands
  // as steep from the eye: (x - 600) / 2 - 3 = .085 x; and it goes on up, out of the circle short of 1 000 m.
  const slope = [[600, 0], [1000, 200]], out = (y, reach = 1000) => leaves({ x: 0, y }, reach, ...slope);
  near(eyeGround(land, eye), [[0, 200], [303 / .415, out(3)]]);
  assert(out(3) > 980 && out(3) < 985);
  // Lower down the eye sees less of the far slope and higher up more of it; from 40 m, the far half of the valley
  // too; and from high enough to look down the back of the hill, all of the ground in its circle.
  const from = y => eyeGround(land, { ...eye, y });
  near(from(1), [[0, 200], [301 / .405, out(1)]]);
  near(from(10), [[0, 200], [310 / .45, out(10)]]);
  near(from(20), [[0, 200], [640, out(20)]]);
  near(from(40), [[0, 200], [400, out(40)]]);
  near(from(80), [[0, out(80)]]);
  // A reach that ends in the valley finds nothing past the hill.
  near(eyeGround(land, { ...eye, right: 500 }), [[0, 200]]);
  // And one that ends on the far slope, part of it.
  near(eyeGround(land, { ...eye, right: 800 }), [[0, 200], [303 / .415, out(3, 800)]]);
});

test('from the bottom of a valley an eye sees to the next crest, and from a crest far beyond it', () => {
  // Two crests 50 m high, 400 m apart, with a valley between them and long slopes down outside.
  const land = ground([[-400, 0], [0, 50], [200, 0], [400, 50], [800, 0]]);
  near(eyeGround(land, { x: 200, y: 2, left: 1000, right: 1000 }), [[0, 400]]);
  // Two metres over the crest: the valley and the slope across it to the other crest, and all the ground ahead in its circle.
  near(eyeGround(land, { x: 400, y: 52, left: 1000, right: 1000 }), [[0, 400 + along(1000, 52)]]);
  // Half way up the near slope: the crest above is the horizon, and nothing shows behind it.
  near(eyeGround(land, { x: 300, y: 27, left: 1000, right: 1000 }), [[0, 400]]);
});

test('on the ground of the game what an eye sees is what a straight line reaches within its circle', () => {
  const land = new Terrain(MAIN_WORLD.terrain, { seed: MAIN_WORLD.seed, length: MAIN_WORLD.mapLength, center: 12 }), points = land.points;
  assert.equal(land.spacing, SIGHT_STEP, 'the sweep reads the very points of the outline');
  // Whether the ground at x is within the circle of the eye and the line from the eye to it passes over every point of
  // the outline between them.
  const reached = (eye, x) => {
    const y = land.height(x), low = Math.min(eye.x, x), high = Math.max(eye.x, x);
    if (Math.hypot(x - eye.x, y - eye.y) > (x < eye.x ? eye.left : eye.right)) return false;
    for (let i = land.segmentIndex(low); i < points.length && points[i].x < high; i++) {
      const p = points[i]; if (p.x <= low) continue;
      if (p.y > eye.y + (y - eye.y) * (p.x - eye.x) / (x - eye.x) + 1e-6) return false;
    }
    return true;
  };
  let lost = 0, found = 0, spans = 0;
  for (const at of [-90000, -31007.3, 12, 20500, 45000, 77123.9, 120000]) for (const lift of [2.6, 9]) {
    const eye = { x: at, y: land.height(at) + lift, left: 1000, right: 650 }, seen = eyeGround(land, eye);
    spans += seen.length;
    assert(seen[0][0] >= at - 1000 - 1e-9 && seen.at(-1)[1] <= at + 650 + 1e-9); assert(contains(seen, at), 'the ground under the eye');
    for (let x = at - 999.5; x < at + 650; x += 7.3) {
      const told = contains(seen, x), edge = seen.some(span => Math.abs(span[0] - x) < .05 || Math.abs(span[1] - x) < .05);
      if (!edge) assert.equal(told, reached(eye, x), `from ${at} + ${lift} m, the ground at ${x.toFixed(1)}`);
      told ? found++ : lost++;
    }
  }
  assert(found > 500 && lost > 300 && spans > 30, `${found} places in sight and ${lost} hidden, in ${spans} spans`);
});

test('what a construction on the ground explores is what it explored when it saw as far as it reached along the ground', () => {
  const land = new Terrain(MAIN_WORLD.terrain, { seed: MAIN_WORLD.seed, length: MAIN_WORLD.mapLength, center: 12 }), points = land.points;
  // Whether the line from the eye to the ground at x passes over every point of the outline between them.
  const clear = (eye, x) => {
    const y = land.height(x), low = Math.min(eye.x, x), high = Math.max(eye.x, x);
    for (let i = land.segmentIndex(low); i < points.length && points[i].x < high; i++) {
      const p = points[i]; if (p.x > low && p.y > eye.y + (y - eye.y) * (p.x - eye.x) / (x - eye.x) + 1e-6) return false;
    }
    return true;
  };
  // The cells explored ground is kept by (server/room.ts `EXPLORED_GRID`), each taken when its middle is in sight: the same
  // as by the reach along the ground, but where the circle comes down short of it — by as little as a few metres where
  // the ground out there stands a hundred metres over or under the eye — and that is at the far end of the reach.
  let cells = 0, apart = 0;
  for (const at of [-90000, 12, 45000, 120000]) for (const [lift, reach] of [[2.2, 4000], [1.25, 650]]) {
    const eye = { x: at, y: land.height(at) + lift, left: reach, right: reach }, explored = quantise(new GroundSight(land).seen([{ id: 'car', eyes: [eye] }]), 8);
    for (let middle = Math.ceil((at - reach) / 8) * 8 + 4; middle < at + reach; middle += 8) {
      const far = Math.abs(middle - at), up = land.height(middle) - eye.y, short = reach - Math.sqrt(Math.max(0, reach * reach - up * up));
      cells++;
      if (contains(explored, middle) === (far <= reach && clear(eye, middle))) continue;
      apart++; assert(far > reach - short - 8, `from ${at}, the cell at ${middle}: ${far.toFixed(1)} m off, ${up.toFixed(1)} m up`);
    }
  }
  assert(cells > 4000 && apart <= 4, `${apart} of ${cells} cells`);
});

test('a construction with no eye sees no ground, not even what it stands on', () => {
  const sight = new GroundSight(level());
  assert.deepEqual(sight.seen([{ id: 'blind', eyes: [] }]), []); assert.equal(sight.ground.reads.length, 0, 'and no height is read for it');
  assert.deepEqual(sight.seen([]), []);
  // An eye its own armour hides on every side is no eye, and one that sees to one side only sees nothing of the ground behind it.
  assert.deepEqual(sight.seen([{ id: 'shut', eyes: [{ x: 501, y: 2, left: 0, right: 0 }] }]), []);
  assert.deepEqual(sight.seen([{ id: 'car', eyes: [{ x: 501, y: 2, left: 0, right: 650 }] }]), [[501, 501 + along(650, 2)]]);
  // The ground ends where the field does.
  assert.deepEqual(new GroundSight(ground([[0, 0]], { minX: 480, maxX: 900 })).seen([{ id: 'car', eyes: [{ x: 501, y: 2, left: 0, right: 650 }] }]), [[501, 900]]);
});

test('what several eyes and several constructions see is one list of spans', () => {
  const land = ground([[0, 0], [100, 0], [200, 20], [300, 0], [600, 0], [1000, 200]]), far = 303 / .415, slope = [[600, 0], [1000, 200]],
    out = leaves({ x: 0, y: 3 }, 1000, ...slope), scout = { id: 'scout', x: 0, eyes: [{ x: 0, y: 3, left: 0, right: 1000 }] };
  near(new GroundSight(land).seen([scout]), [[0, 200], [far, out]]);
  // A second eye of the same construction, looking back; another construction in the valley, which sees its two slopes;
  // and one with no eye far off, which adds nothing.
  const both = { ...scout, eyes: [...scout.eyes, { x: -1, y: 2, left: 300, right: 0 }] },
    sunk = { id: 'sunk', x: 450, eyes: [{ x: 450, y: 2, left: 400, right: 400 }] }, away = { id: 'away', x: 2000, eyes: [] };
  near(new GroundSight(land).seen([both]), [[-1 - along(300, 2), -1], [0, 200], [far, out]]);
  // The one in the valley alone: from its hollow, the back of the hill up to its top and the far slope as far as it reaches.
  near(new GroundSight(land).seen([sunk]), [[200, leaves({ x: 450, y: 2 }, 400, ...slope)]]);
  // All of them: what the scout loses behind the hill the one in the valley has, and the two are one stretch.
  near(new GroundSight(land).seen([both, sunk, away]), [[-1 - along(300, 2), -1], [0, out]]);
});

test('an eye that stands where it stood is not swept again, and its far ends go with it', () => {
  const land = ground([[0, 0], [100, 0], [200, 20], [300, 0], [600, 0], [1000, 200]]), sight = new GroundSight(land),
    at = (x, y = 3, reach = 500) => [{ id: 'scout', x, eyes: [{ x, y, left: reach, right: reach }] }], reads = () => land.reads.length;
  const first = sight.seen(at(0)), swept = reads();
  near(first, [[-along(500, 3), 200]]); assert(swept > 200);
  // Asked again as it was: the very answer, and not a height read.
  assert.equal(sight.seen(at(0)), first); assert.equal(sight.seen(at(0).map(c => ({ ...c, eyes: c.eyes.map(eye => ({ ...eye })) }))), first);
  assert.equal(reads(), swept);
  // It goes a metre and a half: nothing is read, the ends of its reach are a metre and a half on, and the hill hides what it hid.
  const moved = sight.seen(at(1.5));
  assert.equal(reads(), swept); near(moved, [[1.5 - along(500, 3), 200]]); assert.notEqual(moved, first);
  assert.equal(sight.seen(at(1.5)), moved);
  // Past the slack it is swept from where it stands now; so it is when it rises, or reaches another distance.
  assert(EYE_SLACK === 2 && EYE_RISE === .5);
  near(sight.seen(at(2.5)), [[2.5 - along(500, 3), 200]]); const again = reads(); assert(again > swept + 200);
  // A little higher is the same eye, and the edge of its circle is where it now stands: not a height read.
  near(sight.seen(at(3.5, 3.4)), [[3.5 - along(500, 3.4), 200]]); assert.equal(reads(), again, 'a little higher is the same eye');
  sight.seen(at(3.5, 3.6)); const risen = reads(); assert(risen > again + 200);
  // With a longer reach it comes to the far slope, over the top of the hill: 16.4 m up in 196.5 m.
  const horizon = 16.4 / 196.5;
  near(sight.seen(at(3.5, 3.6, 900)), [[3.5 - along(900, 3.6), 200], [(303.6 - 3.5 * horizon) / (.5 - horizon), leaves({ x: 3.5, y: 3.6 }, 900, [600, 0], [1000, 200])]]);
  const reached = reads(); assert(reached > risen + 400);
  // A construction that left is forgotten, and swept anew when it comes back; another's eyes are its own.
  sight.seen([]); sight.seen(at(3.5, 3.6, 900)); assert(reads() > reached + 400);
  const kept = reads(); sight.seen([...at(3.5, 3.6, 900), { id: 'other', x: 3.5, eyes: [{ x: 3.5, y: 3.6, left: 900, right: 900 }] }]);
  assert(reads() > kept + 400); const two = reads();
  sight.seen([...at(3.5, 3.6, 900), { id: 'other', x: 3.5, eyes: [{ x: 3.5, y: 3.6, left: 900, right: 900 }] }]); assert.equal(reads(), two);
  // Here what the kept eye was said to see is what one swept anew at its place sees: the hill hid the same ground from both.
  near(new GroundSight(land).seen(at(1.5)), moved);
});

// A run of the air an eye sees, or none: its ends alike, to a slack.
const same = (got, wanted, slack = 1e-9) => { assert.equal(got?.length, wanted?.length, JSON.stringify(got));
  if (got) for (const [i, end] of got.entries()) assert(end === wanted[i] || Math.abs(end - wanted[i]) <= slack, `${got} against ${wanted}`); };

test('an eye sees the air over a place from the line over its horizon, or from under the ground in sight, as far up as along', () => {
  // Level ground, a hill 20 m high with its top 200 m ahead, a valley and a long slope beyond: the hill of the test above.
  const land = ground([[0, 0], [100, 0], [200, 20], [300, 0], [600, 0], [1000, 200]]), eye = { x: 0, y: 3, left: 0, right: 1000 },
    saw = { ...eye, ...eyeSweep(land, eye) }, column = (x, at = eye) => eyeColumn(at, saw, x, land.height(x));
  // The sweep reads its first height four metres on, and keeps at each height the crest of the horizon there.
  const { left, right } = saw.horizon;
  assert.deepEqual([right.first, right.crests.length / 2, left.crests.length], [SIGHT_STEP, 250, 0]);
  assert.deepEqual(right.crests.slice(2 * 60, 2 * 60 + 2), [200, 17], 'at 244 m the top of the hill');
  near(saw.spans, eyeGround(land, eye)); assert.equal(eyeSweep(land, eye, false).horizon, undefined, 'told not to, it keeps no crests');
  // Before the hill the ground is in sight, and the air over it up to where the reach ends: as far up as along.
  same(column(150), [-Infinity, 3 + Math.sqrt(1000 ** 2 - 150 ** 2)]);
  // Behind it, from the line over its top: 17 m up in 200 m from the eye, 28.5 m over the valley at 300 m.
  same(column(300), [3 + 17 * 1.5, 3 + Math.sqrt(1000 ** 2 - 300 ** 2)]);
  // The far slope comes out over that line, and is in sight, till it rises out of the circle at 982 m: out of sight there,
  // with none of the air of the circle over it.
  same(column(900), [-Infinity, 3 + Math.sqrt(1000 ** 2 - 900 ** 2)]); same(column(980), [-Infinity, 3 + Math.sqrt(1000 ** 2 - 980 ** 2)]);
  assert.deepEqual([column(990), column(1000)], [null, null]);
  // Past the reach and to a side the hull hides, nothing; under the eye, all of the air up to its reach.
  assert.deepEqual([column(1000.5), column(-5)], [null, null]); same(column(0), [-Infinity, 1003]);
  // A reach that ends under the line over the hill: nothing over the valley.
  assert.equal(column(560, { ...eye, right: 561 }), null);
  // An eye gone a little on and up from where it was swept turns the line about the same crest.
  const moved = { ...eye, x: 1.5, y: 3.3 };
  same(column(300, moved), [3.3 + (20 - 3.3) * 298.5 / 198.5, 3.3 + Math.sqrt(1000 ** 2 - 298.5 ** 2)]);
  // One that stands on a crest it was swept from below, or past it, has it from where it was swept.
  const bump = ground([[0, 0], [4, 6], [8, 0]]), low = { x: 0, y: 1, left: 0, right: 100 }, swept = { ...low, ...eyeSweep(bump, low) };
  same(eyeColumn({ ...low, x: 3.5, y: 7 }, swept, 50, 0), [1 + 5 * 50 / 4, 7 + Math.sqrt(100 ** 2 - 46.5 ** 2)]);
  // High over the ground it sees the air under it as over it, down to the foot of its circle where the ground lies under
  // that: 2 km up with a reach of 4 km, all of the circle over the ground under it, and 3.5 km off only the air over the
  // foot of the circle there, 63.5 m up. 5 km up, no ground, and the air under it down to a kilometre over the ground.
  const flat = level(), high = { x: 0, y: 2000, left: 4000, right: 4000 }, from = { ...high, ...eyeSweep(flat, high) },
    higher = { ...high, y: 5000 }, fromHigher = { ...higher, ...eyeSweep(flat, higher) };
  same(eyeColumn(high, from, 0, 0), [-Infinity, 6000]);
  same(eyeColumn(high, from, 3500, 0), [2000 - Math.sqrt(4000 ** 2 - 3500 ** 2), 2000 + Math.sqrt(4000 ** 2 - 3500 ** 2)]);
  same(eyeColumn(high, from, -3464, 0), [-Infinity, 2000 + Math.sqrt(4000 ** 2 - 3464 ** 2)]);
  same(eyeColumn(higher, fromHigher, 0, 0), [1000, 9000]); same(eyeColumn(higher, fromHigher, 3000, 0), [5000 - Math.sqrt(7e6), 5000 + Math.sqrt(7e6)]);
});

test('the sight over a view is by cells laid on the world: its eyes, the ground in sight and the domes of what sees without them', () => {
  const land = ground([[-1000, 0], [100, 0], [200, 20], [300, 0], [600, 0], [1000, 200], [3000, 200]]), sight = new GroundSight(land, { horizon: true });
  sight.seen([{ id: 'scout', eyes: [{ x: 0, y: 3, left: 600, right: 600 }] }]);
  // Told to, it keeps by each eye what it swept; a GroundSight that is not — the field's — keeps no crests.
  assert.equal(sight.looking.length, 1); assert.deepEqual(Object.keys(sight.looking[0]), ['eye', 'saw']); assert(sight.looking[0].saw.horizon.right.crests.length > 0);
  const bare = new GroundSight(land); bare.seen([{ id: 'scout', eyes: [{ x: 0, y: 3, left: 600, right: 600 }] }]);
  assert.deepEqual([bare.looking, bare.kept.get('scout:0').horizon], [[], undefined]);
  const fog = { seen: sight.answer, eyes: sight.looking, domes: [{ x: -900, y: 0, reach: 50 }] }, camera = { x: 250, y: 20, zoom: 2, width: 800, height: 400 },
    view = new ViewSight().frame(camera, fog, land), cell = SIGHT_CELL / camera.zoom;
  // Eight pixels a cell, the screen and one more past each edge, and one more on the side they begin on.
  assert.deepEqual([view.cell, view.columns, view.rows, view.first, view.bottom], [4, 103, 53, Math.floor((250 - 200) / 4) - 1, Math.floor((20 - 100) / 4) - 1]);
  assert.equal(cell, 4);
  // Over the valley behind the hill it sees from the line over its top; over the slope before it, all the air.
  assert.deepEqual([[100, 1], [250, 5], [250, 25], [400, 30], [400, 40], [550, 100], [-50, 500]].map(([x, y]) => view.sees(x, y)), [true, false, true, false, true, true, true]);
  const valley = view.runs[Math.floor(300 / cell) - view.first];
  assert.equal(valley.length, 2); assert(Math.abs(valley[0] - (3 + 17 * 302 / 200)) < 1e-9, 'the middle of the cell, at 302 m');
  // The same cells wherever the view stands: one a little along has its columns on the same places.
  const along = new ViewSight().frame({ ...camera, x: 251.3 }, fog, land);
  assert.deepEqual(along.runs[10 + view.first - along.first], view.runs[10]);
  // A dome of air with no eye under it, as high as it is wide (32 m off its middle, 38.4 m up); and where nothing sees, nothing.
  const far = new ViewSight().frame({ ...camera, x: -900, y: 0, zoom: 1 }, fog, land);
  assert.deepEqual([far.sees(-900, 49), far.sees(-900, 51), far.sees(-932, 38), far.sees(-932, 39), far.sees(-960, 0)], [true, false, true, false, false]);
  // Ground in sight with no eye over it — told so by the field — is in sight to the air just over it.
  const told = new ViewSight().frame({ ...camera, x: -900, y: 0, zoom: 1 }, { seen: [[-1000, -980]], eyes: [], domes: [] }, land);
  assert.deepEqual([told.sees(-990, -40), told.sees(-990, GROUND_AIR - .5), told.sees(-990, GROUND_AIR + 4.5)], [true, true, false]);
  // Of each cell from the lowest row, 1 out of sight and 0 in it; a place off the cells goes by the nearest column.
  const cover = view.cover(new Float32Array(view.columns * view.rows)), at = (x, y) => cover[(Math.floor(y / cell) - view.bottom) * view.columns + Math.floor(x / cell) - view.first];
  assert.deepEqual([at(250, 5), at(250, 25), at(100, -60), at(300, -60)], [1, 0, 0, 1]);
  assert.equal(view.sees(-1e6, 5), view.sees((view.first + .5) * cell, 5));
});
