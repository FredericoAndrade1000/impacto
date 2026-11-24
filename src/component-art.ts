import type { MetalLook, ArtBounds, ArtFinish, ComponentArtOptions, FinishProfile } from './vehicle-art-contract.ts';
import type { ModuleKind } from './materials.ts';
import type { WeatheringMaps } from './weathering.ts';
export type { MetalLook } from './vehicle-art-contract.ts';
import type { ArtContext, CanvasPaint, GradientStop, XY } from './canvas-art.ts';
import { paintGear } from './gear-art.ts';
import { paintCargo } from './cargo-art.ts';
import { isMachineKind, paintMachine, kit } from './machine-art.ts';
import { paintWeathering } from './weathering.ts';
import { CASING } from './work-arm.ts';
// Cached procedural cutaway artwork. Lighting and mechanical detail live in
// these canvases; the component solids and simulation dimensions stay simple.
// Every piece keeps the one rule of the art written in machine-art.ts: a side
// elevation, seen square on. Tanks lie lengthwise; engineering housings keep
// their winches and stowed tools within the ordinary component's fixed box.
const TAU = Math.PI * 2;

// A colour of the art as a piece of another metal shows it (`look`, from METALS): what is painted in the olive and the
// greys of the steel takes the hue of the metal, as grey as it is, lighter or darker; the rubber and the dark stay dark,
// and whatever has a colour of its own — the load, the fuel, a lamp, a warm brass — stays what it was.
export function metalRgb(r: number, g: number, b: number, look?: MetalLook | null): [number, number, number] {
  if (!look) return [r, g, b];
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2, d = max - min,
    s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    const R = r / 255, G = g / 255, B = b / 255;
    h = 60 * (max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4);
  }
  if (s >= .45 || !(h >= 60 && h <= 175 || s < .06)) return [r, g, b];
  const bright = Math.min(1, Math.max(0, (l - .1) / .2)),
    L = Math.min(1, Math.max(0, l + (look.lift > 0 ? look.lift * (1 - l) : look.lift * l) * bright)),
    S = look.saturation * Math.min(1, Math.max(.3, s / .15)), C = (1 - Math.abs(2 * L - 1)) * S,
    X = C * (1 - Math.abs(look.hue / 60 % 2 - 1)), m = L - C / 2, sector = Math.floor(look.hue / 60) % 6,
    R = sector === 0 || sector === 5 ? C : sector === 1 || sector === 4 ? X : 0,
    G = sector === 1 || sector === 2 ? C : sector === 0 || sector === 3 ? X : 0,
    B = sector === 3 || sector === 4 ? C : sector === 2 || sector === 5 ? X : 0;
  return [Math.round((R + m) * 255), Math.round((G + m) * 255), Math.round((B + m) * 255)];
}
// The same of a colour told as a number (Pixi's), and of a picture already painted.
export function metalColor(tone: number, look?: MetalLook | null) {
  if (!look) return tone;
  const [r, g, b] = metalRgb(tone >> 16 & 255, tone >> 8 & 255, tone & 255, look);
  return r << 16 | g << 8 | b;
}
// A radius confines the finish to a rim, leaving the surrounding tyre unchanged.
export function paintMetal(ctx: ArtContext, look: MetalLook | null | undefined, radius?: number) {
  if (!look) return;
  const { width, height } = ctx.canvas, image = ctx.getImageData(0, 0, width, height), data = image.data;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] && (radius === undefined ||
    ((i / 4) % width + .5 - width / 2) ** 2 + (Math.floor(i / 4 / width) + .5 - height / 2) ** 2 <= radius ** 2))
    [data[i], data[i + 1], data[i + 2]] = metalRgb(data[i]!, data[i + 1]!, data[i + 2]!, look);
  ctx.putImageData(image, 0, 0);
}

// Keep the physical faces and their protected fittings while the piece is
// drawn. Its material tint and grain are baked first; only then do these masks
// receive the finish, so oxide never passes through the metal recolouring.
type RetainedBounds = ArtBounds & { matrix: DOMMatrix; circle?: false };
interface RetainedCircle { x: number; y: number; radius: number; circle: true; matrix: DOMMatrix; path?: undefined }
function componentFinish(ctx: ArtContext, maps: WeatheringMaps | null | undefined, material: string): (ArtFinish & { paint(): void }) | null {
  if (!maps) return null;
  const faces: (RetainedBounds & { profile: FinishProfile })[] = [], protectedFaces: (RetainedBounds | RetainedCircle)[] = [],
    remember = <Bounds extends { x: number; y: number }>(bounds: Bounds) => ({ ...bounds, matrix: ctx.getTransform() }),
    trace = (face: RetainedBounds | RetainedCircle) => {
      ctx.setTransform(face.matrix);
      if (face.path) face.path(ctx);
      else if (face.circle) { ctx.moveTo(face.x + face.radius, face.y); ctx.arc(face.x, face.y, face.radius, 0, TAU); }
      else ctx.roundRect(face.x, face.y, face.width, face.height, face.radius || 0);
    };
  return {
    face(bounds: ArtBounds, profile: FinishProfile = {}) { if (bounds.width > 0 && bounds.height > 0) faces.push({ ...remember(bounds), profile }); },
    protect(bounds: ArtBounds) { if (bounds.width > 0 && bounds.height > 0) protectedFaces.push(remember(bounds)); },
    protectCircle(x: number, y: number, radius: number) { protectedFaces.push(remember({ x, y, radius, circle: true })); },
    paint() {
      if (!faces.length) return;
      ctx.save();
      try {
        // Intersect separate exclusions: overlapping protected fittings must
        // never cancel each other's holes through an even-odd union.
        for (const face of protectedFaces) {
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
          trace(face); ctx.clip('evenodd');
        }
        for (const face of faces) {
          ctx.beginPath(); trace(face);
          paintWeathering(ctx, maps, face, { material, chips: .15, rust: .09, dirt: .12, oil: 0, period: .32, ...face.profile });
        }
      } finally { ctx.restore(); }
    },
  };
}

// The optional returned pass belongs after the texture's material tint and
// grain. It contains only this paint's temporary geometric masks.
export function paintComponent(ctx: ArtContext, kind: ModuleKind, widthM = 5.04, heightM = .74, options: ComponentArtOptions = {}) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  if (kind === 'wheel' || kind === 'track') { paintGear(ctx, kind, widthM, heightM, options); return; }
  const finish = componentFinish(ctx, options.weathering, options.metal || 'steel'),
    painted = finish ? { ...options, finish } : options;
  if (kind === 'hopper' || kind === 'cistern' || kind === 'supply') { paintCargo(ctx, kind, widthM, heightM, painted); return finish?.paint; }
  if (isMachineKind(kind)) { paintMachine(ctx, kind, widthM, heightM, painted); return finish?.paint; }
  if (kind === 'builder' || kind === 'excavator' || kind === 'drill') {
    paintTool(ctx, kind, widthM, heightM, finish); return finish?.paint;
  }
  ctx.save(); ctx.scale(W / 400, H / 260);
  const recess = 3, path = (x: number, y: number, w: number, h: number, radius: number) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); };
  const metal = (x: number, y: number, w: number, h: number, base = '#68776b', round = 3) => {
    // Recessed bottom edge, cast face, then a narrow machined upper lip.
    ctx.fillStyle = '#101a17'; path(x, y + recess, w, h, round); ctx.fill();
    const g = ctx.createLinearGradient(x, y, x + w * .14, y + h);
    g.addColorStop(0, '#b0b6a4'); g.addColorStop(.065, base);
    g.addColorStop(.46, base); g.addColorStop(.80, '#3a4840'); g.addColorStop(1, '#24312b');
    ctx.fillStyle = g; path(x, y, w, h, round); ctx.fill();
    finish?.face({ x, y, width: w, height: h, radius: round }, { period: [.32 * 400 / widthM, .32 * 260 / heightM] });
    ctx.strokeStyle = '#18251f'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.strokeStyle = '#d6ddbe74'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + round + 1, y + 2); ctx.lineTo(x + w - round - 1, y + 2); ctx.stroke();
    ctx.strokeStyle = '#0b181a70'; ctx.beginPath(); ctx.moveTo(x + 3, y + h - 3); ctx.lineTo(x + w - 3, y + h - 3); ctx.stroke();
  };
  const bolt = (x: number, y: number, r: number = 3) => {
    ctx.fillStyle = '#14221dd9'; ctx.beginPath(); ctx.arc(x + .6, y + 1, r + 1.4, 0, TAU); ctx.fill();
    const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    g.addColorStop(0, '#d0d2ba'); g.addColorStop(.42, '#929c86'); g.addColorStop(1, '#48574a');
    ctx.fillStyle = g; ctx.beginPath();
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; k ? ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : ctx.moveTo(x + r, y); }
    ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#29392e'; ctx.lineWidth = .8; ctx.stroke();
    ctx.strokeStyle = '#233229'; ctx.lineWidth = Math.max(.7, r * .25);
    ctx.beginPath(); ctx.moveTo(x - r * .4, y + r * .25); ctx.lineTo(x + r * .4, y - r * .25); ctx.stroke();
  };
  const tube = (points: readonly XY[], color = '#4a5549', size = 8) => {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0e1a16'; ctx.lineWidth = size + 4;
    ctx.beginPath(); points.forEach(([x, y], i: number) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = size; ctx.stroke();
    ctx.strokeStyle = '#d0d1ac60'; ctx.lineWidth = Math.max(1, size * .23);
    ctx.beginPath(); points.forEach(([x, y], i: number) => i ? ctx.lineTo(x - .7, y - size * .2) : ctx.moveTo(x - .7, y - size * .2)); ctx.stroke();
  };
  // The shell and its seated foot reach the physical box. The filler uses
  // the upper clearance; transparent margins cannot make a seated tank float.
  const straps = [94, 298], aspect = 400 * heightM / (260 * widthM);
  metal(1.25, 32, 397.5, 260 - 32 - recess, '#74816c', 14);
  ctx.strokeStyle = '#c5cbb054'; ctx.lineWidth = 1;
  path(6, 37, 388, 216, 10); ctx.stroke();
  // The two stiffening beads sit between the bands and stay shallow in the sheet.
  for (const y of [105, 187]) metal(118, y, 156, 8, '#7d8972', 4);
  for (const x of straps) {
    ctx.fillStyle = '#14251e99'; path(x - 12, 31, 27, 226, 5); ctx.fill();
    metal(x - 11, 31, 22, 225, '#53644e', 4);
    ctx.fillStyle = '#c1c8a24d'; ctx.fillRect(x - 8, 39, 1, 207);
    for (const y of [66, 241]) {
      metal(x - 16, y - 10, 32, 20, '#64735b', 3);
      // Correct only the fastener, so all four circular faces stay round in the real component's aspect.
      ctx.save(); ctx.translate(x, y); ctx.scale(aspect, 1); bolt(0, 0, 5); ctx.restore();
    }
  }
  // A central filler in profile, with knurls on its cap; no top-down circle or simulated level indicator.
  metal(174, 18, 44, 20, '#56654f', 3); metal(166, 1.25, 60, 20, '#65725b', 4);
  ctx.fillStyle = '#243326aa'; for (let x = 171; x < 223; x += 5) ctx.fillRect(x, 5, 1.4, 10);
  tube([[358, 75], [379, 75], [379, 118]], '#56654c', 5);
  metal(351, 65, 16, 21, '#65735b', 3);
  finish?.face({ x: 337, y: 67, width: 30, height: 43, radius: 6 },
    { chips: 0, rust: 0, dirt: .12, oil: .18, period: [.32 * 400 / widthM, .32 * 260 / heightM] });
  ctx.restore();
  return finish?.paint;
}

// These are the fixed hydraulic bases, not their separately articulated arms: their casing begins where the seat of the
// arm or the slewing base of the crane stands on it (`CASING`, work-arm.ts).
// Paint in metres with the same kit as the other machines: circular covers and
// fittings stay round on both a low excavator and a tall drill, even though their
// cached canvases share a resolution. There is no additional work per frame.
function paintTool(ctx: ArtContext, kind: 'builder' | 'excavator' | 'drill', W: number, H: number, finish: ArtFinish | null) {
  ctx.save(); ctx.scale(ctx.canvas.width / W, ctx.canvas.height / H);
  const a = kit(ctx, Math.min(ctx.canvas.width / W, ctx.canvas.height / H), finish, true),
    bolt = Math.min(.008, H * .025), rail = kind === 'builder' ? .84 : .79;
  a.housing(W * .018, H * rail, W * .964, H * (.977 - rail), '#485448', .009);
  a.housing(W * .05, H * CASING[kind], W * .9, H * (kind === 'builder' ? .823 : .795) - H * CASING[kind], '#8d8253', .015);
  for (const x of [.075, .255, .745, .925]) a.bolt(W * x, H * (rail + .065), bolt);
  for (const x of [.08, .92]) for (const y of [kind === 'builder' ? .32 : .22, .765]) a.bolt(W * x, H * y, bolt);

  if (kind === 'builder') {
    // A longitudinal winch drum in profile, its gear motor and cable guide.
    // The right cabinet has actual drawers and latches rather than tool icons.
    a.housing(W * .075, H * .36, W * .46, H * .42, '#36463b', .008);
    a.housing(W * .09, H * .47, W * .13, H * .23, '#63725f', .008);
    for (let i = 1; i < 5; i++) a.rib(W * (.09 + i * .026), H * .49, W * (.09 + i * .026), H * .68);
    a.housing(W * .245, H * .46, W * .215, H * .25, '#778176', .003);
    const turns = Math.min(36, Math.max(8, Math.round(W * .215 / .012)));
    for (let i = 0; i < turns; i++) {
      const x = W * (.25 + .202 * i / (turns - 1));
      a.line(x, H * .47, x, H * .70, '#29342f', a.hair(1));
    }
    for (const x of [.23, .46]) a.housing(W * x, H * .405, W * .018, H * .36, '#687360', .003);
    a.tube([[W * .35, H * .46], [W * .52, H * .43], [W * .54, H * .38]], Math.min(.008, H * .018), '#8f9988');
    a.housing(W * .50, H * .35, W * .05, H * .09, '#566550', .003);
    a.housing(W * .59, H * .35, W * .31, H * .43, '#4f6050', .008);
    for (const y of [.37, .50, .63]) {
      a.housing(W * .61, H * y, W * .27, H * .105, '#65745d', .004);
      a.line(W * .69, H * (y + .045), W * .79, H * (y + .045), '#17271e', Math.min(.007, H * .015));
      a.bolt(W * .85, H * (y + .05), bolt * .65);
    }
    a.wear(W * .07, H * .30, W * .85, H * .48, 3);
  } else if (kind === 'excavator') {
    // Cooler, hydraulic pump and a bank of capped hose connections.
    a.housing(W * .085, H * .285, W * .38, H * .43, '#53644f', .008);
    const slots = Math.min(14, Math.max(5, Math.round(H * .38 / .035)));
    for (let i = 0; i < slots; i++) {
      const y = H * (.32 + .33 * i / (slots - 1));
      a.line(W * .105, y, W * .44, y, '#1d2b23', H * .018);
      a.line(W * .105, y + H * .012, W * .44, y + H * .012, '#a5af8c66', a.hair(1));
    }
    const x = W * .715, y = H * .46, r = Math.min(W * .155, H * .215);
    a.housing(W * .53, H * .28, W * .36, H * .36, '#6c7454', .01);
    a.circle(x, y, r, a.radial(x, y, r, [[0, '#8e997d'], [.7, '#5d6d52'], [1, '#344633']]), '#192a20', a.edge);
    a.circle(x, y, r * .43, '#79876b', '#2a3c2a', a.edge);
    for (let i = 0; i < 6; i++) a.bolt(x + Math.cos(i * TAU / 6) * r * .78, y + Math.sin(i * TAU / 6) * r * .78, bolt * .75);
    a.housing(W * .52, H * .68, W * .36, H * .10, '#465943', .004);
    for (let i = 0; i < 4; i++) {
      const x = W * (.56 + i * .09);
      a.tube([[x, H * .72], [x, H * .62], [x - W * .03, H * .60]], Math.min(.012, H * .027), '#27382b');
      a.housing(x - W * .018, H * .695, W * .036, H * .05, '#92977b', .002);
    }
    a.housing(W * .65, H * .016, W * .128, H * .188, '#687461', .005);
  } else {
    // The drill has a vertical drive, feed guides and an accessible gearbox.
    // Its gearbox cover is round; the upright motor below is seen in profile.
    for (const x of [.12, .82]) {
      a.housing(W * x, H * .27, W * .055, H * .47, '#59695a', .004);
      for (const y of [.31, .48, .68]) a.bolt(W * (x + .0275), H * y, bolt);
    }
    a.housing(W * .26, H * .285, W * .48, H * .30, '#5e6f59', .012);
    const x = W * .5, y = H * .43, r = Math.min(W * .20, H * .105);
    a.circle(x, y, r, a.radial(x, y, r, [[0, '#8c967a'], [.8, '#596a51'], [1, '#314332']]), '#233626', a.edge);
    a.circle(x, y, r * .38, '#879078', '#2a3b28', a.edge);
    for (let i = 0; i < 6; i++) a.bolt(x + Math.cos(i * TAU / 6) * r * .78, y + Math.sin(i * TAU / 6) * r * .78, bolt * .8);
    a.housing(W * .36, H * .59, W * .28, H * .17, '#62715a', .01);
    for (let i = 0; i < 5; i++) a.rib(W * (.39 + i * .05), H * .605, W * (.39 + i * .05), H * .74);
    a.tube([[W * .3, H * .37], [W * .23, H * .37], [W * .23, H * .71], [W * .34, H * .71]], Math.min(.016, W * .025), '#293b2c');
    a.housing(W * .65, H * .016, W * .128, H * .188, '#687461', .005);
  }
  ctx.restore();
}
