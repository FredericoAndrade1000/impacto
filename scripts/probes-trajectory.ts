import assert from 'node:assert/strict';
import type { SceneEvent } from '../src/scene-contract.ts';
import type { Point } from '../src/math.ts';
import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { TemplateId } from '../src/construction-template-catalogue.ts';
import type { TerrainId } from '../src/terrain.ts';
import type { SensorMode } from '../src/combat-sensors.ts';
import { requireVehicle } from './review-harness.ts';
import { NativeAudit } from './review-harness.ts';
// Bounded diagnostic probes; orchestration and case matrices live in review.ts/review-cases.ts.
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { Random } from '../src/math.ts';
import { lightRoofBlueprint,vehicleRoof } from '../src/scenarios.ts';
import { weaponSettings } from '../src/weapons.ts';
import { firingSolution } from '../src/ballistics.ts';
import { DamageProbe, advance, permanentParts, partsPreserved, finiteWorld, physicsState, kineticEnergyOf, installedModuleMass } from './review-harness.ts';


// blast-launch
export function probeBlastLaunch({ model = 'scout', seed = 1, location = 'front-wheel',
  power = 410, radius = 5.2, terrain = 'flat', throttle = 0, repeats = 1,
  seconds = 4, diagnostic = false, configureWorld }: {model?: TemplateId; seed?: number; location?: string; power?: number; radius?: number; terrain?: TerrainId; throttle?: number; repeats?: number; seconds?: number; diagnostic?: boolean; configureWorld?: (world: World) => unknown} = {}) {
  const blueprint = createConstruction(model); blueprint.seed = seed; blueprint.terrain = terrain;
  const world = new World(blueprint), random = new Random(seed), trace: Record<string, unknown>[] = [], native: Record<string, unknown>[] = [];
  const audit = diagnostic ? new NativeAudit(world, {
    onStep({ before, afterEnergy, audit }) {
      if (afterEnergy > before.energy * 2 + 100 || !Number.isFinite(afterEnergy))
        native.push({ time: world.time, before: before.energy, after: afterEnergy, rigid: audit.bodies(before) });
    },
    onRecover({ restored, audit }) {
      native.push({ stage: 'restored', time: world.time, energy: kineticEnergyOf(restored.bodyStates), rigid: audit.bodies(restored) });
    },
  }) : null;
  try {
    configureWorld?.(world);
    const parts = permanentParts(world); let preserved = true, finite = true;
    world.controlVehicle(throttle);
    for (let i = 0; i < (throttle ? 120 : 60); i++) { world.step(); world.drainEvents(); }
    const start = requireVehicle(world).pose(), initialClearance = start.y - world.terrain.height(start.x),
      peaks = { lift: 0, clearance: 0, speed: 0, verticalSpeed: 0, omega: 0, energy: 0 },
      gear = world.modules.filter(m => ['wheel', 'track'].includes(m.kind)).sort((a,b) => a.x-b.x),
      reference = location === 'rear-wheel' ? gear.at(-1) : location === 'front-wheel' ? gear[0] :
        world.modules.find(m => m.kind === (location === 'fuel' ? 'fuel' : 'engine'));
    assert(reference, 'Blast-launch review needs its target component.');
    let origin = { x: reference.x, y: reference.y };
    if (location.includes('wheel')) origin = { x: reference.x - reference.width / 2 - random.range(.02, .2),
      y: reference.y + random.range(-reference.height * .42, reference.height * .42) };
    if (location === 'roof') origin = { x: start.x + random.range(-1.5, 1.5),
      y: Math.max(...world.plates.map(p => p.bounds.maxY)) + random.range(.02, .2) };
    origin.y = Math.max(world.terrain.height(origin.x) + .03, origin.y);
    const begin = world.time;
    world.explode(origin.x, origin.y, power, radius, 'launch-review');
    for (let i = 0; i < seconds * 60; i++) {
      if (i > 0 && i % 60 === 0 && i / 60 < repeats)
        world.explode(origin.x, origin.y, power, radius, 'launch-review');
      world.step(); world.drainEvents();
      preserved &&= partsPreserved(world, parts); finite &&= finiteWorld(world);
      const v = requireVehicle(world), state = physicsState(world), energy = kineticEnergyOf(state.bodyStates);
      peaks.lift = Math.max(peaks.lift, v.y - start.y); peaks.speed = Math.max(peaks.speed, Math.hypot(v.vx, v.vy));
      peaks.verticalSpeed = Math.max(peaks.verticalSpeed, Math.abs(v.vy));
      peaks.clearance = Math.max(peaks.clearance, v.y - world.terrain.height(v.x) - initialClearance);
      peaks.omega = Math.max(peaks.omega, Math.abs(v.omega)); peaks.energy = Math.max(peaks.energy, energy);
      if (diagnostic || i % 30 === 0 || peaks.speed > 8) trace.push({ time: world.time - begin, x: v.x, y: v.y,
        vx: v.vx, vy: v.vy, angle: v.angle, omega: v.omega, energy, mass: v.mass,
        carriers: state.bodyStates.filter(b => b.dynamic).map(b => b.mass),
        recoveries: world.dynamics?.recoveries || 0 });
      if (!preserved || !finite || !Number.isFinite(peaks.energy + peaks.speed) || peaks.speed > 40 || peaks.lift > 10) break;
    }
    return { model, seed, location, power, radius, terrain, throttle, repeats, origin, start, peaks,
      stats: { ...world.stats }, partsPreserved: preserved, finite, recoveries: world.dynamics?.recoveries || 0, lastRecovery: world.dynamics && 'lastRecovery' in world.dynamics ? world.dynamics.lastRecovery : undefined,
      modules: world.modules.map(m => ({ kind: m.kind, health: m.health / m.maxHealth, attached: m.attached !== false })), trace, native };
  } finally { audit?.close(); world.dispose(); }
}

// mortar-light
export function mortarReviewBlueprint(model: TemplateId | 'four-wheel' = 'four-wheel') {
  return model === 'four-wheel' ? lightRoofBlueprint() : createConstruction(model);
}

export function probeMortarRoof({ model = 'four-wheel', seed = 1, distance = 0,
  salvos = 3, offset = 0, terrain = 'flat', spread = 0, aftermath = 4,
  blueprint = mortarReviewBlueprint(model), targetSensor = null, configureWorld }: {model?: TemplateId | 'four-wheel'; seed?: number; distance?: number; salvos?: number; offset?: number; terrain?: TerrainId; spread?: number; aftermath?: number; blueprint?: AuthoredConstruction; targetSensor?: SensorMode | null; configureWorld?: (world: World) => unknown} = {}) {
  blueprint.seed = seed; blueprint.terrain = terrain;
  const world = new World(blueprint), config = weaponSettings('mortar', {
    preset: 'm252', ammo: 'he', trajectory: 'high', spread, detonation: 'impact' }),
    events: (SceneEvent & {salvo: number; sinceShot: number})[] = [], trace: Record<string, unknown>[] = [], shots: {accepted: unknown; aim: Point; targetId: string; flight: number}[] = [], peaks = { clearance: 0, verticalSpeed: 0,
      speed: 0, omega: 0, energy: 0 },
    roofDefinition=vehicleRoof(world).definition;
  try {
    configureWorld?.(world);
    advance(world, 60);
    world.setTestDistance(distance);
    const carrierMass = () => physicsState(world).bodyStates.filter(body => body.dynamic).reduce((sum, body) => sum + body.mass, 0),
      carrierMassBefore = carrierMass(), structureMassBefore = carrierMassBefore - installedModuleMass(world), begin = world.time, probe = new DamageProbe(world, { peaks, geometry: false,
      limits: { speed: 40, clearance: 10 } });
    for (let salvo = 0; salvo < salvos; salvo++) {
      const roof = world.plates.find(p => p.id === roofDefinition.id);
      assert(roof && roof.nodes[0], 'Mortar review needs its authored roof outline.');
      const a = roof.nodes.reduce((best, n) => n.x < best.x ? n : best, roof.nodes[0]),
        b = roof.nodes.reduce((best, n) => n.x > best.x ? n : best, roof.nodes[0]),
        u = Math.min(.94, Math.max(.06, .78 + offset)),
        sensor = targetSensor && world.modules.find(m=>m.kind==='sensor' && m.sensorMode===targetSensor),
        aim = sensor ? {x:sensor.x,y:sensor.y} : { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u },
        launcher = world.launcher(config);
      assert(launcher, 'Mortar review needs its launcher.');
      const solution = firingSolution(launcher, aim, config), start = world.time;
      if(targetSensor && !sensor)throw new Error('Missing authored mortar sensor target: '+targetSensor);
      shots.push({ accepted: world.fire(aim, config, true), aim, targetId:sensor?.id||roof.id, flight: solution.time });
      probe.run(Math.ceil((solution.time + aftermath) * 60), { events: [], after(i, values, frameEvents) {
        events.push(...frameEvents.filter(e => ['explosion', 'penetration', 'blocked'].includes(e.type))
          .map(e => ({ ...e, salvo, sinceShot: Number(e.time) - start })));
        const v = requireVehicle(world);
        if (i % 30 === 0) trace.push({ time: world.time - begin, salvo, x: v.x, y: v.y,
          vy: v.vy, omega: v.omega, recoveries: world.dynamics?.recoveries || 0 });
      } });
      if (probe.invalid) break;
    }
    const primary = events.filter(e => e.type === 'explosion' && e.preset === 'm252'),
      failures = [];
    if (shots.some(s => !s.accepted) || primary.length !== salvos) failures.push('missing-primary');
    if (!Number.isFinite(peaks.energy + peaks.speed) || peaks.clearance > 2 || peaks.verticalSpeed > 8)
      failures.push('carrier-launched');
    if (probe.invalid) failures.push('physical-instability');
    return { model, seed, distance, terrain, salvos, offset, spread, peaks, failures, shots,
      primary, events, carrierMassBefore, carrierMassAfter: carrierMass(), structureMassBefore, structureMassAfter: carrierMass() - installedModuleMass(world), stats: { ...world.stats }, partsPreserved: probe.partsPreserved, finite: probe.finite, recoveries: world.dynamics?.recoveries || 0,
      modules: world.modules.map(m => ({ kind: m.kind, health: m.health / m.maxHealth })), trace };
  } finally { world.dispose(); }
}
