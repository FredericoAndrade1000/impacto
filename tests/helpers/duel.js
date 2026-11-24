import { World } from '../../src/physics.ts';
import { createConstruction } from '../../src/construction-templates.ts';

// Two constructions face to face on a ground of their own, put there as src/benchmark-world.ts puts its six: an empty
// construction opens the world and leaves it, and 'local' stands `separation` metres from 'opponent', each facing the
// other, 'local' on the left unless `swapSides`. The ground is a test track, or a landscape drawn from `seed` over
// `mapLength` metres about X = 12, under `weather`. What else the world is made with is the world's own (`options`).
// The world goes with the test `t`; without one, the caller disposes of it.
export function duel(t, blueprint, { opponent = blueprint, terrain = 'flat', seed = 6173, mapLength, weather = 'clear', separation = 36,
  swapSides = false, ...options } = {}) {
  const arena = createConstruction('empty'); arena.terrain = terrain; arena.seed = seed;
  const world = new World(arena, { ...options, scene: { seed, mapLength, center: 12, weather } }), side = swapSides ? -1 : 1;
  t?.after(() => world.dispose());
  world.removeActor('local');
  world.addActor(blueprint, { id: 'local', ownerId: 'local', x: 12 - side * separation / 2, facing: side });
  world.addActor(opponent, { id: 'opponent', ownerId: 'opponent', x: 12 + side * separation / 2, facing: -side });
  return world;
}
