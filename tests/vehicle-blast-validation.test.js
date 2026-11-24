import { withRaisedFloor } from './helpers/designs.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessVehicleBlast } from '../scripts/probes-impact.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { chassisSpec, frameThicknessMm } from '../src/chassis.ts';

const health = (row, kind) => row.modules.find(m => m.kind === kind).health;
// Permanent hull/chassis mass remains; measured component masses include expended reserves and burnt interiors.
function structurePreserved(row) {
  assert(Math.abs(row.structureMassAfter - row.structureMassBefore) < 1e-6 && row.carrierMassAfter <= row.carrierMassBefore);
}
function stableCarrier(row) {
  assert(row.finite && row.partsPreserved && row.restored && row.unchanged);
  assert(row.peaks.height < .02 && row.peaks.speed < .3);
  assert(row.plates.every(p => p.attached));
  structurePreserved(row);
}
function throughColumns(grid) {
  const bytes = Buffer.from(grid.bits, 'hex'); let empty = 0;
  for (let x = 0; x < grid.nx; x++) {
    let material = false;
    for (let y = 0; y < grid.ny; y++) {
      const i = y * grid.nx + x;
      material ||= Boolean(bytes[i >> 3] & (1 << (i & 7)));
    }
    empty += !material;
  }
  return empty;
}
function centralMaterialPreserved(before, after) {
  assert.equal(after.nx, before.nx); assert.equal(after.ny, before.ny);
  assert.deepEqual(after.bounds, before.bounds);
  const old = Buffer.from(before.bits, 'hex'), current = Buffer.from(after.bits, 'hex'),
    length = before.bounds.maxX - before.bounds.minX, cellWidth = length / before.nx;
  // Stock plate ends can protrude beyond their neighbours. This charge may
  // crater those tips, but must not eat through the protected middle of a wall.
  const endBandM = Math.min(.22 + cellWidth, length / 4);
  for (let y = 0; y < before.ny; y++) for (let x = 0; x < before.nx; x++) {
    const i = y * before.nx + x, bit = 1 << (i & 7);
    if ((old[i >> 3] ^ current[i >> 3]) & bit)
      assert(Math.min(x + .5, before.nx - x - .5) * cellWidth <= endBandM,
        'secondary damage remains confined to exposed stock ends');
  }
}
for (const location of ['front', 'rear', 'roof', 'track']) test(`600-power external blast at ${location}: stock damage preserves the rigid carrier`, () => {
  const row = assessVehicleBlast({ location, power: 600, radius: 4.5, seconds: 3 });
  stableCarrier(row); assert.equal(row.stats.explosions, 1, 'there is no unobserved reserve detonation');
  // The charge opens the exposed thin wall. At the running gear the current
  // stock section has a 35 mm nose, which is vulnerable too; its 20 mm frame lies under the floor of the hull, on the
  // cell nearest to lying flush on it, which covers most of its depth, and only the stock end of the floor ahead of
  // the front may crater. Its thicker hull must continue to protect the live internal equipment.
  const damagedWalls = { front: ['hull:front'], rear: ['hull:rear'], roof: ['turret:roof'],
    track: ['chassis:nose'] }[location];
  for (const plate of row.plates) {
    const before = row.preBlastPlates.find(p => p.id === plate.id);
    if (damagedWalls.includes(plate.id)) {
      assert(plate.integrity < before.integrity, '600-power HE really removes native material from the exposed wall');
      if(location==='front')assert(row.stats.spallBursts>0 && row.stats.secondaryComponentHits>0,
        'the stronger front loses rear-facing material and emits real internal flakes before complete perforation');
      else assert(throughColumns(plate.ballisticGrid) > throughColumns(before.ballisticGrid),
        'the explosion creates a new opening through the actual native thickness grid');
    } else centralMaterialPreserved(before.ballisticGrid, plate.ballisticGrid);
  }
  assert(health(row, 'engine') > 0 && health(row, 'ammo') > 0, 'the carrier still contains live protected internals');
  if (location === 'rear') assert(health(row, 'engine') < .95 && row.stats.secondaryComponentHits > 0,
    'the perforated rear exposes the engine to real instantaneous fragments');
  if (location === 'roof') assert(health(row, 'weapon') < .95 && health(row,'ammo') > .95 && row.stats.secondaryComponentHits > 0,
    'the perforated turret roof exposes its receiver while the separate hull still protects ammunition');
  if (location === 'track') assert.equal(health(row, 'track'), 0, 'exposed running gear receives a real functional failure');
});

for (const location of ['front', 'rear', 'roof', 'track']) test(`600-power external blast at ${location}: explicitly reinforced armour retains protection`, () => {
  const construction = withRaisedFloor(createConstruction('heavy'), 125);
  // Thicker floor and ceiling stock need headroom for the original engine, and the thicker rear a hand of room behind it.
  const floorY = Math.min(...construction.nodes.map(node => node.y));
  for (const node of construction.nodes) if (node.y > floorY + 1) node.y += 2;
  for (const part of construction.components) if (['weapon', 'sensor'].includes(part.kind)) part.pose.y += 2;
  construction.components.find(part => part.kind === 'engine').pose.x -= 2;
  // This is an authored protection experiment, not a change to the stock
  // template: 125 mm hull/turret walls and a 90 mm structural section resist
  // this HE load. The section also authors its thicker sloping nose.
  for (const plate of construction.plates) plate.thicknessMm = 125;
  construction.chassis.topPlate.thicknessMm = 125;
  for (const node of construction.nodes) if (node.id.startsWith('turret-top-')) node.y += 6;
  construction.chassis.thicknessMm = 90;
  // Thickening a roof no longer moves equipment implicitly. This assay also
  // explicitly raises the two exterior instruments clear of that new metal.
  for (const part of construction.components)
    if (part.kind === 'sensor' && part.id !== 'sensor-vision') part.pose.y += 7; // cells: 35 cm
  // The thicker bay must fit its actual tube sweep; this protection assay
  // narrows the sector instead of forcing an invalid stock mounting through it.
  construction.components.find(part=>part.kind==='weapon').mount.sector={min:-.1,max:.1};
  construction.components.find(part=>part.kind==='weapon').pose.x += .5;
  const row = assessVehicleBlast({ construction, location, power: 600, radius: 4.5, seconds: 3 });
  stableCarrier(row);
  // The authored frame gauge scales both structural plates. The actual metal
  // at the corners protects their buried faces as well as the hull walls.
  const spec = chassisSpec(construction.chassis.model), frameMm = frameThicknessMm(construction.chassis),
    noseMm = spec.noseMm * frameMm / spec.frameMm;
  for (const plate of row.plates) {
    assert.equal(plate.thicknessMm, { 'chassis:frame-0': frameMm, 'chassis:nose': noseMm }[plate.id] ?? 125);
    const before = row.preBlastPlates.find(p => p.id === plate.id);
    assert(plate.integrity > .98);
    // The mandatory weapon already occupies an authored opening with a
    // protective mantlet. A blast must not create any additional lost cells.
    assert.deepEqual(plate.ballisticGrid, before.ballisticGrid);
  }
  assert(health(row, 'engine') > (location === 'rear' ? .85 : .9) && health(row, 'ammo') > .9);
  assert.equal(row.stats.spallBursts, 0, 'this armour load does not reach the rear-flaking or perforation regime');
  if (location === 'track') assert.equal(health(row, 'track'), 0, 'reinforced walls still leave exposed gear vulnerable');
});

test('internal blast damages modules, detonates ammunition once and leaves fuel burning without ongoing pressure', () => {
  const row = assessVehicleBlast({ location: 'internal', power: 600, radius: 4.5, seconds: 8 });
  assert.equal(row.stats.explosions, 2); assert.deepEqual(row.detonationCounts, { fuel: 0, ammo: 1 });
  assert(row.modules.find(m => m.kind === 'fuel').burning, 'remaining fuel keeps burning after the tank fails');
  assert.equal(health(row, 'engine'), 0); assert.equal(health(row, 'ammo'), 0);
  assert(row.peaks.height < .03);
  structurePreserved(row);
  assert(row.carrierMassAfter < row.carrierMassBefore - 20, 'burnt fuel and detonated rounds are no longer carried');
  assert(row.restored && row.unchanged && row.finite);
});

test('a preformed ballistic opening preserves the mass of the structure without storing gas pressure', () => {
  const closed = assessVehicleBlast({ location: 'internal', power: 600, radius: 4.5 }),
    vent = assessVehicleBlast({ location: 'internal', power: 600, radius: 4.5, vent: true });
  assert(vent.preBlastAreaM2 < closed.preBlastAreaM2, 'the actual ballistic aperture remains open');
  for (const row of [closed, vent]) {
    assert(!Object.hasOwn(row, 'gasPressureTimeKPaSeconds'));
    structurePreserved(row);
    assert.equal(health(row, 'engine'), 0); assert.equal(health(row, 'ammo'), 0);
  }
  assert(vent.finite && vent.restored); assert.equal(vent.stats.explosions, 2);
});

test('an external blast disables a moving track on a reinforced chassis while preserving grounded wreckage and inertia', () => {
  // Isolate losing the track from perforating the structural frame: this
  // vehicle explicitly carries the same 40 mm section as the protection assay.
  const construction = createConstruction('heavy'); construction.chassis.thicknessMm = 40;
  // Remove the stock floor overhang so that the nose covers its whole end.

  const row = assessVehicleBlast({ construction, location: 'track', terrain: 'hills', throttle: .65, seconds: 5 });
  assert.equal(health(row, 'track'), 0); assert.equal(row.end.traction, 0);
  // With its track gone the wreck coasts on up the slope, and then rolls back down it.
  const furthest = Math.max(...row.trace.map(sample => sample.x));
  assert(furthest > row.start.x + 1 && row.end.x < furthest - .1, 'the disabled vehicle coasts uphill and then rolls back');
  assert(row.peaks.speed < 6);
  assert(row.finite);
  // The nose and the frame of the chassis stand between this lighter blast and the floor of the hull: the track is
  // lost, and no wall is.
  for (const plate of row.plates) {
    assert(plate.attached);
    assert.deepEqual(plate.ballisticGrid,
      row.preBlastPlates.find(p => p.id === plate.id).ballisticGrid, 'the walls retain their ballistic material');
  }
  structurePreserved(row);
  assert(row.partsPreserved && row.unchanged && row.restored);
});
