import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { snapshotCollisionIndex } from '../src/impact-preview.ts';
import { weaponContains } from '../src/weapon-art.ts';
import { partViews } from '../src/part-view.ts';
import { servoStatus } from '../src/weapon-presentation.ts';
import { weaponBarrelProfile } from '../src/weapon-geometry.ts';

const worldPoint = (gun, x, y) => ({ x: gun.x + Math.cos(gun.barrelAngle) * x - Math.sin(gun.barrelAngle) * y,
  y: gun.y + Math.sin(gun.barrelAngle) * x + Math.cos(gun.barrelAngle) * y });

test('native queries and projectile previews both pass the tube and retain the actual curved steel', t => {
  const world = new World(createStructuredTemplate('howitzer')); t.after(() => world.dispose()); world.game();
  const gun = world.modules.find(m => m.kind === 'weapon'), shield = gun.weaponMount.shield,
    tubeAt = (shield.radius + shield.thickness + weaponBarrelProfile(gun).end) / 2,
    a = worldPoint(gun, tubeAt, -.2), b = worldPoint(gun, tubeAt, .2);
  assert.equal(world.index.raycast(a, b)?.owner.id, gun.id, 'the tube remains a selectable and reserved physical contour');
  assert.equal(world.index.raycast(a, b, { projectile: true }), null, 'direct shots ignore only the tube role');
  const state = world.snapshot(), preview = snapshotCollisionIndex(state);
  assert.equal(preview.raycast(a, b), null);

  const angle = .62, outer = shield.radius + shield.thickness + .03, inner = shield.radius - .01,
    from = worldPoint(gun, outer * Math.cos(angle), outer * Math.sin(angle)), to = worldPoint(gun, inner * Math.cos(angle), inner * Math.sin(angle)),
    actual = world.index.raycast(from, to, { projectile: true }), drawn = preview.raycast(from, to);
  assert.equal(actual?.owner.id, gun.id); assert.equal(drawn?.owner.id, gun.id);
  assert(Math.abs(actual.depth - drawn.depth) < 1e-7, 'forecast and native share the same chord of actual steel');
  assert(Math.abs(actual.nx - drawn.nx) < 1e-8 && Math.abs(actual.ny - drawn.ny) < 1e-8,
    'forecast and native use the same exposed surface');
  assert(Math.abs(drawn.depth - shield.thickness) < .001, 'the radial chord measures physical thickness');
});

test('the projectile preview agrees with native at an exact shared grazing vertex in either direction', t => {
  const world = new World(createStructuredTemplate('howitzer')); t.after(() => world.dispose()); world.game();
  const state = world.snapshot(), gun = state.modules.find(m => m.kind === 'weapon'), shield = gun.weaponMount.shield,
    outer = shield.radius + shield.thickness,
    gap = Math.atan2(shield.opening, Math.sqrt(shield.radius ** 2 - shield.opening ** 2)),
    theta = (gap + shield.halfAngle) / 2, b = outer * Math.cos((shield.halfAngle - gap) / 2 * .8),
    from = worldPoint(gun, b * Math.cos(theta) - .7 * Math.sin(theta), b * Math.sin(theta) + .7 * Math.cos(theta)),
    to = worldPoint(gun, b * Math.cos(theta) + .7 * Math.sin(theta), b * Math.sin(theta) - .7 * Math.cos(theta)),
    ignoreIds = new Set([...state.plates, ...state.modules].filter(item => item.id !== gun.id).map(item => item.id)),
    preview = snapshotCollisionIndex(state);
  for (const [start, end] of [[from, to], [to, from]]) {
    const actual = world.index.raycast(start, end, { projectile: true, ignoreIds }),
      drawn = preview.raycast(start, end, { ignoreIds });
    assert.equal(actual?.owner.id, gun.id); assert.equal(drawn?.owner.id, gun.id);
    for (const key of ['depth', 'nx', 'ny', 'x', 'y']) assert(Math.abs(actual[key] - drawn[key]) < 1e-8,
      `${key} agrees with the native query at the unmodified shared vertex`);
  }
});

test('a native local perforation and jam update drawing, preview and inspection together', t => {
  const world = new World(createStructuredTemplate('howitzer')); t.after(() => world.dispose());
  const game = world.game(), gun = world.modules.find(m => m.kind === 'weapon'), owner = game.handle(gun.id), shield = gun.weaponMount.shield, angle = .62;
  game.call({ op: 'setPartState', owner, state: { health: gun.maxHealth * .6,
    mantletHoles: [{ min: angle - .04, max: angle + .04 }], elevationDamage: gun.maxHealth * .4 } });
  const state = world.snapshot(), current = state.modules.find(m => m.id === gun.id), point = worldPoint(current,
    (shield.radius + shield.thickness / 2) * Math.cos(angle), (shield.radius + shield.thickness / 2) * Math.sin(angle)),
    from = worldPoint(current, (shield.radius + shield.thickness + .03) * Math.cos(angle), (shield.radius + shield.thickness + .03) * Math.sin(angle)),
    to = worldPoint(current, (shield.radius - .01) * Math.cos(angle), (shield.radius - .01) * Math.sin(angle));
  assert.equal(world.index.raycast(from, to, { projectile: true }), null);
  assert.equal(snapshotCollisionIndex(state).raycast(from, to), null);
  assert.equal(weaponContains(current, point), false, 'a missing strip is empty in selection too');
  assert.equal(servoStatus(current).disabled, true);
  assert.equal(partViews(world.blueprint, state, [gun.id])[0].health.status, 'Mecanismo de elevação travado');
});
