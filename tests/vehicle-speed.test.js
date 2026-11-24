import test from 'node:test';
import assert from 'node:assert/strict';
import { number, count, speed, power, specificPower, volume, litres, distance } from '../src/format.ts';
import { vehicleSpeed } from '../src/vehicle-speed.ts';

test('display units use Brazilian decimals and convert engine power without changing its value', () => {
  assert.equal(number(12345.678), '12.345,7'); assert.equal(count(12345.678), '12.346');
  assert.equal(number(-.001), '0'); assert.equal(number(NaN), '—');
  assert.equal(power(.7456998715822702), '1 hp'); assert.equal(power(180), '241 hp');
  assert.equal(specificPower(180, 10), '24,1 hp/t');
  assert.equal(speed(10), '36 km/h'); assert.equal(speed(-10), '36 km/h');
  assert.equal(speed(-.001), '0 km/h');
  assert.equal(volume(4.72), '4,7 m³'); assert.equal(volume(.04), '0,04 m³');
  assert.equal(litres(1234.2), '1.234 L');
  assert.equal(distance(950), '950 m'); assert.equal(distance(12345), '12,3 km');
});

test('speed follows the vehicle on slopes, says whether it is under way and reports reverse relative to its facing', () => {
  const actor = { id: 'truck', name: 'Caminhão', facing: 1, vehicle: { enabled: true, vx: 8, vy: 6 } },
    state = { actors: [actor] }, before = structuredClone(state);
  assert.deepEqual(vehicleSpeed(state, 'truck'), { speed: '36 km/h', moving: true, reverse: false });
  assert.deepEqual(state, before, 'reading the vehicle gives it no order and changes no simulation state');
  actor.vehicle.vx = -8;
  assert.equal(vehicleSpeed(state, 'truck').reverse, true);
  actor.facing = -1;
  assert.equal(vehicleSpeed(state, 'truck').reverse, false);
  Object.assign(actor.vehicle, { vx: -.1, vy: 0 });
  assert.deepEqual(vehicleSpeed(state, 'truck'), { speed: '0,4 km/h', moving: false, reverse: false }, 'creeping under half a kilometre an hour is standing');
});

test('the speed is not invented for a missing, fixed, wrecked or stale vehicle', () => {
  assert.equal(vehicleSpeed(null, 'truck'), null);
  assert.equal(vehicleSpeed({ actors: [] }, 'truck'), null);
  for (const extra of [{ ghost: { since: 1 } }, { defeated: true }])
    assert.equal(vehicleSpeed({ actors: [{ id: 'truck', vehicle: { enabled: true, vx: 2 }, ...extra }] }, 'truck'), null);
  for (const vehicle of [null, { enabled: false }, { enabled: true, vx: NaN }, { enabled: true, vx: 2, vy: Infinity }])
    assert.equal(vehicleSpeed({ actors: [{ id: 'truck', vehicle }] }, 'truck'), null);
});

// An aircraft sent home hangs all but still over its place before it is let down there, the higher the longer, and turns
// from one way to the other at no speed for a moment: the dock tells its speed all the while it is on its way, and of one
// coming straight down, how fast it falls. In the air it flies either way without turning about: it never backs.
test('an aircraft on its way home has its speed told whichever way it goes, hanging still over its place, and never backs', () => {
  const aircraft = { id: 'air', preset: 'vehicle', facing: 1, vehicle: { x: 0, y: 30000, vx: .0004, vy: 0, flying: true } },
    state = { actors: [aircraft], squad: { manual: null, units: [{ id: 'air', move: { x: 0, land: 'fuel' } }] } };
  assert.deepEqual(vehicleSpeed(state, 'air'), { speed: '0 km/h', moving: true, reverse: false }, 'hanging over its place on its way home');
  Object.assign(aircraft.vehicle, { vx: 0, vy: -52 });
  assert.deepEqual(vehicleSpeed({ actors: [aircraft] }, 'air'), { speed: '187,2 km/h', moving: true, reverse: false }, 'falling straight down, with no order');
  Object.assign(aircraft.vehicle, { vx: -40, vy: 0 });
  assert.equal(vehicleSpeed(state, 'air').reverse, false, 'flying the other way from the way it faces');
  assert.equal(vehicleSpeed({ actors: [{ ...aircraft, vehicle: { ...aircraft.vehicle, flying: false, vx: -4 } }] }, 'air').reverse, true, 'on its skids it backs');
  // Done with its way, it stands for the dock as any other.
  Object.assign(aircraft.vehicle, { vx: .0004 }); state.squad.units[0].move = null;
  assert.equal(vehicleSpeed(state, 'air').moving, false);
});

test('the public vehicle pose already carries speed while the squad is commanded', () => {
  const state = { actors: [{ id: 'truck', name: 'Caminhão', preset: 'vehicle', vehicle: { x: 10, y: 1, vx: 5, vy: 0 } }] };
  assert.equal(vehicleSpeed(state, 'truck').speed, '18 km/h');
});
