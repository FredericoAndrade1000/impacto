import type { ArtFinish, ComponentArtOptions, MachineCrop } from './vehicle-art-contract.ts';
import type { Point } from './math.ts';
import type { WeaponPreset } from './weapons.ts';
import type { ArtContext, CanvasPaint, GradientStop, XY } from './canvas-art.ts';
import { WEAPON_PRESETS, weaponOf } from './weapons.ts';
import { TOOL_POINT, FAR, bladeEdge } from './road-tools.ts';
import { RADAR_PEDESTAL_SHARE } from './combat-sensors.ts';

interface ArtBox { x: number; y: number; w: number; h: number }
interface RamEnds { top: Point; foot: Point }
export interface RamStages { barrel: number; shown: readonly number[]; most: number; hidden?: number }
interface ArtRam extends RamStages, RamEnds { widths: readonly [number, number, ...number[]] }
interface BladeEnd { x: number; foot: number; k: number }
export interface BladeRig {
  s: number; d: number; saddle: number; ball: Point & { r: number }; pin: Point;
  yoke: { rear: number; front: number; top: number; foot: number };
  circle: { rear: number; front: number; top: number; foot: number };
  board: { near: BladeEnd; far: BladeEnd; plate: number; knife: number; cut: number; thick: number; curl: number; heel: number; toe: number; foot: number };
  drive: { x: number; w: number; top: number }; lift: ArtRam; shift: ArtRam;
  hang?: { y: number; slope: number; half?: number; under(x: number): number; middle: number; clevis: number };
  parts: { neck: ArtBox; assembly: ArtBox };
}
export interface PaverRig {
  s: number; d: number; base: number; room: number; collar: number; armDepth: number;
  screed: { x0: number; x1: number; skid: number; top: number; foot: number; console: number };
  tow: Point; pin: Point; lift: ArtRam & { travel: number };
  conveyor: { x0: number; x1: number; top: number; r: number; y: number; pitch: number; slat: number };
  auger: Point & { r: number }; arm: { length: number; outer: number; inner: number; overlap: number };
  parts: { screed: ArtBox; auger: ArtBox; slide: ArtBox; arm: ArtBox };
}
export interface AerialFace { style: '' | 'face' | 'edge' | 'back'; light: number; corners: number[] }
export interface AerialSight { count: number; faces: AerialFace[] }

// The one rule of the art of every piece (here, and in cargo-art.ts, gear-art.ts and component-art.ts): a piece is drawn
// as a side elevation, what is seen looking square on at the vehicle's side, its length from left to right and up being
// up. A part whose axis runs along the vehicle or upright shows its profile: a shaft is a rectangle, a disc on it a thin
// slab, a cylinder lying lengthwise a rectangle shaded round. Only a part whose axis crosses the vehicle, towards the
// view, is a circle: a wheel, a sprocket and the drive out to it, a round shown by its base in a rack across the vehicle,
// a lens looking out sideways. No top faces, no three-quarter views, no lines that recede, nothing seen into; the light
// comes from above, and shading tells only what is round and what stands proud. A piece cut open is a section through it.
// Each piece keeps one real layout, and is drawn as that layout looks from the side.
//
// The engine, the ammunition, the command, the sensors, the two road machines and the thruster, painted in metres over the
// whole of their box: the box is the outline of the piece seen from the side, as solid as it is hit. A sensor, the blade
// of a grader and a thruster stand in the open, and fill their box by their own outline, from side to side and from foot
// to top: between their parts is the world behind them. What has a size of its own in the real thing — a bolt, a fin, a
// key, a round, a flange — keeps it on a piece of any size, and a bigger piece shows more of them instead of bigger ones;
// the masses the piece is made of (a block, a gearbox, a cabinet, a casing) are what grows with it.
const TAU = Math.PI * 2;
export const MACHINE_KINDS = new Set(['engine', 'ammo', 'command', 'sensor', 'blade', 'paver', 'thruster']);
// Road-machine artwork always faces +X. Its component pose reflects the complete picture and its moving parts.
export const FACED_KINDS = new Set(['blade', 'paver']);
// As fine as the closest view needs, within what a texture may hold; the canvas has the shape of the box. A part of a
// road machine painted on its own (`crop`, see paintMachine) is as fine as the picture of its whole box.
const DENSITY = 900, SIDE = [256, 1024] as const;
export const machineFineness = (widthM: number, heightM: number) => { const longest = Math.max(widthM, heightM); return Math.min(Math.max(DENSITY, SIDE[0] / longest), SIDE[1] / longest); };
export function machineCanvas(widthM: number, heightM: number, crop: MachineCrop | null = null): XY {
  const perMetre = crop ? machineFineness(crop.W, crop.H) : machineFineness(widthM, heightM);
  return [Math.max(1, Math.round(widthM * perMetre)), Math.max(1, Math.round(heightM * perMetre))];
}

export const OUTLINE = '#111c17', RECESS = '#141f1a', GLINT = '#d6ddbe';
const rgb = (hex: string) => [1, 3, 5].map((i: number) => parseInt(hex.slice(i, i + 2), 16));
// A tone lighter, towards the pale of a lit edge, or darker, towards the black of a recess: `t` from -1 to 1.
export function shade(hex: string, t: number) {
  const to = t > 0 ? [232, 236, 216] : [12, 20, 16], a = Math.abs(t);
  return '#' + rgb(hex).map((c, i: number) => Math.round(c + (to[i]! - c) * a).toString(16).padStart(2, '0')).join('');
}
const frac = (t: number) => t - Math.floor(t);
// How many things of a pitch fit along a length, and where the first starts for the lot to stand in the middle.
const spread = (length: number, pitch: number) => { const n = Math.max(0, Math.floor(length / pitch + 1e-9)); return { n, start: (length - n * pitch) / 2 }; };
// The same things drawn: `draw` is given the middle of each, from `from` on.
const along = (from: number, length: number, pitch: number, draw: (x: number, index: number) => void) => { const { n, start } = spread(length, pitch); for (let i = 0; i < n; i++) draw(from + start + (i + .5) * pitch, i); };

// What every piece here is drawn with, in metres; `hair(n)` is n pixels of the canvas, for lines that must not vanish.
// The fittings of a hull are drawn with it too (hull-art.ts), for the two to be of one hand.
export function kit(ctx: ArtContext, perMetre: number, finish: ArtFinish | null = null, protectedTubes = false) {
  const px = 1 / perMetre, hair = (n: number) => n * px;
  const path = (x: number, y: number, w: number, h: number, r = 0) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); };
  const shape = (points: readonly XY[]) => { ctx.beginPath(); for (const [x, y] of points) ctx.lineTo(x, y); ctx.closePath(); };
  const fill = (style: CanvasPaint) => { ctx.fillStyle = style; ctx.fill(); };
  const stroke = (style: CanvasPaint, width: number) => { ctx.strokeStyle = style; ctx.lineWidth = width; ctx.stroke(); };
  const gradient = (x0: number, y0: number, x1: number, y1: number, stops: readonly GradientStop[]) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); for (const [at, c] of stops) g.addColorStop(at, c); return g; };
  const radial = (x: number, y: number, r: number, stops: readonly GradientStop[], fx = x, fy = y) => { const g = ctx.createRadialGradient(fx, fy, 0, x, y, r); for (const [at, c] of stops) g.addColorStop(at, c); return g; };
  const circle = (x: number, y: number, r: number, style?: CanvasPaint | null, edge?: CanvasPaint | null, width = hair(1)) => {
    ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, TAU);
    if (style) fill(style);
    if (edge) stroke(edge, width);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, style: CanvasPaint, width: number) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); stroke(style, width); };
  const edge = Math.max(hair(1.2), .0028);
  // A housing: its face lit from above, a pale lip where the light takes its top edge, its foot in shadow.
  const housing = (x: number, y: number, w: number, h: number, base: string, r = .01) => {
    path(x, y, w, h, r);
    fill(gradient(0, y, 0, y + h, ([[0, shade(base, .3)], [Math.min(.3, .012 / h), base], [.6, base], [1, shade(base, -.4)]])));
    stroke(OUTLINE, edge);
    const lip = Math.max(hair(1.6), .0032), inset = Math.max(r, lip * 2);
    if (w > 2 * inset && h > 4 * lip) line(x + inset, y + lip, x + w - inset, y + lip, GLINT + '66', Math.max(hair(1), .0014));
    finish?.face({ x, y, width: w, height: h, radius: Math.min(r, w / 2, h / 2) });
  };
  // A pressed or cast rib: a groove and the light on its lower lip.
  const rib = (x0: number, y0: number, x1: number, y1: number, width = .003) => {
    line(x0, y0, x1, y1, '#0f1a15b0', Math.max(hair(1), width));
    const dx = x1 - x0, dy = y1 - y0, n = Math.hypot(dx, dy) || 1, off = Math.max(hair(1), width);
    line(x0 - dy / n * off, y0 + dx / n * off, x1 - dy / n * off, y1 + dx / n * off, '#b4bc9e48', Math.max(hair(.8), width * .5));
  };
  // A bolt seen end on, its shank across the vehicle: its hex head, and the shade round it.
  const bolt = (x: number, y: number, r = .007) => {
    circle(x + r * .2, y + r * .3, r * 1.3, '#0d1712b8');
    shape(Array.from({ length: 6 }, (_, k: number) => [x + Math.cos(k * Math.PI / 3 + Math.PI / 6) * r, y + Math.sin(k * Math.PI / 3 + Math.PI / 6) * r]));
    fill(gradient(x - r, y - r, x + r, y + r, ([[0, '#d0d2ba'], [.45, '#8f9a84'], [1, '#46554a']])));
    stroke('#26352b', Math.max(hair(.6), r * .14));
  };
  // A bolt whose shank lies in the plane of the view, along `axis` ('x' or 'y'): its head seen from the side, two of its
  // flats split by the edge between them.
  const stud = (x: number, y: number, r: number, axis: 'x' | 'y') => {
    const [w, h] = axis === 'x' ? [r * .9, r * 1.8] : [r * 1.8, r * .9];
    path(x - w / 2, y - h / 2, w, h, r * .12); fill(gradient(0, y - h / 2, 0, y + h / 2, ([[0, '#c4c7af'], [.5, '#7f8a74'], [1, '#3d4a40']])));
    stroke('#26352b', Math.max(hair(.6), r * .14));
    if (axis === 'x') line(x - w / 2, y, x + w / 2, y, '#26352b90', hair(.8)); else line(x, y - h / 2, x, y + h / 2, '#26352b90', hair(.8));
  };
  // A pipe or a hose along points, as thick as it is.
  const tube = (points: readonly XY[], d: number, color: CanvasPaint) => {
    const trace = (dy = 0) => { ctx.beginPath(); for (const [x, y] of points) ctx.lineTo(x, y + dy); };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    trace(); stroke(OUTLINE, d + edge * 1.4);
    trace(); stroke(color, d);
    trace(-d * .24); stroke(GLINT + '50', Math.max(hair(1), d * .2));
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    if (finish) for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1]!, [x1, y1] = points[i]!, gap = d / 2 + edge;
      if (protectedTubes) finish.protect({ x: Math.min(x0, x1) - gap, y: Math.min(y0, y1) - gap,
        width: Math.abs(x1 - x0) + 2 * gap, height: Math.abs(y1 - y0) + 2 * gap, radius: gap });
      else {
        ctx.save(); ctx.translate(x0, y0); ctx.rotate(Math.atan2(y1 - y0, x1 - x0));
        finish.face({ x: -d / 2, y: -d / 2, width: Math.hypot(x1 - x0, y1 - y0) + d, height: d, radius: d / 2 });
        ctx.restore();
      }
    }
  };
  // Lettering of a height in metres, narrowed to `max` wide; none at all where it would be too small to read.
  const label = (text: string, x: number, y: number, size: number, color: CanvasPaint, { align = 'left', weight = 700, max = Infinity }: { align?: CanvasTextAlign; weight?: number; max?: number } = {}) => {
    if (size * perMetre < 5) return;
    ctx.save(); ctx.translate(x, y); ctx.scale(px, px);
    ctx.font = `${weight} ${size * perMetre}px "Segoe UI", sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    const width = ctx.measureText(text).width * px;
    if (width > max) ctx.scale(max / width, 1);
    finish?.protect({ x: align === 'center' ? -width / px / 2 : align === 'right' ? -width / px : 0,
      y: -size / px, width: width / px, height: size / px * 1.25 });
    ctx.fillStyle = color; ctx.fillText(text, 0, 0); ctx.restore();
  };
  // A few fine scratches over a face, fewer than it could hold: wear reads as wear only while it is rare.
  const wear = (x: number, y: number, w: number, h: number, seed = 1) => {
    const n = Math.min(12, 1 + Math.round(w * h * 40));
    for (let i = 0; i < n; i++) {
      const u = frac(seed * .7548 + i * .6180), v = frac(seed * .5698 + i * .3819 + u * .5), long = .008 + frac(i * .73 + seed * .31) * .022;
      line(x + u * (w - long), y + v * h, x + u * (w - long) + long, y + v * h - long * .07, '#d3d5b82c', hair(.8));
    }
  };
  // The ground a piece with recesses is painted on: the box itself, with corners rounded no more than a cast part's.
  const underlay = (w: number, h: number) => { path(0, 0, w, h, Math.min(.012, w * .04, h * .04)); fill(RECESS); };
  return { ctx, hair, path, shape, fill, stroke, gradient, radial, circle, line, housing, rib, bolt, stud, tube, label, wear, underlay, edge, finish };
}

// A part painted on its own (`crop`) is the stretch of the picture of its box from `x`, `y` on, as the box is laid
// (`rear`), and as big as the canvas is given: the whole box is `W` by `H`.
export function paintMachine(ctx: ArtContext, kind: MachineKind, widthM: number, heightM: number, options: ComponentArtOptions = {}) {
  const { width, height } = ctx.canvas, sx = width / widthM, sy = height / heightM, crop = options.crop;
  ctx.save(); ctx.scale(sx, sy);
  if (crop) ctx.translate(-crop.x, -crop.y);
  PAINTERS[kind](kit(ctx, Math.min(sx, sy), options.finish, kind === 'engine' || kind === 'thruster' || kind === 'sensor' && options.sensorMode === 'radar'),
    crop ? crop.W : widthM, crop ? crop.H : heightM, options);
  ctx.restore();
}

// A power pack seen from its side, laid out as a tank's is (the Leopard 2's, the EuroPowerPack's): the engine lies
// lengthwise, its crankshaft along the vehicle, and drives the cross-drive gearbox at its end, which turns the drive out
// to the sprocket on either side. So the gearbox shows end on, and its output to the sprocket is a round flange — the one
// part of the pack whose axis crosses the vehicle —; all else shows its profile: the block, the bank of cylinders along it
// under one valve cover, the exhaust out of every head into the manifold under its heat shield, the turbocharger at the
// far end with its shaft along the engine and the stack up from it; over the gearbox and the block the radiator lying flat
// and the fans standing on it, over the turbocharger the air filter; all on the frame it is lifted out by.
function paintEngine(a: MachineKit, W: number, H: number) {
  const S = H / .64, skid = Math.max(.024, .07 * H), base = H - skid, top = .34 * H, gearW = .3 * W, gh = base - top, at = (f: number) => top + gh * f;
  a.underlay(W, H);
  // The frame, on rubber mounts.
  a.housing(0, base, W, skid, '#3e493a', .006);
  for (const u of [.12, .5, .88]) {
    const w = Math.min(.06, W * .08), x = u * W - w / 2;
    a.path(x, base + skid * .2, w, skid * .6, .004); a.fill('#1b211dcc');
    a.finish?.protect({ x, y: base + skid * .2, width: w, height: skid * .6, radius: .004 });
    a.bolt(x + w / 2, base + skid / 2, Math.min(.007, skid * .22));
  }
  // The turbocharger stands at the far end, and the stack rises beside it: they share out the rest of the length. Along
  // its shaft, from the block outwards: the turbine, the bearing housing, the compressor and the eye it draws air in by.
  const rT = Math.min(.14, Math.max(.03, .07 * S)), end = W - Math.min(.03, W * .03), eye = rT * .38, wheel = rT * .8, bearing = rT * .42,
    turbine = rT * .72, tx = end - eye - wheel - bearing - turbine, ty = at(.51), outlet = Math.min(.07, rT * .55), stackX = tx - outlet * .7,
    coolW = stackX - outlet / 2 - .006, filterX = stackX + outlet / 2 + .006;

  // The gearbox: its end, cast and ribbed, and low in it the output that drives the sprocket on this side.
  a.housing(0, top, gearW, gh, '#55614b', .014);
  along(.015, gearW - .03, .045, (x: number) => a.rib(x, top + .02, x, base - .015, .0035));
  const cx = gearW * .48, cy = at(.62), R = .3 * Math.min(gearW, gh);
  a.finish?.protectCircle(cx, cy, R * 1.1);
  a.circle(cx, cy, R * 1.1, '#24302ab0');
  a.circle(cx, cy, R, a.radial(cx, cy, R, ([[0, '#889477'], [.6, '#677457'], [1, '#3f4a35']]), cx - R * .3, cy - R * .35), OUTLINE, a.edge);
  const ring = R - Math.min(.014, R * .2), bolts = Math.max(6, Math.min(28, Math.round(TAU * ring / .045)));
  for (let i = 0; i < bolts; i++) a.bolt(cx + Math.cos(i * TAU / bolts) * ring, cy + Math.sin(i * TAU / bolts) * ring, Math.min(.0065, R * .1));
  a.circle(cx, cy, R * .45, a.radial(cx, cy, R * .45, ([[0, '#6f7a5f'], [1, '#3f4a36']])), OUTLINE, a.edge);
  a.bolt(cx, cy, Math.min(.009, R * .12));
  // A breather and the dipstick, in the yellow that finds it.
  a.tube(([[gearW * .2, top + .004], [gearW * .2, top + Math.min(.04, gh * .15)]]), .008, '#58665a');
  a.circle(gearW * .82, top + Math.min(.022, gh * .1), .0085, null, '#c9a43a', .0035);

  // The block, and the sump under it with the plug of its drain.
  const bx = gearW, bw = W - gearW;
  a.housing(bx, top, bw, gh, '#5c6952', .01);
  const sumpX = bx + .03, sumpW = bw - .05, sumpY = at(.74);
  a.housing(sumpX, sumpY, sumpW, base - sumpY, '#4f5b47', .012);
  a.finish?.face({ x: sumpX, y: sumpY, width: sumpW, height: base - sumpY, radius: .012 }, { chips: 0, rust: 0, dirt: .1, oil: .22 });
  along(sumpX + .01, sumpW - .02, .032, (x: number) => a.rib(x, sumpY + .014, x, base - .01, .003));
  a.bolt(sumpX + sumpW * .5, base - Math.min(.016, (base - sumpY) * .3), .008);
  // The bell of the flywheel, a flange seen edge on, bolted to the gearbox through its length.
  const bell = Math.max(.014, .022 * Math.sqrt(S)), stud = Math.min(.0055, bell * .3);
  a.housing(gearW - bell, top, bell, gh, '#4b5742', .004);
  along(top + .01, gh - .02, .055, (y: number) => a.stud(gearW + stud * .45, y, stud, 'x'));
  // The bank of cylinders along the block: a head over each, the joint between one and the next, its port and the branch
  // of the exhaust out of it; the core plug of each cylinder in the block below.
  const thermostat = Math.min(.06, bw * .09), first = bx + .012 + thermostat, run = stackX - outlet / 2 - .008 - first,
    count = Math.max(1, spread(run, .1).n), pitch = run / count, cover = Math.min(.06, gh * .16), coverY = top + .012,
    heads = coverY + cover, headH = at(.36) - heads, port = Math.min(.044, pitch * .4), branch = Math.min(.026, pitch * .22);
  a.housing(first, heads, run, headH, '#5f6c55', .006);
  for (let i = 0; i < count; i++) {
    const x = first + i * pitch, px = x + pitch * .55;
    if (i) a.rib(x, heads + .004, x, heads + headH - .004, .0025);
    a.circle(x + pitch / 2, at(.66), Math.min(.014, pitch * .12), '#3f4c41', '#9aa58a70', a.hair(1));
    a.tube(([[px, heads + headH * .55], [px, at(.42)], [px + pitch * .18, at(.47)]]), branch, '#8a7f6c');
    a.housing(px - port / 2, heads + headH * .35, port, Math.min(.02, headH * .45), '#6a6553', .003);
  }
  // The one valve cover over the bank, cast with two ribs along it, held down by two bolts a cylinder.
  a.housing(first, coverY, run, cover, '#6f7c63', Math.min(cover * .45, .02));
  for (const k of [.36, .62]) a.rib(first + .02, coverY + cover * k, first + run - .02, coverY + cover * k, .0025);
  for (let i = 0; i < count; i++) for (const u of [.25, .75]) a.bolt(first + (i + u) * pitch, coverY + cover * .84, Math.min(.0055, cover * .12));
  // The thermostat housing at the front of the bank, where the coolant comes back from the radiator.
  a.housing(bx + .006, coverY, thermostat, cover * .9, '#67745c', .008);
  a.bolt(bx + .006 + thermostat / 2, coverY + cover * .6, Math.min(.0065, thermostat * .15));
  // The heat shield over the exhaust manifold: polished, grooved round it, and darkened where it runs hottest.
  const shieldX = bx + .03, shieldY = at(.44), shieldH = at(.58) - shieldY, shieldW = tx + turbine * .4 - shieldX;
  a.path(shieldX, shieldY, shieldW, shieldH, .012);
  a.finish?.protect({ x: shieldX, y: shieldY, width: shieldW, height: shieldH, radius: .012 });
  a.fill(a.gradient(0, shieldY, 0, shieldY + shieldH, ([[0, '#c3c6b4'], [.35, '#a0a493'], [.8, '#727767'], [1, '#575c4e']])));
  a.stroke(OUTLINE, a.edge);
  along(shieldX + .01, shieldW - .02, .012, (x: number) => a.line(x, shieldY + .006, x, shieldY + shieldH - .006, '#4b5045a0', Math.max(a.hair(1), .0018)));
  // The oil filter can, standing, gripped by its flutes.
  const canW = Math.min(.07, bw * .1), canX = bx + .04, canY = shieldY + shieldH + .006, canH = Math.max(.02, sumpY - canY + Math.min(.05, gh * .1));
  a.housing(canX, canY, canW, canH, '#7a6f4a', .008);
  along(canX + .005, canW - .01, .009, (x: number) => a.rib(x, canY + .008, x, canY + canH - .008, .0018));

  // The radiator lying flat over the gearbox and the block, seen along its edge: its core between its two tanks, the bolts
  // of its frame along its foot.
  const radH = Math.max(.012, Math.min(.07, .05 * S)), radY = top - radH, tank = Math.min(.05, coolW * .08), core = coolW - 2 * tank;
  a.housing(0, radY, coolW, radH, '#4f5c46', .004);
  a.path(tank, radY + radH * .22, core, radH * .5, .002); a.fill('#18231d');
  a.finish?.protect({ x: tank, y: radY + radH * .22, width: core, height: radH * .5, radius: .002 });
  along(tank, core, .007, (x: number) => a.line(x, radY + radH * .22, x, radY + radH * .72, '#6f7f6c', Math.max(a.hair(.9), .0016)));
  along(tank, core, .1, (x: number) => a.bolt(x, radY + radH * .86, Math.min(.004, radH * .1)));
  for (const x of [tank, coolW - tank]) a.rib(x, radY + .003, x, top - .003, .003);
  // The fans standing on it side by side, their axes upright: each a drum of mesh under the lip it is rolled to, on the
  // ring of its foot bolted down to the radiator's frame.
  const gap = .014, fans = Math.max(1, Math.round(core / (.46 * S))), fw = (coolW - .012 - (fans - 1) * gap) / fans, lip = Math.min(.014, top * .08), ringY = radY - lip;
  for (let i = 0; i < fans; i++) {
    const fx = .006 + i * (fw + gap), body = ringY - lip;
    a.path(fx, lip, fw, body);
    a.finish?.protect({ x: fx, y: lip, width: fw, height: body });
    a.fill(a.gradient(fx, 0, fx + fw, 0, ([[0, '#252e24'], [.22, '#56634c'], [.5, '#7b886c'], [.78, '#56634c'], [1, '#252e24']]))); a.stroke(OUTLINE, a.edge);
    along(fx, fw, .012, (x: number) => a.line(x, lip + .002, x, ringY - .002, '#1d261c60', a.hair(1)));
    for (const k of [.34, .67]) { a.path(fx, lip + body * k - .003, fw, .006); a.fill('#4b5744'); }
    a.housing(fx - Math.min(lip * .4, gap * .3), 0, fw + Math.min(lip * .8, gap * .6), lip, '#7a876c', .004);
    a.housing(fx - Math.min(lip * .3, gap * .25), ringY, fw + Math.min(lip * .6, gap * .5), lip, '#4b5742', .002);
    along(fx, fw, .06, (x: number) => a.stud(x, ringY - .0025, .004, 'y'));
  }
  // The hose from the radiator down into the thermostat, clamped.
  const hose = Math.min(thermostat * .7, Math.max(.02, .034 * S)), hoseX = bx + .006 + thermostat / 2, hoseY = (top + coverY) / 2;
  a.tube(([[hoseX, top - radH * .5], [hoseX, coverY + .008]]), hose, '#323b35');
  a.path(hoseX - hose * .62, hoseY - .005, hose * 1.24, .01, .003); a.fill('#a9ab98'); a.stroke(OUTLINE, a.hair(1));

  // The air filter over the turbocharger: a pressed box with a plate and an over-centre clip at each end.
  const filterW = W - filterX;
  a.housing(filterX, 0, filterW, top, '#67755c', .012);
  along(.015, top - .03, .03, (y: number) => a.rib(filterX + .035, y, W - .035, y, .003));
  for (const x of [filterX + .008, W - .028]) {
    const clipH = Math.min(.05, top * .45), y = top / 2 - clipH / 2;
    a.housing(x, y, .02, clipH, '#4b5742', .004); a.line(x + .01, y + .006, x + .01, y + clipH - .006, '#c4c9ae90', Math.max(a.hair(1), .002));
  }
  const room = filterW - .07, plateW = Math.min(.13, room), plateH = Math.min(.04, top * .4);
  if (plateW > .04) {
    const px = filterX + .034 + (room - plateW) / 2, py = top / 2 - plateH / 2;
    a.finish?.protect({ x: px, y: py, width: plateW, height: plateH, radius: .003 });
    a.path(px, py, plateW, plateH, .003); a.fill('#c4c0a0'); a.stroke('#4b4c3d', a.hair(1));
    a.label('FILTRO DE AR', px + plateW / 2, py + plateH * .64, plateH * .42, '#2f3328', { align: 'center', max: plateW - .01 });
  }
  // The intake from the filter down onto the compressor's eye; the outlet of the turbine out along its shaft and up into
  // the stack through the bellows that lets it move.
  const cX = tx + turbine + bearing;
  a.finish?.protect({ x: tx, y: ty - rT, width: end - tx, height: 2 * rT, radius: .002 });
  a.tube(([[end - eye / 2, top - .004], [end - eye / 2, ty - rT * .3]]), Math.min(.08, rT * .6), '#5b6750');
  a.tube(([[tx + turbine * .3, ty], [stackX, ty], [stackX, 0]]), outlet, '#8a8e7c');
  for (let y = top - .01; y > top * .25; y -= .012) a.line(stackX - outlet / 2, y, stackX + outlet / 2, y, '#3f453a90', Math.max(a.hair(1), .002));
  // The turbocharger's housings, each round about the shaft and so a rounded slab from the side: the bearing housing with
  // the oil fed down into it and drained back to the sump, the turbine of iron browned by the heat, the compressor of
  // aluminium, the eye with the clamp of the intake round it.
  const slab = (x: number, w: number, h: number, stops: readonly GradientStop[]) => { a.path(x, ty - h / 2, w, h, Math.min(w * .45, h * .3)); a.fill(a.gradient(0, ty - h / 2, 0, ty + h / 2, stops)); a.stroke(OUTLINE, a.edge); };
  const oil = tx + turbine + bearing / 2, feed = Math.min(.008, rT * .1);
  a.tube(([[oil, ty], [oil, ty - rT * .95]]), feed, '#8b8f7d');
  a.tube(([[oil, ty], [oil, sumpY + .008]]), feed * 1.4, '#2c3229');
  slab(tx + turbine - .002, bearing + .004, rT * .75, ([[0, '#8d977f'], [1, '#454e40']]));
  slab(tx, turbine, rT * 1.8, ([[0, '#8a7458'], [.3, '#6d5c45'], [1, '#3a3127']]));
  slab(cX, wheel, rT * 2, ([[0, '#bfc3b0'], [.3, '#9da290'], [1, '#5c6252']]));
  slab(end - eye, eye, rT, ([[0, '#c3c7b6'], [1, '#6c7263']]));
  a.path(end - eye * .6, ty - rT * .54, eye * .28, rT * 1.08, .002); a.fill('#4a4f45');
  for (const x of [tx + turbine, cX]) a.line(x, ty - rT * .4, x, ty + rT * .4, '#d6d8c560', a.hair(1));
  a.wear(0, top, gearW, gh, 3); a.wear(bx, at(.62), bw, gh * .12, 5); a.wear(filterX, 0, filterW, top, 7);
}

// The rounds a rack holds, by the family of the gun they are for, at their size: a cannon's stub bases end-on in a plate,
// a howitzer's projectiles standing in a cradle, a mortar's bombs lying in their rack, launch tubes end-on, and the belts
// of the automatic guns in their cans, stacked. The rack is seen square on: its uprights and its rails over the plate it
// is built on, and what it holds in front of that plate. Only a rack too small to hold one at its size shows a smaller one.
const racks: Partial<Record<WeaponPreset["family"], typeof canStack>> = { cannon: cannonRack, rocket: tubeRack, mortar: bombRack, howitzer: shellCradle };
function paintAmmo(a: MachineKit, W: number, H: number, options: ComponentArtOptions) {
  const preset = weaponOf(options.ammoPreset) || WEAPON_PRESETS.rh120, calibre = preset.caliberMm / 1000;
  const post = Math.max(.012, Math.min(.024, Math.min(W, H) * .04)), foot = Math.max(post, Math.min(.034, H * .07));
  // The plate, flat against the wall the rack stands by.
  a.path(0, 0, W, H, .01); a.fill(a.gradient(0, 0, 0, H, ([[0, '#47533f'], [1, '#353f31']]))); a.stroke(OUTLINE, a.edge);
  a.finish?.face({ x: 0, y: 0, width: W, height: H, radius: .01 });
  const ix = post, iy = post, iw = W - 2 * post, ih = H - post - foot;
  along(iy, ih, .12, (y: number) => { for (const x of [ix + .008, ix + iw - .008]) a.circle(x, y, .0028, '#262f27'); });
  const pad = .006, contents = racks[preset.family] || canStack;
  if (contents !== canStack) a.finish?.protect({ x: ix + pad, y: iy + pad, width: iw - 2 * pad, height: ih - 2 * pad });
  contents(a, ix + pad, iy + pad, iw - 2 * pad, ih - 2 * pad, calibre, preset);
  // The uprights at its ends, the rail along its top and the one along its foot, bolted where they meet; the placard on
  // the foot.
  for (const x of [0, W - post]) a.housing(x, 0, post, H, '#56634a', .006);
  a.housing(post, 0, iw, post, '#5b6850', .004);
  a.housing(post, H - foot, iw, foot, '#56634a', .004);
  for (const x of [post / 2, W - post / 2]) for (const y of [post / 2, H - foot / 2]) a.bolt(x, y, Math.min(.006, post * .25));
  const textH = Math.min(.016, foot * .55), diamond = foot * .32, wide = W > .25, mid = H - foot / 2;
  if (wide) {
    const dx = ix + diamond + .006;
    a.finish?.protect({ x: dx - diamond, y: mid - diamond, width: 2 * diamond, height: 2 * diamond });
    a.shape(([[dx, mid - diamond], [dx + diamond, mid], [dx, mid + diamond], [dx - diamond, mid]])); a.fill('#d07a2a'); a.stroke('#1b1a12', a.hair(1));
  }
  a.label('MUNIÇÃO', wide ? ix + diamond * 2 + .014 : W / 2, mid + textH * .36, textH, '#d2cfa8', { align: wide ? 'left' : 'center', max: iw * .6 });
  a.wear(0, 0, W, post, 11); a.wear(0, H - foot, W, foot, 13);
}
// A cannon's rounds lie across the vehicle: their stub bases, with the primer, in a plate that holds them in rows.
function cannonRack(a: MachineKit, x: number, y: number, w: number, h: number, calibre: number) {
  endOnRack(a, x, y, w, h, calibre * 1.25, true, (cx, cy, r: number) => {
    a.circle(cx, cy, r, a.radial(cx, cy, r, ([[0, '#a4a690'], [.55, '#7b8170'], [.85, '#5a604f'], [1, '#383e33']]), cx - r * .35, cy - r * .4), OUTLINE, a.edge);
    a.circle(cx, cy, r * .8, null, '#2d3329b0', Math.max(a.hair(1), r * .05));
    a.circle(cx, cy, Math.min(.012, r * .2), a.radial(cx, cy, .012, ([[0, '#e7d59a'], [1, '#9b8248']])), '#3b3420', a.hair(1));
    a.ctx.beginPath(); a.ctx.arc(cx, cy, r * .9, Math.PI * 1.1, Math.PI * 1.45); a.stroke('#e2e4d070', Math.max(a.hair(1), r * .06));
  });
}
// Launch tubes, stacked square, each closed by its end cap and its pull tab.
function tubeRack(a: MachineKit, x: number, y: number, w: number, h: number, calibre: number) {
  endOnRack(a, x, y, w, h, calibre * 1.22, false, (cx, cy, r: number) => {
    a.circle(cx, cy, r, a.radial(cx, cy, r, ([[0, '#7a8a5c'], [.8, '#56653f'], [1, '#34402a']]), cx - r * .3, cy - r * .35), OUTLINE, a.edge);
    a.circle(cx, cy, r * .78, a.radial(cx, cy, r * .78, ([[0, '#3a4036'], [1, '#191d18']]), cx - r * .2, cy - r * .3), '#0c0f0c', a.hair(1));
    a.path(cx - r * .09, cy - r * .5, r * .18, r * .34, r * .05); a.fill('#c2a54e');
    a.circle(cx, cy, Math.min(.008, r * .14), '#5e6655');
  });
}
// Round things seen end-on, as many as fit at their diameter — in staggered rows when `nested` — on the plate behind them.
function endOnRack(a: MachineKit, x: number, y: number, w: number, h: number, diameter: number, nested: boolean, draw: (x: number, y: number, r: number) => void) {
  const gap = .016, d = Math.min(diameter, Math.min(w, h) - gap), pitch = d + gap,
    rowPitch = nested ? pitch * .866 : pitch, rows = Math.max(1, Math.floor((h - pitch) / rowPitch + 1e-9) + 1),
    cols = Math.max(1, Math.floor(w / pitch + 1e-9)), stagger = nested && cols > 1 && rows > 1,
    top = y + (h - (pitch + (rows - 1) * rowPitch)) / 2;
  a.path(x, y, w, h, .006); a.fill(a.gradient(0, y, 0, y + h, ([[0, '#53624d'], [1, '#3b4838']])));
  for (let row = 0; row < rows; row++) {
    const n = stagger && row % 2 ? cols - 1 : cols, left = x + (w - n * pitch) / 2;
    for (let i = 0; i < n; i++) {
      const cx = left + (i + .5) * pitch, cy = top + pitch / 2 + row * rowPitch;
      a.circle(cx, cy, d / 2 + gap * .3, '#0a110d', '#a2ae9030', a.hair(1));
      draw(cx, cy, d / 2);
    }
  }
}
// A howitzer's projectiles standing nose up in their cradles, tier over tier and strapped at the waist, and in the height
// left over more of them lying on rails.
function shellCradle(a: MachineKit, x: number, y: number, w: number, h: number, calibre: number) {
  const gap = .018, fit = Math.min(1, (h - .02) / (calibre * 4.6), (w - gap) / calibre), d = calibre * fit, length = calibre * 4.6 * fit,
    tiers = Math.max(1, Math.floor(h / (length + .03))), standing = tiers * (length + .03), lying = spread(h - standing, d + .02),
    tier = (h - lying.n * (d + .02)) / tiers, below = y + h - tiers * tier;
  for (let t = 0; t < tiers; t++) {
    const foot = below + (t + 1) * tier - .004, cradle = Math.min(.03, tier * .12), { n, start } = spread(w, d + gap);
    a.path(x, foot - cradle, w, cradle + .004, .004); a.fill('#4a5643');
    for (let i = 0; i < Math.max(1, n); i++) shell(a, x + (n ? start : (w - d - gap) / 2) + (i + .5) * (d + gap), foot, 0, d / 2, length);
    const strap = Math.min(.016, length * .05), strapY = foot - length * .4, buckle = Math.min(.03, w * .1);
    a.path(x, strapY, w, strap, .002); a.fill('#3d4a35'); a.stroke(OUTLINE, a.hair(1));
    a.path(x + w / 2 - buckle / 2, strapY - .003, buckle, strap + .006, .003); a.fill('#9a9f88'); a.stroke(OUTLINE, a.hair(1));
  }
  const { n, start } = spread(w, length + .03);
  for (let row = 0; row < lying.n; row++) {
    const cy = below - (row + .5) * (d + .02);
    a.path(x, cy + d / 2 + .002, w, .006, .002); a.fill('#4e5b46');
    for (let i = 0; i < n; i++) shell(a, x + start + i * (length + .03) + .015, cy, Math.PI / 2, d / 2, length);
  }
}
// One projectile, its base at (x, y) and its nose along `turn` from straight up: the rotating band in copper near the base,
// the yellow band of the explosive, the lifting plug in the fuze's place.
function shell(a: MachineKit, x: number, y: number, turn: number, r: number, length: number) {
  const { ctx } = a, at = (f: number) => -length * f;
  ctx.save(); ctx.translate(x, y); ctx.rotate(turn);
  ctx.beginPath(); ctx.moveTo(-r * .94, at(0)); ctx.lineTo(-r, at(.05)); ctx.lineTo(-r, at(.6));
  ctx.quadraticCurveTo(-r, at(.82), -r * .3, at(.92)); ctx.lineTo(r * .3, at(.92));
  ctx.quadraticCurveTo(r, at(.82), r, at(.6)); ctx.lineTo(r, at(.05)); ctx.lineTo(r * .94, at(0)); ctx.closePath();
  a.fill(a.gradient(-r, 0, r, 0, ([[0, '#2f351f'], [.3, '#6f7a4b'], [.45, '#5d6840'], [1, '#262c1a']]))); a.stroke(OUTLINE, a.edge);
  a.path(-r * 1.02, at(.15), r * 2.04, length * .035, length * .01); a.fill(a.gradient(-r, 0, r, 0, ([[0, '#5e3a24'], [.35, '#b47a4c'], [1, '#4a2c1b']])));
  a.path(-r * .97, at(.66), r * 1.94, length * .03); a.fill('#c9ad44c8');
  a.path(-r * .3, at(1), r * .6, length * .08, r * .1); a.fill(a.gradient(-r * .3, 0, r * .3, 0, ([[0, '#5d6253'], [.4, '#a5aa98'], [1, '#4b5044']])));
  a.stroke(OUTLINE, a.hair(1));
  ctx.restore();
}
// A mortar's bombs lying in rows on their rack: the tail with its fins, the body with the yellow band, the fuze.
function bombRack(a: MachineKit, x: number, y: number, w: number, h: number, calibre: number) {
  const fit = Math.min(1, (w - .01) / (calibre * 6.3), (h - .01) / (calibre + .02)), d = calibre * fit, length = calibre * 6.3 * fit, r = d / 2,
    rows = spread(h, d + .022), cols = spread(w, length + .016);
  for (let row = 0; row < Math.max(1, rows.n); row++) {
    const cy = y + rows.start + (row + .5) * (d + .022);
    a.path(x, cy + r + .002, w, .006, .002); a.fill('#4e5b46');
    for (let col = 0; col < Math.max(1, cols.n); col++) {
      const x0 = x + cols.start + col * (length + .016) + .008, at = (f: number) => x0 + length * f;
      for (const s of [-1, 1]) { a.shape(([[at(0), cy + s * r * .9], [at(.17), cy + s * r * .9], [at(.24), cy + s * r * .2], [at(0), cy + s * r * .2]])); a.fill('#7f8572'); a.stroke(OUTLINE, a.hair(1)); }
      a.path(at(0), cy - r * .2, length * .36, r * .4); a.fill(a.gradient(0, cy - r * .2, 0, cy + r * .2, ([[0, '#a3a893'], [1, '#4d5246']]))); a.stroke(OUTLINE, a.hair(1));
      a.ctx.beginPath(); a.ctx.moveTo(at(.3), cy - r * .3); a.ctx.quadraticCurveTo(at(.4), cy - r, at(.55), cy - r);
      a.ctx.quadraticCurveTo(at(.8), cy - r, at(.88), cy - r * .32); a.ctx.lineTo(at(.88), cy + r * .32);
      a.ctx.quadraticCurveTo(at(.8), cy + r, at(.55), cy + r); a.ctx.quadraticCurveTo(at(.4), cy + r, at(.3), cy + r * .3); a.ctx.closePath();
      a.fill(a.gradient(0, cy - r, 0, cy + r, ([[0, '#2f351f'], [.28, '#717c4c'], [.5, '#5b663f'], [1, '#262c1a']]))); a.stroke(OUTLINE, a.edge);
      a.path(at(.6), cy - r * .97, length * .03, r * 1.94); a.fill('#c9ad44c8');
      a.shape(([[at(.88), cy - r * .32], [at(1), cy - r * .08], [at(1), cy + r * .08], [at(.88), cy + r * .32]]));
      a.fill(a.gradient(0, cy - r * .3, 0, cy + r * .3, ([[0, '#e1cf92'], [1, '#8b7742']]))); a.stroke(OUTLINE, a.hair(1));
    }
  }
}
// The belts of the automatic guns, folded in their cans, the cans stacked up from the floor of the rack. Each shows its
// long side: the lid a little proud of the body, the handle folded flat on it and seen edge on, the knuckle of the hinge
// at one end — its pin across the can, the one round thing on it — and the lever of the latch down the other, the band of
// paint that marks the rounds, and what it holds stencilled on its side.
function canStack(a: MachineKit, x: number, y: number, w: number, h: number, calibre: number, preset: WeaponPreset) {
  const heavy = preset.family !== 'machinegun', floor = .01, grip = .006, gap = .012, rough = heavy ? .3 + calibre * 5 : .2 + calibre * 8, ratio = heavy ? .58 : .6,
    fit = Math.min(1, (w - gap) / rough, (h - floor - grip - .002) / (rough * ratio)), length = rough * fit, tall = length * ratio, step = tall + grip + .002,
    rows = Math.max(1, spread(h - floor, step).n), cols = spread(w, length + gap), bottom = y + h - floor, text = `${String(preset.caliberMm).replace('.', ',')} mm`;
  a.housing(x, bottom, w, floor, '#4d5c47', .002);
  const lid = tall * .14, lip = Math.min(.004, length * .012), handle = length * .42, ear = Math.min(.006, handle * .06), knuckle = Math.min(.005, lid * .3),
    latch = Math.min(.008, length * .03), band = Math.min(.03, length * .08), size = Math.min(.022, tall * .15);
  for (let row = 0; row < rows; row++) {
    const top = bottom - (row + 1) * step + grip + .002;
    for (let col = 0; col < Math.max(1, cols.n); col++) {
      const left = x + cols.start + col * (length + gap) + gap / 2, hx = left + (length - handle) / 2;
      a.housing(left, top + lid, length, tall - lid, '#575d33', .004);
      a.housing(left - lip, top, length + 2 * lip, lid, '#5f6538', .003);
      for (const ex of [hx, hx + handle - ear]) { a.path(ex, top - grip * .7, ear, grip * .7 + .001, .001); a.fill('#3a4427'); }
      a.path(hx - ear, top - grip, handle + 2 * ear, Math.max(.0025, grip * .4), .002); a.fill('#4a5532'); a.stroke(OUTLINE, a.hair(1));
      a.circle(left - lip + knuckle * .3, top + lid * .55, knuckle, '#5d6338', OUTLINE, a.hair(1));
      a.housing(left + length - latch * .4, top + lid * .25, latch, tall * .55, '#474c2a', .002);
      a.path(left + length - latch - .006 - band, top + lid + .004, band, tall - lid - .008); a.fill('#c9ad3ccc');
      a.finish?.protect({ x: left + length - latch - .006 - band, y: top + lid + .004, width: band, height: tall - lid - .008 });
      a.path(left + .012, top + lid + .01, length - band - latch - .03, tall - lid - .02, .006); a.stroke('#2a331bb0', Math.max(a.hair(1), .002));
      const middle = left + (length - band - latch) / 2, face = tall - lid;
      a.label('CARTUCHOS', middle, top + lid + face * .42, size * .7, '#d4bd5e', { align: 'center', max: length * .5 });
      a.label(text, middle, top + lid + face * .7, size, '#d4bd5e', { align: 'center', max: length * .5 });
    }
  }
}

// Command D: a low sealed computer with four mounting ears, a small display above its heat sink and a service panel.
// The face is square on; its two traces are abstract, with no lettering or simulated operational state.
function paintCommand(a: MachineKit, W: number, H: number) {
  const chamfer = (x: number, y: number, w: number, h: number, cut: number) => a.shape(([[x + cut, y], [x + w - cut, y], [x + w, y + cut],
    [x + w, y + h - cut], [x + w - cut, y + h], [x + cut, y + h], [x, y + h - cut], [x, y + cut]])),
    ear = Math.min(.038, W * .09, H * .14), rim = .009;
  chamfer(0, 0, W, H, ear * .85);
  a.fill(a.gradient(0, 0, 0, H, ([[0, '#85917d'], [.07, '#66735f'], [.65, '#4f5c4c'], [1, '#303e34']]))); a.stroke(OUTLINE, a.edge);
  chamfer(rim, rim, W - 2 * rim, H - 2 * rim, ear * .7);
  a.fill(a.gradient(0, rim, 0, H - rim, ([[0, '#626e5d'], [.25, '#53614f'], [1, '#44523f']])));
  a.stroke('#a2ae9166', a.hair(1));
  a.finish?.face({ x: rim, y: rim, width: W - 2 * rim, height: H - 2 * rim });
  // Four identical mounting ears, all within the ordinary rectangular component box.
  for (const x of [0, W - ear]) for (const y of [0, H - ear]) {
    chamfer(x, y, ear, ear, ear * .18);
    a.fill(a.gradient(0, y, 0, y + ear, ([[0, '#788472'], [.3, '#596653'], [1, '#3e4d3f']]))); a.stroke(OUTLINE, a.edge);
    a.circle(x + ear / 2, y + ear / 2, ear * .28, '#8b9481', '#28382d', a.hair(1));
    a.circle(x + ear / 2, y + ear / 2, ear * .18, '#111c17', '#b6beaa80', a.hair(1));
  }
  const sx = W * .09, sy = H * .17, sw = W * .48, sh = H * .25,
    sinkY = H * .475, sinkH = H * .375, screw = Math.min(.0028, H * .01);
  // A single horizontal glass window with two quiet, non-tactical traces.
  a.housing(sx - .006, sy - .006, sw + .012, sh + .012, '#596650', .005);
  chamfer(sx, sy, sw, sh, .005);
  a.fill(a.gradient(0, sy, 0, sy + sh, ([[0, '#122a30'], [.4, '#0b2027'], [1, '#091a20']]))); a.stroke('#0a1519', a.hair(1));
  a.finish?.protect({ x: sx, y: sy, width: sw, height: sh, radius: .005 });
  for (const v of [.38, .61]) {
    a.ctx.beginPath(); a.ctx.moveTo(sx + sw * .07, sy + sh * v); a.ctx.lineTo(sx + sw * .18, sy + sh * v);
    a.ctx.lineTo(sx + sw * .25, sy + sh * (v + .14)); a.ctx.lineTo(sx + sw * .58, sy + sh * (v + .14));
    a.stroke('#53838b90', Math.max(a.hair(1), .0011));
  }
  // Parallel aluminium fins share one width, height and pitch; no angled or foreshortened end faces.
  a.housing(sx - .009, sinkY - .006, sw + .018, sinkH + .012, '#394a3d', .005);
  a.finish?.protect({ x: sx, y: sinkY, width: sw, height: sinkH });
  const count = 14, pitch = (sw - .012) / count, finW = pitch * .46, finTop = sinkY + .001, finH = sinkH - .002;
  for (let i = 0; i < count; i++) {
    const x = sx + .006 + (i + .5) * pitch - finW / 2;
    a.path(x, finTop, finW, finH, .001);
    a.fill(a.gradient(0, finTop, 0, finTop + finH, ([[0, '#a7b29c'], [.05, '#86957f'], [.3, '#657760'], [1, '#384d3c']])));
    a.stroke('#1c2e23', a.hair(.8));
    a.line(x + a.hair(1), finTop + .004, x + a.hair(1), finTop + finH - .004, '#b9c3aa50', a.hair(.8));
  }
  for (const x of [sx - .001, sx + sw + .001]) for (const y of [sy - .002, sy + sh + .002, sinkY - .001, sinkY + sinkH + .001]) a.bolt(x, y, screw);
  // The service panel: two matching connectors, a recessed square key and a plain four-screw cover.
  const px = W * .61, py = H * .145, pw = W * .32, ph = H * .715,
    cx = px + pw * .28, radius = Math.min(.0195, pw * .145), pad = radius * 2.5;
  a.housing(px, py, pw, ph, '#4e5d49', .008);
  for (const x of [px + .006, px + pw - .006]) for (const y of [py + .007, py + ph - .007]) a.bolt(x, y, screw);
  for (const cy of [py + ph * .27, py + ph * .67]) {
    a.housing(cx - pad / 2, cy - pad / 2, pad, pad, '#56644f', .004);
    for (const x of [cx - pad * .38, cx + pad * .38]) for (const y of [cy - pad * .38, cy + pad * .38]) a.bolt(x, y, screw * .85);
    a.circle(cx, cy, radius, a.radial(cx, cy, radius, ([[0, '#a7b29c'], [.76, '#82917b'], [1, '#405441']]), cx, cy - radius * .3), OUTLINE, a.hair(1));
    a.circle(cx, cy, radius * .73, '#111e19', '#a1b29890', a.hair(1));
    a.finish?.protectCircle(cx, cy, radius * .73);
    for (let pin = 0; pin < 3; pin++) {
      const turn = -Math.PI / 2 + pin * TAU / 3;
      a.circle(cx + Math.cos(turn) * radius * .29, cy + Math.sin(turn) * radius * .29, .0013, '#b3a16b', '#292d1d', a.hair(.5));
    }
    // The same open protective cover at each socket, seen face on beside its opening.
    a.ctx.beginPath(); a.ctx.arc(cx, cy, radius * .97, Math.PI * .6, Math.PI * 1.4);
    a.ctx.arc(cx, cy, radius * .69, Math.PI * 1.4, Math.PI * .6, true); a.ctx.closePath();
    a.fill('#63735e'); a.stroke('#233b29', a.hair(.8));
    a.housing(cx - radius * .3, cy - radius * 1.05, radius * .6, radius * .28, '#697c63', .002);
  }
  const bx = px + pw * .7, button = Math.min(.047, pw * .35), by = py + ph * .27 - button / 2,
    coverY = py + ph * .53, coverH = ph * .43;
  a.housing(bx - button / 2, by, button, button, '#5c6a54', .004);
  a.path(bx - button * .36, by + button * .14, button * .72, button * .72, .003); a.fill('#15271d'); a.stroke('#86977b70', a.hair(1));
  a.finish?.protect({ x: bx - button * .36, y: by + button * .14, width: button * .72, height: button * .72, radius: .003 });
  a.housing(bx - button * .22, by + button * .28, button * .44, button * .44, '#65775e', .002);
  a.housing(bx - button / 2, coverY, button, coverH, '#56664e', .004);
  for (const x of [bx - button / 2 + .005, bx + button / 2 - .005]) for (const y of [by + .005, by + button - .005, coverY + .005, coverY + coverH - .005]) a.bolt(x, y, screw * .85);
}

// A sensor seen from the side as it stands on the roof, each of its own outline: the camera's armoured head on its pan
// unit, the turntable of the radar — its aerial turns over it, and is painted on its own (`style`: its face, its back or
// its edge) —, or the microphones of the listening array on their spider.
function paintSensor(a: MachineKit, W: number, H: number, options: ComponentArtOptions) {
  if (options.sensorMode === 'radar') (AERIAL[options.style!] || radarTurntable)(a, W, H, options);
  else (options.sensorMode === 'sound' ? listeningArray : cameraHead)(a, W, H, options);
}

// The sight of a vehicle, in the manner of a commander's panoramic one: an armoured head on the finned pan unit it turns
// on, looking out through one large coated window with the rangefinder's port beside it, all on the ring it is bolted
// down by. It turns to whatever it watches: here it looks out of the picture.
function cameraHead(a: MachineKit, W: number, H: number, options: ComponentArtOptions = {}) {
  const ring = Math.min(.026, H * .11), pan = Math.min(.05, H * .21), panY = H - ring - pan, headH = panY + .004;
  // A separate seat follows actual wall or inclined-roof contact. The head and
  // pan unit keep their authored orientation; only the bolt-on flange changes.
  if (options.sensorSupport !== 'separate') {
    a.housing(0, H - ring, W, ring, '#3b4640', .004);
    along(0, W, .03, (x: number) => a.bolt(x, H - ring / 2, Math.min(.0045, ring * .2)));
  }
  a.shape(([[W * .12, H - ring], [W * .16, panY], [W * .84, panY], [W * .88, H - ring]]));
  a.fill(a.gradient(0, panY, 0, H - ring, ([[0, '#8a9a70'], [.25, '#7a8b62'], [1, '#56653f']]))); a.stroke(OUTLINE, a.edge);
  along(W * .17, W * .66, .011, (x: number) => a.rib(x, panY + .007, x, H - ring - .004, .0028));
  a.line(W * .16, panY + .0025, W * .84, panY + .0025, '#141c17', Math.max(a.hair(1), .002));
  // The head, the plates bolted over its sides and the hood over its window.
  const hx = W * .03, hw = W - 2 * hx, ear = Math.min(.03, hw * .1), hood = Math.min(.018, headH * .12);
  a.housing(hx, hood * .6, hw, headH - hood * .6, '#3e4741', .014);
  for (const x of [hx, hx + hw - ear]) {
    a.housing(x, hood + .004, ear, headH - hood - .012, '#343c37', .006);
    along(hood + .01, headH - hood - .03, .028, (y: number) => a.circle(x + ear / 2, y, .0034, '#121814', '#66706a', a.hair(.8)));
  }
  a.housing(0, 0, W, hood, '#4b554e', .006);
  // The window: a frame round coated glass, the two objectives — the day camera's and the thermal one's — dark behind it,
  // the light across it, a wiper parked at its side.
  const port = Math.min(.05, hw * .18), wx = hx + ear + .012, wy = hood + .012, ww = hw - 2 * ear - .024 - port, wh = headH - wy - .016;
  a.path(wx - .007, wy - .007, ww + .014, wh + .014, .012); a.fill('#222925'); a.stroke(OUTLINE, a.edge);
  a.finish?.protect({ x: wx - .007, y: wy - .007, width: ww + .014, height: wh + .014, radius: .012 });
  a.ctx.save(); a.path(wx, wy, ww, wh, .008); a.ctx.clip();
  a.finish?.protect({ x: wx, y: wy, width: ww, height: wh, radius: .008 });
  a.path(wx, wy, ww, wh); a.fill(a.gradient(wx, wy, wx + ww, wy + wh, ([[0, '#4a5068'], [.45, '#262b40'], [1, '#0d101c']])));
  for (const [u, k] of ([[.32, .34], [.74, .22]] satisfies readonly [number, number][])) {
    const r = wh * k, cx = wx + ww * u, cy = wy + wh * .52;
    a.circle(cx, cy, r * 1.25, '#0b0e1d90', '#8d98c450', a.hair(1));
    a.circle(cx, cy, r, a.radial(cx, cy, r, ([[0, '#2b3a63'], [.7, '#0a1024'], [1, '#04060f']]), cx - r * .3, cy - r * .35), '#6f7cae70', a.hair(1));
    a.circle(cx - r * .35, cy - r * .35, r * .14, '#c9d3f2a0');
  }
  a.shape(([[wx + ww * .08, wy + wh], [wx + ww * .42, wy], [wx + ww * .56, wy], [wx + ww * .22, wy + wh]])); a.fill('#e9edff1c');
  a.line(wx + ww * .62, wy + wh, wx + ww * .82, wy, '#e9edff30', Math.max(a.hair(1), .002));
  a.ctx.restore();
  for (const [x, y] of ([[wx - .0035, wy - .0035], [wx + ww + .0035, wy - .0035], [wx - .0035, wy + wh + .0035], [wx + ww + .0035, wy + wh + .0035]] satisfies readonly [number, number][])) a.bolt(x, y, .0032);
  a.line(wx + .006, wy + wh - .004, wx + .006, wy + wh * .2, '#111613', Math.max(a.hair(1.5), .003));
  a.circle(wx + .006, wy + wh - .004, .004, '#2f3732', OUTLINE, a.hair(1));
  // The rangefinder's port and the small window of the laser warning under it.
  const px = hx + hw - ear - .008 - port / 2, pr = Math.min(port * .3, wh * .2), py = wy + pr + .006;
  a.circle(px, py, pr * 1.35, '#222925', OUTLINE, a.edge);
  a.circle(px, py, pr, a.radial(px, py, pr, ([[0, '#4a3c52'], [.7, '#1a1424'], [1, '#07050c']]), px - pr * .3, py - pr * .35), '#8e7fa070', a.hair(1));
  a.finish?.protectCircle(px, py, pr * 1.35);
  a.circle(px - pr * .3, py - pr * .3, pr * .16, '#e2d8f0a0');
  const sq = Math.min(pr * 1.4, wy + wh - py - pr * 1.35 - .01);
  if (sq > .004) { a.path(px - sq / 2, wy + wh - sq, sq, sq, .002); a.fill('#141a26'); a.stroke('#5f6a64', a.hair(1)); a.finish?.protect({ x: px - sq / 2, y: wy + wh - sq, width: sq, height: sq, radius: .002 }); }
  a.wear(hx, hood, hw, headH - hood, 19);
}

// A radar is its turntable and the flat aerial that turns on it: the turntable takes the foot of its box,
// and the aerial the rest, as wide as the box and a fifth of that deep (combat-sensors.ts). `y` is how far the middle
// of the aerial stands over the middle of the box.
const TURNTABLE = RADAR_PEDESTAL_SHARE, AERIAL_DEPTH = .2;
export const radarAerial = (width: number, height: number) => ({ width, height: height * (1 - TURNTABLE), depth: width * AERIAL_DEPTH, y: height * TURNTABLE / 2 });
// A turning slab in the same orthographic elevation as the rest of the game.
// Rotation changes its width, never its height, centre or distance from its foot.
const UPRIGHTS = [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const, SIDES = [['face', 0, 1, 1], ['edge', 1, 2, 1], ['back', 2, 3, 1], ['edge', 0, 3, -1]] as const;
const UPRIGHT_SEEN = new Float64Array(4);
export const aerialSight = (): AerialSight => ({ count: 0, faces: [0, 1].map(() => ({ style: '', light: 0, corners: new Array<number>(8).fill(0) })) });
// Up to two adjacent rectangles, sharing the same upright edge. Reuse `view`
// through the animation; no perspective correction or visible-face rescaling.
export function aerialView(aerial: ReturnType<typeof radarAerial>, turn: number, view = aerialSight()) {
  const { width: W, depth: D, height: H } = aerial, c = Math.cos(turn), s = Math.sin(turn),
    seen = UPRIGHT_SEEN, faces = view.faces;
  for (let i = 0; i < 4; i++) seen[i] = UPRIGHTS[i]![0] * W / 2 * c - UPRIGHTS[i]![1] * D / 2 * s;
  view.count = 0;
  for (const [style, left, right, facing] of SIDES) {
    if ((seen[right]! - seen[left]!) * facing <= W * 1e-12) continue;
    const face = faces[view.count++]!, corners = face.corners;
    face.style = style; face.light = .8 + .2 * Math.abs(style === 'edge' ? s : c);
    corners[0] = corners[6] = seen[left]!; corners[2] = corners[4] = seen[right]!;
    corners[1] = corners[3] = H / 2; corners[5] = corners[7] = -H / 2;
  }
  return view;
}

// The turntable at the foot of a radar's box: a flange bolted to the roof, the drum of the drive with its motor and the
// cable out of it, and the rotary joint the aerial's bracket turns on.
function radarTurntable(a: MachineKit, W: number, H: number, options: ComponentArtOptions = {}) {
  const T = H * TURNTABLE, top = H - T, flange = Math.min(.022, T * .16), joint = T * .24;
  if (options.sensorSupport !== 'separate') {
    a.housing(W * .25, H - flange, W * .5, flange, '#3b4640', .004);
    for (const x of [W * .29, W * .71]) a.bolt(x, H - flange / 2, Math.min(.005, flange * .22));
  }
  const dx = W * .31, dw = W * .38, dy = top + joint, dh = H - flange - dy;
  // A vertical spindle shows a straight drum, shaded across it, not an ellipse.
  a.path(dx, dy, dw, dh, .006);
  a.fill(a.gradient(dx, 0, dx + dw, 0, ([[0, '#303b33'], [.3, '#71806b'], [.6, '#5a6855'], [1, '#303b33']]))); a.stroke(OUTLINE, a.edge);
  a.finish?.face({ x: dx, y: dy, width: dw, height: dh, radius: .006 });
  for (const share of [.18, .82]) a.line(dx, dy + dh * share, dx + dw, dy + dh * share, '#1c251f', Math.max(a.hair(1), .002));
  // A small drive and its service loop remain inside the same mounting box.
  const mw = Math.min(.09, W * .09), mh = dh * .55, mx = dx + dw - .004, my = dy + dh * .38;
  a.housing(mx, my, mw, mh, '#4b5742', .006);
  a.tube(([[mx + mw * .6, my + mh], [mx + mw * .6, H - flange * .6], [mx + mw + .02, H - flange * .4]]), Math.min(.014, mh * .2), '#22291f');
  // The short yoke meets the aerial at the unchanged top of the turntable.
  a.housing(W * .37, top + joint * .55, W * .26, joint * .45, '#29332d', .003);
  for (const x of [W * .37, W * .57]) a.housing(x, top, W * .06, joint, '#465347', .002);
  a.wear(dx, dy, dw, dh, 23);
}

// The pictures of the aerial are of the sides of one slab, which meet at its upright edges: none has its corners rounded,
// for two sides the eye sees to meet without a notch between them.
// A sealed ground-surveillance panel: a quiet radome, one cover joint and a narrow
// frame. The radiating elements are behind it, not a cabinet grid on its surface.
function aerialFace(a: MachineKit, W: number, H: number) {
  // Ranger-style sealed panel: a broad quiet radome between raised vertical edge rails, two shallow reinforcing
  // folds and a dark lower seal. The antenna is behind this cover; there are no exposed mesh or optical lenses.
  const rim = Math.min(.022, W * .045, H * .065), rail = W * .045, inner = rim + rail,
    fw = W - 2 * inner, fh = H - 2 * rim, screw = Math.min(.004, rim * .19);
  a.housing(0, 0, W, H, '#495246', 0);
  a.path(inner, rim, fw, fh, Math.min(.009, rim * .4));
  a.fill(a.gradient(0, rim, 0, H - rim, ([[0, '#b7b29a'], [.4, '#a9a58b'], [1, '#8e9279']])));
  a.stroke('#575e4e', Math.max(a.hair(1), .0015));
  a.finish?.protect({ x: inner, y: rim, width: fw, height: fh, radius: .006 });
  for (const share of [.32, .68]) {
    const x = inner + fw * share;
    a.line(x, rim + .004, x, H - rim - .004, '#d0cbb040', Math.max(a.hair(1), .0025));
    a.line(x + .003, rim + .004, x + .003, H - rim - .004, '#626a5645', Math.max(a.hair(.8), .0015));
  }
  for (const x of [rim, W - rim - rail]) {
    a.housing(x, rim * .5, rail, H - rim, '#727b63', .003);
    a.line(x + rail * .2, rim, x + rail * .2, H - rim, '#bdc0a450', a.hair(1));
    for (const y of [rim * 1.5, H - rim * 1.5]) a.bolt(x + rail / 2, y, screw);
  }
  a.line(inner, H - rim * .65, W - inner, H - rim * .65, '#29382d', Math.max(a.hair(1), .003));
}
// The rear shell, a single fin pack and the central mounting spine. A compact
// connector box and a service loop read apart from the smooth front radome.
function aerialBack(a: MachineKit, W: number, H: number) {
  const rim = Math.min(.026, W * .028, H * .045), fw = W - 2 * rim,
    finX = W * .17, finY = H * .22, finW = W * .66, finH = H * .29,
    spine = Math.min(.16, W * .2), bx = (W - spine) / 2;
  a.housing(0, 0, W, H, '#4d5849', 0);
  a.path(rim, rim, fw, H - 2 * rim, .006); a.fill('#626e58'); a.stroke('#303c30', a.hair(1));
  a.housing(finX, finY, finW, finH, '#45513f', .004);
  for (const x of [W * .055, W * .9]) a.housing(x, H * .08, W * .045, H * .82, '#3e4c3d', .003);
  a.finish?.protect({ x: finX, y: finY, width: finW, height: finH, radius: .004 });
  along(finY + .012, finH - .024, .04, (y: number) => a.rib(finX + .012, y, finX + finW - .012, y, .004));
  a.housing(bx, H * .55, spine, H * .45, '#344135', .003);
  a.housing(W * .26, H * .65, W * .48, H * .07, '#485645', .003);
  for (const x of [W * .29, W * .71]) a.bolt(x, H * .685, Math.min(.006, spine * .08));
  const boxX = W * .1, boxY = H * .76, boxW = W * .22, boxH = H * .17, plug = Math.min(.01, boxH * .15);
  a.housing(boxX, boxY, boxW, boxH, '#56634e', .004);
  for (const x of [boxX + boxW * .28, boxX + boxW * .72]) {
    const y = boxY + boxH * .6;
    a.circle(x, y, plug * 1.3, '#a5ad95', OUTLINE, a.hair(1));
    a.circle(x, y, plug * .65, '#172019'); a.finish?.protectCircle(x, y, plug * 1.3);
  }
  a.tube(([[boxX + boxW * .72, boxY + boxH * .6], [boxX + boxW * .72, H * .96], [W / 2, H * .96]]), Math.min(.01, boxH * .12), '#202b22');
  a.tube(([[W * .36, H * .15], [W * .36, H * .1], [W * .64, H * .1], [W * .64, H * .15]]), .008, '#303c31');
  for (const x of [rim / 2, W - rim / 2]) for (const y of [rim / 2, H - rim / 2]) a.bolt(x, y, Math.min(.004, rim * .18));
  a.wear(rim, rim, fw, H - 2 * rim, 37);
}
// The edge of the aerial as it turns away, a flat side: the frame of the radome on one hand and the shell of the back on
// the other with the seam between them, the screws of the shell, the grip it is carried by.
function aerialEdge(a: MachineKit, W: number, H: number) {
  const lip = Math.min(.018, W * .18), grip = Math.min(.028, H * .06);
  a.path(0, 0, W, H); a.fill('#4c5848'); a.stroke(OUTLINE, a.edge);
  a.finish?.face({ x: 0, y: 0, width: W, height: H });
  a.path(0, 0, lip, H); a.fill('#a4aa90');
  a.finish?.protect({ x: 0, y: 0, width: lip, height: H });
  a.line(lip, .004, lip, H - .004, '#1b261e', Math.max(a.hair(1.2), .002));
  a.line(lip + .003, .004, lip + .003, H - .004, GLINT + '30', a.hair(1));
  along(H * .22 + .012, H * .34 - .024, .04, (y: number) => a.rib(W * .55, y, W - .006, y, .003));
  a.housing(W * .7, H * .1, W * .22, grip, '#303c31', .002);
  a.wear(0, 0, W, H, 41);
}
const AERIAL: Partial<Record<string, (a: MachineKit, W: number, H: number, options: ComponentArtOptions) => void>> = { face: aerialFace, back: aerialBack, edge: aerialEdge };

// The microphones of a listening array, in the manner of a vehicle's gunshot detector: black capsules in their
// windscreens on the six arms of a cast spider and on top of its post, the cable down the post into the box at its foot.
// The arms spread a sixth of a turn apart, two of them along the vehicle: from the side those two reach out to its ends,
// and each of the other pairs shows half as far out, its near arm over its far one. Every capsule is of the one size.
function listeningArray(a: MachineKit, W: number, H: number, options: ComponentArtOptions = {}) {
  const footW = Math.min(W * .42, .13), footH = Math.min(.034, H * .15), fx = (W - footW) / 2, fy = H - footH,
    post = Math.min(.024, W * .075), cw = Math.min(.05, W * .16), ch = Math.min(.074, H * .31), top = 1.2,
    hubY = H * .6, tipY = H * .5, thick = Math.min(.02, H * .085), reach = W / 2 - cw * .58;
  // One capsule standing on its clamp, its foot at (x, y), `tall` times as tall as the others: a black windscreen,
  // rounded on top, with a collar low on it.
  const capsule = (x: number, y: number, tall = 1) => {
    const w = cw, h = ch * tall;
    a.finish?.protect({ x: x - w * .58, y: y - h, width: w * 1.16, height: h * 1.02, radius: w * .3 });
    a.path(x - w * .32, y - h * .16, w * .64, h * .18, .002); a.fill('#5d6b4a'); a.stroke(OUTLINE, a.hair(1));
    a.path(x - w / 2, y - h, w, h * .86, w / 2);
    a.fill(a.radial(x, y - h * .6, w, ([[0, '#3f4843'], [.5, '#222924'], [1, '#0c100e']]), x - w * .25, y - h * .8)); a.stroke(OUTLINE, a.edge);
    for (let i = 0; i < 11; i++) a.circle(x + (frac(i * .618) - .5) * w * .7, y - h * (.3 + frac(i * .382) * .6), a.hair(.8), '#5b625d70');
    a.path(x - w * .58, y - h * .36, w * 1.16, h * .14, .003); a.fill('#262e29'); a.stroke(OUTLINE, a.hair(1));
  };
  // A cast arm of the spider, out from the hub and up at its end under a capsule, `k` of the way out it reaches along the
  // vehicle (the cosine of its turn from it).
  const arm = (side: number, k: number) => {
    const at = (u: number) => W / 2 + side * u * k;
    a.tube(([[W / 2, hubY], [at(W * .2), hubY - thick * .3], [at(reach - cw * .25), tipY + thick * .2], [at(reach), tipY + thick * .9]]), thick, '#5d6b4a');
    capsule(at(reach), tipY);
  };
  // The post, then the arms in front of it and the hub they are cast in, the capsule on the top of the post.
  a.path(W / 2 - post / 2, ch * top * .8, post, fy - ch * top * .8, post * .3);
  a.fill(a.gradient(W / 2 - post / 2, 0, W / 2 + post / 2, 0, ([[0, '#1c231f'], [.35, '#4a544d'], [1, '#141a16']]))); a.stroke(OUTLINE, a.edge);
  a.finish?.face({ x: W / 2 - post / 2, y: ch * top * .8, width: post, height: fy - ch * top * .8, radius: post * .3 });
  a.line(W / 2 + post * .8, hubY + thick, W / 2 + post * .8, fy, '#151b17', Math.max(a.hair(1.2), .003));
  a.finish?.protect({ x: W / 2 + post * .8 - .002, y: hubY + thick, width: .004, height: fy - hubY - thick });
  for (const side of [-1, 1]) { arm(side, .5); arm(side, 1); }
  a.housing(W / 2 - W * .1, hubY - thick, W * .2, thick * 2, '#5d6b4a', .008); a.bolt(W / 2, hubY, Math.min(.0045, thick * .25));
  capsule(W / 2, ch * top, top);
  // The box at the foot: what the microphones hear is worked out in it.
  if (options.sensorSupport !== 'separate') {
    a.housing(fx, fy, footW, footH, '#56654a', .005);
    for (const x of [fx + .008, fx + footW - .008]) a.bolt(x, fy + footH / 2, Math.min(.0035, footH * .14));
    a.label('ESCUTA', W / 2, fy + footH * .68, Math.min(.0095, footH * .38), '#d2d6bf', { align: 'center', max: footW - .03 });
  }
}
// The road machines are drawn as they travel, the blade raised clear of the ground and the screed lifted off it, their
// front at the right. At work the field lowers them
// (road-machine-motion.ts): their picture is then painted in parts (`part`), each where it stands as they travel — what
// stays with the vehicle (`frame`), the drawbar's neck and the circle with the moldboard of a blade (`neck`, `assembly`),
// the screed, the auger, and the two beams of the tow arm of a paver (`screed`, `auger`, `slide`, `arm`) —, and the field
// moves each and draws what joins them (`ram`, `telescope`, `slats`) as here. The whole picture (no `part`) is all of
// them as they travel, laid in the order the field lays the parts.
// A hydraulic ram from the pin of its barrel to the pin of its rod, its barrel `barrel` long: the bright rod out of the
// barrel, an eye at either end with the pin through it, across the vehicle. One whose barrel end is out of the picture
// shows no eye there.
export const RAM = Object.freeze({ rod: '#b9bead', barrel: '#4f5a45', eye: '#3b4538', pin: '#9aa48c' });
function ram(a: MachineKit, x0: number, y0: number, x1: number, y1: number, d: number, barrel = Math.hypot(x1 - x0, y1 - y0) * .55) {
  const length = Math.hypot(x1 - x0, y1 - y0), k = Math.min(1, barrel / length), xm = x0 + (x1 - x0) * k, ym = y0 + (y1 - y0) * k;
  a.tube(([[xm, ym], [x1, y1]]), d * .45, RAM.rod);
  a.tube(([[x0, y0], [xm, ym]]), d, RAM.barrel);
  for (const [x, y] of [[x0, y0], [x1, y1]] satisfies XY[]) { a.circle(x, y, d * .6, RAM.eye, OUTLINE, a.hair(1)); a.circle(x, y, d * .24, RAM.pin); }
}
// A ram of three stages, as one that lifts far: the barrel from its pin, `barrel` long, and out of it each stage thinner
// than the one before, as far as `stages` says each comes out, up to the pin of the last.
export const TELESCOPE = Object.freeze([1, .78, .6, .44] as const);
function telescope(a: MachineKit, x0: number, y0: number, x1: number, y1: number, d: number, stages: readonly XY[]) {
  const length = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / length, uy = (y1 - y0) / length, at = (s: number): XY => [x0 + ux * s, y0 + uy * s];
  for (let i = stages.length - 1; i >= 0; i--) a.tube([at(stages[i]![0]), at(stages[i]![1])], d * TELESCOPE[i]!, i ? RAM.rod : RAM.barrel);
  for (const [x, y] of ([[x0, y0], [x1, y1]] satisfies readonly [number, number][])) { a.circle(x, y, d * .6, RAM.eye, OUTLINE, a.hair(1)); a.circle(x, y, d * .24, RAM.pin); }
}
// Where along a ram drawn out to `length` each of its tubes runs, from the pin of its barrel: the barrel, `barrel` long;
// out of it the stages it hides as it travels, `hidden` of them; and out of those the stages it shows as it travels,
// each as far as `shown` says then, the last up to its pin. Each comes out `most` at the most: those it shows first,
// alike, and once they are all out those it hides, alike — a ram drawn out no further than its stages shown reach shows
// nothing of the others. Each [from, to], the barrel first.
export function ramStages({ barrel, shown, hidden = 0, most }: RamStages, length: number) {
  const rest = shown.reduce((sum, at: number) => sum + at, 0), out = Math.max(0, length - barrel - rest),
    showing = Math.max(0, Math.min(out / shown.length, ...shown.map((at: number) => most - at))), hiding = hidden ? (out - showing * shown.length) / hidden : 0,
    stages: [number, number][] = ([[0, barrel]] satisfies readonly [number, number][]);
  for (const reach of [...new Array<number>(hidden).fill(hiding), ...shown.map((at: number) => at + showing)]) { const from = stages.at(-1)![1]; stages.push([from, from + reach]); }
  stages.at(-1)![1] = Math.max(stages.at(-1)![0], length);
  return stages;
}
// How thick each tube of such a ram is, to its barrel (`ramStages`): its barrel and the stages it shows as `widths` has
// them, and those it hides between its barrel and the first of those, each a step thinner than the one before.
export function stageWidths({ widths, hidden = 0 }: { widths: readonly [number, number, ...number[]]; hidden?: number }) {
  const step = (widths[1] / widths[0]) ** (1 / (hidden + 1));
  return [widths[0], ...Array.from({ length: hidden }, (_, i: number) => widths[0] * step ** (i + 1)), ...widths.slice(1)];
}
// A beam of plate welded into a box, along the points of its outline, lit from above, the seam of its weld along it.
function beam(a: MachineKit, points: readonly XY[], base: string, seam?: readonly [number, number, number, number]) {
  const ys = points.map(([, y]) => y);
  a.shape(points); a.fill(a.gradient(0, Math.min(...ys), 0, Math.max(...ys), ([[0, shade(base, .25)], [.35, base], [1, shade(base, -.4)]])));
  a.stroke(OUTLINE, a.edge);
  if (seam) a.rib(...seam, .0025);
}
// The outline of a beam from one point to another, `from` deep at the first and `to` at the second.
const strut = ([x0, y0]: XY, [x1, y1]: XY, from: number, to: number): XY[] => {
  const length = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / length / 2, ny = (x1 - x0) / length / 2;
  return ([[x0 + nx * from, y0 + ny * from], [x1 + nx * to, y1 + ny * to], [x1 - nx * to, y1 - ny * to], [x0 - nx * from, y0 - ny * from]] satisfies readonly [number, number][]);
};

// The curve of the moldboard's plate, as far back of the front of its lip as it is at a share `t` of its height from its
// top: hollow under the lip, and forward again at its foot, where the cutting edge is.
const hollow = (curl: number, t: number) => t < .42 ? curl * (1 - (1 - t / .42) ** 2) : curl * (1 - .75 * ((t - .42) / .58) ** 2);
// The moldboard works turned aslant across the way, its toe forward, and the side of the vehicle shows it so: its near end,
// the heel, nearer the eye than its far one, the toe. Unlike the side elevation all else is drawn in, it is drawn as the
// eye sees what is nearer and further off: its far end smaller than its near one by `FAR` (road-tools.ts), and seen from
// the height of its top, so that its top runs level and its foot rises towards its far end as the ground does going away
// from the eye. Its face is to the eye, as a Cat 140's is from its side. The curve of each end shows across the way by
// `CROSS` of its depth.
const CROSS = .9;
// How far along the picture of the moldboard from its near end to its far one a share `u` of its length is, and how large
// it is drawn there: the further half shows shorter than the nearer, and smaller.
const recede = (u: number) => u / (FAR * (1 - u) + u), nearness = (u: number) => 1 / (1 - u + u / FAR);
// Where the parts of a blade stand in its box as it travels, in metres from its upper rear corner, its front at the right:
// what the field lowers of it at work turns about the ball and goes down with the circle (road-machine-motion.ts). The
// moldboard reaches across the box under the circle, its near end at the rear: the bottom of its cutting edge stands at the
// foot of the box there, the ground it travels over, and the middle of its length is where the blade works (road-tools.ts).
// The rams that lift it and shift it come down from the lift group, out of the picture: they show from under the saddle
// on. It hangs from the metal over it (`hang`, road-machine-motion.ts `bladeHang`) by a column from its saddle up to the
// underside of that, and the rams hang from it there, each by a clevis; held otherwise, they come down from over the frame.
// Each is a barrel and its rod (`ramStages`), and draws out as far as the field lowers the blade (road-machine-motion.ts
// `machineRig`).
export function bladeRig(W: number, H: number, hang: { y: number; slope: number; half?: number } | null = null): BladeRig {
  const s = H / .45, at = (f: number) => H * f, r = Math.min(at(.06), .045 * Math.sqrt(s)), knife = at(.14), plate = at(.5), cut = .016 * s,
    [heel, toe] = bladeEdge(W, H), near = { x: heel, foot: at(TOOL_POINT.blade.y), k: 1 },
    far = { x: toe, foot: near.foot - (1 - FAR) * (knife + plate), k: FAR },
    rig: Omit<BladeRig, 'parts' | 'lift' | 'shift'> & { lift: RamEnds; shift: RamEnds } = { s, d: Math.max(.02, Math.min(.06, .042 * s)), saddle: at(.07),
      ball: { x: W - r - .008, y: at(.15), r },
      yoke: { rear: W * .17, front: W * .7, top: at(.1), foot: at(.22) },
      pin: { x: W * .68, y: at(.16) },
      circle: { rear: W * .18, front: W * .72, top: at(.22), foot: at(.27) },
      // Each end of the moldboard by the bottom of the front of its cutting edge (`x`, `foot`), and how large it is drawn
      // (`k`): its plate `plate` tall and `thick` thick, its lip `curl` forward of the hollow under it, and under the plate
      // the cutting edge, `knife` tall and `cut` thick. That stands on the ground from its heel, at the near end, to its toe,
      // at the far one, at the foot of the box (`foot`).
      board: { near, far, plate, knife, cut, thick: .018 * s, curl: Math.min(.06 * s, plate * .3), heel: near.x - cut * CROSS, toe: far.x, foot: near.foot },
      drive: { x: W * .56, w: W * .07, top: at(.06) },
      lift: { top: { x: W * .4, y: -H * 1.3 }, foot: { x: W * .38, y: at(.16) } },
      shift: { top: { x: W * .58, y: -H * .75 }, foot: { x: W * .22, y: at(.16) } } };
  if (hang) {
    // The underside of the metal over the box at `X`, and the pin of a clevis under it.
    const under = (X: number) => hang.y + hang.slope * (X - W / 2);
    rig.hang = { ...hang, under, middle: W / 2, clevis: rig.d * 1.5 };
    for (const name of ['lift', 'shift'] as const) rig[name].top.y = under(rig[name].top.x) + rig.hang.clevis;
  }
  // Each barrel as long as its ram as it travels but for a little of the rod, which draws out of it all but as much.
  const completedRam = (ram: RamEnds): ArtRam => {
    const travel = Math.hypot(ram.foot.x - ram.top.x, ram.foot.y - ram.top.y), barrel = Math.max(travel / 2, travel - .05 * s);
    return Object.assign(ram, { barrel, shown: [travel - barrel], most: barrel - (travel - barrel), widths: [1, .45] satisfies [number, number] });
  };
  const lift = completedRam(rig.lift), shift = completedRam(rig.shift);
  // What the field moves of it, each the box of its picture as it travels.
  const parts = { neck: { x: rig.pin.x - .04 * s, y: rig.ball.y - r * 1.6, w: W - rig.pin.x + .04 * s, h: rig.yoke.foot + .02 * s - rig.ball.y + r * 1.6 },
    assembly: { x: 0, y: rig.drive.top - .006 * s, w: W, h: H - rig.drive.top + .006 * s } };
  return Object.assign(rig, { lift, shift, parts });
}
// The moldboard of a blade as it is drawn: where a place of it is, a share `u` of its length on from its near end and `t`
// of the height of its plate down from the top of its lip, on its face (`face`) or the back of its plate (`back`); the bottom
// of its cutting edge there, at its front or `behind` of its thickness back (`foot`); and how large it is drawn there (`k`).
export function moldboard({ board, s }: Pick<BladeRig, 'board' | 's'>) {
  const { near, far, plate, knife, thick, cut, curl } = board, lean = .022 * s,
    end = (e: BladeEnd, depth: number, t: number) => ({ x: e.x + e.k * CROSS * depth, y: e.foot - e.k * (knife + (1 - t) * plate) }),
    on = (u: number, at: (end: BladeRig["board"]["near"]) => Point) => { const a = at(near), b = at(far), g = recede(u); return { x: a.x + (b.x - a.x) * g, y: a.y + (b.y - a.y) * g }; },
    depth = (t: number) => hollow(curl, 1) - hollow(curl, t) - lean;
  return { k: nearness,
    face: (u: number, t: number) => on(u, e => end(e, depth(t), t)),
    back: (u: number, t: number) => on(u, e => end(e, depth(t) - thick, t)),
    foot: (u: number, behind = 0) => on(u, e => ({ x: e.x - e.k * CROSS * cut * behind, y: e.foot })) };
}

// The blade of a motor grader, as a Cat 140's hangs under its frame between the front axle and the tandem, seen from its
// side: the saddle it hangs by under the rails, and at its front the ball of the drawbar; the drawbar's neck back and down
// from the ball to the yoke over the circle; the circle, the ring gear the blade turns on, edge on with its teeth along it,
// the drive of it standing on the yoke, motor over gearbox; the arms down from the circle behind the moldboard's top to the
// guides of its upper box, and the ram that tips it; and the moldboard turned aslant across the way under the circle, as
// the eye sees it (`moldboard`): its face to the eye, hollow under the lip, the end of its near end with the rib, the box and
// the rail along its back, and the cutting edge bolted along its foot, worn bright where it meets the ground, an end bit
// over either end of it. The lift ram and the ram that shifts the circle come down aslant from the lift group over the
// frame. It stands in the open: between its parts is the world behind it.
// The paint of the plates of a road tool that face the eye — the moldboard of a blade, the wing of a paver's hopper —:
// steel in the ochre of its maker, and another metal bare, in an olive of the same light, which takes the tone of that
// metal as the rest of the machine does (component-art.ts `metalRgb`, which leaves a warm paint as it is).
const toolPaint = (options: ComponentArtOptions, ochre: string) => options.metal && options.metal !== 'steel' ? '#7c8460' : ochre;
function paintBlade(a: MachineKit, W: number, H: number, options: ComponentArtOptions) {
  const rig = bladeRig(W, H, options.hang), part = options.part, all = !part;
  if (all || part === 'neck') bladeNeck(a, rig);
  if (all || part === 'assembly') bladeAssembly(a, rig, W, H, options);
  if (all) for (const name of ['shift', 'lift'] as const) { const { top, foot, barrel } = rig[name]; ram(a, top.x, top.y, foot.x, foot.y, rig.d, barrel); }
  if (all || part === 'frame') bladeFrame(a, rig, W);
}
// The saddle under the rails, bolted up into them, the bracket of the ball at its front, and the ball in the socket of the
// drawbar's neck: the neck turns down about it.
function bladeFrame(a: MachineKit, rig: BladeRig, W: number) {
  const { saddle, ball, s } = rig;
  a.circle(ball.x, ball.y, ball.r * 1.45, '#46513f', OUTLINE, a.edge);
  a.housing(W * .03, 0, W * .94, saddle, '#4b5742', .004);
  along(W * .03 + .02, W * .94 - .04, .12, (x: number) => a.stud(x, saddle * .5, Math.min(.007, saddle * .28), 'y'));
  a.housing(ball.x - ball.r * 1.35, saddle - .004 * s, ball.r * 2.5, ball.y - saddle + ball.r * .7, '#46513f', .006);
  a.bolt(ball.x - ball.r * .55, saddle + (ball.y - saddle) * .35, Math.min(.006, ball.r * .3));
  a.circle(ball.x, ball.y, ball.r, a.radial(ball.x, ball.y, ball.r, ([[0, '#b7bba6'], [.6, '#7f8873'], [1, '#3e483a']]), ball.x - ball.r * .35, ball.y - ball.r * .4), OUTLINE, a.edge);
}
// The neck of the drawbar, a welded box from the socket round the ball (which stays with the frame) back to the yoke,
// where it is pinned.
function bladeNeck(a: MachineKit, rig: BladeRig) {
  const { ball, pin, yoke, s } = rig, steel = '#56614c', socket = ball.r * 1.45;
  beam(a, strut([ball.x, ball.y], [pin.x - .02 * s, pin.y], ball.r * 2.2, yoke.foot - yoke.top - .01 * s), steel,
    [ball.x - socket, ball.y + ball.r * .15, pin.x, pin.y + .004 * s]);
  a.finish?.face({ x: pin.x, y: ball.y - socket, width: ball.x - pin.x, height: socket * 2 });
}
// How lit the face of the moldboard is at a share `t` of the height of its plate: the top of its lip in the light, the
// hollow under the lip in its own shade, and the face below it lit again, darker towards its foot.
const LIGHT = ([[0, .5], [.04, .3], [.1, -.5], [.26, -.4], [.45, -.12], [.72, .12], [1, -.2]] satisfies readonly [number, number][]);
const light = (t: number) => {
  const i = Math.max(1, LIGHT.findIndex(([at]) => at >= t)), [t0, v0] = LIGHT[i - 1]!, [t1, v1] = LIGHT[i]!;
  return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
};
// What hangs from the yoke and goes down with it: the yoke, the circle and its drive, the arms, and the moldboard.
function bladeAssembly(a: MachineKit, rig: BladeRig, W: number, H: number, options: ComponentArtOptions) {
  const { yoke, pin, circle, board, drive, d, s } = rig, steel = '#56614c', paint = toolPaint(options, '#8a7c48'), at = (f: number) => H * f;
  // The yoke, the rear of the drawbar, over the whole of the circle, and the lug at its front the neck is pinned to.
  beam(a, ([[yoke.rear, yoke.top + .01 * s], [yoke.front, yoke.top], [yoke.front, yoke.foot], [yoke.rear + .02 * s, yoke.foot]]), steel,
    [yoke.rear + .03 * s, (yoke.top + yoke.foot) / 2, yoke.front - .02 * s, (yoke.top + yoke.foot) / 2]);
  a.finish?.face({ x: yoke.rear, y: yoke.top, width: yoke.front - yoke.rear, height: yoke.foot - yoke.top });
  const lug = Math.min(.03 * s, (yoke.foot - yoke.top) * .45);
  a.housing(pin.x - lug, pin.y - lug, lug * 2, lug * 2, '#46513f', .004);
  a.circle(pin.x, pin.y, lug * .55, '#2b332d', OUTLINE, a.hair(1)); a.bolt(pin.x, pin.y, Math.min(.007, lug * .3));
  // The circle, edge on: its teeth along it, the shoes that hold it up to the yoke.
  const span = circle.front - circle.rear;
  for (const u of [.08, .44, .8]) a.housing(circle.rear + span * u, yoke.foot - .004 * s, span * .1, circle.top - yoke.foot + .006 * s, '#4b5742', .003);
  a.housing(circle.rear, circle.top, span, circle.foot - circle.top, '#5a6550', .004);
  along(circle.rear + .01, span - .02, .024,
    (x: number) => a.line(x, circle.top + (circle.foot - circle.top) * .45, x, circle.foot - .002, '#1a221dc0', Math.max(a.hair(1), .0016)));
  // The drive of the circle standing on the yoke, outside it: its gearbox, the motor on it, both round about the upright shaft.
  const upright = (x: number, y: number, w: number, h: number, base: string) => {
    a.path(x, y, w, h, Math.min(.006, w * .1));
    a.fill(a.gradient(x, 0, x + w, 0, ([[0, shade(base, -.45)], [.3, shade(base, .18)], [.55, base], [1, shade(base, -.5)]])));
    a.stroke(OUTLINE, a.edge); a.finish?.face({ x, y, width: w, height: h, radius: Math.min(.006, w * .1) });
  };
  const gear = yoke.top + (yoke.foot - yoke.top) * .2;
  upright(drive.x + drive.w * .18, drive.top, drive.w * .64, gear - drive.top, '#59654f');
  upright(drive.x, gear, drive.w, circle.top - gear, '#4f5a46');
  along(drive.x, drive.w, .03, (x: number) => a.stud(x, gear, Math.min(.005, at(.015)), 'x'));
  const { face, back, foot, k } = moldboard(rig), xy = (p: Point): XY => [p.x, p.y], ts = Array.from({ length: 17 }, (_, i: number) => i / 16);
  // The arms down from the circle, the far one further off, each behind the moldboard's top to the guide of its upper box,
  // which shows over the lip; and from the near one to its guide, the ram that tips the moldboard.
  for (const u of [.7, .28]) {
    const n = k(u), lip = face(u, 0), hang = { x: lip.x - .05 * s * n, y: lip.y + .03 * s * n }, top = { x: hang.x - .035 * s * n, y: circle.foot - .004 * s },
      guide = { x: hang.x - .03 * s * n, y: lip.y - .016 * s * n, w: .06 * s * n, h: .04 * s * n };
    beam(a, strut([top.x, top.y], [hang.x, hang.y], .05 * s * n, .034 * s * n), '#4b5742');
    a.housing(guide.x, guide.y, guide.w, guide.h, '#46513f', .003);
    a.bolt(hang.x, guide.y + guide.h * .4, Math.min(.007, .012 * s * n));
    if (u < .5) ram(a, top.x + .03 * s, top.y + .012 * s, guide.x + guide.w + .012 * s, guide.y + guide.h * .3, d * .6);
  }
  // The near end, turned to the eye: the rib at the end of the moldboard from the back of its plate to its straight back,
  // along which the box of its upper edge and the rail of its lower one run away from the eye, seen end on; the end of its
  // plate, and of the cutting edge under it.
  const y = (t: number) => face(0, t).y, spine = back(0, .42).x - .014 * s * CROSS,
    upperSize = { w: .036 * s * CROSS, h: .036 * s }, lowerSize = { w: .026 * s * CROSS, h: .024 * s };
  const upper = Object.assign(upperSize, { x: spine + .004 * s - upperSize.w, y: y(0) + .002 * s });
  const lower = Object.assign(lowerSize, { x: spine + .003 * s - lowerSize.w, y: y(.8) - lowerSize.h / 2 });
  a.shape([...ts.filter((t: number) => t <= .92).map((t: number) => xy(back(0, t))), [spine, y(.92)], [spine, y(0)]]);
  a.fill(a.gradient(0, y(0), 0, y(.92), ([[0, shade(paint, -.25)], [1, shade(paint, -.55)]]))); a.stroke(OUTLINE, a.edge);
  for (const [r, base] of [[upper, shade(paint, -.18)], [lower, '#656c58']] satisfies [ArtBox, string][]) {
    a.path(r.x, r.y, r.w, r.h, .003 * s);
    a.fill(a.gradient(0, r.y, 0, r.y + r.h, ([[0, shade(base, .3)], [.3, base], [1, shade(base, -.45)]]))); a.stroke(OUTLINE, a.edge);
  }
  a.shape([...ts.map((t: number) => xy(face(0, t))), ...ts.slice().reverse().map((t: number) => xy(back(0, t)))]);
  a.fill(shade(paint, .12)); a.stroke(OUTLINE, a.edge);
  a.shape([[back(0, 1).x, y(1) - .004 * s], [face(0, 1).x, y(1) - .004 * s], xy(foot(0)), xy(foot(0, 1))]);
  a.fill('#4a5146'); a.stroke(OUTLINE, a.edge);
  // The face, from the near end to the far one: each band of its height lit as the curve of the plate takes the light,
  // laid a little over the next; then its outline, and the top of its lip in the light.
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i]!, t1 = Math.min(1, ts[i + 1]! + .02);
    a.shape([xy(face(0, t0)), xy(face(1, t0)), xy(face(1, t1)), xy(face(0, t1))]); a.fill(shade(paint, light((t0 + ts[i + 1]!) / 2)));
  }
  a.shape([...ts.map((t: number) => xy(face(0, t))), ...ts.slice().reverse().map((t: number) => xy(face(1, t)))]); a.stroke(OUTLINE, a.edge);
  a.finish?.face({ x: upper.x, y: y(0), width: face(1, 1).x - upper.x, height: foot(0).y - y(0) });
  a.line(face(0, 0).x, face(0, 0).y + a.hair(1), face(1, 0).x, face(1, 0).y + a.hair(1), shade(paint, .55), Math.max(a.hair(1.2), .003 * s));
  // The cutting edge along the foot of the plate, its plough bolts countersunk in it, worn bright along the bottom where it cuts.
  const seat = (u: number) => face(u, 1);
  a.shape([xy(seat(0)), xy(seat(1)), xy(foot(1)), xy(foot(0))]);
  a.fill(a.gradient(0, seat(0).y, 0, foot(0).y, ([[0, '#5d6459'], [1, '#3e453c']]))); a.stroke(OUTLINE, a.edge);
  a.line(foot(0).x, foot(0).y - a.hair(1), foot(1).x, foot(1).y - a.hair(1), '#c9ccb8', Math.max(a.hair(1.5), .003 * s));
  const length = foot(1).x - foot(0).x;
  along(0, length, .15, p => {
    const u = p / length, q = Math.min(.006, .004 * s) * k(u), c = { x: (seat(u).x + foot(u).x) / 2, y: (seat(u).y + foot(u).y) / 2 };
    a.path(c.x - q, c.y - q, 2 * q, 2 * q, q * .2); a.fill('#262c26'); a.stroke('#8d957f', a.hair(1));
  });
  // An end bit bolted over either end of the cutting edge and the corner of the plate over it.
  const from = .55, bit = Math.min(.07, .09 * s / length);
  for (const [u0, u1] of ([[0, bit], [1 - bit, 1]] satisfies readonly [number, number][])) {
    const n = k(u0), up = ts.filter((t: number) => t >= from);
    a.shape([...up.map((t: number) => xy(face(u0, t))), xy(foot(u0)), xy(foot(u1)), ...up.slice().reverse().map((t: number) => xy(face(u1, t)))]);
    a.fill(a.gradient(0, face(u0, from).y, 0, foot(u0).y, ([[0, '#59604f'], [1, '#383f36']]))); a.stroke(OUTLINE, a.edge);
    for (const t of [.72, .94]) { const p = face((u0 + u1) / 2, t); a.stud(p.x, p.y, Math.min(.006, .005 * s) * n, 'x'); }
  }
  a.wear(face(0, 0).x, y(0), face(1, 0).x - face(0, 0).x, y(1) - y(0), 43); a.wear(yoke.rear, yoke.top, yoke.front - yoke.rear, yoke.foot - yoke.top, 47);
}

// Where the parts of a paver stand in its box as it travels, in metres from its upper rear corner, its front at the right.
// The screed is at the rear of the box, its trailing edge at the rear end, where the field lays the asphalt behind it
// (road-tools.ts). At work it goes down plumb till that edge meets the ground, and sits on it (road-machine-motion.ts): the
// ram of three stages it hangs from, down from the upright, draws out as far as it goes down; the auger it carries before
// it goes down with it; and the tow arm pinned to its end plate turns down about the tow point and draws out, a beam out
// of the one pinned there (`slide` out of `arm`). Both reach as far as the field lowers the screed (road-machine-motion.ts
// `machineRig`). The slats of the conveyor run; what is left of the rear end of the box at work is the screed's room (`room`).
export function paverRig(W: number, H: number): PaverRig {
  const s = H / .9, at = (f: number) => H * f, base = at(.92), cy0 = at(.79), cr = (base - cy0) / 2, d = Math.max(.02, Math.min(.06, .04 * s)), collar = .02 * s,
    screed = { x0: W * TOOL_POINT.paver.x, x1: W * .19, skid: W * .15, top: at(.44), foot: at(TOOL_POINT.paver.y), console: at(.07) },
    tow = { x: W * .7, y: at(.74) }, pin = { x: W * .13, y: at(.76) },
    lift = { top: { x: screed.x1 + d * .7, y: at(.06) }, foot: { x: screed.x1 + d * .7, y: at(.62) } },
    rig: Omit<PaverRig, 'arm' | 'parts' | 'lift'> & { lift: RamEnds } = { s, d, base, room: W * .2, screed, tow, pin, lift, collar, armDepth: at(.06),
      conveyor: { x0: W * .37, x1: W * .88, top: cy0, r: cr, y: cy0 + cr, pitch: .05, slat: .024 },
      auger: { x: W * .275, y: at(.795), r: at(.085) } };
  // The lift ram as long as it is as the screed travels, its barrel all of it but a collar of each stage, and each stage
  // drawn out all but an overlap of three collars (`ramStages`).
  const travel = lift.foot.y - lift.top.y, completedLift = Object.assign(lift, { travel, barrel: travel - 3 * collar, shown: [collar, collar, collar], most: travel - 5 * collar, widths: TELESCOPE });
  // The beams of the tow arm, each as long as the arm is as the screed travels but for the room it keeps from the pin at
  // the other end, and drawn out as far as they keep an `overlap`.
  const length = Math.hypot(tow.x - pin.x, tow.y - pin.y), outer = length - .04 * s, inner = length - .06 * s;
  const arm = { length, outer, inner, overlap: .05 * s };
  // The box of each part's picture as it travels: the screed with the hanger of the auger and the lug of the ram, the auger,
  // and each beam of the arm from its pin, as far as it reaches.
  const depth = rig.armDepth, auger = rig.auger.r * 1.15, ux = (tow.x - pin.x) / length, uy = (tow.y - pin.y) / length,
    beamBox = (from: Point, reach: Point, half: number) => { const to = { x: from.x + reach.x, y: from.y + reach.y };
      return { x: Math.min(from.x, to.x) - half, y: Math.min(from.y, to.y) - half, w: Math.abs(to.x - from.x) + 2 * half, h: Math.abs(to.y - from.y) + 2 * half }; };
  const parts = { screed: { x: 0, y: screed.console - .004 * s, w: Math.max(lift.foot.x + d, rig.auger.x) + .01 * s, h: screed.foot - screed.console + .01 * s },
    auger: { x: rig.auger.x - auger, y: rig.auger.y - auger, w: auger * 2, h: auger * 2 },
    slide: beamBox(pin, { x: ux * inner, y: uy * inner }, depth * .6),
    arm: beamBox(tow, { x: -ux * outer, y: -uy * outer }, depth * .6) };
  return Object.assign(rig, { lift: completedLift, arm, parts });
}
// The slats of the conveyor's chain along its two runs, `run` metres on: the upper run carries the mix back to the auger
// and the lower one comes forward again, and the sprocket at either end hides what passes round it. Each is a box of
// [x, y, width, height], and the light or the dark of its run.
export function conveyorSlats(rig: PaverRig, run = 0) {
  const { x0, x1, top, r, y, pitch, slat } = rig.conveyor, base = rig.base, hub = r * .8, slats: [number, number, number, number, string][] = [],
    upper: [number, number, string] = [top + .003, r * .5, '#8d907e'], lower: [number, number, string] = [base - .003 - r * .4, r * .4, '#5d6154'], { n, start } = spread(x1 - x0, pitch);
  for (const [sy, sh, color, way] of [[...upper, -1], [...lower, 1]] satisfies [number, number, string, number][]) {
    const shift = ((way * run) % pitch + pitch) % pitch, mid = sy + sh / 2, cover = Math.sqrt(Math.max(0, hub * hub - (mid - y) ** 2));
    for (let i = -1; i <= n; i++) {
      const cx = x0 + start + (i + .5) * pitch + shift, from = Math.max(cx - slat / 2, x0 + cover, x0 - r), to = Math.min(cx + slat / 2, x1 - cover, x1 + r);
      if (to - from > 1e-4) slats.push([from, sy, to - from, sh, color]);
    }
  }
  return slats;
}
// A paver, as a Vögele Super 1800's tractor end is laid out, on the bed of a chassis that does its travelling: the frame
// it is bolted down by; the hopper at the front, a wing of it seen by its side plate, with the ribs that stiffen it, the
// ram that folds it and the push roller the lorries back on to at its foot; the slat conveyor under it, the chain of slats
// round a sprocket at either end, that feeds the mix back to the auger at the rear, seen end on; the hydraulic pack and
// the generator that heats the screed in the middle, under a handrail; at the rear the screed, lifted into the box as it
// travels, low behind the upright as a paver's sits behind its tractor: its end plate with the crank of its depth and the
// console of its controls on a post, the auger it carries before it on a hanger, the ram of three stages it hangs from
// down the front of it from the top of the upright, and the tow arm, low along the side, forward from its end plate to
// the tow point, set up or down by the ram over that.
function paintPaver(a: MachineKit, W: number, H: number, options: ComponentArtOptions) {
  const rig = paverRig(W, H), part = options.part, all = !part;
  if (all) a.underlay(W, H);
  else if (part === 'frame') { a.ctx.save(); a.ctx.beginPath(); a.ctx.rect(rig.room, 0, W - rig.room, H); a.ctx.clip(); a.underlay(W, H); a.ctx.restore(); }
  if (all || part === 'frame') paverFrame(a, rig, W, H, all, options);
  if (all || part === 'screed') paverScreed(a, rig, W, H);
  if (all || part === 'auger') paverAuger(a, rig);
  if (all || part === 'slide') paverSlide(a, rig);
  if (all || part === 'arm') paverArm(a, rig);
  if (all) telescope(a, rig.lift.top.x, rig.lift.top.y, rig.lift.foot.x, rig.lift.foot.y, rig.d, ramStages(rig.lift, rig.lift.travel));
}
// All that stays with the tractor: the frame, the upright with the lug the screed's ram hangs from, the pack, the conveyor
// — its slats too on the whole picture —, the hopper, the push roller, and the tow point with the ram over it.
function paverFrame(a: MachineKit, rig: PaverRig, W: number, H: number, slats: boolean, options: ComponentArtOptions) {
  const { d, base, conveyor: c, tow, lift } = rig, at = (f: number) => H * f, paint = toolPaint(options, '#857a4e'), steel = '#4f5a45';
  // The frame, bolted down to the bed.
  a.housing(0, base, W, H - base, '#3e493a', .004);
  along(.02, W - .04, .2, (x: number) => a.stud(x, (base + H) / 2, Math.min(.007, (H - base) * .2), 'y'));
  // The upright at the rear the screed hangs from, the lug of its ram over the top of it, and the pack in the middle under
  // its handrail.
  a.housing(W * .205, at(.06), W * .095, base - at(.06), steel, .006);
  a.housing(lift.top.x - d * .8, lift.top.y - d * .7, W * .3 - lift.top.x + d * .8, d * 1.4, '#46513f', .004);
  a.housing(W * .3, at(.1), W * .33, at(.74) - at(.1), '#55614b', .01);
  along(at(.15), at(.24), .022, (y: number) => a.rib(W * .32, y, W * .61, y, .0025));
  a.housing(W * .32, at(.44), W * .14, at(.24), '#4b5742', .006);
  along(W * .32 + .008, W * .14 - .016, .018, (x: number) => a.rib(x, at(.47), x, at(.65), .0022));
  a.housing(W * .48, at(.44), W * .13, at(.26), '#5a6650', .008);
  a.path(W * .48 + .012, at(.5), Math.min(.016, W * .02), at(.12), .004); a.fill('#20291f'); a.stroke('#9aa48c', a.hair(1));
  for (const x of [W * .31, W * .62]) a.tube(([[x, at(.1)], [x, at(.025)]]), Math.min(.02, d * .5), '#c8a63c');
  a.tube(([[W * .31, at(.025)], [W * .62, at(.025)]]), Math.min(.02, d * .5), '#c8a63c');
  // The conveyor: a chain of slats round a sprocket at either end, its upper run carrying the mix back to the auger.
  a.path(c.x0 - c.r, c.top, c.x1 - c.x0 + 2 * c.r, base - c.top, c.r); a.fill('#262c27'); a.stroke(OUTLINE, a.edge);
  a.finish?.protect({ x: c.x0 - c.r, y: c.top, width: c.x1 - c.x0 + 2 * c.r, height: base - c.top, radius: c.r });
  if (slats) for (const [x, y, w, h, color] of conveyorSlats(rig)) { a.path(x, y, w, h, .002); a.fill(color); }
  for (const x of [c.x0, c.x1]) {
    a.circle(x, c.y, c.r * .8, a.radial(x, c.y, c.r * .8, ([[0, '#8f9a84'], [.7, '#5b6553'], [1, '#2f382f']]), x - c.r * .25, c.y - c.r * .3), OUTLINE, a.edge);
    a.circle(x, c.y, c.r * .32, '#3b4538'); a.bolt(x, c.y, Math.min(.006, c.r * .2));
  }
  // The floor of the hopper over the conveyor, and the side plate of its wing, stiffened, with the ram that folds it.
  a.housing(W * .3, at(.73), W * .69, c.top - at(.73), steel, .003);
  beam(a, ([[W * .6, at(.045)], [W * .995, at(.045)], [W * .995, at(.73)], [W * .66, at(.73)]]), paint);
  a.finish?.face({ x: W * .6, y: at(.045), width: W * .395, height: at(.685) });
  along(W * .68, W * .3, .14, (x: number) => a.rib(x, at(.1), x, at(.7), .0035));
  a.housing(W * .595, at(.03), W * .405, Math.min(.03, at(.04)), shade(paint, -.15), .004);
  ram(a, W * .75, at(.67), W * .9, at(.13), d);
  // The push roller the lorries back on to, its axle across the vehicle.
  const pr = Math.min(at(.065), .06), px = W - pr - .006, py = at(.84);
  a.housing(W * .93, at(.74), W * .07, base - at(.74), '#46513f', .004);
  a.circle(px, py, pr, a.radial(px, py, pr, ([[0, '#6c7363'], [.7, '#3e443a'], [1, '#1d221d']]), px - pr * .3, py - pr * .35), OUTLINE, a.edge);
  a.bolt(px, py, Math.min(.007, pr * .2));
  // The tow point, low on the tractor, with the ram over it that sets it up or down.
  a.housing(tow.x - W * .03, tow.y - at(.08), W * .06, at(.12), '#46513f', .004);
  ram(a, tow.x, at(.5), tow.x, tow.y - at(.06), d * .8);
  a.wear(W * .6, at(.08), W * .38, at(.6), 53); a.wear(W * .3, at(.1), W * .33, at(.3), 59);
}
// The auger, end on: its flight round the shaft, the bearing it turns in.
function paverAuger(a: MachineKit, rig: PaverRig) {
  const { x, y, r } = rig.auger;
  a.circle(x, y, r, a.radial(x, y, r, ([[0, '#9aa08c'], [.6, '#6a7060'], [1, '#353b32']]), x - r * .3, y - r * .35), OUTLINE, a.edge);
  for (let k = 0; k < 3; k++) {
    const t = k * TAU / 3;
    a.line(x + Math.cos(t) * r * .35, y + Math.sin(t) * r * .35, x + Math.cos(t + .9) * r * .95, y + Math.sin(t + .9) * r * .95, '#2a3029', Math.max(a.hair(1.2), .003));
  }
  a.circle(x, y, r * .3, '#4b5742', OUTLINE, a.hair(1)); a.bolt(x, y, Math.min(.007, r * .18));
}
// The screed: the hanger the auger turns in, forward from its front, and the lug its ram is pinned to; its end plate with
// the skid it floats on, the box of its tamper, the crank that sets its depth, and the console of its controls on its post.
function paverScreed(a: MachineKit, rig: PaverRig, W: number, H: number) {
  const { screed: sc, d, s, auger, lift } = rig, at = (f: number) => H * f, h = sc.foot - sc.top, y = (f: number) => sc.top + h * f, x = (f: number) => sc.x1 * f;
  a.housing(sc.x1 - .01 * s, auger.y - auger.r * .35, auger.x - sc.x1 + .01 * s, auger.r * .7, '#46513f', .004);
  a.housing(sc.x1 - .01 * s, lift.foot.y - d * .7, lift.foot.x - sc.x1 + d * .8, d * 1.4, '#46513f', .004);
  beam(a, ([[0, sc.top], [sc.x1, sc.top], [sc.x1, y(.78)], [sc.skid, sc.foot], [0, sc.foot]]), '#5b5f50');
  a.finish?.face({ x: 0, y: sc.top, width: sc.x1, height: h });
  a.housing(x(.09), y(.14), x(.55), h * .3, '#4b5742', .005);
  a.housing(0, sc.foot - h * .08, x(.85), h * .08, '#3a4036', .002);
  a.line(.004, sc.foot - a.hair(1.5), sc.skid, sc.foot - a.hair(1.5), '#c9ccb8', Math.max(a.hair(1.5), .003));
  a.tube(([[x(.82), sc.top + at(.02)], [x(.82), at(.32)]]), Math.min(.016, d * .4), '#9aa48c');
  a.tube(([[x(.82), at(.32)], [x(.97), at(.32)], [x(.97), at(.29)]]), Math.min(.012, d * .3), '#c8a63c');
  a.tube(([[x(.42), sc.top], [x(.42), at(.26)]]), Math.min(.02, d * .5), '#3f483d');
  a.housing(x(.06), sc.console, x(.85), at(.2), '#4b5742', .006);
  const scr = Math.min(.05, x(.3));
  a.path(x(.15), at(.1), scr, Math.min(scr * .7, at(.08)), .003); a.fill('#141a26'); a.stroke('#5f6a64', a.hair(1));
  a.finish?.protect({ x: x(.15), y: at(.1), width: scr, height: Math.min(scr * .7, at(.08)), radius: .003 });
  along(x(.15), x(.52), .02, bx => { a.path(bx - .005, at(.21), .01, .01, .002); a.fill('#c8a63c'); a.stroke(OUTLINE, a.hair(1)); });
  a.wear(0, sc.top, sc.x1, h * .7, 61);
}
// The tow arm: the beam that draws out of it, back to the pin on the screed's end plate (`slide`), and the beam pinned to
// the tow point, a gland at its rear end the other draws out of (`arm`).
function paverSlide(a: MachineKit, rig: PaverRig) {
  const { pin, tow, s, armDepth: depth, arm } = rig, u = { x: (tow.x - pin.x) / arm.length, y: (tow.y - pin.y) / arm.length },
    end: XY = [pin.x + u.x * arm.inner, pin.y + u.y * arm.inner];
  beam(a, strut([pin.x, pin.y], end, depth * .66, depth * .66), '#6b7461', [pin.x + u.x * .02 * s, pin.y + u.y * .02 * s, end[0], end[1]]);
  a.circle(pin.x, pin.y, depth * .4, '#2b332d', OUTLINE, a.hair(1)); a.bolt(pin.x, pin.y, Math.min(.008, depth * .18));
}
function paverArm(a: MachineKit, rig: PaverRig) {
  const { pin, tow, s, armDepth: depth, arm } = rig, u = { x: (pin.x - tow.x) / arm.length, y: (pin.y - tow.y) / arm.length },
    end: XY = [tow.x + u.x * arm.outer, tow.y + u.y * arm.outer], gland = .03 * s;
  beam(a, strut([tow.x, tow.y], end, depth, depth * .9), '#4f5a45', [tow.x + u.x * .02 * s, tow.y + depth * .1, end[0] - u.x * gland, end[1] + depth * .1]);
  beam(a, strut([end[0] - u.x * gland, end[1] - u.y * gland], end, depth * 1.08, depth * 1.08), '#3f493b');
  a.circle(tow.x, tow.y, depth * .46, '#2b332d', OUTLINE, a.hair(1)); a.bolt(tow.x, tow.y, Math.min(.008, depth * .2));
}

// A lift jet, as the Rolls-Royce RB162 that held up the Dornier Do 31 and the VAK 191B: a turbojet of one shaft, short and
// light, standing in its box as it stands in the vehicle, its axis upright, the air taken in at the top and thrown out at
// the foot. From the top down: the bell of its intake, its lip rolled round; the flange of the front bearing; the casing
// of its compressor of six stages, moulded of glass fibre, a joint between each stage and the next; the flange it is hung
// by, a trunnion out of it to either side, its pin across the vehicle and so seen end on; the annular combustion chamber,
// wider than the rest, the fuel manifold round it, the burners fed from it and the igniter's plug; the casing of its one
// turbine, browned and blued by the heat; and the short convergent nozzle, darkened, its exit at the foot of the box, a
// share `THRUSTER_NOZZLE` of its width (the jet out of it is drawn on its own, effects.ts `thrusterJet`). The fuel control
// unit hangs by the compressor on one side and the oil tank of its total-loss lubrication on the other. Each part of it is
// round about the upright axis, and so a band shaded round across it, lit from above; what is spread round it — the nuts
// of a flange, the burners — shows as round things do from the side, closer together towards either edge. It stands in
// the open and fills its box by its own outline: the lip from side to side at the top, the trunnions at the sides, the
// nozzle at the foot.
export const THRUSTER_NOZZLE = .52;
// How a band round the upright axis is lit across it: both its edges turned away into the shade, the light a third of the
// way across.
const ROUND = ([[0, -.6], [.14, -.14], [.32, .22], [.48, .06], [.74, -.2], [1, -.62]] satisfies readonly [number, number][]);
function paintThruster(a: MachineKit, W: number, H: number) {
  const cx = W / 2, at = (f: number) => H * f, wide = (f: number) => W * f, fl = Math.min(.02, at(.022)), nut = Math.min(.0055, fl * .3),
    pipe = Math.min(.014, wide(.022)), lip = at(.045), throatY = at(.125), compTop = throatY + fl, compFoot = at(.5),
    burnTop = compFoot + fl, burnFoot = at(.745), turbTop = burnFoot + fl, turbFoot = at(.835), exit = Math.min(.016, at(.016)),
    throat = wide(.7), comp: XY = [wide(.7), wide(.66)], flange = wide(.76), burner = wide(.8), turbine = wide(.67),
    nozzle: XY = [wide(.62), wide(THRUSTER_NOZZLE)], manifold = burnTop + Math.min(.04, (burnFoot - burnTop) * .22);
  const roundly = (base: string, from: number, to: number) => a.gradient(from, 0, to, 0, ROUND.map(([share, t]) => [share, shade(base, t)]));
  // A band round the axis about `mid`, from `y0` down to `y1`, `w0` wide at its top and `w1` at its foot — or of one width
  // with its corners rounded by `r` —, in `base` shaded round across it, the light along its top edge. It is given back to
  // be traced again for a tint laid over it (`tint`).
  const band = (mid: number, y0: number, y1: number, w0: number, w1: number, base: string, r = 0) => {
    const span = Math.max(w0, w1), corners: readonly [XY, XY, XY, XY] = [[mid - w0 / 2, y0], [mid + w0 / 2, y0], [mid + w1 / 2, y1], [mid - w1 / 2, y1]],
      trace = (ctx = a.ctx) => { ctx.moveTo(...corners[0]); for (let i = 1; i < 4; i++) ctx.lineTo(...corners[i]!); ctx.closePath(); },
      again = () => { if (r) a.path(mid - w0 / 2, y0, w0, y1 - y0, r); else { a.ctx.beginPath(); trace(); } };
    again(); a.fill(roundly(base, mid - span / 2, mid + span / 2)); a.stroke(OUTLINE, a.edge);
    a.finish?.face(r ? { x: mid - w0 / 2, y: y0, width: w0, height: y1 - y0, radius: r } : { x: mid - span / 2, y: y0, width: span, height: y1 - y0, path: trace });
    const inset = Math.max(r, a.hair(2));
    if (w0 > 2 * inset && y1 - y0 > a.hair(4)) a.line(mid - w0 / 2 + inset, y0 + a.hair(1), mid + w0 / 2 - inset, y0 + a.hair(1), GLINT + '48', a.hair(1));
    return { again, y0, y1 };
  };
  const tint = (part: ReturnType<typeof band>, stops: readonly GradientStop[]) => { part.again(); a.fill(a.gradient(0, part.y0, 0, part.y1, stops)); };
  // Things spread round a ring `width` across at `pitch`, those on its near side but for its very edges, where they turn
  // away: `draw` is given where each shows across the piece.
  const around = (width: number, pitch: number, draw: (x: number) => void) => {
    const n = Math.max(8, Math.round(Math.PI * width / pitch));
    for (let i = 0; i < n; i++) {
      const turn = (i + .5) * TAU / n, c = Math.cos(turn);
      if (Math.sin(turn) > 0 && Math.abs(c) < .9) draw(cx + width / 2 * c);
    }
  };
  // A flange at `y`, `width` across, and the nuts of its bolts standing on it.
  const ring = (y: number, width: number) => {
    band(cx, y, y + fl, width, width, '#7f8980');
    around(width - 4 * nut, .045, (x: number) => a.stud(x, y - nut * .4, nut, 'y'));
  };

  // The fuel line from the control unit down to the manifold, behind the trunnion it passes.
  const unitX = wide(.02), unitW = cx - comp[0] / 2 + wide(.05) - unitX, unitY = at(.2), unitH = at(.17), lineX = unitX + unitW * .4;
  a.tube(([[lineX, unitY + unitH], [lineX, manifold - pipe], [cx - burner / 2 + pipe, manifold]]), pipe * .7, '#8a8e7c');
  // The trunnions it is hung by, out of the flange under the compressor to the sides of the box: their bosses end on, on
  // the arms forged with the flange, the pin through each.
  const hang = compFoot + fl / 2, boss = Math.min(wide(.075), at(.04));
  for (const side of [-1, 1]) {
    const x = side < 0 ? boss : W - boss, inner = cx + side * (flange / 2 - fl), arm = boss * 1.3;
    a.housing(Math.min(x, inner), hang - arm / 2, Math.abs(inner - x), arm, '#4b5742', .004);
    a.finish?.protectCircle(x, hang, boss);
    a.circle(x, hang, boss, a.radial(x, hang, boss, ([[0, '#8d9a80'], [.6, '#66735a'], [1, '#3a4536']]), x - boss * .3, hang - boss * .35), OUTLINE, a.edge);
    a.circle(x, hang, boss * .55, '#323d33', '#9aa58a70', a.hair(1));
    a.bolt(x, hang, Math.min(.008, boss * .3));
  }

  // The bell of the intake, flaring out from its throat, and the lip rolled round over it, its two ends turned away.
  const top = lip * .55, flare = W / 2 - lip * .35,
    bell = (ctx: ArtContext) => { ctx.moveTo(cx - flare, top); ctx.quadraticCurveTo(cx - throat / 2, top, cx - throat / 2, throatY);
      ctx.lineTo(cx + throat / 2, throatY); ctx.quadraticCurveTo(cx + throat / 2, top, cx + flare, top); ctx.closePath(); };
  a.ctx.beginPath(); bell(a.ctx); a.fill(roundly('#89958b', cx - flare, cx + flare)); a.stroke(OUTLINE, a.edge);
  a.finish?.face({ x: cx - flare, y: top, width: 2 * flare, height: throatY - top, path: bell });
  a.line(cx - flare + lip, lip + a.hair(1.5), cx + flare - lip, lip + a.hair(1.5), '#0f1a15a0', Math.max(a.hair(1.5), .003));
  a.path(0, 0, W, lip, lip / 2);
  a.fill(a.gradient(0, 0, 0, lip, ([[0, shade('#a2aba0', .45)], [.3, shade('#a2aba0', .12)], [.62, '#a2aba0'], [1, shade('#a2aba0', -.5)]])));
  a.stroke(OUTLINE, a.edge);
  a.finish?.face({ x: 0, y: 0, width: W, height: lip, radius: lip / 2 });
  a.path(0, 0, W, lip, lip / 2); a.fill(a.gradient(0, 0, W, 0, ([[0, '#0c141070'], [.1, '#0c141000'], [.9, '#0c141000'], [1, '#0c141070']])));
  // The recessed throat is a narrow slot in side elevation, not an exposed
  // fan facing the camera. Its rolled lip stays visibly separate from the case.
  band(cx, lip * 1.12, lip * 1.42, wide(.84), wide(.8), '#202925');
  ring(throatY, wide(.74));

  // A graphite-coloured composite compressor case. Fine circumferential joints
  // and two longitudinal stays read as an engine housing rather than stacked drums.
  band(cx, compTop, compFoot, comp[0], comp[1], '#52576b');
  for (let k = 1; k < 6; k++) {
    const y = compTop + (compFoot - compTop) * k / 6, w = comp[0] + (comp[1] - comp[0]) * k / 6;
    a.line(cx - w / 2 + a.hair(2), y, cx + w / 2 - a.hair(2), y, '#171c2a70', a.hair(1));
    a.line(cx - w / 2 + a.hair(2), y + a.hair(1), cx + w / 2 - a.hair(2), y + a.hair(1), '#b9c2c728', a.hair(.6));
  }
  for (const side of [-1, 1]) {
    const x0 = cx + side * comp[0] * .31, x1 = cx + side * comp[1] * .31, stay = Math.min(.012, wide(.02));
    a.tube(([[x0, compTop + fl * .4], [x1, compFoot - fl * .4]]), stay, '#8b9689');
    for (const [x, y] of ([[x0, compTop + fl * .6], [x1, compFoot - fl * .6]] satisfies readonly [number, number][])) a.bolt(x, y, nut * .8);
  }
  a.wear(cx - comp[1] / 2, compTop, comp[1], compFoot - compTop, 71);
  ring(compFoot, flange);

  // The combustion chamber, wider than the rest; the manifold round its top and a burner fed from it every so far round;
  // the plug of the igniter.
  const shoulder = Math.min(.035, (burnFoot - burnTop) * .25), feed = Math.min(.035, (burnFoot - burnTop) * .2);
  band(cx, burnTop, burnFoot, burner, burner, '#8a958b', shoulder);
  a.rib(cx - burner / 2 + shoulder, at(.705), cx + burner / 2 - shoulder, at(.705), .003);
  around(burner - 2 * pipe, .09, (x: number) => a.tube(([[x, manifold], [x, manifold + feed]]), pipe * .6, '#8a8e7c'));
  a.tube(([[cx - burner / 2 - pipe * .3, manifold], [cx + burner / 2 + pipe * .3, manifold]]), pipe, '#9a9c88');
  const plug = Math.min(.03, wide(.05)), plugX = cx + burner * .28, plugY = at(.655);
  a.housing(plugX - plug / 2, plugY - plug / 2, plug, plug, '#4b5742', .003);
  a.bolt(plugX, plugY, Math.min(.007, plug * .3));
  a.wear(cx - burner / 2, burnTop, burner, burnFoot - burnTop, 73);
  ring(burnFoot, wide(.72));

  // The turbine's casing, straw and bronze where it ran hottest and purple towards the nozzle; the nozzle narrowing to its
  // exit, dark brown with the heat and purpled down to its lip; and the clamp that holds the one to the other, its latch to
  // the front. Their tints are warm and purple, never grey: the tone of the metal (component-art.ts `metalRgb`) leaves
  // them as the heat left them.
  const casing = band(cx, turbTop, turbFoot, turbine, turbine * .98, '#84715d');
  tint(casing, ([[0, '#c0904000'], [.45, '#8a4a6a30'], [1, '#5a3a7a48']]));
  const shell = band(cx, turbFoot, H - exit, nozzle[0], nozzle[1] * .98, '#4a3a30');
  tint(shell, ([[0, '#5a3a7a40'], [1, '#3a2a4a00']]));
  // Shallow seams in the convergent shell, darker at the hot lip. They stay in
  // profile; no flared rocket bell or variable afterburner petals are added.
  for (const u of [-.36, -.18, .18, .36]) {
    const y0 = turbFoot + Math.min(.014, at(.014)), y1 = H - exit * 1.5;
    a.line(cx + nozzle[0] * u, y0, cx + nozzle[1] * u, y1, '#161a23a0', a.hair(1.2));
    a.line(cx + nozzle[0] * u + a.hair(1), y0, cx + nozzle[1] * u + a.hair(1), y1, '#c4b29838', a.hair(.6));
  }
  band(cx, H - exit, H, nozzle[1], nozzle[1], '#5a4636');
  const strap = Math.min(.014, at(.014)), latch = Math.min(.005, strap * .35);
  band(cx, turbFoot - strap / 2, turbFoot + strap / 2, turbine * .98 + 2 * nut, turbine * .98 + 2 * nut, '#4b5742');
  a.housing(cx - strap, turbFoot - strap * .8, strap * 2, strap * 1.6, '#5d6a55', .002);
  a.stud(cx, turbFoot, latch, 'x');

  // The fuel control unit hung by the compressor: a ribbed cover held by a bolt at each corner.
  a.housing(unitX, unitY, unitW, unitH, '#5f6c55', .006);
  along(unitY + .012, unitH - .024, .03, (y: number) => a.rib(unitX + .008, y, unitX + unitW - .008, y, .0025));
  for (const y of [unitY + .008, unitY + unitH - .008]) for (const x of [unitX + .008, unitX + unitW - .008]) a.bolt(x, y, Math.min(.004, unitW * .06));
  // The oil tank on the other side, upright and so shaded round, its filler on top, its sight glass, and the pipe from its
  // foot into the bearing over the flange under the compressor.
  const tankX = cx + comp[0] / 2 - wide(.04), tankW = W - wide(.025) - tankX, tankY = at(.19), tankH = at(.17), filler = Math.min(.016, at(.014));
  a.tube(([[tankX + tankW / 2, tankY + tankH], [tankX + tankW / 2, compFoot - pipe], [cx + comp[1] / 2 - pipe, compFoot - pipe]]), pipe * .55, '#2c3229');
  band(tankX + tankW / 2, tankY, tankY + tankH, tankW, tankW, '#67745c', tankW * .3);
  a.housing(tankX + tankW * .3, tankY - filler, tankW * .4, filler, '#4b5742', .002);
  const glassX = tankX + tankW * .4, glassY = tankY + tankH * .35;
  a.path(glassX, glassY, tankW * .2, tankH * .35, .002); a.fill('#1a1f1c'); a.stroke('#9aa58a70', a.hair(1));
  a.finish?.protect({ x: glassX, y: glassY, width: tankW * .2, height: tankH * .35, radius: .002 });
}
export type MachineKit = ReturnType<typeof kit>;
export type MachineKind = keyof typeof PAINTERS;
export const isMachineKind = (kind: string): kind is MachineKind => MACHINE_KINDS.has(kind);
const PAINTERS = { engine: paintEngine, ammo: paintAmmo, command: paintCommand, sensor: paintSensor, blade: paintBlade, paver: paintPaver, thruster: paintThruster };
