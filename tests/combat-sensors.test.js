import test from 'node:test';
import assert from 'node:assert/strict';
import { SENSOR_MODES, COMMAND_CAMERA_RANGE } from '../src/combat-sensors.ts';
import { weaponSettings } from '../src/weapons.ts';
import { perceptionScene, instrument, health, until, moveTarget, sensed } from './helpers/perception-scene.js';

const contact = async (t, options) => sensed(await perceptionScene(t, options), 'own', 'enemy');

test('compiled hardware distinguishes detection, estimates and optical identification at 350–4000 m', async t => {
  assert.equal(COMMAND_CAMERA_RANGE, 650); assert.equal(SENSOR_MODES.visual.range, 4000);
  assert.equal(SENSOR_MODES.radar.range, 8000);
  // The 4.3 × 2.1 m box has 10 mm plates. Its visible height also includes the real chassis profile and suspension
  // pose, rather than a nominal deck height. That silhouette extends the command post's 220 m identification range,
  // but stays below 350 m; a dedicated camera's 1500 m identification ceiling does not grow with a large silhouette.
  const basic = await contact(t, { mode: null, command: true, distance: 350 }),
    dedicatedWorld = await perceptionScene(t, { distance: 350 }), dedicated = sensed(dedicatedWorld, 'own', 'enemy'),
    far = await contact(t, { distance: 1600 }),
    roof = dedicatedWorld.plates.find(plate => plate.actorId === 'enemy' && plate.id.endsWith('hull:roof')),
    wheels = dedicatedWorld.modules.filter(module => module.actorId === 'enemy' && module.kind === 'wheel'),
    targetHeight = Math.max(...roof.nodes.map(node => node.y)) - Math.min(...wheels.map(wheel => wheel.y - wheel.height / 2));
  assert.equal(basic.classification, 'estimated'); assert.equal(basic.identified, false);
  assert.equal(dedicated.classification, 'identified'); assert.equal(dedicated.identified, true);
  assert(Math.abs(dedicated.width - 4.31) < 1e-9); assert(Math.abs(dedicated.height - targetHeight) < 1e-9);
  assert.equal(far.classification, 'estimated'); assert.equal(far.width, 4); assert.equal(far.height, 3);
  assert.equal((await contact(t, { distance: 800 })).identified, true);
  assert.equal((await contact(t, { distance: 1490 })).identified, true);
  assert.equal((await contact(t, { distance: 1510 })).identified, false);
  assert.equal((await contact(t, { distance: 3990 })).detected, true);
  assert.equal((await contact(t, { distance: 4100 })).detected, false);
  assert.equal((await contact(t, { distance: 700, mode: null, command: true })).detected, false);
});

test('optical range and uncertainty degrade with weather while radar remains an imprecise LOS estimate', async t => {
  const near = await contact(t), far = await contact(t, { distance: 600 }), haze = await contact(t, { distance: 600, weather: 'haze' });
  assert(far.uncertainty > near.uncertainty); assert(haze.uncertainty > far.uncertainty);
  assert.equal((await contact(t, { distance: 3000, weather: 'haze' })).detected, true);
  assert.equal((await contact(t, { distance: 3400, weather: 'haze' })).detected, false);
  assert.equal((await contact(t, { distance: 2000, weather: 'mist' })).detected, false);
  assert.equal((await contact(t, { mode: null, command: true, weather: 'mist' })).detected, false);
  const radar = await contact(t, { distance: 600, mode: 'radar' });
  assert.deepEqual(radar, await contact(t, { distance: 600, mode: 'radar', weather: 'mist' }));
  assert.equal(radar.classification, 'estimated'); assert.equal(radar.identified, false);
  assert.equal(radar.width, 0); assert.equal(radar.height, 0); assert(radar.uncertainty > 5); assert.notEqual(radar.x, 600);
  assert.equal((await contact(t, { distance: 7900, mode: 'radar' })).detected, true);
  assert.equal((await contact(t, { distance: 8100, mode: 'radar' })).detected, false);
  assert.equal((await contact(t, { distance: 600, mode: 'radar', blocked: true })).detected, false);
});

test('real partial cover reveals only visible silhouette samples, never dimensions behind a wall', async t => {
  const seen = await contact(t, { partial: true });
  assert(seen.detected); assert.equal(seen.classification, 'detected'); assert.equal(seen.identified, false);
  assert.equal(seen.width, 0); assert.equal(seen.height, 0);
  assert.equal((await contact(t, { blocked: true })).classification, 'none');
});

test('sound requires a real shot and never supplies size, exact position or mechanical velocity', async t => {
  const world = await perceptionScene(t, { distance: 600, mode: 'sound' });
  assert.equal(sensed(world, 'own', 'enemy').detected, false);
  world.game().call({ op: 'configureLauncher', actorId: 'enemy', point: { x: 600, y: 4 } });
  assert(world.fire({ x: 600, y: 40 }, weaponSettings('machinegun', { preset: 'fnmag', platform: 'ground', spread: 0 }), true, 'enemy'));
  until(world, .5);
  const first = sensed(world, 'own', 'enemy');
  assert.equal(first.source, 'team'); assert.equal(first.channel, 'sound'); assert.equal(first.classification, 'detected'); assert.equal(first.identified, false);
  assert(first.uncertainty >= 179); assert.notEqual(first.x, 600); assert.equal(first.width, 0); assert.equal(first.height, 0);
  moveTarget(world, { x: 630, vx: 80, vy: 60 }); until(world, 1);
  const next = sensed(world, 'own', 'enemy'); assert.equal(next.vx, 0); assert.equal(next.vy, 0);
  for (const key of ['enemyModules', 'health', 'fuelLitres']) assert(!Object.hasOwn(next, key));
  const quiet = await perceptionScene(t, { distance: 600, mode: 'sound', targetEngine: true });
  assert.equal(sensed(quiet, 'own', 'enemy').detected, false, 'an idling engine is weaker than a gunshot');
});

test('camera changes respect polling and destroyed hardware only returns aging measurements before expiry', async t => {
  // Past the silhouette-dependent identification range of the command post: alone, it estimates the target.
  const world = await perceptionScene(t, { command: true, distance: 350 }), first = sensed(world, 'own', 'enemy');
  assert.equal(first.classification, 'identified'); until(world, .05);
  const cached = sensed(world, 'own', 'enemy');
  assert.equal(cached.x, first.x); assert.equal(cached.y, first.y); assert.equal(cached.time, first.time);
  assert(cached.age > first.age, 'cached measurement ages before the next 100 ms poll');
  health(world, instrument(world, 'visual'), 0); until(world, .12);
  const basic = sensed(world, 'own', 'enemy');
  assert.equal(basic.classification, 'estimated'); assert.notEqual(basic.x, first.x); assert(basic.time > first.time);
  health(world, instrument(world, 'command'), 0); moveTarget(world, { x: 400 }); until(world, .4);
  const remembered = sensed(world, 'own', 'enemy');
  assert.equal(remembered.source, 'memory'); assert.equal(remembered.x, basic.x); assert.equal(remembered.time, basic.time);
  assert.equal(remembered.identified, false); assert(remembered.age > 0);
  assert(remembered.uncertainty > basic.uncertainty); assert(remembered.confidence < basic.confidence);
  until(world, 2.3); assert.equal(sensed(world, 'own', 'enemy').classification, 'none');
});
