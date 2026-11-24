import assert from 'node:assert/strict';
import type { WorldOptions } from '../src/physics.ts';
import type { LiveModule, SceneEvent } from '../src/scene-contract.ts';
import type { PlateMesh } from '../src/mesh.ts';
import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { TemplateId } from '../src/construction-template-catalogue.ts';
import type { TerrainId } from '../src/terrain.ts';
import type { Point, LocalPoint } from '../src/math.ts';
import type { WeaponPresetId, AmmoId } from '../src/weapons.ts';
import type { VehicleSnapshot } from '../src/vehicle.ts';
import type { PhysicsStateProbe } from './review-harness.ts';
import { requireVehicle } from './review-harness.ts';

export interface DriveOptions {
  template?: TemplateId; terrain?: TerrainId; direction?: number; facing?: number; seconds?: number;
  action?: string | null; actionAt?: number; sampleEvery?: number;
}
export interface TrackEdgeOptions {
  point?: string | Point; preset?: WeaponPresetId; ammo?: AmmoId; settle?: number; burst?: boolean;
  seconds?: number | null; follow?: boolean; spread?: number; control?: boolean; trace?: boolean;
  prepareHole?: boolean; observe?: ((world: World, sample: ReturnType<typeof state>, step: number) => unknown) | null;
  launcher?: Point | null;
}
export interface LightWheelOptions {
  seed?: number; target?: string; throttle?: number; shots?: number; seconds?: number; terrain?: TerrainId;
  preset?: WeaponPresetId; ammo?: AmmoId; configureWorld?: (world: World) => unknown;
  diagnostic?: boolean; startSpeedKmh?: number;
}
import { face } from './damage-fixtures.ts';
import { NativeAudit, physicsState, partPhysics, actorPhysics, kineticEnergyOf, componentMaterialPoint } from './review-harness.ts';
// Bounded diagnostic probes; orchestration and case matrices live in review.ts/review-cases.ts.
import { mechanicalState, timing, indentationState, finiteWorld, advance, DamageProbe, permanentParts, partsPreserved, resetRestored } from './review-harness.ts';
import { World, FIXED_DT } from '../src/physics.ts';
import { weaponSettings, WEAPON_PRESETS } from '../src/weapons.ts';
import { snapshotVehicle } from './probes-impact.ts';
import { lightWheelBlueprint } from '../src/scenarios.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { componentPolygon, isRunningGear } from '../src/assembly.ts';
import { firingSolution, flightPoint } from '../src/ballistics.ts';
export { mechanicalState } from './review-harness.ts';

// Material UVs select distinct exposed parts of the currently admitted track: the lower half of its front curve, round
// its raised idler, which stands out under the sloped nose of the tub of its chassis (that nose covers the upper half),
// and the top of it under the hull, which a shot reaches only through the floor (`chassis-overlap`). Each of the
// curve is within the belt, below where the nose ends, round towards the run down to the road wheels.
// They are diagnostic inputs, never a second physical contour definition.
export const EDGE_POINTS = Object.freeze({
  'lower-neighbour': { u: .01, v: .556 },
  'image-marker': { u: .012, v: .515 },
  'middle-curve': { u: .017, v: .552 },
  'lower-curve': { u: .023, v: .578 },
  'lower-tip': { u: .029, v: .611 },
  'left-neighbour': { u: .019, v: .584 },
  'right-neighbour': { u: .028, v: .563 },
  'chassis-overlap': { u: .1, v: .12 },
});
const isEdgePoint = (point: string): point is keyof typeof EDGE_POINTS => Object.hasOwn(EDGE_POINTS, point);
const TRACK_EDGE_LAUNCHER = Object.freeze({ x: 1.65, y: .55 });
// At y=1.42 the long front-to-floor shot is grazing and the floor ricochets.
// This steeper bench chord deliberately tests a real primary floor passage.
const HULL_PASSAGE_LAUNCHER = Object.freeze({ x: 1.65, y: 3 });

function verticalFloorBench(world: World, track: LiveModule) {
  // Pick an unobstructed diagnostic column from current admitted hitboxes.
  // A retired absolute x can now cross a real barrel or equipment container.
  // These fixture rays select a bench intervention, never a pilot command.
  // The roof of the hull is every plate that closes its room from above,
  // the floor of a tower included.
  const floor = face(world, 'floor'),
    hull = world.blueprint.rooms.find(room => room.walls.some(wall => wall.id === floor.id));
  assert(hull, 'Track bench needs the authored floor room.');
  const roofs = hull.walls.filter(wall => wall.normal.y > .9).map(wall => world.plates.find(p => p.id === wall.id)),
    ceiling = Math.max(...world.plates.flatMap(p => p.nodes.map(n => n.y))) +
      weaponSettings('cannon', { preset: 'rh120' }).barrel + 2,
    bottom = Math.min(...componentPolygon(track).map(p => p.y)) - 1,
    groups: {i: number; uv: LocalPoint; aim: Point; roof: PlateMesh | LiveModule}[][] = [];
  for (let i = 0; i < 64; i++) {
    const uv = { u: (i + .5) / 64, v: .5 }, aim = componentMaterialPoint(track, uv),
      layers = world.index.raycastLayers({ x: aim.x, y: ceiling }, { x: aim.x, y: bottom }),
      roof = layers.find(hit => roofs.some(plate => plate === hit.owner.object))?.owner.object,
      clear = roof && layers.some(hit => hit.owner.object === floor) &&
        layers.some(hit => hit.owner.object === track) &&
        layers.every(hit => world.plates.some(plate => plate === hit.owner.object) || hit.owner.object === track);
    if (!clear) continue;
    const last = groups.at(-1);
    if (last?.at(-1)?.i === i - 1) last.push({ i, uv, aim, roof });
    else groups.push([{ i, uv, aim, roof }]);
  }
  const clear = groups.sort((a, b) => b.length - a.length || a[0]!.i - b[0]!.i)[0],
    selected = clear?.[Math.floor(clear.length / 2)];
  if (!selected) throw new Error('The admitted vehicle has no clear roof/floor/track diagnostic column');
  return { aim: selected.aim, launcher: { x: selected.aim.x, y: ceiling },
    selection: { kind: 'admitted-roof-floor-track-column', trackUV: selected.uv,
      roofId: selected.roof.id, floorId: floor.id, trackId: track.id } };
}

export function contactState(world: World) {
  const game = world.game(), name = (owner: number | null) => {
    const part = owner === null ? undefined : game.objects.get(owner);
    return !part ? 'ground' : world.plates.some(plate => plate === part) ? `plate-${world.plates.findIndex(plate => plate === part)}` :
      `component:${'kind' in part ? part.kind : part.material}`;
  };
  return physicsState(world, { contacts: true }).contactStates.map(c => ({ ...c,
    a: name(c.ownerA), b: name(c.ownerB) })).sort((a, b) => b.impulse - a.impulse);
}

function geometryState(world: World) {
  const track = world.modules.find(m => m.kind === 'track'), physics = physicsState(world);
  assert(track, 'Track review needs its installed track.');
  return { contactContours: structuredClone(world.actor()!.contactContours),
    track: { id: track.id, health: track.health, maxHealth: track.maxHealth, attached: track.attached !== false,
      beltCut: Boolean(track.beltCut), mass: track.physicalMass },
    plates: world.plates.map((p, i) => {
      const r = partPhysics(world, p, physics);
      return { i, id: p.id, attached: p.attached !== false, area: p.remainingArea, integrity: p.integrity,
        outlineTriangles: p.activeIndices.length / 3,
        ballisticGridCells: p.ballisticGrid ? p.ballisticGrid.nx * p.ballisticGrid.ny : 0,
        ballisticGridBytes: (p.ballisticGrid?.bits.length || 0) / 2,
        ballisticRegions: p.damage.regions.length,
        colliders: r?.colliders || 0 };
    }),
    runningGear: world.modules.filter(isRunningGear).map(m => ({ kind: m.kind, mass: m.physicalMass,
      health: m.health, grounded: Boolean(m.groundContact), wheelAngularSpeed: m.wheelAngularSpeed || 0 })) };
}

function state(world: World, details = false) {
  const v = requireVehicle(world), physics = physicsState(world), carrier = actorPhysics(world, 'local', physics);
  return { time: world.time, vehicle: { x: v.x, y: v.y, angle: v.angle,
    vx: v.vx, vy: v.vy, omega: v.omega, speed: Math.hypot(v.vx, v.vy) },
    carrier: { body: carrier?.handle, mass: carrier?.mass, inertia: carrier?.inertia },
    recoveries: physics.recoveries, ...mechanicalState(world, details, physics) };
}

export function runTrackEdge({ point = 'lower-curve', preset = 'rh120', ammo = 'ap',
  settle = 0, burst = false, seconds = null, follow = true, spread = 0,
  control = false, trace = false, prepareHole = false, observe = null, launcher = null }: TrackEdgeOptions = {}) {
  const config = weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo, spread }),
    blueprint = createConstruction('heavy');
  const world = new World(blueprint), track = world.modules.find(m => m.kind === 'track');
  assert(track, 'Track-edge review needs its installed track.');
  const floorBench = point === 'floor-passage' ? verticalFloorBench(world, track) : null,
    aim = floorBench?.aim || (typeof point === 'string' && isEdgePoint(point) ? componentMaterialPoint(track, EDGE_POINTS[point]) : point),
    configuredLauncher = { ...(launcher || floorBench?.launcher ||
      (point === 'chassis-overlap' ? HULL_PASSAGE_LAUNCHER : TRACK_EDGE_LAUNCHER)) },
    duration = seconds ?? (burst && config.rate < 20 ? 10.75 : burst ? 2 : 1.5),
    events: ReturnType<typeof identify>[] = [], impulses: Record<string, unknown>[] = [], samples: (ReturnType<typeof state> & {step: number})[] = [], preparationSamples: (ReturnType<typeof state> & {step: number})[] = [], traces: Record<string, unknown>[] = [], stepMs: number[] = [], parts = permanentParts(world);
  let inputKineticJ = 0, firedPx = 0, firedPy = 0, step = 0, nativeSubstep = 0,
    manualMuzzlesPending = 0, accountedShots = 0,
    thrown: string | null = null, peakContacts: ReturnType<typeof contactState> = [], peakGeometry: ReturnType<typeof geometryState> | null = null, aperture: Record<string, unknown> | null = null, invalidSolves = 0;
  if (!aim || typeof aim === 'string' || !Number.isFinite(aim.x) || !Number.isFinite(aim.y)) {
    world.dispose();throw new Error('Track-edge point must be a known name or a finite world point');
  }
  const initialPose = requireVehicle(world).pose(),
    dx = aim.x - initialPose.x, dy = aim.y - initialPose.y,
    initialCos = Math.cos(initialPose.angle), initialSin = Math.sin(initialPose.angle),
    localAim = { x: initialCos * dx + initialSin * dy, y: -initialSin * dx + initialCos * dy },
    authoredPlateIds = world.plates.map(p => p.id),
    wallIds = Object.fromEntries(['floor', 'front', 'roof', 'rear'].map(role => {
      const matches = role === 'floor' ? [face(world, role)] : world.plates.filter(p => p.id.endsWith('hull:' + role));
      return [role, matches.length === 1 ? matches[0]!.id : null];
    }));
  const peaks = { kineticJ: 0, carrierKineticJ: 0, speed: 0, y: initialPose.y,
    absVy: 0, preNativeKineticJ: 0, postNativeKineticJ: 0,
    plateDisplacement: 0, contactImpulse: 0, localDentMeters: 0, dentLimitRatio: 0 };
  const currentAim = () => {
    if (!follow) return aim;
    const c = Math.cos(requireVehicle(world).angle), s = Math.sin(requireVehicle(world).angle);
    return { x: requireVehicle(world).x + c * localAim.x - s * localAim.y,
      y: requireVehicle(world).y + s * localAim.x + c * localAim.y };
  };
  const identify = (e: SceneEvent) => ({ ...e, plate: world.plates.findIndex(p => p.id === e.id),
    plateId: world.plates.find(p => p.id === e.id)?.id ?? null,
    module: world.modules.find(m => m.id === e.id)?.kind,
    moduleId: world.modules.find(m => m.id === e.id)?.id ?? null });
  const materialLayers = () => {
    // Use the exact point admitted by configureLauncher, also for the chord
    // query. The bench does not read the launcher written in the blueprint.
    const solution = firingSolution(configuredLauncher, currentAim(), config),
      start = { x: solution.x, y: solution.y }, end = flightPoint(solution, FIXED_DT);
    return world.index.raycastLayers(start, end).map(hit => ({
      plate: world.plates.findIndex(plate => plate === hit.owner.object),
      plateId: world.plates.some(plate => plate === hit.owner.object) ? hit.owner.object.id : null,
      module: 'kind' in hit.owner.object ? hit.owner.object.kind : undefined, moduleId: 'kind' in hit.owner.object && hit.owner.object.kind ? hit.owner.object.id : null,
      point: { x: hit.x, y: hit.y }, exit: { x: hit.exitX, y: hit.exitY }, depth: hit.depth }));
  };
  const originalFire = world.fire;
  world.fire = function(...args) {
    const out = originalFire.apply(this, args);
    if (out) {
      const p = this.projectiles.at(-1);
      assert(p && p.mass !== undefined, 'Accepted manual shot needs its born projectile mass.');
      inputKineticJ += p.mass * (p.vx ** 2 + p.vy ** 2) / 2;
      firedPx += p.mass * p.vx; firedPy += p.mass * p.vy;
      manualMuzzlesPending++;accountedShots++;
    }
    return out;
  };
  const accountMuzzles = (frameEvents: readonly SceneEvent[]) => {
    for (const event of frameEvents.filter(e=>e.type==='muzzle')) {
      if (manualMuzzlesPending>0) {manualMuzzlesPending--;continue;}
      // Held fire is born insideRust rather than through the World.fire hook.
      // This fixed bench has no inherited motion. Numeric charge is exact;
      // automatic charge uses the admitted maximum as a conservative bound.
      const charge=typeof config.charge==='number'?config.charge:1,
        speed=config.speed*Math.sqrt(charge);
      inputKineticJ+=config.mass*speed*speed/2;
      firedPx+=config.mass*speed*Math.cos(event.angle);
      firedPy+=config.mass*speed*Math.sin(event.angle);accountedShots++;
    }
  };
  let nativeBefore: ReturnType<typeof state> | undefined;
  const audit = new NativeAudit(world, { beforeStep() { nativeBefore = state(world, trace); }, onStep({ nativeEnergy }) {
    const before = nativeBefore, after = state(world, trace);
    assert(before, 'Native beforeStep observation must precede onStep.'); nativeSubstep++;
    const invalid = nativeEnergy.last?.invalid;
    if (!Number.isSafeInteger(invalid) || invalid < 0)
      throw new Error('Native energy audit must include a nonnegative integer last.invalid code');
    invalidSolves += Number(invalid !== 0);
    peaks.preNativeKineticJ = Math.max(peaks.preNativeKineticJ, before.kineticJ);
    peaks.postNativeKineticJ = Math.max(peaks.postNativeKineticJ, after.kineticJ);
    if (trace && (nativeSubstep <= 48 || before.kineticJ > 500_000 || after.kineticJ > 500_000))
      traces.push({ substep: nativeSubstep, before, after, solver: physicsState(world).energy,
        contacts: contactState(world), geometry: geometryState(world) });
  } });
  const collectPeaks = (now: ReturnType<typeof state>) => {
    const dent = indentationState(world);
    for (const key of ['localDentMeters', 'dentLimitRatio'] as const) peaks[key] = Math.max(peaks[key], dent[key]);
    if (now.kineticJ > peaks.kineticJ) {
      peaks.kineticJ = now.kineticJ; peakContacts = contactState(world);
      peakGeometry = geometryState(world);
      peaks.contactImpulse = Math.max(peaks.contactImpulse,
        peakContacts.reduce((sum, contact) => sum + contact.impulse, 0));
    }
    peaks.speed = Math.max(peaks.speed, now.vehicle.speed);
    peaks.absVy = Math.max(peaks.absVy, Math.abs(now.vehicle.vy));
    peaks.y = Math.max(peaks.y, now.vehicle.y);
    const physics = physicsState(world), body = actorPhysics(world, 'local', physics);
    peaks.carrierKineticJ = Math.max(peaks.carrierKineticJ, body ? kineticEnergyOf([body]) : 0);
    for (const p of snapshotVehicle(world).plates) {
      peaks.plateDisplacement = Math.max(peaks.plateDisplacement, p.maxDisplacement);
    }
  };
  try {
    for (const [role, id] of Object.entries(wallIds))
      if (id === null) throw new Error(`Expected one admitted hull wall for ${role}`);
    if (world.game().call({ op: 'configureLauncher', point: configuredLauncher }) !== true)
      throw new Error('Track-edge bench launcher admission failed');
    advance(world, settle); nativeSubstep = 0; traces.length = 0;
    const start = state(world), startGeometry = geometryState(world), initialMaterialLayers = materialLayers();
    // Height starts at the measured intervention boundary, not the retired
    // 1.3 m origin. The initial settled sample is part of the peak measurement.
    peaks.y = start.vehicle.y; collectPeaks(start);
    if (prepareHole) {
      world.fire(currentAim(), weaponSettings('cannon', { preset: 'rh120', ammo: 'ap', spread: 0 }), true);
      // A same-cannon follow-up honours its ten-second reload. Switching
      // weapon families resets the bench cooldown through World.fire.
      const coolingSteps = preset === 'rh120' ? Math.ceil(60 * 60 / config.rate) : 90;
      for (let i = 0; i < coolingSteps; i++) {
        world.step(); const frameEvents=world.drainEvents();accountMuzzles(frameEvents);
        events.push(...frameEvents.map(identify));
        const now = state(world); collectPeaks(now);
        if (i < 4 || i % 30 === 29) preparationSamples.push({ step: i + 1, ...now });
      }
      aperture = { state: state(world), geometry: geometryState(world),
        materialLayers: materialLayers(), events: events.filter(e => e.type === 'penetration' ||
          e.type === 'secondary-impact' && e.result === 'penetration') };
      nativeSubstep = 0;
    }
    if (!control) {
      if (burst) world.setTrigger(true, currentAim(), config);
      else world.fire(currentAim(), config, true);
    }
    advance(world, Math.round(duration * 60), { samples: stepMs, before() {
      if (burst && follow) world.setTrigger(true, currentAim(), config);
    }, after(i, w, frameEvents) {
      step = i; events.push(...frameEvents.map(identify));
      accountMuzzles(frameEvents);
      impulses.push(...frameEvents.filter(e => Number.isFinite(e.impulse)).map(e => ({ time: world.time,
        owner: e.owner, point: { x: e.x, y: e.y }, magnitude: e.impulse })));
      const now = state(world); collectPeaks(now);
      if (step < 4 || step % 30 === 29) samples.push({ step: step + 1, ...now });
      if (observe) observe(world, now, step);
      if (!finiteWorld(world) || !partsPreserved(world, parts) || peaks.dentLimitRatio > 1 + 1e-6 || now.kineticJ > 1e10 || now.vehicle.speed > 300) {
        thrown = 'non-finite state or catastrophic physical divergence'; return false;
      }
    } });
    world.setTrigger(false);

    return { point, aim, preset, ammo: config.ammo, settle, burst, follow,
      seconds: duration, seed: blueprint.seed, launcher: configuredLauncher,
      benchSelection: floorBench?.selection || null,
      aimReference: { kind: 'admitted-pose', initialPose, localAim,
        coordinates: floorBench ? 'admitted-roof-floor-track-column' :
          typeof point === 'string' ? 'admitted-track-material-uv' : 'explicit-world-point' },
      construction: structuredClone(blueprint),
      authoredPlateIds, wallIds,
      control, prepareHole, config: { mass: config.mass, speed: config.speed, rate: config.rate,
        power: config.power, caliberMm: config.caliberMm },
      shots: world.stats.shots, accountedShots, stats: { ...world.stats }, inputKineticJ,
      launchEnergyAccounting:'manual-born-projectile plus native-muzzle-trigger; auto charge is an upper bound',
      firedImpulse: { x: firedPx, y: firedPy }, start, startGeometry,
      end: state(world), endGeometry: geometryState(world), peaks, partsPreserved: partsPreserved(world, parts),
      initialMaterialLayers, endMaterialLayers: materialLayers(), invalidSolves,
      peakContacts, peakGeometry, aperture, impulses, samples, preparationSamples, traces, events, thrown,
      timingIncludesInstrumentation: true, ...timing(stepMs) };
  } finally { audit.close(); world.dispose(); }
}

// light-wheel
const storedMechanicalEnergy = (physics: PhysicsStateProbe) => physics.energyStoredJ.total;

export function probeLightWheel({ seed = 1, target = 'wheel-upper', throttle = 0,
  shots = 1, seconds = 5, terrain = 'flat', preset = 'rh120', ammo = 'ap',
  configureWorld, diagnostic = false, startSpeedKmh = 9.6 }: LightWheelOptions = {}) {
  const blueprint = lightWheelBlueprint(); blueprint.seed = seed; blueprint.terrain = terrain;
  const world = new World(blueprint), config = weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo, spread: 0 }),
    events: SceneEvent[] = [], trace: Record<string, unknown>[] = [], impulses: Record<string, unknown>[] = [], peaks = { speed: 0, clearance: 0, energy: 0, wheelOmega: 0,
      solverGrowth: 0, passiveGrowth: 0 };
  let audit: NativeAudit | undefined;
  let stage = 'settling', thrown: {stage: string; message: unknown; stack?: unknown} | null = null, start: (VehicleSnapshot & {energy: number; mass: number}) | undefined, end: VehicleSnapshot | undefined, recoveries = 0, quietEnergy: number | null = null, quietFrames = 0, preserved = true;
  try {
    configureWorld?.(world);
    const parts = permanentParts(world);
    for (let i = 0; i < 60; i++) { world.step(); world.drainEvents(); }
    world.controlVehicle(throttle);
    for (let i = 0; throttle && i < 240 && Math.abs(requireVehicle(world).vx) * 3.6 < startSpeedKmh; i++) {
      world.step(); world.drainEvents();
    }
    const wheel = world.modules.find(m => m.kind === 'wheel'), engine = world.modules.find(m => m.kind === 'engine'),
      initialY = requireVehicle(world).y - world.terrain.height(requireVehicle(world).x),
      initialMotion = physicsState(world);
    assert(wheel && engine, 'Light-wheel review needs its wheel and engine.');
    start = { ...requireVehicle(world).snapshot(), energy: kineticEnergyOf(initialMotion.bodyStates),
      mass: requireVehicle(world).mass, fuelLitres: requireVehicle(world).fuelLitres };
    world.controlVehicle(0);
    if (diagnostic) audit = new NativeAudit(world, { onStep({ before, afterEnergy, nativeEnergy }) {
      peaks.solverGrowth = Math.max(peaks.solverGrowth, nativeEnergy?.maxGrowth.growth ?? afterEnergy - before.energy);
      if (afterEnergy > before.energy * 1.5 + 1000) trace.push({ stage: 'native', time: world.time,
        before: before.energy, after: afterEnergy });
    } });
    stage = 'firing';
    for (let frame = 0; frame < seconds * 60; frame++) {
      if (frame % 4 === 0 && world.stats.shots < shots) {
        const origin = componentMaterialPoint(target === 'engine' ? engine : wheel, { u: .5, v: .5 }),
          aim = target === 'front-slope' ? { x: origin.x + .15, y: origin.y + 1.05 } :
            target === 'engine' ? origin : { x: origin.x - wheel.width * .30,
              y: origin.y + wheel.height * (target === 'wheel-lower' ? -.30 : .30) };
        world.fire(aim, config, true);
      }
      world.step();
      const frameEvents = world.drainEvents().filter(e => ['module', 'explosion', 'penetration', 'blocked'].includes(e.type));
      events.push(...frameEvents);
      for (const e of frameEvents) if (Number.isFinite(e.impulse)) {
        // GameState resolves CCD and applies this measured resultant inside
        // Rust. Read its physical event rather than a dormant JS interceptor.
        const part = e.owner == null ? undefined : world.game().objects.get(e.owner);
        impulses.push({time:world.time,type:part && 'mesh' in part && part.mesh ? 'fragment' : 'plate',
          kind:part && ('componentKind' in part && part.componentKind || 'kind' in part && part.kind || undefined),magnitude:e.impulse});
      }
      preserved &&= partsPreserved(world, parts);
      const v = requireVehicle(world), motion = physicsState(world), energy = kineticEnergyOf(motion.bodyStates),
        gear = world.modules.filter(m => m.kind === 'wheel'), totalEnergy = storedMechanicalEnergy(motion),
        loadsEnded = world.stats.shots === shots && !world.projectiles.length &&
          !frameEvents.some(e => e.type === 'explosion');
      // Projectiles run after the native solve. Let the next frame integrate
      // the last shot's or cook-off's pending impulses before measuring passive energy.
      // Burning itself carries no impulse and can outlast this observation window.
      quietFrames = loadsEnded ? quietFrames + 1 : 0;
      const quiet = quietFrames > 1;
      if (!quiet) quietEnergy = null;
      else { quietEnergy ??= totalEnergy; peaks.passiveGrowth = Math.max(peaks.passiveGrowth, totalEnergy - quietEnergy); }
      peaks.speed = Math.max(peaks.speed, Math.hypot(v.vx, v.vy)); peaks.energy = Math.max(peaks.energy, energy);
      peaks.clearance = Math.max(peaks.clearance, v.y - world.terrain.height(v.x) - initialY);
      peaks.wheelOmega = Math.max(peaks.wheelOmega, ...gear.map(m => Math.abs(m.wheelAngularSpeed || 0)));
      if (diagnostic || frame % 30 === 0) trace.push({ time: world.time, vx: v.vx, vy: v.vy, energy,
        totalEnergy, quiet, enginePower: v.availablePowerKw, wheelOmega: gear.map(m => m.wheelAngularSpeed || 0), recoveries: world.dynamics?.recoveries || 0 });
      if (!preserved || !Number.isFinite(energy + peaks.speed) || peaks.speed > 40 || peaks.clearance > 10) break;
    }
    end = requireVehicle(world).snapshot();
  } catch (error) { thrown = { stage, message: error instanceof Error ? error.message : undefined, stack: error instanceof Error ? error.stack : undefined }; }
  finally {
    audit?.close();
    recoveries = world.dynamics?.recoveries || 0;
    try { world.dispose(); } catch (error) { thrown ??= { stage: 'dispose', message: error instanceof Error ? error.message : undefined }; }
  }
  return { seed, target, throttle, shots, terrain, preset, ammo, start, end, peaks, partsPreserved: preserved, thrown,
    stats: { ...world.stats }, recoveries, impulses, events, trace };
}

// terrain
// `facing` is the way the vehicle looks when it sets off, to the left as it stands at first: driven `direction` the
// other way, it backs. Reset, it stands as it did at first.
export function reviewDrive({ template = 'heavy', terrain = 'hills', direction = 1, facing = -1,
  seconds = 12, action = null, actionAt = 4, sampleEvery = 30 }: DriveOptions = {}) {
  const blueprint = createConstruction(template); blueprint.terrain = terrain;
  const world = new World(blueprint), original = JSON.stringify(world.blueprint), samples: (VehicleSnapshot & {time: number; gears: {kind: string; health: number; x: number; y: number; angle: number; grounded: boolean; attached: boolean}[]})[] = [], initial = permanentParts(world);
  if (facing !== world.actor('local')!.facing) world.turnActor('local');
  const peaks = { speed: 0, height: 0, angle: 0, groundPenetration: 0, kineticJ: 0 };
  let actionSpeed: number | undefined, actionX: number | undefined, actionTime: number | undefined, acted = false;
  try {
    advance(world, 30); const start = requireVehicle(world).pose(); world.controlVehicle(direction);
    const probe = new DamageProbe(world, { peaks, limits: { speed: 50, kineticJ: 1e10 } });
    probe.run(Math.round(seconds * 60), { before(i) {
      if (action && !acted && i >= actionAt * 60) {
        acted = true; actionSpeed = Math.hypot(requireVehicle(world).vx, requireVehicle(world).vy); actionX = requireVehicle(world).x; actionTime = world.time;
        if (action === 'brake') world.controlVehicle(0, 1);
        if (action === 'release') world.controlVehicle(0);
        const fail = (m: LiveModule | undefined) => world.command('setPartState', { owner: world.game().handle(m), state: { health: 0 } });
        if (action === 'engine') fail(world.modules.find(m => m.kind === 'engine'));
        if (action === 'gear') world.modules.filter(isRunningGear).forEach(fail);
        if (action === 'blast') {
          const m = world.modules.find(isRunningGear), p = componentPolygon(m!).reduce((a, b) => a.x < b.x ? a : b);
          world.explode(p.x - .18, p.y, 410, 5.2, 'validation');
        }
      }
    }, after(i) {
      const body = requireVehicle(world);
      peaks.height = Math.max(peaks.height, body.y);
      for (const m of world.modules.filter(isRunningGear)) {
        const polygon = componentPolygon(m);
        peaks.groundPenetration = Math.max(peaks.groundPenetration, ...polygon.map(p => world.terrain.height(p.x) - p.y));
      }
      if (i % sampleEvery === 0 || i === seconds * 60 - 1) samples.push({ time: world.time, ...body.snapshot(),
        gears: world.modules.filter(isRunningGear).map(m => ({ kind: m.kind, health: m.health / m.maxHealth,
          x: m.x, y: m.y, angle: m.angle, grounded: !!m.groundContact, attached: m.attached !== false })) });
    } });
    const row = { template, terrain, direction, action, seconds, start, end: requireVehicle(world).snapshot(), peaks,
      actionSpeed, actionX, actionTime, retained: world.plates.map(p => p.integrity),
      originalUnchanged: original === JSON.stringify(world.blueprint), partsPreserved: probe.partsPreserved, recoveries: world.dynamics?.recoveries || 0,
      stats: { ...world.stats }, samples, meanPhysicsMs: probe.timing().meanMs };
    return { ...row, restored: resetRestored(world, initial) && requireVehicle(world).x === 12 && requireVehicle(world).vx === 0 };
  } finally { world.dispose(); }
}

// environment
export function environmentDrive(options: DriveOptions = {}) {
  const row = reviewDrive({ seconds: 12, ...options });
  const surfaces: Record<string, {x: number; speedKmh: number; pressureKPa: number; resistance: number}[]> = {};
  for (const sample of row.samples) {
    if (!sample.groundSurface) continue;
    const list = surfaces[sample.groundSurface] ||= [];
    list.push({ x: sample.x, speedKmh: Math.hypot(sample.vx, sample.vy) * 3.6,
      pressureKPa: sample.groundPressureKPa, resistance: sample.groundResistance });
  }
  return { ...row, surfaces };
}

// armored-revision
export function driveTrial(blueprint: AuthoredConstruction, { terrain = 'hills', side = 1, seconds = 30, distance = 80 }: {terrain?: TerrainId; side?: number; seconds?: number; distance?: number} = {}) {
  const world = new World({ ...createConstruction('empty'), terrain, seed: 6173 }, { visualEvents: false });
  try {
    world.removeActor('local'); world.bounds = { minX: -300, maxX: 324 };
    const actor = world.addActor(blueprint, { id: 'local', x: 12 + side * 120, facing: -side, ownerId: 'local' });
    world.vehicle = actor.vehicle;
    for (let i = 0; i < 60; i++) world.step();
    const v = actor.vehicle; assert(v, 'Drive trial needs its authored vehicle.');
    const start = v.pose(), original = JSON.stringify(blueprint), samples: {elapsed: number; x: number; y: number; speedKmh: number; traction: number | undefined; surface: string | null | undefined; pressureKPa: number | undefined}[] = [],
      peaks = { speedKmh: 0, clearance: 0, angleDegrees: 0 };
    let reachedAt: number | null = null, progress = 0, steps = 0;
    world.controlVehicle(-side);
    while (steps < seconds * 60 && (reachedAt === null || steps * FIXED_DT < reachedAt + 3)) {
      world.step(); steps++;
      progress = Math.max(progress, (v.x - start.x) * -side);
      peaks.speedKmh = Math.max(peaks.speedKmh, Math.hypot(v.vx, v.vy) * 3.6);
      peaks.clearance = Math.max(peaks.clearance, v.y - world.terrain.height(v.x));
      peaks.angleDegrees = Math.max(peaks.angleDegrees, Math.abs(v.angle) * 180 / Math.PI);
      if (reachedAt === null && progress >= distance) { reachedAt = steps * FIXED_DT; world.controlVehicle(0, 1); }
      if (steps % 60 === 0) samples.push({ elapsed: steps * FIXED_DT, x: v.x, y: v.y,
        speedKmh: Math.hypot(v.vx, v.vy) * 3.6, traction: v.traction,
        surface: v.groundSurface, pressureKPa: v.groundPressureKPa });
      if (world.dynamics?.recoveries || !Number.isFinite(v.x + v.y + v.vx + v.vy) ||
          peaks.speedKmh > 324 || peaks.clearance > 25) break;
    }
    const status = world.dynamics?.recoveries || !Number.isFinite(v.x + v.y + v.vx + v.vy) ||
      peaks.speedKmh > 324 || peaks.clearance > 25 ? 'invalid' : 'finished';
    return { status, terrain, side, elapsed: steps * FIXED_DT, targetDistance: distance, progressMetres: progress,
      reachedAt, start, end: v.snapshot(), peaks, recoveries: world.dynamics?.recoveries || 0,
      allAttached: world.modules.every(m => m.attached !== false), originalUnchanged: original === JSON.stringify(blueprint), samples };
  } finally { world.dispose(); }
}
