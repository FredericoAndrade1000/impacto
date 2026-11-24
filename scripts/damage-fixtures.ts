import { closedFrame } from '../src/lab-constructions.ts';
import { chassisSpec, straightChassis } from '../src/chassis.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { VEHICLE_ORIGIN } from '../src/vehicle.ts';
import { cellOf, metresOf } from '../src/grid.ts';
import assert from 'node:assert/strict';
import type { AuthoredComponent, AuthoredConstruction, AuthoredPlate, ChassisModelId } from '../src/construction-contract.ts';
import type { MaterialId } from '../src/materials.ts';
import type { TerrainId } from '../src/terrain.ts';
import type { Point } from '../src/math.ts';
import type { World } from '../src/physics.ts';

export interface DamageConstructionOptions {
  length?: number; height?: number; rideHeight?: number; frontThickness?: number; wallThickness?: number;
  material?: MaterialId; incidence?: number; dynamic?: boolean; chassis?: ChassisModelId | null;
  components?: readonly AuthoredComponent[]; seed?: number; terrain?: TerrainId;
  thicknesses?: Partial<Record<'floor' | 'front' | 'rear' | 'roof', number>>;
}


// Authored closed laboratory hulls. This file accepts dimensions and valid
// component poses in metres, and writes them on the cells nearest (grid.ts), never generated mechanical DTOs.
export function interior<Kind extends AuthoredComponent['kind']>(kind: Kind, pose: Point & {angle?: number}, id?: string): {id: string; kind: Kind; pose: Point & {angle: number}};
export function interior<Kind extends AuthoredComponent['kind'], Options extends object>(kind: Kind, pose: Point & {angle?: number}, id: string | undefined, options: Options & {id?: never; kind?: never; pose?: never}): {id: string; kind: Kind; pose: Point & {angle: number}} & Options;
export function interior(kind: AuthoredComponent['kind'], pose: Point & {angle?: number}, id: string = kind, options: object = {}) {
  return {id, kind, ...options, pose: {angle: 0, ...pose}};
}

// One that moves (`dynamic`) is a vehicle on `chassis`, by default a wheeled one, at
// least 3.5 m long so that its axles carry the armoured front. rideHeight is a
// laboratory layout argument; the returned design stores only physical poses. A front at an `incidence` (degrees from
// upright) leans back from a nose of its own armour, a cell taller than the front is thick, on the cells nearest: laid
// on the floor itself, so sharp a corner would put the metal of the one in the other (`Frame::meet` in the core).
export function damageConstruction({ length = 3, height = 2, rideHeight = .7,
  frontThickness = 80, wallThickness = 5, material = 'steel', incidence = 0,
  dynamic = false, chassis = dynamic ? 'wheeled' : null,
  components = [], seed = 6173, terrain = 'flat', thicknesses = {} }: DamageConstructionOptions = {}): AuthoredConstruction {
  const model = chassisSpec(chassis), span = model && Math.max(length, 3.5), floor = model ? model.deck + (thicknesses.floor ?? wallThickness) / 2000 : rideHeight,
    localFloor = floor - VEHICLE_ORIGIN.y, armour = (side: 'floor' | 'rear' | 'roof' | 'front'): Pick<AuthoredPlate, 'material' | 'thicknessMm'> => ({ material: side === 'front' ? material : 'steel',
      thicknessMm: thicknesses[side] ?? (side === 'front' ? frontThickness : wallThickness) }),
    frame = closedFrame([[-length / 2, localFloor], [length / 2, localFloor], [length / 2, localFloor + height], [-length / 2, localFloor + height]],
      ['floor', 'rear', 'roof', 'front'], armour);
  if (incidence > 0) {
    const [foot, , , top] = frame.nodes;
    assert(foot && top, 'Closed damage hull needs four corners.');
    const nose = { id: 'hull-nose', x: foot.x, y: foot.y + cellOf(armour('front').thicknessMm / 1000) + 1 };
    top.x += cellOf(metresOf(top.y - nose.y) * Math.tan(incidence * Math.PI / 180));
    frame.nodes.push(nose); const front = frame.plates.find(plate => plate.id === 'hull:front');
    assert(front, 'Closed damage hull needs its front.'); front.b = nose.id;
    frame.plates.push({ id: 'hull:nose', a: nose.id, b: foot.id, ...armour('front') });
  }
  const parts = structuredClone(components).map(part => part.pose
    ? { ...part, pose: { ...part.pose, x: cellOf(part.pose.x), y: cellOf(part.pose.y) } } : part);
  return model && chassis && span !== undefined ?
    { version: DESIGN_VERSION, preset: 'vehicle', name: 'Ensaio de dano fechado', seed, terrain,
      launcher: { x: 1.65, y: floor + height / 2 },
      chassis: straightChassis(chassis, cellOf(-span / 2), cellOf(span / 2)), ...frame, components: parts } :
    { version: DESIGN_VERSION, preset: 'bunker', name: 'Ensaio de dano fechado', seed, terrain,
      launcher: { x: 1.65, y: floor + height / 2 }, ...frame, components: parts };
}

export function face(world: World, id = 'front', actorId = 'local') {
  const plate = world.plates.find(part => part.actorId === actorId &&
    (part.id === `hull:${id}` || part.id.endsWith(`:hull:${id}`) ||
      id === 'floor' && (part.id === 'chassis:top-0' || part.id.endsWith(':chassis:top-0'))));
  if (!plate) throw new Error(`Missing authored laboratory wall: hull:${id}`);
  return plate;
}
