import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_PRESETS, PROPELLANT_LEVELS, propellantCharges, weaponSettings, fixedWeapon } from '../src/weapons.ts';
import { firingSolution, flightPoint, chargeSpeed } from '../src/ballistics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { World } from '../src/physics.ts';
import { applyWorldInput } from '../src/episode-input.ts';

const counts = { m224: 5, m252: 5, m119: 7, m777: 5 };
const settings = (preset, controls = {}) => fixedWeapon({ preset, ...controls });
// Direct controls that lay one installed gun on a bearing inside its sector with one charge, the trigger let go.
function laid(gun, charge) {
  const { min, max } = gun.weaponMount, aimAngle = gun.angle + min + (max - min) * .6;
  return { type: 'controls', throttle: 0, brake: 0, aimAngle, aim: { x: gun.x + Math.cos(aimAngle) * 50, y: gun.y + Math.sin(aimAngle) * 50 },
    fire: false, componentId: gun.id, ammo: 'he', charge };
}

test('artillery models offer discrete, ordered catalogue charges; arbitrary inputs cannot create extra power', () => {
  for (const [preset, count] of Object.entries(counts)) {
    const levels = propellantCharges(preset), config = settings(preset);
    assert.equal(levels.length, count); assert(config.variableCharge);
    assert.equal(config.charge, 'auto');
    assert.equal(settings(preset, { charge: 'auto' }).charge, 'auto');
    assert.equal(config.charges, levels);
    assert(levels.every((level, i) => PROPELLANT_LEVELS.includes(level.value) &&
      (!i || level.value > levels[i - 1].value)));
    assert.equal(settings(preset, { charge: -20 }).charge, levels[0].value);
    assert.equal(settings(preset, { charge: 50 }).charge, 1);
    assert(levels.some(level => level.value === settings(preset, { charge: .333 }).charge));
    assert.equal(settings(preset, { aimAngle: .8 }).charge, 1, 'a free bearing never invokes automatic charge selection');
    assert.equal(settings(preset, { charge: .08, speed: 1e8, power: 1e8 }).speed, WEAPON_PRESETS[preset].speed);
  }
  assert.deepEqual(propellantCharges('m224').map(c => c.name), ['Carga 0', 'Carga 1', 'Carga 2', 'Carga 3', 'Carga 4']);
  assert.deepEqual(propellantCharges('m119').map(c => c.name), Array.from({ length: 7 }, (_, i) => 'Carga ' + (i + 1)));
  assert.equal(settings('rh120', { charge: .08 }).charge, 1);
  assert.equal(settings('rh120').variableCharge, false);
});

test('automatic arcs use real catalogue levels at close and far distances, including mirrored flight', () => {
  for (const preset of Object.keys(counts)) for (const distance of [8, 30, 120, 250]) {
    const config = settings(preset, { trajectory: 'high', charge: 'auto' }), launcher = { x: 0, y: 2 }, aim = { x: distance, y: 3 },
      shot = firingSolution(launcher, aim, config), mirror = firingSolution(launcher, { x: -distance, y: 3 }, config);
    assert(shot.reachable, preset + ':' + distance);
    assert(config.charges.some(level => level.value === shot.charge));
    assert.equal(shot.speed, chargeSpeed(config, shot.charge));
    assert(Math.hypot(shot.target.x - aim.x, shot.target.y - aim.y) < .004, preset + ':' + distance);
    assert(Math.abs(shot.vx + mirror.vx) < 1e-9); assert.equal(shot.charge, mirror.charge);
  }
});

test('manual charge is retained when out of range, and high-arc choices offer different obstacle clearance', t => {
  const weak = settings('m252', { charge: .08, trajectory: 'high' }), strong = settings('m252', { charge: 1, trajectory: 'high' }),
    source = { x: 0, y: 2 }, target = { x: 300, y: 2 },
    low = firingSolution(source, target, weak), high = firingSolution(source, target, strong);
  assert(low.reachable && high.reachable);
  const heightAt = (shot, x) => {
    let low = 0, high = shot.time;
    for (let i = 0; i < 28; i++) {
      const mid = (low + high) / 2;
      if (flightPoint(shot, mid).x < x) low = mid; else high = mid;
    }
    return flightPoint(shot, (low + high) / 2).y;
  };
  assert(heightAt(low, 150) < 500 && heightAt(high, 150) > 500, 'the same target permits passing above a 500 m ridge with a different arc');
  assert.equal(firingSolution(source, { x: 800, y: 2 }, weak).reachable, false);
  const world = new World({ ...createConstruction('recon'), launcher: source }); t.after(() => world.dispose());
  assert.equal(world.fire({ x: 800, y: 2 }, weak), false);
  assert.equal(world.stats.shots, 0); assert.equal(world.cooldown, 0);
});

test('a free bearing and its charge jointly determine range without target-point assistance', () => {
  const source = { x: 0, y: 4 }, angle = .8;
  for (const preset of Object.keys(counts)) {
    let previous = 0;
    for (const level of propellantCharges(preset)) {
      const config = settings(preset, { aimAngle: angle, charge: level.value, fuzeTime: 2 }),
        near = firingSolution(source, { x: 1, y: 1 }, config), far = firingSolution(source, { x: 500, y: 60 }, config),
        range = flightPoint(near, near.time).x - near.x;
      assert.equal(near.angle, angle); assert.equal(near.speed, far.speed); assert.equal(near.time, 2);
      assert.equal(near.charge, level.value); assert(range > previous); previous = range;
    }
  }
});

test('mounted low/full charges agree with preview, change recoil and consume one identical explosive shell', t => {
  for (const preset of Object.keys(counts)) {
    const shots = [];
    for (const charge of [propellantCharges(preset)[0].value, 1]) {
      const blueprint = createStructuredTemplate('mortar', { preset }),
        world = new World(blueprint); t.after(() => world.dispose());
      const gun = world.modules.find(m => m.kind === 'weapon');
      const installed = world.modules.find(m => m.id === gun.id), supply = world.modules.find(m => m.kind === 'ammo'), before = supply.rounds,
        config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, aimAngle: installed.barrelAngle,
          charge, detonation: 'airburst', fuzeTime: 2 });
      assert.equal(config.rate, WEAPON_PRESETS[preset].rate, preset + ' catalogue cadence');
      assert(world.fire({ x: 500, y: 10 }, config));
      assert.equal(installed.reload, 60 / WEAPON_PRESETS[preset].rate, preset + ' actual reload');
      const [p] = world.projectiles;
      assert.equal(p.charge, charge); assert.equal(p.mass, config.mass);
      assert.equal(p.power, config.power); assert.equal(p.blastRadius, config.blastRadius);
      assert.equal(p.fuzeTime, 2); assert.equal(supply.rounds, before - 1);
      assert(Math.abs(Math.hypot(p.vx, p.vy) - chargeSpeed(config)) < 1e-7);
      assert(Math.abs(world.vehicle.peakImpulse - config.mass * chargeSpeed(config) * config.recoilFactor) < 1e-7);
      shots.push({ impulse: world.vehicle.peakImpulse, power: p.power, mass: world.vehicle.mass, cooldown: installed.reload });
    }
    assert(shots[0].impulse < shots[1].impulse); assert.equal(shots[0].power, shots[1].power);
    assert.equal(shots[0].mass, shots[1].mass); assert(shots[0].cooldown > 0); assert.equal(shots[0].cooldown, shots[1].cooldown);
  }
});

test('direct controls choose every model-specific charge and replay its exact value; a level the model lacks is laid as its nearest one', t => {
  for (const [preset, count] of Object.entries(counts)) {
    const blueprint = createStructuredTemplate('mortar', { preset }),
      world = new World(blueprint); t.after(() => world.dispose());
    const gun = world.modules.find(m => m.kind === 'weapon'),
      offered = world.playerWeapon({ platform: 'vehicle', componentId: gun.id }).charges.map(level => level.value);
    assert.equal(offered.length, count);
    for (const value of PROPELLANT_LEVELS) {
      const action = { ...laid(gun, value), phase: 'decision' }, { record } = applyWorldInput(world, 'local', action, { platform: 'vehicle' }),
        expected = offered.includes(value) ? value : settings(preset, { charge: value }).charge;
      assert(offered.includes(expected)); assert.equal(record.charge, expected);
      assert.equal(world.actor('local').weapon.charge, expected);
      // Weapon admission records a periodic bearing in [-PI, PI].
      for (const angle of [record.aimAngle, world.actor('local').weapon.aimAngle])
        assert(Math.abs(Math.atan2(Math.sin(angle - action.aimAngle), Math.cos(angle - action.aimAngle))) < 1e-12);
    }
  }
});

test('default automatic charge round-trips while saved explicit charges and free-bearing safety remain intact', t => {
  const blueprint = createConstruction('howitzer'), world = new World(blueprint); t.after(() => world.dispose());
  const gun = world.modules.find(m => m.kind === 'weapon'), command = { type: 'aim', phase: 'before', platform: 'vehicle',
    componentId: gun.id, aim: { x: gun.x - 30, y: gun.y } },
    first = applyWorldInput(world, 'local', command, { platform: 'vehicle' }),
    repeated = applyWorldInput(world, 'local', first.record, { platform: 'vehicle' });
  assert.equal(first.record.charge, 'auto'); assert.deepEqual(repeated.record, first.record);
  assert.equal(world.actor('local').weapon.charge, 'auto');
  const manual = applyWorldInput(world, 'local', { ...command, charge: .4 }, { platform: 'vehicle' }),
    saved = JSON.parse(JSON.stringify(manual.record));
  assert.equal(saved.charge, .4);
  assert.deepEqual(applyWorldInput(world, 'local', saved, { platform: 'vehicle' }).record, saved);
  assert.throws(() => applyWorldInput(world, 'local', { ...command, charge: 'auto', aimAngle: .8 }), /inválido/);
  assert.equal(settings('m119', { charge: 'auto', aimAngle: .8 }).charge, 1);
});
