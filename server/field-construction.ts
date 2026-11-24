import { compileStructuredConstruction, compileManufacture } from '../src/structured-construction.ts';
import { constructionSupportSite } from '../src/construction-admission.ts';
import { constructionEditError } from '../src/structured-editing.ts';
import { coldConstructionPlacement, constructionSpan as designSpan } from '../src/construction-placement.ts';
import { siteRefusalMessage, gap, BUILD_REACH } from '../src/construction-site.ts';
import { phrase } from '../src/i18n.ts';
import { userError } from '../src/user-message.ts';
import { constructionLimitReason } from '../src/construction-limits.ts';
import { STOCK_IDS, SUPPLIED, SUPPLY_REACH, TRANSFER_RATE, LOAD_REACH, appraise, bill, billSum, billTotal, carriedBy, cratesOf, designBill, fieldParts, stocked, stow, supplied, gatherSupplies, toolPace } from '../src/economy.ts';
import { footingBill } from '../src/fixed-footing.ts';
import { boxesOf } from '../src/work-arm.ts';
import { pileLook, pileSize } from '../src/cargo-art.ts';
import { POST_LIMIT, POST_RADIUS, POST_FULL_MESSAGE, POST_NAME, postRefusalMessage, postSpan } from '../src/territory.ts';
import { depositsNear } from '../src/deposits.ts';
import type { AuthoredConstruction, CompiledConstruction } from '../src/construction-contract.ts';
import type { World } from '../src/physics.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { SharedRoom } from './room.ts';
import type { Faction, Player, Post, Facing } from './room-contract.ts';
import type { WorkView, HeapView } from '../src/field-service-contract.ts';
export type { WorkView, HeapView } from '../src/field-service-contract.ts';

type Actor = NonNullable<ReturnType<World['actor']>>;
type Module = World['modules'][number];
type HullPart = Parameters<typeof boxesOf>[0][number];
export interface WorkSpan { minX: number; maxX: number }
interface WorkBase {
  id: string; factionId: string; ownerId: string; x: number; facing: Facing;
  cost: SupplyBill; delivered: SupplyBill; progress: number; seconds: number; from: string | null;
}
export type Work = WorkBase & ({ post: true; blueprint?: never } | { post?: false; blueprint: AuthoredConstruction });
export interface Heap { id: string; factionId: string; x: number; stock: SupplyBill }
interface WorkPlanBase { p: Pick<Player, 'id'>; faction: Pick<Faction, 'id'>; direction: Facing; position: number; cost: SupplyBill; seconds: number }
export type WorkPlan = WorkPlanBase & ({ post: true; blueprint?: null } | { post?: false; blueprint: AuthoredConstruction });
export interface BuilderAttendance { pieces: Module[]; job: string; share?: number }
export type Takedown = { id: string; team: string; x: number; span: WorkSpan;
  service: { progress: number; seconds: number; to?: string | null } } &
  ({ actor: Actor; post?: never } | { post: Post; actor?: never });
export type WorksRoom = Pick<SharedRoom, 'calm' | 'carry' | 'completeObjective' | 'constructionCounts' | 'crates' | 'deposits' | 'discard' |
  'factions' | 'fog' | 'forget' | 'free' | 'limits' | 'lowered' | 'mint' | 'outOfAction' | 'players' | 'position' | 'post' |
  'postPlaces' | 'raised' | 'record' | 'records' | 'show' | 'still' | 'supplyDispatch' | 'territory' | 'topology' | 'works' | 'world'>;
function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const items = map.get(key);
  if (items) items.push(value); else map.set(key, [value]);
}
function nearest<T>(list: readonly T[], far: (item: T) => number, reach: number): T | null {
  let best: { item: T; d: number } | null = null;
  for (const item of list) { const d = far(item); if (d <= reach && (!best || d < best.d)) best = { item, d }; }
  return best?.item ?? null;
}

// Structures are put up where their faction chose on the field, not made at a base. A works (`obra`) keeps the project, its
// place, what it costs and what of that its supply vehicles brought it: opening one costs nothing, and it is a structure of
// the faction for its limit from then on. Supply vehicles of the faction that stand still beside it (`CONSTRUCTION_REACH`),
// out of combat, unload into it what it still lacks, and builders that stand so by it — the one it was opened from, or the
// nearest free one, goes there by itself (supply-dispatch.ts) — put it up as far as that goes, one of the reference size at the
// full pace of its engines in the time the base would have taken to build it (`buildSeconds`), and all of them together
// each at its own pace (`toolPace`): it is a structure once all of it came and was put up. A works given up leaves
// what had come of it where it stood, a heap (`heap`) of the faction's that supply vehicles load again and take home; and a
// structure is taken down where it stands by a builder beside it, in the time of what it gives back, leaving that in a heap.
// Moving one is taking it down and opening a works of the same project elsewhere, which its heap goes to first. A post of a
// faction (territory.ts) is put up and taken down the same way, over the ground it serves, with no project: once it is up it
// is a place, and no structure. The works and the heaps of a faction are its own to know of: they are told to it alone
// (`view`), never in a frame of the field.
// How near a construction stands to a works, or to a structure it takes down, to work at it: the end of it within this many
// metres of it (construction-site.ts).
export const CONSTRUCTION_REACH = BUILD_REACH;

export function constructionSpan(source: AuthoredConstruction, x: number, facing: Facing): WorkSpan {
  return designSpan(compileStructuredConstruction(source), { x, facing });
}
// Explicit new manufacture only: never called by load, Works.complete or actor
// re-admission. No client-supplied ground, root IDs or pose enter this request.
export function manufactureDesign(source: AuthoredConstruction, world: World | null = null, { x = 12, facing = -1 }: { x?: number; facing?: Facing } = {}) {
  let blueprint: CompiledConstruction | null = null;
  try {
    blueprint = compileStructuredConstruction(source);
    const site = blueprint.preset === 'vehicle' || !world ? {} : constructionSupportSite(world.terrain,
      coldConstructionPlacement(blueprint, world.terrain, { x, facing, settle: world.settle }),
      designSpan(blueprint, { x, facing }));
    return compileManufacture(source, site);
  } catch (error) {
    const fixed = blueprint !== null && blueprint.preset !== 'vehicle';
    const details = error && typeof error === 'object' ? error : {};
    throw Object.assign(constructionEditError(error, { fixed }), {
      code: 'code' in details ? details.code : undefined, reason: 'reason' in details ? details.reason : undefined,
      ids: 'ids' in details ? details.ids : undefined });
  }
}
// Of a bill, its whole units, as a faction is told it.
const whole = (amounts: SupplyBill): SupplyBill => bill(...STOCK_IDS.map(id => stocked(amounts[id])));
// A heap is gone once nothing of a whole unit is left of it.
const spent = (stock: SupplyBill): boolean => STOCK_IDS.every(id => stocked(stock[id]) < 1);

// Where a structure may stand, as its faction asks for it (construction-site.ts): within the territory of its faction and
// in that of no other (territory.ts), clear of the structures, the posts and the works of the faction but `ignore` — the
// works being finished, or the structure being moved, which holds no ground of its own for it either. Vehicles reserve no
// ground, nor does what is of the others: constructions pass through one another on this field, a vehicle moves off, and a
// refusal must not tell of one the faction does not see. Returns the stretch the structure takes up; refused, in words, by
// the first rule it breaks.
export function constructionSite(room: WorksRoom, faction: Faction, source: AuthoredConstruction, x: number, facing: Facing, ignore: string | null = null): WorkSpan {
  return standing(room, faction, Number.isFinite(x) ? constructionSpan(source, x, facing) : null, x, ignore);
}
// Where a post may stand, as its faction asks for it: over the ground it serves (territory.ts `postSpan`) by the rules of a
// structure (`constructionSite`), where its faction has fewer posts than it may have, standing or being put up — that
// first —, as far from its base and its other posts as a post keeps, and off the veins where trucks load: every site of the
// ground holds one (`postRefusal`). `ignore` is the works of the post being finished. Returns the ground it stands on;
// refused, in words, by the first rule it breaks.
export function postSite(room: WorksRoom, faction: Faction, x: number, ignore: string | null = null): WorkSpan {
  const posts = room.postPlaces(faction, ignore);
  if (Number.isFinite(x) && posts.length >= POST_LIMIT) throw userError(POST_FULL_MESSAGE);
  const span = standing(room, faction, Number.isFinite(x) ? postSpan(x) : null, x, ignore),
    reason = postRefusalMessage({ x, base: faction.base?.x ?? null, posts, sites: depositsNear(room.deposits, x, POST_RADIUS + LOAD_REACH) });
  if (reason) throw userError(reason);
  return span;
}
// Whether something of a faction may stand over `span`, about `x` (construction-site.ts),
// as `constructionSite` and `postSite` ask it. What it keeps clear of is each structure of the faction where it stands, the
// ground of each of its posts and each of its works, but `ignore`. Returns `span`; refused, in words.
function standing(room: WorksRoom, faction: Faction, span: WorkSpan | null, x: number, ignore: string | null): WorkSpan {
  const reason = !span || x < room.limits.minX || x > room.limits.maxX ? phrase('Posição no campo inválida.') :
    siteRefusalMessage({ span, limits: room.limits, explored: room.fog ? faction.explored ?? [] : null, own: room.territory(faction, ignore),
      foreign: [...room.factions.values()].filter(other => other !== faction).map(other => room.territory(other)), home: faction.base?.x ?? null,
      ground: room.world.terrain,
      taken: [...room.world.actors.filter(actor => actor.team === faction.id && !actor.vehicle && actor.id !== ignore).map(actor => room.world.actorBounds(actor.id)),
        ...faction.posts.filter(post => post.id !== ignore).map(post => postSpan(post.x)),
        ...room.works.of(faction.id).filter(work => work.id !== ignore).map(work => room.works.span(work))] });
  if (reason) throw userError(reason);
  return span!;
}
// What a works of a structure costs at its place: its design, and the footing a slope asks for there (fixed-footing.ts), the
// same bill the page quotes. Taking the structure down gives back nothing of the footing: moved, it pays for one again where
// it goes.
export function structureBill(room: Pick<WorksRoom, 'world'>, source: AuthoredConstruction, x: number, facing: Facing): SupplyBill {
  const blueprint = compileStructuredConstruction(source);
  return billSum(designBill(blueprint), footingBill(blueprint, room.world.terrain, { x, facing }));
}

export class Works {
  declare room: WorksRoom;
  declare pending: Map<string, Work>; declare heaps: Map<string, Heap>;
  declare builders: Map<string, string[]>; declare feeders: Map<string, string[]>; declare idle: Map<string, string[]>;
  declare blocked: Map<string, string>; declare spans: Map<string, WorkSpan>;
  declare hulls: { time: number; plates: World['plates']; modules: World['modules']; parts: Map<string, HullPart[]>; of: Map<string, WorkSpan> } | null;
  constructor(room: WorksRoom) {
    this.room = room;
    // The works under way and the heaps on the field, each by its name. A works is named as the structure it becomes; a
    // heap as what it is of: the works given up or the structure taken down.
    this.pending = new Map(); this.heaps = new Map();
    // What each works and each structure being taken down had working on it at the last look: builders, and supply
    // vehicles unloading, and the builders standing by a works with nothing to put up until more comes; and why a works all
    // put up waits. What the stretch of each works is, worked out once.
    this.builders = new Map(); this.feeders = new Map(); this.idle = new Map(); this.blocked = new Map(); this.spans = new Map();
    // The parts of each construction at the last look they were asked for at, and the stretch of the field each takes up
    // then (`hull`).
    this.hulls = null;
  }
  // What the field keeps of them (`SharedRoom.keep`): all of it but what the last look saw.
  keep() {
    return { works: [...this.pending.values()].map(work => structuredClone(work)), heaps: [...this.heaps.values()].map(heap => structuredClone(heap)) };
  }
  resume({ works, heaps }: { works: Work[]; heaps: Heap[] }): void {
    if (!Array.isArray(works) || !Array.isArray(heaps)) throw new Error('Campo salvo sem obras ou montes.');
    this.pending = new Map(works.map(work => [work.id, structuredClone(work)])); this.heaps = new Map(heaps.map(heap => [heap.id, structuredClone(heap)]));
  }
  of(factionId: string): Work[] { return [...this.pending.values()].filter(work => work.factionId === factionId); }
  heapsOf(factionId: string): Heap[] { return [...this.heaps.values()].filter(heap => heap.factionId === factionId); }
  // The stretch of the field a works takes up: what its structure stands over, or of the works of a post (`post`), the
  // ground of that post (territory.ts `postSpan`).
  span(work: Work): WorkSpan {
    if (!this.spans.has(work.id)) this.spans.set(work.id, work.post ? postSpan(work.x) : constructionSpan(work.blueprint, work.x, work.facing));
    return this.spans.get(work.id)!;
  }
  // What a works is named by: the project of its structure, or of a post, a post.
  name(work: Work) { return work.post ? POST_NAME : work.blueprint.name; }
  // The stretch of the field a construction takes up as it stands, end to end, by the boxes of its parts still on it
  // (work-arm.ts `boxesOf`, which a crane is parked by): of all of them, sorted once a look of the field, when one is asked.
  hull(actor: Actor): WorkSpan {
    const world = this.room.world;
    if (this.hulls?.time !== world.time || this.hulls.plates !== world.plates || this.hulls.modules !== world.modules) {
      const parts = new Map<string, HullPart[]>(), add = (id: string, part: HullPart): void => append(parts, id, part);
      for (const plate of world.plates) if (plate.attached !== false) add(plate.actorId!, plate.definition);
      for (const piece of world.modules) if (piece.attached !== false) add(piece.actorId, piece);
      this.hulls = { time: world.time, plates: world.plates, modules: world.modules, parts, of: new Map() };
    }
    const { parts, of } = this.hulls;
    if (!of.has(actor.id)) {
      const boxes = boxesOf(parts.get(actor.id) ?? []), x = this.room.position(actor);
      of.set(actor.id, boxes.length ? { minX: Math.min(...boxes.map(box => box.lo)), maxX: Math.max(...boxes.map(box => box.hi)) } : { minX: x, maxX: x });
    }
    return of.get(actor.id)!;
  }
  // How far a construction stands from a stretch of the field, from the nearer end of it; and whether it stands beside it,
  // near enough to work at what takes it up (`CONSTRUCTION_REACH`).
  gap(actor: Actor, span: WorkSpan): number { return gap(this.hull(actor), span); }
  beside(actor: Actor, span: WorkSpan): boolean { return this.gap(actor, span) <= CONSTRUCTION_REACH; }
  // The stretch of the field a heap takes up, as the screens show it (cargo-art.ts): a supply vehicle loads it from beside
  // that (`SUPPLY_REACH`), as a crane loads it (supply-dispatch.ts `parking`).
  pile(heap: Heap): WorkSpan {
    const { width } = pileSize(pileLook(heap.stock));
    return { minX: heap.x - width / 2, maxX: heap.x + width / 2 };
  }
  // What a works still lacks, and how far along what came of it goes: the least share of any stock it asks for.
  need(work: Work): SupplyBill { return bill(...STOCK_IDS.map(id => work.cost[id] - work.delivered[id] > 1e-6 ? work.cost[id] - work.delivered[id] : 0)); }
  share(work: Work): number {
    let least = 1;
    for (const id of STOCK_IDS) if (work.cost[id] > 0) least = Math.min(least, work.delivered[id] + 1e-6 >= work.cost[id] ? 1 : work.delivered[id] / work.cost[id]);
    return least;
  }
  // A works opened for a player of a faction, at a place the faction may have (`constructionSite`), of a project as the field
  // keeps it, with its bill and the time it takes to put up; `from` is the structure it is moved from, whose heap it is
  // brought first. The works of a post (`post`, territory.ts) has no project: it is the post, where a post may stand
  // (`postSite`), and comes from nothing.
  open(plan: WorkPlan, from: string | null = null): Work {
    const { p, faction, direction, position, cost, seconds } = plan;
    const base: WorkBase = { id: this.room.mint('c'), factionId: faction.id, ownerId: p.id, x: position, facing: direction,
      cost: { ...cost }, delivered: bill(), progress: 0, seconds, from };
    const work: Work = plan.post ? { ...base, post: true } : { ...base, blueprint: plan.blueprint };
    this.pending.set(work.id, work);
    return work;
  }
  // A works given up makes no structure: what came of it is left where it stood, in a heap of the faction's. Moving a structure
  // is given up with it: the structure taken down for it stands as it was. Returns the heap, or nothing where nothing came.
  cancel(work: Work): Heap | null {
    const mover = work.from ? this.room.world.actor(work.from) : null, record = mover ? this.room.records.get(mover.id) : undefined;
    if (record?.service?.kind === 'dismantle' && record.service.to === work.id) this.room.free(mover!);
    this.drop(work.id);
    return this.heap(work.id, work.factionId, work.x, work.delivered);
  }
  drop(id: string): void { for (const map of [this.pending, this.spans, this.builders, this.feeders, this.blocked]) map.delete(id); }
  heap(id: string, factionId: string, x: number, stock: SupplyBill): Heap | null {
    if (spent(stock)) return null;
    const heap = { id, factionId, x, stock: { ...stock } };
    this.heaps.set(id, heap);
    return heap;
  }
  // Everything of a faction leaves the field: its works and its heaps. Returns what had come of the works and what lay in
  // the heaps, by stock.
  clear(factionId: string): SupplyBill {
    const back = bill();
    for (const work of this.of(factionId)) { for (const id of STOCK_IDS) back[id] += work.delivered[id]; this.drop(work.id); }
    for (const heap of this.heapsOf(factionId)) { for (const id of STOCK_IDS) back[id] += heap.stock[id]; this.heaps.delete(heap.id); }
    return back;
  }
  // Supply pieces that serve unload into a works what it lacks of what they carry — but what they keep for later on their trip
  // (`keep`, supply-dispatch.ts `combine`) —, as far as `budget` units go, each stock in the share of what it lacks: what
  // came grows evenly. Returns how much went in.
  deliver(work: Work, crates: Module[], budget: number, keep: SupplyBill | null = null): number {
    const held = supplied(carriedBy(crates).carried), carried = keep ? bill(...STOCK_IDS.map(id => Math.max(0, held[id] - keep[id]))) : held, need = this.need(work),
      wanted = bill(...STOCK_IDS.map(id => Math.max(0, Math.min(need[id], carried[id])))), total = billTotal(wanted);
    if (!(total > 1e-6) || !(budget > 0)) return 0;
    const share = Math.min(1, budget / total);
    let moved = 0;
    for (const id of STOCK_IDS) if (wanted[id] > 0) {
      const taken = stow(crates, SUPPLIED[id], -wanted[id] * share);
      this.room.carry(taken.changed); work.delivered[id] = Math.min(work.cost[id], work.delivered[id] + taken.moved); moved += taken.moved;
    }
    return moved;
  }
  // Supply pieces load what lies in a heap, as far as they have room and `budget` units go, each stock in the share it has of
  // the heap. A heap with nothing of a whole unit left is gone. Returns how much was loaded.
  gather(heap: Heap, crates: Module[], budget: number): number {
    const moved = gatherSupplies(heap.stock, crates, budget, changed => this.room.carry(changed));
    if (spent(heap.stock)) this.heaps.delete(heap.id);
    return moved;
  }
  // What `elapsed` seconds bring to the works and take of the heaps, and who builds what. A construction of a faction that
  // stands still out of combat, held by no service, does its part: one with supply pieces that serve loads what lies in the
  // nearest heap of its faction it stands beside (`SUPPLY_REACH` off its pile, `pile`) and unloads into the nearest works of its faction that lacks
  // something it carries, of those it stands beside (`beside`) — a supply vehicle on a trip of the dispatch, only at the heap
  // and the works of its trip, and a builder loading the heap of what it took down, only at that heap (supply-dispatch.ts) —,
  // each at `TRANSFER_RATE`; and a vehicle with builders that work takes up the nearest of what there is to do of what it
  // stands so beside, where it unloads too: a works with more come of it than put up, or a structure being taken down —
  // one the dispatch sent to something, that alone (`errand`). Its builders do one thing at a time. Returns them, by the
  // construction they are on (`pieces`), with what they are at
  // (`job`, the name of the works or of the structure): the field asks its engines for them with its other tools at work
  // (SharedRoom.haul), and says what share of their pace they give (`share`) before they work (`step`).
  attend(elapsed: number): Map<string, BuilderAttendance> {
    const room = this.room, world = room.world, takedowns = this.takedowns(), building = new Map<string, BuilderAttendance>();
    this.builders = new Map(); this.feeders = new Map(); this.idle = new Map();
    if (!this.pending.size && !this.heaps.size && !takedowns.length) return building;
    const crates = new Map<string, Module[]>(), tools = new Map<string, Module[]>(), out = room.outOfAction(),
      add = (map: Map<string, Module[]>, m: Module): void => append(map, m.actorId, m);
    for (const m of cratesOf(world.modules)) if (m.health > 0 && m.attached !== false) add(crates, m);
    for (const m of world.modules) if (m.kind === 'builder' && m.health > 0 && m.attached !== false) add(tools, m);
    for (const actor of world.actors) {
      const record = room.records.get(actor.id), faction = room.players.has(actor.ownerId!) && room.factions.get(actor.team!);
      if (!faction || !record || record.wreck || record.service || out[actor.id] || !room.still(actor) || !room.calm(actor)) continue;
      const served = crates.get(actor.id), off = (work: Work) => this.gap(actor, this.span(work)), by = (heap: Heap) => this.gap(actor, this.pile(heap));
      if (served) {
        const trip = room.supplyDispatch.task(actor.id),
          heap = trip ? trip.heap && this.heaps.get(trip.heap) : nearest(this.heapsOf(faction.id), by, SUPPLY_REACH);
        if (heap && by(heap) <= SUPPLY_REACH) this.gather(heap, served, TRANSFER_RATE * elapsed);
        const carried = supplied(carriedBy(served).carried), lacking = (work: Work) => {
          const need = this.need(work);
          return STOCK_IDS.some(id => need[id] > 0 && carried[id] > 1e-6);
        },
          work = trip ? trip.work && this.pending.get(trip.work) : nearest(this.of(faction.id).filter(lacking), off, CONSTRUCTION_REACH);
        if (work && off(work) <= CONSTRUCTION_REACH && this.deliver(work, served, TRANSFER_RATE * elapsed, trip?.keep) > 0) append(this.feeders, work.id, actor.id);
      }
      if (tools.has(actor.id) && actor.vehicle?.config.enabled) {
        const sent = room.supplyDispatch.errand(actor.id)?.targetId, ours = (id: string) => !sent || id === sent,
          jobs = [...this.of(faction.id).filter(work => ours(work.id) && work.progress < this.share(work) - 1e-9).map(work => ({ id: work.id, span: this.span(work) })),
            ...takedowns.filter(down => down.team === faction.id && ours(down.id)).map(down => ({ id: down.id, span: down.span }))],
          job = nearest(jobs, job => this.gap(actor, job.span), CONSTRUCTION_REACH);
        if (job) { append(this.builders, job.id, actor.id); building.set(actor.id, { pieces: tools.get(actor.id)!, job: job.id }); }
        else {
          const waiting = nearest(this.of(faction.id).filter(work => ours(work.id)), off, CONSTRUCTION_REACH);
          if (waiting) append(this.idle, waiting.id, actor.id);
        }
      }
    }
    return building;
  }
  // What is being taken down on the field, each by its name, whose it is (`team`), where it stands and the stretch of the
  // field it takes up (`span`), and how far that has gone (`service`): a structure held so (`service.kind`, room.ts
  // `takeDown`), as it stands now (`hull`), or a post a builder of its faction takes down (`post.takedown`, room.ts
  // `lower`), over its ground.
  takedowns(): Takedown[] {
    const room = this.room, down: Takedown[] = [];
    for (const actor of room.world.actors) {
      const service = room.records.get(actor.id)?.service;
      if (service?.kind === 'dismantle') down.push({ id: actor.id, team: actor.team!, x: room.position(actor), span: this.hull(actor), service, actor });
    }
    for (const faction of room.factions.values()) for (const post of faction.posts)
      if (post.takedown) down.push({ id: post.id, team: faction.id, x: post.x, span: postSpan(post.x), service: post.takedown, post });
    return down;
  }
  // The one of them of this name, or nothing.
  takedown(id: string | null | undefined): Takedown | null { return this.takedowns().find(down => down.id === id) ?? null; }
  // What `elapsed` seconds of the builders at work (`attend`, with the share of their pace their engines gave them) did for
  // the works and what is being taken down. Each goes as far as all the builders at it go together. What is all put up is a
  // structure or a post (`complete`), and what is all taken down a heap (`finish`).
  step(elapsed: number, building: ReadonlyMap<string, BuilderAttendance>): void {
    const room = this.room, pace = (id: string) => (this.builders.get(id) ?? []).reduce((sum, actorId) => {
      // SharedRoom.haul asks power for every attendance before this phase.
      const { pieces, share } = building.get(actorId)!;
      return sum + share! * pieces.reduce((each, piece) => each + toolPace(piece), 0);
    }, 0);
    for (const work of [...this.pending.values()]) {
      const share = this.share(work), going = pace(work.id);
      if (going > 0 && work.progress < share) work.progress = work.seconds > 0 ? Math.min(share, work.progress + elapsed * going / work.seconds) : share;
      if (work.progress >= 1 - 1e-9) this.complete(work);
    }
    for (const down of this.takedowns()) {
      const service = down.service, going = pace(down.id);
      if (!(going > 0)) continue;
      service.progress = service.seconds > 0 ? Math.min(1, service.progress + elapsed * going / service.seconds) : 1;
      if (service.progress >= 1 - 1e-9) this.finish(down); else if (down.actor) room.show(down.actor);
    }
  }
  // A works all put up is a structure, where it stood and as it faced, under the name it had, once its place and the limit of
  // the faction admit it still: until they do it waits there, all put up, saying why (`blocked`). It is the player's who
  // opened it while that one is of the faction, or else its leader's; and it is held by nobody. The works of a post is a post
  // of the faction from then on, where a post may stand still (`postSite`): a place, not a construction (room.ts `raised`).
  complete(work: Work): void {
    const room = this.room, faction = room.factions.get(work.factionId)!;
    try {
      if (work.post) postSite(room, faction, work.x, work.id);
      else {
        constructionSite(room, faction, work.blueprint, work.x, work.facing, work.id);
        const limit = constructionLimitReason(room.constructionCounts(faction, work.id), false);
        if (limit) throw new Error(limit);
      }
    } catch (error) { this.blocked.set(work.id, error instanceof Error ? error.message : String(error)); return; }
    this.drop(work.id);
    if (work.post) { room.raised(faction, work); return; }
    const owner = room.players.get(faction.members.has(work.ownerId) ? work.ownerId : faction.leader)!;
    const actor = room.world.addActor(work.blueprint, { id: work.id, ownerId: owner.id, team: faction.id, x: work.x, facing: work.facing, color: owner.color, playerName: owner.name });
    room.record(actor);
    room.topology++; room.show(actor); owner.squad!.sync();
    room.completeObjective(owner, 'buildDefense');
  }
  // What is all taken down leaves the field, and what it gives back lies where it stood, in a heap named as it was. Of a
  // structure, what is left of it, by the rules of dismantling (`appraise`: a whole piece for all it cost, a damaged one for a
  // share of what is left of it), with what its supply pieces carried; what its hoppers and its cisterns held comes out as a
  // load tipped does: it is lost. Of a post, what its faction put into it (room.ts `lowered`).
  finish(down: Takedown) {
    if (down.post) return this.room.lowered(down.post);
    const room = this.room, actor = down.actor, value = appraise(actor, fieldParts(room.world)).salvage, carried = supplied(carriedBy(room.crates(actor.id)).carried),
      heap = this.heap(actor.id, actor.team!, room.position(actor), billSum(value, carried)), owner = room.players.get(actor.ownerId!);
    room.discard(actor.id);
    if (owner) room.forget(owner, actor.id);
    return heap;
  }
  // The paid target of a selected arm must still be a pending works or something being taken down.
  working(actorId: string): string | null {
    const at = this.room.records.get(actorId)?.building?.at;
    return at && this.builders.get(at)?.includes(actorId) && (this.pending.has(at) ||
      this.room.world.actor(at) && this.room.records.get(at)?.service?.kind === 'dismantle' || Boolean(this.room.post(at)?.takedown)) ? at : null;
  }
  // The works and the heaps of a faction as each member is told them. Of a works: its name and where it stands, its project
  // — or that it is to be a post (`post`), which has none —, what it costs and what of that came, how far it is put up,
  // whether a builder and supply vehicles work on it now, whether a builder stands by it with nothing to put up until more
  // comes (`waiting`), the builder sent to it (`sent`), why it waits all put up, the structure it is moved from, and what its
  // base has not of what it still lacks — less what the dispatch is bringing it (`lack`). Of a heap: where it lies and what
  // is in it.
  view(faction: Faction): { works: WorkView[]; heaps: HeapView[] } {
    const stock = faction.stock;
    return {
      works: this.of(faction.id).map(work => {
        const need = this.need(work), coming = this.room.supplyDispatch.carrying(work.id),
          lack = bill(...STOCK_IDS.map(id => Math.max(0, Math.ceil(need[id] - coming[id] - Math.max(0, stock[id]) - 1e-6))));
        const head = { id: work.id, name: this.name(work) }, tail = { x: work.x, facing: work.facing, cost: work.cost, delivered: whole(work.delivered),
          progress: Math.floor(work.progress * 1000) / 1000, share: Math.floor(this.share(work) * 1000) / 1000, seconds: work.seconds,
          building: this.builders.get(work.id)?.some(actorId => this.working(actorId) === work.id) ?? false, waiting: !this.builders.has(work.id) && this.idle.has(work.id), sent: this.room.supplyDispatch.coming(work.id),
          supplying: this.feeders.has(work.id), blocked: this.blocked.get(work.id) ?? '', from: work.from, lack };
        return work.post ? { ...head, post: true, ...tail } : { ...head, blueprint: work.blueprint, ...tail };
      }),
      heaps: this.heapsOf(faction.id).map(heap => ({ id: heap.id, x: heap.x, stock: whole(heap.stock) })),
    };
  }
}
