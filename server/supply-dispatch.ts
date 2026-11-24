import { appraise, bill, billSum, billTotal, carriedBy, fieldParts, load, loadTotal, pavedBy, resupply, stow, supplied, supplySpace, toolPace,
  PAVING, STOCK_IDS, SUPPLIED, LOAD_REACH, SUPPLY_REACH, TRANSFER_RATE } from '../src/economy.ts';
import { cargoMass, cargoRoom, cargoSpace, cargoUnitMass, cargoUnitVolume, cargoVolume, reserveState, CARGO } from '../src/component-volume.ts';
import { pickupContainer, workArea } from '../src/loading-area.ts';
import { BUILD_REACH, SITE_CLEARANCE } from '../src/construction-site.ts';
import { boxesOf, craneParking } from '../src/work-arm.ts';
import { workShape } from '../src/work-art.ts';
import { pileLook, pileSize } from '../src/cargo-art.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { blueprintMass, blueprintPowertrain } from '../src/mass-properties.ts';
import { nativeFuelFlow } from '../src/native-dynamics.ts';
import { isVehicleDesign } from '../src/persistence.ts';
import { POST_EYE, POST_RADIUS, territoryOf } from '../src/territory.ts';
import { ARRIVAL, DEPOT_INSET, EDGE, GAP, LOADING_APPROACH, FLIGHT_HOMING, HAUL_SCARE, MARK_SCARE, OUT_OF_RANGE, PILOT_LANDINGS,
  aircraft, flightFuel, lifts, steady } from '../src/squad.ts';
import { travelSeconds } from '../src/terrain-speed.ts';
import { stretches, length as spanned } from '../src/roads.ts';
import { without } from '../src/road-site.ts';
import { clip, contains, groundWithin, merged } from '../src/ground-sight.ts';
import { ROAD_TOOLS } from './road-works.ts';
import { repairOffer } from './service-policy.ts';
import { activityKnown, activitySite, activityStock, activityStilled } from './world-activities.ts';
import { GUARDIAN } from './airdrop-guardian.ts';
import { PRIORITY, jobView, pausedJob, idleJob } from '../src/automatic-jobs.ts';
export { PRIORITY } from '../src/automatic-jobs.ts';
import type { SupplyBill, CargoKind, StockId } from '../src/economy-contract.ts';
import type { Appraisal, FieldParts, Load } from '../src/economy.ts';
import type { CompiledConstruction, CompiledModule } from '../src/construction-contract.ts';
import type { SceneActor, SceneModule } from '../src/scene-contract.ts';
import type { ModuleKind } from '../src/materials.ts';
import type { Squad } from '../src/squad.ts';
import type { SquadUnit, SquadMove, SquadHaul, SquadSpan } from '../src/squad-contract.ts';
import type { DispatchPhase, DispatchView, JobKind, JobReason, PauseReason, WaitReason } from '../src/automatic-jobs.ts';
import type { Deposit } from '../src/deposits.ts';
import type { LoadingSite } from '../src/loading-area.ts';
import type { RoadSpan } from '../src/roads.ts';
import type { Work, Heap, WorkSpan, Takedown } from './field-construction.ts';
import type { RoadOrder, RoadLane, RoadPart } from './road-works.ts';
import type { ActivitySite } from './world-activities.ts';
import type { Faction, Player, Depot, OrderRequest } from './room-contract.ts';
import type { SharedRoom } from './room.ts';

export type DispatchRoom = Pick<SharedRoom, 'activities' | 'allied' | 'atDepot' | 'calm' | 'canMend' | 'carry' |
  'deliverCargo' | 'depot' | 'faction' | 'factions' | 'field' | 'fleet' | 'handy' | 'hasten' | 'holds' | 'known' |
  'manned' | 'mendFrom' | 'outOfAction' | 'pieces' | 'players' | 'position' | 'prospected' | 'reconnoitred' |
  'record' | 'records' | 'refill' | 'roadworks' | 'scouted' | 'serving' | 'sites' | 'still' | 'stilled' |
  'territories' | 'unload' | 'works' | 'world'>;
interface JobFields {
  ownerId: string; factionId: string; reason: JobReason; leg: SquadMove | null | undefined;
  reserved: SupplyBill; source: string | null; tries?: number; until?: number; targetX?: number;
  then?: string | null; after?: DispatchStop[]; targetIds?: string[]; haul?: SquadHaul | null; passing?: CargoKind | 'supplies';
  parked?: string | null; queued?: boolean; unlanded?: boolean; window?: SquadSpan | null;
  mend?: boolean; refuel?: boolean; full?: boolean; far?: boolean; left?: string;
}
interface ActiveFields extends JobFields { targetId: string; phase: DispatchPhase }
export type BuilderDispatchJob = ActiveFields & { kind: 'build' | 'dismantle'; tries: number; until: number; then: string | null };
export type RoadDispatchJob = ActiveFields & { kind: RoadPart; tries: number; until: number; lane: RoadLane; front: number; start: number; share: number; short?: boolean };
export type SupplyDispatchJob = ActiveFields & { kind: 'rearm' | 'repair' | 'work' | 'heap' | 'haul'; tries: number; targetX: number };
export type ReturningDispatchJob = JobFields & { kind: null; targetId: null; phase: 'return' | 'aside' };
export type DispatchJob = BuilderDispatchJob | RoadDispatchJob | SupplyDispatchJob | ReturningDispatchJob;
interface DispatchStop { kind: 'rearm' | 'repair' | 'work'; targetId: string; targetIds: string[]; payload: SupplyBill; x: number }
type Stocked<T> = T extends object ? Omit<T, 'stock'> & { stock: number } : never;
export type ReadyPile = Stocked<(Deposit & { supplies?: never; refined?: false }) | ActivitySite>;
interface Capacity { volume: number; mass: number }
interface DemandFields {
  id: string; x: number; key: string; weight: number; danger?: true; shared?: boolean; taken?: boolean;
  span?: WorkSpan; work?: Work; heap?: Heap | null; target?: SceneActor; quote?: Appraisal;
  service?: Takedown['service']; road?: RoadOrder; site?: ReadyPile;
}
interface DemandPayloads {
  rearm: { target: SceneActor; quote: Appraisal }; repair: { target: SceneActor; quote: Appraisal };
  work: { work: Work; heap: Heap | null }; heap: { heap: Heap }; haul: { site: ReadyPile };
  build: { work: Work; span: WorkSpan }; dismantle: { span: WorkSpan; service: Takedown['service'] };
  grade: { road: RoadOrder }; pave: { road: RoadOrder };
}
type Demand = { [Kind in JobKind]: DemandFields & { kind: Kind } & DemandPayloads[Kind] }[JobKind];
type ServiceDemand = Extract<Demand, { kind: 'work' | 'rearm' | 'repair' }>;
type Candidate<T> = T extends Demand ? Omit<T, 'key' | 'weight'> : never;
type ServiceCandidate = Candidate<ServiceDemand>;
interface Offer { phase: DispatchPhase; reserved: SupplyBill; seconds: number; targetIds?: string[]; lane?: RoadLane; passing?: CargoKind | 'supplies' }
interface Refusal { reason: JobReason; targetId: string | null; far?: number }
interface Crewman {
  actor: SceneActor; id: string; here: number; atDepot: boolean; depot: number | null; fuel: number; home: number;
  aboard: SupplyBill; crates: boolean; arm: boolean; road: RoadPart[] | null; carrier: boolean; raw: Load;
  carries: boolean; loaded: boolean; homing: boolean; left: string | null;
}
interface Sighting { x: number; y: number; radius: number; at: number; actor: boolean }
interface StopOptions { exact?: boolean; sides?: number[] | null; clearance?: number; reach?: number; strict?: boolean }
interface Drive { powerKw: number; maxSpeed: number; tracked?: boolean; efficiency?: number }

const PERIOD = 1, RETRY = 30, LOW = .35;
// Whether a construction as `quote` appraised it (economy.ts `appraise`) runs low: a magazine or a tank of it that is to be
// filled — of `kinds`, its tanks alone for its fuel — holds no more than `LOW` of what the design fills it with. That is when
// a supply vehicle is sent to it (`need`), and the column of the field marks its fuel low (room.ts `units`).
export function runsLow(design: CompiledConstruction, quote: Appraisal, kinds: readonly ModuleKind[] = ['ammo', 'fuel']): boolean {
  return design.modules.some(piece => {
    if (!kinds.includes(piece.kind) || !quote.full[piece.id]) return false;
    if (piece.kind === 'fuel') {
      const designed = reserveState(piece).fuelLitres;
      return designed > 0 && quote.levels[piece.id]!.fuelLitres! <= designed * LOW;
    }
    if (piece.kind === 'ammo') {
      const designed = reserveState(piece).rounds;
      return designed > 0 && quote.levels[piece.id]!.rounds! <= designed * LOW;
    }
    return false;
  });
}
// A vehicle sent beside a works or a structure — or beside a construction it serves, or a heap it loads — whose way leaves it
// short of it there is sent again from where it stands, as many times as this in all; left short again, the way there is
// shut (`blocked-way`).
const TRIES = 2;
// Metres from the place a trip from the base goes to within which what else waits there is on the way of the trip, whichever
// side of the base it is on (`combine`).
const NEARBY = 60;
// Metres a construction a supply vehicle is sent to serve may stand from where it stood when it was sent, still and with no
// way of its own, before it is held to be going elsewhere (`target-moving`): nearer, the supply vehicle is sent beside it
// where it stands now (`service`).
const STRAY = 30;
// How far out of reach of a works the vehicles that wait for a place by it may stand, one after another, in metres (`outside`).
const QUEUE = 100;
// What each job of a faction weighs in its plan (`plan`): to rearm and refuel a vehicle that runs low, to repair damage,
// to bring a works its material, to put one up, to take a structure down, to grade a road and to pave one, and to take a heap home.
// A job that waits with nobody on it weighs a point more for every this many seconds it has waited.
export const AGING = 120;
// What a vehicle is reckoned to spend at a job besides its way and the work itself, in seconds: stopping, turning, starting.
const HANDLING = 10;
// The share of the speed a vehicle goes at over each stretch of its way — its top speed, or the speed reckoned for the
// ground there where that is lower — it is reckoned to go at, for the time a job takes it and the fuel it burns; besides
// the time its engine takes at full power to lift it up every rise of the way (`lift`).
const CRUISE = .35;
// What a design weighs with all it carries full of what weighs most (`SupplyDispatch.lift`).
const LOADED = new WeakMap<CompiledConstruction, number>();
const positive = (amounts: SupplyBill): SupplyBill => bill(...STOCK_IDS.map(id => Math.max(0, amounts[id])));
const haltedReason = (unit: SquadUnit | null | undefined): WaitReason | undefined => [unit?.halt, unit?.reason].find((reason): reason is WaitReason => reason === 'immobile' || reason === 'blocked-way' || reason === 'no-loader' || Boolean(reason?.startsWith('stuck-')));
const manualOrders = new Set(['move', 'stop', 'haul', 'attack', 'bombard', 'control', 'turn', 'home']);
// Why an aircraft gives up a job for a while: there is no ground it may come down on where it would work (Squad.landing).
const NO_LANDING = 'no-landing';
// Why the automatic sends no vehicle to a job, or a vehicle gives one up on its way there: its faction holds the place it
// goes to dangerous (`perilous`).
export const DANGER = 'danger';
// Seconds a faction keeps in mind where it held an armed enemy after it last held it so (`watch`): about what a vehicle of
// it takes to drive to a job a few kilometres off, so that an enemy seen by a place as a vehicle sets out for it still counts
// as it comes there; and the window in which an enemy that only shows itself holds a worker at all (Squad `SCARE_WINDOW`).
export const DANGER_MEMORY = 300;
// Metres about an airdrop that its sentinel makes dangerous while its faction does not know it to be out of the fight: as
// far from the drop as it patrols (airdrop-guardian.ts `GUARDIAN.leash`), and as far again as a mark of an enemy whose
// guns nobody saw holds a worker (Squad `MARK_SCARE`). Seen, its guns count as those of any other enemy (`watch`).
export const SENTINEL_REACH = GUARDIAN.leash + MARK_SCARE;
// A job owns its leg and haul by identity. A new player order, even to the same place, is another object.
// Room services are separate: an automatic turn holds the job without making it a player order, and so does the way home
// of an aircraft its pilot sent there for its fuel or to be mended, or down where it is for a thruster it lost
// (Squad.homeward and `mend`, `PILOT_LANDINGS`; `fuelling`).
function playerOrder(squad: Squad | null | undefined, id: string, job: DispatchJob | undefined): PauseReason | '' {
  const unit = squad?.units.get(id);
  if (squad?.manual === id) return 'manual-control';
  const hauling = Boolean(job?.haul && unit?.haul === job.haul), moving = unit?.move && unit.move !== job?.leg && !PILOT_LANDINGS.includes(unit.move.land!);
  return unit?.attack || !hauling && (moving || unit?.haul) ? 'manual-order' : '';
}
// Only the automatic haul we started is ours to stop. A newly accepted manual order is another object.
function releaseHaul(squad: Squad | undefined, id: string, haul: SquadHaul | null | undefined): void {
  const unit = squad?.units.get(id);
  if (haul && unit?.haul === haul) { unit.haul = unit!.move = null; squad!.release(id); }
}
// Supply pieces with less room than this left take nothing more from a heap.
const FULL = 1e-3;
// The legs of a job on which a vehicle goes to load or unload where it is served, or does it.
const DEPOT_PHASES = new Set(['collect', 'return', 'home', 'unload']);
// The services to the fleet: to rearm and refuel a vehicle that runs low, and to repair one.
const SERVICES = new Set(['rearm', 'repair']);
// The jobs only a builder does: to put up a works, or to take a structure down.
const builds = <T extends { kind: JobKind | null }>(job: T | null | undefined): job is T & { kind: 'build' | 'dismantle' } => job?.kind === 'build' || job?.kind === 'dismantle';
// Once a real haul turns home, its loaded cargo owns no part of the ready pile left behind.
export const outwardHaul = (job: DispatchJob | null | undefined): boolean => job?.kind === 'haul' && job.haul?.phase !== 'home' && job.haul?.phase !== 'unload';
// What a vehicle on its way home with a load may take on by the way (`passing`): a ready pile, or a heap of its faction.
const PICKUPS = new Set(['haul', 'heap']);
// A vehicle takes a load home (`loaded`) when what it carries fills this share of the room of its hoppers, cisterns and
// supply pieces or more: a trickle taken on for a moment — while an order of the player's held it by a pile, say — is none.
const LOAD_SHARE = .1;
// The jobs only a road machine does: to grade a road, or to pave it (road-works.ts).
const roadwork = <T extends { kind: JobKind | null }>(job: T | null | undefined): job is T & { kind: RoadPart } => job?.kind === 'grade' || job?.kind === 'pave';
// A paver short of the mix for this many metres of road goes by the base for more — or for what is left of its lane, or for
// this share of what its hoppers and supply pieces take, where that is less (`least`).
const LEAST_PAVING = 1, LEAST_SHARE = .05;
// Metres from where a road machine left off on its lane within which its tools take it up again, and metres the place it is
// sent to along its lane moves by before it is sent there instead (`aim`).
const RESUME = 3, REAIM = .05;
// The stretch of the field a lane takes up.
const laneSpan = (lane: RoadLane): WorkSpan => ({ minX: Math.min(lane.from, lane.to), maxX: Math.max(lane.from, lane.to) });
const along = (a: number, b: number): number => Math.abs(a - b);
// Where a vehicle coming from `here` stops in a place of its faction where it is served (room.ts `depots`): inside its edge,
// on that side.
const depotAt = (here: number, place: Depot): number => place.x + (Math.sign(here - place.x) || 1) * (place.radius - DEPOT_INSET);
// Whether a bill asks for anything: what is left of a works as its material comes in, a dust of a unit, asks for nothing.
const lacking = (amounts: SupplyBill): boolean => STOCK_IDS.some(id => amounts[id] > 1e-6);

// Whether a construction works by itself when its faction has something for it to do: a vehicle with supply pieces, which takes
// the stocks where they are asked for, with hoppers/cisterns that carry ready piles, with a builder, which puts works up
// and takes structures down, or with a blade/paver for the faction's roads. Every one comes on the field in automatic.
// A blade and a paver work as their vehicle drives on along a road: an aircraft, which goes nowhere on its skids, makes
// none, and works for its faction by its other pieces alone (`tools`).
const WORKERS = new Set<ModuleKind>(['supply', 'hopper', 'cistern', 'builder', ...Object.values(ROAD_TOOLS)]), MACHINES = new Set<ModuleKind>(Object.values(ROAD_TOOLS)),
  FLYING_WORKERS = new Set([...WORKERS].filter(kind => !MACHINES.has(kind)));
export const worker = (actor: SceneActor): boolean => isVehicleDesign(actor.construction) &&
  actor.blueprint.modules.some(piece => (aircraft(actor) ? FLYING_WORKERS : WORKERS).has(piece.kind));
// Whether a construction is a road machine as designed: a vehicle with a blade or a paver, but an aircraft.
export const roadMachine = (actor: SceneActor): boolean => isVehicleDesign(actor.construction) && !aircraft(actor) && actor.blueprint.modules.some(piece => MACHINES.has(piece.kind));

// The jobs of the factions, and the vehicles in automatic that do them. Only dispatch and bookkeeping live here: Squad drives
// the real vehicle and reports actual lack of progress; the room's ordinary refill pays for every round and litre, and the
// room loads, unloads and builds at its pace (field-construction.ts) where a job says (`task`, `errand`), and makes roads where
// its machines drive along their lanes (road-works.ts). The base a vehicle loads at, unloads at and comes home to is the
// nearest place of its faction where it is served (room.ts `depot`): its base, or one of its posts; the stocks they load from
// are the faction's, the same at all of them.
// The jobs are listed in PRIORITY: to rearm and refuel a vehicle of the faction that runs low (`rearm`); to repair damage
// (`repair`), below urgent reserves, from the room's same whole or meaningful partial quote; to bring a works what
// it lacks (`work`) — from the heap of the structure it is moved from, while that has some of it, or else from what the vehicle
// carries or the stocks of the base —; to take a heap (`heap`) or a known ready pile (`haul`) home; to put up a works (`build`); and
// to take a structure down (`dismantle`), and on from that to the works it is moved to (`then`). Supply pieces do the first
// four and a builder the other two; a blade grades the roads the faction asks for (`grade`) and a paver paves them (`pave`),
// each on a lane of its own (road-works.ts). Once a second the free vehicles of each faction are given what there is to do (`plan`),
// what weighs most for the time it takes first; one done goes on to the next from where it stands. An order of the player's to a
// vehicle ends its job; one in automatic stays in it, held by the order until that is carried out (`paused`), but for Stop, which
// takes it out of automatic until the player puts it back. No vehicle is sent where its faction holds dangerous — the ground of
// another, the place of an armed enemy it saw lately, or an airdrop its sentinel guards (`perils`) —, and one on its way gives
// its job up once its faction holds so where it goes, saying why (`DANGER`); what the player orders goes where the player says.
export class SupplyDispatch {
  declare room: DispatchRoom;
  declare nextAt: number;
  declare jobs: Map<string, DispatchJob>;
  declare waits: Map<string, { until: number; reason: JobReason; targetId?: string | null }>;
  declare targets: Map<string, number>;
  declare since: Map<string, { factionId: string; at: number }>;
  declare paused: Map<string, PauseReason>;
  declare hovering: Set<string>;
  declare sightings: Map<string, Map<string, Sighting>>;
  declare cleared: Map<string, Set<string>>;
  declare dangers: Map<string, { time: number; spans: RoadSpan[] }>;
  constructor(room: DispatchRoom) {
    this.room = room; this.nextAt = -Infinity;
    this.jobs = new Map(); this.waits = new Map(); this.targets = new Map();
    // Since when each job of a faction waits with nobody on it, by its kind and what it is for (`plan`).
    this.since = new Map();
    // The vehicles in automatic an order of the player's holds while it is carried out, by why (`ordered`). The field keeps
    // none of it: a field taken up again has each in automatic, and what its squad was told holds it again (`step`).
    this.paused = new Map();
    // The aircraft in automatic an order of the player's left in the air — a Move to a point of the sky ends hovering there,
    // over its base too —, or that were put in automatic there: with nothing to do they hover there as the order left them,
    // and are given their next job from there (`idle`), till they come down or are given one. The field keeps none of it.
    this.hovering = new Set();
    // What each faction keeps in mind of the armed enemies about the field, by the name of each (`watch`); of each airdrop, the
    // factions that know its sentinel out of the fight; and what each holds dangerous as of the last look (`perils`). The
    // field keeps none of it: a faction taken up again begins with what it holds then.
    this.sightings = new Map(); this.cleared = new Map(); this.dangers = new Map();
  }

  // Whether the jobs of its faction send a vehicle: one in automatic that no order of the player's holds, in action, of a player
  // on the field, with supply pieces, a builder, a blade or a paver that serve. One held so the room serves as any other, but
  // for what its supply pieces carry: its base never fills them up (SharedRoom.haul), and they are as it left them when it is
  // let go, for its next job to load and unload (`ready`).
  manages(id: string): boolean {
    if (!this.room.records.get(id)?.auto || this.paused.has(id)) return false;
    const actor = this.room.world.actor(id), owner = actor && this.room.players.get(actor.ownerId!);
    return Boolean(actor?.vehicle?.config.enabled && owner && this.equipped(id));
  }
  // Working cargo or tools, checked both when automatic is enabled and when dispatch takes the vehicle.
  equipped(id: string): boolean { return Boolean(this.room.serving(id).length || this.carrier(id) || this.arm(id) || this.machine(id)); }
  // Whether a construction has a builder that serves: not destroyed, and still on it.
  arm(id: string): boolean { return this.room.world.modules.some(piece => piece.actorId === id && piece.kind === 'builder' && piece.health > 0 && piece.attached !== false); }
  // Whether it has a blade or a paver that serves so, as a vehicle that drives along a road does (`roadMachine`).
  machine(id: string): boolean {
    const world = this.room.world;
    return world.modules.some(piece => piece.actorId === id && MACHINES.has(piece.kind) && piece.health > 0 && piece.attached !== false) && !aircraft(world.actor(id));
  }
  // Hoppers and cisterns carry ready material; an excavator or drill alone is not a transporter.
  carrier(id: string): boolean { return this.room.pieces(id).some(piece => piece.health > 0 && piece.attached !== false); }

  // Putting a vehicle in automatic, or out of it, ends the job it is on; put back, it may try a way that was shut again, once
  // what an order of the player's still holds it for is carried out.
  set(id: string, on: boolean): void {
    const actor = this.room.world.actor(id);
    if (!actor) return;
    if (on !== true || !builds(this.jobs.get(id))) this.cancel(id);
    this.waits.delete(id); this.paused.delete(id); this.hovering.delete(id);
    this.room.record(actor).auto = on === true;
    if (on === true) {
      const squad = this.room.players.get(actor.ownerId!)?.squad, unit = squad?.units.get(id), held = this.ordered(id);
      if (haltedReason(unit)) unit!.halt = unit!.reason = '';
      squad?.resume(id);
      if (held) this.paused.set(id, held);
      else if (this.aloft(actor) && !this.jobs.has(id)) this.hovering.add(id);
    }
    this.nextAt = -Infinity;
  }
  // An order of the player's to a vehicle on a job ends it. One in automatic stays in it, held by the order until that is
  // carried out (`step`); Stop takes it out of automatic, and it says why.
  off(id: string, stop = false): void {
    this.cancel(id);
    if (!this.room.records.get(id)?.auto) return;
    if (stop) { this.set(id, false); this.waits.set(id, { until: 0, reason: 'manual-order' }); return; }
    this.paused.set(id, this.ordered(id) || 'manual-order'); this.waits.delete(id);
  }
  // Why an order of the player's holds a vehicle now, if one does: it is in the player's hands (`manual-control`), or on a way,
  // an attack or a haul its squad was told — the way of its own job is none of them —, or turning about (`manual-order`). The
  // squad tells when each is over: there, out of the fight, at the end of the haul, turned, or let go.
  ordered(id: string): PauseReason | '' {
    const actor = this.room.world.actor(id), squad = actor && this.room.players.get(actor.ownerId!)?.squad, unit = squad?.units.get(id);
    if (!unit) return '';
    return playerOrder(squad, id, this.jobs.get(id)) || (this.room.records.get(id)?.service?.kind === 'turn' ? 'manual-order' : '');
  }

  // Called only after an accepted player command. A new manual move must never be cleared while cancelling the old automatic
  // leg, even to the same place. A vehicle an order did not take — one held by a service it is not turned about from, or the one
  // in the player's hands told to stop — goes on as it was.
  command(player: Player, data: OrderRequest & { type?: unknown; actorId?: unknown }): void {
    let ids: (string | null)[] = [];
    if (data.type === 'squad' && typeof data.order === 'string' && manualOrders.has(data.order))
      ids = data.order === 'control' ? [typeof data.id === 'string' ? data.id : null] : Array.isArray(data.ids) ? data.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    else if (data.type === 'select' || data.type === 'drive')
      ids = [typeof data.actorId === 'string' && data.actorId || player.selected];
    for (const id of ids) {
      if (!id) continue;
      const actor = this.room.world.actor(id);
      if (actor?.ownerId !== player.id) continue;
      const held = this.ordered(id);
      if (data.order === 'stop' ? held !== 'manual-control' : held) this.off(id, data.order === 'stop');
    }
  }

  // What a vehicle that works by itself does, as its faction is told it: its job (`kind`, `phase`, `targetId`), why it waits
  // (`reason`) and, of a pile or a heap it takes on by its way home, what that is (`passing`: the material, or `supplies`);
  // `paused` out of automatic, held by an order of the player's or in the player's hands, `idle` with nothing to do, and
  // `return` on its way home. One on its way to load or unload, or doing it, says when that is at a post (`post`).
  view(id: string): DispatchView {
    const actor = this.room.world.actor(id), owner = actor && this.room.players.get(actor.ownerId!),
      auto = actor && this.room.records.get(id)?.auto, job = this.jobs.get(id), wait = this.waits.get(id), held = owner?.squad!.manual === id,
      paused = this.paused.get(id) || owner && this.room.manned(this.room.faction(owner)) && this.ordered(id);
    // A works may finish before the next dispatch look retires its job.
    if (job && !held && (job.kind !== 'build' || this.room.works.pending.has(job.targetId))) {
      const phase = job.haul?.phase ?? job.phase, faction = DEPOT_PHASES.has(phase) ? this.room.factions.get(job.factionId) : undefined,
        post = faction?.base && this.room.depot(faction, this.room.position(actor!))!.post;
      return jobView(job, Boolean(post));
    }
    if (!auto || held || paused) return pausedJob(held ? 'manual-control' : auto ? paused || '' : wait?.reason || '');
    return idleJob(wait?.reason || '', wait?.targetId ?? null);
  }

  // Where a vehicle loads and unloads now, for the room (`Works.attend`): on a trip for a works or a heap, the heap of its trip
  // while it fetches it and the works of its trip while it brings it what it carries, and neither on any other trip or leg of
  // one; a builder loading the heap it left (`load`), at that heap alone. Nothing for a vehicle on no job, nor for a builder sent
  // to build: that one loads and unloads where it stands, as any other.
  task(id: string): { work: string | null; heap: string | null; keep?: SupplyBill } | null {
    const job = this.jobs.get(id);
    if (job?.phase === 'load') return { work: null, heap: job.targetId };
    if (!job || builds(job) || !this.manages(id)) return null;
    return { work: job.kind === 'work' && job.phase === 'deliver' ? job.targetId : null,
      heap: job.phase === 'fetch' ? job.kind === 'heap' ? job.targetId : job.source : null, keep: this.later(job) };
  }
  // What the jobs under way bring a works, but that of `except`: what is reserved for it at the base, and what is aboard on the
  // way there — of a builder sent to put it up, all it carries.
  carrying(workId: string, except: string | null = null): SupplyBill {
    const coming = bill();
    for (const [id, job] of this.jobs) if (id !== except) {
      if (job.targetId === workId && (job.kind === 'work' || job.kind === 'build')) {
        const brings = job.phase === 'collect' ? job.reserved : job.kind === 'build' || job.phase === 'deliver' ? positive(billSum(this.stock(id), this.later(job), -1)) : null;
        if (brings) for (const stock of STOCK_IDS) coming[stock] += brings[stock];
      }
      for (const stop of job.after ?? []) if (stop.kind === 'work' && stop.targetId === workId) for (const stock of STOCK_IDS) coming[stock] += stop.payload[stock];
    }
    return coming;
  }
  // The works a vehicle carries for, by its job: a builder sent to put it up — or to take down the structure it is moved
  // from, once that is down —, or a supply vehicle bringing it its material. Nothing for any other.
  bound(id: string): Work | null {
    const job = this.jobs.get(id), moved = job?.kind === 'dismantle' && !this.room.works.takedown(job.targetId);
    return job && (job.kind === 'build' || job.kind === 'work' || moved) && this.room.works.pending.get((moved ? job.then : job.targetId)!) || null;
  }
  // What of what a vehicle carries (`carried`) it serves others from (SharedRoom.points): all of it but what the works it
  // carries for still lacks, which stays aboard for that one — a builder beside it, or a machine at a road by it, would
  // fill its tank from it and leave the works short.
  // What it loaded for the stops of its trip still to come (`after`) stays aboard for those too.
  giving(id: string, carried: SupplyBill): SupplyBill {
    const work = this.bound(id), kept = positive(billSum(carried, this.later(this.jobs.get(id)), -1));
    return work ? positive(billSum(kept, this.room.works.need(work!), -1)) : kept;
  }
  // What a job loaded at the base for the stops of its trip after the one it goes to now (`combine`).
  later(job: DispatchJob | undefined): SupplyBill {
    const kept = bill();
    for (const stop of job?.after ?? []) for (const stock of STOCK_IDS) kept[stock] += stop.payload[stock];
    return kept;
  }

  // A vehicle whose orders are taken from it — called home with its faction (SharedRoom.recall), or replaced by a new one
  // (`publish`) —: its job ends, and so does what an order of the player's held it for. It stays in automatic as it was.
  drop(id: string): void { this.cancel(id); this.paused.delete(id); }
  // A job ended, however it ends: a road machine lays first what it did of its lane (road-works.ts `commit`).
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const actor = roadwork(job) && this.room.world.actor(id);
    if (actor) this.room.roadworks.commit(job, actor);
    const squad = this.room.players.get(job.ownerId)?.squad, unit = squad?.units.get(id);
    releaseHaul(squad, id, job.haul);
    if (job.leg && unit?.move === job.leg) { unit!.move = null; squad!.release(id); }
    this.jobs.delete(id);
  }

  wait(id: string, reason: JobReason, seconds = RETRY): void {
    this.cancel(id); this.waits.set(id, { until: this.room.world.time + seconds, reason });
  }

  // The drive a vehicle goes by: as it is now, or as designed while its engine has not told it yet.
  drive(actor: SceneActor): Drive {
    const actual = actor.vehicle?.powertrain;
    return actual && actual.maxSpeed > 0 ? actual : blueprintPowertrain(actor.blueprint);
  }
  // Full-power fuel flow over the seconds a way takes at a modest mean speed is deliberately conservative:
  // this is a trip budget, rather than the optimistic flat-road range label. An aircraft burns what its thrusters burn
  // holding it up loaded full (`flightFuel`), its engine aside: that turns its tools.
  fuel(actor: SceneActor, seconds: number): number {
    if (!(seconds > 0)) return 0;
    if (aircraft(actor)) return flightFuel(actor.blueprint, this.laden(actor), seconds);
    const drive = this.drive(actor);
    if (!(drive.powerKw > 0 && drive.maxSpeed > 0)) return Infinity;
    return Math.ceil(nativeFuelFlow(drive.powerKw, drive.powerKw) * (seconds + 30) / 3600 * 1.5 + 2);
  }
  // The seconds a vehicle is reckoned to take from one place to another (`CRUISE`): none for less than a metre. An aircraft
  // flies over whatever ground lies under it, at the pace one is reckoned to go home at (Squad `FLIGHT_HOMING`).
  travel(actor: SceneActor, from: number, to: number): number {
    if (along(from, to) < 1) return 0;
    if (aircraft(actor)) return along(from, to) / FLIGHT_HOMING;
    const drive = this.drive(actor);
    return travelSeconds(this.room.world.terrain, from, to, { top: drive.maxSpeed || 0, tracked: drive.tracked!, share: CRUISE, lift: this.lift(actor, drive) });
  }
  // The metres a second a vehicle's engine lifts it at full power, loaded full of what weighs most, as the way back from a
  // job may find it: ore in its hoppers and supply pieces, petroleum in its cisterns. A lorry that carries eleven tonnes
  // of ore climbs at a third of what it does empty, and up a long hill that, and not the speed of its ground, holds it.
  lift(actor: SceneActor, drive: Drive): number { return drive.powerKw * 1000 * (drive.efficiency ?? 1) / (this.laden(actor) * 9.81); }
  // What a design weighs loaded so, in kg.
  laden(actor: SceneActor): number {
    const blueprint = actor.blueprint;
    let mass = LOADED.get(blueprint);
    if (mass === undefined) LOADED.set(blueprint, mass = blueprintMass(blueprint) + blueprint.modules.reduce((sum, piece) =>
      sum + (cargoRoom(piece) || 0) * CARGO[piece.kind === 'cistern' ? 'petroleo' : 'ferro'].density, 0));
    return mass;
  }
  // The seconds a vehicle is reckoned to take from a place to the nearest of a span.
  toward(actor: SceneActor, x: number, span: WorkSpan): number { return this.travel(actor, x, Math.min(span.maxX, Math.max(span.minX, x))); }

  need(actor: SceneActor, parts: FieldParts, quote: Appraisal = appraise(actor, parts)): Appraisal | null {
    return billTotal(quote.rearm) && runsLow(actor.blueprint, quote) ? quote : null;
  }

  stock(id: string): SupplyBill { return supplied(carriedBy(this.room.serving(id)).carried); }

  // Existing faction memory, not the invisible current pile. Event cargo is already public to its eligible factions.
  readyPiles(faction: Faction): ReadyPile[] {
    const room = this.room, sites: ReadyPile[] = room.prospected(faction).flatMap(site => {
      const known = room.known(faction, site);
      return known?.stock! > 1e-6 && !room.stilled(faction, site) ? [{ ...site, stock: known!.stock }] : [];
    }), drop = activitySite(room);
    if (drop && activityKnown(room, faction) && !activityStilled(room, faction, drop) && activityStock(room.activities!.drop) > 1e-6)
      sites.push({ ...drop, stock: activityStock(room.activities!.drop) });
    return sites;
  }

  // The same physical loading allowance for dispatch and pickup. Room.haul still shares and debits the real pile.
  // `unloaded` is the weight of cargo the vehicle is reckoned without.
  transportSpace(actor: SceneActor, site: LoadingSite, pieces: SceneModule[] = this.room.holds(actor.id), unloaded = 0): number {
    const containers = pieces.filter(piece => pickupContainer(piece, site) && piece.health > 0 && piece.attached !== false),
      space = site.supplies ? supplySpace(containers, site.supplies) : containers.reduce((sum, piece) => sum + cargoSpace(piece, site.material!), 0),
      perUnit = site.supplies ? STOCK_IDS.reduce((sum, id) => sum + site.supplies![id] * cargoUnitMass(SUPPLIED[id]), 0) /
        Math.max(1e-9, billTotal(site.supplies)) : cargoUnitMass(site.material!),
      mass = Math.max(0, (actor.blueprint.chassis?.limitKg ?? Infinity) - actor.vehicle!.mass + unloaded);
    return Math.max(0, Math.min(space, mass / perUnit));
  }
  // What a vehicle would take on at a site come there empty: all the room of its pieces that take it, as far as the weight its
  // chassis bears allows.
  emptySpace(actor: SceneActor, site: LoadingSite): number {
    const pieces = this.room.holds(actor.id);
    return this.transportSpace(actor, site, pieces.map(piece => ({ ...piece, cargo: {} })), pieces.reduce((sum, piece) => sum + cargoMass(piece), 0));
  }

  available(faction: Faction, except: string | null = null): SupplyBill {
    let stock = { ...faction.stock };
    for (const [id, job] of this.jobs) if (id !== except && job.phase === 'collect' && job.factionId === faction.id)
      stock = positive(billSum(stock, job.reserved, -1));
    return stock;
  }

  capacity(actor: SceneActor): Capacity {
    const crates = this.room.serving(actor.id), chassis = actor.blueprint.chassis;
    // loadedKg is the hypothetical heaviest full load, not the live chassis.
    // Its existing supply cargo is unloaded before loading the chosen payload.
    return { volume: crates.reduce((sum, piece) => sum + cargoRoom(piece), 0),
      mass: Math.max(0, (chassis?.limitKg ?? Infinity) - actor.vehicle!.mass + crates.reduce((sum, piece) => sum + cargoMass(piece), 0)) };
  }
  // What its supply pieces take on top of what they and the rest of it carry now.
  spareCapacity(actor: SceneActor): Capacity {
    return { volume: this.room.serving(actor.id).reduce((sum, piece) => sum + Math.max(0, cargoRoom(piece) - cargoVolume(piece)), 0),
      mass: Math.max(0, (actor.blueprint.chassis?.limitKg ?? Infinity) - actor.vehicle!.mass) };
  }
  // How many units of stocks mixed as `stock` is a capacity holds.
  holding(stock: SupplyBill, capacity: Capacity): number {
    const total = billTotal(stock), per = (unit: (material: CargoKind) => number) => STOCK_IDS.reduce((sum, id) => sum + stock[id] * unit(SUPPLIED[id]), 0) / total;
    return total > 0 ? Math.min(capacity.volume / per(cargoUnitVolume), capacity.mass / per(cargoUnitMass)) : 0;
  }

  // What fits of an offer of stocks, each in the share it has of it: as much of it as the room and the weight left allow.
  fits(offer: SupplyBill, capacity: Capacity): SupplyBill {
    const whole = bill(...STOCK_IDS.map(id => Math.max(0, Math.floor(offer[id])))),
      volume = STOCK_IDS.reduce((sum, id) => sum + whole[id] * cargoUnitVolume(SUPPLIED[id]), 0),
      mass = STOCK_IDS.reduce((sum, id) => sum + whole[id] * cargoUnitMass(SUPPLIED[id]), 0),
      share = Math.min(1, capacity.volume / Math.max(1e-9, volume), capacity.mass / Math.max(1e-9, mass));
    return share < 1 ? bill(...STOCK_IDS.map(id => Math.floor(whole[id] * share))) : whole;
  }

  payload(actor: SceneActor, quote: Appraisal, stock: SupplyBill, capacity: Capacity): SupplyBill {
    const offer = this.fits(bill(Math.min(quote.rearm.ferro, stock.ferro), 0, 0, Math.min(quote.rearm.combustivel, stock.combustivel)), capacity);
    // The room buys whole rounds, not fractions of their price. Use its same
    // calculation before reserving stock or sending a vehicle to collect it.
    return resupply(actor.blueprint, quote, offer).cost;
  }

  // Only material that the room can actually mend with, within real load limits.
  // The shared service policy chooses whole or meaningful partial repair.
  repairPayload(quote: Appraisal, stock: SupplyBill, capacity: Capacity): SupplyBill {
    const offer = this.fits(bill(...STOCK_IDS.map(id => Math.min(quote.repair[id], stock[id]))), capacity),
      [point, part] = repairOffer([{ stock: offer }], quote);
    return point ? { ...(part ? part.cost : quote.repair) } : bill();
  }

  // Why nothing is loaded for a service from `stock`: the stocks lack what it takes (`waiting-stock`), or they have it, and the
  // vehicle has not the room for a part of it worth the trip (`no-room`).
  scant(target: SceneActor, quote: Appraisal, stock: SupplyBill, repairing: boolean): 'no-room' | 'waiting-stock' {
    const unbounded = { volume: Infinity, mass: Infinity };
    return billTotal(repairing ? this.repairPayload(quote, stock, unbounded) : this.payload(target, quote, stock, unbounded)) ? 'no-room' : 'waiting-stock';
  }

  // What else a vehicle that loads at the base for a job (`job`, and what it loads for that, `loaded`) takes on, as far as its
  // supply pieces take it, the stocks have it and its tank takes it there and home: for the services and the works that
  // wait near where that job takes it — on its side of the base it loads at, and no further from there than that is from it —,
  // which nobody else is on and its faction does not hold dangerous (`hazard`). On a trip to rearm, another that runs low and
  // a repair, of that one too; on any other, a repair and a works — but no works on a trip to rearm, whose load would only
  // slow it. It loads for one that runs low first, then for repairs, and then for works, the nearest first — to each what
  // `offer` would load for it, and of a repair or a works, a part; and of a stock the works lack more of than there is, for a
  // works only what the others leave over, so that one trip takes no more of it to the works on its way than the planner gives
  // out to each. Returns that load, and the stops of the trip after the job's own (`after`), which it goes to first, as it
  // would alone — a builder that stops by a works puts it up as it unloads —: one that runs low first, and then the nearest
  // each time.
  combine(actor: SceneActor, job: SupplyDispatchJob, faction: Faction, parts: FieldParts, loaded: SupplyBill): { payload: SupplyBill; after: DispatchStop[] } {
    const room = this.room, capacity = this.capacity(actor), rearming = job.kind === 'rearm', target = job.kind !== 'work' && room.world.actor(job.targetId),
      from = job.kind === 'work' ? room.works.pending.get(job.targetId)?.x : target && room.position(target), base = room.depot(faction, room.position(actor))!.x, payload = bill();
    if (typeof from !== 'number' || !Number.isFinite(from)) return { payload, after: [] };
    const space = { volume: capacity.volume, mass: capacity.mass }, stock = positive(billSum(this.available(faction, actor.id), loaded, -1)),
      take = (amounts: SupplyBill) => { for (const id of STOCK_IDS) { space.volume -= amounts[id] * cargoUnitVolume(SUPPLIED[id]); space.mass -= amounts[id] * cargoUnitMass(SUPPLIED[id]); } };
    take(loaded);
    // What the other works of the faction lack that nothing brings them.
    const owed = bill();
    for (const work of room.works.of(faction.id)) if (!(job.kind === 'work' && work.id === job.targetId)) {
      const wanted = this.wanted(work!, actor.id);
      for (const id of STOCK_IDS) owed[id] += wanted[id];
    }
    const reach = Math.max(NEARBY, along(base, from)), side = Math.sign(from - base), kinds = rearming ? ['rearm', 'repair'] : ['repair', 'work'],
      taken = new Set((rearming ? job.targetIds ?? [job.targetId] : [job.targetId]).map(id => job.kind + ':' + id)), claimed = this.claimed(actor.id),
      left: ServiceCandidate[] = this.demands(faction, parts).list.filter((demand): demand is ServiceDemand => (demand.kind === 'work' || demand.kind === 'rearm' || demand.kind === 'repair') && kinds.includes(demand.kind) && (demand.kind !== 'work' || Boolean(demand.shared)) && !demand.danger &&
        !taken.has(demand.kind + ':' + demand.id) && !claimed.has(demand.id) && along(demand.x, from) <= reach &&
        (along(demand.x, from) <= NEARBY || Math.sign(demand.x - base) === side) &&
        (demand.kind === 'work' || !this.target(demand.target, { factionId: faction.id, targetX: room.position(demand.target) })));
    // A vehicle that runs low is listed to rearm alone (`demands`): on a trip to rearm it, its repair is one more.
    if (rearming) for (const id of new Set([...job.targetIds ?? [job.targetId], ...left.filter(demand => demand.kind === 'rearm').map(demand => demand.id)])) {
      const other = room.world.actor(id), quote = other && appraise(other, parts);
      if (quote && billTotal(quote.repair) && room.canMend(room.players.get(other.ownerId!), other)) left.push({ kind: 'repair', id, x: room.position(other), target: other, quote });
    }
    const first = { rearm: 0, repair: 1, work: 2 }, chosen: DispatchStop[] = [];
    left.sort((a, b) => first[a.kind] - first[b.kind] || along(a.x, from) - along(b.x, from));
    for (const demand of left) {
      if (!(space.volume > 1e-6 && space.mass > 1e-6)) break;
      const free = { volume: space.volume, mass: space.mass };
      let part;
      if (demand.kind === 'work') {
        const wanted = this.wanted(demand.work, actor.id), spare = (id: StockId) => Math.min(stock[id], stock[id] - (owed[id] - wanted[id]));
        part = this.fits(bill(...STOCK_IDS.map(id => Math.max(0, Math.min(Math.ceil(wanted[id] - 1e-6), Math.floor(spare(id) + 1e-6))))), free);
      } else part = demand.kind === 'repair' ? this.repairPayload(demand.quote, stock, free) : this.payload(demand.target, demand.quote, stock, free);
      if (!billTotal(part)) continue;
      chosen.push({ kind: demand.kind, targetId: demand.id, targetIds: [demand.id], payload: part, x: demand.x });
      for (const id of STOCK_IDS) { stock[id] -= part[id]; payload[id] += part[id]; if (demand.kind === 'work') owed[id] -= part[id]; }
      take(part);
    }
    const stops: { x: number }[] = [{ x: from }], ordered: DispatchStop[] = [];
    for (let at = from; chosen.length;) {
      chosen.sort((a, b) => Number(b.kind === 'rearm') - Number(a.kind === 'rearm') || along(a.x, at) - along(b.x, at));
      const stop = chosen.shift()!; stops.push(stop); ordered.push(stop); at = stop.x;
    }
    if (stops.length < 2) return { payload, after: [] };
    // Its tank takes it by all of them and home, with what fuel the stocks have left after the load.
    let seconds = this.homeFrom(actor, faction, stops.at(-1)!.x);
    for (const [i, stop] of stops.entries()) seconds += this.travel(actor, i ? stops[i - 1]!.x : base, stop.x);
    const litres = this.fuel(actor, seconds);
    if (!(litres - actor.vehicle!.fuelLitres <= stock.combustivel) || !this.refuel(actor, parts, faction, litres)) return { payload: bill(), after: [] };
    return { payload, after: ordered };
  }
  // A stop of a trip done (`after`): on to the next one that still wants what was loaded for it, and that its faction does not
  // hold dangerous now (`perilous`), which it goes to with that aboard; with none, the job is done, and what is left aboard goes
  // home.
  next(actor: SceneActor, parts: FieldParts): void {
    const room = this.room, job = this.jobs.get(actor.id)!;
    let stop: DispatchStop | undefined;
    while ((stop = job.after?.shift())) {
      const target = stop.kind !== 'work' ? room.world.actor(stop.targetId) : null, work = stop.kind === 'work' ? room.works.pending.get(stop.targetId) : null,
        faction = room.factions.get(job.factionId)!, span = work ? room.works.span(work!) : null;
      if (work ? work.factionId !== job.factionId || !lacking(room.works.need(work!)) || this.perilous(faction, span!.minX, span!.maxX) :
        !target || room.atDepot(faction, target) || this.target(target, { factionId: job.factionId, targetX: room.position(target) }) ||
        this.perilous(faction, room.position(target))) continue;
      if (target) {
        const quote = appraise(target, parts);
        if (!billTotal(stop.kind === 'repair' ? quote.repair : quote.rearm)) continue;
      }
      Object.assign(job, { kind: stop.kind, targetId: stop.targetId, targetX: work ? work.x : room.position(target!), phase: 'deliver', reason: '',
        reserved: bill(), source: null, tries: 0, targetIds: stop.targetIds, queued: false } satisfies
        Pick<SupplyDispatchJob, 'kind' | 'targetId' | 'targetX' | 'phase' | 'reason' | 'reserved' | 'source' | 'tries' | 'targetIds' | 'queued'>);
      if (work) this.alongside(job, actor, room.works.span(work!)); else this.nextTo(job, actor, target!);
      return;
    }
    this.done(actor);
  }

  // The urgent construction is served first. Spare room takes only current deficits of its own faction within reach
  // of this same stop (`SUPPLY_REACH` of where the vehicle is to stand by it, `standing`), including reserves above LOW, of
  // those not standing where the faction holds dangerous (`perilous`). On the way back to collect, only the urgent target is
  // committed: the real loading position, stock and neighbouring deficits are known again when the vehicle reaches the base.
  rearmLoad(actor: SceneActor, target: SceneActor, quote: Appraisal, faction: Faction, parts: FieldParts, stock: SupplyBill): { payload: SupplyBill; targetIds: string[] } {
    const capacity = this.capacity(actor), left = { ...stock }, payload = bill(), targetIds: string[] = [];
    const take = (recipient: SceneActor, wanted: Appraisal) => {
      const cost = this.payload(recipient, wanted, left, capacity);
      if (!billTotal(cost)) return;
      targetIds.push(recipient.id);
      for (const id of STOCK_IDS) {
        left[id] = Math.max(0, left[id] - cost[id]); payload[id] += cost[id];
        capacity.volume = Math.max(0, capacity.volume - cost[id] * cargoUnitVolume(SUPPLIED[id]));
        capacity.mass = Math.max(0, capacity.mass - cost[id] * cargoUnitMass(SUPPLIED[id]));
      }
    };
    take(target, quote);
    if (!targetIds.length) return { payload, targetIds };
    const stop = this.standing(actor, this.room.works.hull(target)), claimed = this.claimed(actor.id);
    for (const other of this.room.fleet(faction)) {
      if (other.id === actor.id || other.id === target.id || claimed.has(other.id) || this.targets.has(other.id) ||
        this.room.atDepot(faction, other) || this.room.works.gap(other, stop) > SUPPLY_REACH ||
        this.target(other, { factionId: faction.id, targetX: this.room.position(other) }) || this.perilous(faction, this.room.position(other))) continue;
      take(other, appraise(other, parts));
    }
    return { payload, targetIds };
  }

  // What a works lacks that no other job brings it.
  wanted(work: Work, except: string | null = null): SupplyBill { return positive(billSum(this.room.works.need(work!), this.carrying(work.id, except), -1)); }
  // What a load from the base takes for a works, by stock: what it lacks that no other job brings, in whole units that cover
  // it — what came of a heap may leave it short of a part of one —, as far as the stocks have it.
  asked(work: Work, faction: Faction, except: string | null = null): SupplyBill {
    const wanted = this.wanted(work, except), available = this.available(faction, except);
    return bill(...STOCK_IDS.map(id => Math.max(0, Math.min(Math.ceil(wanted[id] - 1e-6), Math.floor(available[id])))));
  }
  // Whether a works waits for the heap of the structure it is moved from: while that is still being taken down for it.
  awaits(work: Work): boolean {
    const record = work.from ? this.room.records.get(work.from) : undefined;
    return record?.service?.kind === 'dismantle' && record.service.to === work.id;
  }
  // The heap a works is brought from first: that of the structure it is moved from, while it has some of what the works lacks.
  source(work: Work): Heap | null {
    const heap = work.from && this.room.works.heaps.get(work.from), need = this.room.works.need(work!);
    return heap && STOCK_IDS.some(id => need[id] > 0 && heap.stock[id] >= 1) ? heap : null;
  }
  // Whether supply pieces have room for more.
  spare(actor: SceneActor): boolean { return this.room.serving(actor.id).reduce((sum, piece) => sum + Math.max(0, cargoRoom(piece) - cargoVolume(piece)), 0) > FULL; }

  // What a vehicle carries of the stocks of its faction goes back to them: what its supply pieces that serve carry, the mix
  // of its asphalt among it, and the mix in the hoppers of its pavers that work.
  unload(actor: SceneActor, faction: Faction): void {
    const ore = this.room.deliverCargo(faction, actor);
    const crates = [...this.room.serving(actor.id), ...this.room.roadworks.tools(actor, 'pave')], back = supplied(carriedBy(crates).carried);
    if (!billTotal(back)) { if (loadTotal(ore)) this.room.world.command('sync'); return; }
    this.room.unload(crates, load());
    for (const id of STOCK_IDS) faction.stock[id] += back[id];
    this.room.world.command('sync');
  }
  // Loads a bill from the stocks of the faction into the supply pieces of a vehicle, or into other pieces of it that take it.
  stow(actor: SceneActor, faction: Faction, wanted: SupplyBill, crates: SceneModule[] = this.room.serving(actor.id)): void {
    for (const id of STOCK_IDS) if (wanted[id] > 0) {
      const put = stow(crates, SUPPLIED[id], wanted[id]); this.room.carry(put.changed); faction.stock[id] -= put.moved;
    }
    this.room.world.command('sync');
  }

  // Sends a vehicle on a job to a place by its squad, as a Move sends it. An aircraft comes down there to work (Squad `land`,
  // `'work'`) — its pilot watching its fuel all the way (Squad.homeward) —, at the very place its job chose for it: one it
  // may come down on (`alight`) — or anywhere of the stretch about it the job gives it (`within`, Squad.touchdown).
  go(job: DispatchJob, actor: SceneActor, x: number, arrival: number | null = null, within: SquadSpan | null = null): boolean {
    const squad = this.room.players.get(job.ownerId)!.squad!;
    if (aircraft(actor)) { squad.land(actor.id, 'work', x, within); job.leg = squad.units.get(actor.id)?.move; return Boolean(job.leg); }
    squad.command({ order: 'move', ids: [actor.id], x });
    const unit = squad.units.get(actor.id);
    job.leg = unit?.move;
    if (job.leg && arrival === LOADING_APPROACH) {
      // Ordinary spacing may choose another place. Only the certified crane stop is a cosmetic preference.
      if (Math.abs(job.leg.x - x) > 1e-9) { unit!.move = job.leg = null; squad!.release(actor.id); }
      else job.leg.arrival = arrival;
    }
    return Boolean(job.leg);
  }
  // Where an aircraft on a job comes down about `x`: the nearest place to it, from `lo` to `hi` where given, where the ground
  // under it is level enough and no vehicle of its side stands or goes (Squad.landing); nothing where there is none.
  alight(job: DispatchJob, actor: SceneActor, x: number, lo = -Infinity, hi = Infinity): number | null {
    return this.room.players.get(job.ownerId)!.squad!!.landing(actor.id, x, new Set([actor.id]), { lo, hi, strict: true });
  }
  // A job an aircraft cannot come down for, or not reach and come back from on its tanks full (`OUT_OF_RANGE`), by its
  // target: it is given up and tried again in a while (`targets`), and the aircraft says why it waits (`wait`).
  unlanded(job: DispatchJob, actor: SceneActor, why: JobReason = NO_LANDING): void { if (job.targetId) this.targets.set(job.targetId, this.room.world.time + RETRY); this.wait(actor.id, why); }
  // Whether an aircraft is in the air: it hovers or flies, and stands nowhere (SharedRoom.still).
  aloft(actor: SceneActor): boolean { return aircraft(actor) && Boolean(actor.vehicle?.flying); }
  // Beside what a supply vehicle serves or loads from (`span`: of a construction, its hull, Works.hull; of a heap, its pile,
  // Works.pile), near enough to hand it over (`SUPPLY_REACH`), as a crew hands crates across and runs a hose over: on the side
  // it comes from, or else on the other, its end `clearance` off it and the fine stop of loading more, and no further than
  // that reach (`stop`), where no other vehicle of its side stands or goes; with none free, the nearest of those places on
  // the side it comes from all the same — vehicles stand through each other —, as it stands now. One that stands so on the
  // ground already stays. An aircraft comes down there, on ground it may come down on, as it faces; with none there,
  // nowhere (`unlanded`).
  beside(job: DispatchJob, actor: SceneActor, span: WorkSpan, clearance: number): void {
    if (!this.aloft(actor) && this.room.works.gap(actor, span) <= SUPPLY_REACH) { job.leg = null; return; }
    const at = (options: StopOptions) => this.stop(job, actor, span, { clearance, reach: SUPPLY_REACH, ...options }),
      goal = at({ exact: job.tries! > 0 }) ?? at({ exact: true, strict: false });
    if (goal !== null) this.place(job, actor, goal); else this.unlanded(job, actor);
  }
  // Beside a construction it serves, the gap of its squad off it (squad.ts `GAP`): nearer, the squad would send it on.
  nextTo(job: DispatchJob, actor: SceneActor, target: SceneActor): void { this.beside(job, actor, this.room.works.hull(target), GAP); }
  // By a heap it loads, a little off it, as by a works (construction-site.ts `SITE_CLEARANCE`).
  atHeap(job: DispatchJob, actor: SceneActor, heap: Heap): void { this.beside(job, actor, this.room.works.pile(heap), SITE_CLEARANCE); }
  // Where a supply vehicle stands by what it is sent to serve (`span`, its hull), as it is sent there (`beside`), but for
  // where others of its side stand: on the side it comes from, the gap of its squad off it, as long as it is.
  standing(actor: SceneActor, span: WorkSpan): WorkSpan {
    const here = this.room.position(actor), hull = this.room.works.hull(actor), length = hull.maxX - hull.minX,
      side = Math.sign(here - (span.minX + span.maxX) / 2) || -1, edge = side < 0 ? span.minX - GAP : span.maxX + GAP;
    return { minX: Math.min(edge, edge + side * length), maxX: Math.max(edge, edge + side * length) };
  }
  depot(job: DispatchJob, actor: SceneActor): void {
    const faction = this.room.factions.get(job.factionId)!, here = this.room.position(actor), place = this.room.depot(faction!, here)!, at = depotAt(here, place);
    if (!aircraft(actor)) { this.go(job, actor, at); return; }
    const inside = { lo: place.x - place.radius + EDGE, hi: place.x + place.radius - EDGE };
    this.go(job, actor, this.alight(job, actor, at, inside.lo, inside.hi) ?? at, null, inside);
  }
  // A vehicle on a leg of its job to the nearest place of its faction where it is served (`depot`), to load or unload there,
  // that does not stand still there yet: with nowhere it is sent, away from it its way there is shut (`blocked-way`), and an
  // aircraft over it in the air, which would hover there for ever, is sent down there.
  unhoused(job: DispatchJob, actor: SceneActor, faction: Faction, unit: SquadUnit | undefined): void {
    if (unit?.move) return;
    if (!this.room.atDepot(faction, actor)) this.wait(actor.id, 'blocked-way');
    else if (this.aloft(actor)) this.depot(job, actor);
  }
  // The way from a place of the field home: to the nearest place of the faction where a vehicle is served.
  homeFrom(actor: SceneActor, faction: Faction, x: number): number { return this.travel(actor, x, this.room.depot(faction, x)!.x); }
  // Where a road machine's next outward trip begins: here, or at the same depot point it is sent to for collection.
  // Already stopped in its base, it loads there and goes from there, without an invented trip through the base centre.
  departure(actor: SceneActor, collect = false): number {
    const room = this.room, here = room.position(actor);
    if (!collect) return here;
    const faction = room.factions.get(actor.team!);
    return faction?.base && !(room.atDepot(faction, actor) && room.still(actor)) ? depotAt(here, room.depot(faction, here)!) : here;
  }

  // On its way home, with what it carries: it unloads it in the base, and waits there a moment. A reason says why it went:
  // what it went for is tried again in a while.
  home(job: DispatchJob, actor: SceneActor, reason: JobReason = ''): void {
    releaseHaul(this.room.players.get(job.ownerId)?.squad, actor.id, job.haul);
    delete job.haul;
    if (reason && job.targetId) this.targets.set(job.targetId, this.room.world.time + RETRY);
    delete job.targetIds; delete job.after;
    Object.assign(job, { kind: null, targetId: null, source: null, phase: 'return', reason, reserved: bill() } satisfies
      Pick<ReturningDispatchJob, 'kind' | 'targetId' | 'source' | 'phase' | 'reason' | 'reserved'>);
    const faction = this.room.factions.get(job.factionId);
    if (!faction?.base) { this.cancel(actor.id); return; }
    if (this.room.atDepot(faction, actor) && this.room.still(actor)) {
      this.unload(actor, faction); this.wait(actor.id, reason, 5); return;
    }
    this.depot(job, actor);
  }
  // A job done: the vehicle is free where it stands, and is given the next one from there (`plan`).
  done(actor: SceneActor): void { this.cancel(actor.id); }

  safe(actor: SceneActor, owner: Player | undefined): boolean {
    const record = this.room.record(actor), unit = owner?.squad!.units.get(actor.id);
    return Boolean(owner && !record.wreck && !record.service && this.room.calm(actor) &&
      !(unit?.threat || unit?.alertUntil! > this.room.world.time || unit?.answerUntil! > this.room.world.time));
  }

  // The side of a member of a faction: what any of its members' sides holds of the enemies is what the faction holds (room.ts
  // `Side`). None for a faction with nobody on the field.
  side(faction: Faction) {
    for (const id of faction.members) { const squad = this.room.players.get(id)?.squad; if (squad) return squad.side; }
    return null;
  }
  // What a faction keeps in mind of the armed enemies about the field, by what it holds of them now (Side.threats and
  // Side.batteries) and nothing else: of each it has in sight with a gun, where it is — along the field and how high —, and as
  // far about that as its guns reach but no farther than an enemy in sight turns a worker back (Squad `HAUL_SCARE`); of each it
  // holds only as a mark, where the mark puts it, and as far about that as a mark holds a worker (Squad `MARK_SCARE`) or its
  // guns were last seen to reach, whichever is farther; and of each gun its base places by its fire, where it fired from — on
  // the ground, or in the air as high as the mark says —, as far as a mark and as far again as that place may be off by. It
  // keeps each in mind `DANGER_MEMORY` seconds after it last held it so, but forgets at once one it sees with no gun, one it
  // knows to be out of the fight or gone (Side.foe), and one of an ally. It knows the sentinel of an airdrop it knows of to be
  // out of the fight once it saw that, or saw it go, from then on (`guarded`).
  watch(faction: Faction): void {
    const room = this.room, time = room.world.time, side = this.side(faction), ground = room.world.terrain;
    if (!side) return;
    let kept = this.sightings.get(faction.id);
    if (!kept) this.sightings.set(faction.id, kept = new Map());
    for (const foe of side.threats?.() ?? []) {
      const radius = foe.reach === null ? Math.max(MARK_SCARE, kept.get(foe.id)?.radius ?? 0) : Math.min(HAUL_SCARE, foe.reach);
      if (radius > 0) kept.set(foe.id, { x: foe.x, y: foe.y, radius, at: time, actor: true }); else kept.delete(foe.id);
    }
    for (const mark of side.batteries)
      kept.set(mark.id, { x: mark.x, y: mark.y ?? ground.height(mark.x), radius: MARK_SCARE + mark.error, at: mark.at, actor: false });
    for (const [id, held] of kept)
      if (time - held.at > DANGER_MEMORY || held.actor && (!side.foe(id) || room.allied(faction.id, room.world.actor(id)?.team))) kept.delete(id);
    const drop = room.activities?.drop;
    if (drop?.guardianId !== undefined && activityKnown(room, faction) && !side.foe(drop.guardianId)) {
      let known = this.cleared.get(drop.id);
      if (!known) this.cleared.set(drop.id, known = new Set());
      known.add(faction.id);
    }
  }
  // Whether a faction holds the airdrop guarded: one it knows of, with a sentinel it does not know to be out of the fight. What
  // the event tells it says only that there may be one (world-activities.ts `activityView`).
  guarded(faction: Faction): boolean {
    const drop = this.room.activities?.drop;
    return Boolean(drop && drop.guardianId !== undefined && activityKnown(this.room, faction) && !this.cleared.get(drop.id)?.has(faction.id));
  }
  // What a faction holds dangerous for its automatic work now, as spans of the field ([[from, to], …]), by what it knows and no
  // more: the ground of every other faction but its allies, as it is told it (SharedRoom.territories), and as much ground about
  // each base and each post of theirs it knows of as a base or a post holds (territory.ts `territoryOf`), whether it saw that
  // ground or not — but its own ground, where no structure of theirs stands (territory.ts `territoryRefusal`), about its base and
  // each of its posts, one it takes down too until it is down —; about the armed enemies it keeps in mind (`watch`); and about
  // the airdrop while it holds it guarded (`SENTINEL_REACH`). About an enemy it is the ground within that reach of where the
  // enemy is, up and down alike (ground-sight.ts `groundWithin`): an aircraft whose guns reach less far than it is high
  // over the ground endangers none of it. Worked out once a look of the dispatch. A faction that is gone holds nothing.
  perils(faction: Faction | undefined): RoadSpan[] {
    if (!faction) return [];
    const room = this.room, time = room.world.time, held = this.dangers.get(faction.id);
    if (held?.time === time) return held.spans;
    const enemy = (id: string) => id !== faction.id && !room.allied(faction.id, id), drop = room.activities?.drop,
      ground = [...room.territories(faction).filter(told => told.kind === 'other').flatMap(told => told.spans),
        ...[...room.reconnoitred(faction)].filter(([id]) => enemy(id)).flatMap(([, known]) => territoryOf(known.x)),
        ...territoryOf(null, [...room.scouted(faction).values()].filter(known => enemy(known.of)).map(known => known.x))],
      spans = merged([...without(merged(ground), territoryOf(faction.base?.x ?? null, faction.posts.map(post => post.x))),
        ...[...this.sightings.get(faction.id)?.values() ?? []].flatMap(({ x, y, radius }) => groundWithin(room.world.terrain, x, y, radius)),
        ...this.guarded(faction) ? [[drop!.x - SENTINEL_REACH, drop!.x + SENTINEL_REACH] as RoadSpan] : []]);
    this.dangers.set(faction.id, { time, spans });
    return spans;
  }
  // Whether a faction holds a place dangerous for its automatic work (`perils`): a point of the field, or any of a stretch of
  // it from `lo` to `hi`.
  perilous(faction: Faction | undefined, lo: number, hi = lo): boolean {
    const spans = this.perils(faction);
    return contains(spans, lo) || clip(spans, lo, hi).length > 0;
  }
  // Whether a faction holds dangerous the place a job of it sends a vehicle to (`perilous`): the vehicle it serves, the works it
  // brings material to and the heap that comes from, the works it puts up or the structure it takes down, or the heap or the
  // pile it takes home. Of a road, the lane a machine would take of it is judged instead (`offer`).
  hazard(faction: Faction, demand: Demand): boolean {
    const span = demand.span ?? (demand.work ? this.room.works.span(demand.work!) : null);
    return !roadwork(demand) && (this.perilous(faction, demand.x) || demand.heap && this.perilous(faction, demand.heap.x) ||
      Boolean(span) && this.perilous(faction, span!.minX, span!.maxX));
  }
  // Whether a vehicle on a trip of its supply pieces is to give it up on its way, as its faction holds the place it goes to
  // dangerous now (`perilous`): the vehicle it serves, the heap it fetches and the works it brings that to, or the pile of its
  // haul. One that turned home with its haul, or is on its way home, goes there.
  forsaken(job: DispatchJob, actor: SceneActor): boolean {
    const room = this.room, faction = room.factions.get(job.factionId), works = room.works;
    if (!faction || job.phase === 'return' || job.phase === 'aside') return false;
    if (job.kind === 'haul') return outwardHaul(job) && this.perilous(faction, job.targetX);
    if (job.kind === 'rearm' || job.kind === 'repair') {
      const target = room.world.actor(job.targetId);
      return Boolean(target && this.perilous(faction, room.position(target)));
    }
    const work = job.kind === 'work' && works.pending.get(job.targetId), span = work && works.span(work!),
      heap = job.phase !== 'deliver' && works.heaps.get((job.kind === 'heap' ? job.targetId : job.source)!);
    return Boolean(span && this.perilous(faction, span.minX, span.maxX) || heap && this.perilous(faction, heap.x));
  }
  // A builder or a road machine whose faction holds dangerous now where it was sent (`perilous`) gives that up — a road
  // machine lays first what it did of its lane (`cancel`) — and goes home saying why, as a vehicle with supply pieces does
  // (`home`): free on its way there for any other job (`ready`).
  forgo(job: DispatchJob, actor: SceneActor): void {
    this.cancel(actor.id);
    const trip: ReturningDispatchJob = { kind: null, ownerId: job.ownerId, factionId: job.factionId, targetId: null, phase: 'return', reason: '', reserved: bill(), leg: null, source: null };
    this.jobs.set(actor.id, trip); this.home(trip, actor, DANGER);
  }

  // The pieces of a construction that work: not destroyed, and still on it.
  live(actor: SceneActor, parts: FieldParts): CompiledModule[] {
    return actor.blueprint.modules.filter(piece => {
      const part = parts.get(`${actor.id}:${actor.revision}:${piece.id}`);
      return part?.health! > 0 && part!.attached !== false;
    });
  }
  // Whether a vehicle goes where a job sends it: on an engine and running gear that work, or as an aircraft on thrusters that
  // work and lift it with what it carries (Squad `lifts`).
  drives(actor: SceneActor, parts: FieldParts): boolean {
    const live = this.live(actor, parts);
    if (aircraft(actor)) return live.some(piece => piece.kind === 'thruster') && lifts(this.room.world, actor.id);
    return live.some(piece => piece.kind === 'engine') && live.some(piece => ['wheel', 'track'].includes(piece.kind));
  }
  // Whether a construction may be sent to build: a vehicle in action, with a builder that works and an engine that turns it
  // (SharedRoom.power).
  fit(actor: SceneActor, parts: FieldParts): boolean {
    const record = this.room.records.get(actor.id), live = this.live(actor, parts);
    return Boolean(actor.vehicle?.config.enabled && record && !record.wreck && !this.room.outOfAction()[actor.id] &&
      live.some(piece => piece.kind === 'builder') && live.some(piece => piece.kind === 'engine'));
  }
  // How fast the builders of a vehicle that work go together, one of the reference size going at 1.
  pace(actor: SceneActor, parts: FieldParts): number { return this.live(actor, parts).reduce((sum, piece) => sum + (piece.kind === 'builder' ? toolPace(piece) : 0), 0); }

  target(actor: SceneActor | null | undefined | false, job: { factionId: string; targetX?: number }): JobReason {
    const owner = actor && this.room.players.get(actor.ownerId!), record = actor && this.room.record(actor);
    if (!owner || owner.factionId !== job.factionId || !record || record.wreck || record.service) return 'target-lost';
    const unit = owner!.squad!.units.get(actor.id);
    if (!this.room.still(actor) || unit?.move && !actor.vehicle?.fuelStarved ||
      Math.abs(this.room.position(actor) - job.targetX!) > STRAY) return 'target-moving';
    // A structure fights where it stands, and the fire it takes holds back nothing brought to it: an enemy that keeps
    // hitting a casemate out of rounds would keep it so. Whoever brings that keeps itself out of harm by its own rule (`safe`).
    if (isVehicleDesign(actor.construction) && !this.room.calm(actor)) return 'threat';
    return '';
  }

  // At the base, before going out: what it carried goes back to the stocks, and its tank is filled from them with the fuel
  // `budget` asks for, as far as they have it. Whether it has that much.
  refuel(actor: SceneActor, parts: FieldParts, faction: Faction, budget: number): boolean {
    this.unload(actor, faction);
    const fuel = Math.ceil(Math.max(0, budget - actor.vehicle!.fuelLitres));
    if (fuel > 0) {
      const given = this.room.refill(actor, appraise(actor, parts), { supplier: null, stock: bill(0, 0, 0, Math.min(fuel, this.available(faction, actor.id).combustivel)) });
      // The restricted point is a quote, not the faction's stock object.
      if (given) faction.stock.combustivel -= given.cost.combustivel;
    }
    return actor.vehicle!.fuelLitres + 1e-6 >= budget;
  }

  // A trip of supply pieces: to rearm or repair a vehicle, or for a works or a heap.
  advance(job: DispatchJob, actor: SceneActor, parts: FieldParts): void {
    const owner = this.room.players.get(job.ownerId), unit = owner?.squad!.units.get(actor.id), record = this.room.record(actor);
    if (!this.manages(actor.id) || actor.ownerId !== job.ownerId || owner?.factionId !== job.factionId || record.wreck) { this.cancel(actor.id); return; }
    if (playerOrder(owner!.squad, actor.id, job)) { this.off(actor.id); return; }
    if (record.service || this.fuelling(job, actor, unit)) return;
    if (!this.drives(actor, parts)) { this.wait(actor.id, 'immobile'); return; }
    if (actor.vehicle?.fuelStarved) {
      const fuel = this.stock(actor.id).combustivel;
      if (fuel > 0 && this.room.still(actor) && this.room.calm(actor))
        this.room.refill(actor, appraise(actor, parts), { supplier: actor, stock: bill(0, 0, 0, fuel) });
      if (actor.vehicle!.fuelStarved) { if (job.targetId) this.targets.set(job.targetId, this.room.world.time + RETRY); this.wait(actor.id, 'waiting-fuel'); return; }
    }
    const halted = haltedReason(unit);
    if (halted) { if (job.targetId) this.targets.set(job.targetId, this.room.world.time + RETRY); this.wait(actor.id, halted); return; }
    if (!this.safe(actor, owner) && job.phase !== 'return') { this.home(job, actor, 'threat'); return; }
    if (this.forsaken(job, actor)) { this.home(job, actor, DANGER); return; }
    const faction = this.room.factions.get(job.factionId)!;
    if (job.phase === 'aside') { if (!unit?.move) this.done(actor); return; }
    if (job.phase === 'return') {
      if (this.room.atDepot(faction, actor) && this.room.still(actor)) { this.unload(actor, faction); this.wait(actor.id, job.reason, 5); }
      else this.unhoused(job, actor, faction, unit);
      return;
    }
    if (job.kind === 'haul') this.transport(job, actor, parts, faction, unit);
    else if (job.kind === 'rearm' || job.kind === 'repair') this.service(job, actor, parts, faction, unit);
    else if (job.kind === 'work' || job.kind === 'heap') this.carry(job, actor, parts, faction, unit);
  }

  // An aircraft on a job that its pilot sends home for its fuel (Squad.homeward) keeps the job: it waits while the aircraft
  // goes there and comes down, and there until its tanks are full, and takes up its way again from there (`retake`). One on a
  // haul goes home by it (Squad.haul). One sent home so after it left home full (`full`, till it comes down away from home)
  // does not reach its work and come back (`far`): the job is given up there for a while (`home`). So does one in the air on
  // thrusters that no longer hold it up as its pilot flies it (Squad `steady`) keep it, for its pilot to send it home to be
  // mended (Squad.mend), while he has it so (`unit.mend`) — on its way there (`thruster-lost`), and there until its thrusters
  // hold it up again (`mending`) —, and take it up again as from a fill-up once it is out of danger too (`safe`): it was hit
  // for it, and the job does not send it home for that (`threat`, `advance`). One its pilot sets down where it is gives the
  // job up (`forced-landing`). Whether the job waits so now.
  fuelling(job: DispatchJob, actor: SceneActor, unit: SquadUnit | undefined): boolean {
    const room = this.room, squad = room.players.get(job.ownerId)!.squad!;
    if (aircraft(actor) && !actor.vehicle!.flying) {
      if (!room.atDepot(room.factions.get(job.factionId)!, actor)) delete job.full;
      else if (squad.topped(actor.id)) job.full = true;
    }
    if (unit?.move?.land === 'forced') { this.wait(actor.id, 'forced-landing', 0); return true; }
    if (unit?.mend || aircraft(actor) && actor.vehicle!.flying && !steady(room.world, actor.id)) {
      Object.assign(job, { mend: true, reason: unit?.move?.land === 'mend' ? 'thruster-lost' : 'mending', tries: 0, leg: null });
      return true;
    }
    if (job.mend) {
      if (!this.safe(actor, room.players.get(job.ownerId))) { job.reason = 'threat'; return true; }
      delete job.mend; job.reason = '';
      if (!job.refuel) { if (!unit?.move) this.retake(job, actor); return true; }
    }
    if (unit?.move?.land === 'fuel') {
      if (job.full) job.far = true;
      Object.assign(job, { refuel: true, reason: 'refuelling', tries: 0, leg: null });
      return true;
    }
    if (!job.refuel) return false;
    if (!unit?.move && !squad.topped(actor.id)) { job.reason = 'refuelling'; return true; }
    delete job.refuel; job.reason = '';
    if (job.far) { delete job.far; this.home(job, actor, OUT_OF_RANGE); }
    else if (!unit?.move) this.retake(job, actor);
    return true;
  }
  // Sends an aircraft filled up on its way home on with its job: to the heap it fetches, or to the vehicle it serves. A builder
  // (`attend`) and one bringing a works its material (`carry`) take up their way by themselves, as from wherever they stand.
  retake(job: DispatchJob, actor: SceneActor): void {
    const heap = this.gathering(job), target = (job.kind === 'rearm' || job.kind === 'repair') && this.room.world.actor(job.targetId!);
    if (job.phase === 'fetch' && heap) this.atHeap(job, actor, heap!);
    else if (job.phase === 'deliver' && target) this.nextTo(job, actor, target);
  }

  // One ordinary physical haul, then back to this same dispatcher. It never orders extraction or waits for production.
  transport(job: SupplyDispatchJob, actor: SceneActor, parts: FieldParts, faction: Faction, unit: SquadUnit | undefined): void {
    if (job.phase === 'collect') {
      if (!(this.room.atDepot(faction, actor) && this.room.still(actor))) {
        if (unit?.move) return;
        if (this.aloft(actor) && this.room.atDepot(faction, actor)) this.depot(job, actor); else this.wait(actor.id, 'blocked-way');
        return;
      }
      const site = this.readyPiles(faction).find(site => site.id === job.targetId);
      if (!site || !(this.transportSpace(actor, site) > 1e-6)) { this.done(actor); return; }
      const moved = Math.min(site.supplies ? billTotal(site.supplies) : site.stock, this.transportSpace(actor, site)),
        budget = this.fuel(actor, 2 * this.travel(actor, this.room.position(actor), site.x) + moved / TRANSFER_RATE);
      if (!this.refuel(actor, parts, faction, budget)) { this.wait(actor.id, 'waiting-fuel'); return; }
      this.beginTransport(job, actor);
      return;
    }
    // A haul an aircraft found no ground to come down on for, or that its tanks full did not take it to (Squad.haul), is
    // given up for a while.
    if (unit?.haul !== job.haul) {
      const why = ([NO_LANDING, OUT_OF_RANGE] as const).find(why => unit?.halt === why);
      if (why) { unit!.halt = ''; this.unlanded(job, actor, why); } else this.done(actor);
      return;
    }
    if (unit!.haul!.blocked) { this.home(job, actor, unit!.haul!.blocked); return; }
    if (unit!.haul!.fled) job.reason = 'threat';
  }

  beginTransport(job: SupplyDispatchJob, actor: SceneActor): void {
    const squad = this.room.players.get(job.ownerId)!.squad!;
    squad.command({ order: 'haul', ids: [actor.id], depositId: job.targetId });
    job.haul = squad.units.get(actor.id)!.haul;
    job.haul!.once = true; job.phase = 'fetch'; job.reserved = bill(); job.leg = null;
  }

  service(job: SupplyDispatchJob, actor: SceneActor, parts: FieldParts, faction: Faction, unit: SquadUnit | undefined): void {
    const target = this.room.world.actor(job.targetId)!, repairing = job.kind === 'repair';
    if (repairing && target && this.room.record(target).service?.kind === 'repair') { this.next(actor, parts); return; }
    const refusal = this.target(target, job);
    if (refusal) { this.home(job, actor, refusal); return; }
    const quote = appraise(target, parts), owner = this.room.players.get(target.ownerId!);
    if (!billTotal(repairing ? quote.repair : quote.rearm) || this.room.atDepot(faction, target)) { this.next(actor, parts); return; }
    if (repairing && !this.room.canMend(owner, target)) { this.home(job, actor, 'target-lost'); return; }
    if (job.phase === 'collect') {
      if (this.room.atDepot(faction, actor) && this.room.still(actor)) {
        if (!this.refuel(actor, parts, faction, this.fuel(actor, 2 * this.travel(actor, this.room.position(actor), this.room.position(target))))) { this.wait(actor.id, 'waiting-fuel'); return; }
        const stock = this.available(faction, actor.id), load = repairing
          ? { payload: this.repairPayload(quote, stock, this.capacity(actor)) }
          : this.rearmLoad(actor, target, quote, faction, parts, stock);
        if (!billTotal(load.payload)) { this.wait(actor.id, this.scant(target, quote, stock, repairing)); return; }
        if (!repairing && 'targetIds' in load) job.targetIds = load.targetIds;
        const more = this.combine(actor, job, faction, parts, load.payload);
        job.after = more.after;
        this.stow(actor, faction, billSum(load.payload, more.payload));
        job.phase = 'deliver'; job.reserved = bill();
        this.nextTo(job, actor, target);
      } else this.unhoused(job, actor, faction, unit);
      return;
    }
    // It hands over beside it, on the ground (SharedRoom.handy): an aircraft over it comes down first.
    if (this.room.handy(actor, target) && !this.aloft(actor)) {
      // A move can finish while the real chassis is still braking. Keep its delivery (and the other recipients'
      // reserved load) until it settles; cancelling here would release their ammunition budget to ordinary repairs.
      if (!this.room.still(actor)) return;
      const point = { supplier: actor, stock: this.giving(actor.id, this.stock(actor.id)) }, given = repairing
        ? this.room.mendFrom(owner!, target, quote, [point]) : this.room.refill(target, quote, point);
      if (given || job.after?.length) this.next(actor, parts); else this.home(job, actor, 'waiting-stock');
    } else if (!unit?.move) {
      // Short of it with nowhere it is sent — its way left it short, or it stopped a little off where it was sent to serve it
      // (`STRAY`) —, it is sent beside it again from where it stands, as many times as `TRIES`; then the way there is shut.
      if (job.tries! < TRIES) this.nextTo(job, actor, target);
      else { this.targets.set(target.id, this.room.world.time + RETRY); this.home(job, actor, 'blocked-way'); }
    }
  }

  // A trip for a works or a heap: by the base, where it unloads and fills its tank, to the heap it loads at — of a works, the
  // one the works is moved from — and then, of a works, to the works (`collect`, `fetch`, `deliver`); or, of a works brought
  // from the base, loaded there with what the works lacks that the stocks have, as far as it carries it. One that has the room
  // and the fuel for it goes to the heap straight from where it stands, and one that carries some of what the works lacks to
  // the works (`offer`). Done — the heap loaded as far as it goes, or the works given all it lacked of what it carried —, it is
  // free where it stands with what is left aboard.
  carry(job: SupplyDispatchJob, actor: SceneActor, parts: FieldParts, faction: Faction, unit: SquadUnit | undefined): void {
    const works = this.room.works, work = job.kind === 'work' ? works.pending.get(job.targetId) : null,
      heap = job.kind === 'heap' ? works.heaps.get(job.targetId!) : job.source ? works.heaps.get(job.source) : null;
    if (job.kind === 'work' ? !work || work.factionId !== job.factionId : !heap) { this.done(actor); return; }
    const here = this.room.position(actor), still = this.room.still(actor);
    if (job.phase === 'collect') {
      if (!(this.room.atDepot(faction, actor) && still)) { this.unhoused(job, actor, faction, unit); return; }
      const out = heap ? this.travel(actor, here, heap.x) : 0,
        to = work ? this.travel(actor, heap?.x ?? here, work.x) + this.homeFrom(actor, faction, work.x) : out;
      if (!this.refuel(actor, parts, faction, this.fuel(actor, out + to))) { this.wait(actor.id, 'waiting-fuel'); return; }
      if (heap) { job.phase = 'fetch'; job.reserved = bill(); job.tries = 0; this.atHeap(job, actor, heap!); return; }
      const asked = this.asked(work!, faction, actor.id), wanted = this.fits(asked, this.capacity(actor));
      if (!billTotal(wanted)) { if (lacking(this.wanted(work!, actor.id))) this.wait(actor.id, billTotal(asked) ? 'no-room' : 'waiting-stock'); else this.done(actor); return; }
      const more = this.combine(actor, job, faction, parts, wanted);
      job.after = more.after;
      this.stow(actor, faction, billSum(wanted, more.payload));
      job.phase = 'deliver'; job.reserved = bill();
      this.alongside(job, actor, works.span(work!));
      return;
    }
    if (job.phase === 'fetch') {
      // It loads beside the heap, on the ground (`SUPPLY_REACH` off its pile, Works.pile): an aircraft over it comes down first.
      const near = Boolean(heap) && !this.aloft(actor) && works.gap(actor, works.pile(heap!)) <= SUPPLY_REACH;
      // Loaded as far as it goes, or with the heap gone: on to the works, or done.
      if (!heap || near && still && !this.spare(actor)) {
        if (!work) { this.done(actor); return; }
        job.phase = 'deliver'; job.tries = 0; this.alongside(job, actor, works.span(work!)); return;
      }
      // One with a builder loads it where its crane reaches it.
      if (near && still && !unit?.move && this.arm(actor.id) && this.settle(job, actor, parts)) return;
      // Short of it with nowhere it is sent, it is sent beside it again from where it stands, as many times as `TRIES`; then
      // the way there is shut.
      if (!near && !unit?.move) { if (job.tries! < TRIES) this.atHeap(job, actor, heap!); else this.home(job, actor, 'blocked-way'); }
      return;
    }
    // Unloaded of all the works lacked of what it carried: done, with the rest aboard. It unloads only beside it, where a
    // builder of it stops once more where its crane reaches the works (`settle`); a way that left it short of that sends it
    // there again from where it stands (`alongside`), until the way there is shut. An aircraft beside it in the air, with
    // nowhere it is sent, is sent down there.
    const carried = positive(billSum(this.stock(actor.id), this.later(job), -1)), need = works.need(work!);
    if (!STOCK_IDS.some(id => need[id] > 0 && carried[id] > 1e-6)) { this.next(actor, parts); return; }
    if (unit?.move) return;
    const span = works.span(work!);
    if (works.beside(actor, span) && !this.aloft(actor)) { job.tries = 0; if (still && this.arm(actor.id)) this.settle(job, actor, parts); return; }
    if (job.tries! >= TRIES) { this.targets.set(work!.id, this.room.world.time + RETRY); this.home(job, actor, 'blocked-way'); return; }
    this.alongside(job, actor, span);
  }

  // A builder sent to a works (`build`) or to a structure being taken down (`dismantle`), and from that on to the works it is
  // moved to (`then`). Its leg is the squad's move like any other (`go`): `phase` is `go` until it stands within reach of
  // it, and `work` there — or `collect` first, on its way by the base, where it loads what it is to bring (`reserved`) —;
  // `reason` says why it waits to go, and `until` when it tries again a way that was shut.
  assign(actor: SceneActor, kind: 'build' | 'dismantle', targetId: string, then?: string | null, options?: Partial<Offer>): BuilderDispatchJob;
  assign(actor: SceneActor, kind: RoadPart, targetId: string, then: string | null, options: Offer): RoadDispatchJob;
  assign(actor: SceneActor, kind: 'build' | 'dismantle' | RoadPart, targetId: string, then: string | null = null, options: Partial<Offer> = {}): BuilderDispatchJob | RoadDispatchJob {
    const { phase = 'go', reserved = bill() } = options;
    this.cancel(actor.id); this.waits.delete(actor.id);
    const common = { ownerId: actor.ownerId!, factionId: actor.team!, targetId, then, phase, reason: '' as const, leg: null, until: -Infinity, reserved, source: null, tries: 0 };
    // A successful road offer owns its lane before the job is entered in the map.
    const job: BuilderDispatchJob | RoadDispatchJob = kind === 'grade' || kind === 'pave' ?
      { kind, ...common, lane: options.lane!, front: options.lane!.from, start: options.lane!.from, share: 1 } : { kind, ...common };
    this.jobs.set(actor.id, job); this.nextAt = -Infinity;
    return job;
  }
  // What a vehicle was sent to build, or nothing (field-construction.ts works on that alone).
  errand(id: string): BuilderDispatchJob | null { const job = this.jobs.get(id); return builds(job) ? job : null; }
  // The builder sent to a works or to a structure being taken down, as its faction is told it: on its way or there (`phase`),
  // and why it waits to go (`reason`); of a works a structure is moved to, that its builder takes that one down first. With
  // none, of a works, one with a builder bringing it what it lacks (`bringing`) is on its way.
  coming(id: string): { phase: DispatchPhase | 'dismantle'; reason: JobReason } | null {
    for (const job of this.jobs.values()) if (builds(job)) {
      if (job.targetId === id) return { phase: job.phase, reason: job.reason };
      if (job.then === id) return { phase: job.phase === 'load' ? 'go' : 'dismantle', reason: '' };
    }
    return this.bringing().has(id) ? { phase: 'go', reason: '' } : null;
  }
  // The works vehicles with a builder bring what they lack to (`work`): each puts up what it unloads there as it unloads it.
  bringing(): Set<string> { return new Set([...this.jobs].flatMap(([id, job]) => job.kind === 'work' && this.arm(id) ? [job.targetId] : [])); }
  // Whether a vehicle with a builder bringing a works what it lacks gets there within `seconds`: by the base first, while it
  // is on its way to load there.
  ahead(work: Work, seconds: number): boolean {
    for (const [id, job] of this.jobs) if (job.kind === 'work' && job.targetId === work.id && this.arm(id)) {
      const actor = this.room.world.actor(id), here = actor && this.room.position(actor), faction = this.room.factions.get(job.factionId),
        base = actor && faction?.base ? this.room.depot(faction, here!)!.x : undefined;
      if (!actor || job.phase === 'collect' && base === undefined) continue;
      const way = job.phase === 'collect' ? this.travel(actor, here!, base!) + this.travel(actor, base!, work.x) : this.travel(actor, here!, work.x);
      if (way <= seconds) return true;
    }
    return false;
  }
  // Where what a builder was sent to stands: a works with something left to put up, or a structure — as it stands — or a post
  // — over its ground — while it is taken down. Nothing once that is done or given up.
  span(job: BuilderDispatchJob): WorkSpan | null {
    const room = this.room;
    if (job.kind === 'dismantle') {
      const down = room.works.takedown(job.targetId);
      return !down ? null : down.post ? down.span : room.world.actorBounds(job.targetId);
    }
    const work = room.works.pending.get(job.targetId);
    return work?.factionId === job.factionId && work.progress < 1 - 1e-9 ? room.works.span(work!) : null;
  }
  // The fuel a builder needs for its way: the budget of the trip (`fuel`), or as much as its tanks take where that is less —
  // full, it goes, and is refuelled where its tanks run dry.
  budget(actor: SceneActor, seconds: number): number { return Math.min(this.fuel(actor, seconds), this.tanks(actor)); }
  // What the tanks of a vehicle take, full.
  tanks(actor: SceneActor): number { return actor.blueprint.modules.filter(piece => piece.kind === 'fuel').reduce((sum, piece) => sum + reserveState(piece).fuelLitres, 0); }

  // The heap a job loads now: the one a vehicle fetches for a works or for the base, or the one a builder left of what it
  // took down.
  gathering(job: DispatchJob): Heap | null {
    const heaps = this.room.works.heaps;
    return job.phase === 'load' ? heaps.get(job.targetId!) ?? null : job.phase === 'fetch' ? heaps.get((job.kind === 'heap' ? job.targetId : job.source)!) ?? null : null;
  }
  // Prefer a stop where the actual crane reaches the completed height, not just a stop beside it (`stop`): of a heap it
  // loads, the pile as the screens show it (cargo-art.ts); of a post, put up or taken down, its ground up to its eye, where
  // its flag flies (territory.ts).
  // Pending works have no actor yet. For dismantling, the shared plan only offers the side already occupied.
  parking(job: DispatchJob, actor: SceneActor): number | null {
    const world = this.room.world, pieces = (id: string) => [
      ...world.plates.filter(part => part.actorId === id && part.attached !== false).map(part => part.definition),
      ...world.modules.filter(part => part.actorId === id && part.attached !== false)
    ], heap = this.gathering(job), work = !heap && (job.kind === 'build' || job.kind === 'work') && this.room.works.pending.get(job.targetId),
      post = !heap && (work ? work.post && work : job.kind === 'dismantle' && this.room.works.takedown(job.targetId)?.post);
    let target;
    if (heap) {
      const { width, height } = pileSize(pileLook(heap.stock)), lo = heap.x - width / 2, hi = heap.x + width / 2;
      target = { lo, hi, down: false, boxes: [{ lo, hi, top: world.terrain.height(heap.x) + height }] };
    } else if (post) {
      const lo = post.x - POST_RADIUS, hi = post.x + POST_RADIUS;
      target = { lo, hi, down: false, boxes: [{ lo, hi, top: world.terrain.height(post.x) + POST_EYE }] };
    } else if (work) {
      const shape = workShape(compileStructuredConstruction(work.blueprint), world.terrain, work.x, work.facing);
      target = { lo: shape.minX, hi: shape.maxX, down: false, boxes: [{ lo: shape.minX, hi: shape.maxX, top: shape.maxY }] };
    } else {
      const boxes = boxesOf(pieces(job.targetId!));
      if (!boxes.length) return null;
      target = { lo: Math.min(...boxes.map(box => box.lo)), hi: Math.max(...boxes.map(box => box.hi)), down: true, boxes };
    }
    return craneParking(pieces(actor.id), target, at => world.terrain.height(at),
      { x: this.room.position(actor), arrival: aircraft(actor) ? ARRIVAL : LOADING_APPROACH, clearance: SITE_CLEARANCE });
  }
  // Beside what it works at, or by the heap it loads, a vehicle with a builder stops once more where its crane as installed
  // reaches it (`parking`): once for each, safe, able to drive there and with the fuel for it — but where another vehicle
  // of its side stands there or goes there (`go`), again at a later look. Whether it goes there. An aircraft takes off to
  // come down there, once, where it comes down off the place it went to (`ARRIVAL`) and the ground lets it.
  settle(job: DispatchJob, actor: SceneActor, parts: FieldParts): boolean {
    const here = this.room.position(actor), heap = this.gathering(job), at = heap ? 'heap:' + heap.id : job.targetId, air = aircraft(actor);
    if (job.parked === at || !this.safe(actor, this.room.players.get(job.ownerId)) || !this.drives(actor, parts)) return false;
    job.parked = at;
    const goal = this.parking(job, actor);
    if (goal === null || !(along(goal, here) > (air ? ARRIVAL : LOADING_APPROACH)) || actor.vehicle!.fuelLitres + 1e-6 < this.budget(actor, this.travel(actor, here, goal)) ||
      air && this.alight(job, actor, goal, goal, goal) === null) return false;
    if (this.go(job, actor, goal, LOADING_APPROACH)) return true;
    job.parked = null;
    return false;
  }
  // Where a vehicle stands beside a works, or a structure it takes down (`span`), to work at it (field-construction.ts): on
  // the side it comes from, or else on the other (`sides`, those it may stand on, the first first), with its end towards it
  // `clearance` off it — `SITE_CLEARANCE` — and the fine stop it is sent with (`LOADING_APPROACH`) more — and no further from
  // it than `reach` — `BUILD_REACH`. Of those places, the nearest it that no other vehicle of its side stands at or goes to
  // (Squad.clear); with none free, none: it waits for one outside (`outside`), and stands on no other there — or, not `strict`,
  // the nearest all the same, standing through whatever stands there. How far its ends reach of where it
  // stands is as it stands now (`exact`), or else either way, as it may come there turned about.
  // An aircraft, which does not turn about in the air, comes there as it faces now, no nearer either end of that than it
  // comes down off the place it is sent to (`ARRIVAL`), on ground it may come down on (Squad.landing); where none has any, it
  // is to come down nowhere there (`unlanded`).
  stop(job: DispatchJob, actor: SceneActor, span: WorkSpan, { exact = false, sides = null, clearance = SITE_CLEARANCE, reach = BUILD_REACH, strict = true }: StopOptions = {}): number | null {
    const room = this.room, squad = room.players.get(job.ownerId)!.squad!, here = room.position(actor), hull = room.works.hull(actor),
      air = aircraft(actor), margin = air ? ARRIVAL : LOADING_APPROACH,
      ends = [hull.maxX - here, here - hull.minX], from = Math.sign(here - (span.minX + span.maxX) / 2) || -1,
      places = (sides ?? [from, -from]).map(side => {
        const towards = exact || air ? [ends[side < 0 ? 0 : 1]!] : ends, edge = side < 0 ? span.minX : span.maxX;
        return { side, near: edge + side * (clearance + margin + Math.max(...towards)),
          far: edge + side * (reach - margin + Math.min(...towards)) };
      }),
      // Those that hold no place against it: itself, or, not `strict`, all of its side.
      placing = new Set(strict ? [actor.id] : [actor.id, ...squad!.side.roster.map(m => m.id)]);
    job.unlanded = air;
    for (const { side, near, far } of places) {
      if ((far - near) * side < 0) continue;
      const lo = Math.min(near, far), hi = Math.max(near, far),
        place = air ? squad.landing(actor.id, near, placing, { lo, hi, strict: true }) : squad.clear(actor.id, near, lo, hi, placing, true);
      if (air && squad.level(actor.id, lo, hi)) job.unlanded = false;
      if (place !== null) { delete job.unlanded; job.window = air ? { lo, hi } : null; return place; }
    }
    if (!job.unlanded) delete job.unlanded;
    return null;
  }
  // Where a vehicle waits for a place by a works, or by a structure it takes down, while none is free (`stop`): on the side
  // it comes from, out of reach of it — where it neither works at it nor unloads into it —, a vehicle of its own length and the
  // gap of its squad clear of the farthest place there, so that the one that goes in has it; and clear of those that wait
  // there before it (Squad.clear).
  outside(job: DispatchJob, actor: SceneActor, span: WorkSpan): number {
    const squad = this.room.players.get(job.ownerId)!.squad!, here = this.room.position(actor), hull = this.room.works.hull(actor),
      side = Math.sign(here - (span.minX + span.maxX) / 2) || -1, length = hull.maxX - hull.minX,
      near = (side < 0 ? span.minX : span.maxX) + side * (BUILD_REACH + 2 * length + GAP), lo = Math.min(near, near + side * QUEUE), hi = Math.max(near, near + side * QUEUE);
    return aircraft(actor) ? squad.landing(actor.id, near, new Set([actor.id]), { lo, hi }) : squad.clear(actor.id, near, lo, hi, new Set([actor.id]));
  }
  // Sends a vehicle to a place by a works (`stop`), or, with none free, to wait outside it for one (`queued`), saying so:
  // there it looks again, and goes in once one is free. Its turn waiting is no try of a way that may be shut. An aircraft with
  // no ground to come down on by it gives it up for a while (`unlanded`).
  approach(job: DispatchJob, actor: SceneActor, goal: number | null, span: WorkSpan): void {
    if (goal === null && job.unlanded) { this.unlanded(job, actor); return; }
    job.queued = goal === null;
    if (goal !== null) { job.reason = ''; this.place(job, actor, goal); return; }
    // It says it waits once it stands there: on its way, it is going to it.
    const wait = this.outside(job, actor, span), far = along(wait, this.room.position(actor)) > ARRIVAL;
    job.reason = far ? '' : 'waiting-place';
    if (far) this.go(job, actor, wait);
  }
  // Sends a vehicle to stand beside a works (`stop`), as it stands now once it was sent there before.
  alongside(job: DispatchJob, actor: SceneActor, span: WorkSpan): void { this.approach(job, actor, this.stop(job, actor, span, { exact: job.tries! > 0 }), span); }
  // A vehicle that waits outside a works for a place (`queued`) with something aboard the works lacks has one made for it: of
  // those of its side that stand beside it in automatic, one that brings it nothing of what it lacks — on no job, or sent to
  // put it up — steps out, to wait in its turn, and is free for another job (`aside`). One that would leave the works without
  // a builder stays, while the one waiting has none: a builder counts there only standing still on the ground beside it, as one
  // builds (`still`), and not one in the air over it.
  makeRoom(): void {
    const room = this.room, works = room.works;
    for (const [id, job] of this.jobs) {
      const work = job.queued && (job.kind === 'work' || job.kind === 'build') && works.pending.get(job.targetId), actor = work && room.world.actor(id);
      if (!actor || this.room.players.get(job.ownerId)?.squad!.units.get(id)?.move) continue;
      const need = works.need(work!), brings = (id: string) => { const aboard = this.stock(id); return STOCK_IDS.some(stock => need[stock] > 0 && aboard[stock] >= 1); };
      if (!brings(id)) continue;
      const span = works.span(work!), beside = room.world.actors.filter(other => other.id !== id && other.team === actor.team && works.beside(other, span)),
        builders = beside.filter(other => this.arm(other.id) && room.still(other)).length,
        idle = beside.filter(other => {
          const held = this.jobs.get(other.id);
          return this.manages(other.id) && !this.paused.has(other.id) && !this.ordered(other.id) && room.still(other) && !room.record(other).service &&
            (!held || held.kind === 'build' && held.targetId === work.id) && !brings(other.id);
        }),
        leaving = idle.find(other => this.arm(id) || !this.arm(other.id) || builders > 1);
      if (leaving) this.aside(leaving, span, work.id);
    }
  }
  // Whether a vehicle waits outside a works for a place by it (`approach`).
  queued(workId: string): boolean { return [...this.jobs.values()].some(job => job.queued && job.targetId === workId); }
  // Sends a vehicle out of its place by a works (`left`), to wait outside it (`outside`): on its way there, and once it stands
  // there, it is free for any job (`ready`) — on its way, but to put that works up with nothing for it.
  aside(actor: SceneActor, span: WorkSpan, left: string): void {
    this.cancel(actor.id); this.waits.delete(actor.id);
    const job: ReturningDispatchJob = { kind: null, ownerId: actor.ownerId!, factionId: actor.team!, targetId: null, phase: 'aside', reason: '', reserved: bill(), leg: null, source: null, left };
    this.jobs.set(actor.id, job);
    this.go(job, actor, this.outside(job, actor, span));
  }
  // Sends a vehicle to the very place `stop` chose, with the fine stop of loading: one more try (`TRIES`). An aircraft comes
  // down there, or anywhere of the stretch it chose it from (`window`, `go`).
  place(job: DispatchJob, actor: SceneActor, x: number): void {
    const squad = this.room.players.get(job.ownerId)!.squad!;
    job.tries!++;
    if (aircraft(actor)) { this.go(job, actor, x, null, job.window); return; }
    squad.command({ order: 'move', ids: [actor.id], x });
    const leg = squad.units.get(actor.id)?.move;
    if (leg) Object.assign(leg, { x, best: Math.abs(x - this.room.position(actor)), arrival: LOADING_APPROACH });
    job.leg = leg;
  }

  // A builder goes to what it was sent to as any vehicle goes, by its squad, and stops beside it (`alongside`), where its
  // crane reaches it if it can (`settle`). Without the fuel for the way it waits for some; a way that was shut it tries again
  // in a while. Beside it it works there (field-construction.ts), and once that is done goes on (`after`). One that can no longer
  // build, or drive there, or is no longer of the faction it was sent for, is sent no more; one whose faction holds where it was
  // sent dangerous now gives it up (`forgo`); and any other order to it is the player's (`off`).
  attend(job: BuilderDispatchJob, actor: SceneActor, parts: FieldParts): void {
    const room = this.room, time = room.world.time, owner = room.players.get(job.ownerId), unit = owner?.squad!.units.get(actor.id);
    if (actor.ownerId !== job.ownerId || owner?.factionId !== job.factionId || !this.fit(actor, parts)) { this.cancel(actor.id); return; }
    if (playerOrder(owner!.squad, actor.id, job)) { this.off(actor.id); return; }
    if (room.record(actor).service || this.fuelling(job, actor, unit)) return;
    const span = this.span(job), here = room.position(actor);
    if (!span) { this.after(job, actor, parts); return; }
    if (this.perilous(room.factions.get(job.factionId), span.minX, span.maxX)) { this.forgo(job, actor); return; }
    if (job.phase === 'collect' && !this.collect(job, actor, parts, span, unit)) return;
    // It works beside it on the ground: an aircraft beside it in the air, with nowhere it is sent, is sent down there.
    if (room.works.beside(actor, span) && !this.aloft(actor)) {
      job.tries = 0;
      // One that brings it nothing, come to stand where another of its side stands or goes, leaves that place to that one.
      const raised = job.kind === 'build' && room.works.pending.get(job.targetId);
      if (raised && !unit?.move && this.starved(raised, this.stock(actor.id)) &&
        owner!.squad!.clear(actor.id, here, here, here, new Set([actor.id]), true) === null) { this.aside(actor, span, raised.id); return; }
      if (!unit?.move && room.still(actor)) {
        if (this.settle(job, actor, parts)) { job.phase = 'go'; job.reason = ''; return; }
        Object.assign(job, { phase: 'work', reason: '' });
      }
      // At a works with nothing to put up, and nothing aboard of what it lacks, it waits for what other jobs bring it, and
      // says so (`waiting-material`); one with supply pieces is free to go and get what none of them brings (`wanted`), stock
      // by stock: what is on its way of another stock keeps nobody waiting for this one.
      const work = job.kind === 'build' && job.phase === 'work' && room.works.pending.get(job.targetId);
      if (work) {
        const waits = this.starved(work, this.stock(actor.id));
        if (waits && room.serving(actor.id).length && lacking(this.wanted(work!, actor.id))) { this.done(actor); return; }
        job.reason = waits ? 'waiting-material' : '';
      }
      return;
    }
    job.phase = 'go';
    if (this.waitForMove(job, actor, unit)) return;
    const halted = haltedReason(unit);
    if (!this.drives(actor, parts)) { this.cancel(actor.id); return; }
    if (job.tries! >= TRIES) { Object.assign(job, { reason: 'blocked-way', until: time + RETRY, tries: 0 }); return; }
    // A structure taken down is worked at from the side it is come to: a crane is never put across it.
    const sides = job.kind === 'dismantle' ? [Math.sign(here - (span.minX + span.maxX) / 2) || -1] : null,
      goal = this.stop(job, actor, span, { exact: job.tries! > 0, sides });
    if (actor.vehicle!.fuelLitres + 1e-6 < this.budget(actor, this.travel(actor, here, goal ?? this.outside(job, actor, span)))) { job.reason = 'waiting-fuel'; return; }
    if (halted) unit!.halt = unit!.reason = '';
    this.approach(job, actor, goal, span);
  }
  // Builders and road machines wait for the current leg, then for one retry
  // deadline. Confirmed physical stalls remain distinct from a delayed route.
  waitForMove(job: BuilderDispatchJob | RoadDispatchJob, actor: SceneActor, unit: SquadUnit | undefined): boolean {
    if (unit?.move) { job.reason = actor.vehicle!.fuelStarved ? 'waiting-fuel' : ''; return true; }
    const time = this.room.world.time;
    if (time < job.until) return true;
    const halted = haltedReason(unit);
    if (halted && job.reason !== halted) { Object.assign(job, { reason: halted, until: time + RETRY }); return true; }
    return false;
  }
  // Whether a works has nothing to put up till more of it comes, and a vehicle carries nothing of what it lacks (`aboard`).
  starved(work: Work, aboard: SupplyBill): boolean {
    const need = this.room.works.need(work!);
    return !(this.room.works.share(work) > work.progress + 1e-9) && !STOCK_IDS.some(id => need[id] > 0 && aboard[id] >= 1);
  }
  // A builder on its way by the base: there it fills its tank for the way out and back, and loads what the works it puts up
  // lacks that no other job brings it, as far as its supply pieces take it (`asked`); a paver, into the hoppers of its pavers
  // first and then into its supply pieces, the mix for what is left to pave of its road (`paving`), and with not even that in
  // the stocks it waits for some. Whether it goes on from there now.
  collect(job: BuilderDispatchJob | RoadDispatchJob, actor: SceneActor, parts: FieldParts, span: WorkSpan, unit: SquadUnit | undefined): boolean {
    const room = this.room, time = room.world.time, faction = room.factions.get(job.factionId);
    if (!faction?.base) { job.phase = 'go'; return true; }
    if (!(room.atDepot(faction, actor) && room.still(actor))) {
      if (unit?.move || time < job.until) return false;
      if (job.leg && !room.atDepot(faction, actor)) { Object.assign(job, { reason: 'blocked-way', until: time + RETRY, leg: null }); return false; }
      // An aircraft over it in the air, with nowhere it is sent, is sent down there.
      if (!job.leg || this.aloft(actor)) { job.reason = ''; this.depot(job, actor); }
      return false;
    }
    // A paver fills its tanks, for the way and for its lane.
    const fill = job.kind === 'pave' ? this.tanks(actor) : this.budget(actor, 2 * this.toward(actor, room.position(actor), span));
    if (!this.refuel(actor, parts, faction, fill)) { job.reason = 'waiting-fuel'; return false; }
    const work = job.kind === 'build' && room.works.pending.get(job.targetId), road = job.kind === 'pave' && room.roadworks.pending.get(job.targetId);
    if (work) this.stow(actor, faction, this.fits(this.asked(work!, faction, actor.id), this.capacity(actor)));
    if (road) {
      this.stow(actor, faction, this.paving(road, faction, actor), room.roadworks.mixers(actor));
      if (room.roadworks.aboard(actor) < this.least(actor, this.unpaved(road)) - 1e-6) { this.wait(actor.id, 'waiting-stock'); return false; }
    }
    Object.assign(job, { phase: 'go', reason: '', reserved: bill(), leg: null, until: -Infinity });
    return true;
  }
  // How many metres of asphalt a paver goes by the base for more short of the mix for: `LEAST_PAVING`, or `left`, what is left
  // for it to pave, or a twentieth of what its hoppers and supply pieces take (`LEAST_SHARE`), the least of them. A small one,
  // that does not take the mix of a metre, goes out with it all the same, and lays nearly all of it.
  least(actor: SceneActor, left: number): number { return Math.min(LEAST_PAVING, left, this.room.roadworks.holds(actor) * LEAST_SHARE); }
  // How many metres of a road are not of asphalt yet, graded or not.
  unpaved(road: RoadOrder): number { return road.x1 - road.x0 - spanned(stretches(this.room.field.roads, road.x0, road.x1, 'asphalt')); }
  // What a paver loads at the base for a road, with the hoppers of its pavers and its supply pieces emptied there (`refuel`):
  // the mix for what is left to pave of it, and a twentieth and a metre more, as far as they take it and the stocks have it:
  // each thing of it in the very share a metre takes, so that none of it is left over in a supply piece.
  paving(road: RoadOrder, faction: Faction, actor: SceneActor): SupplyBill {
    const stock = this.available(faction, actor.id),
      space = this.room.roadworks.holds(actor) - this.room.roadworks.aboard(actor),
      metres = Math.min(this.unpaved(road) * 1.05 + LEAST_PAVING, pavedBy(stock), Math.max(0, space));
    return bill(...STOCK_IDS.map(id => Math.min(PAVING[id] * metres, Math.floor(stock[id]))));
  }
  // How many metres a second the tools of a vehicle for a part of a road make together, at the full pace of its engines.
  rate(actor: SceneActor, part: RoadPart): number { return this.room.roadworks.rate(actor, part); }
  // The lanes the other machines on a part of a road are on, from what each has not laid of its lane yet to its end, as
  // [from, to] (Roadworks.unlaid): of those at work on theirs alone, `working`.
  claims(roadId: string, kind: RoadPart, except: string | null = null, working = false): RoadSpan[] {
    return [...this.jobs].flatMap(([id, job]) => id !== except && job.kind === kind && job.targetId === roadId && (!working || job.phase === 'work') ?
      [this.room.roadworks.unlaid(job)] : []);
  }
  // Where a road machine of a faction takes no lane of a road for a part, as [from, to]: the lanes others are on (`claims`), and
  // the ground its faction holds dangerous (`perils`).
  barred(roadId: string, kind: RoadPart, except: string | null, faction: Faction | undefined, working = false): RoadSpan[] { return [...this.claims(roadId, kind, except, working), ...this.perils(faction)]; }
  // A road machine on its lane of a road (road-works.ts): `phase` is `go` until it stands where it left off (`front`), `work`
  // as it drives along it — no faster than its tools work (`pace`, set at every look of the field by Roadworks.step) —, and
  // `collect` on its way by the base, where a paver loads what it paves with (`collect`); `reason` says why it waits to go,
  // and `until` when it tries again a way that was shut. Its lane done, it goes on with the lane beyond as it drives
  // (`onward`); else, or a paver's material spent — then it goes by the base and comes back —, what it did is laid
  // (`commit`), and it is given its next job from where it stands (`plan`). One on its way whose lane another went on into
  // takes the lane left nearest it instead. One whose faction holds what is left of its lane dangerous now gives it up
  // (`forgo`), and no lane it is given lies where its faction holds so (`barred`). One out of automatic, that can no longer
  // work, or is no longer of the faction, or whose road is done or given up, is free; and any other order to it is the player's
  // (`off`).
  roadwork(job: RoadDispatchJob, actor: SceneActor, parts: FieldParts): void {
    const room = this.room, time = room.world.time, owner = room.players.get(job.ownerId), unit = owner?.squad!.units.get(actor.id),
      road = room.roadworks.pending.get(job.targetId), faction = room.factions.get(job.factionId);
    if (!this.manages(actor.id) || actor.ownerId !== job.ownerId || owner?.factionId !== job.factionId || !road || room.record(actor).wreck ||
      !(this.rate(actor, job.kind) > 0)) { this.done(actor); return; }
    if (playerOrder(owner!.squad, actor.id, job)) { this.off(actor.id); return; }
    if (room.record(actor).service) return;
    if (this.perilous(faction, ...room.roadworks.unlaid(job))) { this.forgo(job, actor); return; }
    const here = room.position(actor);
    // One on its way to its lane — nothing of it done yet, or what it did laid — that one at work went on into (`beyond`):
    // it is sent afresh, from where it is, to the lane left nearest it now, and is free where none is left.
    if (job.phase !== 'work' && room.roadworks.crosses(job, this.claims(road.id, job.kind, actor.id, true))) {
      const lane = room.roadworks.lane(road, job.kind, this.departure(actor, job.phase === 'collect'), this.barred(road.id, job.kind, actor.id, faction));
      if (!lane) { this.done(actor); return; }
      if (unit?.move === job.leg) { unit!.move = null; owner!.squad!.release(actor.id); }
      Object.assign(job, { lane, front: lane.from, start: lane.from, reason: '', leg: null, until: -Infinity });
    }
    if (job.phase === 'collect') {
      if (!this.collect(job, actor, parts, laneSpan(job.lane), unit)) return;
      // Collection changed where an untouched lane is approached from; more ground may have become ready meanwhile.
      // A committed partial lane has start === front too, but its front is already beyond lane.from: resume it as it is.
      if (job.front === job.lane.from && job.start === job.lane.from) {
        const lane = room.roadworks.lane(road, job.kind, this.departure(actor), this.barred(road.id, job.kind, actor.id, faction));
        if (!lane) { this.done(actor); return; }
        Object.assign(job, { lane, front: lane.from, start: lane.from });
      }
    }
    const lane = job.lane;
    if (job.phase === 'work') {
      if ((lane.to - job.front) * lane.dir <= 1e-9 && !this.onward(job, actor, road)) { this.done(actor); return; }
      if (job.kind === 'pave' && room.roadworks.aboard(actor) - (job.front - job.start) * job.lane.dir < this.least(actor, (job.lane.to - job.front) * job.lane.dir) - 1e-6) {
        room.roadworks.commit(job, actor);
        if (unit?.move === job.leg) { unit!.move = null; owner!.squad!.release(actor.id); }
        Object.assign(job, { phase: 'collect', reason: '', leg: null, until: -Infinity });
        return;
      }
      if (unit?.move) { this.reaim(job, actor, road, unit.move); return; }
      // Its way along its lane shut, what it did is laid and it waits a while, saying why, and the road for it. A way that only
      // came no nearer holds it no longer then (`ready`): it is given its next job as any other, from where it stands. One its
      // core found it stuck on, or unable to drive, holds it till the player helps it.
      const halted = haltedReason(unit);
      if (halted) { this.targets.set(road.id, time + RETRY); this.wait(actor.id, halted); if (halted === 'blocked-way') unit!.halt = unit!.reason = ''; return; }
      this.along(job, actor, road);
      return;
    }
    if (Math.abs(room.roadworks.at(actor, job.kind, lane.dir) - job.front) <= RESUME && !unit?.move) {
      Object.assign(job, { phase: 'work', reason: '', leg: null });
      this.along(job, actor, road);
      return;
    }
    job.phase = 'go';
    if (this.waitForMove(job, actor, unit)) return;
    const halted = haltedReason(unit);
    if (!this.drives(actor, parts)) { this.cancel(actor.id); return; }
    // It goes to where its tools stand where it left off: sent past it by as much as counts as there (`ARRIVAL`), so that it
    // comes to a stop with them there.
    const start = room.roadworks.stand(actor, job.kind, lane.dir, job.front);
    if (actor.vehicle!.fuelLitres + 1e-6 < this.budget(actor, this.travel(actor, here, start))) { job.reason = 'waiting-fuel'; return; }
    if (halted) unit!.halt = unit!.reason = '';
    job.reason = ''; this.steer(job, actor, start + Math.sign(start - here) * ARRIVAL);
  }
  // A road machine at the end of its lane goes on with the lane beyond as it drives, where there is one for it (`beyond`),
  // at the very look it comes to that end (Roadworks.step) or at the next look of the dispatch: whether it did.
  onward(job: RoadDispatchJob, actor: SceneActor, road: RoadOrder): boolean {
    const leg = this.room.players.get(job.ownerId)?.squad!.units.get(actor.id)?.move, next = leg && leg === job.leg && this.beyond(job, actor, road);
    if (!next) return false;
    job.lane = next;
    this.reaim(job, actor, road, leg);
    return true;
  }
  // On its way along its lane it is sent as far as it goes on, as that changes: where its lane ends, or the lane beyond does.
  reaim(job: RoadDispatchJob, actor: SceneActor, road: RoadOrder, leg: SquadMove): void {
    const x = this.aim(job, actor, road);
    if (Math.abs(x - leg.x) > REAIM) Object.assign(leg, { x, best: Math.abs(x - this.room.position(actor)) });
  }
  // Sends a road machine along its lane at the pace of its tools (`aim`).
  along(job: RoadDispatchJob, actor: SceneActor, road: RoadOrder): void { this.steer(job, actor, this.aim(job, actor, road), this.rate(actor, job.kind) * job.share); }
  // Where a road machine on its lane is sent: to where its tools finish it, or the lane beyond it that it goes on with
  // (`beyond`), as far past that as it is sent to where it left off; it slows to a stop only where it stops.
  aim(job: RoadDispatchJob, actor: SceneActor, road: RoadOrder): number {
    const lane = job.lane;
    return this.room.roadworks.stand(actor, job.kind, lane.dir, (this.beyond(job, actor, road) ?? lane).to) + lane.dir * ARRIVAL;
  }
  // The lane a road machine goes on with where its own ends (Roadworks.beyond), that no other of its kind is at work on — one
  // still on its way to it, however far, takes another (`roadwork`) — and its faction does not hold dangerous (`barred`): a
  // paver only where the mix it carries paves the least of it once it has paved its own (`least`), as it would go out for that
  // from the base.
  beyond(job: RoadDispatchJob, actor: SceneActor, road: RoadOrder): RoadLane | null {
    const roadworks = this.room.roadworks,
      next = roadworks.beyond(road, job.kind, job.lane, this.barred(road.id, job.kind, actor.id, this.room.factions.get(job.factionId), true));
    if (!next || job.kind !== 'pave') return next;
    const spent = (job.lane.to - job.start) * job.lane.dir;
    return roadworks.aboard(actor) - spent >= this.least(actor, Math.abs(next.to - next.from)) - 1e-6 ? next : null;
  }
  // Sends a road machine to a place of its lane, by its squad as any vehicle goes, to that very place: along a lane it goes
  // through whatever stands there, as it would through any construction, and not beside it. On its lane it goes no faster
  // than `pace`. Its pilot takes it up at the next step (`hasten`): standing with nothing to do, it looked around seldom.
  steer(job: RoadDispatchJob, actor: SceneActor, x: number, pace?: number): void {
    const owner = this.room.players.get(job.ownerId)!, squad = owner.squad!;
    squad.command({ order: 'move', ids: [actor.id], x });
    const leg = squad.units.get(actor.id)?.move;
    if (leg) Object.assign(leg, { x, best: Math.abs(x - this.room.position(actor)) }, pace === undefined ? {} : { pace });
    job.leg = leg;
    this.room.hasten(owner);
  }
  // What a builder does once what it was sent to is done. One that took a structure down loads the heap it left there as far
  // as its supply pieces take it, the room loading it as it loads any heap (`task`), and no truck is sent for that heap
  // meanwhile (`claimed`); then, of a structure moved, it goes on to the works it is moved to, with that aboard. Done with all
  // of it — the heap all aboard, its pieces full, or it no longer standing by it out of combat —, it is free where it stands:
  // one in automatic is given its next job from there (`plan`), and any other stays where it is with what it loaded.
  after(job: BuilderDispatchJob, actor: SceneActor, parts: FieldParts): void {
    const room = this.room, heap = job.kind === 'dismantle' && room.works.heaps.get(job.targetId!),
      unit = room.players.get(job.ownerId)?.squad!.units.get(actor.id);
    // On its way to where its crane reaches the heap (`settle`), it loads it there. It goes there once (`parked`), and loads
    // it while it stands beside it (`SUPPLY_REACH` off its pile, Works.pile), as its crane reaches it from wherever it does.
    if (heap && job.phase === 'load' && job.leg && unit?.move === job.leg) return;
    const by = heap && room.works.gap(actor, room.works.pile(heap!)) <= SUPPLY_REACH;
    if (heap && this.spare(actor) && (by || job.parked !== 'heap:' + heap.id) && room.still(actor) && room.calm(actor)) {
      job.phase = 'load'; job.reason = ''; this.settle(job, actor, parts); return;
    }
    if (job.kind === 'dismantle' && job.then && room.works.pending.has(job.then)) {
      Object.assign(job, { kind: 'build', targetId: job.then, then: null, phase: 'go', reason: '', until: -Infinity, tries: 0 } satisfies
        Pick<BuilderDispatchJob, 'kind' | 'targetId' | 'then' | 'phase' | 'reason' | 'until' | 'tries'>);
      this.attend(job, actor, parts); return;
    }
    this.done(actor);
  }

  // Whether a vehicle in automatic is free for a job now: on none but its way home — or the way home of its haul (`homing`) —,
  // in nobody's hands, under no order of its squad nor service, standing still, in the air or on its way home, able to drive
  // and out of danger. An aircraft with no job in the air — hovering where an order of the player's left it, say — is free as
  // one standing: it flies to its next job from there, and comes down only where that has it work. In its base on no job it
  // carries nothing: what a job needs it loads there (`collect`). One away from the base short of the fuel for the way home
  // takes it from what it carries, if it can. What keeps it from a job it waits for (`wait`).
  ready(actor: SceneActor, faction: Faction, parts: FieldParts): boolean {
    const room = this.room, id = actor.id, owner = room.players.get(actor.ownerId!)!, unit = owner?.squad!.units.get(id), job = this.jobs.get(id),
      homing = this.homing(id);
    if (!this.manages(id) || job && job.phase !== 'return' && job.phase !== 'aside' && !homing) return false;
    const still = room.still(actor), atDepot = room.atDepot(faction, actor);
    if (!job && still && atDepot) this.unload(actor, faction);
    if (this.waits.get(id)?.until! > room.world.time || owner!.squad!.manual === id || room.record(actor).service) return false;
    if (unit?.attack || unit?.haul && !homing || unit?.counter || unit?.move && unit.move !== job?.leg && !homing || !job && !still && !this.aloft(actor)) return false;
    // An aircraft that lost a thruster the others do not make up for (Squad `steady`) is given nothing until it is mended,
    // and says so; one on its way home keeps going there.
    if (aircraft(actor) && !steady(room.world, id)) { if (!job) this.wait(id, 'mending', 0); return false; }
    const halted = haltedReason(unit);
    if (halted) { this.wait(id, halted); return false; }
    if (!this.drives(actor, parts)) { this.wait(id, 'immobile'); return false; }
    if (!this.safe(actor, owner)) { if (!job) this.wait(id, 'threat', 10); return false; }
    const home = this.homeward(actor, faction), carried = this.stock(id).combustivel;
    if (actor.vehicle!.fuelLitres < home && carried > 0)
      room.refill(actor, appraise(actor, parts), { supplier: actor, stock: bill(0, 0, 0, Math.min(Math.ceil(home - actor.vehicle!.fuelLitres), carried)) });
    return true;
  }
  // Whether a vehicle is on the way home of the haul of its job with nothing to send it there but its pile run out, or its site
  // gone (Squad.haul) — not an enemy, a loader that does not reach it, a way shut, nor a pile it left with room to spare —:
  // free for what it passes on its way home (`plan`), and for nothing else.
  homing(id: string): boolean {
    const job = this.jobs.get(id)!, haul = job?.kind === 'haul' ? job.haul : null,
      unit = haul && this.room.players.get(job.ownerId)?.squad!.units.get(id);
    return Boolean(unit && unit.haul === haul && haul.phase === 'home' && !haul.fled && !haul.interrupted && !haul.blocked &&
      !this.readyPiles(this.room.factions.get(job.factionId)!).some(site => site.id === job.targetId));
  }
  // The fuel a vehicle needs to come into the nearest place of its faction where it is served, from where it stands.
  homeward(actor: SceneActor, faction: Faction): number {
    const here = this.room.position(actor), place = this.room.depot(faction, here)!;
    return this.fuel(actor, this.toward(actor, here, { minX: place.x - place.radius, maxX: place.x + place.radius }));
  }
  // A vehicle as the plan reckons with it: where it stands, whether in a place of its faction where it is served and the
  // nearest of them (`atDepot`, `depot`), the fuel it has and needs to come home, what it carries and has
  // room for — whether that is anything to take home, raw material or a whole unit of a stock or more (`carries`), and whether
  // a load (`loaded`, `LOAD_SHARE`) —, which jobs it does — of a road, the parts its tools do (`road`), none for an aircraft —, and whether it is on the
  // way home of its haul (`homing`) from a pile (`left`).
  crewman(actor: SceneActor, parts: FieldParts = fieldParts(this.room.world)): Crewman {
    const room = this.room, faction = room.factions.get(actor.team!)!,
      road: RoadPart[] = aircraft(actor) ? [] : (['grade', 'pave'] as const).filter(part => this.rate(actor, part) > 0),
      aboard = this.stock(actor.id), raw = carriedBy(room.pieces(actor.id)).carried, homing = this.homing(actor.id),
      holds = [...room.pieces(actor.id), ...room.serving(actor.id)], fill = holds.reduce((sum, piece) => sum + cargoVolume(piece), 0) /
        Math.max(1e-9, holds.reduce((sum, piece) => sum + cargoRoom(piece), 0));
    return { actor, id: actor.id, here: room.position(actor), atDepot: Boolean(room.atDepot(faction, actor)),
      depot: faction?.base ? room.depot(faction, room.position(actor))!.x : null, fuel: actor.vehicle!.fuelLitres,
      home: faction?.base ? this.homeward(actor, faction) : 0, aboard, crates: room.serving(actor.id).length > 0, arm: this.fit(actor, parts),
      road: road.length ? road : null, carrier: this.carrier(actor.id), raw, carries: loadTotal(raw) > 1e-6 || STOCK_IDS.some(stock => aboard[stock] >= 1),
      loaded: fill >= LOAD_SHARE, homing, left: homing ? this.jobs.get(actor.id)!.targetId : null };
  }

  // What a faction has for its vehicles to do now: each vehicle of it that runs low out of its base, still and out of combat
  // (`rearm`), or with payable damage and free for automatic mending (`repair`); each works that lacks something no job
  // brings it (`work`) — one moved from a structure still being taken down
  // for it waits for its heap, and one whose heap is loaded by another, for that one — and each with something left to put up
  // (`build`) that no builder is sent to or tends; each structure being taken down that no builder is sent to or tends
  // (`dismantle`) — one in automatic standing there with no job tends nothing: that is the job to give it —; each road with
  // ground left to grade (`grade`), or to pave (`pave`), that machines are not on all of; and each heap no
  // works waits for and nothing loads or is sent to (`heap`). A job tried and given up waits a while (`targets`). Each says
  // what it weighs: its kind (`PRIORITY`), and a point more for every `AGING` seconds it waited; and one whose place its
  // faction holds dangerous says so (`danger`, `hazard`): it is listed still, and given to nobody while that lasts (`offer`).
  demands(faction: Faction, parts: FieldParts): { list: Demand[]; reason: JobReason } {
    const room = this.room, works = room.works, time = room.world.time, list: Demand[] = [], listed = new Set<string>(),
      claimed = this.claimed(), sent = new Set([...this.jobs.values()].filter(builds).flatMap(job => [job.targetId, job.then])),
      tending = (actorId: string) => !this.manages(actorId) || Boolean(this.jobs.get(actorId)?.kind),
      tended = (id: string) => sent.has(id) || [...works.builders.get(id) ?? [], ...works.idle.get(id) ?? []].some(tending), loaded = this.loaded(faction);
    const add = (input: Candidate<Demand>): void => {
      const { kind, id } = input;
      const key = `${kind}:${id}`, since = this.since.get(key)?.at ?? time;
      this.since.set(key, { factionId: faction.id, at: since }); listed.add(key);
      list.push({ ...input, key, weight: PRIORITY[kind] + (time - since) / AGING });
    };
    for (const target of room.fleet(faction)) {
      if (claimed.has(target.id) || this.targets.has(target.id) || room.atDepot(faction, target) || this.target(target, { factionId: faction.id, targetX: room.position(target) })) continue;
      const quote = appraise(target, parts);
      if (this.need(target, parts, quote)) add({ kind: 'rearm', id: target.id, x: room.position(target), target, quote });
      else if (billTotal(quote.repair) && room.canMend(room.players.get(target.ownerId!), target))
        add({ kind: 'repair', id: target.id, x: room.position(target), target, quote });
    }
    let reason: JobReason = '';
    for (const work of works.of(faction.id)) {
      if (this.awaits(work)) { if (billTotal(works.need(work!))) reason ||= 'waiting-dismantle'; continue; }
      if (!this.targets.has(work.id) && lacking(this.wanted(work))) {
        const heap = this.source(work);
        if (!heap || !claimed.has(heap.id) && !loaded(heap)) add({ kind: 'work', id: work.id, x: work.x, work, heap, shared: !heap });
      }
      if (work.progress < 1 - 1e-9 && !tended(work.id)) add({ kind: 'build', id: work.id, x: work.x, work, span: works.span(work!) });
    }
    // A road with natural ground left to grade, or graded earth left to pave into asphalt, that no machine of its kind is on
    // all of: one with all of it made meanwhile — by whoever made it — is done with.
    for (const road of room.roadworks.of(faction.id)) {
      if (room.roadworks.done(road)) { room.roadworks.pending.delete(road.id); continue; }
      if (this.targets.has(road.id)) continue;
      for (const part of road.kind === 'asphalt' ? ['grade', 'pave'] as const : ['grade'] as const) {
        const free = room.roadworks.left(road, part).some(([a, b]) => !this.claims(road.id, part).some(([from, to]) => from <= a && to >= b));
        if (free) add({ kind: part, id: road.id, x: (road.x0 + road.x1) / 2, road, shared: true });
      }
    }
    for (const down of works.takedowns()) if (down.team === faction.id && !tended(down.id))
      add({ kind: 'dismantle', id: down.id, x: down.x, span: down.post ? down.span : room.world.actorBounds(down.id), service: down.service });
    const awaited = new Set(works.of(faction.id).flatMap(work => work.from ? [work.from] : []));
    for (const heap of works.heapsOf(faction.id))
      if (!awaited.has(heap.id) && !claimed.has(heap.id) && !loaded(heap) && !this.targets.has(heap.id)) add({ kind: 'heap', id: heap.id, x: heap.x, heap });
    // One automatic trip per ready site; a manual haul of our faction already committed there takes precedence, and so does
    // what loads there — but a vehicle in automatic on no job, which is given its next one now: what it took on there as an
    // order of the player's left it there commits it to nothing.
    const hauling = new Set(room.fleet(faction).flatMap(actor => {
      const haul = room.players.get(actor.ownerId!)?.squad!.units.get(actor.id)?.haul, job = this.jobs.get(actor.id);
      if (job?.haul === haul && job?.kind === 'haul' && !outwardHaul(job) || !job && this.manages(actor.id)) return [];
      return [haul?.depositId, room.record(actor).loading].filter(Boolean);
    }));
    for (const site of this.readyPiles(faction))
      if (!claimed.has(site.id) && !hauling.has(site.id) && !this.targets.has(site.id)) add({ kind: 'haul', id: site.id, x: site.x, site });
    for (const [key, { factionId }] of this.since) if (factionId === faction.id && !listed.has(key)) this.since.delete(key);
    for (const demand of list) if (this.hazard(faction, demand)) demand.danger = true;
    return { list, reason };
  }
  // Whether a heap of the faction is being loaded by what stands by it out of automatic, or held by an order of the player's: a
  // construction of the faction in action with supply pieces that serve and have room, still and out of combat within reach of
  // it (`SUPPLY_REACH` off its pile, Works.pile), which the room loads there (`Works.attend`).
  loaded(faction: Faction): (heap: Heap) => boolean {
    const room = this.room, works = room.works, heaps = works.heapsOf(faction.id), near = new Set(), out = heaps.length ? room.outOfAction() : null,
      piles = heaps.map(heap => ({ id: heap.id, span: works.pile(heap) }));
    for (const actor of heaps.length ? room.world.actors : []) {
      const record = room.records.get(actor.id);
      if (actor.team !== faction.id || record?.auto && !this.paused.has(actor.id) || this.jobs.has(actor.id)) continue;
      if (record && !record.wreck && !record.service && !out![actor.id] && room.players.has(actor.ownerId!) && room.still(actor) && room.calm(actor) && this.spare(actor))
        for (const pile of piles) if (works.gap(actor, pile.span) <= SUPPLY_REACH) near.add(pile.id);
    }
    return (heap: Heap) => near.has(heap.id);
  }
  // What jobs under way go to, including every funded recipient of a rearm load, and the heaps builders load.
  claimed(except: string | null = null): Set<string | null> {
    return new Set([...this.jobs].filter(([id, job]) => id !== except && (builds(job) ? job.phase === 'load' : job.phase !== 'return') &&
      (job.kind !== 'haul' || outwardHaul(job)))
      .flatMap(([, job]) => [...job.kind === 'rearm' ? job.targetIds! : job.kind === 'work' ? job.source ? [job.source] : [] : [job.targetId],
        ...(job.after ?? []).flatMap(stop => stop.kind === 'work' ? [] : stop.targetIds)]));
  }

  // Whether a pile or a heap at `x` pays a vehicle that takes a load home for going by there (`offer`), and the seconds that
  // adds to its way home if so: its stop, the loading of what it has room for (`moved`), and the way by there less the way
  // straight home. It pays while that way off its way is no longer than the share that is of what it would take there empty
  // (`full`) of a trip of its own there from the base and back: on its way it takes on even a little; off it, the more the
  // farther. Nothing where its tank would not see it home by there.
  passing(man: Crewman, x: number, moved: number, full: number, faction: Faction): number | '' {
    const { actor, here, fuel } = man, go = (from: number, to: number) => this.travel(actor, from, to), back = this.homeFrom(actor, faction, x), loading = moved / TRANSFER_RATE,
      off = Math.max(0, go(here, x) + back - this.homeFrom(actor, faction, here));
    if (!(moved > 1e-6 && full > 0) || fuel < this.fuel(actor, go(here, x) + back + loading)) return '';
    return off <= moved / full * 2 * back ? off + HANDLING + loading : '';
  }

  // What a job would take a vehicle (`crewman`), as a plan of how it goes — its first leg (`phase`) and what it loads for it at
  // the base (`reserved`) — and the time it would take it (`seconds`): its way to where the job begins, by the base where it
  // loads or fills its tank there, and the job itself; of a pile or a heap one taking a load home takes on by the way, only
  // what that adds to its way home (`passing`). Refused, by why it cannot do it now (`waiting-stock`, `waiting-fuel`), or by
  // nothing when there is nothing in it for that one. A job its faction holds dangerous is refused for that (`DANGER`, `hazard`):
  // of a road, all that is left of it for a machine lying where its faction holds so (`barred`).
  // Pair ranking appraises only its anchor. The chosen rearm pair expands to neighbouring deficits once it is assigned.
  offer(man: Crewman, demand: Demand, faction: Faction, parts: FieldParts, group = false): Offer | JobReason {
    const { actor, here, fuel, home, aboard } = man, base = man.depot!, way = (seconds: number) => seconds + HANDLING,
      go = (from: number, to: number) => this.travel(actor, from, to), back = (x: number) => this.homeFrom(actor, faction, x);
    if (demand.danger) return DANGER;
    // To where it begins by the base, from where it stands.
    const by = (x: number) => go(here, base) + go(base, x);
    // An aircraft goes only where its tanks full take it from home and back (`OUT_OF_RANGE`): its pilot turns it home for its
    // fuel on its way short of that (Squad.homeward).
    if (aircraft(actor) && this.fuel(actor, 2 * back(demand.x)) > this.tanks(actor)) return OUT_OF_RANGE;
    if (demand.kind === 'haul') {
      const site = demand.site, moved = Math.min(site.supplies ? billTotal(site.supplies) : site.stock, this.transportSpace(actor, site));
      if (!(moved > 1e-6) || !workArea(this.room.world, actor.id, site, LOAD_REACH, { dig: false, stock: moved })) return '';
      // One that takes a load home takes on a pile by the way as it pays for that (`passing`): raw material in its hoppers and
      // cisterns, refined in its supply pieces, as far as each takes it (`transportSpace`).
      if (man.loaded) {
        const seconds = this.passing(man, site.x, moved, this.emptySpace(actor, site), faction);
        return seconds === '' ? '' : { phase: 'fetch', reserved: bill(), seconds, passing: site.supplies ? 'supplies' : site.material };
      }
      const handling = moved / TRANSFER_RATE, away = back(site.x);
      if (fuel >= this.fuel(actor, go(here, site.x) + away + handling))
        return { phase: 'fetch', reserved: bill(), seconds: way(go(here, site.x) + away) + handling };
      const trip = this.fuel(actor, 2 * away + handling), needed = Math.ceil(Math.max(0, trip + home - fuel)),
        tanks = actor.blueprint.modules.filter(piece => piece.kind === 'fuel').reduce((sum, piece) => sum + reserveState(piece).fuelLitres, 0);
      if (fuel < home || tanks < trip || this.available(faction).combustivel < needed) return 'waiting-fuel';
      return { phase: 'collect', reserved: bill(0, 0, 0, needed), seconds: way(by(site.x) + away) + handling };
    }
    if (demand.kind === 'rearm' || demand.kind === 'repair') {
      const { target, quote } = demand, repairing = demand.kind === 'repair', x = this.room.position(target), away = back(x),
        direct = repairing ? this.repairPayload(quote, aboard, { mass: Infinity, volume: Infinity }) : resupply(target.blueprint, quote, aboard).cost;
      if (billTotal(direct) > 0 && fuel >= this.fuel(actor, go(here, x) + away))
        return { phase: 'deliver', reserved: bill(), targetIds: !repairing && group ? this.rearmLoad(actor, target, quote, faction, parts, aboard).targetIds : [target.id], seconds: way(go(here, x)) };
      const trip = this.fuel(actor, 2 * away), needed = Math.ceil(Math.max(0, trip + home - fuel)), available = positive(billSum(this.available(faction), aboard)),
        stock = { ...available, combustivel: Math.max(0, available.combustivel - needed) },
        payload = repairing ? this.repairPayload(quote, stock, this.capacity(actor)) : this.payload(target, quote, stock, this.capacity(actor)),
        tanks = actor.blueprint.modules.filter(piece => piece.kind === 'fuel').reduce((sum, piece) => sum + reserveState(piece).fuelLitres, 0);
      if (tanks < trip || available.combustivel < needed || fuel < home) return 'waiting-fuel';
      if (!billTotal(payload)) return this.scant(target, quote, stock, repairing);
      const load = !repairing && group && man.atDepot ? this.rearmLoad(actor, target, quote, faction, parts, stock) : { payload, targetIds: [target.id] };
      return { phase: 'collect', reserved: positive(billSum(billSum(load.payload, bill(0, 0, 0, needed)), aboard, -1)), targetIds: load.targetIds, seconds: way(by(x)) };
    }
    if (demand.kind === 'heap' || demand.kind === 'work' && demand.heap) {
      const heap = demand.heap!, work = demand.work, on = work ? go(heap.x, work.x) : 0, away = back(work?.x ?? heap.x),
        moved = billTotal(this.fits(heap.stock, this.capacity(actor))), handled = moved / TRANSFER_RATE * (work ? 2 : 1);
      if (!moved) return '';
      // One that takes a load home already takes a heap by its way as one of its piles (`passing`), in the room its supply
      // pieces have left of what they would take empty; one off its way it goes on to from where it stands, as to any heap,
      // but on the way home of its haul.
      if (!work && man.loaded) {
        const empty = this.capacity(actor), seconds = this.passing(man, heap.x, Math.min(billTotal(heap.stock), this.holding(heap.stock, this.spareCapacity(actor))),
          this.holding(heap.stock, { ...empty, mass: empty.mass + this.room.pieces(actor.id).reduce((sum, piece) => sum + cargoMass(piece), 0) }), faction);
        if (seconds) return { phase: 'fetch', reserved: bill(), seconds, passing: 'supplies' };
        if (man.homing) return '';
      }
      if (this.spare(actor) && fuel >= this.fuel(actor, go(here, heap.x) + on + away)) return { phase: 'fetch', reserved: bill(), seconds: way(go(here, heap.x) + on + (work ? 0 : away)) + handled };
      if (fuel < home) return 'waiting-fuel';
      return { phase: 'collect', reserved: bill(), seconds: way(by(heap.x) + on + (work ? 0 : away)) + handled };
    }
    if (demand.kind === 'work') {
      const work = demand.work, wanted = this.wanted(work), x = work.x;
      if (!lacking(wanted)) return '';
      const brought = STOCK_IDS.reduce((sum, id) => sum + Math.min(wanted[id], aboard[id] >= 1 ? aboard[id] : 0), 0);
      if (brought > 0 && fuel >= this.fuel(actor, go(here, x) + back(x))) return { phase: 'deliver', reserved: bill(), seconds: way(go(here, x)) + brought / TRANSFER_RATE };
      const available = this.available(faction);
      if (!STOCK_IDS.some(id => wanted[id] > 0 && available[id] >= 1)) return 'waiting-stock';
      const asked = this.asked(work, faction), planned = this.fits(asked, this.capacity(actor));
      // The stocks have some of what it lacks, and not a unit of that fits aboard.
      if (!billTotal(planned)) return billTotal(asked) ? 'no-room' : 'waiting-stock';
      if (fuel < home) return 'waiting-fuel';
      return { phase: 'collect', reserved: planned, seconds: way(by(x)) + billTotal(planned) / TRANSFER_RATE };
    }
    // A road machine, to its lane of a road (road-works.ts `lane`), the nearest of what is left of its part there out of where
    // others are on and where its faction holds dangerous (`barred`), which it says where that is all that is left: by the base
    // where it is short of the fuel for the way, and a paver short of the mix for its lane aboard besides — none in the
    // stocks either, it waits. It takes the lane at the pace of its tools.
    if (roadwork(demand)) {
      const rate = man.road?.includes(demand.kind) ? this.rate(actor, demand.kind) : 0,
        claims = this.barred(demand.road.id, demand.kind, actor.id, faction);
      let lane = rate > 0 && this.room.roadworks.lane(demand.road, demand.kind, here, claims);
      if (!lane) return rate > 0 && this.room.roadworks.lane(demand.road, demand.kind, here, this.claims(demand.road.id, demand.kind, actor.id)) ? DANGER : '';
      let span = laneSpan(lane);
      const short = fuel + 1e-6 < this.budget(actor, this.toward(actor, here, span)),
        aboard = demand.kind === 'pave' ? this.room.roadworks.aboard(actor) : Infinity,
        via = short || aboard < this.least(actor, span.maxX - span.minX) - 1e-6, from = this.departure(actor, via);
      if (via) {
        lane = this.room.roadworks.lane(demand.road, demand.kind, from, claims);
        if (!lane) return '';
        span = laneSpan(lane);
      }
      const least = this.least(actor, span.maxX - span.minX);
      if (aboard < least - 1e-6 && pavedBy(this.available(faction)) < least - 1e-6) return 'waiting-stock';
      if (via && fuel < home) return 'waiting-fuel';
      return { phase: via ? 'collect' : 'go', reserved: bill(), lane,
        seconds: way((via ? go(here, from) : 0) + this.toward(actor, from, span)) + (span.maxX - span.minX) / rate };
    }
    // A builder: to put up a works, with what it carries of what that lacks and what it may load for it on its way by the base,
    // or to take a structure down. It goes by the base where it stands in it or the base lies on its way, to load there, and
    // where it is short of the fuel for the way. A works with nothing to put up waits, but for what it brings or loads for it,
    // or all it lacks being on its way there: as the builder beside it waits (`attend`).
    const { span } = demand, middle = (span.minX + span.maxX) / 2, pace = this.pace(actor, parts), work = demand.kind === 'build' ? demand.work : null,
      passes = man.atDepot || (here - base) * (middle - base) < 0,
      reserved = work && man.crates && passes ? this.fits(this.asked(work, faction), this.capacity(actor)) : bill(),
      short = fuel + 1e-6 < this.budget(actor, this.toward(actor, here, span));
    if (work && this.starved(work, aboard) && lacking(this.wanted(work)) && !billTotal(reserved)) return '';
    // Nor goes one with nothing for it, to wait there, where a vehicle with a builder bringing what it lacks gets first: that
    // one puts it up as it unloads it.
    if (work && this.starved(work, aboard) && !billTotal(reserved) && this.ahead(work, this.toward(actor, here, span))) return '';
    // Nor to a works where one that brings what it lacks waits outside for a place: that one puts it up as it unloads, and this
    // one would take its place.
    if (work && this.starved(work, aboard) && !billTotal(reserved) && (this.queued(work.id) || this.jobs.get(actor.id)?.left === work.id)) return '';
    if (short && fuel < home) return 'waiting-fuel';
    const left = work ? work.seconds * Math.max(0, 1 - work.progress) : demand.service!.seconds * Math.max(0, 1 - demand.service!.progress),
      via = billTotal(reserved) > 0 || short;
    return { phase: via ? 'collect' : 'go', reserved, seconds: way(via ? go(here, base) + this.toward(actor, base, span) : this.toward(actor, here, span)) + left / Math.max(1e-6, pace) };
  }

  // Gives a vehicle a job as its offer says (`offer`), and sets it on its way.
  start(man: Crewman, demand: Demand, offer: Offer, faction: Faction, parts: FieldParts): void {
    const room = this.room, actor = man.actor;
    if (builds(demand)) {
      this.attend(this.assign(actor, demand.kind, demand.id, demand.service?.to ?? null, offer), actor, parts);
      return;
    }
    if (roadwork(demand)) {
      const job = this.assign(actor, demand.kind, demand.id, null, offer);
      Object.assign(job, { lane: offer.lane!, front: offer.lane!.from, start: offer.lane!.from, share: 1 });
      this.roadwork(job, actor, parts);
      return;
    }
    this.cancel(actor.id); this.waits.delete(actor.id);
    const job: SupplyDispatchJob = { kind: demand.kind, ownerId: actor.ownerId!, factionId: faction.id, targetId: demand.id, targetX: demand.x, phase: offer.phase, reason: '', leg: null,
      reserved: offer.reserved, source: demand.kind === 'work' && demand.heap ? demand.heap.id : null, tries: 0,
      ...(demand.kind === 'rearm' ? { targetIds: offer.targetIds! } : {}), ...(offer.passing ? { passing: offer.passing } : {}) };
    this.jobs.set(actor.id, job);
    if (job.kind === 'haul' && job.phase === 'fetch') this.beginTransport(job, actor);
    else if (job.phase === 'deliver') { if (job.kind === 'work') this.alongside(job, actor, room.works.span(demand.work!)); else this.nextTo(job, actor, demand.target!); }
    else if (job.phase === 'fetch') this.atHeap(job, actor, demand.heap!);
    else if (room.atDepot(faction, actor) && room.still(actor)) this.advance(job, actor, parts);
    else this.depot(job, actor);
  }

  // A vehicle in automatic given no job: one that carries something — a whole unit of a stock or more —, or a supply vehicle with
  // no builder, goes home — in its base it waits there with nothing aboard —, and a builder or a road machine with nothing aboard
  // stays where it is; so does a road machine while its faction has a road to make, and one short of the fuel for the way home.
  // Either says why it has nothing to do, if anything says so (`refused`), and of what: of the jobs it was refused, the
  // nearest it. A paver with nothing to pave, while a road of asphalt is still to be graded, says it waits for that.
  // An aircraft goes home whatever it is and whatever fuel it has, to wait there with its tanks filled: the next job takes it
  // there and back from home (`offer`), and a builder left short of what that reckons by the works it put up would wait
  // there for fuel no vehicle brings it while its tanks are not low (`need`). Its pilot sees to the fuel of its way home. One
  // in the air over its base or post comes down there: hovering, it would burn its fuel for nothing — but one an order of the
  // player's left in the air (`hovering`), which hovers there as it was left, wherever that is, till a job takes it.
  idle(man: Crewman, faction: Faction, refused: Refusal): void {
    const id = man.id, job = this.jobs.get(id), roads = Boolean(man.road) && this.room.roadworks.of(faction.id).length > 0,
      aloft = this.aloft(man.actor);
    let { reason, targetId } = refused;
    if (job) return;
    if (man.road?.includes('pave') && this.room.roadworks.awaits(faction.id)) { reason = 'waiting-grade'; targetId = null; }
    if (!this.hovering.has(id) && (aloft || !man.atDepot && (aircraft(man.actor) || man.fuel >= man.home && !roads && (man.carries || !man.arm && !man.road)))) {
      const trip: ReturningDispatchJob = { kind: null, ownerId: man.actor.ownerId!, factionId: faction.id, targetId: null, phase: 'return', reason: '', reserved: bill(), leg: null, source: null };
      this.jobs.set(id, trip); this.home(trip, man.actor, reason);
      return;
    }
    this.waits.set(id, !man.atDepot && man.fuel < man.home ? { until: -Infinity, reason: 'waiting-fuel', targetId: null } : { until: -Infinity, reason, targetId });
  }

  // The jobs of each faction on the field (`demands`) given out to its vehicles in automatic that are free for one (`ready`): a
  // vehicle and a job it does are worth the weight of the job over the time it would take it (`offer`), and the best of them
  // go first, each vehicle to one job and each job to one vehicle — but a works that lacks more than a load: that one is offered
  // again for what it still lacks, and a road, to any machine for a lane of its own. Builders are given what only a builder
  // does first — one with supply pieces and nothing aboard that a works lacks, by the same worth, a service to the fleet that
  // no other vehicle with supply pieces is free to take instead (`unserved`): a fleet out of rounds does not wait for every
  // works to stand, nor a works all but up for a little repair far off —, then road machines what only they do, and then any
  // other vehicle with supply pieces what those do: a road machine makes roads and nothing else — but one with a builder and
  // supply pieces brings works what they lack, last: else one off the way of its base would leave its works waiting for ever.
  // Whoever is given nothing goes home or stays (`idle`). Nothing is given out for a faction nobody is on the field for
  // (SharedRoom.recall): its vehicles only go home, or stay.
  plan(crew: SceneActor[], parts: FieldParts): void {
    for (const faction of this.room.factions.values()) {
      const ours = faction.base ? crew.filter(actor => actor.team === faction.id) : [];
      if (!ours.length) continue;
      if (faction.away !== null) for (const [key, { factionId }] of this.since) if (factionId === faction.id) this.since.delete(key);
      const { list, reason } = faction.away === null ? this.demands(faction, parts) : { list: [], reason: '' as const },
        free = ours.filter(actor => this.ready(actor, faction, parts)).map(actor => this.crewman(actor, parts));
      if (!free.length) continue;
      // The services to the fleet no free vehicle with supply pieces and no builder takes now (`unserved`), and whether a vehicle
      // carries something a works of the faction lacks: that goes there, and to nobody else (`giving`).
      const reasons = new Map<string, Refusal & { far: number }>(), given = new Set<string>(), suppliers = free.filter(man => man.crates && !man.arm && !man.homing && !roadMachine(man.actor)),
        unserved = new Set(list.filter(demand => SERVICES.has(demand.kind) &&
          !suppliers.some(man => man.id !== demand.id && typeof this.offer(man, demand, faction, parts) === 'object'))),
        bound = (man: Crewman) => this.room.works.of(faction.id).some(work => {
          const need = this.room.works.need(work!);
          return STOCK_IDS.some(id => need[id] > 0 && man.aboard[id] >= 1);
        });
      const passes: readonly [((man: Crewman) => unknown), readonly JobKind[], boolean?][] = [[man => man.arm, ['build', 'dismantle'], true], [man => man.road, ['grade', 'pave']],
        [man => (man.crates || man.carrier) && !roadMachine(man.actor), ['rearm', 'repair', 'work', 'heap', 'haul']],
        [man => man.arm && man.crates && roadMachine(man.actor), ['work']]];
      for (const [able, kinds, serving] of passes) {
        const pairs: { man: Crewman; demand: Demand; offer: Offer; worth: number }[] = [], filled = new Set<Demand>();
        for (const man of free) if (!given.has(man.id) && able(man)) for (const demand of list) {
          const serves = serving && man.crates && !roadMachine(man.actor) && unserved.has(demand) && !bound(man);
          if (!kinds.includes(demand.kind) && !serves || demand.id === man.id || ['rearm', 'repair', 'work', 'heap'].includes(demand.kind) && !man.crates) continue;
          // On the way home of its haul, only what it may take on by the way, and not again the pile it has just left.
          if (man.homing && (!PICKUPS.has(demand.kind) || demand.id === man.left)) continue;
          const offer = this.offer(man, demand, faction, parts), far = Math.abs(demand.x - man.here);
          if (typeof offer === 'string') { if (offer && !(reasons.get(man.id)?.far! <= far)) reasons.set(man.id, { reason: offer, targetId: demand.id, far }); continue; }
          pairs.push({ man, demand, offer, worth: demand.weight / offer.seconds });
        }
        pairs.sort((a, b) => b.worth - a.worth);
        for (const { man, demand, offer } of pairs) {
          if (given.has(man.id) || filled.has(demand) || ['rearm', 'repair', 'haul'].includes(demand.kind) && this.claimed(man.id).has(demand.id)) continue;
          // A works another vehicle was just given a load for is offered again for what it still lacks.
          // A rearm load may also have committed neighbours or stock since these pairs were ranked.
          const now = ['rearm', 'repair', 'haul'].includes(demand.kind) || demand.taken ? this.offer(man, demand, faction, parts, demand.kind === 'rearm') : offer;
          if (typeof now === 'string') continue;
          this.start(man, demand, now, faction, parts);
          given.add(man.id); demand.taken = true; this.since.delete(demand.key);
          if (!demand.shared) filled.add(demand);
        }
      }
      for (const man of free) if (!given.has(man.id)) this.idle(man, faction, reasons.get(man.id) ?? { reason, targetId: null });
    }
  }

  step(): void {
    const room = this.room, time = room.world.time, works = room.works;
    if (time < this.nextAt) return;
    this.nextAt = time + PERIOD;
    const actors = new Map(room.world.actors.map(actor => [actor.id, actor]));
    for (const [key, { factionId }] of this.since) if (!room.factions.has(factionId)) this.since.delete(key);
    for (const [id] of this.waits) if (!actors.has(id)) this.waits.delete(id);
    // An order carried out lets go of the vehicle it held: it is given its next job from where it stands, as any other — an
    // aircraft it left in the air, from there (`hovering`).
    for (const [id] of this.paused) if (!actors.has(id) || !this.ordered(id)) {
      this.paused.delete(id);
      if (actors.has(id) && this.aloft(actors.get(id)!)) this.hovering.add(id);
    }
    for (const id of this.hovering) if (!actors.has(id) || !this.aloft(actors.get(id)!) || this.jobs.has(id) || this.paused.has(id)) this.hovering.delete(id);
    for (const [id, until] of this.targets)
      if (time >= until || !actors.has(id) && !works.pending.has(id) && !works.heaps.has(id) && !room.roadworks.pending.has(id) &&
        !room.sites.has(id) && activitySite(room)?.id !== id) this.targets.delete(id);
    const crew = [...actors.values()].filter(actor => room.records.get(actor.id)?.auto && room.players.has(actor.ownerId!));
    // An order of the player's a vehicle in automatic went on with when the field was kept holds it again once the field is
    // taken up: the room loads and serves it as one held so (`manages`), and it is given no job until that is carried out.
    for (const actor of crew) if (!this.jobs.has(actor.id) && !this.paused.has(actor.id)) {
      const held = this.ordered(actor.id);
      if (held) this.paused.set(actor.id, held);
    }
    // What a faction that is gone kept in mind goes with it, and what was known of an airdrop that is over goes with that.
    for (const kept of [this.sightings, this.dangers]) for (const id of kept.keys()) if (!room.factions.has(id)) kept.delete(id);
    for (const id of this.cleared.keys()) if (room.activities?.drop?.id !== id) this.cleared.delete(id);
    if (!crew.length && !this.jobs.size) return;
    // Each faction takes in what it holds of the enemies now before its jobs go on and are given out.
    for (const faction of room.factions.values()) this.watch(faction);
    const parts = fieldParts(room.world);
    for (const [id, job] of this.jobs) {
      const actor = actors.get(id);
      if (!actor) this.jobs.delete(id);
      else if (builds(job)) this.attend(job, actor, parts); else if (roadwork(job)) this.roadwork(job, actor, parts); else this.advance(job, actor, parts);
    }
    this.makeRoom();
    if (crew.length) this.plan(crew, parts);
  }
}
