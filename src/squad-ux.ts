import { tr } from './i18n.ts';
import { messageText } from './user-message.ts';
import { node, icon, escapeHTML } from './dom-view.ts';
import { knownVeins, veinMarks, heldText } from './faction-ui.ts';
import { ORDERS, ACTIONS, COLUMN, fieldOf, fieldNotices } from './field-panel.ts';
import { showReport } from './report-dialog.ts';
import { depositsOf, depositsNear } from './deposits.ts';
import { LOAD_REACH } from './economy.ts';
import { touching, reach, capture, TWICE_MS } from './touch.ts';
import { SquadMarks, squadTagBox, updateSquadTag, selectedRadar } from './squad-marks.ts';
import { selectionRuler } from './selection-ruler.ts';
import { sceneFrame } from './scene-frame.ts';
import { plateCorners } from './math.ts';
import { componentPolygon } from './assembly.ts';
import { pickShownPiece } from './editor.ts';
import { FieldSites } from './field-sites.ts';
import { compileBlueprint } from './persistence.ts';
import { constructionSilhouette } from './construction-preview.ts';
import { towOf, towReady } from './tow-ui.ts';
import { flies } from './ui-model.ts';
import { metres } from './format.ts';
import { isSquadStance } from './squad-contract.ts';
import type { SquadCommand, SquadStance } from './squad-contract.ts';
import type { Point } from './math.ts';
import type { UiView } from './ui-model.ts';
import type { AuthoredConstruction, CompiledConstruction } from './construction-contract.ts';
import type { FieldView, FieldSquad, KnownVein } from './faction-ui.ts';
import type { FieldPanelView, FieldOrderId, FieldActionId, FieldAction, FieldUnitRow, FieldNoticeMemo, FieldNoticeItem } from './field-panel.ts';
import type { Camera } from './camera.ts';
import type { Terrain } from './terrain.ts';
import type { SceneSample } from './scene-frame.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { EncounterBand } from './encounter-bands.ts';
import type { CanvasPoint } from './canvas-controls.ts';
import type { FieldSitesOptions, FieldSiteMark, SiteArea, SiteKind } from './field-sites.ts';
import type { DepositLabelPlacement } from './deposit-labels.ts';
import type { SquadDepositMark } from './squad-marks.ts';

interface SquadLabelBox extends SiteArea { x: number }
interface SquadSiteBox { kind: Exclude<SiteKind, 'vein' | 'wreck'>; id: string; label: SquadLabelBox; area: SiteArea }
export interface SquadUXRenderer {
  canvas: HTMLCanvasElement; state: FieldView | null; ground: Terrain; aim: Point;
  camera: Pick<Camera, 'toWorld' | 'toScreen' | 'zoom' | 'x' | 'y' | 'width' | 'height' | 'cover' | 'follow' | 'fit'>;
  scene: SceneSample<DrawingScene> | null; labelBoxes: ReadonlyMap<string, SquadLabelBox>; siteBoxes?: ReadonlyMap<string, SquadSiteBox>;
  markHeight(x: number, id?: string): number;
}
export interface SquadUXOptions {
  renderer: SquadUXRenderer; view: Pick<UiView, 'mode' | 'cameraFree' | 'testTool'>;
  command: FieldSitesOptions['command'];
  toast(text: string, error?: boolean, place?: number | null, items?: readonly FieldNoticeItem[]): void;
  alert(kind: 'grave' | 'contact'): void; refresh(): void; stopControls(): void; sendAim(): void;
  selected?: (ids: readonly string[]) => void; blocked?: () => boolean;
  design?: (id: string) => AuthoredConstruction | null | undefined;
  actions?: Partial<Record<FieldActionId, (action: FieldAction | undefined) => unknown>>;
}
type SquadPanel = Pick<FieldPanelView, 'squad' | 'orders' | 'actions' | 'refused' | 'stances' | 'veins' | 'wrecks' | 'works' | 'heaps' | 'roads'> &
  Partial<Pick<FieldPanelView, 'posts' | 'turn' | 'turnDisabled' | 'turnReason'>> & { auto?: null };
interface SquadExtent { left: number; right: number; bottom: number; top: number }
interface SquadBounds extends Point { minX: number; maxX: number; minY: number; maxY: number; fixed?: boolean }
interface BoxGesture {
  start: CanvasPoint; end: CanvasPoint; additive: boolean; moved: boolean; column: boolean;
  was: Set<string>; before: Set<string>; box?: ReturnType<typeof selectionRuler>['box']; armed?: never;
}
interface OrderGesture { start: CanvasPoint; end: CanvasPoint; armed: FieldOrderId; moved: boolean; column?: never; was?: never; before?: never; additive?: never; box?: never }
type SquadGesture = BoxGesture | OrderGesture;
interface OrderButton { button: HTMLButtonElement; label: HTMLSpanElement; count: HTMLElement; mark: HTMLSpanElement; reason: HTMLParagraphElement; main: boolean }
interface ActionButton { button: HTMLButtonElement; label: HTMLSpanElement; reason: HTMLParagraphElement }
interface SilhouetteLayer { layer: string; url: string }
interface Silhouette { design: CompiledConstruction; key: string | null; layers: SilhouetteLayer[] | null }
type SquadMember = NonNullable<ReturnType<typeof fieldOf>>['members'][number];
type TowData = { act: 'detach'; actorId: string } | { act: 'attach'; actorId: string; targetId: string };
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing squad view record'); return value; };
const isElement = (target: EventTarget | null): target is Element => target !== null && 'closest' in target && typeof target.closest === 'function';
const isNode = (target: EventTarget | null): target is Node => target !== null && ('nodeType' in target || 'parentNode' in target);
const isHtml = (element: Element | null | undefined): element is HTMLElement => element != null && 'style' in element;
const errorMessage = (error: unknown): string => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
const isOrderId = (value: unknown): value is FieldOrderId => typeof value === 'string' && Object.hasOwn(ORDER_ICONS, value);
const isActionId = (value: unknown): value is FieldActionId => typeof value === 'string' && ACTIONS.some(action => action.id === value);
const isMark = (value: unknown): value is keyof typeof MARKS => typeof value === 'string' && Object.hasOwn(MARKS, value);
const positioned = (value: { x?: number | undefined; y?: number | undefined }): value is Point =>
  typeof value.x === 'number' && typeof value.y === 'number' && Number.isFinite(value.x + value.y);

// Command of the squad: who is selected, what the mouse orders, the column of the constructions of the faction over the field
// and the orders of the dock, with Mais ações: the orders out of its main row, what is done to the constructions picked and
// the stance. One another member holds is in the column, and never picked. It owns the selection and nothing else: orders are
// carried out by the simulation, every reading comes from its frames, and what the column and the dock have is what
// `fieldPanel` says of them.
const DEFAULT_EXTENT = { left: -4, right: 4, bottom: -1.3, top: 2 };
// The panel before any was told: nothing is offered.
const NOTHING: SquadPanel = Object.freeze({ squad: null, orders: [], actions: [], refused: {}, stances: null, auto: null, veins: [], wrecks: [], works: [], heaps: [], roads: [] });
// What the player does to a place of the field, with the mouse or with a finger.
const press = () => touching() ? tr('Toque') : tr('Clique');
// The mark of each order, and the one a construction of the column bears when it is worth one.
const ORDER_ICONS = Object.freeze({ move: 'i-flag', attack: 'i-target', bombard: 'i-arc', haul: 'i-haul', tow: 'i-tow', turn: 'i-turn', home: 'i-garage', stop: 'i-stop', free: 'i-unlock' });
// The orders of the main row of the dock; the others are in Mais ações.
const PRIMARY_ORDERS = new Set(['move', 'attack', 'haul', 'turn', 'home', 'stop']);
const MARKS = Object.freeze({ manual: 'i-wheel', fire: 'i-target', dry: 'r-combustivel', stuck: 'i-warn', build: 'i-build', dismantle: 'i-build', repair: 'i-repair' });
// The groups of the column, by the words a reader is told of each.
const GROUPS = Object.freeze({ attack: tr('Tropas de ataque'), logistics: tr('Logística'), fixed: tr('Estruturas') });
// How long a finger is held on a construction of the column to put it in the selection, or take it out of it.
const HOLD_MS = 450;
// The mark of a design in the column (`constructionSilhouette`), as large as the picture of a button (`.pawn-art`), as
// damaged as its construction is (`damage`, field-panel.ts): the images that mask each layer of the picture in its colour,
// worked out again for a design only when what is damaged of it changes.
const ART = Object.freeze({ width: 54, height: 25 });
const silhouettes = new WeakMap<AuthoredConstruction, Silhouette>();
const silhouette = (blueprint: AuthoredConstruction, damage: FieldUnitRow['damage']) => {
  let art = silhouettes.get(blueprint);
  if (!art) silhouettes.set(blueprint, art = { design: compileBlueprint(blueprint), key: null, layers: null });
  const key = JSON.stringify(damage);
  if (art.key !== key) {
    const marks: Record<string, string> | null = constructionSilhouette(art.design, { ...ART, damage });
    art.key = key;
    art.layers = marks && Object.entries(marks).filter(([, mark]) => mark).map(([layer, mark]) => ({ layer, url: `url("data:image/svg+xml,${encodeURIComponent(mark)}")` }));
  }
  return art.layers;
};
// What the picture of each button of the column was last given.
const pictured = new WeakMap<HTMLElement, SilhouetteLayer[] | string>();
// A construction of the squad the player may pick: one standing that no other member holds.
const usable = (u: FieldSquad['units'][number]) => !u.defeated && !u.by;

// `design` is the design of one of the player's constructions on the field, as the page was told of it, when it was. `actions`
// does what each of `ACTIONS` does, given what the panel told of it: dismantling, with those it takes; the others, to the
// construction in focus.
export function initSquadUX({ renderer, view, command, toast, alert, refresh, stopControls, sendAim, selected = () => {}, blocked = () => false, design = () => null,
  actions = {} }: SquadUXOptions) {
  const viewport = required(document.querySelector<HTMLElement>('#viewport')), canvas = renderer.canvas,
    column = required(document.querySelector<HTMLElement>('#field-pawns'));
  const dock = document.querySelector<HTMLElement>('#field-dock'), controls = dock && {
    dock, commands: node('div', 'field-command-options'), primary: node('div', 'squad-orders'), more: node('details', 'field-more-actions'),
    secondary: node('div', 'squad-orders'), postures: node('div', 'field-postures'), menu: node('div', 'field-more-menu'),
    primaryReasons: node('div', 'field-order-reasons'), secondaryReasons: node('div', 'field-order-reasons'),
    deeds: node('div', 'squad-orders field-unit-actions'), deedReasons: node('div', 'field-order-reasons'),
    orderGroup: node('div', 'field-more-group'), deedGroup: node('div', 'field-more-group') },
    orderButtons = new Map<FieldOrderId, OrderButton>(), actionButtons = new Map<FieldActionId, ActionButton>(), stanceButtons = new Map<string, HTMLButtonElement>();
  if (controls) {
    const { dock, commands, primary, more, secondary, postures, menu, primaryReasons, secondaryReasons, deeds, deedReasons, orderGroup, deedGroup } = controls;
    // In the menu the other orders come first, then what is done to the constructions picked, and last the stance.
    const summary = node('summary', '', tr('Mais ações'));
    orderGroup.append(secondary, secondaryReasons); deedGroup.append(deeds, deedReasons);
    menu.append(orderGroup, deedGroup, postures); more.append(summary, menu); commands.append(primary, more, primaryReasons);
    dock.insertBefore(commands, dock.querySelector('.field-dock-status')); commands.hidden = true;
    primary.setAttribute('role', 'group'); primary.setAttribute('aria-label', tr('Ordens para a seleção'));
    secondary.setAttribute('role', 'group'); secondary.setAttribute('aria-label', tr('Outras ordens'));
    deeds.setAttribute('role', 'group'); deeds.setAttribute('aria-label', tr('Ações sobre a seleção'));
    postures.append(node('span', 'eyebrow', tr('Postura de combate')));
    for (const order of ORDERS) {
      const button = node('button'), mark = node('span', 'field-button-icon'), label = node('span'), count = node('small'), key = node('kbd', '', order.key),
        reason = node('p', 'field-order-reason'), main = PRIMARY_ORDERS.has(order.id);
      button.type = 'button'; button.dataset.act = 'order'; button.dataset.value = order.id; mark.innerHTML = icon(ORDER_ICONS[order.id]);
      reason.id = 'field-order-reason-' + order.id; reason.hidden = true;
      button.append(mark, label, count, key); button.hidden = true; orderButtons.set(order.id, { button, label, count, mark, reason, main });
      (main ? primary : secondary).append(button); (main ? primaryReasons : secondaryReasons).append(reason);
    }
    for (const action of ACTIONS) {
      const button = node('button'), mark = node('span', 'field-button-icon'), label = node('span'), reason = node('p', 'field-order-reason');
      button.type = 'button'; button.dataset.act = 'action'; button.dataset.value = action.id; mark.innerHTML = icon(action.icon);
      reason.id = 'field-action-reason-' + action.id; reason.hidden = true;
      button.append(mark, label); button.hidden = true; actionButtons.set(action.id, { button, label, reason });
      deeds.append(button); deedReasons.append(reason);
    }
  }
  const overlay = node('div', 'squad-overlay'), marks = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), box = node('div', 'squad-box'), ruler = node('output', 'squad-ruler');
  overlay.hidden = box.hidden = ruler.hidden = true; marks.setAttribute('class', 'squad-marks'); ruler.setAttribute('aria-live', 'off');
  // The box of a selection is drawn over the column too, which it picks from.
  overlay.append(marks); viewport.append(overlay, box, ruler);
  const drawnMarks = new SquadMarks(marks);
  const selection = new Set<string>(), tags = new Map<string, HTMLDivElement>(), extents = new WeakMap<FieldView, Map<string, SquadExtent>>(), watched: FieldNoticeMemo & { expected: Set<string> } = { expected: new Set() };
  // `shown` is the panel as last painted: what it offers is what the keys and the mouse may order. `kept` is the
  // construction last in the player's hands or picked alone: the one the workshop of the field would replace. `coming`
  // is a construction to pick as soon as the frames have it in the squad: the one just published, or the one met on joining.
  // `watching` is a vehicle of the field the camera goes with, asked for by a double click on it: the player's or another's.
  // `rows` are the constructions of the column as last painted, by id; `held` a finger held on one of them, and `tapped` the
  // last tap of a finger on one of them; `services` when the page first saw each construction built or mended, which how far
  // along that is counts from. `swept` says a box of selection drawn from the column was just let go, over a button that
  // then hears a click.
  let kept: string | null = null, coming: string | null = null, shown: SquadPanel = NOTHING, watching: string | null = null,
    rows = new Map<string, FieldUnitRow>(), held: { done: boolean; timer: ReturnType<typeof setTimeout> } | null = null,
    tapped: { id: string; at: number } | null = null;
  let armed: FieldOrderId | null = null, gesture: SquadGesture | null = null, rightDown: { sx: number; sy: number } | null = null, columnKey = '', ownCursor = false, swept = false, towing = false;
  const services = new Map<string, { until: number; from: number }>();

  const state = () => view.mode === 'test' ? renderer.state : null;
  const field = (s = state()) => fieldOf(s);
  const squad = () => { const s = state(); return s?.squad?.units.length && field(s) ? s.squad : null; };
  // The squad of the shared field, whichever of its two tabs the page is on: the field goes on about its workshop.
  const fielded = () => { const s = renderer.state; return fieldOf(s) && s ? s.squad : null; };
  const commanding = () => { const sq = squad(); return Boolean(sq && !sq.manual); };
  const member = (id: string | undefined) => required(field()).members.find(p => p.id === id);
  const chosen = () => { const sq = squad(); return sq ? sq.units.filter(u => selection.has(u.id) && usable(u)).map(u => u.id) : []; };
  // An order some aircraft did not take for their fuel return says so, in the page's language (server/room.ts `give`).
  const send = (data: SquadCommand) => command('squad', data).then((told: unknown) => {
    if (told && typeof told === 'object' && 'refused' in told && told.refused) toast(messageText(told.refused), true);
    refresh();
  }, (error: unknown) => toast(errorMessage(error), true));
  const worldPoint = (event: MouseEvent): CanvasPoint => {
    const r = canvas.getBoundingClientRect(), sx = event.clientX - r.left, sy = event.clientY - r.top;
    return { sx, sy, ...renderer.camera.toWorld(sx, sy) };
  };
  // The veins and the wrecks at their marks: what there is there, and what those picked can do there.
  const sites = new FieldSites(overlay, { view: viewport, canvas, camera: renderer.camera, command, toast, refresh, picked: () => chosen() });

  // The box of a vehicle around its body, from the plates of the frame it came in.
  function extent(s: FieldView, id: string): SquadExtent {
    let all = extents.get(s);
    if (!all) {
      const raw = new Map<string | undefined, { minX: number; maxX: number; minY: number; maxY: number }>(); all = new Map();
      for (const p of s.plates) {
        if (p.attached === false) continue;
        const d = p.definition, hx = Math.abs(Math.cos(d.angle)) * d.length / 2, hy = Math.abs(Math.sin(d.angle)) * d.length / 2,
          e = raw.get(p.actorId) || { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        e.minX = Math.min(e.minX, d.x - hx); e.maxX = Math.max(e.maxX, d.x + hx);
        e.minY = Math.min(e.minY, d.y - hy); e.maxY = Math.max(e.maxY, d.y + hy); raw.set(p.actorId, e);
      }
      for (const a of s.actors) {
        const e = raw.get(a.id), v = a.vehicle;
        if (e && v && positioned(v)) all.set(a.id, { left: Math.max(-9, e.minX - v.x), right: Math.min(9, e.maxX - v.x),
          bottom: Math.max(-2.5, Math.min(-1.2, e.minY - v.y)), top: Math.min(4.5, e.maxY - v.y) });
      }
      extents.set(s, all);
    }
    return all.get(id) || DEFAULT_EXTENT;
  }
  function bounds(id: string | null | undefined): SquadBounds | null {
    const s = state(), actor = s?.actors.find(a => a.id === id), body = actor?.vehicle;
    if (!s || !actor) return null;
    // Fixed constructions have no vehicle body. Their attached pieces still define the same
    // displayed space used by picking, selection and camera framing.
    if (!body) {
      const frame = renderer.scene?.frame?.source === s ? renderer.scene.frame : sceneFrame(s);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const part of frame.actorParts.get(actor.id) || []) {
        if (part.data.attached === false) continue;
        const points = part.type === 'plate' ? plateCorners({ ...part.definition, ...renderer.scene?.pose?.(part.id, 'plate') }) :
          componentPolygon({ ...part.definition, ...renderer.scene?.pose?.(part.id, 'module') });
        for (const p of points) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
      return Number.isFinite(minX + maxX + minY + maxY) ?
        { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, maxX, minY, maxY, fixed: true } : null;
    }
    const pose = renderer.scene?.actor(actor.id) || body, e = extent(s, actor.id);
    if (!positioned(pose)) return null;
    return { x: pose.x, y: pose.y, minX: pose.x + e.left, maxX: pose.x + e.right, minY: pose.y + e.bottom, maxY: pose.y + e.top };
  }
  // The vehicle under a point of the field, of those wanted: the player's own — of the faction, and held by no other member — or the enemies.
  // The one a piece of which the last frame drew under the pointer — a plate as thin as a chassis rail taken a little off
  // it too (editor.ts `pickShownPiece`) —; else, of those whose box around their plates the point falls in, the nearest.
  const OWN = (_p: SquadMember, mine: boolean) => mine, FOE = (p: SquadMember, mine: boolean) => !mine && p.foe !== false;
  function pick(point: Point, wanted: (member: SquadMember, mine: boolean) => boolean): string | null {
    const sq = required(squad()), people = required(field()), zoom = renderer.camera.zoom, pad = reach(12) / zoom, scene = renderer.scene,
      ok = (p: SquadMember | null | undefined): p is SquadMember => Boolean(p && !people.out(p.id) && wanted(p, sq.units.some(u => u.id === p.id && !u.by))),
      piece = scene?.frame ? pickShownPiece(scene, point, undefined, reach(6) / zoom) : null, shown = piece && scene ? member(scene.frame.byId.get(piece)?.actorId) : null;
    if (ok(shown)) return shown.id;
    let best: { id: string; distance: number } | null = null;
    for (const p of people.members) {
      if (!ok(p)) continue;
      const b = bounds(p.id);
      if (!b || point.x < b.minX - pad || point.x > b.maxX + pad || point.y < b.minY - pad || point.y > b.maxY + pad) continue;
      const distance = Math.abs(point.x - b.x);
      if (!best || distance < best.distance) best = { id: p.id, distance };
    }
    return best?.id || null;
  }
  // The veins the faction knows of, each as it was last told of it, and those of a stretch of the field: of a site
  // it was told nothing of there is no mark, and nothing to send anybody to.
  const veins = () => knownVeins(depositsOf(renderer.ground), required(state()).faction);
  const deposits = (x: number, reach: number) => depositsNear(veins(), x, reach);
  // Where the mark of a vein stands on the screen: over the ground it is dug from.
  const markAt = (deposit: { x: number; id: string }) => { const at = renderer.camera.toScreen(deposit.x, renderer.markHeight(deposit.x, deposit.id)); return { x: at.x, y: at.y - 26 }; };
  // The vein a point of the field names: the nearest one known that no base stills within loading reach of it, or,
  // when only a press on the mark itself counts, the one whose mark is under the pointer.
  function depositAt(point: CanvasPoint, onMark = false) {
    const near = deposits(point.x, Math.max(LOAD_REACH, reach(16) / renderer.camera.zoom)).filter(d => d.active &&
      (!onMark || Math.hypot(markAt(d).x - point.sx, markAt(d).y - point.sy) <= reach(13)));
    return near.sort((a, b) => Math.abs(a.x - point.x) - Math.abs(b.x - point.x))[0] || null;
  }
  function select(ids: readonly string[], additive = false): void {
    armed = null;
    if (!additive) selection.clear();
    for (const id of ids) if (additive && selection.has(id) && ids.length === 1) selection.delete(id); else selection.add(id);
    selected(chosen());
    refresh();
  }
  function focus(id: string | null | undefined, keepZoom = false): void {
    const b = bounds(id), camera = renderer.camera;
    if (!b) return;
    camera.follow?.(null);
    if (!keepZoom && camera.zoom < 14) camera.zoom = 26;
    const cover = camera.cover();
    camera.x = b.x - (cover.left - cover.right) / 2 / camera.zoom;
    camera.y = b.y + (b.fixed ? 0 : 1.2) + (cover.top - cover.bottom) / 2 / camera.zoom;
  }
  // The camera goes to a vehicle and with it while it moves, at the zoom the player had, until the player takes the
  // view away from it, presses Esc, double-clicks the ground or takes a vehicle in hand.
  function watch(id: string | null | undefined): void {
    const b = bounds(id);
    watching = b ? required(id) : null;
    view.cameraFree = !b;
    if (b) focus(id, true);
    refresh();
  }
  // The player's hands go to one vehicle, or back to none.
  async function control(id: string | null | undefined): Promise<void> {
    const sq = squad();
    if (!sq || id && sq.units.find(u => u.id === id)?.defeated) return;
    stopControls(); armed = null;
    try { await command('squad', { order: 'control', id }); } catch (error) { toast(errorMessage(error), true); return; }
    if (id) { watching = id; view.cameraFree = false; }
    else if (!view.cameraFree) watching ||= sq.manual;
    if (id) {
      selection.clear(); selection.add(id); view.testTool = 'fire';
      selected([id]);
      const b = bounds(id), actor = state()?.actors.find(a => a.id === id);
      if (b && actor) { renderer.aim = { x: b.x + Number(actor.facing) * 14, y: b.y + 1.1 }; focus(id); }
      // The first aim leaves once the frames show this vehicle under the player's hands.
      const wait = performance.now(), ready = () => {
        if (squad()?.manual === id) sendAim(); else if (performance.now() - wait < 1000) requestAnimationFrame(ready);
      };
      ready();
    }
    refresh();
  }
  // Visibility describes compatibility; availability and its explanation come
  // from the same model for buttons, shortcuts and contextual commands.
  function offered(kind: FieldOrderId): boolean {
    const action = shown.orders.find(order => order.id === kind);
    if (action && !action.disabled && (!action.ids || action.ids.some(id => selection.has(id)))) return true;
    const reason = action?.reason || shown.refused[kind];
    if (reason) toast(reason);
    return false;
  }
  function order(kind: FieldOrderId, point?: CanvasPoint): void {
    const selected = chosen();
    if (!selected.length) { toast(tr('Selecione um veículo do seu esquadrão primeiro.')); return; }
    if (!offered(kind)) return;
    let ids = (required(shown.orders.find(order => order.id === kind)).ids || selected).filter(id => selected.includes(id));
    if (!ids.length) return;
    // An aircraft is sent to the point of the sky clicked, as high over the ground there, or comes down about the point of
    // the ground clicked (squad.ts `move`).
    if (kind === 'move') send({ order: 'move', ids, x: required(point).x, ...(ids.some(id => flies(state()?.actors.find(a => a.id === id))) ? { y: required(point).y } : {}) });
    else if (kind === 'attack') {
      const targetId = pick(required(point), FOE);
      if (!targetId) { toast(press() + tr(' num veículo inimigo para atacar. Para atingir um ponto do terreno, use Bombardear.')); return; }
      send({ order: 'attack', ids, targetId });
    } else if (kind === 'bombard') send({ order: 'bombard', ids, point: { x: required(point).x, y: required(point).y } });
    else if (kind === 'haul') {
      const deposit = depositAt(required(point));
      if (!deposit) { toast(press() + tr(' na marca de uma jazida que a facção conhece.')); return; }
      ids = (shown.veins.find(row => row.id === deposit.id)?.collect?.ids || []).filter(id => selected.includes(id));
      if (!ids.length) { toast(tr('A seleção não tem equipamento compatível com esta jazida.')); return; }
      send({ order: 'haul', ids, depositId: deposit.id });
    } else if (kind === 'tow') tow(required(ids[0]), point);
    else if (kind === 'turn') turn(ids);
    else if (kind === 'home') send({ order: 'home', ids });
    else if (kind === 'stop') send({ order: 'stop', ids });
    else if (kind === 'free') command('squad', { order: 'free', ids }).then(() => {
      toast(ids.length === 1 ? tr('Liberado: outro membro da facção pode assumi-lo.') : tr`${ids.length} liberados: outro membro da facção pode assumi-los.`); refresh();
    }, (error: unknown) => toast(errorMessage(error), true));
  }
  // The vehicle picked alone takes on its cable another of the faction that stands still beside it, or lets go of the one
  // it is on. The field fixes the cable and says why it will not; the page only spares it a request it would refuse.
  function tow(actorId: string, point?: CanvasPoint): void {
    if (towing) return;
    if (released()) { cable({ act: 'detach', actorId }, tr('Cabo solto.')); return; }
    const targetId = pick(required(point), OWN), candidates = towable(actorId);
    if (targetId && targetId !== actorId && towOf(state(), targetId)) { toast(tr('Esse veículo já está num cabo.')); return; }
    if (!targetId || !candidates.has(targetId)) { toast(press() + tr(' num veículo da sua facção para rebocar.')); return; }
    if (candidates.get(targetId) === false) { toast(tr('Chegue mais perto (até 4 m) e pare os dois.')); return; }
    cable({ act: 'attach', actorId, targetId }, tr('Cabo engatado.'));
  }
  const cable = (data: TowData, done: string) => {
    towing = true;
    command('tow', data).then(() => { toast(done); refresh(); }, (error: unknown) => toast(errorMessage(error), true)).finally(() => { towing = false; });
  };
  // Whether the order of the cable is now the one that lets go of it.
  const released = () => Boolean(shown.orders.find(order => order.id === 'tow')?.release);
  // The vehicles of the faction the one picked alone could take on its cable, each with whether it could now (`towReady`):
  // those no other member holds, that stand on the field and are on no cable.
  function towable(actorId: string): Map<string, boolean | null> {
    const s = state(), sq = squad(), found = new Map<string, boolean | null>();
    if (!s || !sq) return found;
    for (const u of sq.units) {
      const actor = u.id !== actorId && usable(u) && !required(field()).out(u.id) && s.actors.find(a => a.id === u.id && a.vehicle && !a.ghost);
      if (actor && !towOf(s, u.id)) found.set(u.id, towReady(s, actorId, u.id));
    }
    return found;
  }
  function stance(value: SquadStance): void {
    const selected = chosen(), ids = (shown.orders.find(order => order.id === 'attack')?.ids || selected).filter(id => selected.includes(id));
    if (ids.length) send({ order: 'stance', ids, stance: value });
  }
  // A turning about is asked of the field, which says how long it takes, and whether it is in the air: an aircraft flies on.
  const turn = (ids: string[]) => command('squad', { order: 'turn', ids }).then((told: unknown) => {
    if (!told || typeof told !== 'object' || !('seconds' in told) || typeof told.seconds !== 'number') throw new TypeError('Invalid turn receipt');
    toast('aloft' in told && told.aloft ? tr`Virando no ar: ${told.seconds} s seguindo o voo, sem atirar. Um acerto nesse tempo desfaz o giro.` :
      tr`Virando: ${told.seconds} s sem andar nem atirar. Um acerto nesse tempo desfaz o giro.`); refresh();
  }, (error: unknown) => toast(errorMessage(error), true));
  function turnManual() {
    const id = squad()?.manual;
    if (!id || !shown.turn) return;
    if (shown.turnDisabled) { if (shown.turnReason) toast(shown.turnReason); return; }
    return turn([id]);
  }
  function arm(kind: FieldOrderId): void {
    if (kind === 'stop' || kind === 'turn' || kind === 'home' || kind === 'free' || kind === 'tow' && released()) { armed = null; order(kind); }
    else if (offered(kind)) armed = armed === kind ? null : kind;
    refresh();
  }

  // The existing selection gesture also measures its horizontal span in world metres. Reprojecting
  // the start keeps the rectangle and its reading in agreement when the player zooms mid-drag. A box drawn from the
  // column measures nothing of the field.
  function updateDragBox() {
    const visible = Boolean(gesture?.moved && !gesture.armed && commanding()), measured = visible && !gesture?.column;
    if (box.hidden === visible) box.hidden = !visible;
    if (ruler.hidden === measured) ruler.hidden = !measured;
    if (!visible || !gesture || gesture.armed) return;
    const reading = selectionRuler(renderer.camera, gesture.start, gesture.end);
    Object.assign(gesture.end, reading.end); gesture.box = reading.box;
    for (const [element, values] of [[box, reading.box], [ruler, reading.label]] as const) for (const [key, value] of Object.entries(values)) {
      const pixels = Math.round(value) + 'px'; if (key === 'left' || key === 'top' || key === 'width' || key === 'height') { if (element.style[key] !== pixels) element.style[key] = pixels; }
    }
    if (ruler.textContent !== reading.text) ruler.textContent = reading.text;
  }
  // A box of selection takes in the player's constructions within it on the field, and those whose buttons it touches
  // where the column shows them, with those picked before it when it was begun with Shift or Ctrl: as it is drawn, and as
  // it is let go.
  function sweep({ start, end, box: drawn, before }: BoxGesture): void {
    const taken = new Set(before), minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x),
      minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
    for (const u of required(squad()).units) {
      const b = usable(u) && bounds(u.id);
      if (b && b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY) taken.add(u.id);
    }
    const pawns = drawn && !column.hidden ? column.querySelectorAll<HTMLButtonElement>('.pawn') : [];
    if (pawns.length && drawn) {
      const at = canvas.getBoundingClientRect(), shows = column.getBoundingClientRect(),
        left = Math.max(at.left + drawn.left, shows.left), right = Math.min(at.left + drawn.left + drawn.width, shows.right),
        top = Math.max(at.top + drawn.top, shows.top), bottom = Math.min(at.top + drawn.top + drawn.height, shows.bottom);
      if (left <= right && top <= bottom) for (const pawn of pawns) {
        const r = pawn.getBoundingClientRect();
        const id = required(pawn.dataset.id);
        if (!pawn.disabled && !rows.get(id)?.held && r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom) taken.add(id);
      }
    }
    if (taken.size === selection.size && [...taken].every(id => selection.has(id))) return;
    selection.clear(); for (const id of taken) selection.add(id);
    refresh();
  }
  // What was picked before a box that is called off.
  function unsweep(was: ReadonlySet<string>): void { selection.clear(); for (const id of was) selection.add(id); refresh(); }

  // The field: left button selects, right button orders. Handled before the
  // canvas handlers, which keep aiming, firing and moving the camera.
  const onCanvas = (event: Event) => event.target === canvas;
  // A box of selection: where it began, where the pointer is, whether it adds to those picked (`before`, with those that
  // were picked when it began, `was`), whether it began on the column, and whether it was dragged at all.
  const boxing = (p: CanvasPoint, additive: boolean, column = false): BoxGesture =>
    ({ start: p, end: p, additive, moved: false, column, was: new Set(selection), before: new Set(additive ? selection : []) });
  viewport.addEventListener('pointerdown', event => {
    swept = false;
    if (blocked() || !squad()) return;
    // A drag that starts on the column with the mouse draws a box of selection, as one on the field does; a press that
    // drags nothing stays the column's own click.
    if (!onCanvas(event)) {
      if (isNode(event.target) && column.contains(event.target) && event.button === 0 && event.pointerType !== 'touch' && commanding())
        gesture = boxing(worldPoint(event), event.shiftKey || event.ctrlKey || event.metaKey, true);
      return;
    }
    if (controls) controls.more.open = false;
    const p = worldPoint(event);
    if (event.button === 2) { rightDown = { sx: p.sx, sy: p.sy }; return; }
    if (event.button !== 0 || !commanding()) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey, id = armed ? null : pick(p, OWN);
    // Shift + drag over open ground stays with the camera.
    if (event.shiftKey && !armed && !id) return;
    event.stopPropagation(); event.preventDefault(); canvas.focus({ preventScroll: true });
    // A finger gives the order waiting for it where it is let go, unless it went on to move the camera: the mouse where it presses.
    if (armed && event.pointerType === 'touch') { capture(canvas, event.pointerId); gesture = { start: p, end: p, armed, moved: false }; return; }
    if (armed) { const kind = armed; armed = null; order(kind, p); refresh(); return; }
    if (id) { select([id], additive); return; }
    capture(canvas, event.pointerId);
    gesture = boxing(p, additive);
  }, true);
  viewport.addEventListener('pointermove', event => {
    if (blocked()) return;
    if (!gesture) {
      if (onCanvas(event) && commanding() && !event.buttons) {
        const p = worldPoint(event);
        canvas.style.cursor = armed ? 'crosshair' : pick(p, OWN) || sites.at(p.sx, p.sy) ? 'pointer' : selection.size && pick(p, FOE) ? 'crosshair' : '';
        ownCursor = true;
      }
      return;
    }
    // A press on the column let go where it was not heard.
    if (gesture.column && !event.buttons) { gesture = null; return; }
    event.stopPropagation();
    const p = worldPoint(event); gesture.end = p;
    if (!gesture.moved && Math.hypot(p.sx - gesture.start.sx, p.sy - gesture.start.sy) >= 4) {
      gesture.moved = true;
      // A box drawn from the column takes the pointer from the button it began on.
      if (gesture.column) { armed = null; capture(canvas, event.pointerId); }
    }
    updateDragBox();
    if (gesture.moved && !gesture.armed) sweep(gesture);
  }, true);
  const release = (event: PointerEvent) => {
    if (blocked()) {
      rightDown = null;
      if (gesture) {
        if (gesture.moved && !gesture.armed) unsweep(gesture.was);
        gesture = null; box.hidden = ruler.hidden = true;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (rightDown && event.button === 2) {
      const p = worldPoint(event), still = Math.hypot(p.sx - rightDown.sx, p.sy - rightDown.sy) < 5; rightDown = null;
      // A right click that did not drag the camera is an order to the selection.
      if (still && onCanvas(event) && commanding() && event.type === 'pointerup' && chosen().length) {
        const requested = armed;
        armed = null;
        if (requested) order(requested, p);
        else if (event.ctrlKey || event.altKey || event.metaKey) order('bombard', p);
        else if (pick(p, FOE)) order('attack', p);
        else if (depositAt(p, true)) order('haul', p);
        else order('move', p);
      }
    }
    if (!gesture) return;
    // A press on the column that dragged nothing is its click.
    if (gesture.column && !gesture.moved) { gesture = null; return; }
    event.stopPropagation();
    updateDragBox();
    const drawn = gesture, { start, end, additive, moved, armed: waiting } = drawn; gesture = null; box.hidden = ruler.hidden = true;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (event.type !== 'pointerup' || !squad()) { if (moved && !waiting && squad()) unsweep(drawn.was); return; }
    if (waiting) { if (!moved) { armed = null; order(waiting, end); refresh(); } return; }
    // A press on the mark of a vein or a wreck opens what there is there, and keeps whoever is picked.
    if (!moved) { const site = sites.at(start.sx, start.sy); if (site) sites.toggle(site); else if (!additive) select([]); return; }
    // Those the box took in stay picked, and are told once. A box let go over a button of the column is no click on it.
    sweep(drawn); armed = null; swept = drawn.column; selected(chosen()); refresh();
  };
  viewport.addEventListener('pointerup', release, true);
  viewport.addEventListener('pointercancel', release, true);
  // A double click on the field puts the camera on the vehicle under it, or lets it go over open ground. With a vehicle
  // in hand the clicks on the field are its aim and its fire, two of them too: the camera stays with it.
  viewport.addEventListener('dblclick', event => {
    if (blocked() || !onCanvas(event) || !commanding() || event.shiftKey || event.ctrlKey || event.metaKey || event.button !== 0) return;
    const p = worldPoint(event), id = pick(p, OWN) || pick(p, FOE);
    if (id) event.stopPropagation();
    watch(id);
  }, true);

  document.addEventListener('keydown', event => {
    const sq = squad();
    const target = isElement(event.target) ? event.target : null;
    if (!sq || blocked() || viewport.inert || target?.closest('#first-objectives') ||
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() !== 'a' || event.altKey) return;
    if ([...document.querySelectorAll('dialog')].some(d => d.open) || target?.matches('input,select,textarea,[contenteditable=true]')) return;
    const key = event.key.toLowerCase(), done = () => { event.preventDefault(); event.stopPropagation(); };
    if (key === 'escape' && controls?.more.open) { done(); controls.more.open = false; canvas.focus({ preventScroll: true }); return; }
    if (key === 'escape' && sites.close()) { done(); return; }
    // A key is the place of a construction in the column.
    if (/^[1-9]$/.test(event.key)) {
      const place = shown.squad?.units[Number(event.key) - 1], unit = place && sq.units.find(u => u.id === place.id);
      if (!unit || unit.defeated) return;
      done();
      if (unit.by) { toast(heldText(unit.by.name)); return; }
      if (sq.manual) { if (sq.manual !== unit.id) control(unit.id); else focus(unit.id); }
      else if (!event.shiftKey && selection.size === 1 && selection.has(unit.id)) { selected([unit.id]); focus(unit.id); }
      else select([unit.id], event.shiftKey);
      return;
    }
    if (key === 'escape') {
      if (sq.manual) { done(); releaseControl(); }
      else if (armed) { done(); armed = null; refresh(); }
      else if (watching) { done(); watch(null); }
      else if (selection.size) { done(); select([]); }
      return;
    }
    if (key === 'c' && !event.repeat) {
      done();
      if (sq.manual) releaseControl();
      else if (chosen().length === 1) control(chosen()[0]); else toast(tr('Selecione uma única construção para assumir o controle.'));
      return;
    }
    // The vehicle in hand turns about by the key of the order.
    if (sq.manual && key === 'v' && !event.repeat && shown.turn) { done(); turnManual(); return; }
    if (sq.manual) return;
    if ((event.ctrlKey || event.metaKey) && key === 'a') { done(); select(sq.units.filter(usable).map(u => u.id)); return; }
    if (event.repeat) return;
    const shortcut = ORDERS.find(order => order.key.toLowerCase() === key);
    if (shortcut) { done(); if (chosen().length) arm(shortcut.id); else toast(tr('Selecione um veículo do seu esquadrão primeiro.')); return; }
    // Holding fire is for whoever has something to fire.
    if (key === 'g') { done(); const ids = chosen(), units = sq.units.filter(u => ids.includes(u.id));
      if (units.length && shown.stances) stance(shown.stances.some(s => s.id === 'hold' && s.active) ? 'return' : 'hold');
      else if (units.length && shown.refused.attack) toast(shown.refused.attack); }
  }, true);

  // A construction of the column is picked by a click, put in the selection or taken out of it with Shift or Ctrl, and
  // followed by the camera at a double click; with a vehicle in hand, a click only finds it on the field. One another member
  // holds says whose it is. A drag over the column picks those it takes in (`sweep`).
  const panelClick = (event: MouseEvent) => {
    if (blocked()) return;
    const button = isElement(event.target) ? event.target.closest<HTMLButtonElement>('button[data-act]') : null;
    if (!button || button.disabled) return;
    const { act, id, value } = button.dataset, sq = squad();
    if (!sq) return;
    if (act === 'unit') {
      if (id === undefined) throw new Error('Missing squad unit id');
      // The click a held finger ends in was its pick, and the one a box drawn from the column ends in, the box's.
      if (held?.done) { held = null; return; }
      if (swept) { swept = false; return; }
      // A finger's second tap on the same button, soon after the first, is a double click, as on the field (touch.ts): a
      // browser may count a finger's taps no more than one.
      const tap = touching() ? { id, at: event.timeStamp } : null,
        twice = event.detail > 1 || Boolean(tap && tapped?.id === id && tap.at - tapped.at < TWICE_MS);
      tapped = twice ? null : tap;
      if (twice && !event.shiftKey && !event.ctrlKey && !event.metaKey) watch(id);
      else if (sq.manual) { watching = null; view.cameraFree = true; focus(id); refresh(); }
      else if (rows.get(id)?.held) toast(heldText(required(rows.get(id)).held));
      else select([id], event.shiftKey || event.ctrlKey || event.metaKey);
    } else if (act === 'order' && isOrderId(value)) arm(value);
    else if (act === 'stance' && isSquadStance(value)) stance(value);
    else if (act === 'action' && isActionId(value)) actions[value]?.(shown.actions.find(action => action.id === value));
    if (act !== 'unit' && controls) controls.more.open = false;
    // The keyboard goes back to the field: Space pauses instead of pressing this button again.
    canvas.focus({ preventScroll: true });
  };
  column.addEventListener('click', panelClick);
  controls?.commands.addEventListener('click', panelClick);
  // A finger held on a construction of the column puts it in the selection, or takes it out: what Shift does with the mouse.
  column.addEventListener('pointerdown', event => {
    const pawn = isElement(event.target) ? event.target.closest<HTMLButtonElement>('button[data-act="unit"]') : null;
    clearTimeout(held?.timer); held = null;
    if (event.pointerType !== 'touch' || !pawn || pawn.disabled || pawn.dataset.id !== undefined && rows.get(pawn.dataset.id)?.held || blocked()) return;
    const press: { done: boolean; timer: ReturnType<typeof setTimeout> } = held = { done: false, timer: setTimeout(() => { if (!commanding()) return; press.done = true; select([required(pawn.dataset.id)], true); }, HOLD_MS) };
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) column.addEventListener(type, () => { if (held && !held.done) { clearTimeout(held.timer); held = null; } });
  column.addEventListener('contextmenu', event => { if (isElement(event.target) && event.target.closest('button[data-act="unit"]')) event.preventDefault(); });

  // Markers follow the vehicles on screen: who is who, who is selected, where each one was sent. Of those another member
  // holds, that member is told.
  function follow(encounters: readonly EncounterBand[] = []): void {
    if (gesture) updateDragBox();
    const sq = squad(), visible = Boolean(sq || encounters.length && state()?.shared), mine = sq ? sq.units.filter(u => !u.by) : [];
    if (overlay.hidden === visible) overlay.hidden = !visible;
    for (const [id, tag] of tags) if (!mine.some(u => u.id === id)) { tag.remove(); tags.delete(id); }
    const camera = renderer.camera;
    drawnMarks.begin(camera);
    if (visible) for (const encounter of encounters) drawnMarks.encounter(encounter, camera);
    const radar = sq && selectedRadar(state(), renderer.scene, selection);
    if (radar) drawnMarks.radar(radar, camera, renderer.ground);
    if (!sq) { drawnMarks.end(); sites.place([]); return; }
    // Keep every known marker in view; only the labels compete for screen space, with the button over them of what those
    // picked can do at a vein.
    const known = veins(), seen = veinMarks(known, camera.x, camera.width / camera.zoom / 2 + 40).map(mark => {
      const action = sites.size('vein', mark.id); return action ? { ...mark, action } : mark;
    }), laid = drawnMarks.deposits(seen, markAt);
    for (const u of mine) {
      const b = !u.defeated && bounds(u.id), projected = b ? squadTagBox(camera, b) : null;
      let tag = tags.get(u.id);
      if (!tag && projected?.visible) { tag = node('div', 'squad-tag'); tag.append(node('b'), node('span')); overlay.append(tag); tags.set(u.id, tag); }
      const picked = selection.has(u.id), manual = sq.manual === u.id;
      if (tag) updateSquadTag(tag, projected, { selected: picked, manual, alert: u.alert, heard: Boolean(u.heard) });
      if (tag && projected?.visible) {
        const row = rows.get(u.id), feedback = (manual || picked && selection.size === 1) && row ? row.feedback : null,
          line = tag.children[1], words = feedback?.text || '', kind = feedback?.kind || '';
        if (!isHtml(line)) throw new Error('Missing squad feedback label');
        if (line.hidden !== !words) line.hidden = !words;
        if (line.textContent !== words) line.textContent = words;
        if (line.dataset.serviceFeedback !== kind) line.dataset.serviceFeedback = kind;
      }
      if (!b || !projected) continue;
      const { width, height, cx, cy } = projected;
      const from = { x: cx, y: cy }, ink = picked ? 1 : .45;
      // Where a vehicle's senses put an enemy that came freshly into them; of one the side was told no place of, beside
      // the vehicle, on the side it came from.
      if (u.heard) {
        const heardX = u.heard.x, placed = typeof heardX === 'number' && Number.isFinite(heardX),
          to = placed ? camera.toScreen(heardX, renderer.markHeight(heardX)) : { x: cx + (Number(u.heard.side) < 0 ? -1 : 1) * (width / 2 + 14), y: cy + 30 };
        drawnMarks.heard(u.id, to, placed);
      }
      // Where a vehicle is going, and the vein a hauler works, only of those picked or in the player's hands.
      // Of an aircraft sent to a point of the sky, the flag stands there, with how high over the ground it is.
      if (u.move && (picked || manual)) {
        const flyHeight = u.move.height, sky = typeof flyHeight === 'number' && Number.isFinite(flyHeight),
          to = camera.toScreen(u.move.x, sky ? renderer.ground.height(u.move.x) + flyHeight : renderer.markHeight(u.move.x));
        drawnMarks.line('move', u.id, { x: from.x, y: cy + height / 2 }, to, ink, 'flag', sky ? metres(flyHeight) : '');
      }
      const haul = u.haul, dug = (picked || manual) && haul && known.find(d => d.id === haul.depositId);
      if (dug) drawnMarks.line('haul', u.id, from, markAt(dug), ink);
      const target = u.attack?.targetId ? bounds(u.attack.targetId) : null, point = u.attack?.point;
      if (target || point) {
        const to = target ? camera.toScreen(target.x, (target.minY + target.maxY) / 2) : camera.toScreen(required(point).x, required(point).y);
        drawnMarks.line('attack', u.id, from, to, ink, target ? 'vehicle' : 'point');
      }
    }
    drawnMarks.end();
    sites.place(blocked() ? [] : [...laid.map(veinSite), ...wreckSites(camera), ...workSites()]);
  }
  // Where a vein is on the screen: its mark, with its words when they are shown and the button over them.
  function veinSite({ deposit, at, layout: placed }: { deposit: SquadDepositMark; at: Point; layout: DepositLabelPlacement | undefined }): FieldSiteMark {
    const layout = required(placed);
    const mark = { left: at.x - 9, right: at.x + 9, top: at.y - 9, bottom: at.y + 9 }, words = layout.mode === 'hidden' ? null : layout.box;
    return { kind: 'vein', id: deposit.id, x: words ? at.x + layout.x : at.x,
      area: words ? { left: Math.min(mark.left, words.left), right: Math.max(mark.right, words.right), top: words.top, bottom: mark.bottom } : mark,
      button: layout.action && { x: at.x + layout.action.x, y: at.y + layout.action.y } };
  }
  // Where a wreck is on the screen: its label, which is its mark, and the wreck itself under it. Wrecks that stand on one
  // another have one label, and one button over it at a time.
  function wreckSites(camera: SquadUXRenderer['camera']): FieldSiteMark[] {
    const taken = new Set<SquadLabelBox>();
    return shown.wrecks.flatMap((row: { id: string; salvage?: unknown }) => {
      const label = renderer.labelBoxes.get(row.id), b = label && bounds(row.id);
      if (!label) return [];
      const corner = b && camera.toScreen(b.minX, b.maxY), end = b && camera.toScreen(b.maxX, b.minY),
        free = row.salvage && !taken.has(label) && taken.add(label);
      return [{ kind: 'wreck', id: row.id, x: label.x, button: free ? { x: label.x, y: label.top - 4 } : null,
        area: b ? { left: Math.min(label.left, required(corner).x), right: Math.max(label.right, required(end).x), top: label.top, bottom: Math.max(label.bottom, required(end).y) } : label }];
    });
  }
  // Where the works, the heaps, the roads asked for and the posts of the faction are on the screen, as the field draws them (render.ts,
  // `siteBoxes`): each its label and what is drawn of it under that, with no button over it.
  function workSites(): FieldSiteMark[] {
    const told = { work: shown.works, heap: shown.heaps, road: shown.roads, post: shown.posts };
    return [...renderer.siteBoxes?.values() ?? []].filter(site => told[site.kind]?.some(row => row.id === site.id))
      .map(({ kind, id, label, area }) => ({ kind, id, x: label.x, button: null,
        area: { left: Math.min(label.left, area.left), right: Math.max(label.right, area.right), top: Math.min(label.top, area.top), bottom: Math.max(label.bottom, area.bottom) } }));
  }

  // The column: the constructions of the faction group by group, each a small picture of it with its key in a corner — and
  // beside the key a camera, on the one the camera goes with —, a mark of what holds it or what it does when that is worth
  // one, and a hairline of how full its tanks are — or, while it is built, mended or taken down, of how far along that is.
  // What it is called and what it is doing are told to the pointer.
  function build(p: FieldPanelView): string {
    return COLUMN.map(group => {
      const units = required(p.squad).units.filter(u => u.group === group);
      return units.length ? `<div class="pawn-group" role="group" aria-label="${GROUPS[group]}" data-group="${group}">` + units.map(u =>
        `<button type="button" class="pawn" data-act="unit" data-id="${escapeHTML(u.id)}"><span class="pawn-art"></span>` +
        `<kbd>${u.number}</kbd>${icon('i-camera', 'pawn-watch')}${icon('', 'pawn-mark')}<i></i></button>`).join('') + '</div>' : '';
    }).join('');
  }
  // Buttons survive new frames, status changes and changes of eligibility. They use only
  // the recipients already resolved by fieldPanel; this presentation owns no selection.
  function renderCommands(p: FieldPanelView): void {
    if (!controls) return;
    const { commands, more, postures, primaryReasons, secondaryReasons, orderGroup, deedGroup, deedReasons } = controls;
    const hidden = !p.squad || !p.orders.length && !p.actions.length || Boolean(p.release);
    if (commands.hidden !== hidden) commands.hidden = hidden;
    if (commands.hidden) { more.open = false; return; }
    const count = required(p.squad).units.filter(unit => unit.selected && !unit.defeated).length;
    let mainReason = false, otherReason = false;
    for (const [id, entry] of orderButtons) {
      const order = p.orders.find(order => order.id === id), { button, label, mark, reason } = entry;
      if (button.hidden !== !order) button.hidden = !order;
      const explains = Boolean(order?.disabled && order.reason && !order.quiet);
      if (reason.hidden !== !explains) reason.hidden = !explains;
      if (!reason.hidden && order) {
        const words = (order.label || order.name) + ': ' + order.reason;
        if (reason.textContent !== words) reason.textContent = words;
        if (entry.main) mainReason = true; else otherReason = true;
      }
      if (!order) continue;
      const recipients = order.ids?.length ?? count, partial = !order.disabled && recipients < count,
        name = order.label && order.label !== order.name ? order.label + ': ' + order.name.toLowerCase() : order.name,
        scope = partial ? ` · ${recipients} de ${count} selecionados` : '',
        title = order.disabled ? order.reason : order.name + scope + ' · ' + order.key + (order.hint ? ' — ' + press().toLowerCase() + ' ' + order.hint : ''),
        glyph = order.icon || ORDER_ICONS[id];
      if (button.disabled !== Boolean(order.disabled)) button.disabled = Boolean(order.disabled);
      const description = reason.hidden ? '' : reason.id;
      if (button.getAttribute('aria-describedby') !== description) button.setAttribute('aria-describedby', description);
      if (label.textContent !== (order.label || order.name)) label.textContent = order.label || order.name;
      if (entry.count.textContent !== (partial ? recipients + '/' + count : '')) entry.count.textContent = partial ? recipients + '/' + count : '';
      if (entry.count.hidden !== !partial) entry.count.hidden = !partial;
      if (button.title !== title) button.title = title;
      if (button.getAttribute('aria-label') !== name + scope) button.setAttribute('aria-label', name + scope);
      if (button.getAttribute('aria-pressed') !== String(order.active)) button.setAttribute('aria-pressed', String(order.active));
      if (mark.dataset.icon !== glyph) { mark.dataset.icon = glyph; mark.innerHTML = icon(glyph); }
    }
    if (primaryReasons.hidden !== !mainReason) primaryReasons.hidden = !mainReason;
    if (secondaryReasons.hidden !== !otherReason) secondaryReasons.hidden = !otherReason;
    const others = p.orders.some(order => !PRIMARY_ORDERS.has(order.id));
    if (orderGroup.hidden !== !others) orderGroup.hidden = !others;
    // What is done to the constructions picked: a disabled one says why, under them.
    let deedReason = false;
    for (const [id, { button, label, reason }] of actionButtons) {
      const action = p.actions.find(action => action.id === id), explains = Boolean(action?.disabled && action.reason);
      if (button.hidden !== !action) button.hidden = !action;
      if (reason.hidden !== !explains) reason.hidden = !explains;
      if (!action) continue;
      const words = 'label' in action && action.label || action.name, title = action.disabled ? action.reason : action.title;
      if (explains) { deedReason = true; if (reason.textContent !== action.name + ': ' + action.reason) reason.textContent = action.name + ': ' + action.reason; }
      if (label.textContent !== words) label.textContent = words;
      if (button.disabled !== Boolean(action.disabled)) button.disabled = Boolean(action.disabled);
      if (button.title !== title) button.title = title;
      if (button.getAttribute('aria-label') !== words) button.setAttribute('aria-label', words);
      const description = explains ? reason.id : '';
      if (button.getAttribute('aria-describedby') !== description) button.setAttribute('aria-describedby', description);
    }
    if (deedGroup.hidden !== !p.actions.length) deedGroup.hidden = !p.actions.length;
    if (deedReasons.hidden !== !deedReason) deedReasons.hidden = !deedReason;
    for (const [id, entry] of stanceButtons) {
      const hidden = !p.stances?.some(stance => stance.id === id);
      if (entry.hidden !== hidden) entry.hidden = hidden;
    }
    for (const stance of p.stances || []) {
      let button = stanceButtons.get(stance.id);
      if (!button) { button = node('button'); button.type = 'button'; button.dataset.act = 'stance'; button.dataset.value = stance.id; stanceButtons.set(stance.id, button); postures.append(button); }
      if (button.hidden) button.hidden = false;
      if (button.textContent !== stance.name) button.textContent = stance.name;
      if (button.title !== stance.help) button.title = stance.help;
      if (button.getAttribute('aria-pressed') !== String(stance.active)) button.setAttribute('aria-pressed', String(stance.active));
    }
    if (postures.hidden !== !p.stances?.length) postures.hidden = !p.stances?.length;
    const noMore = !others && !p.actions.length && postures.hidden;
    if (more.hidden !== noMore) more.hidden = noMore;
  }
  // The readings of the column, on the buttons it has.
  function update(_p: FieldPanelView): void {
    const s = state(), time = s?.time ?? 0, facing = new Map((s?.actors || []).map(actor => [actor.id, actor.facing]));
    for (const id of services.keys()) if (!rows.get(id)?.until) services.delete(id);
    for (const pawn of column.querySelectorAll<HTMLButtonElement>('.pawn')) {
      const u = required(rows.get(required(pawn.dataset.id))), blueprint = design(u.id), art = required(pawn.querySelector<HTMLElement>('.pawn-art')),
        layers = blueprint ? silhouette(blueprint, u.damage) : null, look = layers || 'k-' + u.kind;
      // The mark of its design, a layer for each colour its damage is drawn in, or with no design to draw it from, the icon
      // of what it is.
      if (pictured.get(art) !== look) {
        pictured.set(art, look); art.classList.toggle('design', Boolean(layers));
        art.innerHTML = layers ? layers.map(({ layer }) => `<span data-layer="${layer}"></span>`).join('') : icon('k-' + u.kind);
        layers?.forEach(({ url }, index) => { const layer = art.children[index]; if (!isHtml(layer)) throw new Error('Missing squad silhouette layer'); layer.style.setProperty('--art', url); });
      }
      // A design faces left: one that faces right on the field is shown so.
      const flip = String(Boolean(layers) && facing.get(u.id) === 1);
      if (art.dataset.flip !== flip) art.dataset.flip = flip;
      const watched = u.id === watching, title = [u.name, u.held && 'com ' + u.held, u.status, u.feedback?.text, watched && tr('câmera fixa')].filter(Boolean).join(' · ');
      if (pawn.title !== title) { pawn.title = title; pawn.setAttribute('aria-label', title); }
      if (pawn.dataset.held !== String(Boolean(u.held))) pawn.dataset.held = String(Boolean(u.held));
      if (pawn.dataset.watched !== String(watched)) pawn.dataset.watched = String(watched);
      if (pawn.disabled !== u.defeated) pawn.disabled = u.defeated;
      if (pawn.dataset.selected !== String(u.selected)) pawn.dataset.selected = String(u.selected);
      if (pawn.dataset.manual !== String(u.manual)) pawn.dataset.manual = String(u.manual);
      if (pawn.getAttribute('aria-pressed') !== String(u.selected || u.manual)) pawn.setAttribute('aria-pressed', String(u.selected || u.manual));
      if (pawn.dataset.alert !== String(u.alert)) pawn.dataset.alert = String(u.alert);
      if (pawn.dataset.mark !== u.mark) pawn.dataset.mark = u.mark;
      const mark = required(pawn.querySelector('.pawn-mark use')), glyph = isMark(u.mark) ? '#' + MARKS[u.mark] : '';
      if (mark.getAttribute('href') !== glyph) mark.setAttribute('href', glyph);
      // How far along a construction is built or mended counts from when the page first saw it so, to when that ends; how
      // far one is taken down, the field tells. Else its hairline is how full its tanks are, in the colour of how low they
      // run (`fuel`, field-panel.ts), and one with no tank has none.
      let progress = u.progress ?? null;
      if (u.until !== null) {
        if (services.get(u.id)?.until !== u.until) services.set(u.id, { until: u.until, from: Math.min(time, u.until) });
        const { from } = required(services.get(u.id));
        progress = u.until > from ? Math.min(1, Math.max(0, (time - from) / (u.until - from))) : 1;
      }
      const gauge = progress !== null ? 'progress' : u.fuel ? u.fuel.level || 'fuel' : '';
      if (pawn.dataset.gauge !== gauge) pawn.dataset.gauge = gauge;
      required(pawn.querySelector('i')).style.setProperty('--fill', Math.round((progress ?? u.fuel?.share ?? 0) * 100) + '%');
    }
  }
  // The one construction the base and the workshop of the field work on: the one in hand or picked alone and,
  // from the workshop, the one that last was, while it is still the player's.
  function focused(): string | null {
    const sq = squad(), ids = chosen();
    return sq ? sq.manual || (ids.length === 1 ? required(ids[0]) : null) : fielded()?.units.some(u => u.id === kept && usable(u)) ? kept : null;
  }

  function releaseControl() { const id = squad()?.manual; if (id) return control(null).then(() => select([id])); }

  return {
    follow,
    // In command of the squad with no vehicle under the player's hands.
    commanding, focused,
    cancelOrder() { armed = null; refresh(); },
    release: releaseControl,
    turn: turnManual,
    frame() {
      const sq = squad(), ids = sq?.manual ? [sq.manual] : chosen(), objects = ids.map(bounds).filter((b): b is SquadBounds => b !== null).map(b =>
        ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, width: b.maxX - b.minX, height: b.maxY - b.minY }));
      if (!objects.length) return false;
      watching = null; view.cameraFree = true; renderer.camera.follow?.(null); renderer.camera.fit({ plates: [], modules: objects }, true); refresh(); return true;
    },
    // The vehicle the camera goes with by a double click, while it is on the field; and letting it go.
    watched() { if (watching && !state()?.actors.some(a => a.id === watching)) watching = null; return watching; },
    watch,
    unwatch() { watching = null; view.cameraFree = true; renderer.camera.follow?.(null); refresh(); },
    // Only the one construction picked alone while commanding is seen from inside. Groups and the construction
    // in the player's hands stay outside; all chosen constructions still bear their selection edge.
    opened() { const ids = commanding() ? chosen() : []; return new Set(ids.length === 1 ? ids : []); },
    // How the field edges the player's vehicles (silhouette.ts): those picked while the player commands the squad; the
    // one in their hands has the dark edge of every vehicle. While Rebocar waits for its vehicle, those it could take now.
    marked() {
      const ids = commanding() ? chosen() : [], marks = new Map<string, 'selected' | 'towable'>(ids.map(id => [id, 'selected']));
      if (armed === 'tow' && ids.length === 1) for (const [id, ready] of towable(required(ids[0]))) if (ready) marks.set(id, 'towable');
      return marks;
    },
    // A construction the player is giving up: its going is not news to them.
    leaving(id: string) { watched.expected.add(id); },
    // The construction the player is to find picked, under command, once the field has it in the squad.
    pick(id: string) { coming = id; refresh(); },
    // Joining a fresh field has no user selection. Clear old local presentation
    // without reporting a selection action or sending an order to the room.
    clearSelection() { selection.clear(); coming = kept = armed = null; refresh(); },
    // An explicit tutorial action has the same selection semantics as a click on
    // the column. Deferred selection on join/publication continues to use pick().
    select(ids: readonly string[]) { if (commanding()) select(ids.filter(id => required(squad()).units.some(unit => unit.id === id && usable(unit)))); },
    // The vehicle picked alone goes into the player's hands: the button of the vehicle's block of the panel.
    take() { const ids = chosen(); if (commanding() && ids.length === 1) control(ids[0]); },
    // All the vehicles picked while commanding: who an order given from outside the field goes to.
    picked() { return commanding() ? chosen() : []; },
    // The player's choice on the field, settled against the frame on screen: who is picked, the order waiting
    // for its click and the construction in focus. The field goes on while the player is at its workshop, and so does the choice.
    choice() {
      const sq = squad(), there = sq || fielded();
      if (!sq || sq.manual) armed = null;
      if (!sq) { gesture = null; box.hidden = ruler.hidden = true; }
      if (coming && sq?.units.some(u => u.id === coming)) { selection.clear(); selection.add(coming); coming = null; }
      for (const id of [...selection]) if (!there?.units.some(u => u.id === id && usable(u))) selection.delete(id);
      kept = sq && focused() || kept;
      return { picked: this.picked(), armed, focus: focused() };
    },
    // Paints the column and the orders as `fieldPanel` told them for that choice.
    render(p: FieldPanelView) {
      const sq = squad();
      shown = p; rows = new Map((p.squad?.units || []).map(u => [u.id, u])); sites.render(p);
      // What came about since the last look is said once, with what the squad has just made contact with: a vehicle lost,
      // out of fuel, of rounds or of a way to move, a repair that is done, and what became of the faction. Bad news of a
      // vehicle stays longer on the screen. It is heard too (`alert`): bad news by one cue, an enemy in the squad's senses,
      // or a gun the base placed by its fire, by another: of that gun the notice is pressed to go and look where it is held.
      const said = fieldNotices(watched, p.watch, performance.now() / 1000);
      // What is wrong with the vehicles as the player comes into the field is read in a dialog, not a notice that goes by.
      if (watched.entry) showReport(watched.entry, id => { select([id]); watch(id); });
      if (said.length) toast(said.join(' '), watched.grave, watched.place, watched.items);
      if (watched.grave) alert('grave'); else if (watched.spotted) alert('contact');
      column.hidden = !p.squad;
      renderCommands(p);
      if ((!sq || sq.manual) && ownCursor) { canvas.style.cursor = ''; ownCursor = false; }
      // A compatible pending order can become unavailable while targeting.
      // Retain its kind so that click cannot silently become a contextual move.
      if (armed && !p.orders.some(order => order.id === armed && !order.release)) armed = null;
      if (!p.squad) { columnKey = ''; return; }
      const key = JSON.stringify(p.squad.units.map(u => [u.id, u.number, u.group]));
      if (key !== columnKey) { columnKey = key; column.innerHTML = build(p); }
      update(p);
    },
  };
}
