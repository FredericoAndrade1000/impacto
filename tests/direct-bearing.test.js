import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { applyWorldInput } from '../src/episode-input.ts';
import { fixedWeapon } from '../src/weapons.ts';
import { firingSolution, mountedFiringSolution } from '../src/ballistics.ts';
import { weaponAngle } from '../src/weapon-geometry.ts';
import { materialState } from './mechanical-queries.js';
import { duel } from './helpers/duel.js';

// A command may name the bearing of the barrel instead of a point to hit: the gun is laid there and no arc is solved.
const session = t => duel(t, createConstruction('recon'), { visualEvents: false });
const mounted = w => w.modules.find(m => m.actorId === 'local' && m.kind === 'weapon');
const input = (w, command) => applyWorldInput(w, 'local', { ...command, phase: 'before' }, { platform: 'vehicle' });
const along = (gun, angle) => ({ x: gun.x + Math.cos(angle) * 50, y: gun.y + Math.sin(angle) * 50 });

test('direct artillery uses the commanded bearing and legal charges/fuzes instead of the automatic firing solution', () => {
  const gun = { id: 'gun', kind: 'weapon', weaponPreset: 'm252', health: 10, x: 0, y: 3, barrelAngle: 1 },
    settings = fixedWeapon({ platform: 'vehicle', componentId: gun.id, aimAngle: .6, charge: .25,
      detonation: 'airburst', fuzeTime: 2, power: 1e9, rate: 1e9, speed: 1e9 }, [gun]),
    a = firingSolution(gun, { x: 30, y: 3 }, settings), b = firingSolution(gun, { x: 300, y: 30 }, settings),
    actual = mountedFiringSolution(gun, { x: 300, y: 30 }, settings);
  assert.equal(a.angle, .6); assert.equal(b.angle, a.angle); assert.equal(a.speed, 125, 'a quarter of the propellant, half of the 250 m/s of the full charge'); assert.equal(b.speed, a.speed);
  assert.equal(actual.angle, 1); assert.equal(actual.time, 2); assert.equal(settings.power, 260); assert.equal(settings.rate, 15);
  assert.equal(fixedWeapon({ platform: 'vehicle', componentId: 'c', aimAngle: 0, charge: .25 },
    [{ ...gun, id: 'c', weaponPreset: 'rh120' }]).charge, 1);
});

test('bearing commands respect the preset servo rate and keep their exact charge, bearing and independent trigger', t => {
  const w = session(t), gun = mounted(w), initial = weaponAngle(gun),
    bearing = gun.angle + gun.weaponMount.max, action = { type: 'controls', throttle: 1, brake: 0, aimAngle: bearing,
      aim: along(gun, bearing), fire: false, componentId: gun.id, charge: 1 };
  const maxSpeed = materialState(w, gun).servo.maxSpeed,
    difference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  assert(Number.isFinite(maxSpeed) && maxSpeed > 0);
  const { record } = input(w, action); assert.equal(weaponAngle(gun), initial);
  assert(Number.isFinite(record.aimAngle)); assert.equal(record.charge, 1);
  let previous = initial, chassis = w.actor('local').vehicle.angle, servoTravel = 0, steps = 0;
  for (; steps < 18; steps++) {
    w.step();
    const bore = weaponAngle(gun), nextChassis = w.actor('local').vehicle.angle,
      travel = difference(bore, previous) - difference(nextChassis, chassis);
    assert(Math.abs(travel) <= maxSpeed / 60 + 1e-6, 'each servo step respects its native preset rate independently of chassis rotation');
    servoTravel += travel; previous = bore; chassis = nextChassis;
  }
  assert(Math.abs(servoTravel) <= maxSpeed * steps / 60 + 1e-6);
  assert(Math.abs(servoTravel) > 1e-4, 'the actual orientation follows the direct command');
  assert.equal(w.actor('local').stats.shots, 0, 'laying the gun pulls no trigger');
});

test('pulling the trigger while slewing fires from the real bore and cannot reset reload', t => {
  const w = session(t), gun = mounted(w), angle = weaponAngle(gun), aim = along(gun, angle),
    settings = w.playerWeapon({ platform: 'vehicle', componentId: gun.id, aimAngle: angle + .4 }, 'local');
  assert.equal(w.fire(aim, settings, false, 'local'), true);
  const p = w.projectiles[0]; assert(p);
  const delta = Math.atan2(Math.sin(Math.atan2(p.vy, p.vx) - angle), Math.cos(Math.atan2(p.vy, p.vx) - angle));
  assert(Math.abs(delta) < .03, 'the projectile does not jump to the requested servo orientation');
  assert.equal(w.fire(aim, { ...settings, aimAngle: angle - .5 }, false, 'local'), false);
  assert.throws(() => w.fire(aim, { ...settings, ammo: 'he' }, false, 'local'), /Unavailable weapon ammunition/);
  assert.equal(w.actor('local').stats.shots, 1);
  assert.throws(() => input(w, { type: 'controls', throttle: 1, brake: 0, aim, fire: false,
    componentId: gun.id, charge: 1, aimAngle: NaN }), /inválido/);
});
