import { nativeBallisticFlight } from './native-dynamics.ts';
import type { BallisticLauncher, BallisticSettings, FlightSolution, FlightState, FlightTrajectory, InheritedMotion, MountedBallisticLauncher } from './ballistic-contract.ts';
import type { Point } from './math.ts';
export { FLIGHT_HORIZON } from './weapons.ts';

export const GRAVITY = 9.81;

export function chargeSpeed(settings: Pick<BallisticSettings, 'charge' | 'speed' | 'variableCharge'>, charge = typeof settings.charge === 'number' ? settings.charge : 1): number {
  return settings.speed * Math.sqrt(settings.variableCharge ? charge : 1);
}

// One Rust flight model serves simulation, player assistance and rendering.
export function firingSolution(launcher: BallisticLauncher, aim: Point, settings: BallisticSettings, inherited: InheritedMotion = { x: 0, y: 0 }): FlightSolution {
  return nativeBallisticFlight({ op: 'solution', launcher, aim, settings, inherited });
}

export function mountedFiringSolution(launcher: MountedBallisticLauncher, aim: Point, settings: BallisticSettings, inherited: InheritedMotion = { x: 0, y: 0 }): FlightSolution {
  return nativeBallisticFlight({ op: 'mounted', launcher, aim, settings, inherited });
}

export function flightState(solution: FlightTrajectory, time: number): FlightState {
  return nativeBallisticFlight({ op: 'point', solution, time });
}

export function flightPoint(solution: FlightTrajectory, time: number): Point {
  const { x, y } = flightState(solution, time);
  return { x, y };
}

export function flightPath(solution: FlightTrajectory, count = 64, endTime = solution.time): FlightState[] {
  return nativeBallisticFlight({ op: 'path', solution, count, endTime });
}
