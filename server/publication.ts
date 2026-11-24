// What the field publishes of itself. A snapshot of the field is exact, and nothing in it stands still: a vehicle
// at rest trembles by micrometres on its suspension, a gun that fires rocks its hull, a tank that idles burns a
// drop of fuel. Told as it is, every part of every construction would be told again on every frame, to the last
// bit. What is published of a part is what was published of it before for as long as it is that, to within what
// no page shows: a place to two millimetres, an angle to a fifth of a milliradian, a speed to five millimetres a
// second — a vehicle that came to rest is told at rest. A field of a part that went
// farther is published as it is, and the others stay as they were: nothing drifts, because each is measured from
// what was last published and not from the frame before.
//
// A part that is published as it was is the very object published before: the frames tell objects apart by which
// they are, and say nothing of one they told already. What is published is nobody's to write into: of the
// objects the field goes on writing into — the design of a plate, the suspension of a wheel — it keeps its own.
//
// Nor is all of a part published: what no page reads of it stays on the field. The figures the field works a part
// by — its mass and inertia, what a gun is being laid to, the cells of its armour, where the nodes of a plate are
// (a page draws a plate from its design and its shape) —, of a construction its aim, its gun and its tally, and of
// a vehicle all but how it goes, what it has in its tanks and how it takes the ground.
//
// The plates, the pieces and the eyes of a vehicle are published where the vehicle is published to be, sitting on it
// where they were published to sit for as long as they sit there still, to within what no page shows: what is held to
// what was published of such a part is the part as it sits on the vehicle (`SEAT`, in network-protocol.ts), and what is
// published is that put where the vehicle is published to be (`STAND`). All of a vehicle but its running gear sits on
// it for good, and goes with it rigidly; a page is told where each part sits (`SEATS`).
import { SEATS, SEAT, STAND, posed } from '../src/network-protocol.ts';
import { rotationBasis } from '../src/math.ts';
import type { Pose, Basis } from '../src/math.ts';
import type { SceneSnapshot, SceneSources } from '../src/scene-contract.ts';

export type { PublishedScene, PublishedActor, PublishedModule, PublishedPlate, PublishedDefinition, PublishedVehicle } from '../src/publication-contract.ts';
import type { PublishedScene } from '../src/publication-contract.ts';

const NEAR = .002, TURN = 2e-4, SLOW = .005;
// By list, and by what an item holds — an object of fields, or a list of such objects —: how far a field may be from
// what was published of it and still be that (`slack`), and the fields no page reads (`unread`), or the only ones it reads (`read`).
interface PublicationKind { slack: Readonly<Record<string, number>>; unread: Set<string>; read: Set<string> | null }
interface KindOptions { slack?: Record<string, number>; unread?: string[]; read?: string[] | null }
const kind = ({ slack = {}, unread = [], read = null }: KindOptions): PublicationKind => ({ slack, unread: new Set(unread), read: read && new Set(read) }), KINDS: Readonly<Record<string, PublicationKind>> = {
  actors: kind({ slack: { x: NEAR }, unread: ['aim', 'weapon', 'stats', 'contactContours'] }),
  plates: kind({ unread: ['ballisticGrid', 'ballisticScars', 'physicalMass', 'physicalInertia', 'physicalCenterLocal'] }),
  modules: kind({ slack: { x: NEAR, y: NEAR, angle: TURN, barrelAngle: TURN, targetBarrelAngle: TURN, wheelSpin: .002, thrust: .01, barrelTemperature: 1 },
    unread: ['owner', 'physicalMass', 'dryMass', 'physicalInertia', 'physicalCenterLocal', 'mechanicalDepth', 'barrelProfile', 'receiverMm', 'barrelMm', 'burnAge', 'smokeClock', 'fireAge',
      'barrelDamage', 'ballisticScars', 'fuelLitres', 'capacityRounds', 'roundMass', 'aimOffset', 'targetAimOffset', 'wheelAngularSpeed', 'barrelCooling'] }),
  definition: kind({ slack: { x: NEAR, y: NEAR, angle: TURN },
    unread: ['owner', 'actorId', 'mountId', 'ballisticGrid', 'originalArea', 'physicalMass', 'physicalInertia', 'physicalCenterLocal', 'dragWidthM'] }),
  // Instantaneous flow is read by own-faction engine audio; outside keeps its allowlist.
  vehicle: kind({ slack: { x: NEAR, y: NEAR, angle: TURN, vx: SLOW, vy: SLOW, omega: .001, slip: .01, fuelLitres: .05, rangeKm: .1, fuelRate: .01 },
    unread: ['enabled', 'massTonnes', 'powerPerTonne', 'travel', 'groundSlope', 'groundSurface', 'groundGrip',
      'groundLoad', 'groundPressureKPa', 'groundResistance', 'softGroundLoad', 'lastImpulse', 'peakImpulse', 'station'] }),
  // Of a running gear, how far its strut gives and where it touches the ground: to a centimetre, where a page lays a
  // mark or throws dust.
  suspension: kind({ slack: { displacement: .001 }, read: ['displacement'] }),
  groundContact: kind({ slack: { x: .01 }, read: ['x'] }),
  eyes: kind({ slack: { x: NEAR, y: NEAR } }),
};
// Each part published on a vehicle as it was published to sit on it (`sat`), and the vehicle it was put on (`body`), by
// what was published of it. A field taken back (field-snapshot.ts) works them out again: what it publishes then is
// within what no page shows of what it would have.
type ListName = 'actors' | 'plates' | 'modules';
interface PublicationItem {
  id: string; actorId?: string | undefined; vehicle?: Pose | null | undefined;
  eyes?: { x: number; y: number; left: number; right: number }[] | undefined;
  definition?: Pose | undefined; groundContact?: { x: number } | null | undefined;
  x?: number | undefined; y?: number | undefined; angle?: number | undefined;
}
interface Body { exact: Pose; told?: Pose; seat?: () => Basis; stand?: () => Basis }
const seats = new WeakMap<object, { sat: PublicationItem; body: Pose }>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
// A publication shares each body's exact and published axes separately, only when a point is moved.
const basisFor = (angle: number): (() => Basis) => { let basis: Basis | undefined; return () => basis ||= rotationBasis(angle); };
const shown = (kind: PublicationKind, key: string): boolean => !kind.unread.has(key) && (!kind.read || kind.read.has(key));
// What of an item changes only with a count the item keeps: the shape of a plate with its revision, the marks
// left on a part with the revision of its marks. With the count as it was, it is what was published.
const FOLLOWS: Readonly<Partial<Record<string, string>>> = { solidRegions: 'revision', marks: 'markRevision' };

const sameWords = (a: Record<string, unknown>, b: unknown): boolean => {
  const length = a.length, other = record(b) ? b : undefined;
  if (length !== other?.length) return false;
  for (let i = 0; typeof length === 'number' && i < length; i++) if (a[i] !== other?.[i]) return false;
  return true;
};
// How many fields each object that was published has: one more or one less is an item that changed.
const sizes = new WeakMap<object, number>(), size = (held: object): number => sizes.get(held) ?? Object.keys(held).length;
// What is published of a value that is no number and is not the one published before (`held`): that one when
// the value says what it said, and the value otherwise.
function kept(key: string, value: unknown, held: unknown, item: Record<string, unknown>, before: Record<string, unknown>): unknown {
  if (!record(value) || !record(held)) return value;
  const count = FOLLOWS[key], inner = KINDS[key];
  if (count && typeof item[count] === 'number' && item[count] === before[count]) return held;
  if (ArrayBuffer.isView(value)) return sameWords(value, held) ? held : value;
  if (Array.isArray(value)) {
    if (!Array.isArray(held) || value.length !== held.length) return value;
    if (inner) {
      let list: unknown[] | null = null;
      for (let index = 0; index < value.length; index++) {
        const part = settled(value[index], held[index], inner);
        if (!list && part !== held[index]) list = held.slice(0, index);
        if (list) list.push(part);
      }
      return list || held;
    }
    return value.every((entry, index) => entry === held[index]) || JSON.stringify(value) === JSON.stringify(held) ? held : value;
  }
  if (inner) return settled(value, held, inner);
  return JSON.stringify(value) === JSON.stringify(held) ? held : value;
}
// An item as it is published: the one published before when every field of it is that still, and otherwise one
// with the fields that went farther, and the others as they were. Most fields of most items are the very value
// they were, and are looked at no further.
function settled(input: unknown, held: unknown, kind: PublicationKind, changes: object | null = null): unknown {
  if (!record(input)) return own(input, kind, changes);
  let item: Record<string, unknown> = input;
  let overrides = record(changes) ? changes : null;
  // Preserve spread key order when a transform adds an own field or the input is not plain data.
  if (overrides && (Object.getPrototypeOf(item) !== Object.prototype ||
    Object.keys(overrides).some(key => !Object.prototype.propertyIsEnumerable.call(item, key)))) {
    item = { ...item, ...overrides }; overrides = null;
  }
  if (!record(held)) return own(item, kind, overrides);
  const slack = kind.slack;
  let next: Record<string, unknown> | null = null, fields = 0;
  for (const key in item) {
    if (!shown(kind, key)) continue;
    const value = overrides && Object.hasOwn(overrides, key) ? overrides[key] : item[key], before = held[key];
    let told = before;
    fields++;
    if (value !== before) {
      if (typeof value !== 'number') told = kept(key, value, before, item, held);
      else if (typeof before !== 'number' || !(Math.abs(value - before) <= (slack[key] || 0)) && (value === value || before === before)) told = value;
      if (told !== before) {
        if (!next) { next = {}; for (const earlier in item) { if (earlier === key) break; if (shown(kind, earlier)) next[earlier] = held[earlier]; } }
        if (told === value) told = own(value, KINDS[key]);
      }
    }
    if (next) next[key] = told;
  }
  // A field the item lost is no field of what is published of it.
  if (!next && size(held) !== fields) { next = {}; for (const key in item) if (shown(kind, key)) next[key] = held[key]; }
  if (next) sizes.set(next, fields);
  return next || held;
}
// A value as the publication keeps it: of an item, or of an object of a kind it holds, a copy of what a page reads.
function own(value: unknown, kind: PublicationKind | undefined, changes: object | null = null): unknown {
  const overrides = record(changes) ? changes : null;
  if (!kind || !record(value)) return value;
  if (Array.isArray(value)) return value.map(entry => own(entry, kind));
  const item: Record<string, unknown> = {};
  let fields = 0;
  for (const name in value) if (shown(kind, name)) {
    const field = overrides && Object.hasOwn(overrides, name) ? overrides[name] : value[name];
    item[name] = own(field, KINDS[name]); fields++;
  }
  sizes.set(item, fields);
  return item;
}

// This is the single reflective projection bridge. KINDS applies its concrete
// Omit/Pick filter to already typed snapshot data; pose transforms preserve id
// and all unrelated fields. The public type is asserted only after that pass.
function project(item: PublicationItem, held: PublicationItem | undefined, kind: PublicationKind, overrides: object | null = null): PublicationItem {
  return settled(item, held, kind, overrides) as PublicationItem;
}
// The frame a publication read the scene as of when it last published, by what told it the scene; and of each plate and
// piece it published, what it was read from. Kept beside a publication and not in it: one taken back (field-snapshot.ts)
// reads its first state whole.
const readAt = new WeakMap<object, { changes: SceneSources['changes']; frame: number }>(), madeOf = new WeakMap<object, object>();
export class Publication {
  declare held: Record<ListName, Map<string, PublicationItem>>;
  constructor() { this.held = { actors: new Map(), plates: new Map(), modules: new Map() }; }
  // A snapshot of the field as it is published: its constructions, plates and pieces each as `settled`, in the
  // order the snapshot has them, and all else of it as it is but the count of its steps.
  // Told what the snapshot was read from (`sources`), it publishes by parts: a plate or a piece read from what it was
  // published from before, which the core has not changed since, on a construction whose vehicle has not changed either,
  // is what it was — what `settled` would make of it again, from all the same.
  state(snapshot: SceneSnapshot, sources?: SceneSources): PublishedScene {
    const { tick, ...state } = snapshot, bodies = new Map<string | undefined, Body>();
    const publishing: Omit<SceneSnapshot, 'tick' | ListName> & Record<ListName, PublicationItem[]> = state;
    const changes = sources?.changes, last = changes && readAt.get(this),
      since = changes && last?.changes === changes && changes.whole <= last.frame ? last.frame : null,
      // The constructions whose vehicle stands as it was read and published before, or that have none.
      still = new Set<string>();
    for (const name of ['actors', 'plates', 'modules'] as const) {
      const held = this.held[name], now = new Map<string, PublicationItem>(), kind = KINDS[name]!, seat = SEATS[name];
      const items: readonly PublicationItem[] = snapshot[name], from: readonly object[] | undefined = name === 'modules' ? items : sources?.[name];
      publishing[name] = items.map((item, index) => {
        const before = held.get(item.id), source = from?.[index];
        if (since !== null && name !== 'actors' && before && source && madeOf.get(before) === source && !changes!.changedAfter(source, since) &&
          (item.actorId === undefined || still.has(item.actorId))) { now.set(item.id, before); return before; }
        // A construction's eyes go with its own vehicle; a plate and a piece with the vehicle of their construction.
        const on: Body | false | undefined = name === 'actors' ? posed(item.vehicle) && { exact: item.vehicle! } : bodies.get(item.actorId);
        let told: PublicationItem;
        if (on) {
          // As it sits on the vehicle, published as `settled`; and where the vehicle is published to be, the very object
          // while neither is another.
          const was = before && seats.get(before), basis = on.seat ||= basisFor(on.exact.angle), sat = name === 'modules'
            ? seat.move(item, on.exact, SEAT, (module: PublicationItem, overrides?: object) => project(module, was?.sat, kind, overrides), basis)
            : project(seat.move(item, on.exact, SEAT, null, basis), was?.sat, kind), body = on.told || sat.vehicle!;
          told = sat === was?.sat && body === was!.body ? before! : seat.move(sat, body, STAND, null, on.stand ||= basisFor(body.angle));
          if (told !== before) seats.set(told, { sat, body });
        } else told = project(item, before, kind);
        if (name === 'actors' && on && posed(item.vehicle) && posed(told.vehicle)) { on.told = told.vehicle!; bodies.set(item.id, on); }
        if (since !== null && name === 'actors' && source && (source as SceneSources['actors'][number]).id === item.id) {
          const vehicle = (source as SceneSources['actors'][number]).vehicle;
          if (!vehicle || !changes!.changedAfter(vehicle, since) && before !== undefined && told.vehicle === before.vehicle) still.add(item.id);
        }
        if (source && name !== 'actors') madeOf.set(told, source);
        now.set(item.id, told);
        return told;
      });
      this.held[name] = now;
    }
    if (changes) readAt.set(this, { changes, frame: changes.frames });
    return publishing as PublishedScene;
  }
}
