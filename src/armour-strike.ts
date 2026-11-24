import { firingSolution, flightState, GRAVITY, FLIGHT_HORIZON } from './ballistics.ts';
import { KINETIC_AMMO, allowedTrajectories } from './weapons.ts';
import { MATERIALS, MODULES } from './materials.ts';
import { GROUND_SURFACES } from './ground-impact.ts';
import { plateCorners, closestSegment } from './math.ts';
import { componentPolygon, componentPolygons } from './assembly.ts';
import { regionContains } from './scene-frame.ts';
import { faceHolds, polygonHolds } from './hull-coverage.ts';
import { predictImpact } from './impact-preview.ts';
import { number } from './format.ts';
import type { Point, Pose } from './math.ts';
import type { GridBounds } from './armor-grid.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { ImpactIndex, PreviewScene } from './impact-preview.ts';
import type { Terrain } from './terrain.ts';
import type { AmmoId, WeaponSettings } from './weapons.ts';
import type { FlightModel, FlightState, FlightTrajectory } from './ballistic-contract.ts';

export type PredictedStrikeImpact = NonNullable<ReturnType<typeof predictImpact>>;
export type StrikeScene = PreviewScene & Pick<DrawingScene, 'bodyPanels'>;
export interface StrikeTest {
  state: StrikeScene; index: ImpactIndex; ground: Pick<Terrain, 'height' | 'raycast'>;
  hull: Pose | null | undefined; weapon: WeaponSettings; distance: number;
}
export interface StrikeArrival { muzzle: number; speed: number; start: number; flight: FlightModel; range: number }
export interface StrikeRoundOptions {
  point: Point; direction: Point; hop: number; arrival: StrikeArrival; weapon: WeaponSettings; bounds: GridBounds | null; end?: Point | null;
}
export type StrikeJudgement = { verdict: 'air' | 'miss' | 'ground' | 'burst' | 'pending' } |
  { verdict: 'ricochet' | 'through' | 'stopped'; cost: number };
export interface StrikeDetailOptions { away?: number | null; blast?: number; airburst?: Point | null }

// The test of armour is struck along a line the player draws, as the analysis of protection of a tank game shoots
// from where it is asked: pressed where the round comes from and dragged toward where it goes, the round goes on
// along that line to the first thing it meets, the design or the ground (`lineMeets`). It arrives there along the
// line, with the speed a round of the gun of the test has there after flying as far as the distance of the test
// says (`arrival`); it is put in the air where the line was drawn from (`strikeRound`), and the core flies it from
// there as any other. What it does where it first strikes is told while the line is drawn (`strikeVerdict`), by the
// rule the core strikes by. A shell set to burst in the air is fuzed for where the line was drawn to, and bursts there
// unless it meets something first. A click on the design strikes it level at the place clicked (`levelStrike`).

// How far outside what the design spans a round is put in the air when the line is drawn from on the design, in metres.
export const STRIKE_MARGIN = .5;
// How far over the ground the muzzle of the gun the round comes from stands, in metres: a line is drawn from no lower.
export const MUZZLE_CLEARANCE = .3;
// How far along its line a round is followed to the first thing it meets, in metres: what it meets beyond is the sky.
export const STRIKE_REACH = 4000;
// The nearest a gun of the test stands to where its round strikes, in metres.
export const NEAREST_GUN = 10;
const local = (part: { actorId?: string | undefined }): boolean => (part.actorId || 'local') === 'local';
const surfaceNames: Readonly<Record<string, { name: string }>> = GROUND_SURFACES;

// What the design under test spans, of its plates and of its pieces that are on it.
export function designBounds(state: Pick<StrikeScene, 'plates' | 'modules'>): GridBounds | null {
  const points = [...state.plates.filter(local).flatMap(plate => plateCorners(plate.definition)),
    ...state.modules.filter(module => local(module) && module.attached !== false).flatMap(componentPolygon)];
  if (!points.length) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// How far a point of the world is from the design under test: from the nearest of its plates and of its pieces that
// are on it, nothing when it is on one. None without a part.
export function designDistance(state: Pick<StrikeScene, 'plates' | 'modules'>, point: Point): number | null {
  const polygons = [...state.plates.filter(local).map(plate => plateCorners(plate.definition)),
    ...state.modules.filter(module => local(module) && module.attached !== false).flatMap(componentPolygons)];
  if (!polygons.length) return null;
  let nearest = Infinity;
  for (const polygon of polygons) {
    if (polygonHolds(polygon, point)) return 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const at = closestSegment(point, polygon[j]!, polygon[i]!);
      nearest = Math.min(nearest, Math.hypot(point.x - at.x, point.y - at.y));
    }
  }
  return nearest;
}

// Whether a point of the world is on the design under test — on a plate, on a piece or on the skin of its hull —, or
// within `reach` metres of it. `hull` is where the hull stands now, to lay the skin on.
export function onDesign(state: Pick<StrikeScene, 'plates' | 'modules' | 'bodyPanels'>, hull: Pose | null | undefined, point: Point, reach = 0): boolean {
  const plates = state.plates.filter(local), modules = state.modules.filter(module => local(module) && module.attached !== false),
    faces = (state.bodyPanels || []).filter(local),
    holds = (at: Point) => plates.some(plate => regionContains(plate, at)) ||
      modules.some(module => componentPolygons(module).some(polygon => polygonHolds(polygon, at))) ||
      faces.some(face => faceHolds(face, hull || face.pose, at));
  const offsets: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  return offsets.some(([dx, dy]) => holds({ x: point.x + dx * reach, y: point.y + dy * reach }));
}

// Where a line pressed at `point` is drawn from: no lower over the ground than a muzzle stands.
export const strikeOrigin = (point: Point, ground: Pick<Terrain, 'height'>): Point => ({ x: point.x, y: Math.max(point.y, ground.height(point.x) + MUZZLE_CLEARANCE) });
// The way along a line drawn from `from` toward `to`; none while the two are one place.
export function strikeDirection(from: Point, to: Point): Point | null {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  return length > 1e-9 ? { x: dx / length, y: dy / length } : null;
}

// The first thing a straight line from `from` along `direction` meets within `reach` metres: a part of a construction
// of the state (`index`, its collision index) or the ground, and how far along the line it is. None: the line goes to
// the sky.
export function lineMeets(index: ImpactIndex, ground: Pick<Terrain, 'raycast'>, from: Point, direction: Point, reach = STRIKE_REACH): (Point & { distance: number; ground: boolean }) | null {
  const to = { x: from.x + direction.x * reach, y: from.y + direction.y * reach },
    part = index.raycast(from, to, { projectile: true }), soil = ground.raycast(from, to),
    hit = soil && (!part || soil.enter < part.enter) ? soil : part;
  return hit ? { x: hit.x, y: hit.y, distance: hit.enter * reach, ground: hit === soil } : null;
}

// How a round of the gun of the test (`weapon`) arrives where it strikes, having flown `distance` metres from the gun
// on the arc the gun takes there — a mortar's high one —, with its charge (`firingSolution`): how fast it leaves the gun
// (`muzzle`), how fast it arrives (`speed`), how fast it goes `hop` metres before it arrives (`start`), as the air
// slows it, and what the air takes of it (`flight`). The gun stands no nearer than where the round is put in the air.
export function arrival(weapon: WeaponSettings, distance: number, hop = 0): StrikeArrival {
  const range = Math.max(distance, hop, NEAREST_GUN), aim = { x: range, y: 0 },
    arc = allowedTrajectories(weapon.preset).includes('auto') ? 'auto' : weapon.trajectory,
    solution = firingSolution({ x: 0, y: 0 }, aim, { ...weapon, trajectory: arc }), end = flightState(solution, solution.time),
    muzzle = Math.hypot(solution.vx, solution.vy), speedAt = (state: FlightState) => Math.hypot(state.vx, state.vy),
    away = (time: number) => { const at = flightState(solution, time); return Math.hypot(at.x - aim.x, at.y - aim.y); };
  // The last time the round is `hop` metres from where it strikes: on its way down, for a round that climbs first.
  let early = 0, late = solution.time;
  if (hop > 0) for (let step = 0; step < 32 && late - early > 1e-7; step++) {
    const middle = (early + late) / 2;
    if (away(middle) >= hop) early = middle; else late = middle;
  }
  const speed = speedAt(end) > 1 ? speedAt(end) : muzzle, start = hop > 0 ? speedAt(flightState(solution, early)) : speed;
  return { muzzle, speed, start: start > 1 ? start : speed, flight: solution.flight, range };
}

// How far back from `point`, against `direction`, a round is clear of what the design spans, and STRIKE_MARGIN more.
function clearance(point: Point, direction: Point, bounds: GridBounds | null): number {
  if (!bounds) return STRIKE_MARGIN;
  const exit = (from: number, way: number, low: number, high: number): number => way > 0 ? (high - from) / way : way < 0 ? (low - from) / way : Infinity;
  const along = Math.min(exit(point.x, -direction.x, bounds.minX, bounds.maxX), exit(point.y, -direction.y, bounds.minY, bounds.maxY));
  return Math.max(0, along) + STRIKE_MARGIN;
}

// The round as the core is told to put it in the air (`round`, the projectile op), `hop` metres back from `point` on
// the line, and the flight it takes as a forecast reads it (`solution`, impact-preview.ts). It goes so as to come to
// `point` along `direction`: gravity, which bends it on the way, is taken back for what it flies to it, and it leaves
// as fast as a round of the gun goes there (`arrival`). What a kinetic round can pierce falls with its speed, as it
// does in the air (`commit_air`, game_projectiles.rs); a shaped charge and a shell keep theirs. A shell fuzed for a
// place on the line (`end`) bursts as it gets there (`fuzeAt`), unless it meets something first; the forecast follows
// it until then, and any other round across what the design spans and a little past it.
export function strikeRound({ point, direction, hop, arrival: arrived, weapon, bounds, end = null }: StrikeRoundOptions) {
  const speed = arrived.start, time = hop / speed, flight = arrived.flight,
    start = { x: point.x - direction.x * hop, y: point.y - direction.y * hop - GRAVITY * time * time / 2 },
    velocity = { x: direction.x * speed, y: direction.y * speed + GRAVITY * time },
    power = KINETIC_AMMO.includes(weapon.ammo) ? weapon.power * (Math.hypot(velocity.x, velocity.y) / arrived.muzzle) ** 2 : weapon.power,
    fuze = end ? fuzeAt({ x: start.x, y: start.y, vx: velocity.x, vy: velocity.y, flight }, end, direction, time) : null,
    span = bounds ? Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) : 0,
    reach = fuze ?? (hop + span + 1) / Math.min(speed, arrived.speed);
  return { point, direction, hop, start, power,
    round: { actorId: 'local', weapon: weapon.id, preset: weapon.preset, ammo: weapon.ammo, mass: flight.mass, caliberMm: flight.caliberMm,
      radius: weapon.radius, power, blastRadius: weapon.blastRadius, poweredTrail: weapon.poweredTrail, detonation: weapon.detonation,
      x: start.x, y: start.y, vx: velocity.x, vy: velocity.y, age: 0, flight, ...(fuze === null ? {} : { fuzeTime: fuze }) },
    solution: { x: start.x, y: start.y, vx: velocity.x, vy: velocity.y, flight, time: reach, flightLimit: reach, reachable: fuze !== null } };
}

// The fuze of a round flown as `solution` says (`flightState`, as the core flies it) for `end`: the time it is first
// past the line through `end` square to `direction`, about `guess` seconds into its flight. The core bursts it at
// that time to the step (`move_projectile`, game_projectiles.rs), so it bursts there, never short of it.
function fuzeAt(solution: Omit<FlightTrajectory, 'time' | 'flightLimit'>, end: Point, direction: Point, guess: number): number {
  const flown = { ...solution, time: FLIGHT_HORIZON, flightLimit: FLIGHT_HORIZON },
    past = (time: number) => { const at = flightState(flown, time); return (at.x - end.x) * direction.x + (at.y - end.y) * direction.y >= 0; };
  let early = 0, late = Math.min(FLIGHT_HORIZON, guess * 1.5);
  while (!past(late) && late < FLIGHT_HORIZON) { early = late; late = Math.min(FLIGHT_HORIZON, late * 2); }
  for (let step = 0; step < 64 && late - early > 1e-12 * (1 + late); step++) {
    const middle = (early + late) / 2;
    if (past(middle)) late = middle; else early = middle;
  }
  return late;
}

// A strike along the line drawn from `from` along `direction`, for a test (`test`: its `state`, the collision index
// of it, its `ground`, where its `hull` stands, the `weapon` and the `distance` of the test): the round put in the
// air where the line was drawn from — from on the design, clear of it back along the line —, and nearer the place it
// strikes where gravity would take it under the ground or into the design on the way; the forecast of what it meets
// first (`impact`), as the core flies it, and the power it strikes with there. A shell set to burst in the air is
// fuzed for where the line was drawn to (`aim`): it bursts there (`airburst`) if it meets nothing first — one drawn
// from on the design meets the design first. How far from the design it strikes the ground or bursts in the air is
// `away`. None when the line goes to the sky and nothing bursts there.
export function strikeAlong(test: StrikeTest, from: Point, direction: Point, aim: Point | null = null) {
  const { state, index, ground, hull, weapon, distance } = test, met = lineMeets(index, ground, from, direction),
    inside = onDesign(state, hull, from), drawn = aim && weapon.ammo === 'he' && weapon.detonation === 'airburst' ?
      Math.max(0, (aim.x - from.x) * direction.x + (aim.y - from.y) * direction.y) : 0,
    end = drawn > 0 ? { x: from.x + direction.x * drawn, y: from.y + direction.y * drawn } : null,
    aloft = Boolean(end) && !inside && (!met || met.distance > drawn);
  if (!met && !aloft) return null;
  const point = aloft ? end! : { x: met!.x, y: met!.y }, bounds = designBounds(state),
    clear = (at: Point) => at.y > ground.height(at.x) && !onDesign(state, hull, at);
  let hop = aloft ? drawn : inside ? clearance(point, direction, bounds) : met!.distance,
    arrived: StrikeArrival, strike: ReturnType<typeof strikeRound>;
  for (;;) {
    arrived = arrival(weapon, distance, hop); strike = strikeRound({ point, direction, hop, arrival: arrived, weapon, bounds, end });
    if (hop <= STRIKE_MARGIN || clear(strike.start)) break;
    hop = Math.max(STRIKE_MARGIN, hop / 2);
  }
  const impact = predictImpact(state, strike.solution, { platform: 'ground', ammo: weapon.ammo, power: strike.power }, index),
    struck = impact && flightState(strike.solution, Math.min(impact.time, strike.solution.flightLimit)),
    power = struck && KINETIC_AMMO.includes(weapon.ammo) ? weapon.power * (Math.hypot(struck.vx, struck.vy) / arrived.muzzle) ** 2 : strike.power,
    burst = !impact && strike.solution.reachable ? flightState(strike.solution, strike.solution.time) : null,
    airburst = burst && { x: burst.x, y: burst.y }, off = airburst ?? (impact?.owner.type === 'ground' ? impact : null);
  return { ...strike, from, ground: !aloft && met!.ground, impact, airburst, power, ammo: weapon.ammo,
    blast: KINETIC_AMMO.includes(weapon.ammo) ? 0 : weapon.blastRadius, away: off && designDistance(state, off), arrival: arrived };
}

// A click on the design, not dragged, strikes it level at the place clicked (`point`), as a gun at that height would:
// from the side whose level line meets first the part clicked (`part`), or else the side whose line meets the design
// nearer the place. Each line is drawn from `lead` metres outside what the design spans. None where neither meets it.
export type ArmourStrike = NonNullable<ReturnType<typeof strikeAlong>>;
export function levelStrike(test: StrikeTest, point: Point, part: string | null | undefined, lead: number) {
  const bounds = designBounds(test.state);
  if (!bounds) return null;
  const near = (strike: ArmourStrike & { impact: PredictedStrikeImpact }): number => Math.hypot(strike.impact.x - point.x, strike.impact.y - point.y),
    sides = [1, -1].map(way => strikeAlong(test, { x: way > 0 ? bounds.minX - STRIKE_MARGIN - lead : bounds.maxX + STRIKE_MARGIN + lead, y: point.y },
      { x: way, y: 0 })).filter((strike): strike is ArmourStrike & { impact: PredictedStrikeImpact } => Boolean(strike?.impact && strike.impact.owner.type !== 'ground')).sort((a, b) => near(a) - near(b));
  const strike = sides.find(side => side.impact.owner.id === part) ?? sides[0];
  return strike ? { ...strike, aim: point } : null;
}

// What a round does where it first strikes (`impact`, a forecast of impact-preview.ts), by the rule the core strikes
// by (`resolve_impact`, game_projectiles.rs): a shell bursts on it; a shaped charge gets through what costs it no more
// than it can pierce (`power`); a kinetic round glances off a face it meets at a slant, unless it can pierce well over
// what that costs, and else gets through or is stopped. A plate costs its material over the length the round crosses
// of it; a piece costs what the core says (`resistance`): until it is told, nothing is said of it (`pending`). A shell
// fuzed for a place in the air bursts there when it meets nothing on the way (`airburst`).
export function strikeVerdict(impact: PredictedStrikeImpact | null | undefined,
  { ammo, power, airburst = null }: { ammo: AmmoId; power: number; airburst?: Point | null }, resistance?: number): StrikeJudgement {
  if (!impact) return { verdict: airburst ? 'air' : 'miss' };
  if (impact.owner.type === 'ground') return { verdict: 'ground' };
  if (ammo === 'he') return { verdict: 'burst' };
  const plate = impact.owner.type === 'plate', material = impact.owner.material ?? MATERIALS.steel,
    cost = plate ? Math.max(.5, impact.traversedMm * material.resistance) : resistance;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return { verdict: 'pending' };
  const cosine = Math.cos(impact.angleDegrees * Math.PI / 180);
  if (ammo !== 'heat' && cosine < material.ricochet && power < cost * 1.3) return { verdict: 'ricochet', cost };
  return { verdict: power >= cost ? 'through' : 'stopped', cost };
}

export const STRIKE_WORDS = Object.freeze({ through: 'Penetra', stopped: 'Não penetra', ricochet: 'Ricochete', burst: 'Explode',
  ground: 'Chão', miss: 'Não atinge', air: 'Explode no ar', pending: '…' });
// What is struck first, in a few words: a plate by its material and thickness, the slant it is met at (0° is square
// on) and the thickness the round crosses there; a piece by its kind and the slant; the ground, or the place in the air
// a shell bursts at (`airburst`), by how far it is from the design (`away`), with the reach of the burst of an
// explosive round (`blast`), or a ricochet off the ground.
export function strikeDetail(impact: PredictedStrikeImpact | null | undefined, { away = null, blast = 0, airburst = null }: StrikeDetailOptions = {}): string {
  const where = away === null ? null : away < .05 ? 'junto ao projeto' : 'a ' + number(away, away < 10 ? 1 : 0) + ' m do projeto',
    reach = blast ? 'raio de ' + number(blast, 1) + ' m' : '';
  if (!impact) return airburst ? [where, reach].filter(Boolean).join(' · ') : '';
  const angle = number(impact.angleDegrees, 0) + '°';
  if (impact.owner.type === 'ground')
    return [where ?? (surfaceNames[impact.surface ?? '']?.name || 'Solo'), reach || (impact.bounce ? 'ricochete' : '')].filter(Boolean).join(' · ');
  if (impact.owner.type === 'module') return MODULES[impact.owner.object.kind].name + ' · ' + angle;
  const thickness = impact.owner.object.definition?.thicknessMm;
  return [impact.owner.material.name + (thickness ? ' ' + number(thickness, 0) + ' mm' : ''), angle,
    number(impact.traversedMm, 0) + ' mm efetivos'].join(' · ');
}
