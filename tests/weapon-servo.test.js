import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { structuredTemplateSource } from '../src/structured-templates.ts';
import { angleDifference } from '../src/math.ts';
import { servoStatus } from '../src/weapon-presentation.ts';
import { posePart } from '../src/scene-frame.ts';
import { mountedFiringSolution } from '../src/ballistics.ts';
import { weaponSettings } from '../src/weapons.ts';
import { applyWorldInput, releaseWorldInputs } from '../src/episode-input.ts';
import { ownerState, physics, materialState, setPart } from './mechanical-queries.js';
import { standing } from './helpers/designs.js';

const near = (a, b, e = 1e-8) => assert(Math.abs(a - b) < e, `${a} != ${b}`);
const step = (w, n) => { for (let i = 0; i < n; i++) w.step(); };
function fixture(t, { mobile = false, preset = 'rh120' } = {}) {
  const template = structuredTemplateSource('heavy', { preset }), source = mobile ? template : standing(template);
  if (mobile) source.components = source.components.filter(p => !['engine', 'fuel'].includes(p.kind));
  const w = new World(source); t.after(() => w.dispose());
  const gun = w.modules.find(m => m.id === 'weapon'), ammo = w.modules.find(m => m.kind === 'ammo'),
    config = w.playerWeapon({ platform: 'vehicle', componentId: gun.id });
  const legalOffset = offset => Math.max(gun.weaponMount.min, Math.min(gun.weaponMount.max, offset)),
    bearing = offset => gun.angle + legalOffset(offset),
    aim = offset => ({ x: gun.x + Math.cos(bearing(offset)) * 80, y: gun.y + Math.sin(bearing(offset)) * 80 });
  return { w, source, gun, ammo, config, aim, bearing };
}

test('paused aiming cannot advance a mounted servo, consume ammunition or create recoil', t => {
  const { w, gun, ammo, config, aim, bearing } = fixture(t), initial = gun.barrelAngle, rounds = ammo.rounds;
  near(gun.weaponMount.fireTolerance,Math.PI/180);
  assert.equal(servoStatus(gun,gun.barrelAngle+.5*Math.PI/180).aligning,false,'ordinary cannon retains its one-degree assisted threshold');
  for (let i = 0; i < 100; i++) { w.aimWeapon(aim(-.3), config); assert.equal(w.fire(aim(-.3), config, true), false); }
  near(gun.barrelAngle, initial); near(gun.targetBarrelAngle, bearing(-.3));
  assert.equal(w.time, 0); assert.equal(w.stats.shots, 0); assert.equal(w.projectiles.length, 0);
  assert.equal(ammo.rounds, rounds); assert(servoStatus(gun).aligning);
});

test('servo speed and sector remain bounded without cannon contacts, joints or torque', t => {
  const { w, gun, config, aim, bearing } = fixture(t), initial = ownerState(w, gun), before = physics(w),
    profile = materialState(w, gun).servo;
  w.aimWeapon(aim(-.3), config); let last = gun.barrelAngle;
  for (let i = 0; i < 360; i++) {
    w.step(); assert(Math.abs(angleDifference(gun.barrelAngle, last)) <= profile.maxSpeed / 60 + 1e-9);
    assert(Math.abs(gun.servoVelocity) <= profile.maxSpeed + 1e-9); last = gun.barrelAngle;
  }
  near(angleDifference(gun.barrelAngle, bearing(-.3)), 0, 1e-7);
  assert.equal(profile.torqueNm, 0);
  assert.equal(ownerState(w, gun).body, initial.body); assert.equal(physics(w).bodies, before.bodies);
  assert.equal(physics(w).colliders, before.colliders);
  for (const offset of [-2, 2]) {
    w.aimWeapon(aim(offset), config); step(w, 360);
    assert(gun.aimOffset >= gun.weaponMount.min - 1e-9 && gun.aimOffset <= gun.weaponMount.max + 1e-9);
  }
});

test('one queued click aligns, uses the physical muzzle once and spends one compatible round', t => {
  const { w, gun, ammo, config, aim } = fixture(t), rounds = ammo.rounds;
  assert.equal(applyWorldInput(w, 'local', { ...config, type: 'fire', phase: 'before', aim: aim(-.3), queue: true }).accepted, false);
  assert.equal(w.actor().pendingShot.expires, w.time + 12);
  let muzzle;
  for (let i = 0; i < 400 && !w.stats.shots; i++) {
    w.step(); if (w.stats.shots) muzzle = w.drainEvents().find(e => e.type === 'muzzle');
  }
  assert(muzzle); assert.equal(w.stats.shots, 1); assert.equal(ammo.rounds, rounds - 1);
  assert(Math.abs(angleDifference(muzzle.angle, gun.targetBarrelAngle)) <= gun.weaponMount.fireTolerance + .01);
  near(Math.hypot(muzzle.x - gun.x, muzzle.y - gun.y), config.barrel, .002);
  assert.equal(w.actor().pendingShot, null); step(w, 20); assert.equal(w.stats.shots, 1);
});

test('perforating all armour retains the gun on the same carrier with its admitted sector', t => {
  const { w, gun, config, aim } = fixture(t), carrier = ownerState(w, gun).body,
    contours = structuredClone(w.actor().contactContours), mass = physics(w).bodyStates.map(b => [b.mass, b.inertia]);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  for (const plate of w.plates) w.cutBody(plate, plate.definition, plate.definition, plate.definition.length * 2);
  assert(w.plates.every(p => p.remainingArea === 0));
  w.aimWeapon(aim(-.3), config); step(w, 240);
  assert.equal(gun.attached, true); assert(Math.abs(gun.aimOffset) > .2);
  assert.equal(ownerState(w, gun).body, carrier); assert.deepEqual(w.actor().contactContours, contours);
  assert.deepEqual(physics(w).bodyStates.map(b => [b.mass, b.inertia]), mass);
});

test('aim changes, explicit cancellation of an unavailable weapon, release and destruction clear a queued input shot', t => {
  const { w, gun, ammo, config, aim } = fixture(t), rounds = ammo.rounds,
    input = (type, offset, extra = {}) => applyWorldInput(w, 'local', { ...config, type, phase: 'before', aim: aim(offset), ...extra }),
    queue = () => { assert.equal(input('fire', -.3, { queue: true }).accepted, false); assert(w.actor().pendingShot); };
  queue(); input('aim', -.2); assert.equal(w.actor().pendingShot, null);
  queue(); input('trigger', -.3, { active: false, componentId: 'another-gun', cancel: true });
  assert.equal(w.actor().pendingShot, null);
  queue(); releaseWorldInputs(w); assert.equal(w.actor().pendingShot, null);
  queue(); setPart(w, gun, { health: 0 }); w.step();
  assert.equal(w.actor().pendingShot, null); assert.equal(w.stats.shots, 0);
  assert.equal(ammo.rounds, rounds);
});

test('overlapping allied, enemy and defeated vehicles cannot physically block a servo', t => {
  for (const [ownerId, defeated] of [['local', false], ['enemy', false], ['enemy', true]]) {
    const { w, gun, config, aim } = fixture(t), other = structuredTemplateSource('heavy');
    const obstacle = w.addActor(other, { id: 'obstacle', ownerId, x: 12 });
    if (defeated) obstacle.defeated = 'command';
    const before = physics(w).bodyStates.map(b => [b.handle, b.mass, b.inertia]);
    w.aimWeapon(aim(gun.weaponMount.min), config); step(w, 360);
    near(gun.aimOffset, gun.weaponMount.min, 1e-7);
    assert.deepEqual(physics(w).bodyStates.map(b => [b.handle, b.mass, b.inertia]), before);
    assert.equal(w.dynamics.recoveries || 0, 0);
  }
});

test('aiming cannot lift or propel an unpowered vehicle through terrain', t => {
  const { w, source, gun, config, aim } = fixture(t, { mobile: true }), control = new World(source);
  t.after(() => control.dispose()); step(w, 60); step(control, 60);
  w.aimWeapon(aim(.2), config); step(w, 480); step(control, 480);
  assert.equal(w.vehicle.availablePowerKw, 0);
  near(w.vehicle.x, control.vehicle.x, .005); near(w.vehicle.y, control.vehicle.y, .02);
  assert(Math.hypot(w.vehicle.vx, w.vehicle.vy) < .01); assert.equal(w.dynamics.recoveries || 0, 0);
});

test('render interpolation crosses angle wrap continuously and supplies the same muzzle and preview pose', t => {
  const { gun } = fixture(t), previous = { ...gun, x: 10, y: 4, barrelAngle: Math.PI - .05 },
    current = { ...previous, x: 12, y: 6, barrelAngle: -Math.PI + .05, targetBarrelAngle: 0 },
    pose = posePart(current, previous, .5);
  near(pose.x, 11); near(pose.y, 5); near(pose.barrelAngle, Math.PI);
  const config = weaponSettings('cannon', { preset: 'rh120', barrel: 1.8, speed: 1000, trajectory: 'direct', life: 45 }),
    solution = mountedFiringSolution(pose, { x: 20, y: 8 }, config);
  near(solution.x, pose.x + Math.cos(pose.barrelAngle) * config.barrel);
  near(solution.y, pose.y + Math.sin(pose.barrelAngle) * config.barrel);
  near(solution.angle, pose.barrelAngle); assert(servoStatus(pose).aligning);
});
