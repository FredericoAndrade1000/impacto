import { clamp } from './math.ts';
import { carries, cargoSpace } from './component-volume.ts';
import { extracts, supplySpace } from './economy.ts';
import { workFrame, workSide, workLayout, workReachable, workDelivery } from './work-arm.ts';
import { aircraft } from './squad.ts';
import type { SceneActor, SceneModule } from './scene-contract.ts';
import type { CargoKind, SupplyBill } from './economy-contract.ts';
import type { WorkLayout, WorkPart } from './work-arm.ts';

export type LoadingSite = { x: number; feature?: string } &
  ({ refined: true; supplies: SupplyBill; material?: CargoKind } | { refined?: false; material: CargoKind; supplies?: SupplyBill });
export interface LoadingGround { height(x: number): number }
type LoadingPlate = Pick<WorkPart, 'id' | 'definition' | 'attached'> & { actorId?: string | undefined; kind?: never };
export interface LoadingWorld {
  time: number; modules: readonly SceneModule[]; plates: readonly LoadingPlate[]; terrain: LoadingGround;
  actor(id: string): SceneActor | null | undefined;
}
type LoadingPart = SceneModule | LoadingPlate;
export interface CollectionWork { piece: SceneModule; layout: WorkLayout; point: number }
interface WorkStop { lo: number; hi: number; goal: number; ready: boolean }
interface ToolStop extends WorkStop { reachable: boolean }
interface LoadStop extends WorkStop { piece: SceneModule }
export interface WorkArea extends WorkStop { digs: boolean; loads: boolean }
interface CollectionPlan {
  time: number; modules: readonly SceneModule[]; plates: readonly LoadingPlate[];
  groups: Map<string | undefined, LoadingPart[]>; actors: Map<string, CollectionWork[]>;
}

// The actual surface deposit, inside the scenery's outcrop/sand/seep band.
// LOAD_REACH remains only the broad search radius around a vehicle.
const RADII: Readonly<Partial<Record<string, number>>> = Object.freeze({ outcrop: 8, ruins: 9, talus: 10, dune: 14, lowland: 10, airdrop: 8 });
const EDGE = 1; // room for the bucket to drag through material, rather than past the edge
const PICKUP_HEIGHT = 2; // metres below the container floor; a larger container gains capacity, not reach
// Metres of places a stretch where a vehicle both digs and loads leaves its pilot to stop in: in a narrower one it does
// the two at two places instead.
const STAND = 1;
export function loadingZone(site: Pick<LoadingSite, 'x' | 'feature'>): { lo: number; hi: number } {
  const radius = site.feature === undefined ? 8 : RADII[site.feature] ?? 8;
  return { lo: site.x - radius, hi: site.x + radius };
}
const inside = (site: LoadingSite, point: number): boolean => { const zone = loadingZone(site); return point >= zone.lo + EDGE && point <= zone.hi - EDGE; };
// The places of a vehicle (where it stands) that put a point of it, `offset` from where it stands, in the material of a
// site, within `reach` of the site: the one that puts the point at the site's middle (`goal`), as far as they go.
function stretch(site: LoadingSite, reach: number, offset: number): Omit<WorkStop, 'ready'> | null {
  const zone = loadingZone(site), lo = Math.max(site.x - reach, zone.lo + EDGE - offset), hi = Math.min(site.x + reach, zone.hi - EDGE - offset);
  return hi >= lo ? { lo, hi, goal: clamp(site.x - offset, lo, hi) } : null;
}

// One small geometry plan per simulation frame, shared by collection and the pilots.
const plans = new WeakMap<LoadingWorld, CollectionPlan>();
function collectionPlan(world: LoadingWorld): CollectionPlan {
  const modules = world.modules, plates = world.plates;
  let plan = plans.get(world);
  if (!plan || plan.time !== world.time || plan.modules !== modules || plan.plates !== plates) {
    const groups = new Map<string | undefined, LoadingPart[]>();
    for (const part of [...plates, ...modules]) {
      const group = groups.get(part.actorId);
      if (group) group.push(part); else groups.set(part.actorId, [part]);
    }
    plans.set(world, plan = { time: world.time, modules, plates, groups, actors: new Map() });
  }
  return plan;
}
export function collectionWork(world: LoadingWorld, actorId: string): CollectionWork[] {
  const plan = collectionPlan(world);
  if (!plan.actors.has(actorId)) {
    const parts = plan.groups.get(actorId) || [], work: CollectionWork[] = [];
    for (const piece of parts) {
      if (piece.kind !== 'excavator' && piece.kind !== 'drill' || piece.health <= 0 || piece.attached === false) continue;
      const frame = workFrame(piece, parts), layout = workLayout(piece, frame, workSide(frame, 0, piece.mirrored), x => world.terrain.height(x)),
        point = layout.mount.x + layout.side * layout.out;
      work.push({ piece, layout, point });
    }
    plan.actors.set(actorId, work);
  }
  const work = plan.actors.get(actorId);
  if (!work) throw new Error('Missing collection plan.');
  return work;
}

export function canCollect(work: CollectionWork, site: LoadingSite, ground: LoadingGround): boolean {
  if (!extracts(work.piece, site.material)) return false;
  return inside(site, work.point) && workReachable(work.layout, x => ground.height(x));
}

// Places of the vehicle that put a compatible arm in the material.
function digPlaces(world: LoadingWorld, actorId: string, site: LoadingSite, reach: number, x: number): ToolStop[] {
  return collectionWork(world, actorId).filter(work => extracts(work.piece, site.material) && work.layout.out < work.layout.length - .02).flatMap(work => {
    const place = stretch(site, reach, work.point - x), reachable = workReachable(work.layout, at => world.terrain.height(at));
    // Course reach and site alignment are separate: an arm may need to drive
    // into the band even though its complete stroke already reaches the ground.
    return place ? [{ ...place, reachable, ready: reachable && inside(site, work.point) }] : [];
  });
}

function pickupReachable(piece: Pick<SceneModule, 'x' | 'y' | 'angle' | 'height'>, ground: LoadingGround): boolean {
  const c = Math.cos(piece.angle || 0), s = Math.sin(piece.angle || 0),
    x = piece.x + s * piece.height / 2, y = piece.y - c * piece.height / 2,
    gap = y - ground.height(x);
  return gap >= -.1 && gap <= PICKUP_HEIGHT;
}

// Raw piles go into hoppers/cisterns; a refined remittance goes into supply pieces. Their physical pickup reach is shared.
export const pickupContainer = (piece: { kind: SceneModule['kind'] } | { kind?: never }, site: LoadingSite): boolean => site.refined ? piece.kind === 'supply' :
  (piece.kind === 'hopper' || piece.kind === 'cistern') && carries(piece, site.material);
const holders = (parts: readonly LoadingPart[], site: LoadingSite): SceneModule[] => parts.filter((piece): piece is SceneModule => Boolean(piece.kind && pickupContainer(piece, site) && piece.health > 0 && piece.attached !== false));
const pickupSpace = (piece: SceneModule, site: LoadingSite): number => site.refined ? supplySpace([piece], site.supplies) : cargoSpace(piece, site.material);
const roomFor = (pieces: readonly SceneModule[], site: LoadingSite): number => pieces.reduce((sum, piece) => sum + pickupSpace(piece, site), 0);

// Every place belongs to a mouth: a container whose own floor reaches the material, or one an arm in the material
// delivers into. What comes in at a mouth fills every container of the vehicle that takes it (`loadingContainers`), as
// a conveyor would: a low hopper takes a pile in for the high ones, full or not, but a vehicle whose every container
// stands high has no mouth. A vehicle stands on the ground with a wheel or a track on it; an aircraft, on its skids, once it
// no longer flies (game_hover.rs): one that hovers there loads nothing.
function loadPlaces(world: LoadingWorld, actorId: string, site: LoadingSite, reach: number, x: number): LoadStop[] {
  const actor = world.actor(actorId), parts = collectionPlan(world).groups.get(actorId) || [], mouths = holders(parts, site);
  if (!(roomFor(mouths, site) > 1e-6)) return [];
  if (!actor) throw new TypeError('Loading actor is unavailable.');
  const grounded = !actor.vehicle || (aircraft(actor) ? !actor.vehicle.flying : parts.some(piece =>
      (piece.kind === 'wheel' || piece.kind === 'track') && piece.attached !== false && piece.groundContact)), places: LoadStop[] = [],
    add = (piece: SceneModule, point: number, ready: boolean): void => {
      const place = stretch(site, reach, point - x);
      if (place) places.push({ piece, ...place, ready: ready && inside(site, point) });
    };
  for (const piece of mouths) {
    const reachable = pickupReachable(piece, world.terrain);
    // The ground under a vehicle en route says nothing about its destination.
    // At the site, an unreachable mounting has no target to keep revisiting.
    // Losing wheel contact is temporary and only suspends pickup.
    if (!inside(site, piece.x) || !grounded || reachable) add(piece, piece.x, grounded && reachable);
  }
  for (const work of collectionWork(world, actorId)) {
    if (!extracts(work.piece, site.material) || work.layout.out >= work.layout.length - .02) continue;
    const delivery = workDelivery(work.layout, parts, site, at => world.terrain.height(at)),
      piece = mouths.find(piece => piece.id === delivery?.partId);
    if (piece) add(piece, work.point, grounded && canCollect(work, site, world.terrain));
  }
  return places;
}
function nearest<Place extends WorkStop>(places: Place[], x: number): Place {
  const place = places.sort((a, b) => Number(b.ready) - Number(a.ready) || Math.abs(a.goal - x) - Math.abs(b.goal - x))[0];
  if (!place) throw new TypeError('Missing loading stop.');
  return place;
}

// Where a vehicle works a site, one rule for its pilot and for the field (server/room.ts `haul` digs by `canCollect` and
// loads by `loadingContainers`, from these same places): the places of the vehicle (`lo`…`hi`, the one it would rather
// stand at, `goal`) where it does what it can there, and whether it stands at one of them (`ready`). It digs (`digs`)
// with a tool whose stroke reaches the ground, while the vein has reserve (`dig`), and loads (`loads`) while its
// containers have room. One that can do both does them at one place; where it cannot — its tool and its mouths too far
// apart for the material — it digs until the pile it knows of (`stock`) fills it, and then takes the pile in.
// A container still loads where its tool cannot reach the ground, and a tool alone is driven to where it should dig.
export function workArea(world: LoadingWorld, actorId: string, site: LoadingSite, reach: number, { dig = true, stock = 0 }: { dig?: boolean; stock?: number } = {}): WorkArea | null {
  const actor = world.actor(actorId), x = actor?.vehicle?.x ?? actor?.x;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const tools = dig ? digPlaces(world, actorId, site, reach, x) : [], loads = loadPlaces(world, actorId, site, reach, x),
    working = tools.filter(place => place.reachable),
    area = ({ lo, hi, goal, ready }: WorkStop, digs: boolean, loads: boolean): WorkArea => ({ lo, hi, goal, ready, digs, loads });
  if (working.length && loads.length) {
    const both = working.flatMap(tool => loads.flatMap(load => {
      const lo = Math.max(tool.lo, load.lo), hi = Math.min(tool.hi, load.hi);
      return hi - lo >= STAND ? [{ lo, hi, goal: clamp(tool.goal, lo, hi), ready: tool.ready && load.ready }] : [];
    }));
    if (both.length) return area(nearest(both, x), true, true);
    const load = nearest(loads, x), room = roomFor(holders(collectionPlan(world).groups.get(actorId) || [], site), site);
    return load.ready && stock > 0 || stock >= room ? area(load, false, true) : area(nearest(working, x), true, false);
  }
  if (loads.length) return area(nearest(loads, x), false, true);
  const tool = tools.sort((a, b) => Number(b.ready) - Number(a.ready) || Number(b.reachable) - Number(a.reachable) || Math.abs(a.goal - x) - Math.abs(b.goal - x))[0];
  return tool ? area(tool, true, false) : null;
}

// What a vehicle standing where it is takes a pile into: once one of its mouths is in the material, every container of
// it that takes the material and has room for it, its mouths first; nothing otherwise.
export function loadingContainers(world: LoadingWorld, actorId: string, site: LoadingSite, reach: number): SceneModule[] {
  const actor = world.actor(actorId), x = actor?.vehicle?.x ?? actor?.x;
  if (typeof x !== 'number' || !Number.isFinite(x)) return [];
  const ready = loadPlaces(world, actorId, site, reach, x).filter(place => place.ready).map(place => place.piece);
  if (!ready.length) return [];
  return [...new Set([...ready, ...holders(collectionPlan(world).groups.get(actorId) || [], site)])]
    .filter(piece => pickupSpace(piece, site) > 1e-6);
}
