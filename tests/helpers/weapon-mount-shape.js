import assert from 'node:assert/strict';
import { WEAPON_PRESETS, weaponMountSize } from '../../src/weapons.ts';
import { WEAPON_MOUNTS } from '../../src/weapon-mounts.ts';

const EPSILON = 1e-9;
const near = (actual, expected, label) => {
  assert(Number.isFinite(actual), label + ' must be finite');
  assert(Math.abs(actual - expected) < EPSILON, `${label}: ${actual} != ${expected}`);
};
const rectangle = (left, bottom, right, top) => [
  { x: left, y: bottom }, { x: right, y: bottom },
  { x: right, y: top }, { x: left, y: top },
];

function convexQuad(polygon, label) {
  assert.equal(polygon.length, 4, label + ' has four distinct corners');
  for (const point of polygon) {
    assert(Number.isFinite(point.x) && Number.isFinite(point.y), label + ' has finite coordinates');
  }
  const turns = polygon.map((point, i) => {
    const next = polygon[(i + 1) % 4], after = polygon[(i + 2) % 4];
    return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
  });
  assert(turns.every(turn => turn > 0) || turns.every(turn => turn < 0), label + ' is strictly convex in either winding');
}

function sameRectangle(polygon, expected, label) {
  convexQuad(polygon, label);
  const sorted = points => points.toSorted((a, b) => a.x - b.x || a.y - b.y);
  for (const [i, point] of sorted(polygon).entries()) {
    const wanted = sorted(expected)[i];
    near(point.x, wanted.x, label + ' x'); near(point.y, wanted.y, label + ' y');
  }
}

// An undamaged native projection, checked by its physical regions rather than
// the number of facets chosen to approximate the two curved armour sheets.
export function assertMountProjection(gun) {
  const mount = gun.weaponMount, model = WEAPON_PRESETS[gun.weaponPreset];
  assert(model, 'the projection names a catalogued gun'); assert(mount, 'the gun has its admitted mount');
  assert.equal(mount.version, 3); assert.equal(typeof mount.exposed, 'boolean'); assert.equal(typeof mount.mirrored, 'boolean');
  assert.equal(Object.hasOwn(mount, 'mantlet'), false, 'no rectangular mantle bounds remain');
  assert.equal(Object.hasOwn(mount, 'shield'), true, 'shield absence is explicit');
  assert.equal(mount.material, 'steel');
  // The receiver with what the compartment of its ready rounds reaches behind it.
  near(gun.width, weaponMountSize(gun.weaponPreset).width, 'receiver length');
  assert(gun.width >= model.receiver.length, 'never shorter than the gun itself');
  near(gun.height, model.receiver.height, 'receiver height');
  assert.equal(Object.hasOwn(mount, 'port'), false, 'each port belongs to its own wall');
  if (mount.hostId === null) {
    assert.equal(mount.hostOwner, 0); assert.deepEqual(mount.walls, [], 'a free mechanism meets no plate');
  } else {
    assert.equal(typeof mount.hostId, 'string'); assert(mount.hostOwner > 0);
    assert.equal(mount.walls[0].wallId, mount.hostId, 'the mount goes with the first plate it meets');
    assert.equal(mount.walls[0].owner, mount.hostOwner);
    if (mount.exposed) assert.equal(mount.walls.length, 1, 'a post stands on one face');
    for (const wall of mount.walls) {
      assert(wall.owner > 0 && typeof wall.wallId === 'string' && wall.thicknessMm > 0, 'a real plate');
      for (const end of [wall.a, wall.b]) assert(Number.isFinite(end.x) && Number.isFinite(end.y), 'its middle in mount coordinates');
      if (mount.exposed) { assert.equal(Object.hasOwn(wall, 'port'), false, 'an exposed post does not cut a port'); continue; }
      assert(wall.port.lo < wall.port.hi, 'each plate fired through has a finite real port');
      assert(mount.min <= wall.port.min && wall.port.min <= wall.port.max && wall.port.max <= mount.max,
        'cut by a stretch of the sector');
    }
  }
  const [receiver, tube, ...armour] = gun.materialPolygons;
  sameRectangle(tube, rectangle(0, -model.barrelRadius, model.barrel, model.barrelRadius), 'tube role 1');
  if (mount.exposed) {
    assert.equal(mount.shield, null); assert.equal(gun.materialPolygons.length, 4);
    // The post: its top across the trunnion, at least a third of the gun's height wide, and as long down to its face as
    // the gun reaches back from the trunnion and two clearances more, and no more than 1.5 m beyond that.
    convexQuad(receiver, 'post role 0');
    const [foot0, top0, top1, foot1] = receiver, shortest = Math.hypot(gun.width, gun.height / 2) + .03;
    near((top0.x + top1.x) / 2, 0, 'post top x'); near((top0.y + top1.y) / 2, 0, 'post top y');
    assert(Math.hypot(top1.x - top0.x, top1.y - top0.y) >= gun.height / 3 - EPSILON, 'post width');
    const reach = Math.hypot((foot0.x + foot1.x) / 2, (foot0.y + foot1.y) / 2);
    assert(reach >= shortest - EPSILON && reach <= Math.max(shortest, 1.5) + EPSILON, `post length ${reach}`);
    sameRectangle(armour[0], rectangle(-gun.width, -gun.height / 2, 0, gun.height / 2), 'carried receiver role 2');
    sameRectangle(armour[1], rectangle(0, -gun.height / 4, .4 * gun.height, gun.height / 4), 'tube support role 3');
    return;
  }
  sameRectangle(receiver, rectangle(-gun.width, -gun.height / 2, 0, gun.height / 2), 'receiver role 0');
  const profile = WEAPON_MOUNTS[mount.preset], extent = Math.max(gun.height / 2, model.barrelRadius) + .015,
    angle = Math.max(Math.abs(profile.min), Math.abs(profile.max)), gauge = profile.armourMm / 1000,
    footHeight = Math.max(extent / Math.cos(angle) + extent * Math.tan(angle), mount.shield.radius + gauge + .015);
  sameRectangle(armour.shift(), rectangle(-extent, footHeight, extent, footHeight + gauge), 'fixed upper base role 2');
  sameRectangle(armour.shift(), rectangle(-extent, -footHeight - gauge, extent, -footHeight), 'fixed lower base role 3');
  const shield = mount.shield;
  assert.deepEqual(Object.keys(shield).sort(), ['halfAngle', 'opening', 'radius', 'thickness']);
  assert(shield.radius > shield.opening / Math.sin(shield.halfAngle), 'the curved shield clears the tube opening');
  assert(shield.radius + shield.thickness < model.barrel - .015, 'the finite shield ends before the muzzle');
  near(shield.thickness, WEAPON_MOUNTS[mount.preset].armourMm / 1000, 'independent radial armour thickness');
  near(shield.halfAngle, Math.PI / 3, 'fixed shield half angle');
  near(shield.opening, model.barrelRadius + .015, 'clear tube opening');
  const gap = Math.asin(shield.opening / shield.radius), intervals = [[], []];
  for (const [index, polygon] of armour.entries()) {
    const label = 'shield facet ' + index;
    convexQuad(polygon, label);
    const radii = polygon.map(point => Math.hypot(point.x, point.y));
    assert.equal(radii.filter(radius => Math.abs(radius - shield.radius) < EPSILON).length, 2, label + ' has two inner corners');
    assert.equal(radii.filter(radius => Math.abs(radius - shield.radius - shield.thickness) < EPSILON).length, 2, label + ' has two outer corners');
    const angles = polygon.map(point => Math.atan2(point.y, point.x)).sort((a, b) => a - b);
    near(angles[0], angles[1], label + ' has one radial edge');
    near(angles[2], angles[3], label + ' has the other radial edge');
    assert(angles[2] > angles[0], label + ' spans a finite arc');
    assert((angles[2] - angles[0]) * (shield.radius + shield.thickness) <= .020000001, label + ' resolves at most 2 cm of outer arc');
    const side = angles[2] <= -gap + EPSILON ? 0 : 1;
    assert(side === 0 || angles[0] >= gap - EPSILON, label + ' leaves the tube opening empty');
    intervals[side].push([angles[0], angles[2]]);
  }
  for (const [side, [start, end]] of [[-shield.halfAngle, -gap], [gap, shield.halfAngle]].entries()) {
    let cursor = start;
    for (const [from, to] of intervals[side].sort((a, b) => a[0] - b[0])) {
      near(from, cursor, 'shield sheet has neither a gap nor overlapping facets'); cursor = to;
    }
    near(cursor, end, 'the entire fixed shield sheet is present');
  }
}
