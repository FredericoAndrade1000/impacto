import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { damageConstruction, face } from './damage-fixtures.js';
import { ownerState, materialState, physics } from './mechanical-queries.js';
import { armorGrid } from './armor-grid-contract.js';

const material = mesh => ({ nodes: mesh.nodes.map(n => [n.u, n.v, n.local.x, n.local.y]),
  indices: [...mesh.activeIndices], area: mesh.remainingArea, dents: [...mesh.dents.values()] });
// The front-heavy dynamic hull has its front axle under the armour, on an authored four-metre frame
// (in cells, axles at ±1.45 m).
function fixture(t, dynamic = false) {
  const source = damageConstruction({height:3,rideHeight:.2,frontThickness:100,dynamic,chassis:dynamic?'wheeled':null});
  if(dynamic) {
    const y = source.chassis.points[0].y;
    source.chassis={model:'wheeled',points: [{ x: -40, y }, { x: 40, y }],axles:[-29,29]};
  }
  const world = new World(source);
  t.after(() => world.dispose()); return {world,part:face(world)};
}
const dent = (world, part, y) => world.command('dent', {
  owner: world.game().handle(part), point: { x: 10.45, y }, depth: .004, radius: .05,
});

for (const dynamic of [false, true]) test(`${dynamic ? 'dynamic closed hull' : 'fixed closed hull'} saturation retains contour, mass, pose and native body`, t => {
  const { world, part } = fixture(t, dynamic), mesh = part.mesh || part;
  for (let i = 0; i < 10; i++) dent(world, part, 1.7);
  const before = material(mesh), native = ownerState(world, part), counts = physics(world),
    revision = mesh.revision, pose = { ...mesh.definition }, contours = structuredClone(world.actor().contactContours);
  if (dynamic) {
    assert(Array.isArray(contours) && contours.length > 0);
    assert(contours.every(polygon => polygon.length >= 3 && polygon.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
  }
  for (let i = 0; i < 100; i++) dent(world, part, 1.7);
  assert.deepEqual(material(mesh), before);
  assert.equal(mesh.revision, revision);
  assert.deepEqual(mesh.definition, pose);
  assert.equal(ownerState(world, part).body, native.body);
  assert.equal(ownerState(world, part).colliders, native.colliders);
  assert.equal(physics(world).bodies, counts.bodies);
  if (dynamic) assert.deepEqual(world.actor().contactContours, contours);
  assert(mesh.marks.length > 0);
  assert.equal(materialState(world, part, { x: 10.45, y: 1.7 }).resistanceScale, 1);
  const oldMarks = mesh.markRevision;
  dent(world, part, 2);
  assert(mesh.markRevision > oldMarks);
  assert.equal(materialState(world, part, { x: 10.45, y: 2 }).resistanceScale, 1,
    'visual dents cannot silently reduce the independent ballistic thickness');
  assert.equal(ownerState(world, part).body, native.body);
  assert.equal(materialState(world, part, { x: 10.45, y: 2.7 }).resistanceScale, 1);
});

test('thirty overlapping native channels retain exact ballistic area and fixed physical mass', t => {
  const world = new World(damageConstruction({length:8,height:2,rideHeight:2,thicknesses:{floor:240}}));
  t.after(() => world.dispose());
  const mesh = face(world,'floor'), originalArea = mesh.remainingArea, before = ownerState(world, mesh);
  for (let i = 0; i < 30; i++) {
    const x = 8.1 + (i * .273) % 7;
    world.cutBody(mesh, { x: x - .02, y: 2.3 }, { x: x + .04, y: 1.7 }, .018 + i % 3 * .005);
  }
  assert.equal(mesh.nodes.length, 4);
  assert.deepEqual([...mesh.activeIndices], [0,1,2,0,2,3]);
  const grid = armorGrid(mesh);
  assert(grid.cells.length > 0 && grid.cells.length < grid.nx*grid.ny);
  assert(mesh.solidRegions.length > 0 && mesh.solidRegions.length <= grid.cells.length);
  const regionArea = mesh.solidRegions.reduce((sum, r) => sum + (r.maxX-r.minX)*(r.maxY-r.minY), 0);
  assert(mesh.remainingArea < originalArea); assert(Math.abs(mesh.remainingArea-regionArea) < 1e-10);
  assert.equal(ownerState(world, mesh).state.mass, before.state.mass);
  assert.equal(ownerState(world, mesh).state.inertia, before.state.inertia);
});
