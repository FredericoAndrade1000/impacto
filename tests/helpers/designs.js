import { closedFrame } from '../../src/lab-constructions.ts';
import { chassisSpec, straightChassis } from '../../src/chassis.ts';
import { VEHICLE_ORIGIN } from '../../src/vehicle.ts';
import { DESIGN_VERSION } from '../../src/persistence.ts';
import { CELL, cellOf } from '../../src/grid.ts';

// Vehicles written for the tests as the workshop writes them: a design on one chassis of the catalogue, whose
// running gear comes with it, laid out in metres and written on the cells of the grid (grid.ts). Nothing here converts
// an old design; these are current authors.

// The chassis of `model` under a floor from `front` to `rear` (local x, a design faces left): as long as the floor,
// or as the model is made at the shortest, and centred under it, its ends on the cells just outside.
function span(model, front, rear) {
  const [shortest, longest] = chassisSpec(model).length, length = rear - front, half = Math.max(shortest, length) / 2;
  if (length > longest + 1e-9) throw new Error(`A floor of ${length} m is longer than ${model} is made.`);
  return straightChassis(model, Math.floor(((front + rear) / 2 - half) / CELL + 1e-9), Math.ceil(((front + rear) / 2 + half) / CELL - 1e-9));
}

// A closed box of four plates, floor, rear, roof and front, standing on a chassis: by default a wheeled
// one. `thicknessMm` is every wall; `thicknesses` sets some apart by side.
export function vehicleBox({ length = 4.3, height = 2.1, thicknessMm = 10, thicknesses = {}, material = 'steel',
  model = 'wheeled', components = [], name = 'Ensaio sobre chassi', seed = 77, ...rest } = {}) {
  const floor = chassisSpec(model).deck + (thicknesses.floor ?? thicknessMm) / 2000 - VEHICLE_ORIGIN.y;
  return { version: DESIGN_VERSION, preset: 'vehicle', name, seed, ...rest,
    chassis: span(model, -length / 2, length / 2),
    ...closedFrame([[-length / 2, floor], [length / 2, floor], [length / 2, floor + height], [-length / 2, floor + height]],
      ['floor', 'rear', 'roof', 'front'], side => ({ material, thicknessMm: thicknesses[side] ?? thicknessMm })),
    components: writtenParts(components) };
}

// A pose laid out in metres as a design writes it, on the cell nearest (grid.ts); and parts with such poses.
export const writtenPose = ({ x, y, ...rest }) => ({ ...rest, x: cellOf(x), y: cellOf(y) });
export const writtenParts = parts => structuredClone(parts).map(part => part.pose ? { ...part, pose: writtenPose(part.pose) } : part);

// The same design with no chassis: a fixed structure, standing with its floor where the deck held it, that does not
// drive (what a vehicle is not, now that one drives exactly when it has a chassis).
export function standing(source) {
  const { chassis, ...design } = structuredClone(source);
  return { ...design, preset: 'bunker' };
}

// Where a point of the design, in its own metres, stands on the field before the vehicle moves.
export const onField = (compiled, { x, y }) => ({ x: compiled.frame.origin.x + x, y: compiled.frame.origin.y + y });

// Explicit assay stock: keep the closed hull joined to a thicker deck, internal equipment above its upper face,
// and wall/roof equipment with the hull. The compiler still admits the resulting geometry without repairs.
export function withRaisedFloor(input, thicknessMm) {
  const source = structuredClone(input), lift = (thicknessMm - source.chassis.topPlate.thicknessMm) / 1000 / CELL;
  source.chassis.topPlate.thicknessMm = thicknessMm;
  // Room boundaries meet the deck plate's centreline, while internal equipment clears its upper face.
  for (const node of source.nodes) node.y += lift / 2;
  for (const part of source.components) part.pose.y += ['weapon', 'sensor'].includes(part.kind) ? lift / 2 : lift;
  return source;
}
