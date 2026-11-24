import type { Point } from './math.ts';
import type { MaterialId } from './materials.ts';
import type { AuthoredConstruction, AuthoredPlate, ConstructionNode, CompiledConstruction } from './construction-contract.ts';
import type { PlateEdge } from './edge-plates.ts';
export interface PlateStock { material?: MaterialId; thicknessMm?: number }
export interface FrameEndpoint extends Point { nodeId?: string }
export interface RoomWall { a: Point; b: Point; length: number; material: MaterialId; thicknessMm: number; normal?: Point | null; aId?: string | null; bId?: string | null; bed?: boolean }
export interface RoomDrawing { source: AuthoredConstruction; length: number; depth: number; plates: string[]; polygon: Point[]; refusal?: never }
export interface JoinedContacts { source: AuthoredConstruction; points: Point[]; parts: Map<string,string[]> }
interface Division extends Point { id?: string }
interface Span { a: Point; b: Point }
interface LandingPlace extends Point { ids: string[] }
interface Landing extends LandingPlace { to: Point; onto: string[] | null; off: number }
interface EdgeSpot extends Point { i?: number; k?: number }
interface TurnedSelection { nodes: ReadonlySet<string>; plates: ReadonlySet<string> }
import { tr } from './i18n.ts';
import { closestSegment, wrapAngle } from './math.ts';
import { CAPACITY, CONSTRUCTION_ORIGIN, PART_LIMITS, compileDraftConstruction } from './structured-construction.ts';
import { designFrame, regionGeometry } from './scene-frame.ts';
import { mountedWeaponPolygons, fixedWeaponMaterial } from './weapon-geometry.ts';
import { polygonMaterialContacts, MATERIAL_CONTACT_EPS } from './sensor-support.ts';
import { samePlace } from './frame-points.ts';
import { CELL, cellClear, cellOf, metresOf, unitsOf } from './grid.ts';
import { onAxis, mirrored, plateAcross } from './symmetry.ts';

// Moving a plate or junction carries the ends already at that exact coordinate,
// never the far ends of neighbouring plates or unselected equipment. Plate nodes use units of 5 cm
// (grid.ts), including fractions; rooms are told in metres how small and deep they may be.
export const MAX_NODES = 64, MAX_PLATES = PART_LIMITS.plates, SMALLEST_ROOM = .2, OFFERED_DEPTH = .6;
const SLACK = 1e-7;
// The shortest plate the compiler admits, in metres (`PLATE_LENGTH` in native/dynamics/src/game_construction.rs).
const SHORTEST_PLATE = .08;
const round = (value: number) => Number(value.toFixed(9));
// The construction box, the same for every design and fixed in its reference: 6 m to either side of the reference and
// `FRAME_HEIGHT` metres up from the workshop floor, which the running gear stands on however large it is and wherever
// the chassis runs (`REACH`, `FLOOR`, `HEIGHT` in native/dynamics/src/game_construction.rs), in metres from the
// reference, and in cells as nodes and chassis points are written (`REACH_CELLS`). They stay in it, and nothing goes
// under its floor.
export const FRAME_HEIGHT = 8;
export const FRAME_REACH = Object.freeze({ minX: -6, maxX: 6, minY: -CONSTRUCTION_ORIGIN.y, maxY: round(FRAME_HEIGHT - CONSTRUCTION_ORIGIN.y) });
export const REACH_CELLS = Object.freeze({ minX: cellOf(FRAME_REACH.minX), maxX: cellOf(FRAME_REACH.maxX), minY: cellOf(FRAME_REACH.minY), maxY: cellOf(FRAME_REACH.maxY) });
const refuse: (message: string) => never = message => { throw Object.assign(new Error(message), { code: 'FRAME_EDIT' }); };
const nodeOf = (source: AuthoredConstruction, id: string): ConstructionNode => source.nodes.find(node => node.id === id)!;
const platesAt = (source: AuthoredConstruction, id: string) => source.plates.filter(plate => plate.a === id || plate.b === id);
const ends = (source: AuthoredConstruction, plate: AuthoredPlate): [ConstructionNode, ConstructionNode] => [nodeOf(source, plate.a), nodeOf(source, plate.b)];
// How near the line of a plate, in cells, an end stands on it: ten times as near as the compiler tells one that does
// (`EPS` in `Frame::meet`, native/dynamics/src/game_construction.rs), so that whatever it would tell is joined here.
const ON_LINE = unitsOf(MATERIAL_CONTACT_EPS) * 10;
// Plates meet only at their ends (`Frame::meet`). Where an end of plates stands on another plate between its ends — a
// T — that plate is divided at that very end; where two plates cross — an X — both are divided at a new node where
// their lines cross, which the four parts share. Nothing moves: the node of a T is the end itself, and that of an X
// stands exactly where the lines cross, on no cell of the grid. A plate that runs on along the line of the one its end
// stands on is no T but two plates in one place, which the compiler refuses. Each plate divided keeps its id for its
// first part (frame-editing.ts `cut`). The design so joined, where it was divided (`points`, in cells) and the plates it
// is made of in the place of each one divided (`parts`).
export function joinContacts(source: AuthoredConstruction): JoinedContacts {
  const at = new Map(source.nodes.map(node => [node.id, node])), used = new Set(source.plates.flatMap(plate => [plate.a, plate.b])),
    spans = source.plates.map(plate => ({ plate, a: at.get(plate.a)!, b: at.get(plate.b)! })),
    // Where a point stands along a span, from its first end, and how far off its line.
    station = ({ a, b }: Span, p: Point) => {
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      return { along: ((p.x - a.x) * dx + (p.y - a.y) * dy) / length, off: ((p.x - a.x) * dy - (p.y - a.y) * dx) / length, length };
    },
    inside = (span: Span, p: Point) => { const { along, off, length } = station(span, p); return Math.abs(off) <= ON_LINE && along > ON_LINE && along < length - ON_LINE; },
    divisions = new Map<string, Division[]>(spans.map(span => [span.plate.id, []])), points: Division[] = [];
  // A point divisions share: an end of plates there, or one already made there.
  const point = (p: Division) => points.find(other => Math.hypot(other.x - p.x, other.y - p.y) <= ON_LINE) ?? (points.push(p), p);
  for (const span of spans) for (const id of used) {
    const end = at.get(id)!;
    if (!inside(span, end) || source.plates.some(plate => (plate.a === id || plate.b === id) &&
      Math.abs(station(span, at.get(plate.a === id ? plate.b : plate.a)!).off) <= ON_LINE)) continue;
    divisions.get(span.plate.id)!.push(point({ x: end.x, y: end.y, id }));
  }
  spans.forEach((span, i) => {
    for (const other of spans.slice(0, i)) {
      const dx = span.b.x - span.a.x, dy = span.b.y - span.a.y, ex = other.b.x - other.a.x, ey = other.b.y - other.a.y,
        cross = dx * ey - dy * ex;
      if (!cross) continue;
      const t = ((other.a.x - span.a.x) * ey - (other.a.y - span.a.y) * ex) / cross, p = { x: span.a.x + dx * t, y: span.a.y + dy * t };
      if (inside(span, p) && inside(other, p)) for (const crossed of [span, other]) divisions.get(crossed.plate.id)!.push(point(p));
    }
  });
  if (!points.length) return { source, points: [], parts: new Map<string, string[]>() };
  const next = structuredClone(source), parts = new Map<string, string[]>();
  for (const division of points) if (!division.id) {
    division.id = fresh(next, 'node'); next.nodes.push({ id: division.id, x: division.x, y: division.y });
  }
  for (const span of spans) {
    const stops = [...new Set(divisions.get(span.plate.id)!)].sort((p, q) => station(span, p).along - station(span, q).along);
    if (!stops.length) continue;
    let plate = next.plates.find(plate => plate.id === span.plate.id)!;
    const made = [plate.id];
    for (const stop of stops) { const rest = cut(next, plate, nodeOf(next, stop.id!)); plate = next.plates.find(other => other.id === rest)!; made.push(rest); }
    parts.set(span.plate.id, made);
  }
  if (next.nodes.length > MAX_NODES || next.plates.length > MAX_PLATES) refuse(CAPACITY);
  return { source: next, points: points.map(({ x, y }) => ({ x, y })), parts };
}
const dropLoose = (source: AuthoredConstruction) => { source.nodes = source.nodes.filter(node => platesAt(source, node.id).length); return source; };
// How far the plate runs past its ends, in cells.
const extensions = (plate: AuthoredPlate, start: number, end: number) => {
  if (start || end) plate.ends = { start, end }; else delete plate.ends;
  return plate;
};
const placed = (point: Point) => Number.isFinite(point?.x) && Number.isFinite(point?.y);

function fresh(source: AuthoredConstruction, name: string) {
  const stem = name.replace(/-\d+$/, ''), used = [...source.nodes, ...source.plates, ...source.components].map(item => item.id);
  for (let count = 2; ; count++) {
    const id = `${stem}-${count}`;
    if (!used.some(other => other === id || other.startsWith(id + ':') || other.startsWith(id + '-'))) return id;
  }
}

// Nodes moved past the box are moved back into it together, as far as they went past it.
function holdInReach(nodes: Point[]) {
  if (!nodes.length) return;
  const xs = nodes.map(node => node.x), ys = nodes.map(node => node.y);
  if (Math.max(...xs) - Math.min(...xs) > REACH_CELLS.maxX - REACH_CELLS.minX || Math.max(...ys) - Math.min(...ys) > REACH_CELLS.maxY - REACH_CELLS.minY)
    refuse(tr`A construção pode ocupar no máximo ${FRAME_REACH.maxX - FRAME_REACH.minX} × ${FRAME_HEIGHT} m.`);
  const dx = Math.max(0, REACH_CELLS.minX - Math.min(...xs)) - Math.max(0, Math.max(...xs) - REACH_CELLS.maxX),
    dy = Math.max(0, REACH_CELLS.minY - Math.min(...ys)) - Math.max(0, Math.max(...ys) - REACH_CELLS.maxY);
  for (const node of nodes) {
    if (dx) node.x += dx;
    if (dy) node.y += dy;
  }
}

// Sharing a coordinate does not make an unselected plate part of a transform.
function detach(source: AuthoredConstruction, selected: ReadonlySet<string>, moved: ReadonlySet<string> | null = null) {
  const renamed = new Map<string, string>();
  for (const plate of source.plates.filter(plate => selected.has(plate.id))) for (const end of ['a', 'b'] as const) {
    const id = plate[end];
    if (moved && !moved.has(id)) continue;
    if (!source.plates.some(other => !selected.has(other.id) && (other.a === id || other.b === id))) continue;
    if (!renamed.has(id)) {
      if (source.nodes.length >= MAX_NODES) refuse(CAPACITY);
      const node = { ...nodeOf(source, id), id: fresh(source, 'node') };
      source.nodes.push(node); renamed.set(id, node.id);
    }
    plate[end] = renamed.get(id)!;
  }
  return renamed;
}

// The nodes `positions` names (id → { x, y } in authoring units) put there. Pointer drags stay in reach; numeric
// transforms may leave their exact proposal for the compiler to admit or refuse, without shifting its centre.
export function moveNodes(source: AuthoredConstruction, positions: ReadonlyMap<string, Point>, { plateIds = null, clampToReach = true }: { plateIds?: Iterable<string> | null; clampToReach?: boolean } = {}) {
  if ([...positions].every(([id, point]) => {
    const node = nodeOf(source, id);
    return node && placed(point) && node.x === point.x && node.y === point.y;
  })) return source;
  const next = structuredClone(source), selected = plateIds && new Set(plateIds),
    renamed = selected ? detach(next, selected, new Set(positions.keys())) : new Map<string, string>(), moved: ConstructionNode[] = [];
  for (const [id, point] of positions) {
    const node = nodeOf(next, renamed.get(id) || id);
    if (!node || !placed(point)) refuse(tr('Nó ou coordenada inválidos.'));
    Object.assign(node, { x: point.x, y: point.y }); moved.push(node);
  }
  if (clampToReach) holdInReach(moved);
  return carryPlateWeapons(source, dropLoose(next));
}

// The plate a gun goes with: the one the core finds its barrel passes through, or its post stands on; for one with
// neither, the one plate its real fixed feet alone touch. Receiver/recoil space and corner-only contact do not count,
// nothing of it is saved, and every resulting edit is still admitted by the native compiler.
const designHosts = new WeakMap<AuthoredConstruction, Map<string,string>>();
function weaponHosts(source: AuthoredConstruction): Map<string,string> {
  if (!source.components.some(part=>part.kind==='weapon')) return new Map<string,string>();
  let hosts=designHosts.get(source);
  if (!hosts) {
    const compiled=compileDraftConstruction(source), frame=designFrame(compiled),
      plates=frame.plates.map(plate=>({id:plate.id,pose:plate.definition,geometry:regionGeometry(plate)}));
    hosts=new Map<string,string>();
    for (const module of compiled.modules.filter(module=>module.kind==='weapon')) {
      if (module.weaponMount.hostId) { hosts.set(module.id,module.weaponMount.hostId); continue; }
      const polygons=mountedWeaponPolygons(module).filter((_,index)=>fixedWeaponMaterial(module.weaponMount.exposed,index)),
        touched=new Set(polygonMaterialContacts(polygons,plates).filter(contact=>contact.span>MATERIAL_CONTACT_EPS).map(contact=>contact.plateId));
      if (touched.size===1) hosts.set(module.id,[...touched][0]!);
    }
    designHosts.set(source,hosts);
  }
  return hosts;
}
export const weaponHost = (source: AuthoredConstruction, id: string) => weaponHosts(source).get(id) || null;

// A gun fixed to a changed plate follows it. Its station along
// that plate and perpendicular stand-off survive reshaping; other equipment
// and a gun whose host was removed stay where the author put them.
export function carryPlateWeapons(source: AuthoredConstruction, next: AuthoredConstruction): AuthoredConstruction {
  const stations = new Map<string, { a: Point; c: Point; length: number; changed: number; ux: number; uy: number; vx: number; vy: number; turn: number }>();
  for (const plate of source.plates) {
    const after = next.plates.find(other => other.id === plate.id);
    if (!after) continue;
    const [a, b] = ends(source, plate), [c, d] = ends(next, after);
    if (!a || !b || !c || !d || samePlace(a, c) && samePlace(b, d)) continue;
    const length = Math.hypot(b.x-a.x, b.y-a.y), changed = Math.hypot(d.x-c.x, d.y-c.y);
    if (!length || !changed) continue;
    stations.set(plate.id, { a, c, length, changed, ux:(b.x-a.x)/length, uy:(b.y-a.y)/length,
      vx:(d.x-c.x)/changed, vy:(d.y-c.y)/changed, turn:wrapAngle(Math.atan2(d.y-c.y,d.x-c.x)-Math.atan2(b.y-a.y,b.x-a.x)) });
  }
  if (!stations.size) return next;
  const hosts=weaponHosts(source);
  return { ...next, components: next.components.map(part => {
    const before = source.components.find(other => other.id === part.id), station = before?.kind === 'weapon' && stations.get(hosts.get(before.id)!);
    if (!station || !before) return part;
    const { a,c,length,changed,ux,uy,vx,vy,turn }=station, dx=before.pose.x-a.x, dy=before.pose.y-a.y,
      along=(dx*ux+dy*uy)/length*changed, normal=-dx*uy+dy*ux;
    return { ...part, pose: { ...before.pose, x:c.x+vx*along-vy*normal, y:c.y+vy*along+vx*normal, angle:wrapAngle(before.pose.angle+turn) } };
  }) };
}

// A new plate from `a` to `b` (in cells).
export function addPlate(source: AuthoredConstruction, a: FrameEndpoint, b: FrameEndpoint, { material = 'steel', thicknessMm = 20 }: PlateStock = {}) {
  if (!placed(a) || !placed(b) || a.x === b.x && a.y === b.y)
    refuse(tr('A chapa precisa ter dois pontos distintos e finitos.'));
  // The gesture may have chosen an existing endpoint exactly: the one it names (`nodeId`), or else one where it is.
  // Reuse that identity; a nearby endpoint is not searched for by this document operation.
  const shared = [a, b].map(point => source.nodes.find(node => (point.nodeId ? node.id === point.nodeId : samePlace(node, point)) &&
    platesAt(source, node.id).length));
  if (source.nodes.length + shared.filter(node => !node).length > MAX_NODES || source.plates.length >= MAX_PLATES) refuse(CAPACITY);
  const next = structuredClone(source), id = fresh(next, 'plate'),
    endpoint = (point: Point, existing: ConstructionNode | undefined) => {
      if (existing) return existing.id;
      const node = { id: fresh(next, 'node'), x: point.x, y: point.y };
      next.nodes.push(node); return node.id;
    },
    first = endpoint(a, shared[0]), last = endpoint(b, shared[1]);
  next.plates.push({ id, a: first, b: last, material, thicknessMm });
  return { source: next, plateId: id };
}

// The plate `plateId` divided in two at a new node at `point` (in authoring units).
export function splitPlate(source: AuthoredConstruction, plateId: string, point: Point) {
  const next = structuredClone(source), plate = next.plates.find(plate => plate.id === plateId);
  if (!plate) refuse(tr('Chapa não encontrada.'));
  if (next.nodes.length >= MAX_NODES || next.plates.length >= MAX_PLATES) refuse(CAPACITY);
  if (!placed(point)) refuse(tr('Coordenada inválida.'));
  const [a, b] = ends(next, plate), near = closestSegment(point, a, b);
  if (near.t <= 0 || near.t >= 1 || samePlace(point, a) || samePlace(point, b)) refuse(tr('Divida a chapa entre os dois nós.'));
  const node = { id: fresh(next, 'node'), x: point.x, y: point.y };
  next.nodes.push(node);
  return { source: next, nodeId: node.id, plateId: cut(next, plate, node) };
}

// The plate divided at `node`: it runs from its first end to the node, and a new one, of the same armour, from the node
// to its last end. Each keeps what ran past the end it keeps; none runs past the node.
function cut(source: AuthoredConstruction, plate: AuthoredPlate, node: ConstructionNode) {
  const { start = 0, end = 0 } = plate.ends || {},
    rest = extensions({ ...plate, id: fresh(source, plate.id), a: node.id }, 0, end);
  extensions(plate, start, 0);
  plate.b = node.id; source.plates.splice(source.plates.indexOf(plate) + 1, 0, rest);
  return rest.id;
}

// Removing a vertex is an explicit merge of its two authored spans.
export function removeNode(source: AuthoredConstruction, nodeId: string) {
  const next = structuredClone(source), joined = platesAt(next, nodeId);
  if (joined.length !== 2) refuse(tr('Escolha um nó entre duas chapas para uni-las.'));
  const first = joined[0]!, second = joined[1]!, far = (plate: AuthoredPlate) => plate.a === nodeId ? plate.b : plate.a,
    outer = (plate: AuthoredPlate) => (plate.a === nodeId ? plate.ends?.end : plate.ends?.start) || 0,
    start = outer(first), end = outer(second),
    a = far(first), b = far(second);
  if (a === b) refuse(tr('As duas chapas terminam no mesmo nó.'));
  first.a = a; first.b = b; extensions(first, start, end); next.plates.splice(next.plates.indexOf(second), 1);
  return { source: dropLoose(next), plateId: first.id };
}

// Joining makes the chosen endpoints one authored identity where the first of
// them is. Normal endpoint movement also carries independently named ends at
// that exact position, without rewriting their IDs.
export function joinNodes(source: AuthoredConstruction, ids: Iterable<string>) {
  const [kept, ...rest] = [...new Set(ids)], gone = new Set(rest), next = structuredClone(source);
  if (!rest.length) refuse(tr('Escolha duas ou mais pontas para juntar.'));
  if ([kept, ...rest].some(id => !platesAt(next, id!).length)) refuse(tr('Ponta não encontrada.'));
  for (const plate of next.plates) {
    if (gone.has(plate.a)) plate.a = kept!;
    if (gone.has(plate.b)) plate.b = kept!;
    if (plate.a === plate.b) refuse(tr('As duas pontas de uma mesma chapa não se juntam.'));
  }
  return { source: dropLoose(next), nodeId: kept! };
}
// The other ends exactly where the end `id` is, that are not one point with it.
export function coincidentNodes(source: AuthoredConstruction, id: string) {
  const node = nodeOf(source, id);
  return node ? source.nodes.filter(other => other.id !== id && samePlace(other, node) &&
    platesAt(source, other.id).length).map(other => other.id) : [];
}
// Where the loose ends of what a gesture moves land, let go (Editor.proposeLanding): `moved(ox, oy)` is the document
// with it moved, that many cells further the way the pointer goes, and `before` the document it was moved in. Where
// each lands is told where the pointer leaves it; then what moved slides whole to put its end nearest to where it lands
// there, so that its plates keep their shape, and any other end that lands goes there alone. Each is joined to the end
// it lands on, and one that lands on a plate divides it there (joinContacts). The document so moved, how far further it
// slid (in cells) and the ends of plates it is joined to (in cells); null where none lands.
export function landEnds(before: AuthoredConstruction, moved: (ox: number, oy: number) => AuthoredConstruction, reach: number) {
  const first = moved(0, 0), landed = landings(before, first, reach), [nearest] = landed;
  if (!nearest) return null;
  // Which way an end of it goes as the pointer goes on: across the axis, in symmetric editing, the other way; on it, or
  // against the side of the construction box, not at all.
  const offset = { x: 0, y: 0 };
  if (!samePlace(nearest, nearest.to)) {
    const probe = nodeOf(moved(1, 1), nearest.ids[0]!), wx = probe.x - nearest.x, wy = probe.y - nearest.y;
    if (wx) offset.x = (nearest.to.x - nearest.x) / wx;
    if (wy) offset.y = (nearest.to.y - nearest.y) / wy;
  }
  let next = offset.x || offset.y ? moved(offset.x, offset.y) : first;
  const apart = landed.filter(landing => !samePlace(nodeOf(next, landing.ids[0]!), landing.to));
  if (apart.length) next = moveNodes(next, new Map(apart.flatMap(landing => landing.ids.map(id => [id, landing.to]))), { clampToReach: false });
  for (const landing of landed) if (landing.onto) next = joinNodes(next, [...landing.onto, ...landing.ids]).source;
  return { source: next, offset, ends: landed.filter(landing => landing.onto).map(landing => landing.to) };
}
// The point of the line from `a` to `b` nearest to `p`, and how far along it, from `a`, as a part of its length: `p` taken
// straight across to it, so that along a level or upright line it keeps the coordinate it goes along exactly.
function foot(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy), off = ((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
  return { x: p.x - off * dy / length, y: p.y + off * dx / length, t: ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length) };
}
// The loose ends of what moved, from `before` to `next`, and where each lands: the nearest end of the plates that stayed
// within `reach` of where it rests (in cells), or else the nearest point of one of them between its ends. An end is loose
// where every plate at it moved whole; the ends of plates in one place are one end, and so are those it lands on, which
// it is joined to (`onto`), the first kept. Of two ends that would land in one place, only the nearer does. Nearest first.
function landings(before: AuthoredConstruction, next: AuthoredConstruction, reach: number): Landing[] {
  const was = new Map(before.nodes.map(node => [node.id, node])), at = new Map(next.nodes.map(node => [node.id, node])),
    stayed = (id: string) => was.has(id) && samePlace(was.get(id)!, at.get(id)!),
    whole = new Set(next.plates.filter(plate => !stayed(plate.a) && !stayed(plate.b)).map(plate => plate.id)),
    still = next.plates.filter(plate => stayed(plate.a) && stayed(plate.b)),
    gather = (places: LandingPlace[], id: string) => {
      const node = at.get(id)!, place = places.find(other => samePlace(other, node)) ?? places[places.push({ x: node.x, y: node.y, ids: [] }) - 1]!;
      if (!place.ids.includes(id)) place.ids.push(id);
      return places;
    },
    ends = still.flatMap(plate => [plate.a, plate.b]).reduce(gather, []),
    loose = next.nodes.filter(node => !stayed(node.id) && platesAt(next, node.id).length).map(node => node.id).reduce(gather, [])
      .filter(place => place.ids.every(id => platesAt(next, id).every(plate => whole.has(plate.id)))),
    off = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y), taken: Point[] = [];
  return loose.map(place => {
    const end = ends.filter(end => off(end, place) <= reach).sort((p, q) => off(p, place) - off(q, place))[0];
    if (end) return { ...place, to: { x: end.x, y: end.y }, onto: end.ids, off: off(end, place) };
    const on = still.map(plate => foot(place, at.get(plate.a)!, at.get(plate.b)!))
      .filter(point => point.t > 0 && point.t < 1 && off(point, place) <= reach).sort((p, q) => off(p, place) - off(q, place))[0];
    return on && { ...place, to: { x: on.x, y: on.y }, onto: null, off: off(on, place) };
  }).filter((landing): landing is Landing => Boolean(landing)).sort((p, q) => p.off - q.off)
    .filter(landing => !taken.some(to => off(to, landing.to) <= ON_LINE) && taken.push(landing.to));
}
// New plates laid along an edge: over the stretch from `from` to `to` metres along `path`, the line the edge runs
// along (`points`, as the nodes are written but in metres, from its start), each of its stretches with how far to the
// left of it the new plates stand (`offsets`, in metres). One plate for each straight stretch, sharing their ends at its
// bends; an end that falls where a node already is reuses that node: the gesture named it. Optional snap puts each end
// on the first whole cell clear of the edge (grid.ts `cellClear`), at a bend clear of both its stretches, so that no end
// sinks into a face it lies on. A first or last plate too short to be one is left to the bend beside it.
export function platesAlong(source: AuthoredConstruction, { points, offsets }: PlateEdge, from: number, to: number, { material = 'steel', thicknessMm = 20, snap = false }: PlateStock & { snap?: boolean } = {}) {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i]!.x, point.y - points[i]!.y)),
    starts = lengths.map((_, i) => lengths.slice(0, i).reduce((sum, length) => sum + length, 0)),
    total = starts.at(-1)! + lengths.at(-1)!, low = Math.max(0, Math.min(from, to)), high = Math.min(total, Math.max(from, to)),
    along = (i: number) => ({ x: (points[i + 1]!.x - points[i]!.x) / lengths[i]!, y: (points[i + 1]!.y - points[i]!.y) / lengths[i]! }),
    left = (i: number, base: Point) => { const d = along(i); return { x: base.x - d.y * offsets[i]!, y: base.y + d.x * offsets[i]! }; },
    // Where the plates start, on the stretch they go on along; where they end, on the stretch they came along. At a bend
    // they start or end where the plates on both sides of it meet, as a row laid on over it would.
    at = (u: number, ahead: boolean): EdgeSpot => {
      const corner = starts.findIndex((start, k) => k > 0 && Math.abs(start - u) <= SLACK), meet = corner > 0 ? bend(corner) : null;
      if (meet) return meet;
      const found = ahead ? lengths.findLastIndex((length, i) => starts[i]! <= u + SLACK && starts[i]! + length > u + SLACK)
          : lengths.findIndex((length, i) => starts[i]! < u - SLACK && starts[i]! + length >= u - SLACK),
        i = found < 0 ? (ahead ? 0 : lengths.length - 1) : found, d = along(i), s = Math.max(0, Math.min(lengths[i]!, u - starts[i]!));
      return { ...left(i, { x: points[i]!.x + d.x * s, y: points[i]!.y + d.y * s }), i };
    },
    bend = (k: number): EdgeSpot | null => {
      const d = along(k - 1), e = along(k), cross = d.x * e.y - d.y * e.x;
      if (Math.abs(cross) < 1e-6) return null;
      const p = left(k - 1, points[k]!), q = left(k, points[k]!), s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / cross;
      return { x: p.x + d.x * s, y: p.y + d.y * s, k };
    },
    // The ways out of the edge at a spot: to the left of the stretch it is on, or of each of the two at a bend, as its
    // offset says.
    outward = (spot: EdgeSpot) => (spot.k ? [spot.k - 1, spot.k] : [spot.i!]).map(i => {
      const d = along(i), side = Math.sign(offsets[i]!) || 1; return { x: -d.y * side, y: d.x * side };
    });
  const spots = [at(low, true)];
  for (let k = 1; k < points.length - 1; k++) if (starts[k]! > low + SLACK && starts[k]! < high - SLACK) { const spot = bend(k); if (spot) spots.push(spot); }
  spots.push(at(high, false));
  const span = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y);
  if (spots.length > 2 && span(spots[0]!, spots[1]!) < SHORTEST_PLATE) spots.splice(0, 1);
  if (spots.length > 2 && span(spots.at(-2)!, spots.at(-1)!) < SHORTEST_PLATE) spots.splice(-1, 1);
  const cells = spots.map(spot => {
    const point = { x: unitsOf(spot.x), y: unitsOf(spot.y) };
    return snap ? cellClear(point, outward(spot)) : point;
  });
  if (cells.length < 2 || cells.slice(1).some((cell, i) =>
    (snap ? metresOf(span(cells[i]!, cell)) : span(spots[i]!, spots[i + 1]!)) < SHORTEST_PLATE)) refuse(tr('A chapa precisa ter ao menos 8 cm.'));
  if (source.plates.length + cells.length - 1 > MAX_PLATES) refuse(CAPACITY);
  const next = structuredClone(source), ids = cells.map(cell => {
    const there = next.nodes.find(node => samePlace(node, cell));
    if (there) return there.id;
    const node = { id: fresh(next, 'node'), x: cell.x, y: cell.y };
    next.nodes.push(node); return node.id;
  });
  if (next.nodes.length > MAX_NODES) refuse(CAPACITY);
  const plates = ids.slice(1).map((b, i) => {
    const plate = { id: fresh(next, 'plate'), a: ids[i]!, b, material, thicknessMm };
    next.plates.push(plate); return plate.id;
  });
  return { source: next, plateIds: plates };
}

// The new plates `ids` laid again across the axis, as symmetric editing makes a plate (symmetry.ts): an end where an end
// already stands is that end, and a plate whose ends mirror each other, or whose mirror is there already, is not laid
// again. The ids of those laid.
export function platesAcross(source: AuthoredConstruction, ids: readonly string[]) {
  const next = structuredClone(source), plateIds: string[] = [];
  for (const id of ids) {
    const plate = next.plates.find(plate => plate.id === id);
    if (!plate || plateAcross(next, id) !== null) continue;
    if (next.plates.length >= MAX_PLATES) refuse(CAPACITY);
    const endpoints = ends(next, plate).map(node => {
      const at = mirrored(node), there = next.nodes.find(other => samePlace(other, at));
      if (there) return there.id;
      if (next.nodes.length >= MAX_NODES) refuse(CAPACITY);
      const added = { id: fresh(next, 'node'), x: at.x, y: at.y };
      next.nodes.push(added); return added.id;
    });
    const copy = { ...structuredClone(plate), id: fresh(next, 'plate'), a: endpoints[0]!, b: endpoints[1]! };
    next.plates.push(copy); plateIds.push(copy.id);
  }
  return { source: next, plateIds };
}

export function removePlates(source: AuthoredConstruction, ids: Iterable<string>) {
  const gone = new Set(ids), next = structuredClone(source);
  next.plates = next.plates.filter(plate => !gone.has(plate.id));
  return dropLoose(next);
}

export function assemblySelection(source: AuthoredConstruction, ids: Iterable<string>) {
  const selected = new Set(ids);
  return [...source.plates, ...source.components].filter(part => selected.has(part.id)).map(part => part.id);
}

// The selected plates and components, and the selected points `nodeIds`, moved (dx, dy) cells: each plate end or point
// takes every exactly coincident end with it. In symmetric editing the plates and points `turned`
// (symmetry.ts symmetricMove) go too, the other way across, and an end on the axis goes only up or down.
export function moveFrameSelection(source: AuthoredConstruction, ids: Iterable<string>, dx: number, dy: number, nodeIds: readonly string[] = [], turned: TurnedSelection | null = null) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) refuse(tr('Deslocamento inválido.'));
  if (!dx && !dy) return source;
  const shared = (id: string) => [id, ...coincidentNodes(source, id)],
    reflected = new Set([...turned?.nodes ?? []].flatMap(shared));
  const selected = new Set([...assemblySelection(source, ids), ...turned?.plates ?? []]),
    points = new Set([...nodeIds.flatMap(shared), ...reflected].filter(id => nodeOf(source, id))),
    next = structuredClone(source);
  // How far across each end goes: with the pointer, unless only what is turned takes it.
  const ways = new Map<string, number>(), way = (id: string, value: number) => ways.set(id, Math.max(ways.get(id) ?? -1, value));
  for (const plate of source.plates) if (selected.has(plate.id)) for (const end of [plate.a, plate.b])
    for (const id of shared(end)) way(id, turned?.plates.has(plate.id) ? -1 : 1);
  for (const id of points) way(id, reflected.has(id) ? -1 : 1);
  for (const node of next.nodes) if (ways.has(node.id)) {
    const across = turned && onAxis(node.x) ? 0 : ways.get(node.id)! * dx;
    if (across) node.x += across;
    if (dy) node.y += dy;
  }
  for (const part of next.components) if (selected.has(part.id))
    part.pose = { ...part.pose, x: part.pose.x + dx, y: part.pose.y + dy };
  return carryPlateWeapons(source, dropLoose(next));
}

// This action removes that room's external walls. Contents, neighbouring rooms
// and disconnected pieces stay; no support or ownership cascade is inferred.
export function removeRoom(source: AuthoredConstruction, compiled: CompiledConstruction, plateId: string) {
  const room = compiled.rooms.find(room => room.walls.some(wall => wall.id === plateId && wall.exterior));
  if (!room) refuse(tr('Esta chapa não fecha um compartimento por fora.'));
  const shared = new Set(compiled.rooms.filter(other => other !== room).flatMap(other => other.walls.map(wall => wall.id)));
  return removePlates(source, room.walls.filter(wall => !shared.has(wall.id)).map(wall => wall.id));
}

export const carriesRoom = <Wall extends RoomWall>(wall: Wall | null | undefined): wall is Wall => Boolean(wall?.a && wall?.b && Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) > SLACK);
// The stretch of a face (in field metres) a room of `length` grows from, about `point`. Feet stay exactly on the face;
// optional snap steps the length and displacement along it by 5 cm. A remainder shorter than a plate joins the room.
export function roomSpan<W extends RoomWall>(wall: W, point: Point, length = 1.8, { snap = false } = {}) {
  const least = snap ? Math.ceil(unitsOf(SHORTEST_PLATE)) * CELL : SHORTEST_PLATE,
    size = Math.min(wall.length, Math.max(least, snap ? metresOf(cellOf(length)) : length));
  if (wall.length - size < least - SLACK) return wall;
  const at = closestSegment(point, wall.a, wall.b).t * wall.length,
    middle = at - size / 2,
    wanted = Math.max(0, Math.min(wall.length - size, snap ? metresOf(cellOf(middle)) : middle)),
    start = wanted < least - SLACK ? 0 : wanted,
    end = wall.length - (wanted + size) < least - SLACK ? wall.length : wanted + size,
    along = (value: number) => value === 0 ? wall.a : value === wall.length ? wall.b :
      ({ x: wall.a.x + (wall.b.x - wall.a.x) * value / wall.length,
        y: wall.a.y + (wall.b.y - wall.a.y) * value / wall.length });
  return { ...wall, a: along(start), b: along(end), length: end - start,
    aId: start < SLACK ? wall.aId : null, bId: end > wall.length - SLACK ? wall.bId : null };
}

function growthDirection(wall: RoomWall, from: Point, to: Point | null) {
  let normal = wall.normal || { x: wall.b.y - wall.a.y, y: wall.a.x - wall.b.x };
  if (!wall.normal && to && normal.x * (to.x - from.x) + normal.y * (to.y - from.y) < 0)
    normal = { x: -normal.x, y: -normal.y };
  return Math.abs(normal.x) > Math.abs(normal.y) ? { x: Math.sign(normal.x), y: 0 } : { x: 0, y: Math.sign(normal.y) };
}
export function drawRoom(source: AuthoredConstruction, compiled: CompiledConstruction, wall: RoomWall, from: Point, to: Point | null, { snap = false } = {}): RoomDrawing | { refusal?: string; source?: never } {
  if (!carriesRoom(wall)) return { refusal: tr('Escolha uma face externa para criar um compartimento.') };
  const floor = wall.bed ? 1 : 0, missing = [wall.aId, wall.bId].filter(id => !id).length;
  if (source.nodes.length + 2 + missing > MAX_NODES || source.plates.length + 3 + floor > MAX_PLATES) return { refusal: CAPACITY };
  // Feet keep the face's exact positions. Only depth is rounded when the player enables snap.
  const origin = compiled.frame.origin, out = growthDirection(wall, from, to), smallest = unitsOf(SMALLEST_ROOM),
    localPoint = (point: Point): Point => ({ x: unitsOf(point.x - origin.x), y: unitsOf(point.y - origin.y) }), a = localPoint(wall.a), b = localPoint(wall.b),
    room = out.y > 0 ? REACH_CELLS.maxY - Math.max(a.y, b.y) : out.y < 0 ? Math.min(a.y, b.y) - REACH_CELLS.minY
      : out.x > 0 ? REACH_CELLS.maxX - Math.max(a.x, b.x) : Math.min(a.x, b.x) - REACH_CELLS.minX;
  if (room < smallest - SLACK)
    return { refusal: out.y < 0 ? tr('A estrutura já chegou ao chão.') : tr('A estrutura já chegou ao limite de construção desse lado.') };
  const requested = to ? (to.x - from.x) * out.x + (to.y - from.y) * out.y : OFFERED_DEPTH,
    pulled = snap ? cellOf(requested) : unitsOf(requested),
    depth = Math.min(room, pulled);
  if (depth < smallest - SLACK) return {};
  const next = structuredClone(source), name = fresh(next, 'bay'), names = new Set<string>(),
    nodes = [a, b].map((point, i) => ({ id: `${name}-${i}`, x: point.x + out.x * depth, y: point.y + out.y * depth })),
    feet = [a, b].flatMap((point, i) => [wall.aId, wall.bId][i] ? [] : [{ id: `${name}-${i + 2}`, ...point }]),
    corners = [{ id: wall.aId || `${name}-2`, ...a }, nodes[0]!, nodes[1]!, { id: wall.bId || `${name}-3`, ...b }],
    plates = [0, 1, 2, 3].slice(0, 3 + floor).map(i => {
      const p = corners[i]!, q = corners[(i + 1) % 4]!, way = { x: q.y - p.y, y: p.x - q.x },
        wanted = Math.abs(way.y) >= Math.abs(way.x) ? way.y > 0 ? 'roof' : 'under' : way.x < 0 ? 'front' : 'rear';
      let side: string = wanted; for (let count = 2; names.has(side); count++) side = wanted + count;
      names.add(side);
      return { id: `${name}:${side}`, a: p.id, b: q.id, material: wall.material, thicknessMm: wall.thicknessMm };
    });
  next.nodes.push(...feet, ...nodes); next.plates.push(...plates);
  return { source: next, length: wall.length, depth: metresOf(depth), plates: plates.map(plate => plate.id),
    polygon: [wall.a, ...nodes.map(node => ({ x: metresOf(node.x) + origin.x, y: metresOf(node.y) + origin.y })), wall.b] };
}

