import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { Terrain } from '../src/terrain.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { physics, setVehicle, freewheel, advance } from './mechanical-queries.js';

const gear = world => world.modules.filter(m => ['wheel', 'track'].includes(m.kind));
const grounded = world => gear(world).some(m => m.groundContact);
function fixture(t, design, height, surface = null) {
  const world = new World(createConstruction(design), { visualEvents: false });
  t.after(() => world.dispose());
  world.terrain = new Terrain('rough');
  for (const p of world.terrain.points) p.y = Math.fround(height(p.x));
  if (surface) world.terrain.sectors = [{ start: -1600, end: 1600, surface }];
  world.game(); return world;
}
function boundedPhysics(world) {
  const state = physics(world);
  assert.equal(state.bodies, 1);
  assert.equal(state.colliders, 2, 'one fixed compound for the vehicle and one terrain collider');
  assert.equal(state.recoveries, 0);
}

// The crest stands between the axles of the scout, 3.35 m apart on tyres of 0.95 m, with 11 cm between its flanks and
// either tyre, and 28 cm under the rails of the chassis. The ground is concrete, with no bumps over its line: the rims
// come to rest on the line itself.
for (const drop of [.1, 3]) test(`a crest below the scout floor cannot suspend its wheels after a ${drop} m drop`, t => {
  const world = fixture(t, 'scout', x => .35 * Math.min(1, Math.max(0, (1.3 - Math.abs(x - 12)) / .5)), 'concrete');
  const health = () => gear(world).map(m => [m.id, m.health]), initialHealth = health(),
    material = () => world.plates.map(p => [p.id, p.remainingArea, p.integrity, p.revision]), initialMaterial = material(),
    installed = () => [...world.plates, ...world.modules].map(p => [p.id, p.attached]), initialInstalled = installed(),
    properties = () => physics(world).bodyStates.map(b => [b.handle, b.mass, b.inertia]), initialProperties = properties(),
    contours = structuredClone(world.actor().contactContours);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  setVehicle(world, { y: world.vehicle.y + .35 + drop });
  advance(world, 360);
  assert(Math.abs(world.vehicle.x - 12) < .02);
  assert(Math.abs(world.vehicle.y - 1.3) < .025, 'support comes from the wheels, not a filled gap between them');
  assert.equal(gear(world).filter(m => m.groundContact).length, 2);
  t.diagnostic(JSON.stringify({ drop, healthBefore: initialHealth, healthAfter: health(), traction: world.vehicle.traction }));
  if (drop === .1) {
    assert.deepEqual(health(), initialHealth, 'the small drop is absorbed without injury');
    assert.equal(world.vehicle.traction, 1);
  } else {
    assert(gear(world).every(m => m.health < m.maxHealth && m.marks.length > 0), 'the violent landing leaves real damage in the gear');
    const condition = gear(world).map(m => m.health / m.maxHealth);
    assert(world.vehicle.traction >= Math.min(...condition) && world.vehicle.traction <= Math.max(...condition) &&
      world.vehicle.traction < 1, 'support remains physical and traction reflects the surviving gear condition');
    assert(world.plates.some(p => p.dents.size > 0), 'the overloaded support retains a dent');
  }
  for (const wheel of gear(world)) {
    const gap = wheel.y - wheel.height / 2 - world.terrain.height(wheel.x);
    assert(Math.abs(gap) < .001, `the wheels rest with their rims on the ground: ${gap}`);
  }
  assert.deepEqual(material(), initialMaterial, 'landing cannot erode the ballistic material');
  assert.deepEqual(installed(), initialInstalled);
  assert.deepEqual(properties(), initialProperties, 'functional damage preserves carrier mass and inertia');
  assert.deepEqual(world.actor().contactContours, contours);
  boundedPhysics(world);
});

test('a crest reaching the scout floor still supports the real hull and removes wheel traction', t => {
  const world = fixture(t, 'scout', x => .95 * Math.min(1, Math.max(0, (1.5 - Math.abs(x - 12)) / .5)));
  setVehicle(world, { y: world.vehicle.y + 1.05 });
  advance(world, 360);
  const rail = world.plates.find(p => p.definition.chassis?.part === 'rail'),
    floorGap = rail.bounds.minY - world.terrain.height(world.vehicle.x);
  assert(floorGap >= 0 && floorGap < .025, 'the actual lower rail rests on the crest within the contact skin');
  assert(Math.abs(world.vehicle.angle) < .01);
  for (const wheel of gear(world)) {
    assert.equal(wheel.health, wheel.maxHealth);
    assert(wheel.y - wheel.height / 2 - world.terrain.height(wheel.x) > .1, 'the rims are physically above the ground');
  }
  assert.equal(gear(world).filter(m => m.groundContact).length, 0);
  assert.equal(world.vehicle.traction, 0);
  boundedPhysics(world);
});

test('a tilted scout can touch down on one axle without gripping and pivoting over that wheel', t => {
  for (const speed of [-12, 12]) {
    const world = fixture(t, 'scout', () => 0), angle = -.15 * Math.sign(speed);
    setVehicle(world, { y: world.vehicle.y + 1.5, vx: speed, vy: 0, angle, omega: 0 });
    let first = null, peakPitch = 0;
    for (let frame = 0; frame < 180; frame++) {
      world.step();
      peakPitch = Math.max(peakPitch, Math.abs(world.vehicle.angle));
      if (grounded(world) && !first) first = world.vehicle.vx;
    }
    assert(first && first * Math.sign(speed) > Math.abs(speed) * .98);
    assert(peakPitch < .35, 'a small initial pitch must not cause an artificial roll');
    boundedPhysics(world);
  }
});

for (const design of ['scout', 'heavy']) for (const slope of [.2, -.2])
  test(`${design} let go of on a ${slope * 100}% grade stays where it was left`, t => {
    const world = fixture(t, design, x => slope * (x - 12)),
      still = () => Math.hypot(world.vehicle.vx, world.vehicle.vy) < .001;
    advance(world, 120);
    const left = world.vehicle.x;
    advance(world, 600);
    assert(Math.abs(world.vehicle.x - left) < .001 && still(), 'ten seconds on the grade move it by nothing');
    // Driven along the grade and let go of, it brakes to a stop of itself and stays there as well.
    world.controlVehicle(1); advance(world, 120); world.controlVehicle(0); advance(world, 600);
    const stopped = world.vehicle.x;
    assert(Math.abs(stopped - left) > 1 && still());
    advance(world, 600);
    assert(Math.abs(world.vehicle.x - stopped) < .001 && still());
    boundedPhysics(world);
  });

for (const design of ['scout', 'heavy']) for (const slope of [0, .2, -.2])
  test(`${design} lands on a ${slope * 100}% grade without wheel friction braking or forced uprighting`, t => {
    for (const speed of [-25, -12, 12, 25]) {
      // On ground that shakes nothing, and its wheels free, so that what the contact takes is not mistaken for what rough
      // ground takes of a fast vehicle, or for the brake of a vehicle let go of.
      const world = fixture(t, design, x => slope * (x - 12), 'concrete'), angle = Math.atan(slope);
      freewheel(world);
      setVehicle(world, { y: world.vehicle.y + 1.5, angle, vx: speed, vy: 0, omega: 0 });
      // Holding the opposite key now brakes: keep this contact-only fixture rolling its own way.
      world.controlVehicle(Math.sign(speed), 0);
      let first = null, peakPitch = 0;
      for (let frame = 0; frame < 180; frame++) {
        const before = { vx: world.vehicle.vx, vy: world.vehicle.vy };
        world.step(); const v = world.vehicle;
        peakPitch = Math.max(peakPitch, Math.abs(v.angle - angle));
        if (grounded(world) && !first) first = { ...before, afterVx: v.vx, afterVy: v.vy, frame };
      }
      assert(first && first.frame > 0, 'a genuinely airborne vehicle must touch down');
      const before = (first.vx + slope * first.vy) / Math.hypot(1, slope),
        after = (first.afterVx + slope * first.afterVy) / Math.hypot(1, slope);
      assert(Math.abs(before - after) < .08, 'contact preserves tangential velocity apart from ordinary gravity/drag');
      if (!slope) assert(first.afterVx * Math.sign(speed) > Math.abs(speed) * .98);
      // An uphill impact may rock the rigid track on one end before its whole
      // base settles. It must remain upright and naturally recover the grade.
      assert(peakPitch < Math.PI / 4, `ordinary landing must remain upright: ${peakPitch}`);
      assert(Math.abs(world.vehicle.angle - angle) < .02, 'the carrier settles on the contact tangent');
      boundedPhysics(world);
    }
  });
