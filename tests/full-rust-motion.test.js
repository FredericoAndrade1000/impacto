import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { wheelPhysics, setPart, setVehicle, flyRound, managedWorld, advance } from './mechanical-queries.js';
import { mechanicalState, NativeAudit } from '../scripts/review-harness.ts';

for (const terrain of ['flat', 'mud', 'sand', 'mixed', 'rough', 'hills'])
  test(`persistent Rust running gear traverses ${terrain} terrain with finite suspension and no recovery`, t => {
    const design = createConstruction('scout'); design.terrain = terrain;
    const world = managedWorld(t, design, { visualEvents: false }), start = world.vehicle.x;
    advance(world, 60); world.controlVehicle(1); advance(world, 120);
    const v = world.vehicle;
    assert([v.x, v.y, v.angle, v.vx, v.vy, v.omega].every(Number.isFinite));
    assert(v.x > start + .2, 'the input actually moves the construction');
    assert.equal(world.dynamics.recoveries, 0);
    assert(world.modules.filter(m => m.kind === 'wheel').every(m =>
      [m.suspension.travel, m.suspension.displacement, m.suspension.compression].every(Number.isFinite)));
  });

for (const template of ['scout', 'heavy'])
  test(`airborne ${template} running gear hangs freely through sideways and inverted hull rotations`, t => {
    const source = createConstruction(template), world = managedWorld(t, source, { visualEvents: false }),
      gear = () => world.modules.filter(m => m.kind === 'wheel' || m.kind === 'track'),
      local = m => {
        const v = world.vehicle, c = Math.cos(v.angle), s = Math.sin(v.angle), dx = m.x - v.x, dy = m.y - v.y;
        return { x: c * dx + s * dy, y: -s * dx + c * dy };
      };
    for (const facing of [-1, 1]) {
      world.replaceActor(source, { id: 'local', facing });
      const supported = () => {
        assert(world.vehicle.traction > .99);
        assert(gear().every(m => m.groundContact && m.suspension.compression > 0 && m.suspension.compression < m.suspension.travel));
      };
      advance(world, 180); supported();
      const stood = { x: world.vehicle.x, y: world.vehicle.y, angle: world.vehicle.angle, vx: 0, vy: 0, omega: 0 };
      setVehicle(world, { x: 12, y: 100, angle: 0, vx: 0, vy: 0, omega: 0 });
      advance(world);
      const hanging = gear().map(local);
      const check = () => gear().forEach((m, i) => {
        const at = local(m), message = `${facing}: hull at ${world.vehicle.angle} rad`;
        assert(Math.abs(m.suspension.displacement + m.suspension.travel / 3) < 1e-10, message);
        assert(Math.abs(m.suspension.compression) < 1e-10, message);
        assert(Math.hypot(at.x - hanging[i].x, at.y - hanging[i].y) < 1e-9, `the axle stays fixed in its unloaded hull frame: ${message}`);
        assert(!m.groundContact, message);
      });
      for (const direction of [-1, 1]) {
        for (const degrees of [0, 89.9, 90, 90.1, 179.9, 180, 180.1, 269.9, 270, 270.1, 360]) {
          setVehicle(world, { angle: direction * degrees * Math.PI / 180 });
          check();
        }
        setVehicle(world, { angle: 0, omega: direction * 9 });
        for (let step = 0; step < 60; step++) { advance(world); check(); }
      }
      // Let the hull land on its roof, then put it back on its gear. Real ground contact must
      // unload the inverted springs and resume carrying the upright hull without retained state.
      setVehicle(world, { x: stood.x, y: 5, angle: Math.PI, vx: 0, vy: 0, omega: 0 });
      advance(world, 240); check(); assert.equal(world.vehicle.traction, 0);
      setVehicle(world, stood); advance(world, 240); supported();
      assert.equal(world.dynamics.recoveries, 0);
    }
  });

test('persistent Rust soft-ground load can stall a partly throttled scout without a scripted drive override', t => {
  // On its two pairs of 0.95 m tyres the scout presses some 240 kPa on mud that bears 100: rolling takes 0.126 of its
  // weight and the mud holds 0.194 of it. The throttle asks for its share of what the drivetrain pulls, at a standstill
  // as it pulls at 1.5 m/s (game_motion.rs `SLIP_SPEED`), the ground holding what it holds: on less of the throttle
  // than rolling takes of that, it does not move.
  const design = createConstruction('scout'); design.terrain = 'mud';
  const world = managedWorld(t, design, { visualEvents: false }), start = world.vehicle.x, v = world.vehicle;
  advance(world, 60);
  const d = v.drivetrain, pull = Math.min(d.maxDriveForce, d.powerKw * 1000 * d.efficiency / 1.5);
  world.controlVehicle(.85 * v.groundResistance * v.mass * 9.81 / pull); advance(world, 120);
  assert.equal(world.vehicle.groundSurface, 'mud');
  assert(world.vehicle.groundPressureKPa > 200);
  assert(world.vehicle.groundResistance > .1);
  assert(Math.abs(world.vehicle.x - start) < .02);
  assert(Math.abs(world.vehicle.vx) < .01);
  assert.equal(world.dynamics.recoveries, 0);
});

test('a loaded lorry with a worn engine stands in sand with its wheels turning, says what holds it, and drives off two fifths of its load lighter', t => {
  const design = createConstruction('truck'); design.terrain = 'sand';
  const world = managedWorld(t, design, { visualEvents: false }), hopper = world.modules.find(m => m.kind === 'hopper'), engine = world.modules.find(m => m.kind === 'engine'),
    wheels = () => world.modules.filter(m => m.kind === 'wheel'), spin = () => wheels().map(m => m.wheelSpin);
  // Empty, it pulls more than the sand holds under so little weight: its wheels slip as it sets off flat out, and it makes way.
  advance(world, 60); world.controlVehicle(1); advance(world, 60);
  assert(world.vehicle.vx > 1); assert.deepEqual([world.vehicle.stuck, world.vehicle.slip > 0], [null, true]);
  world.controlVehicle(0, 1); advance(world, 120);
  // Full of iron, its engine worn until it pulls 85 % of what rolling over the sand then takes: it stands, though the
  // bumps of the sand (game_terrain.rs `Bumps`) tilt the ground under it a little. On four pairs of 1.25 m tyres the
  // sand bears it at some 300 kPa, and two fifths of the load less takes a third less: more than it must pull past to
  // dig itself out.
  setPart(world, hopper, { cargo: { ferro: 1e9 } }); advance(world, 30);
  const sand = world.vehicle.groundResistance * world.vehicle.mass * 9.81;
  setPart(world, engine, { health: engine.maxHealth * .85 * sand / world.vehicle.drivetrain.maxDriveForce }); advance(world, 30);
  const full = hopper.cargo.ferro, x = world.vehicle.x, before = spin();
  world.controlVehicle(1); advance(world, 120);
  const v = world.vehicle, turned = spin().map((angle, i) => angle - before[i]);
  assert(v.groundResistance * v.mass * 9.81 > v.drivetrain.maxDriveForce, 'the sand takes more than the drivetrain pulls');
  assert(Math.abs(v.x - x) < .02 && Math.abs(v.vx) < .01, 'it stands');
  // Its wheels turn all the same, at the speed its drivetrain slips, and its core says why it stands. On its springs
  // over the bumps it rocks by a few millimetres a second.
  const slipping = (vehicle, slip) => vehicle.stuck === 'ground' && Math.abs(vehicle.slip - slip) < .005;
  assert(slipping(v, 1.5), `${v.stuck} ${v.slip}`);
  for (const [i, wheel] of wheels().entries()) {
    assert(Math.abs(turned[i] + 1.5 * 2 / (wheel.height / 2)) < .2, `two seconds of it: ${turned[i]}`);
    assert(Math.abs(wheel.wheelAngularSpeed + 1.5 / (wheel.height / 2)) < .05);
  }
  assert(slipping(world.snapshot().actors[0].vehicle, 1.5), 'and the frame carries both');
  // Backwards it is the same, the other way round.
  world.controlVehicle(-1); advance(world, 30); assert(slipping(world.vehicle, -1.5), `${world.vehicle.stuck} ${world.vehicle.slip}`);
  // Two fifths of the load tipped out, the same engine takes it on.
  setPart(world, hopper, { cargo: { ferro: full * .6 } }); world.controlVehicle(1); advance(world, 240);
  assert(world.vehicle.x > x + .5 && world.vehicle.vx > .3, `it drives off: ${world.vehicle.x - x} m`); assert.equal(world.vehicle.stuck, null);
  assert.equal(world.dynamics.recoveries, 0);
});

test('persistent Rust brake and destroyed engine dissipate a cold initial velocity', t => {
  const world = managedWorld(t, createConstruction('scout'), { visualEvents: false });
  world.vehicle.vx = 8;
  const engine = world.modules.find(m => m.kind === 'engine');
  setPart(world, engine, { health: 0 });
  const before = mechanicalState(world).kineticJ;
  world.controlVehicle(1, 1); advance(world, 180);
  assert.equal(world.vehicle.availablePowerKw, 0);
  assert(Math.abs(world.vehicle.vx) < .1, 'destroyed motor and brakes cannot accelerate the vehicle');
  assert(mechanicalState(world).kineticJ < before);
  assert.equal(world.dynamics.recoveries, 0);
});

test('persistent Rust gear damage preserves the single carrier mass, COM and moment of inertia', t => {
  const world = managedWorld(t, createConstruction('scout'), { visualEvents: false }); advance(world, 60);
  const wheel = world.modules.find(m => m.kind === 'wheel'), before = wheelPhysics(world, wheel),
    contours = structuredClone(world.actor().contactContours), mass = mechanicalState(world).mass;
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  // The scout has come to rest: the step that flies the round moves it by nothing but the round.
  assert(before.bodies[0].sleeping);
  // An armour-piercing round flown level into the wheel from two centimetres off its rim, spent inside it.
  flyRound(world, { x: wheel.x + wheel.width / 2 + .02, y: wheel.y, vx: -600, vy: 0,
    power: 100, radius: .06, mass: .2, caliberMm: 120, ammo: 'ap' }, .0001);
  assert.equal(world.stats.penetrations, 1); assert(wheel.health < wheel.maxHealth);
  const after = wheelPhysics(world, wheel);
  assert.equal(after.owner.body, before.owner.body); assert.equal(after.bodies.length, 1);
  for (const key of ['mass', 'inertia', 'centerX', 'centerY'])
    assert.equal(after.bodies[0][key], before.bodies[0][key]);
  assert.deepEqual(world.actor().contactContours, contours);
  assert.equal(mechanicalState(world).mass, mass);
  advance(world, 60); assert.equal(world.dynamics.recoveries, 0);
});

test('persistent Rust audits actual subsolve energy separately from frame loads', t => {
  const world = managedWorld(t,createConstruction('scout'), { visualEvents: false }); advance(world,60);
  world.game().call({op:'setVehicleState',state:{vx:3}});
  const samples = [], audit = new NativeAudit(world,{onStep:sample=>samples.push(sample)});
  t.after(()=>audit.close());
  advance(world,2);
  assert.equal(samples.length,2);
  for (const sample of samples) {
    const energy = sample.nativeEnergy, peak = energy.maxGrowth;
    assert.equal(energy.solves,1,'the audit is reset per host frame and measures every native subsolve');
    assert.equal(sample.before.energy,peak.before); assert.equal(sample.afterEnergy,peak.after);
    assert.equal(peak.growth,peak.after-peak.before);
    assert([peak.before,peak.after,peak.growth,peak.gravityWork,peak.constraintEnergy].every(Number.isFinite));
    assert(energy.maxBefore >= peak.before && energy.maxAfter >= peak.after);
    assert.equal(peak.invalid,0);
    assert(peak.after <= peak.before*4+peak.gravityWork+peak.constraintEnergy+100);
  }
  assert.equal(audit.substeps,2); assert.equal(world.dynamics.recoveries,0);
});
