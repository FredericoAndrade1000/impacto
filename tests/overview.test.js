import test from 'node:test';
import assert from 'node:assert/strict';
import { Overview, overviewRange, overviewSpan, overviewScale, overviewPath, shotReach } from '../src/overview.ts';
import { Terrain } from '../src/terrain.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { packShots } from '../src/shots.ts';
import { EncounterBands } from '../src/encounter-bands.ts';
import { Fog, chapters, GHOST_SECONDS } from '../server/fog.ts';

// A strip 400 pixels wide whose painting is only counted: each call, and the tint it filled with and how opaque.
function strip() {
  const calls = [], set = {}, context = new Proxy({}, { get: (_, name) => (...args) => { calls.push({ name, args, tint: set.fillStyle, stroke: set.strokeStyle, alpha: set.globalAlpha }); },
      set: (_, name, value) => { set[name] = value; return true; } }),
    canvas = { clientWidth: 400, clientHeight: 64, width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ left: 10, width: 400 }) },
    label = { textContent: '' }, element = { hidden: true, querySelector: selector => selector === 'canvas' ? canvas : label };
  return { overview: new Overview(element), element, label, calls };
}

const boxes = calls => calls.flatMap((call, i) => {
  if (call.name !== 'rect' || call.args[2] !== call.args[3]) return [];
  const [x, y, wide, tall] = call.args, filled = calls[i + 1].name === 'fill';
  return [{ x: x + wide / 2, y: y + tall, wide, filled,
    tint: filled ? calls[i + 1].tint : calls[i + 2].stroke, alpha: calls[i + 1].alpha,
    braces: filled ? [] : calls.slice(i + 4, i + 8).map(one => [one.name, ...one.args]) }];
});

// The fixed symbol's horizontal foot is drawn with its own contrast edge and faction-colour core.
const foundations = calls => calls.flatMap((call, i) => call.name === 'moveTo' && calls[i + 1]?.name === 'lineTo' &&
  call.args[1] === calls[i + 1].args[1] && calls[i + 2]?.name === 'stroke' && calls[i + 3]?.name === 'stroke'
  ? [{ from: call.args, to: calls[i + 1].args, tint: calls[i + 3].stroke, alpha: calls[i + 3].alpha }] : []);

test('fixed defences span the overview and use square marks with the same faction colours as vehicles', () => {
  const made = strip(), ground = { minX: -32000, maxX: 32000, height: () => 100 }, camera = { x: 0, zoom: 4, width: 1200 },
    fixed = (id, x, ownerId, team, extra = {}) => ({ id, x, ownerId, team, vehicle: null, ...extra }),
    state = { shared: true, time: 5, controlledActor: 'own', localPlayerId: 'me',
      faction: { id: 'green', base: { x: 25000, radius: 100 } }, actors: [
        fixed('own', -6000, 'me', 'green'), fixed('second', -3000, 'me', 'green'), fixed('ally', 1000, 'friend', 'green'),
        fixed('enemy', 5000, 'foe', 'red'), fixed('wreck', 7000, 'foe', 'red', { defeated: true }),
        { id: 'truck', ownerId: 'me', team: 'green', vehicle: { x: 0, y: 101 } }, { id: 'bench' },
      ] }, before = structuredClone(state);
  made.overview.draw({ ground, camera, state });
  assert(made.overview.lo < -6000 && made.overview.hi > 7000, 'fixed actors outside the camera open the strip too');
  const marks = boxes(made.calls), at = x => (x - made.overview.lo) / (made.overview.hi - made.overview.lo) * 400;
  assert.equal(marks.length, 5); assert(marks.every(mark => mark.filled && mark.alpha === 1));
  assert.deepEqual(marks.map(mark => mark.tint), ['#ffd095', '#b4d28b', '#b4d28b', '#eba383', '#8f9a93']);
  for (const [i, x] of [-6000, -3000, 1000, 5000, 7000].entries()) assert(Math.abs(marks[i].x - at(x)) < 1e-9);
  assert.equal(marks[0].wide, 8.8); assert.equal(marks[1].wide, 7.2, 'the focus stays larger, independent of world scale');
  assert.equal(made.calls.filter(call => call.name === 'fill' && call.tint === '#b4d28b').length, 3, 'the mobile vehicle keeps its triangle');
  const feet = foundations(made.calls); assert.equal(feet.length, marks.length, 'only fixed actors have a ground foot, including the fixed wreck');
  for (const [i, foot] of feet.entries()) {
    assert.equal(foot.tint, marks[i].tint); assert.equal(foot.alpha, marks[i].alpha);
    assert(Math.abs((foot.from[0] + foot.to[0]) / 2 - marks[i].x) < 1e-9);
    assert(Math.abs(foot.to[0] - foot.from[0] - marks[i].wide - 3) < 1e-9);
    assert.equal(foot.from[1], marks[i].y + 1.5);
  }
  assert.equal(made.calls.find(call => call.name === 'fillText').args[0], 'base ' + overviewSpan(31000), 'base distance also works while controlling a fixed defence');
  assert.deepEqual(state, before);
});

test('on the proving ground a target put out of action is marked as the wreck it is, as on the field', () => {
  const made = strip(), ground = { minX: -3000, maxX: 3000, height: () => 0 }, camera = { x: 0, zoom: 4, width: 1200 },
    target = (id, x, extra = {}) => ({ id, x, ownerId: 'alvo', team: 'alvo', vehicle: null, ...extra }),
    state = { time: 5, actors: [{ id: 'local', ownerId: 'local', x: 12, vehicle: null }, target('alvo-0', -138), target('alvo-1', -288, { ownerId: null, defeated: true })] };
  made.overview.draw({ ground, camera, state });
  assert.deepEqual(boxes(made.calls).map(mark => mark.tint), ['#ffd095', '#eba383', '#8f9a93']);
});

test('the overview follows real fog admission: unseen and radar-only defences are absent and ghosts retain their last position and work state', () => {
  const fog = new Fog(), ground = { minX: -32000, maxX: 32000, height: () => 0 }, camera = { x: 0, zoom: 4, width: 1200 },
    own = { id: 'own', ownerId: 'me', team: 'green', x: 0, vehicle: null }, ally = { id: 'ally', team: 'green', x: 40, vehicle: null },
    radar = { id: 'radar', team: 'red', x: -12000, vehicle: null };
  let enemy = { id: 'enemy', team: 'red', x: 6000, vehicle: null, field: { service: { kind: 'build', until: 50 } } };
  const told = time => {
    const state = { shared: true, time, localPlayerId: 'me', faction: { id: 'green' },
      actors: [own, ally, enemy, radar], plates: [], modules: [], bodyPanels: [], attachments: [] };
    return fog.tell(state, chapters(state), 'green');
  }, draw = state => { const made = strip(); made.overview.draw({ ground, camera, state }); return { ...made, marks: boxes(made.calls) }; };
  const hidden = draw(told(0));
  assert.equal(hidden.marks.length, 2); assert(hidden.overview.hi < 1000 && hidden.overview.lo > -1000);
  fog.read({ sight: { green: [{ actorId: 'enemy', channel: 'visual', visible: true, x: 6000, y: 1, by: 'own', error: 0 },
    { actorId: 'radar', channel: 'radar', x: -12000, y: 1, by: 'own', error: 20 }] } }, .1);
  const seen = draw(told(.1));
  assert.equal(seen.marks.length, 3); assert.equal(seen.marks[2].filled, false); assert.equal(seen.marks[2].alpha, 1);
  assert(seen.overview.hi > 6000 && seen.overview.lo > -12000, 'a radar contact is not promoted to an exact defence mark');
  enemy = { ...enemy, x: 20000, field: null };
  fog.read({ sight: { green: [] } }, 1);
  const memory = told(1), remembered = draw(memory), ghost = memory.actors.find(actor => actor.id === 'enemy');
  assert.equal(ghost.x, 6000); assert(ghost.ghost); assert.equal(remembered.marks[2].filled, false, 'completion while unseen is not revealed');
  assert(remembered.marks[2].alpha > 0 && remembered.marks[2].alpha < 1);
  assert.equal(foundations(remembered.calls).length, 2, 'remembered work keeps its open braces rather than revealing a finished fixed symbol');
  assert(remembered.overview.hi > 6000 && remembered.overview.hi < 10000, 'neither the hidden current place nor its completion expands the strip');
  const gone = draw(told(GHOST_SECONDS + 1));
  assert.equal(gone.marks.length, 2); assert(gone.overview.hi < 1000);
});

// A heap is a low bar of its own tint on the strip.
const bars = calls => calls.flatMap((call, i) => call.name === 'rect' && call.args[2] === 7 && call.args[3] === 3
  ? [{ x: call.args[0] + 3.5, tint: calls[i + 1].tint }] : []);

test('airdrop UI overview frames one public marker despite crowded natural deposits and removes it on cleanup', () => {
  const { overview, calls } = strip(), ground = { minX: -32000, maxX: 32000, height: () => 0 },
    camera = { x: 0, y: 100, zoom: 4, width: 1200 }, activity = { id: 'airdrop:1', x: 18000 },
    state = { shared: true, time: 220, actors: [], faction: { activity } },
    natural = Array.from({ length: 80 }, (_, index) => ({ x: -500 + index * 12, material: 'ferro', share: .5, active: true })),
    deposit = { type: 'airdrop', x: activity.x, material: 'ferro', share: 0, active: true },
    before = structuredClone({ state, natural, deposit });
  overview.draw({ ground, camera, state, deposits: [...natural, deposit] });
  assert(overview.lo < camera.x && overview.hi > activity.x, 'the public point outside the initial camera expands the strip');
  const marks = boxes(calls);
  assert.equal(marks.length, 1, 'dense natural deposits never suppress the single public square');
  assert.equal(marks[0].wide, 6); assert.equal(marks[0].filled, true); assert.equal(marks[0].tint, '#b98a6a');
  const pixel = (activity.x - overview.lo) / (overview.hi - overview.lo) * 400;
  assert(Math.abs(marks[0].x - pixel) < 1e-9); assert(Math.abs(overview.worldX(10 + pixel) - activity.x) < 1e-8);
  const previousHi = overview.hi;
  calls.length = 0;
  const supplied = { type: 'airdrop', x: activity.x, supplied: true, share: 0, active: true };
  overview.draw({ ground, camera, state, deposits: [...natural, supplied] });
  assert.equal(boxes(calls).length, 1); assert.equal(boxes(calls)[0].tint, '#cbbd8a',
    'a mixed supplied event has its own existing neutral tint without inventing a CARGO material');
  assert.equal(Object.hasOwn(supplied, 'material'), false);
  calls.length = 0;
  overview.draw({ ground, camera, state: { ...state, faction: { activity: null } }, deposits: natural });
  assert.deepEqual(boxes(calls), []); assert(overview.hi < previousHi);
  assert.deepEqual({ state, natural, deposit }, before);
});

test('the works of the faction have an open crossed mark and its heaps a low bar, for as long as the faction is told of them', () => {
  const made = strip(), ground = { minX: -32000, maxX: 32000, height: () => 0 }, camera = { x: 0, zoom: 4, width: 1200 },
    state = { shared: true, time: 5, localPlayerId: 'me', faction: { id: 'green', units: [],
      works: [{ id: 'c4', name: 'Posto', x: 5000, progress: .3 }], heaps: [{ id: 'c2', x: -4000, stock: { ferro: 4216, ligas: 0, silica: 0, combustivel: 0 } }] },
    actors: [{ id: 'truck', ownerId: 'me', team: 'green', vehicle: { x: 0, y: 1 } },
      { id: 'base-work', ownerId: 'me', team: 'green', vehicle: { x: -2600, y: 1 }, field: { service: { kind: 'build', until: 30 } } }] },
    before = structuredClone(state);
  made.overview.draw({ ground, camera, state });
  const marks = boxes(made.calls), at = x => (x - made.overview.lo) / (made.overview.hi - made.overview.lo) * 400;
  assert.equal(marks.length, 2); assert(marks.every(mark => !mark.filled && mark.tint === '#b4d28b'));
  assert(made.overview.lo < -4000 && made.overview.hi > 5000 && made.overview.hi < 10000, 'the works and the heaps open the strip');
  assert(Math.abs(marks[1].x - at(5000)) < 1e-9, 'the works is marked where it stands');
  for (const mark of marks) {
    const half = mark.wide / 2;
    assert.deepEqual(mark.braces, [['moveTo', mark.x - half, mark.y - mark.wide], ['lineTo', mark.x + half, mark.y],
      ['moveTo', mark.x + half, mark.y - mark.wide], ['lineTo', mark.x - half, mark.y]]);
  }
  assert.deepEqual(bars(made.calls).map(bar => [Math.round(bar.x - at(-4000)), bar.tint]), [[0, '#cbbd8a']]);
  assert.deepEqual(state, before);
  // Put up, a works is the structure it became; collected, a heap is gone: neither leaves a mark of its own.
  made.calls.length = 0;
  made.overview.draw({ ground, camera, state: { ...state, faction: { ...state.faction, works: [], heaps: [] },
    actors: [{ id: 'c4', ownerId: 'me', team: 'green', x: 5000, vehicle: null, field: null }] } });
  assert.deepEqual(boxes(made.calls).map(mark => mark.filled), [true]); assert.deepEqual(bars(made.calls), []);
});

test('fixed actors and own sites on unexplored ground reveal no terrain height and local fixed tests still have a mark', () => {
  const made = strip(), ground = { minX: -32000, maxX: 32000, height: () => { assert.fail('unexplored terrain must not be sampled'); } },
    camera = { x: 0, zoom: 4, width: 1200 }, actor = { id: 'local', x: 100, y: 900, vehicle: null },
    state = { shared: true, time: 1, controlledActor: 'local', actors: [actor, { id: 'bench' }, { id: 'bad', x: NaN }],
      faction: { works: [{ id: 'c1', x: 400, progress: 0 }], heaps: [{ id: 'c0', x: -300, stock: { ferro: 10 } }] } };
  made.overview.draw({ ground, camera, state, fog: { explored: [], seen: [] } });
  assert.deepEqual(boxes(made.calls).map(mark => [mark.y, mark.filled]), [[52, true], [52, false]], 'known positions stay on the undisclosed flat line');
  assert.equal(bars(made.calls).length, 1);
  const local = strip(); local.overview.draw({ ground: { ...ground, height: () => 0 }, camera,
    state: { actors: [actor], faction: state.faction, time: 1 } });
  assert.deepEqual(boxes(local.calls).map(mark => [mark.tint, mark.filled]), [['#ffd095', true]], 'private trials do not inherit faction work sites');
  assert.deepEqual(bars(local.calls), []);
});

test('the overview spans what is worth seeing at once: no less than its narrowest stretch, no more than the field', () => {
  const ground = { minX: -32000, maxX: 32000 };
  assert.deepEqual(overviewRange(ground, [0, 100]), { lo: -700, hi: 800 });
  assert.deepEqual(overviewRange(ground, [-5000, NaN, 15000]), { lo: -6600, hi: 16600 }, 'a margin either side of a long stretch');
  assert.deepEqual(overviewRange(ground, [31900, 40000]), { lo: 31900 - 648, hi: 32000 }, 'the strip ends where the field does');
  assert.equal(overviewSpan(850), '850 m'); assert.equal(overviewSpan(12340), '12,3 km');
});

test('encounters expand the minimap beyond the camera and tint small columns beneath readable marks', () => {
  const { overview, calls } = strip(), ground = { minX: -32000, maxX: 32000, height: () => 0 },
    camera = { x: 0, y: 100, zoom: 4, width: 1200 },
    state = { actors: [{ id: 'local', vehicle: { x: 0, y: 1 } }] },
    encounters = [{ id: 'west', x: -5000, approximate: true, alpha: .5 }, { id: 'zero', x: 0, approximate: false, alpha: 1 }];
  overview.draw({ ground, camera, state, encounters });
  assert(overview.lo < -5000 && overview.hi > 0, 'the encounter outside the camera still has a place on the minimap');
  const columns = calls.filter(call => call.name === 'fillRect' && call.tint === '#f08f78');
  assert.deepEqual(columns.map(call => call.args.slice(1)), [[0, 10, 64], [0, 6, 64]]);
  assert.deepEqual(columns.map(call => call.alpha), [.125, .25]);
  const cameraWindow = calls.find(call => call.name === 'fillRect' && call.tint === '#ffffff1f'),
    actor = calls.find(call => call.name === 'fill' && call.tint === '#ffd095');
  assert.equal(cameraWindow.alpha, 1); assert.equal(actor.alpha, 1, 'band alpha does not dim the camera window or actors');
  assert(calls.indexOf(columns[1]) < calls.indexOf(actor), 'the vehicle icon is painted over the band');
  for (const x of [-5000, 0]) {
    const clientX = 10 + (x - overview.lo) / (overview.hi - overview.lo) * 400;
    assert(Math.abs(overview.worldX(clientX) - x) < 1e-8, 'the existing minimap click still names the encounter place');
  }
});

test('minimap bands stay inside its edges and disappear with the sampled encounter lifetime', () => {
  const { overview, calls } = strip(), bands = new EncounterBands(),
    ground = { minX: -750, maxX: 750, height: () => 0 }, camera = { x: 0, y: 100, zoom: 4, width: 1200 }, state = { actors: [] },
    scene = { ground, camera, state }, columns = () => calls.filter(call => call.name === 'fillRect' && call.tint === '#f08f78');
  bands.record([{ encounter: { id: 'left', x: -750 } }, { encounter: { id: 'right', x: 750, approximate: true } }], 0);
  overview.draw({ ...scene, encounters: bands.sample(0) });
  assert.deepEqual(columns().map(call => call.args), [[0, 0, 6, 64], [390, 0, 10, 64]]);
  calls.length = 0; overview.draw({ ...scene, encounters: bands.sample(8) });
  assert.deepEqual(columns().map(call => call.alpha), [.125, .125]);
  calls.length = 0; overview.draw({ ...scene, encounters: bands.sample(12) }); assert.deepEqual(columns(), []);
  const ordinary = strip(), explicitEmpty = strip();
  ordinary.overview.draw(scene); explicitEmpty.overview.draw({ ...scene, encounters: [] });
  assert.deepEqual(explicitEmpty.calls, ordinary.calls, 'an empty encounter array introduces no drawing work');
});

test('one smooth scale of heights: no line breaks at a hilltop, a flat shot keeps its shape, a high arc leaves the hills readable', () => {
  // A straight climb from the lowest ground to the top of the sky never changes its slope abruptly.
  const bend = (relief, sky) => { const share = overviewScale(relief, sky), top = relief + sky,
    rise = Array.from({ length: 200 }, (_, i) => share((i + 1) * top / 200) - share(i * top / 200));
    return Math.max(...rise.slice(1).map((step, i) => rise[i] / step)); };
  for (const [relief, sky] of [[40, 300], [150, 300], [150, 3000], [400, 6000]])
    assert(bend(relief, sky) < 1.12, `two neighbouring steps of a climb differ by ${bend(relief, sky).toFixed(3)}`);
  // Over modest heights the scale is close to even: half the way up is near the middle of the strip.
  const low = overviewScale(150, 300);
  assert.equal(low(0), 0); assert(Math.abs(low(450) - 1) < 1e-12); assert.equal(low(9000), 1);
  assert(low(225) > .5 && low(225) < .68); assert(low(150) > .33 && low(150) < .48, 'the hills fill the lower part');
  // Under the arc of a howitzer the hills are still there.
  const high = overviewScale(150, 3000);
  assert(high(150) > .12, 'a hill under a three kilometre arc is ' + (high(150) * 100).toFixed(0) + '% of the strip');
  assert(high(1575) < .85, 'and the arc does not reach its ceiling at half its height');
});

test('a long chord of the world is drawn as the curve it is on the scale of heights', () => {
  // A fast round: three points of its path, a kilometre and a half of climb in the first chord.
  const share = overviewScale(150, 3000), sx = x => x / 20, sy = h => 60 - 54 * share(h),
    points = [{ x: 0, y: 0 }, { x: 1000, y: 1500 }, { x: 4000, y: 3000 }, { x: 8000, y: 0 }],
    turn = path => Math.max(...path.slice(2).map(([x, y], i) => {
      const [ax, ay] = path[i], [bx, by] = path[i + 1], bend = Math.atan2(y - by, x - bx) - Math.atan2(by - ay, bx - ax);
      return Math.abs(Math.atan2(Math.sin(bend), Math.cos(bend)));
    })),
    bare = points.map(p => [sx(p.x), sy(p.y)]), drawn = overviewPath(points, sx, sy);
  assert(drawn.length > 40 && drawn.length <= 1 + 3 * 48);
  for (const [x, y] of bare) assert(drawn.some(p => p[0] === x && p[1] === y), 'the points of the path are kept');
  // Every point between two of them stands on their chord, at the height the scale gives it.
  const first = drawn.slice(0, drawn.findIndex(p => p[0] === bare[1][0]) + 1);
  for (const [x, y] of first) assert(Math.abs(y - sy(x * 20 * 1.5)) < 1e-9);
  for (let i = 1; i < drawn.length; i++) assert(Math.hypot(drawn[i][0] - drawn[i - 1][0], drawn[i][1] - drawn[i - 1][1]) < 7);
  // Inside a chord the line bends a little at a time: the corners left are those of the path itself.
  assert(turn(first) < .12, `the first chord bends by ${turn(first).toFixed(3)} rad at most`);
  assert(turn(bare) > .5, 'drawn as three straight lines the same path has a corner');
  // A path thinned out keeps its ends.
  const thin = overviewPath(points, sx, sy, 2);
  assert.deepEqual([thin[0], thin.at(-1)], [bare[0], bare.at(-1)]); assert(!thin.some(p => p[0] === bare[1][0] && p[1] === bare[1][1]));
});

test('the strip holds the camera, the vehicles, the aim and the rounds, and a pointer on it names a place of the field', () => {
  const { overview, element, label, calls } = strip(),
    ground = new Terrain(MAIN_WORLD.terrain, { seed: MAIN_WORLD.seed, length: MAIN_WORLD.mapLength, center: 12 }),
    vehicle = x => ({ x, y: ground.height(x) + 1.5 }), camera = { x: 0, y: 160, zoom: 4, width: 1200 },
    state = { controlledActor: 'local', actors: [{ id: 'local', vehicle: vehicle(0) }, { id: 'opponent', vehicle: vehicle(600) }, { id: 'bench' }] },
    aim = { reachable: true, path: [{ x: 0, y: 160 }, { x: 4000, y: 2400 }, { x: 8000, y: 150 }] };
  overview.draw({ ground, camera, state, shots: packShots([{ id: 'shell', x: 2000, y: 1500 }]), aim,
    arcs: [{ actorId: 'local', fade: .5, x: -900, y: 150, points: [{ x: 0, y: 160 }, { x: -900, y: 150 }] }] });
  assert.equal(element.hidden, false);
  assert(overview.lo < -900 && overview.hi > 8000 && overview.hi < 10000, 'the fallen arc behind, the fall of the aim ahead, and no farther');
  assert.equal(label.textContent, overviewSpan(overview.hi - overview.lo)); assert(label.textContent.endsWith(' km'));
  assert(Math.abs(overview.worldX(210) - (overview.lo + overview.hi) / 2) < 1e-9, 'the middle of the strip is the middle of its stretch');
  assert.equal(overview.worldX(-500), overview.lo); assert.equal(overview.worldX(5000), overview.hi);
  assert(calls.some(call => call.name === 'arc') && calls.some(call => call.name === 'fillRect'), 'rounds and the camera window are painted');
  // The round is a light core in a dark ring, once each, where it stands.
  const dots = calls.filter(call => call.name === 'arc' && [3, 1.8].includes(call.args[2]));
  assert.deepEqual(dots.map(call => call.args[2]), [3, 1.8]); assert.deepEqual(dots[0].args.slice(0, 2), dots[1].args.slice(0, 2));
  assert(Math.abs(dots[0].args[0] - (2000 - overview.lo) / (overview.hi - overview.lo) * 400) < 1e-9 && dots[0].args[1] > 6 && dots[0].args[1] < 40);
  // With the aim gone the strip closes on what is left, a little at a time, and stands still under a pointer.
  const wide = overview.hi - overview.lo;
  overview.draw({ ground, camera, state });
  const closing = overview.hi - overview.lo; assert(closing < wide && closing > 1500);
  overview.held = true; overview.draw({ ground, camera, state }); assert.equal(overview.hi - overview.lo, closing);
  overview.draw(null); assert.equal(element.hidden, true); assert.equal(overview.lo, null);
});

test('a long volley costs the strip a pass over its numbers and a dot a cell, however many rounds stand in it', () => {
  const ground = { minX: -32000, maxX: 32000, height: () => 0 }, camera = { x: 180, y: 2000, zoom: 8, width: 1600 }, state = { controlledActor: 'local', actors: [] },
    painted = ({ overview, calls }, shots, back = 0) => { calls.length = 0; overview.draw({ ground, camera, state, shots, back }); return calls.filter(call => call.name === 'arc'); },
    // Thirty-two guns firing straight up: thirty thousand rounds between the ground and four kilometres, and a round that is nowhere.
    volley = packShots([...Array.from({ length: 30000 }, (_, i) => ({ id: `shot-${i}`, x: i % 32 * 12, y: i / 7.5, vx: 0, vy: 100, age: 10, ammo: 'ap' })),
      { id: 'shot-40001', x: NaN, y: 5, vx: 0, vy: 0, age: 1, ammo: 'ap' }]);
  assert.deepEqual(shotReach(volley), { lo: 0, hi: 372, top: 29999 / 7.5 }, 'the stretch and the sky they need');
  assert.equal(shotReach(volley), shotReach(volley), 'read once from a block'); assert.deepEqual(shotReach(undefined), { lo: Infinity, hi: -Infinity, top: -Infinity });
  const crowd = strip(); assert.equal(painted(crowd, undefined).length, 0, 'a state with no rounds paints none');
  const fills = crowd.calls.filter(call => call.name === 'fill').length, arcs = painted(crowd, volley), rings = arcs.filter(call => call.args[2] === 3), cores = arcs.filter(call => call.args[2] === 1.8);
  assert(crowd.overview.lo < 0 && crowd.overview.hi > 372 && crowd.overview.hi - crowd.overview.lo < 1600, 'the strip holds the volley');
  assert.equal(arcs.length, rings.length + cores.length); assert.equal(rings.length, cores.length);
  assert(rings.length > 300 && rings.length <= Math.ceil(400 / 3) * Math.ceil(64 / 3), `${rings.length} dots for 30 000 rounds: no more than the strip has cells`);
  assert.equal(crowd.calls.filter(call => call.name === 'fill').length, fills + 2, 'and two fills for all of them');
  assert(rings.every(call => call.args[0] >= 0 && call.args[0] <= 400 && call.args[1] >= 0 && call.args[1] <= 64));
  assert.deepEqual(cores.map(call => call.args.slice(0, 2)), rings.map(call => call.args.slice(0, 2)), 'a core in every ring');
  // Each round is where the display has it: back along its velocity from the snapshot, and no farther than it has flown.
  const few = strip(), pair = (y, age) => packShots([{ id: 'shot-1', x: 100, y, vx: 0, vy: 100, age, ammo: 'ap' }, { id: 'shot-2', x: 300, y: 3000, vx: 0, vy: 0, age: 9, ammo: 'ap' }]),
    low = arcs => { assert.equal(arcs.length, 4); return Math.max(...arcs.map(call => call.args[1])); },
    still = low(painted(few, pair(950, 9))), snapshot = low(painted(few, pair(1000, 9))), flown = low(painted(few, pair(1000, 9), .5)), young = low(painted(few, pair(1000, .5), 2));
  assert(snapshot < still - .5, 'fifty metres higher is higher on the strip');
  assert(Math.abs(flown - still) < 1e-4, 'half a second before its snapshot the round was fifty metres lower');
  assert(Math.abs(young - still) < 1e-4, 'and one fired half a second ago is no farther back than its muzzle');
});

test('the deposits of the stretch are marks on its ground, while the strip has room for them', () => {
  const { overview, calls } = strip(), ground = { minX: -32000, maxX: 32000, height: x => 100 + x / 50 }, camera = { x: 0, y: 160, zoom: 4, width: 1200 },
    state = { controlledActor: 'local', actors: [] },
    marks = places => places.map((x, i) => ({ x, material: ['ferro', 'ligas', 'silica'][i % 3], share: i / places.length, active: i !== 1 })),
    // A mark is a lozenge: from its top to its right corner, 2.8 pixels across and 3.4 down.
    lozenges = deposits => { calls.length = 0; overview.draw({ ground, camera, state, deposits });
      return calls.filter((call, i) => call.name === 'moveTo' && calls[i + 1]?.name === 'lineTo' && Math.abs(calls[i + 1].args[0] - call.args[0] - 2.8) < 1e-9 &&
        Math.abs(calls[i + 1].args[1] - call.args[1] - 3.4) < 1e-9).map(call => call.args); },
    plain = lozenges(undefined), fills = calls.filter(call => call.name === 'fill').length, at = x => (x - overview.lo) / (overview.hi - overview.lo) * 400;
  assert.deepEqual(plain, [], 'a field with no deposits has no marks'); assert.deepEqual(lozenges([]), []);
  const shown = lozenges(marks([-300, 0, 400, 9000, -9000]));
  assert.equal(shown.length, 3, 'those of the stretch shown, whether they are dug or not');
  for (const [i, x] of [-300, 0, 400].entries()) assert(Math.abs(shown[i][0] - at(x)) < 1e-9 && shown[i][1] > 0 && shown[i][1] < 64);
  assert(shown[0][1] > shown[2][1], 'each on its own ground: the higher one higher on the strip');
  assert.equal(calls.filter(call => call.name === 'fill').length, fills + 3);
  // A stretch with more of them than the strip can tell apart shows none.
  const row = count => marks(Array.from({ length: count }, (_, i) => -280 + i * 10));
  assert.equal(lozenges(row(57)).length, 57); assert.equal(lozenges(row(58)).length, 0);
});

test('the base of the faction is a pennant on its ground, or the way to it and how far when it is off the strip', () => {
  const { overview, calls } = strip(), ground = { minX: -128000, maxX: 128000, height: x => 100 + x / 50 }, camera = { x: 0, y: 160, zoom: 4, width: 1200 },
    field = (base, extra = {}) => ({ ground, camera, state: { controlledActor: 'local', actors: [], shared: true, faction: { id: 1, base }, ...extra } }),
    drawn = scene => { calls.length = 0; overview.draw(scene); return calls; },
    at = x => (x - overview.lo) / (overview.hi - overview.lo) * 400, words = () => calls.filter(call => call.name === 'fillText').map(call => call.args),
    // The pennant leaves the top of its mast 7.5 pixels to the right and 3 down.
    pennants = () => calls.filter((call, i) => call.name === 'moveTo' && calls[i + 1]?.name === 'lineTo' &&
      Math.abs(calls[i + 1].args[0] - call.args[0] - 7.5) < 1e-9 && Math.abs(calls[i + 1].args[1] - call.args[1] - 3) < 1e-9).map(call => call.args);
  drawn(field({ x: 200, y: 104, radius: 100 }));
  const [[x, y]] = pennants(); assert.equal(pennants().length, 1);
  assert(Math.abs(x - at(200)) < 1e-9 && y > 0 && y < 64, 'over the place of the base');
  // The stretch the base covers lies along the foot of the strip.
  const band = calls.find(call => call.name === 'fillRect' && call.args[3] === 3 && call.args[1] === 61);
  assert(Math.abs(band.args[0] - at(100)) < 1e-9 && Math.abs(band.args[2] - (at(300) - at(100))) < 1e-9);
  assert.deepEqual(words(), [], 'a base in sight needs no words');
  // Off the strip to either side: a mark at that end, and the distance from the camera, or from the player's construction when it has one.
  drawn(field({ x: 40388, y: 451, radius: 100 }));
  assert.deepEqual(pennants(), []); assert.deepEqual(words(), [['base 40,4 km', 400 - 4 - 9, 54]]);
  drawn(field({ x: -15250, y: 30, radius: 100 }));
  assert.deepEqual(words(), [['base 15,3 km', 4 + 9, 54]]);
  drawn(field({ x: 40388, y: 451, radius: 100 }, { actors: [{ id: 'local', vehicle: { x: 388, y: 108 } }] }));
  assert.deepEqual(words().map(([text]) => text), ['base 40 km']);
  // No base off the shared field, and none for a player without a faction yet.
  for (const scene of [{ ground, camera, state: { controlledActor: 'local', actors: [], faction: { base: { x: 200, y: 104, radius: 100 } } } },
    field(undefined), { ground, camera, state: { controlledActor: 'local', actors: [], shared: true } }]) {
    drawn(scene); assert.deepEqual(pennants(), []); assert.deepEqual(words(), []);
  }
});

test('a base of another faction it knows is a square flag on its ground, in the colour of an enemy and paler out of sight', () => {
  const { overview, calls } = strip(), ground = { minX: -128000, maxX: 128000, height: x => 100 + x / 50 }, camera = { x: 0, y: 160, zoom: 4, width: 1200 },
    other = (x, seen) => ({ id: `f${x}`, name: 'Bia', nation: null, x, facing: -1, radius: 100, seen, at: seen ? null : 12 }),
    drawn = (bases, shared = true) => { calls.length = 0;
      overview.draw({ ground, camera, state: { controlledActor: 'local', actors: [], shared, faction: { id: 'f1', base: { x: 40000, y: 900, radius: 100 }, bases } } }); },
    at = x => (x - overview.lo) / (overview.hi - overview.lo) * 400,
    // A flag is laid as a rectangle seven pixels wide and five and a half tall from the top of its mast, and filled.
    flags = () => calls.flatMap((call, i) => call.name === 'rect' && call.args[2] === 7 && call.args[3] === 5.5 ?
      [{ x: call.args[0], y: call.args[1], tint: calls[i + 1].tint, alpha: calls[i + 1].alpha }] : []);
  drawn([other(200, true), other(-300, false), other(9000, true)]);
  const [seen, unseen] = flags();
  assert.equal(flags().length, 2, 'those of the stretch shown');
  assert(Math.abs(seen.x - at(200)) < 1e-9 && Math.abs(unseen.x - at(-300)) < 1e-9);
  assert.deepEqual([seen.tint, seen.alpha, unseen.tint, unseen.alpha], ['#eba383', 1, '#eba383', .55]);
  assert(seen.y < unseen.y && seen.y > 0 && unseen.y < 64, 'each on its own ground: the higher one higher on the strip');
  drawn([]); assert.deepEqual(flags(), []);
  drawn([other(200, true)], false); assert.deepEqual(flags(), [], 'none off the shared field');
});

test('on a field with fog the strip has the relief of the ground the faction knows, lighter where it sees, and the rest dark and level', () => {
  const { overview, calls } = strip(), reads = [], ground = { minX: -32000, maxX: 32000, height: x => { reads.push(x); return 100 + 40 * Math.sin(x / 90); } },
    camera = { x: 0, y: 160, zoom: 4, width: 1200 }, state = { controlledActor: 'local', actors: [] },
    fog = { explored: [[-300, 200]], seen: [[-60, 90]] }, deposits = [{ x: 100, material: 'ferro', share: 1, active: true }, { x: 500, material: 'ligas', share: 1, active: true }],
    // What was filled as a path in a tint: the pixels across the strip it goes over, and how high it gets.
    filled = tint => calls.flatMap((call, i) => {
      if (call.name !== 'fill' || call.tint !== tint) return [];
      const path = calls.slice(calls.slice(0, i).findLastIndex(one => one.name === 'beginPath'), i).filter(one => one.name === 'lineTo' || one.name === 'moveTo').map(one => one.args);
      return [{ from: Math.min(...path.map(p => p[0])), to: Math.max(...path.map(p => p[0])), top: Math.min(...path.map(p => p[1])) }];
    }),
    rects = tint => calls.filter(call => call.name === 'fillRect' && call.tint === tint).map(call => call.args),
    lozenges = () => calls.filter((call, i) => call.name === 'moveTo' && calls[i + 1]?.name === 'lineTo' && Math.abs(calls[i + 1].args[0] - call.args[0] - 2.8) < 1e-9).map(call => call.args);
  overview.draw({ ground, camera, state, fog, deposits });
  // The strip shows from -750 to 750: a pixel is 3.75 m, and a height is read every two pixels.
  assert.deepEqual([overview.lo, overview.hi], [-750, 750]);
  const at = x => (x + 750) / 1500 * 400;
  assert(reads.length > 60 && reads.every(x => x >= -300 && x <= 200), 'no height of the ground never seen is read');
  // The earth of what is known, and over it the earth of what is in sight, each within its ground.
  const [earth] = filled('#5d7152'), [lit] = filled('#73895f');
  assert.equal(filled('#5d7152').length, 1); assert.equal(filled('#73895f').length, 1);
  assert(earth.from >= at(-300) && earth.from < at(-300) + 2 && earth.to <= at(200) && earth.to > at(200) - 2, JSON.stringify(earth));
  assert(lit.from >= at(-60) && lit.from < at(-60) + 2 && lit.to <= at(90) && lit.to > at(90) - 2, JSON.stringify(lit));
  assert(earth.top > 4 && earth.top < 48, `the relief stands up from the foot of the strip: to ${earth.top}`);
  // To each side, the ground never seen: dark and level eight pixels over the foot, and the strip dim over it to its top.
  const dark = rects('#26323c'), dim = rects('#1a242d8c');
  assert.deepEqual(dark.map(rect => [rect[1], rect[3]]), [[52, 12], [52, 12]]); assert.deepEqual(dim.map(rect => [rect[1], rect[3]]), [[0, 52], [0, 52]]);
  assert(dark[0][0] === 0 && Math.abs(dark[0][2] - at(-300)) <= 2 && Math.abs(dark[1][0] - at(200)) <= 2 && Math.abs(dark[1][0] + dark[1][2] - 400) < 1e-9);
  assert.deepEqual(dim.map(rect => [rect[0], rect[2]]), dark.map(rect => [rect[0], rect[2]]));
  // A deposit of ground never seen is a mark on the level line; one of known ground is on its relief.
  const [known, unseen] = lozenges();
  assert.equal(lozenges().length, 2); assert(Math.abs(unseen[1] - (52 - 1 - 3.4)) < 1e-9 && Math.abs(unseen[0] - at(500)) < 1e-9); assert(known[1] < 44);
  // Nothing known on the strip: no height is read, and all of it is dark.
  reads.length = 0; calls.length = 0; overview.draw({ ground, camera, state, fog: { explored: [], seen: [] } });
  assert.equal(reads.length, 0); assert.deepEqual([filled('#5d7152').length, filled('#73895f').length], [0, 0]);
  assert.deepEqual(rects('#26323c'), [[0, 52, 400, 12]]);
  // All of it known and none in sight: the relief whole, nothing dark, nothing lit.
  calls.length = 0; overview.draw({ ground, camera, state, fog: { explored: [[-5000, 5000]], seen: [] } });
  assert.deepEqual([filled('#5d7152').map(shape => [shape.from, shape.to]), filled('#73895f'), rects('#26323c'), rects('#1a242d8c')], [[[0, 400]], [], [], []]);
  // Off a field with fog the strip is as ever: every height read, one earth, no tint of sight.
  reads.length = 0; calls.length = 0; overview.draw({ ground, camera, state });
  assert.equal(reads.length, 201); assert.deepEqual([filled('#5d7152').map(shape => [shape.from, shape.to]), filled('#73895f'), rects('#26323c'), rects('#1a242d8c')], [[[0, 400]], [], [], []]);
});

test('a gun the base placed by its fire is a reticle on its ground, and the strip opens to hold it', () => {
  const ground = { minX: -128000, maxX: 128000, height: x => 100 + x / 50 }, camera = { x: 0, y: 160, zoom: 4, width: 1200 },
    gun = (more = {}) => ({ id: 'gun', kind: 'battery', x: 6100, error: 300, at: 29.5, by: 'radar', ...more }),
    drawn = (contacts, state = {}) => { const made = strip();
      made.overview.draw({ ground, camera, time: 30, state: { controlledActor: 'local', actors: [], shared: true, time: 30.05, contacts, ...state } });
      const at = x => (x - made.overview.lo) / (made.overview.hi - made.overview.lo) * 400, arcs = radius => made.calls.filter(call => call.name === 'arc' && call.args[2] === radius).map(call => call.args);
      return { ...made, at, arcs, bars: made.calls.filter(call => call.name === 'fillRect' && call.args[3] === 2).map(call => call.args) }; },
    none = drawn([]), one = drawn([gun()]);
  assert.deepEqual([none.overview.lo, none.overview.hi], [-750, 750]); assert.deepEqual(none.arcs(3.6), []);
  assert(one.overview.lo < -150 && one.overview.hi > 6100 && one.overview.hi < 7000, 'the strip opens as far as the gun');
  // The reticle is drawn twice, a dark edge under its tint, over the ground where the gun is held.
  const rings = one.arcs(3.6); assert.equal(rings.length, 2);
  for (const [x, y] of rings) assert(Math.abs(x - one.at(6100)) < 1e-9 && y > 0 && y < 64);
  // It stands on a bar as long as the place may be off, and the word that is half a second old still closes on it.
  assert.equal(one.bars.length, 1); assert(Math.abs(one.bars[0][0] - one.at(5800)) < 1e-9 && Math.abs(one.bars[0][2] - (one.at(6400) - one.at(5800))) < 1e-9);
  assert.deepEqual(one.arcs(5 + 11 * (1 - .5 / 1.4)).length, 1);
  // A place held closely has no bar, and a word that is old no ring; what a radar or an ear of a vehicle holds is no mark of the strip.
  const sure = drawn([gun({ error: 20, at: 5 }), { id: 'blip', kind: 'radar', x: 3000, y: 160, error: 9, at: 30 }]);
  assert.equal(sure.arcs(3.6).length, 2); assert.deepEqual(sure.bars, []); assert.equal(sure.calls.filter(call => call.name === 'arc').length, 2);
  // Two guns are two reticles, and the strip holds both; off the shared field there is none.
  const two = drawn([gun(), gun({ id: 'other', x: -9000 })]);
  assert.equal(two.arcs(3.6).length, 4); assert(two.overview.lo < -9000 && two.overview.hi > 6100);
  const lab = drawn([gun()], { shared: false }); assert.deepEqual(lab.arcs(3.6), []); assert.deepEqual([lab.overview.lo, lab.overview.hi], [-750, 750]);
});

test('the territories the faction is told of are bands along the foot of the strip, each in the colour of its faction, its own over the others', () => {
  const made = strip(), ground = { minX: -32000, maxX: 32000, height: () => 100 }, camera = { x: 0, zoom: 4, width: 1200 },
    territory = [{ kind: 'own', color: '#4fa3d9', spans: [[-5000, 5000]] }, { kind: 'other', color: '#d94f4f', spans: [[7000, 8000]] },
      { kind: 'ally', color: null, spans: [[-9000, -6000]] }],
    state = { shared: true, time: 5, localPlayerId: 'me', faction: { id: 'green', territory },
      actors: [{ id: 'a', ownerId: 'me', team: 'green', vehicle: { x: -9500, y: 101 } }, { id: 'b', ownerId: 'me', team: 'green', vehicle: { x: 8500, y: 101 } }] };
  made.overview.draw({ ground, camera, state });
  const at = x => (x - made.overview.lo) / (made.overview.hi - made.overview.lo) * 400,
    foot = (tall) => made.calls.filter(call => call.name === 'fillRect' && call.args[1] === 64 - 6 && call.args[3] === tall),
    bands = foot(6), edges = foot(1);
  assert.deepEqual(bands.map(band => [band.tint, band.alpha]), [['#d94f4f', .5], ['#b4d28b', .5], ['#4fa3d9', .5]],
    'the others first, an ally whose colour is not told in the tint of allies, and its own last');
  assert(Math.abs(bands[2].args[0] - at(-5000)) < 1e-9 && Math.abs(bands[2].args[0] + bands[2].args[2] - at(5000)) < 1e-9, 'over the stretch it holds');
  assert.deepEqual(edges.map(edge => [edge.tint, edge.alpha]), [['#d94f4f', 1], ['#b4d28b', 1], ['#4fa3d9', 1]], 'each with an edge on top');
  // What the faction is not told is not drawn: another's territory it never explored is not in its view (room.ts `territories`).
  const none = strip(); none.overview.draw({ ground, camera, state: { ...state, faction: { id: 'green', territory: [] } } });
  assert(!none.calls.some(call => call.name === 'fillRect' && call.args[3] === 6));
  const trial = strip(); trial.overview.draw({ ground, camera, state: { ...state, shared: false } });
  assert(!trial.calls.some(call => call.name === 'fillRect' && call.args[3] === 6), 'a test of a design has no territory');
});
