import { Mesh, MeshGeometry } from 'pixi.js';
import type { BLEND_MODES, Texture } from 'pixi.js';
import { canvas } from './textures.ts';
import type { Point } from './math.ts';

export type ShotTint = 0 | 1 | 2;
type AtlasFrame = readonly [number, number, number, number];
export interface TrailPoint extends Point { fade?: number }
export interface TrailView { left: number; right: number; bottom: number; top: number; hidden?: ((x: number, y: number) => boolean) | null }

// Tails and far markers of rounds in flight are quads taken from one small
// texture and written straight into the buffers of a mesh. A volley of hundreds
// then costs a few numbers a round on each frame, where vector strokes would be
// tessellated all over again.
const WIDTH = 64, HEIGHT = 128, BAND = 16;
const TAIL_COLORS = ['#f5dfb4', '#ffc78b', '#dfded0'], GLOW_COLORS = ['249,233,196', '242,199,138', '230,222,193'];
// Pixels across a tail: a 2.2 px light core on a 4.2 px dark edge that keeps it
// apart from a pale sky, and the soft rim around both.
export const TAIL_WIDTH = 5.6;
// The far marker is a bright point with a dark rim; its glow reaches further.
export const MARKER_RADIUS = 6, GLOW_RADIUS = 10;
const MARKER: AtlasFrame = [2 / WIDTH, 50 / HEIGHT, 30 / WIDTH, 78 / HEIGHT];
const GLOWS = [0, 1, 2].map((kind): AtlasFrame => [(1 + kind * 22) / WIDTH, 85 / HEIGHT, (19 + kind * 22) / WIDTH, 103 / HEIGHT]);

// Armour-piercing, explosive and rocket rounds each have a colour of their own.
export const shotKind = (shot: { poweredTrail?: boolean | null | undefined; ammo?: string | undefined }): ShotTint => shot.poweredTrail ? 2 : shot.ammo === 'he' || shot.ammo === 'heat' ? 1 : 0;

export function paintShotAtlas() {
  const sheet = canvas(WIDTH, HEIGHT), ctx = sheet.getContext('2d')!, texel = TAIL_WIDTH / (BAND - 2);
  TAIL_COLORS.forEach((color, kind) => {
    for (const [tint, pixels, alpha] of [['#2c3834', 4.2, .55], [color, 2.2, .9]] as const) {
      ctx.globalAlpha = alpha; ctx.fillStyle = tint;
      ctx.fillRect(0, kind * BAND + BAND / 2 - pixels / texel / 2, WIDTH, pixels / texel);
    }
  });
  // Along a tail the texture goes from nothing to full strength, quickly at first so the far end still shows.
  const ramp = ctx.createLinearGradient(.5, 0, WIDTH - .5, 0);
  for (let i = 0; i <= 8; i++) ramp.addColorStop(i / 8, `rgba(0,0,0,${(i / 8) ** .6})`);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = ramp;
  ctx.fillRect(0, 0, WIDTH, HEIGHT); ctx.globalCompositeOperation = 'source-over';
  const scale = 14 / MARKER_RADIUS;
  for (const [radius, tint, alpha] of [[4.4, '#1d2924', .7], [2.8, '#fff4d2', 1]] as const) {
    ctx.globalAlpha = alpha; ctx.fillStyle = tint; ctx.beginPath(); ctx.arc(16, 64, radius * scale, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  GLOW_COLORS.forEach((color, kind) => {
    const x = 10 + kind * 22, glow = ctx.createRadialGradient(x, 94, 0, x, 94, 9);
    glow.addColorStop(0, `rgba(${color},.5)`); glow.addColorStop(.45, `rgba(${color},.3)`); glow.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = glow; ctx.fillRect(x - 10, 84, 20, 20);
  });
  return sheet;
}

function quadIndices(quads: number) {
  const indices = new Uint32Array(quads * 6);
  for (let i = 0; i < quads; i++) indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  return indices;
}

export class ShotQuads {
  declare positions: Float32Array; declare uvs: Float32Array;
  declare count: number; declare drawn: number; declare x: number; declare y: number; declare alpha: number; declare mesh: Mesh<MeshGeometry> | null;
  constructor(capacity = 256) {
    this.positions = new Float32Array(capacity * 8); this.uvs = new Float32Array(capacity * 8);
    this.count = this.drawn = 0; this.x = this.y = 0; this.alpha = 1; this.mesh = null;
  }
  attach(texture: Texture, blendMode: BLEND_MODES = 'normal') {
    const geometry = new MeshGeometry({ positions: this.positions, uvs: this.uvs, indices: quadIndices(this.positions.length / 8) });
    geometry.batchMode = 'no-batch';
    this.mesh = new Mesh({ geometry, texture }); this.mesh.blendMode = blendMode;
    return this.mesh;
  }
  // Corners are kept relative to a point near them: single precision holds a
  // tail a few pixels wide tens of kilometres from the origin of the world.
  clear(x = 0, y = 0) { this.count = 0; this.x = x; this.y = y; }
  quad(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, u0: number, v0: number, u1: number, v1: number) {
    const at = this.count++ * 8;
    if (at === this.positions.length) for (const name of ['positions', 'uvs'] as const) {
      const grown = new Float32Array(at * 2); grown.set(this[name]); this[name] = grown;
    }
    const p = this.positions, t = this.uvs, x = this.x, y = this.y;
    p[at] = ax - x; p[at + 1] = ay - y; p[at + 2] = bx - x; p[at + 3] = by - y;
    p[at + 4] = cx - x; p[at + 5] = cy - y; p[at + 6] = dx - x; p[at + 7] = dy - y;
    t[at] = t[at + 2] = u0; t[at + 4] = t[at + 6] = u1; t[at + 1] = t[at + 5] = v0; t[at + 3] = t[at + 7] = v1;
  }
  // A ribbon along recorded points, `half` its half width. Each point's own
  // fade times `strength` is how much of the tail shows there. Gentle bends
  // share their corners; a sharp one, as at a ricochet, starts a new ribbon.
  // Stretches outside `view` are left out, and on a field with fog those whose
  // middle is hidden (`view.hidden`, of a place).
  tail(points: readonly TrailPoint[], kind: ShotTint, half: number, strength = 1, view: TrailView | null = null) {
    const v0 = (kind * BAND + 1) / HEIGHT, v1 = (kind * BAND + BAND - 1) / HEIGHT, last = points.length - 1;
    let ux = 0, uy = 0, ox = 0, oy = 0, joined = false;
    for (let i = 0; i < last; i++) {
      const a = points[i]!, b = points[i + 1]!;
      if (!joined) {
        ux = b.x - a.x; uy = b.y - a.y; const length = Math.hypot(ux, uy);
        if (!(length > 1e-9)) continue;
        ux /= length; uy /= length; ox = -uy * half; oy = ux * half;
      }
      let ex = -uy * half, ey = ux * half, nx = 0, ny = 0; joined = false;
      if (i + 1 < last) {
        const c = points[i + 2]!; nx = c.x - b.x; ny = c.y - b.y; const length = Math.hypot(nx, ny);
        if (length > 1e-9) {
          nx /= length; ny /= length; const turn = ux * nx + uy * ny;
          if (turn > .5) { const mitre = half / (1 + turn); ex = -(uy + ny) * mitre; ey = (ux + nx) * mitre; joined = true; }
        }
      }
      const fa = Math.min(1, (a.fade ?? 1) * strength), fb = Math.min(1, (b.fade ?? 1) * strength);
      if ((fa > .02 || fb > .02) && !(view && (Math.max(a.x, b.x) < view.left || Math.min(a.x, b.x) > view.right ||
          Math.max(a.y, b.y) < view.bottom || Math.min(a.y, b.y) > view.top || view.hidden?.((a.x + b.x) / 2, (a.y + b.y) / 2))))
        this.quad(a.x + ox, a.y + oy, a.x - ox, a.y - oy, b.x + ex, b.y + ey, b.x - ex, b.y - ey,
          (.5 + Math.max(0, fa) * (WIDTH - 1)) / WIDTH, v0, (.5 + Math.max(0, fb) * (WIDTH - 1)) / WIDTH, v1);
      if (joined) { ux = nx; uy = ny; ox = ex; oy = ey; }
    }
  }
  // A square about a point. Thousands are written on a frame of a long volley: its corners go straight to the buffers.
  square(x: number, y: number, half: number, frame: AtlasFrame) {
    const at = this.count * 8, u0 = frame[0], v0 = frame[1], u1 = frame[2], v1 = frame[3];
    // A full buffer grows where every quad is written.
    if (at === this.positions.length) { this.quad(x - half, y - half, x - half, y + half, x + half, y - half, x + half, y + half, u0, v0, u1, v1); return; }
    const p = this.positions, t = this.uvs, left = x - this.x - half, right = x - this.x + half, low = y - this.y - half, high = y - this.y + half;
    p[at] = p[at + 2] = left; p[at + 4] = p[at + 6] = right; p[at + 1] = p[at + 5] = low; p[at + 3] = p[at + 7] = high;
    t[at] = t[at + 2] = u0; t[at + 4] = t[at + 6] = u1; t[at + 1] = t[at + 5] = v0; t[at + 3] = t[at + 7] = v1;
    this.count++;
  }
  marker(x: number, y: number, half: number) { this.square(x, y, half, MARKER); }
  glow(x: number, y: number, half: number, kind: ShotTint) { this.square(x, y, half, GLOWS[kind]!); }
  // Hand the frame to the mesh. Only the quads in use travel to the GPU, and
  // those of the last frame drawn that are no longer are folded to nothing.
  sync() {
    const mesh = this.mesh;
    if (!mesh) return;
    // A batch with nothing to show is not drawn at all: it keeps the room of its densest frame, and there are
    // several of them. Nothing travels to the GPU for a mesh that is not drawn, and a later request takes the
    // place of one that did not travel: what the GPU holds stays as the last frame drawn left it (`drawn`), to
    // be folded by the next one that is.
    mesh.position.set(this.x, this.y); mesh.alpha = this.alpha; mesh.visible = this.count > 0 && this.alpha > 0;
    // Keep the pooled buffers, but draw only their live prefix rather than every dormant quad.
    mesh.geometry.indexCount = this.count * 6;
    if (!mesh.visible) return;
    const live = Math.max(this.count, this.drawn), geometry = mesh.geometry;
    if (geometry.positions !== this.positions) {
      geometry.positions = this.positions; geometry.uvs = this.uvs; geometry.indices = quadIndices(this.positions.length / 8);
    }
    if (this.drawn > this.count) this.positions.fill(0, this.count * 8, this.drawn * 8);
    geometry.getBuffer('aPosition').update(live * 32); geometry.getBuffer('aUV').update(live * 32);
    this.drawn = this.count;
  }
}
