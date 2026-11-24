import { worldToLocal } from './math.ts';
import { isRunningGear } from './assembly.ts';
import type { Point, Pose } from './math.ts';
import type { DrawingScene, DrawingModule } from './scene-drawing-contract.ts';
import type { SceneSample } from './scene-frame.ts';

type CoverageModule = Point & Pick<DrawingModule, 'kind' | 'attached'>;
interface HullFace { actorId?: string | undefined; localPolygon?: readonly Point[] | undefined; pose?: Pose | undefined }
type CoverageScene = Pick<SceneSample<DrawingScene>, 'frame' | 'actor' | 'pose'>;
type CoverageState = Pick<DrawingScene, 'bodyPanels'>;

const NOTHING = new Set<string>();
// Whether a polygon holds a point, both in one frame.
export function polygonHolds(polygon: readonly Point[], point: Point): boolean {
  let within = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < a.x + (point.y - a.y) / (b.y - a.y) * (b.x - a.x)) within = !within;
  }
  return within;
}
// Whether a point of the world is within a face of a hull standing as `hull` says.
export function faceHolds(face: Pick<HullFace, 'localPolygon'>, hull: Pose | null | undefined, point: Point): boolean {
  if (!face.localPolygon || !hull) return false;
  const at = worldToLocal(hull, point);
  return polygonHolds(face.localPolygon, { x: at.u, y: at.v });
}
// Whether a face of a hull, standing as `hull` says, covers a module that is at `place`: its middle is within
// the face. What sits on the armour — a sensor, a tank or a load carried out in the open — is outside, and so are
// the running gear and a weapon, which reaches out through the armour or stands on it; what came loose is no
// longer within. The field tells another faction no module a face
// covers but extraction mechanisms and builders (server/fog.ts), whose arms work outside; cargo containers inside remain hidden.
const within = (module: CoverageModule): boolean => !(module.kind === 'weapon' || module.attached === false || isRunningGear(module));
export function faceCovers(face: Pick<HullFace, 'localPolygon'>, hull: Pose | null | undefined, module: CoverageModule, place: Point = module): boolean {
  return within(module) && faceHolds(face, hull, place);
}
// What the skin of a hull covers, of the constructions seen from outside only (`closed` names them). The design on the
// bench (`designFaces`, its faces where the bench lays them) is the construction 'local'.
export function coveredParts(state: CoverageState, closed: ReadonlySet<string> | null | undefined, scene: CoverageScene,
  unseen: ReadonlySet<string> | null = null, designFaces: readonly { poly: readonly Point[] }[] | null = null): Set<string> {
  if (!closed?.size) return NOTHING;
  const covered = new Set<string>(), frame = scene.frame;
  if (designFaces) {
    if (!closed.has('local')) return NOTHING;
    for (const face of designFaces) for (const part of frame.parts)
      if (part.type === 'module' && !covered.has(part.id) && within(part.data) && polygonHolds(face.poly, scene.pose(part.id)!)) covered.add(part.id);
    return covered;
  }
  for (const face of state.bodyPanels || []) {
    if (!closed.has(face.actorId!) || unseen?.has(face.actorId!)) continue;
    const hull = scene.actor(face.actorId) || face.pose;
    for (const part of frame.actorParts.get(face.actorId!) || [])
      if (part.type === 'module' && !covered.has(part.id) && faceCovers(face, hull, part.data, scene.pose(part.id)!)) covered.add(part.id);
  }
  return covered;
}
