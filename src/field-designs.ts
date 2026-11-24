import type { NetworkClient } from './network-client.ts';
import type { CommandResult } from './field-protocol-contract.ts';
import type { DrawingActor } from './scene-drawing-contract.ts';

type DesignNetwork = Pick<NetworkClient, 'faction' | 'playerId' | 'designs' | 'command'>;
type DesignActor = Pick<DrawingActor, 'id' | 'defeated' | 'team' | 'ownerId'>;
export function createFieldDesigns(network: DesignNetwork, rememberConstruction: (result: CommandResult<'blueprint'>) => void) {
  // A design is kept while its construction is of the player's faction: one that became a wreck, left the field or stayed
  // with a faction the player left is forgotten. One of the faction the page was never told of — a defence a constructor
  // raised, one another member built — is asked of the field, once. Before the faction is told, the player's own are those of
  // the player's squad.
  const fielded = new Set<string>(), asked = new Map<string, object>();
  const ours = (actor: DesignActor) => !actor.defeated && (network.faction ? actor.team === network.faction.id : actor.ownerId === network.playerId);
  function forgetLost(actors: readonly DesignActor[]) {
    const current = new Set(actors.filter(ours).map(actor => actor.id));
    // A request belongs to this period of ownership. Returning to the faction
    // can fetch again; a reply from the previous period can no longer restore it.
    for (const id of asked.keys()) if (!current.has(id)) asked.delete(id);
    for (const id of network.designs.keys()) {
      const actor = actors.find(a => a.id === id);
      if (actor && ours(actor)) fielded.add(id);
      else if (actor || fielded.has(id)) { network.designs.delete(id); fielded.delete(id); }
    }
    for (const actor of actors) {
      if (!ours(actor) || network.designs.has(actor.id) || asked.has(actor.id)) continue;
      const request = {};
      asked.set(actor.id, request);
      network.command('blueprint', { actorId: actor.id }).then(result => {
        if (asked.get(actor.id) === request) rememberConstruction(result);
      }, () => {});
    }
  }

  return forgetLost;
}
