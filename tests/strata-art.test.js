import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, TERRAIN_PROFILES, BIOME_IDS, WORLD_BLEND } from '../src/terrain.ts';
import { laboratoryCourse } from './helpers/laboratory-course.js';
import { Graphics } from 'pixi.js';
import { earthFloor, groundView, drawGroundSurface } from '../src/terrain-art.ts';
import { surfaceGeometry } from '../src/terrain-surface.ts';
import { anchorGraphics } from '../src/world-anchor.ts';
import { simplifyGround, outlineError } from '../src/terrain-lod.ts';
import { BED_TOPS, STRATA_LAP, GRAIN_PERIODS, GroundRelief, strataPlan, strataTones, strataTexture, bedLines, buildStrata, buildSoilGrain,
  groundBandDepth } from '../src/strata-art.ts';

const BEDS = BED_TOPS.length, ROWS = 128;
const ground = id => id === 'laboratory' ? laboratoryCourse() : new Terrain(id, TERRAIN_PROFILES[id].battle ? { seed: 6173, length: id === 'world' ? 16000 : 2000 } : {});
// The strips of a stretch of strata, in the order they are laid: the beds from the deepest up.
// Each is its columns from left to right, a corner at the top and one at the foot.
function strips(mesh) {
  const out = [];
  for (let i = 0; i < mesh.bedVertices * 2; i += 4) {
    if (mesh.positions[i] === 0) out.push([]);
    out.at(-1).push({ x: mesh.positions[i], top: mesh.positions[i + 1], foot: mesh.positions[i + 3], u: mesh.tones[i], v: [mesh.tones[i + 1], mesh.tones[i + 3]],
    });
    assert.equal(mesh.positions[i + 2], mesh.positions[i], 'the two corners of a column stand one over the other');
  }
  return out;
}
const bedStrip = (mesh, bed) => strips(mesh)[BEDS - 1 - bed];
// The top of a strip at a place along its stretch, on the straight run between its columns.
function along(strip, x) {
  const i = strip.findIndex(column => column.x >= x), b = strip[i], a = strip[Math.max(0, i - 1)];
  return b.x === x || a === b ? b.top : a.top + (b.top - a.top) * (x - a.x) / (b.x - a.x);
}

test('the relief the beds read is the ground itself, averaged without walking it', () => {
  for (const id of ['highlands', 'mixed', 'world']) {
    const terrain = ground(id), relief = new GroundRelief(terrain), first = terrain.points[0], last = terrain.points.at(-1);
    for (const x of [first.x - 500, first.x, terrain.minX + .3, 12, 12.5, 311.7, terrain.maxX - .3, last.x, last.x + 500]) {
      const here = x <= first.x ? first.y : x >= last.x ? last.y : terrain.height(x);
      assert(Math.abs(relief.at(x) - here) < 1e-9, `height at ${x}`);
      assert.equal(relief.mean(x, 0), relief.at(x));
      for (const half of [3, 40, 700]) {
        let sum = 0; const steps = 4000;
        for (let i = 0; i < steps; i++) sum += relief.at(x - half + (i + .5) * 2 * half / steps);
        assert(Math.abs(relief.mean(x, half) - sum / steps) < .02, `mean over ${half} m at ${x}`);
        assert(relief.low(x, half) <= relief.at(x) + 1e-9);
        assert(relief.low(x, half) <= relief.mean(x, half) + 1e-9);
      }
    }
  }
});

for (const id of [...BIOME_IDS, 'world', 'flat', 'mixed', 'rough']) test(`${id}: the beds lie under the ground in order, thicker with depth, down to the foot of the earth`, () => {
  const terrain = ground(id), plan = strataPlan(terrain), floor = earthFloor(terrain), before = terrain.snapshot(),
    left = terrain.points[0].x, right = terrain.points.at(-1).x, steepest = new Array(BEDS).fill(0);
  let previous = null;
  for (let x = left; x <= right; x += 8) {
    const lines = Array.from(bedLines(plan, x, floor));
    assert.equal(lines.length, BEDS + 1); assert(lines.every(Number.isFinite));
    // The first two metres of ground are painted over the strata: the top bed starts inside them.
    const under = terrain.height(x) - lines[0];
    assert(under >= .35 - 1e-9 && under < 2, `the top bed lies ${under} m under the ground at ${x}`);
    for (let bed = 0; bed < BEDS; bed++) {
      const nominal = (BED_TOPS[bed + 1] ?? 4000) - BED_TOPS[bed];
      assert(lines[bed] - lines[bed + 1] >= .08 * nominal, `bed ${bed} is squeezed to nothing at ${x}`);
      if (previous) steepest[bed] = Math.max(steepest[bed], Math.abs(lines[bed] - previous[bed]) / 8);
    }
    assert(lines[BEDS] <= groundView(terrain).minY, 'the earth is drawn as far down as a view may go');
    // A bed asked for alone is the same bed.
    const few = bedLines(plan, x, floor, new Float64Array(BEDS + 1), 3);
    assert.deepEqual(Array.from(few.slice(0, 4)), lines.slice(0, 4));
    previous = lines;
  }
  // The deeper a bed, the less of the relief above shows in it: the rock under every biome lies almost level.
  for (let bed = 5; bed < BEDS; bed++) assert(steepest[bed] < .15, `bed ${bed} turns by ${steepest[bed]}`);
  if (['highlands', 'plateau', 'world'].includes(id)) assert(steepest[7] < steepest[1] / 4);
  assert.deepEqual(Array.from(bedLines(plan, 12, floor)), Array.from(bedLines(strataPlan(ground(id)), 12, floor)), 'the same map has the same earth');
  assert.deepEqual(terrain.snapshot(), before, 'reading the ground for its strata leaves it as it was');
});

test('a stretch of strata is a small mesh, measured from its own corner, that leaves no gap', () => {
  for (const id of ['highlands', 'world', 'flat']) {
    const terrain = ground(id), plan = strataPlan(terrain), floor = earthFloor(terrain), left = terrain.minX + 256, right = left + 512,
      mesh = buildStrata(plan, left, right, floor), parts = strips(mesh), lines = new Float64Array(BEDS + 1);
    assert.deepEqual([mesh.x, mesh.y], [left, 0]);
    assert(mesh.bedVertices <= 1800 && mesh.bedIndices <= 5400, 'half a kilometre of beds stays under two thousand corners');
    assert(mesh.positions.length / 2 < 12000 && mesh.clasts < 1600, 'native clasts have a bounded preparation budget');
    assert.equal(mesh.tones.length, mesh.positions.length);
    assert(mesh.positions.every(Number.isFinite) && mesh.tones.every(Number.isFinite));
    assert(Math.max(...mesh.indices) < mesh.positions.length / 2);
    for (const [kind, material] of [...Object.entries(mesh.grain), ['rock', mesh.clastGrain]]) {
      assert.equal(material.positions.length, material.uvs.length);
      assert(material.positions.every(Number.isFinite) && material.uvs.every(Number.isFinite));
      assert(Math.max(...material.indices) < material.positions.length / 2);
      for (let i = 0; i < material.positions.length; i += 2) {
        assert(material.positions[i] >= 0 && material.positions[i] <= right - left, 'the grain leaves the horizontal lap unpainted');
        assert(Math.abs(Math.hypot(material.uvs[i] - material.uvs[0], material.uvs[i + 1] - material.uvs[1]) * GRAIN_PERIODS[kind] -
          Math.hypot(material.positions[i] - material.positions[0], material.positions[i + 1] - material.positions[1])) < .004, 'rotation keeps the material scale');
      }
    }
    assert.equal(parts.length, BEDS, 'the beds alone, with nothing of another tone behind them');
    for (const [k, part] of parts.entries()) {
      // Every strip runs from the left end to the right, and one lap past it under the next stretch.
      assert.equal(part[0].x, 0); assert.equal(part.at(-2).x, right - left);
      assert(Math.abs(part.at(-1).x - (right - left + STRATA_LAP)) < 1e-4);
      for (const [i, column] of part.entries()) {
        assert(column.foot < column.top, 'a column has height');
        if (i) assert(column.x > part[i - 1].x);
        const bed = BEDS - 1 - k, x = left + column.x; bedLines(plan, x, floor, lines);
        // The top bed follows the ground to within a tenth of a metre, the others their lines.
        assert(Math.abs(column.top - lines[bed]) < (bed ? .01 : .11), `bed ${bed} starts where its line is`);
        // It reaches a little under the top of the next, which is laid over it. The columns of the next are
        // among its own, so it does so all along the straight runs between them.
        if (bed < BEDS - 1) assert(column.foot < along(parts[k - 1], column.x) - .1, `bed ${bed} reaches under the next at ${x}`);
        else assert(column.foot <= floor + .01);
        assert(column.u >= .5 / plan.width - 1e-6 && column.u <= 1 - .5 / plan.width + 1e-6);
        assert(Math.abs(column.v[0] - (bed * ROWS + .5) / plan.height) < 1e-6 && Math.abs(column.v[1] - ((bed + 1) * ROWS - .5) / plan.height) < 1e-6);
      }
    }
    // The grain is laid over the beds alone, and not over the lap, where it would be laid twice.
    const quads = BEDS + parts.reduce((sum, part) => sum + part.length - 2, 0);
    assert.equal(mesh.bedIndices, quads * 6);
    assert.deepEqual(buildStrata(strataPlan(ground(id)), left, right, floor), mesh, 'the same stretch is the same mesh');
  }
});

test('two stretches meet in every bed at the same height and tone', () => {
  const terrain = ground('world'), plan = strataPlan(terrain), floor = earthFloor(terrain);
  for (const [a, b, c] of [[-1024, -512, 0], [terrain.biomes[1].start - 400, terrain.biomes[1].start, terrain.biomes[1].start + 380]]) {
    const one = buildStrata(plan, a, b, floor), other = buildStrata(plan, b, c, floor);
    for (let bed = 0; bed < BEDS; bed++) {
      const end = bedStrip(one, bed).at(-2), start = bedStrip(other, bed)[0];
      assert(Math.abs(end.top - start.top) < 1e-3 && Math.abs(end.foot - start.foot) < 1e-3, `bed ${bed} steps at ${b}`);
      assert(Math.abs(end.u - start.u) < 1e-6); assert.deepEqual(end.v, start.v);
    }
  }
});

test('irregular distant strips retain the exact bed heights and biome coordinates without resampling shared columns', () => {
  const terrain = new Terrain('world', { seed: 6173, length: 512000 }), plan = strataPlan(terrain), floor = earthFloor(terrain),
    border = terrain.biomes[5].start, materialAt = terrain.materialAt,
    bytes = array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (const [left, width] of [[125000, 497.3], [border - 1945.85, 3891.7], [border, 512]]) for (const step of [0, 8, 32]) {
    const right = left + width; let samples = 0, mesh;
    terrain.materialAt = function (x) { samples++; return materialAt.call(this, x); };
    try { mesh = buildStrata(plan, left, right, floor, step); }
    finally { terrain.materialAt = materialAt; }
    const bare = buildStrata(plan, left, right, floor, step, false);
    for (const field of ['positions', 'tones', 'indices'])
      assert.deepEqual(bytes(bare[field]), bytes(mesh[field]), `${field} stays byte-identical without grain at step ${step}`);
    for (const field of ['x', 'y', 'bedVertices', 'bedIndices', 'clasts']) assert.equal(bare[field], mesh[field]);
    assert.equal(bare.grain, null); assert.equal(bare.clastGrain, null);
    assert(mesh.grain && mesh.clastGrain, 'the default still includes both material finishes');
    if (step === 32 && width === 3891.7)
      assert(samples < 1500, 'distant layers share their ground samples instead of repeating thousands of reads');
    for (const [k, part] of strips(mesh).entries()) {
      const bed = BEDS - 1 - k, count = part.length - 2, thick = (BED_TOPS[bed + 1] ?? Infinity) - BED_TOPS[bed], spacing = Math.max([2, 2, 4, 8, 16, 32, 64, 128, 256][bed], step);
      for (const [i, column] of part.entries()) {
        const near = left + column.x, grid = i > count ? right + STRATA_LAP : i === count ? right : i === 0 ? left : Math.round(near / spacing) * spacing,
          // The top bed has a column at each corner the outline drawn at that step keeps, besides those of the grid.
          corner = !bed && Math.abs(grid - near) > .01,
          x = corner ? terrain.minX + Math.round((near - terrain.minX) / terrain.spacing) * terrain.spacing : grid, expected = bedLines(plan, x, floor);
        if (i > 0 && i < count && !corner) assert(Math.abs((x / spacing) - Math.round(x / spacing)) < 1e-9, 'interior columns use the same world grid in every chunk');
        assert.equal(column.u, Math.fround((plan.coordinate(x) + .5) / plan.width));
        if (bed) {
          assert.equal(column.top, Math.fround(expected[bed]), `bed ${bed} at ${x}, step ${step}`);
          assert.equal(column.foot, Math.fround(bed === BEDS - 1 ? expected[BEDS] : expected[bed + 1] - .15 * thick));
          continue;
        }
        // The top bed hangs under the outline drawn at that step, and meets the next on the straight runs between its columns.
        assert(Math.abs(column.top - expected[0]) <= Math.max(step / 16, .1) + 1e-3, `bed 0 at ${x}, step ${step}`);
        if (!corner) assert.equal(column.foot, Math.fround(expected[1] - .15 * thick));
        else {
          const a = Math.max(left, Math.floor(x / spacing) * spacing), b = Math.min(right, Math.ceil(x / spacing) * spacing);
          assert(Math.abs(column.foot - (bedLines(plan, a, floor)[1] + (bedLines(plan, b, floor)[1] - bedLines(plan, a, floor)[1]) * (x - a) / (b - a) - .15 * thick)) < 1e-3);
        }
      }
    }
  }
});

test('tones are a column for each region over one rock that all of them share', () => {
  const world = ground('world'), plan = strataPlan(world), tones = strataTones(plan), at = (column, bed, row) => {
    const i = ((bed * ROWS + row) * plan.width + column) * 4; return [tones[i], tones[i + 1], tones[i + 2], tones[i + 3]];
  }, light = c => c[0] + c[1] + c[2];
  assert.equal(plan.width, world.biomes.length); assert.equal(plan.height, BEDS * ROWS + 3); assert.equal(tones.length, plan.width * plan.height * 4);
  for (let column = 0; column < plan.width; column++) {
    for (let bed = 0; bed < BEDS; bed++) for (const row of [0, 31, 64, 127]) {
      assert.equal(at(column, bed, row)[3], 255);
      // Under the first hundred metres there is no telling which biome stands above.
      if (bed >= 5) assert.deepEqual(at(column, bed, row), at(0, bed, row));
    }
    assert(light(at(column, 0, 0)) > light(at(column, 8, 127)), 'the basement is darker than surface earth');
    for (let bed = 0; bed < BEDS - 1; bed++) {
      const edge = at(column, bed, ROWS - 1), next = at(column, bed + 1, 0);
      assert(edge.slice(0, 3).every((v, k) => Math.abs(v - next[k]) <= 1), 'adjacent beds meet in the same tone');
    }
  }
  const sand = world.biomes.findIndex(r => r.id === 'arid-basin'), wet = world.biomes.findIndex(r => r.id === 'wet-valley');
  assert(sand >= 0 && wet >= 0);
  assert(Math.abs(light(at(sand, 1, 64)) - light(at(wet, 1, 64))) > 40, 'dry earth is not the earth of the valley');
  assert.deepEqual(strataTones(strataPlan(ground('world'))), tones);
  // One biome alone is one earth: both columns of its texture are the same.
  for (const id of ['plateau', 'flat']) {
    const alone = strataPlan(ground(id)), own = strataTones(alone);
    assert.equal(alone.width, 2);
    for (let i = 0; i < own.length; i += 8) assert.deepEqual([own[i], own[i + 1], own[i + 2]], [own[i + 4], own[i + 5], own[i + 6]]);
    for (const x of [-Infinity, -300, 0, 12, 700, Infinity]) assert.equal(alone.coordinate(x), 0);
  }
  const texture = strataTexture(plan);
  try { assert.equal(texture.source.pixelWidth, plan.width); assert.equal(texture.source.pixelHeight, BEDS * ROWS + 3); assert.equal(texture.source.addressMode, 'clamp-to-edge'); }
  finally { texture.destroy(true); }
});

test('across a border the earth of one region gives way to the next over the stretch the surface fades', () => {
  const world = new Terrain('world', { seed: 6173, length: 512000 }), plan = strataPlan(world), epsilon = 1e-7;
  assert.equal(plan.coordinate(-Infinity), 0); assert.equal(plan.coordinate(world.biomes[0].start - WORLD_BLEND - 1), 0);
  assert.equal(plan.coordinate(Infinity), world.biomes.length - 1);
  assert.equal(plan.coordinate(world.biomes.at(-1).end + WORLD_BLEND + 1), world.biomes.length - 1);
  for (const [i, region] of world.biomes.entries()) {
    if (!i) continue;
    const border = region.start;
    assert.equal(plan.coordinate(border - WORLD_BLEND - 1), i - 1); assert.equal(plan.coordinate(border + WORLD_BLEND + 1), i);
    assert(Math.abs(plan.coordinate(border) - (i - .5)) < 1e-9); assert(Math.abs(plan.coordinate(border - 1e-7) - (i - .5)) < 1e-6);
    for (const offset of [-WORLD_BLEND - epsilon, -WORLD_BLEND, -WORLD_BLEND + epsilon, -epsilon, 0, epsilon, WORLD_BLEND - epsilon, WORLD_BLEND, WORLD_BLEND + epsilon]) {
      const x = border + offset, t = Math.max(0, Math.min(1, (x - border + WORLD_BLEND) / (2 * WORLD_BLEND)));
      assert.equal(plan.coordinate(x), i - 1 + t * t * (3 - 2 * t), `exact biome coordinate at ${x}`);
    }
    for (let x = border - WORLD_BLEND; x < border + WORLD_BLEND; x += 2) {
      const step = plan.coordinate(x + 2) - plan.coordinate(x);
      assert(step >= 0 && step < .014, 'the earth changes by a hundredth of the way at a time');
    }
  }
  assert.equal(plan.look(world.biomes[1].start, 'span'), (plan.looks[0].span + plan.looks[1].span) / 2);
});

// The first two metres of a stretch of ground and the beds under them, as a scene paints them at a step: the
// ground line drawn there (the outline as the step simplifies it, exact where one ground gives way to the next),
// and what the triangles of both meshes paint along the vertical through x, from the top down.
function paintedGround(terrain, left, right, step = 0) {
  const sectors = terrain.sectors.filter(s => s.end > left && s.start < right),
    outline = [{ x: left, y: terrain.height(left) }, ...terrain.points.filter(p => p.x > left && p.x < right), { x: right, y: terrain.height(right) }],
    points = step ? simplifyGround(outline, outlineError(step)) : outline,
    local = { ...terrain, minX: left, maxX: right, sectors, points,
      height: x => terrain.height(x), surface: x => terrain.surface(x), materialAt: x => terrain.materialAt(x) },
    drawing = anchorGraphics(new Graphics(), left, 0), metres = new Map();
  drawGroundSurface(local, drawing, step > 0);
  const surface = surfaceGeometry(drawing.context), strata = buildStrata(strataPlan(terrain), left, right, earthFloor(terrain), step, false);
  // The triangles each mesh paints, in the places of the world, filed by the metres along the ground they cross.
  const file = (positions, indices, count) => {
    for (let i = 0; i < count; i += 3) {
      const corners = [0, 1, 2].map(k => [left + positions[indices[i + k] * 2], positions[indices[i + k] * 2 + 1]]),
        xs = corners.map(c => c[0]);
      for (let m = Math.floor(Math.min(...xs)); m <= Math.floor(Math.max(...xs)); m++) {
        if (!metres.has(m)) metres.set(m, []);
        metres.get(m).push(corners);
      }
    }
  };
  try {
    file(surface.attributes.aPosition.buffer.data, surface.indexBuffer.data, surface.indexBuffer.data.length);
    file(strata.positions, strata.indices, strata.bedIndices);
  } finally { surface.destroy(true); drawing.destroy({ context: true }); }
  const line = [...points, ...sectors.flatMap(s => [s.start, s.end]).filter(x => x > left && x < right).map(x => ({ x, y: terrain.height(x) }))]
    .sort((a, b) => a.x - b.x);
  return {
    top: x => { const i = line.findIndex(p => p.x >= x), b = line[i], a = line[Math.max(0, i - 1)]; return a === b ? b.y : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x); },
    spans: x => {
      const spans = [];
      for (const corners of metres.get(Math.floor(x)) || []) {
        const ys = [];
        for (let k = 0; k < 3; k++) {
          const [a, b] = [corners[k], corners[(k + 1) % 3]];
          if (x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) continue;
          if (a[0] === b[0]) ys.push(a[1], b[1]); else ys.push(a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]));
        }
        if (ys.length) spans.push([Math.min(...ys), Math.max(...ys)]);
      }
      return spans.sort((a, b) => b[1] - a[1]);
    },
  };
}
// How far under the drawn ground at x the sky first shows, looking down to 40 m: 40 m where it does not.
function skyUnder(painted, x) {
  const top = painted.top(x);
  let reach = top - .01;
  for (const [low, high] of painted.spans(x)) { if (high < reach - 1e-4) break; reach = Math.min(reach, low); }
  return Math.min(40, top - reach);
}

// Where the ground falls steeply, nothing of the sky shows through the earth under it: every place from the
// ground some way down is painted by its first two metres or by a bed. The steep descent of the laboratory
// ground falls 8 m in 10: the lowest ground two metres along lies deeper than those two metres reach.
test('under a steep slope the first two metres and the beds leave no sky between them', () => {
  const terrain = ground('laboratory'), left = -700, right = -620, painted = paintedGround(terrain, left, right);
  assert((terrain.height(-650) - terrain.height(-656)) / 6 > .75, 'the descent is as steep as it was laid out');
  for (let x = left + 1; x < right - 1; x += .02) {
    const sky = skyUnder(painted, x);
    assert(sky >= 40, `the sky shows ${sky.toFixed(2)} m under the ground at ${x.toFixed(2)}`);
  }
});

// From afar the ground is drawn with fewer corners (terrain-lod.ts), and so are the buried edges of its first two
// metres. Over a pit those edges keep its corners: they cut neither across its mouth, painting earth over the
// opening, nor above its floor, leaving the sky under it. Up close the same holds over the two ditches, whose
// walls are a quarter of a metre wide. Only the rim stroked along a near ground, or the earth hung from an
// outline drawn with fewer corners, rises over the ground drawn. Each stretch starts a whole number of metres
// from the start of its ground, as the ground does in a scene: its buried edges keep the same corners.
test('over pits and ditches, near or far, the first two metres neither cover the opening nor bare the earth', () => {
  const terrain = ground('laboratory');
  for (const [left, right, steps] of [[-960, -180, [8, 32]], [-945, -932, [0, 8]], [-2546, -2533, [0, 8]]]) for (const step of steps) {
    const painted = paintedGround(terrain, left, right, step), rise = step ? outlineError(step) : .06;
    for (let x = left + 1; x < right - 1; x += .05) {
      const sky = skyUnder(painted, x), over = painted.spans(x)[0][1] - painted.top(x);
      assert(sky >= 40, `step ${step}: the sky shows ${sky.toFixed(2)} m under the ground at ${x.toFixed(2)}`);
      assert(over <= rise, `step ${step}: earth is painted ${over.toFixed(2)} m over the ground at ${x.toFixed(2)}`);
    }
  }
});

// Where a slab meets the earth beside it, every layer of either ends on one line down from the corner between
// them, at the depth both reckon there, the slab's level layers too: no sliver of sky shows between the two.
test('where concrete meets earth their first two metres meet with no sliver of sky between them', () => {
  const terrain = ground('laboratory'), sectors = terrain.sectors,
    seams = sectors.slice(1).filter((s, i) => [s.surface, sectors[i].surface].includes('concrete')).map(s => s.start);
  assert.equal(seams.length, 10, 'the pad and the four steps each meet the earth at both ends');
  for (const seam of seams) {
    const painted = paintedGround(terrain, seam - 3, seam + 3);
    for (let x = seam - 2; x < seam + 2; x += .005) {
      const sky = skyUnder(painted, x);
      assert(sky >= 40, `the sky shows ${sky.toFixed(3)} m under the ground at ${x.toFixed(3)}, by the seam at ${seam}`);
    }
  }
});

test('the first two metres keep their contact offset and fixed material scale, including concrete and ruins', () => {
  for (const id of ['mixed', 'flat', 'laboratory']) {
    const terrain = ground(id), left = terrain.points[0].x, right = terrain.points.at(-1).x, before = terrain.snapshot(),
      parts = buildSoilGrain(terrain, left, right);
    assert.deepEqual(Object.keys(parts), ['soil', 'rock', 'concrete']);
    for (const [kind, part] of Object.entries(parts)) {
      assert.deepEqual([part.x, part.y], [left, 0]);
      assert.equal(part.positions.length, part.uvs.length); assert.equal(part.indices.length % 6, 0);
      if (!part.indices.length) continue;
      for (let i = 0; i < part.positions.length; i += 4) {
        const x = left + part.positions[i], y = terrain.height(x);
        assert(Math.abs(part.positions[i + 1] - (y - .03)) < .001, 'the top grain remains below the actual contact edge');
        assert(Math.abs(part.positions[i + 3] - (y - (kind === 'concrete' ? 2.1 : groundBandDepth(terrain.seed, x, 2.1)))) < .001);
        assert(Math.abs(Math.hypot(part.uvs[i + 2] - part.uvs[i], part.uvs[i + 3] - part.uvs[i + 1]) * GRAIN_PERIODS[kind] -
          Math.abs(part.positions[i + 3] - part.positions[i + 1])) < .001, 'the rotated grain keeps its size through the crust');
      }
    }
    if (id === 'flat') assert(parts.concrete.indices.length > 0 && !parts.soil.indices.length && !parts.rock.indices.length);
    assert.deepEqual(terrain.snapshot(), before, 'material geometry leaves the physical ground untouched');
  }
});

test('buried band depths stay ordered, continuous and local while the contact depth stays exact', () => {
  const depths = [0, .016, .13, .27, .52, 1.12, 2.1, 15], seed = 6173;
  for (let x = -250; x < 125300; x += 173.31) {
    const values = depths.map(depth => groundBandDepth(seed, x, depth));
    assert.equal(values[0], 0);
    for (let i = 1; i < values.length; i++) {
      assert(values[i] > values[i - 1]); assert(Math.abs(values[i] - depths[i]) <= Math.min(.28, depths[i] * .22));
      assert(Math.abs(values[i] - groundBandDepth(seed, x + 1e-6, depths[i])) < 1e-6);
    }
  }
  const rough = Array.from({ length: 100 }, (_, x) => groundBandDepth(seed, x * .5, 1.12));
  assert(Math.max(...rough) - Math.min(...rough) > .12, 'buried bands have visible, moderate local variation');
});

test('buried clasts are native, varied, below contact, and share exact clipped edges between irregular chunks', () => {
  const terrain = ground('rural-ridges'), plan = strataPlan(terrain), floor = earthFloor(terrain), before = terrain.snapshot(),
    left = 125.125, right = 349.625, whole = buildStrata(plan, left, right, floor),
    centers = [...new Set(Array.from(whole.indices.slice(whole.bedIndices)).filter((_, i) => i % 3 === 0))],
    center = centers.reduce((kept, next) => Math.abs(left + whole.positions[next * 2] - 237.375) < Math.abs(left + whole.positions[kept * 2] - 237.375) ? next : kept),
    border = left + whole.positions[center * 2],
    a = buildStrata(plan, left, border, floor), b = buildStrata(plan, border, right, floor);
  assert(whole.clasts >= right - left && whole.clasts <= (right - left + 2) * 3);
  for (const mesh of [whole, a, b]) {
    const depths = [];
    for (let i = mesh.bedVertices * 2; i < mesh.positions.length; i += 2) {
      const x = mesh.x + mesh.positions[i], y = mesh.positions[i + 1];
      assert(x >= mesh.x - 1e-5 && x <= (mesh === a ? border : right) + 1e-5);
      assert(y < terrain.height(x) - .25, 'a clast cannot change the native contact silhouette');
      depths.push(terrain.height(x) - y);
    }
    assert(Math.max(...depths) > 10 && Math.min(...depths) < 1, 'different depths break up the cut instead of one pebble row');
    assert(mesh.clastGrain.indices.length > 0);
    assert.equal(mesh.clastGrain.positions.length, mesh.positions.length - mesh.bedVertices * 2);
    assert.equal(mesh.clastGrain.indices.length, mesh.indices.length - mesh.bedIndices, 'the separate finish covers exactly the native clasts');
  }
  const edge = (mesh, local) => {
    const values = [];
    for (let i = mesh.bedVertices * 2; i < mesh.positions.length; i += 2)
      if (Math.abs(mesh.positions[i] - local) < 1e-6) values.push(mesh.positions[i + 1]);
    return [...new Set(values)].sort((a, b) => a - b);
  };
  assert(edge(a, border - left).length > 0);
  assert.deepEqual(edge(a, border - left), edge(b, 0), 'both chunks clip the same world clasts');
  assert(buildStrata(plan, left, right, floor, 8).clasts < whole.clasts / 4, 'only already subpixel clasts are dropped in the coarse view');
  assert.equal(buildStrata(plan, left, right, floor, 32).clasts, 0);
  assert.deepEqual(terrain.snapshot(), before);
});

test('every bed material repeats in metres at shared chunk edges and across depth, without a grain underlap', () => {
  const terrain = ground('world'), plan = strataPlan(terrain), floor = earthFloor(terrain), left = 125000.125, border = 125271.375,
    a = buildStrata(plan, left, border, floor), b = buildStrata(plan, border, 125512.7, floor);
  for (const kind of ['soil', 'rock']) {
    for (const mesh of [a, b]) {
      const part = mesh.grain[kind], period = GRAIN_PERIODS[kind];
      for (let i = 0; i < part.positions.length; i += 2) {
        const u = part.uvs[i], v = part.uvs[i + 1], x = part.positions[i], y = part.positions[i + 1];
        assert(Math.abs(Math.hypot(u - part.uvs[0], v - part.uvs[1]) * period -
          Math.hypot(x - part.positions[0], y - part.positions[1])) < .004, 'bed thickness and rotation never stretch the grain');
      }
    }
    const edge = (part, local) => {
      const values = new Map();
      for (let i = 0; i < part.positions.length; i += 2) if (Math.abs(part.positions[i] - local) < 1e-6)
        values.set(part.positions[i + 1], [part.uvs[i], part.uvs[i + 1]]);
      return values;
    }, end = edge(a.grain[kind], border - left), start = edge(b.grain[kind], 0);
    for (const [height, [u, v]] of end) {
      assert(start.has(height)); const [other, low] = start.get(height);
      for (const turns of [u - other, v - low]) assert(Math.abs(turns - Math.round(turns)) < .0002, 'both UV axes meet across the chunk');
    }
  }
  // Each material band's top and foot are stitched from the next band's actual
  // polyline. Their shared endpoints occur once on each side of the same edge,
  // rather than following the extra opaque lap used only by native bed colours.
  const mesh = buildStrata(plan, 20, 40, floor), boundary = bedStrip(mesh, 2), soil = mesh.grain.soil;
  for (const column of boundary.slice(0, -1)) {
    const x = column.x, y = column.top;
    let found = false;
    for (let i = 0; i < soil.positions.length; i += 2) if (soil.positions[i] === x && soil.positions[i + 1] === y) found = true;
    assert(found, 'the soil ends on the rock top, excluding opaque underlap');
  }
});
