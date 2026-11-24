import type { CommanderChoice, CommanderObservation, CommanderReason, CommanderState, CommanderUnit, GroundOperation } from './commander-contract.ts';
import { baseAlarm } from './commander-defense.ts';
import { activeJob, canGuard, exploring, FUEL_RESERVE_SHARE, isDefender, mobilityBlocked, returning } from './commander-units.ts';

// Preparation and combat allowance; departure adds the force's round-trip time.
export const OPERATION_SECONDS = 1200, OPERATION_COOLDOWN = 600;
const MAX_OPERATION_SECONDS = 7200, RETURN_GRACE = 300;
const CONTACT_STANDOFF = 200, SUPPORT_GAP = 180, CONTACT_REPLAN = 150, CONTACT_GAP = 15;
const share = (unit: CommanderUnit): number => unit.fuelCapacity > 0 ? unit.fuel / unit.fuelCapacity : 0;
const available = (unit: CommanderUnit): boolean => unit.ready && !returning(unit) && !unit.haul && !activeJob(unit) && unit.job?.reason !== 'manual-control';
const servicingAtBase = (unit: CommanderUnit): boolean => !unit.ready && unit.atBase && !unit.haul && !activeJob(unit) && unit.job?.reason !== 'manual-control';
const blocked = (unit: CommanderUnit, o: CommanderObservation, state: CommanderState): boolean => (state.blocked[unit.id]?.until ?? -Infinity) > o.time;

export const operationUnit = (state: CommanderState, id: string): boolean => Boolean(state.operation &&
  state.operation.phase !== 'prepare' && state.operation.unitIds.includes(id));
export function operationReason(operation: GroundOperation): CommanderReason {
  return ({ prepare: 'prepare-operation', gather: 'rally-force', advance: 'advance-operation', combat: 'fight-operation',
    occupy: 'occupy-base', return: 'return-operation' } as const)[operation.phase];
}

export const baseKnown = (base: CommanderObservation['bases'][number]): boolean => base.seen || base.at !== null;

// A surveyed fixed base stays where it was last observed until new information
// says otherwise. Requiring an unbroken strip
// of optical ground visibility would reject routes the scout physically crossed
// whenever a hollow was hidden behind a crest.
export function operationTarget(o: CommanderObservation, state: CommanderState) {
  if (!o.base) return undefined;
  const base = o.base;
  return o.bases.filter(target => target.id !== o.factionId && baseKnown(target) && !target.sheltered &&
    (state.cooldowns['operation:' + target.id] ?? -Infinity) <= o.time &&
    (!o.explored || o.explored.some(([lo, hi]) => lo <= target.x && hi >= target.x)))
    .sort((a, b) => Math.abs(a.x - base.x) - Math.abs(b.x - base.x) || a.id.localeCompare(b.id))[0];
}

function launchReady(unit: CommanderUnit, o: CommanderObservation, state: CommanderState): boolean {
  return isDefender(unit) && available(unit) && unit.atBase && unit.atDepot && !unit.moving && unit.attack === null &&
    unit.stance === 'fire' && !unit.halt && !blocked(unit, o, state) && unit.health >= .8 && unit.ammoRatio >= .6 && share(unit) >= .75;
}

export function chooseGroundOperation(o: CommanderObservation, state: CommanderState, funded: boolean): CommanderChoice | null {
  const mission = state.operation;
  if (!mission) {
    const target = funded && !baseAlarm(o) && operationTarget(o, state);
    return target ? { action: null, reason: 'prepare-operation', operation: { phase: 'prepare', targetId: target.id,
      targetX: target.x, startedAt: o.time, until: o.time + OPERATION_SECONDS } } : null;
  }
  if (!o.base) return { action: null, reason: 'abort-operation', operation: null };
  const base = o.base;
  const target = o.bases.find(base => base.id === mission.targetId), captured = o.taken?.factionId === mission.targetId && o.taken.at >= mission.startedAt,
    lostTarget = !target || target.sheltered || Math.abs(target.x - mission.targetX) > 100 || !target.seen && target.at === null;
  if (mission.phase === 'prepare') {
    if (captured || lostTarget || baseAlarm(o) || o.time >= mission.until)
      return { action: null, reason: captured ? 'complete-operation' : 'abort-operation', operation: null };
    if (!funded) return null;
    const returningScout = o.units.find(unit => isDefender(unit) && available(unit) && !mobilityBlocked(unit) && !unit.atBase &&
      (exploring(state.orders[unit.id]) || !unit.moving && unit.attack === null));
    if (returningScout) return { action: { kind: 'home', unitId: returningScout.id }, reason: 'rally-force' };
    const prepared = o.units.filter(unit => launchReady(unit, o, state))
      .sort((a, b) => a.maxHealth - b.maxHealth || Math.abs(a.x - o.base!.x) - Math.abs(b.x - o.base!.x) || a.id.localeCompare(b.id));
    if (prepared.length < 3 || Object.values(state.orders).some(order => order.kind === 'intercept')) return null;
    // Budget a round trip at half the mechanical speed limit, plus combat time.
    // Terrain and combat still use ordinary driving, fuel and retreat rules.
    const distance = Math.abs(mission.targetX - o.base.x), seconds = (unit: CommanderUnit): number =>
      unit.mobility ? OPERATION_SECONDS + 2 * distance / (unit.mobility.speed / 2) : Infinity,
      capable = prepared.filter(unit => unit.mobility && unit.fuel > 0 &&
        2 * distance <= unit.mobility.range * Math.max(0, (unit.fuel - unit.fuelCapacity * FUEL_RESERVE_SHARE) / unit.fuel) &&
        o.time + seconds(unit) <= mission.startedAt + MAX_OPERATION_SECONDS),
      guard = prepared.find(unit => capable.length - Number(capable.includes(unit)) >= 2);
    if (!guard) return { action: null, reason: 'abort-operation', operation: null };
    // A short-range vehicle can guard home. Send the most durable capable pair,
    // using their actual owned parts rather than template names or bonuses.
    const spares = capable.filter(unit => unit !== guard).sort((a, b) => b.maxHealth - a.maxHealth);
    const unitIds: [string, string] = [spares[0]!.id, spares[1]!.id],
      rallyX = o.base.x + Math.sign(mission.targetX - o.base.x) * Math.min(250, distance / 3),
      until = o.time + Math.max(seconds(spares[0]!), seconds(spares[1]!));
    return { action: { kind: 'deploy', unitIds, x: rallyX }, reason: 'rally-force',
      operation: { ...mission, phase: 'gather', unitIds, guardId: guard.id, rallyX, until } };
  }
  const units = mission.unitIds.flatMap(id => o.units.find(unit => unit.id === id) ?? []),
    withdraw = (outcome: 'captured' | 'aborted'): CommanderChoice => ({ action: null,
      reason: outcome === 'captured' ? 'complete-operation' : 'abort-operation', operation: { ...mission, phase: 'return', outcome } });
  if (mission.phase === 'return') {
    // Existing services, direct control and automatic returns retain authority.
    const outside = units.filter(unit => (!unit.atBase || returning(unit)) && !unit.haul && !activeJob(unit) && unit.job?.reason !== 'manual-control');
    if (!outside.length || o.time >= mission.until + RETURN_GRACE)
      return { action: null, reason: mission.outcome === 'captured' ? 'complete-operation' : 'abort-operation', operation: null };
    const unit = outside.find(unit => unit.ready && !returning(unit) &&
      (!mobilityBlocked(unit) || state.orders[unit.id]?.kind !== 'home'));
    return unit ? { action: { kind: 'home', unitId: unit.id }, reason: 'return-operation' } : null;
  }
  if (captured) return withdraw('captured');
  if (lostTarget) return withdraw('aborted');
  // Use only current authorized contacts. A forward force can screen the base
  // from an attacker it is already closer to, rather than drive away from it.
  const distance = (x: number): number => Math.min(...units.map(unit => Math.abs(unit.x - x))),
    contacts = o.threats.filter(threat => threat.kind === 'contact' && threat.armed !== false && threat.grounded &&
      threat.x >= Math.min(base.x, mission.targetX) - target!.radius &&
      threat.x <= Math.max(base.x, mission.targetX) + target!.radius && distance(threat.x) < 1200)
      .sort((a, b) => distance(a.x) - distance(b.x) || a.x - b.x),
    contact = contacts.find(threat => threat.kind === 'contact' && units.some(unit => unit.attack === threat.id)) ?? contacts[0];
  const guard = o.units.find(unit => unit.id === mission.guardId);
  const screening = contact && units.some(unit => (unit.x - base.x) * (contact.x - base.x) > 0 &&
      Math.abs(unit.x - base.x) <= Math.abs(contact.x - base.x)),
    // A brief sensory gap must not turn one minor hit on a healthy home guard
    // into a fresh retreat. Waiting never renews this existing trace timestamp.
    recentFight = mission.phase === 'combat' && guard && guard.health >= .8 && units.some(unit => unit.moving) &&
      state.history.some(row => row.result === 'applied' && row.reason === 'fight-operation' &&
        row.at >= mission.startedAt && row.at <= o.time && o.time - row.at <= CONTACT_GAP && row.action &&
        ('unitId' in row.action ? mission.unitIds.includes(row.action.unitId) :
          row.action.kind === 'deploy' && row.action.unitIds.every(id => mission.unitIds.includes(id))));
  if (o.besieged || baseAlarm(o) && !screening && !recentFight || o.time >= mission.until || !guard || !guard.atBase || !(available(guard) || servicingAtBase(guard)) || !canGuard(guard) || units.length !== 2 ||
    units.some(unit => !isDefender(unit) || !(available(unit) || mission.phase === 'gather' && servicingAtBase(unit)) ||
      unit.health < .55 || unit.ammoRatio < .1 || share(unit) < FUEL_RESERVE_SHARE || Boolean(unit.halt)))
    return withdraw('aborted');
  if (mission.phase === 'gather') {
    if (!guard.ready || units.some(unit => !unit.ready || unit.moving || Math.abs(unit.x - mission.rallyX) > 35)) return null;
    const x = mission.targetX - Math.sign(mission.targetX - o.base.x) * Math.min(220, Math.abs(mission.targetX - o.base.x) / 3);
    return { action: { kind: 'deploy', unitIds: mission.unitIds, x }, reason: 'advance-operation', operation: { ...mission, phase: 'advance' } };
  }
  if (mission.phase === 'occupy') {
    if (contact && contact.kind === 'contact' && Math.abs(contact.x - mission.targetX) <= target!.radius)
      return { action: { kind: 'attack', unitId: units[0]!.id, targetId: contact.id }, reason: 'fight-operation', operation: { ...mission, phase: 'combat' } };
    const displaced = units.some(unit => !unit.moving && Math.abs(unit.x - mission.targetX) > target!.radius - 15);
    if (displaced) return { action: { kind: 'deploy', unitIds: mission.unitIds, x: mission.targetX }, reason: 'occupy-base' };
    if (units.some(unit => unit.moving)) return null;
    const firing = units.find(unit => unit.stance !== 'return');
    return firing ? { action: { kind: 'stance', unitId: firing.id, stance: 'return' }, reason: 'occupy-base' } : null;
  }
  if (contact?.kind === 'contact') {
    // The more durable vehicle takes the front; its support stops behind it
    // instead of masking the cannon with an allied armoured hull. Use normal
    // individual moves and their existing order memory, in either direction.
    const formation = [...units].sort((a, b) => b.maxHealth - a.maxHealth || a.id.localeCompare(b.id))
      .map((unit, index) => ({ unit, x: contact.x + Math.sign(base.x - contact.x) *
        Math.min(CONTACT_STANDOFF + index * SUPPORT_GAP, Math.abs(base.x - contact.x) / 2) })),
      approach = formation.find(({ unit, x }) => {
        const order = state.orders[unit.id];
        return Math.abs(unit.x - contact.x) > CONTACT_STANDOFF + 100 &&
          !(order?.kind === 'defend' && Math.abs(order.x - x) <= CONTACT_REPLAN);
      });
    if (approach)
      return { action: { kind: 'defend', unitId: approach.unit.id, x: approach.x }, reason: 'fight-operation',
        operation: { ...mission, phase: 'combat' } };
    const unit = units.find(unit => unit.attack !== contact.id);
    return unit ? { action: { kind: 'attack', unitId: unit.id, targetId: contact.id }, reason: 'fight-operation',
      operation: { ...mission, phase: 'combat' } } : null;
  }
  // A gap in perception does not mean the force has arrived or won the fight.
  // Continue its existing approach; the pilot still owns aiming and movement.
  if (units.some(unit => unit.moving)) return null;
  return { action: { kind: 'deploy', unitIds: mission.unitIds, x: mission.targetX }, reason: 'occupy-base', operation: { ...mission, phase: 'occupy' } };
}

// Cold saves may omit this new memory. Explicit malformed missions are rejected;
// elapsed deadlines stay elapsed and never become fresh sorties after a resume.
export function readGroundOperation(raw: unknown, time: number): GroundOperation | null {
  if (raw === null) return null;
  const invalid = (): never => { throw new Error('Operação terrestre inválida no comandante salvo.'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>, key = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 160 && !['__proto__', 'constructor', 'prototype'].includes(id),
    number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const limit = value.phase === 'prepare' ? OPERATION_SECONDS : MAX_OPERATION_SECONDS;
  if (!key(value.targetId) || !number(value.targetX) || !number(value.startedAt) || value.startedAt < 0 || value.startedAt > time + 1e-6 ||
    !number(value.until) || value.until < value.startedAt || value.until - value.startedAt > limit + 1e-6) return invalid();
  const common = { targetId: value.targetId, targetX: value.targetX, startedAt: value.startedAt, until: value.until };
  if (value.phase === 'prepare') return { ...common, phase: 'prepare' };
  if (!Array.isArray(value.unitIds) || value.unitIds.length !== 2 || !value.unitIds.every(key) ||
    value.unitIds[0] === value.unitIds[1] || !key(value.guardId) || value.unitIds.includes(value.guardId) || !number(value.rallyX)) return invalid();
  const force = { ...common, unitIds: [...value.unitIds] as [string, string], guardId: value.guardId, rallyX: value.rallyX };
  if (value.phase === 'return' && (value.outcome === 'captured' || value.outcome === 'aborted')) return { ...force, phase: 'return', outcome: value.outcome };
  if (value.phase === 'gather' || value.phase === 'advance' || value.phase === 'combat' || value.phase === 'occupy') return { ...force, phase: value.phase };
  return invalid();
}
