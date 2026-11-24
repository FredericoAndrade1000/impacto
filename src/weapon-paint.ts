import { WEAPON_PRESETS, weaponMountSize, weaponOf, weaponBase, weaponCompartment } from './weapons.ts';
import { weaponBarrelProfile, weaponMaterialRole } from './weapon-geometry.ts';
import { kit, shade } from './machine-art.ts';
import { TUBE_FITTINGS, tubeFittings } from './weapon-fittings.ts';
import { facetBoundary } from './facet-boundary.ts';
import { paintWeathering } from './weathering.ts';
import { context2d } from './canvas-art.ts';
import type { ArtCanvas, ArtContext, CanvasFactory, XY } from './canvas-art.ts';
import type { WeatheringMaps } from './weathering.ts';
import type { Point } from './math.ts';
import type { WeaponId, WeaponPresetId, WeaponFamilyId } from './weapons.ts';
import type { WeaponGeometry } from './weapon-geometry.ts';
import type { TubeFitting, TubeMuzzle } from './weapon-fittings.ts';
export type WeaponPart = 'all' | 'receiver' | 'moving' | 'cradle';
export interface WeaponBox { x0: number; x1: number; y0: number; y1: number }
// The compartment of a gun's ready rounds (weapons.ts `weaponCompartment`), as its layout carries it: its belt or magazine
// of `rounds`, `behind` metres of it behind the gun's own receiver and, of a belt's can, `beside` metres beside it; the
// height the core gives it, the calibre of its rounds and the length of the gun's own receiver, m; and whether its roof is
// blow-out panels (`vented`).
export interface LaidCompartment { kind: 'belt' | 'magazine'; rounds: number; behind: number; beside: number; height: number; calibre: number; receiver: number;
  vented: boolean }
interface LayoutBase { preset: WeaponPresetId; family: WeaponFamilyId; barrels: number; turn: number; receiver: WeaponBox; tube: WeaponBox; b: number; r: number; cy: number;
  compartment: LaidCompartment | null }
// How a gun is painted besides its geometry: `animated`, for the field, where its turning barrels and its ready rounds
// are pictures of their own over it (weapon-sprites.ts), so neither is painted in; `cut`, its compartment wrecked.
export interface WeaponLook { animated?: boolean | undefined; cut?: boolean | undefined }
interface BenchLayout extends LayoutBase { mounted: false; mantlets: null; proud: { up: number; down: number }; reserve?: never;
  exposed?: never; base?: never; contours?: never; body?: never; support?: never }
interface MountedLayoutBase extends LayoutBase { mounted: true; mantlets: WeaponBox[]; base: WeaponBox[]; reserve: number;
  contours: { receiver: Point[]; tube: Point[]; base: Point[][]; mantlets: Point[][] }; shieldEdges: [Point, Point][]; proud?: never }
interface EnclosedLayout extends MountedLayoutBase { exposed?: false; body?: never; support?: never }
export interface ExposedLayout extends MountedLayoutBase { exposed: true; body: WeaponBox; support: WeaponBox }
export type WeaponLayout = BenchLayout | EnclosedLayout | ExposedLayout;
export interface WeaponCanvasArt<C extends ArtCanvas = ArtCanvas> { canvas: C; scale: number; originX: number; originY: number }
export interface WeaponCanvasOptions extends WeaponLook { scale?: number | undefined; pad?: number; create?: CanvasFactory | undefined; weathering?: WeatheringMaps | null }
type WeaponKit = ReturnType<typeof kit> & { weathering: WeatheringMaps | null };
type Lathe = ReturnType<typeof lathe>;
type ReceiverFrame = ReturnType<typeof receiverFrame>;
type PaintedFitting = Omit<TubeFitting, 'y' | 'reach'> & { cy: number; r: number; k: number; y: number; reach: number; L: WeaponLayout; mounted: boolean };
type PaintedMuzzle = ReturnType<typeof tubeFittings>['muzzle'] & { cy: number; r: number; rb: number; k: number; L: WeaponLayout; mounted: boolean };


// Painted weapon artwork, by the rule of every piece (machine-art.ts): a strict side elevation, the light from above,
// only what turns across the gun drawn round. Each gun is drawn as the real one is, its receiver after its own and its
// barrel with its fittings at their real distances from the trunnion (weapon-fittings.ts). Units are metres in the
// weapon's own frame, +x along the bore and +y its lit side, painted on a canvas whose y runs down: what stands up is
// drawn at -y. Mounted art is clipped to native contours; direct-shot queries
// omit the tube separately. Only bench art lets fittings stand proud of it.
const GUNMETAL = '#3f4a45', STEEL = '#56635c', PARKER = '#47524c', ARMOUR = '#6d7b72', OLIVE = '#5f6c46', BRASS = '#b29a5a',
  RUBBER = '#232b27', BORE = '#070b09', OUTLINE = '#111c17', GLINT = '#d6ddbe', PANEL_TONE = '#78847a';
const UNCOATED_DETAILS = new Set([RUBBER, BRASS, BORE, '#c9b561', '#2c3430', '#9b2f22', '#8a2a1e']);
// One physical scale in the weapon's metre frame. Finish goes onto a filled
// metal face before its ports, seals, lettering and fasteners are drawn.
function finishMetal(a: WeaponKit, x: number, y: number, width: number, height: number, base = STEEL, material = 'steel') {
  if (!a.weathering || UNCOATED_DETAILS.has(base) || width < .012 || height < .012) return false;
  return paintWeathering(a.ctx, a.weathering, { x, y, width, height },
    { material, chips: .11, rust: .025, dirt: .055, oil: .04, period: .7 });
}
function weaponKit(ctx: ArtContext, scale: number, weathering: WeatheringMaps | null) {
  const a = Object.assign(kit(ctx, scale), { weathering });
  if (weathering) {
    const housing = a.housing;
    a.housing = (x, y, width, height, base, radius = .01) => {
      housing(x, y, width, height, base, radius);
      // Keep the procedural lip and outline crisp. Everything added by the
      // caller (holes, grips, bolts and markings) is still drawn over the face.
      const inset = Math.max(a.hair(1.8), .0035);
      if (width > inset * 2 && height > inset * 2 && !UNCOATED_DETAILS.has(base)) {
        a.path(x + inset, y + inset, width - 2 * inset, height - 2 * inset, Math.max(0, radius - inset));
        finishMetal(a, x + inset, y + inset, width - 2 * inset, height - 2 * inset, base);
        // Canvas save/restore does not preserve the current path. Restore the
        // exact native housing tail: its lit lip, or its rounded face.
        const lip = Math.max(a.hair(1.6), .0032), nativeInset = Math.max(radius, lip * 2);
        if (width > 2 * nativeInset && height > 4 * lip) {
          ctx.beginPath(); ctx.moveTo(x + nativeInset, y + lip); ctx.lineTo(x + width - nativeInset, y + lip);
        } else a.path(x, y, width, height, radius);
      }
    };
  }
  return a;
}
// The middle of each of as many things of a pitch as fit along a length, the lot standing in its middle.
const along = (from: number, length: number, pitch: number, draw: (position: number, index: number) => void) => {
  const n = Math.max(0, Math.floor(length / pitch + 1e-9)), start = (length - n * pitch) / 2;
  for (let i = 0; i < n; i++) draw(from + start + (i + .5) * pitch, i);
};

// A flipped layout keeps the light above a weapon whose native +y points down.
// A gun carried whole on a post, as on an exposed mount, has for its fixed solid
// the post, in the mount's frame, and for the two others the receiver behind
// the trunnion and the barrel support before it; drawn whole, the post stands
// square under the level gun. Off any mount, a gun is laid out from its own
// receiver and barrel, its fittings standing proud of the tube by as much as
// they do on the real one.
export function weaponLayout(presetId: WeaponId | null | undefined, polygons: readonly (readonly Point[])[] | null = null, flip = 1, reserve = 0, exposed = false): WeaponLayout {
  // Drawn as the gun of the catalogue it was made of, to the measures of its own.
  const own: WeaponId = presetId && weaponOf(presetId) ? presetId : 'rh120', preset = weaponBase(own), family = WEAPON_PRESETS[preset].family,
    barrels = weaponOf(own)?.steel?.barrels ?? 1, compartment = laidCompartment(own);
  if (polygons) {
    // The fixed mechanism may be turned about the pivot. Its own box is
    // recovered unturned; `turn` says how it lies against the bore.
    const laid = polygons.map(poly => poly.map(p => ({ x: p.x, y: p.y * flip }))),
      spin = Math.atan2(laid[0]![1]!.y - laid[0]![0]!.y, laid[0]![1]!.x - laid[0]![0]!.x), turn = Math.abs(spin) < 1e-9 ? 0 : spin,
      c = Math.cos(turn), s = Math.sin(turn),
      [receiverShape, tubeShape, ...otherShapes] = laid.map((poly, index) => {
        const points = index || !turn ? poly : poly.map(p => ({ x: c * p.x + s * p.y, y: c * p.y - s * p.x })),
          xs = points.map(p => p.x), ys = points.map(p => p.y);
        return { points, box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } };
      }),
      baseShapes = otherShapes.filter((_, i) => weaponMaterialRole(exposed, i + 2) === 'base'),
      mantletShapes = otherShapes.filter((_, i) => weaponMaterialRole(exposed, i + 2) !== 'base'),
      carried = exposed ? { exposed: true as const, turn: Math.PI / 2, body: mantletShapes[0]!.box, support: mantletShapes[1]!.box } : null;
    mantletShapes.sort((a, b) => a.box.y0 - b.box.y0);
    const receiver = receiverShape!.box, tube = tubeShape!.box, mantlets = mantletShapes.map(shape => shape.box),
      contours = { receiver: receiverShape!.points, tube: tubeShape!.points, base: baseShapes.map(shape => shape.points), mantlets: mantletShapes.map(shape => shape.points) };
    const mounted: MountedLayoutBase = { preset, family, barrels, compartment, mounted: true, turn, receiver, tube, mantlets, base: baseShapes.map(shape => shape.box), contours, shieldEdges: exposed ? [] : facetBoundary(contours.mantlets), reserve,
      b: tube.x1, r: (tube.y1 - tube.y0) / 2, cy: (tube.y0 + tube.y1) / 2 };
    return carried ? { ...mounted, ...carried } : mounted;
  }
  const { end: b, radius: r } = weaponBarrelProfile({ weaponPreset: own }), { width, height } = weaponMountSize(own);
  return { preset, family, barrels, compartment, mounted: false, turn: 0, mantlets: null, b, r, cy: 0, proud: fittingReach(preset, b, r, 0),
    receiver: { x0: -width, x1: 0, y0: -height / 2, y1: height / 2 }, tube: { x0: 0, x1: b, y0: -r, y1: r } };
}
// A core not loaded yet tells no compartment: the gun is drawn without it.
function laidCompartment(id: WeaponId): LaidCompartment | null {
  let told: ReturnType<typeof weaponCompartment>;
  try { told = weaponCompartment(id); } catch { return null; }
  if (!told || !(told.rounds > 0) || told.kind !== 'belt' && told.kind !== 'magazine') return null;
  return { kind: told.kind, rounds: told.rounds, behind: Math.max(0, told.lengthM || 0), beside: Math.max(0, told.besideM || 0),
    height: told.heightM, calibre: (weaponOf(id)?.caliberMm ?? 12.7) / 1000, receiver: weaponOf(id)?.receiver.length ?? 0, vented: Boolean(told.vented) };
}

// How far the fittings of a gun off any mount stand above and below its tube's box: a carrying handle, a sight, a brake
// wider than the barrel.
function fittingReach(preset: WeaponPresetId, b: number, r: number, start: number) {
  const table = TUBE_FITTINGS[preset]!, k = r / table.radius, { muzzle, fittings } = tubeFittings(preset, b, start);
  let up = 0, down = 0;
  for (const f of [muzzle, ...fittings]) {
    const half = f.d * k / 2, y = (('y' in f ? f.y : 0) || 0) * k, reach = 'reach' in f ? f.reach : 0;
    up = Math.max(up, (reach && f.kind !== 'grip' ? reach * k : y + half) - r);
    down = Math.max(down, (f.kind === 'grip' ? reach! * k : half - y) - r);
  }
  return { up, down };
}

// 'receiver' is measured in the mechanism's own frame; 'all' in the bore's.
export function weaponPartBounds(L: WeaponLayout, part: WeaponPart = 'all') {
  const boxes = part === 'cradle' ? (L.exposed ? [] : [...(L.mantlets || [])])
    : part === 'receiver' ? [L.receiver] : [L.tube, ...(part === 'moving' && L.mounted && !L.exposed ? [] : L.mantlets || [])];
  if ((part === 'cradle' || part === 'all') && L.reserve! > 0) boxes.push(recoilFrameBounds(L));
  // Off any mount the fittings stand proud of the tube.
  if (!L.mounted && part !== 'receiver') boxes.push({ x0: L.tube.x0, x1: L.b, y0: -L.r - L.proud.down, y1: L.r + L.proud.up });
  if (part === 'all') {
    boxes.push(...(L.base || []));
    const c = Math.cos(L.turn), s = Math.sin(L.turn), box = L.receiver,
      xs = ([box.x0, box.x1] as const).flatMap(x => ([box.y0, box.y1] as const).map(y => c * x - s * y)),
      ys = ([box.x0, box.x1] as const).flatMap(x => ([box.y0, box.y1] as const).map(y => s * x + c * y));
    boxes.push(L.turn ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : box);
  }
  return { x0: Math.min(...boxes.map(box => box.x0)), x1: Math.max(...boxes.map(box => box.x1)),
    y0: Math.min(...boxes.map(box => box.y0)), y1: Math.max(...boxes.map(box => box.y1)) };
}

export function recoilFrameBounds(L: WeaponLayout) {
  const body = L.exposed ? L.body : L.receiver;
  return { x0: body.x0 - L.reserve!, x1: body.x0, y0: body.y0, y1: body.y1 };
}

// The few shapes a gun is made of besides machine-art.ts's: a turned part lying along the bore, rounded by the light
// from above; a cone; a ring round a barrel; a hole through a turned part, round where it faces the eye and narrowed
// towards the rims, as a hole drilled square into a cylinder is seen from its side.
function lathe(a: WeaponKit) {
  const round = (top: number, r: number, base: string) => a.gradient(0, top, 0, top + 2 * r, [([0, shade(base, -.35)] as const), ([.1, shade(base, .08)] as const),
    ([.24, shade(base, .42)] as const), ([.38, shade(base, .12)] as const), ([.64, base] as const), ([.88, shade(base, -.4)] as const), ([1, shade(base, -.58)] as const)]);
  const turned = (x0: number, x1: number, cy: number, r: number, base: string, { cap = 0, line = true, material = 'steel' }: { cap?: number; line?: boolean; material?: string } = {}) => {
    if (!(x1 > x0) || !(r > 0)) return;
    a.path(x0, cy - r, x1 - x0, 2 * r, Math.min(cap, r)); a.fill(round(cy - r, r, base));
    // Clipping the current path can cache a flattened device-space version.
    // Recreate the authored path before its original outline is stroked.
    if (finishMetal(a, x0, cy - r, x1 - x0, 2 * r, base, material))
      a.path(x0, cy - r, x1 - x0, 2 * r, Math.min(cap, r));
    if (line) a.stroke(OUTLINE, Math.min(a.edge, r * .2));
  };
  const cone = (x0: number, x1: number, cy: number, r0: number, r1: number, base: string) => {
    if (!(x1 > x0)) return;
    const points = [([x0, cy - r0] as const), ([x1, cy - r1] as const), ([x1, cy + r1] as const), ([x0, cy + r0] as const)];
    a.shape(points); a.fill(round(cy - Math.max(r0, r1), Math.max(r0, r1), base));
    if (finishMetal(a, x0, cy - Math.max(r0, r1), x1 - x0, 2 * Math.max(r0, r1), base)) a.shape(points);
    a.stroke(OUTLINE, Math.min(a.edge, Math.max(r0, r1) * .2));
  };
  const ring = (x0: number, x1: number, cy: number, r: number, base: string) => {
    turned(x0, x1, cy, r, base);
    for (const x of ([x0, x1] as const)) a.line(x, cy - r * .92, x, cy + r * .92, '#0f1a15a0', Math.min(a.hair(1), (x1 - x0) * .4));
  };
  const hole = (x: number, y: number, w: number, h: number, cy: number, r: number) => {
    const squeeze = Math.sqrt(Math.max(0, 1 - ((y - cy) / r) ** 2));
    a.ctx.beginPath(); a.ctx.ellipse(x, y, w / 2, Math.max(a.hair(.6), h / 2 * squeeze), 0, 0, Math.PI * 2);
    a.fill(BORE); a.stroke('#9aa58a50', a.hair(.8));
  };
  return { turned, cone, ring, hole };
}

// The barrel and what it carries, from where it leaves its mount to its muzzle (weapon-fittings.ts), and the mouth of the
// bore: every diameter in proportion to the tube's box.
// The barrels of a rotary gun about its axis, within the tube's box (game_variant.rs `derive`: touching, about the axis):
// those beyond the axis first and darker, then those before it, clamped together at their middle and at their muzzles.
// In the field the barrels turn (weapon-sprites.ts): each is a picture of its own (`rotorPiece`), drawn where `rotorLook`
// has it at the angle the rotor has come to, and the clamps over them another.
export function rotorLook(L: WeaponLayout) {
  const n = L.barrels, start = L.tube.x0, end = L.b, tube = L.r / (1 + 1 / Math.sin(Math.PI / n));
  // On a post the front of the cradle covers the root of the barrels: they show from where it ends.
  return { n, cy: -L.cy, start, from: L.exposed ? Math.max(start, Math.min(end - tube, L.support.x1 - .004)) : start, end, tube, around: L.r - tube, r: L.r };
}
// The height of a barrel at `turn` about the axis of the rotor, and how much darker it is beyond the axis.
export const rotorBarrel = (look: ReturnType<typeof rotorLook>, turn: number) => ({ y: look.cy + look.around * Math.sin(turn), depth: Math.cos(turn) });
function rotorRings(a: WeaponKit, look: ReturnType<typeof rotorLook>) {
  const lath = lathe(a), { start, end, cy, r } = look;
  for (const at of [.35, .96] as const) {
    const x = start + (end - start) * at, half = Math.min(.025, (end - start) * .02);
    lath.ring(x - half, Math.min(end, x + half), cy, r, GUNMETAL);
  }
}
function paintRotor(a: WeaponKit, L: WeaponLayout) {
  const look = rotorLook(L), lath = lathe(a),
    turns = Array.from({ length: look.n }, (_, i) => 2 * Math.PI * (i + .5) / look.n).sort((p, q) => Math.cos(p) - Math.cos(q));
  for (const turn of turns) lath.turned(look.start, look.end, rotorBarrel(look, turn).y, look.tube, shade(PARKER, Math.cos(turn) < 0 ? -.25 : 0));
  rotorRings(a, look);
}
function paintTube(a: WeaponKit, L: WeaponLayout, animated = false) {
  if (L.barrels > 1) { if (!animated) paintRotor(a, L); return; }
  const T = TUBE_FITTINGS[L.preset]!, k = L.r / T.radius, cy = -L.cy, start = L.tube.x0, b = L.b, mounted = L.mounted,
    { muzzle, fittings } = tubeFittings(L.preset, b, start), at = (d: number) => d * k / 2, lath = lathe(a);
  // The body: a barrel tapering to its muzzle device, a sleeve over it, or the skin of a pod.
  const r0 = at(T.barrel[0]!), r1 = at(T.barrel[1]!), end = muzzle.from;
  if (T.pod) {
    lath.turned(start, end + a.hair(1), cy, r0, OLIVE);
    for (const y of ([-.55, .55] as const)) a.rib(start + .02, cy + r0 * y, end - .02, cy + r0 * y, .0025);
  } else if (T.sleeve) {
    // The thermal sleeve in its lengths, each a little narrower towards the muzzle, the seam between them.
    const lengths = Math.max(1, Math.round((end - start) / .6));
    for (let i = 0; i < lengths; i++) {
      const x0 = start + (end - start) * i / lengths, x1 = start + (end - start) * (i + 1) / lengths,
        r = r0 + (r1 - r0) * (i + .5) / lengths;
      lath.turned(x0, x1 + a.hair(1), cy, r, i % 2 ? '#5d6a55' : '#5a6752', { line: false, material: 'composite' });
      a.line(x1, cy - r, x1, cy + r, '#141d18c0', a.hair(1.4));
    }
    a.line(start, cy - Math.max(r0, r1), end, cy - Math.max(r0, r1), OUTLINE, a.edge * .8);
    a.line(start, cy + Math.max(r0, r1), end, cy + Math.max(r0, r1), OUTLINE, a.edge * .8);
  } else lath.cone(start, end + a.hair(1), cy, r0, r1, L.family === 'rocket' ? OLIVE : PARKER);
  // A long steel barrel catches a thin line of light along its top.
  if (!T.pod && end - start > .3) a.line(start + .02, cy - r0 * .52, end - .02, cy - r1 * .52, GLINT + '38', Math.max(a.hair(1), r1 * .12));
  for (const f of fittings) FITTINGS[f.kind]!(a, lath, { ...f, cy, r: at(f.d), k, y: cy - (f.y || 0) * k, reach: (f.reach || 0) * k, L, mounted });
  MUZZLES[muzzle.kind]!(a, lath, { ...muzzle, cy, r: at(muzzle.d), rb: r1, k, L, mounted });
}

// The fittings along a barrel, each between `from` and `to` from the trunnion; `r` is its half-width, `y` the height of
// its own axis, `reach` how far it stands above the bore (or below, for a grip).
const FITTINGS: Record<TubeFitting['kind'], (a: WeaponKit, lath: Lathe, fitting: PaintedFitting) => void> = {
  // A perforated jacket: rows of holes round it, the middle row facing the eye.
  jacket(a, lath, f) {
    lath.turned(f.from, f.to, f.cy, f.r, GUNMETAL);
    const pitch = Math.max(.024, f.r * 1.15), rows = f.rows || 3, hole = Math.min(pitch * .62, f.r * .5);
    for (let row = 0; row < rows; row++) {
      const y = f.cy + f.r * .62 * (row - (rows - 1) / 2) / Math.max(1, (rows - 1) / 2);
      along(f.from + pitch * .3, f.to - f.from - pitch * .6, pitch, (x, i) => lath.hole(x + (row % 2) * pitch * .5 - pitch * .25, y, hole, hole, f.cy, f.r * 1.05));
    }
    a.line(f.from + a.hair(2), f.cy - f.r * .55, f.to - a.hair(2), f.cy - f.r * .55, GLINT + '30', a.hair(1));
  },
  // A barrel-support tube with two long holes through it.
  support(a, lath, f) {
    lath.turned(f.from, f.to, f.cy, f.r, GUNMETAL);
    const length = f.to - f.from;
    for (const t of ([.22, .55] as const)) {
      const x = f.from + length * t, w = Math.min(length * .2, f.r * 2.4);
      a.path(x, f.cy - f.r * .38, w, f.r * .76, f.r * .38); a.fill(BORE); a.stroke('#9aa58a50', a.hair(.8));
    }
    a.bolt(f.from + length * .08, f.cy - f.r * .55, Math.min(.006, f.r * .12));
  },
  sleeve(a, lath, f) { lath.turned(f.from, f.to, f.cy, f.r, GUNMETAL); a.rib(f.from + .01, f.cy + f.r * .3, f.to - .01, f.cy + f.r * .3, .0025); },
  // Rings round a barrel at a pitch of their own: cooling fins, a ribbed sleeve, the thread of a barrel's root.
  ribbed(a, lath, f) {
    lath.turned(f.from, f.to, f.cy, f.r * .86, STEEL);
    along(f.from, f.to - f.from, f.pitch || .02, x => lath.ring(x - (f.pitch || .02) * .28, x + (f.pitch || .02) * .28, f.cy, f.r, GUNMETAL));
  },
  collar(a, lath, f) { lath.ring(f.from, f.to, f.cy, f.r, GUNMETAL); },
  // A clamping band, its bolt standing out of it.
  band(a, lath, f) {
    lath.ring(f.from, f.to, f.cy, f.r, shade(STEEL, -.1));
    a.stud((f.from + f.to) / 2, f.cy - f.r * .55, Math.min(.008, (f.to - f.from) * .3), 'y');
  },
  // A bore evacuator: a chamber round the barrel swelling to it on short cones.
  evacuator(a, lath, f) {
    const taper = Math.min((f.to - f.from) * .16, f.r * .7), rb = f.r * .72;
    lath.cone(f.from, f.from + taper, f.cy, rb, f.r, '#5d6a55');
    lath.turned(f.from + taper - a.hair(.5), f.to - taper + a.hair(.5), f.cy, f.r, '#5f6c57', { line: false });
    lath.cone(f.to - taper, f.to, f.cy, f.r, rb, '#5d6a55');
    a.line(f.from + taper, f.cy - f.r, f.to - taper, f.cy - f.r, OUTLINE, a.edge * .8);
    a.line(f.from + taper, f.cy + f.r, f.to - taper, f.cy + f.r, OUTLINE, a.edge * .8);
    for (const x of ([f.from + taper * 1.6, f.to - taper * 1.6] as const)) a.line(x, f.cy - f.r * .9, x, f.cy + f.r * .9, '#141d18a0', a.hair(1.2));
    a.wear(f.from + taper, f.cy - f.r, f.to - f.from - 2 * taper, f.r, 3);
  },
  // A carrying handle on the barrel: its clamp, the post up from it and the grip along the barrel.
  handle(a, lath, f) {
    const top = f.cy - f.reach, grip = Math.max(.01, (f.reach - f.r) * .38), post = f.from + (f.to - f.from) * .18;
    lath.ring(f.from, f.from + (f.to - f.from) * .3, f.cy, f.r, GUNMETAL);
    a.shape([([post - .006, f.cy - f.r] as const), ([post + .012, f.cy - f.r] as const), ([post + .016, top + grip] as const), ([post - .004, top + grip] as const)]);
    a.fill(GUNMETAL); a.stroke(OUTLINE, a.hair(1));
    a.path(post - .006, top, f.to - post + .006, grip, grip * .45); a.fill(a.gradient(0, top, 0, top + grip, [[0, '#4a524d'], ([1, RUBBER] as const)]));
    a.stroke(OUTLINE, a.hair(1));
    along(post + .01, f.to - post - .02, .008, x => a.line(x, top + grip * .2, x, top + grip * .8, '#0b100d80', a.hair(.8)));
  },
  // A gas cylinder under the barrel, from the receiver to the gas block.
  gas(a, lath, f) { lath.turned(f.from, f.to, f.y, f.r, STEEL); },
  // The gas block and its regulator, and the front sight where it stands on it.
  gasblock(a, lath, f) {
    const top = f.cy - f.r * .7, bottom = f.y + f.r;
    a.housing(f.from, top, f.to - f.from, bottom - top, GUNMETAL, .004);
    lath.ring(f.from + (f.to - f.from) * .55, f.to, f.y, f.r * .62, STEEL);
    along(f.from + (f.to - f.from) * .58, (f.to - f.from) * .4, .005, x => a.line(x, f.y - f.r * .5, x, f.y + f.r * .5, '#0b100d70', a.hair(.7)));
  },
  // A front sight post up from a clamp, its blade on top as high as the sight reaches.
  sight(a, lath, f) {
    const top = f.cy - f.reach, w = f.to - f.from, blade = top + (f.reach - f.r) * .25;
    lath.ring(f.from - w * .4, f.to + w * .4, f.cy, f.r, GUNMETAL);
    a.shape([([f.from - w * .2, f.cy - f.r] as const), ([f.from + w * .1, blade] as const), ([f.to - w * .1, blade] as const), ([f.to + w * .2, f.cy - f.r] as const)]);
    a.fill(a.gradient(0, blade, 0, f.cy, [([0, shade(GUNMETAL, .25)] as const), ([1, GUNMETAL] as const)])); a.stroke(OUTLINE, a.hair(1));
    a.path(f.from + w * .3, top, w * .4, blade - top, w * .1); a.fill(STEEL); a.stroke(OUTLINE, a.hair(.8));
  },
  // The collar of a tank gun's muzzle reference sensor and, on it, the box of its mirror, looked into by the sight.
  mrs(a, lath, f) {
    lath.ring(f.from, f.to, f.cy, f.r, '#52604c');
    const w = (f.to - f.from) * 1.4, x = (f.from + f.to) / 2 - w / 2, top = f.cy - f.reach;
    a.housing(x, top, w, f.cy - f.r * .8 - top, '#4b5844', .004);
    a.path(x + w * .12, top + (f.reach - f.r) * .25, w * .2, (f.reach - f.r) * .35, .002); a.fill('#1a2330'); a.stroke(OUTLINE, a.hair(.8));
  },
  // A pod's suspension lug: the ring standing on its strongback, and the pads of the sway braces either side.
  lug(a, lath, f) {
    const top = f.cy - f.reach, w = f.to - f.from, foot = f.cy - f.r;
    a.housing(f.from - w * .6, foot - (f.reach - f.r) * .3, w * 2.2, (f.reach - f.r) * .3 + .004, '#56624a', .003);
    a.ctx.beginPath(); a.ctx.arc((f.from + f.to) / 2, top + w * .45, w * .45, Math.PI, 0); a.ctx.lineTo(f.to, foot - (f.reach - f.r) * .3); a.ctx.lineTo(f.from, foot - (f.reach - f.r) * .3); a.ctx.closePath();
    a.fill(STEEL); a.stroke(OUTLINE, a.hair(1));
    a.circle((f.from + f.to) / 2, top + w * .45, w * .2, BORE);
  },
  // A grip under the barrel, raked forward, on its clamp.
  grip(a, lath, f) {
    const bottom = f.cy + f.reach, w = f.to - f.from;
    lath.ring(f.from - w * .3, f.to + w * .3, f.cy, f.r * 1.04, RUBBER);
    a.shape([([f.from, f.cy + f.r] as const), ([f.to, f.cy + f.r] as const), ([f.to + w * .35, bottom] as const), ([f.from + w * .2, bottom] as const)]);
    a.fill(a.gradient(f.from, 0, f.to, 0, [[0, '#2c3430'], [.4, '#3d4641'], [1, '#1c2320']])); a.stroke(OUTLINE, a.hair(1));
    along(f.cy + f.r + .01, f.reach - f.r - .02, .012, y => a.line(f.from + w * .25, y, f.to + w * .1, y, '#0b100d70', a.hair(.8)));
  },
  // The collar a mortar's mount holds the tube by, with its clamping bolt.
  clamp(a, lath, f) {
    lath.ring(f.from, f.to, f.cy, f.r, GUNMETAL);
    a.housing((f.from + f.to) / 2 - (f.to - f.from) * .2, f.cy - f.r * 1.0, (f.to - f.from) * .4, f.r * .5, STEEL, .002);
    a.stud((f.from + f.to) / 2, f.cy - f.r * .82, Math.min(.007, (f.to - f.from) * .12), 'x');
  },
  // The cap screwed on a mortar's base, its firing pin inside.
  basecap(a, lath, f) {
    lath.turned(f.from, f.to, f.cy, f.r, GUNMETAL, { cap: f.r * .5 });
    a.line(f.to - (f.to - f.from) * .3, f.cy - f.r * .9, f.to - (f.to - f.from) * .3, f.cy + f.r * .9, '#0f1a15a0', a.hair(1));
  },
};

// The devices at a muzzle, measured back from it; `rb` is the barrel's half-width where it meets them. Each leaves the
// mouth of the bore dark at the muzzle.
const mouth = (a: WeaponKit, f: PaintedMuzzle, r: number) => { a.path(f.to - Math.max(a.hair(1.5), .003), f.cy - r, Math.max(a.hair(1.5), .003), 2 * r); a.fill(BORE); };
// A machined side port: a chamfer catching the light, the thick inner wall
// and a dark chamber behind it. All of it is painted once into the tube's art.
function bafflePort(a: WeaponKit, x: number, y: number, w: number, h: number) {
  const bevel = Math.min(w * .12, h * .09), corner = Math.min(w * .18, h * .12),
    outline = (left: number, top: number, width: number, height: number, cut: number) => a.shape([
      ([left + cut, top] as const), ([left + width - cut, top] as const), ([left + width, top + cut] as const),
      ([left + width, top + height - cut] as const), ([left + width - cut, top + height] as const),
      ([left + cut, top + height] as const), ([left, top + height - cut] as const), ([left, top + cut] as const),
    ]);
  outline(x, y, w, h, corner);
  a.fill(a.gradient(x, y, x + w * .3, y + h, [[0, '#17221f'], [.35, '#2d3a34'], [.78, '#778271'], [1, '#46564b']]));
  a.stroke('#19251f', Math.min(a.hair(.8), bevel * .5));
  const left = x + bevel, top = y + bevel, right = x + w - bevel, bottom = y + h - bevel;
  outline(left, top, right - left, bottom - top, corner * .65);
  a.fill(a.gradient(left, top, right, bottom, [[0, '#070d0b'], [.5, '#0c1511'], [.82, '#17231c'], [1, '#26352a']]));
  // The forward wall stands proud of the chamber; its foot is lit, while
  // the upper lip casts a narrow shadow. Avoid a round, lens-like highlight.
  a.shape([([right - bevel * .8, top + corner] as const), ([right, top + corner * .65] as const),
    ([right, bottom - corner * .65] as const), ([right - bevel * 1.5, bottom - corner] as const)]);
  a.fill(a.gradient(right - bevel * 1.5, top, right, bottom, [[0, '#1d2b24'], [.6, '#324336'], [1, '#4e6050']]));
  a.line(left + corner, top, right - corner, top, '#050b09c0', Math.min(a.hair(1), bevel * .6));
  a.line(left + corner, y + h - bevel * .35, right - corner, y + h - bevel * .35,
    '#adb39a55', Math.min(a.hair(.8), bevel * .4));
}
const MUZZLES: Record<TubeMuzzle['kind'], (a: WeaponKit, lath: Lathe, muzzle: PaintedMuzzle) => void> = {
  crown(a, lath, f) { lath.turned(f.from, f.to, f.cy, Math.max(f.rb, f.r * .9), PARKER); lath.ring(f.to - (f.to - f.from) * .35, f.to, f.cy, f.r, GUNMETAL); mouth(a, f, f.rb * .45); },
  collar(a, lath, f) { lath.ring(f.from, f.to, f.cy, f.r, GUNMETAL); mouth(a, f, f.r * .55); },
  lip(a, lath, f) { lath.ring(f.from, f.to, f.cy, f.r, GUNMETAL); mouth(a, f, f.r * .78); },
  // The muzzle of a tank gun, bare and narrower than the sleeve.
  plain(a, lath, f) { lath.turned(f.from, f.to, f.cy, f.r, STEEL); a.line(f.from + (f.to - f.from) * .3, f.cy - f.r, f.from + (f.to - f.from) * .3, f.cy + f.r, '#141d18a0', a.hair(1)); mouth(a, f, f.r * .78); },
  // A flash hider: a cone opened by long slots, as a machine gun's is.
  hider(a, lath, f) {
    const length = f.to - f.from;
    lath.cone(f.from, f.to, f.cy, f.rb, f.r, GUNMETAL);
    for (const y of ([-.4, 0, .4] as const)) a.path(f.from + length * .3, f.cy + f.r * y - f.r * .1, length * .62, f.r * .2, f.r * .1), a.fill(BORE);
    mouth(a, f, f.r * .55);
  },
  // A stack of rings, the suppressor of a chain gun.
  rings(a, lath, f) {
    const length = f.to - f.from, n = Math.max(3, Math.round(length / Math.max(.012, f.r * .5)));
    lath.turned(f.from, f.to, f.cy, f.r * .7, GUNMETAL);
    for (let i = 0; i < n; i++) lath.ring(f.from + length * (i + .15) / n, f.from + length * (i + .75) / n, f.cy, f.r, i % 2 ? GUNMETAL : shade(GUNMETAL, .08));
    mouth(a, f, f.r * .45);
  },
  // A short brake with its ports through it.
  brake(a, lath, f) {
    const length = f.to - f.from;
    lath.turned(f.from, f.to, f.cy, f.r, GUNMETAL, { cap: f.r * .2 });
    for (const t of ([.22, .48, .74] as const)) lath.hole(f.from + length * t, f.cy, length * .14, f.r * 1.3, f.cy, f.r * 1.4);
    mouth(a, f, f.r * .45);
  },
  // A brake of many baffles, a slot between each two.
  baffles(a, lath, f) {
    const length = f.to - f.from, n = 5;
    lath.cone(f.from, f.from + length * .12, f.cy, f.rb, f.r, GUNMETAL);
    lath.turned(f.from + length * .1, f.to, f.cy, f.r, GUNMETAL);
    for (let i = 1; i < n; i++) a.path(f.from + length * (.12 + .88 * i / n) - length * .03, f.cy - f.r * .62, length * .06, f.r * 1.24, length * .02), a.fill(BORE);
    mouth(a, f, f.r * .5);
  },
  // The unit at the muzzle of a 35 mm gun that measures each round's speed and sets its fuze: its coils in their housing,
  // and the brake in front.
  velocity(a, lath, f) {
    const length = f.to - f.from, brake = length * .3;
    lath.cone(f.from, f.from + length * .1, f.cy, f.rb, f.r, '#4d5a50');
    lath.turned(f.from + length * .1, f.to - brake, f.cy, f.r, '#4d5a50');
    for (const t of ([.3, .5] as const)) lath.ring(f.from + length * t, f.from + length * (t + .06), f.cy, f.r * 1.02, GUNMETAL);
    a.tube([([f.from + length * .2, f.cy - f.r * .4] as const), ([f.from - length * .15, f.cy - f.r * .4] as const)], Math.min(.012, f.r * .14), '#22291f');
    lath.turned(f.to - brake, f.to, f.cy, f.r * .7, GUNMETAL, { cap: f.r * .1 });
    for (const t of ([.3, .65] as const)) lath.hole(f.to - brake + brake * t, f.cy, brake * .2, f.r * .9, f.cy, f.r);
    mouth(a, f, f.r * .3);
  },
  // Two chambers in one brake, with broad side vents and a solid web between
  // them. The bevels and front face stay inside the existing device dimensions.
  baffle(a, lath, f) {
    const length = f.to - f.from, h = f.r, x0 = f.from + length * .13,
      face = Math.min(length * .07, h * .16), x1 = f.to - face,
      top = f.cy - h, bottom = f.cy + h, cut = Math.min(length * .055, h * .16), body = x1 - x0;
    lath.cone(f.from, x0 + cut, f.cy, f.rb * 1.04, h * .72, GUNMETAL);
    lath.ring(f.from + length * .025, f.from + length * .09, f.cy, f.rb * 1.14, STEEL);
    a.shape([([x0 + cut, top] as const), ([x1 - cut, top] as const), ([x1, top + cut] as const), ([x1, bottom - cut] as const),
      ([x1 - cut, bottom] as const), ([x0 + cut, bottom] as const), ([x0, bottom - cut] as const), ([x0, top + cut] as const)]);
    a.fill(a.gradient(x0, top, x0, bottom, [[0, '#7d8978'], [.12, '#56665b'], [.4, '#4a5a50'], [.8, '#35453a'], [1, '#1e2d24']]));
    finishMetal(a, x0, top, body, 2 * h);
    a.stroke(OUTLINE, Math.min(a.edge, cut * .35));
    a.shape([([x0 + cut, top] as const), ([x1 - cut, top] as const), ([x1, top + cut] as const),
      ([x0 + cut * .6, top + cut * 1.3] as const), ([x0, top + cut] as const)]);
    a.fill(a.gradient(x0, top, x0, top + cut * 1.3, [[0, '#adb49b'], [1, '#647362']]));
    a.line(x0 + cut, bottom - cut * .35, x1 - cut, bottom - cut * .35, '#121e17a0', a.hair(.8));
    a.wear(x0 + cut, top + cut, body - 2 * cut, 2 * h - 2 * cut, 9);
    for (const from of ([.09, .55] as const)) bafflePort(a, x0 + body * from, f.cy - h * .61, body * .33, h * 1.22);
    // The thick front wall and its bore are distinct from the two side vents.
    a.shape([([x1 - cut * .25, top + cut] as const), ([f.to, top + cut * 1.5] as const),
      ([f.to, bottom - cut * 1.5] as const), ([x1 - cut * .25, bottom - cut] as const)]);
    a.fill(a.gradient(x1, top, f.to, bottom, [[0, '#77846f'], [.45, '#4e6050'], [1, '#25382a']]));
    finishMetal(a, x1 - cut * .25, top + cut, f.to - x1 + cut * .25, 2 * h - 2 * cut);
    a.line(f.to - a.hair(.8), top + cut * 1.8, f.to - a.hair(.8), bottom - cut * 1.8,
      '#9aa78c65', Math.min(a.hair(.8), face * .3));
    mouth(a, f, Math.min(h * .4, f.rb * .8));
  },
  // A mortar's blast attenuator: a squat sleeve over the muzzle, ported round.
  bad(a, lath, f) {
    const length = f.to - f.from;
    lath.turned(f.from, f.to, f.cy, f.r, GUNMETAL, { cap: f.r * .15 });
    for (const t of ([.35, .7] as const)) lath.hole(f.from + length * t, f.cy, length * .16, f.r * .7, f.cy, f.r);
    mouth(a, f, f.r * .7);
  },
  // A launcher's bumper over its mouth.
  endcap(a, lath, f) { lath.turned(f.from, f.to, f.cy, f.r, RUBBER, { cap: f.r * .25 }); a.rib(f.from + (f.to - f.from) * .4, f.cy - f.r * .9, f.from + (f.to - f.from) * .4, f.cy + f.r * .9, .0025); mouth(a, f, f.r * .7); },
  // The front of a rocket pod: the fairing ring round its tube mouths.
  fairing(a, lath, f) { lath.turned(f.from, f.to, f.cy, f.r * 1.01, shade(OLIVE, -.15), { cap: f.r * .06 }); mouth(a, f, f.r * .8); },
};

// Each gun's receiver laid out in its box (`R`): `X(t)` from the rear of the box (0) to the trunnion (1), `Y(v)` from the
// bore down (-1) and up (1), in shares of the box. Every one is drawn inside its box: it is the solid the mechanism is.
// What has a size of its own — a bolt, a rivet, a link of a belt — keeps it in a box of any size.
function receiverFrame(a: WeaponKit, box: WeaponBox) {
  const top = -box.y1, bottom = -box.y0, inset = a.edge / 2, W = box.x1 - box.x0, H = bottom - top,
    X = (t: number) => box.x0 + inset + (W - 2 * inset) * t, Y = (v: number) => (top + bottom) / 2 - (H - 2 * inset) * v / 2;
  return { x0: box.x0, x1: box.x1, top, bottom, W, H, cy: (top + bottom) / 2, X, Y,
    // A housing between shares of the box.
    block: (t0: number, t1: number, v0: number, v1: number, base: string, r = .008) => a.housing(X(t0), Y(v1), X(t1) - X(t0), Y(v0) - Y(v1), base, Math.min(r, (X(t1) - X(t0)) / 3, (Y(v0) - Y(v1)) / 3)),
    // Rivets in a row between two shares, at a pitch of their own.
    rivets: (t0: number, t1: number, v: number, pitch = .03, r = .0035) => along(X(t0), X(t1) - X(t0), pitch, x => a.circle(x, Y(v), r, '#7f8a7b', '#1b2620', a.hair(.8))) };
}

// A belt or a chute of links down from a feed into the hull: a link of a size of its own at each step of a curve. It goes
// no further than the box `R` it is drawn in, round ends and all.
function chute(a: WeaponKit, R: ReceiverFrame, route: readonly XY[], width: number, color = '#3f4a3c') {
  const pitch = Math.max(.012, width * .45), keep = width * .6,
    points = route.map(([x, y]) => ([Math.min(R.x1 - keep, Math.max(R.x0 + keep, x)), Math.min(R.bottom - keep, Math.max(R.top + keep, y))] as const));
  a.tube(points, width, color);
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!, [x1, y1] = points[i]!, step = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / step, ny = (x1 - x0) / step;
    for (let s = (pitch - walked % pitch) % pitch; s < step; s += pitch) {
      const x = x0 + (x1 - x0) * s / step, y = y0 + (y1 - y0) * s / step;
      a.line(x - nx * width * .46, y - ny * width * .46, x + nx * width * .46, y + ny * width * .46, '#141c17b0', a.hair(1));
    }
    walked += step;
  }
}

// The throat of a feeder a belt goes into from the side, between shares of the receiver's box: dark within, the light on
// its lower lip.
function feedThroat(a: WeaponKit, R: ReceiverFrame, t0: number, t1: number, v0: number, v1: number) {
  const { X, Y } = R, h = Y(v0) - Y(v1);
  a.path(X(t0), Y(v1), X(t1) - X(t0), h, Math.min(.004, h * .3)); a.fill(BORE); a.stroke(OUTLINE, a.hair(1));
  a.line(X(t0) + h * .3, Y(v0) - a.hair(1), X(t1) - h * .3, Y(v0) - a.hair(1), '#aab39a66', a.hair(1));
}

// Spade grips seen from their side: the near grip upright on its two arms, the far one behind it, the trigger between.
function spadeGrips(a: WeaponKit, R: ReceiverFrame, t1: number, low: number, high: number) {
  const { X, Y } = R;
  for (const v of ([high - .06, low + .06] as const)) R.block(0, t1, v - .07, v + .07, STEEL, .004);
  R.block(.004, t1 * .58, low, high, RUBBER, .012);
  along(Y(high) + .006, Y(low) - Y(high) - .012, .012, y => a.line(X(.012), y, X(t1 * .56), y, '#0a0f0c90', a.hair(.8)));
  R.block(t1 * .7, t1 * .96, -.18, .14, shade(STEEL, .15), .003);
}

const RECEIVERS: Record<WeaponPresetId, (a: WeaponKit, R: ReceiverFrame, L: WeaponLayout) => void> = {
  // Browning M2HB: the spade grips behind the backplate, the receiver box riveted along its side plates, the retracting
  // slide handle in its slot, the feedway with a round in it, the top cover over the feed tray with its latch and the
  // rear sight leaf folded before it, the trunnion block at its front with the pin the cradle holds it by.
  m2hb(a, R) {
    const { X, Y } = R;
    spadeGrips(a, R, .12, -.78, .7);
    R.block(.12, .18, -.94, .86, GUNMETAL, .012);
    R.block(.17, .9, -.86, .58, PARKER, .004);
    R.rivets(.2, .86, .44); R.rivets(.2, .86, -.72);
    a.rib(X(.19), Y(-.5), X(.86), Y(-.5), .002);
    a.path(X(.3), Y(-.08), X(.62) - X(.3), Y(-.24) - Y(-.08), .002); a.fill(BORE);
    R.block(.52, .58, -.32, .02, STEEL, .003); a.bolt(X(.55), Y(-.15), Math.min(.006, R.H * .04));
    a.path(X(.64), Y(.46), X(.8) - X(.64), Y(.06) - Y(.46), .003); a.fill(BORE);
    a.path(X(.66), Y(.34), X(.78) - X(.66), Y(.18) - Y(.34), Y(.18) - Y(.34)); a.fill(a.gradient(0, Y(.34), 0, Y(.18), [[0, '#e0cd8e'], [1, '#8a7240']]));
    R.block(.42, .87, .56, .94, STEEL, .004);
    along(X(.46), X(.84) - X(.46), .02, x => a.line(x, Y(.6), x, Y(.9), '#0f1a1550', a.hair(.8)));
    R.block(.42, .47, .58, .98, shade(STEEL, .18), .003);
    R.block(.3, .37, .58, .76, GUNMETAL, .003);
    R.block(.86, 1, -.96, .92, GUNMETAL, .006);
    a.circle(X(.93), Y(-.55), Math.min(.012, R.H * .09), BORE, '#9aa58a70', a.hair(1));
    a.wear(X(.17), Y(.58), X(.9) - X(.17), Y(-.86) - Y(.58), 2);
  },
  // FN MAG on a coaxial mount: the buffer at its back, the long riveted receiver with the bore high in it, the feed cover
  // on its front half with its latch, the cocking handle in its slot, the solenoid that fires it under the rear, the
  // barrel latch at the front.
  fnmag(a, R) {
    const { X, Y } = R;
    R.block(0, .08, -.5, .36, GUNMETAL, .02);
    R.block(.06, .94, -.96, .44, PARKER, .004);
    R.rivets(.1, .9, .3, .026); R.rivets(.1, .9, -.82, .026);
    for (const t of ([.2, .36, .52] as const)) R.rivets(t, t + .06, -.3, .02);
    R.block(.44, .94, .42, .96, STEEL, .004);
    for (const t of ([.56, .7, .84] as const)) a.rib(X(t), Y(.46), X(t), Y(.9), .002);
    R.block(.44, .49, .44, .99, shade(STEEL, .18), .003);
    a.path(X(.5), Y(.18), X(.86) - X(.5), Y(.04) - Y(.18), .002); a.fill(BORE);
    R.block(.8, .85, -.02, .24, STEEL, .003);
    R.block(.2, .42, -1, -.74, OLIVE, .006); a.tube([([X(.24), Y(-.87)] as const), ([X(.12), Y(-.87)] as const), ([X(.06), Y(-.9)] as const)], Math.min(.008, R.H * .05), '#1d231c');
    a.path(X(.58), Y(-.82), X(.72) - X(.58), Y(-.96) - Y(-.82), .002); a.fill(BORE);
    R.block(.93, 1, -.62, .5, GUNMETAL, .004);
    a.bolt(X(.965), Y(-.1), Math.min(.006, R.H * .05));
    a.wear(X(.06), Y(.44), X(.94) - X(.06), Y(-.96) - Y(.44), 4);
  },
  // FN Minimi, vehicle model: the backplate, the receiver with the magazine well under it, the feed cover with its rail,
  // the charging handle in its slot.
  minimi(a, R) {
    const { X, Y } = R;
    R.block(0, .07, -.62, .4, GUNMETAL, .012);
    R.block(.05, .95, -.84, .4, PARKER, .004);
    R.rivets(.1, .9, -.68, .022);
    R.block(.4, .6, -1, -.8, GUNMETAL, .004);
    R.block(.34, .95, .38, .82, STEEL, .004);
    R.block(.38, .9, .82, .98, GUNMETAL, .002);
    along(X(.4), X(.88) - X(.4), .008, x => a.line(x, Y(.84), x, Y(.96), '#0b100d90', a.hair(.8)));
    a.path(X(.62), Y(.14), X(.9) - X(.62), Y(.02) - Y(.14), .002); a.fill(BORE); R.block(.84, .89, -.02, .2, STEEL, .002);
    R.block(.95, 1, -.6, .44, GUNMETAL, .003);
    a.wear(X(.05), Y(.4), X(.95) - X(.05), Y(-.84) - Y(.4), 6);
  },
  // Mk 19 Mod 3: spade grips, the boxy receiver with the bore low in it, its top cover over the feed tray with the leaf
  // sight's bracket, the charging handle on the side, the feed throat with a 40 mm round in its link.
  mk19(a, R) {
    const { X, Y } = R;
    spadeGrips(a, R, .11, -.62, .62);
    R.block(.1, .16, -.82, .74, GUNMETAL, .01);
    R.block(.15, .95, -.8, .6, PARKER, .006);
    R.rivets(.18, .92, -.66, .03, .004);
    R.block(.38, .95, .58, .97, STEEL, .005); R.block(.38, .43, .6, 1, shade(STEEL, .18), .003);
    R.block(.62, .7, .9, 1, GUNMETAL, .002);
    a.path(X(.55), Y(.42), X(.8) - X(.55), Y(-.04) - Y(.42), .004); a.fill(BORE);
    const r = Math.min(.02, (Y(-.04) - Y(.42)) * .4); a.path(X(.57), Y(.19) - r, X(.74) - X(.57), 2 * r, r); a.fill(a.gradient(0, Y(.19) - r, 0, Y(.19) + r, [[0, '#d9c78a'], [1, '#7d6b3e']]));
    a.circle(X(.76), Y(.19), r * .8, '#5f6b57', OUTLINE, a.hair(.8));
    a.shape([([X(.28), Y(-.3)] as const), ([X(.34), Y(.3)] as const), ([X(.4), Y(.3)] as const), ([X(.36), Y(-.3)] as const)]); a.fill(STEEL); a.stroke(OUTLINE, a.hair(1));
    R.block(.95, 1, -.7, .7, GUNMETAL, .004);
    a.wear(X(.15), Y(.6), X(.95) - X(.15), Y(-.8) - Y(.6), 8);
  },
  m242(a, R, L) { chainGun(a, R, { feeder: ([.3, .97] as const), low: -.62, waist: .28, motor: .3, chutes: L.compartment ? 0 : 1 }); },
  mk44(a, R, L) { chainGun(a, R, { feeder: ([.34, .97] as const), low: -.6, waist: .3, motor: .26, chutes: L.compartment ? 0 : 2 }); },
  // M230LF: the compact receiver with the bore at its middle, the recoil adapter along its side, the feeder over its
  // rear with the chute into it from the hull, or the throat its belt goes into from the can beside it (`compartment`),
  // the drive motor under the rear.
  m230lf(a, R, L) {
    const { X, Y } = R, lath = lathe(a);
    R.block(.08, .96, -.62, .56, PARKER, .006);
    R.block(0, .2, -.92, -.2, GUNMETAL, .01); along(Y(-.88), Y(-.24) - Y(-.88), .008, y => a.line(X(.03), y, X(.17), y, '#0b100d80', a.hair(.8)));
    R.block(.06, .5, .54, .98, STEEL, .006);
    if (L.compartment) feedThroat(a, R, .2, .38, .7, .86);
    else chute(a, R, [([X(.28), Y(.8)] as const), ([X(.18), Y(.2)] as const), ([X(.12), Y(-1)] as const)], Math.min(.05, R.W * .1));
    for (const t of ([.12, .3, .46] as const)) a.bolt(X(t), Y(.9), Math.min(.005, R.H * .03));
    R.block(.3, .48, .62, .84, shade(STEEL, .12), .004);
    lath.turned(X(.52), X(.99), Y(.12), (Y(-.14) - Y(.38)) / 2, STEEL, { cap: .01 });
    for (const t of ([.6, .8] as const)) lath.ring(X(t), X(t + .04), Y(.12), (Y(-.18) - Y(.42)) / 2, GUNMETAL);
    a.rib(X(.12), Y(-.42), X(.94), Y(-.42), .002);
    for (const t of ([.6, .78, .92] as const)) a.bolt(X(t), Y(-.24), Math.min(.006, R.H * .04));
    R.block(.95, 1, -.6, .54, GUNMETAL, .003);
    a.wear(X(.08), Y(.56), X(.96) - X(.08), Y(-.62) - Y(.56), 10);
  },
  // Rheinmetall Rh202: the recoil buffer at its back, the slim receiver with the bore at its middle, the feed box on this
  // side with its belt down into the hull (the other side's behind it) — or, fed from its can, the mouth of the box open
  // on top for the belt — the charging cylinder on top.
  rh202(a, R, L) {
    const { X, Y } = R, lath = lathe(a);
    lath.turned(X(0), X(.16), R.cy, (Y(-.42) - Y(.42)) / 2, STEEL, { cap: .01 });
    R.block(.12, .96, -.72, .66, PARKER, .006);
    R.rivets(.16, .92, -.58, .03);
    lath.turned(X(.14), X(.62), Y(.82), (Y(.68) - Y(.96)) / 2, STEEL, { cap: .008 });
    R.block(.38, .74, -.32, .94, GUNMETAL, .006);
    if (!L.compartment) chute(a, R, [([X(.56), Y(-.3)] as const), ([X(.5), Y(-1)] as const)], Math.min(.05, R.W * .12));
    a.path(X(.42), Y(.8), X(.7) - X(.42), Y(.6) - Y(.8), .003); a.fill(BORE);
    R.block(.95, 1, -.6, .6, GUNMETAL, .003);
    a.wear(X(.12), Y(.66), X(.96) - X(.12), Y(-.72) - Y(.66), 12);
  },
  // Rheinmetall MK35-E: the electric drive at its back, finned, the long receiver under its ribbed cover, the feeder on
  // this side taking the linkless rounds up its chute from the hull, or through its throat from the can beside it.
  mk35(a, R, L) {
    const { X, Y } = R, lath = lathe(a);
    lath.turned(X(0), X(.17), Y(-.1), (Y(-.6) - Y(.4)) / 2, '#4b5650', { cap: .02 });
    along(X(.02), X(.15) - X(.02), .012, x => a.line(x, Y(.36), x, Y(-.56), '#0b100d70', a.hair(.9)));
    R.block(.14, .97, -.86, .7, PARKER, .008);
    R.block(.16, .95, .7, .96, STEEL, .006);
    along(X(.18), X(.93) - X(.18), .05, x => a.rib(x, Y(.74), x, Y(.92), .0025));
    lath.turned(X(.2), X(.48), Y(.52), (Y(.42) - Y(.62)) / 2, STEEL, { cap: .006 });
    for (const t of ([.24, .44] as const)) a.bolt(X(t), Y(.52), Math.min(.006, R.H * .02));
    R.block(.5, .82, -.3, .86, GUNMETAL, .008);
    R.block(.53, .79, .6, .8, shade(GUNMETAL, .1), .004);
    for (const t of ([.56, .76] as const)) a.stud(X(t), Y(.84), Math.min(.007, R.H * .025), 'y');
    if (L.compartment) feedThroat(a, R, .56, .76, .32, .52);
    else chute(a, R, [([X(.66), Y(-.28)] as const), ([X(.6), Y(-1)] as const)], Math.min(.07, R.W * .1));
    R.rivets(.18, .48, -.7, .04, .005);
    R.block(.96, 1, -.8, .8, GUNMETAL, .003);
    a.wear(X(.14), Y(.7), X(.97) - X(.14), Y(-.86) - Y(.7), 14);
  },
  // Rheinmetall 120 mm: the breech ring at the back, its vertical sliding wedge and the crank that works it; ahead of it
  // the cradle the gun recoils in, the recoil brakes above and below it, and at its front the trunnion, whose pin looks
  // at the eye.
  rh120(a, R) {
    const { X, Y } = R, lath = lathe(a), rc = (Y(-.6) - Y(.6)) / 2;
    lath.turned(X(.18), X(.98), R.cy, rc, '#4f5b52', { cap: .02 });
    cradleBands(a, lath, R, ([.4, .66] as const), rc);
    for (const v of ([.8, -.8] as const)) {
      lath.turned(X(.26), X(.92), Y(v), (Y(v - .13) - Y(v + .13)) / 2, STEEL, { cap: .02 });
      lath.turned(X(.22), X(.27), Y(v), (Y(v - .1) - Y(v + .1)) / 2, BRASS, { cap: .01 });
    }
    R.block(0, .22, -.98, .98, GUNMETAL, .02);
    R.block(.03, .19, -.82, .5, shade(GUNMETAL, .12), .008);
    a.rib(X(.03), Y(-.12), X(.19), Y(-.12), .003);
    a.line(X(.11), Y(.5), X(.17), Y(.86), OUTLINE, Math.min(.03, R.W * .025)); a.line(X(.11), Y(.5), X(.17), Y(.86), STEEL, Math.min(.016, R.W * .012));
    a.bolt(X(.17), Y(.86), Math.min(.012, R.H * .03));
    for (const v of ([.7, -.7] as const)) a.bolt(X(.11), Y(v), Math.min(.008, R.H * .02));
    trunnion(a, R);
    a.wear(X(0), Y(.98), X(.22) - X(0), R.H * .9, 16);
  },
  // M119A3: the breech ring and its vertical sliding block with the operating lever, the cradle with the buffer over the
  // tube and the recuperator under it, the trunnion.
  m119(a, R) { howitzer(a, R, { breech: .4, lever: true }); },
  // The 155 mm cannon: the breech ring with its screw block, the carrier's hinge and the operating handle, the firing
  // lock at its back; the cradle with the recoil cylinders over the tube and the recuperator under it, the trunnion.
  m777(a, R) { howitzer(a, R, { breech: .55, screw: true }); },
  // A mortar's base plate seen edge on, its axis along the tube: the plate with its spades behind it, the socket the ball
  // of the tube's cap turns in, its locking lever.
  m224(a, R) { mortarBase(a, R); },
  m252(a, R) { mortarBase(a, R); },
  // The rear half of a pod of rockets: its skin, the aft bulkhead band, the strongback along its top, the connector of
  // its igniters.
  hydra70(a, R) {
    const { X, Y } = R, lath = lathe(a);
    lath.turned(X(0), X(1), R.cy, (Y(-1) - Y(1)) / 2, OLIVE, { cap: .02 });
    lath.ring(X(.04), X(.1), R.cy, (Y(-1) - Y(1)) / 2, shade(OLIVE, -.2));
    along(Y(.9), Y(-.9) - Y(.9), .03, y => a.circle(X(.07), y, Math.min(.0035, R.W * .01), '#7f8a6b', '#1b2620', a.hair(.8)));
    for (const v of ([.55, -.55] as const)) a.rib(X(.12), Y(v), X(.99), Y(v), .0025);
    a.line(X(.62), Y(.8), X(.62), Y(-.96), '#141d18a0', a.hair(1.2));
    along(Y(.76), Y(-.92) - Y(.76), .04, y => a.circle(X(.62) + .006, y, Math.min(.003, R.W * .008), '#7f8a6b', '#1b2620', a.hair(.7)));
    R.block(.3, 1, .82, 1, '#56624a', .003);
    R.block(.66, .74, .86, 1, STEEL, .004); a.circle(X(.7), Y(.94), Math.min(.006, R.H * .02), BORE);
    R.block(.18, .3, .78, .98, GUNMETAL, .004); a.circle(X(.24), Y(.88), Math.min(.012, R.H * .04), '#9a9f8a', OUTLINE, a.hair(.8));
    a.path(X(.45), Y(.05), X(.75) - X(.45), Y(-.15) - Y(.05), .002); a.fill('#c9b561'); a.stroke('#3d3f33', a.hair(.8));
    for (const v of ([.0, -.05, -.1] as const)) a.line(X(.48), Y(v), X(v ? .66 : .72), Y(v), '#2f3328', a.hair(1));
    a.wear(X(0), Y(1), R.W, R.H, 18);
  },
  // The rear half of an AT4: the tube, the venturi cap at its end, the firing mechanism on top with its cocking lever,
  // the trigger under it.
  at4(a, R) {
    const { X, Y } = R, lath = lathe(a), rt = (Y(-.66) - Y(.66)) / 2;
    lath.turned(X(.06), X(1), R.cy, rt, OLIVE);
    for (const t of ([.6, .64] as const)) lath.ring(X(t), X(t + .016), R.cy, rt * 1.01, '#c9b561');
    lath.ring(X(.36), X(.4), R.cy, rt * 1.05, shade(OLIVE, -.3));
    lath.turned(X(0), X(.1), R.cy, (Y(-.8) - Y(.8)) / 2, RUBBER, { cap: .01 });
    a.rib(X(.06), Y(.74), X(.06), Y(-.74), .002);
    a.path(X(.16), Y(.24), X(.32) - X(.16), Y(-.24) - Y(.24), .002); a.fill('#c9b561'); a.stroke('#3d3f33', a.hair(.8));
    for (const v of ([.12, -.04] as const)) a.line(X(.18), Y(v), X(.3), Y(v), '#2f3328', a.hair(1));
    R.block(.18, .3, .62, .84, GUNMETAL, .004);
    R.block(.48, .84, .6, .92, GUNMETAL, .004); R.block(.5, .7, .86, 1, shade(GUNMETAL, .14), .003);
    a.line(X(.52), Y(.78), X(.7), Y(.97), OUTLINE, Math.min(.014, R.W * .02)); a.line(X(.52), Y(.78), X(.7), Y(.97), STEEL, Math.min(.008, R.W * .012));
    R.block(.76, .8, .9, 1, '#9b2f22', .002); R.block(.82, .86, .9, .98, '#8a2a1e', .002);
    R.block(.62, .88, -1, -.62, RUBBER, .008);
    along(X(.64), X(.86) - X(.64), .012, x => a.line(x, Y(-.66), x, Y(-.96), '#0b100d90', a.hair(.8)));
    a.circle(X(.2), Y(-.72), Math.min(.008, R.H * .05), null, STEEL, a.hair(1.6));
    a.wear(X(.1), Y(.66), X(.9), rt * 2, 30);
  },
  // The rear half of a Carl Gustaf M4: the venturi flaring at its back, the lock that hinges it, the shoulder piece and the
  // trigger grip under the tube, the sight mount on top.
  carlgustaf(a, R) {
    const { X, Y } = R, lath = lathe(a), rt = (Y(-.6) - Y(.6)) / 2, flare = (Y(-.86) - Y(.86)) / 2;
    lath.cone(X(0), X(.26), R.cy, flare, rt * 1.05, '#3a4440');
    for (const t of ([.05, .14] as const)) { const r = flare + (rt * 1.05 - flare) * t / .26; a.line(X(t), R.cy - r * .94, X(t), R.cy + r * .94, '#0f1a15a0', a.hair(1)); }
    lath.ring(X(.25), X(.33), R.cy, rt * 1.14, GUNMETAL);
    a.line(X(.29), Y(.7), X(.44), Y(.66), OUTLINE, Math.min(.012, R.W * .02)); a.line(X(.29), Y(.7), X(.44), Y(.66), STEEL, Math.min(.007, R.W * .012));
    a.bolt(X(.29), Y(.7), Math.min(.006, R.H * .04));
    lath.turned(X(.32), X(1), R.cy, rt, '#2e3633');
    along(X(.36), X(.98) - X(.36), .02, x => a.line(x, R.cy - rt * .8, x + .01, R.cy + rt * .8, '#0b100d26', a.hair(.8)));
    R.block(.38, .58, -1, -.62, RUBBER, .008);
    along(X(.4), X(.56) - X(.4), .01, x => a.line(x, Y(-.68), x, Y(-.94), '#0b100d90', a.hair(.8)));
    a.shape([([X(.66), Y(-.6)] as const), ([X(.76), Y(-.6)] as const), ([X(.8), Y(-1)] as const), ([X(.7), Y(-1)] as const)]);
    a.fill(a.gradient(X(.66), 0, X(.8), 0, [[0, '#2c3430'], [.4, '#3d4641'], [1, '#1c2320']])); a.stroke(OUTLINE, a.hair(1));
    a.line(X(.62), Y(-.62), X(.62), Y(-.78), STEEL, a.hair(1.5));
    R.block(.44, .96, .6, .72, GUNMETAL, .002);
    along(X(.46), X(.94) - X(.46), .014, x => a.line(x, Y(.62), x, Y(.7), '#0b100d90', a.hair(.8)));
    R.block(.58, .84, .72, 1, '#2c3430', .006);
    a.path(X(.8), Y(.94), X(.84) - X(.8), Y(.78) - Y(.94), .002); a.fill('#1a2330'); a.stroke(OUTLINE, a.hair(.8));
    a.wear(X(.32), Y(.6), X(1) - X(.32), rt * 2, 20);
  },
};

// The bands that close a cradle round the gun's barrel, each with the bolts that clamp it and a rib along the cradle
// between them, where its two halves are joined.
function cradleBands(a: WeaponKit, lath: Lathe, R: ReceiverFrame, at: readonly number[], r: number) {
  const { X } = R, w = Math.min(.04, R.W * .03);
  a.rib(X(at[0]!), R.cy + r * .55, X(at.at(-1)!) + w, R.cy + r * .55, .0025);
  for (const t of at) {
    lath.ring(X(t), X(t) + w, R.cy, r * 1.04, shade('#4f5b52', -.12));
    for (const v of ([-.6, .6] as const)) a.stud(X(t) + w / 2, R.cy + r * v, Math.min(.007, w * .3), 'y');
  }
}

// The trunnion at the front of a gun's mechanism: its pin, whose axis looks at the eye, and the boss round it.
function trunnion(a: WeaponKit, R: ReceiverFrame) {
  const r = Math.min(R.H * .2, R.W * .08), x = R.X(1) - r * 1.3;
  a.circle(x, R.cy, r * 1.25, '#24302ab0');
  a.circle(x, R.cy, r, a.radial(x, R.cy, r, [[0, '#7a8673'], [.6, '#5b6858'], [1, '#353f37']], x - r * .3, R.cy - r * .35), OUTLINE, a.edge);
  finishMetal(a, x - r, R.cy - r, 2 * r, 2 * r);
  const ring = r * .72, n = 6;
  for (let i = 0; i < n; i++) a.bolt(x + Math.cos(i * Math.PI / 3) * ring, R.cy + Math.sin(i * Math.PI / 3) * ring, Math.min(.006, r * .12));
  a.circle(x, R.cy, r * .32, '#2a332e', OUTLINE, a.hair(1));
}

// A chain gun (M242, Mk44): the bore low in its box, the receiver over it, the feeder standing on its front with the
// chute of each feed coming up into it from the hull, the drive motor under its rear, the cover of the chain drive.
function chainGun(a: WeaponKit, R: ReceiverFrame, { feeder, low, waist, motor, chutes }: { feeder: XY; low: number; waist: number; motor: number; chutes: number }) {
  const { X, Y } = R, lath = lathe(a);
  R.block(0, .97, low, waist, PARKER, .008);
  R.block(.04, .6, low + .1, waist - .14, shade(PARKER, .08), .006);
  along(X(.06), X(.58) - X(.06), .05, x => a.bolt(x, Y(low + .16), Math.min(.005, R.H * .02)));
  lath.turned(X(0), X(motor), Y(-.8), (Y(-.98) - Y(-.62)) / 2, '#4b5650', { cap: .015 });
  along(X(.02), X(motor) - X(.04), .01, x => a.line(x, Y(-.66), x, Y(-.94), '#0b100d70', a.hair(.8)));
  for (let i = 0; i < chutes; i++) {
    const t = feeder[0]! + (feeder[1]! - feeder[0]!) * (chutes > 1 ? .2 + .55 * i : .45);
    chute(a, R, [([X(t), Y(waist + .3)] as const), ([X(t - .04), Y(low)] as const), ([X(t - .1), Y(-1)] as const)], Math.min(.07, R.W * .11), i ? '#3a4538' : '#434e40');
  }
  R.block(feeder[0]!, feeder[1]!, waist - .02, .98, GUNMETAL, .01);
  R.block(feeder[0]! + .03, feeder[1]! - .03, .62, .9, shade(GUNMETAL, .1), .006);
  for (const t of ([.1, .5, .9] as const)) a.bolt(X(feeder[0]! + (feeder[1]! - feeder[0]!) * t), Y(.94 - .08), Math.min(.006, R.H * .02));
  a.path(X(feeder[0]! + .06), Y(.5), X(feeder[1]! - .1) - X(feeder[0]! + .06), Y(.36) - Y(.5), .003); a.fill(BORE);
  R.block(.92, 1, low - .04, waist + .06, GUNMETAL, .004);
  a.wear(X(0), Y(waist), X(.97) - X(0), Y(low) - Y(waist), 22);
}

// A howitzer's mechanism: the breech ring at the back, worked by a lever (a sliding block) or its screw block on the
// carrier; the cradle the tube recoils in, the recoil cylinders over it and the recuperator under it; the trunnion.
function howitzer(a: WeaponKit, R: ReceiverFrame, { breech, lever, screw }: { breech: number; lever?: boolean; screw?: boolean }) {
  const { X, Y } = R, lath = lathe(a), rc = (Y(-.5) - Y(.5)) / 2;
  lath.turned(X(breech - .04), X(.98), R.cy, rc, '#4f5b52', { cap: .02 });
  cradleBands(a, lath, R, ([breech + .12, (breech + .98) / 2 + .06] as const), rc);
  lath.turned(X(breech + .04), X(.95), Y(.76), (Y(.58) - Y(.94)) / 2, STEEL, { cap: .02 });
  lath.turned(X(breech + .1), X(.95), Y(-.76), (Y(-.94) - Y(-.58)) / 2, STEEL, { cap: .02 });
  lath.turned(X(breech), X(breech + .06), Y(.76), (Y(.62) - Y(.9)) / 2, BRASS, { cap: .01 });
  R.block(0, breech, -.92, .92, GUNMETAL, .02);
  if (screw) {
    R.block(.08, breech - .06, -.6, .6, shade(GUNMETAL, .12), .01);
    lath.turned(X(0), X(.1), R.cy, (Y(-.22) - Y(.22)) / 2, STEEL, { cap: .008 });
    a.line(X(breech * .3), Y(-.6), X(breech * .55), Y(-.95), OUTLINE, Math.min(.03, R.W * .03));
    a.line(X(breech * .3), Y(-.6), X(breech * .55), Y(-.95), STEEL, Math.min(.016, R.W * .015));
    a.circle(X(breech * .3), Y(-.6), Math.min(.018, R.H * .05), STEEL, OUTLINE, a.hair(1));
  }
  if (lever) {
    R.block(.05, breech - .05, -.8, .55, shade(GUNMETAL, .12), .008);
    a.line(X(breech * .7), Y(.55), X(breech * .25), Y(.88), OUTLINE, Math.min(.03, R.W * .03));
    a.line(X(breech * .7), Y(.55), X(breech * .25), Y(.88), STEEL, Math.min(.016, R.W * .015));
    a.bolt(X(breech * .7), Y(.55), Math.min(.012, R.H * .04));
  }
  for (const v of ([.78, -.78] as const)) a.bolt(X(breech * .5), Y(v), Math.min(.008, R.H * .025));
  trunnion(a, R);
  a.wear(X(0), Y(.92), X(breech), R.H * .9, 24);
}

function mortarBase(a: WeaponKit, R: ReceiverFrame) {
  const { X, Y } = R;
  R.block(0, .34, -1, 1, '#4d5a48', .01);
  along(Y(.94), Y(-.94) - Y(.94), .05, y => a.rib(X(.02), y, X(.32), y, .003));
  along(Y(.86), Y(-.86) - Y(.86), .1, y => a.bolt(X(.26), y, Math.min(.005, R.W * .02)));
  for (const v of ([.9, -.9] as const)) R.block(.34, .44, v > 0 ? .8 : -.96, v > 0 ? .96 : -.8, STEEL, .004);
  a.shape([([X(.34), Y(.6)] as const), ([X(.7), Y(.36)] as const), ([X(.7), Y(-.36)] as const), ([X(.34), Y(-.6)] as const)]);
  a.fill(a.gradient(0, Y(.6), 0, Y(-.6), [[0, '#6b7864'], [.4, '#56634f'], [1, '#2f3a2e']]));
  finishMetal(a, X(.34), Y(.6), X(.7) - X(.34), Y(-.6) - Y(.6)); a.stroke(OUTLINE, a.edge);
  R.block(.66, 1, -.3, .3, GUNMETAL, .01);
  a.circle(X(.84), R.cy, Math.min(R.H * .12, R.W * .1), a.radial(X(.84), R.cy, R.H * .12, [[0, '#7d8977'], [1, '#353f37']]), OUTLINE, a.hair(1));
  R.block(.4, .56, .4, .62, STEEL, .003);
  a.line(X(.5), Y(.5), X(.62), Y(.74), OUTLINE, Math.min(.012, R.W * .03)); a.line(X(.5), Y(.5), X(.62), Y(.74), STEEL, Math.min(.007, R.W * .018));
  a.bolt(X(.62), Y(.74), Math.min(.006, R.W * .02));
  for (const v of ([.2, -.2] as const)) a.bolt(X(.74), Y(v), Math.min(.005, R.W * .02));
  a.wear(X(0), Y(1), X(.34) - X(0), R.H, 26);
}

// The gun's own receiver in its box; an enclosed mount's room holds it, and only what it shows of it is drawn. The box the
// core gives it holds the compartment of its ready rounds too (`compartmentBoxes`): the can beside it on its far side, the
// receiver over that, and the belt from the can into its feed over both.
function paintReceiver(a: WeaponKit, L: WeaponLayout, box: WeaponBox, look: WeaponLook = {}) {
  const boxes = compartmentBoxes(L);
  if (boxes) paintCompartment(a, L, look, 'back');
  RECEIVERS[L.preset]!(a, receiverFrame(a, boxes?.own ?? box), L);
  if (boxes) paintCompartment(a, L, look, 'front');
}

// ---- The compartment of the ready rounds (game_variant.rs `compartment`) ----
// Turning and running back with the gun, as high as its receiver. The box the core gives the receiver holds it
// (weapons.ts `weaponMountSize`): the gun's own receiver at its front (`own`) and behind it what of the compartment does not
// stand beside it (`behind`); a belt's can (`can`) stands beside the back of the receiver, on its far side, as the M2A1
// can hangs on the M2, and reaches behind it with what the receiver had no length for.
const receiverBox = (L: WeaponLayout) => L.exposed ? L.body : L.receiver;
export function compartmentBoxes(L: WeaponLayout) {
  const c = L.compartment, box = receiverBox(L);
  if (!c) return null;
  // Only what the box holds behind the gun's own receiver: a box laid out before its compartment was told holds none.
  const behind = Math.max(0, Math.min(c.behind, box.x1 - box.x0 - c.receiver)), x = box.x0 + behind, beside = c.kind === 'belt' ? Math.min(c.beside, box.x1 - x) : 0;
  return { box, own: { ...box, x0: x }, behind: behind > 1e-4 ? { ...box, x1: x } : null,
    can: c.kind === 'belt' && behind + beside > 1e-4 ? { ...box, x1: x + beside } : null };
}
// A revolving magazine in a box `height` high, as a turret's bustle holds an autoloader's: its walls, the drum within them,
// and round its axis the rounds of `calibre`, their axes along the bore as a revolver's cylinder holds its cartridges, as
// many as go round it (`rounds` at most); a magazine of more holds them in rings within, hidden by these.
export function drumFit(height: number, calibre: number, rounds: number) {
  const wall = Math.min(.03, Math.max(.008, height * .07)), drum = height / 2 - wall, d = Math.min(calibre * 1.35, drum * .62),
    ring = drum - d * .57, fit = Math.floor(2 * Math.PI * ring / (d * 1.1) + 1e-9);
  return { wall, drum, d, ring, chambers: Math.max(1, Math.min(rounds, Math.max(3, fit))) };
}
// Whether anything moves on a gun besides its recoil: its ready rounds in their compartment, its barrels about their axis.
export function weaponMoves(id: WeaponId | null | undefined) {
  try { return Boolean(id && (laidCompartment(id) || (weaponOf(id)?.steel?.barrels ?? 1) > 1)); } catch { return false; }
}
// How many rounds go round the drum of a gun's magazine, the places it turns through; none for a gun fed otherwise.
export function feedChambers(id: WeaponId) {
  const c = laidCompartment(id);
  return c?.kind === 'magazine' ? drumFit(c.height, c.calibre, c.rounds).chambers : 0;
}
// Where the belt goes into each gun, in shares of its own receiver's box (`receiverFrame`): its feed tray or feeder.
const FEED_POINTS: Partial<Record<WeaponPresetId, XY>> = { m2hb: [.7, .3], fnmag: [.62, .5], minimi: [.5, .44], mk19: [.64, .2],
  m242: [.48, .43], mk44: [.52, .43], m230lf: [.29, .78], rh202: [.56, .7], mk35: [.66, .42] };
export interface BeltLook { kind: 'belt'; route: XY[]; at: number[]; length: number; width: number; pitch: number; family: WeaponFamilyId }
export interface DrumLook { kind: 'magazine'; x0: number; x1: number; length: number; round: number; cy: number; ring: number; d: number;
  chambers: number; axle: number; drum: number; wall: number; plate: number; box: { x0: number; x1: number; top: number; bottom: number }; family: WeaponFamilyId }
export type FeedLook = BeltLook | DrumLook;
// What the compartment shows moving, in the canvas frame of the gun (y down): of a magazine, its drum seen from the side
// through the cut in its box, the rounds round its axis between its end plates; of a belt, its course from where it comes
// over the top of the can, or up out of the can behind the receiver, into the gun's feed, crossing the receiver's side.
export function feedLook(L: WeaponLayout): FeedLook | null {
  const boxes = compartmentBoxes(L), c = L.compartment;
  if (!boxes || !c) return null;
  const top = -boxes.box.y1, bottom = -boxes.box.y0, H = bottom - top, cy = (top + bottom) / 2;
  if (c.kind === 'magazine') {
    const b = boxes.behind;
    if (!b) return null;
    const fit = drumFit(H, c.calibre, c.rounds), plate = Math.min(.02, Math.max(.005, (b.x1 - b.x0) * .035)),
      x0 = b.x0 + fit.wall + plate, x1 = b.x1 - fit.wall - plate;
    if (!(x1 - x0 > fit.d && fit.ring > 0)) return null;
    return { kind: 'magazine', x0, x1, length: x1 - x0, round: Math.min((x1 - x0) * .94, c.calibre * 8.5), cy, ring: fit.ring, d: fit.d,
      chambers: drumFit(c.height || H, c.calibre, c.rounds).chambers, axle: Math.min(fit.d * .28, fit.ring * .3), drum: fit.drum,
      wall: fit.wall, plate, box: { x0: b.x0, x1: b.x1, top, bottom }, family: L.family };
  }
  const own = boxes.own, [ft, fv] = FEED_POINTS[L.preset] ?? ([.55, .5] as const), width = Math.min(c.calibre * 1.65, H * .16),
    keep = width * .62, fx = own.x0 + (own.x1 - own.x0) * ft, fy = Math.min(bottom - keep, cy - H / 2 * fv),
    rear = boxes.can?.x0 ?? own.x0, from = boxes.behind ? boxes.behind.x0 + (boxes.behind.x1 - boxes.behind.x0) * .6 : rear + (fx - rear) * .3,
    sx = Math.max(boxes.box.x0 + keep, Math.min(from, fx - 2 * width)), sy = top + keep, cx = sx + (fx - sx) * .72;
  if (!(fx - sx > width)) return null;
  const route: XY[] = [], at: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, x = (1 - t) ** 2 * sx + 2 * t * (1 - t) * cx + t * t * fx, y = (1 - t) ** 2 * sy + 2 * t * (1 - t) * sy + t * t * fy;
    at.push(i ? at[i - 1]! + Math.hypot(x - route[i - 1]![0], y - route[i - 1]![1]) : 0);
    route.push([x, y]);
  }
  return { kind: 'belt', route, at, length: at.at(-1)!, width, pitch: width * 1.14, family: L.family };
}
// The place and the heading along a belt's course `s` metres from where it shows, written into `out`.
export function routeAt(look: BeltLook, s: number, out: { x: number; y: number; angle: number }) {
  const { route, at } = look;
  let i = 1;
  while (i < at.length - 1 && at[i]! < s) i++;
  const [x0, y0] = route[i - 1]!, [x1, y1] = route[i]!, t = Math.min(1, Math.max(0, (s - at[i - 1]!) / Math.max(1e-9, at[i]! - at[i - 1]!)));
  out.x = x0 + (x1 - x0) * t; out.y = y0 + (y1 - y0) * t; out.angle = Math.atan2(y1 - y0, x1 - x0);
  return out;
}
// A link comes into sight over the can and goes out of it into the feed over a share of its pitch.
export const beltFade = (look: BeltLook, s: number) => Math.max(0, Math.min(1, s / (look.pitch * .7), (look.length - s) / (look.pitch * .7)));
// The height of a chamber of the drum at `turn` about its axis (up is less, the canvas's y running down), and how near it is.
export const drumChamber = (look: DrumLook, turn: number) => ({ y: look.cy - look.ring * Math.sin(turn), depth: Math.cos(turn) });

// The look of a round by the family of its gun: its projectile, the tip or fuze of it, the band painted round it.
const ROUND_LOOKS: Record<WeaponFamilyId, { body: string; tip: string; band?: string }> = {
  machinegun: { body: '#9a5b36', tip: '#1d211d' }, autocannon: { body: '#2a302b', tip: '#a8402c', band: '#c9ad44' },
  grenade: { body: '#5d6640', tip: '#c9b561', band: '#c9ad44' }, cannon: { body: '#3e4636', tip: '#1f2420', band: '#c9ad44' },
  howitzer: { body: '#59633f', tip: '#9a9f88', band: '#c9ad44' }, mortar: { body: '#59633f', tip: '#c9b561', band: '#c9ad44' },
  rocket: { body: '#5f6c46', tip: '#2f3328' } };
const CASE_STOPS = [[0, '#4f401c'], [.28, '#d8c07a'], [.48, '#f0dc98'], [.74, '#b29a5a'], [1, '#4a3c1a']] as const;
// A turned part of a round lying along x, rounded by the light from above; rounds take no weathering.
function rod(a: WeaponKit, x0: number, x1: number, cy: number, r: number, base: string) {
  if (!(x1 > x0) || !(r > 0)) return;
  a.path(x0, cy - r, x1 - x0, 2 * r, Math.min(r * .2, (x1 - x0) / 2));
  a.fill(a.gradient(0, cy - r, 0, cy + r, [[0, shade(base, -.35)], [.22, shade(base, .42)], [.4, shade(base, .1)], [.7, base], [1, shade(base, -.55)]]));
  a.stroke(OUTLINE, Math.min(a.edge * .7, r * .2));
}
// A chamber of the drum, from its rear end plate (x = 0) to its front one, on its axis (y = 0): the tray it holds its round
// in and the clips at its ends, and the round, its tip forward against the breech. `dim` darkens what is beyond the axis.
function paintChamber(a: WeaponKit, m: DrumLook, full: boolean, dim = 0) {
  const r = m.d / 2, tone = (c: string) => dim > 0 ? shade(c, -dim) : c, look = ROUND_LOOKS[m.family];
  a.path(0, r * .5, m.length, r * .52, r * .2); a.fill(tone('#2f3832')); a.stroke(OUTLINE, a.hair(.8));
  for (const x of [m.length * .05, m.length * .95]) { a.path(x - r * .22, r * .12, r * .44, r * .96, r * .1); a.fill(tone('#4a554d')); a.stroke(OUTLINE, a.hair(.8)); }
  if (!full) return;
  const x0 = m.length - m.round, neck = x0 + m.round * .58, ogive = x0 + m.round * .84, end = m.length, rb = r * .74;
  rod(a, x0, neck, 0, r, tone(BRASS));
  rod(a, x0, x0 + Math.max(a.hair(1.5), m.round * .02), 0, r * 1.04, tone('#8a7240'));
  rod(a, neck - a.hair(.5), ogive, 0, rb, tone(look.body));
  if (look.band) { a.path(neck + (ogive - neck) * .25, -rb, (ogive - neck) * .12, 2 * rb); a.fill(tone(look.band)); }
  const nose = (from: number, half: number, color: string) => {
    const bend = from + (end - from) * .7;
    a.ctx.beginPath(); a.ctx.moveTo(from, -half); a.ctx.quadraticCurveTo(bend, -half, end, -r * .08); a.ctx.lineTo(end, r * .08);
    a.ctx.quadraticCurveTo(bend, half, from, half); a.ctx.closePath();
    a.fill(a.gradient(0, -half, 0, half, [[0, shade(color, -.3)], [.25, shade(color, .38)], [.7, color], [1, shade(color, -.55)]]));
    a.stroke(OUTLINE, Math.min(a.edge * .7, half * .2));
  };
  nose(ogive, rb, tone(look.body));
  nose(ogive + (end - ogive) * .62, rb * .5, tone(look.tip));
}
// A round of a belt and its links, across the belt, the belt running along x through it: the case lit across, the bullet
// at the belt's outer edge, and the two loops of the link that holds it to the next.
function paintLink(a: WeaponKit, b: BeltLook, burnt = false) {
  const p = b.pitch, w = b.width, half = p * .44, step = w * .2, look = ROUND_LOOKS[b.family], tone = (c: string) => burnt ? shade(c, -.72) : c;
  a.path(-half, -w / 2, 2 * half, w / 2 + step, half * .35);
  a.fill(burnt ? '#2a2620' : a.gradient(-half, 0, half, 0, CASE_STOPS)); a.stroke(OUTLINE, a.hair(.8));
  a.path(-half * .74, step, half * 1.48, w / 2 - step, half * .6);
  a.fill(a.gradient(-half, 0, half, 0, [[0, tone(shade(look.body, -.45))], [.42, tone(shade(look.body, .3))], [1, tone(shade(look.body, -.55))]])); a.stroke(OUTLINE, a.hair(.8));
  a.path(-half * .42, w / 2 - w * .1, half * .84, w * .1, w * .04); a.fill(tone(look.tip));
  for (const v of [-.34, -.06] as const) { a.path(-p / 2, w * v, p, w * .1, w * .03); a.fill(burnt ? '#141310' : '#3b433ddd'); }
}
// A belt's can, as the M2A1's is: its long side, the lid a little proud of the body with the handle folded flat on it
// and seen edge on, the knuckle of the hinge at its back (its pin across the can, the one round thing on it), the lever
// of the latch down its front, the band that marks its rounds, its stiffening ribs; wrecked, burnt and torn open.
function paintCan(a: WeaponKit, can: WeaponBox, cut: boolean, vented = false) {
  const e = a.edge / 2, x0 = can.x0 + e, x1 = can.x1 - e, top = -can.y1 + e, bottom = -can.y0 - e, w = x1 - x0, H = bottom - top;
  if (!(w > .012 && H > .02)) return;
  const grip = Math.min(.006, H * .035), lid = Math.min(H * .14, .03), body = top + grip + lid, olive = cut ? '#2f2d26' : '#575d33',
    lidTone = cut ? '#38332a' : '#5f6538', knuckle = Math.min(.005, lid * .3), latch = Math.min(.008, w * .05), band = Math.min(.03, w * .08);
  a.housing(x0, body, w, bottom - body, olive, .004);
  along(x0, w, .24, x => { if (x > x0 + .02 && x < x1 - .02) a.rib(x, body + .008, x, bottom - .008, .003); });
  a.housing(x0, top + grip, w, lid, lidTone, .003);
  const handle = Math.min(w * .42, .12), hx = x0 + (w - handle) / 2;
  for (const ex of [hx, hx + handle - grip]) { a.path(ex, top + grip * .3, grip, grip * .8, .001); a.fill(cut ? '#1d1b16' : '#3a4427'); }
  a.path(hx - grip, top, handle + 2 * grip, Math.max(.0025, grip * .45), .002); a.fill(cut ? '#24211b' : '#4a5532'); a.stroke(OUTLINE, a.hair(1));
  a.circle(x0 + knuckle * 1.3, top + grip + lid * .55, knuckle, lidTone, OUTLINE, a.hair(1));
  a.housing(x1 - latch * 1.4, top + grip + lid * .25, latch, (bottom - body) * .5 + lid * .75, cut ? '#25221c' : '#474c2a', .002);
  const bandX = x1 - latch * 1.6 - .006 - band;
  if (!cut && bandX > x0 + .02) { a.path(bandX, body + .004, band, bottom - body - .008); a.fill('#c9ad3ccc'); }
  if (bandX - x0 > .04) {
    a.path(x0 + .01, body + .008, bandX - x0 - .02, bottom - body - .016, .006); a.stroke(cut ? '#0d0c0aa0' : '#2a331bb0', Math.max(a.hair(1), .002));
    if (!cut) for (const [v, share] of [[.38, .7], [.6, .45]] as const)
      a.line(x0 + (bandX - x0) * (1 - share) / 2, body + (bottom - body) * v, bandX - (bandX - x0) * (1 - share) / 2, body + (bottom - body) * v, '#d2cfa8a0', a.hair(1.4));
  }
  a.wear(x0, body, w, bottom - body, 32);
  // Its lid made blow-out panels: they, not its walls, give way to what goes off in it.
  if (vented) paintPanels(a, x0, x1, top + grip, lid, cut);
  if (!cut) return;
  // Burnt from within: soot over it, darkest at the top, and its lid torn open over the belt that went off in it, or, of
  // panels, its walls whole under the roof they left open.
  a.path(x0, top + grip + (vented ? lid : 0), w, H - grip - (vented ? lid : 0), .004);
  a.fill(a.gradient(0, top, 0, bottom, [[0, '#060705e0'], [.45, '#15130ea8'], [1, '#2a241850']]));
  if (!vented) torn(a, x0 + w * .08, x1 - w * .08, top + grip + lid * .3, H * .34, 41);
}
// Blow-out panels along the roof of a compartment, `thick` deep from `top` (weapons.ts `WeaponCompartment.vented`): plates
// of steel a little paler than the box, a seam between each and the next, each held down by a shear bolt at either end, so
// that they give way before its walls and its blast door. Blown (`cut`), the roof is open where they were, dark within,
// the stubs of their bolts left along it and its edges scorched.
function paintPanels(a: WeaponKit, x0: number, x1: number, top: number, thick: number, cut: boolean) {
  const w = x1 - x0;
  if (!(w > .012 && thick > .002)) return;
  const count = Math.max(1, Math.min(4, Math.round(w / .4))), pitch = w / count, seam = Math.max(a.hair(1.5), .0015),
    bolt = Math.max(Math.min(.006, thick * .28, pitch * .08), .0012);
  if (cut) {
    a.path(x0, top, w, thick); a.fill(a.gradient(0, top, 0, top + thick, [[0, '#020202'], [1, '#1a140c']]));
    const stub = Math.min(pitch * .18, thick * 1.6);
    for (const [from, dir] of [[x0, 1], [x1, -1]] as const) {
      a.shape([[from, top + thick], [from, top + thick * .35], [from + dir * stub, top], [from + dir * stub * 1.15, top + thick * .3], [from + dir * stub * .4, top + thick]]);
      a.fill(shade(PANEL_TONE, -.45)); a.stroke('#8a6a3c90', a.hair(1));
    }
    a.line(x0 + stub, top + thick, x1 - stub, top + thick, '#8a6a3cb0', a.hair(1.4));
    for (let i = 1; i < count; i++) a.bolt(x0 + pitch * i, top + thick * .75, bolt * .7);
    return;
  }
  for (let i = 0; i < count; i++) {
    const px = x0 + pitch * i + seam / 2, pw = pitch - seam;
    a.housing(px, top, pw, thick, PANEL_TONE, .0015);
    a.line(px + seam, top + Math.max(a.hair(1), thick * .12), px + pw - seam, top + Math.max(a.hair(1), thick * .12), '#c3cbbf90', a.hair(1.2));
    for (const bx of [px + bolt * 1.8, px + pw - bolt * 1.8]) a.bolt(bx, top + thick * .55, bolt);
  }
  a.line(x0, top + thick, x1, top + thick, '#1a1d18c0', a.hair(1.2));
}
// A tear in a plate, from `y` down as far as `depth`, ragged and dark within, its edges blued and rusted by the fire.
function torn(a: WeaponKit, x0: number, x1: number, y: number, depth: number, seed: number) {
  const teeth = Math.max(4, Math.round((x1 - x0) / .02)), points: XY[] = [[x0, y]];
  for (let i = 1; i < teeth; i++) {
    const t = i / teeth, u = (Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) % 1, deep = Math.abs(u);
    points.push([x0 + (x1 - x0) * t, y + depth * (i % 2 ? .45 + .55 * deep : .15 + .3 * deep) * Math.sin(Math.PI * t) ** .5]);
  }
  points.push([x1, y]);
  a.shape(points); a.fill('#060705'); a.stroke('#8a6a3c80', a.hair(1.2));
}
// What a gun's compartment shows, behind its own receiver (`back`) or over it (`front`). In the field (`look.animated`)
// its drum's rounds and its belt are pictures of their own (`feedPiece`), drawn over the box where they are.
function paintCompartment(a: WeaponKit, L: WeaponLayout, look: WeaponLook, stage: 'back' | 'front') {
  const boxes = compartmentBoxes(L), feed = feedLook(L);
  if (!boxes) return;
  if (stage === 'back') {
    const vented = Boolean(L.compartment?.vented);
    if (boxes.can) paintCan(a, boxes.can, Boolean(look.cut), vented);
    if (feed?.kind === 'magazine') paintMagazine(a, feed, look, vented);
    return;
  }
  if (feed?.kind !== 'belt') return;
  const at = { x: 0, y: 0, angle: 0 };
  if (look.cut) {
    // Of a belt that went off in its can, a burnt end hangs from the feed.
    for (const k of [.5, 1.5] as const) {
      routeAt(feed, Math.max(0, feed.length - k * feed.pitch), at);
      a.ctx.save(); a.ctx.translate(at.x, at.y + (k - .5) * feed.pitch * .4); a.ctx.rotate(Math.PI / 2 - .35 * k); paintLink(a, feed, true); a.ctx.restore();
    }
    return;
  }
  if (look.animated) return;
  for (let s = feed.length - feed.pitch * .5; s >= 0; s -= feed.pitch) {
    const alpha = beltFade(feed, s);
    if (alpha <= 0) continue;
    routeAt(feed, s, at);
    a.ctx.save(); a.ctx.translate(at.x, at.y); a.ctx.rotate(at.angle);
    if (alpha < 1) a.ctx.globalAlpha = alpha;
    paintLink(a, feed); a.ctx.restore();
  }
}
// An autoloader's magazine behind the gun, as a turret's bustle holds it: an armoured box bolted along its walls, a lug to
// lift it by on its top, the port the rammer drives the round through into the breech; cut away over its drum, after the
// cut convention (cargo-art.ts): behind the cut the far wall in shade, the end plates of the drum seen edge on, and between
// them the rounds round its axis. Wrecked, its rounds went off in it: burnt, its cut torn wider and empty. With blow-out
// panels its roof is they (`paintPanels`), and its rounds went off through them, its walls left whole.
function paintMagazine(a: WeaponKit, m: DrumLook, look: WeaponLook, vented = false) {
  const { box: { x0, x1, top, bottom }, wall, plate, cy, drum } = m, e = a.edge / 2, W = x1 - x0, cut = Boolean(look.cut),
    armour = cut ? '#33322b' : '#5e6b60', plateTone = cut ? '#2a2a24' : STEEL, roof = vented ? Math.max(wall * .9, (bottom - top) * .09) : 0;
  a.housing(x0 + e, top + e, W - 2 * e, bottom - top - 2 * e, armour, .008);
  const bolt = Math.min(.006, wall * .3);
  along(x0 + wall, W - 2 * wall, .07, x => { a.bolt(x, top + wall * .5, bolt); a.bolt(x, bottom - wall * .5, bolt); });
  if (!vented) {
    const lug = Math.min(.04, W * .12), lx = x0 + W * .5 - lug / 2;
    a.housing(lx, top + e, lug, wall * .9, shade(armour, .1), .002); a.circle(lx + lug / 2, top + e + wall * .45, Math.min(lug * .18, wall * .25), BORE);
  }
  const wx0 = m.x0 - plate, wx1 = m.x1 + plate, wy0 = cy - drum, wy1 = cy + drum;
  a.path(wx0, wy0, wx1 - wx0, wy1 - wy0);
  a.fill(cut ? a.gradient(0, wy0, 0, wy1, [[0, '#050605'], [.5, '#0e0f0c'], [1, '#090a08']])
    : a.gradient(0, wy0, 0, wy1, [[0, '#1b2621'], [.3, '#2c3a33'], [.75, '#25312b'], [1, '#141d19']]));
  for (const px of [m.x0 - plate, m.x1]) a.housing(px, wy0, plate, wy1 - wy0, plateTone, .002);
  if (!look.animated && !cut) {
    const turns = Array.from({ length: m.chambers }, (_, j) => -2 * Math.PI * j / m.chambers).sort((p, q) => Math.cos(p) - Math.cos(q));
    let axle = false;
    for (const turn of turns) {
      const { y, depth } = drumChamber(m, turn);
      if (!axle && depth >= 0) { axle = true; drumAxle(a, m, m.x0, cy); }
      a.ctx.save(); a.ctx.translate(m.x0, y); paintChamber(a, m, true, depth < 0 ? -depth * .3 : 0); a.ctx.restore();
    }
    if (!axle) drumAxle(a, m, m.x0, cy);
  }
  a.path(wx0, wy0, wx1 - wx0, drum * .16); a.fill(a.gradient(0, wy0, 0, wy0 + drum * .16, [[0, '#060c0a99'], [1, '#060c0a00']]));
  a.path(wx0, wy0, wx1 - wx0, wy1 - wy0); a.stroke('#c7cdb5a0', Math.max(a.hair(1), .0016));
  a.path(x1 - wall - e, cy - m.d * .55, wall, m.d * 1.1, m.d * .1); a.fill(BORE);
  a.wear(x0, top, W, wall, 34); a.wear(x0, bottom - wall, W, wall, 35);
  // Its roof of panels, seen edge on over the cut, as thick as a roof that bears a blast until they go.
  if (vented) paintPanels(a, x0 + e, x1 - e, top + e, roof, cut);
  if (!cut) return;
  a.path(x0 + e, top + e + roof, W - 2 * e, bottom - top - 2 * e - roof, .008);
  a.fill(a.gradient(0, top, 0, bottom, [[0, '#060705d0'], [.5, '#14120d90'], [1, '#2a241840']]));
  if (!vented) torn(a, wx0 - plate, wx1 + plate, wy0 - wall * .5, drum * .5, 53);
}
function drumAxle(a: WeaponKit, m: DrumLook, x: number, y: number) { rod(a, x, x + m.length, y, m.axle, STEEL); }

// The pictures that move over a gun in the field (weapon-sprites.ts), each painted once for its gun and laid where the
// moment has it: a chamber of the drum with its round (`round`) or without (`cell`), each laid at its rear end plate on
// its axis; the drum's axle; a round of the belt with its links, laid at its middle across the belt; a barrel of a rotor,
// laid at its rear on its axis; the clamps round the rotor and the rotor blurred as it turns fast, laid at the trunnion.
export type WeaponPiece = 'round' | 'cell' | 'axle' | 'link' | 'barrel' | 'rings' | 'blur';
export function weaponPiece(L: WeaponLayout, piece: WeaponPiece, { create = domCanvas, weathering = null, pad = 2 }: { create?: CanvasFactory; weathering?: WeatheringMaps | null; pad?: number } = {}): WeaponCanvasArt | null {
  const feed = feedLook(L), rotor = L.barrels > 1 ? rotorLook(L) : null;
  let box: { x0: number; x1: number; y0: number; y1: number }, paint: (a: WeaponKit) => void;
  if ((piece === 'round' || piece === 'cell' || piece === 'axle') && feed?.kind === 'magazine') {
    const half = piece === 'axle' ? feed.axle : feed.d * .56;
    box = { x0: 0, x1: feed.length, y0: -half, y1: half };
    paint = piece === 'axle' ? a => drumAxle(a, feed, 0, 0) : a => paintChamber(a, feed, piece === 'round');
  } else if (piece === 'link' && feed?.kind === 'belt') {
    box = { x0: -feed.pitch / 2, x1: feed.pitch / 2, y0: -feed.width / 2, y1: feed.width / 2 };
    paint = a => paintLink(a, feed);
  } else if (piece === 'barrel' && rotor) {
    box = { x0: 0, x1: rotor.end - rotor.from, y0: -rotor.tube, y1: rotor.tube };
    paint = a => lathe(a).turned(0, rotor.end - rotor.from, 0, rotor.tube, PARKER);
  } else if (piece === 'rings' && rotor) {
    box = { x0: rotor.start, x1: rotor.end, y0: rotor.cy - rotor.r * 1.05, y1: rotor.cy + rotor.r * 1.05 };
    paint = a => rotorRings(a, rotor);
  } else if (piece === 'blur' && rotor) {
    box = { x0: rotor.from, x1: rotor.end, y0: rotor.cy - rotor.r, y1: rotor.cy + rotor.r };
    paint = a => {
      // Turning faster than the eye follows, the barrels run together into one round mass streaked along its length.
      lathe(a).turned(rotor.from, rotor.end, rotor.cy, rotor.r * .97, shade(PARKER, -.1));
      for (let k = 0; k < 4 * rotor.n; k++) {
        const { y, depth } = rotorBarrel(rotor, 2 * Math.PI * k / (4 * rotor.n));
        if (depth > .2) a.line(rotor.from + rotor.tube, y - rotor.tube * .5, rotor.end - rotor.tube, y - rotor.tube * .5, GLINT + '1c', Math.max(a.hair(1), rotor.tube * .3));
      }
    };
  } else return null;
  const scale = Math.min(DENSITY, LONGEST / Math.max(box.x1 - box.x0, box.y1 - box.y0)),
    canvas = create(Math.ceil((box.x1 - box.x0) * scale) + pad * 2, Math.ceil((box.y1 - box.y0) * scale) + pad * 2),
    originX = pad - box.x0 * scale, originY = pad - box.y0 * scale, ctx = context2d(canvas);
  ctx.save(); ctx.setTransform(scale, 0, 0, scale, originX, originY);
  paint(weaponKit(ctx, scale, piece === 'barrel' || piece === 'rings' ? weathering : null));
  ctx.restore();
  return { canvas, scale, originX, originY };
}

// The shield turns about the trunnion with the gun. Its native contour includes
// the curved inner face and the opening around the bore; a bounding box only
// sizes its bitmap and never fills that empty space with painted steel.
function paintMantlet(a: WeaponKit, L: WeaponLayout) {
  if (!L.mantlets?.length) return;
  const x0 = Math.min(...L.mantlets.map(m => m.x0)), x1 = Math.max(...L.mantlets.map(m => m.x1)),
    top = -Math.max(...L.mantlets.map(m => m.y1)), bottom = -Math.min(...L.mantlets.map(m => m.y0)), w = x1 - x0, h = bottom - top;
  a.path(x0, top, w, h); a.fill(a.gradient(x0, top, x1, bottom,
    [([0, shade(ARMOUR, .28)] as const), ([.36, shade(ARMOUR, .08)] as const), ([.62, ARMOUR] as const), ([1, shade(ARMOUR, -.30)] as const)]));
  finishMetal(a, x0, top, w, h);
  a.wear(x0, top, w, h, 28);
  for (const [p, q] of L.shieldEdges) {
    a.line(p.x, -p.y, q.x, -q.y, OUTLINE, a.edge);
    a.line(p.x, -p.y, q.x, -q.y, p.y + q.y > 0 ? '#d4dcc06a' : '#273a30a0', a.edge * .42);
  }
}

// The post of a mount out in the open, in its own frame: +x runs up from the face of
// the plate to the trunnion, however far the gun stands off it, and its foot is cut
// along that face, square across a level one and aslant on a slope. A foot plate
// bolted on the face, gussets, the boxed bearing column banded along it, and at its
// top the cradle socket and locking pin; a long one is stayed under its socket too,
// and spliced by a bolted flange half way up.
function paintPost(a: WeaponKit, L: ExposedLayout) {
  const lath = lathe(a), e = a.edge / 2, box = L.receiver, outline = L.contours.receiver, first = outline[0]!, last = outline[3]!,
    // Where the face crosses it, at a height of the canvas (whose y runs down).
    face = (y: number) => first.x + (last.x - first.x) * (-y - first.y) / (last.y - first.y),
    x0 = Math.max(first.x, last.x), x1 = box.x1, tall = x1 - x0,
    cy = -(box.y0 + box.y1) / 2, half = (box.y1 - box.y0) / 2 - e, r = half * .56, foot = Math.min(.024, tall * .05),
    socket = Math.min(.11, tall * .2), stay = Math.min(tall * .18, Math.max(.1, tall * .14)), column = tall - foot - socket,
    bands = Math.max(2, Math.round(column / .28));
  // A fabricated pedestal, with reinforced cheeks and a guided upper spindle.
  // All paint remains clipped to the one native post solid, which it fills down to the face.
  a.shape(outline.map(p => ([p.x, -p.y] as const))); a.fill(shade(GUNMETAL, .02));
  a.housing(x0+foot,cy-r,column,2*r,shade(GUNMETAL,.08),Math.min(.008,r*.25));
  a.housing(x0+foot+stay*.35,cy-r*.64,column-stay*.35,r*1.28,shade(STEEL,.13),.003);
  a.line(x0+foot+stay*.45,cy-r*.42,x1-socket-.004,cy-r*.42,'#bbc4a080',a.hair(1));
  for (const t of bands === 2 ? ([.22,.66] as const) : Array.from({length:bands},(_,i)=>(i+.5)/bands)) {
    const x=x0+foot+column*t;
    a.line(x,cy-r*.9,x,cy+r*.9,'#17271b',a.hair(1.2));
    a.bolt(x,cy,Math.min(.005,r*.23));
  }
  for (const side of ([-1, 1] as const)) {
    const y = cy + side * half, inner = cy + side * r, from = face(inner) + foot;
    a.shape([([face(y) + foot, y] as const), ([from, inner] as const), ([x0 + foot + stay, inner] as const)]);
    a.fill(shade(GUNMETAL, side < 0 ? .12 : -.12));
    finishMetal(a, Math.min(from, face(y) + foot), Math.min(y, inner), x0 + foot + stay - Math.min(from, face(y) + foot), half - r); a.stroke(OUTLINE, a.hair(1));
  }
  if (column > 3 * stay) for (const side of ([-1, 1] as const)) {
    a.shape([([x1 - socket, cy + side * half * .9] as const), ([x1 - socket, cy + side * r] as const), ([x1 - socket - stay * .8, cy + side * r] as const)]);
    a.fill(shade(GUNMETAL, side < 0 ? .12 : -.12)); a.stroke(OUTLINE, a.hair(1));
  }
  if (column > 1) {
    const x = x0 + foot + column / 2, ring = Math.min(.016, foot * .7);
    a.housing(x - ring / 2, cy - half * .86, ring, half * 1.72, shade(GUNMETAL, -.04), .002);
    for (const side of ([-1, 1] as const)) a.bolt(x, cy + side * half * .7, Math.min(ring * .4, .005));
  }
  a.shape([([face(cy - half) + e, cy - half] as const), ([face(cy - half) + foot, cy - half] as const), ([face(cy + half) + foot, cy + half] as const), ([face(cy + half) + e, cy + half] as const)]);
  a.fill(shade(GUNMETAL, -.08)); a.stroke(OUTLINE, a.hair(1));
  for (const side of ([-1, 1] as const)) a.bolt(face(cy + side * half * .74) + foot * .55, cy + side * half * .74, Math.min(foot * .32, .006));
  lath.turned(x1 - socket, x1 - socket * .25, cy, half * .86, GUNMETAL, { cap: half * .2 });
  for (const t of ([.35, .7] as const)) a.line(x1 - socket * t, cy - half * .86, x1 - socket * t, cy + half * .86, '#0f1a1570', a.hair(1));
  a.housing(x1 - socket * .62, cy - half - e, socket * .2, half * .5 + e, shade(STEEL, .25), .002);
  lath.turned(x1 - socket * .25, x1, cy, r * .7, shade(STEEL, .1));
}

// A gun on a post without grips of its own is fired by a grip under its rear.
const GRIPPED = new Set<WeaponPresetId>(['fnmag', 'minimi']);
// The gun a post carries, in the frame of its bore: its own receiver lying behind the trunnion, the compartment of its
// ready rounds with it (`paintCompartment`), and the cradle that takes the gun at the trunnion.
function paintCarried(a: WeaponKit, L: ExposedLayout, look: WeaponLook = {}) {
  const boxes = compartmentBoxes(L), R = receiverFrame(a, boxes?.own ?? L.body), { X, Y } = R;
  if (boxes) paintCompartment(a, L, look, 'back');
  RECEIVERS[L.preset]!(a, R, L);
  if (GRIPPED.has(L.preset)) {
    a.shape([([X(.2), Y(-.7)] as const), ([X(.14), Y(-1)] as const), ([X(.24), Y(-1)] as const), ([X(.3), Y(-.7)] as const)]); a.fill(RUBBER); a.stroke(OUTLINE, a.hair(1));
  }
  if (boxes) paintCompartment(a, L, look, 'front');
  // The cradle takes the gun under its front, on the pin of the trunnion.
  R.block(.82, 1, -1, -.5, shade(ARMOUR, -.12), .004);
  const r = Math.min(R.H * .12, R.W * .05);
  a.circle(L.body.x1 - r, R.cy, r, a.radial(L.body.x1 - r, R.cy, r, [[0, '#7a8673'], [1, '#353f37']]), OUTLINE, a.hair(1));
  a.bolt(L.body.x1 - r, R.cy, Math.min(.006, r * .4));
}

// The front of the cradle before the trunnion, round the root of the barrel.
function paintSupport(a: WeaponKit, L: ExposedLayout) {
  const e = a.edge / 2, s = L.support, x0 = s.x0, x1 = s.x1 - e, top = -s.y1 + e, bottom = -s.y0 - e, h = bottom - top;
  a.housing(x0, top, x1 - x0, h, shade(GUNMETAL, .06), Math.min(h * .3, (x1 - x0) * .3));
  a.path(x0 + (x1 - x0) * .25, -L.cy - h * .12, (x1 - x0) * .45, h * .24, h * .1); a.fill(BORE);
  a.bolt(x0 + (x1 - x0) * .2, top + h * .2, Math.min(.006, h * .1));
}

// An open slide shows the travel behind the breech, as far as the gun recoils
// where it is laid (weapon-art.ts `weaponRecoilStroke`). The rails stay put
// while the mechanism runs between them; their open middle does not read as
// another slab of armour. This drawing adds no material to the admitted gun.
function paintRecoilFrame(a: WeaponKit, L: WeaponLayout) {
  if (!L.mounted || !(L.reserve > 0)) return;
  const box = recoilFrameBounds(L), h = box.y1 - box.y0,
    rail = Math.min(.025, h * .08, L.reserve * .12), top = -box.y1, bottom = -box.y0;
  a.ctx.save(); a.ctx.globalAlpha = .78;
  a.housing(box.x0, top, L.reserve, rail, shade(STEEL, .12), rail * .2);
  a.housing(box.x0, bottom - rail, L.reserve, rail, shade(GUNMETAL, -.06), rail * .2);
  a.housing(box.x0, top + rail, rail, h - 2 * rail, GUNMETAL, rail * .2);
  a.line(box.x0 + rail, top + rail * .4, box.x1 - rail * .3, top + rail * .4, '#ced5bd80', Math.min(a.hair(1), rail * .3));
  a.line(box.x0 + rail, bottom - rail * .4, box.x1 - rail * .3, bottom - rail * .4, '#9da99270', Math.min(a.hair(1), rail * .3));
  a.ctx.restore();
}

// `originX/originY` is the canvas pixel of the weapon's pivot, at `scale` px/m.
export function paintWeapon(ctx: ArtContext, L: WeaponLayout, part: WeaponPart = 'all', scale = 400, originX = 0, originY = 0, weathering: WeatheringMaps | null = null, look: WeaponLook = {}) {
  ctx.save(); ctx.setTransform(scale, 0, 0, scale, originX, originY);
  const a = weaponKit(ctx, scale, weathering), clip = (contours: readonly (readonly Point[] | undefined)[]) => {
    if (!L.mounted) return;
    ctx.beginPath();
    for (const points of contours) {
      points!.forEach((point, i) => i ? ctx.lineTo(point.x, -point.y) : ctx.moveTo(point.x, -point.y));
      ctx.closePath();
    }
    ctx.clip();
  };
  if (part === 'all') for (const poly of L.contours?.base || []) {
    a.shape(poly.map(p => ([p.x, -p.y] as const))); a.fill(STEEL); a.stroke(OUTLINE, a.hair(1));
  }
  if (part === 'cradle') {
    paintRecoilFrame(a, L);
    if (!L.exposed) { ctx.save(); clip(L.contours!.mantlets); paintMantlet(a, L); ctx.restore(); }
    ctx.restore(); return;
  }
  if (part !== 'moving') {
    ctx.save(); if (part === 'all' && L.turn) ctx.rotate(-L.turn); clip(([L.contours?.receiver] as const));
    if (L.exposed) paintPost(a, L); else paintReceiver(a, L, L.receiver, look);
    ctx.restore();
  }
  if (part !== 'receiver') {
    ctx.save(); clip([L.contours?.tube, ...(L.exposed ? L.contours.mantlets : [])]); paintTube(a, L, look.animated);
    if (L.exposed) { paintSupport(a, L); paintCarried(a, L, look); }
    ctx.restore();
    if (L.mounted && !L.exposed && part === 'all') {
      ctx.save(); clip(L.contours.mantlets); paintMantlet(a, L); ctx.restore();
    }
  }
  if (part === 'all') paintRecoilFrame(a, L);
  ctx.restore();
}

// As fine as the closest view needs, within what a texture may hold (machine-art.ts): a long gun is painted coarser
// per metre than a short one, never wider than the longest side a texture takes everywhere.
const DENSITY = 900, LONGEST = 2048;
const domCanvas = (width: number, height: number) => Object.assign(document.createElement('canvas'), { width, height });
export function weaponCanvas(L: WeaponLayout, part?: WeaponPart, options?: Omit<WeaponCanvasOptions, 'create'> & { create?: undefined }): WeaponCanvasArt<HTMLCanvasElement>;
export function weaponCanvas<C extends ArtCanvas>(L: WeaponLayout, part: WeaponPart, options: Omit<WeaponCanvasOptions, 'create'> & { create: CanvasFactory<C> }): WeaponCanvasArt<C>;
export function weaponCanvas(L: WeaponLayout, part: WeaponPart = 'all', { scale, pad = 2, create = domCanvas, weathering = null, animated, cut }: WeaponCanvasOptions = {}): WeaponCanvasArt {
  const box = weaponPartBounds(L, part), size = scale ?? Math.min(DENSITY, LONGEST / Math.max(box.x1 - box.x0, box.y1 - box.y0)),
    canvas = create(Math.ceil((box.x1 - box.x0) * size) + pad * 2, Math.ceil((box.y1 - box.y0) * size) + pad * 2),
    originX = pad - box.x0 * size, originY = pad + box.y1 * size;
  paintWeapon(context2d(canvas), L, part, size, originX, originY, weathering, { animated, cut });
  return { canvas, scale: size, originX, originY };
}
// Lit side of a mounted weapon: host axes pointing left carry native +y downward.
export const weaponFlip = (weapon: Pick<WeaponGeometry, 'weaponMount' | 'angle'> | null | undefined) => weapon?.weaponMount && Math.cos(weapon.angle || 0) < -.01 ? -1 : 1;
// One still image for cards and the inspector: the catalogue weapon, or an
// installed one with its own mechanism, port collar and mantlet, `width` pixels
// long or at `scale` pixels a metre.
export function weaponPreviewCanvas(presetId: WeaponId, installed: WeaponGeometry | null = null, { scale, width = 520, weathering = null }: { scale?: number; width?: number; weathering?: WeatheringMaps | null } = {}) {
  const mounted = installed?.weaponMount && Array.isArray(installed.materialPolygons),
    L = weaponLayout(presetId, mounted ? installed.materialPolygons : null, weaponFlip(installed), 0, installed?.weaponMount?.exposed), box = weaponPartBounds(L);
  return weaponCanvas(L, 'all', { scale: scale ?? Math.min(DENSITY, width / (box.x1 - box.x0)), weathering }).canvas;
}
// The guns of a tab of the arsenal, shown at one scale for their sizes to compare: the length of each off any mount and
// its share of the longest, the width its picture takes of its card.
export function arsenalScale(presetIds: readonly WeaponId[]) {
  const lengths = presetIds.map(id => { const box = weaponPartBounds(weaponLayout(id)); return box.x1 - box.x0; }), longest = Math.max(...lengths);
  return { longest, shares: lengths.map(length => length / longest) };
}
