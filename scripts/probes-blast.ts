import assert from 'node:assert/strict';
import type { SceneEvent } from '../src/scene-contract.ts';
import type { Point } from '../src/math.ts';
import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { TemplateId } from '../src/construction-template-catalogue.ts';
import type { TerrainId } from '../src/terrain.ts';
import type { SensorMode } from '../src/combat-sensors.ts';
import { requireVehicle } from './review-harness.ts';
import {World} from '../src/physics.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {vehicleBlastOrigin,vehicleRoof} from '../src/scenarios.ts';
import {mechanicalState,installedModuleMass,eventCounts,plateShape,DamageProbe,advance,resetRestored} from './review-harness.ts';
export function blastCase({ location, power = 410, radius = 5.2, seed = 6173, seconds = 3 }: {location: string; power?: number; radius?: number; seed?: number; seconds?: number}) {
  const blueprint = createConstruction('heavy'); blueprint.seed = seed;
  const world = new World(blueprint);
  const peaks = { speed: 0, y: 1.3, kineticJ: 0 };
  const events: SceneEvent[] = [];
  try {
    advance(world, 30);
    const probe = new DamageProbe(world, { peaks, limits: { speed: 100, kineticJ: 1e10 } });
    const origin=vehicleBlastOrigin(world,location);
    world.explode(origin.x,origin.y, power, radius, 'diagnostic');
    probe.run(Math.round(seconds * 60), { events });
    return { scenario: 'blast-' + location, power, radius, seed, peaks, stats: { ...world.stats },
      partsPreserved: probe.partsPreserved,
      modules: world.modules.map(m => ({ kind: m.kind, fraction: m.health / m.maxHealth,
        burning: m.burning || false, attached: m.attached !== false })),
      plates: world.plates.map((p, index) => ({ index, integrity: p.integrity, attached: p.attached !== false,
        displacement: plateShape(p, requireVehicle(world)).maxDisplacement })),
      eventCounts: eventCounts(events) };
  } finally { world.dispose(); }
}

// vehicle-blasts
export function assessVehicleBlast({ location = 'front', power = 410, radius = 5.2,
  seed = 6173, seconds = 4, vent = false, control = false, throttle = 0,
  repeated = 1, terrain = 'flat', construction = createConstruction('heavy') }: {location?: string; power?: number; radius?: number; seed?: number; seconds?: number; vent?: boolean; control?: boolean; throttle?: number; repeated?: number; terrain?: TerrainId; construction?: AuthoredConstruction} = {}) {
  const blueprint = structuredClone(construction); blueprint.seed = seed; blueprint.terrain = terrain;
  const world = new World(blueprint), original = JSON.stringify(world.blueprint), events: SceneEvent[] = [], trace: {time: number; x: number; y: number; angle: number; speed: number; traction: number | undefined; kineticJ: number}[] = [];
  const peaks = { speed: 0, height: 0, angle: 0, kineticJ: 0,
    displacement: 0, fragments: 0 };
  let origin: Point, start: Point & {angle: number}, carrierMassBefore: number, structureMassBefore: number;
  try {
    world.controlVehicle(throttle);
    advance(world, throttle ? 120 : 30); start = requireVehicle(world).pose();
    carrierMassBefore = mechanicalState(world).mass; structureMassBefore = carrierMassBefore - installedModuleMass(world);
    const probe = new DamageProbe(world, { peaks, limits: { speed: 50, kineticJ: 1e10 } });
    if (vent) {
      const roof=vehicleRoof(world),point=roof.materialPosition({u:.73,v:.5}),
        a={x:point!.x,y:point!.y-.3},b={x:point!.x,y:point!.y+.3};
      world.cutBody(roof, a, b, .16);
    }
    const preBlastAreaM2 = world.plates.reduce((sum, plate) => sum + plate.remainingArea, 0),
      preBlastPlates = world.plates.map(plate => ({ id: plate.id, integrity: plate.integrity,
        ballisticGrid: plate.ballisticGrid }));
    origin = vehicleBlastOrigin(world,location);
    const begin = world.time;
    if (!control) world.explode(origin.x, origin.y, power, radius, 'validation');
    probe.run(Math.round(seconds * 60), { events, before(step) {
      if (!control && repeated > 1 && step > 0 && step % 60 === 0 && step / 60 < repeated) {
        origin = vehicleBlastOrigin(world,location);
        world.explode(origin.x, origin.y, power, radius, 'validation');
      }
    }, after(step, values) {
      trace.push({ time: world.time - begin, x: requireVehicle(world).x, y: requireVehicle(world).y, angle: requireVehicle(world).angle,
        speed: Math.hypot(requireVehicle(world).vx, requireVehicle(world).vy), traction: requireVehicle(world).traction,
        kineticJ: values.kineticJ });
    } });
    const modules = world.modules.map(m => ({ kind: m.kind, health: m.health / m.maxHealth,
      attached: m.attached !== false, detonated: m.detonated, burning: m.burning })),
      plates = world.plates.map((p, index) => ({ index, id: p.id, integrity: p.integrity,
        thicknessMm: p.definition.thicknessMm, ballisticGrid: p.ballisticGrid,
        attached: p.attached !== false, ...plateShape(p, requireVehicle(world)) })),
      stats = { ...world.stats }, end = requireVehicle(world).snapshot(), unchanged = original === JSON.stringify(world.blueprint),
      carrierMassAfter = mechanicalState(world).mass, structureMassAfter = carrierMassAfter - installedModuleMass(world),
      detonationCounts = Object.fromEntries(world.modules.filter(m => ['fuel', 'ammo'].includes(m.kind))
        .map(m => [m.kind, events.filter(e => e.type === 'explosion' && e.source === m.id).length]));
    const restored = resetRestored(world);

    return { scenario: `${control ? 'control' : 'blast'}-${location}${vent ? '-vent' : ''}${throttle ? '-moving' : ''}${repeated > 1 ? '-repeat' : ''}`,
      seed, terrain, power, radius, origin, seconds, repeated, start, end, finite: probe.finite, partsPreserved: probe.partsPreserved, unchanged, restored, peaks, stats, modules,
      plates, detonationCounts, carrierMassBefore, carrierMassAfter, structureMassBefore, structureMassAfter, preBlastAreaM2, preBlastPlates,
      eventCounts: eventCounts(events),
      ...probe.timing(), trace };
  } finally { world.dispose(); }
}
