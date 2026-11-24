import { WEAPONS, WEAPON_PRESETS, weaponSettings } from './weapons.ts';
import { WEAPON_MOUNTS } from './weapon-mounts.ts';
import { SENSOR_MODES, LEGACY_RADAR } from './combat-sensors.ts';
import { componentReference } from './component-size.ts';
import { CHASSIS_MODELS } from './chassis.ts';
import { detailCatalogue } from './vehicle-details.ts';
import { freezeRecord } from './immutable.ts';
import type { AmmoId, WeaponFamilyId, WeaponFamilySpec, WeaponPreset, WeaponPresetId, WeaponSettings } from './weapons.ts';
import type { WeaponMountId, WeaponMountSpec } from './weapon-mounts.ts';
import type { SensorMode } from './combat-sensors.ts';
import type { ChassisSpec } from './chassis.ts';
import type { ChassisModelId, ConstructionPoint, ConstructionPose } from './construction-contract.ts';

export type WeaponCatalogueEntry = Omit<WeaponSettings, 'ammo'> & Partial<Omit<WeaponPreset, 'ammo' | 'servoMaxSpeed'>> & {
  ammo: AmmoId | readonly [AmmoId, ...AmmoId[]]; allowedAmmo: readonly [AmmoId, ...AmmoId[]]; servoMaxSpeed?: number | undefined;
};
export type WeaponCatalogue = Readonly<Record<WeaponPresetId | WeaponFamilyId, WeaponCatalogueEntry>>;
export interface ConstructionCatalogue {
  weapons: WeaponCatalogue; mounts: Readonly<Record<WeaponMountId, WeaponMountSpec>>;
  chassis: Readonly<Record<ChassisModelId, ChassisSpec>>; details: ReturnType<typeof detailCatalogue>;
  sensors: Readonly<Record<SensorMode, { mass: number; cost: number; width: number; height: number; depthM: number | undefined; legacy?: typeof LEGACY_RADAR }>>;
}

// Build data is shared by pricing, templates and scene admission. Variants explicitly clone it.
let weapons: WeaponCatalogue | undefined, construction: Readonly<ConstructionCatalogue> | undefined;

export function weaponCatalogue(): WeaponCatalogue {
  if (weapons) return weapons;
  const catalogue: Partial<Record<WeaponPresetId | WeaponFamilyId, WeaponCatalogueEntry>> = Object.fromEntries(
    (Object.entries(WEAPON_PRESETS) as [WeaponPresetId, WeaponPreset][]).map(([id, spec]) => {
      const family: WeaponFamilySpec = WEAPONS[spec.family];
      return [id, { ...weaponSettings(spec.family, { preset: id }), allowedAmmo: spec.ammo || family.ammo, servoMaxSpeed: family.servoMaxSpeed, ...spec }];
    }));
  for (const [id, spec] of Object.entries(WEAPONS) as [WeaponFamilyId, WeaponFamilySpec][])
    catalogue[id] = { ...weaponSettings(id), allowedAmmo: spec.ammo, servoMaxSpeed: spec.servoMaxSpeed };
  // Both complete closed catalogues were visited; the result has every key of their union.
  return weapons = freezeRecord(structuredClone(catalogue)) as WeaponCatalogue;
}

// A sensor is of the size its kind of detection has (component-size.ts `componentReference`).
export function constructionCatalogue(): Readonly<ConstructionCatalogue> {
  if (construction) return construction;
  const definitions = { mounts: WEAPON_MOUNTS, chassis: CHASSIS_MODELS, details: detailCatalogue(),
    sensors: Object.fromEntries((Object.keys(SENSOR_MODES) as SensorMode[]).map(id => {
      const { mass, cost } = SENSOR_MODES[id], { width, height, depthM } = componentReference({ kind: 'sensor', sensorMode: id });
      return [id, { mass, cost, width, height, depthM, ...(id === 'radar' ? { legacy: LEGACY_RADAR } : {}) }];
    })) as ConstructionCatalogue['sensors'] };
  return construction = freezeRecord({ weapons: weaponCatalogue(), ...structuredClone(definitions) });
}


// Package known terrain and the existing cold placement for the native support query; this decides no contact.
// Server callers reconstruct this context from their own field rather than accepting client-supplied surfaces.
export interface SupportTerrain { segmentIndex(x: number): number; points: readonly ConstructionPoint[] }
export function constructionSupportSite(terrain: SupportTerrain, { pose, facing, clearance }: { pose: ConstructionPose; facing: number; clearance: number }, { minX, maxX }: { minX: number; maxX: number }) {
  const first = terrain.segmentIndex(minX), last = terrain.segmentIndex(maxX);
  return { pose, facing, clearance, ground: terrain.points.slice(first, last + 2).map(({ x, y }) => ({ x, y })) };
}
