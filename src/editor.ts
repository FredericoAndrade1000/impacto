import { freezeRecord } from './immutable.ts';
import { makeId } from './blueprints.ts';
import { automaticFinish } from './vehicle-details.ts';
import { clamp, worldToLocal, segmentConvex, rectangle, closestSegment, plateCorners } from './math.ts';
import { containsPoint, foregroundGearAt, piecePolygon } from './assembly.ts';
import { weaponContains } from './weapon-art.ts';
import { compatibleWeaponMounts, defaultWeaponMount, WEAPON_MOUNTS } from './weapon-mounts.ts';
import { allowedAmmo, fedAmmo, cartridgeId } from './weapons.ts';
import { METALS, metalOf, metalRefusal, takesMetal } from './materials.ts';
import { weaponBarrelPolygon } from './weapon-geometry.ts';
import { DESIGN_VERSION, validateDraftBlueprint } from './persistence.ts';
import { CAPACITY, CONSTRUCTION_ORIGIN, PART_LIMITS, compileManufacture, compileDraft, validateDraftConstruction, compileDraftConstruction, outerWalls,
  planStructuredComponent, RECOVERABLE as CONSTRUCTION_ERRORS } from './structured-construction.ts';
import { CELL, cellOf, metresOf, unitsOf } from './grid.ts';
import { planStructuredModule, planStructuredWeaponPlacement, moveStructuredComponents, componentFaceSnap,
  planStructuredRoom, remountStructuredWeapon, constructionEditMessage, chassisRangeMessage, withPieceProperty, refuseToolsTooHigh, LIMITS, MARKED_ISSUES } from './structured-editing.ts';
import { idleAmmunition } from './workshop-checklist.ts';
import { addPlate, moveNodes, splitPlate, removeNode, removePlates, removeRoom, joinNodes, coincidentNodes, platesAlong,
  platesAcross, assemblySelection, moveFrameSelection, joinContacts, landEnds, REACH_CELLS } from './frame-editing.ts';
import { onAxis, mirrored, nodeAcross, plateAcross, vertexAcross, stretchAcross, withAcross, symmetricMove, untilAxis } from './symmetry.ts';
import { CHASSIS_ID, chassisPart, chassisTopPlate, chassisPointRange, constructionKind, withConstructionKind, withChassisAxle,
  withChassisGap, withChassisPoint, withChassisPointAdded, withChassisPointRemoved, withChassisPointsMoved, withChassisTrackEnd,
  withChassisTrackPosition, withChassisTrackHeight, withChassisSkidEnd, withChassisSkidLeg, withChassisSkidsMoved, withFrameMetal, withChassisTopMaterial,
  bedStretchAt, withTrackOnFloor } from './chassis-editing.ts';
import { nodeKey, vertexKey, stretchKey, pointOf, selectedPoints, samePlace } from './frame-points.ts';
import { plateEdge, chassisEdge, alongEdge } from './edge-plates.ts';
import { chassisAxles, chassisSkids, chassisStretchOf, chassisTrack, chassisVertices, gearProblem } from './chassis.ts';
import { Terrain } from './terrain.ts';
import { coldConstructionPlacement, constructionSpan } from './construction-placement.ts';
import { constructionSupportSite } from './construction-admission.ts';
import { regionContains } from './scene-frame.ts';
import type { Point, Pose } from './math.ts';
import type { MaterialId, ModuleKind, MetalId, ArmourMaterial } from './materials.ts';
import type { AuthoredConstruction, AuthoredPlate, CompiledConstruction, CompiledModule, CompiledPlate, CompiledPiece, NativeAdmissionIssue, ConstructionError, ConstructionAppearance, ConstructionNode, ChassisModelId, ConstructionSource } from './construction-contract.ts';
import type { ModulePlacementOptions, ModulePlacementPlan, StructuredRoomPlan, PieceProperty, PiecePropertyValues, PropertyEdit, ComponentCopy, PlateCopy } from './structured-editing.ts';
import type { PlateEdge } from './edge-plates.ts';
import type { ChassisMetalId } from './chassis.ts';
import type { RoomWall } from './frame-editing.ts';
import type { SceneSample, GeometrySource, GeometryPlate, RegionSource } from './scene-frame.ts';
import { isNativeAdmissionIssue, isConstructionError } from './construction-codec.ts';

export type EditorGear = Point & {key:string} & (
  {grip:'axle';index:number;end?:never;inset?:never} | {grip:'skid';end:'front'|'rear';index?:never;inset?:never} |
  {grip:'skid-position';end?:never;index?:never;inset?:never} | {grip:'skid-leg';index:number;end?:never;inset?:never} |
  {grip:'track';end:'front'|'rear';inset:number;index?:never} | {grip:'track-position'|'track-height';end?:never;index?:never;inset?:never});
export type EditorGearHit = EditorGear & {source:AuthoredConstruction};
export type RoomHandle = RoomWall & {id:string;source?:AuthoredConstruction};
export interface EditorDuplicate {kind:ModuleKind|'plate';copies:ComponentCopy[];plates:PlateCopy[];anchor:Point}
interface EditFeedback {ids?:string[];polygons?:Point[][];points?:Point[]}
export interface EditorEvent { kind: 'document' | 'preview' | 'selection' | 'feedback' }
export interface SelectionPose extends Pose { id: string }
export interface EditorChassisPoint extends Point { index: number; end: 'front' | 'rear' | null; top: Point; foot: Point }
export interface EditorNodeHit extends Point { kind: 'node'; id: string; key: string; source: AuthoredConstruction }
export interface EditorVertexHit extends EditorChassisPoint { kind: 'vertex'; key: string; source: AuthoredConstruction }
export type EditorPointHit = EditorNodeHit | EditorVertexHit;
export interface EditorPlateSpan {
  id: string; aId: string | null; bId: string | null; a: Point; b: Point; length: number;
  material: MaterialId; thicknessMm: number; normal: Point | null; roomId: string | null;
}
export interface EditorPlateHit extends EditorPlateSpan { source: AuthoredConstruction }
interface PlateArmour { material: MaterialId; thicknessMm: number }
interface PlateEndpoint extends Point { nodeId?: string; surfaceId?: string }
export interface EditorEdgeHit extends PlateEdge { armour: PlateArmour; at: number; source: AuthoredConstruction }
interface EditorDocument { key: string; projectId: string; blueprint: AuthoredConstruction }
interface CompiledSlot { source: AuthoredConstruction; value: CompiledConstruction; manufacture?: readonly NativeAdmissionIssue[] | undefined }
interface DrawnPlates { source: AuthoredConstruction; compiled: CompiledConstruction; plateIds: string[]; meets: Point[] }
type PlatePlan = DrawnPlates & { refusal?: never; polygons?: never }
  | { refusal: unknown; meets: Point[]; polygons: Point[][]; source?: never; compiled?: never; plateIds?: never };
interface BlockedEdit { message: string; ids: string[]; polygons: Point[][]; points: Point[]; until: number }
interface PlateGesturePlan { source: AuthoredConstruction; key: string; drawn: DrawnPlates | null; refusal: unknown; polygons: Point[][] }
interface EdgeGesturePlan { edge: EditorEdgeHit; key: string; laid: DrawnPlates | null; refusal: unknown; polygons: Point[][] }
interface RoomGesturePlan { source: AuthoredConstruction; key: string; drawn: StructuredRoomPlan | null; refusal: unknown }
interface LastAssemblyMove { original: readonly SelectionPose[]; source: AuthoredConstruction; current: AuthoredConstruction; dx: number; dy: number; joinReach: number; accepted: boolean }
export interface PickMaterialPlate { id:string; material: MaterialId | ArmourMaterial; kind?:never }
export interface PickPlate extends Pose { id: string; length: number; thicknessMm: number; material: MaterialId; kind?: never }
export interface PickModule extends Pose { id: string; kind: ModuleKind; width: number; height: number; barrelAngle?: number | undefined; material?: never }

// The bench is level ground. A fixed design stands on nothing but the ground and its own pieces: it is reviewed resting on
// the bench as the board draws it (render.ts `settleDesign`), and again on the field where its works is placed, whose
// ground may reach other pieces (publication-placement.ts). A vehicle carries itself on its chassis anywhere.
const BENCH = new Terrain('flat');
const benchSite = (blueprint: CompiledConstruction) => blueprint.preset === 'vehicle' ? {} :
  constructionSupportSite(BENCH, coldConstructionPlacement(blueprint, BENCH, { settle: true }), constructionSpan(blueprint));

const RECOVERABLE = [...CONSTRUCTION_ERRORS, 'FRAME_EDIT'];
const frameRefusal = (message: string) => Object.assign(new Error(message), { code: 'FRAME_EDIT' });
// A refusal of an edit said in the author's terms; a slip of the code goes as it came.
const told = (error: unknown) => isNativeAdmissionIssue(error) && RECOVERABLE.includes(error.code) ? Object.assign(new Error(constructionEditMessage(error)), error) : error;
// A refusal of the compiler's kind, made here: what the editor already knows the compiler would say.
const refusal = (reason: string, fields: Partial<NativeAdmissionIssue> = {}) => Object.assign(new Error(reason), { code: 'STRUCTURED_CONSTRUCTION', reason, ...fields });
// A point written in cells, in the field.
const fieldPoint = (point: Point) => ({ x: CONSTRUCTION_ORIGIN.x + metresOf(point.x), y: CONSTRUCTION_ORIGIN.y + metresOf(point.y) });
// A proposal with its plates divided where they meet (frame-editing.ts `joinContacts`), admitted as a draft: the document,
// its projection, the parts of each plate divided and where it was divided, in the field (`divisions`).
function joinedDraft(next: AuthoredConstruction) {
  const { source, points, parts } = joinContacts(next), { construction, compiled } = compileDraft(source);
  return { construction, compiled, parts, divisions: points.map(fieldPoint) };
}

// The workshop and damage inspector share visible-order picking. A live frame
// supplies its clipped material test; document pieces use their exact outlines.
export function pickPiece<P extends PickPlate, M extends PickModule>(plates: readonly P[], modules: readonly M[], point: Point, tolerance?: number,
  containsMaterial?: (piece: P | M) => boolean | undefined): string | null;
export function pickPiece<P extends PickMaterialPlate, M extends PickModule>(plates: readonly P[], modules: readonly M[], point: Point, tolerance: number,
  containsMaterial: (piece: P | M) => boolean | undefined): string | null;
export function pickPiece<P extends PickMaterialPlate, M extends PickModule>(plates: readonly P[], modules: readonly M[], point: Point, tolerance = .06,
  containsMaterial: (piece: P | M) => boolean | undefined = () => undefined): string | null {
  // Snapshot plates carry their geometry in a definition; their material callback resolves them.
  // Only document plates have the stock pose used by the optional proximity and rail assistance.
  const stock = <P extends PickMaterialPlate>(plate: P): plate is P & PickPlate =>
    'x' in plate && typeof plate.x === 'number' && 'y' in plate && typeof plate.y === 'number' &&
    'angle' in plate && typeof plate.angle === 'number' && 'length' in plate && typeof plate.length === 'number' &&
    'thicknessMm' in plate && typeof plate.thicknessMm === 'number' && typeof plate.material === 'string';
  const contains = (p: P | M): boolean => {
    const material = containsMaterial(p);
    if (material !== undefined) return material;
    if (p.kind) return p.kind === 'weapon' ? weaponContains(p, point, tolerance, p.barrelAngle ?? Math.PI + (p.angle || 0)) : containsPoint(p, point);
    return stock(p) && containsPoint(p, point);
  };
  const reversed = [...modules].reverse(), sheets = [...plates].reverse();
  const gun = reversed.find(m => m.kind === 'weapon' && contains(m)),
    gear = !gun && foregroundGearAt(modules.filter(contains), point);
  if (gun) return gun.id;
  if (gear) return gear.id;
  const exact = sheets.find(contains) || reversed.find(contains) || sheets.find(plate => stock(plate) && railContains(plate, plates.filter(stock), point));
  if (exact) return exact.id;
  let nearest: string | null = null, distance = tolerance;
  if (tolerance > 0) for (const plate of sheets) {
    if (!stock(plate)) continue;
    const p = worldToLocal(plate, point), gap = Math.hypot(Math.max(0, Math.abs(p.u) - plate.length / 2),
      Math.max(0, Math.abs(p.v) - plate.thicknessMm / 2000));
    if (gap <= tolerance && (nearest === null || gap < distance)) { nearest = plate.id; distance = gap; }
  }
  return nearest;
}
// The rail of a chassis is drawn as deep as from it up to the frame plate over it (chassis-art.ts): a press anywhere between
// the two takes the rail, past any piece in front of it, though each plate is a few millimetres thick.
const RAIL = /^(.*chassis:)rail-(\d+)$/;
function railContains(rail: PickPlate, plates: readonly PickPlate[], point: Point): boolean {
  const named = RAIL.exec(rail.id ?? ''), frame = named && plates.find(p => p.id === `${named[1]}frame-${named[2]}`);
  if (!frame) return false;
  const p = worldToLocal(rail, point), f = worldToLocal(rail, frame), h = rail.thicknessMm / 2000, g = frame.thicknessMm / 2000;
  return Math.abs(p.u) <= rail.length / 2 && p.v >= Math.min(-h, f.v - g) && p.v <= Math.max(h, f.v + g);
}
// The inspector of the field picks among what a frame draws (scene-frame.ts `sampleScene`), where the frame draws it. The
// frame shows the field a little behind the newest state the page holds, between the two states about its time
// (presentation.ts): a construction that moves is drawn behind where the newest state has it, by as far as it goes in that
// time — some 27 m at 360 m/s. Picked from that state, a piece would be found only by a press ahead of where it is seen.
// `hidden` are the pieces under the skin of a hull that is not looked into; `tolerance`, how far off a plate a press still
// takes it (`pickPiece`).
interface ShownSceneSource extends GeometrySource {readonly plates:readonly (GeometryPlate & RegionSource & {material:MaterialId|ArmourMaterial})[]}
export function pickShownPiece<Source extends ShownSceneSource>(scene: SceneSample<Source>, point: Point, hidden: ReadonlySet<string> = NO_PIECES, tolerance = 0) {
  const plates = [], modules = [];
  for (const part of scene.frame.parts)
    if (part.type === 'plate') plates.push(scene.pose(part.id, 'plate')!); else if (!hidden.has(part.id)) modules.push(scene.pose(part.id, 'module')!);
  // A plate is found by the material it has left, as its record holds it, where the frame puts it.
  return pickPiece(plates, modules, point, tolerance, piece => {
    const plate = 'material' in piece && piece.material && scene.frame.get(piece.id, 'plate');
    if (plate) return regionContains(plate, point, piece);
  });
}
const NO_PIECES = new Set<string>();

export class Editor {
  declare document: EditorDocument;
  declare selectionIds: Set<string>;
  declare past: EditorDocument[];
  declare future: EditorDocument[];
  declare before: EditorDocument | null;
  declare revision: number;
  declare symmetric: boolean;
  declare snap: boolean;
  declare meets: Point[];
  declare onchange: ((event: EditorEvent) => void) | undefined;
  declare blockedEdit: BlockedEdit | null | undefined;
  declare compiled: CompiledSlot | null | undefined;
  declare weaponMovePreview: ModulePlacementPlan | null | undefined;
  declare choosable: { blueprint: CompiledConstruction; ids: Set<string> } | undefined;
  declare spans: { blueprint: CompiledConstruction; value: EditorPlateSpan[] } | undefined;
  declare planned: { blueprint: CompiledConstruction; asked: string; plan: ModulePlacementPlan } | undefined;
  declare chapa: { source: AuthoredConstruction; key: string; plan: PlatePlan } | undefined;
  declare laid: EdgeGesturePlan | undefined;
  declare platePlan: PlateGesturePlan | undefined;
  declare roomPlan: RoomGesturePlan | undefined;
  declare unjoined: { source: AuthoredConstruction; drawn: AuthoredConstruction } | undefined;
  declare root: { source: AuthoredConstruction; value: CompiledConstruction } | undefined;
  declare lastAssemblyMove: LastAssemblyMove | undefined;
  constructor(blueprint: ConstructionSource, projectId: string | null = null) {
    this.document = this.createDocument(blueprint, projectId);
    this.selection = null;
    this.past = [];
    this.future = [];
    this.before = null;
    this.revision = 0;
    // Symmetric editing (symmetry.ts): the frame edited on one side of the axis is edited mirrored on the other.
    this.symmetric = false;
    this.snap = true;
    // What the plates of the gesture previewed meet, in the field: the ends of plates they are joined to and the points
    // where plates are divided for them.
    this.meets = [];
  }
  // A design comes into the Oficina with its track on the floor, where every edit keeps it (chassis-editing.ts).
  createDocument(blueprint: ConstructionSource, projectId: string | null): EditorDocument {
    return { key: makeId('document'), projectId: projectId || makeId('design'), blueprint: validateDraftBlueprint(withTrackOnFloor(blueprint)) };
  }
  get source(): AuthoredConstruction { return this.document.blueprint; }
  get blueprint(): CompiledConstruction {
    if (this.compiled?.source !== this.source)
      this.compiled = { source: this.source, value: compileDraftConstruction(this.source) };
    return freezeRecord(this.compiled.value);
  }
  set blueprint(value: AuthoredConstruction) {
    if (value?.version !== DESIGN_VERSION || 'derived' in value && value.derived) throw new Error('Esse projeto não pode ser editado na Oficina.');
    this.document.blueprint = value; this.compiled = null;
  }
  // Confirmed UI refresh asks once. Drawing/drag previews only read this result;
  // a changed source naturally discards it with the existing projection slot. What fabrication refuses of the pieces, shown
  // on them: one with nothing to stand on, a road tool too high over the ground, a gun with no round of its calibre aboard;
  // and a box of a calibre no gun takes, which it does not refuse (structured-editing.ts `MARKED_ISSUES`).
  reviewManufacture() {
    const blueprint = this.blueprint;
    this.compiled!.manufacture ||= freezeRecord([...compileManufacture(this.source, benchSite(blueprint), true).compiled.admissionIssues
      .filter(issue => MARKED_ISSUES.has(issue.code)), ...idleAmmunition(blueprint)]);
    return this.compiled!.manufacture;
  }
  get manufactureIssues() { return this.compiled?.source === this.source ? this.compiled!.manufacture ?? [] : []; }
  get projectId() { return this.document.projectId; }
  get documentKey() { return this.document.key; }
  begin() {
    if (!this.before) { this.before = structuredClone(this.document); this.weaponMovePreview = null; this.meets = []; }
  }
  publish() { this.revision++; this.onchange?.({ kind: 'document' }); }
  preview() { this.onchange?.({ kind: 'preview' }); }
  previewAppearance(appearance: ConstructionAppearance) {
    this.begin();
    const physical = this.blueprint, manufacture = this.compiled!.manufacture;
    this.document.blueprint = { ...this.source, appearance };
    // Appearance cannot change derived geometry. Retain that projection while a gesture is held; commit still
    // readmits the full document through the native compiler, just like imported and published projects.
    this.compiled = { source: this.source, value: { ...physical, appearance: structuredClone(appearance) }, manufacture };
    this.preview();
  }
  // A construction an edit proposes, as the core admits it: refused where it would leave a road tool too high over the
  // ground (structured-editing.ts `refuseToolsTooHigh`) where the construction the edit began from had none so.
  validateConstruction(candidate: AuthoredConstruction): AuthoredConstruction {
    const next = validateDraftConstruction(candidate);
    refuseToolsTooHigh(compileDraftConstruction(this.before?.blueprint ?? this.source), compileDraftConstruction(next));
    return next;
  }
  rejectEdit(error: unknown, { ids = [...this.selectionIds], polygons = [], points = [] }: EditFeedback = {}) {
    const refused = isNativeAdmissionIssue(error) ? error.ids ?? [] : [],
      pieces = this.pieces.filter(piece => refused.includes(piece.id) || refused.some(id => piece.id.startsWith(id + ':')));
    // A point refused is shown where it stands, and a stretch of the chassis as its frame.
    const stretches = ids.filter(key => pointOf(key)?.kind === 'stretch'), spots = ids.filter(key => pointOf(key) && !stretches.includes(key));
    this.blockedEdit = { message: constructionEditMessage(error), ids: [...new Set([...ids, ...pieces.map(piece => piece.id)])],
      polygons: [...polygons, ...stretches.flatMap(key => { const point = pointOf(key); return point && point.kind !== 'node' ? [this.chassisStretch(point.index)] : []; }).filter(polygon => polygon.length)],
      points: [...points, ...spots.map(key => this.pointPlace(key)).filter((point): point is Point => Boolean(point))], until: Date.now() + 1400 };
    this.onchange?.({ kind: 'feedback' });
  }
  editProperty<K extends PieceProperty>(key: K, value: PiecePropertyValues[K], commit?: boolean): void;
  editProperty(...[key, value, commit = false]: PropertyEdit): void {
    if (!this.selected) return;
    let next;
    const plate = this.source.plates.find(p => p.id === this.selection), part = this.source.components.find(p => p.id === this.selection);
    if (this.selection === CHASSIS_ID || chassisTopPlate(this.selection)) next = this.validateConstruction(withPieceProperty(this.source, this.selection!, key, value));
    else if (plate) {
      if (!['material', 'thicknessMm', 'angle', 'length'].includes(key)) throw new Error('A forma da blindagem muda arrastando nós e chapas.');
      next = this.validateConstruction(joinContacts(withPieceProperty(this.source, plate.id, key, value)).source);
    } else if (part) {
      if (key === 'sizeScale' && part.kind === 'weapon') throw new Error('O tamanho do armamento é definido pelo modelo e calibre.');
      // A material there is, on a piece that may not be made of it; one there is not, the compiler refuses. So is a way of
      // detecting that a sensor of its material may not have, as a radar of plastic.
      if (key === 'metal' && METALS[value] && !takesMetal(part, value)) throw new Error(metalRefusal(part, value));
      const detecting = key === 'sensorMode' && part.kind === 'sensor' && { ...part, sensorMode: value };
      if (detecting && !takesMetal(detecting, metalOf(part).id)) throw new Error(metalRefusal(detecting, metalOf(part).id));
      if (key === 'weaponAmmo' && (part.kind !== 'weapon' || !allowedAmmo(part.weaponPreset).includes(value))) throw new Error('Essa arma não dispara essa munição.');
      if (!['sizeScale', 'metal', 'weaponPreset', 'weaponAmmo', 'sensorMode', 'ammoPreset', 'mountPreset', 'sectorMin', 'sectorMax', 'angle'].includes(key))
        throw new Error('A peça não tem esse ajuste. Para mudá-la de lugar, arraste-a.');
      if (['mountPreset', 'sectorMin', 'sectorMax'].includes(key)) {
        if (part.kind !== 'weapon') throw new Error('Só armas têm montagem e setor de tiro.');
        if (key === 'mountPreset') next = remountStructuredWeapon(this.source, part, value);
        else {
          const changed = withPieceProperty(this.source, part.id, key, value).components.find(other => other.id === part.id)!;
          next = planStructuredComponent(this.source, changed).construction;
        }
      } else if (key === 'weaponAmmo') {
        // The guns of one calibre are fed one ammunition: choosing it for one chooses it for them all.
        const fired = cartridgeId(part.kind === 'weapon' ? part.weaponPreset ?? 'rh120' : 'rh120');
        next = this.validateConstruction({ ...this.source, components: this.source.components.map(other =>
          other.kind === 'weapon' && cartridgeId(other.weaponPreset ?? 'rh120') === fired ? { ...other, weaponAmmo: value } : other) });
      } else if (key === 'weaponPreset') {
        if (part.kind !== 'weapon') throw new TypeError('O componente não tem montagem.');
        const mount = WEAPON_MOUNTS[part.mount!.preset!], options = compatibleWeaponMounts(value),
          keeps = options.some(([id]) => id === part.mount!.preset!),
          // Preserve a compatible mounting category when changing weapon family.
          mountPreset = (options.find(([, other]) => other.surface === mount?.surface) || options.find(([id]) => id === defaultWeaponMount(value)))?.[0]
            ?? defaultWeaponMount(value),
          // The author's sector goes with it to the new mount, and the ammunition if the new gun takes it: the one the
          // other guns of its calibre are fed, where it has any, for a calibre is fed one. Its mantlet is sized anew for
          // it, on its mount or another (structured-editing.ts `withPieceProperty`).
          mounted = (keeps ? withPieceProperty(this.source, part.id, 'weaponPreset', value) : withPieceProperty(this.source, part.id, 'mountPreset', mountPreset))
            .components.find((other): other is Extract<typeof other,{kind:'weapon'}> => other.id === part.id && other.kind === 'weapon')!,
          { weaponAmmo: own, ...kept } = mounted,
          // Of a calibre are the guns that fire one cartridge (weapons.ts `cartridgeId`): a gun made over with a longer
          // barrel, or more of them, fires the rounds of the gun it was made of.
          [was, will] = [cartridgeId(part.weaponPreset ?? 'rh120'), cartridgeId(value)],
          alike = this.source.components.find(other => other.kind === 'weapon' && other.id !== part.id && cartridgeId(other.weaponPreset ?? 'rh120') === will),
          weaponAmmo = alike ? fedAmmo(alike) : own,
          swapped = { ...kept, weaponPreset: value, ...(weaponAmmo !== undefined && allowedAmmo(value).includes(weaponAmmo) ? { weaponAmmo } : {}) },
          placed = planStructuredComponent(this.source, swapped).construction,
          // The boxes that fed the gun replaced alone feed the new one: they take its calibre, and with it the rounds it is
          // fed and as many of them as they hold (game_construction.rs). They stay where another gun still takes theirs.
          shared = placed.components.some(other => other.kind === 'weapon' && other.id !== part.id && cartridgeId(other.weaponPreset ?? 'rh120') === was);
        next = shared || will === was ? placed : this.validateConstruction({ ...placed, components: placed.components.map(other =>
          other.kind === 'ammo' && (other.ammoPreset ?? 'rh120') === was ? { ...other, ammoPreset: will } : other) });
      } else next = planStructuredComponent(this.source, withPieceProperty(this.source, part.id, key, value).components.find(other => other.id === part.id)!).construction;
    }
    if (!next) return;
    refuseToolsTooHigh(compileDraftConstruction(this.before?.blueprint ?? this.source), compileDraftConstruction(next));
    this.begin(); this.blueprint = next; this.blockedEdit = null;
    if (commit) this.commit(); else this.preview();
    return;
  
  }
  commit() {
    if (!this.before) return false;
    if (this.weaponMovePreview?.refused) { this.cancel(); return false; }
    let changed = JSON.stringify(this.before) !== JSON.stringify(this.document);
    if (changed) {
      try {
        const previous = this.before.blueprint;
        if (previous.appearance?.automaticDetails === undefined && this.source.appearance?.automaticDetails === undefined &&
            JSON.stringify(previous.appearance?.details) === JSON.stringify(this.source.appearance?.details) &&
            (['nodes', 'plates', 'components', 'chassis'] as const).some(key => JSON.stringify(previous[key]) !== JSON.stringify(this.source[key]))) {
          const frozen = automaticFinish(compileDraftConstruction(previous));
          this.document.blueprint = { ...this.source, appearance: { ...this.source.appearance!, details: frozen.details!, automaticDetails: true } };
          this.compiled = null;
        }
        this.blueprint = this.validateConstruction(this.source);
        changed = JSON.stringify(this.before) !== JSON.stringify(this.document);
      }
      catch (error) { this.cancel(); this.select([...this.selectionIds]); throw error; }
    }
    if (changed) {
      this.past.push(this.before);
      if (this.past.length > 80) this.past.shift();
      this.future = [];
    }
    this.before = null;
    this.weaponMovePreview = null;
    if (changed) this.publish();
    return changed;
  }
  cancel() {
    this.weaponMovePreview = null;
    if (!this.before) return;
    this.document = this.before;
    this.before = null;
    this.publish();
  }
  change(action: (source: AuthoredConstruction) => void) {
    this.begin(); this.compiled = null;
    try { action(this.source); this.compiled = null; this.commit(); }
    catch (error) { this.compiled = null; this.cancel(); throw error; }
  }
  restore(backward: boolean) {
    this.commit();
    const from = backward ? this.past : this.future;
    const to = backward ? this.future : this.past;
    if (!from.length) return false;
    to.push(structuredClone(this.document));
    this.document = from.pop()!;
    this.selection = null;
    this.publish();
    return true;
  }
  undo() { return this.restore(true); }
  redo() { return this.restore(false); }
  replace(blueprint: ConstructionSource, projectId: string | null = null): void {
    this.commit();
    this.change(() => { this.document = this.createDocument(blueprint, projectId); });
    this.selection = null; this.blockedEdit = null;
  }
  // Saved as a new project, the open document is that project now, and so is the history that led to it: undoing
  // goes back through its own edits, and the project it was saved from keeps what the garage has of it.
  adopt(projectId: string) {
    const from = this.projectId;
    for (const document of [this.document, ...this.past, ...this.future]) if (document.projectId === from) document.projectId = projectId;
  }
  // A removed project cannot return through undo. Switching away from it must
  // discard its preview rather than commit or add that document to history.
  forgetProject(id: string, replacement: {id:string;blueprint:ConstructionSource} | null = null) {
    let next = null;
    if (this.projectId === id) {
      if (typeof replacement?.id !== 'string' || !replacement.id || replacement.id === id)
        throw new Error('Escolha outro projeto para substituir o projeto removido.');
      next = this.createDocument(replacement.blueprint, replacement.id);
    }
    this.past = this.past.filter(document => document.projectId !== id);
    this.future = this.future.filter(document => document.projectId !== id);
    if (!next) return false;
    this.document = next; this.before = null; this.compiled = null;
    this.selectionIds.clear(); this.blockedEdit = null;
    this.publish(); return true;
  }
  get selection(): string | null { return [...this.selectionIds].at(-1) || null; }
  set selection(id: string | null) {
    this.selectionIds = new Set(id ? [id] : []);
    this.onchange?.({ kind: 'selection' });
  }
  get pieces(): CompiledPiece[] { const blueprint = this.blueprint; return [...blueprint.plates, ...blueprint.modules]; }
  get selectedPieces(): CompiledPiece[] { return this.pieces.filter(p => this.selectionIds.has(p.id)); }
  // What may be selected: the pieces, and the points of the frame (frame-points.ts) — the ends of plates, the points of
  // the chassis and its stretches.
  selectable() {
    const blueprint = this.blueprint;
    if (this.choosable?.blueprint !== blueprint) {
      const points = this.source.chassis?.points || [], ends = new Set(this.source.plates.flatMap(plate => [plate.a, plate.b]));
      this.choosable = { blueprint, ids: new Set([...this.pieces.map(p => p.id), ...[...ends].map(nodeKey),
        ...points.map((_, i) => vertexKey(i)), ...points.slice(1).map((_, i) => stretchKey(i))]) };
    }
    return this.choosable.ids;
  }
  select(selection: string | readonly string[] | null | undefined, { additive = false, toggle = false } = {}) {
    const ids = typeof selection === 'string' ? [selection] : selection ?? [];
    const valid = this.selectable();
    if (!additive && !toggle) this.selectionIds.clear();
    for (const id of ids) if (valid.has(id)) {
      if (toggle && this.selectionIds.has(id)) this.selectionIds.delete(id);
      else { this.selectionIds.delete(id); this.selectionIds.add(id); }
    }
    this.onchange?.({ kind: 'selection' });
  }
  selectBox(start: Point, end: Point, additive = false) {
    const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x),
      minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y),
      box = rectangle((minX + maxX) / 2, (minY + maxY) / 2, maxX - minX, maxY - minY, 0),
      inside = (p: Point) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    const ids = [...new Set(this.pieces.filter(p => {
      const polygons = [piecePolygon(p), ...('kind' in p && p.kind === 'weapon' ? [weaponBarrelPolygon(p)] : [])];
      return polygons.some(poly => poly.some(inside) || box.some(q => containsPoint(p, q)) ||
        box.some((q, i) => segmentConvex(q, box[(i + 1) % 4]!, poly)));
    }).map(p => chassisPart(p.id) ? CHASSIS_ID : p.id))];
    this.select(ids, { additive }); return ids;
  }
  captureSelection(): SelectionPose[] {
    const ids = new Set(assemblySelection(this.source, this.selectionIds));
    return [...this.pieces.filter(p => ids.has(p.id)).map(p => ({ id: p.id, x: p.x, y: p.y, angle: p.angle || 0 })),
      ...[...this.selectionIds].filter(pointOf).map(key => ({ id: key, ...this.pointPlace(key)!, angle: 0 }))];
  }
  // Where a point of the selection stands in the field: a node, the grip of a point of the chassis, the middle of the top
  // of a stretch of it.
  pointPlace(key: string): Point | null {
    const point = pointOf(key);
    if (point?.kind === 'node') { const node = this.nodes().find(node => node.id === point.id); return node ? { x: node.x, y: node.y } : null; }
    if (point?.kind === 'vertex') { const spot = this.chassisPoints()[point.index]; return spot ? { x: spot.x, y: spot.y } : null; }
    const [a, b] = point?.kind === 'stretch' ? this.chassisStretch(point.index) : [];
    return a ? { x: (a.x + b!.x) / 2, y: (a.y + b!.y) / 2 } : null;
  }
  // Grid assistance changes one rigid delta for the selection. Without it,
  // plates, equipment and chassis points retain the requested physical move.
  moveSelection(original: readonly SelectionPose[], dx: number, dy: number, { faceTolerance = 0, joinReach = 0 } = {}) {
    if (!original.length || !Number.isFinite(dx + dy)) return false;
    const source = this.before?.key === this.document.key ? this.before.blueprint : this.source,
      weapon = original.length === 1 && source.components.find((part): part is Extract<typeof part,{kind:'weapon'}> => part.id === original[0]!.id && part.kind === 'weapon');
    if (weapon) {
      const before = original[0]!, plan = planStructuredWeaponPlacement(source, weapon, { x: before.x + dx, y: before.y + dy },
        { from: before, snap: this.snap, faceTolerance });
      this.weaponMovePreview = plan;
      if (!plan.source) {
        const module = plan.module;
        this.rejectEdit(plan.error, { ids: [weapon.id], polygons: module ? [piecePolygon(module), weaponBarrelPolygon(module)] : [] });
        return false;
      }
      this.blueprint = plan.source; this.blockedEdit = null; return true;
    }
    this.weaponMovePreview = null;
    if (this.snap) { dx = metresOf(cellOf(dx)); dy = metresOf(cellOf(dy)); }
    if (original.length > 1 || original.some(part => pointOf(part.id) || this.source.plates.some(plate => plate.id === part.id)))
      return this.moveAssembly(original, dx, dy, joinReach);
    if (faceTolerance > 0) {
      const before = original[0]!, component = this.blueprint.modules.find(part => part.id === before.id);
      if (component) {
        const point = componentFaceSnap({ ...component, ...before, x: before.x + dx, y: before.y + dy }, this.blueprint.plates, faceTolerance);
        dx = point.x - before.x; dy = point.y - before.y;
      }
    }
    return this.transformSelection(original, p => ({ x: p.x + dx, y: p.y + dy }));
  }
  // The selection moved (dx, dy) metres; its loose ends within `joinReach` of an end or a plate that stays land there
  // (Editor.admitLanding).
  moveAssembly(original: readonly SelectionPose[], dx: number, dy: number, joinReach = 0) {
    const source = this.before?.key === this.document.key ? this.before.blueprint : this.source;
    const previous = this.lastAssemblyMove;
    if (previous?.original === original && previous.source === source && previous.current === this.source && previous.dx === dx && previous.dy === dy &&
      previous.joinReach === joinReach) return previous.accepted;
    const remember = (accepted: boolean) => {
      this.lastAssemblyMove = { original, source, current: this.source, dx, dy, joinReach, accepted }; return accepted;
    };
    // A point of the chassis selected goes with the selection, and so do both ends of a stretch of it; in symmetric
    // editing, what stands across the axis goes the other way.
    const ids = original.map(part => part.id), { nodes, vertices, stretches } = selectedPoints(ids),
      { turned, ways } = this.symmetric ? symmetricMove(source, ids)
        : { turned: null, ways: new Map([...vertices, ...stretches.flatMap(index => [index, index + 1])].map(index => [index, 1])) },
      moved = (ox: number, oy: number) => {
        const across = unitsOf(dx) + ox, up = unitsOf(dy) + oy;
        let next = moveFrameSelection(source, ids, across, up, nodes, turned);
        for (const way of [1, 0, -1]) next = withChassisPointsMoved(next, [...ways].filter(([, at]) => at === way).map(([index]) => index), way * across, up);
        return next;
      };
    try {
      this.admitLanding(source, moved, joinReach); return remember(true);
    } catch (error) {
      if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error;
      const polygons = original.filter(before => !pointOf(before.id)).flatMap(before => {
          const part = this.pieces.find(piece => piece.id === before.id)!, pose = { ...part, x: before.x + dx, y: before.y + dy };
          return [piecePolygon(pose), ...('kind' in part && part.kind === 'weapon' ? [weaponBarrelPolygon(pose)] : [])];
        }), points = original.filter(before => pointOf(before.id)).map(before => ({ x: before.x + dx, y: before.y + dy }));
      this.rejectEdit(error, { ids: ids.filter(id => !pointOf(id)), polygons, points }); return remember(false);
    }
  }
  transformSelection(original: readonly SelectionPose[], transform: (part: SelectionPose) => Point & {angle?:number}) {
    const source = this.before?.key === this.document.key ? this.before.blueprint : this.source;
    const next = moveStructuredComponents(source, original, transform, error => {
      const polygons = original.flatMap(before => {
        const part = this.pieces.find(piece => piece.id === before.id)!, pose = { ...part, ...transform(before) };
        return [piecePolygon(pose), ...('kind' in part && part.kind === 'weapon' ? [weaponBarrelPolygon(pose)] : [])];
      });
      this.rejectEdit(error, { ids: original.map(part => part.id), polygons });
    });
    if (!next) return false;
    this.blueprint = next; this.blockedEdit = null; return true;
  }
  get selected(): CompiledPiece | null { return this.pieces.find(p => p.id === this.selection) || null; }
  // The frame of the chassis picks the stretch of it pressed — its plate, the rail under it, the frame between the plates
  // it is made of as it is drawn, or a gap where it has none —; its nose, wheels or track pick the whole chassis.
  pick(point: Point, tolerance = 0.06): string | null {
    const id = pickPiece(this.blueprint.plates, this.blueprint.modules, point, tolerance), stretch = /^chassis:(?:frame|rail)-(\d+)$/.exec(id ?? '');
    if (stretch) return stretchKey(Number(stretch[1]));
    if (id) return chassisPart(id) ? CHASSIS_ID : id;
    const index = this.chassisStretchAt(point, tolerance);
    return index === null ? null : stretchKey(index);
  }
  // What a cursor is told of a place is asked once for the place: a pointer that moves within a cell of the grid
  // asks the same again.
  planModule(kind: ModuleKind | 'plate', point: Point, options: ModulePlacementOptions = {}): ModulePlacementPlan {
    options = { snap: this.snap, ...(kind === 'weapon' && !options.copies && !options.sector && options.sectorMin === undefined && options.sectorMax === undefined ? {compactSector:true} : {}), ...options };
    const asked = JSON.stringify([kind, point, options]), blueprint = this.blueprint;
    if (this.planned?.blueprint !== blueprint || this.planned.asked !== asked)
      this.planned = { blueprint, asked, plan: planStructuredModule(this.source, kind, point, options) };
    return this.planned.plan;
  }
  addModule(kind: ModuleKind | 'plate', point: Point, options: ModulePlacementOptions = {}) {
    const plan = this.planModule(kind, point, options);
    // The refusal as the compiler made it, so the pieces it names are shown; its words are the player's when told.
    if (!plan.source) throw plan.error || new Error(plan.reason);
    this.change(() => { this.blueprint = plan.source; });
    this.select(plan.ids); return plan.module || this.selected;
  }
  // A new plate from `from` to `to`, in the field, as Chapa draws it: an end on an end of plates (`nodeId`) is joined to
  // it, one on a plate (`surfaceId`) stands on its line, and any other on the cell it falls in, with the grid. In the
  // armour given, else in that of the plate selected; in symmetric editing, with one across the axis. The plates it
  // meets are divided where it meets them. What it makes — the document, its projection and its plates — and what it
  // meets (`meets`, in the field), or its refusal; asked once for the same ends.
  planPlate(from: PlateEndpoint, to: PlateEndpoint, armour: PlateArmour | null = null): PlatePlan {
    const source = this.source, key = JSON.stringify([from, to, armour, this.selection, this.snap, this.symmetric]);
    if (this.chapa?.source === source && this.chapa.key === key) return this.chapa.plan;
    const position = (point: PlateEndpoint) => {
      if (!point.nodeId) return this.local(source, point, this.snap && !point.surfaceId);
      const node = source.nodes.find(node => node.id === point.nodeId);
      if (!node) throw frameRefusal('A ponta escolhida não está mais no projeto.');
      return { x: node.x, y: node.y, nodeId: node.id };
    }, selected = source.plates.find(plate => plate.id === this.selection),
      chosen = armour || (selected ? { material: selected.material, thicknessMm: selected.thicknessMm } : undefined);
    let plan: PlatePlan;
    try {
      const result = addPlate(source, position(from), position(to), chosen),
        draft = joinedDraft(this.symmetric ? platesAcross(result.source, [result.plateId]).source : result.source);
      plan = { source: draft.construction, compiled: draft.compiled, plateIds: draft.parts.get(result.plateId) ?? [result.plateId], meets: draft.divisions };
    } catch (error) {
      if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error;
      plan = { refusal: error, meets: [], polygons: [plateCorners({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, length: Math.hypot(to.x - from.x, to.y - from.y),
        thicknessMm: chosen?.thicknessMm ?? 20, angle: Math.atan2(to.y - from.y, to.x - from.x) })] };
    }
    this.chapa = { source, key, plan }; return plan;
  }
  // The plate Chapa draws, shown as it would be made: what it meets is lit, a refusal shown where it would be.
  previewPlate(from: PlateEndpoint, to: PlateEndpoint) {
    const plan = this.planPlate(from, to);
    this.meets = plan.meets;
    if ('refusal' in plan) this.rejectEdit(plan.refusal, { ids: [], polygons: plan.polygons! }); else this.blockedEdit = null;
    return plan;
  }
  addPlate(from: PlateEndpoint, to: PlateEndpoint, armour: PlateArmour | null = null) {
    const plan = this.planPlate(from, to, armour);
    if ('refusal' in plan) throw told(plan.refusal);
    this.change(() => { this.blueprint = plan.source; }); this.select(plan.plateIds[0]);
    return this.selected;
  }
  // Duplication is an installation intent. No geometry or history changes
  // until addModule confirms the cursor placement.
  duplicate(): EditorDuplicate | undefined {
    const selected = new Set(this.selectionIds), compiled = this.blueprint,
      nodes = new Map(compiled.frame.nodes.map(node => [node.id, node])),
      parts = this.source.components.filter(part => selected.has(part.id)),
      plates = [...this.source.plates.filter(plate => selected.has(plate.id)),
        ...compiled.frame.plates.filter(plate => chassisTopPlate(plate.id) && selected.has(plate.id)).map(span => {
          const {material,thicknessMm}=compiled.plates.find(plate=>plate.id===span.id)!;
          return {id:span.id,a:span.a,b:span.b,material,thicknessMm};
        })];
    if (!parts.length && !plates.length) return;
    if (this.source.components.length + parts.length > PART_LIMITS.components || this.source.plates.length + plates.length > PART_LIMITS.plates)
      throw new Error(CAPACITY);
    const copies = parts.map(part => {
      const { id, ...component } = structuredClone(part), pose = compiled.modules.find(module => module.id === id)!;
      return { component, x: pose.x, y: pose.y, angle: pose.angle || 0 };
    }), spans = plates.map(plate => ({ plate: structuredClone(plate), a: { ...nodes.get(plate.a)! }, b: { ...nodes.get(plate.b)! } })),
      anchor = copies[0] || spans[0]!.a;
    return { kind: copies[0]?.component.kind || 'plate', copies, plates: spans, anchor: { x: anchor.x, y: anchor.y } };
  }
  // Removing a piece never implicitly removes its contents or neighbours. A point goes as a double click takes it: an
  // end between two plates joins them in one, a point of the chassis lets the line run straight past it; a stretch of
  // the chassis removed is a gap, and a gap removed is chassis again; they stay selected, unless a point of the chassis
  // went with them. All of it is one edit. In symmetric editing what of the frame stands across the axis goes too, as far
  // as it can: an end across that joins no two plates, or the end of the chassis across, stays.
  remove() {
    const source = this.source, chosen = [...this.selectionIds], ids = new Set(this.symmetric ? withAcross(source, chosen) : chosen),
      plates = source.plates.filter(plate => ids.has(plate.id)).map(plate => plate.id), named = selectedPoints(chosen),
      { nodes, vertices } = selectedPoints(ids), points = source.chassis?.points || [], end = (index: number) => !index || index === points.length - 1,
      floor = chosen.some(chassisTopPlate),
      rest = { ...(floor ? withChassisTopMaterial(source,'none') : source),
        components: source.components.filter(part => !ids.has(part.id)) };
    if (!floor && !plates.length && rest.components.length === source.components.length && !nodes.length && !vertices.length && !named.stretches.length) return;
    if (named.vertices.some(end)) throw frameRefusal('As pontas do chassi não saem: arraste-as para mudar o comprimento.');
    let next = plates.length ? removePlates(rest, plates) : rest;
    for (const id of nodes) if (next.nodes.some(node => node.id === id)) {
      try { next = removeNode(next, id).source; }
      catch (error) { if (named.nodes.includes(id) || (!isConstructionError(error) || error.code !== 'FRAME_EDIT')) throw told(error); }
    }
    // A stretch across the axis becomes what the one chosen becomes.
    const gaps = new Map<number, boolean>();
    for (const index of named.stretches) {
      const gap = !points[index]!.gap, other = this.symmetric ? stretchAcross(source, index) : null;
      gaps.set(index, gap); if (other !== null && !gaps.has(other)) gaps.set(other, gap);
    }
    for (const [index, gap] of gaps) next = withChassisGap(next, index, gap);
    for (const index of vertices.filter(index => !end(index)).toSorted((a, b) => b - a)) next = withChassisPointRemoved(next, index);
    next = next === rest ? rest : this.admitted(next);
    this.change(() => { this.blueprint = next; }); this.select(vertices.length ? [] : named.stretches.map(stretchKey));
  }
  // The ends of plates selected made one point where the first of them is; one end alone is joined with the ends just
  // where it is. The point stays selected. In symmetric editing the ends across the axis are joined as well, where the
  // first of them is, when each has one and none is on the axis. Plates the joined ends then meet are divided there. They
  // are joined in `source`, the document as it is unless a drop joins them in the drag it ends (joinDroppedNode).
  joinPoints(mirrorSource = this.source, source = this.source) {
    const { nodes } = selectedPoints(this.selectionIds), ids = nodes.length === 1 ? [nodes[0]!, ...coincidentNodes(source, nodes[0]!)] : nodes;
    if (ids.length < 2) throw frameRefusal(nodes.length ? 'Nenhuma outra ponta neste ponto: escolha mais pontas com Shift.' : 'Escolha as pontas de chapa para juntar.');
    const across = this.symmetric ? ids.map(id => nodeAcross(mirrorSource, id)) : [];
    let joined; try { joined = joinNodes(source, ids); } catch (error) { throw told(error); }
    if (across.length && across.every((id): id is string => Boolean(id && !ids.includes(id))) && new Set(across).size > 1) {
      try { joined = { ...joined, source: joinNodes(joined.source, across).source }; } catch (error) { throw told(error); }
    }
    const next = this.admitted(joined.source), kept = [...this.selectionIds].filter(key => pointOf(key)?.kind !== 'node');
    this.change(() => { this.blueprint = next; }); this.select([...kept, nodeKey(joined.nodeId)]);
    return true;
  }
  // A point deliberately dropped onto another end becomes one joint. A click, a refused move or a return to the
  // original position leaves independent ends alone; plates moved or copied whole land their loose ends as they are
  // previewed instead (Editor.admitLanding). The ends are joined in the drag as it was before the plates it met were
  // divided for it: joined, they meet others.
  joinDroppedNode(hit: EditorNodeHit, reach = 0) {
    const others = this.dropTarget(hit, reach);
    if (!others.length) return false;
    this.select([others[0]!, ...[hit.id, ...coincidentNodes(hit.source, hit.id)], ...others.slice(1)].map(nodeKey));
    // Resolve the mirrored ends before the drag made their positions coincide.
    return this.joinPoints(hit.source, this.dragged());
  }
  // The document a frame drag previews, as it was before the plates it meets were divided for it (Editor.proposeFrame).
  dragged() { return this.unjoined?.source === this.source ? this.unjoined.drawn : this.source; }
  // The ends the end `hit`, dragged where it is now, would be joined with if let go there (joinDroppedNode): those it
  // stands on, or else the nearest within `reach` and those standing with it; the first is where they join. None for an
  // end not moved or refused, nor for the ends of its own plates.
  dropTarget(hit: EditorNodeHit, reach = 0) {
    const source = this.dragged(), before = hit?.source?.nodes.find(node => node.id === hit.id), node = source.nodes.find(node => node.id === hit?.id);
    if (!before || !node || samePlace(before, node) || this.blockedEdit) return [];
    const sharing = new Set([hit.id, ...coincidentNodes(hit.source, hit.id)]),
      linked = new Set(source.plates.filter(plate => sharing.has(plate.a) || sharing.has(plate.b)).flatMap(plate => [plate.a, plate.b])),
      linkedPoints = source.nodes.filter(point => linked.has(point.id)),
      available = source.nodes.filter(point => !linkedPoints.some(linked => samePlace(point, linked))),
      allowed = new Set(available.map(point => point.id)),
      others = coincidentNodes(source, hit.id).filter(id => !linked.has(id));
    if (others.length || !(reach > 0)) return others;
    const nearest = available.map(point => ({ node: point, distance: metresOf(Math.hypot(point.x - node.x, point.y - node.y)) }))
      .filter(candidate => candidate.distance <= reach)
      .sort((a, b) => a.distance - b.distance)[0]?.node;
    return nearest ? [nearest.id, ...coincidentNodes(source, nearest.id).filter(id => allowed.has(id))] : [];
  }
  // The edge under `point` new plates may be laid along (edge-plates.ts): a plate, in its own armour, or the top of the
  // chassis, in that of the plate selected or else of the plate nearest; with how far along it `point` is. Like a
  // handle, it remembers the document it was taken from.
  pickEdge(point: Point, tolerance = .08): EditorEdgeHit | null {
    const span = this.pickPlate(point, tolerance), spans = this.plateSpans();
    let edge: PlateEdge | null = null, armour: PlateArmour | null = null;
    if (span) {
      armour = { material: span.material, thicknessMm: span.thicknessMm };
      edge = plateEdge(spans, span.id, point, armour.thicknessMm);
    } else if (this.source.chassis && this.chassisStretchAt(point, tolerance) !== null) {
      const chosen = spans.find(other => other.id === this.selection) || spans.reduce<(EditorPlateSpan & {distance:number}) | null>((best, other) => {
        const near = closestSegment(point, other.a, other.b), distance = Math.hypot(near.x - point.x, near.y - point.y);
        return !best || distance < best.distance ? { ...other, distance } : best;
      }, null);
      armour = chosen ? { material: chosen.material, thicknessMm: chosen.thicknessMm } : { material: 'steel', thicknessMm: 20 };
      edge = chassisEdge(this.chassisPoints(), armour.thicknessMm);
    }
    return edge && { ...edge, armour: armour!, at: alongEdge(edge, point), source: this.source };
  }
  // New plates along `edge` from `from` to `to` metres along it, previewed from the document the edge came from; their
  // ids, or null for a pull too short or refused, the refusal shown where they would be. In symmetric editing they stop
  // at the axis, and the same are laid across it. Plates they meet are divided there (`meets`), and so are they.
  layPlates(edge: EditorEdgeHit, from: number, to: number) {
    const source = edge.source, origin = this.rooted(source).frame.origin, local = (point: Point) => ({ x: point.x - origin.x, y: point.y - origin.y }),
      points = edge.points.map(local);
    if (this.symmetric) to = untilAxis(points, from, to);
    const key = [from, to, this.symmetric, this.snap].join(':');
    if (Math.abs(to - from) < .08) {
      if (this.source !== source) this.blueprint = source;
      this.blockedEdit = null; return null;
    }
    let plan = this.laid;
    if (plan?.edge !== edge || plan.key !== key) {
      plan = { edge, key, laid: null, refusal: null, polygons: [] };
      let proposed: {source:AuthoredConstruction;plateIds:string[];shown?:string[]} | null = null;
      try {
        proposed = platesAlong(source, { points, offsets: edge.offsets }, from, to, { ...edge.armour, snap: this.snap });
        const across = this.symmetric ? platesAcross(proposed.source, proposed.plateIds) : null;
        if (across) proposed = { source: across.source, plateIds: proposed.plateIds, shown: [...proposed.plateIds, ...across.plateIds] };
        const draft = joinedDraft(proposed.source);
        plan.laid = { source: draft.construction, compiled: draft.compiled, plateIds: proposed.plateIds.flatMap(id => draft.parts.get(id) ?? [id]),
          meets: draft.divisions };
      } catch (error) {
        if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error;
        plan.refusal = error;
        if (proposed) plan.polygons = (proposed.shown ?? proposed.plateIds).map(id => {
          const plate = proposed!.source.plates.find(other => other.id === id)!, points = [plate.a, plate.b]
            .map(end => proposed!.source.nodes.find(node => node.id === end)!).map(node => ({ x: metresOf(node.x) + origin.x, y: metresOf(node.y) + origin.y })), a = points[0]!, b = points[1]!;
          return plateCorners({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, length: Math.hypot(b.x - a.x, b.y - a.y),
            thicknessMm: plate.thicknessMm, angle: Math.atan2(b.y - a.y, b.x - a.x) });
        });
      }
      this.laid = plan;
    }
    if (plan.laid) {
      this.blueprint = plan.laid.source; this.compiled = { source: this.source, value: plan.laid.compiled };
      this.blockedEdit = null; this.meets = plan.laid.meets; return plan.laid.plateIds;
    }
    if (this.source !== source) this.blueprint = source;
    this.rejectEdit(plan.refusal, { ids: [], polygons: plan.polygons });
    return null;
  }
  // A new plate drawn from the end of plates `hit` towards `to` in the field, previewed from the document the end was
  // taken from. It starts on that very node, joined to it, in the armour of the thickest plate ending there (of those as
  // thick, the first). It ends where an end let go there would rest: on a plate near `to`, as an end dragged rests
  // (Editor.framePoint), other than those of the end it starts from, or else on the cell `to` falls in, held in the
  // construction box; and as one let go joins (Editor.dropTarget), on an end of plates within `reach` of `to` or of
  // where it rests, joined to it. In symmetric editing it stops at the axis, and the same is drawn across it. The plates
  // it meets are divided where it meets them, and so is it. Its ids, or null for a pull too short to be a plate or
  // refused, the refusal shown where it would be; what it meets — the end of plates its end is joined to and the points
  // where plates are divided — is told in `meets`, in the field.
  drawPlate(hit: EditorNodeHit, to: Point, reach = 0) {
    this.meets = [];
    const source = hit?.source ?? this.source, nodeOf = (id: string) => source.nodes.find(node => node.id === id)!, start = nodeOf(hit?.id);
    if (!start || !Number.isFinite(to?.x + to?.y)) return null;
    const origin = this.rooted(source).frame.origin, field = (point: Point) => ({ x: origin.x + metresOf(point.x), y: origin.y + metresOf(point.y) }),
      own = source.plates.filter(plate => [plate.a, plate.b].some(id => samePlace(nodeOf(id), start))),
      armour = own.reduce<AuthoredPlate | null>((best, plate) => !best || plate.thicknessMm > best.thicknessMm ? plate : best, null),
      rest = this.framePoint(to, reach, { source, excluded: new Set(own.map(plate => plate.id)) }),
      cell = this.local(source, rest, this.snap && !rest.surfaceId),
      placed = rest.surfaceId ? { ...cell, surfaceId: rest.surfaceId }
        : { x: clamp(cell.x, REACH_CELLS.minX, REACH_CELLS.maxX), y: clamp(cell.y, REACH_CELLS.minY, REACH_CELLS.maxY) },
      ends = new Set(source.plates.flatMap(plate => [plate.a, plate.b])),
      // Joined to the end of plates nearest to the pointer or to where the end would rest, within reach of either.
      onto = reach > 0 ? source.nodes.filter(node => ends.has(node.id) && !samePlace(node, start)).map(node => {
        const at = field(node), there = field(placed);
        return { node, away: Math.min(Math.hypot(at.x - to.x, at.y - to.y), Math.hypot(at.x - there.x, at.y - there.y)) };
      }).filter(near => near.away <= reach).sort((p, q) => p.away - q.away)[0]?.node : null;
    let end: PlateEndpoint = onto ? { x: onto.x, y: onto.y, nodeId: onto.id } : placed;
    // From one side of the axis, it goes no further than the axis.
    if (this.symmetric && !onAxis(start.x) && end.x && Math.sign(end.x) !== Math.sign(start.x)) {
      const y = start.y + (end.y - start.y) * start.x / (start.x - end.x);
      end = { x: 0, y: this.snap ? Math.round(y) || 0 : y };
    }
    if (metresOf(Math.hypot(end.x - start.x, end.y - start.y)) < .08 - 1e-9) {
      if (this.source !== source) this.blueprint = source;
      this.blockedEdit = null; return null;
    }
    const key = [hit.id, end.x, end.y, end.nodeId, end.surfaceId, this.symmetric].join(':');
    let plan = this.platePlan;
    if (plan?.source !== source || plan.key !== key) {
      const corners = (a: Point, b: Point) => plateCorners({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, length: Math.hypot(b.x - a.x, b.y - a.y),
          thicknessMm: armour!.thicknessMm, angle: Math.atan2(b.y - a.y, b.x - a.x) }),
        drawn = [[start, end], ...this.symmetric ? [[mirrored(start), mirrored(end)]] : []];
      plan = { source, key, drawn: null, refusal: null, polygons: drawn.map(([a, b]) => corners(field(a!), field(b!))) };
      try {
        const added = addPlate(source, { ...start, nodeId: start.id }, end, { material: armour!.material, thicknessMm: armour!.thicknessMm }),
          draft = joinedDraft(this.symmetric ? platesAcross(added.source, [added.plateId]).source : added.source),
          far = nodeOf(added.source.plates.find(plate => plate.id === added.plateId)!.b);
        plan.drawn = { source: draft.construction, compiled: draft.compiled, plateIds: draft.parts.get(added.plateId) ?? [added.plateId],
          meets: [...far ? [field(far)] : [], ...draft.divisions] };
      } catch (error) {
        if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error;
        plan.refusal = error;
      }
      this.platePlan = plan;
    }
    if (plan.drawn) {
      this.blueprint = plan.drawn.source; this.compiled = { source: this.source, value: plan.drawn.compiled };
      this.blockedEdit = null; this.meets = plan.drawn.meets; return plan.drawn.plateIds;
    }
    if (this.source !== source) this.blueprint = source;
    this.rejectEdit(plan.refusal, { ids: [], polygons: plan.polygons });
    return null;
  }
  // What the compiler makes of a proposal, with its plates divided where they meet, its refusal said in the author's terms.
  admitted(next: AuthoredConstruction): AuthoredConstruction {
    try { return this.validateConstruction(joinContacts(next).source); }
    catch (error) { throw told(error); }
  }

  // The frame as the field shows it: its nodes, and each plate with its ends.
  // A plate that closes one room and looks out on open air also has the normal
  // of that face: there a weapon, a sensor or a new room can stand. The free
  // chassis bed is offered separately by pickBed().
  nodes() { return this.blueprint.frame.nodes.filter(node => !node.id.startsWith('chassis:')); }
  plateSpans(): EditorPlateSpan[] {
    const blueprint = this.blueprint;
    if (this.spans?.blueprint !== blueprint) {
      const at = new Map(blueprint.frame.nodes.map(node => [node.id, { x: node.x, y: node.y }])),
        authored = new Set(this.source.nodes.map(node=>node.id)),
        walls = new Map(outerWalls(blueprint).map(wall => [wall.id, wall])), plates = new Map(blueprint.plates.map(plate => [plate.id, plate]));
      this.spans = { blueprint, value: blueprint.frame.plates.map(span => {
        const a = at.get(span.a)!, b = at.get(span.b)!, plate = plates.get(span.id)!, wall = walls.get(span.id);
        return { id: span.id, aId: authored.has(span.a) ? span.a : null, bId: authored.has(span.b) ? span.b : null, a, b, length: Math.hypot(b.x - a.x, b.y - a.y),
          material: plate.material, thicknessMm: plate.thicknessMm, normal: wall?.normal ?? null, roomId: wall?.roomId ?? null };
      }) };
    }
    return this.spans.value;
  }
  // A handle remembers the source. Every endpoint at this exact authored
  // coordinate goes with it, retaining its IDs. Of ends in one place, the one selected is taken, or one of a plate selected; a press that chooses
  // (`nearest`) takes the nearest.
  pickNode(point: Point, tolerance = .08, { nearest: choosing = false }: { nearest?: boolean } = {}): EditorNodeHit | null {
    let hit: EditorNodeHit | null = null, nearest = tolerance, priority = -1;
    for (const node of this.nodes()) {
      const incident = this.source.plates.filter(plate => plate.a === node.id || plate.b === node.id);
      if (!incident.length) continue;
      const rank = choosing ? 0 : this.selectionIds.has(nodeKey(node.id)) ? 2 : incident.some(plate => this.selectionIds.has(plate.id)) ? 1 : 0,
        distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance <= tolerance && (rank > priority || rank === priority && distance <= nearest)) {
        hit = { kind: 'node', id: node.id, key: nodeKey(node.id), x: node.x, y: node.y, source: this.source };
        nearest = distance; priority = rank;
      }
    }
    return hit;
  }
  // The point of the chassis whose grip is within `tolerance` of `point`, the nearest: like a node, it remembers the
  // document it was taken from.
  pickChassisPoint(point: Point, tolerance = .08): EditorVertexHit | null {
    const spot = this.chassisPoints().reduce<{spot:EditorChassisPoint;distance:number} | null>((best, spot) => {
      const distance = Math.hypot(spot.x - point.x, spot.y - point.y);
      return distance <= tolerance && (!best || distance < best.distance) ? { spot, distance } : best;
    }, null)?.spot;
    return spot ? { ...spot, kind: 'vertex', key: vertexKey(spot.index), source: this.source } : null;
  }
  // The point of the frame a press takes: an end of plates or a point of the chassis, the nearer. A press that adds to
  // the selection or takes from it (`nearest`) takes the end nearest to it, selected or not.
  pickPoint(point: Point, tolerance = .08, options: { nearest?: boolean } = {}): EditorPointHit | null {
    const node = this.pickNode(point, tolerance, options), vertex = this.pickChassisPoint(point, tolerance),
      away = (hit: Point) => Math.hypot(hit.x - point.x, hit.y - point.y);
    return node && vertex ? away(vertex) < away(node) ? vertex : node : node || vertex;
  }
  pickPlate(point: Point, tolerance = .08): EditorPlateHit | null {
    let hit: EditorPlateSpan | null = null, nearest = tolerance;
    for (const span of this.plateSpans()) {
      const p = closestSegment(point, span.a, span.b), distance = Math.hypot(point.x - p.x, point.y - p.y);
      if (distance <= nearest) { hit = span; nearest = distance; }
    }
    return hit && { ...hit, source: this.source };
  }
  rooted(source: AuthoredConstruction): CompiledConstruction {
    if (this.root?.source !== source) this.root = { source, value: compileDraftConstruction(source) };
    return this.root.value;
  }
  // A field point in authoring coordinates; pointer gestures may ask for grid assistance.
  local(source: AuthoredConstruction, point: Point, snap = this.snap) {
    const origin = this.rooted(source).frame.origin, coordinate = snap ? cellOf : unitsOf;
    return { x: coordinate(point.x - origin.x), y: coordinate(point.y - origin.y) };
  }
  // Dividing a plate keeps the point on its line. Grid assistance measures
  // along the plate instead of bending it towards a nearby grid intersection.
  pointOnPlate(source: AuthoredConstruction, span: EditorPlateSpan, point: Point) {
    const near = closestSegment(point, span.a, span.b),
      t = this.snap ? clamp(Math.round(near.t * span.length / CELL) * CELL / span.length, 0, 1) : near.t;
    return this.local(source, { x: span.a.x + (span.b.x - span.a.x) * t, y: span.a.y + (span.b.y - span.a.y) * t }, false);
  }
  // An end of plates dragged to `point`, in the field. Where it may not stand, for its plates would stand in others, and
  // an end of other plates or a plate is within `joinReach` of it, it is shown there instead (Editor.joinPlace), as let
  // go it is joined to it; else it stays where it last could be, the refusal told.
  moveNode(hit: EditorNodeHit | null, point: Point, { faceTolerance = 0, joinReach = 0 } = {}) {
    const source = hit?.source ?? (this.before?.key === this.document.key ? this.before.blueprint : this.source);
    if (!hit || !Number.isFinite(point.x + point.y) || !source.nodes.some(node => node.id === hit.id)) return false;
    const rest = this.restNode(hit, point, source, faceTolerance), original = source.nodes.find(node => node.id === hit.id)!, local = this.local(source, rest, this.snap && !rest.surfaceId),
      other = this.symmetric ? nodeAcross(source, hit.id) : null;
    if (rest.x === hit.x || other === hit.id) local.x = original.x;
    if (rest.y === hit.y) local.y = original.y;
    // In symmetric editing the end across the axis goes where this one goes, mirrored; one on the axis stays on it. This
    // one rests where it would alone, held in the construction box, and the one across from there.
    const shared = (id: string) => [id, ...coincidentNodes(source, id)],
      across = other && other !== hit.id && source.nodes.find(node => node.id === other),
      propose = (local: Point) => this.proposeFrame(() => {
        const positions = new Map(shared(hit.id).map(id => [id, local]));
        if (!across) return moveNodes(source, positions);
        const held = moveNodes(source, positions).nodes.find(node => node.id === hit.id) ?? local;
        for (const id of shared(hit.id)) positions.set(id, { x: held.x, y: held.y });
        for (const id of shared(other!)) positions.set(id, { x: held.x === original.x ? across.x : -held.x, y: held.y === original.y ? across.y : held.y });
        return moveNodes(source, positions);
      }, [rest]);
    if (propose(local)) return true;
    const refused = this.blockedEdit, place = joinReach > 0 && other !== hit.id && this.joinPlace(hit, rest, source, joinReach);
    if (place && propose(place)) return true;
    this.blockedEdit = refused; return false;
  }
  // Where the end `hit`, at `point` in the field, is within `reach` of an end of other plates, that end; else, within
  // `reach` of another plate, the point of it nearest: where, let go, it is joined (Editor.joinDroppedNode) or divides
  // that plate. Never an end or a plate of its own plates. In cells; null for none.
  joinPlace(hit: EditorNodeHit, point: Point, source: AuthoredConstruction, reach: number) {
    const shared = new Set([hit.id, ...coincidentNodes(source, hit.id)]), { frame } = this.rooted(source),
      nodes = new Map(frame.nodes.map(node => [node.id, node])), written = new Set(source.plates.map(plate => plate.id)),
      own = source.plates.filter(plate => shared.has(plate.a) || shared.has(plate.b)),
      linked = own.flatMap(plate => [nodes.get(plate.a)!, nodes.get(plate.b)!]),
      spans = frame.plates.filter(span => written.has(span.id) && !own.some(plate => plate.id === span.id)),
      off = (p: Point) => Math.hypot(p.x - point.x, p.y - point.y), nearest = <P extends Point>(places: readonly P[]): P | undefined => places.filter(p => off(p) <= reach).sort((p, q) => off(p) - off(q))[0],
      end = nearest(spans.flatMap(span => [nodes.get(span.a)!, nodes.get(span.b)!]).filter(end => !linked.some(own => Math.hypot(own.x - end.x, own.y - end.y) < 1e-9)));
    if (end) { const { x, y } = source.nodes.find(node => node.id === end.id)!; return { x, y }; }
    const on = nearest(spans.map(span => closestSegment(point, nodes.get(span.a)!, nodes.get(span.b)!)));
    return on ? this.local(source, on, false) : null;
  }
  // The grid guides free space; a nearby real joint or plate takes precedence.
  // Preserve the exact projection, including fractional chassis floors and T
  // junctions: rounding it again would open the hull. No source IDs are welded.
  framePoint(point: Point, tolerance = 0, { source = this.source, excluded = new Set<string>() }: {source?:AuthoredConstruction;excluded?:ReadonlySet<string>} = {}): PlateEndpoint {
    const compiled = this.rooted(source), origin = compiled.frame.origin,
      rest = (axis: 'x' | 'y') => origin[axis] + metresOf(cellOf(point[axis] - origin[axis])),
      grid = this.snap ? { x:rest('x'), y:rest('y') } : { x:point.x, y:point.y };
    if (!this.snap || !(tolerance > 0)) return grid;
    const reach = Math.min(.1,tolerance), nodes = new Map(compiled.frame.nodes.map(node => [node.id,node])),
      spans = compiled.frame.plates.filter(span => !excluded.has(span.id) && (!chassisPart(span.id) || chassisTopPlate(span.id)));
    let nearest: (PlateEndpoint & {distance:number;surfaceId:string}) | null = null;
    for (const span of spans) {
      const a=nodes.get(span.a)!, b=nodes.get(span.b)!, raw=closestSegment(point,a,b), distance=Math.hypot(point.x-raw.x,point.y-raw.y);
      if (distance > reach || nearest && distance >= nearest.distance) continue;
      const exact=closestSegment(grid,a,b);
      nearest={distance,x:exact.x,y:exact.y,surfaceId:span.id};
      for (const end of [a,b]) if (Math.hypot(point.x-end.x,point.y-end.y) <= reach) { nearest={distance,x:end.x,y:end.y,surfaceId:span.id}; break; }
    }
    // Without an extra floor layer, the chassis bed is its real upper face.
    if (!source.chassis?.topPlate) for (const bed of compiled.beds.filter(bed => chassisPart(bed.id) && !excluded.has(bed.id))) {
      const normal=bed.normal, lift=bed.thicknessMm/2000,
        a={x:bed.a.x+normal.x*lift,y:bed.a.y+normal.y*lift}, b={x:bed.b.x+normal.x*lift,y:bed.b.y+normal.y*lift},
        raw=closestSegment(point,a,b), distance=Math.hypot(point.x-raw.x,point.y-raw.y);
      if (distance <= reach && (!nearest || distance < nearest.distance)) nearest={distance,...closestSegment(grid,a,b),surfaceId:bed.id};
    }
    return nearest ? {x:nearest.x,y:nearest.y,surfaceId:nearest.surfaceId} : grid;
  }
  restNode(hit: EditorNodeHit, point: Point, source = hit.source ?? this.source, tolerance = 0) {
    const shared=new Set([hit.id,...coincidentNodes(source,hit.id)]),
      excluded=new Set(source.plates.filter(plate=>shared.has(plate.a)||shared.has(plate.b)).map(plate=>plate.id));
    return this.framePoint(point,tolerance,{source,excluded});
  }
  // Reshaping preserves authored placements and sectors. The compiler either
  // admits that proposal or refuses it; no mechanism is moved to make it fit. The plates it makes meet are divided where
  // they meet (`meets`); the proposal as it was before is kept for a drop to join ends in (Editor.dragged).
  proposeFrame(next: AuthoredConstruction | (() => AuthoredConstruction), points: Point[] = []) {
    return this.proposing(() => this.admitFrame(typeof next === 'function' ? next() : next), points);
  }
  // What a gesture moves whole, previewed with its loose ends landed (Editor.admitLanding).
  proposeLanding(source: AuthoredConstruction, moved: (ox:number,oy:number)=>AuthoredConstruction, reach: number, points: Point[] = []) { return this.proposing(() => this.admitLanding(source, moved, reach), points); }
  // A proposal admitted; or else its refusal shown at `points`, the preview left as it last could be.
  proposing(admit: () => void, points: Point[]) {
    try { admit(); return true; }
    catch (error) {
      if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error;
      this.rejectEdit(error, { ids: [], points }); return false;
    }
  }
  // The document `drawn` previewed, divided where its plates meet: those points are lit, and so are the ends of plates
  // `joined` to it as it was moved, in cells. A refusal is thrown.
  admitFrame(drawn: AuthoredConstruction, joined: Point[] = []) {
    const draft = joinedDraft(drawn);
    this.blueprint = draft.construction; this.compiled = { source: this.source, value: draft.compiled };
    this.unjoined = { source: this.source, drawn }; this.meets = [...joined.map(fieldPoint), ...draft.divisions];
    this.blockedEdit = null;
  }
  // What a gesture moves whole, `moved(ox, oy)` (frame-editing.ts `landEnds`), previewed with its loose ends landed on the
  // ends or plates within `reach` (in metres) of where they rest, which they are joined to: as it is let go, they are.
  // Where joined it would be refused, it is previewed where the pointer takes it, not joined; where that is refused too,
  // the refusal is thrown and it stays where it last could be.
  admitLanding(source: AuthoredConstruction, moved: (ox:number,oy:number)=>AuthoredConstruction, reach: number) {
    if (reach > 0) try {
      const landed = landEnds(source, moved, unitsOf(reach));
      if (landed) { this.admitFrame(landed.source, landed.ends); return; }
    } catch (error) { if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error; }
    this.admitFrame(moved(0, 0));
  }
  // A plate dragged whole takes both its junctions by the same delta, including coincident ends of its neighbours.
  // Their far ends and unselected equipment stay put. In symmetric editing the plate across the
  // axis goes the other way across, and an end on the axis, or a plate across it, only up or down. A loose end of it
  // within `joinReach` of an end or a plate that stays lands there (Editor.admitLanding).
  movePlate(hit: EditorPlateHit | null, dx: number, dy: number, { joinReach = 0 } = {}) {
    const source = hit?.source ?? (this.before?.key === this.document.key ? this.before.blueprint : this.source);
    if (!hit || !Number.isFinite(dx + dy) || !source.plates.some(plate => plate.id === hit.id)) return false;
    const other = this.symmetric ? plateAcross(source, hit.id) : null;
    const coordinate = this.snap ? cellOf : unitsOf;
    dx = other === hit.id ? 0 : coordinate(dx); dy = coordinate(dy);
    const plates: [string,number][] = [[hit.id, 1], ...other && other !== hit.id ? [[other, -1] satisfies [string,number]] : []],
      ends = (id: string) => { const plate = source.plates.find(plate => plate.id === id)!; return source.nodes.filter(node => node.id === plate.a || node.id === plate.b); },
      placed = (dx: number, dy: number, alone = false) => {
        const positions = new Map<string,Point>();
        for (const [id, way] of alone ? plates.slice(0, 1) : plates) for (const node of ends(id)) {
          const across = this.symmetric && onAxis(node.x) ? 0 : way * dx;
          for (const end of [node.id, ...coincidentNodes(source, node.id)])
            positions.set(end, { x: node.x + across, y: node.y + dy });
        }
        return positions;
      }, to = [hit.a, hit.b].map(point => ({ x: point.x + metresOf(dx), y: point.y + metresOf(dy) })),
      moved = (ox: number, oy: number) => {
        const across = other === hit.id ? 0 : dx + ox, up = dy + oy;
        if (plates.length === 1) return moveNodes(source, placed(across, up));
        // With the plate across, this one goes as far as it would alone, held in the construction box, and that one as far.
        const alone = placed(across, up, true), [end] = alone.keys(), wanted = alone.get(end!)!,
          held = moveNodes(source, alone).nodes.find(node => node.id === end) ?? wanted;
        return moveNodes(source, placed(across + held.x - wanted.x, up + held.y - wanted.y));
      };
    return this.proposeLanding(source, moved, joinReach, to);
  }
  // One whole edit of the frame: proposed, committed and, when kept, selected.
  reshape<R extends {source:AuthoredConstruction}>(edit: () => R, points: Point[], selected: (result:R) => string | readonly string[] | null | undefined, ids: string[] = []) {
    let result;
    try { result = edit(); }
    catch (error) { if ((!isConstructionError(error) || error.code !== 'FRAME_EDIT')) throw error; this.rejectEdit(error, { ids, points }); return false; }
    this.begin();
    const accepted = this.proposeFrame(result.source, points);
    this.commit();
    if (accepted && selected(result)) this.select(selected(result));
    return accepted;
  }
  // A new node on a plate where `point` falls on its line: two stretches of
  // the same armour. In symmetric editing, another where it falls mirrored, on the
  // plate across the axis or on the other half of this one.
  splitPlate(hit: EditorPlateSpan | null, point: Point) {
    if (!hit || !Number.isFinite(point?.x + point?.y)) return false;
    if (chassisTopPlate(hit.id)) return this.addChassisPoint(point);
    const near = closestSegment(point, hit.a, hit.b), source = this.source, at = this.pointOnPlate(source, hit, near);
    return this.reshape(() => {
      const result = splitPlate(source, hit.id, at), other = this.symmetric && !onAxis(at.x) ? plateAcross(source, hit.id) : null;
      if (other === null) return result;
      const there = mirrored(at), plate = [other, ...other === hit.id ? [result.plateId] : []].map(id => result.source.plates.find(plate => plate.id === id)!)
        .find(plate => { const [a, b] = [plate.a, plate.b].map(id => result.source.nodes.find(node => node.id === id)!), on = closestSegment(there, a!, b!);
          return on.t > 0 && on.t < 1 && Math.hypot(on.x - there.x, on.y - there.y) < 1; });
      return plate ? { ...result, source: splitPlate(result.source, plate.id, there).source } : result;
    }, [near], result => result.plateId, [hit.id]);
  }
  // The same new node without aiming at the plate: the selected stretch splits in the middle.
  splitPlateMiddle(id: string) {
    const span = this.plateSpans().find(span => span.id === id);
    return span ? this.splitPlate(span, { x: (span.a.x + span.b.x) / 2, y: (span.a.y + span.b.y) / 2 }) : false;
  }
  // A node between two plates joins them without opening the contour; in symmetric editing, the node across the axis
  // too, where it also joins two.
  removeNode(hit: Pick<EditorNodeHit,'id'|'x'|'y'> | null) {
    if (!hit) return false;
    const source = this.source, other = this.symmetric ? nodeAcross(source, hit.id) : null;
    return this.reshape(() => {
      const result = removeNode(source, hit.id);
      if (!other || other === hit.id || result.source.plates.filter(plate => plate.a === other || plate.b === other).length !== 2) return result;
      return { ...result, source: removeNode(result.source, other).source };
    }, [{ x: hit.x, y: hit.y }], result => result.plateId);
  }
  // The whole room a plate closes on the outside, with what is mounted on it and what it holds.
  // Answers how many rooms went: one that carried others takes them with it.
  removeRoom(plateId: string) {
    const rooms = this.blueprint.rooms.length, next = this.admitted(removeRoom(this.source, this.blueprint, plateId));
    this.change(() => { this.blueprint = next; }); this.select([...this.selectionIds]); return rooms - this.blueprint.rooms.length;
  }
  // A whole compartment grows from an outer face, previewed from the document
  // the handle came from. A short pull draws nothing; refusal keeps the source. Where the plate it stands on is divided
  // at its feet is told in `meets`.
  drawRoom(hit: RoomHandle | null, from: Point, to: Point | null) {
    const source = hit?.source ?? this.source;
    const coordinate = this.snap ? cellOf : unitsOf,
      key = hit && JSON.stringify([hit.id, from.x, from.y, this.snap, to && coordinate(to.x - from.x), to && coordinate(to.y - from.y)]);
    let plan = this.roomPlan;
    if (hit && (plan?.source !== source || plan.key !== key)) {
      plan = { source, key: key!, drawn: null, refusal: null };
      try { plan.drawn = planStructuredRoom(source, this.rooted(source), hit, from, to, { snap: this.snap }); }
      catch (error) { if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error; plan.refusal = error; }
      this.roomPlan = plan;
    }
    const { drawn = null, refusal = null } = hit ? plan! : {};
    this.meets = drawn ? drawn.divisions.map(fieldPoint) : [];
    if (drawn) { this.blueprint = drawn.source; this.blockedEdit = null; return drawn; }
    if (this.source !== source) this.blueprint = source;
    if (refusal) this.rejectEdit(refusal, { ids: [hit!.id] });
    else this.blockedEdit = null;
    return null;
  }
  // The free stretch of the bed under `point`, which carries a room as a plate does (chassis-editing.ts bedStretchAt).
  // Like a handle, it remembers the document it was taken from.
  pickBed(point: Point, tolerance = .08): RoomHandle | null {
    const stretch = bedStretchAt(this.blueprint, point, tolerance);
    return stretch && { ...stretch, source: this.source };
  }

  // The points of the chassis in the field, from its front, each with where its grip stands: halfway down from the line
  // of the chassis there to the foot of the frame under it, at a knee on the line the two stretches meet on, clear of
  // the nodes of the hull resting on it. `top` is the point itself, where a node of the hull resting there stands, and
  // `foot` the foot of the frame under it (chassis.ts `chassisVertices`); `end` names the first and the last, which make
  // the chassis as long as it is.
  chassisPoints(): EditorChassisPoint[] {
    const chassis = this.blueprint.chassis, points = this.source.chassis?.points, vertices = chassis?.outlines && chassisVertices(chassis);
    if (!points || vertices?.length !== points.length) return [];
    return vertices.map(({ top, foot, middle }, index) =>
      ({ index, end: !index ? 'front' : index === points.length - 1 ? 'rear' : null, x: middle.x, y: middle.y, top, foot }));
  }
  // The stretches of the chassis that may be a gap, all but the two at its ends, from the front: each with whether it is
  // one, and its line along the top of the frame from `a` to `b`.
  chassisGaps() {
    const points = this.chassisPoints();
    return points.slice(1, -2).map(({ index, top }) => ({ index, gap: Boolean(this.source.chassis!.points[index]!.gap), a: top, b: points[index + 1]!.top }));
  }
  // Where the frame of the stretch from point `index` is, or would be, in the field: from the top of the chassis to the
  // foot of its frame.
  chassisStretch(index: number): Point[] {
    const points = this.chassisPoints(), from = points[index], to = points[index + 1];
    return from && to ? [from.top, to.top, to.foot, from.foot] : [];
  }
  // The stretch of the chassis `point` is on, within `tolerance` of it, from the top of the chassis to the foot of its
  // frame as it is outlined (chassis.ts `chassisStretchOf`), or where its frame would be across a gap (`gaps`); null
  // for none.
  chassisStretchAt(point: Point, tolerance = 0, { gaps = true } = {}) {
    const points = this.chassisPoints(), written = this.source.chassis?.points;
    return points.length > 1 ? chassisStretchOf(points, point, tolerance, gaps ? [] : written!.map(p => Boolean(p.gap))) : null;
  }
  // Whether `point` is on the frame of the chassis, within `tolerance` of it: on a stretch of it that is no gap.
  onChassisFrame(point: Point, tolerance = 0) { return this.chassisStretchAt(point, tolerance, { gaps: false }) !== null; }
  // A point of the chassis dragged to `point`, where its grip would go, the others staying: with optional grid assistance,
  // of the construction, up from the deck, at least two cells from the points beside it; an end also within the lengths its
  // model is made in and the limit of construction. If the hull, the running gear or what stands on the bed would not
  // stand on the chassis so, it stops at the last place on the way that the compiler admits. Capacity remains a
  // diagnostic of the resulting draft.
  // In symmetric editing the point across the axis goes where it goes, mirrored, and one on the axis only up or down.
  moveChassisPoint(hit: EditorVertexHit | null, point: Point) {
    const source = hit?.source ?? this.source, points = source.chassis?.points;
    if (!hit || !points?.[hit.index] || !Number.isFinite(point?.x + point?.y)) return false;
    const was = points[hit.index]!, range = chassisPointRange(source, hit.index), other = this.symmetric ? vertexAcross(source, hit.index) : null,
      coordinate = this.snap ? cellOf : unitsOf,
      wanted = { x: other === hit.index ? was.x : was.x + coordinate(point.x - hit.x), y: was.y + coordinate(point.y - hit.y) },
      to = { x: clamp(wanted.x, range.minX, range.maxX), y: clamp(wanted.y, range.minY, range.maxY) },
      // Held at a bound, the point is told which: the points beside it, the lengths of the model or the limit of
      // construction. On the deck it just rests.
      bound = wanted.x < range.minX ? 'minX' : wanted.x > range.maxX ? 'maxX'
        : wanted.y < range.minY ? 'minY' : wanted.y > range.maxY ? 'maxY' : null,
      held = bound && { order: () => refusal('CHASSIS_ORDER'), length: () => new Error(chassisRangeMessage(source.chassis!.model)),
        reach: () => new Error(LIMITS.reach), below: () => new Error(LIMITS.below), above: () => new Error(LIMITS.above) }[range.held[bound]](),
      steps = Math.max(Math.abs(to.x - was.x), Math.abs(to.y - was.y)),
      along = (n: number) => n >= steps ? to : { x: was.x + (this.snap ? Math.round((to.x - was.x) * n / steps) : (to.x - was.x) * n / steps),
        y: was.y + (this.snap ? Math.round((to.y - was.y) * n / steps) : (to.y - was.y) * n / steps) },
      across = other !== null && other !== hit.index ? points[other] : null,
      // The point across is held by its own bounds, with this one moved.
      placed = (n: number) => {
        const at = along(n), moved = withChassisPoint(source, hit.index, at), room = across && chassisPointRange(moved, other!);
        return across ? withChassisPoint(moved, other!, { x: at.x === was.x ? across.x : clamp(-at.x, room!.minX, room!.maxX),
          y: at.y === was.y ? across.y : clamp(at.y, room!.minY, room!.maxY) }) : moved;
      },
      { next, refusal: refused = held } = this.reach(source, 0, steps, placed, this.snap ? 1 : .02);
    this.blueprint = next; this.blockedEdit = null;
    if (!refused) return true;
    // A node of the hull the chassis would leave behind is shown where it stands, and so is the gear it would leave off
    // a level stretch.
    const named = isNativeAdmissionIssue(refused) ? refused.nodeIds ?? [] : [];
    this.rejectEdit(refused, { ids: [], points: this.rooted(source).frame.nodes.filter(node => named.includes(node.id)) });
    return false;
  }
  // One whole edit of the points of the chassis: proposed, committed when admitted and then `selected`, else shown
  // refused on the stretch it was made at.
  rework(proposed: AuthoredConstruction, stretch: number, selected: string | readonly string[] = []) {
    let next;
    try { next = this.admitted(proposed); }
    catch (error) {
      if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error;
      this.rejectEdit(error, { ids: [], polygons: [this.chassisStretch(stretch)].filter(polygon => polygon.length) }); return false;
    }
    this.change(() => { this.blueprint = next; }); this.select(selected);
    return true;
  }
  // A new point of the chassis where `point` falls along it, with optional grid assistance along the line the chassis ran
  // along there; it is selected. In symmetric editing another goes where it falls mirrored.
  addChassisPoint(point: Point) {
    const source = this.source;
    if (!source.chassis || !Number.isFinite(point?.x)) return false;
    const x = (this.snap ? cellOf : unitsOf)(point.x - this.blueprint.frame.origin.x), added = withChassisPointAdded(source, x),
      stretch = source.chassis.points.findLastIndex(at => at.x <= x);
    if (added === source) { this.rejectEdit(refusal('CHASSIS_ORDER'), { ids: [] }); return false; }
    const next = this.symmetric && !onAxis(x) ? withChassisPointAdded(added, -x) : added;
    return this.rework(next, stretch, vertexKey(next.chassis!.points.findIndex(at => at.x === x)));
  }
  // The point `index` of the chassis taken out, the line running straight from the point before it to the point after.
  // Its ends do not go: they make it as long as it is. In symmetric editing the point across the axis goes too.
  removeChassisPoint(index: number) {
    const points = this.source.chassis?.points, end = (at: number) => !at || at === points!.length - 1;
    if (!points?.[index]) return false;
    if (end(index)) {
      this.rejectEdit(new Error('As pontas do chassi não saem: arraste-as para mudar o comprimento.'), { ids: [] }); return false;
    }
    const other = this.symmetric ? vertexAcross(this.source, index) : null,
      gone = [index, ...other !== null && other !== index && !end(other) ? [other] : []].toSorted((a, b) => b - a);
    return this.rework(gone.reduce((next, at) => withChassisPointRemoved(next, at), this.source), index - 1);
  }
  // A part of the chassis taken from `from` towards `to` along the design, as `propose` writes the design with it at a
  // place: at `to` where the compiler admits it there, or else at the last place on the way, in steps of `step`, that it
  // admits — where it was, when none is. The answer is that design, and the compiler's refusal of `to` if it refused it.
  reach(source: AuthoredConstruction, from: number, to: number, propose: (value:number) => AuthoredConstruction, step: number): {next:AuthoredConstruction;refusal?:ConstructionError} {
    const at = (x: number) => {
      try { return this.validateConstruction(propose(x)); }
      catch (error) { if (!isConstructionError(error) || !RECOVERABLE.includes(error.code)) throw error; return error; }
    };
    const there = at(to);
    if (!(there instanceof Error)) return { next: there };
    const steps = Math.ceil(Math.abs(to - from) / step - 1e-9), place = (n: number) => n >= steps ? to : from + Math.sign(to - from) * n * step;
    let next = source;
    for (let low = 0, high = steps; high - low > 1;) {
      const middle = (low + high) >> 1, tried = at(place(middle));
      if (tried instanceof Error) high = middle; else { low = middle; next = tried; }
    }
    return { next, refusal: there };
  }
  // Preview one running-gear measure from the captured document. A resting
  // grip restores that document; a refused move retains the last admitted one.
  previewGearMeasure(source: AuthoredConstruction, from: number, to: number, propose: (value:number)=>AuthoredConstruction) {
    const { next, refusal } = Math.abs(to - from) < 1e-12 ? { next: source }
      : this.reach(source, from, to, propose, this.snap ? CELL : .001);
    this.blueprint = next; this.blockedEdit = null;
    return refusal;
  }
  // Axles move along their level running line. A track has a centre grip and independent length/height grips. Skids have
  // a grip at either end of their runner and one in its middle, which takes the runner and both legs along, on the floor,
  // and one halfway up each leg.
  chassisGear(): EditorGear[] {
    const blueprint = this.blueprint, chassis = blueprint.chassis, at = (id: string) => blueprint.modules.find(module => module.id === id)!;
    if (!chassis) return [];
    if (chassis.axles) return chassis.axles.map((x, index) => ({ key: `axle-${index}`, grip: 'axle', index, x, y: at(`chassis:wheel-${index}`).y }));
    if (chassis.skids) {
      const { front, rear, y } = chassis.skids, leg = (index: number) => blueprint.plates.find(plate => plate.id === `chassis:leg-${index}`)!;
      return [...(['front', 'rear'] as const).map(end => ({ key: `skid-${end}`, grip: 'skid' as const, end, x: chassis.skids![end], y })),
        { key: 'skid-position', grip: 'skid-position', x: (front + rear) / 2, y },
        ...[0, 1].map(index => ({ key: `skid-leg-${index}`, grip: 'skid-leg' as const, index, x: leg(index).x, y: leg(index).y }))];
    }
    const { x, y, height } = at('chassis:track');
    return [...(['front', 'rear'] as const).map(end => {
      const inset = (end === 'front' ? 1 : -1) * height / 2;
      return { key: `track-${end}`, grip: 'track' as const, end, x: chassis.track![end] + inset, y, inset };
    }), { key: 'track-position', grip: 'track-position', x, y },
      { key: 'track-height', grip: 'track-height', x, y: y + height / 2 }];
  }
  // The grip of the gear taken hold of (`key`, as chassisGear tells it): like a node, it remembers the document it was
  // taken from.
  gearHandle(key: string): EditorGearHit | null {
    const at = this.chassisGear().find(candidate => candidate.key === key);
    return at ? { ...at, source: this.source } : null;
  }
  // Invalid gear geometry stops at the last place that fits. Capacity and balance remain visible in the draft.
  moveGear(hit: EditorGearHit | null, point: Point) {
    const source = hit?.source ?? this.source, chassis = source.chassis;
    if (!hit || !chassis || !Number.isFinite(point?.x)) return false;
    if (hit.grip === 'skid' || hit.grip === 'skid-position' || hit.grip === 'skid-leg') return this.moveSkids(hit, point);
    if (hit.grip !== 'axle') return this.moveTrackGear(hit, point);
    const x = point.x - this.rooted(source).frame.origin.x, axles = chassisAxles(chassis),
      written = chassis.axles ? [...chassis.axles].sort((a, b) => a - b) : axles.map(unitsOf), from = axles[hit.index]!,
      wanted = this.snap ? (cellOf(x) === cellOf(from) ? from : metresOf(cellOf(x))) : x, step = this.snap ? CELL : .001,
      propose = (place: number) => withChassisAxle(source, hit.index, place),
      to = chassisAxles(propose(wanted).chassis!)[hit.index]!,
      why = Math.abs(to - wanted) > (this.snap ? CELL / 2 : 1e-9)
        ? gearProblem({ ...chassis, axles: written.with(hit.index, unitsOf(to + Math.sign(wanted - to) * step)) }) : null,
      held = why ? Object.assign(new Error(why.code), why, { reason: why.code, code: 'STRUCTURED_CONSTRUCTION' }) : null,
      { next, refusal = held } = this.reach(source, from, to, propose, step);
    this.blueprint = next; this.blockedEdit = null;
    if (!refusal) return true;
    const beside = refusal === held && why?.code === 'AXLE_SPACING' ? [`chassis:wheel-${hit.index + Math.sign(wanted - to)}`] : [];
    this.rejectEdit(refusal, { ids: [`chassis:wheel-${hit.index}`, ...beside] });
    return false;
  }
  // Track dimensions and place along the design are continuous. Grid assistance affects only the measure being
  // dragged; every proposal starts from the captured authoring. The belt stays on the floor: its top, where the height
  // grip is, goes as far as the height grows, and the hull rises as its model hangs it over larger gear.
  moveTrackGear(hit: Extract<EditorGearHit,{grip:'track'|'track-position'|'track-height'}>, point: Point) {
    if (hit.grip === 'track-height' ? !Number.isFinite(point?.y) : !Number.isFinite(point?.x)) return false;
    const source = hit.source ?? this.source, track = chassisTrack(source.chassis!),
      snap = (value: number, before: number) => this.snap ? cellOf(value) === cellOf(before) ? before : metresOf(cellOf(value)) : value;
    let from, to, propose;
    if (hit.end) {
      from = track[hit.end]; to = snap(from + (point.x - hit.x), from);
      propose = (place: number) => withChassisTrackEnd(source, hit.end, place);
    } else if (hit.grip === 'track-height') {
      from = track.height; to = snap(from + (point.y - hit.y), from);
      propose = (height: number) => withChassisTrackHeight(source, height);
    } else {
      from = (track.front + track.rear) / 2; to = snap(from + (point.x - hit.x), from);
      propose = (x: number) => withChassisTrackPosition(source, x);
    }
    const refusal = this.previewGearMeasure(source, from, to, propose);
    if (!refusal) return true;
    this.rejectEdit(refusal, { ids: ['chassis:track'] }); return false;
  }
  // The skids of an aircraft are dragged along the design as a track is: an end of their runner, the runner with both
  // legs, or one leg, from the captured authoring, resting on the grid where it assists and going no further than the
  // compiler admits. Taken whole, they keep their place on the grid: they go by whole cells. A leg goes no further than
  // the other: dragged past it, it stops as near it as they may stand.
  moveSkids(hit: Extract<EditorGearHit,{grip:'skid'|'skid-position'|'skid-leg'}>, point: Point) {
    const source = hit.source ?? this.source, skids = chassisSkids(source.chassis!), dx = point.x - hit.x,
      snap = (value: number, before: number) => this.snap ? cellOf(value) === cellOf(before) ? before : metresOf(cellOf(value)) : value;
    let from: number, to: number, propose: (value:number)=>AuthoredConstruction, ids: string[];
    if (hit.grip === 'skid-leg') {
      const other = skids.legs[1 - hit.index]!;
      from = skids.legs[hit.index]!; to = snap(from + dx, from); to = hit.index ? Math.max(to, other) : Math.min(to, other);
      propose = (x: number) => withChassisSkidLeg(source, hit.index, x); ids = [`chassis:leg-${hit.index}`];
    } else if (hit.grip === 'skid') {
      from = skids[hit.end]; to = snap(from + dx, from);
      propose = (x: number) => withChassisSkidEnd(source, hit.end, x); ids = ['chassis:skid-0'];
    } else {
      from = skids.front; to = snap(from + dx, from);
      propose = (x: number) => withChassisSkidsMoved(source, x - from); ids = ['chassis:skid-0', 'chassis:leg-0', 'chassis:leg-1'];
    }
    const refusal = this.previewGearMeasure(source, from, to, propose);
    if (!refusal) return true;
    // Too near the other leg, both are shown; off the end of the runner, the runner with the leg.
    if (refusal.reason === 'SKID_SPACING' || refusal.code === 'SKID_SPACING') ids = ['chassis:leg-0', 'chassis:leg-1'];
    else if (hit.grip === 'skid-leg' && [refusal.reason, refusal.code].includes('SKID_RUNNER')) ids = [...ids, 'chassis:skid-0'];
    this.rejectEdit(refusal, { ids }); return false;
  }
  // The construction on another chassis or none (chassis-editing.ts withConstructionKind), as one edit. On a chassis,
  // the chassis is selected; fixed, nothing is.
  setConstructionKind(kind: ChassisModelId | 'fixed') {
    if (constructionKind(this.source) === kind) return false;
    let proposed; try { proposed = withConstructionKind(this.source, kind); } catch (error) { throw told(error); }
    const next = this.admitted(proposed);
    this.change(() => { this.blueprint = next; });
    this.select(next.chassis ? CHASSIS_ID : [...this.selectionIds].filter(id => !chassisPart(id)));
    return true;
  }
  // The frame of the chassis in another metal (chassis-editing.ts withFrameMetal), as one edit.
  setChassisMetal(metal: ChassisMetalId) {
    if (!this.source.chassis || (this.source.chassis.metal ?? 'steel') === metal) return false;
    const next = this.admitted(withFrameMetal(this.source, metal));
    this.change(() => { this.blueprint = next; }); this.select(CHASSIS_ID);
    return true;
  }
}
