import type { Point } from './math.ts';

// These are drawing tolerances, in metres. The authoritative contact outline is never changed.
// At the upper zoom of either distant level, the surface error stays below a quarter of a pixel.
export const terrainStep = (zoom: number): number => zoom >= .5 ? 0 : zoom >= .125 ? 8 : 32;
// How far the outline of a step strays from the ground, up or down: the surface is drawn from it, and the
// top of the earth under that surface hangs from it (strata-art.ts).
export const outlineError = (step: number): number => step / 16;

// Remove only corners whose vertical departure from the new segment fits the tolerance. Endpoints
// stay exact, including at biome and chunk seams; a narrow crest is kept even between long flat runs.
export function simplifyGround<P extends Point>(points: P[], error: number): P[] {
  if (points.length < 3 || error <= 0) return points;
  const keep = new Uint8Array(points.length), pending = [0, points.length - 1];
  keep[0] = keep[points.length - 1] = 1;
  while (pending.length) {
    const end = pending.pop(), start = pending.pop();
    if (start === undefined || end === undefined) throw new Error('Incomplete ground simplification range.');
    const a = points[start], b = points[end];
    if (!a || !b) throw new TypeError('Ground outline has a missing endpoint.');
    let worst = error, at = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      if (!p) throw new TypeError('Ground outline has a missing point.');
      const gap = Math.abs(p.y - a.y - (p.x - a.x) * (b.y - a.y) / (b.x - a.x));
      if (gap > worst) { worst = gap; at = i; }
    }
    if (at >= 0) { keep[at] = 1; pending.push(start, at, at, end); }
  }
  return points.filter((_, i) => keep[i]);
}
