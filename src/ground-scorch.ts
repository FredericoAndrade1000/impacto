import type { Graphics } from 'pixi.js';
import type { EffectTerrain } from './effect-types.ts';
export interface Scorch { x: number; width: number; strength: number; depth?: number; lift?: number; seed?: number; outlines?: ScorchOutlines }
export interface ScorchOutlines { terrain: EffectTerrain; points: EffectTerrain['points']; soot: number[]; core: number[] }
import { anchorGraphics } from './world-anchor.ts';

// A burn mark lies on the ground as the ground runs. Each mark is a thin lens
// along the exact contour between its two ends, thickest under the burst, so a
// slope or a ridge carries it instead of being crossed by a level ellipse.
const STEPS = 20;

function ragged(x: number, seed: number) {
  const wave = Math.sin(x * 3.7 + seed) * .5 + Math.sin(x * 9.1 + seed * 1.7) * .3 + Math.sin(x * 21.3 + seed * .6) * .2;
  return .82 + wave * .18;
}

// Abscissas of the band: an even subdivision for the taper, plus every vertex
// of the piecewise-linear contour inside the span, so no chord cuts a corner.
function stations(terrain: EffectTerrain, left: number, right: number) {
  const xs = Array.from({ length: STEPS + 1 }, (_, i) => left + (right - left) * i / STEPS);
  for (const point of terrain.points || []) if (point.x > left && point.x < right) xs.push(point.x);
  return xs.sort((a, b) => a - b).filter((x, i, all) => !i || x - all[i - 1]! > 1e-6);
}

// Closed outline as a flat [x, y, …] list: along the surface, then back below it.
export function scorchBand(terrain: EffectTerrain, { x, width, depth = .08, lift = .014, seed = x }: Omit<Scorch, 'strength'>, share = 1, thin = 1) {
  const half = width * share, left = x - half, right = x + half, xs = stations(terrain, left, right), top = [], bottom = [];
  for (const at of xs) {
    const u = (at - x) / half, profile = Math.max(0, 1 - u * u) ** .7, ground = terrain.height(at);
    top.push(at, ground + lift * profile);
    bottom.unshift(at, ground - depth * thin * profile * ragged(at, seed));
  }
  return top.concat(bottom);
}

// The soot spreads wide and faint; the burnt core is narrower and darker.
export function scorchOutlines(terrain: EffectTerrain, scorch: Scorch): ScorchOutlines {
  if (scorch.outlines?.terrain === terrain && scorch.outlines.points === terrain.points) return scorch.outlines;
  return scorch.outlines = { terrain, points: terrain.points,
    soot: scorchBand(terrain, scorch), core: scorchBand(terrain, scorch, .5, .75) };
}

export function drawScorches(graphics: Graphics, terrain: EffectTerrain | null | undefined, scorches: readonly Scorch[]) {
  if (!terrain?.height) return;
  for (const scorch of scorches) {
    if (!(scorch.width > 0)) continue;
    const { soot, core } = scorchOutlines(terrain, scorch);
    graphics.poly(soot).fill({ color: 0x2f2d24, alpha: scorch.strength * .6 });
    graphics.poly(core).fill({ color: 0x1d1f1a, alpha: scorch.strength });
  }
}

// The marks of the bursts a view shows, in a drawing of their own: those whose soot lies between the ends of the view,
// drawn again only when one comes into it or leaves it, or the ground they lie on is another. A field at war keeps forty
// of them wherever they were burnt (effects.ts `scorch`), each a band of some fifty corners for Pixi to lay out: drawn
// anew on every frame, wherever they lay, they made every frame of a long battle slower as they piled up.
export class ScorchMarks {
  declare graphics: Graphics; declare ground: EffectTerrain | null; declare shown: Scorch[]; declare drawings: number;
  constructor(graphics: Graphics) { this.graphics = graphics; this.ground = null; this.shown = []; this.drawings = 0; }
  // Of `scorches` on `ground`, those from `left` to `right` along it; drawn anew, the drawing stands at (`x`, `y`)
  // (world-anchor.ts), within the view. Whether it was drawn anew.
  update(ground: EffectTerrain, scorches: readonly Scorch[], left: number, right: number, x: number, y: number) {
    const shown = scorches.filter(scorch => scorch.width > 0 && scorch.x + scorch.width >= left && scorch.x - scorch.width <= right);
    if (ground === this.ground && shown.length === this.shown.length && shown.every((scorch, i) => scorch === this.shown[i])) return false;
    this.ground = ground; this.shown = shown; this.drawings++;
    drawScorches(anchorGraphics(this.graphics, x, y), ground, shown);
    return true;
  }
}
