export interface SpeedTerrain {
  height(x: number): number;
  groundAt(x: number): string | null | undefined;
}
export type SpeedTerrainInput = SpeedTerrain | { height?: null | undefined };
interface TerrainRelief { minX: number; maxX: number; height(x: number): number }
export interface TravelTerrain extends SpeedTerrain, TerrainRelief {
  sectors: readonly { start: number; end: number }[];
  roads: readonly { x0: number; x1: number }[];
}
export interface TerrainSpeedPlan { speed2: number; braking2: number; range: number; ahead: number }
export interface TerrainSpeedOptions {
  speed?: number; length?: number; height?: number; pressure?: number; tracked?: boolean; known?: (x: number) => boolean;
}

// A pilot's speed estimate, not a second contact solver. Rust still owns the
// tyres, suspension, brakes and every impulse. A straight slope holds a vehicle
// to nothing but stopping by the end of the way it plans.
const GRAVITY = 9.81, STEP = 4, LOOK_AHEAD = 512;
// The m/s² a pilot counts on its brakes taking off a vehicle on level ground, short of the 5 they give where the ground
// holds that much (game_motion.rs): all of them stop every stock vehicle harder than this from as fast as it goes over
// each ground, its bumps and all, rock the least, at 4.4 from 100 km/h; on sand and mud by the grip of the ground
// (`groundBraking`), which they also hold to with something to spare.
export const BRAKING = 4.25;
// Nominal grip and bearing follow game_terrain.rs; pressure is the live native reading.
const GROUND: Readonly<Record<string, readonly [number, number, number]>> = { soil: [.72, .72, 0], rock: [.72, .72, 0], concrete: [.72, .72, 0],
  gravel: [.60, .60, 0], sand: [.40, .54, 180000], mud: [.26, .44, 100000], graded: [.70, .70, 0], asphalt: [.80, .80, 0] };
// The grip a running gear has on a ground, for its weight on it: the less where ground that gives under it is pressed harder.
function groundGrip(ground: string | null | undefined, tracked = false, pressure = 0): number {
  const surface = GROUND[String(ground)], loss = surface?.[2] ? Math.min(3, pressure * 1000 / surface[2]) : 0;
  return surface ? surface[tracked ? 1 : 0] / (1 + loss * (tracked ? .07 : .14)) : .26;
}
// What a pilot counts on its brakes taking off a vehicle on a ground on level ground, in m/s²: `BRAKING`, or what the
// grip of the ground holds where that is less. A ground it is not told of is taken for the one that holds least.
export function groundBraking(ground: string | null | undefined, tracked = false, pressure = 0): number {
  return Math.min(BRAKING, GRAVITY * groundGrip(ground, tracked, pressure));
}
// The speed a way over each ground is reckoned at, in km/h, on wheels and on tracks (`travelSeconds`): by fives, the
// fastest any of the stock vehicles holds flat out over a level stretch of it, its bumps (game_terrain.rs `Bumps`) and
// how it rolls holding them back. Concrete and asphalt have no bumps: there a vehicle goes as fast as it goes.
// A pilot holds no vehicle to it. Flat out over every ground, come onto it at the full speed they have on asphalt, and
// thrown onto it far faster, at 180 km/h on wheels and 130 on tracks, the stock vehicles are thrown about on their
// springs, their gear off the ground as much as two steps in five on rock, and pay for it in fuel; but none of them
// strikes the ground with anything, breaks or rolls over, and their brakes still stop them as `BRAKING` counts on.
export const GROUND_KMH: Readonly<Record<string, readonly [number, number]>> = Object.freeze({ soil: [105, 70], sand: [100, 70], gravel: [125, 70], rock: [85, 60], mud: [55, 55], graded: [135, 70] });
// The speed a way over the ground at a place is reckoned at, in m/s: no less than the vehicle's own where it has no bumps.
export function groundSpeed(terrain: Pick<SpeedTerrain, 'groundAt'>, x: number, tracked = false): number {
  const kmh = GROUND_KMH[String(terrain.groundAt(x))]?.[tracked ? 1 : 0];
  return kmh ? kmh / 3.6 : Infinity;
}

// What a pilot plans for comes nearer as the vehicle goes: a bend, the end of the way it plans or the unexplored
// frontier, `ahead` metres on. That spends its braking distance between the pilot's looks (Squad.safeSpeed), and one
// ahead is braked for as it comes nearer, at what its brakes are counted on for (Squad.drive).
function speedPlan(braking2: number, range: number, ahead: number): TerrainSpeedPlan {
  return { speed2: Math.max(0, braking2), braking2, range, ahead };
}

export function terrainSpeed(terrain: SpeedTerrainInput | null | undefined, from: number, to: number,
  { speed = 0, length = 6, height = 1, pressure = 0, tracked = false, known = () => true }: TerrainSpeedOptions = {}): TerrainSpeedPlan {
  const heading = Math.sign(to - from), distance = Math.min(LOOK_AHEAD, Math.abs(to - from)), support = Math.max(2, length / 2),
    reserve = Math.min(1, length / (2 * Math.max(.5, height))), moving = Math.max(0, speed),
    stopping = (brake: number): number => brake > 0 ? moving * moving / (2 * brake) + moving * 2 + length * 2 : LOOK_AHEAD;
  let range = Math.min(distance, Math.max(support * 2, stopping(BRAKING))), energy = 0, braking2 = Infinity, ahead = 0, previous = 0, braking = BRAKING;
  const bound = (speed2: number, at: number): void => { if (speed2 < braking2) { braking2 = speed2; ahead = at; } };
  if (!heading || !terrain?.height || !Number.isFinite(from) || !Number.isFinite(to)) return speedPlan(braking2, 0, ahead);
  // At most 129 samples / 387 height reads, independent of the map length.
  for (let d = 0; d <= range; d += STEP) {
    const x = from + heading * d;
    // Check all four places before reading any height or ground: hidden terrain is not
    // a route hint. Approach the frontier at a pace that stops in one body length,
    // and keep moving as the faction's sensors reveal more of the ground.
    if (![x - support, x, x + support, x + heading * length].every(known)) { bound(energy + 2 * braking * length, d + length); return speedPlan(braking2, d, ahead); }
    const before = terrain.height(x - support), middle = terrain.height(x), after = terrain.height(x + support),
      grade = (after - before) / (2 * support) * heading, bend = (after - 2 * middle + before) / (support * support),
      brake = groundBraking(terrain.groundAt(x), tracked, pressure) + GRAVITY * Math.min(0, grade / Math.hypot(1, grade));
    // A descent may consume all braking. Keep that deficit in the v² budget;
    // rolling and aerodynamic drag only help, and are not promised by the pilot.
    energy += 2 * Math.min(braking, brake) * (d - previous); previous = d; braking = brake;
    // At a convex crest v_x² * |height''| takes weight off the gear: as much as all of it, and no more, so that it does
    // not leave the ground there; a dip may press it as much again. A tall centre of mass keeps a margin of that. No bend
    // means no terrain speed limit.
    if (Math.abs(bend) > 1e-8) bound(GRAVITY * reserve / Math.abs(bend) + energy, d);
    range = Math.min(distance, Math.max(range, stopping(brake)));
  }
  // It stops by the end of the way it plans, the place it is sent to or as far as it looks ahead: on level ground and up
  // a slope that is further than it takes, and down one its brakes do not hold it on it is gone down no faster than that.
  bound(energy + 2 * braking * (range - previous), range);
  return speedPlan(braking2, range, ahead);
}

// Every rise of a ground, read every `CLIMB_STEP` metres from one end of it to the other, summed as a vehicle going east
// meets them, and as one going west does: worked out once for a ground (`climbed`).
interface TerrainRises { lo: number; east: Float64Array; west: Float64Array }
const CLIMB_STEP = 8, RISES = new WeakMap<TerrainRelief, TerrainRises>();
function rises(terrain: TerrainRelief): TerrainRises {
  let kept = RISES.get(terrain);
  if (!kept) {
    const lo = terrain.minX, count = Math.ceil((terrain.maxX - lo) / CLIMB_STEP) + 1, east = new Float64Array(count), west = new Float64Array(count);
    for (let i = 1, last = terrain.height(lo); i < count; i++) {
      const y = terrain.height(Math.min(terrain.maxX, lo + i * CLIMB_STEP));
      east[i] = Number(east[i - 1]) + Math.max(0, y - last); west[i] = Number(west[i - 1]) + Math.max(0, last - y); last = y;
    }
    RISES.set(terrain, kept = { lo, east, west });
  }
  return kept;
}
// The metres a way from one place to another climbs, going that way.
export function climbed(terrain: TerrainRelief, from: number, to: number): number {
  const { lo, east, west } = rises(terrain), at = (x: number): number => Math.max(0, Math.min(east.length - 1, Math.round((x - lo) / CLIMB_STEP)));
  return to > from ? Number(east[at(to)]) - Number(east[at(from)]) : Number(west[at(from)]) - Number(west[at(to)]);
}

// The seconds a way from one place to another takes at `share` of the speed a vehicle goes at over each stretch of its
// ground: its `top` speed, or the speed reckoned for the ground there where that is lower, and never under a metre a
// second. Of each stretch of one ground — between the ends of its sectors and of the roads laid on it — once. And, for a
// vehicle its engine lifts `lift` metres a second at full power, as long as that takes up every rise of the way: one
// that goes as fast as the speed reckoned for its ground on the level crawls up a long climb by what its engine lifts.
export function travelSeconds(terrain: TravelTerrain, from: number, to: number,
  { top, tracked = false, share = 1, lift = Infinity }: { top: number; tracked?: boolean; share?: number; lift?: number }): number {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (!(hi > lo)) return 0;
  const ends = [lo, hi], sectors = terrain.sectors, roads = terrain.roads;
  let first = 0, last = sectors.length;
  while (first < last) {
    const mid = (first + last) >>> 1, sector = sectors[mid];
    if (!sector) throw new TypeError('Terrain has a missing sector.');
    if (sector.end <= lo) first = mid + 1; else last = mid;
  }
  for (let i = first; i < sectors.length; i++) {
    const sector = sectors[i];
    if (!sector) throw new TypeError('Terrain has a missing sector.');
    if (!(sector.start < hi)) break;
    ends.push(sector.start, sector.end);
  }
  for (const road of roads) if (road.x1 > lo && road.x0 < hi) ends.push(road.x0, road.x1);
  const stops = ends.filter(x => x >= lo && x <= hi).sort((a, b) => a - b);
  let seconds = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (a !== undefined && b !== undefined && b > a) seconds += (b - a) / Math.max(1, share * Math.min(top, groundSpeed(terrain, (a + b) / 2, tracked)));
  }
  const up = Number.isFinite(lift) ? climbed(terrain, from, to) : 0;
  return up > 0 ? seconds + up / lift : seconds;
}
