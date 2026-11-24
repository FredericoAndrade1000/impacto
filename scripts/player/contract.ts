import { array, object, optional, union, literal, numeric, logical, record } from '../../src/wire-shape.ts';
import type { Guard, Checked, Optional } from '../../src/wire-shape.ts';
import { isConstructionSource } from '../../src/construction-codec.ts';
import { CONSTRUCTION_TEMPLATES } from '../../src/construction-template-catalogue.ts';
import type { ConstructionTemplateId } from '../../src/construction-template-catalogue.ts';
import { isUpgradeId } from '../../src/industry.ts';
import { isSquadStance } from '../../src/squad-contract.ts';

// The local tool admits player intentions, never arbitrary wire commands.
const text: Guard<string> = (v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192;
const id: Guard<string> = (v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const ids: Guard<string[]> = (v): v is string[] => array(id)(v) && v.length > 0 && v.length <= 64 && new Set(v).size === v.length;
const nonnegative: Guard<number> = (v): v is number => numeric(v) && v >= 0;
const seconds: Guard<number> = (v): v is number => numeric(v) && v > 0 && v <= 50;
const cursor: Guard<number> = (v): v is number => nonnegative(v) && Number.isSafeInteger(v);
const eventCursor: Guard<string> = (v): v is string => typeof v === 'string' && /^[a-f0-9-]{36}:\d+$/.test(v) &&
  Number.isSafeInteger(Number(v.split(':')[1]));
const model: Guard<ConstructionTemplateId> = (v): v is ConstructionTemplateId => CONSTRUCTION_TEMPLATES.some(t => t.id === v);
function exact<const S extends Readonly<Record<string, Guard<unknown> | Optional<unknown>>>>(schema: S) {
  const check = object(schema);
  return (v: unknown): v is Checked<typeof check> => check(v) && Object.keys(v).every(key => Object.hasOwn(schema, key));
}
const point = exact({ x: numeric, y: numeric });
const facing = union(literal(-1), literal(1));
const design = union(exact({ model }), exact({ blueprint: isConstructionSource }));
const groupOrder = union(
  exact({ kind: literal('move'), ids, x: numeric, y: optional(numeric) }),
  exact({ kind: literal('attack'), ids, targetId: id }),
  exact({ kind: literal('bombard'), ids, point }),
  exact({ kind: literal('haul'), ids, depositId: id }),
  exact({ kind: union(literal('home'), literal('stop'), literal('free'), literal('turn')), ids }),
  exact({ kind: literal('stance'), ids, stance: isSquadStance }),
  exact({ kind: union(literal('auto'), literal('homing')), ids, on: logical }),
  exact({ kind: union(literal('repair'), literal('cancel-repair'), literal('remove'), literal('cancel-dismantle'), literal('abandon'), literal('dump-cargo')), ids }),
);
const action = union(groupOrder,
  exact({ kind: literal('recover') }),
  exact({ kind: literal('salvage'), wreckId: id }),
  exact({ kind: literal('upgrade'), id: isUpgradeId }),
  exact({ kind: literal('cancel-upgrade'), id: cursor }),
  exact({ kind: literal('road'), x0: numeric, x1: numeric, roadKind: union(literal('graded'), literal('asphalt')) }),
  exact({ kind: literal('cancel-road'), roadId: id }),
  exact({ kind: literal('cancel-work'), workId: id }),
  exact({ kind: literal('post'), x: numeric, facing: optional(facing) }),
  exact({ kind: union(literal('remove-post'), literal('keep-post')), postId: id }),
  exact({ kind: literal('tow'), actorId: id, targetId: id }),
  exact({ kind: literal('unhook'), actorId: id }),
);
export const EVENT_KINDS = ['connection', 'contact', 'unit', 'work', 'industry', 'duel', 'stalled', 'command', 'clock'] as const;
export type PlayerEventKind = typeof EVENT_KINDS[number];
const eventKind: Guard<PlayerEventKind> = (v): v is PlayerEventKind => EVENT_KINDS.some(kind => kind === v);
const reason = { reason: text, observedAt: optional(nonnegative) };
const request = union(
  exact({ op: literal('observe') }),
  exact({ op: literal('inspect'), actorId: id, blueprint: optional(logical) }),
  exact({ op: literal('quote'), design, replaceId: optional(id) }),
  exact({ op: literal('order'), action, ...reason }),
  exact({ op: literal('build'), design, replaceId: optional(id), x: optional(numeric), facing: optional(facing), ...reason }),
  exact({ op: literal('wait'), after: eventCursor, kinds: optional(array(eventKind)), wallSeconds: optional(seconds), simSeconds: optional(nonnegative) }),
  exact({ op: literal('plan'), goal: text, notes: optional(text) }),
  exact({ op: literal('speed'), factor: union(literal(1), literal(2), literal(4), literal(8)), reason: text }),
  exact({ op: literal('stop') }),
);
export type PlayerRequest = Checked<typeof request>;
export type PlayerAction = Checked<typeof action>;
export type PlayerDesign = Checked<typeof design>;
export interface PlayerEvent { session: string; sequence: number; kind: PlayerEventKind; at: number | null; wallAt: string; detail: string; actorId?: string }
export interface PlayerPlan { goal: string; notes: string; updatedAt: string; at: number | null }
export type PlayerReply = { ok: true; value: unknown } | { ok: false; error: string };
export interface PlayerEnvelope { id: string; secret: string; request: PlayerRequest }
const envelope = exact({ id, secret: id, request });
export function readPlayerRequest(value: unknown): PlayerRequest {
  if (!request(value)) throw new Error('Invalid player request. Use observe, inspect, quote, order, build, wait, plan, speed or stop.');
  return value;
}
export function readPlayerEnvelope(value: unknown): PlayerEnvelope {
  if (!envelope(value)) throw new Error('Invalid player envelope.'); return value;
}
export function readPlayerReply(value: unknown): PlayerReply {
  if (!record(value) || typeof value.ok !== 'boolean' || (value.ok ? !Object.hasOwn(value, 'value') : typeof value.error !== 'string'))
    throw new Error('Invalid player reply.');
  return value.ok ? { ok: true, value: value.value } : { ok: false, error: String(value.error) };
}
