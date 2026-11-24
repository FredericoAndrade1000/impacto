import { phrase, translate } from './i18n.ts';
// Manufacturing allowances belong to the faction, including unfinished field work.
export const CONSTRUCTION_LIMITS = Object.freeze({ vehicles: 12, fixed: 32 });
export const MAX_FACTION_CONSTRUCTIONS = CONSTRUCTION_LIMITS.vehicles + CONSTRUCTION_LIMITS.fixed;
// How many rounds a faction may have in the air on the shared field, and how many of its own each of its constructions
// may always have there however many the faction has (native core, game_shot_budget.rs): a gun of a faction at its
// share waits for some to come down, its round unspent.
export const SHOT_BUDGET = Object.freeze({ faction: 1024, own: 4 });

// Only a vehicle replaces another, and it takes that one's place: it needs no new place, even in a fleet kept from
// before these limits.
export interface ConstructionCounts { vehicles: number; fixed: number }
export function constructionLimitMessage(counts: ConstructionCounts, vehicle: boolean, replacing = false) {
  if (replacing) return null;
  const kind = vehicle ? 'vehicles' : 'fixed', limit = CONSTRUCTION_LIMITS[kind];
  return counts[kind] >= limit ? phrase`Limite: ${limit} ${phrase(vehicle ? 'veículos' : 'estruturas')} por facção.` : null;
}
export const constructionLimitReason = (counts: ConstructionCounts, vehicle: boolean, replacing = false) => translate(constructionLimitMessage(counts, vehicle, replacing) ?? '');
