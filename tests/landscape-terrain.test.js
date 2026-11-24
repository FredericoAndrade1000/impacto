import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Terrain, BATTLE_TERRAIN_IDS } from '../src/terrain.ts';
import { BIOME_IDS } from '../src/terrain.ts';
import { drawGroundSurface, drawGroundDetail, groundView, earthFloor } from '../src/terrain-art.ts';
import { strataPlan, buildStrata } from '../src/strata-art.ts';
import { plantFlora, plantCover } from '../src/flora-art.ts';
import { skyTones } from '../src/landscape-art.ts';
import { GraphicsRecorder } from './scenery-canvas.js';

for (const id of BATTLE_TERRAIN_IDS.slice(0, 3)) test(`${id}: seeded kilometre landscape is continuous, traversable and geographically coherent`, () => {
  for (const seed of [0, 1, 6173, 930222, 0xffffffff]) for (const length of [1000, 1600, 2000]) {
    const terrain = new Terrain(id, { seed, length, center: 12 }), copy = new Terrain(terrain.descriptor());
    assert.deepEqual(copy.snapshot(), terrain.snapshot());
    assert.equal(terrain.maxX - terrain.minX, length); assert.equal(terrain.points.length, length + 3);
    assert.equal(terrain.spacing, 1);
    let maxSlope = 0, variation = 0;
    for (let i = 1; i < terrain.points.length - 2; i++) {
      const a = terrain.points[i], b = terrain.points[i + 1];
      assert.equal(Math.fround(a.y), a.y); assert.equal(terrain.height(a.x), a.y);
      const slope = Math.abs((b.y - a.y) / (b.x - a.x)); maxSlope = Math.max(maxSlope, slope);
      variation += Math.abs(b.y - a.y);
    }
    assert(maxSlope < .35, `grade ${maxSlope} exceeded a traversable 19.3 degrees`);
    assert(variation > 10, 'the arena must have actual large-scale relief');
    for (const x of [terrain.minX - .01, terrain.minX, terrain.minX + .01, terrain.maxX - .01, terrain.maxX, terrain.maxX + .01])
      assert(Math.abs(terrain.height(x) - terrain.surface(x).y) < 1e-12);
    const surfaces = new Set(terrain.sectors.map(s => s.surface));
    for (const kind of id === 'wet-valley' ? ['soil', 'mud', 'gravel', 'rock'] : id === 'arid-basin' ?
      ['sand', 'gravel', 'rock'] : ['soil', 'gravel', 'concrete', 'rock']) assert(surfaces.has(kind), `${id} lacks ${kind}`);
    for (const f of terrain.features) if (['outcrop', 'road', 'ruins', 'drywash'].includes(f.kind))
      assert.equal(terrain.materialAt(f.peak), f.surface);
    for (let i = 1; i < terrain.sectors.length; i++) assert.equal(terrain.sectors[i - 1].end, terrain.sectors[i].start);
    for (const x of [terrain.minX + 70.3, 12, terrain.maxX - 70.3]) {
      const hit = terrain.raycast({ x, y: terrain.height(x) + 10 }, { x, y: terrain.height(x) - 2 });
      assert(hit); assert(Math.abs(hit.y - terrain.height(x)) < 1e-10); assert.equal(hit.surface, terrain.materialAt(x));
    }
  }
});

test('seed changes the actual ground while moving its centre translates the same terrain', () => {
  for (const id of BATTLE_TERRAIN_IDS) {
    const a = new Terrain(id, { seed: 42 }), b = new Terrain(id, { seed: 43 }), moved = new Terrain(id, { seed: 42, center: -217.5 });
    assert.notDeepEqual(a.points, b.points);
    assert.deepEqual(a.points.map(p => p.y), moved.points.map(p => p.y));
    assert.deepEqual(a.sectors.map(s => s.surface), moved.sectors.map(s => s.surface));
    assert.equal(moved.points[100].x - a.points[100].x, -217.5);
  }
});

test('landscape crests hide lower ground instead of revealing a complete map', () => {
  for (const id of BATTLE_TERRAIN_IDS) {
    const terrain = new Terrain(id, { seed: 6173 }), points = terrain.points;
    let hidden = false;
    for (let i = 80; i < points.length - 200; i += 8) {
      const a = points[i], b = points[i + 160], hit = terrain.raycast({ x: a.x, y: a.y + 1.3 }, { x: b.x, y: b.y + .1 });
      if (hit && hit.enter > .01 && hit.enter < .99) { hidden = true; break; }
    }
    assert(hidden, `${id} offers no terrain occlusion`);
  }
});

test('laboratory fixtures stay exact and landscape inputs reject oversized allocations', () => {
  const flat = new Terrain('flat', { seed: 99, length: 2000, center: 100 });
  assert.equal(flat.points.length, 1587); assert.equal(flat.minX, -384); assert.equal(flat.height(12), 0);
  for (const options of [{ length: 999 }, { length: 512001 }, { seed: -1 }, { seed: 2 ** 32 }, { center: Infinity },
    { length: '1600' }, { center: '0' }, { seed: .5 }])
    assert.throws(() => new Terrain('wet-valley', options), /paisagem/);
});

test('all mechanical contour samples and material intervals match the shared Rust parity fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/landscape-parity.json', import.meta.url))),
    bits = new DataView(new ArrayBuffer(4)), surfaces = ['soil', 'rock', 'concrete', 'gravel', 'sand', 'mud'],
    fold = (hash, word) => Math.imul(hash ^ word, 16777619) >>> 0;
  for (const row of fixture.cases) {
    const terrain = new Terrain(row); let contour = 2166136261, regions = 2166136261;
    for (const p of terrain.points) {
      bits.setFloat32(0, p.y, true);
      contour = fold(fold(contour, (p.x * 2) >>> 0), bits.getUint32(0, true));
    }
    for (const s of terrain.sectors)
      regions = fold(fold(fold(regions, (s.start * 2) >>> 0), (s.end * 2) >>> 0), surfaces.indexOf(s.surface));
    assert.equal(contour, row.contour, `${row.id} seed ${row.seed} contour`);
    assert.equal(regions, row.regions, `${row.id} seed ${row.seed} material regions`);
  }
});

test('landscape art follows the seeded mechanical contour and weather without rebuilding the map', () => {
  for (const id of BIOME_IDS) {
    const terrain = new Terrain(id, { seed: 6173, length: 2000 }), snapshot = terrain.snapshot(),
      earth = new GraphicsRecorder(), fine = new GraphicsRecorder(), props = new GraphicsRecorder();
    drawGroundSurface(terrain, earth);
    // Each stretch has a bounded set of native bands, followed by a shade with
    // every point of the exact contact outline. Soft buried transitions add no
    // physical corners and must never lift the top of a band above that outline.
    const layers = earth.fills(), stretches = terrain.sectors.filter(s => s.end > terrain.points[0].x && s.start < terrain.points.at(-1).x).length, outline = [];
    // The slab of a ruin is three more over the earth it was built on (ruins-art.ts), and a chapada adds five beds of its
    // own rock to each of its tablelands.
    const slabs = 3 * terrain.sectors.filter(s => s.surface === 'concrete').length, beds = id === 'plateau' ? 5 * terrain.features.filter(f => f.kind === 'plateau').length : 0;
    assert(layers.length >= 4 * stretches + slabs + beds && layers.length <= 12 * stretches + slabs + beds,
      'the ground uses a bounded number of cached outlines per material');
    const groups = []; let group = [];
    for (const fill of layers) {
      group.push(fill);
      if (fill.style.color === 0x263f34) { groups.push(group); group = []; }
      if (groups.length === stretches) break;
    }
    assert.equal(groups.length, stretches);
    for (const group of groups) {
      assert(group.length >= 4 && group.length <= 12);
      const shade = group.at(-1).points, deep = group[0].points;
      for (let i = 0; i < shade.length / 2; i += 2) {
        if (!outline.length || shade[i] > outline.at(-1).x) outline.push({ x: shade[i], y: shade[i + 1] + .022 });
        // Every layer starts at the outline itself: nothing of the ground is drawn above what a vehicle stands on.
        assert.equal(deep[i], shade[i]); assert.equal(deep[i + 1], terrain.height(deep[i]));
      }
      // The foot of the deepest layer leans under the next ground, two metres down: two grounds meet at a slope, not a wall.
      const last = deep.length - 2;
      const depth = terrain.height(deep[last]) - deep[last + 1];
      assert(deep[last] > deep[0] + 1 && depth > 1.8 && depth < 2.4);
    }
    assert.equal(outline.length, terrain.points.length);
    for (const [i, p] of terrain.points.entries()) { assert.equal(outline[i].x, p.x); assert(Math.abs(outline[i].y - p.y) < 1e-9); }
    // Under those two metres the strata go on to where the camera stops.
    const view = groundView(terrain), floor = earthFloor(terrain), strata = buildStrata(strataPlan(terrain), terrain.minX, terrain.minX + 500, floor);
    let lowest = Infinity; for (let i = 1; i < strata.positions.length; i += 2) lowest = Math.min(lowest, strata.positions[i]);
    assert.equal(view.minY, floor); assert(lowest <= view.minY, 'the camera stops where the drawn earth does');
    assert.deepEqual([view.minX, view.maxX], [terrain.minX, terrain.maxX]);
    drawGroundDetail(terrain, fine, props);
    assert(fine.calls.length < 16000 && props.calls.length < 12000, 'kilometre scenery should use bounded cached art');
    assert(fine.calls.length > 1000, 'a near view has aggregate and roots below the surface');
    // Grass and loose pebbles are atlas quads, not hundreds of vector calls.
    // Check the actual dressing and the markers still drawn into props.
    const cover = plantCover(terrain, terrain.minX, terrain.maxX), markers = props.calls.flatMap((call, i) => {
      const next = props.calls[i + 1];
      return call[0] === 'moveTo' && next?.[0] === 'lineTo' && call[1] === next[1] &&
        Math.abs(next[2] - call[2] - .4) < 1e-9 ? [{ x: call[1], y: call[2] }] : [];
    });
    assert(cover.some(plant => ['grass', 'dryGrass'].includes(plant.kind)), `${id} has near ground grass`);
    assert(cover.some(plant => ['greyPebbles', 'ochrePebbles'].includes(plant.kind)), `${id} has loose pebbles`);
    assert.deepEqual(plantCover(terrain, terrain.minX, terrain.maxX), cover, 'the same ground has the same cached cover');
    assert(markers.length > 10, 'markers remain distributed over the kilometre landscape');
    for (const marker of markers) assert.equal(marker.y, terrain.height(marker.x), 'each marker starts on the mechanical contour');
    const again = new GraphicsRecorder(), detail = new GraphicsRecorder(), dressed = new GraphicsRecorder();
    drawGroundSurface(terrain, again); drawGroundDetail(terrain, detail, dressed);
    assert.deepEqual(again.calls, earth.calls); assert.deepEqual(detail.calls, fine.calls); assert.deepEqual(dressed.calls, props.calls);
    plantFlora(terrain, terrain.minX, terrain.maxX, id);
    assert.notDeepEqual(skyTones('mist'), skyTones('clear')); assert.notDeepEqual(skyTones('haze'), skyTones('mist'));
    assert.deepEqual(terrain.snapshot(), snapshot, 'weather and art must not alter mechanical terrain');
  }
});
