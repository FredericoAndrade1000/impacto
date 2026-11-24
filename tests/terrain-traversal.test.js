import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { weaponSettings } from '../src/weapons.ts';

for (const terrain of ['highlands', 'plateau']) for (const direction of [-1, 1])
  test(`${terrain}: a tracked vehicle crosses a full seeded hill in direction ${direction}`, t => {
    for (const seed of [0, 6173, 0xffffffff]) {
      const blueprint = createStructuredTemplate('heavy'), world = new World({ ...blueprint, terrain },
        { visualEvents: false, scene: { seed, mapLength: 1600, center: 12 } });
      try {
        const hills = world.terrain.features.filter(f => ['ridge', 'plateau'].includes(f.kind)),
          hill = hills.reduce((a, b) => a.height > b.height ? a : b),
          start = direction > 0 ? hill.start - 8 : hill.end + 8,
          finish = direction > 0 ? hill.end + 8 : hill.start - 8;
        world.replaceActor(blueprint, { id: 'local', x: start, facing: direction });
        world.controlVehicle(0, 1); for (let i = 0; i < 90; i++) world.step();
        let frames = 0, summit = false, maxGap = 0;
        while (direction * (world.vehicle.x - finish) < 0 && frames < 9000) {
          const speed = direction * world.vehicle.vx;
          if (frames % 6 === 0) world.controlVehicle(direction * Math.max(.05, Math.min(1, (7 - speed) * .5)), speed > 9 ? 1 : 0);
          world.step(); frames++;
          const v = world.vehicle;
          assert(Number.isFinite(v.x + v.y + v.vx + v.vy + v.angle));
          assert(Math.abs(v.angle) < Math.PI / 2, 'reasonable driving must not overturn the carrier');
          if (Math.abs(v.x - hill.peak) < 8) summit = true;
          maxGap = Math.max(maxGap, v.y - world.terrain.height(v.x));
        }
        assert(direction * (world.vehicle.x - finish) >= 0,
          `seed ${seed} stalled at ${world.vehicle.x.toFixed(1)}; goal ${finish.toFixed(1)}; fuel ${world.vehicle.fuelLitres}`);
        assert(summit); assert(maxGap < 4, 'terrain curves must not launch a careful driver');
        assert.equal(world.dynamics.recoveries, 0);
        t.diagnostic(`seed ${seed}: ${(Math.abs(finish - start)).toFixed(0)} m in ${(frames / 60).toFixed(1)} s`);
      } finally { world.dispose(); }
    }
  });

test('workshop landscapes place the original construction above ground and use the whole selected map', t => {
  const blueprint = createStructuredTemplate('heavy'), world = new World({ ...blueprint, terrain: 'plateau' },
    { scene: { seed: 6173, mapLength: 16000, center: 12 } });
  t.after(() => world.dispose());
  world.setTestDistance(0); const state = world.snapshot();
  assert.equal(world.bounds.minX, -8060); assert.equal(world.bounds.maxX, 8084);
  assert(world.vehicle.y > world.terrain.height(world.vehicle.x));
  assert(world.benchLauncher.y > world.terrain.height(world.benchLauncher.x));
  assert.deepEqual(world.construction.nodes, blueprint.nodes); assert.deepEqual(world.construction.plates, blueprint.plates);
  assert.deepEqual(world.construction.components, blueprint.components);
  assert.equal(state.terrainSettings.length, 16000);
});

test('a vehicle admits directly on a distant valley below the origin altitude', t => {
  const blueprint = createStructuredTemplate('heavy'), world = new World({ ...blueprint, terrain: 'highlands' },
    { visualEvents: false, scene: { seed: 1, mapLength: 16000, center: 12 } });
  t.after(() => world.dispose());
  const valley = world.terrain.points.reduce((a, b) => a.y < b.y ? a : b);
  assert(valley.y < -100);
  world.replaceActor(blueprint, { id: 'local', x: valley.x, facing: 1 });
  assert(world.vehicle.y < valley.y + 2);
  world.controlVehicle(0, 1); for (let i = 0; i < 120; i++) world.step();
  assert(world.vehicle.y > world.terrain.height(world.vehicle.x));
  assert(world.vehicle.y < world.terrain.height(world.vehicle.x) + 2);
  assert.equal(world.dynamics.recoveries, 0);
});

test('weapon input keeps the actual target altitude on high summits and deep valleys', t => {
  const blueprint = createStructuredTemplate('heavy'), world = new World({ ...blueprint, terrain: 'highlands' },
    { visualEvents: false, scene: { seed: 1, mapLength: 16000, center: 12 } });
  t.after(() => world.dispose());
  const low = world.terrain.points.reduce((a, b) => a.y < b.y ? a : b),
    high = world.terrain.points.reduce((a, b) => a.y > b.y ? a : b),
    config = { ...weaponSettings('cannon', { preset: 'rh120', ammo: 'ap' }), platform: 'vehicle' };
  for (const target of [low, high]) {
    const aim = { x: target.x, y: target.y + 2 };
    assert(aim.y < -10 || aim.y > 100);
    world.aimWeapon(aim, config);
    assert.deepEqual(world.actor('local').aim, aim);
  }
});
