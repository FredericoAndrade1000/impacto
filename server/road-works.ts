import { userError } from '../src/user-message.ts';
import type { RoadworkView } from '../src/field-service-contract.ts';
export type { RoadworkView } from '../src/field-service-contract.ts';
import { stretches, length, isRoadKind } from '../src/roads.ts';
import { ROAD_SEAM, roadLeft, roadRefusalMessage, roadWork, without } from '../src/road-site.ts';
import { TOOL_CONTACT, gradedGround, placeOf, toolNeed, toolOffset } from '../src/road-tools.ts';
import { PAVING, STOCK_IDS, SUPPLIED, carriedBy, pavedBy, roadRate, stow, supplied } from '../src/economy.ts';
import { MIX_VOLUME, cargoRoom, mixRoom, mixSpace } from '../src/component-volume.ts';
import type { World } from '../src/physics.ts';
import type { RoadKind, RoadSpan } from '../src/roads.ts';
import type { SharedRoom } from './room.ts';
import type { Faction } from './room-contract.ts';
import type { RoadDispatchJob } from './supply-dispatch.ts';

type Actor = NonNullable<ReturnType<World['actor']>>;
type Module = World['modules'][number];
export type RoadPart = 'grade' | 'pave';
export interface RoadOrder { id: string; factionId: string; x0: number; x1: number; kind: RoadKind }
export interface RoadLane { from: number; to: number; dir: number }
export interface ToolWork { share: number; limit?: 'engine' | 'fuel' | 'power' | null | undefined }
export type ToolWorkView = { limit: 'engine' | 'fuel' } | { pace: number; limit?: 'engine' | 'fuel' | 'power' };
export type RoadRoom = Pick<SharedRoom, 'calm' | 'carry' | 'field' | 'fog' | 'limits' | 'mint' | 'outOfAction' | 'pave' |
  'players' | 'position' | 'power' | 'records' | 'serving' | 'supplyDispatch' | 'world'>;

// The roads a faction asks for on the shared field, and the road machines that make them (supply-dispatch.ts). A road asked
// for (`estrada`) is a stretch of the field and the kind of road it is to be: graded earth, or asphalt — asked for from one
// road to another, the ground between them (`open`). Asking costs nothing. What of it is made is the field's roads (roads.ts): a blade grades the natural ground of the stretch into earth
// and a paver lays asphalt over what is graded, out of the mix it carries in the hopper built into it (`PAVING`), which the supply
// pieces of its vehicle feed with the mix they carry (`feed`) — asphalt over
// natural ground is graded first, and paved behind the blades as it is graded. Each machine takes a lane of what is left to
// do of its part, `ROAD_LANE` metres at most, that no other of its kind is on, and drives along it no faster than its tools
// work (`step`): several of them on one road work it each on a lane of its own, and their paces add up. What it does is laid
// on the field `ROAD_CHUNK` metres at a time, and what is left of a chunk when it leaves its lane (`commit`). A road all
// made is done with. The roads asked for are their faction's to know of: they are told to it alone (`view`).
export const ROAD_LANE = 50, ROAD_CHUNK = 10;
// The tool of each part of the making of a road.
export const ROAD_TOOLS = Object.freeze({ grade: 'blade', pave: 'paver' } as const);
// What the faction of a construction is told of its tools at work, of what its engines did for them (SharedRoom.power):
// that they stop, with no fuel or no engine that turns (`limit`); or else the share of their pace they work at (`pace`), to
// the hundredth, and whether engines too weak for them held them under it (`power`). Nothing of tools that did nothing.
// A road machine whose tools fall short of the ground is told that instead, and which tool it is (`Roadworks.step`).
export const toolsTold = ({ share, limit }: ToolWork): ToolWorkView | null => limit === 'fuel' || limit === 'engine' ? { limit } :
  share > 0 ? { pace: Math.round(share * 100) / 100, ...(limit ? { limit } : {}) } : null;
// What a part leaves the ground as, and what ground it works on: a blade natural ground, which it grades; a paver graded
// earth, which it paves.
const MADE = Object.freeze({ grade: 'graded', pave: 'asphalt' } as const), WORKS = Object.freeze({ grade: null, pave: 'graded' } as const);
// A tool works the ground where it stands on its vehicle (`at`), and as far as this ahead of that. The vehicle drives this
// much faster than they work while what they did is half of that ahead of them or more, never to fall behind, and the
// slower the further they go ahead of that, to none where they went this much further ahead than what they did.
const REACH = .5, LAG = 3, MARGIN = 1.1;
// How far within what they reach the tools of a machine that fell short of the ground must come again for it to go on
// (`Roadworks.short`): the bumps it stands on do not stop and start it.
const SHORT_BACK = .05;
// What is left of a lane shorter than this is none: the steps of a machine far along the field sum up to as much short of
// where its lane ends.
const HAIR = 1e-6;
const centimetre = (x: number): number => Math.round(x * 100);

export class Roadworks {
  declare room: RoadRoom;
  declare pending: Map<string, RoadOrder>;
  constructor(room: RoadRoom) { this.room = room; this.pending = new Map(); }
  // What the field keeps of them (`SharedRoom.keep`): every road asked for, as it was asked for, in the order it was — of a
  // stretch two roads were asked for over, the first is to make it (`left`). What its machines did is the field's roads.
  keep() { return [...this.pending.values()].map(road => ({ ...road })); }
  resume(roads: readonly RoadOrder[]): void {
    if (!Array.isArray(roads)) throw new Error('Campo salvo sem estradas pedidas.');
    this.pending = new Map(roads.map(road => [road.id, { ...road }]));
  }
  of(factionId: string): RoadOrder[] { return [...this.pending.values()].filter(road => road.factionId === factionId); }
  // The roads its faction asked for before a road, in the order it asked for them.
  before(road: RoadOrder): RoadOrder[] {
    const earlier: RoadOrder[] = [];
    for (const other of this.pending.values()) { if (other.id === road.id) break; if (other.factionId === road.factionId) earlier.push(other); }
    return earlier;
  }
  // A road asked for by a faction from `x0` to `x1`, as `kind`, where it may be asked for (road-site.ts), its ends in order to
  // the tenth of a metre: over what of that it makes (`roadWork`), from the first of it to the last — a stretch asked for
  // from one road to another is the ground between them. Refused, in words, by the first rule it breaks.
  open(faction: Faction, { x0, x1, kind }: { x0: unknown; x1: unknown; kind: unknown }): RoadOrder {
    const room = this.room, a = Math.round(Math.min(Number(x0), Number(x1)) * 10) / 10, b = Math.round(Math.max(Number(x0), Number(x1)) * 10) / 10, taken = this.of(faction.id),
      reason = roadRefusalMessage({ x0: a, x1: b, kind, limits: room.limits, explored: room.fog ? faction.explored ?? [] : null, roads: room.field.roads, taken });
    if (reason) throw userError(reason);
    if (!isRoadKind(kind)) throw userError('Tipo de estrada inválido.');
    const work = roadWork({ x0: a, x1: b, kind, roads: room.field.roads, taken }),
      road = { id: room.mint('r'), factionId: faction.id, x0: work[0]![0], x1: work.at(-1)![1], kind };
    this.pending.set(road.id, road);
    return road;
  }
  // A road given up: each machine on it lays what it did of its lane, and is free.
  cancel(road: RoadOrder): void {
    const dispatch = this.room.supplyDispatch;
    for (const [id, job] of [...dispatch.jobs]) if (job.targetId === road.id && (job.kind === 'grade' || job.kind === 'pave')) dispatch.cancel(id);
    this.pending.delete(road.id);
  }
  // Everything of a faction leaves the field: the roads it asked for too. What was made of them stays.
  clear(factionId: string): void { for (const road of this.of(factionId)) this.pending.delete(road.id); }
  // What is left of a road for a part: the stretches of it a blade grades, of natural ground, or a paver paves, of graded earth,
  // that no road its faction asked for before it is to (road-site.ts `roadLeft`). Of each part every stretch is one road's.
  left(road: RoadOrder, part: RoadPart): RoadSpan[] { return roadLeft(road, part, this.room.field.roads, this.before(road)); }
  // What is left of all of a road for a part, whoever is to make it.
  unmade(road: RoadOrder, part: RoadPart): RoadSpan[] { return roadLeft(road, part, this.room.field.roads); }
  // Whether all of a road is made, by whoever made it: graded all over, and of asphalt, paved.
  done(road: RoadOrder): boolean { return !this.unmade(road, 'grade').length && (road.kind === 'graded' || !this.unmade(road, 'pave').length); }
  // The lane a machine at `here` takes of what is left of a road for its part, but `claims`, the lanes others of its kind are
  // on: of the stretch left nearest it, from its end nearest the machine, `ROAD_LANE` metres on at most. Nothing where none is left.
  lane(road: RoadOrder, part: RoadPart, here: number, claims: readonly RoadSpan[]): RoadLane | null {
    const free = without(this.left(road, part), claims).filter(([a, b]) => b - a >= ROAD_SEAM);
    if (!free.length) return null;
    const far = ([a, b]: RoadSpan) => Math.max(0, a - here, here - b), [a, b] = free.reduce((best, span) => far(span) < far(best) ? span : best),
      dir = here - a <= b - here ? 1 : -1, from = dir > 0 ? a : b;
    return { from, to: from + dir * Math.min(ROAD_LANE, b - a), dir };
  }
  // The lane a machine on `lane` of a road goes on with where it ends, without stopping: what is left of its part from there
  // on, the same way, that no other of its kind is on (`claims`), `ROAD_LANE` metres at most. None where nothing is left there.
  beyond(road: RoadOrder, part: RoadPart, lane: RoadLane, claims: readonly RoadSpan[]): RoadLane | null {
    const at = lane.to, dir = lane.dir, span = without(this.left(road, part), claims)
      .find(([a, b]) => dir > 0 ? a <= at + ROAD_SEAM && b - at >= ROAD_SEAM : b >= at - ROAD_SEAM && at - a >= ROAD_SEAM);
    return span ? { from: at, to: at + dir * Math.min(ROAD_LANE, dir > 0 ? span[1] - at : at - span[0]), dir } : null;
  }
  // What a machine has not laid of its lane yet, done or not, as [from, to]: from where it last laid any to where it ends.
  unlaid(job: RoadDispatchJob): RoadSpan { return [Math.min(job.start, job.lane.to), Math.max(job.start, job.lane.to)]; }
  // Whether that crosses any of `claims` by more than a seam.
  crosses(job: RoadDispatchJob, claims: readonly RoadSpan[]): boolean {
    const [a, b] = this.unlaid(job);
    return claims.some(([from, to]) => Math.min(b, to) - Math.max(a, from) > ROAD_SEAM);
  }
  // The pieces of a vehicle that do a part, as they stand: not destroyed, and still on it.
  tools(actor: Actor, part: RoadPart): Module[] {
    return this.room.world.modules.filter(piece => piece.actorId === actor.id && piece.kind === ROAD_TOOLS[part] && piece.health > 0 && piece.attached !== false);
  }
  // Where those pieces work along the way `dir` points, the vehicle facing it, as it works facing the way it goes: as far from
  // the middle of it as each meets the ground, plumb under its tool as the piece stands, on the level or on a slope
  // (road-tools.ts) — a blade under the middle of its cutting edge, a paver under the trailing edge of its screed, where its
  // asphalt comes out behind it —, the hindmost of them, behind which the road is made. Its middle, without one.
  at(actor: Actor, part: RoadPart, dir: number): number {
    const x = this.room.position(actor), lead = Math.min(...this.tools(actor, part).map(piece =>
      (piece.x + toolOffset(ROAD_TOOLS[part], piece) - x) * actor.facing));
    return x + (Number.isFinite(lead) ? dir * lead : 0);
  }
  // How far those pieces fall short of the ground they work, as they stand: the most any goes down to meet it (road-tools.ts
  // `toolNeed`, as the screen sets it down) past what it reaches (`toolReach`, game_construction.rs) and may stand over it
  // (`TOOL_CONTACT`); less than none where all meet it. A blade rests on the ground it leaves graded.
  short(pieces: readonly Module[]): number {
    const terrain = this.room.world.terrain;
    let graded: ReturnType<typeof gradedGround> | null = null;
    return Math.max(-Infinity, ...pieces.map(piece => toolNeed(piece.kind === 'blade' ? 'blade' : 'paver', placeOf(piece, piece.width, piece.height),
      piece.kind === 'blade' ? graded ??= gradedGround(terrain) : terrain) - piece.toolReach! - (piece.kind === 'blade' ? TOOL_CONTACT.blade : TOOL_CONTACT.paver)));
  }
  // Where the middle of the vehicle stands for those pieces to work at `x`, the way `dir` points.
  stand(actor: Actor, part: RoadPart, dir: number, x: number): number { return x + this.room.position(actor) - this.at(actor, part, dir); }
  // How many metres a second those pieces make together, at the full pace of its engines.
  rate(actor: Actor, part: RoadPart): number { return this.tools(actor, part).reduce((sum, piece) => sum + roadRate(piece), 0); }
  // What carries the mix of the asphalt of a vehicle: the hoppers of its pavers that work, and its supply pieces that serve.
  mixers(actor: Actor): Module[] { return [...this.tools(actor, 'pave'), ...this.room.serving(actor.id)]; }
  // How many metres of asphalt the mix aboard a vehicle paves: in those hoppers, and in its supply pieces, each by what of it
  // is in the share a metre of road takes.
  aboard(actor: Actor): number { return pavedBy(supplied(carriedBy(this.tools(actor, 'pave')).carried)) + pavedBy(supplied(carriedBy(this.room.serving(actor.id)).carried)); }
  // And how many metres of it they take the mix for, empty.
  holds(actor: Actor): number {
    return this.tools(actor, 'pave').reduce((sum, piece) => sum + mixRoom(piece), 0) + this.room.serving(actor.id).reduce((sum, piece) => sum + cargoRoom(piece), 0) / MIX_VOLUME;
  }
  // The supply pieces of a vehicle feed the hoppers of its pavers out of the mix they carry, in the share a metre of road
  // takes of each, as far as the hoppers take it: they stay full while those have the mix for it.
  feed(actor: Actor): void {
    const hoppers = this.tools(actor, 'pave'), crates = this.room.serving(actor.id), mixed = STOCK_IDS.filter(id => PAVING[id] > 0),
      metres = Math.min(pavedBy(supplied(carriedBy(crates).carried)), ...mixed.map(id => hoppers.reduce((sum, piece) => sum + mixSpace(piece, SUPPLIED[id]), 0) / PAVING[id]));
    if (!(metres > 1e-9)) return;
    for (const id of mixed) {
      const taken = stow(crates, SUPPLIED[id], -PAVING[id] * metres);
      this.room.carry(taken.changed); this.room.carry(stow(hoppers, SUPPLIED[id], taken.moved).changed);
    }
  }

  // What `elapsed` seconds of the field did on the lanes of the machines at work: each that stands out of combat, held by no
  // service, facing the way its lane goes — one facing the other way does none of it till it has turned about to go on it
  // (Squad.turnsAbout) —, with a tool that works and ground under it to work, has its engines asked for its tools (SharedRoom.power), which
  // burn the fuel for them, and does at the share of its pace they give. Its tools reach `REACH` ahead of where they stand
  // (`at`), and do no more than the ground they came to: driving slower than they work, it works as fast as it drives. A paver does no
  // more than it carries the mix for. The pilot drives each along its lane at the pace of its tools there
  // (`pace`, Squad.drive), a little faster where it falls behind them and slower as it gets ahead, so that it keeps level with
  // them without stopping and going again; it holds it only where its tools do nothing. While they work it is getting on with
  // its way, however slowly its pace takes it (`since`, Squad.drive). Every `ROAD_CHUNK` metres done, and the end of its
  // lane — where its tools are, short of it by no more than a hair (`HAIR`) —, are laid on the field (`commit`); there it
  // goes on with the lane beyond at once (SupplyDispatch.onward), not to run past what it did for as long as the dispatch
  // takes to look. A machine any of whose tools does not reach the ground under it (`short`) does none and stands where it
  // is, its faction told so, till they all reach it again by a little more than they must (`SHORT_BACK`).
  step(elapsed: number): void {
    const room = this.room, jobs = room.supplyDispatch.jobs;
    if (!jobs.size) return;
    const out = room.outOfAction();
    for (const [id, job] of jobs) {
      if ((job.kind !== 'grade' && job.kind !== 'pave') || job.phase !== 'work') continue;
      const actor = room.world.actor(id), record = actor && room.records.get(id);
      if (!actor || !record) continue;
      if ((job.lane.to - job.front) * job.lane.dir <= HAIR) job.front = job.lane.to;
      const unit = room.players.get(job.ownerId)?.squad?.units.get(id), leg = unit?.move && unit.move === job.leg ? job.leg : null,
        lane = job.lane, tools = this.tools(actor, job.kind),
        rate = tools.reduce((sum, piece) => sum + roadRate(piece), 0), ahead = (this.at(actor, job.kind, lane.dir) - job.front) * lane.dir,
        uncommitted = (job.front - job.start) * lane.dir,
        reach = Math.min((lane.to - job.front) * lane.dir, ahead + REACH, job.kind === 'pave' ? this.aboard(actor) - uncommitted : Infinity),
        over = this.short(tools), short = job.short = over > 0 || Boolean(job.short) && over > -SHORT_BACK,
        able = rate > 0 && !short && !record.wreck && !record.service && !out[id] && room.calm(actor);
      if (short) record.tools = { limit: 'ground', tool: ROAD_TOOLS[job.kind] };
      if (able && actor.facing === lane.dir && reach > HAIR) {
        const work = room.power(actor, tools, elapsed);
        job.share = work.share;
        record.tools = toolsTold(work);
        job.front += lane.dir * Math.min(reach, rate * work.share * elapsed);
        if (leg && work.share > 0) leg.since = room.world.time;
      }
      if (leg)
        leg.pace = able && job.share > 0 ? rate * job.share * MARGIN * Math.min(1, Math.max(0, (LAG - ahead) / (LAG + REACH / 2))) : 0;
      if ((lane.to - job.front) * lane.dir <= 1e-9) {
        this.commit(job, actor);
        const road = this.pending.get(job.targetId);
        if (road) room.supplyDispatch.onward(job, actor, road);
      } else if ((job.front - job.start) * lane.dir >= ROAD_CHUNK - 1e-9) this.commit(job, actor, job.start + lane.dir * Math.min(ROAD_CHUNK, (job.front - job.start) * lane.dir));
    }
  }
  // What a machine did of its lane since it last laid any is laid on the field, all of it or as far as `to`: where the ground
  // is still what its part works on — the rest was made meanwhile —, as its part leaves it, to the centimetre the field keeps
  // its roads by (roads.ts); a paver pays for just that out of the mix in its hopper and, of what that lacks, in its supply
  // pieces, which then fill it up again (`feed`). A road all made is done with. Returns how many metres were laid.
  commit(job: RoadDispatchJob, actor: Actor, to = job.front): number {
    const a = Math.min(job.start, to), b = Math.max(job.start, to), room = this.room;
    job.start = to;
    if (!(b - a > 1e-9)) return 0;
    const spans = stretches(room.field.roads, a, b, WORKS[job.kind]).filter(([from, to]) => centimetre(to) > centimetre(from)),
      laid = spans.reduce((sum, [from, to]) => sum + (centimetre(to) - centimetre(from)) / 100, 0);
    if (job.kind === 'pave' && laid > 0) {
      const mixers = this.mixers(actor);
      for (const id of STOCK_IDS) if (PAVING[id] > 0) room.carry(stow(mixers, SUPPLIED[id], -PAVING[id] * laid).changed);
      this.feed(actor);
    }
    for (const [from, to] of spans) room.pave(from, to, MADE[job.kind]);
    const road = this.pending.get(job.targetId);
    if (road && this.done(road)) this.pending.delete(road.id);
    return laid;
  }
  // Whether a faction has a road of asphalt still to be graded somewhere: a paver with nothing to pave waits for that.
  awaits(factionId: string): boolean { return this.of(factionId).some(road => road.kind === 'asphalt' && this.unmade(road, 'grade').length > 0); }

  // The roads a faction asked for, as each member is told them: where each runs and what it is to be, how much of it is
  // graded — graded or paved — and paved, to the thousandth, which of its parts a machine works on now (`working`), and
  // whether one is on its way to it (`coming`).
  view(faction: Faction): RoadworkView[] {
    const jobs = [...this.room.supplyDispatch.jobs.values()];
    return this.of(faction.id).map(road => {
      const whole = road.x1 - road.x0, share = (metres: number) => Math.floor(Math.min(1, metres / whole) * 1000) / 1000,
        on = jobs.filter((job): job is RoadDispatchJob => job.targetId === road.id && (job.kind === 'grade' || job.kind === 'pave'));
      return { id: road.id, x0: road.x0, x1: road.x1, kind: road.kind,
        graded: share(whole - length(this.unmade(road, 'grade'))), paved: road.kind === 'asphalt' ? share(length(stretches(this.room.field.roads, road.x0, road.x1, 'asphalt'))) : 0,
        working: [...new Set(on.filter(job => job.phase === 'work').map(job => job.kind))].sort(), coming: on.some(job => job.phase !== 'work') };
    });
  }
}
