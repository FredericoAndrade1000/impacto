import type { Point } from './math.ts';
import type { Editor, EditorPointHit, EditorPlateSpan } from './editor.ts';
import type { CompiledConstruction } from './construction-contract.ts';
import type { ModuleKind } from './materials.ts';
export interface ProjectPart {id:string;kind:ModuleKind|'chassis';name:string}
interface SelectionHit {piece?:string|null;node?:EditorPointHit|null;plate?:EditorPlateSpan|null}
import { CHASSIS_ID, chassisPart } from './chassis-editing.ts';
import { chassisName } from './chassis.ts';
import { partName } from './part-view.ts';
import { tr } from './i18n.ts';

// On a short plate the grips of both ends overlap. Reserve its middle half
// for moving the plate; the ends and an unrelated joint still take their grip.
export function plateMiddleHit(point: Point, node: EditorPointHit | null | undefined, plate: EditorPlateSpan | null | undefined) {
  if (!plate || node?.kind !== 'node' || ![plate.aId, plate.bId].includes(node.id)) return false;
  const dx = plate.b.x - plate.a.x, dy = plate.b.y - plate.a.y,
    length2 = dx * dx + dy * dy,
    along = ((point.x - plate.a.x) * dx + (point.y - plate.a.y) * dy) / length2;
  return along > .25 && along < .75;
}

// Taking a selected group's corner or wall moves the group, rather than
// reshaping that wall. A handle outside the selection still edits normally.
// `node` is a point of the frame taken (Editor.pickPoint): an end of plates, or a point of the chassis.
export function groupSelectionHit(editor: Pick<Editor,'selectionIds'|'plateSpans'>, { piece, node, plate }: SelectionHit = {}) {
  const ids = editor.selectionIds;
  return ids.size > 1 && (piece != null && ids.has(piece) || plate != null && ids.has(plate.id) || node != null && ids.has(node.key) || Boolean(node?.kind === 'node' &&
    editor.plateSpans().some(span => ids.has(span.id) && (span.aId === node.id || span.bId === node.id))));
}

// Every piece of the project, as Ctrl+A selects it: the chassis once for all its running gear, the plates and the
// components. It only selects them; applying a setting remains a separate undoable edit.
export function everyPiece(blueprint: Pick<CompiledConstruction,'chassis'|'plates'|'modules'>) {
  const own = (pieces: readonly {id:string}[]) => (pieces || []).filter(piece => !chassisPart(piece.id)).map(piece => piece.id);
  return [...(blueprint.chassis ? [CHASSIS_ID] : []), ...own(blueprint.plates), ...own(blueprint.modules)];
}

// The pieces listed beside the project, each picked with a press: the chassis, named for its running gear, and the
// components in the order they were installed. The plates of the hull are picked on the drawing. Pieces of one name
// are numbered in that order ("Câmera óptica 1", "Câmera óptica 2"); a name of one piece only is told as it is.
export function projectParts(blueprint: Pick<CompiledConstruction,'chassis'|'modules'>): ProjectPart[] {
  const parts: ProjectPart[] = [...(blueprint.chassis ? [{ id: CHASSIS_ID, kind: 'chassis' as const, name: tr(chassisName(blueprint.chassis.model)) }] : []),
      ...(blueprint.modules || []).filter(piece => !chassisPart(piece.id)).map(piece => ({ id: piece.id, kind: piece.kind, name: partName(piece) }))],
    named = new Map<string,number>(), seen = new Map<string,number>();
  for (const { name } of parts) named.set(name, (named.get(name) || 0) + 1);
  return parts.map(part => {
    if (named.get(part.name)! < 2) return part;
    seen.set(part.name, (seen.get(part.name) || 0) + 1);
    return { ...part, name: `${part.name} ${seen.get(part.name)}` };
  });
}
