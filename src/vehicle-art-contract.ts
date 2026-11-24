import type { ArtContext } from './canvas-art.ts';
import type { WeatheringMaps, WeatheringProfile } from './weathering.ts';
import type { MetalId, PieceMetal } from './materials.ts';
import type { WeaponId } from './weapons.ts';
import type { SensorMode } from './combat-sensors.ts';
import type { CargoKind } from './component-volume.ts';

export type MetalLook = NonNullable<PieceMetal['look']>;
export interface ArtBounds {
  x: number; y: number; width: number; height: number;
  radius?: number | undefined; path?: ((context: ArtContext) => void) | undefined;
}
export type FinishProfile = Partial<Omit<WeatheringProfile, 'material'>>;
export interface ArtFinish {
  face(bounds: ArtBounds, profile?: FinishProfile): void;
  protect(bounds: ArtBounds): void;
  protectCircle(x: number, y: number, radius: number): void;
}
export interface MachineCrop { x: number; y: number; W: number; H: number }
export interface CargoArch { x: number; y: number; r: number; half: number }
export interface ComponentArtOptions {
  finish?: ArtFinish | null | undefined; weathering?: WeatheringMaps | null | undefined;
  metal?: MetalId | undefined; armorMm?: number | undefined;
  ammoPreset?: WeaponId | undefined; sensorMode?: SensorMode | undefined;
  sensorSupport?: string | undefined; style?: string | undefined;
  crop?: MachineCrop | null | undefined; part?: string | null | undefined;
  hang?: { y: number; slope: number; half?: number } | null | undefined;
  paint?: number | undefined; arches?: readonly CargoArch[] | undefined;
  mirror?: number | undefined; side?: 'inside' | 'outside' | undefined;
  cargoLevel?: number | undefined; cargoMaterial?: CargoKind | '' | undefined;
  cargoFuel?: number | undefined; overlay?: boolean | undefined;
  teeth?: number | undefined;
}
