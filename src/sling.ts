import type { World } from './physics.ts';
import type { SceneTow } from './scene-contract.ts';

export interface SlungLoad { tow: SceneTow; id: string; mass: number; depth: number }

// A vehicle with a thruster that works takes another up on a sling (game_towing.rs `Tow::sling`): a cable from a hook on
// its frame under its centre of mass to a ring a bridle holds over the centre of mass of the load. The field decides; the
// page, the server and the pilots only read it here.

// The longest sling, in metres (game_towing.rs `SLING_REACH`). What an aircraft may take up on one is its pilot's to
// reckon (squad.ts `slingLimit`), as the field does.
export const SLING_REACH = 15;
const GRAVITY = 9.81;
// The most, in m/s², its flight computer speeds an aircraft and its load up or slows them down by along the field
// (game_hover.rs `SLUNG`).
export const SLING_BRISK = .15 * GRAVITY;

// What an aircraft holds up on a sling, as the field tells it: the cable, the load and its mass, and how far under where
// the aircraft stands (`vehicle.y`) the lowest of the load hangs on it plumb — its hook, the cable and, under the ring, the
// load to its lowest point. Null on none.
export function slung(world: Pick<World, 'tows' | 'actor' | 'actorBounds'>, id: string): SlungLoad | null {
  const tow = world.tows?.find(tow => tow.actorId === id && tow.sling);
  if (!tow) return null;
  const vehicle = world.actor(id)?.vehicle, load = world.actor(tow.targetId)?.vehicle;
  if (!vehicle || !load) return null;
  const bottom = world.actorBounds(tow.targetId).minY;
  return { tow, id: tow.targetId, mass: load.mass, depth: vehicle.y - tow.anchorA.y + tow.length + tow.anchorB.y - bottom };
}
