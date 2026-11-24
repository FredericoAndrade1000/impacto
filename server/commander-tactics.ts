import type { CommanderChoice, CommanderObservation, CommanderState, CommanderThreat, CommanderUnit } from './commander-contract.ts';
import { commanderActionKey } from './commander-contract.ts';
import { activeJob, canGuard, isDefender, returning } from './commander-units.ts';
import { baseAlarm } from './commander-defense.ts';

export const INTERCEPTION_SECONDS = 180;
const BASE_ALARM = 1000, MAX_INTERCEPTION = 3000, ROUTE_MARGIN = 1000, STANDOFF = 200, ARRIVAL = 30;
type Contact = Extract<CommanderThreat, { kind: 'contact' }>;

const fuelShare = (unit: CommanderUnit): number => unit.fuelCapacity > 0 ? unit.fuel / unit.fuelCapacity : 0;
const idOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const paused = (unit: CommanderUnit): boolean => !unit.ready || returning(unit) || Boolean(unit.haul) ||
  activeJob(unit) || unit.job?.reason === 'manual-control';
const blocked = (unit: CommanderUnit, o: CommanderObservation, state: CommanderState): boolean =>
  (state.blocked[unit.id]?.until ?? -Infinity) > o.time;

// A grounded, current contact is an identified enemy. A signal can alarm the
// base but cannot name an attack, even when it lies at the same position.
function contactInside(o: CommanderObservation, target: CommanderThreat): target is Contact {
  if (!o.base || target.kind !== 'contact' || target.armed === false || !target.grounded) return false;
  const distance = Math.abs(target.x - o.base.x);
  return distance > BASE_ALARM && distance <= MAX_INTERCEPTION;
}

function guardReady(unit: CommanderUnit, o: CommanderObservation, state: CommanderState): boolean {
  return canGuard(unit) && unit.atBase && unit.atDepot && unit.stance === 'fire' && !unit.moving && unit.attack === null &&
    !paused(unit) && !unit.halt && !blocked(unit, o, state);
}

// The mission protects actual work. Known haul endpoints define its route;
// other working/moving economic vehicles contribute only their own position.
function nearWork(o: CommanderObservation, contact: Contact): boolean {
  return o.units.some(unit => {
    if (!(unit.health > 0) || !unit.vehicle || isDefender(unit) ||
      !(unit.builder || unit.supply || unit.extracts.length || unit.carries.length) ||
      !(unit.haul || unit.moving || activeJob(unit))) return false;
    if (Math.abs(contact.x - unit.x) <= ROUTE_MARGIN) return true;
    const site = unit.haul && o.deposits.find(site => site.id === unit.haul!.depositId);
    if (!site || !o.base) return false;
    return contact.x >= Math.min(o.base.x, site.x) - ROUTE_MARGIN &&
      contact.x <= Math.max(o.base.x, site.x) + ROUTE_MARGIN;
  });
}

// Maintaining a mission never monopolizes the faction's strategic cycle. If
// movement/focus already suffice, null leaves its economy free to plan.
export function maintainInterception(o: CommanderObservation, state: CommanderState): CommanderChoice | null {
  if (!state.enabled || !o.base) return null;
  for (const [unitId, mission] of Object.entries(state.orders)) {
    if (mission.kind !== 'intercept') continue;
    const unit = o.units.find(unit => unit.id === unitId);
    // Current services, direct control, logistics and return orders retain
    // authority even when diagnostic strategic memory has not been retired.
    if (!unit || paused(unit) || unit.attack !== null && unit.attack !== mission.targetId) return null;
    const target = o.threats.find(threat => threat.kind === 'contact' && threat.id === mission.targetId),
      guard = o.units.some(other => other.id !== unit.id && guardReady(other, o, state)),
      withdraw = (): CommanderChoice => ({ action: { kind: 'home', unitId }, reason: 'end-interception' });
    if (o.time >= mission.until || !target || !contactInside(o, target) || !isDefender(unit) ||
      Math.abs(unit.x - o.base.x) > MAX_INTERCEPTION || Math.abs(mission.x - o.base.x) > MAX_INTERCEPTION ||
      unit.health < .55 || fuelShare(unit) < .25 || unit.ammoRatio < .1 || !guard || baseAlarm(o) || unit.halt)
      return withdraw();
    if (unit.attack === mission.targetId) return null;
    if (Math.abs(unit.x - mission.x) <= ARRIVAL)
      return { action: { kind: 'attack', unitId, targetId: mission.targetId }, reason: 'intercept-contact' };
    // A failed approach does not become a stationary attack at arbitrary range,
    // nor a new travel order that restarts the pilot's progress measurement.
    return unit.moving ? null : withdraw();
  }
  return null;
}

export function chooseInterception(o: CommanderObservation, state: CommanderState): CommanderChoice | null {
  if (!state.enabled || !o.base || baseAlarm(o) || Object.values(state.orders).some(order => order.kind === 'intercept')) return null;
  const guards = o.units.filter(unit => guardReady(unit, o, state));
  if (guards.length < 2) return null;
  const contacts = o.threats.filter((threat): threat is Contact => contactInside(o, threat) && nearWork(o, threat))
    .sort((a, b) => Math.abs(a.x - o.base!.x) - Math.abs(b.x - o.base!.x) || idOrder(a.id, b.id));
  for (const target of contacts) {
    const unit = guards.filter(unit => unit.health >= .8 && fuelShare(unit) >= .5 && unit.ammoRatio >= .25)
      .sort((a, b) => Math.abs(a.x - target.x) - Math.abs(b.x - target.x) || idOrder(a.id, b.id))[0];
    if (!unit) continue;
    const x = target.x - Math.sign(target.x - o.base.x) * STANDOFF;
    const action = { kind: 'intercept' as const, unitId: unit.id, targetId: target.id, x };
    if ((state.cooldowns[commanderActionKey(action)] ?? -Infinity) > o.time) continue;
    return { action, reason: 'protect-route' };
  }
  return null;
}
