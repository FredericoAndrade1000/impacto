import type { Point } from './math.ts';
import type { EffectCamera, EffectView } from './effect-types.ts';
import type { SceneEye } from './scene-contract.ts';
import type { DrawingActor } from './scene-drawing-contract.ts';
import type { GroundSight, ViewSight, SightGround, SightFog, Spans, SightEye } from './ground-sight.ts';
interface FogFaction { id: string; base?: (Point & { radius: number }) | null | undefined; posts?: readonly { id: string; x: number; sight: number; eye: number }[] | undefined; explored?: Spans | null | undefined }
export interface FogState { faction?: FogFaction | null | undefined; actors: readonly DrawingActor[]; sharedEyes?: readonly SceneEye[] | undefined }
export interface FieldFog extends SightFog { explored: Spans }
export interface MistBand { from: number; to: number; a: number; b: number }
interface MistStand { at: number; up: number; over: number }
interface Wisp { mesh: Mesh<MeshGeometry, Shader>; round: number; high: number; speed: number; depth: number; long: number; tall: number; sway: number; strength: number; flip: number }
interface Shade { columns: number; rows: number; data: Uint8Array; cover: Float32Array; spare: Float32Array; previous: Float32Array; sighted: Float32Array; laid: { ground: SightGround | null; cell: number; first: number; bottom: number } | null; any: boolean; texture: Texture }
import { Container, GlProgram, Mesh, MeshGeometry, Shader, Sprite, Texture } from 'pixi.js';
import { Random, clamp, smoothstep } from './math.ts';
import { ShotQuads } from './shot-quads.ts';
import { bufferTexture, mistTones } from './landscape-art.ts';
import { merged, unite, clip, apart } from './ground-sight.ts';
import { BASE_MARGIN, LOW_AIR, MIST_HEIGHT, MIST_FADE } from './battle-rules.ts';
export { BASE_MARGIN, LOW_AIR, MIST_HEIGHT, MIST_FADE };

// On a field with fog the ground is in one of three states to the faction that looks at it. What its
// constructions see now is clear. What they do not see now lies under a haze that dims it: a shade, darker than
// the day, over all they do not see — the ground, the earth under it and the air over it, as their eyes see: what
// a crest hides from them and what lies past their reach (`ViewSight`, ground-sight.ts). The sky they see is the
// sky. What the faction never saw lies under a bank of mist as well, closed over the ground and over whatever
// stands on it. The bank lies on the land: it thins out high above the ground, and it goes down through the earth,
// past the foot of the view: it has no foot to be seen. The haze ends softly where the sight does, and the line of
// the ground that is known shows through it. The bank follows the ground only at its edge. Within, it hides how the ground lies as well: it stands over the highest
// ground about, so that its top does not draw the relief, and the earth under ground never seen tells no more than
// the ground does. Neither has an edge to be seen either: each comes on over a stretch of ground, and from afar
// over no fewer pixels than a soft edge takes. A mark the page puts on such ground stands in the bank, as high
// as the bank lets go of the ground there (`lift`), and the hills behind are those of the ground that is known.
// The hiding is of the screen alone: the page grows the whole ground from its seed, and hides what stands on the
// ground the field says the faction has not seen.
//
// The haze comes on over this many cells of the sight (`SIGHT_CELL` pixels each) to each side of where the sight ends.
export const VEIL_SOFT = 2;
// How much of its shade it lays over what it covers.
export const VEIL_STRENGTH = .5;
// Over ground that is known and out of sight what flies lower than this many metres is hidden with the ground:
// what is told of it higher — the rounds a radar follows — is drawn in the air out of sight, under the haze
// (`LOW_AIR`, battle-rules.ts: the server tells a faction its own shells by the same sky).
// The bank closes over this many metres from ground that is known, on the ground never seen: what is known is
// clear of it.
export const MIST_EDGE = 60;
// Well within ground never seen it is whole to this many metres over the ground and gone this many metres higher
// (`MIST_HEIGHT`, `MIST_FADE`, battle-rules.ts).
// A bank is low at its edge and deep within: it has all of its height this far from the ground that is known. A
// stretch never seen that is narrower than tall would else stand as a column, and a relief of crests is full of them.
export const MIST_DEEP = 300;
// Where the bank is closed it no longer follows the ground: it stands over the highest ground within this many
// metres to each side of a place.
export const MIST_SPAN = 120;
// From afar a bank some metres deep would be thinner than a pixel. It is whole to no less than this many
// pixels over the ground, and gone no less than this many higher.
export const MIST_PIXELS = [12, 44] as const;
// And an edge some metres wide would be a line: the bank comes on over no fewer than this many pixels.
export const MIST_EDGE_PIXELS = 190;
// How wide the edge of the bank is on a view at a zoom, in metres.
export const mistEdge = (zoom: number) => Math.max(MIST_EDGE, MIST_EDGE_PIXELS / zoom);
// Where the bank comes on it rises too: from this share of its height at its edge to all of it.
export const EDGE_RISE = .2;
// The bank follows the ground by stretches of this many pixels, and of no less than this many metres: the outline
// of the ground has a point every so many, and is straight between two of them.
export const STRIDE = 12, STEP = 4;
// The top of the bank is no line: it swells and sinks by this share of its height along the ground, and drifts
// with the time of the field. From afar, where a stretch is as long as a swell, it lies still.
export const SWELL = .3;
const STILL = 160, SWELLING = 40;
const billow = (x: number, time: number) => .5 * Math.sin(x / 97 + time * .021) + .3 * Math.sin(x / 41 - time * .034 + 1.7) + .2 * Math.sin(x / 233 + .6);
// A construction of another faction that is seen is seen where it stands, and so is a wreck of the faction's own while
// it burns; and a ghost stands on ground that is known: this much ground to each side of it, whatever the eyes of the
// faction make of the ground itself there, and the air this far about it. One told in flight higher over the ground
// than this has no ground about it: only the air.
export const MET_REACH = 16;

// What the page has of the ground on a frame of a field with fog (`faction.explored` is told): the ground in
// sight now and the ground known. In sight is what the eyes of the faction's standing constructions see
// (`sight`, a GroundSight on the ground of the page), each where the frame shows its construction between two
// states (`pose`), and the eye of each of its posts, with the base of the faction and the ground under whatever of another faction is seen. A wreck of
// its own sees nothing, but while the core says it burns its fire is seen, as one of another is, wherever no eye of
// the faction is: the ground under it is in sight, and the air over it, until the fire is out. Known
// is what the field told as explored, what is in sight, and the ground under each ghost. And what the faction sees
// the air with (`ViewSight`): its eyes as they stood, each with its sweep (`eyes`, the GroundSight's `looking`),
// and a circle of air over its base and about each of the others it sees (`domes`: of each its middle and how far
// about, as far as the ground it puts in sight).
export function fieldFog(sight: GroundSight, state: FogState, pose: (id: string) => Point | null | undefined = () => null): FieldFog | null {
  const faction = state.faction;
  if (!faction?.explored) return null;
  const own: { id: string; eyes: readonly SightEye[] }[] = [], lit: [number, number][] = [], met: [number, number][] = [], domes: (Point & { reach: number })[] = [];
  for (const actor of state.actors) {
    const told = actor.vehicle || actor, shown = pose(actor.id), toldX = Number(told.x), toldY = Number(told.y), dx = shown ? shown.x - toldX : 0, dy = shown ? shown.y - toldY : 0, x = toldX + dx, y = toldY + dy;
    if (actor.team !== faction.id || actor.burning === true) {
      if (!(actor.vehicle?.flying && y - sight.ground!.height(x) > MET_REACH)) (actor.ghost ? met : lit).push([x - MET_REACH, x + MET_REACH]);
      if (!actor.ghost) domes.push({ x, y, reach: MET_REACH });
    }
    if (actor.team === faction.id && !actor.defeated) own.push({ id: actor.id, eyes: (actor.eyes || []).map(eye => ({ x: eye.x + dx, y: eye.y + dy, left: eye.left, right: eye.right })) });
  }
  const base = faction.base;
  // Each post of the faction sees from the top of its mast as the field has it see (server/room.ts `postSight`): `eye` metres
  // over the ground where it stands, `sight` metres to each side.
  for (const post of faction.posts ?? []) own.push({ id: 'post:' + post.id, eyes: [{ x: post.x, y: sight.ground!.height(post.x) + post.eye, left: post.sight, right: post.sight }] });
  if (state.sharedEyes?.length) own.push({ id: 'alliance-optics', eyes: state.sharedEyes });
  if (base) {
    lit.push([base.x - base.radius - BASE_MARGIN, base.x + base.radius + BASE_MARGIN]);
    domes.push({ x: base.x, y: base.y, reach: base.radius + BASE_MARGIN });
  }
  const seen = unite(sight.seen(own), merged(lit));
  return { seen, explored: unite(unite(faction.explored, seen), merged(met)), eyes: sight.looking, domes };
}

// The bank over the stretch of field a view shows (`left` to `right`): over all the ground that is not `known`
// (explored or in sight), as a list of bands from the left, none over another. A band runs `from` one place `to`
// another and stands at `a` of its full strength at the first and at `b` at the second, along a ramp that eases in
// and out between them (`rampLevel`). Where it has no band the ground is clear of it. It comes on over `edge`
// metres (`mistEdge`) from each end of the ground it lies on, and where the two come to meet before either is whole
// they meet in the middle: a fold of the ground that no eye caught, some metres wide, has next to nothing over it.
// The edges are of the ground and not of where the view stands: what lies more than a whole edge past either end of
// the view has no part in them.
export function mistBands(view: Pick<EffectView, 'left' | 'right'>, known: Spans, edge = MIST_EDGE): MistBand[] {
  const first = view.left - edge, last = view.right + edge, bands: MistBand[] = [];
  const band = (from: number, to: number, a: number, b: number) => {
    const left = Math.max(from, view.left), right = Math.min(to, view.right), at = (x: number) => a + (b - a) * (x - from) / (to - from);
    if (right > left) bands.push({ from: left, to: right, a: at(left), b: at(right) });
  };
  const lay = (from: number, to: number, before: boolean, after: boolean) => {
    const wide = to - from, ramps = (Number(before) + Number(after)) * edge, top = ramps > wide ? wide / ramps : 1, rise = Number(before) * edge * top, fall = Number(after) * edge * top;
    if (!(wide > 0)) return;
    band(from, from + rise, 0, top); band(from + rise, to - fall, top, top); band(to - fall, to, top, 0);
  };
  let under = first, edged = false;
  for (const [from, to] of clip(known, first, last)) { lay(under, from, edged, true); under = to; edged = true; }
  lay(under, last, edged, false);
  return bands;
}
// The place of the ground that is known nearest to a place: the place itself where its ground is known, and
// where nothing is known yet.
export function nearestKnown(known: Spans, x: number) {
  let best = x, least = Infinity;
  for (const [from, to] of known) {
    if (x >= from && x <= to) return x;
    const near = x < from ? from : to, far = Math.abs(near - x);
    if (far < least) { least = far; best = near; }
  }
  return best;
}
// How much of a full strength a band shows where it stands at `level` of its ramp.
export const rampLevel = (level: number) => smoothstep(level);
// How much of its height the bank has where it stands at `level` of its way up.
export const riseLevel = (level: number) => EDGE_RISE + (1 - EDGE_RISE) * rampLevel(level);
// How closed the bank is over a whole stretch of the view, or at one place of it: the least of it there, and not
// at all where some of the stretch is clear.
export function mistOver(mist: readonly MistBand[], from: number, to: number) {
  let least = 1, covered = null;
  for (const band of mist) {
    if (band.to < from) continue;
    if (band.from > to || band.from > (covered ?? from) + 1e-9) break;
    const at = (x: number) => band.a + (band.b - band.a) * (x - band.from) / (band.to - band.from);
    least = Math.min(least, at(Math.max(from, band.from)), at(Math.min(to, band.to))); covered = band.to;
  }
  return covered === null || covered < to - 1e-9 ? 0 : rampLevel(least);
}

// The texture of the bank. Across, it goes from nothing to whole along the ramp; down, from nothing in its first
// row to whole in its last. It is white: what draws with it gives it the tone of the weather.
const RAMP = 64, ROWS = 32;
function layerTones() {
  const data = new Uint8Array(RAMP * ROWS * 4);
  for (let row = 0; row < ROWS; row++) for (let column = 0; column < RAMP; column++)
    data.set([255, 255, 255, Math.round(255 * smoothstep(column / (RAMP - 1)) * smoothstep(row / (ROWS - 1)))], (row * RAMP + column) * 4);
  return data;
}
const rampU = (level: number) => (.5 + clamp(level, 0, 1) * (RAMP - 1)) / RAMP, LOW = 1 - .5 / ROWS, HIGH = .5 / ROWS;
// The bands of the bank laid on the ground (`ground.height`) as quads (`quads`, a ShotQuads): by stretches of
// `stride` metres, the same ones wherever the view stands, each a quad from its foot to where the layer is
// whole, one above it in which it thins out to nothing, and one under its foot in which it comes on. `tall`
// tells, of a place and of where its band stands there, how many metres over the ground the layer is whole and how
// many more it takes to be gone; `under`, how many metres under the line of the ground its foot is and how many
// more below that it comes on over. A layer told nothing of that has its foot on the ground and nothing under it.
export function layMist(quads: ShotQuads, bands: readonly MistBand[], ground: SightGround, { stride, tall, under = null }: { stride: number; tall(x: number, level: number): readonly [number, number]; under?: ((x: number, level: number) => readonly [number, number]) | null }) {
  const origin = Number.isFinite(ground.minX) ? ground.minX! : 0;
  for (const { from, to, a, b } of bands) {
    const edge = (x: number) => {
      const level = a + (b - a) * (x - from) / (to - from), [whole, fade] = tall(x, level), [sunk, soft] = under ? under(x, level) : [0, 0],
        line = ground!.height(x), base = line - sunk, low = line + whole;
      return { u: rampU(level), foot: base - soft, base, low, high: low + fade };
    };
    for (let x = from, near = edge(x); x < to;) {
      const next = Math.min(to, origin + (Math.floor((x - origin) / stride + 1e-6) + 1) * stride), far = edge(next);
      if (under) quads.quad(x, near.foot, x, near.base, next, far.foot, next, far.base, near.u, HIGH, far.u, LOW);
      quads.quad(x, near.base, x, near.low, next, far.base, next, far.low, near.u, LOW, far.u, LOW);
      quads.quad(x, near.low, x, near.high, next, far.low, next, far.high, near.u, LOW, far.u, HIGH);
      x = next; near = far;
    }
  }
}

// A wisp: a long soft shape of a few lobes, gone to nothing well before any of its edges.
const WISP_WIDTH = 128, WISP_HEIGHT = 64;
function wispTones() {
  const data = new Uint8Array(WISP_WIDTH * WISP_HEIGHT * 4), random = new Random(0x3157),
    lobes = Array.from({ length: 5 }, (_, i) => ({ x: (i + .5) / 5 + random.range(-.06, .06), y: .5 + random.range(-.13, .13),
      wide: random.range(.15, .25), tall: random.range(.16, .28), strength: random.range(.45, 1) }));
  for (let row = 0; row < WISP_HEIGHT; row++) for (let column = 0; column < WISP_WIDTH; column++) {
    const u = (column + .5) / WISP_WIDTH, v = (row + .5) / WISP_HEIGHT,
      body = lobes.reduce((sum, lobe) => sum + lobe.strength * Math.exp(-(((u - lobe.x) / lobe.wide) ** 2) - ((v - lobe.y) / lobe.tall) ** 2), 0),
      edge = smoothstep(Math.min(u, 1 - u) / .22) * smoothstep(Math.min(v, 1 - v) / .3);
    data.set([255, 255, 255, Math.round(255 * clamp(body * .7, 0, 1) * edge)], (row * WISP_WIDTH + column) * 4);
  }
  return data;
}
// The wisps are a few quads of that one shape, paler than the bank and in it: about its top, where they break
// its line, and in its body. Each is some hundreds of pixels long where the bank is deep on the screen, and no
// taller than this share of the bank where it is not. They drift slowly with the time of the field, and as the
// camera goes along the ground they go a share of what the ground goes: the bank is deep. One that leaves the
// screen at an end comes back at the other.
const WISPS = 9, WISP_SHARE = .6;
// How much of the length of a wisp, about its middle, must lie in closed mist for it to show whole.
const WISP_BODY = .42;
// A wisp is only a few steps of the eight bits of the screen paler than the bank, over hundreds of pixels: drawn
// plainly, every step is a ring round its middle, and the rings of wisps drifting over one another shimmer in the sky
// like moire. Its shader adds to every pixel less than a step of a grain that stays with the screen, before the screen
// rounds it: the rings break up into a grain no eye tells, and the wisp is as soft as its texture.
const WISP_VERTEX = `
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec4 uColor;
out vec2 vUV;
out vec4 vColor;
void main() {
    vec3 position = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
    gl_Position = vec4(position.xy, 0.0, 1.0);
    vUV = aUV;
    vColor = uColor * uWorldColorAlpha;
}`;
export const WISP_FRAGMENT = `
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTexture;
out vec4 finalColor;
void main() {
    vec4 colour = texture(uTexture, vUV) * vColor;
    // Interleaved gradient noise: another fraction at each pixel, the same one there on every frame. Half a step
    // either way, and none where the wisp is not, so that it darkens nothing about it.
    float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
    finalColor = vec4(colour.rgb + grain / 255.0 * min(1.0, colour.a * 255.0), colour.a);
}`;
// The quad of a wisp: its texture a pixel a unit, about its middle.
function wispGeometry() {
  const x = WISP_WIDTH / 2, y = WISP_HEIGHT / 2;
  return new MeshGeometry({ positions: new Float32Array([-x, -y, x, -y, x, y, -x, y]), uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
}

// Whether two masks of as many cells are the same, cell for cell.
function same(a: ArrayLike<number>, b: ArrayLike<number>) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// The haze over the cells of the sight (`ViewSight`) that are out of it, softened over `VEIL_SOFT` of them to each
// side (`cover`, of each cell from the lowest row, 1 out of sight and 0 in it; `spare`, as many cells to work in):
// how much of the haze stands over each cell, eased in and out like a band of the bank.
// A cell whose neighbours all lie within the mask adds them up as they lie, in the same order as one at an edge does
// with its neighbours clamped to the edge: the same sums, without the clamping of every neighbour of every cell. A row of
// one value all along (the sky in sight, the earth deep under the veil) softens to one value all along, worked out once
// with the very same sum; and so do the rows about which every row is that one value.
export function softCover<Buffer extends Float32Array | Float64Array | number[]>(cover: Buffer, spare: Float32Array | Float64Array | number[], columns: number, rows: number, soft = VEIL_SOFT): Buffer {
  const wide = 2 * soft + 1, sum = (value: number) => { let total = 0; for (let k = -soft; k <= soft; k++) total += value; return total / wide; },
    level = new Float64Array(rows);
  for (let row = 0; row < rows; row++) {
    const start = row * columns, first = cover[start]!;
    let even = true;
    for (let at = start + 1, end = start + columns; at < end && even; at++) even = cover[at]! === first;
    level[row] = even ? first : NaN;
    if (even) { spare.fill(sum(first), start, start + columns); continue; }
    for (let column = 0; column < columns; column++) {
      let total = 0;
      if (column >= soft && column < columns - soft) for (let at = start + column - soft, end = start + column + soft; at <= end; at++) total += cover[at]!;
      else for (let k = -soft; k <= soft; k++) total += cover[start + Math.min(columns - 1, Math.max(0, column + k))]!;
      spare[start + column] = total / wide;
    }
  }
  for (let row = 0; row < rows; row++) {
    const inner = row >= soft && row < rows - soft, value = level[row]!;
    let even = value === value;
    for (let k = -soft; k <= soft && even; k++) even = level[Math.min(rows - 1, Math.max(0, row + k))]! === value;
    if (even) { cover.fill(rampLevel(sum(spare[row * columns]!)), row * columns, (row + 1) * columns); continue; }
    for (let column = 0; column < columns; column++) {
      let total = 0;
      if (inner) for (let at = (row - soft) * columns + column, end = (row + soft) * columns + column; at <= end; at += columns) total += spare[at]!;
      else for (let k = -soft; k <= soft; k++) total += spare[Math.min(rows - 1, Math.max(0, row + k)) * columns + column]!;
      cover[row * columns + column] = rampLevel(total / wide);
    }
  }
  return cover;
}

// The haze, the bank and its wisps over the world of a renderer. Everything is made once, with the first frame
// of a field with fog — the texture of the haze again when the screen takes another number of cells: a field
// without fog, a test and the bench make nothing and draw nothing. A frame writes the haze over the cells of its
// sight, the corners of the stretches of the bank the view shows, and places the wisps. The bank is counted from the
// camera of the frame.
export class GroundMist {
  declare root: Container; declare veil: Sprite; declare mist: ShotQuads; declare wisps: Wisp[]; declare bands: MistBand[] | null; declare weather: string | null; declare look: ReturnType<typeof mistTones> | null;
  declare shade: Shade | null; declare shown: { time: number; x: number } | null; declare stand: ((at: number) => MistStand) | null; declare tones?: Texture; declare shape?: Texture; declare wispQuad?: MeshGeometry; declare wispShader?: Shader;
  constructor() {
    this.root = new Container(); this.root.label = 'mist'; this.root.visible = false;
    this.veil = new Sprite(Texture.EMPTY); this.mist = new ShotQuads(1024); this.wisps = []; this.bands = null; this.weather = null; this.look = null;
    this.shade = null; // the texture of the haze, and what it is written from
    this.shown = null; // the time and the place of the camera of the last frame drawn
    this.stand = null; // how the bank of the last frame stands at a place
  }
  // How far over the ground a mark of the page stands at a place: nothing on ground that is known, and under the
  // bank as high as the bank lets go of the ground there, so that the mark tells no more of the relief than the bank does.
  lift(at: number) { return this.stand ? this.stand(at).over : 0; }
  prepare() {
    if (this.tones) return;
    this.tones = bufferTexture(layerTones(), RAMP, ROWS); this.shape = bufferTexture(wispTones(), WISP_WIDTH, WISP_HEIGHT);
    this.root.addChild(this.veil, this.mist.attach(this.tones));
    this.wispQuad = wispGeometry();
    this.wispShader = new Shader({ glProgram: GlProgram.from({ name: 'mist-wisp', vertex: WISP_VERTEX, fragment: WISP_FRAGMENT }),
      resources: { uTexture: this.shape.source } });
    const random = new Random(0x715);
    for (let i = 0; i < WISPS; i++) {
      const mesh = this.root.addChild(new Mesh({ geometry: this.wispQuad, shader: this.wispShader, texture: this.shape }));
      // Where it is across the screen (`round`, a share of its lap: the screen and its own length), how high in the
      // bank, how fast it drifts in pixels a second, and the share of the ground's way it goes with the camera.
      this.wisps.push({ mesh, round: (i + random.range(0, .8)) / WISPS, high: (i * 4 % WISPS + random.range(.1, .9)) / WISPS, speed: random.range(5, 16),
        depth: random.range(.3, .75), long: random.range(520, 1100), tall: random.range(130, 300), sway: random.range(0, 6.28),
        strength: random.range(.08, .17), flip: random.next() < .5 ? -1 : 1 });
    }
  }
  // `fog` is the ground in sight and the ground known (`fieldFog`), or nothing where there is no fog, and `sight`
  // what the faction sees over the view (a ViewSight of the frame). `time` is that of the field, which carries the
  // wisps and the swell of the bank, and `ground` the ground the bank lies on.
  update(camera: EffectCamera, fog: FieldFog | null | undefined, time = 0, weather = 'clear', ground: SightGround | null = null, sight: ViewSight | null = null) {
    this.root.visible = Boolean(fog); this.bands = null; this.stand = null;
    if (!fog) return;
    this.prepare();
    if (weather !== this.weather) { this.weather = weather; this.look = mistTones(weather); }
    this.hazeOver(sight, ground);
    // A little past each edge of the screen, so that no edge of it shows a seam.
    const { x, y, zoom, width } = camera, wide = width / zoom / 2 + 2 / zoom, known = unite(fog.explored, fog.seen),
      view = { left: x - wide, right: x + wide }, edge = mistEdge(zoom), bands = this.bands = mistBands(view, known, edge),
      stride = Math.max(STEP, STRIDE / zoom), calm = SWELL * clamp((STILL - stride) / (STILL - SWELLING), 0, 1),
      bank = { whole: Math.max(MIST_HEIGHT, MIST_PIXELS[0] / zoom), fade: Math.max(MIST_FADE, MIST_PIXELS[1] / zoom) };
    // It goes down from the ground past the foot of the view, a little under it.
    const floor = y - (camera.height / 2 + 4) / zoom, under = (at: number): [number, number] => [Math.max(0, ground!.height(at) - floor), 2 / zoom];
    // The bank is as high as the ground under it is far from ground that is known, and as it closes it lets go of
    // the ground (`closed`, from none at its edge to all where it is whole): its top goes up to the highest ground
    // about (`about`). The ground is read at places that stand still as the view goes along it, a few to each
    // side, each of them once in a frame.
    const reach = Math.max(stride, MIST_SPAN / 6), heights = new Map<number, number>(),
      height = (place: number) => { let found = heights.get(place); if (found === undefined) heights.set(place, found = ground!.height(place * reach)); return found; },
      about = (at: number) => {
        const middle = Math.round(at / reach), sides = Math.ceil(MIST_SPAN / reach), own = ground!.height(at);
        let high = own;
        for (let place = middle - sides; place <= middle + sides; place++) high = Math.max(high, height(place));
        return high - own;
      };
    let stood: MistStand | null = null;
    const stand = (at: number): MistStand => {
      if (stood?.at === at) return stood;
      const far = apart(known, at), closed = rampLevel(far / edge);
      return stood = { at, up: riseLevel(far / MIST_DEEP) * (calm ? 1 + calm * billow(at, time) : 1), over: closed ? closed * about(at) : 0 };
    };
    this.stand = stand;
    this.mist.clear(x, y); layMist(this.mist, bands, ground!, { stride,
      tall: at => { const { up, over } = stand(at); return [over + bank.whole * up, bank.fade * up]; }, under });
    this.mist.alpha = 1; this.mist.sync(); this.mist.mesh!.tint = this.look!.bank;
    // Since the frame before: the time that went by, no more than a second of it, and the pixels the ground went.
    const before = this.shown, drift = before ? clamp(time - before.time, 0, 1) : 0, went = before ? (x - before.x) * zoom : 0;
    this.shown = { time, x };
    for (const wisp of this.wisps) {
      const mesh = wisp.mesh, lap = width + wisp.long, round = wisp.round + (wisp.speed * drift - went * wisp.depth) / lap;
      wisp.round = round - Math.floor(round);
      // It shows as the bank is closed over what the screen has of its body: over the end of the screen, while it comes in.
      const along = x + (wisp.round * lap - wisp.long / 2 - width / 2) / zoom, body = wisp.long * WISP_BODY / zoom,
        closed = mistOver(bands, clamp(along - body, view.left, view.right), clamp(along + body, view.left, view.right));
      mesh.visible = closed > .01;
      if (!mesh.visible) continue;
      const size = Math.min(1, (bank.whole + bank.fade) * zoom * WISP_SHARE / wisp.tall);
      mesh.position.set(along, ground!.height(along) + stand(along).over + bank.whole * (.25 + wisp.high) + 14 * size * Math.sin(time * .07 + wisp.sway) / zoom);
      mesh.scale.set(wisp.flip * wisp.long * size / WISP_WIDTH / zoom, wisp.tall * size / WISP_HEIGHT / zoom);
      mesh.tint = this.look!.wisp; mesh.alpha = wisp.strength * closed;
    }
  }
  // The haze over the cells of the sight out of it, a texel a cell, laid where the cells are; none without a sight.
  hazeOver(sight: ViewSight | null, ground: SightGround | null = null) {
    const veil = this.veil, cells = sight ? sight.columns * sight.rows : 0;
    if (!cells || !sight) { veil.visible = false; return; }
    let shade = this.shade;
    if (shade?.columns !== sight.columns || shade.rows !== sight.rows) {
      shade?.texture.destroy(true);
      const data = new Uint8Array(cells * 4).fill(255);
      shade = this.shade = { columns: sight.columns, rows: sight.rows, data, cover: new Float32Array(cells), spare: new Float32Array(cells),
        previous: new Float32Array(cells).fill(-1), sighted: new Float32Array(cells).fill(-1), laid: null, any: false,
        texture: bufferTexture(data, sight.columns, sight.rows) };
      veil.texture = shade.texture;
    }
    const cover = sight.cover(shade.cover), { columns, rows, cell, first, bottom } = sight, laid = shade.laid;
    // The same sight over the same cells of the same ground is the same haze: a view held still costs the mask alone.
    if (laid?.ground === ground && laid.cell === cell && laid.first === first && laid.bottom === bottom && same(cover, shade.sighted)) {
      this.placeVeil(sight); return;
    }
    shade.sighted.set(cover); shade.laid = { ground, cell, first, bottom };
    // Sight clears whole underground columns. Let only their visual veil close
    // smoothly with depth, retaining the logical sight and every hidden cell.
    if (ground) {
      const reach = cell * (2 * VEIL_SOFT + 1);
      for (let column = 0; column < columns; column++) {
        const line = ground!.height((first + column + .5) * cell),
          // A whole reach and more under the line a cell is under the veil, and over the line it is as the sight has it:
          // only the rows between, with one more to either side, are eased.
          deep = Math.min(rows, Math.max(0, Math.floor((line - reach) / cell - bottom - .5))),
          over = Math.min(rows, Math.max(deep, Math.ceil(line / cell - bottom - .5) + 1));
        for (let row = 0; row < deep; row++) cover[row * columns + column] = 1;
        for (let row = deep; row < over; row++) {
          const at = row * columns + column, depth = line - (bottom + row + .5) * cell;
          cover[at] = Math.max(cover[at]!, smoothstep(depth / reach));
        }
      }
    }
    let different = false;
    for (let i = 0; i < cells; i++) {
      if (shade.previous[i] !== cover[i]!) { different = true; break; }
    }
    // An unchanged cell mask has the same blur, even when the camera or its eyes moved within a cell.
    // Keep the input before softCover overwrites it; -1 makes the first mask, including all clear, new.
    if (different) {
      shade.previous.set(cover);
      softCover(cover, shade.spare, sight.columns, sight.rows);
      let any = false, changed = false;
      for (let i = 0; i < cells; i++) {
        const alpha = Math.round(255 * shade.cover[i]!), at = i * 4 + 3;
        if (shade.data[at] !== alpha) { shade.data[at] = alpha; changed = true; }
        if (alpha) any = true;
      }
      shade.any = any;
      if (any && changed) shade.texture.source.update();
    }
    this.placeVeil(sight);
  }
  // The haze laid where the cells of the sight are, in the tone of the weather; hidden where it covers nothing.
  placeVeil(sight: ViewSight) {
    const veil = this.veil;
    veil.visible = this.shade!.any;
    if (!veil.visible) return;
    veil.position.set(sight.first * sight.cell, sight.bottom * sight.cell); veil.scale.set(sight.cell, sight.cell);
    veil.alpha = VEIL_STRENGTH; veil.tint = this.look!.veil;
  }
  destroy() {
    this.root.destroy({ children: true }); this.wispQuad?.destroy(); this.wispShader?.destroy();
    this.tones?.destroy(true); this.shape?.destroy(true); this.shade?.texture.destroy(true); this.shade = null; this.wisps = [];
  }
}
