import { PlateMesh } from './mesh.ts';
import { MATERIALS } from './materials.ts';
import { fixedWeapon, isWeaponSettings } from './weapons.ts';
import { Random, plateCorners } from './math.ts';
import { componentPolygon, componentFootprintPolygons } from './assembly.ts';
import { coldConstructionPlacement } from './construction-placement.ts';
import { compileBlueprint, validateBlueprint } from './persistence.ts';
import { Vehicle, VEHICLE_ORIGIN } from './vehicle.ts';
import { NativeDynamics, initNativeDynamics } from './native-dynamics.ts';
import { Terrain, TERRAIN_PROFILES, BATTLE_TERRAIN_IDS } from './terrain.ts';
import { NO_ROADS, paved, normalRoads } from './roads.ts';
import { RustGame, NativeQueries, VEHICLE_STATE, PLATE_STATE, MODULE_STATE, copyModuleField, copyPlateField } from './rust-game.ts';
import { decodeKeptWorld, restoreVehicleState, nativeRecord, nativePoint, nativePolygons, nativeBoolean, finiteNumber, nativeSuspension } from './native-frame-contract.ts';
import { gridRegions } from './armor-grid.ts';
import { designation } from './designation.ts';
import { turnPlate, turnModule, turningOffset, aloftPose, keepPlate, keepModule } from './turn-about.ts';
import type { AuthoredConstruction, ConstructionSource, CompiledConstruction, CompiledModule, CompiledPlate, ModuleSupport } from './construction-contract.ts';
import type { Point, Pose } from './math.ts';
import type { SceneActor, SceneActorBase, LiveModule, SceneEvent, SceneStats, SceneProjectile, SceneSnapshot, SceneSources, SceneTow } from './scene-contract.ts';
import type { MaterialGrid } from './armor-grid.ts';
import type { Road, RoadKind } from './roads.ts';
import type { WeaponSettings, WeaponOverrides, WeaponFamilyId } from './weapons.ts';
import type { TerrainId } from './terrain.ts';

export interface WorldScene { weather?: string; seed?: number; mapLength?: number; center?: number }
export interface WorldOptions { visualEvents?: boolean; enclosed?: boolean; shotBudget?: unknown; settle?: boolean; scene?: WorldScene }
export interface ActorOptions {
  id: string; ownerId?: string | null | undefined; team?: string | null | undefined; x?: number; facing?: number; revision?: number;
  color?: string | undefined; playerName?: string | undefined; rest?: boolean; aloft?: { y: number; angle: number } | null;
}
export const FIXED_DT = 1 / 60;

await initNativeDynamics();

function installedModule(definition: CompiledModule, actorId: string): LiveModule {
  return { ...definition, actorId, burning: false, detonated: false, burnAge: 0, fireAge: 0 };
}
function placedActor<T extends object>(fields: T, vehicle: Vehicle | null, y: number) {
  return vehicle ? Object.assign(fields, { vehicle }) : Object.assign(fields, { vehicle: null, y });
}
// The support of a piece (game_construction.rs `standoff`) as its piece faces the other way: its foot from rear to
// front still, and its column counter-clockwise still.
const across = <P extends Point>(point: P): P => ({ ...point, x: -point.x });
function mirroredSupport(support: ModuleSupport): ModuleSupport {
  return { ...support, foot: support.foot.map(across).reverse(), normal: across(support.normal),
    ...(support.polygon ? { polygon: support.polygon.map(across).reverse() } : {}) };
}

// What a field kept says of a construction to have it admitted again, and what it says of how it stood (`World.keep`).
const ADMITTED = ['id', 'ownerId', 'team', 'x', 'facing', 'revision', 'color', 'playerName'] as const,
  STOOD = ['defeated', 'cooldown', 'aim', 'weapon', 'lastWeapon', 'stats', 'contactContours'] as const;
// Mount profiles belong to the compiler; only live state is written out and restored. So do the most a piece holds and
// what it weighs empty: a field resumed has them as its designs make them now, by the rules of the core that admits them
// again, and each piece holds what it held as far as that room goes (`World.resume`; a load is stowed as far as its
// room goes by the core, game_damage.rs `stow`). Its body is weighed again by what it holds now as soon as that differs
// (game.rs `weigh`).
const DESIGNED: readonly (keyof LiveModule)[] = Object.freeze(['weaponMount', 'capacityLitres', 'capacityRounds', 'capacityM3', 'dryMass']);
// Nor is how far its crew got loading a gun: a field resumed has its guns loaded from their boxes (game.rs `load_guns`).
const RELOADED: readonly (keyof LiveModule)[] = Object.freeze(['loaded', 'feedReload']);
const KEPT_MODULE_STATE = ['x', 'y', 'angle', 'barrelAngle', ...MODULE_STATE.filter(key => !DESIGNED.includes(key) && !RELOADED.includes(key))] as const;
// The pieces whose weight follows what they hold: the core weighs them empty by their size (game_damage.rs `reservoir`).
// Any other weighs empty what it weighs as admitted.
const RESERVOIRS = Object.freeze(['fuel', 'ammo', 'hopper', 'cistern', 'supply', 'paver']);
function pick<T, K extends keyof T>(from: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const selected: Partial<Pick<T, K>> = {};
  for (const key of keys) selected[key] = from[key];
  return selected;
}
function restoreActor(actor: SceneActor, saved: Record<string, unknown>): void {
  if (saved.defeated !== undefined) { if (!nativeBoolean(saved.defeated)) throw new TypeError('Invalid saved actor condition.'); actor.defeated = saved.defeated; }
  if (saved.cooldown !== undefined) { if (!finiteNumber(saved.cooldown)) throw new TypeError('Invalid saved actor cooldown.'); actor.cooldown = saved.cooldown; }
  if (saved.aim !== undefined) { if (!nativePoint(saved.aim)) throw new TypeError('Invalid saved actor aim.'); actor.aim = saved.aim; }
  if (saved.weapon !== undefined) { if (saved.weapon !== null && !isWeaponSettings(saved.weapon)) throw new TypeError('Invalid saved actor weapon.'); actor.weapon = saved.weapon; }
  if (saved.lastWeapon !== undefined) { if (saved.lastWeapon !== null && typeof saved.lastWeapon !== 'string') throw new TypeError('Invalid saved weapon identity.'); actor.lastWeapon = saved.lastWeapon; }
  if (saved.stats !== undefined) { if (!nativeRecord(saved.stats) || !finiteNumber(saved.stats.shots)) throw new TypeError('Invalid saved actor counters.'); actor.stats = { ...saved.stats, shots: saved.stats.shots }; }
  if (saved.contactContours !== undefined) { if (!nativePolygons(saved.contactContours)) throw new TypeError('Invalid saved contact contours.'); actor.contactContours = saved.contactContours; }
}
function numericStats(stats: SceneStats): SceneStats {
  const selected: SceneStats = { shots: stats.shots, impacts: stats.impacts, penetrations: stats.penetrations, ricochets: stats.ricochets, explosions: stats.explosions };
  for (const [key, value] of Object.entries(stats)) if (typeof value === 'number') selected[key] = value;
  return selected;
}
// Whether two ballistic grids are of one plate: as many cells, over the same bounds.
function sameGrid(a: MaterialGrid | undefined, b: MaterialGrid | undefined): boolean {
  if (!a?.bounds || !b?.bounds) return false;
  return a.nx === b.nx && a.ny === b.ny && (['minX', 'maxX', 'minY', 'maxY'] as const).every(key => a.bounds[key] === b.bounds[key]);
}
export class World {
  declare visualEvents: boolean; declare enclosed: boolean; declare shotBudget: unknown; declare settle: boolean;
  declare scene: WorldScene & { weather: string }; declare materials: typeof MATERIALS; declare index: NativeQueries;
  declare blueprint: CompiledConstruction; declare construction: AuthoredConstruction;
  declare rustGame: RustGame | null; declare dynamics: NativeDynamics | null;
  declare nativeActors: Map<string, number>; declare nextOwner: number; declare nextActor: number;
  declare terrain: Terrain; declare roads: readonly Road[]; declare random: Random;
  declare plates: PlateMesh[]; declare modules: LiveModule[]; declare seeded: SceneProjectile[];
  declare events: SceneEvent[]; declare _tows: SceneTow[];
  declare time: number; declare tick: number; declare nextId: number; declare stats: SceneStats;
  declare vehicle: Vehicle | null; declare bounds: { minX: number; maxX: number };
  declare testDistance: number; declare benchLauncher: Point | null; declare actors: SceneActor[];
  // Constructions pass through one another; enclosed worlds hold vehicles short of the ends of their ground. A world
  // with a `shotBudget` holds the fire of a side with that many rounds in the air (construction-limits.ts).
  constructor(blueprint: ConstructionSource | null, { visualEvents = true, enclosed = false, shotBudget = null, settle = false, scene = {} }: WorldOptions = {}) {
    this.visualEvents = visualEvents;
    this.enclosed = enclosed;
    this.shotBudget = shotBudget;
    this.settle = settle;
    this.scene = { weather: 'clear', ...scene };
    this.materials = MATERIALS;
    this.index = new NativeQueries(this);
    if (blueprint !== null) this.load(blueprint);
  }
  load(blueprint: ConstructionSource): void {
    const source = validateBlueprint(blueprint), validated = compileBlueprint(source);
    this.rustGame = null;
    this.nextOwner = 1;
    this.nativeActors = new Map(); this.nextActor = 1;
    this.dynamics?.free();
    this.blueprint = validated;
    this.construction = source;
    this.terrain = new Terrain(validated.terrain || 'flat', {
      seed: this.scene.seed ?? validated.seed,
      ...(this.scene.mapLength === undefined ? {} : { length: this.scene.mapLength }), ...(this.scene.center === undefined ? {} : { center: this.scene.center }) });
    // The roads the field laid over its ground (roads.ts): none on a world just loaded.
    this.roads = NO_ROADS;
    this.random = new Random(this.blueprint.seed);
    this.plates = this.blueprint.plates.map((p) => new PlateMesh({ ...p, actorId: 'local' }));
    this.modules = this.blueprint.modules.map(m => installedModule(m, 'local'));
    this.projectiles = [];
    this.events = [];
    this._tows = [];
    this.time = 0;
    this.tick = 0;
    this.nextId = 1;
    this.stats = {
      shots: 0,
      impacts: 0,
      penetrations: 0,
      ricochets: 0,
      explosions: 0,
      spallBursts: 0,
      secondaryShots: 0,
      secondaryComponentHits: 0,
    };
    this.vehicle = this.blueprint.preset === 'vehicle' ? new Vehicle(this.blueprint.vehicle) : null;
    // A landscape is held to its own ground; a laboratory track to the stretch about its workshop.
    const profile = TERRAIN_PROFILES[this.terrain.id];
    this.bounds = profile.battle ?
      { minX: this.terrain.minX - 72, maxX: this.terrain.maxX + 72 } :
      { minX: -1500, maxX: 1500 };
    this.testDistance = 0;
    this.benchLauncher = null;
    this.actors = [
      placedActor({
        id: 'local',
        ownerId: 'local',
        name: designation(this.blueprint),
        blueprint: this.blueprint,
        construction: source,
        x: 12,
        // A fixed construction stands where its design was laid out (see `#admitActor`).
        facing: -1 as const,
        mirror: 1 as const,
        revision: 0,
        vehicle: this.vehicle,
        cooldown: 0,
        trigger: null,
        lastWeapon: null,
        aim: { x: 20, y: 1.5 },
        weapon: null,
        stats: { ...this.stats },
        eyes: [],
      }, this.vehicle, VEHICLE_ORIGIN.y),
    ];
    for (const plate of this.plates) {
      plate.actorId = 'local';
      plate.definition.actorId = 'local';
    }
    this.buildAssembly(this.actors[0]!);
    this.dynamics = new NativeDynamics();
    // A normal trial seats fixed structures before the first solver step;
    // explicitly authored scenes keep their original height. Vehicles retain
    // their existing placement on elevated landscapes.
    if (BATTLE_TERRAIN_IDS.includes(this.terrain.id) || this.settle && !this.vehicle)
      this.replaceActor(source, { id: 'local', x: 12, facing: -1 });
  }
  reset() {
    this.load(this.construction);
  }
  game(): RustGame { return this.rustGame ||= new RustGame(this); }
  // Every round in the air, in full. The core keeps them: before the scene is admitted,
  // this is the list it will start with. A host that only shows them reads `shots`.
  get projectiles(): SceneProjectile[] { return this.rustGame ? this.rustGame.projectiles() : this.seeded; }
  set projectiles(rounds: SceneProjectile[]) { this.seeded = rounds; }
  // The rounds in the air as numbers: see shots.ts.
  get shots() { return this.game().shots(); }
  get shotDrags() { return this.game().drags(); }
  // Reads the scene after steps taken without looking at it.
  sync() { this.rustGame?.sync(); }
  dispose() {
    this.dynamics?.free();
    this.dynamics = null;
  }
  actor(id?: string | null): SceneActor | undefined {
    return this.actors.find(actor => actor.id === (id || 'local')) || (!id ? this.actors[0] : undefined);
  }
  // Read-only projection of the Native relation; mechanics never read this array.
  get tows() { return this._tows || []; }
  // The bench launcher's reload. A mounted gun carries its own: `reload`, on the component.
  get cooldown() { return this.actor()?.cooldown || 0; }
  get trigger() { return this.actor()?.trigger || null; }
  get lastWeapon() { return this.actor()?.lastWeapon || null; }
  addActor(blueprint: ConstructionSource, options: Partial<ActorOptions> = {}): SceneActor {
    if (!options.id || this.actor(options.id)) throw new Error('Construção já existe.');
    return this.#admitActor(blueprint, { ...options, id: options.id });
  }
  replaceActor(blueprint: ConstructionSource, options: Partial<ActorOptions> = {}): SceneActor {
    const old = options.id && this.actor(options.id);
    if (!old) throw new Error('Construção não existe.');
    return this.#admitActor(blueprint, {
      id: old.id, ownerId: old.ownerId, team: old.team, x: old.vehicle?.x ?? old.x, facing: old.facing,
      color: old.color, playerName: old.playerName, ...options, revision: old.revision + 1,
    });
  }
  // A construction turns about where it stands: it is admitted again from its design, facing the other way, in the
  // stretch of ground it took up, lying along that ground, and is what it was — what it holds, what it lost and the
  // marks left on it (turn-about.ts), with what it counted. It comes to rest anew: nothing is kept of how it moved,
  // nor of how its guns were laid, nor of how it lay — one that lay on its side comes back on its wheels.
  // One that flies turns about where it is in the air (`aloft`): it is laid as its own mirror image in the frame of its
  // hull, about the upright of the hull through its centre of mass, and the core stands it where it was and has it go on
  // as it went — moving, turning and flying as it did, its guns laid anew (game_install.rs `admit`).
  turnActor(id: string): SceneActor {
    const old = this.actor(id);
    if (!old) throw new Error('Construção não existe.');
    this.game().sync();
    const plates = this.plates.filter(p => p.actorId === id), modules = this.modules.filter(m => m.actorId === id),
      // The design is laid about its own X = 12, and seldom has its middle there.
      middle = turningOffset(old.blueprint), pose = old.vehicle?.pose(), turned = old.vehicle?.flying ? aloftPose(old) : null,
      place = turned ? { x: turned.x, aloft: { y: turned.y, angle: turned.angle } }
        : { x: (pose?.x ?? old.x) + 2 * old.mirror * middle * Math.cos(pose?.angle || 0), rest: true };
    return this.#admitActor(old.construction, { ...pick(old, ADMITTED), id: old.id, ...place, facing: -old.facing, revision: old.revision + 1 }, (actor, scene) => {
      Object.assign(actor.stats, old.stats);
      for (const [i, plate] of scene.plates.filter(p => p.actorId === id).entries()) turnPlate(plate, plates[i]!);
      for (const [i, module] of scene.modules.filter(m => m.actorId === id).entries()) turnModule(module, modules[i]!);
    });
  }
  // A construction mended where it stands of what the core lets nobody mend in it as it is — a component that burst, which
  // the core holds burst whatever health it is given, and a plate, whose holes it keeps — is admitted again from its design,
  // where it stands, facing as it faced and lying along its ground, and is what it was (turn-about.ts `keepPlate`,
  // `keepModule`), with what it counted, but for those: the components in `revived`, by their ids in the design, work
  // again with what they hold now, and the plates in `renewed` are as the design has them (room.ts `fix`). Like one
  // turned about, it comes to rest anew.
  reviveActor(id: string, { revived = new Set<string>(), renewed = new Set<string>() }: { revived?: ReadonlySet<string>; renewed?: ReadonlySet<string> } = {}): SceneActor {
    const old = this.actor(id);
    if (!old) throw new Error('Construção não existe.');
    this.game().sync();
    const plates = this.plates.filter(p => p.actorId === id), modules = this.modules.filter(m => m.actorId === id),
      design = (part: { id: string }) => part.id.split(':').slice(2).join(':');
    return this.#admitActor(old.construction, { ...pick(old, ADMITTED), id: old.id, x: old.vehicle?.x ?? old.x, revision: old.revision + 1, rest: true }, (actor, scene) => {
      Object.assign(actor.stats, old.stats);
      for (const [i, plate] of scene.plates.filter(p => p.actorId === id).entries()) if (!renewed.has(design(plate))) keepPlate(plate, plates[i]!);
      for (const [i, module] of scene.modules.filter(m => m.actorId === id).entries()) {
        keepModule(module, modules[i]!);
        if (revived.has(design(module))) Object.assign(module, { detonated: false, burning: false, fireAge: 0 });
      }
    });
  }
  // `settle` gives the construction and its parts what they are to come into the scene with, before the core is told of them.
  // A vehicle comes level, or with `rest` as it would lie on the ground there: along the line that ground follows
  // under its running gear; or, turned about in the air (`aloft`), with the origin of its hull as high as `y` and leant
  // `angle`, and the core told that it takes the place of one of its own that goes on in it.
  #admitActor(blueprint: ConstructionSource, { id, ownerId, team = ownerId, x = 12, facing = -1, revision = 0, color = '#b4c786', playerName = '', rest = false, aloft = null }: ActorOptions, settle: ((actor: SceneActor, scene: World) => void) | null = null): SceneActor {
    if (facing !== -1 && facing !== 1) throw new Error('Orientação de construção inválida.');
    if (!Number.isFinite(x)) throw new Error('Posição de construção inválida.');
    // Workshop designs face left. Facing is a world direction; reflection is
    // a separate placement transform and never rotates the chassis upside down.
    const mirror = facing === -1 ? 1 : -1, source = validateBlueprint(blueprint), design = compileBlueprint(source),
      scenic = BATTLE_TERRAIN_IDS.includes(this.terrain.id),
      tilt = aloft ? aloft.angle : rest && design.preset === 'vehicle' ? this.#groundTilt(design, x, mirror) : 0,
      { lift, point } = coldConstructionPlacement(design, this.terrain, { x, facing, angle: tilt, settle: this.settle, lift: aloft && aloft.y - VEHICLE_ORIGIN.y }),
      vehicle = design.preset === 'vehicle' ? new Vehicle(design.vehicle, { x, y: VEHICLE_ORIGIN.y + lift }) : null;
    if (vehicle) {
      vehicle.angle = tilt;
      vehicle.bounds = {
        minX: this.bounds.minX + 4,
        maxX: this.bounds.maxX - 4,
      };
    }
    const actor = placedActor<SceneActorBase & { vehicle: Vehicle | null }>({
      id,
      ownerId,
      team,
      name: designation(design),
      blueprint: design,
      construction: source,
      x,
      // A vehicle is where its body is. A fixed construction has none: it stands where it came, its design raised with
      // the ground under it, and this is how high the origin of the design stands then.
      facing,
      mirror,
      revision,
      color,
      playerName,
      vehicle,
      cooldown: 0,
      trigger: null,
      lastWeapon: null,
      aim: { x: x + facing * 12, y: 2.42 + (scenic ? this.terrain.height(x) : 0) },
      weapon: null,
      stats: {
        shots: 0,
        impacts: 0,
        penetrations: 0,
        ricochets: 0,
        explosions: 0,
      },
      // What it sees with, as the core tells it with every frame: each working optic that sees out to a
      // side, where it stands and how far it sees to the left and to the right. None while out of action.
      eyes: [],
    }, vehicle, VEHICLE_ORIGIN.y + lift);
    const qualify = (pieceId: string | null | undefined): string | null => (pieceId ? `${id}:${revision}:${pieceId}` : null);
    const commonPlace = <P extends CompiledPlate | CompiledModule>(p: P) => ({
      ...p, id: `${id}:${revision}:${p.id}`, mountId: qualify(p.mountId), actorId: id, x: point(p).x, y: point(p).y,
    });
    const placePlate = (p: CompiledPlate): CompiledPlate & { actorId: string } => ({
      ...commonPlace(p), angle: (mirror === -1 ? Math.PI - p.angle : p.angle) + tilt,
      anchors: p.anchors.map(a => ({ ...a, v: mirror * a.v })),
      physicalCenterLocal: { ...p.physicalCenterLocal, y: mirror * p.physicalCenterLocal.y },
    });
    const placeModule = (p: CompiledModule): CompiledModule & { actorId: string } => {
      if (p.kind !== 'weapon') {
        const placed = { ...commonPlace(p), angle: mirror * p.angle + tilt, mirrored: Boolean(p.mirrored) !== (mirror === -1),
          physicalCenterLocal: { ...p.physicalCenterLocal, x: mirror * p.physicalCenterLocal.x } };
        // A sensor's column or a blade's support remains in the frame of its piece.
        return p.support && mirror === -1 ? Object.assign(placed, { support: mirroredSupport(p.support) }) : placed;
      }
      return {
        ...commonPlace(p), angle: (mirror === -1 ? Math.PI - p.angle : mirror * p.angle) + tilt,
        physicalCenterLocal: { ...p.physicalCenterLocal, y: mirror * p.physicalCenterLocal.y },
        weaponMount: {
          ...p.weaponMount, hostId: qualify(p.weaponMount.hostId),
          walls: p.weaponMount.walls.map(wall => ({ ...wall, wallId: `${id}:${revision}:${wall.wallId}`,
            a: { ...wall.a, y: mirror * wall.a.y }, b: { ...wall.b, y: mirror * wall.b.y },
            ...(wall.port && mirror === -1 ? { port: { ...wall.port, min: -wall.port.max, max: -wall.port.min } } : {}) })),
          ...(mirror === -1 ? { mirrored: !p.weaponMount.mirrored, min: -p.weaponMount.max, max: -p.weaponMount.min,
            ...(Number.isFinite(p.weaponMount.hullAxis) ? { hullAxis: Math.PI - p.weaponMount.hullAxis } : {}) } : {}),
        }, aimOffset: mirror * p.aimOffset,
        barrelAngle: (mirror === -1 ? Math.PI - p.angle : p.angle) + mirror * p.aimOffset + tilt,
        targetBarrelAngle: (mirror === -1 ? Math.PI - p.angle : p.angle) + mirror * p.aimOffset + tilt,
        materialPolygons: p.weaponMount.exposed ? p.materialPolygons.map(poly => poly.map(q => ({ x: q.x, y: mirror * q.y }))) : p.materialPolygons,
      };
    };
    const next = this.#actorScene(id);
    next.actors.push(actor);
    for (const definition of design.plates) {
      const plate = new PlateMesh(placePlate(definition));
      plate.actorId = id;
      next.plates.push(plate);
    }
    for (const definition of design.modules)
      next.modules.push(installedModule(placeModule(definition), id));
    next.buildAssembly(actor);
    if (id === 'local') { next.blueprint = design; next.construction = source; }
    settle?.(actor, next);
    this.#commitActorScene(next, aloft ? [id] : []);
    return actor;
  }
  // The angle of the line that the ground follows under the running gear of a design laid at `x`, as `mirror` lays
  // it: the line nearest to the ground at every quarter metre of the stretch the wheels and tracks take up — of the
  // whole design, when it has none.
  #groundTilt(design: CompiledConstruction, x: number, mirror: number): number {
    const gear = design.modules.filter(m => m.kind === 'wheel' || m.kind === 'track'),
      xs = (gear.length ? gear.flatMap(componentPolygon) : [...design.plates.flatMap(plateCorners), ...design.modules.flatMap(componentPolygon)])
        .map(p => x + mirror * (p.x - 12)),
      from = Math.min(...xs), to = Math.max(...xs), count = Math.max(2, Math.ceil((to - from) / .25) + 1),
      points = Array.from({ length: count }, (_, i) => { const at = from + (to - from) * i / (count - 1); return { x: at, y: this.terrain.height(at) }; }),
      middle = points.reduce((sum, p) => ({ x: sum.x + p.x / count, y: sum.y + p.y / count }), { x: 0, y: 0 }),
      across = points.reduce((sum, p) => sum + (p.x - middle.x) * (p.y - middle.y), 0), along = points.reduce((sum, p) => sum + (p.x - middle.x) ** 2, 0);
    return along > 0 ? Math.atan(across / along) : 0;
  }
  #actorScene(id: string): World {
    const next: World = Object.create(this);
    next.actors = this.actors.filter(a => a.id !== id);
    next.plates = this.plates.filter(p => p.actorId !== id);
    next.modules = this.modules.filter(m => m.actorId !== id);
    // The rounds in the air are the core's once it has the scene: it drops those of a construction that leaves.
    if (!this.rustGame) next.projectiles = this.projectiles.filter(p => p.actorId !== id);
    next.nativeActors = new Map(this.nativeActors);
    next.nextId = this.nextId; next.nextOwner = this.nextOwner; next.nextActor = this.nextActor;
    next.events = this.events.slice();
    next.rustGame = null;
    return next;
  }
  #commitActorScene(next: World, aloft: string[] = []): void {
    next.vehicle = next.actor()?.vehicle || null;
    // Before the first command, callers may still compose terrain and actors.
    // A live scene commits only after the core took what changed of it: the constructions that left and those
    // that came, and nothing of the others, and of those that came the ones turned about in the air (`aloft`). A
    // core that refuses has the scene it had, and so does this world.
    if (this.rustGame) {
      const before = new Set(this.actors), after = new Set(next.actors);
      this.rustGame.admit(next, this.actors.filter(a => !after.has(a)), next.actors.filter(a => !before.has(a)), aloft);
      next.rustGame = this.rustGame;
    }
    Object.assign(this, next);
  }
  removeActor(id: string): void {
    if (!this.actors.some(actor => actor.id === id)) return;
    const next = this.#actorScene(id);
    next.nativeActors.delete(id);
    this.#commitActorScene(next);
  }
  drainEvents() {
    return this.events.splice(0);
  }
  // Lays a road over the ground of the field from `x0` up to `x1`, of `kind`, over whatever was there (roads.ts `paved`).
  // Returns the roads of the field then.
  pave(x0: number, x1: number, kind: RoadKind): readonly Road[] { this.lay(paved(this.roads, x0, x1, kind)); return this.roads; }
  // The roads of the field are `roads` from now on: the ground of this world has them, and the core lays them under the
  // running gear from its next step. Laying them changes nothing else.
  lay(roads: readonly Road[]): void {
    this.roads = roads; this.terrain.roads = roads;
    this.rustGame?.call({ op: 'roads', roads, frame: false });
  }
  // The field as it stands, to be written out and resumed by another world on the same ground: every
  // construction as it was authored, and what a frame tells of it since — where it is and how it moves, what it
  // holds, what it lost and the marks left on it — with the clock, the draw and the roads. The rounds in the air are not
  // in it, nor a trigger held or a shot waiting: a field resumed is one where nobody is firing yet. Of the
  // counts of the field, the numbers: who hit whom is told by handles another world gives anew. What it
  // returns is this world's own, not a copy: it is for writing out at once.
  keep() {
    this.game().sync();
    return { time: this.time, tick: this.tick, nextId: this.nextId, randomState: this.random.state >>> 0,
      stats: numericStats(this.stats),
      recoveries: this.dynamics!.recoveries || 0, roads: this.roads,
      ...(this.tows.length ? { tows: this.tows.map(tow => pick(tow, ['actorId', 'targetId', 'partAId', 'partBId', 'localA', 'localB', 'length'])) } : {}),
      actors: this.actors.map(a => ({ ...pick(a, ADMITTED), ...pick(a, STOOD), defeated: Boolean(a.defeated), construction: a.construction,
        vehicle: a.vehicle && { enabled: a.vehicle.config.enabled, mass: a.vehicle.mass, ...pick(a.vehicle, VEHICLE_STATE) } })),
      plates: this.plates.map(p => ({ id: p.id, pose: { x: p.definition.x, y: p.definition.y, angle: p.definition.angle || 0 },
        ballisticGrid: p.ballisticGrid, marks: p.marks, dents: [...(p.dents?.values() || [])], perforations: p.perforations,
        originalArea: p.originalArea, ...pick(p, PLATE_STATE) })),
      modules: this.modules.map(m => ({ id: m.id, ...pick(m, KEPT_MODULE_STATE), suspension: m.suspension })) };
  }
  // Makes this world, with nothing on it yet, the field that was kept, as read back from where it was written.
  // Each construction is admitted again from its design, as any that comes into the field, and then given the
  // state it had; the core takes the whole scene at once. A part the design no longer has, or has and was not
  // kept, is refused: the design is not what it was.
  resume(input: unknown): void {
    const kept = decodeKeptWorld(input);
    if (this.actors.length) throw new Error('Só um campo vazio é retomado.');
    this.rustGame = null;
    for (const stood of kept.actors) {
      const a = this.addActor(validateBlueprint(stood.construction), { ...pick(stood, ADMITTED), id: stood.id });
      restoreActor(a, stood);
      if (!a.vehicle !== !stood.vehicle) throw new Error('Construção salva de outro tipo.');
      if (a.vehicle) {
        const vehicle = stood.vehicle;
        if (!vehicle || !nativeBoolean(vehicle.enabled) || !finiteNumber(vehicle.mass)) throw new TypeError('Invalid saved vehicle.');
        a.vehicle.config.enabled = vehicle.enabled;
        restoreVehicleState(a.vehicle, vehicle);
        a.vehicle.mass = vehicle.mass;
      }
    }
    const plates = new Map(this.plates.map(p => [p.id, p])), modules = new Map(this.modules.map(m => [m.id, m]));
    if (plates.size !== kept.plates.length || modules.size !== kept.modules.length) throw new Error('As peças salvas não são as dos projetos.');
    for (const { id, pose, ballisticGrid, marks, dents, perforations, wear: _wear, wearCount: _wearCount, ...state } of kept.plates) {
      const mesh = plates.get(id);
      if (!mesh) throw new Error('Chapa salva que o projeto não tem.');
      if (!sameGrid(ballisticGrid, mesh.ballisticGrid)) throw new Error('Construção salva de chapas que o projeto já não faz.');
      Object.assign(mesh.definition, pose);
      Object.assign(mesh.frame, { x: pose.x, y: pose.y, c: Math.cos(pose.angle), s: Math.sin(pose.angle) });
      mesh.ballisticGrid = ballisticGrid; mesh.damage.regions = gridRegions(ballisticGrid); mesh.damage.refresh(); mesh.refreshSpans();
      for (const key of PLATE_STATE) copyPlateField(mesh, state, key);
      if (state.originalArea !== undefined) { if (!finiteNumber(state.originalArea)) throw new TypeError('Invalid saved plate area.'); mesh.originalArea = state.originalArea; }
      Object.assign(mesh, { marks, dents: new Map(dents.map((dent, i) => [i, dent])), perforations });
      mesh.updateBounds();
    }
    for (const { id, suspension, ...state } of kept.modules) {
      const m = modules.get(id);
      if (!m) throw new Error('Componente salvo que o projeto não tem.');
      // What it weighs empty is what its design makes it weigh, however much it was weighed at when it was kept.
      if (!RESERVOIRS.includes(m.kind)) m.dryMass = m.physicalMass;
      for (const key of KEPT_MODULE_STATE) {
        const value = state[key]; if (value === undefined) continue;
        if (key === 'x' || key === 'y' || key === 'angle') {
          if (!finiteNumber(value)) throw new TypeError(`Invalid saved piece pose: ${key}.`); m[key] = value;
        } else if (key === 'barrelAngle') {
          if (!finiteNumber(value) || m.kind !== 'weapon') throw new TypeError('Invalid saved barrel angle.'); m.barrelAngle = value;
        } else copyModuleField(m, state, key);
      }
      // A tank keeps no more fuel than its design gives it room for now, and a box no more rounds.
      if (m.kind === 'fuel') m.fuelLitres = Math.min(m.fuelLitres, m.capacityLitres);
      if (m.kind === 'ammo') m.rounds = Math.min(m.rounds, m.capacityRounds);
      if (suspension) {
        if (!nativeSuspension(suspension) || m.kind !== 'wheel' && m.kind !== 'track') throw new TypeError('Invalid saved suspension.');
        Object.assign(m.suspension, suspension);
      }
    }
    Object.assign(this, { time: kept.time, tick: kept.tick, nextId: kept.nextId, stats: kept.stats });
    this.random.state = kept.randomState; this.dynamics!.recoveries = kept.recoveries;
    this.lay(normalRoads(kept.roads));
    this.rustGame = new RustGame(this, structuredClone(kept.tows || []));
  }
  playerWeapon(config: WeaponOverrides, actorId?: string | null): WeaponSettings {
    return fixedWeapon(
      config,
      this.modules.filter(part => part.actorId === this.actor(actorId)?.id),
    );
  }
  buildAssembly(actor: SceneActor): void {
    const plates = this.plates.filter(part => part.actorId === actor.id),
      modules = this.modules.filter(part => part.actorId === actor.id);
    const origin = actor.vehicle ? actor.vehicle.pose() : { x: 0, y: actor.y, angle: 0 };
    const lift = origin.y - VEHICLE_ORIGIN.y,
      // Its faces and mount lines are told in the frame of the construction, however it lies.
      placed = (point: Point): Point => ({ x: actor.x - origin.x + actor.mirror * (point.x - 12), y: point.y + lift - origin.y });
    actor.bodyPanels = actor.blueprint.bodyPanels.map(face => ({
      id: `${actor.id}:${actor.revision}:${face.id}`, actorId: actor.id,
      localPolygon: face.poly.map(placed), pose: origin,
    }));
    // Cold admission consumes enclosed rooms and the paid chassis sections once. The core retains immutable contact contours.
    const c = Math.cos(origin.angle), s = Math.sin(origin.angle);
    const volumes = [...actor.bodyPanels.map(face => face.localPolygon),
      ...(actor.blueprint.chassis?.outlines || []).map(poly => poly.map(placed))];
    actor.contactVolumes = volumes.map(poly => poly.map(p => ({
      x: origin.x + c * p.x - s * p.y, y: origin.y + s * p.x + c * p.y,
    })));
    for (const plate of plates) {
      plate.attached = true;
      plate.carrier = actor.vehicle;
    }
    for (const m of modules) {
      m.attached = true;
      // Its springs are its own, which the core writes into: not those of the design.
      if (m.suspension) m.suspension = { ...m.suspension };
    }
  }
  setTestDistance(distance = 0) {
    if (![0, 30, 60, 120, 250].includes(distance)) throw new Error('Distância de ensaio inválida.');
    this.testDistance = distance;
    const objects = [...this.blueprint.plates, ...this.blueprint.modules];
    const center = objects.length ? (Math.min(...objects.map(p => p.x)) + Math.max(...objects.map(p => p.x))) / 2 : 12;
    const x = center - distance;
    const raised = BATTLE_TERRAIN_IDS.includes(this.terrain.id);
    this.benchLauncher = distance || raised ? { x: distance ? x : this.blueprint.launcher.x,
      y: this.blueprint.launcher.y + this.terrain.height(distance ? x : this.blueprint.launcher.x) } : null;
    if (this.rustGame) this.rustGame.call({ op: 'configureLauncher',
      point: this.benchLauncher || this.blueprint.launcher });
  }
  launcher(settings: WeaponSettings, actor = this.actor()): Point | LiveModule | null {
    if (!actor) return null;
    if (settings.platform !== 'vehicle')
      return actor.id === 'local'
        ? this.benchLauncher || this.blueprint.launcher
        : {
            x: actor.x + actor.mirror * (actor.blueprint.launcher.x - 12),
            y: actor.blueprint.launcher.y,
          };
    return (
      this.modules.find(
        (m) =>
          m.actorId === actor.id &&
          m.kind === 'weapon' &&
          m.health > 0 &&
          !m.barrelDisabled &&
          m.attached !== false &&
          (!settings.componentId || settings.componentId === m.id),
      ) || null
    );
  }
  actorBounds(id: string): { minX: number; maxX: number; minY: number; maxY: number } {
    const points = this.plates.filter(p => p.actorId === id).flatMap(p => plateCorners(p.definition))
      .concat(this.modules.filter(m => m.actorId === id).flatMap(componentFootprintPolygons).flat());
    return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
      minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
  }
  // Publication reads synchronously and owns every module it retains: it is handed the pieces themselves, and what each
  // construction and plate of the state was read from, with what the core changed of them since (`SceneSources`).
  // Other snapshot readers keep their module copies.
  snapshot(): SceneSnapshot;
  snapshot<T>(read: (state: SceneSnapshot, sources: SceneSources) => T): T;
  snapshot<T>(read: ((state: SceneSnapshot, sources: SceneSources) => T) | null = null): SceneSnapshot | T {
    this.game().sync();
    const burning = new Set<string>();
    for (const module of this.modules) if (module.attached !== false && module.burning) burning.add(module.actorId);
    const state: SceneSnapshot = {
      time: this.time,
      tick: this.tick,
      name: this.blueprint.name,
      preset: this.blueprint.preset,
      terrain: this.terrain.id,
      terrainSettings: this.terrain.reference(),
      // The very list while the field lays no other: a frame tells it when it changes (network-protocol.ts).
      roads: this.roads,
      weather: this.scene.weather,
      appearance: this.blueprint.appearance || null,
      launcher: this.benchLauncher || this.blueprint.launcher,
      testDistance: this.testDistance,
      bodyPanels: this.actors.flatMap(a => a.bodyPanels!),
      actors: this.actors.map((a) => ({
        id: a.id,
        ownerId: a.ownerId,
        team: a.team,
        defeated: Boolean(a.defeated),
        burning: burning.has(a.id),
        // What the field keeps about a construction: a wreck's remaining time, a service under way.
        field: a.field || null,
        name: a.name,
        playerName: a.playerName,
        color: a.color,
        preset: a.blueprint.preset,
        appearance: a.blueprint.appearance || null,
        x: a.vehicle?.x ?? a.x,
        facing: a.facing,
        mirror: a.mirror,
        revision: a.revision,
        contactContours: a.contactContours,
        ...(a.vehicle ? { vehicle: a.vehicle.snapshot() } : { vehicle: null, y: a.y! }),
        cooldown: a.cooldown,
        aim: a.aim,
        weapon: a.weapon,
        eyes: a.eyes,
      })),
      plates: this.plates.map(p => p.snapshot()),
      // JSON metadata represents both signs of zero as 0. Normalize only the
      // snapshot field so local/full/compact frames agree without changing motion.
      modules: read ? this.modules : this.modules.map((m) => {
        const module = { ...m };
        if (m.wheelAngularSpeed === 0) module.wheelAngularSpeed = 0;
        return module;
      }),
      shots: this.shots,
      stats: { ...this.stats },
    };
    return read ? read(state, { changes: this.rustGame!, actors: this.actors, plates: this.plates }) : state;
  }
  command(op: string, options: object = {}): unknown { return this.game().call({ op, ...options }); }
  setTrigger(active: boolean, aim?: Point, config?: WeaponSettings, actorId?: string | null): unknown { return this.command('trigger', { active, aim, config, actorId }); }
  controlVehicle(throttle: number, brake?: number, actorId?: string | null): unknown { return this.command('control', { throttle, brake, actorId }); }
  aimWeapon(aim: Point, config: WeaponSettings, actorId?: string | null): unknown { return this.command('aim', { aim, config, actorId }); }
  fire(aim: Point, config: WeaponSettings, force = false, actorId?: string | null): unknown { return this.command('fire', { aim, config, force, actorId }); }
  // A quiet step tells this projection nothing but the clock: the host reads the scene
   // with `sync`, or with the frame a command brings, when something needs it.
  step(dt = FIXED_DT, { quiet = false } = {}) { return quiet ? this.game().advance(dt) : this.game().step(dt); }
  explode(x: number, y: number, power: number, radius: number, source: PlateMesh | LiveModule | string | null = null, details: Record<string, unknown> = {}): unknown {
    return this.command('explode', { point: { x, y }, power, radius, sourceOwner: this.game().handle(source), details });
  }
  cutBody<T extends PlateMesh | LiveModule>(body: T, start: Point, end: Point, radius: number): T[] {
    const game = this.game(), changed = game.call({ op: 'cut', owner: game.handle(body), start, end, radius });
    return changed ? [body] : [];
  }
}
