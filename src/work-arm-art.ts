import type { Graphics } from 'pixi.js';
import type { WorkFigure, CraneFigure } from './work-arm.ts';
import type { Point } from './math.ts';
import type { CargoKind } from './component-volume.ts';
import type { StockId } from './economy-contract.ts';
import type { WeatheredFill } from './weathered-fill.ts';
import type { ArtContext, CanvasPaint, GradientStop, XY } from './canvas-art.ts';
import { DEPOSIT_TONES } from './deposit-art.ts';

type DepositTone = (typeof DEPOSIT_TONES)[keyof typeof DEPOSIT_TONES];
const materialTones: Partial<Record<CargoKind | StockId, DepositTone>> = DEPOSIT_TONES;
type WorkFaceName = 'seat' | 'boom' | 'stick' | 'bucket' | 'mast' | 'head' | 'foot' | 'column' | 'jib' | 'first' | 'second' | 'third' | 'block';
interface WorkWeatheringFace { fill: WeatheredFill; sx: number; sy: number }
export type WorkWeatheringFills = Partial<Record<WorkFaceName, WorkWeatheringFace>>;
export interface WorkArmArtOptions { pixel?: number | undefined; material?: CargoKind | StockId | undefined; weatheringFills?: WorkWeatheringFills | null | undefined }
type WorkKit = ReturnType<typeof workKit>;

// The complete excavator arm, drill rig and builder's crane, drawn from their figure (work-arm.ts) in places of the
// world: beams in the ochre of working gear, rams and pins of steel. `pixel` is how many metres a pixel
// of the screen is: from afar only the beams and the tool are drawn, and no line is thinner than a pixel.
const PAINT = 0xb19a55, SHADE = 0x77683c, STEEL = 0x56635a, DARK = 0x1b2620, ROD = 0xcdd2c0, PIN = 0x98a38e, HOSE = 0x1f2924, LATTICE = 0x39463f,
  CABLE = 0x262d29, HOOK = 0x8f9a90, PALLET = 0x8a7650, BLOCKS = 0x4a3d26, STRAP = 0x2a2620;

// These four opaque surfaces are prepared once by the renderer. Articulation
// changes only a segment's texture basis, never its material or tile content.
// A tool may be built from different metals. Its shared painted finish has
// scuffs, dirt and oil, with no ferrous oxide applied to aluminium or titanium.
export const WORK_ARM_WEATHERING = Object.freeze({
  armPaint: Object.freeze({ id: 'work-arm-paint', color: PAINT, material: 'painted', chips: .12, dirt: .10, oil: .01, period: 1.6 }),
  bucketSteel: Object.freeze({ id: 'work-bucket-steel', color: 0x47544b, material: 'painted', chips: .20, dirt: .22, oil: .02, period: .9 }),
  mastSteel: Object.freeze({ id: 'work-mast-steel', color: LATTICE, material: 'painted', chips: .12, dirt: .12, oil: .01, period: 1.2 }),
  seatSteel: Object.freeze({ id: 'work-seat-steel', color: STEEL, material: 'painted', chips: .12, dirt: .10, oil: .02, period: .9 }),
});

// One retained set per installed tool. Each rigid face needs its own matrix;
// shared material textures and their default matrices remain untouched. A
// builder's crane has faces of its own: its column, its two booms, the three
// sections that run out of the outer one and its hook block.
export function createWorkArmWeathering(fills: Record<keyof typeof WORK_ARM_WEATHERING, WeatheredFill> | null | undefined, kind: string | null = null) {
  if (!fills) return null;
  const face = (family: keyof typeof WORK_ARM_WEATHERING) => {
    const base = fills[family];
    return { fill: { ...base, matrix: base.matrix.clone() }, sx: base.matrix.a, sy: base.matrix.d };
  };
  if (kind === 'builder') return { column: face('seatSteel'), boom: face('armPaint'), jib: face('armPaint'), first: face('armPaint'),
    second: face('armPaint'), third: face('armPaint'), block: face('seatSteel') };
  return { seat: face('seatSteel'), boom: face('armPaint'), stick: face('armPaint'), bucket: face('bucketSteel'),
    mast: face('mastSteel'), head: face('armPaint'), foot: face('seatSteel') };
}

// What every arm is drawn with: whether it is near enough for its detail (`fine`), the width of an outline, a rigid
// face's fill set at its place (`metal`), and beams, rams and pins.
function workKit(g: Graphics, pixel: number, weatheringFills: WorkWeatheringFills | null) {
  const fine = pixel < .07, line = Math.max(.014, pixel * .9),
    metal = (name: WorkFaceName, color: number, x: number, y: number, ux = 1, uy = 0, vx = -uy, vy = ux) => {
      const face = weatheringFills?.[name];
      if (!face) return color;
      face.fill.matrix.set(ux * face.sx, uy * face.sx, vx * face.sy, vy * face.sy, x, y);
      return face.fill;
    },
    along = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    unit = (a: Point, b: Point) => { const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1; return { x: dx / length, y: dy / length }; },
    beam = (a: Point, b: Point, wide: number, narrow: number, color: number, face: WorkFaceName) => {
      const way = unit(a, b), nx = -way.y / 2, ny = way.x / 2;
      g.poly([a.x + nx * wide, a.y + ny * wide, b.x + nx * narrow, b.y + ny * narrow, b.x - nx * narrow, b.y - ny * narrow, a.x - nx * wide, a.y - ny * wide])
        .fill(metal(face, color, a.x, a.y, way.x, way.y)).stroke({ color: DARK, width: line });
    },
    // A ram: its barrel from where it is footed, its rod on to what it pushes.
    ram = (a: Point, b: Point, width: number) => {
      const m = along(a, b, .56);
      g.moveTo(m.x, m.y).lineTo(b.x, b.y).stroke({ color: ROD, width: Math.max(width * .42, pixel) });
      g.moveTo(a.x, a.y).lineTo(m.x, m.y).stroke({ color: DARK, width: width + line * 2 });
      g.moveTo(a.x, a.y).lineTo(m.x, m.y).stroke({ color: STEEL, width });
    },
    pin = (p: Point, radius: number) => { g.circle(p.x, p.y, radius).fill(DARK); g.circle(p.x, p.y, radius * .5).fill(PIN); };
  return { fine, line, pixel, metal, along, unit, beam, ram, pin };
}

export function drawWorkArm(g: Graphics, figure: WorkFigure | CraneFigure, { pixel = 0, material = 'ferro', weatheringFills = null }: WorkArmArtOptions = {}) {
  const kit = workKit(g, pixel, weatheringFills), { fine, line, metal, along, unit, beam, ram, pin } = kit;
  if (figure.kind === 'builder') { drawCrane(g, figure, kit, materialTones[material] || DEPOSIT_TONES.ferro); return; }
  const { mount, elbow, wrist, size, side, rig } = figure, tone = materialTones[rig ? 'petroleo' : material] || DEPOSIT_TONES.ferro,
    tail = along(elbow, wrist, -.16), boomWay = unit(mount, elbow), lift = { x: -boomWay.y * side, y: boomWay.x * side };
  // The hose of a rig hangs under the arm, from the head of the string to the seat: it lies behind the beams.
  if (rig) {
    const sag = (a: Point, b: Point) => { const m = along(a, b, .5); return { x: m.x, y: m.y - .14 * Math.hypot(b.x - a.x, b.y - a.y) }; },
      first = sag(wrist, elbow), second = sag(elbow, mount), width = Math.max(.05 * size, pixel);
    g.moveTo(figure.head.x, figure.head.y).lineTo(wrist.x, wrist.y).quadraticCurveTo(first.x, first.y, elbow.x, elbow.y)
      .quadraticCurveTo(second.x, second.y, mount.x, mount.y).stroke({ color: HOSE, width });
    // What it pumps goes along it in swellings, from the mast towards the site's collection point.
    if (fine && figure.flow !== null) for (let k = 0; k < 4; k++) {
    const s = ((k / 4 + Number(figure.flow) * .55) % 1) * 2, [a, c, b] = s < 1 ? [wrist, first, elbow] : [elbow, second, mount], t = s % 1, u = 1 - t;
      g.circle(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, width * .62).fill({ color: 0x6d776c, alpha: .9 });
    }
  }
  // The seat on the casing of the piece: its slewing ring, and under a ring standing high a pedestal kept over the casing
  // at the end of the piece. Then the boom with its ram and the stick with its own.
  const up = unit(figure.base, mount), deep = Math.max(.1, Math.hypot(mount.x - figure.base.x, mount.y - figure.base.y) / size),
    seat = (u: number, v: number): XY => [mount.x + (up.y * u + up.x * v) * size, mount.y + (-up.x * u + up.y * v) * size], high = deep > .12, end = high ? .085 : .17;
  g.poly([...seat(-side * .17, -deep), ...seat(side * end, -deep), ...seat(side * end, -.1), ...seat(side * .17, -.1), ...seat(side * .11, .03),
    ...seat(-side * .11, .03), ...seat(-side * .17, -.1)]).fill(metal('seat', STEEL, mount.x, mount.y, up.y, -up.x)).stroke({ color: DARK, width: line });
  if (fine && high) g.moveTo(...seat(-.17, -.1)).lineTo(...seat(.17, -.1)).stroke({ color: DARK, width: Math.max(.02 * size, pixel) });
  if (fine) ram({ x: mount.x + side * .2 * size, y: mount.y - .05 * size }, along(mount, elbow, .42), .055 * size);
  beam(mount, elbow, .17 * size, .125 * size, PAINT, 'boom');
  if (fine) {
    const from = along(mount, elbow, .52);
    ram({ x: from.x + lift.x * .11 * size, y: from.y + lift.y * .11 * size }, tail, .05 * size);
    const a = along(mount, elbow, .12), b = along(mount, elbow, .9);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: SHADE, width: Math.max(.02 * size, pixel) });
  }
  beam(tail, wrist, .13 * size, .095 * size, PAINT, 'stick');
  if (rig) drawMast(g, figure, { fine, line, pixel, tone, unit, along, beam });
  else drawBucket(g, figure, { fine, line, pixel, tone, along, ram, metal });
  if (fine) { pin(mount, .06 * size); pin(elbow, .05 * size); pin(wrist, .042 * size); }
}

// The bucket: its side plate, the teeth on its lip and, when it holds any, a heap of what it dug.
function drawBucket(g: Graphics, figure: Extract<WorkFigure, { rig: false }>, { fine, line, pixel, tone, along, ram, metal }: Pick<WorkKit, 'fine' | 'line' | 'pixel' | 'along' | 'ram' | 'metal'> & { tone: DepositTone }) {
  const { wrist, elbow, tip, open, length, size, side } = figure, way = { x: (tip.x - wrist.x) / length, y: (tip.y - wrist.y) / length },
    at = (u: number, v: number): XY => [wrist.x + (way.x * u + open.x * v) * length, wrist.y + (way.y * u + open.y * v) * length],
    shape = (points: readonly XY[]) => points.flatMap(([u, v]) => at(u, v));
  if (fine) { const [x, y] = at(.14, -.3); ram(along(elbow, wrist, .38), { x, y }, .04 * size); }
  if (figure.load > 0) {
    const full = figure.load;
    g.poly(shape([[.1, -.02], [.28, .2 * full], [.55, .27 * full], [.8, .16 * full], [.96, -.02]])).fill(tone.heap);
    if (fine) g.poly(shape([[.36, .16 * full], [.55, .25 * full], [.7, .17 * full], [.54, .09 * full]])).fill({ color: tone.light, alpha: .5 });
  }
  g.poly(shape([[-.06, .05], [-.13, -.2], [.02, -.5], [.36, -.64], [.72, -.5], [.93, -.2], [1, 0], [.82, -.08], [.1, -.03]]))
    .fill(metal('bucket', 0x47544b, wrist.x, wrist.y, way.x, way.y, open.x, open.y)).stroke({ color: DARK, width: line });
  if (fine) {
    for (const u of [.86, .98]) g.poly(shape([[u, -.03], [u + .17, .05], [u - .04, -.13]])).fill(ROD);
    const [ax, ay] = at(.12, -.3), [bx, by] = at(.42, -.5), [cx, cy] = at(.74, -.36);
    g.moveTo(ax, ay).lineTo(bx, by).lineTo(cx, cy).stroke({ color: 0x6f7c70, width: Math.max(.018 * size, pixel) });
  }
  // What falls into the opening stays there as the empty bucket lifts away.
  if (figure.spill !== null) for (let i = 0; i < 6; i++) {
    const t = figure.spill - i * .07, [u, v] = at(.55 + (i % 3) * .12, .05),
      x = u + (figure.spillOrigin.x - tip.x), y = v + (figure.spillOrigin.y - tip.y), fall = 4.9 * t * t;
    if (t > 0 && fall < y - (figure.floor ?? y - length - .45 * size)) g.circle(x - side * (.03 + i % 2 * .05) * t, y - fall, (.045 + i % 3 * .012) * size).fill(i % 2 ? tone.heap : tone.shade);
  }
  // And the dust of the ground it breaks, rising where it digs.
  if (figure.dig && figure.dust !== null) for (let i = 0; i < 4; i++) {
    const p = Math.min(1, figure.dust * 1.25 + i * .06), fade = 1 - p;
    if (fade > 0) g.circle(figure.dig.x + side * (i - 1.5) * .22 * (1 + p), figure.dig.y + .12 + (.25 + i % 2 * .2) * p * size, (.14 + .32 * p) * size)
      .fill({ color: tone.light, alpha: .3 * fade });
  }
}

// The mast: two rails braced against one another, the string between them with its head riding down, and
// at the ground the collar of what it brought up. The flights of the string go by as it turns.
function drawMast(g: Graphics, figure: Extract<WorkFigure, { rig: true }>, { fine, line, pixel, tone, unit, along, beam }: Pick<WorkKit, 'fine' | 'line' | 'pixel' | 'unit' | 'along' | 'beam'> & { tone: DepositTone }) {
  const { wrist, tip, head, bit, collar, size, length } = figure, way = unit(wrist, tip), nx = -way.y, ny = way.x, half = .085 * size,
    rail = (sign: number) => { g.moveTo(wrist.x + nx * half * sign, wrist.y + ny * half * sign).lineTo(tip.x + nx * half * sign, tip.y + ny * half * sign)
      .stroke({ color: PAINT, width: Math.max(.035 * size, pixel) }); };
  if (collar) {
    const wide = (.2 + .22 * figure.sunk) * size, high = .1 * figure.sunk * size;
    g.ellipse(collar.x, collar.y + .01, wide * 1.5, Math.max(.03 * size, pixel)).fill({ color: tone.light, alpha: .6 * figure.sunk });
    g.poly([collar.x - wide, collar.y, collar.x - wide * .4, collar.y + high, collar.x + wide * .4, collar.y + high, collar.x + wide, collar.y]).fill(tone.heap);
  }
  beam(wrist, tip, 2 * half, 2 * half, LATTICE, 'mast');
  if (fine) {
    const bays = Math.max(3, Math.round(length / (.24 * size)));
    for (let i = 0; i < bays; i++) {
      const a = along(wrist, tip, i / bays), b = along(wrist, tip, (i + 1) / bays), sign = i % 2 ? 1 : -1;
      g.moveTo(a.x + nx * half * sign, a.y + ny * half * sign).lineTo(b.x - nx * half * sign, b.y - ny * half * sign).stroke({ color: SHADE, width: Math.max(.018 * size, pixel) });
    }
  }
  rail(1); rail(-1);
  // The string, from its head to where the ground takes it.
  const run = Math.hypot(bit.x - head.x, bit.y - head.y), wide = .05 * size;
  g.moveTo(head.x, head.y).lineTo(bit.x, bit.y).stroke({ color: 0x8f9a90, width: Math.max(wide, pixel) });
  if (fine && run > 0) {
    const pitch = .12 * size, phase = figure.turn * 1.6 % 1;
    for (let d = phase * pitch; d < run; d += pitch) {
      const x = head.x + way.x * d, y = head.y + way.y * d;
      g.moveTo(x - nx * wide * .8 - way.x * wide * .5, y - ny * wide * .8 - way.y * wide * .5)
        .lineTo(x + nx * wide * .8 + way.x * wide * .5, y + ny * wide * .8 + way.y * wide * .5).stroke({ color: DARK, width: line });
    }
  }
  beam({ x: head.x - way.x * .09 * size, y: head.y - way.y * .09 * size }, { x: head.x + way.x * .09 * size, y: head.y + way.y * .09 * size }, .25 * size, .25 * size, PAINT, 'head');
  beam({ x: tip.x - nx * .17 * size, y: tip.y - ny * .17 * size }, { x: tip.x + nx * .17 * size, y: tip.y + ny * .17 * size }, .05 * size, .05 * size, STEEL, 'foot');
}

// The builder's crane: its slewing base on the casing, the column on its turntable, the main boom on the column with its
// ram from the foot, the outer boom on the knuckle with its ram over the main boom and the three sections run out of it,
// the cable from the sheave at the tip to the hook block, the boom rest its booms lie on folded, and the load
// (`drawLoad`). From afar, the base, the rest, the beams, the cable, the block and the load.
function drawCrane(g: Graphics, figure: CraneFigure, { fine, line, pixel, metal, along, unit, beam, ram, pin }: WorkKit, tone: DepositTone) {
  const { base, mount, pivot, knuckle, sleeve, tip, hook, size, side, run, block, rest } = figure,
    up = unit(mount, pivot), boomWay = unit(pivot, knuckle), over = { x: -boomWay.y * side, y: boomWay.x * side },
    way = unit(knuckle, sleeve), heel = along(knuckle, sleeve, -.12), out = (p: Point, d: number) => ({ x: p.x + way.x * d, y: p.y + way.y * d }),
    // Across and up the piece from a place, in metres of the reference crane; the steel parts share the column's finish.
    from = (p: Point, u: number, v: number): XY => [p.x + (up.y * u + up.x * v) * size, p.y + (-up.x * u + up.y * v) * size], foot = (u: number, v: number) => from(mount, u, v),
    plate = (points: readonly XY[]) => g.poly(points.flat()).fill(metal('column', STEEL, mount.x, mount.y, up.x, up.y)).stroke({ color: DARK, width: line }),
    // How high over the casing the foot of the column stands, and the saddle of the rest under the folded outer boom.
    deep = Math.hypot(mount.x - base.x, mount.y - base.y) / size,
    saddle = ((rest.head.x - rest.foot.x) * up.x + (rest.head.y - rest.foot.y) * up.y) / size - .06;
  // The rest: a post on its foot plate with a saddle the folded outer boom lies in.
  plate([from(rest.foot, -.022, 0), from(rest.foot, .022, 0), from(rest.foot, .022, saddle - .03), from(rest.foot, -.022, saddle - .03)]);
  plate([from(rest.foot, -.05, 0), from(rest.foot, .05, 0), from(rest.foot, .04, .025), from(rest.foot, -.04, .025)]);
  plate([from(rest.foot, -.045, saddle - .035), from(rest.foot, .045, saddle - .035), from(rest.foot, .075, saddle), from(rest.foot, -.075, saddle)]);
  if (fine) g.moveTo(...from(rest.foot, -.07, saddle - .006)).lineTo(...from(rest.foot, .07, saddle - .006)).stroke({ color: DARK, width: Math.max(.012 * size, pixel) });
  // The slewing base the column turns on, kept over the casing at the end of the piece and housing its gear on the side
  // towards the middle; its turntable and the column.
  plate([foot(-side * .125, -deep), foot(side * .22, -deep), foot(side * .18, -.05), foot(-side * .125, -.05)]);
  if (fine) g.moveTo(...foot(-side * .115, -.45 * deep)).lineTo(...foot(side * .2, -.45 * deep)).stroke({ color: DARK, width: Math.max(.015 * size, pixel) });
  plate([foot(-.155, -.05), foot(.155, -.05), foot(.13, .06), foot(-.13, .06)]);
  beam(mount, pivot, .24 * size, .2 * size, STEEL, 'column');
  if (fine) {
    // The slewing ring low on the column, and the ram that raises the main boom from the foot of the column.
    const ring = along(mount, pivot, .3);
    g.moveTo(ring.x - up.y * .13 * size, ring.y + up.x * .13 * size).lineTo(ring.x + up.y * .13 * size, ring.y - up.x * .13 * size)
      .stroke({ color: DARK, width: Math.max(.035 * size, pixel) });
    const under = along(pivot, knuckle, .42);
    ram({ x: mount.x + (up.y * side * .1 + up.x * .1) * size, y: mount.y + (-up.x * side * .1 + up.y * .1) * size },
      { x: under.x - over.x * .07 * size, y: under.y - over.y * .07 * size }, .07 * size);
  }
  beam(pivot, knuckle, .17 * size, .14 * size, PAINT, 'boom');
  if (fine) {
    const from = along(pivot, knuckle, .3);
    ram({ x: from.x + over.x * .11 * size, y: from.y + over.y * .11 * size }, { x: heel.x + over.x * .05 * size, y: heel.y + over.y * .05 * size }, .055 * size);
    const a = along(pivot, knuckle, .1), b = along(pivot, knuckle, .9);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: SHADE, width: Math.max(.02 * size, pixel) });
  }
  // The sections slide out of the end of the outer boom, each narrower one out of the one before, by a third of the run each.
  if (run > .01 * size) for (const [k, face] of [[3, 'third'], [2, 'second'], [1, 'first']] as const)
    beam(out(sleeve, run * (k - 1) / 3 - .25 * size), k === 3 ? tip : out(sleeve, run * k / 3), (.11 - .016 * k) * size, (.105 - .016 * k) * size, PAINT, face);
  beam(heel, sleeve, .13 * size, .11 * size, PAINT, 'jib');
  if (fine) { g.circle(tip.x, tip.y, .055 * size).fill(STEEL).stroke({ color: DARK, width: line }); }
  // The cable, and the block it holds with the hook under it.
  g.moveTo(tip.x, tip.y).lineTo(hook.x, hook.y).stroke({ color: CABLE, width: Math.max(.022 * size, pixel) });
  const bottom = hook.y - block, crook = figure.crook;
  g.poly([hook.x - .08 * size, hook.y, hook.x + .08 * size, hook.y, hook.x + .065 * size, bottom, hook.x - .065 * size, bottom])
    .fill(metal('block', STEEL, hook.x, hook.y)).stroke({ color: DARK, width: line });
  g.moveTo(hook.x, bottom).lineTo(hook.x, bottom - .5 * crook).lineTo(hook.x - .03 * size, bottom - .75 * crook).lineTo(hook.x, bottom - crook)
    .lineTo(hook.x + .035 * size, bottom - .79 * crook).lineTo(hook.x + .03 * size, bottom - .58 * crook).stroke({ color: HOOK, width: Math.max(.025 * size, pixel) });
  if (figure.load) drawLoad(g, figure.load, { fine, line, pixel, size, tone, sling: figure.load.hung ? { x: hook.x, y: bottom - .83 * crook } : null });
  if (fine) { pin(pivot, .06 * size); pin(knuckle, .05 * size); }
}

// A load of material on its pallet: the deck on its blocks, the goods on it in the tones of the material with a band of its
// colour along the top, their courses and the straps that hold them, and, hung, the two slings to the hook. One coming to
// be where it is taken up or going into what it is set on is as faint as it is so far there.
function drawLoad(g: Graphics, load: NonNullable<CraneFigure['load']>, { fine, line, pixel, size, tone, sling }: Pick<WorkKit, 'fine' | 'line' | 'pixel'> & { size: number; tone: DepositTone; sling: Point | null }) {
  const { x, y, width: w, height: h, shown: alpha } = load, left = x - w / 2, base = y + .16 * h, goods = .92 * w;
  if (!(alpha > 0)) return;
  if (fine) for (const u of [0, .44, .88]) g.rect(left + u * w, y, .12 * w, .05 * h).fill({ color: BLOCKS, alpha });
  g.rect(left, fine ? y + .05 * h : y, w, fine ? .11 * h : .16 * h).fill({ color: PALLET, alpha });
  g.rect(x - goods / 2, base, goods, h - .16 * h).fill({ color: tone.heap, alpha }).stroke({ color: DARK, width: line, alpha });
  g.rect(x - goods / 2, y + .86 * h, goods, .14 * h).fill({ color: tone.plate, alpha });
  if (fine) {
    for (const k of [1, 2]) g.moveTo(x - goods / 2, base + .7 * h * k / 3).lineTo(x + goods / 2, base + .7 * h * k / 3).stroke({ color: tone.shade, width: line, alpha });
    for (const u of [-.25, .25]) g.rect(x + u * w - .018 * w, base, .036 * w, h - .16 * h).fill({ color: STRAP, alpha });
  }
  if (sling) g.moveTo(x - .38 * w, y + h).lineTo(sling.x, sling.y).lineTo(x + .38 * w, y + h).stroke({ color: CABLE, width: Math.max(.015 * size, pixel) });
}
