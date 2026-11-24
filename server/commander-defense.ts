import type { CommanderChoice, CommanderObservation, CommanderState } from './commander-contract.ts';
import { activeJob, canGuard, exploring, isDefender, mobilityBlocked, returning } from './commander-units.ts';
import { COUNTER_ERROR } from '../src/squad.ts';

// These anonymous reports are the same uncertain ground fixes available to
// ordinary counter-battery fire. They never identify or locate a hidden actor.
export function needsCounterBattery(o: CommanderObservation): boolean {
  const range = o.offers.find(offer => offer.model === 'mortar')?.artilleryRange ?? 0;
  return Boolean(o.base && baseAlarm(o) && o.batteries.some(mark => o.time >= mark.at && o.time - mark.at <= 60 &&
    mark.error <= COUNTER_ERROR && Math.abs(mark.x - o.base!.x) + mark.error <= range));
}

// The faction's own public capture warning survives loss of its sensors.
// Other alarms require owned combat reports or already perceived threats.
// Recent fire near the yard matters even when the shooter is beyond 1 km.
export function baseAlarm(o: CommanderObservation): boolean {
  return Boolean(o.base && (o.besieged || o.threats.some(threat => (threat.kind === 'signal' || threat.armed !== false) &&
    Math.abs(threat.x - o.base!.x) <= (threat.kind === 'contact' ? 1800 : 1000)) ||
    o.units.some(unit => unit.combatAt !== null && o.time - unit.combatAt <= 20 &&
      Math.abs(unit.x - o.base!.x) <= 1000)));
}

export function chooseBaseDefense(o: CommanderObservation, state: CommanderState): CommanderChoice | null {
  if (!o.base || !baseAlarm(o)) return null;
  const base = o.base, threat = o.threats.filter(threat => (threat.kind === 'signal' || threat.armed !== false) && Math.abs(threat.x - base.x) <= 3000)
    .sort((a, b) => Math.abs(a.x - base.x) - Math.abs(b.x - base.x))[0];
  for (const unit of o.units.filter(unit => isDefender(unit) || unit.artillery && unit.vehicle && unit.armed && !unit.aircraft)) {
    if (!unit.ready || returning(unit) || unit.haul || activeJob(unit) || unit.job?.reason === 'manual-control' || unit.attack) continue;
    const previous = state.orders[unit.id];
    if (unit.moving && !exploring(previous)) continue;
    if (!unit.atBase) {
      if (exploring(previous)) return { action: { kind: 'home', unitId: unit.id }, reason: 'local-defense' };
      continue;
    }
    // Own damage plus a recent anonymous firing report justifies leaving a
    // bombarded position, not identifying or chasing its hidden shooter.
    // Existing history also keeps routine defense from undoing this move.
    if (state.history.some(row => row.result === 'applied' && row.reason === 'evade-fire' &&
      row.action && 'unitId' in row.action && row.action.unitId === unit.id && o.time - row.at >= 0 && o.time - row.at < 30)) continue;
    if ((unit.health < .98 || unit.maintenance?.critical) && unit.combatAt !== null && o.time >= unit.combatAt && o.time - unit.combatAt <= 8 &&
      unit.mobility && unit.fuel > unit.fuelCapacity * .25 && !mobilityBlocked(unit) &&
      o.batteries.some(mark => o.time >= mark.at && o.time - mark.at <= 15))
      return { action: { kind: 'defend', unitId: unit.id, x: base.x + (unit.x >= base.x ? -80 : 80) }, reason: 'evade-fire' };
    if (unit.stance !== 'fire') return { action: { kind: 'stance', unitId: unit.id, stance: 'fire' }, reason: 'local-defense' };
    // Artillery keeps its yard position and lets the ordinary squad aim at
    // measured reports; it is never sent forward as a direct-fire guard.
    if (unit.artillery || !threat || mobilityBlocked(unit) || !canGuard(unit)) continue;
    const x = base.x + Math.sign(threat.x - base.x) * 80;
    if (Math.abs(unit.x - x) > 18 && !unit.moving)
      return { action: { kind: 'defend', unitId: unit.id, x }, reason: 'local-defense' };
  }
  return null;
}
