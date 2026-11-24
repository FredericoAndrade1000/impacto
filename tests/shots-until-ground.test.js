import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { firingSolution, flightPath } from '../src/ballistics.ts';

// One round from the test bench at a bearing, followed until it is gone.
function flight(t, preset, degrees) {
  const world = new World(createConstruction('empty'), { visualEvents: false }); t.after(() => world.dispose());
  const config = world.playerWeapon({ preset, aimAngle: degrees * Math.PI / 180 });
  assert.equal(world.fire({ x: 100, y: 100 }, config, true), true);
  let apex = -Infinity, last = null, power = Infinity;
  for (let step = 0; step < 240 * 240; step++) {
    const [round] = world.projectiles;
    if (!round) break;
    apex = Math.max(apex, round.y); power = Math.min(power, round.power); last = { x: round.x, y: round.y, age: round.age };
    world.step();
  }
  assert.equal(world.projectiles.length, 0, preset + ' comes to an end');
  return { world, config, apex, last, power };
}

test('a round stays in the air past its catalogue lifetime and a kilometre up until it comes down', t => {
  for (const [preset, degrees] of [['at4', 86], ['m2hb', 88]]) {
    const { world, config, apex, last, power } = flight(t, preset, degrees);
    assert(last.age > config.life * 4, `${preset} outlives its ${config.life} s (${last.age.toFixed(1)} s)`);
    assert(apex > 1000, `${preset} climbs above a kilometre (${apex.toFixed(0)} m)`);
    assert(last.x > world.bounds.minX && last.x < world.bounds.maxX);
    assert(last.y - world.terrain.height(last.x) < 5, `${preset} is last seen at the ground (${last.y.toFixed(2)} m)`);
    // An armour-piercing round is not dropped for being slow at the top of its arc.
    if (['ap', 'apfsds'].includes(config.ammo)) assert(power < .5, `${preset} keeps flying with ${power.toFixed(3)} of power`);
  }
});

test('a round that leaves the field by its side is gone there, not before', t => {
  const { world, last } = flight(t, 'rh120', 20);
  assert(last.y > 100, 'it was still high in the air'); assert(last.x > world.bounds.maxX - 30, `it got to the edge (${last.x.toFixed(0)} m)`);
});

test('the aim assistant follows a low arc longer than the old five seconds', () => {
  const rocket = weaponSettings('rocket', { preset: 'at4', trajectory: 'low' }), aim = { x: 1800, y: 0 },
    solution = firingSolution({ x: 0, y: 2 }, aim, rocket), end = flightPath(solution).at(-1);
  assert.equal(rocket.life, 5); assert(solution.reachable); assert(solution.time > 10);
  assert(Math.hypot(end.x - aim.x, end.y - aim.y) < .05);
});
