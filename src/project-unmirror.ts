import { detailAngle } from './vehicle-details.ts';

// Temporary: a project kept from when the workshop could turn a whole design about ("Espelhar projeto") has its chassis
// marked `mirrored`, the nose and the gear drawn at its rear, while the vehicle drove towards its first point all the same:
// it went tail first. Such a project is read once the right way round, its front where its nose is, as the design that
// turning it about once more makes of it, and kept so in the garage of a browser (library.ts). It leaves, in a commit of
// its own, once the players have opened the game. Nothing else reads the mark.
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const records = (values: readonly unknown[], place: string): Record<string, unknown>[] => values.map(value => {
  if (!record(value)) throw new TypeError(`Invalid legacy project ${place}.`);
  return value;
});
const negate = (value: unknown): number => value ? -Number(value) : 0;
const otherHand = (value: Record<string, unknown>) => {
  const { mirrored: parity, ...rest } = value;
  return { ...rest, ...(!parity ? { mirrored: true } : {}) };
};

// The project `project` with its front at its first point: the whole design turned about its fixed vertical reference,
// each piece of equipment and detail of the other hand, the points of the chassis in ascending order again and its mark
// gone. Authored identities and the direction of each plate's stock stay; any other project as it is.
export function unmirrored(project: unknown): unknown {
  // One that is not a project of the workshop is left for the core to refuse, as it is.
  if (!record(project) || !record(project.chassis) || project.chassis.mirrored !== true ||
    !Array.isArray(project.components) || !Array.isArray(project.nodes) || !Array.isArray(project.chassis.points)) return project;
  const chassis = project.chassis, chassisPoints = records(project.chassis.points, 'chassis point'),
    componentRecords = records(project.components, 'component'), nodeRecords = records(project.nodes, 'node'),
    lastSegment = chassisPoints.length - 2,
    hostAcross = (id: unknown): unknown => {
      const found = /^chassis:(top|frame|rail)-(\d+)$/.exec(String(id ?? ''));
      return found && Number(found[2]) <= lastSegment ? `chassis:${found[1]}-${lastSegment - Number(found[2])}` : id;
    },
    components = componentRecords.map(component => {
      if (!record(component.pose)) throw new TypeError('Invalid legacy component pose.');
      return { ...component, pose: otherHand({ ...component.pose, x: negate(component.pose.x), angle: negate(component.pose.angle) }) };
    }),
    nodes = nodeRecords.map(node => ({ ...node, x: negate(node.x) }));
  const appearanceRecord = record(project.appearance) ? project.appearance : null;
  if (appearanceRecord?.details && !Array.isArray(appearanceRecord.details)) throw new TypeError('Invalid legacy project details.');
  const details: readonly unknown[] | null = appearanceRecord?.details && Array.isArray(appearanceRecord.details) ? appearanceRecord.details : null,
    appearance = details ? { ...appearanceRecord, details: records(details, 'detail').map(detail =>
      detail.surface === 'part' ? { ...detail } : otherHand({ ...detail, host: hostAcross(detail.host),
        ...(detail.space === 'project' || detail.surface === 'chassis' ? { x: negate(detail.x), angle: detailAngle(negate(detail.angle)) }
          : { y: negate(detail.y), angle: detailAngle(-Number(detail.angle) - Math.PI) }) })) } : project.appearance,
    points = [...chassisPoints].reverse().map((point, index) => {
      const { gap, ...rest } = point;
      return { ...rest, x: negate(point.x), ...(chassisPoints[chassisPoints.length - 2 - index]?.gap ? { gap: true } : {}) };
    }),
    { mirrored: _mark, ...kept } = chassis;
  if (chassis.axles && !Array.isArray(chassis.axles)) throw new TypeError('Invalid legacy project axles.');
  if (chassis.track && !record(chassis.track)) throw new TypeError('Invalid legacy project track.');
  const axles: readonly unknown[] | null = Array.isArray(chassis.axles) ? chassis.axles : null, track = record(chassis.track) ? chassis.track : null;
  return { ...project, nodes, components, ...(appearance ? { appearance } : {}), chassis: { ...kept, points,
    ...(axles ? { axles: [...axles].reverse().map(negate) } : {}),
    ...(track ? { track: { ...track, front: negate(track.rear), rear: negate(track.front) } } : {}) } };
}
