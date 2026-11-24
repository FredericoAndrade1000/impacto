import type { NativePowertrain, NativeVehicle } from './native-contract.gen.ts';
import type { Point, Pose } from './math.ts';

export interface VehicleConfig { enabled: boolean; chassisId?: string | null }
type PowertrainSummary = Pick<NativePowertrain, 'maxSpeed' | 'powerKw' | 'powerPerTonne' | 'fuelStarved' | 'fuelLitres' | 'rangeKm'>;
export type VehiclePowertrain = PowertrainSummary & Partial<NativePowertrain>;
const VEHICLE_DEFAULTS = Object.freeze({ enabled: true });
export const VEHICLE_ORIGIN = Object.freeze({ x: 12, y: 1.3 });
const EMPTY_POWERTRAIN = Object.freeze({ maxSpeed: 0, powerKw: 0, powerPerTonne: 0, fuelStarved: false, fuelLitres: 0, rangeKm: 0 });

// A vehicle is a presentation of the accepted native state. Driving, mass
// transfer, braking and suspension are executed exclusively by Rust.
export class Vehicle {
  declare config: VehicleConfig;
  declare x: number; declare y: number; declare angle: number;
  declare vx: number; declare vy: number; declare omega: number; declare travel: number;
  declare throttle: number; declare brake: number; declare mass: number;
  declare lastImpulse: number; declare peakImpulse: number; declare fuelRate: number;
  declare drivetrain?: NativePowertrain;
  declare carrierMass?: NativeVehicle['carrierMass'];
  declare carrierInertia?: NativeVehicle['carrierInertia'];
  declare carrierCenter?: NativeVehicle['carrierCenter'];
  declare localCenter?: NativeVehicle['localCenter'];
  declare driveSpeed?: NativeVehicle['driveSpeed'];
  declare traction?: NativeVehicle['traction'];
  declare gearCount?: NativeVehicle['gearCount'];
  declare suspensionCount?: NativeVehicle['suspensionCount'];
  declare groundSlope?: NativeVehicle['groundSlope'];
  declare groundSurface?: NativeVehicle['groundSurface'];
  declare groundGrip?: NativeVehicle['groundGrip'];
  declare groundLoad?: NativeVehicle['groundLoad'];
  declare groundPressureKPa?: NativeVehicle['groundPressureKPa'];
  declare groundResistance?: NativeVehicle['groundResistance'];
  declare softGroundLoad?: NativeVehicle['softGroundLoad'];
  declare slip?: NativeVehicle['slip'];
  declare stuck?: NativeVehicle['stuck'];
  declare rise?: NativeVehicle['rise'];
  declare flying?: NativeVehicle['flying'];
  declare grounded?: NativeVehicle['grounded'];
  declare thrustN?: NativeVehicle['thrustN'];
  declare station?: NativeVehicle['station'];
  declare bounds?: { minX: number; maxX: number };

  constructor(config: Partial<VehicleConfig> = {}, origin: Point = VEHICLE_ORIGIN) {
    this.config = { ...VEHICLE_DEFAULTS, ...config };
    Object.assign(this, origin, { angle: 0, vx: 0, vy: 0, omega: 0, travel: 0,
      throttle: 0, brake: 0, mass: .001, lastImpulse: 0, peakImpulse: 0, fuelRate: 0 });
  }
  get powertrain(): VehiclePowertrain { return this.drivetrain || EMPTY_POWERTRAIN; }
  get engine() { return this.powertrain.powerKw > 0; }
  get availablePowerKw() { return this.powertrain.powerKw; }
  get powerPerTonne() { return this.powertrain.powerPerTonne; }
  get fuelStarved() { return this.powertrain.fuelStarved; }
  get fuelLitres() { return this.powertrain.fuelLitres; }
  get center() {
    const c = Math.cos(this.angle), s = Math.sin(this.angle), p = this.carrierCenter || { x: 0, y: 0 };
    return { x: this.x + c * p.x - s * p.y, y: this.y + s * p.x + c * p.y };
  }
  velocityAt(point: Point): Point {
    const center = this.center;
    return { x: this.vx - this.omega * (point.y - center.y), y: this.vy + this.omega * (point.x - center.x) };
  }
  pose(): Pose { return { x: this.x, y: this.y, angle: this.angle }; }
  snapshot() { const drivetrain = this.drivetrain || EMPTY_POWERTRAIN; return { ...this.pose(), enabled: this.config.enabled, massTonnes: this.mass / 1000, maxSpeed: drivetrain.maxSpeed,
    powerKw: drivetrain.powerKw, powerPerTonne: drivetrain.powerPerTonne,
    fuelStarved: drivetrain.fuelStarved, fuelLitres: drivetrain.fuelLitres,
    vx: this.vx, vy: this.vy, omega: this.omega, travel: this.travel, engine: drivetrain.powerKw > 0, throttle: this.throttle, brake: this.brake, driveSpeed: this.driveSpeed, traction: this.traction ?? 1, gearCount: this.gearCount ?? 0, groundSlope: this.groundSlope || 0,
    groundSurface: this.groundSurface, groundGrip: this.groundGrip || 0, groundLoad: this.groundLoad ?? 1, groundPressureKPa: this.groundPressureKPa || 0,
    groundResistance: this.groundResistance || 0, softGroundLoad: this.softGroundLoad || 0,
    // How much faster than the ground passes the drivetrain turns the running gear, and what keeps the vehicle where it is while it pushes.
    slip: this.slip || 0, stuck: this.stuck ?? null,
    // What its thrusters push with together, and whether its flight computer holds it in the air (game_hover.rs).
    thrustN: this.thrustN || 0, flying: Boolean(this.flying),
    chassisId: this.config.chassisId, lastImpulse: this.lastImpulse, peakImpulse: this.peakImpulse, fuelRate: this.fuelRate,
    // To the tenth of a kilometre: a figure for the panel, not one more number that changes on every frame.
    rangeKm: Math.round(drivetrain.rangeKm * 10) / 10 }; }
}
export type VehicleSnapshot = ReturnType<Vehicle['snapshot']>;
