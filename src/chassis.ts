import { MATERIALS, PIECE_METALS } from './materials.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';
import { CELL, cellOf, metresOf, unitsOf } from './grid.ts';
import { SPRING_REST } from './running-gear.ts';
import type { MaterialId, MetalId } from './materials.ts';
import type { MessageKey } from './message-contract.ts';
import type { AuthoredChassis, ChassisModelId, ChassisPoint, ChassisProjection, ConstructionPoint, NativeAdmissionIssue, WithAbsentSlots } from './construction-contract.ts';

export interface ChassisVertex { top: ConstructionPoint; foot: ConstructionPoint; middle: ConstructionPoint }
type GearScaleOptions = Pick<AuthoredChassis, 'gearScale'>;
type ModelGear = Pick<AuthoredChassis, 'model' | 'gearScale'>;
type ChassisEnds = Pick<AuthoredChassis, 'points'>;
export type TrackQueryInput = AuthoredChassis | ModelGear & { track: NonNullable<AuthoredChassis['track']> };
export type AxleQueryInput = AuthoredChassis | ModelGear & { axles: number[] };
export interface SkidLayout { front: number; rear: number; legs: [number, number]; tube: number; end: number }

// A vehicle authors a frame, its metal and one uniform kind of running gear: wheels, a track, or the skids of an aircraft.
// game_chassis.rs admits this same description, generates its plates/gear and
// checks TOTAL mass with every fuel/ammunition/cargo reserve full, plus the
// extremes of its centre of mass as those reserves empty independently.
// Structural capacity is calculated only by the construction compiler. Its
// dimensions and margins are catalogue data, not class ratings.
// Load distribution, deflection and the dynamic allowance are simplified design
// choices; they do not certify a real vehicle or solve a deformable frame.
// The support tube scales with the running assembly; this ratio defines its
// geometry, while section, metal and load distribution determine its capacity.
export const CHASSIS_STRUCTURE = Object.freeze({ railWidth: .12, crossMemberPitch: 1.5, axleDiameterRatio: .18,
  // Geometry selection, not a strength formula: the catalogue section is the
  // eight-metre reference. Similar larger/thicker frames select deeper stock
  // profiles in 20 mm steps; the compiler then calculates their real section.
  profileLength: 8, profileStep: .02,
  // Conservative yield references: S355J2, 5083 O/H111 and annealed Ti Grade 2.
  yieldStrength: Object.freeze({ steel: 285e6, aluminum: 105e6, titanium: 275e6 }),
  deflectionRatio: 200, dynamicFactor: 2,
  youngModulus: Object.freeze(Object.fromEntries((['steel', 'aluminum', 'titanium'] as const).map(m => [m, MATERIALS[m].youngModulus]))),
  // Over a gap, the hull plates that cross it are the beam (game_chassis.rs `carry`), each of its own material, by
  // the published minimum yield and the modulus of the armour it is. Steel is the steel of the frame. The composite
  // has no yield: its laminate tensile strength. Ceramic, glass and concrete carry nothing.
  //   hha: SSAB Armox 500T, Rp0.2 ≥ 1250 MPa (3–80 mm); E 207 GPa.
  //   aluminum: 5083-H131 armour plate, MIL-DTL-46027K table VI, yield ≥ 35 ksi (241 MPa); E 70 GPa (EN AW-5083).
  //   titanium: Ti-6Al-4V armour plate to MIL-DTL-46077 (ATI 6-4-MIL), yield ≥ 120 ksi (828 MPa); E 113,8 GPa.
  //   fiberglass: woven-roving glass laminate (Revchem S101), ISO 527-4: tensile 286 MPa, modulus 18,8 GPa.
  plateYieldStrength: Object.freeze({ steel: 285e6, hha: 1250e6, aluminum: 241e6, titanium: 828e6, fiberglass: 286e6 }),
  plateYoungModulus: Object.freeze({ steel: MATERIALS.steel.youngModulus, hha: 207e9, aluminum: 70e9, titanium: 113.8e9, fiberglass: 18.8e9 }),
  rubberShare: Object.freeze({ wheeled: .55, tracked: .15 }) });

export const CHASSIS_MODELS = Object.freeze({
  wheeled: Object.freeze({ kind: 'wheeled', length: [2.5, 12] as const, deck: .9, frameMm: 8,
    travel: .25, armourMm: 40, axles: 2, axleRange: [2, 8] as const, wheel: 1.1, overhang: [.8, .8] as const, depth: .25, structure: CHASSIS_STRUCTURE }),
  tracked: Object.freeze({ kind: 'tracked', length: [3, 12] as const, deck: .86, frameMm: 20,
    armourMm: 80, track: .78, noseMm: 35, clearance: .45, structure: CHASSIS_STRUCTURE }),
  // Rails as a wheeled frame has, on skids as a light helicopter stands: two struts of cross tubes as axles are, sized as
  // for a gear `skid` high, `overhang` from the ends where nothing says otherwise, and legs down from them to a runner of
  // tube on either side, which lies on the floor however high the frame stands over it (game_chassis.rs
  // `Running::Skids`). No armour on them; the size of the gear (`gearScale`) is that of their tubes.
  aircraft: Object.freeze({ kind: 'aircraft', length: [2.5, 12] as const, deck: .9, frameMm: 8,
    armourMm: 0, depth: .25, skid: .6, overhang: [.8, .8] as const, structure: CHASSIS_STRUCTURE }),
});

export type ChassisSpec = WithAbsentSlots<typeof CHASSIS_MODELS[ChassisModelId]>;
export const isChassisModelId = (model: unknown): model is ChassisModelId => typeof model === 'string' && Object.hasOwn(CHASSIS_MODELS, model);
export function chassisSpec(model: ChassisModelId): ChassisSpec;
export function chassisSpec(model: unknown): ChassisSpec | undefined;
export function chassisSpec(model: unknown): ChassisSpec | undefined { return isChassisModelId(model) ? CHASSIS_MODELS[model] : undefined; }
function requiredAt<Value>(items: readonly Value[], index: number): Value {
  const value = items[index];
  if (value === undefined) throw new RangeError('A geometria do chassi não contém esse ponto.');
  return value;
}
function wheeledSpec(model: ChassisModelId) {
  const spec = chassisSpec(model);
  if (spec.kind !== 'wheeled') throw new TypeError('Esse chassi não usa eixos de rodas.');
  return spec;
}
function trackedSpec(model: ChassisModelId) {
  const spec = chassisSpec(model);
  if (spec.kind !== 'tracked') throw new TypeError('Esse chassi não usa esteiras.');
  return spec;
}

const KIND_LABELS = {
  wheeled: { name: 'Chassi de rodas', label: 'Rodas' },
  tracked: { name: 'Chassi de esteiras', label: 'Esteiras' },
  aircraft: { name: 'Chassi de aeronave', label: 'Aeronave' },
} satisfies Record<ChassisModelId, { name: MessageKey; label: MessageKey }>;
export const chassisName = (model: ChassisModelId) => KIND_LABELS[chassisSpec(model).kind].name;
export const chassisLabel = (model: ChassisModelId) => KIND_LABELS[chassisSpec(model).kind].label;
// The skids of an aircraft (game_chassis.rs): the runner a tube this thick at the size of the model, thinner or thicker
// with the size of the gear, lying on the floor, and its legs no shorter than `SKID_LEG` from the foot of the rails to
// its top. Where the design says nothing of them, the runner lies from `SKID_INSET` in from the front of the frame to as
// far in from its rear, and the legs stand where the model puts its struts (`overhang`). Wherever they are put, the runner
// stays between the ends of the frame, each leg stands on it no nearer either end of it than `SKID_END` at the size of
// the model — behind the toe it is bent up into, which is as large as its tube is —, and the two legs no nearer each
// other than `SKID_SPACING`. In metres.
export const SKID_TUBE = .08, SKID_LEG = .15, SKID_INSET = Object.freeze([.3, .1] as const), SKID_END = .2, SKID_SPACING = .5;
// Whether the plate of this id, as a field names it (`actor:chassis:skid-0`) or a design does, is of the skids of an
// aircraft: its runner or a leg, tubes at either side of its body that a round flies between (game_geometry.rs `skid`).
export const skidPlate = (id: string | null | undefined) => /(^|:)chassis:(skid|leg)-\d+$/.test(id ?? '');
// How much higher than its model hangs it the Oficina stands an aircraft over its skids at the most, in cells: legs
// that long stand clear of a machine gun hung pointed straight down under the hull.
export const SKID_RISE = 30;
// The authored profile runs from smaller to larger x about the stable project
// reference, its points in cells (grid.ts). Rust validates dimensions, ordering, knees and gaps. Its ends and length,
// as the running gear is reckoned, in metres.
export const chassisFront = (chassis: ChassisEnds) => metresOf(chassis.points[0].x);
export const chassisRear = (chassis: ChassisEnds) => metresOf(requiredAt(chassis.points, chassis.points.length - 1).x);
export const chassisLength = (chassis: ChassisEnds) => chassisRear(chassis) - chassisFront(chassis);
// A level chassis from `front` to `rear` (in cells), of two points on its deck, on the cell nearest to the deck of its
// model.
export const straightChassis = (model: ChassisModelId, front: number, rear: number): AuthoredChassis => {
  const y = cellOf(chassisSpec(model).deck - VEHICLE_ORIGIN.y);
  return { model, points: [{ x: front, y }, { x: rear, y }] };
};
// Its segments, from the front: the `index`-th from its point `a` to the next, `b`, a gap where `a` says so.
export const chassisSegments = (chassis: AuthoredChassis) => chassis.points.slice(0, -1).map((a, index) => ({ index, a, b: requiredAt(chassis.points, index + 1), gap: a.gap === true }));
// The chassis with its point `index` at `x`, `y` (in cells), its gap as it was.
// Array edit methods forget tuple length; these guarded edits retain both endpoints.
export function withPoint(chassis: AuthoredChassis, index: number, { x, y }: ConstructionPoint): AuthoredChassis {
  if (!(index in chassis.points)) return chassis;
  return { ...chassis, points: chassis.points.with(index, { ...requiredAt(chassis.points, index), x, y }) as AuthoredChassis['points'] };
}
// The chassis with a point more at `x` along the design (in cells), exactly on the segment it is put in
// there; none where it is no segment with a frame, or at an end.
export function withPointAdded(chassis: AuthoredChassis, x: number): AuthoredChassis | null {
  const segment = chassisSegments(chassis).find(({ a, b }) => x > a.x && x < b.x);
  if (!segment || segment.gap) return null;
  const { index, a, b } = segment, y = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
  return { ...chassis, points: chassis.points.toSpliced(index + 1, 0, { x, y }) as AuthoredChassis['points'] };
}
// The chassis without its point `index`, the segments either side of it one; a gap beside it takes the whole of that
// one. Its ends stay: none without one.
export function withPointRemoved(chassis: AuthoredChassis, index: number): AuthoredChassis | null {
  const points = chassis.points;
  if (!(index > 0 && index < points.length - 1)) return null;
  const { gap: _, ...before } = requiredAt(points, index - 1), gap = requiredAt(points, index - 1).gap === true || requiredAt(points, index).gap === true;
  return { ...chassis, points: points.toSpliced(index - 1, 2, gap ? { ...before, gap: true } : before) as AuthoredChassis['points'] };
}
// The chassis with the segment from its point `index` a gap, or not.
export function withGap(chassis: AuthoredChassis, index: number, on: boolean): AuthoredChassis {
  if (!(index in chassis.points)) return chassis;
  const { gap: _, ...point } = requiredAt(chassis.points, index);
  return { ...chassis, points: chassis.points.with(index, on ? { ...point, gap: true } : point) as AuthoredChassis['points'] };
}
// Each vertex of a chassis as the core outlines it (game_chassis.rs `outlines`, `under_way`), one for each of its points
// from the front: the point on the top of the frame (`top`), the foot of the frame under it (`foot`) and halfway down
// between them (`middle`). The foot is as deep under the stretch either side of it, where the two meet at a knee,
// square to its stretch at an end of a part between gaps and, at the front of a tub, at the foot of its nose. Told by
// `outlines`, one for each part between gaps, its top from the front back and then under each point from the rear
// forward, as the compiled chassis has them in the field and the plate of its frame in the frame of its picture.
export function chassisVertices({ outlines }: Pick<ChassisProjection, 'outlines'>): ChassisVertex[] {
  return outlines.flatMap(outline => {
    const n = outline.length / 2;
    return outline.slice(0, n).map((top, k) => {
      const foot = requiredAt(outline, 2 * n - 1 - k);
      return { top, foot, middle: { x: (top.x + foot.x) / 2, y: (top.y + foot.y) / 2 } };
    });
  });
}
// The stretch of a chassis `point` is on within `tolerance` of it, by the index of the vertex it starts at, or null for
// none: in the outline of the stretch from the top of that vertex to that of the next and back by their feet
// (`chassisVertices`, from the front), the first from the front when two are near. `skip` says which stretches not to
// take, by the same index (the gaps, where only the frame would be).
export function chassisStretchOf(vertices: readonly Pick<ChassisVertex, 'top' | 'foot'>[], point: ConstructionPoint, tolerance: number = 0, skip: readonly boolean[] = []) {
  const index = vertices.slice(0, -1).findIndex(({ top, foot }, i) => {
    if (skip[i]) return false;
    const after = requiredAt(vertices, i + 1), quad = [top, after.top, after.foot, foot];
    let inside = true, sign = 0;
    for (const [k, a] of quad.entries()) {
      const b = requiredAt(quad, (k + 1) % 4), side = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
      if (Math.abs(side) > 1e-12 && sign && Math.sign(side) !== sign) inside = false;
      if (Math.abs(side) > 1e-12 && !sign) sign = Math.sign(side);
    }
    if (inside) return true;
    return quad.some((a, k) => {
      const b = requiredAt(quad, (k + 1) % 4), dx = b.x - a.x, dy = b.y - a.y,
        t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t) <= tolerance;
    });
  });
  return index < 0 ? null : index;
}
// What the player shapes of a chassis besides its model and its points, each optional in `chassis` (game_chassis.rs
// validates it; these are the same rules, for the editor to move what it draws):
// - `metal`: the structural metal of both frame and gear, steel when omitted.
//   Changing it preserves authored millimetres; material minimum gauges apply.
// - `axles` (wheeled): where its axles stand along the design, in cells, between the fewest and the most of its model
//   (`axleRange`), each wheel whole within the ends of the frame, and no nearer the next than a wheel across and
//   `AXLE_GAP`. Where nothing says, they stand where
//   the model puts them: `axles` evenly spaced between `overhang` from the ends. Each carries according to its real
//   support section and the selected metal.
// - `track` (tracked): its physical ascending ends and centre height, `{ front, rear, y }`, in fractional cells.
//   Height comes only from gearScale. Its road wheels are derived from its real dimensions, never authored or a
//   length quantizer. An omitted track spans the frame up to the model's maximum aspect ratio, on the floor
//   (`trackFloorY`). Explicit coordinates are retained even at that default; later edits must not silently
//   redistribute it. The Oficina keeps the belt on the floor, as wheels are: what changes how high the hull rides over
//   it moves the hull (chassis-editing.ts); the compiler admits any centre within the reach of the suspension.
// - `skids` (aircraft): the ends of its runner and where its two legs stand along the design, `{ front, rear, legs: [a,
//   b] }`, in fractional cells as the track's are, the legs from the front. How high the hull stands over them is not
//   written: they lie on the floor. An omitted one is where the model puts it (`SKID_INSET`, `overhang`); written, it
//   stays written, as a track does, for an edit of the points of the frame not to move it. Its size is `gearScale`.
// The functions below tell the gear where it stands, in local metres, including the track's centre y.
export const AXLE_GAP = .1, MIN_ROAD_WHEELS = 3, MAX_ROAD_WHEELS = 14, MAX_CHASSIS_LENGTH = 12;
export const CHASSIS_GEAR_SCALE = Object.freeze({ min: .5, max: 1.5 });
// The frame is of what its running gear may be, which is of it: a metal, never glass fibre.
export const CHASSIS_METALS = PIECE_METALS.wheel;
export type ChassisMetalId = typeof CHASSIS_METALS[number];
export const isChassisMetalId = (value: unknown): value is ChassisMetalId => CHASSIS_METALS.some(metal => metal === value);
const NEAR = 1e-7, specOf = (chassis: Pick<AuthoredChassis, 'model'>) => chassisSpec(chassis.model);
// Thickness is the real section gauge; changing metal never changes it.
export const frameThicknessMm = (chassis: Pick<AuthoredChassis, 'model' | 'thicknessMm'>) => chassis.thicknessMm ?? chassisSpec(chassis.model).frameMm;
// Both kinds use the same twelve-metre construction envelope.
export const chassisLengthRange = (model: ChassisModelId): [number, number] => [CHASSIS_MODELS[chassisSpec(model).kind].length[0], MAX_CHASSIS_LENGTH];
export const chassisGearScale = (chassis: GearScaleOptions) => chassis.gearScale ?? 1;
export const chassisGearSize = (chassis: ModelGear) => {
  const spec = specOf(chassis), size = spec.kind === 'wheeled' ? spec.wheel : spec.kind === 'tracked' ? spec.track : spec.skid;
  return size * chassisGearScale(chassis);
};
// The real suspension offset (game_chassis.rs `suspension`) relative to the model's sizing zero. Wheeled gear keeps
// its level floor line; a track has its own authored centre. Both use the same bounded reach, in fractional cells.
// A raised arch does not lower that reference. The editor changes this offset of either by moving the construction
// over its gear, which stays on the floor.
export const SUSPENSION_REACH = 4;
// Where the centre of a track `height` high stands on the floor, in local metres: its belt a centimetre over it, where
// the compiler hangs a track that does not say (game_chassis.rs `read`).
export const trackFloorY = (height: number) => height / 2 + .01 - VEHICLE_ORIGIN.y;
// How deep the stock profile of the frame is: the rails of a wheeled chassis or an aircraft, the tub of a tracked one,
// over its sizing deck `deck` (game_chassis.rs `profile_depth`). The rails of an aircraft are those for skids of the
// model's size, however large its skids are.
function profileDepth(chassis: AuthoredChassis, deck: number) {
  const spec = specOf(chassis), { profileLength, profileStep: step, axleDiameterRatio } = spec.structure,
    scale = spec.kind === 'aircraft' ? 1 : chassisGearScale(chassis), thickness = frameThicknessMm(chassis),
    base = spec.kind === 'tracked' ? spec.deck - spec.clearance : spec.depth,
    desired = base * Math.sqrt(chassisLength(chassis) / profileLength * scale * thickness / spec.frameMm),
    least = Math.ceil(2 * thickness / 1000 / step - 1e-9) * step,
    most = Math.floor((deck - (spec.kind === 'aircraft' ? spec.skid : chassisGearSize(chassis)) * axleDiameterRatio) / step + 1e-9) * step;
  return Math.min(most, Math.max(least, Math.ceil(desired / step - 1e-9) * step));
}
// Where the model of a chassis hangs gear of the size it has, as the cell of its deck in the construction's local
// reference, the first no lower than the deck it is sized for (game_chassis.rs `deck`): that of the model, raised by
// what the gear grows, on wheels as high as the rails clear their axle tubes with the wheels at their stop, and on
// skids as high as their legs are long enough.
export function suspensionZero(chassis: AuthoredChassis) {
  const spec = specOf(chassis), size = chassisGearSize(chassis);
  let deck = spec.deck + (spec.kind === 'wheeled' ? (size - spec.wheel) / 2 : spec.kind === 'tracked' ? size - spec.track : 0);
  if (spec.kind === 'wheeled') deck = Math.max(deck, size / 2 + .01 + profileDepth(chassis, deck) + size * spec.structure.axleDiameterRatio / 2
    + spec.travel * (1 - SPRING_REST));
  if (spec.kind === 'aircraft') deck = Math.max(deck, .01 + skidTube(chassis) + SKID_LEG + profileDepth(chassis, deck));
  return Math.ceil((deck - VEHICLE_ORIGIN.y) / CELL - 1e-9) || 0;
}
// How thick across the runner of the skids of an aircraft is, of the size of its gear.
const skidTube = (chassis: GearScaleOptions) => SKID_TUBE * chassisGearScale(chassis);
// How much lower and higher than where its model hangs it an aircraft may stand over its skids, in cells: as low as
// leaves the legs from its rails to their runner `SKID_LEG` long, as high as `SKID_RISE` over that.
export function skidRange(chassis: AuthoredChassis) {
  const legs = suspensionZero(chassis) * CELL + VEHICLE_ORIGIN.y - profileDepth(chassis, specOf(chassis).deck) - .01 - skidTube(chassis);
  return { min: -Math.floor((legs - SKID_LEG) / CELL + 1e-9), max: SKID_RISE };
}
// In cells, as its points are. An aircraft's is how much higher than its model hangs it it stands over its skids.
export function suspensionHeight(chassis: AuthoredChassis) {
  const ordinary = Math.min(...chassis.points.map(point => point.y)) - suspensionZero(chassis);
  if (specOf(chassis).kind !== 'tracked') return ordinary;
  const track = chassisTrack(chassis);
  return ordinary - unitsOf(track.y - trackFloorY(track.height));
}
export function frameThicknessRange(chassis: Pick<AuthoredChassis, 'model' | 'metal'>) {
  const spec = specOf(chassis);
  return { min: MATERIALS[chassis.metal ?? 'steel'].minThicknessMm, max: spec.kind === 'tracked' ? 200 : spec.depth * 500 };
}
// How near the axles of a model stand to one another at the nearest.
export const axleSpacing = (model: ChassisModelId, options: GearScaleOptions = {}) => wheeledSpec(model).wheel * chassisGearScale(options) + AXLE_GAP;
// `count` supports `size` across where the model puts them, evenly spaced between its `overhang` from either end. On a
// chassis too short for them, both overhangs give up what the wheels need between them, as far as a wheel's radius
// (game_chassis.rs `spaced`). The struts of skids are spaced so too, as large as the runner's tube.
const spaced = (model: ChassisModelId, front: number, rear: number, count: number, size: number) => {
  const spec = chassisSpec(model), half = size / 2,
    overhang = spec.kind === 'tracked' ? null : spec.overhang;
  if (!overhang) throw new TypeError('Esse chassi não usa apoios espaçados.');
  const
    ahead = Math.max(overhang[0], half), behind = Math.max(overhang[1], half),
    short = Math.max((count - 1) * (size + AXLE_GAP) - (rear - front - ahead - behind), 0) / 2,
    first = front + Math.max(ahead - short, half), last = rear - Math.max(behind - short, half);
  return Array.from({ length: count }, (_, i) => first + (last - first) * i / (count - 1));
};
// The axles of a wheeled chassis along the design, from the front, in metres.
export const chassisAxles = (chassis: AxleQueryInput) => {
  if (chassis.axles) return chassis.axles.map(metresOf).sort((a, b) => a - b);
  if (!('points' in chassis)) throw new TypeError('O chassi não contém pontos para distribuir seus eixos.');
  return spaced(chassis.model, chassisFront(chassis), chassisRear(chassis), wheeledSpec(chassis.model).axles, chassisGearSize(chassis));
};
// Capture the actual axle positions in authored units; only editor gestures choose whether to snap.
const axlePositions = (axles: readonly number[]) => axles.map(unitsOf);
// The reference aspect envelope, not the spacing or a quantizer of an authored track. Its actual road wheels are
// distributed by running-gear.ts trackWheels / game_geometry.rs track_wheels over the continuous physical span.
export const roadWheelPitch = (model: ChassisModelId, options: GearScaleOptions = {}) => 5.04 / 7 * (trackedSpec(model).track * chassisGearScale(options) / .74);
export const trackLength = (model: ChassisModelId, wheels: number, options: GearScaleOptions = {}) => (wheels === 7 ? 5.04 : 5.04 * wheels / 7) * (trackedSpec(model).track * chassisGearScale(options) / .74);
export const trackLengthRange = (chassis: ModelGear): [number, number] => [trackLength(chassis.model, MIN_ROAD_WHEELS, chassis), trackLength(chassis.model, MAX_ROAD_WHEELS, chassis)];
// The one writer of a physical span and centre, all in local metres. It imposes no authoring grid or wheel count.
export function writtenTrack(chassis: AuthoredChassis, front: number, rear: number, y: number = chassisTrack(chassis).y) {
  return { front: unitsOf(front), rear: unitsOf(rear), y: unitsOf(y) };
}
// The physical span and centre of a tracked chassis in local metres. The count is a readout of the same dimensional
// rule used by contact geometry and drawing; it never changes either endpoint.
export function chassisTrack(chassis: TrackQueryInput) {
  const height = chassisGearSize(chassis);
  let front, rear, y;
  if (chassis.track) {
    front = metresOf(chassis.track.front); rear = metresOf(chassis.track.rear); y = metresOf(chassis.track.y);
  } else {
    if (!('points' in chassis)) throw new TypeError('O chassi não contém pontos para posicionar sua esteira.');
    const length = Math.min(chassisLength(chassis), trackLengthRange(chassis)[1]);
    front = chassisFront(chassis); rear = front + length;
    y = trackFloorY(height);
  }
  const wheels = Math.min(MAX_ROAD_WHEELS, Math.max(MIN_ROAD_WHEELS, Math.round((rear - front) / roadWheelPitch(chassis.model, chassis))));
  return { front, rear, y, height, wheels };
}
// The skids of an aircraft along the design, in local metres: the ends of its runner, where its two legs stand from the
// front, how thick across its tube is and how far in from either end of the runner a leg stands at the nearest (`end`),
// as the compiler reads them (game_chassis.rs `read`).
export function chassisSkids(chassis: AuthoredChassis): SkidLayout {
  const tube = skidTube(chassis), end = SKID_END * chassisGearScale(chassis);
  if (chassis.skids) {
    const legs: [number, number] = [metresOf(chassis.skids.legs[0]), metresOf(chassis.skids.legs[1])];
    return { front: metresOf(chassis.skids.front), rear: metresOf(chassis.skids.rear), legs: legs.sort((a, b) => a - b), tube, end };
  }
  const front = chassisFront(chassis), rear = chassisRear(chassis);
  const positions = spaced(chassis.model, front, rear, 2, tube);
  return { front: front + SKID_INSET[0], rear: rear - SKID_INSET[1], legs: [requiredAt(positions, 0), requiredAt(positions, 1)], tube, end };
}
// The one writer of skids where they are put, from local metres: the legs from the front. It imposes no grid.
export const writtenSkids = (front: number, rear: number, legs: readonly [number, number]): NonNullable<AuthoredChassis['skids']> => {
  const written: [number, number] = [unitsOf(legs[0]), unitsOf(legs[1])];
  return { front: unitsOf(front), rear: unitsOf(rear), legs: written.sort((a, b) => a - b) };
};
// The same refusal codes as the compiler for chassis drag bounds, or nothing.
export function gearProblem(chassis: AuthoredChassis): NativeAdmissionIssue | null {
  const spec = specOf(chassis), refuse = (code: string, fields: Partial<NativeAdmissionIssue> = {}): NativeAdmissionIssue => ({ code, model: chassis.model, ...fields });
  if (chassis.metal !== undefined && !isChassisMetalId(chassis.metal)) return refuse('FIELD', { field: 'metal' });
  const scale = chassisGearScale(chassis), thickness = frameThicknessMm(chassis), range = frameThicknessRange(chassis);
  if (chassis.gearScale !== undefined && !Number.isFinite(chassis.gearScale) || !Number.isFinite(scale) || scale < CHASSIS_GEAR_SCALE.min || scale > CHASSIS_GEAR_SCALE.max) return refuse('FIELD', { field: 'gearScale' });
  if (chassis.thicknessMm !== undefined && !Number.isFinite(chassis.thicknessMm) || !Number.isFinite(thickness) || thickness < range.min || thickness > range.max) return refuse('FIELD', { field: 'thicknessMm' });
  if (spec.kind !== 'aircraft' && chassis.skids) return refuse('CHASSIS_GEAR_KIND');
  if (spec.kind === 'wheeled') {
    if (chassis.track) return refuse('CHASSIS_GEAR_KIND');
    if (chassis.axles?.some(x => !Number.isFinite(x))) return refuse('AXLES', { field: 'axles' });
    const axles = chassisAxles(chassis), [fewest, most] = spec.axleRange, half = chassisGearSize(chassis) / 2;
    if (axles.length < fewest || axles.length > most) return refuse('AXLE_COUNT');
    if (axles.some(x => !Number.isFinite(x) || x < chassisFront(chassis) + half - NEAR || x > chassisRear(chassis) - half + NEAR)) return refuse('AXLE_EXTENT');
    if (axles.some((x, i) => i && x - requiredAt(axles, i - 1) < axleSpacing(chassis.model, chassis) - NEAR)) return refuse('AXLE_SPACING');
    return null;
  }
  // Skids stand on the runner under the frame, their two legs apart.
  if (spec.kind === 'aircraft') {
    if (chassis.axles || chassis.track) return refuse('CHASSIS_GEAR_KIND');
    const written = chassis.skids;
    if (written && !(Number.isFinite(written.front) && Number.isFinite(written.rear) && Array.isArray(written.legs) && written.legs.length === 2
      && written.legs.every(Number.isFinite))) return refuse('FIELD', { field: 'skids' });
    const { front, rear, legs, end } = chassisSkids(chassis), off = legs.findIndex(x => x < front + end - NEAR || x > rear - end + NEAR);
    if (front < chassisFront(chassis) - NEAR || rear > chassisRear(chassis) + NEAR) return refuse('SKID_EXTENT');
    if (off >= 0) return refuse('SKID_RUNNER', { index: off, least: end });
    return legs[1] - legs[0] < SKID_SPACING - NEAR ? refuse('SKID_SPACING', { least: SKID_SPACING }) : null;
  }
  if (chassis.axles) return refuse('CHASSIS_GEAR_KIND');
  if (chassis.track) {
    if (![chassis.track.front, chassis.track.rear, chassis.track.y].every(Number.isFinite)) return refuse('FIELD', { field: 'track' });
  }
  const track = chassisTrack(chassis), length = track.rear - track.front, [least, most] = trackLengthRange(chassis);
  if (length < least - NEAR || length > most + NEAR) return refuse('TRACK_LENGTH');
  return track.front < chassisFront(chassis) - NEAR || track.rear > chassisRear(chassis) + NEAR ? refuse('TRACK_EXTENT') : null;
}
// The chassis with its gear written only where the model does not put it: `axles` or `track` as they are written, in
// cells.
function plain(chassis: AuthoredChassis, { axles }: { axles?: number[] } = {}): AuthoredChassis {
  const { axles: _, track: __, ...rest } = chassis;
  if (axles) {
    const even = chassisAxles(rest), sorted = [...axles].sort((a, b) => a - b);
    return sorted.length === even.length && sorted.every((x, i) => Math.abs(metresOf(x) - requiredAt(even, i)) < NEAR) ? rest : { ...rest, axles: sorted };
  }
  return rest;
}
// The chassis with its running gear written where it stands, in cells: moving its points cannot silently redistribute
// it.
export function withGearWritten(chassis: AuthoredChassis): AuthoredChassis {
  if (specOf(chassis).kind === 'aircraft') {
    const { front, rear, legs } = chassisSkids(chassis);
    return { ...chassis, skids: chassis.skids ?? writtenSkids(front, rear, legs) };
  }
  if (specOf(chassis).kind === 'wheeled') return { ...chassis, axles: chassis.axles ?? axlePositions(chassisAxles(chassis)) };
  const track = chassisTrack(chassis);
  return { ...chassis, track: chassis.track ?? writtenTrack(chassis, track.front, track.rear, track.y) };
}
// The chassis on so many axles, evenly spaced where the model puts its first and last, or over all the frame when
// they do not fit there; nothing when they fit nowhere or the model is not made with so many.
export function withAxleCount(chassis: AuthoredChassis, count: number): AuthoredChassis | null {
  const spec = specOf(chassis);
  if (spec.kind !== 'wheeled') return null;
  const [fewest, most] = spec.axleRange;
  if (!(count >= fewest && count <= most)) return null;
  const { axles: _, ...rest } = chassis, axles = axlePositions(spaced(chassis.model, chassisFront(chassis), chassisRear(chassis), count, chassisGearSize(chassis)));
  return gearProblem({ ...rest, axles }) ? null : plain(rest, { axles });
}
// An axle stays between the frame ends and its neighbours, independently of arches and gaps above it, on the cell
// at `x` (in metres) as far as those bounds allow; the editor applies its optional snap before calling.
export function withAxle(chassis: AuthoredChassis, index: number, x: number): AuthoredChassis {
  const axles = chassisAxles(chassis), half = chassisGearSize(chassis) / 2, spacing = axleSpacing(chassis.model, chassis);
  if (!(index in axles)) return chassis;
  const lo = Math.max(chassisFront(chassis) + half, index ? requiredAt(axles, index - 1) + spacing : -Infinity),
    hi = Math.min(chassisRear(chassis) - half, index < axles.length - 1 ? requiredAt(axles, index + 1) - spacing : Infinity);
  if (!Number.isFinite(x) || lo > hi) return chassis;
  const written = chassis.axles ? [...chassis.axles].sort((a, b) => a - b) : axlePositions(axles);
  return plain(chassis, { axles: written.with(index, unitsOf(Math.min(hi, Math.max(lo, x)))) });
}
// Continuous track transforms affect only the chosen span, centre along the design or height; the belt stays on the
// floor. Geometry and mechanical admission decide whether the requested result is usable; no invalid request silently
// resizes or moves another part.
export function withTrackSpan(chassis: AuthoredChassis, front: number, rear: number): AuthoredChassis {
  const current = chassisTrack(chassis);
  return { ...chassis, track: writtenTrack(chassis, front, rear, current.y) };
}
export function withTrackPosition(chassis: AuthoredChassis, x: number): AuthoredChassis {
  const track = chassisTrack(chassis), dx = x - (track.front + track.rear) / 2;
  return { ...chassis, track: writtenTrack(chassis, track.front + dx, track.rear + dx, track.y) };
}
export const withTrackHeight = (chassis: AuthoredChassis, height: number) => withGearScale(chassis, height / trackedSpec(chassis.model).track);
export function withTrackEnd(chassis: AuthoredChassis, end: 'front' | 'rear', x: number): AuthoredChassis {
  const track = chassisTrack(chassis);
  return withTrackSpan(chassis, end === 'front' ? x : track.front, end === 'rear' ? x : track.rear);
}
// The chassis of another metal: steel is the one that is not written. Nothing for a metal no frame is made of.
export function withChassisMetal(chassis: AuthoredChassis, metal: MetalId): AuthoredChassis | null {
  if (!isChassisMetalId(metal)) return null;
  const thickness = frameThicknessMm(chassis),
    { metal: _, thicknessMm: __, ...rest } = chassis, changed = metal === 'steel' ? rest : { ...rest, metal };
  return withFrameThickness(changed, thickness);
}
export function withFrameThickness(chassis: AuthoredChassis, thicknessMm: number): AuthoredChassis {
  const { thicknessMm: _, ...rest } = chassis;
  return Math.abs(thicknessMm - frameThicknessMm({ model: chassis.model })) < NEAR ? rest : { ...rest, thicknessMm };
}
// Tyres keep their axle positions. A track keeps its physical span and stays on the floor, growing up from it; its
// supports are derived from those dimensions. Skids keep their runner and their legs where they are, their tubes thinner
// or thicker on the floor. Invalid geometry stays explicit for the compiler to diagnose.
export function withGearScale(chassis: AuthoredChassis, gearScale: number): AuthoredChassis {
  const explicit = specOf(chassis).kind === 'tracked' ? withGearWritten(chassis) : chassis,
    { gearScale: _, ...rest } = explicit, changed = gearScale === 1 ? rest : { ...rest, gearScale };
  if (!Number.isFinite(gearScale) || gearScale <= 0 || specOf(chassis).kind === 'aircraft') return changed;
  if (specOf(chassis).kind === 'wheeled') return plain(changed, { axles: chassis.axles ?? axlePositions(chassisAxles(chassis)) });
  const track = changed.track;
  if (!track) throw new TypeError('A esteira não foi escrita antes de mudar sua escala.');
  return { ...changed, track: { ...track, y: unitsOf(trackFloorY(chassisGearSize(changed))) } };
}
// The runner of skids with its `end` ('front' or 'rear') at `x`, its legs where they were; their legs all with their
// runner `dx` further along the design; and one leg, `index` from the front, at `x`. In local metres, written as they are
// asked, as the track's ends are: the compiler says whether the skids stand so, and nothing else of them moves.
export function withSkidEnd(chassis: AuthoredChassis, end: 'front' | 'rear', x: number): AuthoredChassis {
  const { front, rear, legs } = chassisSkids(chassis);
  return { ...chassis, skids: writtenSkids(end === 'front' ? x : front, end === 'rear' ? x : rear, legs) };
}
export function withSkidsMoved(chassis: AuthoredChassis, dx: number): AuthoredChassis {
  const { front, rear, legs } = chassisSkids(chassis);
  return { ...chassis, skids: writtenSkids(front + dx, rear + dx, [legs[0] + dx, legs[1] + dx]) };
}
export function withSkidLeg(chassis: AuthoredChassis, index: number, x: number): AuthoredChassis {
  const { front, rear, legs } = chassisSkids(chassis);
  return index in legs ? { ...chassis, skids: writtenSkids(front, rear, [index === 0 ? x : legs[0], index === 1 ? x : legs[1]]) } : chassis;
}
