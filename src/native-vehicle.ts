import type { NativeVehicle, NativePowertrain } from './native-contract.gen.ts';
import type { Point } from './math.ts';

// The live projection and World.keep share this list of state owned by Rust.
export const VEHICLE_STATE = ['x', 'y', 'angle', 'vx', 'vy', 'omega', 'travel', 'driveSpeed', 'throttle', 'brake', 'traction', 'gearCount',
  'suspensionCount', 'groundSlope', 'groundSurface', 'groundGrip', 'groundLoad', 'groundPressureKPa', 'groundResistance', 'softGroundLoad',
  'lastImpulse', 'peakImpulse', 'fuelRate', 'slip', 'stuck', 'carrierMass', 'carrierInertia', 'carrierCenter', 'localCenter',
  'rise', 'flying', 'grounded', 'thrustN', 'station'] as const satisfies readonly (keyof NativeVehicle)[];

type VehicleState = Pick<NativeVehicle, (typeof VEHICLE_STATE)[number]>;
type SeparatelyHandled = 'enabled' | 'massTonnes' | 'drivetrain';
// Vehicle getters read these summaries from drivetrain, rather than storing a second copy.
type PowertrainSummaries = 'maxSpeed' | 'powerKw' | 'powerPerTonne' | 'fuelStarved' | 'fuelLitres' | 'engine';
// mass duplicates massTonnes in kg; inertia and accumulated slip belong to the Rust solver.
type ExplicitlyUnused = PowertrainSummaries | 'mass' | 'inertia' | 'slipped';
type AssertNever<T extends never> = T;
type VehicleContractCoverage = AssertNever<Exclude<keyof NativeVehicle, keyof VehicleState | SeparatelyHandled | ExplicitlyUnused>>;

type VehicleTarget = Partial<VehicleState> & {
  config: { enabled?: boolean };
  mass: number;
  drivetrain?: NativePowertrain;
};

function copyState<K extends keyof VehicleState>(target: Partial<VehicleState>, state: VehicleState, key: K): void {
  if (state[key] !== undefined) target[key] = state[key];
}

export function applyNativeVehicle(target: VehicleTarget, state: NativeVehicle): void {
  if (state.enabled !== undefined) target.config.enabled = state.enabled;
  for (const key of VEHICLE_STATE) copyState(target, state, key);
  target.mass = state.massTonnes * 1000;
  target.drivetrain = state.drivetrain;
}

// A live frame tells a vehicle in numbers (game_dto.rs `NativeVehicle::numbers`), read here in the order
// they were written; its two names, the ground it stands on and what holds it, come as words.
export interface NumberReader { next(): number; flag(): boolean; point(): Point; optional(): number | null }
export const VEHICLE_NUMBERS = 39 + 19;
export function readNativeVehicle(target: VehicleTarget, r: NumberReader): void {
  target.x = r.next(); target.y = r.next(); target.angle = r.next(); target.config.enabled = r.flag(); target.mass = r.next() * 1000;
  target.carrierMass = r.next(); target.carrierInertia = r.next(); target.localCenter = r.point(); target.carrierCenter = r.point();
  target.vx = r.next(); target.vy = r.next(); target.omega = r.next(); target.travel = r.next(); target.throttle = r.next(); target.brake = r.next();
  target.traction = r.next(); target.gearCount = r.next(); target.suspensionCount = r.next(); target.driveSpeed = r.next();
  target.groundSlope = r.next(); target.groundGrip = r.next(); target.groundLoad = r.next(); target.groundPressureKPa = r.next();
  target.groundResistance = r.next(); target.softGroundLoad = r.next(); target.lastImpulse = r.next(); target.peakImpulse = r.next();
  target.fuelRate = r.next(); target.slip = r.next(); target.rise = r.next(); target.flying = r.flag(); target.grounded = r.flag();
  target.thrustN = r.next(); target.station = [r.optional(), r.optional()];
  target.drivetrain = { powerKw: r.next(), torqueNm: r.next(), efficiency: r.next(), rollingCoefficient: r.next(), drag: r.next(),
    dragAstern: r.next(), dragOver: r.next(), dragUnder: r.next(), radius: r.next(), maxDriveForce: r.next(), gearedSpeed: r.optional(),
    maxSpeed: r.next(), powerPerTonne: r.next(), fueled: r.flag(), fuelLitres: r.next(), rangeKm: r.next(), fuelStarved: r.flag(),
    tracked: r.flag() };
}
