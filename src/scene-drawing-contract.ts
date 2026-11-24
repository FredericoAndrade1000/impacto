import type { SceneSnapshot, SceneActorSnapshot, SceneModule, ScenePlate, SceneBodyPanel, SceneTow } from './scene-contract.ts';
import type { PublishedScene, PublishedActor, PublishedModule, PublishedPlate, PublishedDefinition } from './publication-contract.ts';
import type { FogFrame, FogActor, FogModule, PublicTow, FogShotBlock } from './fog-contract.ts';
import type { DesignScene, DesignActor, DesignModule, DesignPlate, GeometrySource } from './scene-frame.ts';

// A drawing is an observation, not a mechanical admission. Each producer can
// reveal different channels independently; omitted channels remain unknown.
type SourceKeys<Source> = Source extends unknown ? keyof Source : never;
type SourceValue<Source, Key extends PropertyKey> = Source extends unknown ? Key extends keyof Source ? Source[Key] : never : never;
type Observed<Source, Required extends SourceKeys<Source> = never, Keys extends SourceKeys<Source> = SourceKeys<Source>> = {
  readonly [Key in Keys]?: SourceValue<Source, Key> | undefined;
} & { readonly [Key in Required]-?: Exclude<SourceValue<Source, Key>, undefined> };

type ActorSources = SceneActorSnapshot | PublishedActor | FogActor | DesignActor;
type VehicleSources = NonNullable<SourceValue<ActorSources, 'vehicle'>>;
export type DrawingVehicle = Observed<VehicleSources>;
export type DrawingActor = Omit<Observed<ActorSources, 'id' | 'x'>, 'vehicle'> & {
  readonly vehicle?: DrawingVehicle | null | undefined;
};

type ModuleSources = SceneModule | PublishedModule | FogModule | DesignModule;
export type DrawingSuspension = Observed<NonNullable<SourceValue<ModuleSources, 'suspension'>>>;
export type DrawingGroundContact = Observed<NonNullable<SourceValue<ModuleSources, 'groundContact'>>, 'x'>;
export type DrawingModule = Omit<Observed<ModuleSources, 'id' | 'actorId' | 'kind' | 'x' | 'y' | 'angle' | 'width' | 'height' | 'attached'>,
  'suspension' | 'groundContact'> & {
  readonly suspension?: DrawingSuspension | undefined;
  readonly groundContact?: DrawingGroundContact | null | undefined;
};

type PlateSources = ScenePlate | PublishedPlate | FogFrame['plates'][number] | DesignPlate;
type DefinitionSources = ScenePlate['definition'] | PublishedDefinition | FogFrame['plates'][number]['definition'] | DesignPlate['definition'];
export type DrawingDefinition = Observed<DefinitionSources, 'id' | 'material' | 'x' | 'y' | 'angle' | 'length' | 'thicknessMm'>;
export type DrawingPlate = Omit<Observed<PlateSources, 'id' | 'material' | 'solidRegions' | 'integrity' | 'revision' | 'marks' | 'markRevision'>,
  'definition'> & { readonly definition: DrawingDefinition };

export type DrawingBodyPanel = Observed<SceneBodyPanel | DesignScene['bodyPanels'][number], 'id'>;
export type DrawingTow = Observed<SceneTow | PublicTow, 'actorId' | 'targetId' | 'anchorA' | 'anchorB' | 'length'>;
export type DrawingShotBlock = Observed<NonNullable<SceneSnapshot['shots']> | NonNullable<PublishedScene['shots']> | FogShotBlock, 'data' | 'kinds'>;

// The portable scene owns visual state. Viewer-specific faction/contact metadata
// belongs to FieldView; compiler-only machinery remains on CompiledConstruction.
type SceneSources = SceneSnapshot | PublishedScene | DesignScene;
type SceneKeys = Extract<keyof SceneSnapshot, SourceKeys<SceneSources>>;
export type DrawingScene = Omit<Observed<SceneSources, 'time', SceneKeys>, 'actors' | 'modules' | 'plates' | 'bodyPanels' | 'tows' | 'shots'> & {
  readonly actors: readonly DrawingActor[];
  readonly modules: readonly DrawingModule[];
  readonly plates: readonly DrawingPlate[];
  readonly bodyPanels?: readonly DrawingBodyPanel[] | undefined;
  readonly tows?: readonly DrawingTow[] | undefined;
  readonly shots?: DrawingShotBlock | undefined;
};

// These checks connect the read model to every producer without weakening them.
type CompatibleDrawing<Source extends DrawingScene> = Source;
type DrawingProducers = CompatibleDrawing<PublishedScene | FogFrame | DesignScene | SceneSnapshot>;
type CompatibleGeometry<Source extends GeometrySource> = Source;
type DrawingGeometry = CompatibleGeometry<DrawingScene>;
