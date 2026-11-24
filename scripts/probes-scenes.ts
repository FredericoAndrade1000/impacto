import assert from 'node:assert/strict';
import type { WorldOptions } from '../src/physics.ts';
import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { TemplateId } from '../src/construction-template-catalogue.ts';
import type { AmmoId, WeaponPresetId, WeaponSettings } from '../src/weapons.ts';
import type { SceneEvent } from '../src/scene-contract.ts';
import type { ReferenceScene } from '../src/scenarios.ts';
import type { SharedRoom } from '../server/room.ts';
import { requireVehicle } from './review-harness.ts';

export interface ProfileOptions {
  id?: string; frames?: number; every?: number; blast?: boolean; profile?: boolean;
  warmup?: number; snapshotEvery?: number; scene?: ReferenceScene; pvp?: boolean; benchmark?: boolean; trigger?: boolean;
}
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { structuredTemplateSource } from '../src/structured-templates.ts';
import { labConstruction } from '../src/lab-constructions.ts';
import { referenceScenario, applyReferenceScene, angledJointBlueprint, vehicleBlastOrigin,vehicleRoof } from '../src/scenarios.ts';
import { createBenchmarkWorld } from '../src/benchmark-world.ts';
import { weaponSettings, WEAPON_PRESETS } from '../src/weapons.ts';
import { firingSolution } from '../src/ballistics.ts';
import { predictImpact } from '../src/impact-preview.ts';
import { rehearsal } from '../server/room.ts';
import { DamageProbe, Profiler, physicsState, advance, timing, mean, round, finiteWorld, fingerprint, permanentParts, partsPreserved } from './review-harness.ts';

const withWorld = <Result>(blueprint: AuthoredConstruction, run: (world: World) => Result, options?: WorldOptions): Result => {
  const world = new World(blueprint, options);
  try { return run(world); } finally { world.dispose(); }
};
const wall = (world: World, edge: string) => {
  const part = world.plates.find(plate => plate.id === `hull:${edge}` || plate.id.endsWith(`:hull:${edge}`));
  if (!part) throw new Error('Parede autorada ausente: hull:' + edge);
  return part;
};

export function probeReferenceBlast({ id, frames = 180 }: {id: string; frames?: number}) {
  const scene = referenceScenario(id);
  return withWorld(scene.blueprint, w => {
    const trace: {time: number; displacement: number}[] = [], peaks = { displacement: 0, speed: 0 },
      probe = new DamageProbe(w, { peaks });
    applyReferenceScene(w, scene);
    probe.run(frames, { after(step, state) {
      trace.push({ time: w.time, displacement: state.displacement });
    } });
    return { scenario: id, blast: scene.blast, durationSeconds: w.time, seed: scene.blueprint.seed,
      peaks, stats: { ...w.stats },
      retained: w.plates.map(p => p.integrity), modules: w.modules.map(m => ({ kind: m.kind, health: m.health / m.maxHealth })),
      finite: probe.finite, partsPreserved: probe.partsPreserved, trace };
  });
}

export function probeJoint({ thickness, gap = 0, offset = 0 }: {thickness?: number; gap?: number; offset?: number}) {
  if (gap !== 0) throw new Error('O ensaio admite somente o encontro fechado autorado; uma folga aberta não é uma construção fechada.');
  const b = angledJointBlueprint(thickness), config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 });
  assert(b.launcher, 'Joint assay needs its authored launcher.');
  b.launcher.y += offset;
  return withWorld(b, w => {
    assert(b.launcher, 'Joint assay needs its authored launcher.');
    const aim = { x: 12, y: b.launcher.y }, prediction = predictImpact(w.snapshot(), firingSolution(b.launcher, aim, config)), events: SceneEvent[] = [],
      parts = permanentParts(w);
    w.fire(aim, config, true); advance(w, 12, { events });
    return { scenario: 'joint', thickness, gap, offset, angle: prediction?.angleDegrees, pathMm: prediction?.traversedMm,
      outcome: events.filter(e => ['penetration', 'ricochet', 'blocked'].includes(e.type)).map(e => e.type),
      retained: w.plates.map(p => p.integrity), authoredPlateIds: w.plates.map(p => p.id),
      partsPreserved: partsPreserved(w, parts), finite: finiteWorld(w) };
  });
}

export function probeConcentrated({ preset, count = 400 }: {preset: WeaponPresetId; count?: number}) {
  const b = labConstruction({ name: 'Fogo concentrado · parede frontal de 125 mm',
    length: 3, height: 2, rideHeight: .7, thicknessMm: 125, launcher: { x: 7, y: 1.7 } });
  return withWorld(b, w => {
    const config = weaponSettings(WEAPON_PRESETS[preset].family, { preset, spread: 0 }),
      front = wall(w, 'front'), parts = permanentParts(w); let firstPerforation: number | null = null;
    for (let shot = 1; shot <= count; shot++) {
      w.fire({ x: 12, y: 1.7 }, config, true); advance(w, 1, { after(step, world, events) {
        if (!firstPerforation && events.some(e => e.type === 'penetration' && e.id === front.id)) firstPerforation = shot;
      } });
    }
    return { scenario: 'concentrated-fire', preset, shots: w.stats.shots, requestedShots: count, firstPerforation, retained: front.integrity,
      fragments: 0,
      partsPreserved: partsPreserved(w, parts), authoredPlateIds: w.plates.map(p => p.id), finite: finiteWorld(w) };
  });
}

export function probeDamagedBlast({ model, location }: {model: TemplateId; location: string}) {
  return withWorld(createConstruction(model), w => {
    advance(w, 30);
    advance(w, 240, { before(i) {
      if (i % 8 === 0) {
        const p = wall(w, 'front');
        w.fire({ x: (p.bounds.minX + p.bounds.maxX) / 2, y: (p.bounds.minY + p.bounds.maxY) / 2 + .08 * Math.sin(i) },
          weaponSettings('autocannon', { preset: 'm242', ammo: 'ap', spread: .006 }), true);
      }
    } });
    const gear = w.modules.find(m => m.kind === 'track' || m.kind === 'wheel'), front = wall(w, 'front');
    assert(gear, 'Damaged blast assay needs its running gear.');
    const origin = location === 'internal' ? w.modules.find(m => m.kind === 'engine') : location === 'running-gear' ?
        { x: gear.x - gear.width / 2 - .18, y: gear.y } : { x: front.bounds.minX - .18, y: (front.bounds.minY + front.bounds.maxY) / 2 },
      peaks = { height: 0, speed: 0, energy: 0 }, probe = new DamageProbe(w, { peaks });
    assert(origin, 'Damaged blast assay needs its target.');
    w.explode(origin.x, origin.y, 600, 4.5); probe.run(360);
    return { model, location, peaks, stats: { ...w.stats }, recoveries: w.dynamics?.recoveries || 0,
      lastRecovery: w.dynamics && 'lastRecovery' in w.dynamics ? w.dynamics.lastRecovery : undefined, fragments: 0, finite: probe.finite, partsPreserved: probe.partsPreserved };
  });
}

export function probeDurability({ preset, ammo }: {preset: WeaponPresetId; ammo: AmmoId}) {
  const b = structuredTemplateSource('heavy'); b.seed = 6173;
  b.components = b.components.filter(m => !['ammo', 'fuel'].includes(m.kind));
  return withWorld(b, w => {
    const roof = vehicleRoof(w), d=roof.definition, center={x:d.x+Math.cos(d.angle)*d.length*.15,y:d.y+Math.sin(d.angle)*d.length*.15},
      config = weaponSettings('autocannon', { preset, ammo, spread: 0 }), count = ammo === 'ap' ? 12 : 3, events: SceneEvent[] = [],
      parts = permanentParts(w), authoredPlateIds = w.plates.map(plate => plate.id);
    w.command('configureLauncher',{point:{x:center.x,y:center.y+2}});
    let peakY = 0;
    const step = (ticks: number) => advance(w, ticks, { events, after() { peakY = Math.max(peakY, requireVehicle(w).y); } });
    for (let shot = 0; shot < count; shot++) {
      w.fire({ x: center.x + ((shot % 3) - 1) * .09, y: center.y }, config, true); step(ammo === 'ap' ? 8 : 30);
    }
    step(120);
    return { preset, ammo, shots: w.stats.shots, impacts: w.stats.impacts, roofIntegrity: roof.integrity, roofAttached: roof.attached !== false,
      partsPreserved: partsPreserved(w, parts), attachedPlates: w.plates.filter(p => p.attached !== false).length,
      authoredPlateCount: authoredPlateIds.length, authoredPlateIds,
      localHoles: roof.perforations.length, roofPenetrations: events.filter(e => e.type === 'penetration' && e.id === roof.id).length,
      explosions: w.stats.explosions, fragments: 0, peakY, finite: finiteWorld(w) };
  });
}

export function probeLongRange({ preset, distance, detonation, target }: {preset: WeaponPresetId; distance: number; detonation: WeaponSettings['detonation']; target: string}) {
  if (!['vehicle', 'bunker'].includes(target)) throw new Error('Alvo de longo alcance desconhecido.');
  const b = createConstruction(target === 'vehicle' ? 'heavy' : 'bunker'); b.seed = 6173;
  return withWorld(b, w => {
    const config = weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo: 'he', detonation, spread: 0 });
    w.setTestDistance(distance);
    const roof = vehicleRoof(w), front = wall(w, 'front'),r=roof.definition,
      aim = detonation==='airburst'?{x:r.x,y:r.y+2.6}:preset==='m252'?
        {x:r.x+Math.cos(r.angle)*r.length*.15,y:r.y+Math.sin(r.angle)*r.length*.15}:
        {x:front.definition.x,y:front.definition.y},
      launcher = w.launcher(config); assert(launcher, 'Long range assay needs its launcher.');
    const solution = firingSolution(launcher, aim, config), events: SceneEvent[] = [], samples: number[] = [];
    let peakY = w.vehicle?.y || 0, peakSpeed = 0;
    const accepted = w.fire(aim, config, true);
    advance(w, Math.ceil(solution.time * 60) + 100, { events, samples, after() {
      if (w.vehicle) { peakY = Math.max(peakY, requireVehicle(w).y); peakSpeed = Math.max(peakSpeed, Math.hypot(w.vehicle.vx, w.vehicle.vy)); }
    } });
    const shells = events.filter(e => e.type === 'explosion' && e.preset === preset), secondary = events.filter(e => e.type === 'explosion' && !e.preset), times = timing(samples);
    return { preset, distance, detonation, target, accepted, predictedFlightS: solution.time, impacts: w.stats.impacts, shellBlasts: shells.length,
      secondaryBlasts: secondary.length, uniqueSecondary: new Set(secondary.map(e => e.source)).size,
      blast: shells[0] ? { x: shells[0].x, y: shells[0].y, radius: shells[0].radius, detonation: shells[0].detonation } : null,
      fragments: 0, finite: finiteWorld(w), peakY, peakSpeed, attachedPlates: w.plates.filter(p => p.attached !== false).length,
      modules: w.modules.map(m => ({ kind: m.kind, health: m.health, maxHealth: m.maxHealth, attached: m.attached !== false })),
      meanStepMs: times.meanMs, p95StepMs: times.p95Ms, peakStepMs: times.peakMs };
  });
}

export function probeExposed({ kind }: {kind: 'engine' | 'weapon' | 'wheel' | 'track'}) {
  if (!['engine', 'weapon', 'wheel', 'track'].includes(kind)) throw new Error('Componente exposto desconhecido.');
  // Running gear comes with the chassis: it is shot on the vehicle with nothing put in it. Any other part stands alone
  // in the hull, which stands fixed where the deck of its chassis held it.
  const source = structuredTemplateSource(kind === 'track' ? 'heavy' : 'scout'), { chassis: _, ...hull } = source,
    component = source.components.find(component => component.kind === kind);
  if (!['wheel', 'track'].includes(kind)) assert(component, 'Exposed assay needs its authored component.');
  const b: AuthoredConstruction = ['wheel', 'track'].includes(kind) ? { ...source, components: [] } : { ...hull, preset: 'bunker',
      components: [component!] };
  return withWorld(b, w => {
    const component = w.modules[0]; assert(component, 'Exposed assay needs its installed component.');
    const settings = weaponSettings('machinegun', { preset: 'fnmag', spread: 0 }), samples: {shot: number; health: number; attached: boolean; partsPreserved: boolean; fragments: number; mountedMass: number}[] = [], parts = permanentParts(w);
    // Interior components become exposed through a real ballistic opening,
    // while the closed authored hull, carrier and installed identities remain.
    if (kind === 'engine') {
      const front = wall(w, 'front');
      w.cutBody(front, { x: front.definition.x, y: component.y - component.height / 2 },
        { x: front.definition.x, y: component.y + component.height / 2 }, component.height * .6);
    }
    for (let shot = 0; shot < 6; shot++) {
      w.game().call({ op: 'configureLauncher', point: { x: 7, y: component.y } });
      w.fire({ x: component.x + 2, y: component.y }, settings, true); advance(w, 1);
      samples.push({ shot: shot + 1, health: component.health, attached: component.attached, partsPreserved: partsPreserved(w, parts),
        fragments: 0, mountedMass: component.physicalMass });
    }
    return { scenario: 'exposed-' + kind, constructionVersion: b.version, maxHealth: component.maxHealth, configuredMass: component.physicalMass, samples,
      finite: finiteWorld(w), partsPreserved: partsPreserved(w, parts) };
  });
}

// Benchmarks, destruction profiles and salvo timing share lifecycle, timing,
// snapshots and native counters; only their interventions differ.
export function profileScene(id: string) {
  return referenceScenario(id);
}
export function profileScenario({ id = 'internal', frames = 90, every = 0, blast = false, profile = true, warmup = 0, snapshotEvery = 3, scene: supplied, pvp = false, benchmark = false, trigger = false }: ProfileOptions = {}) {
  let room: SharedRoom | undefined;
  const scene = supplied || (pvp || benchmark ? null : profileScene(id));
  const w = pvp ? (room = rehearsal()).world : benchmark ? createBenchmarkWorld() : new World(scene!.blueprint), profiler = new Profiler(), samples: number[] = [], snapshots: number[] = [], checkpoints: {frame: number; ms: number | undefined; fragments: number; triangles: number; plateTriangles: number; colliders: number}[] = [];
  try {
    if (pvp) {
      assert(room, 'PvP profile needs its shared room.');
      const players = [room.join('Alice'), room.join('Bob')];
      for (let i = 0; i < 4; i++) {
        const player = players[i % 2]!; const record = room.players.get(player.playerId); assert(record); record.builtAt = -Infinity;
        const result = room.publish(player.playerId, createConstruction('heavy'));
        assert('actor' in result && result.actor, 'PvP profile publication must be accepted.');
        w.controlVehicle(.5, 0, result.actor.id);
      }
      const player = players[0]!; const record = room.players.get(player.playerId); assert(record); record.builtAt = -Infinity;
      room.publish(player.playerId, createConstruction('bunker'));
    }
    if (profile) profiler.watch(w, ['cutBody', 'step'], 'world.')
      .watch(w.game(), ['step', 'call', 'accept'], 'core.')
      .watch(w.index, ['raycast', 'raycastLayers'], 'collision.');
    if (trigger) w.setTrigger(true, scene!.aim, scene!.weapon);
    else if (!every && !blast && !pvp && !benchmark) w.fire(scene!.aim, scene!.weapon, true);
    advance(w, frames, { samples, snapshots, snapshotEvery, before(frame) {
      if (benchmark && frame % 15 === 0) {
        const p = w.plates[(frame / 15) % w.plates.length]; assert(p, 'Benchmark needs its admitted plate.'); w.command('impulse', { owner: w.game().handle(p), point: { x: p.definition.x, y: p.definition.y }, impulse: { x: 100, y: 0 } });
      } else if (blast && frame % 180 === 0) {
        const point=w.vehicle?vehicleBlastOrigin(w,'internal'):scene?.blast;
        if(!point)throw new Error('O perfil requer um ponto de explosão autorado.');
        w.explode(point.x,point.y,600,4.5);
      }
      else if (every && frame % every === 0) {
        const aim = { ...scene!.aim }, p = wall(w, 'front');
        if (w.vehicle && p?.remainingArea) { aim.x = (p.bounds.minX + p.bounds.maxX) / 2; aim.y = (p.bounds.minY + p.bounds.maxY) / 2; }
        w.fire(aim, scene!.weapon, true);
      }
    }, after(frame) {
      if (frame % 15 === 0) checkpoints.push({ frame, ms: samples.at(-1), fragments: 0,
        triangles: 0, plateTriangles: w.plates.reduce((sum, p) => sum + p.activeIndices.length / 3, 0),
        colliders: physicsState(w).colliders });
    } });
    const counts = physicsState(w).owners.map((record): [string | number, number] => [w.game().objects.get(record.owner)?.id || record.owner, record.colliders]);
    return { scene: id, frames, ...timing(samples.slice(warmup)), snapshotMs: round(mean(snapshots)), inclusiveMs: profiler.totals(frames),
      fragments: 0, activeFragments: 0, integrity: w.plates.every(p => p.integrity > .999999),
      fragmentTriangles: 0, stats: { ...w.stats }, checkpoints, finite: finiteWorld(w),
      fingerprint: fingerprint({ state: w.snapshot(), stats: w.stats }, { opaqueIdentities: true }), counts: counts.sort((a, b) => b[1] - a[1]) };
  } finally { profiler.close(); w.dispose(); }
}

export function probeExplosionPerformance(model: TemplateId, location: string, frames = 360) {
  const blueprint = createConstruction(model); blueprint.terrain = location === 'moving-track' ? 'hills' : 'flat';
  const world = new World(blueprint), profiler = new Profiler(), peaks = { height: 0, speed: 0, energy: 0 };
  let slowest = 0, peakFrame: number | undefined, peakProfile: Record<string, number> | undefined, angle = 0;
  try {
    profiler.watch(world, ['explode', 'cutBody', 'step'], 'world.')
      .watch(world.game(), ['step', 'call', 'accept'], 'core.')
      .watch(world.index, ['raycast', 'raycastLayers'], 'collision.');
    if (location === 'moving-track') world.controlVehicle(.65);
    advance(world, location === 'moving-track' ? 120 : 30);
    const probe = new DamageProbe(world, { peaks }), blastLocation=
      location.includes('internal')?'internal':location.endsWith('track')?'track':'front';
    probe.run(frames, { before(frame) {
      profiler.costs.clear();
      if (frame === 0 || location === 'internal-repeat' && (frame === 60 || frame === 120)) {
        const origin=vehicleBlastOrigin(world,blastLocation);
        world.explode(origin.x,origin.y,600,4.5);
      }
    }, after(frame) {
      const duration = probe.durations.at(-1); assert(duration !== undefined, 'Profile step needs its duration.');
      angle = Math.max(angle, Math.abs(requireVehicle(world).angle - probe.start.angle));
      if (duration > slowest) {
        slowest = duration; peakFrame = frame;
        peakProfile = Object.fromEntries(Object.entries(profiler.totals()).sort((a, b) => b[1] - a[1]).slice(0, 10));
      }
    } });
    const times = probe.timing();
    return { model, location, meanMs: times.meanMs, p95Ms: times.p95Ms, peakMs: round(slowest), peakFrame, peakProfile,
      peaks: { ...peaks, angle }, invalid: probe.invalid, partsPreserved: probe.partsPreserved, fragments: 0, stats: { ...world.stats },
      modules: world.modules.map(m => ({ kind: m.kind, health: round(m.health / m.maxHealth), attached: m.attached !== false })) };
  } finally { profiler.close(); world.dispose(); }
}
