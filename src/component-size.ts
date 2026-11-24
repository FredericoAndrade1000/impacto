import { MODULES } from './materials.ts';
import { weaponMountSize } from './weapons.ts';
import { SENSOR_MODES, LEGACY_RADAR } from './combat-sensors.ts';
import type { ModuleKind } from './materials.ts';
import type { WeaponId } from './weapons.ts';
import type { SensorMode, SensorSpec } from './combat-sensors.ts';

export interface ComponentReferenceInput {
  kind: ModuleKind; weaponPreset?: WeaponId | undefined;
  sensorMode?: SensorMode | undefined; radarModel?: 'legacy' | 'mobile' | undefined;
}
export interface ComponentBounds { width: number; height: number; depthM?: number }
export type SizedComponent = ComponentReferenceInput &
  ({ kind: 'weapon'; width?: number } | { kind: Exclude<ModuleKind, 'weapon'>; width: number });

// One visible scale controls the complete installed assembly: its length and its height. Its depth across the body
// stays that of its kind (component-volume.ts `componentDepth`), so that what it holds and gives follows what the side
// view shows of it, and a tiny sprite cannot hide an oversized engine/tank. A sensor is of the size its kind of
// detection has (combat-sensors.ts).
export const componentReference = (module: ComponentReferenceInput): ComponentBounds => {
  if (module.kind === 'weapon') return weaponMountSize(module.weaponPreset || 'rh120');
  if (module.kind !== 'sensor') return MODULES[module.kind];
  if (module.sensorMode === 'radar' && module.radarModel === 'legacy') return LEGACY_RADAR;
  const sensor: SensorSpec | undefined = module.sensorMode ? SENSOR_MODES[module.sensorMode] : undefined;
  return sensor?.size ?? MODULES.sensor;
};
// Every construction is this wide, in metres (game_construction.rs `BODY_WIDTH`): what stands inside one is no deeper.
export const BODY_WIDTH = 2.4;
export const componentScale = (module: SizedComponent) => module.kind === 'weapon' ? 1 : module.width / componentReference(module).width;
// A hopper, a cistern and a supply piece grow to three times their size, as long and as tall as the body of a large dump
// truck or tanker; any other piece is no longer or taller than 4 m (game_geometry.rs `largest_scale`). Across the body
// each stays as deep as its kind, which every kind is within the body.
const LOADS = Object.freeze(['hopper', 'cistern', 'supply']);
export function componentSizeLimits(module: ComponentReferenceInput) {
  const base = componentReference(module);
  if (['command', 'sensor'].includes(module.kind)) return { min: 1, max: 1 };
  if (LOADS.includes(module.kind)) return { min: .25, max: 3 };
  return { min: .25, max: Math.floor(Math.min(4 / base.width, 4 / base.height) * 20) / 20 };
}
export function componentDimensions(module: SizedComponent, scale?: number): ComponentBounds;
export function componentDimensions(module: ComponentReferenceInput, scale: number): ComponentBounds;
export function componentDimensions(module: ComponentReferenceInput, scale?: number): ComponentBounds {
  // The one-argument overload accepts compiled geometry; authored references supply a scale.
  const size = scale === undefined ? componentScale(module as SizedComponent) : scale;
  const base = componentReference(module), factor = module.kind === 'weapon' ? 1 : size;
  return { width: base.width * factor, height: base.height * factor };
}
