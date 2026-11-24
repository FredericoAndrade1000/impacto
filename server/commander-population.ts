import { FIXED_DT } from '../src/physics.ts';
import { COMMANDER_LIMIT } from './worker-contract.ts';
import type { FieldHost } from './field-host.ts';

export const COMMANDER_FILL_INTERVAL = 60;

// New identities use the normal join/kit path. Names are merely presentation;
// existing seats, including defeated and paused commanders, keep their identity.
export function addNamedCommander(host: FieldHost) {
  let ordinal = 1;
  for (;;) {
    const name = `Comandante IA ${ordinal}`;
    try { host.room.nameFree(name); }
    catch (error) {
      if (!(error instanceof Error && 'nameTaken' in error && error.nameTaken === true)) throw error;
      ordinal++; continue;
    }
    return host.addCommander(name);
  }
}

// Operational scheduling belongs to this live host, never to Room's replayed
// decisions. Each actual creation is a normal external FieldHost diary event.
// Restarting delays the first attempt again; it never advances a grant deadline.
export function commanderPopulation(host: FieldHost, minimum: number): () => void {
  let nextAt = host.room.world.time + COMMANDER_FILL_INTERVAL + FIXED_DT;
  return () => {
    const room = host.room, now = room.world.time;
    if (minimum === 0 || room.commanders.size >= COMMANDER_LIMIT || now + 1e-9 < nextAt) return;
    nextAt = now + COMMANDER_FILL_INTERVAL;
    const humans = [...room.players.values()].filter(player => player.connected && !room.commanders.has(player.id)).length,
      active = [...room.commanders.values()].filter(state => state.enabled).length;
    if (humans + active >= minimum) return;
    addNamedCommander(host);
  };
}
