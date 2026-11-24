import { weaponCatalogue } from './construction-admission.ts';
import { gridRegions } from './armor-grid.ts';
import { WEAPON_MOUNTS } from './weapon-mounts.ts';
import { NO_SHOTS } from './shots.ts';
import { applyNativeVehicle, readNativeVehicle, VEHICLE_NUMBERS } from './native-vehicle.ts';
import { PlateMesh } from './mesh.ts';
import { isWeaponMountProjection } from './construction-codec.ts';
import { isWeaponSettings } from './weapons.ts';
import { decodeNativeClock, decodeNativeFrame, decodeNativeEnvelope, decodeNativeParts, decodeNativeProjectiles, decodeNativeRay, decodeNativeRays,
  parseNativeJSON, nativeRecord, nativeArray, nativePoint, nativePose, nativePolygons, nativeVehicle, finiteNumber, nativeBoolean, nativeString,
  nativeGrid, nativeMarks, nativeDents, nativePerforations, nativeBarrelMarks, nativeHoles, nativeCargo, nativeScars, nativeContact, nativeSuspension } from './native-frame-contract.ts';
import type { Guard, NativeFrame, NativeParts, NativeRay, NativeProjectileRecord, KeptTow } from './native-frame-contract.ts';
import type { NativeWorldHandle } from './native-world-contract.ts';
import type { NumberReader } from './native-vehicle.ts';
import type { World } from './physics.ts';
import type { LiveModule, SceneActor, SceneProjectile, ActorStats, SceneTrigger, PendingShot, AdditionalTrigger, SceneEye } from './scene-contract.ts';
import type { Point, Pose } from './math.ts';
import type { ShotKind, ShotBlock } from './shots.ts';
import type { ArmourMaterial } from './materials.ts';
export { VEHICLE_STATE } from './native-vehicle.ts';

const NO_DRAGS = new Float64Array(0);
// What a live frame's block says a module has (game_frame.rs `ModuleNumbers`), and how long a plate's and a module's records are.
const MOUNT = 1, FUEL = 2, AMMO = 4, THRUSTER = 8, SERVO = 16, GEAR = 32, CONTACT = 64, SUSPENSION = 128;
const PLATE_NUMBERS = 4, MODULE_NUMBERS = 2 + 37;
// A live frame's block of numbers (game_frame.rs `Told`), read in the order the core wrote it.
class Numbers implements NumberReader {
  declare block: Float64Array; declare at: number;
  constructor(block: Float64Array) {
    for (const value of block) if (!Number.isFinite(value)) throw new TypeError('Invalid Native frame numbers.');
    this.block = block; this.at = 0;
  }
  next(): number {
    const value = this.block[this.at++];
    if (value === undefined) throw new TypeError('Native frame numbers cut short.');
    return value;
  }
  flag(): boolean { return this.next() !== 0; }
  point(): Point { return { x: this.next(), y: this.next() }; }
  optional(): number | null { const there = this.flag(), value = this.next(); return there ? value : null; }
}
const vehicleWords = (value: unknown): value is { groundSurface: string | null; stuck: string | null } => nativeRecord(value) &&
  (value.groundSurface === null || nativeString(value.groundSurface)) && (value.stuck === null || nativeString(value.stuck));

const iterableView = (value: unknown): value is ArrayBufferView & Iterable<unknown> => ArrayBuffer.isView(value) && Symbol.iterator in value;
const encode = (value: unknown): string => {
  const text = JSON.stringify(value, (_key: string, item: unknown) => ArrayBuffer.isView(item) ? iterableView(item) ? Array.from(item) : [] : item);
  if (text === undefined) throw new TypeError('Native requests must be serializable.');
  return text;
};
const pose = (object: Point & { angle?: number }): Pose => ({ x: object.x, y: object.y, angle: object.angle || 0 });
export type NativeObject = PlateMesh | LiveModule;
export interface NativeCommand { op: string; actorId?: string | null | undefined; defeated?: boolean }
export type MaterialOwner = { type: 'plate'; id: string; object: PlateMesh; material: ArmourMaterial } |
  { type: 'module'; id: string; object: LiveModule; material: ArmourMaterial };
export type NativeHit = Omit<NativeRay, 'owner'> & Point & { exitX: number; exitY: number; nx: number; ny: number; owner: MaterialOwner };
export interface NativeQueryOptions { ignoreIds?: Iterable<string | NativeObject>; completeExit?: boolean; projectile?: boolean }
export interface NativeWorkResult { share: number; limit?: 'engine' | 'fuel' | 'power' | null }
export interface NativeInputResult { accepted: boolean; record?: Record<string, unknown> }

// Material queries share the exact native damage geometry used by projectiles.
export class NativeQueries {
  declare world: World;
  constructor(world: World) { this.world = world; }
  query(op: 'raycast', start: Point, end: Point, options?: NativeQueryOptions): NativeHit | null;
  query(op: 'raycastLayers', start: Point, end: Point, options?: NativeQueryOptions): NativeHit[];
  query(op: 'raycast' | 'raycastLayers', start: Point, end: Point, options: NativeQueryOptions = {}): NativeHit | NativeHit[] | null {
    const game = this.world.game(), ignored = options.ignoreIds || [];
    const request = { op, start, end,
      ignoreOwners: [...ignored].map(id => game.handle(id)).filter(id => id != null),
      completeExit: options.completeExit !== false, projectile: options.projectile === true };
    const result = op === 'raycast' ? decodeNativeRay(game.call(request)) : decodeNativeRays(game.call(request));
    const project = (hit: NativeRay | null): NativeHit | null => {
      if (!hit) return null;
      const object = game.objects.get(hit.owner);
      if (!object) throw new TypeError('Native material ray refers to an unknown piece.');
      const owner: MaterialOwner = hit.kind === 'module' && !(object instanceof PlateMesh)
        ? { type: 'module', id: object.id, object, material: this.world.materials[object.weaponMount?.material || 'steel'] }
        : hit.kind === 'plate' && object instanceof PlateMesh
          ? { type: 'plate', id: object.id, object, material: this.world.materials[object.definition.material] }
          : (() => { throw new TypeError('Native material ray refers to a different kind of piece.'); })();
      return { ...hit, x: hit.point.x, y: hit.point.y, exitX: hit.exitPoint.x, exitY: hit.exitPoint.y,
        nx: hit.normal.x, ny: hit.normal.y,
        owner };
    };
    return Array.isArray(result) ? result.map(hit => project(hit)!) : project(result);
  }
  raycast(start: Point, end: Point, options?: NativeQueryOptions): NativeHit | null { return this.query('raycast', start, end, options); }
  raycastLayers(start: Point, end: Point, options?: NativeQueryOptions): NativeHit[] { return this.query('raycastLayers', start, end, options); }
}

// The construction/editor host compiles a scene once. No mechanical state is
// sent back to Rust during a simulation tick; Rust owns it until the next edit.
// The state this projection keeps, and that a field kept to be resumed is made of (World.keep).
export const PLATE_STATE = ['massScale', 'physicalMass', 'physicalInertia', 'physicalCenterLocal', 'revision', 'markRevision', 'groundMarks'] as const satisfies readonly (keyof PlateMesh)[];
export const MODULE_STATE = ['health', 'maxHealth', 'physicalMass', 'dryMass', 'physicalInertia', 'physicalCenterLocal',
  'weaponMount', 'materialPolygons', 'aimOffset', 'targetAimOffset', 'servoMaxSpeed',
  'fuelLitres', 'rounds', 'capacityLitres', 'capacityRounds', 'cargo', 'capacityM3', 'detonated',
  'burning', 'burnAge', 'fireAge', 'barrelDamage', 'barrelDisabled', 'barrelMarks', 'beltCut', 'markRevision', 'groundMarks', 'groundDamage', 'marks', 'ballisticScars',
  'mantletHoles', 'elevationDamage', 'elevationDisabled',
  'servoVelocity', 'targetBarrelAngle', 'reload', 'barrelTemperature', 'barrelCooling', 'loaded', 'feedReload', 'groundContact', 'wheelSpin', 'wheelAngularSpeed', 'thrust'] as const satisfies readonly (keyof LiveModule)[];

type ModuleField = (typeof MODULE_STATE)[number];
const moduleFields: { [K in ModuleField]: Guard<LiveModule[K]> } = {
  health: finiteNumber, maxHealth: finiteNumber, physicalMass: finiteNumber, dryMass: finiteNumber, physicalInertia: finiteNumber, physicalCenterLocal: nativePoint,
  weaponMount: isWeaponMountProjection, materialPolygons: nativePolygons, aimOffset: finiteNumber, targetAimOffset: finiteNumber, servoMaxSpeed: finiteNumber,
  fuelLitres: finiteNumber, rounds: finiteNumber, capacityLitres: finiteNumber, capacityRounds: finiteNumber, cargo: nativeCargo, capacityM3: finiteNumber,
  detonated: nativeBoolean, burning: nativeBoolean, burnAge: finiteNumber, fireAge: finiteNumber, barrelDamage: finiteNumber, barrelDisabled: nativeBoolean,
  barrelMarks: nativeBarrelMarks, beltCut: nativeBoolean, markRevision: finiteNumber, groundMarks: finiteNumber, groundDamage: finiteNumber,
  marks: nativeMarks, ballisticScars: nativeScars, mantletHoles: nativeHoles, elevationDamage: finiteNumber, elevationDisabled: nativeBoolean,
  servoVelocity: finiteNumber, targetBarrelAngle: finiteNumber, reload: finiteNumber, barrelTemperature: finiteNumber, barrelCooling: nativeBoolean,
  loaded: finiteNumber, feedReload: finiteNumber, groundContact: nativeContact, wheelSpin: finiteNumber,
  wheelAngularSpeed: finiteNumber, thrust: finiteNumber,
};
export function copyModuleField<K extends ModuleField>(target: LiveModule, source: Record<string, unknown>, key: K): void {
  const value = source[key], guard = moduleFields[key];
  if (value === undefined) return;
  if (!guard(value)) throw new TypeError(`Invalid Native module field: ${key}.`);
  target[key] = value;
}
type PlateField = (typeof PLATE_STATE)[number];
const plateFields: { [K in PlateField]: Guard<PlateMesh[K]> } = {
  massScale: finiteNumber, physicalMass: finiteNumber, physicalInertia: finiteNumber, physicalCenterLocal: nativePoint,
  revision: finiteNumber, markRevision: finiteNumber, groundMarks: finiteNumber,
};
export function copyPlateField<K extends PlateField>(target: PlateMesh, source: Record<string, unknown>, key: K): void {
  const value = source[key], guard = plateFields[key];
  if (value === undefined) return;
  if (!guard(value)) throw new TypeError(`Invalid Native plate field: ${key}.`);
  target[key] = value;
}
const actorStats = (value: unknown): value is ActorStats => nativeRecord(value) && finiteNumber(value.shots);
const trigger = (value: unknown): value is SceneTrigger | null => value === null || nativeRecord(value) && nativePoint(value.aim) && isWeaponSettings(value.config);
const pending = (value: unknown): value is PendingShot | null => value === null || nativeRecord(value) && nativePoint(value.aim) && isWeaponSettings(value.settings) && finiteNumber(value.expires);
const additional = (value: unknown): value is AdditionalTrigger => nativeRecord(value) && nativePoint(value.aim) && isWeaponSettings(value.config) && nativeBoolean(value.held) && (value.expires === null || finiteNumber(value.expires));
const eye = (value: unknown): value is SceneEye => nativeRecord(value) && nativePoint(value) && finiteNumber(value.left) && finiteNumber(value.right);

// Of each projection, how many frames it read, the one that told it all there is (`whole`), and of each construction,
// vehicle, plate and piece the frame by which it last changed (`stamps`): what a reader that read the scene as of a frame
// passes over as it was (`RustGame.changedAfter`, publication.ts). Kept beside a projection and not in it: one taken back
// with its field (field-snapshot.ts) counts anew, and its readers read it whole first.
interface Count { frames: number; whole: number; stamps: WeakMap<object, number> }
const counts = new WeakMap<RustGame, Count>(), counted = (game: RustGame): Count => {
  let count = counts.get(game);
  if (!count) counts.set(game, count = { frames: 0, whole: 0, stamps: new WeakMap() });
  return count;
};
export class RustGame {
  declare world: World; declare core: NativeWorldHandle;
  declare objects: Map<number, NativeObject>; declare objectHandles: WeakMap<NativeObject, number>; declare namedHandles: Map<string, number>;
  declare actorHandles: Map<string, number>; declare actorIds: Map<number, string>; declare acceptedFrame: boolean;
  declare kinds: ShotKind[]; declare rounds: SceneProjectile[] | null; declare block: ShotBlock | null;
  declare count: number; declare stale: boolean;

  constructor(world: World, initialTows: readonly KeptTow[] = world._tows || []) {
    this.world = world;
    this.core = world.dynamics!.core;
    this.objects = new Map();
    this.objectHandles = new WeakMap();
    this.namedHandles = new Map();
    this.actorHandles = new Map();
    this.actorIds = new Map();
    this.acceptedFrame = false;
    // What is kept here of the rounds in the air: the legend of their kinds, and until the
    // core moves them again, their words and their full records if somebody asked for them.
    this.kinds = []; this.rounds = this.block = null; this.count = 0; this.stale = false;
    const catalogue = weaponCatalogue();
    this.core.load_game(encode({ ...this.told(world, world.actors, world.plates, world.modules), catalogue, mountCatalogue: WEAPON_MOUNTS,
      projectiles: world.projectiles.map(p => this.projectile(p)),
      tows: initialTows,
      // The core grows a landscape from what a frame says of it, as a page does, and lays the
      // roads of the field over it.
      terrain: { id: world.terrain.id, ...world.terrain.reference(), roads: world.roads }, weather: world.scene.weather,
      visualEvents: world.visualEvents, enclosed: world.enclosed, shotBudget: world.shotBudget, seed: world.blueprint.seed,
      time: world.time, tick: world.tick, nextId: world.nextId,
      randomState: world.random.state >>> 0,
      recoveries: world.dynamics!.recoveries || 0,
      bounds: world.bounds, stats: world.stats }));
    this.accept(decodeNativeFrame(parseNativeJSON(this.core.current_frame())));
    // The scene has them now.
    world.projectiles = [];
  }
  // Constructions of a scene (`world`) with their plates and their pieces, as the core is told of them: each under
  // the handle it goes by there, which this projection knows it by from then on.
  told(world: World, constructions: SceneActor[], meshes: PlateMesh[], pieces: LiveModule[]) {
    for (const a of constructions) {
      if (!world.nativeActors.has(a.id)) world.nativeActors.set(a.id, world.nextActor++);
      const handle = world.nativeActors.get(a.id)!;
      this.actorHandles.set(a.id, handle); this.actorIds.set(handle, a.id);
    }
    const owner = (object: NativeObject | null | undefined): number | null => {
      if (!object) return null;
      const handle = this.objectHandles.get(object) || world.nextOwner++;
      this.objects.set(handle, object);
      this.objectHandles.set(object, handle);
      this.namedHandles.set(object.id, handle);
      return handle;
    };
    const actor = (id: string | undefined): number => id === undefined ? 0 : this.actorHandles.get(id) || 0;
    const actors = constructions.map(a => ({ ...a, blueprint: undefined, bodyPanels: undefined,
      handle: actor(a.id),
      vehicle: a.vehicle ? { ...a.vehicle.snapshot(), ...a.vehicle.pose(),
        mass: a.vehicle.mass, carrierMass: a.vehicle.carrierMass, carrierInertia: a.vehicle.carrierInertia,
        carrierCenter: a.vehicle.carrierCenter, localCenter: a.vehicle.localCenter,
        suspensionCount: a.vehicle.suspensionCount, config: { ...a.vehicle.config },
        // A field resumed (World.resume) flies on as it was kept: in the air, held where it hovered and asked what it was.
        rise: a.vehicle.rise ?? 0, flying: Boolean(a.vehicle.flying), station: a.vehicle.station ?? [null, null] } : null,
      launcher: a.id === 'local' ? world.benchLauncher || world.blueprint.launcher : {
        x: a.x + a.mirror * (a.blueprint.launcher.x - 12), y: a.blueprint.launcher.y } }));
    const plates = meshes.map(p => ({ id: p.id, actorId: p.actorId, definition: p.definition,
      indices: Array.from(p.activeIndices), ballisticGrid: p.ballisticGrid,
      integrity: p.integrity, revision: p.revision, marks: p.marks.slice(), markRevision: p.markRevision, groundMarks: p.groundMarks,
      physicalMass: p.physicalMass, physicalInertia: p.physicalInertia, physicalCenterLocal: p.physicalCenterLocal,
      positions: p.nodes.flatMap(n => [n.x, n.y]), uvs: p.nodes.flatMap(n => [n.u, n.v]),
      vertices: p.nodes.map(n => ({ ...n.local })),
      owner: owner(p), actor: actor(p.actorId), pose: pose(p.definition),
      attached: p.attached !== false, massScale: p.massScale, originalArea: p.originalArea,
      perforations: p.perforations, dents: [...(p.dents?.values() || [])] }));
    const modules = pieces.map(m => ({ ...m, owner: owner(m), actor: actor(m.actorId) }));
    for (const module of modules) if (module.weaponMount) {
      const mount = module.weaponMount, host = mount.hostId ? this.namedHandles.get(mount.hostId) : null;
      if (mount.hostId && !Number.isInteger(host)) throw new Error('Blindagem de montagem nativa ausente.');
      module.weaponMount = { ...mount, hostOwner: host ?? 0, walls: mount.walls.map(wall => {
        const handle = this.namedHandles.get(wall.wallId);
        if (!Number.isInteger(handle)) throw new Error('Parede da montagem nativa ausente.');
        return { ...wall, owner: handle! };
      }) };
    }
    return { actors, plates, modules };
  }
  // The scene the core has becomes `next`: the constructions that are `leaving` go out of it with their parts and
  // the rounds they had in the air, and those that are `coming` are admitted alone. The ground, the other
  // constructions and their rounds stand in the core as they stood: nothing of them is told again. The core
  // answers with what a cold frame says of what came, which no frame told yet; it is read into `next`, the scene
  // from then on.
  // A construction the core refuses leaves it with the scene it had, and this projection as it was. Of those that come,
  // the ones named in `aloft` take the place of one of their own turned about in the air, and the core has each go on as
  // that one went (game_install.rs `admit`).
  admit(next: World, leaving: SceneActor[], coming: SceneActor[], aloft: string[] = []): void {
    const world = this.world, came = new Set(coming.map(a => a.id)), handles = leaving.map(a => this.actorHandles.get(a.id)),
      // The parts of constructions of a scene are no longer known here, nor the constructions that have no other of their name.
      forget = (scene: World, actors: SceneActor[], named: (id: string) => boolean): void => {
        if (actors.length === 0) return;
        const ids = new Set(actors.map(a => a.id));
        for (const part of [...scene.plates, ...scene.modules]) {
          if (part.actorId === undefined || !ids.has(part.actorId)) continue;
          const handle = this.objectHandles.get(part); if (handle !== undefined) this.objects.delete(handle);
          this.objectHandles.delete(part); this.namedHandles.delete(part.id);
        }
        for (const a of actors) if (!named(a.id)) {
          const handle = this.actorHandles.get(a.id); if (handle !== undefined) this.actorIds.delete(handle); this.actorHandles.delete(a.id);
        }
      };
    this.world = next;
    try {
      const told = this.told(next, coming, next.plates.filter(p => p.actorId !== undefined && came.has(p.actorId)), next.modules.filter(m => came.has(m.actorId)));
      // No frame is asked for: nothing but this changed, and of what came the answer says more than a frame.
      const cold = this.call({ op: 'admit', leaving: handles, ...told, ...(aloft.length ? { aloft: aloft.map(id => this.actorHandles.get(id)) } : {}), frame: false });
      forget(world, leaving, id => came.has(id));
      this.parts(cold, true);
      // Leaving also removes that actor's rounds. Cold admission returns parts,
      // so any cached round list/block needs a fresh reading, without stepping.
      if (leaving.length) { this.stale = true; this.rounds = this.block = null; }
    } catch (error) {
      forget(next, coming, id => world.actors.some(a => a.id === id));
      throw error;
    } finally { this.world = world; }
  }
  call<Request extends NativeCommand & { op: 'projectiles' }>(request: Request): NativeProjectileRecord[];
  call<Request extends NativeCommand & { op: 'admit' }>(request: Request): NativeParts;
  call<Request extends NativeCommand & { op: 'digest' }>(request: Request): string;
  call<Request extends NativeCommand & { op: 'work' }>(request: Request): NativeWorkResult;
  call<Request extends NativeCommand & { op: 'input' }>(request: Request): NativeInputResult;
  call<Request extends NativeCommand>(request: Request): unknown;
  call(request: NativeCommand): unknown {
    const actor = this.world.actor(request.actorId);
    if (actor && request.defeated == null) request = { ...request, defeated: Boolean(actor.defeated) };
    const result = decodeNativeEnvelope(parseNativeJSON(this.core.game_command(encode(request))));
    this.accept(result.frame);
    const value = result.result;
    if (request.op === 'projectiles') return decodeNativeProjectiles(value);
    if (request.op === 'admit') return decodeNativeParts(value);
    if (request.op === 'digest') {
      if (typeof value !== 'string') throw new TypeError('Invalid Native digest.');
      return value;
    }
    if (request.op === 'work') {
      if (!nativeRecord(value) || !finiteNumber(value.share) || !(value.limit === undefined || value.limit === null || value.limit === 'engine' || value.limit === 'fuel' || value.limit === 'power'))
        throw new TypeError('Invalid Native work result.');
      return value;
    }
    if (request.op === 'input') {
      if (!nativeRecord(value) || !nativeBoolean(value.accepted) || !(value.record === undefined || nativeRecord(value.record))) throw new TypeError('Invalid Native input result.');
      return value;
    }
    return value;
  }
  // How many frames this projection read, and the one that told it all there is (`counted`).
  get frames(): number { return counted(this).frames; }
  get whole(): number { return counted(this).whole; }
  // An object of the scene the field changed itself, as of the frame to come: a reader passes it over no more.
  touch(object: object): void { const count = counted(this); count.stamps.set(object, count.frames + 1); }
  // Whether an object changed after a reader read the scene as of `frame`: one never stamped is as the frame that told all.
  changedAfter(object: object, frame: number): boolean { const count = counted(this); return (count.stamps.get(object) ?? count.whole) > frame; }
  handle(object: string | NativeObject | null | undefined): number | null {
    return typeof object === 'string' ? this.namedHandles.get(object) ?? null :
      object && this.objectHandles.get(object) || null;
  }
  projectile<P extends SceneProjectile>(p: P) {
    const handle = (value: string | number): number | null => typeof value === 'number' ? value : this.handle(value);
    return { ...p, actor: p.actorId == null ? p.actor : this.actorHandles.get(p.actorId) ?? p.actor,
      emitterOwners: Array.from(p.emitterIds || p.emitterOwners || [], handle).filter(id => id != null),
      visitedOwners: Array.from(p.visited || p.visitedOwners || [], handle).filter(id => id != null) };
  }
  step(dt: number): void { this.accept(decodeNativeFrame(parseNativeJSON(this.core.game_step(dt)))); }
  // A step nobody looks at: the core goes on and tells only its clock. What changed
  // meanwhile comes with the next frame, asked for by `sync` or brought by a command.
  advance(dt: number): void {
    const clock = decodeNativeClock(parseNativeJSON(this.core.game_advance(dt)));
    this.world.time = clock.time; this.world.tick = clock.tick;
    this.stale = true; this.rounds = this.block = null;
  }
  sync(): void { if (this.stale) this.call({ op: 'sync' }); }
  // Every round in the air, in full: what a scene is rebuilt with, and what a test looks over.
  projectiles(): SceneProjectile[] { return this.rounds ||= this.named(this.call({ op: 'projectiles' })); }
  // The rounds in the air as a screen takes them: eight numbers each and the legend of their kinds.
  shots(): ShotBlock {
    this.sync();
    return this.block ||= this.count ? { data: this.core.shot_block(), kinds: this.kinds } : { data: NO_SHOTS.data, kinds: this.kinds };
  }
  // What the air takes of each of those rounds, in the same order: for a host that tells a
  // round once and lets a screen follow it (shot-forecast.ts).
  drags(): Float64Array { this.sync(); return this.count ? this.core.shot_drags() : NO_DRAGS; }
  // The records are owned by this projection: their identifiers are translated in place.
  named(rounds: NativeProjectileRecord[]): SceneProjectile[] {
    return rounds.map(p => Object.assign(p, {
      actorId: p.actorId || (p.actor == null ? undefined : this.actorIds.get(p.actor)),
      emitterIds: new Set((p.emitterOwners || []).map(id => this.objects.get(id)?.id || id)),
      visited: new Set((p.visitedOwners || []).map(id => this.objects.get(id)?.id || id)),
    }));
  }
  accept(frame: NativeFrame | null): void {
    if (!frame) return;
    const world = this.world;
    world.time = frame.time; world.tick = frame.tick; world.stats = frame.stats;
    world.random.state = frame.randomState;
    world.nextId = frame.nextId;
    // The rounds in the air stay in the core. A frame tells how many they are and the kinds new
    // to this legend; only a cold frame carries them in full. Whatever was read of them before
    // is no longer what they are.
    this.stale = false; this.count = frame.shots; this.block = null;
    this.rounds = frame.projectiles ? this.named(frame.projectiles) : null;
    if (frame.shotKinds.from < this.kinds.length) this.kinds = this.kinds.slice(0, frame.shotKinds.from);
    for (const { actor, ...kind } of frame.shotKinds.list) this.kinds.push({ actorId: actor === null ? null : this.actorIds.get(actor) ?? null, ...kind });
    // The parsed packet is owned by this projection. Translate its identifiers
    // directly rather than cloning every emitted event.
    world.dynamics!.recoveries = frame.recoveries;
    // What moves at every step comes as numbers, before the words of what changes now and then.
    const cold = !this.acceptedFrame, actor = this.actors();
    const count = counted(this);
    if (cold) count.whole = count.frames + 1;
    // The numbers are the frame's once taken: a frame accepted again reads the same ones.
    if (frame.block) this.numbers(new Numbers(frame.numbers ??= this.core.frame_block()), cold, actor);
    this.parts(frame, cold, actor);
    const actorId = (handle: number | null | undefined): string | undefined => handle == null ? undefined : this.actorIds.get(handle);
    for (const event of frame.events) {
      // Raw friendly contacts still audit armour loss; they produce no public impact effects or sounds.
      if (event.friendly === true) continue;
      const m = event.owner == null ? undefined : this.objects.get(event.owner), part = event.sourceOwner == null ? undefined : this.objects.get(event.sourceOwner);
      event.actorId = m?.actorId || event.actorId || actorId(event.actor);
      if (event.type === 'secondary-ray' && event.internal)
        event.actorId = part?.actorId || actorId(event.targetActor) || event.actorId;
      event.id = m?.id || event.id; event.componentId = m && !(m instanceof PlateMesh) ? m.id : event.componentId;
      event.otherId = (event.otherOwner == null ? undefined : this.objects.get(event.otherOwner)?.id) || event.otherId;
      event.source = part?.source || part?.id || m?.source || event.source;
      if (event.primaryContact) {
        event.shooterActorId = actorId(event.shooterActor) || null;
        event.targetActorId = actorId(event.targetActor) || null;
        event.emitterId = (event.emitterOwner == null ? undefined : this.objects.get(event.emitterOwner)?.id) || null;
      }
      world.events.push(event);
    }
    count.frames++;
    this.acceptedFrame = true;
  }
  // What a frame says of the constructions, the plates and the pieces, read into the scene. A `cold` one says
  // all there is of each, whatever was read of it before.
  // One lookup table for a frame; keep World.actor's first match and local/first fallback.
  actors(): (id?: string) => SceneActor | undefined {
    const world = this.world, byId = new Map<string, SceneActor>();
    for (const actor of world.actors) if (!byId.has(actor.id)) byId.set(actor.id, actor);
    return id => byId.get(id || 'local') || (!id ? world.actors[0] : undefined);
  }
  // Where a plate is now, and whether it moved: a cold frame says it did, whatever was read of it before.
  place(mesh: PlateMesh, x: number, y: number, angle: number, cold: boolean): boolean {
    const moved = cold || mesh.frame.x !== x || mesh.frame.y !== y || mesh.definition.angle !== angle;
    // Native poses already include chassis motion. Applying moveActor here
    // would transform the same rigid geometry before immediately replacing it.
    mesh.definition.x = x; mesh.definition.y = y; mesh.definition.angle = angle;
    if (moved) Object.assign(mesh.frame, { x, y, c: Math.cos(angle), s: Math.sin(angle) });
    return moved;
  }
  // The numbers of a live frame (game_frame.rs `Told`): of the constructions, the plates and the pieces whose
  // numbers changed, what moves at every step. A construction or a piece this scene does not have is passed over.
  numbers(r: Numbers, cold: boolean, actor: (id?: string) => SceneActor | undefined): void {
    const { stamps, frames } = counted(this), frame = frames + 1;
    for (let n = r.next(); n > 0; n--) {
      const id = this.actorIds.get(r.next()), length = r.next(), end = r.at + length, a = id === undefined ? undefined : actor(id);
      if (!a) { r.at = end; continue; }
      a.cooldown = r.next(); a.aim = r.point(); a.stats = { shots: r.next() }; stamps.set(a, frame);
      if (r.flag()) {
        if (a.vehicle) { readNativeVehicle(a.vehicle, r); stamps.set(a.vehicle, frame); }
        else r.at += VEHICLE_NUMBERS;
      }
      const eyes: SceneEye[] = [];
      for (let e = r.next(); e > 0; e--) eyes.push({ x: r.next(), y: r.next(), left: r.next(), right: r.next() });
      a.eyes = eyes;
      if (r.at !== end) throw new TypeError('Invalid Native actor numbers.');
    }
    for (let n = r.next(); n > 0; n--) {
      const end = r.at + PLATE_NUMBERS, mesh = this.objects.get(r.next());
      if (!mesh) { r.at = end; continue; }
      if (!(mesh instanceof PlateMesh)) throw new TypeError('Native plate state refers to another kind of piece.');
      mesh.carrier = actor(mesh.actorId)?.vehicle || null; stamps.set(mesh, frame);
      if (this.place(mesh, r.next(), r.next(), r.next(), cold)) mesh.updateBounds();
    }
    for (let n = r.next(); n > 0; n--) {
      const end = r.at + MODULE_NUMBERS, m = this.objects.get(r.next());
      if (!m) { r.at = end; continue; }
      if (m instanceof PlateMesh) throw new TypeError('Native module state refers to another kind of piece.');
      stamps.set(m, frame);
      const has = r.next();
      m.x = r.next(); m.y = r.next(); m.angle = r.next();
      const barrelAngle = r.next();
      if (m.kind === 'weapon') m.barrelAngle = barrelAngle;
      m.health = r.next(); m.physicalMass = r.next(); m.physicalInertia = r.next(); m.burnAge = r.next(); m.fireAge = r.next();
      m.groundMarks = r.next(); m.groundDamage = r.next();
      // What only some pieces have is told of every piece, as 0 where it means nothing.
      const aimOffset = r.next(), fuelLitres = r.next(), rounds = r.next(), thrust = r.next();
      if (has & MOUNT) m.aimOffset = aimOffset;
      if (has & FUEL) m.fuelLitres = fuelLitres;
      if (has & AMMO) m.rounds = rounds;
      if (has & THRUSTER) m.thrust = thrust;
      const targetAimOffset = r.next(), servoVelocity = r.next(), targetBarrelAngle = r.next(), reload = r.next(), barrelTemperature = r.next(),
        loaded = r.next(), feedReload = r.next();
      if (has & SERVO) {
        if (has & MOUNT) m.targetAimOffset = targetAimOffset;
        m.servoVelocity = servoVelocity; m.targetBarrelAngle = targetBarrelAngle; m.reload = reload; m.barrelTemperature = barrelTemperature;
        m.loaded = loaded; m.feedReload = feedReload;
      }
      // The kinds of ground a wheel stands on come as words (`parts`); the place it touches, here.
      if (has & CONTACT) m.groundContact = { nx: r.next(), ny: r.next(), tx: r.next(), ty: r.next(), x: r.next(), y: r.next(),
        contacts: r.next(), materials: m.groundContact?.materials ?? {}, minX: r.next(), maxX: r.next() };
      else {
        if (has & GEAR) m.groundContact = null;
        r.at += 9;
      }
      if (has & SUSPENSION) {
        if (m.kind !== 'wheel' && m.kind !== 'track') throw new TypeError('Invalid Native suspension state.');
        Object.assign(m.suspension, { travel: r.next(), displacement: r.next(), tilt: r.next(), compression: r.next() });
        m.wheelSpin = r.next(); m.wheelAngularSpeed = r.next();
      } else r.at += 6;
      if (r.at !== end) throw new TypeError('Invalid Native module numbers.');
    }
    if (r.at !== r.block.length) throw new TypeError('Invalid Native frame numbers.');
  }
  // What a frame says of the constructions, the plates and the pieces in words, read into the scene. A `cold` frame says
  // all there is of each, whatever was read of it before, numbers included; a live one tells its numbers apart (`numbers`).
  parts(frame: NativeParts, cold: boolean, actor = this.actors()): void {
    const world = this.world, { stamps, frames } = counted(this), told = frames + 1;
    if (frame.tows !== undefined) world._tows = frame.tows;
    for (const state of frame.actors) {
      const a = actor(state.id); if (!a) continue;
      stamps.set(a, told);
      const also = state.also || [];
      if (!(state.weapon === null || isWeaponSettings(state.weapon)) || !(state.lastWeapon === null || typeof state.lastWeapon === 'string') ||
        !trigger(state.trigger) || !pending(state.pendingShot) || !nativeArray(also, additional)) throw new TypeError('Invalid Native actor state.');
      Object.assign(a, { weapon: state.weapon, lastWeapon: state.lastWeapon, trigger: state.trigger, pendingShot: state.pendingShot, also });
      // A cold record: its numbers and its whole vehicle with it.
      const whole = state.cooldown !== undefined;
      if (whole) {
        if (!finiteNumber(state.cooldown) || !nativePoint(state.aim) || !actorStats(state.stats) || !nativeArray(state.eyes, eye))
          throw new TypeError('Invalid Native actor state.');
        Object.assign(a, { cooldown: state.cooldown, aim: state.aim, stats: state.stats, eyes: state.eyes });
      }
      if (cold) {
        if (state.contactContours !== undefined && !nativePolygons(state.contactContours)) throw new TypeError('Invalid Native contact contours.');
        a.contactContours = state.contactContours; delete a.contactVolumes;
      }
      if (a.vehicle && state.vehicle) {
        stamps.set(a.vehicle, told);
        if (whole) {
          if (!nativeVehicle(state.vehicle)) throw new TypeError('Invalid Native vehicle state.');
          applyNativeVehicle(a.vehicle, state.vehicle);
        } else {
          if (!vehicleWords(state.vehicle)) throw new TypeError('Invalid Native vehicle state.');
          a.vehicle.groundSurface = state.vehicle.groundSurface; a.vehicle.stuck = state.vehicle.stuck;
        }
      }
    }
    for (const state of frame.plates) {
      const mesh = this.objects.get(state.owner);
      if (!mesh) continue;
      if (!(mesh instanceof PlateMesh)) throw new TypeError('Native plate state refers to another kind of piece.');
      stamps.set(mesh, told);
      const p = state.pose, damage = state.damage,
        geometryChanged = damage?.ballisticGrid !== undefined && (cold || damage.revision !== mesh.revision);
      mesh.carrier = actor(mesh.actorId)?.vehicle || null;
      const moved = p !== undefined && this.place(mesh, p.x, p.y, p.angle, cold);
      if (damage) {
        if (geometryChanged) {
          if (!nativeGrid(damage.ballisticGrid)) throw new TypeError('Invalid Native plate grid.');
          mesh.ballisticGrid = damage.ballisticGrid;
          mesh.damage.regions = gridRegions(damage.ballisticGrid);
          mesh.damage.refresh(); mesh.refreshSpans();
        }
        if (damage.marks !== undefined) { if (!nativeMarks(damage.marks)) throw new TypeError('Invalid Native plate marks.'); mesh.marks = damage.marks; }
        if (damage.dents !== undefined) { if (!nativeDents(damage.dents)) throw new TypeError('Invalid Native dents.'); mesh.dents = new Map(damage.dents.map((d, i) => [i, d])); }
        if (damage.perforations !== undefined) { if (!nativePerforations(damage.perforations)) throw new TypeError('Invalid Native perforations.'); mesh.perforations = damage.perforations; }
        for (const key of PLATE_STATE) copyPlateField(mesh, damage, key);
      }
      if (moved || geometryChanged) mesh.updateBounds();
    }
    for (const state of frame.modules) {
      const m = this.objects.get(state.owner); if (!m) continue;
      if (m instanceof PlateMesh) throw new TypeError('Native module state refers to another kind of piece.');
      stamps.set(m, told);
      if (state.x !== undefined) {
        if (!nativePose(state)) throw new TypeError('Invalid Native module pose.');
        Object.assign(m, { x: state.x, y: state.y, angle: state.angle });
        if (m.kind === 'weapon') {
          if (!finiteNumber(state.barrelAngle)) throw new TypeError('Invalid Native barrel angle.');
          m.barrelAngle = state.barrelAngle;
        }
      }
      for (const key of MODULE_STATE) copyModuleField(m, state, key);
      if (state.suspension !== undefined) {
        if (!nativeSuspension(state.suspension) || m.kind !== 'wheel' && m.kind !== 'track') throw new TypeError('Invalid Native suspension state.');
        Object.assign(m.suspension, state.suspension);
      }
      if (state.groundMaterials !== undefined) {
        if (!nativeScars(state.groundMaterials)) throw new TypeError('Invalid Native ground materials.');
        if (m.groundContact) m.groundContact = { ...m.groundContact, materials: state.groundMaterials };
      }
    }
  }
}
