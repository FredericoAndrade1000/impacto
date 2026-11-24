import type { Point } from './math.ts';
import type { WeaponSettings } from './weapons.ts';

export type BallisticSettings = WeaponSettings;
export type BallisticLauncher = Point & (
  { weaponMount?: null; angle?: number } |
  { weaponMount: { min: number; max: number }; angle: number }
);
export type MountedBallisticLauncher = BallisticLauncher & { barrelAngle: number };
export interface InheritedMotion extends Point { omega?: number | undefined }

// Wire fields published by game_flight.rs::Drag and game_weapons.rs::flight_request.
export interface FlightModel {
  model: 'quadratic-drag-v2'; mass: number; caliberMm: number; family: string;
  dragCoefficient: number; airDensity: number; scaleHeight: number;
}
export interface FlightState extends Point { vx: number; vy: number; time: number }
export interface FlightTrajectory extends FlightState { flightLimit: number; flight: FlightModel }
export interface FlightSolution extends FlightTrajectory {
  angle: number; speed: number; charge: number; reachable: boolean;
  distance: number; target: Point; apex: number; limit: 'range' | 'sector' | 'near' | null; miss: number;
}
export interface SolutionRequest {
  op: 'solution'; launcher: BallisticLauncher; aim: Point; settings: BallisticSettings; inherited?: InheritedMotion | null;
}
export interface MountedRequest {
  op: 'mounted'; launcher: MountedBallisticLauncher; aim: Point; settings: BallisticSettings; inherited?: InheritedMotion | null;
}
export interface PointRequest { op: 'point'; solution: FlightTrajectory; time: number }
export interface PathRequest { op: 'path'; solution: FlightTrajectory; count: number; endTime?: number }
export type BallisticRequest = SolutionRequest | MountedRequest | PointRequest | PathRequest;
export type BallisticReply = FlightSolution | FlightState | FlightState[];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const point = (value: unknown): value is Point => record(value) && finite(value.x) && finite(value.y);

function flightState(value: unknown): value is FlightState {
  return record(value) && point(value) && finite(value.vx) && finite(value.vy) && finite(value.time);
}
function flightModel(value: unknown): value is FlightModel {
  return record(value) && value.model === 'quadratic-drag-v2' && finite(value.mass) && finite(value.caliberMm) &&
    typeof value.family === 'string' && finite(value.dragCoefficient) && finite(value.airDensity) && finite(value.scaleHeight);
}
function flightSolution(value: unknown): value is FlightSolution {
  return record(value) && flightState(value) && flightModel(value.flight) && finite(value.flightLimit) &&
    finite(value.angle) && finite(value.speed) && finite(value.charge) && typeof value.reachable === 'boolean' &&
    finite(value.distance) && point(value.target) && finite(value.apex) && finite(value.miss) &&
    (value.limit === null || value.limit === 'range' || value.limit === 'sector' || value.limit === 'near');
}
function flightPath(value: unknown): value is FlightState[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 513) return false;
  for (const state of value) if (!flightState(state)) return false;
  return true;
}

export function decodeBallisticReply(op: 'solution' | 'mounted', value: unknown): FlightSolution;
export function decodeBallisticReply(op: 'point', value: unknown): FlightState;
export function decodeBallisticReply(op: 'path', value: unknown): FlightState[];
export function decodeBallisticReply(op: BallisticRequest['op'], value: unknown): BallisticReply;
export function decodeBallisticReply(op: BallisticRequest['op'], value: unknown): BallisticReply {
  if ((op === 'solution' || op === 'mounted') && flightSolution(value)) return value;
  if (op === 'point' && flightState(value)) return value;
  if (op === 'path' && flightPath(value)) return value;
  throw new TypeError(`Invalid Native ballistic reply for ${op}.`);
}
