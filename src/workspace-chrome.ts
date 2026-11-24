import { tr } from './i18n.ts';
interface WorkspaceUi {
  get(selector: string): HTMLElement;
  set(selector: string, changes: { hidden?: boolean; text?: string; attr?: Record<string, string> }): unknown;
}
export interface WorkspaceChromeState {
  space: 'field' | 'project' | 'trial';
  panel?: string | null;
  title?: string;
  inspector?: boolean;
  trial?: string | null;
}
interface FocusTarget extends Element { focus(options?: FocusOptions): void }
const focusTarget = (element: Element | null): element is FocusTarget => Boolean(element && 'focus' in element && typeof element.focus === 'function');
const disabled = (element: Element): boolean => 'disabled' in element && Boolean(element.disabled);
const SPACE_NAMES = { field: tr('Campo'), project: tr('Construir'), trial: tr('Ensaio') };
const TRIAL_NAMES: Readonly<Record<string, string>> = { armour: tr('Ensaio de blindagem'), terrain: tr('Campo de provas') };
const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };

// The fixed shell lives in index.html. Opening a surface owns no game state.
export class WorkspaceChrome {
  declare ui: WorkspaceUi;
  declare beforeOpen: (() => void) | undefined;
  declare onClose: (() => void) | null;
  declare opener: FocusTarget | null;
  declare app: HTMLElement; declare sidebar: HTMLElement; declare viewport: HTMLElement;
  declare bar: HTMLElement; declare nav: HTMLElement; declare field: HTMLElement; declare project: HTMLElement;
  declare trialName: HTMLElement; declare reset: HTMLElement; declare trialActions: HTMLElement; declare projectTools: HTMLElement; declare fieldTools: HTMLElement;
  declare heading: HTMLElement; declare close: HTMLElement; declare content: HTMLElement; declare backdrop: HTMLElement;
  declare inspector: HTMLElement; declare dock: HTMLElement;
  constructor(ui: WorkspaceUi, { stopControls }: { stopControls?: () => void } = {}) {
    this.ui = ui; this.beforeOpen = stopControls; this.onClose = null; this.opener = null;
    this.app = ui.get('#app'); this.sidebar = ui.get('.sidebar'); this.viewport = ui.get('#viewport');
    this.bar = ui.get('#workspace-bar'); this.nav = ui.get('#workspace-nav');
    this.field = ui.get('#go-field'); this.project = ui.get('#go-workshop');
    this.trialName = ui.get('#trial-name'); this.reset = ui.get('#reset');
    this.trialActions = ui.get('#workspace-trial'); this.projectTools = ui.get('#project-tools'); this.fieldTools = ui.get('#field-tools');
    this.heading = ui.get('#workspace-surface-heading'); this.close = ui.get('#workspace-surface-close');
    this.close.onclick = () => this.onClose?.();
    this.content = ui.get('#workspace-surface-content'); this.backdrop = ui.get('#workspace-backdrop');
    // Keep the whole first gesture on this layer. Closing on pointerdown would
    // expose the canvas before the same gesture's pointerup and click arrive.
    for (const type of ['pointerdown', 'pointerup']) this.backdrop.addEventListener(type, event => event.stopPropagation());
    this.backdrop.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (!this.backdrop.hidden && event.button === 0) this.onClose?.();
    });
    this.inspector = ui.get('#project-inspector'); this.dock = ui.get('#field-dock');

    this.sidebar.addEventListener('keydown', event => {
      if (this.sidebar.hidden || event.defaultPrevented || event.isComposing) return;
      // A native select uses Escape to dismiss its own choices first.
      if (event.key === 'Escape' && (!event.target || !('tagName' in event.target) || event.target.tagName !== 'SELECT')) {
        event.preventDefault(); event.stopPropagation(); this.onClose?.(); return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...this.sidebar.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')]
        .filter(element => !disabled(element) && element.tabIndex >= 0 && !element.closest('[hidden], [inert]') && element.checkVisibility()),
        first = controls[0], last = controls.at(-1), active = document.activeElement;
      if (!first || event.shiftKey && (active === first || active === this.heading) || !event.shiftKey && active === last) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus({ preventScroll: true });
        if (!first) this.heading.focus({ preventScroll: true });
      }
    });
    this.render({ space: 'project', panel: null, title: tr('Construir') });
  }

  render({ space, panel = null, title = '', inspector = false, trial = null }: WorkspaceChromeState): void {
    const open = Boolean(panel), wasOpen = !this.sidebar.hidden,
      changed = this.app.dataset.workspace !== space || this.app.dataset.workspacePanel !== (panel || '');
    if (open && !wasOpen) {
      const active = document.activeElement;
      this.opener = focusTarget(active) && !this.sidebar.contains(active) && !active.matches('body, html') ? active : null;
      this.beforeOpen?.();
    }
    if (this.app.dataset.workspace !== space) this.app.dataset.workspace = space;
    if (this.app.dataset.workspacePanel !== (panel || '')) this.app.dataset.workspacePanel = panel || '';
    this.sidebar.hidden = !open;
    this.backdrop.hidden = !open;
    if (open && (!wasOpen || changed)) this.content.scrollTop = 0;
    this.viewport.inert = open;
    this.projectTools.hidden = space !== 'project'; this.fieldTools.hidden = space !== 'field';
    this.inspector.hidden = space !== 'project' || !inspector;
    if (space === 'project') this.dock.hidden = true;
    this.trialActions.hidden = space !== 'trial';
    this.trialName.hidden = this.reset.hidden = space !== 'trial';
    write(this.trialName, (trial && TRIAL_NAMES[trial]) || tr('Ensaio privado'));
    write(this.heading, title || SPACE_NAMES[space]);
    this.ui.set('#go-field', { hidden: false, attr: { 'aria-current': space === 'field' ? 'page' : 'false',
      'aria-label': space === 'trial' ? tr('Sair do ensaio e voltar ao campo') : tr('Campo'), title: tr('Ir para o campo') } });
    this.ui.set('#go-workshop', { hidden: false, attr: { 'aria-current': space === 'project' ? 'page' : 'false',
      'aria-label': space === 'trial' ? tr('Sair do ensaio e voltar ao projeto') : tr('Construir'), title: tr('Construir e editar veículos') } });
    // In the workshop C closes the panel as Esc does (workshop-keys.ts).
    this.ui.set('#workspace-surface-close', { attr: { title: space === 'project' ? tr('Fechar painel · C') : tr('Fechar painel · Esc') } });
    this.ui.set('#workspace-bar', { attr: { 'aria-label': space === 'trial' ? (trial && TRIAL_NAMES[trial]) || tr('Ensaio privado') : SPACE_NAMES[space] } });
    this.ui.set('#go-field-label', { text: tr('Campo') }); this.ui.set('#go-workshop-label', { text: space === 'trial' ? tr('Voltar ao projeto') : tr('Construir') });
    if (open && (!wasOpen || changed)) this.heading.focus({ preventScroll: true });
    else if (!open && wasOpen) {
      const target = this.opener;
      this.opener = null;
      if (target?.isConnected && !disabled(target) && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
      else (space === 'field' ? this.field : this.project).focus({ preventScroll: true });
    }
  }
}
