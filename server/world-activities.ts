import { BASE_RADIUS, LOAD_REACH, STOCK_IDS, bill, billTotal } from '../src/economy.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { GroundSight } from '../src/ground-sight.ts';
import { Random } from '../src/math.ts';
import { GUARDIAN, guardianOrders, livingGuardian, removeGuardian, spawnGuardian } from './airdrop-guardian.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { ActivitySite, ActivityView, ActivityPhase, ActivitySiteBase } from '../src/field-service-contract.ts';
export type { ActivitySite, ActivityView, ActivityPhase } from '../src/field-service-contract.ts';
import type { Faction } from './room-contract.ts';
import type { SharedRoom } from './room.ts';

interface DropBase { id: string; x: number; arrivesAt: number; expiresAt: number; retireAt?: number; guardianId?: string }
export type ActivityDrop = DropBase & (
  { supplies: SupplyBill; known: string[]; stock?: never; refined?: never } |
  { stock: number; supplies?: never; refined?: never; known?: string[] }
);
// orders is cold metadata, decoded and removed by resumeGuardian before stepping.
export interface ActivityState { nextId: number; nextAt: number; drop: ActivityDrop | null; orders?: unknown }
export interface SavedActivities { nextId: number; nextAt: number; drop: unknown; orders?: unknown }
export type ActivitiesRoom = Pick<SharedRoom, 'activities' | 'deposits' | 'factions' | 'field' | 'guardianSquad' | 'limits' |
  'outOfAction' | 'players' | 'position' | 'reconnoitred' | 'records' | 'stilled' | 'world'>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const factionList = (value: unknown): value is string[] => Array.isArray(value) &&
  value.every((id: unknown) => typeof id === 'string' && /^f[1-9]\d*$/.test(id)) && new Set(value).size === value.length;

// Candidates are independent draws over the whole map; current sight and occupation only veto unsafe sites.
// All deadlines use the field's persisted clock. One record owns all uncollected supplies.
export const AIRDROP = Object.freeze({ first: 43200, notice: 3600, collect: 28800, interval: 43200,
  supplies: Object.freeze(bill(48000, 16000, 12000, 4000)), noticeReach: 30000, warning: 15,
  clearance: Math.max(2 * SENSOR_MODES.visual.range, SENSOR_MODES.radar.range) });
const LEGACY_STOCK = 4000, LEGACY_REFINED_STOCK = 80000;
export const activityStock = (drop: ActivityDrop | null | undefined): number => drop?.supplies ? billTotal(drop.supplies) : drop?.stock ?? 0;

export function startActivities(room: ActivitiesRoom): void {
  room.activities ??= { nextId: 1, nextAt: room.world.time + AIRDROP.first, drop: null };
}
export const keepActivities = (room: SharedRoom, state: ActivityState): SavedActivities => ({ ...structuredClone(state), orders: guardianOrders(room) });
export function resumeActivities(saved: unknown): ActivityState | null {
  if (saved === undefined || saved === null) return null;
  if (!object(saved) || !finite(saved.nextId) || !Number.isSafeInteger(saved.nextId) || saved.nextId < 1 || !finite(saved.nextAt))
    throw new Error('Campo salvo com airdrop inválido.');
  let drop: ActivityDrop | null = null;
  if (saved.drop !== null) {
    const raw = saved.drop;
    if (!object(raw) || typeof raw.id !== 'string' || !/^airdrop:[1-9]\d*$/.test(raw.id) || typeof raw.x !== 'number' || !Number.isFinite(raw.x) ||
      !finite(raw.arrivesAt) || !finite(raw.expiresAt) || raw.expiresAt < raw.arrivesAt ||
      raw.retireAt !== undefined && (!finite(raw.retireAt) || raw.retireAt < raw.arrivesAt) ||
      raw.guardianId !== undefined && (typeof raw.guardianId !== 'string' || !/^c[1-9]\d*$/.test(raw.guardianId)) ||
      raw.known !== undefined && !factionList(raw.known)) throw new Error('Campo salvo com airdrop inválido.');
    const mixed = Object.hasOwn(raw, 'supplies'), known = factionList(raw.known) ? [...raw.known] : undefined;
    if ((mixed || raw.refined === true) && known === undefined) throw new Error('Campo salvo com airdrop inválido.');
    const { stock: _stock, refined: _refined, supplies: _supplies, ...extra } = structuredClone(raw);
    const common = { ...extra, id: raw.id, x: raw.x, arrivesAt: raw.arrivesAt, expiresAt: raw.expiresAt,
      ...(typeof raw.retireAt === 'number' ? { retireAt: raw.retireAt } : {}),
      ...(typeof raw.guardianId === 'string' ? { guardianId: raw.guardianId } : {}) };
    if (mixed) {
      const value = raw.supplies;
      if (!object(value) || Object.keys(value).length !== STOCK_IDS.length || Object.keys(value).some(key => !STOCK_IDS.some(id => id === key)) ||
        !finite(value.ferro) || !finite(value.ligas) || !finite(value.silica) || !finite(value.combustivel) ||
        Object.hasOwn(raw, 'stock') || Object.hasOwn(raw, 'refined')) throw new Error('Campo salvo com airdrop inválido.');
      const supplies = bill(value.ferro, value.ligas, value.silica, value.combustivel);
      if (billTotal(supplies) > Math.max(LEGACY_REFINED_STOCK, billTotal(AIRDROP.supplies))) throw new Error('Campo salvo com airdrop inválido.');
      drop = { ...common, supplies, known: known! };
    } else {
      if (!finite(raw.stock) || raw.stock > (raw.refined ? LEGACY_REFINED_STOCK : LEGACY_STOCK) ||
        raw.refined !== undefined && raw.refined !== true) throw new Error('Campo salvo com airdrop inválido.');
      // Preserve exact remaining Fe of a legacy refined event without granting a new audience or reward.
      drop = raw.refined === true ? { ...common, supplies: bill(raw.stock), known: known! } :
        { ...common, stock: raw.stock, ...(known ? { known } : {}) };
    }
  }
  return { ...structuredClone(saved), nextId: saved.nextId, nextAt: saved.nextAt, drop };
}
export const collecting = (drop: ActivityDrop | null | undefined, time: number): drop is ActivityDrop => Boolean(drop && drop.retireAt === undefined &&
  time >= drop.arrivesAt && time < drop.expiresAt && activityStock(drop) > 1e-6);

// A public event site is distinct from the generated geological sites. It has no underground reserve.
export function activitySite(room: Pick<ActivitiesRoom, 'activities' | 'field'>): ActivitySite | null {
  const drop = room.activities?.drop;
  if (!collecting(drop, room.field.time)) return null;
  const base: ActivitySiteBase = { id: drop.id, type: 'airdrop', feature: 'airdrop', x: drop.x };
  return drop.supplies ? { ...base, refined: true, supplies: drop.supplies } : { ...base, material: 'ferro', reserve: 0 };
}
// Knowledge belongs to the one event, not to geological reserves. Legacy live drops keep their old audience.
export const activityKnown = (room: Pick<ActivitiesRoom, 'activities'>, faction: Faction | null | undefined): boolean => Boolean(room.activities?.drop && faction &&
  (room.activities.drop.known === undefined || room.activities.drop.known.includes(faction.id)));
function discover(room: ActivitiesRoom, drop: ActivityDrop, time: number): void {
  if (!drop.known || drop.retireAt !== undefined || time >= drop.expiresAt || activityStock(drop) <= 1e-6) return;
  const waiting = new Set([...room.factions.keys()].filter(id => !drop.known!.includes(id))),
    learn = (id: string) => { drop.known!.push(id); waiting.delete(id); };
  for (const id of waiting) {
    const base = room.factions.get(id)!.base;
    if (base && Math.abs(base.x - drop.x) <= AIRDROP.noticeReach) learn(id);
  }
  if (!waiting.size) return;
  const defeated = room.outOfAction();
  for (const actor of room.world.actors) {
    const factionId = room.players.get(actor.ownerId!)?.factionId, record = room.records.get(actor.id);
    if (!factionId || !waiting.has(factionId) || actor.defeated || defeated[actor.id] || record?.wreck || record?.service?.kind === 'build') continue;
    if (Math.abs(room.position(actor) - drop.x) <= AIRDROP.noticeReach) learn(factionId);
  }
}
// Only the receiver's own base and the bases it already knows can still a public pickup for it.
export function activityStilled(room: Pick<ActivitiesRoom, 'stilled' | 'reconnoitred'>, faction: Faction, site: { x: number }): boolean {
  if (room.stilled(faction, site)) return true;
  for (const known of room.reconnoitred(faction).values())
    if (Math.abs(known.x - site.x) <= BASE_RADIUS + LOAD_REACH) return true;
  return false;
}
export function activityView(room: Pick<ActivitiesRoom, 'activities' | 'field' | 'stilled' | 'reconnoitred'>, faction: Faction): ActivityView | null {
  const drop = room.activities?.drop;
  if (!drop || !activityKnown(room, faction)) return null;
  // Whitelist public data only: no anchor faction, base, actor, seat, sensor or key is published here.
  const base: ActivitySiteBase = { id: drop.id, type: 'airdrop', feature: 'airdrop', x: drop.x };
  const phase: ActivityPhase = drop.retireAt !== undefined ? 'withdrawal' : room.field.time < drop.arrivesAt ? 'announcement' : 'collection';
  const tail = { arrivesAt: drop.arrivesAt, expiresAt: drop.expiresAt,
    ...(drop.retireAt === undefined ? {} : { retireAt: drop.retireAt }), guarded: true,
    phase, active: collecting(drop, room.field.time) && !activityStilled(room, faction, drop), seen: true } as const;
  return drop.supplies ? { ...base, refined: true, supplies: { ...drop.supplies }, ...tail } :
    { ...base, material: 'ferro', reserve: 0, left: 0, stock: drop.stock, ...tail };
}
// One current physical reading for this rare draw. Historical exploration, client knowledge and debug fog are not sight.
function placement(room: ActivitiesRoom): (x: number) => boolean {
  const out = room.outOfAction(), living = room.world.actors.filter(actor => !actor.defeated && !out[actor.id] &&
    !room.records.get(actor.id)?.wreck && room.factions.has(actor.team!)),
    visible = new GroundSight(room.field.terrain).seen(living), occupied = living.filter(actor => actor.vehicle).map(actor => room.world.actorBounds(actor.id));
  return (x: number) => {
    const from = x - GUARDIAN.leash, to = x + GUARDIAN.leash;
    return visible.every(([lo, hi]) => hi < from || lo > to) &&
      occupied.every(({ minX, maxX }) => maxX <= from - AIRDROP.clearance || minX >= to + AIRDROP.clearance);
  };
}
function place(room: ActivitiesRoom, id: number): number | null {
  const ground = room.field.terrain, { minX, maxX } = room.limits,
    low = minX + 150, high = maxX - 150,
    random = new Random(ground.seed ^ Math.imul(id, 0x9e3779b9));
  if (high < low) return null;
  const clear = placement(room);
  for (let attempt = 0; attempt < 16; attempt++) {
    const x = Math.round(low + random.next() * (high - low));
    // No competing natural pickup band, or arrival on an abrupt step of the ground.
    if (room.deposits.some(site => Math.abs(site.x - x) <= 2 * LOAD_REACH)) continue;
    if (!clear(x)) continue;
    const y = ground.height(x);
    if ([-8, 8, 32, 48].some(dx => Math.abs(ground.height(x + dx) - y) > 6)) continue;
    return x;
  }
  return null; // no teleport, terrain edit or unbounded search when there is no suitable place
}
export function stepActivities(room: SharedRoom): void {
  const state = room.activities;
  if (!state) return;
  const time = room.field.time, drop = state.drop;
  if (drop) {
    discover(room, drop, time);
    // An already announced event is never given a new enemy later, including a pre-update event with no identity.
    if (drop.guardianId !== undefined && !livingGuardian(room)) room.guardianSquad = null;
    if (drop.retireAt === undefined && time >= drop.arrivesAt && (activityStock(drop) <= 1e-6 || time >= drop.expiresAt)) {
      if (drop.supplies) Object.assign(drop.supplies, bill()); else drop.stock = 0;
      if (livingGuardian(room)) drop.retireAt = time + AIRDROP.warning;
      else { removeGuardian(room); state.drop = null; return; }
    }
    if (drop.retireAt !== undefined && time >= drop.retireAt) { removeGuardian(room); state.drop = null; }
    return;
  }
  if (time < state.nextAt || !room.factions.size) return;
  const id = state.nextId++, x = place(room, id);
  state.nextAt = time + AIRDROP.interval;
  if (x === null) return;
  state.drop = { id: 'airdrop:' + id, x, supplies: { ...AIRDROP.supplies }, known: [],
    arrivesAt: time + AIRDROP.notice, expiresAt: time + AIRDROP.notice + AIRDROP.collect };
  spawnGuardian(room);
  discover(room, state.drop, time);
}
