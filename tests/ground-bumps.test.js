import test from 'node:test';
import assert from 'node:assert/strict';
import { Container } from 'pixi.js';
import { World } from '../src/physics.ts';
import { Terrain, RoughGround, BUMPS_REACH, BUMPS_DEPTH } from '../src/terrain.ts';
import { TerrainScene, ROUGH, BUMPS_ZOOM } from '../src/terrain-scene.ts';
import { drawRoads } from '../src/road-art.ts';
import { paved, NO_ROADS } from '../src/roads.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { trackWheels } from '../src/running-gear.ts';
import { setVehicle } from './mechanical-queries.js';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();

// The bumps of the ground the page grows (terrain.ts `Terrain.underfoot`) are the mirror of those the core stands every
// running gear on (game_terrain.rs `Bumps`). The core tells them by where it stands the gear: on level ground a tyre
// stands as high over the line as the highest of the bumps under its foot, flat for .3 of its radius behind its axle and
// ahead (game_motion.rs `TYRE_PATCH`) and round past that, and a track along the highest of its road wheels, each on its
// belt halfway to the next. How high a foot stands on the bumps the page has, read every half millimetre:
function footRise(ground, x, radius, [behind, ahead]) {
  let best = -Infinity;
  for (let d = -behind - radius; d <= ahead + radius; d += .0005) {
    const off = d >= -behind && d <= ahead ? 0 : radius - Math.sqrt(Math.max(0, radius ** 2 - (d < 0 ? d + behind : d - ahead) ** 2));
    best = Math.max(best, ground.bump(x + d) - off);
  }
  return best;
}
// The least knot of the bumps of each ground: wheels left on it at a few places stand on a quarter of that at the least.
const LOW = { soil: .03, sand: .04, gravel: .02, rock: .08, mud: .07, graded: .005 };
// A design left on level ground of `surface` at each of `places`, settled there, with what the page reads under it.
function settled(t, design, surface, places, roads = []) {
  const world = new World(createConstruction(design), { visualEvents: false });
  t.after(() => world.dispose());
  world.terrain = new Terrain('rough');
  for (const p of world.terrain.points) p.y = 0;
  world.terrain.sectors = [{ start: -1600, end: 1600, surface }];
  world.game();
  for (const [x0, x1, kind] of roads) world.pave(x0, x1, kind);
  return places.map(x => {
    setVehicle(world, { x, y: 1.5, angle: 0, vx: 0, vy: 0, omega: 0 });
    for (let i = 0; i < 240; i++) world.step();
    return world.modules.filter(m => m.actorId === 'local' && ['wheel', 'track'].includes(m.kind)).map(m => ({ ...m }));
  }).flat().map(gear => ({ gear, ground: world.terrain }));
}

for (const surface of [...Object.keys(LOW), 'concrete'])
  test(`${surface}: a tyre stands on the bumps the page draws, as the core seats it`, t => {
    const rises = [];
    for (const { gear, ground } of settled(t, 'scout', surface, [12, 29.3, 47.9, 66.1, 83.6])) {
      const radius = gear.height / 2, rise = footRise(ground, gear.x, radius, [.3 * radius, .3 * radius]);
      assert(Math.abs(gear.y - radius - rise) < 1e-3, `${surface} at ${gear.x}: the core ${gear.y - radius}, the page ${rise}`);
      rises.push(rise);
    }
    // Over concrete there are none; over any other ground the wheels stand on some.
    if (surface === 'concrete') assert(rises.every(rise => rise === 0));
    else assert(Math.max(...rises.map(Math.abs)) > LOW[surface] / 4, `${surface} has bumps under its wheels`);
  });

test('over a road the bumps are the road\'s: small on graded earth, none on asphalt, and each starts level', t => {
  const roads = [[20, 40.5, 'graded'], [40.5, 61, 'asphalt']], seen = { graded: 0, asphalt: 0, rock: 0 };
  for (const { gear, ground } of settled(t, 'scout', 'rock', [25, 30.2, 36.4, 44.8, 52.3, 57.1, 18.9, 62.4], roads)) {
    const radius = gear.height / 2, rise = footRise(ground, gear.x, radius, [.3 * radius, .3 * radius]);
    assert(Math.abs(gear.y - radius - rise) < 1e-3, `at ${gear.x}: the core ${gear.y - radius}, the page ${rise}`);
    const kind = ground.groundAt(gear.x);
    if (kind === 'asphalt' && gear.x - 1 > 40.5 && gear.x + 1 < 61) assert.equal(rise, 0);
    if (kind === 'graded' && gear.x - 1 > 20 && gear.x + 1 < 40.5) assert(Math.abs(rise) <= .015 / 2);
    seen[kind]++;
  }
  assert(seen.graded && seen.asphalt && seen.rock);
});

test('a track stands along the highest of its road wheels on the bumps the page draws', t => {
  for (const design of ['tracked', 'heavy']) for (const surface of ['rock', 'mud', 'gravel']) {
    for (const { gear, ground } of settled(t, design, surface, [12, 31.7, 57.3])) {
      const { radius, road, low } = trackWheels(gear.width, gear.height), c = Math.cos(gear.angle), s = Math.sin(gear.angle),
        belt = (road.at(-1) - road[0]) / (road.length - 1) / 2,
        over = road.map((x, i) => gear.y + s * x + c * low - radius -
          footRise(ground, gear.x + c * x - s * low, radius, [i > 0 ? belt : 0, i < road.length - 1 ? belt : 0]));
      // Here and there a stone under one wheel holds the belt over a trough under the next.
      assert(Math.abs(Math.min(...over)) < 1e-3 && Math.min(...over) > -1e-3, `${design} on ${surface}: ${over}`);
    }
  }
});

test('the bumps of a ground stand as high as the core has them, start and end level with its line and are the same however they are read', () => {
  const terrain = new Terrain('world', { seed: 6173, length: 64000 }), from = terrain.minX + 1000;
  terrain.roads = paved(paved(NO_ROADS, from + 300, from + 340.25, 'graded'), from + 500, from + 620, 'asphalt');
  const rough = new RoughGround(terrain, from, from + 2000);
  let high = 0, low = 0;
  for (let i = 0; i < 40000; i++) {
    const x = from + i * .05, bump = rough.bump(x), [start, end, ground] = terrain.stretch(x);
    // A stretch of one ground: of a road where one lies, and of the ground between roads.
    assert.equal(ground, terrain.groundAt(x)); assert(start <= x && x < end);
    assert.equal(bump, terrain.bump(x), 'read about a place or along a stretch, a bump is the same');
    if (['concrete', 'asphalt'].includes(ground)) assert.equal(bump, 0);
    high = Math.max(high, bump); low = Math.min(low, bump);
  }
  assert(high <= BUMPS_REACH && low >= -BUMPS_DEPTH && high > .02 && low < -.01);
  for (const x of [from + 300, from + 340.25, from + 500, from + 620]) assert(Math.abs(rough.bump(x)) < 1e-12 && Math.abs(rough.bump(x - 1e-6)) < 1e-5);
  // The outline a near view draws holds both ends, every corner of the line and every knot of the bumps between them.
  const outline = rough.section(from + 290, from + 350), knots = rough.knots.filter((x, i) => i % 2 === 0 && x > from + 290 && x < from + 350);
  assert.deepEqual(outline.map(p => p.x), [...new Set([from + 290, ...terrain.points.map(p => p.x).filter(x => x > from + 290 && x < from + 350), ...knots, from + 350])].sort((a, b) => a - b));
  assert(outline.every(p => p.y === rough.height(p.x) && Math.abs(p.y - terrain.height(p.x) - rough.bump(p.x)) < 1e-9));
});

test('read as narrow as under a tyre, the bumps by either end of a stretch are those of the whole ground', () => {
  const terrain = new Terrain('world', { seed: 6173, length: 64000 }), from = terrain.minX + 1000;
  terrain.roads = paved(paved(NO_ROADS, from + 300, from + 340.25, 'graded'), from + 500, from + 620, 'asphalt');
  // Straight between the knots either side of a place, and none before the first or past the last.
  const along = (knots, x) => {
    for (let i = 2; i < knots.length; i += 2) if (knots[i] > x)
      return knots[i - 2] <= x ? knots[i - 1] + (knots[i + 1] - knots[i - 1]) * (x - knots[i - 2]) / (knots[i] - knots[i - 2]) : 0;
    return 0;
  };
  // Every end of a stretch of one ground over two kilometres, the roads' and those of the grounds between them, read
  // about it every centimetre for three metres either side, five centimetres to either side of the place.
  const ends = [];
  for (let x = from; x < from + 2000;) { const [, end] = terrain.stretch(x); ends.push(end); x = end; }
  assert(ends.length > 6, `${ends.length} ends`);
  for (const end of ends) for (let i = -300; i <= 300; i++) {
    const x = end + i / 100, bump = along(terrain.underfoot(x - .05, x + .05), x);
    assert(Math.abs(bump - terrain.bump(x)) < 1e-12, `${terrain.stretch(x)[2]} ${i / 100} m from the end at ${end}: ${bump}, the ground ${terrain.bump(x)}`);
  }
});

test('a near view draws the ground with its bumps, and again with those of a road the field lays over it', t => {
  const terrain = new Terrain('plateau', { seed: 6173, length: 2000 }), roots = [new Container(), new Container()], scene = new TerrainScene(...roots);
  t.after(() => { scene.clear(); for (const root of roots) root.destroy(); });
  scene.rebuild(terrain);
  const chunk = scene.chunks.find(c => [c.left + 10, (c.left + c.right) / 2, c.right - 10].every(x => terrain.materialAt(x) === 'rock')),
    middle = (chunk.left + chunk.right) / 2, camera = { x: middle, width: 300, zoom: BUMPS_ZOOM };
  let now = 0;
  const settle = zoom => { for (let i = 0; i < 20; i++) scene.update({ ...camera, zoom }, now += 100); },
    // The highest corner the surface of the chunk has at each place along it, counted from its end.
    corners = () => {
      const p = chunk.earth.geometry.attributes.aPosition.buffer.data, at = new Map();
      for (let i = 0; i < p.length; i += 2) at.set(p[i], Math.max(at.get(p[i]) ?? -Infinity, p[i + 1]));
      return at;
    },
    highest = (from, to) => Math.max(...[...corners()].filter(([x]) => x > from - chunk.left && x < to - chunk.left)
      .map(([x, y]) => y - terrain.height(x + chunk.left)));
  settle(BUMPS_ZOOM);
  assert.equal(chunk.step, ROUGH);
  // Every corner of the bumps is a corner of the surface, and the rock has stones over its line.
  const rough = new RoughGround(terrain, chunk.left, chunk.right), drawn = corners();
  for (const p of rough.section(middle - 30, middle + 30).slice(1, -1))
    assert(drawn.get(Math.fround(p.x - chunk.left)) >= Math.fround(p.y) - 1e-6, `a corner of the bumps at ${p.x}`);
  assert(highest(middle - 20, middle + 20) > .08, 'stones of rock stand over the line');
  // Drawn back from afar, the whole outline lies over the same earth as the one with its bumps.
  settle(BUMPS_ZOOM * .99);
  assert.equal(chunk.step, 0); assert.equal(chunk.bases.get(ROUGH).strata, chunk.strata);
  settle(BUMPS_ZOOM);
  // A road of graded earth laid over it: the surface is drawn again with the small bumps of the road, the stones under it.
  const before = chunk.earth, road = paved(NO_ROADS, middle - 20, middle + 20, 'graded');
  terrain.roads = road; scene.repaved([[middle - 20, middle + 20]]);
  assert.equal(chunk.earth, before, 'kept till it is drawn again');
  settle(BUMPS_ZOOM);
  assert(chunk.earth !== before && before.destroyed && chunk.step === ROUGH);
  assert(highest(middle - 19, middle + 19) < .0075 + .02, 'no stone stands through the road');
  // And the road is drawn along the same bumps.
  const roads = scene.roadArt.context.instructions.find(instruction => instruction.action === 'fill').data.path.shapePath.shapePrimitives[0].shape.points,
    { x0, x1 } = road[0], top = new RoughGround(terrain, x0, x1).section(x0, x1);
  // Its top, counted from where it starts.
  assert.deepEqual(roads.slice(0, top.length * 2).map((v, i) => i % 2 ? Math.fround(v) : Math.fround(v - roads[0])),
    top.flatMap(p => [Math.fround(p.x - top[0].x), Math.fround(p.y)]));
});
