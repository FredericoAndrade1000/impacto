import { phrase, translate } from './i18n.ts';
import { compileNativeConstruction } from './native-dynamics.ts';
import { constructionCatalogue } from './construction-admission.ts';
import { chassisSpec, frameThicknessMm, frameThicknessRange, straightChassis, suspensionZero } from './chassis.ts';
import { DESIGN_VERSION } from './design-contract.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';
import { cellOf, unitsOf } from './grid.ts';
import type { AuthoredComponent, AuthoredComponentPose, AuthoredConstruction, CanonicalConstruction, CompiledConstruction,
  CompilerResponse, ConstructionPoint, NativeCompilerResponse, NativeCompiledConstruction, ChassisModelId, AuthoredChassis } from './construction-contract.ts';
import { isConstructionError } from './construction-codec.ts';
import { cartridgeId } from './weapons.ts';

export const CONSTRUCTION_ORIGIN = VEHICLE_ORIGIN;
// What one construction holds on the field, counted as the player writes it: the frame and the running gear that come
// with a chassis are not counted. The workshop refuses past it where the field would.
export const PART_LIMITS = Object.freeze({ plates: 32, components: 16 });
export const CAPACITY_MESSAGE = phrase`No campo, cada construção leva até ${PART_LIMITS.plates} chapas e ${PART_LIMITS.components} componentes.`;
export const CAPACITY = translate(CAPACITY_MESSAGE);
const fail = (message: string, code = 'STRUCTURED_CONSTRUCTION'): never => { throw Object.assign(new Error(message), { code }); };

// What is persisted is the authoring: nodes, the plates between them and the
// equipment. The one Rust compiler validates it and derives the rooms those
// plates close and all mechanical geometry. These host overlays draw its
// already compiled data.
// One edit asks for the same construction more than once: to validate it, then
// to draw it, to weigh it, to price it; and a drag asks on every frame. The
// last few answers are kept by what was asked, and by the canonical form that
// came back, so the compiler runs once for each distinct construction. Only the
// requested projection is copied out; the cached answer is never exposed.
const ANSWERS = new Map<string, CompilerResponse>(), KEPT = 12;
const answerKey = (input: unknown, draft: boolean) => `${draft ? 'draft' : 'admitted'}:${JSON.stringify(input)}`;
function keep(result: NativeCompilerResponse, draft: boolean, ...asked: string[]): CompilerResponse {
  const presented = { ...result, compiled: presentCompiledConstruction(result.compiled) };
  for (const key of new Set([...asked, answerKey(result.construction, draft)])) { ANSWERS.delete(key); ANSWERS.set(key, presented); }
  while (ANSWERS.size > KEPT) {
    const oldest = ANSWERS.keys().next().value;
    if (oldest !== undefined) ANSWERS.delete(oldest);
  }
  return presented;
}
function compile(input: unknown, draft = false): CompilerResponse {
  const asked = answerKey(input, draft), known = ANSWERS.get(asked);
  if (known) return known;
  return keep(compileNativeConstruction(input, constructionCatalogue(), draft), draft, asked);
}
export const compileDraft = (input: unknown): CompilerResponse => structuredClone(compile(input, true));
// The site comes from current field placement/terrain, never from network root IDs.
// It is not cached with source geometry: the same design can stand on another real surface.
export function compileManufacture(input: unknown, site: unknown = {}, draft = false): CompilerResponse {
  const result = compileNativeConstruction(input, constructionCatalogue(), draft, site);
  return { ...result, compiled: presentCompiledConstruction(result.compiled) };
}
function presentCompiledConstruction(dto: NativeCompiledConstruction): CompiledConstruction {
  return Object.assign(dto, { bodyPanels: dto.rooms.map(room => ({ id: room.id + ':panel', roomId: room.id, poly: room.polygon })) });
}
export const validateStructuredConstruction = (input: unknown): CanonicalConstruction => structuredClone(compile(input).construction);
export const compileStructuredConstruction = (input: unknown): CompiledConstruction => structuredClone(compile(input).compiled);
export const validateDraftConstruction = (input: unknown): CanonicalConstruction => structuredClone(compile(input, true).construction);
export const compileDraftConstruction = (input: unknown): CompiledConstruction => structuredClone(compile(input, true).compiled);
// A closed box: four nodes and the plates between them, counter-clockwise from the floor. A vehicle stands on
// `chassis`, by default wheels, centred under the box and hung where its model hangs it (chassis.ts suspensionZero), the
// floor of the box on it as a factory lays it (game_templates.rs `finish`). As a new factory design, its section is
// reinforced to carry the authored hull, and hung again as its frame deepens; ordinary edits do not change thickness
// automatically. Coordinates use the stable project reference; its sizes, in metres, are written on the cells nearest
// to them.
export interface ConstructionOptions { name?: string; length?: number; height?: number; frontInset?: number; rearInset?: number;
  thicknessMm?: number; rideHeight?: number; preset?: 'vehicle' | 'bunker'; chassis?: ChassisModelId | null }
export function createStructuredConstruction({ name = 'Blindado estruturado', length = 5.4, height = 1.6,
  frontInset = .5, rearInset = .1, thicknessMm = 40, rideHeight = .7, preset = 'vehicle',
  chassis = preset === 'vehicle' ? 'wheeled' : null }: ConstructionOptions = {}) {
  const span = chassis ? Math.max(length, chassisSpec(chassis).length[0]) : 0,
    corners: [number, number][] = [[-length / 2, 0], [length / 2, 0], [length / 2 - rearInset, height], [-length / 2 + frontInset, height]];
  let frame: AuthoredChassis | null = chassis ? straightChassis(chassis, -cellOf(span / 2), cellOf(span / 2)) : null;
  const built = () => {
    const deck = frame ? suspensionZero(frame) : 0,
      floor = frame ? deck + cellOf(thicknessMm / 2000) : cellOf(rideHeight - CONSTRUCTION_ORIGIN.y);
    return { version: DESIGN_VERSION, preset, name,
      ...(frame ? { chassis: { ...frame, topPlate: { material: 'steel', thicknessMm },
        points: frame.points.map(point => ({ ...point, y: deck })) } } : {}),
      nodes: corners.map(([x, y], i) => ({ id: 'hull-' + i, x: cellOf(x), y: cellOf(y) + floor })),
      plates: ['floor', 'rear', 'roof', 'front'].flatMap((side, i) => frame && i === 0 ? [] : [{ id: 'hull:' + side, a: 'hull-' + i, b: 'hull-' + (i + 1) % 4,
        material: 'steel', thicknessMm }]),
      components: [] };
  };
  for (let attempt = 0; ; attempt++) try { return validateStructuredConstruction(built()); }
    catch (error) {
      if (!frame || !isConstructionError(error) || error.code !== 'CHASSIS_OVERLOAD' || attempt >= 31) throw error;
      const gauge = frameThicknessMm(frame), { max } = frameThicknessRange(frame);
      if (gauge >= max) throw error;
      frame = { ...frame, thicknessMm: Math.min(max, Math.ceil(gauge * 1.25 * 10) / 10) };
    }
}
// The guns of one cartridge (weapons.ts `cartridgeId`) on a construction are fed one ammunition, so that the boxes of it
// carry rounds of one weight (game_construction.rs): a gun put in, or changed to a cartridge already there, is fed what
// that cartridge is.
function fedLike(input: Pick<AuthoredConstruction, 'components'>, proposed: AuthoredComponent): AuthoredComponent {
  if (proposed.kind !== 'weapon') return proposed;
  const twin = input.components.find((part): part is Extract<AuthoredComponent, { kind: 'weapon' }> =>
    part.kind === 'weapon' && part.id !== proposed.id && cartridgeId(part.weaponPreset ?? 'rh120') === cartridgeId(proposed.weaponPreset ?? 'rh120'));
  if (!twin) return proposed;
  const { weaponAmmo, ...rest } = proposed;
  return twin.weaponAmmo ? { ...rest, weaponAmmo: twin.weaponAmmo } : rest;
}
export function planStructuredComponent(input: AuthoredConstruction, proposed: AuthoredComponent) {
  proposed = fedLike(input, proposed);
  const components = input.components.some(part => part.id === proposed.id)
    ? input.components.map(part => part.id === proposed.id ? proposed : part) : [...input.components, proposed],
    result = compileDraft({ ...input, components });
  return { construction: result.construction, compiled: result.compiled,
    component: result.construction.components.find(part => part.id === proposed.id) };
}
// A new or existing weapon at the pose it is given, like any other piece: the core finds the plates its barrel fires
// through, or the one its post stands on. Put in with a reach (`faceTolerance`), the core first seats it, as it is
// turned, where the mounting made for the face nearest `point` holds it. Existing weapons keep their identity and
// ammunition.
export function planStructuredWeapon(input: AuthoredConstruction, proposed: AuthoredComponent,
  { faceTolerance = 0, point }: { faceTolerance?: number; point?: ConstructionPoint } = {}) {
  const fresh = !input.components.some(part => part.id === proposed.id);
  if (fresh && input.components.length >= PART_LIMITS.components)
    throw Object.assign(new Error(CAPACITY), { code: 'STRUCTURED_CONSTRUCTION', reason: 'AUTHORING_LIMIT' });
  if (fresh) proposed = fedLike(input, proposed);
  const tolerance = Number.isFinite(faceTolerance) ? Math.max(0, Math.min(.1, faceTolerance)) : 0,
    result = tolerance > 0
      ? structuredClone(keep(compileNativeConstruction(input, constructionCatalogue(), true, undefined, { component: proposed, tolerance, point }), true))
      : compileDraft({ ...input, components: fresh ? [...input.components, proposed] : input.components.map(part => part.id === proposed.id ? proposed : part) });
  return { construction: result.construction, compiled: result.compiled,
    component: result.construction.components.find(part => part.id === proposed.id) };
}
// What the compiler refuses of an edit that the workshop tells the player, leaving the design as it was.
export const RECOVERABLE = ['STRUCTURED_CONSTRUCTION', 'CONSTRUCTION_OVERLAP', 'CHASSIS_OVERLOAD'];
// Outer room walls for presentation, in the derived counter-clockwise room order.
export const outerWalls = (compiled: Pick<CompiledConstruction, 'rooms'>) => compiled.rooms.flatMap(room =>
  room.walls.filter(wall => wall.exterior).map(wall => ({ ...wall, roomId: room.id })));
// A cursor supplies the pose directly, on the cell nearest to it; rooms, surfaces and chassis shape never choose a
// different position for the player.
export function structuredPlacementIntent(part: { kind: AuthoredComponent['kind']; pose?: Partial<AuthoredComponentPose> }, point: ConstructionPoint, { snap = true } = {}): AuthoredComponentPose {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) fail('Posição inválida.');
  const coordinate = snap ? cellOf : unitsOf;
  return { x: coordinate(point.x - CONSTRUCTION_ORIGIN.x), y: coordinate(point.y - CONSTRUCTION_ORIGIN.y),
    angle: part.pose?.angle ?? (part.kind === 'weapon' ? Math.PI : 0),
    ...(part.pose?.mirrored ? { mirrored: true } : {}) };
}
