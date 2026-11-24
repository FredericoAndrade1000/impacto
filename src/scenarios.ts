import { weaponSettings } from './weapons.ts';
import { createConstruction } from './construction-templates.ts';
import { structuredTemplateSource } from './structured-templates.ts';
import { compileBlueprint } from './persistence.ts';
import { closedFrame, labConstruction } from './lab-constructions.ts';
import { MATERIALS } from './materials.ts';
import { power } from './format.ts';
import { chassisSpec, straightChassis } from './chassis.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';
import { cellOf } from './grid.ts';
import type { World } from './physics.ts';
import type { AuthoredConstruction, AuthoredComponent, CompiledModule, CompiledPlate } from './construction-contract.ts';
import type { Point, PlateGeometry } from './math.ts';
import type { WeaponSettings, WeaponFamilyId, WeaponPresetId, AmmoId, WeaponOverrides } from './weapons.ts';

export interface ReferenceScene {
  blueprint: AuthoredConstruction; weapon: WeaponSettings; aim: Point;
  fire?: boolean; drive?: number; settle?: number; distance?: number; vent?: boolean;
  blast?: (Point & {power: number; radius: number}) | null; blastLocation?: string; blastModule?: CompiledModule['kind'];
}
export type ReferencePlate = CompiledPlate | { id: string; definition: PlateGeometry };
export interface ReferenceGeometry<Plate extends ReferencePlate = ReferencePlate> {
  modules: readonly Pick<CompiledModule, 'kind' | 'weaponMount' | 'x' | 'y' | 'angle' | 'width' | 'height'>[];
  plates: readonly Plate[];
}
interface BlastOriginSpec {
  edge?: 'front' | 'rear' | 'roof'; weaponHost?: boolean; u?: number; standoff?: number;
  moduleColumn?: CompiledModule['kind']; runningGear?: boolean; below?: number; module?: CompiledModule['kind'];
}


// The scenes the tests and the probes of the physics run on: a construction each, and the shot, the blast or the
// drive done to it.
export const REFERENCE_IDS: readonly string[] = ['blocked', 'penetration', 'concrete', 'internal', 'weapon', 'enclosure', 'vented',
  'concrete-burst', 'components', 'rocketbox', 'vehicle-roof', 'vehicle-front', 'vehicle-toe', 'track-edge',
  'spall', 'spall-components', 'blast-spall', 'ground-ricochet', 'blast-standoff', 'blast-contact',
  'blast-closed', 'blast-open', 'blast-distance', 'blast-vehicle', 'blast-light-vehicle', 'artillery-light-roof',
  'light-wheel-fire', 'angled-joint', 'vehicle-blast-front', 'vehicle-blast-rear', 'vehicle-blast-roof',
  'vehicle-blast-track', 'artillery-mortar', 'artillery-howitzer', 'drive-tracks', 'drive-wheels',
  'drive-mixed-tracks', 'drive-mixed-wheels'];

export function lightRoofBlueprint(): AuthoredConstruction {
  const source = structuredTemplateSource('mortar'); source.name = 'Morteiro no veículo leve'; source.terrain = 'flat';
  // Its plates of steel 5 mm thick, and the glass of its vision block as thin as glass comes.
  for (const plate of source.plates) plate.thicknessMm = Math.max(5, MATERIALS[plate.material].minThicknessMm);
  return source;
}
export function lightWheelBlueprint(): AuthoredConstruction {
  // Explicit closed laboratory vehicle: changing the stock scout must not
  // change the 39 kW impact experiment on its two-axle wheeled chassis or add a gun bay to it.
  // Its bench stands 5 m before its front: the 4.25 m tube of the 120 mm gun it is shot with ends short of it. Its engine
  // and its tank keep the room they had, and so their mass and the 25 L of the tank, about the same middles: a size is
  // the square root of their share of the room of one of 100 %.
  const source = labConstruction({ name: `Impacto no veículo · ${power(39)}`, length: 4.8, height: 1.8,
    thicknessMm: 5, otherThicknessMm: 5, rideHeight: chassisSpec('wheeled').deck + .0025, launcher: { x: 4.6, y: 1.7 } });
  return { ...source, preset: 'vehicle', chassis: straightChassis('wheeled', cellOf(-2.4), cellOf(2.4)),
    components: [
      { id: 'engine', kind: 'engine', sizeScale: Math.sqrt(39 / 180),
        pose: { x: cellOf(-1.35), y: cellOf(1.4456666666666664 - VEHICLE_ORIGIN.y), angle: 0 } },
      { id: 'fuel', kind: 'fuel', sizeScale: Math.sqrt(.125),
        pose: { x: cellOf(1.2), y: cellOf(1.5456666666666665 - VEHICLE_ORIGIN.y), angle: 0 } },
    ] };
}
export const VEHICLE_BLAST_ORIGINS = Object.freeze({
  front: { edge: 'front', standoff: .15 }, rear: { edge: 'rear', standoff: .15 },
  roof: { edge: 'roof', weaponHost: true, u: .65, standoff: .15 },
  'hull-roof': { edge: 'roof', moduleColumn: 'ammo', standoff: .15 },
  track: { runningGear: true, standoff: .15, below: .25 }, internal: { module: 'fuel' },
  distant: { edge: 'front', standoff: 2.8 },
} satisfies Record<string, BlastOriginSpec>);
const geometryDefinition = (plate: ReferencePlate): PlateGeometry => 'definition' in plate ? plate.definition : plate;
export function vehicleRoof<Plate extends ReferencePlate>(geometry: ReferenceGeometry<Plate>): Plate {
  const host = geometry.modules.find(module => module.kind === 'weapon')?.weaponMount?.hostId,
    body = host ? host.slice(0, host.lastIndexOf(':')) : 'hull',
    roof = geometry.plates.find(plate => plate.id === `${body}:roof`);
  if (!roof) throw new Error('Teto autorado do armamento ausente: ' + body);
  return roof;
}
export type VehicleBlastLocation = keyof typeof VEHICLE_BLAST_ORIGINS;
const isBlastLocation = (location: string): location is VehicleBlastLocation => Object.hasOwn(VEHICLE_BLAST_ORIGINS, location);
export function vehicleBlastOrigin(geometry: ReferenceGeometry, location: string): Point {
  if (!isBlastLocation(location)) throw new Error('Local de explosão desconhecido: ' + location);
  const spec: BlastOriginSpec = VEHICLE_BLAST_ORIGINS[location];
  if (!spec) throw new Error('Local de explosão desconhecido: ' + location);
  if (spec.module) {
    const module = geometry.modules.find(part => part.kind === spec.module);
    if (!module) throw new Error('Componente da explosão ausente: ' + spec.module);
    return { x: module.x, y: module.y };
  }
  if (spec.runningGear) {
    const gear = geometry.modules.filter(part => ['track', 'wheel'].includes(part.kind))
      .sort((a, b) => a.x - b.x)[0];
    if (!gear) throw new Error('Rodagem do ensaio de explosão ausente.');
    // Ahead of the gear, a quarter of its height under its axis: the nose of a tracked chassis covers the upper half
    // of the front curve of its track.
    const distance = gear.width / 2 + Number(spec.standoff), drop = gear.height * Number(spec.below), angle = gear.angle || 0,
      c = Math.cos(angle), s = Math.sin(angle);
    return { x: gear.x - c * distance + s * drop, y: gear.y - s * distance - c * drop };
  }
  const plate = spec.weaponHost ? vehicleRoof(geometry) : geometry.plates.find(part => part.id === `hull:${spec.edge}`);
  if (!plate) throw new Error('Parede da explosão ausente: ' + spec.edge);
  const d = geometryDefinition(plate), c = Math.cos(d.angle), s = Math.sin(d.angle),
    module = spec.moduleColumn && geometry.modules.find(part => part.kind === spec.moduleColumn);
  if (spec.moduleColumn && !module) throw new Error('Coluna da explosão ausente: ' + spec.moduleColumn);
  const along = module ? (module.x - d.x) * c + (module.y - d.y) * s : ((spec.u ?? .5) - .5) * d.length,
    distance = Number(spec.standoff) + d.thicknessMm / 2000;
  return { x: d.x + c * along + s * distance, y: d.y + s * along - c * distance };
}
export function angledJointBlueprint(thicknessMm = 100): AuthoredConstruction {
  const source = labConstruction({ name: 'Encontro de bordas · ' + thicknessMm + ' mm', thicknessMm });
  return Object.assign(source, closedFrame(([[-1, 0], [3, 0], [3, 3], [-1, 3], [-2, 1.5]] satisfies [number, number][]).map(([x, y]): [number, number] => [x, y + .15 - VEHICLE_ORIGIN.y]),
    ['floor', 'rear', 'roof', 'upper-front', 'lower-front'], () => ({ material: 'steel', thicknessMm })));
}
export function applyReferenceScene(world: World, scene: ReferenceScene) {
  if (scene.settle) { for (let i = 0; i < scene.settle; i++) world.step(); world.drainEvents(); }
  if (scene.distance != null) world.setTestDistance(scene.distance);
  if (scene.vent) {
    const front = world.plates.find(plate => plate.definition.id.endsWith('hull:front'));
    if (!front) throw new Error('Parede da abertura ausente.');
    const point = front.definition;
    world.cutBody(front, { x: point.x, y: point.y - .2 }, { x: point.x, y: point.y + .2 }, .26);
  }
  if (scene.blast) {
    const point = scene.blastLocation ? vehicleBlastOrigin(world, scene.blastLocation) :
      scene.blastModule ? world.modules.find(module => module.kind === scene.blastModule) : scene.blast;
    if (!point) throw new Error('Alvo da explosão ausente.');
    world.explode(point.x, point.y, scene.blast.power, scene.blast.radius);
  }
  if (scene.drive) world.controlVehicle(scene.drive);
  if (scene.fire !== false) world.fire(scene.aim, scene.weapon, true);
}
const gun = (family: WeaponFamilyId = 'cannon', preset: WeaponPresetId = 'rh120', ammo: AmmoId = 'ap', extra: WeaponOverrides = {}) =>
  weaponSettings(family, { preset, ammo, spread: 0, ...extra });
function target(source: AuthoredConstruction, kind?: CompiledModule['kind']): Point {
  const dto = compileBlueprint(source), part = dto.modules.find(module => module.kind === kind);
  if (part) return { x: part.x, y: part.y };
  const front = dto.plates.find(plate => plate.id.endsWith('hull:front'));
  if (!front) throw new Error('Parede frontal do ensaio ausente.');
  return { x: front.x, y: front.y };
}
function vehicleScene(id: string): ReferenceScene {
  const source = createConstruction('heavy'); source.terrain = 'flat'; source.name = id;
  return { blueprint: source, weapon: gun(), aim: target(source) };
}
export function referenceScenario(id: string): ReferenceScene {
  if (!REFERENCE_IDS.includes(id)) throw new Error('Ensaio inexistente: ' + id);
  if (id.startsWith('drive-')) {
    const source = createConstruction(id.endsWith('wheels') ? 'scout' : 'heavy');
    source.terrain = id.includes('mixed') ? 'mixed' : 'rough';
    return { blueprint: source, weapon: gun('machinegun', 'm2hb'), aim: { x: 30, y: 2 }, fire: false, drive: .65 };
  }
  if (id === 'light-wheel-fire' || id === 'artillery-light-roof') {
    const source = id === 'light-wheel-fire' ? lightWheelBlueprint() : lightRoofBlueprint();
    return { blueprint: source, weapon: id === 'light-wheel-fire' ? gun() : gun('mortar', 'm252', 'he', { trajectory: 'high' }),
      aim: target(source, 'engine'), settle: 60 };
  }
  if (id.startsWith('vehicle-blast-') || ['blast-vehicle', 'blast-light-vehicle'].includes(id)) {
    const source = createConstruction(id === 'blast-light-vehicle' ? 'ifv' : 'heavy'),
      location = id.startsWith('vehicle-blast-') ? id.slice('vehicle-blast-'.length) : 'internal',
      origin = vehicleBlastOrigin(compileBlueprint(source), location);
    return { blueprint: source, weapon: gun('grenade', 'mk19', 'he'), aim: origin, fire: false,
      settle: 60, blastLocation: location, blast: { ...origin, power: 600, radius: 4.5 } };
  }
  if (['internal', 'weapon', 'components', 'vehicle-front', 'vehicle-toe', 'vehicle-roof', 'track-edge',
    'artillery-mortar', 'artillery-howitzer'].includes(id)) {
    const scene = vehicleScene(id);
    scene.aim = target(scene.blueprint, id === 'weapon' ? 'weapon' : id === 'track-edge' ? 'track' : 'engine');
    if (id === 'vehicle-roof' || id === 'artillery-mortar') {
      const roof = vehicleRoof(compileBlueprint(scene.blueprint));
      scene.aim = { x: roof.x + Math.cos(roof.angle) * .15 * roof.length,
        y: roof.y + Math.sin(roof.angle) * .15 * roof.length };
    }
    if (id.startsWith('artillery-')) {
      const mortar = id === 'artillery-mortar'; scene.weapon = gun(mortar ? 'mortar' : 'howitzer', mortar ? 'm252' : 'm119', 'he',
        { trajectory: mortar ? 'high' : 'low', detonation: 'impact' }); scene.distance = 60;
    }
    return scene;
  }
  if (id === 'angled-joint') return { blueprint: angledJointBlueprint(), weapon: gun('autocannon', 'rh202'),
    aim: { x: 10, y: 1.65 }, fire: false };
  const components: AuthoredComponent[] = ['spall-components', 'blast-spall'].includes(id)
    ? [{ id: 'engine', kind: 'engine', sizeScale: .75, pose: { x: .7, y: .7175 - VEHICLE_ORIGIN.y, angle: 0 } }] : [];
  const source = labConstruction({ name: id, thicknessMm: id === 'blocked' ? 180 : id.includes('spall') ? 50 : 100,
    material: id.startsWith('concrete') ? 'concrete' : 'steel', components });
  if (id.startsWith('concrete')) {
    const front = source.plates.find(plate => plate.id === 'hull:front');
    if (!front) throw new Error('Parede frontal do ensaio ausente.');
    front.thicknessMm = 480;
  }
  const aim = target(source), scene: ReferenceScene = { blueprint: source, weapon: id === 'blocked' ? gun('machinegun', 'm2hb') : gun(), aim };
  if (id === 'concrete-burst') scene.weapon = gun('machinegun', 'fnmag');
  if (id === 'ground-ricochet') { source.launcher = { x: 7, y: .75 }; scene.aim = { x: 10, y: .05 }; }
  if (['enclosure', 'vented', 'rocketbox'].includes(id) || id.startsWith('blast-')) {
    scene.fire = false; scene.vent = ['vented', 'blast-open'].includes(id);
    scene.blast = { x: id === 'blast-standoff' ? 9 : id === 'blast-contact' ? aim.x - .05 : id === 'blast-distance' ? 6 : 12,
      y: 1.65, power: 600, radius: 4.5 };
    if (id === 'rocketbox') { scene.fire = true; scene.blast = null; source.launcher = { x: 11.2, y: 1.65 };
      scene.weapon = gun('rocket', 'at4', 'he'); scene.aim = { x: 14, y: 1.65 }; }
  }
  return scene;
}


