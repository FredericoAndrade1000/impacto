// Mechanical tests use the compiled public boundary. These helpers only
// select native diagnostics; they do not recreate solver bodies or formulas.
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';

import { installedModuleMass } from '../scripts/review-harness.ts';

export const physics = world => world.game().call({ op: 'physics' });
// Permanent hull/chassis mass, beyond its measured installed components and their consumable contents.
export const structureMass = (world, actorId = 'local') =>
  physics(world).bodyStates.find(body => body.actor === world.game().actorHandles.get(actorId)).mass - installedModuleMass(world, actorId);
export function ownerState(world, part) {
  return physics(world).owners.find(record => record.owner === world.game().handle(part));
}
export const materialState = (world, part, point, options = {}) => world.game().call({
  op: 'material', owner: world.game().handle(part), point, ...options,
});
export const setVehicle = (world, state, actorId = 'local') => world.command('setVehicleState', { actorId, state });
export const setPart = (world, part, state) => world.command('setPartState', { owner: world.game().handle(part), state });
// Wheels left free. A vehicle let go of holds its brake, so a test that wants one that only
// rolls kills its engines and holds the throttle: nothing pushes it and nothing brakes it.
export function freewheel(world, actorId = 'local') {
  for (const engine of world.modules.filter(m => m.actorId === actorId && m.kind === 'engine')) setPart(world, engine, { health: 0 });
  world.controlVehicle(1, 0, actorId);
}
export const impulse = (world, part, point, value) => world.command('impulse', {
  owner: world.game().handle(part), point: { x: point.x, y: point.y }, impulse: value,
});
export const dent = (world, part, point, depth, radius = .08) => world.command('dent', {
  owner: world.game().handle(part), point, depth, radius,
});
// A round put into the scene as it is told, for the scene's own steps to fly: how a test
// has one that no weapon fired. Returns it as the scene keeps it.
export function placeRound(world, round) {
  const game = world.game();
  return game.call({ op: 'projectile', projectile: game.projectile(round) }).projectile;
}
// That round flown by one step of the scene. Given `seconds`, it carries a fuze with no
// charge and ends after that much flight, so that a test can stop it between two things in
// its path. Returns the round as it flies on, or null once it is spent.
export function flyRound(world, round, seconds) {
  const placed = placeRound(world, seconds === undefined ? round :
    { ...round, fuzeTime: (round.age || 0) + seconds, blastRadius: 0 });
  world.step();
  return world.projectiles.find(p => p.numericId === placed.numericId) || null;
}
export function managedWorld(t, blueprint = createStructuredTemplate('empty'), options) {
  const world = new World(blueprint, options);
  t.after(() => world.dispose()); return world;
}
// `steps` fixed steps of the scene. The events of each step are moved into `events` when it is given, thrown
// away with `drain`, and otherwise left in the world. Returns `events`.
export function advance(world, steps = 1, { events, drain = false } = {}) {
  for (let i = 0; i < steps; i++) {
    world.step();
    if (events) events.push(...world.drainEvents()); else if (drain) world.drainEvents();
  }
  return events;
}
export function wheelPhysics(world, module) {
  const state = physics(world), owner = state.owners.find(record => record.owner === world.game().handle(module));
  return { owner, bodies: state.bodyStates.filter(body => body.handle === owner.body) };
}
