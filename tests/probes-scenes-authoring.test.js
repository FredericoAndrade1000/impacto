import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { profileScene, probeJoint, probeConcentrated, probeDurability, probeExposed } from '../scripts/probes-scenes.ts';
await initNativeDynamics();

test('weapon profile is a real mounted authored construction', () => {
  const scene = profileScene('weapon'), source = scene.blueprint;
  assert.equal(source.version, DESIGN_VERSION);
  assert(source.plates.length >= 4);
  const weapon = source.components.find(part => part.kind === 'weapon');
  assert(Number.isFinite(weapon.pose.x) && Number.isFinite(weapon.pose.y) && Number.isFinite(weapon.pose.angle));
  assert.equal(Object.hasOwn(weapon.mount, 'hostId'), false);
  assert.equal(compileStructuredConstruction(source).modules.find(part => part.id === weapon.id).weaponMount.hostId, 'turret:front');
  assert(weapon.mount.preset);
  assert(!Object.hasOwn(source, 'rooms'));
  assert(!Object.hasOwn(source, 'modules'));
});

test('open independent-plate gap is rejected before scene admission; closed angled edges remain functional', () => {
  assert.throws(() => probeJoint({ thickness: 100, gap: .06, offset: 0 }), /encontro fechado/);
  const result = probeJoint({ thickness: 100, gap: 0, offset: 0 });
  assert(result.finite && result.partsPreserved);
  assert.equal(result.authoredPlateIds.length, 5);
  assert(result.authoredPlateIds.some(id => id.endsWith('hull:upper-front')));
  assert(result.authoredPlateIds.some(id => id.endsWith('hull:lower-front')));
  assert(result.outcome.length > 0, 'the measured shot still reaches the authored corner');
});

test('concentrated fire measures the named front wall and retains all authored parts', () => {
  const result = probeConcentrated({ preset: 'fnmag', count: 3 });
  assert.equal(result.shots, 3);
  assert.equal(result.requestedShots, 3);
  assert.equal(result.authoredPlateIds.length, 4);
  assert(result.finite && result.partsPreserved);
  assert(Number.isFinite(result.retained) && result.retained >= 0 && result.retained <= 1);
});

test('durability counts actual authored walls and preserves roof damage/motion gates', () => {
  const result = probeDurability({ preset: 'm242', ammo: 'ap' });
  assert.equal(result.authoredPlateCount, result.authoredPlateIds.length);
  assert.equal(new Set(result.authoredPlateIds).size, result.authoredPlateCount);
  assert.equal(result.attachedPlates, result.authoredPlateCount);
  assert(result.authoredPlateIds.some(id => id.endsWith('hull:roof')));
  assert(result.finite && result.partsPreserved && result.roofAttached);
  assert(result.roofIntegrity >= .75);
  assert(result.impacts >= 1);
  assert(result.peakY <= 1.5);
});

test('engine exposure uses a native ballistic opening, with clamped health and fixed installed mass', () => {
  const result = probeExposed({ kind: 'engine' });
  assert.equal(result.constructionVersion, DESIGN_VERSION);
  assert(result.finite && result.partsPreserved);
  assert.equal(result.samples.length, 6);
  assert(result.samples.some(sample => sample.health < result.maxHealth), 'real projectiles must damage the exposed engine');
  for (const [index, sample] of result.samples.entries()) {
    assert(sample.health >= 0 && sample.health <= result.maxHealth);
    assert(sample.partsPreserved && sample.attached !== false);
    assert.equal(sample.mountedMass, result.configuredMass);
    if (index) assert(sample.health <= result.samples[index - 1].health);
  }
});
