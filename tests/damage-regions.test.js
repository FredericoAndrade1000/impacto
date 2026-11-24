import test from 'node:test';
import assert from 'node:assert/strict';
import { damageConstruction, face } from './damage-fixtures.js';
import { polygonProperties, regionPolygons } from '../src/damage-regions.ts';
import { armorGrid } from './armor-grid-contract.js';
import { managedWorld, ownerState } from './mechanical-queries.js';

const near = (actual, expected, tolerance = 1e-9) =>
  assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const rectangle = t => {
  const source = damageConstruction({ length: 2, height: 2, rideHeight: 1, thicknesses: { floor: 1000 } }),
    ends = {
      'hull:floor': { start: 1, end: 0 }, 'hull:rear': { start: 10, end: 0 },
      'hull:roof': { start: 0, end: 1 }, 'hull:front': { start: 0, end: 10 },
    };
  // The material assay includes these authored corner overlaps as real metal. In cells: the walls run half a metre
  // past the thick floor, the floor and the roof one cell past their joints (4 cm before the grid), and none past
  // the others (2.5 mm before).
  for (const plate of source.plates) plate.ends = ends[plate.id];
  return managedWorld(t, source);
};
const area = polygons => polygons.reduce((sum, polygon) => sum + polygonProperties(polygon).area, 0);
const contains = (plate, point) => {
  const local = { x: point.x - plate.definition.x, y: point.y - plate.definition.y };
  return plate.solidRegions.some(r => local.x > r.minX && local.x < r.maxX && local.y > r.minY && local.y < r.maxY);
};

test('ballistic material stays bounded with fixed carrier mass after many disjoint and overlapping hits', t => {
  const world = rectangle(t), plate = face(world, 'floor'), nodes = plate.nodes.map(n => ({ ...n.local })),
    indices = Array.from(plate.activeIndices);
  const original=ownerState(world,plate).state;let maximum=0;
  for (let i = 0; i < 700; i++) {
    const x = 11 + (i * .618033988749895 % 1) * 2, y = .5 + i * .414213562373095 % 1,
      start = { x: x - .005, y: y - .009 }, end = { x: x + .005, y: y + .009 };
    world.cutBody(plate, start, end, .008);
    assert(plate.remainingArea >= 0);
    near(area(regionPolygons(nodes,plate.activeIndices,plate.solidRegions)),plate.remainingArea);
    assert.equal(ownerState(world,plate).state.mass,original.mass);
    assert.equal(ownerState(world,plate).state.inertia,original.inertia);
    const grid = armorGrid(plate);
    near(grid.area, plate.remainingArea);
    assert(plate.solidRegions.length <= grid.cells.length);
    maximum = Math.max(maximum, plate.solidRegions.length);
    const remaining=plate.remainingArea;
    world.cutBody(plate, start, end, .008);
    near(plate.remainingArea,remaining);
  }
  assert(maximum > 40, 'fixture exercises many disjoint presentation runs without growing the fixed grid');
  assert.deepEqual(plate.nodes.map(n => n.local), nodes); assert.deepEqual(Array.from(plate.activeIndices), indices);
  near(area(regionPolygons(nodes, plate.activeIndices, plate.solidRegions)), plate.remainingArea);
});

test('an oblique channel removes a narrow staircase rather than its whole diagonal box', t => {
  const world = rectangle(t), plate = face(world, 'floor'), start = { x: 11.2, y: .7 }, end = { x: 12.8, y: 1.3 }, radius = .012;
  world.cutBody(plate, start, end, radius);
  const removed = plate.originalArea - plate.remainingArea;
  assert(removed > 2 * radius * Math.hypot(end.x - start.x, end.y - start.y));
  assert(removed < .22, 'diagonal damage remains local');
  // 1 m thick; mitred into its neighbours, the plate is a little longer than its 2 m wall.
  assert(plate.definition.length > 2); near(plate.remainingArea + removed, plate.definition.length);
  const holes = Array.from({ length: 101 }, (_, i) => ({
    x: start.x + (end.x - start.x) * i / 100, y: start.y + (end.y - start.y) * i / 100,
  }));
  assert(holes.every(point => !contains(plate, point)));
  world.cutBody(plate, { x: 11.1, y: 1.35 }, { x: 11.5, y: 1.35 }, .03);
  assert(holes.every(point => !contains(plate, point)), 'merging regions cannot heal an earlier opening');
});

test('a shallow crater preserves the rear material and its second moment', t => {
  const world = rectangle(t), plate = face(world, 'floor'), original = plate.massProperties.second,
    before = ownerState(world, plate).state, initial = armorGrid(plate);
  world.cutBody(plate, { x: 11.8, y: 1.6 }, { x: 11.8, y: 1.4 }, .02);
  const grid = armorGrid(plate), removed = plate.originalArea-plate.remainingArea;
  // Whole cells conservatively cover the shallow capsule. Its uncertainty is
  // bounded by one cell on each side and one extra thickness row, not a packet.
  assert(removed >= .004-1e-12);
  assert(removed <= (.04+2*grid.dx)*(.12+grid.dy)+1e-12);
  near(removed/(grid.dx*grid.dy), Math.round(removed/(grid.dx*grid.dy)));
  assert(contains(plate, { x: 11.8, y: 1 }));
  const removedSecond = initial.cells.filter(c => !grid.occupied(c.y*grid.nx+c.x))
    .reduce((sum,c) => sum+c.second, 0);
  near(plate.massProperties.second+removedSecond, original);
  near(grid.second, plate.massProperties.second);
  assert.equal(ownerState(world,plate).state.inertia,before.inertia);
  assert.equal(ownerState(world,plate).state.mass,before.mass);
  assert.equal(world.projectiles.length,0);
});
