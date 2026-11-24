import test from 'node:test';
import assert from 'node:assert/strict';
import { constructionCatalogue, weaponCatalogue } from '../src/construction-admission.ts';
import { WEAPON_PRESETS, weaponSettings } from '../src/weapons.ts';

test('admission, templates and pricing share one immutable catalogue for the loaded build', () => {
  const catalogue = constructionCatalogue();
  assert.equal(constructionCatalogue(), catalogue);
  assert.equal(catalogue.weapons, weaponCatalogue());
  assert.throws(() => { catalogue.weapons.m2hb.speed = 0; }, TypeError);
  assert.throws(() => { catalogue.weapons.m2hb.allowedAmmo.push('invented'); }, TypeError);
  assert.throws(() => { catalogue.mounts.pintle.exposed = false; }, TypeError);
  assert.throws(() => { catalogue.details.kinds.number.width = 99; }, TypeError);
  assert.equal(catalogue.weapons.m2hb.speed, weaponSettings(WEAPON_PRESETS.m2hb.family, { preset: 'm2hb' }).speed);
});

test('an explicit catalogue variant cannot change another consumer or the shared build data', () => {
  const catalogue = constructionCatalogue(), before = JSON.stringify(catalogue), variant = structuredClone(catalogue);
  variant.weapons.m2hb.speed = 1; variant.sensors.visual.cost = 0;
  assert.equal(JSON.stringify(constructionCatalogue()), before);
  assert.notEqual(variant.weapons.m2hb.speed, catalogue.weapons.m2hb.speed);
});
