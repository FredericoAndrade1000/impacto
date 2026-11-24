import type { CommanderObservation } from './commander-contract.ts';

export const ROUTE_RETRY_SECONDS = 180;
export const commanderRouteKey = (depositId: string): string => `route:${depositId}`;

// Shared civilian/recovery safety uses only the faction's known risks and bases.
// Combat missions deliberately have their own bounded approach rules.
export function safeCommanderRoute(o: CommanderObservation, from: number, to = from): boolean {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  return !o.danger.some(span => span.lo <= hi && span.hi >= lo) &&
    !o.bases.some(base => base.id !== o.factionId && base.x - base.radius <= hi && base.x + base.radius >= lo);
}
