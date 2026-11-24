import { Mesh, MeshGeometry, Texture } from 'pixi.js';
import { metalColor, paintMetal } from './component-art.ts';
import { GROUND_SURFACES } from './ground-impact.ts';
import { clamp } from './math.ts';
import { TRACK_BELT, TRACK_GROUSER, TRACK_HORN, TRACK_SHOE_HALF_THICKNESS, TRACK_SIDE, TRACK_WHEEL, beltJoint, trackLinks } from './running-gear.ts';
import { canvas, pieceTexture, paintTrackSurface } from './textures.ts';
import { idlerCrank, paintTrackShoe, paintTrackSide, rollerBracket, TRACK_GROUSER_WIDTH, TRACK_HORN_WIDTH, TRACK_JOINT, TRACK_SHOE_COLORS } from './track-shoe-art.ts';
import { context2d } from './canvas-art.ts';
import type { Point } from './math.ts';
import type { Graphics } from 'pixi.js';
import type { MetalLook } from './vehicle-art-contract.ts';
import type { TrackSurfaces } from './textures.ts';
import type { BeltGeometry, trackGear } from './running-gear.ts';
export interface TrackDirtState { r: number; g: number; b: number; amount: number; time: number; tone: number }


// One small cached atlas for the horn, body, grouser and joint, with guard texels
// around each face. Motion only changes positions.
export function trackLinkTexture(look: MetalLook | null, surfaces: TrackSurfaces | null | undefined) {
  const c = canvas(128, 256), ctx = context2d(c),
    color = (value: string) => '#' + metalColor(parseInt(value.slice(1), 16), look).toString(16).padStart(6, '0'),
    colors = { steel: color(TRACK_SHOE_COLORS.steel), shade: color(TRACK_SHOE_COLORS.shade), light: color(TRACK_SHOE_COLORS.light),
      dark: color(TRACK_SHOE_COLORS.dark), deep: color(TRACK_SHOE_COLORS.deep), worn: color(TRACK_SHOE_COLORS.worn) };
  for (let part = 0; part < 4; part++) {
    ctx.save(); ctx.translate(4, part * 64 + 4); paintTrackShoe(ctx, 120, 56, part, colors); ctx.restore();
  }
  paintTrackSurface(ctx, surfaces, 'shoe');
  return pieceTexture(c);
}

// Corners stay in the track's own frame, also at the far end of a long world. Indices change only when its link count
// changes; motion moves the corners, and the material of each joint with the corners the belt cuts off it as it bends.
// The links go round the belt the running gear has where its wheels are (running-gear.ts `trackGear`), as many as
// `trackLinks` has round it (`count`), `pitch` apart round a sprocket of `teeth`. Each turns on a pin at either end, as
// the links of a real belt do: it runs straight from one to the next, and round a wheel the outside of two links opens
// over the pin they share, which the joint between them covers. So nothing shows between the links, and their bodies
// and joints make the edge of the belt (`outline`, two places over each pin, `half` of a link out from the line of the
// pins); the grousers stand out of it, as far as the edge pushed out by their height (`tread`).
// Each link is three quads, its horn, its body and its grouser, each on its row of the atlas, then its joint on the last.
// Its horn and its grouser are fine detail: drawn small (`fine` false), each is a point in the middle of its body.
const FACES = 3, JOINT = 6, row = (part: number): [number, number] => ([(part * 64 + 4.5) / 256, (part * 64 + 59.5) / 256] as const), [JOINT_TOP, JOINT_LOW] = row(FACES);
export class TrackLinks extends Mesh<MeshGeometry> {
  declare count: number; declare start: number | null; declare belt: BeltGeometry | null; declare fine: boolean | null;
  declare outline: Float64Array | null; declare tread: Float64Array | null; declare widthMetres?: number; declare heightMetres?: number;
  declare pitch?: number; declare teeth?: number; declare places?: Float64Array; declare ways?: Float64Array; declare joint?: Float64Array;
  declare topologyFine?: boolean;
  constructor(texture?: Texture) {
    const geometry = new MeshGeometry({ positions: new Float32Array(), uvs: new Float32Array(), indices: new Uint32Array() });
    geometry.indexBuffer.data = new Uint16Array();
    geometry.batchMode = 'no-batch';
    super({ geometry, texture: texture! }); this.count = 0; this.start = null; this.belt = null; this.fine = null; this.outline = null; this.tread = null;
  }
  configure(width: number, height: number) {
    if (this.widthMetres === width && this.heightMetres === height) return;
    this.widthMetres = width; this.heightMetres = height; this.start = null;
    const { count, pitch, teeth } = trackLinks(width, height);
    this.pitch = pitch; this.teeth = teeth;
    if (this.count === count) return;
    this.count = count; this.places = new Float64Array(count * 4); this.ways = new Float64Array(count * 2); this.joint = new Float64Array(18);
    this.layout(this.fine ?? true);
  }
  private layout(fine: boolean) {
    this.topologyFine = fine;
    const count = this.count, faces = fine ? FACES : 1,
      positions = new Float32Array(count * (faces * 4 + JOINT) * 2), uvs = new Float32Array(positions.length),
      indices = new Uint16Array(count * (faces * 6 + 12));
    for (let quad = 0; quad < count * faces; quad++) {
      const [top, low] = row(fine ? Math.floor(quad / count) : 1), vertex = quad * 4;
      uvs.set([4.5 / 128, top, 4.5 / 128, low, 123.5 / 128, low, 123.5 / 128, top], vertex * 2);
      indices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], quad * 6);
    }
    // A joint is a quad with its outer corners cut, its corners as running-gear.ts `beltJoint` has them.
    for (let i = 0, vertex = count * faces * 4; i < count; i++, vertex += JOINT) {
      uvs.set([4.5 / 128, JOINT_TOP, 123.5 / 128, JOINT_TOP, 123.5 / 128, JOINT_LOW, .5, JOINT_LOW, .5, JOINT_LOW, 4.5 / 128, JOINT_LOW], vertex * 2);
      indices.set([0, 1, 2, 0, 2, 5, 5, 2, 3, 5, 3, 4].map(k => vertex + k), count * faces * 6 + i * 12);
    }
    this.geometry.positions = positions; this.geometry.uvs = uvs; this.geometry.indexBuffer.data = indices;
  }
  // The links round `belt`, their pins from `start` along it back (running-gear.ts `linkStart`): link i from pin i + 1
  // to pin i, its body along it, its lit face inwards, its horn in from its middle and its grouser out from it, and the
  // joint over pin i. Whether they moved.
  update(start: number, belt: BeltGeometry, fine = true) {
    if (this.start === start && this.belt === belt && this.fine === fine || !this.count) return false;
    // Omit the collapsed horn/grouser quads at the existing coarse LOD. The
    // visible bodies and joints keep their exact vertices and material mapping.
    if (this.topologyFine !== fine) this.layout(fine);
    this.start = start; this.belt = belt; this.fine = fine;
    const { count, heightMetres, geometry } = this, faces = fine ? FACES : 1, height = heightMetres!, places = this.places!, ways = this.ways!, corners = this.joint!, positions = geometry.positions, uvs = geometry.uvs,
      step = belt.length / count, half = height * TRACK_SHOE_HALF_THICKNESS, joint = TRACK_JOINT * step / 2,
      // Half as high and half as wide as a horn and a grouser, and how far out the tips of the grousers stand.
      horn = fine ? TRACK_HORN * height / 2 : 0, hornWide = fine ? TRACK_HORN_WIDTH * step / 2 : 0,
      grouser = fine ? TRACK_GROUSER * height / 2 : 0, grouserWide = fine ? TRACK_GROUSER_WIDTH * step / 2 : 0,
      outline = this.outline = new Float64Array(count * 4), tread = this.tread = new Float64Array(count * 4);
    const quad = (at: number, ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
      positions[at] = ax + nx; positions[at + 1] = ay + ny;
      positions[at + 2] = ax - nx; positions[at + 3] = ay - ny;
      positions[at + 4] = bx - nx; positions[at + 5] = by - ny;
      positions[at + 6] = bx + nx; positions[at + 7] = by + ny;
    };
    belt.sample(count, start, belt.length / count, places);
    // The way each link runs, from the pin behind it to the one ahead.
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count, dx = places[i * 4]! - places[j * 4]!, dy = places[i * 4 + 1]! - places[j * 4 + 1]!, length = Math.hypot(dx, dy) || 1;
      ways[i * 2] = dx / length; ways[i * 2 + 1] = dy / length;
    }
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count, k = (i + count - 1) % count, ax = places[j * 4]!, ay = places[j * 4 + 1]!, bx = places[i * 4]!, by = places[i * 4 + 1]!,
        c = ways[i * 2]!, s = ways[i * 2 + 1]!, kc = ways[k * 2]!, ks = ways[k * 2 + 1]!, mx = (ax + bx) / 2, my = (ay + by) / 2,
        hx = mx - s * (half + horn), hy = my + c * (half + horn), gx = mx + s * (half + grouser), gy = my - c * (half + grouser);
      if (fine) quad(i * 8, hx - c * hornWide, hy - s * hornWide, hx + c * hornWide, hy + s * hornWide, -s * horn, c * horn);
      quad(((fine ? count : 0) + i) * 8, ax, ay, bx, by, -s * half, c * half);
      if (fine) quad((count * 2 + i) * 8, gx - c * grouserWide, gy - s * grouserWide, gx + c * grouserWide, gy + s * grouserWide, -s * grouser, c * grouser);
      // The joint over pin i and the edge of the belt there (running-gear.ts `beltJoint`), its picture cut with it, and
      // that edge pushed out along the way between the two links as far as the tips of their grousers stand out of
      // their outer faces (half the bend between them off the way of each).
      const at = (count * faces * 4 + i * JOINT) * 2, ox = s + ks, oy = -c - kc, out = 4 * grouser / (ox * ox + oy * oy || 1);
      beltJoint(bx, by, c, s, kc, ks, half, joint, corners);
      positions.set(corners.subarray(0, 12), at); outline.set(corners.subarray(12, 16), i * 4);
      for (let n = 0; n < 4; n += 2) { tread[i * 4 + n] = corners[12 + n]! + ox * out; tread[i * 4 + n + 1] = corners[13 + n]! + oy * out; }
      uvs[at + 5] = uvs[at + 11] = JOINT_TOP + (JOINT_LOW - JOINT_TOP) * (1 + corners[17]!) / 2;
      uvs[at + 6] = .5 + 119 / 256 * corners[16]!; uvs[at + 8] = .5 - 119 / 256 * corners[16]!;
    }
    geometry.getBuffer('aPosition').update(); geometry.getBuffer('aUV').update();
    return true;
  }
  destroy(options?: Parameters<Mesh['destroy']>[0]) {
    if (this.destroyed) return;
    const geometry = this.geometry;
    super.destroy(options); geometry.destroy(true);
  }
}

// What stands still over the wheels and the links of a track, its shade (gear-art.ts, `overlay`) or its dirt
// (`trackDirtTexture`): its picture laid over the outline of the belt as it is drawn (`update`, x and y one after
// another, in the frame of the track), each place of it as the picture has it at that height over the middle of the
// track. It is laid in strips, one from each
// side of the outline straight up or down to the line between the places of the belt furthest back and furthest ahead:
// along each run, from one end of the belt to the other, the belt goes on the one way, so each place within it is under
// one strip, however its wheels have it bend, round the sprocket outside with a road wheel pressed up over it too.
export class TrackShade extends Mesh<MeshGeometry> {
  declare outline: Float64Array | null; declare heightMetres?: number;
  constructor() {
    const geometry = new MeshGeometry({ positions: new Float32Array(), uvs: new Float32Array(), indices: new Uint32Array() });
    geometry.indexBuffer.data = new Uint16Array();
    geometry.batchMode = 'no-batch';
    super({ geometry, texture: Texture.EMPTY }); this.outline = null;
  }
  update(outline: Float64Array, height: number) {
    if (this.outline === outline && this.heightMetres === height) return;
    this.outline = outline; this.heightMetres = height;
    const geometry = this.geometry, count = outline.length / 2;
    if (geometry.positions.length !== count * 4) {
      // Each place of the outline (i), and under or over it its foot on the line between the ends (count + i).
      const indices = new Uint16Array(count * 6);
      for (let i = 0; i < count; i++) { const j = (i + 1) % count; indices.set([i, j, count + j, i, count + j, count + i], i * 6); }
      geometry.positions = new Float32Array(count * 4); geometry.uvs = new Float32Array(count * 4); geometry.indexBuffer.data = indices;
    }
    let back = 0, ahead = 0;
    for (let i = 1; i < count; i++) { if (outline[i * 2]! < outline[back * 2]!) back = i; if (outline[i * 2]! > outline[ahead * 2]!) ahead = i; }
    const positions = geometry.positions, uvs = geometry.uvs, x0 = outline[back * 2]!, y0 = outline[back * 2 + 1]!,
      slope = (outline[ahead * 2 + 1]! - y0) / (outline[ahead * 2]! - x0);
    for (let i = 0; i < count; i++) {
      const x = outline[i * 2]!, y = outline[i * 2 + 1]!, foot = y0 + (x - x0) * slope, at = (count + i) * 2;
      positions[i * 2] = positions[at] = x; positions[i * 2 + 1] = y; positions[at + 1] = foot;
      uvs[i * 2] = uvs[at] = .5; uvs[i * 2 + 1] = .5 - y / height; uvs[at + 1] = .5 - foot / height;
    }
    geometry.getBuffer('aPosition').update(); geometry.getBuffer('aUV').update();
  }
  destroy(options?: Parameters<Mesh['destroy']>[0]) {
    if (this.destroyed) return;
    const geometry = this.geometry;
    super.destroy(options); geometry.destroy(true);
  }
}

// The dirt of the ground a track runs on, as it lies over it (`TrackShade`), white for its tone to be its tint: on its
// lower run and on the lower half of its wheels, thickest along the ground, none from the middles of its road wheels up
// (`1 - TRACK_WHEEL` down it, running-gear.ts `trackWheels`).
export function trackDirtTexture() {
  const c = canvas(4, 64), ctx = context2d(c), fall = ctx.createLinearGradient(0, 0, 0, 64), middle = 1 - TRACK_WHEEL;
  for (const [at, alpha] of [([0, 0] as const), ([middle, 0] as const), ([middle + (1 - middle) * .45, .3] as const), ([middle + (1 - middle) * .8, .75] as const), ([1, 1] as const)])
    fall.addColorStop(at, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = fall; ctx.fillRect(0, 0, 4, 64);
  return pieceTexture(c);
}
// How dirty a track is of the ground it runs on (`surface`, terrain.ts `groundAt`) at `now`, in seconds (`soil`, kept
// from one frame to the next): of the tone of its dust (ground-impact.ts `GROUND_SURFACES`), as much as `TRACK_DIRT` of
// it, half that off hard ground. From one ground to another its tone and its amount go over in about `DIRT_TURN`
// seconds, never at once.
export const TRACK_DIRT = .42, DIRT_TURN = 1.2;
const HARD_GROUND = new Set(['concrete', 'asphalt', 'rock']);
export function trackDirt(soil: TrackDirtState | null | undefined, surface: string, now: number): TrackDirtState {
  const surfaces: Partial<Record<string, { dust: number }>> = GROUND_SURFACES;
  const { dust } = surfaces[surface] ?? GROUND_SURFACES.soil, amount = TRACK_DIRT * (HARD_GROUND.has(surface) ? .5 : 1),
    r = dust >> 16 & 255, g = dust >> 8 & 255, b = dust & 255;
  if (!soil) return { r, g, b, amount, time: now, tone: dust };
  const k = 1 - Math.exp(-clamp(now - soil.time, 0, .25) / DIRT_TURN);
  soil.r += (r - soil.r) * k; soil.g += (g - soil.g) * k; soil.b += (b - soil.b) * k; soil.amount += (amount - soil.amount) * k; soil.time = now;
  soil.tone = Math.round(soil.r) << 16 | Math.round(soil.g) << 8 | Math.round(soil.b);
  return soil;
}

// The picture of the side of the hull behind the wheels of a track `height` high (running-gear.ts `TRACK_SIDE`), `width`
// long, its grain as fine as on the rest of the track.
export function trackSideTexture(look: MetalLook | null, surfaces: TrackSurfaces | null | undefined, width: number, height: number) {
  const { top, bottom } = TRACK_SIDE, c = canvas(Math.max(8, Math.ceil(width * 200)), Math.max(8, Math.ceil((top - bottom) * height * 200))),
    ctx = context2d(c), tall = c.height / (top - bottom);
  paintTrackSide(ctx, 0, c.width, v => (top - v) * tall);
  paintTrackSurface(ctx, surfaces, 'track', width, (top - bottom) * height);
  paintMetal(ctx, look);
  return pieceTexture(c);
}

// What of a track stands behind its links, where its running gear has it (running-gear.ts `trackGear`), in the tones of
// `look`, over the side of the hull: from afar, where its links are not drawn (`casing`), the belt itself as a band as
// wide as they are; the bracket of each roller, the arm of each road wheel from its boss on the side of the hull to
// the middle of the wheel, and the crank of the idler and the screw that holds it (track-shoe-art.ts `idlerCrank`).
// Within the belt, between them, what is behind the track shows.
export function drawTrackFrame(frame: Graphics, gear: ReturnType<typeof trackGear>, look: MetalLook | null, height: number, casing: boolean) {
  frame.clear();
  if (casing) frame.poly(gear.belt.outline()).stroke({ color: metalColor(0x3a4236, look), width: TRACK_BELT * height, join: 'round' });
  const flat = (points: readonly Point[]) => points.flatMap(p => ([p.x, p.y] as const)), round = (x: number, y: number, r: number) => {
    const points = [];
    for (let i = 0; i < 24; i++) { const a = i * Math.PI / 12; points.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    return frame.poly(points);
  };
  for (const roller of gear.rollers) {
    const { stem, flange, bolts } = rollerBracket(roller), edge = { color: metalColor(0x111c17, look), width: roller.radius * .06 };
    frame.poly(flat(flange)).fill(metalColor(0x2b3a2a, look)).stroke(edge);
    frame.poly(flat(stem)).fill(metalColor(0x33412f, look)).stroke(edge);
    for (const bolt of bolts) round(bolt.x, bolt.y, bolt.r).fill(metalColor(0xbcc3a8, look)).stroke({ color: metalColor(0x24352a, look), width: bolt.r * .4 });
  }
  const boss = height * .05 / .74;
  for (const { x, y, pivot } of gear.road) {
    round(pivot.x, pivot.y, boss).fill(metalColor(0x33412f, look)).stroke({ color: metalColor(0x111c17, look), width: boss * .12 });
    round(pivot.x, pivot.y, boss * .5).fill(metalColor(0x5f6e56, look));
    frame.moveTo(pivot.x, pivot.y).lineTo(x, y).stroke({ color: metalColor(0x17271d, look), width: .045 });
    frame.moveTo(pivot.x, pivot.y + .008).lineTo(x, y + .008).stroke({ color: metalColor(0x8b957b, look), width: .016, alpha: .8 });
  }
  const crank = idlerCrank(gear.crank, gear.idler, height), edge = { color: metalColor(0x111c17, look), width: height * .006 };
  frame.poly(flat(crank.sleeve)).fill(metalColor(0x2b3a2a, look)).stroke(edge);
  frame.poly(flat(crank.rod)).fill(metalColor(0x9aa38b, look)).stroke(edge);
  round(crank.bracket.x, crank.bracket.y, crank.bracket.r).fill(metalColor(0x33412f, look)).stroke(edge);
  frame.poly(flat(crank.arm)).fill(metalColor(0x33412f, look)).stroke(edge);
  round(crank.eye.x, crank.eye.y, crank.eye.r).fill(metalColor(0x5f6e56, look)).stroke(edge);
  round(crank.boss.x, crank.boss.y, crank.boss.r).fill(metalColor(0x33412f, look)).stroke(edge);
  round(crank.pin.x, crank.pin.y, crank.pin.r).fill(metalColor(0xbcc3a8, look));
}
