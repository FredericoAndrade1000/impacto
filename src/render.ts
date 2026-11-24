import { tr, locale } from './i18n.ts';
import { Application, Container, Graphics, Mesh, MeshGeometry, Sprite, Texture, RenderTexture, Text, GraphicsContext, Assets } from 'pixi.js';
import { Camera, FramedCamera, screenMirrored } from './camera.ts';
import { Effects, thrusterJet } from './effects.ts';
import { SurfaceLight } from './surface-light.ts';
import { fireSurface, fireProfilePixels } from './fire-surface.ts';
import { canvas, paintDamage, paintComponentDamage, paintComponentSoot, createBodyImpactTexture, pieceTexture, textureFromCanvas, resizePicture, repaintTexture, paintParticleAtlas, createParticleAtlas, surfaceGrain, mineralTexture, FRAME_SURFACE_KINDS } from './textures.ts';
import { TexturePainter } from './texture-painter.ts';
import { paintTextureCanvas, previewTextureCanvas, texturePreviewShape } from './texture-paint.ts';
import { MATERIALS, MODULES, metalOf } from './materials.ts';
import { plateCorners, clamp, smoothstep, angleDifference, localToWorld, worldToLocal, Random } from './math.ts';
import { resolveArmament, linkedArmament, pieceKey } from './ui-model.ts';
import { componentPolygon, componentPolygons } from './assembly.ts';
import { MARKED_ISSUES } from './structured-editing.ts';
import { WeaponSprites } from './weapon-sprites.ts';
import { sensorSupport, drawSensorSupport } from './sensor-support.ts';
import { weaponRecoilGuide, drawWeaponRecoilGuide } from './weapon-art.ts';
import { KINETIC_AMMO, boreElevation, barrelGlow, BARREL_SHIMMER, airTemperature, weaponCompartment } from './weapons.ts';
import { feedChambers } from './weapon-paint.ts';
import { touching, clearOf, LIFT } from './touch.ts';
import { RestingArt } from './resting-art.ts';
import { bodyPanelSurfaces } from './body-panels.ts';
import { coveredParts } from './hull-coverage.ts';
import { hullArtwork, hullBaseTone, hullImpactLayout, paintHullImpacts, createFittingTexture, fittingImpacts, paintDetailCanvas } from './hull-art.ts';
import { chassisLayout, chassisArtwork, chassisPlacement, chassisPoint, chassisLocal, chassisImpactLayout, chassisFrame, chassisFloor, floorSegment, heldTrack,
  chassisSeats, createSeatShade, seatShadeGeometry, deckGlint, mudguardsOver, suspensionShapes, chassisOutlineAt } from './chassis-art.ts';
import { hullLayout, outerFace, within, hashText } from './hull-details.ts';
import { mountedFiringSolution, flightPath } from './ballistics.ts';
import { componentTint } from './impact-damage.ts';
import { MACHINE_KINDS, FACED_KINDS, radarAerial, aerialView, aerialSight } from './machine-art.ts';
import { ROAD_MOTION_ZOOM, ROAD_DETAIL_ZOOM, MOTION_PARTS, RoadMachineView, machineRig, followWork, lower, advanceLanes, worksOf,
  bladeDrop, bladePose, biting, earthFoot, screedDrop, screedPose, screedPoint, toolAt, partBox, partMarks, metalPaint, earthTone, shake, drawBladeSupports, bladeHang } from './road-machine-motion.ts';
import { gradedGround, placeOf } from './road-tools.ts';
import { AimQueries, selectedLauncher, observedWeapon } from './aim-queries.ts';
import { STRIKE_WORDS } from './armour-strike.ts';
import { FramePresentation } from './presentation.ts';
import { projectileAppearance, projectileBodyGeometry } from './projectile-visual.ts';
import { ShotQuads, paintShotAtlas, shotKind, TAIL_WIDTH, MARKER_RADIUS, GLOW_RADIUS } from './shot-quads.ts';
import { Terrain, underfootGround } from './terrain.ts';
import { CELL, metresOf } from './grid.ts';
import { NO_ROADS, normalRoads, unlike } from './roads.ts';
import { SiteMarkers, FOREIGN_BASE, FOREIGN_LABEL, UNSEEN_BASE, BASE_VIEW } from './site-markers.ts';
import { terrainDrawKey } from './terrain-draw-key.ts';
import { GroundTrails, groundView } from './terrain-art.ts';
import { TerrainScene, BUMPS_ZOOM } from './terrain-scene.ts';
import { Backdrop, AmbientDust } from './landscape-art.ts';
import { grainTextures } from './strata-art.ts';
import { floraTexture } from './flora-art.ts';
import { drawBaseArt, drawBaseWatch, watchPosts, AERIAL_TURN, WATCH_RADAR } from './base-art.ts';
import { POST_EYE } from './territory.ts';
import { loadBaseMaterials, destroyBaseMaterials } from './base-materials.ts';
import { prepareWeathering } from './weathering.ts';
import { weatheredFill, destroyWeathering } from './weathered-fill.ts';
import { drawFlag, knownFlags, flagTall, countryFlag } from './flag.ts';
import { drawSite, drawVein, drawAirdrop, drawPosts, depositLook, lookKey, DEPOSIT_ART_REACH } from './deposit-art.ts';
import { updateAirdropDescent, airdropFooting } from './airdrop-descent.ts';
import { cargoLook, cargoOutline, loadArches, heapOver, heapCanvasSize, paintHeap, pileLook, pileSize, pileCanvasSize, paintPile } from './cargo-art.ts';


import { VEHICLE_ORIGIN } from './vehicle.ts';
import { nodeKey, vertexKey, pointOf, looseEnds } from './frame-points.ts';
import { depositsOf, depositsNear } from './deposits.ts';
import { weaponAngle } from './weapon-geometry.ts';
import { TRACK_GROUSER, TRACK_PIN, TRACK_SHOE_HALF_THICKNESS, terrainShadow, contactShadow, trackGear, holdTrackShape, linkStart } from './running-gear.ts';
import { TrackLinks, TrackShade, drawTrackFrame, trackDirt, trackDirtTexture, trackLinkTexture, trackSideTexture } from './track-links.ts';
import { TyreShade } from './tyre-shade.ts';
import { MAIN_LIGHT } from './main-light.ts';
import { tyreOutline } from './gear-art.ts';
import { servoStatus, servoGuide, presentedMountSector, presentedPivotVelocity, aimLimitText,
  visualRecoilStroke, startWeaponRecoil, advanceWeaponRecoil, AimPresentation, carried, movedPath,
  startWeaponSpin, advanceWeaponSpin, followFeed, advanceFeed } from './weapon-presentation.ts';
import { designFrame, sceneFrame, sampleScene, regionGeometry } from './scene-frame.ts';
import { footingOutlines, fixedFooting, footingShape, paintFooting } from './fixed-footing.ts';
import { ArmorArtCache } from './armor-art.ts';
import { EffectSurfaceClip } from './effect-surface-clip.ts';
import { ScorchMarks } from './ground-scorch.ts';
import { HeatHaze, type HotBarrel } from './heat-haze.ts';
import { ScreenShake, SHAKE_LEVELS } from './screen-shake.ts';
import { standing, seenFromOutside, wreckFade, ghostFade, buildFade, labelGroups, contactMarks, watchPulses, knownVeins, factionName, GHOST_TINT } from './faction-ui.ts';
import { LabelIcons, VehicleLabel, vehicleLabel, groupedVehicleLabel, vehicleLabelLayout, separateVehicleLabels } from './vehicle-labels.ts';
import { anchorGraphics } from './world-anchor.ts';
import { BOARD, BOARD_FACING, drawBoardFloor, fieldX } from './workshop-site.ts';
import { constructionPlacement } from './construction-placement.ts';
import { holdsCargo } from './component-volume.ts';
import { workFrame, workSide, workLayout, workStep, workFigure, workDelivery, boxesOf, craneLayout, craneSide, craneRoute, craneFigure, craneStep, craneStandby,
  LIFT_SECONDS, LIFT_HOLD } from './work-arm.ts';
import { stockOf, STILL_SPEED } from './economy.ts';
import { BUILD_REACH } from './construction-site.ts';
import { drawWorkArm, WORK_ARM_WEATHERING, createWorkArmWeathering } from './work-arm-art.ts';
import { GroundSight, ViewSight, contains } from './ground-sight.ts';
import { GroundMist, fieldFog, nearestKnown, LOW_AIR, MIST_HEIGHT, MIST_FADE } from './ground-mist.ts';
import { drawSight } from './sight-art.ts';
import { SilhouetteArt, silhouette, drawOutline, drop, lineAt, GLINT_ZOOM } from './silhouette.ts';
import { HazedGraphics, hazedPicture, TREE_HAZE } from './haze.ts';
import { detailPartId, detailGroup, plateDetails, detailInBasis } from './vehicle-details.ts';
import type { CanvasSource, ColorSource, TextStyleOptions, Shader } from 'pixi.js';
import type { Point, Pose } from './math.ts';
import type { UiView, ArmamentIntent, ResolvedArmament } from './ui-model.ts';
import type { FieldView } from './faction-ui.ts';
import type { DesignScene, SceneSample, SceneFramePart, FrameSurface, ComponentBuffers, RegionGeometry } from './scene-frame.ts';
import type { DrawingScene, DrawingActor, DrawingModule, DrawingPlate } from './scene-drawing-contract.ts';
export type { DrawingActor, DrawingModule, DrawingPlate } from './scene-drawing-contract.ts';
import type { CompiledConstruction, CompiledRoom, BodyPanel, NativeAdmissionIssue } from './construction-contract.ts';
import type { EditorPlateSpan, RoomHandle } from './editor.ts';
import type { CanvasModulePreview, CanvasPlatePoint } from './canvas-controls.ts';
import type { StrikeView } from './armour-trial.ts';
import type { FrameMeter } from './frame-meter.ts';
import type { RecoilMotion, ForecastPoint, SpinMotion, FeedMotion } from './weapon-presentation.ts';
import type { WeaponSpriteOptions, WeaponFeedPose } from './weapon-sprites.ts';
import type { FireProfile } from './fire-surface.ts';
import type { TexturePaintRequest, TextureMaterials } from './texture-paint.ts';
import type { HullArtwork, PaintDetail } from './hull-art.ts';
import type { TerrainId, TerrainOptions } from './terrain.ts';
import type { Road } from './roads.ts';
import type { FieldFog } from './ground-mist.ts';
import type { MaterialId, ModuleKind, ArmourMaterial } from './materials.ts';
import type { AimForecast } from './aim-queries.ts';
import type { CraneArmState, CraneGeometryTarget } from './work-arm.ts';
import type { WorkWeatheringFills } from './work-arm-art.ts';
import type { ArtCanvas } from './canvas-art.ts';
import { context2d } from './canvas-art.ts';
import type { ArtContext, XY } from './canvas-art.ts';
import type { WeaponOverrides, WeaponFamilyId, WeaponPresetId, WeaponId } from './weapons.ts';
import type { WeaponCanvasArt } from './weapon-paint.ts';
import type { ComponentArtOptions, CargoArch } from './vehicle-art-contract.ts';
import type { Sampled, SceneFrame, WithAbsentSlots } from './scene-frame.ts';
import type { TrackGear, ShadowPatch } from './running-gear.ts';
import type { HullScene, HullLayout, HullFitting } from './hull-details.ts';
import type { ChassisArtwork, ChassisLayout, ChassisPlacement, ChassisShade, KeyedChassisGuard, SuspensionShape } from './chassis-art.ts';
import type { Silhouette, SilhouetteStyle } from './silhouette.ts';
import type { PresentationSample, PresentationFrame } from './presentation.ts';
import type { SceneEventBase } from './scene-contract.ts';
import type { FactionFlag } from './flag.ts';
import type { PileLook } from './cargo-art.ts';
import type { DetailEditView } from './ui-model.ts';
import type { FlightSolution, FlightState } from './ballistic-contract.ts';
import type { FactionView, KnownVein, KnownDeposit, KnownAirdrop, DepositObservation } from './faction-ui.ts';
import type { RoadToolKind, RoadPlace } from './road-tools.ts';
import type { MachineWorkState, MachineRig, MotionBladeRig, MotionPaverRig, MotionBox, MotionPart, BladePose, ScreedPose, MetalPaint, RoadWork } from './road-machine-motion.ts';
import type { WorkFrame, WorkPart, HeightAt } from './work-arm.ts';
import type { AirdropDescent } from './airdrop-descent.ts';
import type { BaseFootprint, BaseWatchPulse } from './base-art.ts';
import type { SitePostPreview, SiteRoadPreview } from './site-markers.ts';
import type { PaintedBodyPanel, BodyFittingScene } from './body-panels.ts';
import type { VehicleLabelBox, VehicleLabelModel } from './vehicle-labels.ts';
import type { CargoKind } from './component-volume.ts';
import type { StockId } from './economy-contract.ts';
import type { PieceTexture } from './textures.ts';
import type { Deposit } from './deposits.ts';

export type RenderFaction = Pick<FactionView, 'id' | 'flag' | 'known'> & {deposits: readonly DepositObservation[]} & Partial<Pick<FactionView,
 'explored' | 'units' | 'works' | 'posts' | 'base' | 'bases' | 'outposts' | 'roadworks' | 'heaps' | 'territory' | 'activity'>>;
export type RenderFieldView = Omit<FieldView, 'faction'> & { faction?: RenderFaction | null; observerBases?: FactionView['bases'] };
export type RendererDrawing = RenderFieldView;
type RendererTool = UiView['buildTool'] | UiView['testTool'];
export type RendererView = Partial<Omit<UiView, 'weapon' | 'buildTool' | 'testTool'>> & {
  weapon?: (WeaponOverrides & { id?: WeaponFamilyId }) | null; buildTool?: RendererTool; testTool?: RendererTool;
};
type RenderCraneTarget = CraneGeometryTarget & { materials?: StockId[] | undefined };
interface RenderWorkArm extends CraneArmState { side?: number; told?: number; target?: RenderCraneTarget | null | undefined; weathering?: WorkWeatheringFills | null }
type CanvasTexture = PieceTexture;
export interface RenderTextureEntry { texture: CanvasTexture; persistent: boolean; key: string; paint?: TexturePaintRequest | null; revision?: string | number | undefined; art?: WeaponCanvasArt | null; layout?: HullLayout; painted?: HullArtwork }
export interface BoardSite extends Point { mirror: boolean }
type GridLine = [Point, Point, number];
interface EdgeIndex { a: number; b: number }
type DrawingPart = SceneFramePart<RendererDrawing>;
type RenderPose = NonNullable<ReturnType<SceneSample<RendererDrawing>['pose']>>;
type RenderModulePose = Sampled<DrawingModule>;
type RenderBodyPose = NonNullable<ReturnType<SceneSample<RendererDrawing>['actor']>>;
type ImageShape = Pick<RegionGeometry, 'positions' | 'uvs' | 'indices'> & { revision?: number | string | undefined; edges?: readonly EdgeIndex[] };
interface ShadeCast { data: unknown; ground: Terrain; strip: number; deep: number; lift: number; x: number; y: number; angle: number; sx: number; sy: number; reach: number; slope: number | null; slack: number }
type ShadowGraphic = Graphics & { cast?: ShadeCast };
type ShadowGroup = Point & { rotation: number; scale?: Point };
interface ShadowDrawing { group: ShadowGroup; data?: unknown; positions?: Float32Array; edges?: readonly EdgeIndex[]; outline?: readonly Point[] | null; placement?: ChassisPlacement; shade?: ShadowGraphic; under?: ShadowGraphic }
interface ChassisShadow extends ShadowDrawing { layout?: ChassisLayout; data?: { outline: readonly Point[] } }
type PanelRim = Graphics & { shape?: string | undefined; stroked?: number };
interface LoadBody { paint: number | undefined; side: 'inside' | 'outside'; arches: readonly CargoArch[]; out: boolean; mirror: number; frame: SceneFrame<RendererDrawing> }
interface TrackDetails { container: Container; side: Sprite; frame: Graphics; links: TrackLinks; dirt: TrackShade; cover: TrackShade; soil: ReturnType<typeof trackDirt> | null; wheels: Sprite[];
 gear?: TrackGear; wheelPictures?: Map<string, Texture>; metal?: DrawingModule['metal']; teeth?: number; edgeGear?: TrackGear; edge?: Float64Array; outline?: Float64Array;
 frameGear?: TrackGear; frameMetal?: DrawingModule['metal']; casing?: boolean }
interface AerialIdentity { id?: string; actorId?: string | undefined }
type Aerial = Container<Sprite> & { radar: AerialIdentity & { width: number; height: number; shape: ReturnType<typeof radarAerial>; bearing: number } };
type TrackOutline = Graphics & { drawnFor?: { shape: unknown; style: SilhouetteStyle; width: number } };
interface RenderDrawable extends ShadowDrawing { group: Container; mesh: Mesh<MeshGeometry, Shader>; geometry: MeshGeometry; positions: Float32Array; data: ImageShape;
 edges: readonly EdgeIndex[]; shapeKey?: string; artEdges?: readonly { a: Point; b: Point }[] | undefined; rim?: Graphics & { made?: { edges: unknown; data: ImageShape; width: number; color: number } };
 tyreShade?: TyreShade; tyreShadeStyle?: string; heap?: Container<Sprite>; silhouette?: Silhouette | TrackOutline; glint?: Silhouette;
 trackDetails?: TrackDetails; heldData?: ImageShape; hold?: Pose | null; body?: LoadBody; bodyTextures?: Partial<Record<'inside' | 'outside', string[]>>;
 textureKeys?: string[]; sensorSeat?: Graphics; sensorSeatKey?: string; aerial?: Aerial | null }
interface FittedFace { state: RendererDrawing; scene: BodyFittingScene & {side: 'inside' | 'outside'}; key: string; lettering: boolean; textureKeys?: string[]; outer?: HullSprite['outer']; paint?: number | undefined; shape?: HullArtwork;
 art?: { key: string; painted: HullArtwork; layout: HullLayout } }
type FittingSprite = Sprite & { fitting: HullFitting; key: string };
type FittingContainer = Container<FittingSprite> & { layout?: HullLayout };
type HullSprite = Sprite & { rim?: PanelRim; fittings?: FittingContainer; silhouette?: Silhouette; glint?: Silhouette; textureKeys?: string[];
 fitted?: Partial<Record<'inside' | 'outside', FittedFace>>; outer?: { rooms: number; sits: number[]; polygon: Point[]; points: readonly Point[] } };
type GuardSprite = Sprite & { rim?: PanelRim; fittings?: Container };
interface ShadeSeat { seats: readonly XY[]; depth: number; pieces: readonly ChassisShade[]; mesh: Mesh<MeshGeometry> | null }
type SeatContainer = Container & { seatShade?: ShadeSeat };
type ActorExtent = { revision: DrawingActor['revision']; length: number; left?: number; right?: number; bottom?: number; top?: number; angle?: number };
interface ActorLayers { container: Container; body: Container; footing: Graphics; shade: Container; outline: Container; chassis: Container; hullSkins: Container; bodyPanels: Container; moduleLayer: Container; plateLayer: Container;
 edges: Container; outerSkin: Container; outsideLayer: Container; suspensionArms: Graphics; runningGearLayer: Container; guards: Container; gunArt: Container; gun: Graphics; heaps: Container; fxLayer: Container;
 fade?: number; ghost?: boolean; still?: boolean; tint?: number; label?: VehicleLabel; flag?: Graphics; extent?: ActorExtent; dotted?: boolean; markGun?: boolean; gunsOutside?: boolean;
 chassisKeys?: string[]; chassisHung?: { sign: string; guards: KeyedChassisGuard[] }; chassisArt?: SeatContainer; chassisGuards?: Container<GuardSprite>; chassisGuardPreviews?: Container; chassisSkirtShade?: SeatContainer;
 chassisShadow?: ChassisShadow; chassisWanted?: string; chassisShape?: ChassisArtwork; chassisDetails?: (PaintDetail & { mask: readonly Point[] })[]; chassisDetailKey?: string; chassisSeats?: [number, number][];
 chassisSilhouette?: Silhouette; chassisGlint?: Silhouette; labelKey?: string; ownWidth?: number;
 footingMade?: { ground: Terrain; records: DrawingPart['data'][]; key: string; cast: ShadowDrawing | null } }
export interface LabelBox { x: number; left: number; right: number; top: number; bottom: number }
type HullSurface = ReturnType<typeof bodyPanelSurfaces>[number];
type RenderStrike = WithAbsentSlots<StrikeView> & {aim?: Point};
interface LabelledActor {id:string;key:string;alone:boolean;content:VehicleLabelModel;color:string|undefined;labelY:number;flown:GraphicsContext|null|undefined;worldX:number;x:number;y:number;width:number;alpha:number}
interface PlacedActorLabel extends VehicleLabelBox {id:string;ids:string[];key:string;first:ActorLayers;rest:ActorLayers[];label:VehicleLabel;flown:GraphicsContext|null|undefined;baseY:number;worldX:number;labelY:number;alpha:number}
type ArmamentCache = { source: CompiledConstruction | RenderFieldView | undefined | null; intent: RendererView['weapon']; key: string; value: ResolvedArmament };
type LinkedArc = { asked: string; solution: FlightSolution; path: FlightState[]; made: number; at: Pose & { barrelAngle: number; vx: number; vy: number; omega: number | undefined }; drawn?: ForecastPoint[] };
interface RenderMachine extends MachineWorkState { keys?: string[]; shown?: boolean | undefined; frame?: Texture | null; parts?: Partial<Record<MotionPart, Texture>> | null; boxes?: Partial<Record<MotionPart, MotionBox>>;
 rig?: MachineRig; place?: RoadPlace; pose?: BladePose | ScreedPose; contact?: boolean; dt?: number; at?: number; view?: RoadMachineView | null; metal?: DrawingModule['metal']; paint?: MetalPaint;
 due?: Record<string, number>; random?: Random }
interface DrawnBase { ground: Terrain; x: number; radius: number; facing: number | undefined; scale: number; banner: string; flag: Point }
interface ForeignBaseArt { works: HazedGraphics; front: Graphics; label: Text; drawn: DrawnBase | null }
interface DepositDrawing { works: HazedGraphics; front: Graphics; laid: {ground: Terrain;scale: number} | null;
 vein: { works: HazedGraphics; under: Graphics; front: Graphics } | null; drawn: {key: string | null;plate: Point | null} | null; load?: Sprite | null; loadKey?: string | null }
interface FadingDeposit { parts: Container[]; from: number; loadKey: string | null | undefined }
interface LaidDeposits {ground: Terrain;scale: number;veins: readonly KnownVein[];left: number;right: number;postsKey: string | undefined}
type ActorLayerKind = 'footing' | 'shade' | 'outline' | 'chassis' | 'hullSkins' | 'bodyPanels' | 'moduleLayer' | 'plateLayer' | 'edges' | 'outerSkin' | 'outsideLayer' | 'suspensionArms' | 'runningGearLayer' | 'guards' | 'gunArt' | 'gun' | 'heaps' | 'fxLayer';
type PaintedSynthetic = { kind: 'wheel' | 'track' | 'sensor'; width: number; height: number; mirrored?: boolean } & Pick<ComponentArtOptions, 'metal' | 'sensorMode'>;
type PaintedModule = WithAbsentSlots<DrawingModule | PaintedSynthetic> & Pick<ComponentArtOptions, 'style' | 'teeth' | 'overlay' | 'part' | 'crop' | 'sensorSupport'>;
type MaterialPicture = WithAbsentSlots<DrawingPlate | DrawingModule>;
export interface RendererBoard<State extends RenderFieldView = FieldView> {
  host: Renderer<State>; camera: FramedCamera; body: Container; marks: Container; view: RendererView;
  site: BoardSite | null; ground: Terrain; flatGround: Terrain; shade: Sprite; floor: Graphics;
  shadows: Graphics; actorLayerRoot: Container; benchArt: Container; overlay: Graphics;
  blueprint: CompiledConstruction; designState: DesignScene; designFaces: BodyPanel[];
  modulePreview: CanvasModulePreview | null; platePreview: { a: CanvasPlatePoint; b: CanvasPlatePoint } | null;
  manufactureIssues: NativeAdmissionIssue[]; holdArt: boolean; floored?: { site: BoardSite; ground: Terrain; fixed: boolean };
  resting: RestingArt; siteMarkers: SiteMarkers;
  clearConstructions: Renderer<State>['clearConstructions']; initConstructions: Renderer<State>['initConstructions'];
  drawDesign: Renderer<State>['drawDesign']; drawManufactureIssues: Renderer<State>['drawManufactureIssues'];
  drawPlaceLabels: Renderer<State>['drawPlaceLabels']; drawOverlay: Renderer<State>['drawOverlay'];
  workArms?: Renderer<State>['workArms'];
}

// Below this many pixels to the metre the field is seen from afar: rounds and arcs are drawn to be found, not inspected.
const FAR_VIEW_ZOOM = 8;
// Ends of plates nearer than this on the screen, in pixels, look one: their markers meet.
const LOOSE_PX = 12;
// What an optic selected in the workshop sees is drawn out to this share of the shorter side of the view.
const SIGHT_REACH = .46;
// How far past each side of the view the sites of the deposits are laid out, in metres.
const DEPOSITS_REACH = 512;
// The scale of the art of the deposits goes by thirds of an octave of the zoom. From this one down, under some .18 of
// a pixel to the metre, a site is under ten pixels across and is drawn from afar: only the posts of the veins known.
const DEPOSIT_FAR_STEP = -8;
// How long the drawing of a vein the faction forgets takes to fade away, in seconds.
const DEPOSIT_FADE = 1.5;
// The most pixels the view is ever thrown by a shake (screen-shake.ts): the fog is drawn that far past each edge of it.
const SHAKE_MARGIN = Math.max(...Object.values(SHAKE_LEVELS));
// A strike of the test of armour in the colour of what it does where it first strikes: gets through, is stopped, glances
// off, goes into the ground, meets nothing, bursts in the air; the rest in the colour of the words of the aim. Fired, its
// arrow stays this faint under the round that flies along it, and fades in this many milliseconds.
const STRIKE_COLORS = Object.freeze({ through: 0x9fd98a, stopped: 0xf07c66, ricochet: 0xf2cf5e, ground: 0xd6b07c, miss: 0x9aa59c, air: 0xf4a35a }),
  STRIKE_PLAIN = 0xffdfac, STRIKE_FIRED = .45, STRIKE_FADE_MS = 1200;
// The stretch of screen the tail of a round fills.
const TRAIL_PIXELS = 220;
// The most rounds a frame draws a body for. Each body is tessellated anew on every frame: past this many,
// a round in view is the point and glow of the far view, at whatever zoom.
const MAX_SHOT_BODIES = 64;
// How far from its origin a construction and its shadow may reach, in metres: what is further than this from
// what the camera shows has nothing on the screen.
const ACTOR_REACH = 16;
// From afar a construction is a few pixels long, under its label, and its art tells no more than a mark would: one
// shorter on the screen than `DOT_PIXELS` is a mark as long and as tall as it is, in its paint as darkened as its art
// looks from afar (`DOT_SHADE`), and one longer than `ART_PIXELS` is drawn in full again. The gap keeps a zoom that
// wavers about the limit from switching it back and forth. No construction is shorter than `DOT_SHORTEST` metres: a
// view that shows that many in more pixels than the limit has none to make a mark of, and measures none.
const DOT_PIXELS = 10, ART_PIXELS = 12.5, DOT_SHADE = .6, DOT_SHORTEST = 2;
// Between the old mark scale and the full artwork, keep the actual gun's direction over the compact body.
const MARK_GUN_PIXELS = 6;
// The paint of a construction (`#rrggbb`) as its mark from afar has it: darkened as its art looks, and tinted as its
// layers are, a ghost pale and a wreck grey. One with no paint told is in the olive of the presets.
const markColor = (paint: string | undefined, tint = 0xffffff) => {
  const color = /^#[0-9a-f]{6}$/i.test(paint ?? '') ? parseInt(paint!.slice(1), 16) : 0x6d7863;
  return [16, 8, 0].reduce((made, shift) => made | Math.round((color >> shift & 255) * DOT_SHADE * (tint >> shift & 255) / 255) << shift, 0);
};
// Below this many pixels to the metre the arm of a hopper and the rig of a cistern are not drawn.
const WORK_ARM_ZOOM = 4;
// The pieces drawn with an arm of their own, and the materials a crane carries in loads, as the stocks name them.
const WORK_TOOLS = new Set(['excavator', 'drill', 'builder']), CRANE_LOADS = ['ferro', 'ligas', 'silica'] as const;
// A road machine is the same from one revision of its construction to the next (a supply piece filled up, say): what
// the screen keeps of it at work goes by its construction and its piece, not by its piece of that revision.
const machineKey = (module: Pick<DrawingModule, 'id' | 'actorId'>) => (module.actorId || 'local') + ':' + pieceKey(module.id);
const roadMachineModule = (module: DrawingModule): module is DrawingModule & {kind: RoadToolKind} => FACED_KINDS.has(module.kind);
const airdropSite = (site: Deposit | KnownAirdrop): site is KnownAirdrop => 'type' in site && site.type === 'airdrop';
const armourMaterials: Readonly<Record<MaterialId, ArmourMaterial>> = MATERIALS;
// The flag a construction flies over its label is this many pixels wide, and stands this many over the middle of
// the label: clear of its one line, or of the two it has while the base works on the construction.
const LABEL_FLAG = 15, LABEL_FONT = 11;
// Pixels to the metre under which the fittings of a hull are not drawn: the smallest of them would be a pixel or two.
const FITTINGS_ZOOM = 12;
// Pixels to the metre under which the springs of a wheeled chassis are not drawn: as the fittings of a hull, they would
// be a pixel or two, and behind the tyres.
const SUSPENSION_ZOOM = 12;
// A track keeps its complete painted silhouette until its internal wheels are large enough to read: until the belt
// round one of them, along the line of its pins, is this many pixels across. The workshop always keeps its full
// presentation.
const TRACK_DETAIL_PIXELS = 12;
// Pixels to the metre under which the plates of a hull are drawn as they are cut, without the bevels of their edges and
// the joins of their ends (armor-art.ts): a bevel is at most 5.5 cm, two thirds of a pixel there. Laying out the joins of
// every plate in view cost some 0.6 ms a frame for ten vehicles from 4 px/m on, where they changed four pixels of the
// screen; the workshop always has them.
const ARMOR_DETAIL_ZOOM = 12;
// How many pixels high the grousers of a track are drawn from, and with them its horns: smaller, they would flicker.
const TRACK_FINE_PIXELS = 1;
// How far under where it stands loaded an axle that has lost its wheel hangs, in metres.
const BARE_AXLE_DROP = .08;
// While a design stands on the board of the field, the field behind it is under a shade of this tone and this
// strength, and the names and marks over its constructions keep this much of themselves: what stands at the base
// is not to be taken for a part of the design.
const BOARD_SHADE = 0x0e1713, BOARD_DIM = .55, BOARD_FADED = .25;
// The straight pieces a slack sling is drawn bowed in (drawTows).
const BOW = 16;
// A line thinner than this many pixels on the screen is not drawn: nothing of it would be seen.
const LINE_SEEN = .1;
// A wheel or a track less than this many pixels high is not outlined (silhouette.ts).
const GEAR_OUTLINE_PIXELS = 6;
// The strips of a shadow on the ground are no narrower than this many pixels.
const SHADE_STRIP = 3;
// The shadow where a wheel or a track touches the ground is as deep as this many pixels, and no less than this many
// metres, and a pixel over the ground line, with a soft base and a darker narrow core.
const CONTACT_PIXELS = MAIN_LIGHT.contactPixels, CONTACT_DEPTH = MAIN_LIGHT.contactDepth, CONTACT_ALPHA = MAIN_LIGHT.contactAlpha;
// A line the camera is close enough to thin is thinned by steps, not anew on every frame of a zoom.
const lineWidth = (most: number, pixels: number, zoom: number) => pixels / zoom >= most ? most : most * 2 ** (Math.round(Math.log2(pixels / zoom / most) * 8) / 8);
// A damaged copy must refresh when its retained backing changes from solid to painted.
const paintRevision = (entry: RenderTextureEntry, revision: string | number | undefined) => entry.paint ? revision + ':preview' : revision;
const flightSeconds = (time: number) => (time < 10 ? time.toFixed(1).replace('.', ',') : Math.round(time)) + ' s';
// The move of an end of a forecast that goes nowhere: the ground it comes down on, the level of the aim it comes to.
const STILL = Object.freeze({ x: 0, y: 0 });
const suspendedTrack = (module: {kind: ModuleKind;attached?: boolean | undefined;beltCut?: boolean | undefined}) => module.kind === 'track' && module.attached !== false && !module.beltCut;
// Where the frame of the skin of a hull (`shape`, hull-art.ts `hullArtwork`, in which its outline is counted from its lower
// left corner) stands, with the hull at `pose`: what is drawn once for the outline stands there, wherever the hull is.
const skinFoot = (shape: {left?: number;bottom?: number}, pose: Pose) => {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  return { x: pose.x + c * Number(shape.left) - s * Number(shape.bottom), y: pose.y + s * Number(shape.left) + c * Number(shape.bottom), angle: pose.angle };
};

// How far out of its centre a polygon about it (`positions`, flat) reaches on every side: the least reach of its sides.
function inscribed(positions: Float32Array) {
  let least = Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    const j = (i + 2) % positions.length, ax = positions[i]!, ay = positions[i + 1]!, bx = positions[j]!, by = positions[j + 1]!;
    least = Math.min(least, Math.abs(ax * by - ay * bx) / Math.hypot(bx - ax, by - ay));
  }
  return least;
}
function boundaryEdges(indices: Uint32Array) {
  const edges = new Map<string, EdgeIndex & { count: number }>();
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = indices[i + j]!, b = indices[i + (j + 1) % 3]!, key = Math.min(a, b) + ':' + Math.max(a, b);
    const e = edges.get(key); if (e) e.count++; else edges.set(key, { a, b, count: 1 });
  }
  return [...edges.values()].filter(e => e.count === 1);
}
function roundShape(graphics: Graphics, x: number, y: number, radius: number) {
  // Graphics tessellation works in local units; metre-sized circles would
  // otherwise become hexagons when enlarged by the camera.
  const points = [];
  for (let i = 0; i < 40; i++) { const angle = i * Math.PI / 20; points.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius); }
  return graphics.poly(points);
}
// Words over the field, with a dark edge that reads on sky and ground alike.
const fieldWords = (text: string, fill: ColorSource, fontSize = 12, fontWeight: TextStyleOptions['fontWeight'] = 'normal') =>
  new Text({ text, style: { fontFamily: 'system-ui', fontSize, fontWeight, fill, stroke: { color: 0x23372e, width: 3 } } });
// The name of a base stands over its flag, at the size of the words of the page whatever the zoom.
function placeBaseLabel(label: Text, flag: Point, zoom: number) { label.position.set(flag.x, flag.y + 3 / zoom); label.scale.set(1 / zoom, -1 / zoom); }
// An arc as it is drawn: from afar one line, near at hand dashes, a pair of its points each.
function traceArc(g: Graphics, path: readonly Point[], distant: boolean) {
  if (distant) { g.moveTo(path[0]!.x, path[0]!.y); for (let i = 1; i < path.length; i++) g.lineTo(path[i]!.x, path[i]!.y); }
  else for (let i = 0; i < path.length - 1; i += 2) g.moveTo(path[i]!.x, path[i]!.y).lineTo(path[i + 1]!.x, path[i + 1]!.y);
  return g;
}




// The grid of the construction, a line on every cell (grid.ts), each told how many cells it stands on of the coarser
// grids it is also a line of; the finer are drawn only where they stand far enough apart (`gridStep`). Construction-only
// lines are clipped and cached when the document changes.
const GRID_STEPS = [1, 2, 20];
const gridEvery = (n: number) => GRID_STEPS.findLast(step => n % step === 0)!;
const gridStep = (zoom: number) => GRID_STEPS.find(step => step * CELL * zoom >= 6) ?? GRID_STEPS.at(-1)!;
function constructionGrid(rooms: readonly CompiledRoom[] = []): GridLine[] {
  const lines: GridLine[] = [];
  for (const room of rooms) {
    const poly = room.polygon, x0 = Math.min(...poly.map(p => p.x)), x1 = Math.max(...poly.map(p => p.x)),
      y0 = Math.min(...poly.map(p => p.y)), y1 = Math.max(...poly.map(p => p.y));
    // A room may be concave: a line is kept on every stretch of it that runs inside.
    const clip = (a: Point, b: Point, every: number) => {
      const point = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }), cuts = [0, 1];
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length]!, turn = (b.x - a.x) * (q.y - p.y) - (b.y - a.y) * (q.x - p.x);
        if (Math.abs(turn) > 1e-12) cuts.push(clamp(((p.x - a.x) * (q.y - p.y) - (p.y - a.y) * (q.x - p.x)) / turn, 0, 1));
      });
      cuts.sort((m, n) => m - n);
      for (let i = 0; i + 1 < cuts.length; i++)
        if (cuts[i + 1]! - cuts[i]! > 1e-9 && within(point((cuts[i]! + cuts[i + 1]!) / 2), poly)) lines.push([point(cuts[i]!), point(cuts[i + 1]!), every]);
    };
    // A single authored grid stays in place when rooms open or their plates change thickness.
    const grid = VEHICLE_ORIGIN;
    for (let x = Math.ceil((x0 - grid.x) / CELL - 1e-9); x <= Math.floor((x1 - grid.x) / CELL + 1e-9); x++)
      clip({ x: grid.x + metresOf(x), y: y0 }, { x: grid.x + metresOf(x), y: y1 }, gridEvery(x));
    for (let y = Math.ceil((y0 - grid.y) / CELL - 1e-9); y <= Math.floor((y1 - grid.y) / CELL + 1e-9); y++)
      clip({ x: x0, y: grid.y + metresOf(y) }, { x: x1, y: grid.y + metresOf(y) }, gridEvery(y));
  }
  return lines;
}
function destroyMesh(item: RenderDrawable) {
  // These drawings belong to the part: a children-only destroy leaves their GPU contexts alive.
  item.group.destroy({ children: true, context: true }); item.geometry.destroy(); item.tyreShade?.destroy();
  // What is kept of it outside its own group: the rim of a plate, the shadow under a gear, the heap over a hopper, and
  // its outline and light edge (which keep the drawing they share with other parts).
  for (const kept of [item.rim, item.shade, item.heap, item.silhouette, item.glint]) if (kept && !kept.destroyed) kept.destroy({ children: true, context: true });
}
// Hull fittings and outlines live in actor layers, outside the skin sprite.
// Release them both when a hull vanishes and when its whole scene is cleared.
function destroyHull(sprite: HullSprite) {
  for (const kept of [sprite.rim, sprite.fittings, sprite.silhouette, sprite.glint]) if (kept && !kept.destroyed) kept.destroy({ children: true, context: true });
  sprite.destroy();
}
// A mesh with a shader of its own is drawn on its own, and one without it in a batch with the rest. Pixi settles which
// when it builds a mesh, and again only of one whose picture changed on a frame that changes nothing else on the
// stage: a mesh that changes over on a frame that also changes the stage (a wheel losing its outline with its light,
// say) is built as it was before, and the first frame that only moves it then updates it in a batch it is not in, and
// stops the drawing. A part that changes over is given a new mesh for it, then, standing as the one it had stood.
function remesh(item: RenderDrawable, shader: Shader | null) {
  const old = item.mesh, mesh = new Mesh({ geometry: item.geometry, texture: old.texture, shader: shader! });
  mesh.rotation = old.rotation; mesh.tint = old.tint; mesh.visible = old.visible;
  item.group.addChildAt(mesh, item.group.getChildIndex(old)); old.destroy();
  item.mesh = mesh;
}
// The aerial of a radar `width` × `height` (machine-art.ts `radarAerial`) that points to `bearing` when it is put up: a
// sprite for each visible side. Orthographic faces keep their height and pivot
// throughout a turn; only their widths and lateral positions change.
function aerialMeshes(width: number, height: number, bearing: number, whose: AerialIdentity = {}): Aerial {
  const aerial = Object.assign(new Container<Sprite>(), { radar: { ...whose, width, height, shape: radarAerial(width, height), bearing } }), side = () => { const sprite = new Sprite(); sprite.anchor.set(.5); return sprite; };
  aerial.addChild(side(), side());
  return aerial;
}
// What the sight of each aerial is worked out in, one after another (machine-art.ts `aerialView`).
const AERIAL_SIGHT = aerialSight();
// A colour as lit as `light` (from 0 to 1).
const lit = (color: number, light: number) => Math.round((color >> 16 & 255) * light) << 16 | Math.round((color >> 8 & 255) * light) << 8 | Math.round((color & 255) * light);
// Where an aerial was pointing when it was put up: radars do not turn in step.
const aerialBearing = (id: string) => { let h = 7; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h / 2 ** 32 * Math.PI * 2; };
function drawablePoints(item: ShadowDrawing): readonly Point[] {
  if (item.outline) return item.outline;
  if (item.placement) return item.outline = (item.data as { outline: readonly Point[] }).outline.map(p => chassisPoint(item.placement!, p.x, p.y));
  const c = Math.cos(item.group.rotation), s = Math.sin(item.group.rotation), sx = item.group.scale?.x ?? 1, sy = item.group.scale?.y ?? 1;
  return item.outline = Array.from({ length: item.positions!.length / 2 }, (_, i) => {
    const x = item.positions![i * 2]! * sx, y = item.positions![i * 2 + 1]! * sy;
    return { x: item.group.x + c * x - s * y, y: item.group.y + s * x + c * y };
  });
}

export class Renderer<State extends RenderFieldView = FieldView> {
  declare view: RendererView;
  declare element: HTMLElement;
  declare camera: Camera;
  declare canvas: HTMLCanvasElement;
  declare ready: boolean;
  declare workArms?: Map<string, RenderWorkArm>;
  declare ground: Terrain;
  declare site: BoardSite | null;
  declare host?: Renderer<State>;
  declare fieldBoard?: RendererBoard<State>;
  declare constructionPreview?: RendererBoard<State> | null;
  declare benchSite?: BoardSite | null;
  declare fog: FieldFog | null;
  declare eyes: GroundSight | null;
  declare sight: ViewSight;
  declare modulePreview: CanvasModulePreview | null;
  declare platePreview: { a: CanvasPlatePoint; b: CanvasPlatePoint } | null;
  declare strike: RenderStrike | null;
  declare marquee: { start: Point; end: Point } | null;
  declare hoverId: string | null | undefined;
  declare edgeHover: EditorPlateSpan | RoomHandle | null;
  declare vertexHover: Point | null;
  declare joinTargets: Point[];
  declare app: Application;
  declare textures: Map<string, RenderTextureEntry>;
  declare usedTextures: Set<string>;
  declare nextTexturePaint: RenderTextureEntry | null;
  declare asked: string[] | null;
  declare frameNow: number;
  declare playback: FramePresentation<State>;
  declare aimQueries: AimQueries;
  declare aimPresentation?: AimPresentation<AimForecast>;
  declare tails: ShotQuads; declare markers: ShotQuads; declare glows: ShotQuads;
  declare specks: ShotQuads; declare speckGlows: ShotQuads;
  declare weaponRecoil: Map<string, RecoilMotion>;
  // The turning barrels of rotary guns, by their muzzle events, and the ready rounds of guns fed by a belt or a magazine, as
  // their frames tell them (weapon-presentation.ts): stepped with the effects, drawn by the weapon sprites.
  declare weaponSpin: Map<string, SpinMotion>; declare weaponFeed: Map<string, FeedMotion>;
  declare weaponPaint: WeaponSpriteOptions & { recoil: number; alpha: number; tint: number; weathering?: ReturnType<typeof prepareWeathering> };
  declare fireProfiles: WeakMap<object, FireProfile | null>;
  declare fireProbe: ArtCanvas | null;
  declare effectSurfaceClip: EffectSurfaceClip;
  declare heatHaze: HeatHaze; declare hotBarrels: HotBarrel[];
  declare surfaceLight: SurfaceLight;
  declare screenShake: ScreenShake;
  declare meter: FrameMeter | null;
  declare releaseSamplers: () => void;
  declare releaseScene: Container;
  declare releaseTarget: RenderTexture;
  declare observer: ResizeObserver;
  declare silhouettes: SilhouetteArt;
  declare marked: ReadonlyMap<string, SilhouetteStyle> | null;
  declare resting: RestingArt;
  declare armorArt: ArmorArtCache;
  declare armorPlan: ReturnType<ArmorArtCache['prepare']> | null;
  declare labelIcons: LabelIcons;
  declare flameImage: HTMLImageElement;
  declare baseMaterials: Awaited<ReturnType<typeof loadBaseMaterials>>;
  declare wearImages: { scuffs: HTMLImageElement; oxide: HTMLImageElement; earth: HTMLImageElement; oil: HTMLImageElement };
  declare weatheringMaps: ReturnType<typeof prepareWeathering>;
  declare weatheringFills: { workArm: Parameters<typeof createWorkArmWeathering>[0] };
  declare wheelSurface: ReturnType<typeof surfaceGrain>;
  declare trackSurfaces: { steel: ReturnType<typeof surfaceGrain>; rubber: ReturnType<typeof surfaceGrain> };
  declare radarSurface: ReturnType<typeof surfaceGrain>;
  declare frameSurface: ReturnType<typeof surfaceGrain>;
  declare rockTexture: ReturnType<typeof mineralTexture>;
  declare hullSurfaces: { outside: ReturnType<typeof surfaceGrain>; concrete: ReturnType<typeof surfaceGrain> };
  declare texturePainter: TexturePainter;
  declare backdrop: Backdrop;
  declare world: Container; declare terrain: Container; declare scenery: Container;
  declare shadows: Graphics; declare groundMarks: Container;
  declare scorchMarks: ScorchMarks;
  declare terrainScene: TerrainScene;
  declare dust: AmbientDust;
  declare benchArt: Container; declare trails: Graphics; declare actorLayerRoot: Container;
  declare shotAtlas: CanvasTexture;
  declare fxLayer: Container;
  declare effects: Effects;
  declare groundTrails: GroundTrails;
  declare mist: GroundMist;
  declare overlay: Graphics; declare labels: Container;
  declare impactLabel: Text; declare servoLabel: Text; declare leadLabel: Text;
  declare strikeWords: Text; declare strikeDetail: Text; declare recoilLabel?: Text;
  declare terrainKey: ReturnType<typeof terrainDrawKey>;
  declare weather: string;
  declare roadsTold: readonly Road[] | null;
  declare gridLines: GridLine[];
  declare blueprint: CompiledConstruction;
  declare designState: DesignScene;
  declare designFaces: BodyPanel[];
  declare underfoot?: { of: Terrain; ground: ReturnType<typeof underfootGround> };
  declare holdArt: boolean;
  declare presentationAlpha: number;
  declare scene: SceneSample<RendererDrawing> | null;
  declare unseen: Set<string>; declare closed: Set<string>; declare covered: Set<string>; declare dotted: Set<string>;
  declare nextDepth: number; declare actorDots: Graphics | null; declare dotsKey: string;
  declare opened?: ReadonlySet<string> | null;
  declare burningSurfaceCount?: number;
  declare depositPosts?: HazedGraphics;
  declare drawables: Map<string, RenderDrawable>;
  declare hullSprites: Map<string, HullSprite>;
  declare actorLayers: Map<string, ActorLayers>;
  declare weaponArt: WeaponSprites<RenderTextureEntry>;
  declare armament?: ArmamentCache;
  declare labelBoxes: Map<string, LabelBox>;
  declare siteMarkers: SiteMarkers;
  declare flagArts: Map<string, GraphicsContext>;
  declare flagTextures: Map<string, Texture | null>;
  declare bodyFeet?: Map<string, [Point, Point][]>;
  declare hullFeet?: Map<string, [Point, Point][]>;
  declare arched?: Map<string, Point[]>;
  declare labelPen?: CanvasRenderingContext2D;
  declare aimPreview: { path: readonly Point[]; reachable: boolean } | null;
  declare linkedMade?: number;
  declare linkedKept?: Map<string, LinkedArc>;
  declare lifted: number;
  declare widened?: Point & { zoom: number; width: number; height: number };
  declare roadMachines?: Map<string, RenderMachine>;
  declare carriedDetail?: Sprite;
  declare impactSources?: (kind: string, variant: number) => CanvasImageSource;
  declare airdropDescent?: AirdropDescent<Terrain> | null;
  declare marks: Container;
  declare baseArt?: Graphics;
  declare baseWorks?: HazedGraphics;
  declare watchPieces?: Container<Sprite | Aerial>;
  declare baseWatch?: Graphics;
  declare baseLabel?: Text;
  declare baseDrawn?: DrawnBase;
  declare foreignBases?: Map<string, ForeignBaseArt>;
  declare depositSites?: Map<string, DepositDrawing>;
  declare depositFading: FadingDeposit[];
  declare depositWorks: Container;
  declare depositUnder: Container;
  declare depositFront: Container;
  declare depositsLaid?: LaidDeposits | null;
  constructor(element: HTMLElement, view: RendererView = {}) {
    this.view = view;
    view.mode ??= 'edit'; view.buildTool ??= 'select'; view.testTool ??= 'fire';
    view.aim ??= { x: 10, y: 1.4 }; view.weapon ??= null;
    this.element = element; this.camera = new Camera(); this.textures = new Map();
    this.usedTextures = new Set(); this.ready = false;
    this.initConstructions();
    // On a field with fog: the ground the faction sees and knows (`fog`), its eyes, and what it sees over the view (`sight`).
    this.site = null; this.fog = null; this.eyes = null; this.sight = new ViewSight();
    this.weaponRecoil = new Map(); this.weaponSpin = new Map(); this.weaponFeed = new Map(); this.weaponPaint = { recoil: 0, alpha: 1, tint: 0xffffff };
    this.modulePreview = this.platePreview = null; this.joinTargets = []; this.flagArts = new Map(); this.flagTextures = new Map();
    // The strike of a test of armour being aimed, or fired a moment ago (armour-strike.ts, `drawStrike`).
    this.strike = null;
    // Where the label of each works and each heap of the faction stands on the screen this frame, and what of the view it
    // marks with what it labels (`drawWorks`), by its kind and id.
    this.siteMarkers = new SiteMarkers({ text: fieldWords, flagTexture: (flag: FactionFlag) => this.flagTexture(flag),
      pilePicture: (look: PileLook) => this.pilePicture(look), markHeight: (x: number) => this.markHeight(x) });
    this.frameNow = 0;
    this.playback = new FramePresentation<State>();
    this.aimQueries = new AimQueries();
    this.tails = new ShotQuads(); this.markers = new ShotQuads(); this.glows = new ShotQuads();
    this.specks = new ShotQuads(); this.speckGlows = new ShotQuads();
    // The outlines of the parts of the constructions, a drawing for each shape (silhouette.ts); and how each
    // construction the player has picked is edged (`marked`, by the page: 'selected').
    this.silhouettes = new SilhouetteArt(); this.marked = null;
    this.fireProfiles = new WeakMap(); this.fireProbe = null;
    this.effectSurfaceClip = new EffectSurfaceClip();
    this.heatHaze = new HeatHaze(); this.hotBarrels = [];
    this.surfaceLight = new SurfaceLight();
    // The shake of the view (screen-shake.ts): only the drawing of the world is thrown, never the camera.
    this.screenShake = new ScreenShake();
    // Whoever times the frames, when someone does (frame-meter.ts): `draw` marks each stretch of its work for it, by name,
    // and in detail tells it what the frame sent to the video card (`countCalls`) and how near it drew the field.
    this.meter = null;
    this.releaseSamplers = () => {
      if (this.releaseScene) this.app.renderer.render({ container: this.releaseScene, target: this.releaseTarget, clear: true });
    };
  }
  // While the meter tells the detail of the frames, the calls of the context that draw and that send pictures and corners
  // to the video card are counted for it, each as it is made; off, the context is as Pixi has it again.
  countCalls(on: boolean) {
    const renderer = this.app?.renderer, gl = renderer && 'gl' in renderer ? renderer.gl : null;
    if (!gl) return;
    const calls = { drawElements: 'draws', drawArrays: 'draws', drawElementsInstanced: 'draws', drawArraysInstanced: 'draws',
      texImage2D: 'textures', texSubImage2D: 'textures', compressedTexImage2D: 'textures', bufferData: 'buffers', bufferSubData: 'buffers' };
    for (const [call, name] of Object.entries(calls)) {
      if (!on) { if (Object.hasOwn(gl, call)) Reflect.deleteProperty(gl, call); continue; }
      const made: unknown = Reflect.get(Object.getPrototypeOf(gl), call);
      if (typeof made === 'function' && !Object.hasOwn(gl, call)) Reflect.set(gl, call, (...args: unknown[]) => { this.meter?.tally(name); return Reflect.apply(made, gl, args); });
    }
  }
  // The field, workshop board and placement preview each own their construction
  // drawings. Their texture cache and painter stay with the host.
  initConstructions() {
    this.drawables = new Map(); this.hullSprites = new Map(); this.actorLayers = new Map(); this.nextDepth = 0;
    this.unseen = new Set(); this.closed = new Set(); this.covered = new Set(); this.scene = null;
    // Of those, the ones on the screen that are drawn as marks from afar (`cullActors`), and the drawing of the marks.
    this.dotted = new Set(); this.actorDots = null; this.dotsKey = '';
    this.weaponArt = new WeaponSprites((key, create, place) => this.texture(key, create, false, place), entry => this.usedTextures.add(entry.key));
    this.resting = new RestingArt(); this.armorArt = new ArmorArtCache(); this.armorPlan = null;
    // Current screen bounds of individual/grouped labels, including wreck marks.
    this.labelIcons = new LabelIcons(); this.labelBoxes = new Map();
  }
  get state() { return this.playback.state; }
  get previous() { return this.playback.previous; }
  get presentedState() { return this.playback.display?.state; }
  // What this renderer draws: the design, or a world told in frames. On a bench of its own that is what
  // the player is doing. With the workshop in the field (`site`) the player works on the design while this
  // renderer goes on showing the field, and the design is drawn by the board that stands there (`fieldBoard`).
  get mode() { return this.site ? 'test' : this.view.mode!; }
  // The field is only looked at: the player's hands are on the board standing in it.
  get watching() { return Boolean(this.site) && !this.host; }
  // Whoever draws the design, with the camera and the ground of the frame the design is made in.
  get boardFrame() { return this.site || (this.view.mode === 'edit' ? this.benchSite : null); }
  get board(): Renderer<State> | RendererBoard<State> { return this.boardFrame ? this.fieldBoard || this : this; }
  get tool() { return (this.mode === 'edit' ? this.view.buildTool : this.view.testTool)!; }
  set tool(value: RendererTool) { this.view[this.mode === 'edit' ? 'buildTool' : 'testTool'] = value; }
  get aim() { return this.view.aim!; }
  set aim(value: Point) { this.view.aim = value; }
  get weapon() {
    const state = this.state, actorId = state?.controlledActor || 'local', editor = this.view.editor;
    const source = this.mode === 'edit' || !state ? editor?.blueprint : state, intent = this.view.weapon;
    const key = this.mode + ':' + actorId + ':' + editor?.revision;
    if (this.armament?.source === source && this.armament!.intent === intent && this.armament!.key === key) return this.armament!.value;
    // A wreck has no gun in hand (wreck.ts): of a test whose design became one, nothing is aimed nor fired.
    const wreck = source === state && state?.actors?.some(actor => actor.id === actorId && actor.defeated),
      modules = wreck ? [] : source === state && state ? state.modules.filter(m => m.actorId === actorId) : editor?.blueprint.modules || [];
    const value = resolveArmament(intent!, modules, this.mode !== 'edit' && Boolean(state?.shared));
    this.armament = { source, intent, key, value }; return value;
  }
  get selection() { return this.view.editor?.selection; }
  get selectionIds() { return [...(this.view.editor?.selectionIds || [])]; }
  async init() {
    this.app = new Application();
    try {
      await this.app.init({ preference: ['webgl'], width: this.element.clientWidth, height: this.element.clientHeight, antialias: true, autoStart: false, resolution: Math.min(devicePixelRatio || 1, 2), backgroundColor: 0xb0b9b6 });
    } catch (cause) {
      const detail = String(cause != null && (typeof cause === 'object' || typeof cause === 'function') && 'message' in cause ? cause.message || cause : cause), assets = /dynamically imported module|Importing a module script failed|loading dynamically imported module/i.test(detail),
        unavailable = !assets && /No available renderer|browser does not support WebGL|Error creating WebGL context/i.test(detail),
        message = assets ? tr('Os arquivos gráficos não terminaram de carregar. Recarregue a página.') : unavailable ?
          tr('Não foi possível iniciar o WebGL. Verifique se a aceleração gráfica está disponível e recarregue a página.') :
          tr('Não foi possível iniciar o desenho do jogo. Recarregue a página.');
      throw Object.assign(new Error(message, { cause }), { code: unavailable ? 'WEBGL_UNAVAILABLE' : 'RENDERER_UNAVAILABLE' });
    }
    const load = async (url: URL) => { const image = new Image(); image.src = url.href; await image.decode(); return image; };
    const [baseMaterials, images] = await Promise.all([loadBaseMaterials(), Promise.all([
      load(new URL('./assets/wheel-grain.webp', import.meta.url)),
      load(new URL('./assets/terrain-soil-detail.webp', import.meta.url)),
      load(new URL('./assets/terrain-rock-detail.webp', import.meta.url)),
      load(new URL('./assets/hull-outside-grain.webp', import.meta.url)),
      load(new URL('./assets/concrete-grain.webp', import.meta.url)),
      load(new URL('./assets/flora-natural-v2.webp', import.meta.url)),
      load(new URL('./assets/clouds-natural-v6.webp', import.meta.url)),
      load(new URL('./assets/scenery-ranges-v4.webp', import.meta.url)),
      load(new URL('./assets/frame-grain.webp', import.meta.url)),
      load(new URL('./assets/boulder-grain.webp', import.meta.url)),
      load(new URL('./assets/track-steel-grain.webp', import.meta.url)),
      load(new URL('./assets/track-rubber-grain.webp', import.meta.url)),
      load(new URL('./assets/radar-grain.webp', import.meta.url)),
      load(new URL('./assets/wear-scuffs.webp', import.meta.url)),
      load(new URL('./assets/wear-oxide.webp', import.meta.url)),
      load(new URL('./assets/wear-earth.webp', import.meta.url)),
      load(new URL('./assets/wear-oil.webp', import.meta.url)),
      load(new URL('./assets/fire-flame.png', import.meta.url)),
    ])]);
    const [wheel, soil, rock, outside, concrete, flora, clouds, ranges, frame, boulder, trackSteel, trackRubber, radar, scuffs, oxide, earth, oil, flames] = images;
    this.flameImage = flames;
    this.baseMaterials = baseMaterials;
    // The images of the wear are kept: its canvases are made from them again when the video card loses them (`repaint`).
    this.wearImages = { scuffs, oxide, earth, oil }; this.wear();
    this.app.stage.once('destroyed', () => {
      this.releaseSamplers(); destroyWeathering(this.weatheringMaps); destroyBaseMaterials(baseMaterials);
    });
    this.wheelSurface = surfaceGrain(wheel);
    this.trackSurfaces = { steel: surfaceGrain(trackSteel, 512), rubber: surfaceGrain(trackRubber, 512) };
    this.radarSurface = surfaceGrain(radar, 512);
    this.frameSurface = surfaceGrain(frame, 512); this.rockTexture = mineralTexture(surfaceGrain(boulder, 512));
    const concreteSurface = surfaceGrain(concrete, 512);
    this.hullSurfaces = { outside: surfaceGrain(outside, 512), concrete: concreteSurface };
    this.texturePainter = new TexturePainter(this.paintingMaterials());
    this.app.stage.once('destroyed', () => this.texturePainter.destroy());
    this.app.ticker.stop(); this.canvas = this.app.canvas; this.canvas.id = 'battle-canvas'; this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', tr('Vista lateral do jogo: monte construções na Oficina, teste disparos e comande o esquadrão no campo.'));
    this.element.prepend(this.canvas);
    this.buildScene({ soil: surfaceGrain(soil, 512), rock: surfaceGrain(rock, 512), concrete: concreteSurface }, { flora, clouds, ranges });
    for (const texture of [this.terrainScene.art!.flora, this.terrainScene.art!.farFlora])
      this.app.renderer.texture.initSource(texture!.source);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.element);
    this.canvas.addEventListener('webglcontextrestored', () => this.repaint());
    return this;
  }
  // The wear the painters lay (weathering.ts), made from its images: its maps, the fills of the arms of the
  // constructions, and the paint of their guns. Those it replaces are let go.
  wear() {
    const old = this.weatheringMaps;
    this.weatheringMaps = prepareWeathering(this.wearImages);
    this.weatheringFills = { workArm: {
      armPaint: weatheredFill(this.weatheringMaps, WORK_ARM_WEATHERING.armPaint),
      bucketSteel: weatheredFill(this.weatheringMaps, WORK_ARM_WEATHERING.bucketSteel),
      mastSteel: weatheredFill(this.weatheringMaps, WORK_ARM_WEATHERING.mastSteel),
      seatSteel: weatheredFill(this.weatheringMaps, WORK_ARM_WEATHERING.seatSteel),
    } };
    this.weaponPaint.weathering = this.weatheringMaps;
    if (old) destroyWeathering(old);
  }
  // The video card was taken from the page and given back: a reset of its driver, the GPU process of the browser started
  // again. Pixi has made its context anew and uploads each texture again from what it was made of (GlContextSystem), but
  // the canvases the browser kept on the video card come back empty, and the pictures painted on them with them: of a
  // construction there would be left its outline and what is drawn without a picture. All that is painted is painted
  // again, on canvases of its own: every picture of a construction, which goes with the drawings that hold it and is
  // asked for anew by the next frame, those kept for the whole game too; the wear and the painter that lays it; the
  // atlases of the rounds and of the effects; the ranges behind.
  repaint() {
    for (const board of [this, this.fieldBoard, this.constructionPreview]) {
      if (!board) continue;
      board.clearConstructions();
      if (Object.hasOwn(board, 'workArms')) for (const arm of board.workArms!.values()) arm.weathering = null;
    }
    for (const entry of this.textures.values()) entry.persistent = false;
    this.releaseTextures(true);
    this.wear();
    this.texturePainter.destroy(); this.texturePainter = new TexturePainter(this.paintingMaterials());
    repaintTexture(this.shotAtlas, paintShotAtlas()); repaintTexture(this.effects.atlas.glow, paintParticleAtlas(this.flameImage));
    this.backdrop.repaint();
  }
  // Everything a frame draws, under the stage of the application. It is made apart from the screen it is
  // shown on, so that a frame can be drawn, and what it hands Pixi looked at, where there is none.
  buildScene(groundSurfaces: Record<'soil' | 'rock' | 'concrete', Float32Array>, scenicArt: ConstructorParameters<typeof Backdrop>[1] & { flora?: HTMLImageElement } = {}) {
    // Behind the world: the sky and the ranges. Low cover has its own fixed row
    // in front of the vehicles; trees and the rest of the scenery stay behind.
    this.backdrop = new Backdrop(this.releaseSamplers, scenicArt); this.app.stage.addChild(this.backdrop.root);
    this.world = new Container(); this.app.stage.addChild(this.world);
    this.terrain = new Container(); this.scenery = new Container(); this.shadows = new Graphics();
    // The marks of the bursts lie over the shadows, as they were drawn after them when they were drawn with them.
    this.scorchMarks = new ScorchMarks(new Graphics()); this.groundMarks = new Container();
    const grains = grainTextures(groundSurfaces);
    this.app.stage.once('destroyed', () => { for (const texture of Object.values(grains)) texture.destroy(true); });
    // The trees behind the ground line are painted from the same atlas seen through the haze (haze.ts), once.
    this.terrainScene = new TerrainScene(this.terrain, this.scenery, { grains,
      flora: floraTexture(scenicArt.flora), farFlora: scenicArt.flora && pieceTexture(hazedPicture(scenicArt.flora, TREE_HAZE)),
      masonry: mineralTexture(groundSurfaces.concrete) });
    this.dust = new AmbientDust(); this.terrainScene.layers.works.addChild(this.dust.host);
    this.benchArt = new Container(); this.trails = new Graphics();
    this.actorLayerRoot = new Container(); this.actorLayerRoot.sortableChildren = true;
    const shots = this.shotAtlas = textureFromCanvas(paintShotAtlas());
    this.world.addChild(this.terrain, this.scenery, this.groundMarks,
      this.shadows, this.scorchMarks.graphics, this.actorLayerRoot, this.terrainScene.foreground, this.benchArt, this.tails.attach(shots), this.trails,
      this.markers.attach(shots), this.specks.attach(shots), this.glows.attach(shots, 'add'), this.speckGlows.attach(shots, 'add'));
    this.surfaceLight.init(this.world);
    this.world.setChildIndex(this.surfaceLight.ground!, this.world.getChildIndex(this.actorLayerRoot));
    this.app.stage.once('destroyed', () => this.surfaceLight.destroy());
    this.fxLayer = new Container(); this.world.addChild(this.fxLayer); this.effects = new Effects(this.fxLayer,createParticleAtlas(this.flameImage));
    this.effectSurfaceClip.attach(this.fxLayer);
    this.heatHaze.init(); this.world.addChild(this.heatHaze.host);
    this.effectSurfaceClip.attach(this.heatHaze.host);
    this.effects.actorLayer = id => this.actorLayers.get(id)?.fxLayer;
    // A part of a construction where this frame shows it, for what the effects keep on it.
    this.effects.pose = id => this.scene?.pose(id) ?? this.scene?.actor(id) ?? null;
    this.effects.velocity = id => this.scene?.actor(id) ?? null;
    this.effects.fireProfile = id => this.componentFireProfile(id);
    this.effects.fireSurface = id => fireSurface(this.scene, id, !this.closed.has(id!), this.effects.fireProfile, this.effects.view);
    this.groundTrails = new GroundTrails(this.groundMarks, this.effects);
    // Over the world and all that goes on in it, the haze over what is out of sight and the mist of the ground never
    // seen (ground-mist.ts), by what the faction sees over the view (`sight`); over them what is an instrument of the
    // player: the marks of the sensors, the aim, the labels, the base.
    this.mist = new GroundMist(); this.world.addChild(this.mist.root);
    // Aim and selection paths change every frame; rebuild their instructions apart from the scenery and fleet.
    // Its camera anchor keeps both the vertices and the render-group transform small on long maps.
    this.overlay = new Graphics({ isRenderGroup: true }); this.labels = new Container(); this.world.addChild(this.overlay, this.labels);
    const aimLabels = [0xffdfac, 0xffdfac, 0xa9dfe3].map(fill => {
      const label = this.world.addChild(fieldWords('', fill)); label.visible = false; return label;
    });
    this.impactLabel = aimLabels[0]!; this.servoLabel = aimLabels[1]!; this.leadLabel = aimLabels[2]!;
    // What a strike of the test of armour does where it strikes, and what it strikes there (`drawStrike`).
    const strikeLabels = ([[14, '700'], [12, 'normal']] as const).map(([size, weight]) => {
      const label = this.world.addChild(fieldWords('', 0xffdfac, size, weight)); label.visible = false; return label;
    });
    this.strikeWords = strikeLabels[0]!; this.strikeDetail = strikeLabels[1]!;
    // Rebind both mesh and batch samplers before releasing damaged textures.
    // Draw offscreen so restoring the scene never flashes an empty canvas.
    this.releaseTarget = RenderTexture.create({ width: 1, height: 1 });
    this.releaseScene = new Container();
    const releaseGeometry = new MeshGeometry({ positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
    releaseGeometry.batchMode = 'no-batch';
    this.releaseScene.addChild(new Mesh({ geometry: releaseGeometry, texture: Texture.EMPTY }), new Sprite(Texture.EMPTY));
    // Compile the shared tyre program while loading, on the existing offscreen target.
    // Keep the release quad and program; discard only this temporary mesh and shader instance.
    const tyreShader = new TyreShade(Texture.EMPTY),
      tyreMesh = this.releaseScene.addChild(new Mesh({ geometry: releaseGeometry, texture: Texture.EMPTY, shader: tyreShader }));
    try { this.releaseSamplers(); }
    finally { this.releaseScene.removeChild(tyreMesh); tyreMesh.destroy(); tyreShader.destroy(); }
    this.drawTerrain(); this.ready = true; this.resize();
  }
  resize() {
    if (!this.ready) return;
    const width = Math.max(300, this.element.clientWidth), height = Math.max(280, this.element.clientHeight);
    this.app.renderer.resize(width, height); this.camera.width = width; this.camera.height = height; this.backdrop.resize(width, height, this.app.renderer.resolution);
  }
  setTerrain(id: string, settings: TerrainOptions = {}, weather = 'clear') {
    const key = terrainDrawKey(id, settings, weather, this.terrainKey);
    if (this.terrainKey === key) return;
    const ground = new Terrain(id, settings);
    this.terrainKey = key; this.weather = weather;
    this.ground = ground; this.roadsTold = null; if (this.effects) this.effects.terrain = this.ground;
    this.groundTrails?.clear();
    if (this.terrain) this.drawTerrain();
  }
  // The roads the field has laid on its ground, as the state tells them (roads.ts): the ground the renderer reads is
  // theirs where they lie, and the scenery is drawn again where they change.
  setRoads(told: readonly Road[] = NO_ROADS) {
    if (told === this.roadsTold) return;
    this.roadsTold = told;
    const before = this.ground.roads, roads = normalRoads(told), changed = unlike(before, roads);
    if (!changed.length) return;
    this.ground.roads = roads; this.terrainScene?.repaved(changed);
  }
  drawTerrain() {
    this.ground ||= new Terrain();
    if (this.effects) this.effects.terrain = this.ground;
    this.camera.limits = groundView(this.ground);
    // All the scenery follows from the ground and the weather, and is made here, once for a map.
    this.terrainScene.rebuild(this.ground);
    this.backdrop.setScene(this.ground, this.weather || 'clear'); this.dust.setScene(this.ground, this.weather || 'clear');
    this.effectSurfaceClip.update(this.ground, this.camera);
    this.settleDesign();
  }
  // A frame builds nothing of the scenery that it has already shown: it places the backdrop and the dust, and
  // shows the stretches of ground the camera holds. The time is that of the world, which carries the clouds.
  // The meter tells the sky, the trees and the stones apart from the ground under them (terrain-scene.ts marks them).
  drawScenery(time: number, alpha = 1) {
    const camera = this.camera;
    if(this.mode==='test') this.effects.vegetation.write(this.terrainScene.vegetationUniforms.uniforms,camera,this.world.position,time,alpha);
    else this.terrainScene.vegetationUniforms.uniforms.uPlantMotion.fill(0);
    // Over ground never seen the hills behind are those of the nearest ground that is known: they are the biome's.
    this.backdrop.update(camera, time, this.fog ? nearestKnown(this.fog.explored, camera.x) : camera.x); this.dust.update(camera, time);
    this.meter?.mark('scenery');
    this.terrainScene.meter = this.meter; this.terrainScene.update(camera); this.meter?.mark('terrain');
    if (this.meter?.detailed) this.meter.note('ground', this.terrainScene.scale());
  }
  design(blueprint: CompiledConstruction) {
    this.gridLines = constructionGrid(blueprint.rooms);
    this.blueprint = blueprint;
    this.designState = designFrame(blueprint);
    // A compiled construction carries the exact outline of every room its plates close.
    this.designFaces = blueprint.bodyPanels;
    this.settleDesign();
  }
  // On the bench, too, the design is drawn by the board, turned about its middle with its front to the right as the
  // workshop shows every design (`BOARD_FACING`, workshop-site.ts); a fixed one stands at its placement on the ground.
  // Designs retain their authored frame: the board's camera takes the turn and the placement away from pointer
  // coordinates, including nodes and grips.
  settleDesign() {
    if (!this.blueprint) { this.benchSite = null; return; }
    this.benchSite = { x: 0, mirror: true, y: this.blueprint.preset === 'bunker'
      ? constructionPlacement(this.blueprint, this.ground || { height: () => 0 }, { facing: BOARD_FACING, allowDownward: true }).lift : 0 };
    if (this.world) this.fieldBoard ||= this.buildBoard();
  }
  receive(state: State, events: readonly SceneEventBase[], options: Parameters<FramePresentation<State>['receive']>[2] = {}) {
    if (this.mode === 'test') { this.setTerrain(state.terrain || 'flat', state.terrainSettings, state.weather); this.setRoads(state.roads); }
    this.playback.receive(state, events, { now: performance.now(), ...options });
    // The paths of the rounds come with what they met, and are told before it is shown: the effects draw a strike by its round.
    if (events?.length) this.effects?.learn(events);
  }
  advanceEffects(dt: number) {
    this.heatHaze.update(dt);
    this.screenShake.update(dt);
    this.effects.update(dt);
    for (const id of this.weaponRecoil.keys()) {
      if (!advanceWeaponRecoil(this.weaponRecoil.get(id)!, dt)) this.weaponRecoil.delete(id);
    }
    for (const [id, spin] of this.weaponSpin) if (!advanceWeaponSpin(spin, dt)) this.weaponSpin.delete(id);
    // A gun not drawn for a while is forgotten: seen again, its rounds are taken as its frame has them.
    for (const [id, feed] of this.weaponFeed) if (this.frameNow - feed.seen > 4000) this.weaponFeed.delete(id); else advanceFeed(feed, dt);
  }
  // The ground of a frame of a field with fog (`fieldFog`): what the player's faction has in sight on it, each
  // construction where the frame shows it, and what it knows. Nothing off such a field: a test, a field told
  // whole. The eyes are swept over the ground of this renderer, and kept while it is that ground.
  groundFog(sample: PresentationSample<State>) {
    const state = sample.state;
    if (this.mode !== 'test' || !state.shared || !state.faction?.explored) return null;
    if (this.eyes?.ground !== this.ground) this.eyes = new GroundSight(this.ground, { horizon: true });
    return fieldFog(this.eyes, state, id => sample.scene.actor(id));
  }
  // Whether a place along the ground is in the sight of the player's faction: everywhere, without fog, and so
  // is what happens at no place in particular.
  sees(x: number | undefined) { return !this.fog || !Number.isFinite(x) || contains(this.fog.seen, x!); }
  // How high a mark of the page stands at a place: on the ground, and where the ground was never seen, in the
  // bank of mist over it (`lift`, in ground-mist.ts). A mark put on the ground itself there would draw its relief.
  markHeight(x: number, depositId: string | null = null) {
    const floor = this.ground.height(x) + (this.mist?.lift(x) ?? 0), load = depositId && this.depositSites?.get(depositId)?.load;
    return load ? Math.max(floor, load.y + load.height) : floor;
  }
  // The ground what stands on it is drawn on: close enough for the ground to be drawn with the bumps its running gear
  // stands on (`BUMPS_ZOOM`, terrain-scene.ts), on them (`underfootGround`), so that the shadow of a gear, its road
  // wheels, its marks and a footing meet the ground where the gear does. Ground read anywhere else is as it is, and so
  // is none, before the renderer is given one (`drawTerrain`).
  standing() {
    const ground = this.ground;
    if (!ground || this.camera.zoom < BUMPS_ZOOM || Object.hasOwn(ground, 'height')) return ground;
    if (this.underfoot?.of !== ground) this.underfoot = { of: ground, ground: underfootGround(ground) };
    return this.underfoot.ground;
  }
  // Whether a point is on the screen or within a screen of it.
  near(point: {x?: number | undefined; y?: number | undefined}) {
    const camera = this.camera, width = camera.width / camera.zoom, height = camera.height / camera.zoom;
    return !Number.isFinite(point.x! + point.y!) ||
      Math.abs(point.x! - camera.x) <= width * 1.5 + 30 && Math.abs(point.y! - camera.y) <= height * 1.5 + 30;
  }
  // `ahead` is how long after the last step of the effects the event came. The step that follows covers
  // that time too, and what the event makes must not be aged by it.
  consumeEffect(event: SceneEventBase, ahead = 0) {
    // What only sparks and smokes for a moment is not made far from the screen: with a field
    // firing at once that is most of it, it would be gone before the camera got there, and it
    // would take the room of what is on the screen. Of a burst there, only the mark it leaves on the ground is made.
    // On a field with fog nothing is made of what happens over ground out of sight.
    const seen = this.sees(event.x);
    if (seen) {
      if (this.near(event)) this.effects.consume([event], ahead);
      else if (event.type === 'explosion') this.effects.scorch(event);
    }
    this.screenShake.event(event, { own: this.state?.controlledActor || 'local', view: this.camera, seen, mode: this.mode });
    // An unseen gun may report its muzzle without its identity: it shakes no gun drawn.
    if (event.type !== 'muzzle' || !event.componentId) return;
    const id = event.componentId, preset = event.preset || this.scene?.pose(id, 'module')?.weaponPreset, stroke = this.recoilStroke(id, event);
    if (stroke > 0) this.weaponRecoil.set(id, startWeaponRecoil(this.weaponRecoil.get(id), stroke, preset, ahead));
    const spin = startWeaponSpin(this.weaponSpin.get(id), preset, ahead);
    if (spin) this.weaponSpin.set(id, spin);
  }
  // The whole stroke a gun on a vehicle recoils as it fires, as far as it does with its bore at the elevation over its
  // hull it fires at (weapons.ts `recoilAt`): drawn along the bore, its breech with it, and back to battery after.
  recoilStroke(id: string, event: SceneEventBase | null = null) {
    const gun = this.scene?.pose(id, 'module'), mount = gun?.weaponMount;
    const bore = Number.isFinite(mount?.hullAxis) ? mount!.hullAxis + angleDifference(event?.angle ?? gun!.barrelAngle!, gun!.angle) : 0;
    return visualRecoilStroke(gun?.weaponPreset || event?.preset, boreElevation(bore));
  }
  // The view the fog is reckoned and drawn over: the camera's, wider and taller by SHAKE_MARGIN pixels to each side,
  // so that no shake of the world (`screenShake`) ever shows an edge of it.
  fogView() {
    const camera = this.camera, view = this.widened ??= { x: 0, y: 0, zoom: 1, width: 0, height: 0 };
    view.x = camera.x; view.y = camera.y; view.zoom = camera.zoom;
    view.width = camera.width + 2 * SHAKE_MARGIN; view.height = camera.height + 2 * SHAKE_MARGIN; return view;
  }
  clearScene() {
    this.camera.follow(null); this.siteMarkers.clear();
    // What the board in the field drew goes first: the textures it was drawn with are released below.
    this.previewConstruction(null);
    this.fieldBoard?.clearConstructions();
    this.clearParts();
    this.heatHaze.clear(this.app?.renderer); this.screenShake.clear();
    this.releaseTextures(true);
    this.effects.clear(); this.groundTrails.clear(); this.weaponRecoil.clear(); this.weaponSpin.clear(); this.weaponFeed.clear(); this.modulePreview = this.platePreview = null;
    this.playback.clear(); this.meter?.renew();
    this.aimQueries.clear(); this.aimPresentation?.clear(); this.linkedKept?.clear(); this.linkedMade = 0;
    this.clearLayers(); this.silhouettes.sweep();
  }
  // What was made for the parts of the constructions drawn here, and then the layers they were drawn into.
  clearParts() {
    for (const item of this.drawables.values()) destroyMesh(item); this.drawables.clear();
    for (const sprite of this.hullSprites.values()) destroyHull(sprite); this.hullSprites.clear();
    this.weaponArt.clear();
    this.armorArt.clear(); this.armorPlan = null;
  }
  clearLayers() {
    for (const id of this.actorLayers.keys()) this.removeActorLayer(id);
    this.actorDots?.destroy({ context: true }); this.actorDots = null; this.dotsKey = '';
    this.nextDepth = 0; this.labelIcons.clear();
  }
  clearConstructions() { this.clearParts(); this.clearLayers(); }
  // The design is drawn in the frame it is made in: the board, its floor at zero and its middle at 12. On
  // a bench of its own that frame is the world, and this renderer draws it. On the shared field the
  // workshop is a place of the base: the board stands at `site` with the field going on about it. This
  // renderer shows the field then, and the design is drawn by `fieldBoard`, over it. Nothing of the
  // design is stated in places of the field, 120 km out: the layers of the board stand at the site, in
  // double precision, and hold the numbers of its own frame.
  //
  // Stands the board in the field, the origin of its frame at `site`, or takes it back to the bench.
  stand(site: BoardSite | null = null) {
    if (site) this.fieldBoard ||= this.buildBoard(); else this.fieldBoard?.clearConstructions();
    this.site = site;
  }
  // The board draws the design as this renderer draws it on the bench, with the same calls: it is made
  // from this renderer, and reads here whatever it has not got of its own — the design, the textures,
  // what the pointer is over. Its own are the layers it draws into, what it makes for the parts, the
  // camera as its frame has it and a level ground, its floor. `body` goes among the constructions of
  // the field, under its rounds and its smoke; `marks` over everything, as the marks of an edit are.
  buildBoard(frame: () => BoardSite = () => this.boardFrame!): RendererBoard<State> {
    const board: RendererBoard<State> = Object.create(this), body = new Container(), marks = new Container();
    // A design has no frame before it.
    Object.defineProperties(board, { mode: { value: 'edit' }, previous: { value: null } });
    const flatGround = new Terrain('flat');
    Object.assign(board, { host: this, body, marks, aimQueries: new AimQueries(), camera: new FramedCamera(this.camera, frame, BOARD.middle), ground: flatGround, flatGround,
      // Nothing burns or smokes on the board: it has no effects to cut at the ground. The bases and the
      // deposits are marks of the field, and its renderer's to draw or to hide.
      effectSurfaceClip: { attach() {}, detach() {} }, drawBase() {}, drawForeignBases() {}, drawSites() {}, drawDeposits() {},
      shade: new Sprite(Texture.WHITE), floor: new Graphics(), shadows: new Graphics(), actorLayerRoot: new Container(), benchArt: new Container(), overlay: new Graphics() });
    board.siteMarkers = new SiteMarkers();
    board.initConstructions();
    board.actorLayerRoot.sortableChildren = true; body.label = 'board'; marks.label = 'board:marks';
    board.shade.tint = BOARD_SHADE; board.shade.alpha = BOARD_DIM;
    body.addChild(board.shade, board.floor, board.shadows, board.actorLayerRoot, board.benchArt); marks.addChild(board.overlay);
    body.visible = marks.visible = false;
    this.world.addChildAt(body, this.world.getChildIndex(this.benchArt) + 1); this.world.addChild(marks);
    return board;
  }
  // A works being placed is only a picture, in its authored frame at the proposed site. It shares the field's
  // painters and lazy texture cache, but has no simulation, editor, selection or orders of its own.
  previewConstruction(blueprint: CompiledConstruction | null, site: BoardSite | null = null, manufactureIssues: NativeAdmissionIssue[] = []) {
    let preview = this.constructionPreview;
    if (!blueprint) {
      if (preview) {
        preview.clearConstructions();
        preview.body.destroy({ children: true, context: true }); preview.marks.destroy({ children: true, context: true });
        this.constructionPreview = null;
      }
      return;
    }
    // Unknown ground never supplies a site. Do not prepare its artwork or read its relief.
    if (!preview && !site) return;
    if (!preview) {
      preview = this.constructionPreview = this.buildBoard(() => this.constructionPreview!.site!);
      preview.view = { mode: 'edit', exterior: true };
      Object.defineProperty(preview, 'weapon', { value: true });
      Object.defineProperty(preview, 'manufactureIssues', { value: [], writable: true });
      preview.drawPlaceLabels = () => [];
      preview.drawOverlay = () => preview!.drawManufactureIssues(
        anchorGraphics(preview!.overlay, preview!.camera.x, preview!.camera.y), 1.1 / preview!.camera.zoom);
      preview.modulePreview = preview.platePreview = null; preview.shade.visible = preview.floor.visible = false; preview.body.alpha = .68;
    }
    if (!Object.hasOwn(preview, 'blueprint') || preview.blueprint !== blueprint) {
      preview.clearConstructions(); preview.blueprint = blueprint;
      preview.designState = designFrame(blueprint); preview.designFaces = blueprint.bodyPanels;
    }
    if (site && (preview.site?.x !== site.x || preview.site?.y !== site.y || preview.site?.mirror !== site.mirror || Object.getPrototypeOf(preview.ground) !== this.ground)) {
      // Moving or turning also changes the footing and its contact shadow. Read the real ground in this frame.
      preview.ground = Object.assign(Object.create(this.ground), { height: (u: number) => this.ground.height(fieldX(site, u)) - site.y });
    }
    preview.site = site; preview.manufactureIssues = manufactureIssues;
    preview.body.visible = preview.marks.visible = Boolean(site) && this.view.mode === 'test';
  }
  get manufactureIssues() { return this.view?.editor?.manufactureIssues ?? []; }
  drawManufactureIssues(g: Graphics, width: number) {
    for (const issue of this.manufactureIssues) if (MARKED_ISSUES.has(issue.code)) for (const id of issue.ids || []) {
      const plate = this.blueprint.plates.find(part => part.id === id), component = this.blueprint.modules.find(part => part.id === id),
        polygons = plate ? [plateCorners(plate)] : component ? componentPolygons(component) : [];
      for (const polygon of polygons) g.poly(polygon.flatMap(p => [p.x, p.y]))
        .fill({ color: 0xe45f59, alpha: .28 }).stroke({ color: 0xff9a8d, alpha: .95, width: width * 2 });
    }
  }
  // The stretch being chosen for a road (road-placement.ts): its ends, `x0` and `x1` — one alone while the other is not
  // chosen —, what of it the road makes (`spans`), passes over as it is (`over`) and lies on ground the faction never saw
  // (`unknown`), and whether the field would refuse it (`refused`). Nothing: none.
  previewRoad(stretch: SiteRoadPreview | null = null) { this.siteMarkers.previewRoad(stretch); }
  drawConstructionPreview() {
    const preview = this.constructionPreview, site = preview?.site;
    if (!preview) return;
    preview.body.visible = preview.marks.visible = Boolean(site) && this.view.mode === 'test';
    if (!preview.body.visible) return;
    for (const layer of [preview.body, preview.marks]) {
      layer.position.set(site!.mirror ? site!.x + 2 * BOARD.middle : site!.x, site!.y);
      layer.scale.x = site!.mirror ? -1 : 1;
    }
    preview.holdArt = false; preview.drawDesign();
  }
  // The board over the field of this frame: its layers at the site, its floor on the ground there.
  drawBoard(holdArt = false) {
    const board = this.fieldBoard, site = this.boardFrame;
    if (!board) return;
    board.body.visible = board.marks.visible = Boolean(site);
    // Pixi applies a Graphics root's alpha in its group pass too. A faded field overlay uses the ordinary batch.
    this.overlay.isRenderGroup = !this.site;
    this.labels.alpha = this.overlay.alpha = this.site ? BOARD_FADED : 1;
    if (!site) return;
    board.holdArt = this.view.mode === 'edit' && holdArt;
    const fixed = this.blueprint.preset === 'bunker';
    // A standalone bench keeps its ordinary scenery; only a board in the field dims what is behind it.
    board.shade.visible = Boolean(this.site); board.floor.visible = Boolean(this.site) && !fixed;
    // A design that will face right is drawn turned about the middle of the board, as the field will have it.
    for (const layer of [board.body, board.marks]) { layer.position.set(site.mirror ? site.x + 2 * BOARD.middle : site.x, site.y); layer.scale.x = site.mirror ? -1 : 1; }
    // The shade is the first thing of the board, under its floor: over all the screen and two pixels more each way.
    const { y, zoom, width, height } = this.camera, wide = (width + 4) / zoom, tall = (height + 4) / zoom;
    board.shade.position.set(board.camera.x - wide / 2, y - tall / 2 - site.y); board.shade.width = wide; board.shade.height = tall;
    const floored = board.floored;
    if (floored?.site !== site || floored.ground !== this.ground || floored.fixed !== fixed) {
      board.floored = { site, ground: this.ground, fixed };
      // Shadows and sight read the ground in the same frame as the design. A fixed building has no
      // raised workshop deck; the actual terrain remains visible beneath it.
      board.ground = fixed ? Object.assign(Object.create(this.ground), {
        height: (u: number) => this.ground.height(fieldX(site, u)) - site.y,
      }) : board.flatGround;
      if (!fixed && this.site) drawBoardFloor(anchorGraphics(board.floor, BOARD.middle, 0), site, this.ground);
    }
    board.drawDesign();
  }
  // A frame of the design in the layers of whoever is asked: what the bench shows, without its ground.
  drawDesign() {
    const state = this.designState, { x, y } = this.camera;
    if (!state) return;
    this.syncActorLayers(state); this.scene = sampleScene(state, null, 1); this.cullActors(state);
    anchorGraphics(this.shadows, x, y);
    const placeLabels = this.drawPlaceLabels(state);
    this.drawSurfaces(); this.drawStructure(state, placeLabels); this.drawBodyPanels(state, 1); this.drawChassisArt(state); this.drawGun(state); this.drawWorkArms(state);
    this.drawOverlay(state);
    this.pruneActorLayers(state);
  }
  syncActorLayers(state: RendererDrawing) {
    this.effectSurfaceClip.attach(this.fxLayer);
    // Stable actor-wide depths: moving, firing, replacing a mesh or destroying
    // a component must never let one vehicle interleave with another's parts.
    // A vehicle keeps the depth it came with for as long as its layers stand, and goes with them; each one that
    // comes goes over all that came before it, so the count runs on past those that went (`nextDepth`).
    for (const actor of state.actors) {
      if (this.actorLayers.has(actor.id)) continue;
      const container = new Container(), body = new Container(), layers: ActorLayers = { container, body,
        footing: new Graphics(), shade: new Container(), outline: new Container(), chassis: new Container(), hullSkins: new Container(), bodyPanels: new Container(),
        moduleLayer: new Container(), plateLayer: new Container(), edges: new Container(), outerSkin: new Container(), outsideLayer: new Container(), suspensionArms: new Graphics(),
        runningGearLayer: new Container(), guards: new Container(), gunArt: new Container(), gun: new Graphics(), heaps: new Container(), fxLayer: new Container() };
      container.label = 'vehicle:' + actor.id; container.zIndex = this.nextDepth; this.nextDepth += 100;
      // The footing of one that stands fixed (`footing`, fixed-footing.ts) is under all of it, as the ground is, and under
      // the shadows it casts. The dark outline of its parts (`outline`, silhouette.ts) is under the rest of it, over its shadow.
      // The chassis is under the skin of its hull and under all it carries. The skin of a hull seen from inside is its
      // far wall, under all it holds; seen from outside (`outerSkin`) it is over the plates and the pieces within it,
      // and under what stands out of it: what is carried out in the open, running gear, guns and arms. What the chassis
      // hangs over its running gear (`guards`) is over the gear outside; its track skirt stays there when cut open.
      // Cutaway wheel fenders stay with the chassis, behind plate sections. The heap of ore over the rim
      // of a hopper (`heaps`) is over its arm folded on it, seen from outside or cut open.
      for (const kind of ['footing', 'shade', 'outline', 'chassis', 'hullSkins', 'bodyPanels', 'moduleLayer', 'plateLayer', 'edges', 'outerSkin', 'outsideLayer', 'suspensionArms',
        'runningGearLayer', 'guards', 'gunArt', 'gun', 'heaps', 'fxLayer'] as const) {
        if (kind === 'chassis') container.addChild(body);
        (['footing','shade','outline','fxLayer'].includes(kind) ? container : body).addChild(layers[kind]);
      }
      layers.runningGearLayer.sortableChildren = true;
      this.effectSurfaceClip.attach(layers.fxLayer);
      this.actorLayers.set(actor.id, layers); this.actorLayerRoot.addChild(container);
    }
    // A wreck is nobody's: it stands darkened, and goes away over its last seconds on the field.
    // A ghost is what was last seen of a construction that is seen no longer: it stands pale where it was. One being built stands pale too.
    for (const actor of state.actors) {
      const layers = this.actorLayers.get(actor.id)!, wreck = Boolean(actor.field?.wreck), tint = actor.ghost ? GHOST_TINT : wreck ? 0x8d938c : 0xffffff;
      layers.fade = (wreck ? wreckFade(actor, state.time) : 1) * ghostFade(actor, state.time); layers.ghost = Boolean(actor.ghost); layers.still = wreck || layers.ghost;
      layers.container.alpha = layers.fade * buildFade(actor);
      if (layers.tint !== tint) { layers.tint = tint;
        for (const layer of [...layers.container.children, ...layers.body.children])
          if (layer !== layers.body && layer !== layers.fxLayer && layer !== layers.shade) layer.tint = tint;
      }
    }
    // Only what moves within its construction is drawn anew on every frame, with its places counted from
    // the camera of that frame: the rest is kept where it was made.
    const { x, y } = this.camera;
    for (const layers of this.actorLayers.values()) for (const kind of ['suspensionArms', 'gun'] as const) {
      const drawn = layers[kind];
      drawn.pivot.set(0, 0); drawn.scale.set(1, 1); drawn.rotation = 0;
      anchorGraphics(drawn, x, y);
    }
  }
  actorLayer<Kind extends ActorLayerKind>(id: string | null | undefined, kind: Kind): ActorLayers[Kind] | undefined {
    return this.actorLayers.get(id || 'local')?.[kind];
  }
  pruneActorLayers(state: RendererDrawing) {
    const present = new Set(state.actors.map(a => a.id));
    for (const id of this.actorLayers.keys()) if (!present.has(id)) this.removeActorLayer(id);
  }
  removeActorLayer(id: string) {
    const layers = this.actorLayers.get(id)!;
    this.effectSurfaceClip.detach(layers.fxLayer);
    layers.container.destroy({ children: true, context: true }); layers.label?.destroy({ children: true }); layers.flag?.destroy();
    this.actorLayers.delete(id);
  }
  // `place` is given for art that follows a shape, by what shows it: while the shape is on its way the place
  // goes on with the art it has (resting-art.ts), and nothing is painted for a shape it only passes through.
  texture(key: string, create: () => CanvasTexture, persistent = false, place: string | null = null): RenderTextureEntry {
    if (place) key = this.resting.shown(place, key, painted => this.textures.has(painted), this.frameNow, this.holdArt);
    this.usedTextures.add(key); this.asked?.push(key);
    if (!this.textures.has(key)) this.textures.set(key, { texture: create(), persistent, key });
    return this.textures.get(key)!;
  }
  // Works heaps and delivered/descending supplies share the same bounded crate/can pictures.
  pilePicture(look: PileLook) {
    return this.texture(['pile', ...look.crates, look.cans].join(':'), () => {
      const painted = canvas(...pileCanvasSize(look));
      paintPile(context2d(painted), look);
      return pieceTexture(painted);
    });
  }
  paintedTexture(key: string, base: CanvasTexture, revision: string | number | undefined, paint: (context: ArtContext) => void): CanvasTexture {
    // Include the base identity so changing a component kind cannot reuse its
    // old damage canvas. All transient artwork has the same GPU lifetime. The
    // copy keeps the mipmaps of its base, made anew from each repaint it uploads.
    const source = base.source.resource;
    const entry = this.texture(key + ':' + base.uid, () => pieceTexture(canvas(source.width, source.height),
      { mipmaps: base.source.autoGenerateMipmaps, dynamic: base.dynamic }));
    if (entry.revision !== revision) {
      resizePicture(entry.texture.source, source.width, source.height);
      const ctx = context2d(entry.texture.source.resource);
      ctx!.clearRect(0, 0, source.width, source.height); ctx!.drawImage(source, 0, 0);
      paint(ctx); this.fireProfiles?.delete(entry.texture.source.resource);
      entry.texture.source.update(); entry.revision = revision;
    }
    return entry.texture;
  }
  getTexture(part: MaterialPicture, definition: MaterialPicture['definition'] = part.definition) {
    const entry = this.progressiveTexture('material:' + part.material,
      () => ({ type: 'material', options: { material: part.material } }), { persistent: true, mipmaps: false }),
      base = entry.texture, revision = paintRevision(entry, part.markRevision);
    return part.marks?.length ? this.paintedTexture('damage:' + part.id, base, revision,
      ctx => paintDamage(ctx, part.marks!, part.material, definition?.length, definition ? definition.thicknessMm / 1000 : undefined)) : base;
  }
  moduleTexture(module: PaintedModule, body: LoadBody | null = null, asked: {painted?: boolean} | null = null): Texture {
    // `style` and `overlay` tell apart the pictures a piece of running gear is made of (see gear-art.ts),
    // the load of a hopper, a cistern or a supply piece the pictures of it, one for each step it shows;
    // `body` is how a piece that carries a load is painted (`loadBody`). A
    // piece that carries a load and one of machine-art.ts are painted in metres, so their size is a picture of its own
    // too, and an ammunition box has one for the rounds it holds, a road machine one
    // for each of its parts painted on its own (`part`, `crop`, drawRoadMachines). Cargo
    // retains its current picture of each side. `asked`, when given, is told whether the picture is painted yet.
    // A track drawn close up is its wheels, its links and what stands behind them (drawTrackDetails): it has no picture.
    if (this.detailedTrack(module) && !module.overlay) return Texture.EMPTY;
    const actor = this.scene?.frame.actors.get(module.actorId || 'local'),
      { details, key: detailKey, lettering } = detailGroup(actor?.appearance, 'part', detailPartId(module, actor)),
      letteringMirror = lettering && screenMirrored(module.mirrored, this.camera.turn),
      load = cargoLook(module, body?.side), cargo = holdsCargo(module), hang = bladeHang(module),
      // The board can reflect the authored frame as well as the piece; only lettering compensates both.
      mirror = body && body.mirror * this.camera.turn,
      shape = module.kind === 'track' || MACHINE_KINDS.has(module.kind) || cargo || FRAME_SURFACE_KINDS.has(module.kind) ? `${module.width.toFixed(3)}x${module.height.toFixed(3)}` : (module.width / module.height).toFixed(4),
      key = [module.kind, module.ammoPreset || '', module.sensorMode || '', shape, module.armorMm || 0, module.style || '', module.teeth ?? '',
        module.overlay ? 'over' : '', module.sensorSupport ?? '', hang ? [hang.y, hang.slope, hang.half].join(',') : '', load.level, load.material, load.fuel ?? '', module.metal || '', module.part ?? '',
        module.crop ? [module.crop.x, module.crop.y, module.crop.W, module.crop.H].join(',') : '', detailKey, letteringMirror, this.weatheringMaps?.id ?? 0,
        body ? [body.paint ?? '', body.side, mirror, ...body.arches.map(arch => `${arch.x},${arch.y},${arch.r},${arch.half}`)].join('/') : ''].join(':'),
      persistent = module.kind === 'wheel' || module.kind === 'sensor',
      // Wheel styles include transparent light masks and track-wheel sprites requested only once.
      // A track overlay is a light mask too; the ordinary component pictures can all start solid.
      defer = !(module.kind === 'wheel' && module.style || module.kind === 'track' && module.overlay),
      entry = this.progressiveTexture('component:' + key,
        () => ({ type: 'module', kind: module.kind, width: module.width, height: module.height,
          options: { sensorMode: module.sensorMode, sensorSupport: module.sensorSupport, hang, ammoPreset: module.ammoPreset,
            armorMm: module.armorMm || 0, style: module.style, teeth: module.teeth, overlay: module.overlay,
            cargoLevel: load.level, cargoMaterial: load.material, cargoFuel: load.fuel, metal: module.metal,
            part: module.part, crop: module.crop, details, letteringMirror,
            ...(body && { paint: body.paint, side: body.side, mirror: mirror!, arches: body.arches }) } }), { persistent, defer });
    // Quantized soot shares the existing damage canvas, with at most three
    // repaints as combustible material is consumed, instead of one per frame.
    const base = entry.texture, mirrored = module.kind !== 'weapon' && Boolean(module.mirrored),
      soot = Math.min(3,Math.ceil((module.burnAge||0)/30)),
      revision = paintRevision(entry, (module.markRevision || 0) + ':' + mirrored + ':' + soot);
    if (asked) asked.painted = !entry.paint;
    return module.marks?.length || soot ? this.paintedTexture('damage:' + module.id, base, revision, ctx => {
      ctx.save(); ctx.globalCompositeOperation = 'source-atop';
      // Native marks use the rotated physical frame. Cropped part marks were already mapped to canonical artwork.
      if (mirrored && !module.crop) { ctx.translate(ctx.canvas.width, 0); ctx.scale(-1, 1); }
      paintComponentDamage(ctx, module.marks || [], module.width, module.height);
      if (soot) paintComponentSoot(ctx,module.width,module.height,soot,module.id);
      ctx.restore();
    }) : base;
  }
  paintingMaterials(): TextureMaterials {
    return { frameSurface: this.frameSurface, hullSurfaces: this.hullSurfaces, weathering: this.weatheringMaps,
      wheelSurface: this.wheelSurface, trackSurfaces: this.trackSurfaces, radarSurface: this.radarSurface };
  }
  progressiveTexture(key: string, describe: () => TexturePaintRequest, { persistent = false, place = null, defer = true, mipmaps = true }: {persistent?: boolean;place?: string | null;defer?: boolean;mipmaps?: boolean} = {}): RenderTextureEntry {
    const host = this.host || this, lazy = defer && host.texturePainter?.available;
    let request = null;
    const entry = this.texture(key, () => {
      request = describe();
      return pieceTexture(lazy ? previewTextureCanvas(request) : paintTextureCanvas(request, this.paintingMaterials()), { dynamic: Boolean(lazy), mipmaps });
    }, persistent, place);
    if (request && lazy) entry.paint = request;
    // A lost worker uses the same painter and retained cache entry.
    if (entry.paint && !lazy) this.finishTexturePaint(entry, paintTextureCanvas(entry.paint, this.paintingMaterials()));
    // The board shares the host's worker. Do not paint intermediate shapes
    // during a drag, or a retained older key while the current one is pending.
    if (entry.paint && entry.key === key && !this.holdArt && !host.nextTexturePaint && !host.texturePainter.busy) host.nextTexturePaint = entry;
    return entry;
  }
  finishTexturePaint(entry: RenderTextureEntry, picture: ArtCanvas | ImageBitmap) {
    const source = entry.texture.source;
    resizePicture(source, picture.width, picture.height);
    const ctx = source.resource.getContext('2d');
    ctx!.clearRect(0, 0, picture.width, picture.height); ctx!.drawImage(picture, 0, 0);
    this.fireProfiles?.delete(source.resource); source.update(); entry.paint = null;
  }
  componentFireProfile(id: string | undefined) {
    const picture = this.drawables.get(id!)?.mesh?.texture?.source.resource;
    if (!picture?.getContext) return null;
    if (this.fireProfiles.has(picture)) return this.fireProfiles.get(picture);
    const probe = this.fireProbe ||= canvas(32,32), ctx = probe.getContext('2d',{willReadFrequently:true});
    ctx!.clearRect(0,0,32,32); ctx!.drawImage(picture,0,0,32,32);
    const profile = fireProfilePixels(ctx!.getImageData(0,0,32,32).data,32,32);
    this.fireProfiles.set(picture,profile); return profile;
  }
  paintNextTexture() {
    const entry = this.nextTexturePaint; this.nextTexturePaint = null;
    if (!entry?.paint || !this.texturePainter?.available || this.texturePainter.busy) return;
    const request = entry.paint;
    void this.texturePainter.paint(request).then(picture => {
      if (!picture) return;
      try {
        if (this.textures.get(entry.key) === entry && entry.paint === request) this.finishTexturePaint(entry, picture);
      } finally { picture.close(); }
    });
  }
  releaseTextures(reset = false) {
    const obsolete = [...this.textures].filter(([key, entry]) =>
      !entry.persistent && (reset || !this.usedTextures.has(key)));
    if (!obsolete.length) return;
    // Rebind mesh and sprite samplers once before destroying any GPU source.
    this.releaseSamplers();
    for (const [key, entry] of obsolete) { entry.texture.destroy(true); this.textures.delete(key); }
    for (const resting of [this.resting, this.fieldBoard?.resting, this.constructionPreview?.resting]) resting?.forget(key => this.textures.has(key));
  }
  geometry(surface: FrameSurface<RendererDrawing>, layer: Container, texture: Texture): RenderDrawable {
    let item = this.drawables.get(surface.id);
    const source = surface.geometry, artwork = surface.type === 'plate' ? this.armorPlan?.get(surface.id) : null,
      key = artwork?.shapeKey || [surface.type, source.revision, surface.type === 'plate' ? surface.geometry.definition.length : undefined, surface.type === 'plate' ? surface.geometry.definition.thicknessMm : undefined].join(':'),
      data: ImageShape = this.holdArt && surface.type === 'plate' ? regionGeometry(surface.geometry)
        : item?.shapeKey === key ? item!.data : artwork?.geometry || (surface.type === 'module' ? surface.geometry : regionGeometry(surface.geometry));
    if (!item || item.positions.length !== data.positions.length) {
      if (item) destroyMesh(item);
      const positions = new Float32Array(data.positions),
        geometry = new MeshGeometry({ positions, uvs: data.uvs, indices: data.indices }), group = new Container(), mesh = new Mesh({ geometry, texture });
      group.addChild(mesh); item = { group, mesh, geometry, positions, data, edges: data.edges || boundaryEdges(data.indices) };
      this.drawables.set(surface.id, item);
    }
    if (item!.data !== data) {
      item!.positions.set(data.positions);
      item!.geometry.getBuffer('aPosition').update();
      item!.geometry.indices = data.indices; item!.geometry.uvs = data.uvs;
      item!.edges = data.edges || boundaryEdges(data.indices);

    }
    item!.data = data; item!.shapeKey = key; item!.outline = null;
    item!.artEdges = artwork?.edges;
    if (item!.group.parent !== layer) layer.addChild(item!.group);
    const pose = this.scene!.pose(surface.id);
    item!.group.position.set(pose!.x, pose!.y); item!.group.rotation = pose!.angle; item!.group.zIndex = surface.order;
    const mirror = surface.component?.kind !== 'weapon' && surface.component?.mirrored ? -1 : 1;
    item!.group.scale.x = mirror;
    item!.mesh.rotation = surface.component?.kind === 'wheel' ? mirror * (pose!.wheelSpin || 0) : 0;
    item!.mesh.texture = texture; item!.mesh.tint = surface.component ? componentTint(surface.component) : 0xffffff;
    item!.group.visible = item!.mesh.visible = data.indices.length > 0;
    // Set the final LOD once: hiding a detailed belt before showing it again invalidates the whole stage.
    if (item!.trackDetails) item!.trackDetails.container.visible = Boolean(item!.mesh.visible && surface.gear && this.detailedTrack(surface.component!));
    return item;
  }
  draw({ now = performance.now(), follow = null, holdArt = false }: { now?: number;follow?: string | null | undefined;holdArt?: boolean} = {}) {
    if (!this.ready) return;
    this.frameNow = now; this.holdArt = this.mode === 'edit' && holdArt;
    const sample = this.mode === 'test' && this.state ? this.playback.sample(now) : null;
    // The camera is where this frame shows it before the rounds are asked for: only those it holds are told.
    this.camera.follow(follow && sample ? this.playback.vehicleAt(sample, follow) : null, this.ground);
    this.meter?.mark('playback');
    // The ground in sight is settled before anything of the frame is shown: what is made of an event goes by it.
    this.fog = sample ? this.groundFog(sample) : null; this.effects.sight = this.fog?.seen ?? null;
    if (this.fog) this.sight.frame(this.fogView(), this.fog, this.ground);
    this.meter?.mark('sight');
    // The effects are told what the screen holds too: with their budget full, what is made on it takes the room of what is off it.
    if (sample) { sample.trailReach = TRAIL_PIXELS / this.camera.zoom; sample.view = this.effects.view = this.shotView(); }
    const state = this.mode === 'edit' ? this.designState : sample?.state; if (!state) return;
    const grounded = this.mode === 'edit' && Boolean(this.benchSite);
    if (grounded && this.actorLayers.size) this.clearConstructions();
    this.actorLayerRoot.visible = !grounded;
    this.usedTextures.clear(); this.nextTexturePaint = null;
    if (!grounded) this.syncActorLayers(state); this.meter?.mark('constructions');
    // Muzzle events of a newly arrived gun need this sample's pose as well.
    if (sample) this.scene = sample.scene;
    // The presentation is timed in two: the effects made and stepped, up to the end of their step, and after it the rounds told.
    const presentation = sample && this.playback.present(sample, {
      prepare: state => this.effects.setActors(state.actors),
      update: dt => { this.advanceEffects(dt); this.meter?.mark('effects'); }, consume: (event, ahead) => this.consumeEffect(event, ahead),
    });
    this.meter?.mark('shots');
    const camera = this.camera, shake = this.screenShake.offset(camera.zoom, this.mode);
    this.world.position.set(camera.width / 2 - camera.x * camera.zoom + shake.x, camera.height / 2 + camera.y * camera.zoom + shake.y); this.world.scale.set(camera.zoom, -camera.zoom);
    const alpha = this.mode === 'edit' || state === presentation!.previous ? 1 : presentation!.alpha;
    this.drawScenery(presentation?.time || 0, alpha);
    this.presentationAlpha = alpha; this.scene = presentation ? presentation.scene : sampleScene(state, null, alpha);
    if (!grounded) this.cullActors(state); this.meter?.mark('constructions', grounded ? 1 : state.actors.length - this.unseen.size + this.dotted.size);
    if (this.meter?.detailed) this.meter.note('vehicles', grounded || !this.dotted.size ? '' : tr`${this.dotted.size.toLocaleString(locale())} como ponto`);
    if (presentation) {
      this.groundTrails.update(state, this.standing(), presentation.time, camera);
      // The motor of a rocket lays its smoke from where the round was a frame ago.
      const previous = presentation.previousDisplay;
      if (previous && presentation.time > previous.time)
        for (const shot of this.playback.burningAt(presentation, presentation.time - previous.time)) if (this.sees(shot.x)) this.effects.rocketTrail(shot, shot.from);
    }
    this.beginFrame(); this.meter?.mark('effects');
    const placeLabels = this.drawPlaceLabels(state, presentation?.time); this.meter?.mark('sites');
    if (!grounded) {
      if (presentation) this.stepRoadMachines(state, presentation.time);
      this.drawSurfaces(); this.drawThrusterJets(state); this.drawStructure(state, placeLabels); this.drawBodyPanels(state, alpha, presentation?.previous); this.drawChassisArt(state); this.drawGun(state);
      this.drawWorkArms(state, presentation?.time ?? null);
      if (presentation) this.drawRoadMachines(state);
    } else { this.drawGun(state, false); this.drawThrusterJets(null); }
    this.meter?.mark('constructions');
    this.drawProjectiles(presentation); this.meter?.mark('shots', presentation ? presentation.shots.length + presentation.specks.count : 0);
    const along = camera.width / camera.zoom / 2;
    this.scorchMarks.update(this.standing(), this.effects.scorches, camera.x - along, camera.x + along, camera.x, camera.y);
    this.effects.sample(1);
    this.surfaceLight.sample(this.effects, camera, this.actorLayers, this.scene, this.standing(), this.world);
    this.heatHaze.sample(this.effects, camera, this.app.renderer, this.hotBarrels);
    // Empty effect hosts need no ground outline; the first visible effect refreshes it before this frame is drawn.
    if (this.effectSurfaceClip.sync()) this.effectSurfaceClip.update(this.ground, camera);
    this.meter?.mark('effects', this.effects.particles.length);
    this.mist.update(this.fogView(), this.fog, presentation?.time ?? 0, this.weather || 'clear', this.ground, this.sight);
    this.meter?.mark('mist');
    if (grounded) {
      anchorGraphics(this.overlay, camera.x, camera.y); this.drawDeposits(null); this.drawCarriedDetail(null);
      this.aimPreview = null; this.lifted = 0;
      this.impactLabel.visible = this.servoLabel.visible = this.leadLabel.visible = this.strikeWords.visible = this.strikeDetail.visible = false;
      if (Object.hasOwn(this, 'recoilLabel')) this.recoilLabel!.visible = false;
    } else this.drawOverlay(state, presentation?.time);
    this.meter?.mark('overlay');
    this.drawBoard(holdArt); this.meter?.mark('board');
    this.drawConstructionPreview(); this.meter?.mark('constructions');
    // A running painter can work during submission. Start a new worker after the first preview.
    if (this.texturePainter?.worker) { this.paintNextTexture(); this.meter?.mark('constructions'); }
    this.app.renderer.render(this.app.stage);
    this.releaseTextures(); this.meter?.mark('gpu');
    this.paintNextTexture();
    if (!grounded) this.pruneActorLayers(state); this.meter?.mark('constructions');
    return presentation;
  }
  // What every frame draws anew is emptied here, with its places counted from the camera of that frame:
  // the shadows on the ground, the bodies of the rounds and the particles of the effects.
  beginFrame() {
    const { x, y } = this.camera;
    for (const drawn of [this.shadows, this.trails]) anchorGraphics(drawn, x, y);
    this.effects.anchor(x, y);
  }
  // A construction the camera does not show is not drawn: its layers are hidden and nothing of it is laid out
  // again until it comes back into view. What it had on the screen is kept for then. One the camera shows only a few
  // pixels long is a mark from afar (`dotted`): nothing of it is laid out either, and of its layers only its effects
  // stay, the smoke of a wreck seen from afar as near; its label stays too.
  cullActors(state: RendererDrawing) {
    const camera = this.camera, zoom = camera.zoom, reach = ACTOR_REACH + 16 / zoom,
      left = camera.x - camera.width / zoom / 2 - reach, right = camera.x + camera.width / zoom / 2 + reach,
      bottom = camera.y - camera.height / zoom / 2 - reach, top = camera.y + camera.height / zoom / 2 + reach,
      far = this.mode !== 'edit' && DOT_SHORTEST * zoom < ART_PIXELS;
    this.unseen.clear(); this.dotted.clear();
    if (far) this.measureActors(state);
    for (const actor of state.actors) {
      const body = this.scene!.actor(actor.id), x = body?.x ?? actor.x ?? 12, y = body?.y ?? actor.y ?? 1.3, layers = this.actorLayers.get(actor.id)!,
        seen = this.mode === 'edit' || x >= left && x <= right && y >= bottom && y <= top;
      layers.container.visible = seen;
      if (!seen) {
        this.unseen.add(actor.id);
        if (layers.label) layers.label.visible = false;
        if (layers.flag) layers.flag.visible = false;
        continue;
      }
      const dotted = far && layers.extent!.length * zoom < (layers.dotted ? ART_PIXELS : DOT_PIXELS);
      const markGun = dotted && layers.extent!.length * zoom >= MARK_GUN_PIXELS;
      if (dotted !== Boolean(layers.dotted) || markGun !== Boolean(layers.markGun)) {
        layers.dotted = dotted; layers.markGun = markGun;
        layers.body.visible = !dotted || markGun;
        for (const layer of [...layers.container.children, ...layers.body.children]) if (layer !== layers.body)
          layer.visible = !dotted || layer === layers.fxLayer || markGun && (layer === layers.gunArt || layer === layers.gun);
      }
      if (dotted) { this.unseen.add(actor.id); this.dotted.add(actor.id); }
    }
    this.drawDots(state);
    // On the field a construction is seen from outside — the skin of its hull over what stands within it — but the
    // player's own that is picked (`opened`: selected, while none is in hand) and near enough to inspect. Distant
    // selections keep the skin instead of preparing unreadable interiors; the workshop retains its cutaway view, and a
    // test the one the page opens (main.ts) at any distance.
    this.closed.clear();
    if (this.mode === 'edit') { if (this.view.exterior) this.closed.add('local'); }
    else for (const actor of state.actors)
      if (seenFromOutside(actor, state, !state.shared || this.camera.zoom >= FAR_VIEW_ZOOM ? this.opened : null)) this.closed.add(actor.id);
    this.covered = coveredParts(state, this.closed, this.scene!, this.unseen, this.mode === 'edit' ? this.designFaces : null);
    for (const [id, layers] of this.actorLayers) this.layGuns(layers, this.closed.has(id));
  }
  // The box of each construction about its body, in its pose of the frame, from the plates it is built of: what its mark
  // from afar covers. It is measured once, and again when the construction is built anew (`revision`).
  measureActors(state: RendererDrawing) {
    let boxes = null;
    for (const actor of state.actors) {
      const extent = this.actorLayers.get(actor.id)!.extent;
      if (!extent || extent.revision !== actor.revision) (boxes ??= new Map()).set(actor.id, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    }
    if (!boxes) return;
    for (const plate of state.plates) {
      const box = boxes.get(plate.actorId);
      if (!box || plate.attached === false) continue;
      const pose = this.scene!.pose(plate.id, 'plate')!, d = plate.definition, angle = pose?.angle ?? d.angle, px = pose?.x ?? d.x, py = pose?.y ?? d.y,
        half = Math.abs(Math.cos(angle)) * d.length / 2, rise = Math.abs(Math.sin(angle)) * d.length / 2 + d.thicknessMm / 2000;
      box.minX = Math.min(box.minX, px - half); box.maxX = Math.max(box.maxX, px + half);
      box.minY = Math.min(box.minY, py - rise); box.maxY = Math.max(box.maxY, py + rise);
    }
    for (const [id, box] of boxes) {
      const actor = state.actors.find(actor => actor.id === id), body = this.scene!.actor(id), x = body?.x ?? actor!.x ?? 12, y = body?.y ?? actor!.y ?? 1.3;
      // One with no plate has no box to stand for it: it is drawn in full at any distance.
      this.actorLayers.get(id)!.extent = box.minX <= box.maxX
        ? { revision: actor!.revision, left: box.minX - x, right: box.maxX - x, bottom: box.minY - y, top: box.maxY - y,
          angle: body?.angle ?? 0, length: Math.max(box.maxX - box.minX, box.maxY - box.minY) }
        : { revision: actor!.revision, length: Infinity };
    }
  }
  // The constructions seen as marks from afar: each a box where its art would stand, in its paint darkened, never thinner
  // or lower than a pixel, as faded and as pale as its art. The drawing is made again only when a mark moved by a tenth of
  // a pixel or looks otherwise: the camera may move as it will, the marks stand in the world.
  drawDots(state: RendererDrawing) {
    if (!this.dotted.size) { if (this.actorDots) this.actorDots.visible = false; this.dotsKey = ''; return; }
    const dots = this.actorDots ??= Object.assign(this.actorLayerRoot.addChild(new Graphics()), { label: 'constructions:marks', zIndex: Number.MAX_SAFE_INTEGER });
    dots.visible = true;
    const zoom = this.camera.zoom, pixel = 1 / zoom, marks = [], tenth = (value: number) => Math.round(value * zoom * 10);
    let key = '';
    for (const actor of state.actors) {
      if (!this.dotted.has(actor.id)) continue;
      const layers = this.actorLayers.get(actor.id)!, { left, right, bottom, top, angle = 0 } = layers.extent!, body = this.scene!.actor(actor.id),
        x = body?.x ?? actor.x ?? 12, y = body?.y ?? actor.y ?? 1.3, width = Math.max(right! - left!, pixel), low = y + bottom!,
        mark = { x: x + (left! + right! - width) / 2, y: low, width, height: Math.max(top! - bottom!, pixel),
          originX: x, originY: y, angle: (body?.angle ?? 0) - angle,
          color: markColor(actor.appearance?.paint, layers.tint), alpha: layers.container.alpha };
      key += `${tenth(mark.x)},${tenth(mark.y)},${tenth(mark.width)},${tenth(mark.height)},${tenth(mark.angle * layers.extent!.length)},${mark.color},${Math.round(mark.alpha * 100)};`;
      marks.push(mark);
    }
    if (key === this.dotsKey) return;
    this.dotsKey = key;
    anchorGraphics(dots, this.camera.x, this.camera.y);
    for (const mark of marks) {
      if (Math.abs(mark.angle) < 1e-6) dots.rect(mark.x, mark.y, mark.width, mark.height);
      else {
        const c = Math.cos(mark.angle), s = Math.sin(mark.angle), point = (u: number, v: number) => {
          const dx = mark.x + u - mark.originX, dy = mark.y + v - mark.originY;
          return { x: mark.originX + c * dx - s * dy, y: mark.originY + s * dx + c * dy };
        };
        dots.poly([point(0,0),point(mark.width,0),point(mark.width,mark.height),point(0,mark.height)]);
      }
      dots.fill({ color: mark.color, alpha: mark.alpha });
    }
  }
  // Seen from outside, the guns and the arms of a construction are under the skin of its hull: what of them is within
  // it is hidden by it, and what reaches out of it shows. Seen from inside they are over everything but the effects.
  layGuns(layers: ActorLayers, outside: boolean) {
    if (layers.gunsOutside === outside) return;
    layers.gunsOutside = outside;
    const container = layers.body;
    container.removeChild(layers.gunArt, layers.gun);
    const at = outside ? container.getChildIndex(layers.outerSkin) : container.getChildIndex(layers.runningGearLayer) + 1;
    container.addChildAt(layers.gunArt, at); container.addChildAt(layers.gun, at + 1);
  }
  // The stretch of field the camera shows, and a little around it. Nothing is drawn for what is outside, and the
  // presentation makes nothing of a round out there: of a long volley most are out of view. `whole` is how many
  // rounds it is asked to tell in full, the ones a body may be drawn for: none from afar, where no round has one.
  // On a field with fog a round, a tail or an arc is drawn where the faction sees (`sight`), and out of its sight only
  // in the sky (`skyline`): what lies low over ground out of sight is hidden with it. `hidden` tells of a place.
  shotView() {
    const camera = this.camera, zoom = camera.zoom, room = 16 / zoom + 1;
    return { zoom, left: camera.x - camera.width / zoom / 2 - room, right: camera.x + camera.width / zoom / 2 + room,
      bottom: camera.y - camera.height / zoom / 2 - room, top: camera.y + camera.height / zoom / 2 + room,
      whole: zoom > FAR_VIEW_ZOOM * .5 ? MAX_SHOT_BODIES : 0, hidden: this.fog ? (x: number, y: number) => !this.sight.sees(x, y) && !(y > this.skyline(x)) : null };
  }
  // Where the sky begins over ground out of sight: over the low air of ground that is known, and over the bank of
  // mist that stands on ground never seen (ground-mist.ts).
  skyline(x: number) { return this.markHeight(x) + (contains(this.fog!.explored, x) ? LOW_AIR : MIST_HEIGHT + MIST_FADE); }
  drawProjectiles(presentation: PresentationFrame<State> | null) {
    const camera = this.camera, zoom = camera.zoom, own = presentation?.state?.controlledActor || 'local',
      colors = [0xf5dfb4, 0xffc78b, 0xdfded0] as const, view = this.shotView(),
      seen = (x: number, y: number) => x >= view.left && x <= view.right && y >= view.bottom && y <= view.top && !view.hidden?.(x, y),
      batches = [this.tails, this.markers, this.glows, this.specks, this.speckGlows];
    // Seen from afar the body of a round is a speck: a bright point with a dark rim and a glow stands for it.
    const far = clamp((FAR_VIEW_ZOOM - zoom) / (FAR_VIEW_ZOOM * .5), 0, 1), glow = GLOW_RADIUS / zoom, core = MARKER_RADIUS / zoom;
    for (const quads of batches) quads.clear(camera.x, camera.y);
    // Where the last long shot of each of the player's guns went: its whole arc,
    // faint, and a ring where it ended, to correct the next aim by.
    for (const arc of presentation?.fallenArcs || []) {
      if (arc.actorId && arc.actorId !== own) continue;
      this.tails.tail(arc.points, shotKind(arc), TAIL_WIDTH * .38 / zoom, .4 * arc.fade, view);
      if (!seen(arc.x, arc.y)) continue;
      roundShape(this.trails, arc.x, arc.y, 8 / zoom).stroke({ color: 0x2c3834, width: 3.6 / zoom, alpha: .45 * arc.fade });
      roundShape(this.trails, arc.x, arc.y, 8 / zoom).stroke({ color: colors[shotKind(arc)], width: 1.6 / zoom, alpha: .9 * arc.fade });
    }
    // Recorded tracer chords, each fading along its own length. The cost stays
    // a quad a chord, including rounds that hit between two displayed snapshots.
    for (const trail of presentation?.shotTrails || [])
      this.tails.tail(trail.points, shotKind(trail), TAIL_WIDTH / 2 / zoom, trail.fade ?? 1, view);
    this.markers.alpha = this.glows.alpha = far * .94; this.specks.alpha = this.speckGlows.alpha = .94;
    // Bodies are for the newest rounds in view, the last of the list, and for no more of them than a frame can
    // draw. The rounds before those are points, as from afar, but in full strength at any zoom.
    const shots = presentation?.shots || [], crowd = presentation?.specks;
    let first = shots.length;
    for (let bodies = 0; first > 0 && bodies < MAX_SHOT_BODIES;) { const shot = shots[--first]; if (!shot!.fragment && seen(shot!.x, shot!.y)) bodies++; }
    for (let index = 0; index < shots.length; index++) {
      const shot = shots[index]!;
      if (shot!.fragment || !seen(shot!.x, shot!.y)) continue;
      if (index < first) { this.speckGlows.glow(shot!.x, shot!.y, glow, shotKind(shot)); this.specks.marker(shot!.x, shot!.y, core); continue; }
      if (far > 0) {
        this.glows.glow(shot!.x, shot!.y, glow, shotKind(shot)); this.markers.marker(shot!.x, shot!.y, core);
        if (far === 1) continue;
      }
      const visual = projectileAppearance(shot, zoom), body = projectileBodyGeometry(shot, visual),
        solid = visual!.alpha * (shot!.fade ?? 1) * (1 - far);
      if (!body.shell.length) continue;
      if (body.fins?.length) this.trails.poly(body.fins).fill({ color: visual!.finColor, alpha: solid });
      this.trails.poly(body.shell).fill({ color: visual!.bodyColor, alpha: solid })
        .stroke({ color: visual!.outline, width: visual!.outlineWidth, alpha: solid, join: 'round' });
      this.trails.poly(body.nose).fill({ color: visual!.noseColor, alpha: solid });
      if (body.band.length) this.trails.poly(body.band).fill({ color: visual!.bandColor, alpha: solid });
      this.trails.poly(body.highlight).fill({ color: visual!.highlightColor, alpha: solid * .64 });
    }
    // The rest of the rounds in view come as a place and a kind each, already within the view: two quads a round.
    if (crowd?.count) {
      const tints = crowd.kinds.map(shotKind);
      for (let i = 0; i < crowd.count; i++) {
        if (view.hidden?.(crowd.x[i]!, crowd.y[i]!)) continue;
        this.speckGlows.glow(crowd.x[i]!, crowd.y[i]!, glow, tints[crowd.kind[i]!]!); this.specks.marker(crowd.x[i]!, crowd.y[i]!, core);
      }
    }
    for (const quads of batches) quads.sync();
  }
  // The shadow a part casts on the ground, in the first layer of its construction, which fades with it. It
  // follows the ground under the part and is laid out again when it has moved a quarter of a pixel. From afar,
  // horizontal travel may wait up to one pixel, unless the ground's slope would change the clearance by a quarter:
  // a parked vehicle keeps the one it has. From afar it is made of strips no narrower than the screen tells apart.
  // Its strips are places on the ground: it stands where its part was when it was laid out, and counts them from there.
  // A wheel or a track casts the short shadow of where it bears on the ground instead (`contact`, running-gear.ts
  // `contactShadow`): a few pixels deep at any zoom, darkest along the ground line.
  drawShade(item: ShadowDrawing, actorId: string | undefined, slot: 'shade' | 'under', opacity: number, contact = false) {
    const layer = this.actorLayers.get(actorId || 'local')!.shade, pose = item.group, zoom = this.camera.zoom,
      sx = pose.scale?.x ?? 1, sy = pose.scale?.y ?? 1,
      fine = .25 / zoom, far = this.mode !== 'edit' && zoom < FAR_VIEW_ZOOM, slack = (far ? 1 : .25) / zoom,
      strip = .18 * 2 ** (Math.ceil(Math.log2(Math.max(1, SHADE_STRIP / zoom / .18)) * 2) / 2),
      deep = contact ? Math.max(CONTACT_DEPTH, lineAt(CONTACT_PIXELS, zoom)) : 0, lift = contact ? lineAt(1, zoom) : 0,
      ground = this.standing();
    let shade = item[slot];
    if (!shade || shade.destroyed) shade = item[slot] = new Graphics();
    if (shade.parent !== layer) layer.addChild(shade);
    shade.visible = true;
    const cast = shade.cast;
    if (cast && cast.data === item.data && cast.sx === sx && cast.sy === sy && cast.ground === ground && cast.strip === strip && cast.deep === deep && cast.lift === lift) {
      const dx = Math.abs(pose.x - cast.x), dy = Math.abs(pose.y - cast.y), turn = Math.abs(angleDifference(pose.rotation, cast.angle)) * cast.reach,
        distance = Math.hypot(dx, dy) + turn, across = far && cast.slope !== null ? Math.min(slack, cast.slack) : fine,
        clearance = dy + turn + (cast.slope ?? 0) * (dx + turn);
      if (distance <= across && clearance <= fine) return;
    }
    const points = drawablePoints(item), edges = item.edges!.map((edge): readonly [Point, Point] => [points[edge.a]!, points[edge.b]!]);
    // Bound the change in ground height anywhere under the part, including where its next pixel of travel could
    // take it. Custom/board samplers keep the fine tolerance; only the standard linear ground has this bound.
    let slope = null;
    if (far && ground.height === Terrain.prototype.height) {
      const left = Math.min(...points.map(p => p.x)) - slack, right = Math.max(...points.map(p => p.x)) + slack;
      slope = 0;
      for (let i = ground.segmentIndex(left), last = ground.segmentIndex(right); i <= last; i++) {
        const a = ground.points[i], b = ground.points[i + 1];
        slope = Math.max(slope, Math.abs((b!.y - a!.y) / (b!.x - a!.x)));
      }
    }
    const reach = Math.max(...points.map(p => Math.hypot(p.x - pose.x, p.y - pose.y)));
    shade.cast = { data: item.data, ground, strip, deep, lift, x: pose.x, y: pose.y, angle: pose.rotation, sx, sy, reach, slope, slack };
    anchorGraphics(shade, pose.x, pose.y);
    // One outline for each unbroken run of it: the ground along the top, the foot of the shadow back along the bottom,
    // as deep as `share` of its depth.
    const lay = (patches: readonly ShadowPatch[], share: number, alpha: number) => {
      let top: number[] = [], foot: number[] = [];
      const fill = () => { if (top.length) shade.poly([...top, ...foot]).fill({ color: MAIN_LIGHT.shadow, alpha }); top = []; foot = []; };
      for (const p of patches) {
        if (top.length && top.at(-2) !== p.left) fill();
        if (!top.length) { top.push(p.left, p.topLeft); foot.unshift(p.left, p.topLeft - p.depthLeft * share); }
        top.push(p.right, p.topRight); foot.unshift(p.right, p.topRight - p.depthRight * share);
      }
      fill();
    };
    if (!contact) return lay(terrainShadow(points, ground, opacity, edges, strip), 1, opacity);
    // Darker along the ground line than at its foot, as the shadow right under what touches is.
    const patches = contactShadow(points, ground, edges, Math.max(strip / 2, .02), deep, lift);
    lay(patches, 1, opacity * MAIN_LIGHT.contactSoftness); lay(patches, MAIN_LIGHT.contactCore, opacity);
  }
  // The chassis of each construction (drawChassis), after the skins of the hulls and the bodies out in the open: they tell
  // it where they stand on its deck, and a hull seen cut open the wheels it stands over.
  drawChassisArt(state: RendererDrawing) {
    for (const actor of state.actors) {
      const layers = this.actorLayers.get(actor.id)!;
      // The pictures of the chassis of one out of view are kept for when it comes back.
      if (this.unseen.has(actor.id)) { for (const key of layers.chassisKeys || []) this.usedTextures.add(key); continue; }
      this.drawChassis(actor, layers, this.arched?.get(actor.id) || [], [...this.hullFeet?.get(actor.id) || [], ...this.bodyFeet?.get(actor.id) || []]);
    }
  }
  // The chassis of a construction (chassis-art.ts), told by the plates of its frame as every faction that sees them is
  // told them: its picture in the layer under the skin of its hull, laid on its frame plate as that stands now, with the
  // marks of its plates on it, and the shade of what stands on its deck under their feet (`feet`, where the world has
  // them); over its running gear its skirt, in that shade too, and the mudguards of its wheels but over those a hull seen
  // cut open stands over (`arched`, where the world has their axles), the others under the same fender then under one of
  // their own (`mudguardsOver`, kept in `layers.chassisHung`); its shadow on the ground, cast by its rail or its
  // belly; and of a wheeled one, each axle that has lost its wheel, hanging bare. Each picture is painted once for a
  // model, a length, its running gear and a paint; its marks, on a copy of it, when they change. `layers.chassis…` keep
  // what was worked out for it.
  drawChassis(actor: DrawingActor, layers: ActorLayers, arched: readonly Point[], feet: readonly [Point, Point][]) {
    const parts = this.scene!.frame.actorParts.get(actor.id) || [], frame = chassisFrame(parts);
    if (!frame) {
      for (const drawn of [layers.chassisArt, layers.chassisGuards, layers.chassisGuardPreviews, layers.chassisSkirtShade, layers.chassisShadow?.under]) if (drawn) drawn.visible = false;
      drop(layers, 'chassisSilhouette'); drop(layers, 'chassisGlint');
      return;
    }
    const definition = frame.data.definition, chassis = definition.chassis, hull = this.scene!.actor(actor.id), paint = this.paintOf(actor.id),
      place = chassisPlacement(this.scene!.pose(frame.id, 'plate')!, chassis, hull?.angle ?? 0),
      // Its track, on the frame plate of the stretch it runs under.
      track = chassis.kind === 'tracked' ? parts.find((part): part is Extract<DrawingPart, {type:'module'}> => part.type === 'module' && part.data.kind === 'track'
        && this.scene!.frame.get(part.data.mountId, 'plate')?.definition?.chassis?.part === 'frame')?.data : null,
      middle = chassis.track && (chassis.track.front + chassis.track.rear) / 2, trackHeld = track?.attached !== false,
      detailSource = detailGroup(actor.appearance, 'chassis'),
      letteringMirror = detailSource.lettering && screenMirrored(place.mirrored, this.camera.turn),
      // Its floor plate, the pieces of it still on it, painted with it (drawSurfaces leaves them to it).
      floor = chassisFloor(parts),
      wanted = [chassis.model, chassis.length, JSON.stringify(chassis.profile), definition.thicknessMm, definition.material, chassis.deck, chassis.depth, chassis.wheelDiameter, track?.width, track?.height, middle, chassis.track?.y, track?.armorMm, trackHeld, chassis.axles, JSON.stringify(chassis.skids ?? null), paint, detailSource.key, letteringMirror,
        floor ? `${floor.thicknessMm}/${floor.metal}/${floor.segments}` : ''].join(':');
    if (layers.chassisWanted !== wanted) {
      layers.chassisWanted = wanted;
      layers.chassisShape = chassisArtwork(chassisLayout(chassis.model,
        { length: chassis.length!, profile: chassis.profile, outlines: chassis.outlines!, deck: chassis.deck, depth: chassis.depth, wheelDiameter: chassis.wheelDiameter,
          thicknessMm: definition.thicknessMm, metal: definition.material,
          track: track && { width: track.width, height: track.height, middle: middle!, y: chassis.track!.y, armorMm: track.armorMm, held: trackHeld }, axles: chassis.axles,
          skids: chassis.skids ?? null, floor }), paint);
      const fix = (n: number) => Math.round(n * 1e5) / 1e5;
      layers.chassisDetails = plateDetails(parts, actor, 'chassis', part => this.scene!.pose(part.id)!, hull).map(detail => {
        const at = detailInBasis(detail, place);
        return { kind: detail.kind, x: fix(at.x), y: fix(at.y), angle: fix(at.angle), mirrored: at.mirrored,
          width: detail.width, height: detail.height, text: detail.text,
          mask: chassis.outlines!.find(poly => within(chassisLocal(place, detail.space === 'project' ? detail : this.scene!.pose(detail.plate!.id, 'plate')!), poly)) || [] };
      });
      layers.chassisDetailKey = layers.chassisDetails.length ? JSON.stringify(layers.chassisDetails) : '';
    }
    const shape = layers.chassisShape!, layout = shape.layout, asked = this.asked = [],
      textureKey = shape!.key + ':' + (this.weatheringMaps?.id ?? 0) + ':' + layers.chassisDetailKey + (letteringMirror ? ':letters-mirror' : ''),
      entry = this.progressiveTexture(textureKey, () => ({ type: 'chassis', shape, options: { paint, details: layers.chassisDetails, letteringMirror } }), { place: 'chassis:' + actor.id }),
      // Resizing a pending bitmap also resizes Pixi's original rectangle, before the next frame can fit its sprite.
      // The edit keeps its current solid outline until that bitmap is ready and fitted here.
      base = entry.texture, preview = this.mode === 'edit' && (entry.key !== textureKey || Boolean(entry.paint)),
      damage = this.chassisDamage(parts, place, shape),
      texture = damage ? this.paintedTexture('chassis-damage:' + actor.id, base, paintRevision(entry, damage.revision),
        ctx => paintHullImpacts(ctx, shape, damage.impacts, this.impactSource)) : base;
    let art = layers.chassisArt;
    if (!art || art.destroyed) { art = layers.chassisArt = new Container(); art.addChild(new Sprite()); }
    if (art.parent !== layers.chassis) layers.chassis.addChild(art);
    // The picture runs from the front of the chassis to its rear and up from its deck: on a vehicle that faces right it
    // is turned over, as its frame is.
    const sprite = art.children[0] as GuardSprite;
    art.visible = true; art.position.set(place.origin.x, place.origin.y); art.rotation = Math.atan2(place.along.y, place.along.x); art.scale.y = place.mirrored ? -1 : 1;
    sprite!.texture = texture; sprite!.visible = !preview; sprite!.position.set(shape!.left, shape!.top); sprite!.width = shape!.width; sprite!.height = shape!.height;
    sprite!.scale.y = -Math.abs(sprite!.scale.y);
    const seats = layers.chassisSeats = chassisSeats(place, layout, feet, layers.chassisSeats);
    this.seatShade(art, 1, seats, layout.kind !== 'tracked' ? layout.depth * .8 : Math.min(.2, layout.depth * .5), layout.shades);
    if (preview) {
      this.drawPanelRim(sprite, art, texturePreviewShape({ type: 'chassis', shape }), { x: 0, y: 0, angle: 0 }, paint);
      art.setChildIndex(sprite!.rim!, 1); // The deck shade remains over the current solid outline.
    } else if (sprite!.rim) sprite!.rim.visible = false;
    // What it hangs over its running gear, in the same frame, each a picture of its own with the marks that fall on it.
    const guardLayer = layout.kind === 'wheeled' && !this.closed.has(actor.id) ? layers.chassis : layers.guards;
    let guards = layers.chassisGuards;
    if (!guards || guards.destroyed) guards = layers.chassisGuards = new Container<GuardSprite>();
    // Cutaway fenders sit behind plate sections; exterior fenders and track skirts retain their foreground.
    if (guards.parent !== guardLayer) guardLayer.addChildAt(guards, guardLayer === layers.chassis ? guardLayer.getChildIndex(art) + 1 : 0);
    guards.visible = true; guards.position.copyFrom(art.position); guards.rotation = art.rotation; guards.scale.y = art.scale.y;
    const archedAt = arched.map(point => chassisLocal(place, point).x),
      bare = layout.kind === 'wheeled' ? layout.axles.map(axle => archedAt.some(x => Math.abs(x - axle.x) < axle.r * .5)) : [],
      sign = layout.key + '/' + bare.map(Number).join(''), kept = layers.chassisHung,
      hung = kept?.sign === sign ? kept.guards : (layers.chassisHung = { sign,
        guards: bare.some(Boolean) ? mudguardsOver(layout, layout.axles.filter((_, i) => !bare[i])) : layout.guards }).guards;
    while (guards.children.length > hung.length) {
      const child = guards.removeChildAt(guards.children.length - 1); child.rim?.destroy(); child.destroy();
    }
    while (guards.children.length < hung.length) guards.addChild(new Sprite());
    for (const [i, guard] of hung.entries()) {
      const child = guards.children[i];
      const hits = damage && fittingImpacts(damage.impacts, { x: guard.x - shape!.left, y: shape!.top - guard.y, w: guard.w, h: guard.h, flip: false });
      const key = `chassis-${guard.key}:${paint}:${layout.metal}:${this.weatheringMaps?.id ?? 0}`,
        entry = this.progressiveTexture(key, () => ({ type: 'guard', shape: guard, options: { paint, metal: layout.metal } }),
          { place: `chassis-guard:${actor.id}:${i}` }), preview = this.mode === 'edit' && (entry.key !== key || Boolean(entry.paint));
      let picture = entry.texture;
      if (hits?.length) picture = this.paintedTexture(`chassis-guard-damage:${actor.id}:${i}:${guard.x}`, picture, paintRevision(entry, damage!.revision), ctx =>
        paintHullImpacts(ctx, { width: guard.w, height: guard.h }, hits, this.impactSource));
      child!.texture = picture; child!.visible = !preview; child!.position.set(guard.x - guard.w / 2, guard.y + guard.h / 2); child!.width = guard.w; child!.height = guard.h;
      child!.scale.y = -Math.abs(child!.scale.y);
      if (preview) {
        const holder = layers.chassisGuardPreviews ??= new Container();
        if (holder.parent !== guardLayer) guardLayer.addChildAt(holder, guardLayer.getChildIndex(guards) + 1);
        holder.visible = true; holder.position.copyFrom(guards.position); holder.rotation = guards.rotation; holder.scale.y = guards.scale.y;
        this.drawPanelRim(child!, holder, texturePreviewShape({ type: 'guard', shape: guard }), { x: 0, y: 0, angle: 0 }, paint);
        if (layers.chassisSkirtShade?.parent === guardLayer)
          guardLayer.setChildIndex(holder, guardLayer.getChildIndex(layers.chassisSkirtShade));
      } else if (child!.rim) child!.rim.visible = false;
    }
    // A skirt hangs from under the deck, in the shade of what stands on it too; a mudguard stands out in front of it.
    const skirt = layout.guards.find(guard => guard.kind === 'skirt');
    let under = layers.chassisSkirtShade;
    if (skirt) {
      if (!under || under.destroyed) under = layers.chassisSkirtShade = new Container();
      if (under.parent !== layers.guards) layers.guards.addChild(under);
      under.visible = true; under.position.copyFrom(art.position); under.rotation = art.rotation; under.scale.y = art.scale.y;
      this.seatShade(under, 0, seats, Math.min(.22, skirt.h * .45), skirt.deck);
    } else if (under) under.visible = false;
    this.asked = null; layers.chassisKeys = asked;
    this.drawChassisEdges(layers, actor.id, layout, art, seats);
    // Cast by the outline of each part of it between its gaps.
    const shadow = layers.chassisShadow ??= { group: { x: 0, y: 0, rotation: 0 } };
    if (shadow.layout !== layout) {
      let first = 0;
      shadow.layout = layout; shadow.data = { outline: layout.outlines.flat() };
      shadow.edges = layout.outlines.flatMap(outline => { const start = first; first += outline.length; return outline.map((_, i) => ({ a: start + i, b: start + (i + 1) % outline.length })); });
    }
    // The retained cast often needs no new points. Project this local outline only if drawShade rebuilds it.
    shadow.outline = null; shadow.placement = place;
    Object.assign(shadow.group, { x: place.origin.x, y: place.origin.y, rotation: art.rotation });
    this.drawShade(shadow, actor.id, 'under', .14);
    if (chassis.kind !== 'wheeled' || this.camera.zoom < SUSPENSION_ZOOM) return;
    const rails = new Set(parts.filter(part => part.type === 'plate' && part.data.definition?.chassis?.part === 'rail').map(part => part.id)),
      held = parts.filter(part => part.type === 'module' && part.data.kind === 'wheel' && part.data.attached !== false && rails.has(part.data.mountId!))
        .map(part => chassisLocal(place, this.scene!.pose(part.id)!).x);
    for (const axle of layout.axles) if (!held.some(x => Math.abs(x - axle.x) < axle.r * .5))
      this.drawRig(actor.id, place, suspensionShapes(chassis.model, { x: axle.x, y: axle.y - BARE_AXLE_DROP }, paint, layout));
  }
  // The shade under the feet of what stands on a deck (chassis-art.ts `chassisSeats`, `seatShadeGeometry`, `createSeatShade`),
  // `depth` down from it over each stretch it stands on and only on what it falls on (`pieces`): one picture for all, in
  // one mesh after the first `after` children of `holder`, laid anew only when the seats change (`holder.seatShade`).
  seatShade(holder: SeatContainer, after: number, seats: readonly XY[], depth: number, pieces: readonly ChassisShade[]) {
    const texture = this.texture('seat-shade', createSeatShade, true).texture, laid = holder.seatShade;
    if (laid?.seats !== seats || laid.depth !== depth || laid.pieces !== pieces) {
      laid?.mesh?.destroy();
      const data = seatShadeGeometry(seats, depth, pieces), geometry = data.indices.length ? new MeshGeometry(data) : null,
        mesh = geometry && holder.addChildAt(new Mesh({ geometry, texture }), after);
      mesh?.once('destroyed', () => geometry!.destroy());
      holder.seatShade = { seats, depth, pieces, mesh };
    }
    if (holder.seatShade!.mesh) holder.seatShade!.mesh.texture = texture;
  }
  // The marks of the plates of a chassis, where the world has them, laid on its picture (chassis-art.ts): the last
  // sixteen of each plate, each as large as it is drawn on the skin of a hull (body-panels.ts).
  chassisDamage(parts: readonly DrawingPart[], place: ChassisPlacement, shape: ChassisArtwork) {
    const marks = [];
    for (const part of parts) {
      if (part.type !== 'plate' || !part.data.definition?.chassis && floorSegment(part.data.definition) === null || !part.data.marks?.length) continue;
      const plate = part.data, pose = this.scene!.pose(part.id, 'plate')!, { length, thicknessMm } = plate.definition;
      for (const m of plate.marks.slice(-16)) marks.push({ ...m, ...localToWorld(pose, (m.u - .5) * length, (.5 - m.v) * thicknessMm / 1000), angle: pose!.angle,
        radius: Math.max(.002, m.radius || (m.kind === 'hole' ? .025 : .014) + .014 * Math.sqrt(clamp(m.strength ?? 1, .05, 3))) });
    }
    return marks.length ? chassisImpactLayout(place, shape, marks) : null;
  }
  // The paint of a construction, as a number.
  paintOf(actorId: string | undefined) { return Number.parseInt((this.scene!.frame.actors.get(actorId || 'local')?.appearance?.paint || '#68765a').slice(1), 16); }
  // The picture of a mark of each kind and look, which every damaged picture of a part is painted with.
  get impactSource() {
    return this.impactSources ??= (kind, variant) => this.texture(`body-impact:${kind}:${variant}`, () => createBodyImpactTexture(kind, variant), true).texture.source.resource;
  }
  // The rim of a plate is laid out once in the plate's own frame and follows the plate from there. It is made
  // again when the plate changes its shape, or when the camera is close enough for the line to be thinned.
  drawRim(item: RenderDrawable, layer: Container, color: number) {
    const zoom = this.camera.zoom, width = lineWidth(.006, .95, zoom);
    let rim = item.rim;
    if (width * zoom < LINE_SEEN) { if (rim) rim.visible = false; return; }
    if (!rim || rim.destroyed) rim = item.rim = new Graphics();
    if (rim.parent !== layer) layer.addChild(rim);
    const edges = item.artEdges || item.edges, made = rim.made;
    if (!made || made.edges !== edges || made.data !== item.data || made.width !== width || made.color !== color) {
      rim.made = { edges, data: item.data, width, color }; rim.clear();
      // Edges that follow on from one another are one line, joined at their corners: a translucent line laid twice over
      // a corner would mark it.
      const at = item.positions, ends: (readonly [Point, Point])[] = item.artEdges ? item.artEdges.map(({ a, b }) => [a, b])
        : item.edges.map(({ a, b }) => [{ x: at[a * 2]!, y: at[a * 2 + 1]! }, { x: at[b * 2]!, y: at[b * 2 + 1]! }]), same = (p: Point, q: Point) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) < 1e-6;
      let start: Point | null = null;
      for (let i = 0; i < ends.length; i++) {
        const [a, b] = ends[i]!;
        if (!start || !same(ends[i - 1]![1], a)) { start = a; rim.moveTo(a.x, a.y); }
        if (same(b, start) && !same(a, b)) { rim.closePath(); start = null; } else rim.lineTo(b.x, b.y);
      }
      if (edges.length) rim.stroke({ color, width, alpha: .48, cap: 'round', join: 'round' });
    }
    rim.visible = true; rim.position.set(item.group.x, item.group.y); rim.rotation = item.group.rotation;
  }
  // The outline of a body panel seen cut open, over the rooms within it: drawn for the outline of its skin (`shape`) in the
  // frame of that skin, which is all its key tells, and stood at the skin's foot as its edges are (`drawHullEdges`). A
  // flat fill previews the current outline while its full bitmap waits during an edit; of a chassis in parts between its
  // gaps, each of its outlines (texture-paint.ts `texturePreviewShape`).
  drawPanelRim(sprite: {rim?: PanelRim;fittings?: Container}, layer: Container, shape: ReturnType<typeof texturePreviewShape> & {}, pose: Pose, fill: ColorSource | null = null) {
    const zoom = this.camera.zoom, width = lineWidth(.008, .9, zoom), key = fill === null ? shape.contour : shape.contour + ':' + fill;
    let rim = sprite.rim;
    if (fill === null && width * zoom < LINE_SEEN) { if (rim) rim.visible = false; return; }
    if (!rim || rim.destroyed) rim = sprite.rim = new Graphics();
    if (rim.parent !== layer) {
      if (fill !== null && sprite.fittings?.parent === layer) layer.addChildAt(rim, layer.getChildIndex(sprite.fittings));
      else layer.addChild(rim);
    }
    // `stroked`, not `width`: that one is the display width of a Graphics, and setting it scales the drawing.
    if (rim.shape !== key || rim.stroked !== width) {
      rim.shape = key; rim.stroked = width; rim.clear();
      for (const points of shape.outlines ?? [shape.points]) {
        rim.poly(points.flatMap(p => [p.x, p.y]));
        if (fill !== null) rim.fill(fill);
        rim.stroke({ color: 0x26382f, width, alpha: .48, join: 'round' });
      }
    }
    const foot = skinFoot(shape, pose);
    rim.visible = true; rim.position.set(foot.x, foot.y); rim.rotation = foot.angle;
  }
  // How the parts of a construction are outlined (silhouette.ts): in the dark of every construction, or as the player
  // has picked it.
  outlineStyle(actorId: string): SilhouetteStyle { return this.marked?.get(actorId) || 'dark'; }
  // The edges of the skin of a hull (`shape`, hull-art.ts `hullArtwork`, standing at `pose`): its outline under its
  // construction and, seen from outside and near enough, the light along the edges of it that look up, over its
  // fittings; an edge another room of the construction (`rooms`, in the frame of the outline) stands on has none.
  drawHullEdges(sprite: HullSprite, actorId: string, shape: HullArtwork, pose: Pose, outside: boolean, rooms: readonly (readonly Point[])[]) {
    const zoom = this.camera.zoom, width = lineAt(1, zoom), layers = this.actorLayers.get(actorId)!, foot = skinFoot(shape, pose);
    silhouette(this.silhouettes, sprite, 'silhouette', layers.outline, shape.contour, () => ({ points: shape.points }), this.outlineStyle(actorId), width, foot);
    if (!outside || zoom < GLINT_ZOOM) { drop(sprite, 'glint'); return; }
    silhouette(this.silhouettes, sprite, 'glint', layers.outerSkin, shape.key, () => ({ points: shape.points,
      others: rooms.map(room => room.map(p => ({ x: p.x - shape.left, y: p.y - shape.bottom }))) }), 'glint', width, foot);
  }
  // The outline of a part that makes the shape of its construction, a wheel, a track or a body carried out in the open,
  // standing as its group does: under its construction and, on a body, the light along its top over it. A wheel or a
  // track only a few pixels high has none: it is part of the speck its construction is. A tyre is outlined along its
  // tread, round its blocks and down between them (gear-art.ts `tyreOutline`), no farther out than its polygon draws its
  // picture at every turn, and turns with its picture as it is seen: on a construction turned about, the picture turns
  // within the mirror of its group and so the other way on the screen, and its line, turned outside that mirror, turns
  // back with it. A track is outlined round its belt as it is drawn (`outlineTrack`).
  // A body is outlined round its picture (cargo-art.ts `cargoOutline`), clear of the corners of its box a cistern leaves bare.
  outlinePart(item: RenderDrawable, actorId: string, module: DrawingModule, gear: boolean) {
    const zoom = this.camera.zoom;
    if (gear && module.height * zoom < GEAR_OUTLINE_PIXELS) { drop(item, 'silhouette'); return; }
    if (module.kind === 'track') { this.outlineTrack(item, this.actorLayers.get(actorId)!.outline, this.outlineStyle(actorId), lineAt(1, zoom)); return; }
    const width = lineAt(1, zoom), layers = this.actorLayers.get(actorId)!, key = 'part:' + item.data.revision,
      tyre = module.kind === 'wheel',
      shape = tyre ? () => ({ points: tyreOutline(module.height / 2, width, inscribed(item.data.positions) / (module.height / 2)) })
        : () => ({ points: cargoOutline(module.kind, module.width, module.height, width) });
    // Tracks own a dynamic Graphics outline; the other stable component identities own Silhouette instances.
    const holder = item as RenderDrawable & { silhouette?: Silhouette };
    const line = silhouette(this.silhouettes, holder, 'silhouette', layers.outline, key, shape, this.outlineStyle(actorId), width, item.group);
    if (tyre) line.rotation += item.group.scale.x * item.mesh.rotation;
    if (gear || zoom < GLINT_ZOOM) { drop(item, 'glint'); return; }
    const layer = item.group.parent!, glint = silhouette(this.silhouettes, item, 'glint', layer, key, shape, 'glint', width, item.group);
    if (layer!.getChildIndex(glint) < layer!.getChildIndex(item.group)) layer!.addChild(glint);
  }
  // The outline of a track, in `layer` under its construction (silhouette.ts `drawOutline`), round its belt as it is
  // drawn: close up round the outside of its links, which go with its wheels and its hull (drawTrackDetails), from afar
  // round its picture as its hull holds it (holdTrack). No other part has its shape, which changes as it goes: it is a
  // drawing of its own, drawn again when its shape does.
  outlineTrack(item: RenderDrawable, layer: Container, style: SilhouetteStyle, width: number) {
    const details = item.trackDetails, close = Boolean(details?.container.visible), shape = close ? details!.outline : item.hold ?? item.heldData;
    let line = item.silhouette as TrackOutline | undefined;
    if (!line || line.destroyed) line = item.silhouette = new Graphics();
    if (line.parent !== layer) layer.addChild(line);
    const drawn = line.drawnFor;
    if (drawn?.shape !== shape || drawn!.style !== style || drawn!.width !== width) {
      const flat = close ? details!.outline : item.positions, points: Point[] = [];
      for (let i = 0; i < flat!.length; i += 2) if (flat![i] !== flat![i - 2] || flat![i + 1] !== flat![i - 1]) points.push({ x: flat![i]!, y: flat![i + 1]! });
      line.drawnFor = { shape, style, width }; line.clear();
      drawOutline(line.context, points, style, width);
    }
    line.position.copyFrom(item.group.position); line.rotation = item.group.rotation; line.scale.copyFrom(item.group.scale);
    drop(item, 'glint');
  }
  // The outline of each part of a chassis between its gaps (`layout`, chassis-art.ts) under its construction, and the light
  // along its deck over its picture but where a hull or a body stands on it (`seats`); in the frame of its picture (`art`),
  // as it stands.
  drawChassisEdges(layers: ActorLayers, actorId: string, layout: ChassisLayout, art: Container, seats: readonly XY[]) {
    const zoom = this.camera.zoom, width = lineAt(1, zoom), key = 'chassis:' + layout.key;
    silhouette(this.silhouettes, layers, 'chassisSilhouette', layers.outline, key, () => ({ outlines: layout.decks }), this.outlineStyle(actorId), width, art);
    if (zoom < GLINT_ZOOM) { drop(layers, 'chassisGlint'); return; }
    const glint = silhouette(this.silhouettes, layers, 'chassisGlint', layers.chassis, key + '|' + seats.flat().join(','), () => deckGlint(layout, seats), 'glint', width, art);
    if (layers.chassis.children.at(-1) !== glint) layers.chassis.addChild(glint);
  }
  // The flag of a faction as its constructions fly it over their labels: one drawing for them all, a unit wide,
  // about the middle of its lower edge.
  flagArt(flag: FactionFlag) {
    const key = JSON.stringify(flag), tall = flagTall(flag), texture = this.flagTexture(flag);
    if (!this.flagArts.has(key)) {
      const art = new GraphicsContext(); drawFlag(art, flag, -.5, tall, 1, texture);
      art.rect(-.5, 0, 1, tall).stroke({ color: 0x1b3024, width: .07, alpha: .9 }); this.flagArts.set(key, art);
    }
    return this.flagArts.get(key)!;
  }
  // The picture of a country's flag (public/flags): asked for the first time it is to be drawn, and nothing until it
  // has come — whatever was drawn without it is then drawn again. It is drawn from 15 pixels wide over a label to
  // a hundred and more on the mast of a base, so it is kept at every halving of its size. A flag that is made has none.
  flagTexture(flag: FactionFlag) {
    const country = flag.country;
    if (!country) return null;
    if (!this.flagTextures.has(country)) {
      this.flagTextures.set(country, null);
      Assets.load({ src: countryFlag(country), data: { width: 256, height: 192, resolution: 1, autoGenerateMipmaps: true } })
        .then(texture => { this.flagTextures.set(country, texture); this.flagArts.delete(JSON.stringify(flag)); }, () => {});
    }
    return this.flagTextures.get(country)!;
  }
  // The footing of a construction that stands fixed (fixed-footing.ts), cast in the shape of its base down to the ground
  // under it, at the place it stands (`x`, `y`). It is worked out and drawn when the parts it is cast under, or the ground,
  // are others than it was drawn for, and kept as it is otherwise: a frame only tells that its parts are the same ones.
  // Where it goes into the ground it is darkened as a wheel darkens the ground it touches (`drawShade`).
  drawFooting(actor: DrawingActor, layers: ActorLayers, parts: readonly DrawingPart[], x: number, y: number) {
    const made = layers.footingMade, records = actor.preset === 'bunker' ? parts.map(part => part.data) : [], ground = this.standing();
    if (made && made.ground === ground && made.records.length === records.length && made.records.every((record, i) => record === records[i])) {
      if (made.cast) this.drawShade(made.cast, actor.id, 'shade', CONTACT_ALPHA, true);
      return;
    }
    const outlines = records.length ? footingOutlines(parts) : [],
      key = outlines.map(outline => outline.map(p => Math.round(p.x * 1e4) + ',' + Math.round(p.y * 1e4)).join(' ')).join('|');
    let cast = made?.cast ?? null;
    if (!made || made.ground !== ground || made.key !== key) {
      const footings = fixedFooting(outlines, ground);
      paintFooting(anchorGraphics(layers.footing, x, y), footings, this.baseMaterials);
      if (footings.length) {
        // The contact shadow is cast by the shapes of the footings as one part that stands where the construction does.
        const shapes = footings.map(footingShape), outline = shapes.flat();
        let first = 0;
        cast = Object.assign(cast ?? {}, { data: footings, outline, group: { x, y, rotation: 0 },
          edges: shapes.flatMap(shape => { const at = first; first += shape.length; return shape.map((_, i) => ({ a: at + i, b: at + (i + 1) % shape.length })); }) });
      } else if (cast) { cast.shade?.destroy(); cast = null; }
    }
    layers.footingMade = { ground, records, key, cast };
    if (cast) this.drawShade(cast, actor.id, 'shade', CONTACT_ALPHA, true);
  }
  drawStructure(state: RendererDrawing, obstacles: Parameters<typeof separateVehicleLabels>[1] = []) {
    const flags = new Map<string, GraphicsContext>(), labelled: LabelledActor[] = [], maxLabelWidth = Math.max(80, Math.min(260, this.camera.width - 24));
    this.labelBoxes.clear();
    if (state.shared) for (const [faction, flag] of knownFlags(state.faction)) flags.set(faction, this.flagArt(flag));
    for (const actor of state.actors) {
      // A mark from afar keeps its label, over the plates it stands for; its footing is hidden with its art.
      const dotted = this.dotted.has(actor.id);
      if (this.unseen.has(actor.id) && !dotted) continue;
      const layers = this.actorLayers.get(actor.id)!,
        parts = this.scene!.frame.actorParts.get(actor.id) || [], plates = parts.filter(part => part.type === 'plate').map(part => part.data),
        body = this.scene!.actor(actor.id), x = body?.x ?? actor.x ?? 12, y = body?.y ?? actor.y ?? 1.3;
      if (!dotted) this.drawFooting(actor, layers, parts, x, y);
      if (!state.shared) continue;
      // The roof, name and camera share the displayed pose. Snapshot heights would make the name jump
      // at each network delivery while an airborne vehicle moves smoothly between those deliveries.
      let height = y + 1.9;
      for (const plate of plates) {
        const pose = this.scene!.pose(plate.id, 'plate')!, definition = plate.definition;
        height = Math.max(height, pose!.y + Math.abs(Math.sin(pose!.angle)) * definition.length / 2 +
          Math.abs(Math.cos(pose!.angle)) * definition.thicknessMm / 2000);
      }
      const labelY = height + .45, projected = this.camera.toScreen(x, labelY);
      if (projected.x < -30 || projected.x > this.camera.width + 30) {
        if (layers.label) layers.label.visible = false;
        if (layers.flag) layers.flag.visible = false;
        continue;
      }
      const content = vehicleLabel(actor, state, parts), contentKey = JSON.stringify([content, maxLabelWidth]),
        side = standing(actor, state), flown = side === 'wreck' ? null : flags.get(actor.team!);
      if (!layers.label) layers.label = this.labels.addChild(new VehicleLabel(this.labelIcons, text => this.labelWidth(text)));
      if (layers.labelKey !== contentKey) { layers.labelKey = contentKey; layers.ownWidth = vehicleLabelLayout(content, text => this.labelWidth(text), maxLabelWidth).width; }
      const half = Math.min(layers.ownWidth! / 2 + 6, this.camera.width / 2), at = clamp(projected.x, half, this.camera.width - half);
      labelled.push({ id: actor.id, key: content.key, alone: content.alone, content, color: actor.color, labelY, flown,
        worldX: x + (at - projected.x) / this.camera.zoom, x: at, y: projected.y, width: layers.ownWidth!,
        alpha: (actor.id === state.controlledActor ? 1 : side === 'wreck' ? .6 : .85) * layers.fade! });
      if (flown && !layers.flag) layers.flag = this.labels.addChild(new Graphics(flown));
    }
    // Constructions that stand on one another have one label, over the middle of them, with one flag.
    const told = new Map(labelled.map(item => [item.id, item])), placements: PlacedActorLabel[] = [];
    for (const { ids } of labelGroups(labelled)) {
      const items = ids.map(id => told.get(id)), [first, ...rest] = ids.map(id => this.actorLayers.get(id)!);
      const content = groupedVehicleLabel(items.map(item => item!.content)), label = first!.label!, flown = items[0]!.flown,
        x = items.reduce((sum, item) => sum + item!.worldX, 0) / items.length, labelY = Math.max(...items.map(item => item!.labelY));
      // Content and visibility are applied only after grouping, never rewritten as individual labels during a pan.
      label!.setContent(content, maxLabelWidth, items[0]!.color);
      const projected = this.camera.toScreen(x, labelY), half = Math.min(label!.layout!.width / 2 + 6, this.camera.width / 2),
        screenX = clamp(projected.x, half, this.camera.width - half);
      placements.push({ id: ids[0]!, ids, key: content.key, first: first!, rest, label, flown,
        x: screenX, y: projected.y, baseY: projected.y, worldX: x + (screenX - projected.x) / this.camera.zoom, labelY,
        width: Math.max(label!.layout!.width, flown ? LABEL_FLAG : 0), top: Math.min(label!.layout!.top, flown ? -label!.layout!.lift - LABEL_FLAG : 0),
        bottom: label!.layout!.bottom, alpha: items[0]!.alpha });
    }
    for (const placed of separateVehicleLabels(placements, obstacles)) {
      const { first, rest, label, flown, worldX } = placed, labelY = placed.labelY + (placed.baseY - placed.y) / this.camera.zoom;
      label.position.set(worldX, labelY); label.scale.set(1 / this.camera.zoom, -1 / this.camera.zoom); label.alpha = placed.alpha; label.visible = true;
      if (first.flag) {
        if (flown) {
          if (first.flag.context !== flown) first.flag.context = flown;
          first.flag.position.set(worldX, labelY + label.layout!.lift / this.camera.zoom);
          first.flag.scale.set(LABEL_FLAG / this.camera.zoom); first.flag.alpha = label.alpha;
        }
        first.flag.visible = Boolean(flown);
      }
      for (const other of rest) { other.label!.visible = false; if (other.flag) other.flag.visible = false; }
      const box = { x: placed.x, left: placed.x - placed.width / 2, right: placed.x + placed.width / 2, top: placed.y + placed.top, bottom: placed.y + placed.bottom };
      for (const id of placed.ids) this.labelBoxes.set(id, box);
    }
  }
  drawSurfaces() {
    const frame = this.scene!.frame, used = new Set<string>(), feet = this.bodyFeet = new Map<string, [Point, Point][]>();
    this.armorPlan = !this.holdArt && (this.mode === 'edit' || this.camera.zoom >= ARMOR_DETAIL_ZOOM)
      ? this.armorArt.prepare(frame.surfaces, id => this.scene!.pose(id), this.unseen) : null;
    for (const surface of frame.surfaces) {
      // What an unseen construction had drawn stays as it was, with the textures it was drawn with.
      if (this.unseen.has(surface.actorId || 'local')) {
        used.add(surface.id);
        for (const key of this.drawables.get(surface.id)?.textureKeys || []) this.usedTextures.add(key);
        continue;
      }
      const { data, component, gear } = surface;
      // The chassis picture shows its generated frame plates, the floor plate over them and their damage in either view.
      // Painting them again as generic armour adds a bright strip along the deck: the floor, as bare metal, a pale line
      // between the deck and what stands on it, which then seems to float. Detached plates remain their own.
      if (this.covered.has(surface.id)) {
        // Closing a hull hides its contents; it does not remove their parts from the field. Keep only artwork
        // already made, so opening the same vehicle again does not rebuild its interior or upload it anew.
        const item = this.drawables.get(surface.id);
        if (item) {
          used.add(surface.id); item.group.visible = false;
          for (const key of item.textureKeys || []) this.usedTextures.add(key);
          for (const kept of [item.rim, item.shade, item.heap]) if (kept) kept.visible = false;
          drop(item, 'silhouette'); drop(item, 'glint');
        }
        continue;
      }
      if (surface.type === 'plate' && (surface.data.definition.chassis || floorSegment(surface.data.definition) !== null) && surface.data.attached !== false && !('detached' in surface.data && surface.data.detached) && !('fragment' in surface.data && surface.data.fragment)
        && chassisFrame(frame.actorParts.get(surface.actorId || 'local') || [])) continue;
      const seat = sensorSupport(component);
      const asked = this.asked = [], body = component && holdsCargo(component) ? this.loadBody(component, this.drawables.get(surface.id)?.body) : null,
        // A road machine shown at work has the picture of what of it stays with the vehicle (drawRoadMachines), and keeps the
        // one it travels with for when it is done.
        whole = component && component.kind !== 'weapon' ? this.moduleTexture(seat?.separate ? {...component,sensorSupport:'separate'} : component, body) : null,
        texture = whole ? (FACED_KINDS.has(component!.kind) && Object.hasOwn(this, 'roadMachines') && this.roadMachines!.get(machineKey(component!))?.frame) || whole :
          this.getTexture(data),
        // A closed hull hides the upper return where they overlap; a cutaway keeps the running gear in front.
        surfaceLayer = gear && component.kind === 'track' && this.closed.has(surface.actorId || 'local')
          ? 'moduleLayer' : surface.layer,
        item = this.geometry(surface, this.actorLayer(surface.actorId, surfaceLayer)!, texture);
      if (body) {
        // The foot of a body out in the open, where the world has it, for the deck it stands on (drawChassis), and the
        // heap over a hopper.
        if (body.out) {
          const pose = this.scene!.pose(component!.id, 'module')!, owner = surface.actorId || 'local';
          if (!feet.has(owner)) feet.set(owner, []);
          feet.get(owner)!.push([localToWorld(pose, -component!.width / 2, -component!.height / 2), localToWorld(pose, component!.width / 2, -component!.height / 2)]);
        }
        item.body = body; this.drawHeap(item, component!, body);
      }
      this.asked = null;
      if (body) {
        // Cargo has a cut-open and an outside picture too. Each side replaces its latest load/finish;
        // these two slots never retain a history of the loads the vehicle has carried.
        (item.bodyTextures ??= {})[body.side] = asked;
        item.textureKeys = Object.values(item.bodyTextures).flat();
        for (const key of item.textureKeys) this.usedTextures.add(key);
      } else item.textureKeys = asked;
      used.add(surface.id);
      if (!item.mesh.visible) {
        if (item.sensorSeat) item.sensorSeat.visible=false;
        for (const kept of [item.rim, item.shade, item.heap]) if (kept) kept.visible = false;
        drop(item, 'silhouette'); drop(item, 'glint'); continue;
      }
      if (surface.type === 'plate') this.drawRim(item, this.actorLayer(surface.actorId, 'edges')!, surface.data.material === 'concrete' ? 0xc3c1ac : 0xbac8bc);
      if (gear) {
        const pose = this.scene!.pose(component.id, 'module')!, hull = this.scene!.actor(surface.actorId);
        this.drawShade(item, surface.actorId, 'shade', CONTACT_ALPHA, true);
        if (component.kind === 'wheel') this.drawSuspension(component, pose, hull);
        if (component.kind === 'track') this.holdTrack(item, pose, hull);
        if (this.detailedTrack(component)) this.drawTrackDetails(item, pose);
      }
      // Running gear and a body carried out in the open make the shape of their construction, as its hull does: a track
      // as it is drawn, as its hull holds it and its wheels have it.
      if (gear || body?.out) this.outlinePart(item, surface.actorId || 'local', component!, Boolean(gear));
      else { drop(item, 'silhouette'); drop(item, 'glint'); }
      if (component?.kind === 'wheel') {
        // The picture of a wheel turns with it; the light of the sky on its upper half and its own shade on the half that
        // faces the ground do not, and they lie on the picture alone (tyre-shade.ts), including its brake drum. Between
        // the tread blocks the background stays untouched. On the rail of a wheeled chassis the top of the tyre is in the
        // shade of the fender over it instead; torn off, it is out in the open. A wheel a few pixels high is part of the
        // speck its construction is: it has neither, and its picture is drawn in one go with the rest of it.
        const lit = component.height * this.camera.zoom >= GEAR_OUTLINE_PIXELS;
        if (lit) {
          const style = this.underFender(component) ? 'fendered' : 'shade';
          if (item.tyreShadeStyle !== style) {
            const still = this.moduleTexture({ kind: 'wheel', ...MODULES.wheel, style });
            if (item.tyreShade) item.tyreShade.shade = still; else item.tyreShade = new TyreShade(still);
            item.tyreShadeStyle = style;
          }
          item.tyreShade!.texture = item.mesh.texture; item.tyreShade!.spin = item.mesh.rotation;
        }
        if (Boolean(item.mesh.shader) !== lit) remesh(item, lit ? item.tyreShade! : null);
      }
      if (component?.kind === 'sensor') {
        if (seat) {
          if (!item.sensorSeat) item.sensorSeat=item.group.addChildAt(new Graphics(),0);
          if (item.sensorSeatKey!==seat.key) { item.sensorSeat.clear(); drawSensorSupport(item.sensorSeat,seat); item.sensorSeatKey=seat.key; }
          item.sensorSeat.visible=true; item.sensorSeat.tint=item.mesh.tint; item.sensorSeat.alpha=item.mesh.alpha;
        } else if (item.sensorSeat) item.sensorSeat.visible=false;
        this.drawAerial(item, component);
      }
      if (component?.kind === 'blade' && this.camera.zoom >= ROAD_MOTION_ZOOM) this.drawBladeSupport(component);
    }
    for (const [id, item] of this.drawables) if (!used.has(id)) { destroyMesh(item); this.drawables.delete(id); }
  }
  // The jet out of each thruster of the frame (effects.ts `ThrusterJets`), in the layer of the thruster: the skin of a hull
  // seen from outside hides what of it is within, as it hides the thruster, and the jet still shows out of it. What an
  // unseen construction had drawn stays as it was; a wreck and a ghost blow none. With no frame (`state` none), none.
  drawThrusterJets(state: RendererDrawing | null) {
    const jets = this.effects.jets;
    jets.begin();
    for (const module of state?.modules || []) {
      if (module.kind !== 'thruster') continue;
      const owner = module.actorId || 'local', layers = this.actorLayers.get(owner)!;
      if (this.unseen.has(owner)) { jets.keep(module.id); continue; }
      jets.draw(module.id, layers?.[module.exposed && module.attached !== false ? 'outsideLayer' : 'moduleLayer'],
        layers?.still ? null : thrusterJet(module, this.scene!.pose(module.id, 'module')! ?? module, this.ground), this.camera?.zoom);
    }
    jets.end();
  }
  // The column a blade hangs by and its rams over its box, as the core admitted it (road-machine-motion.ts `bladeHang`).
  drawBladeSupport(module: DrawingModule) {
    const rig = machineRig('blade', module.width, module.height, bladeHang(module), module.toolReach);
    if (!rig.hang) return;
    const place = placeOf(this.scene!.pose(module.id, 'module')!, module.width, module.height), machine = this.roadMachines?.get(machineKey(module));
    drawBladeSupports(this.actorLayer(module.actorId || 'local', 'gun')!, rig, place,
      { pose: machine?.shown ? machine.pose! : null, pixel: 1 / this.camera.zoom, look: metalOf(module).look });
  }
  // Cargo is painted in its canonical local frame; the component's group reflects the complete picture. A body out in
  // the open is in the paint of its construction if it is of steel; of another material it is left bare, as the tanks
  // and boxes of aluminium and of glass fibre are, and shows what it is made of (`METALS` `look`).
  loadBody(module: DrawingModule, kept?: LoadBody): LoadBody {
    const actorId = module.actorId || 'local', pose = this.scene!.pose(module.id, 'module')!, mirror = module.mirrored ? -1 : 1,
      out = Boolean(module.exposed) && module.attached !== false,
      settled = kept && kept.out === out && kept.mirror === mirror && (this.mode !== 'edit' || kept.frame === this.scene!.frame);
    const arches = settled ? kept.arches : !out ? [] : loadArches(module.width, module.height, this.restAxles(actorId).map(axle => {
      const at = worldToLocal(pose, axle);
      return { x: mirror * at.u, y: at.v, r: axle.r };
    }));
    return { paint: out && !metalOf(module).look ? this.paintOf(actorId) : undefined, side: this.closed.has(actorId) ? 'outside' : 'inside', arches, out, mirror,
      frame: this.scene!.frame };
  }
  // Where the axles of a wheeled chassis are when it stands at rest, in the world as its frame plate is now (chassis-art.ts).
  restAxles(actorId: string) {
    const frame = chassisFrame(this.scene!.frame.actorParts.get(actorId) || []), chassis = frame?.data.definition.chassis;
    if (chassis?.kind !== 'wheeled') return [];
    const place = chassisPlacement(this.scene!.pose(frame!.id, 'plate')!, chassis, this.scene!.actor(actorId)?.angle ?? 0);
    return chassisLayout(chassis.model, { length: chassis.length!, profile: chassis.profile, outlines: chassis.outlines!, axles: chassis.axles,
      deck: chassis.deck, depth: chassis.depth, wheelDiameter: chassis.wheelDiameter }).axles.map(({ x, y, r }) => ({ ...chassisPoint(place, x, y), r }));
  }
  // The heap a hopper is loaded over its rim with (cargo-art.ts `heapOver`): a picture of its own, laid on the top of the
  // piece as its group lies, in the layer over the arm folded on it (`heaps`). None on the lower steps, which stay within
  // the rim.
  drawHeap(item: RenderDrawable, module: DrawingModule, body: LoadBody) {
    const load = cargoLook(module), over = module.kind === 'hopper' ? heapOver(module.width, module.height, load.level) : null;
    if (!over) { if (item.heap) item.heap.visible = false; return; }
    let heap = item.heap;
    if (!heap || heap.destroyed) heap = item.heap = this.actorLayer(module.actorId, 'heaps')!.addChild(new Container<Sprite>());
    const [picture = heap!.addChild(new Sprite())] = heap!.children;
    picture.texture = this.texture(['heap', module.width.toFixed(3), module.height.toFixed(3), over.level, load.material].join(':'), () => {
      const painted = canvas(...heapCanvasSize(over));
      paintHeap(context2d(painted), over, load.material);
      return pieceTexture(painted);
    }).texture;
    heap!.visible = true; heap!.position.copyFrom(item.group.position); heap!.rotation = item.group.rotation; heap!.scale.x = item.group.scale.x;
    picture.position.set(over.x0 - module.width / 2, module.height / 2 + over.height);
    picture.width = over.x1 - over.x0; picture.height = over.height; picture.scale.y = -Math.abs(picture.scale.y);
  }
  // The aerial of a radar turns over its turntable, a turn every few seconds (base-art.ts `AERIAL_TURN`), each radar from a
  // bearing of its own; one put out of order or loose, or of a wreck or a ghost, stands still. Another sensor has no aerial.
  drawAerial(item: RenderDrawable, module: DrawingModule) {
    if (module.sensorMode !== 'radar') { item.aerial?.destroy({ children: true }); item.aerial = null; return; }
    const made = item.aerial?.destroyed ? null : item.aerial?.radar;
    if (made?.id !== module.id || made.actorId !== module.actorId || made.width !== module.width || made.height !== module.height) {
      item.aerial?.destroy({ children: true });
      item.aerial = item.group.addChild(aerialMeshes(module.width, module.height, aerialBearing(module.actorId + ':' + module.id),
        { id: module.id, actorId: module.actorId }));
      item.aerial.position.set(0, item.aerial.radar.shape.y);
    }
    const working = module.health !== 0 && module.attached !== false && !this.actorLayers.get(module.actorId)?.still;
    this.placeAerial(item.aerial!, item.aerial!.radar.bearing + (working ? this.frameNow / 1000 * AERIAL_TURN : 0), componentTint(module), module.metal);
  }
  // The aerial's orthographic sides, far to near, lit as they face the view under `tint`, of the material of its radar.
  // Visible faces ask the texture cache each draw, including while their painting waits for the worker.
  placeAerial(aerial: Aerial, turn: number, tint: number, metal?: DrawingModule['metal']) {
    const { shape } = aerial.radar, view = aerialView(shape, turn, AERIAL_SIGHT);
    for (let i = 0; i < aerial.children.length; i++) {
      const mesh = aerial.children[i], side = view.faces[i];
      mesh!.visible = i < view.count;
      if (!mesh!.visible) continue;
      const { style, corners: c } = side!;
      mesh!.texture = this.moduleTexture({ kind: 'sensor', sensorMode: 'radar', style, width: style === 'edge' ? shape.depth : shape.width, height: shape.height, metal });
      mesh!.position.set((c[0]! + c[2]!) / 2, 0);
      mesh!.scale.set((c[2]! - c[0]!) / mesh!.texture.width, -shape.height / mesh!.texture.height); mesh!.tint = lit(tint, side!.light);
    }
  }
  // How wide the words of a label of a construction are on the screen, in pixels, as its font writes them.
  labelWidth(text: string) {
    const pen = this.labelPen ??= document.createElement('canvas').getContext('2d')!;
    pen.font = `600 ${LABEL_FONT}px 'Segoe UI'`;
    return pen.measureText(text).width + 6;
  }
  // Whether a wheel is held on the rail of a wheeled chassis, under the mudguard the chassis hangs over it.
  underFender(module: Pick<DrawingModule,'mountId'|'attached'>) {
    return module.attached !== false && Boolean(module.mountId) && this.scene!.frame.get(module.mountId, 'plate')?.definition?.chassis?.kind === 'wheeled';
  }
  // What holds a wheel of a wheeled chassis to its rail (chassis-art.ts `suspensionShapes`), where the wheel is now: the
  // end of its axle, and the spring and the damper between it and the rail, in the frame of the picture of the chassis.
  // From afar, behind the tyre, none is drawn.
  drawSuspension(module: DrawingModule, pose: RenderModulePose, hull: RenderBodyPose | null) {
    const rail = module.mountId ? this.scene!.frame.get(module.mountId, 'plate') : null, frame = rail && chassisFrame(this.scene!.frame.actorParts.get(module.actorId || 'local') || []);
    if (rail?.definition?.chassis?.kind !== 'wheeled' || !frame || this.camera.zoom < SUSPENSION_ZOOM) return;
    const chassis = frame.data.definition.chassis, place = chassisPlacement(this.scene!.pose(frame.id, 'plate')!, chassis, hull?.angle ?? 0);
    this.drawRig(module.actorId, place, suspensionShapes(chassis.model, chassisLocal(place, pose), this.paintOf(module.actorId), { deck: chassis.deck, depth: chassis.depth, wheelDiameter: module.height }));
  }
  // Shapes in the frame of the picture of a chassis (`place`), drawn where the world has them in the layer of what moves
  // within the construction: filled, and outlined, or a line along their points.
  drawRig(actorId: string | undefined, place: ChassisPlacement, shapes: readonly SuspensionShape[]) {
    const g = this.actorLayer(actorId, 'suspensionArms')!;
    for (const { points, fill, line } of shapes) {
      const world = new Array(points.length);
      for (let i = 0; i < points.length; i += 2) { const p = chassisPoint(place, points[i]!, points[i + 1]!); world[i] = p.x; world[i + 1] = p.y; }
      if (fill !== undefined) { g.poly(world).fill(fill); if (line) g.stroke(line); continue; }
      g.moveTo(world[0], world[1]);
      for (let i = 2; i < world.length; i += 2) g.lineTo(world[i], world[i + 1]);
      g.stroke({ ...line, cap: 'round', join: 'round' });
    }
  }
  detailedTrack(module: Pick<DrawingModule,'kind'|'height'> & {attached?: boolean | undefined;beltCut?: boolean | undefined}) {
    return suspendedTrack(module) && (this.mode === 'edit' || 2 * TRACK_PIN * module.height * this.camera.zoom >= TRACK_DETAIL_PIXELS);
  }
  // The picture of a track, and the shade over its wheels (`trackDetails.cover`), as the track rides on its springs under
  // its hull: its foot where the track stands, its top where the hull holds it (running-gear.ts `holdTrackShape`), as
  // the hull holds the track it was built with (chassis-art.ts `heldTrack`, kept in `item.hold` for its wheels).
  holdTrack(item: RenderDrawable, module: RenderModulePose, hull: RenderBodyPose | null) {
    const plate = module.mountId ? this.scene!.frame.get(module.mountId, 'plate') : null, frame = plate?.definition?.chassis && chassisFrame(this.scene!.frame.actorParts.get(module.actorId || 'local') || []),
      chassis = frame?.data.definition.chassis,
      hold = chassis?.track ? heldTrack(chassisPlacement(this.scene!.pose(frame!.id, 'plate')!, chassis, hull?.angle ?? 0), chassis as typeof chassis & {track: NonNullable<typeof chassis.track>}, module) : null,
      last = item.hold;
    // Kept while it holds the track the same way, to the tenth of a millimetre and the hundredth of a milliradian.
    if (item.heldData === item.data && (last === hold || last && hold && Math.round(last.x * 1e4) === Math.round(hold.x * 1e4)
      && Math.round(last.y * 1e4) === Math.round(hold.y * 1e4) && Math.round(last.angle * 1e5) === Math.round(hold.angle * 1e5))) return;
    item.hold = hold; item.heldData = item.data;
    holdTrackShape(item.data.positions, item.positions, module.width, module.height, hold);
    item.geometry.getBuffer('aPosition').update();
  }
  drawTrackDetails(item: RenderDrawable, module: RenderModulePose) {
    let details = item.trackDetails;
    if (!details) {
      const container = new Container(), side = new Sprite(), frame = new Graphics(), links = new TrackLinks();
      side.anchor.set(.5); container.addChild(side, frame, links); item.group.addChild(container);
      details = { container, side, frame, links, dirt: new TrackShade(), cover: new TrackShade(), soil: null, wheels: [] }; item.trackDetails = details;
    }
    // Where its wheels are drawn and the belt round them (running-gear.ts `trackGear`), kept while they stay where they were:
    // in the field its upper run sags as its belt is slack, going over to that from frame to frame; in the workshop as built.
    const gear = details.gear = trackGear(module, this.standing(), item.hold, details.gear, this.mode === 'edit' ? null : this.frameNow / 1000);
    const links = details.links;
    links.configure(module.width, module.height);
    // How far the belt has gone round, and with it the sprocket that drives it, turned as far on the line of its pins.
    const travel = (module.mirrored ? 1 : -1) * (module.wheelSpin || 0) * module.height / 2, turn = -travel / gear.pin, { count, pitch, teeth } = links,
      tint = componentTint(module), metal = module.metal, look = metalOf(module).look;
    if (!details.wheelPictures || details.metal !== metal || details.teeth !== teeth) {
      details.metal = metal; details.teeth = teeth!; details.wheelPictures = new Map();
      for (const role of ['road', 'sprocket', 'idler', 'roller'])
        details.wheelPictures.set(role, this.moduleTexture({ kind: 'wheel', ...MODULES.wheel, metal, style: role, ...role === 'sprocket' && { teeth } }));
    }
    details.container.visible = true;
    while (details.wheels.length > gear.drawn.length) details.wheels.pop()!.destroy();
    for (const [i, wheel] of gear.drawn.entries()) {
      let sprite = details.wheels[i];
      if (!sprite) {
        sprite = new Sprite(); sprite.anchor.set(.5);
        details.container.addChild(sprite); details.wheels.push(sprite);
      }
      // The sprocket drives the belt, its teeth at the pins of its links; the idler turns it back, the road wheels carry
      // the vehicle on it, and the rollers carry its upper run back.
      sprite.texture = details.wheelPictures.get(wheel.role)!;
      sprite.position.set(wheel.x, wheel.y); sprite.width = sprite.height = wheel.radius * 2;
      sprite.scale.y = -Math.abs(sprite.scale.y); sprite.tint = wheel.shade < 1 ? lit(tint, wheel.shade) : tint;
      sprite.rotation = wheel.role === 'sprocket' ? turn : -travel / wheel.rolls;
    }
    // The links of a belt are drawn where one can be told from the next: from afar the belt is a band as wide as they
    // are. They go round it with the sprocket, the way that carries the lower run back under the hull as the vehicle goes
    // ahead; their horns and grousers once those are a pixel high. The edge of the track is the outside of the one or the
    // other (`outline`).
    links.visible = Math.min(pitch!, 2 * TRACK_SHOE_HALF_THICKNESS * module.height) * this.camera.zoom >= 1.5;
    if (links.visible) {
      links.texture = this.texture('track-links:' + (metal || ''), () => trackLinkTexture(look, this.trackSurfaces), true).texture;
      links.update(linkStart(gear, count, teeth!, turn), gear.belt, TRACK_GROUSER * module.height * this.camera.zoom >= TRACK_FINE_PIXELS);
    } else if (details.edgeGear !== gear) { details.edgeGear = gear; details.edge = Float64Array.from(gear.edge.outline()); }
    details.outline = links.visible ? links.outline! : details.edge!;
    // Behind the links, the side of the hull where the hull holds it, and over it the brackets of the rollers and the
    // arms of the road wheels (track-links.ts `drawTrackFrame`).
    const side = details.side, place = gear.side;
    if (details.frameGear !== gear || details.frameMetal !== metal || details.casing !== !links.visible) {
      details.frameGear = gear; details.frameMetal = metal; details.casing = !links.visible;
      drawTrackFrame(details.frame, gear, look, module.height, details.casing);
    }
    // Over the wheels and the links, standing still, the dirt of the ground it runs on (track-links.ts `trackDirt`), out
    // to the tips of the grousers, coming in as the wheels grow large enough to read; over that the shade of the hull on
    // the upper run and the dark along the ground, within the edge of the belt.
    const { container, dirt, cover } = details, size = 2 * TRACK_PIN * module.height * this.camera.zoom;
    if (container.children.at(-2) !== dirt || container.children.at(-1) !== cover) container.addChild(dirt, cover);
    const soil = details.soil = trackDirt(details.soil, this.ground?.groundAt?.(module.x), this.frameNow / 1000);
    dirt.update(links.visible ? links.tread! : details.edge!, module.height);
    dirt.tint = soil.tone; dirt.alpha = soil.amount * clamp(size / TRACK_DETAIL_PIXELS - 1, 0, 1);
    cover.update(details.outline!, module.height);
    // Their pictures are among those the track is drawn with: they are kept for as long as the track stays drawn.
    this.asked = item.textureKeys!;
    dirt.texture = this.texture('track-dirt', trackDirtTexture, true).texture;
    cover.texture = this.moduleTexture({ kind: 'track', width: module.width, height: module.height, metal, overlay: true });
    side.texture = this.texture(`track-side:${metal || ''}:${place.width.toFixed(3)}x${module.height.toFixed(3)}`,
      () => trackSideTexture(look, this.trackSurfaces, place.width, module.height)).texture;
    this.asked = null;
    side.position.set(place.x, place.y); side.rotation = place.angle; side.width = place.width; side.height = place.height;
    side.scale.y = -Math.abs(side.scale.y);
    details.cover.tint = details.links.tint = details.side.tint = details.frame.tint = tint;
    return details.container;
  }
  drawGun(state: RendererDrawing, parts = true) {
    // Painted sprites are placed every frame; any that were not are retired
    // before the transient texture cache releases what this frame left unused.
    this.weaponArt.begin(); this.hotBarrels.length = 0;
    if (this.weapon) this.drawArmament(state, parts);
    const ghosts = parts && this.mode === 'edit' && this.modulePreview ? this.modulePreview.modules : [];
    for (const ghost of ghosts) if (ghost.kind === 'weapon')
      this.weaponArt.place('preview:' + ghost.id, this.benchArt, ghost, weaponAngle(ghost), ghost.weaponPreset, { alpha: .62, weathering: this.weatheringMaps });
    this.weaponArt.end();
  }
  // The complete arm of each installed extractor and builder in view (work-arm.ts), in the layer of what moves within
  // its construction. `time` is that of the frame shown: a design has none, and its arms stay folded. What is
  // kept of an arm from one frame to the next is this renderer's own, and goes with the piece of its construction as it was
  // designed (`machineKey`): one that turns about, and so comes to the field again, folds and unfolds as it was.
  drawWorkArms(state: RendererDrawing, time: number | null = null) {
    const zoom = this.camera.zoom;
    if (zoom < WORK_ARM_ZOOM) return;
    const arms = Object.hasOwn(this, 'workArms') ? this.workArms : this.workArms = new Map(), seen = new Set(), ground = (x: number) => this.ground.height(x);
    let extractionPaces;
    for (const module of state.modules) {
      const actorId = module.actorId || 'local';
      if (!WORK_TOOLS.has(module.kind) || module.attached === false || this.unseen.has(actorId)) continue;
      // How far the construction reaches from the middle of the piece, along the piece as it stands upright.
      const piece = this.scene!.pose(module.id, 'module')!, parts = (this.scene!.frame.actorParts.get(actorId) || []).map(part => this.scene!.pose(part.id)!), frame = workFrame(piece, parts);
      const key = machineKey(module), arm: RenderWorkArm = arms!.get(key) || {};
      arm.weathering ||= createWorkArmWeathering(this.weatheringFills?.workArm, module.kind);
      arms!.set(key, arm); seen.add(key);
      const actor = this.scene!.frame.actors.get(actorId);
      if (module.kind === 'builder') { this.drawCrane(state, { module, piece, parts, frame, arm, actor }, time, ground); continue; }
      // An arm that is out keeps the end it works past and its length until it is folded again.
      if (!arm.deployed) arm.side = workSide(frame, 0, piece!.mirrored);
      const extraction = actor?.field?.extraction?.find(tool => tool.partId === module.id),
        active = !actor?.ghost && module.health! > 0 && Boolean(extraction),
        layout = workLayout(piece, frame, arm.side!, active || arm.deployed ? ground : null),
        site = extraction && depositsNear(depositsOf(this.ground), piece!.x, layout.length + DEPOSIT_ART_REACH).find(site => site.id === extraction.siteId);
      if (time !== null) {
        // The faction already knows its engines' paid pace. This changes only the cycle, never activity;
        // other visible factions keep their existing rhythm without disclosing their power.
        if (active) extractionPaces ??= new Map((state.faction?.units ?? []).map(unit => [unit.id, unit.tools?.pace ?? 1]));
        workStep(arm, layout.rig, active, actor?.ghost ? arm.time ?? time : time, extractionPaces?.get(actorId) ?? 1);
      }
      const delivery = active || arm.deployed ? workDelivery(layout, parts, site, ground, arm) : null;
      drawWorkArm(this.actorLayer(actorId, 'gun')!, workFigure(layout, arm, ground, delivery),
        { pixel: 1 / zoom, material: site?.material || 'ferro', weatheringFills: arm.weathering });
    }
    for (const key of arms!.keys()) if (!seen.has(key)) arms!.delete(key);
  }
  // The crane of a builder: at work while the field says its construction puts up or takes down something (`field.building`);
  // standing still, at work on the heap it loads, out at rest over what it stands by (`craneStandby`), or over what it was at
  // for a moment after it worked (`LIFT_HOLD`) and as long as it takes to set down the load it lifts; and else folded, as it
  // is while it drives. It works at what the page is told of (`craneTarget`), and else past the end of its construction, as
  // fast as its engines let it (`pace`), towards what it falls short of (`craneRoute`); it keeps the way it works until it
  // is folded, and folds before it works on the other side; and it carries a load of each material of what it is at in turn.
  drawCrane(state: RendererDrawing, { module, piece, parts, frame, arm, actor }: {module: DrawingModule;piece: RenderModulePose;parts: WorkPart[];frame: WorkFrame;arm: RenderWorkArm;actor: DrawingActor | undefined}, time: number | null, ground: HeightAt) {
    const able = !actor?.ghost && Number(module.health) > 0 && !actor?.field?.service, body = actor?.vehicle,
      told = able ? actor?.field?.building ?? null : null, still = Math.hypot(body?.vx || 0, body?.vy || 0) <= STILL_SPEED;
    if (told && time !== null) arm.told = time;
    let duty: 'fold' | 'rest' | 'work' = 'fold', target: RenderWorkArm['target'] = null;
    if (told) { duty = 'work'; target = this.craneTarget(state, told.at); }
    else if (able && still) {
      target = this.craneStandby(state, actor, parts);
      if (target) duty = target.gather ? 'work' : 'rest';
      else if (time !== null && (time >= arm.told! && time - arm.told! < LIFT_HOLD || arm.finishing)) { duty = 'rest'; target = arm.target ?? null; }
    }
    const side = target ? craneSide(piece, target) : arm.side ?? workSide(frame, 0, piece.mirrored);
    if (!arm.deployed) arm.side = side;
    else if (side !== arm.side) duty = 'fold';
    if (duty !== 'fold') arm.target = target;
    const layout = craneLayout(piece, frame, arm.side!),
      route = duty !== 'fold' || arm.deployed ? craneRoute(layout, parts, ground, arm.target) : null, kinds = arm.target?.materials ?? [];
    // What it falls short of it reaches out to, and rests.
    if (route?.short && duty === 'work') duty = 'rest';
    if (time !== null) craneStep(arm, duty, actor?.ghost ? arm.time ?? time : time, told?.pace ?? 1);
    drawWorkArm(this.actorLayer(module.actorId || 'local', 'gun')!, craneFigure(layout, arm, route), { pixel: 1 / this.camera.zoom,
      material: kinds.length ? kinds[Math.floor((arm.cycle || 0) / LIFT_SECONDS) % kinds.length] : 'ferro', weatheringFills: arm.weathering });
  }
  // What a builder of the player's faction standing still and told to work at nothing is at (work-arm.ts `craneStandby`), by
  // its job: the works of the faction and the structures of it being taken down, as its crane works at them, and the heaps
  // of the faction (`faction.heaps`), as they are drawn (`siteMarks`), its loads taken off the top of the pile. Nothing of
  // another faction's: what it works at is not told.
  craneStandby(state: RendererDrawing, actor: DrawingActor | undefined, parts: WorkPart[]): RenderCraneTarget | null {
    const faction = state.faction, unit = actor && faction?.units?.find(unit => unit.id === actor.id);
    if (!unit) return null;
    const ids = [...(faction!.works ?? []).map(work => work.id), ...(faction!.posts ?? []).filter(post => post.takedown).map(post => post.id),
        ...state.actors.filter(other => other.team === actor.team && other.field?.service?.kind === 'dismantle').map(other => other.id)],
      heaps = (faction!.heaps ?? []).map(heap => {
        const size = this.siteMarkers.heapSize(heap.id);
        if (!size) return null;
        const lo = heap.x - size.width / 2, hi = heap.x + size.width / 2;
        return { id: heap.id, gather: true, lo, hi, down: false, boxes: [{ lo, hi, top: this.ground.height(heap.x) + size.height }],
          materials: CRANE_LOADS.filter(id => heap.stock?.[id] > 0) };
      }),
      targets = [...ids.map(id => { const target = this.craneTarget(state, id); return target && { ...target, id }; }), ...heaps].filter((target): target is NonNullable<typeof target> => Boolean(target));
    return targets.length ? craneStandby(boxesOf(parts), targets, unit.job, BUILD_REACH) : null;
  }
  // What a builder of the player's faction puts up or takes down, as its crane works at it: the stretch of the field it
  // takes up, the boxes a load is set on — a works as high as it is put up (`siteMarks`), a structure by its parts, a post
  // being taken down over its ground up to its eye, as the field has it (supply-dispatch.ts `parking`) —, whether it is being
  // taken down, and the stocks it is of. Nothing the page is not told of.
  craneTarget(state: RendererDrawing, at: string | null | undefined): RenderCraneTarget | null {
    const work = at && state.faction?.works?.find(work => work.id === at), shape = work && this.siteMarkers.workBounds(at);
    if (shape) return { lo: shape.minX, hi: shape.maxX, down: false, materials: CRANE_LOADS.filter(id => work.cost?.[id] > 0),
      boxes: [{ lo: shape.minX, hi: shape.maxX, top: shape.minY + (shape.maxY - shape.minY) * clamp(work.progress, 0, 1) }] };
    const post = at && state.faction?.posts?.find(post => post.id === at && post.takedown);
    if (post) {
      const lo = post.x - post.radius, hi = post.x + post.radius;
      return { lo, hi, down: false, materials: ['ferro', 'ligas', 'silica'], boxes: [{ lo, hi, top: this.ground.height(post.x) + POST_EYE }] };
    }
    const standing = at ? this.scene!.frame.actors.get(at) : null, parts = standing?.field?.service?.kind === 'dismantle' ? this.scene!.frame.actorParts.get(at!) ?? [] : [],
      boxes = boxesOf(parts.map(part => this.scene!.pose(part.id)));
    return boxes.length ? { lo: Math.min(...boxes.map(box => box.lo)), hi: Math.max(...boxes.map(box => box.hi)), down: true, boxes,
      materials: [...new Set(parts.filter(part => part.type === 'plate').map(part => stockOf(part.data)))] } : null;
  }
  // The road machines (road-machine-motion.ts), before their pieces are drawn: what each is told it does, its tool lowered
  // as far as it has gone, and how far the road it makes has come on the screen — behind the hindmost of the tools of its
  // kind that work on its vehicle, as the field makes it —, for the ground to show it (TerrainScene `showWork`). One in view
  // near enough is shown at work (`drawRoadMachines`) once the pictures of its parts are painted: till then, and afar, it is
  // the picture it travels with, and its tool goes down only once it may be shown. Out of view it goes on as it did, with
  // the pictures it had. A blade rests on the ground it leaves graded, cutting the bumps of the ground drawn close by.
  stepRoadMachines(state: RendererDrawing, time: number) {
    const machines = this.roadMachines ??= new Map(), seen = new Set<string>(), works: RoadWork[] = [], ground = this.standing(),
      graded = ground === this.ground ? ground : gradedGround(this.ground), near = this.camera.zoom >= ROAD_MOTION_ZOOM,
      stepped: [RenderMachine & {at:number;dt:number}, RoadToolKind, string][] = [], tools = new Map<string, number[]>();
    for (const module of state.modules) {
      if (!roadMachineModule(module) || module.attached === false) continue;
      const actorId = module.actorId || 'local', key = machineKey(module), machine: RenderMachine = machines.get(key) ?? {};
      machines.set(key, machine); seen.add(key);
      const dt = followWork(machine, this.scene!.frame.actors.get(actorId), module, time), W = module.width, H = module.height,
        rig = machineRig(module.kind, W, H, bladeHang(module), module.toolReach);
      if (this.unseen.has(actorId)) { for (const key of machine.keys ?? []) this.usedTextures.add(key); lower(machine, dt); }
      else {
        const ready = near && (machine.working || machine.lowered! > 0) && this.roadMachineArt(module, machine, rig);
        if (!near || ready) lower(machine, dt);
        machine.shown = ready && (machine.working || machine.lowered! > 0);
        if (!machine.shown) { machine.frame = machine.parts = null; machine.keys = []; }
      }
      const place = placeOf(this.scene!.pose(module.id, 'module')!, W, H), eased = smoothstep(machine.lowered ?? 0);
      let pose: BladePose | ScreedPose, contact: boolean;
      if ('ball' in rig) {
        const full: {drop:number;tilt?:number;contact:boolean;surface?:ReturnType<typeof bladeDrop>['surface']} =
          eased > 0 ? bladeDrop(rig, place, graded, ground) : { drop: 0, tilt: 0, contact: false };
        pose = bladePose(rig, place.down, eased * full.drop, full.surface); contact = full.contact;
      } else {
        const full = eased > 0 ? screedDrop(rig, place, this.ground) : { drop: 0, tilt: 0, contact: false };
        pose = screedPose(rig, place.down, eased * full.drop, eased * full.tilt); contact = full.contact;
      }
      const placed = Object.assign(machine, { rig, place, pose, contact, dt, at: toolAt(module.kind, place, W, H) });
      const team = actorId + ':' + module.kind;
      stepped.push([placed, module.kind, team]);
      if (module.health! > 0) tools.set(team, [...tools.get(team) ?? [], placed.at]);
    }
    for (const [machine, kind, team] of stepped) {
      advanceLanes(machine, tools.get(team) ?? [machine.at], machine.dt, this.ground.roads);
      works.push(...worksOf(machine, kind));
    }
    for (const [id, machine] of machines) if (!seen.has(id)) { machine.view?.destroy(); machines.delete(id); }
    this.terrainScene.showWork(works);
  }
  // The pictures a road machine is drawn at work with: what of it stays with its vehicle, and each
  // part that moves, as it travels (`partBox`), with the marks of the hits that fall on it. Whether all are painted; the
  // names of their textures are kept for while it is out of view.
  roadMachineArt(module: DrawingModule & {kind:RoadToolKind}, machine: RenderMachine, rig: MachineRig) {
      const W = module.width, H = module.height, painted: (boolean | undefined)[] = [],
      picture = (look: PaintedModule) => { const told: {painted?: boolean} = {}, texture = this.moduleTexture(look, null, told); painted.push(told.painted); return texture; };
    this.asked = [];
    machine.frame = picture({ ...module, part: 'frame' });
    machine.boxes = {}; machine.parts = {};
    for (const part of MOTION_PARTS[module.kind]) {
      const box = machine.boxes[part] = partBox(rig, part, W, H);
      machine.parts[part] = picture({ ...module, width: box.w, height: box.h, part, crop: { x: box.x, y: box.y, W, H },
        marks: module.marks?.length ? partMarks(module.marks, box, W, H, module.mirrored) : module.marks });
    }
    machine.keys = this.asked; this.asked = null;
    return painted.every(Boolean);
  }
  // The road machines shown at work (stepRoadMachines), each over its picture, its tool where it has gone down to; and
  // closer, what they raise: earth off a blade on the ground, the shaking of a screed and the steam off the mix behind it.
  drawRoadMachines(state: RendererDrawing) {
    if (!Object.hasOwn(this, 'roadMachines')) return;
    const pixel = 1 / this.camera.zoom, detail = this.camera.zoom >= ROAD_DETAIL_ZOOM;
    for (const module of state.modules) {
      const machine = this.roadMachines!.get(machineKey(module)), actorId = module.actorId || 'local';
      if (!machine || this.unseen.has(actorId)) continue;
      if (!roadMachineModule(module)) continue;
      // The picture it hangs under goes with what of the view is in it (destroyMesh): the rest of the view goes too.
      if (machine.view?.destroyed) { machine.view.destroy(); machine.view = null; }
      const item = this.drawables.get(module.id);
      if (!machine.shown || !item) { if (machine.view) machine.view.visible = false; continue; }
      const view = machine.view ??= new RoadMachineView(module.kind), guards = this.actorLayer(actorId, 'guards')!;
      if (view.under.parent !== item.group) item.group.addChildAt(view.under, 0);
      if (view.over && view.over.parent !== guards) guards.addChild(view.over);
      if (machine.metal !== (module.metal ?? 'steel')) { machine.metal = module.metal ?? 'steel'; machine.paint = metalPaint(metalOf(module).look); }
      const rig = machine.rig!, pose = machine.pose!, W = module.width, H = module.height, eased = smoothstep(machine.lowered!), paint = machine.paint!;
      view.visible = true; view.lay(W, H, item.group, item.mesh.tint);
      // stepRoadMachines writes this kind's rig and pose together on the retained machine.
      if (module.kind === 'blade') {
        const blade = rig as MotionBladeRig, held = pose as BladePose, tone = earthTone(this.ground.groundAt?.(machine.at!));
        view.blade(blade, W, H, { textures: machine.parts!, boxes: machine.boxes!, pose: held, earth: machine.making && machine.contact ? smoothstep((machine.lowered! - .6) / .4) : 0,
          phase: machine.lane?.done ?? 0, tone, pixel, paint });
        if (detail && machine.making && machine.contact && machine.lowered! >= 1) this.bladeDust(module, machine, blade, machine.place!, held, tone);
      } else {
        const paver = rig as MotionPaverRig, held = pose as ScreedPose,
          shaken = detail && machine.making ? { ...held, dy: held.dy + shake(machine.time!, paver.s) * eased } : held;
        view.paver(paver, W, H, { textures: machine.parts!, boxes: machine.boxes!, pose: shaken, run: machine.run ?? 0, turn: machine.turn ?? 0, pixel, paint });
        if (detail && machine.making && machine.contact && machine.lowered! >= .9) this.screedSteam(machine, paver, machine.place!, held);
      }
    }
  }
  // How many of something a road machine makes this frame at `rate` a second, what is left over kept for the next.
  roadMachineDue(machine: RenderMachine, name: string, rate: number) {
    const due = ((machine.due ??= {})[name] ?? 0) + rate * machine.dt!, count = Math.floor(due);
    machine.due[name] = due - count; machine.random ??= new Random(Math.floor(machine.time! * 1e3) >>> 0);
    return count;
  }
  // Off the heel of a blade grading, as its vehicle drives, the loose earth it leaves and a little dust; off its toe the
  // clods that fall off the roll of earth ahead of it.
  bladeDust(module: DrawingModule, machine: RenderMachine, rig: MotionBladeRig, place: RoadPlace, pose: BladePose, tone: ReturnType<typeof earthTone>) {
    const vehicle = this.scene!.frame.actors.get(module.actorId || 'local')?.vehicle, speed = Math.abs(vehicle?.vx ?? 0);
    if (!(speed > .05)) return;
    const way = Math.sign(vehicle!.vx!), pace = Math.min(1.5, speed), heel = pose.surface![0]!, toe = pose.surface!.at(-1)!,
      heelDown = biting(pose, heel), toeDown = biting(pose, toe), world = (p: Point) => place.world(p.x, p.y),
      back = heelDown ? world(earthFoot(pose, heel)) : null, front = toeDown ? world(earthFoot(pose, toe)) : null,
      clods = this.roadMachineDue(machine, 'clods', heelDown ? 10 * pace : 0), dust = this.roadMachineDue(machine, 'dust', heelDown ? 3 * pace : 0),
      roll = this.roadMachineDue(machine, 'roll', toeDown ? 4 * pace : 0), r = machine.random;
    for (let i = 0; i < clods; i++) this.effects.add('dust', { x: back!.x + r!.range(-.05, .05), y: back!.y + .03,
      vx: -way * r!.range(.2, .9), vy: r!.range(.5, 1.5), size: r!.range(.02, .05) * rig.s, life: r!.range(.35, .7), tint: r!.next() < .5 ? tone.color : tone.top, opacity: .9 });
    for (let i = 0; i < dust; i++) this.effects.add('smoke', { x: back!.x - way * r!.range(0, .3), y: back!.y + .1,
      vx: -way * r!.range(.2, .6), vy: r!.range(.05, .2), size: r!.range(.25, .45) * rig.s, life: r!.range(1.2, 2), grow: .4, drag: 1.8, lift: .14, fadeIn: .1,
      opacity: .16, tint: tone.dust, aspectX: 1.65, aspectY: .58, rotation: 0, spin: .06 });
    for (let i = 0; i < roll; i++) this.effects.add('dust', { x: front!.x + way * r!.range(.02, .12) * rig.s, y: front!.y + .08 * rig.s,
      vx: way * r!.range(.1, .4), vy: r!.range(.3, .8), size: r!.range(.015, .03) * rig.s, life: r!.range(.3, .55), tint: r!.next() < .5 ? tone.color : tone.top, opacity: .9 });
  }
  // The steam off the hot mix a paver's screed leaves behind it.
  screedSteam(machine: RenderMachine, rig: MotionPaverRig, place: RoadPlace, pose: ScreedPose) {
    const steam = this.roadMachineDue(machine, 'steam', 5), r = machine.random;
    for (let i = 0; i < steam; i++) {
      const behind = screedPoint(rig, pose, { x: rig.screed.x0 - r!.range(.05, .6) * rig.s, y: rig.screed.foot }), p = place.world(behind.x, behind.y);
      this.effects.add('smoke', { x: p.x, y: this.ground.height(p.x) + .03, vx: r!.range(-.1, .1), vy: r!.range(.15, .35), size: r!.range(.16, .28) * rig.s,
        life: r!.range(1.4, 2.4), grow: .45, lift: .35, drag: 1.2, fadeIn: .3, opacity: r!.range(.28, .38), tint: 0xe6e7e2 });
    }
  }
  drawArmament(state: RendererDrawing, parts = true) {
    for (const module of parts ? state.modules : []) {
      if (module.kind !== 'weapon') continue;
      if (this.unseen.has(module.actorId || 'local') && !this.actorLayers.get(module.actorId || 'local')?.markGun) { this.weaponArt.retain(module.id); continue; }
      const gunGraphics = this.actorLayer(module.actorId, 'gun')!;
      const launcher = this.scene!.pose(module.id, 'module')!;
      if (!observedWeapon(launcher)) continue;
      const angle = launcher.barrelAngle, preset = launcher.weaponPreset || 'rh120',
        paint = this.weaponPaint, recoil = this.weaponRecoil.get(module.id)?.value || 0;
      paint.recoil = recoil; paint.alpha = module.health! > 0 ? 1 : 0.8; paint.tint = componentTint(module);
      paint.feed = this.feedPose(module, preset); paint.spin = this.weaponSpin.get(module.id) ?? null;
      this.weaponArt.place(module.id, this.actorLayer(module.actorId, 'gunArt')!, launcher, angle, preset, paint);
      // A tube hot enough to glow does so over its paint, as it recoils: an enemy sees it too (server/fog.ts).
      const glow = barrelGlow(module.barrelTemperature), tube = launcher.materialPolygons?.[1];
      if (glow && tube) {
        const c = Math.cos(angle), s = Math.sin(angle);
        gunGraphics.poly(tube.flatMap(p => [launcher.x + (p.x - recoil) * c - p.y * s, launcher.y + (p.x - recoil) * s + p.y * c])).fill(glow);
      }
      // From a lower heat the air it warms shimmers over it (heat-haze.ts): its tube is told along its upper side.
      if (tube && (module.barrelTemperature ?? 0) >= BARREL_SHIMMER) {
        const c = Math.cos(angle), s = Math.sin(angle), xs = tube.map(p => p.x), ys = tube.map(p => p.y),
          from = Math.min(...xs) - recoil, to = Math.max(...xs) - recoil, low = Math.min(...ys), high = Math.max(...ys), side = c >= 0 ? high : low,
          motion = this.scene!.actor(module.actorId);
        this.hotBarrels.push({ id: module.id, actorId: module.actorId || null,
          x0: launcher.x + from * c - side * s, y0: launcher.y + from * s + side * c, x1: launcher.x + to * c - side * s, y1: launcher.y + to * s + side * c,
          diameter: high - low, temperature: module.barrelTemperature!, air: airTemperature(launcher.y), vx: motion?.vx ?? 0, vy: motion?.vy ?? 0 });
      }
      if (module.barrelMarks) for (const mark of module.barrelMarks) {
        const x = launcher!.x + (mark.x - recoil) * Math.cos(angle) - mark.y * Math.sin(angle),
          y = launcher!.y + (mark.x - recoil) * Math.sin(angle) + mark.y * Math.cos(angle);
        roundShape(gunGraphics, x, y, mark.radius).fill({ color: 0x141e16, alpha: .85 });
      }
    }
  }
  // The ready rounds of a gun with a compartment for them (weapons.ts `weaponCompartment`), as they stand this frame: what
  // its frame says it holds (`loaded`; none said, full), followed into the places its drum or belt has gone forward.
  feedPose(module: DrawingModule, preset: WeaponId): WeaponFeedPose | null {
    const compartment = weaponCompartment(preset);
    if (!compartment) { this.weaponFeed.delete(module.id); return null; }
    const motion = followFeed(this.weaponFeed.get(module.id), module.loaded, { kind: compartment.kind, rounds: compartment.rounds, chambers: feedChambers(preset) });
    motion.seen = this.frameNow; this.weaponFeed.set(module.id, motion);
    return { places: motion.places, turned: motion.turned, loaded: motion.loaded, chambers: motion.chambers, cut: Boolean(module.beltCut) };
  }
  drawBodyPanels(state: RendererDrawing, alpha: number, previous: RendererDrawing | null = this.previous) {
    const used = new Set(), arched = this.arched = new Map(), feet = this.hullFeet = new Map(),
      surfaces = bodyPanelSurfaces(state, this.mode === 'edit' ? this.designFaces : null, previous, alpha, this.scene!, this.unseen);
    for (const [index, observed] of surfaces.entries()) {
      if (this.unseen.has(observed.actorId || 'local')) {
        const kept = (observed.actorId || 'local') + ':' + (observed.id ?? index);
        used.add(kept);
        for (const key of this.hullSprites.get(kept)?.textureKeys || []) this.usedTextures.add(key);
        continue;
      }
      // The producer omits artwork only for the same unseen identities handled above.
      const surface = observed as PaintedBodyPanel;
      const asked = this.asked = [], id = (surface.actorId || 'local') + ':' + (surface.id ?? index);
      // Reuse a sprite instead of rebuilding a textured Graphics command each
      // frame. Transient hull textures never enter Pixi's global Graphics bind-
      // group cache, so repainting/restoring can release them cleanly.
      let sprite = this.hullSprites.get(id);
      if (!sprite || sprite.destroyed) { sprite = new Sprite(); this.hullSprites.set(id, sprite); }
      // The skin is laid over the outline as it is now; while editing holds its bitmap, a flat preview has that outline.
      // Seen from outside it reaches the outer faces of the plates; cut open, the plates stand in section over it.
      const outside = this.closed.has(surface.actorId!), side = outside ? 'outside' : 'inside', fitted = this.fitted(sprite, surface, state, side),
        outline = outside ? this.outerOutline(sprite, surface, fitted.scene.rooms) : surface.artPolygon,
        inside = !outside && !fitted.scene.cast;
      // outerOutline already replaces its record when the geometry changes; movement keeps it.
      if (outside && (fitted.outer !== sprite.outer || fitted.paint !== surface.paint)) {
        fitted.outer = sprite.outer; fitted.paint = surface.paint;
        fitted.shape = hullArtwork(outline, surface.paint, side, fitted.key);
      }
      const shape = outside ? fitted.shape! : hullArtwork(outline, surface.paint, side, inside ? '' : fitted.key);
      // The metal inner wall is independent of its equipment. Keep its current fittings apart from the
      // shared bitmap: a moving fitting or a translated room must not repaint that wall or move twice.
      const currentLayout = inside || this.mode === 'edit',
        layoutKey = shape!.key + ':' + shape!.left + ':' + shape!.bottom + ':' + (this.weatheringMaps?.id ?? 0);
      if (currentLayout && fitted.art?.key !== layoutKey) fitted.art = {
        key: layoutKey, painted: shape, layout: hullLayout(outline, fitted.scene),
      };
      let laid: HullLayout | null = null;
      const letteringMirror = outside && fitted.lettering && this.camera.turn < 0,
        textureKey = shape!.key + ':' + (this.weatheringMaps?.id ?? 0) + (letteringMirror ? ':letters-mirror' : ''), entry = this.progressiveTexture(textureKey, () => {
        laid = currentLayout ? fitted.art!.layout : hullLayout(outline, fitted.scene);
        return { type: 'hull', shape, layout: laid, options: { paint: surface.paint, letteringMirror } };
      }, { place: 'hull:' + id + ':' + side, defer: !inside });
      if (laid) Object.assign(entry, { layout: laid, painted: shape });
      const details = currentLayout ? fitted.art! : entry as RenderTextureEntry & {layout: HullLayout;painted: HullArtwork}, preview = this.mode === 'edit' && entry.key !== textureKey;
      const base = entry.texture, pose = surface.artPose || { x: 0, y: 0, angle: 0 }, c = Math.cos(pose.angle), s = Math.sin(pose.angle);
      const damage = surface.marks!.length ? hullImpactLayout(shape, pose, surface.marks) : null, impactSource = this.impactSource,
        texture = damage ? this.paintedTexture('hull-damage:' + id, base, paintRevision(entry, damage.revision),
          ctx => paintHullImpacts(ctx, shape, damage.impacts, impactSource)) : base;
      const layer = this.actorLayer(surface.actorId, outside ? 'outerSkin' : 'hullSkins')!;
      if (sprite.parent !== layer) layer.addChild(sprite);
      sprite.texture = texture; sprite.visible = !preview; sprite.width = shape!.width; sprite.height = shape!.height;
      sprite.scale.y = -Math.abs(sprite.scale.y); sprite.rotation = pose.angle;
      sprite.position.set(pose.x + c * shape!.left - s * (shape!.bottom + shape!.height),
        pose.y + s * shape!.left + c * (shape!.bottom + shape!.height));
      this.drawFittings(sprite, layer, details, shape, pose, surface.paint, id, damage, impactSource);
      this.asked = null; fitted.textureKeys = asked;
      sprite.textureKeys = Object.values(sprite.fitted!).flatMap(face => face!.textureKeys || []);
      for (const key of sprite.textureKeys) this.usedTextures.add(key);
      // Where the world has its feet, for the deck they stand on, and seen cut open the axles it stands over, which have no
      // fender (drawChassis): on the skin of now, as its fittings are.
      const owner = surface.actorId || 'local', sx = shape!.width / details!.painted!.width, sy = shape!.height / details!.painted!.height,
        world = (u: number, v: number) => { const x = shape!.left + (u - details!.painted!.left) * sx, y = shape!.bottom + (v - details!.painted!.bottom) * sy;
          return { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y }; };
      if (!arched.has(owner)) { arched.set(owner, []); feet.set(owner, []); }
      if (!outside) for (const arch of details!.layout!.arches) arched.get(owner).push(...arch.over.map(x => world(x, arch.y)));
      for (const foot of details!.layout!.feet) feet.get(owner).push([world(foot.x0, foot.y), world(foot.x1, foot.y)]);
      used.add(id);
      this.drawHullEdges(sprite, owner, shape, pose, outside, fitted.scene.rooms);
      // A retained bitmap is not the current outline. Its simple preview stays until the requested art is ready,
      // including a short drag released before the normal art interval has elapsed.
      const previewPaint = preview && fitted.scene.cast
        ? hullBaseTone(surface.paint, true).reduce((rgb, v) => rgb * 256 + Math.round(v), 0) : surface.paint;
      if (outside && !preview) { if (sprite.rim) sprite.rim.visible = false; }
      else this.drawPanelRim(sprite, preview ? layer : this.actorLayer(surface.actorId, 'bodyPanels')!, shape, pose, preview ? previewPaint : null);
    }
    for (const [id, sprite] of this.hullSprites) if (!used.has(id)) {
      destroyHull(sprite); this.hullSprites.delete(id);
    }
  }
  // The outline of a face seen from outside, out to the outer faces of the plates of its construction (hull-details.ts
  // `outerFace`), each the two ends of its middle line and half its thickness in the frame of the outline: where the
  // frame has them, on the vehicle where the frame has it, and not as a picture between two frames draws them, which for
  // a construction just turned about (its plates new, the vehicle drawn from where it stood) sets them astray of the
  // outline; a construction fixed in its place has no vehicle, and its faces are told from where it stands (`artPose`,
  // physics.ts `buildAssembly`); the faces of the bench are in the frame of the design. It is worked out again only
  // when the outline, its other rooms (`rooms`), or the plates the construction holds and where they sit to the
  // centimetre (as near as a plate lies along an edge) are not those it was worked out for (`sprite.outer`): one worked
  // out with a plate astray, which leaves the plate showing under the skin, is mended once the plate is back. A plate one
  // sees through (`transparent`, armoured glass) is not painted over: the skin stays at its middle, and the glass shows
  // out of it.
  outerOutline(sprite: HullSprite, surface: PaintedBodyPanel, rooms: readonly (readonly Point[])[]) {
    const polygon = surface.artPolygon, body = surface.artPose && (this.scene!.frame.actors.get(surface.actorId || 'local')?.vehicle || surface.artPose),
      plates = (this.scene!.frame.actorParts.get(surface.actorId || 'local') || []).filter((part): part is Extract<DrawingPart, {type:'plate'}> => part.type === 'plate' && Boolean(part.data.definition)
        && !part.data.definition.chassis && !armourMaterials[part.data.material]?.transparent
        && part.data.attached !== false && !('detached' in part.data && part.data.detached) && !('fragment' in part.data && part.data.fragment)).map(part => {
        const { x, y, angle, length, thicknessMm } = part.data.definition, c = Math.cos(angle), s = Math.sin(angle),
          end = (k: number) => { const point = { x: x + c * length / 2 * k, y: y + s * length / 2 * k }; if (!body) return point; const { u, v } = worldToLocal(body as Pose, point); return { x: u, y: v }; };
        return { a: end(-1), b: end(1), half: thicknessMm / 2000 };
      }),
      sits = plates.flatMap(({ a, b, half }) => [Math.round(a.x * 100), Math.round(a.y * 100), Math.round(b.x * 100), Math.round(b.y * 100), half]),
      kept = sprite.outer;
    if (kept?.rooms === rooms.length && kept.sits.length === sits.length && kept.sits.every((v, i) => v === sits[i])
      && kept.polygon.length === polygon!.length && kept.polygon.every((p, i) => p.x === polygon![i]!.x && p.y === polygon![i]!.y)) return kept.points;
    return (sprite.outer = { rooms: rooms.length, sits, polygon: polygon!.map(p => ({ x: p.x, y: p.y })), points: outerFace(polygon, plates, rooms) }).points;
  }
  // What the fittings of a face are placed by, for the side it is seen from, and the key it is told apart by. A face of
  // the field is asked once (`settled`); one of the bench again when the design changes.
  fitted(sprite: HullSprite, surface: PaintedBodyPanel, state: RendererDrawing, side: 'inside' | 'outside'): FittedFace {
    const kept = (sprite.fitted ??= {})[side];
    if (kept && (surface.settled || kept.state === state)) return kept;
    const scene = { ...surface.fittings(side === 'outside' ? this.covered : null), side }, key = 'f' + hashText(JSON.stringify(scene));
    return sprite.fitted[side] = kept?.key === key ? { ...kept, state } : { scene, key, state, lettering: Boolean(scene.details?.some(d => d.kind === 'number')) };
  }
  // The fittings of a hull, each a picture of its own, laid where the layout of the skin it shows put them: on the skin
  // last painted they stand as it is stretched to the outline of now. A fitting a mark of the hull falls on shows the mark
  // too. From afar, where the smallest would be a pixel, none is shown, and none is painted that was not.
  drawFittings(sprite: HullSprite, layer: Container, entry: {layout: HullLayout;painted: HullArtwork}, shape: HullArtwork, pose: Pose, paint: number, id: string, damage: ReturnType<typeof hullImpactLayout> | null, impactSource: (kind:string,variant:number)=>CanvasImageSource) {
    const layout = entry.layout, painted = entry.painted;
    let fittings = sprite.fittings;
    if (!fittings || fittings.destroyed) fittings = sprite.fittings = new Container<FittingSprite>();
    if (fittings.parent !== layer) layer.addChild(fittings);
    if (fittings.layout !== layout) {
      for (const child of fittings.removeChildren()) child.destroy();
      for (const fitting of layout.fittings) {
        const child = fittings.addChild(Object.assign(new Sprite(), { fitting, key: `hull-fitting:${fitting.kind}:${fitting.w}x${fitting.h}:${paint}:${fitting.count ?? ''}:${fitting.text ?? ''}:${this.weatheringMaps?.id ?? 0}` })); child.anchor.set(.5);
      }
      fittings.layout = layout;
    }
    const seen = this.camera.zoom >= FITTINGS_ZOOM, sx = shape.width / painted.width, sy = shape.height / painted.height;
    fittings.visible = seen; fittings.position.set(pose.x, pose.y); fittings.rotation = pose.angle;
    for (const [i, child] of fittings.children.entries()) {
      const fitting = child.fitting;
      if (!seen && !this.textures.has(child.key)) continue;
      let texture = this.texture(child.key, () => createFittingTexture(fitting, paint, this.weatheringMaps)).texture;
      // Where it stands on the skin of now, in the frame of the hull and in that of the skin's picture.
      const x = shape.left + (fitting.x - painted.left) * sx, y = shape.bottom + (fitting.y - painted.bottom) * sy,
        hits = damage && fittingImpacts(damage.impacts, { x: x - shape.left, y: shape.height - (y - shape.bottom), w: fitting.w, h: fitting.h, flip: fitting.flip });
      if (hits?.length) texture = this.paintedTexture(`hull-fitting-damage:${id}:${i}`, texture, damage!.revision, ctx =>
        paintHullImpacts(ctx, { width: fitting.w, height: fitting.h }, hits, impactSource));
      // A fitting with a front is turned about on a hull that faces right; the number of a vehicle reads the right way
      // on a board drawn turned about.
      const turned = fitting.flip !== (fitting.kind === 'number' && this.camera.turn < 0);
      child.texture = texture; child.position.set(x, y);
      child.scale.set(fitting.w / texture.width * (turned ? -1 : 1), -fitting.h / texture.height);
    }
  }
  // The sampled scene serves artwork, selection, sectors and servo guides. The primary collision forecast reads the snapshot.
  sceneFor(state: DrawingScene) {
    return this.scene?.frame.source === state ? this.scene : sampleScene(state, this.previous, this.mode === 'edit' ? 1 : this.presentationAlpha ?? 1);
  }
  // The flight of a round the gun in hand would fire now at the aim. A gun on no construction is not in hand: the one
  // the test of armour is struck with goes along a line drawn (main.ts).
  aimingSolution(state: RendererDrawing | null = this.mode === 'test' ? this.presentedState || this.state : this.designState) {
    return this.aimQueries.solution(state, this.weapon, this.aim, this.mode === 'test');
  }
  // The guns switched on to fire along with the one in hand (ui-model.ts), each with the arc its round would take
  // now: from its own muzzle, at the bearing its barrel has, with its own loadout. An arc is out of date when the aim
  // or the loadout is another, or the gun has moved: its barrel by a hundredth of a degree, the gun by two
  // centimetres, its motion by a tenth of a metre a second. A frame works out one arc at most, that of the gun that
  // has waited longest for it; a gun with none yet has none drawn. With no gun in hand, none fires along with it.
  linkedArcs(state: RendererDrawing | null = this.presentedState || this.state) {
    const kept = this.linkedKept ??= new Map(), weapon = this.weapon;
    if (!state || this.mode !== 'test' || weapon?.platform !== 'vehicle' || !weapon.componentId) { kept.clear(); return []; }
    const actorId = state.controlledActor || 'local', modules = state.modules.filter(m => m.actorId === actorId),
      scene = this.sceneFor(state), guns = linkedArmament(this.view, modules, weapon), waited = (arc: LinkedArc | undefined) => arc?.made ?? 0;
    for (const id of kept.keys()) if (!guns.some(gun => gun.componentId === id)) kept.delete(id);
    let due = null;
    for (const { componentId, ...load } of guns) {
      const pose = scene.pose(componentId, 'module')!;
      if (!observedWeapon(pose)) continue;
      const settings = resolveArmament({ platform: 'vehicle', componentId, ...load }, modules, true),
        inherited = presentedPivotVelocity(scene.actor(pose!.actorId || 'local'), pose) ?? { x: 0, y: 0, omega: 0 },
        asked = JSON.stringify([this.aim, settings]), arc = kept.get(componentId), at = arc?.at;
      const current = arc && arc.asked === asked && Math.hypot(pose!.x - at!.x, pose!.y - at!.y) <= .02 &&
        Math.abs(angleDifference(pose!.barrelAngle, at!.barrelAngle)) <= 2e-4 && Math.abs(angleDifference(pose!.angle, at!.angle)) <= 2e-4 &&
        Math.hypot(inherited.x - at!.vx, inherited.y - at!.vy) <= .1 && Math.abs(Number(inherited.omega) - Number(at!.omega)) <= .01;
      if (!current && !(due && waited(kept.get(due.componentId)) <= waited(arc))) due = { componentId, pose, settings, inherited, asked };
    }
    if (due) {
      const { componentId, pose, settings, inherited, asked } = due, solution = mountedFiringSolution(pose, this.aim, settings, inherited);
      kept.set(componentId, { asked, solution, path: flightPath(solution), made: this.linkedMade = (this.linkedMade ?? 0) + 1,
        at: { x: pose!.x, y: pose!.y, angle: pose!.angle, barrelAngle: pose!.barrelAngle, vx: inherited.x, vy: inherited.y, omega: inherited.omega } });
    }
    // A gun that goes fast is metres on from where the frame that worked out its arc drew it: the arc is drawn (`drawn`) from
    // where this frame draws its muzzle, the move fading out to where the round comes level with the aim (`movedPath`).
    return guns.flatMap(({ componentId }) => {
      const arc = kept.get(componentId);
      if (!arc) return [];
      const start = arc.path[0]!, mouth = carried(start, arc.at, scene.pose(componentId, 'module')!, weaponAngle);
      arc.drawn = movedPath(arc.path, arc.solution.time, { x: mouth.x - start!.x, y: mouth.y - start!.y }, STILL, arc.drawn);
      return [arc];
    });
  }
  // What keeps the gun in hand from firing, as the core keeps it (`launch`): its mouth in material or in the ground, or
  // the vehicle it is on as the first thing its round would meet (`own`).
  weaponObstruction(state: RendererDrawing | null = this.mode === 'test' ? this.presentedState || this.state : this.designState, solution = this.aimingSolution(state)) {
    return this.aimQueries.obstruction(state, solution, this.weapon, this.ground);
  }
  // The ally of the vehicle in hand that a round fired now meets first, if one is: the round harms nothing of it, and
  // its armour stops what it stops of anyone's (`Sides`, game_projectiles.rs).
  allyInLine(state: RendererDrawing | null = this.mode === 'test' ? this.presentedState || this.state : this.designState, solution = this.aimingSolution(state)) {
    return this.aimQueries.ally(state, solution, this.weapon);
  }
  // The selected gun belongs to the controlled vehicle, including in private tests.
  // A construction without one never borrows a target's gun for its forecast.
  launcherOf(state: RendererDrawing) {
    return selectedLauncher(state, this.weapon);
  }
  // What the predictions of a shot read the scene by: made again only for another state, which also asks the impact anew.
  predictionScene(state: DrawingScene) {
    return this.aimQueries.scene(state);
  }
  impactPrediction(state: RendererDrawing | null = this.mode === 'test' ? this.presentedState || this.state : this.designState, solution = this.aimingSolution(state)) {
    return this.aimQueries.impact(state, solution, this.weapon);
  }
  // How far this frame draws the ends of a forecast from where the snapshot it was solved against has them, for the overlay
  // to draw it moved so (weapon-presentation.ts `AimPresentation`): the muzzle goes with the gun as the frame draws it, and
  // the place the round meets a construction with the piece it meets there; the ground stays where it is. Nothing, when
  // the frame does not draw the gun, or nothing moved. The pieces are read from the snapshot of the forecast, not from what
  // the forecast holds of them: the index of the predictions is refitted to every new snapshot, records and all.
  forecastShift(forecast: AimForecast) {
    const frame = sceneFrame(forecast.state), gun = forecast.gun && frame.get(forecast.gun, 'module'), shown = gun && this.scene?.pose(gun.id);
    if (!shown) return null;
    const met = forecast.impact?.owner, piece = met && met.type !== 'ground' ? frame.get(met.id, met.type) : null,
      drawn = piece && this.scene!.pose(piece.id), start = forecast.path[0], end = forecast.path.at(-1),
      mouth = carried(start!, gun!, shown, weaponAngle), contact = drawn ? carried(end!, piece && 'definition' in piece ? piece.definition : piece!, drawn) : end!,
      from = { x: mouth.x - start!.x, y: mouth.y - start!.y }, to = { x: contact!.x - end!.x, y: contact!.y - end!.y };
    return Math.hypot(from.x, from.y) + Math.hypot(to.x, to.y) > 1e-9 ? { from, to } : null;
  }
  // The vehicle under the aim, if it moves, and where it will be when a round fired now arrives:
  // the place to aim at. The aim stays tied to it on the way from the one to the other. It is
  // where the frame draws it, as the aim is put on it: not where the snapshot has it, metres on at speed.
  movingTarget(state: RendererDrawing, flight: number) {
    const own = state.controlledActor || 'local', reach = Math.max(10, 48 / this.camera.zoom), aim = this.aim,
      // On the shared field the side is the faction: friends and wrecks are led by nobody.
      faction = state.actors?.find(actor => actor.id === own)?.team, scene = this.sceneFor(state);
    let best = null;
    for (const actor of state.actors || []) {
      const body = actor.vehicle && (scene.actor(actor.id) || actor.vehicle);
      if (!body || actor.id === own || actor.defeated || faction != null && actor.team === faction || !(Math.hypot(Number(body.vx), Number(body.vy)) > .5)) continue;
      const to = { x: body.x! + body.vx! * flight, y: body.y! + body.vy! * flight },
        distance = Math.min(Math.hypot(aim.x - body.x!, aim.y - body.y!), Math.hypot(aim.x - to.x, aim.y - to.y));
      if (distance < reach && !(best?.distance! < distance)) best = { distance, from: body as typeof body & Point, to };
    }
    return best;
  }
  // The base of the player's faction on the shared field: an installation over the ground it covers, with the
  // flag of the faction on it (`flown`). Its works stand behind the ground line, among the scenery; the band along its
  // ground lies behind the vehicles. It is drawn again only when the base, its flag, the ground or the scale of the view
  // is another: a frame places the label, and draws what moves of the watch the base keeps — the aerial of its
  // radar, which turns, and the words that watch has just had of a gun (`pulses`: faction-ui.ts) — while the base is in the view.
  drawBase(base: BaseFootprint | null | undefined, flown: FactionFlag | undefined, pulses: readonly BaseWatchPulse[]) {
    if (!this.baseArt) {
      if (!base) return;
      this.baseArt = new Graphics(); this.world.addChildAt(this.baseArt, this.world.getChildIndex(this.shadows));
      this.baseWorks = this.terrainScene.layers.works.addChild(new HazedGraphics()); this.watchPieces = this.terrainScene.layers.works.addChild(new Container<Sprite | Aerial>());
      this.watchPieces.addChild(new Sprite(), aerialMeshes(WATCH_RADAR.width, WATCH_RADAR.height, aerialBearing('base')), new Sprite(), new Sprite(), new Sprite());
      this.baseWatch = this.terrainScene.layers.works.addChild(new Graphics());
      this.baseLabel = this.baseLabelFor('Base', 0xcfe3a8);
    }
    this.baseArt.visible = this.baseWorks!.visible = this.baseLabel!.visible = Boolean(base);
    this.baseWatch!.visible = Boolean(base) && Math.abs(base!.x - this.camera.x) <= this.camera.width / this.camera.zoom / 2 + base!.radius;
    this.watchPieces!.visible = this.baseWatch!.visible && 1 / this.camera.zoom < .5;
    if (!base) return;
    const zoom = this.camera.zoom;
    this.baseDrawn = this.drawnBase(this.baseDrawn, this.baseWorks!, this.baseArt, base, flown!);
    placeBaseLabel(this.baseLabel!, this.baseDrawn.flag, zoom);
    if (this.baseWatch!.visible) drawBaseWatch(anchorGraphics(this.baseWatch!, base.x, 0), base, this.ground, 1 / zoom, pulses);
    if (this.watchPieces!.visible) this.drawWatchPieces(base, this.ground, 1 / zoom);
  }
  // The art of a base (base-art.ts) in `works` and `front`, as it was drawn (`drawn`) or drawn again when the base, its flag
  // (`flown`), the ground or the scale of the view is another. Both drawings stand at the base and count from there.
  drawnBase(drawn: DrawnBase | null | undefined, works: HazedGraphics, front: Graphics, base: BaseFootprint, flown: FactionFlag, color?: number, watch = true): DrawnBase {
    const ground = this.ground, scale = 2 ** (Math.round(Math.log2(this.camera.zoom) * 3) / 3), texture = this.flagTexture(flown),
      banner = JSON.stringify(flown) + (texture ? '' : '…');
    if (drawn && drawn.ground === ground && drawn.x === base.x && drawn.radius === base.radius && drawn.facing === base.facing &&
      drawn.scale === scale && drawn.banner === banner) return drawn;
    for (const made of [works, front]) anchorGraphics(made, base.x, 0);
    return { ground, x: base.x, radius: base.radius, facing: base.facing, scale, banner, flag: drawBaseArt(works, front, base, ground, 1 / scale, flown, texture, color, watch, this.baseMaterials) };
  }


  // The place being chosen for a post (post-placement.ts): where it would stand, how it would face and whether the field
  // would refuse it there (`refused`), or nothing.
  previewPost(post: SitePostPreview | null = null) { this.siteMarkers.previewPost(post); }
  baseLabelFor(text: string, fill: ColorSource) {
    const label = this.world.addChild(fieldWords(text, fill, 13, '600')); label.anchor.set(.5, 1); return label;
  }
  // The radar and the microphones the base keeps watch with are a vehicle's, the radar at the size of a base's: its
  // turntable on the top of its mast and its aerial turning over it, each microphone on the head of its stake. From afar,
  // where they would be dots, the radar is left out, and the microphones sooner.
  drawWatchPieces(base: BaseFootprint, ground: Terrain, pixel: number) {
    const pieces = this.watchPieces!, post = watchPosts(base, ground), { width, height } = WATCH_RADAR, sensor = (look: Pick<PaintedSynthetic, 'width' | 'height' | 'sensorMode'>) => this.moduleTexture({ kind: 'sensor', ...look }),
      stand = (sprite: Sprite, look: Pick<PaintedSynthetic, 'width' | 'height' | 'sensorMode'>, x: number, y: number) => {
        sprite.texture = sensor(look); sprite.anchor.set(.5, 1); sprite.position.set(x, y);
        sprite.width = look.width; sprite.height = look.height; sprite.scale.y = -Math.abs(sprite.scale.y);
      };
    stand(pieces.children[0] as Sprite, { sensorMode: 'radar', width, height }, post.radar.x, post.radar.y);
    const aerial = pieces.children[1] as Aerial;
    aerial.position.set(post.radar.x, post.radar.y + height / 2 + aerial.radar.shape.y);
    this.placeAerial(aerial, aerial.radar.bearing + this.frameNow / 1000 * AERIAL_TURN, 0xffffff);
    for (const [i, ear] of post.ears.entries()) {
      const sprite = pieces.children[2 + i] as Sprite;
      sprite.visible = pixel < .1;
      if (sprite.visible) stand(sprite, { sensorMode: 'sound', width: MODULES.sensor.width, height: MODULES.sensor.height }, ear.x, ear.y);
    }
  }
  // The bases of others the player's faction knows of on the shared field (`bases`, as the field last told it of them:
  // where each stood when last seen, and whose it is; nothing off that field), each drawn as its own base is, in the
  // colour of an enemy and under the flag of the faction it is of, with a label that names it and says whether it is
  // sheltered while its faction is away (server/room.ts, `shelter`). What a base keeps watch with is its own faction's,
  // and is not drawn. One the faction does not have in sight now stands paler, as it was last
  // seen. Only a base about the view is shown; each is drawn again only when it, its flag, the ground or the scale of the
  // view is another, and a base the faction no longer knows is let go.
  drawForeignBases(bases: FactionView['bases'] | null | undefined) {
    const known = this.foreignBases ??= new Map(), camera = this.camera, zoom = camera.zoom, half = camera.width / zoom / 2, shown = new Set();
    for (const [id, art] of known) {
      if (bases && !bases.some(base => base.id === id)) { art.works.destroy(); art.front.destroy(); art.label.destroy(); known.delete(id); }
    }
    for (const base of bases ?? []) {
      if (Math.abs(base.x - camera.x) > half + base.radius + BASE_VIEW) continue;
      let art = known.get(base.id);
      if (!art) {
        const works = this.terrainScene.layers.works.addChild(new HazedGraphics()), front = new Graphics();
        this.world.addChildAt(front, this.world.getChildIndex(this.shadows));
        art = { works, front, drawn: null, label: this.baseLabelFor('', FOREIGN_LABEL) };
        known.set(base.id, art);
      }
      art.drawn = this.drawnBase(art.drawn, art.works, art.front, base, base.flag, FOREIGN_BASE, false);
      const name = 'Base · ' + factionName(base) + (base.sheltered ? ' · protegida' : '');
      if (art.label.text !== name) art.label.text = name;
      art.works.visible = art.front.visible = art.label.visible = true;
      shown.add(base.id);
      art.works.alpha = art.front.alpha = art.label.alpha = base.seen ? 1 : UNSEEN_BASE;
      placeBaseLabel(art.label, art.drawn.flag, zoom);
    }
    for (const [id, art] of known) if (!shown.has(id)) art.works.visible = art.front.visible = art.label.visible = false;
  }
  get siteBoxes() { return this.siteMarkers.boxes; }
  drawSites(faction: RenderFaction | null | undefined, obstacles: Parameters<SiteMarkers['draw']>[1]) {
    return this.siteMarkers.frame({ world: this.world, worksLayer: this.terrainScene?.layers.works,
      labels: this.labels, shadows: this.shadows, ground: this.ground, camera: this.camera, baseMaterials: this.baseMaterials }).draw(faction, obstacles);
  }
  // The sites of the shared field and the veins the player's faction knows of in them (`veins`, from one end of the
  // ground to the other; nothing off that field), as far as the view and half a kilometre to each side of it
  // (deposit-art.js): every site as the feature of the ground it is, and under one whose vein the faction knows, that
  // vein in the earth as it was last seen, with its workings. A site the faction knows no vein at is drawn from the
  // ground alone, whatever lies in it. Each site is a drawing of its own, counted from the site: its ground, standing
  // behind the ground line among the scenery and lying on it behind the vehicles; and the vein, in the same two and
  // in the earth, over the strata and the band of its first two metres and under their soil and detail. The ground of
  // a site is drawn again only when the ground or the scale of the view is another, and its vein besides when what
  // the faction knows of it looks otherwise (`lookKey`). A vein the faction forgets — it saw the site bare — fades
  // away over `DEPOSIT_FADE` seconds of `now` rather than going at once. The sites are looked over only when the view
  // comes to an end of the stretch laid out or the faction is told anew, and one left out of the stretch is let go. From
  // afar (`DEPOSIT_FAR_STEP`) none is drawn of its own but the drops of supplies, and the posts of the veins are one drawing.
  drawDeposits(veins: readonly KnownVein[] | null, now = performance.now() / 1000, fieldTime?: number) {
    const shown = Boolean(veins);
    updateAirdropDescent(this, veins?.find(vein => vein.type === 'airdrop'), fieldTime!);
    if (!this.depositSites) {
      if (!shown) return;
      this.depositSites = new Map(); this.depositFading = [];
      this.depositWorks = this.terrainScene.layers.works.addChild(new Container());
      this.depositUnder = this.terrain.addChildAt(new Container(), this.terrain.getChildIndex(this.terrainScene.layers.soil));
      this.depositFront = this.world.addChildAt(new Container(), this.world.getChildIndex(this.shadows));
    }
    this.depositWorks.visible = this.depositUnder.visible = this.depositFront.visible = shown;
    // The static deposit cache may return early; its visible package still owns its shared texture this frame.
    if (shown) for (const art of this.depositSites.values()) if (art.loadKey) {
      if (this.textures.has(art.loadKey)) this.usedTextures.add(art.loadKey);
      else { art.drawn!.key = null; this.depositsLaid = null; }
    }
    // The veins forgotten fade on every frame until they are gone; out of the shared field they go at once.
    this.depositFading = this.depositFading.filter(fading => {
      const alpha = shown ? 1 - (now - fading.from) / DEPOSIT_FADE : 0;
      if (alpha > 0 && fading.loadKey) this.usedTextures.add(fading.loadKey);
      for (const made of fading.parts) if (alpha > 0) made.alpha = Math.min(1, alpha); else made.destroy({ children: true, context: true });
      return alpha > 0;
    });
    if (!veins) return;
    const ground = this.ground, camera = this.camera, half = camera.width / camera.zoom / 2, sites = this.depositSites,
      step = Math.round(Math.log2(camera.zoom) * 3), scale = 2 ** (step / 3), far = step <= DEPOSIT_FAR_STEP, laid = this.depositsLaid;
    const inside = laid && laid.ground === ground && laid.scale === scale && camera.x - half >= laid.left && camera.x + half <= laid.right;
    if (inside && laid.veins === veins) return;
    // From afar a site and its vein are a few pixels across, and only the post of a vein known tells anything there: the
    // posts of all the veins known about the view are one drawing, laid out for as much again as the view to each side
    // of it, and of the sites only the drops of supplies are drawn one by one.
    const margin = far ? half : DEPOSITS_REACH, posts = this.depositPosts ??= this.depositWorks.addChild(new HazedGraphics());
    const left = far && inside ? laid.left : camera.x - half - margin, right = far && inside ? laid.right : camera.x + half + margin;
    posts.visible = far;
    let postsKey;
    if (far) {
      const visible = depositsNear(veins, (left + right) / 2, (right - left) / 2 + DEPOSIT_ART_REACH).filter((vein): vein is KnownDeposit => vein.type !== 'airdrop' && Boolean(depositLook(vein)));
      // Stock and reserve updates do not move a survey post. Keep its drawing and coverage until its visible inputs change.
      postsKey = visible.map(site => `${site.x}:${site.material}`).join(';');
      if (!inside || laid.postsKey !== postsKey) drawPosts(anchorGraphics(posts, camera.x, ground.height(camera.x)), visible, ground, 1 / scale);
    }
    const known = new Map(veins.map(vein => [vein.id, vein])), reach = half + margin + DEPOSIT_ART_REACH,
      near = [...far ? [] : depositsNear(depositsOf(ground), camera.x, reach),
        ...depositsNear(veins.filter((vein): vein is KnownAirdrop => vein.type === 'airdrop'), camera.x, reach)];
    for (const site of near) {
      const told = known.get(site.id), look = depositLook(told),
        packageLook = told?.supplies && told.phase === 'collection' ? pileLook(told.supplies) : null,
        key = lookKey(look) + (packageLook ? ':pile:' + [...packageLook.crates, packageLook.cans].join(':') : ''),
        anchor = [site.x, ground.height(site.x)] as const;
      let art = sites.get(site.id);
      if (!art) sites.set(site.id, art = { works: this.depositWorks.addChild(new HazedGraphics()), front: this.depositFront.addChild(new Graphics()), laid: null, vein: null, drawn: null });
      const fresh = art.laid?.ground === ground && art.laid.scale === scale;
      if (!fresh) {
        for (const made of [art.works, art.front]) anchorGraphics(made, ...anchor);
        if (!airdropSite(site)) drawSite(art, site, ground, 1 / scale, this.rockTexture);
        art.laid = { ground, scale };
      } else if (art.drawn!.key === key) continue;
      const vein = art.vein && [...Object.values(art.vein), ...art.load ? [art.load] : []];
      if (!look) {
        if (vein && fresh) this.depositFading.push({ parts: vein, loadKey: art.loadKey, from: now });
        else if (vein) for (const made of vein) made.destroy({ children: true, context: true });
        art.vein = null; art.load = art.loadKey = null; art.drawn = { key, plate: null };
        continue;
      }
      art.vein ??= { works: this.depositWorks.addChild(new HazedGraphics()), under: this.depositUnder.addChild(new Graphics()), front: this.depositFront.addChild(new Graphics()) };
      for (const made of Object.values(art.vein)) anchorGraphics(made, ...anchor);
      if (packageLook) {
        const picture = this.pilePicture(packageLook), size = pileSize(packageLook), foot = airdropFooting(ground, site.x, size.width),
          load = art.load ??= this.depositWorks.addChild(new Sprite());
        art.loadKey = picture.key; load.texture = picture.texture; load.anchor.set(.5, 1);
        load.position.set(site.x, foot); load.width = size.width; load.height = size.height; load.scale.y = -Math.abs(load.scale.y);
      } else if (art.load) { art.load.destroy(); art.load = art.loadKey = null; }
      art.drawn = { key, plate: airdropSite(site) ? drawAirdrop(art.vein, site, look, ground, 1 / scale) :
        drawVein(art.vein, site, look, ground, 1 / scale, this.terrainScene.plan!) };
    }
    const kept = new Set(near.map(site => site.id));
    for (const [id, art] of sites) if (!kept.has(id)) {
      for (const made of [art.works, art.front, ...art.vein ? Object.values(art.vein) : [], ...art.load ? [art.load] : []]) made.destroy({ children: true, context: true });
      sites.delete(id);
    }
    this.depositsLaid = { ground, scale, veins, left, right, postsKey };
  }
  // Only the faction's own cable endpoints are delivered. Missing or remembered
  // actors never turn an attachment point into a view of an unseen construction.
  drawTows(g: Graphics, state: RendererDrawing) {
    const factionId = state.faction?.id;
    if (this.mode !== 'test' || !state.shared || !factionId || !state.tows?.length) return;
    const camera = this.camera, zoom = camera.zoom, halfW = camera.width / zoom / 2 + 4 / zoom,
      halfH = camera.height / zoom / 2 + 4 / zoom,
      known = (id: string) => state.actors.some(actor => actor.id === id && actor.team === factionId && !actor.ghost),
      anchor = (id: string, point: Point | null | undefined) => {
        const body = this.scene!.frame.actors.get(id)?.vehicle, pose = this.scene!.actor(id);
        if (!body || !pose || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        if (typeof body.x !== 'number' || typeof body.y !== 'number' || typeof body.angle !== 'number') return null;
        const local = worldToLocal(body as Pose, point);
        return localToWorld(pose, local.u, local.v);
      };
    // A strand through `points`, or bowed from the first to the second about `bend` (a quadratic curve, in `BOW` straight
    // pieces: the field is in metres, and the curve Pixi would draw would be cut by those into a few).
    const strand = (points: readonly Point[], bend: Point | null = null) => {
      const path = bend ? Array.from({ length: BOW + 1 }, (_, i) => {
        const t = i / BOW, u = 1 - t;
        return { x: u * u * points[0]!.x + 2 * u * t * bend.x + t * t * points[1]!.x, y: u * u * points[0]!.y + 2 * u * t * bend.y + t * t * points[1]!.y };
      }) : points;
      for (const [color, width, alpha] of [[0x18211d, 2.8, .9], [0xb9b8a2, 1.2, .85]] as const) {
        g.moveTo(path[0]!.x, path[0]!.y);
        for (const p of path.slice(1)) g.lineTo(p.x, p.y);
        g.stroke({ color, width: width! / zoom, alpha });
      }
    };
    for (const tow of state.tows) {
      if (!known(tow.actorId) || !known(tow.targetId)) continue;
      const a = anchor(tow.actorId, tow.anchorA), b = anchor(tow.targetId, tow.anchorB);
      if (!a || !b) continue;
      // A sling hangs from the ring over its load on a bridle, from the ends of the beam of its frame (game_towing.rs).
      const legs = tow.sling && Array.isArray(tow.bridle) ? tow.bridle.map(end => anchor(tow.targetId, end)).filter((point): point is Point => point !== null) : [],
        ends = [a, b, ...legs];
      if (Math.max(...ends.map(p => p!.x)) < camera.x - halfW || Math.min(...ends.map(p => p!.x)) > camera.x + halfW ||
          Math.max(...ends.map(p => p!.y)) < camera.y - halfH || Math.min(...ends.map(p => p!.y)) > camera.y + halfH) continue;
      // Native anchors follow the same sampled poses as the chassis. A sling gone slack, as one whose load stands on the
      // ground, bows by what a parabola of its length over the span between its ends sags, square to that span and down —
      // or aside, hanging plumb —; a cable on the ground is drawn straight. This is a visible mark, not a second rope
      // simulation or a pose solver.
      const span = Math.hypot(b.x - a.x, b.y - a.y), sag = tow.sling && span > 1e-3 && span < tow.length ? Math.sqrt(3 * span * (tow.length - span) / 8) : 0,
        down = (b.x - a.x) / span > 0 ? -1 : 1, bow = { x: down * -(b.y - a.y) / span, y: down * (b.x - a.x) / span };
      strand([a, b], sag > .02 ? { x: (a.x + b.x) / 2 + 2 * sag * bow.x, y: (a.y + b.y) / 2 + 2 * sag * bow.y } : null);
      if (legs.length === 2) strand([legs[0]!, b, legs[1]!]);
    }
  }
  // What the faction's sensors hold without seeing it (faction-ui.ts): where a radar has something, a
  // lozenge in a ring as wide as the radar may be off; beside a construction that heard something, arcs
  // on the side it came from; and where the watch of the base places a gun by its fire, a reticle between two
  // brackets as far apart as the place may be off, with a ring that closes on it at each word of the gun.
  // Only the marks in the view are drawn: the drawing is counted from its camera.
  drawContacts(g: Graphics, state: RendererDrawing, time: number) {
    const camera = this.camera, zoom = camera.zoom, halfX = camera.width / zoom / 2 + 30, halfY = camera.height / zoom / 2 + 30, width = 1.4 / zoom;
    for (const mark of contactMarks(state, time, actor => actor.vehicle && (this.scene?.actor(actor.id) || actor.vehicle))) {
      const x = mark.x, y = mark.y ?? this.markHeight(mark.x) + 1.5;
      if (!(mark.alpha > 0) || Math.abs(x - camera.x) > halfX + ('radius' in mark ? mark.radius : 0) || Math.abs(y - camera.y) > halfY) continue;
      if (mark.kind === 'battery') {
        const size = Math.max(11 / zoom, .8), reach = Math.max(mark.radius, size * 2.2), tick = size * .6, color = 0xff8f6b, light = 0xffd9cc;
        g.moveTo(x - reach, y).lineTo(x - size * 1.6, y).moveTo(x + size * 1.6, y).lineTo(x + reach, y)
          .moveTo(x - reach, y - tick).lineTo(x - reach, y + tick).moveTo(x + reach, y - tick).lineTo(x + reach, y + tick).stroke({ color, width, alpha: .75 * mark.alpha });
        g.circle(x, y, size).fill({ color, alpha: .16 * mark.alpha }).stroke({ color: light, width: width * 1.2, alpha: .95 * mark.alpha });
        g.moveTo(x - size * 1.45, y).lineTo(x - size * .4, y).moveTo(x + size * .4, y).lineTo(x + size * 1.45, y)
          .moveTo(x, y - size * 1.45).lineTo(x, y - size * .4).moveTo(x, y + size * .4).lineTo(x, y + size * 1.45).stroke({ color: light, width: width * 1.2, alpha: .95 * mark.alpha });
        if (mark.pulse < 1) g.circle(x, y, size * (1.2 + 3.2 * (1 - mark.pulse))).stroke({ color, width: width * 1.4, alpha: .9 * (1 - mark.pulse) });
      } else if (mark.kind === 'radar') {
        const size = Math.max(7 / zoom, .6);
        g.circle(x, y, Math.max(mark.radius, size * 1.6)).stroke({ color: 0xffb35c, width, alpha: .5 * mark.alpha });
        g.poly([x, y + size, x + size, y, x, y - size, x - size, y]).fill({ color: 0xffb35c, alpha: .28 * mark.alpha })
          .stroke({ color: 0xffd9a3, width, alpha: .9 * mark.alpha });
      } else for (let ring = 1; ring <= 3; ring++) {
        const radius = (8 + ring * 7) / zoom, from = x + mark.side * 4, height = y + 1.5;
        for (let step = 0; step <= 6; step++) {
          const angle = (step / 6 - .5) * 1.2, px = from + mark.side * Math.cos(angle) * radius, py = height + Math.sin(angle) * radius;
          step ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.stroke({ color: 0xcfe3a8, width, alpha: (1 - ring * .2) * mark.alpha });
      }
    }
  }
  // Place labels are current before vehicle labels are placed. Only their visible Text bounds reserve space.
  drawPlaceLabels(state: RendererDrawing, time = state.time ?? 0) {
    const base = this.mode === 'test' && state.faction?.base || null;
    this.drawBase(base, state.faction?.flag, base ? watchPulses(state, base.x, time) : []);
    this.drawForeignBases(this.mode === 'test' ? state.observerBases ?? state.faction?.bases : null);
    const obstacles: VehicleLabelBox[] = [];
    this.drawSites(this.mode === 'test' && state.shared ? state.faction : null, obstacles);
    if (!state.shared) return obstacles;
    for (const label of [this.baseLabel, ...Array.from(this.foreignBases?.values() || [], art => art.label)]) {
      if (!label?.visible) continue;
      const { minX, minY, maxX, maxY } = label.getBounds();
      if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY ||
        maxX < 0 || minX > this.camera.width || maxY < 0 || minY > this.camera.height) continue;
      obstacles.push({ x: (minX + maxX) / 2, y: minY, width: maxX - minX, top: 0, bottom: maxY - minY });
    }
    return obstacles;
  }
  // `time` is the time the frame shows, a little behind that of its state: what goes out with age, or moves, goes by it.
  // The detail in hand (detail-editor.ts) is out of the art of its surface while it is moved, sized or turned, and is drawn
  // here over it, under the marks of the edit, as the art paints it: the art is not painted anew at each step of the hand.
  drawCarriedDetail(carried: DetailEditView['carried'] | null | undefined) {
    if (!carried) { if (Object.hasOwn(this, 'carriedDetail')) this.carriedDetail!.visible = false; return; }
    if (!Object.hasOwn(this, 'carriedDetail') || this.carriedDetail!.destroyed) { this.carriedDetail = new Sprite(); this.carriedDetail.anchor.set(.5); }
    const sprite = this.carriedDetail!, parent = this.overlay.parent, { detail, pose, paint } = carried,
      texture = this.texture(`carried-detail:${detail.kind}:${paint}:${detail.text ?? ''}:${this.weatheringMaps?.id ?? 0}`,
        () => pieceTexture(paintDetailCanvas(detail, paint, this.weatheringMaps))).texture,
      // A number reads the right way on a board drawn turned about; another detail faces as its surface has it.
      turned = detail.kind === 'number' ? this.camera.turn < 0 : pose.mirrored;
    if (sprite!.parent !== parent) parent!.addChildAt(sprite, parent!.getChildIndex(this.overlay));
    sprite!.texture = texture; sprite!.visible = true; sprite!.alpha = carried.hidden ? .4 : 1;
    sprite!.position.set(pose.x, pose.y); sprite!.rotation = pose.angle;
    sprite!.scale.set(detail.width / texture.width * (turned ? -1 : 1), -detail.height / texture.height);
  }
  drawOverlay(state: RendererDrawing, time = state.time ?? 0) {
    // The marks of the frame are drawn anew, with their places counted from its camera.
    const g = anchorGraphics(this.overlay, this.camera.x, this.camera.y), width = 1.1 / this.camera.zoom;
    this.aimPreview = null; this.meter?.mark('overlay');
    this.drawDeposits(this.mode === 'test' && state.shared ? knownVeins(depositsOf(this.ground), state.faction) : null, undefined, state.time);
    this.meter?.mark('sites');
    this.drawTows(g, state);
    if (this.mode === 'test' && state.contacts?.length) this.drawContacts(g, state, time);
    this.impactLabel.visible = false; this.servoLabel.visible = false; this.leadLabel.visible = false; this.lifted = 0;
    this.strikeWords.visible = this.strikeDetail.visible = false;
    if (this.mode !== 'test' || this.watching || this.tool === 'inspect' || this.weapon?.platform !== 'vehicle')
      this.aimPresentation?.clear();
    if (Object.hasOwn(this, 'recoilLabel')) this.recoilLabel!.visible = false;
    // What is selected is a piece of what the player works on: of the field only looked at, nothing.
    const selectedIds = new Set(this.watching ? [] : this.mode === 'edit' ? this.selectionIds || [this.selection] : [this.selection]);
    // The frame of a chassis is one piece to the player: a plate of one of its stretches selected, all of theirs are.
    const frames = state.plates.filter(plate => plate.definition?.chassis?.part === 'frame'), actorOf = (plate: { actorId?: string | undefined }) => plate.actorId || 'local',
      framed = new Set(frames.filter(plate => selectedIds.has(plate.id)).map(actorOf));
    for (const plate of frames) if (framed.has(actorOf(plate))) selectedIds.add(plate.id);
    // Editing details (detail-editor.ts): the one in hand; the surface of the one picked and its outline, whose handles are
    // the page's; the one under the mouse; dashed, those of which nothing shows; and the lines a moved one settles on.
    this.drawCarriedDetail(this.mode === 'edit' ? this.view.detailEdit?.carried : null);
    if (this.mode === 'edit' && this.view.detailEdit) {
      const detail = this.view.detailEdit, dash = 5 / this.camera.zoom;
      if (detail.host?.length) g.poly(detail.host.flatMap(p => [p.x, p.y])).stroke({ color: 0xb9cc8b, width, alpha: .6 });
      if (detail.ghosts?.length) {
        for (const ghost of detail.ghosts) ghost.forEach((a, i) => {
          const b = ghost[(i + 1) % ghost.length], length = Math.hypot(b!.x - a.x, b!.y - a.y);
          for (let at = 0; at < length; at += dash * 2) {
            const from = at / length, to = Math.min(length, at + dash) / length;
            g.moveTo(a.x + (b!.x - a.x) * from, a.y + (b!.y - a.y) * from).lineTo(a.x + (b!.x - a.x) * to, a.y + (b!.y - a.y) * to);
          }
        });
        g.stroke({ color: 0xe9eddf, width: width * 1.4, alpha: .8 });
      }
      if (detail.hover?.length) g.poly(detail.hover.flatMap(p => [p.x, p.y])).stroke({ color: 0xffcf93, width: width * 1.2, alpha: .6 });
      if (detail.guides?.length) {
        for (const [a, b] of detail.guides) g.moveTo(a!.x, a!.y).lineTo(b!.x, b!.y);
        g.stroke({ color: 0x8fd8ff, width: width * 1.2, alpha: .95 });
      }
      if (detail.corners?.length) g.poly(detail.corners.flatMap(p => [p.x, p.y])).stroke({ color: 0xffcf93, width: width * 2 });
    }
    if (this.mode === 'edit' && !this.view.detailEdit) {
      const gridAlpha = this.tool === 'module' || this.modulePreview ? .16 : .075;
      const step = gridStep(this.camera.zoom);
      for (const [a, b, every] of this.gridLines || []) if (every >= step) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      g.stroke({ color: 0xd5dfbd, width: width * .65, alpha: gridAlpha });
      // The points of the frame: the ends of plates, round, and the points of the chassis, square, halfway down its frame;
      // a selected stretch of the chassis is outlined over its frame. A point selected is lit. An end so near another that
      // the two look one, but apart from it, is a hollow ring (frame-points.ts looseEnds); the end a drag would join is
      // ringed.
      const hot = (point: Point) => this.vertexHover && Math.hypot(point.x - this.vertexHover.x, point.y - this.vertexHover.y) < 1e-6,
        editor = this.view.editor,
        // The floor follows the chassis grips; its derived joints are not independent handles.
        ends = this.blueprint.frame.nodes.filter(point => !point.id.startsWith('chassis:')),
        loose = looseEnds(ends, this.blueprint.frame.plates, LOOSE_PX / this.camera.zoom);
      for (const point of ends) {
        const lit = hot(point) || selectedIds.has(nodeKey(point.id));
        if (!lit && loose.has(point.id)) roundShape(g, point.x, point.y, 5 / this.camera.zoom).stroke({ color: 0xf08f78, width: width * 1.6 });
        else roundShape(g, point.x, point.y, (lit ? 7 : 5) / this.camera.zoom).fill(lit ? 0xffd095 : 0x405645)
          .stroke({ color: lit ? 0xfff1d6 : 0xffd095, width: width * 1.5 });
      }
      for (const point of this.joinTargets) roundShape(g, point.x, point.y, 11 / this.camera.zoom)
        .fill({ color: 0xffd095, alpha: .22 }).stroke({ color: 0xfff1d6, width: width * 2.2 });
      for (const point of editor?.chassisPoints?.() ?? []) {
        const lit = hot(point) || selectedIds.has(vertexKey(point.index)), half = (lit ? 6 : 4.5) / this.camera.zoom;
        g.rect(point.x - half, point.y - half, half * 2, half * 2).fill(lit ? 0xffd095 : 0x405645)
          .stroke({ color: lit ? 0xfff1d6 : 0xffd095, width: width * 1.5 });
      }
      for (const id of selectedIds) {
        const chosen = pointOf(id), stretch = chosen?.kind === 'stretch' ? editor?.chassisStretch?.(chosen.index) : null;
        if (stretch?.length) g.poly(stretch.flatMap(p => [p.x, p.y])).fill({ color: 0xffcd8d, alpha: .12 }).stroke({ color: 0xffcd8d, width: width * 2, alpha: .95 });
      }
      if (this.edgeHover) {
        const { a, b } = this.edgeHover;
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffd095, width: width * 3, alpha: .9 });
        roundShape(g, (a.x + b.x) / 2, (a.y + b.y) / 2, 4 / this.camera.zoom)
          .fill(0x405645).stroke({ color: 0xffd095, width: width * 1.5 });
      }
    }
    // An optic selected shows what it sees: the arcs its own armour leaves open to it, as a glow about it that
    // is gone some way off on the screen and stops at the ground, and brighter the lines it sees out level along.
    if (this.mode === 'edit') for (const sight of this.blueprint.sights) if (selectedIds.has(sight.id))
      drawSight(g, sight, SIGHT_REACH * Math.min(this.camera.width, this.camera.height) / this.camera.zoom, x => this.ground.height(x), 1 / this.camera.zoom);
    for (const id of selectedIds) {
      const module = this.scene!.pose(id, 'module');
      if (!module || !module.weaponMount) continue;
      const sector = presentedMountSector(module);
      if (!sector) continue;
      if (this.mode === 'edit' && !this.modulePreview) this.drawRecoilGuide(module as typeof module & { weaponMount: NonNullable<typeof module.weaponMount> }, g, selectedIds.size === 1);
      const radius = Math.max(.35, Math.min(1.1, module!.width)), steps = 24;
      for (let i = 0; i <= steps; i++) {
        const angle = sector.min + (sector.max - sector.min) * i / steps,
          x = module!.x + Math.cos(angle) * radius, y = module!.y + Math.sin(angle) * radius;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke({ color: 0xcee1a6, width: width * 1.2, alpha: .6 });
      for (const angle of [sector.min, sector.max])
        g.moveTo(module!.x, module!.y).lineTo(module!.x + Math.cos(angle) * radius,
          module!.y + Math.sin(angle) * radius).stroke({ color: 0xcee1a6, width, alpha: .35 });
    }
    const selectedPieces = [...state.plates, ...state.modules].filter(p => selectedIds.has(p.id));
    // The frame of a chassis is edged as it is drawn: the outline of each part of it between gaps, mitred at each knee
    // (chassis-art.ts `chassisOutlineAt`), once for all its stretches.
    const outlined = new Set<string>();
    for (const frame of frames) if (selectedIds.has(frame.id) && frame.definition.chassis!.outlines && !outlined.has(actorOf(frame))
      && frame.attached !== false && !('detached' in frame && frame.detached) && !('fragment' in frame && frame.fragment)) {
      const chassis = frame.definition.chassis!;
      if (!chassis.profile || !chassis.outlines) continue;
      outlined.add(actorOf(frame));
      const framedChassis = chassis as typeof chassis & { profile: NonNullable<typeof chassis.profile>; outlines: NonNullable<typeof chassis.outlines> },
        place = chassisPlacement(this.scene!.pose(frame.id, 'plate')!, framedChassis, this.scene!.actor(actorOf(frame))?.angle ?? 0);
      for (const outline of chassisOutlineAt(place, framedChassis))
        g.poly(outline.flatMap(p => [p.x, p.y])).stroke({ color: 0xffcd8d, width: width * 2, alpha: 0.95 });
    }
    for (const selected of selectedPieces) {
      if ('definition' in selected && selected.definition.chassis?.part === 'frame' && outlined.has(actorOf(selected))) continue;
      if ('definition' in selected) {
        const item = this.drawables.get(selected.id);
        // A plate of the chassis or of its floor is in its picture, not drawn on its own: outlined by its own region.
        const geometry = item || (selected.definition.chassis || floorSegment(selected.definition) !== null ? regionGeometry(selected) : null), pose = geometry && !item ? this.scene!.pose(selected.id) : null,
          points = item ? drawablePoints(item) : geometry && Array.from({ length: geometry.positions.length / 2 }, (_, i) => localToWorld(pose!, geometry.positions[i * 2]!, geometry.positions[i * 2 + 1]!));
        if (geometry) {
          for (const edge of geometry.edges) {
            const a = points![edge.a], b = points![edge.b]; g.moveTo(a!.x, a!.y).lineTo(b!.x, b!.y);
          }
          g.stroke({ color: 0xffcd8d, width: width * 2, alpha: 0.95 });
        }
      } else for (const poly of componentPolygons(this.scene!.pose(selected.id, 'module')!)) {
        const points = poly.flatMap(p => [p.x, p.y]);
        g.poly(points).stroke({ color: 0xffcc8b, width: width * 4.5, alpha: .22 });
        g.poly(points).stroke({ color: 0xffcc8b, width: width * 1.6 });
      }
    }
    // A component under the pointer is outlined before it is taken.
    const hovered = this.mode === 'edit' && this.hoverId && !selectedIds.has(this.hoverId) &&
      state.modules.find(module => module.id === this.hoverId);
    if (hovered) for (const poly of componentPolygons(this.scene!.pose(hovered.id, 'module')!))
      g.poly(poly.flatMap(p => [p.x, p.y])).fill({ color: 0xfff1d6, alpha: .07 }).stroke({ color: 0xfff1d6, width: width * 1.3, alpha: .85 });
    if (this.marquee && this.mode === 'edit') {
      const { start, end } = this.marquee;
      g.rect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y))
        .fill({ color: 0xd5dcb1, alpha: .13 }).stroke({ color: 0xf1d69d, width: width * 1.5 });
    }
    if (this.mode === 'edit' && this.modulePreview) {
      const invalid = this.modulePreview.overlap || this.modulePreview.refused;
      for (const p of this.modulePreview.modules) {
        const poly = componentPolygon(p);
        g.poly(poly.flatMap(p => [p.x, p.y])).fill({ color: invalid ? 0xcb6557 : 0xb9c88e, alpha: 0.3 }).stroke({ color: invalid ? 0xf59c87 : 0xffd095, width: width * 1.5 });
        if (p.kind === 'weapon') this.drawRecoilGuide(p, g, true);
      }
      for (const plate of this.modulePreview.plates || [])
        g.poly(plateCorners(plate).flatMap(p => [p.x, p.y])).fill({ color: invalid ? 0xcb6557 : 0xb9c88e, alpha: .3 })
          .stroke({ color: invalid ? 0xf59c87 : 0xffd095, width: width * 1.5 });
    }
    if (this.mode === 'edit' && this.platePreview) {
      const { a, b } = this.platePreview;
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffd095, width: width * 3 });
      for (const p of [a, b]) roundShape(g, p.x, p.y, 4 / this.camera.zoom).fill(0xffd095);
    }
    if (this.mode === 'edit') this.drawManufactureIssues(g, width);
    const blocked = this.mode === 'edit' ? this.view.editor?.blockedEdit : null;
    if (blocked && blocked.until > Date.now()) {
      const alpha = Math.min(1, (blocked!.until - Date.now()) / 350), color = 0xf06b66,
        polygons = [...blocked!.polygons];
      for (const id of blocked!.ids) {
        const plate = this.blueprint.plates.find(part => part.id === id), module = this.blueprint.modules.find(part => part.id === id);
        if (plate) polygons.push(plateCorners(plate));
        if (module) polygons.push(...componentPolygons(module));
      }
      for (const polygon of polygons) g.poly(polygon.flatMap(p => [p.x, p.y]))
        .fill({ color, alpha: .13 * alpha }).stroke({ color, alpha, width: width * 2.5 });
      for (const point of blocked!.points) roundShape(g, point.x, point.y, 7 / this.camera.zoom)
        .fill({ color, alpha: .5 * alpha }).stroke({ color, alpha, width: width * 2 });
    }
    // The strikes of the test of armour, where no gun is in hand to draw the arc of.
    if (this.mode === 'test' && this.strike) this.drawStrike(g, width);
    if (this.mode === 'test' && !this.watching && this.tool !== 'inspect' && this.weapon?.platform === 'vehicle') {
      // The arcs of the guns fired along with it lie under that of the gun in hand: fainter, thinner, with no marks.
      for (const { solution: { reachable }, drawn: path } of this.linkedArcs(state)) {
        if (!reachable) continue;
        const color = 0xe6cf92, distant = this.camera.zoom < FAR_VIEW_ZOOM, last = path!.at(-1);
        traceArc(g, path!, distant).stroke({ color, width: width * (distant ? 1.3 : .9), alpha: .4, join: 'round' });
        roundShape(g, last!.x, last!.y, 3.5 / this.camera.zoom).stroke({ color, width, alpha: .5 });
      }
      const solution = this.aimingSolution(state);
      const display = this.aimPresentation ||= new AimPresentation(), sample = this.playback.display,
        reset = !sample?.previous || sample.state !== state || this.playback.paused,
        obstruction = solution?.reachable ? this.weaponObstruction(state, solution) : null,
        ally = solution?.reachable && !obstruction ? this.allyInLine(state, solution) : null,
        raw = solution?.reachable ? this.aimQueries.forecast(state, solution, this.weapon, this.ground) : null,
        prediction = raw && display.sample(raw, { state, previous: sample?.previous, alpha: this.presentationAlpha ?? 1,
          now: this.frameNow, zoom: this.camera.zoom, reset: reset || Boolean(obstruction || ally), shift: forecast => this.forecastShift(forecast) });
      if (!raw) display.clear();
      if (solution) {
        // The muzzle where the frame draws it, with no arc to start from too: what is said of the barrel is said there.
        const module = this.launcherOf(state), sampled = module && this.sceneFor(state).pose(module.id, 'module'),
          pose = sampled && observedWeapon(sampled) ? sampled : null,
          mouth = prediction?.path[0] || (pose ? carried(solution, module!, pose, weaponAngle) : solution);
        if (this.weapon.platform === 'vehicle') {
          if (module && pose) {
            const goalAngle = pose.targetBarrelAngle ?? weaponAngle(pose),
              status = servoStatus(pose, goalAngle), color = 0xffd095;
            roundShape(g, mouth.x, mouth.y, 3 / this.camera.zoom).fill({ color, alpha: .85 });
            if (status.aligning) {
              const { radius, extent } = servoGuide(this.weapon.barrel), segments = 12;
              for (let i = 0; i < 10; i += 2) {
                const a = extent * i / 10, b = extent * (i + 1) / 10;
                g.moveTo(pose!.x + Math.cos(goalAngle) * a, pose!.y + Math.sin(goalAngle) * a)
                  .lineTo(pose!.x + Math.cos(goalAngle) * b, pose!.y + Math.sin(goalAngle) * b)
                  .stroke({ color: 0xe1e7d2, width, alpha: .45 });
              }
              for (let i = 0; i <= segments; i++) {
                const a = pose!.barrelAngle! + status.error! * i / segments,
                  x = pose!.x + Math.cos(a) * radius, y = pose!.y + Math.sin(a) * radius;
                i ? g.lineTo(x, y) : g.moveTo(x, y);
              }
              g.stroke({ color, width: width * 1.5, alpha: .85 });
              this.servoLabel.text = 'Apontando · ' + status.errorDegrees.toFixed(0) + '°';
              this.servoLabel.style.fill = color;
              this.tag(this.servoLabel, pose!.x, pose!.y, 14, 42);
            }
          }
        }
        if (!solution.reachable) {
          // No shot is admitted to this request. Keep the servo/cursor and explain the limit there.
          this.impactLabel.text = aimLimitText(solution);
          this.tag(this.impactLabel, this.aim.x, this.aim.y, 10, 20);
        } else {
          if (obstruction) { roundShape(g, mouth.x, mouth.y, 9 / this.camera.zoom).stroke({ color: 0xeb9976, width: width * 2 }); this.impactLabel.text = 'own' in obstruction && obstruction.own ? tr('Próprio veículo na linha de tiro') : tr('Cano obstruído'); this.tag(this.impactLabel, mouth.x, mouth.y, 10, 20); }
          // An ally in the line is told; a round that bursts on it, which would harm nothing of it, is drawn red.
          const spent = ally && !KINETIC_AMMO.includes(this.weapon.ammo), { impact, path, flight } = prediction!,
            color = !obstruction && !spent ? 0xe6cf92 : 0xd99373,
            distant = this.camera.zoom < FAR_VIEW_ZOOM;
          // From afar the dashes of a long arc run together: it is one line with a dark edge.
          if (distant) for (const [tint, wide, alpha] of [[0x24332c, 3.6, .5], [color, 2, .95]] as const)
            traceArc(g, path, true).stroke({ color: tint, width: width * wide!, alpha, join: 'round' });
          else traceArc(g, path, false).stroke({ color, width: width * 1.3, alpha: .8 });
          for (const mark of prediction === raw ? raw!.marks : display.marks(prediction!))
            roundShape(g, mark.x, mark.y, 3.2 / this.camera.zoom).fill({ color: 0x24332c, alpha: .85 }).stroke({ color, width: width * 1.4 });
          const last = path.at(-1)!; roundShape(g, last.x, last.y, 5 / this.camera.zoom).stroke({ color, width: distant ? width * 2 : width });
          this.aimPreview = { path, reachable: solution.reachable };
          if (this.weapon.ammo === 'he') roundShape(g, last.x, last.y, this.weapon.blastRadius).stroke({ color, width, alpha: 0.27 });
          if (impact && !obstruction) {
            const length = 32 / this.camera.zoom;
            g.moveTo(impact.x, impact.y).lineTo(impact.x + impact.nx * length, impact.y + impact.ny * length).stroke({ color: 0xd4e2b4, width: width * 1.4 });
            this.impactLabel.text = impact.angleDegrees.toFixed(1).replace('.', ',') + '°';
            if (impact.bounce) {
              const speed = Math.hypot(impact.bounce.vx, impact.bounce.vy), length = 70 / this.camera.zoom;
              g.moveTo(impact.x, impact.y).lineTo(impact.x + impact.bounce.vx / speed * length,
                impact.y + impact.bounce.vy / speed * length).stroke({ color: 0xedba8b, width: width * 1.5 });
              this.impactLabel.text += ' · ricochete';
            }
            if (flight >= 1) this.impactLabel.text += ' · ' + flightSeconds(flight);
            if (ally) this.impactLabel.text = tr('Aliado na linha de tiro · ') + this.impactLabel.text;
            this.tag(this.impactLabel, impact.x, impact.y, 9, 24);
          } else if (!obstruction && flight >= 1) {
            this.impactLabel.text = flightSeconds(flight);
            this.tag(this.impactLabel, last.x, last.y, 9, 24);
          }
          const lead = !obstruction && flight >= .3 ? this.movingTarget(state, flight) : null;
          if (lead) {
            const { from, to } = lead, size = 7 / this.camera.zoom, tint = 0xa9dfe3;
            g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color: tint, width, alpha: .55 });
            g.poly([to.x - size, to.y, to.x, to.y + size, to.x + size, to.y, to.x, to.y - size])
              .fill({ color: 0x24332c, alpha: .55 }).stroke({ color: tint, width: width * 1.6 });
            this.leadLabel.text = tr('alvo em ') + flightSeconds(flight);
            this.tag(this.leadLabel, to.x, to.y, 11, -6);
          }
        }
      }
      const size = 9 / this.camera.zoom, hole = 3 / this.camera.zoom,
        aim = display.point(this.aim, this.camera, this.frameNow, raw?.key,
          reset || !raw || Boolean(obstruction || ally));
      g.moveTo(aim.x - size, aim.y).lineTo(aim.x - hole, aim.y).moveTo(aim.x + hole, aim.y).lineTo(aim.x + size, aim.y).moveTo(aim.x, aim.y - size).lineTo(aim.x, aim.y - hole).moveTo(aim.x, aim.y + hole).lineTo(aim.x, aim.y + size).stroke({ color: 0x2f4538, width, alpha: 0.85 });
      g.circle(aim.x, aim.y, hole * 0.3).fill(0xdabc83);
    }
  }
  // A strike of the test of armour (`strike`, main.ts): an arrow from where its line was drawn from to where it first
  // strikes, or to where it bursts in the air, in the colour of what it does there, with how the face stands there, the
  // reach of the burst of a round that bursts, and a faint line on to the place clicked when it strikes short of it; a
  // line into the sky is an arrow to the pointer. What it does and what it strikes are said by the pointer that drew it,
  // or by the tail of a line drawn for a click, on their side away from the head. Back on the place pressed, a ring there
  // says that letting go calls it off. Fired, the arrow stays faint under the round that flies along it, and fades.
  drawStrike(g: Graphics, width: number) {
    const strike = this.strike, zoom = this.camera.zoom, labels = [this.strikeWords, this.strikeDetail];
    if (strike!.back) {
      roundShape(g, strike!.from.x, strike!.from.y, 9 / zoom).stroke({ color: STRIKE_PLAIN, width: width * 1.6 });
      for (const label of labels) label.alpha = 1;
      this.strikeWords.style.fill = STRIKE_PLAIN; this.placeStrikeWords(tr('Solte aqui para cancelar'), '', strike!.from);
      return;
    }
    const fade = strike!.fired ? 1 - (performance.now() - strike!.fired) / STRIKE_FADE_MS : 1;
    if (fade <= 0) { this.strike = null; return; }
    const colors: Partial<Record<NonNullable<RenderStrike['verdict']>, number>> = STRIKE_COLORS;
    const alpha = strike!.fired ? STRIKE_FIRED * fade : 1, color = colors[strike!.verdict!] ?? STRIKE_PLAIN, tail = strike!.from,
      tip = strike!.impact ?? strike!.airburst ?? strike!.point ?? strike!.toward, length = Math.hypot(tip.x - tail.x, tip.y - tail.y),
      d = length > 1e-9 ? { x: (tip.x - tail.x) / length, y: (tip.y - tail.y) / length } : strike!.direction,
      head = Math.min(14 / zoom, length), side = head * .42, neck = { x: tip.x - d.x * head * .8, y: tip.y - d.y * head * .8 };
    for (const [tint, wide, shade] of [[0x23372e, 4.6, .55], [color, 2.2, 1]] as const)
      g.moveTo(tail.x, tail.y).lineTo(neck.x, neck.y).stroke({ color: tint, width: width * wide, alpha: shade * alpha, cap: 'round' });
    g.poly([tip.x, tip.y, tip.x - d.x * head - d.y * side, tip.y - d.y * head + d.x * side, tip.x - d.x * head + d.y * side, tip.y - d.y * head - d.x * side])
      .fill({ color, alpha }).stroke({ color: 0x23372e, width, alpha: .6 * alpha });
    if (strike!.blast && strike!.verdict !== 'miss')
      roundShape(g, tip.x, tip.y, strike!.blast).fill({ color, alpha: .08 * alpha }).stroke({ color, width, alpha: .5 * alpha });
    if (strike!.impact) {
      const reach = 26 / zoom, { nx, ny } = strike!.impact;
      g.moveTo(tip.x, tip.y).lineTo(tip.x + nx * reach, tip.y + ny * reach).stroke({ color: 0xd4e2b4, width: width * 1.2, alpha: .8 * alpha });
    }
    const aim = strike!.aim;
    if (aim) {
      if (Math.hypot(aim.x - tip.x, aim.y - tip.y) > 4 / zoom) g.moveTo(tip.x, tip.y).lineTo(aim.x, aim.y).stroke({ color, width, alpha: .35 * alpha });
      roundShape(g, aim.x, aim.y, 2.5 / zoom).fill({ color, alpha });
    }
    for (const label of labels) label.alpha = fade;
    this.strikeWords.style.fill = color;
    this.placeStrikeWords(STRIKE_WORDS[strike!.verdict], strike!.detail ?? '', strike!.pointer ?? tail, tip);
  }
  // The words of a strike by a point of the world: over it and on its side away from `from` (to its right without
  // one), above a finger when one is on it, and inside the view; under it when there is no room above.
  placeStrikeWords(words: string, detail: string, at: Point, from = at) {
    const zoom = this.camera.zoom, spot = this.camera.toScreen(at.x, at.y), lift = touching() ? LIFT : 0, labels = [this.strikeWords, this.strikeDetail];
    this.strikeWords.text = words; this.strikeDetail.text = detail;
    for (const label of labels) { label.scale.set((this.camera.turn ?? 1) / zoom, -1 / zoom); label.visible = Boolean(label.text); }
    const width = Math.max(...labels.map(label => Math.abs(label.width) * zoom)), height = labels.reduce((sum, label) => sum + (label.text ? Math.abs(label.height) * zoom : 0), 0),
      left = this.camera.toScreen(from.x, from.y).x > spot.x + 1,
      x = clamp(left ? spot.x - 14 - width : spot.x + 14, 8, Math.max(8, this.camera.width - width - 8)),
      top = spot.y - lift - 18 - height >= 8 ? spot.y - lift - 18 - height : Math.min(spot.y + 22, this.camera.height - height - 8);
    let y = top;
    for (const label of labels) {
      if (!label.text) continue;
      const corner = this.camera.toWorld(x, y); label.position.set(corner.x, corner.y); y += Math.abs(label.height) * zoom;
    }
  }
  drawRecoilGuide(module: Parameters<typeof weaponRecoilGuide>[0], graphics: Graphics, label = false) {
    const guide = weaponRecoilGuide(module);
    if (!guide) return;
    drawWeaponRecoilGuide(graphics, guide, 1 / this.camera.zoom);
    if (!label) return;
    if (!Object.hasOwn(this, 'recoilLabel')) {
      this.recoilLabel = fieldWords('', 0xf2c985, 11);
      (this.host ? this.marks : this.world).addChild(this.recoilLabel);
    }
    const x = (guide.minX + guide.maxX) / 2, y = guide.maxY,
      cos = Math.cos(guide.angle), sin = Math.sin(guide.angle);
    this.recoilLabel!.text = 'Recuo: ' + String(Math.round(guide.stroke * 1000) / 10).replace('.', ',') + ' cm';
    this.tag(this.recoilLabel!, guide.x + cos * x - sin * y, guide.y + sin * x + cos * y, 8, 15);
    this.recoilLabel!.scale.x *= this.camera.turn ?? 1;
  }
  // A label of the aim, `dx`, `dy` pixels right of and above the point (`x`, `y`) of the world. With a finger on the
  // aim, one that would be under the finger is lifted clear of it, above those lifted before it this frame.
  tag(label: Text, x: number, y: number, dx: number, dy: number) {
    const zoom = this.camera.zoom;
    label.scale.set(1 / zoom, -1 / zoom); label.position.set(x + dx / zoom, y + dy / zoom); label.visible = true;
    if (!touching() || !this.aim) return;
    const finger = this.camera.toScreen(this.aim.x, this.aim.y), spot = this.camera.toScreen(label.position.x, label.position.y),
      width = Math.abs(label.width) * zoom, height = Math.abs(label.height) * zoom;
    if (Math.hypot(clamp(finger.x, spot.x, spot.x + width) - finger.x, clamp(finger.y, spot.y, spot.y + height) - finger.y) >= LIFT) return;
    const { left, right } = this.camera.cover(),
      foot = clearOf(finger.x, finger.y - this.lifted, width, height, { left, right: this.camera.width - right, bottom: this.camera.height });
    this.lifted += height + 4;
    const corner = this.camera.toWorld(foot.x - width / 2 * (this.camera.turn ?? 1), foot.y - height);
    label.position.set(corner.x, corner.y);
  }
}
