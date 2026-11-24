import { WRECK_SECONDS } from './economy.ts';
import { releaseWorldInputs } from './episode-input.ts';
import type { World } from './physics.ts';
import type { SceneActor } from './scene-contract.ts';

// What becomes of a construction put out of action, on the shared field (server/room.ts) and on the proving ground
// (trial-targets.ts) alike: every screen darkens the wreck. Its fire remains the core's shared fire.

// The constructions with no command post that works: one whose posts were all destroyed, as one that has none. Such a
// construction is out of action: it takes no orders and is no target.
export function uncommanded(world: Pick<World, 'modules' | 'actors'>): string[] {
  const posted = new Set<string>();
  for (const m of world.modules) if (m.kind === 'command' && m.health > 0) posted.add(m.actorId);
  return world.actors.filter(actor => !posted.has(actor.id)).map(actor => actor.id);
}
// Makes a construction a wreck: nobody's, its controls let go and the core told so. What every screen is told of it
// (`actor.field.wreck`): until when it stands, `lasts` from now. Becoming a wreck does not ignite it.
export function makeWreck(world: World, actor: SceneActor, { lasts = WRECK_SECONDS }: { lasts?: number } = {}): { until: number } {
  const time = world.time;
  actor.defeated = true; actor.ownerId = null;
  releaseWorldInputs(world, [actor.id], 1, true, true);
  return { until: time + lasts };
}
