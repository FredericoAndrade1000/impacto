import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { engineBox } from './helpers/mechanics-source.js';
import { validateBlueprint } from '../src/persistence.ts';
import { ownerState, physics, flyRound, structureMass, managedWorld, advance } from './mechanical-queries.js';

// Admitted at once: what the vehicle weighs is the core's.
const managed = (t, blueprint) => { const w = managedWorld(t, blueprint); w.game(); return w; };
const installation = w => [...w.plates, ...w.modules].map(p => [p.id, p.attached, ownerState(w, p).body]);
const properties = w => physics(w).bodyStates.map(b => [b.handle, b.mass, b.inertia]);
const contactShape = w => {
  const contours = structuredClone(w.actor().contactContours);
  assert(contours.length > 0 && contours.every(polygon => polygon.length >= 3));
  return contours;
};

test('removing ballistic chassis material preserves every installed piece, mass and relative pose', t => {
  const w = managed(t, createConstruction('heavy')), before = installation(w),
    root = w.plates.find(p => p.id === w.vehicle.config.chassisId),
    mass = properties(w), contour = contactShape(w),
    plates = w.plates.map(p => ({ id: p.id, x: p.definition.x - w.vehicle.x, y: p.definition.y - w.vehicle.y,
      angle: p.definition.angle - w.vehicle.angle }));
  w.cutBody(root, root.definition, root.definition, 20);
  assert.equal(root.remainingArea, 0);
  assert.equal(w.command('cut', { owner: w.game().handle(root), start: root.definition, end: root.definition, radius: .01 }), false,
    'a second cut cannot remove material from an already empty ballistic region');
  advance(w, 120);
  assert.deepEqual(installation(w), before); assert.deepEqual(properties(w), mass);
  assert.deepEqual(w.actor().contactContours, contour);
  for (const original of plates) {
    const p = w.plates.find(p => p.id === original.id), dx = p.definition.x - w.vehicle.x, dy = p.definition.y - w.vehicle.y,
      c = Math.cos(w.vehicle.angle), s = Math.sin(w.vehicle.angle);
    assert(Math.abs(c * dx + s * dy - original.x) < 1e-6);
    assert(Math.abs(-s * dx + c * dy - original.y) < 1e-6);
    assert(Math.abs(p.definition.angle - w.vehicle.angle - original.angle) < 1e-6);
  }
  assert.equal(physics(w).bodies, 1);
  assert.equal(w.dynamics.recoveries || 0, 0);
});

test('running gear is a functional ballistic hitbox of the carrier, with no independent axle state', t => {
  const w = managed(t, createConstruction('heavy')), gear = w.modules.find(m => m.kind === 'track'),
    before = ownerState(w, gear), mass = properties(w), contour = contactShape(w);
  // An armour-piercing round flown level into the trailing end of the track from two centimetres off it, spent inside.
  flyRound(w, { x: gear.x + gear.width / 2 + .02, y: gear.y, vx: -600, vy: 0, power: 300, radius: .08, mass: .2, caliberMm: 160, ammo: 'ap' }, .0001);
  assert.equal(w.stats.penetrations, 1); assert(gear.health < gear.maxHealth && gear.attached);
  assert.equal(ownerState(w, gear).body, before.body); assert.deepEqual(properties(w), mass);
  assert.deepEqual(w.actor().contactContours, contour);
});

for (const template of ['heavy', 'scout']) test(`${template}: repeated blasts disable mechanisms without structural separation or loss of structure`, t => {
  const w = managed(t, createConstruction(template)), before = installation(w), [[body, mass, inertia]] = properties(w),
    structure = structureMass(w), contour = contactShape(w);
  advance(w, 45);
  for (let i = 0; i < 3; i++) {
    const fuel = w.modules.find(m => m.kind === 'fuel');
    w.explode(fuel.x, fuel.y, 600, 4.5); advance(w, 75);
  }
  assert.deepEqual(installation(w), before);
  // Expended reserves and burnt interiors leave the body; its permanent hull/chassis remains.
  const [[still, lighter, easier], ...others] = properties(w);
  assert.deepEqual([still, others], [body, []]); assert(lighter < mass - 20 && easier < inertia);
  assert(Math.abs(structureMass(w) - structure) < 1e-6);
  assert.deepEqual(w.actor().contactContours, contour);
  assert(w.modules.some(m => m.health === 0));
  assert(!w.events.some(e => ['hinge', 'detached'].includes(e.type)));
  assert.equal(w.dynamics.recoveries || 0, 0);
});

test('free authored plates share the construction carrier while compiled DTO fields are refused', t => {
  const posed = createConstruction('scout'), apart = createConstruction('scout');
  posed.plates.push({ id: 'loose', x: 22, y: 3, length: 1.5, thicknessMm: 60, material: 'steel' });
  assert.throws(() => validateBlueprint(posed), { reason: 'AUTHORING_FIELDS' });
  // A 1.5 m plate 3 m up, from 4 m behind the reference, in cells.
  apart.nodes.push({ id: 'loose-0', x: 80, y: 60 }, { id: 'loose-1', x: 110, y: 60 });
  apart.plates.push({ id: 'loose', a: 'loose-0', b: 'loose-1', material: 'steel', thicknessMm: 60 });
  const world=managed(t,apart),body=ownerState(world,world.plates[0]).body;
  assert.equal(physics(world).bodyStates.length,1);
  assert(world.plates.some(plate=>plate.id==='loose'));
  for(const part of [...world.plates,...world.modules])assert.equal(ownerState(world,part).body,body);
  advance(world,10);assert.equal(physics(world).bodyStates.length,1);
});

test('bounded immediate blast rays retain primary rounds and one rigid carrier through repeated blasts', t => {
  const blueprint = engineBox(.3);
  const w = managed(t, blueprint), bodies = physics(w).bodyStates.map(b => b.handle), mass = properties(w), installed = installation(w),
    primary = { id: 'primary', age: 0, x: -100, y: 10, vx: 1, vy: 0, power: 100, mass: 1, caliberMm:20, radius: .01 };
  w.command('projectile', { projectile: w.game().projectile(primary) });
  const target = w.modules.find(m => m.kind === 'engine');
  for (let i = 0; i < 20; i++) w.explode(target.x, target.y, 300, 4);
  const rays = w.drainEvents().filter(event => event.type === 'secondary-ray');
  assert(rays.length > 0 && rays.length <= 20 * 6, 'each real blast traces at most three internal and three external directions');
  assert(rays.every(ray => ray.energyBudget > 0 && ray.energySpent >= 0 && ray.energySpent <= ray.energyBudget + 1e-8));
  // Blast mechanical energy is 10%, split equally into body loads and rays;
  // the 8% limit belongs to primary perforation spall, a different source.
  assert(rays.reduce((sum, ray) => sum + ray.energyBudget, 0) <= 20 * 300 * 200 * .10 * .5 + 1e-6,
    'instantaneous fragments share the finite blast budget, while body impulse owns the other half');
  assert.equal(w.stats.secondaryShots, rays.length, 'secondary contacts cannot recursively emit another cloud');
  w.step();
  assert.equal(w.projectiles.length, 1, 'the ray result is immediate and creates no persistent packets');
  assert.equal(w.projectiles[0].id, primary.id); assert(w.projectiles[0].age > primary.age);
  assert.deepEqual(physics(w).bodyStates.map(b => b.handle), bodies);
  assert.deepEqual(properties(w), mass); assert.deepEqual(installation(w), installed);
});
