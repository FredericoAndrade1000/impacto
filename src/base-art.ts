// The base of a faction on the shared field, drawn as a forward operating base seen square on from the side: at each
// end a corner of the perimeter, earth-filled wire baskets with concertina over them and a watchtower on a footing of
// baskets; inside them the two yards where haulers unload (squad.ts), the refinery at one and the shed its ore waits in at
// the other; a maintenance hall on a levelled footing with the flag over it, the fuel bladders in their bund, the shelter
// of the radio and its stayed mast, an earth-covered magazine, the tent and the office of the base with its generator,
// and a hardstand under camouflage nets lit by two masts. It is paint: nothing here is met by a vehicle, a round or a
// sensor. Every piece is footed on the ground under it and drawn behind the ground line, as the trees are, so a slope
// hides what it would bury; only the band, the hardstand and the aprons of the yards lie on the ground itself.
// Everything is a side elevation, lit from above as the machine pieces are (machine-art.ts): a face pale along its top
// and shaded at its foot, a cylinder lying along the view a band shaded for its roundness, one standing shaded across,
// and a circle only where an axis points at the viewer — a wheel, a reel, a fan. The tones are those of weathered works,
// quieter than a vehicle: the flag is the faction's own (flag.ts), and its mast, the markers, the band and the hood of
// the door of the hall carry the colour of the field.
// The watch the base keeps (server/base-watch.ts) stands in it as a radar on the mast of a cabin, beyond the radio mast,
// and a row of microphones on stakes beyond the hardstand: the radar and the microphones of a vehicle (machine-art.ts),
// drawn as a vehicle's are (render.ts), the radar at the size of a base's. The aerial of a radar turns this fast (rad/s),
// a turn in three seconds, as a surveillance radar turns.
import { FillGradient } from 'pixi.js';
import type { Graphics, Texture, FillInput } from 'pixi.js';
import type { BaseMaterials, BaseMaterialKind } from './base-materials.ts';
import type { FlagChoice } from './flag.ts';
import type { XY } from './canvas-art.ts';
export interface BaseFootprint { x: number; facing?: number; radius: number }
export interface BaseGround { height(x: number): number }
export interface BaseWatchPulse { by: string; age: number; side: number }
type Segment = readonly [number, number, number, number];
type BaseKit = ReturnType<typeof kit>;
type ShelterPlan = ReturnType<typeof shelterPlan>;
import { drawFlag, flagTall } from './flag.ts';
import { radarAerial } from './machine-art.ts';
import { DEPOT_INSET } from './squad.ts';

const RADAR_AT = 46.5, RADAR_TALL = 3.5, EARS_AT = ([-49, -47.6, -46.2] as const), EAR_TALL = 1.5;
export const AERIAL_TURN = 2.1, WATCH_RADAR = Object.freeze({ width: 2.5, height: 2.1 });
// Where the watch stands: the foot of its radar's mast and the top of it, where the turntable stands, and of each
// microphone the foot of its stake and the head of it, where the microphones stand.
export function watchPosts(base: Pick<BaseFootprint, 'x' | 'facing'>, ground: BaseGround) {
  const side = base.facing || 1, at = (u: number) => base.x + u * side,
    foot = (a: number, b: number) => { let y = Infinity; for (let u = a; u <= b; u += .5) y = Math.min(y, ground.height(at(u))); return y - .2; },
    post = (u: number, half: number, tall: number) => { const y = foot(u - half, u + half); return { x: at(u), foot: y, y: y + tall }; };
  return { radar: post(RADAR_AT, 1.5, RADAR_TALL), ears: EARS_AT.map(u => post(u, .5, EAR_TALL)) };
}

// Where each work stands, in metres from the middle of the base towards the side it faces; those at the ends are
// counted from the end. The yards are where a hauler stops to unload: as far in from each end as squad.ts has it.
export const WORKS = Object.freeze(({ tent: ([-66.4, -58]), office: ([-57, -50.94]), generator: ([-45.4, -41.5]), nets: ([-38.6, -14.4]),
  hall: ([-9.5, 14]), fuel: ([15.5, 27.5]), radio: ([28.9, 34.96]), mast: 36, magazine: ([50, 60.5]), refinery: ([61.4, 73]), hopper: ([3.6, 2]), wall: ([16, 1]), tower: ([9.6, 4]) }) satisfies Record<string, number | [number, number]>);
export const yardAt = (base: Pick<BaseFootprint, 'radius'>) => base.radius - DEPOT_INSET;

// The tones of the works: steel, the liner of the baskets and the earth over them, sandbags, canvas, the membrane of the
// hall, containers, concrete, rubber, timber, the nets, and the dark of an opening.
const STEEL = 0x77806f, LINER = 0x9f977b, EARTH = 0x857b62, BAGS = 0x958e70, CANVAS = 0x7f8468, MEMBRANE = 0x828b77, ROOF = 0x6d7768,
  OLIVE = 0x6b7660, SAND = 0x8f8a6f, CLAD = 0x7c8375, CONCRETE = 0xa2a191, FOOTING = 0x989d8c, RUBBER = 0x50564c, TIMBER = 0x8f7d60,
  GRASS = 0x7b875f, NET = 0x6f7356, NET_DARK = 0x4f5442, NET_LIGHT = 0x8c8565, OPENING = 0x323d36, GLASS = 0x56666a, LINE = 0x4f5a4f, DARK = 0x24332c, OUTLINE = 0x1b2721,
  GLINT = 0xd6ddbe, SHADED = 0x737a6f, LAMP = 0xd9d3a8, WIRE = 0x9ca192, WARNING = 0xa98549, BEACON = 0x9c5a4c;
// A tone towards the pale of a lit edge, or the black of a recess: `t` from -1 to 1, as machine-art.ts has it.
function shade(tone: number, t: number) {
  const to = t > 0 ? ([232, 236, 216] as const) : ([12, 20, 16] as const), a = Math.abs(t);
  return ([16, 8, 0] as const).reduce<number>((made, shift, i) => { const c = tone >> shift & 255; return made | Math.round(c + (to[i]! - c) * a) << shift; }, 0);
}
// The shading of a face across its height from its foot (0) to its top (1); of a cylinder lying along the view, the
// band of light it takes high on its round; of one standing, across it, lit from the side the sun is on.
const LIT: XY[] = [([0, -.34] as const), ([.35, -.06] as const), ([.8, .04] as const), ([.94, .12] as const), ([1, .26] as const)], ROUND: XY[] = [([0, -.52] as const), ([.28, -.2] as const), ([.62, .06] as const), ([.8, .28] as const), ([.92, .1] as const), ([1, -.1] as const)],
  UPRIGHT: XY[] = [([0, -.36] as const), ([.4, -.06] as const), ([.72, .18] as const), ([.86, .08] as const), ([1, -.24] as const)];
// Each gradient is made once and shared by every base: it is laid over the bounds of whatever it fills.
const GRADIENTS = new Map<string, FillGradient>();
function graded(kind: string, tone: number, stops: readonly XY[], across = false) {
  const key = kind + tone;
  let made = GRADIENTS.get(key);
  if (!made) GRADIENTS.set(key, made = new FillGradient({ type: 'linear', start: { x: 0, y: 0 }, end: across ? { x: 1, y: 0 } : { x: 0, y: 1 },
    textureSpace: 'local', colorStops: stops.map(([offset, t]) => ({ offset, color: shade(tone, t) })) }));
  return made;
}
export const litFace = (tone: number) => graded('lit', tone, LIT), lyingRound = (tone: number) => graded('round', tone, ROUND), standingRound = (tone: number) => graded('upright', tone, UPRIGHT, true);
// A number of a place, the same every time it is asked: what varies from basket to basket or patch to patch.
const jitter = (n: number) => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

// Below this many metres to the pixel a view tells the faces of the works apart, with their edges, seams and openings;
// below the other, their bolts, meshes, wires and slats.
export const SEEN_PIXEL = .2, NEAR_PIXEL = .035;

// What every work is drawn with, in places of the base: `u` along it from its middle towards the side it faces, `y` up.
function kit(g: Graphics, base: BaseFootprint, ground: BaseGround, pixel: number, materials: BaseMaterials | null = null) {
  const side = base.facing || 1, at = (u: number) => base.x + u * side, high = (u: number) => ground.height(at(u)),
    seen = pixel < SEEN_PIXEL, near = pixel < NEAR_PIXEL, thin = (width: number) => Math.max(width, 1.1 * pixel),
    // The lowest ground under a piece: it stands there, and the rise beside it hides its foot.
    low = (a: number, b: number) => { let y = Infinity; for (let u = Math.min(a, b); u < Math.max(a, b); u += 1) y = Math.min(y, high(u)); return Math.min(y, high(Math.max(a, b))); },
    top = (a: number, b: number) => { let y = -Infinity; for (let u = Math.min(a, b); u < Math.max(a, b); u += 1) y = Math.max(y, high(u)); return Math.max(y, high(Math.max(a, b))); },
    rect = (a: number, b: number, y0: number, y1: number) => g.poly([at(a), y0, at(b), y0, at(b), y1, at(a), y1]),
    edge = (alpha = .5) => g.stroke({ color: OUTLINE, width: thin(.02), alpha, join: 'round' }),
    // The points of an outline without one that repeats the one before it: an edge of no length has no side to stroke along,
    // and Pixi hands NaN for it.
    distinct = (points: readonly XY[], closed: boolean) => {
      const kept = points.filter(([u, y], i) => !i || Math.abs(u - points[i - 1]![0]!) > 1e-6 || Math.abs(y - points[i - 1]![1]!) > 1e-6);
      const first = kept[0]!, last = kept.at(-1)!;
      return closed && kept.length > 1 && Math.abs(first[0]! - last[0]!) < 1e-6 && Math.abs(first[1]! - last[1]!) < 1e-6 ? kept.slice(0, -1) : kept;
    },
    round = (cx: number, cy: number, r: number, steps = 20) => Array.from({ length: steps }, (_, i): XY => ([cx + Math.cos(i * Math.PI * 2 / steps) * r, cy + Math.sin(i * Math.PI * 2 / steps) * r] as const)),
    grain = (points: number[], kind: BaseMaterialKind | null) => { if (seen && kind && materials?.[kind]!) g.poly(points).fill(materials[kind]!); };
  const k = {
    g, side, at, high, low, top, seen, near, thin, pixel,
    box: (a: number, b: number, y0: number, y1: number, color: number, alpha = 1) => rect(a, b, y0, y1).fill(alpha === 1 ? color : { color, alpha }),
    // A face lit from above, edged in dark where the view tells its edges.
    face: (a: number, b: number, y0: number, y1: number, tone: number, edged = seen, material: BaseMaterialKind = 'paint') => {
      rect(a, b, y0, y1).fill(litFace(tone)); grain([at(a), y0, at(b), y0, at(b), y1, at(a), y1], material); if (edged) edge();
    },
    shape: (points: readonly XY[], style: FillInput, edged = false, material: BaseMaterialKind | null = null) => {
      const outline = distinct(points, true).flatMap(([u, y]) => ([at(u), y] as const));
      g.poly(outline).fill(style); grain(outline, material); if (edged) edge();
    },
    // Lines of one kind, every one in a single stroke. Their ends are cut square: a round end is as many triangles as the
    // line itself again, and meshes, slats and seams have thousands of ends.
    lines: (segments: readonly Segment[], color: number, width: number, alpha = 1) => {
      if (!segments.length) return;
      for (const [ax, ay, bx, by] of segments) g.moveTo(at(ax), ay).lineTo(at(bx), by);
      g.stroke({ color, width: thin(width), alpha });
    },
    // Lines of many points each, every one in a single stroke, bent at their points without rounding.
    strands: (list: readonly (readonly XY[])[], color: number, width: number, alpha = 1) => {
      for (const points of list) distinct(points, false).forEach(([u, y], i) => i ? g.lineTo(at(u), y) : g.moveTo(at(u), y));
      g.stroke({ color, width: thin(width), alpha, join: 'bevel' });
    },
    path: (points: readonly XY[], color: number, width: number, alpha = 1) => {
      distinct(points, false).forEach(([u, y], i) => i ? g.lineTo(at(u), y) : g.moveTo(at(u), y));
      g.stroke({ color, width: thin(width), alpha, cap: 'round', join: 'round' });
    },
    // A cylinder lying along the view, as long as from `a` to `b` and as thick as from `y0` to `y1`, its ends rounded by `r`.
    lying: (a: number, b: number, y0: number, y1: number, tone: number, r = (y1 - y0) / 2, material: BaseMaterialKind = 'paint') => {
      const ends: XY[] = [], l = Math.min(a, b), h = Math.max(a, b);
      for (let i = 0; i <= 6; i++) { const t = -Math.PI / 2 + i * Math.PI / 6; ends.push(([h - r + Math.cos(t) * r, (y0 + y1) / 2 + Math.sin(t) * (y1 - y0) / 2] as const)); }
      for (let i = 0; i <= 6; i++) { const t = Math.PI / 2 + i * Math.PI / 6; ends.push(([l + r + Math.cos(t) * r, (y0 + y1) / 2 + Math.sin(t) * (y1 - y0) / 2] as const)); }
      k.shape(ends, lyingRound(tone), seen, material);
    },
    standing: (a: number, b: number, y0: number, y1: number, tone: number, edged = seen) => {
      rect(a, b, y0, y1).fill(standingRound(tone)); grain([at(a), y0, at(b), y0, at(b), y1, at(a), y1], 'paint'); if (edged) edge();
    },
    // A round whose axis points at the viewer.
    disc: (u: number, y: number, r: number, style: FillInput, edged = seen) => k.shape(round(u, y, r), style, edged),
    ring: (u: number, y: number, r: number, color: number, width: number, alpha = 1) => k.path([...round(u, y, r), round(u, y, r)[0]!], color, width, alpha),
    // Hexagon heads, only where a view is near enough to tell them.
    bolts: (list: readonly XY[], r = .018) => {
      if (!near) return;
      for (const [u, y] of list) g.poly(Array.from({ length: 6 }, (_, i) => ([at(u + Math.cos(i * Math.PI / 3) * r), y + Math.sin(i * Math.PI / 3) * r] as const)).flat()).fill(0x8a9483);
    },
    // A pale line where the light takes the top edge of a face.
    lip: (a: number, b: number, y: number, alpha = .4) => { if (seen) k.lines([([a, y, b, y] as const)], GLINT, .016, alpha); },
  };
  return k;
}

// Door seals, hinges and recessed catches share the same restrained dimensions.
// They are geometry, so the material map never supplies a false seam or shadow.
function panelDetails(k: BaseKit, a: number, b: number, y0: number, y1: number) {
  if (!k.seen) return;
  const margin = Math.min(.055, (b - a) / 9), inset = [([a + margin, y0 + margin] as const), ([b - margin, y0 + margin] as const),
    ([b - margin, y1 - margin] as const), ([a + margin, y1 - margin] as const), ([a + margin, y0 + margin] as const)];
  k.path(inset, OUTLINE, .015, .55);
  k.lip(a + margin, b - margin, y1 - margin, .45);
  for (const t of ([.22, .75] as const)) {
    const y = y0 + (y1 - y0) * t;
    k.box(a - .015, a + .045, y - .065, y + .065, shade(STEEL, -.12));
    k.lines([([a + .012, y - .055, a + .012, y + .055] as const)], GLINT, .012, .4);
  }
  const latch = b - Math.min(.18, (b - a) * .22), middle = y0 + (y1 - y0) * .48;
  k.face(latch - .035, latch + .035, middle - .055, middle + .075, shade(STEEL, -.15), false);
  k.lines([([latch - .095, middle + .035, latch + .005, middle + .035] as const)], GLINT, .02, .6);
}

// Baskets of earth side by side, each on its own ground, so a wall steps down a slope; `tiers` of them, the upper set a
// little back as they are stacked. Over the top the earth they were filled with, and concertina along the wall.
function baskets(k: BaseKit, a: number, b: number, tiers = 1, wire = false) {
  const unit = 1.06, tall = 1.37, cells = [], tops = [];
  for (let u = a; u + unit <= b + 1e-9; u += unit) cells.push(([u, k.low(u, u + unit) - .2] as const));
  for (const [u, y] of cells) {
    for (let tier = 0; tier < tiers; tier++) k.face(u, u + unit, y + tier * tall, y + (tier + 1) * tall, tier ? shade(LINER, .04) : LINER, k.seen, 'canvas');
    tops.push(([u, y + tiers * tall] as const));
  }
  if (!k.seen) return tops;
  for (const [i, [u, y]] of tops.entries()) {
    const crest = [([u + .02, y - .05] as const)];
    for (let s = 1; s < 5; s++) crest.push(([u + s * unit / 5, y + .02 + .07 * jitter(i * 5 + s + u)] as const));
    crest.push(([u + unit - .02, y - .05] as const));
    k.shape(crest, EARTH);
  }
  // The coiled joints between the cells, dark with light catching their front.
  const joints = [];
  for (const [u, y] of cells) joints.push(([u, y, u, y + tiers * tall] as const));
  joints.push(([cells.at(-1)![0]! + unit, cells.at(-1)![1]!, cells.at(-1)![0]! + unit, cells.at(-1)![1]! + tiers * tall] as const));
  k.lines(joints, OUTLINE, .045, .5); k.lines(joints.map(([ax, ay, bx, by]) => ([ax + .025, ay, bx + .025, by] as const)), GLINT, .012, .25);
  if (k.near) {
    const mesh = [];
    for (const [u, y] of cells) {
      for (let h = .27; h < tiers * tall; h += .27) mesh.push(([u, y + h, u + unit, y + h] as const));
      for (let s = .265; s < unit - .1; s += .265) mesh.push(([u + s, y, u + s, y + tiers * tall] as const));
    }
    k.lines(mesh, 0x5f6152, .008, .35);
  }
  if (wire && k.pixel < .08) {
    // Concertina: coils of wire run along the top; seen from the side each turn is a loop leaning along the run.
    const loops = [], rx = .19, ry = .4;
    for (let u = a + .2; u < b - .2; u += .26) {
      const cy = (tops.find(([v]) => u >= v && u < v + unit) ?? tops.at(-1))![1] + ry + .02;
      loops.push(Array.from({ length: 13 }, (_, s) => { const t = s / 12 * Math.PI * 2, y = Math.sin(t) * ry; return ([u + Math.cos(t) * rx - y * .11, cy + y] as const); }));
    }
    k.strands(loops, WIRE, .012, .75);
    const pickets = [];
    for (let u = a + .5; u < b; u += 3) { const at = (tops.find(([v]) => u >= v && u < v + unit) ?? tops.at(-1))!; pickets.push(([u, at[1]! - .1, u, at[1]! + .95] as const)); }
    k.lines(pickets, STEEL, .03, .8);
  }
  return tops;
}

// A wall of sandbags laid in courses, each course over the joints of the one under it.
function sandbags(k: BaseKit, a: number, b: number, y: number, courses: number) {
  const course = .15, bag = .55, tall = courses * course, crest = [([a, y] as const)];
  for (let u = a; u < b - 1e-9; u += bag / 2) crest.push(([u, y + tall - .03] as const), ([Math.min(b, u + bag / 4), y + tall + .02] as const));
  crest.push(([b, y + tall - .03] as const), ([b, y] as const));
  k.shape(crest, litFace(BAGS), k.seen, 'canvas');
  if (!k.seen) return;
  const seams = [];
  for (let c = 1; c < courses; c++) seams.push(([a, y + c * course, b, y + c * course] as const));
  if (k.near) for (let c = 0; c < courses; c++) for (let u = a + (c % 2 ? bag / 2 : bag); u < b - .05; u += bag) seams.push(([u, y + c * course + .02, u, y + (c + 1) * course - .02] as const));
  k.lines(seams, OUTLINE, .014, .3);
}

// A watchtower: two tiers of baskets, the hut on them with its slit behind sandbags, a roof of sheet over it, a net over
// the slit, and the stair up to it from the side of the base it watches over.
function watchtower(k: BaseKit, a: number, inward: number) {
  const tops = baskets(k, a + .9, a + 3.02, 2), floor = Math.max(...tops.map(([, y]) => y)), hut = ([a + .55, a + 3.4] as const), head = floor + 2.2;
  k.box(hut[0]! - .05, hut[1]! + .05, floor - .08, floor + .06, TIMBER);
  k.face(hut[0]!, hut[1]!, floor + .06, head, shade(TIMBER, .08));
  if (k.seen) {
    k.box(hut[0]! + .15, hut[1]! - .15, floor + 1.15, floor + 1.5, OPENING, .92);
    k.lines([([hut[0]!, floor + .06, hut[0]!, head] as const), ([hut[1]!, floor + .06, hut[1]!, head] as const)], OUTLINE, .05, .4);
    for (const u of ([hut[0]! + .08, hut[1]! - .08] as const)) {
      k.lines([([u, floor + .1, u, head - .1] as const)], shade(TIMBER, -.3), .08, .8);
      k.bolts([([u, floor + .3] as const), ([u, head - .2] as const)], .025);
    }
    if (k.near) k.lines([([hut[0]! + .9, floor + .1, hut[0]! + .9, floor + 1.1] as const), ([hut[0]! + 1.8, floor + .1, hut[0]! + 1.8, floor + 1.1] as const)], OUTLINE, .012, .3);
  }
  sandbags(k, hut[0]! + .05, hut[1]! - .05, floor + .72, 3);
  // The roof: sheet laid to fall away from the slit, over its rafters.
  k.shape([([hut[0]! - .35, head] as const), ([hut[1]! + .35, head + .14] as const), ([hut[1]! + .35, head + .26] as const), ([hut[0]! - .35, head + .14] as const)], litFace(ROOF), k.seen);
  if (k.near) { const ribs = []; for (let u = hut[0]! - .25; u < hut[1]! + .3; u += .2) ribs.push(([u, head + .02 + .14 * (u - hut[0]! + .35) / (hut[1]! - hut[0]! + .7), u, head + .13 + .14 * (u - hut[0]! + .35) / (hut[1]! - hut[0]! + .7)] as const)); k.lines(ribs, GLINT, .008, .25); }
  if (k.seen) {
    // The net hung over the slit, ragged at its edge.
    const net = [([hut[0]! - .2, head + .05] as const)];
    for (let s = 0; s <= 8; s++) net.push(([hut[0]! - .2 + s * (hut[1]! - hut[0]! + .4) / 8, head - .3 - .22 * jitter(s + a)] as const));
    net.push(([hut[1]! + .2, head + .05] as const));
    k.shape(net, { color: NET, alpha: .88 });
    // The stair: a stringer from the ground to the floor, its treads, and the rail over it.
    const foot = inward > 0 ? hut[1]! + 2.3 : hut[0]! - 2.3, landing = inward > 0 ? hut[1]! : hut[0]!, ground = k.high(foot) - .15, rise = floor - ground;
    k.lines([([foot, ground, landing, floor] as const), ([foot + inward * .12, ground, landing + inward * .12, floor] as const)], TIMBER, .07);
    k.lines([([foot, ground + 1, landing, floor + 1] as const), ([foot, ground, foot, ground + 1] as const), ([(foot + landing) / 2, ground + rise / 2, (foot + landing) / 2, ground + rise / 2 + 1] as const)], TIMBER, .045, .9);
    if (k.near) { const treads = []; for (let s = 1; s < 12; s++) { const t = s / 12; treads.push(([foot + (landing - foot) * t - .14, ground + rise * t, foot + (landing - foot) * t + .14, ground + rise * t] as const)); } k.lines(treads, shade(TIMBER, -.3), .035, .8); }
    // A whip aerial on the roof.
    k.lines([([hut[0]! + .3, head + .2, hut[0]! + .3, head + 1.9] as const)], STEEL, .02, .8);
  }
}

// A twenty-foot container on blocks: its corrugated side between the posts and rails of its frame, the castings at its
// corners. An office has a door, a window and the cooler of its air; the radio's shelter its port of cables and a vent;
// the magazine of a post its door under a placard and the vents at its ends.
function container(k: BaseKit, a: number, b: number, use: 'office' | 'radio' | 'magazine') {
  const floor = k.top(a, b) + .12, roof = floor + 2.59, tone = use === 'office' ? SAND : OLIVE;
  for (const u of ([a + .1, b - .45] as const)) k.box(u, u + .35, k.low(u, u + .35) - .2, floor, shade(CONCRETE, -.08));
  k.face(a, b, floor, roof, tone);
  k.box(a, b, roof - .14, roof, shade(tone, -.16)); k.box(a, b, floor, floor + .16, shade(tone, -.24));
  k.standing(a, a + .11, floor, roof, shade(tone, -.12), false); k.standing(b - .11, b, floor, roof, shade(tone, -.12), false);
  k.lip(a + .12, b - .12, roof - .03);
  if (k.seen) {
    const flutes = [], light = [];
    for (let u = a + .3; u < b - .2; u += .26) { flutes.push(([u, floor + .2, u, roof - .18] as const)); light.push(([u + .07, floor + .2, u + .07, roof - .18] as const)); }
    k.lines(flutes, OUTLINE, .028, .22); k.lines(light, GLINT, .016, .14);
    for (const u of ([a, b - .18] as const)) for (const y of ([floor, roof - .12] as const)) k.box(u, u + .18, y, y + .12, shade(tone, -.42));
    for (const u of ([a + .09, b - .09] as const)) for (const y of ([floor + .06, roof - .06] as const)) k.disc(u, y, .035, OPENING, false);
    if (use === 'office') {
      k.face(a + 1, a + 1.92, floor + .16, floor + 2.12, shade(tone, -.06)); k.box(a + 1.7, a + 1.8, floor + 1.05, floor + 1.12, DARK, .7);
      panelDetails(k, a + 1, a + 1.92, floor + .16, floor + 2.12);
      k.box(a + 3.1, a + 4.4, floor + 1.15, floor + 1.95, GLASS); k.lip(a + 3.12, a + 4.38, floor + 1.92, .3);
      k.path([([a + 3.08, floor + 1.13] as const), ([a + 4.42, floor + 1.13] as const), ([a + 4.42, floor + 1.97] as const), ([a + 3.08, floor + 1.97] as const), ([a + 3.08, floor + 1.13] as const)], shade(STEEL, .15), .035, .8);
      k.face(a + 4.75, a + 5.75, floor + 1.25, floor + 2.05, shade(STEEL, .1));
      k.disc(a + 5.25, floor + 1.65, .3, OPENING, false);
      k.bolts([([a + 4.79, floor + 1.29] as const), ([a + 5.71, floor + 1.29] as const), ([a + 4.79, floor + 2.01] as const), ([a + 5.71, floor + 2.01] as const)], .022);
      if (k.near) {
        const blades = []; for (let i = 0; i < 4; i++) { const t = i * Math.PI / 2 + .4; blades.push(([a + 5.25, floor + 1.65, a + 5.25 + Math.cos(t) * .26, floor + 1.65 + Math.sin(t) * .26] as const)); }
        k.lines(blades, STEEL, .03, .8); k.ring(a + 5.25, floor + 1.65, .3, GLINT, .01, .4);
        const bars = []; for (let u = a + 3.3; u < a + 4.4; u += .2) bars.push(([u, floor + 1.15, u, floor + 1.95] as const)); k.lines(bars, DARK, .02, .8);
      }
      // The steps to the door.
      k.box(a + .95, a + 1.97, k.low(a + .95, a + 1.97) - .2, floor - .05, CONCRETE);
    } else if (use === 'magazine') {
      // The door under the placard that warns of what is kept in it, vents high at its ends, the strap to its earth rod.
      k.face(a + 1.1, a + 2.1, floor + .2, floor + 2.2, shade(tone, -.06)); k.box(a + 1.9, a + 2, floor + 1.1, floor + 1.18, DARK, .7);
      panelDetails(k, a + 1.1, a + 2.1, floor + .2, floor + 2.2);
      k.shape([([a + 1.6, floor + 1.42] as const), ([a + 1.83, floor + 1.65] as const), ([a + 1.6, floor + 1.88] as const), ([a + 1.37, floor + 1.65] as const)], WARNING, true);
      for (const u of ([a + 3.4, b - 1.05] as const)) {
        k.face(u, u + .6, floor + 1.8, floor + 2.25, STEEL);
        if (k.near) { const louvres = []; for (let y = floor + 1.87; y < floor + 2.2; y += .07) louvres.push(([u + .05, y, u + .55, y] as const)); k.lines(louvres, OUTLINE, .012, .5); }
      }
      k.path([([b - .7, floor + .25] as const), ([b - .7, floor + .05] as const), ([b - .4, k.high(b - .4) - .1] as const)], DARK, .04, .8);
      k.box(a + 1.05, a + 2.15, k.low(a + 1.05, a + 2.15) - .2, floor - .05, CONCRETE);
    } else {
      k.face(a + 4.6, a + 5.6, floor + .2, floor + 2.2, shade(tone, -.06)); k.box(a + 5.4, a + 5.5, floor + 1.1, floor + 1.18, DARK, .7);
      panelDetails(k, a + 4.6, a + 5.6, floor + .2, floor + 2.2);
      k.face(a + .7, a + 1.4, floor + 1.7, floor + 2.2, STEEL);
      if (k.near) { const louvres = []; for (let y = floor + 1.78; y < floor + 2.15; y += .07) louvres.push(([a + .75, y, a + 1.35, y] as const)); k.lines(louvres, OUTLINE, .012, .5); }
      k.face(a + 2.2, a + 2.9, floor + .9, floor + 1.4, shade(STEEL, -.1));
      k.path([([a + 2.55, floor + .9] as const), ([a + 2.55, floor + .4] as const), ([a + 2.9, floor + .2] as const), ([a + 3.2, k.high(a + 3.2) - .1] as const)], DARK, .05, .8);
    }
    k.bolts([([a + .055, floor + .5] as const), ([a + .055, roof - .5] as const), ([b - .055, floor + .5] as const), ([b - .055, roof - .5] as const)]);
  }
  return { floor, roof };
}

// The maintenance hall: its membrane on portal frames, the roll-up door of the vehicle bay with the colour of the field on
// its hood, a door, windows and the office built on at its end; the footing that levels the slope under it.
function hall(k: BaseKit, color: number) {
  const [a, b] = WORKS.hall, annex = 9.4, floor = k.low(a, b) + (k.top(a, b) - k.low(a, b)) * .35 + .15, eaves = floor + 4.3, crown = eaves + 2.2, roof = [];
  k.shape([([a - 1.6, floor] as const), ([b + 1.6, floor] as const), ([b + 2.6, k.low(a - 2, b + 3) - 1.2] as const), ([a - 2.6, k.low(a - 2, b + 3) - 1.2] as const)], FOOTING, false, 'concrete');
  k.box(a - 1.6, b + 1.6, floor - .22, floor, shade(FOOTING, -.2), .8);
  // The office built on: a lean-to with its window, door and the cooler of its air.
  k.face(annex, b, floor, floor + 3.1, shade(MEMBRANE, -.12), k.seen, 'rubber');
  k.shape([([annex, floor + 3.1] as const), ([b + .3, floor + 3.1] as const), ([b + .3, floor + 3.3] as const), ([annex, floor + 3.75] as const)], litFace(ROOF), k.seen);
  k.box(10.3, 11.5, floor + 1.5, floor + 2.3, GLASS); k.face(12.2, 13.2, floor, floor + 2.1, shade(MEMBRANE, -.3));
  // The end of the hall, square on: its wall and the gable under the arch in one membrane, seamed panel by panel, the
  // posts of its frame, and the arch of the end frame over it, a little wider than the wall.
  const arch = (u: number) => eaves + (crown - eaves) * Math.sin(Math.PI * (u - a + .4) / 19.8), end = [([a, floor] as const), ([annex + .1, floor] as const), ([annex + .1, arch(annex + .1)] as const)];
  for (let i = 9; i >= 1; i--) end.push(([a - .4 + 19.8 * i / 10, arch(a - .4 + 19.8 * i / 10)] as const));
  end.push(([a, arch(a)] as const));
  k.shape(end, litFace(MEMBRANE), k.seen, 'rubber');
  k.box(a, annex + .1, floor, floor + .5, shade(MEMBRANE, -.3), .8);
  const posts = [a, a + 4.75, a + 9.5, a + 14.25, annex];
  if (k.seen) {
    const seams = [], light = [];
    for (let u = a + 1.2; u < annex; u += 1.2) { seams.push(([u, floor + .5, u, arch(u) - .3] as const)); light.push(([u + .05, floor + .5, u + .05, arch(u) - .3] as const)); }
    k.lines(seams, OUTLINE, .02, .2); k.lines(light, GLINT, .012, .12);
    for (const u of posts) k.standing(u - .1, u + .1, floor, arch(u) - .2, STEEL, false);
    for (const u of posts) { k.face(u - .2, u + .2, floor, floor + .14, shade(STEEL, -.15), false); k.bolts([([u - .14, floor + .07] as const), ([u + .14, floor + .07] as const)], .022); }
    k.bolts(posts.flatMap(u => [([u - .06, floor + .08] as const), ([u + .06, floor + .08] as const)]));
  }
  for (let i = 0; i <= 20; i++) roof.push(([a - .4 + 19.8 * i / 20, arch(a - .4 + 19.8 * i / 20)] as const));
  for (let i = 20; i >= 0; i--) roof.push(([a - .4 + 19.8 * i / 20, arch(a - .4 + 19.8 * i / 20) - .3] as const));
  k.shape(roof, litFace(ROOF), k.seen);
  if (k.near) {
    const fixings = [];
    for (let u = a; u < annex; u += 1.15) fixings.push(([u, arch(u) - .13] as const));
    k.bolts(fixings, .025);
  }
  // The vehicle bay: its door rolled two thirds down over the dark of the bay, under its hood.
  const door = ([-6.4, 1.2] as const);
  k.box(door[0]!, door[1]!, floor, floor + 3.7, OPENING);
  k.face(door[0]!, door[1]!, floor + 1.25, floor + 3.7, shade(STEEL, .06));
  k.face(door[0]! - .2, door[1]! + .2, floor + 3.7, floor + 4.05, shade(STEEL, -.05)); k.box(door[0]! - .2, door[1]! + .2, floor + 3.82, floor + 3.94, color, .75);
  if (k.seen) {
    const slats = [];
    for (let y = floor + 1.25 + (k.near ? .12 : .45); y < floor + 3.7; y += k.near ? .12 : .45) slats.push(([door[0]!, y, door[1]!, y] as const));
    k.lines(slats, OUTLINE, .014, .3);
    k.lines([([door[0]!, floor, door[0]!, floor + 3.7] as const), ([door[1]!, floor, door[1]!, floor + 3.7] as const)], shade(STEEL, -.3), .08, .9);
    k.path([([door[1]! + .14, floor + 3.72] as const), ([door[1]! + .25, floor + 3.6] as const), ([door[1]! + .25, floor + .3] as const), ([door[1]! + 1, floor + .3] as const), ([door[1]! + 1, floor + .75] as const)], STEEL, .025, .7);
    k.face(door[1]! + .89, door[1]! + 1.1, floor + .68, floor + .91, shade(STEEL, -.12), false);
    // Inside the bay, in its shade: the bench along its far wall and the hook of the hoist.
    if (k.near) {
      k.box(door[0]! + .4, door[0]! + 2.6, floor, floor + .95, shade(OPENING, .14));
      k.lines([([door[0]! + 4.2, floor + 1.25, door[0]! + 4.2, floor + .75] as const)], shade(STEEL, -.35), .025, .9);
      k.box(door[0]! + 4.12, door[0]! + 4.28, floor + .62, floor + .78, shade(STEEL, -.25));
    }
    // A man door, the windows over the bench inside, and a lamp over the bay.
    k.face(3.2, 4.3, floor, floor + 2.1, shade(MEMBRANE, -.28)); k.box(3.45, 4.05, floor + 1.3, floor + 1.8, GLASS);
    panelDetails(k, 3.2, 4.3, floor, floor + 2.1); panelDetails(k, 12.2, 13.2, floor, floor + 2.1);
    k.box(5.6, 7.9, floor + 1.6, floor + 2.5, GLASS); k.lines([([6.37, floor + 1.6, 6.37, floor + 2.5] as const), ([7.13, floor + 1.6, 7.13, floor + 2.5] as const)], MEMBRANE, .05);
    k.lip(5.6, 7.9, floor + 2.48, .35);
    k.shape([([-2.9, floor + 4.25] as const), ([-2.3, floor + 4.25] as const), ([-2.4, floor + 4.1] as const), ([-2.8, floor + 4.1] as const)], LAMP);
    k.lines([([-2.6, floor + 4.25, -2.6, floor + 4.45] as const)], STEEL, .04);
    // The downpipe from the gutter at the end of the hall.
    k.lines([([a + .15, eaves, a + .15, floor + .1] as const)], shade(STEEL, -.2), .07, .9);
  }
  k.face(-1.5, .3, crown - .75, crown + .25, ROOF); k.face(-1.7, .5, crown + .25, crown + .42, shade(MEMBRANE, -.25));
  if (k.near) { const louvres = []; for (let y = crown - .6; y < crown + .2; y += .12) louvres.push(([-1.4, y, .2, y] as const)); k.lines(louvres, OUTLINE, .012, .45); }
  return { floor, eaves, crown };
}

// The fuel point: two bladders on the liner of their pit with the pump between them, and the bund of earth in front.
function fuel(k: BaseKit) {
  const [a, b] = WORKS.fuel, level = k.low(a, b) + .15;
  k.shape([([a, level] as const), ([b, level] as const), ([b, k.low(a, b) - 1] as const), ([a, k.low(a, b) - 1] as const)], shade(FOOTING, -.08));
  for (const [u0, u1] of [([15.9, 20.9] as const), ([21.75, 27.1] as const)]) {
    k.lying(u0, u1, level, level + 1.15, RUBBER, .5, 'rubber');
    if (k.seen) {
      k.lines([([u0 + 1.4, level + .05, u0 + 1.4, level + 1.12] as const), ([u1 - 1.4, level + .05, u1 - 1.4, level + 1.12] as const)], shade(RUBBER, .25), .07, .6);
      k.face(u0 + .5, u0 + .85, level + 1.12, level + 1.3, STEEL);
      k.face(u0 + .47, u0 + .88, level + 1.27, level + 1.34, shade(STEEL, .12), false);
      for (const u of ([u0 + 1.4, u1 - 1.4] as const)) { k.face(u - .055, u + .055, level + .12, level + .27, shade(STEEL, .12), false); k.box(u - .025, u + .025, level + .16, level + .23, OPENING); }
    }
  }
  // The pump: a cabinet with the reel of its hose, the hose to each bladder and the nozzle on its hook.
  k.face(20.95, 21.6, level, level + 1.55, shade(OLIVE, .05));
  panelDetails(k, 20.95, 21.6, level + .03, level + 1.51);
  k.disc(21.27, level + 1.05, .26, OPENING, false);
  if (k.seen) {
    k.ring(21.27, level + 1.05, .2, shade(RUBBER, .15), .07);
    k.disc(21.27, level + 1.05, .065, STEEL, false);
    k.path([([16.7, level + 1.27] as const), ([20.5, level + 1.27] as const), ([20.82, level + 1.45] as const), ([20.96, level + 1.45] as const)], RUBBER, .055, .95);
    k.path([([21.59, level + 1.45] as const), ([21.88, level + 1.45] as const), ([22.15, level + 1.27] as const), ([22.45, level + 1.27] as const)], RUBBER, .055, .95);
    k.path([([20.95, level + .3] as const), ([20.7, level + .25] as const), ([20.6, level + .5] as const)], RUBBER, .06, .9);
    k.path([([21.6, level + .3] as const), ([21.85, level + .25] as const), ([21.95, level + .5] as const)], RUBBER, .06, .9);
    k.lip(20.97, 21.58, level + 1.53);
  }
  // The bund, faced with the liner where it turns over its crest.
  const bund = [([a - .4, level - .2] as const)];
  for (let s = 0; s <= 12; s++) bund.push(([a - .2 + s * (b - a + .4) / 12, level + .5 + .05 * jitter(s + 3)] as const));
  bund.push(([b + .4, level - .2] as const));
  k.shape(bund, litFace(EARTH), k.seen, 'earth');
  if (k.seen) k.lines([([a - .2, level + .52, b + .2, level + .52] as const)], shade(LINER, .1), .05, .5);
}

// A pallet of jerrycans: the cross pressed in each and the three grips over it.
function jerrycans(k: BaseKit, a: number, rows: number, tiers: number) {
  const y0 = k.low(a, a + rows * .36 + .1) - .1, can = ([.345, .47] as const);
  k.box(a, a + rows * .36 + .06, y0, y0 + .14, TIMBER);
  for (let t = 0; t < tiers; t++) for (let r = 0; r < rows; r++) {
    const u = a + .03 + r * .36, y = y0 + .14 + t * (can[1]! + .04);
    k.face(u, u + can[0]!, y, y + can[1]!, OLIVE);
    if (k.near) {
      k.lines([([u + .04, y + .05, u + can[0]! - .04, y + can[1]! - .08] as const), ([u + .04, y + can[1]! - .08, u + can[0]! - .04, y + .05] as const)], shade(OLIVE, .25), .012, .5);
      k.lines([([u + .05, y + can[1]!, u + .05, y + can[1]! + .035] as const), ([u + .17, y + can[1]!, u + .17, y + can[1]! + .035] as const), ([u + .29, y + can[1]!, u + .29, y + can[1]! + .035] as const)], shade(OLIVE, -.3), .02, .9);
    }
  }
}

// The stayed radio mast: a lattice that narrows upwards, stays at three heights, and the aerials over its top.
function radioMast(k: BaseKit, u: number) {
  const y = k.low(u - 1, u + 1) - .2, tall = 17, leg = (s: number) => .75 - .63 * s;
  const stays = [];
  for (const [reach, share] of [([9, .9] as const), ([6.5, .6] as const), ([4, .3] as const)]) for (const way of ([-1, 1] as const)) stays.push(([u + way * leg(share) * .5, y + tall * share, u + way * reach, k.high(u + way * reach) - .05] as const));
  k.lines(stays, WIRE, .016, .45);
  k.lines([([u - .75, y, u - .12, y + tall] as const), ([u + .75, y, u + .12, y + tall] as const)], STEEL, .1, .95);
  const bracing = [];
  for (let i = 0; i < 12; i++) {
    const s0 = i / 12, s1 = (i + 1) / 12, way = i % 2 ? 1 : -1;
    bracing.push(([u - way * leg(s0), y + tall * s0, u + way * leg(s1), y + tall * s1] as const));
    if (k.near) bracing.push(([u - leg(s1), y + tall * s1, u + leg(s1), y + tall * s1] as const));
  }
  k.lines(bracing, STEEL, .045, .75);
  // The aerials: a whip, a dipole on its arm, a dish seen edge on, and the lamp that marks the top for aircraft.
  k.lines([([u, y + tall, u, y + tall + 3.2] as const)], STEEL, .05, .9);
  k.lines([([u - 1.1, y + tall - .5, u + 1.1, y + tall - .5] as const)], STEEL, .04, .9);
  k.face(u - .6, u + .6, y + tall - .5, y + tall - .15, STEEL);
  if (k.seen) {
    k.lines([([u - 1.1, y + tall - .5, u - 1.1, y + tall - 1.4] as const), ([u + 1.1, y + tall - .5, u + 1.1, y + tall - 1.4] as const)], STEEL, .025, .8);
    const dish = [], centre = y + tall * .74;
    for (let s = 0; s <= 10; s++) { const t = -1 + s / 5; dish.push(([u + .55 + .18 * (1 - t * t), centre + t * .55] as const)); }
    k.shape([...dish, ([u + .55, centre + .55] as const), ([u + .55, centre - .55] as const)], litFace(shade(STEEL, .25)), true);
    k.lines([([u + .25, centre, u + .55, centre] as const)], STEEL, .04, .9);
    k.box(u - .07, u + .07, y + tall + 3.1, y + tall + 3.3, BEACON);
    for (const way of ([-1, 1] as const)) for (const reach of ([9, 6.5, 4] as const)) k.box(u + way * reach - .25, u + way * reach + .25, k.high(u + way * reach) - .2, k.high(u + way * reach) + .12, CONCRETE);
  }
  if (k.near) k.lines([([u - .5, y + .3, u - .5, y + tall * .7] as const)], DARK, .03, .6);
}

// A towed generator: its housing with louvres at both ends, the exhaust and its cap, on the frame of its trailer with a
// wheel under a mudguard and the drawbar on its jack.
function generator(k: BaseKit) {
  const [a, b] = WORKS.generator, y = k.low(a, b) - .1, chassis = y + .62, wheel = a + 1.6;
  k.disc(wheel, y + .4, .4, RUBBER); k.disc(wheel, y + .4, .2, shade(OLIVE, -.1), false);
  k.shape([([wheel - .55, chassis] as const), ([wheel - .45, chassis + .22] as const), ([wheel + .45, chassis + .22] as const), ([wheel + .55, chassis] as const)], litFace(OLIVE));
  k.box(a + .1, b - .9, chassis, chassis + .12, shade(OLIVE, -.3));
  k.lines([([b - .9, chassis + .06, b - .05, chassis - .05] as const), ([b - .3, chassis - .02, b - .3, y + .12] as const)], shade(OLIVE, -.3), .07, .95);
  k.face(a + .2, b - 1.1, chassis + .12, chassis + 1.42, OLIVE);
  k.lip(a + .25, b - 1.15, chassis + 1.39);
  k.standing(a + .55, a + .7, chassis + 1.42, chassis + 1.95, shade(STEEL, -.1));
  k.shape([([a + .5, chassis + 1.95] as const), ([a + .78, chassis + 2.05] as const), ([a + .78, chassis + 2.1] as const), ([a + .5, chassis + 2] as const)], STEEL);
  if (k.seen) {
    const louvres = [];
    for (const u0 of ([a + .3, b - 1.6] as const)) for (let h = .25; h < 1.15; h += k.near ? .08 : .2) louvres.push(([u0, chassis + .12 + h, u0 + .38, chassis + .12 + h] as const));
    k.lines(louvres, OUTLINE, .014, .5);
    k.lines([([a + 1.15, chassis + .2, a + 1.15, chassis + 1.32] as const), ([a + 2.05, chassis + .2, a + 2.05, chassis + 1.32] as const)], OUTLINE, .012, .35);
    panelDetails(k, a + 1.16, a + 2.04, chassis + .18, chassis + 1.34);
    k.ring(wheel, y + .4, .15, shade(STEEL, .15), .02, .65);
    k.disc(wheel, y + .4, .055, shade(STEEL, -.2), false);
    k.box(a + 1.3, a + 1.7, chassis + .95, chassis + 1.15, GLINT, .3);
    // The earth cable to its rod.
    k.path([([a + .25, chassis + .2] as const), ([a - .1, y + .2] as const), ([a - .25, k.high(a - .25) - .05] as const)], DARK, .025, .7);
  }
}

// A frame tent: low walls, its roof falling to them at the shoulders, a seam at every frame, windows with their flaps
// rolled over them, and stays to their pegs at both ends; the cooler of its air at its end with the duct into it.
function tent(k: BaseKit) {
  const [a, b] = WORKS.tent, y = k.low(a, b) - .15, wall = y + 1.85, ridge = y + 3.15, outline = [([a, y] as const), ([b, y] as const), ([b, wall] as const)];
  for (let s = 0; s <= 6; s++) { const t = s / 6; outline.push(([b - .9 * Math.sin(t * Math.PI / 2), wall + (ridge - wall) * (1 - Math.cos(t * Math.PI / 2)) * .82] as const)); }
  for (let s = 6; s >= 0; s--) { const t = s / 6; outline.push(([a + .9 * Math.sin(t * Math.PI / 2), wall + (ridge - wall) * (1 - Math.cos(t * Math.PI / 2)) * .82] as const)); }
  outline.push(([a, wall] as const));
  k.shape(outline, litFace(CANVAS), k.seen, 'canvas');
  k.shape([([a + .9, ridge - .23] as const), ([b - .9, ridge - .23] as const), ([b - .9, ridge] as const), ([a + .9, ridge] as const)], litFace(shade(CANVAS, .1)));
  if (!k.seen) return;
  const seams = [];
  for (let u = a + 1.22; u < b - .5; u += 1.22) seams.push(([u, y + .05, u, ridge - .05] as const));
  k.lines(seams, OUTLINE, .016, .25);
  for (let u = a + 1.22; u < b - .5; u += 1.22) {
    k.lines([([u + .04, y + .08, u + .04, ridge - .09] as const)], shade(CANVAS, .2), .025, .5);
    k.face(u - .055, u + .055, y + .08, y + .2, shade(STEEL, -.1), false);
  }
  k.lines([([a, wall, b, wall] as const)], OUTLINE, .02, .3);
  for (const u of ([a + 1.6, b - 2.8] as const)) {
    k.box(u, u + 1.2, y + .9, y + 1.55, GLASS, .9); k.lying(u - .05, u + 1.25, y + 1.55, y + 1.72, shade(CANVAS, .08), .085, 'canvas');
    k.path([([u, y + .9] as const), ([u + 1.2, y + .9] as const), ([u + 1.2, y + 1.55] as const), ([u, y + 1.55] as const), ([u, y + .9] as const)], shade(CANVAS, -.2), .035, .8);
    for (const belt of ([u + .12, u + 1.08] as const)) k.face(belt - .025, belt + .025, y + 1.5, y + 1.73, shade(CANVAS, -.18), false, 'canvas');
  }
  for (const [peg, from] of [([a - 1.3, a] as const), ([b + 1.3, b] as const)]) k.lines([([from, wall, peg, k.high(peg) - .05] as const)], DARK, .012, .5);
  // The cooler at the end, with its duct over the wall.
  k.face(a - 1.05, a - .2, y + .1, y + 1.05, shade(OLIVE, .05));
  k.path([([a - .5, y + 1.05] as const), ([a - .5, y + 1.6] as const), ([a + .25, y + 1.6] as const)], shade(CANVAS, .2), .28, .95);
  if (k.near) { const fins = []; for (let u = a - .95; u < a - .25; u += .07) fins.push(([u, y + .2, u, y + .95] as const)); k.lines(fins, OUTLINE, .01, .45); }
}

// Camouflage nets over the hardstand: on poles with their spreaders, falling between them, ragged at their edges and
// pegged down at both ends, the shade of the bays under them; patches of two tones over the net.
function nets(k: BaseKit) {
  const [a, b] = WORKS.nets, poles = [([-34.6, 4.5] as const), ([-26.5, 5] as const), ([-18.4, 4.5] as const)], y = k.low(a, b) - .1, top: XY[] = [];
  const peak = ([u, tall]: XY) => ([u, k.low(u - .2, u + .2) - .1 + tall] as const);
  top.push(([a, k.high(a) - .1] as const));
  for (let i = 0; i < poles.length; i++) {
    const [u, h] = peak(poles[i]!); top.push(([u, h] as const));
    if (i < poles.length - 1) { const [v, g] = peak(poles[i + 1]!); for (let s = 1; s < 6; s++) { const t = s / 6; top.push(([u + (v - u) * t, h + (g - h) * t - .55 * Math.sin(t * Math.PI)] as const)); } }
  }
  top.push(([b, k.high(b) - .1] as const));
  // The bays under the net, in its shade; the net from its top to a ragged hem that pegged ends take down to the ground.
  const hem = [], over = (u: number, from: number) => from + 1.7 + .35 * jitter(u * 3.1);
  for (let s = 0; s <= 24; s++) {
    const u = b - s * (b - a) / 24, at = Math.min(1, Math.min(u - a, b - u) / 3.2);
    hem.push(([u, k.high(u) - .1 + (over(u, 0) * at) - .12 * (s % 2)] as const));
  }
  k.shape([...top, ...hem.map(([u, h]) => ([u, Math.max(k.high(u) - .1, h - 1.6)] as const))], { color: OPENING, alpha: .16 });
  // Let the backdrop show through; keep the drawn weave without an extra canvas-grain layer.
  k.shape([...top, ...hem], { fill: litFace(NET), alpha: .42 }, k.seen);
  for (const [u, tall] of poles) k.lines([([u, k.low(u - .2, u + .2) - .2, u, k.low(u - .2, u + .2) - .1 + tall] as const)], TIMBER, .07, .95);
  if (!k.seen) return;
  const height = (u: number) => { const i = top.findIndex(([v]) => v >= u), [u0, y0] = top[Math.max(0, i - 1)]!, [u1, y1] = top[Math.max(0, i)]!; return u1 > u0 ? y0 + (y1 - y0) * (u - u0) / (u1 - u0) : y1; };
  k.path(top, shade(NET, -.25), .035, .95); k.path(hem, shade(NET, -.25), .025, .85);
  if (k.near) {
    const weave = [];
    for (let u = a + 2.5; u < b - 2; u += .55) {
      const ceiling = height(u) - .12, floor = k.high(u) + 1.9;
      if (ceiling > floor) weave.push(([u, floor, u + .13, ceiling] as const));
    }
    k.lines(weave, GLINT, .008, .16);
  }
  // Patches of the garnish, long and ragged, kept within the net.
  for (let i = 0; i < 30; i++) {
    const u = poles[0]![0]! - 1 + jitter(i * 7.3) * (poles.at(-1)![0]! - poles[0]![0]! + 2), r = .4 + .55 * jitter(i * 1.7),
      ceiling = Math.min(height(u - r), height(u), height(u + r)) - .15, floor = k.high(u) - .1 + over(u, 0) + .15;
    if (ceiling - floor < .45) continue;
    const tall = Math.min(r * .5, (ceiling - floor) / 2), cy = floor + tall + (ceiling - floor - 2 * tall) * jitter(i * 3.9), blob = [];
    for (let s = 0; s < 14; s++) { const t = s / 14 * Math.PI * 2, swell = .7 + .45 * jitter(i * 5 + s); blob.push(([u + Math.cos(t) * r * swell, cy + Math.sin(t) * tall * swell] as const)); }
    k.shape(blob, { color: i % 3 ? NET_DARK : NET_LIGHT, alpha: .32 });
  }
  for (const [u, tall] of poles) { const y0 = k.low(u - .2, u + .2) - .1 + tall; k.lying(u - .35, u + .35, y0 - .06, y0 + .06, TIMBER); }
}

// The lamps of the hardstand: a pole with its foot, a crossarm and two floodlights tipped down at the ground.
function lightingMast(k: BaseKit, u: number) {
  const y = k.low(u - .5, u + .5) - .2, tall = 8.5;
  k.standing(u - .09, u + .09, y, y + tall, STEEL); k.face(u - .35, u + .35, y, y + .5, shade(STEEL, -.1));
  k.lines([([u - .9, y + tall, u + .9, y + tall] as const)], STEEL, .12, .95);
  for (const lamp of ([-.75, .75] as const)) {
    k.shape([([u + lamp - .32, y + tall - .08] as const), ([u + lamp + .32, y + tall - .08] as const), ([u + lamp + .22, y + tall - .5] as const), ([u + lamp - .22, y + tall - .5] as const)], litFace(STEEL), k.seen);
    if (k.seen) k.lines([([u + lamp - .2, y + tall - .48, u + lamp + .2, y + tall - .48] as const)], LAMP, .05, .9);
  }
  if (k.near) k.bolts([([u - .25, y + .3] as const), ([u + .25, y + .3] as const)]);
}

// The earth-covered magazine: the concrete headwall at its door end, its barrel under a mound of earth grassed over its
// crest, the vents through it, and the masts that keep lightning off it with the wire between them.
function magazine(k: BaseKit) {
  const [a, b] = WORKS.magazine, y = k.low(a, b) - .2, crest = y + 3.7, shoulder = a + 6.2, outline = [];
  // The crest of the mound, rounding over its shoulder down to the ground at its far end.
  for (let s = 0; s <= 8; s++) { const t = s / 8; outline.push(([a + .6 + t * (shoulder - a - .6), crest + .1 * Math.sin(t * Math.PI)] as const)); }
  for (let s = 1; s <= 8; s++) { const t = s / 8 * Math.PI / 2; outline.push(([shoulder + (b - shoulder) * Math.sin(t), y + (crest - y) * Math.cos(t) ** 1.4] as const)); }
  k.shape([([a + .3, y] as const), ([a + .3, crest - .2] as const), ...outline], litFace(EARTH), k.seen, 'earth');
  k.path(outline.map(([u, h]) => ([u, h - .1] as const)), GRASS, .3, .85);
  k.face(a, a + .45, y, crest + .3, CONCRETE, k.seen, 'concrete'); k.face(a - .1, a + .55, crest + .3, crest + .48, shade(CONCRETE, -.1), k.seen, 'concrete');
  if (k.seen) {
    k.shape([([a + .45, y] as const), ([a + 1.6, y] as const), ([a + .45, y + 2.2] as const)], litFace(shade(CONCRETE, -.06)), true, 'concrete');
    k.lines([([a, y + 1.55, a + .45, y + 1.55] as const)], shade(CONCRETE, -.3), .022, .6);
    for (const u of ([a + 2.4, a + 5.4] as const)) {
      k.standing(u, u + .3, crest - .1, crest + .75, STEEL);
      k.face(u - .08, u + .38, crest + .75, crest + .88, shade(STEEL, -.1));
      k.face(u - .07, u + .37, crest - .12, crest + .03, shade(CONCRETE, -.1), false, 'concrete');
      k.lip(u - .06, u + .36, crest + .85, .45);
    }
    // The masts against lightning at both ends, and the wire between them.
    const left = a - .5, right = b - .4, tall = 8;
    k.lines([([left, k.high(left) - .2, left, y + tall] as const), ([right, k.high(right) - .2, right, y + tall] as const)], STEEL, .06, .9);
    const wire = [];
    for (let s = 0; s <= 10; s++) { const t = s / 10; wire.push(([left + (right - left) * t, y + tall - 1.1 * Math.sin(t * Math.PI)] as const)); }
    k.path(wire, WIRE, .014, .6);
    // The placard on its post before the door.
    k.lines([([a - 1.2, k.high(a - 1.2) - .2, a - 1.2, y + 1.6] as const)], TIMBER, .05);
    k.shape([([a - 1.2, y + 1.3] as const), ([a - .95, y + 1.55] as const), ([a - 1.2, y + 1.8] as const), ([a - 1.45, y + 1.55] as const)], WARNING, true);
  }
}

// A conveyor and its supports share their geometry in the base and the post.
function conveyor(k: BaseKit, c0: XY, c1: XY) {
  const on = (t: number) => ([c0[0]! + (c1[0]! - c0[0]!) * t, c0[1]! + (c1[1]! - c0[1]!) * t] as const);
  if (k.seen) {
    const truss = [[...on(0), ...on(1)] as const, ([c0[0]!, c0[1]! - .45, c1[0]!, c1[1]! - .45] as const)];
    for (let s = 0; s < 10; s++) { const [u0, h0] = on(s / 10), [u1, h1] = on((s + 1) / 10); truss.push(s % 2 ? ([u0, h0, u1, h1 - .45] as const) : ([u0, h0 - .45, u1, h1] as const)); }
    k.lines(truss, STEEL, .05, .85);
    const [bu, bh] = on(.45); k.lines([([bu - .5, k.high(bu - .5) - .2, bu, bh - .45] as const), ([bu + .5, k.high(bu + .5) - .2, bu, bh - .45] as const)], STEEL, .07, .9);
  }
  k.shape([on(0), on(1), ([c1[0]!, c1[1]! + .3] as const), ([c0[0]!, c0[1]! + .3] as const)], litFace(shade(CLAD, .1)), k.seen, 'paint');
}

// The refinery: milling house, furnace stack, kiln, conveyor and receiving hopper.
function refinery(k: BaseKit, yard: number) {
  const [a, b] = WORKS.refinery, y = k.low(a, b + 4) - .2, house = ([a, a + 4.6] as const), roof = y + 7.2;
  // The stack, from the floor of the house up past its roof.
  k.standing(a + .9, a + 1.6, y, y + 15.5, shade(CLAD, -.08));
  if (k.seen) {
    for (let h = 8; h < 15.5; h += 2) {
      k.face(a + .85, a + 1.65, y + h - .045, y + h + .045, shade(STEEL, -.12), false);
      k.bolts([([a + .91, y + h] as const), ([a + 1.59, y + h] as const)], .02);
    }
  }
  k.face(a + .82, a + 1.68, y + 15.5, y + 15.75, shade(STEEL, -.3));
  // The kiln lying from the house to the hood at its other end, on two piers.
  const k0 = ([house[1]! + .2, y + 4.6] as const), k1 = ([b - .8, y + 3.6] as const), r = .75, along = (t: number, off: number) => ([k0[0]! + (k1[0]! - k0[0]!) * t, k0[1]! + (k1[1]! - k0[1]!) * t + off] as const);
  for (const t of ([.22, .78] as const)) { const [u, h] = along(t, -r); k.shape([([u - .55, y] as const), ([u + .55, y] as const), ([u + .35, h] as const), ([u - .35, h] as const)], litFace(CONCRETE), k.seen, 'concrete'); }
  k.shape(([along(0, -r), along(1, -r), along(1, r), along(0, r)] as const), lyingRound(shade(STEEL, -.12)), k.seen, 'paint');
  if (k.seen) for (const t of ([.22, .5, .78] as const)) { const [u0, y0] = along(t, -r - .05), [, y1] = along(t, r + .05); k.box(u0 - .12, u0 + .12, y0, y1, t === .5 ? shade(STEEL, -.4) : shade(STEEL, .2)); }
  k.face(b - .9, b, y + 2.4, y + 5.2, shade(CLAD, -.05));
  k.lines([([b - .45, y, b - .45, y + 2.4] as const)], STEEL, .14, .95);
  if (k.seen) k.lying(b - .3, b + .5, y + 3.55, y + 3.85, shade(STEEL, -.1));
  // The conveyor from the hopper up to the top of the house, on its bent.
  conveyor(k, ([yard - .2, y + 1.1] as const), ([house[1]! - .1, roof - .6] as const));
  // The house: clad in sheet, a monitor along its roof, louvres and its door.
  k.face(house[0]!, house[1]!, y, roof, CLAD);
  k.shape([([house[0]! - .2, roof] as const), ([house[1]! + .2, roof] as const), ([house[1]! + .2, roof + .2] as const), ([house[0]! - .2, roof + .2] as const)], litFace(ROOF));
  k.face(house[0]! + 1.1, house[1]! - 1, roof + .2, roof + 1.2, shade(CLAD, .06)); k.face(house[0]! + .95, house[1]! - .85, roof + 1.2, roof + 1.38, ROOF);
  if (k.seen) {
    const sheet = []; for (let u = house[0]! + .2; u < house[1]!; u += k.near ? .2 : .6) sheet.push(([u, y + .3, u, roof - .1] as const));
    k.lines(sheet, OUTLINE, .016, .22);
    k.face(house[0]! + 2.2, house[1]! - .7, y, y + 2.6, shade(CLAD, -.3));
    panelDetails(k, house[0]! + 2.2, house[1]! - .7, y, y + 2.6);
    k.path([([house[0]! + .5, y + .3] as const), ([house[0]! + .5, roof - .8] as const), ([house[0]! + .8, roof - .8] as const)], shade(STEEL, -.2), .035, .8);
    k.face(house[0]! + .35, house[0]! + .78, y + 1, y + 1.65, shade(STEEL, -.1));
    k.box(house[0]! + 1.3, house[1]! - 1.2, roof + .4, roof + 1, OPENING, .7);
    k.lip(house[0]!, house[1]!, roof - .03);
  }
  // The hopper the haulers tip into at the yard: its bin on legs, the bars over it, the chute onto the conveyor.
  hopper(k, yard, y);
}
function hopper(k: BaseKit, yard: number, y = k.low(yard - 2, yard + 2) - .2) {
  const [wide, narrow] = WORKS.hopper, rim = y + 3.4, neck = y + 1.9;
  k.lines([([yard - wide / 2 + .3, y, yard - wide / 2 + .3, rim - .4] as const), ([yard + wide / 2 - .3, y, yard + wide / 2 - .3, rim - .4] as const)], STEEL, .12, .95);
  k.shape([([yard - wide / 2, rim] as const), ([yard + wide / 2, rim] as const), ([yard + narrow / 2, neck] as const), ([yard - narrow / 2, neck] as const)], litFace(shade(STEEL, .05)), k.seen, 'paint');
  k.face(yard - narrow / 2, yard + narrow / 2, neck - .6, neck, shade(STEEL, -.15));
  k.lip(yard - wide / 2 + .05, yard + wide / 2 - .05, rim - .04);
  if (k.seen) {
    k.lines([([yard - wide / 2 + .06, rim - .06, yard - narrow / 2 + .06, neck + .06] as const), ([yard + wide / 2 - .06, rim - .06, yard + narrow / 2 - .06, neck + .06] as const)], shade(STEEL, .18), .055, .75);
    k.bolts([([yard - wide / 2 + .1, rim - .1] as const), ([yard + wide / 2 - .1, rim - .1] as const), ([yard - narrow / 2 + .1, neck + .1] as const), ([yard + narrow / 2 - .1, neck + .1] as const)], .025);
  }
  if (k.near) { const bars = []; for (let u = yard - wide / 2 + .2; u < yard + wide / 2; u += .25) bars.push(([u, rim, u, rim + .1] as const)); k.lines(bars, OUTLINE, .02, .7); }
}

// The shed at the yard of the rear, where the ore waits: a roof of sheet on posts, open on the side the view is from, and
// the bays under it between their walls of concrete blocks.
function oreShed(k: BaseKit, yard: number) {
  const a = yard - 6.5, b = yard + 5.5, y = k.low(a, b) - .2, eaves = y + 4.8, peak = y + 5.5, under = (u: number) => eaves + (peak - eaves) * (u - a) / (b - a);
  // The back wall in the shade of the roof, its sheets seen through the open side.
  k.shape([([a, y] as const), ([b, y] as const), ([b, under(b)] as const), ([a, under(a)] as const)], litFace(SHADED), k.seen, 'paint');
  if (k.seen) { const back = []; for (let u = a + .3; u < b; u += k.near ? .25 : .75) back.push(([u, y + .3, u, under(u) - .3] as const)); k.lines(back, OUTLINE, .016, .22); }
  // The walls between the bays: blocks of concrete stacked three high, seen end on, in the shade of the roof.
  for (const u of ([a + 2.4, (a + b) / 2, b - 2.4] as const)) for (let h = 0; h < 3; h++) k.face(u - .4, u + .4, y + h * .8, y + (h + 1) * .8, shade(CONCRETE, -.3 - .03 * h), k.seen, 'concrete');
  for (const u of ([a + .12, (a + b) / 2, b - .12] as const)) {
    k.standing(u - .12, u + .12, y, under(u), STEEL);
    k.face(u - .23, u + .23, y, y + .15, shade(CONCRETE, -.18), k.seen, 'concrete');
    if (k.seen) { k.face(u - .2, u + .2, under(u) - .45, under(u) - .2, shade(STEEL, -.1)); k.bolts([([u - .11, under(u) - .32] as const), ([u + .11, under(u) - .32] as const)], .024); }
  }
  k.lines([([a, eaves - .1, b, peak - .1] as const)], shade(STEEL, -.2), .2, .95);
  k.shape([([a - .5, under(a - .5)] as const), ([b + .5, under(b + .5)] as const), ([b + .5, under(b + .5) + .28] as const), ([a - .5, under(a - .5) + .28] as const)], litFace(ROOF), k.seen);
  if (k.near) { const ribs = []; for (let u = a - .4; u < b + .4; u += .25) ribs.push(([u, under(u) + .02, u, under(u) + .26] as const)); k.lines(ribs, GLINT, .008, .25); }
  hopper(k, yard);
}

// The radar's cabin, its mast up to the turntable, and the stakes of the microphones.
function watchWorks(k: BaseKit, base: BaseFootprint, ground: BaseGround) {
  const post = watchPosts(base, ground), u = RADAR_AT, y = post.radar.foot;
  k.face(u - 1.3, u + 1.3, y, y + 2, shade(OLIVE, .08)); k.face(u - 1.4, u + 1.4, y + 2, y + 2.18, ROOF);
  k.face(u - .95, u - .25, y, y + 1.6, shade(OLIVE, -.12));
  if (k.seen) {
    k.box(u + .2, u + .95, y + 1.1, y + 1.6, OPENING, .8);
    if (k.near) { const louvres = []; for (let h = y + 1.17; h < y + 1.6; h += .07) louvres.push(([u + .25, h, u + .9, h] as const)); k.lines(louvres, GLINT, .01, .3); }
    k.lip(u - 1.28, u + 1.28, y + 1.97);
  }
  k.standing(u - .08, u + .08, y + 2.18, post.radar.y, STEEL);
  k.lines([([u, y + 2.18, u, post.radar.y] as const)], shade(STEEL, .2), .02, .4);
  for (const [i, ear] of post.ears.entries()) {
    k.lines([([EARS_AT[i]!, ear.foot, EARS_AT[i]!, ear.y] as const)], STEEL, .05, .9);
    if (k.seen) k.face(EARS_AT[i]! - .09, EARS_AT[i]! + .09, ear.foot + .5, ear.foot + .75, shade(OLIVE, -.1));
  }
}

// Perimeter markers share their sizing and terrain contact in a base and a post.
function perimeterMarkers(k: BaseKit, radius: number, color: number) {
  const { at, high, pixel, g } = k;
  for (const u of ([-radius, radius] as const)) {
    const y = high(u) - .15, tall = Math.max(2.4, 13 * pixel), size = Math.max(.7, 5 * pixel) * (u < 0 ? 1 : -1);
    k.lines([([u, y, u, y + tall] as const)], STEEL, .1, .9);
    g.poly([at(u), y + tall, at(u + size), y + tall - Math.abs(size) * .32, at(u), y + tall - Math.abs(size) * .64]).fill({ color, alpha: .9 });
    if (k.seen) { k.face(u - .22, u + .22, y, y + 1.05, FOOTING); k.box(u - .22, u + .22, y + .55, y + .8, color, .7); }
  }
}

// `pixel` is the size of a screen pixel in metres at the scale the art is made for: lines are never thinner than a pixel,
// the flag and the end markers never smaller than a few, and what only a near view tells apart is left out from afar.
// `flag` is the flag of the faction, and `texture` its picture when it is a country's (nothing of it is drawn until that
// has come). Returns where it flies, for the label over it. `works` and `front` are drawn into as they stand: whoever owns
// them has emptied them and stood them at their anchor. Without its `watch` it is the base of another, as a faction knows
// it: what that base keeps watch with is not drawn, neither the radar nor the microphones. Nothing else the art is told of
// a base is anything but its place, its facing and its reach: what it holds or keeps is never drawn.
export function drawBaseArt(works: Graphics, front: Graphics, base: BaseFootprint, ground: BaseGround, pixel: number, flag: FlagChoice, texture: Texture | null = null, color = 0xb4d28b, watch = true, materials: BaseMaterials | null = null) {
  const k = kit(works, base, ground, pixel, materials), { at, high } = k, radius = base.radius, yard = yardAt(base), g = works;

  // The corners of the perimeter at the two ends, with a watchtower in each, looking in over the base.
  for (const way of ([-1, 1] as const)) {
    const [inner, outer] = WORKS.wall, [far, near] = WORKS.tower;
    baskets(k, way < 0 ? -radius + outer : radius - inner, way < 0 ? -radius + inner : radius - outer, 1, true);
    watchtower(k, way < 0 ? -radius + near : radius - far, -way);
  }
  radioMast(k, WORKS.mast);
  nets(k);
  oreShed(k, -yard);
  refinery(k, yard);
  magazine(k);
  if (watch) watchWorks(k, base, ground);
  tent(k);
  container(k, ...WORKS.office, 'office');
  container(k, ...WORKS.radio, 'radio');
  generator(k);
  for (const u of ([-40, -13] as const)) lightingMast(k, u);
  fuel(k);
  const { floor, eaves, crown } = hall(k, color);
  jerrycans(k, 14.25, 3, 2);

  perimeterMarkers(k, radius, color);

  // The flag of the faction, on a mast over the hall: from afar it is the base.
  const [a] = WORKS.hall, mast = 5.5, foot = floor + (crown - eaves) * Math.sin(Math.PI * (mast - a + .4) / 19.8) + 4.3 - .1,
    peak = Math.max(crown + 5.5, high(mast) + 62 * pixel), wide = Math.max(2.4, 21 * pixel) * k.side, tall = Math.abs(wide) * flagTall(flag);
  g.moveTo(at(mast), foot).lineTo(at(mast), peak).stroke({ color: DARK, width: Math.max(.09, 3.4 * pixel), alpha: .55, cap: 'round' });
  g.moveTo(at(mast), foot).lineTo(at(mast), peak).stroke({ color, width: Math.max(.045, 1.7 * pixel), cap: 'round' });
  drawFlag(g, flag, at(mast), peak, wide, texture);
  g.poly([at(mast), peak, at(mast) + wide, peak, at(mast) + wide, peak - tall, at(mast), peak - tall]).stroke({ color: DARK, width: Math.max(.02, .8 * pixel), alpha: .6, join: 'round' });

  // On the ground itself: the band along what the base covers, the hardstand where vehicles are served and the aprons of
  // the yards where haulers tip their loads, each with the joints of its slabs.
  front.moveTo(at(-radius), high(-radius) - .1);
  for (let u = -radius + 4; u < radius; u += 4) front.lineTo(at(u), high(u) - .1);
  front.lineTo(at(radius), high(radius) - .1).stroke({ color, width: Math.max(.3, 3 * pixel), alpha: .28, join: 'round', cap: 'round' });
  for (const [from, to] of [([-40, -13] as const), ([-yard - 9, -yard + 7] as const), ([yard - 7, yard + 9] as const)]) {
    apron(front, at, high, from, to, .015, .2, 0xa5a28c, .9); apron(front, at, high, from, to, .015, -.035, 0xc4c2aa, .7);
    if (k.seen) {
      for (let u = from + 3; u < to; u += 3) front.moveTo(at(u), high(u) - .02).lineTo(at(u - .05), high(u) - .2);
      front.stroke({ color: LINE, width: k.thin(.03), alpha: .35, cap: 'round' });
    }
  }
  return { x: at(mast), y: peak };
}
// A post of a faction (territory.ts) is a small forward post in the manner of the base, a third of one: a corner of
// baskets under concertina at each end; at the yard of the rear the shed the ore waits in, as the base has it, and at the
// yard of the front the point it is sent on from to the stocks of the faction, a hopper the haulers tip into and its
// conveyor up to the roof of a bin on legs; between them what serves the vehicles over its ground, a magazine in a
// container with pallets of ammunition boxes by it, a repair shelter of membrane over its bay, the fuel point with its
// bladder in a bund and jerrycans, and a lamp on its mast; in the middle the flag of the faction on a mast of its own.
// It keeps no watch: that is the base's alone. Where each work stands, in metres from the middle towards the side the
// post faces; the corners are counted from the ends, as the base's are, and the bin from the yard of the front.
export const POST_WORKS = Object.freeze(({ wall: ([6.4, 1]), boxes: -42.5, magazine: ([-39.2, -33.14]), shelter: ([-17, -6]), hardstand: ([-18.6, -4.4]),
  mast: 0, fuel: ([2.5, 9.3]), cans: 9.8, light: 15.5, bin: ([11, 14]) }) satisfies Record<string, number | [number, number]>);
// When each work of a post is begun and when it stands, in shares of its works from 0 to 1. Before it is begun a work is
// the pegs it is set out by; then it is footed and rises, in scaffolding where it stands tall; done, it is as it stays.
export const POST_BUILD = Object.freeze(({ yards: ([.02, .22]), corners: ([.04, .4]), shelter: ([.08, .62]), fuel: ([.14, .46]), shed: ([.22, .72]),
  magazine: ([.3, .56]), bin: ([.34, .9]), light: ([.6, .8]), mast: ([.78, .96]) }) satisfies Record<string, [number, number]>);

// Scaffolding about a work that rises, from its floor `y0` to where the work has come, `y1`: standards on sole boards, each
// on its own ground, a ledger over their feet and one with its boards at every lift, braces across alternate bays, and
// the rails over the top lift. From afar it is a haze of tubes over the work, framed. Its tubes are galvanised, a little
// paler than the wire of the stays.
const TUBE = shade(WIRE, .06);
function scaffold(k: BaseKit, a: number, b: number, y0: number, y1: number) {
  const lifts: number[] = [];
  for (let h = y0 + 2; h <= y1 + 1e-9; h += 2) lifts.push(h);
  const top = (lifts.at(-1) ?? y0 + .2) + 1, bays = Math.max(1, Math.round((b - a) / 2.1)), standards = [];
  for (let i = 0; i <= bays; i++) standards.push(a + (b - a) * i / bays);
  const feet = standards.map(u => k.low(u - .2, u + .2) - .1);
  if (!k.seen) {
    k.box(a, b, y0, top, TUBE, .25);
    k.lines([([a, feet[0]!, a, top] as const), ([b, feet.at(-1)!, b, top] as const), ([a, top, b, top] as const)], TUBE, .06, .85);
    return;
  }
  k.lines(standards.map((u, i) => ([u, feet[i]!, u, top] as const)), TUBE, .048, .9);
  k.lines([([a, y0 + .3, b, y0 + .3] as const), ...lifts.map(h => ([a, h, b, h] as const)), ([a, top - .5, b, top - .5] as const), ([a, top, b, top] as const)], TUBE, .044, .85);
  const braces = [];
  for (let i = 0; i < bays; i += 2) braces.push(([standards[i]!, y0 + .3, standards[i + 1]!, top - .5] as const));
  k.lines(braces, shade(TUBE, -.12), .04, .75);
  for (const h of lifts) k.box(a - .05, b + .05, h, h + .05, TIMBER);
  if (k.near) {
    for (const [i, u] of standards.entries()) k.box(u - .22, u + .22, feet[i]! - .05, feet[i]! + .04, TIMBER);
    if (lifts.length) k.box(a, b, lifts.at(-1)! + .05, lifts.at(-1)! + .2, shade(TIMBER, -.12));
    k.bolts(standards.flatMap(u => [([u, y0 + .3] as const), ...lifts.map(h => ([u, h] as const)), ([u, top] as const)]), .03);
  }
}

// A corner of baskets at an end of the post, filled cell by cell as it is built, those still to fill standing open; the
// concertina goes over it once it is done.
function corner(k: BaseKit, a: number, b: number, built: number) {
  if (built >= 1) { baskets(k, a, b, 1, true); return; }
  const unit = 1.06, count = Math.floor((b - a) / unit + 1e-9), filled = Math.floor(built * count + 1e-9);
  if (filled) baskets(k, a, a + filled * unit, 1, false);
  if (!k.seen) return;
  const open = [];
  for (let i = filled; i < count; i++) {
    const u = a + i * unit, y = k.low(u, u + unit) - .2;
    open.push(([u, y, u, y + 1.37] as const), ([u + unit, y, u + unit, y + 1.37] as const), ([u, y + 1.37, u + unit, y + 1.37] as const), ([u + unit / 2, y, u + unit / 2, y + 1.37] as const));
  }
  k.lines(open, LINE, .02, .7);
}

// The point at the yard of the front where what the haulers tip is sent on to the stocks of the faction: the hopper they
// tip into, the conveyor up to the roof of a bin on legs, and the bin itself, its cone and gate over the bay it loads
// into, the ladder in its cage and the rail round its roof. While it is built (`built` under 1) the footings of its legs
// come first, then the legs and the rings of the bin in scaffolding, the hopper, and last the roof and the conveyor.
function transfer(k: BaseKit, yard: number, built = 1) {
  const [p, q] = POST_WORKS.bin, a = yard + p, b = yard + q, mid = (a + b) / 2, y = k.low(a - .3, b + .9) - .2, done = built >= 1,
    gate = y + 2.3, belly = y + 3.6, top = y + 6.8, cone = top + .6, legs = ([a + .2, b - .2] as const),
    reach = done ? top : y + .2 + Math.max(0, built - .12) / .88 * (top - y - .2);
  for (const u of legs) k.face(u - .3, u + .3, y - .3, y + .2, shade(CONCRETE, -.08), k.seen, 'concrete');
  if (reach > y + .5) for (const u of legs) k.standing(u - .09, u + .09, y + .2, Math.min(reach, belly), STEEL);
  if (reach >= belly) {
    if (k.seen) k.lines([([legs[0]!, y + .5, legs[1]!, belly - .2] as const), ([legs[1]!, y + .5, legs[0]!, belly - .2] as const)], shade(STEEL, -.1), .045, .8);
    k.shape([([a + .05, belly] as const), ([b - .05, belly] as const), ([mid + .32, gate + .3] as const), ([mid - .32, gate + .3] as const)], standingRound(shade(CLAD, .08)), k.seen, 'paint');
    k.face(mid - .32, mid + .32, gate, gate + .3, shade(STEEL, -.15));
    if (k.seen) k.shape([([mid - .22, gate] as const), ([mid + .22, gate] as const), ([mid + .32, gate - .45] as const), ([mid - .08, gate - .45] as const)], litFace(shade(STEEL, -.05)), true);
    k.face(a, b, belly - .16, belly, shade(STEEL, -.12));
    // The body, ring on ring, the seams between them pale where the light takes their lap.
    const body = Math.min(reach, top);
    if (body > belly + .1) {
      k.standing(a, b, belly, body, shade(CLAD, .12));
      if (k.seen) {
        const seams = [], laps = [];
        for (let s = belly + .8; s < body - .1; s += .8) { seams.push(([a, s, b, s] as const)); laps.push(([a, s - .03, b, s - .03] as const)); }
        k.lines(seams, OUTLINE, .016, .3); k.lines(laps, GLINT, .01, .2);
        if (k.near) k.bolts(seams.flatMap(([, s]) => [a + .25, a + .8, mid, b - .8, b - .25].map(u => ([u, s + .04] as const))), .02);
      }
    }
  }
  if (!done) {
    if (built >= .55) hopper(k, yard);
    if (reach > y + .6) scaffold(k, a - .5, b + .5, y + .2, reach);
    return;
  }
  // The roof, its vent, the rail round its edge, and the ladder up the far side in its cage.
  k.shape([([a - .08, top] as const), ([b + .08, top] as const), ([mid + .4, cone] as const), ([mid - .4, cone] as const)], litFace(ROOF), k.seen);
  k.face(mid - .25, mid + .25, cone, cone + .2, shade(ROOF, -.1)); k.face(mid - .36, mid + .36, cone + .2, cone + .28, ROOF);
  k.lip(a - .06, b + .06, top + .02);
  if (k.seen) {
    k.lines([([a + .05, top, a + .05, top + 1] as const), ([mid, top, mid, top + 1] as const), ([b - .05, top, b - .05, top + 1] as const), ([a + .05, top + 1, b - .05, top + 1] as const), ([a + .05, top + .5, b - .05, top + .5] as const)], STEEL, .035, .85);
    const cage = [([b + .12, y + .4, b + .12, top + 1] as const), ([b + .48, y + 2.6, b + .48, top + 1] as const), ([b + .8, y + 2.6, b + .8, top + .9] as const)];
    for (let h = y + 2.6; h < top + 1; h += .9) cage.push(([b + .12, h, b + .8, h] as const));
    k.lines(cage, STEEL, .03, .85);
    if (k.near) for (let h = y + .7; h < top + .9; h += .3) k.box(b + .09, b + .15, h - .02, h + .02, shade(STEEL, .15));
  }
  // The conveyor from the hopper up to the head over the hatch in the roof, on its bent; the hopper in front of it.
  const hy = k.low(yard - 2, yard + 2) - .2, c1 = ([a + .75, cone + .65] as const);
  conveyor(k, ([yard + .2, hy + 1.1] as const), c1);
  k.face(c1[0]! - .05, c1[0]! + .3, top + .35, c1[1]! - .1, shade(STEEL, -.15));
  k.face(c1[0]! - .35, c1[0]! + .45, c1[1]! - .15, c1[1]! + .55, shade(CLAD, -.05));
  k.lip(c1[0]! - .33, c1[0]! + .43, c1[1]! + .52);
  hopper(k, yard);
}

// The shed of the yard of the rear as it is built: the pads of its posts, the posts rising and the walls of its bays laid
// course by course, and the rafter once they stand, in scaffolding; done, it is the shed of the base (`oreShed`).
function shedFrame(k: BaseKit, yard: number, built: number) {
  const a = yard - 6.5, b = yard + 5.5, y = k.low(a, b) - .2, eaves = y + 4.8, peak = y + 5.5, under = (u: number) => eaves + (peak - eaves) * (u - a) / (b - a),
    reach = y + built * (peak + .3 - y), courses = Math.min(3, Math.floor(built * 4 + 1e-9));
  for (const u of ([a + 2.4, (a + b) / 2, b - 2.4] as const)) for (let h = 0; h < courses; h++) k.face(u - .4, u + .4, y + h * .8, y + (h + 1) * .8, shade(CONCRETE, -.3 - .03 * h), k.seen, 'concrete');
  for (const u of ([a + .12, (a + b) / 2, b - .12] as const)) {
    k.face(u - .23, u + .23, y, y + .15, shade(CONCRETE, -.18), k.seen, 'concrete');
    if (reach > y + .3) k.standing(u - .12, u + .12, y, Math.min(reach, under(u)), STEEL);
  }
  if (reach >= peak) k.lines([([a, eaves - .1, b, peak - .1] as const)], shade(STEEL, -.2), .2, .95);
  scaffold(k, a - .4, b + .4, y, reach);
}

// A magazine of a post: a container on its blocks, set once they are laid, and the pallets of ammunition by it once done.
function magazinePoint(k: BaseKit, built: number) {
  const [a, b] = POST_WORKS.magazine;
  if (built >= .5) container(k, a, b, 'magazine');
  else for (const u of ([a + .1, b - .45] as const)) k.box(u, u + .35, k.low(u, u + .35) - .2, k.top(a, b) + .12, shade(CONCRETE, -.08));
  if (built >= 1) ammoBoxes(k, POST_WORKS.boxes, 4, 3);
}

// Pallets of ammunition boxes, strapped down: each box with the seam of its lid, its catches and the grip at its end.
function ammoBoxes(k: BaseKit, a: number, rows: number, tiers: number) {
  const wide = .52, tall = .29, pitch = wide + .04, b = a + rows * pitch + .04, y0 = k.low(a, b) - .1, lids = [];
  k.box(a, b, y0, y0 + .14, TIMBER);
  for (let t = 0; t < tiers; t++) for (let r = 0; r < rows; r++) {
    const u = a + .04 + r * pitch, y = y0 + .14 + t * (tall + .02);
    k.face(u, u + wide, y, y + tall, shade(OLIVE, (r + t) % 2 ? .04 : -.04));
    if (k.seen) lids.push(([u + .02, y + tall - .07, u + wide - .02, y + tall - .07] as const));
    if (k.near) { for (const c of ([u + .1, u + wide - .16] as const)) k.box(c, c + .06, y + tall - .11, y + tall - .03, shade(STEEL, .1)); k.lines([([u + wide - .02, y + .1, u + wide + .015, y + .1] as const)], DARK, .02, .8); }
  }
  k.lines(lids, OUTLINE, .014, .45);
  if (k.seen) { const over = y0 + .14 + tiers * (tall + .02); k.lines([([a + .3, y0 + .1, a + .3, over] as const), ([b - .3, y0 + .1, b - .3, over] as const)], shade(LINER, -.15), .03, .85); }
}

// The repair shelter of a post: a small hall of membrane on arched frames seen at its end, as the hall of the base is, on
// a footing that levels the slope under it.
function shelterPlan(k: BaseKit) {
  const [a, b] = POST_WORKS.shelter, floor = k.low(a, b) + (k.top(a, b) - k.low(a, b)) * .35 + .15, eaves = floor + 3.1, crown = eaves + 1.7, span = b - a + .6;
  return { a, b, floor, eaves, crown, span, arch: (u: number) => eaves + (crown - eaves) * Math.sin(Math.PI * (u - a + .3) / span), bay: ([a + 1.8, b - 2.4] as const), head: floor + 3.3 };
}
function shelterFooting(k: BaseKit, { a, b, floor }: ShelterPlan) {
  const deep = k.low(a - 1.4, b + 1.4) - 1;
  k.shape([([a - .8, floor] as const), ([b + .8, floor] as const), ([b + 1.4, deep] as const), ([a - 1.4, deep] as const)], FOOTING, false, 'concrete');
  k.box(a - .8, b + .8, floor - .2, floor, shade(FOOTING, -.2), .8);
}
function shelterFrames(k: BaseKit, { a, b, floor, arch, bay }: ShelterPlan, reach = Infinity) {
  for (const u of ([a, bay[0]! - .12, bay[1]! + .12, b] as const)) if (Math.min(reach, arch(u) - .2) > floor + .3) k.standing(u - .1, u + .1, floor, Math.min(reach, arch(u) - .2), STEEL, false);
}
function shelterRoof(k: BaseKit, { a, span, arch }: ShelterPlan) {
  const roof = [];
  for (let i = 0; i <= 16; i++) roof.push(([a - .3 + span * i / 16, arch(a - .3 + span * i / 16)] as const));
  for (let i = 16; i >= 0; i--) roof.push(([a - .3 + span * i / 16, arch(a - .3 + span * i / 16) - .25] as const));
  k.shape(roof, litFace(ROOF), k.seen);
}
// Done: its end in one membrane, seamed, on the posts of its frame; the bay open under the drum its door is rolled up
// into, with the colour of the field on the hood over it; in the shade of the bay the gantry with its hoist and the bench;
// a door, the lamp over the bay, the sandbags that weigh down its skirt and the stays to their pegs.
function shelter(k: BaseKit, color: number) {
  const plan = shelterPlan(k), { a, b, floor, eaves, span, arch, bay, head } = plan;
  shelterFooting(k, plan);
  const end = [([a, floor] as const), ([b, floor] as const), ([b, arch(b)] as const)];
  for (let i = 9; i >= 1; i--) { const u = a - .3 + span * i / 10; end.push(([u, arch(u)] as const)); }
  end.push(([a, arch(a)] as const));
  k.shape(end, litFace(MEMBRANE), k.seen, 'rubber');
  k.box(a, b, floor, floor + .4, shade(MEMBRANE, -.3), .8);
  if (k.seen) {
    const seams = [], light = [];
    for (let u = a + 1.1; u < b - .3; u += 1.1) { seams.push(([u, floor + .4, u, arch(u) - .3] as const)); light.push(([u + .05, floor + .4, u + .05, arch(u) - .3] as const)); }
    k.lines(seams, OUTLINE, .02, .2); k.lines(light, GLINT, .012, .12);
    shelterFrames(k, plan);
  }
  shelterRoof(k, plan);
  k.box(bay[0]!, bay[1]!, floor, head, OPENING);
  if (k.seen) {
    const dim = shade(OPENING, .16), hoist = bay[0]! + (bay[1]! - bay[0]!) * .62;
    k.box(bay[0]! + .25, bay[1]! - .25, head - .45, head - .3, dim);
    k.lines([([bay[0]! + .55, floor, bay[0]! + .55, head - .45] as const), ([bay[1]! - .55, floor, bay[1]! - .55, head - .45] as const)], dim, .1);
    k.box(hoist - .18, hoist + .18, head - .62, head - .45, shade(OPENING, .24));
    k.lines([([hoist, head - .62, hoist, floor + 1.5] as const)], shade(STEEL, -.35), .025, .9);
    k.box(hoist - .07, hoist + .07, floor + 1.38, floor + 1.5, shade(STEEL, -.25));
    if (k.near) {
      k.box(bay[0]! + .8, bay[0]! + 2.6, floor + 1.15, floor + 2, shade(OPENING, .07));
      k.box(bay[0]! + .7, bay[0]! + 2.7, floor, floor + .9, shade(OPENING, .12));
      k.box(bay[0]! + 2.2, bay[0]! + 2.45, floor + .9, floor + 1.08, shade(STEEL, -.3));
    }
    k.lines([([bay[0]!, floor, bay[0]!, head] as const), ([bay[1]!, floor, bay[1]!, head] as const)], shade(STEEL, -.3), .08, .9);
  }
  k.lying(bay[0]! - .15, bay[1]! + .15, head, head + .32, shade(STEEL, .06), .16);
  k.face(bay[0]! - .25, bay[1]! + .25, head + .32, head + .58, shade(STEEL, -.05)); k.box(bay[0]! - .25, bay[1]! + .25, head + .4, head + .5, color, .75);
  if (k.seen) {
    k.face(b - 1.95, b - .95, floor, floor + 2.05, shade(MEMBRANE, -.28)); panelDetails(k, b - 1.95, b - .95, floor, floor + 2.05);
    const mid = (bay[0]! + bay[1]!) / 2;
    k.shape([([mid - .25, head + .78] as const), ([mid + .25, head + .78] as const), ([mid + .17, head + .66] as const), ([mid - .17, head + .66] as const)], LAMP);
    k.lines([([mid, head + .58, mid, head + .66] as const)], STEEL, .04);
    sandbags(k, a + .1, a + 1.5, floor, 2); sandbags(k, b - .85, b - .1, floor, 2);
    k.lines([([a + .05, eaves - .3, a - 1.6, k.high(a - 1.6) - .05] as const), ([b - .05, eaves - .3, b + 1.6, k.high(b + 1.6) - .05] as const)], DARK, .012, .5);
  }
}
// As it is built: its footing, the posts of its frame rising and the arch over them, in scaffolding.
function shelterFrame(k: BaseKit, built: number) {
  const plan = shelterPlan(k), { a, b, floor, crown } = plan, reach = floor + Math.max(0, built - .15) / .85 * (crown + .3 - floor);
  shelterFooting(k, plan);
  shelterFrames(k, plan, reach);
  if (reach >= crown) shelterRoof(k, plan);
  if (reach > floor + .3) scaffold(k, a - .5, b + .5, floor, reach);
}

// The fuel point of a post: a bladder on the liner of its pit, the pump at its end with the reel of its hose, and the bund
// of earth in front of them. As it is built the pit is dug and the bund heaped, then the bladder is laid in it, flat
// until it is filled, and the pump set by it.
function postFuel(k: BaseKit, built = 1) {
  const [a, b] = POST_WORKS.fuel, level = k.low(a, b) + .15, bladder = ([a + .4, b - 1.2] as const), pump = ([b - 1.05, b - .4] as const), done = built >= 1;
  k.shape([([a, level] as const), ([b, level] as const), ([b, k.low(a, b) - 1] as const), ([a, k.low(a, b) - 1] as const)], shade(FOOTING, -.08));
  if (built >= .5) k.lying(bladder[0]!, bladder[1]!, level, level + (done ? 1.1 : .28), RUBBER, done ? .5 : .14, 'rubber');
  if (done && k.seen) {
    const [u0, u1] = bladder;
    k.lines([([u0 + 1.2, level + .05, u0 + 1.2, level + 1.07] as const), ([u1 - 1.2, level + .05, u1 - 1.2, level + 1.07] as const)], shade(RUBBER, .25), .07, .6);
    k.face(u0 + .5, u0 + .85, level + 1.07, level + 1.25, STEEL);
    k.face(u0 + .47, u0 + .88, level + 1.22, level + 1.29, shade(STEEL, .12), false);
    for (const u of ([u0 + 1.2, u1 - 1.2] as const)) { k.face(u - .055, u + .055, level + .12, level + .27, shade(STEEL, .12), false); k.box(u - .025, u + .025, level + .16, level + .23, OPENING); }
  }
  if (built >= .75) {
    k.face(pump[0]!, pump[1]!, level, level + 1.5, shade(OLIVE, .05));
    panelDetails(k, pump[0]!, pump[1]!, level + .03, level + 1.46);
    k.disc((pump[0]! + pump[1]!) / 2, level + 1.02, .25, OPENING, false);
    if (k.seen) {
      const reel = (pump[0]! + pump[1]!) / 2;
      k.ring(reel, level + 1.02, .19, shade(RUBBER, .15), .07); k.disc(reel, level + 1.02, .06, STEEL, false);
      if (done) k.path([([bladder[0]! + .8, level + 1.22] as const), ([bladder[1]! - .35, level + 1.22] as const), ([pump[0]! - .15, level + 1.4] as const), ([pump[0]!, level + 1.4] as const)], RUBBER, .055, .95);
      k.path([([pump[1]!, level + .3] as const), ([pump[1]! + .25, level + .25] as const), ([pump[1]! + .32, level + .5] as const)], RUBBER, .06, .9);
      k.lip(pump[0]! + .02, pump[1]! - .02, level + 1.48);
    }
  }
  // The bund, heaped as the pit is dug, faced with the liner where it turns over its crest.
  const heap = Math.min(1, built * 2), bund = [([a - .4, level - .2] as const)];
  for (let s = 0; s <= 10; s++) bund.push(([a - .2 + s * (b - a + .4) / 10, level - .2 + (.7 + .05 * jitter(s + 7)) * heap] as const));
  bund.push(([b + .4, level - .2] as const));
  k.shape(bund, litFace(EARTH), k.seen, 'earth');
  if (k.seen && heap >= 1) k.lines([([a - .2, level + .52, b + .2, level + .52] as const)], shade(LINER, .1), .05, .5);
}

// The lamp of a post, on a mast that rises section by section from its foot as it is put up, the lamps on its head.
function lampMast(k: BaseKit, u: number, built: number) {
  if (built >= 1) { lightingMast(k, u); return; }
  const y = k.low(u - .5, u + .5) - .2, tall = y + .5 + (8.5 - .5) * built;
  k.face(u - .35, u + .35, y, y + .5, shade(STEEL, -.1));
  if (tall < y + 1) return;
  k.standing(u - .09, u + .09, y + .5, tall, STEEL);
  if (k.seen) for (let h = y + 3.3; h < tall - .2; h += 2.8) k.face(u - .12, u + .12, h - .06, h + .06, shade(STEEL, -.15), false);
  k.lines([([u - .9, tall, u + .9, tall] as const)], STEEL, .12, .95);
  for (const lamp of ([-.75, .75] as const)) k.shape([([u + lamp - .32, tall - .08] as const), ([u + lamp + .32, tall - .08] as const), ([u + lamp + .22, tall - .5] as const), ([u + lamp - .22, tall - .5] as const)], litFace(STEEL), k.seen);
}

// `pixel`, `flag`, `texture`, `works` and `front` are as the base's (drawBaseArt). A post is drawn over the ground it
// serves (`post.radius` to each side of `post.x`, facing `post.facing`): its works as they are told above, the yards where
// haulers tip their loads as far in from each end as they stop (yardAt), a marker at each end with a pennant in the colour
// of the faction (`color`), the band along its ground, and the flag of the faction on its mast in the middle. `progress`
// is how far its works have come, from 0 to 1 (POST_BUILD): one not done shows each work as far as it has come, and its
// mast bare; the flag goes up only when all is done. Returns where the flag flies, or will fly, over the middle of the
// post, for the label over it. Nothing else the art is told of a post is drawn: what it holds changes no line of it.
export function drawPostArt(works: Graphics, front: Graphics, post: BaseFootprint, ground: BaseGround, pixel: number, flag: FlagChoice, texture: Texture | null = null, color = 0xb4d28b, materials: BaseMaterials | null = null, progress = 1) {
  const k = kit(works, post, ground, pixel, materials), { at, high } = k, radius = post.radius, yard = yardAt(post), g = works,
    done = progress >= 1, share = done ? 1 : progress > 0 ? progress : 0, begun = (work: keyof typeof POST_BUILD) => done || share >= POST_BUILD[work]![0]!,
    built = (work: keyof typeof POST_BUILD) => { const [from, to] = POST_BUILD[work]!; return done ? 1 : Math.max(0, Math.min(1, (share - from) / (to - from))); },
    [inner, outer] = POST_WORKS.wall, corners = [([-radius + outer, -radius + inner] as const), ([radius - inner, radius - outer] as const)],
    yards = [([-yard - 6, -yard + 6] as const), ([yard - 6, yard + 6] as const)], [binFrom, binTo] = POST_WORKS.bin;

  // The works, from the corners at the ends inwards.
  if (begun('corners')) for (const [a, b] of corners) corner(k, a, b, built('corners'));
  if (begun('bin')) transfer(k, yard, built('bin'));
  if (begun('shed')) { if (built('shed') >= 1) oreShed(k, -yard); else shedFrame(k, -yard, built('shed')); }
  if (begun('magazine')) magazinePoint(k, built('magazine'));
  if (begun('shelter')) { if (built('shelter') >= 1) shelter(k, color); else shelterFrame(k, built('shelter')); }
  if (begun('light')) lampMast(k, POST_WORKS.light, built('light'));
  if (begun('fuel')) { postFuel(k, built('fuel')); if (built('fuel') >= 1) jerrycans(k, POST_WORKS.cans, 3, 2); }

  // The pegs each work not yet begun is set out by, with the tape between them.
  const set = Object.entries({ corners, yards, shelter: ([POST_WORKS.hardstand] as const), fuel: [([POST_WORKS.fuel[0]!, POST_WORKS.cans + 1.14] as const)], shed: [([-yard - 6.5, -yard + 5.5] as const)],
    magazine: [([POST_WORKS.boxes, POST_WORKS.magazine[1]!] as const)], bin: [([yard + binFrom, yard + binTo + .8] as const)], light: [([POST_WORKS.light - .5, POST_WORKS.light + .5] as const)],
    mast: [([POST_WORKS.mast - .4, POST_WORKS.mast + .4] as const)] }).flatMap(([work, spans]) => begun(work as keyof typeof POST_BUILD) ? [] : spans);
  if (set.length) {
    k.lines(set.flatMap(ends => ends.map(u => ([u, high(u) - .1, u, high(u) + .9] as const))), TIMBER, .06, .95);
    if (k.seen) k.lines(set.map(([a, b]) => ([a, high(a) + .6, b, high(b) + .6] as const)), WARNING, .02, .75);
  }

  perimeterMarkers(k, radius, color);

  // The mast in the middle, on its footing: it rises section by section as the last of the works, and stands bare until
  // the post is done and the flag of the faction goes up on it. From afar the flag is the post.
  const u = POST_WORKS.mast, foot = k.low(u - .4, u + .4) - .2, plate = foot + .45, standing = plate + 9,
    peak = Math.max(standing, high(u) + 52 * pixel), wide = Math.max(2, 18 * pixel) * k.side, tall = Math.abs(wide) * flagTall(flag);
  if (begun('mast')) {
    k.face(u - .35, u + .35, foot, plate, CONCRETE, k.seen, 'concrete');
    const reach = done ? peak : plate + 9 * built('mast');
    if (reach > plate + .5) {
      g.moveTo(at(u), plate).lineTo(at(u), reach).stroke({ color: DARK, width: Math.max(.09, 3.4 * pixel), alpha: .55, cap: 'round' });
      g.moveTo(at(u), plate).lineTo(at(u), reach).stroke({ color, width: Math.max(.045, 1.7 * pixel), cap: 'round' });
      if (k.near) { k.lines([([u + .07, plate + 1.2, u + .07, reach] as const)], WIRE, .01, .7); k.box(u + .03, u + .15, plate + 1.1, plate + 1.3, STEEL); }
    }
  }
  if (done) {
    drawFlag(g, flag, at(u), peak, wide, texture);
    g.poly([at(u), peak, at(u) + wide, peak, at(u) + wide, peak - tall, at(u), peak - tall]).stroke({ color: DARK, width: Math.max(.02, .8 * pixel), alpha: .6, join: 'round' });
  }

  // On the ground itself: the band along what the post covers, and the aprons of the yards and the hardstand of the
  // shelter, graded first and then laid in slabs.
  front.moveTo(at(-radius), high(-radius) - .1);
  for (let v = -radius + 4; v < radius; v += 4) front.lineTo(at(v), high(v) - .1);
  front.lineTo(at(radius), high(radius) - .1).stroke({ color, width: Math.max(.3, 3 * pixel), alpha: .28, join: 'round', cap: 'round' });
  for (const [[from, to], work] of [...yards.map(span => [span, 'yards'] as const), [POST_WORKS.hardstand, 'shelter'] as const]) {
    if (!begun(work)) continue;
    if (built(work) < 1) { apron(front, at, high, from, to, .012, .15, EARTH, .55); continue; }
    apron(front, at, high, from, to, .015, .2, 0xa5a28c, .9); apron(front, at, high, from, to, .015, -.035, 0xc4c2aa, .7);
    if (k.seen) {
      for (let v = from + 3; v < to; v += 3) front.moveTo(at(v), high(v) - .02).lineTo(at(v - .05), high(v) - .2);
      front.stroke({ color: LINE, width: k.thin(.03), alpha: .35, cap: 'round' });
    }
  }
  return { x: at(u), y: peak };
}
// A strip that follows the ground between two places, from `over` above it to `under` below.
function apron(g: Graphics, at: (u: number) => number, high: (u: number) => number, a: number, b: number, over: number, under: number, fill: number, alpha = 1) {
  const upper = [], lower = [];
  for (let u = a; u < b; u += 2) { upper.push(at(u), high(u) + over); lower.unshift(at(u), high(u) - under); }
  upper.push(at(b), high(b) + over); lower.unshift(at(b), high(b) - under);
  return g.poly([...upper, ...lower]).fill({ color: fill, alpha });
}

// The words the watch has just had of a gun (`pulses`: faction-ui.ts), drawn on every frame the base is in the view:
// waves that leave the aerial of the radar, up and to the side the gun is on, or that come to the microphones from that
// side. `pixel` is the size of a screen pixel in metres as the frame has it: the waves are as large on the screen at any
// scale. `g` is drawn into as it stands, emptied and at its anchor.
export function drawBaseWatch(g: Graphics, base: BaseFootprint, ground: BaseGround, pixel: number, pulses: readonly BaseWatchPulse[] = []) {
  const post = watchPosts(base, ground), { x, y } = post.radar, width = Math.max(.05, 1.3 * pixel),
    middle = y + WATCH_RADAR.height / 2 + radarAerial(WATCH_RADAR.width, WATCH_RADAR.height).y;
  for (const pulse of pulses) {
    const radar = pulse.by === 'radar', ear = post.ears[1]!, fade = 1 - pulse.age, cx = radar ? x : ear.x, cy = radar ? middle : ear.y;
    for (let ring = 0; ring < 3; ring++) {
      // The waves of the radar grow as they go, tilted up to where the shells fly; a sound closes on the microphones, level.
      const radius = (radar ? 12 + 44 * pulse.age + ring * 9 : 8 + 34 * fade + ring * 8) * pixel;
      for (let step = 0; step <= 8; step++) {
        const angle = (radar ? .45 : 0) + (step / 8 - .5) * 1.1, px = cx + pulse.side * Math.cos(angle) * radius, py = cy + Math.sin(angle) * radius;
        step ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.stroke({ color: radar ? 0xffb35c : 0xcfe3a8, width, alpha: fade * (1 - ring * .25) });
    }
  }
}
