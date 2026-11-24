import { closestSegment, localToWorld, worldToLocal, clamp } from './math.ts';
import { sampleScene, posePart } from './scene-frame.ts';
import { plateDetails } from './vehicle-details.ts';
import type { Point, Pose, PlateGeometry } from './math.ts';
import type { SurfaceMark } from './scene-contract.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { SceneFrame, SceneFramePart } from './scene-frame.ts';
import type { HullScene } from './hull-details.ts';

export interface BodyFace { id: string; actorId?: string | undefined; poly?: readonly Point[] | undefined; localPolygon?: readonly Point[] | undefined; pose?: Pose | undefined }
export interface BodyPanelSample<Source extends DrawingScene = DrawingScene> {
  frame: SceneFrame<Source>; pose(id: string): Pose | null; actor(id: string | undefined): Pose | null;
}
export interface BodyBackingMark extends SurfaceMark, Point { radius: number; angle: number }
export interface BodyFittingScene extends HullScene {
  front: number; vehicle: boolean; cast: boolean; seed: string; manualDetails: boolean; automaticDetails: boolean;
  pieces: NonNullable<HullScene['pieces']>; details: NonNullable<HullScene['details']>; rooms: NonNullable<HullScene['rooms']>;
}
export interface UnseenBodyPanel {
  id: string; actorId: string | undefined; artPolygon?: never; artPose?: never; paint?: never;
  marks?: never; settled?: never; fittings?: never;
}
export interface PaintedBodyPanel {
  id: string; actorId: string | undefined; artPolygon: readonly Point[]; artPose: Pose | null | undefined; paint: number;
  marks: BodyBackingMark[]; settled: boolean; fittings(covered?: ReadonlySet<string> | null): BodyFittingScene;
}
export type BodyPanelSurface = UnseenBodyPanel | PaintedBodyPanel;
const posedVehicle = (vehicle: DrawingScene['actors'][number]['vehicle']): vehicle is NonNullable<typeof vehicle> & Pose => Boolean(vehicle &&
  typeof vehicle.x === 'number' && Number.isFinite(vehicle.x) && typeof vehicle.y === 'number' && typeof vehicle.angle === 'number');

// One authored plate may close only a stretch of a room, or border several rooms. Its middle need not touch any
// of them. Match real overlapping parallel edges, including stock extending past the authored junctions.
function plateBorders(contour: readonly Point[], plate: PlateGeometry, body: Pose | null): boolean {
  const at = body ? worldToLocal(body, plate) : { u: plate.x, v: plate.y },
    angle = plate.angle - (body?.angle || 0), c = Math.cos(angle), s = Math.sin(angle), half = plate.length / 2,
    local = (p: Point) => ({ u: (p.x - at.u) * c + (p.y - at.v) * s, v: -(p.x - at.u) * s + (p.y - at.v) * c }),
    reach = (plate.thicknessMm || 0) / 2000 + .08;
  return contour.some((point, i) => {
    const a = local(point), b = local(contour[(i + 1) % contour.length]!), span = Math.hypot(b.u - a.u, b.v - a.v);
    return span > 1e-6 && Math.abs(a.v - b.v) < span * .001 && Math.abs(a.v) <= reach && Math.abs(b.v) <= reach
      && Math.min(half, Math.max(a.u, b.u)) - Math.max(-half, Math.min(a.u, b.u)) > 1e-6;
  });
}

// What the fittings of a face are placed by (hull-details.ts), in the frame of its outline: the way its construction
// faces, whether it drives, whether it is cast in concrete, its other rooms and the pieces it carries, these to the tenth
// of a millimetre. A face of the field is in the frame of its vehicle, and of a structure where it was built; one of the
// bench is in the frame of the design, which faces left. Outside, the renderer's existing covered set omits private
// pieces before this scene and its artwork key are made; the open interior keeps all its pieces.
function fittingScene<Source extends DrawingScene>(frame: SceneFrame<Source>, face: BodyFace, faces: readonly BodyFace[], actor: Source['actors'][number] | undefined, covered?: ReadonlySet<string> | null): BodyFittingScene {
  const parts = frame.actorParts.get(face.actorId || 'local') || [], vehicle = actor?.vehicle,
    body = face.localPolygon ? posedVehicle(vehicle) ? vehicle : face.pose : null,
    fix = (v: number): number => Math.round(v * 1e4) / 1e4, pieces: NonNullable<HullScene['pieces']>[number][] = [];
  let concrete = 0, total = 0;
  for (const part of parts) {
    if (part.type === 'plate') { const data = part.data, length = data.definition?.length || 0; total += length; if (data.material === 'concrete') concrete += length; continue; }
    const data = part.data;
    if (data.attached === false || covered?.has(part.id)) continue;
    const at = body ? worldToLocal(body, data) : { u: data.x, v: data.y };
    pieces.push({ kind: data.kind, x: fix(at.u), y: fix(at.v), w: data.width, h: data.height, angle: fix((data.angle || 0) - (body?.angle || 0)), exposed: Boolean(data.exposed) });
  }
  const contour = face.localPolygon || face.poly, appearance = actor?.appearance,
    details = plateDetails(parts, actor, 'body').flatMap(detail => {
      const plate = detail.plate?.data.definition;
      // Anchor walls identify their room; a detail never bleeds onto another closed skin.
      if (detail.space !== 'project' && !plateBorders(contour!, plate!, body || null)) return [];
      const p = body ? worldToLocal(body, detail) : { u: detail.x, v: detail.y };
      return [{ kind: detail.kind, x: fix(p.u), y: fix(p.v), angle: fix(detail.angle - (body?.angle || 0)),
        width: detail.width, height: detail.height, mirrored: detail.mirrored, text: detail.text }];
    });
  return { front: actor?.facing ?? -1, vehicle: Boolean(actor?.vehicle && actor.vehicle.enabled !== false), cast: concrete > total / 2,
    seed: Array.isArray(appearance?.details) ? 'authored' : face.actorId || 'local', pieces,
    manualDetails: Array.isArray(appearance?.details), automaticDetails: appearance?.automaticDetails === undefined, details,
    rooms: faces.filter(other => other !== face && (other.actorId || 'local') === (face.actorId || 'local')).map(other => (other.localPolygon || other.poly)!) };
}

// Every hull has its skin. `unseen` names the actors nobody looks at: a panel of theirs is told by what it is, with
// nothing worked out for it. A face of the field is `settled`: what its fittings are placed by (`fittings`) is asked once
// for it, for the pieces of a vehicle on the move are where its pose puts them, a hair apart from frame to frame.
export function bodyPanelSurfaces<Source extends DrawingScene>(state: Source, designFaces: readonly { poly: readonly Point[] }[] | null = null,
  previous: Source | null = null, alpha = 1, scene: BodyPanelSample<Source> = sampleScene(state, previous, alpha), unseen: ReadonlySet<string> | null = null): BodyPanelSurface[] {
  const frame = scene.frame;
  const faces: readonly BodyFace[] = designFaces ? designFaces.map((f, i) => ({ id: 'design-' + i, actorId: 'local', poly: f.poly })) : state.bodyPanels || [];
  const previousFaces = new Map((previous?.bodyPanels || []).map(f => [f.id, f]));
  const result: BodyPanelSurface[] = [];
  for (const face of faces) {
    const actor = frame.actors.get(face.actorId || 'local');
    const appearance = actor ? actor.appearance : state.appearance;
    const contour = face.localPolygon || face.poly;
    if (!contour || contour.length < 3) continue;
    if (unseen?.has(face.actorId || 'local')) { result.push({ id: face.id, actorId: face.actorId }); continue; }
    const old = previousFaces.get(face.id), pose = face.pose && (scene.actor(face.actorId) || posePart(face.pose, old?.pose, alpha)),
      marked = (face.actorId ? frame.actorParts.get(face.actorId) || [] : frame.parts).filter((part): part is Extract<SceneFramePart<Source>, { type: 'plate' }> => Boolean(part.type === 'plate' && part.data.marks?.length)),
      marks: BodyBackingMark[] = [];
    if (marked.length) {
      const poly = face.localPolygon ? face.localPolygon.map(p => localToWorld(pose!, p.x, p.y)) : face.poly!,
        cx = poly.reduce((s, p) => s + p.x, 0) / poly.length, cy = poly.reduce((s, p) => s + p.y, 0) / poly.length,
        markSlots = new Map<string, number>();
      for (const part of marked) {
        const plate = part.data, platePose = scene.pose(part.id)!;
        for (let i = Math.max(0, plate.marks.length - 16); i < plate.marks.length; i++) {
          const m = plate.marks[i]!, p = localToWorld(platePose, (m.u - 0.5) * plate.definition.length, (0.5 - m.v) * plate.definition.thicknessMm / 1000);
          let nearEdge = false;
          for (let edge = 0; edge < poly.length; edge++) {
            const q = closestSegment(p, poly[edge]!, poly[(edge + 1) % poly.length]!);
            if (Math.hypot(q.x - p.x, q.y - p.y) <= .25) { nearEdge = true; break; }
          }
          if (!nearEdge) continue;
          const length = Math.hypot(cx - p.x, cy - p.y) || 1,
            radius = Math.max(.002, m.radius || (m.kind === 'hole' ? .025 : .014) + .014 * Math.sqrt(clamp(m.strength ?? 1, .05, 3))),
            inward = radius * .65,
            mark = { ...m, x: p.x + (cx - p.x) / length * inward, y: p.y + (cy - p.y) / length * inward,
              radius, angle: platePose.angle },
            key = `${part.id}:${m.kind}:${m.u.toFixed(4)}:${m.v.toFixed(4)}`,
            slot = markSlots.get(key);
          // Repeated hits at the same material coordinate share one backing
          // decal. Retain a measured footprint instead of stacking or inflating
          // circles; the physical plate still owns all of its impact records.
          if (slot !== undefined) { if (radius >= marks[slot]!.radius) marks[slot] = mark; }
          else { markSlots.set(key, marks.length); marks.push(mark); }
        }
      }
    }
    result.push({ id: face.id, actorId: face.actorId, artPolygon: contour, artPose: face.localPolygon ? pose : null,
      paint: Number.parseInt((appearance?.paint || '#68765a').slice(1), 16), marks,
      settled: Boolean(face.localPolygon), fittings: covered => fittingScene(frame, face, faces, actor, covered) });
  }
  return result;
}
