import { createConstruction } from './construction-templates.ts';
import { World } from './physics.ts';

export function createBenchmarkWorld(options: ConstructorParameters<typeof World>[1] = {}): World {
  const arena = createConstruction('empty');
  arena.name = 'Ensaio de desempenho'; arena.terrain = 'mixed';
  const world = new World(arena, options), blueprint = createConstruction('heavy');
  world.removeActor('local');
  for (let i = 0; i < 6; i++) world.addActor(blueprint, {
    id: 'bench-' + i, ownerId: i < 3 ? 'blue' : 'red', x: 12 + i * 12,
  });
  world.game();
  return world;
}
