import type { Point, Pose } from '../src/math.ts';

export interface ProbeBody extends Pose {
  vx: number; vy: number; omega: number; mass: number; inertia: number;
  center: Point; dynamic: boolean;
}
export interface ProbeCarrier { handle: number; actor: number | null }
export interface ProbeBodyState extends ProbeBody, ProbeCarrier {}
export interface ProbeOwner { owner: number; body: number; colliders: number; state: ProbeBody | null }
export interface ProbeEnergySample { before: number; after: number; growth: number; gravityWork: number; constraintEnergy: number; invalid: number }
export interface ProbeEnergyAudit { solves: number; last: ProbeEnergySample; maxGrowth: ProbeEnergySample; maxBefore: number; maxAfter: number }
export interface ProbeContact {
  ownerA: number | null; ownerB: number | null; normal: Point; impulse: number; penetration: number;
  contacts: { point1: Point; point2: Point; dist: number; impulse: number }[];
  solverContacts: { point: Point; dist: number }[];
}
export interface PhysicsStateProbe {
  bodies: number; colliders: number; recoveries: number; owners: ProbeOwner[]; bodyStates: ProbeBodyState[];
  energy: ProbeEnergyAudit; energyStoredJ: { kinetic: number; gravity: number; spring: number; total: number };
  contactStates?: ProbeContact[];
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value: unknown): value is number | null => value === null || number(value);
const numbers = (value: Record<string, unknown>, keys: readonly string[]): boolean => keys.every(key => number(value[key]));
const point = (value: unknown): value is Point => record(value) && numbers(value, ['x', 'y']);
function body(value: unknown): value is ProbeBody {
  return record(value) && numbers(value, ['x', 'y', 'angle', 'vx', 'vy', 'omega', 'mass', 'inertia']) &&
    point(value.center) && typeof value.dynamic === 'boolean';
}
function carrier(value: unknown): value is ProbeCarrier {
  return record(value) && number(value.handle) && nullableNumber(value.actor);
}
function bodyState(value: unknown): value is ProbeBodyState {
  return body(value) && carrier(value);
}
function owner(value: unknown): value is ProbeOwner {
  return record(value) && numbers(value, ['owner', 'body', 'colliders']) && (value.state === null || body(value.state));
}
function energySample(value: unknown): value is ProbeEnergySample {
  return record(value) && numbers(value, ['before', 'after', 'growth', 'gravityWork', 'constraintEnergy', 'invalid']);
}
function energyAudit(value: unknown): value is ProbeEnergyAudit {
  return record(value) && numbers(value, ['solves', 'maxBefore', 'maxAfter']) && energySample(value.last) && energySample(value.maxGrowth);
}
function contact(value: unknown): value is ProbeContact {
  return record(value) && nullableNumber(value.ownerA) && nullableNumber(value.ownerB) && point(value.normal) && numbers(value, ['impulse', 'penetration']) &&
    Array.isArray(value.contacts) && value.contacts.every((entry: unknown) => record(entry) && point(entry.point1) && point(entry.point2) && numbers(entry, ['dist', 'impulse'])) &&
    Array.isArray(value.solverContacts) && value.solverContacts.every((entry: unknown) => record(entry) && point(entry.point) && number(entry.dist));
}
function physics(value: unknown): value is PhysicsStateProbe {
  return record(value) && numbers(value, ['bodies', 'colliders', 'recoveries']) &&
    Array.isArray(value.owners) && value.owners.every(owner) && Array.isArray(value.bodyStates) && value.bodyStates.every(bodyState) &&
    energyAudit(value.energy) && record(value.energyStoredJ) && numbers(value.energyStoredJ, ['kinetic', 'gravity', 'spring', 'total']) &&
    (value.contactStates === undefined || Array.isArray(value.contactStates) && value.contactStates.every(contact));
}

// This diagnostic response is separate from a gameplay frame. Preserve the
// response itself and its unconsumed fields after checking what probes read.
export function decodePhysicsState(value: unknown): PhysicsStateProbe {
  if (!physics(value)) throw new TypeError('Invalid Native physics diagnostic.');
  return value;
}

// Identity audits need only each carrier's permanent identity, so their port
// also supports small identity fixtures without demanding an energy report.
export function physicsCarriers(value: unknown): ProbeCarrier[] {
  if (!record(value) || !Array.isArray(value.bodyStates) || !value.bodyStates.every(carrier))
    throw new TypeError('Invalid Native carrier diagnostic.');
  return value.bodyStates;
}
