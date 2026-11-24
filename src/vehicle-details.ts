import type { MessageKey } from './message-contract.ts';
import type { Point, Pose } from './math.ts';
import type { AuthoredDetail, ConstructionAppearance, CompiledConstruction } from './construction-contract.ts';
import type { ModuleKind } from './materials.ts';
import type { DrawingActor, DrawingScene } from './scene-drawing-contract.ts';
import type { FramePart } from './scene-frame.ts';
type DetailFramePart = FramePart<CompiledConstruction | DrawingScene>;
type DetailActor = Pick<DrawingActor, 'id' | 'appearance' | 'mirror' | 'x' | 'y' | 'revision' | 'vehicle'>;

export type DetailSurface = AuthoredDetail['surface'];
export interface DetailHost { surface: DetailSurface; host: string; name: string; pose: Pose; polygon: readonly Point[]; hosts: string[]; origin?: Point; mirrored?: boolean | undefined; covered?: boolean; anchors?: ReadonlyMap<string, Pose> }
export type DetailHosts = DetailHost[] & { origin?: Point };
export interface DetailGroup { details: readonly AuthoredDetail[]; key: string; lettering: boolean }
export interface DetailBasis { origin: Point; along: Point; up: Point; mirrored?: boolean }
import { localToWorld, worldToLocal, rectangle } from './math.ts';
import { componentPolygon } from './assembly.ts';
import { within, hullLayout } from './hull-details.ts';
import { MODULES } from './materials.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';

// A closed catalogue shared with native admission. Drawings are code-owned; a project carries only these identifiers
// and bounded poses, never images, paths, shaders or scripts. Poses use fixed project space or a component's frame.
export const DETAIL_LIMIT = 32;
const entry = <const Name extends MessageKey>(name: Name, width: number, height: number, maxScale = 2) => Object.freeze({ name, width, height, minScale: .5, maxScale });
export const VEHICLE_DETAILS = Object.freeze({
  'cab-door': entry('Porta com janela', 1.12, 1), 'cab-step': entry('Degraus', .62, .14),
  'industrial-door': entry('Porta de máquina', 1.10, 1.35),
  'armour-door': entry('Porta de viatura blindada', .7, .95), 'access-hatch': entry('Escotilha lateral', .65, .7),
  'service-panel': entry('Painel de manutenção', .85, .5), periscope: entry('Cabeça de periscópio', .14, .09),
  exhaust: entry('Saída de escape protegida', .6, .18),
  engine: entry('Grelha de ventilação', .8, .24, 2.5), hatch: entry('Escotilha', .62, .085),
  handle: entry('Alça', .26, .07), filler: entry('Tampa de abastecimento', .14, .12),
  tools: entry('Ferramentas presas', 1.1, .15), cable: entry('Cabo de reboque guardado', 1.8, .08, 2),
  cans: entry('Galão', .42, .52), bin: entry('Caixa externa', .8, .4),
  eye: entry('Olhal', .1, .1), ring: entry('Argola', .08, .08),
  marker: entry('Refletor', .07, .04), shackle: entry('Manilha', .2, .2),
  headlight: entry('Farol', .3, .17), taillight: entry('Lanterna traseira', .16, .12),
  number: entry('Número', .34, .2),
});
export type DetailKind = keyof typeof VEHICLE_DETAILS;
export const detailCatalogue = () => ({ limit: DETAIL_LIMIT, kinds: VEHICLE_DETAILS });
const groups = new WeakMap<ConstructionAppearance, Map<string, DetailGroup>>(), EMPTY_GROUP = Object.freeze({ details: Object.freeze([]), key: '', lettering: false });
// Appearance is an immutable cold profile, held by the existing network protocol. Group and stringify it once;
// ordinary movement, cargo changes, cropped tool pictures and zoom reuse these small records.
export function detailGroup(appearance: ConstructionAppearance | null | undefined, surface: DetailSurface, host: string | null = ''): DetailGroup {
  if (!appearance?.details?.length || host === null) return EMPTY_GROUP;
  let grouped = groups.get(appearance);
  if (!grouped) {
    const byHost = new Map<string, AuthoredDetail[]>();
    for (const detail of appearance.details) for (const key of [detail.surface, `${detail.surface}:${detail.host}`]) {
      if (!byHost.has(key)) byHost.set(key, []);
      byHost.get(key)!.push(detail);
    }
    grouped = new Map([...byHost].map(([key, details]) => [key, { details, key: JSON.stringify(details), lettering: details.some(d => d.kind === 'number') }]));
    groups.set(appearance, grouped);
  }
  return grouped.get(host ? `${surface}:${host}` : surface) || EMPTY_GROUP;
}
export const DETAIL_PARTS = new Set<ModuleKind>(['engine', 'fuel', 'ammo', 'command', 'hopper', 'cistern', 'supply', 'excavator', 'drill', 'builder', 'blade', 'paver']);
export const detailAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
export const detailPose = (host: DetailHost, detail: AuthoredDetail) => {
  if (detail.space === 'project') {
    const origin = host.origin || VEHICLE_ORIGIN;
    return { x: origin.x + detail.x, y: origin.y + detail.y, angle: detail.angle, mirrored: Boolean(detail.mirrored) };
  }
  const sign = host.mirrored ? -1 : 1, p = localToWorld(host.pose, sign * detail.x, detail.y);
  return { ...p, angle: detailAngle(host.pose.angle + sign * detail.angle), mirrored: Boolean(detail.mirrored) !== Boolean(host.mirrored) };
};
export function detailAt(host: DetailHost, point: Point, kind: DetailKind, id: string, more: Partial<AuthoredDetail> = {}): AuthoredDetail {
  const project = host.surface !== 'part', pose = project ? { ...(host.origin || VEHICLE_ORIGIN), angle: 0 } : host.pose,
    at = worldToLocal(pose, point), spec = VEHICLE_DETAILS[kind], sign = project ? 1 : host.mirrored ? -1 : 1;
  return { id, kind, surface: host.surface, host: host.host, x: sign * at.u, y: at.v, angle: detailAngle(-sign * host.pose.angle),
    width: spec.width, height: spec.height, ...(project ? { space: 'project', angle: 0 } : {}),
    ...(host.mirrored && !project ? { mirrored: true } : {}), ...(kind === 'number' ? { text: '01' } : {}), ...more };
}
// Field identifiers are qualified once at installation; the compact blueprint keeps only authored ids.
export function detailPartId(part: { id?: string | undefined }, actor?: { id?: string | undefined; revision?: number | string | undefined } | null) {
  if (!part.id) return null;
  const prefix = `${actor?.id}:${actor?.revision}:`;
  return part.id.startsWith(prefix) ? part.id.slice(prefix.length) : part.id;
}
// A plate's stock direction is preserved by reflection. Its normal changes sign; artwork reflects horizontally.
export function plateDetailPose(pose: Pose, detail: AuthoredDetail, mirror = 1) {
  return { ...localToWorld(pose, detail.x, mirror * detail.y),
    angle: detailAngle(pose.angle + mirror * detail.angle + (mirror < 0 ? Math.PI : 0)),
    mirrored: Boolean(detail.mirrored) !== (mirror < 0) };
}
export function detailInBasis(detail: AuthoredDetail, { origin, along, up, mirrored = false }: DetailBasis) {
  const dx = detail.x - origin.x, dy = detail.y - origin.y, angle = Math.atan2(along.y, along.x), sign = mirrored ? -1 : 1;
  // The chassis art reflects its vertical axis; stamps reflect their horizontal one. Compensate the half turn.
  return { ...detail, x: dx * along.x + dy * along.y, y: dx * up.x + dy * up.y,
    angle: detailAngle(sign * (detail.angle - angle) + (mirrored ? Math.PI : 0)),
    mirrored: Boolean(detail.mirrored) !== mirrored };
}
export function plateDetails<Part extends DetailFramePart>(parts: readonly Part[], actor: DetailActor | null | undefined, surface: DetailSurface, poseOf: (part: Extract<Part, { type: 'plate' }>) => Pose = part => part.definition, actorPose: Pose | null = null) {
  const details = detailGroup(actor?.appearance, surface).details;
  if (!details?.length || !actor) return [];
  const hosts = new Map(parts.filter((p): p is Extract<Part, { type: 'plate' }> => p.type === 'plate' && (!('attached' in p.data) || p.data.attached !== false)).map(p => [detailPartId(p, actor), p]));
  return details.filter(d => d.surface === surface && (d.space === 'project' || hosts.has(d.host))).map(d => {
    if (d.space !== 'project') return { ...d, ...plateDetailPose(poseOf(hosts.get(d.host)!), d, actor.mirror ?? 1), plate: hosts.get(d.host)! };
    const vehicle = actor.vehicle, sign = actor.mirror ?? 1, body = actorPose || (vehicle && typeof vehicle.x === 'number' && Number.isFinite(vehicle.x) && typeof vehicle.y === 'number' && typeof vehicle.angle === 'number' ? { x: vehicle.x, y: vehicle.y, angle: vehicle.angle } :
      { x: actor.x ?? VEHICLE_ORIGIN.x, y: actor.y ?? VEHICLE_ORIGIN.y, angle: 0 }),
      point = localToWorld(body, sign * d.x, d.y);
    return { ...d, ...point, angle: detailAngle((body.angle || 0) + sign * d.angle),
      mirrored: Boolean(d.mirrored) !== (sign < 0), plate: hosts.get(d.host) || null };
  });
}
export function detailHosts(blueprint: CompiledConstruction, exterior = true): DetailHost[] {
  const plates = new Map(blueprint.plates.map(p => [p.id, p]));
  const body = blueprint.rooms.flatMap<DetailHost>(room => {
    const wall = room.walls.find(w => w.exterior && plates.has(w.id));
    if (!wall) return [];
    return [{ surface: 'body', host: wall.id, name: 'Carroceria', pose: plates.get(wall.id)!, polygon: room.polygon,
      hosts: room.walls.map(w => w.id) }];
  });
  const chassis = blueprint.plates.filter(p => p.chassis?.part === 'frame').map<DetailHost>(p => ({ surface: 'chassis', host: p.id, name: 'Chassi', pose: p,
    polygon: blueprint.chassis?.outlines.find(poly => within(p, poly)) || [], hosts: [p.id] }));
  const parts = blueprint.modules.filter(p => DETAIL_PARTS.has(p.kind)).map<DetailHost>(p => ({ surface: 'part', host: p.id, name: MODULES[p.kind].name,
    pose: p, mirrored: p.mirrored, polygon: componentPolygon(p), hosts: [p.id], covered: !p.exposed && body.some(h => within(p, h.polygon)) }));
  return exterior ? [...chassis, ...parts.filter(p => p.covered), ...body, ...parts.filter(p => !p.covered)] : [...chassis, ...body, ...parts];
}
export function hostForDetail(hosts: DetailHosts, detail: AuthoredDetail): DetailHost | null {
  if (detail.space === 'project') {
    const origin = hosts.origin || VEHICLE_ORIGIN, point = { x: origin.x + detail.x, y: origin.y + detail.y },
      host = hosts.find(h => h.surface === detail.surface && within(point, h.polygon)) || hosts.find(h => h.surface === detail.surface && h.hosts.includes(detail.host));
    return { ...(host || { surface: detail.surface, name: 'Superfície temporariamente ausente', polygon: [], hosts: [detail.host] }),
      host: detail.host, origin, pose: { ...origin, angle: 0 }, mirrored: false };
  }
  const host = hosts.find(h => h.surface === detail.surface && h.hosts.includes(detail.host));
  if (!host) return null;
  if (host.host === detail.host) return host;
  // A body can be anchored to any of its authored walls, not only the wall chosen as its selection handle.
  return host.anchors?.get(detail.host) ? { ...host, host: detail.host, pose: host.anchors.get(detail.host)! } : host;
}
export function editableDetailHosts(blueprint: CompiledConstruction, exterior = true): DetailHosts {
  const anchors = new Map(blueprint.plates.map(p => [p.id, p]));
  return Object.assign(detailHosts(blueprint, exterior).map(h => ({ ...h, anchors, origin: blueprint.frame.origin })), { origin: blueprint.frame.origin });
}
export function detailHostAt(hosts: readonly DetailHost[], point: Point) {
  // Visible equipment wins over its skin; the skin wins over the frame underneath it.
  return [...hosts].reverse().find(h => within(point, h.polygon)) || null;
}
export function detailCorners(host: DetailHost, detail: AuthoredDetail) {
  const p = detailPose(host, detail);
  return rectangle(p.x, p.y, detail.width, detail.height, p.angle);
}
export function pickDetail(hosts: DetailHosts, details: readonly AuthoredDetail[], point: Point) {
  return [...details].reverse().find(d => {
    const host = hostForDetail(hosts, d);
    return host && within(point, host.polygon) && within(point, detailCorners(host, d));
  }) || null;
}
// Materialize procedural finish once, in fixed project coordinates. Geometry edits keep these bounded stamps;
// enabling automatic generation again may replace only those marked automatic.
export function legacyDetails(blueprint: CompiledConstruction, { existing = [], limit = DETAIL_LIMIT, automatic = false }: { existing?: readonly AuthoredDetail[]; limit?: number; automatic?: boolean } = {}): AuthoredDetail[] {
  const hosts = editableDetailHosts(blueprint), details: AuthoredDetail[] = [], pieces = blueprint.modules.map(p => ({
    kind: p.kind, x: p.x, y: p.y, w: p.width, h: p.height, angle: p.angle || 0, exposed: Boolean(p.exposed) }));
  const occupied = existing.flatMap(detail => {
    const host = hostForDetail(hosts, detail);
    return host && detail.surface === 'body' ? [{ ...detail, ...detailPose(host, detail) }] : [];
  }), used = new Set(existing.map(detail => detail.id));
  for (const room of blueprint.rooms) {
    const host = hosts.find(h => h.surface === 'body' && h.polygon === room.polygon);
    if (!host) continue;
    const cast = room.walls.filter(w => w.material === 'concrete').length > room.walls.length / 2,
      layout = hullLayout(room.polygon, { front: -1, vehicle: Boolean(blueprint.vehicle?.enabled), cast, pieces,
        rooms: blueprint.rooms.filter(r => r !== room).map(r => r.polygon), details: occupied, seed: 'local' });
    for (const fitting of layout.fittings) {
      if (details.length >= limit) return details;
      const spec = VEHICLE_DETAILS[fitting.kind];
      if (!spec) continue;
      let serial = details.length + 1, id;
      do { id = `${automatic ? 'auto' : 'finish'}-${serial++}`; } while (used.has(id)); used.add(id);
      details.push(detailAt(host, fitting, fitting.kind, id, {
        width: Math.max(spec.width * spec.minScale, Math.min(spec.width * spec.maxScale, fitting.w)),
        height: Math.max(spec.height * spec.minScale, Math.min(spec.height * spec.maxScale, fitting.h)),
        ...(fitting.flip ? { mirrored: true } : {}), ...(fitting.text ? { text: fitting.text } : {}),
        ...(automatic ? { automatic: true } : {}),
      }));
    }
  }
  return details;
}
export function automaticFinish(blueprint: CompiledConstruction, regenerate = false): ConstructionAppearance {
  const appearance = blueprint.appearance || {}, kept = (appearance.details || []).filter(detail => !regenerate || !detail.automatic);
  return { ...appearance, automaticDetails: true,
    details: [...kept, ...legacyDetails(blueprint, { existing: kept, limit: DETAIL_LIMIT - kept.length, automatic: true })] };
}
