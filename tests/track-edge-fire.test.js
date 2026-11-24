import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrackEdge, mechanicalState } from '../scripts/probes-mobility.ts';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { face } from './damage-fixtures.js';
import { weaponSettings } from '../src/weapons.ts';
import { ownerState } from './mechanical-queries.js';
import { blueprintMass } from '../src/mass-properties.ts';

// The track comes with the chassis, under its tub: the sloped nose of the tub covers the upper half of the front curve
// of the track, and the lower half stands out. The bench names points of that half (`EDGE_POINTS`).

function assertFinite(result, launcher = result.point === 'floor-passage' ? result.launcher :
  { x: 1.65, y: result.point === 'chassis-overlap' ? 3 : .55 }) {
  assert.equal(result.thrown, null, `${result.preset}/${result.point}: physical state diverged`);
  // The world holds every plate written in the design, and the frame and the nose of its tracked chassis.
  assert.deepEqual([...result.authoredPlateIds].sort(),
    [...result.construction.plates.map(p => p.id), 'chassis:frame-0', 'chassis:nose', 'chassis:top-0'].sort(), 'retain every authored plate');
  assert.equal(new Set(result.authoredPlateIds).size, result.authoredPlateIds.length);
  assert.deepEqual(result.startGeometry.plates.map(p => p.id).sort(), [...result.authoredPlateIds].sort());
  assert.deepEqual(result.endGeometry.plates.map(p => p.id).sort(), [...result.authoredPlateIds].sort(),
    'keep all authored armour and mounted identities');
  assert.deepEqual(result.launcher, launcher, 'exercise the specified real firing position');
  assert.equal(result.accountedShots, result.shots, 'the energy budget includes every real muzzle event');
  assert(Number.isFinite(result.inputKineticJ) && result.inputKineticJ >= 0);
  assert(Number.isFinite(result.firedImpulse.x + result.firedImpulse.y));
  assert(Number.isFinite(result.peaks.kineticJ + result.peaks.speed + result.peaks.y));
  assert(result.peaks.dentLimitRatio <= 1 + 1e-6, 'local dents cannot grow beyond the material budget');
  assert.equal(result.start.recoveries, 0); assert.equal(result.end.recoveries, 0);
  assert.equal(result.invalidSolves, 0, 'the solver must accept every physical step without recovery');
  assert(result.partsPreserved, 'ballistic damage preserves construction identities');
  assert(Number.isFinite(result.start.carrier.mass + result.start.carrier.inertia));
  assert(result.start.carrier.mass > 0 && result.start.carrier.inertia > 0);
  assert.deepEqual(result.end.carrier, result.start.carrier, 'carrier body, mass and inertia stay fixed under damage');
  assert.equal(result.end.mass, result.start.mass);
  const contours = result.startGeometry.contactContours;
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3 &&
    contour.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))), 'the body has finite admitted contact polygons');
  assert.deepEqual(result.endGeometry.contactContours, contours,
    'ballistic apertures do not remove terrain support');
}

function assertArmourUnchanged(result) {
  // The compiler already opens the authored weapon port before any shot.
  // Preserve the former1% additional material-loss limit on that real base.
  for (const plate of result.endGeometry.plates) {
    const initial=result.startGeometry.plates.find(p=>p.id===plate.id);
    if (plate.id === 'chassis:nose' && result.events.some(e => e.plateId === plate.id)) continue; // The current nose lies behind this exposed curve.
    assert(plate.attached && plate.integrity>=initial.integrity-.01,
      `${plate.id}: an isolated gear shot must not damage remote armour`);
  }
}

function assertFloorPassage(result) {
  const stage = result.aperture, events = stage?.events || result.events,
    plates = (stage?.geometry || result.endGeometry).plates,
    layers = stage?.materialLayers || result.endMaterialLayers;
  const penetration = events.find(event => event.plateId === result.wallIds.floor && (event.type === 'penetration' ||
    event.type === 'secondary-impact' && event.result === 'penetration'));
  assert(penetration, 'a recorded primary or material ray must explicitly perforate the real floor');
  if (penetration.type === 'secondary-impact') {
    assert(penetration.spall && penetration.instantaneous);
    assert.equal(penetration.impulse, 0, 'an internal material ray must not add carrier momentum');
    assert(Number.isFinite(penetration.energy) && penetration.energy > 0);
  }
  const floor = plates.find(p => p.id === result.wallIds.floor),
    originalFloor = result.startGeometry.plates.find(p => p.id === result.wallIds.floor);
  assert(floor && originalFloor, 'both views contain the identified authored floor');
  assert(floor.area < originalFloor.area, 'the floor loses actual ballistic material');
  assert(result.initialMaterialLayers.some(hit => hit.plateId === result.wallIds.floor), 'the undamaged shot chord crosses the floor');
  assert(!layers.some(hit => hit.plateId === result.wallIds.floor), 'native material queries must see a complete floor passage along the shot chord');
}

function assertClosedImpactEnergy(result) {
  // No motor input or explosion supplies mechanical energy. Conservatively
  // allow 10% integration error and eight centimetres of gravitational work
  // for the complete calculated vehicle mass, including initial settling.
  const budget = result.inputKineticJ * 1.1 + result.start.kineticJ + result.start.mass * 9.81 * 0.08 + 2_000;
  for (const [name, energy] of [['end-of-tick', result.peaks.kineticJ],
    ['before native solve', result.peaks.preNativeKineticJ],
    ['after native solve', result.peaks.postNativeKineticJ]]) {
    assert(energy <= budget,
      `${result.preset}/${result.point} ${name}: ${energy} J exceeds physical input allowance ${budget} J`);
  }
}

// Every point of the curve once; half of them hit at once, the others after the tank settled.
for (const [point, settle] of [['image-marker', 0], ['middle-curve', 60], ['lower-curve', 0], ['lower-tip', 60],
  ['left-neighbour', 0], ['right-neighbour', 60]]) {
  test(`RH120 AP: ${point}, settled ${settle} ticks, cannot create energy or launch the complete tank`, () => {
    const result = runTrackEdge({ point, settle });
    assertFinite(result);
    const hit = result.events.find(e => e.type === 'module');
    assert.equal(hit?.module, 'track', 'the exposed curve is hit, not a different hull plate');
    assert.equal(result.stats.explosions, 0);
    assertClosedImpactEnergy(result);
    assert(result.peaks.speed < 6, 'a stopped projectile does not launch the complete vehicle at tens of metres per second');
    assert(result.peaks.y < result.start.vehicle.y + 1,
      'a local curved-casing impact does not throw the chassis tens of metres skyward');
    assert(result.endGeometry.track.health < result.startGeometry.track.health,
      'resistance does not suppress real functional damage');
    assertArmourUnchanged(result);
  });
}

// Each gun a single round and a burst, on the three points of the curve between them.
for (const [preset, point, burst] of [['fnmag', 'image-marker', false], ['fnmag', 'lower-curve', true],
  ['m2hb', 'lower-tip', false], ['m2hb', 'image-marker', true]]) {
  test(`${preset} ${burst ? 'burst' : 'single'}: the exposed ${point} curve remains a stable support`, () => {
    const result = runTrackEdge({ preset, point, burst, settle: burst ? 60 : 0,
      seconds: burst ? 2.5 : 1.5 });
    assertFinite(result);
    assert(result.events.some(e => e.type === 'module' && e.module === 'track'));
    assertClosedImpactEnergy(result);
    assert.equal(result.stats.explosions, 0);
    assert(result.peaks.speed < 1);
    assert(result.peaks.y < result.start.vehicle.y + 0.08);
    assert(result.endGeometry.track.attached, 'local functional damage preserves uncut casing supports');
    assertArmourUnchanged(result);
    if (burst) {
      assert(result.shots >= (preset === 'fnmag' ? 21 : 18), 'use actual cadence through the subsequent physical casing');
      assert(result.endGeometry.track.health > result.startGeometry.track.maxHealth * 0.75 &&
        result.endGeometry.track.health < result.startGeometry.track.health,
      'short MG bursts leave the track operational but damaged');
    }
  });
}

for (const [point, settle] of [['image-marker', 0], ['lower-curve', 60], ['lower-tip', 0]]) {
  test(`M242 AP: a ${point} hit after ${settle} settling ticks deforms/damages the gear without launching its carrier`, () => {
    const result = runTrackEdge({ preset: 'm242', point, settle });
    assertFinite(result);
    assert(result.events.some(e => e.type === 'module' && e.module === 'track'));
    assertClosedImpactEnergy(result);
    assert.equal(result.stats.explosions, 0);
    assert(result.peaks.speed < 2);
    assert(result.peaks.y < result.start.vehicle.y + 0.25);
    assert(result.endGeometry.track.health < result.startGeometry.track.health * 0.95,
      'a peripheral strike causes meaningful local functional damage without requiring an instant total failure');
    assert(result.endGeometry.track.attached);
  });
}

for (const preset of ['m242', 'rh120', 'at4']) {
  test(`${preset} HE: a real explosion against the upper curve keeps material/contact motion finite`, () => {
    const result = runTrackEdge({ preset, ammo: 'he', settle: 60 });
    assertFinite(result);
    assert(result.stats.explosions >= 1, 'the explosive loadout must actually detonate');
    assert(result.peaks.speed < 20);
    assert(result.peaks.y < result.start.vehicle.y + 5);
    assert(result.peaks.kineticJ < 30_000_000,
      'allow substantial explosive work without accepting a numerical megaspring launch');
  });
}

for (const preset of ['fnmag', 'm2hb', 'm242', 'rh120']) {
  test(`${preset}: subsequent rounds along real front/floor apertures do not destabilize the curved track casing`, () => {
    const result = runTrackEdge({ preset, point: 'chassis-overlap', settle: 60,
      prepareHole: true, burst: preset !== 'rh120' });
    assertFinite(result);
    assert(result.aperture.events.some(e => e.plateId === result.wallIds.front), 'the preparation actually perforates the front');
    assertFloorPassage(result);
    assert(result.shots >= 2, 'shoot the damaged geometry again after it has cooled');
    assert(result.events.some(e => e.time >= result.aperture.state.time &&
      (e.type === 'module' && e.module === 'track' || ['blocked', 'penetration'].includes(e.type))),
    'later bullets collide with surviving real geometry');
    assertClosedImpactEnergy(result);
    assert.equal(result.stats.explosions, 0);
    assert(result.peaks.speed < 8);
    assert(result.peaks.y < result.start.vehicle.y + 2);
  });
}

test('one front/floor perforation cannot create a delayed launch when its cooled wreckage makes contact', () => {
  const result = runTrackEdge({ point: 'chassis-overlap', settle: 60, seconds: 4 });
  assertFinite(result);
  assert.equal(result.shots, 1, 'isolate settling/contact from a second projectile');
  assert(result.events.some(e => e.type === 'penetration' && e.plateId === result.wallIds.front));
  assertFloorPassage(result);
  assert.equal(result.stats.explosions, 0);
  assertClosedImpactEnergy(result);
  assert(result.peaks.speed < 8, 'cooling and contact must not act as an artificial motor');
  assert(result.peaks.y < result.start.vehicle.y + 2);
});

for (const prepareHole of [false, true]) {
  test(`${prepareHole ? 'FN MAG follow-up' : 'RH120 AP'}: a vertical primary floor passage preserves the settled carrier`, () => {
    const result = runTrackEdge({ point: 'floor-passage', preset: prepareHole ? 'fnmag' : 'rh120',
      settle: 60, seconds: 4, prepareHole });
    assertFinite(result);
    assert.equal(result.benchSelection.kind, 'admitted-roof-floor-track-column');
    assert(Math.abs(result.launcher.x - result.aim.x) < 1e-10, 'the measured bench chord is vertical');
    assert(!result.initialMaterialLayers.some(hit => hit.module && hit.module !== 'track'),
      'the real column does not accidentally hit the mounted barrel or internal containers');
    assert.equal(result.shots, prepareHole ? 2 : 1);
    const initialHits = result.aperture?.events || result.events;
    const roofHit = initialHits.find(event => event.plateId === result.benchSelection.roofId &&
      (event.type === 'penetration' || event.type === 'secondary-impact' && event.result === 'penetration'));
    assert(roofHit, 'the roof loses real material along the vertical passage');
    // Under a tower the roof of the hull is the tower's floor: the first impact
    // may send a material ray through it before the primary reaches it.
    if (roofHit.type === 'secondary-impact') {
      assert(roofHit.spall && roofHit.instantaneous); assert.equal(roofHit.impulse, 0);
      assert(roofHit.energy > 0);
    }
    // The track stands under the floor and the frame of its chassis: the material rays of the roof may open both ahead
    // of the primary, which crosses them by that opening and perforates the track under them.
    assert(initialHits.some(event => event.type === 'penetration' && event.moduleId === result.benchSelection.trackId),
      'the same primary crosses the floor to the track under it');
    assertFloorPassage(result);
    assert(result.endGeometry.track.health < result.startGeometry.track.health,
      'the through-carrier shot causes real running-gear damage');
    if (prepareHole) assert(result.events.some(event => event.time >= result.aperture.state.time &&
      event.type === 'penetration' && event.module === 'track'),
    'the later MG round crosses the real plate openings and reaches surviving gear material');
    assertClosedImpactEnergy(result);
    assert.equal(result.stats.explosions, 0);
    assert(result.peaks.speed < 8);
    assert(result.peaks.y < result.start.vehicle.y + 2);
  });
}

test('energy/mass telemetry counts the installed track once before and after a local hit', t => {
  const world = new World(createConstruction('heavy')); t.after(() => world.dispose());
  const before = mechanicalState(world), track = world.modules.find(m => m.kind === 'track'),
    initialCarrier = ownerState(world, track);
  assert(Math.abs(before.mass - blueprintMass(world.blueprint)) < .01);
  world.fire({ x: 9.5, y: .6 }, weaponSettings('cannon', { preset: 'rh120', ammo: 'ap', spread: 0 }), true); world.step();
  const record = ownerState(world, track);
  assert(record?.state.dynamic);
  assert(record.state.mass > 1000, 'the complete carrier retains its physical mass');
  assert.equal(record.body, initialCarrier.body);
  assert.equal(record.body, ownerState(world, world.plates[0]).body, 'track and armour share one carrier');
  assert.equal(record.state.mass, initialCarrier.state.mass);
  assert.equal(record.state.inertia, initialCarrier.state.inertia);
  assert(Math.abs(mechanicalState(world).mass - before.mass) < .01);
  assert.equal(world.dynamics.recoveries || 0, 0);
});
