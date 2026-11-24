import type { DomView } from './dom-view.ts';
import type { UiModel, UiView } from './ui-model.ts';
import type { PartCategory } from './workshop-context.ts';
import type { CompiledConstruction } from './construction-contract.ts';
import type { StockId } from './economy-contract.ts';
export type WorkshopSurface = 'build' | 'project' | 'publish' | 'test';
export type WorkshopTask = WorkshopSurface | 'closed' | 'adjust';
export interface WorkshopScreen {
  ui: DomView; surface: WorkshopSurface | null; selection: string; inspecting: boolean; editing: boolean;
  sidebar: HTMLElement; inspector: HTMLElement; adjust: HTMLElement; capacity: HTMLElement; publishActions: HTMLElement;
  panels: HTMLElement[]; inspectorTitle: HTMLElement; placement: HTMLElement; partButtons: HTMLElement[]; categories: HTMLElement;
  surfaceButtons: Map<WorkshopSurface, HTMLElement>; stockAvailable: [StockId, HTMLElement][];
  category?: PartCategory | undefined; aircraft?: boolean | undefined; visibilityChanged?: (surface: WorkshopSurface | null, inspecting: boolean) => void;
  installing?: string; view?: UiView; onTask?: (task: WorkshopTask) => void; quoteAvailable?: boolean; visibilityKey?: string; reviewed?: CompiledConstruction;
}
import { tr } from './i18n.ts';
import { node } from './dom-view.ts';
import { weaponPreviewCanvas } from './weapon-paint.ts';
import { workshopChecklist } from './workshop-checklist.ts';
import { PART_CATEGORIES, SUMMARY_FIGURES, categoryOf, workshopContext } from './workshop-context.ts';
import { chassisCapacity, capacityElement } from './workshop-capacity.ts';
import { projectParts } from './workshop-selection.ts';
import { count } from './format.ts';
import { pointOf } from './frame-points.ts';

const POINT_TITLES = { node: tr('Ponta de chapa'), vertex: tr('Ponto do chassi'), stretch: tr('Trecho do chassi') };

// Only variable-length presentation needs DOM construction. All scalar values,
// visibility and enabled states arrive from ScreenModel in the same update.
export class WorkshopScreen {
  constructor(ui: DomView) {
    this.ui = ui; this.surface = null; this.selection = '';
    this.inspecting = false; this.editing = true;
    this.sidebar = ui.get('.sidebar')!; this.inspector = ui.get('#project-inspector')!;
    this.adjust = ui.get('#workshop-adjust')!;
    const content = ui.get('#workspace-surface-content')!;
    this.surfaceButtons = new Map();
    for (const [id, surface] of [
      ['project-add', 'build'], ['project-test', 'test'], ['project-publish', 'publish'],
    ] as const) {
      const button = ui.get('#' + id)!; button.onclick = () => this.openTask(surface); this.surfaceButtons.set(surface, button);
    }
    this.capacity = ui.get('#workshop-capacity')!; this.publishActions = ui.get('#project-publish-actions')!;
    this.panels = [...content.querySelectorAll<HTMLElement>('[data-workshop-panel]')];
    this.inspectorTitle = ui.get('#project-inspector-title')!; this.placement = ui.get('#project-placement')!;
    ui.get('#project-inspector-close')!.onclick = () => this.closeInspector();
    const palette = ui.get('.component-palette')!;
    this.partButtons = [...palette.querySelectorAll<HTMLElement>('[data-component]'), ui.get('#catalog-edit')!];
    this.categories = ui.get('#part-categories')!;
    for (const category of PART_CATEGORIES) {
      const button = node('button', '', category.label); button.type = 'button'; button.dataset.category = category.id;
      button.onclick = () => this.showCategory(category.id); this.categories.append(button);
    }
    this.showCategory('base');
    this.stockAvailable = (['ferro', 'ligas', 'silica', 'combustivel'] as const).map(id => [id, ui.get('#cost-' + id)!.querySelector<HTMLElement>('.cost-available')!]);
    this.syncVisibility();
  }
  // The tiles of a category; the thruster's on an aircraft alone, which it lifts (game_construction.rs `THRUSTER_CHASSIS`).
  showCategory(id = this.category, aircraft = this.aircraft) {
    Object.assign(this, { category: id, aircraft });
    for (const button of this.categories.querySelectorAll<HTMLElement>('button')) button.setAttribute('aria-pressed', String(button.dataset.category === id));
    for (const button of this.partButtons)
      button.hidden = categoryOf(button.dataset.component || 'weapon') !== id || button.dataset.component === 'thruster' && !aircraft;
  }
  onVisibility(callback: (surface: WorkshopSurface | null, inspecting: boolean) => void) {
    this.visibilityChanged = callback; callback(this.surface, !this.inspector.hidden);
  }
  get inspectorVisible() { return this.editing && !this.surface && this.inspecting; }
  close() {
    this.surface = null; this.syncVisibility();
  }
  closeInspector() {
    if (this.installing) this.ui.get('#workshop-placement-cancel')!.click();
    else if (this.view) {
      this.view.editor.select([]);
      this.onTask?.('adjust');
    }
    this.inspecting = false; this.syncVisibility();
  }
  openTask(task: string, { focus = false, notify = true } = {}) {
    if (task === 'closed') { this.close(); return; }
    if (task !== 'adjust' && task !== 'build' && task !== 'project' && task !== 'publish' && task !== 'test') return;
    const next = task === 'adjust' ? null : task;
    this.surface = next;
    if (task === 'adjust') this.inspecting = true;
    if (notify) this.onTask?.(task); this.syncVisibility();
    if (focus) (task === 'adjust' ? this.inspectorTitle : this.surfaceButtons.get(task))?.focus({ preventScroll: true });
  }
  syncVisibility() {
    const inspecting = this.inspectorVisible;
    const task = this.surface || 'closed';
    if (this.sidebar.dataset.workshopTask !== task) this.sidebar.dataset.workshopTask = task;
    for (const panel of this.panels) {
      const showing = this.editing && panel.dataset.workshopPanel === this.surface &&
        (panel.id !== 'publish-panel' || this.quoteAvailable) && (panel.id !== 'workshop-publish-empty' || !this.quoteAvailable);
      if (panel.hidden !== !showing) panel.hidden = !showing;
    }
    if (this.inspector.hidden !== !inspecting) this.inspector.hidden = !inspecting;
    const publishing = this.editing && this.surface === 'publish' && this.quoteAvailable;
    if (this.publishActions.hidden !== !publishing) this.publishActions.hidden = !publishing;
    const placing = Boolean(this.installing);
    if (this.placement.hidden !== !placing) this.placement.hidden = !placing;
    if (this.adjust.hidden !== placing) this.adjust.hidden = placing;
    for (const [surface, button] of this.surfaceButtons) {
      const expanded = String(this.editing && this.surface === surface);
      if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    }
    const key = [this.editing, this.surface, inspecting].join('|');
    if (key !== this.visibilityKey) {
      this.visibilityKey = key; this.visibilityChanged?.(this.surface, inspecting);
    }
  }
  render(c: UiModel, view: UiView) {
    const ui = this.ui, sidebar = ui.get('.sidebar')!;
    this.view = view; this.editing = Boolean(c.edit); this.quoteAvailable = Boolean(c.panel.publish);
    if (sidebar.dataset.mode !== view.mode) { sidebar.dataset.mode = view.mode; sidebar.scrollTop = 0; }
    ui.apply(c.bindings);
    const installation = c.edit && view.buildTool !== 'select' ? [view.buildTool, view.placement.kind, view.placement.weaponPreset].join('|') : '';
    if (installation && installation !== this.installing) {
      if (view.buildTool === 'module') this.showCategory(categoryOf(view.placement.kind));
      this.inspecting = true; this.close();
    }
    // Points of the frame are chosen as pieces are: their settings open with them.
    const chosen = c.edit ? [...c.selection.map(piece => piece.id), ...c.points] : [];
    if (!installation && this.installing && !chosen.length) this.inspecting = false;
    this.installing = installation;
    const selected = chosen.join('|');
    if (selected && selected !== this.selection && view.buildTool === 'select') {
      this.openTask('adjust', { notify: false }); ui.get('#workshop-adjust')!.scrollTop = 0;
    }
    if (!selected && this.selection && view.buildTool === 'select') this.inspecting = false;
    if (!c.edit) { this.surface = null; this.inspecting = false; }
    this.selection = selected;
    // One piece is titled as the list of pieces names it; one point, by what it is.
    const title = installation ? c.placementTitle : c.points.length ?
      chosen.length === 1 ? POINT_TITLES[pointOf(c.points[0])!.kind] : `${chosen.length} ${c.selection.length ? 'itens' : 'pontos'} selecionados` :
      c.selection.length === 1 ?
      projectParts(c.blueprint).find(part => part.id === c.selection[0]!.id)?.name || c.selection[0]!.name || tr('Peça selecionada') :
      c.selection.length ? tr`${c.selection.length} peças selecionadas` : tr('Selecionar peças');
    if (this.inspectorTitle.textContent !== title) this.inspectorTitle.textContent = title;
    this.syncVisibility();
    if (c.edit && this.reviewed !== c.blueprint) {
      this.reviewed = c.blueprint;
      const review = workshopChecklist(c.blueprint, c.manufactureIssues).sort((a, b) => Number(b.state === 'attention') - Number(a.state === 'attention')),
        context = workshopContext(review, c.figures), assist = ui.get('#workshop-assist')!;
      assist.hidden = !context.suggestion;
      assist.replaceChildren();
      if (context.suggestion) {
        const item = context.suggestion, button = node('button'), words = node('span'), mark = node('span', 'workshop-check-mark', '!');
        button.type = 'button'; button.dataset.workshopReview = item.id; button.dataset.target = item.target; button.toggleAttribute('data-marked', Boolean(item.marked));
        mark.setAttribute('aria-hidden', 'true'); button.append(mark, words);
        words.append(node('b', '', context.action), node('small', '', item.detail));
        assist.append(button);
        if (context.remaining) {
          const more = node('button', 'assist-review', tr`Revisar mais ${context.remaining} ${context.remaining === 1 ? tr('pendência') : tr('pendências')}`);
          more.type = 'button'; more.onclick = () => this.openTask('project'); assist.append(more);
        }
      }
      const capacity = chassisCapacity(c.blueprint);
      this.capacity.hidden = !capacity;
      this.capacity.replaceChildren(...(capacity ? [capacityElement(capacity)] : []));
      // Weight, power and range are read in the figures over the project, and the weight against the chassis in its card here.
      ui.get('#workshop-figures')!.replaceChildren(...c.figures.filter(figure => !SUMMARY_FIGURES.includes(figure.label)).map(figure => {
        const row = node('div'); row.dataset.figure = figure.label;
        row.append(node('dt', '', figure.label), node('dd', '', figure.value));
        if (figure.title) row.title = figure.title;
        return row;
      }));
      ui.get('#workshop-checklist')!.replaceChildren(...review.map(item => {
        const compact = item.state === 'ready' && ['command', 'engine', 'running-gear'].includes(item.id),
          button = node('button', 'workshop-check' + (compact ? ' is-compact' : '')), words = node('span'), mark = node('span', 'workshop-check-mark',
          item.state === 'ready' ? '✓' : item.state === 'attention' ? '!' : '·');
        button.type = 'button'; button.dataset.workshopReview = item.id; button.dataset.target = item.target; button.dataset.state = item.state;
        button.toggleAttribute('data-marked', Boolean(item.marked));
        mark.setAttribute('aria-hidden', 'true'); words.append(node('b', '', item.label), node('small', compact ? 'sr-only' : '', item.detail));
        button.append(mark, words); button.title = item.detail + ' ' + (item.target === 'build' ? tr('Adicionar') : tr('Ajustar')) + ' · ' + item.label;
        return button;
      }));
    }
    if (c.edit) for (const [id, element] of this.stockAvailable) {
      const stock = c.panel.publish && 'availableStock' in c.panel.publish ? c.panel.publish.availableStock : undefined,
        value = tr('Disponível: ') + (stock ? count(stock[id]) + (id === 'combustivel' ? ' L' : '') : c.bindings['stock-' + id]?.text);
      if (element.textContent !== value) element.textContent = value;
    }
    const installing = view.buildTool === 'module' ? view.placement.kind : '', aircraft = view.editor?.source?.chassis?.model === 'aircraft';
    if (aircraft !== Boolean(this.aircraft)) this.showCategory(this.category, aircraft);
    for (const button of document.querySelectorAll<HTMLElement>('[data-component]')) ui.set(`[data-component="${button.dataset.component}"]`,
      { classes: { active: button.dataset.component === installing }, attr: { 'aria-pressed': button.dataset.component === installing } });
    // The bench weapon shows the rounds it takes, and no others.
    for (const ammo of c.ammoButtons) ui.set(`[data-ammo="${ammo.id}"]`,
      { hidden: ammo.disabled, classes: { active: ammo.active }, attr: { 'aria-pressed': ammo.active } });
    const switches = ui.get('#linked-weapons')!, switchKey = JSON.stringify(c.weaponButtons.map(b => [b.id, b.label]));
    if (switches.dataset.key !== switchKey) {
      switches.dataset.key = switchKey;
      switches.replaceChildren(...c.weaponButtons.map(b => {
        const button = node('button'); button.type = 'button'; button.dataset.weapon = b.id;
        button.append(node('span', '', b.label), node('small')); return button;
      }));
    }
    for (const [i, b] of c.weaponButtons.entries()) {
      const button = switches.querySelectorAll<HTMLButtonElement>('button')[i]!, on = b.lead || b.linked;
      button.classList.toggle('lead', b.lead); button.classList.toggle('active', b.linked); button.disabled = b.out && !b.linked;
      if (button.getAttribute('aria-pressed') !== String(on)) button.setAttribute('aria-pressed', String(on));
      if (button.lastChild!.textContent !== b.status) button.lastChild!.textContent = b.status;
    }
    for (const [id, preset] of [['current-weapon-preview', c.weapon.preset], ['new-weapon-preview', view.placement.weaponPreset ?? 'rh120']] as const) {
      const preview = ui.get('#' + id)!;
      if (preview.dataset.preset !== preset) { preview.replaceChildren(weaponPreviewCanvas(preset)); preview.dataset.preset = preset; }
    }
  }
}
