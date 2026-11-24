import type { FogActor, FogModule, FogPlate, FogFrame, PublicTow, SharedIdentity, FogContactView, FogShotKind, FogShotBlock } from '../src/fog-contract.ts';
export type { FogActor, FogModule, FogPlate, FogFrame, PublicTow, SharedIdentity, FogContactView, FogShotKind, FogShotBlock } from '../src/fog-contract.ts';
import type { PublishedScene } from '../src/publication-contract.ts';
import type { SceneBodyPanel, SceneEventBase, FlightSceneEvent } from '../src/scene-contract.ts';
import type { ShotBlock, ShotLegend } from '../src/shots.ts';
import type { Point } from '../src/math.ts';
import type { GroundSight, SightEye, SweptEye, SightGround, EyeHorizons, SightSpan } from '../src/ground-sight.ts';
export interface FogChapter { actor: FogActor; plates: FogPlate[]; modules: FogModule[]; bodyPanels: SceneBodyPanel[]; outside?: FogChapter }
export type Chapters = Map<string, FogChapter> & { owner: Map<string, string> };
interface RadarMark extends Point { error: number; at: number }
type SoundMark = { shared: true; from: SharedIdentity; side: -1 | 1; at: number } | { shared?: false; by: string; x: number; y: number; at: number };
interface FogEntry { visible?: boolean; seenAt?: number; toldAt?: number; place?: Point; last?: FogChapter | null; ghost?: FogChapter | null; radar?: RadarMark; sound?: SoundMark }
type GhostEntry = FogEntry & { last: FogChapter; seenAt: number; place: Point };
export interface FogContact extends Point { actorId: string; visible: boolean; channel: string; age?: number; error?: number; by?: string; report?: { team: string; side: number } }
export interface SightReading { sight: Record<string, FogContact[]>; cleared?: { team: string; actorId: string }[] }
interface Sky { height(x: number): number; explored: readonly SightSpan[] }
interface SightHolder { lo: number; hi: number; reach?: number; x?: number; y?: number; eye?: SightEye; saw?: SweptEye | null; ground?: SightGround | undefined }
interface SightZone { lo: number; hi: number; holders: SightHolder[] }
export interface Witness { zones: SightZone[]; own: Set<string>; sky?: Sky }
interface WitnessOptions { base?: { x: number; radius: number } | null; sky?: Sky | null; sweeps?: GroundSight | null; lookouts?: { id: string; eyes: SightEye[] }[] }
interface Legend { of: ShotBlock<ShotLegend>['kinds']; kinds: FogShotKind[]; places: number[]; strangers: Map<string, number>; since: Map<number, number> }
// What each faction is told of the field. Its own constructions it always knows. Another's it is
// told as it shows from outside while its sensors see it; as a mark while a radar holds it or an ear
// hears it; and as a ghost — the construction as it was last seen, where it was — for a while after
// it is lost; a wreck actually seen has the field's longer memory window. The sensors are the core's:
// this keeps what they said and puts a state together from it.
// Of what flies over the field and of what happens on it, it is told what it witnesses (`witness`).
import { GHOST_SECONDS, BLIP_SECONDS, SOUND_SECONDS, BASE_MARGIN, FELT_REACH, LOW_AIR, MIST_HEIGHT, MIST_FADE } from '../src/battle-rules.ts';
import { WRECK_SECONDS } from '../src/economy.ts';
import { faceCovers } from '../src/hull-coverage.ts';
import { contains, eyeColumn, eyeSweep } from '../src/ground-sight.ts';
import { SHOT_WORDS, SHOT_NUMBER, SHOT_KIND, SHOT_X, SHOT_Y, SHOT_AGE } from '../src/shots.ts';
import { VIEW } from '../src/network-protocol.ts';
import { BARREL_SHIMMER } from '../src/weapons.ts';
export { GHOST_SECONDS, BLIP_SECONDS, SOUND_SECONDS };
export const SIGHT_GRACE = .35, // a sight stands this long: readings come a tenth of a second apart
  // A ghost is what a faction was told while it saw. One it went on seeing with nobody to tell,
  // for longer than this, is no ghost: what was last told of it is not how it was last seen.
  TOLD_SLACK = 1;
// How many of the constructions of others it saw leave the field a faction goes on knowing to be gone (`Fog.left`).
const LEFT_KEPT = 256;

const PARTS = ['plates', 'modules', 'bodyPanels'] as const;
const fresh = (at: number | undefined, span: number, time: number): at is number => at !== undefined && time - at <= span;
const visible = (entry: FogEntry, time: number) => entry.visible !== false && fresh(entry.seenAt, SIGHT_GRACE, time);
// When a reading told at `time` was taken, to the millisecond: the same reading told again says the same.
const taken = (contact: FogContact, time: number) => Math.round((time - (contact.age || 0)) * 1000) / 1000;
// Only the exterior actually seen can establish a wreck, with the field's longer memory window.
const rememberedWreck = (entry: FogEntry) => entry.last?.actor.defeated === true;
const heldSight = (entry: FogEntry, time: number) => fresh(entry.seenAt,
  entry.last ? (rememberedWreck(entry) ? WRECK_SECONDS : GHOST_SECONDS) : SIGHT_GRACE, time);
// Whether what is held is a ghost: last told as it was seen, and lost since.
const ghostly = (entry: FogEntry, time: number): entry is GhostEntry => Boolean(entry.last) && !visible(entry, time) && heldSight(entry, time);
// The fields of an item named in `keys`, those it has, as they are.
function only<T extends object, const K extends readonly PropertyKey[]>(item: T, keys: K): Pick<T, Extract<keyof T, K[number]>> {
  const left = {};
  for (const key of keys) if (Object.hasOwn(item, key)) Reflect.set(left, key, Reflect.get(item, key));
  return left as Pick<T, Extract<keyof T, K[number]>>;
}

// A published state (Publication.state) taken apart by construction: each with its plates, modules and panels, in the
// order the state has them. Whose each
// part is, by its name, the chapters say too (`owner`).
export function chapters(state: PublishedScene): Chapters {
  const all = Object.assign(new Map<string, FogChapter>(state.actors.map(actor => [actor.id, { actor, plates: [], modules: [], bodyPanels: [] }])), { owner: new Map<string, string>() }), owner = all.owner;
  for (const item of state.plates) { all.get(item.actorId!)!.plates.push(item); owner.set(item.id, item.actorId!); }
  for (const item of state.modules) { all.get(item.actorId)!.modules.push(item); owner.set(item.id, item.actorId); }
  for (const item of state.bodyPanels ?? []) { all.get(item.actorId)!.bodyPanels.push(item); owner.set(item.id, item.actorId); }
  all.owner = owner;
  return all;
}
// What looking at a construction tells, which is all another faction is told of it. Of the construction: whose it is, what
// it is called and looks like, where it stands and which way it faces, whether it is out of the fight and what the field
// keeps of it in plain view — a wreck, a service. Of its vehicle: where it is and how it moves, whether its engine runs,
// whether it flies and how its wheels take the ground — what a page draws and sounds it by. Not its eyes, its aim, the
// gun it has in hand, its reload, what it fired, the outline it touches the ground with; not its fuel, its weight and
// power, its pedals, whether it may drive nor the running gear it has left.
const SEEN = ['id', 'ownerId', 'team', 'defeated', 'burning', 'field', 'name', 'playerName', 'color', 'preset', 'appearance', 'x', 'y', 'facing', 'mirror', 'revision', 'vehicle'] as const,
  SEEN_DRIVE = ['x', 'y', 'angle', 'vx', 'vy', 'omega', 'engine', 'traction', 'slip', 'flying', 'chassisId'] as const,
  // Of a piece that shows: what it is and what it is like, where it stands, whether out in the open, what it is fixed to and the column it stands on, where its barrel lies, how
  // its running gear takes the ground, how hard a thruster blows its jet, and the damage it shows. Not its reload or its feed, where its gun is being laid nor how its servo
  // turns, the rounds or the fuel it holds, its mass. Of a road machine, how far down its tool goes. Of a hopper or a cistern
  // carried in the open, what it holds as well: its load is drawn with it.
  SEEN_PIECE = ['id', 'kind', 'actorId', 'x', 'y', 'angle', 'mirrored', 'width', 'height', 'mountId', 'attached', 'exposed', 'weaponPreset', 'weaponMount', 'materialPolygons', 'support',
    'barrelAngle', 'sensorMode', 'armorMm', 'style', 'overlay', 'metal', 'sizeScale', 'depthM', 'suspension', 'groundContact', 'wheelSpin', 'toolReach',
    'health', 'maxHealth', 'burning', 'detonated', 'barrelDisabled', 'barrelMarks', 'elevationDisabled', 'beltCut', 'marks', 'markRevision', 'thrust'] as const,
  SEEN_LOAD = [...SEEN_PIECE, 'cargo', 'capacityM3'] as const, OPEN = new Set(['excavator', 'drill', 'builder']);
// A piece as it shows, once for each object a state hands over: a piece the publication hands over again as it was is
// the very object told before, and says nothing on the wire. It is another item than the piece told whole to its own
// faction (`VIEW`): what changed of each is told apart.
const pieces = new WeakMap<FogModule, FogModule>(), asSeen = (piece: FogModule): FogModule => {
  let seen = pieces.get(piece);
  if (!seen) {
    pieces.set(piece, seen = only(piece, piece.kind === 'hopper' || piece.kind === 'cistern' ? SEEN_LOAD : SEEN_PIECE)); seen[VIEW] = 'outside';
    // A barrel shows how hot it is only as the air over it shimmers, and then as it glows; below that it is told as none at
    // all, so that it stops shimmering too.
    if (piece.kind === 'weapon') seen.barrelTemperature = (piece.barrelTemperature ?? 0) >= BARREL_SHIMMER ? piece.barrelTemperature! : 0;
  }
  return seen;
};
// A construction as it shows from outside, which is all another faction is told of it: not on its screen alone —
// nothing else of it leaves the field. Its plates and the skin of its hull; of its pieces, those no face of the
// hull covers (`faceCovers`, the rule the page draws by) — a gun, a sensor, the running gear, and a tank or a load
// carried out in the open —; and of itself, its vehicle
// and those pieces what is seen and heard of them (`SEEN`). Extraction tools and builders are
// told wherever their fixed base sits: their arm works in the open, by the actual
// activity in actor.field.extraction and actor.field.building — of a builder at work, only that it works: not the
// works or the structure it is at, nor how far its engines let it go. A road machine at work is told whole
// (`actor.field.road`): its tool and the lane it makes, which its blade or its screed shows on the ground as it goes.
// Once for a state, whoever asks: every faction that sees it is told the same.
// A hull stands where its vehicle is, as on the page; the pose a face has of its own is where the construction was
// made, and is where it stands only when it has no vehicle to take it elsewhere.
function outside(chapter: FogChapter): FogChapter {
  if (chapter.outside) return chapter.outside;
  const covered = new Set<string>(), body = chapter.actor.vehicle, moved = Number.isFinite(body?.x) && Number.isFinite(body?.y);
  for (const face of chapter.bodyPanels) for (const module of chapter.modules)
    if (!OPEN.has(module.kind) && faceCovers(face, moved ? body : face.pose, module)) covered.add(module.id);
  const actor: FogActor = only(chapter.actor, SEEN);
  if (actor.vehicle) actor.vehicle = only(actor.vehicle, SEEN_DRIVE);
  if (actor.field?.building) actor.field = { ...actor.field, building: {} };
  actor[VIEW] = 'outside';
  return chapter.outside = { actor, plates: chapter.plates, bodyPanels: chapter.bodyPanels,
    modules: chapter.modules.filter(module => !covered.has(module.id)).map(asSeen) };
}
// The names of the parts of a construction as a faction was told them, once for each telling.
const names = new WeakMap<FogChapter, Set<string>>(), partsOf = (chapter: FogChapter): Set<string> => {
  let told = names.get(chapter);
  if (!told) { names.set(chapter, told = new Set()); for (const name of PARTS) for (const item of chapter[name]) told.add(item.id); }
  return told;
};
// The construction as it was last told, standing where it was: its parts are the very objects
// told then, and of the construction itself only that it is a ghost, since when, and that it
// stands still and silent — a screen neither leads it nor hears its engine.
const ghostOf = (last: FogChapter, since: number): FogChapter => ({ ...last, actor: { ...last.actor, ghost: { since },
  ...(last.actor.vehicle ? { vehicle: { ...last.actor.vehicle, vx: 0, vy: 0, omega: 0, engine: false } } : {}) } });

// What flies over the field and what happens on it is no construction's, and a faction is told of it what it
// witnesses (`witnessed`): what an eye of one of its standing constructions has in sight in the circle of its reach
// about it, up and down alike, as its page sees the air (ground-sight.ts `eyeColumn`) — over ground in sight all the
// circle holds there, and over ground a crest hides from it what stands over the line from it over that crest —; what
// is at its base, however high, as far past each end as its ground is always clear; and what is within `FELT_REACH` of
// one of its constructions, which feels what strikes it with no eye at all. It sees with the eyes its allies' constructions
// and the posts it sees with have as well (`lookouts`, each by the name GroundSight.seen takes it by, with its `eyes`).
// What each eye swept of the ground is in `sweeps` (the faction's GroundSight, which keeps each sweep by the name of the
// eye): an eye with no sweep of its own sees all of its circle. Each of those reaches over a stretch of the field, and
// `zones` are those stretches merged, sorted, with what reaches over each: what lies over no stretch is passed over at
// once. `own` are the names of its constructions: the shells they fire it is told in the sky as well (`aloft`), where its
// page draws them over ground it does not see. `sky` says where the sky begins: the height of the ground (`height`, of a
// place) and the ground the faction explored (`explored`, as spans); a sight with none has the sky down to the ground.
export function witness(state: Pick<PublishedScene | FogFrame, 'actors'>, team: string, { base = null, sky = null, sweeps = null, lookouts = [] }: WitnessOptions = {}): Witness {
  const holders: SightHolder[] = base ? [{ lo: base.x - base.radius - BASE_MARGIN, hi: base.x + base.radius + BASE_MARGIN, reach: Infinity }] : [], own = new Set<string>(),
    looking = (id: string, eyes: readonly SightEye[]) => eyes.forEach((eye, index) =>
      holders.push({ lo: eye.x - eye.left, hi: eye.x + eye.right, eye, saw: sweeps?.kept.get(id + ':' + index) ?? null, ground: sweeps?.ground }));
  for (const actor of state.actors) {
    if (actor.team !== team) continue;
    const at = actor.vehicle || actor;
    own.add(actor.id);
    if (!actor.defeated) looking(actor.id, actor.eyes || []);
    holders.push({ lo: at.x - FELT_REACH, hi: at.x + FELT_REACH, x: at.x, y: at.y!, reach: FELT_REACH });
  }
  for (const { id, eyes } of lookouts) looking(id, eyes);
  const zones: SightZone[] = [];
  for (const held of holders.filter(held => held.hi > held.lo).sort((a, b) => a.lo - b.lo)) {
    const last = zones.at(-1);
    if (last && held.lo <= last.hi) { last.hi = Math.max(last.hi, held.hi); last.holders.push(held); }
    else zones.push({ lo: held.lo, hi: held.hi, holders: [held] });
  }
  return sky ? { zones, own, sky } : { zones, own };
}
// What an eye swept of the ground, with its horizon to each side for what it sees of the air (`eyeColumn`): swept once
// again from where it stood when it was swept for the ground, the first time a place over ground it does not see asks.
const horizons = new WeakMap<SweptEye, { x: number; y: number; horizon: EyeHorizons }>(), horizon = ({ saw, ground }: { saw: SweptEye; ground: SightGround }) => {
  let swept = horizons.get(saw);
  if (!swept) horizons.set(saw, swept = { x: saw.x, y: saw.y, horizon: eyeSweep(ground, saw).horizon! });
  return swept!;
};
// Whether what holds part of a sight (`witness`) has a place (x, y) in sight: its base all over its ground, a construction
// within its reach of it, and an eye in its circle, where it does not stand under the shadow of a crest.
function holds(held: SightHolder, x: number, y: number) {
  const eye = held.eye;
  if (!eye) return held.reach === Infinity || (x - held.x!) ** 2 + (y - held.y!) ** 2 <= held.reach! ** 2;
  if (!((x - eye.x) ** 2 + (y - eye.y) ** 2 <= (x < eye.x ? eye.left : eye.right) ** 2)) return false;
  // All of the circle over ground in sight is in sight: the line to anything over that ground runs over the line to it.
  if (!held.saw || contains(held.saw.sure, x)) return true;
  const run = eyeColumn(eye, horizon({ saw: held.saw, ground: held.ground! }), x, held.ground!.height(x));
  return run !== null && y >= run[0] && y <= run[1];
}
// Whether a faction witnesses a place over the field, by its sight (`witness`).
export function witnessed({ zones }: Witness, x: number | undefined, y: number | undefined) {
  if (x === undefined || y === undefined) return false;
  let low = 0, high = zones.length;
  while (low < high) { const mid = low + high >>> 1; if (zones[mid]!.hi < x) low = mid + 1; else high = mid; }
  const zone = zones[low];
  if (!zone || zone.lo > x) return false;
  for (const held of zone.holders) if (x >= held.lo && x <= held.hi && holds(held, x, y)) return true;
  return false;
}
// Whether a place over the field is in the sky to a faction, as its page draws the sky over ground it does not see
// (Renderer.skyline): higher over the ground than the low air over ground it explored, or than the bank of mist over
// ground it never saw.
export const aloft = ({ sky }: Witness, x: number, y: number) => !sky || y > sky.height(x) + (contains(sky.explored, x) ? LOW_AIR : MIST_HEIGHT + MIST_FADE);
// The path of a round a faction is told: its points where the faction witnesses them — and of a shell of its own, those
// in the sky too —, and that it ended only where the faction witnesses the end. A shell of its own that comes down out
// of the sky over ground it does not witness is lost to it there: where it fell, or what it struck, is no rangefinder.
// Of a path the faction witnesses nothing of, nothing.
function flownPath(event: SceneEventBase, sight: Witness): SceneEventBase | null {
  const points = event.points, mine = event.actorId != null && sight.own.has(event.actorId);
  if (!Array.isArray(points)) return mine ? event : null;
  const end = event.terminal ? points.at(-1) : null, ended = end != null && witnessed(sight, end.x, end.y);
  let kept = points.filter(point => witnessed(sight, point.x, point.y) || mine && aloft(sight, point.x, point.y));
  if (kept.length === points.length && (!end || ended)) return event;
  if (end && !ended && kept.at(-1) === end) kept = kept.slice(0, -1);
  return kept.length ? { ...event, points: kept, ...(event.terminal ? { terminal: ended } : {}) } : null;
}
// What a faction is told of what happened on the field since the frame before, by what it witnesses: what
// happened there, a ray that starts or ends there, and of the paths of the rounds what it witnesses of each
// (`flown`). What has no place is told to whose construction it is of.
export function happenings(events: readonly SceneEventBase[], sight: Witness): SceneEventBase[] {
  const told: SceneEventBase[] = [];
  for (const event of events) {
    if (event.type === 'flight') { const path = flownPath(event, sight); if (path) told.push(path); }
    else if (Number.isFinite(event.x) ? witnessed(sight, event.x, event.y) || Number.isFinite(event.endX) && witnessed(sight, event.endX, event.endY) :
      event.actorId != null && sight.own.has(event.actorId)) told.push(event);
  }
  return told;
}
// What a gun of another faction does that shows nothing outside it: finding its rounds spent, its barrel blocked.
const UNSEEN = new Set(['weapon-empty', 'weapon-blocked']);
// What is told of something that happened to a piece a faction is not told of: that it happened, where, when, how hard.
const PLAIN = ['type', 'time', 'x', 'y', 'power', 'strength'] as const;
// Something that happened as a faction is told it. Of a construction of another (`theirs`): where, when and how hard, as
// it showed. The construction is named only while the faction sees it (`parts`, the names of its parts the faction is
// told), a part of it only when that part shows, and a piece under its hull is not even said to be one of a kind. Of
// the gun that fired something, nothing but by its muzzle. A round's calibre also shows at its exterior contact,
// without identifying its gun; a contact under the hull is still PLAIN. Of what happened on its own the faction is told all, but
// the name of a part of another it is not told (`told`).
function shown(event: SceneEventBase, theirs: boolean, parts: Set<string> | null, told: (id: string | null, actorId?: string | null) => boolean): SceneEventBase {
  const out: SceneEventBase = { ...event };
  if (theirs) {
    if (!parts) delete out.actorId;
    if (event.type !== 'muzzle') {
      delete out.weapon; delete out.preset;
      if (!['blocked', 'penetration', 'ricochet'].includes(event.type)) delete out.caliberMm;
    }
    for (const key of ['id', 'componentId'] as const) if (out[key] !== undefined && !told(out[key], event.actorId)) delete out[key];
    if (event.componentId !== undefined && out.componentId === undefined && event.type !== 'muzzle') {
      const plain: SceneEventBase = only(event, PLAIN);
      if (parts) plain.actorId = event.actorId;
      return plain;
    }
  }
  if (out.source !== undefined && !told(typeof out.source === 'string' ? out.source : null, event.actorId)) { delete out.source; Reflect.deleteProperty(out, 'sourceKind'); }
  // What is told whole is the very event.
  return Object.keys(out).length === Object.keys(event).length ? event : out;
}
// The path of a round of another faction as the faction is told it: not whose it is, nor of what gun, nor a name of its
// own; and no point of it where a gun the faction does not see fired it (`muzzles`).
function stranger(event: SceneEventBase, muzzles: Set<string> | null) {
  const { actorId, weapon, ...path } = event;
  if (!/^shot-\d+$/.test(path.id ?? '')) path.id = 'shot-' + (event.n ?? 0);
  if (muzzles && Array.isArray(path.points)) {
    const points = path.points.filter(point => !muzzles.has(point.x + ',' + point.y));
    if (!points.length) return null;
    if (points.length !== path.points.length) path.points = points;
  }
  return path;
}

export class Fog {
  declare books: Map<string, Map<string, FogEntry>>;
  declare legends: Map<string, Legend>; declare departed: Map<string, Set<string>>; declare parts: Chapters | null;
  // By team: what it holds of each construction of another, the legend of the rounds it was told, and the
  // constructions of others it saw leave the field. And the chapters of the state last told.
  constructor() { this.books = new Map(); this.legends = new Map(); this.departed = new Map(); this.parts = null; }
  #book(team: string): Map<string, FogEntry> {
    let book = this.books.get(team);
    if (!book) this.books.set(team, book = new Map());
    return book;
  }
  // `team` knows a construction of another to be gone from the field: it saw it go, or took it off itself.
  #went(team: string, actorId: string) {
    let left = this.departed.get(team);
    if (!left) this.departed.set(team, left = new Set());
    left.delete(actorId); left.add(actorId);
    if (left.size > LEFT_KEPT) left.delete(left.values().next().value!);
  }
  // Whether `team` knows a construction of another to have left the field: seen to go, or taken off by itself.
  left(team: string, actorId: string) { return this.departed.get(team)?.has(actorId) ?? false; }
  // The ghosts that stand, and where each was last seen: the field says which of those places are seen empty now.
  ghosts(time: number) {
    const standing: (Point & { team: string; actorId: string })[] = [];
    for (const [team, book] of this.books) for (const [actorId, entry] of book)
      if (ghostly(entry, time)) standing.push({ team, actorId, x: entry.place.x, y: entry.place.y });
    return standing;
  }
  // What the core says of the sensors at `time` (its `teamSight`). `sight` has, by team, what it
  // holds of each construction of another: a sight (`visual`) of one a camera of the team sees now,
  // and what a radar or an ear has of one — whether the last reading took it, where, how far off
  // that may be, how old the reading is and the construction of the team that took it.
  // `cleared` are the ghosts whose place their team sees empty. `present`, when given, are the names of the
  // constructions on the field: one a team saw until now that is not among them it saw go.
  read({ sight, cleared = [] }: SightReading, time: number, present: Set<string> | null = null, current = false, identity: ((team: string) => SharedIdentity | null) | null = null) {
    // A changed permission is authoritative now, even inside the normal SIGHT_GRACE. Last told parts remain memory.
    if (current) for (const book of this.books.values()) for (const entry of book.values()) entry.visible = false;
    for (const [team, contacts] of Object.entries(sight)) {
      const book = this.#book(team);
      for (const contact of contacts) {
        if (!contact.visible) continue;
        let entry = book.get(contact.actorId);
        if (!entry) book.set(contact.actorId, entry = {});
        if (contact.channel === 'visual') {
          if (entry.last && !rememberedWreck(entry) && !fresh(entry.toldAt, TOLD_SLACK, time)) entry.last = entry.ghost = null;
          entry.seenAt = time; entry.visible = true; entry.place = { x: contact.x, y: contact.y };
        }
        else if (rememberedWreck(entry)) continue;
        // A radar that holds what was lost from sight says where it is now: the ghost gives way to the mark.
        // What a radar or an ear holds is told for a while after it was taken: the mark is as old as the reading.
        else if (contact.channel === 'radar') {
          entry.radar = { x: contact.x, y: contact.y, error: contact.error!, at: taken(contact, time) };
          if (!visible(entry, time)) entry.last = entry.ghost = null;
        } else if (contact.report?.team && contact.report.team !== team) {
          const from = identity?.(contact.report.team);
          if (from) entry.sound = { shared: true, from, side: contact.report.side < 0 ? -1 : 1, at: taken(contact, time) };
        } else entry.sound = { by: contact.by!, x: contact.x, y: contact.y, at: taken(contact, time) };
      }
    }
    for (const { team, actorId } of cleared) { const entry = this.books.get(team)?.get(actorId); if (entry) entry.last = entry.ghost = null; }
    for (const [team, book] of this.books) for (const [id, entry] of book) {
      // Seen until now and no longer on the field: it was seen to go, and leaves no ghost.
      if (present && !present.has(id) && visible(entry, time)) { book.delete(id); this.#went(team, id); }
      else if (!(heldSight(entry, time) || fresh(entry.radar?.at, BLIP_SECONDS, time) || fresh(entry.sound?.at, SOUND_SECONDS, time))) book.delete(id);
    }
  }
  // How `team` knows a construction at `time`: as its own, seen, as a ghost, on the radar — or not at all.
  knows(team: string, actor: Pick<FogActor, 'id' | 'team'>, time: number) {
    if (actor.team === team) return 'own';
    const entry = this.books.get(team)?.get(actor.id);
    return !entry ? null : visible(entry, time) ? 'seen' : ghostly(entry, time) ? 'ghost'
      : fresh(entry.radar?.at, BLIP_SECONDS, time) ? 'radar' : null;
  }
  // Where `team` holds a construction of another by a mark alone at `time`, which tells nothing of what it is: a blip its
  // radar has of it, or what an ear of its own heard of it — a report shared by another faction tells only a side —, as fresh
  // as each is told (`tell`): where along the field and how high the reading puts it. Nothing of one in sight, or of a wreck
  // it saw.
  mark(team: string, actorId: string, time: number) {
    const entry = this.books.get(team)?.get(actorId);
    if (!entry || visible(entry, time) || rememberedWreck(entry)) return null;
    if (fresh(entry.radar?.at, BLIP_SECONDS, time)) return { x: entry.radar.x, y: entry.radar.y };
    return fresh(entry.sound?.at, SOUND_SECONDS, time) && !entry.sound.shared ? { x: entry.sound.x, y: entry.sound.y } : null;
  }
  // The construction of a ghost as `team` was last told of it, or null when it holds none of that name.
  ghost(team: string, actorId: string, time: number) {
    const entry = this.books.get(team)?.get(actorId);
    return entry && ghostly(entry, time) ? entry.last.actor : null;
  }
  // Those of every ghost `team` holds at `time`, whether the constructions are still on the field or not.
  ghostsOf(team: string, time: number) { return [...this.books.get(team)?.values() ?? []].filter(entry => ghostly(entry, time)).map(entry => entry.last.actor); }
  // What `team` itself took off the field — a wreck it dismantled — it knows to be gone, seen or not: it leaves no ghost.
  gone(team: string, actorId: string) { this.books.get(team)?.delete(actorId); this.#went(team, actorId); }
  // The state `team` is told, from the state of the field and its constructions (`chapters`): its
  // own as they are and those in sight as they show from outside, then the ghosts, and in `contacts` what is only a mark.
  // A ghost is the very construction last told, so a frame after the first says nothing of it.
  tell(state: PublishedScene, parts: Chapters, team: string): FogFrame {
    const time = state.time, book = this.#book(team), told: Pick<FogFrame, 'actors' | 'plates' | 'modules' | 'bodyPanels'> = { actors: [], plates: [], modules: [], bodyPanels: [] }, contacts: FogContactView[] = [];
    const add = (chapter: FogChapter) => {
      told.actors.push(chapter.actor);
      for (const item of chapter.plates) told.plates.push(item);
      for (const item of chapter.modules) told.modules.push(item);
      for (const item of chapter.bodyPanels) told.bodyPanels.push(item);
    };
    this.parts = parts;
    for (const chapter of parts.values()) {
      const entry = book.get(chapter.actor.id);
      if (chapter.actor.team === team) add(chapter);
      else if (entry && visible(entry, time)) {
        entry.last = outside(chapter); entry.toldAt = time; entry.ghost = null;
        if (rememberedWreck(entry)) { delete entry.radar; delete entry.sound; }
        add(entry.last);
      }
    }
    for (const [id, entry] of book) {
      if (visible(entry, time)) {
        // Seen and no longer on the field: it was seen to go, and leaves no ghost.
        if (!parts.has(id)) { book.delete(id); this.#went(team, id); }
        continue;
      }
      const ghost = ghostly(entry, time);
      if (ghost) add(entry.ghost ||= ghostOf(entry.last, entry.seenAt));
      if (rememberedWreck(entry)) continue;
      // A mark says where the radar had it; what was only heard says no more than the side it came from.
      if (!ghost && fresh(entry.radar?.at, BLIP_SECONDS, time)) contacts.push({ id, kind: 'radar', x: entry.radar.x, y: entry.radar.y, error: entry.radar.error, at: entry.radar.at });
      else if (fresh(entry.sound?.at, SOUND_SECONDS, time)) {
        if (entry.sound.shared) contacts.push({ kind: 'sound', shared: true, from: entry.sound.from, side: entry.sound.side, at: entry.sound.at });
        else {
          const by = parts.get(entry.sound.by)?.actor;
          if (by) contacts.push({ kind: 'sound', by: by.id, side: entry.sound.x < (by.vehicle?.x ?? by.x) ? -1 : 1, at: entry.sound.at });
        }
      }
    }
    return { ...state, ...told, contacts };
  }
  // The rounds in the air `team` is told, of a block of them (shots.ts): those within what it witnesses (`sight`, of
  // `witness`), those the radar of its base follows (`followed`, of the number of a round: base-watch.ts), and its own
  // shells in the sky as well (`aloft`). The legend is its own too — the kinds of the rounds it was told, in the order
  // they came — so that no kind tells of a gun it saw no round of; it starts over when the field's does. Of a round of
  // another it is told what a page draws it by and no more: its kind is told as no gun's (`#stranger`), and its age is
  // how long the faction has been told it — where and when it left its gun no number of it says. The drag that is told
  // with each round lets a page follow it on from there (shot-forecast.ts).
  rounds(shots: ShotBlock<ShotLegend> & { drag?: Float64Array }, team: string, sight: Witness, followed: ((number: number) => boolean) | null = null): FogShotBlock {
    let legend = this.legends.get(team);
    if (legend?.of !== shots.kinds) this.legends.set(team, legend = { of: shots.kinds, kinds: [], places: [], strangers: new Map(), since: new Map() });
    // Of each kind of the field, whether it is of the faction's own.
    const data = shots.data, ours: boolean[] = [], kept: number[] = [];
    for (let at = 0; at < data.length; at += SHOT_WORDS) {
      const place = data[at + SHOT_KIND]!, x = data[at + SHOT_X]!, y = data[at + SHOT_Y]!;
      ours[place] ??= sight.own.has((shots.kinds[place]!.actorId ?? ''));
      if (witnessed(sight, x, y) || (ours[place] ? aloft(sight, x, y) : followed?.(data[at + SHOT_NUMBER]!))) kept.push(at);
    }
    const told: FogShotBlock = { data: new Float64Array(kept.length * SHOT_WORDS), kinds: legend.kinds }, since = new Map<number, number>();
    if (shots.drag) told.drag = new Float64Array(kept.length);
    for (let index = 0, to = 0; index < kept.length; index++, to += SHOT_WORDS) {
      const at = kept[index]!, place = data[at + SHOT_KIND]!, kind = shots.kinds[place]!;
      for (let word = 0; word < SHOT_WORDS; word++) told.data[to + word] = data[at + word]!;
      told.data[to + SHOT_KIND] = legend.places[place] ??= ours[place] ? legend.kinds.push(kind) - 1 : this.#stranger(legend, kind);
      if (!ours[place]) {
        const number = data[at + SHOT_NUMBER]!, age = data[at + SHOT_AGE]!, first = legend.since.get(number) ?? age;
        since.set(number, first); told.data[to + SHOT_AGE] = age - first;
      }
      if (told.drag) told.drag[index] = shots.drag![at / SHOT_WORDS]!;
    }
    legend.since = since;
    return told;
  }
  // A kind of round of another faction as `legend` tells it: what a page draws a round by — the gun by its preset, the
  // ammunition and the trail — and not whose it is, the name of its gun nor its own.
  // Kinds that differ by no more than that are one: no place in the legend tells two guns of one preset apart.
  #stranger(legend: Legend, kind: ShotLegend) {
    const told = { preset: kind.preset ?? null, ammo: kind.ammo, poweredTrail: Boolean(kind.poweredTrail) }, key = JSON.stringify(told);
    let place = legend.strangers.get(key);
    if (place === undefined) legend.strangers.set(key, place = legend.kinds.push(told) - 1);
    return place;
  }
  // What `team` is told of what happened on the field since the frame before (`events`, as a frame says them:
  // tellEvent), by what it witnesses (`sight`, of `witness`) at `time`: what happened where it witnesses it
  // (`happenings`), and of what a construction of another did, or what was done to it, only what showed (`shown`):
  // nothing of what a gun does inside it, nothing of the muzzle of a gun it does not see, nothing of a ray inside a hull.
  // A round of another is no gun's (`stranger`). The parts it is told by their names are those of the state last told.
  heard(events: readonly SceneEventBase[], sight: Witness, team: string, time: number) {
    const book = this.books.get(team), own = sight.own, owner = this.parts?.owner,
      // The names of the parts of a construction of another the faction sees now; null when it does not see it.
      sees = (actorId: string) => { const entry = book?.get(actorId); return entry?.last && visible(entry, time) ? partsOf(entry.last) : null; },
      // Whether the faction is told a part of the field by its name: one of its own, or one that shows of a construction
      // it sees. What is no part — the ground — is nobody's.
      told = (id: string | null, actorId?: string | null) => { const of = (id === null ? undefined : owner?.get(id)) ?? actorId; return of == null || own.has(of) || id !== null && Boolean(sees(of)?.has(id)); };
    let muzzles: Set<string> | null = null;
    for (const event of events) if (event.type === 'muzzle' && event.actorId != null && !own.has(event.actorId) && !sees(event.actorId))
      (muzzles ||= new Set()).add(event.x + ',' + event.y);
    const heard: SceneEventBase[] = [];
    for (const event of happenings(events, sight)) {
      const actorId = event.actorId, theirs = actorId != null && !own.has(actorId);
      if (event.type === 'flight') { const path = theirs ? stranger(event, muzzles) : event; if (path) heard.push(path); continue; }
      if (theirs && (UNSEEN.has(event.type) || event.type === 'secondary-ray' && event.internal || event.type === 'muzzle' && !sees(actorId))) continue;
      heard.push(theirs || event.source !== undefined ? shown(event, theirs, theirs ? sees(actorId) : null, told) : event);
    }
    return heard;
  }
  forget(team: string) { this.books.delete(team); this.legends.delete(team); this.departed.delete(team); }
}

const objectRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function isFogContact(value: unknown): value is FogContact {
  if (!objectRecord(value) || typeof value.actorId !== 'string' || typeof value.visible !== 'boolean' || typeof value.channel !== 'string' ||
    !finiteNumber(value.x) || !finiteNumber(value.y) || value.age !== undefined && !finiteNumber(value.age) ||
    value.error !== undefined && !finiteNumber(value.error) || value.by !== undefined && typeof value.by !== 'string') return false;
  if (value.report !== undefined && (!objectRecord(value.report) || typeof value.report.team !== 'string' || !finiteNumber(value.report.side))) return false;
  return value.channel === 'visual' || value.channel === 'radar' && finiteNumber(value.error) ||
    value.channel !== 'radar' && (typeof value.by === 'string' || objectRecord(value.report));
}
function isSightReading(value: unknown): value is SightReading {
  return objectRecord(value) && objectRecord(value.sight) && Object.values(value.sight).every(contacts => Array.isArray(contacts) && contacts.every(isFogContact)) &&
    (value.cleared === undefined || Array.isArray(value.cleared) && value.cleared.every((entry: unknown) => objectRecord(entry) && typeof entry.team === 'string' && typeof entry.actorId === 'string'));
}
// One admission of the teamSight reply. Fog.read consumes it without cloning or
// repeating validation over the published physical frame.
export function decodeSightReading(value: unknown): SightReading {
  if (!isSightReading(value)) throw new TypeError('Invalid Native team sight.');
  return value;
}
