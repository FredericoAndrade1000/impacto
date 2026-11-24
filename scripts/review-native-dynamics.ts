import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { finiteWorld, permanentParts, partsPreserved, timing, mean } from './review-harness.ts';
import type { WorldOptions } from '../src/physics.ts';
import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { SceneActor } from '../src/scene-contract.ts';
import type { Vehicle } from '../src/vehicle.ts';
import type { Point } from '../src/math.ts';

export interface DynamicsCase {
  name: string; actors: number; exercise: 'drive' | 'ap' | 'internal-blast' | 'controls' | 'pass';
  blueprint: AuthoredConstruction; arena: AuthoredConstruction & { terrain: string }; steps: number;
  owners?: string[]; starts?: number[]; defeatedActor?: number;
}
export interface DynamicsRunOptions {
  warmup?: number; sampleEvery?: number;
  factory?: (blueprint: AuthoredConstruction, options: WorldOptions) => World | Promise<World>;
}
// Comparison consumes physical fields, not Native handles or all of a World.
// Other fields stay unknown until the metric that reads them checks its number.
export type DynamicsComparisonPart = Point & {
  angle: number; vx?: number; vy?: number; omega?: number;
} & Record<string, unknown>;
export interface DynamicsComparisonState {
  actors: DynamicsComparisonPart[]; plates: DynamicsComparisonPart[]; modules: DynamicsComparisonPart[];
  stats: Record<string, unknown>;
}
export interface DynamicsComparisonRow {
  name: string; steps: number; actors: number; exercise: string; terrain: string;
  finite: boolean; partsPreserved: boolean; recoveries: number; meanMs?: number; p95Ms?: number;
  frames: { step: number; state: DynamicsComparisonState }[];
}

const nativeBinary = new URL('../src/native/battle_dynamics_bg.wasm', import.meta.url);
const PARITY_TOLERANCE = Object.freeze({
  positionM: .02, velocityMps: .05, angleRad: .01, spinRadps: .1,
  massRelative: 1e-5, healthFraction: .02, areaRelative: .002, reserveRelative: 1e-4,
});

export async function prepareDynamics() {
  if (!existsSync(nativeBinary)) throw new Error('Rust dynamics binary is not built: src/native/battle_dynamics_bg.wasm');
  const { initNativeDynamics } = await import('../src/native-dynamics.ts');
  await initNativeDynamics();
}

export function dynamicsCases(steps = 240): DynamicsCase[] {
  const heavy = createConstruction('heavy'), arena = { ...createConstruction('empty'), seed: 6173, terrain: 'mixed' },
    exercises: readonly DynamicsCase['exercise'][] = ['drive', 'ap', 'internal-blast'],
    cases: DynamicsCase[] = [1, 6].flatMap(actors => exercises.map(exercise => ({
      name: `${actors}-${exercise}`, actors, exercise, blueprint: heavy, arena, steps,
    })));
  for (const terrain of ['flat', 'rough']) cases.push({ name: `scout-controls-${terrain}`, actors: 1,
    exercise: 'controls', blueprint: createConstruction('scout'), arena: { ...arena, terrain }, steps });
  return cases;
}

// These are accepted game states, with ordered part identity represented by its
// place in the construction. Native handles and generated UUID spelling are not outcomes.
function vehicleOf(actor: SceneActor): Vehicle {
  if (!actor.vehicle) throw new TypeError('A dynamics case requires a mobile actor.');
  return actor.vehicle;
}
function actorAt(world: World, index: number): SceneActor {
  const actor = world.actors[index];
  if (!actor) throw new TypeError(`A dynamics case requires actor ${index}.`);
  return actor;
}
export function dynamicsState(world: World) {
  const pose = (body: Point & { angle?: number; vx?: number; vy?: number; omega?: number }) => ({ x: body.x, y: body.y, angle: body.angle || 0,
    vx: body.vx || 0, vy: body.vy || 0, omega: body.omega || 0 });
  return {
    actors: world.actors.map(a => {
      const vehicle = vehicleOf(a);
      return { id: a.id, ...pose(vehicle), mass: vehicle.mass,
        fuel: vehicle.powertrain.fuelLitres, power: vehicle.availablePowerKw };
    }),
    plates: world.plates.map(p => ({ x: p.frame.x, y: p.frame.y, angle: Math.atan2(p.frame.s, p.frame.c),
      area: p.remainingArea, originalArea: p.definition.length * p.definition.thicknessMm / 1000,
      cells: p.activeIndices.length / 3, attached: p.attached !== false })),
    modules: world.modules.map(m => ({ ...pose(m), kind: m.kind, health: m.health / m.maxHealth,
      fuel: m.fuelLitres ?? 0, rounds: m.rounds ?? 0, barrelAngle: m.barrelAngle ?? 0,
      displacement: m.suspension?.displacement ?? 0, attached: m.attached !== false })),
    stats: { ...world.stats },
  };
}

export type DynamicsState = ReturnType<typeof dynamicsState>;

function intervene(world: World, item: DynamicsCase, step: number): void {
  // The first vehicle sent at the second and driven on: let go of, it would brake to a stop short of it.
  if (item.exercise === 'pass' && step === 0) {
    const actor = actorAt(world, 0);
    world.game().call({ op: 'setVehicleState', actorId: actor.id, state: { vx: 8 } });
    world.controlVehicle(1, 0, actor.id);
  }
  if (item.exercise === 'drive') for (const actor of world.actors) world.controlVehicle(.7, 0, actor.id);
  if (item.exercise === 'controls') {
    const phase = step / item.steps;
    world.controlVehicle(phase < .5 ? .8 : phase < .75 ? 0 : -.8, phase >= .5 && phase < .75 ? 1 : 0, actorAt(world, 0).id);
  }
  const vehicle = vehicleOf(actorAt(world, 0));
  if (step % 90 === 0 && item.exercise === 'ap') {
    // A real external test round, rather than an impossible mounted servo aim
    // into its own carrier. The normal muzzle/CCD/impulse path stays active.
    const actorId = actorAt(world, 0).id;
    world.game().call({ op: 'configureLauncher', actorId, point: { x: vehicle.x - 10, y: vehicle.y + .3 } });
    world.fire({ x: vehicle.x, y: vehicle.y + .3 },
      weaponSettings('cannon', { preset: 'rh120', platform: 'ground', spread: 0 }), true, actorId);
  }
  if (step % 90 === 0 && item.exercise === 'internal-blast') world.explode(vehicle.x, vehicle.y + .3, 600, 4.5);
}

export async function runDynamicsCase(item: DynamicsCase, { warmup = 60,
  sampleEvery = 15, factory = (blueprint, options) => new World(blueprint, options) }: DynamicsRunOptions = {}) {
  await prepareDynamics();
  const started = performance.now(), world = await factory(structuredClone(item.arena), {
    visualEvents: false,
  });
  try {
    world.removeActor('local');
    for (let i = 0; i < item.actors; i++) world.addActor(structuredClone(item.blueprint), {
      id: `vehicle-${i}`, ownerId: item.owners?.[i] ?? (i < 3 ? 'blue' : 'red'), x: item.starts?.[i] ?? 12 + i * 12,
    });
    for (let i = 0; i < warmup; i++) { world.step(); world.drainEvents(); }
    if (item.defeatedActor != null) {
      const actor = actorAt(world, item.defeatedActor), vehicle = vehicleOf(actor); actor.defeated = true;
      world.game().call({ op: 'control', actorId: actor.id,
        throttle: vehicle.throttle, brake: vehicle.brake, defeated: true });
    }
    const setupMs = performance.now() - started, initial = permanentParts(world), frames: { step: number; state: DynamicsState }[] = [],
      stepTimes: number[] = [], snapshotTimes: number[] = [], eventCounts: Record<string, number> = {};
    let finite = finiteWorld(world), preserved = partsPreserved(world, initial), maxSpeed = 0,
      maxRise = 0, maxVerticalSpeed = 0, maxSpin = 0;
    const groundOffset = world.actors.map(a => { const vehicle = vehicleOf(a); return vehicle.y - world.terrain.height(vehicle.x); });
    for (let step = 0; step < item.steps; step++) {
      const at = performance.now();
      intervene(world, item, step); world.step();
      stepTimes.push(performance.now() - at);
      for (const event of world.drainEvents()) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
      for (const [i, actor] of world.actors.entries()) {
        const v = vehicleOf(actor);
        maxSpeed = Math.max(maxSpeed, Math.hypot(v.vx, v.vy));
        maxVerticalSpeed = Math.max(maxVerticalSpeed, Math.abs(v.vy));
        maxSpin = Math.max(maxSpin, Math.abs(v.omega));
        maxRise = Math.max(maxRise, v.y - world.terrain.height(v.x) - Number(groundOffset[i]));
      }
      if (step % sampleEvery === 0 || step === item.steps - 1) {
        const snapshotAt = performance.now(); world.snapshot(); snapshotTimes.push(performance.now() - snapshotAt);
        frames.push({ step, state: dynamicsState(world) });
        finite &&= finiteWorld(world); preserved &&= partsPreserved(world, initial);
      }
    }
    const dynamics = world.dynamics;
    if (!dynamics) throw new TypeError('A dynamics case requires its active Native world.');
    return { name: item.name, backend: dynamics.backend, actors: item.actors, exercise: item.exercise,
      terrain: item.arena.terrain, steps: item.steps, setupMs, ...timing(stepTimes), snapshotMs: mean(snapshotTimes),
      finite, partsPreserved: preserved, recoveries: dynamics.recoveries || 0,
      peaks: { speedMps: maxSpeed, riseM: maxRise, verticalSpeedMps: maxVerticalSpeed, spinRadps: maxSpin },
      stats: { ...world.stats }, eventCounts, frames };
  } finally { world.dispose(); }
}

export type DynamicsRow = Awaited<ReturnType<typeof runDynamicsCase>>;

const angleError = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const relativeError = (a: number, b: number, floor = 1): number => Math.abs(a - b) / Math.max(floor, Math.abs(a), Math.abs(b));
const metric = (part: DynamicsComparisonPart, key: string): number => typeof part[key] === 'number' ? part[key] : NaN;

export function compareDynamicsRows(reference: DynamicsComparisonRow, candidate: DynamicsComparisonRow,
  tolerance: Readonly<Record<string, number>> = PARITY_TOLERANCE) {
  const errors: Record<string, number> = Object.fromEntries(Object.keys(tolerance).map(key => [key, 0])), mismatches = new Set<string>(),
    max = (name: string, value: number): void => { errors[name] = Math.max(Number(errors[name]), value); },
    pose = (a: DynamicsComparisonPart, b: DynamicsComparisonPart): void => {
      max('positionM', Math.hypot(a.x - b.x, a.y - b.y));
      max('velocityMps', Math.hypot((a.vx || 0) - (b.vx || 0), (a.vy || 0) - (b.vy || 0)));
      max('angleRad', angleError(a.angle, b.angle)); max('spinRadps', Math.abs((a.omega || 0) - (b.omega || 0)));
    };
  const scenarioKeys: readonly (keyof Pick<DynamicsComparisonRow, 'name' | 'steps' | 'actors' | 'exercise' | 'terrain'>)[] = ['name', 'steps', 'actors', 'exercise', 'terrain'];
  for (const key of scenarioKeys)
    if (reference[key] !== candidate[key]) mismatches.add(`scenario.${key}`);
  if (reference.frames.length !== candidate.frames.length) mismatches.add('frame-count');
  for (const [i, frame] of reference.frames.entries()) {
    const other = candidate.frames[i];
    if (!other || other.step !== frame.step) { mismatches.add('frame-step'); continue; }
    const a = frame.state, b = other.state;
    const groups: readonly ('actors' | 'plates' | 'modules')[] = ['actors', 'plates', 'modules'];
    for (const group of groups) {
      if (a[group].length !== b[group].length) mismatches.add(`${group}.count`);
      a[group].forEach((part, index) => {
        const next = b[group][index]; if (!next) return;
        pose(part, next);
        for (const key of ['id', 'kind', 'cells', 'attached', 'mounted'])
          if (part[key] !== next[key]) mismatches.add(`${group}.${key}`);
        if ('mass' in part) max('massRelative', relativeError(metric(part, 'mass'), metric(next, 'mass')));
        if ('area' in part) max('areaRelative', Math.abs(metric(part, 'area') - metric(next, 'area')) / Math.max(1e-8, metric(part, 'originalArea')));
        if ('health' in part) max('healthFraction', Math.abs(metric(part, 'health') - metric(next, 'health')));
        for (const key of ['fuel', 'rounds', 'power'])
          if (key in part) max('reserveRelative', relativeError(metric(part, key), metric(next, key)));
        if ('barrelAngle' in part) max('angleRad', angleError(metric(part, 'barrelAngle'), metric(next, 'barrelAngle')));
        if ('displacement' in part) max('positionM', Math.abs(metric(part, 'displacement') - metric(next, 'displacement')));
      });
    }
    for (const [key, value] of Object.entries(a.stats)) {
      if (!isDeepStrictEqual(value, b.stats[key])) mismatches.add(`stats.${key}`);
    }
  }
  const violations = Object.keys(errors).filter(key => !Number.isFinite(errors[key]) || Number(errors[key]) > Number(tolerance[key]));
  const stable = [reference, candidate].every(row => row.finite && row.partsPreserved && row.recoveries === 0);
  return { pass: stable && !violations.length && !mismatches.size, stable, errors, tolerance,
    violations, mismatches: [...mismatches], meanSpeedup: Number(reference.meanMs) / Math.max(1e-9, Number(candidate.meanMs)),
    p95Speedup: Number(reference.p95Ms) / Math.max(1e-9, Number(candidate.p95Ms)) };
}
