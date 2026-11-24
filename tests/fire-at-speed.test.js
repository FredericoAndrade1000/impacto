import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { propellantCharges } from '../src/weapons.ts';
import { chargeSpeed } from '../src/ballistics.ts';

// A carrier on flat ground, thrown at the given velocity and turning rate, with its gun ready along its barrel.
function thrown(t, template, preset, [vx, vy, omega]) {
  const blueprint = createStructuredTemplate(template, preset ? { preset } : {}); blueprint.terrain = 'flat';
  const world = new World(blueprint); t.after(() => world.dispose()); world.game();
  for (let i = 0; i < 40; i++) world.step();
  world.drainEvents();
  const id = world.modules.find(module => module.kind === 'weapon').id, gun = () => world.modules.find(module => module.id === id),
    ahead = Math.cos(gun().barrelAngle) >= 0 ? 1 : -1;
  world.command('setVehicleState', { state: { x: world.vehicle.x, y: world.vehicle.y, vx: vx * ahead, vy, omega } });
  const config = () => world.playerWeapon({ platform: 'vehicle', componentId: id, ...(preset ? { preset } : {}), aimAngle: gun().barrelAngle, spread: 0 }),
    aim = () => ({ x: gun().x + 30 * Math.cos(gun().barrelAngle), y: gun().y + 30 * Math.sin(gun().barrelAngle) });
  return { world, gun, config, aim };
}

test('a weapon fired at speed never strikes itself', t => {
  for (const [template, preset] of [['ifv', 'minimi'], ['ifv', 'rh202'], ['scout', null], ['heavy', null]])
    for (const motion of [[18, 2, 0], [30, 3, 0], [45, -1, 0], [-25, 0, 0], [20, 5, 1.5], [30, 4, -2]]) {
      const { world, gun, config, aim } = thrown(t, template, preset, motion), label = `${template} ${preset || ''} at ${motion}`;
      let struck = 0;
      for (let frame = 0; frame < 30; frame++) {
        world.setTrigger(true, aim(), config()); world.step();
        struck += world.drainEvents().filter(event => event.emitterOwner !== undefined && event.emitterOwner !== null && !event.ground).length;
      }
      assert(world.stats.shots > 0, label);
      assert.equal(struck, 0, `${label}: its own rounds struck the carrier`);
      assert.equal(gun().health, gun().maxHealth, label);
    }
});

test('a round leaves at the speed of its charge from a muzzle that moves and turns with the carrier about its centre of mass', t => {
  for (const [template, preset] of [['mortar', 'm119'], ['mortar', 'm224'], ['heavy', 'rh120']]) {
    const levels = propellantCharges(preset).map(level => level.value);
    assert.equal(levels.length, preset === 'm119' ? 7 : preset === 'm224' ? 5 : 1);
    for (const charge of levels) {
      const { world, config, aim } = thrown(t, template, preset, [4.25, -.3, .35]), settings = { ...config(), charge },
        v = { ...world.vehicle }, c = Math.cos(v.angle), s = Math.sin(v.angle),
        centre = { x: v.x + c * v.carrierCenter.x - s * v.carrierCenter.y, y: v.y + s * v.carrierCenter.x + c * v.carrierCenter.y };
      assert(world.fire(aim(), settings, true));
      const round = world.projectiles[0],
        muzzle = { x: v.vx - v.omega * (round.y - centre.y), y: v.vy + v.omega * (round.x - centre.x) };
      // The dispersion of the gun turns the round a little off the bore and leaves its speed as the charge gives it.
      assert.equal(round.charge, charge);
      assert(Math.abs(Math.hypot(round.vx - muzzle.x, round.vy - muzzle.y) - chargeSpeed(settings)) < 1e-9, `${preset} charge ${charge}`);
    }
  }
});

test('the flight of a round fired at speed starts at the muzzle as it stands after the step', t => {
  for (const motion of [[0, 0, 0], [30, 3, 0], [20, 5, 1.5]]) {
    const { world, gun, config, aim } = thrown(t, 'ifv', 'minimi', motion), settings = config();
    assert(world.fire(aim(), settings));
    const launched = { ...world.projectiles[0] }; world.step();
    const round = world.projectiles[0], weapon = gun(),
      muzzle = { x: weapon.x + settings.barrel * Math.cos(weapon.barrelAngle), y: weapon.y + settings.barrel * Math.sin(weapon.barrelAngle) },
      flown = { x: round.x - muzzle.x, y: round.y - muzzle.y };
    // One whole step of flight from the muzzle, slowed only by the air: nothing of it is spent behind the gun.
    for (const [axis, speed] of [['x', 'vx'], ['y', 'vy']]) {
      const [least, most] = [launched[speed], round[speed]].map(value => value / 60).sort((a, b) => a - b);
      assert(flown[axis] > least - .01 && flown[axis] < most + .01, `at ${motion}: ${axis} ${flown[axis]} outside ${least}..${most}`);
    }
  }
});
