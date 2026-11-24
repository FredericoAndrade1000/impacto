import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { driveIntent } from '../src/ui-model.ts';
import { miningWorld } from './helpers/mining-mobility.js';
import { advance, setVehicle } from './mechanical-queries.js';

const speed = vehicle => vehicle.vx * Math.cos(vehicle.groundSlope) + vehicle.vy * Math.sin(vehicle.groundSlope);
const key = direction => direction < 0 ? 'a' : 'd';
function controls(world, keys) {
  const { throttle, brake } = driveIntent({ driveKeys: new Set(keys) });
  world.controlVehicle(throttle, brake);
}
function downhill(t, template, options) {
  const world = miningWorld(createStructuredTemplate(template), { grade: -.3, cargo: null, ...options });
  t.after(() => world.dispose());
  controls(world, [key(options.direction)]); advance(world, 180, { drain: true });
  assert(speed(world.vehicle) * options.direction > 4, 'the native engine and downhill run create real incoming speed');
  return world;
}

for (const [template, cargo] of [['mining-truck', null], ['mining-truck', 'ferro'], ['heavy', null]])
  test(`${template}/${cargo || 'empty'}: the opposite A/D key brakes like S, then drives uphill in either facing`, t => {
    for (const direction of [-1, 1]) for (const facing of [-1, 1]) {
      const options = { direction, facing, cargo }, opposite = downhill(t, template, options), manual = downhill(t, template, options),
        origin = opposite.vehicle.x, incoming = speed(opposite.vehicle) * direction;
      assert(Math.abs(speed(manual.vehicle) * direction - incoming) < 1e-9);
      controls(opposite, [key(-direction)]); controls(manual, ['s']);
      let steps = 0;
      while (speed(manual.vehicle) * direction > .3 && steps++ < 600) {
        advance(opposite, 1, { drain: true }); advance(manual, 1, { drain: true });
        assert(Math.abs(speed(opposite.vehicle) - speed(manual.vehicle)) < 1e-8, 'at travelling speed, both controls use the same physical brake');
        assert.equal(opposite.vehicle.slip, 0, 'braking does not spin the gear against the incoming motion');
        assert.equal(opposite.vehicle.fuelRate, 0, 'braking applies the same fuel policy as S');
      }
      assert(steps < 600, 'the vehicle stops against the downhill grade');
      assert((manual.vehicle.x - origin) * direction > 1, 'the comparison includes a real stopping distance');
      advance(manual, 60, { drain: true });
      assert(Math.abs(speed(manual.vehicle)) < .01, 'S remains a brake when held');
      advance(opposite, 360, { drain: true });
      assert(speed(opposite.vehicle) * direction < -1, 'the held opposite key engages the engine and climbs back');
      assert(opposite.vehicle.fuelRate > 0 && Number.isFinite(opposite.vehicle.fuelRate), 'fuel follows engine work again after engaging the new direction');
      assert(opposite.vehicle.x * direction < manual.vehicle.x * direction - 2, 'the vehicle makes progress in the requested new direction');
      controls(opposite, []); advance(opposite, 180, { drain: true });
      assert(Math.abs(speed(opposite.vehicle)) < .01, 'releasing A/D keeps the existing parking brake');
      assert.equal(opposite.dynamics.recoveries, 0); assert.equal(manual.dynamics.recoveries, 0);
    }
  });

test('a full mining truck can start uphill through a small rollback without repeatedly reapplying its brakes', t => {
  for (const direction of [-1, 1]) for (const facing of [-1, 1]) {
    const world = miningWorld(createStructuredTemplate('mining-truck'), { grade: .5, cargo: 'ferro', direction, facing });
    t.after(() => world.dispose());
    const slope = world.vehicle.groundSlope, start = world.vehicle.x;
    setVehicle(world, { vx: -direction * .06 * Math.cos(slope), vy: -direction * .06 * Math.sin(slope) });
    controls(world, [key(direction)]);
    let departures = 0, moving = false;
    for (let step = 0; step < 600; step++) {
      advance(world, 1, { drain: true });
      const forward = speed(world.vehicle) * direction > .15;
      if (forward && !moving) departures++;
      moving = forward;
    }
    assert.equal(departures, 1, 'the engine makes one continuous departure from rest');
    assert(speed(world.vehicle) * direction > 1 && (world.vehicle.x - start) * direction > 2, JSON.stringify({direction,facing,speed:speed(world.vehicle),distance:world.vehicle.x-start}));
    assert.equal(world.dynamics.recoveries, 0);
  }
});
