import { Graphics, GraphicsContext } from 'pixi.js';
import { outlineEdges, within } from './hull-details.ts';
import { MAIN_LIGHT } from './main-light.ts';
import type { Container, DestroyOptions, PointData, StrokeInput } from 'pixi.js';
import type { Point, Pose } from './math.ts';

export type SilhouetteStyle = 'dark' | 'selected' | 'towable' | 'glint';
interface OutlineStyle { color: number; alpha: number; pixels: number; halo?: number }
interface OutlineEdge { a: Point; b: Point; normal: Point }
interface OutlineContext {
  poly(points: number[], closePath?: boolean): OutlineContext;
  stroke(style: StrokeInput): OutlineContext;
}
type ShapeOutlines = readonly (readonly Point[])[];
export type SilhouetteShape = { points: readonly Point[]; outlines?: ShapeOutlines; others?: ShapeOutlines }
  | { points?: readonly Point[]; outlines: ShapeOutlines; others?: ShapeOutlines };
export interface SilhouetteDrawing { context: GraphicsContext; width: number | null; users: number }
export type SilhouetteHolder<K extends string = string> = Partial<Record<K, Silhouette>>;
interface DisplayPose extends Pose { position: PointData; rotation: number; scale: PointData }

// The edge a construction is told from what stands behind it by: a fine dark line just outside the outline of each
// part of it that makes its shape — the skin of a hull, its chassis, a body carried out in the open, its wheels and
// its tracks — and a fine light one just inside the edges of a hull and of a chassis that look up, where the sun
// catches the edge of the armour. Both are as wide on the screen at any zoom. The dark line of every part lies under
// the whole construction: what of it falls on another part is hidden by that part, and what shows is the outline of
// the construction and the gaps between its parts.
//
// The vehicles the player has picked are edged in the light olive of a selection, with a dark line beyond it that keeps
// it clear of the sky (`STYLES`). The one in their hands has the dark edge of every vehicle. While the order Rebocar waits
// for its vehicle, those it could take now are edged so in amber.
//
// A drawing is made once for a shape and a style, and every part of that shape wears it, moved to where the part
// is: three hundred vehicles of one design are one drawing. It is drawn again only when the zoom has gone a quarter
// of an octave from the one it was drawn for, as the width of its line on the screen would have changed.

export const STYLES: Readonly<Record<SilhouetteStyle, Readonly<OutlineStyle>>> = Object.freeze({
  dark: Object.freeze({ color: 0x0e1511, alpha: .7, pixels: 1 }),
  selected: Object.freeze({ color: 0xb9cc8b, alpha: .95, pixels: 2, halo: .55 }),
  // A vehicle the one picked could take on its cable now, while Rebocar waits for it: in the accent of the page.
  towable: Object.freeze({ color: 0xf0b874, alpha: .95, pixels: 2, halo: .55 }),
  glint: Object.freeze({ color: MAIN_LIGHT.color, alpha: .6, pixels: 1 }),
});
// An edge looks up when its normal out of the part rises at least this much: a roof, a deck, a glacis. Whether
// another outline stands on it is asked this far out of its middle, in metres.
const UPWARD = .45, PROBE = .02;
// The pixels to the metre under which a part shows no light edge: its roof is a few pixels across.
export const GLINT_ZOOM = 5;

// How wide a line of `pixels` on the screen is, in metres, at `zoom`: by quarters of an octave, so that a zoom
// draws again only when the line would be a fifth off.
export const lineAt = (pixels: number, zoom: number): number => 2 ** (Math.round(Math.log2(pixels / zoom) * 4) / 4);

// The places of an outline (`{ x, y }`, in order) as Pixi takes them.
const flat = (points: readonly Point[]): number[] => points.flatMap(p => [p.x, p.y]);

// The runs of an outline whose edges look up, each moved `inset` into the part: a line along each, as wide as
// twice that, lies just within its edge. An edge another outline of the part's construction stands on (`others`,
// in the same frame) is within the construction, and has none.
export function upwardRuns(points: readonly Point[], inset = 0, others: ShapeOutlines = []): Point[][] {
  const edges: readonly OutlineEdge[] = outlineEdges(points), runs: Point[][] = [],
    up = edges.map(edge => edge.normal.y >= UPWARD && !others.some(other => within({
      x: (edge.a.x + edge.b.x) / 2 + edge.normal.x * PROBE, y: (edge.a.y + edge.b.y) / 2 + edge.normal.y * PROBE }, other))),
    // A run begins after an edge that does not look up, so one that goes round the start of the outline is whole.
    // Some edge of a closed outline looks down.
    start = up.indexOf(false);
  if (start < 0) return runs;
  let run: Point[] | null = null;
  for (let k = 1; k <= edges.length; k++) {
    const i = (start + k) % edges.length, edge = edges[i]!;
    if (!up[i]) { run = null; continue; }
    const inward = { x: -edge.normal.x * inset, y: -edge.normal.y * inset };
    if (!run) { run = [{ x: edge.a.x + inward.x, y: edge.a.y + inward.y }]; runs.push(run); }
    else {
      // The corner between two edges that look up is moved in along both: where their moved lines meet.
      const before = edges[(i + edges.length - 1) % edges.length]!.normal, n = { x: before.x + edge.normal.x, y: before.y + edge.normal.y },
        dot = n.x * edge.normal.x + n.y * edge.normal.y, scale = dot > .2 ? inset / dot : 0;
      run[run.length - 1] = { x: edge.a.x - n.x * scale, y: edge.a.y - n.y * scale };
    }
    run.push({ x: edge.b.x + inward.x, y: edge.b.y + inward.y });
  }
  return runs;
}

// Draws the outline of a shape (`points`, closed) in a style, its line `width` metres wide, into a context; the light
// edge leaves out what the outlines `others` stand on.
export function drawOutline(context: OutlineContext, points: readonly Point[], style: SilhouetteStyle, width: number, others: ShapeOutlines = []): OutlineContext {
  const look = STYLES[style];
  if (style === 'glint') {
    for (const run of upwardRuns(points, width / 2, others)) context.poly(flat(run), false);
    return context.stroke({ color: look.color, alpha: look.alpha, width, cap: 'butt', join: 'round' });
  }
  const line = look.pixels / STYLES.dark.pixels * width;
  // The selection is edged on the outside in the dark of the outline, a pixel beyond its own line.
  if (look.halo) context.poly(flat(points), true).stroke({ color: STYLES.dark.color, alpha: look.halo, width: line + width, alignment: 0, join: 'round' });
  return context.poly(flat(points), true).stroke({ color: look.color, alpha: look.alpha, width: line, alignment: 0, join: 'round' });
}

// The drawings of the outlines, one for each shape (`key`) and style, at the width of the zoom of the frame. What a
// drawing is drawn by is asked of `shape` only when it is drawn: its outline (`points`), or its outlines when it is in
// pieces (`outlines`), and what stands on it (`others`). Each is kept while a part wears it, and let go after.
export class SilhouetteArt {
  made: Map<string, SilhouetteDrawing>;
  constructor() { this.made = new Map(); }
  wanted(key: string, shape: () => SilhouetteShape, style: SilhouetteStyle, width: number): SilhouetteDrawing {
    const name = style + '|' + key;
    let made = this.made.get(name);
    if (!made) {
      if (this.made.size >= 512) this.sweep();
      made = { context: new GraphicsContext(), width: null, users: 0 }; this.made.set(name, made);
    }
    if (made.width !== width) {
      const { points, outlines = [points!], others } = shape();
      made.width = width; made.context.clear();
      for (const outline of outlines) drawOutline(made.context, outline, style, width, others);
    }
    return made;
  }
  // Lets go of every drawing no part wears.
  sweep() {
    for (const [name, made] of this.made) if (!made.users) { made.context.destroy(); this.made.delete(name); }
  }
}

// A part's outline: a drawing it shares with every part of its shape, which it never destroys.
export class Silhouette extends Graphics {
  made: SilhouetteDrawing;
  constructor(made: SilhouetteDrawing) { super(made.context); this.made = made; made.users++; }
  wear(made: SilhouetteDrawing): this {
    if (made === this.made) return this;
    this.made.users--; made.users++; this.made = made; this.context = made.context;
    return this;
  }
  override destroy(options?: DestroyOptions): void {
    if (this.destroyed) return;
    this.made.users--;
    super.destroy({ ...typeof options === 'object' ? options : { children: Boolean(options) }, context: false });
  }
}

// The outline of a part in a style: its silhouette, made where there was none and laid last in `layer` when it is not
// there, wearing the drawing of the shape now and standing as `pose` does (a pose, or what stands as the part does).
// `slot` is what holds it on whatever keeps it.
export function silhouette<K extends string>(art: SilhouetteArt, holder: SilhouetteHolder<K>, slot: K, layer: Container,
  key: string, shape: () => SilhouetteShape, style: SilhouetteStyle, width: number, pose: Pose | DisplayPose): Silhouette {
  const made = art.wanted(key, shape, style, width);
  let line = holder[slot];
  if (!line || line.destroyed) line = holder[slot] = new Silhouette(made); else line.wear(made);
  if (line.parent !== layer) layer.addChild(line);
  if ('position' in pose && pose.position) { line.position.copyFrom(pose.position); line.rotation = pose.rotation; line.scale.copyFrom(pose.scale); }
  else { line.position.set(pose.x, pose.y); line.rotation = pose.angle; }
  return line;
}
// A part's outline taken out of its layer, for as long as it is not drawn: laid back, it goes over what is there.
export function drop<K extends string>(holder: Partial<Record<K, Pick<Graphics, 'removeFromParent'>>>, slot: K): void { holder[slot]?.removeFromParent(); }
