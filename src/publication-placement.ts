import { tr } from './i18n.ts';
import { constructionBounds } from './construction-preview.ts';
import { BOARD, fieldX } from './workshop-site.ts';
import { node, icon, actionButton } from './dom-view.ts';
import { STOCK_IDS, STOCKS, bill, billTotal } from './economy.ts';
import { count, metres, way } from './format.ts';
import { coldConstructionPlacement, constructionSpan } from './construction-placement.ts';
import { constructionSupportSite } from './construction-admission.ts';
import { compileManufacture } from './structured-construction.ts';
import { workshopAdmissionMessage } from './workshop-checklist.ts';
import { siteRefusal } from './construction-site.ts';
import { postSpan, territoryOf } from './territory.ts';
import { footingBill } from './fixed-footing.ts';
import { plateCorners } from './math.ts';
import { componentFootprintPolygons } from './assembly.ts';
import { touching } from './touch.ts';
import { within } from './ground-sight.ts';
import type { AuthoredConstruction, CompiledConstruction, NativeAdmissionIssue } from './construction-contract.ts';
import type { FactionView, FieldView, obraQuote } from './faction-ui.ts';
import type { WorkView } from './field-service-contract.ts';
import type { SupplyBill, StockId } from './economy-contract.ts';
import type { ConstructionSpan } from './construction-site.ts';
import type { Terrain } from './terrain.ts';
import type { Camera } from './camera.ts';
import type { BoardSite } from './workshop-site.ts';

export interface PublicationIntent { blueprint: CompiledConstruction; source: AuthoredConstruction; facing: number; x: number | null; move: string | null; field: boolean }
export interface PublicationPlacementRenderer {
  readonly state: FieldView | null; readonly ground: Terrain; readonly camera: Pick<Camera, 'toScreen'>;
  previewConstruction(blueprint: CompiledConstruction | null, site?: BoardSite | null, issues?: readonly NativeAdmissionIssue[]): unknown;
}
export interface PublicationPlacementOptions {
  host: HTMLElement; renderer: PublicationPlacementRenderer; compile(source: AuthoredConstruction): CompiledConstruction;
  getQuote(intent: PublicationIntent, footing: SupplyBill): ReturnType<typeof obraQuote> | null | undefined;
  onPosition?(position: { x: number | null; facing: number }): unknown; onConfirm?(intent: PublicationIntent): unknown;
  onCancel?(intent: PublicationIntent): unknown; onAdjust?(intent: PublicationIntent): unknown;
}
export interface PublicationBegin { blueprint: CompiledConstruction; source: AuthoredConstruction; facing?: number; x?: number | null | undefined; move?: string | null; field?: boolean }

const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
// What a structure or a post of the faction keeps clear of on the field, as the page is told of it: the stretch each
// structure of the faction stands over, but `ignore`, the ground each of its posts serves (territory.ts `postSpan`), and
// the stretch each of its works takes up (`span`, of a works). Vehicles keep no ground: they pass through constructions
// and move off.
export function takenGround(state: Pick<FieldView, 'actors' | 'plates' | 'modules'>, faction: Pick<FactionView, 'id' | 'posts' | 'works'> | null | undefined, ignore: string | null | undefined, span: (work: WorkView) => ConstructionSpan): ConstructionSpan[] {
  const own = new Set<string | undefined>((state.actors || []).filter(actor => faction && actor.team === faction.id && !actor.vehicle && actor.id !== ignore).map(actor => actor.id)),
    stretches = new Map<string | undefined, ConstructionSpan>(), reach = (id: string | undefined, x: number): void => {
      const stretch = stretches.get(id);
      if (!stretch) stretches.set(id, { minX: x, maxX: x }); else { stretch.minX = Math.min(stretch.minX, x); stretch.maxX = Math.max(stretch.maxX, x); }
    };
  for (const plate of state.plates || []) if (own.has(plate.actorId)) for (const corner of plateCorners(plate.definition)) reach(plate.actorId, corner.x);
  for (const module of state.modules || []) if (own.has(module.actorId)) for (const polygon of componentFootprintPolygons(module)) for (const corner of polygon) reach(module.actorId, corner.x);
  return [...stretches.values(), ...(faction?.posts ?? []).map(post => postSpan(post.x)), ...(faction?.works ?? []).map(span)];
}
// A button of the dock made as those of the vehicle's dock are (field-workspace.css): its mark, its words, if any, and the
// key that does the same, if one does.
const dockButton = (glyph: string, words: string, action: () => unknown, key = '') => {
  const button = actionButton('', action), mark = node('span', 'field-button-icon'), label = words ? node('span', 'field-button-label', words) : null;
  mark.dataset.icon = glyph; mark.innerHTML = icon(glyph); button.append(mark, ...label ? [label] : [], ...key ? [node('kbd', '', key)] : []);
  return { button, label, mark };
};

// A structure is not made at a base: it is a works opened at a place of the shared field the player chooses there
// (construction-site.ts). Its outline follows the pointer over the field (`point`) and stands where the player points — a
// click, a tap — (`setX`), saying what refuses that place, if anything, by the same rules the field keeps, with what the
// faction knows; the field has the last word once the place is confirmed. The view of the field stays the player's to move
// meanwhile. A structure moved (`move`, its id) has its new place chosen the same way, with itself out of the way. The
// quote is the game's own (`getQuote`), given what the footing of the place costs, and `compile` makes the works of the
// faction out of their projects, to keep clear of them. The preview owns no orders and no materials. Its dock is the vehicle's: what is placed and what it costs, the
// metre either way and the turn beside it, the orders in a row, and a line of where it stands or of what refuses it. A post
// is no structure: it is placed as a post (post-placement.ts).
export class PublicationPlacement {
  declare renderer: PublicationPlacementRenderer; declare compile: PublicationPlacementOptions['compile']; declare getQuote: PublicationPlacementOptions['getQuote'];
  declare onPosition: PublicationPlacementOptions['onPosition']; declare onConfirm: PublicationPlacementOptions['onConfirm'];
  declare onCancel: PublicationPlacementOptions['onCancel']; declare onAdjust: PublicationPlacementOptions['onAdjust'];
  declare current: PublicationIntent | null; declare busy: boolean; declare site: BoardSite | null; declare rejection: string; declare refusal: string; declare pointed: number | null;
  declare works: Map<string, ConstructionSpan>; declare box: ReturnType<typeof constructionBounds>;
  declare element: HTMLDivElement; declare ghost: HTMLDivElement; declare dock: HTMLElement; declare mode: HTMLSpanElement; declare name: HTMLElement;
  declare costs: HTMLSpanElement; declare chips: { id: StockId; chip: HTMLSpanElement; figure: HTMLElement }[];
  declare left: HTMLButtonElement; declare right: HTMLButtonElement; declare turnButton: HTMLButtonElement;
  declare confirm: HTMLButtonElement; declare confirmLabel: HTMLSpanElement | null; declare confirmMark: HTMLSpanElement;
  declare adjust: HTMLButtonElement; declare back: HTMLButtonElement; declare status: HTMLParagraphElement;
  constructor({ host, renderer, compile, getQuote, onPosition, onConfirm, onCancel, onAdjust }: PublicationPlacementOptions) {
    this.renderer = renderer; this.compile = compile; this.getQuote = getQuote; this.onPosition = onPosition;
    this.onConfirm = onConfirm; this.onCancel = onCancel; this.onAdjust = onAdjust;
    this.current = null; this.busy = false; this.site = null; this.rejection = ''; this.refusal = ''; this.pointed = null;
    // The stretch of each works of the faction, by its name: a works never changes its project nor its place.
    this.works = new Map();
    this.element = node('div', 'publication-placement'); this.element.hidden = true;
    this.ghost = node('div', 'publication-ghost'); this.ghost.setAttribute('aria-hidden', 'true');
    this.dock = node('section', 'publication-dock'); this.dock.setAttribute('aria-label', tr('Escolher o local da obra'));
    this.mode = node('span', 'field-mode'); this.name = node('strong');
    // What the works asks of each stock, by its mark, as the stocks of the faction are told.
    this.costs = node('span', 'publication-costs');
    this.chips = STOCK_IDS.map(id => {
      const chip = node('span', 'cost-chip'), figure = node('b');
      chip.innerHTML = icon('r-' + id, 'stock-icon') + `<span class="sr-only">${tr(STOCKS[id])}</span>`; chip.append(figure); this.costs.append(chip);
      return { id, chip, figure };
    });
    const heading = node('div', 'field-dock-heading'), named = node('span', 'field-dock-name');
    named.append(this.name, this.costs); heading.append(this.mode, named);
    this.left = dockButton('i-arrow-left', '', () => this.nudge(-1)).button;
    this.right = dockButton('i-arrow-right', '', () => this.nudge(1)).button;
    this.turnButton = dockButton('i-turn', tr('Virar'), () => this.turn()).button;
    for (const [button, words] of [[this.left, tr('Mover a obra 1 m à esquerda')], [this.right, tr('Mover a obra 1 m à direita')], [this.turnButton, tr('Virar a estrutura para o outro lado')]] satisfies [HTMLButtonElement, string][]) {
      button.setAttribute('aria-label', words); button.title = words;
    }
    const tools = node('div', 'field-dock-actions'); tools.append(this.left, this.right, this.turnButton);
    ({ button: this.confirm, label: this.confirmLabel, mark: this.confirmMark } = dockButton('i-build', tr('Abrir obra'), () => this.submit(), 'Enter'));
    this.confirm.id = 'publication-confirm';
    this.adjust = dockButton('i-edit', tr('Ajustar projeto'), () => this.cancel({ adjust: true })).button;
    this.back = dockButton('i-close', tr('Cancelar'), () => this.cancel(), 'Esc').button;
    this.back.id = 'publication-cancel'; this.back.title = 'Cancelar · Esc';
    const orders = node('div', 'squad-orders'); orders.setAttribute('role', 'group'); orders.setAttribute('aria-label', tr('Obra'));
    orders.append(this.confirm, this.adjust, this.back);
    this.status = node('p', 'field-dock-status'); this.status.id = 'publication-status'; this.status.setAttribute('role', 'status');
    this.dock.append(heading, tools, orders, this.status);
    this.element.append(this.ghost, this.dock); host.append(this.element);
  }

  get active() { return Boolean(this.current); }
  get chosen() { return Number.isFinite(this.current?.x); }
  get intent() { return this.current ? structuredClone(this.current) : null; }
  get pending() { return this.busy; }
  set pending(value: boolean) { this.busy = Boolean(value); this.render(); }

  // `blueprint` is the compiled project and `source` its authoring; `x` is where its outline stands until the player points
  // (the middle of the view the field opens on); `field` says it was asked for on the field rather than in the workshop.
  begin({ blueprint, source, facing = 1, x = null, move = null, field = false }: PublicationBegin) {
    if (this.pending) return false;
    this.current = { blueprint, source: structuredClone(source), facing: facing === -1 ? -1 : 1, x: null, move, field: Boolean(field) };
    this.rejection = ''; this.pointed = Number.isFinite(x) ? x : null;
    this.box = constructionBounds(blueprint);
    // The cached bounds keep the validity border in place; the Renderer draws the actual outside, guns included.
    this.ghost.innerHTML = ''; this.element.hidden = false;
    this.render(); this.follow(); return true;
  }

  render() {
    if (!this.active) return;
    const intent = this.current!, state = this.renderer.state, shared = Boolean(state?.shared),
      faction = state?.faction, x = this.chosen ? intent.x : this.pointed,
      placed = shared && Number.isFinite(x), base = faction?.base, span = placed ? constructionSpan(intent.blueprint, { x: x!, facing: intent.facing }) : null;
    // Ground the faction never saw is not read: the outline would tell its relief.
    this.refusal = placed ? this.refuse(span!) : '';
    const known = placed && faction && (!faction.explored || within(faction.explored, span!.minX, span!.maxX)),
      cold = known ? coldConstructionPlacement(intent.blueprint, this.renderer.ground, { x: x!, facing: intent.facing }) : null,
      review = known && !this.refusal ? compileManufacture(intent.source,
        constructionSupportSite(this.renderer.ground, cold!, span!), true).compiled : null;
    this.site = cold ? { x: x! - BOARD.middle, y: cold.lift, mirror: intent.facing > 0 } : null;
    this.renderer.previewConstruction(intent.blueprint, this.site, review?.admissionIssues ?? []);
    this.refusal ||= review ? workshopAdmissionMessage(review) : '';
    // The works is quoted with the footing its place asks for (fixed-footing.ts), where it may stand.
    const footing = this.site && !this.refusal ? footingBill(intent.blueprint, this.renderer.ground, { x: x!, facing: intent.facing }) : bill(),
      quote = this.getQuote(intent, footing);
    this.element.dataset.pointChosen = String(this.chosen); this.element.dataset.refused = String(Boolean(this.refusal));
    const named = intent.source?.name || tr('Estrutura'), confirming = intent.move ? tr('Mudar para cá') : tr('Abrir obra');
    write(this.mode, intent.move ? tr('MUDAR DE LUGAR') : tr('NOVA OBRA')); write(this.name, named); this.name.title = named;
    // What the stocks lack is marked, and refuses nothing: the material is taken to the works as it comes. Of a structure
    // moved, only its footing is told: its pieces go to its new works.
    for (const { id, chip, figure } of this.chips) {
      const cost = quote?.costs?.find(cost => cost.id === id), look = cost?.short ? 'cost-chip short' : 'cost-chip',
        title = cost?.short ? tr`${tr(STOCKS[id])}: faltam ${String(cost.missing)} no estoque` : tr(STOCKS[id]);
      chip.hidden = !cost; write(figure, cost?.text ?? '');
      if (chip.className !== look) chip.className = look;
      if (chip.title !== title) chip.title = title;
    }
    this.costs.hidden = this.chips.every(({ chip }) => chip.hidden);
    this.left.disabled = this.right.disabled = this.pending || !shared || !this.chosen;
    this.turnButton.disabled = this.pending || !shared;
    // One line: what refuses the place or the works, or where it stands from the base — before a place is chosen, how to
    // choose one —, whether it asks for a footing, and how long it takes to put up.
    const problem = this.rejection || (!shared ? tr('Aguarde uma atualização do campo.') : this.refusal ||
      (quote?.spawn?.disabled ? quote.spawn.title || quote.text : '')),
      where = !this.chosen ? tr`${touching() ? tr('Toque') : tr('Clique')} no chão para escolher o local` :
        Number.isFinite(base?.x) ? tr`a ${metres(Math.abs(x! - base!.x))} ${way(x!, base!.x)} da base` : '',
      line = problem || [where, billTotal(footing) > 0 ? tr('fundação') : '',
        !intent.move && Number.isFinite(quote?.seconds) ? `montagem ${count(quote!.seconds)} s` : ''].filter(Boolean).join(' · ');
    write(this.status, line); this.status.title = line; this.status.dataset.problem = String(Boolean(problem));
    this.confirm.disabled = this.pending || !shared || !this.chosen || Boolean(this.refusal) || !quote?.spawn || quote.spawn.disabled;
    write(this.confirmLabel!, this.pending ? 'Aguardando o campo…' : confirming);
    // A structure moved goes where it is sent, as a vehicle told to move does.
    const glyph = intent.move ? 'i-flag' : 'i-build';
    if (this.confirmMark.dataset.icon !== glyph) { this.confirmMark.dataset.icon = glyph; this.confirmMark.innerHTML = icon(glyph); }
    this.confirm.title = !this.chosen ? tr('Escolha primeiro o ponto no campo.') : problem || confirming + ' · Enter';
    this.adjust.hidden = Boolean(intent.move);
    this.adjust.disabled = this.back.disabled = this.pending;
  }

  // Why the structure may not stand over `span`, as the page can tell it (construction-site.ts), within the territory of the
  // faction — its base and its posts but one being taken down — and in no other it is told of (territory.ts), clear of
  // what of its own keeps ground (`takenGround`), but the structure moved.
  refuse(span: ConstructionSpan) {
    const { move } = this.current!, state = this.renderer.state!, faction = state.faction, ground = this.renderer.ground,
      end = (value: number | undefined, side: number) => Number.isFinite(value) ? (side < 0 ? Math.ceil(value! + 20) : Math.floor(value! - 20)) : side * Infinity,
      base = faction?.base?.x ?? null, standing = (faction?.posts ?? []).filter(post => !post.takedown).map(post => post.x);
    return siteRefusal({ span, limits: { minX: end(ground.minX, -1), maxX: end(ground.maxX, 1) },
      explored: faction?.explored ?? null, own: faction ? territoryOf(base, standing) : null,
      foreign: (faction?.territory ?? []).filter(held => held.kind !== 'own').map(held => held.spans), home: base,
      ground, taken: takenGround(state, faction, move, work => this.span(work)) });
  }
  // The stretch a works of the faction takes up — of a post, the ground it serves —, kept by its name.
  span(work: WorkView): ConstructionSpan {
    if (!this.works.has(work.id)) this.works.set(work.id, work.post ? postSpan(work.x) : constructionSpan(this.compile(work.blueprint), work));
    return this.works.get(work.id)!;
  }

  // Where the pointer is over the field, in metres along it: the outline follows it until a place is chosen.
  point(worldX: number) {
    if (!this.active || this.chosen || this.pending || !Number.isFinite(worldX) || Math.abs(worldX - (this.pointed ?? Infinity)) < .1) return false;
    this.pointed = worldX; this.render(); this.follow(); return true;
  }
  // The place chosen, in real coordinates of the field, to the tenth of a metre.
  setX(worldX: number) {
    if (!this.active || this.pending || !this.renderer.state?.shared || !Number.isFinite(worldX)) return false;
    const x = Math.round(worldX * 10) / 10;
    if (x === this.current!.x && this.chosen) return false;
    this.current!.x = x; this.rejection = '';
    this.onPosition?.({ x, facing: this.current!.facing }); this.render(); this.follow(); return true;
  }
  nudge(by: number) { return this.chosen && this.setX(this.current!.x! + by); }
  // The place asked of the field, by the button or by Enter: once, until the field answers.
  submit() {
    this.render(); if (!this.active || this.confirm.disabled) return false;
    this.pending = true;
    try { this.onConfirm?.(this.intent!); } catch (error) { this.pending = false; throw error; }
    return true;
  }
  turn() {
    if (!this.active || this.pending) return false;
    this.current!.facing = -this.current!.facing; this.rejection = '';
    this.onPosition?.({ x: this.current!.x, facing: this.current!.facing }); this.render(); this.follow(); return true;
  }

  // Camera motion changes only the cached border's pixel bounds. No layout read,
  // geometry scan, compiler or quote is needed on the rendering frame.
  follow() {
    this.ghost.hidden = !this.active || !this.renderer.state?.shared || !this.site;
    if (this.ghost.hidden) return;
    const { x, y, width, height } = this.box, camera = this.renderer.camera,
      a = camera.toScreen(fieldX(this.site!, x), this.site!.y - y),
      b = camera.toScreen(fieldX(this.site!, x + width), this.site!.y - y - height);
    this.ghost.style.transform = `translate(${Math.min(a.x, b.x)}px, ${a.y}px)`;
    this.ghost.style.width = `${Math.abs(b.x - a.x)}px`; this.ghost.style.height = `${Math.abs(b.y - a.y)}px`;
    this.ghost.dataset.mirror = String(this.site!.mirror);
  }

  cancel({ adjust = false } = {}) {
    if (!this.active || this.pending) return false;
    const intent = this.intent!; this.finish();
    if (adjust) this.onAdjust?.(intent); else this.onCancel?.(intent);
    return true;
  }

  reject(reason: unknown) {
    if (!this.active) return false;
    this.rejection = String((reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined) || reason || tr('O campo recusou o local.'));
    this.pending = false; return true;
  }

  finish() {
    this.renderer.previewConstruction(null);
    this.current = this.site = null; this.busy = false; this.rejection = this.refusal = ''; this.pointed = null;
    this.element.hidden = true; this.ghost.innerHTML = ''; this.ghost.hidden = true; this.works.clear();
  }
}
