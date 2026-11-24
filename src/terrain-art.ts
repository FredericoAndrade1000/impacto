import type { Container, StrokeInput } from 'pixi.js';
import type { Point } from './math.ts';
import type { Terrain, TerrainRegion, TerrainId, RoughGround } from './terrain.ts';
import type { DrawingScene, DrawingVehicle } from './scene-drawing-contract.ts';
type TrailVehicle = Pick<DrawingVehicle, 'vx' | 'slip'>;
import type { Effects } from './effects.ts';
import type { EffectCamera } from './effect-types.ts';
import type { XY } from './canvas-art.ts';
export type TerrainPaintGround = Pick<Terrain, 'id' | 'seed' | 'length' | 'center' | 'spacing' | 'minX' | 'maxX' | 'minHeight' | 'points' | 'sectors' | 'features' | 'rocks' | 'roads' | 'biomes' | 'height' | 'surface' | 'materialAt'> & { regionAt?: Terrain['regionAt'] };
interface GroundTone { top: number; body: number; deep: number; vein: number; rim: number; crust: number }
interface TrailMark { a: number; b: number; y1: number; y2: number; surface: string; track: boolean }
interface TrailChunk { marks: TrailMark[]; x: number; y: number; left: number; right: number; bottom: number; top: number; graphics: Graphics | null; dirty?: boolean }
interface TrailContact extends Point { surface: string; track: boolean }
import { Graphics } from 'pixi.js';
import { Random, lerp } from './math.ts';
import { TERRAIN_PROFILES, WORLD_BLEND, BUMPS_DEPTH } from './terrain.ts';
import { anchorGraphics } from './world-anchor.ts';
import { ruinFloor, ruinEarth, inSlab, drawSlab, drawSlabDetail } from './ruins-art.ts';
import { groundBandDepth, groundBandWave } from './strata-art.ts';
import { simplifyGround } from './terrain-lod.ts';
import { laidOver } from './roads.ts';

const section = (terrain: TerrainPaintGround, start: number, end: number) => [terrain.surface(start),
  ...terrain.points.filter(p => p.x > start && p.x < end), terrain.surface(end)];
// Where two grounds meet, one laps under the other: for every metre of depth, the two ends of a layer lie this far along the ground.
const LAP = .55;
// Drawn with its bumps, the ground has every layer under its crust start this far under its line: under the deepest of them.
const BUMPS_UNDER = BUMPS_DEPTH + .01;
// How many corners of the top drawn with its bumps a piece of the shade under it runs along.
const SHADE_PIECE = 128;
// A deep buried edge keeps each corner the ground turns at by more than this, in metres: it then strays from
// the shape of the outline it hangs from by no more than twice this, and a layer over .7 m deep never crosses
// that outline, however few corners a distant view draws it with.
const UNDERSIDE_ERROR = .2;
// `end`, where given, is the place [x, y] where a layer ends under the ground past an end of `points`, at x.
function strip(points: (Point & { wave?: number })[], top: number, bottom: number, end: ((x: number) => XY) | null = null, depthAt: (p: Point & { wave?: number }) => number = () => bottom, edge: readonly number[] | null = null) {
  // Keep the entire contact edge. Deep, buried layer edges can use fewer
  // vertices without altering the silhouette or generating frame-time work.
  let underside = points;
  if (bottom > .7 && points.length > 8) {
    const corners = new Set(simplifyGround(points, UNDERSIDE_ERROR));
    underside = points.filter((p, i) => i % 4 === 0 || corners.has(p));
  }
  let foot = underside.map((p): XY => [p.x, p.y - depthAt(p)]);
  if (end) {
    const first = end(points[0]!.x), last = end(points.at(-1)!.x);
    foot = [first, ...foot.filter(([x]) => x > first[0] + .05 && x < last[0] - .05), last];
  }
  return [...(edge || points.flatMap(p => [p.x, p.y - top])), ...foot.reverse().flat()];
}

// Art palettes deliberately live outside the traction/impact material table.
// Every layer is below the shared contact outline; only light, paint and plants
// sit above it. Nothing here is sent to the simulation.
const SOIL_ART: Readonly<Record<string, GroundTone>> = Object.freeze({
  soil: { top: 0x9a957b, body: 0x69725d, deep: 0x4b5346, vein: 0xb8a27e, rim: 0xc2b995, crust: .16 },
  gravel: { top: 0xa49a83, body: 0x70766a, deep: 0x50574a, vein: 0xc2ac86, rim: 0xc9c1a4, crust: .27 },
  mud: { top: 0x77735b, body: 0x485346, deep: 0x3a453b, vein: 0x888065, rim: 0xaaa98b, crust: .24 },
  sand: { top: 0xd0b681, body: 0xab956b, deep: 0x837654, vein: 0xe2cda0, rim: 0xe5d0a3, crust: .52 },
  rock: { top: 0x989f91, body: 0x66766d, deep: 0x4b5650, vein: 0xb9b6a0, rim: 0xc5c9b0, crust: .14 },
  concrete: { top: 0xadb1a8, body: 0x858a82, deep: 0x62675f, vein: 0xbebdaf, rim: 0xcfcec2, crust: .13 },
});
const PLATEAU_ART: Readonly<Record<string, GroundTone>> = Object.freeze({ ...SOIL_ART, rock: { ...SOIL_ART.rock!,
  top: 0xb4a281, body: 0x897658, deep: 0x615d4d, vein: 0xc2ab7e, rim: 0xd8c29b },
  gravel: { ...SOIL_ART.gravel!, top: 0xb1a488, body: 0x837a64, deep: 0x5f594a } });
// What a biome paints its ground with, and its ordinary ground with nothing laid on it. The earth under
// the first two metres is the strata's.
const groundArt = (id: TerrainId) => id === 'plateau' ? PLATEAU_ART : SOIL_ART;
const plainGround = (id: TerrainId) => groundArt(id)[TERRAIN_PROFILES[id].surface];
const alike = (a: TerrainId, b: TerrainId) => plainGround(a) === plainGround(b);
const ease = (t: number) => t * t * (3 - 2 * t);
const tint = (a: number, b: number, t: number) => [16, 8, 0].reduce((mixed, shift) => mixed | Math.round(lerp(a >> shift & 255, b >> shift & 255, t)) << shift, 0);

// Where the world passes from one biome to the next, the look of each gives way to the other's along the
// stretch their heights are faded over: the neighbour at x and how much of it shows, a half at the border.
export function biomeFade(biomes: readonly TerrainRegion[], x: number) {
  let i = 0; while (i < biomes.length - 1 && biomes[i]!.end <= x) i++;
  const here = biomes[i]!;
  if (i > 0 && x - here.start < WORLD_BLEND)
    return { here, other: biomes[i - 1]!, share: 1 - ease((x - here.start + WORLD_BLEND) / (2 * WORLD_BLEND)) };
  if (i < biomes.length - 1 && here.end - x < WORLD_BLEND)
    return { here, other: biomes[i + 1]!, share: ease((x - here.end + WORLD_BLEND) / (2 * WORLD_BLEND)) };
  return { here, other: null, share: 0 };
}
// A fade is painted in slices this wide, each a step of colour too small to see.
const FADE_STEP = 4;
// The earth goes down past the foot of the widest view, where a long flight is framed from far away.
export const earthFloor = (terrain: TerrainPaintGround) => Math.min(-60, terrain.minHeight - 60) - 4000;
// What a view may show: a landscape between its two ends, a test track as far as its ground goes, and
// the earth down to its foot.
export function groundView(terrain: TerrainPaintGround) {
  const scenic = TERRAIN_PROFILES[terrain.id]?.battle;
  return { minX: scenic ? terrain.minX : terrain.points[0]!.x, maxX: scenic ? terrain.maxX : terrain.points.at(-1)!.x, minY: earthFloor(terrain) };
}

function contourLine(g: Graphics, terrain: TerrainPaintGround, start: number, end: number, depth: number, style: StrokeInput) {
  const points = section(terrain, start, end);
  for (const [i, p] of points.entries()) i ? g.lineTo(p.x, p.y - depth) : g.moveTo(p.x, p.y - depth);
  g.stroke(style);
}

function stone(g: Graphics, x: number, y: number, width: number, height: number, color: number, alpha = .7, terrain?: TerrainPaintGround) {
  const at = (dx: number, dy: number): XY => [x + dx, Math.min(y + dy, terrain ? terrain.height(x + dx) - .007 : Infinity)],
    highlightA = at(-width * .31, height * .55), highlightB = at(width * .1, height * .84);
  g.poly([...at(-width * .5, 0), ...at(-width * .32, height * .63), ...at(width * .12, height),
    ...at(width * .5, height * .25), ...at(width * .36, -height * .27), ...at(-width * .27, -height * .2)])
    .fill({ color, alpha });
  g.moveTo(...highlightA).lineTo(...highlightB)
    .stroke({ color: 0xd2ccb0, alpha: alpha * .4, width: .008 });
}

// How a stretch of ground is toned. One biome paints it whole; a stretch of one biome of the world is
// painted beside its neighbours, and across a border its look gives way to the other's in slices of one
// tone each.
function groundTones(terrain: TerrainPaintGround) {
  const palette = groundArt(terrain.id), left = terrain.points[0]!.x, right = terrain.points.at(-1)!.x,
    biomes = terrain.id !== 'world' && terrain.biomes || [],
    fades = biomes.slice(1).flatMap((r, i): XY[] => alike(biomes[i]!.id, r.id) ? [] : [[r.start - WORLD_BLEND, r.start + WORLD_BLEND]])
      .filter(([a, b]) => b > left && a < right),
    fadeAt = (x: number) => { const fade = fades.length ? biomeFade(biomes, x) : null; return fade?.other && !alike(fade.here.id, fade.other!.id) ? fade : null; };
  // Ground is painted whole where one biome holds it, and in slices of one tone each where two meet.
  const slices = (start: number, end: number): XY[] => {
    const parts: XY[] = []; let x = start;
    for (const [from, to] of fades) {
      if (to <= x || from >= end) continue;
      if (from > x) { parts.push([x, from]); x = from; }
      for (const stop = Math.min(end, to); x < stop;) {
        const next = Math.min(stop, (Math.floor(x / FADE_STEP) + 1) * FADE_STEP); parts.push([x, next]); x = next;
      }
    }
    if (x < end) parts.push([x, end]);
    return parts;
  };
  // The look of the ground at x. Across a border it takes on that of the ground the neighbour brings to
  // it; the two grounds that meet there are one run of tones, whichever side the material changes on.
  const tone = (x: number, material: string): GroundTone => {
    const fade = fadeAt(x);
    if (!fade) return palette[material]!;
    const border = Math.max(fade.here.start, fade.other!.start), inward = (terrain.spacing + .01) * Math.sign(fade.here.start - fade.other.start),
      mine = terrain.materialAt(border + inward), theirs = terrain.materialAt(border - inward),
      a = groundArt(fade.here.id)[material === theirs ? mine : material]!, b = groundArt(fade.other.id)[theirs]!,
      mixed: GroundTone = { ...a, crust: lerp(a.crust, b.crust, fade.share) };
    for (const layer of ['top', 'body', 'deep', 'vein', 'rim'] as const) mixed[layer] = tint(a[layer], b[layer], fade.share);
    return mixed;
  };
  // How much of the ground at x is the biome's own: all of it, down to none at a border.
  const own = (x: number) => 1 - 2 * (fadeAt(x)?.share || 0);
  return { left, right, slices, tone, own };
}

// The first two metres under the contact outline, which every scale of the view shows: the crust, body
// and foot of each ground, the slab of a ruin and the beds of a chapada. Built once when the map changes;
// the earth under it is the strata's, and what only a near view tells apart is `drawGroundDetail`'s. It
// is drawn into `earth` as that stands: whoever owns the drawing has emptied it and stood it at its anchor.
// A near view draws it with the bumps a running gear stands on (`rough`, a RoughGround of the stretch, terrain.ts): the
// top of its crust, the shade under it and its rim are drawn along them, and every other layer from as deep as the
// deepest of them, where that crust covers its top.
export function drawGroundSurface(terrain: TerrainPaintGround, earth: Graphics, coarse = false, overview = false, rough: RoughGround | null = null) {
  const { left, right, slices, tone } = groundTones(terrain);
  // Where one ground gives way to the next, every layer of either ends on one line down from the corner between
  // them, LAP along the ground for every metre of the depth it ends at: that of the shared disturbance there, which
  // both grounds reckon alike, a slab's level layers too. The end of a layer of one is the start of the other's.
  const endOf = (depth: number) => (x: number): XY => {
    const deep = groundBandDepth(terrain.seed, x, depth), at = x + LAP * deep;
    return [at, terrain.height(at) - deep];
  };
  for (const sector of terrain.sectors) {
    // Under the slab of a ruin lies the earth it was built on, as it lies about the ruin (ruins-art.ts).
    const start = Math.max(left, sector.start), end = Math.min(right, sector.end), ground = !overview && ruinFloor(terrain, sector.surface) ? ruinEarth(terrain) : sector.surface,
      solid = ground === 'concrete';
    if (start >= end) continue;
    for (const [a, b] of slices(start, end)) {
      // All buried bands use the same disturbance at a vertex; only its depth changes.
      const outline = section(terrain, a, b), points = solid || overview ? outline :
        outline.map(p => ({ x: p.x, y: p.y, wave: groundBandWave(terrain.seed, p.x) })),
        skin = rough ? rough.section(a, b) : points, edge = skin.flatMap(p => [p.x, p.y]), material = tone((a + b) / 2, ground);
      // At overview scale these two metres are below a pixel. One skin keeps the same silhouette,
      // materials and biome fades; separate crusts and slab bands add no visible shape there.
      const band = (depth: number, color: number, top = false) => earth.poly(strip(points, BUMPS_UNDER, depth, endOf(depth),
        solid ? undefined : p => groundBandDepth(terrain.seed, p.x, depth, p.wave), top || !rough ? edge : null)).fill(color);
      band(2.1, overview ? material.top : material.deep);
      if (overview) continue;
      if (solid) { band(.44, material.body); band(material.crust, material.top, true); }
      else for (const [depth, above, below] of [[1.12, material.body, material.deep], [material.crust, material.top, material.body]] satisfies [number, number, number][]) {
        // A few native colour steps soften each irregular buried boundary. At a
        // coarse scale that narrow transition is subpixel, so one outline suffices.
        const feather = coarse ? 0 : Math.min(.12, depth * .25), steps = coarse ? 1 : 5;
        for (let i = 0; i < steps; i++) {
          const share = steps === 1 ? 1 : i / (steps - 1);
          band(depth + lerp(feather, -feather, share), tint(below, above, share), depth === material.crust && i === steps - 1);
        }
      }
      if (!coarse) {
        // Along the bumps the shade under the top is laid in short pieces: a long thin one, with all their corners, takes
        // the triangulation of a polygon far longer than all of them.
        const piece = rough ? SHADE_PIECE : skin.length;
        for (let i = 0; i < skin.length - 1; i += piece)
          earth.poly(strip(skin.slice(i, i + piece + 1), .022, .068)).fill({ color: 0x263f34, alpha: ground === 'mud' ? .38 : .18 });
        for (const [i, p] of skin.entries()) i ? earth.lineTo(p.x, p.y) : earth.moveTo(p.x, p.y);
        earth.stroke({ color: material.rim, width: solid ? .018 : .014, alpha: solid ? .84 : .5 });
      }
    }
  }
  // The slab of each ruin over that earth, broken at its ends.
  if (!overview) for (const sector of terrain.sectors)
    if (ruinFloor(terrain, sector.surface) && sector.end > left && sector.start < right) drawSlab(earth, terrain, sector, left, right, groundArt(terrain.id).concrete!);
  // Horizontal bedding is clipped below the actual ramp outline. It conveys
  // tall rock masses without adding ledges or collision objects to the route.
  if (terrain.id === 'plateau') for (const f of terrain.features.filter(f => f.kind === 'plateau')) {
    const a = Math.max(left, f.start), b = Math.min(right, f.end), points = section(terrain, a, b);
    for (const [i, depth] of [4, 9, 15, 22, 30].entries()) {
      const level = terrain.height(f.peak) - depth,
        top = points.flatMap(p => [p.x, Math.min(p.y - .3, level + .12 * Math.sin(p.x * .045))]),
        bottom = [...points].reverse().flatMap(p => [p.x, Math.min(p.y - .5, level - (i % 2 ? .7 : 1.3))]);
      earth.poly([...top, ...bottom]).fill({ color: i % 2 ? 0x3f443a : 0xbea77c, alpha: i % 2 ? .16 : .25 });
    }
    if (!overview) for (let x = a + 4; x < b; x += 28) {
      const y = terrain.height(x), depth = Math.min(8, Math.max(.7, y - terrain.height(f.start)));
      earth.moveTo(x, y - .28).lineTo(x - .4, y - depth * .5).lineTo(x + .5, y - depth)
        .stroke({ color: 0x394738, alpha: .23, width: .08 });
    }
  }
}

// What a near view shows of the ground: aggregate and roots under the surface, joints, the cracks of the
// slab of a ruin, ripples and puddles on it, grass and markers. None of it is a pixel across from afar, so it is built
// when the camera first comes close to a stretch, and hidden when it draws back. `earth` and `props` are
// drawn into as they stand, emptied and anchored by whoever owns them.
export function drawGroundDetail(terrain: TerrainPaintGround, earth: Graphics, props: Graphics, options: { salt?: number; inset?: number; density?: number } = {}) {
  const scenic = TERRAIN_PROFILES[terrain.id]?.battle,
    random = new Random(scenic ? terrain.seed ^ 0x9e3779b9 ^ Math.imul(options.salt || 0, 0x85ebca6b) : 8216),
    startArt = terrain.minX + (options.inset ?? 4), endArt = terrain.maxX - (options.inset ?? 4), density = options.density ?? (endArt - startArt) / 143,
    { tone, own } = groundTones(terrain);
  // Under the slab of a ruin and past its broken ends, the earth it was built on; in the slab, its aggregate.
  const earthAt = (x: number, depth: number) => { const material = terrain.materialAt(x); return ruinFloor(terrain, material) && !inSlab(terrain, x, depth) ? ruinEarth(terrain) : material; };
  // Shallow aggregate reads at vehicle scale; buried fragments and longer
  // sediment lenses make the cutaway feel like ground rather than a flat fill.
  for (let i = 0; i < Math.min(1700, Math.round(570 * density)); i++) {
    const x = random.range(startArt, endArt), surface = terrain.materialAt(x),
      depth = random.range(.08, i % 3 ? .68 : 3.1), y = terrain.height(x) - depth, material = earthAt(x, depth), art = tone(x, material),
      length = random.range(.028, surface === 'rock' ? .29 : .18);
    if (material === 'gravel' || material === 'rock') {
      stone(earth, x, y, length, length * random.range(.28, .55), i % 2 ? art.vein : art.deep, .5, terrain);
    } else {
      earth.moveTo(x, y).lineTo(x + length, terrain.height(x + length) - depth + random.range(-.016, .016))
        .stroke({ color: i % 3 ? art.vein : 0x304a3b, alpha: .31, width: random.range(.007, .018) });
    }
  }
  for (let i = 0; i < Math.min(200, Math.round(66 * density)); i++) {
    const x = random.range(startArt, endArt), surface = terrain.materialAt(x),
      w = random.range(.4, 1.5), depth = random.range(.32, 1.8), material = earthAt(x, depth - .04), art = tone(x, material);
    if (material === 'concrete') continue;
    earth.poly([x, terrain.height(x) - depth, x + w * .46, terrain.height(x + w * .46) - depth + .035,
      x + w, terrain.height(x + w) - depth, x + w * .7, terrain.height(x + w * .7) - depth - .035,
      x + w * .2, terrain.height(x + w * .2) - depth - .025]).fill({ color: art.vein, alpha: .18 });
    // Roots reach up to the top of the earth, and never through a slab.
    if (surface === 'soil' || surface === 'mud') {
      const rootY = terrain.height(x) - .12, endY = terrain.height(x + .17) - .49;
      earth.moveTo(x, rootY).quadraticCurveTo(x + .09, rootY - .19, x + .17, endY)
        .lineTo(x + .31, endY - .09).stroke({ color: 0x3b503e, width: .017, alpha: .4 });
      earth.moveTo(x + .13, endY + .11).lineTo(x - .03, endY + .06)
        .stroke({ color: 0x3b503e, width: .009, alpha: .3 });
    }
  }
  for (const sector of terrain.sectors) {
    const start = Math.max(startArt, sector.start), end = Math.min(endArt, sector.end);
    // A slab laid as a pad has its joints; the slab of a ruin has its cracks (`drawSlabDetail`).
    if (start >= end || ruinFloor(terrain, sector.surface)) continue;
    if (sector.surface === 'concrete') {
      const span = Math.max(2, (endArt - startArt) / 340);
      for (let x = Math.ceil(start / span) * span, i = 0; x < end; x += span, i++) {
        const y = terrain.height(x);
        earth.moveTo(x, y - .018).lineTo(x - .016, y - .43).stroke({ color: 0x3d534b, width: .024, alpha: .7 });
        earth.moveTo(x + .028, y - .06).lineTo(x + .018, y - .37).stroke({ color: 0xd3ceb3, width: .008, alpha: .4 });
        if (i % 3 === 0) {
          earth.poly([x - .045, y - .021, x + .08, y - .021, x + .034, y - .087, x - .021, y - .056])
            .fill({ color: 0x657467, alpha: .65 });
          const w = random.range(.35, .65), sign = i % 2 ? 1 : -1;
          earth.moveTo(x, y - .12).lineTo(x + w * .2 * sign, y - .16).lineTo(x + w * .46 * sign, y - .15)
            .lineTo(x + w * sign, terrain.height(x + w * sign) - .22).stroke({ color: 0x41574d, width: .01, alpha: .48 });
        }
      }
    } else if (sector.surface === 'sand') {
      for (let x = start + .1; x < end; x += random.range(scenic ? 2.1 : .8, scenic ? 3.8 : 1.4)) {
        const y = terrain.height(x), w = random.range(.25, .58), sandy = own(x);
        earth.moveTo(x, y - .13).quadraticCurveTo(x + w * .5, terrain.height(x + w * .5) - .09, x + w, terrain.height(x + w) - .13)
          .stroke({ color: 0xf1d9aa, width: .015, alpha: .48 * sandy });
        earth.moveTo(x + w * .18, y - .26).quadraticCurveTo(x + w * .6, terrain.height(x + w * .6) - .22,
          x + w * 1.2, terrain.height(x + w * 1.2) - .26).stroke({ color: 0x8f875f, width: .01, alpha: .32 * sandy });
      }
    } else if (sector.surface === 'mud') {
      for (let a = start + (scenic ? 3 : (end - start) * .25); a < end - 1; a += scenic ? random.range(8, 18) : end - start) {
        if (scenic && Math.abs(terrain.surface(a).slope) > .04) continue;
        const b = Math.min(end - .5, scenic ? a + random.range(2, 5) : start + (end - start) * .70), pool = section(terrain, a, b),
          // A road laid over the mud keeps no pool on it, and moves none of the others.
          covered = terrain.roads && laidOver(terrain.roads, a, b);
        if (!covered) {
          props.poly(strip(pool, .005, .105, null, p => .105 + .035 * Math.sin(p.x * 1.4))).fill({ color: 0x2f4840, alpha: .78 });
          props.poly(strip(pool, .012, .049)).fill({ color: 0x83a49b, alpha: .73 });
          contourLine(props, terrain, a + .06, b - .08, .006, { color: 0xc7c9b0, width: .016, alpha: .66 });
        }
        for (let x = a + .1; x < b; x += random.range(.45, 1.1)) {
          const w = random.range(.09, .3);
          if (!covered) contourLine(props, terrain, x, Math.min(b, x + w), .028, { color: 0xd9d6b6, width: .01, alpha: .56 });
        }
      }
    }
  }
  for (const rock of terrain.rocks) {
    // A rock a road is laid over is under the road.
    if (terrain.roads && laidOver(terrain.roads, rock.start, rock.end)) continue;
    const outline = section(terrain, rock.start, rock.end), width = rock.end - rock.start,
      depth = Math.min(.43, .16 + width * .018), art = tone(rock.peak, terrain.materialAt(rock.peak)),
      lit = section(terrain, rock.start, rock.peak), shade = section(terrain, rock.peak, rock.end),
      x = rock.start + width * .57, w = Math.min(.37, width * .06);
    // Broad mineral faces replace repeated hatch marks. All paint remains below
    // the real contact edge, in the existing cached drawing and biome palette.
    props.poly(strip(outline, 0, depth)).fill(tint(art.body, art.top, .45));
    props.poly(strip(lit, 0, depth * .6)).fill({ color: art.vein, alpha: .46 });
    props.poly(strip(shade, depth * .18, depth)).fill({ color: art.deep, alpha: .28 });
    props.moveTo(x, terrain.height(x) - .028).lineTo(x + w * .35, terrain.height(x + w * .35) - depth * .53)
      .lineTo(x + w, terrain.height(x + w) - depth * .8).stroke({ color: art.deep, width: .009, alpha: .38 });
  }
  for (let x = Math.ceil(startArt / (scenic ? 80 : 8)) * (scenic ? 80 : 8); x <= endArt; x += scenic ? 80 : 8) {
    const y = terrain.height(x);
    props.moveTo(x, y).lineTo(x, y + .40).stroke({ color: 0x546d59, width: .036, alpha: .65 });
    props.moveTo(x - .006, y + .06).lineTo(x - .006, y + .27).stroke({ color: 0xafb394, width: .01, alpha: .58 });
    props.moveTo(x, y + .30).lineTo(x, y + .39).stroke({ color: 0xdbc89b, width: .043, alpha: .85 });
  }
  if (scenic) for (const f of terrain.features) {
    if (f.kind === 'road') {
      for (let x = Math.max(startArt, f.start + 2); x < Math.min(endArt, f.end - 2); x += 8)
        props.moveTo(x, terrain.height(x) + .01).lineTo(x + 2, terrain.height(x + 2) + .01)
          .stroke({ color: 0xc7ba91, width: .04, alpha: .4 });
    } else if (f.kind === 'ruins') {
      // What stands of a ruin is drawn among the scenery behind the ground line (ruins-art.ts): a near view adds
      // the cracks of its slab and the bars bared at its broken ends.
      drawSlabDetail(earth, terrain, f);
    }
  }
}

// Cosmetic marks keep their chronological order, including translucent overlaps.
// A new mark changes only the last small drawing; expiring marks change only the first.
// Each drawing stays at its own nearby anchor, so panning never rebuilds old geometry.
const MAX_MARKS = 600, MARKS_PER_CHUNK = 48, MARKS_REACH = 512;
// A gear that turns this much faster than the ground passes under it, in m/s, throws the ground out behind it.
const SPRAY_SLIP = .5;
export class GroundTrails {
  declare graphics: Container; declare effects: Effects; declare chunks: TrailChunk[]; declare marks: TrailMark[]; declare previous: Map<string, { x: number; time: number; dug: boolean; }>; declare time: number | null; declare contactTurn: number;
  constructor(graphics: Container, effects: Effects) { this.graphics = graphics; this.effects = effects; this.clear(); }
  clear() {
    for (const chunk of this.chunks || []) chunk.graphics?.destroy({ context: true });
    this.chunks = []; this.marks = []; this.previous = new Map(); this.time = null; this.contactTurn = 0;
  }
  update(state: Pick<DrawingScene, 'actors' | 'modules'>, terrain: Terrain, time: number, view: EffectCamera) {
    this.record(state, terrain, time);
    // Like terrain detail, marks appear from 3 px/m: their usual <= .16 m segments are subpixel below it.
    // Contacts, dust and history continue while hidden. Approaching builds only missing or changed lots.
    this.graphics.visible = view.zoom >= 3;
    if (this.graphics.visible) this.draw(view);
  }
  add(mark: TrailMark) {
    let chunk = this.chunks.at(-1)!;
    if (!chunk || chunk.marks.length === MARKS_PER_CHUNK ||
      Math.max(Math.abs(mark.a - chunk.x), Math.abs(mark.b - chunk.x), Math.abs(mark.y1 - chunk.y), Math.abs(mark.y2 - chunk.y)) > MARKS_REACH) {
      chunk = { marks: [], x: mark.a, y: mark.y1, left: mark.a, right: mark.a, bottom: mark.y1, top: mark.y1, graphics: null };
      this.chunks.push(chunk);
    }
    this.marks.push(mark); chunk.marks.push(mark); chunk.dirty = true;
    chunk.left = Math.min(chunk.left, mark.a, mark.b); chunk.right = Math.max(chunk.right, mark.a, mark.b);
    chunk.bottom = Math.min(chunk.bottom, mark.y1, mark.y2); chunk.top = Math.max(chunk.top, mark.y1, mark.y2);
  }
  // Takes the marks the running gear has left since the last time told.
  record(state: Pick<DrawingScene, 'actors' | 'modules'>, terrain: Terrain, time: number) {
    if (time === this.time) return;
    if (this.time != null && time < this.time) this.clear();
    // The time the marks are taken for: none at the first telling, and no more than a moment after a pause.
    const gap = this.time == null ? 0 : time - this.time, passed = Math.min(.1, gap);
    if (gap > 1) this.previous.clear();
    this.time = time;
    const present = new Set<string>(), vehicles = new Map<string, TrailVehicle>(), emitters = new Map<string, { vehicle: TrailVehicle; contacts: number; rolling: TrailContact[]; slipping: TrailContact[] }>();
    for (const a of state.actors) if (a.vehicle) vehicles.set(a.id, a.vehicle);
    for (const m of state.modules) {
      if (!['wheel', 'track'].includes(m.kind) || !m.groundContact || m.attached === false) continue;
      present.add(m.id);
      const x = m.groundContact.x, surface = terrain.groundAt(x), old = this.previous.get(m.id), vehicle = vehicles.get(m.actorId),
        slip = Math.abs(Number(vehicle?.slip)) > SPRAY_SLIP ? vehicle!.slip! : 0,
        loose = !['concrete', 'asphalt', 'rock'].includes(surface);
      let emitter = emitters.get(m.actorId);
      if (vehicle && !emitter) emitters.set(m.actorId, emitter = { vehicle, contacts: 0, rolling: [], slipping: [] });
      if (emitter) emitter.contacts++;
      if (!old) { this.previous.set(m.id, { x, time, dug: false }); continue; }
      const distance = Math.abs(x - old.x), elapsed = time - old.time,
        travel = Math.abs(vehicle?.vx || 0) * Math.max(0, elapsed);
      // Discontinuous contacts reset before either marks or particles are emitted.
      if (distance > Math.max(2, travel + .5) || distance >= .15 && elapsed > 1) { this.previous.set(m.id, { x, time, dug: false }); continue; }
      if (loose && emitter) {
        const contact = { x, y: terrain.height(x), surface, track: m.kind === 'track' };
        emitter.rolling.push(contact);
        if (slip && !(m.health !== undefined && m.health <= 0)) emitter.slipping.push(contact);
      }
      // A gear that slips throws loose ground out behind it for as long as it does, and digs in where it stands.
      // A wrecked one turns no more: it throws nothing, and marks the ground only where it is dragged.
      if (slip && loose && !(m.health !== undefined && m.health <= 0)) {
        if (!old.dug) {
          old.dug = true;
          this.add({ a: x - .18, b: x + .18, y1: terrain.height(x - .18) + .009, y2: terrain.height(x + .18) + .009, surface, track: m.kind === 'track' });
        }
      }
      if (distance < .15 || elapsed <= 0) continue;
      this.previous.set(m.id, { x, time, dug: false });
      if (loose) {
        const count = Math.min(8, Math.ceil(distance / .16));
        for (let k = 0; k < count; k++) {
          const a = old.x + (x - old.x) * k / count, b = old.x + (x - old.x) * (k + 1) / count;
          this.add({ a, b, y1: terrain.height(a) + .009, y2: terrain.height(b) + .009,
            surface: terrain.groundAt((a + b) / 2), track: m.kind === 'track' });
        }
      }
    }
    // One timed emitter per vehicle shares its budget across its real contacts.
    // Cycling those contacts shows dust at every axle without multiplying its rate.
    for (const { vehicle, contacts, rolling, slipping } of emitters.values()) {
      if (passed <= 0) continue;
      if (rolling.length && vehicle.vx !== undefined && Math.abs(vehicle.vx) > .75) {
        const contact = rolling[this.contactTurn % rolling.length]!;
        this.effects.surfaceTrail({ ...contact, speed: Math.abs(vehicle.vx), direction: Math.sign(vehicle.vx),
          seconds: passed * rolling.length / contacts });
      }
      if (slipping.length) {
        const contact = slipping[this.contactTurn % slipping.length]!;
        this.effects.surfaceSpray({ ...contact, slip: vehicle.slip!, seconds: passed * slipping.length / contacts });
      }
    }
    this.contactTurn++;
    let expired = Math.max(0, this.marks.length - MAX_MARKS);
    if (expired) this.marks.splice(0, expired);
    while (expired) {
      const chunk = this.chunks[0]!, count = Math.min(expired, chunk.marks.length);
      if (count === chunk.marks.length) { chunk.graphics?.destroy({ context: true }); this.chunks.shift(); }
      else { chunk.marks.splice(0, count); chunk.dirty = true; }
      expired -= count;
    }
    for (const id of this.previous.keys()) if (!present.has(id)) this.previous.delete(id);
  }
  draw(view: EffectCamera) {
    const halfWidth = view.width / view.zoom / 2 + .08, halfHeight = view.height / view.zoom / 2 + .08;
    let index = 0;
    for (const chunk of this.chunks) {
      // Bounds stay conservative when the head expires; they cover at most this small lot.
      const visible = chunk.left <= view.x + halfWidth && chunk.right >= view.x - halfWidth &&
        chunk.bottom <= view.y + halfHeight && chunk.top >= view.y - halfHeight;
      if (visible && !chunk.graphics) chunk.graphics = this.graphics.addChildAt(new Graphics(), index);
      if (chunk.graphics) {
        index++; chunk.graphics.visible = visible;
        if (visible && chunk.dirty) this.drawChunk(chunk);
      }
    }
  }
  drawChunk(chunk: TrailChunk) {
    const g = anchorGraphics(chunk.graphics!, chunk.x, chunk.y);
    for (const mark of chunk.marks) {
      g.moveTo(mark.a, mark.y1).lineTo(mark.b, mark.y2).stroke({ color: mark.surface === 'sand' ? 0x917b4f : 0x3b412f,
        width: mark.track ? .032 : .022, alpha: mark.surface === 'mud' ? .6 : .32 });
      if (mark.track) g.moveTo(mark.a, mark.y1).lineTo(mark.a + .045, mark.y1 - .025)
        .stroke({ color: 0x3b412f, width: .013, alpha: .32 });
    }
    chunk.dirty = false;
  }
}
