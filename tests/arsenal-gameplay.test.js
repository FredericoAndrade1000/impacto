import test from 'node:test';
import assert from 'node:assert/strict';
import { armorTrial } from '../scripts/probes-impact.ts';
import { WEAPON_PRESETS, allowedAmmo, allowedTrajectories, weaponSettings } from '../src/weapons.ts';
import { weaponShapes } from '../src/weapon-art.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { World } from '../src/physics.ts';
import { firingSolution } from '../src/ballistics.ts';
import { muzzleObstruction } from '../src/weapon-geometry.ts';
import { duel } from './helpers/duel.js';

for (const [preset] of Object.entries(WEAPON_PRESETS)) {
  if (allowedAmmo(preset).includes('ap')) test(`${preset}: CCD catches 5 mm steel and heavy armor stops the same AP shot`, () => {
    const thin = armorTrial({ preset, thickness: 5 }), thick = armorTrial({ preset, thickness: 1000 });
    assert.equal(thin.platePenetrations, 1, 'the one primary shot crosses the thin plate once');
    assert(thin.penetrations >= thin.platePenetrations, 'aggregate contacts include any subsequent casing');
    assert(thin.impacts > 0); assert(thin.finite);
    assert.equal(thick.penetrations, 0); assert(thick.blocked > 0); assert.equal(thick.componentHealth, thick.componentMaxHealth);
  });
  test(`${preset}: rendered barrel and real projectile agree on muzzle and caliber`, () => {
    const model = WEAPON_PRESETS[preset], settings = weaponSettings(model.family, { preset });
    const shapes = weaponShapes(preset), xs = shapes.flatMap(s => s.points.filter((_, i) => !(i % 2)));
    assert(Math.abs(Math.max(...xs) - settings.barrel) < 1e-9);
    assert.equal(settings.radius * 2000, model.caliberMm);
    const muzzle = firingSolution({ x: 12, y: 2 }, { x: 30, y: 2 }, settings);
    assert(Math.abs(Math.hypot(muzzle.x - 12, muzzle.y - 2) - settings.barrel) < 1e-9);
    if (settings.trajectory === 'direct') { assert.equal(muzzle.x, 12 + settings.barrel); assert.equal(muzzle.y, 2); }
  });
}
test('AP choices produce clear relative protection and grazing ricochets instead of identical damage', () => {
  assert.equal(armorTrial({ preset: 'm2hb', thickness: 60 }).penetrations, 0);
  assert.equal(armorTrial({ preset: 'm242', thickness: 60 }).platePenetrations, 1);
  const angle = armorTrial({ preset: 'm242', thickness: 60, incidence: 60 });
  assert.equal(angle.penetrations, 0);
  const grazing = armorTrial({ preset: 'm2hb', thickness: 200, incidence: 80 }); assert(grazing.ricochets > 0);
});
test('launchers fire shaped charges and the explosive-only cannon shells: they burst where they strike, with no fake AP mode', () => {
  for (const [preset, fed] of [['at4', ['heat']], ['carlgustaf', ['heat', 'he']], ['m230lf', ['he']]]) {
    assert.deepEqual(allowedAmmo(preset), fed);
    for (const ammo of fed) {
      const trial = armorTrial({ preset, ammo, thickness: 80 });
      assert(trial.explosions > 0, `${preset} ${ammo}`); assert(trial.finite);
    }
    assert.equal(weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo: 'ap' }).ammo, fed[0]);
  }
});
test('matching seeds reproduce impacts and repeated rounds reuse an existing perforation', () => {
  const settings = { preset: 'm242', thickness: 60, count: 6, seed: 928 };
  const stripTimes = ({ meanMs, p95Ms, peakMs, ...rest }) => rest;
  const a = armorTrial(settings), b = armorTrial(settings);
  assert.deepEqual(stripTimes(a), stripTimes(b));
  assert.equal(a.platePenetrations, 1, 'rounds through the opening should not repeatedly cut a fresh plate'); assert(a.componentHealth < a.componentMaxHealth);
});
test('mounted new weapons fire at catalog cadence, impart recoil and preserve construction on reset', t => {
  for (const preset of ['minimi', 'rh202', 'm230lf', 'mk35', 'carlgustaf']) {
    const b = createStructuredTemplate('ifv', { preset }), original = structuredClone(b);
    const w = new World(b); t.after(() => w.dispose()); w.game();
    const module = w.modules.find(m => m.kind === 'weapon'), initialY = w.vehicle.y,
      config = w.playerWeapon({ platform: 'vehicle', componentId: module.id, preset, aimAngle: module.barrelAngle }),
      aim = { x: module.x + 30 * Math.cos(module.barrelAngle), y: module.y + 30 * Math.sin(module.barrelAngle) };
    w.setTrigger(true, aim, config);
    for (let i = 0; i < 60; i++) w.step(); w.setTrigger(false);
    const expected = config.rate / 60;
    assert(Math.abs(w.stats.shots - expected) <= 1, `${preset} cadence`);
    assert(w.vehicle.peakImpulse > 0); assert(Math.abs(w.vehicle.y - initialY) < 0.06);
    assert(w.modules.find(m => m.id === module.id).attached !== false);
    assert.deepEqual(b, original);
  }
});

test('IFV sensor supports stay connected and clear the short MINIMI bore in both directions', t => {
  const b = createStructuredTemplate('ifv', { preset: 'minimi' }), compiled = compileBlueprint(b), w = duel(t, b);
  assert.equal(compiled.mechanicalAdmission, true);
  for (const actorId of ['local', 'opponent']) {
    const gun = w.modules.find(m => m.actorId === actorId && m.kind === 'weapon'),
      settings = w.playerWeapon({ platform: 'vehicle', componentId: gun.id, aimAngle: gun.barrelAngle }, actorId),
      launcher = w.launcher(settings, w.actor(actorId)),
      aim = { x: gun.x + 20 * Math.cos(gun.barrelAngle), y: gun.y + 20 * Math.sin(gun.barrelAngle) },
      muzzle = firingSolution(launcher, aim, settings);
    assert.equal(muzzleObstruction(w.index, w.terrain, launcher, muzzle, settings.radius), null);
    const before = w.stats.shots;
    assert(w.fire(aim, settings, true, actorId), 'the real mounted shot leaves the bore');
    assert.equal(w.stats.shots, before + 1);
    assert.equal(w.drainEvents().some(e => e.type === 'weapon-blocked'), false);
  }
});

test('what falls on a place takes its arc by itself, and may be held to one', () => {
  for (const [preset, ways] of [['m224', ['auto', 'high', 'low']], ['m252', ['auto', 'high', 'low']], ['m119', ['auto', 'low', 'high', 'direct']],
    ['m777', ['auto', 'low', 'high', 'direct']], ['mk19', ['auto', 'low', 'high', 'direct']], ['rh120', ['direct', 'low']]]) {
    assert.deepEqual(allowedTrajectories(preset), ways, preset);
    // The automatic arc is where a gun starts; a gun that fires straight keeps the line of sight.
    assert.equal(weaponSettings(WEAPON_PRESETS[preset].family, { preset }).trajectory, ways.includes('auto') ? 'auto' : 'direct', preset);
  }
  // A mortar laid by itself on a level place takes its high arc, and held to the low one, takes that.
  const point = { x: 2000, y: 0 }, laid = trajectory => firingSolution({ x: 0, y: 1.5 }, point, weaponSettings('mortar', { preset: 'm252', trajectory, charge: 'auto' }));
  assert(laid('auto').reachable && laid('low').reachable);
  assert.equal(laid('auto').angle, laid('high').angle); assert(laid('low').angle < Math.PI / 4 && laid('auto').angle > Math.PI / 4);
});
