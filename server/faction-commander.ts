import { commanderBlueprint } from './commander-designs.ts';
import { upgradeById } from '../src/industry.ts';
import { COMMANDER_REASONS, COMMANDER_STRUCTURES, COMMANDER_VEHICLES, commanderActionKey } from './commander-contract.ts';
import { chooseCommanderAction } from './commander-policy.ts';
import { observeCommander } from './commander-observation.ts';
import { INTERCEPTION_SECONDS } from './commander-tactics.ts';
import { OPERATION_COOLDOWN, readGroundOperation } from './commander-operations.ts';
import { commanderRouteKey, ROUTE_RETRY_SECONDS, safeCommanderRoute } from './commander-routes.ts';
import { mobilityBlocked } from './commander-units.ts';
import type { CommanderAction, CommanderChoice, CommanderObservation, CommanderProfile, CommanderState, CommanderTrace } from './commander-contract.ts';
import type { SharedRoom } from './room.ts';
import type { RoomRequest } from './room-contract.ts';

const CYCLE = 5, HISTORY = 40;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 && !['__proto__', 'constructor', 'prototype'].includes(value);
const member = <Value extends string>(values: readonly Value[], value: unknown): value is Value => typeof value === 'string' && values.some(item => item === value);
const profiles: readonly CommanderProfile[] = ['balanced', 'cautious'];

export function newCommanderState(profile: CommanderProfile, time: number): CommanderState {
  if (!member(profiles, profile) || !finite(time)) throw new Error('Configuração do comandante inválida.');
  return { enabled: true, profile, nextAt: time, sequence: 0, actions: 0, refusals: 0, cooldowns: {}, blocked: {}, orders: {}, deferredRepairs: [], history: [], operation: null };
}
function readAction(raw: unknown): CommanderAction | null {
  if (raw === null) return null;
  if (!record(raw)) throw new Error('Ação do comandante inválida.');
  switch (raw.kind) {
    case 'recover': return { kind: raw.kind };
    case 'salvage': if (id(raw.wreckId)) return { kind: raw.kind, wreckId: raw.wreckId }; break;
    case 'haul': if (id(raw.unitId) && id(raw.depositId)) return { kind: raw.kind, unitId: raw.unitId, depositId: raw.depositId }; break;
    case 'stop':
    case 'cancel-repair': case 'repair': case 'dismantle': case 'dump-cargo':
    case 'home': if (id(raw.unitId)) return { kind: raw.kind, unitId: raw.unitId }; break;
    case 'explore':
    case 'reconnoitre':
    case 'defend': if (id(raw.unitId) && typeof raw.x === 'number' && Number.isFinite(raw.x)) return { kind: raw.kind, unitId: raw.unitId, x: raw.x }; break;
    case 'deploy': if (Array.isArray(raw.unitIds) && raw.unitIds.length === 2 && raw.unitIds.every(id) && raw.unitIds[0] !== raw.unitIds[1] &&
      typeof raw.x === 'number' && Number.isFinite(raw.x)) return { kind: raw.kind, unitIds: [...raw.unitIds] as [string, string], x: raw.x }; break;
    case 'intercept': if (id(raw.unitId) && id(raw.targetId) && typeof raw.x === 'number' && Number.isFinite(raw.x))
      return { kind: raw.kind, unitId: raw.unitId, targetId: raw.targetId, x: raw.x }; break;
    case 'attack': if (id(raw.unitId) && id(raw.targetId)) return { kind: raw.kind, unitId: raw.unitId, targetId: raw.targetId }; break;
    case 'stance': if (id(raw.unitId) && (raw.stance === 'fire' || raw.stance === 'return')) return { kind: raw.kind, unitId: raw.unitId, stance: raw.stance }; break;
    case 'manufacture': if (member(COMMANDER_VEHICLES, raw.model)) return { kind: raw.kind, model: raw.model }; break;
    case 'build': if (member(COMMANDER_STRUCTURES, raw.model) && typeof raw.x === 'number' && Number.isFinite(raw.x) && (raw.facing === -1 || raw.facing === 1))
      return { kind: raw.kind, model: raw.model, x: raw.x, facing: raw.facing }; break;
    case 'upgrade': { const upgrade = upgradeById(raw.upgrade); if (upgrade) return { kind: raw.kind, upgrade: upgrade.id }; break; }
  }
  throw new Error('Ação do comandante inválida.');
}
export function validateCommanderState(value: unknown, time: number): CommanderState {
  const invalid = (): never => { throw new Error('Comandante inválido no campo salvo.'); };
  if (!record(value) || typeof value.enabled !== 'boolean' || !member(profiles, value.profile) || !finite(value.nextAt) || value.nextAt > time + 3600 ||
    ![value.sequence, value.actions, value.refusals].every(n => finite(n) && Number.isSafeInteger(n)) ||
    !record(value.cooldowns) || !record(value.blocked) || !record(value.orders) || !Array.isArray(value.history) || value.history.length > HISTORY ||
    Number(value.actions) + Number(value.refusals) > Number(value.sequence)) return invalid();
  const cooldowns: CommanderState['cooldowns'] = {}, blocked: CommanderState['blocked'] = {}, orders: CommanderState['orders'] = {};
  for (const raw of [value.cooldowns, value.blocked, value.orders]) if (Object.keys(raw).length > 256) return invalid();
  for (const [key, until] of Object.entries(value.cooldowns)) {
    if (!id(key) || !finite(until) || until > time + 3600) return invalid(); cooldowns[key] = until;
  }
  for (const [key, raw] of Object.entries(value.blocked)) {
    if (!id(key) || !record(raw) || !id(raw.reason) || !finite(raw.until) || raw.until > time + 3600) return invalid();
    blocked[key] = { reason: raw.reason, until: raw.until };
  }
  for (const [key, raw] of Object.entries(value.orders)) {
    if (!id(key) || !record(raw)) return invalid();
    const action = readAction({ ...raw, unitId: key });
    if (action?.kind === 'haul') orders[key] = { kind: action.kind, depositId: action.depositId };
    else if (action?.kind === 'explore' || action?.kind === 'reconnoitre' || action?.kind === 'defend') orders[key] = { kind: action.kind, x: action.x };
    else if (action?.kind === 'home') orders[key] = { kind: action.kind };
    else if (action?.kind === 'intercept' && finite(raw.until) && raw.until <= time + INTERCEPTION_SECONDS)
      orders[key] = { kind: action.kind, targetId: action.targetId, x: action.x, until: raw.until };
    else return invalid();
  }
  if (Object.values(orders).filter(order => order.kind === 'intercept').length > 1) return invalid();
  const history: CommanderTrace[] = value.history.map(raw => {
    if (!record(raw) || !finite(raw.at) || raw.at > time + 1e-6 || !member(COMMANDER_REASONS, raw.reason) ||
      !member(['applied', 'refused', 'waiting'] as const, raw.result) || raw.detail !== undefined && (typeof raw.detail !== 'string' || raw.detail.length > 240)) return invalid();
    return { at: raw.at, reason: raw.reason, result: raw.result, action: readAction(raw.action), ...(raw.detail === undefined ? {} : { detail: raw.detail }) };
  });
  const deferredRepairs = value.deferredRepairs === undefined ? [] : value.deferredRepairs;
  if (!Array.isArray(deferredRepairs) || deferredRepairs.length > 256 || !deferredRepairs.every(id) ||
    new Set(deferredRepairs).size !== deferredRepairs.length) return invalid();
  return { enabled: value.enabled, profile: value.profile, nextAt: value.nextAt, sequence: Number(value.sequence),
    actions: Number(value.actions), refusals: Number(value.refusals), cooldowns, blocked, orders, history,
    deferredRepairs: [...deferredRepairs],
    operation: Object.hasOwn(value, 'operation') ? readGroundOperation(value.operation, time) : null };
}

function request(action: CommanderAction): RoomRequest {
  switch (action.kind) {
    case 'haul': return { type: 'squad', order: 'haul', ids: [action.unitId], depositId: action.depositId };
    case 'stop': return { type: 'squad', order: 'stop', ids: [action.unitId] };
    case 'home': return { type: 'squad', order: 'home', ids: [action.unitId] };
    case 'cancel-repair': case 'repair': return { type: action.kind, actorId: action.unitId };
    case 'dump-cargo': return { type: action.kind, actorId: action.unitId };
    case 'dismantle': return { type: 'remove', actorId: action.unitId };
    case 'salvage': return { type: 'salvage', wreckId: action.wreckId };
    case 'explore': return { type: 'squad', order: 'move', ids: [action.unitId], x: action.x };
    case 'reconnoitre': return { type: 'squad', order: 'move', ids: [action.unitId], x: action.x };
    case 'defend': return { type: 'squad', order: 'move', ids: [action.unitId], x: action.x };
    case 'deploy': return { type: 'squad', order: 'move', ids: action.unitIds, x: action.x };
    case 'intercept': return { type: 'squad', order: 'move', ids: [action.unitId], x: action.x };
    case 'attack': return { type: 'squad', order: 'attack', ids: [action.unitId], targetId: action.targetId };
    case 'stance': return { type: 'squad', order: 'stance', ids: [action.unitId], stance: action.stance };
    case 'manufacture': return { type: 'spawn', blueprint: commanderBlueprint(action.model) };
    case 'build': return { type: 'spawn', blueprint: commanderBlueprint(action.model), x: action.x, facing: action.facing };
    case 'upgrade': return { type: 'upgrade', id: action.upgrade };
    case 'recover': return { type: 'recover' };
  }
}
function trace(state: CommanderState, choice: CommanderChoice, at: number, result: CommanderTrace['result'], detail?: string) {
  const previous = state.history.at(-1);
  if (result === 'waiting' && previous?.result === 'waiting' && previous.reason === choice.reason) return;
  state.history.push({ action: choice.action, reason: choice.reason, at, result, ...(detail ? { detail: detail.slice(0, 240) } : {}) });
  if (state.history.length > HISTORY) state.history.shift();
}
function commitOperation(state: CommanderState, choice: CommanderChoice, now: number): void {
  if (choice.operation === undefined) return;
  if (state.operation && choice.operation === null) state.cooldowns['operation:' + state.operation.targetId] = now + OPERATION_COOLDOWN;
  state.operation = choice.operation;
}
// At most one strategic observation/action per physics step. Native vehicle
// decisions keep their existing cadence. Nothing external is journalled twice.
export function stepCommander(room: SharedRoom, playerId: string, state: CommanderState,
  decide: (observation: CommanderObservation, state: CommanderState) => CommanderChoice = chooseCommanderAction): boolean {
  const now = room.world.time;
  if (!state.enabled || state.nextAt > now + 1e-9) return false;
  state.nextAt = now + CYCLE; state.sequence++;
  const observation = observeCommander(room, playerId), live = new Set(observation.units.map(unit => unit.id));
  for (const key of Object.keys(state.cooldowns)) if (state.cooldowns[key]! <= now) delete state.cooldowns[key];
  for (const key of Object.keys(state.blocked)) if (!live.has(key)) delete state.blocked[key];
  for (const key of Object.keys(state.orders)) if (!live.has(key)) {
    const order = state.orders[key], wreck = room.records.get(key)?.wreck;
    // Own losses are known even without a surviving observer of the attacker.
    // Dismantling or transferring a vehicle is not evidence of an unsafe route.
    if (order?.kind === 'haul' && wreck && !wreck.abandoned)
      state.cooldowns[commanderRouteKey(order.depositId)] = now + ROUTE_RETRY_SECONDS;
    delete state.orders[key];
  }
  state.deferredRepairs = state.deferredRepairs.filter(id => observation.units.some(unit => unit.id === id &&
    unit.maintenance && unit.maintenance.phase !== 'needed'));
  for (const unit of observation.units) {
    const wait = /enemy|danger/.test(unit.halt) ? ROUTE_RETRY_SECONDS : mobilityBlocked(unit) || /no-loader/.test(unit.halt) ? 600 : /vein-empty/.test(unit.halt) ? 120 : 0;
    if (wait && state.blocked[unit.id]?.reason !== unit.halt) {
      state.blocked[unit.id] = { reason: unit.halt, until: now + wait };
      if ((/enemy|danger/.test(unit.halt) || mobilityBlocked(unit)) && unit.haul)
        state.cooldowns[commanderRouteKey(unit.haul.depositId)] = now + wait;
    }
    if (!unit.halt) delete state.blocked[unit.id];
  }
  const choice = decide(observation, state), action = choice.action;
  if (!action) { commitOperation(state, choice, now); trace(state, choice, now, 'waiting'); return true; }
  const key = commanderActionKey(action);
  try {
    room.command(playerId, request(action)); state.actions++;
    if (action.kind === 'home' && choice.reason === 'retreat') {
      const unit = observation.units.find(unit => unit.id === action.unitId),
        source = observation.deposits.find(site => site.id === unit?.haul?.depositId);
      // A strategic withdrawal can precede the pilot's danger report. Keep
      // the source before Home replaces the haul, using only known risk.
      if (unit?.haul && !safeCommanderRoute(observation, unit.x, source?.x ?? unit.x))
        state.cooldowns[commanderRouteKey(unit.haul.depositId)] = now + ROUTE_RETRY_SECONDS;
    }
    if (action.kind === 'cancel-repair' && !state.deferredRepairs.includes(action.unitId)) state.deferredRepairs.push(action.unitId);
    else if (action.kind === 'repair' || action.kind === 'dismantle') state.deferredRepairs = state.deferredRepairs.filter(id => id !== action.unitId);
    commitOperation(state, choice, now);
    state.cooldowns[key] = now + (action.kind === 'intercept' ? INTERCEPTION_SECONDS * 2 : action.kind === 'dump-cargo' ? 180 : action.kind === 'explore' || action.kind === 'reconnoitre' ? 90 : action.kind === 'haul' ? 30 : 10);
    if (action.kind === 'haul') state.orders[action.unitId] = { kind: action.kind, depositId: action.depositId };
    else if (action.kind === 'explore' || action.kind === 'reconnoitre' || action.kind === 'defend') state.orders[action.unitId] = { kind: action.kind, x: action.x };
    else if (action.kind === 'intercept' && state.orders[action.unitId]?.kind !== 'intercept')
      state.orders[action.unitId] = { kind: action.kind, targetId: action.targetId, x: action.x, until: now + INTERCEPTION_SECONDS };
    else if (action.kind === 'deploy') for (const unitId of action.unitIds) state.orders[unitId] = { kind: 'defend', x: action.x };
    else if (action.kind === 'home') state.orders[action.unitId] = { kind: action.kind };
    else if (action.kind === 'stop') delete state.orders[action.unitId];
    trace(state, choice, now, 'applied');
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError || !(error instanceof Error)) throw error;
    state.refusals++; state.cooldowns[key] = now + 60;
    trace(state, choice, now, 'refused', error.message);
  }
  return true;
}

export function stepCommanders(room: SharedRoom): void {
  for (const [playerId, state] of room.commanders)
    if (stepCommander(room, playerId, state)) return;
}

// Recorded decisions are data. Replaying never needs the trainer or a model.
export function readCommanderChoice(raw: unknown, time: number): CommanderChoice {
  if (!record(raw) || !member(COMMANDER_REASONS, raw.reason)) throw new Error('Decisão do comandante inválida.');
  const choice: CommanderChoice = { action: readAction(raw.action), reason: raw.reason };
  if (Object.hasOwn(raw, 'operation')) choice.operation = readGroundOperation(raw.operation, time);
  return choice;
}
