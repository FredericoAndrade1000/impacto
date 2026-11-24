import assert from 'node:assert/strict';
import type { Point, Pose } from '../src/math.ts';
import type { LiveModule, SceneEvent } from '../src/scene-contract.ts';
import type { PlateMesh } from '../src/mesh.ts';
import type { AuthoredConstruction } from '../src/construction-contract.ts';
import type { MaterialId } from '../src/materials.ts';
import type { TerrainId } from '../src/terrain.ts';
import type { WeaponPresetId, WeaponFamilyId, AmmoId, Trajectory, WeaponSettings } from '../src/weapons.ts';
import { requireVehicle, errorDetail } from './review-harness.ts';

interface FireTargetSpec {
  face?: string; u?: number; level?: boolean; weaponHost?: boolean;
  moduleColumn?: LiveModule['kind']; module?: LiveModule['kind'];
}
export interface FireCaseOptions {
  target?: string; preset?: WeaponPresetId; weapon?: WeaponFamilyId; ammo?: AmmoId;
  seconds?: number; burst?: boolean; settle?: number; control?: boolean; spread?: number;
  follow?: boolean; throttle?: number; blueprint?: AuthoredConstruction | null;
  observe?: ((world: World, state: ReturnType<typeof snapshotVehicle>, step: number) => unknown) | null;
  beforeFire?: ((world: World) => unknown) | null; measureEngineFloor?: boolean;
}
type ReportedEvent<Event extends SceneEvent = SceneEvent> = Event extends SceneEvent ? Omit<Event, 'id' | 'source' | 'time'> & {id: string | number | null | undefined; source: string | number | null | undefined; time: number; salvo: number} : never;
export interface ArtilleryOptions {
  preset?: WeaponPresetId; trajectory?: Trajectory; distance?: number; target?: string; terrain?: TerrainId;
  seed?: number; detonation?: WeaponSettings['detonation']; spread?: number; salvos?: number; control?: boolean;
  aftermath?: number; configureWorld?: (world: World) => unknown;
}
// Bounded diagnostic probes; orchestration and case matrices live in review.ts/review-cases.ts.
import { mechanicalState, physicsState, partPhysics, eventCounts, toCarrier, plateShape, DamageProbe, advance, resetRestored, permanentParts, partsPreserved, finiteWorld } from './review-harness.ts';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponSettings, WEAPON_PRESETS } from '../src/weapons.ts';
import { pointInTriangle, closestSegment } from '../src/math.ts';
import { surfaceEdges } from '../src/solid-geometry.ts';
import { firingSolution } from '../src/ballistics.ts';
import { predictImpact } from '../src/impact-preview.ts';
import { componentPolygon, componentPolygons, isRunningGear } from '../src/assembly.ts';
import { weaponMaterialRole } from '../src/weapon-geometry.ts';
import { vehicleRoof } from '../src/scenarios.ts';
import {damageConstruction,face,interior} from './damage-fixtures.ts';
import { metresOf } from '../src/grid.ts';
export { toCarrier } from './review-harness.ts';
export { materialRestPoint } from './review-harness.ts';
export { plateShape } from './review-harness.ts';

// vehicle-fire. The glacis is shot at level from ahead: a gun laid over the front of the hull, as the tank's own
// is, covers it from above.
export const FIRE_TARGETS = Object.freeze({
  'upper-front': { face: 'glacis', u: .5, level: true },
  roof: { face: 'roof', weaponHost: true, u: .65 },
  front: { face: 'front', moduleColumn: 'ammo' },
  'front-lower-edge': { face: 'front', u: .92 },
  track: { module: 'track' },
  mount: { module: 'weapon' },
  'roof-front-edge': { face: 'roof', weaponHost: true, u: .92 },
  'roof-rear-edge': { face: 'roof', weaponHost: true, u: .03 },
  'engine-roof': { face: 'roof', moduleColumn: 'engine' },
} satisfies Record<string, FireTargetSpec>);
export type FireTarget = keyof typeof FIRE_TARGETS;
const isFireTarget = (name: string): name is FireTarget => Object.hasOwn(FIRE_TARGETS, name);

// A shield probe aims through a real native facet. Require four centimetres
// of clear material to either side of the ray: the burst's ordinary spread
// must strike this shield, not a nearby port edge or overlapping hull wall.
function shieldTarget(world: World, part: Extract<LiveModule, {kind: 'weapon'}>, reach: number) {
  const shield=part.weaponMount.shield;
  if(!shield)throw new Error('The mount armour probe needs a curved shield');
  const c=Math.cos(part.barrelAngle),s=Math.sin(part.barrelAngle),
    gap=Math.asin(shield.opening/shield.radius),desired=-(gap+shield.halfAngle)/2,
    facets=part.materialPolygons.filter((_, index) => weaponMaterialRole(part.weaponMount.exposed, index) === 'shield').map(poly=>{
      const x=poly.reduce((sum,p)=>sum+p.x,0)/poly.length,y=poly.reduce((sum,p)=>sum+p.y,0)/poly.length;
      return {x,y,angle:Math.atan2(y,x)};
    }).filter(p=>p.y<0).sort((a,b)=>Math.abs(a.angle-desired)-Math.abs(b.angle-desired));
  for(const p of facets){
    const r=Math.hypot(p.x,p.y),normal={x:(c*p.x-s*p.y)/r,y:(s*p.x+c*p.y)/r},
      aim={x:part.x+c*p.x-s*p.y,y:part.y+s*p.x+c*p.y},
      launcher={x:aim.x+normal.x*reach,y:aim.y+normal.y*reach};
    if([-.04,0,.04].every(offset=>{
      const shift={x:-normal.y*offset,y:normal.x*offset},
        hit=world.index.raycast({x:launcher.x+shift.x,y:launcher.y+shift.y},{x:aim.x+shift.x,y:aim.y+shift.y},{projectile:true});
      return hit?.owner.object===part;
    }))return {aim,normal};
  }
  throw new Error('No exposed curved shield facet clears the mount armour probe');
}

// These are laboratory aiming points on admitted own geometry, not policy
// rules. No V1 coordinates, projection-as-authoring or compatibility aliases.
// The launcher stands 4 m off the aim, or as far as the `barrel` it fires through and a metre more.
export function fireTarget(world: World, name: string, barrel = 0) {
  if(!isFireTarget(name))throw new Error('Unknown authored fire target: '+name);
  const spec: FireTargetSpec=FIRE_TARGETS[name];
  const reach=Math.max(4,barrel+1);
  let part: PlateMesh | LiveModule, aim: Point, normal: Point;
  if(spec.face){
    part=spec.weaponHost?vehicleRoof(world):face(world,spec.face);const d=part.definition,u=spec.u??.5;
    aim={x:d.x+Math.cos(d.angle)*(u-.5)*d.length,y:d.y+Math.sin(d.angle)*(u-.5)*d.length};
    if(spec.moduleColumn){
      const module=world.modules.find(m=>m.kind===spec.moduleColumn);
      if(!module)throw new Error('Missing fire target column: '+spec.moduleColumn);
      const c=Math.cos(d.angle),s=Math.sin(d.angle),along=(module.x-d.x)*c+(module.y-d.y)*s;
      aim={x:d.x+c*along,y:d.y+s*along};
    }
    normal=spec.level?{x:Math.sign(Math.sin(d.angle)),y:0}:{x:Math.sin(d.angle),y:-Math.cos(d.angle)};
  }else{
    const module=world.modules.find(m=>m.kind===spec.module);if(!module)throw new Error('Missing fire target module: '+spec.module);
    part=module;
    if(spec.module==='weapon'){
      assert(part.kind === 'weapon', 'Weapon target needs the installed gun.');
      ({aim,normal}=shieldTarget(world,part,reach));
    }else{
      const angle=part.angle||0,c=Math.cos(angle),s=Math.sin(angle),x=-part.width/2+.15;
      aim={x:part.x+c*x,y:part.y+s*x};normal={x:-c,y:-s};
    }
  }
  return {aim,launcher:{x:aim.x+normal.x*reach,y:aim.y+normal.y*reach},id:part.id,
    type:spec.face?'plate':'module',plateIndex:world.plates.findIndex(plate => plate === part)};
}

export const kineticEnergy = (world: World) => mechanicalState(world).kineticJ;

export function engineFloorPenetration(world: World) {
  const engine = world.modules.find((m) => m.kind === 'engine'), floor = face(world,'floor'),
    indices = floor.activeIndices, edges = surfaceEdges(indices);
  let penetration = 0;
  if (engine) for (const point of componentPolygon(engine)) {
      if (!indices.some((id, i) => i % 3 === 0 && pointInTriangle(point,
        floor.nodes[id]!, floor.nodes[indices[i+1]!]!, floor.nodes[indices[i+2]!]!))) continue;
      let nearest = Infinity;
      for (const [a, b] of edges) {
        const closest = closestSegment(point, floor.nodes[a]!, floor.nodes[b]!);
        nearest = Math.min(nearest, Math.hypot(point.x - closest.x, point.y - closest.y));
      }
      penetration = Math.max(penetration, nearest);
    }
  return penetration;
}

function triangleOverlap(first: Point[], second: [Point, Point, Point]) {
  if (Math.max(...first.map((p) => p.x)) < Math.min(...second.map((p) => p.x)) ||
    Math.max(...second.map((p) => p.x)) < Math.min(...first.map((p) => p.x)) ||
    Math.max(...first.map((p) => p.y)) < Math.min(...second.map((p) => p.y)) ||
    Math.max(...second.map((p) => p.y)) < Math.min(...first.map((p) => p.y))) return 0;
  const side = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x),
    sign = Math.sign(side(...second));
  let polygon = first;
  for (let j = 0; j < 3; j++) {
    const a = second[j]!, b = second[(j + 1) % 3]!, next: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!,
        dp = side(a, b, p) * sign, dq = side(a, b, q) * sign;
      if (dp >= 0) next.push(p);
      if (dp * dq < 0) {
        const t = dp / (dp - dq);
        next.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
    polygon = next;
    if (polygon.length < 3) return 0;
  }
  return Math.abs(polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length]!;
    return sum + p.x * q.y - p.y * q.x;
  }, 0)) / 2;
}

export function engineFloorOverlapArea(world: World) {
  const engine = world.modules.find((m) => m.kind === 'engine'), floor = face(world,'floor'), indices = floor.activeIndices;
  let area = 0;
  if (engine) {
    const vertices = componentPolygon(engine);
    for (let i = 1; i < vertices.length - 1; i++) {
      const triangle = [vertices[0]!, vertices[i]!, vertices[i + 1]!];
      for (let j = 0; j < indices.length; j += 3)
        area += triangleOverlap(triangle, [floor.nodes[indices[j]!]!, floor.nodes[indices[j+1]!]!, floor.nodes[indices[j+2]!]!]);
    }
  }
  return area;
}

const moduleMountReferences = new WeakMap<LiveModule, Pose>();
function moduleMountState(module: LiveModule, vehicle: Pose) {
  const local = toCarrier(module, vehicle);
  if (!moduleMountReferences.has(module)) moduleMountReferences.set(module, {...local,angle:(module.angle||0)-vehicle.angle});
  const reference = moduleMountReferences.get(module);
  assert(reference, 'Mounted component reference must be established.');
  const angle=(module.angle||0)-vehicle.angle-reference.angle;
  return { relativeAngle: Math.atan2(Math.sin(angle),Math.cos(angle)),
    centerDisplacement: Math.hypot(local.x - reference.x, local.y - reference.y) };
}

export function snapshotVehicle(world: World) {
  const vehicle = requireVehicle(world), physics = physicsState(world);
  return {
    time: world.time, vehicle: { x: vehicle.x, y: vehicle.y, angle: vehicle.angle,
      speed: Math.hypot(vehicle.vx, vehicle.vy), omega: vehicle.omega },
    kineticJ: kineticEnergy(world),carrierMass:mechanicalState(world).mass,
    plates: world.plates.map((p, index) => ({ id:p.id,index, attached: p.attached !== false,
      integrity: p.integrity, ...plateShape(p, vehicle),
      nodes: p.nodes.length, cells: p.activeIndices.length / 3,
      nativeColliders: partPhysics(world, p, physics)?.colliders || 0 })),
    modules: world.modules.map((m) => ({ id:m.id,kind: m.kind, health: m.health, maxHealth: m.maxHealth,
      attached: m.attached !== false,
      ...moduleMountState(m, vehicle) })),
    nativeColliders: physics.colliders,
  };
}

export function runFireCase({ target = 'roof', preset = 'fnmag', weapon = WEAPON_PRESETS[preset].family,
  ammo = 'ap', seconds = 2, burst = false, settle = 0, control = false, spread = 0,
  follow = false, throttle = 0, blueprint: suppliedBlueprint = null, observe = null, beforeFire = null, measureEngineFloor = false }: FireCaseOptions = {}) {
  const blueprint = suppliedBlueprint || createConstruction('heavy');
  const world = new World(blueprint), settings = weaponSettings(weapon, { preset, ammo, spread }),
    events: SceneEvent[] = [], samples: ReturnType<typeof snapshotVehicle>[] = [],
    peaks = { speed: 0, y: 1.3, carrierDisplacement: 0, kineticJ: 0, plateDisplacement: 0,
      plateAngle: 0, shapeResidual: 0, fragments: 0, nativeColliders: 0 };
  let firstAnomaly: (ReturnType<typeof snapshotVehicle>['plates'][number] & {step: number; shots: number; kind: string; plate: number}) | null = null, thrown: string | null = null, afterSettlingPenetration = 0, afterSettlingOverlapArea = 0;
  let aim: Point, aimLocal: Point, selected: ReturnType<typeof fireTarget>;
  const currentAim = () => {
    if (!follow) return aim;
    const {x,y}=aimLocal,
      c = Math.cos(requireVehicle(world).angle), s = Math.sin(requireVehicle(world).angle);
    return { x: requireVehicle(world).x + c * x - s * y,
      y: requireVehicle(world).y + s * x + c * y };
  };
  const identify = (event: SceneEvent) => ({ ...event, plateIndex: world.plates.findIndex((p) => p.id === event.id),
    moduleKind: world.modules.find((m) => m.id === event.id)?.kind });
  try {
    world.controlVehicle(throttle);
    advance(world, settle);
    selected=fireTarget(world,target,settings.barrel);aim=selected.aim;aimLocal=toCarrier(aim,requireVehicle(world));
    world.command('configureLauncher',{point:selected.launcher});
    const probe = new DamageProbe(world, { peaks, limits: { speed: 3000, kineticJ: 1e10 } }), start = snapshotVehicle(world);
    beforeFire?.(world);
    if (!control) {
      if (burst) world.setTrigger(true, currentAim(), settings);
      else world.fire(currentAim(), settings, true);
    }
    probe.run(Math.round(seconds * 60), { before() {
      if (follow && burst) world.setTrigger(true, currentAim(), settings);
    }, after(step, values, frameEvents) {
      events.push(...frameEvents.map(identify));
      const state = snapshotVehicle(world);
      if (!firstAnomaly && settings.id === 'machinegun' && !control) {
        const plate = state.plates.find((p) => p.attached && p.maxDisplacement > 0.08);
        if (plate) firstAnomaly = { step: step + 1, shots: world.stats.shots,
          kind: 'mounted-armour-displaced', plate: plate.index, ...plate };
      }
      if ((step + 1) % 30 === 0 || step === 0) samples.push(state);
      if (measureEngineFloor && step > 120) {
        afterSettlingPenetration = Math.max(afterSettlingPenetration, engineFloorPenetration(world));
        if (step % 10 === 0) afterSettlingOverlapArea = Math.max(afterSettlingOverlapArea, engineFloorOverlapArea(world));
      }
      if (observe) observe(world, state, step);
    } });
    if (probe.invalid) thrown = 'physical divergence: ' + probe.invalid;
    world.setTrigger(false, aim, settings);
    const end = snapshotVehicle(world);
    return { scenario: `${control ? 'control' : preset}-${target}-${burst ? 'burst' : 'single'}`,
      authoredPlateCount:blueprint.plates.length,
      authoredModuleCount:blueprint.components.length,
      target,targetId:selected.id,targetType:selected.type,targetPlateIndex:selected.plateIndex,
      preset, weapon: settings.id, ammo: settings.ammo, seed: blueprint.seed, settle,
      seconds, burst, follow, throttle, settings: { caliberMm: settings.caliberMm, speed: settings.speed,
        mass: settings.mass, power: settings.power, rate: settings.rate, spread: settings.spread },
      shots: world.stats.shots, inputKineticJ: world.stats.shots * settings.mass * settings.speed ** 2 / 2,
      stats: { ...world.stats }, start, end, peaks, partsPreserved: probe.partsPreserved, firstAnomaly, thrown, samples,
      eventCounts: eventCounts(events),
      impacts: events.filter((e) => ['blocked', 'penetration', 'ricochet', 'module',
        'destroyed', 'explosion'].includes(e.type)).slice(0, 60),
      ...(measureEngineFloor ? { afterSettlingPenetration, afterSettlingOverlapArea } : {}), ...probe.timing() };
  } catch (error) {
    return { scenario: `${preset}-${target}`, thrown: errorDetail(error), events };
  } finally { world.dispose(); }
}

// blast-stability
export function repeatedFire({ preset, weapon, ammo = 'ap', target, seconds = 5, seed = 6173 }: {preset: WeaponPresetId; weapon: WeaponFamilyId; ammo?: AmmoId; target: string; seconds?: number; seed?: number}) {
  const blueprint = createConstruction('heavy'); blueprint.seed = seed;
  const result = runFireCase({ blueprint, preset, weapon, ammo, target, seconds,
    burst: true, follow: true, settle: 30 });
  return { scenario: result.scenario, seed, shots: 'shots' in result ? result.shots : undefined, stats: 'stats' in result ? result.stats : undefined,
    inputKineticJ: ('inputKineticJ' in result ? result.inputKineticJ : undefined), peaks: ('peaks' in result ? result.peaks : undefined),
    thrown: result.thrown, partsPreserved: ('partsPreserved' in result ? result.partsPreserved : undefined), eventCounts: ('eventCounts' in result ? result.eventCounts : undefined), end: ('end' in result ? result.end : undefined),
    meanMs: ('meanMs' in result ? result.meanMs : undefined), p95Ms: ('p95Ms' in result ? result.p95Ms : undefined), peakMs: ('peakMs' in result ? result.peakMs : undefined) };
}

export function salvoCase({ preset = 'm242', seed = 6173, thickness = null, ammo = 'ap',
  count = 60, interval = 6, target = 'front' }: {preset?: WeaponPresetId; seed?: number; thickness?: number | null; ammo?: AmmoId; count?: number; interval?: number; target?: string} = {}) {
  const blueprint = createConstruction('heavy'); blueprint.seed = seed;
  if (thickness) for (const plate of blueprint.plates) plate.thicknessMm = thickness;
  const world = new World(blueprint), settings = weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo, spread: 0 });
  const peaks = { speed: 0, y: 1.3, kineticJ: 0, fragments: 0 };
  let anomaly: ({step: number; time: number; shots: number} & typeof peaks) | null = null;
  try {
    advance(world, 30);
    const selected=fireTarget(world,target==='front'?'front':'roof',settings.barrel),local=toCarrier(selected.aim,requireVehicle(world));
    world.command('configureLauncher',{point:selected.launcher});
    const probe = new DamageProbe(world, { peaks, limits: { speed: 100, kineticJ: 1e10 } });
    probe.run(count * interval + 120, { before(i) {
      if (i % interval === 0 && i < count * interval) {
        const variation = 0.18 * Math.sin(i / interval * 1.618),
          c = Math.cos(requireVehicle(world).angle), s = Math.sin(requireVehicle(world).angle),
          at = target === 'front'?{x:local.x,y:local.y+variation}:{x:local.x+variation,y:local.y};
        world.fire({ x: requireVehicle(world).x + c * at.x - s * at.y,
          y: requireVehicle(world).y + s * at.x + c * at.y }, settings, true);
      }
    }, after(i) {
      if (!anomaly && (probe.invalid || peaks.kineticJ > 1000000))
        anomaly = { step: i, time: world.time, shots: world.stats.shots, ...peaks };
    } });
    return { scenario: `${preset}-${ammo}-${target}-${thickness || 'stock'}-salvo`, seed,
      peaks, anomaly, partsPreserved: probe.partsPreserved, stats: { ...world.stats } };
  } finally { world.dispose(); }
}

// artillery-vehicle
function artilleryMissBounds(world: World) {
  // Base plate outlines retain the complete physical hull even where its
  // ballistic grid is perforated. Installed modules retain their resistant
  // solids after failure; weapon polygons come from native mount admission.
  const hull = world.plates.filter(p => p.actorId === 'local').flatMap(p => p.nodes.map(n => n.x)),
    installed = world.modules.filter(m => m.actorId === 'local' && m.attached !== false),
    gear = installed.filter(isRunningGear).flatMap(m => componentPolygon(m).map(point => point.x)),
    modules = installed.flatMap(m => componentPolygons(m).flatMap(poly => poly.map(point => point.x)));
  return { hullMinX: Math.min(...hull), gearMinX: gear.length ? Math.min(...gear) : null,
    moduleMinX: modules.length ? Math.min(...modules) : null,
    minX: Math.min(...hull, ...modules) };
}

function artilleryTarget(world: World, target: string, missBounds: ReturnType<typeof artilleryMissBounds> | null) {
  if (['roof', 'front', 'track'].includes(target)) return fireTarget(world, target).aim;
  const roof = vehicleRoof(world);
  if (target === 'airburst') return { x: roof.definition.x, y: roof.definition.y + 2.6 };
  if (target === 'near-miss' || target === 'far-miss') {
    assert(missBounds, 'A miss needs the authored hull bounds.');
    const x = missBounds.minX - (target === 'near-miss' ? .55 : 5.55);
    return { x, y: world.terrain.height(x) };
  }
  throw new Error('Unknown authored artillery target: ' + target);
}

export function assessArtilleryVehicle({ preset = 'm252', trajectory,
  distance = 60, target = 'roof', terrain = 'flat', seed = 6173,
  detonation = target === 'airburst' ? 'airburst' : 'impact',
  spread = 0, salvos = 1, control = false, aftermath = 4, configureWorld }: ArtilleryOptions = {}) {
  const blueprint = createConstruction('heavy'); blueprint.seed = seed; blueprint.terrain = terrain;
  const world = new World(blueprint), original = JSON.stringify(blueprint), events: ReportedEvent[] = [], trace: {time: number; salvo: number; speed: number; y: number; health: Record<string, number>}[] = [];
  const config = weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo: 'he', spread,
    detonation, ...(trajectory ? { trajectory } : {}) });
  const peaks = { speed: 0, lift: 0, angle: 0,
    nativeFragments: 0 };
  const predictions: {reachable: boolean; intendedFlightS: number; effectiveSpeed: number; apex: number; aim: Point; launcher: Point; missBounds?: ReturnType<typeof artilleryMissBounds>; contact: (Point & {time: number; blastX: number; blastY: number; owner: string | number | null | undefined; angleDegrees: number}) | null}[] = [], shots: unknown[] = [];

  const ownerName = (id: string | number | null | undefined) => {
    const index = world.plates.findIndex(p => p.id === id);
    return index >= 0 ? 'plate-' + index : world.modules.find(m => m.id === id)?.kind || id;
  };
  try {
    configureWorld?.(world);
    advance(world, 30);
    world.setTestDistance(distance); const start = requireVehicle(world).pose(), begin = world.time,
      probe = new DamageProbe(world, { peaks, limits: { speed: 50, kineticJ: 1e10 } });
    for (let salvo = 0; salvo < salvos; salvo++) {
      const missBounds = ['near-miss', 'far-miss'].includes(target) ? artilleryMissBounds(world) : null,
        aim = artilleryTarget(world, target, missBounds),
        launcher = world.launcher(config);
      assert(launcher, 'Artillery review needs its launcher.');
      const solution = firingSolution(launcher, aim, config),
        prediction = predictImpact(world.snapshot(), { ...solution,
          time: detonation === 'impact' ? config.life : solution.time }, config);
      const duration = Math.min(config.life, detonation === 'airburst' ? solution.time : prediction?.time ?? config.life) + aftermath;
      predictions.push({ reachable: solution.reachable, intendedFlightS: solution.time,
        effectiveSpeed: solution.speed, apex: solution.apex, aim, launcher, ...(missBounds ? { missBounds } : {}),
        contact: prediction ? { x: prediction.x, y: prediction.y, time: prediction.time,
          blastX: prediction.x + (prediction.owner.type === 'ground' ? .08 * prediction.nx : 0),
          blastY: prediction.y + (prediction.owner.type === 'ground' ? .08 * prediction.ny : 0),
          owner: ownerName(prediction.owner.id), angleDegrees: prediction.angleDegrees } : null });
      shots.push(control ? false : world.fire(aim, config, true));
      const shotBegin = world.time;
      probe.run(Math.ceil(duration * 60), { after(i, values, frameEvents) {
        events.push(...frameEvents.filter(e => !['flight', 'muzzle'].includes(e.type)).map(e => ({ ...e,
          source: ownerName(e.source), id: ownerName(e.id), time: Number(e.time) - shotBegin, salvo })));
        if (i % 30 === 0) trace.push({ time: world.time - begin, salvo,
          speed: Math.hypot(requireVehicle(world).vx, requireVehicle(world).vy), y: requireVehicle(world).y,
          health: Object.fromEntries(world.modules.map(m => [m.kind, m.health / m.maxHealth])) });
      } });
      if (probe.invalid) break;
    }
    const blasts = events.filter((e): e is ReportedEvent & {type: 'explosion'; x: number; y: number} => e.type === 'explosion'), primary = blasts.filter(e => e.preset === preset),
      secondary = blasts.filter(e => !e.preset),
      modules = world.modules.map(m => ({ kind: m.kind, health: m.health / m.maxHealth,
        attached: m.attached !== false, detonated: !!m.detonated, burning: !!m.burning })),
      plates = world.plates.map((p, index) => ({ index, id:p.id,length:p.definition.length, thicknessMm: p.definition.thicknessMm,
        integrity: p.integrity, attached: p.attached !== false, ...plateShape(p, requireVehicle(world)) })),
      stats = { ...world.stats }, unchanged = JSON.stringify(blueprint) === original,
      simulationSeconds = world.time - begin;
    const agreement = primary.map(e => {
      const forecast = predictions[e.salvo];
      assert(forecast, 'A detonation needs the recorded prediction.');
      const contact = forecast.contact;
      return { salvo: e.salvo, detonation: e.detonation, source: e.source,
        positionError: Math.hypot(e.x - (e.detonation === 'airburst' ? forecast.aim.x : contact?.blastX ?? e.x),
          e.y - (e.detonation === 'airburst' ? forecast.aim.y : contact?.blastY ?? e.y)),
        timeError: Math.abs(e.time - (e.detonation === 'airburst' ? forecast.intendedFlightS : contact?.time ?? e.time)),
        ownerMatches: e.detonation === 'airburst' || e.source === contact?.owner };
    });
    const restored = resetRestored(world);
    const failures = [];
    if (!control && (shots.some(accepted => !accepted) || primary.length !== salvos)) failures.push('primary-shot-or-detonation');
    if (secondary.length !== new Set(secondary.map(e => e.source)).size) failures.push('repeated-secondary-explosion');
    if (probe.invalid) failures.push('physical-instability');
    if (peaks.lift > .15 || peaks.speed > 3) failures.push('carrier-launched');
    if (!unchanged || !restored) failures.push('blueprint-or-reset');
    if (spread === 0 && agreement.some(e => !e.ownerMatches || e.positionError > .001 || e.timeError > .00005)) failures.push('prediction-mismatch');
    const costs = probe.timing();
    return { preset, caliberMm: config.caliberMm, trajectory: config.trajectory, distance, target, terrain, seed,
      detonation, spread, salvos, control, aftermath, simulationSeconds,
      shots, predictions, agreement, blasts: primary, secondaryBlasts: secondary, peaks,
      modules, plates, stats, finite: probe.finite, partsPreserved: probe.partsPreserved, unchanged, restored, failures, trace,
      meanStepMs: costs.meanMs, p95StepMs: costs.p95Ms };
  } finally { world.dispose(); }
}

// arsenal
export function armorTrial({ preset, ammo = 'ap', material = 'steel', thickness = 80, incidence = 0, count = 1, seed = 6173 }: {preset: WeaponPresetId; ammo?: AmmoId; material?: MaterialId; thickness?: number; incidence?: number; count?: number; seed?: number}) {
  // The sloped front belongs to a convex closed hull with a horizontal base.
  // Its rear command is a real admitted interior component. We author the
  // slope instead of rotating a generated isolated plate or the whole base: from its nose, the top of the slope on the
  // cell nearest to where the incidence puts it (damageConstruction); the command a cell over the floor, in the line of
  // fire, which is aimed at the middle of the slope.
  if (!(incidence >= 0 && incidence <= 80)) throw new Error('Armor trial incidence must be 0..80 degrees');
  const height = .8, b = damageConstruction({ length: 8, height, seed, material, frontThickness: thickness, incidence,
      components: [interior('command', { x: 3.05, y: -.3 })] }),
    at = (id: string) => b.nodes.find(node => node.id === id), foot = at('hull-nose') ?? at('hull-0'), top = at('hull-3');
  assert(foot && top, 'Armour assay needs its authored front endpoints.');
  const run = metresOf(top.x - foot.x), rise = metresOf(top.y - foot.y);
  const aim = { x: 8 + run / 2, y: 1.3 + metresOf(foot.y) + rise / 2 };
  b.launcher = { x: aim.x - 3.5, y: aim.y };
  const w = new World(b), settings = weaponSettings(WEAPON_PRESETS[preset].family, { preset, ammo, spread: 0 });
  const times: number[] = [], allEvents: SceneEvent[] = [], parts = permanentParts(w);
  try {
    for (let shot = 0; shot < count; shot++) {
      w.fire(aim, settings, true);
      const launcher = w.launcher(settings); assert(launcher, 'Armour assay needs its launcher.');
      const flight = firingSolution(launcher, aim, settings).time;
      const ticks = Math.max(ammo === 'he' ? 24 : 12, Math.ceil(flight * 60) + 24);
      for (let i = 0; i < ticks; i++) { const start = performance.now(); w.step(); times.push(performance.now() - start); }
      allEvents.push(...w.drainEvents());
    }
    const module = w.modules.find(m => m.kind === 'command'), plate = face(w);
    assert(module, 'Armour assay needs its command component.');
    const finite = finiteWorld(w);
    const sorted = times.slice().sort((a, b) => a - b);
    return { preset, ammo, material, thickness, incidence, count, aim, sourceId:plate.id,
      shots: w.stats.shots, impacts: w.stats.impacts, penetrations: w.stats.penetrations,
      blocked: allEvents.filter(e => e.type === 'blocked').length, ricochets: allEvents.filter(e => e.type === 'ricochet').length,
      platePenetrations: allEvents.filter(e => e.type === 'penetration' && e.id === plate.id).length,
      explosions: allEvents.filter(e => e.type === 'explosion').length,
      integrity: plate.integrity, componentHealth: module.health, componentMaxHealth: module.maxHealth,
      fragments: 0, partsPreserved: partsPreserved(w, parts), finite, meanMs: times.reduce((a, b) => a + b, 0) / times.length, p95Ms: sorted[Math.floor(sorted.length * 0.95)], peakMs: sorted.at(-1) };
  } finally { w.dispose(); }
}

// front-mounts
export function reviewFrontMounts(preset: WeaponPresetId, weapon: WeaponFamilyId, burst = false, seconds = 3, observe: Exclude<FireCaseOptions['observe'], undefined> = null) {
  return runFireCase({ target: 'front-lower-edge', preset, weapon, burst, seconds, follow: burst, observe });
}

export { blastCase, assessVehicleBlast } from './probes-blast.ts';
export { reviewSecondary } from './probes-secondary.ts';
