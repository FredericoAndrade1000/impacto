import { firingSolution, mountedFiringSolution, flightPath } from './ballistics.ts';
import { predictImpact, snapshotCollisionIndex } from './impact-preview.ts';
import { sceneFrame } from './scene-frame.ts';
import { presentedPivotVelocity } from './weapon-presentation.ts';
import { muzzleObstruction } from './weapon-geometry.ts';
import { tr } from './i18n.ts';
import type { CollisionIndex } from './collision.ts';
import type { PreviewOwner, ImpactPrediction, PreviewScene, PreviewModule, PreviewVehicle } from './impact-preview.ts';
import type { PathForecast } from './weapon-presentation.ts';
import type { FlightSolution } from './ballistic-contract.ts';
import type { Point } from './math.ts';
import type { WeaponSettings } from './weapons.ts';
import type { Terrain } from './terrain.ts';

export interface AimScene extends PreviewScene { controlledActor?: string | null | undefined }
export type SceneWeapon = PreviewModule & { kind: 'weapon'; barrelAngle: number; weaponMount: NonNullable<PreviewModule['weaponMount']> };
export const observedWeapon = (module: PreviewModule): module is SceneWeapon => module.kind === 'weapon' && typeof module.barrelAngle === 'number' && module.weaponMount != null;
const movingBody = (body: PreviewVehicle | null | undefined): body is PreviewVehicle & Point & { angle: number } => Number.isFinite(body?.x) && Number.isFinite(body?.y) && Number.isFinite(body?.angle);
export interface AimForecast extends PathForecast {
  state: AimScene; solution: FlightSolution; weapon: WeaponSettings; terrain: Terrain;
  gun: string | undefined; marks: Point[];
}

// A controlled construction never borrows a target's gun for its forecast.
export function selectedLauncher(state: AimScene | null | undefined, weapon: WeaponSettings | null | undefined): SceneWeapon | null {
  if (weapon?.platform !== 'vehicle' || !weapon.componentId || !state) return null;
  const actorId = state.controlledActor || 'local';
  return state.modules.find((module): module is SceneWeapon => module.id === weapon.componentId && module.actorId === actorId && observedWeapon(module) &&
    Number(module.health) > 0 && !module.barrelDisabled && module.attached !== false) || null;
}

// Physical queries use one immutable snapshot, independently of the sampled
// artwork, camera and GPU. All their retained state is released together.
export class AimQueries {
  declare state: AimScene | null;
  declare index: CollisionIndex<PreviewOwner> | null;
  declare solutionCache: { key: string; value: FlightSolution } | null;
  declare impactCache: { key: string; value: ImpactPrediction | null } | null;
  declare forecastCache: AimForecast | null;
  declare marksCache: { solution: FlightSolution; flight: number; points: Point[] } | null;
  constructor() { this.clear(); }
  clear() {
    this.state = this.index = this.solutionCache = this.impactCache = this.forecastCache = this.marksCache = null;
  }
  solution(state: AimScene | null | undefined, weapon: WeaponSettings, aim: Point, mounted: boolean) {
    const launcher = selectedLauncher(state, weapon);
    if (!launcher) return null;
    const body = sceneFrame(state!).actors.get(launcher.actorId || 'local')?.vehicle,
      inherited = movingBody(body) ? presentedPivotVelocity(body, launcher) : undefined,
      key = JSON.stringify([mounted, launcher.x, launcher.y, launcher.angle,
        launcher.weaponMount?.min, launcher.weaponMount?.max, mounted ? launcher.barrelAngle : null,
        aim, weapon, inherited], (_, value) => Object.is(value, -0) ? '-0' : value);
    if (this.solutionCache?.key === key) return this.solutionCache.value;
    const solve = mounted ? mountedFiringSolution : firingSolution,
      value = solve(launcher, aim, weapon, inherited);
    this.solutionCache = { key, value }; return value;
  }
  // Refit geometry once per new snapshot, reusing its collision index. The
  // result of an older impact query must not survive that refit, even a miss.
  scene(state: AimScene): CollisionIndex<PreviewOwner> {
    if (this.state !== state) {
      this.state = state; this.index = snapshotCollisionIndex(state, this.index); this.impactCache = null;
    }
    return this.index!;
  }
  impact(state: AimScene | null | undefined, solution: FlightSolution | null | undefined, weapon: WeaponSettings) {
    if (!state || !solution) return null;
    const index = this.scene(state), key = [solution.x, solution.y, solution.vx, solution.vy, solution.time,
      JSON.stringify(solution.flight), weapon.platform, weapon.componentId, weapon.ammo, weapon.power].join(':');
    if (this.impactCache?.key !== key) this.impactCache = { key, value: predictImpact(state, solution,
      { platform: weapon.platform, componentId: weapon.componentId, actorId: state.controlledActor, ammo: weapon.ammo, power: weapon.power }, index) };
    return this.impactCache.value;
  }
  obstruction(state: AimScene | null | undefined, solution: FlightSolution | null | undefined, weapon: WeaponSettings, ground: Terrain) {
    const launcher = solution && selectedLauncher(state, weapon);
    // A sector/range refusal is not an authorized flight at the current barrel.
    if (!launcher || solution!.reachable === false) return null;
    const mouth = muzzleObstruction(this.scene(state!), ground, launcher, solution!, weapon.radius);
    if (mouth) return mouth;
    const impact = this.impact(state, solution, weapon);
    return impact?.owner.object?.actorId === launcher.actorId ? { ...impact, own: true, reason: tr('O próprio veículo está na linha de tiro') } : null;
  }
  ally(state: AimScene | null | undefined, solution: FlightSolution | null | undefined, weapon: WeaponSettings) {
    const launcher = solution && selectedLauncher(state, weapon), impact = launcher && this.impact(state, solution, weapon),
      own = state?.actors?.find(actor => actor.id === launcher?.actorId), met = state?.actors?.find(actor => actor.id === impact?.owner.object?.actorId);
    return own && met && met !== own && !met.defeated && own.team != null && met.team === own.team ? impact : null;
  }
  // Only AimPresentation interpolates this package. Controls read raw queries.
  forecast(state: AimScene, solution: FlightSolution, weapon: WeaponSettings, ground: Terrain): AimForecast {
    const previous = this.forecastCache;
    if (previous?.state === state && previous.solution === solution && previous.weapon === weapon) return previous;
    const module = selectedLauncher(state, weapon), actor = sceneFrame(state).actors.get(module?.actorId || 'local'),
      impact = this.impact(state, solution, weapon), flight = impact?.time ?? solution.time,
      key = JSON.stringify([state.controlledActor, actor?.revision, actor?.facing, actor?.mirror, actor?.vehicle?.chassisId,
        module?.id, module?.health, module?.weaponMount?.min, module?.weaponMount?.max, weapon, solution.charge,
        impact?.owner.type, impact?.owner.id, impact?.owner.object?.actorId,
        impact?.owner.object && 'revision' in impact.owner.object ? impact.owner.object.revision : undefined,
        impact?.owner.object && 'health' in impact.owner.object ? impact.owner.object.health : undefined, impact?.surface, Boolean(impact?.bounce)]);
    return this.forecastCache = { state, solution, weapon, key, terrain: ground, roads: state.roads, gun: module?.id,
      path: impact?.path || flightPath(solution), impact, flight, marks: this.flightMarks(solution, flight) };
  }
  // Canonical dragged positions at every five seconds, without resampling a
  // physical trajectory every time the renderer draws another display frame.
  flightMarks(solution: FlightSolution, flight: number) {
    if (this.marksCache?.solution !== solution || this.marksCache.flight !== flight) {
      const count = Math.max(0, Math.ceil(flight / 5 - 1e-9) - 1);
      this.marksCache = { solution, flight, points: count ? flightPath(solution, count, count * 5).slice(1) : [] };
    }
    return this.marksCache.points;
  }
}
