import { absent, literal, numeric, object, optional, textual, tuple, union } from './wire-shape.ts';
import type { Guard } from './wire-shape.ts';

interface DuelStart { sides: [string, string]; since: number }
export type Duel = DuelStart & (
  | { phase: 'playing' }
  | { phase: 'won'; at: number; winner: string; loser: string }
  | { phase: 'draw'; at: number }
);
export type DuelView = { phase: 'playing'; since: number } |
  { phase: 'won' | 'lost' | 'draw'; since: number; at: number };

const start = { sides: tuple(textual, textual), since: numeric },
  shape = union(
    object({ ...start, phase: literal('playing'), at: optional(absent), winner: optional(absent), loser: optional(absent) }),
    object({ ...start, phase: literal('won'), at: numeric, winner: textual, loser: textual }),
    object({ ...start, phase: literal('draw'), at: numeric, winner: optional(absent), loser: optional(absent) }),
  );
export const isDuel: Guard<Duel> = (value): value is Duel => shape(value) && value.since >= 0 &&
  value.sides.every(id => id.length > 0 && id.length <= 160) && value.sides[0] !== value.sides[1] &&
  (value.phase === 'playing' || value.at >= value.since) &&
  (value.phase !== 'won' || value.winner !== value.loser && value.sides.includes(value.winner) && value.sides.includes(value.loser));

const viewShape = union(
  object({ phase: literal('playing'), since: numeric, at: optional(absent) }),
  object({ phase: union(literal('won'), literal('lost'), literal('draw')), since: numeric, at: numeric }),
);

export const isDuelView: Guard<DuelView> = (value): value is DuelView => viewShape(value) && value.since >= 0 &&
  (value.phase === 'playing' || value.at >= value.since);

export function duelView(duel: Duel, factionId: string): DuelView {
  return duel.phase === 'playing' ? { phase: 'playing', since: duel.since } :
    { phase: duel.phase === 'draw' ? 'draw' : duel.winner === factionId ? 'won' : 'lost', since: duel.since, at: duel.at };
}

// Shape validation belongs to the save/transport boundary. Room restoration
// also checks these references and clocks against the actual restored field.
export function readDuel(value: Duel | undefined, time: number, factions: ReadonlyMap<string, {
  base: unknown; fell: { at: number; by: string } | null;
}>): Duel | null {
  if (value === undefined) return null;
  if (!isDuel(value) || value.since > time + 1e-6 || value.phase !== 'playing' && value.at > time + 1e-6 ||
    factions.size !== 2 || !value.sides.every(id => factions.has(id))) throw new Error('Duelo salvo inválido.');
  if (value.phase === 'won') {
    const lost = factions.get(value.loser)!;
    if (lost.base || lost.fell?.by !== value.winner || lost.fell.at !== value.at || !factions.get(value.winner)!.base)
      throw new Error('Resultado do duelo incompatível com as bases.');
  } else if (!value.sides.every(id => factions.get(id)!.base)) throw new Error('Duelo salvo sem as duas bases.');
  return structuredClone(value);
}
