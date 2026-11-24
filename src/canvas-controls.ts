import { tr } from './i18n.ts';
import { pointOf } from './frame-points.ts';
import { FRAME_REACH } from './frame-editing.ts';
import { VEHICLE_ORIGIN } from './vehicle.ts';
import { cellOf, metresOf } from './grid.ts';
import { clamp } from './math.ts';
import { AIM_SKY } from './battle-rules.ts';
import { controlContext } from './ui-model.ts';
import { groupSelectionHit, plateMiddleHit } from './workshop-selection.ts';
import { initTouch, touching, reach, capture, LIFT } from './touch.ts';
import { strikeOrigin } from './armour-strike.ts';
import { STRIKE_PX } from './armour-trial.ts';
import type { Point } from './math.ts';
import type { Editor, EditorPointHit, EditorPlateHit, EditorPlateSpan, SelectionPose, RoomHandle } from './editor.ts';
import type { UiView } from './ui-model.ts';
import type { TouchOptions } from './touch.ts';
import type { Camera, CameraFrame, CameraGround, CameraLimits } from './camera.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { StrikeView } from './armour-trial.ts';

export interface CanvasPoint extends Point { sx: number; sy: number }
export interface CanvasPlatePoint extends Point { nodeId?: string }
interface CanvasGestureBase { chosen?: string[] }
interface CanvasDragBase extends CanvasGestureBase { start: CanvasPoint; moved: boolean }
export type CanvasMoveGesture = CanvasDragBase & { type: 'move'; original: SelectionPose[] };
type CanvasFrameGesture = CanvasDragBase & (
  { type: 'hull'; handle: Extract<EditorPointHit, { kind: 'node' }> } |
  { type: 'vertex'; handle: Extract<EditorPointHit, { kind: 'vertex' }> } |
  { type: 'edge'; handle: EditorPlateHit }
);
export interface CanvasStrikeGesture extends CanvasGestureBase {
  type: 'strike'; pressed: Point; from: Point; sx: number; sy: number; moved: boolean; at?: CanvasPoint;
}
type CanvasReshapeGesture = CanvasFrameGesture | CanvasMoveGesture;
export type CanvasGesture = CanvasReshapeGesture | CanvasStrikeGesture |
  CanvasGestureBase & (
    { type: 'pan'; sx: number; sy: number } |
    { type: 'marquee'; start: CanvasPoint; end: CanvasPoint; additive: boolean; moved: boolean } |
    { type: 'place' } | { type: 'plate'; start: CanvasPlatePoint }
  );
export interface CanvasControlInput { gesture: CanvasGesture | null; pointerFire: boolean; spacePan: boolean }
export type CanvasControlView = Pick<UiView, 'mode' | 'buildTool' | 'repeatPlacement' | 'placement'>;
type CanvasPlacementPlan = ReturnType<Editor['planModule']>;
type PreviewParts<Plan extends CanvasPlacementPlan> = Plan extends unknown ? Pick<Plan, 'modules' | 'plates' | 'overlap' | 'refused'> : never;
export type CanvasModulePreview = PreviewParts<CanvasPlacementPlan> & Point & {
  width: number | undefined; height?: number | undefined; reason?: string | undefined; feedback: string | undefined;
};
export interface CanvasRenderer {
  canvas: HTMLCanvasElement;
  ground: CameraGround & Pick<CameraLimits, 'minX' | 'maxX'>;
  aim: Point;
  camera: Pick<Camera, 'zoom' | 'toWorld' | 'pan' | 'zoomBy'>;
  board: { camera: Pick<CameraFrame, 'turn' | 'toWorld' | 'toScreen'> };
  modulePreview: CanvasModulePreview | null;
  platePreview: { a: CanvasPlatePoint; b: CanvasPlatePoint } | null;
  strike: StrikeView | null;
  marquee: { start: Point; end: Point } | null;
  edgeHover: EditorPlateSpan | RoomHandle | null;
  vertexHover: Point | null;
  joinTargets: Point[];
  state: DrawingScene | null;
  tool: string;
}
interface CanvasPlacement { setX(x: number): void; point(x: number): void }
interface CanvasEffects {
  onField(): boolean;
  requestUI(): void;
  stopControls(): void;
  placing(): CanvasPlacement | null;
  seen(): Parameters<typeof controlContext>[2];
  detailsUX?: { enabled: boolean; grabs(point: Point): boolean } | null;
  armour: Pick<ReturnType<typeof import('./armour-trial.ts').createArmourTrial>, 'quicken' | 'strikes' | 'clearCosts' | 'aimStrike' | 'clickStrike' | 'launchStrike'>;
  inspectAt(point: CanvasPoint): void;
  sendAim(): void;
  syncTrigger(options?: { queue?: boolean }): void;
  explainSilence(): void;
  followAim(): void;
  attempt(action: () => void): void;
  cue(cue: 'clunk'): void;
  toast(message: string, error?: boolean): void;
  reportError(error: unknown): void;
}
export interface CanvasControlOptions {
  editor: Editor; renderer: CanvasRenderer; view: CanvasControlView; session: { ready: boolean }; input: CanvasControlInput;
  effects: CanvasEffects; document?: Pick<Document, 'querySelector'>; touch?: (options: TouchOptions) => void;
}
function reshaping(gesture: CanvasGesture | null): gesture is CanvasReshapeGesture {
  return gesture?.type === 'hull' || gesture?.type === 'vertex' || gesture?.type === 'edge' || gesture?.type === 'move';
}
function dragging(gesture: CanvasGesture | null): gesture is CanvasReshapeGesture | Extract<CanvasGesture, { type: 'marquee' }> {
  return reshaping(gesture) || gesture?.type === 'marquee';
}

const AIM_HOLD_MS = 180;
export function pointerAim(point: Point, ground: { minX: number; maxX: number }, shared: boolean): Point {
  return { x: shared ? clamp(point.x, ground.minX, ground.maxX) : point.x, y: clamp(point.y, -AIM_SKY, AIM_SKY) };
}

// Pointer gestures have one owner. Browser events and tests call this same
// installation; editor transactions and pending UI updates keep their owners.
export function createCanvasControls({ editor, renderer, view, session, input, effects, document = globalThis.document, touch = initTouch }: CanvasControlOptions) {
  function pointAim(point: Point): void {
    // The aim is where the pointer is, under the ground as over it: below the gun in a valley too. The shared field
    // refuses one beyond its ends or further than AIM_SKY above or below it.
    const ground = renderer.ground;
    renderer.aim = pointerAim(point, ground, effects.onField());
  }
  function clearGesture(cancel = false) {
    if (cancel) editor.cancel();
    if (input.gesture?.type === 'place' || input.gesture?.type === 'move') renderer.modulePreview = null;
    renderer.platePreview = null;
    // A strike that was not fired is no longer drawn; one fired fades as its round flies.
    if (input.gesture?.type === 'strike' && !renderer.strike?.fired) renderer.strike = null;
    input.gesture = null; renderer.marquee = renderer.edgeHover = null; renderer.joinTargets = [];
    effects.requestUI();
  }
  // Plates copied join the ends and plates within the reach an end dragged joins them in (Editor.admitLanding).
  function componentPlacement(point: Point): Parameters<Editor['planModule']> {
    const { kind, ...intent } = view.placement;
    return [kind, editor.snap && kind !== 'weapon' ? { x: onCell(point, 'x'), y: onCell(point, 'y') } : { x: point.x, y: point.y },
      { ...intent, snap: editor.snap, faceTolerance: componentSnapReach(), ...intent.plates?.length ? { joinReach: joinReach() } : {} }];
  }
  // How near an end of plates dragged, or of plates moved or copied whole, joins an end or a plate it is let go by.
  const joinReach = () => reach(9) / renderer.camera.zoom;
  // A point of the board on the cell of the grid nearest to it, counted from the reference of the construction (grid.ts).
  const onCell = (point: Point, key: 'x' | 'y') => VEHICLE_ORIGIN[key] + metresOf(cellOf(point[key] - VEHICLE_ORIGIN[key]));
  // The same small visible approach at every zoom, capped so a distant view never pulls a part to a remote support.
  const componentSnapReach = () => Math.min(.1, 14 / renderer.camera.zoom);
  function installCanvasEvents() {
    const canvas = renderer.canvas;
    // The place under the pointer, in the frame of what the player works on: the world, or the board that stands in the field.
    const point = (event: MouseEvent, lift = 0): CanvasPoint => { const r = canvas.getBoundingClientRect(), sx = event.clientX - r.left, sy = event.clientY - r.top - lift; return { sx, sy, ...renderer.board.camera.toWorld(sx, sy) }; };
    // A finger installs a piece a little above itself, where the piece is seen: under it, it would hide what it places.
    const placed = (event: MouseEvent) => point(event, LIFT);
    // How near a node, a plate or a piece the pointer takes hold of it, in the world.
    const grip = (pixels: number) => reach(pixels) / renderer.camera.zoom;
    // A finger takes hold, at the workshop, of a point of the frame, a plate or a piece, and drags what is being installed;
    // anywhere else its drag is the camera's. Held still it orders the vehicles picked on the field, as the right button
    // does, and pulls at the workshop, as Shift does: on a point of the frame, always, which takes it into the selection or
    // out of it.
    const pointAt = (x: number, y: number) => { const r = canvas.getBoundingClientRect(); return editor.pickPoint(renderer.board.camera.toWorld(x - r.left, y - r.top), grip(9)); };
    touch({ canvas, zoom: (factor, x, y) => renderer.camera.zoomBy(factor, x, y), pan: (dx, dy) => renderer.camera.pan(dx, dy), changed: () => { effects.stopControls(); effects.requestUI(); },
      grabs: (x, y) => {
        if (!session.ready || effects.placing()) return false;
        const r = canvas.getBoundingClientRect(), p = renderer.board.camera.toWorld(x - r.left, y - r.top);
        // Under a test of armour a finger draws the line of a strike, wherever it is put down.
        if (view.mode !== 'edit') return effects.armour.strikes();
        // Editing details, a finger takes a detail; anywhere else it moves the camera.
        if (effects.detailsUX?.enabled) return effects.detailsUX.grabs(p);
        if (view.buildTool !== 'select') return true;
        return Boolean(editor.pickPoint(p, grip(9)) || editor.pick(p, grip(5)) || editor.pickPlate(p, grip(7)));
      },
      held: (x, y) => effects.placing() || effects.detailsUX?.enabled ? null : view.mode === 'edit' ? view.buildTool === 'select' && (editor.selectionIds.size < 2 || x !== undefined && y !== undefined && pointAt(x, y)) ? 'shift' : null
        : controlContext(view, renderer.state, effects.seen()).autopilot ? 'secondary' : null,
      // A gun in hand is aimed by a finger held a moment and dragged: in a fight that moment is short.
      holding: () => !effects.placing() && view.mode === 'test' && renderer.tool === 'fire' && !controlContext(view, renderer.state, effects.seen()).autopilot ? AIM_HOLD_MS : null,
      // At the workshop a finger held still is shown its hold filling: about the point of the frame a press with Shift
      // takes there, or about the finger.
      shown: (x, y) => {
        if (!session.ready || effects.placing() || view.mode !== 'edit' || effects.detailsUX?.enabled) return null;
        const r = canvas.getBoundingClientRect(),
          spot = editor.pickPoint(renderer.board.camera.toWorld(x - r.left, y - r.top), grip(9), { nearest: true }), at = spot && renderer.board.camera.toScreen(spot.x, spot.y);
        return at ? { x: at.x + r.left, y: at.y + r.top } : { x, y };
      } });
    // A component goes where the pointer is: the mouse shows where while it hovers, a finger while it is down.
    let placementCursor: Point | null = null;
    const placementPreview = (plan: CanvasPlacementPlan, p: Point, feedback: string | undefined): CanvasModulePreview => {
      const first = plan.module || plan.plates?.[0] || p,
        width = 'width' in first && typeof first.width === 'number' ? first.width : 'length' in first && typeof first.length === 'number' ? first.length : undefined;
      const shown = { ...first, width, feedback: plan.reason || feedback };
      return plan.refused
        ? { ...shown, modules: plan.modules, plates: plan.plates, overlap: plan.overlap, refused: true }
        : { ...shown, modules: plan.modules, plates: plan.plates, overlap: plan.overlap, refused: false };
    };
    const movePieces = (p: CanvasPoint, gesture: CanvasMoveGesture) => {
      const at = renderer.camera.toWorld(p.sx, p.sy), { start, original } = gesture;
      editor.moveSelection(original, (at.x - start.x) * renderer.board.camera.turn, at.y - start.y,
        { faceTolerance: componentSnapReach(), joinReach: joinReach() });
      // The ends the plates moved are joined to, and where they meet others and are divided there, are lit.
      renderer.joinTargets = editor.meets;
      const plan = editor.weaponMovePreview;
      renderer.modulePreview = plan?.refused ? placementPreview(plan, p, plan.reason) : null;
    };
    const showPlacement = (p: Point) => {
      placementCursor = { x: p.x, y: p.y };
      const plan = editor.planModule(...componentPlacement(p)), go = touching() ? tr('solte para instalar') : tr('clique para instalar');
      renderer.modulePreview = placementPreview(plan, p, tr('Cabe aqui · ') + go); renderer.joinTargets = plan.meets ?? [];
      effects.requestUI();
    };
    const moduleSettings = document.querySelector('#new-module-settings');
    if (!moduleSettings) throw new Error('Missing new module settings');
    moduleSettings.addEventListener('change', () => {
      if (view.mode === 'edit' && view.buildTool === 'module' && !view.placement.copies && !view.placement.plates && renderer.modulePreview)
        showPlacement(placementCursor || renderer.modulePreview);
    });
    // An end of a plate drawn with Chapa rests where an end let go there would, and is joined to the end of plates under
    // the pointer or within reach of where it rests, as an end let go is (Editor.dropTarget).
    const platePoint = (p: Point): CanvasPlatePoint => {
      const rest = editor.framePoint(p, componentSnapReach()),
        placed = { ...rest, x: clamp(rest.x, VEHICLE_ORIGIN.x + FRAME_REACH.minX, VEHICLE_ORIGIN.x + FRAME_REACH.maxX),
          y: clamp(rest.y, VEHICLE_ORIGIN.y + FRAME_REACH.minY, VEHICLE_ORIGIN.y + FRAME_REACH.maxY) },
        target = editor.pickNode(p, grip(9), { nearest: true }) ?? editor.pickNode(placed, grip(9), { nearest: true });
      return target ? { x: target.x, y: target.y, nodeId: target.id } : placed;
    };
    // The ends of a plate being drawn that will be joined to an end of plates are lit, and so are the points where the
    // plates it meets are divided; where it may not be drawn, the refusal is shown.
    const litPlateEnds = ({ a, b }: { a: CanvasPlatePoint; b: CanvasPlatePoint }) => {
      const long = Math.hypot(b.x - a.x, b.y - a.y) >= .08 - 1e-9, meets = long ? editor.previewPlate(a, b).meets : [];
      if (!long) editor.blockedEdit = null;
      renderer.joinTargets = [...[a, b].filter(end => end.nodeId), ...meets];
    };
    const place = (p: Point) => {
      effects.attempt(() => {
        editor.addModule(...componentPlacement(p));
        if (!view.repeatPlacement) {
          view.buildTool = 'select'; delete view.placement.copies; delete view.placement.plates; delete view.placement.anchor; renderer.modulePreview = null;
        }
        effects.cue('clunk'); effects.toast(tr('Peça instalada.'));
      });
    };
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('pointerdown', event => {
      if (!session.ready) return;
      event.preventDefault(); canvas.focus({ preventScroll: true }); capture(canvas, event.pointerId);
      const p = point(event);
      if (event.button === 1 || event.button === 2 || view.mode === 'edit' && input.spacePan || view.mode === 'test' && event.shiftKey) { input.gesture = { type: 'pan', sx: p.sx, sy: p.sy }; return; }
      if (event.button !== 0) return;
      const placement = effects.placing();
      if (placement) { placement.setX(renderer.camera.toWorld(p.sx, p.sy).x); effects.requestUI(); return; }
      if (view.mode === 'test') {
        if (effects.armour.quicken()) return;
        if (renderer.tool === 'inspect') effects.inspectAt(p);
        else if (effects.armour.strikes()) {
          effects.armour.clearCosts();
          input.gesture = { type: 'strike', pressed: { x: p.x, y: p.y }, from: strikeOrigin(p, renderer.ground), sx: p.sx, sy: p.sy, moved: false };
        }
        // A finger aims; it fires with the button of the controls over the field.
        else if (event.pointerType === 'touch') { pointAim(p); effects.sendAim(); }
        else { pointAim(p); input.pointerFire = true; effects.syncTrigger({ queue: true }); effects.explainSilence(); }
        return;
      }
      const selecting = view.buildTool === 'select', additive = event.shiftKey || event.ctrlKey || event.metaKey,
        chosen = [...editor.selectionIds], id = selecting ? editor.pick(p, grip(5)) : null,
        node = selecting ? editor.pickPoint(p, grip(9), { nearest: additive }) : null,
        plate = selecting && !additive && !editor.source.components.some(part => part.id === id) ? editor.pickPlate(p, grip(7)) : null,
        spot = plateMiddleHit(p, node, plate) ? null : node, edge = !spot ? plate : null;
      if (selecting && !additive && groupSelectionHit(editor, { piece: id, node, plate })) {
        editor.begin(); renderer.edgeHover = renderer.vertexHover = null;
        input.gesture = { type: 'move', start: p, original: editor.captureSelection(), moved: false };
      } else if (spot) {
        // A point of the frame — an end of plates or a point of the chassis — is taken alone and dragged; with Shift or
        // Ctrl it is taken into the selection or out of it.
        if (additive) editor.select(spot.key, { toggle: true });
        else {
          if (!editor.selectionIds.has(spot.key)) editor.select(spot.key);
          editor.begin(); input.gesture = spot.kind === 'node' ? { type: 'hull', handle: spot, start: p, moved: false } : { type: 'vertex', handle: spot, start: p, moved: false };
        }
        effects.requestUI();
      } else if (selecting) {
        if (edge) {
          editor.select(edge.id); editor.begin(); renderer.edgeHover = edge;
          input.gesture = { type: 'edge', handle: edge, start: p, moved: false };
        } else if (id) {
          if (additive) editor.select(id, { toggle: true });
          else if (!editor.selectionIds.has(id)) editor.select(id);
          effects.requestUI();
          if (!additive && editor.selectionIds.size) { editor.begin(); input.gesture = { type: 'move', start: p, original: editor.captureSelection(), moved: false }; }
        } else {
          if (!additive) editor.select([]);
          input.gesture = { type: 'marquee', start: p, end: p, additive, moved: false }; effects.requestUI();
        }
      } else if (view.buildTool === 'module') {
        if (event.pointerType === 'touch') { input.gesture = { type: 'place' }; showPlacement(placed(event)); } else place(p);
      } else if (view.buildTool === 'plate') {
        const start = platePoint(p);
        input.gesture = { type: 'plate', start };
        renderer.platePreview = { a: start, b: start }; litPlateEnds(renderer.platePreview); effects.requestUI();
      }
      // A press called off — a finger held there goes on as a press with Shift (touch.ts) — leaves chosen what was.
      if (input.gesture) input.gesture.chosen = chosen;
      // A reshaping delta follows the camera, not the board's changing ground placement.
      if (reshaping(input.gesture))
        Object.assign(input.gesture.start, renderer.camera.toWorld(p.sx, p.sy));
    });
    canvas.addEventListener('dblclick', event => {
      if (!session.ready || view.mode !== 'edit' || view.buildTool !== 'select' || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      const p = point(event);
      const node = editor.pickPoint(p, grip(9));
      if (node && !plateMiddleHit(p, node, editor.pickPlate(p, grip(7)))) return;
      // On the frame of the chassis, the two clicks or the two taps put a point of it there.
      if (pointOf(editor.pick(p, grip(5)))?.kind === 'stretch' && editor.onChassisFrame(p, grip(4))) {
        event.preventDefault(); clearGesture();
        effects.attempt(() => { if (!editor.addChassisPoint(p) && editor.blockedEdit) effects.toast(editor.blockedEdit.message, true); });
        return;
      }
      const edge = editor.pickPlate(p, grip(7));
      if (!edge || groupSelectionHit(editor, { piece: editor.pick(p, grip(5)), plate: edge })) return;
      event.preventDefault(); clearGesture();
      effects.attempt(() => {
        if (!editor.splitPlate(edge, p)) effects.toast(editor.blockedEdit?.message || tr('Não foi possível dividir a chapa nessa posição.'), true);
      });
    });
    canvas.addEventListener('pointermove', event => {
      const p = point(event);
      if (view.mode === 'edit' && view.buildTool === 'select' && !input.gesture) {
        const node = editor.pickPoint(p, grip(9)), id = editor.pick(p, grip(5)),
          edge = !editor.source.components.some(part => part.id === id) ? editor.pickPlate(p, grip(7)) : null,
          vertex = plateMiddleHit(p, node, edge) ? null : node,
          group = groupSelectionHit(editor, { piece: id, node, plate: edge });
        renderer.edgeHover = group ? null : !vertex ? edge : null;
        canvas.style.cursor = group ? 'grab' : vertex ? 'move' : renderer.edgeHover ? 'grab' : '';
      }
      if (view.mode === 'edit' && (!input.gesture || input.gesture.type === 'place') && view.buildTool === 'module')
        showPlacement(input.gesture ? placed(event) : p);
      if (input.gesture?.type === 'pan') { renderer.camera.pan(p.sx - input.gesture.sx, p.sy - input.gesture.sy); input.gesture.sx = p.sx; input.gesture.sy = p.sy; return; }
      if (dragging(input.gesture) && !input.gesture.moved) {
        input.gesture.moved = Math.hypot(p.sx - input.gesture.start.sx, p.sy - input.gesture.start.sy) >= 3;
        if (!input.gesture.moved) return;
      }
      const source = editor.source;
      if (reshaping(input.gesture)) {
        const at = renderer.camera.toWorld(p.sx, p.sy), start = input.gesture.start,
          dx = (at.x - start.x) * renderer.board.camera.turn, dy = at.y - start.y;
        if (input.gesture.type === 'hull') {
          const { handle } = input.gesture;
          editor.moveNode(handle, { x: handle.x + dx, y: handle.y + dy }, { faceTolerance: componentSnapReach(), joinReach: joinReach() });
          // The end it would be joined with, let go here, is lit, and so are the points where plates are divided for it.
          const [target] = editor.dropTarget(handle, joinReach()), at = target && editor.nodes().find(node => node.id === target);
          renderer.joinTargets = [...at ? [at] : [], ...editor.meets];
        } else if (input.gesture.type === 'vertex') {
          const { handle } = input.gesture;
          editor.moveChassisPoint(handle, { x: handle.x + dx, y: handle.y + dy });
        } else if (input.gesture.type === 'edge') {
          const { handle } = input.gesture;
          editor.movePlate(handle, dx, dy, { joinReach: joinReach() });
          renderer.edgeHover = editor.plateSpans().find(edge => edge.id === handle.id) || null;
          renderer.joinTargets = editor.meets;
        } else if (input.gesture.original.length) movePieces(p, input.gesture);
      } else if (input.gesture?.type === 'marquee') {
        input.gesture.end = p; renderer.marquee = { start: input.gesture.start, end: p };
      } else if (input.gesture?.type === 'plate') {
        renderer.platePreview = { a: input.gesture.start, b: platePoint(p) }; litPlateEnds(renderer.platePreview); effects.requestUI();
      } else if (input.gesture?.type === 'strike') {
        const gesture = input.gesture;
        gesture.moved ||= Math.hypot(p.sx - gesture.sx, p.sy - gesture.sy) >= reach(STRIKE_PX);
        if (gesture.moved) effects.armour.aimStrike(gesture, p);
      } else if (effects.placing()) {
        const placement = effects.placing();
        if (!input.gesture && event.pointerType === 'mouse' && placement) placement.point(renderer.camera.toWorld(p.sx, p.sy).x);
      } else if (view.mode === 'test' && renderer.tool !== 'inspect') {
        pointAim(p); effects.followAim();
      }
      if (editor.source !== source) editor.preview();
    });
    const release = (event: PointerEvent) => {
      input.pointerFire = false; effects.syncTrigger();
      try {
      if (reshaping(input.gesture)) {
        const gesture = input.gesture;
        if (gesture.type === 'move' && gesture.original.length === 1 &&
            editor.source.components.some(part => part.id === gesture.original[0]?.id && part.kind === 'weapon')) {
          const p = point(event);
          gesture.moved ||= Math.hypot(p.sx - gesture.start.sx, p.sy - gesture.start.sy) >= 3;
          if (gesture.moved) movePieces(p, gesture);
        }
        if (input.gesture.type === 'hull' && input.gesture.moved) editor.joinDroppedNode(input.gesture.handle, joinReach());
        editor.commit();
        if (editor.blockedEdit && editor.blockedEdit.until > Date.now()) effects.toast(editor.blockedEdit.message, true);
        effects.requestUI();
      }
      if (input.gesture?.type === 'marquee' && input.gesture.moved) {
        editor.selectBox(input.gesture.start, input.gesture.end, input.gesture.additive); effects.requestUI();
      }
      if (input.gesture?.type === 'place') { renderer.modulePreview = null; place(placed(event)); }
      if (input.gesture?.type === 'plate') {
        const from = input.gesture.start, to = platePoint(point(event));
        if (Math.hypot(to.x - from.x, to.y - from.y) >= .08 - 1e-9) {
          const plates = editor.source.plates.length;
          editor.addPlate(from, to);
          if (!view.repeatPlacement) view.buildTool = 'select';
          // In symmetric editing it comes with one across the axis.
          effects.cue('clunk'); effects.toast(editor.source.plates.length - plates > 1 ? tr('Chapas criadas, uma de cada lado do eixo.') : tr('Chapa criada.'));
        }
      }
      if (input.gesture?.type === 'strike') {
        // A line drawn fires on to what it meets; a click strikes the design where it was clicked.
        if (!input.gesture.moved) effects.armour.clickStrike(input.gesture.pressed);
        else if (renderer.strike && 'round' in renderer.strike && renderer.strike.round) effects.armour.launchStrike(renderer.strike);
      }
      } catch (error) { editor.cancel(); effects.reportError(error); }
      clearGesture();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', event => {
      const chosen = input.gesture?.chosen;
      input.pointerFire = false; effects.syncTrigger(); clearGesture(true); if (chosen) editor.select(chosen);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointerleave', () => {
      if (renderer.modulePreview) renderer.joinTargets = [];
      renderer.modulePreview = renderer.edgeHover = null; canvas.style.cursor = ''; effects.requestUI();
    });
    canvas.addEventListener('wheel', event => { event.preventDefault(); const p = point(event); renderer.camera.zoomBy(Math.exp(-event.deltaY * 0.0015), p.sx, p.sy); }, { passive: false });
  }


  return { install: installCanvasEvents, clearGesture, pointAim };
}
