import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { depositsOf, DEPOSIT_RESERVE } from '../src/deposits.ts';
import { strataPlan, bedLines } from '../src/strata-art.ts';
import { drawSite, drawVein, depositLook, lookKey, cutBody, outlineArea, DEPOSIT_TONES, ORE_TONES, DEPOSIT_ART_REACH, ORE_STEPS } from '../src/deposit-art.ts';
import { GraphicsRecorder } from './scenery-canvas.js';
import { mineralTexture } from '../src/textures.ts';

const world = new Terrain('world', { seed: 6173, length: 40000 }), plan = strataPlan(world), deposits = depositsOf(world);
// One site of each feature a site is read off, as the ground has them.
const FEATURES = ['outcrop', 'ruins', 'talus', 'dune', 'lowland'], sample = FEATURES.map(feature => deposits.find(site => site.feature === feature));

test('a shared rock material changes only fills and preserves site geometry, footing and ore state', () => {
  const surface = mineralTexture(Float32Array.from({ length: 512 * 512 }, (_, i) => 1 + Math.sin(i * .017) * .06)), snapshot = world.snapshot();
  try {
    for (const site of sample.filter(s => ['outcrop', 'talus'].includes(s.feature))) {
      const plain = { works: new GraphicsRecorder(), front: new GraphicsRecorder() }, textured = { works: new GraphicsRecorder(), front: new GraphicsRecorder() };
      drawSite(plain, site, world, 1 / 45); drawSite(textured, site, world, 1 / 45, surface);
      for (const part of ['works', 'front']) assert.deepEqual(textured[part].calls.filter(c => c[0] !== 'fill'), plain[part].calls.filter(c => c[0] !== 'fill'));
      assert(textured.works.fills().some(f => f.style.texture === surface));
    }
    assert.deepEqual(world.snapshot(), snapshot);
  } finally { surface.destroy(true); }
});
// A site as everybody draws it, and its vein as a faction that knows `look` of it draws it besides.
const draw = (site, look, pixel = 1 / 45) => {
  const parts = { works: new GraphicsRecorder(), under: new GraphicsRecorder(), front: new GraphicsRecorder() };
  drawSite(parts, site, world, pixel);
  return { ...parts, plate: look ? drawVein(parts, site, look, world, pixel, plan) : null };
};
const vein = (site, look, pixel = 1 / 45) => {
  const parts = { works: new GraphicsRecorder(), under: new GraphicsRecorder(), front: new GraphicsRecorder() };
  return { ...parts, plate: drawVein(parts, site, look, world, pixel, plan) };
};
// What the faction knows of the vein of a site, when so much of its reserve was left.
const known = (site, share, more = {}) => depositLook({ ...site, left: share * site.reserve, at: null, seen: true, loading: false, active: true, ...more });
const places = g => g.calls.flatMap(c => c[0] === 'poly' ? c[1].flatMap((v, i) => i % 2 ? [] : [[v, c[1][i + 1]]]) : c[0] === 'moveTo' || c[0] === 'lineTo' ? [[c[1], c[2]]] : []);
const extent = points => { const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2); return { left: Math.min(...xs), right: Math.max(...xs), low: Math.min(...ys), high: Math.max(...ys) }; };
const pairs = points => points.flatMap((v, i) => i % 2 ? [] : [[v, points[i + 1]]]);
const toneOf = style => style?.color ?? style;
const area = fills => fills.reduce((sum, f) => sum + outlineArea(pairs(f.points)), 0);
// The ore of a vein: its body in the tone of the ore at its full strength, under the halo about it.
const core = (art, site) => { const tone = ORE_TONES[site.feature]; return art.under.fills().filter(f => toneOf(f.style) === tone.body && f.style.alpha === tone.strength); };
const lowest = (a, b) => { let y = Infinity; for (let x = a; x <= b; x += .25) y = Math.min(y, world.height(x)); return Math.min(y, world.height(b)); };

test('the ground of the sample has a site of each feature, and every site holds a vein, richer the farther it lies', () => {
  for (const [i, site] of sample.entries()) {
    assert(site, `a site on ${FEATURES[i]} within 20 km of the middle`);
    assert.deepEqual(Object.keys(site), ['id', 'x', 'material', 'feature', 'reserve'], 'a site says nothing of what is left of its vein');
  }
  assert(deposits.every(site => site.reserve >= DEPOSIT_RESERVE), 'no site is bare ground');
  for (const feature of ['outcrop', 'talus', 'dune', 'lowland']) {
    const reserves = deposits.filter(site => site.feature === feature).map(site => site.reserve);
    assert(Math.max(...reserves) > Math.min(...reserves), `${feature}: veins of more than one reserve`);
  }
});

test('what the drawing takes of a vein is what the faction knows of it: the share of its reserve left, in steps, whether it was dug and whether it is loaded from', () => {
  const site = sample[0];
  assert.equal(depositLook(null), null); assert.equal(depositLook(undefined), null);
  assert.deepEqual(known(site, 1), { share: 1, begun: false, loading: false, extracting: false, pile: 0 });
  assert.deepEqual(known(site, .5, { loading: true }), { share: .5, begun: true, loading: true, extracting: false, pile: 0 });
  assert.equal(depositLook({ ...site, left: site.reserve - 1 }).share, 1, 'a step of digging is a step of the reserve');
  assert.equal(depositLook({ ...site, left: site.reserve - 1 }).begun, true);
  // A vein is told only while something is left of it, and the least that is told keeps a step of ore.
  for (const left of [1, 999, 1000, site.reserve / ORE_STEPS]) assert.equal(depositLook({ ...site, left }).share, 1 / ORE_STEPS, String(left));
  // A share between two steps is drawn as the next one up, and the look is a word that changes with it.
  assert.equal(known(site, .52).share, .55); assert.equal(lookKey(known(site, .52)), lookKey(known(site, .55)));
  assert.equal(new Set([null, known(site, 1), known(site, .55), known(site, .5), known(site, .5, { loading: true })].map(lookKey)).size, 5);
  assert.equal(lookKey(null), '-');
});

test('a body is cut where it is dug: the line that leaves the share asked of its area on the side kept', () => {
  const square = [[0, 0], [2, 0], [2, 1], [0, 1]], other = [[0, 3], [2, 3], [2, 4], [0, 4]];
  for (const [share, side, level] of [[.3, 1, .7], [.3, -1, .3], [1, 1, 0], [1, -1, 1], [.05, 1, .95]]) {
    const cut = cutBody([square], share, 1, side);
    assert(Math.abs(cut.level - level) < 1e-6, `${share} kept ${side > 0 ? 'past' : 'before'} the line at ${cut.level}`);
    const ore = cut.ore.reduce((sum, part) => sum + outlineArea(part), 0), worked = cut.worked.reduce((sum, part) => sum + outlineArea(part), 0);
    assert(Math.abs(ore - 2 * share) < 1e-6 && Math.abs(worked - 2 * (1 - share)) < 1e-6);
  }
  // Two parts are cut as one body: what is dug is all that lies before the line, the first part whole.
  const two = cutBody([square, other], .25, 1, 1);
  assert(Math.abs(two.level - 3.5) < 1e-6); assert.equal(two.ore.length, 1); assert.equal(two.worked.length, 2);
  assert.deepEqual(two.ore[0].map(p => Math.round(p[1] * 1e6) / 1e6).sort(), [3.5, 3.5, 4, 4]);
  // Along the other axis just the same.
  assert(Math.abs(cutBody([square], .25, 0, -1).level - .5) < 1e-6);
});

test('the art of a site and of its vein is the same every time, keeps to its reach and leaves the ground as it was', () => {
  const before = world.snapshot();
  for (const site of sample) for (const look of [null, known(site, 1), known(site, .5), known(site, .5, { loading: true }), known(site, .05)]) for (const pixel of [2, .25, 1 / 12, 1 / 80]) {
    const a = draw(site, look, pixel), b = draw(site, look, pixel);
    for (const part of ['works', 'under', 'front']) assert.deepEqual(a[part].calls, b[part].calls);
    assert.deepEqual(a.plate, b.plate); assert.equal(Boolean(a.plate), Boolean(look));
    for (const [x, y] of ['works', 'under', 'front'].flatMap(part => places(a[part]))) {
      assert(Number.isFinite(x) && Number.isFinite(y));
      assert(Math.abs(x - site.x) <= DEPOSIT_ART_REACH, `${site.feature}: a piece ${(x - site.x).toFixed(1)} m from the site`);
      assert(y > world.height(site.x) - 40 && y < world.height(site.x) + 12 + 30 * pixel, `${site.feature}: a piece ${(y - world.height(site.x)).toFixed(1)} m over the site`);
    }
    // No outline has a corner on the one before it: a line drawn round it could not turn there, and Pixi builds it into no number at all.
    for (const part of ['works', 'under', 'front']) for (const call of a[part].calls) if (call[0] === 'poly') {
      const corners = pairs(call[1]);
      for (const [i, [x, y]] of corners.entries()) { const [u, v] = corners[(i + 1) % corners.length]; assert(Math.hypot(u - x, v - y) > 1e-7, `${site.feature}: two corners at one place in ${part}`); }
    }
    // Paths, not objects: some hundreds of instructions a site, built when what is known or the scale changes and never on a frame.
    for (const part of ['works', 'under', 'front']) assert(a[part].calls.length < 500, `${site.feature}: ${a[part].calls.length} calls in ${part}`);
  }
  assert.deepEqual(world.snapshot(), before);
});

test('a site is drawn from its ground alone, alike however rich its vein, and with nothing under the ground', () => {
  for (const feature of ['outcrop', 'talus', 'dune', 'lowland']) {
    const sites = deposits.filter(site => site.feature === feature).sort((a, b) => a.reserve - b.reserve), lean = sites[0], rich = sites.at(-1);
    assert(rich.reserve > lean.reserve, feature);
    // What everybody sees of a site has no part under the ground to draw into, no post and no plate, and nothing in the tints of the ore.
    const [a, b] = [lean, rich].map(site => { const parts = { works: new GraphicsRecorder(), front: new GraphicsRecorder() }; drawSite(parts, site, world, 1 / 45); return parts; });
    for (const art of [a, b]) for (const part of ['works', 'front']) {
      const tones = new Set(art[part].calls.filter(c => c[0] === 'fill' || c[0] === 'stroke').map(c => toneOf(c[1])));
      for (const tone of ['body', 'halo', 'band']) assert(!tones.has(ORE_TONES[feature][tone]), `${feature}: the ${tone} of the ore in ${part}`);
      assert(!art[part].fills().some(f => f.style?.alpha === .95 && Object.values(DEPOSIT_TONES).some(t => t.plate === toneOf(f.style))), `${feature}: a plate in ${part}`);
    }
    // The same pieces in the same tones, by the same rule: only their places, which are the ground's, differ.
    const kinds = calls => calls.map(c => [c[0], c[0] === 'fill' || c[0] === 'stroke' ? toneOf(c[1]) : null]);
    for (const part of ['works', 'front']) assert.deepEqual(kinds(a[part].calls), kinds(b[part].calls), `${feature}: ${part}`);
  }
});

test('the ore of a vein known is as large as its reserve and keeps the share the faction knows is left, by steps, whatever the vein holds', () => {
  for (const site of sample) {
    const shares = [1, .75, .5, .25, .05], areas = shares.map(share => area(core(vein(site, known(site, share)), site)));
    assert(areas[0] > 4, `${site.feature}: ${areas[0].toFixed(1)} m² of ore`);
    for (const [i, share] of shares.entries()) {
      assert(Math.abs(areas[i] / areas[0] - share) < .02, `${site.feature}: ${(areas[i] / areas[0]).toFixed(3)} of the ore drawn for ${share} of it left`);
      if (i) assert(areas[i] < areas[i - 1], 'less ore for less left');
    }
    assert(areas.at(-1) > 0, 'the least a vein is told with shows some ore');
    // Within a step the drawing is the same; a step down is another.
    assert.deepEqual(vein(site, known(site, .52)).under.calls, vein(site, known(site, .55)).under.calls);
    // A richer vein is a larger body; drawn for what the faction was told, never for what the vein holds now.
    const lean = { ...site, reserve: DEPOSIT_RESERVE }, rich = { ...site, reserve: DEPOSIT_RESERVE * 3 };
    assert(area(core(vein(rich, known(rich, 1)), rich)) > area(core(vein(lean, known(lean, 1)), lean)) * 1.5, site.feature);
    assert.deepEqual(vein(site, depositLook({ ...site, left: site.reserve / 2, held: 0 })).under.calls, vein(site, known(site, .5)).under.calls);
  }
});

test('the ore sits in the rock: a tint the beds read through, fading out through a halo of weaker ore, with no line round it', () => {
  for (const site of sample) for (const look of [known(site, 1), known(site, .5)]) {
    const art = vein(site, look), tone = ORE_TONES[site.feature], body = core(art, site), fills = art.under.fills();
    // Nothing under the ground hides the earth it lies in.
    for (const f of fills) assert(typeof f.style === 'object' && f.style.alpha <= .6, `${site.feature}: a fill of ${toneOf(f.style).toString(16)} at ${f.style.alpha}`);
    // The halo reaches past the ore, each ring of it fainter than the ore; ring over ring it grows towards the body.
    const halo = fills.filter(f => toneOf(f.style) === tone.halo || toneOf(f.style) === tone.body && f.style.alpha < tone.strength);
    assert(halo.length >= 5 && halo.every(f => f.style.alpha < tone.strength / 2), `${site.feature}: ${halo.length} rings of halo`);
    // Of a vein not dug yet, all round; where it is dug, the halo is cut at the face with the ore.
    const reach = extent(halo.flatMap(f => f.points)), ore = extent(body.flatMap(f => f.points));
    if (!look.begun) assert(reach.left < ore.left - .5 && reach.right > ore.right + .5 && reach.low < ore.low - .5, `${site.feature}: the halo reaches past the ore`);
    // No outline under the ground is drawn round with a line: every edge there is a fading one.
    assert(!art.under.calls.some((c, i) => c[0] === 'stroke' && ['poly', 'fill'].includes(art.under.calls[i - 1]?.[0])), `${site.feature}: an outline drawn round`);
  }
});

test('the vein lies along the beds of the earth it is drawn in', () => {
  const lines = new Float64Array(4), depth = (x, bed) => world.height(x) - bedLines(plan, x, 0, lines, 3)[bed];
  for (const site of sample) {
    const body = core(vein(site, known(site, 1)), site).flatMap(f => pairs(f.points)), mean = body.reduce((sum, [x, y]) => sum + y, 0) / body.length,
      middle = body.reduce((sum, [x]) => sum + x, 0) / body.length, under = world.height(middle) - mean;
    // Its middle lies between the top of the earth and the third of its beds, where the beds run there.
    assert(under > 0 && under < depth(middle, 3) + 2, `${site.feature}: ${under.toFixed(1)} m down, the third bed ${depth(middle, 3).toFixed(1)} m`);
    // And along them, as a bed lies: a body is far longer than it is deep; the pods of the alloys are strung along it one by one.
    const span = extent(body.flat());
    assert(span.right - span.left > 3 * (span.high - span.low) || site.feature === 'talus', `${site.feature}: longer than deep`);
  }
});

test('digging leaves its workings, which grow with what was dug, and a vein loaded from shows it', () => {
  // The worked ground: caved or backfilled, or the water that rose under the petroleum.
  const worked = (art, site) => area(art.under.fills().filter(f => site.feature === 'lowland' ? toneOf(f.style) === ORE_TONES.lowland.water && f.style.alpha === .18
    : [0x47433d, 0xa39a80].includes(toneOf(f.style)) && f.style.alpha === .24));
  for (const site of sample) {
    const untouched = vein(site, known(site, 1)), half = vein(site, known(site, .5)), spent = vein(site, known(site, .05)), loading = vein(site, known(site, .5, { loading: true }));
    const standing = art => area(art.works.fills());
    assert.equal(worked(untouched, site), 0, `${site.feature}: nothing worked before digging`);
    assert(worked(half, site) > 1 && worked(spent, site) > worked(half, site), `${site.feature}: the workings grow`);
    if (site.feature !== 'dune') assert(standing(half) > standing(untouched) + .5, `${site.feature}: something stands about the working`);
    // A well is the same well however much it has drawn; what a mine takes out it heaps beside it.
    if (!['lowland', 'dune'].includes(site.feature)) assert(standing(spent) > standing(half), `${site.feature}: the waste grows`);
    assert.notDeepEqual([loading.works.calls, loading.under.calls], [half.works.calls, half.under.calls], `${site.feature}: loading shows`);
  }
});

test('the ready stockpile shrinks when hauled, independently of the reserve already extracted', () => {
  for (const site of sample) {
    const empty = known(site, .5), ready = known(site, .5, { stock: 12000 }), less = known(site, .5, { stock: 50 }),
      exhausted = known(site, 0, { stock: 12000, extracting: false });
    assert.equal(empty.pile, 0); assert(ready.pile > less.pile && less.pile > 0);
    assert.notEqual(lookKey(ready), lookKey(empty)); assert.notEqual(lookKey(ready), lookKey(less));
    assert.notDeepEqual(vein(site, ready).works.calls, vein(site, empty).works.calls);
    assert.equal(exhausted.share, 0); assert.equal(exhausted.pile, ready.pile);
    assert(vein(site, exhausted).works.calls.length > 0, 'a depleted underground reserve retains its ready pile');
    assert.notEqual(lookKey(known(site, .5, { extracting: true })), lookKey(empty));
  }
});

test('every piece is where it belongs: what stands is footed on its ground, what lies on the ground lies on it and the vein is under it', () => {
  for (const site of sample) for (const look of [null, known(site, .5, { loading: true }), known(site, .05)]) {
    const art = draw(site, look, 1 / 45);
    for (const [x, y] of places(art.under)) assert(y <= world.height(x) - .02 + 1e-9, `${site.feature}: ${(y - world.height(x)).toFixed(2)} m over the ground under it`);
    for (const [x, y] of places(art.front)) assert(Math.abs(y - world.height(x)) < .4, `${site.feature}: ${(y - world.height(x)).toFixed(2)} m from the ground it lies on`);
    for (const fill of art.works.fills()) {
      const piece = extent(fill.points), under = lowest(piece.left, piece.right);
      assert(piece.high > under, `${site.feature}: a piece from ${(piece.left - site.x).toFixed(1)} m shows over its ground`);
      assert(piece.low > under - 1.6, `${site.feature}: a piece from ${(piece.left - site.x).toFixed(1)} m stands ${(piece.low - under).toFixed(2)} m into its ground`);
    }
  }
});

test('the plate on the post tells the material at any scale, and a near view gains its detail', () => {
  const sizes = {};
  for (const zoom of [.5, 4, 12, 45, 80]) {
    const pixel = 1 / zoom;
    sizes[zoom] = 0;
    for (const site of sample) {
      const art = draw(site, known(site, .5), pixel), tone = DEPOSIT_TONES[site.material];
      sizes[zoom] += art.works.calls.length + art.under.calls.length + art.front.calls.length;
      const plate = art.works.fills().filter(f => toneOf(f.style) === tone.plate && f.style.alpha === .95).map(f => extent(f.points));
      assert.equal(plate.length, 1, 'a plate in the tone of the material, and nothing else in it');
      assert(Math.abs((plate[0].left + plate[0].right) / 2 - site.x) < 1e-9 && Math.abs(plate[0].high - art.plate.y) < 1e-9 && art.plate.x === site.x);
      assert((plate[0].high - plate[0].low) * zoom >= 9 - 1e-6 || plate[0].high - plate[0].low >= .84 - 1e-9, 'seen at any scale');
      assert((plate[0].low - world.height(site.x)) * zoom >= 16 || plate[0].low - world.height(site.x) > 1.8, 'and clear of the ground');
      for (const part of ['works', 'under', 'front']) for (const call of art[part].calls) if (call[0] === 'stroke') assert(call[1].width >= .8 * pixel - 1e-12, `a line of ${call[1].width * zoom} px`);
    }
  }
  assert.equal(sizes[.5], sizes[4], 'nothing is added to what a far view cannot show');
  assert(sizes[45] > sizes[4], 'a near view shows the seams, the stones and the timbers'); assert.equal(sizes[45], sizes[80]);
  assert.equal(new Set(Object.values(DEPOSIT_TONES).map(tone => tone.plate)).size, 4, 'each material has a tone of its own');
  // The edge round a plate is darker than the plate by a clear step, whatever the material: a plate as dark as its
  // edge or darker shows it as a pale ring, and reads as a hole and not as the same sign in another colour.
  const light = color => .299 * (color >> 16 & 255) + .587 * (color >> 8 & 255) + .114 * (color & 255);
  for (const site of sample) {
    const { works } = draw(site, known(site, 1), 1 / 4), tone = DEPOSIT_TONES[site.material].plate,
      at = works.calls.findIndex(call => call[0] === 'fill' && toneOf(call[1]) === tone && call[1].alpha === .95), edge = works.calls[at + 1];
    assert.equal(edge[0], 'stroke', `${site.material}: an edge round its plate`);
    assert(light(tone) - light(toneOf(edge[1])) >= 32, `${site.material}: a plate ${(light(tone) - light(toneOf(edge[1]))).toFixed(0)} lighter than its edge`);
  }
});
