import type { DomView } from './dom-view.ts';
import type { UiView, UiModel } from './ui-model.ts';
import type { FactionView } from './faction-ui.ts';
export type FieldTask = 'vehicle' | 'infra' | 'test';
export interface FieldTestConsole { readonly available: boolean; readonly blocked: string; open(): boolean; close(): unknown }
export interface FieldScreenOptions {
  readonly view: Pick<UiView, 'trial'>; readonly release: (event: MouseEvent) => unknown;
  readonly turn: (event: MouseEvent) => unknown; readonly cancelOrder: (event: MouseEvent) => unknown;
  readonly testConsole?: FieldTestConsole | null; readonly notify?: (text: string) => void;
}
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing field screen control'); return value; };
const isTask = (task: string): task is FieldTask => task === 'vehicle' || task === 'infra' || task === 'test';
import { tr } from './i18n.ts';
import { FIELD_TASKS, fieldNavigation } from './field-navigation.ts';

const write = (element: Node | null | undefined, value: string): void => { const target = required(element); if (target.textContent !== String(value)) target.textContent = value; };
const hide = (element: HTMLElement | null | undefined, value: boolean): void => { const target = required(element); if (target.hidden !== Boolean(value)) target.hidden = Boolean(value); };
const attribute = (element: HTMLElement, name: string, value: string | boolean): void => { if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value)); };
// Fixed controls are authored in index.html; tasks retain only presentation state. Of the buttons of the field's tools, those
// of a page open it in the side panel — the condition of a construction, the infrastructure of the faction, the tests —; that
// of the faction opens its own window (faction-dialog.ts), and is only shown here.
export class FieldScreen {
  declare readonly ui: Pick<DomView, 'get'>;
  declare readonly view: Pick<UiView, 'trial'>;
  declare task: FieldTask | null;
  declare visibility: ((task: FieldTask | null) => void) | null;
  declare readonly testConsole: FieldTestConsole | null;
  declare readonly notify: (text: string) => void;
  declare readonly sidebar: HTMLElement; declare readonly tools: HTMLElement; declare readonly dock: HTMLElement; declare readonly pages: HTMLElement;
  declare readonly panels: Map<string, HTMLElement>; declare readonly buttons: Map<string, HTMLElement>; declare readonly triggers: Map<string, HTMLElement>;
  declare readonly vehicleEmpty: HTMLElement; declare readonly heading: HTMLElement; declare readonly mode: HTMLElement; declare readonly title: HTMLElement;
  declare readonly details: HTMLElement; declare offers: boolean; declare readonly release: HTMLElement; declare readonly control: HTMLElement; declare readonly controlLabel: HTMLElement;
  declare readonly status: HTMLElement; declare readonly prompt: HTMLElement; declare readonly promptText: HTMLElement; declare readonly cancel: HTMLElement;
  declare readonly controls: HTMLElement; declare readonly turn: HTMLElement; declare readonly turnReason: HTMLElement; declare readonly controlsHint: HTMLElement;
  constructor(ui: Pick<DomView, 'get'>, { view, release, turn, cancelOrder, testConsole = null, notify = () => {} }: FieldScreenOptions) {
    const get = (selector: string): HTMLElement => required(ui.get(selector));
    this.ui = ui; this.view = view; this.task = null; this.visibility = null; this.testConsole = testConsole; this.notify = notify;
    this.sidebar = get('.sidebar');
    this.tools = get('#field-tools'); this.dock = get('#field-dock');
    this.pages = get('#field-pages');
    this.panels = new Map(['vehicle', 'infra', ...(testConsole ? ['test'] : [])].map(id => [id, get('#field-page-' + id)]));
    this.buttons = new Map(FIELD_TASKS.filter(task => task.id !== 'test' || testConsole).map(task => [task.id, get('[data-field-task="' + task.id + '"]')]));
    this.triggers = new Map([...this.buttons].filter(([id]) => this.panels.has(id)));
    for (const [id, trigger] of this.triggers) trigger.onclick = () => this.task === id ? this.close() : this.openTask(id);
    this.vehicleEmpty = get('#field-vehicle-empty');
    this.heading = get('#field-dock-heading'); this.mode = get('#field-mode'); this.title = get('#field-dock-title');
    // Condition and services share one page: with something to ask, it opens on the services.
    this.details = get('#field-details'); this.offers = false;
    this.details.onclick = () => { if (this.offers) Reflect.set(get('#unit-services'), 'open', true); this.openTask('vehicle'); };
    this.release = get('#field-release'); this.release.onclick = release;
    this.control = get('#unit-control'); this.controlLabel = get('#unit-control-label');
    this.status = get('#field-dock-status'); this.prompt = get('#field-order-prompt'); this.promptText = get('#field-order-prompt-text');
    this.cancel = get('#field-order-cancel'); this.cancel.onclick = cancelOrder;
    this.controls = get('#field-controls'); this.turn = get('#field-turn'); this.turn.onclick = turn;
    this.turnReason = get('#field-turn-reason'); this.controlsHint = get('#field-controls-hint');
  }
  get titleText(): string { return this.task === 'vehicle' && this.view.trial ? tr('Ajustar teste') : this.task ? { vehicle: tr('Condição e serviços'), infra: tr('Infraestrutura'), test: tr('Painel de testes') }[this.task] : tr('Campo'); }
  onVisibility(change: (task: FieldTask | null) => void): () => void { this.visibility = change; return () => { if (this.visibility === change) this.visibility = null; }; }
  openTask(task: string): boolean {
    if (!isTask(task) || !this.panels.has(task)) return false;
    if (task === 'test' && !this.testConsole?.open()) return false;
    if (this.task === 'test' && task !== 'test') this.testConsole?.close();
    const changed = this.task !== task; this.task = task; this.sidebar.dataset.fieldTask = task;
    this.pages.hidden = false;
    for (const [id, page] of this.panels) page.hidden = id !== task;
    for (const [id, trigger] of this.triggers) trigger.setAttribute('aria-expanded', String(id === task));
    if (changed) { required(this.panels.get(task)).scrollTop = 0; this.visibility?.(task); }
    return true;
  }
  close() {
    if (this.task === null) return false;
    if (this.task === 'test') this.testConsole?.close();
    this.task = null; this.sidebar.dataset.fieldTask = 'closed'; this.pages.hidden = true;
    for (const page of this.panels.values()) page.hidden = true;
    for (const trigger of this.triggers.values()) trigger.setAttribute('aria-expanded', 'false');
    this.visibility?.(null); return true;
  }
  render(c: UiModel, faction: FactionView | null | undefined): void {
    const active = !c.edit, testTools = active && Boolean(this.testConsole?.available),
      model = fieldNavigation({ shared: c.shared, panel: c.panel, faction, touch: c.touch, driven: c.driven, flies: c.flies, testTools });
    for (const [id, button] of this.buttons) hide(button, !active || !model.tasks.some(task => task.id === id));
    // A test has no faction at the top, and no name in its dock, which is in the row at the top: its heading is the speed of the
    // vehicle in hand alone.
    hide(this.tools, !active || !model.tasks.length); hide(this.dock, !active || !model.dock);
    if (!active) { this.close(); return; }
    if (this.task === 'test' && (!testTools || this.testConsole?.blocked)) this.close();
    // No construction remains to inspect: release the surface so recovery over the field is reachable.
    if (this.task === 'vehicle' && model.vehicleEmpty && faction?.count === 0) this.close();
    // Selection and control update the dock; they never open or replace a surface.
    attribute(this.dock, 'data-manual', Boolean(c.manual)); attribute(this.dock, 'data-armed', Boolean(model.armed));
    hide(this.heading, !model.title && !c.dockSpeed); write(this.mode, model.mode); write(this.title, model.title); this.title.title = model.title;
    hide(this.mode, !model.mode); hide(this.title, !model.title);
    hide(this.details, !model.details); write(this.details.children[1], model.detailsLabel);
    this.offers = model.services; attribute(this.details, 'data-services', model.services);
    const details = model.services ? model.detailsLabel + tr(' · serviços disponíveis') : model.detailsLabel;
    attribute(this.details, 'aria-label', details); attribute(this.details, 'title', details);
    write(this.controlLabel, model.controlLabel); hide(this.release, !model.release);
    write(this.status, model.status); hide(this.status, !model.status || Boolean(model.armed));
    hide(this.prompt, !model.armed); write(this.promptText, model.armed);
    hide(this.vehicleEmpty, !model.vehicleEmpty);
    const hint = c.manual ? model.controlsHint : '';
    hide(this.controls, !hint && !c.panel.turn); hide(this.turn, !c.panel.turn); write(this.controlsHint, hint); hide(this.controlsHint, !hint);
    Reflect.set(this.turn, 'disabled', Boolean(c.panel.turnDisabled));
    write(this.turnReason, c.panel.turnReason || ''); hide(this.turnReason, !c.panel.turn || !c.panel.turnReason);
    attribute(this.turn, 'aria-describedby', c.panel.turnDisabled ? this.turnReason.id : '');
    // The pedals are of a design that moves: not of a fixed one on the field, nor of one under a test of armour. One that
    // flies is flown with the stick in their place.
    const pedals = !(c.shared && !model.mobile || c.driven === false);
    hide(this.ui.get('#touch-pad .touch-drive'), !pedals || c.flies); hide(this.ui.get('#touch-stick'), !pedals || !c.flies);
    if (!faction) return;
    // A stock that something stands still for, or that does not cover what is asked of it, is in the colour of that, and says
    // what it is to the pointer over it — and to a touch or a click, in a notice: it alone takes them from the field.
    for (const stock of model.stocks) {
      const hud = required(this.ui.get('#stock-' + stock.id)), row = required(hud.parentElement), want = c.wants?.[stock.id],
        title = stock.name + ': ' + stock.text + (want ? ' · ' + want.text : '');
      if (row.title !== title) row.title = title;
      attribute(row, 'data-want', want?.level ?? '');
      row.onclick = want ? () => this.notify(stock.name + ' · ' + want.text) : null;
    }
  }
}
