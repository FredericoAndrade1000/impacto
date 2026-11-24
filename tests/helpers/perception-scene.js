import { World } from '../../src/physics.ts';
import { validateBlueprint } from '../../src/persistence.ts';
import { Terrain } from '../../src/terrain.ts';
import { closedFrame } from '../../src/lab-constructions.ts';
import { DESIGN_VERSION } from '../../src/persistence.ts';
import { scriptedDecision } from '../../src/squad.ts';
import { vehicleBox, writtenPose, writtenParts } from './designs.js';
import { VEHICLE_ORIGIN } from '../../src/vehicle.ts';
import { componentReference } from '../../src/component-size.ts';

// These are explicit current authors, not a converter for free plates/modules.
// Material grids, masses and sensor bounds come from the Rust compiler. Fixtures
// choose their geometry in metres; rideHeight is only a fixture layout argument.
export function boxBlueprint({ length = 4.3, height = 2.1, rideHeight = .55,
  thicknessMm = 100, preset = 'bunker', components = [], name = 'Sensor fixture', model } = {}) {
  if (preset === 'vehicle') return vehicleBox({ length, height, thicknessMm, components, name, ...(model && { model }) });
  const floor = rideHeight - VEHICLE_ORIGIN.y;
  return { version: DESIGN_VERSION, preset, name, seed: 77, components: writtenParts(components),
    ...closedFrame([[-length / 2, floor], [length / 2, floor], [length / 2, floor + height], [-length / 2, floor + height]],
      ['floor', 'rear', 'roof', 'front'], () => ({ material: 'steel', thicknessMm })) };
}

export function emptyBlueprint() {
  return boxBlueprint({ length: .2, height: .2, rideHeight: .15, thicknessMm: 5, components: [] });
}

export function instrumentBlueprint({ mode = 'visual', command = false, modes = mode ? [mode] : [], y = 2 } = {}) {
  const length = Math.max(4, modes.length * .7 + 1),
    source = boxBlueprint({ length, height: y + .2, rideHeight: .15, thicknessMm: 20 });
  source.components = modes.map((sensorMode, i) => {
    const { height } = componentReference({ kind: 'sensor', sensorMode });
    return { id: 'sensor-' + sensorMode, kind: 'sensor', sensorMode,
      ...(sensorMode === 'radar' ? { radarModel: 'mobile' } : {}),
      pose: writtenPose({ x: i * .7, y: y + .2 + .15 - VEHICLE_ORIGIN.y + .01 + height / 2 + .015, angle: 0 }) };
  });
  // A command post sees out of its box through glass: the walls before and behind it are windows.
  if (command) {
    source.components.push({ id: 'command', kind: 'command',
      pose: writtenPose({ x: -.05, y: y - 1.375, angle: 0 }) });
    for (const plate of source.plates) if (['hull:front', 'hull:rear'].includes(plate.id)) plate.material = 'glass';
  }
  return validateBlueprint(source);
}

// A target on wheels, light enough for its chassis to carry; without an engine it does not drive itself.
export function targetBlueprint({ engine = false } = {}) {
  const source = boxBlueprint({ preset: 'vehicle', thicknessMm: 10 });
  if (engine) source.components.push({ id: 'engine', kind: 'engine',
    pose: writtenPose({ x: .55, y: .905 - VEHICLE_ORIGIN.y + .675, angle: 0 }) });
  return validateBlueprint(source);
}

export function coverBlueprint({ top = 8 } = {}) {
  return validateBlueprint(boxBlueprint({ length: .1, height: top - .15, rideHeight: .15, thicknessMm: 20 }));
}

export function crestTerrain(hiddenHeight = 0) {
  const terrain = new Terrain('hills');
  for (const p of terrain.points) p.y = p.x >= 6 && p.x < 8 ? (p.x - 6) * 3 : p.x >= 8 && p.x < 10 ? 6 :
    p.x >= 10 && p.x < 14 ? (14 - p.x) * 1.5 : p.x >= 16 && p.x <= 60 ? hiddenHeight : 0;
  return terrain;
}

export async function perceptionScene(t, { distance = 300, target = true, targetEngine = false, facing = 1,
  weather = 'clear', terrain, blocked = false, partial = false, ...hardware } = {}) {
  const world = new World(emptyBlueprint(), { visualEvents: false, scene: { weather } });
  t.after(() => world.dispose());
  world.removeActor('local');
  if (terrain) world.terrain = terrain; // Cold scene input, before any native admission or observation.
  world.addActor(instrumentBlueprint(hardware), { id: 'own', ownerId: 'blue', x: 0, facing });
  if (target) world.addActor(targetBlueprint({ engine: targetEngine }), { id: 'enemy', ownerId: 'red', x: distance, facing: -1 });
  // With the camera actually mounted above the roof, 1.9 m no longer masks
  // most of a target. This cover exposes only the top silhouette samples.
  if (blocked || partial) addCover(world, distance / 2, partial ? 2.4 : 8);
  world.game();
  return world;
}

export function addCover(world, x, top = 8, id = 'cover') {
  return world.addActor(coverBlueprint({ top }), { id, ownerId: id, x, facing: -1 });
}
export const instrument = (world, mode, actorId = 'own') => world.modules.find(m => m.actorId === actorId &&
  (mode === 'command' ? m.kind === 'command' : m.kind === 'sensor' && m.sensorMode === mode));
export function health(world, module, value) {
  const game = world.game();
  game.call({ op: 'setPartState', owner: game.handle(module), state: { health: value } });
}
export function frames(world, count = 1) { for (let i = 0; i < count; i++) world.step(); }
export function until(world, time) { frames(world, Math.max(0, Math.round((time - world.time) * 60))); }
export function moveTarget(world, state, actorId = 'enemy') { world.game().call({ op: 'setVehicleState', actorId, state }); }
export const controls = (world, actorId = 'own') => {
  const actor = world.actor(actorId);
  return structuredClone({ aim: actor.aim, weapon: actor.weapon, trigger: actor.trigger,
    throttle: actor.vehicle?.throttle, brake: actor.vehicle?.brake, shots: actor.stats.shots });
};

// What the sensors of an observer's side hold of a target, as the rule pilot of the observer, ordered onto that
// target, decides by it: the contact of its decision. Of a target it holds nothing of, or too little to act on, that
// is no contact.
export const sensed = (world, observerId, targetId) => scriptedDecision(world, observerId, world.bounds, targetId).contact;
