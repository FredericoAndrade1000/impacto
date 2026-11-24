import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { damageConstruction, face } from './damage-fixtures.js';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { localToWorld, segmentConvex, worldToLocal } from '../src/math.ts';
import { regionPolygons } from '../src/damage-regions.ts';
import { dent, flyRound, materialState, ownerState, physics, setPart, setVehicle } from './mechanical-queries.js';

function checkVisibleGeometry(world, plate) {
  for (let i = 0; i < 70; i++) {
    const y = .8 + i * .034, start = { x: 9.4, y }, end = { x: 10.6, y: y + .013 },
      polygons = regionPolygons(plate.nodes.map(n => ({ ...n.local, u: n.u, v: n.v })), plate.activeIndices, plate.solidRegions),
      intervals = polygons.map(polygon => segmentConvex(start, end, polygon.map(p => ({
        x: plate.frame.x + plate.frame.c * p.x - plate.frame.s * p.y,
        y: plate.frame.y + plate.frame.s * p.x + plate.frame.c * p.y,
      })))).filter(hit => hit && hit.exit - hit.enter > 1e-8).sort((a, b) => a.enter - b.enter),
      actual = world.index.raycast(start, end);
    if (!intervals.length) { assert.equal(actual, null); continue; }
    const first = intervals[0]; let exit = first.exit;
    for (let k = 1; k < intervals.length; k++) {
      if (intervals[k].enter > exit + 1e-6) break;
      exit = Math.max(exit, intervals[k].exit);
    }
    assert(actual); assert(Math.abs(actual.enter - first.enter) < 1e-6);
    assert(Math.abs(actual.exit - exit) < 1e-6, 'native CCD matches the visible material intervals');
    const uv = materialState(world, plate, actual).uv;
    assert(uv.x >= -1e-9 && uv.x <= 1 + 1e-9 && uv.y >= -1e-9 && uv.y <= 1 + 1e-9);
  }
}
function scene(t, material = 'steel', thickness = 50) {
  const blueprint = damageConstruction({ length: 4, height: 2.6, rideHeight: .7, material, frontThickness: thickness });
  const world = new World(blueprint); t.after(() => world.dispose()); return world;
}
function layered(t) {
  const world = scene(t), other = damageConstruction({ length: 4, height: 2.6, rideHeight: .7, frontThickness: 50 });
  world.addActor(other, { id: 'passing', x: 12 });
  return world;
}
const sweep = (world, x) => world.index.raycast({ x: x - .3, y: 2 }, { x: x + .3, y: 2 });

test('reduced native geometry preserves actual apertures, dents and material hit coordinates', t => {
  const world = scene(t), plate = face(world);
  world.cutBody(plate, { x: 9.7, y: 1.9 }, { x: 10.3, y: 1.9 }, .02);
  checkVisibleGeometry(world, plate);
  const before = physics(world);
  dent(world, plate, { x: 9.98, y: 2.3 }, .006, .03);
  for (let i = 0; i < 12; i++) world.step();
  checkVisibleGeometry(world, plate);
  assert.equal(physics(world).colliders, before.colliders);
});

test('blocked small rounds leave marks and preserve native body allocation and all ballistic intervals', t => {
  const world = scene(t, 'concrete', 100), before = physics(world),
    first = world.index.raycast({ x: 9.5, y: 2 }, { x: 10.5, y: 2 });
  // Each round flies from half a metre in front of the wall, which stops it within its step.
  for (let i = 0; i < 32; i++) assert.equal(flyRound(world, { id: `round-${i}`, x: 9.5, y: 2, vx: 90, vy: 0,
    mass: .001, caliberMm: 4, power: 1, radius: .002, ammo: 'ap', age: 0, visited: new Set() }), null);
  assert(face(world).marks.length > 0); assert.equal(face(world).integrity, 1);
  assert.equal(physics(world).bodies, before.bodies); assert.equal(physics(world).colliders, before.colliders);
  const after = world.index.raycast({ x: 9.5, y: 2 }, { x: 10.5, y: 2 });
  assert.equal(after.enter, first.enter); assert.equal(after.exit, first.exit);
});

test('native owner order selects the nearest material and breaks coincident ties deterministically', t => {
  const world = layered(t), start = { x: 9.5, y: 2 }, end = { x: 10.5, y: 2 },
    first = world.index.raycast(start, end), layers = world.index.raycastLayers(start, end);
  const fronts = world.plates.filter(plate => plate.id.endsWith('hull:front'));
  assert.equal(first.owner.id, fronts[0].id); assert(first.x < 10);
  assert.equal(layers.length, 2); assert.deepEqual(layers.map(hit => hit.owner.id), fronts.map(plate => plate.id));
  for (let i = 0; i < 20; i++) {
    world.snapshot(); assert.equal(world.index.raycast(start, end).owner.id, first.owner.id);
  }
  assert.equal(world.index.raycast(start, end, { ignoreIds: new Set([first.owner.id]) }).owner.id, fronts[1].id);
});

test('an actor edit replaces its native geometry while surviving material keeps stable owner handles', t => {
  const world = layered(t), native = world.game(), plate = face(world), owner = native.handle(plate);
  world.removeActor('passing'); world.game();
  assert.equal(world.game().handle(plate), owner); assert.equal(world.index.raycastLayers({ x: 9.5, y: 2 }, { x: 10.5, y: 2 }).length, 1);
  world.cutBody(plate, { x: 9.7, y: 2 }, { x: 10.3, y: 2 }, .02);
  assert.equal(sweep(world, 10), null, 'a new aperture immediately replaces the old ballistic material');
});

test('servo motion updates its own contour without changing distant armour or allocating bodies', t => {
  const blueprint = createStructuredTemplate('heavy');
  const world = new World(blueprint); t.after(() => world.dispose());
  world.addActor(damageConstruction({ length: 4, height: 2.6, rideHeight: .7 }), { id: 'distant', x: 25 });
  const gun = world.modules.find(m => m.kind === 'weapon'), initialAngle = gun.barrelAngle,
    plate = world.plates.find(p => p.id === 'distant:0:hull:front'),
    before = physics(world), contour = plate.nodes.map(n => [n.x, n.y]);
  world.aimWeapon({ x: gun.x - 30, y: gun.y + 10 },
    world.playerWeapon({ componentId: gun.id, platform: 'vehicle', aimAngle: gun.angle - .3 }));
  for (let i = 0; i < 60; i++) world.step();
  assert(Math.abs(gun.barrelAngle - initialAngle) > .1);
  assert.deepEqual(plate.nodes.map(n => [n.x, n.y]), contour);
  assert.equal(physics(world).bodies, before.bodies); assert.equal(physics(world).colliders, before.colliders);
  assert.equal(sweep(world, 23).owner.id, plate.id);
});

test('weapon failure retains the actual receiver and barrel as ballistic cover', t => {
  const world = new World(createStructuredTemplate('heavy')); t.after(() => world.dispose());
  const gun = world.modules.find(m => m.kind === 'weapon'), polygon = mountedWeaponPolygons(gun).at(-1),
    center = polygon.reduce((p, q) => ({ x: p.x + q.x / polygon.length, y: p.y + q.y / polygon.length }), { x: 0, y: 0 }),
    start = { x: center.x - Math.sin(gun.barrelAngle) * .3, y: center.y + Math.cos(gun.barrelAngle) * .3 },
    end = { x: center.x + Math.sin(gun.barrelAngle) * .3, y: center.y - Math.cos(gun.barrelAngle) * .3 },
    ignoreIds = new Set([...world.plates, ...world.modules].filter(p => p !== gun).map(p => p.id)),
    before = world.index.raycast(start, end, { ignoreIds });
  assert(before); setPart(world, gun, { health: 0 });
  assert(ownerState(world, gun)?.body != null);
  assert.deepEqual(world.index.raycast(start, end, { ignoreIds }), before, 'functional failure retains the actual gun material');
});

test('mounted apertures and running-gear hitboxes follow accepted chassis pose, the gear on its springs', t => {
  const world = new World(createStructuredTemplate('heavy')); t.after(() => world.dispose()); world.game();
  const track = world.modules.find(module => module.kind === 'track'), plate = face(world, 'floor'),
    original = world.vehicle.pose(), contours = structuredClone(world.actor().contactContours);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  world.cutBody(plate, { x: plate.definition.x, y: plate.definition.y - 1 },
    { x: plate.definition.x, y: plate.definition.y + 1 }, .1);
  const regions = structuredClone(plate.solidRegions), positions = plate.nodes.map(node => ({ ...node.local })),
    ids = physics(world).bodyStates.map(state => state.handle),
    ignoreIds = new Set([...world.plates, ...world.modules].filter(part => part !== track).map(part => part.id)),
    start = { x: track.x - track.width * .6, y: track.y }, end = { x: track.x + track.width * .6, y: track.y },
    hit = world.index.raycast(start, end, { ignoreIds }),
    endpoints = [start, end].map(point => worldToLocal(track, point)), built = worldToLocal(original, track).v;
  assert.equal(hit?.owner.id, track.id, 'query must hit the module, not an undefined retired casing');
  setVehicle(world, { x: original.x + 3, y: original.y + 1, angle: .3 });
  assert.deepEqual(plate.solidRegions, regions); assert.deepEqual(physics(world).bodyStates.map(state => state.handle), ids);
  assert.deepEqual(plate.nodes.map(node => ({ ...node.local })), positions, 'rigid motion preserves local ballistic geometry');
  assert.deepEqual(world.actor().contactContours, contours);
  // Lifted off the ground the track hangs let go on its springs, and its material is where it hangs.
  const hung = built - worldToLocal(world.vehicle.pose(), track).v;
  assert(hung > 0 && hung < track.suspension.travel && Math.abs(track.suspension.compression) < 1e-9);
  const [movedStart, movedEnd] = endpoints.map(point => localToWorld(track, point.u, point.v)),
    moved = world.index.raycast(movedStart, movedEnd, { ignoreIds });
  assert.equal(moved?.owner.id, track.id);
  assert(Math.abs(moved.enter - hit.enter) < 2e-6 && Math.abs(moved.exit - hit.exit) < 2e-6,
    'all running-gear material intervals move with the gear under the accepted carrier pose');
});
