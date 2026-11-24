import { Random, clamp, smoothstep, TAU } from './math.ts';

export type EffectKind = 'smoke' | 'dense-smoke' | 'fire' | 'flame' | 'shockwave' | 'muzzle' | 'flash' | 'dust' | 'plume' | 'jetcore';
type RGB = readonly [number, number, number];
type HotPalette = readonly [RGB, RGB, RGB, RGB, RGB, RGB];

// Visible radius inside the cached pressure tile; shared with the presentation
// trajectory so optical effects can follow the same front without re-rastering.
export const SHOCKWAVE_RING_RADIUS = .80;
export const FLAME_FRAMES = 64;
export const FLAME_VARIANTS = 1;
// The small visible foot surrounds this anchor; the sheet opens above it.
export const FLAME_ROOT = .16, FLAME_FOOT_RADIUS = .11, FLAME_FOOT_HEIGHT = .012;
const FIRE_COLORS: HotPalette = [[188, 45, 7], [247, 87, 10], [255, 157, 24], [255, 215, 76], [255, 245, 167], [255, 255, 239]];
const FLAME_COLORS: HotPalette = [[160, 32, 4], [232, 64, 6], [255, 115, 10], [255, 184, 30], [255, 237, 115], [255, 255, 230]];
const MUZZLE_COLORS: HotPalette = [[206, 66, 10], [244, 112, 18], [255, 162, 40], [255, 210, 92], [255, 240, 176], [255, 255, 246]];
// The jet leaves the bore at the tile's left; a particle anchors it there.
export const MUZZLE_JET_ROOT = .07;
const JET_PEAK = .379 ** .55 * .621 ** .9;
// The jet of a thruster leaves its nozzle at the tile's left too (`JET_ROOT`), its axis along the middle of the tile and
// as wide there as its nozzle: the plume a share `PLUME_RADIUS` of the tile's half-height either side of the axis, the
// core `CORE_RADIUS` (effects.ts `ThrusterJets` sizes them so).
export const JET_ROOT = .04, PLUME_RADIUS = .36, CORE_RADIUS = .6;
const PLUME_COLORS: HotPalette = [[105, 112, 133], [130, 144, 168], [157, 175, 199], [186, 201, 221], [215, 225, 239], [245, 247, 255]];

function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x + seed, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967295;
}
function noise(x: number, y: number, seed: number, period = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smoothstep(x - ix), fy = smoothstep(y - iy),
    y0 = period ? ((iy % period) + period) % period : iy, y1 = period ? (y0 + 1) % period : iy + 1,
    a = hash(ix, y0, seed), b = hash(ix + 1, y0, seed), c = hash(ix, y1, seed), d = hash(ix + 1, y1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function turbulence(x: number, y: number, seed: number) {
  return noise(x * 5.2, y * 5.2, seed) * .58 + noise(x * 12.7, y * 12.7, seed + 73) * .29 + noise(x * 29, y * 29, seed + 151) * .13;
}
function hotColor(data: Uint8ClampedArray, index: number, heat: number, palette: HotPalette = FIRE_COLORS) {
  const t = clamp(heat, 0, 1) * 5, level = Math.min(4, Math.floor(t)), blend = t - level,
    a = palette[level]!, b = palette[level + 1]!;
  for (let channel = 0; channel < 3; channel++) data[index + channel] = a[channel]! + (b[channel]! - a[channel]!) * blend;
}

// Startup-only RGBA painters. The runtime batches their 128 px frames in one
// texture source; no noise field, filter or canvas is evaluated during motion.
// A tile is the same for the same kind, variant and size: a renderer made again (a lost context
// restored, another view) takes it painted. Each caller gets its own copy.
const painted = new Map<string, Uint8ClampedArray>();
export function effectTilePixels(kind: EffectKind, variant = 0, size = 128) {
  const key = `${kind}:${variant}:${size}`;
  let data = painted.get(key);
  if (!data) painted.set(key, data = paintTile(kind, variant, size));
  return data.slice();
}
function paintTile(kind: EffectKind, variant: number, size: number) {
  if (!['smoke', 'dense-smoke', 'fire', 'flame', 'shockwave', 'muzzle', 'flash', 'dust', 'plume', 'jetcore'].includes(kind)) throw new Error('Unknown effect artwork: ' + kind);
  const data = new Uint8ClampedArray(size * size * 4), seed = 91 + variant * 1301,
    random = new Random(seed), phase = random.range(0, TAU), phase2 = random.range(0, TAU),
    smokeWidth = random.range(.58, .90), smokeHeight = random.range(.58, .84),
    billows = Array.from({ length: 3 }, (_, i) => {
      const a=phase+i*TAU/3+random.range(-.3,.3),reach=random.range(.23,.38);
      return {x:Math.cos(a)*reach,y:Math.sin(a)*reach,rx:random.range(.31,.44),ry:random.range(.27,.40)};
    }),
    // A burst has a few long spikes among shorter ones, never an even star.
    spikes = Array.from({ length: 11 }, (_, i) => ({ angle: phase + i * TAU / 11 + random.range(-.2, .2),
      length: i % 3 ? random.range(.36, .60) : random.range(.80, .95), width: i % 3 ? random.range(.030, .045) : random.range(.045, .060) })),
    // The jet is one long tongue with a shorter one diverging to each side.
    lobes = [{ slope: 0, reach: 1, width: .40 }, ...[1, -1].map(side => ({ slope: side * random.range(.10, .22),
      reach: random.range(.52, .76), width: random.range(.20, .27) }))],
    flameFamily = Math.floor(variant / FLAME_FRAMES) % FLAME_VARIANTS,
    flamePhase = (variant % FLAME_FRAMES) * TAU / FLAME_FRAMES,
    flameSeed = 48207 + flameFamily * 877,
    tongues = [-1,-.52,.03,.49,.95].map((side, i) => ({ side,
      tip: .45 + .45 * (.5 + .5 * Math.sin(flamePhase + i * 1.7 + flameFamily * 2.7)),
      width: .08 + .075 * (.5 + .5 * Math.cos(flamePhase + i * 2.3 + flameFamily)) }));
  for (let y = 2; y < size - 2; y++) for (let x = 2; x < size - 2; x++) {
    const px = (x + .5) / size * 2 - 1, py = (y + .5) / size * 2 - 1,
      fy = (y + .5) / size, index = (y * size + x) * 4,
      edgeFade = smoothstep((.98 - Math.max(Math.abs(px), Math.abs(py))) * 16);
    if (kind === 'dust') {
      // A chipped clod with flat faces, fine grit and a narrow soft edge. Runtime tint supplies
      // the soil, sand or mud; its cached silhouette replaces the old plain quadrilateral.
      const wx = px + py * .16, wy = py * 1.05,
        edge = Math.max(Math.abs(wx), Math.abs(wy), Math.abs(wx + wy) * .68, Math.abs(wx - wy) * .76),
        grit = noise(px * 24, py * 24, seed), chip = noise(px * 12, py * 12, seed + 17),
        face = wx + wy * .35 > .08 ? -.17 : 0,
        shade = clamp(.84 - wy * .16 + face + (grit - .5) * .18, .48, .98) * 255;
      data[index] = data[index + 1] = data[index + 2] = shade;
      data[index + 3] = smoothstep((.56 + (chip - .5) * .09 - edge) * size / 2) * 255;
      continue;
    }
    if (kind === 'shockwave') {
      const angle = Math.atan2(py, px),
        ripple = Math.sin(angle * 3 + phase) * .009 + Math.sin(angle * 7 + phase2) * .005 + Math.sin(angle * 11 + phase) * .0015,
        feather = .0085 + (.5 + .5 * Math.sin(angle * 5 + phase2)) * .0012,
        distance = (Math.hypot(px, py) - SHOCKWAVE_RING_RADIUS - ripple) / feather,
        density = .76 + .24 * (.5 + .5 * Math.sin(angle * 4 + phase));
      data[index] = 248; data[index + 1] = 248; data[index + 2] = 235;
      // A subpixel-alpha edge stays restrained when a large blast magnifies the
      // 128 px tile. Corrugation and angular density avoid a perfect neon circle.
      data[index + 3] = Math.exp(-distance * distance * .5) * density * 120 * edgeFade;
      continue;
    }
    if (kind === 'flash') {
      // White, to be tinted and added to the scene: a small saturated core, a
      // soft halo, and tapering spikes that give the burst a direction.
      const radius = Math.hypot(px, py), angle = Math.atan2(py, px);
      let rays = 0;
      for (const spike of spikes) {
        const turn = angle - spike.angle, along = radius * Math.cos(turn);
        if (along <= 0 || along >= spike.length) continue;
        const reach = 1 - along / spike.length, across = radius * Math.sin(turn) / (spike.width * reach + .004);
        rays = Math.max(rays, Math.exp(-across * across) * reach ** .8);
      }
      data[index] = data[index + 1] = data[index + 2] = 255;
      data[index + 3] = clamp(Math.exp(-((radius / .17) ** 2)) + Math.exp(-((radius / .46) ** 2)) * .34 + rays * .8, 0, 1) * edgeFade * 255;
      continue;
    }
    if (kind === 'plume' || kind === 'jetcore') {
      const along = (px + 1 - JET_ROOT * 2) / (1.94 - JET_ROOT * 2);
      if (along <= 0 || along >= 1) continue;
      if (kind === 'plume') {
        // A non-afterburning lift jet: mostly transparent mixing gas, a short
        // pale root, then a diffuse wake. Heat refraction supplies most of its
        // motion; this tile never becomes an orange rocket flame.
        const flow = turbulence(px * .7 + phase, py * 1.6, seed + 977), off = Math.abs(py + (flow - .5) * .12 * along),
          tongue = PLUME_RADIUS * (1 - along) ** 1.5 + (flow - .5) * .06 * along,
          haze = PLUME_RADIUS + (.86 - PLUME_RADIUS) * along ** .8 + (flow - .5) * .2 * along,
          hot = smoothstep((1 - off / Math.max(.02, tongue)) * 2.2), warm = smoothstep((1 - off / haze) * 1.6);
        hotColor(data, index, .2 + hot * .6 * Math.exp(-along * 4) + (flow - .5) * .08, PLUME_COLORS);
        data[index + 3] = (hot * .55 * Math.exp(-along * 5) + warm * .3) * (1 - along) ** .9 * smoothstep(along * 24) *
          (.7 + .3 * flow) * edgeFade * 255;
      } else {
        // A soft, short luminous root. No regular shock diamonds: this engine
        // has a fixed convergent nozzle and no afterburner.
        const half = CORE_RADIUS * (1 - along) ** 1.1 + .01,
          across = Math.abs(py) / half, light = Math.max(0, 1 - across);
        data[index] = 190 + 65 * light; data[index + 1] = 212 + 43 * light; data[index + 2] = 255;
        data[index + 3] = smoothstep(light * 2) * smoothstep(along * 30) * (1 - along) ** .8 * edgeFade * 220;
      }
      continue;
    }
    const n = kind === 'flame' ? 0 : turbulence(px, py, seed);
    if (kind === 'muzzle') {
      // Burning propellant leaves the bore as one tongue: white where it is
      // born, widening at once, then cooling into a ragged, forked orange tip.
      const along = (px + 1 - MUZZLE_JET_ROOT * 2) / 1.74;
      if (along <= 0 || along >= 1) continue;
      const flow = turbulence(px * .8 + phase, py * 1.5, seed + 421),
        grain = noise(px*24,py*21,seed+619), bend = (flow - .5) * .10 * along;
      let body = 0, core = -.5;
      for (const lobe of lobes) {
        const t = along / lobe.reach;
        if (t >= 1) continue;
        const half = lobe.width * t ** .55 * (1 - t) ** .9 / JET_PEAK * (1 + (flow - .5) * (.25 + t * .7)),
          across = Math.abs(py - lobe.slope * along * 1.74 + bend) / Math.max(.004, half);
        body = Math.max(body, smoothstep((1 - across + (grain-.5)*.35*along) * 3.6)); core = Math.max(core, 1 - across);
      }
      hotColor(data, index, .34 + core * .62 - along * .55 + (flow - .5) * .28 + (grain-.5)*.16*along + Math.exp(-((along / .16) ** 2)) * .3, MUZZLE_COLORS);
      data[index + 3] = body * smoothstep(along * 16) * (.86 + n * .14) * edgeFade * 255;
      continue;
    }
    if (kind === 'smoke' || kind === 'dense-smoke') {
      // Advected folds form one irregular veil instead of a cluster of shaded
      // spheres. Density channels and ragged wisps leave air between the rolls.
      const curl = noise(px * 2.4 + 11, py * 2.7, seed + 317),
        wx = px + Math.sin(py * 4.1 + phase) * .13 + (curl - .5) * .29,
        wy = py + Math.sin(px * 3.4 + phase2) * .11 + (n - .5) * .19,
        radius = Math.hypot(wx / smokeWidth, wy / smokeHeight),
        roll = turbulence(wx * .65 + .8, wy * .78, seed + 613),
        folds = noise(wx * 6.1 + roll, wy * 5.4, seed + 947),
        rim = Math.sin(Math.atan2(wy, wx) * 3 + phase) * .055,
        body = smoothstep((1 - radius + (roll - .5) * .34 + rim) * 3.0),
        wisps = smoothstep((.91 - Math.hypot((px + .18 * Math.sin(py * 4 + phase)) / .86, py / .73) + (n - .5) * .18) * 2.7),
        gaps = smoothstep((.39 - roll) * 5.2),
        density = Math.max(body * (.36 + roll * .48 + folds * .12), wisps * .26) * (1 - gaps * .42),
        shade = clamp(.58 + roll * .34 + folds * .13 - py * .055, .50, .97), gray = 255 * shade;
      data[index] = data[index + 1] = data[index + 2] = gray;
      // Denser folds occupy the existing quad; the transparent perimeter still
      // breaks up overlaps. This work runs once while painting the atlas.
      // A connected, shaded core makes combustion clouds substantial within
      // the same quad. Fine road dust and propellant keep the lighter frames.
      const core = kind === 'dense-smoke' ? smoothstep((.85 - radius + (roll - .5) * .23 + rim) * 4.3) * (.84 + roll * .12) : 0;
      data[index + 3] = Math.max(density ** .78 * 235, core * 255) * edgeFade;
    } else if (kind === 'fire') {
      // Unequal billows overlap through torn edges. Hot patches and soot gaps
      // break up the blast at several scales, within the existing four tiles.
      const curl = noise(px * 3.1, py * 3.1 + 9, seed + 271),
        wx = px + Math.sin(py * 4.2 + phase) * .12 + (curl - .5) * .18,
        wy = py + (n - .5) * .15,
        radius = Math.hypot(wx / .72, wy / .59),
        roll = turbulence(wx * .72, wy * .82, seed + 811),
        thermal = noise(wx*2.7,wy*2.7,seed+1213),
        grain = noise(wx*14,wy*14,seed+953),
        core = smoothstep((1-radius+(roll-.5)*.38+(grain-.5)*.12)*5.2);
      let empty = 1-core*.94, hot = 0;
      for(const lobe of billows){
        const distance=Math.hypot((wx-lobe.x)/lobe.rx,(wy-lobe.y)/lobe.ry),
          body=smoothstep((1-distance+(roll-.5)*.32+(grain-.5)*.12)*5);
        empty*=1-body*.94;
        hot=Math.max(hot,Math.exp(-distance*distance*3));
      }
      const heat = .30+thermal*.25+hot*.52+(grain-.5)*.02-Math.min(1,radius)*.04,
        gaps = smoothstep((.30-thermal)*5);
      hotColor(data, index, heat);
      data[index+3]=(1-empty)*(.84+roll*.14)*(1-gaps*.65)*edgeFade*255;
    } else {
      // The fuel bed stays fixed. Periodic noise travels upward through broad
      // sheets, with independent tips rather than thin, looping ribbons. All
      // advection is painted here once; motion only selects a cached frame.
      const stage = clamp((fy - .14) / .78, 0, 1), travel = stage - flamePhase / TAU,
        salt = flameSeed,
        flow = noise(px * 3.2, travel * 4, salt, 4) * .60 + noise(px * 7.1, travel * 8, salt + 73, 8) * .28 +
          noise(px * 14.3, travel * 16, salt + 151, 16) * .12,
        grain = noise((px+(flow-.5)*.12)*15+stage*4,stage*20-flamePhase/TAU*4,salt+313,4),
        grit = noise(px*25-stage*5,stage*36-flamePhase/TAU*8,salt+517,8),
        centre = (Math.sin(stage * 7 - flamePhase + flameFamily) * .17 + Math.sin(stage * 16 - flamePhase * 2) * .06) * stage ** 1.3,
        width = .40 * Math.max(.01, 1 - stage) ** .62,
        across = Math.abs(px - centre + (flow - .5) * .13) / width,
        // A soft, curved opening replaces the straight-sided V. The small
        // contact stays inside its support, then dissolves into the folds.
        opening = smoothstep((fy-FLAME_ROOT)/.10),
        footWidth = (.012+.72*opening)*(1+(flow-.5)*.24*opening),
        window = smoothstep((fy-.145)/.035)*smoothstep((footWidth-Math.abs(px))/.035)*smoothstep((.94-fy)/.07),
        body = smoothstep((1-across+(flow-.5)*.8+(grain-.5)*.24)*3.4)*smoothstep((.67-stage)*6)*window;
      let empty = 1 - body * .98;
      for (const tongue of tongues) {
        const progress = stage / tongue.tip;
        if (progress <= 0 || progress >= 1) continue;
        const bend = centre + tongue.side * (.14 + stage * .16) + (flow - .5) * .24 * progress,
          reach = tongue.width * (1 - progress) ** .55,
          distance = Math.abs(px - bend) / reach,
          density = smoothstep((1-distance+(flow-.5)*1.1+(grain-.5)*.35+(grit-.5)*.08)*3.4)*smoothstep((1-progress)*8)*window;
        empty *= 1 - density * .96;
      }
      const notch = smoothstep((.43-grain)*6)*smoothstep((.51-flow)*6)*smoothstep((stage-.10)*6),
        root = Math.exp(-(((px + .06 * Math.sin(flamePhase)) / .16) ** 2 + ((fy - .24) / .075) ** 2) * 1.5),
        fold = Math.exp(-(((flow-.60)/.12)**2))*(.65+.35*grain),
        heat = (.23+(1-stage)*.22+flow*.24+fold*.34+root*.26-Math.min(1,across)*.12)*
          (.65+.35*smoothstep((fy-FLAME_ROOT)/.14));
      hotColor(data, index, heat, FLAME_COLORS);
      data[index+3]=(1-empty)*(.72+flow*.28)*(1-notch*.45)*edgeFade*255;
    }
  }
  return data;
}
