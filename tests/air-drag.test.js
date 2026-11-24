import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nativeRuntimeInfo } from '../scripts/native-dynamics-host.ts';
import { initNativeDynamics, nativeBallisticFlight } from '../src/native-dynamics.ts';
import { firingSolution, flightPath, flightState } from '../src/ballistics.ts';
import { fixedWeapon, weaponSettings, WEAPON_PRESETS } from '../src/weapons.ts';

await initNativeDynamics();

const launcher = { x: 0, y: 400 }, aim = { x: 1000, y: 400 };
const settings = preset => fixedWeapon({ preset, aimAngle: .3, fuzeTime: 3, charge: 1 });

test('air drag uses physical calibre and mass, independent of visual tracer radius', () => {
  const config = settings('m2hb'), original = firingSolution(launcher, aim, config),
    decorated = firingSolution(launcher, aim, { ...config, radius: .12 });
  assert.deepEqual(decorated, original);
  const after = flightState(original, 2), initial = Math.hypot(original.vx, original.vy);
  assert(after.vx < original.vx && Math.hypot(after.vx, after.vy) < initial * .85);
  assert(after.x < original.x + original.vx * 2);
  assert.equal(original.flight.model, 'quadratic-drag-v2');
  assert.equal(original.flight.caliberMm, 12.7);
  assert.throws(() => nativeBallisticFlight({ op: 'solution', launcher, aim,
    settings: { ...config, caliberMm: 0 } }), /caliber/i);
  assert.throws(() => flightState({ x: 0, y: 3, vx: 100, vy: 0, time: 1 }, 1), /flight/i);
});

test('every catalogue family supplies a physical calibre without using its visual radius', () => {
  for (const [preset, model] of Object.entries(WEAPON_PRESETS)) {
    const config = weaponSettings(model.family, { preset });
    assert.equal(config.caliberMm, model.caliberMm);
    assert(Number.isFinite(config.mass) && config.mass > 0);
  }
  for (const id of ['machinegun', 'autocannon', 'cannon', 'rocket', 'grenade', 'mortar', 'howitzer']) {
    const base = weaponSettings(id), changed = weaponSettings(id, { radius: .12 });
    assert.equal(base.caliberMm, changed.caliberMm); assert(base.caliberMm > 0);
  }
});

test('real primary projectiles and the forecast share dragged flight; HE fill remains unchanged', t => {
  const info = nativeRuntimeInfo(), Core = info.runtime === 'native'
    ? createRequire(import.meta.url)(info.binary).NativeWorld : null;
  // This boundary is also exercised via the Wasm binding when that host is selected.
  return (async () => {
    const Binding = Core || (await import('../src/native/battle_dynamics.js')).NativeWorld;
    for (const preset of ['m2hb', 'rh120', 'm224', 'm119']) {
      const config = settings(preset), solution = firingSolution(launcher, aim, config),
        core = new Binding(new Float64Array(), 0, -9.81);
      t.after(() => core.free());
      core.load_game(JSON.stringify({ terrain: 'flat', seed: 61, visualEvents: false,
        actors: [], modules: [], plates: [], bounds: { minX: -5000, maxX: 5000, minY: -10, maxY: 2000 } }));
      // The round is put into the empty scene and flown by its steps: two seconds in the air.
      const command = request => JSON.parse(core.game_command(JSON.stringify(request))).result;
      command({ op: 'projectile', projectile: { ...config, id: 'drag-test', numericId: 17, weapon: config.id,
        x: solution.x, y: solution.y, vx: solution.vx, vy: solution.vy,
        power: config.power, age: 0, flight: solution.flight } });
      for (let i = 0; i < 120; i++) assert.equal(JSON.parse(core.game_step(1 / 60)).shots, 1);
      const [projectile] = command({ op: 'projectiles' });
      assert.equal(projectile.id, 'drag-test');
      const predicted = flightState(solution, 2), path = flightPath(solution, 120, 2).at(-1);
      assert(Math.hypot(projectile.x - predicted.x, projectile.y - predicted.y) < .05, preset + ' forecast versus CCD');
      assert(Math.hypot(projectile.x - path.x, projectile.y - path.y) < .05, preset + ' preview versus CCD');
      assert(Math.abs(projectile.vx - predicted.vx) < .05);
      if (config.ammo === 'he') assert.equal(projectile.power, config.power, 'drag cannot reduce explosive fill');
      else assert(projectile.power < config.power);
    }
  })();
});

test('dragged assisted arcs reach the requested point at mirrored artillery distances', () => {
  for (const [preset, distance] of [['m224', 200], ['m119', 700], ['m777', 1000]]) {
    for (const side of [-1, 1]) {
      const target = { x: side * distance, y: 2 }, config = fixedWeapon({ preset, trajectory: 'high', charge: 1 }),
        solution = firingSolution({ x: 0, y: 2 }, target, config);
      assert(solution.reachable, preset + ':' + side);
      const end = flightPath(solution, 512).at(-1);
      assert(Math.hypot(end.x - target.x, end.y - target.y) < .1, preset + ' long arc');
    }
  }
});
