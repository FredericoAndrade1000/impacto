import weights from './objective.json' with { type: 'json' };
export const SCORE_VERSION = weights.version;
export type EpisodeOutcome = 'duel-win' | 'duel-loss' | 'duel-draw' | 'base-captured' | 'base-lost' | 'horizon';
export const REWARDS = ['standard', 'discovery'] as const;
export type Reward = typeof REWARDS[number];

// Terminal objectives outrank any amount of stock or recoverable construction
// value. A four-faction capture is a local objective, not an arena victory.
export function episodeScore(outcome: EpisodeOutcome, initialCapital: number, finalCapital: number, discovery = 0): number {
  if (![initialCapital, finalCapital, discovery].every(Number.isFinite) || discovery < 0 || discovery > 1)
    throw new Error('Invalid episode capital or discovery progress.');
  const objective = outcome === 'duel-win' ? 2 : outcome === 'duel-loss' ? -2 :
    outcome === 'base-captured' ? 1 : outcome === 'base-lost' ? -1 : 0;
  // Even saturated capital + all discovery bonuses stay below a local capture.
  return objective + weights.capitalWeight * Math.tanh((finalCapital - initialCapital) / 100000) + weights.discoveryWeight * discovery;
}
