import type { SceneBodyPanel, SceneTow } from './scene-contract.ts';
import type { PublishedScene, PublishedActor, PublishedModule, PublishedPlate, PublishedVehicle } from './publication-contract.ts';
import type { ShotLegend } from './shots.ts';
import type { Point } from './math.ts';
import type { SightEye } from './ground-sight.ts';
import type { FlagChoice } from './flag.ts';
import type { VIEW } from './network-protocol.ts';
import type { FieldPresence } from './field-contract.ts';

// Exterior and remembered observations transported to a faction. Full private
// fields are optional; the server's projection chooses which fields are present.
export type FogActor = Omit<PublishedActor, 'vehicle'> & {
  vehicle?: (Pick<PublishedVehicle, 'x' | 'y' | 'angle'> & { [K in keyof PublishedVehicle]?: PublishedVehicle[K] | undefined }) | null | undefined;
  ghost?: unknown; [VIEW]?: 'outside';
};
type PublicModuleFields = { [K in keyof PublishedModule]?: PublishedModule[K] | undefined };
export type FogModule = Pick<PublishedModule, 'id' | 'actorId' | 'kind' | 'x' | 'y' | 'angle' | 'width' | 'height' | 'attached'> & PublicModuleFields & { [VIEW]?: 'outside' };
export type FogPlate = PublishedPlate;
export type PublicTow = Pick<SceneTow, 'actorId' | 'targetId' | 'anchorA' | 'anchorB' | 'length' | 'sling'> & {
  tension?: number | undefined; limit?: number | undefined; bridle?: [Point, Point] | null | undefined;
};
export interface SharedIdentity { ref: string; nation: string | null; flag?: FlagChoice; name?: string }
export type FogContactView = { id: string; kind: 'radar'; x: number; y: number; error: number; at: number } |
  { kind: 'sound'; shared: true; from: SharedIdentity; side: -1 | 1; at: number } |
  { kind: 'sound'; by: string; side: number; at: number };
export interface BatteryMark { id: string; kind: 'battery'; x: number; y?: number; error: number; at: number; by: 'radar' | 'sound' }
export type FogShotKind = ShotLegend;
export interface FogShotBlock { data: Float64Array; kinds: readonly FogShotKind[]; drag?: Float64Array }
export interface FogFrame extends Omit<PublishedScene, 'actors' | 'modules' | 'bodyPanels' | 'shots' | 'tows'> {
  actors: FogActor[]; modules: FogModule[]; bodyPanels: SceneBodyPanel[]; contacts: (FogContactView | BatteryMark)[];
  shots?: FogShotBlock; tows?: PublicTow[];
  players?: FieldPresence[] | undefined; sharedEyes?: SightEye[];
}
