import type { Graphics } from 'pixi.js';
import type { Point } from './math.ts';
import type { Terrain } from './terrain.ts';
import type { Road } from './roads.ts';
// The roads a field lays on its ground (roads.ts), as they are seen from the side: a band under the ground line,
// following it over every rise and fall, which the relief keeps as it was. Only the look of the ground changes; the
// ground line itself is the terrain's, and the vehicles stand on it as before: a near view draws it with the bumps of the
// road there, as the running gear stands on them (terrain.ts `RoughGround`), small on graded earth and none on asphalt.
import { simplifyGround, outlineError } from './terrain-lod.ts';
import { RoughGround } from './terrain.ts';
import { Random } from './math.ts';

// How each kind of road is painted, from the ground line down, in metres: graded earth packed smooth and paler than
// the ground about it, under a thin crust paler still; asphalt, a dark grey course over its bed of crushed stone. Each
// with an edge of its own along its top, discreet. The deeper layer is laid first.
const ROAD_ART = Object.freeze({
  graded: { layers: [[.3, 0x9e957a], [.09, 0xbcb294]] satisfies [number, number][], edge: { color: 0xd6cdae, width: .016, alpha: .45 } },
  asphalt: { layers: [[.36, 0x6b685d], [.13, 0x3d4043]] satisfies [number, number][], edge: { color: 0x8b8e8b, width: .018, alpha: .55 } },
});
// The foot of a layer ends this far along the ground for every metre of its depth inside an end of its road that meets
// the bare ground; where it meets another road, the two lie end to end.
const BEVEL = .8;

// The ground line between two places: their heights and every corner of the outline between them.
function line(terrain: Terrain, a: number, b: number) {
  const points = terrain.points;
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle]!.x <= a) low = middle + 1; else high = middle; }
  const out = [{ x: a, y: terrain.height(a) }];
  for (let i = low; i < points.length && points[i]!.x < b; i++) out.push(points[i]!);
  out.push({ x: b, y: terrain.height(b) });
  return out;
}

// A band from the ground line down to `depth`, its foot drawn in from the ends that are `bare`, [start, end].
function band(points: readonly Point[], depth: number, bare: readonly boolean[]) {
  const a = points[0]!.x, b = points.at(-1)!.x, bevel = Math.min(BEVEL * depth, (b - a) * .45),
    from = bare[0] ? a + bevel : a, to = bare[1] ? b - bevel : b, inside = points.filter(p => p.x > from && p.x < to),
    height = (x: number) => { const i = points.findIndex(p => p.x >= x); const p = points[i]!, q = points[i - 1] ?? p;
      return p.x === q.x ? p.y : q.y + (p.y - q.y) * (x - q.x) / (p.x - q.x); };
  return [...points.flatMap(p => [p.x, p.y]), to, height(to) - depth,
    ...inside.reverse().flatMap(p => [p.x, p.y - depth]), from, height(from) - depth];
}

// Draws the roads of `terrain` between two places into `g`, as it stands, at the outline a view of `step` draws the
// ground with (terrain-lod.ts), or a negative one with its bumps (terrain-scene.ts `ROUGH`): one band for each layer of
// each stretch, and its edge.
export function drawRoads(g: Graphics, terrain: Terrain, roads: readonly Road[], left: number, right: number, step = 0, detail = true) {
  for (const [i, road] of roads.entries()) {
    const a = Math.max(left, road.x0), b = Math.min(right, road.x1), art = ROAD_ART[road.kind],
      bare = [a === road.x0 && roads[i - 1]?.x1 !== road.x0, b === road.x1 && roads[i + 1]?.x0 !== road.x1];
    if (!(b > a) || !art) continue;
    const rough = step < 0 ? new RoughGround(terrain, a, b) : null,
      exact = rough ? rough.section(a, b) : line(terrain, a, b),
      points = step > 0 ? simplifyGround(exact, outlineError(step)) : exact;
    for (const [depth, color] of art.layers) g.poly(band(points, depth, bare)).fill(color);
    for (const [k, p] of points.entries()) k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y);
    g.stroke(art.edge);
    // These patches belong only to the static near-road cache. A machine's
    // temporary road keeps its cheap bands until the field confirms that stretch.
    if (detail && step <= 0) for (let cell = Math.floor(a / 4); cell * 4 < b; cell++) {
      const random = new Random((terrain.seed ^ Math.imul(cell, 0x85ebca6b) ^ (road.kind === 'asphalt' ? 719 : 491)) >>> 0),
        from = Math.max(a, cell * 4 + random.range(.12, 1.4)), to = Math.min(b, cell * 4 + random.range(2.1, 3.95)),
        pale = random.next() < .45;
      if (from >= to || random.next() < .22) continue;
      const skin = rough ? rough.section(from, to) : line(terrain, from, to), graded = road.kind === 'graded';
      g.poly(band(skin, random.range(.025, .075), [true, true]))
        .fill({ color: pale ? (graded ? 0xd3c4a0 : 0xa59e89) : (graded ? 0x696c55 : 0x202b2b), alpha: pale ? .12 : .1 });
      if (graded) {
        const x = Math.min(to, from + random.range(.05, .3)), y = terrain.height(x) - .055, size = random.range(.035, .075);
        g.poly([x - size, y, x, y + size * .35, x + size * .8, y - size * .45, x - size * .5, y - size * .6])
          .fill({ color: 0x777963, alpha: .35 });
      }
    }
  }
  return g;
}
