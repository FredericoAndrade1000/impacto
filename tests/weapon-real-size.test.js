import test from 'node:test';
import assert from 'node:assert/strict';
import { BARREL_REACH, WEAPONS, WEAPON_PRESETS, weaponMountSize, weaponSettings, weaponCompartment } from '../src/weapons.ts';
import { weaponBarrelProfile } from '../src/weapon-geometry.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { World } from '../src/physics.ts';

// Catalogue dimensions, including the estimates identified in weapons.ts. This checks consistency between consumers,
// not independent agreement with manufacturers: trunnion-to-muzzle, tube radius, receiver and recoil, in metres.
const SIZES = {
  minimi: [.40, .0175, .39, .15, 0], fnmag: [.50, .02, .56, .165, 0], m2hb: [.88, .0225, .77, .193, .03],
  mk44: [2.72, .055, .685, .392, .03], m242: [2.08, .05, .594, .373, .03], rh202: [1.91, .03, .70, .25, .02],
  m230lf: [1.53, .045, .60, .303, .03], mk35: [3.3, .05, .95, .48, .03], rh120: [4.25, .115, 1.35, .46, .30],
  at4: [.55, .05, .47, .12, 0], carlgustaf: [.55, .055, .40, .15, 0], mk19: [.35, .03, .745, .20, .03],
  m224: [1.02, .037, .15, .46, .10], m252: [1.28, .05, .20, .50, .10], m119: [3.0, .09, .75, .36, .635],
  m777: [6.8, .12, .50, .45, 1.4], hydra70: [.84, .20, .84, .40, 0],
};
// What the native core admits (game_geometry.rs `BARREL_RADIUS`, game_construction.rs `RECEIVER_LENGTH`,
// `RECEIVER_HEIGHT` and `RECOIL`).
const RADIUS = [.001, .2], LENGTH = [.1, 2], HEIGHT = [.1, 1], RECOIL = [0, 2];
const within = (value, [low, high]) => value >= low && value <= high;
const near = (a, b, e = 1e-9) => assert(Math.abs(a - b) < e, `${a} != ${b}`);

test('each weapon keeps its catalogue dimensions across consumers, without family geometry defaults', () => {
  assert.deepEqual(Object.keys(SIZES).sort(), Object.keys(WEAPON_PRESETS).sort());
  for (const [preset, [barrel, radius, length, height, recoil]] of Object.entries(SIZES)) {
    const model = WEAPON_PRESETS[preset];
    assert.deepEqual([model.barrel, model.barrelRadius, model.receiver.length, model.receiver.height, model.recoil],
      [barrel, radius, length, height, recoil], preset);
    assert(within(barrel, BARREL_REACH) && within(radius, RADIUS) && within(length, LENGTH) && within(height, HEIGHT)
      && within(recoil, RECOIL), preset);
    // The workshop, the drawing and the core read the same tube and the same receiver.
    assert.equal(weaponSettings(model.family, { preset }).barrel, barrel, preset);
    assert.deepEqual(weaponBarrelProfile({ weaponPreset: preset }), { start: .10, end: barrel, radius }, preset);
    // The receiver as it is mounted reaches as far behind it as its compartment of ready rounds does (weapon-variants.test.js).
    assert.deepEqual(weaponMountSize(preset), { width: length + (weaponCompartment(preset)?.lengthM ?? 0), height }, preset);
  }
  for (const [family, model] of Object.entries(WEAPONS)) {
    for (const key of ['width', 'height', 'barrel']) assert(!(key in model), `${family} ${key}`);
  }
});

test('a barrel asked of any length is held within the reach of the shortest launcher and the longest howitzer', () => {
  assert.deepEqual(BARREL_REACH, [.2, 7.5]);
  assert.equal(weaponSettings('cannon', { preset: 'rh120', barrel: .05 }).barrel, BARREL_REACH[0]);
  assert.equal(weaponSettings('cannon', { preset: 'rh120', barrel: 9 }).barrel, BARREL_REACH[1]);
  // A family named without a preset is of the size of its usual one.
  assert.equal(weaponSettings('howitzer').barrel, WEAPON_PRESETS.m119.barrel);
});

test('the native core holds a barrel within the same reach as the catalogue', t => {
  for (const [asked, held] of [[.05, BARREL_REACH[0]], [9, BARREL_REACH[1]], [5.5, 5.5]]) {
    const world = new World(createStructuredTemplate('heavy')); t.after(() => world.dispose());
    const origin = { x: -60, y: 40 }, config = { ...weaponSettings('cannon', { preset: 'rh120', spread: 0 }), barrel: asked };
    world.command('configureLauncher', { point: origin });
    assert(world.fire({ x: origin.x - 400, y: origin.y }, config, true));
    world.step();
    const muzzle = world.drainEvents().find(e => e.type === 'muzzle');
    assert(muzzle, `${asked}`);
    near(Math.hypot(muzzle.x - origin.x, muzzle.y - origin.y), held, 1e-6);
  }
});
