import type { MessageValue } from '../src/message-contract.ts';
import type { NativeInputResult } from '../src/rust-game.ts';
import { readRoomSave } from './room-save.ts';
import { duelView, readDuel } from '../src/duel.ts';
import type { Duel } from '../src/duel.ts';
import { newCommanderState, validateCommanderState, stepCommanders } from './faction-commander.ts';
import type { CommanderProfile, CommanderState } from './commander-contract.ts';
import { ROOM_LIMITS } from './room-limits.ts';
export { ROOM_LIMITS } from './room-limits.ts';
import type { FactionView, UnitView, RoomSquadView, KnownWreck, WreckView, FieldIdentity, FieldStanding, FieldCapture, FieldPerson, FieldPresence } from '../src/field-contract.ts';
import { decodeSquadCommand } from '../src/squad-contract.ts';
import { decodeScriptedDecisions } from '../src/scripted-contract.ts';
import type { ScriptedDecisionEntry } from '../src/scripted-contract.ts';
import type { SightReading, Chapters, Witness } from './fog.ts';
import type { Actor, SceneModule, ScenePlate, SceneEventBase } from '../src/scene-contract.ts';
import type { PublishedScene as SceneFrame } from '../src/publication-contract.ts';
import type { AuthoredConstruction, CanonicalConstruction, CompiledConstruction, CompilerResponse } from '../src/construction-contract.ts';
import type { SupplyBill, CargoLoad, CargoKind, RepairLevels } from '../src/economy-contract.ts';
import type { Deposit } from '../src/deposits.ts';
import type { ConstructionService } from '../src/construction-service.ts';
import type { SightEye } from '../src/ground-sight.ts';
import type { Point } from '../src/math.ts';
import type { SquadOrders, SquadUnit, SquadSide, SquadMember } from '../src/squad-contract.ts';
import type { Work, Heap } from './field-construction.ts';
import type { ActivityState, ActivityDrop } from './world-activities.ts';
import type { RoomSave, SharedRoomOptions, Player, Faction, Post, RoomRecord, Base, Depot, Facing, RawLoad, Span,
  Trade, Accord, ChatMessage, Serials, SerialKind, PublicationAnswer, PublishOptions, PlacementRequest, ServicePoint, Objective,
  FieldDraft, ManufacturingDraft, KnownBase, KnownPost, FactionMet, KnownDeposit, CargoWork, ExtractionWork, RecoveryOffer, RoomRequest, OrderRequest } from './room-contract.ts';
export type { RoomSave, SharedRoomOptions, Player, Faction, Post, RoomRecord } from './room-contract.ts';
import { userError } from '../src/user-message.ts';
import { phrase } from '../src/i18n.ts';
import { buildService, repairService, turnService, dismantleService, advanceService, actorService, factionService, serviceHold } from '../src/construction-service.ts';
import { createHash, randomBytes } from 'node:crypto';
import { FIXED_DT, World } from '../src/physics.ts';
import { createStructuredConstruction, compileStructuredConstruction } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { isVehicleDesign } from '../src/persistence.ts';
import { MAX_FACTION_CONSTRUCTIONS, SHOT_BUDGET, constructionLimitMessage } from '../src/construction-limits.ts';
import { WEAPONS, WEAPON_PRESETS, weaponOf } from '../src/weapons.ts';
import { Random } from '../src/math.ts';
import { applyWorldInput, easedThrottle, releaseWorldInputs } from '../src/episode-input.ts';
import { Squad, unitOrders, gunReach, plateWear, pieceWear, aircraft, fuelRefused, slingLimit, DECISION_STEPS, FREE_FIRE_RADIUS } from '../src/squad.ts';
import { SLING_REACH } from '../src/sling.ts';
import { MAIN_WORLD, AIM_SKY } from '../src/battle-rules.ts';
import { appraise, resupply, supplyLoad, supplySpace, gatherSupplies, fieldParts, designBill, buildSeconds, bill, billSum, billTotal, shortMessage, scantMessage, stocked, load, loadTotal, supplied, refined, weight, reservoirsOf, cratesOf, hauls, extracts, carriedBy, suppliesFill, mixFill, fillOf, dumpOf, stow, sharePile, refine,
  STOCK_IDS, RAW_IDS, SUPPLIED, YIELD, STARTING_STOCK, BASE_RADIUS, CALM_SECONDS, SALVAGE_REACH, LOAD_REACH, extractRate, SUPPLY_REACH, RESUME_DISTANCE, STILL_SPEED, TURN_SECONDS, AIR_TURN_SECONDS, UNBASED,
  CAPTURE_SECONDS, POST_CAPTURE_SECONDS, LOOT_SHARE, BASE_SHARE, SHELTER_AWAY, SHELTER_CALM, SHELTER_LONGEST, captureAt, TRANSFER_RATE, REFINE_RATE, POST_REFINE_RATE, worksAgain } from '../src/economy.ts';
import { keyOf, PUBLICATION_COMMANDS } from '../src/network-protocol.ts';
import { carries, cargoRoom, cargoVolume, cargoSpace, holdsMix } from '../src/component-volume.ts';
import { depositsOf, depositsNear, recovered, RESERVE_STEP } from '../src/deposits.ts';
import { collectionWork, canCollect, workArea, loadingContainers, pickupContainer } from '../src/loading-area.ts';
import { GroundSight, unite, clip, quantise, contains, eyeSweep } from '../src/ground-sight.ts';
import { Fog, witness, decodeSightReading } from './fog.ts';
import { BaseWatch } from './base-watch.ts';
import { validFlag, nationName, defaultFlag } from '../src/flag.ts';
import { uncommanded, makeWreck } from '../src/wreck.ts';
import { SupplyDispatch, worker, roadMachine, outwardHaul, runsLow } from './supply-dispatch.ts';
import { CONSTRUCTION_REACH, Works, constructionSite, postSite, manufactureDesign, structureBill } from './field-construction.ts';
import { Roadworks, ROAD_TOOLS, toolsTold } from './road-works.ts';
import { SOCIAL_LIMITS, ALLIANCE_TERMS, socialText, tradeBill } from '../src/faction-social.ts';
import { activitySite, activityStock, activityKnown, activityStilled, activityView, keepActivities, resumeActivities, stepActivities } from './world-activities.ts';
import { resumeGuardian } from './airdrop-guardian.ts';
import { repairOffer, serviceOffers } from './service-policy.ts';
import { stockWants } from './stock-wants.ts';
import { admitManufacturingDesign, manufacturingPlan, baseVehiclePosition } from './manufacturing.ts';
import { BASIC_INDUSTRY, FULL_INDUSTRY } from '../src/industry.ts';
import type { IndustryLevels } from '../src/industry.ts';
import { newIndustry, advanceIndustry, validateIndustry, startUpgrade, cancelUpgrade, liquidateIndustry, industryView } from './industry.ts';
import { territoryOf, meeting, postEye, BASE_TERRITORY, POST_RADIUS, POST_LIMIT, POST_FULL_MESSAGE, POST_NAME, POST_BILL, POST_EYE, POST_SIGHT } from '../src/territory.ts';
import { TEST_READS, TEST_TARGET_TEAM, testIntent, prepareTestSpawn, testTargetLimit, activeTestActor,
  prepareTestMove, moveTestActor, repairTestActor, resupplyTestActor, stopTestActor, publicationInstant } from '../src/test-tools.ts';


function isRoomRequest(input: unknown): input is RoomRequest { return input !== null && typeof input === 'object' && 'type' in input && typeof input.type === 'string'; }
function roomRequest(input: unknown): RoomRequest {
  if (!isRoomRequest(input)) throw userError('Ação inválida.');
  return input;
}
function lookup<T>(map: ReadonlyMap<string, T>, id: unknown): T | undefined { return typeof id === 'string' ? map.get(id) : undefined; }
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const facingValue = (value: unknown): value is Facing => value === -1 || value === 1;
const objectRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unknownArray = (value: unknown): value is unknown[] => Array.isArray(value);
const stringArray = (value: unknown): value is string[] => unknownArray(value) && value.every(id => typeof id === 'string');
const arrayShape = (value: unknown): boolean => Array.isArray(value);
const included = (list: readonly unknown[], value: unknown): boolean => list.includes(value);
const defined = <T>(value: T | undefined | null): value is T => value != null;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

type DepositSite = Deposit & { type?: never; refined?: never; supplies?: never };
type FieldSite = DepositSite | NonNullable<ReturnType<typeof activitySite>>;
type Appraisal = ReturnType<typeof appraise>;
export interface KnownWreckReading { rows: KnownWreck[]; actors: Map<string, Parameters<SharedRoom['position']>[0]> }
interface LoadRequest { actor: Actor; record: RoomRecord; faction: Faction; containers: SceneModule[]; space: number }
interface LoadSite { site: FieldSite; space: number; containers: SceneModule[] }
interface WorkingLoad {
  actor: Actor; record: RoomRecord; faction: Faction; own: SceneModule[] | undefined; kept: SceneModule[] | undefined;
  work: ReturnType<typeof collectionWork>; near: FieldSite[]; transport: import('./supply-dispatch.ts').DispatchJob | null | undefined;
}
interface ReadingCache { parts: ReturnType<typeof fieldParts>; appraisals: Map<string, Appraisal>; factions: Map<string, UnitView[]>; wants: Map<string, ReturnType<typeof stockWants>> }
const steppedCargo = (cargo: RawLoad): RawLoad => load(...RAW_IDS.map(id => Math.floor(cargo[id] / CARGO_STEP) * CARGO_STEP));
const loadLevel = (told: number, real: number): number => real >= 1 - 1e-6 ? 1 : Math.min(told, 1 - 1e-6);
const compareNames = new Intl.Collator('pt-BR').compare;

// Who may be on the field at once, and from one address; how many new players an address brings in a day; what a
// faction may have standing on the field; how many projects the library of a faction keeps. What one construction may be
// made of is PART_LIMITS, which the workshop holds to as well. The field itself has no limit of constructions: it holds
// what its factions do.
const FULL = phrase`O campo já tem ${ROOM_LIMITS.players} jogadores conectados.`,
  CROWDED = phrase`Só ${ROOM_LIMITS.perAddress} jogadores conectados ao mesmo tempo por conexão: a sua já tem ${ROOM_LIMITS.perAddress}.`,
  SPENT = phrase`Só ${ROOM_LIMITS.newPerAddressPerDay} facções novas por conexão a cada 24 horas: a sua já fundou ${ROOM_LIMITS.newPerAddressPerDay}. Volte mais tarde, ou entre com a que você já tem.`,
  UNKNOWN_KEY = 'Chave de acesso não encontrada neste campo: confira as letras e os números.';
// The name a player goes by, of the one a page says: words, cleared of what is not to be read and cut short, or none
// (null) for a page that says none or nothing to be read. A player who comes saying none keeps the name they had, and a
// new seat is given one of its own (`join`, `unnamed`). Anything else is no name, and is refused before anything on the
// field changes for it. A name worked out is its own name worked out again: the diary writes down the one worked out (field-host.ts).
function playerName(name: unknown): string | null {
  if (name != null && typeof name !== 'string') throw userError('Nome de jogador inválido.');
  return name?.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24).trim() || null;
}
// Two names are one name where they read alike: whatever their case, their accents and the spaces between their words.
const alike = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
const TAKEN = 'Esse nome já é de outro jogador.';
// The names given to seats whose players say none, by count: 'Jogador', 'Jogador 2', 'Jogador 3'…
const numbered = (n: number) => n === 1 ? 'Jogador' : `Jogador ${n}`;
// The key of a seat (`join`): the secret a player comes back to it with, from any device. Twenty-four of the
// thirty-two letters and figures that are not mistaken for one another, drawn by chance — 120 bits —, which a player
// is told in groups of four (`keyText`, network-protocol.ts).
const KEY_SIGNS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const accessKey = () => Array.from(randomBytes(24), byte => KEY_SIGNS[byte & 31]).join('');
// The flag a faction flies until it makes its own, drawn when it is founded and kept with it. It is drawn by chance and
// not by the field's draw: every faction is told the flags of all the others (`factionView`), and a flag worked out of
// anything of the field's would tell what it was worked out of — the faction's name on the field, the order it came in.
// The host draws it as the player comes and writes the draw in its diary (field-host.ts): a field run again flies the same flags.
export const flagDraw = () => randomBytes(8).toString('hex');
// What every player is told a faction by when it asks to join it (`apply`), whether its faction has met that one or not: a
// name of its own, made of the draw of its flag, which tells nothing of when it came, as its name on the field (its id) would.
export const factionRef = (draw: string) => createHash('sha256').update('ref:' + draw).digest('hex').slice(0, 12);
// Why a construction of the faction is not the player's to have while another member holds it (`claim`).
const heldBy = (holder: Player) => phrase`Este veículo está com ${holder.name} até ser liberado.`;
// The first base is founded near the middle of the world, and each one after it a long march from every
// other — a faction has ground of its own to hold — yet within reach of the nearest: the factions people a
// stretch of the world that grows with them, and the rest of it, out to a margin at each end, is frontier
// for whoever goes looking. A faction's constructions come into the field in a row around its base.
const END_MARGIN = 8000, BASE_SPACING = 10000, BASE_REACH = 30000;
const COLORS = ['#b4c786', '#e9b07d', '#81c2ca', '#c6a5d8', '#e0ce7f', '#a6b8ec', '#dd9292', '#86c4a1'];
const WATCH_STEPS = DECISION_STEPS * 5; // a vehicle with nothing to do looks around twice a second
const SURVEY_STEPS = 6;                 // the field looks over its constructions ten times a second
const SIGHT_STEPS = 6;                  // and reads what each faction's sensors hold as often
const DEAL_STEPS = 2;                   // a round of decisions is dealt over this many steps
// Every "how long" of the field's rules is counted in its steps, sixty to a second of the field: a field that is
// replayed step by step does as it did, however fast or slow the host that runs it.
const LEASE_STEPS = 90;                 // a player gone quiet for a second and a half lets go of the vehicle in their hands
const DAY_STEPS = 24 * 60 * 60 * 60;    // an address brings so many new players in a day (`ROOM_LIMITS.newPerAddressPerDay`)
const PUBLISH_STEPS = 24;               // a player publishes again no sooner than this
// The publications of a player the field answers again under the tickets they went with, the last ones (`publish`).
const ANSWERS_KEPT = 8;
// What the field draws a base with is a draw of its own that it keeps: the same field draws the same. A field begins
// drawing from here.
const CHANCE_SEED = 0x1d5c0ffe;
// A deposit this near a base is not dug: nothing loads where it also unloads.
const DEPOSIT_CLEARANCE = BASE_RADIUS + LOAD_REACH;
// What a player is told of a load being taken on, in steps, as of a vein (`RESERVE_STEP`): a truck that loads changes neither many times a second.
const CARGO_STEP = 250;
const FIRST_OBJECTIVES: Objective[] = ['selectMiner', 'collectOre', 'deliverOre', 'directControl', 'fabricateVehicle', 'buildDefense'];
const ORES: readonly CargoKind[] = RAW_IDS.filter(id => id !== 'petroleo');
const completedObjectives = (saved: Partial<Record<Objective, boolean>> | undefined): Player['objectives'] =>
  Object.fromEntries(FIRST_OBJECTIVES.filter(id => saved?.[id] === true).map((id): [Objective, true] => [id, true]));
// A refinery turns out what it made once in this many seconds.
const REFINE_SECONDS = 1;
// The field looks over who stands armed in each base once in this many seconds.
const CAPTURE_LOOK = 1;
// A faction knows the ground this far to each side of its base from the day it is founded there, and keeps what
// it has explored by cells of this many metres: a cell is explored once its middle was seen.
const BASE_SIGHT = 1000, EXPLORED_GRID = 8;
// Foundation targets are economic access distances, not changes to driving physics.
// Iron starts production, petroleum sustains it; the other materials reward exploration within the first territory.
const BASE_RESOURCE_REACH: Readonly<Record<CargoKind, number>> = Object.freeze({
  ferro: BASE_SIGHT, petroleo: 2 * BASE_SIGHT, ligas: BASE_TERRITORY, silica: BASE_TERRITORY,
});
const STARTING_RESOURCES: readonly CargoKind[] = Object.freeze(['ferro', 'petroleo']);
const rounded = (amounts: RawLoad) => load(...RAW_IDS.map(id => Math.round(amounts[id])));
const roles = new WeakMap<Actor, 'artillery' | 'armor'>();
// Puts amounts of each stock into the stocks of a faction, or takes them out.
const credit = (stock: SupplyBill, amounts: SupplyBill, sign = 1) => { for (const id of STOCK_IDS) stock[id] += sign * amounts[id]; };
// Why a work is refused where nothing serves the construction.
// Why a structure is not turned about: it faces as it was put up.
const UNTURNED = 'Estruturas não viram: use Mover para montá-la virada para o outro lado.';
// Amounts of each stock in whole units, as a faction is told them.
const whole = (amounts: SupplyBill) => bill(...STOCK_IDS.map(id => stocked(amounts[id])));
// The least a faction gets back on its feet with: the ore lorry of the catalogue, with its fuel (`recovery`).
let lorry: SupplyBill | null = null;
const lorryBill = () => lorry ||= designBill(compileStructuredConstruction(createStructuredTemplate('mining-truck')));
// The last subsidy, including its real event timestamp in a record kept before aidAt existed.
const dismantleTarget = (service: ConstructionService | null | undefined): string | null => service?.kind === 'dismantle' ? service.to : null;
const lastAidAt = (recovered: Faction['recovered']) => recovered?.aidAt ?? (recovered && billTotal(recovered.aid) > 0 ? recovered.at : null);
// Each kind keeps its own next name, including names of things no longer on the
// field: a dismantled construction remembered by an enemy must never be named again.
// The shared field as one player's squad sees it: its roster has its own and allied constructions.
// An opponent is asked for separately, by what the faction knows of it (`foe`).
export class Side implements SquadSide {
  declare room: SharedRoom; declare playerId: string;
  declare foes?: { time: number; list: { id: string; x: number; y: number; reach: number | null }[] };
  constructor(room: SharedRoom, playerId: string) { this.room = room; this.playerId = playerId; }
  get world() { return this.room.world; }
  get arenaBounds() { return this.room.world.bounds; }
  // Automatic work has its own trips, even while it loads or builds with no leg.
  freeFireRegion(actorId: string, anchor: number | null) {
    return this.room.records.get(actorId)?.auto || this.room.towOf(actorId) ? null : { anchor, radius: FREE_FIRE_RADIUS };
  }
  knowsGround(x: number) { return this.room.explored(this.faction.id, x); }
  get defeats() { return this.room.outOfAction(); }
  get roster() {
    const roster: SquadMember[] = [];
    for (const actor of this.room.fielded()) {
      const team = this.team(actor);
      if (team !== 'opponent') roster.push(this.member(actor, team));
    }
    return roster;
  }
  team(actor: Actor): SquadMember['team'] {
    const players = this.room.players, owner = lookup(players, actor.ownerId);
    return actor.ownerId === this.playerId ? 'local'
      : owner && owner.factionId === players.get(this.playerId)?.factionId ? 'ally' : 'opponent';
  }
  member(actor: Actor, team = this.team(actor)): SquadMember {
    if (!roles.has(actor)) {
      const preset = actor.blueprint.modules.find(m => m.kind === 'weapon')?.weaponPreset;
      roles.set(actor, preset !== undefined && ['mortar', 'howitzer'].includes(weaponOf(preset)?.family ?? '') ? 'artillery' : 'armor');
    }
    return { id: actor.id, pilot: 'player', role: roles.get(actor)!, team };
  }
  // The field steps next and reads the scene then: no input asks for it.
  input(actorId: string, input: object, decision = false) {
    return applyWorldInput<NativeInputResult>(this.room.world, actorId, { ...input, phase: decision ? 'decision' : 'before' },
      { platform: 'vehicle', quiet: true }).accepted;
  }
  // What a hauler needs to know of the field. Of a site its faction knows a vein at: where it is, how near
  // it loads, the reserve and ready pile it knows, and whether a base stills it (`stilled`); of a site it never saw,
  // nothing. Of a construction there, where it works the site (`area`, loading-area.ts `workArea`): it digs there, but on
  // a trip of the dispatch for a ready pile, whatever the faction last knew of the reserve — a vein comes back by
  // itself —, and takes in the pile it knows. What it carries and its room are in litres; `load.extracts` distinguishes
  // a stationary tool from a vehicle with neither capability.
  get faction() { return this.room.faction(this.room.players.get(this.playerId)!); }
  deposit(id: string, actorId: string | null = null): import('../src/squad-contract.ts').SquadDeposit | null {
    const publicSite = activitySite(this.room);
    if (publicSite?.id === id && activityKnown(this.room, this.faction)) return { x: publicSite.x, reach: LOAD_REACH,
      stock: activityStock(this.room.activities!.drop),
      ...(publicSite.refined ? { refined: true } : { material: publicSite.material, left: 0 }),
      stilled: activityStilled(this.room, this.faction, publicSite),
      ...(actorId ? { area: workArea(this.world, actorId, publicSite, LOAD_REACH,
        { dig: false, stock: activityStock(this.room.activities!.drop) }) } : {}) };
    const room = this.room, site = room.sites.get(id), known = site && room.known(this.faction, site);
    if (!site || !known) return null;
    return { x: site.x, reach: LOAD_REACH, material: site.material, stilled: room.stilled(this.faction, site), left: known.left, stock: known.stock ?? 0,
      ...(actorId ? { area: workArea(room.world, actorId, site, LOAD_REACH,
        { dig: room.supplyDispatch.jobs.get(actorId)?.kind !== 'haul', stock: known.stock ?? 0 }) } : {}) };
  }
  // How a construction of the side works a vein of a material, by its pieces that work (Squad.beside): it carries off
  // what is dug there ('carries') with a container that takes the material, whether it digs too or not, and only digs
  // ('digs') with a tool that extracts the material and no such container. Neither, null.
  role(actorId: string, material: CargoKind | undefined) {
    const pieces = this.room.world.modules.filter(m => m.actorId === actorId && m.health > 0 && m.attached !== false);
    return pieces.some(m => material !== undefined && hauls(m, material)) ? 'carries' : pieces.some(m => material !== undefined && extracts(m, material)) ? 'digs' : null;
  }
  // The vein a place of the field lies by, as the faction knows it: the nearest one within loading reach of the place.
  veinAt(x: number) {
    const room = this.room, publicSite = activitySite(room),
      site = [...depositsNear(room.deposits, x, LOAD_REACH).filter(site => room.known(this.faction, site)),
        ...(publicSite && activityKnown(room, this.faction) && Math.abs(publicSite.x - x) <= LOAD_REACH ? [publicSite] : [])]
      .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    return site ? { id: site.id, x: site.x, reach: LOAD_REACH } : null;
  }
  // The place of its faction nearest a construction of the side where a load is brought (SharedRoom.depot): its base or a post.
  // Or the one nearest the place `x` of the field it is to go to, for its way home from there (Squad.fuelRefusal).
  depot(actorId: string, x: number = this.room.position(this.room.world.actor(actorId)!)) {
    const place = this.room.depot(this.faction, x);
    return place && { x: place.x, radius: place.radius };
  }
  // Whether an aircraft of the side keeps its fuel to come home (SharedRoom `homing`, Squad.homing): unless it was told not to.
  homing(actorId: string) { return this.room.records.get(actorId)?.homing !== false; }
  // Whether there is fuel there to fill up a construction of the side with (SharedRoom.serve): in the stocks of its faction.
  get fuelled() { return this.faction.stock.combustivel >= 1; }
  // The pilot of an aircraft lets go of the load it set down on its sling (Squad.fly), as the player lets go of a cable
  // (SharedRoom.tow): false when it holds none.
  unhook(actorId: string) {
    const room = this.room, link = room.towOf(actorId);
    if (link?.actorId !== actorId || !link.sling) return false;
    room.unhook(room.world.actor(actorId)!);
    return true;
  }
  // The squad turns a vehicle about on its own, to go on the way it was sent — an aircraft in the air as well, where it
  // flies: false when something holds it.
  turnAbout(actorId: string) {
    const room = this.room, actor = room.world.actor(actorId);
    if (!actor || !isVehicleDesign(actor.construction) || room.held(actor) || room.towOf(actorId)) return false;
    room.turn(room.players.get(this.playerId)!, actor, true);
    return true;
  }
  // The guns the base of the faction places by their fire (base-watch.ts), for whoever of the squad answers them.
  get batteries() {
    return this.room.batteryMarks(this.faction.id, this.room.world.time, null, true);
  }
  // Whether the squad holds a construction as an enemy still in the fight, by what its faction is told (fog.ts): until
  // the faction sees it out of the fight — in sight so, or last seen so — or sees it leave the field. One it lost track
  // of it goes on holding, whatever became of it: an order on it stands, and the pilot finds nothing there.
  foe(actorId: string) {
    const room = this.room, actor = room.world.actor(actorId), faction = this.faction.id;
    if (!actor) return room.fog !== null && !room.fog.left(faction, actorId);
    if (this.team(actor) !== 'opponent') return false;
    const how = room.knows(faction, actor);
    return how === 'seen' ? !room.outOfAction()[actorId] : how === 'ghost' ? !room.fog!.ghost(faction, actorId, room.field.time)!.defeated : true;
  }
  // The enemies the faction holds now, for the safety of its automatic work (Squad.endangered): each in sight still in
  // the fight, where it is — along the field and how high (`y`), a vehicle by its body and a structure by its origin — and
  // how far the guns it shows reach (`gunReach`, none for one with no gun); and each held only as a mark — a blip of its
  // radar, or what an ear of its own heard (fog.ts `mark`) —, where the mark puts it, as high as the reading has it, which
  // says nothing of its guns (`reach` null). A ghost is only remembered: it is none of them. Each goes by the name of its
  // construction (`id`), which stays on the server: what the faction keeps in mind of an enemy follows it by that name
  // (supply-dispatch.ts `watch`). On a field without fog the faction has every enemy in sight. Taken once a look of the field.
  threats() {
    const room = this.room, world = room.world, time = world.time;
    if (this.foes?.time === time) return this.foes.list;
    const faction = this.faction.id, out = room.outOfAction(), list: import('../src/squad-contract.ts').SquadThreat[] = [];
    for (const actor of world.actors) {
      if (this.team(actor) !== 'opponent' || room.allied(faction, actor.team)) continue;
      const how = room.knows(faction, actor), mark = how === 'seen' ? null : room.fog?.mark(faction, actor.id, room.field.time), at = actor.vehicle ?? actor;
      if (how === 'seen' && !out[actor.id]) list.push({ id: actor.id, x: at.x, y: at.y, reach: gunReach(world, actor.id) });
      else if (mark) list.push({ id: actor.id, x: mark.x, y: mark.y, reach: null });
    }
    this.foes = { time, list };
    return list;
  }
  // Where the faction holds an enemy construction now, for an aircraft that goes for it (Squad.strike): in sight or on its
  // radar, the middle of it, and with `seen` whether it is in sight; a ghost, where its body was when last seen; a mark, the
  // place along the field the mark puts it at, on the ground. Nothing for one it holds nowhere.
  whereabouts(actorId: string) {
    const room = this.room, world = room.world, actor = world.actor(actorId), faction = this.faction.id, time = room.field.time;
    if (!actor || this.team(actor) !== 'opponent') return null;
    const how = room.knows(faction, actor), ground = (x: number) => world.terrain.height(x) + 1;
    if (how === 'seen' || how === 'radar') {
      const b = world.actorBounds(actorId);
      return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, seen: how === 'seen' };
    }
    const ghost = how === 'ghost' && room.fog!.ghost(faction, actorId, time);
    if (ghost) { const x = room.position(ghost); return { x, y: ghost.vehicle?.y ?? ground(x) }; }
    const mark = room.fog?.mark(faction, actorId, time);
    return mark ? { x: mark.x, y: ground(mark.x) } : null;
  }
  // Whether the faction has a construction of another in sight or on its radar now: what the squad's screen may name.
  sighted(actorId: string) {
    const actor = this.room.world.actor(actorId);
    return actor != null && included(['seen', 'radar'], this.room.knows(this.faction.id, actor));
  }
  // Whether a construction stands where it tipped part of its load out, and so takes nothing on there.
  tipped(actorId: string) { return (this.room.records.get(actorId)?.tipped ?? null) !== null; }
  load(actorId: string) {
    const haul = this.room.players.get(this.playerId)?.squad?.units.get(actorId)?.haul, material = haul?.material,
      modules = this.room.world.modules.filter(m => m.actorId === actorId && m.health > 0 && m.attached !== false),
      pieces = haul?.refined ? cratesOf(modules) : reservoirsOf(modules).filter(m => material !== undefined && carries(m, material));
    const job = this.room.supplyDispatch.jobs.get(actorId), automatic = Boolean(job?.haul && haul === job.haul), event = automatic && activitySite(this.room),
      site = automatic && haul ? (this.room.sites.get(haul.depositId) ?? (event && event.id === haul.depositId ? event : null)) : null;
    return { carried: pieces.reduce((sum, m) => sum + cargoVolume(m), 0) * 1000, room: pieces.reduce((sum, m) => sum + cargoRoom(m), 0) * 1000,
      extracts: !automatic && !haul?.refined && modules.some(m => material !== undefined && extracts(m, material)),
      ...(site ? { full: this.room.supplyDispatch.transportSpace(this.world.actor(actorId)!, site, pieces) <= 1e-6 } : {}),
      waiting: this.room.records.get(actorId)?.cargoWork?.waiting === true };
  }
}
// A field to rehearse on: stocks no rehearsal runs out of, vehicles ready the moment they are published and structures the
// moment all their material is at their works with a builder beside it, and the bases where it puts them, by order of
// foundation; the last one given serves whoever comes after. The bases may be given as what places them, when where they
// stand is to be read from the field. What else it is made with is the field's own (`options`).
export const rehearsal = (bases: number[] | ((index: number) => number | null | undefined) = [-213, 237], stock = bill(1e9, 1e9, 1e9, 1e9), options: SharedRoomOptions = {}) =>
  new SharedRoom({ stock, build: false, starter: false, industry: FULL_INDUSTRY, ...options, base: typeof bases === 'function' ? bases : i => bases[Math.min(i, bases.length - 1)] });
// What the field reads of a command, by its type: what `SharedRoom.command` reads of it, and what is read of it where the
// command is handed on (`publish`, `order` and `give`, `identity`...). A type the field does not know it reads as it
// reads the controls of the construction in hand, and refuses as it refuses them.
const PIECE = ['actorId'], CONTROLS = ['actorId', 'request'], GUN = [...CONTROLS, 'cancel', 'active', 'aim', 'weapon', 'queue'];
const READS = new Map<string, readonly string[]>([
  ['test', TEST_READS],
  ['ping', []], ['release', []], ['recover', []], ['rekey', []], ['rename', ['name']],
  ['spawn', ['ticket', 'blueprint', 'x', 'facing', 'instant']], ['post', ['ticket', 'x', 'facing', 'instant']], ['replace', ['ticket', 'actorId', 'blueprint', 'facing', 'instant']], ['relocate', ['ticket', 'actorId', 'x', 'facing']],
  ['squad', ['order', 'id', 'ids', 'x', 'y', 'targetId', 'point', 'stance', 'depositId']],
  ['tow', ['act', 'actorId', 'targetId']],
  ['invite', ['playerId', 'cancel']], ['join-faction', ['factionId']], ['decline', ['factionId']], ['identity', ['nation', 'flag']],
  ['member', ['playerId', 'act']], ['leave-faction', []], ['apply', ['ref', 'cancel']], ['answer', ['playerId', 'accept']],
  ['library', ['act', 'id', 'ids', 'blueprint']],
  ['upgrade', ['id']], ['cancel-upgrade', ['id']],
  ['trade', ['act', 'id', 'ref', 'give', 'want']], ['accord', ['act', 'id', 'ref', 'text', 'kind']], ['chat', ['scope', 'text']],
  ['salvage', ['wreckId']],
  ['auto', ['actorId', 'on']], ['homing', ['actorId', 'on']], ['cancel-work', ['workId']], ['road', ['x0', 'x1', 'kind']], ['cancel-road', ['roadId']],
  ['remove-post', ['postId']], ['keep-post', ['postId']],
  ['objectives', ['action', 'ids']],
  ...['select', 'remove', 'cancel-dismantle', 'abandon', 'repair', 'cancel-repair', 'dump-cargo', 'blueprint'].map(type => [type, PIECE] as const),
  ['drive', [...CONTROLS, 'throttle', 'brake', 'rise']], ['aim', GUN], ['trigger', GUN], ['fire', GUN],
]);
// A command as the field reads it: its type and what the field reads of that type, each as it was sent. Whatever else a
// page sends with it reaches neither the field nor its diary (field-host.ts).
export function asked(input: unknown): RoomRequest {
  const data = roomRequest(input), said: RoomRequest = { type: data.type };
  for (const key of READS.get(data.type) ?? CONTROLS) if (data[key] !== undefined) said[key] = data[key];
  return said;
}
// Whether a command, as the field reads it, may found a faction: for a player who leaves theirs, or is removed from it.
// The flag drawn for it (`flagDraw`) goes with the command where it is run (`SharedRoom.command`) and written down.
export const founding = (said: RoomRequest) => said.type === 'leave-faction' || said.type === 'member' && said.act === 'remove';
export class SharedRoom {
  duel: Duel | null = null;
  declare field: World;
  declare players: Map<string, Player>; declare factions: Map<string, Faction>; declare records: Map<string, RoomRecord>;
  declare commanders: Map<string, CommanderState>;
  declare arrivals: number; declare trades: Map<string, Trade>; declare accords: Map<string, Accord>; declare chat: ChatMessage[];
  declare activities: ActivityState | null; declare guardianSquad: Squad | null;
  declare reserved: Set<string>; declare newcomers: Map<string, number[]>; declare fieldId: string;
  declare steps: number; declare round: number; declare dealing: { ordered: Actor[]; done: number; step: number; steps: number; spent: number; start: number } | null;
  declare surveyed: number; declare faults: Set<string>; declare topology: number;
  declare grant: SupplyBill; declare site: SharedRoomOptions['base']; declare founded: number; declare building: boolean; declare starter: boolean;
  declare startingIndustry: IndustryLevels; declare chance: Random; declare random: () => number; declare serials: Serials;
  declare sites: Map<string, DepositSite>; declare veins: Map<string, number>; declare extracted: Map<string, number>;
  declare fog: Fog | null; declare sighted: number; declare sightTopology: number; declare watch: BaseWatch | null;
  declare contested: Map<string, { foes: string[] }>; declare disputed: Map<string, { foes: string[]; full: string[] }>;
  declare besieged: number; declare lookouts: Map<string, SightEye & { spans: Span[] }>;
  declare sheltered: Set<Actor>; declare works: Works; declare roadworks: Roadworks; declare supplyDispatch: SupplyDispatch;
  declare listed?: { actors: Actor[]; ordered: Actor[] };
  declare sampledOut?: number | null;
  declare out: Record<string, boolean>;
  declare served?: { topology: number; of: Map<string, { base: Base | null; places: Depot[] }> };
  declare hauledAt?: number;
  declare quoted?: ReadingCache;
  declare reckoned?: { second: number; wealth: Map<string, number> };
  declare acquainted?: number;

  // `stock` is what a faction is founded with; `base` places the bases of a
  // rehearsed field instead of drawing them. Without `fog` every faction is told the whole field.
  // `random` is what the field draws a base with instead of its own draw (`chance`).
  // `kept` is a field written out before (`keep`), which this one resumes instead of beginning empty. Without `build`
  // a vehicle is ready the moment it is published, instead of being built at the base first, and a works is put up, and a
  // structure taken down, the moment a builder is beside it (field-construction.ts).
  // `starter` gives a new seat a ready miner, scout and constructor; rehearsals can explicitly begin empty.
  constructor({ stock = STARTING_STOCK, base = null, fog = true, random = null, kept = null, build = true, starter = true, industry = BASIC_INDUSTRY }: SharedRoomOptions = {}) {
    const arena = createStructuredConstruction({ preset: 'bunker', length: .2, height: .2,
      frontInset: .01, rearInset: .01 });
    this.field = new World({ ...arena, terrain: MAIN_WORLD.terrain },
      { enclosed: true, shotBudget: SHOT_BUDGET, scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } });
    this.world.removeActor('local');
    this.players = new Map(); this.factions = new Map(); this.records = new Map(); this.commanders = new Map(); this.arrivals = 0;
    this.trades = new Map(); this.accords = new Map(); this.chat = []; this.activities = null; this.guardianSquad = null;
    // The constructions a member holds (`claim`), each in the squad of that member (its `ownerId`): a holding lasts while the
    // member is on the field, and is not kept (`keep`).
    this.reserved = new Set();
    // The steps at which each address was given a new seat in the last day of the field (`seat`). Not kept (`keep`):
    // a field started again has forgotten them.
    this.newcomers = new Map();
    this.fieldId = randomBytes(16).toString('hex');
    this.steps = 0; this.round = 0; this.dealing = null; this.surveyed = -Infinity; this.faults = new Set();
    this.topology = 0; // counts the constructions that came, went or were rebuilt, and the posts that came, went, changed hands or began or stopped being taken down
    this.grant = stock; this.site = base; this.founded = 0; this.building = build; this.starter = starter;
    this.startingIndustry = newIndustry(industry).levels;
    // Players, factions and constructions are named in the order they came, each kind by a count of its own that the
    // field keeps (`mint`): the name of a construction says nothing of how many players or factions came before it.
    this.chance = new Random(CHANCE_SEED); this.random = random ?? (() => this.chance.next()); this.serials = { j: 0, f: 0, c: 0, r: 0, t: 0, a: 0, m: 0 };
    // The sites of the ground by name, and what is left of the vein of each that holds less than its reserve: a site
    // `veins` does not name holds its whole reserve, as every site does when a field begins (`left`, `replenish`).
    this.sites = new Map(this.deposits.map(site => [site.id, site]));
    this.veins = new Map();
    this.extracted = new Map(); // material ready to collect, shared by everybody, separately from the geological reserve
    // What each faction knows of the constructions of the others, and the step and the field the sensors were last read at.
    this.fog = fog ? new Fog() : null; this.sighted = -Infinity; this.sightTopology = -1;
    // What the base of each faction places of the guns of the others by their fire: with no fog there is nothing to place.
    this.watch = fog ? new BaseWatch() : null;
    // What each base had standing armed in it when the field last looked (`besiege`), by the faction it is of, and when that
    // was; and what each post had so, by its name.
    this.contested = new Map(); this.disputed = new Map(); this.besieged = -Infinity;
    // What the eye of each post sees of the ground about it, by the name of the post (`lookout`): the ground does not change
    // under a post, nor does the post move.
    this.lookouts = new Map();
    // The constructions the core was last told are sheltered by their base (`shelter`).
    this.sheltered = new Set();
    this.world.game();
    // The works and the heaps of the factions (field-construction.ts), the roads they ask for (road-works.ts), and the
    // vehicles that go by themselves.
    this.works = new Works(this); this.roadworks = new Roadworks(this);
    this.supplyDispatch = new SupplyDispatch(this);
    if (kept) try { this.resume(kept); } catch (error) { this.field.dispose(); throw error; }
  }
  // The ground of this field in a few letters: its landscape, sampled from end to end, and its sites. A field
  // kept on another — another seed, another length, a landscape drawn otherwise since — is not resumed on this one.
  ground() {
    const terrain = this.field.terrain, hash = createHash('sha256');
    hash.update(JSON.stringify([terrain.id, terrain.seed, terrain.length, terrain.center, ...this.sites.keys()]));
    for (let i = 0; i <= 256; i++) hash.update(terrain.height(terrain.minX + (terrain.maxX - terrain.minX) * i / 256).toFixed(3));
    return hash.digest('hex').slice(0, 16);
  }
  // The field to be written out, and resumed by the server that starts next (field-save.js): the scene as it
  // stands (`World.keep`), what is left in the veins dug below their reserve and what their public piles hold, every faction with who leads it and who
  // administers it, its stocks, its base or none, the capture of it under way, the last base it lost (`fell`), the last base
  // it took, the last time it recovered (`recovered`) and where it came from
  // when it was founded for a player removed from another, since when all its members are away, when it last fought and
  // since when its base is sheltered (`shelter`), its posts with the yard of each, the capture of each under way and what is
  // being taken down of it (`posts`), the last post it lost (`lost`) and the last it took (`seized`), what it knows of the
  // ground, of the others, of their bases and of their posts (`outposts`), what it is told by
  // when somebody asks to join it (`ref`) and the projects of its library, every seat with its key, the orders of its squad and
  // the faction it asked to join (`request`), and what the field keeps of each construction, with its draw. Every "when" in
  // it is the field's own clock, which is kept too: nothing runs out while no server runs. The works and the heaps of the
  // factions are kept with what came of each (`Works.keep`), and the roads they asked for as they were asked for
  // (`Roadworks.keep`); a leg the pilot drives at the pace of a road machine's tools is not. Recent publication answers
  // (`published`) stay with each seat: a page may retry an unacknowledged command after restart. What lasts seconds is left
  // out and found again — the fog's ghosts and marks, what a squad heard, the wear a look compares — with whatever is only the pace of the field or was worked out from the rest.
  // Nobody is on a field resumed, and so nobody holds a construction of it (`reserved`).
  // The independent name counters remain even after their last named object leaves.
  get ended(): boolean { return this.duel !== null && this.duel.phase !== 'playing'; }

  // Opt in only after the two factions and their bases exist. Old captures do
  // not decide a new duel; the next actual capture does. Persistent fields omit it.
  startDuel(): void {
    const sides = [...this.factions.keys()];
    if (this.duel || sides.length !== 2 || [...this.factions.values()].some(f => !f.base || f.capture) ||
      [...this.accords.values()].some(a => a.kind === 'alliance' && a.acceptedAt !== null))
      throw new Error('O duelo exige duas facções separadas, com bases e sem disputa em andamento.');
    this.duel = { phase: 'playing', sides: [sides[0]!, sides[1]!], since: this.world.time };
  }

  private finishDuel(outcome: { phase: 'won'; winner: string; loser: string; at: number } | { phase: 'draw'; at: number }): void {
    if (!this.duel || this.duel.phase !== 'playing') return;
    this.duel = { sides: this.duel.sides, since: this.duel.since, ...outcome };
    this.dealing = null;
    for (const player of this.players.values()) {
      this.take(player, null);
      const ids = this.world.actors.filter(actor => actor.ownerId === player.id).map(actor => actor.id);
      player.squad!.command({ order: 'stop', ids });
      player.squad!.command({ order: 'stance', ids, stance: 'hold' });
    }
    for (const actor of this.world.actors) {
      const record = this.records.get(actor.id);
      if (record) { record.auto = false; record.drive = null; }
    }
    releaseWorldInputs(this.field, this.world.actors.filter(actor => actor.ownerId).map(actor => actor.id), 1, true, true);
  }

  keep(): RoomSave {
    return { fieldId: this.fieldId, ground: this.ground(), veins: [...this.veins], extracted: [...this.extracted], arrivals: this.arrivals, founded: this.founded, chance: this.chance.state >>> 0, serials: { ...this.serials },
      trades: [...this.trades.values()], accords: [...this.accords.values()], chat: this.chat, startingIndustry: { ...this.startingIndustry },
      ...(this.activities ? { activities: keepActivities(this, this.activities) } : {}),
      ...(this.commanders.size ? { commanders: structuredClone([...this.commanders]) } : {}),
      ...(this.duel ? { duel: structuredClone(this.duel) } : {}),
      players: [...this.players.values()].map(({ id, token, name, color, selected, factionId, request, squad, objectives, published, aidAt }) => ({
        id, token, name, color, selected, factionId, request, objectives: completedObjectives(objectives), published: structuredClone([...published]),
        ...(aidAt == null ? {} : { aidAt }),
        orders: [...squad!.units].map(([actorId, unit]) => {
          const order = unitOrders(unit), job = this.supplyDispatch.jobs.get(actorId),
            automatic = job?.kind === 'haul' && (job.haul ? order.haul === job.haul : order.move === job.leg);
          // An automatic pickup is replanned from the preserved cargo and auto switch. Manual rounds stay exactly as ordered.
          if (automatic || order.move?.pace !== undefined) order.move = null;
          if (automatic) order.haul = null;
          return [actorId, order];
        }) })),
      factions: [...this.factions.values()].map(({ id, ref, leader, admins, nation, flag, stock, yard, refinedAt, base, fell, recovered, removed, capture, taken, away, fought, shelter, posts, lost, seized, industry, members, invited, met, explored, veins, bases, outposts, library, chat }) => ({
        id, ref, leader, admins: [...admins], nation, flag, stock, yard, refinedAt, base, fell, recovered, removed, capture, taken, away, fought, shelter, posts: structuredClone(posts), lost, seized,
        industry: structuredClone(industry), members: [...members], invited: [...invited], met: [...met], explored,
        veins: veins && [...veins], bases: bases && [...bases], outposts: outposts && [...outposts], library: structuredClone(library), chat })),
      records: [...this.records].map(([id, { arrival, combatAt, wreck, service, declined, tipped, auto, homing, gatheredOre, supplyDelivery }]) =>
        [id, { arrival, combatAt: Number.isFinite(combatAt) ? combatAt : null, wreck, service, declined, tipped, ...(auto ? { auto: true } : {}), ...(homing === false ? { homing: false } : {}),
          ...(gatheredOre ? { gatheredOre: true } : {}), ...(supplyDelivery === true ? { supplyDelivery: true } : {}) }]),
      ...this.works.keep(), roadworks: this.roadworks.keep(), scene: this.world.keep() };
  }
  // Makes this field, which nobody came to yet, the one that was kept. To the field it is as if everybody had
  // left and come back to it later: nobody is connected, no construction is in anybody's hands, and each seat
  // waits for its key. A faction somebody of which was on the field when it was kept is away from now, the first step of
  // this field; what its constructions were doing they go on doing, as for everybody else.
  resume(input: unknown) {
    const kept = readRoomSave(input);
    if (kept.ground !== this.ground()) throw new Error('é de outro terreno');
    if (!Array.isArray(kept.extracted)) throw new Error('Campo salvo sem mapa de materiais extraídos.');
    if (!kept.serials || (['j', 'f', 'c', 'r'] as const).some(kind => !Number.isSafeInteger(kept.serials[kind]) || kept.serials[kind] < 0))
      throw new Error('Campo salvo sem contadores válidos de jogadores, facções, construções e estradas.');
    this.veins = new Map(kept.veins); this.extracted = new Map(kept.extracted); this.arrivals = kept.arrivals; this.founded = kept.founded;
    if (typeof kept.fieldId === 'string' && kept.fieldId) this.fieldId = kept.fieldId;
    this.chance.state = kept.chance; this.serials = { ...kept.serials, t: kept.serials.t ?? 0, a: kept.serials.a ?? 0, m: kept.serials.m ?? 0 };
    for (const { orders, published = [], ...seat } of kept.players) {
      if (seat.aidAt != null && (!Number.isFinite(seat.aidAt) || seat.aidAt < 0)) throw new Error('Histórico de auxílio inválido no campo salvo.');
      if (!Array.isArray(published) || published.length > ANSWERS_KEPT || published.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== 'string' || entry[0].length > 64 || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])))
        throw new Error('Comprovantes de fabricação inválidos no campo salvo.');
      const answers = new Map(structuredClone(published));
      if (answers.size !== published.length) throw new Error('Comprovantes de fabricação repetidos no campo salvo.');
      this.players.set(seat.id, { ...seat, objectives: completedObjectives(seat.objectives), builtAt: -Infinity, published: answers, connected: false, lastInput: this.steps });
    }
    for (const { members, admins, invited, met, explored, veins, bases, outposts, posts, library, ...faction } of kept.factions) {
      if (!Array.isArray(posts)) throw new Error('Campo salvo sem os postos das facções.');
      this.factions.set(faction.id, { ...faction, chat: structuredClone(faction.chat === undefined ? [] : faction.chat), members: new Set(members), admins: new Set(admins), invited: new Set(invited), met: new Map(met), library: structuredClone(library),
        posts: structuredClone(posts), explored: this.fog && explored, seen: [], eyes: this.fog && new GroundSight(this.field.terrain), veins: this.fog && new Map(veins), bases: this.fog && new Map(bases),
        outposts: this.fog && new Map(outposts) });
    }
    this.resumeSocial(kept);
    this.activities = resumeActivities(kept.activities);
    this.field.resume(kept.scene);
    this.duel = readDuel(kept.duel, this.field.time, this.factions);
    for (const [id, state] of kept.commanders ?? []) {
      if (!this.players.has(id) || this.commanders.has(id)) throw new Error('Controladores de facção inválidos no campo salvo.');
      this.commanders.set(id, validateCommanderState(state, this.field.time));
    }
    for (const player of this.players.values())
      if (player.aidAt != null && player.aidAt > this.field.time) throw new Error('Histórico de auxílio inválido no campo salvo.');
    this.startingIndustry = newIndustry(kept.startingIndustry).levels;
    for (const faction of this.factions.values()) faction.industry = validateIndustry(faction.industry, this.field.time, Boolean(faction.base));
    // The records are in place before anybody asks for one: asking makes the record of a construction that has none.
    this.records = new Map(kept.records.map(([id, { combatAt, ...record }]) =>
      [id, { ...record, auto: record.auto === true, homing: record.homing !== false, combatAt: combatAt ?? -Infinity, wear: null, shots: null, pulled: null, drive: null, loading: null, extraction: null, tools: null, building: null, road: null }]));
    const actors = this.field.actors;
    if (actors.length !== this.records.size || !actors.every(actor => this.records.has(actor.id))) throw new Error('as construções não são as que o campo guardava');
    for (const actor of actors) this.show(actor);
    releaseWorldInputs(this.field, actors.map(actor => actor.id), 0, true, true);
    for (const { id, orders } of kept.players) {
      const player = this.players.get(id)!; player.squad! = new Squad(new Side(this, id));
      for (const [actorId, order] of orders) {
        const unit = player.squad!.units.get(actorId); if (!unit) continue;
        // Saves without the new anchor start here once; a saved Stop (null) stays stopped.
        // Retired post/guard fields neither choose the region nor change the saved source.
        const fireAt = Object.hasOwn(order, 'fireAt') ? order.fireAt : order.stance === 'fire' ? player.squad!.position(actorId) : null;
        if (fireAt !== null && !finiteNumber(fireAt)) throw new Error('Origem de fogo livre inválida no campo salvo.');
        Object.assign(unit, unitOrders({ ...order, fireAt }), { fireAt });
      }
    }
    // Native restored the one physical relation after its actors. A saved cable
    // cannot silently reawaken a target's old orders, worker or rebuild service.
    for (const link of this.field.tows) {
      const actor = this.field.actor(link.actorId)!, target = this.field.actor(link.targetId)!, owner = lookup(this.players, actor.ownerId),
        members = owner && this.faction(owner)?.members, a = owner?.squad!.units.get(actor.id), b = this.squadFor(target)?.units.get(target.id),
        first = this.records.get(actor.id), second = this.records.get(target.id);
      if (!members?.has(target.ownerId ?? '') || !a || !b || first!.wreck || second!.wreck || first!.service || second!.service || first!.auto || second!.auto ||
        a.haul || a.attack || a.move && a.move.purpose !== 'order' || b.move || b.attack || b.haul || b.fireAt !== null)
        throw new Error('Reboque salvo incompatível com as ordens ou a facção dos veículos.');
    }
    resumeGuardian(this);
    this.works.resume(kept); this.roadworks.resume(kept.roadworks);
    this.syncAlliances(false);
    for (const faction of this.factions.values()) {
      if (this.manned(faction)) this.arrive(faction);
      else faction.away ??= this.field.time;
    }
  }
  // A print of the field as it stands, by which two runs of it are told apart (field-host.ts): the core's, of every
  // body and every round in the air, with the counts, the draw and the veins of the field, its seats, its factions with
  // their posts, who holds which construction, its constructions as the field keeps them, its works and heaps, and its
  // roads. Reading it changes nothing.
  digest() {
    const hash = createHash('sha256');
    if (this.duel) hash.update(JSON.stringify(this.duel));
    hash.update(this.field.game().call({ op: 'digest', frame: false }));
    hash.update(JSON.stringify([this.steps, this.round, this.surveyed, this.sighted, this.topology, this.serials, this.chance.state, this.arrivals, this.founded,
      [...this.veins], [...this.extracted], [...this.players.values()].map(p => [p.id, p.name, p.factionId, p.selected, p.connected, p.lastInput, p.squad!.manual,
        ...(p.aidAt == null ? [] : [['aidAt', p.aidAt]]),
        ...(Object.keys(p.objectives ?? {}).length ? [completedObjectives(p.objectives)] : []), ...(p.request ? [p.request] : []), ...(p.chatAt === undefined ? [] : [p.chatAt])]),
      [...this.factions.values()].map(f => [f.id, f.stock, f.yard, f.base?.x, [...f.members], f.leader, [...f.admins], f.away, f.fought, f.shelter,
        lastAidAt(f.recovered), f.industry,
        ...(f.library.length ? [f.library.map(model => model.id)] : []), ...(f.posts.length ? [f.posts] : [])]), [...this.reserved],
      [...this.records].map(([id, record]) => [id, record.arrival, record.combatAt, Boolean(record.wreck), Boolean(record.service),
        ...(record.auto ? ['auto'] : []), ...(record.homing === false ? ['homing-off'] : []), ...(record.gatheredOre ? ['gatheredOre'] : []), ...(record.supplyDelivery === true ? ['supplyDelivery'] : []),
        ...(record.service?.kind === 'build' && record.service.objective ? ['fabricatingVehicle'] : []), ...(record.service?.kind === 'dismantle' ? [record.service] : [])]), this.works.keep(), this.roadworks.keep(), this.field.roads]));
    hash.update(JSON.stringify([[...this.trades.values()], [...this.accords.values()], this.chat, [...this.factions.values()].map(f => [f.id, f.chat])]));
    if (this.activities) hash.update(JSON.stringify(keepActivities(this, this.activities)));
    if (this.commanders.size) hash.update(JSON.stringify([...this.commanders]));
    return hash.digest('hex').slice(0, 24);
  }
  // A host may step the field without looking at its scene. Whoever reads the world gets it as
  // it is now: the scene is read then, once, however many read it before the next step.
  get world() { this.field.sync(); return this.field; }
  // Where a construction may be put on the field: anywhere along the ground it has, short of its ends.
  get limits() { const { minX, maxX } = this.world.terrain; return { minX: Math.ceil(minX + 20), maxX: Math.floor(maxX - 20) }; }
  // A point to aim at or to shell: anywhere along the field, up into the sky or down into the ground.
  inField(point: unknown): point is Point {
    const ground = this.world.terrain;
    if (point === null || typeof point !== 'object' || !('x' in point) || !('y' in point) || typeof point.x !== 'number' || typeof point.y !== 'number') return false;
    return Number.isFinite(point.x + point.y) && point.x >= ground.minX && point.x <= ground.maxX &&
      Math.abs(point.y) <= AIM_SKY;
  }

  // The sites of the field's ground. Each holds a vein, dug while no base stands too near it: that stills it.
  // Whether none does, leaving the base of one faction out of it (`but`). A faction with no base stills nothing.
  get deposits(): readonly DepositSite[] { return depositsOf(this.field.terrain); }
  squadFor(actor: Actor) { return lookup(this.players, actor.ownerId)?.squad ??
    (this.activities?.drop?.guardianId === actor.id ? this.guardianSquad : null); }
  // One ready balance per physical pile. Geological piles keep their existing map; the event owns its own finite balance.
  pileStock(site: FieldSite) { return site.type === 'airdrop' ? this.activities?.drop?.id === site.id ? activityStock(this.activities.drop) : 0 : this.extracted.get(site.id) ?? 0; }
  setPileStock(site: FieldSite, stock: number) {
    const left = stock > 1e-6 ? stock : 0;
    if (site.type === 'airdrop') { if (this.activities?.drop?.id === site.id && !this.activities.drop.supplies) this.activities.drop.stock = left; }
    else if (left) this.extracted.set(site.id, left); else this.extracted.delete(site.id);
  }
  dug(site: Pick<Deposit, 'x'>, but: Faction | null = null) { return [...this.factions.values()].every(f => f === but || !f.base || Math.abs(f.base.x - site.x) > DEPOSIT_CLEARANCE); }
  // What is left in the vein of a site of the ground: its whole reserve, but for what was dug of it and has not come back yet.
  left(site: Deposit) { return this.veins.get(site.id) ?? site.reserve; }
  // The veins gain back what was dug of them over `seconds` of the field, each at the pace of its own reserve
  // (deposits.ts `recovered`), up to that reserve: a vein whole again is named no longer. An empty vein gives nothing
  // until it gains something back, and then no more than that.
  replenish(seconds: number) {
    for (const [id, left] of this.veins) {
      const site = this.sites.get(id)!, now = recovered(site, left, seconds);
      if (now < site.reserve) this.veins.set(id, now); else this.veins.delete(id);
    }
  }
  // Prefer a source that can supply a first load now. Depleted worlds retain their real, regenerating deposits.
  baseDeposits(material: CargoKind) {
    const sites = this.deposits.filter(site => site.material === material && this.dug(site)),
      ready = sites.filter(site => this.left(site) >= RESERVE_STEP || this.pileStock(site) >= CARGO_STEP);
    return ready.length ? ready : sites;
  }
  // The nearest usable source, without revealing a foreign base that stills another deposit.
  endow(base: Base, material: CargoKind) {
    const far = (site: Deposit) => Math.abs(site.x - base.x);
    return this.baseDeposits(material).sort((a, b) => far(a) - far(b))[0];
  }
  // Initial and reconstructed bases identify iron and petroleum, alongside the veins in the ground the base
  // knows about itself, as they are then. On a field without fog nothing is kept: every vein is known to everybody.
  stake(faction: Faction) {
    const given = STARTING_RESOURCES.map(material => this.endow(faction.base!, material)).filter((site): site is DepositSite => Boolean(site)), time = this.field.time;
    if (!this.fog) return;
    for (const site of new Set([...depositsNear(this.deposits, faction.base!.x, BASE_SIGHT), ...given])) faction.veins!.set(site.id, this.assay(faction, site, time));
  }
  // What a faction that sees a vein learns of it: what is left of it, when that was, and whether the base of another stills it.
  assay(faction: Faction, site: Deposit, time: number) { return { left: this.left(site), stock: this.extracted.get(site.id) ?? 0, at: time, still: !this.dug(site, faction) }; }
  // What a faction knows of the vein of a site: what it learnt when it last saw it, and nothing of a site it never saw.
  // On a field without fog it knows every vein as it is.
  known(faction: Faction, site: Deposit) { return faction.veins ? faction.veins!.get(site.id) ?? null : this.assay(faction, site, this.field.time); }
  // Whether a vein is stilled, as a faction knows: by its own base, or by that of another when it last saw the site.
  // A base founded beside a vein since is not told to whoever neither sees it nor digs there (`felt`).
  stilled(faction: Faction, site: { x: number; id?: string }) { return faction.base !== null && Math.abs(faction.base.x - site.x) <= DEPOSIT_CLEARANCE || Boolean(faction.veins ? lookup(faction.veins, site.id)?.still : !this.dug(site, faction)); }
  // The sites a faction knows the vein of, from one end of the ground to the other: on a field without fog, every one.
  prospected(faction: Faction): DepositSite[] { return faction.veins ? [...faction.veins!.keys()].map(id => this.sites.get(id)!).sort((a, b) => a.x - b.x) : this.deposits.slice(); }
  // Where a base is founded, given where the bases that stand are (`others`): the place a rehearsed field
  // has for it, or one drawn. A base never covers a deposit and uses the best access among its valid draws.
  settle(others: number[]): Base {
    const terrain = this.world.terrain, { minX, maxX } = this.limits, margin = Math.min(END_MARGIN, (maxX - minX) / 4),
      low = minX + margin, high = maxX - margin, taken = others.slice().sort((a, b) => a - b);
    let x = this.site?.(this.founded) ?? null;
    // A base is drawn from the stretches of the world a long march from every other and within reach of the
    // nearest: between two bases, what either reaches, and beyond the first and the last, what that one does.
    // A stretch between two wins an equal access score: abandoned ground is available to the next faction.
    // With no base yet it is drawn about the middle of the world; with no place left, bases come
    // closer. Minimise the worst resource access relative to the economic targets, then total access.
    // No vein is created or moved, and no faction learns a foreign base or an advanced material from this choice.
    const resources = RAW_IDS.map(material =>
      ({ reach: BASE_RESOURCE_REACH[material], sites: this.baseDeposits(material) })).filter(resource => resource.sites.length),
      access = (at: number) => {
        const distances = resources.map(({ reach, sites }) => sites.reduce((near, site) => Math.min(near, Math.abs(site.x - at)), Infinity) / reach);
        return { worst: Math.max(0, ...distances), total: distances.reduce((sum, distance) => sum + distance, 0) };
      };
    for (let spacing = BASE_SPACING; x === null; spacing *= .8) {
      const between: { from: number; room: number }[] = [], beyond: { from: number; room: number }[] = [], stretch = (list: { from: number; room: number }[], from: number, to: number) => { if (to >= from) list.push({ from, room: to - from }); };
      if (!taken.length) stretch(beyond, Math.max(low, terrain.center - BASE_SPACING / 2), Math.min(high, terrain.center + BASE_SPACING / 2));
      else for (let i = 0; i <= taken.length; i++) {
        const left = taken[i - 1] ?? -Infinity, right = taken[i] ?? Infinity, from = Math.max(low, left + spacing), to = Math.min(high, right - spacing),
          list = i && i < taken.length ? between : beyond;
        if (left + BASE_REACH >= right - BASE_REACH) stretch(list, from, to);
        else { stretch(list, from, Math.min(to, left + BASE_REACH)); stretch(list, Math.max(from, right - BASE_REACH), to); }
      }
      let spare: number | null = null, best = { worst: Infinity, total: Infinity };
      for (const free of [between, beyond]) {
        const room = free.reduce((sum, stretch) => sum + stretch.room, 0);
        for (let i = 0; i < 32 && free.length && x === null; i++) {
          let along = this.random() * room, k = 0;
          while (k < free.length - 1 && along > free[k]!.room) along -= free[k++]!.room;
          const drawn = Math.round(free[k]!.from + along);
          if (!taken.every(other => Math.abs(other - drawn) >= spacing) || depositsNear(this.deposits, drawn, DEPOSIT_CLEARANCE).length) continue;
          const score = access(drawn);
          if (spare === null || score.worst < best.worst || score.worst === best.worst && score.total < best.total) { spare = drawn; best = score; }
        }
      }
      x ??= spare;
    }
    this.founded++;
    return { x, facing: x > terrain.center ? -1 : 1 };
  }
  // The bases of every faction that has one: what a base is drawn away from.
  bases() { return [...this.factions.values()].filter(f => f.base).map(f => f.base!.x); }
  // The posts of a faction (territory.ts), but `ignore`: those it has (`faction.posts`), but one being taken down, which is
  // a post no longer for its territory, its services or its limit.
  posts(faction: Faction, ignore: string | null = null) { return faction.posts.filter(post => post.id !== ignore && !post.takedown); }
  // Where the posts of a faction stand and the works of its posts are, but `ignore`: what another post of it keeps from, and
  // how many it has for its limit (`POST_LIMIT`).
  postPlaces(faction: Faction, ignore: string | null = null) {
    return [...this.posts(faction, ignore).map(post => post.x),
      ...this.works.of(faction.id).filter(work => work.post && work.id !== ignore).map(work => work.x)];
  }
  // The post of this name, whoever's it is, or nothing.
  post(id: string) {
    for (const faction of this.factions.values()) for (const post of faction.posts) if (post.id === id) return post;
    return null;
  }
  // The territory of a faction (territory.ts): about its base and its posts, but `ignore`.
  territory(faction: Faction, ignore: string | null = null) { return territoryOf(faction.base?.x ?? null, this.posts(faction, ignore).map(post => post.x)); }
  // The territories a faction is told of, each in the colour of the faction it is of — its leader's —: its own and its allies'
  // whole, and of every other what lies in the ground it has explored, which tells it nothing of a base it never saw.
  territories(faction: Faction) {
    return [...this.factions.values()].flatMap(other => {
      const kind = other === faction ? 'own' : this.allied(faction.id, other.id) ? 'ally' : 'other', spans = this.territory(other),
        told = kind === 'other' && this.fog ? meeting(spans, faction.explored ?? []) : spans;
      return told.length ? [{ kind, color: this.players.get(other.leader)?.color ?? null, spans: told }] : [];
    });
  }
  // A faction starts with a base and an empty yard, where what its constructions bring waits for the refinery.
  // Initial stocks and vehicles are granted only to a newly created player (`join`), never by founding another faction.
  // It knows no other faction yet (`acquaint`),
  // nor the base nor the posts of any (`reconnoitre`). Of the ground it has explored what lies about its base, and sees none
  // yet (`explore`): on a field without fog none of that is kept.
  // Of the veins it knows those about its base (`stake`), and from then on what it sees of them (`prospect`). Nobody is
  // taking its base, it took none and lost none (`besiege`), and it never recovered (`recover`). It has no post, and took
  // and lost none. The player leads it, with no administrators (`member`), and it goes by
  // the leader's name, under a flag drawn for it (`flagDraw`). It was founded for nobody removed from another (`removed`).
  // It is away from now while the player is (`away`), it never fought, and its base is not sheltered (`shelter`). Whoever
  // asks to join it is told it by a name made of the same draw (`factionRef`), and its library has no project yet.
  // Returns it.
  found(player: Player, draw: string = flagDraw()): Faction {
    const base = this.settle(this.bases()), faction: Faction = { id: this.mint('f'), ref: factionRef(draw), leader: player.id, admins: new Set(), nation: null, flag: defaultFlag(draw), stock: bill(), yard: load(), refinedAt: null, base,
      fell: null, recovered: null, removed: null, capture: null, taken: null, away: this.active(player) ? null : this.field.time, fought: null, shelter: null,
      posts: [], lost: null, seized: null, industry: newIndustry(this.startingIndustry), members: new Set([player.id]), invited: new Set(), met: new Map(), library: [], chat: [],
      explored: this.fog && this.surroundings(base.x), seen: [], eyes: this.fog && new GroundSight(this.field.terrain), veins: this.fog && new Map(), bases: this.fog && new Map(),
      outposts: this.fog && new Map() };
    this.factions.set(faction.id, faction); player.factionId = faction.id; this.stake(faction); this.apron(base);
    return faction;
  }
  // A base is founded on an apron of asphalt: its whole stretch is paved.
  apron(base: Base) { this.pave(base.x - BASE_RADIUS, base.x + BASE_RADIUS, 'asphalt'); }
  // Lays a road over the ground of the field, from `x0` up to `x1`, of `kind` — graded earth or asphalt (roads.ts) —, over
  // whatever road was there: the ground there is the road's from the next step, as every faction is told it. Returns the
  // roads of the field.
  pave(x0: number, x1: number, kind: import('../src/roads.ts').RoadKind) { return this.field.pave(x0, x1, kind); }
  // The ground a base knows about itself, in the cells explored ground is kept by.
  surroundings(x: number) {
    const { minX, maxX } = this.field.terrain;
    return clip(quantise([[x - BASE_SIGHT, x + BASE_SIGHT]], EXPLORED_GRID), minX, maxX);
  }
  // What establishing a base costs a faction that has none: `BASE_SHARE` of each stock a faction is founded with.
  baseCost() { return bill(...STOCK_IDS.map(id => Math.round(this.grant[id] * BASE_SHARE))); }
  // Subsidies belong to the faction and all members who benefited from them.
  // A member's history survives a split; older saves still supply their faction's recorded date.
  subsidyAt(faction: Faction): number | null {
    let at = lastAidAt(faction.recovered);
    for (const id of faction.members) {
      const memberAt = this.players.get(id)!.aidAt;
      if (memberAt != null && (at === null || memberAt > at)) at = memberAt;
    }
    return at;
  }
  // Aid covers the shortage for a base where needed, a catalogue ore lorry with its tank full, and two more tankfuls
  // kept in stocks. Another subsidy waits 30 minutes of simulation; paid recovery has no such wait. A standing
  // construction refuses recovery separately. Older positive aid records carry their real event time until aidAt is kept.
  recovery(faction: Faction): RecoveryOffer | null {
    if (this.ended) return null;
    const lorry = lorryBill(), reserve = bill(0, 0, 0, 2 * lorry.combustivel), means = billSum(faction.stock, refined(faction.yard)),
      base = faction.base ? null : this.baseCost(), short = Boolean(shortMessage(billSum(means, base ?? bill(), -1), billSum(lorry, reserve)));
    if (!base && !short) return null;
    const needed = billSum(billSum(base ?? bill(), short ? lorry : bill()), short ? reserve : bill()),
      aid = bill(...STOCK_IDS.map(id => Math.max(0, Math.ceil(needed[id] - means[id] - 1e-6)))),
      standing = this.enlisted(faction).length > 0, aidAt = this.subsidyAt(faction),
      wait = !standing && billTotal(aid) > 0 && aidAt !== null ? Math.max(0, aidAt + 30 * 60 - this.field.time) : 0;
    return { base, lorry: short ? lorry : null, reserve: short ? reserve.combustivel : 0, aid,
      offered: !standing && wait === 0, ...(wait > 0 ? { wait } : {}) };
  }
  // A name for whatever comes into the field — a player (`j`), a faction (`f`), a construction (`c`) —, by the count of its
  // kind: never given to two things the field holds, and telling nobody how many of another kind came.
  mint(kind: SerialKind) { return kind + ++this.serials[kind]; }
  // The name of its nation and its flag are a faction's to give itself: any member's, for all of them. A name
  // another faction on the field goes by is not taken, whether this one has met it or not: every faction is told the
  // names of all the others (`factionView`), and the refusal tells it nothing more. An empty one gives the faction back its leader's.
  identity(p: Player, { nation, flag }: Pick<RoomRequest, 'nation' | 'flag'>) {
    const faction = this.faction(p), name = nationName(nation), made = validFlag(flag), same = name?.toLocaleLowerCase('pt-BR');
    if (name && [...this.factions.values()].some(other => other !== faction && other.nation?.toLocaleLowerCase('pt-BR') === same)) throw userError('Já há uma facção com esse nome no campo.');
    faction.nation = name; faction.flag = made;
    return {};
  }
  // A member recovers the same faction at its existing base, or a new one with ore and petroleum about it. Costs and
  // the fuel reserve use stocks, then the refined yard, with aid only for the shortage. Paying and crediting the reserve
  // transfers its refined yard share into stocks without increasing net aid. Paid recovery carries the last aidAt;
  // at remains the latest recovery event, so its notice is independent of the subsidy interval.
  recover(p: Player) {
    const faction = this.faction(p), offer = this.recovery(faction);
    if (!offer?.offered && (offer?.wait ?? 0) > 0) throw userError`Novo auxílio subsidiado em ${Math.ceil(offer!.wait!)} s de jogo.`;
    if (!offer?.offered) throw userError(
      offer ? 'A facção ainda tem construções no campo: o auxílio é para quem não tem nenhuma.' :
        'Os estoques e o pátio da facção pagam um caminhão de minério: fabrique-o na Oficina.');
    // Refuse an invalid catalogue design before aid, payment, base work or mint.
    const prepared = offer.lorry ? manufactureDesign(this.validateDesign(createStructuredTemplate('mining-truck'))) : null,
      from = offer.base ? faction.fell!.from : null, reserve = bill(0, 0, 0, offer.reserve),
      subsidized = billTotal(offer.aid) > 0, aidAt = subsidized ? this.field.time : this.subsidyAt(faction);
    credit(faction.stock, offer.aid);
    this.spend(faction, billSum(billSum(offer.base ?? bill(), offer.lorry ?? bill()), reserve));
    credit(faction.stock, reserve);
    if (offer.base) {
      faction.base = this.settle([...this.bases(), from!]); this.apron(faction.base);
      if (this.fog) faction.explored = unite(faction.explored!, this.surroundings(faction.base.x));
      this.stake(faction);
    }
    const lorry = prepared && this.furnish(p, prepared);
    faction.recovered = { at: this.field.time, base: offer.base ? faction.base!.x : null, from, lorry: Boolean(lorry), aid: offer.aid,
      ...(aidAt === null ? {} : { aidAt }) };
    if (subsidized) for (const id of faction.members) this.players.get(id)!.aidAt = aidAt!;
    if (lorry) { this.release(p.id); this.claim(p, [lorry]); p.selected = lorry.id; this.take(p, null); }
    return { base: this.base(p), selected: p.selected, ...(lorry ? { actor: this.design(lorry) } : {}) };
  }
  // Takes a bill from a faction whose stocks and yard hold all it asks: from the stocks first, and what they lack from the
  // yard, as much of it as the refinery makes into that stock (`YIELD`).
  spend(faction: Faction, cost: SupplyBill) {
    for (const id of STOCK_IDS) {
      const stocks = Math.min(cost[id], Math.max(0, faction.stock[id])), raw = SUPPLIED[id];
      faction.stock[id] -= stocks; faction.yard[raw] = Math.max(0, faction.yard[raw] - (cost[id] - stocks) / YIELD[raw]);
    }
  }
  faction(player: Player): Faction { return this.factions.get(player.factionId!)!; }
  // The base: where the faction's constructions come into the field and are serviced. Nothing for a faction that has none.
  base(player: Player) {
    const base = this.faction(player).base;
    return base && { x: base.x, y: this.world.terrain.height(base.x), facing: base.facing, radius: BASE_RADIUS };
  }
  enlisted(faction: Faction) { return this.world.actors.filter(a => faction.members.has(a.ownerId ?? '')); }
  // What a faction has of each kind for its limits: its vehicles, and its structures with its works, each a structure from
  // the moment it is opened. A structure taken down to be moved counts no more: its works does. `ignore` names a works or
  // a construction not counted — the works being finished, the structure being moved. A post is no structure, nor is the
  // works of one: posts have a limit of their own (territory.ts `POST_LIMIT`).
  constructionCounts(faction: Faction, ignore: string | null = null) {
    const counts = { vehicles: 0, fixed: 0 };
    for (const actor of this.enlisted(faction)) if (actor.id !== ignore && !dismantleTarget(this.records.get(actor.id)?.service))
      counts[isVehicleDesign(actor.construction) ? 'vehicles' : 'fixed']++;
    for (const work of this.works.of(faction.id)) if (work.id !== ignore && !work.post) counts.fixed++;
    return counts;
  }
  // The constructions of a faction are all its members': the fleet, in the order they came to the field. Each is in the squad of
  // one member (its `ownerId`), which carries out its orders; whoever gives it an order, takes it in hand, has a service done to
  // it or makes it holds it (`claim`) until letting it go (`unclaim`), leaving the field or the faction, and it goes on with
  // its orders meanwhile. One nobody holds is free: any member takes it, and it comes into that one's squad as it stands.
  fleet(faction: Faction) { return this.fielded().filter(a => faction.members.has(a.ownerId ?? '')); }
  // The member who holds a construction, or nobody for one that is free.
  holding(actor: Actor) { return this.reserved.has(actor.id) ? lookup(this.players, actor.ownerId) : null; }
  // Whether a construction is one of the player's faction that no other member holds: one the player may have.
  usable(p: Player, actor: Actor | null | undefined): actor is Actor {
    const holder = actor && this.holding(actor);
    return actor != null && Boolean(this.faction(p)?.members.has(actor.ownerId ?? '')) && (!holder || holder === p);
  }
  // Refuses, in words, a construction another member holds.
  vacant(p: Player, actor: Actor) { const holder = this.holding(actor); if (holder && holder !== p) throw userError(heldBy(holder)); }
  // The player takes constructions of the faction (`vacant`): those in the squad of another member come into the player's, with
  // the orders they had (`hand`), and the player holds every one of them from then on.
  claim(p: Player, actors: Actor[]) {
    for (const actor of actors) this.vacant(p, actor);
    const kept = new Map<string, Actor[]>();
    for (const actor of actors) if (actor.ownerId !== p.id) kept.set(actor.ownerId!, [...kept.get(actor.ownerId!) ?? [], actor]);
    for (const [id, given] of kept) this.hand(this.players.get(id)!, given, p);
    for (const actor of actors) this.reserved.add(actor.id);
  }
  // The player lets go of what they hold: those of `ids`, or all of it. Each goes on as it was, free for any member.
  unclaim(p: Player, ids: string[] | null = null) { for (const actor of this.owned(p.id)) if (!ids || ids.includes(actor.id)) this.reserved.delete(actor.id); }
  // The name a faction goes by while its nation has none: its leader's.
  named(faction: Faction) { return this.players.get(faction.leader)?.name || 'Facção'; }
  // What a player is to a faction: its leader, an administrator of it or a member (`member`).
  role(faction: Faction, playerId: string): 'leader' | 'admin' | 'member' { return playerId === faction.leader ? 'leader' : faction.admins.has(playerId) ? 'admin' : 'member'; }
  // Out of a faction, for another or for one of the player's own. The player lets go of what they held (`unclaim`), and
  // what was in their squad stays with the faction, free, in the leader's squad from then on (`hand`); should the player have
  // led it, the leadership goes to the administrator who came into it first, or with none, to the member who did. With
  // nobody left in it the faction is gone, with its stocks, its base and its library, and its constructions leave the field
  // with what they carry: that would be stocks carried across. A faction the player was the last of on the field is away from
  // then on (`depart`). The player is invited nowhere any longer, and asks to join nowhere (`request`). Returns the
  // constructions of the faction, which the player has no longer.
  leave(player: Player) {
    const faction = this.faction(player), owned = this.owned(player.id), ids = this.fleet(faction).map(actor => actor.id);
    const aidAt = this.subsidyAt(faction);
    if (aidAt !== null) player.aidAt = aidAt;
    this.release(player.id); this.take(player, null); this.unclaim(player);
    faction.members.delete(player.id); faction.admins.delete(player.id);
    if (!faction.members.size) { for (const id of ids) this.discard(id); this.disband(faction); }
    else {
      if (faction.leader === player.id) faction.leader = [...faction.members].find(id => faction.admins.has(id)) ?? [...faction.members][0]!;
      faction.admins.delete(faction.leader);
      this.hand(player, owned, this.players.get(faction.leader)!);
      this.depart(faction);
    }
    for (const other of this.factions.values()) other.invited.delete(player.id);
    player.factionId = null; player.selected = null; player.request = null; player.squad!.sync();
    return ids;
  }
  // Constructions in the squad of a member pass to the squad of another of the faction as they stand, under that one's name
  // and colour, with the orders they had: the job one went on by itself (`SupplyDispatch`) it is given again for its new squad.
  hand(from: Player, actors: Actor[], to: Player) {
    const orders = actors.map((actor): [string, SquadUnit | undefined] => { this.supplyDispatch.cancel(actor.id); return [actor.id, from.squad!.units.get(actor.id)]; });
    for (const actor of actors) {
      Object.assign(actor, { ownerId: to.id, color: to.color, playerName: to.name });
      if (from.selected === actor.id) from.selected = null;
    }
    from.squad!.sync(); to.squad!.sync();
    for (const [id, unit] of orders) if (unit) Object.assign(to.squad!.units.get(id)!, unitOrders(unit));
  }
  // A player out of a faction (`leave`) has an empty faction and base of their own.
  // Starting over socially never grants stocks or vehicles; recovery uses the member's existing subsidy history.
  part(p: Player, draw: string) {
    const removed = this.leave(p), faction = this.found(p, draw);
    return { removed, faction };
  }
  // A player leaves the faction for one of their own (`part`). That is a new faction of the player's address
  // (`newcomer`), refused once those of the day are spent; and it is refused to the only member of a faction, who would
  // only start again.
  quit(p: Player, draw: string) {
    if (this.faction(p).members.size === 1) throw userError('Você é o único membro da facção.');
    if (p.address != null && this.newcomersOf(p.address).length >= ROOM_LIMITS.newPerAddressPerDay) throw userError(SPENT);
    this.newcomer(p.address ?? null);
    return { removed: this.part(p, draw).removed, selected: p.selected, base: this.base(p) };
  }
  // What the leader of a faction and its administrators do to the others of it (`act`), by what each is to it (`role`):
  // the leader removes anyone, makes a member an administrator (`admin`) or an administrator a member again (`member`),
  // and hands the leadership over (`leader`), to go on as an administrator; an administrator removes those who are
  // neither; a member does none of it. Whoever is removed has a faction of their own from then on (`part`), whatever
  // the new factions of their address, which is told where the player was removed from, as that faction was named then (`removed`).
  member(p: Player, playerId: unknown, act: unknown, draw: string) {
    const faction = this.faction(p), other = typeof playerId === 'string' && faction.members.has(playerId) ? this.players.get(playerId) : null,
      mine = this.role(faction, p.id);
    if ((typeof act !== 'string' || !['remove', 'admin', 'member', 'leader'].includes(act))) throw userError('Ação inválida.');
    if (!other) throw userError('Esse jogador já não é da facção.');
    if (other === p) throw userError('Escolha outro membro da facção.');
    const theirs = this.role(faction, other.id);
    if (act === 'remove') {
      if (mine === 'member') throw userError('Só o líder e os administradores removem membros.');
      if (theirs === 'leader') throw userError('O líder não pode ser removido.');
      if (theirs === 'admin' && mine !== 'leader') throw userError('Só o líder remove administradores.');
      const from = { name: this.named(faction), nation: faction.nation ?? null };
      this.part(other, draw).faction.removed = { at: this.field.time, from };
      return {};
    }
    if (mine !== 'leader') throw userError(act === 'leader' ? 'Só o líder passa a liderança.' : 'Só o líder nomeia e tira administradores.');
    if (act === 'leader') { faction.admins.delete(other.id); faction.admins.add(p.id); faction.leader = other.id; }
    else if (act === 'admin') faction.admins.add(other.id);
    else faction.admins.delete(other.id);
    return {};
  }
  // A faction that is gone takes what it knew of the field with it, and no other knows it, its base or its posts any longer:
  // those go with it. A capture it had under way is over, and so is every request to join it. Its works and its heaps go
  // with its stocks.
  disband(faction: Faction) {
    const shared = [...this.accords.values()].some(a => a.kind === 'alliance' && a.acceptedAt !== null && (a.from === faction.id || a.to === faction.id));
    this.factions.delete(faction.id); this.fog?.forget(faction.id); this.watch?.forget(faction.id); this.works.clear(faction.id);
    this.roadworks.clear(faction.id);
    for (const post of faction.posts) this.lookouts.delete(post.id);
    if (faction.posts.length) this.topology++;
    for (const records of [this.trades, this.accords]) for (const [id, record] of records)
      if (record.from === faction.id || record.to === faction.id) records.delete(id);
    for (const other of this.factions.values()) {
      other.met.delete(faction.id); other.bases?.delete(faction.id); if (other.capture?.by === faction.id) other.capture = null;
      for (const [id, known] of other.outposts ?? []) if (known.of === faction.id) other.outposts!.delete(id);
      for (const post of other.posts) if (post.capture?.by === faction.id) post.capture = null;
    }
    for (const p of this.players.values()) if (p.request === faction.id) p.request = null;
    if (shared) this.syncAlliances();
  }
  // An invitation goes to a player the faction is told of (`factionView`): a member of a faction it has met, or anybody
  // else who is on the field. One it is not told of is nobody to it, as one that never came is, and the refusal is the same
  // however it is asked: the name of a player says nothing of who else came or is away. What it invited it can always call off.
  invite(p: Player, playerId: unknown, cancel: boolean) {
    const faction = this.faction(p), other = lookup(this.players, playerId),
      told = other != null && (other.factionId === faction.id || faction.met.has(other.factionId!) || this.present(other));
    if (cancel && typeof playerId === 'string' && faction.invited.delete(playerId)) return {};
    if (!other || !told || other.id === p.id) throw userError('Jogador não encontrado.');
    if (other.factionId === faction.id) throw userError('Esse jogador já é da sua facção.');
    if (!cancel) faction.invited.add(other.id);
    return {};
  }
  // A player invited into another faction joins it (`transfer`).
  enlist(p: Player, factionId: unknown) {
    const next = lookup(this.factions, factionId);
    if (!next?.invited.has(p.id)) throw userError('Esse convite já não vale.');
    return { removed: this.transfer(p, next), selected: null, base: this.base(p) };
  }
  // Whoever joins another faction brings nothing: the stocks stay behind, and so do the constructions of the faction (`leave`).
  // A player who is on the field brings the faction there with them (`arrive`). Returns the constructions the player has no longer.
  transfer(p: Player, next: Faction) {
    const removed = this.leave(p);
    next.members.add(p.id); p.factionId = next.id; p.squad!.sync();
    if (this.active(p)) this.arrive(next);
    return removed;
  }
  // A player asks to join another faction, named as every player is told it (`ref`, `factionView`), whether theirs met it or
  // not; or calls the request off. A player has one request at a time: the last replaces the one before, and the player goes on
  // in their own faction meanwhile. A faction that invited the player is joined by its invitation.
  apply(p: Player, ref: unknown, cancel: boolean) {
    if (cancel) { p.request = null; return {}; }
    const faction = typeof ref === 'string' ? [...this.factions.values()].find(f => f.ref === ref) : null;
    if (!faction) throw userError('Essa facção já não está no campo.');
    if (faction.id === p.factionId) throw userError('Você já é dessa facção.');
    if (faction.invited.has(p.id)) throw userError('Essa facção já convidou você: aceite o convite no alto da página.');
    p.request = faction.id;
    return {};
  }
  // The leader of a faction or an administrator of it answers a request to join it (`apply`): accepted, the player joins it
  // (`transfer`), connected or not; refused, the request is over. A member answers none.
  answer(p: Player, playerId: unknown, accept: boolean) {
    const faction = this.faction(p), other = typeof playerId === 'string' ? this.players.get(playerId) : null;
    if (this.role(faction, p.id) === 'member') throw userError('Só o líder e os administradores respondem aos pedidos.');
    if (other?.request !== faction.id) throw userError('Esse pedido já não vale.');
    other.request = null;
    if (accept) this.transfer(other, faction);
    return {};
  }
  // The leader and administrators speak for their faction. Their authority is checked when each command arrives.
  represent(p: Player) {
    const faction = this.faction(p);
    if (this.role(faction, p.id) === 'member') throw userError('Só o líder e os administradores representam a facção.');
    return faction;
  }
  counterpart(p: Player, ref: unknown) {
    const other = typeof ref === 'string' && [...this.factions.values()].find(f => f.ref === ref);
    if (!other) throw userError('Essa facção já não está no campo.');
    if (other.id === p.factionId) throw userError('Escolha outra facção.');
    return other;
  }
  // Only pending offers exist. Both stocks are checked before either is written; removing the offer prevents a second transfer.
  trade(p: Player, { act, id, ref, give, want }: Pick<RoomRequest, 'act' | 'id' | 'ref' | 'give' | 'want'>) {
    const faction = this.represent(p);
    if (act === 'offer') {
      const other = this.counterpart(p, ref), sends = tradeBill(give), asks = tradeBill(want);
      if (!STOCK_IDS.some(stock => sends[stock] || asks[stock])) throw userError('Inclua recursos na oferta.');
      const same = [...this.trades.values()].find(t => t.from === faction.id && t.to === other.id &&
        STOCK_IDS.every(stock => t.give[stock] === sends[stock] && t.want[stock] === asks[stock]));
      if (same) return { offered: same.id };
      if ([faction, other].some(f => [...this.trades.values()].filter(t => t.from === f.id || t.to === f.id).length >= SOCIAL_LIMITS.offers))
        throw userError`Cada facção mantém até ${SOCIAL_LIMITS.offers} ofertas: encerre uma antes de propor outra.`;
      this.afford(faction, sends, phrase('oferecer'));
      const offer = { id: this.mint('t'), from: faction.id, to: other.id, give: sends, want: asks };
      this.trades.set(offer.id, offer); return { offered: offer.id };
    }
    if ((typeof act !== 'string' || !['accept', 'cancel'].includes(act))) throw userError('Ação inválida.');
    const offer = lookup(this.trades, id);
    if (!offer || offer.from !== faction.id && offer.to !== faction.id || act === 'accept' && offer.to !== faction.id)
      throw userError('Essa oferta já não está disponível.');
    if (act === 'cancel') { this.trades.delete(offer.id); return { cancelled: id }; }
    const from = this.factions.get(offer.from), to = this.factions.get(offer.to);
    if (!from || !to) throw userError('Essa oferta já não está disponível.');
    this.afford(to, offer.want, phrase('aceitar a troca'));
    if (shortMessage(from.stock, offer.give)) throw userError('A outra facção já não tem os recursos da oferta.');
    const nextFrom = billSum(billSum(from.stock, offer.give, -1), offer.want),
      nextTo = billSum(billSum(to.stock, offer.want, -1), offer.give);
    // Affordability above owns the economy's rounding tolerance. As credit does, keep the fractional remainder of each debit.
    if ([nextFrom, nextTo].some(stock => STOCK_IDS.some(key => !Number.isFinite(stock[key]) || stock[key] > Number.MAX_SAFE_INTEGER)))
      throw userError('Os estoques não comportam essa troca.');
    Object.assign(from.stock, nextFrom); Object.assign(to.stock, nextTo); this.trades.delete(offer.id);
    return { traded: id };
  }
  // A proposal is the first faction's consent. Once the second accepts, the commitment is public until either ends it.
  accord(p: Player, { act, id, ref, text, kind }: Pick<RoomRequest, 'act' | 'id' | 'ref' | 'text' | 'kind'>) {
    const faction = this.represent(p);
    if (act === 'propose') {
      if (kind !== undefined && (typeof kind !== 'string' || !['declaration', 'alliance'].includes(kind))) throw userError('Tipo de acordo inválido.');
      const other = this.counterpart(p, ref), alliance = kind === 'alliance', terms = alliance ? ALLIANCE_TERMS : socialText(text),
        same = [...this.accords.values()].find(a => alliance ? a.kind === 'alliance' &&
          (a.from === faction.id && a.to === other.id || a.to === faction.id && a.from === other.id) :
          a.kind !== 'alliance' && a.from === faction.id && a.to === other.id && a.text === terms && a.acceptedAt === null);
      if (same) return { proposed: same.id };
      if ([faction, other].some(f => [...this.accords.values()].filter(a => a.from === f.id || a.to === f.id).length >= SOCIAL_LIMITS.accords))
        throw userError`Cada facção mantém até ${SOCIAL_LIMITS.accords} acordos e propostas: encerre um antes de propor outro.`;
      const accord: Accord = { id: this.mint('a'), from: faction.id, to: other.id, text: terms, acceptedAt: null, ...(alliance ? { kind: 'alliance' } : {}) };
      this.accords.set(accord.id, accord); return { proposed: accord.id };
    }
    if ((typeof act !== 'string' || !['accept', 'end'].includes(act))) throw userError('Ação inválida.');
    const accord = lookup(this.accords, id);
    if (!accord || accord.from !== faction.id && accord.to !== faction.id || act === 'accept' && (accord.to !== faction.id || accord.acceptedAt !== null))
      throw userError('Esse acordo já não está disponível para esta ação.');
    if (act === 'end') {
      this.accords.delete(accord.id);
      if (accord.kind === 'alliance' && accord.acceptedAt !== null) this.syncAlliances();
      return { ended: id };
    }
    if ((kind ?? 'declaration') !== (accord.kind ?? 'declaration'))
      throw userError('Confirme o tipo de acordo proposto antes de aceitar.');
    accord.acceptedAt = this.field.time;
    if (accord.kind === 'alliance') this.syncAlliances();
    return { accepted: id };
  }
  // A direct intelligence grant never changes ownership, physical teams or another ally's own grants.
  allied(a: string | null | undefined, b: string | null | undefined) {
    return a !== b && [...this.accords.values()].some(row => row.kind === 'alliance' && row.acceptedAt !== null &&
      (row.from === a && row.to === b || row.from === b && row.to === a));
  }
  intelligenceSources(factionId: string) {
    return [...this.factions.values()].filter(f => f.id === factionId || this.allied(factionId, f.id));
  }
  // The base has already measured these reports. Consult its own book only while it grants this faction access;
  // never copy a source's derived contacts or follow its grants. A public ref namespaces anonymous mark ids.
  batteryMarks(factionId: string, time: number, known: ReadonlySet<string> | null = null, automatic = false) {
    const permit = automatic ? (actorId: string) => {
      const actor = this.world.actor(actorId);
      return !actor || actor.team !== factionId && !this.allied(factionId, actor.team);
    } : null;
    return this.intelligenceSources(factionId).flatMap(source => (this.watch?.marks(source.id, time, known, permit) ?? [])
      .map(mark => source.id === factionId ? mark : { ...mark, id: `battery:${source.ref}:${mark.id}` }));
  }
  batterySource(factionId: string, markId: string) {
    for (const source of this.intelligenceSources(factionId)) {
      const prefix = `battery:${source.ref}:`, id = source.id === factionId ? markId : markId?.startsWith(prefix) ? markId.slice(prefix.length) : null,
        actorId = id && this.watch?.source(source.id, id);
      if (actorId) return actorId;
    }
    return null;
  }
  syncAlliances(look = true) {
    const pairs = [...this.accords.values()].filter(a => a.kind === 'alliance' && a.acceptedAt !== null).map(a => [a.from, a.to]);
    this.world.game().call({ op: 'alliances', pairs, frame: false });
    for (const player of this.players.values()) if (player.squad!) player.squad!.sampled = null;
    for (const player of this.players.values()) for (const [id, unit] of player.squad?.units ?? []) {
      const actor = this.world.actor(id), targetId = unit.targetId || unit.counter?.id && this.batterySource(player.factionId!, unit.counter.id),
        target = targetId && this.world.actor(targetId);
      if (!actor || !target || player.squad!.manual === id || unit.attack || !this.allied(actor.team, target.team)) continue;
      // Only fire chosen by the pilot is let go. Movement and explicit/manual input retain their authority.
      player.squad!.side.input(id, { type: 'trigger', active: false, cancel: true });
      if (unit.counter) unit.counters.delete(unit.counter.id);
      unit.targetId = unit.counter = null;
    }
    if (look && this.fog) this.sight(this.steps, true);
  }
  // Faction ids and stocks are private. Public agreements and the participants' offers use only the identities already public in the ranking.
  socialView<R extends Trade | Accord>(records: Map<string, R>, faction: Faction, publicAccepted = false) {
    const identity = (id: string) => { const f = this.factions.get(id)!; return { ref: f.ref, name: this.named(f), nation: f.nation ?? null, flag: f.flag }; };
    return [...records.values()].filter(record => record.from === faction.id || record.to === faction.id || publicAccepted && record.acceptedAt !== null)
      .map(record => ({ ...record, from: identity(record.from), to: identity(record.to) }));
  }
  // A message goes to everyone (`global`), to the writer's faction (`faction`), or to it and every faction allied to it
  // when it is sent (`allies`). An allies message names the public refs of the allies it went to (`to`) and is kept,
  // as one record, in the conversation of each of those factions and of the writer's: an alliance that ends later takes
  // nothing back of what was said, and one made later shows nothing said before it.
  say(p: Player, { scope, text }: Pick<RoomRequest, 'scope' | 'text'>) {
    if (scope !== 'faction' && scope !== 'allies' && scope !== 'global') throw userError('Escolha Facção, Aliados ou Global.');
    const words = socialText(text), faction = this.faction(p),
      allies = scope === 'allies' ? [...this.factions.values()].filter(f => this.allied(faction.id, f.id)) : [];
    if (scope === 'allies' && !allies.length) throw userError('Sua facção não tem aliados.');
    if (this.steps - (p.chatAt ?? -Infinity) < SOCIAL_LIMITS.chatSteps) throw userError('Aguarde um instante para enviar outra mensagem.');
    const message: ChatMessage = { id: this.mint('m'), scope, of: faction.ref, nation: faction.nation || `Facção de ${this.named(faction)}`, by: p.name, text: words, at: this.field.time,
        ...(scope === 'allies' ? { to: allies.map(f => f.ref) } : {}) },
      lists = scope === 'global' ? [this.chat] : [faction, ...allies].map(f => f.chat);
    for (const list of lists) { list.push(message); if (list.length > SOCIAL_LIMITS.history) list.shift(); }
    p.chatAt = this.steps;
    return { chat: message };
  }
  // Recent history travels on arrival or faction change, never with the frequently quoted economy. The faction's
  // conversation holds what was said to it and to its allies, by it or by them.
  chatView(playerId: string) {
    const p = this.players.get(playerId), faction = p && this.faction(p);
    return faction ? { ref: faction.ref, global: this.chat, faction: faction.chat } : { ref: null, global: [], faction: [] };
  }
  receivesChat(playerId: string, message: ChatMessage) {
    const p = this.players.get(playerId), ref = p && this.faction(p)?.ref;
    return Boolean(p?.connected && (message.scope === 'global' || message.scope === 'faction' && ref === message.of ||
      message.scope === 'allies' && (ref === message.of || message.to?.includes(ref!))));
  }
  // These fields are optional in save25. A new collection with no valid counter is refused instead of reusing ids.
  resumeSocial(kept: RoomSave) {
    const invalid = (): never => { throw new Error('Campo salvo com comunicação, ofertas ou acordos inválidos.'); },
      kinds = { t: 'trades', a: 'accords', m: 'chat' } as const;
    for (const kind of ['t', 'a', 'm'] as const) {
      const key = kinds[kind], counter = kept.serials[kind], present = Object.hasOwn(kept, key) || kind === 'm' && kept.factions.some(f => Object.hasOwn(f, 'chat'));
      if ((present || Object.hasOwn(kept.serials, kind)) && (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0)) invalid();
    }
    const named = (id: unknown, kind: SerialKind): id is string => typeof id === 'string' && new RegExp(`^${kind}[1-9]\\d*$`).test(id) &&
      Number.isSafeInteger(Number(id.slice(1))) && Number(id.slice(1)) <= this.serials[kind];
    const restore = <T extends Trade | Accord>(input: readonly T[] | undefined, kind: 't' | 'a', map: Map<string, T>, limit: number, admit: (row: T) => void): void => {
      const rows = input === undefined ? [] : input;
      if (!arrayShape(rows) || rows.length > this.factions.size * limit) invalid();
      for (const source of rows) {
        const row = structuredClone(source);
        if (!row || !named(row.id, kind) || map.has(row.id) || row.from === row.to || !this.factions.has(row.from) || !this.factions.has(row.to)) invalid();
        admit(row); map.set(row.id, row);
      }
      for (const f of this.factions.values()) if ([...map.values()].filter(row => row.from === f.id || row.to === f.id).length > limit) invalid();
    };
    restore(kept.trades, 't', this.trades, SOCIAL_LIMITS.offers, row => {
      row.give = tradeBill(row.give); row.want = tradeBill(row.want);
      if (!STOCK_IDS.some(stock => row.give[stock] || row.want[stock])) invalid();
    });
    restore(kept.accords, 'a', this.accords, SOCIAL_LIMITS.accords, row => {
      if (row.kind !== undefined && !['declaration', 'alliance'].includes(row.kind)) invalid();
      row.text = socialText(row.text);
      if (row.kind === 'alliance' && [...this.accords.values()].some(a => a.kind === 'alliance' &&
        (a.from === row.from && a.to === row.to || a.from === row.to && a.to === row.from))) invalid();
      if (row.acceptedAt !== null && (!Number.isFinite(row.acceptedAt) || row.acceptedAt < 0)) invalid();
    });
    this.chat = structuredClone(kept.chat === undefined ? [] : kept.chat);
    const ids = new Map<string, string | null>();
    const conversations: [ChatMessage[], string | null][] = [[this.chat, null], ...[...this.factions.values()].map((f): [ChatMessage[], string] => [f.chat, f.ref])];
    for (const [list, ref] of conversations) {
      if (!Array.isArray(list) || list.length > SOCIAL_LIMITS.history) invalid();
      for (const message of list) {
        if (!message || !named(message.id, 'm') || typeof message.of !== 'string' || typeof message.by !== 'string' ||
          typeof message.nation !== 'string' || !Number.isFinite(message.at) || message.at < 0) invalid();
        const allies = message.scope === 'allies', to = message.to, said = JSON.stringify(message);
        if (ref === null ? message.scope !== 'global' : message.scope === 'faction' ? message.of !== ref : !allies ||
          !Array.isArray(to) || !to.length || to.some(other => typeof other !== 'string' || other === message.of) || new Set(to).size !== to.length ||
          message.of !== ref && !to.includes(ref)) invalid();
        if (ids.has(message.id) && !(allies && ids.get(message.id) === said)) invalid();
        socialText(message.text); ids.set(message.id, allies ? said : null);
      }
    }
  }
  // The library of a faction: projects its members publish to it, each a copy of a design as the field would build it
  // (`validateDesign`), under its name, with whoever published it and when. A member publishing a project of a name they
  // published before publishes a new version of it, in its place. Every member is told which projects there are and when
  // each was published (`factionView`), and asks for the ones their page does not have as published then (`get`, by their
  // names: no more than the library holds; one of no project of the faction's, gone by now or never there, is left out),
  // to open a copy in the workshop; whoever published one, the leader and the administrators remove it. They stay with
  // the faction whoever leaves it.
  shelf(p: Player, { act, id, ids, blueprint }: Pick<RoomRequest, 'act' | 'id' | 'ids' | 'blueprint'>) {
    const faction = this.faction(p), library = faction.library;
    if (act === 'get') {
      if (!unknownArray(ids) || ids.length > ROOM_LIMITS.library || !stringArray(ids)) throw userError('Pedido inválido.');
      const asked = new Set(ids);
      return { models: structuredClone(library.filter(model => asked.has(model.id))) };
    }
    if (act === 'publish') {
      const source = this.validateDesign(blueprint), at = library.findIndex(model => model.author === p.id && model.name === source.name!);
      if (at < 0 && library.length >= ROOM_LIMITS.library) throw userError`A biblioteca da facção guarda até ${ROOM_LIMITS.library} projetos: remova um antes de publicar outro.`;
      const model = { id: at < 0 ? createHash('sha256').update(JSON.stringify([faction.id, p.id, source.name, this.steps])).digest('hex').slice(0, 12) : library[at]!.id,
        name: source.name, author: p.id, by: p.name, at: this.field.time, blueprint: source };
      if (at < 0) library.push(model); else library[at] = model;
      return { model: { id: model.id, name: model.name, replaced: at >= 0 } };
    }
    if (act === 'remove') {
      const at = library.findIndex(model => model.id === id);
      if (at < 0) throw userError('Esse projeto já não está na biblioteca da facção.');
      if (library[at]!.author !== p.id && this.role(faction, p.id) === 'member') throw userError('Só quem publicou, o líder e os administradores removem um projeto da biblioteca.');
      library.splice(at, 1);
      return {};
    }
    throw userError('Ação inválida.');
  }

  // One step of the field. Every vehicle under orders decides once a round, and what a round
  // costs is one reading of all the sensors, whoever asks for it first. A round is dealt over
  // two steps — one vehicle in the first, which pays for the reading, the others in the next —
  // and the look over the constructions waits for a step that deals none, so that no step
  // carries it all. A step that decides reads the scene, which is why a round is not dealt
  // any thinner. A round an order asked for is decided whole in its first step; one an order asked for while
  // another was being dealt comes when it was asked for (`hasten`), not later.
  // Rounds come at the pace of the pilots (`DECISION_STEPS`), slower on a field crowded
  // enough to make them long, and seldom while every vehicle only watches.
  // A quiet step leaves the scene unread: the host that shows one step in three reads it then.
  // The fog has the sensors read ten times a second, rounds or none: a reading reads no scene, and
  // the vehicle that decides first in a round that begins with one finds it taken. It waits a step
  // for the look over the constructions, which does read the scene.
  // How long a round took to deal is the one thing of a step the field does not decide for itself: `pace` is given
  // the pace that makes for a round that ends in this step and says the pace it is dealt at. A host that runs a field
  // again gives the one it was dealt at then (field-host.ts).
  step({ quiet = false, pace = (measured: number) => measured }: { quiet?: boolean; pace?: (measured: number) => number } = {}) {
    if (this.ended) { this.steps++; this.field.step(undefined, { quiet }); return; }
    if (this.commanders.size) stepCommanders(this);
    const obeys = (actor: Actor) => {
      const squad = this.squadFor(actor);
      return squad && actor.id !== squad.manual && squad.alive(actor.id) && !this.records.get(actor.id)?.service &&
        this.towOf(actor.id)?.targetId !== actor.id ? squad : null;
    };
    if (this.steps++ >= this.round) {
      this.dealing = { ordered: this.world.actors.filter(obeys), done: 0, step: 0, steps: this.round === 0 ? 1 : DEAL_STEPS, spent: 0, start: this.steps - 1 };
      this.round = Infinity;
    }
    const dealing = this.dealing, looks = this.steps - 1 - this.surveyed >= SURVEY_STEPS && !(dealing?.ordered.length && dealing.steps > 1);
    if (looks) { this.surveyed = this.steps - 1; this.survey(); }
    if (this.ended) { this.dealing = null; this.field.step(undefined, { quiet }); return; }
    if (this.fog && this.steps - 1 - this.sighted >= SIGHT_STEPS + (looks ? 1 : 0)) this.sight(this.steps - 1);
    if (dealing) {
      const { ordered } = dealing, last = ++dealing.step >= dealing.steps, started = performance.now(),
        until = last ? ordered.length : Math.min(ordered.length, 1 + Math.ceil((ordered.length - 1) * (dealing.step - 1) / (dealing.steps - 1)));
      const pending: { actor: Actor; squad: Squad; member?: SquadMember; prepared?: ReturnType<Squad['prepareDecision']>; error?: unknown }[] = [], consume = (entry: (typeof pending)[number], answer?: ScriptedDecisionEntry) => {
        // A failed prefix attempted no native query. A failed query or suffix still leaves later pilots their turn.
        try {
          if (Object.hasOwn(entry, 'error')) throw entry.error;
          if (answer && Object.hasOwn(answer, 'error')) throw new Error(answer.error);
          const { actor, squad, member, prepared } = entry,
            action = squad.decide(member ?? squad.side.member(actor), dealing.start,
              prepared === undefined ? undefined : { prepared, ...(answer && 'result' in answer && answer.result ? { decision: answer.result } : {}) });
          if (action) squad.side.input(actor.id, action, true);
        } catch (error) { if (!this.faults.has(errorMessage(error))) { this.faults.add(errorMessage(error)); console.error('Esquadrão na rede:', errorMessage(error)); } }
        dealing.done++;
      }, flush = () => {
        const requests = pending.flatMap(entry => entry.prepared?.request ? [entry.prepared.request] : []);
        let answers: ScriptedDecisionEntry[] | undefined, next = 0;
        if (requests.length > 1) {
          try {
            answers = decodeScriptedDecisions(this.world.game().call({ op: 'scriptedDecisions', requests }));
            if (!Array.isArray(answers) || answers.length !== requests.length) throw userError('Lote de pilotagem inválido.');
          } catch (error) { answers = requests.map(() => ({ error: errorMessage(error) })); }
        }
        for (const entry of pending) consume(entry, entry.prepared?.request && answers ? answers[next++] : undefined);
        pending.length = 0;
      };
      for (let at = dealing.done; at < until; at++) {
        // A vehicle that left the field or came into the player's hands since the round began has nothing to decide.
        const actor = ordered[at]!, squad = this.world.actor(actor.id) === actor ? obeys(actor) : null;
        if (!squad) { flush(); dealing.done++; continue; }
        const unit = squad.units.get(actor.id)!;
        // Haulers reserve places between decisions; bombardment can start a service before its controls are applied.
        if (unit.haul || unit.attack?.point) { flush(); consume({ actor, squad }); continue; }
        try {
          const member = squad.side.member(actor), prepared = squad.prepareDecision(member, dealing.start);
          pending.push({ actor, squad, member, prepared });
        } catch (error) { pending.push({ actor, squad, error }); }
      }
      flush();
      dealing.spent += performance.now() - started;
      if (last) {
        const busy = ordered.some(actor => this.world.actor(actor.id) === actor && obeys(actor)?.busy(actor.id)),
          dealt = pace(Math.min(3, Math.max(1, Math.ceil(dealing.spent / 6))));
        this.round = Math.min(this.round, dealing.start + (busy ? DECISION_STEPS * dealt : WATCH_STEPS)); this.dealing = null;
      }
    }
    this.ease();
    this.field.step(undefined, { quiet });
  }
  // The throttle of each vehicle in a player's hands goes on toward what the player asks for (episode-input.ts
  // `easedThrottle`); not that of one held by a service, but for an aircraft turning about in the air, flown on meanwhile.
  ease() {
    for (const p of this.players.values()) {
      const id = p.squad!.manual, record = id ? this.records.get(id) : undefined, drive = record?.drive;
      if (!id || !record || !drive || drive.throttle === drive.wanted || record.service && !(record.service.kind === 'turn' && record.service.aloft) || this.towOf(id)?.targetId === id) continue;
      drive.throttle = easedThrottle(drive.throttle, drive.wanted, FIXED_DT);
      applyWorldInput(this.field, id, { type: 'drive', phase: 'before', throttle: drive.throttle, brake: drive.brake, rise: drive.rise }, { quiet: true });
    }
  }
  // One reading of the sensors for the fog, before the step of this number: the core says what each
  // faction's sensors hold of the constructions of the others, and which of the ghosts that stand
  // have their place in plain view of whoever keeps them. It reads no scene. What a faction saw until now and is no
  // longer on the field it saw go (`Fog.left`).
  sight(step: number = this.steps, current = false) {
    const time = this.field.time, ghosts = this.fog!.ghosts(time);
    this.fog!.read(this.postSight(decodeSightReading(this.field.game().call({ op: 'teamSight', ghosts, frame: false })), ghosts), time, new Set(this.field.actors.map(a => a.id)), current,
      source => { const f = this.factions.get(source); return f ? { ref: f.ref, name: this.named(f), nation: f.nation ?? null } : null; });
    this.explore(); this.prospect(time); this.reconnoitre(time);
    this.sighted = step; this.sightTopology = this.topology;
  }
  // What the posts of the field see, added to what the cameras of the core read (`read`, its `teamSight`). A faction sees
  // with the eye of each of its posts and of those of its allies, as an optical camera sees (territory.ts `POST_SIGHT`): over
  // the ground that eye has in sight (`lookout`), every construction of another that stands on that ground or over it within
  // the reach of the eye, whole, as a camera tells it; and the place of each ghost it holds there (`ghosts`, Fog.ghosts),
  // empty once what the ghost was of is not seen there. What a camera of the core sees already is told once. A post sees
  // where it stands, whatever fires at it or hides by it: it is a place, and nothing there is hit.
  postSight(read: SightReading, ghosts: ReturnType<Fog['ghosts']>) {
    const holders = [...this.factions.values()].filter(faction => faction.posts.length);
    if (!holders.length) return read;
    const sight = { ...read.sight }, cleared = [...read.cleared ?? []], terrain = this.field.terrain;
    for (const faction of this.factions.values()) {
      const eyes = holders.filter(other => other === faction || this.allied(faction.id, other.id)).flatMap(other => other.posts.map(post => this.lookout(post)));
      if (!eyes.length) continue;
      const sees = (x: number, y: number) => eyes.some(eye => Math.hypot(x - eye.x, y - eye.y) <= POST_SIGHT && contains(eye.spans, x)),
        told = sight[faction.id] ?? [], seen = new Set(told.filter(contact => contact.channel === 'visual' && contact.visible).map(contact => contact.actorId)), more: SightReading['sight'][string] = [];
      for (const actor of this.field.actors) {
        if (actor.team === faction.id || seen.has(actor.id)) continue;
        const x = this.position(actor), y = actor.vehicle?.y ?? terrain.height(x) + 1;
        if (sees(x, y)) { more.push({ actorId: actor.id, channel: 'visual', visible: true, x, y }); seen.add(actor.id); }
      }
      if (more.length) sight[faction.id] = [...told, ...more];
      for (const ghost of ghosts) if (ghost.team === faction.id && !seen.has(ghost.actorId) && sees(ghost.x, ghost.y)) cleared.push({ team: ghost.team, actorId: ghost.actorId });
    }
    return { ...read, sight, cleared };
  }
  // What the eye of a post sees of the ground (territory.ts `postEye`): what lies within the circle of its reach, over the
  // crests in between, as an eye of a construction sees it (ground-sight.ts `eyeSweep`). Swept once for where the post stands.
  lookout(post: Post) {
    let view = this.lookouts.get(post.id);
    if (view?.x !== post.x) {
      const terrain = this.field.terrain, eye = postEye(post.x, terrain);
      this.lookouts.set(post.id, view = { ...eye, spans: clip(eyeSweep(terrain, eye, false).spans, Math.max(terrain.minX, eye.x - eye.left), Math.min(terrain.maxX, eye.x + eye.right)) });
    }
    return view;
  }
  // The eyes of the posts a faction sees with: its allies' and, unless `own` is false, its own (`postSight`), each as the eyes
  // of a construction are told (`id`, `eyes`), for the ground it sees (`explore`).
  postEyes(faction: Faction, own = true) {
    return [...this.factions.values()].filter(other => other === faction ? own : this.allied(faction.id, other.id))
      .flatMap(other => other.posts.map(post => { const { x, y, left, right } = this.lookout(post); return { id: 'post:' + post.id, eyes: [{ x, y, left, right }] }; }));
  }
  // What each faction knows of the bases of the others is what it has seen of them, as of the veins. A base is a great
  // thing, and stands still: the faction knows one whose place, its mast, is in the ground it sees now — whose it is,
  // where it stands and how it faces, and when that was. Where it sees a place it knew a base at and that base is no
  // longer there — its faction lost it, and has none or another elsewhere — it forgets it. Of a base out of its sight it goes
  // on knowing what it last saw, whatever became of it since: the base a faction establishes is nobody's to know
  // until it is seen. So it knows the posts of the others (`outposts`), each by its name: whose it is — a post taken is
  // another's from then on —, where it stands and how it faces, and when it saw it last; one whose mast it sees and that
  // stands there no longer, or is its own now, it forgets.
  reconnoitre(time: number) {
    for (const faction of this.factions.values()) {
      for (const other of this.factions.values()) {
        if (other === faction) continue;
        if (other.base && contains(faction.seen, other.base.x)) faction.bases!.set(other.id, { x: other.base!.x, facing: other.base!.facing, at: time });
        for (const post of other.posts) if (contains(faction.seen, post.x)) faction.outposts!.set(post.id, { of: other.id, x: post.x, facing: post.facing, at: time });
      }
      for (const [id, known] of faction.bases!) if (contains(faction.seen, known.x) && this.factions.get(id)!.base?.x !== known.x) faction.bases!.delete(id);
      for (const [id, known] of faction.outposts!)
        if (contains(faction.seen, known.x) && !this.factions.get(known.of)?.posts.some(post => post.id === id)) faction.outposts!.delete(id);
    }
  }
  // The bases of others a faction knows, by the faction each is of: where each stood and how it faced when the faction
  // last saw it, and when that was. On a field without fog it knows every base as it is.
  reconnoitred(faction: Faction) {
    return faction.bases ?? new Map([...this.factions.values()].filter(other => other !== faction && other.base)
      .map(other => [other.id, { x: other.base!.x, facing: other.base!.facing, at: this.field.time }]));
  }
  // The posts of others a faction knows, by their names (`reconnoitre`): whose each is, where it stood and how it faced when
  // the faction last saw it, and when that was. On a field without fog it knows every post as it is.
  scouted(faction: Faction) {
    return faction.outposts ?? new Map([...this.factions.values()].filter(other => other !== faction)
      .flatMap(other => other.posts.map(post => [post.id, { of: other.id, x: post.x, facing: post.facing, at: this.field.time }])));
  }
  // What each faction knows of the veins is what it has seen of them, and what digging there told it (`felt`). Of a site in the ground it sees now it knows
  // the vein, with what is left of it — growing back as it watches — and whether a base stills it. Of a site out of
  // its sight it goes on knowing what it last saw, whatever became of the vein since: dug out, or come back. It is the faction's, as the
  // ground it explored is: all its members', and kept whatever becomes of the constructions that saw it.
  prospect(time: number) {
    for (const faction of this.factions.values()) for (const [from, to] of faction.seen)
      for (const site of depositsNear(this.deposits, (from + to) / 2, (to - from) / 2)) faction.veins!.set(site.id, this.assay(faction, site, time));
  }
  // The ground each faction sees now and what that adds to the ground it has explored (ground-sight.ts): what the
  // eyes of its standing constructions see, as the scene last read has them, and nothing about one that has no eye; and what
  // the eyes of its posts see (`postEyes`). What a faction has explored it keeps, whatever becomes of the constructions and
  // the posts that saw it, and it is all its members'.
  explore() {
    for (const faction of this.factions.values()) {
      const seen = faction.eyes!.seen([...this.field.actors.filter(a => a.team === faction.id || this.allied(faction.id, a.team)).map(a => ({ id: a.id, eyes: a.eyes })),
        ...this.postEyes(faction)]);
      if (seen === faction.seen) continue;
      faction.seen = seen; faction.explored = unite(faction.explored!, quantise(seen, EXPLORED_GRID));
    }
  }
  // The ground a faction sees now, as spans of the world from the left ([[from, to], …], in metres): what `explore`
  // made of the sensors as they were last read, and they are read first when a reading is due. Whether it sees a
  // place now, and whether it has explored one: seen it at any time, or had a base within a kilometre of it. On a
  // field without fog all the ground is in sight of everybody.
  seen(factionId: string): Span[] {
    if (!this.fog) return [[this.field.terrain.minX, this.field.terrain.maxX]];
    this.look();
    return this.factions.get(factionId)?.seen ?? [];
  }
  sees(factionId: string, x: number) { return contains(this.seen(factionId), x); }
  explored(factionId: string, x: number) { return !this.fog || contains(this.factions.get(factionId)?.explored ?? [], x); }
  // How a faction knows a construction now: as its own, seen, as a ghost, on the radar, or not at
  // all (fog.ts). On a field without fog every faction sees every construction.
  knows(factionId: string, actor: Pick<Actor, 'id' | 'team'>) {
    return this.fog ? this.fog.knows(factionId, actor, this.field.time) : actor.team === factionId ? 'own' : 'seen';
  }
  // What a player asks to do to a construction of another is answered by what the sensors hold
  // now: they are read first when the constructions of the field changed, or a reading is due.
  look() { if (this.fog && (this.sightTopology !== this.topology || this.steps - this.sighted >= SIGHT_STEPS)) this.sight(); }
  // A construction as a faction has it on its screens: itself when it is its own or in sight, what
  // was last told of it when it stands as a ghost, and nothing when the faction was told of none.
  told(factionId: string, actor: Actor) {
    const how = this.knows(factionId, actor);
    return how === 'own' || how === 'seen' ? actor : how === 'ghost' ? this.fog!.ghost(factionId, actor.id, this.field.time) : null;
  }
  // The state and events a faction is told of the field, from a state and its constructions (`chapters`):
  // what the fog leaves of it. Of the players it is told its own and, of the others, whoever
  // owns a construction it is told of: not who else is on the field.
  // Of the rounds in the air and of what happened it is told what it witnesses (fog.ts), by one sight of this state.
  audience(state: SceneFrame & { players?: { id: string; connected?: boolean | undefined }[] }, parts: Chapters | null, events: SceneEventBase[], factionId: string | null) {
    // The private core list is never spread into a faction frame. Only its own
    // endpoints and the world anchors needed to draw their cable leave the host: of a sling, the ends of its bridle too.
    const own = lookup(this.factions, factionId)?.members, tows = this.field.tows.filter(link =>
      own?.has(this.field.actor(link.actorId)?.ownerId ?? '') && own.has(this.field.actor(link.targetId)?.ownerId ?? ''))
      .map(({ actorId, targetId, anchorA, anchorB, length, tension, limit, sling, bridle }) =>
        ({ actorId, targetId, anchorA, anchorB, length, tension, limit, ...sling ? { sling, bridle } : {} }));
    if (!this.fog) return { state: { ...state, tows }, events };
    if (parts === null || factionId === null) throw new TypeError('Missing faction audience.');
    const told = this.fog.tell(state, parts, factionId), owners = new Set(told.actors.map(a => a.ownerId));
    told.tows = tows;
    // Optical geometry alone is shared: the eyes of the allies' constructions and of their posts (`postEyes`; the faction is
    // told the eyes of its own posts with them, `factionView`). No source actor, module, cargo or private faction view travels with it.
    told.sharedEyes = [...state.actors.filter(a => !a.defeated && this.allied(factionId, a.team)).flatMap(a =>
      (a.eyes || []).map(({ x, y, left, right }) => ({ x, y, left, right }))),
      ...this.factions.has(factionId) ? this.postEyes(this.factions.get(factionId)!, false).flatMap(({ eyes }) => eyes) : []];
    told.players = state.players?.filter(p => own?.has(p.id) || owners.has(p.id));
    delete told.stats;
    // A gun its base placed by its fire is a mark like those of the sensors, unless the faction sees the construction
    // itself: a ghost is where it was, and the mark where it fires from now. A mark names no construction.
    told.contacts.push(...this.batteryMarks(factionId, state.time, new Set(told.actors.filter(actor => !actor.ghost).map(actor => actor.id))));
    const sight = state.shots?.data.length || events.length ? this.witness(state, factionId) : null;
    if (state.shots) {
      const follows = this.intelligenceSources(factionId).map(source => this.watch!.follows(source.id));
      told.shots = this.fog.rounds(state.shots, factionId, sight!, number => follows.some(has => has(number)));
    }
    return { state: told, events: events.length ? this.fog.heard(events, sight!, factionId, state.time) : events };
  }
  // What a faction witnesses of the field as a state has it (fog.ts): by its constructions there, at its base, and as far as
  // the eyes of its allies' constructions and of its posts and its allies' see (`postEyes`), as by the eye of a construction
  // — each over the ground it was last swept for (`explore`) —; and where the sky begins to it, over the ground it explored
  // and the ground it never saw.
  witness(state: SceneFrame, factionId: string): Witness {
    const faction = this.factions.get(factionId), base = faction?.base, terrain = this.field.terrain;
    return witness(state, factionId, { base: base ? { x: base.x, radius: BASE_RADIUS } : null, sky: { height: x => terrain.height(x), explored: faction?.explored || [] },
      sweeps: faction?.eyes || null, lookouts: [...state.actors.filter(a => !a.defeated && this.allied(factionId, a.team)).map(a => ({ id: a.id, eyes: a.eyes || [] })),
        ...faction ? this.postEyes(faction) : []] });
  }
  // What the field keeps of a construction: when it last fought, whether it is a wreck or under repair,
  // and the vein it is loading from. What it carries is in its hoppers, its cisterns and its supply pieces; `supplyDelivery`
  // remembers a collected supply load still to be delivered, independently of its orders. Of a repair it
  // keeps what paid for it; of one that was cancelled, where (`declined`), while the construction stands there. A vehicle
  // with supply pieces or a builder comes on the field in automatic (`auto`, supply-dispatch.ts), and an aircraft keeping its
  // fuel to come home (`homing`, Squad.homing), as any construction does till it is told not to.
  record(actor: Actor): RoomRecord {
    if (!this.records.has(actor.id)) this.records.set(actor.id, { arrival: this.arrivals++, combatAt: -Infinity, wear: null, shots: null,
      wreck: null, service: null, declined: null, pulled: null, drive: null, loading: null, extraction: null, tools: null, building: null, road: null, tipped: null,
      auto: worker(actor), homing: true });
    return this.records.get(actor.id)!;
  }
  // The hoppers and the cisterns of a construction, as the scene has them: what it hauls ore and petroleum in.
  pieces(actorId: string) { return reservoirsOf(this.world.modules).filter(m => m.actorId === actorId); }
  // Its supply pieces: what it takes the stocks of its faction to the front in. One that has any is a supply vehicle.
  crates(actorId: string) { return cratesOf(this.world.modules).filter(m => m.actorId === actorId); }
  // Those that serve: not destroyed, and still on it. What the others hold stays aboard, and serves nobody.
  serving(actorId: string) { return this.crates(actorId).filter(m => m.health > 0 && m.attached !== false); }
  // Its pavers: what it lays asphalt with, out of the mix in the hopper built into each (road-works.ts). What they hold
  // was taken from the stocks of its faction, as what its supply pieces hold.
  pavers(actorId: string) { return this.world.modules.filter(m => m.actorId === actorId && holdsMix(m)); }
  // Everything it carries in: what a wreck holds is a load like any other.
  holds(actorId: string) { return [...this.pieces(actorId), ...this.crates(actorId), ...this.pavers(actorId)]; }
  // Raw cargo goes into the yard of the base or the post it stands in (`atDepot`), including a dispatcher returning a finite
  // pickup. Never credit it at a distance.
  deliverCargo(faction: Faction, actor: Actor) {
    const place = this.atDepot(faction, actor);
    if (!place) return load();
    const transferred = this.unload(this.pieces(actor.id), this.yardOf(faction, place)), record = this.record(actor);
    if (actor.vehicle?.config.enabled && record.gatheredOre && ORES.some(id => transferred[id] > 0))
      this.completeObjective(lookup(this.players, actor.ownerId), 'deliverOre');
    return transferred;
  }
  // Gives pieces the loads worked out for them (`stow`). The scene is told at once and read at the next step.
  carry(changed: Map<SceneModule, CargoLoad>) {
    const game = this.world.game();
    for (const [piece, cargo] of changed) { game.call({ op: 'setPartState', owner: game.handle(piece), state: { cargo }, frame: false }); piece.cargo = cargo; game.touch(piece); }
  }
  // Empties pieces into a yard.
  unload(pieces: SceneModule[], yard: RawLoad) {
    const emptied = new Map<SceneModule, CargoLoad>(), transferred = load();
    for (const piece of pieces) {
      let any = false;
      for (const id of RAW_IDS) { const units = piece.cargo?.[id] ?? 0; if (units > 0) { yard[id] += units; transferred[id] += units; any = true; } }
      if (any) emptied.set(piece, {});
    }
    this.carry(emptied);
    return transferred;
  }
  // What a construction carries goes back to its base when it leaves the field there or is made another: ore
  // into the yard, to be refined, and supplies — and the mix of its pavers — into the stocks they came from, unit for unit.
  // It carries neither then. Returns what went back: the supplies, by stock (`back`), and the load that went into the yard,
  // as a faction is told it (`cargo`).
  empty(faction: Faction, actor: Actor) {
    const pieces = this.pieces(actor.id), crates = [...this.crates(actor.id), ...this.pavers(actor.id)], back = supplied(carriedBy(crates).carried),
      carried = carriedBy(pieces).carried;
    const cargo = rounded(carried);
    this.unload(pieces, faction.yard); this.unload(crates, load());
    credit(faction.stock, back);
    delete this.record(actor).supplyDelivery;
    return { back, cargo };
  }
  // What the constructions a faction has on the field are built of, by stock: the shares a supply vehicle is loaded in.
  mix(faction: Faction) { return this.enlisted(faction).reduce((sum, actor) => billSum(sum, designBill(actor.blueprint)), bill()); }
  // Fills the supply pieces of a construction out of automatic from the stocks of its faction (one in it loads only what a job
  // of it needs, supply-dispatch.ts): first with what the works of the faction lack that no job brings them, as far as the
  // pieces do not carry it already — a guard post of concrete asks for Sílica a fleet of steel would never be loaded with —,
  // and then in the shares its constructions are built of (`supplyLoad`). What goes in comes out of the stocks, unit for unit.
  provision(faction: Faction, crates: SceneModule[]) {
    const held = supplied(carriedBy(crates).carried),
      lack = this.works.of(faction.id).reduce((sum, work) => billSum(sum, this.supplyDispatch.wanted(work)), bill()),
      fill = (want: SupplyBill) => {
        const taken = bill();
        for (const id of STOCK_IDS) {
          if (!(want[id] > 0)) continue;
          const put = stow(crates, SUPPLIED[id], want[id]);
          this.carry(put.changed); taken[id] = put.moved;
        }
        credit(faction.stock, taken, -1);
      };
    fill(bill(...STOCK_IDS.map(id => Math.min(Math.ceil(lack[id] - held[id] - 1e-6), stocked(faction.stock[id])))));
    fill(supplyLoad(crates, this.mix(faction), faction.stock));
  }
  // The constructions in the order they came to the field. One rebuilt, by a repair or by a new
  // design, keeps its place in every list: the squad's numbers do not shift under the player.
  fielded() {
    const actors = this.world.actors;
    if (this.listed?.actors !== actors) this.listed = { actors,
      ordered: actors.slice().sort((a, b) => this.record(a).arrival - this.record(b).arrival) };
    return this.listed.ordered;
  }
  // What every screen is told of it: a wreck and when it goes, a building, a repair or a turning about and when it ends, or
  // a taking down and how far it has gone, to the hundredth; and of its tools at work, which dig where, what its
  // builders put up or take down (`building`, Works.attend) at what share of their pace (fog.ts tells another faction only
  // that they work), and the lane of a road its road machine makes (`road`, `roadWork`).
  show(actor: Actor) {
    const record = this.record(actor), { wreck, service } = record;
    if (wreck || service) record.extraction = record.building = record.road = null;
    const { extraction, building, road } = record, cargoWork = !wreck && !service ? record.cargoWork : null;
    actor.field = wreck || service || extraction || building || cargoWork || road ? { wreck: wreck && { until: wreck.until },
      service: actorService(service),
      ...(extraction ? { extraction } : {}), ...(building ? { building } : {}), ...(cargoWork ? { cargoWork } : {}), ...(road ? { road } : {}) } : null;
  }
  // What a road machine on a lane of a road is told doing there (road-works.ts), for its screens to show it at work
  // (road-machine-motion.ts): its tool, the ends of its lane, from where it began it, to the centimetre, and whether it did
  // nothing of it since the look before (`idle`), its tool at rest, or because its tools do not reach the ground (`short`),
  // down as far as they go. `fronts` is where each had come to before that look.
  roadWork(fronts: Map<string, number | undefined>) {
    const jobs = this.supplyDispatch.jobs, centimetre = (x: number) => Math.round(x * 100) / 100;
    for (const actor of this.world.actors) {
      const record = this.record(actor), job = jobs.get(actor.id),
        road: RoomRecord['road'] = job && (job.kind === 'grade' || job.kind === 'pave') && job.phase === 'work' && !record.wreck && !record.service ? { tool: ROAD_TOOLS[job.kind],
          from: centimetre(job.lane.from), to: centimetre(job.lane.to), ...(fronts.get(actor.id) === job.front ? { idle: true } : {}), ...(job.short ? { short: true } : {}) } : null;
      if (road?.tool === record.road?.tool && road?.from === record.road?.from && road?.to === record.road?.to && road?.idle === record.road?.idle &&
        road?.short === record.road?.short) continue;
      record.road = road; this.show(actor);
    }
  }
  // One look over the field: who fired or was hit, who went out of action, which wrecks
  // had their time and which repairs are done. A hit leaves holes, marks and lost health; what the ground leaves in a
  // fall is no hit (`plateWear`, `pieceWear`). A construction that fired or was hit is in combat, and its faction fought
  // then (`fought`): a wreck is nobody's.
  // The veins gain back what was dug of them (`replenish`) — before anything is dug at this look, so that a vein dug as fast as it
  // comes back stays empty —, loads are taken on and put down, works brought their material and put up, structures taken down
  // (`Works.step`), and the yards refined, for the time since the look before. Who stands armed in each
  // base is looked at once a second (`besiege`), and which bases are sheltered at every look (`shelter`).
  survey() {
    const world = this.world, time = world.time, wear = new Map<string, number>(), out = this.outOfAction();
    for (const p of world.plates) wear.set(p.actorId!, (wear.get(p.actorId!) || 0) + plateWear(p));
    for (const m of world.modules) wear.set(m.actorId, (wear.get(m.actorId) || 0) + pieceWear(m));
    for (const actor of world.actors.slice()) {
      const record = this.record(actor), now = wear.get(actor.id) || 0, shots = actor.stats.shots,
        hit = record.wear !== null && Math.abs(now - record.wear) > 1e-9;
      if (hit || record.wear !== null && shots !== record.shots) {
        record.combatAt = time;
        const faction = !record.wreck && lookup(this.factions, actor.team);
        if (faction) faction.fought = time;
      }
      record.wear = now; record.shots = shots;
      // A construction that moved away from where its repair was cancelled is mended by itself again where it next stops.
      if (record.declined !== null && Math.abs(this.position(actor) - record.declined) > RESUME_DISTANCE) record.declined = null;
      if (record.wreck) { if (time >= record.wreck.until) this.discard(actor.id); }
      else if (out[actor.id]) this.wreck(actor);
      else {
        const change = advanceService(record.service, time, hit);
        switch (change?.kind) {
          case 'finish-build':
            this.free(actor);
            if (change.objective) this.completeObjective(lookup(this.players, actor.ownerId), 'fabricateVehicle');
            break;
          case 'finish-repair': this.restore(actor); break;
          case 'finish-turn': this.turned(actor); break;
          case 'cancel-turn': this.free(actor); break;
        }
      }
    }
    const elapsed = time - (this.hauledAt ?? time), building = this.works.attend(elapsed);
    const fronts = new Map([...this.supplyDispatch.jobs].map(([id, job]) => [id, (job.kind === 'grade' || job.kind === 'pave') ? job.front : undefined]));
    this.replenish(elapsed); this.haul(elapsed, building); this.roadworks.step(elapsed); this.roadWork(fronts); this.hauledAt = time;
    stepActivities(this);
    this.works.step(elapsed, building);
    this.serve();
    this.supplyDispatch.step();
    this.refine(time);
    for (const faction of this.factions.values()) if (faction.base) advanceIndustry(faction.industry, time);
    this.acquaint(time);
    if (time - this.besieged >= CAPTURE_LOOK) this.besiege(time);
    this.shelter(time); this.cover();
    // The bases watch the rounds in the air: the shells their radars follow and the guns their ears hear (base-watch.ts).
    this.watch?.look({ shots: world.shots, time, terrain: world.terrain, teamOf: id => world.actor(id)?.team ?? null,
      bases: [...this.factions.values()].filter(faction => faction.base).map(faction => ({ team: faction.id, x: faction.base!.x, y: world.terrain.height(faction.base!.x) })) });
  }
  // A faction meets another by sight: once a sensor of it sees a construction the other has standing it knows that
  // faction, and keeps when that first was, and when and where it last had one of them in sight. What a radar holds
  // or an ear hears does not say whose it is, and a wreck is nobody's. Knowing is one-sided. A faction that started
  // again and is seen again is seen like any other: it is no longer the one that was defeated.
  acquaint(time: number) {
    for (const actor of this.world.actors) {
      if (!actor.ownerId) continue;
      for (const faction of this.factions.values()) {
        if (faction.id === actor.team || this.knows(faction.id, actor) !== 'seen') continue;
        const met = faction.met.get(actor.team!);
        faction.met.set(actor.team!, { since: met?.since ?? time, at: time, x: Math.round(this.position(actor)), defeatedAt: null });
      }
    }
    this.acquainted = time;
  }
  // Who holds each base, as the field looks once a second. What stands in a base, for it or against it, is a construction
  // in action there on the ground, held by no service, with a gun that fires and rounds for it (`armed`): an aircraft in
  // the air, however low it hovers, stands in no base, and neither begins, holds up, contests nor keeps a capture of one,
  // while one that drives about on the ground in it stands there as well as one at rest. A faction other than the
  // base's that stands so in it alone begins to take it, from the day the base is founded, unless the base is sheltered
  // (`shelter`) or something of the base's own faction stands so there too; and it takes it in `CAPTURE_SECONDS`, a second
  // of them a second (`captureAt`). The capture stands still while it is contested — while another faction stands so there
  // too, or the base's own does, whenever what stands came there: one fabricated since the capture began holds the base
  // as well as one that was there before it —; and it goes back while its faction stands there no longer, down to
  // nothing, where it is over: only then may another faction begin one. A capture that comes to its end with its faction
  // standing there alone takes the base (`fall`). Both factions fight while a capture is under way (`fought`). The bases
  // the factions of others stand in are kept for what they are told (`contested`): who stands there. A base with nothing
  // of another faction in it and no capture under way is looked at no closer: whatever of its own stands there, nothing
  // happens to it. A faction with no base has nothing to look at.
  // Each post (territory.ts) is held the same way, by what stands in it (`POST_RADIUS` to each side of it), and taken in
  // `POST_CAPTURE_SECONDS` (`seize`), by the rules of a base, its own capture (`post.capture`) and the posts others stand
  // in kept as the bases are (`disputed`) — but that a faction with all the posts it may have (`POST_LIMIT`, those being put
  // up counted) begins to take none, and the capture of one by a faction that came to have them all meanwhile stands still,
  // as contested, until it has room for it again (`full`): a post taken is the taker's. A post being taken down is taken as
  // well as one that serves: it stands until it is down.
  besiege(time: number) {
    if (this.ended) return;
    const completed: Faction[] = [];
    const out = this.outOfAction();
    // A ground vehicle at the apex of a jump is neither flying nor moving fast; only Native support counts it.
    let standing = this.world.actors.filter(a => a.ownerId && !out[a.id] && !this.record(a).service && this.grounded(a));
    this.besieged = time; this.contested = new Map();
    for (const faction of [...this.factions.values()]) {
      const near = standing.filter(a => this.atBase(faction, a));
      if (!faction.capture && near.every(a => faction.members.has(a.ownerId ?? ''))) continue;
      const inside = near.filter(a => this.armed(a)), held = inside.some(a => faction.members.has(a.ownerId ?? '')),
        foes = [...new Set(inside.filter(a => !faction.members.has(a.ownerId ?? '')).map(a => a.team!))], capture = faction.capture;
      if (capture) {
        faction.fought = this.factions.get(capture.by)!.fought = time;
        const progress = captureAt(capture, time), state = !foes.includes(capture.by) ? 'receding' : foes.length > 1 || held ? 'contested' : 'advancing';
        // What the base taken had standing leaves the field with it, and stands in no other base any longer.
        if (state === 'advancing' && progress >= CAPTURE_SECONDS) {
          // Resolve both bases from the same standing snapshot in a duel.
          // Simultaneous captures draw instead of depending on faction order.
          if (this.duel) { completed.push(faction); continue; }
          this.fall(faction, time);
          const left = new Set(this.world.actors); standing = standing.filter(a => left.has(a)); continue;
        }
        if (state === 'receding' && progress <= 0) faction.capture = null;
        else if (state !== capture.state) Object.assign(capture, { progress, at: time, state });
      }
      if (!faction.capture && foes.length === 1 && !held && faction.shelter === null) {
        faction.capture = { by: foes[0]!, progress: 0, at: time, state: 'advancing' };
        faction.fought = this.factions.get(foes[0]!)!.fought = time;
      }
      this.contested.set(faction.id, { foes });
    }
    if (completed.length) {
      if (completed.length === 2) this.finishDuel({ phase: 'draw', at: time });
      else this.fall(completed[0]!, time);
      return;
    }
    this.disputed = new Map();
    const full = (id: string) => this.postPlaces(this.factions.get(id)!).length >= POST_LIMIT;
    for (const faction of [...this.factions.values()]) for (const post of [...faction.posts]) {
      const near = standing.filter(a => Math.abs(this.position(a) - post.x) <= POST_RADIUS);
      if (!post.capture && near.every(a => faction.members.has(a.ownerId ?? ''))) continue;
      const inside = near.filter(a => this.armed(a)), held = inside.some(a => faction.members.has(a.ownerId ?? '')),
        foes = [...new Set(inside.filter(a => !faction.members.has(a.ownerId ?? '')).map(a => a.team!))], capture = post.capture;
      if (capture) {
        faction.fought = this.factions.get(capture.by)!.fought = time;
        const progress = captureAt(capture, time, POST_CAPTURE_SECONDS),
          state = !foes.includes(capture.by) ? 'receding' : foes.length > 1 || held || full(capture.by) ? 'contested' : 'advancing';
        if (state === 'advancing' && progress >= POST_CAPTURE_SECONDS) { this.seize(faction, post, time); continue; }
        if (state === 'receding' && progress <= 0) post.capture = null;
        else if (state !== capture.state) Object.assign(capture, { progress, at: time, state });
      }
      if (!post.capture && foes.length === 1 && !held && faction.shelter === null && !full(foes[0]!)) {
        post.capture = { by: foes[0]!, progress: 0, at: time, state: 'advancing' };
        faction.fought = this.factions.get(foes[0]!)!.fought = time;
      }
      this.disputed.set(post.id, { foes, full: foes.filter(full) });
    }
  }
  // A post taken changes hands as it stands (`besiege`): it is the taker's from then on, with its territory, its services and
  // its sight, as one it put up — but that taking it down gives nothing back (`salvage`): the taker put nothing into it.
  // Nothing is taken from the stocks of either: what waited in its yard goes into the stocks of the faction that lost it, at
  // once, refined (`refined`), and the post refines for the taker from an empty yard. Both are told it (`lost`, `seized`):
  // where it stood, by whom or of whom, and what of the yard went back; the taker knows it its own at once.
  seize(faction: Faction, post: Post, time: number) {
    const victor = this.factions.get(post.capture!.by)!, yard = rounded(post.yard);
    credit(faction.stock, refined(post.yard));
    faction.posts = faction.posts.filter(other => other !== post);
    victor.posts.push(Object.assign(post, { yard: load(), refinedAt: null, salvage: bill(), takedown: null, capture: null }));
    faction.lost = { at: time, x: post.x, by: victor.id, yard };
    victor.seized = { at: time, x: post.x, of: faction.id };
    victor.outposts?.delete(post.id); this.disputed.delete(post.id); this.topology++;
  }
  // Which bases are sheltered, as of `time`. The base of a faction is once every member of it has been away from the
  // field `SHELTER_AWAY` seconds and the faction has not fought for `SHELTER_CALM` — a fire or a hit of a construction of
  // it, anywhere on the field, or a capture of its base or by it (`survey`, `besiege`) —, and stays so until a member
  // comes back (`arrive`), or until `SHELTER_LONGEST` after the last of them left: then it is sheltered no longer, nor
  // again before somebody of it has been back. What else the faction does while it is sheltered shelters it no less.
  shelter(time: number) {
    for (const faction of this.factions.values()) {
      const away = faction.away === null ? -Infinity : time - faction.away;
      if (away >= SHELTER_LONGEST) faction.shelter = null;
      else if (faction.shelter === null && away >= SHELTER_AWAY && (faction.fought === null || time - faction.fought >= SHELTER_CALM)) faction.shelter = time;
    }
  }
  // Tells the core which constructions their bases shelter now: those of a sheltered faction that stand on the ground in its
  // base or one of its posts (`atDepot`), out of action or not, but no wreck. One sheltered is harmed and pushed by nobody's fire, and fires none (native core,
  // `Actor::sheltered`). One that comes into the base is sheltered there, and one that leaves it, or takes off from it, no
  // longer: an aircraft in the air over its base is sheltered nowhere. One made anew — repaired, turned about — is told again.
  cover() {
    const sheltered = new Set<Actor>(), tell = (actor: Actor, on: boolean) => this.world.game().call({ op: 'setActorState', actorId: actor.id, state: { sheltered: on }, frame: false });
    for (const faction of this.factions.values()) if (faction.shelter !== null)
      for (const actor of this.enlisted(faction))
        if (!this.records.get(actor.id)?.wreck && this.grounded(actor) && this.atDepot(faction, actor)) sheltered.add(actor);
    const standing = new Set(this.sheltered.size ? this.field.actors : []);
    for (const actor of this.sheltered) if (!sheltered.has(actor) && standing.has(actor)) tell(actor, false);
    for (const actor of sheltered) if (!this.sheltered.has(actor)) tell(actor, true);
    this.sheltered = sheltered;
  }
  // Whether a construction has a gun that fires and rounds for it, as its squad reckons its guns (`Squad.armed`).
  armed(actor: Actor) { return lookup(this.players, actor.ownerId)!.squad!.armed({ id: actor.id }).fed.length > 0; }
  // A base taken is lost, with its works, and the faction it was of goes on without one — its members, its stocks and
  // its yard — until it establishes another (`recover`). Every construction of its members on the field, at the base or
  // anywhere else, is dismantled where it stands (`strip`), and then the faction that took the base takes `LOOT_SHARE` of
  // what the stocks hold above what a faction is founded with, stock by stock, and of what waits in the yard, still to be
  // refined; the rest stays. Nothing is made and nothing lost but what dismantling a damaged piece loses: what the one has
  // less, the other has more, in whole units. Both are told what came of it (`fell`, `taken`). What waits in the yard waits
  // for a base to refine it. To every faction that had met it, it was defeated then and is nowhere they know of; the one that
  // took the base knows it gone at once, and the others when they see its place empty (`reconnoitre`). What its base placed
  // of the guns of others by their fire is forgotten with it.
  fall(faction: Faction, time: number) {
    const victor = this.factions.get(faction.capture!.by)!, from = faction.base!.x, { dismantled, returned, cargo } = this.strip(faction),
      stock = bill(...STOCK_IDS.map(id => Math.floor(LOOT_SHARE * Math.max(0, faction.stock[id] - this.grant[id])))),
      yard = load(...RAW_IDS.map(id => Math.floor(LOOT_SHARE * faction.yard[id])));
    credit(faction.stock, stock, -1); credit(victor.stock, stock);
    for (const id of RAW_IDS) { faction.yard[id] -= yard[id]; victor.yard[id] += yard[id]; }
    victor.taken = { at: time, of: faction.id, dismantled, stock, yard };
    Object.assign(faction, { base: null, capture: null, refinedAt: null,
      fell: { at: time, from, by: victor.id, dismantled, returned: whole(returned), cargo, stock, yard } });
    this.contested.delete(faction.id); this.watch?.forget(faction.id); victor.bases?.delete(faction.id);
    for (const other of this.factions.values()) { const met = other.met.get(faction.id); if (met) Object.assign(met, { at: null, x: null, defeatedAt: time }); }
    this.finishDuel({ phase: 'won', winner: victor.id, loser: faction.id, at: time });
  }
  // Takes every construction of a faction's members off the field, wherever it stands, dismantled as it would be at its base
  // (`appraise`): what is left of it goes into the stocks, and so does what a repair it was held for was paid with, never
  // done; what its supply pieces carry goes back into the stocks, and what its hoppers and its cisterns carry into the yard
  // (`empty`). Its players let go of it first. So do its works and its heaps: what came of each works, and what lay in each
  // heap, goes into the stocks. So do its posts, taken down as by a builder (`lowered`): what each gives back goes into the
  // stocks, and what waited in its yard into that of the base. Returns how many constructions there were, what went into the
  // stocks and the load that went into the yard, as the faction is told it.
  strip(faction: Faction) {
    const parts = fieldParts(this.world), actors = this.enlisted(faction), returned = this.works.clear(faction.id), cargo = load();
    this.roadworks.clear(faction.id);
    const industrial = liquidateIndustry(faction.industry);
    credit(returned, industrial); credit(faction.stock, returned);
    for (const post of faction.posts) {
      const yard = rounded(post.yard);
      credit(faction.stock, post.salvage); credit(returned, post.salvage);
      for (const id of RAW_IDS) { faction.yard[id] += post.yard[id]; cargo[id] += yard[id]; }
      this.lookouts.delete(post.id);
    }
    if (faction.posts.length) { faction.posts = []; this.topology++; }
    for (const id of faction.members) { this.release(id); this.take(this.players.get(id)!, null); }
    for (const actor of actors) {
      const record = this.record(actor), paid = record.service?.kind === 'repair' ? record.service.cost : bill(),
        value = appraise(actor, parts, { damagedShare: 1 }).salvage;
      record.service = null;
      for (const amounts of [paid, value]) { credit(faction.stock, amounts); credit(returned, amounts); }
      const emptied = this.empty(faction, actor);
      credit(returned, emptied.back);
      for (const id of RAW_IDS) cargo[id] += emptied.cargo[id];
      this.discard(actor.id);
    }
    for (const id of faction.members) { const p = this.players.get(id)!; p.selected = null; p.squad!.sync(); }
    return { dismantled: actors.length, returned, cargo };
  }
  // What `elapsed` seconds did for the loads. A construction that stands still inside its base, or a post of its faction,
  // puts what its hoppers and its cisterns carry into the yard there (`deliverCargo`), and the supply pieces of one out of automatic are
  // filled up again from the stocks, out of combat (`provision`). What one in automatic carries in them is for its dispatch
  // alone to load and unload, while an order of the player's holds it too (supply-dispatch.ts `ready`, `collect`): the base
  // filling it and the dispatch emptying it would take turns at it. Away from the base, a real excavator or drill takes reserve into the site's public pile,
  // each at its own rate (`extractRate`), as far as the engines of its construction turn it and its tanks feed them
  // (`power`). Those engines are asked once for all its tools at work: those that reach a vein, and the builders of it that
  // stand by something to put up or take down (`building`, Works.attend), which are told the share of their pace they give
  // (`share`). What they work at, and what held them, is told (`tools`), and what builders work on at what share of their pace, while their engines
  // give them any (`record.building`). Hoppers and cisterns take only from that pile, whether another vehicle
  // extracted it or their own tool did. Taking on has one rate per vehicle, not per piece. Emptying the reserve leaves
  // its pile as it is; the two amounts are independent, and the reserve comes back by itself (`replenish`). A construction under repair
  // does neither, and a wreck keeps what it carried. Supply pieces take refined remittances, never raw material.
  // One that tipped part of its load out to weigh less (`dump`) takes nothing on where it did that: the vein
  // it stands by would only fill it up again. It does once it has gone on from there (`tipped` is where).
  haul(elapsed: number, building: ReturnType<Works['attend']> = new Map()) {
    const world = this.world, pieces = new Map<string, SceneModule[]>(), crates = new Map<string, SceneModule[]>(), working: WorkingLoad[] = [], cargoWork = new Map<string, CargoWork>(),
      add = (map: Map<string, SceneModule[]>, m: SceneModule) => { if (!map.has(m.actorId)) map.set(m.actorId, []); map.get(m.actorId)!.push(m); },
      ask = (actor: Actor, record: RoomRecord, tools: SceneModule[]) => {
        const builders = building.get(actor.id), { share, limit } = this.power(actor, [...tools, ...builders?.pieces ?? []], elapsed),
          pace = Math.round(share * 100) / 100;
        record.tools = toolsTold({ share, limit });
        if (builders) { builders.share = share; record.building = pace > 0 ? { at: builders.job, ...(pace < 1 ? { pace } : {}) } : null; }
        return share;
      };
    for (const m of reservoirsOf(world.modules)) add(pieces, m);
    for (const m of cratesOf(world.modules)) add(crates, m);
    for (const actor of world.actors) {
      const record = this.record(actor), owner = lookup(this.players, actor.ownerId), own = pieces.get(actor.id), kept = crates.get(actor.id);
      record.loading = record.extraction = record.tools = record.building = null;
      if (record.tipped !== null && Math.abs(this.position(actor) - record.tipped) > LOAD_REACH) record.tipped = null;
      if (!owner || record.wreck || record.service || !this.still(actor)) continue;
      const faction = this.faction(owner), x = this.position(actor);
      const delivered = record.supplyDelivery === true && this.atDepot(faction, actor);
      if (delivered) {
        credit(faction.stock, supplied(this.unload(kept ?? [], load())));
        delete record.supplyDelivery;
      }
      const managed = this.supplyDispatch.manages(actor.id), transport = managed && this.supplyDispatch.jobs.get(actor.id)?.kind === 'haul'
        ? this.supplyDispatch.jobs.get(actor.id) : null;
      if (managed && !transport) continue;
      if (this.atDepot(faction, actor)) {
        const refinedHaul = owner.squad!.units.get(actor.id)?.haul?.refined === true;
        if (own) this.deliverCargo(faction, actor);
        if (kept && !record.auto && !delivered && !refinedHaul && this.calm(actor)) this.provision(faction, kept);
        continue;
      }
      if (transport && (transport.phase === 'collect' || !outwardHaul(transport))) continue;
      if (record.tipped !== null || !this.calm(actor)) continue;
      const work = collectionWork(world, actor.id);
      if (!own && !kept && !work.length) continue;
      const publicSite = activitySite(this),
        near = [...depositsNear(this.deposits, x, LOAD_REACH),
          ...(publicSite && activityKnown(this, faction) && actor.vehicle?.config.enabled && Math.abs(publicSite.x - x) <= LOAD_REACH ? [publicSite] : [])]
          .filter(site => !transport || site.id === transport.targetId)
          .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
      working.push({ actor, record, faction, own, kept, work, near, transport });
      if (transport) continue; // A ready-material trip may use its pickup arm, but never starts geological extraction.
      // Every tool that reaches a vein with reserve left works it, whether the vehicle has a container or not, all of
      // them at the share of their pace its engines give them. Their output stays at the site, including what does not
      // fit aboard this vehicle.
      const reaching: { tool: ReturnType<typeof collectionWork>[number]; site: DepositSite }[] = [];
      for (const tool of work) {
        const site = near.find((site): site is DepositSite => site.type !== 'airdrop' && canCollect(tool, site, world.terrain));
        if (!site) continue;
        if (this.dug(site) && this.left(site) > 0) reaching.push({ tool, site }); else this.felt(faction, site);
      }
      if (!reaching.length) continue;
      const share = ask(actor, record, reaching.map(({ tool }) => tool.piece)), digging: ExtractionWork[] = [];
      for (const { tool, site } of reaching) {
        const left = this.left(site), moved = Math.min(extractRate(tool.piece) * elapsed * share, left);
        if (!(moved > 0)) continue;
        this.extracted.set(site.id, (this.extracted.get(site.id) ?? 0) + moved);
        digging.push({ partId: tool.piece.id, siteId: site.id });
        this.veins.set(site.id, left - moved > 1e-6 ? left - moved : 0); this.felt(faction, site, null, true);
      }
      record.extraction = digging.length ? digging : null;
    }
    for (const [id, builders] of building) if (builders.share === undefined) { const actor = world.actor(id)!; ask(actor, this.record(actor), []); }
    // All extraction precedes pickup. Compatible vehicles select one physical pile, then share it together,
    // including across factions: the first actor no longer takes the whole output while its neighbours wait.
    const piles = new Map<string, { site: FieldSite; requests: LoadRequest[] }>();
    for (const { actor, record, faction, own, kept, near, transport } of working) {
      if (!own?.length && !kept?.length) continue;
      const eligible: LoadSite[] = [];
      for (const site of near) {
        if (!this.dug(site)) {
          if (transport && loadingContainers(world, actor.id, site, LOAD_REACH).length && site.type !== 'airdrop') this.felt(faction, site);
          continue;
        }
        const containers = loadingContainers(world, actor.id, site, LOAD_REACH);
        if (transport && containers.length && site.type !== 'airdrop') this.felt(faction, site, this.pileStock(site));
        const ordinary = site.supplies ? supplySpace(containers, site.supplies) : containers.reduce((sum, piece) => sum + cargoSpace(piece, site.material), 0),
          space = this.supplyDispatch.jobs.get(actor.id)?.kind === 'haul'
            ? Math.min(ordinary, this.supplyDispatch.transportSpace(actor, site, containers)) : ordinary;
        if (space > 1e-6) eligible.push({ site, space, containers });
      }
      const picked = eligible.find(({ site }) => this.pileStock(site) > 0)
        || !transport && eligible.find(({ site }) => site.type !== 'airdrop' && this.left(site) > 0);
      if (!picked) continue;
      if (!piles.has(picked.site.id)) piles.set(picked.site.id, { site: picked.site, requests: [] });
      piles.get(picked.site.id)!.requests.push({ actor, record, faction, containers: picked.containers, space: picked.space });
    }
    for (const { site, requests } of piles.values()) {
      const stock = this.pileStock(site),
        shares = sharePile(stock, requests.map(request => Math.min(TRANSFER_RATE * elapsed, request.space))),
        enough = stock + 1e-6 >= requests.reduce((sum, request) => sum + request.space, 0),
        drained = stock - shares.reduce((sum, share) => sum + share, 0) <= 1e-6;
      let moved = 0;
      for (const [index, { actor, record, containers, space }] of requests.entries()) {
        const taken = site.supplies ? null : stow(containers, site.material, shares[index]!),
          loaded = site.supplies ? gatherSupplies(site.supplies, containers, shares[index]!, changed => this.carry(changed)) : taken!.moved;
        if (loaded > 0) {
          if (taken) this.carry(taken.changed);
          record.loading = site.id; moved += loaded;
          if (site.refined) record.supplyDelivery = true;
          if (!site.refined && actor.vehicle?.config.enabled && ORES.includes(site.material)) {
            record.gatheredOre = true;
            this.completeObjective(lookup(this.players, actor.ownerId), 'collectOre');
          }
          if (!site.supplies) this.setPileStock(site, stock - moved);
        }
        const left = space - loaded;
        if (left > 1e-6) {
          const progress: CargoWork = { kind: 'load' };
          if (enough) progress.until = Math.ceil((world.time + left / TRANSFER_RATE - 1e-6) * 4) / 4;
          else if (stock <= 1e-6) progress.waiting = true;
          else if (drained && loaded > 0) progress.limited = true;
          cargoWork.set(actor.id, progress);
        }
      }
      if (site.type !== 'airdrop') for (const { actor, faction } of requests)
        this.felt(faction, site, this.supplyDispatch.jobs.get(actor.id)?.kind === 'haul' ? this.pileStock(site) : null);
    }
    for (const actor of world.actors) {
      const record = this.record(actor), next = cargoWork.get(actor.id) ?? null, previous = record.cargoWork;
      if (previous?.kind !== next?.kind || previous?.until !== next?.until || previous?.limited !== next?.limited || previous?.waiting !== next?.waiting)
        record.cargoWork = next;
      this.show(actor);
    }
  }
  // What the engines of a construction did for its tools that reach a vein over `seconds` of the field (`work`, in the
  // core, which burns the fuel for it out of its tanks): the share of their full pace they dug at, and what held them
  // under it — no engine that turns ('engine'), no fuel ('fuel'), or engines weaker than they ask ('power').
  power(actor: Actor, tools: SceneModule[], seconds: number) {
    const game = this.world.game();
    return game.call({ op: 'work', actorId: actor.id, tools: tools.map(piece => game.handle(piece)), seconds, frame: false });
  }
  // What a faction learns of a vein it knows from a construction of its own that works there, with an eye or none: that a
  // base stills it; that it gets nothing more out of it, empty for now, with the pile still available there; of one it digs,
  // what is left in it, by what comes out (`dug`); or of a pile it takes in, what that holds (`stock`).
  felt(faction: Faction, site: Deposit, stock: number | null = null, dug = false) {
    const known = faction.veins?.get(site.id);
    if (!known) return;
    if (!this.dug(site)) faction.veins!.set(site.id, { ...known, still: true });
    else if (!(this.left(site) > 0)) faction.veins!.set(site.id, { ...known, left: 0, stock: this.extracted.get(site.id) ?? 0 });
    else if (dug) faction.veins!.set(site.id, { ...known, left: this.left(site) });
    else if (stock !== null) faction.veins!.set(site.id, { ...known, stock }); // A real pickup mouth learned the ready balance, not hidden reserve.
  }
  // The refinery of each base, and that of each post that serves (`depots`), makes stock of the faction of what waits in its
  // yard, a batch at a time, each at its own rate: they add up. A faction with no base has no refinery: its yard waits for the
  // next one. A post that does not serve — being taken down — refines nothing meanwhile.
  refine(time: number) {
    const run = (holder: { refinedAt: number | null }, yard: RawLoad, stock: SupplyBill, rate: number) => {
      if (!(rate > 0) || !(loadTotal(yard) > 0)) { holder.refinedAt = null; return; }
      holder.refinedAt ??= time;
      const batches = Math.floor((time - holder.refinedAt + 1e-9) / REFINE_SECONDS);
      if (batches > 0) { refine(yard, stock, batches * REFINE_SECONDS, rate); holder.refinedAt += batches * REFINE_SECONDS; }
    };
    for (const faction of this.factions.values()) {
      run(faction, faction.yard, faction.stock, faction.base ? REFINE_RATE : 0);
      for (const post of faction.posts) run(post, post.yard, faction.stock, post.takedown ? 0 : POST_REFINE_RATE);
    }
  }
  position(actor: { vehicle?: { x?: number | undefined } | null | undefined; x: number }) { return actor.vehicle?.x ?? actor.x; }
  calm(actor: Actor) { return this.world.time - this.record(actor).combatAt >= CALM_SECONDS; }
  // Native support, rather than flight mode or speed, distinguishes landing from the apex of a jump.
  // Fixed structures already stand on their admitted foundations.
  grounded(actor: Actor) { return !actor.vehicle || !actor.vehicle.flying && actor.vehicle.grounded === true; }
  // Local work and service require both physical support and near-zero speed.
  still(actor: Actor) { return this.grounded(actor) && Math.hypot(actor.vehicle?.vx || 0, actor.vehicle?.vy || 0) <= STILL_SPEED; }
  atBase(faction: Faction, actor: Actor) { return faction.base !== null && Math.abs(this.position(actor) - faction.base.x) <= BASE_RADIUS; }
  // The places of a faction where its constructions are served as in its base — they unload into a yard there, are rearmed,
  // refuelled and repaired from the stocks, and are sheltered with it —: its base, and each of its posts (`posts`), each
  // where it stands (`x`), how far to each side of that it serves (`radius`, territory.ts `POST_RADIUS`) and which post it is
  // (`post`, none for the base). A post being taken down serves no longer. Read again whenever a post came, went, changed
  // hands or began or stopped being taken down (`topology`), or the base did.
  depots(faction: Faction) {
    if (!this.served || this.served.topology !== this.topology) this.served = { topology: this.topology, of: new Map() };
    let known = this.served.of.get(faction.id);
    if (!known || known.base !== faction.base) this.served.of.set(faction.id, known = { base: faction.base,
      places: [...faction.base ? [{ x: faction.base.x, radius: BASE_RADIUS, post: null }] : [],
        ...this.posts(faction).map(post => ({ x: post.x, radius: POST_RADIUS, post: post.id }))] });
    return known.places;
  }
  // The one of them nearest a place of the field, or nothing for a faction with none.
  depot(faction: Faction, x: number) {
    let nearest: Depot | null = null;
    for (const place of this.depots(faction)) if (!nearest || Math.abs(place.x - x) < Math.abs(nearest.x - x)) nearest = place;
    return nearest;
  }
  // The one of them a construction stands in, or nothing.
  atDepot(faction: Faction, actor: Actor) {
    const x = this.position(actor);
    return this.depots(faction).find(place => Math.abs(x - place.x) <= place.radius) ?? null;
  }
  // The yard of one of them: what a load is unloaded into there, for its refinery.
  yardOf(faction: Faction, place: Depot) { return place.post ? faction.posts.find(post => post.id === place.post)!.yard : faction.yard; }
  // What waits to be refined in all the yards of a faction: that of its base and those of its posts.
  yards(faction: Faction) {
    const all = { ...faction.yard };
    for (const post of faction.posts) for (const id of RAW_IDS) all[id] += post.yard[id];
    return all;
  }
  // Whether a supply vehicle stands near enough a construction to hand it supplies (`SUPPLY_REACH`): the two of them that
  // near end to end, as they stand (Works.hull). A supply vehicle is as near itself as it gets.
  handy(supplier: Actor, actor: Actor) { return supplier === actor || this.works.gap(supplier, this.works.hull(actor)) <= SUPPLY_REACH; }
  // Where a construction is serviced, and what pays there. Inside its base, or a post (`atDepot`), the stocks of the
  // faction do. With no fuel left there, a supplier may still fuel its own tank from what it carries. Anywhere else,
  // the supply vehicles of the faction beside it (`handy`) do — those with a supply piece that serves —, the nearest
  // first, each from what those pieces carry: `held` says what keeps one from it — it is under repair, it moves, or
  // it is in combat. A supply vehicle is the first of its own points while it carries fuel, and for that fuel alone
  // (`own`): it fills its own tank, and neither arms nor mends itself. What hoppers and cisterns carry serves nobody, nor
  // does what a supply piece destroyed or torn off still holds (`serving`), nor, of another, what it carries for a works
  // that this still lacks (SupplyDispatch.giving).
  points(faction: Faction, actor: Actor, own = true): ServicePoint[] {
    const depot = this.atDepot(faction, actor), points: ServicePoint[] = depot ? [{ supplier: null, stock: faction.stock, held: '' }] : [];
    if (depot && (!own || faction.stock.combustivel > 0)) return points;
    const x = this.position(actor), far = (other: Actor) => Math.abs(this.position(other) - x), candidates: { other: Actor; crates: SceneModule[] }[] = [];
    for (const other of depot ? [actor] : this.enlisted(faction)) {
      if (!other.blueprint.modules.some(piece => piece.kind === 'supply') || !this.handy(other, actor)) continue;
      // Repair delivery is one recipient's point until its job ends or the player cancels it.
      const delivery = this.supplyDispatch.jobs.get(other.id);
      if (delivery?.kind === 'repair' && delivery.targetId !== actor.id) continue;
      // A road machine in automatic carries in its supply pieces the mix of its asphalt (road-works.ts): it fuels nobody out
      // of them, itself neither.
      if (this.records.get(other.id)?.auto && roadMachine(other)) continue;
      const crates = this.serving(other.id);
      if (crates.length) candidates.push({ other, crates });
    }
    for (const { other, crates } of candidates.sort((a, b) => far(a.other) - far(b.other))) {
      const carried = supplied(carriedBy(crates).carried),
        stock = other === actor ? bill(0, 0, 0, carried.combustivel) : this.supplyDispatch.giving(other.id, carried);
      if (other === actor && !(own && stock.combustivel > 0)) continue;
      points.push({ supplier: other, stock, held: this.record(other).service?.kind ?? (!this.still(other) ? 'moving' : !this.calm(other) ? 'combat' : '') });
    }
    return points;
  }
  // The same automatic allowance is quoted and paid. A point of another construction keeps its physical stock;
  // the own point keeps fuel carried for a works, including salvage loaded before its build handoff, unless this job
  // needs it to operate. Manual orders end the job.
  resupplyPoint(actor: Actor, quote: ReturnType<typeof appraise>, point: ServicePoint, parts: ReturnType<typeof fieldParts>) {
    if (point.supplier?.id !== actor.id || !(quote.rearm.combustivel > 0)) return point;
    const dispatch = this.supplyDispatch, job = dispatch.jobs.get(actor.id), owner = lookup(this.players, actor.ownerId),
      faction = owner && this.faction(owner), work = dispatch.bound(actor.id);
    if (!faction?.base || work?.factionId !== faction.id || !(this.works.need(work).combustivel > 0)) return point;
    const span = this.works.span(work), assembling = job!.kind !== 'work'
      ? work.seconds * Math.max(0, 1 - work.progress) / Math.max(1e-6, dispatch.pace(actor, parts)) : 0,
      seconds = dispatch.toward(actor, this.position(actor), span) + dispatch.toward(actor, faction.base.x, span) + assembling,
      needed = Math.max(0, Math.ceil(dispatch.budget(actor, seconds) - actor.vehicle!.fuelLitres));
    return { ...point, stock: { ...point.stock, combustivel: Math.min(point.stock.combustivel, needed) } };
  }
  // Takes a bill from a point: from the stocks of the faction, or out of the supply pieces of the supply vehicle that serve.
  charge(point: ServicePoint, cost: SupplyBill) {
    credit(point.stock, cost, -1);
    if (!point.supplier) return;
    const crates = this.serving(point.supplier.id);
    for (const id of STOCK_IDS) if (cost[id] > 0) this.carry(stow(crates, SUPPLIED[id], -cost[id]).changed);
  }
  // Magazines and tanks are filled from a point as far as it pays for (`resupply`): to the load of the design
  // when it pays for all of it. Returns what was given, or nothing when the point pays for none of it.
  refill(actor: Actor, quote: ReturnType<typeof appraise>, point: ServicePoint) {
    const given = resupply(actor.blueprint, quote, point.stock);
    if (!Object.keys(given.levels).length) return null;
    this.charge(point, given.cost); this.supply(actor, given.levels);
    let fuelLitres = 0, rounds = 0;
    for (const [piece, level] of Object.entries(given.levels)) {
      fuelLitres += (level.fuelLitres ?? 0) - (quote.levels[piece]!.fuelLitres ?? 0);
      rounds += (level.rounds ?? 0) - (quote.levels[piece]!.rounds ?? 0);
    }
    // Only the receipt is brief: the transfer is immediate, and points at this same instant add to one receipt.
    const record = this.record(actor), at = this.world.time, previous = record.refilled?.at === at ? record.refilled : null;
    record.refilled = { at, until: at + 4, fuelLitres: fuelLitres + (previous?.fuelLitres ?? 0), rounds: rounds + (previous?.rounds ?? 0) };
    return given;
  }
  // A repair is paid up front by a point, and holds the construction for a time that grows with the damage it mends:
  // it neither moves nor fires meanwhile. The way it was on ends there; what it was told to go on doing — a haul or a
  // target — it goes back to once it is mended. Whatever becomes of the point then, the repair is done. The
  // repair keeps what it cost and what paid it — the supply vehicle, or nobody for the stocks —: cancelled, that goes back.
  // A point that pays for the whole of the damage mends all of it; one that pays for part of it, the pieces that part pays
  // for (`partialMend`: `part`), which the repair keeps (`pieces`).
  mend(owner: Player, actor: Actor, quote: ReturnType<typeof appraise>, point: ServicePoint, part: import('../src/economy.ts').PartialRepair | null = null) {
    if (this.towOf(actor.id)) throw userError('Solte o cabo antes de reparar o veículo.');
    const cost = part ? part.cost : quote.repair;
    this.charge(point, cost);
    Object.assign(this.record(actor), { declined: null, drive: null, pulled: null,
      service: repairService(this.world.time + (part ? part.seconds : quote.seconds),
        { levels: quote.levels, cost, payer: point.supplier?.id ?? null, pieces: part ? part.pieces : null }) });
    releaseWorldInputs(this.world, [actor.id], 1, true, true);
    const unit = owner.squad!.units.get(actor.id); if (unit) unit.move = null;
    this.show(actor);
  }
  // Local services require a construction free of wrecks/services, stationary and out of combat.
  // Automatic dispatch and the additional repair vetoes are separate decisions.
  canServe(actor: Actor) {
    const record = this.record(actor);
    return !record.wreck && !record.service && this.still(actor) && this.calm(actor);
  }
  // The same vetoes govern a local automatic repair and a supplier sent to pay for one.
  canMend(owner: Player | undefined, actor: Actor) {
    const record = this.record(actor), hand = owner?.squad!.manual === actor.id;
    return Boolean(owner && !this.towOf(actor.id) && this.canServe(actor) && record.declined === null &&
      (!hand || this.atDepot(this.faction(owner), actor) && !record.drive?.wanted && !record.drive?.throttle && !actor.trigger) &&
      !owner.squad!.units.get(actor.id)?.move);
  }
  mendFrom(owner: Player, actor: Actor, quote: ReturnType<typeof appraise>, points: ServicePoint[]) {
    if (!billTotal(quote.repair) || !this.canMend(owner, actor)) return false;
    const [point, part] = repairOffer(points, quote);
    if (!point) return false;
    this.mend(owner, actor, quote, point, part);
    return true;
  }
  // Service that comes by itself, for the constructions of every player: one that stands still at
  // a point that is ready, out of combat, is filled up there and then mended, without being asked. The construction
  // in a player's hands is mended in its base too, once its accelerator and trigger are released. Away from its base,
  // or where its repair was cancelled, that is asked for; one on its way somewhere waits until it arrives.
  serve() {
    let parts: ReturnType<typeof fieldParts> | null = null;
    // Each supplier pays its own anchor first, within the ordinary point reach and readiness rules. Sorting actors alone
    // lets an older anchor drain several partial suppliers before their own anchors get anything.
    const rearming = (job: import('./supply-dispatch.ts').DispatchJob | undefined): job is import('./supply-dispatch.ts').SupplyDispatchJob & { kind: 'rearm'; phase: 'deliver' } => job?.kind === 'rearm' && job.phase === 'deliver';
    for (const [supplierId, job] of this.supplyDispatch.jobs) {
      if (!rearming(job)) continue;
      const actor = this.world.actor(job.targetId), owner = actor && lookup(this.players, actor.ownerId);
      if (!owner || owner.factionId !== job.factionId || !this.canServe(actor)) continue;
      const point = this.points(this.faction(owner), actor).find(point => point.supplier?.id === supplierId && !point.held);
      if (point) this.refill(actor, appraise(actor, parts ||= fieldParts(this.world)), point);
    }
    // Repair cargo is paid to its own anchor before ordinary fills or repairs can spend it.
    // Urgent grouped rearm above keeps its existing order and payload unchanged.
    for (const [supplierId, job] of this.supplyDispatch.jobs) {
      if (job.kind !== 'repair' || job.phase !== 'deliver') continue;
      const actor = this.world.actor(job.targetId), owner = actor && lookup(this.players, actor.ownerId), supplier = this.world.actor(supplierId);
      if (!owner || owner.factionId !== job.factionId || !this.canMend(owner, actor) ||
        !supplier || !this.supplyDispatch.safe(supplier, lookup(this.players, supplier.ownerId))) continue;
      const point = this.points(this.faction(owner), actor).find(point => point.supplier?.id === supplierId && !point.held);
      if (point) this.mendFrom(owner, actor, appraise(actor, parts ||= fieldParts(this.world)), [point]);
    }
    // The remaining cargo serves nearby constructions normally. Automatic repair waits until these rearm jobs finish.
    for (const actor of this.world.actors) {
      const owner = lookup(this.players, actor.ownerId);
      if (!owner || !this.canServe(actor)) continue;
      let quote = appraise(actor, parts ||= fieldParts(this.world));
      if (!billTotal(quote.rearm) && !billTotal(quote.repair)) continue;
      const points = this.points(this.faction(owner), actor).filter(point => !point.held);
      if (!points.length) continue;
      for (const point of points) {
        if (!billTotal(quote.rearm)) break;
        if (lookup(this.supplyDispatch.jobs, point.supplier?.id)?.kind === 'repair') continue;
        if (this.refill(actor, quote, this.resupplyPoint(actor, quote, point, parts))) quote = appraise(actor, parts);
      }
      this.mendFrom(owner, actor, quote, points.filter(point => {
        const job = lookup(this.supplyDispatch.jobs, point.supplier?.id);
        return !rearming(job) && job?.kind !== 'repair';
      }));
    }
  }
  // A construction out of action is a wreck (wreck.ts): nobody's and in nobody's way, for
  // anybody to dismantle until its time on the field is over. What its supply pieces carried is a load like any other from then on.
  // Fire follows the core's combustible contents, including after destruction or abandonment.
  wreck(actor: Actor, abandoned = false) {
    const record = this.record(actor), owner = lookup(this.players, actor.ownerId);
    Object.assign(record, { wreck: { ...makeWreck(this.world, actor), abandoned, stripped: false }, service: null, loading: null });
    this.reserved.delete(actor.id);
    this.show(actor); this.sampledOut = null;
    if (owner) this.forget(owner, actor.id);
  }
  // A construction that left a player's side: the squad lets go of it and the workshop looks at another.
  forget(player: Player, actorId: string) {
    player.squad!.sync();
    if (player.selected === actorId) player.selected = this.owned(player.id)[0]?.id || null;
  }
  discard(actorId: string) {
    this.supplyDispatch.cancel(actorId);
    this.world.removeActor(actorId); this.records.delete(actorId); this.reserved.delete(actorId); this.topology++; this.sampledOut = null;
  }
  // A vehicle with no command post that works takes no orders and is no target (wreck.ts). Nor does a wreck.
  outOfAction() {
    if (this.sampledOut !== this.world.time) {
      this.out = Object.fromEntries(uncommanded(this.world).map((id): [string, true] => [id, true]));
      for (const [id, record] of this.records) if (record.wreck) this.out[id] = true;
      this.sampledOut = this.world.time;
    }
    return this.out;
  }

  // A construction being built, under repair or turning about is held until that is over: nothing else is done with it.
  held(actor: Actor) {
    return serviceHold(this.record(actor).service);
  }
  // Work on a construction is done at the base, standing still there on the ground (`still`), out of combat, one job at a
  // time: an aircraft over its base, however low it hovers, is to land first.
  workshop(p: Player, actor: Actor, work: MessageValue) {
    if (this.towOf(actor.id)) throw userError('Solte o cabo antes de modificar ou desmontar o veículo.');
    if (this.held(actor)) throw new Error(this.held(actor));
    if (!this.atBase(this.faction(p), actor)) throw userError`Leve a construção até a base para ${work}.`;
    if (!this.still(actor)) throw actor.vehicle?.flying ? userError`Pouse na base para ${work}.` : userError`Pare na base para ${work}.`;
    if (!this.calm(actor)) throw userError`Saia de combate para ${work}: ${CALM_SECONDS} s sem atirar nem ser atingida.`;
  }
  // A repair asked for is done wherever a point serves: at the base, or beside another supply vehicle of the faction
  // that stands still, out of combat — to a construction that stands still there on the ground itself (`still`): an
  // aircraft is to land for it. Returns the points that are ready, the nearest first.
  station(p: Player, actor: Actor, work: MessageValue) {
    if (this.towOf(actor.id)) throw userError('Solte o cabo antes de reparar o veículo.');
    if (this.held(actor)) throw new Error(this.held(actor));
    const points = this.points(this.faction(p), actor, false), ready = points.filter(point => !point.held);
    if (!points.length) throw userError`Leve a construção até a base, ou um veículo de suprimentos até ela, para ${work}.`;
    if (!this.still(actor)) throw actor.vehicle?.flying ? userError`Pouse para ${work}.` : userError`Pare para ${work}.`;
    if (!this.calm(actor)) throw userError`Saia de combate para ${work}: ${CALM_SECONDS} s sem atirar nem ser atingida.`;
    if (!ready.length) throw userError`O veículo de suprimentos precisa estar parado e fora de combate para ${work}.`;
    return ready;
  }
  // A bill is paid whole, each amount from its own stock, or not at all: the refusal names the stocks that are short.
  afford(faction: Faction, cost: SupplyBill, what: MessageValue) {
    const short = shortMessage(faction.stock, cost, what);
    if (short) throw userError(short);
  }
  // Sets what magazines and tanks hold, by piece of the design. The scene is read back at
  // once: the next quote must see the new load, or a bill asked twice would be paid twice.
  supply(actor: Actor, levels: RepairLevels) {
    const game = this.world.game(), patches = Object.entries(levels)
      .map(([piece, state]) => ({ owner: game.handle(`${actor.id}:${actor.revision}:${piece}`), state }))
      .filter(patch => patch.owner !== null);
    if (!patches.length) return;
    try {
      game.call({ op: 'setPartStates', actorId: actor.id, patches });
    } catch (error) {
      // A refused batch can have written its prefix; publish it and preserve the original refusal.
      try { game.call({ op: 'sync' }); } finally { throw error; }
    }
  }
  // Dismantling a vehicle gives back what is physically left of it; whatever it still carried goes back with it (`empty`).
  // The reply says all that went into the stocks, in whole units as the faction is told them and as the workshop quoted it
  // (faction-ui.ts `dismantleQuote`), and the load that went into the yard. A structure is taken down where it stands
  // instead (`takeDown`).
  dismantle(p: Player, actor: Actor) {
    if (!isVehicleDesign(actor.construction)) return this.takeDown(p, actor);
    this.workshop(p, actor, phrase('desmontar')); this.claim(p, [actor]);
    const faction = this.faction(p), value = appraise(actor, fieldParts(this.world)).salvage, driven = p.squad!.manual === actor.id;
    credit(faction.stock, value);
    const { back, cargo } = this.empty(faction, actor);
    this.discard(actor.id); this.forget(p, actor.id);
    if (driven) this.take(p, null);
    return { removed: actor.id, selected: p.selected, refund: billSum(value, whole(back)), cargo };
  }
  // A structure is taken down where it stands, by a builder of the faction beside it (`Works.step`) — the nearest free one
  // goes there by itself (supply-dispatch.ts) —, in the time the base would take to build what it gives back
  // (`buildSeconds`): it is held meanwhile — it neither fires nor is serviced — and what it gives back is left there in a
  // heap (`Works.finish`). Moved (`to`, the works it is moved to), the heap goes to that works first, and the builder that
  // took it down on to put it up. Refused, in words, for one already held.
  takeDown(p: Player, actor: Actor, to: string | null = null) {
    if (this.held(actor)) throw new Error(this.held(actor));
    this.claim(p, [actor]);
    const value = appraise(actor, fieldParts(this.world)).salvage, seconds = this.building ? buildSeconds(value) : 0;
    Object.assign(this.record(actor), { declined: null, service: dismantleService(seconds, to) });
    releaseWorldInputs(this.world, [actor.id], 1, true, true);
    if (p.squad!.manual === actor.id) this.take(p, null);
    this.show(actor);
    return { dismantling: actor.id, seconds, value };
  }
  // A structure being taken down stands as it was again, and so does the works it was being moved to: given up, it leaves
  // what came of it in a heap (`Works.cancel`).
  keepUp(p: Player, actor: Actor) {
    const service = this.record(actor).service;
    if (service?.kind !== 'dismantle') throw userError('Essa estrutura não está sendo desmontada.');
    this.claim(p, [actor]);
    const work = service.to && this.works.pending.get(service.to);
    this.free(actor);
    return { kept: actor.id, ...(work ? { heap: this.works.cancel(work)?.id ?? null } : {}) };
  }
  // Left where it stands, it is a wreck like any other, worth less for not having been brought home.
  abandon(p: Player, actor: Actor) { this.claim(p, [actor]); this.wreck(actor, true); return { removed: actor.id, selected: p.selected }; }
  // A repair asked for charges the value destroyed to the nearest point that pays all of it, or else what it mends of
  // it to the nearest that pays for part of it (`mender`, `mend`). Refused, in words, where no point pays for anything.
  repair(p: Player, actor: Actor) {
    const points = this.station(p, actor, phrase('reparar')), quote = appraise(actor, fieldParts(this.world));
    if (!billTotal(quote.repair)) throw userError('Essa construção não tem danos a reparar.');
    const [point, part] = repairOffer(points, quote);
    if (!point) {
      const nearest = points[0]!, work = phrase('o reparo'), refusal = nearest.supplier
        ? scantMessage(nearest.stock, quote.repair, work, phrase('ao alcance'))
        : shortMessage(nearest.stock, quote.repair, work);
      throw userError(refusal ?? phrase('Faltam recursos para reparar.'));
    }
    this.claim(p, [actor]); this.mend(p, actor, quote, point, part);
    return { service: actor.field!.service, cost: part ? part.cost : quote.repair, seconds: part ? part.seconds : quote.seconds, partial: Boolean(part) };
  }
  // A repair cancelled mends nothing and gives its whole bill back to what paid it: the stocks of the faction, or the
  // supply vehicle, while that one stands on the field as one, as far as the supply pieces of it that serve have room
  // (`serving`). One with none that serves takes nothing back: in its base or a post the stocks take the bill instead, and the
  // reply says so, as it says what does not go back anywhere, which is lost. The construction is free at once and goes
  // on with what it was told, as after a repair that ends; where it stands no repair begins by itself again (`serve`).
  cancel(p: Player, actor: Actor) {
    const record = this.record(actor), service = record.service;
    if (service?.kind !== 'repair') throw userError('Essa construção não está em reparo.');
    this.claim(p, [actor]);
    const faction = this.faction(p), supplier = service.payer ? this.world.actor(service.payer) : null, refund = bill(),
      standing = supplier != null && faction.members.has(supplier.ownerId ?? ''), crates = standing ? this.serving(supplier.id) : [],
      stocks = !service.payer || standing && !crates.length && this.atDepot(faction, supplier);
    if (stocks) { credit(faction.stock, service.cost); Object.assign(refund, service.cost); }
    else for (const id of STOCK_IDS) {
      const put = service.cost[id] > 0 ? stow(crates, SUPPLIED[id], service.cost[id]) : null;
      if (put) { this.carry(put.changed); refund[id] = put.moved; }
    }
    Object.assign(record, { service: null, declined: this.position(actor) });
    this.show(actor);
    return { refund, lost: billSum(service.cost, refund, -1), supplier: stocks ? null : service.payer, gone: Boolean(service.payer) && !standing };
  }
  // A construction tips part of what its hoppers and its cisterns carry out where it stands, anywhere on the field, to weigh
  // less: a quarter of what they hold when full, or what is left of it (`dumpOf`). What comes out is lost: it makes no
  // heap on the ground and goes back to no vein, yard or stock. Supplies are not tipped out: they go back at the base.
  // Where it tipped it takes nothing on again (`tipped`), and a hauler takes what it has left home, from the next step (`lightened`). One under repair tips nothing: it comes
  // out of its repair with the load it went in with. Returns what came out.
  dump(p: Player, actor: Actor) {
    const record = this.record(actor), pieces = this.pieces(actor.id), { carried, room } = carriedBy(pieces), out = dumpOf(carried, room), dumped = load();
    if (this.held(actor)) throw new Error(this.held(actor));
    if (!(loadTotal(out) > 0)) throw userError('Essa construção não leva carga para despejar.');
    this.claim(p, [actor]);
    for (const id of RAW_IDS) {
      const taken = out[id] > 0 ? stow(pieces, id, -out[id]) : null;
      if (taken) { this.carry(taken.changed); dumped[id] = taken.moved; }
    }
    record.tipped = this.position(actor);
    if (p.squad!.lightened(actor.id)) this.round = 0;
    return { dumped: rounded(dumped) };
  }
  // A construction turns about where it stands, to face the other way, wherever it is on the field and for
  // nothing: it takes `TURN_SECONDS`, held as by a repair — it neither moves nor fires, and the way it was on ends
  // there — unless the squad turned it about to go on with it (`keep`). An aircraft in the air turns about where it
  // is (`aloft`), in `AIR_TURN_SECONDS`: held so as well, but flying on meanwhile as it was flown — its flight computer
  // holds it up and on its way with what it was last asked, which only the player who flies it changes meanwhile —, its
  // guns silent, and on its way still once it is turned (World.turnActor). A hit in that time undoes either (`survey`):
  // it stays as it faced, free at once. Refused, in words, for a construction already held, and for a structure: one
  // faces as it was put up, and is moved to face otherwise (`relocate`).
  turn(p: Player | null, actor: Actor, keep = false) {
    if (this.towOf(actor.id)) throw userError('Solte o cabo antes de virar o veículo.');
    if (!isVehicleDesign(actor.construction)) throw userError(UNTURNED);
    if (this.held(actor)) throw new Error(this.held(actor));
    const aloft = Boolean(actor.vehicle?.flying);
    this.record(actor).service = turnService(this.world.time + (aloft ? AIR_TURN_SECONDS : TURN_SECONDS), aloft);
    if (aloft) applyWorldInput(this.world, actor.id, { type: 'trigger', phase: 'before', active: false, cancel: true }, { quiet: true });
    else releaseWorldInputs(this.world, [actor.id], 1, true, true);
    const unit = (p?.squad ?? this.squadFor(actor))?.units.get(actor.id); if (unit && !keep && !aloft) unit.move = null;
    this.show(actor);
  }
  // What held a construction is over, and nothing came of it: it takes up the way it was sent on.
  free(actor: Actor) { this.record(actor).service = null; this.show(actor); this.squadFor(actor)?.resume(actor.id); }
  // Turned about, it is what it was, facing the other way (`World.turnActor`), and goes back to what it was told: a
  // way it was turned about for, it takes up from where it is.
  turned(actor: Actor) {
    Object.assign(this.record(actor), { service: null, wear: null, shots: null });
    const fresh = this.world.turnActor(actor.id);
    this.show(fresh); this.topology++; this.renewed(fresh);
  }
  // Repaired, it is the design again, with the load it carried: rounds and fuel are another bill.
  restore(actor: Actor) {
    const record = this.record(actor), service = record.service;
    if (service?.kind !== 'repair') throw new Error('Esta constru��o n�o est� em reparo.');
    const { levels, pieces } = service;
    if (pieces) return this.fix(actor, pieces);
    Object.assign(record, { service: null, wear: null, shots: null });
    const fresh = this.world.replaceActor(actor.construction, { id: actor.id });
    this.supply(fresh, levels); this.show(fresh); this.topology++; this.renewed(fresh);
  }
  // A repair of part of the damage mends those pieces of the construction where they stand, each by the share of what it
  // lacked that was paid for (`partialMend`): a gun's mechanism and local shield
  // openings are mended by that same share, and a plate whole. A component that burst works again as one only damaged
  // works, once it has health enough for that (`worksAgain`): it, and a plate made whole, only in the construction admitted
  // anew where it stands, with all else as it was (World.reviveActor). The construction is the
  // one it was; what it wore before is no measure of a hit.
  fix(actor: Actor, pieces: import('../src/construction-service.ts').RepairPiece[]) {
    const record = this.record(actor), game = this.world.game(), plates = new Set(actor.blueprint.plates.map(plate => plate.id)),
      revived = new Set<string>(), renewed = new Set<string>();
    for (const { id, share } of pieces) {
      if (plates.has(id)) { renewed.add(id); continue; }
      const name = `${actor.id}:${actor.revision}:${id}`, module = this.world.modules.find(m => m.id === name), owner = game.handle(name);
      if (!module || owner === null) continue;
      const health = share >= 1 ? module.maxHealth : module.health + (module.maxHealth - module.health) * share,
        weapon = module.kind === 'weapon' ? {
          barrelDamage: share >= 1 ? 0 : (module.barrelDamage || 0) * (1 - share),
          elevationDamage: share >= 1 ? 0 : (module.elevationDamage || 0) * (1 - share),
          mantletHoles: share >= 1 ? [] : (module.mantletHoles || []).map(({ min, max }) => {
            const middle = (min + max) / 2, half = (max - min) * (1 - share) / 2;
            return { min: middle - half, max: middle + half };
          }),
        } : {};
      game.call({ op: 'setPartState', actorId: actor.id, owner, state: { health, ...weapon } });
      if (module.detonated && worksAgain(module, health)) revived.add(id);
    }
    Object.assign(record, { service: null, wear: null });
    if (revived.size || renewed.size) {
      const fresh = this.world.reviveActor(actor.id, { revived, renewed });
      this.show(fresh); this.topology++; this.renewed(fresh);
      return;
    }
    this.show(actor); this.renewed(actor);
  }
  // Every squad that keeps the wear of a construction made anew forgets it (`Squad.renewed`).
  renewed(actor: Actor) { for (const p of this.players.values()) p.squad?.renewed(actor.id); this.guardianSquad?.renewed(actor.id); }
  // A wreck goes to whoever brings a construction of theirs up to it and stands it still there on the ground, out of
  // combat: an aircraft hovering by it, however low, is to land, and one that drives by is to stop. What is left of
  // it goes into the stocks of the faction, as if it were dismantled; what it carried (`wreckCargo`) goes into the
  // hoppers and the cisterns of the constructions that reached it, each kind into its own, the nearest
  // first, and has to be brought home. What does not fit stays in the wreck, which is then nothing
  // but its load, for whoever fetches it before its time is over. A supply piece takes none of it:
  // what a wreck carried is to be refined, whatever it was, and no supplies come of it on the way.
  salvage(p: Player, wreckId: unknown) {
    const record = lookup(this.records, wreckId), actor = record?.wreck && typeof wreckId === 'string' ? this.world.actor(wreckId) : undefined;
    // A wreck is answered by what the faction has on its screens (`known`), never by what became of it out of sight: one
    // it was told of none is, to it, no wreck on the field, and one it holds the ghost of is that ghost, standing where
    // it was, whether it is still there or not — until a construction of the player is there to find it gone. The
    // sensors are read first whether there is one or not: how long the answer takes says nothing either.
    this.look();
    const known = actor ? this.told(p.factionId!, actor) : typeof wreckId === 'string' ? this.fog?.ghost(p.factionId!, wreckId, this.field.time) : null;
    if (!known?.defeated) throw userError('Esses destroços já não estão no campo.');
    const reached = this.reaching(p, known), wait = !reached.length && this.calmIn(p, known);
    if (wait) throw userError`Sua construção junto dos destroços ainda está em combate: desmonte em ${wait} s.`;
    if (!reached.length) {
      const by = this.reaching(p, known, { calm: false, still: false });
      if (by.some(a => a.vehicle?.flying)) throw userError('Pouse perto dos destroços para recolhê-los.');
      if (by.length) throw userError('Pare perto dos destroços para recolhê-los.');
      throw userError`Leve uma construção sua, fora de combate, a menos de ${SALVAGE_REACH} m dos destroços.`;
    }
    if (!actor) throw userError('Os destroços já não estão aqui.');
    const value = this.worth(actor, fieldParts(this.world)), cargo = load(), held = this.holds(actor.id);
    for (const taker of reached) {
      const own = this.pieces(taker.id);
      for (const id of RAW_IDS) {
        const there = held.reduce((sum, m) => sum + (m.cargo?.[id] || 0), 0), taken = there > 0 ? stow(own, id, there) : null;
        if (!taken || !(taken.moved > 0)) continue;
        this.carry(taken.changed); this.carry(stow(held, id, -taken.moved).changed); cargo[id] += taken.moved;
      }
    }
    if (record!.wreck!.stripped && !loadTotal(cargo)) throw userError('Nenhuma construção sua junto dos destroços tem caçamba ou cisterna com espaço para a carga.');
    credit(this.faction(p).stock, value); record!.wreck!.stripped = true;
    const left = rounded(this.wreckCargo(actor.id));
    if (!loadTotal(left)) { this.discard(actor.id); this.fog?.gone(p.factionId!, actor.id); }
    return { salvaged: actor.id, value, cargo: rounded(cargo), left };
  }
  // What a wreck carries, for whoever takes it: what its pieces hold.
  wreckCargo(actorId: string) { return carriedBy(this.holds(actorId)).carried; }
  // What is left of a wreck to dismantle: nothing once that was taken and only its load remains.
  worth(wreck: Actor, parts: ReturnType<typeof fieldParts>) { const state = this.records.get(wreck.id)!.wreck!; return state.stripped ? bill() : appraise(wreck, parts, state).salvage; }
  // The constructions of the faction a player may have (`usable`) that may work on a wreck: in reach of it, standing still
  // on the ground (`still`), out of combat, the nearest first — or, as asked, in combat or not and still or not. Working on
  // it holds none of them.
  reaching(p: Player, wreck: Parameters<SharedRoom['position']>[0], { calm = true, still = true }: { calm?: boolean; still?: boolean } = {}) {
    const x = this.position(wreck), out = this.outOfAction(), far = (a: Actor) => Math.abs(this.position(a) - x);
    return this.fleet(this.faction(p)).filter(a => this.usable(p, a) && far(a) <= SALVAGE_REACH && !out[a.id] && !this.record(a).service &&
      (!still || this.still(a)) && (!calm || this.calm(a))).sort((a, b) => far(a) - far(b));
  }
  // How long until a construction the player may have standing still by a wreck is out of combat and may dismantle it: the
  // soonest of those in reach of it, none of them out of combat yet. Nothing when one already is, or none stands there.
  calmIn(p: Player, wreck: Parameters<SharedRoom['position']>[0]) {
    const near = this.reaching(p, wreck, { calm: false });
    if (!near.length || near.some(a => this.calm(a))) return null;
    return Math.ceil(Math.min(...near.map(a => CALM_SECONDS - (this.world.time - this.record(a).combatAt))));
  }

  // What a player's screen shows of the squad: the vehicle in the player's hands, and every construction of the faction
  // (`fleet`), as the squad of the member it is in has it, with whether the player holds it (`reserved`) or which other member
  // does (`by`) — a free one says neither —; and which vehicles of the field are out of action:
  // of those of other factions, the ones it sees so, and the ghosts of those it last saw so — whether they are still on
  // the field or not, as its frames show them (fog.ts).
  squadView(playerId: string, reading?: Map<Squad, ReturnType<Squad['view']>>): RoomSquadView | null {
    const p = this.players.get(playerId);
    if (!p) return null;
    const out = this.outOfAction(), time = this.field.time, faction = this.faction(p);
    let own = reading?.get(p.squad!);
    if (!own) { own = p.squad!.view(); reading?.set(p.squad!, own); }
    const { manual, units } = own!, views = new Map(units.map(u => [u.id, u]));
    for (const id of faction?.members ?? []) if (id !== p.id) {
      const squad = this.players.get(id)!.squad!;
      let other = reading?.get(squad);
      if (!other) { other = squad.view(); reading?.set(squad, other); }
      for (const unit of other.units) views.set(unit.id, unit);
    }
    return { manual, units: (faction ? this.fleet(faction) : []).flatMap(actor => {
      const unit = views.get(actor.id), holder = this.holding(actor);
      return !unit ? [] : [holder === p ? { ...unit, reserved: true } : holder ? { ...unit, by: { id: holder.id, name: holder.name } } : unit];
    }), out: !this.fog ? Object.keys(out) : [
      ...this.field.actors.filter(a => out[a.id] && included(['own', 'seen'], this.knows(p.factionId!, a))).map(a => a.id),
      ...this.fog.ghostsOf(p.factionId!, time).filter(ghost => ghost.defeated).map(ghost => ghost.id)] };
  }
  // Conclusions belong to the seat, not the faction or the constructions it still has.
  // Selection is the sole UI observation; every other conclusion follows a real result here.
  completeObjective(player: Player | undefined, id: Objective) {
    if (player) (player.objectives ??= {})[id] = true;
  }
  selectObjective(player: Player, data: RoomRequest) {
    if (data.action !== 'select' || !unknownArray(data.ids) ||
      (data.ids.length > MAX_FACTION_CONSTRUCTIONS && data.ids.length > this.enlisted(this.faction(player)).length) || !stringArray(data.ids))
      throw userError('Seleção de objetivo inválida.');
    const out = this.outOfAction();
    for (const id of data.ids) {
      const actor = this.world.actor(id);
      if (!this.usable(player, actor) || !actor.vehicle?.config.enabled || out[id] || this.held(actor)) continue;
      const pieces = this.world.modules.filter(piece => piece.actorId === id && piece.health > 0 && piece.attached !== false);
      if (ORES.some(material => pieces.some(piece => extracts(piece, material)) && pieces.some(piece => hauls(piece, material) && cargoRoom(piece) > 0))) {
        this.completeObjective(player, 'selectMiner'); break;
      }
    }
    return {};
  }
  // What a player is told of the faction, alone: its stocks, what of them something stands still for or that falls short of
  // what the fleet and the works ask (`wants`, stock-wants.ts), what waits in its yard and its base — none, for one that lost
  // it —, what the aid would be to it (`recovery`) and the last time it recovered (`recovered`),
  // the ground it has explored, as spans of the world from the left (`explored`: nothing on a field without fog, where
  // all of it is known), who
  // is in it, each with what it is to the faction (`role`), the factions it has met (`known`) and who else is on the field
  // (`strangers`), who invited the player — each faction with what a request to join it names it by (`ref`) —,
  // whether the player left service to itself, what each construction of the faction (`fleet`)
  // is worth, would cost to service and carries, the wrecks on the field with what they would give, and the veins
  // the faction knows of (`depositView`), its works and its heaps (`Works.view`) and the roads it asked for (`Roadworks.view`),
  // which no other faction is told of. Every
  // amount is by stock or by thing dug; nothing is told of the stocks or the yards of others.
  // Of the library of the faction, each project by its name, whoever published it and when (`library`): the designs
  // themselves are asked for (`shelf`). Of the request to join another faction the player has, that faction (`request`); and
  // to its leader and its administrators, who asks to join it, from which faction (`requests`).
  // A load being taken on and a vein are told in steps, and a load at rest exactly.
  // Of the service of a construction: whether it stands still, and whether it is in the air (`aloft`), what its supply pieces carry (`supplies`, nothing without one), whether
  // one of them serves (`serves`, as `serving` has it: it is a supply vehicle then), what loading supplies at the base would take from the stocks (`load`, where it can be done), what the point mends of a repair it
  // does not pay the whole of (`mend`), and the point that would serve
  // it now — the base, or the supply vehicle named, with what that one carries and what holds it — with what
  // filling up there would come to. The point told is the nearest ready one that pays for something the construction
  // is short of, or the nearest that is ready, or the nearest: a supply vehicle is told itself, with the fuel it
  // carries, where that is what fills its tank. Of a repair under way it is told what it cost and the supply vehicle
  // that paid, and of one cancelled where the construction stands, that it waits to be asked for (`declined`).
  // Of a faction it has met: its name, which is its leader's, as an invitation names it, and that one's colour; its members, and
  // whether this faction invited each; whether one of its constructions is in sight now (`seen`) or else when and where
  // one last was, in the time of the field; and when it last lost its base, while it was not seen since (`defeated`).
  // Of the players on the field in factions it has not met: a name, whether connected, whether invited, and no more.
  // Of every faction on the field, its own with them, how wealthy it is (`ranking`, the wealthiest first: `riches`): of
  // its own and of those it has met as they are named everywhere; of any other, the name it goes by — its nation's, or
  // its leader's while it has none — and its flag, and nothing else, not even its name on the field (its id), whose count
  // says when it came: those as wealthy as one another are in the order of the names they go by. Each, its own with them,
  // with what a player who asks to join it names it by (`ref`).
  // Of a faction founded for a player removed from another, where from and when (`removed`).
  // Of the bases (`besiege`): the capture of its own under way (`siege`), as far as it had gone when the field last
  // looked and which way it goes since; the bases of others it is taking or stands armed in (`taking`), each by whose it
  // is, with the capture of it by this faction or, while none can begin, as contested, and whether it is sheltered
  // (`shelter`); the last base it took (`taken`): whose it was, when, how many constructions were dismantled there and what
  // came of it to the stocks and to the yard; and the last base it lost (`fell`): by whom, when, where it stood, and what
  // dismantling gave back and the looting took.
  // Of the bases of others it knows (`reconnoitred`), each by whose it is: where it stood and how it faced when last seen,
  // as far as it covers, and whether it is in sight now (`seen`) or else when it last was, in the time of the field; and
  // of one in sight, whether it is sheltered. Of its posts (`posts`): each by its name, where it stands and how it faces, as
  // far as it serves, how high its eye is and how far it sees, its taking down under way — how far it has gone, in what
  // time, whether a builder works at it now and the builder sent to it —, and its capture under way (`siege`), by whom.
  // Of the posts of others it knows (`outposts`, `scouted`), as of their bases, each by its name and by whose it is. The
  // posts of others it is taking or stands armed in are told with the bases (`taking`), by their names (`post`) and where
  // they stand, and whether this faction has all the posts it may have, so that it takes none (`full`); the last post it
  // lost (`lost`): when, where, to whom and what of its yard went into the stocks; and the last it took (`seized`): when,
  // where and whose it was. Of the territories of the field, those it is told of (`territories`).
  factionView(playerId: string, parts: ReturnType<typeof fieldParts> = fieldParts(this.world), wrecks?: Map<string, KnownWreckReading>): FactionView | null {
    const p = this.players.get(playerId), faction = p && this.faction(p);
    if (!faction) return null;
    const name = (f: Faction) => this.named(f), member = (id: string) => this.players.get(id)!,
      controller = (id: string): Pick<FieldPerson, 'ai'> => {
        const state = this.commanders.get(id);
        return state ? { ai: state.enabled ? 'active' : 'paused' } : {};
      },
      controlled = (f: Faction): Pick<FieldStanding, 'ai'> => {
        const states = [...f.members].map(id => this.commanders.get(id));
        return states.length && states.every(state => state !== undefined) ? { ai: states.some(state => state?.enabled) ? 'active' : 'paused' } : {};
      },
      person = (m: Player): FieldPerson => ({ id: m.id, name: m.name, connected: m.connected, invited: faction.invited.has(m.id), ...controller(m.id) });
    // What a faction is called and flies: the name its members gave their nation, or none — it then goes by its leader's —,
    // and the flag they made, or the one drawn for it (`flagDraw`).
    // A faction named by its id is told so, and one gone since is nobody; a capture is told without what holds it.
    const identity = (f: Faction): FieldIdentity => ({ name: name(f), nation: f.nation ?? null, flag: f.flag }),
      // A faction in the ranking: its own and one it met as it is named everywhere, and any other by what everybody is told
      // of it — a leader's name only while it is the name the faction goes by.
      standing = (f: Faction): FieldStanding => ({ ...(f === faction || faction.met.has(f.id) ? { id: f.id, ...identity(f) } :
        { id: null, name: f.nation ? null : name(f), nation: f.nation ?? null, flag: f.flag }), ...controlled(f) }),
      // In the order of the names they go by, and of their flags where two go by the same: never in the order they came.
      order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0,
      byName = (a: FieldStanding, b: FieldStanding) => compareNames((a.nation ?? a.name)!, (b.nation ?? b.name)!) || order(JSON.stringify(a.flag), JSON.stringify(b.flag)),
      riches = this.riches(parts),
      called = (id: string) => this.factions.has(id) ? identity(this.factions.get(id)!) : null,
      course = (capture: NonNullable<Faction['capture']>): FieldCapture => ({ progress: capture.progress, at: capture.at, state: capture.state });
    const asked = p.request && this.factions.get(p.request), admits = this.role(faction, p.id) !== 'member';
    return { id: faction.id, ref: faction.ref, ...identity(faction), stock: whole(faction.stock), wants: this.wants(faction, parts), yard: rounded(this.yards(faction)), base: this.base(p),
      ...(this.duel ? { duel: duelView(this.duel, faction.id) } : {}),
      industry: industryView(faction.industry),
      objectives: { fieldId: this.fieldId, completed: { selectMiner: p.objectives.selectMiner === true, collectOre: p.objectives.collectOre === true, deliverOre: p.objectives.deliverOre === true, directControl: p.objectives.directControl === true, fabricateVehicle: p.objectives.fabricateVehicle === true, buildDefense: p.objectives.buildDefense === true } },
      recovery: this.recovery(faction), recovered: faction.recovered, fell: faction.fell && { ...faction.fell, by: called(faction.fell.by) }, removed: faction.removed, explored: faction.explored,
      siege: faction.capture && course(faction.capture),
      taking: [...this.factions.values()].flatMap(other => {
        const capture = other.capture?.by === faction.id ? other.capture : null, there = this.contested.get(other.id),
          posts = other.posts.flatMap(post => {
            const capture = post.capture?.by === faction.id ? post.capture : null, there = this.disputed.get(post.id);
            if (!capture && !there?.foes.includes(faction.id)) return [];
            return [{ id: other.id, ...identity(other), post: post.id, x: post.x, ...(capture ? course(capture) : { progress: 0, at: 0, state: 'contested' as const }),
              sheltered: !capture && other.shelter !== null, full: Boolean(there?.full.includes(faction.id)) }];
          });
        if (!capture && !there?.foes.includes(faction.id)) return posts;
        return [{ id: other.id, ...identity(other), ...(capture ? course(capture) : { progress: 0, at: 0, state: 'contested' as const }),
          sheltered: !capture && other.shelter !== null }, ...posts];
      }),
      lost: faction.lost && { ...faction.lost, by: called(faction.lost.by) },
      seized: faction.seized && { ...faction.seized, of: called(faction.seized.of) },
      taken: faction.taken && { ...faction.taken, of: called(faction.taken.of) },
      bases: [...this.reconnoitred(faction)].map(([id, known]) => {
        const seen = !this.fog || contains(faction.seen, known.x), other = this.factions.get(id)!;
        return { id, ...identity(other), x: known.x, facing: known.facing, radius: BASE_RADIUS, seen, at: seen ? null : known.at,
          sheltered: seen && other.shelter !== null };
      }),
      outposts: [...this.scouted(faction)].map(([id, known]) => {
        const seen = !this.fog || contains(faction.seen, known.x), other = this.factions.get(known.of)!;
        return { id, of: known.of, ...identity(other), x: known.x, facing: known.facing, radius: POST_RADIUS, seen, at: seen ? null : known.at,
          sheltered: seen && other.shelter !== null };
      }),
      members: [...faction.members].map(member).map(m => ({ id: m.id, name: m.name, connected: m.connected, role: this.role(faction, m.id), ...controller(m.id) })),
      known: [...faction.met].map(([id, met]) => {
        const other = this.factions.get(id)!, seen = met.at !== null && met.at === this.acquainted;
        return { id, ...identity(other), color: member(other.leader)?.color ?? null, members: [...other.members].map(member).map(person),
          seen, at: seen ? null : met.at, x: seen ? null : met.x, defeated: met.defeatedAt };
      }),
      strangers: [...this.players.values()].filter(m => m.factionId !== faction.id && !faction.met.has(m.factionId!) && this.present(m)).map(person),
      ranking: [...this.factions.values()].map(f => ({ ...standing(f), ref: f.ref, wealth: riches.get(f.id)! })).sort((a, b) => b.wealth - a.wealth || byName(a, b)),
      invites: [...this.factions.values()].filter(f => f.invited.has(p.id)).map(f => ({ factionId: f.id, ref: f.ref, ...identity(f), members: f.members.size })),
      request: asked ? { ref: asked.ref, ...standing(asked) } : null,
      requests: admits ? [...this.players.values()].filter(m => m.request === faction.id)
        .map(m => ({ id: m.id, name: m.name, connected: m.connected, ...controller(m.id), from: standing(this.factions.get(m.factionId!)!) })) : [],
      library: faction.library.map(({ id, name, author, by, at }) => ({ id, name, author, by, at })),
      trades: this.socialView(this.trades, faction), accords: this.socialView(this.accords, faction, true),
      count: this.enlisted(faction).length, counts: this.constructionCounts(faction),
      posts: faction.posts.map(post => ({ id: post.id, x: post.x, facing: post.facing, radius: POST_RADIUS, eye: POST_EYE, sight: POST_SIGHT,
        takedown: post.takedown && { progress: Math.floor(post.takedown.progress * 1000) / 1000, seconds: post.takedown.seconds,
          building: Boolean(this.works.builders.get(post.id)?.length), sent: this.supplyDispatch.coming(post.id) },
        siege: post.capture && { ...course(post.capture), by: called(post.capture.by) } })),
      territory: this.territories(faction),
      units: this.units(faction, parts),
      wrecks: this.wrecks(p, faction, parts, wrecks),
      deposits: this.depositView(p), activity: activityView(this, faction), ...this.works.view(faction), roadworks: this.roadworks.view(faction) };
  }
  // What the costs of a reading of the field (`parts`) come to, worked out once for all that ask: each construction as it is
  // appraised (`appraise`), and of each faction what its constructions (`units`) and its stocks (`wants`) are told as.
  reading(parts: ReturnType<typeof fieldParts>): ReadingCache {
    if (this.quoted?.parts !== parts) this.quoted = { parts, appraisals: new Map(), factions: new Map(), wants: new Map() };
    return this.quoted;
  }
  appraisal(actor: Actor, parts: ReturnType<typeof fieldParts>): Appraisal {
    const { appraisals } = this.reading(parts);
    if (!appraisals.has(actor.id)) appraisals.set(actor.id, appraise(actor, parts));
    return appraisals.get(actor.id)!;
  }
  wants(faction: Faction, parts: ReturnType<typeof fieldParts>): ReturnType<typeof stockWants> {
    const { wants } = this.reading(parts);
    if (!wants.has(faction.id)) wants.set(faction.id, stockWants(this, faction, parts, actor => this.appraisal(actor, parts)));
    return wants.get(faction.id)!;
  }
  // What each construction of the faction is told as (`factionView`): the same to every member, worked out once for the
  // costs of a reading of the field (`parts`).
  units(faction: Faction, parts: ReturnType<typeof fieldParts>): UnitView[] {
    const worked = this.reading(parts).factions, cached = worked.get(faction.id);
    if (cached && cached.every(unit => !unit.builder || unit.builder.working === this.works.working(unit.id))) return cached;
    const mix = this.mix(faction), units = this.fleet(faction).map(a => this.unitView(a, faction, parts, mix));
    worked.set(faction.id, units);
    return units;
  }
  unitView(a: Actor, faction: Faction, parts: ReturnType<typeof fieldParts>, mix: SupplyBill): UnitView {
        const quote = this.appraisal(a, parts), { service, declined, loading, extraction, tools, cargoWork, combatAt, refilled, auto, homing } = this.record(a),
          // Cargo follows the same reading as the appraisal, in authored order, including damaged and detached pieces.
          installed = (piece: { id: string }): SceneModule | undefined => { const live = parts.get(`${a.id}:${a.revision}:${piece.id}`); return live?.kind !== undefined ? live : undefined; },
          pieces = reservoirsOf(a.blueprint.modules).map(installed).filter(defined), crates = cratesOf(a.blueprint.modules).map(installed).filter(defined),
          pavers = a.blueprint.modules.filter(holdsMix).map(installed).filter(defined),
          calm = this.calm(a), calmUntil = combatAt + CALM_SECONDS, { carried, room } = carriedBy(pieces),
          cargo = loading ? steppedCargo(carried) : rounded(carried), told = fillOf(cargo, room), real = fillOf(carried, room), atBase = this.atBase(faction, a), depot = this.atDepot(faction, a),
          points = this.points(faction, a).map(point => this.resupplyPoint(a, quote, point, parts)),
          { point, rearm, mender, part } = serviceOffers(a, quote, points),
          stated = (point: ServicePoint) => {
            const calmUntil = point.held === 'combat' && point.supplier ? this.record(point.supplier).combatAt + CALM_SECONDS : null;
            return { supplier: point.supplier?.id ?? null, stock: point.supplier ? whole(point.stock) : null, held: point.held ?? '',
              ...(calmUntil !== null && Number.isFinite(calmUntil) ? { calmUntil } : {}) };
          },
          taking = depot && crates.some(piece => piece.health > 0) && !this.supplyDispatch.manages(a.id) ? supplyLoad(crates, mix, faction.stock) : null,
          builder = a.blueprint.modules.some(piece => piece.kind === 'builder'), reason = builder ? this.builderRefusal(a) : '';
        return { id: a.id, vehicle: isVehicleDesign(a.construction), value: quote.salvage, built: quote.built, repair: quote.repair, repairSeconds: quote.seconds, rearm: quote.rearm,
          mend: part && { cost: part.cost, seconds: part.seconds },
          // One in a post says so: it is served there as in the base, but for the workshop.
          atBase, ...(depot?.post ? { atPost: true } : {}), calm, ...(!calm && Number.isFinite(calmUntil) ? { calmUntil } : {}),
          // Its tanks run as low as a supply vehicle is sent to it for: the column of the field says so.
          ...(runsLow(a.blueprint, quote, ['fuel']) ? { fuelLow: true } : {}),
          ...(refilled && this.world.time < refilled.until ? { refilled: { ...refilled } } : {}),
          ...(cargoWork && !service ? { cargoWork } : {}),
          // A builder says what it works on, and why it may not now; a road machine, that it is one.
          ...(builder ? { builder: { reach: CONSTRUCTION_REACH, ready: !reason, reason, working: this.works.working(a.id) } } : {}),
          ...(roadMachine(a) ? { road: true } : {}),
          // One that works by itself says whether it is in automatic, and its job (supply-dispatch.ts).
          ...(worker(a) ? { auto: Boolean(auto), job: this.supplyDispatch.view(a.id) } : {}),
          // An aircraft says whether it keeps its fuel to come home (Squad.homing), and one in the air says so (`aloft`): it
          // stands nowhere — it is served, repaired, dismantled and replaced, and takes a wreck, only landed (`still`).
          ...(aircraft(a) ? { homing: homing !== false } : {}), ...(a.vehicle?.flying ? { aloft: true } : {}),
          // A structure being taken down says how far that has gone, whether a builder takes it down now, the builder sent to
          // it and the works it is moved to.
          still: this.still(a), service: service?.kind === 'dismantle' ? factionService(service, {
            building: this.works.builders.get(a.id)?.some(actorId => this.works.working(actorId) === a.id) ?? false,
            sent: this.supplyDispatch.coming(a.id) }) : factionService(service),
          declined: declined !== null, cargo, fill: { solid: loadLevel(told.solid, real.solid), liquid: loadLevel(told.liquid, real.liquid), supplies: Math.round(suppliesFill(crates) * 100) / 100 }, loading,
          extracting: extraction?.[0]?.siteId ?? null, ...(tools ? { tools } : {}),
          supplies: crates.length ? whole(supplied(carriedBy(crates).carried)) : null, serves: crates.some(piece => piece.health > 0 && piece.attached !== false), load: taking,
          // A paver says what the hoppers of its pavers hold, by the stocks it was taken from, and how full they are.
          ...(pavers.length ? { mix: { held: whole(supplied(carriedBy(pavers).carried)), fill: Math.round(mixFill(pavers) * 100) / 100 } } : {}),
          point: point ? { ...stated(point), resupply: rearm } : null, mender: mender ? stated(mender) : null };
  }
  // How wealthy each faction is, by its name on the field, as the field last reckoned it: once in a second of the field at
  // most, whoever asks, and of a faction founded since when it is first asked for. Wealth is in points, a kilogram to a
  // point (`weight`): the stocks of the faction and what waits in its yards, as the stock it is refined into; and of each
  // construction of its members on the field, what dismantling it would give back (`appraise`), what it carries — its
  // load as its yard is counted, and its supplies and the mix of its pavers, in pieces that serve or not — and what a repair under way was paid
  // with, which its cancellation would give back; recoverable post capital, industrial capital and paid pending upgrades;
  // and what came of its works and lies in its heaps. A wreck is nobody's.
  riches(parts: ReturnType<typeof fieldParts>) {
    const second = Math.floor(this.field.time);
    if (this.reckoned?.second !== second) this.reckoned = { second, wealth: new Map() };
    const { wealth } = this.reckoned, owing = [...this.factions.values()].filter(faction => !wealth.has(faction.id));
    if (!owing.length) return wealth;
    const loads = new Map<string, SceneModule[]>(), crates = new Map<string, SceneModule[]>(), add = (map: Map<string, SceneModule[]>, piece: SceneModule) => (map.get(piece.actorId) ?? map.set(piece.actorId, []).get(piece.actorId)!).push(piece),
      held = (map: Map<string, SceneModule[]>, actor: Actor) => carriedBy(map.get(actor.id) ?? []).carried;
    for (const piece of reservoirsOf(this.world.modules)) add(loads, piece);
    for (const piece of this.world.modules) if (piece.kind === 'supply' || holdsMix(piece)) add(crates, piece);
    for (const faction of owing) {
      let points = weight(faction.stock) + weight(refined(this.yards(faction))) + weight(faction.industry.capital) +
        (faction.industry.pending ? weight(faction.industry.pending.cost) : 0);
      for (const post of faction.posts) points += weight(post.salvage);
      for (const work of this.works.of(faction.id)) points += weight(work.delivered);
      for (const heap of this.works.heapsOf(faction.id)) points += weight(heap.stock);
      for (const actor of this.enlisted(faction)) {
        const service = this.records.get(actor.id)?.service, cost = service?.kind === 'repair' ? service.cost : undefined;
        points += weight(appraise(actor, parts).salvage) + weight(refined(held(loads, actor))) + weight(supplied(held(crates, actor))) + (cost ? weight(cost) : 0);
      }
      wealth.set(faction.id, Math.round(points));
    }
    return wealth;
  }
  // The wrecks a faction knows of: its own, those in its sight, and the ghosts of those it last
  // saw as wrecks. Of one in sight it is told what it gives and carries now; of a ghost, what it was
  // last told, whatever became of the wreck since.
  knownWrecks(faction: Faction, parts: ReturnType<typeof fieldParts>): KnownWreckReading {
    const before = faction.wrecks || new Map<string, KnownWreck>(), kept = faction.wrecks = new Map<string, KnownWreck>(), told: KnownWreckReading['actors'] = new Map(), time = this.field.time;
    for (const a of this.world.actors) {
      const record = this.records.get(a.id), how = record?.wreck ? this.knows(faction.id, a) : null;
      if (how !== 'own' && how !== 'seen') continue;
      kept.set(a.id, { id: a.id, name: a.name, x: Math.round(this.position(a)), until: record!.wreck!.until, value: this.worth(a, parts), cargo: rounded(this.wreckCargo(a.id)) });
      told.set(a.id, a);
    }
    // The ghost of a wreck stays in the list while it stands on the screens, whether the wreck is still there or not.
    for (const [id, row] of before) {
      const ghost = !kept.has(id) ? this.fog?.ghost(faction.id, id, time) : undefined;
      if (ghost?.defeated) { kept.set(id, row); told.set(id, ghost); }
    }
    return { rows: [...kept.values()], actors: told };
  }
  // A publication prepares the shared knowledge once. Individual queries prepare
  // their own reading; availability and the wait for calm are always this player's.
  wrecks(p: Player, faction: Faction, parts: ReturnType<typeof fieldParts>, reading?: Map<string, KnownWreckReading>): WreckView[] {
    let known = reading?.get(faction.id);
    if (!known) { known = this.knownWrecks(faction, parts); reading?.set(faction.id, known); }
    return known.rows.map(row => ({ ...row, inReach: this.reaching(p, known.actors.get(row.id)!).length > 0,
      calmIn: this.calmIn(p, known.actors.get(row.id)!) }));
  }
  // The veins a faction knows of, as a player of it is told, from one end of the ground to the other. Of each: what
  // was left of it when the faction last saw it, in whole steps (`RESERVE_STEP`), so that a vein with less than one left
  // is told empty and one coming back gains a step only once it holds it, and a whole one exactly;
  // whether the faction has it in sight now (`seen`) or else when it last had, in the time of the field; whether a
  // construction of the faction is loading there; and whether a base stills it, as the faction knows (`stilled`): a base
  // founded beside a vein out of its sight is not told by it, but by digging there (`felt`). Of a site the faction never saw
  // nothing at all is told: to it that is ground like any other.
  depositView(p: Player) {
    const faction = this.faction(p), fleet = this.fleet(faction), loading = new Set(fleet.map(a => this.record(a).loading)),
      extracting = new Set(fleet.flatMap(a => this.record(a).extraction ?? []).map(tool => tool.siteId));
    return this.prospected(faction).map(site => {
      const known = this.known(faction, site)!, seen = !this.fog || contains(faction.seen, site.x);
      return { id: site.id, left: known.left >= site.reserve ? site.reserve : Math.floor(known.left / RESERVE_STEP) * RESERVE_STEP,
        stock: Math.ceil((known.stock ?? 0) / CARGO_STEP) * CARGO_STEP, at: seen ? null : known.at, seen,
        loading: loading.has(site.id), extracting: extracting.has(site.id), active: !this.stilled(faction, site) };
    });
  }
  // A lookup of the authoritative Native projection, never a host pair registry.
  towOf(actorId: string) { return this.field.tows.find(link => link.actorId === actorId || link.targetId === actorId); }
  // The target is left idle on both attachment and release. No saved order stack
  // is revived after the cable is gone, and no velocity or body pose is rewritten.
  idleTowTarget(actor: Actor, brake: number) {
    const owner = lookup(this.players, actor.ownerId);
    if (owner?.squad!.manual === actor.id) { this.release(owner.id); this.take(owner, null); }
    this.supplyDispatch.set(actor.id, false);
    owner?.squad!.command({ order: 'stop', ids: [actor.id] });
    Object.assign(this.record(actor), { drive: null, pulled: null });
    releaseWorldInputs(this.world, [actor.id], brake, true, true);
    if (owner) this.hasten(owner);
  }
  // Either end of a cable lets go of it, the target left idle on its brakes (`idleTowTarget`): a load let go of in the air
  // falls as it hangs.
  unhook(actor: Actor) {
    const previous = this.towOf(actor.id);
    this.world.command('towDetach', { actorId: actor.id });
    const target = previous && this.world.actor(previous.targetId);
    if (target) this.idleTowTarget(target, 1);
  }
  tow(p: Player, data: RoomRequest) {
    if ((data.act !== 'attach' && data.act !== 'detach') || typeof data.actorId !== 'string' || !data.actorId)
      throw userError('Comando de reboque inválido.');
    const actor = this.requireActor(p.id, data.actorId); this.vacant(p, actor);
    // An aircraft takes what it tows up on a sling (sling.ts), and is told so.
    const sling = (actor.vehicle?.thrustN ?? 0) > 0, change = (op: 'towAttach' | 'towDetach', targetId?: string) => {
      try { return this.world.command(op, { actorId: actor.id, ...(targetId ? { targetId } : {}) }); }
      catch (error) {
        // The refusals of a sling that carry numbers go as phrases with values (user-message.ts), to be read in the
        // player's language.
        const target = targetId ? this.world.actor(targetId) : undefined, tonnes = (kg: number) => (kg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }),
          message = { TOW_ACTOR: 'Escolha dois veículos reparáveis da sua facção.', TOW_BUSY: 'Um desses veículos já está ligado a um cabo.',
          TOW_MOTOR: 'O rebocador precisa de um motor em condições de puxar.',
          TOW_ANCHOR: sling ? 'Falta chassi na vertical do centro de massa da aeronave ou do veículo para prender o cabo.' :
            'Não há metal do chassi em condições de prender o cabo.',
          TOW_REACH: sling ? () => userError`Paire a até ${SLING_REACH} m sobre o veículo para conectar o cabo.` : 'Aproxime os chassis para conectar o cabo.',
          TOW_SPEED: sling ? 'Pare a aeronave sobre o veículo parado antes de conectar o cabo.' : 'Pare os dois veículos antes de conectar o cabo.',
          TOW_HEAVY: () => userError`Pesado demais para os propulsores: a aeronave ergue até ${tonnes(slingLimit(this.world, actor.id))} t além do próprio peso, e o veículo pesa ${tonnes(target?.vehicle?.mass ?? 0)} t.` }[errorMessage(error)];
        if (!message) throw error;
        throw Object.assign(typeof message === 'function' ? message() : new Error(message), { code: errorMessage(error) });
      }
    }, previous = this.towOf(actor.id);
    if (data.act === 'detach') {
      this.unhook(actor);
      return { towing: false };
    }
    if (typeof data.targetId !== 'string' || !data.targetId || data.targetId === actor.id)
      throw userError('Escolha outro veículo da sua facção para rebocar.');
    const target = this.requireActor(p.id, data.targetId); this.vacant(p, target);
    // Repeating an accepted directed pair must not cancel a new Move or recapture
    // cable length merely because the bodies are moving or the engine ran dry.
    if (previous?.actorId === actor.id && previous.targetId === target.id) { change('towAttach', target.id); return { towing: true }; }
    for (const end of [actor, target]) {
      if (!isVehicleDesign(end.construction) || !end.vehicle || this.outOfAction()[end.id] || this.record(end).wreck)
        throw userError('Escolha dois veículos reparáveis da sua facção.');
      if (this.held(end)) throw new Error(this.held(end));
      if (this.towOf(end.id)) throw userError('Um desses veículos já está ligado a um cabo.');
    }
    // The Native validator chooses real anchors, checks their velocities/range,
    // motor and material, and inserts atomically before any host order is lost.
    change('towAttach', target.id);
    this.claim(p, [actor, target]);
    this.supplyDispatch.set(actor.id, false);
    const unit = p.squad!.units.get(actor.id)!;
    if (unit.move?.purpose !== 'order') unit.move = null;
    Object.assign(unit, { attack: null, haul: null, fireAt: null });
    this.idleTowTarget(target, this.towOf(actor.id)?.sling ? 1 : 0);
    this.hasten(p);
    return { towing: true };
  }
  // The player's hands go to a vehicle, or to none when it can no longer be driven.
  take(p: Player, actorId: string | null) {
    if (actorId && this.towOf(actorId)?.targetId === actorId) actorId = null;
    try { p.squad!.command({ order: 'control', id: actorId }); } catch { p.squad!.command({ order: 'control', id: null }); }
  }
  // The seat a player who comes takes (`seat`) and the name they say (`playerName`): refused, in words, as `seat` refuses
  // it, and for a name another seat goes by (`nameFree`). Asking changes nothing on the field.
  admit(name: unknown, token: unknown = '', address: string | null = null) {
    const called = playerName(name), player = this.seat(token, address);
    if (called) this.nameFree(called, player);
    return { called, player };
  }
  // Refuses, in words, a name that reads as the name of another seat of the field (`alike`), whether its player is on the
  // field or away: a name is a seat's for as long as the seat is. The name a player goes by is theirs to say again, however
  // it is written, even where another goes by it too — two of a field kept from before names were told apart, who go by it
  // until one of them changes it.
  nameFree(name: string, player: Player | null = null) {
    const sought = alike(name);
    if (player && alike(player.name) === sought) return;
    if ([...this.players.values()].some(other => other !== player && alike(other.name) === sought)) throw Object.assign(userError(TAKEN), { nameTaken: true });
  }
  // The name of a new seat whose player says none: the first of 'Jogador', 'Jogador 2', 'Jogador 3'… no seat goes by.
  unnamed() {
    const taken = new Set([...this.players.values()].map(p => alike(p.name)));
    let n = 1;
    while (taken.has(alike(numbered(n)))) n++;
    return numbered(n);
  }
  // A player goes by another name from now on, at their word: none is refused, and so is one another seat goes by
  // (`nameFree`), before anything changes.
  rename(p: Player, name: unknown) {
    const called = playerName(name);
    if (!called) throw userError('Escreva o seu nome.');
    this.nameFree(called, p);
    this.goBy(p, called);
    return { name: called };
  }
  // A player goes by `name` on everything of theirs on the field and on every project they put in a library.
  goBy(p: Player, name: string) {
    p.name = name;
    for (const actor of this.owned(p.id)) actor.playerName = name;
    for (const faction of this.factions.values()) for (const model of faction.library) if (model.author === p.id) model.by = name;
  }
  // A seat on the field is kept by its key (`token`, `accessKey`): whoever comes with it, from any device, is the player
  // of that seat, with the faction and all it has; and a page that comes to a seat another page sits in takes it from
  // that one (the host lets that one go). A key the field does not know is refused: a new seat is for whoever comes with none.
  // An address (`address`, as the server counts those who come: null for one it does not count, which comes as often
  // as it likes) has two players connected at a time: two of a house, or one with two pages. A seat is not taken
  // from an address two other players are connected from; what a player who left has standing on the field does not
  // count. And an address is given three new factions, each with its base, in a day of the field (`newcomer`): a new seat —
  // a third page, or a browser that forgot the seat it had — is one, and so is a player of it leaving their faction
  // (`quit`); coming back to a seat by its key is not. A player who comes back keeps the name they had unless the page
  // says another (`playerName`), and the faction is on the field again (`arrive`). No two seats come to go by one name
  // (`nameFree`), and a new one whose player says none is given the first free of its own (`unnamed`).
  // Whatever the field refuses a player who comes, it refuses before anything on it changes (`admit`).
  join(name: unknown, token: unknown = '', address: string | null = null, draw: string = flagDraw()) {
    const { called, player: seated } = this.admit(name, token, address), created = !seated;
    if (created && this.duel) throw userError('Este duelo já tem suas duas facções. Reconecte com seu acesso existente.');
    const prepared = created && this.starter ? this.starterDesigns() : [];
    let player = seated;
    if (!player) {
      player = { id: this.mint('j'), token: accessKey(), name: called ?? this.unnamed(), color: COLORS[this.players.size % COLORS.length]!, selected: null,
        request: null, builtAt: -Infinity, published: new Map(), objectives: {} };
      this.players.set(player.id, player); credit(this.found(player, draw).stock, this.grant);
      player.squad! = new Squad(new Side(this, player.id));
      this.newcomer(address);
    }
    // Who comes into the field commands the squad: nobody is put at the controls of a vehicle by coming.
    player.connected = true; player.address = address; player.lastInput = this.steps; this.release(player.id); this.take(player, null);
    this.arrive(this.faction(player));
    if (created && this.starter) this.grantStarter(player, prepared);
    this.goBy(player, called ?? player.name);
    return { playerId: player.id, token: player.token, name: player.name, selected: player.selected, base: this.base(player),
      faction: this.factionView(player.id), chat: this.chatView(player.id), actors: this.fleet(this.faction(player)).map(a => this.design(a)) };
  }
  // An internal controller owns an ordinary seat and pays the ordinary economy.
  // Its active presence is explicit; no socket is fabricated and its key is never returned.
  addCommander(name: string, profile: CommanderProfile = 'balanced', draw: string = flagDraw()) {
    const state = newCommanderState(profile, this.field.time), joined = this.join(name, '', null, draw),
      player = this.players.get(joined.playerId)!;
    this.commanders.set(player.id, state);
    player.connected = false; player.address = null;
    this.arrive(this.faction(player));
    return { id: player.id, factionId: this.faction(player).id, enabled: state.enabled };
  }
  setCommanderEnabled(id: string, enabled: boolean) {
    const state = this.commanders.get(id), player = this.players.get(id);
    if (!state || !player || typeof enabled !== 'boolean') throw new Error('Controlador de facção inválido.');
    if (state.enabled !== enabled) {
      state.enabled = enabled; state.nextAt = this.field.time;
      if (enabled) this.arrive(this.faction(player));
      else this.disconnect(id);
    }
    return { id, factionId: this.faction(player).id, enabled: state.enabled };
  }
  // Only a new seat gets a ready miner, scout and constructor.
  // Returning to an existing identity or changing faction grants nothing.
  starterDesigns() {
    return (['mining-truck', 'scout', 'construction-truck'] as const).map(template =>
      manufactureDesign(this.validateDesign(createStructuredTemplate(template))));
  }
  grantStarter(player: Player, prepared: CompilerResponse[] = this.starterDesigns()) {
    for (const design of prepared) this.furnish(player, design);
    this.take(player, null);
  }
  // A construction of the catalogue, ready, at the first free place of the base of the player's faction and facing as the
  // base does, under the player's command: what a faction is founded with, and the lorry of the aid (`recover`).
  furnish(player: Player, prepared: CompilerResponse) {
    const blueprint = prepared.construction, faction = this.faction(player), direction = faction.base!.facing,
      x = this.placement(player, blueprint, null, direction), id = this.mint('c'),
      actor = this.world.addActor(blueprint, { id, ownerId: player.id, team: faction.id, x, facing: direction, color: player.color, playerName: player.name });
    this.topology++; this.show(actor);
    return actor;
  }
  // The seat a player who comes with `token` takes (`join`): the one that key keeps, or none for a new one. Refused, in
  // words, for a key no seat keeps (`holder`), where the field or the address has no room for the player, or where a new
  // seat is asked for from an address given all its new seats of the day. Asking changes nothing on the field: not even
  // its scene is read.
  seat(token: unknown = '', address: string | null = null) {
    const id = this.holder(token), player = id === null ? null : this.players.get(id)!;
    if (address !== null && [...this.players.values()].filter(p => p !== player && p.connected && p.address === address).length >= ROOM_LIMITS.perAddress)
      throw userError(CROWDED);
    if (address !== null && !player && this.newcomersOf(address).length >= ROOM_LIMITS.newPerAddressPerDay) throw userError(SPENT);
    if (!player?.connected && [...this.players.values()].filter(p => p.connected).length >= ROOM_LIMITS.players) throw userError(FULL);
    return player;
  }
  // The seat a key keeps, by whose it is, however the key is written (`keyOf`): none for no key, and refused, in words,
  // for one no seat keeps — one mistyped, or changed since (`rekey`).
  holder(token: unknown) {
    const key = keyOf(token);
    if (!key) return null;
    const player = [...this.players.values()].find(p => p.token === key);
    if (!player || this.commanders.has(player.id)) throw Object.assign(userError(UNKNOWN_KEY), { unknownKey: true });
    return player.id;
  }
  // A player changes the key of their seat: the one they had keeps it no longer, on any device. Returns the new one, for
  // that player alone.
  rekey(p: Player) { p.token = accessKey(); return { token: p.token }; }
  // The steps of the last day of the field at which `address` was given a new faction.
  newcomersOf(address: string | null) { return (lookup(this.newcomers, address) ?? []).filter(step => this.steps - step < DAY_STEPS); }
  // An address is given a new faction now (`join`, `quit`). One given none for a day is forgotten; one the field does not
  // count (null) is not written down.
  newcomer(address: string | null) {
    if (address == null) return;
    for (const [place, steps] of this.newcomers) if (this.steps - steps.at(-1)! >= DAY_STEPS) this.newcomers.delete(place);
    this.newcomers.set(address, [...this.newcomersOf(address), this.steps]);
  }
  owned(playerId: string) { return this.fielded().filter(a => a.ownerId === playerId); }
  // Whether a player is on the field: connected to it, or with something standing there. Who owns what is the field's
  // own to say: no scene is read for it.
  active(player: Player) { return Boolean(player.connected || this.commanders.get(player.id)?.enabled); }
  present(player: Player) { return this.active(player) || this.field.actors.some(a => a.ownerId === player.id); }
  // Who is on the field and whether each is connected, for the frames (`shown`): a page says of the constructions of whoever
  // is away that they stand there under the orders they were left with. A construction names its player itself. Who is
  // of which faction is not in it: a faction is told that of those it has met, alone (`factionView`).
  roster(): FieldPresence[] {
    return [...this.players.values()].filter(p => this.present(p)).map(p => {
      const state = this.commanders.get(p.id);
      return { id: p.id, connected: p.connected, ...(state ? { ai: state.enabled ? 'active' : 'paused' } : {}) };
    });
  }
  // A construction of the faction as the workshop opens it.
  design(actor: Actor) { return { id: actor.id, blueprint: structuredClone(actor.construction) }; }
  requirePlayer(id: string) { const p = this.players.get(id); if (!p || !this.active(p)) throw userError('Entre no campo primeiro.'); return p; }
  // A construction of the player's faction, held by whoever holds it (`vacant` says whether the player may have it). One
  // that is not the faction's is refused by what the faction has of it on its screens:
  // one it was told of none is, to it, not on the field, and a ghost is what it was when last seen, whether the
  // construction still stands or has left the field since. The sensors are read first for any that is not the
  // faction's, whether it stands on the field or not: how long the answer takes says nothing either.
  requireActor(playerId: string, actorId: unknown) {
    const actor = typeof actorId === 'string' ? this.world.actor(actorId) : undefined, factionId = this.players.get(playerId)?.factionId;
    if (actor && lookup(this.factions, factionId)?.members.has(actor.ownerId ?? '')) return actor;
    this.look();
    const told = actor ? this.told(factionId!, actor) : typeof actorId === 'string' && this.fog?.ghost(factionId!, actorId, this.field.time);
    if (!told) throw userError('Essa construção já não está no campo.');
    throw userError(told.defeated ? 'Essa construção está fora de combate.' : 'Esta construção é de outra facção.');
  }
  // Lets go of the vehicle in the player's hands. The others keep their orders.
  release(playerId: string, { cancelPending = true }: { cancelPending?: boolean } = {}) {
    const manual = this.players.get(playerId)?.squad!.manual;
    if (!manual || !this.world.actor(manual)) return;
    releaseWorldInputs(this.world, [manual], 0, cancelPending, true);
    Object.assign(this.record(this.world.actor(manual)!), { pulled: null, drive: null });
  }
  // A player who leaves has no hands on anything and holds nothing: every vehicle falls back on its orders, free for the
  // members still on the field (`unclaim`), and stays on the field under
  // them as the player left them — what holds its fire holds it, and a hauler goes on with its rounds —; unless the
  // player was the last of the faction on the field (`depart`). The player, the faction and all it has stay on the
  // field however long everybody is away: a faction is over only when its last member leaves it (`leave`).
  disconnect(playerId: string) {
    const p = this.players.get(playerId);
    if (p) { p.connected = false; this.release(playerId); this.take(p, null); this.unclaim(p); this.depart(this.faction(p)); }
  }
  // Whether somebody of a faction is on the field.
  manned(faction: Faction) { return [...faction.members].some(id => this.active(this.players.get(id)!)); }
  // A member of a faction comes on the field: the faction is away no longer, and its base is sheltered no longer.
  arrive(faction: Faction) {
    faction.away = null;
    if (faction.shelter !== null) { faction.shelter = null; this.cover(); }
  }
  // The last member of a faction on the field left it: the faction is away from now (`shelter`), and its fleet comes home.
  depart(faction: Faction) {
    if (faction.away !== null || this.manned(faction)) return;
    faction.away = this.field.time;
    this.recall(faction);
  }
  // A faction with nobody on the field calls its constructions home: each one stops what it was doing, and every vehicle
  // outside its base and its posts is sent to the nearest of them (`depot`; `Squad`, `move`), to stop there; an aircraft,
  // in the air or not, to land there (`home`). One that cannot go — wrecked or stuck, out of fuel —
  // stays where it is. The job one went on by itself ends, and none is given while the faction is away (`SupplyDispatch`): a
  // vehicle in automatic stays in it for when a member comes back, held no longer by an order it was given. A construction
  // held by a service finishes it first: one being built at the base, a structure being taken down, a repair.
  recall(faction: Faction) {
    const out = this.outOfAction();
    for (const id of faction.members) {
      const p = this.players.get(id)!, ids = this.owned(id).filter(actor => !out[actor.id]).map(actor => actor.id);
      if (!ids.length) continue;
      for (const actorId of ids) this.supplyDispatch.drop(actorId);
      p.squad!.command({ order: 'stop', ids });
      const fliers = ids.filter(actorId => (this.world.actor(actorId)!.vehicle?.thrustN ?? 0) > 0),
        away = ids.map(actorId => this.world.actor(actorId)!).filter(actor => actor.vehicle?.config.enabled && !fliers.includes(actor.id) &&
          this.towOf(actor.id)?.targetId !== actor.id && !this.atDepot(faction, actor)), homes = new Map<number, string[]>();
      for (const actor of away) { const x = this.depot(faction, this.position(actor))!.x; homes.set(x, [...homes.get(x) ?? [], actor.id]); }
      for (const [x, group] of homes) p.squad!.command({ order: 'move', ids: group, x });
      if (fliers.length) p.squad!.command({ order: 'home', ids: fliers });
      this.hasten(p);
    }
  }
  // What lapses with the field's steps, as of the step of this number: the host that runs the field looks before each step.
  // A player gone quiet lets go once, not at every look.
  checkLeases(now = this.steps) {
    for (const p of this.players.values())
      if (p.connected && now - p.lastInput! > LEASE_STEPS && p.lapsed !== p.lastInput) { p.lapsed = p.lastInput!; this.release(p.id, { cancelPending: false }); }
  }
  validateDesign(input: unknown): CanonicalConstruction {
    return admitManufacturingDesign(input);
  }
  // A builder is an ordinary vehicle carrying one complete, attached construction mechanism. Its scale changes
  // mass and cost, not its reach or the time a structure takes; there is no second physical arm or build queue. Why it
  // works on nothing now, in words, or nothing when it may: it puts up a works and takes a structure down beside it (`Works.step`).
  builderRefusal(actor: Actor) {
    if (this.towOf(actor.id)) return 'Solte o cabo antes de montar ou desmontar.';
    if (!actor.blueprint.vehicle?.enabled) return 'O braço construtor precisa estar em um veículo.';
    if (this.outOfAction()[actor.id]) return 'O construtor está fora de combate.';
    if (!this.world.modules.some(piece => piece.actorId === actor.id && piece.kind === 'builder' && piece.health > 0 && piece.attached !== false))
      return 'O braço construtor foi destruído ou se soltou.';
    if (this.held(actor)) return this.held(actor);
    if (!this.still(actor)) return actor.vehicle?.flying ? 'Pouse o construtor para montar ou desmontar.' : 'Pare o construtor para montar ou desmontar.';
    if (!this.calm(actor)) return `Saia de combate para montar ou desmontar: ${CALM_SECONDS} s sem atirar nem ser atingido.`;
    return '';
  }
  // A works opened for a structure published (`draft`): nothing is paid for it, and it waits at its place for its material,
  // for the nearest free builder in automatic to put it up (supply-dispatch.ts). The reply names it, where it stands and
  // what it costs.
  begin(draft: FieldDraft, ticket: unknown, instant = false) {
    const { p, blueprint, cost } = draft, work = this.works.open(draft);
    if (instant) {
      credit(draft.faction.stock, cost, -1);
      work.delivered = { ...cost }; work.progress = 1;
      this.works.complete(work);
      p.builtAt = this.steps;
      const actor = this.world.actor(work.id), answer = { ...(actor ? { actor: this.design(actor) } :
        { work: { id: work.id, name: blueprint.name, x: work.x }, blocked: this.works.blocked.get(work.id) }), cost, seconds: 0 };
      this.rememberPublication(p, ticket, answer);
      return answer;
    }
    p.builtAt = this.steps;
    const answer = { work: { id: work.id, name: blueprint.name, x: work.x }, cost, seconds: work.seconds };
    this.rememberPublication(p, ticket, answer);
    return answer;
  }
  // A post is raised as a structure is published (`draft`, `begin`): asked by a player of a faction with a base, at a place a
  // post may have (`postSite`), it is a works of the faction there, facing as asked or as the base does, that costs
  // `POST_BILL` and takes the time the base would take to build that (`buildSeconds`). Asked at once — by a test
  // (`publicationInstant`) —, it is paid from the stocks and stands at once. Refused, in words, by the first thing that fails.
  raise(p: Player, { x, facing, ticket, instant = false }: PlacementRequest) {
    const faction = this.faction(p);
    if (!faction.base) throw new Error(UNBASED);
    if (this.steps - p.builtAt < PUBLISH_STEPS) throw userError('Aguarde um instante antes de fabricar novamente.');
    if (!finiteNumber(x)) throw userError('Escolha o local do posto no campo.');
    postSite(this, faction, x);
    const cost = { ...POST_BILL }, direction = facingValue(facing) ? facing : faction.base!.facing;
    if (instant) this.afford(faction, cost, phrase('erguer o posto'));
    const work = this.works.open({ p, faction, post: true, direction, position: x, cost, seconds: this.building ? buildSeconds(cost) : 0 });
    p.builtAt = this.steps;
    let answer: PublicationAnswer = { work: { id: work.id, name: POST_NAME, x: work.x }, cost, seconds: work.seconds };
    if (instant) {
      credit(faction.stock, cost, -1);
      work.delivered = { ...cost }; work.progress = 1;
      this.works.complete(work);
      const post = faction.posts.find(post => post.id === work.id);
      answer = post ? { post: { id: post.id, x: post.x }, cost, seconds: 0 } : { ...answer, blocked: this.works.blocked.get(work.id), seconds: 0 };
    }
    this.rememberPublication(p, ticket, answer);
    return answer;
  }
  // The works of a post all put up is a post of its faction (Works.complete), where the works stood and as it faced, by its
  // name: with an empty yard for its refinery, taken by nobody, and giving back, taken down, all it was put up with
  // (`salvage`).
  raised(faction: Faction, work: Work) {
    faction.posts.push({ id: work.id, x: work.x, facing: work.facing, yard: load(), refinedAt: null, salvage: { ...work.cost }, takedown: null, capture: null });
    this.topology++;
  }
  // A post of the faction is taken down where it stands, as a structure is (`takeDown`): by a builder of the faction beside
  // it — the nearest free one goes there by itself (supply-dispatch.ts) —, in the time the base would take to build what it
  // gives back (`buildSeconds`). Meanwhile it is a post no longer: it neither serves nor holds ground, nor counts for the
  // limit (`posts`). Refused, in words, for a post the faction has not, or one being taken down already.
  lower(p: Player, postId: unknown) {
    const post = this.faction(p).posts.find(post => post.id === postId);
    if (!post) throw userError('Esse posto não é da sua facção.');
    if (post.takedown) throw userError('Esse posto já está sendo desmontado.');
    post.takedown = { progress: 0, seconds: this.building ? buildSeconds(post.salvage) : 0 };
    this.topology++;
    return { dismantling: post.id, seconds: post.takedown.seconds, value: { ...post.salvage } };
  }
  // A post being taken down is a post again, as it was — while the faction has room for it (`POST_LIMIT`): one taken
  // meanwhile may have filled it.
  keepPost(p: Player, postId: unknown) {
    const faction = this.faction(p), post = faction.posts.find(post => post.id === postId);
    if (!post?.takedown) throw userError('Esse posto não está sendo desmontado.');
    if (this.postPlaces(faction).length >= POST_LIMIT) throw userError(POST_FULL_MESSAGE);
    post.takedown = null; this.topology++;
    return { kept: post.id };
  }
  // A post all taken down leaves the field (Works.finish): what it gives back (`salvage`) lies where it stood, in a heap
  // named as it was, for a builder to bring home, and what waited in its yard goes into the stocks of its faction at once,
  // refined, as when it is taken (`seize`).
  lowered(post: Post) {
    const faction = [...this.factions.values()].find(other => other.posts.includes(post))!;
    faction.posts = faction.posts.filter(other => other !== post);
    credit(faction.stock, refined(post.yard)); this.lookouts.delete(post.id); this.topology++;
    return this.works.heap(post.id, faction.id, post.x, post.salvage);
  }
  // A works of the faction given up (`Works.cancel`): the reply says the heap it left, and what is in it.
  abandonWork(p: Player, workId: unknown) {
    const work = typeof workId === 'string' ? this.works.pending.get(workId) : null;
    if (!work || work.factionId !== p.factionId) throw userError('Essa obra já não está no campo.');
    const heap = this.works.cancel(work);
    return { cancelled: work.id, heap: heap ? { id: heap.id, stock: whole(heap.stock) } : null };
  }
  // A road asked for by a player of the faction from the Infraestrutura panel, over a stretch of the field its faction may ask
  // one for (road-works.ts): asking costs nothing, and the road machines of the faction in automatic make it as the plan of
  // the faction gives it out (supply-dispatch.ts), looked at again at once. Refused, in words, before anything is done. The
  // reply names it, where it runs and what it is to be.
  road(p: Player, { x0, x1, kind }: Pick<RoomRequest, 'x0' | 'x1' | 'kind'>) {
    const road = this.roadworks.open(this.faction(p), { x0, x1, kind });
    this.supplyDispatch.nextAt = -Infinity;
    return { road: { id: road.id, x0: road.x0, x1: road.x1, kind: road.kind } };
  }
  // A road of the faction given up (`Roadworks.cancel`): what its machines made of it stays.
  abandonRoad(p: Player, roadId: unknown) {
    const road = typeof roadId === 'string' ? this.roadworks.pending.get(roadId) : null;
    if (!road || road.factionId !== p.factionId) throw userError('Essa estrada já não está no campo.');
    this.roadworks.cancel(road);
    return { cancelled: road.id };
  }
  // A structure of the faction is moved: taken down where it stands (`takeDown`), and a works of the same project opened at
  // the place asked for, which may be its own (`constructionSite`), facing as asked or as it faces; its heap goes to that
  // works first (supply-dispatch.ts). Refused, in words, before anything is done, as a publication is.
  relocate(p: Player, actor: Actor, { x, facing, ticket }: PlacementRequest) {
    if (isVehicleDesign(actor.construction)) throw userError('Só estruturas são movidas assim: dê a ordem Mover ao veículo.');
    if (this.held(actor)) throw new Error(this.held(actor));
    if (this.steps - p.builtAt < PUBLISH_STEPS) throw userError('Aguarde um instante antes de fabricar novamente.');
    const faction = this.faction(p), direction = facingValue(facing) ? facing : actor.facing,
      limit = constructionLimitMessage(this.constructionCounts(faction, actor.id), false);
    if (limit) throw userError(limit);
    const position = this.spot(faction, actor.construction, x, direction, actor.id);
    manufactureDesign(actor.construction, this.world, { x: position, facing: direction });
    const cost = structureBill(this, actor.construction, position, direction),
      work = this.works.open({ p, faction, blueprint: structuredClone(actor.construction), direction, position, cost, seconds: this.building ? buildSeconds(cost) : 0 }, actor.id);
    const taken = this.takeDown(p, actor, work.id);
    p.builtAt = this.steps;
    const answer = { work: { id: work.id, name: actor.construction.name, x: work.x }, dismantling: actor.id, seconds: taken.seconds };
    this.rememberPublication(p, ticket, answer);
    return answer;
  }
  // The place a structure is asked for, as a number: refused, in words, where it may not stand (`constructionSite`).
  spot(faction: Faction, source: AuthoredConstruction, x: unknown, facing: Facing, ignore: string | null = null) {
    if (!finiteNumber(x)) throw userError('Escolha o local da estrutura no campo.');
    constructionSite(this, faction, source, x, facing, ignore);
    return x;
  }
  rememberPublication(p: Player, ticket: unknown, answer: PublicationAnswer) {
    if (typeof ticket !== 'string' || ticket.length > 64) return;
    p.published.set(ticket, answer);
    if (p.published.size > ANSWERS_KEPT) p.published.delete(p.published.keys().next().value!);
  }
  // Only the live physics-worker grants permission. Trusted diary commands arrive here by the same path,
  // including after a binary photo; no permission is part of the deterministic room or its saved state.
  testCommand(p: Player, data: RoomRequest) {
    const intent = testIntent(data);
    if (intent.act === 'list' || intent.act === 'speed') throw userError('A consulta ou configuração de testes pertence ao servidor.');
    if (intent.act === 'resources') {
      const faction = this.faction(p);
      if (!faction.base) throw new Error(UNBASED);
      Object.assign(faction.stock, intent.stock);
      return { stock: { ...faction.stock } };
    }
    if (intent.act === 'spawn') {
      if (!intent.ticket) throw userError('Confirme novamente a criação de teste.');
      const ticket = `test:${intent.ticket}`, signature = JSON.stringify(intent), previous = p.published.get(ticket);
      if (previous) {
        if (previous.testIntent !== signature) throw userError('Esse pedido de teste já foi usado para outra criação.');
        return structuredClone(previous.answer);
      }
      const prepared = prepareTestSpawn(this.world, intent), faction = this.faction(p), vehicle = intent.kind === 'vehicle';
      if (vehicle) {
        const reason = constructionLimitMessage(this.constructionCounts(faction), true);
        if (reason) throw userError(reason);
      } else testTargetLimit(this.world, prepared.mobile);
      // Compilation, terrain support and scene limits have all been checked before minting an identity.
      const next = this.serials.c + 1, actor = this.world.addActor(prepared.source, {
        id: `c${next}`, ownerId: vehicle ? p.id : null, team: vehicle ? faction.id : TEST_TARGET_TEAM,
        x: intent.x, facing: intent.facing, color: vehicle ? p.color : '#c96f5b', playerName: vehicle ? p.name : 'Alvo de teste',
      });
      this.serials.c = next;
      if (vehicle) this.reserved.add(actor.id);
      this.record(actor).auto = false;
      stopTestActor(this.world, actor); this.show(actor); this.topology++; this.sampledOut = null; this.round = 0;
      p.squad!.sync();
      const answer = { actor: { id: actor.id, blueprint: structuredClone(actor.construction) } };
      this.rememberPublication(p, ticket, { testIntent: signature, answer: structuredClone(answer) });
      return answer;
    }
    let actor = activeTestActor(this.world, intent.actorId);
    const record = this.record(actor);
    if (record.wreck) throw userError('Construção fora de combate: crie outra.');
    if (record.service) throw userError('Aguarde ou cancele o serviço dessa construção antes de usar as ferramentas de testes.');
    const pose = intent.act === 'reposition' ? prepareTestMove(this.world, actor, intent) : null;
    // Administrative maintenance ends the actor's current job and input; it grants no manual control.
    this.supplyDispatch.off(actor.id, true);
    const squad = this.squadFor(actor), unit = squad?.units.get(actor.id);
    if (squad && unit) {
      if (squad.manual === actor.id) Object.assign(squad.obey(actor.id), { move: null, attack: null, haul: null });
      else squad.command({ order: 'stop', ids: [actor.id] });
    }
    Object.assign(record, { pulled: null, drive: null, loading: null, extraction: null, building: null, road: null });
    if (intent.act === 'repair') actor = repairTestActor(this.world, actor);
    else if (intent.act === 'resupply') actor = resupplyTestActor(this.world, actor);
    else actor = moveTestActor(this.world, actor, intent, pose!);
    Object.assign(record, { wear: null, shots: null });
    this.show(actor); this.renewed(actor); this.topology++; this.sampledOut = null; this.round = 0;
    return { changed: actor.id };
  }
  // A new vehicle takes the place asked for, or the first free base-row point. A replacement keeps its current point
  // when its new outline fits; otherwise it takes the nearest free point within the same base.
  placement(player: Player, source: AuthoredConstruction, requested: unknown, facing: Facing, ignoreId?: string) {
    const faction = this.faction(player);
    return baseVehiclePosition({ world: this.world, source, requested, facing, ...(ignoreId === undefined ? {} : { ignoreId }),
      limits: this.limits, factionId: faction.id, base: faction.base!.x });
  }
  // A vehicle is bought from the faction's stocks, each piece from the stock of what it is made of and its fuel from the
  // fuel, and comes into the field at the base: where it is asked to (`x`), or at the first free place of the row, facing
  // as it is asked to or as the base does. Replacing one keeps its point when the new design fits there, or uses the
  // nearest free point inside the same base. No neighbour is moved to make room.
  // It pays the new design less what the old one gives back, stock by stock, and what the old one carried goes back to the base (`empty`).
  // It is built there for a time that grows with what was paid for its materials (`buildSeconds`), held as by a repair:
  // it neither moves nor fires until it is ready. One made another is new to a repair cancelled where it stands: it is
  // mended by itself there (`serve`); and it is in automatic as a new one of its design is, on no job yet. A structure is
  // not bought: published, it is a works at the place asked for (`site`).
  // A publication asked under a ticket (`ticket`, a short word of the page's) is answered again under it, as it was, while
  // it is among the last few the player made (`command`): a page that never had the answer asks again, and nothing is
  // built, paid or opened twice.
  publish(playerId: string, input: unknown, { actorId = null, x = null, facing = null, ticket = null, instant = false }: PublishOptions = {}) {
    const drafted = this.draft(playerId, input, { actorId, x, facing, instant });
    if (drafted.work) return this.begin(drafted, ticket, instant);
    const { p, faction, old, blueprint, direction, position, cost } = drafted, from = old ? this.position(old) : null;
    const id = old?.id || this.mint('c'), options = { id, ownerId: playerId, team: faction.id, x: position,
      facing: direction, color: p.color, playerName: p.name };
    if (old) { this.claim(p, [old]); this.empty(faction, old); this.supplyDispatch.drop(old.id); }
    const a = old ? this.world.replaceActor(blueprint, options) : this.world.addActor(blueprint, options);
    this.reserved.add(a.id);
    credit(faction.stock, cost, -1); this.topology++;
    const seconds = this.building && !instant ? buildSeconds(cost) : 0, vehicle = !old && a.vehicle?.config.enabled;
    Object.assign(this.record(a), { wear: null, shots: null, loading: null, extraction: null, building: null, road: null, declined: null, gatheredOre: false, auto: worker(a), homing: true,
      service: seconds ? buildService(this.world.time + seconds, Boolean(vehicle)) : null }); this.show(a);
    if (vehicle && !seconds) this.completeObjective(p, 'fabricateVehicle');
    // A new construction comes in picked, held by the player (`claim`), with no orders of the one it replaced, and under the
    // player's command: nobody is put at its controls, nor left at those of another.
    this.release(playerId); p.squad!.units.delete(id); p.selected = id; this.take(p, null);
    p.builtAt = this.steps;
    const answer = { actor: this.design(a), selected: id, cost, seconds,
      ...(old && position !== from ? { relocated: { from: from!, to: position } } : {}) };
    this.rememberPublication(p, ticket, answer);
    return answer;
  }
  // What publishing asks before it puts anything on the field, in the order it asks it, and what that comes to: the
  // player and its faction, which needs a base to make anything, the construction replaced, the design as the field
  // keeps it (`validateDesign`), where the construction is to stand, how it is to face and what it costs. A structure is
  // opened as a works (`work`), at a place of the field it may have (`constructionSite`), for nothing then, costing what it
  // costs there with its footing (`structureBill`), and in the time it takes to put up; it replaces nothing. Refused, in
  // words, by the first thing that fails.
  // Asking puts nothing on the field and takes nothing from it.
  draft(playerId: string, input: unknown, { actorId = null, x = null, facing = null, instant = false }: PublishOptions = {}): ManufacturingDraft {
    const p = this.requirePlayer(playerId), faction = this.faction(p), old = actorId ? this.requireActor(playerId, actorId) : null;
    if (!faction.base) throw new Error(UNBASED);
    if (this.steps - p.builtAt < PUBLISH_STEPS) throw userError('Aguarde um instante antes de fabricar novamente.');
    if (old && !isVehicleDesign(old.construction)) throw userError('Estruturas não são substituídas: desmonte esta e abra outra obra.');
    if (old) { this.vacant(p, old); this.workshop(p, old, phrase('substituir')); }
    const { blueprint, vehicle, direction } = manufacturingPlan({ blueprint: this.validateDesign(input), previous: old,
      baseFacing: faction.base!.facing, facing, counts: this.constructionCounts(faction), industry: faction.industry.levels });
    if (!vehicle) {
      const position = this.spot(faction, blueprint, x, direction);
      manufactureDesign(blueprint, this.world, { x: position, facing: direction });
      const cost = structureBill(this, blueprint, position, direction);
      if (instant) this.afford(faction, cost, phrase('fabricar'));
      return { p, faction, blueprint, direction, position, cost, seconds: this.building ? buildSeconds(cost) : 0, work: true };
    }
    const position = this.placement(p, blueprint, old ? this.position(old) : x, direction, old?.id);
    const price = designBill(manufactureDesign(blueprint).compiled),
      cost = old ? billSum(price, appraise(old, fieldParts(this.world)).salvage, -1) : price;
    this.afford(faction, cost, phrase(old ? 'substituir' : 'fabricar'));
    return { p, faction, old, blueprint, direction, position, cost };
  }
  // The design a command to publish (`spawn`, `replace`) would put on the field, asked before the command is run, as the
  // command asks it: as the field keeps it, or the refusal, in words; nothing for one it answered already under its ticket.
  // The host writes down the design of what the field publishes, and of nothing else (field-host.ts).
  drafted(playerId: string, data: RoomRequest) {
    const p = this.requirePlayer(playerId);
    if (lookup(p.published, data.ticket) !== undefined) return undefined;
    const actorId = data.type === 'replace' ? this.requireActor(playerId, data.actorId || p.selected).id : null;
    return this.draft(playerId, data.blueprint, { actorId, x: data.x, facing: data.facing, instant: publicationInstant(data) }).blueprint;
  }
  // `draw` is the flag of a faction a command founds (`founding`), drawn here when it is not given.
  command(playerId: string, input: unknown, draw: string | null = null) {
    const data = roomRequest(input);
    const instant = publicationInstant(data);
    const p = this.requirePlayer(playerId); p.lastInput = this.steps;
    if (data.type === 'ping') return {};
    if (data.type === 'test') {
      if (this.ended && data.act !== 'list') throw userError('O duelo terminou. O resultado é definitivo.');
      return this.testCommand(p, data);
    }
    if (data.type === 'objectives') return this.selectObjective(p, data);
    if (data.type === 'release') { this.release(playerId); return {}; }
    // A publication asked again under the ticket it went with is answered as it was (`publish`), whatever came since.
    if (PUBLICATION_COMMANDS.includes(data.type) && lookup(p.published, data.ticket) !== undefined) return lookup(p.published, data.ticket);
    if (this.ended && !['blueprint', 'select', 'chat', 'rekey'].includes(data.type)) throw userError('O duelo terminou. O resultado é definitivo.');
    if (this.duel && ['invite', 'join-faction', 'member', 'leave-faction', 'apply', 'answer', 'trade', 'accord'].includes(data.type))
      throw userError('As duas facções do duelo permanecem separadas até o fim.');
    if (data.type === 'spawn') return this.publish(playerId, data.blueprint, { x: data.x, facing: data.facing, ticket: data.ticket, instant });
    if (data.type === 'post') return this.raise(p, { x: data.x, facing: data.facing, ticket: data.ticket, instant });
    if (data.type === 'remove-post') return this.lower(p, data.postId);
    if (data.type === 'keep-post') return this.keepPost(p, data.postId);
    if (data.type === 'cancel-work') return this.abandonWork(p, data.workId);
    if (data.type === 'road') return this.road(p, data);
    if (data.type === 'cancel-road') return this.abandonRoad(p, data.roadId);
    if (data.type === 'squad') return this.order(p, data);
    if (data.type === 'tow') return this.tow(p, data);
    if (data.type === 'invite') return this.invite(p, data.playerId, data.cancel === true);
    if (data.type === 'join-faction') return this.enlist(p, data.factionId);
    if (data.type === 'decline') { lookup(this.factions, data.factionId)?.invited.delete(p.id); return {}; }
    if (data.type === 'member') return this.member(p, data.playerId, data.act, draw ?? flagDraw());
    if (data.type === 'leave-faction') return this.quit(p, draw ?? flagDraw());
    if (data.type === 'recover') return this.recover(p);
    if (data.type === 'rekey') return this.rekey(p);
    if (data.type === 'rename') return this.rename(p, data.name);
    if (data.type === 'identity') return this.identity(p, data);
    if (data.type === 'apply') return this.apply(p, data.ref, data.cancel === true);
    if (data.type === 'answer') return this.answer(p, data.playerId, data.accept === true);
    if (data.type === 'library') return this.shelf(p, data);
    if (data.type === 'upgrade' || data.type === 'cancel-upgrade') {
      const faction = this.faction(p);
      if (this.role(faction, p.id) === 'member') throw userError('Só o líder e os administradores melhoram as instalações da base.');
      if (!faction.base) throw new Error(UNBASED);
      advanceIndustry(faction.industry, this.field.time);
      return data.type === 'upgrade' ? startUpgrade(faction.industry, faction.stock, data.id, p.id, this.field.time) :
        cancelUpgrade(faction.industry, faction.stock, data.id);
    }
    if (data.type === 'trade') return this.trade(p, data);
    if (data.type === 'accord') return this.accord(p, data);
    if (data.type === 'chat') return this.say(p, data);
    if (data.type === 'salvage') return this.salvage(p, data.wreckId);
    // An input still on its way to a construction lost meanwhile, a wreck by now or gone, is dropped without complaint.
    // So is one for a construction the faction does not have in sight: nothing is said of what it is now.
    const targetId = data.actorId || p.selected, target = typeof targetId === 'string' ? this.world.actor(targetId) : undefined;
    if (!data.request && ['drive', 'aim', 'trigger', 'fire'].includes(data.type)) {
      if (!target || this.records.get(target.id)?.wreck) return {};
      if (target.ownerId !== p.id) { this.look(); if (!included(['own', 'seen'], this.knows(p.factionId!, target))) return {}; }
    }
    // What is done to a construction of the faction is done by whoever may have it (`vacant`), who holds it from then on
    // (`claim`): reading its design holds nothing.
    const actor = this.requireActor(playerId, data.actorId || p.selected);
    const manual = <T>(answer: T): T => { this.supplyDispatch.command(p, data); return answer; };
    if (data.type === 'blueprint') return { actor: this.design(actor) };
    this.vacant(p, actor);
    const link = this.towOf(actor.id);
    if (link && data.type === 'auto' && data.on)
      throw userError('Solte o cabo antes de iniciar um trabalho automático.');
    if (data.type === 'auto') {
      if (typeof data.on !== 'boolean') throw userError('Estado do automático inválido.');
      if (!worker(actor) || data.on && (!actor.vehicle?.config.enabled || this.outOfAction()[actor.id] || !this.supplyDispatch.equipped(actor.id)))
        throw userError('Selecione um cargueiro, veículo de suprimentos, construtor ou máquina de estrada em condições de operar.');
      this.claim(p, [actor]); this.supplyDispatch.set(actor.id, data.on); return { auto: this.record(actor).auto };
    }
    // Whether an aircraft keeps its fuel to come home (Squad.homing): on, its pilot sends it home for its fuel and it takes
    // no order that would leave it short of that; off, it never goes home for it by itself and takes every order. A way home
    // for its fuel it is already on when switched off goes on till another order.
    if (data.type === 'homing') {
      if (typeof data.on !== 'boolean') throw userError('Estado da volta automática inválido.');
      if (!aircraft(actor)) throw userError('Selecione uma aeronave.');
      this.claim(p, [actor]); this.record(actor).homing = data.on; return { homing: data.on };
    }
    if (data.type === 'select') { this.release(playerId); this.claim(p, [actor]); p.selected = actor.id; this.take(p, actor.id); return manual({ selected: actor.id }); }
    if (data.type === 'remove') return this.dismantle(p, actor);
    if (data.type === 'cancel-dismantle') return this.keepUp(p, actor);
    if (data.type === 'relocate') return this.relocate(p, actor, { x: data.x, facing: data.facing, ticket: data.ticket });
    if (data.type === 'abandon') return this.abandon(p, actor);
    if (data.type === 'repair') return manual(this.repair(p, actor));
    if (data.type === 'cancel-repair') return this.cancel(p, actor);
    if (data.type === 'dump-cargo') return this.dump(p, actor);
    if (data.type === 'replace') return this.publish(playerId, data.blueprint, { actorId: actor.id, facing: data.facing, ticket: data.ticket, instant });
    if (actor.id !== p.selected) throw userError('Selecione essa construção antes de controlar.');
    // Only the vehicle in the player's hands is driven and fired. An input still
    // on its way when the hands moved elsewhere is dropped without complaint.
    if (actor.id !== p.squad!.manual || this.towOf(actor.id)?.targetId === actor.id) {
      if (data.request) throw userError('Assuma o controle dessa construção antes de conduzi-la.');
      return {};
    }
    // An aircraft turning about in the air flies on in the player's hands meanwhile (`turn`): only its guns wait.
    const record = this.record(actor), leavingRepair = record.service?.kind === 'repair' && this.atDepot(this.faction(p), actor) &&
      data.type === 'drive' && Number.isFinite(data.throttle) && data.throttle !== 0, flownOn = record.service?.kind === 'turn' && record.service.aloft && data.type === 'drive';
    if (this.held(actor) && !leavingRepair && !flownOn) {
      if (data.request) throw new Error(this.held(actor));
      return {};
    }
    // The field steps within a tick of any input and reads the scene then: none of them asks
    // for it. What a later input of the same tick needs to know of an earlier one, the field keeps.
    // The throttle goes toward what the player asks for at every step from where it is (`ease`); the brake, and the climb
    // of a vehicle that flies, are as asked.
    if (data.type === 'drive') {
      if (typeof data.throttle !== 'number' || !Number.isFinite(data.throttle)) throw userError('Acelerador inválido; ação de pilotagem inválida.');
      const throttle = record.drive?.throttle ?? 0, brake = data.brake, rise = data.rise ?? 0;
      if (brake !== undefined && !finiteNumber(brake)) throw userError('Freio inválido.');
      if (!finiteNumber(rise)) throw userError('Subida inválida.');
      applyWorldInput(this.world, actor.id, { type: 'drive', phase: 'before', throttle, brake, rise }, { quiet: true });
      // The core validates the whole input before a pedal can cancel a base repair and refund its bill. Neutral
      // updates leave the job alone; accelerating frees it without a second repair starting at the same place.
      if (leavingRepair) this.cancel(p, actor);
      record.drive = { tick: this.world.tick, wanted: Math.max(-1, Math.min(1, data.throttle)), throttle, brake, rise }; return manual({});
    }
    if (!['fire', 'trigger', 'aim'].includes(data.type)) throw userError('Ação inválida.');
    if (data.type === 'trigger' && data.active === false) {
      applyWorldInput(this.world, actor.id, { type: 'trigger', phase: 'before', active: false, cancel: data.cancel }, { quiet: true });
      record.pulled = null; return {};
    }
    const aim = data.aim;
    if (!this.inField(aim)) throw userError('Mira fora do campo.');
    const weapon = data.weapon;
    if (!objectRecord(weapon) || typeof weapon.id !== 'string' || !Object.hasOwn(WEAPONS, weapon.id)) throw userError('Arma inválida.');
    // The pull of a trigger fires at once; held, it is the gun that fires again. A second pull within the tick is the same pull.
    const held = Boolean(actor.trigger) || record.pulled === this.world.tick;
    const { accepted } = applyWorldInput<NativeInputResult>(this.world, actor.id, { ...weapon, type: data.type, phase: 'before',
      aim, active: data.active, shot: data.type === 'trigger' && !held, queue: data.queue, cancel: data.cancel }, { platform: 'vehicle', quiet: true });
    if (data.type === 'trigger') record.pulled = this.world.tick;
    if (data.type === 'fire') return { accepted };
    return {};
  }
  // Orders to the vehicles the player is not driving. Taking one over, or letting it go, is an order too. One that
  // changed what any vehicle of the player's was told is obeyed at the next step, not at the next look around
  // (`hasten`); one that was refused, or changed nothing, asks nothing of the field.
  // The aircraft an order did not go to for their fuel (`held`, `give`) go on with their jobs as they were.
  order(p: Player, data: OrderRequest) {
    const told = this.orders(p);
    try {
      const answer = this.give(p, data), held = answer.held ?? [];
      this.supplyDispatch.command(p, held.length && Array.isArray(data.ids) ? { ...data, ids: data.ids.filter(id => !held.includes(id)) } : data); return answer;
    }
    finally { if (this.orders(p) !== told) this.hasten(p); }
  }
  // What the player's squad was told, vehicle by vehicle, as the field keeps it (`keep`), and which one is in the player's hands.
  orders(p: Player) {
    return JSON.stringify([p.squad!.manual, [...p.squad!.units].map(([id, unit]) => [id, unitOrders(unit)])]);
  }
  // A round of decisions is dealt whole at the next step, for a player no more often than once a round of the pilots
  // (`DECISION_STEPS`): what that player orders sooner after is obeyed when that round is up. A round that comes by
  // then anyway obeys it, and asks nothing more.
  hasten(p: Player) {
    const due = Math.max(this.steps, (p.hastened ?? -Infinity) + DECISION_STEPS), now = due === this.steps;
    if (now ? this.round === 0 : this.round <= due) return;
    this.round = now ? 0 : due; p.hastened = due;
  }
  // An order goes to the constructions of the faction it names that the player may have (`usable`), who holds them from then
  // on (`claim`); one that names only constructions another member holds is refused in the words of the first of them.
  // Letting go (`free`) is an order to what the player holds: each goes on as it was, free for any member, and the
  // vehicle in the player's hands is let go of first.
  give(p: Player, data: OrderRequest) {
    const faction = this.faction(p), fleet = (id: unknown) => {
      const actor = typeof id === 'string' ? this.world.actor(id) : null;
      return actor && faction.members.has(actor.ownerId ?? '') ? actor : null;
    };
    if (data.order === 'control') {
      const actor = data.id == null ? null : fleet(data.id);
      if (data.id != null && !actor) throw userError('Esta construção é de outra facção.');
      if (actor) {
        this.vacant(p, actor);
        if (this.towOf(actor.id)?.targetId === actor.id) throw userError('Solte o cabo antes de controlar o veículo rebocado.');
        if (this.outOfAction()[actor.id]) throw userError('Este veículo não pode ser controlado.');
        this.claim(p, [actor]);
      }
      const previous = p.squad!.manual ? this.world.actor(p.squad!.manual) : undefined, returned = data.id == null && previous?.vehicle?.config.enabled && !this.outOfAction()[previous.id] && !this.held(previous);
      p.squad!.command({ order: 'control', id: actor?.id ?? null });
      if (returned) this.completeObjective(p, 'directControl');
      if (p.squad!.manual) p.selected = p.squad!.manual;
      return { selected: p.selected };
    }
    if (data.order === 'bombard' && !this.inField(data.point)) throw userError('Esse ponto fica fora do campo.');
    if (data.order === 'move' && data.y != null && !this.inField({ x: data.x, y: data.y })) throw userError('Esse ponto fica fora do campo.');
    // An order names constructions by their names, no more of them than a faction has: anything else is refused as it
    // comes, before a single one is looked for.
    if (data.ids != null && (!unknownArray(data.ids) ||
      (data.ids.length > MAX_FACTION_CONSTRUCTIONS && data.ids.length > this.enlisted(faction).length) || data.ids.some(id => typeof id !== 'string')))
      throw userError('Ordem inválida.');
    const named = (unknownArray(data.ids) ? data.ids : []).map(fleet).filter(defined), actors = named.filter(actor => this.usable(p, actor)), ids = actors.map(actor => actor.id);
    if (named.length && !actors.length) this.vacant(p, named[0]!);
    if (data.order === 'free') {
      const held = ids.filter(id => this.reserved.has(id));
      if (p.squad!.manual !== null && held.includes(p.squad!.manual)) { this.release(p.id); this.take(p, null); }
      this.unclaim(p, held);
      return {};
    }
    // Turning about is asked of each construction, the one in the player's hands as any other: those that are held
    // go on as they were, and with none that turns the order is refused in the words of the first. The answer says how
    // long the slowest of them takes, and whether all of them turn in the air (`aloft`).
    if (data.order === 'turn') {
      if (actors.some(actor => this.towOf(actor.id))) throw userError('Solte o cabo antes de virar o veículo.');
      const vehicles = actors.filter(actor => isVehicleDesign(actor.construction)), free = vehicles.filter(actor => !this.held(actor));
      if (!free.length) throw vehicles.length ? new Error(this.held(vehicles[0]!)) : userError(actors.length ? UNTURNED : 'Selecione a construção que vai virar.');
      this.claim(p, free);
      const aloft = free.every(actor => actor.vehicle?.flying);
      for (const actor of free) this.turn(p, actor);
      return { turning: free.map(actor => actor.id), seconds: aloft ? AIR_TURN_SECONDS : TURN_SECONDS, ...(aloft ? { aloft } : {}) };
    }
    if (data.order !== 'stop' && actors.some(actor => this.towOf(actor.id)?.targetId === actor.id))
      throw userError('Solte o cabo antes de dar ordens ao veículo rebocado.');
    if (data.order !== 'move' && data.order !== 'stop' && actors.some(actor => this.towOf(actor.id)))
      throw userError('Com o cabo conectado, conduza o rebocador ou use Mover.');
    // A collection order needs either a tool for the reserve or a container for its pile.
    // What lies at a site is the faction's to know only of a vein it knows there: of any other the squad refuses the site.
    if (data.order === 'haul') {
      const publicSite = activitySite(this), drop = publicSite?.id === data.depositId && activityKnown(this, this.faction(p)) ? publicSite : null,
        site = lookup(this.sites, data.depositId), material = drop?.material ?? (site && this.known(this.faction(p), site) ? site.material : null);
      if (drop && (!actors.length || actors.some(actor => !actor.vehicle?.config.enabled || !actor.blueprint.modules.some(m => pickupContainer(m, drop)))))
        throw userError('Selecione veículos com recipiente compatível para transportar o airdrop.');
      if (!drop && material && actors.length && !actors.some(actor => actor.blueprint.modules.some(m => hauls(m, material) || extracts(m, material))))
        throw userError(material === 'petroleo' ? 'Instale uma Perfuratriz para extrair petróleo ou uma Cisterna para transportá-lo.' :
          'Instale uma Escavadeira para extrair minério ou uma Caçamba para transportá-lo.');
    }
    // An attack is ordered on what the faction's sensors hold now, in sight or on a radar, whatever became of it since:
    // the mark of one that left the field unseen is a target all the same. A ghost is no target, nor is what the
    // faction was told nothing of: there is the ground to shell.
    if (data.order === 'attack') {
      const id = typeof data.targetId === 'string' ? data.targetId : null;
      if (id) this.look();
      const target = id && (this.field.actors.find(a => a.id === id) ?? { id });
      if (!target || !included(['seen', 'radar'], this.knows(p.factionId!, target))) throw userError('Alvo inválido.');
    }
    // An aircraft that keeps its fuel to come home takes no order that would leave it short of that (Squad.fuelRefusal): the
    // others take it, and the player is told how many did not and why (`refused`, `held`), in the words of his page's language
    // (user-message.ts `messageText`); with none to take it, it is refused in those words.
    // Check its current squad before claiming it: a free teammate aircraft is not yet in the requester's squad.
    const order = decodeSquadCommand({ order: data.order, ids, x: data.x, y: data.y, targetId: data.targetId, point: data.point, stance: data.stance, depositId: data.depositId });
    if (order.order === 'control') throw userError('Ordem desconhecida.');
    p.squad!.check(order);
    const held = actors.map((actor): [string, import('../src/squad-contract.ts').FuelRefusal | ''] => [actor.id, this.squadFor(actor)!.fuelRefusal(actor.id, order)]).filter((entry): entry is [string, import('../src/squad-contract.ts').FuelRefusal] => entry[1] !== ''), kept = new Set(held.map(([id]) => id)),
      refused = held.length ? fuelRefused(held.map(([, why]) => why), ids.length) : null;
    if (held.length && held.length === ids.length) throw userError(refused!);
    this.claim(p, actors.filter(actor => !kept.has(actor.id))); p.squad!.command({ ...order, ids: ids.filter(id => !kept.has(id)) });
    return held.length ? { refused, held: [...kept] } : {};
  }
}

export type { FactionView, RoomSquadView, UnitView } from '../src/field-contract.ts';
