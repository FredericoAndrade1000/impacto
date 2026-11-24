import { wrapAngle, worldToLocal, rectangle } from './math.ts';
import { TURN_STEP } from './detail-gestures.ts';
import { RECOVERABLE } from './structured-construction.ts';
import type { Point, Pose, PlateGeometry } from './math.ts';

interface TurnMount { hostId: string | null | undefined; exposed?: boolean }
export interface TurnComponent extends Pose {
  id: string; kind: string; width: number; height: number; weaponMount?: TurnMount | null;
}
type TurnPlate = PlateGeometry & { id: string };
export interface TurnEditor {
  selected: { id: string; angle: number } | null;
  source: { components: readonly { id: string; pose: { angle: number } }[] };
  blockedEdit: unknown;
  editProperty(property: 'angle', value: number): unknown;
  rejectEdit(error: unknown): unknown;
}

// The round handle that turns the piece selected alone in the workshop (workshop-ux.ts), the same for a gun as for any
// other piece with an Ângulo: dragged, the piece turns about its pivot — the trunnion of a gun, the middle of anything
// else — so that the handle stays on the line from the pivot to the pointer, in steps of TURN_STEP, or onto a magnet
// where one is nearer than the nearest step; with Shift, as the pointer puts it. A thruster points one of eight ways
// 45° apart and no other (game_construction.rs `THRUSTER_TURN`): it turns in those steps, with no magnet, Shift or
// not. What a turn asks is what the Ângulo of the bar asks: the angle the author writes, which the core admits or
// refuses.

// How near, in metres, a plate is to a piece that sits against it.
const AGAINST = .05;
const THRUSTER_TURN = Math.PI / 4;
export const turnStep = (piece: Pick<TurnComponent, 'kind'>): number => piece.kind === 'thruster' ? THRUSTER_TURN : TURN_STEP;
export const turnsFree = (piece: Pick<TurnComponent, 'kind'>): boolean => piece.kind !== 'thruster';

// The way square out of the plate a gun's barrel passes through, or up off the one its post stands on.
function squareOut(plates: readonly TurnPlate[], weapon: TurnComponent, mount: TurnMount): number | null {
  const plate = plates.find(candidate => candidate.id === mount.hostId);
  if (!plate) return null;
  const normal = plate.angle + Math.PI / 2,
    way = mount.exposed ? Math.cos(normal) * (weapon.x - plate.x) + Math.sin(normal) * (weapon.y - plate.y) : Math.cos(normal - weapon.angle);
  return wrapAngle(way >= 0 ? normal : normal + Math.PI);
}
// The headings at which a piece lies flush with each plate it sits against: along it and square to it, either way
// round. Level and upright are steps already.
function flushWith(plates: readonly TurnPlate[], piece: TurnComponent): number[] {
  const corners = rectangle(piece.x, piece.y, piece.width, piece.height, piece.angle), headings: number[] = [];
  for (const plate of plates) {
    const half = plate.thicknessMm / 2000;
    if (!corners.some(corner => {
      const { u, v } = worldToLocal(plate, corner);
      return Math.abs(u) <= plate.length / 2 + AGAINST && Math.abs(v) <= half + AGAINST;
    })) continue;
    for (let quarter = 0; quarter < 4; quarter++) headings.push(wrapAngle(plate.angle + quarter * Math.PI / 2));
  }
  return headings;
}
// The headings a piece, as compiled, settles on besides the steps as it is turned from where it stands: a gun square
// out of its plate; anything else flush with the plates it sits against.
export const turnMagnets = (plates: readonly TurnPlate[], piece: TurnComponent): number[] => {
  if (piece.kind === 'thruster') return [];
  if (piece.kind !== 'weapon' || !piece.weaponMount) return flushWith(plates, piece);
  const square = squareOut(plates, piece, piece.weaponMount);
  return square === null ? [] : [square];
};

// The heading a piece turned about `pivot` takes with its handle, `lever` round from its heading, at `point`: in
// steps of `step`, or the nearest of `magnets` where that is nearer than the nearest step; `free`, as the pointer puts it.
export function turnedHeading(pivot: Point, lever: number, point: Point, magnets: readonly number[] = [], free = false, step = TURN_STEP): number {
  const pointed = wrapAngle(Math.atan2(point.y - pivot.y, point.x - pivot.x) - lever);
  if (free) return pointed;
  const off = (heading: number): number => Math.abs(wrapAngle(pointed - heading));
  return magnets.reduce((best, magnet) => off(magnet) < off(best) ? magnet : best, Math.round(pointed / step) * step);
}

// The piece selected put to `heading` within the change a press began (Editor.begin), all of it one change of the
// history once let go: the angle its author writes — a gun drawn the other way round is written half a turn from how
// it lies —, asked of the core. Refused, the piece stays as it last stood and the refusal is shown where it happened
// (Editor.rejectEdit); back on that heading, nothing is refused any more. Whether this heading was refused.
export function turnPiece(editor: TurnEditor, heading: number): boolean {
  const piece = editor.selected;
  if (!piece) return false;
  const part = editor.source.components.find(candidate => candidate.id === piece.id);
  if (!part) return false;
  const angle = wrapAngle(heading - piece.angle + part.pose.angle);
  if (Math.abs(wrapAngle(angle - part.pose.angle)) < 1e-9) { editor.blockedEdit = null; return false; }
  try { editor.editProperty('angle', angle); return false; }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || !RECOVERABLE.some(code => code === error.code)) throw error;
    editor.rejectEdit(error); return true;
  }
}
