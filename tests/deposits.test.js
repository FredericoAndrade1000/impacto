import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { depositsOf, depositsNear, recovered, DEPOSIT_FEATURES, DEPOSIT_SPACING, DEPOSIT_RUN, DEPOSIT_RESERVE, RICHEST, RECOVERY_SECONDS, RESERVE_STEP } from '../src/deposits.ts';

const ground = (length = MAIN_WORLD.mapLength, seed = MAIN_WORLD.seed) => new Terrain(MAIN_WORLD.terrain, { seed, length, center: 12 });
const world = ground(), deposits = depositsOf(world), of = material => deposits.filter(d => d.material === material);
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

const MATERIALS = ['ferro', 'ligas', 'silica', 'petroleo'];
test('deposits are read off the features of the ground: iron in outcrops and ruins, alloys in scree, silica in dunes, petroleum in the low wet ground', () => {
  assert(deposits.length > 20);
  assert.deepEqual([...new Set(Object.values(DEPOSIT_FEATURES))], MATERIALS, 'the four things a faction digs');
  for (const material of MATERIALS) assert(of(material).length > 3, `the world has ${of(material).length} deposits of ${material}`);
  assert(of('petroleo').every(d => d.feature === 'lowland') && of('petroleo').every(d => world.materialAt(d.x) === 'mud'), 'petroleum seeps where the ground is low and wet');
  const peaks = new Map(world.features.map(f => [f.kind + ':' + f.peak, f]));
  for (const deposit of deposits) {
    assert(peaks.has(deposit.feature + ':' + deposit.x), 'a deposit lies at the peak of its feature');
    assert.equal(DEPOSIT_FEATURES[deposit.feature], deposit.material);
    assert(deposit.x > world.minX && deposit.x < world.maxX);
  }
  assert.equal(new Set(deposits.map(d => d.id)).size, deposits.length, 'each is known by a name of its own');
  assert.deepEqual(deposits.map(d => d.x), deposits.map(d => d.x).sort((a, b) => a - b), 'from one end of the ground to the other');
  assert(new Set(of('ferro').map(d => d.feature)).size === 2, 'iron comes from both outcrops and ruins');
  assert.deepEqual(depositsOf(new Terrain('flat')), [], 'a ground with no such features has none');
});

test('the server and every page find the same deposits, with nothing sent', () => {
  // A page grows the ground again from what a frame says of it; a snapshot is the ground as a worker holds it.
  const again = ground(), told = Terrain.fromSnapshot(world.snapshot());
  assert.deepEqual(depositsOf(again), deposits); assert.deepEqual(depositsOf(told), deposits);
  assert.equal(depositsOf(world), deposits, 'and a ground is read once');
  assert.notDeepEqual(depositsOf(ground(MAIN_WORLD.mapLength, MAIN_WORLD.seed + 1)).map(d => d.x), deposits.map(d => d.x), 'another seed is another world');
  assert(Object.isFrozen(deposits) && Object.isFrozen(deposits[0]));
});

test('the seed keeps one stretch of ground in so many that have a feature of a material, counted from the middle to each side', () => {
  const draws = new Set();
  for (const material of MATERIALS) {
    const mine = of(material), cells = mine.map(d => Math.floor((d.x - world.center) / DEPOSIT_SPACING));
    assert.equal(new Set(cells).size, mine.length, 'never two in one stretch');
    for (const [i, cell] of cells.entries()) assert.equal(mine[i].id, material + ':' + cell);
    // Of the stretches with a feature of the material, counted off from the middle, one in each run of `DEPOSIT_RUN` has
    // its site, the last run at each end too, and no other has.
    const featured = [...new Set(world.features.filter(f => DEPOSIT_FEATURES[f.kind] === material).map(f => Math.floor((f.peak - world.center) / DEPOSIT_SPACING)))];
    for (const side of [-1, 1]) {
      const row = featured.filter(cell => side > 0 ? cell >= 0 : cell < 0).sort((a, b) => side * (a - b)), kept = new Set(cells);
      for (let start = 0; start < row.length; start += DEPOSIT_RUN) {
        const run = row.slice(start, start + DEPOSIT_RUN), held = run.filter(cell => kept.has(cell));
        assert.equal(held.length, 1, `${material}: one site in the run from ${run[0]}`); draws.add(run.indexOf(held[0]));
      }
      assert.equal(cells.filter(cell => side > 0 ? cell >= 0 : cell < 0).length, Math.ceil(row.length / DEPOSIT_RUN));
    }
    // Where such ground goes on, sites follow each other at about so many stretches.
    const gaps = mine.slice(1).map((d, i) => d.x - mine[i].x).filter(gap => gap < 2 * DEPOSIT_RUN * DEPOSIT_SPACING);
    assert(median(gaps) > DEPOSIT_SPACING * DEPOSIT_RUN * .5 && median(gaps) < DEPOSIT_SPACING * DEPOSIT_RUN * 1.5, `${material}: ${Math.round(median(gaps))} m between neighbours`);
  }
  // It is a draw, not the first place of each run.
  assert.equal(draws.size, DEPOSIT_RUN);
});

test('the vein of a site is richer the farther it lies from the middle of the world', () => {
  const half = world.length / 2;
  for (const deposit of deposits) {
    const richness = 1 + (RICHEST - 1) * Math.abs(deposit.x - world.center) / half;
    assert.equal(deposit.reserve, Math.round(DEPOSIT_RESERVE * richness));
    assert.deepEqual(Object.keys(deposit), ['id', 'x', 'material', 'feature', 'reserve'], 'a site is where it lies, what is dug there and how much a whole vein holds');
  }
  const iron = of('ferro'), middle = iron.reduce((a, b) => Math.abs(a.x - world.center) < Math.abs(b.x - world.center) ? a : b);
  assert(middle.reserve < DEPOSIT_RESERVE * 1.1, 'by the middle, about the plain reserve');
  assert(iron[0].reserve > DEPOSIT_RESERVE * (RICHEST - .2) && iron.at(-1).reserve > DEPOSIT_RESERVE * (RICHEST - .2), 'at the ends, about three times as much');
});

test('a longer world keeps the deposits of a shorter one, but for the last of a material at each end', () => {
  const short = ground(64000), near = depositsOf(short), far = new Map(deposits.map(d => [d.id, d])),
    kept = deposit => far.get(deposit.id)?.x === deposit.x && far.get(deposit.id)?.material === deposit.material,
    outermost = deposit => !near.some(other => other.material === deposit.material && (other.x >= short.center) === (deposit.x >= short.center) &&
      Math.abs(other.x - short.center) > Math.abs(deposit.x - short.center));
  assert(near.length > 20);
  for (const deposit of near) assert(kept(deposit) || outermost(deposit), deposit.id);
  assert(near.filter(kept).length >= near.length - 2 * MATERIALS.length);
});

test('the deposits near a place are found without looking at all of them', () => {
  const [a, b] = of('ferro').slice(3), between = (a.x + b.x) / 2, reach = (b.x - a.x) / 2;
  assert.deepEqual(depositsNear(deposits, a.x, 0), [a]);
  assert.deepEqual(depositsNear(deposits, between, reach).filter(d => d.material === 'ferro'), [a, b], 'the reach counts at both ends');
  assert(!depositsNear(deposits, between, reach - 1).includes(a));
  assert.deepEqual(depositsNear(deposits, world.minX - 5000, 100), []); assert.deepEqual(depositsNear(deposits, 0, 1e9), deposits);
  for (const x of [-9000, -40, 2500]) assert.deepEqual(depositsNear(deposits, x, 700), deposits.filter(d => Math.abs(d.x - x) <= 700));
});

test('every site holds a vein, and what is dug of one comes back by itself: whole from nothing in two hours, evenly, and never more than its reserve', () => {
  // On the field of the game, so many sites of each material, each with its vein.
  assert.deepEqual(MATERIALS.map(material => of(material).length), [160, 86, 44, 39]);
  assert.deepEqual([RECOVERY_SECONDS, RESERVE_STEP], [7200, 1000]);
  const lean = of('ferro').reduce((a, b) => a.reserve < b.reserve ? a : b), rich = of('ferro').reduce((a, b) => a.reserve > b.reserve ? a : b);
  assert(rich.reserve > 2.5 * lean.reserve);
  for (const site of [lean, rich]) {
    // At an even pace of its own reserve: a quarter of it in half an hour, half in an hour, whatever was left.
    assert.equal(recovered(site, 0, 1800), site.reserve / 4); assert.equal(recovered(site, 0, 3600), site.reserve / 2);
    assert.equal(recovered(site, site.reserve / 4, 1800), site.reserve / 2);
    assert.equal(recovered(site, 0, RECOVERY_SECONDS), site.reserve, 'empty to whole in two hours');
    // Never past its reserve, however long it is left alone, and a whole one stays as it is.
    assert.equal(recovered(site, site.reserve * .9, RECOVERY_SECONDS), site.reserve); assert.equal(recovered(site, site.reserve, 3600), site.reserve);
    assert.equal(recovered(site, 0, 0), 0, 'and nothing in no time');
  }
  // A rich vein gains back as much more in the same time: each comes back whole in the same two hours.
  assert.equal(recovered(rich, 0, 60) / recovered(lean, 0, 60), rich.reserve / lean.reserve);
});
