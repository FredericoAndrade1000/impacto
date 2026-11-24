import type { Point, Pose, Basis } from './math.ts';
import type { BinaryWords } from './network-codec.ts';
import type { ShotBlock, ShotLegend } from './shots.ts';
export interface SeatItem {
  id?: unknown; actorId?: unknown; vehicle?: unknown; eyes?: unknown; definition?: unknown; groundContact?: unknown;
}
export interface SeatOverrides extends Pose { groundContact?: { x: number } }
export interface SeatTransform {
  point(body: Pose, at: Point, basis?: (() => Basis) | undefined): Point;
  pose(body: Pose, at: Pose, basis?: (() => Basis) | undefined): Pose;
  ground(x: number, from: Point, to: Point): number;
}
export interface SeatMapping {
  body(item: SeatItem, bodies: ReadonlyMap<string, Pose>): Pose | undefined;
  move<T extends SeatItem>(item: T, body: Pose, to: SeatTransform, read?: ((item: T, overrides?: SeatOverrides) => T) | null, basis?: (() => Basis) | undefined): T;
}
type Dictionary = Record<string, unknown>;
export interface FrameItem extends Dictionary, SeatItem { id: string; [VIEW]?: unknown }
export interface FrameScene extends Dictionary { time?: number; actors?: FrameItem[]; plates?: FrameItem[]; modules?: FrameItem[]; bodyPanels?: FrameItem[]; shots?: ShotBlock<ShotLegend> & { drag?: Float64Array } }
export interface FrameEnvelope<Event extends object = Dictionary> extends Dictionary { events: readonly Event[]; serial: number; base: number | null }
export interface FramePacket extends FrameEnvelope { state: FrameScene }
export interface DecodedFramePacket<State extends object, Event extends object = Dictionary> extends FrameEnvelope<Event> { state: State }
interface Carried { x: number; y: number; angle: number; item: FrameItem }
interface Words { text: string; arrays: BinaryWords[] }
interface Memo { prints: Map<string, unknown> }
interface Entry extends Memo { item: FrameItem | undefined; before: FrameItem | undefined; changes: Words | null; whole: Words | null; users: number }
interface ItemMemo { item: FrameItem | undefined; id: string; view: unknown; index: number; serial: number; entry: Entry }
interface KeptList { memos: Map<string, ItemMemo>; order: ItemMemo[] }
interface ListDelta { $list: number; from?: number[]; at: number[]; with: Dictionary[] }
interface ToldShots { all?: Float64Array; gone?: Uint32Array; fresh?: Float64Array; turned?: Float64Array; kinds?: readonly ShotLegend[]; from?: number }
export interface Retelling { text?: string | undefined; view?: unknown }
const record = (value: unknown): value is Dictionary => value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
const list = (value: unknown): value is unknown[] => Array.isArray(value);
const dictionary = (value: unknown): Dictionary => { if (!record(value)) throw new Error('Objeto de rede inválido.'); return value; };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const words = (value: unknown): value is BinaryWords => value instanceof Float32Array || value instanceof Uint32Array || value instanceof Float64Array;
const stringList = (value: unknown): value is string[] => list(value) && value.every((v: unknown) => typeof v === 'string');
const frameItem = (value: unknown): value is FrameItem => record(value) && typeof value.id === 'string';
const frameItems = (value: unknown): value is FrameItem[] => list(value) && value.every(frameItem);
const records = (value: unknown): value is Dictionary[] => list(value) && value.every(record);
const numbers = (value: unknown): value is number[] => list(value) && value.every(finite);
const legend = (v: unknown): v is ShotLegend => record(v) && (v.preset === null || typeof v.preset === 'string') && typeof v.ammo === 'string' && typeof v.poweredTrail === 'boolean' &&
  (v.actorId === undefined || v.actorId === null || typeof v.actorId === 'string') && (v.weapon === undefined || typeof v.weapon === 'string') && (v.name === undefined || v.name === null || typeof v.name === 'string');
const legends = (value: unknown): value is ShotLegend[] => list(value) && value.every(legend);
const shotBlock = (v: unknown): v is ShotBlock<ShotLegend> & { drag?: Float64Array } => record(v) && v.data instanceof Float64Array && legends(v.kinds) && (v.drag === undefined || v.drag instanceof Float64Array);
function shotDelta(value: unknown): ToldShots {
  const v = dictionary(value), result: ToldShots = {};
  for (const key of ['all', 'fresh', 'turned'] as const) if (v[key] !== undefined) { const data = v[key]; if (!(data instanceof Float64Array)) throw new Error('Tiros de rede inválidos.'); result[key] = data; }
  if (v.gone !== undefined) { if (!(v.gone instanceof Uint32Array)) throw new Error('Tiros removidos inválidos.'); result.gone = v.gone; }
  if (v.kinds !== undefined) { if (!legends(v.kinds)) throw new Error('Legenda de tiros inválida.'); result.kinds = v.kinds; }
  if (v.from !== undefined) { if (!finite(v.from)) throw new Error('Legenda incremental inválida.'); result.from = v.from; }
  return result;
}
function listDelta(value: unknown): ListDelta {
  const v = dictionary(value);
  if (!finite(v.$list) || !Number.isInteger(v.$list) || !numbers(v.at) || !records(v.with) || v.from !== undefined && !numbers(v.from)) throw new Error('Lista incremental inválida.');
  return { $list: v.$list, at: v.at, with: v.with, ...(v.from === undefined ? {} : { from: v.from }) };
}

function scene(value: unknown): FrameScene {
  const v = dictionary(value); if (v.time !== undefined && !finite(v.time)) throw new Error('Relógio de rede inválido.');
  for (const name of LISTS) if (v[name] !== undefined && !frameItems(v[name])) throw new Error('Lista de rede inválida.');
  if (v.shots !== undefined && !shotBlock(v.shots)) throw new Error('Tiros publicados inválidos.');
  return { ...v, ...(v.time === undefined ? {} : { time: v.time }), ...(frameItems(v.actors) ? { actors: v.actors } : {}), ...(frameItems(v.plates) ? { plates: v.plates } : {}),
    ...(frameItems(v.modules) ? { modules: v.modules } : {}), ...(frameItems(v.bodyPanels) ? { bodyPanels: v.bodyPanels } : {}), ...(shotBlock(v.shots) ? { shots: v.shots } : {}) };
}
// One metadata header followed by aligned typed arrays. The rounds in the air stay binary.
import { ShotTable, ShotTeller, TOLD_WORDS } from './shot-forecast.ts';
import { localToWorld, worldToLocal } from './math.ts';
import { placeWords as placed, placeArrays as placing, pack, decodePacket } from './network-codec.ts';
// Raised whenever what the page and the server say to each other changes: constructions, frames, orders.
export const NETWORK_VERSION = 91;
// The publications whose retries must keep the same ticket on both sides.
export const PUBLICATION_COMMANDS = Object.freeze(['spawn', 'replace', 'relocate', 'post']);
// The key of a seat, as the field keeps it, of what a player typed or a browser kept: its letters and figures in upper
// case, with the letters that pass for figures read as those figures; nothing of anything else. A player is told it
// in groups of four (`keyText`).
export const keyOf = (text: unknown) => typeof text === 'string' ? text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1') : '';
export const keyText = (key: string) => key.match(/.{1,4}/g)?.join('-') ?? '';
// A number of a state is told as finely as a page shows it: a place to a tenth of a millimetre, an angle to ten
// microradians, a speed to a millimetre a second, a slip, a reload and the loading of a feed to a thousandth, fuel to a
// centilitre, a barrel to a degree. The field
// holds them exact, and what changed is told by that.
export const POSE_PRECISION = Object.freeze({ position: 1e4, angle: 1e5 });
const PLACES: Readonly<Record<string, number>> = { x: POSE_PRECISION.position, y: POSE_PRECISION.position, angle: POSE_PRECISION.angle, barrelAngle: POSE_PRECISION.angle, targetBarrelAngle: POSE_PRECISION.angle, vx: 1e3, vy: 1e3, omega: 1e4, wheelSpin: 1e4, displacement: 1e4,
  slip: 1e3, reload: 1e3, feedReload: 1e3, fuelLitres: 1e2, thrust: 1e3, barrelTemperature: 1 };
const rounding = (key: string, value: unknown): unknown => typeof value === 'number' && PLACES[key] ? Math.round(value * PLACES[key]!) / PLACES[key]! : value;
const wording = (arrays: BinaryWords[]) => { const place = placing(arrays); return (key: string, value: unknown): unknown => typeof value === 'number' ? rounding(key, value) : place(key, value); };
export function decodeFrame(input: ArrayBuffer | ArrayBufferView) {
  const packet = decodePacket(input);
  // What happened comes as rows, and is handed over as it was said.
  if (packet.events !== undefined) packet.events = unpackEvents(packet.events);
  return packet;
}

// Most of what a state says of a construction is what the state before said: its design, its
// armour, where its parts are bolted. A writer tells a whole state when asked to, and otherwise
// only what changed since the frame before; a reader puts the two together again. What a
// reader hands over is the state a whole frame would have brought, field by field.
//
// The lists of a state whose items have a life of their own. An item is known by its `id`:
// wherever it stands in its list it is the same item.
// A frame says which of the items of the frame before stay and in what order, and tells whole only
// those that came. So a state may show now more of the field and now less — a construction that
// comes into sight, one that leaves it — at the cost of what came and went.
const LISTS = ['actors', 'plates', 'modules', 'bodyPanels'] as const;
// The parts of a vehicle are told where they sit on it, and the reader puts them where the vehicle is: a plate and a
// piece by their pose, the ground a running gear touches by where the gear is, and a construction's eyes by where they
// look from. All of a vehicle but its running gear sits on it for good: a vehicle on the move is told where it went, and
// of its plates, its pieces and its eyes nothing. The field publishes such a part where the vehicle is published to be
// with the part where it sits (server/publication.ts), so that where it sits is told once, and the reader has it where
// it was published, to the tenth of a millimetre. By list: the vehicle an item goes with, and the item moved by `to`,
// to where it sits on the vehicle (`SEAT`) or back to where the vehicle is (`STAND`).
const located = (at: unknown): at is Point => record(at) && finite(at.x) && finite(at.y);
export const posed = (at: unknown): at is Pose => located(at) && 'angle' in at && finite(at.angle);
const rounded = (key: string, value: number): number => { const precision = PLACES[key]; return precision ? Math.round(value * precision) / precision : value; };
export const SEATS: Readonly<Record<'actors' | 'plates' | 'modules', SeatMapping>> = {
  actors: { body: actor => posed(actor.vehicle) ? actor.vehicle : undefined,
    move: (actor, body, to, _read, basis) => Array.isArray(actor.eyes) && actor.eyes.length ? { ...actor, eyes: actor.eyes.map((eye: unknown) => located(eye) ? { ...eye, ...to.point(body, eye, basis) } : eye) } : actor },
  plates: { body: (plate, bodies) => typeof plate.actorId === 'string' ? bodies.get(plate.actorId) : undefined,
    move: (plate, body, to, _read, basis) => posed(plate.definition) ? { ...plate, definition: { ...plate.definition, ...to.pose(body, plate.definition, basis) } } : plate },
  modules: { body: (module, bodies) => typeof module.actorId === 'string' ? bodies.get(module.actorId) : undefined, move: (module, body, to, read = null, basis) => {
    if (!posed(module)) return read ? read(module) : module;
    const pose = to.pose(body, module, basis), ground = module.groundContact, moved: SeatOverrides = pose;
    if (record(ground) && finite(ground.x)) moved.groundContact = { ...ground, x: to.ground(ground.x, module, pose) };
    return read ? read(module, moved) : { ...module, ...moved };
  } },
};
export const SEAT: SeatTransform = {
  point: (body, at, basis) => { const { u, v } = worldToLocal(body, at, basis?.()); return { x: rounded('x', u), y: rounded('y', v) }; },
  pose: (body, at, basis) => ({ ...SEAT.point(body, at, basis), angle: rounded('angle', at.angle - body.angle) }),
  ground: (x, from) => rounded('x', x - from.x),
};
export const STAND: SeatTransform = {
  point: (body, at, basis) => localToWorld(body, at.x, at.y, basis?.()),
  pose: (body, at, basis) => ({ ...localToWorld(body, at.x, at.y, basis?.()), angle: body.angle + at.angle }),
  ground: (x, _from, to) => x + to.x,
};
const bodiesOf = (actors: readonly FrameItem[] | undefined): Map<string, Pose> => { const bodies = new Map<string, Pose>(); for (const actor of actors || []) if (posed(actor.vehicle)) bodies.set(actor.id, actor.vehicle); return bodies; };
function carried(memo: WeakMap<FrameItem, Carried>, item: FrameItem, seat: SeatMapping, body: Pose | undefined, to: SeatTransform): FrameItem {
  if (!body) return item;
  let told = memo.get(item);
  if (told?.x !== body.x || told.y !== body.y || told.angle !== body.angle) memo.set(item, told = { x: body.x, y: body.y, angle: body.angle, item: seat.move(item, body, to) });
  return told.item;
}
// An item that some writers of a field tell otherwise than the rest — a construction as it shows from outside —
// names under this key the view it is of. It is then another item than the one of its name told as it is: what
// the ledger keeps of each is kept apart, and each writer goes on being told what changed. The key is no field
// of the item: nothing of it goes into a frame.
export const VIEW = Symbol('view');
// Objects a snapshot hands over again and again while they are what they were, and replaces
// when they change: told apart by which object they are, never read through. The roads of the field are one such.
const HELD = new Set(['ballisticGrid', 'weaponMount', 'materialPolygons', 'support', 'mantletHoles', 'appearance', 'localPolygon', 'roads']);
// The design of a plate, of which a frame moves three numbers, and what a frame moves of a vehicle and of a
// running gear — where it is, how it goes, how it sits on the ground — among much that stays: their own fields
// are told one by one, whichever object brings them; what they hold is told apart like the objects above.
const OPEN = new Set(['definition', 'vehicle', 'suspension', 'groundContact', 'ballisticScars']);
// The marks a part was left with: a list that grows at its end, loses its oldest and has its last one deepened.
// A frame tells how many of the first went, how many after them stay as they were, and those that follow.
const QUEUES = new Set(['marks']);
class Queue { declare items: unknown[]; declare texts: (string | undefined)[]; constructor(items: unknown[]) { this.items = items; this.texts = items.map(item => JSON.stringify(item)); } }
// What changed of a queue, or null: `held` is brought up to it. The items of a snapshot are the very objects of
// the one before while the list is what it was, so a list nothing came to is known without reading it.
function queued(held: Queue, value: unknown[]) {
  const before = held.items, old = held.texts;
  if (before.length === value.length && value.every((item, index) => item === before[index])) return null;
  const texts = value.map(item => JSON.stringify(item));
  let gone = 0, kept = 0;
  // The oldest that went are few: the shift under which the most of what follows stayed, of the first of them.
  for (let shift = 0; shift <= Math.min(old.length, 8); shift++) {
    let same = 0;
    while (shift + same < old.length && same < texts.length && old[shift + same] === texts[same]) same++;
    if (same > kept || !shift) { gone = shift; kept = same; }
    if (shift + same >= old.length - 1) break;
  }
  held.items = value.slice(); held.texts = texts;
  return kept === texts.length && !gone && old.length === texts.length ? null : { $queue: [gone, kept], more: value.slice(kept) };
}
const sameWords = (a: unknown, b: BinaryWords) => {
  if (!words(a) || a.constructor !== b.constructor || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
// What of a value is remembered to know it again: a number or a text as itself, the words of an
// array, the object itself when it is one of those held, and otherwise its text. A text kept for
// an object is kept as one, so that no string a field may hold is taken for it.
class Text { declare text: string | undefined; constructor(text: string | undefined) { this.text = text; } }
function changed(prints: Map<string, unknown>, key: string, value: unknown) {
  const old = prints.get(key);
  if (value === null || typeof value !== 'object') { if (old === value) return false; prints.set(key, value); return true; }
  if (words(value)) { if (sameWords(old, value)) return false; prints.set(key, value.slice()); return true; }
  if (HELD.has(key)) { if (old === value) return false; prints.set(key, value); return true; }
  const text = JSON.stringify(value);
  if (old instanceof Text && old.text === text) return false;
  prints.set(key, new Text(text)); return true;
}
// The fields of an open object as they were last told. A field of one is known again by which it is — its lists
// are made once — but an object of words made anew on every snapshot, by what it says.
class Fields { declare prints: Map<string, unknown>; constructor() { this.prints = new Map(); } }
const worded = (key: string, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value) && !HELD.has(key);
function moved(prints: Map<string, unknown>, key: string, value: unknown) {
  const old = prints.get(key);
  if (old === value || value !== value && old !== old) return false;
  if (worded(key, value)) return changed(prints, key, value);
  prints.set(key, value); return true;
}
// What of an item is not what the memo has of it, or null: the memo is brought up to the item.
// With `arrays`, an array that changed is put among them and the patch keeps its place.
function tell(item: Dictionary, memo: Memo, arrays: BinaryWords[] | null): Dictionary | null {
  let patch: Dictionary | null = null, seen = 0;
  for (const key in item) {
    const value = item[key];
    if (value === undefined) continue;
    seen++;
    if (OPEN.has(key) && record(value)) {
      let held = memo.prints.get(key);
      if (!(held instanceof Fields)) {
        const fresh = new Fields(); memo.prints.set(key, fresh);
        for (const k of Object.keys(value)) if (value[k] !== undefined) moved(fresh.prints, k, value[k]);
        (patch ||= {})[key] = value; continue;
      }
      let inner: Dictionary | null = null;
      for (const k of Object.keys(value)) { const v = value[k]; if (v !== undefined && moved(held.prints, k, v)) (inner ||= {})[k] = v; }
      for (const k of held.prints.keys()) if (value[k] === undefined) { held.prints.delete(k); dropKey(inner ||= {}, k); }
      if (inner) (patch ||= {})[key] = { $set: inner };
    } else if (QUEUES.has(key) && Array.isArray(value)) {
      const held = memo.prints.get(key);
      if (!(held instanceof Queue)) { memo.prints.set(key, new Queue(value.slice())); (patch ||= {})[key] = value; continue; }
      const said = queued(held, value);
      if (said) (patch ||= {})[key] = said;
    } else if (changed(memo.prints, key, value)) (patch ||= {})[key] = arrays && words(value) ? placed(arrays, value) : value;
  }
  // Every field seen is remembered: more remembered than seen is a field the item lost.
  if (memo.prints.size !== seen) for (const key of memo.prints.keys()) if (item[key] === undefined) { memo.prints.delete(key); dropKey(patch ||= {}, key); }
  return patch;
}
function dropKey(patch: Dictionary, key: string): void {
  const drops = patch.$drop;
  if (stringList(drops)) drops.push(key); else patch.$drop = [key];
}
function mend(old: unknown, patch: Dictionary): Dictionary {
  const before = record(old) ? old : {}, item: Dictionary = { ...before, ...patch };
  for (const key of Object.keys(patch)) {
    const change = patch[key], queue = record(change) && QUEUES.has(key) ? change.$queue : null;
    if (Array.isArray(queue) && finite(queue[0]) && finite(queue[1])) {
      const held = list(before[key]) ? before[key] : [], more = record(change) && list(change.more) ? change.more : [];
      item[key] = held.slice(queue[0], queue[0] + queue[1]).concat(more); continue;
    }
    const inner = record(change) ? change.$set : null;
    if (!record(inner) || !OPEN.has(key)) continue;
    const nested = { ...(record(before[key]) ? before[key] : {}), ...inner };
    for (const gone of stringList(inner.$drop) ? inner.$drop : []) delete nested[gone];
    delete nested.$drop; item[key] = nested;
  }
  for (const gone of stringList(patch.$drop) ? patch.$drop : []) delete item[gone];
  delete item.$drop; return item;
}
// Words written apart go into a frame with the arrays they name, or not at all when there are none.
const put = (arrays: BinaryWords[], said: Words | null): string | null => {
  if (!said) return null;
  for (const words of said.arrays) arrays.push(words);
  return said.text;
};

// What the writers of one field have in common. Each faction is told a frame of its own, but of a
// construction they are all told the same: what changed of an item since the frame before is
// worked out and put into words once a turn, for every writer that tells it. So is whatever else
// the frames of a turn say alike. The rounds each writer tells by itself: a faction is told those
// it witnesses, and its reader follows them from where it was told.
//
// What is kept of an item goes by the objects handed over: the item as it was last brought here,
// the one before it, and the words that take a reader from that one to this. A writer says which
// object it last told; if that is the one before, those words are its words. Nothing handed to a
// writer is written into afterwards.
// What a page makes of something that happened on the field: where and when, what it was and of what, how hard.
// The core says more of it — who fired, what was left of the round, by which handle each part goes —, which is the
// field's own to count by. A frame carries the fields a page shows and sounds an event by, a place to the
// millimetre and an instant to the microsecond, and of the path of a round its points the same way: of a fragment
// ray, what it was given (`powerBudget`); of a burst, whether it was a shaped charge's (`shaped`) or went out through
// blow-out panels, which way (`vented`, `nx`, `ny`); and of a piece struck within, whether the round went on through it
// (`penetrated`).
const EVENT_FIELDS = ['type', 'time', 'x', 'y', 'endX', 'endY', 'angle', 'nx', 'ny', 'vx', 'vy', 'power', 'speed', 'impulse', 'impactEnergy', 'closingSpeed', 'strength', 'radius',
    'reach', 'seconds', 'slip', 'count', 'direction', 'caliberMm', 'actorId', 'id', 'componentId', 'source', 'sourceKind', 'projectileId', 'kind', 'surface', 'material',
    'ground', 'track', 'contactPair', 'internal', 'penetrated', 'weapon', 'preset', 'platform', 'reason', 'n', 'ammo', 'fragment', 'spall', 'poweredTrail', 'terminal', 'arc',
    'powerBudget', 'shaped', 'spread', 'exterior', 'vented'],
  FINE = new Set(['x', 'y', 'endX', 'endY']), TIMED = new Set(['time']);
// Of some kinds a page reads less than the fog does. Of a round at a face or at a piece within, the handle of the part
// it struck is told by the part (`id`), what the round was (`fragment`, `spall`) and how squarely it came, not how fast
// (`speed`), by its path; how hard it pushed (`impulse`) sounds only of debris. Of a piece struck within, a page draws
// nothing by its kind; of a fragment's impact, nothing by a name of it; of a fragment ray, nothing by its source; and of
// a gun, nothing by what carries it. The fog tells what it tells of a part of another by those (`componentId`), so they
// are left out only as a frame packs its events (`packEvents`), each frame what it would show and sound the same.
const STRUCK = ['componentId', 'fragment', 'impulse', 'spall', 'speed'];
export const UNREAD_EVENT_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([['module', new Set([...STRUCK, 'kind'])], ['penetration', new Set(STRUCK)],
    ['blocked', new Set(STRUCK)], ['ricochet', new Set(STRUCK)], ['secondary-impact', new Set([...STRUCK, 'kind', 'id'])],
    ['secondary-ray', new Set(['source'])], ['muzzle', new Set(['platform'])]]);
const round = (value: number, per: number) => Math.round(value * per) / per,
  measured = (key: string, value: unknown): unknown => typeof value !== 'number' ? value : FINE.has(key) ? round(value, 1e3) : TIMED.has(key) ? round(value, 1e6) : Number(value.toPrecision(5));
// What happened is most of what a battle says, and most of that is said over and over: the names of the fields,
// the handle of the vehicle and of the part it happened to. A frame tells its events as rows. The kinds of row
// it has are named once, each by its fields in their order; a row is its kind and its values. A text is told
// once in a frame, however many rows say it, and a row has its place among the texts: such a field is named
// with a `$`. The points of a path are their numbers in a row (`*`).
const POINT = ['time', 'x', 'y', 'vx', 'vy'] as const,
  pointed = (value: unknown): value is Record<typeof POINT[number], number>[] => list(value) && value.every(point => record(point) && Object.keys(point).length === POINT.length && POINT.every(key => finite(point[key])));
export function packEvents(events: readonly Dictionary[]) {
  const kinds: string[][] = [], known = new Map<string, number>(), texts: string[] = [], places = new Map<string, number>(), rows: unknown[][] = [];
  for (const event of events) {
    const row: unknown[] = [0], unread = typeof event.type === 'string' ? UNREAD_EVENT_FIELDS.get(event.type) : undefined;
    let name = '';
    for (const key in event) {
      const value = event[key];
      if (value === undefined || unread?.has(key)) continue;
      if (typeof value === 'string') {
        let place = places.get(value);
        if (place === undefined) { places.set(value, place = texts.length); texts.push(value); }
        name += '\n$' + key; row.push(place);
      } else if (key === 'points' && pointed(value)) { name += '\n*' + key; row.push(value.flatMap(point => POINT.map(field => point[field]))); }
      else { name += '\n' + key; row.push(value); }
    }
    let kind = known.get(name);
    if (kind === undefined) { known.set(name, kind = kinds.length); kinds.push(name ? name.slice(1).split('\n') : []); }
    row[0] = kind; rows.push(row);
  }
  return { $rows: rows, kinds, texts };
}
function unpackEvents(input: unknown): Dictionary[] {
  const { $rows, kinds, texts } = dictionary(input);
  if (!list($rows) || !list(kinds) || !stringList(texts)) throw new Error('Eventos de rede inválidos.');
  return $rows.map(row => {
    if (!list(row) || !finite(row[0])) throw new Error('Linha de evento inválida.');
    const event: Dictionary = {}, fields = kinds[row[0]];
    if (!stringList(fields)) throw new Error('Campos de evento inválidos.');
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!, value = row[i + 1];
      if (field[0] === '$') { if (!finite(value) || texts[value] === undefined) throw new Error('Texto de evento inválido.'); event[field.slice(1)] = texts[value]; }
      else if (field[0] === '*') {
        if (!list(value)) throw new Error('Caminho de evento inválido.');
        const points: Dictionary[] = []; event[field.slice(1)] = points;
        for (let at = 0; at < value.length; at += POINT.length) { const point: Dictionary = {}; for (let k = 0; k < POINT.length; k++) point[POINT[k]!] = value[at + k]; points.push(point); }
      } else event[field] = value;
    }
    return event;
  });
}
// A view of a player's own that the field tells it in words — its squad, its faction — goes as what changed of it since it
// was last told. Of an object, the fields that changed, each as what changed of it, and under `$drop` those it lost; of a
// list as long as it was, the items that changed, by their places (`$at`); anything else whole. Nothing when nothing did.
const plain = record;
export function difference(old: unknown, value: unknown): unknown {
  if (old === value) return undefined;
  if (Array.isArray(value) && Array.isArray(old) && value.length === old.length) {
    let at: Dictionary | null = null;
    for (let index = 0; index < value.length; index++) { const said = difference(old[index], value[index]); if (said !== undefined) (at ||= {})[index] = said; }
    return at ? { $at: at } : undefined;
  }
  if (plain(value) && plain(old)) {
    let said: Dictionary | null = null;
    for (const key of Object.keys(value)) { const changed = difference(old[key], value[key]); if (changed !== undefined) (said ||= {})[key] = changed; }
    for (const key of Object.keys(old)) if (!(key in value)) dropKey(said ||= {}, key);
    return said ?? undefined;
  }
  return JSON.stringify(old) === JSON.stringify(value) ? undefined : value;
}
// What a reader has of a view, brought up to it by what changed (`difference`).
export function merged(old: unknown, said: unknown): unknown {
  if (!plain(said)) return said === undefined ? old : said;
  if (record(said.$at) && Array.isArray(old)) {
    const copy: unknown[] = old.slice();
    for (const key of Object.keys(said.$at)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= old.length || String(index) !== key) throw new Error('Mensagem inválida.');
      copy[index] = merged(old[index], said.$at[key]);
    }
    return copy;
  }
  const value: Dictionary = plain(old) ? { ...old } : {};
  for (const key of Object.keys(said)) {
    if (key === '__proto__') throw new Error('Mensagem inválida.');
    if (key !== '$drop') value[key] = merged(Object.hasOwn(value, key) ? value[key] : undefined, said[key]);
  }
  for (const key of stringList(said.$drop) ? said.$drop : []) delete value[key];
  return value;
}
// What changed of a view since a reader was last told it (`kept`: what it was told, in words and as read), or undefined.
export function retell(kept: Retelling, view: unknown): unknown {
  const text = JSON.stringify(view);
  if (text === kept.text) return undefined;
  const now: unknown = JSON.parse(text), said = difference(kept.view, now);
  kept.text = text; kept.view = now;
  return said;
}
export function tellEvent<Event extends object>(event: Event): Event extends { type: string } ? Dictionary & { type: string } : Dictionary;
export function tellEvent(event: object): Dictionary {
  const source = dictionary(event), told: Dictionary = {};
  for (const key of EVENT_FIELDS) if (source[key] !== undefined && source[key] !== null) told[key] = measured(key, source[key]);
  if (Array.isArray(source.points)) told.points = source.points.map((point: unknown) => { const p = dictionary(point);
    if (!finite(p.time) || !finite(p.x) || !finite(p.y) || !finite(p.vx) || !finite(p.vy)) throw new Error('Ponto de evento inválido.');
    return { time: round(p.time, 1e6), x: round(p.x, 1e3), y: round(p.y, 1e3), vx: round(p.vx, 10), vy: round(p.vy, 10) }; });
  return told;
}

export class FrameLedger {
  declare serial: number; declare lists: Map<string, Map<string, Entry>>; declare said: Map<object, Words>; declare seats: WeakMap<FrameItem, Carried>;
  constructor() { this.serial = 0; this.lists = new Map(); this.said = new Map(); this.seats = new WeakMap(); }
  // An item as the writers tell it: its parts where they sit on its vehicle, one object for all of them while it and the vehicle stand.
  seated(item: FrameItem, seat: SeatMapping, bodies: ReadonlyMap<string, Pose>) { return carried(this.seats, item, seat, seat.body(item, bodies), SEAT); }
  // A new frame of the field, which its writers are about to tell, each to its own.
  turn() { this.said.clear(); }
  // What is kept of the item of a list, for as long as some writer tells it.
  entry(name: string, key: string) {
    let entries = this.lists.get(name);
    if (!entries) this.lists.set(name, entries = new Map());
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { prints: new Map(), item: undefined, before: undefined, changes: null, whole: null, users: 0 });
    entry.users++;
    return entry;
  }
  leave(name: string, key: string, entry: Entry) { if (!--entry.users) this.lists.get(name)?.delete(key); }
  // Brings what is kept of an item up to the object a frame has, and keeps the words of what changed.
  follow(entry: Entry, item: FrameItem) {
    if (entry.item === item) return;
    const arrays: BinaryWords[] = [], patch = tell(item, entry, arrays);
    entry.before = entry.item; entry.item = item; entry.whole = null;
    entry.changes = patch && { text: JSON.stringify(patch, rounding), arrays };
  }
  all(entry: Entry, item: FrameItem) {
    if (!entry.whole) { const arrays: BinaryWords[] = []; entry.whole = { text: JSON.stringify(item, wording(arrays)), arrays }; }
    return entry.whole;
  }
  // The words for an item, to a writer that last told `from` of it: what changed, nothing when
  // nothing did, and all of it when `from` is not what the item was a frame ago. All of it is laid
  // by the reader over what it has, so it says too which fields of `from` the item has not: the
  // mark of a ghost, on a construction that is seen again while its owner was told it all along.
  changes(entry: Entry, from: FrameItem | undefined, item: FrameItem, arrays: BinaryWords[]) {
    this.follow(entry, item);
    if (from !== undefined && from === entry.before) return put(arrays, entry.changes);
    const all = this.all(entry, item), lost = from === undefined ? [] : Object.keys(from).filter(key => from[key] !== undefined && item[key] === undefined);
    return put(arrays, lost.length ? { text: (all.text.length > 2 ? all.text.slice(0, -1) + ',' : '{') + '"$drop":' + JSON.stringify(lost) + '}', arrays: all.arrays } : all);
  }
  // The words for the whole of an item this frame brings.
  whole(entry: Entry, item: FrameItem, arrays: BinaryWords[]) { this.follow(entry, item); return put(arrays, this.all(entry, item)); }
  // The words of anything the writers of a turn say alike, written once: the events, the measures,
  // an item one of them kept from an earlier frame.
  words(value: unknown, arrays: BinaryWords[]) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    let said = this.said.get(value);
    if (!said) { const own: BinaryWords[] = []; this.said.set(value, said = { text: JSON.stringify(value, wording(own)), arrays: own }); }
    return put(arrays, said);
  }
  // What happened since the frame before, as rows (`packEvents`): written once for the writers told the very same.
  events(list: readonly Dictionary[], arrays: BinaryWords[]) {
    let said = this.said.get(list);
    if (!said) {
      const own: BinaryWords[] = [];
      this.said.set(list, said = { text: JSON.stringify(packEvents(list), placing(own)), arrays: own });
    }
    return put(arrays, said);
  }
}

export class FrameWriter {
  declare ledger: FrameLedger; declare alone: boolean; declare serial: number | null; declare lists: Map<string, KeptList> | null; declare rest: Memo | null; declare kinds: readonly ShotLegend[] | null; declare told: number; declare teller: ShotTeller | null; declare time: number;
  // The writers of one field are given its ledger and tell its turns; a writer alone keeps one of its own.
  constructor(ledger: FrameLedger | null = null) {
    this.ledger = ledger || new FrameLedger(); this.alone = !ledger;
    this.serial = null; this.lists = null; this.rest = null; this.kinds = null; this.told = 0; this.teller = null; this.time = 0;
  }
  // `whole` tells everything: for a peer that came, one that lost a frame, a field whose constructions changed.
  encode<Packet extends { state: object }>(packet: Packet, whole = false) {
    const { state: rawState, ...rawEnvelope } = packet, state = scene(rawState), envelope = dictionary(rawEnvelope), ledger = this.ledger;
    if (this.alone) ledger.turn();
    // The frames of a ledger are numbered together: a frame of one writer is never taken for another's.
    const serial = ++ledger.serial, base = whole || !this.lists ? null : this.serial, arrays: BinaryWords[] = [], rest: Dictionary = { ...state };
    this.serial = serial; this.lists ||= new Map(); this.rest ||= { prints: new Map() };
    let text = '{';
    for (const key of Object.keys(envelope)) {
      // What happened is told when something did.
      if (key === 'events') { const events = envelope[key]; if (records(events) && events.length) text += '"events":' + ledger.events(events, arrays) + ','; continue; }
      const words = ledger.words(envelope[key], arrays);
      if (words !== undefined) text += JSON.stringify(key) + ':' + words + ',';
    }
    text += '"serial":' + serial + ',"base":' + base + ',"state":';
    for (const name of LISTS) delete rest[name];
    const shots = state.shots, bodies = bodiesOf(state.actors); delete rest.shots;
    let rounds: ToldShots | null | undefined;
    if (shots) {
      const time = state.time; if (!finite(time)) throw new Error('Relógio de tiros inválido.');
      // What a frame says of the rounds at its time: every one of them to a reader that starts here (`all`), and
      // otherwise what changed since the frame before, if anything did: the reader moves the rounds it has on by
      // the time between the two frames. A round is told when it comes and when it turns from the flight the reader
      // follows it on (shot-forecast.ts), and the places of those that went. The legend of the rounds only grows:
      // a frame tells the kinds that are new.
      const said = base === null || !this.teller ? (this.teller = new ShotTeller()).whole(shots) : this.teller.next(shots, time - this.time),
        grown = base !== null && this.kinds === shots.kinds && this.told <= shots.kinds.length;
      rounds = 'dt' in said ? {} : { all: said.fresh };
      if ('dt' in said) { if (said.gone.length) rounds.gone = said.gone; if (said.fresh.length) rounds.fresh = said.fresh; if (said.turned.length) rounds.turned = said.turned; }
      if (!grown) rounds.kinds = shots.kinds;
      else if (shots.kinds.length > this.told) { rounds.kinds = shots.kinds.slice(this.told); rounds.from = this.told; }
      if (base !== null && !Object.keys(rounds).length) rounds = undefined;
      this.kinds = shots.kinds; this.told = shots.kinds.length; this.time = time;
    } else { rounds = this.teller && base !== null ? null : undefined; this.kinds = null; this.teller = null; }
    // What is left is the state's own fields: its clock, its players, its ground.
    const own = tell(rest, this.rest, null) || {}, fields = base === null ? rest : own;
    if (rounds !== undefined) fields.shots = rounds;
    const body = JSON.stringify(fields, wording(arrays));
    // The lists are most of a frame. What is said of each item is words written already, with the
    // places of its arrays: they are put together as they stand, in the order of the lists.
    let lists = '';
    for (const name of LISTS) {
      const list = state[name];
      if (!Array.isArray(list)) { if (base !== null && this.lists.has(name)) lists += ',"' + name + '":null'; this.drop(name); continue; }
      let kept = this.lists.get(name);
      if (!kept) this.lists.set(name, kept = { memos: new Map(), order: [] });
      const memos = kept.memos, order = kept.order, seat = name === 'bodyPanels' ? undefined : SEATS[name], words: (string | null | undefined)[] = [], at: number[] = [], from: number[] = [];
      let moved = list.length !== order.length, next = -1;
      for (let index = 0; index < list.length; index++) {
        const item = seat ? ledger.seated(list[index]!, seat, bodies) : list[index]!, view = item[VIEW];
        // Most items stand where they stood: such a one is known by its place, and its name is not asked for.
        let memo = order[index];
        if (!memo || memo.serial === serial || memo.item !== item && (memo.id !== item.id || memo.view !== view)) {
          const name0 = item.id + (view ? '\n' + view : '');
          let key = name0;
          memo = memos.get(key);
          // Two items of a list under one name are told apart by their turn in it.
          for (let turn = 2; memo && memo.serial === serial; turn++) memo = memos.get(key = name0 + '#' + turn);
          if (!memo) memos.set(key, memo = { item: undefined, id: item.id, view, index: -1, serial: 0, entry: ledger.entry(name, key) });
        }
        order[index] = memo;
        if (base !== null) {
          // Where the item stood in the frame before, in runs: so many from there on, or so many new ones.
          const was = memo.index;
          if (was !== index) moved = true;
          if (from.length && next === (was < 0 ? -1 : was)) from[from.length - 1] = from[from.length - 1]! + 1; else from.push(was < 0 ? -1 : was, 1);
          next = was < 0 ? -1 : was + 1;
        }
        memo.index = index; memo.serial = serial;
        // The very object told before says nothing: a ghost, a panel.
        if (base === null) words.push(memo.item === item ? ledger.words(item, arrays) : ledger.whole(memo.entry, item, arrays));
        else if (memo.item !== item) {
          const said = ledger.changes(memo.entry, memo.item, item, arrays);
          if (said) { at.push(index); words.push(said); }
        }
        memo.item = item;
      }
      if (memos.size > list.length) for (const [key, memo] of memos) if (memo.serial !== serial) { ledger.leave(name, key, memo.entry); memos.delete(key); }
      order.length = list.length;
      // A list of which nothing changed is not named: the reader keeps it as it was.
      if (base === null) lists += ',"' + name + '":[' + words.join(',') + ']';
      else if (moved || at.length) lists += ',"' + name + '":{"$list":' + list.length + (moved ? ',"from":[' + from.join(',') + ']' : '') + ',"at":[' + at.join(',') + '],"with":[' + words.join(',') + ']}';
    }
    return pack(text + (body.length > 2 ? body.slice(0, -1) + lists : '{' + lists.slice(1)) + '}}', arrays);
  }
  drop(name: string) {
    const kept = this.lists?.get(name);
    if (!kept) return;
    for (const [key, memo] of kept.memos) this.ledger.leave(name, key, memo.entry);
    this.lists?.delete(name);
  }
  // A writer that tells no more gives back what the ledger kept for it.
  close() { for (const name of LISTS) this.drop(name); this.lists = null; }
}
const NONE: readonly number[] = [];
export class FrameReader {
  declare serial: number | null; declare state: FrameScene | null; declare table: ShotTable | null; declare placed: WeakMap<FrameItem, Carried>;
  constructor() { this.serial = null; this.state = null; this.table = null; this.placed = new WeakMap(); }
  // The state as a page has it: the plates and pieces of a vehicle where the vehicle is. What the reader keeps to read
  // the next frame by is the state as told.
  present(state: FrameScene) {
    const bodies = bodiesOf(state.actors);
    if (!bodies.size) return state;
    const shown = { ...state };
    for (const name of ['actors', 'plates', 'modules'] as const) { const items = state[name], seat = SEATS[name]; if (items) shown[name] = items.map(item => carried(this.placed, item, seat, seat.body(item, bodies), STAND)); }
    return shown;
  }
  // The rounds a frame tells, as a block of numbers, `dt` seconds after the frame before: every one of them, or what
  // changed of those the reader has — the rounds it does not tell are where their flight has taken them.
  rounds(told: ToldShots, dt = 0) {
    if (told.all) return (this.table = new ShotTable(Math.max(256, told.all.length / TOLD_WORDS))).mend([], told.all, []) ? this.table.words() : null;
    if (!this.table) return null;
    this.table.advance(dt);
    return this.table.mend(told.gone || NONE, told.fresh || NONE, told.turned || NONE) ? this.table.words() : null;
  }
  // The items of a list as a frame has them: those of the list before that stay, in the runs the
  // frame names, with the places of the new ones left open for what the frame tells of them.
  // Null when the frame names what the list before never had.
  list(old: readonly FrameItem[], delta: ListDelta): (FrameItem | undefined)[] | null {
    if (!delta.from) return delta.$list === old.length ? old.slice() : null;
    const list: (FrameItem | undefined)[] = [], runs = delta.from;
    for (let k = 0; k < runs.length; k += 2) {
      const start = runs[k], count = runs[k + 1];
      if (start === undefined || count === undefined) return null;
      if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0 || list.length + count > delta.$list) return null;
      if (start < 0) list.length += count;
      else { if (start + count > old.length) return null; for (let index = start; index < start + count; index++) list.push(old[index]); }
    }
    return list.length === delta.$list ? list : null;
  }
  // The packet, or null when it builds on a frame this reader never had: it must then ask for a whole one. A frame
  // that tells nothing of what happened hands over that nothing did.
  decode(input: ArrayBuffer | ArrayBufferView): FramePacket | null {
    const packet = decodeFrame(input), told = dictionary(packet.state), serial = packet.serial, base = packet.base ?? null;
    if (!finite(serial) || base !== null && !finite(base)) throw new Error('Sequência de rede inválida.');
    const events = packet.events ?? [];
    if (!records(events)) throw new Error('Eventos de rede inválidos.');
    let current: FrameScene;
    if (base !== null) {
      const before = this.state;
      if (!before || base !== this.serial) return null;
      const state = mend(before, told);
      for (const name of LISTS) {
        const said = told[name];
        if (said === undefined) continue;
        if (said === null) { delete state[name]; continue; }
        const delta = listDelta(said), items = this.list(before[name] || [], delta);
        if (!items) return null;
        for (const [k, index] of delta.at.entries()) {
          const patch = delta.with[k]; if (!patch) return null;
          const item = mend(items[index], patch); if (!frameItem(item)) return null; items[index] = item;
        }
        if (delta.from) for (let index = 0; index < items.length; index++) if (!items[index]) return null;
        state[name] = items;
      }
      const said = told.shots === undefined && before.shots ? {} : told.shots;
      if (said === null) { delete state.shots; this.table = null; }
      else if (said !== undefined) {
        const shots = shotDelta(said); let kinds = shots.kinds ?? before.shots?.kinds ?? [];
        if (shots.from !== undefined) { const known = before.shots?.kinds || []; if (shots.from !== known.length) return null; kinds = known.concat(kinds); }
        if (!finite(state.time) || !finite(before.time)) throw new Error('Relógio de rede inválido.');
        const data = this.rounds(shots, state.time - before.time); if (!data) return null;
        state.shots = { data, kinds };
      }
      current = scene(state);
    } else {
      if (told.shots) { const shots = shotDelta(told.shots), data = this.rounds(shots); if (!data) throw new Error('Estado de rede inválido.'); told.shots = { data, kinds: shots.kinds ?? [] }; }
      else this.table = null;
      current = scene(told);
    }
    this.serial = serial; this.state = current;
    return { ...packet, serial, base, events, state: this.present(current) };
  }
}

// The transport owns reconstruction. A consumer owns the public scene it reads;
// its decoder can cache by identity while this adapter keeps the packet opaque.
export class SceneFrameReader<State extends object> {
  readonly transport = new FrameReader();
  declare readonly decodeScene: (scene: FrameScene) => State;
  constructor(decodeScene: (scene: FrameScene) => State) { this.decodeScene = decodeScene; }
  decode(input: ArrayBuffer | ArrayBufferView): DecodedFramePacket<State> | null {
    const packet = this.transport.decode(input);
    return packet ? { ...packet, state: this.decodeScene(packet.state) } : null;
  }
}
