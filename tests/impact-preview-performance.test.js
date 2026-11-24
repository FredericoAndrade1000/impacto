import test from 'node:test';
import assert from 'node:assert/strict';
import { CollisionIndex } from '../src/collision.ts';
import { snapshotCollisionIndex, predictImpact } from '../src/impact-preview.ts';
import { Renderer } from '../src/render.ts';
import { AimQueries } from '../src/aim-queries.ts';
import { regionGeometry, regionContains, designFrame, sampleScene } from '../src/scene-frame.ts';
import { MATERIALS } from '../src/materials.ts';
import { localToWorld, rectangle } from '../src/math.ts';
import { Container, Texture } from 'pixi.js';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Terrain } from '../src/terrain.ts';

await initNativeDynamics();

const whole = { minX: -.0625, maxX: .0625, minY: -1, maxY: 1 };
const aperture = [{ ...whole, maxY: -.1875 }, { ...whole, minY: .1875 }];
function panel(solidRegions = [whole], revision = 1) {
  const definition = { id: 'panel', material: 'steel', x: 10.0625, y: 2, angle: 0,
    length: .125, thicknessMm: 2000, anchors: [] }, blueprint = { modules: [], plates: [definition] };
  return { ...designFrame(blueprint).plates[0], revision, solidRegions: structuredClone(solidRegions) };
}
const state = (plate, otherPlates = [], modules = []) => ({ time: 1, terrain: 'flat', plates: [...(plate ? [plate] : []), ...otherPlates], modules });
function reference(frame) {
  const index = new CollisionIndex();
  for (const item of frame.plates) {
    const type = 'plate';
    const pose = item.definition || item, owner = { type, id: item.id, object: item, material: MATERIALS[item.material] };
    for (const r of item.solidRegions) index.add(owner, rectangle((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2,
      r.maxX - r.minX, r.maxY - r.minY, 0).map(p => localToWorld(pose, p.x, p.y)));
  }
  return index;
}
function equivalent(actualIndex, frame, start, end) {
  const actual = actualIndex.raycast(start, end, { completeExit: true }), expected = reference(frame).raycast(start, end, { completeExit: true });
  if (!expected) { assert.equal(actual, null); return; }
  assert(actual); assert.equal(actual.owner.id, expected.owner.id);
  for (const key of ['x', 'y', 'enter', 'exit', 'depth']) assert(Math.abs(actual[key] - expected[key]) < 1e-7, `${key}: ${actual[key]} != ${expected[key]}`);
  assert.equal(actual.owner.object, frame.plates.find(item => item.id === actual.owner.id));
}

test('preview and picking preserve apertures, concavities and disconnected regions', () => {
  for (const regions of [[whole], aperture, [{ ...whole, maxX: -.02 }, { ...whole, minX: .02 },
    { minX: -.02, maxX: .02, minY: -1, maxY: -.2 }, { minX: -.02, maxX: .02, minY: .2, maxY: 1 }],
    [{ ...whole, maxX: -.02 }, { minX: -.02, maxX: .0625, minY: -1, maxY: -.2 }]]) {
    const plate = panel(regions), frame = state(plate), index = snapshotCollisionIndex(frame);
    assert(index.entries.length <= regions.length * 2);
    for (let ray = 0; ray < 45; ray++) {
      const y = .97 + ray * .047;
      equivalent(index, frame, { x: 9.9, y }, { x: 10.8, y: y + .014 });
      assert.equal(regionContains(plate, { x: 10.05, y }), regions.some(r => -.0125 >= r.minX && -.0125 <= r.maxX && y - 2 >= r.minY && y - 2 <= r.maxY));
    }
  }
});

test('moving snapshots refit the same entries and return the latest owner', () => {
  const first = state(panel()), index = snapshotCollisionIndex(first), entry = index.entries[0], plate = structuredClone(first.plates[0]);
  plate.definition.x += 3;
  const moved = state(plate); moved.time++;
  assert.equal(snapshotCollisionIndex(moved, index), index); assert.equal(index.entries[0], entry);
  assert.equal(index.raycast({ x: 9.9, y: 2 }, { x: 10.3, y: 2 }), null);
  equivalent(index, moved, { x: 12.9, y: 2 }, { x: 13.8, y: 2 });
  snapshotCollisionIndex(state(null), index);
  assert.equal(index.entries.length, 0); assert.equal(index.groups.size, 0);
});

test('a region revision invalidates preview geometry without changing the base contour', () => {
  const initial = state(panel()), index = snapshotCollisionIndex(initial), old = index.entries[0], plate = panel(aperture, 2), frame = state(plate);
  assert.deepEqual(plate.definition, initial.plates[0].definition);
  snapshotCollisionIndex(frame, index); assert.notEqual(index.entries[0], old);
  assert.equal(index.raycast({ x: 9.9, y: 2 }, { x: 10.8, y: 2 }), null);
  assert.equal(regionContains(plate, { x: 10.05, y: 2 }), false);
  snapshotCollisionIndex(state(panel([], 3)), index);
  assert.equal(index.entries.length, 0); assert.equal(regionGeometry(panel([])).indices.length, 0);
});

test('rotating installed plates preserve apertures and owner exclusions', () => {
  const base = panel(aperture), index = snapshotCollisionIndex(state(base)), entry = index.entries[0],
    current = structuredClone(base);
  Object.assign(current.definition, { x: 8, y: 3, angle: .7 });
  const frame = state(current);
  snapshotCollisionIndex(frame, index); assert.equal(index.entries[0], entry);
  for (let ray = 0; ray < 25; ray++) {
    const y = -.95 + ray * .077, start = localToWorld(current.definition, -.2, y), end = localToWorld(current.definition, .5, y);
    equivalent(index, frame, start, end);
    assert.equal(index.raycast(start, end, { ignoreIds: new Set([current.id]) }), null);
  }
});

test('the visual region mesh keeps UVs and excludes internal seams at region junctions', () => {
  const plate = panel([{ ...whole, maxX: -.02 }, { ...whole, minX: .02 },
    { minX: -.02, maxX: .02, minY: -1, maxY: -.2 }, { minX: -.02, maxX: .02, minY: .2, maxY: 1 }]), geometry = regionGeometry(plate);
  assert.equal(regionGeometry(plate), geometry);
  let perimeter = 0;
  for (const edge of geometry.edges) {
    const a = edge.a * 2, b = edge.b * 2, ax = geometry.positions[a], ay = geometry.positions[a + 1],
      bx = geometry.positions[b], by = geometry.positions[b + 1], length = Math.hypot(bx - ax, by - ay);
    perimeter += length;
    const normal = { x: -(by - ay) / length * 1e-5, y: (bx - ax) / length * 1e-5 }, mx = (ax + bx) / 2, my = (ay + by) / 2;
    assert.notEqual(regionContains(plate, localToWorld(plate.definition, mx + normal.x, my + normal.y)),
      regionContains(plate, localToWorld(plate.definition, mx - normal.x, my - normal.y)), 'an outline cannot run through solid material');
  }
  assert(Math.abs(perimeter - (2 * (.125 + 2) + 2 * (.04 + .4))) < 1e-6);
  for (let i = 0; i < geometry.positions.length; i += 2) {
    assert(Math.abs(geometry.uvs[i] - (geometry.positions[i] / .125 + .5)) < 1e-7);
    assert(Math.abs(geometry.uvs[i + 1] - (.5 - geometry.positions[i + 1] / 2)) < 1e-7);
  }
});

test('a visual plate retains its clipped buffers while moving, updates changed regions and releases removed geometry', t => {
  const first = state(panel(aperture)), next = structuredClone(first), renderer = new Renderer({}), layer = new Container();
  next.plates[0].definition.x += 3; next.plates[0].definition.angle = Math.PI / 2;
  const bytes = array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const check = (item, plate) => {
    const expected = regionGeometry(plate);
    for (const key of ['positions', 'uvs', 'indices']) assert.deepEqual(bytes(item.geometry[key]), bytes(expected[key]), key);
    assert.deepEqual(item.edges, expected.edges);
  };
  t.after(() => { renderer.clearParts(); renderer.effectSurfaceClip.destroy(); layer.destroy({ children: true }); });
  renderer.scene = sampleScene(first);
  const item = renderer.geometry(renderer.scene.frame.surfaces[0], layer, Texture.EMPTY), positions = item.positions.slice(), shape = item.data;
  check(item, first.plates[0]);
  renderer.scene = sampleScene(next, first, .5);
  assert.equal(renderer.geometry(renderer.scene.frame.surfaces[0], layer, Texture.EMPTY), item);
  assert.equal(item.data, shape); assert.deepEqual(item.positions, positions);
  assert.equal(item.group.x, 11.5625); assert.equal(item.group.y, 2); assert.equal(item.group.rotation, Math.PI / 4);
  check(item, first.plates[0]);
  const changed = state(panel([{ ...whole, maxY: -.3 }, { ...whole, minY: .3 }], 2)), geometry = item.geometry;
  renderer.scene = sampleScene(changed);
  assert.equal(renderer.geometry(renderer.scene.frame.surfaces[0], layer, Texture.EMPTY), item, 'same-sized region updates retain the mesh');
  assert.equal(item.geometry, geometry); check(item, changed.plates[0]);
  const rebuilt = state(panel([whole], 3)); renderer.scene = sampleScene(rebuilt);
  const replacement = renderer.geometry(renderer.scene.frame.surfaces[0], layer, Texture.EMPTY);
  assert.notEqual(replacement, item, 'a different vertex count replaces the mesh');
  assert(item.group.destroyed); assert.equal(geometry.buffers, null); check(replacement, rebuilt.plates[0]);
  renderer.scene = sampleScene(state(null)); renderer.drawSurfaces();
  assert.equal(renderer.drawables.size, 0); assert(replacement.group.destroyed); assert.equal(replacement.geometry.buffers, null);
});

test('projectile previews pass the tube, retain damaged live cover and ignore defeated whole actors', () => {
  const module = { id: 'gun', actorId: 'local', kind: 'weapon', x: 4, y: 2, angle: 0, barrelAngle: 0,
    width: 1.6, height: .6, health: 100, maxHealth: 100, weaponPreset: 'rh120' },
    index = snapshotCollisionIndex(state(null, [], [module])), entry = index.ownerEntries.get('module:gun')[0],
    current = { ...module, barrelAngle: Math.PI / 2 };
  snapshotCollisionIndex(state(null, [], [current]), index); assert.equal(index.ownerEntries.get('module:gun')[0], entry);
  assert.equal(index.entries[0].owner.object, current);
  assert.equal(index.raycast({ x: 3.8, y: 3 }, { x: 4.2, y: 3 }), null, 'the vertical tube is transparent to direct shots');
  const destroyed = { ...current, health: 0 }, plate = panel(); plate.actorId = 'local';
  const live = { ...state(plate, [], [destroyed]), actors: [{ id: 'local', defeated: false, field: { wreck: { until: 100 } } }] };
  snapshotCollisionIndex(live, index);
  const hit = index.raycast({ x: 3, y: 2 }, { x: 5, y: 2 });
  assert(hit); assert.equal(hit.owner.object, destroyed, 'piece health and field metadata do not make a whole wreck');
  assert.equal(index.raycast({ x: 9.9, y: 2 }, { x: 10.8, y: 2 }).owner.object, plate);
  const wreck = { ...live, actors: [{ id: 'local', defeated: true }] };
  snapshotCollisionIndex(wreck, index);
  assert.equal(index.raycast({ x: 3, y: 2 }, { x: 5, y: 2 }), null);
  assert.equal(index.raycast({ x: 9.9, y: 2 }, { x: 10.8, y: 2 }), null);
  assert.equal(index.entries.length, 0);
  assert.equal(wreck.modules[0], destroyed); assert.equal(wreck.plates[0], plate, 'preview filtering never deletes art/salvage records');
  snapshotCollisionIndex(live, index);
  assert.equal(index.raycast({ x: 3, y: 2 }, { x: 5, y: 2 }).owner.object, destroyed, 'restored live material is admitted again');
});

test('renderer predictions reuse the index while distinct aims and damage query the current regions', () => {
  const frame = state(panel(aperture)), renderer = new Renderer({}, { mode: 'test', weapon: { preset: 'rh120', platform: 'ground' }, editor: { blueprint: frame } });
  renderer.playback.state = frame;
  const solution = y => ({ flightLimit: 45, flight: { model: 'quadratic-drag-v2', mass: .1, caliberMm: 10, family: 'machinegun', dragCoefficient: .30, airDensity: 1.225, scaleHeight: 8500 }, reachable: true, x: 0, y, vx: 1000, vy: 0, time: .011 });
  assert.equal(renderer.impactPrediction(frame, solution(2)), null);
  const index = renderer.aimQueries.index, hit = renderer.impactPrediction(frame, solution(1.2));
  assert(hit); assert.equal(hit.owner.id, 'panel'); assert.equal(renderer.aimQueries.index, index);
  const updated = state(panel([whole], 2)); renderer.playback.state = updated;
  assert(renderer.impactPrediction(updated, solution(2))); assert.equal(renderer.aimQueries.index, index);
  assert.equal(renderer.impactPrediction(updated, solution(2)).owner.object, updated.plates[0]);
  assert.equal(predictImpact(updated, solution(2), {}, index).owner.id, 'panel');
});

test('clearing physical aim queries releases the scene and allows a fresh forecast with reused part names', () => {
  const queries = new AimQueries(), frame = state(panel()), ground = new Terrain('flat'),
    weapon = { platform: 'ground', ammo: 'ap', power: 1 },
    solution = { reachable: true, x: 0, y: 2, vx: 1000, vy: 0, time: .011, flightLimit: 45,
      flight: { model: 'quadratic-drag-v2', mass: .1, caliberMm: 10, family: 'machinegun', dragCoefficient: .30, airDensity: 1.225, scaleHeight: 8500 } },
    forecast = queries.forecast(frame, solution, weapon, ground), index = queries.index;
  assert.equal(forecast.impact.owner.object, frame.plates[0]);
  queries.clear(); queries.clear();
  assert.equal(queries.state, null); assert.equal(queries.index, null); assert.equal(queries.forecastCache, null);
  const next = state(panel(aperture)), fresh = queries.forecast(next, solution, weapon, ground);
  assert.notEqual(queries.index, index, 'the previous scene is no longer retained');
  assert.equal(fresh.state, next); assert.equal(fresh.impact, null, 'the new scene has a hole where the former plate was solid');
});

test('moving artwork never mixes its sampled muzzle with raw armour or refits the index between snapshots', t => {
  const skin = panel(); skin.actorId = 'local'; skin.definition.x = 2.0625;
  const gun = { id: 'gun', actorId: 'local', kind: 'weapon', weaponPreset: 'm2hb', health: 100,
    x: 4, y: 2, angle: 0, barrelAngle: 0, width: .8, height: .3,
    weaponMount: { min: -.6, max: .6, exposed: true, fireTolerance: .01 },
    materialPolygons: [rectangle(0, 0, .4, .2, 0), rectangle(.44, 0, .88, .04, 0)] },
    next = { ...state(skin, [], [gun]), time: 2, controlledActor: 'local', actors: [{ id: 'local', vehicle: {
      chassisId: 'frame', x: 4, y: 0, angle: 0, vx: 12, vy: .25, omega: .2, carrierCenter: { x: .1, y: .2 } } }] },
    first = structuredClone(next), renderer = new Renderer({}, { mode: 'test',
      weapon: { preset: 'm2hb', platform: 'vehicle', componentId: 'gun' }, aim: { x: 12, y: 2 } });
  first.time = 1; first.modules[0].x = 0; first.modules[0].angle = -.15; first.modules[0].barrelAngle = -.1;
  first.plates[0].definition.x -= 4;
  Object.assign(first.actors[0].vehicle, { x: 0, angle: -.15, vx: 3, omega: -.1 });
  renderer.playback.state = next; renderer.ground = new Terrain('flat');
  t.after(() => renderer.effectSurfaceClip.destroy());
  let held, index, entries, refits = 0, clear;
  for (const alpha of [0, .5, 1]) {
    renderer.presentationAlpha = alpha; renderer.scene = sampleScene(next, first, alpha);
    const solution = renderer.aimingSolution(next);
    assert(solution.reachable);
    assert(Math.abs(solution.x - gun.x - renderer.weapon.barrel) < 1e-9, 'the forecast starts at the raw muzzle');
    assert.equal(solution.y, gun.y);
    // Raw COM (4.1,.2), pivot (4,2), omega .2: 11.64 m/s at the pivot and .406 m/s upward at the mouth.
    assert(Math.abs(solution.vx - renderer.weapon.speed - 11.64) < 1e-9, 'motion is inherited from the raw body');
    assert(Math.abs(solution.vy - .406) < 1e-9);
    assert.equal(renderer.weaponObstruction(next, solution), null, 'the raw plate is behind this raw muzzle');
    assert.equal(renderer.impactPrediction(next, solution), null);
    if (!held) {
      held = solution; index = renderer.aimQueries.index; entries = [...index.entries]; clear = index.clear;
      index.clear = function() { refits++; return clear.call(this); };
    } else {
      assert.equal(solution, held, 'alpha alone does not request another physical solve');
      assert.equal(renderer.aimQueries.index, index);
      assert.deepEqual(index.entries, entries);
    }
  }
  assert.equal(refits, 0, 'a display sample does not readmit every shape');
  index.clear = clear;
  const blocker = panel(); blocker.id = blocker.definition.id = 'blocking'; blocker.actorId = 'local'; blocker.definition.x = 7;
  const blocked = { ...next, plates: [...next.plates, blocker] };
  renderer.playback.state = blocked; renderer.scene = sampleScene(blocked);
  const hit = renderer.weaponObstruction(blocked, renderer.aimingSolution(blocked));
  assert(hit?.own, 'real own armour still blocks an admitted request'); assert.equal(hit.owner.id, blocker.id);
  assert.equal(renderer.aimQueries.index, index, 'a genuine new snapshot reuses the existing index');
});
