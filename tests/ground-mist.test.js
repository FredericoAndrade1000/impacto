import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Mesh, Sprite, Texture } from 'pixi.js';
import { GroundMist, WISP_FRAGMENT, fieldFog, mistBands, mistOver, layMist, nearestKnown, rampLevel, riseLevel, softCover, VEIL_SOFT, VEIL_STRENGTH, LOW_AIR, MIST_EDGE, MIST_HEIGHT, MIST_FADE, MIST_DEEP, MIST_SPAN, MIST_PIXELS, MIST_EDGE_PIXELS, mistEdge, EDGE_RISE, STRIDE, STEP, SWELL, BASE_MARGIN, MET_REACH } from '../src/ground-mist.ts';
import { GroundSight, ViewSight, contains, merged, unite, apart, SIGHT_CELL } from '../src/ground-sight.ts';
import { mistTones, skyTones } from '../src/landscape-art.ts';
import { Renderer } from '../src/render.ts';
import { Effects } from '../src/effects.ts';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { SHAKE_LEVELS } from '../src/screen-shake.ts';
import { GraphicsRecorder } from './scenery-canvas.js';
import { groundSurfaces } from './helpers/ground-art.js';

test('moving an unchanged haze repositions its texture without uploading the same alpha cells again', t => {
  const mist = new GroundMist(); t.after(() => mist.destroy()); mist.look = mistTones('clear');
  let cover = 1;
  const sight = { columns: 4, rows: 4, first: 0, bottom: 0, cell: 8, cover: into => into.fill(cover) };
  mist.hazeOver(sight);
  let uploads = 0; mist.shade.texture.source.on('update', () => uploads++);
  for (let i = 0; i < 50; i++) { sight.first++; mist.hazeOver(sight); }
  assert.equal(uploads, 0); assert.equal(mist.veil.x, 400); assert(mist.veil.visible);
  cover = 0; mist.hazeOver(sight); assert.equal(mist.veil.visible, false);
  cover = 1; mist.hazeOver(sight); assert.equal(uploads, 1); assert(mist.veil.visible);
  cover = .5; mist.hazeOver(sight); assert.equal(uploads, 2);
  mist.hazeOver(sight); assert.equal(uploads, 2);
});

// The haze as it was laid before it learnt its shortcuts: every cell of every column eased by its depth under the line,
// every neighbour of every cell clamped to the mask. What the haze lays is this, byte for byte.
function hazeByEveryCell(mask, columns, rows, { cell, first, bottom }, ground) {
  const cover = Float32Array.from(mask), spare = new Float32Array(cover.length), reach = cell * (2 * VEIL_SOFT + 1), wide = 2 * VEIL_SOFT + 1;
  const ease = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
  for (let column = 0; column < columns; column++) {
    const line = ground.height((first + column + .5) * cell);
    for (let row = 0; row < rows; row++) { const at = row * columns + column; cover[at] = Math.max(cover[at], ease((line - (bottom + row + .5) * cell) / reach)); }
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    let sum = 0; for (let k = -VEIL_SOFT; k <= VEIL_SOFT; k++) sum += cover[row * columns + Math.min(columns - 1, Math.max(0, column + k))];
    spare[row * columns + column] = sum / wide;
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    let sum = 0; for (let k = -VEIL_SOFT; k <= VEIL_SOFT; k++) sum += spare[Math.min(rows - 1, Math.max(0, row + k)) * columns + column];
    cover[row * columns + column] = rampLevel(sum / wide);
  }
  return Uint8Array.from(cover, value => Math.round(255 * value));
}

test('the haze over a rolling ground is laid byte for byte as cell by cell, panned, held and over another sight', t => {
  const mist = new GroundMist(); t.after(() => mist.destroy()); mist.look = mistTones('clear');
  const columns = 61, rows = 37, cell = 2.5, ground = { height: x => 14 * Math.sin(x / 23) + 6 * Math.sin(x / 7.1) },
    mask = new Float32Array(columns * rows), sight = { columns, rows, cell, first: -12, bottom: -9, cover: into => { into.set(mask); return into; } };
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const alphas = () => mist.shade.data.filter((_, i) => i % 4 === 3);
  for (let frame = 0; frame < 40; frame++) {
    // Now the sight changes, now the view goes along and down the ground by a cell, now it is held still.
    // Some rows of one value all along, as the sky in sight and the earth under the veil are, some bands of them.
    if (frame % 3 === 0) for (let i = 0; i < mask.length; i++) {
      const row = Math.floor(i / columns), band = (row + frame) % 11;
      mask[i] = band < 3 ? 0 : band < 6 ? 1 : random() < .35 ? 1 : random() < .1 ? .5 : 0;
    }
    if (frame % 3 === 1) { sight.first += frame % 2 ? 1 : -2; sight.bottom += frame % 4 ? 1 : -1; }
    mist.hazeOver(sight, ground);
    assert.deepEqual(alphas(), hazeByEveryCell(mask, columns, rows, sight, ground), 'frame ' + frame);
  }
});

test('changing one haze cell retains the exact RGBA of a freshly softened mask', t => {
  const mist = new GroundMist(); t.after(() => mist.destroy()); mist.look = mistTones('clear');
  const columns = 7, rows = 5, mask = Float32Array.from({ length: columns * rows }, (_, i) => i % columns >= 3 ? 1 : 0),
    sight = { columns, rows, first: 0, bottom: 0, cell: 8, cover: into => { into.set(mask); return into; } },
    reference = () => {
      const cover = softCover(mask.slice(), new Float32Array(mask.length), columns, rows), rgba = new Uint8Array(mask.length * 4).fill(255);
      for (let i = 0; i < cover.length; i++) rgba[i * 4 + 3] = Math.round(255 * cover[i]);
      return rgba;
    };
  mist.hazeOver(sight); assert.deepEqual(mist.shade.data, reference());
  const texture = mist.shade.texture;
  // Changes at a corner, the middle and the opposite edge exercise both clamped blur passes.
  for (const cell of [0, 17, 34]) {
    mask[cell] = 1 - mask[cell]; mist.hazeOver(sight);
    assert.deepEqual(mist.shade.data, reference()); assert.equal(mist.shade.texture, texture);
  }
  // The retained input is Float32, so fractional coverage is compared without integer truncation too.
  mask[17] = .5; mist.hazeOver(sight); assert.deepEqual(mist.shade.data, reference());
  mist.hazeOver(sight); assert.deepEqual(mist.shade.data, reference());
});

test('unchanged haze masks skip blur and RGBA work while panning, changing tint or returning from no sight', t => {
  const mist = new GroundMist(); t.after(() => mist.destroy()); mist.look = mistTones('clear');
  let cover = 1;
  const sight = { columns: 4, rows: 4, first: 0, bottom: 0, cell: 8, cover: into => into.fill(cover) };
  mist.hazeOver(sight);
  const shade = mist.shade, texture = shade.texture, data = shade.data;
  let uploads = 0; texture.source.on('update', () => uploads++);
  // Scratch stays untouched when no blur runs. Guarding the actual output array also catches
  // an unnecessary alpha-conversion pass, without a production counter or a replacement blur.
  shade.spare.fill(NaN);
  shade.data = new Proxy(data, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) assert.fail('unchanged coverage must not reread RGBA output');
      return Reflect.get(target, key, target);
    },
    set() { assert.fail('unchanged coverage must not rewrite RGBA output'); },
  });
  for (let i = 0; i < 50; i++) { sight.first++; sight.bottom--; mist.hazeOver(sight); }
  sight.cell = 4; mist.look = mistTones('mist'); mist.hazeOver(sight);
  assert.deepEqual([mist.veil.x, mist.veil.y, mist.veil.scale.x, mist.veil.scale.y], [200, -200, 4, 4]);
  assert.deepEqual([mist.veil.alpha, mist.veil.tint, mist.veil.visible], [VEIL_STRENGTH, mistTones('mist').veil, true]);
  mist.hazeOver(null); assert.equal(mist.veil.visible, false);
  mist.hazeOver(sight); assert.equal(mist.veil.visible, true);
  assert(shade.spare.every(Number.isNaN)); assert.equal(uploads, 0); assert.equal(mist.shade, shade);
  shade.data = data;
  // Equal cell count is insufficient for reuse: different row/column counts have different edges.
  sight.columns = 2; sight.rows = 8; mist.hazeOver(sight);
  assert.notEqual(mist.shade, shade); assert(texture.destroyed); assert(mist.veil.visible);
  assert.equal(mist.veil.texture, mist.shade.texture); assert(mist.shade.data.every(value => value === 255));
  cover = 0; sight.columns = 3; sight.rows = 3; mist.hazeOver(sight);
  assert.equal(mist.veil.visible, false); assert(mist.shade.data.every((value, i) => i % 4 < 3 ? value === 255 : value === 0));
  mist.hazeOver(null); mist.hazeOver(sight); assert.equal(mist.veil.visible, false);
});

const whole = (from, to) => ({ from, to, a: 1, b: 1 });
// How much of a list of bands stands at a place: nothing where it has no band.
const level = (bands, x) => { const band = bands.find(band => x >= band.from && x <= band.to);
  return band ? band.a + (band.b - band.a) * (x - band.from) / (band.to - band.from) : 0; };
const close = (a, b, slack = 1e-9) => Math.abs(a - b) <= slack;
const alike = (bands, wanted) => { assert.equal(bands.length, wanted.length, JSON.stringify(bands));
  for (const [i, band] of bands.entries()) for (const key of ['from', 'to', 'a', 'b']) assert(close(band[key], wanted[i][key]), `${JSON.stringify(bands)} against ${JSON.stringify(wanted)}`); };

test('a view is under the bank where the faction never saw: what it knows, explored or in sight, is clear of it', () => {
  const view = { left: 1000, right: 1200 };
  assert.deepEqual(mistBands(view, []), [whole(1000, 1200)]);
  assert.deepEqual(mistBands(view, [[0, 5000]]), []);
  // A view just past the end of what is known: the bank on its way up, as far along it as the ground is.
  alike(mistBands(view, [[0, 990]]), [{ from: 1000, to: 1050, a: 1 / 6, b: 1 }, whole(1050, 1200)]);
  assert.deepEqual([MIST_EDGE, VEIL_STRENGTH], [60, .5]);
});

test('from afar the edge of the bank is as wide as a soft edge takes on the screen: it ends on a line at no zoom', () => {
  assert.equal(MIST_EDGE_PIXELS, 190);
  // Close by the edge is that of the ground; from afar it is as many metres as its pixels take.
  assert.deepEqual([mistEdge(12), mistEdge(4), mistEdge(1), mistEdge(.25)], [60, 60, 190, 760]);
  const view = { left: 0, right: 3000 };
  alike(mistBands(view, [[0, 1000]], mistEdge(.25)), [{ from: 1000, to: 1760, a: 0, b: 1 }, whole(1760, 3000)]);
  // Told no width, the band is that of the ground.
  assert.deepEqual(mistBands(view, [[0, 1000]]), mistBands(view, [[0, 1000]], MIST_EDGE));
});

test('the bank closes over sixty metres on the ground never seen: the ground that is known is clear of it', () => {
  const view = { left: 1000, right: 1200 };
  // Known to 1100: nothing of the bank before it, and the bank whole sixty metres on.
  alike(mistBands(view, [[0, 1100]]), [{ from: 1100, to: 1160, a: 0, b: 1 }, whole(1160, 1200)]);
  // Eighty metres known amid ground never seen are clear, all of them: what is seen is seen.
  alike(mistBands(view, [[1060, 1140]]), [{ from: 1000, to: 1060, a: 1, b: 0 }, { from: 1140, to: 1200, a: 0, b: 1 }]);
  // Two stretches known, with ground never seen between them.
  alike(mistBands({ left: 0, right: 3000 }, [[0, 1000], [2000, 3000]]), [{ from: 1000, to: 1060, a: 0, b: 1 }, whole(1060, 1940), { from: 1940, to: 2000, a: 1, b: 0 }]);
  // The edge of the view cuts a band where it stands on its ramp.
  alike(mistBands({ left: 1130, right: 1200 }, [[0, 1100]]), [{ from: 1130, to: 1160, a: .5, b: 1 }, whole(1160, 1200)]);
});

test('a fold of the ground that no eye caught is no wall of mist: the bank is over it as far as the fold is wide', () => {
  const view = { left: 0, right: 3000 };
  // Thirty metres never seen between two stretches known: a quarter of a bank at the most, in the middle.
  alike(mistBands(view, [[-2000, 1000], [1030, 5000]]), [{ from: 1000, to: 1015, a: 0, b: .25 }, { from: 1015, to: 1030, a: .25, b: 0 }]);
  // Six metres: next to nothing of it.
  alike(mistBands(view, [[-2000, 1000], [1006, 5000]]), [{ from: 1000, to: 1003, a: 0, b: .05 }, { from: 1003, to: 1006, a: .05, b: 0 }]);
  assert(rampLevel(.05) < .01, 'under a hundredth of the bank at its thickest');
  // A hundred and twenty metres is where a bank first gets whole, at one place.
  alike(mistBands(view, [[-2000, 1000], [1120, 5000]]), [{ from: 1000, to: 1060, a: 0, b: 1 }, { from: 1060, to: 1120, a: 1, b: 0 }]);
});

test('whatever is known, the bank stands by how far its ground is from the ground known, and no band begins or ends on a hard line', () => {
  let seed = 11; const random = () => (seed = seed * 1103515245 + 12345 >>> 0) / 2 ** 32,
    spans = (count, wide) => merged(Array.from({ length: count }, () => { const from = random() * 6000; return [from, from + 5 + random() * wide]; }));
  let closed = 0, clear = 0, rising = 0;
  for (let round = 0; round < 300; round++) {
    // Stretches in sight, with a fold between two of them in the view now and then.
    const left = random() * 5600, dip = left + 100 + random() * 300, folded = round % 4 ? [] : [[dip - 150, dip], [dip + 2 + random() * 56, dip + 200]],
      seen = merged([...spans(1 + Math.floor(random() * 5), round % 3 ? 400 : 60), ...folded]), explored = unite(spans(Math.floor(random() * 4), 1500), round % 2 ? seen : []),
      known = unite(explored, seen), view = { left, right: left + 60 + random() * 900 }, mist = mistBands(view, known);
    for (const bands of [mist]) for (const [i, band] of bands.entries()) {
      assert(band.to > band.from && band.from >= view.left && band.to <= view.right, 'within the view');
      assert([band.a, band.b].every(value => value >= -1e-9 && value <= 1 + 1e-9));
      if (i) assert(band.from >= bands[i - 1].to - 1e-9, 'none over another');
      // Where a band begins against nothing it begins at nothing, unless the screen ends there.
      const before = i && close(bands[i - 1].to, band.from) ? bands[i - 1].b : null, after = bands[i + 1] && close(bands[i + 1].from, band.to) ? bands[i + 1].a : null;
      if (before !== null) assert(close(before, band.a), 'two bands that touch stand alike where they touch');
      else assert(close(band.from, view.left) || close(band.a, 0), `a band begins at ${band.a} at ${band.from}: ${JSON.stringify({ view, explored, seen })}`);
      if (after === null) assert(close(band.to, view.right) || close(band.b, 0), `a band ends at ${band.b} at ${band.to}: ${JSON.stringify({ view, explored, seen })}`);
    }
    for (let x = view.left + .37; x < view.right; x += 13.1) {
      // The bank by how far the place is from ground that is known.
      const bank = Math.min(1, apart(known, x) / MIST_EDGE);
      assert(close(level(mist, x), bank, 1e-7), `the bank at ${x}: ${JSON.stringify({ view, explored, seen })}`);
      if (!bank) clear++; else if (bank === 1) closed++; else rising++;
    }
    // Seen through another view the same places stand alike: the edges are of the ground, not of the screen.
    const shift = (random() - .5) * 700, other = { left: view.left + shift, right: view.right + shift + random() * 300 }, again = mistBands(other, known);
    for (let x = Math.max(view.left, other.left) + .11; x < Math.min(view.right, other.right); x += 7.3)
      assert(close(level(mist, x), level(again, x), 1e-7), `the bank at ${x}: ${JSON.stringify({ view, other, explored, seen })}`);
  }
  assert(closed > 500 && clear > 500 && rising > 200, `${closed} places closed, ${clear} clear, ${rising} at an edge of the bank`);
});

test('the bank lies on the ground: by stretches, each a soft foot under where it begins, a body to where it is whole and a top in which it thins out', () => {
  const low = 1 - .5 / 32, high = .5 / 32, u = level => (.5 + level * 63) / 64, slope = { height: x => 150 + x / 10 };
  // One stretch of a band on its way up, on ground that climbs: half as high where it begins as where it is whole.
  const quads = new GraphicsRecorder();
  layMist(quads, [{ from: 10, to: 40, a: 0, b: 1 }], slope, { stride: 100, under: () => [0, 2], tall: (x, level) => [10 + 10 * level, 50] });
  assert.deepEqual(quads.calls, [
    // The foot: from nothing two metres under the ground to whole on its line.
    ['quad', 10, 149, 10, 151, 40, 152, 40, 154, u(0), high, u(1), low],
    // The body: whole from the ground to ten metres over it at one end, and to twenty at the other.
    ['quad', 10, 151, 10, 161, 40, 154, 40, 174, u(0), low, u(1), low],
    // The top: gone fifty metres higher.
    ['quad', 10, 161, 10, 211, 40, 174, 40, 224, u(0), low, u(1), high]]);
  // A layer told to begin under the line of the ground is whole from there: here from nothing at one end to six metres
  // under it at the other, coming on over two metres at one end and over five at the other.
  const sunk = new GraphicsRecorder();
  layMist(sunk, [{ from: 10, to: 40, a: 0, b: 1 }], slope, { stride: 100, under: (x, level) => [6 * level, 2 + 3 * level], tall: () => [10, 50] });
  assert.deepEqual(sunk.calls.slice(0, 2), [['quad', 10, 149, 10, 151, 40, 143, 40, 148, u(0), high, u(1), low], ['quad', 10, 151, 10, 161, 40, 148, 40, 164, u(0), low, u(1), low]]);
  // Across, a quad goes from where its band stands on the ramp at one end to where it stands at the other: the ends
  // of the ramp are the middles of its first and last texel, so that nothing beside them bleeds in.
  assert.deepEqual([u(0), u(1)], [.5 / 64, 63.5 / 64]);
  // The stretches are of the ground and not of the band: counted from where the ground begins, the same wherever a band does.
  const spans = (bands, ground, options) => { const laid = new GraphicsRecorder(); layMist(laid, bands, ground, { tall: () => [10, 50], ...options });
    return laid.calls.map(call => [call[1], call[5]]); };
  assert.deepEqual(spans([whole(250, 700)], slope, { stride: 100 }), [[250, 300], [250, 300], [300, 400], [300, 400], [400, 500], [400, 500], [500, 600], [500, 600], [600, 700], [600, 700]]);
  assert.deepEqual(spans([whole(250, 480)], { ...slope, minX: 30 }, { stride: 100 }), [[250, 330], [250, 330], [330, 430], [330, 430], [430, 480], [430, 480]]);
  assert.deepEqual(spans([whole(250, 420), whole(420, 440)], slope, { stride: 100, under: () => [0, 1] }).filter((_, i) => i % 3 === 0), [[250, 300], [300, 400], [400, 420], [420, 440]]);
  // From what is known to what is drawn: a view with ground known and ground never seen side by side. The bank goes
  // under the ground by no more than its foot, and stands over it no higher than it is told to.
  const mist = mistBands({ left: 0, right: 1000 }, [[-2000, 700]]), drawn = { mist: new GraphicsRecorder() };
  layMist(drawn.mist, mist, slope, { stride: 50, under: () => [0, 1], tall: x => [40 * riseLevel((x - 700) / MIST_DEEP), 80 * riseLevel((x - 700) / MIST_DEEP)] });
  const span = call => [call[1], call[5], +((call[9] * 64 - .5) / 63).toFixed(6), +((call[11] * 64 - .5) / 63).toFixed(6)], feet = calls => calls.filter((_, i) => i % 3 === 0);
  assert.deepEqual(feet(drawn.mist.calls).map(span), [[700, 750, 0, .833333], [750, 760, .833333, 1], [760, 800, 1, 1], ...Array.from({ length: 4 }, (_, i) => [800 + i * 50, 850 + i * 50, 1, 1])]);
  for (const call of drawn.mist.calls) {
    const [, ax, ay, , by, cx, cy, , dy] = call;
    assert(Math.min(ay, by) >= slope.height(ax) - 1 - 1e-9 && Math.min(cy, dy) >= slope.height(cx) - 1 - 1e-9, 'the earth under the ground is drawn as ever');
    assert(Math.max(ay, by) <= slope.height(ax) + 120 + 1e-9 && Math.max(cy, dy) <= slope.height(cx) + 120 + 1e-9, 'and the sky over the bank is the sky');
  }
  // A bank is low where it begins and deep within: a fifth of its height at its edge, all of it three hundred metres in.
  assert.deepEqual([MIST_HEIGHT, MIST_FADE, MIST_DEEP, EDGE_RISE], [40, 80, 300, .2]);
  const tops = feet(drawn.mist.calls).map((_, i) => drawn.mist.calls[i * 3 + 2][4] - slope.height(drawn.mist.calls[i * 3][1]));
  assert(close(tops[0], 120 * .2) && tops.every((top, i) => !i || top >= tops[i - 1]) && tops.at(-1) > 100 && tops.at(-1) < 120, `the top of the bank over the ground, stretch by stretch: ${tops.map(top => top.toFixed(1))}`);
  assert.deepEqual([riseLevel(-1), riseLevel(0), riseLevel(1), riseLevel(Infinity)], [.2, .2, 1, 1]); assert(close(riseLevel(.5), .6));
  // The ramp eases in and out: no corner where a band begins or where it gets whole.
  assert.deepEqual([rampLevel(-1), rampLevel(0), rampLevel(.5), rampLevel(1), rampLevel(2)], [0, 0, .5, 1, 1]);
  assert(rampLevel(.02) < .002 && rampLevel(.98) > .998 && rampLevel(.25) < .25 && rampLevel(.75) > .75);
});

test('how closed the bank is over a stretch is the least of it there', () => {
  const mist = mistBands({ left: 0, right: 3000 }, [[0, 1000]]);
  alike(mist, [{ from: 1000, to: 1060, a: 0, b: 1 }, whole(1060, 3000)]);
  assert.equal(mistOver(mist, 1060, 3000), 1); assert.equal(mistOver(mist, 1500, 1600), 1);
  assert.equal(mistOver(mist, 1030, 1600), rampLevel(.5)); assert.equal(mistOver(mist, 1030, 1045), rampLevel(.5));
  // A stretch with clear ground in it is not closed at all, whatever stands at its ends.
  assert.deepEqual([mistOver(mist, 940, 1600), mistOver(mist, 500, 2000), mistOver(mist, 200, 300), mistOver([], 0, 10)], [0, 0, 0, 0]);
  // At one place: what stands there.
  assert.deepEqual([mistOver(mist, 3000, 3000), mistOver(mist, 1030, 1030), mistOver(mist, 500, 500), mistOver([], 5, 5)], [1, rampLevel(.5), 0, 0]);
});

test('the ground in sight of a frame is what the eyes of the faction see where the frame shows them, its base, and the ground under what it sees of others', () => {
  const flat = { minX: -128000, maxX: 128000, height: () => 0 }, sight = new GroundSight(flat),
    eye = (x, left = 600, right = 600) => ({ x, y: 3, left, right }),
    state = { faction: { id: 'mine', explored: [[-1000, 1000]], base: { x: 0, y: 0, radius: 100 } }, actors: [
      { id: 'scout', team: 'mine', x: 5000, vehicle: { x: 5000, y: 1 }, eyes: [eye(5001)] },
      { id: 'blind', team: 'mine', x: 9000, vehicle: { x: 9000, y: 1 }, eyes: [] },
      { id: 'wreck', team: 'mine', defeated: true, x: 12000, vehicle: { x: 12000, y: 1 }, eyes: [eye(12000)] },
      { id: 'foe', team: 'theirs', x: 20000, vehicle: { x: 20000, y: 1 }, eyes: [eye(20000)] },
      { id: 'ghost', team: 'theirs', ghost: { since: 3 }, x: 30000, vehicle: { x: 30000, y: 1 } }] },
    fog = fieldFog(sight, state);
  // The base with fifty metres past each end; the scout's eye, as far as its circle meets the ground, 3 m under it; sixteen
  // about the foe. One of its own with no eye sees nothing, not the ground it stands on.
  assert.deepEqual([BASE_MARGIN, MET_REACH], [50, 16]);
  const reach = Math.sqrt(600 ** 2 - 3 ** 2);
  assert.deepEqual(fog.seen, [[-150, 150], [5001 - reach, 5001 + reach], [19984, 20016]]);
  const liveFire = fieldFog(new GroundSight(flat), { ...state, actors: state.actors.map(a => a.id === 'scout' ? { ...a, burning: true } : a) });
  assert.deepEqual(liveFire.seen, fog.seen, 'a shared fire does not hide the view of surviving cameras');
  // Known: what the field told, what is in sight, and the ground a ghost stands on. A wreck of its own sees nothing.
  assert.deepEqual(fog.explored, [[-1000, 1000], [5001 - reach, 5001 + reach], [19984, 20016], [29984, 30016]]);
  assert(!contains(fog.seen, 9000) && !contains(fog.explored, 9000) && !contains(fog.seen, 12000) && !contains(fog.explored, 12000) && !contains(fog.seen, 30000));
  // Between two states the frame shows a construction where it is on the way: its eyes go with it.
  const shown = fieldFog(sight, state, id => id === 'scout' ? { x: 5010, y: 1.5 } : null);
  assert.deepEqual(shown.seen[1], [5011 - Math.sqrt(600 ** 2 - 3.5 ** 2), 5011 + Math.sqrt(600 ** 2 - 3.5 ** 2)]);
  // A wreck of its own is seen while it burns, as one of another is: the ground about it and the air over it, until its fire is out.
  const burning = time => fieldFog(new GroundSight(flat), { ...state, time, actors: [...state.actors,
    { id: 'burning', team: 'mine', defeated: true, burning: time < 140, x: 15000, vehicle: { x: 15000, y: 1 }, eyes: [], field: { wreck: { until: 230 } } }] });
  assert.deepEqual([burning(139).seen[2], burning(139).domes[1]], [[14984, 15016], { x: 15000, y: 1, reach: MET_REACH }]);
  assert.deepEqual(burning(140).seen, fog.seen);
  // Nothing of its own on the field, and no base yet: nothing in sight, and what was told is what is known, the very list.
  const bare = fieldFog(new GroundSight(flat), { faction: { id: 'mine', explored: state.faction.explored, base: null }, actors: [] });
  assert.deepEqual(bare.seen, []); assert.equal(bare.explored, state.faction.explored);
  // What it sees the air with: no eye of a GroundSight that keeps no horizon, and a dome over its base and about the foe,
  // each as far about as the ground under it.
  assert.deepEqual(fog.eyes, []);
  assert.deepEqual(fog.domes, [{ x: 20000, y: 1, reach: MET_REACH }, { x: 0, y: 0, reach: 150 }]);
  assert.deepEqual(shown.domes, fog.domes, 'the foe is where it was told');
  const looking = fieldFog(new GroundSight(flat, { horizon: true }), state, id => id === 'scout' ? { x: 5010, y: 1.5 } : null);
  assert.deepEqual(looking.eyes.map(({ eye, saw }) => [eye.x, eye.y, saw.x, Boolean(saw.horizon)]), [[5011, 3.5, 5011, true]]);
  // A frame like the last costs no sweep: the same spans, the very list.
  let reads = 0; const counted = new GroundSight({ ...flat, height: () => { reads++; return 0; } }), first = fieldFog(counted, state), swept = reads;
  assert(swept > 200); assert.deepEqual(fieldFog(counted, state).seen, first.seen); assert.equal(reads, swept);
  // Another told in flight puts the ground about it in sight only while it is near that ground: high up, the air about it
  // alone. The ghost of one high up stands on no ground known either.
  const flying = (y, ghost = false) => fieldFog(new GroundSight(flat), { ...state, actors: [...state.actors,
    { id: 'drone', team: 'theirs', x: 40000, ...ghost ? { ghost: { since: 3 } } : {}, vehicle: { x: 40000, y, flying: true } }] });
  assert.deepEqual(flying(10).seen.at(-1), [39984, 40016]); assert.deepEqual(flying(10).domes[1], { x: 40000, y: 10, reach: MET_REACH });
  assert.deepEqual(flying(800).seen, fog.seen); assert.deepEqual(flying(800).domes[1], { x: 40000, y: 800, reach: MET_REACH });
  assert.deepEqual(flying(800, true).explored, fog.explored); assert.deepEqual(flying(10, true).explored.at(-1), [39984, 40016]);
});

// What a faction sees over a view, from the fog of a frame.
const look = (camera, fog, ground) => new ViewSight().frame(camera, fog, ground);
// The corners of every quad of a batch, in the world, and where each is taken from the texture.
const corners = quads => Array.from({ length: quads.count * 4 }, (_, i) => ({ x: quads.positions[i * 2] + quads.x, y: quads.positions[i * 2 + 1] + quads.y,
  own: Math.max(Math.abs(quads.positions[i * 2]), Math.abs(quads.positions[i * 2 + 1])), u: quads.uvs[i * 2], v: quads.uvs[i * 2 + 1] }));

test('the mist of a field is made once, on its first frame with fog, and a frame after that only writes numbers', t => {
  const mist = new GroundMist(), camera = { x: 100000.25, y: 300, zoom: 4, width: 1280, height: 720 }, tones = mistTones('clear'), flat = { height: () => 296 },
    never = { explored: [], seen: [] };
  t.after(() => mist.destroy());
  // The lab, the bench, a field told whole: nothing is made and nothing is drawn.
  mist.update(camera, null, 5);
  assert.deepEqual([mist.root.visible, mist.root.children.length, mist.tones, mist.shape, mist.wisps.length, mist.bands], [false, 0, undefined, undefined, 0, null]);
  // Ground never seen all over the screen, and nothing in sight: the haze over all of it, and the bank over the ground
  // and two pixels more each way, counted from the camera.
  mist.update(camera, never, 5, 'clear', flat, look(camera, never, flat));
  assert.equal(mist.root.visible, true);
  assert.deepEqual(mist.root.children.map(child => child.constructor), [Sprite, Mesh, ...Array(9).fill(Mesh)]);
  assert.deepEqual(mist.root.children.slice(0, 2), [mist.veil, mist.mist.mesh], 'the haze under the bank, the wisps over both');
  assert.deepEqual([mist.veil.visible, mist.mist.mesh.visible], [true, true]);
  assert.deepEqual([mist.veil.alpha, mist.mist.mesh.alpha, mist.mist.mesh.tint, mist.veil.tint], [VEIL_STRENGTH, 1, tones.bank, tones.veil]);
  // The haze is a shade: every part of its tone is under half that of the bank.
  assert([16, 8, 0].every(shift => (tones.veil >> shift & 255) < (tones.bank >> shift & 255) / 2), 'the haze dims what it covers');
  assert.deepEqual([mist.mist.mesh.x, mist.mist.mesh.y], [camera.x, camera.y]);
  // By stretches of four metres at this zoom (twelve pixels would be three, and the outline of the ground has a point
  // every four), on the lines of the ground: a foot, a body and a top to each.
  assert.deepEqual([STRIDE, STEP, SWELL, MIST_PIXELS], [12, 4, .3, [12, 44]]);
  const floor = view => view.y - (view.height / 2 + 4) / view.zoom;
  const stretches = quads => { const all = corners(quads); return Array.from({ length: quads.count / 3 }, (_, i) => ({ foot: all.slice(i * 12, i * 12 + 4), body: all.slice(i * 12 + 4, i * 12 + 8), top: all.slice(i * 12 + 8, i * 12 + 12) })); };
  for (const [kind, quads] of [['bank', mist.mist]]) {
    const laid = stretches(quads);
    assert.equal(laid.length, 82, kind);
    assert.deepEqual([laid[0].foot[0].x - camera.x, laid[1].foot[0].x, laid.at(-1).foot[2].x - camera.x], [-160.5, 99840, 160.5]);
    assert(corners(quads).every(p => p.own < 260), 'a float holds them to a fraction of a millimetre, a hundred kilometres out');
    assert(corners(quads).every(p => p.u === Math.fround(63.5 / 64)), 'whole all along');
    for (const [i, { foot, body, top }] of laid.entries()) {
      if (i) assert.equal(foot[0].x, laid[i - 1].foot[2].x); assert(foot[2].x - foot[0].x > 0 && foot[2].x - foot[0].x <= 4);
      // It has no foot to be seen: it goes down through the earth to four pixels under the view, with two more of foot.
      const under = floor(camera);
      assert.deepEqual(foot.map(p => p.y), [under - .5, under, under - .5, under]); assert.deepEqual([body[0].y, body[2].y], [under, under]); assert.equal(under, 209);
      assert.deepEqual([top[0].y, top[2].y, top[0].x, top[2].x], [body[1].y, body[3].y, body[0].x, body[2].x]);
      assert(foot[0].v < foot[1].v && body.every(p => p.v === foot[1].v) && top[0].v === foot[1].v && top[1].v === foot[0].v, 'nothing at the foot of the foot and at the top of the top');
      // The bank, this far from any ground that is known, has all of its height, more or less three tenths as it
      // swells: forty metres and eighty.
      const whole = body[1].y - 296, fade = top[1].y - body[1].y;
      assert(whole >= 40 * .7 - 1e-4 && whole <= 40 * 1.3 + 1e-4 && close(fade, whole * 2, 1e-3), `${whole} m whole and ${fade} m more`);
    }
  }
  const crest = stretches(mist.mist).map(stretch => stretch.body[1].y);
  assert(Math.max(...crest) - Math.min(...crest) > 3, 'the top of the bank is no line');
  // Over ground nobody saw the bank does not draw the relief. On hills forty metres from foot to top, a couple of hundred
  // metres from one to the next, its foot is under the view and its top over the highest ground about: the line of
  // the ground is inside it everywhere, and neither edge of it follows that line.
  assert.equal(MIST_SPAN, 120);
  const hills = { height: x => 296 + 20 * Math.sin(x / 30) }, wide = { ...camera, zoom: 1 };
  mist.update(wide, never, 5, 'clear', hills);
  const covered = stretches(mist.mist), feet = covered.map(({ body }) => body[0].y), tops = covered.map(({ body }) => body[1].y);
  assert(covered.length > 100 && feet.every(foot => foot === floor(wide)) && floor(wide) === -64, 'its foot is under the view, and level: ' + [Math.min(...feet), Math.max(...feet)]);
  assert(Math.min(...tops) >= 316 - 1.5 + MIST_HEIGHT * (1 - SWELL) - 1e-3, 'its top is over the highest ground: ' + Math.min(...tops));
  for (const { foot, body } of covered) assert(close(body[0].y - foot[0].y, 2, 1e-3) && body[1].y > hills.height(body[0].x) + MIST_HEIGHT * (1 - SWELL) - 1e-3);
  // A mark of the page on such ground stands in the bank, on the highest ground about: it goes along all but level
  // over hills that rise and fall forty metres, and tells nothing of where they do.
  const marks = Array.from({ length: 200 }, (_, i) => camera.x - 300 + i * 3).map(x => hills.height(x) + mist.lift(x));
  assert(Math.min(...marks) >= 316 - 1.5 && Math.max(...marks) <= 316 + 1e-9, 'a mark stands on the highest ground about: ' + [Math.min(...marks), Math.max(...marks)]);
  // Where the bank begins there is nothing of it, over the ground or under it, and it comes on along the ground — over
  // a hundred and ninety metres at this zoom — with its top low on the ground it comes from: it has no edge down the earth.
  mist.update(wide, { explored: [[0, camera.x]], seen: [[0, camera.x]] }, 5, 'clear', hills);
  const edge = stretches(mist.mist), rise = edge.map(({ body }) => body[1].y - hills.height(body[1].x));
  assert(edge.every(({ body }) => body[0].y === floor(wide)), 'under the view from its very edge');
  assert(close(edge[0].body[0].x, camera.x, 1e-6) && edge[0].body[0].u === Math.fround(.5 / 64) && edge.find(({ body }) => body[0].x - camera.x >= mistEdge(1)).body[0].u === Math.fround(63.5 / 64));
  for (const [i, { body }] of edge.entries()) if (i) assert(body[0].u >= edge[i - 1].body[0].u, 'it only closes, away from the ground that is known');
  assert(rise[0] < MIST_HEIGHT * EDGE_RISE * (1 + SWELL) + 1e-3 && Math.max(...rise) > MIST_HEIGHT * (1 - SWELL), 'low at its edge, high within: ' + [rise[0], Math.max(...rise)]);
  // On ground that is known a mark stands on the ground itself, and leaves it as the bank closes.
  assert.deepEqual([mist.lift(camera.x - 500), mist.lift(camera.x - 1), mist.lift(camera.x)], [0, 0, 0]);
  assert(mist.lift(camera.x + 20) < mist.lift(camera.x + mistEdge(1) + 40) || hills.height(camera.x + mistEdge(1) + 40) > 315);
  assert(close(hills.height(camera.x + 400) + mist.lift(camera.x + 400), 316, 1.5));
  mist.update(camera, null, 5); assert.equal(mist.lift(camera.x + 400), 0, 'no fog, no bank to stand in');
  // The known ground nearest to a place: the place itself on it, an end of a stretch off it, and the place where nothing is known.
  assert.deepEqual([[10, 20], [40, 60]].flatMap((_, i, known) => i ? [] : [5, 10, 15, 29, 31, 60, 75].map(x => nearestKnown(known, x))), [10, 10, 15, 20, 40, 60, 60]);
  assert.equal(nearestKnown([], 33), 33);
  mist.update(camera, never, 5, 'clear', flat);
  // From afar a bank of some metres would be thinner than a pixel: it keeps a height on the screen, and lies still.
  const apex = { ...camera, zoom: .01 }; mist.update(apex, never, 5, 'clear', flat);
  for (const [quads, [least, more]] of [[mist.mist, MIST_PIXELS]]) for (const { body, top } of stretches(quads))
    assert(close((body[1].y - 296) * apex.zoom, least, 1e-2) && close((top[1].y - body[1].y) * apex.zoom, more, 1e-2));
  mist.update(camera, never, 5, 'clear', flat);
  // The bank has one small texture and the wisps another: white, the tone of the weather given as they are drawn.
  assert.equal(mist.mist.mesh.texture, mist.tones); assert(mist.wisps.every(wisp => wisp.mesh.texture === mist.shape));
  // The wisps are drawn by the one shader that grains them, from that texture, on one quad of its size about its middle.
  assert(mist.wisps.every(wisp => wisp.mesh.shader === mist.wispShader && wisp.mesh.geometry === mist.wispQuad));
  assert.equal(mist.wispShader.resources.uTexture, mist.shape.source);
  assert.deepEqual([...mist.wispQuad.positions], [-64, -32, 64, -32, 64, 32, -64, 32]);
  assert.deepEqual([mist.tones, mist.shape].map(texture => [texture.source.width, texture.source.height]), [[64, 32], [128, 64]]);
  const ramp = mist.tones.source.resource, shape = mist.shape.source.resource, by = (row, column) => ramp[(row * 64 + column) * 4 + 3];
  // Across, from nothing to whole in its last row, by the ground, by steps no eye tells apart; and nothing at all in its first, above it.
  assert.deepEqual([by(31, 0), by(31, 63), by(0, 63), ramp[0], ramp[31 * 64 * 4]], [0, 255, 0, 255, 255]);
  for (let column = 1; column < 64; column++) assert(by(31, column) >= by(31, column - 1) && by(31, column) - by(31, column - 1) <= 7 && by(0, column) === 0);
  for (let row = 1; row < 32; row++) assert(by(row, 63) >= by(row - 1, 63) && by(row, 63) - by(row - 1, 63) <= 13);
  // A wisp is soft: gone to nothing at every edge of its texture, and never whole.
  const alpha = (column, row) => shape[(row * 128 + column) * 4 + 3];
  for (let i = 0; i < 128; i++) assert.equal(alpha(i, 0) + alpha(i, 63) + alpha(0, i >> 1) + alpha(127, i >> 1), 0);
  assert(Math.max(...Array.from({ length: 128 * 64 }, (_, i) => shape[i * 4 + 3])) > 120);
  // In the bank the wisps show: long soft shapes, each faint and paler than it, about its top and in its body.
  const visible = () => mist.wisps.filter(wisp => wisp.mesh.visible);
  assert(visible().length >= 3, `${visible().length} wisps on the screen`);
  for (const { mesh, strength } of visible()) {
    assert(mesh.alpha === strength && strength >= .08 && strength <= .17); assert.equal(mesh.tint, tones.wisp);
    const long = Math.abs(mesh.scale.x) * 128 * camera.zoom, tall = mesh.scale.y * 64 * camera.zoom;
    assert(long >= 490 && long <= 1100 && tall >= 130 && tall <= 300, `${long} by ${tall} pixels`);
    assert(mesh.y >= 296 + 40 * .25 - 4 && mesh.y <= 296 + 40 * 1.25 + 4, `a wisp ${mesh.y - 296} m over the ground`);
  }
  // Where the bank is not deep on the screen a wisp is no taller than six tenths of it.
  const far = { ...camera, zoom: 1 }; mist.update(far, never, 5, 'clear', flat);
  assert(visible().length >= 3); for (const { mesh } of visible()) assert(close(mesh.scale.y * 64, 72, 1e-6) && Math.abs(mesh.scale.x) * 128 <= 1100 * 72 / 130);
  // Where they are follows from the time of the field and the camera: the same frame again is the same picture, and they drift with time.
  const places = () => mist.wisps.map(wisp => [wisp.mesh.visible, wisp.mesh.x, wisp.mesh.y]);
  mist.update(camera, never, 5, 'clear', flat); const then = places();
  mist.update(camera, never, 5, 'clear', flat); assert.deepEqual(places(), then);
  mist.update(camera, never, 6, 'clear', flat);
  const drift = mist.wisps.map((wisp, i) => (wisp.mesh.x - then[i][1]) * camera.zoom).filter(step => Math.abs(step) < 100);
  assert(drift.length >= 7 && drift.every(step => step >= 5 - 1e-6 && step <= 16 + 1e-6), `a second carries them ${drift.map(step => step.toFixed(1))} pixels`);
  // All surface and air in sight: the bank clears, while underground shading remains.
  const sighted = { explored: [], seen: [[0, 200000]], eyes: [], domes: [{ x: camera.x, y: 296, reach: 1e5 }] };
  const sight = look(camera, sighted, flat);
  mist.update(camera, sighted, 5, 'clear', flat, sight);
  assert.deepEqual([mist.veil.visible, mist.mist.mesh.visible, visible().length], [true, false, 0]);
  for (let row = 0; row < sight.rows; row++) {
    const y = (sight.bottom + row + .5) * sight.cell, cover = mist.shade.previous[row * sight.columns];
    if (y >= flat.height()) assert.equal(cover, 0, 'visible air stays clear');
    if (y < flat.height() - 100) assert(cover > 0, 'deep underground retains its visual veil');
  }
  // Known to a hundred metres past the middle of the screen: the bank past the end of what is known, coming on from nothing.
  mist.update(camera, { explored: [[0, camera.x + 100]], seen: [[0, camera.x - 100]] }, 5, 'clear', flat);
  const bank = stretches(mist.mist);
  assert.deepEqual([bank[0].foot[0].x - camera.x, bank.at(-1).foot[2].x - camera.x], [100, 160.5]);
  assert.deepEqual([bank[0].foot[0].u, bank.at(-1).foot[2].u], [.5 / 64, 63.5 / 64].map(Math.fround), 'coming on from nothing');
  // Where it comes on the bank is low as well as thin: a fifth of its height.
  assert(bank[0].body[1].y - 296 <= 40 * EDGE_RISE * 1.3 + 1e-4 && bank.at(-1).body[3].y - 296 <= 40 * riseLevel(60.5 / MIST_DEEP) * 1.3 + 1e-4, 'the bank is low at its edge');
  // Wisps belong to the bank: over many moments none shows with its body over ground that is known.
  let shown = 0, hidden = 0;
  for (let time = 0; time < 600; time++) {
    mist.update(camera, { explored: [[0, camera.x]], seen: [[0, camera.x]] }, time, 'clear', flat);
    for (const { mesh, strength } of mist.wisps) {
      if (!mesh.visible) { hidden++; continue; }
      shown++; assert(mesh.x > camera.x + 50 && mesh.alpha <= strength, `a wisp at ${mesh.x - camera.x} m`);
    }
  }
  assert(shown > 40 && hidden > 200, `${shown} shown, ${hidden} not`);
  // Under another sky the mist is of that sky.
  mist.update(camera, never, 5, 'haze', flat);
  assert.equal(mist.mist.mesh.tint, mistTones('haze').bank); assert.notEqual(mistTones('haze').bank, tones.bank);
  // Frames come and go: the same three textures while the screen keeps its size, the same eleven objects, the same buffers.
  mist.update(camera, never, 5, 'clear', flat, look(camera, never, flat));
  const made = [mist.tones, mist.shape, mist.shade.texture, ...mist.root.children], buffers = [mist.mist.positions, ramp, shape, mist.shade.data];
  for (let i = 0; i < 400; i++) {
    const x = camera.x + i * 3.1, known = [[x - 900, x - 40 + 30 * Math.sin(i / 9)], [x + 60, x + 90]], view = { ...camera, x, zoom: 2 + i % 7 },
      fog = { explored: [[x - 2000, x + 400]], seen: known };
    mist.update(view, fog, i / 60, i % 2 ? 'mist' : 'clear', flat, look(view, fog, flat));
  }
  assert.deepEqual([mist.tones, mist.shape, mist.shade.texture, ...mist.root.children], made);
  assert.deepEqual([mist.mist.positions, mist.tones.source.resource, mist.shape.source.resource, mist.shade.data].map((buffer, i) => buffer === buffers[i]), [true, true, true, true]);
  // Off the field again: the layer is not shown.
  mist.update(camera, null); assert.equal(mist.root.visible, false);
});

test('the haze is over all the faction does not see — the ground, the earth under it and the air over it — and comes on softly where its sight ends', t => {
  // Level ground, a hill 20 m high with its top at 200 m, and an eye at 0, 3 m up, that sees 600 m to its right.
  const corners = [[-1000, 0], [100, 0], [200, 20], [300, 0], [3000, 0]],
    hill = { minX: -1000, maxX: 3000, height: x => { for (let i = 1; i < corners.length; i++) if (x <= corners[i][0]) { const [[ax, ay], [bx, by]] = [corners[i - 1], corners[i]]; return ay + (by - ay) * (x - ax) / (bx - ax); } return 0; } },
    state = { faction: { id: 'mine', explored: [[-1000, 3000]] }, actors: [{ id: 'scout', team: 'mine', x: 0, vehicle: { x: 0, y: 1 }, eyes: [{ x: 0, y: 3, left: 0, right: 600 }] }] },
    fog = fieldFog(new GroundSight(hill, { horizon: true }), state), camera = { x: 300, y: 30, zoom: 4, width: 1280, height: 720 },
    view = look(camera, fog, hill), mist = new GroundMist();
  t.after(() => mist.destroy());
  mist.look = mistTones('clear'); mist.hazeOver(view);
  const original = mist.shade.data.slice(), logical = view.cover(new Float32Array(view.columns * view.rows));
  mist.update(camera, fog, 0, 'clear', hill, view);
  const veil = mist.veil, shade = mist.shade, cell = SIGHT_CELL / camera.zoom,
    sample = (data, x, y) => data[((Math.floor(y / cell) - view.bottom) * view.columns + Math.floor(x / cell) - view.first) * 4 + 3],
    alpha = (x, y) => sample(shade.data, x, y);
  assert.deepEqual(view.cover(new Float32Array(logical.length)), logical, 'the logical sight mask is unchanged');
  assert(shade.data.every((value, i) => i % 4 !== 3 || value >= original[i]), 'no cell becomes less concealed');
  for (const [x, y] of [[150, 60], [350, 50], [450, 20]]) assert.equal(alpha(x, y), sample(original, x, y), 'air retains its existing veil');
  // A texel a cell: the sprite stands where the first cell is, a cell to a texel.
  assert.deepEqual([shade.columns, shade.rows, veil.texture, veil.visible, veil.alpha, veil.tint], [view.columns, view.rows, shade.texture, true, VEIL_STRENGTH, mistTones('clear').veil]);
  assert.deepEqual([veil.x, veil.y, veil.scale.x, veil.scale.y], [view.first * cell, view.bottom * cell, cell, cell]);
  // Clear in the air before the hill; whole over the valley behind it under the line over its top,
  // and in the earth under that; clear over that line; whole in the air still under that horizon.
  assert.deepEqual([alpha(150, 15), alpha(150, 60), alpha(350, 10), alpha(350, -20), alpha(350, 50), alpha(450, 20)], [0, 0, 255, 255, 0, 255]);
  assert.deepEqual([alpha(150, -20), alpha(350, -20)], [255, 255], 'seen and occluded soil reach the same deep veil');
  assert(view.sees(150, -20) && !view.sees(350, -20), 'visual depth does not change logical visibility');
  const below = Array.from({ length: 11 }, (_, k) => alpha(150, 14 - k * cell));
  assert(below.every((value, k) => !k || value >= below[k - 1]) && below[0] === 0 && below.at(-1) === 255 && below.some(value => value > 0 && value < 255), `smooth depth transition: ${below}`);
  // About the line over the top of the hill — 17 m up in 200 m from the eye — it comes on over a few cells, eased in and out.
  const line = x => 3 + 17 * x / 200, up = Array.from({ length: 11 }, (_, k) => alpha(400, line(400) + (k - 5) * cell));
  assert(up.every((value, k) => !k || value <= up[k - 1]) && up[0] === 255 && up[10] === 0 && up.some(value => value > 0 && value < 255), `the haze across the line at 400 m: ${up}`);
  assert.equal(VEIL_SOFT, 2);
  // The same texture while the screen keeps its cells; even all-clear sight retains only the deep visual veil.
  const texture = shade.texture, along = { ...camera, x: 330 };
  mist.update(along, fog, 0, 'clear', hill, look(along, fog, hill)); assert.equal(mist.shade.texture, texture);
  const lit = { ...fog, domes: [{ x: 300, y: 0, reach: 1e5 }] };
  mist.update(camera, lit, 0, 'clear', hill, look(camera, lit, hill));
  assert(veil.visible); assert.deepEqual([alpha(300, 20), alpha(300, -20)], [0, 255]);
  // A screen of another size has another number of cells: a texture of that size, and the old one let go.
  const wider = { ...camera, width: 1600 };
  mist.update(wider, fog, 0, 'clear', hill, look(wider, fog, hill));
  assert.notEqual(mist.shade.texture, texture); assert.equal(texture.destroyed, true); assert.equal(mist.shade.columns, Math.ceil(1600 / SIGHT_CELL) + 3);
  assert.equal(veil.texture, mist.shade.texture);
  // Told no sight, there is no haze.
  mist.update(camera, fog, 0, 'clear', hill); assert.equal(veil.visible, false);
});

test('the haze is softened over a few cells to each side of where the sight ends, eased in and out', () => {
  // Seven cells across and five up, out of sight from the fourth column on: the step comes on over five columns.
  const columns = 7, rows = 5, cover = new Float32Array(columns * rows).map((_, i) => i % columns >= 3 ? 1 : 0);
  const soft = softCover(cover, new Float32Array(columns * rows), columns, rows, 2);
  assert.equal(soft, cover, 'in the very array');
  for (let row = 0; row < rows; row++) for (const [column, share] of [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1, 1].entries())
    assert(close(soft[row * columns + column], rampLevel(share), 1e-6), `${row}, ${column}: ${soft[row * columns + column]}`);
  // A cell alone out of sight is a soft spot of a twenty-fifth of the haze over five cells each way, at the edges too.
  const spot = new Float32Array(25); spot[12] = 1; softCover(spot, new Float32Array(25), 5, 5, 2);
  assert(spot.every(value => close(value, rampLevel(1 / 25), 1e-6)));
});

test('the tones of the mist are of the sky it lies under: a blue-grey darker than the horizon and paler than the sky overhead', () => {
  const parts = tint => [tint >> 16, tint >> 8 & 255, tint & 255], light = tone => tone[0] + tone[1] + tone[2];
  assert.deepEqual(mistTones('nowhere'), mistTones('clear'));
  for (const weather of ['clear', 'haze', 'mist']) {
    const bank = parts(mistTones(weather).bank), wisp = parts(mistTones(weather).wisp), sky = skyTones(weather), overhead = [...sky.slice(0, 3)], horizon = [...sky.slice(-4, -1)];
    assert(light(bank) < light(horizon) - 60 && light(bank) > light(overhead) + 60, `${weather}: ${bank} between ${overhead} overhead and ${horizon} at the horizon`);
    assert(wisp.every((value, i) => value > bank[i]), 'the wisps are paler than the bank');
  }
});

// A renderer with nothing to draw on, and what its effects were handed.
function painter() {
  const consumed = [], g = {};
  for (const method of ['moveTo', 'lineTo', 'poly', 'fill', 'stroke']) g[method] = () => g;
  const renderer = new Renderer({}); renderer.trails = g;
  renderer.effects = { consume: events => consumed.push(...events), rocketTrail() {}, sight: null };
  return { renderer, consumed };
}

test('what happens over ground out of sight is not drawn: its blasts and smoke, and the rounds over it and their tails unless they are in the sky', t => {
  const { renderer, consumed } = painter(); Object.assign(renderer.camera, { x: 100, y: 20, zoom: 4, width: 1280, height: 720 });
  const blast = x => ({ type: 'explosion', x, y: 5, power: 240, radius: 1 }), muzzle = x => ({ type: 'muzzle', x, y: 5, weapon: 'cannon', platform: 'vehicle', componentId: 'gun' });
  // Without fog everything is made.
  for (const x of [40, 160]) { renderer.consumeEffect(blast(x)); renderer.consumeEffect(muzzle(x)); }
  assert.equal(consumed.length, 4); assert.equal(renderer.sees(160), true);
  // With it, only what is over the ground in sight; what happens nowhere in particular is as ever.
  renderer.fog = { seen: [[0, 100]], explored: [[0, 5000]] }; consumed.length = 0;
  for (const x of [40, 160]) { renderer.consumeEffect(blast(x)); renderer.consumeEffect(muzzle(x)); }
  renderer.consumeEffect({ type: 'explosion', power: 240, radius: 1 });
  assert.deepEqual(consumed.map(event => event.x), [40, 40, undefined]); assert.deepEqual([renderer.sees(40), renderer.sees(160)], [true, false]);
  // Rounds in flight: a body and its far marker, a speck of a long volley, a fragment, each on either side of the line,
  // `up` metres over the ground.
  renderer.ground = { height: () => 7 };
  const floor = renderer.ground.height(150), round = (id, x, up) => ({ id, x, y: floor + up, vx: 300, vy: 0, ammo: 'ap', radius: .01, age: 1 }), kinds = [{ ammo: 'ap' }],
    tail = (from, to, up) => ({ id: `tail-${from}`, ammo: 'ap', fade: 1, points: [from, (from + to) / 2, to].map(x => ({ x, y: floor + up, fade: 1 })) }),
    draw = (up = 5) => {
      const specks = { count: 4, x: Float32Array.of(50, 60, 150, 170), y: Float32Array.of(floor + up, floor + up, floor + up, floor + up), kind: Uint32Array.of(0, 0, 0, 0), kinds };
      renderer.drawProjectiles({ shots: [round('near', 80, up), round('far', 130, up)], specks, traces: [], shotTrails: [tail(20, 60, up), tail(90, 110, up), tail(140, 180, up)] });
      return [renderer.markers.count, renderer.specks.count, renderer.speckGlows.count, renderer.tails.count];
    };
  renderer.camera.zoom = 2; renderer.camera.y = floor + 20;
  // The faction sees by one eye 3 m over the ground at 50 m, out to 50 m each way: the ground to 100 m, but for the few
  // centimetres its circle falls short of the reach on the ground, and the air over it.
  const fogged = explored => {
    renderer.fog = fieldFog(new GroundSight({ ...renderer.ground, minX: -1e4 }, { horizon: true }), { faction: { id: 'mine', explored },
      actors: [{ id: 'scout', team: 'mine', x: 50, vehicle: { x: 50, y: floor }, eyes: [{ x: 50, y: floor + 3, left: 50, right: 50 }] }] });
    renderer.sight.frame(renderer.camera, renderer.fog, renderer.ground);
  };
  fogged([[0, 5000]]); assert.deepEqual(renderer.fog.seen, [[50 - Math.sqrt(50 ** 2 - 9), 50 + Math.sqrt(50 ** 2 - 9)]]);
  // Low over the ground, a tail is drawn up to the line: of the one that crosses it, the half on this side.
  assert.deepEqual(draw(), [1, 2, 2, 3]);
  assert(Array.from({ length: renderer.tails.count * 8 }, (_, i) => i % 2 ? 0 : renderer.tails.positions[i] + renderer.tails.x).every(x => x <= 100 + 1e-6));
  assert.equal(typeof renderer.shotView().hidden, 'function');
  // Out of sight, what flies is seen in the sky: over the low air of ground that is known, and over the bank of mist on
  // ground never seen. A shell is followed along its whole arc, and is lost as it comes down into them.
  assert.deepEqual([LOW_AIR, renderer.skyline(150) - floor, draw(11), draw(13)], [12, 12, [1, 2, 2, 3], [2, 4, 4, 6]]);
  fogged([[0, 100]]);
  assert.deepEqual([renderer.skyline(150) - floor, draw(13), draw(119), draw(121)], [120, [1, 2, 2, 3], [1, 2, 2, 3], [2, 4, 4, 6]]);
  // What the faction sees of the air goes by the sight of the frame, place by place, low or high.
  renderer.sight.sees = () => true; assert.deepEqual(draw(5), [2, 4, 4, 6]);
  renderer.sight.sees = () => false; assert.deepEqual(draw(5), [0, 0, 0, 0]); delete renderer.sight.sees;
  renderer.fog = null; assert.deepEqual(draw(), [2, 4, 4, 6]); assert.equal(renderer.shotView().hidden, null);
  // Smoke and fire that the sight leaves behind, or that drift out of it, are gone: nothing is kept of them.
  const parent = new Container(), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY), spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY },
    fx = new Effects(parent, atlas); t.after(() => { fx.clear(); parent.destroy({ children: true }); });
  assert.equal(fx.sight, null);
  for (const x of [40, 99.9, 160]) fx.add('smoke', { x, y: 5, vx: .5, vy: .2, life: 10, size: .2 });
  fx.update(.1); assert.equal(fx.particles.length, 3);
  fx.sight = [[0, 100]]; fx.update(.1); assert.deepEqual(fx.particles.map(p => Math.round(p.x)), [40, 100]);
  for (let i = 0; i < 20; i++) fx.update(.1);
  assert.deepEqual(fx.particles.map(p => Math.round(p.x)), [40], 'the one that drifted over the line went with it');
  fx.sight = null; fx.update(.1); assert.equal(fx.particles.length, 1);
});

test('the renderer lays the mist over the world and under its instruments, on a field that tells explored ground and on no other', async t => {
  await initNativeDynamics();
  const SITE = 125000, WIDTH = 1280, HEIGHT = 720, blueprint = createConstruction('recon'); blueprint.terrain = MAIN_WORLD.terrain;
  const world = new World(blueprint, { scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } }); t.after(() => world.dispose());
  world.replaceActor(world.construction, { id: 'local', ownerId: 'me', team: 'mine', x: SITE, facing: -1 });
  world.addActor(world.construction, { id: 'seen', ownerId: 'you', team: 'yours', x: SITE - 4000, facing: 1, playerName: 'Bob' });
  const view = { mode: 'test', testTool: 'fire', weapon: { platform: 'vehicle' }, aim: { x: SITE - 30, y: world.terrain.height(SITE - 30) + 5 } },
    renderer = new Renderer({ clientWidth: WIDTH, clientHeight: HEIGHT }, view), camera = renderer.camera;
  renderer.app = { stage: new Container(), renderer: { render() {}, resize() {}, backBuffer: { useBackBuffer: false } } };
  renderer.buildScene(groundSurfaces());
  let now = 0;
  const frame = (faction, at = 0, zoom = 6, shared = true) => {
    world.step();
    const state = world.snapshot();
    Object.assign(state, { shared, localPlayerId: 'me', controlledActor: 'local', faction: { flag: { field: 'plain', colours: [0, 1, 2], emblem: 'none' }, known: [], ...faction },
      players: [{ id: 'me', connected: true, factionId: 'mine' }, { id: 'you', connected: true, factionId: 'yours' }], contacts: [] });
    Object.assign(camera, { x: world.actor('local').vehicle.x + at, y: world.actor('local').vehicle.y + 6, zoom });
    renderer.receive(state, world.drainEvents(), { now }); renderer.draw({ now }); now += 1000 / 60;
    return state;
  };
  // Over the world and what goes on in it — the haze of heat is the last of that — and under the marks of the sensors, the aim and the labels.
  const order = renderer.world.children, index = node => order.indexOf(node), mist = renderer.mist;
  assert.equal(index(mist.root), index(renderer.heatHaze.host) + 1); assert.equal(index(renderer.overlay), index(mist.root) + 1);
  for (const under of [renderer.terrainLayer ?? renderer.shadows, renderer.actorLayerRoot, renderer.tails.mesh, renderer.markers.mesh, renderer.specks.mesh, renderer.fxLayer])
    assert(index(under) >= 0 && index(under) < index(mist.root), 'the world is under the mist');
  for (const over of [renderer.overlay, renderer.labels, renderer.impactLabel]) assert(index(over) > index(mist.root), 'the instruments are over it');
  // A field that tells no explored ground — one without fog — has none: nothing is made of it.
  const base = { x: SITE + 60, y: world.terrain.height(SITE + 60), radius: 100, facing: 1 };
  for (let i = 0; i < 5; i++) frame({ id: 'mine', base, explored: null });
  assert.deepEqual([renderer.fog, renderer.effects.sight, mist.root.visible, mist.root.children.length, renderer.sees(SITE - 5000)], [null, null, false, 0, true]);
  // One that does: the ground in sight is that of its own construction and its base, the mist is laid by it, and the effects go by it.
  const told = [[SITE - 2000, SITE + 2000]];
  let state; for (let i = 0; i < 5; i++) state = frame({ id: 'mine', base, explored: told });
  const fog = renderer.fog, self = world.actor('local').vehicle.x, eyes = state.actors.find(actor => actor.id === 'local').eyes;
  assert(eyes.length >= 1, 'a frame tells the eyes of a construction');
  assert(renderer.sees(self) && renderer.sees(SITE + 60 + 149) && !renderer.sees(SITE - 5000) && renderer.sees(NaN));
  const left = Math.min(base.x - base.radius - BASE_MARGIN, ...fog.eyes.map(({ eye }) => eye.x - eye.left)),
    right = Math.max(base.x + base.radius + BASE_MARGIN, ...fog.eyes.map(({ eye }) => eye.x + eye.right));
  assert(contains(fog.explored, SITE - 990) && fog.seen.every(([from, to]) => to < SITE - 3900 || from >= left - 1e-6 && to <= right + 1e-6));
  assert.equal(renderer.effects.sight, fog.seen); assert.equal(renderer.eyes.ground, renderer.ground); assert.equal(renderer.eyes.horizon, true);
  assert.deepEqual([mist.root.visible, mist.root.children.length], [true, 11]);
  // The air it sees: to the side an eye looks, high over the ground it sees, and not past the reach of that eye.
  const eye = eyes.find(eye => eye.right > 0) ?? eyes[0], side = eye.right > 0 ? 1 : -1, reach = side > 0 ? eye.right : eye.left;
  assert.deepEqual([renderer.sight.sees(eye.x + side * 20, eye.y + 30), renderer.sight.sees(eye.x + side * 20, eye.y + reach + 1)], [true, false]);
  assert.equal(mist.veil.visible, true, 'and the haze over the air past it');
  // The other construction, four kilometres off, is told as one in sight: so is the ground it stands on, and no more of it.
  const other = world.actor('seen').vehicle.x; assert.deepEqual([renderer.sees(other), renderer.sees(other - 30), renderer.sees(other + 30)], [true, false, false]);
  assert(contains(fog.explored, other) && !contains(told, other));
  // The camera goes where the faction never was: the haze over all of the screen, and the bank all along it, over the
  // ground of the renderer and the line of it, down through the earth to the foot of the view, past it by as far as
  // the view is ever shaken, and a bank's height over the ground about.
  frame({ id: 'mine', base, explored: told }, -9000);
  assert.deepEqual(mist.bands.map(band => [band.a, band.b]), [[1, 1]]);
  assert(mist.veil.visible && mist.shade.data.every((value, i) => i % 4 < 3 || value === 255), 'nothing in sight');
  assert(mist.mist.count >= 150 && mist.mist.count % 3 === 0, `${mist.mist.count} quads of the bank`);
  const about = x => { const heights = Array.from({ length: 2 * MIST_SPAN / 4 + 9 }, (_, i) => renderer.ground.height(x - MIST_SPAN - 16 + i * 4)); return [Math.min(...heights), Math.max(...heights)]; };
  for (const corner of corners(mist.mist)) {
    const over = corner.y - renderer.ground.height(corner.x), [, highest] = about(corner.x),
      foot = camera.y - (camera.height / 2 + 6 + SHAKE_LEVELS.normal) / camera.zoom;
    assert(corner.y >= Math.min(foot, renderer.ground.height(corner.x) - 2 / camera.zoom) - 1e-3 && corner.y <= highest + (MIST_HEIGHT + MIST_FADE) * (1 + SWELL) + 1e-3, `a corner ${over} m over the ground at ${corner.x}`);
  }
  // What the page marks there tells no more than the bank: a mark stands in it, over the ground, and the hills behind
  // the field are those of the nearest ground the faction knows, not of what lies under the camera.
  const far = camera.x, rises = Array.from({ length: 40 }, (_, i) => far - 200 + i * 10).map(x => renderer.markHeight(x) - renderer.ground.height(x));
  assert(rises.every(rise => rise >= 0) && rises.some(rise => rise > 0), 'marks stand in the bank over ground never seen');
  assert.equal(renderer.markHeight(far), renderer.ground.height(far) + mist.lift(far)); assert.equal(renderer.markHeight(self), renderer.ground.height(self));
  const places = [], placed = renderer.backdrop.update; renderer.backdrop.update = (...args) => { places.push(args[2]); return placed.apply(renderer.backdrop, args); };
  frame({ id: 'mine', base, explored: told }, -9000);
  assert.equal(places[0], nearestKnown(renderer.fog.explored, camera.x)); assert(contains(renderer.fog.explored, places[0]) && Math.abs(places[0] - camera.x) > 2000);
  frame({ id: 'mine', base, explored: told }); assert.equal(places[1], camera.x, 'over ground that is known, those of where the camera is');
  frame({ id: 'mine', base, explored: null }); assert.equal(places[2], camera.x, 'and on a field without fog');
  renderer.backdrop.update = placed;
  // Back by its own construction, from afar, with the end of what it has seen in the view: clear about it, and the
  // bank to the right of the two kilometres the field told, coming on over as much ground as a soft edge takes at that zoom.
  // The longer optical reach sees small islands to the left; their shorter gaps correctly have a lower bank.
  frame({ id: 'mine', base, explored: told }, 1500, .4);
  const bank = mist.bands;
  assert.equal(level(bank, self), 0); assert(renderer.sight.sees(self, renderer.ground.height(self) + 1));
  const edge = renderer.fog.explored.find(([from, to]) => from <= self && to >= self)[1], soft = mistEdge(.4);
  assert.equal(soft, 475); assert.equal(level(bank, edge + soft + 20), 1); assert.equal(level(bank, edge - 50), 0); assert(close(level(bank, edge + soft / 2), .5, 1e-6));
  // A state that is not of the shared field — that of the lab — has no mist, whatever it carries; nor has the workshop of the lab.
  frame({ id: 'mine', base, explored: told }, 0, 6, false);
  assert.deepEqual([renderer.fog, renderer.effects.sight, mist.root.visible], [null, null, false]);
  frame({ id: 'mine', base, explored: told }); assert.equal(mist.root.visible, true);
  view.mode = 'edit'; assert.equal(renderer.groundFog({ state }), null);
});

// The grain of the wisps, as their shader works it out for a pixel (WISP_FRAGMENT): interleaved gradient noise.
const grain = (x, y) => { const f = v => v - Math.floor(v); return f(52.9829189 * f(x * .06711056 + y * .00583715)) - .5; };
test('a wisp is grained by less than a step of the screen, the same at each pixel on every frame, so its soft edge has no rings', () => {
  // The shader adds the grain to the colour it draws before the screen rounds it, in steps of the eight bits of the
  // screen, and only where the wisp is.
  assert.match(WISP_FRAGMENT, /gl_FragCoord\.xy/); assert.match(WISP_FRAGMENT, /grain \/ 255\.0 \* min\(1\.0, colour\.a \* 255\.0\)/);
  assert.match(WISP_FRAGMENT, /fract\(52\.9829189 \* fract\(dot\(gl_FragCoord\.xy, vec2\(0\.06711056, 0\.00583715\)\)\)\) - 0\.5/);
  // Half a step either way, spread evenly: a wisp's tone between two steps of the screen comes out as a share of each,
  // and the mean of a patch is its tone.
  const values = []; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) values.push(grain(x + .5, y + .5));
  assert(values.every(v => v >= -.5 && v < .5));
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length; assert(Math.abs(mean) < .01, `mean ${mean}`);
  const bins = Array(8).fill(0); for (const v of values) bins[Math.floor((v + .5) * 8)]++;
  assert(bins.every(count => Math.abs(count - values.length / 8) < values.length / 8 * .15), `bins ${bins}`);
  // A gradient a few steps deep over hundreds of pixels, as a wisp is over the bank. Drawn plainly, the screen rounds
  // it into bands tens of pixels wide, each off its tone by up to half a step where it meets the next: the rings.
  // Grained, every patch of a few pixels comes out at its own tone, and no band is left to see.
  const worst = draw => {
    let most = 0;
    for (let left = 0; left + 8 <= 300; left += 4) {
      let drawn = 0, meant = 0;
      for (let y = 0; y < 8; y++) for (let x = left; x < left + 8; x++) { const tone = 150 + 6 * x / 300; drawn += draw(tone, x + .5, y + .5); meant += tone; }
      most = Math.max(most, Math.abs(drawn - meant) / 64);
    }
    return most;
  };
  const plain = worst(tone => Math.round(tone)), grained = worst((tone, x, y) => Math.round(tone + grain(x, y)));
  assert(plain > .4 && grained < .12, `patches off their tone by ${plain.toFixed(3)} and ${grained.toFixed(3)} of a step`);
});
