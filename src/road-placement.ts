import type { FieldView } from './faction-ui.ts';
import type { Terrain } from './terrain.ts';
import type { RoadKind, RoadSpan } from './roads.ts';
export interface RoadIntent { kind: RoadKind; x0: number; x1: number }
interface RoadDraft { kind: RoadKind; x0: number | null; x1: number | null }
export interface RoadPlan { spans: RoadSpan[]; over: RoadSpan[]; unknown: RoadSpan[] }
export interface RoadPlacementRenderer {
  readonly state: FieldView | null; readonly ground: Terrain; readonly camera?: { readonly zoom: number };
  previewRoad(road: (Omit<RoadIntent, 'kind'> & RoadPlan & { refused: boolean }) | null): void;
}
export interface RoadPlacementOptions { readonly host: HTMLElement; readonly renderer: RoadPlacementRenderer; readonly onConfirm?: (intent: RoadIntent) => unknown; readonly onCancel?: (draft: RoadDraft) => unknown }
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing road placement state'); return value; };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
import { tr } from './i18n.ts';
import { node, icon, actionButton } from './dom-view.ts';
import { number } from './format.ts';
import { farText } from './faction-ui.ts';
import { roadRefusal, roadKindText, roadKnown, roadWork, without, ROAD_SHORTEST } from './road-site.ts';
import { roadAt, length } from './roads.ts';
import { touching } from './touch.ts';
import { clip, contains } from './ground-sight.ts';

// An end chosen this many pixels or nearer from an end of a road, made or asked for, on ground the faction knows, is chosen
// at that end: a stretch from one road to another joins them with no sliver of ground left between.
const SNAP = 12;
const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
// A button of the dock made as those of the vehicle's dock are (field-workspace.css): its mark, its words and the key that
// does the same.
const dockButton = (glyph: string, words: string, action: () => unknown, key: string) => {
  const button = actionButton('', action), mark = node('span', 'field-button-icon'), label = node('span', 'field-button-label', words);
  mark.dataset.icon = glyph; mark.innerHTML = icon(glyph); button.append(mark, label, node('kbd', '', key));
  return { button, label };
};

// A road is asked for over a stretch of the shared field the player chooses there (road-site.ts), from the Infraestrutura page
// (infrastructure-ux.ts), as what it was chosen to be (`kind`), for the road machines of the faction in automatic to make: a
// click — a tap — at one end and another at the other end, the stretch following the pointer from the first until the second; a click after both moves the end nearer it. An
// end may be chosen over a road, made or asked for, and one chosen by the end of a road is at that end (`snap`): from one
// road to another, the road asked for is the ground between them. It says what refuses the stretch, if anything, by the
// same rules the field keeps, with what the faction knows; the field has the last word once the stretch is confirmed. The
// field draws the stretch (render.ts `previewRoad`) by what it makes there and what it passes over as it is, and the ground
// of it the faction never saw (`plan`); the view of the field stays the player's to move meanwhile. Its dock is that of a
// works (publication-placement.ts): what is asked for, the orders in a row, and a line of how long it is, how much of it is
// to be made and where it stands, or of what refuses it.
export class RoadPlacement {
  declare readonly renderer: RoadPlacementRenderer;
  declare readonly onConfirm: RoadPlacementOptions['onConfirm']; declare readonly onCancel: RoadPlacementOptions['onCancel'];
  declare current: RoadDraft | null; declare busy: boolean; declare rejection: string; declare refusal: string; declare pointed: number | null;
  declare readonly element: HTMLDivElement; declare readonly dock: HTMLElement; declare readonly mode: HTMLElement; declare readonly name: HTMLElement;
  declare readonly confirm: HTMLButtonElement; declare readonly confirmLabel: HTMLElement; declare readonly back: HTMLButtonElement; declare readonly status: HTMLElement;
  constructor({ host, renderer, onConfirm, onCancel }: RoadPlacementOptions) {
    this.renderer = renderer; this.onConfirm = onConfirm; this.onCancel = onCancel;
    this.current = null; this.busy = false; this.rejection = ''; this.refusal = ''; this.pointed = null;
    this.element = node('div', 'publication-placement road-placement'); this.element.hidden = true;
    this.dock = node('section', 'publication-dock'); this.dock.setAttribute('aria-label', tr('Escolher o trecho da estrada'));
    this.mode = node('span', 'field-mode'); this.name = node('strong');
    const heading = node('div', 'field-dock-heading'), named = node('span', 'field-dock-name');
    named.append(this.name); heading.append(this.mode, named);
    ({ button: this.confirm, label: this.confirmLabel } = dockButton('i-road', tr('Abrir estrada'), () => this.submit(), 'Enter'));
    this.confirm.id = 'road-confirm';
    this.back = dockButton('i-close', tr('Cancelar'), () => this.cancel(), 'Esc').button;
    this.back.id = 'road-cancel'; this.back.title = 'Cancelar · Esc';
    const orders = node('div', 'squad-orders'); orders.setAttribute('role', 'group'); orders.setAttribute('aria-label', tr('Estrada'));
    orders.append(this.confirm, this.back);
    this.status = node('p', 'field-dock-status'); this.status.id = 'road-status'; this.status.setAttribute('role', 'status');
    this.dock.append(heading, orders, this.status);
    this.element.append(this.dock); host.append(this.element);
  }

  get active() { return Boolean(this.current); }
  get pending() { return this.busy; }
  set pending(value: boolean) { this.busy = Boolean(value); this.render(); }
  // Both ends are chosen.
  get chosen() { return finite(this.current?.x1); }
  // The stretch as it is asked of the field: its ends in order.
  get intent(): RoadIntent | null {
    const current = this.current; if (!current || !finite(current.x0) || !finite(current.x1)) return null;
    const { kind, x0, x1 } = current;
    return { kind, x0: Math.min(x0, x1), x1: Math.max(x0, x1) };
  }

  begin({ kind }: { kind: RoadKind }): boolean {
    if (this.pending || this.active) return false;
    this.current = { kind, x0: null, x1: null }; this.rejection = ''; this.pointed = null;
    this.element.hidden = false; this.render(); return true;
  }

  // The stretch as far as it is chosen: both ends, or the first and the pointer, or the pointer alone.
  stretch(): RoadSpan | null {
    const { x0, x1 } = required(this.current), a = finite(x0) ? x0 : this.pointed, b = finite(x1) ? x1 : finite(x0) ? this.pointed : a;
    return finite(a) && finite(b) ? [Math.min(a, b), Math.max(a, b)] : null;
  }

  render() {
    if (!this.active) return;
    const { kind, x0 } = required(this.current), state = this.renderer.state, shared = Boolean(state?.shared), faction = state?.faction,
      stretch = shared ? this.stretch() : null, started = finite(x0);
    // A stretch with an end alone chosen is not refused while it is short: the other end is still to come.
    this.refusal = stretch && started ? this.refuse(stretch) : '';
    const refused = Boolean(this.refusal) && (this.chosen || required(stretch)[1] - required(stretch)[0] >= ROAD_SHORTEST), plan = stretch && this.plan(stretch);
    this.renderer.previewRoad(stretch ? { x0: stretch[0], x1: stretch[1], refused, ...required(plan) } : null);
    write(this.mode, tr('NOVA ESTRADA')); write(this.name, roadKindText(kind));
    // How long the stretch is, and how much of it is made where that is less: the rest is road already, or asked for. Of a
    // stretch over ground never seen, nothing is told of that.
    const press = touching() ? tr('Toque') : tr('Clique'), base = faction?.base, whole = stretch ? stretch[1] - stretch[0] : 0,
      made = plan && !plan.unknown.length ? length(plan.spans) : whole,
      long = started && whole >= .5 ? `${number(whole)} m` + (whole - made >= .5 ? ` · ${number(made)} m a fazer` : '') : '',
      problem = this.rejection || (!shared ? tr('Aguarde uma atualização do campo.') : refused ? this.refusal : ''),
      line = problem || (!started ? tr`${press} no início do trecho` : !this.chosen ? tr`${press} no fim do trecho` + (long ? ' · ' + long : '') :
        [long, finite(base?.x) ? tr`a ${farText((required(stretch)[0] + required(stretch)[1]) / 2, required(base).x)} da base` : ''].filter(Boolean).join(' · '));
    write(this.status, line); this.status.title = this.chosen ? tr`${line} · ${touching() ? tr('um toque') : tr('um clique')} move a ponta mais perto` : line;
    this.status.dataset.problem = String(Boolean(problem));
    this.element.dataset.pointChosen = String(this.chosen); this.element.dataset.refused = String(refused);
    this.confirm.disabled = this.pending || !shared || !this.chosen || Boolean(this.refusal);
    write(this.confirmLabel, this.pending ? 'Aguardando o campo…' : tr('Abrir estrada'));
    this.confirm.title = !this.chosen ? tr('Escolha primeiro as duas pontas do trecho.') : problem || tr('Abrir estrada · Enter');
    this.back.disabled = this.pending;
  }

  // Why the road may not be asked for over `[a, b]`, as the page can tell it (road-site.ts): the field says it again once
  // asked, of what the faction does not see.
  refuse([a, b]: RoadSpan): string {
    const state = required(this.renderer.state), faction = state.faction, ground = this.renderer.ground,
      end = (value: number | undefined, side: number): number => finite(value) ? (side < 0 ? Math.ceil(value + 20) : Math.floor(value - 20)) : side * Infinity;
    return roadRefusal({ x0: a, x1: b, kind: required(this.current).kind, limits: { minX: end(ground.minX, -1), maxX: end(ground.maxX, 1) },
      explored: faction?.explored ?? null, roads: ground.roads ?? [], taken: faction?.roadworks ?? [] });
  }
  // What a road over `[a, b]` makes, as the faction knows the ground: of what it knows of it (`roadKnown`), what the road
  // makes there (`spans`, road-site.ts `roadWork`) and what it passes over as it is, a road made or asked for (`over`); and
  // what of it the faction never saw (`unknown`), which nothing is read of. A stretch with its ends together is one place.
  plan([a, b]: RoadSpan): RoadPlan {
    const faction = required(this.renderer.state).faction, ground = this.renderer.ground, knows = faction?.explored ? roadKnown(faction.explored) : null,
      known: RoadSpan[] = !knows ? [[a, b]] : b > a ? clip(knows, a, b) : contains(knows, a) ? [[a, b]] : [],
      unknown: RoadSpan[] = b > a ? without([[a, b]], known) : known.length ? [] : [[a, b]],
      spans = without(roadWork({ x0: a, x1: b, kind: required(this.current).kind, roads: ground.roads ?? [], taken: faction?.roadworks ?? [] }), unknown);
    return { spans, over: without(known, spans), unknown };
  }
  // Where an end chosen at `worldX` stands: at the end of a road nearest it, made or asked for, within `SNAP` pixels and on
  // ground the faction knows — to the tenth of a metre the field asks for, on the side of it the road is on, so that the
  // stretch begins on the road and joins it —, or where it is.
  snap(worldX: number): number {
    const faction = this.renderer.state?.faction, ground = this.renderer.ground, roads = ground.roads ?? [], asked = faction?.roadworks ?? [],
      reach = SNAP / (this.renderer.camera?.zoom || Infinity), knows = faction?.explored ? roadKnown(faction.explored) : null;
    let end: number | null = null;
    for (const road of [...roads, ...asked]) for (const x of [road.x0, road.x1])
      if (Math.abs(x - worldX) <= Math.min(reach, Math.abs((end ?? Infinity) - worldX)) && (!knows || contains(knows, x))) end = x;
    if (end === null) return worldX;
    const on = (x: number): boolean => roadAt(roads, x) !== null || asked.some(road => x >= road.x0 && x <= road.x1);
    return on(end - .05) ? Math.floor(end * 10 + 1e-6) / 10 : Math.ceil(end * 10 - 1e-6) / 10;
  }

  // Where the pointer is over the field, in metres along it: the end still to be chosen follows it, by the end of a road at it.
  point(worldX: number): boolean {
    if (!this.active || this.chosen || this.pending || !finite(worldX)) return false;
    const x = this.snap(worldX);
    if (Math.abs(x - (this.pointed ?? Infinity)) < .1) return false;
    this.pointed = x; this.render(); return true;
  }
  // An end chosen, in real coordinates of the field, to the tenth of a metre, by the end of a road at it: the first, the
  // second, and then the one nearer.
  setX(worldX: number): boolean {
    if (!this.active || this.pending || !this.renderer.state?.shared || !finite(worldX)) return false;
    const x = Math.round(this.snap(worldX) * 10) / 10, current = required(this.current);
    if (!finite(current.x0)) current.x0 = x;
    else if (!this.chosen) current.x1 = x;
    else current[Math.abs(x - required(current.x0)) <= Math.abs(x - required(current.x1)) ? 'x0' : 'x1'] = x;
    this.pointed = x; this.rejection = ''; this.render(); return true;
  }
  // The stretch asked of the field, by the button or by Enter: once, until the field answers.
  submit() {
    this.render(); if (!this.active || this.confirm.disabled) return false;
    this.pending = true;
    try { this.onConfirm?.(required(this.intent)); } catch (error) { this.pending = false; throw error; }
    return true;
  }
  // The view is the field's: nothing of the dock stands over a place of it.
  follow() {}

  cancel() {
    if (!this.active || this.pending) return false;
    const current = { ...required(this.current) }; this.finish(); this.onCancel?.(current);
    return true;
  }
  reject(reason: unknown): boolean {
    if (!this.active) return false;
    this.rejection = String((reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined) || reason || tr('O campo recusou o trecho.'));
    this.pending = false; return true;
  }
  finish() {
    this.renderer.previewRoad(null);
    this.current = null; this.busy = false; this.rejection = this.refusal = ''; this.pointed = null;
    this.element.hidden = true;
  }
}
