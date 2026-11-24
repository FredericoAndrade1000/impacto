import { Random, clamp } from './math.ts';
import { canvas, paintSurfaceMetres, pieceTexture } from './textures.ts';
import { kit, shade } from './machine-art.ts';
import { BEVEL, fenderLine, fenderOver, outlineEdges } from './hull-details.ts';
import { paintWeathering } from './weathering.ts';
import { VEHICLE_DETAILS } from './vehicle-details.ts';
import { context2d } from './canvas-art.ts';
import type { ArtCanvas, ArtContext, CanvasPaint, XY } from './canvas-art.ts';
import type { Point, Pose } from './math.ts';
import type { WeatheringMaps, WeatheringBounds } from './weathering.ts';
import type { WeatheringProfile } from './weathering.ts';
type FinishProfile = Partial<WeatheringProfile>;
import type { HullFitting, HullFittingKind, HullEdge, hullLayout } from './hull-details.ts';
import type { AuthoredDetail } from './construction-contract.ts';
import type { DetailKind } from './vehicle-details.ts';
export interface HullArtwork { left: number; bottom: number; width: number; height: number; points: Point[];
  side: 'inside' | 'outside'; contour: string; key: string }
export type HullLayout = ReturnType<typeof hullLayout>;
export interface HullSurfaces { concrete?: Float32Array | undefined; inside?: Float32Array | undefined; outside?: Float32Array | undefined }
export type PaintDetail = Pick<AuthoredDetail, 'kind' | 'x' | 'y' | 'width' | 'height' | 'angle'> &
  { mirrored?: boolean | undefined; text?: string | undefined; mask?: readonly Point[] | undefined };
export interface DetailBox { left: number; bottom: number; width: number; height: number; letteringMirror?: boolean | undefined; polygon?: readonly Point[] | undefined }
export interface HullImpact extends Point { angle: number; radius: number; kind: string; variant: number; opacity: number }
export interface HullMark extends Point { angle: number; radius: number; kind: string; u: number; v: number; strength?: number | undefined }
type Tone = (color: readonly number[], factor: number, alpha?: number) => string;
interface HullArt { ctx: ArtContext; weathering: WeatheringMaps | null | undefined; w: number; h: number; points: readonly Point[];
  edges: HullEdge[]; px: number; random: Random; layout: HullLayout; tone: Tone; outline(): void }
type FittingKit = ReturnType<typeof kit> & { weathering: WeatheringMaps | null; material: string };
type FittingMeta = Partial<Pick<HullFitting, 'text' | 'count'>>;


// A clipped backing is decoration only. Its shape, paint, side and any layout baked into it form the cache key;
// the metal inner wall has no baked equipment or fittings. Movement, zoom, damage
// and mechanical state never regenerate this artwork. A hull is seen from `inside`, cut open, by whoever sees into it, and from `outside` by any other side.
// The shape alone (`contour`) tells apart the outline of the skin (silhouette.ts), whatever is painted on it.
export function hullArtwork(polygon: readonly Point[], paint: number, side: 'inside' | 'outside' = 'inside', layout = ''): HullArtwork {
  const left = Math.min(...polygon.map(p => p.x)), bottom = Math.min(...polygon.map(p => p.y)),
    width = Math.max(.001, Math.max(...polygon.map(p => p.x)) - left),
    height = Math.max(.001, Math.max(...polygon.map(p => p.y)) - bottom),
    points = polygon.map(p => ({ x: p.x - left, y: p.y - bottom })), contour = 'hull:' + points.map(p => p.x.toFixed(5) + ',' + p.y.toFixed(5)).join(';');
  return { left, bottom, width, height, points, side, contour, key: 'hull:' + side + ':' + paint + ':' + layout + ':' + contour.slice(5) };
}

// Store impact artwork in hull coordinates so rigid movement does not repaint
// its texture. The plate records and their measured footprints stay untouched.
export function hullImpactLayout(shape: Pick<HullArtwork, 'left' | 'bottom' | 'height'>, pose: Pose, marks: readonly HullMark[]) {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle), impacts = marks.map(mark => {
    const dx = mark.x - pose.x, dy = mark.y - pose.y;
    return { x: c * dx + s * dy - shape.left, y: shape.height - (-s * dx + c * dy - shape.bottom),
      angle: -(mark.angle - pose.angle), radius: mark.radius,
      kind: ['hole', 'burn', 'ricochet'].includes(mark.kind) ? mark.kind : 'dent',
      variant: Math.abs(Math.round(mark.u * 91471 + mark.v * 81797)) % 4,
      opacity: clamp(.42 + Math.sqrt(clamp(mark.strength ?? 1, 0, 3)) * .16, .42, .76) };
  });
  const fixed = (value: number, precision: number) => (Math.round(value * 10 ** precision) / 10 ** precision).toFixed(precision);
  return { impacts, revision: impacts.map(mark => [mark.kind, mark.variant,
    fixed(mark.x, 4), fixed(mark.y, 4), fixed(mark.angle, 4), fixed(mark.radius, 5), fixed(mark.opacity, 3)].join(':')).join(';') };
}

export function paintHullImpacts(ctx: ArtContext, shape: Pick<HullArtwork, 'width' | 'height'>, impacts: readonly HullImpact[], sourceFor: (kind: string, variant: number) => CanvasImageSource) {
  ctx.save();
  // Composite into the already clipped backing. No per-frame stencil mask or
  // decal can spill outside the hull, including at sharp or damaged corners.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.scale(ctx.canvas.width / shape.width, ctx.canvas.height / shape.height);
  for (const impact of impacts) {
    const size = impact.radius / .16;
    ctx.save(); ctx.globalAlpha = impact.opacity; ctx.translate(impact.x, impact.y); ctx.rotate(impact.angle);
    ctx.drawImage(sourceFor(impact.kind, impact.variant), -size / 2, -size / 2, size, size);
    ctx.restore();
  }
  ctx.restore();
}
// The marks of a hull that fall on a fitting, in the frame of the fitting's own picture (`at`: its box on the hull,
// in the frame of the hull's picture, and whether it is drawn turned about).
export function fittingImpacts(impacts: readonly HullImpact[], at: Pick<HullFitting, 'x' | 'y' | 'w' | 'h'> & { flip?: boolean | undefined }) {
  const x0 = at.x - at.w / 2, y0 = at.y - at.h / 2;
  return impacts.filter(mark => Math.abs(mark.x - at.x) < at.w / 2 + mark.radius && Math.abs(mark.y - at.y) < at.h / 2 + mark.radius)
    .map(mark => ({ ...mark, x: at.flip ? at.w - (mark.x - x0) : mark.x - x0, y: mark.y - y0, angle: at.flip ? Math.PI - mark.angle : mark.angle }));
}

const PRIMER = ([190, 198, 192] as const); // neutral grey-green interior paint, tinted by the hull's own paint
const CONCRETE = ([151, 151, 145] as const); // cast concrete, which a paint only stains
export function hullBaseTone(paint: number, cast: boolean) {
  const rgb = ([paint >> 16 & 255, paint >> 8 & 255, paint & 255] as const);
  return cast ? rgb.map((v, i) => v * .25 + CONCRETE[i]! * .75) : rgb;
}
export function paintHullCanvas(shape: HullArtwork, paint: number, layout: HullLayout, surfaces?: HullSurfaces | null, weathering?: WeatheringMaps | null) {
  const scale = Math.min(220, 1536 / shape.width, 768 / shape.height),
    c = canvas(Math.max(8, Math.ceil(shape.width * scale)), Math.max(8, Math.ceil(shape.height * scale))),
    ctx = context2d(c), sx = c.width / shape.width, sy = c.height / shape.height,
    rgb = hullBaseTone(paint, layout.cast),
    // Painted in metres, in the frame of the outline: up is up, the outline's own left and foot at the origin.
    points = shape.points, at = (p: Point) => ({ x: p.x - shape.left, y: p.y - shape.bottom }),
    art: HullArt = { ctx, weathering, w: shape.width, h: shape.height, points, edges: outlineEdges(points), px: 1 / Math.min(sx, sy), random: new Random(7243),
      layout: { ...layout, fittings: layout.fittings.map(f => ({ ...f, ...at(f) })), seams: layout.seams.map(s => ({ a: at(s.a), b: at(s.b) })),
        tracks: layout.tracks.map(t => ({ x0: t.x0 - shape.left, x1: t.x1 - shape.left })),
        arches: layout.arches.map(a => ({ ...a, ...at(a) })), shadows: layout.shadows.map(s => ({ a: at(s.a), b: at(s.b), depth: s.depth })) },
      tone: (color: readonly number[], factor: number, alpha = 1) => `rgba(${color.map(v => Math.round(clamp(v * factor, 0, 255))).join(',')},${alpha})`,
      outline() { ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); } };
  ctx.setTransform(sx, 0, 0, -sy, 0, c.height);
  art.outline(); ctx.clip();
  if (layout.cast) {
    paintCast(art, rgb);
    if (shape.side === 'inside') { ctx.fillStyle = 'rgba(20,22,18,.24)'; ctx.fillRect(0, 0, shape.width, shape.height); section(art, rgb); }
  } else if (shape.side === 'outside') paintOutside(art, rgb);
  else paintInside(art, rgb, rgb.map((v, i) => v * .5 + PRIMER[i]! * .5));
  const surface = surfaces?.[layout.cast ? 'concrete' : shape.side]!;
  if (surface) paintSurfaceMetres(ctx, surface, shape);
  return c;
}

// Where the outline is crossed by an upright line at `x`: from its foot to its top.
function column(points: readonly Point[], x: number) {
  const ys = [];
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if (a.x > x !== b.x > x) ys.push(a.y + (x - a.x) / (b.x - a.x) * (b.y - a.y));
  }
  return ys.sort((p, q) => p - q);
}
const line = (ctx: ArtContext, a: Point, b: Point, style: CanvasPaint, width: number) => { ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
const blot = (ctx: ArtContext, x: number, y: number, r: number, inner: string, outer = 'rgba(0,0,0,0)') => {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, inner); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
};

// A band `depth` deep within the rim of an outline, an edge at a time (`edges`, outlineEdges): for each edge, the four
// corners of its part of the band, from its own two corners to where the line moved in along it meets those moved in
// along the edges either side. Two edges' parts meet along the bisector of their corner, whether it turns out or in,
// neither short of it nor over it. A corner so sharp that this would reach further in than `MITRE` depths is cut there.
const MITRE = 4;
export function mitredBand(edges: readonly HullEdge[], depth: number) {
  const inner = edges.map((edge, i) => {
    const before = edges[(i + edges.length - 1) % edges.length]!.normal, sum = { x: before.x + edge.normal.x, y: before.y + edge.normal.y },
      length = Math.hypot(sum.x, sum.y), toward = length > 1e-6 ? { x: sum.x / length, y: sum.y / length } : edge.normal,
      reach = depth * (length > 2 / MITRE ? 2 / length : MITRE);
    return { x: edge.a.x - toward.x * reach, y: edge.a.y - toward.y * reach };
  });
  return edges.map((edge, i): [Point, Point, Point, Point] => ([edge.a, edge.b, inner[(i + 1) % edges.length]!, inner[i]!] as const));
}
const fillQuad = (ctx: ArtContext, quad: readonly Point[], style: CanvasPaint) => { ctx.beginPath(); quad.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fillStyle = style; ctx.fill(); };

// The rim of the skin is the edge of the armour, bevelled `BEVEL` deep all round and mitred at its corners. The bevel of
// an edge that looks up takes the light, brightest at its arris and gone into the face by the fold; one that looks down
// is a fine dark line; one that looks aside, a little of either. The folds meet at the corners in one line. Where the
// edges look up or aside, and more often near the corners, the paint is chipped and scratched to the bare steel in
// patches here and there.
function paintBevel({ ctx, edges, random, px }: HullArt) {
  const band = mitredBand(edges, BEVEL);
  for (const [i, { a, b, normal }] of edges.entries()) {
    const up = Math.max(0, normal.y), down = Math.max(0, -normal.y), aside = 1 - Math.abs(normal.y),
      light = .06 * aside + .5 * up ** 1.5, dark = .55 * down ** 1.2 + (normal.y < 0 ? .08 * aside : 0),
      mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2,
      across = (rgb: string, alpha: number) => {
        const g = ctx.createLinearGradient(mx, my, mx - normal.x * BEVEL, my - normal.y * BEVEL);
        g.addColorStop(0, `rgba(${rgb},${alpha})`); g.addColorStop(.45, `rgba(${rgb},${alpha * .35})`); g.addColorStop(1, `rgba(${rgb},0)`);
        return g;
      };
    if (light > .02) fillQuad(ctx, band[i]!, across('240,238,212', light));
    if (dark > .02) fillQuad(ctx, band[i]!, across('8,12,9', dark));
  }
  ctx.lineJoin = 'miter'; ctx.miterLimit = MITRE;
  ctx.beginPath(); band.forEach(([, , , fold], i) => i ? ctx.lineTo(fold.x, fold.y) : ctx.moveTo(fold.x, fold.y)); ctx.closePath();
  ctx.strokeStyle = 'rgba(14,20,16,.2)'; ctx.lineWidth = Math.max(px, .002); ctx.stroke();
  for (const { a, b, normal, length } of edges) {
    const struck = normal.y > .3 ? 1 : 1 - Math.abs(normal.y) > .6 ? .45 : 0;
    if (!struck) continue;
    const along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, patches = Math.round(length * 5 * struck * random.range(.4, 1.6));
    for (let p = 0; p < patches; p++) {
      // Where the edge was struck, a few chips and scratches together: near a corner as often as anywhere else along it.
      const near = random.next() < .45, end = random.next() < .5, at = (near ? (end ? 1 - random.next() ** 2 * .12 : random.next() ** 2 * .12) : random.next()) * length,
        spread = random.range(.012, .08), marks = 1 + Math.floor(random.next() * 5);
      for (let m = 0; m < marks; m++) {
        const s = clamp(at + random.range(-spread, spread), 0, length), depth = BEVEL * .9 * random.next() ** 1.6,
          o = { x: a.x + along.x * s - normal.x * depth, y: a.y + along.y * s - normal.y * depth };
        if (random.next() < .55) {
          const rx = random.range(.0015, .006);
          ctx.fillStyle = `rgba(176,178,162,${random.range(.3, .65)})`; ctx.beginPath();
          ctx.ellipse(o.x, o.y, rx, rx * random.range(.4, .9), Math.atan2(along.y, along.x), 0, Math.PI * 2); ctx.fill();
        } else {
          const long = random.range(.006, .035), turn = random.range(-.25, .25), c = Math.cos(turn), s2 = Math.sin(turn);
          line(ctx, o, { x: o.x + (along.x * c - along.y * s2) * long, y: o.y + (along.x * s2 + along.y * c) * long },
            `rgba(178,180,164,${random.range(.2, .5)})`, Math.max(px, random.range(.0015, .004)));
        }
      }
    }
  }
}

// A weld bead along a joint of two plates: the groove the bead lies in, the bead with its ripples catching the light
// from above, and the fine shade it casts.
function weld(ctx: ArtContext, a: Point, b: Point, paint: readonly number[], tone: Tone, px: number) {
  const length = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / length, uy = (b.y - a.y) / length, nx = -uy, ny = ux,
    lit = ny >= 0 ? 1 : -1, bead = .013;
  line(ctx, { x: a.x - nx * lit * .009, y: a.y - ny * lit * .009 }, { x: b.x - nx * lit * .009, y: b.y - ny * lit * .009 }, 'rgba(10,16,12,.3)', .007);
  line(ctx, a, b, tone(paint, .9), bead);
  // Its ripples: short bars of light across it, a dash at a time.
  ctx.setLineDash(([Math.max(px, .0032), .0108] as const)); line(ctx, a, b, tone(paint, 1.28, .55), bead * .9); ctx.setLineDash([]);
  line(ctx, { x: a.x + nx * lit * .0045, y: a.y + ny * lit * .0045 }, { x: b.x + nx * lit * .0045, y: b.y + ny * lit * .0045 }, tone(paint, 1.35, .4), Math.max(px, .002));
}

// The hull seen from outside: its paint lit from above, a little of it faded and mottled; its plates welded at their
// joints; grime run down from what is fitted to it and from its roof, soot over the grille of the engine, dust thick at
// its foot and mud thrown up by the running gear; the armour's edge bevelled and worn; and over wheels the well cut into
// its foot round the axles under each fender, behind the fender the chassis hangs over them. Over a track the chassis
// hangs its skirt (chassis-art.ts).
function paintOutside(art: HullArt, paint: readonly number[]) {
  const { ctx, w, h, points, random, tone, px, layout } = art, lift = ctx.createLinearGradient(0, h, 0, 0);
  lift.addColorStop(0, tone(paint, 1.2)); lift.addColorStop(.16, tone(paint, 1.06)); lift.addColorStop(.55, tone(paint, .94)); lift.addColorStop(1, tone(paint, .82));
  ctx.fillStyle = lift; ctx.fillRect(0, 0, w, h);
  // Paint gone a shade lighter or darker in broad patches, as a vehicle's does in the weather.
  for (let i = 0; i < Math.min(40, w * h * 2.5); i++)
    blot(ctx, random.range(0, w), random.range(0, h), random.range(.3, .8), i % 2 ? 'rgba(232,228,196,.045)' : 'rgba(18,24,16,.05)');
  for (const seam of layout.seams) weld(ctx, seam.a, seam.b, paint, tone, px);
  // The shade of a room that stands over this one, deep under its foot; the foot of this one where it stands on another.
  for (const { a, b, depth } of layout.shadows) {
    const y = Math.min(a.y, b.y), g = ctx.createLinearGradient(0, y, 0, y + depth);
    g.addColorStop(0, depth < 0 ? 'rgba(8,12,9,.62)' : 'rgba(8,12,9,.3)'); g.addColorStop(depth < 0 ? .35 : .5, depth < 0 ? 'rgba(8,12,9,.3)' : 'rgba(8,12,9,.1)'); g.addColorStop(1, 'rgba(8,12,9,0)');
    ctx.fillStyle = g; ctx.fillRect(Math.min(a.x, b.x), Math.min(y, y + depth), Math.abs(b.x - a.x), Math.abs(depth));
  }
  // Grime run down the side from the roof and from under each fitting, and soot over the grille of the engine.
  const streak = (x: number, y: number, long: number, width: number, alpha: number) => {
    const g = ctx.createLinearGradient(0, y, 0, y - long); g.addColorStop(0, `rgba(30,32,22,${alpha})`); g.addColorStop(1, 'rgba(30,32,22,0)');
    ctx.fillStyle = g; ctx.fillRect(x - width / 2, y - long, width, long);
  };
  for (let i = 0; i < Math.min(36, w * 4); i++) { const x = random.range(0, w), ys = column(points, x); if (ys.length) streak(x, ys.at(-1)! - BEVEL, random.range(.12, .5) * h, random.range(.006, .02), .07); }
  for (const f of layout.fittings) {
    if (f.kind === 'number') continue;
    for (let i = 0; i < Math.max(1, Math.round(f.w / .25)); i++) streak(f.x + random.range(-f.w, f.w) * .4, f.y - f.h / 2, random.range(.08, .35), random.range(.008, .02), .1);
    if (f.kind === 'engine') for (let k = -2; k <= 2; k++) blot(ctx, f.x + k * f.w * .17, f.y + f.h / 2, Math.max(.2, f.w * .2), 'rgba(16,16,12,.16)');
  }
  // Dust settled on the lower side, and mud thrown up where the running gear turns.
  const dust = ctx.createLinearGradient(0, Math.min(h, .9), 0, 0);
  dust.addColorStop(0, 'rgba(124,104,70,0)'); dust.addColorStop(.7, 'rgba(124,104,70,.2)'); dust.addColorStop(1, 'rgba(112,92,60,.36)');
  ctx.fillStyle = dust; ctx.fillRect(0, 0, w, h);
  const thrown = [...layout.tracks.map(t => ([t.x0, t.x1] as const)), ...layout.arches.map(a => ([a.x - a.half - a.r * 1.4, a.x + a.half + a.r * 1.4] as const))];
  // The specks in four shades of mud, a path for each.
  const specks: [number, number, number, number][][] = [[], [], [], []];
  for (const [x0, x1] of thrown) for (let i = 0; i < (x1 - x0) * 60; i++) {
    const x = random.range(x0, x1), ys = column(points, x); if (!ys.length) continue;
    const y = ys[0]! + random.next() ** 2.2 * .45, r = random.range(.002, .009);
    specks[Math.floor(random.next() * 4)]!.push(([x, y, r * random.range(1, 1.8), r] as const));
  }
  for (const [i, group] of specks.entries()) {
    ctx.fillStyle = ['rgba(88,78,58,.2)', 'rgba(88,78,58,.36)', 'rgba(110,98,74,.2)', 'rgba(110,98,74,.36)'][i]!; ctx.beginPath();
    for (const [x, y, rx, ry] of group) { ctx.moveTo(x + rx, y); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); }
    ctx.fill();
  }
  // The lower side turns a little away from the sky: a shade darker along the foot, gone some way up it, at most half a
  // metre. What stands under the hull is in its shade, not the hull in that of what is under it.
  const under = ctx.createLinearGradient(0, 0, 0, Math.min(h * .3, .5));
  under.addColorStop(0, 'rgba(10,14,10,.14)'); under.addColorStop(.5, 'rgba(10,14,10,.05)'); under.addColorStop(1, 'rgba(10,14,10,0)');
  ctx.fillStyle = under; ctx.fillRect(0, 0, w, h);
  paintBevel(art);
  // The well behind the fender of each wheel or group of wheels the foot is cut for, as square as the fender
  // (hull-details.ts `fenderLine`) and straight down at its sides: the dark of the box the tyres stand in, all but black
  // up under the fender and a little lighter down towards the axles, for the tyres to stand out against it; its edge is
  // behind the fender, which the chassis hangs in front of it (chassis-art.ts).
  for (const { x, y, r, half } of layout.arches) {
    const { inner, band, round } = fenderOver(r), reach = inner + band * .4, g = ctx.createLinearGradient(0, y + reach, 0, y);
    g.addColorStop(0, tone(paint, .1)); g.addColorStop(.45, tone(paint, .16)); g.addColorStop(1, tone(paint, .3));
    ctx.fillStyle = g; ctx.beginPath();
    fenderLine(reach, -reach, round + band * .4, half).forEach(([u, v], i) => i ? ctx.lineTo(x + u, y + v) : ctx.moveTo(x + u, y + v));
    ctx.closePath(); ctx.fill();
  }
}

// The hull seen from inside, cut open: a smooth painted metal wall darkens under the roof and down at the floor;
// the frames standing up it, holed to be light, and the stringers along it; the corners the light does not reach,
// and around it the cut through the armour in the paint of the outside, its inner edge catching the light.
function paintInside(art: HullArt, paint: readonly number[], primer: readonly number[]) {
  const { ctx, w, h, random, tone, px } = art;
  const shade = ctx.createLinearGradient(0, h, 0, 0);
  shade.addColorStop(0, tone(primer, .54)); shade.addColorStop(.28, tone(primer, .7)); shade.addColorStop(.75, tone(primer, .64)); shade.addColorStop(1, tone(primer, .48));
  ctx.fillStyle = shade; ctx.fillRect(0, 0, w, h);
  // Settled dust stays near the floor, below frames, cables and the cut edge.
  // A room can have mixed armour, so this backing has no inferred rusty metal.
  if (art.weathering && w > .16 && h > .16) {
    const bounds = { x: .06, y: .055, width: w - .12, height: Math.min(.16, h * .14) };
    ctx.beginPath(); ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
    paintWeathering(ctx, art.weathering, bounds, { material: 'painted', dirt: .1, period: 1.1 });
  }
  const pitch = .85, frames = [];
  for (let x = pitch; x < w - .4; x += pitch) frames.push(x);
  // The stringers along the wall, under the roof and over the floor.
  for (const y of ([h * .78, h * .08] as const)) {
    const g = ctx.createLinearGradient(0, y + .045, 0, y - .02);
    g.addColorStop(0, tone(primer, .9)); g.addColorStop(.4, tone(primer, .66)); g.addColorStop(1, 'rgba(13,25,23,.18)');
    ctx.fillStyle = g; ctx.fillRect(0, y - .02, w, .065);
  }
  // The frames: a flange lit on its left, its web holed to be light.
  for (const x of frames) {
    const g = ctx.createLinearGradient(x - .035, 0, x + .035, 0);
    g.addColorStop(0, 'rgba(10,16,12,.26)'); g.addColorStop(.3, tone(primer, .9)); g.addColorStop(.7, tone(primer, .74)); g.addColorStop(1, 'rgba(10,16,12,.3)');
    ctx.fillStyle = g; ctx.fillRect(x - .035, 0, .07, h);
    for (let y = h * .3; y < h * .7; y += Math.max(.32, h * .2)) {
      ctx.fillStyle = tone(primer, .42); ctx.beginPath(); ctx.arc(x, y, .022, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(232,230,200,.25)'; ctx.lineWidth = Math.max(px, .003); ctx.beginPath(); ctx.arc(x, y, .024, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    }
  }
  for (let i = 0; i < Math.min(900, w * h * 60); i++) {
    ctx.fillStyle = i % 3 ? 'rgba(214,214,178,.035)' : 'rgba(17,26,25,.06)';
    ctx.fillRect(random.range(0, w), random.range(0, h), random.range(.003, .012), random.range(.003, .008));
  }
  const floor = ctx.createLinearGradient(0, h * .3, 0, 0);
  floor.addColorStop(0, 'rgba(30,33,23,0)'); floor.addColorStop(1, 'rgba(31,29,17,.3)');
  ctx.fillStyle = floor; ctx.fillRect(0, 0, w, h);
  section(art, paint);
}
// Around a room seen cut open, the cut through its wall: the corners the light does not reach, the wall cut through in
// its own colour, the inner edge of the cut catching the light.
function section({ ctx, tone, outline, px }: HullArt, color: readonly number[]) {
  ctx.lineJoin = 'round';
  outline(); ctx.strokeStyle = 'rgba(8,14,10,.30)'; ctx.lineWidth = .24; ctx.stroke();
  const cut = .05;
  outline(); ctx.strokeStyle = 'rgba(232,230,198,.24)'; ctx.lineWidth = 2 * cut + 3 * px; ctx.stroke();
  outline(); ctx.strokeStyle = tone(color, .92); ctx.lineWidth = 2 * cut; ctx.stroke();
}

// Concrete cast in place: the grain of the boards of its formwork, the joints of the panels and the holes of the ties
// that held them, the stains run down it and its edges chipped.
function paintCast({ ctx, w, h, random, tone, px, layout, edges }: HullArt, stone: readonly number[]) {
  const lift = ctx.createLinearGradient(0, h, 0, 0);
  lift.addColorStop(0, tone(stone, 1.1)); lift.addColorStop(.5, tone(stone, .98)); lift.addColorStop(1, tone(stone, .84));
  ctx.fillStyle = lift; ctx.fillRect(0, 0, w, h);
  for (let y = .15; y < h; y += .15) line(ctx, { x: 0, y }, { x: w, y }, `rgba(40,40,32,${random.range(.03, .07)})`, Math.max(px, .004));
  for (let i = 0; i < Math.min(60, w * h * 4); i++) blot(ctx, random.range(0, w), random.range(0, h), random.range(.15, .6), i % 2 ? 'rgba(236,234,214,.06)' : 'rgba(36,36,28,.07)');
  for (const { a, b } of layout.seams) {
    line(ctx, a, b, 'rgba(26,26,20,.32)', Math.max(px, .006));
    line(ctx, { x: a.x - .004, y: a.y + .004 }, { x: b.x - .004, y: b.y + .004 }, 'rgba(240,238,220,.16)', Math.max(px, .003));
  }
  for (let x = .3; x < w - .2; x += .6) for (let y = .3; y < h - .2; y += .6) {
    ctx.fillStyle = 'rgba(30,30,24,.5)'; ctx.beginPath(); ctx.arc(x, y, .012, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(240,238,220,.18)'; ctx.lineWidth = Math.max(px, .003); ctx.beginPath(); ctx.arc(x, y, .014, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    const g = ctx.createLinearGradient(0, y, 0, y - .3); g.addColorStop(0, 'rgba(60,50,36,.12)'); g.addColorStop(1, 'rgba(60,50,36,0)');
    ctx.fillStyle = g; ctx.fillRect(x - .006, y - .3, .012, .3);
  }
  // The arris all round, its corners mitred: pale where it looks up, dark elsewhere.
  const arris = mitredBand(edges, .04);
  for (const [k, { a, b, normal }] of edges.entries()) {
    fillQuad(ctx, arris[k]!, normal.y > .3 ? 'rgba(244,242,226,.22)' : 'rgba(20,20,16,.25)');
    for (let i = 0; i < Math.hypot(b.x - a.x, b.y - a.y) * 5; i++) {
      const t = random.next(), r = random.range(.008, .03);
      ctx.fillStyle = 'rgba(70,68,58,.45)'; ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * t - normal.x * r * .4, a.y + (b.y - a.y) * t - normal.y * r * .4, r, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// The picture of a fitting is as long and as tall as the fitting, as fine as a close look at the vehicle needs (the
// bench is looked at closest, at some 330 pixels to the metre) and no bigger than a texture should be; it is shrunk
// smoothly from afar.
const FITTING_DENSITY = 400, FITTING_SIDE = 1024;
function fittingCanvasSize(widthM: number, heightM: number): [number, number] {
  const perMetre = Math.min(FITTING_DENSITY, FITTING_SIDE / Math.max(widthM, heightM));
  return ([Math.max(2, Math.round(widthM * perMetre)), Math.max(2, Math.round(heightM * perMetre))] as const);
}
export function createFittingTexture(fitting: HullFitting, paint: number, weathering: WeatheringMaps | null, material = 'steel') {
  const c = canvas(...fittingCanvasSize(fitting.w, fitting.h)), ctx = context2d(c);
  paintFitting(ctx, fitting, paint, weathering, material);
  return pieceTexture(c);
}
// Each stamp is painted at its catalogue proportions, then scaled as one image. Letter wear only erases this
// scratch image, never the host below it. The bounded catalogue is painted only during a cold composition.
export function paintDetailCanvas(detail: { kind: DetailKind; text?: string | undefined }, paint = 0x68765a, weathering: WeatheringMaps | null = null) {
  const spec = VEHICLE_DETAILS[detail.kind]!;
  const c = canvas(...fittingCanvasSize(spec.width, spec.height));
  paintFitting(context2d(c), { kind: detail.kind, w: spec.width, h: spec.height, text: detail.text || '01' }, paint, weathering);
  return c;
}
export function paintAuthoredDetails<C extends ArtCanvas>(picture: C, box: DetailBox, details: readonly PaintDetail[] | null | undefined, paint: number, weathering: WeatheringMaps | null = null): C {
  if (!details?.length) return picture;
  const ctx = context2d(picture), sx = picture.width / box.width, sy = picture.height / box.height,
    top = box.bottom + box.height;
  ctx.save(); ctx.setTransform(sx, 0, 0, sy, 0, 0); ctx.globalCompositeOperation = 'source-atop';
  for (const detail of details) {
    if (!VEHICLE_DETAILS[detail.kind]!) continue;
    ctx.save();
    const mask = detail.mask || box.polygon;
    if (mask && mask.length < 3) { ctx.restore(); continue; }
    if (mask?.length) {
      ctx.beginPath(); mask.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo']!(p.x - box.left, top - p.y)); ctx.closePath(); ctx.clip();
    }
    ctx.translate(detail.x - box.left, top - detail.y); ctx.rotate(-detail.angle);
    // Positions and directional fittings reflect with their surface. Lettering cancels only the final image/view
    // reflection, so old mirrored projects and either facing still read normally without rewriting their details.
    if (detail.kind === 'number' ? box.letteringMirror : detail.mirrored) ctx.scale(-1, 1);
    ctx.drawImage(paintDetailCanvas(detail, paint, weathering), -detail.width / 2, -detail.height / 2, detail.width, detail.height);
    ctx.restore();
  }
  ctx.restore(); return picture;
}
function paintFitting(ctx: ArtContext, fitting: Pick<HullFitting, 'kind' | 'w' | 'h' | 'text' | 'count'>, paint: number, weathering: WeatheringMaps | null, material = 'steel') {
  const { width, height } = ctx.canvas, sx = width / fitting.w, sy = height / fitting.h;
  ctx.save(); ctx.scale(sx, sy);
  const a = Object.assign(kit(ctx, Math.min(sx, sy)), { weathering, material });
  FITTINGS[fitting.kind]!(a, fitting.w, fitting.h, '#' + paint.toString(16).padStart(6, '0'), fitting);
  ctx.restore();
}

// Each fitting seen square from the side, in metres, its front to the left, lit from above; the hull it is fitted to is
// behind it, so that each casts its shade down onto it.
const OUTLINE = '#111c17', STEEL = '#4f574c', RUBBER = '#1b211d', WOOD = '#7d6243';
// Explicit native faces, before their fasteners, glass, labels and recesses.
// Fittings keep real metre sizes; their finish does not stretch with the hull.
const finishPath = (a: FittingKit, bounds: WeatheringBounds, profile: FinishProfile = {}) => {
  if (a.weathering) paintWeathering(a.ctx, a.weathering, bounds,
    { material: a.material, chips: .14, rust: .035, dirt: .12, period: .7, ...profile });
};
const finishFace = (a: FittingKit, x: number, y: number, width: number, height: number, profile?: FinishProfile) => {
  if (!a.weathering || width <= 0 || height <= 0) return;
  a.path(x, y, width, height, Math.min(.004, width / 6, height / 6));
  finishPath(a, { x, y, width, height }, profile);
};
const fall = (a: FittingKit, x: number, y: number, w: number, h: number, r = .008, depth = .008) => { a.path(x + depth * .4, y + depth, w, h, r); a.fill('#0b130e52'); };
const weldFoot = (a: FittingKit, x0: number, x1: number, y: number) => { a.line(x0, y, x1, y, '#0f1a1580', Math.max(a.hair(1), .004)); a.line(x0, y - .002, x1, y - .002, '#c9cdb466', Math.max(a.hair(.8), .0018)); };
const FITTINGS: Record<HullFittingKind, (a: FittingKit, W: number, H: number, paint: string, fitting?: FittingMeta) => void> = {
  // Full-height glazing in a door cut into the cab of a tracked carrier, as on its operator pod: the glass set in a
  // rubber, the swept pillar of the door left in the paint of the cab.
  'industrial-door'(a, W, H) {
    drip(a, W * .16, W - .028, .018);
    glazing(a, [([W * .17, .055] as const), ([W - .065, .055] as const), ([W - .065, H * .83] as const), ([.065, H * .83] as const), ([.065, H * .25] as const)], H * .83);
    seam(a, [([W * .16, .018] as const), ([W - .028, .018] as const), ([W - .018, H - .025] as const), ([.025, H - .025] as const), ([.025, H * .24] as const)]);
    hinges(a, .025, ([H * .35, H * .76] as const));
    pull(a, W - .1, H * .58, .022, .1);
  },
  // A road cab's door: its seam cut into the skin of the cab, a swept front pillar and the window following it.
  'cab-door'(a, W, H) {
    const windowY = .065, windowH = H * .51, rake = W * .13;
    drip(a, rake, W - .025, .018);
    glazing(a, [([rake + .028, windowY] as const), ([W - .065, windowY] as const), ([W - .065, windowY + windowH] as const), ([.065, windowY + windowH] as const), ([.065, H * .28] as const)], windowY + windowH);
    seam(a, [([rake, .018] as const), ([W - .025, .018] as const), ([W - .018, H - .028] as const), ([.025, H - .028] as const), ([.025, H * .28] as const)]);
    hinges(a, .025, ([H * .61, H * .88] as const));
    pull(a, W - .19, H * .65, .1, .024);
  },
  // A cab's two tread faces, mounted below its door, with open dark risers and drilled anti-slip strips.
  'cab-step'(a, W, H, paint) {
    a.housing(.025, .008, W - .05, H - .016, shade(paint, -.4), .008);
    for (const y of ([.018, H - .04] as const)) {
      a.housing(.008, y, W - .016, .028, STEEL, .004);
      along(.035, W - .07, .045, x => a.line(x, y + .009, x + .018, y + .009, '#1b2520', .008));
    }
  },
  // A thick crew door cut into an armoured side, its top corner ahead cut off, a small vision block set in it. That
  // block belongs to this finish only; the authored glass in the frontal plate supplies the real Command sight. Tanks
  // use roof hatches instead of inheriting this door.
  'armour-door'(a, W, H) {
    drip(a, .14, W - .04, .025);
    glazing(a, [([.17, .15] as const), ([W - .125, .15] as const), ([W - .125, .30] as const), ([.17, .30] as const)], .30, .012);
    seam(a, [([.025, .13] as const), ([.14, .025] as const), ([W - .04, .025] as const), ([W - .025, H - .04] as const), ([.025, H - .04] as const)]);
    hinges(a, .025, ([H * .43, H * .78] as const));
    pull(a, W - .15, H * .54, .09, .024);
  },
  // A small service cover is visibly different from a crew door: its seam bolted round, no window or latch.
  'service-panel'(a, W, H) {
    seam(a, [([.014, .014] as const), ([W - .014, .014] as const), ([W - .014, H - .014] as const), ([.014, H - .014] as const)], .015);
    for (const x of ([.043, W / 2, W - .043] as const)) for (const y of ([.043, H - .043] as const)) a.bolt(x, y, .0055);
    for (const y of ([H * .36, H * .64] as const)) for (const x of ([.043, W - .043] as const)) a.bolt(x, y, .0055);
  },
  // Side access on an artillery turret, cut into its plate, its hinges ahead and the dog latch that holds it behind.
  // This is never a tank hull's cab door.
  'access-hatch'(a, W, H) {
    seam(a, [([.014, .014] as const), ([W - .014, .014] as const), ([W - .014, H - .014] as const), ([.014, H - .014] as const)], .04);
    hinges(a, .014, ([.17, H - .15] as const));
    a.circle(W - .13, H * .52, .036, null, '#0f1a15a8', Math.max(a.hair(1), .005));
    a.line(W - .13, H * .52, W - .19, H * .52 + .05, '#1b2a2290', Math.max(a.hair(1), .01));
    a.line(W - .13, H * .52 - .003, W - .19, H * .52 + .047, '#d6ddbe50', Math.max(a.hair(1), .003));
  },
  exhaust(a, W, H, paint) {
    a.housing(.025, .015, W - .05, H - .03, shade(paint, -.42), .02);
    finishFace(a, .04, .027, W - .08, H - .054, { chips: .18, dirt: .25, rust: .12 });
    a.path(.075, .055, W - .15, H - .11, .015); a.fill('#0c1410');
    along(.1, W - .2, .05, x => a.line(x, .04, x + .035, H - .04, '#65705b', .014));
    for (const x of ([.046, W - .046] as const)) a.bolt(x, H / 2, .008);
  },
  // The headlight in its armoured housing: the lens at its front under a visor, the bar guard bent around it.
  headlight(a, W, H, paint) {
    fall(a, .05, .03, .22, .11, .02);
    a.housing(.17, .05, .1, .09, shade(paint, -.12), .006);
    finishFace(a, .176, .056, .088, .078); a.bolt(.245, .095, .0065);
    a.housing(.055, .036, .165, .1, paint, .028);
    finishFace(a, .068, .045, .138, .078);
    a.path(.043, .046, .022, .08, .008);
    a.fill(a.gradient(0, .046, 0, .126, [[0, '#f6f2d4'], [.45, '#dcd5a8'], [1, '#8b8664']])); a.stroke(OUTLINE, a.edge);
    a.shape([([.036, .03] as const), ([.14, .03] as const), ([.14, .043] as const), ([.05, .043] as const)]); a.fill(shade(paint, .16)); a.stroke(OUTLINE, a.hair(1));
    a.tube([([.205, .017] as const), ([.04, .017] as const), ([.016, .038] as const), ([.016, .132] as const), ([.04, .153] as const), ([.205, .153] as const)], .011, shade(paint, -.04));
    a.line(.09, .12, .19, .12, '#0e171240', a.hair(1));
  },
  // The tail light at the back: a small housing, its red lens facing back, a guard over it.
  taillight(a, W, H, paint) {
    fall(a, .02, .025, .12, .072, .008);
    a.housing(.02, .026, .105, .068, shade(paint, -.06), .008);
    finishFace(a, .028, .033, .089, .052); a.bolt(.045, .06, .006);
    a.path(.121, .032, .017, .056, .005); a.fill(a.gradient(0, .032, 0, .088, [[0, '#e8664c'], [.5, '#b5301f'], [1, '#5f150d']])); a.stroke(OUTLINE, a.edge);
    a.tube([([.02, .013] as const), ([.128, .013] as const), ([.147, .032] as const), ([.147, .086] as const), ([.128, .106] as const), ([.02, .106] as const)], .009, shade(paint, -.04));
  },
  // A towing lug welded at the foot of an end, with the shackle hanging from the pin through it, seen edge-on.
  shackle(a, W, H, paint) {
    fall(a, .04, .02, .12, .11, .02);
    a.shape([([.045, .02] as const), ([.155, .02] as const), ([.168, .085] as const), ([.13, .125] as const), ([.07, .125] as const), ([.032, .085] as const)]);
    a.fill(a.gradient(0, .02, 0, .125, [([0, shade(paint, .25)] as const), ([.2, paint] as const), ([1, shade(paint, -.35)] as const)])); a.stroke(OUTLINE, a.edge);
    finishPath(a, { x: .032, y: .02, width: .136, height: .105 }, { chips: .24, rust: .08, dirt: .19, oil: .04 });
    weldFoot(a, .045, .155, .022);
    a.tube([([.1, .085] as const), ([.1, .165] as const)], .026, STEEL);
    a.circle(.1, .172, .018, a.radial(.1, .172, .018, [[0, '#7c8574'], [1, '#2f372f']]), OUTLINE, a.edge);
    a.circle(.1, .085, .022, a.radial(.1, .085, .022, [[0, '#a3ab96'], [1, '#3b453a']], .094, .079), OUTLINE, a.edge);
    a.circle(.1, .085, .009, '#1c241e');
  },
  // A lifting eye: a plate welded upright at the corner of a roof, the hole through it showing the hull behind.
  eye(a, W, H, paint) {
    const ctx = a.ctx;
    ctx.beginPath(); ctx.moveTo(.016, .095); ctx.lineTo(.016, .05); ctx.arc(.05, .05, .034, Math.PI, 0); ctx.lineTo(.084, .095); ctx.closePath();
    a.fill('#0b130e40');
    ctx.beginPath(); ctx.moveTo(.012, .09); ctx.lineTo(.012, .047); ctx.arc(.048, .047, .036, Math.PI, 0); ctx.lineTo(.084, .09); ctx.closePath();
    a.fill(a.gradient(0, .011, 0, .09, [([0, shade(paint, .32)] as const), ([.25, paint] as const), ([1, shade(paint, -.3)] as const)])); a.stroke(OUTLINE, a.edge);
    finishPath(a, { x: .012, y: .011, width: .072, height: .079 }, { chips: .2, rust: .055 });
    a.circle(.048, .047, .016, shade(paint, -.55), OUTLINE, a.hair(1));
    a.ctx.beginPath(); a.ctx.arc(.048, .047, .016, Math.PI * .1, Math.PI * .9); a.stroke('#d6ddbe55', Math.max(a.hair(1), .002));
    weldFoot(a, .012, .084, .091);
  },
  // A hatch on the roof, seen edge-on: the joint of its lid with the ring it closes, a little under the roof, the
  // knuckle of its hinge at its back and its lock at its front, flush with the skin.
  hatch(a, W, H) {
    const y = .046;
    seam(a, [([.02, .012] as const), ([W - .02, .012] as const), ([W - .02, y] as const), ([.02, y] as const)], .006);
    a.circle(W - .036, .03, .013, null, '#0f1a15a8', Math.max(a.hair(1), .004));
    a.circle(W - .036, .03, .004, '#1d251fa0');
    a.line(.05, .029, .085, .029, '#0f1a15a0', Math.max(a.hair(1), .006));
  },
  // A periscope's head out of the roof: its armoured box, its window looking out ahead, the rain guard over it.
  periscope(a, W, H, paint) {
    a.shape([([.03, .02] as const), ([.125, .016] as const), ([.13, .078] as const), ([.026, .078] as const)]);
    a.fill(a.gradient(0, .016, 0, .078, [([0, shade(paint, .2)] as const), ([.3, shade(paint, -.02)] as const), ([1, shade(paint, -.3)] as const)])); a.stroke(OUTLINE, a.edge);
    finishPath(a, { x: .026, y: .016, width: .104, height: .062 }, { chips: .12, dirt: .08, rust: .02 });
    a.shape([([.014, .03] as const), ([.03, .028] as const), ([.03, .066] as const), ([.02, .066] as const)]);
    a.fill(a.gradient(0, .03, 0, .066, [[0, '#6b8796'], [.5, '#22343c'], [1, '#0c1418']])); a.stroke(OUTLINE, a.hair(1));
    a.shape([([.008, .02] as const), ([.075, .012] as const), ([.075, .02] as const), ([.012, .026] as const)]); a.fill(shade(paint, .12)); a.stroke(OUTLINE, a.hair(1));
    a.bolt(.105, .06, .0048);
  },
  // A grab handle: a bar bent to a U and welded by its feet to the side.
  handle(a, W, H, paint) {
    a.tube([([.034, .066] as const), ([.034, .028] as const), ([W - .034, .028] as const), ([W - .034, .066] as const)], .016, '#0b130e40');
    a.tube([([.03, .06] as const), ([.03, .022] as const), ([W - .03, .022] as const), ([W - .03, .06] as const)], .014, shade(paint, .02));
    finishFace(a, .04, .018, W - .08, .008, { chips: .25, rust: .025, dirt: .09 });
    for (const x of ([.03, W - .03] as const)) { a.circle(x, .06, .012, shade(paint, -.2), OUTLINE, a.hair(1)); }
  },
  // The panel bolted over the engine, and in it the grille the engine breathes through: its slats in a frame.
  engine(a, W, H, paint) {
    fall(a, .006, .006, W - .014, H - .014, .01);
    a.housing(.004, .004, W - .012, H - .012, shade(paint, .03), .01);
    finishFace(a, .014, .014, W - .032, H - .032, { chips: .13, dirt: .15, oil: .08 });
    const pitch = .1;
    along(.03, W - .06, pitch, x => { a.bolt(x, .022, .0055); a.bolt(x, H - .03, .0055); });
    along(.05, H - .1, pitch, y => { a.bolt(.022, y, .0055); a.bolt(W - .03, y, .0055); });
    const gx = .05, gy = .045, gw = W - .1, gh = H - .1;
    if (gw > .08 && gh > .05) {
      a.path(gx, gy, gw, gh, .006); a.fill('#0e1511');
      along(gy, gh, .028, y => {
        a.path(gx + .004, y - .008, gw - .008, .012, .002);
        a.fill(a.gradient(0, y - .008, 0, y + .004, [([0, shade(paint, .2)] as const), ([.35, shade(paint, -.05)] as const), ([1, shade(paint, -.45)] as const)]));
        finishFace(a, gx + .008, y - .006, gw - .016, .008, { chips: .08, dirt: .11, oil: .06, rust: .02 });
      });
      a.path(gx, gy, gw, gh, .006); a.stroke(OUTLINE, a.edge * 1.3);
    }
    a.wear(.02, .02, W - .04, H - .04, W * 7);
  },
  // The filler of the fuel tank: an armoured boss on the side with the cap screwed in it, notched to be gripped.
  filler(a, W, H, paint) {
    fall(a, .02, .015, .1, .09, .012);
    a.housing(.02, .014, .1, .09, shade(paint, -.04), .012);
    finishFace(a, .027, .021, .086, .076, { dirt: .16, oil: .16, chips: .16 });
    for (const [x, y] of [([.032, .026] as const), ([.108, .026] as const), ([.032, .092] as const), ([.108, .092] as const)]) a.bolt(x, y, .0045);
    a.circle(.07, .059, .03, a.radial(.07, .059, .03, [([0, shade(paint, .3)] as const), ([.8, shade(paint, -.1)] as const), ([1, shade(paint, -.4)] as const)], .062, .05), OUTLINE, a.edge);
    for (let i = 0; i < 12; i++) { const t = i * Math.PI / 6; a.line(.07 + Math.cos(t) * .024, .059 + Math.sin(t) * .024, .07 + Math.cos(t) * .03, .059 + Math.sin(t) * .03, '#141e18a0', a.hair(1)); }
    a.circle(.07, .059, .011, shade(paint, -.3), OUTLINE, a.hair(1));
  },
  // The tow cable stowed along the side: braided steel with an eye spliced at each end, held in clips.
  cable(a, W, H, paint) {
    const y = .04, d = .026;
    a.tube([([.08, y + .006] as const), ([W - .08, y + .006] as const)], d + .004, '#0b130e40');
    a.tube([([.075, y] as const), ([W - .075, y] as const)], d, '#4b5046');
    finishFace(a, .075, y - .009, W - .15, .018, { material: 'steel', chips: .2, dirt: .19, rust: .06, oil: .035, period: .6 });
    for (let x = .08; x < W - .08; x += .012) a.line(x, y - d * .42, x + .008, y + d * .42, '#9aa08c60', Math.max(a.hair(.8), .0016));
    for (const [x, way] of [([.04, 1] as const), ([W - .04, -1] as const)]) {
      a.ctx.beginPath(); a.ctx.ellipse(x, y, .03, .024, 0, 0, Math.PI * 2); a.stroke('#3f443b', .011);
      a.ctx.beginPath(); a.ctx.ellipse(x, y, .03, .024, 0, Math.PI * 1.1, Math.PI * 1.9); a.stroke('#a3a994', Math.max(a.hair(1), .003));
      a.housing(x + way * .03 - (way > 0 ? 0 : .034), y - .016, .034, .032, '#6c7264', .006);
    }
    along(.4, W - .8, .6, x => { a.housing(x - .018, y - .03, .036, .062, paint, .005); a.bolt(x, y - .02, .0045); a.bolt(x, y + .021, .0045); });
  },
  // The tools stowed on the side: a shovel and a bar, strapped in two brackets.
  tools(a, W, H, paint) {
    a.tube([([.06, .052] as const), ([.62, .052] as const)], .028, WOOD);
    a.ctx.beginPath(); a.ctx.ellipse(.045, .052, .03, .022, 0, 0, Math.PI * 2); a.stroke(WOOD, .01);
    a.shape([([.62, .034] as const), ([.66, .022] as const), ([.94, .018] as const), ([1.05, .052] as const), ([.94, .086] as const), ([.66, .082] as const), ([.62, .07] as const)]);
    a.fill(a.gradient(0, .018, 0, .086, [([0, shade(paint, .12)] as const), ([.4, shade(paint, -.08)] as const), ([1, shade(paint, -.35)] as const)])); a.stroke(OUTLINE, a.edge);
    finishPath(a, { x: .62, y: .018, width: .43, height: .068 }, { material: 'steel', chips: .32, rust: .09, dirt: .2, period: .55 });
    a.line(.68, .052, .99, .052, '#d6ddbe40', Math.max(a.hair(1), .002));
    a.tube([([.03, .118] as const), ([1.0, .118] as const), ([1.04, .108] as const)], .02, STEEL);
    for (const x of ([.24, .78] as const)) {
      a.housing(x - .022, .006, .044, .138, shade(paint, -.05), .005);
      finishFace(a, x - .017, .012, .034, .126, { dirt: .15, chips: .18 });
      a.path(x - .03, .07, .06, .014, .003); a.fill('#262c24'); a.housing(x - .012, .064, .024, .026, '#8f927e', .003);
    }
  },
  // Jerry cans in their rack at the back: each its broad side with the cross pressed in it and its three handles,
  // the strap across them and the tray under them.
  cans(a, W, H, paint, { count = 1 } = {}) {
    for (let i = 0; i < count; i++) {
      const x = .03 + i * .36, y = .05, w = .34, h = .45, can = shade(paint, -.1);
      fall(a, x, y, w, h, .022);
      a.housing(x, y, w, h, can, .024);
      finishFace(a, x + .016, y + .018, w - .032, h - .036, { chips: .19, rust: .045, dirt: .16, oil: .04 });
      for (const [x0, y0, x1, y1] of [([x + .05, y + .06, x + w - .05, y + h - .05] as const), ([x + w - .05, y + .06, x + .05, y + h - .05] as const)]) a.rib(x0, y0, x1, y1, .006);
      a.path(x + .03, y + .03, w - .06, h - .06, .02); a.stroke('#0e171250', Math.max(a.hair(1), .004));
      for (const k of ([0, 1, 2] as const)) { a.path(x + .05 + k * .085, y - .04, .07, .045, .012); a.stroke(shade(can, -.2), .011); }
    }
    a.housing(.01, H - .03, W - .02, .03, shade(paint, -.1), .004);
    a.path(.01, .25, W - .02, .03, .004); a.fill('#2a3127'); a.housing(W / 2 - .03, .243, .06, .044, '#8f927e', .004);
  },
  // A ring the load is lashed to: its bracket, and the ring hanging from the pin through it.
  ring(a, W, H, paint) {
    a.housing(.022, .008, .036, .026, shade(paint, -.05), .004);
    finishFace(a, .026, .012, .028, .018, { chips: .22, dirt: .16 });
    a.ctx.beginPath(); a.ctx.moveTo(.024, .024); a.ctx.lineTo(.024, .052); a.ctx.quadraticCurveTo(.04, .076, .056, .052); a.ctx.lineTo(.056, .024);
    a.stroke('#0b130e50', .011); a.stroke(STEEL, .008);
    a.circle(.04, .021, .006, '#9aa38c', OUTLINE, a.hair(1));
  },
  // The amber reflector on the side of a vehicle on wheels, near each end: its lens in a rim screwed to the side.
  marker(a, W, H, paint) {
    fall(a, .004, .004, W - .008, H - .008, .006, .004);
    a.housing(.004, .004, W - .01, H - .01, shade(paint, -.25), .006);
    a.path(.011, .01, W - .024, H - .022, .004);
    a.fill(a.gradient(0, .01, 0, H - .012, [[0, '#f6c35c'], [.5, '#d98a1c'], [1, '#7a4508']])); a.stroke(OUTLINE, a.hair(1));
    a.line(.016, .014, W - .02, .014, '#fff3c890', Math.max(a.hair(1), .002));
  },
  // A bin stowed at the back: its lid over its lip, the latches that close it, the ribs pressed in its side.
  bin(a, W, H, paint) {
    fall(a, .012, .03, W - .024, H - .04, .01);
    a.housing(.012, .03, W - .024, H - .042, paint, .01);
    finishFace(a, .022, .042, W - .044, H - .066, { chips: .18, rust: .045, dirt: .16 });
    a.housing(0, .01, W, .036, shade(paint, .08), .006);
    finishFace(a, .012, .016, W - .024, .024, { chips: .22, dirt: .1 });
    for (const y of ([H * .55, H * .78] as const)) a.rib(.04, y, W - .04, y, .005);
    for (const x of ([W * .22, W * .78] as const)) {
      a.housing(x - .018, .04, .036, .05, STEEL, .004); a.line(x, .05, x, .084, '#c9cdb4a0', Math.max(a.hair(1), .003));
    }
    weldFoot(a, .02, W - .02, H - .012);
    a.wear(.02, .05, W - .04, H - .08, W * 13);
  },
  // The number of the vehicle, stencilled in a pale paint worn thin.
  number(a, W, H, paint, { text = '' } = {}) {
    a.label(text, W / 2, H * .82, H * .78, '#ddd7b4c8', { align: 'center', weight: 800, max: W - .02 });
    a.ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 18; i++) {
      const x = .02 + (i * .618 % 1) * (W - .04), y = .03 + (i * .382 % 1) * (H - .06);
      a.line(x, y, x + .014, y, '#000000b0', .004);
    }
    a.ctx.globalCompositeOperation = 'source-over';
  },
  // Inside: the lamp under the roof, its frosted lens below it and its light on the wall.
  lamp(a, W, H) {
    a.ctx.fillStyle = a.radial(W / 2, H, W / 2, [[0, '#f2e6b840'], [1, '#f2e6b800']]); a.ctx.fillRect(0, 0, W, H);
    a.housing(.03, .006, W - .06, .012, '#7b8274', .003);
    a.housing(.04, .016, W - .08, .036, '#c3c6b2', .006);
    finishFace(a, .047, .022, W - .094, .024, { chips: .05, rust: 0, dirt: .07 });
    a.path(.05, .05, W - .1, .016, .006); a.fill(a.gradient(0, .05, 0, .066, [[0, '#fff6d0'], [1, '#d8cc98']])); a.stroke(OUTLINE, a.hair(1));
    a.bolt(.055, .034, .0045); a.bolt(W - .055, .034, .0045);
  },
  // Inside: the conduit of the wiring along the wall, in clamps screwed to it.
  conduit(a, W, H) {
    a.tube([([.01, .027] as const), ([W - .01, .027] as const)], .022, '#8b9286');
    along(.1, W - .2, .3, x => { a.housing(x - .012, .01, .024, .034, '#5f665b', .004); a.bolt(x, .02, .004); });
  },
  // Inside: the box the wiring meets in, its lid screwed on, a warning on it, the cable out of its foot.
  junction(a, W, H) {
    a.tube([([W / 2, H - .04] as const), ([W / 2, H - .005] as const)], .016, '#2a302b');
    a.housing(.015, .012, W - .03, H - .05, '#a6ac97', .008);
    finishFace(a, .022, .019, W - .044, H - .064, { chips: .07, rust: 0, dirt: .09 });
    a.path(.03, .026, W - .06, H - .08, .005); a.stroke('#2f382f80', Math.max(a.hair(1), .003));
    for (const [x, y] of [([.028, .025] as const), ([W - .028, .025] as const), ([.028, H - .052] as const), ([W - .028, H - .052] as const)]) a.bolt(x, y, .004);
    a.shape([([W / 2, .045] as const), ([W / 2 + .022, .083] as const), ([W / 2 - .022, .083] as const)]); a.fill('#d0a73c'); a.stroke('#3b3320', a.hair(1));
  },
  // Inside: the extinguisher where the crew can reach it, in its bracket: the bottle, its valve and hose, its label.
  extinguisher(a, W, H) {
    a.path(.022, .1, .086, H - .11, .036);
    a.fill(a.gradient(.022, 0, .108, 0, [[0, '#5c1a14'], [.3, '#b13a2b'], [.55, '#c95443'], [1, '#6a2018']])); a.stroke(OUTLINE, a.edge);
    finishPath(a, { x: .022, y: .1, width: .086, height: H - .11 }, { chips: .11, rust: 0, dirt: .08, oil: 0 });
    a.path(.022, H * .45, .086, .07, 0); a.fill('#e4e0cc'); a.line(.03, H * .45 + .035, .1, H * .45 + .035, '#5c5a4c', a.hair(1));
    a.housing(.04, .06, .05, .046, '#8a9080', .006);
    a.line(.065, .06, .1, .03, '#2a302b', .008);
    a.tube([([.088, .085] as const), ([.112, .12] as const), ([.112, H * .4] as const)], .008, '#1f2420');
    for (const y of ([H * .3, H * .78] as const)) { a.path(.016, y, .098, .022, .003); a.fill('#2b3229'); a.housing(.048, y - .004, .03, .03, '#8f927e', .004); }
  },
};
// A door or a cover cut into the plate it closes: no slab of its own over the skin, which shows through it in the paint
// and the wear of the hull, but the seam round it, a groove the shade of its upper wall darkens with the light on the
// lip under it, along `points` (corners rounded `round`). It is as fine as a real seam: from afar it is gone with the
// rest of the finish, before it is a scribble.
function seam(a: FittingKit, points: readonly XY[], round = .012) {
  const n = points.length, trace = (dx = 0, dy = 0) => {
    a.ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [px, py] = points[i % n]!, [qx, qy] = points[(i + 1) % n]!, [ox, oy] = points[(i + n - 1) % n]!,
        before = Math.hypot(px - ox, py - oy), after = Math.hypot(qx - px, qy - py), cut = Math.min(round, before / 2, after / 2);
      a.ctx[i ? 'lineTo' : 'moveTo']!(px + (ox - px) * cut / before + dx, py + (oy - py) * cut / before + dy);
      if (i < n) a.ctx.quadraticCurveTo(px + dx, py + dy, px + (qx - px) * cut / after + dx, py + (qy - py) * cut / after + dy);
    }
  };
  const width = Math.max(a.hair(1), .0055);
  trace(width * .7, width * .7); a.stroke('#d9dcc23d', Math.max(a.hair(1), width * .55));
  trace(); a.stroke('#0b120e8f', width);
}
// The rain gutter over a crew door, from `x0` to `x1` over its top at `y`: the fine shade it casts on the skin, and its
// edge in the light.
function drip(a: FittingKit, x0: number, x1: number, y: number) {
  const top = y - .022;
  a.line(x0 - .02, top + .004, x1 + .02, top + .004, '#0b120e40', Math.max(a.hair(1), .006));
  a.line(x0 - .02, top, x1 + .02, top, '#dde0c64a', Math.max(a.hair(1), .003));
}
// The glass of a window set in a door, along `points`: within a black rubber `rubber` wide, the sky over it and the dark
// of the cab under it down to its sill at `foot`, a glint across it.
function glazing(a: FittingKit, points: readonly XY[], foot: number, rubber = .014) {
  const top = Math.min(...points.map(p => p[1]!)), xs = points.map(p => p[0]!), x0 = Math.min(...xs), w = Math.max(...xs) - x0;
  a.shape(points); a.fill(a.gradient(0, top, 0, foot, [[0, '#7c99a5'], [.42, '#4a6e7d'], [1, '#233c46']]));
  a.ctx.save(); a.ctx.clip();
  a.shape([([x0 + w * .18, top] as const), ([x0 + w * .42, top] as const), ([x0 + w * .72, foot] as const), ([x0 + w * .5, foot] as const)]); a.fill('#d4e2d31c');
  a.ctx.restore();
  a.shape(points); a.stroke(RUBBER, Math.max(a.hair(1), rubber));
  a.shape(points); a.stroke('#a9bcb63a', Math.max(a.hair(1), rubber * .25));
}
// The hinges of a door on its seam at `x`, at `ys`: their leaves flush with the skin, only the knuckle of each round
// along the seam, a pin through it.
function hinges(a: FittingKit, x: number, ys: readonly number[]) {
  for (const y of ys) {
    a.path(x - .006, y, .03, .055, .004); a.fill('#0b120e1f');
    a.path(x - .009, y + .004, .016, .047, .007); a.fill(a.gradient(x - .009, 0, x + .007, 0, [[0, '#0b120e70'], [.45, '#d9dcc250'], [1, '#0b120e60']]));
    a.line(x - .001, y + .002, x - .001, y + .053, '#0b120e70', Math.max(a.hair(1), .002));
  }
}
// The handle of a door: a pull recessed into the skin, `w` by `h` from (x, y), the shade in it, the grip across it and
// the light on the lip under it.
function pull(a: FittingKit, x: number, y: number, w: number, h: number) {
  const r = Math.min(w, h) / 2;
  a.path(x, y, w, h, r); a.fill(a.gradient(0, y, 0, y + h, [[0, '#0b120ea8'], [1, '#0b120e50']]));
  a.line(x + r * .8, y + h + .003, x + w - r * .8, y + h + .003, '#d9dcc250', Math.max(a.hair(1), .003));
  if (w > h) a.line(x + w * .2, y + h * .5, x + w * .8, y + h * .5, '#9ea79270', Math.max(a.hair(1), h * .3));
  else a.line(x + w * .5, y + h * .2, x + w * .5, y + h * .8, '#9ea79270', Math.max(a.hair(1), w * .3));
}
// The same things drawn along a length, a pitch apart, the lot in its middle (as machine-art.ts lays them).
function along(from: number, length: number, pitch: number, draw: (position: number, index: number) => void) {
  const n = Math.max(0, Math.floor(length / pitch + 1e-9)), start = (length - n * pitch) / 2;
  for (let i = 0; i < n; i++) draw(from + start + (i + .5) * pitch, i);
}
export const FITTING_KINDS = Object.freeze(Object.keys(FITTINGS));
