import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { drawBaseArt, drawBaseWatch, drawPostArt, watchPosts, yardAt, AERIAL_TURN, WATCH_RADAR, WORKS, POST_WORKS, POST_BUILD, SEEN_PIXEL, NEAR_PIXEL } from '../src/base-art.ts';
import { radarAerial } from '../src/machine-art.ts';
import { DEPOT_INSET } from '../src/squad.ts';
import { GraphicsRecorder } from './scenery-canvas.js';
import { FLAG_COLOURS } from '../src/flag.ts';

// The flag the base flies in these tests, and the colour of its ground.
const BANNER = { field: 'canton', colours: [4, 0, 8], emblem: 'ring' }, CLOTH = FLAG_COLOURS[4].value;
const FLAG = 0xb4d28b, FOOTING = 0x989d8c;
const draw = (base, ground, pixel, color, watch = true) => {
  const works = new GraphicsRecorder(), front = new GraphicsRecorder(), flag = drawBaseArt(works, front, base, ground, pixel, BANNER, null, color, watch);
  return { works, front, flag };
};
const world = new Terrain('world', { seed: 6173, length: 16000 }), grade = x => (world.height(x + 100) - world.height(x - 100)) / 200;
// A slope a base may well be given, and level ground.
const spot = fits => { for (let x = -1400; x < 5000; x += 20) if (fits(Math.abs(grade(x)), x)) return x; throw new Error('no such ground'); };
const steep = spot(s => s > .09 && s < .14), level = spot((s, x) => s < .01 && world.materialAt(x) === 'soil');
const base = (x, facing = 1, ground = world) => ({ x, y: ground.height(x), facing, radius: 100 });
// The extent of an outline, and every place a drawing touches.
const extent = points => { const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2); return { left: Math.min(...xs), right: Math.max(...xs), low: Math.min(...ys), high: Math.max(...ys) }; };
const places = g => g.calls.flatMap(c => c[0] === 'poly' ? c[1].flatMap((v, i) => i % 2 ? [] : [[v, c[1][i + 1]]]) : c[0] === 'moveTo' || c[0] === 'lineTo' ? [[c[1], c[2]]] : []);
const solid = (fill, color) => (typeof fill.style === 'number' ? fill.style : fill.style.color) === color && (fill.style.alpha ?? 1) === 1;
const close = (a, b, within = 1e-9) => Math.abs(a - b) < within;
// The lowest ground between two places.
const lowest = (a, b) => { let y = Infinity; for (let x = Math.min(a, b); x <= Math.max(a, b); x += .25) y = Math.min(y, world.height(x)); return y; };

test('base materials reuse the exact native outlines and disappear with distant detail', () => {
  const materials = Object.fromEntries(['paint', 'concrete', 'canvas', 'rubber', 'earth'].map(name => [name, { texture: name }])), styles = new Set(Object.values(materials));
  for (const facing of [-1, 1]) for (const pixel of [.025, .3]) {
    const b = base(steep, facing), plain = draw(b, world, pixel), works = new GraphicsRecorder(), front = new GraphicsRecorder(),
      flag = drawBaseArt(works, front, b, world, pixel, BANNER, null, undefined, true, materials), untextured = [];
    let overlays = 0;
    for (let i = 0; i < works.calls.length; i++) {
      const call = works.calls[i], next = works.calls[i + 1];
      if (call[0] === 'poly' && next?.[0] === 'fill' && styles.has(next[1])) {
        assert(plain.works.fills().some(fill => JSON.stringify(fill.points) === JSON.stringify(call[1])));
        overlays++; i++;
      } else untextured.push(call);
    }
    assert.deepEqual(untextured, plain.works.calls);
    assert.deepEqual(front.calls, plain.front.calls); assert.deepEqual(flag, plain.flag);
    assert(pixel < SEEN_PIXEL ? overlays > 70 : overlays === 0);
  }
});

test('the base is the same installation every time, keeps to the ground it covers, and leaves the ground as it was', () => {
  const before = world.snapshot();
  for (const x of [steep, level]) for (const facing of [1, -1]) for (const pixel of [2, .25, 1 / 12, 1 / 80]) {
    const a = draw(base(x, facing), world, pixel), b = draw(base(x, facing), world, pixel);
    assert.deepEqual(a.works.calls, b.works.calls); assert.deepEqual(a.front.calls, b.front.calls); assert.deepEqual(a.flag, b.flag);
    for (const [px, py] of [...places(a.works), ...places(a.front)]) {
      assert(Number.isFinite(px) && Number.isFinite(py));
      assert(px > x - 100 - 12 * Math.max(1, pixel) && px < x + 100 + 12 * Math.max(1, pixel), 'the base keeps to the ground it covers');
    }
    // Paths, not objects: some thousands of calls, made when the view changes scale and never on a frame.
    assert(a.works.calls.length < 5000 && a.front.calls.length < 120, `${a.works.calls.length} and ${a.front.calls.length} calls`);
  }
  assert.deepEqual(world.snapshot(), before);
});

test('every work stands on its own ground, and the hall on a footing cut into the slope', () => {
  for (const [x, facing] of [[steep, 1], [steep, -1], [level, 1]]) {
    const { works } = draw(base(x, facing), world, 1 / 45), fills = works.fills(), outlines = fills.map(f => extent(f.points)), at = u => x + u * facing;
    // Each work is footed on the lowest ground under it, or sunk a little into it: none hangs over the slope.
    for (const name of ['tent', 'office', 'generator', 'nets', 'fuel', 'radio', 'magazine', 'refinery']) {
      const [left, right] = WORKS[name].map(at).sort((a, b) => a - b), ground = lowest(left, right),
        foot = Math.min(...outlines.filter(e => e.left >= left - .7 && e.right <= right + .7).map(e => e.low));
      assert(foot <= ground + .05 && foot >= ground - 1.25, `the ${name} stands ${(foot - ground).toFixed(2)} m from its ground`);
    }
    // The hall stands on one floor from end to end, cut into the slope between its lowest and its highest ground; its
    // footing fills what the slope leaves open under it, down into the ground on the low side.
    const [left, right] = WORKS.hall.map(at).sort((a, b) => a - b), heights = [];
    for (let px = left; px <= right; px += .25) heights.push(world.height(px));
    const footing = fills.filter(f => solid(f, FOOTING)).map(f => extent(f.points)).find(e => e.left <= left - 2.5 && e.right >= right + 2.5);
    assert(footing, 'the hall has its footing');
    assert(footing.high >= Math.min(...heights) && footing.high <= Math.max(...heights) + .16, 'the floor is cut into the slope');
    assert(footing.low <= Math.min(...heights) - 1);
    // Each basket of a revetment stands on the ground under it: a wall steps down a slope and never hangs over it.
    const baskets = outlines.filter(e => close(e.right - e.left, 1.06) && close(e.high - e.low, 1.37))
      .filter(e => e.low < Math.min(world.height(e.left), world.height(e.right)));
    assert(baskets.length >= 28, `${baskets.length} baskets on the ground`);
    for (const basket of baskets) {
      const ends = Math.min(world.height(basket.left), world.height(basket.right)),
        under = Math.min(ends, ...world.points.filter(p => p.x > basket.left && p.x < basket.right).map(p => p.y));
      // A local hollow can put the minimum between the two ends. The surveyed footing may sit between
      // those levels minus its burial, but it must still be below every point of the real contour.
      assert(basket.low >= under - .2 - 1e-6 && basket.low <= ends - .2 + 1e-6 && basket.low < under,
        `a basket at ${basket.left - x}`);
    }
  }
});

test('the yards where haulers unload are aprons on the ground, as far in from each end as the hauler stops', () => {
  for (const [x, facing] of [[steep, 1], [level, -1]]) {
    const b = base(x, facing), { front } = draw(b, world, 1 / 45), at = u => x + u * facing, yard = yardAt(b);
    assert.equal(yard, b.radius - DEPOT_INSET);
    const aprons = front.fills().map(f => ({ ...extent(f.points), top: f.points.slice(0, f.points.length / 2) }));
    for (const [from, to] of [[-40, -13], [-yard - 9, -yard + 7], [yard - 7, yard + 9]]) {
      const [left, right] = [at(from), at(to)].sort((a, c) => a - c), apron = aprons.find(e => close(e.left, left) && close(e.right, right));
      assert(apron, `an apron from ${from} to ${to}`);
      for (let i = 0; i < apron.top.length; i += 2) assert(close(apron.top[i + 1], world.height(apron.top[i]) + .015), 'it lies on the ground');
    }
    // The band along the base lies on the ground from one end of it to the other.
    const band = front.calls.filter(c => c[0] === 'moveTo' || c[0] === 'lineTo').slice(0, 51);
    assert.equal(band[0][1], at(-100)); assert.equal(band.at(-1)[1], at(100));
    for (const [, px, py] of band) assert(close(py, world.height(px) - .1));
  }
});

test('the other facing is the same base turned round, lit from the same sky', () => {
  const bench = new Terrain('flat'), x = 12, one = draw(base(x, 1, bench), bench, 1 / 45), other = draw(base(x, -1, bench), bench, 1 / 45);
  for (const layer of ['works', 'front']) {
    const a = one[layer].fills(), b = other[layer].fills(); assert.equal(a.length, b.length);
    for (const [i, fill] of a.entries()) {
      const here = extent(fill.points), there = extent(b[i].points);
      assert(close(here.left, 2 * x - there.right, 1e-6) && close(here.right, 2 * x - there.left, 1e-6), `piece ${i}`);
      assert(close(here.low, there.low, 1e-6) && close(here.high, there.high, 1e-6));
      // The same shading: a face is pale along its top and a standing round lit from the same side, whichever way the base faces.
      assert.deepEqual(fill.style, b[i].style);
    }
  }
  assert.equal(one.flag.x, x + 5.5); assert.equal(other.flag.x, x - 5.5); assert.equal(one.flag.y, other.flag.y);
});

test('from afar the base is a silhouette under a flag that stays a few pixels large; near, it gains its detail', () => {
  const sizes = {};
  for (const zoom of [.5, 4, 12, 45, 80]) {
    const pixel = 1 / zoom, { works, front, flag } = draw(base(steep), world, pixel, 0xd96a4a), mast = steep + 5.5;
    sizes[zoom] = works.calls.length + front.calls.length;
    assert.deepEqual(flag.x, mast);
    // The flag flies over the roof, and never under some sixty pixels over the ground.
    assert((flag.y - world.height(mast)) * zoom >= 62 - 1e-6 || flag.y - world.height(mast) > 10);
    // It is the flag of the faction, from its mast, three wide for two tall.
    const cloth = works.fills().filter(f => f.style.color === CLOTH).map(f => extent(f.points));
    assert.equal(cloth.length, 1); assert(close(cloth[0].high, flag.y)); assert(close(cloth[0].left, mast));
    const wide = cloth[0].right - cloth[0].left;
    assert(wide * zoom >= 21 - 1e-6 && wide >= 2.4 - 1e-9, 'the flag is seen at any scale'); assert(close((cloth[0].high - cloth[0].low) * 3, wide * 2));
    assert.equal(works.calls.filter(c => c[0] === 'circle').length, 1, 'with its emblem');
    // The flag of a country is its picture, four wide for three tall, hung from the same place; without the picture the mast is bare.
    const picture = { name: 'picture' }, bare = new GraphicsRecorder(), hung = new GraphicsRecorder();
    drawBaseArt(bare, new GraphicsRecorder(), base(steep), world, pixel, { country: 'br' }, null, 0xd96a4a);
    assert.deepEqual(drawBaseArt(hung, new GraphicsRecorder(), base(steep), world, pixel, { country: 'br' }, picture, 0xd96a4a), flag);
    assert.equal(bare.calls.filter(c => c[0] === 'texture').length, 0);
    const [laid, drawn] = hung.calls.filter(c => c[0] === 'transform' || c[0] === 'texture');
    assert.deepEqual(drawn, ['texture', picture, 0xffffff, 0, 0, 1, 1]); assert.deepEqual([laid[2], laid[3], laid[5], laid[6]], [0, 0, mast, flag.y]);
    assert(close(laid[1], wide) && close(laid[4], -wide * 3 / 4));
    assert.equal(hung.calls.length, bare.calls.length + 4);
    // A pennant at each end of the ground the base covers.
    const pennants = works.fills().filter(f => f.style.color === 0xd96a4a && f.style.alpha === .9).map(f => extent(f.points));
    assert.equal(pennants.length, 2);
    assert(pennants.some(p => close(p.left, steep - 100)) && pennants.some(p => close(p.right, steep + 100)));
    for (const p of pennants) assert((p.right - p.left) * zoom >= 5 - 1e-6 || p.right - p.left >= .7 - 1e-9);
    // No line is thinner than a pixel can show.
    for (const call of [...works.calls, ...front.calls]) if (call[0] === 'stroke') assert(call[1].width >= .8 * pixel - 1e-12, `a line of ${call[1].width * zoom} px`);
    // The colour of the field is on the mast, the pennants, the hood of the door and the band alone, and on the markers
    // at the ends where a view tells them.
    const tinted = [...works.calls, ...front.calls].filter(c => (c[0] === 'fill' || c[0] === 'stroke') && c[1]?.color === 0xd96a4a).length;
    assert.equal(tinted, pixel < SEEN_PIXEL ? 7 : 5, `${tinted} pieces in the colour of the faction`);
  }
  assert.equal(sizes[.5], sizes[4], 'nothing is added to what a far view cannot show');
  assert(sizes[12] > sizes[4] * 2, 'a view that tells the faces apart shows their edges, seams and openings');
  assert(sizes[45] > sizes[12] * 2, 'a near view shows bolts, meshes, wires and slats'); assert.equal(sizes[45], sizes[80]);
  assert(1 / 12 > NEAR_PIXEL && 1 / 45 < NEAR_PIXEL && 1 / 4 > SEEN_PIXEL);
  // Without a colour of its own the base is marked in the green of the field.
  assert(draw(base(level), world, .25).works.fills().some(f => f.style.color === FLAG && f.style.alpha === .9));
});

test('a base shows nothing of what it holds: its stocks, its fuel and what is built in it change no line of it', () => {
  for (const watch of [true, false]) for (const pixel of [.25, 1 / 45]) {
    const bare = draw(base(level), world, pixel, 0xd96a4a, watch),
      stocked = draw({ ...base(level), stocks: { iron: 9e5, fuel: 4e4, ammo: 300 }, fuel: 1e5, built: ['c1', 'c2'], queue: 3, seen: false }, world, pixel, 0xd96a4a, watch);
    assert.deepEqual(stocked.works.calls, bare.works.calls); assert.deepEqual(stocked.front.calls, bare.front.calls); assert.deepEqual(stocked.flag, bare.flag);
  }
});

test('the watch of the base is a radar whose aerial turns and a row of microphones, each on its own ground', () => {
  const moving = (b, pixel, pulses) => { const g = new GraphicsRecorder(); drawBaseWatch(g, b, world, pixel, pulses); return g; };
  assert(AERIAL_TURN > 1 && AERIAL_TURN < 4, 'a turn every few seconds');
  // The radar is a vehicle's at the size of a base's: its aerial as wide as the cabin under it, and the waves leave its middle.
  assert(WATCH_RADAR.width === 2.5 && Math.abs(WATCH_RADAR.height / WATCH_RADAR.width - .84) < 1e-9);
  const middle = posts => posts.radar.y + WATCH_RADAR.height / 2 + radarAerial(WATCH_RADAR.width, WATCH_RADAR.height).y;
  for (const [x, facing] of [[steep, 1], [steep, -1], [level, -1]]) {
    const b = base(x, facing), posts = watchPosts(b, world), at = u => x + u * facing;
    assert.equal(posts.radar.x, at(46.5)); assert.deepEqual(posts.ears.map(ear => ear.x), [-49, -47.6, -46.2].map(at));
    for (const post of [posts.radar, ...posts.ears]) assert(post.foot <= world.height(post.x) - .2 + 1e-9 && post.foot > world.height(post.x) - 1.2 && post.y - post.foot >= 1.5, 'footed in its ground');
    // The cabin of the radar is of the works, drawn once: its mast ends at the pivot the aerial turns on.
    const { works } = draw(b, world, 1 / 45), cabin = works.fills().map(f => extent(f.points))
      .find(e => close(e.right - e.left, 2.6) && close((e.left + e.right) / 2, posts.radar.x) && close(e.low, posts.radar.foot));
    assert(cabin && cabin.high < posts.radar.y);
    assert(places(works).some(([px, py]) => close(px, posts.radar.x) && close(py, posts.radar.y)), 'the mast reaches the pivot');
    for (const ear of posts.ears) assert(places(works).some(([px, py]) => close(px, ear.x) && close(py, ear.y)), 'a stake to the head of each microphone');
    // The base of another is drawn without its watch: no cabin, no mast to the pivot, no stake to a microphone, and the rest as it is.
    const mine = draw(b, world, 1 / 45, 0xd96a4a), theirs = draw(b, world, 1 / 45, 0xd96a4a, false), heads = [posts.radar, ...posts.ears];
    assert.deepEqual(theirs.flag, mine.flag); assert.deepEqual(theirs.front.calls, mine.front.calls);
    assert(!theirs.works.fills().some(f => { const e = extent(f.points); return close(e.right - e.left, 2.6) && close((e.left + e.right) / 2, posts.radar.x); }), 'no cabin');
    assert(!places(theirs.works).some(([px, py]) => heads.some(head => close(px, head.x) && close(py, head.y))), 'nothing reaches the pivot or a microphone');
    assert(theirs.works.calls.length < mine.works.calls.length);
    // The radar and the microphones are drawn as a vehicle's are (render.ts): a frame with no word to show draws nothing.
    for (const pixel of [1 / 45, .49, 2]) assert.deepEqual(moving(b, pixel).calls, []);
  }
  // A word the watch has just had: three waves, fainter as the word gets old, as large on the screen at any scale.
  const b = base(level), posts = watchPosts(b, world), strokes = g => g.calls.filter(c => c[0] === 'stroke').map(c => c[1]),
    span = g => { const e = extent(places(g).flat()); return [e.left, e.right, e.low, e.high]; };
  for (const side of [1, -1]) {
    // The radar sends them out from its aerial, up and to the side the gun is on.
    const radar = moving(b, 2, [{ by: 'radar', side, age: .25 }]), [left, right, low, high] = span(radar);
    assert.deepEqual(strokes(radar).map(s => [s.color, s.alpha]), [[0xffb35c, .75], [0xffb35c, .75 * .75], [0xffb35c, .75 * .5]]);
    assert(side > 0 ? left > posts.radar.x : right < posts.radar.x); assert(high > middle(posts) + 30 && low > middle(posts) - 12 * 2);
    assert(Math.max(Math.abs(left - posts.radar.x), Math.abs(right - posts.radar.x)) <= (12 + 11 + 18) * 2 + 1e-9);
    // The ears take them in at the microphones, level, from that side.
    const ears = moving(b, 2, [{ by: 'sound', side, age: .25 }]), [from, to, under, over] = span(ears), head = posts.ears[1];
    assert.deepEqual(strokes(ears).map(s => s.color), [0xcfe3a8, 0xcfe3a8, 0xcfe3a8]);
    assert(side > 0 ? from > head.x : to < head.x); assert(close((under + over) / 2, head.y), 'level with the microphones');
  }
  const near = span(moving(b, 2, [{ by: 'radar', side: 1, age: .5 }])), far = span(moving(b, 4, [{ by: 'radar', side: 1, age: .5 }]));
  assert(close(far[1] - posts.radar.x, 2 * (near[1] - posts.radar.x)), 'twice the metres at half the scale');
  const young = span(moving(b, 2, [{ by: 'radar', side: 1, age: 0 }])), old = span(moving(b, 2, [{ by: 'radar', side: 1, age: .9 }]));
  assert(old[1] > young[1], 'the waves of the radar go out'); assert.equal(strokes(moving(b, 2, [{ by: 'radar', side: 1, age: .9 }]))[0].alpha, 1 - .9);
  const coming = age => span(moving(b, 2, [{ by: 'sound', side: 1, age }]))[1]; assert(coming(.9) < coming(0), 'a sound comes in');
  // Two words at once are both shown.
  assert.equal(strokes(moving(b, 2, [{ by: 'radar', side: 1, age: .2 }, { by: 'sound', side: -1, age: .6 }])).length, 6);
});

// A post of a faction (territory.ts POST_RADIUS), drawn as it stands once `progress` reaches 1, or as far as its works have come.
const post = (x, facing = 1) => ({ x, radius: 50, facing });
const drawPost = (p, ground, pixel, color, progress = 1, materials = null) => {
  const works = new GraphicsRecorder(), front = new GraphicsRecorder(), flag = drawPostArt(works, front, p, ground, pixel, BANNER, null, color, materials, progress);
  return { works, front, flag };
};
// The strokes of a drawing, each with the lines it strokes.
const stroked = g => {
  const made = []; let lines = [], from = null;
  for (const call of g.calls) {
    if (call[0] === 'moveTo') from = [call[1], call[2]];
    else if (call[0] === 'lineTo') { lines.push([...from, call[1], call[2]]); from = [call[1], call[2]]; }
    else if (call[0] === 'stroke') { made.push({ style: call[1], lines }); lines = []; }
    else if (call[0] === 'poly') lines = [];
  }
  return made;
};
// The timber of the pegs, and the tubes of scaffolding (the wire of the stays a little paler).
const TIMBER = 0x8f7d60, TUBE = 0xa1a696;
const scaffolding = g => stroked(g).filter(s => s.style.color === TUBE);

test('a post is the same every time, keeps to the ground it serves, and leaves the ground as it was', () => {
  const before = world.snapshot();
  for (const x of [steep, level]) for (const facing of [1, -1]) for (const pixel of [2, .25, 1 / 12, 1 / 80]) for (const progress of [0, .3, .5, .75, 1]) {
    const a = drawPost(post(x, facing), world, pixel, 0xd96a4a, progress), b = drawPost(post(x, facing), world, pixel, 0xd96a4a, progress);
    assert.deepEqual(a.works.calls, b.works.calls); assert.deepEqual(a.front.calls, b.front.calls); assert.deepEqual(a.flag, b.flag);
    for (const [px, py] of [...places(a.works), ...places(a.front)]) {
      assert(Number.isFinite(px) && Number.isFinite(py));
      assert(px > x - 50 - 12 * Math.max(1, pixel) && px < x + 50 + 12 * Math.max(1, pixel), 'the post keeps to the ground it serves');
    }
    // A third of a base, or less: paths made when the view changes scale, never on a frame.
    assert(a.works.calls.length < 2600 && a.front.calls.length < 80, `${a.works.calls.length} and ${a.front.calls.length} calls`);
  }
  assert.deepEqual(world.snapshot(), before);
});

test('every work of a post stands on its own ground, and its shelter on a footing cut into the slope', () => {
  const yard = yardAt(post(0));
  assert.equal(yard, 50 - DEPOT_INSET);
  for (const [x, facing] of [[steep, 1], [steep, -1], [level, 1]]) {
    const { works } = drawPost(post(x, facing), world, 1 / 45), fills = works.fills(), outlines = fills.map(f => extent(f.points)), at = u => x + u * facing;
    const spans = { magazine: POST_WORKS.magazine, fuel: POST_WORKS.fuel, bin: POST_WORKS.bin.map(u => yard + u), shed: [-yard - 6.5, -yard + 5.5] };
    for (const [name, span] of Object.entries(spans)) {
      const [left, right] = span.map(at).sort((a, b) => a - b), ground = lowest(left, right),
        foot = Math.min(...outlines.filter(e => e.left >= left - .7 && e.right <= right + .7).map(e => e.low));
      assert(foot <= ground + .05 && foot >= ground - 1.25, `the ${name} stands ${(foot - ground).toFixed(2)} m from its ground`);
    }
    const [left, right] = POST_WORKS.shelter.map(at).sort((a, b) => a - b), heights = [];
    for (let px = left; px <= right; px += .25) heights.push(world.height(px));
    const footing = fills.filter(f => solid(f, FOOTING)).map(f => extent(f.points)).find(e => e.left <= left - 1.3 && e.right >= right + 1.3);
    assert(footing, 'the shelter has its footing');
    assert(footing.high >= Math.min(...heights) && footing.high <= Math.max(...heights) + .16, 'its floor is cut into the slope');
    assert(footing.low <= Math.min(...heights) - .9);
    // The corners: five baskets at each end, each on the ground under it.
    const baskets = outlines.filter(e => close(e.right - e.left, 1.06) && close(e.high - e.low, 1.37));
    assert.equal(baskets.length, 10);
    for (const basket of baskets) assert(basket.low <= Math.min(world.height(basket.left), world.height(basket.right)) - .2 + 1e-6, `a basket at ${basket.left - x}`);
  }
});

test('the yards of a post are aprons on the ground where its haulers stop, and its band lies along what it serves', () => {
  for (const [x, facing] of [[steep, 1], [level, -1]]) {
    const p = post(x, facing), { front } = drawPost(p, world, 1 / 45), at = u => x + u * facing, yard = yardAt(p);
    const aprons = front.fills().map(f => ({ ...extent(f.points), top: f.points.slice(0, f.points.length / 2) }));
    for (const [from, to] of [[-yard - 6, -yard + 6], [yard - 6, yard + 6], POST_WORKS.hardstand]) {
      const [left, right] = [at(from), at(to)].sort((a, c) => a - c), apron = aprons.find(e => close(e.left, left) && close(e.right, right));
      assert(apron, `an apron from ${from} to ${to}`);
      for (let i = 0; i < apron.top.length; i += 2) assert(close(apron.top[i + 1], world.height(apron.top[i]) + .015), 'it lies on the ground');
    }
    const band = front.calls.filter(c => c[0] === 'moveTo' || c[0] === 'lineTo').slice(0, 26);
    assert.equal(band[0][1], at(-50)); assert.equal(band.at(-1)[1], at(50));
    for (const [, px, py] of band) assert(close(py, world.height(px) - .1));
  }
});

test('the other facing is the same post turned round, lit from the same sky', () => {
  const bench = new Terrain('flat'), x = 12;
  for (const progress of [1, .5]) {
    const one = drawPost(post(x, 1), bench, 1 / 45, undefined, progress), other = drawPost(post(x, -1), bench, 1 / 45, undefined, progress);
    for (const layer of ['works', 'front']) {
      const a = one[layer].fills(), b = other[layer].fills(); assert.equal(a.length, b.length);
      for (const [i, fill] of a.entries()) {
        const here = extent(fill.points), there = extent(b[i].points);
        assert(close(here.left, 2 * x - there.right, 1e-6) && close(here.right, 2 * x - there.left, 1e-6), `piece ${i}`);
        assert(close(here.low, there.low, 1e-6) && close(here.high, there.high, 1e-6)); assert.deepEqual(fill.style, b[i].style);
      }
    }
    assert.equal(one.flag.x, x); assert.equal(other.flag.x, x); assert.equal(one.flag.y, other.flag.y);
  }
});

test('from afar a post is its flag and its markers; near, it gains its detail', () => {
  const sizes = {};
  for (const zoom of [.5, 4, 12, 45, 80]) {
    const pixel = 1 / zoom, { works, front, flag } = drawPost(post(steep), world, pixel, 0xd96a4a);
    sizes[zoom] = works.calls.length + front.calls.length;
    assert.equal(flag.x, steep);
    assert((flag.y - world.height(steep)) * zoom >= 52 - 1e-6 && flag.y - world.height(steep) > 9, 'the flag flies over the works, and is seen from afar');
    const cloth = works.fills().filter(f => f.style.color === CLOTH).map(f => extent(f.points));
    assert.equal(cloth.length, 1); assert(close(cloth[0].high, flag.y)); assert(close(cloth[0].left, steep));
    const wide = cloth[0].right - cloth[0].left;
    assert(wide * zoom >= 18 - 1e-6 && wide >= 2 - 1e-9 && wide < Math.max(2.4, 21 * pixel), 'smaller than the flag of a base, and seen at any scale');
    const pennants = works.fills().filter(f => f.style.color === 0xd96a4a && f.style.alpha === .9).map(f => extent(f.points));
    assert.equal(pennants.length, 2);
    assert(pennants.some(p => close(p.left, steep - 50)) && pennants.some(p => close(p.right, steep + 50)));
    for (const call of [...works.calls, ...front.calls]) if (call[0] === 'stroke') assert(call[1].width >= .8 * pixel - 1e-12, `a line of ${call[1].width * zoom} px`);
    // The colour of the field is on the mast, the pennants, the hood of the shelter's bay and the band, and on the
    // markers where a view tells them.
    const tinted = [...works.calls, ...front.calls].filter(c => (c[0] === 'fill' || c[0] === 'stroke') && c[1]?.color === 0xd96a4a).length;
    assert.equal(tinted, pixel < SEEN_PIXEL ? 7 : 5, `${tinted} pieces in the colour of the faction`);
  }
  assert.equal(sizes[.5], sizes[4], 'nothing is added to what a far view cannot show');
  assert(sizes[12] > sizes[4] * 2 && sizes[45] > sizes[12] * 1.5); assert.equal(sizes[45], sizes[80]);
  // A post is a third of a base, or not much more.
  assert(sizes[45] * 1.8 < draw(base(steep), world, 1 / 45).works.calls.length);
});

test('a post is built in its stages: pegs first, then footings and scaffolding, then its works, and its flag when all is done', () => {
  const x = level, at = u => x + u, ground = u => world.height(at(u)), stage = progress => drawPost(post(x), world, 1 / 45, 0xd96a4a, progress),
    done = stage(1), cloth = g => g.works.fills().filter(f => f.style.color === CLOTH).length;
  // Not begun: the markers, the band and the pegs each work is set out by, at both its ends, and nothing else stands.
  const bare = stage(0), pegs = stroked(bare.works).find(s => s.style.color === TIMBER).lines;
  assert.equal(bare.works.fills().length, 6, 'the pennants and the footings of the markers');
  assert.equal(scaffolding(bare.works).length, 0); assert.equal(bare.front.fills().length, 0);
  for (const u of [POST_WORKS.hardstand[0], POST_WORKS.magazine[1], POST_WORKS.mast - .4, 25 + POST_WORKS.bin[0]])
    assert(pegs.some(([px, py]) => close(px, at(u), 1e-6) && close(py, ground(u) - .1, 1e-6)), `a peg at ${u}`);
  assert(!stroked(done.works).some(s => s.style.color === TIMBER && s.lines.length && s.lines.every(([, y0, , y1]) => close(y1 - y0, 1))), 'no pegs once done');
  // Under way: what rises stands in scaffolding, its standards each on the ground under it.
  for (const [progress, from, to] of [[.4, ...POST_WORKS.shelter], [.5, -25 - 6.5, -25 + 5.5], [.8, 25 + POST_WORKS.bin[0], 25 + POST_WORKS.bin[1]]]) {
    const tubes = scaffolding(stage(progress).works).flatMap(s => s.lines), standards = tubes.filter(([x0, , x1]) => x0 === x1 && x0 >= at(from) - .6 && x0 <= at(to) + .6);
    assert(standards.length >= 3, `scaffolding from ${from} to ${to} at ${progress}`);
    for (const [px, y0] of standards) assert(y0 <= world.height(px) - .1 + 1e-9 && y0 > world.height(px) - 1.5, 'a standard on its ground');
  }
  assert.equal(scaffolding(done.works).length, 0, 'the scaffolding is struck once all is done');
  // What rises shows how far it has come: the shelter and the bin grow taller as the works go on.
  const tallest = (progress, from, to) => Math.max(...places(stage(progress).works).filter(([px]) => px >= at(from) && px <= at(to)).map(([, py]) => py));
  for (const [[from, to], steps] of [[POST_WORKS.shelter, [.15, .25, .35, .45, .55]], [POST_WORKS.bin.map(u => 25 + u), [.45, .55, .65, .75, .85]]]) {
    const heights = steps.map(p => tallest(p, from, to));
    for (let i = 1; i < heights.length; i++) assert(heights[i] >= heights[i - 1] - 1e-9, `${from}: ${heights.map(h => h.toFixed(1))}`);
    assert(heights.at(-1) > heights[0] + 2);
  }
  // The flag flies only once all is done, over where the label stood from the start.
  for (const progress of [0, .1, .3, .5, .7, .9, .97, .999]) {
    const drawn = stage(progress);
    assert.equal(cloth(drawn), 0, `no flag at ${progress}`); assert.deepEqual(drawn.flag, done.flag, 'the label stays where the flag will fly');
  }
  assert.equal(cloth(done), 1);
  const footed = progress => stage(progress).works.fills().filter(f => solid(f, FOOTING) || solid(f, 0xa2a191)).length;
  assert(footed(.1) > footed(0) && footed(.97) > footed(.1));
  // A share beyond the works is the post done, and one short of them or none at all the post not begun.
  assert.deepEqual(stage(2).works.calls, done.works.calls);
  for (const none of [-1, NaN]) { assert.deepEqual(stage(none).works.calls, bare.works.calls); assert.deepEqual(stage(none).front.calls, bare.front.calls); }
  for (const [from, to] of Object.values(POST_BUILD)) assert(from > 0 && from < to && to < 1, 'each work is begun after the post is laid out and stands before it is done');
});

test('a post shows nothing of what it holds, and its materials only grain the outlines it has', () => {
  const materials = Object.fromEntries(['paint', 'concrete', 'canvas', 'rubber', 'earth'].map(name => [name, { texture: name }])), styles = new Set(Object.values(materials));
  for (const progress of [.5, 1]) for (const pixel of [.25, 1 / 45]) {
    const bare = drawPost(post(level), world, pixel, 0xd96a4a, progress),
      stocked = drawPost({ ...post(level), stocks: { iron: 9e5, fuel: 4e4, ammo: 300 }, fuel: 1e5, queue: 3, seen: false, owner: 'x' }, world, pixel, 0xd96a4a, progress);
    assert.deepEqual(stocked.works.calls, bare.works.calls); assert.deepEqual(stocked.front.calls, bare.front.calls); assert.deepEqual(stocked.flag, bare.flag);
    const grained = drawPost(post(level), world, pixel, 0xd96a4a, progress, materials), untextured = [];
    let overlays = 0;
    for (let i = 0; i < grained.works.calls.length; i++) {
      const call = grained.works.calls[i], next = grained.works.calls[i + 1];
      if (call[0] === 'poly' && next?.[0] === 'fill' && styles.has(next[1])) { overlays++; i++; } else untextured.push(call);
    }
    assert.deepEqual(untextured, bare.works.calls); assert.deepEqual(grained.front.calls, bare.front.calls);
    assert(pixel < SEEN_PIXEL ? overlays > 20 : overlays === 0);
  }
});
