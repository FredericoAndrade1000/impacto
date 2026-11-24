import type { CargoRoomObservation, CargoKind } from './component-volume.ts';
import type { SupplyBill, CargoLoad } from './economy-contract.ts';
import type { ModuleKind } from './materials.ts';
import type { ArtFinish, ComponentArtOptions, CargoArch } from './vehicle-art-contract.ts';
import type { ArtContext, CanvasPaint, GradientStop, XY } from './canvas-art.ts';
import { Random, clamp } from './math.ts';
import { DEPOSIT_TONES } from './deposit-palette.ts';
import { MODULES } from './materials.ts';
import { CARGO, FUEL_SHARE, cargoRoom, cargoUnitVolume } from './component-volume.ts';
import { shade } from './machine-art.ts';
import { fenderGroups, fenderLine, fenderOver } from './hull-details.ts';

// The pieces that carry a load, as they are painted: a hopper, a cistern and a supply piece, each seen from the side
// over the whole of its box — what is hit is what is drawn. They are painted in metres: a bolt, a rib, a rung, a can
// is as big on a long piece as on a short one, and a longer piece has more of them. A piece smaller than the one of
// the catalogue is a model of it, all of it smaller in the one measure. A piece within a compartment is machinery, in
// its olive, and is only seen cut open. One out in the open, on a bed or a roof, is a body of its construction: of steel
// in the paint of it, of another material bare, in the tone of that (render.ts `loadBody`); with an arch cut into its
// foot over each wheel that stands under it (`loadArches`). Seen cut open, the
// load shows through a cut in the side of a hopper and of a cistern; seen from outside their side is whole, and the
// load of a hopper shows as the heap over its rim (`heapOver`), on the last step. A supply piece has a closed side,
// cut open to reveal its crates and cans. They keep the one rule of the art of every piece (machine-art.ts): a
// side elevation, seen square on; the cut in a hopper and in a cistern is a section through its near side, and the far
// side shows through it as it stands.
export type CargoBodyKind = 'hopper' | 'cistern' | 'supply';
export interface CargoAxle { x: number; y: number; r: number }
export interface CargoLookObservation extends CargoRoomObservation { cargo?: CargoLoad | undefined }
export interface CargoLook { level: number; material: CargoKind | ''; fuel?: number }
export interface HeapLook { x0: number; x1: number; height: number; level: number; piece: XY }
type PileMaterial = Exclude<CargoKind, 'petroleo'>;
export interface PileLook { crates: PileMaterial[]; cans: number }
type DepositTone = (typeof DEPOSIT_TONES)[keyof typeof DEPOSIT_TONES];
type CargoTones = Record<keyof typeof TONES, string>;
type CargoDrawing = ReturnType<typeof drawing>;
interface PaintedCargoOptions extends ComponentArtOptions { steel: CargoTones; cut: boolean }
const crateLabels: Partial<Record<CargoKind | '', string>> = { ferro: 'FERRO', ligas: 'LIGAS', silica: 'SÍLICA' };
const depositTones: Partial<Record<string, DepositTone>> = DEPOSIT_TONES;
const TAU = Math.PI * 2;

// What a piece shows of its load: how full it is, in so many steps, and what most of it is. A picture is made for
// each step, not for each kilogram: any load at all shows the first. A supply piece tells its crates of materials
// (`level`, of the room they take) from its cans of fuel (`fuel`, of theirs).
export const CARGO_LEVELS = 4;
const NO_LOAD = Object.freeze({ level: 0, material: '' });
const step = (share: number) => share > 0 ? Math.min(CARGO_LEVELS, Math.max(1, Math.round(share * CARGO_LEVELS))) : 0;
export function cargoLook(module: CargoLookObservation, side?: 'inside' | 'outside'): CargoLook {
  // The closed supply side hides the load: unloading must not repaint that same panel.
  if (module.kind === 'supply' && side === 'outside') return NO_LOAD;
  const room = Number(cargoRoom(module)), supply = module.kind === 'supply';
  if (!(room > 0)) return NO_LOAD;
  let solid = 0, liquid = 0, material: CargoKind | '' = '', most = 0;
  for (const [key, units] of Object.entries(module.cargo || {})) {
    const name = key as CargoKind;
    const part = units * cargoUnitVolume(name);
    if (CARGO[name].liquid) liquid += part; else solid += part;
    if (part > most && !(supply && CARGO[name].liquid)) { most = part; material = name; }
  }
  if (!supply) { const level = step((solid + liquid) / room); return level ? { level, material } : NO_LOAD; }
  const level = step(solid / (room * (1 - FUEL_SHARE))), fuel = step(liquid / (room * FUEL_SHARE));
  return level || fuel ? { level, material: level ? material : '', fuel } : NO_LOAD;
}

// The picture of such a piece is as long and as tall as the piece, at this many pixels to the metre: fewer on a long
// one and more on a small one, within what a texture should hold.
const PIXELS_PER_METRE = 384;
export function cargoCanvasSize(widthM: number, heightM: number): XY {
  const width = Math.round(clamp(widthM * PIXELS_PER_METRE, 192, 1024));
  return [width, Math.max(16, Math.round(width * heightM / widthM))];
}

// `options`: the step of the load and what most of it is (`cargoLevel`, `cargoMaterial`, `cargoFuel`); for a piece out in
// the open, the paint of its construction (`paint`, a number) and the wheels it stands over (`arches`, as `loadArches`
// gives them, in the canonical frame of the picture); the side it is seen from (`side`: 'inside', cut open, or 'outside');
// and its final horizontal parity (`mirror`: 1 or -1), which counter-reflects only the lettering.
export function paintCargo(ctx: ArtContext, kind: CargoBodyKind, widthM: number, heightM: number, options: ComponentArtOptions = {}) {
  const art = drawing(ctx, widthM / ctx.canvas.width, options.mirror ?? 1, options.finish), model = Math.min(1, heightM / MODULES[kind].height),
    steel = options.paint === undefined ? STEEL : tones(options.paint);
  ctx.save(); ctx.scale(ctx.canvas.width / widthM, ctx.canvas.height / heightM);
  ({ hopper, cistern, supply })[kind](art, widthM, heightM, model, { ...options, steel, cut: options.side !== 'outside' });
  for (const arch of options.arches || []) wheelArch(art, widthM, heightM, arch, steel);
  ctx.restore();
}

const css = (tone: number) => '#' + tone.toString(16).padStart(6, '0');
// The tones of a sheet of steel in a paint, from the glint of its lit edge to the dark of its seams: each so far towards
// the pale of the light, or towards the black of a recess (machine-art.ts `shade`). A piece within a compartment is in
// the olive of the machinery (`STEEL`); one out in the open, in the paint of its construction.
const TONES = Object.freeze({ glint: .85, pale: .62, light: .5, lit: .4, edge: .3, face: .15, body: 0, mid: -.18, worn: -.34, dark: -.5,
  rivet: -.66, deep: -.72, line: -.86 });
// Each own catalogue key is mapped once to its CSS colour; no external keys enter this record.
const tones = (paint: number): CargoTones => Object.freeze(Object.fromEntries(Object.entries(TONES).map(([name, t]) => [name, shade(css(paint), t)]))) as CargoTones;
const STEEL = tones(0x67756a);

// The wheels a piece out in the open stands over, an arch cut into its foot for each fender over them, as a hull has
// (hull-details.ts): over each wheel or group of wheels under one fender (`fenderGroups`) the well behind it
// (`fenderOver`) reaches the foot of, beside the piece or under it. `axles` are all those of its chassis, in the frame
// of the picture of the piece: from its middle, up being up, each with the radius of its wheel (`r`); each arch is
// round the middle of the end axles of its group, half the way between them either way (`half`). They are to the
// millimetre, as pictures are told apart.
export function loadArches(widthM: number, heightM: number, axles: readonly CargoAxle[]) {
  const fix = (v: number) => Math.round(v * 1000) / 1000;
  return fenderGroups(axles).flatMap(({ x, y, r, half }) => {
    const { inner } = fenderOver(r);
    return Math.abs(x) - half - inner < widthM / 2 && y + inner > -heightM / 2 ? [{ x: fix(x), y: fix(y), r: fix(r), half: fix(half) }] : [];
  });
}
// The well behind the fender over a wheel or a group of wheels, round their axles, as a hull has it (hull-art.ts): as
// square as the fender and straight down at its sides, the dark of the box the tyres stand in, all but black up under
// the fender and a little lighter down towards the axles; its edge is behind the fender.
function wheelArch({ ctx, fall, finish }: Pick<CargoDrawing, 'ctx' | 'fall' | 'finish'>, W: number, H: number, { x, y, r, half }: CargoArch, steel: CargoTones) {
  const cx = W / 2 + x, cy = H / 2 - y, { inner, band, round } = fenderOver(r), reach = inner + band * .4,
    well = fenderLine(reach, -reach, round + band * .4, half).map(([u, v]): XY => [cx + u!, cy - v!]),
    trace = (surface: ArtContext) => { well.forEach(([px, py], i: number) => i ? surface.lineTo(px, py) : surface.moveTo(px, py)); surface.closePath(); };
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  ctx.beginPath(); trace(ctx); ctx.fillStyle = fall(cy - reach, cy, [[0, steel.line], [.6, steel.deep], [1, steel.rivet]]); ctx.fill();
  finish?.protect({ x: cx - half - reach, y: cy - reach, width: 2 * (half + reach), height: 2 * reach, path: trace });
  ctx.restore();
}

// What the three painters share, in metres; `px` is a pixel of the picture, the thinnest a line is drawn. `turn` is -1
// for a picture drawn turned about, its lettering read the right way all the same.
function drawing(ctx: ArtContext, px: number, turn: number = 1, finish: ArtFinish | null | undefined = null) {
  const thin = (width: number) => Math.max(width, px);
  const fall = (y0: number, y1: number, stops: readonly GradientStop[]) => { const g = ctx.createLinearGradient(0, y0, 0, y1); for (const [at, color] of stops) g.addColorStop(at, color); return g; };
  const sweep = (x0: number, x1: number, stops: readonly GradientStop[]) => { const g = ctx.createLinearGradient(x0, 0, x1, 0); for (const [at, color] of stops) g.addColorStop(at, color); return g; };
  const rect = (x: number, y: number, w: number, h: number, style: CanvasPaint) => { ctx.fillStyle = style; ctx.fillRect(x, y, w, h); };
  const box = (x: number, y: number, w: number, h: number, r: number, style: CanvasPaint, line?: CanvasPaint | null, lineWidth?: number) => {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); ctx.fillStyle = style; ctx.fill();
    if (line) { ctx.strokeStyle = line; ctx.lineWidth = thin(lineWidth!); ctx.stroke(); }
  };
  const frame = (x: number, y: number, w: number, h: number, r: number, style: CanvasPaint, width: number) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); ctx.strokeStyle = style; ctx.lineWidth = thin(width); ctx.stroke(); };
  const shape = (points: readonly XY[], style: CanvasPaint) => { ctx.beginPath(); points.forEach(([x, y], i: number) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fillStyle = style; ctx.fill(); };
  const line = (points: readonly XY[], style: CanvasPaint, width: number) => {
    ctx.beginPath(); points.forEach(([x, y], i: number) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = style; ctx.lineWidth = thin(width); ctx.stroke();
  };
  const disc = (x: number, y: number, r: number, style: CanvasPaint) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = style; ctx.fill(); };
  // A hex bolt head, lit from the upper left.
  const bolt = (x: number, y: number, r: number) => {
    disc(x + r * .2, y + r * .3, r * 1.35, '#14221dc0');
    const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    g.addColorStop(0, '#d0d2ba'); g.addColorStop(.45, '#929c86'); g.addColorStop(1, '#48574a');
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; i ? ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    ctx.closePath(); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = '#29392e'; ctx.lineWidth = thin(r * .18); ctx.stroke();
  };
  // A weld or a seam of sheet: a dark groove with the lit lip below or to the right of it.
  const seam = (x0: number, y0: number, x1: number, y1: number, width: number) => {
    const vertical = Math.abs(x1 - x0) < Math.abs(y1 - y0), dx = vertical ? width * 1.2 : 0, dy = vertical ? 0 : width * 1.2;
    line([[x0, y0], [x1, y1]], '#1d2e24c0', width); line([[x0 + dx, y0 + dy], [x1 + dx, y1 + dy]], '#c3cbae4d', width * .6);
  };
  // Stencilled lettering `size` metres tall, centred on `x`, narrowed to `room` if it is longer.
  const stencil = (text: string, x: number, y: number, size: number, color: CanvasPaint, room = Infinity) => {
    ctx.save(); ctx.font = '700 100px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const scale = size / 72, width = ctx.measureText(text).width * scale;
    ctx.translate(x, y); ctx.scale(turn * Math.min(scale, scale * Math.max(0, room) / width), scale); ctx.fillStyle = color; ctx.fillText(text, 0, 0); ctx.restore();
    const span = Math.min(width, room);
    finish?.protect({ x: x - span / 2, y: y - size * .8, width: span, height: size * 1.6 });
  };
  // Scratches and chips of paint, sparse and of their real size.
  const wear = (x: number, y: number, w: number, h: number, count: number, seed: number, k: number) => {
    const random = new Random(seed);
    for (let i = 0; i < count; i++) {
      const sx = x + random.range(0, w), sy = y + random.range(0, h), reach = random.range(.012, .05) * k;
      line([[sx, sy], [sx + reach, sy + random.range(-.004, .004) * k]], random.next() < .65 ? '#d3d5b838' : '#1a221c40', .0035 * k);
    }
  };
  return { ctx, px, thin, fall, sweep, rect, box, frame, shape, line, disc, bolt, seam, stencil, wear, finish };
}

// The bin of a hopper `W` by `H`, a model `k` of the one of the catalogue, in metres along from its rear and down from its
// top: the rail along its top, the sill along its foot, the tailgate at its rear, and the inside of the bin, from the
// tailgate to the front post (`rear` to `front`) and from the rail to its floor.
function bin(W: number, H: number, k: number) {
  const rail = .09 * k, sill = .095 * k, gate = .045 * k, floor = H - sill;
  return { rail, sill, gate, rear: gate + .05 * k, front: W - .07 * k, floor, inside: floor - rail };
}
// The crest of the heap of ore in a bin at a step of its load, by the share of the way from its rear wall to its front
// one, in metres down from the top of the hopper. The bin is filled to the depth of the step against its walls, and the
// grab that loads it heaps and levels it into a low crown along it, as a tipper is loaded: risen from each wall in a
// round shoulder no steeper than broken ore lies (`REPOSE`), and on in a gentle dome to the middle (`DOME`). The crown
// stands over the fill as deep as the rail and `CROWN` of the length of the bin besides, so that on the last step, filled
// to the foot of the rail, it shows over the rim along most of the bin, as low as that.
const CROWN = .06, DOME = .2, REPOSE = Math.tan(38 * Math.PI / 180);
function crest({ rail, rear, front, floor, inside }: Pick<ReturnType<typeof bin>, 'rail' | 'rear' | 'front' | 'floor' | 'inside'>, level: number) {
  const long = front - rear, fill = floor - inside * level / CARGO_LEVELS, crown = rail + CROWN * long,
    shoulder = Math.min(.45, crown * Math.PI / 2 / REPOSE / long);
  return (u: number) => fill - crown * Math.sin(Math.PI / 2 * Math.min(1, Math.min(u, 1 - u) / shoulder)) * (1 - DOME * (2 * u - 1) ** 2);
}
// A heap of ore in the tones of its vein (deposit-art.js) from `x0` to `x1`, its crest at `top(x)` and its foot at
// `foot`: lit at the top of its crown (`high`) and darkening gently down to the tone of the ore by `DUSK` under it, with a
// few small stones over it, each with its lit face up, and the light along its crest. It is painted in the tone of its
// ore and the light of it, and blends of the two: their hue is the ore's, which a hopper of another metal leaves as it is
// (`metalRgb`); a shade of grey laid over them, or the darker tone of some of the veins blended in, would take its hue.
const DUSK = .45;
function ore({ shape, line, fall }: Pick<CargoDrawing, 'shape' | 'line' | 'fall'>, tone: DepositTone, x0: number, x1: number, top: (x: number) => number, foot: number, high: number, k: number, seed: number) {
  const n = Math.max(8, Math.round((x1 - x0) / (.03 * k))), points: XY[] = [];
  for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n; points.push([x, top(x)]); }
  shape([[x0, foot], ...points, [x1, foot]], fall(high, high + DUSK * k, [[0, css(tone.light)], [1, css(tone.heap)]]));
  const random = new Random(seed), lump = .06 * k;
  for (let y = foot - lump * .5; y > high; y -= lump * 1.6)
    for (let x = x0 + random.range(0, lump * 2); x < x1; x += lump * random.range(2.2, 4.4)) {
      const r = lump * random.range(.12, .26), corners = 5 + Math.floor(random.next() * 3), turn = random.range(0, TAU),
        stone = Array.from({ length: corners }, (_, i: number): XY => { const a = turn + i * TAU / corners, d = r * random.range(.72, 1.15); return [x + Math.cos(a) * d * 1.2, y + Math.sin(a) * d * .78]; });
      if (y - r < top(x) + r * .6 || random.next() < .4) continue;
      shape(stone, css(tone.heap));
      shape(stone.map(([sx, sy]) => [x + (sx - x) * .62 - r * .18, y + (sy - y) * .5 - r * .3]), css(tone.light));
    }
  line(points, css(tone.light), .01 * k);
}

// The heap of a hopper over its rim at a step of its load, as a picture of its own laid on the top of the piece: from
// the rear wall of its bin to the front one (`x0` to `x1`, along its canonical picture) and as high over the top as its crest rises (`height`), in metres. None where the
// load stays within the rim, as it does on all but the last step. `piece` is the size of the hopper.
export function heapOver(widthM: number, heightM: number, level: number): HeapLook | null {
  const b = bin(widthM, heightM, Math.min(1, heightM / MODULES.hopper.height)), height = level > 0 ? -crest(b, level)(.5) : 0;
  if (!(height > .005)) return null;
  return { x0: b.rear, x1: b.front, height, level, piece: [widthM, heightM] };
}
// A heap of material on the shared field (server/field-construction.ts) — what came of a works given up, or of a
// structure taken down — lies on the ground as crates of its materials on a pallet, the cans of its fuel standing beside
// them: a crate more for each doubling of the materials from a thousand units, up to a stack of six, and a can more for
// each doubling of the fuel from 250 litres, up to a row of four (`pileLook`). The crates are shared out among the
// materials by how much there is of each, one at least for each while there are crates enough, and the most of it is
// lowest. Each is of its real size: the crates stand three, two and one high, the cans in a row.
const PILE = Object.freeze({ crate: [1.1, .55] satisfies XY, can: [.345, .47] satisfies XY, pallet: .12, gap: .04, crates: 6, cans: 4, rows: [3, 2, 1] });
const doublings = (units: number, from: number, most: number) => units >= 1 ? Math.min(most, 1 + Math.max(0, Math.floor(Math.log2(units / from)))) : 0;
export function pileLook(stock: Partial<SupplyBill>): PileLook {
  const kinds = (['ferro', 'ligas', 'silica'] satisfies PileMaterial[]).map(id => ({ id, units: Math.max(0, stock[id] || 0), n: 1 })).filter((kind) => kind.units >= 1)
      .sort((a, b) => b.units - a.units),
    count = doublings(kinds.reduce((sum, kind) => sum + kind.units, 0), 1000, PILE.crates), shown = kinds.slice(0, count);
  for (let left = count - shown.length; left > 0; left--) shown.reduce((best, kind) => kind.units / (kind.n + 1) > best.units / (best.n + 1) ? kind : best).n++;
  return { crates: shown.flatMap((kind) => new Array<PileMaterial>(kind.n).fill(kind.id)), cans: doublings(stock.combustivel || 0, 250, PILE.cans) };
}
// How many crates stand in each row of a pile, from the pallet up.
const pileRows = (count: number) => PILE.rows.map((most: number, i: number) => Math.max(0, Math.min(most, count - PILE.rows.slice(0, i).reduce((sum, n: number) => sum + n, 0)))).filter(Boolean);
// How wide and how tall a pile is, in metres, from the foot of its pallet: never narrower than a pallet for one crate.
export function pileSize({ crates, cans }: PileLook) {
  const [cw, ch] = PILE.crate, [aw, ah] = PILE.can, gap = PILE.gap, rows = pileRows(crates.length),
    crated = rows.length ? rows[0]! * (cw + gap) + gap : 0, canned = cans ? cans * (aw + gap) + gap : 0;
  return { width: Math.max(cw + 2 * gap, crated + canned), height: PILE.pallet + Math.max(rows.length * (ch + gap), cans ? ah + gap : 0, gap) };
}
// Its picture, at so many pixels to the metre as a texture should hold.
export function pileCanvasSize(look: PileLook): XY {
  const { width, height } = pileSize(look), pixels = Math.round(clamp(width * 256, 64, 1024));
  return [pixels, Math.max(16, Math.round(pixels * height / width))];
}
// The pallet of boards on its blocks, the crates stacked on it from the left, each row over the middle of the one under
// it, and the cans in a row to the right of them.
export function paintPile(ctx: ArtContext, look: PileLook) {
  const { width: W, height: H } = pileSize(look), [cw, ch] = PILE.crate, [aw, ah] = PILE.can, gap = PILE.gap, rows = pileRows(look.crates.length),
    deck = H - PILE.pallet, art = drawing(ctx, W / ctx.canvas.width);
  ctx.save(); ctx.scale(ctx.canvas.width / W, ctx.canvas.height / H);
  art.rect(0, deck, W, PILE.pallet * .4, art.fall(deck, deck + PILE.pallet * .4, [[0, '#9a8558'], [1, '#6e5d3c']]));
  art.line([[0, deck + PILE.pallet * .4], [W, deck + PILE.pallet * .4]], '#2a2216', .01);
  const blocks = Math.max(2, Math.round(W / .55));
  for (let i = 0; i < blocks; i++) art.box(i * (W - .14) / (blocks - 1), deck + PILE.pallet * .4, .14, PILE.pallet * .6, .01, '#5e4f33', '#241d12', .008);
  let next = 0;
  for (const [row, count] of rows.entries()) {
    const from = gap + (rows[0]! - count) * (cw + gap) / 2, y = deck - (row + 1) * (ch + gap);
    for (let i = 0; i < count; i++) crate(art, from + i * (cw + gap), y, cw, ch, 2, look.crates[next++]!);
  }
  const canned = rows.length ? rows[0]! * (cw + gap) + gap : 0;
  for (let i = 0; i < look.cans; i++) can(art, canned + gap + i * (aw + gap), deck - ah, aw, ah, 1);
  ctx.restore();
}
// Its picture is as fine as that of its hopper.
export function heapCanvasSize({ x0, x1, height, piece: [W, H] }: HeapLook): XY {
  const perMetre = cargoCanvasSize(W, H)[0] / W;
  return [Math.max(1, Math.round((x1 - x0) * perMetre)), Math.max(1, Math.round(height * perMetre))];
}
export function paintHeap(ctx: ArtContext, { x0, x1, height, level, piece: [W, H] }: HeapLook, material: CargoKind | '' | undefined) {
  const k = Math.min(1, H / MODULES.hopper.height), top = crest(bin(W, H, k), level), long = x1 - x0;
  ctx.save(); ctx.scale(ctx.canvas.width / long, ctx.canvas.height / height);
  ore(drawing(ctx, long / ctx.canvas.width), depositTones[material!] || DEPOSIT_TONES.ferro, 0, long, (x: number) => height + top(x / long), height, 0, k, 7001 + level);
  ctx.restore();
}

// A hopper: a tipper body of sheet steel seen from the side — a box-section rail along the top, a sill along the
// foot, upright stiffeners between them, the tailgate hung from its upper hinge at the rear (the left) and a heavier
// post at the front. Seen from outside its side is whole. Cut open, the side is cut away over the middle half of its
// length, from stiffener to stiffener: behind the cut the inside of the far wall, and the heap of ore at its step, in the
// tone of what most of it is.
function hopper(art: CargoDrawing, W: number, H: number, k: number, { cargoLevel: level = 0, cargoMaterial, steel, cut: open }: PaintedCargoOptions) {
  const { ctx, rect, box, frame, shape, line, fall, sweep, bolt, seam, disc } = art,
    { rail, sill, gate, rear, front, floor, inside } = bin(W, H, k), rib = .05 * k, bays = Math.max(2, Math.round((front - rear) / (.4 * k))),
    ribs = Array.from({ length: bays - 1 }, (_, i: number) => rear + (front - rear) * (i + 1) / bays),
    nearest = (x: number) => ribs.reduce((best, rib) => Math.abs(rib - x) < Math.abs(best - x) ? rib : best),
    // With a single stiffener the cut is the bay behind it; with more, from the one nearest a quarter of the length
    // to the one nearest three quarters.
    [cut0, cut1] = !open ? [0, 0] : ribs.length > 1 ? [nearest(W * .25) + rib / 2, nearest(W * .75) - rib / 2] : [rear + .02 * k, ribs[0]! - rib / 2];

  // The sheet of the side, lit from above, darker with the grime of the foot.
  box(0, 0, W, H, .012 * k, fall(0, H, [[0, steel.face], [.35, steel.body], [.8, steel.mid], [1, steel.dark]]));
  art.finish?.face({ x: 0, y: 0, width: W, height: H, radius: .012 * k }, { dirt: .2 });
  const edges = [rear, ...ribs, front];
  for (let i = 0; i + 1 < edges.length; i++) {
    // Each panel is pressed a little in: the shade of the rail over it and of the stiffener before it, and the
    // edge of the pressing, dark along its top and lit along its foot.
    const x0 = edges[i]!, x1 = edges[i + 1]!, inset = .04 * k;
    if (x1 - x0 > 3 * inset) {
      line([[x0 + inset, floor - inset], [x0 + inset, rail + inset], [x1 - inset, rail + inset]], '#101a1760', .008 * k);
      line([[x0 + inset, floor - inset], [x1 - inset, floor - inset], [x1 - inset, rail + inset]], '#c3cbae45', .006 * k);
    }
    rect(x0, rail, x1 - x0, .035 * k, fall(rail, rail + .035 * k, [[0, '#101a1770'], [1, '#101a1700']]));
    rect(x0, rail, .025 * k, inside, sweep(x0, x0 + .025 * k, [[0, '#101a1745'], [1, '#101a1700']]));
    rect(x0, floor - .07 * k, x1 - x0, .07 * k, fall(floor - .07 * k, floor, [[0, '#2a221800'], [1, '#2a221860']]));
  }
  art.wear(rear, rail, front - rear, inside, Math.round(W * 14 / k), 4127, k);

  if (open) {
    art.finish?.protect({ x: cut0, y: rail, width: cut1 - cut0, height: inside });
    // Through the cut: the far wall in the shade of the bin, the marks of the steps on it, and the heap.
    rect(cut0, rail, cut1 - cut0, inside, fall(rail, floor, [[0, '#1b2621'], [.3, '#2c3a33'], [.75, '#25312b'], [1, '#141d19']]));
    for (const x of ribs) if (x > cut0 && x < cut1) line([[x, rail], [x, floor]], '#46554b55', .012 * k);
    for (let s = 1; s < CARGO_LEVELS; s++) rect(cut0 + .015 * k, floor - inside * s / CARGO_LEVELS - .003 * k, .045 * k, .006 * k, '#d0cfb066');
    if (level > 0) {
      const top = crest({ rail, rear, front, floor, inside }, level);
      ctx.save(); ctx.beginPath(); ctx.rect(cut0, rail, cut1 - cut0, inside); ctx.clip();
      ore(art, depositTones[cargoMaterial!] || DEPOSIT_TONES.ferro, cut0, cut1, (x: number) => top((x - rear) / (front - rear)), floor, top(.5), k, 9001 + level);
      ctx.restore();
    }
    // The shade the rail throws inside, and the edge of the cut sheet.
    rect(cut0, rail, cut1 - cut0, .05 * k, fall(rail, rail + .05 * k, [[0, '#060c0a99'], [1, '#060c0a00']]));
    frame(cut0, rail, cut1 - cut0, inside, 0, '#c7cdb5a0', .006 * k);
  }

  // The stiffeners: channels pressed out of the side, widening into the rail and the sill. Those within the cut went with it.
  for (const x of ribs) {
    if (x > cut0 && x < cut1) continue;
    const flare = .018 * k, g = sweep(x - rib / 2, x + rib / 2, [[0, steel.lit], [.25, steel.face], [.7, steel.mid], [1, steel.deep]]);
    shape([[x - rib / 2 - flare, rail], [x + rib / 2 + flare, rail], [x + rib / 2, rail + .05 * k], [x + rib / 2, floor - .05 * k], [x + rib / 2 + flare, floor],
      [x - rib / 2 - flare, floor], [x - rib / 2, floor - .05 * k], [x - rib / 2, rail + .05 * k]], g);
    line([[x + rib / 2 + .004 * k, rail + .05 * k], [x + rib / 2 + .004 * k, floor - .05 * k]], '#101a1766', .007 * k);
  }
  // The rail along the top: a box section with its lit upper face and its lip.
  rect(0, 0, W, rail, fall(0, rail, [[0, steel.glint], [.12, steel.light], [.3, steel.face], [.85, steel.mid], [1, steel.dark]]));
  line([[0, rail], [W, rail]], steel.line, .008 * k);
  // The sill along the foot, with the pin the body tips on at the rear.
  rect(0, floor, W, sill, fall(floor, H, [[0, steel.edge], [.15, steel.body], [.7, steel.dark], [1, steel.deep]]));
  line([[0, floor], [W, floor]], steel.line, .008 * k);
  for (const x of edges) for (const y of [rail * .5, floor + sill * .5]) bolt(x + (x === rear ? .025 * k : x === front ? -.025 * k : 0), y, .011 * k);
  const pivot = rear + .1 * k, pin = floor + sill * .5;
  disc(pivot, pin, sill * .36, steel.line); disc(pivot, pin, sill * .28, sweep(pivot - sill * .3, pivot + sill * .3, [[0, steel.pale], [1, steel.worn]])); disc(pivot, pin, sill * .1, steel.line);
  // The front post, heavier, standing the whole height.
  rect(front, 0, W - front, H, sweep(front, W, [[0, steel.deep], [.12, steel.lit], [.4, steel.face], [1, steel.dark]]));
  seam(front + .014 * k, rail, front + .014 * k, floor, .006 * k);
  // The tailgate seen edge on, hung from the pin at its top and held by the hook at its foot.
  rect(0, 0, gate, H, sweep(0, gate, [[0, steel.dark], [.3, steel.face], [1, steel.mid]]));
  line([[gate, 0], [gate, H]], steel.line, .008 * k);
  box(gate * .1, rail * .15, gate * .8 + .03 * k, rail * 1.25, .006 * k, steel.mid, steel.line, .005 * k);
  disc(gate * .5 + .012 * k, rail * .75, rail * .3, steel.pale); disc(gate * .5 + .012 * k, rail * .75, rail * .13, steel.rivet);
  const hook = floor - .035 * k;
  shape([[gate * .2, hook - .03 * k], [gate + .035 * k, hook - .03 * k], [gate + .035 * k, hook + .03 * k], [gate * .2, hook + .012 * k]], steel.mid);
  line([[gate + .02 * k, hook], [gate + .085 * k, hook - .07 * k]], steel.rivet, .014 * k);
  disc(gate + .085 * k, hook - .07 * k, .011 * k, steel.lit);
  frame(0, 0, W, H, .012 * k, steel.line, .01 * k);
}

// How high a liquid stands in a lying round tank it fills to `share` of the volume, as a share of the tank's height.
function standing(share: number) {
  let low = 0, high = 1;
  for (let i = 0; i < 32; i++) {
    const h = (low + high) / 2, half = Math.acos(1 - 2 * h);
    if ((2 * half - Math.sin(2 * half)) / TAU < share) low = h; else high = h;
  }
  return (low + high) / 2;
}
// A lying tank's outline: straight along its top and its foot, its dished heads rounded into them.
function capsule(ctx: ArtContext, x: number, y: number, w: number, h: number, rx: number, ry: number) {
  ctx.beginPath(); ctx.moveTo(x + rx, y); ctx.lineTo(x + w - rx, y);
  ctx.ellipse(x + w - rx, y + ry, rx, ry, 0, -Math.PI / 2, 0); ctx.lineTo(x + w, y + h - ry);
  ctx.ellipse(x + w - rx, y + h - ry, rx, ry, 0, 0, Math.PI / 2); ctx.lineTo(x + rx, y + h);
  ctx.ellipse(x + rx, y + h - ry, rx, ry, 0, Math.PI / 2, Math.PI); ctx.lineTo(x, y + ry);
  ctx.ellipse(x + rx, y + ry, rx, ry, 0, Math.PI, Math.PI * 1.5); ctx.closePath();
}
// The cistern `W` by `H`, a model `k` of the one of the catalogue, in metres along from its rear and down from its top:
// the beam along its foot and the skid over it, the shell over them (`S` high, its heads rounded `rx` along and `ry`
// down), the top of the bolster of the skid at each end (`bolster`), the walkway along the top, and the ladder over the
// front head, its stiles `stile` wide from `x0` and to `x1`, standing from `high` down to the beam.
function tank(W: number, H: number, k: number) {
  const beam = .065 * k, skid = .055 * k, S = H - beam - skid, rx = Math.min(W * .14, S * .22), ry = S * .3, walk = .05 * k,
    ladder = .27 * k, x0 = W - rx - ladder * .35;
  return { beam, skid, S, rx, ry, foot: H - beam, bolster: S - ry * .75, walk, ladder, x0, x1: x0 + ladder, stile: .02 * k, high: walk * .4 };
}

// A cistern: a tank lying on its skid, seen from the side as a tanker's body is — the shell with its dished heads,
// the walkway along the top with the manholes in it, a ladder up the front, the outlet valve and its line under the
// rear, the orange panel of what it carries, and the sight glass that tells how high the petroleum stands in it, as
// high as it stands in a round tank so full (short of the room left for it to swell). Cut open, a cut in the side of
// the shell shows it standing there, beside the glass.
function cistern(art: CargoDrawing, W: number, H: number, k: number, { cargoLevel: level = 0, steel, cut: open }: PaintedCargoOptions) {
  const { ctx, rect, box, frame, shape, line, fall, sweep, bolt, seam, disc, stencil } = art,
    { beam, skid, S, rx, ry, foot, bolster, walk, ladder, x0, x1, stile, high } = tank(W, H, k),
    wall = .012 * k, straight = W - 2 * rx, bottom = S - wall, depth = S - 2 * wall,
    full = (s: number) => bottom - depth * standing(s / CARGO_LEVELS * .9);
  // Under the shell, between its foot and the beam, the shade of the skid; at each end the bolster of the skid rises
  // behind the lower bend of the head.
  rect(rx * .45, S - ry * .5, W - rx * .9, foot - S + ry * .5, '#111a15');
  for (const side of [1, -1]) {
    const end = side > 0 ? 0 : W, at = (x: number) => end + side * x;
    shape([[at(0), bolster], [at(rx * .9), bolster], [at(rx * 1.3), foot], [at(0), foot]], fall(bolster, foot, [[0, steel.face], [.4, steel.mid], [1, steel.dark]]));
    line([[at(0), bolster], [at(rx * .9), bolster]], steel.line, .008 * k);
    disc(at(rx * .3), S + skid * .2, Math.min(rx * .16, skid * .5), '#121b16');
    bolt(at(rx * .2), S - ry * .4, .01 * k);
  }
  // The shell, lit from above as a cylinder is.
  capsule(ctx, 0, 0, W, S, rx, ry);
  ctx.fillStyle = fall(0, S, [[0, steel.mid], [.05, steel.light], [.18, steel.edge], [.5, steel.body], [.82, steel.worn], [1, steel.rivet]]); ctx.fill();
  art.finish?.face({ x: 0, y: 0, width: W, height: S, path: (surface: ArtContext) => capsule(surface, 0, 0, W, S, rx, ry) });
  ctx.save(); capsule(ctx, 0, 0, W, S, rx, ry); ctx.clip();
  // The heads turn away from the light; the welds where they meet the shell, and between the shell's courses.
  rect(0, 0, rx * 1.1, S, sweep(0, rx * 1.1, [[0, '#0f1a1590'], [1, '#0f1a1500']]));
  rect(W - rx * 1.1, 0, rx * 1.1, S, sweep(W - rx * 1.1, W, [[0, '#0f1a1500'], [1, '#0f1a15a0']]));
  const courses = Math.floor(straight / (1.1 * k));
  for (const x of [rx, W - rx, ...Array.from({ length: courses }, (_, i: number) => rx + straight * (i + 1) / (courses + 1))]) seam(x, 0, x, S, .006 * k);
  art.wear(rx, walk, straight, S - walk, Math.round(W * 12 / k), 7331, k);
  ctx.restore();

  // A rail along the lower side of the shell, as tankers carry their hose in.
  const tube = .036 * k, rail = S * .76;
  line([[rx * .7, rail + tube * .25], [W - rx * .7, rail + tube * .25]], steel.line, tube * 1.2);
  line([[rx * .7, rail], [W - rx * .7, rail]], steel.mid, tube);
  line([[rx * .7, rail - tube * .25], [W - rx * .7, rail - tube * .25]], steel.pale + '88', tube * .25);
  // Along the straight of the shell: the orange panel at the rear, over the middle the cut of one cut open, the sight
  // glass after it; the ladder stands over the front head.
  const panel = .2 * k, gauge = .032 * k,
    from = rx + panel + .08 * k, to = W - rx - ladder * .35 - gauge - .1 * k,
    cw = Math.min(to - from, straight * .5), cx = (from + to - cw) / 2, cy = walk + .045 * k, ch = bottom - cy,
    round = .02 * k, surface = level > 0 ? full(level) : bottom;
  if (open) {
    art.finish?.protect({ x: cx, y: cy, width: cw, height: ch, radius: round });
    ctx.save(); ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, round); ctx.clip();
    // Inside: the far wall in the shade, bent away at its top and its foot, and the baffles across the tank edge on.
    rect(cx, cy, cw, ch, fall(cy, bottom, [[0, '#1d2722'], [.25, '#3f4c44'], [.6, '#4b584f'], [.85, '#36423b'], [1, '#1a231e']]));
    const baffles = Math.max(1, Math.round(cw / (.5 * k)));
    for (let i = 1; i < baffles; i++) { const x = cx + cw * i / baffles; rect(x - .012 * k, cy, .024 * k, ch, sweep(x - .012 * k, x + .012 * k, [[0, '#6b796e'], [1, '#2f3b34']])); }
    if (level > 0) {
      rect(cx, surface, cw, bottom - surface, css(DEPOSIT_TONES.petroleo.light));
      // Crude is black and brown where the light gets into it, under the bright line of its surface.
      rect(cx, surface, cw, Math.min(.14 * k, bottom - surface), fall(surface, surface + .14 * k, [[0, '#6a5838b0'], [.35, '#3a3024a0'], [1, '#3a302400']]));
      rect(cx, surface - .003 * k, cw, .006 * k, '#d6c9a0c0');
      for (let i = 0; i < 3; i++) rect(cx + cw * (.1 + i * .3), surface + (.04 + i * .025) * k, cw * .18, .004 * k, '#ffffff0d');
    }
    rect(cx, cy, cw, .04 * k, fall(cy, cy + .04 * k, [[0, '#050a0880'], [1, '#050a0800']]));
    ctx.restore();
    // The cut edge of the plate, and the marks of the steps beside it.
    frame(cx, cy, cw, ch, round, steel.line, .012 * k);
    frame(cx + .004 * k, cy + .004 * k, cw - .008 * k, ch - .008 * k, round, '#c3cbb2a0', .005 * k);
    for (let s = 1; s <= CARGO_LEVELS; s++) rect(cx - .03 * k, full(s) - .003 * k, .026 * k, .006 * k, '#d0cfb099');
  }
  // The sight glass: a tube in its guard, dark as high as the petroleum stands.
  const gx = cx + cw + .035 * k, glass = cy + .02 * k;
  art.finish?.protect({ x: gx, y: glass, width: gauge, height: bottom - .02 * k - glass });
  box(gx - .008 * k, cy, gauge + .016 * k, ch, .008 * k, steel.mid, steel.line, .005 * k);
  rect(gx, glass, gauge, bottom - .02 * k - glass, fall(cy, bottom, [[0, '#9fb7ae'], [1, '#6f8c84']]));
  if (level > 0) rect(gx, Math.max(glass, surface), gauge, bottom - .02 * k - Math.max(glass, surface), '#1f1e20');
  rect(gx + gauge * .2, glass, gauge * .18, bottom - .02 * k - glass, '#e7f2ec55');
  for (let s = 1; s <= CARGO_LEVELS; s++) rect(gx + gauge, full(s) - .002 * k, .014 * k, .004 * k, '#d0cfb0b0');
  bolt(gx + gauge / 2, cy + .004 * k, .009 * k); bolt(gx + gauge / 2, bottom - .006 * k, .009 * k);

  // The walkway along the top: a plate with its drain holes, broken by the manholes and their lids.
  rect(rx, 0, straight, walk, fall(0, walk, [[0, steel.glint], [.15, steel.light], [.5, steel.face], [1, steel.mid]]));
  line([[rx, walk], [W - rx, walk]], steel.line, .008 * k);
  for (let x = rx + .06 * k; x < W - rx - .03 * k; x += .12 * k) disc(x, walk * .55, .008 * k, steel.line);
  const manholes = Math.max(1, Math.round(straight / (1.3 * k))), lid = Math.min(.3 * k, straight / manholes * .45);
  for (let i = 0; i < manholes; i++) {
    const mx = rx + straight * (i + .5) / manholes;
    box(mx - lid / 2, 0, lid, walk + .028 * k, .006 * k, fall(0, walk + .028 * k, [[0, steel.pale], [.25, steel.face], [1, steel.dark]]), steel.line, .006 * k);
    rect(mx - lid / 2 - .01 * k, 0, lid + .02 * k, .014 * k, steel.edge);
    for (const side of [-1, 1]) { rect(mx + side * lid * .32 - .007 * k, .014 * k, .014 * k, .03 * k, steel.rivet); disc(mx + side * lid * .32, .016 * k, .011 * k, steel.lit); }
    disc(mx - lid / 2 + .02 * k, .03 * k, .013 * k, steel.pale); disc(mx - lid / 2 + .02 * k, .03 * k, .005 * k, steel.rivet);
  }
  // The orange panel of a dangerous load: the number of the danger over the number of crude petroleum.
  const ox = rx + .04 * k, oy = S * .48;
  art.finish?.protect({ x: ox, y: oy, width: panel, height: panel * .7, radius: .008 * k });
  box(ox, oy, panel, panel * .7, .008 * k, '#d9822b', '#151513', .009 * k);
  line([[ox, oy + panel * .35], [ox + panel, oy + panel * .35]], '#151513', .008 * k);
  stencil('33', ox + panel / 2, oy + panel * .18, panel * .2, '#151513', panel * .8);
  stencil('1267', ox + panel / 2, oy + panel * .53, panel * .2, '#151513', panel * .8);
  stencil('INFLAMÁVEL', ox + panel / 2, oy - .06 * k, .045 * k, '#d5d3b4', panel * 1.3);
  ctx.strokeStyle = steel.line; ctx.lineWidth = art.thin(.01 * k); capsule(ctx, 0, 0, W, S, rx, ry); ctx.stroke();

  // The skid: saddles under the middle of a long shell, the beam along the foot, the outlet valve at the rear and its line.
  const saddles = Math.max(0, Math.round(W / (1.2 * k)) - 1);
  for (let i = 0; i < saddles; i++) {
    const x = W * (i + 1) / (saddles + 1), w = .1 * k, top = S - .012 * k;
    shape([[x - w / 2, top], [x + w / 2, top], [x + w * .8, foot], [x - w * .8, foot]], fall(top, foot, [[0, steel.body], [1, steel.dark]]));
    rect(x - w / 2 - .01 * k, top - .006 * k, w + .02 * k, .014 * k, steel.line);
  }
  const pipe = Math.min(skid * .65, .045 * k), py = S + skid * .5, valve = rx + .1 * k;
  line([[.006 * k, py], [valve, py]], steel.line, pipe + .008 * k); line([[.006 * k, py], [valve, py]], steel.mid, pipe);
  line([[.006 * k, py - pipe * .25], [valve, py - pipe * .25]], steel.pale + '66', pipe * .22);
  box(0, py - pipe * .85, .028 * k, pipe * 1.7, .006 * k, steel.face, steel.line, .005 * k);
  box(valve - .03 * k, S - .02 * k, .06 * k, skid + .02 * k, .01 * k, fall(S, foot, [[0, steel.lit], [1, steel.dark]]), steel.line, .005 * k);
  line([[valve, S + skid * .35], [valve + .09 * k, S + skid * .1]], steel.rivet, .012 * k); disc(valve + .09 * k, S + skid * .1, .01 * k, '#c9a24a');
  rect(0, foot, W, beam, fall(foot, H, [[0, steel.light], [.12, steel.face], [.55, steel.mid], [1, steel.deep]]));
  art.finish?.face({ x: 0, y: foot, width: W, height: beam }, { dirt: .2 });
  line([[0, foot], [W, foot]], steel.line, .007 * k);
  const bolts = Math.max(2, Math.round(W / (.3 * k)));
  for (let i = 0; i < bolts; i++) bolt(.04 * k + (W - .08 * k) * i / (bolts - 1), foot + beam * .5, .01 * k);
  // The ladder up the front: two stiles from the beam to the walkway, held off the shell, rungs a step apart.
  for (const x of [x0, x1 - stile]) { rect(x, high, stile, foot - high, sweep(x, x + stile, [[0, steel.light], [1, steel.dark]])); line([[x + stile, high], [x + stile, foot]], '#101a1780', .006 * k); }
  for (let y = foot - .22 * k; y > high + .05 * k; y -= .26 * k) {
    rect(x0 + stile, y, x1 - x0 - 2 * stile, .018 * k, fall(y, y + .018 * k, [[0, steel.pale], [1, steel.worn]]));
    line([[x0 + stile, y + .022 * k], [x1 - stile, y + .022 * k]], '#101a1766', .005 * k);
  }
  for (const y of [high + .02 * k, S * .55]) for (const x of [x0, x1 - stile]) bolt(x + stile / 2, y, .009 * k);
}

// The outline of the picture of a piece that carries a load, `widthM` by `heightM` (silhouette.ts), in the frame of its
// polygon: from its middle, up being up. A hopper and a supply piece are painted over the whole of their box. A cistern
// is not: its heads are rounded clear of the upper corners and drawn in a little over the bolsters of its skid, and the
// stile of its ladder nearer the front stands up over the front head, cut where the picture ends. Its line goes round
// the shell, that stile and the bolsters as they are painted, and never out over a corner the picture leaves bare, where
// it would stand off the piece over whatever is behind. Its arcs are cut close enough that none of their sides falls a
// tenth of the line (`width`) inside them.
export function cargoOutline(kind: ModuleKind, widthM: number, heightM: number, width: number) {
  const W = widthM, H = heightM, at = ([x, y]: XY) => ({ x: x - W / 2, y: H / 2 - y });
  if (kind !== 'cistern') return ([[0, 0], [W, 0], [W, H], [0, H]] satisfies XY[]).map(at);
  const { S, rx, ry, bolster, x1, stile, high } = tank(W, H, Math.min(1, H / MODULES.cistern.height)),
    step = Math.sqrt(.8 * width / Math.max(rx, ry)), points: XY[] = [],
    arc = (cx: number, cy: number, from: number, to: number) => {
      const count = Math.max(1, Math.ceil(Math.abs(to - from) / step));
      for (let i = 0; i <= count; i++) { const a = from + (to - from) * i / count; points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    },
    // Where the front head is at `x` along it; the stile stands over it from where the head falls lower than its top
    // (`out`) to its far side or the end of the picture (`edge`).
    turn = (x: number) => TAU - Math.acos(clamp((x - W + rx) / rx, 0, 1)),
    edge = Math.min(W, x1), out = Math.max(x1 - stile, W - rx + rx * Math.sqrt(1 - (1 - high / ry) ** 2)),
    // How far round the lower bend of a head the bolster under it begins.
    dip = Math.asin((bolster - S + ry) / ry);
  arc(rx, ry, Math.PI, TAU * .75);
  if (out < edge) {
    arc(W - rx, ry, TAU * .75, turn(out)); points.push([out, high], [edge, high]);
    // A stile cut by the end of the picture stands along all its front side down to the beam, over the shell there.
    if (edge < W) arc(W - rx, ry, turn(edge), TAU);
  } else arc(W - rx, ry, TAU * .75, TAU);
  arc(W - rx, S - ry, 0, dip); points.push([W, bolster], [W, H], [0, H], [0, bolster]);
  arc(rx, S - ry, Math.PI - dip, Math.PI);
  return points.filter((p, i: number) => !i || Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1]) > 1e-9).map(at);
}

// A crate of materials, of olive-painted boards between end cleats, stencilled with its ore under a band of its colour.
function crate(art: CargoDrawing, x: number, y: number, w: number, h: number, k: number, material: CargoKind | '' | undefined) {
  const { rect, box, line, stencil } = art, cleat = Math.min(.05 * k, w * .12), tone = depositTones[material!] || DEPOSIT_TONES.ferro;
  box(x, y, w, h, .006 * k, art.fall(y, y + h, [[0, '#7d7c52'], [.2, '#6b6a45'], [1, '#4f4f33']]), '#262619', .006 * k);
  for (let b = 1; b < 3; b++) line([[x + cleat, y + h * b / 3], [x + w - cleat, y + h * b / 3]], '#3a3a2499', .004 * k);
  for (const cx of [x, x + w - cleat]) { rect(cx, y, cleat, h, '#5b5a3b'); line([[cx + cleat * .5, y + h * .4], [cx + cleat * .5, y + h * .6]], '#202014', .008 * k); }
  rect(x + cleat, y + h * .1, w - 2 * cleat, Math.min(.035 * k, h * .16), css(tone.plate));
  stencil(crateLabels[material!] || 'MATERIAIS', x + w / 2 + cleat * .3, y + h * .52, Math.min(.05 * k, h * .26), '#e1d8a8', w - 2 * cleat - .08 * k);
  line([[x + cleat + .015 * k, y + h * .8], [x + w * .45, y + h * .8]], '#d9d0a055', .008 * k);
}
// A can of fuel standing broadside: its cross pressed in, its three handles over it and its spout on the corner
// pressed off for it.
function can(art: CargoDrawing, x: number, y: number, w: number, h: number, k: number) {
  const { ctx, box, frame, shape, line, rect, disc } = art, r = .03 * k, rim = .03 * k, top = y + rim, foot = y + h, bevel = .055 * k, round = .014 * k,
    body = [[x + round, top], [x + w - bevel, top], [x + w, top + bevel], [x + w, foot - round], [x + w - round, foot], [x + round, foot], [x, foot - round], [x, top + round]] satisfies XY[];
  shape(body, art.fall(y, foot, [[0, '#6e7b55'], [.3, '#5a6745'], [1, '#3c4730']]));
  ctx.strokeStyle = '#1c2416'; ctx.lineWidth = art.thin(.006 * k); ctx.stroke();
  const ix = x + w * .14, iy = y + rim + h * .12, iw = w * .72, ih = h * .66;
  line([[ix, iy], [ix + iw, iy + ih]], '#8a9670', .02 * k); line([[ix, iy + ih], [ix + iw, iy]], '#8a9670', .02 * k);
  line([[ix + .006 * k, iy + .006 * k], [ix + iw + .006 * k, iy + ih + .006 * k]], '#2c3622', .01 * k);
  line([[ix + .006 * k, iy + ih + .006 * k], [ix + iw + .006 * k, iy + .006 * k]], '#2c3622', .01 * k);
  frame(x + .012 * k, y + rim + .012 * k, w - .024 * k, h - rim - .024 * k, r * .7, '#2c362299', .005 * k);
  for (let i = 0; i < 3; i++) { const hx = x + w * (.18 + i * .2); rect(hx, y + rim * .15, w * .14, rim * .5, '#4a5638'); rect(hx + w * .02, y + rim * .65, w * .1, rim * .35, '#11160d'); }
  rect(x + w * .16, y, w * .46, rim * .3, '#6e7b55');
  box(x + w - bevel - .01 * k, y + rim * .1, w * .17, rim * 1.2, .006 * k, '#4b5739', '#1c2416', .004 * k);
  disc(x + w - bevel - .01 * k + w * .085, y + rim * .5, .008 * k, '#9aa68f');
}

// A supply piece: a cage of steel tube on a deck, the far side of it mesh. On the left the crates of materials,
// stacked on a pallet and strapped down; on the right the cans of fuel standing on theirs in a rack, with a shelf of
// crates over them where there is room. A crate and a can are of their real size: a bigger cage holds more of them,
// and what it has given away leaves its place empty, from the top down.
function supply(art: CargoDrawing, W: number, H: number, k: number, { cargoLevel: level = 0, cargoMaterial, cargoFuel: fuel = 0, steel, cut }: PaintedCargoOptions) {
  const { ctx, rect, box, frame, line, fall, sweep, bolt, stencil } = art,
    top = .05 * k, deck = .07 * k, post = .045 * k, pallet = .1 * k, gap = .012 * k, floor = H - deck - pallet, ledge = .03 * k,
    canW = .345 * k, canH = .47 * k, crateH = .22 * k, crateW = .55 * k, room = floor - top - gap;
  if (!cut) {
    // A sheet side with access panels. This is artwork over the existing component, not added armour.
    rect(0, 0, W, H, fall(0, H, [[0, steel.light], [.12, steel.face], [.8, steel.mid], [1, steel.dark]]));
    art.finish?.face({ x: 0, y: 0, width: W, height: H });
    const panels = Math.max(1, Math.round(W / (.8 * k))), span = W / panels;
    for (let i = 0; i < panels; i++) {
      const x = i * span;
      frame(x + post, top + post, span - 2 * post, H - top - deck - 2 * post, .012 * k, steel.dark, .006 * k);
      for (const bx of [x + post * 1.5, x + span - post * 1.5]) for (const by of [top + post * 1.5, H - deck - post * 1.5]) bolt(bx, by, .009 * k);
      box(x + span / 2 - .04 * k, H * .5, .08 * k, .025 * k, .004 * k, steel.mid, steel.line, .005 * k);
    }
    rect(0, 0, W, top, steel.light); rect(0, H - deck, W, deck, steel.dark);
    stencil('SUPRIMENTOS', W / 2, H - deck / 2, deck * .42, '#d5d3b4', W - 2 * post);
    frame(0, 0, W, H, .01 * k, steel.line, .009 * k);
    return;
  }
  // The mesh of the far side, seen through the cage.
  rect(0, 0, W, H, '#18221d');
  ctx.save(); ctx.beginPath(); ctx.rect(post, top, W - 2 * post, H - deck - top); ctx.clip();
  ctx.strokeStyle = steel.dark; ctx.lineWidth = art.thin(.004 * k); ctx.beginPath();
  for (let d = -H; d < W + H; d += .06 * k) { ctx.moveTo(d, 0); ctx.lineTo(d + H, H); ctx.moveTo(d + H, 0); ctx.lineTo(d, H); }
  ctx.stroke(); ctx.restore();

  // How the inside is shared: as many cans abreast as take about two fifths of it, the crates in the rest.
  const inner = W - 2 * post, cans = Math.max(1, Math.round(inner * .45 / (canW + gap))), divider = .035 * k,
    canZone = Math.min(inner * .7, cans * (canW + gap) + gap), crateZone = inner - canZone - divider,
    columns = Math.max(1, Math.round(crateZone / crateW)), rows = Math.max(1, Math.round(room / crateH)),
    tiers = Math.max(1, Math.floor((room + gap) / (canH + ledge))), shelfRoom = room - tiers * (canH + ledge),
    shelfRows = shelfRoom > crateH * .6 ? Math.max(1, Math.round(shelfRoom / crateH)) : 0,
    shelfColumns = Math.max(1, Math.round(canZone / (crateW * .6))), x0 = post, x1 = post + crateZone + divider,
    shelf = top + gap + shelfRoom, slots: [number, number, number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) slots.push([x0 + crateZone * c / columns, floor - room * (r + 1) / rows, crateZone / columns, room / rows]);
  for (let r = 0; r < shelfRows; r++) for (let c = 0; c < shelfColumns; c++) slots.push([x1 + canZone * c / shelfColumns, shelf - shelfRoom * (r + 1) / shelfRows, canZone / shelfColumns, shelfRoom / shelfRows]);
  // What is left of the load sits lowest: the crates from the floor up, the cans from the lowest tier.
  slots.sort((a, b) => b[1] + b[3] - (a[1] + a[3]) || a[0] - b[0]);
  const used = slots.slice(0, level ? Math.max(1, Math.round(slots.length * level / CARGO_LEVELS)) : 0),
    held = fuel ? Math.max(1, Math.round(cans * tiers * fuel / CARGO_LEVELS)) : 0;

  // The pallets on the deck: boards on blocks, the dark between the blocks.
  for (const [px, pw] of [[x0, crateZone], [x1, canZone]] satisfies XY[]) {
    rect(px, floor, pw, pallet, '#0d1310');
    rect(px, floor, pw, pallet * .28, fall(floor, floor + pallet * .28, [[0, '#a8946a'], [1, '#7a6847']]));
    rect(px, H - deck - pallet * .2, pw, pallet * .2, '#6f5f41');
    const blocks = Math.max(2, Math.round(pw / (.38 * k)) + 1);
    for (let i = 0; i < blocks; i++) {
      const bx = px + (pw - .09 * k) * i / (blocks - 1);
      rect(bx, floor + pallet * .28, .09 * k, pallet * .52, '#8b7653'); line([[bx + .09 * k, floor + pallet * .28], [bx + .09 * k, floor + pallet * .8]], '#3a2f1e', .004 * k);
    }
  }
  for (const [x, y, w, h] of used) crate(art, x + gap / 2, y + gap / 2, w - gap, h - gap, k, cargoMaterial);
  // Two straps down each stack of crates, inside its cleats, over the highest one left, each with its ratchet.
  const strap = .035 * k;
  for (let c = 0; c < columns; c++) {
    const cx = x0 + crateZone * c / columns, cw = crateZone / columns, stack = used.filter(([x]) => Math.abs(x - cx) < 1e-9);
    if (!stack.length) continue;
    const high = Math.min(...stack.map(([, y]) => y)) + gap / 2;
    for (const sx of [cx + Math.min(.05 * k, cw * .12) + .015 * k, cx + cw - Math.min(.05 * k, cw * .12) - .015 * k - strap]) {
      rect(sx, high - .006 * k, strap, floor - high + .006 * k, sweep(sx, sx + strap, [[0, '#a69a62'], [1, '#7a7046']]));
      line([[sx, high], [sx, floor]], '#3c3620', .003 * k);
      box(sx - .006 * k, floor - .085 * k, strap + .012 * k, .05 * k, .005 * k, '#a9ad9c', '#2b3328', .004 * k);
    }
  }
  // The cans in their rack, tier over tier with a shelf over each, and a strap across each tier that holds any.
  const offset = (canZone - cans * (canW + gap) - gap) / 2;
  for (let t = 0; t < tiers; t++) {
    const base = floor - t * (canH + ledge), count = Math.min(cans, Math.max(0, held - t * cans)), band = base - canH * .45;
    for (let i = 0; i < count; i++) can(art, x1 + gap + offset + i * (canW + gap), base - canH, canW, canH, k);
    if (count) {
      rect(x1, band, canZone, strap, fall(band, band + strap, [[0, '#a69a62'], [1, '#7a7046']]));
      box(x1 + canZone * .5 - .03 * k, band - .008 * k, .06 * k, strap + .016 * k, .005 * k, '#a9ad9c', '#2b3328', .004 * k);
    }
    const over = base - canH - ledge;
    if (t < tiers - 1 || shelfRows) { rect(x1, over, canZone, ledge, fall(over, over + ledge, [[0, steel.light], [1, steel.dark]])); line([[x1, over + ledge], [x1 + canZone, over + ledge]], steel.line, .005 * k); }
  }

  // The cage: the posts at its ends and between the crates and the cans, the rail over them and the deck under all.
  const tube = (x: number, w: number) => {
    rect(x, 0, w, H, sweep(x, x + w, [[0, steel.lit], [.3, steel.face], [.75, steel.mid], [1, steel.deep]]));
    art.finish?.face({ x, y: 0, width: w, height: H });
    line([[x + w, top], [x + w, H - deck]], '#0b1410', .004 * k);
  };
  tube(0, post); tube(W - post, post); tube(x1 - divider, divider);
  rect(0, 0, W, top, fall(0, top, [[0, steel.glint], [.18, steel.light], [.5, steel.face], [1, steel.dark]]));
  art.finish?.face({ x: 0, y: 0, width: W, height: top });
  line([[post, top], [W - post, top]], steel.line, .006 * k);
  rect(0, H - deck, W, deck, fall(H - deck, H, [[0, steel.light], [.15, steel.face], [.6, steel.mid], [1, steel.deep]]));
  art.finish?.face({ x: 0, y: H - deck, width: W, height: deck }, { dirt: .2 });
  line([[0, H - deck], [W, H - deck]], steel.line, .007 * k);
  for (const x of [post / 2, x1 - divider / 2, W - post / 2]) { bolt(x, top / 2, .01 * k); bolt(x, H - deck / 2, .01 * k); }
  art.wear(0, 0, W, top, Math.round(W * 4 / k), 2203, k); art.wear(0, H - deck, W, deck, Math.round(W * 5 / k), 2207, k);
  stencil('SUPRIMENTOS', post + crateZone / 2, H - deck * .48, deck * .42, '#d5d3b4', crateZone * .8);
  frame(0, 0, W, H, .01 * k, steel.line, .009 * k);
}
