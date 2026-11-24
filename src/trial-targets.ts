import { World } from './physics.ts';
import { createConstruction } from './construction-templates.ts';
import { TRIAL_TARGET_OWNER, TRIAL_WORLD, TRIAL_TARGETS } from './battle-rules.ts';
import { uncommanded, makeWreck } from './wreck.ts';
import type { ConstructionSource } from './construction-contract.ts';
import type { TerrainId } from './terrain.ts';

// The vehicle under test stands at X = 12 facing −X: the targets stand in front of it, facing it.
export function placeTrialTargets(world: World): void {
  for (const [i, { template, distance }] of TRIAL_TARGETS.entries()) {
    const actor = world.addActor(createConstruction(template), { id: `alvo-${i}`, ownerId: TRIAL_TARGET_OWNER,
      x: 12 - distance, facing: 1, rest: true, color: '#c96f5b' });
    // Cold initial state, admitted with the rest of the actor: a real parking brake, no fixed/hovering vehicle.
    if (actor.vehicle) actor.vehicle.brake = 1;
  }
  world.game();
}

// What of a test is put out of action is the wreck it would be on the field (wreck.ts), darkened and burning for a
// while, but it stands until the test is restored: there is nobody to clear it away, and it is there to be seen. So is
// a target, and so is the design under test, in either test, once it lost the command posts its design has: nothing of
// it is in the player's hands from then on (ui-model.ts). A design that has none is no wreck: it is being worked on,
// and is tested as it is.
export function wreckTrial(world: World): void {
  for (const id of uncommanded(world)) {
    const actor = world.actor(id);
    if (actor && !actor.defeated && actor.blueprint.modules.some(m => m.kind === 'command')) actor.field = { wreck: makeWreck(world, actor, { lasts: Infinity }) };
  }
}

// The page's own world (simulation-worker.ts): the bench of the workshop away from the field, and the tests of the
// design. It is an open field as the shared one is (server/room.ts): every construction passes through every other
// and is still struck by their rounds, and vehicles are held short of the ends of its ground.
export function pageWorld(blueprint: ConstructionSource, { terrain = null, targets = false }: { terrain?: TerrainId | null; targets?: boolean } = {}): World {
  const world = new World({ ...blueprint, ...(terrain ? { terrain } : {}) }, { enclosed: true, settle: true,
    scene: terrain === TRIAL_WORLD.terrain ? TRIAL_WORLD : {} });
  if (targets) placeTrialTargets(world);
  return world;
}
