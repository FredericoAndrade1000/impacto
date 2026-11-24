import type { Graphics, Texture, StrokeStyle, FillInput } from 'pixi.js';
import type { CargoKind } from './component-volume.ts';
import type { Deposit, DepositFeatureKind } from './deposits.ts';
import type { DepositTone } from './deposit-palette.ts';
import type { KnownVein, KnownAirdrop } from './faction-ui.ts';
import type { TerrainPaintGround } from './terrain-art.ts';
import type { StrataPlan } from './strata-art.ts';
import type { XY } from './canvas-art.ts';

export interface DepositSurfaceParts { works: Graphics; front: Graphics; under?: Graphics }
export interface DepositArtParts extends DepositSurfaceParts { under: Graphics }
export interface DepositLook { share: number; begun: boolean; loading: boolean; extracting: boolean; pile: number; supplied?: boolean }
interface DepositPosition { x: number; reserve?: number }
type SurfaceSite = Pick<Deposit, 'x' | 'reserve' | 'feature'>;
type SiteContext = ReturnType<typeof context<DepositPosition>>;
type SurfaceContext = ReturnType<typeof context<SurfaceSite>>;
type VeinContext = ReturnType<typeof context<Deposit, DepositArtParts>> & { look: DepositLook; bed(bed: 0 | 1 | 2 | 3, u: number): number };
type OreBand = readonly [readonly XY[], number, number];
type OreTint = { halo: number; body: number; strength: number };
type BodyCut = ReturnType<typeof cutBody>;
interface OrePod { s: number; u: number; d: number; along: number; across: number; slope: number; rough(angle: number): number }
import { DEPOSIT_RESERVE } from './deposits.ts';
import { loadingZone } from './loading-area.ts';
import { cargoUnitVolume } from './component-volume.ts';
import { bedLines } from './strata-art.ts';
import { SLAB, RUIN_TONES, ruinPlan, rubbleAt } from './ruins-art.ts';
import { mineralFill } from './textures.ts';
import { Matrix } from 'pixi.js';
import { DEPOSIT_TONES } from './deposit-palette.ts';
export { DEPOSIT_TONES } from './deposit-palette.ts';

// The sites of the shared field and the veins in them. A site is a feature of the ground and looks like one, the
// same to everybody (`drawSite`): ledges of rust-stained banded ironstone where iron crops out, rusted beams jutting
// from the heaps of rubble of ruins, a scree of blocks with dark ones among them at the foot of a ridge, a band of pale quartz
// sand along a dune, a pool of tar in a wet lowland. That is all a site the faction knows no vein at shows, whether
// one is there or not.
// A vein the faction knows is drawn besides (`drawVein`), in the cross-section of the earth, as such bodies lie in
// it: in the beds of the strata (strata-art.ts) and along them, swelling and thinning, and seen as the rock it lies
// in with a little more colour, the beds reading through it — a lens of banded ironstone that comes up under the
// outcrop and dips away from it down its bed, a lens of scrap and rubble under the ruins, dark pods of chromite
// strung down a bed under the scree, the bed of white sand the dune stands on, and petroleum where a bed of sand
// arches, under the bed that seals it and over the water. Each fades out into the rock about it through a halo of
// weaker ore, as ore is spread through the rock at its edge. Its size is that of its reserve, and the share of it
// the faction last saw left is what keeps the tint of the ore, by steps: the iron is dug from under the outcrop down
// its bed, the scrap and the sand from one end, the alloys along their string of pods, and the petroleum gives way
// to the water rising under it; what was dug is worked ground. Once digging has begun the site has its workings —
// a headframe over a shaft and a drift along the bed, an adit and its incline, the pit itself, a pumpjack over its
// well — and a dump or a stockpile of what came out that grows with it; a vein loaded from has a fresh face and
// fresh ore by the working, or petroleum in its well. A survey post with a plate in the tone of the material stands
// at every vein known. A vein is told only while something is left of it: the field forgets one dug out when the
// faction sees its site bare, and its drawing fades away (render.ts).
// It is paint: nothing here is met by a vehicle, a round or a sensor. What stands is footed on the ground under it
// and drawn behind the ground line (`works`), as the trees and the works of a base are, so a slope hides what it
// would bury; what lies on the ground is drawn on it (`front`); and what is under it is drawn in the earth
// (`under`), under a crust of the ground it lies in, or through it where a shaft or a well opens. The tones are
// those of the scenery, quieter than a vehicle.
const POST = 0x77806f, DARK = 0x24332c, LINE = 0x4f5a4f, TIMBER = 0x8b7556;
const ROCK_SCALE = new Matrix().scale(3.2 / 256, 3.2 / 256);
const rockFill = (color: number, art: Pick<SiteContext, 'rockTexture'>) => mineralFill(color, art.rockTexture, ROCK_SCALE);
const SUPPLY_TONE: Readonly<Pick<DepositTone, 'plate' | 'heap'> & { shade?: never }> = Object.freeze({ plate: 0xcbbd8a, heap: 0x9b916c });
// The ground of each feature a site is read off, as everybody sees it.
const GROUND = Object.freeze({
  outcrop: { rock: 0x7a6255, weathered: 0x6a5850, seam: 0x4b4245, stain: 0x9b6248 },
  ruins: { steel: 0x6e4b3b, rust: 0x9a6a50, wire: 0x6f4a3a, stain: 0x8a5a44 },
  talus: { rock: 0x878479, weathered: 0x74716a, dark: 0x4b5052, glint: 0x9fb4c4 },
  dune: { stain: 0xe3dcc4, ripple: 0xece5cf },
  lowland: { stain: 0x2a2724, tar: 0x28262a, sheen: 0x7c8b93, reed: 0x3d3a33 },
});
// The ore under each feature, laid over the rock as a tint (`body`, as strong as `strength`): hematite a little
// redder than the rock, in faint bands of grey and jasper; scrap in its rubble, a little greyer; chromite and
// manganese darker, in a paler host; white quartz sand with cream laminae; and petroleum in its sand over the water,
// under the seal, with a trace of gas. `halo` is the weaker ore at its edge, and `pile` and `shade` the heap of it
// by the working.
export const ORE_TONES = Object.freeze({
  outcrop: { body: 0x7f4a3a, strength: .36, halo: 0x7a5143, band: 0x4d3d39, light: 0xa0644c, pile: 0x6b4335, shade: 0x4b4245 },
  ruins: { body: 0x76594a, strength: .42, halo: 0x6e5c4f, band: 0x7a5040, light: 0x9a6a50, pile: 0x9a6a50, shade: 0x6e4b3b },
  talus: { body: 0x363e45, strength: .48, halo: 0x4a5257, host: 0x8a8268, light: 0x9fb4c4, pile: 0x434a50, shade: 0x2b3035 },
  dune: { body: 0xddd4b2, strength: .4, halo: 0xcdc4a3, band: 0xb8ab86, light: 0xece5cf, pile: 0xd2caae, shade: 0xbcb08b },
  lowland: { body: 0x2e2822, strength: .42, halo: 0x56676a, water: 0x56676a, gas: 0xb5b8a8, seal: 0x4f4f49, light: 0x7c8b93 },
});
// Where a vein was dug: the caved or backfilled ground and its stones, the dark of a working, the dump of what
// came out, and the pond of a flooded pit.
const WORKED = { fill: 0x47433d, halo: 0x4f4b44, stone: 0x6c665b, void: 0x3a332c, dump: 0x7b7466, shade: 0x655f54, water: 0x5d7a80, sand: 0xa39a80 };
// The halo a body fades out through, from its outer edge in: how far past the body each ring of it reaches, in
// metres, and how strong its tint is. They lie one over the other, so the tint grows towards the body.
const HALO: readonly XY[] = [[1.4, .05], [1.08, .05], [.78, .06], [.5, .06], [.24, .07]];
// How far to either side of a site its art reaches.
export const DEPOSIT_ART_REACH = 30;
// What is left of a vein is drawn in this many steps of its reserve.
export const ORE_STEPS = 20;
// The crust of ground over what lies under it.
const COVER = .22;
const pileHeight = (material: CargoKind, stock: number) => stock > 0 ? Math.min(3, Math.ceil(Math.cbrt(stock * cargoUnitVolume(material) * .5) * 10) / 10) : 0;

// What the drawing of a vein takes of what the faction knows of it (faction-ui.ts `knownVeins`): the share of its
// reserve left when last seen, in steps, whether it has been dug and whether the player loads there. A vein is told
// only while something is left of it, and keeps the ore of a step at least. Nothing for a site the faction knows no
// vein at: that site is drawn from the ground alone.
export function depositLook(vein: KnownVein | null | undefined): DepositLook | null {
  if (!vein) return null;
  if (vein.type === 'airdrop') {
    // Supplied loads are cached crate/can pictures owned by Render; this graphics layer owns only their marker.
    if (vein.supplies) return { share: 0, begun: false, loading: false, extracting: false, pile: 0, supplied: true };
    const stock = vein.phase === 'announcement' ? 0 : Math.max(0, Number(vein.stock));
    return { share: 0, begun: false, loading: false, extracting: false,
      pile: pileHeight(vein.material, stock) };
  }
  const share = Math.max(0, Math.min(1, vein.left / vein.reserve)), stock = Math.max(0, vein.stock || 0),
    // Decimetre steps keep one cached drawing while the pile grows. Its height follows stored volume,
    // not everything ever removed from the underground reserve; carrying material away shrinks it.
    pile = pileHeight(vein.material, stock);
  return { share: Math.max(0, Math.ceil(share * ORE_STEPS - 1e-9) / ORE_STEPS), begun: share < 1, loading: Boolean(vein.loading),
    extracting: Boolean(vein.extracting), pile };
}
// The look as a word: a vein is drawn again only when it changes.
export const lookKey = (look: DepositLook | null | undefined) => look ? `${look.share}${look.begun ? '' : '='}${look.loading ? '+' : ''}:${look.extracting ? '+' : ''}:${look.pile}${look.supplied ? ':supplied' : ''}` : '-';

// The same draws for the same site, whoever draws it: one stream for the feature of the ground, one for the vein
// and one for what only a near view shows, so that none of them changes with what is known or with the scale.
function draws(site: Pick<DepositPosition, 'x'>, stream: number) {
  let n = (Math.round(site.x * 4) ^ 0x9e3779b9 ^ Math.imul(stream, 0x85ebca6b)) >>> 0;
  return () => { n = Math.imul(n ^ n >>> 15, 0x2c1b3c6d) >>> 0; n = Math.imul(n ^ n >>> 12, 0x297a2d39) >>> 0; n = (n ^ n >>> 15) >>> 0; return n / 4294967296; };
}

// Outlines under the ground are worked in places along the ground (`u`, from the site) and depths under it (`d`).
// The part of an outline on one side of a line across one of the two: Sutherland and Hodgman's clip by a half-plane.
function halfPlane(points: readonly XY[], axis: 0 | 1, level: number, side: number): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, fa = (a[axis] - level) * side, fb = (b[axis] - level) * side;
    if (fa >= 0) out.push(a);
    if (fa > 0 && fb < 0 || fa < 0 && fb > 0) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
export const outlineArea = (points: readonly XY[]) => { let sum = 0; for (let i = 0; i < points.length; i++) { const p = points[i]!, q = points[(i + 1) % points.length]!; sum += p[0] * q[1] - q[0] * p[1]; } return Math.abs(sum) / 2; };
const solid = (points: readonly XY[]) => points.length > 2 && outlineArea(points) > 1e-6;
const inside = (points: readonly XY[], u: number, d: number) => {
  let found = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ui, di] = points[i]!, [uj, dj] = points[j]!;
    if (di > d !== dj > d && u < (uj - ui) * (d - di) / (dj - di) + ui) found = !found;
  }
  return found;
};
// A body cut where it is dug: the line across `axis` that leaves `share` of its area on the side kept (`side`
// +1, the side past the line; -1, the side before it), the ore there and the workings on the other side.
export function cutBody(parts: readonly (readonly XY[])[], share: number, axis: 0 | 1, side: number) {
  const values = parts.flat().map(p => p[axis]), first = Math.min(...values), last = Math.max(...values),
    total = parts.reduce((sum, part) => sum + outlineArea(part), 0), kept = (level: number) => parts.reduce((sum, part) => sum + outlineArea(halfPlane(part, axis, level, side)), 0);
  let level;
  if (share >= 1) level = side > 0 ? first : last;
  else {
    let lo = first, hi = last;
    for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (kept(mid) > share * total === side > 0) lo = mid; else hi = mid; }
    level = (lo + hi) / 2;
  }
  return { axis, side, level, total, ore: parts.map(part => halfPlane(part, axis, level, side)).filter(solid), worked: parts.map(part => halfPlane(part, axis, level, -side)).filter(solid) };
}
// A body lying along the ground from `a` to `b` between a top and a foot (depths, the two meeting at its ends), as
// an outline grown by `grow` metres all round; past its ends the growth is rounded off over twice as far.
function lens(a: number, b: number, top: (u: number) => number, foot: (u: number) => number, grow = 0, steps = 26): XY[] {
  const reach = grow * 2, from = a - reach, to = b + reach, edge: XY[] = [], back: XY[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = from + (to - from) * i / steps;
    if (u < a || u > b) {
      const end = u < a ? a : b, middle = (top(end) + foot(end)) / 2, half = grow * Math.sqrt(Math.max(0, 1 - ((u - end) / reach) ** 2));
      edge.push([u, middle - half]); back.unshift([u, middle + half]);
    } else { edge.push([u, top(u) - grow]); back.unshift([u, foot(u) + grow]); }
  }
  return [...edge, ...back];
}
// A pod about (u, d), its long half `along` a direction (du, dd) and its short half across it, its edge made uneven
// by `rough` (a share of each radius at each angle), grown by `grow` metres all round.
function pod(u: number, d: number, across: number, along: number, du: number, dd: number, rough: (angle: number) => number, grow = 0, corners = 18): XY[] {
  const length = Math.hypot(du, dd), vu = du / length, vd = dd / length;
  return Array.from({ length: corners }, (_, i) => {
    const angle = i / corners * Math.PI * 2, swell = 1 + rough(angle), x = (across * swell + grow) * Math.cos(angle), y = (along * swell + grow) * Math.sin(angle);
    return [u + x * vd + y * vu, d - x * vu + y * vd];
  });
}
// An unevenness along a body: two slow waves of their own for each body, from `random`.
function wobble(random: () => number, size: number, scale = 1) {
  const a = random() * 6.3, b = random() * 6.3, c = .6 + random() * .5;
  return (u: number) => (.62 * Math.sin(u * .45 * c / scale + a) + .38 * Math.sin(u * 1.3 * c / scale + b)) * size;
}

// The context a site is drawn in, for its ground and for its vein alike.
function context<Site extends DepositPosition, Parts extends DepositSurfaceParts = DepositSurfaceParts>(parts: Parts, site: Site, ground: TerrainPaintGround, pixel: number, rockTexture?: Texture | null) {
  // Surface caches omit the underlayer; vein caches keep their exact Graphics subtype.
  const under = parts.under as Parts['under'];
  const near = pixel < .1, thin = (width: number) => Math.max(width, 1.1 * pixel), at = (u: number) => site.x + u, high = (u: number) => ground.height(at(u)), g0 = high(0),
    low = (a: number, b: number) => { let y = Infinity; for (let u = a; u <= b; u += .5) y = Math.min(y, high(u)); return Math.min(y, high(b)); },
    // A place under the ground: so deep under the ground at the site, and never above the ground where it is, less a crust.
    sunk = (u: number, d: number, cover = COVER) => Math.min(g0 - d, high(u) - cover),
    // An outline in the world, without a corner on the one before it, which a line drawn round it could not turn.
    shape = (points: readonly XY[], cover?: number) => {
      const out: number[] = [];
      for (const [u, d] of points) {
        const x = at(u), y = sunk(u, d, cover), n = out.length;
        if (!n || Math.abs(x - out[n - 2]!) > 1e-6 || Math.abs(y - out[n - 1]!) > 1e-6) out.push(x, y);
      }
      if (out.length > 4 && Math.abs(out[0]! - out.at(-2)!) <= 1e-6 && Math.abs(out[1]! - out.at(-1)!) <= 1e-6) out.length -= 2;
      return out;
    },
    // An outline kept under the crust of the ground everywhere along it, so that what is cut of it is what is drawn.
    bury = (points: readonly XY[]): XY[] => points.map(([u, d]) => [u, Math.max(d, g0 - high(u) + COVER)]),
    art = { works: parts.works, under, front: parts.front, site, ground, pixel, near, thin, at, high, low, g0, sunk, shape, bury, rockTexture,
      size: Math.min(1.8, Math.max(1, Math.sqrt(Number(site.reserve) / DEPOSIT_RESERVE))), feature: draws(site, 1), vein: draws(site, 2), detail: draws(site, 3) };
  // The feature of the ground decides the dip of what lies in it, the same for everybody.
  return Object.assign(art, { dip: art.feature() < .5 ? -1 : 1 });
}
// Draws what everybody sees of a site into `works` and `front` (standing, and on the ground). `pixel` is the size of
// a screen pixel in metres at the scale the art is made for: lines are never thinner than a pixel, and what only a
// near view tells apart is left out from afar. The drawings are not emptied here: whoever owns them empties them by
// standing them at their anchor.
export function drawSite(parts: DepositSurfaceParts, site: SurfaceSite, ground: TerrainPaintGround, pixel: number, rockTexture?: Texture | null) {
  SITES[site.feature].surface(context(parts, site, ground, pixel, rockTexture));
}
// The survey posts of the veins known alone, into `works` (standing): what is left of the sites and their veins seen
// from afar, where both are a few pixels across. Each post stands as `post` draws it near, but of the cheapest shapes,
// for hundreds of them are drawn at once: the strokes of the poles are boxes, under all of them one shape filled, and
// the plates of a material are one shape filled and edged.
export function drawPosts(works: Graphics, sites: readonly Pick<Deposit, 'x' | 'material'>[], ground: TerrainPaintGround, pixel: number) {
  if (!sites.length) return;
  const shadow = Math.max(.12, 2.6 * pixel), pole = Math.max(.07, 1.1 * pixel), size = Math.max(.42, 4.5 * pixel), plates = new Map<CargoKind, { site: Pick<Deposit, 'x' | 'material'>; base: number; top: number }[]>(),
    stands = sites.map(site => { const foot = ground.height(site.x), base = foot - .15; return { site, base, top: Math.max(base + 3.1, foot + 26 * pixel) }; });
  for (const [width, style] of [[shadow, { color: DARK, alpha: .5 }], [pole, POST]] satisfies readonly (readonly [number, FillInput])[]) {
    for (const { site, base, top } of stands) works.rect(site.x - width / 2, base, width, top - size - base);
    works.fill(style);
  }
  for (const stand of stands) (plates.get(stand.site.material) ?? plates.set(stand.site.material, []).get(stand.site.material)!).push(stand);
  for (const [material, row] of plates) {
    for (const { site: { x }, top } of row) works.poly([x, top + size, x + size * .8, top, x, top - size, x - size * .8, top]);
    works.fill({ color: DEPOSIT_TONES[material].plate, alpha: .95 }).stroke({ color: DARK, width: Math.max(.03, .9 * pixel), alpha: .6 });
  }
}
// An announced point and, on arrival, its finite load. Refined supplies are pallets, never an invented ore seam.
export function drawAirdrop(parts: DepositSurfaceParts, site: KnownAirdrop, look: DepositLook, ground: TerrainPaintGround, pixel: number) {
  const art = context(parts, site, ground, pixel), zone = loadingZone(site), tone = site.supplies ? SUPPLY_TONE : DEPOSIT_TONES[site.material];
  along(art, parts.front, zone.lo - site.x, zone.hi - site.x,
    { color: tone.heap, width: Math.max(.16, 1.5 * pixel), alpha: .7 });
  if (look.pile > 0) cone(art, parts.works, 0, look.pile, tone.heap, tone.shade!);
  // The public event already has the field's selectable marker; no second survey sign is dropped with the cargo.
  return null;
}
// Draws the vein of a site into `works`, `under` and `front` (standing, under the ground and on it), as a faction
// that knows of it what `look` says (`depositLook`) sees it, in the beds of the earth `plan` (strata-art.ts) lays
// under the ground. Returns where the plate on the post stands, for a label over it.
export function drawVein(parts: DepositArtParts, site: Deposit, look: DepositLook, ground: TerrainPaintGround, pixel: number, plan: StrataPlan) {
  const base = context(parts, site, ground, pixel), lines = new Float64Array(4), tops = new Map<number, number>(),
    // The top of a bed of the earth, as a depth under the site, every metre along the ground and between.
    top = (bed: 0 | 1 | 2 | 3, i: number) => { const key = i * 4 + bed; if (!tops.has(key)) tops.set(key, base.g0 - bedLines(plan, base.at(i), 0, lines, 3)[bed]!); return tops.get(key)!; };
  const art = Object.assign(base, { look, bed: (bed: 0 | 1 | 2 | 3, u: number) => { const i = Math.floor(u), f = u - i; return top(bed, i) * (1 - f) + top(bed, i + 1) * f; } });
  SITES[site.feature].body(art);
  // The material reached by a working tool is visible at the same surface band
  // that collection checks. This is cached with the vein, with no per-frame mesh.
  if (look.loading || look.extracting || look.begun) {
    const zone = loadingZone(site), tone = DEPOSIT_TONES[site.material];
    along(art, parts.front, zone.lo - site.x, zone.hi - site.x,
      { color: tone.heap, width: Math.max(.16, 1.5 * pixel), alpha: look.loading || look.extracting ? .7 : .35 });
  }
  if (look.pile > 0) {
    const tone = DEPOSIT_TONES[site.material];
    if (site.material !== 'petroleo') cone(art, parts.works, 0, look.pile, tone.heap, tone.shade);
    else for (const u of [-1.1, .25]) {
      const x = art.at(u), y = ground.height(x) - .05, high = Math.min(1.4, .65 + look.pile * .25);
      parts.works.roundRect(x, y, 1.05, high, .15).fill(tone.shade).stroke({ color: tone.heap, width: art.thin(.035) });
      parts.works.rect(x + .12, y + .12, .81, Math.max(.1, high * .65)).fill(tone.light);
    }
  }
  return post(art, 0);
}

// A dump tipped on the ground from one place to the next: flanks at the angle loose rock rests at and a flat top,
// footed under the lowest ground it stands on, with its far flank in shade and the streaks of tipping in a near view.
function dump(art: SiteContext, g: Graphics, a: number, wide: number, tall: number, fill: number, shade: number, light: number) {
  const { at, low, near, thin } = art, foot = low(a, a + wide) - .25, h = Math.min(tall, wide / 3.2) + .25, run = h * 1.35, top = foot + h;
  g.poly([at(a), foot, at(a + run), top - .08, at(a + wide * .5), top, at(a + wide - run), top - .05, at(a + wide), foot]).fill(fill);
  g.poly([at(a + wide - run), top - .05, at(a + wide), foot, at(a + wide - run * .55), foot]).fill(shade);
  if (near) for (const k of [.25, .55, .8]) g.moveTo(at(a + run * k), foot + h * k * .95).lineTo(at(a + run * k - .5), foot + .1).stroke({ color: light, width: thin(.04), alpha: .4 });
}
// A stockpile run off a conveyor or a bucket: a cone with its apex a little blunt, and its far half in shade.
function cone(art: SiteContext, g: Graphics, u: number, tall: number, fill: number, shade: number) {
  const { at, low } = art, half = 1.6 * tall, foot = low(u - half, u + half) - .2, top = foot + tall + .2;
  g.poly([at(u - half), foot, at(u - half * .45), foot + (top - foot) * .62, at(u - .14 * tall), top - .04, at(u + .14 * tall), top - .04,
    at(u + half * .45), foot + (top - foot) * .62, at(u + half), foot]).fill(fill);
  g.poly([at(u + .14 * tall), top - .04, at(u + half * .45), foot + (top - foot) * .62, at(u + half), foot, at(u + half * .3), foot]).fill({ color: shade, alpha: .7 });
}
// A rock standing out of the ground on its own foot, its top broken and leaning: eight corners, with `random` for the shape.
function rock(art: SiteContext, g: Graphics, u: number, wide: number, tall: number, lean: number, fill: number, random: () => number) {
  const { at, low } = art, y = low(u, u + wide) - .18, r: [number, number, number, number, number] = [random(), random(), random(), random(), random()];
  const points = [at(u), y, at(u + wide), y, at(u + wide * .98 + lean * .45), y + tall * (.3 + r[0] * .25), at(u + wide * .84 + lean * .8), y + tall * (.62 + r[1] * .3),
    at(u + wide * .62 + lean), y + tall * (.8 + r[2] * .2), at(u + wide * .38 + lean), y + tall, at(u + wide * .16 + lean * .75), y + tall * (.55 + r[3] * .35),
    at(u + wide * .03 + lean * .35), y + tall * (.25 + r[4] * .2)],
    ridge = [at(u + wide * .56 + lean * .4), y + tall * .43],
    tone = (gain: number) => [16, 8, 0].reduce((c, shift) => c | Math.min(255, Math.round((fill >> shift & 255) * gain)) << shift, 0);
  g.poly(points).fill(rockFill(fill, art));
  // Broad faces belong to the native rock, not the material map. Upper-right daylight stays consistent.
  g.poly([...ridge, ...points.slice(2, 10)]).fill(rockFill(tone(1.17), art));
  g.poly([...ridge, ...points.slice(10), ...points.slice(0, 2)]).fill(rockFill(tone(.94), art));
  return y;
}
// A band that follows the ground between two places, a little under it.
function along(art: SiteContext, g: Graphics, a: number, b: number, style: StrokeStyle) {
  const { at, high } = art;
  g.moveTo(at(a), high(a) - .08);
  for (let u = a + 2; u < b; u += 2) g.lineTo(at(u), high(u) - .08);
  g.lineTo(at(b), high(b) - .08).stroke({ join: 'round', cap: 'round', ...style });
}
// A vein in the earth, cut where it is dug (`cut`, of the bodies `outline(0)` gives): each body is a tint over the
// rock with its halo fading out about it, in the tones of the ore past the cut and of the worked ground (`worked`)
// before it; then the bands in the ore, cut where it is.
function vein(art: VeinContext, outline: (grow: number) => readonly (readonly XY[])[], cut: BodyCut, tone: OreTint, worked = WORKED.fill, bands: readonly OreBand[] = []) {
  const { under, shape, look } = art, kept = (points: readonly XY[]) => look.begun ? halfPlane(points, cut.axis, cut.level, cut.side) : points;
  for (const [grow, alpha] of HALO) for (const points of outline(grow)) {
    const ore = kept(points);
    if (solid(ore)) under.poly(shape(ore)).fill({ color: tone.halo, alpha });
    if (!look.begun) continue;
    const dug = halfPlane(points, cut.axis, cut.level, -cut.side);
    if (solid(dug)) under.poly(shape(dug)).fill({ color: WORKED.halo, alpha: alpha * .6 });
  }
  for (const part of cut.worked) under.poly(shape(part)).fill({ color: worked, alpha: .24 });
  for (const part of cut.ore) under.poly(shape(part)).fill({ color: tone.body, alpha: tone.strength });
  for (const [points, color, alpha] of bands) { const ore = kept(points); if (solid(ore)) under.poly(shape(ore)).fill({ color, alpha }); }
}
// The face of a body being dug: a pale line where the ore is cut.
function face(art: VeinContext, cut: BodyCut, color: number, alpha = .55) {
  const { under, at, sunk, thin } = art, ends = cut.ore.flat().filter(p => Math.abs(p[cut.axis] - cut.level) < 1e-6);
  if (ends.length < 2) return;
  const sorted = ends.sort((a, b) => a[1 - cut.axis]! - b[1 - cut.axis]!), a = sorted[0]!, b = sorted.at(-1)!;
  under.moveTo(at(a[0]), sunk(a[0], a[1])).lineTo(at(b[0]), sunk(b[0], b[1])).stroke({ color, width: thin(.08), alpha, cap: 'round' });
}
// A shaft or a drift: a dark working along a path under the ground (a place along it and a depth at each corner),
// with its timber sets in a near view.
function working(art: VeinContext, points: readonly XY[], wide: number, cover = .02) {
  const { under, at, sunk, near, thin } = art, path: XY[] = [];
  for (const [u, d] of points) {
    const x = at(u), y = sunk(u, d, cover), last = path.at(-1);
    if (!last || Math.hypot(x - last[0], y - last[1]) > .01) path.push([x, y]);
  }
  if (path.length < 2) return;
  under.moveTo(...path[0]!);
  for (const p of path.slice(1)) under.lineTo(...p);
  under.stroke({ color: WORKED.void, width: thin(wide), alpha: .42, join: 'round', cap: 'round' });
  if (!near) return;
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1]!, [x1, y1] = path[i]!, length = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / length * wide * .6, ny = (x1 - x0) / length * wide * .6;
    for (let s = .8; s < length; s += 1.6) {
      const x = x0 + (x1 - x0) * s / length, y = y0 + (y1 - y0) * s / length;
      under.moveTo(x + nx, y + ny).lineTo(x - nx, y - ny).stroke({ color: TIMBER, width: thin(.05), alpha: .35 });
    }
  }
}
// The survey post at a vein known, with the plate that tells the material from afar.
function post(art: ReturnType<typeof context<Deposit>>, u: number, tone = DEPOSIT_TONES[art.site.material]) {
  const { works, at, high, pixel, thin, site } = art,
    base = high(u) - .15, top = Math.max(base + 3.1, high(u) + 26 * pixel), size = Math.max(.42, 4.5 * pixel);
  works.moveTo(at(u), base).lineTo(at(u), top - size).stroke({ color: DARK, width: Math.max(.12, 2.6 * pixel), alpha: .5, cap: 'round' });
  works.moveTo(at(u), base).lineTo(at(u), top - size).stroke({ color: POST, width: thin(.07), cap: 'round' });
  works.poly([at(u), top + size, at(u + size * .8), top, at(u), top - size, at(u - size * .8), top])
    .fill({ color: tone.plate, alpha: .95 }).stroke({ color: DARK, width: Math.max(.03, .9 * pixel), alpha: .6, join: 'round' });
  return { id: site.id, x: at(u), y: top + size };
}

// Each feature of the ground a site is read off: what everybody sees of it (`surface`), and what a faction that
// knows its vein sees besides (`body`).
const SITES: Record<DepositFeatureKind, { surface(art: SurfaceContext): void; body(art: VeinContext): void }> = {
  // Iron where banded ironstone crops out: ledges of it standing out of the ground, dipping, and boulders off
  // them, over ground stained with rust. Under it a lens of the ironstone in faint bands comes up under the ledges and
  // runs away down its bed, thinning; it is dug from under the outcrop down the bed, from a shaft beside it with a
  // headframe over it and a drift along the foot of the lens to the face, and a dump of waste beyond.
  outcrop: {
    surface(art) {
      const { works, front, near, thin, at, dip, feature: random } = art, ground = GROUND.outcrop, count = 4;
      for (let i = 0; i < count; i++) {
        const u = -7.5 + i * 15 / count + random() * 1.4, wide = 1.6 + random() * 1.6, tall = .5 + random() * 1, lean = dip * tall * .5,
          y = rock(art, works, u, wide, tall, lean, i % 2 ? ground.weathered : ground.rock, random);
        if (near) for (const k of [.3, .65]) works.moveTo(at(u + wide * k), y + tall * .12)
          .lineTo(at(u + wide * k + lean * .35), y + tall * .4)
          .lineTo(at(u + wide * k + lean * .5 - wide * .04), y + tall * .47)
          .lineTo(at(u + wide * k + lean * .7), y + tall * .7)
          .stroke({ color: ground.seam, width: thin(.014), alpha: .35 });
      }
      for (let i = 0; i < 5; i++) {
        const u = -10 + random() * 20, r = .25 + random() * .3;
        rock(art, works, u, r * 2, r * 1.3, 0, i % 2 ? ground.seam : ground.weathered, random);
      }
      along(art, front, -9.5, 9.5, { color: ground.stain, width: Math.max(.3, 2.4 * art.pixel), alpha: .3 });
    },
    body(art) {
      const { works, look, size, dip, bed, bury, vein: random } = art, tone = ORE_TONES.outcrop, a = -5, b = 13 + 7 * size, thick = 1.7 * size,
        uneven = wobble(random, .16), share = (s: number) => (s - a) / (b - a),
        // Along the bed it lies in, from where it comes up to the tail it thins out to: `s` runs down the dip.
        middle = (s: number) => { const u = dip * s; return bed(1, u) + (bed(3, u) - bed(1, u)) * (.18 + .32 * share(s)); },
        half = (s: number) => { const t = Math.min(1, Math.max(0, share(s))); return thick * Math.sin(Math.PI * t) ** .55 * (1 - .4 * t) * (1 + uneven(s)); },
        turn = (points: readonly XY[]): XY[] => points.map(([s, d]) => [dip * s, d]),
        outline = (grow: number) => [bury(turn(lens(a, b, (s: number) => middle(s) - half(s), (s: number) => middle(s) + half(s), grow)))],
        bands: OreBand[] = [-.6, -.3, 0, .3, .6].map((k: number, i) => [turn(lens(a, b, (s: number) => middle(s) + (k - .07) * half(s), (s: number) => middle(s) + (k + .07) * half(s))),
          i % 2 ? tone.light : tone.band, i % 2 ? .07 : .1]),
        cut = cutBody(outline(0), look.share, 0, dip);
      vein(art, outline, cut, tone, WORKED.fill, bands);
      if (look.begun) {
        const shaft = a - 2.2, sunkTo = middle(a + 2) + .4, upTo = cut.level * dip, drift: XY[] = [];
        for (let s = a + 1; s < upTo; s += 2) drift.push([dip * s, middle(s) + .45 * half(s)]);
        drift.push([cut.level, middle(upTo) + .45 * half(upTo)]);
        working(art, [[dip * shaft, -1], [dip * shaft, sunkTo], ...drift], .28);
        headframe(art, dip * shaft);
        const dug = 1 - look.share, wide = 4 + 8 * dug, from = dip > 0 ? dip * shaft - 1.8 - wide : dip * shaft + 1.8;
        dump(art, works, from, wide, .6 + 2.4 * dug, WORKED.dump, WORKED.shade, tone.light);
      }
      if (look.loading) face(art, cut, tone.light);
    },
  },
  // Iron in ruins is their steel: rusted beams jutting from the heaps of rubble at the foot of the walls (ruins-art.ts),
  // wire tangled in them and rust bled over the slab. Under it a lens of rubble and scrap, dug as a trench from one end,
  // with the scrap of it piled beyond.
  ruins: {
    surface(art) {
      const { works, front, near, thin, pixel, ground, site, feature: random } = art, steel = GROUND.ruins,
        plan = ruinPlan(ground, ground.features.find(f => f.kind === 'ruins' && f.peak === site.x)!), rubble = (x: number) => rubbleAt(plan, ground, x), streaks: [XY, XY][] = [], lips: [XY, XY][] = [];
      // A beam of rolled steel from each heap, seen from its side: its web between the lips of its flanges, its top end
      // torn off, its foot where it comes out of the rubble, with blocks of it fallen over.
      for (const heap of plan.heaps) {
        const foot = heap.peak + (random() - .5) * (heap.east - heap.west) * .25, lean = (.4 + random() * .55) * (random() < .5 ? -1 : 1), long = 1.6 + random() * 1.6,
          torn = random() * .35, wide = Math.max(.24, 1.1 * pixel), dx = Math.sin(lean), dy = Math.cos(lean), nx = dy * wide / 2, ny = -dx * wide / 2,
          y = rubble(foot), corners = [[foot - nx, rubble(foot - nx)], [foot + nx, rubble(foot + nx)],
            [foot + nx + dx * long, y + ny + dy * long], [foot - nx + dx * (long - torn), y - ny + dy * (long - torn)]];
        works.poly(corners.flat()).fill(steel.steel);
        for (const k of [.32, -.32]) lips.push([[foot + nx * k * 2, y + ny * k * 2], [foot + nx * k * 2 + dx * (long - torn * (.5 - k)), y + ny * k * 2 + dy * (long - torn * (.5 - k))]]);
        streaks.push([[foot + dx * .2, y + dy * .2], [foot + dx * long * .8, y + dy * long * .8]]);
        for (const side of [-1, 1]) {
          const x = foot + side * (wide * .5 + .04 + random() * .1), size = .12 + random() * .1, top = rubble(x);
          works.poly([x - size, top - size * .5, x + size * .8, top - size * .45, x + size * .6, top + size * .35, x - size * .7, top + size * .3]).fill(side < 0 ? RUIN_TONES.light : RUIN_TONES.brick);
        }
      }
      if (near) {
        for (const line of lips) works.moveTo(...line[0]).lineTo(...line[1]);
        works.stroke({ color: steel.wire, width: thin(.04), alpha: .7 });
        for (const line of streaks) works.moveTo(...line[0]).lineTo(...line[1]);
        works.stroke({ color: steel.rust, width: thin(.03), alpha: .45 });
      }
      // Wire and bars tangled in the rubble, in a near view.
      const wires: [number, number, number][] = plan.heaps.map(heap => [heap.west + (heap.east - heap.west) * (.2 + random() * .6), .7 + random() * .8, random() < .5 ? -1 : 1]);
      if (near) {
        for (const [x, reach, side] of wires) {
          const y = rubble(x) - .03;
          works.moveTo(x, y).quadraticCurveTo(x + side * reach * .2, y + reach, x + side * reach * .8, y + reach * .7);
        }
        works.stroke({ color: steel.wire, width: thin(.035), alpha: .7 });
      }
      // Rust bled from the steel over the slab: a stain on its wearing course and no deeper than the slab.
      const from = plan.slab.start + .8, to = plan.slab.end - .8, edge: number[] = [];
      for (let x = from; x < to; x += .5) edge.push(x);
      edge.push(to);
      front.poly([...edge.flatMap(x => [x, ground.height(x) - .005]), ...[...edge].reverse().flatMap(x => [x, ground.height(x) - SLAB * .55])]).fill({ color: steel.stain, alpha: .22 });
    },
    body(art) {
      const { works, under, look, size, dip, near, thin, shape, bury, vein: random, detail } = art, tone = ORE_TONES.ruins, W = Math.min(26, 16 * size), H = 3.2 * size, d0 = .35,
        uneven = wobble(random, .18), lean = (random() - .5) * .5,
        foot = (u: number) => { const x = 2 * u / W; return d0 + H * Math.max(0, 1 - x * x) ** .55 * (1 + lean * x) * (1 + uneven(u)); },
        outline = (grow: number) => [bury(lens(-W / 2, W / 2, () => d0, foot, grow))],
        cut = cutBody(outline(0), look.share, 0, dip);
      vein(art, outline, cut, tone);
      // The rubble the scrap lies in: broken concrete in a near view.
      if (near) for (const part of cut.ore) for (let i = 0; i < 24; i++) {
        const u = -W / 2 + detail() * W, d = d0 + detail() * H, r = .14 + detail() * .28;
        if (inside(part, u, d)) under.poly(shape([[u - r, d - r * .3], [u + r * .3, d - r * .7], [u + r, d + r * .2], [u, d + r * .6]])).fill({ color: WORKED.stone, alpha: .22 });
      }
      // The scrap in the rubble: beams at every angle, and wire in a near view.
      for (let i = 0; i < 9; i++) {
        const u = -W / 2 + 1 + random() * (W - 2), d = d0 + .3 + random() * Math.max(.2, foot(u) - d0 - .8), length = .8 + random() * 1.4, thick = .1 + random() * .1, angle = random() * Math.PI,
          cu = Math.cos(angle), cd = Math.sin(angle);
        if ((u - cut.level) * dip < 0) continue;
        under.poly(shape([[u - cu * length / 2 - cd * thick, d - cd * length / 2 + cu * thick], [u + cu * length / 2 - cd * thick, d + cd * length / 2 + cu * thick],
          [u + cu * length / 2 + cd * thick, d + cd * length / 2 - cu * thick], [u - cu * length / 2 + cd * thick, d - cd * length / 2 - cu * thick]])).fill({ color: i % 3 ? tone.band : tone.light, alpha: .45 });
        if (near) under.moveTo(art.at(u), art.sunk(u, d + .3)).lineTo(art.at(u + .9), art.sunk(u + .9, d - .2)).stroke({ color: tone.band, width: thin(.03), alpha: .35 });
      }
      if (look.begun) {
        const dug = 1 - look.share, wide = 3 + 6 * dug, edge = -dip * (W / 2 + 1);
        dump(art, works, dip > 0 ? edge - wide : edge, wide, .6 + 1.6 * dug, tone.shade, GROUND.ruins.wire, tone.light);
      }
      if (look.loading) face(art, cut, tone.light);
    },
  },
  // Alloys where scree gathers at the foot of a ridge: blocks of a pale host rock and dark heavy ones among them.
  // Under it uneven pods of chromite and manganese strung down a bed in a paler host, dug along the string from the
  // first by an incline from an adit, with the ore piled at its mouth.
  talus: {
    surface(art) {
      const { works, front, at, high, near, thin, feature: random } = art, ground = GROUND.talus;
      for (let i = 0; i < 11; i++) {
        const u = -11 + i * 2 + random() * 1.2, wide = .4 + random() * (i % 3 ? .8 : 1.3), dark = i % 4 === 1,
          y = rock(art, works, u, wide, wide * (.6 + random() * .4), (random() - .5) * .3, dark ? ground.dark : i % 2 ? ground.rock : ground.weathered, random);
        if (near && dark) works.moveTo(at(u + wide * .3), y + wide * .35).lineTo(at(u + wide * .43), y + wide * .48)
          .lineTo(at(u + wide * .51), y + wide * .46).lineTo(at(u + wide * .6), y + wide * .55)
          .stroke({ color: ground.glint, width: thin(.015), alpha: .25 });
      }
      for (let i = 0; i < 9; i++) {
        const u = -10 + random() * 20, r = .12 + random() * .2, y = high(u) - .05;
        front.poly([at(u - r), y - r * .5, at(u - r * .6), y + r * .55, at(u + r * .5), y + r * .6, at(u + r), y - r * .4]).fill(rockFill(i % 3 ? ground.rock : ground.dark, art));
      }
    },
    body(art) {
      const { works, under, look, size, dip, bed, shape, bury, vein: random } = art, tone = ORE_TONES.talus, count = 4, pods: OrePod[] = [], scale = size ** .7;
      for (let i = 0; i < count; i++) {
        const s = -4 + i * 4.6 * size ** .5 + (random() - .5) * 1.2, u = dip * s, d = bed(1, u) + (bed(3, u) - bed(1, u)) * (.3 + .12 * i) + (random() - .5) * .8,
          slope = (bed(2, u + 2) - bed(2, u - 2)) / 4 + .12 * dip, along = (1.3 + random() * .8) * scale, across = (.6 + random() * .35) * scale,
          p = random() * 6.3, q = random() * 6.3, r = random() * 6.3;
        pods.push({ s, u, d, along, across, slope, rough: (angle: number) => .18 * Math.sin(2 * angle + p) + .11 * Math.sin(3 * angle + q) + .06 * Math.sin(5 * angle + r) });
      }
      const outline = (grow: number) => pods.map(p => bury(pod(p.u, p.d, p.across, p.along, 1, p.slope, p.rough, grow))),
        // The host the pods are strung in, along the string through them and a little past its ends.
        first = pods[0]!.s - 3, last = pods.at(-1)!.s + 3, string = (s: number) => {
          const i = Math.max(0, Math.min(count - 2, pods.findLastIndex(p => p.s <= s))), a = pods[i]!, b = pods[i + 1]!, t = (s - a.s) / (b.s - a.s);
          return a.d + (b.d - a.d) * t;
        },
        host = (grow: number): XY[] => {
          const reach = 1.6 * scale + grow, round = (s: number) => Math.sqrt(Math.max(0, 1 - ((2 * s - first - last) / (last - first)) ** 2));
          return lens(first, last, (s: number) => string(s) - reach * round(s), (s: number) => string(s) + reach * round(s)).map(([s, d]) => [dip * s, d]);
        };
      for (const [grow, alpha] of [[.8, .08], [0, .09]] satisfies XY[]) under.poly(shape(host(grow))).fill({ color: tone.host, alpha });
      const cut = cutBody(outline(0), look.share, 0, dip);
      vein(art, outline, cut, tone);
      if (look.begun) {
        const mouth = dip * (pods[0]!.s - 6), upTo = cut.level * dip, path: XY[] = [[mouth, -.5]];
        for (const p of pods) if (p.s < upTo) path.push([p.u, p.d]);
        path.push([cut.level, string(Math.min(upTo, pods.at(-1)!.s))]);
        working(art, path, .26);
        adit(art, mouth);
        const dug = 1 - look.share, tall = .6 + 1.6 * dug;
        cone(art, works, mouth - dip * (2.2 + 1.55 * tall), tall, WORKED.dump, WORKED.shade);
      }
      if (look.loading) face(art, cut, tone.light);
    },
  },
  // Silica in dunes: a band of pale quartz sand along the dune. Under it the bed of white sand the dune stands on,
  // in faint cream laminae, dug from one end, the pit behind the face backfilled with a pond at its foot and the
  // sand stockpiled by it.
  dune: {
    surface(art) {
      const { front, near, at, high, thin, feature: random } = art, ground = GROUND.dune;
      along(art, front, -16, 16, { color: ground.stain, width: Math.max(.3, 2.4 * art.pixel), alpha: .35 });
      const ripples = Array.from({ length: 9 }, () => -13 + random() * 26);
      if (near) for (const u of ripples) front.moveTo(at(u), high(u) - .05).quadraticCurveTo(at(u + .3), high(u + .3) + .02, at(u + .7), high(u + .7) - .05)
        .stroke({ color: ground.ripple, width: thin(.03), alpha: .45 });
    },
    body(art) {
      const { works, under, look, size, g0, high, bed, shape, bury, vein: random } = art, tone = ORE_TONES.dune, W = Math.min(52, 32 * size),
        side = random() < .5 ? -1 : 1, uneven = wobble(random, .2, 2),
        top = (u: number) => Math.max(.4, g0 - high(u) + COVER),
        deep = (u: number) => { const x = 2 * u / W; return Math.max(0, (bed(1, u) + bed(2, u)) / 2 - top(u)) * (.8 + uneven(u)) * Math.max(0, 1 - x * x) ** .35; },
        outline = (grow: number) => [bury(lens(-W / 2, W / 2, top, (u: number) => top(u) + deep(u), grow))],
        bands: OreBand[] = [.35, .7].map(f => [lens(-W / 2, W / 2, (u: number) => top(u) + (f - .025) * deep(u), (u: number) => top(u) + (f + .025) * deep(u)), tone.band, .14]),
        cut = cutBody(outline(0), look.share, 0, side);
      vein(art, outline, cut, tone, WORKED.sand, bands);
      // The pit floods where it was dug deepest.
      for (const part of cut.worked) {
        const pond = halfPlane(part, 1, Math.max(...part.map(p => p[1])) - .5, 1);
        if (solid(pond)) under.poly(shape(pond)).fill({ color: WORKED.water, alpha: .5 });
      }
      if (look.begun) {
        const dug = 1 - look.share;
      }
      if (look.loading) face(art, cut, tone.light);
    },
  },
  // Petroleum where it seeps into wet low ground: a pool of tar with a sheen, blackened reeds and ground darkened
  // about it. Under it a bed of sand arches gently under a sealing bed, thinning out on the flanks; the crest of it
  // holds the petroleum over the water, level as fluids lie, a trace of gas at the top. It is drawn from a well
  // beside the seep, under a pumpjack, and the water rises under it as it goes.
  lowland: {
    surface(art) {
      const { works, front, at, high, near, thin, feature: random } = art, ground = GROUND.lowland, a = -10 + random(), b = -2 - random() * .6, steps = 10;
      along(art, front, -13, 12, { color: ground.stain, width: Math.max(.45, 3.2 * art.pixel), alpha: .32 });
      const lip = Array.from({ length: steps + 1 }, (_, i) => a + (b - a) * i / steps);
      // A lens of tar in a hollow of the ground: its surface a hair over the ground, deepest in the middle.
      // The computed final corner can fall a fraction past b. A negative
      // rounding residue raised to .6 would send NaN vertices to Pixi.
      const deep = (u: number) => Math.max(0, Math.sin(Math.PI * (u - a) / (b - a))) ** .6;
      front.poly([...lip.flatMap((u: number) => [at(u), high(u) + .04 * deep(u)]), ...lip.slice(1, -1).reverse().flatMap((u: number) => [at(u), high(u) - .28 * deep(u)])]).fill({ color: ground.tar, alpha: .94 });
      const sheen = [random(), random(), random()];
      if (near) for (const k of sheen) { const u = a + (b - a) * (.15 + k * .6); front.moveTo(at(u), high(u) + .04).lineTo(at(u + .9), high(u + .9) + .04).stroke({ color: ground.sheen, width: thin(.03), alpha: .5 }); }
      const reeds: [number, number, number][] = Array.from({ length: 7 }, () => [-12 + random() * 10, .6 + random() * .7, (random() - .5) * .3]);
      if (near) for (const [u, tall, lean] of reeds) works.moveTo(at(u), high(u) - .1).lineTo(at(u + lean), high(u) + tall).stroke({ color: ground.reed, width: thin(.03), alpha: .65 });
    },
    body(art) {
      const { under, look, size, near, thin, at, sunk, bed, shape, bury, vein: random } = art, tone = ORE_TONES.lowland, L = Math.min(24, 15 * size), B = 2.2 * size,
        uneven = wobble(random, .12), round = (u: number) => Math.sqrt(Math.max(0, 1 - (u / L) ** 2)),
        middle = (u: number) => bed(2, u) + (bed(3, u) - bed(2, u)) * .4 - B * Math.exp(-((u / (.45 * L)) ** 2)),
        half = (u: number) => 1.6 * size * (1 + uneven(u)) * round(u),
        reservoir = (grow: number) => bury(lens(-L, L, (u: number) => middle(u) - half(u), (u: number) => middle(u) + half(u), grow)),
        crest = Math.min(...Array.from({ length: 49 }, (_, i) => { const u = -L + L * i / 24; return middle(u) - half(u); })),
        contact = crest + 1 + .8 * size, trap = halfPlane(reservoir(0), 1, contact, -1), cut = cutBody([trap], look.share, 1, -1);
      // The water the bed holds, fading out into the rock about it, and the seal over it.
      for (const [grow, alpha] of HALO) under.poly(shape(reservoir(grow))).fill({ color: tone.halo, alpha: alpha * .8 });
      under.poly(shape(reservoir(0))).fill({ color: tone.water, alpha: .2 });
      under.poly(shape(lens(-L, L, (u: number) => middle(u) - half(u) - 1.1 * round(u), (u: number) => middle(u) - half(u)))).fill({ color: tone.seal, alpha: .16 });
      for (const part of cut.worked) under.poly(shape(part)).fill({ color: tone.water, alpha: .18 });
      // The petroleum, fading up into the seal and out along the bed, and level on the water.
      for (const [grow, alpha] of HALO) { const oil = halfPlane(reservoir(grow), 1, cut.level, -1); if (solid(oil)) under.poly(shape(oil)).fill({ color: tone.body, alpha: alpha * .8 }); }
      for (const part of cut.ore) under.poly(shape(part)).fill({ color: tone.body, alpha: tone.strength });
      const gas = halfPlane(reservoir(0), 1, crest + .35, -1);
      if (solid(gas)) under.poly(shape(gas)).fill({ color: tone.gas, alpha: .22 });
      // Where the petroleum meets the water under it, level.
      if (near || look.loading) face(art, cut, tone.light, look.loading ? .55 : .3);
      const well = 4.5;
      if (look.begun || look.loading) {
        const foot = middle(well) - .2 * half(well);
        under.moveTo(at(well), sunk(well, -1, .02)).lineTo(at(well), sunk(well, foot, .02)).stroke({ color: 0x3b3f3c, width: thin(.18), alpha: .55 });
        under.moveTo(at(well), sunk(well, -1, .02)).lineTo(at(well), sunk(well, foot - .1, .02))
          .stroke(look.loading ? { color: tone.light, width: thin(.06), alpha: .6 } : { color: 0x8a8f86, width: thin(.04), alpha: .35 });
        pumpjack(art, well);
      }
    },
  },
};

// A headframe over a shaft: two legs and a strut up to the sheave the hoist rope runs over; while ore is hoisted,
// its skip halfway up.
function headframe(art: VeinContext, u: number) {
  const { works, at, low, thin, dip, look } = art, foot = low(u - 1.2, u + 1.2) - .2, top = foot + 5.6, strut = u - dip * 3;
  for (const [a, b] of [[u - 1.1, u - .25], [u + 1.1, u + .25]] satisfies XY[]) works.moveTo(at(a), foot).lineTo(at(b), top).stroke({ color: POST, width: thin(.16), cap: 'round' });
  works.moveTo(at(strut), low(strut - .3, strut + .3) - .2).lineTo(at(u), top - .6).stroke({ color: POST, width: thin(.13), cap: 'round' });
  for (const k of [.35, .68]) works.moveTo(at(u - 1.1 + .85 * k), foot + 5.6 * k).lineTo(at(u + 1.1 - .85 * k), foot + 5.6 * k).stroke({ color: POST, width: thin(.07) });
  works.circle(at(u), top + .25, .5).stroke({ color: LINE, width: thin(.09) });
  works.moveTo(at(u - .25), top).lineTo(at(u + .25), top).stroke({ color: LINE, width: thin(.12) });
  if (look.loading) {
    works.moveTo(at(u), top + .25).lineTo(at(u), foot + 3.4).stroke({ color: DARK, width: thin(.03), alpha: .8 });
    works.poly([at(u - .35), foot + 2.4, at(u + .35), foot + 2.4, at(u + .35), foot + 3.4, at(u - .35), foot + 3.4]).fill(ORE_TONES.outcrop.pile);
  }
}
// The mouth of an adit: a timber set framing the dark of the drift.
function adit(art: SiteContext, u: number) {
  const { works, at, low, thin } = art, foot = low(u - 1, u + 1) - .2;
  works.poly([at(u - .7), foot, at(u + .7), foot, at(u + .7), foot + 1.8, at(u - .7), foot + 1.8]).fill({ color: WORKED.void, alpha: .9 });
  for (const side of [-1, 1]) works.moveTo(at(u + side * .75), foot).lineTo(at(u + side * .75), foot + 1.9).stroke({ color: TIMBER, width: thin(.14) });
  works.moveTo(at(u - 1), foot + 1.9).lineTo(at(u + 1), foot + 1.9).stroke({ color: TIMBER, width: thin(.16) });
}
// A pumpjack over a well: the walking beam on its post, the horse head over the well and the counterweight on
// the crank behind it, with drums beside. While petroleum is drawn the head is down.
function pumpjack(art: VeinContext, u: number) {
  const { works, at, low, thin, look } = art, base = low(u - 3.4, u + 1.6) - .15, pivot: XY = [u - 1, base + 2.6], tilt = look.loading ? -.2 : 0,
    ahead: XY = [pivot[0] + 1.3 * Math.cos(tilt), pivot[1] + 1.3 * Math.sin(tilt)], behind: XY = [pivot[0] - 2 * Math.cos(tilt), pivot[1] - 2 * Math.sin(tilt)],
    point = ([x, y]: XY): XY => [at(x), y];
  works.poly([at(u - 3.4), base, at(u + 1.6), base, at(u + 1.6), base + .3, at(u - 3.4), base + .3]).fill(POST);
  for (const leg of [u - 1.6, u - .4]) works.moveTo(at(leg), base + .3).lineTo(...point(pivot)).stroke({ color: POST, width: thin(.12) });
  works.moveTo(...point(behind)).lineTo(...point(ahead)).stroke({ color: POST, width: thin(.22), cap: 'round' });
  const down: XY = [Math.sin(tilt), -Math.cos(tilt)], forward: XY = [Math.cos(tilt), Math.sin(tilt)], head = (k: number, j: number): XY => [ahead[0] + forward[0] * k + down[0] * j, ahead[1] + forward[1] * k + down[1] * j];
  works.poly([...head(-.15, -.3), ...head(.35, -.2), ...head(.35, .9), ...head(.05, .95)].map((v, i) => i % 2 ? v : at(v))).fill(0x8e9585);
  const hang = head(.3, .9);
  works.moveTo(at(hang[0]), hang[1]).lineTo(at(u), base + .55).stroke({ color: DARK, width: thin(.03), alpha: .8 });
  works.poly([at(u - .15), base + .3, at(u + .15), base + .3, at(u + .15), base + .7, at(u - .15), base + .7]).fill(LINE);
  works.poly([at(u - 3.3), base + .3, at(u - 2.4), base + .3, at(u - 2.4), base + 1.1, at(u - 3.3), base + 1.1]).fill(0x6d7768);
  works.circle(at(u - 2.85), base + 1.25, .5).fill(0x5f685b);
  works.moveTo(...point(behind)).lineTo(at(u - 2.85), base + 1.25).stroke({ color: POST, width: thin(.08) });
  for (const [i, x] of [u + 2.6, u + 3.4].entries()) {
    const y = low(x, x + .62) - .15;
    works.poly([at(x), y, at(x + .62), y, at(x + .62), y + 1.05, at(x), y + 1.05]).fill(i % 2 ? DEPOSIT_TONES.petroleo.shade : DEPOSIT_TONES.petroleo.heap);
  }
}
