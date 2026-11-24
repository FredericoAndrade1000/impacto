import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { Terrain } from '../src/terrain.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { rehearsal } from '../server/room.ts';
import { chapters } from '../server/fog.ts';
import { setVehicle } from './mechanical-queries.js';

// How far the rim of a wheel stands off the ground as a page draws it, square to the ground: from its axle to the
// nearest of the outline, less its radius. Under nothing but the core's own margin a wheel would hang that far over it.
function clearance(terrain, { x, y, height }) {
  let least = Infinity;
  for (let i = terrain.segmentIndex(x - height); i <= terrain.segmentIndex(x + height); i++) {
    const a = terrain.points[i], b = terrain.points[i + 1], dx = b.x - a.x, dy = b.y - a.y,
      t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
    least = Math.min(least, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return least - height / 2;
}
const wheels = (modules, actorId) => modules.filter(m => m.kind === 'wheel' && m.actorId === actorId);
// How far the bumps of each ground (game_terrain.rs `Bumps`) stand off the line it is drawn by, at most: a rim stands
// on them, and a page does not draw them.
const BUMPS = { concrete: 0, asphalt: 0, graded: .0075, gravel: .0175, sand: .03, soil: .035, mud: .065, rock: .15 };

for (const design of ['scout', 'truck']) for (const surface of ['concrete', 'rock'])
  test(`${design}: every wheel stands with its rim on the ${surface} on every grade, left there and driven along it`, t => {
  const reach = BUMPS[surface];
  for (const degrees of [0, 10, 17, 25]) {
    const world = new World(createConstruction(design), { visualEvents: false }), grade = Math.tan(degrees * Math.PI / 180);
    t.after(() => world.dispose());
    world.terrain = new Terrain('rough');
    for (const p of world.terrain.points) p.y = Math.fround(grade * (p.x - 12));
    world.terrain.sectors = [{ start: -1600, end: 1600, surface }];
    world.game();
    // The terrain replaced the level spawn: leave the hull parallel to the actual grade,
    // above it, rather than burying the uphill wheels before the first solve.
    setVehicle(world, { x: 12, y: world.terrain.height(12) + 1.5, angle: Math.atan(world.terrain.surface(12).slope),
      vx: 0, vy: 0, omega: 0 });
    for (let i = 0; i < 240; i++) world.step();
    for (const wheel of wheels(world.modules, 'local')) {
      const gap = clearance(world.terrain, wheel);
      assert(Math.abs(gap) < reach + .001, `${degrees}°, left: ${gap}`);
    }
    for (const throttle of [1, -1]) {
      world.controlVehicle(throttle);
      for (let i = 0; i < 120; i++) {
        world.step();
        for (const wheel of wheels(world.modules, 'local')) {
          const gap = clearance(world.terrain, wheel);
          // Driven over bumps, a wheel may leave one for a moment, by no more than a couple of centimetres.
          assert(Math.abs(gap) < reach + (reach ? .02 : .005), `${degrees}°, driven at ${throttle}: ${gap}`);
        }
      }
    }
  }
});

// The field as the server tells it: a scout of one faction left on a grade of the main world, and a recon of another
// beside it. Its own faction is told it whole, the other as it shows from outside (fog.ts): both are told its wheels
// where the core has them, and a page draws each with its rim on the ground it grows from the same seed, as far off its
// line as the bumps of that ground stand.
test('on the field, the faction of a construction and one that sees it are both told its wheels on the ground', t => {
  const room = rehearsal([0, 400]), world = room.world, [ana, bia] = ['Ana', 'Bia'].map(name => room.join(name));
  t.after(() => world.dispose());
  const publish = (player, model) => { room.players.get(player.playerId).builtAt = -Infinity; return room.publish(player.playerId, createConstruction(model)).actor.id; },
    scout = publish(ana, 'scout'), recon = publish(bia, 'recon'), terrain = world.terrain,
    angle = x => Math.atan(terrain.surface(x).slope), steady = x => [-4, 4].every(dx => Math.abs(angle(x + dx) - angle(x)) < .02);
  // The first stretch of a steady grade of about seventeen degrees out from the first base.
  let x = 0;
  while (!(Math.abs(Math.abs(angle(x)) - 17 * Math.PI / 180) < .01 && steady(x))) x++;
  const place = (id, at) => setVehicle(world, { x: at, y: terrain.height(at) + 1.5, vx: 0, vy: 0, angle: angle(at), omega: 0 }, id);
  place(scout, x); place(recon, x + 40);
  for (let i = 0; i < 240; i++) room.step();
  const state = world.snapshot(), page = new Terrain(state.terrain, state.terrainSettings);
  for (const team of [world.actor(scout).team, world.actor(recon).team]) {
    const told = room.audience(state, chapters(state), [], team).state, seen = wheels(told.modules, scout);
    assert.equal(seen.length, wheels(world.modules, scout).length, `${team} sees the scout`);
    for (const wheel of seen) {
      const gap = clearance(page, wheel), core = world.modules.find(m => m.id === wheel.id);
      assert(Math.abs(wheel.x - core.x) < 1e-6 && Math.abs(wheel.y - core.y) < 1e-6, `${team} is told the wheel where the core has it`);
      assert(Math.abs(gap) < BUMPS[page.groundAt(wheel.x)] + .001, `${team}: ${gap} on ${page.groundAt(wheel.x)}`);
    }
  }
});
