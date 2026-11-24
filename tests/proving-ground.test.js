import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { chassisSpec, suspensionHeight } from '../src/chassis.ts';
import { withChassisSuspension } from '../src/chassis-editing.ts';
import { paced } from '../src/squad.ts';
import { laboratoryCourse } from './helpers/laboratory-course.js';

// Deliberate laboratory limits remain regression fixtures, outside the playable world generator.
const proving = laboratoryCourse(), ahead = x => 12 - x;
const signed = text => ahead(proving.signs.find(sign => sign.text === text).x) + 6;
function laboratoryWorld(source) {
  const world = new World(source, { enclosed: true, settle: true });
  world.terrain = laboratoryCourse();
  world.bounds = { minX: world.terrain.minX - 72, maxX: world.terrain.maxX + 72 };
  world.replaceActor(source, { id: 'local', x: 12, facing: -1 });
  return world;
}

// Drives a stock design, or the same design with explicitly sized gear, from `from` metres ahead of the start,
// flat out or no faster than `pace` m/s, or by its pilot at that pace (squad.ts `paced`); says how far it got.
function drive(template, from, { pace = Infinity, seconds = 90, gearSize, observe, pilot = false } = {}) {
  // Gear of another size, along the whole frame, hangs the whole design as high over it as the stock one does.
  const stock = createStructuredTemplate(template);
  if (gearSize !== undefined && stock.chassis.model === 'wheeled') stock.chassis.axles = [-50,0,50];
  const spec = chassisSpec(stock.chassis.model),
    source = gearSize === undefined ? stock : withChassisSuspension({ ...stock,
      chassis: { ...stock.chassis, gearScale: gearSize / (spec.wheel ?? spec.track) } }, suspensionHeight(stock.chassis));
  const world = laboratoryWorld(source), vehicle = world.actor('local').vehicle;
  try {
    for (let i = 0; i < 30; i++) world.step();
    world.command('setVehicleState', { actorId: 'local', state: { x: ahead(from), y: vehicle.y, angle: 0, vx: 0, vy: 0, omega: 0 } });
    let best = from, bestAt = 0, throttle = 0;
    const leg = {};
    for (let step = 0; step < seconds * 60 && step - bestAt < 15 * 60; step++) {
      if (pilot) {
        const control = paced(leg, vehicle, -1, -vehicle.vx, pace, world.time);
        world.controlVehicle(control.throttle, control.brake, 'local');
      } else {
        const wanted = Math.hypot(vehicle.vx, vehicle.vy) > pace ? 0 : -1;
        if (wanted !== throttle) world.controlVehicle(throttle = wanted, 0, 'local');
      }
      world.step();
      observe?.(world);
      if (ahead(vehicle.x) > best + .5) { best = ahead(vehicle.x); bestAt = step; }
    }
    assert.equal(world.dynamics.recoveries, 0, `${template}: the route must not rely on solver recovery`);
    assert([vehicle.x, vehicle.y, vehicle.angle, vehicle.vx, vehicle.vy].every(Number.isFinite));
    return best;
  } finally { world.dispose(); }
}

test('laboratory obstacles retain their limits: mud a tracked design climbs stops wheels, and the metre step stops a lorry and a tank with low tracks', () => {
  const lama = signed('Lama'), crest = lama + 66, step = signed('Degrau 1 m');
  assert(drive('ifv', lama - 20, { pace: 3 }) > crest, 'tracks climb the mud');
  assert(drive('recon', lama - 20, { pace: 3 }) < crest - 40, 'wheels spin on it');
  assert(drive('truck', step - 120, { seconds: 40 }) < step, 'the lorry goes up the metre step');
  // Lowering the actual belt from .88 m to .66 m also lowers its raised end and clearance.
  assert(drive('heavy', step - 20, { pace: 1.4, seconds: 40, gearSize: .66 }) < step,
    'the tank with low tracks must remain short of the metre step at a walk');
});

test('the stock heavy tank climbs the half-metre step at every pace', () => {
  // Its track meets the face with the belt round its raised idler and runs up onto the edge, at any speed it comes.
  const step = signed('Degrau 0,5 m');
  for (const pace of [1.4, 3, 5, Infinity])
    assert(drive('heavy', step - (pace === Infinity ? 120 : 20), { pace, seconds: 40 }) > step + 12, `at ${pace} m/s`);
});

test('a heavy tank on low tracks stops safely against the metre step at a walk', () => {
  // The former 25 mm fixture climbed only while the structural yield limit also stiffened its springs.
  // With springs sized for the installed payload, the stock tank climbed this step only with the momentum tested at
  // 3 m/s below; over the bumps of the soil before it (game_terrain.rs `Bumps`) it is at the edge of climbing it at a
  // walk. On its tracks lowered from .88 m to .66 m it is short of it: they come up against the face, some 3.4 m ahead
  // of its middle (counted by half metres), and spin there, the ground holding them back by less than it holds a track
  // that grips (game_motion.rs `drive`): they no longer lift its front onto the step.
  // No ground coefficient, motor, geometry or control pace is changed to make it climb at a walk.
  const metre = signed('Degrau 1 m');
  let final, initialArmour, hullPenetration = 0, contactPenetration = 0;
  const best = drive('heavy', metre - 20, { pace: 1.4, seconds: 40, gearSize: .66, observe(world) {
    final = world.vehicle.snapshot();
    assert(world.modules.every(m => m.health === m.maxHealth && !m.beltCut), 'the stopped construction remains intact');
    initialArmour ||= new Map(world.plates.map(p=>[p.id,p.remainingArea]));
    assert(world.plates.every(p => Math.abs(initialArmour.get(p.id) - p.remainingArea) < 1e-10),
      'the step preserves armour material; touching the wall may leave a local dent');
    const c = Math.cos(final.angle), s = Math.sin(final.angle);
    const contours = world.actor().contactContours;
    assert(contours.length > 0, 'the carrier has admitted body contact shapes');
    for (const contour of contours) for (const p of contour) {
      const x = final.x + c * p.x - s * p.y, y = final.y + s * p.x + c * p.y;
      hullPenetration = Math.max(hullPenetration, world.terrain.height(x) - y);
    }
    // Only active manifolds describe this step; cached contacts may belong to a previous pose.
    // The raw contact distance measures real shape overlap, before the separate 20 mm contact skin.
    for (const contact of world.game().call({ op: 'physics', contacts: true }).contactStates)
      if (contact.solverContacts.length) contactPenetration = Math.max(contactPenetration, contact.penetration);
  } });
  assert(best > metre - 4 && best < metre, 'it reaches the metre step and remains short of it');
  assert(Math.abs(final.throttle) > 0 && Math.abs(final.slip) > 1, 'the running gear pushes and spins against the physical obstruction');
  assert(Math.hypot(final.vx, final.vy) < .3, 'the vehicle remains below the physical stall threshold');
  assert(hullPenetration < 1e-8, 'every admitted body contact shape remains above the real terrain');
  assert.equal(contactPenetration, 0, 'active native contact shapes never overlap the terrain');
});

test('raised track ends and large wheels reach the taller steps without a run-up', () => {
  // The lorry's four axles retain their positions: 1.6 m tyres fit their 1.7 m spacing with the required gap.
  for (const [template, obstacle, gearSize] of [['heavy', 'Degrau 1 m'], ['ifv', 'Degrau 0,75 m'], ['truck', 'Degrau 0,5 m', 1.6]]) {
    const start = signed(obstacle);
    assert(drive(template, start - 20, { pace: 3, seconds: 40, gearSize }) > start + 12, `${template}: ${obstacle} at 3 m/s`);
  }
});

test('the howitzer goes down the steep descent and up the half-metre step, at a walk and at 5 m/s', () => {
  // Its track runs from its nose nearly to its tail: its nose does not dig into the foot of the descent, nor does
  // the step stop it. Each a good way on past either.
  for (const text of ['Descida íngreme', 'Degrau 0,5 m']) {
    const start = signed(text);
    for (const pace of [1.4, 5]) assert(drive('howitzer', start - 20, { pace, seconds: 45 }) > start + 25, `${text} at ${pace} m/s`);
  }
});

test('at a walking pace a lorry climbs the step of 0.3 m, on 1.5 m tyres the half-metre one, and the one of three quarters of a metre stops it', () => {
  // On its stock 1.25 m tyres the half-metre step is at the edge of what it climbs at a walk, and over the bumps of the
  // soil before it (game_terrain.rs `Bumps`) it no longer does. Flat out against the face its tyres spin, and the soil
  // holds a tyre that spins by less than one that grips (game_terrain.rs `sliding`): on 1.4 m tyres it no longer climbs
  // it either, on 1.5 m it does.
  for (const [text, climbs, gearSize] of [['Degrau 0,3 m', true], ['Degrau 0,5 m', true, 1.5], ['Degrau 0,75 m', false]]) {
    const step = signed(text);
    assert.equal(drive('truck', step - 20, { pace: 1.4, seconds: 40, gearSize }) > step + 12, climbs, text);
  }
});

test('driven by its pilot, a vehicle climbs what it climbs on the key: steps at a walk and at 3 m/s, and tracks the mud', () => {
  // Against the face of a step, or bogged in the mud, the pilot puts his foot down (squad.ts `leaning`); short of that he
  // asks its gear for no more than its ground holds.
  const half = signed('Degrau 0,5 m'), metre = signed('Degrau 1 m'), lama = signed('Lama');
  assert(drive('truck', half - 20, { pace: 1.4, seconds: 40, gearSize: 1.5, pilot: true }) > half + 12, 'the lorry on 1.5 m tyres');
  assert(drive('heavy', metre - 20, { pace: 3, seconds: 40, pilot: true }) > metre + 12, 'the heavy tank up the metre step');
  assert(drive('ifv', lama - 20, { pace: 3, pilot: true }) > lama + 66, 'tracks climb the mud');
  assert(drive('recon', lama - 20, { pace: 3, pilot: true }) < lama + 26, 'wheels spin on it');
});
