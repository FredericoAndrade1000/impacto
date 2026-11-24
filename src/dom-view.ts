// Small DOM primitives. Models supply values; elements never own game state.
export type DomScalar = string | number | boolean | null | undefined;
export type OptionEntry = readonly [value: string | number, text: DomScalar, disabled?: boolean];
export interface BindingProperties {
  options?: readonly OptionEntry[]; text?: DomScalar; classes?: Readonly<Record<string, unknown>>;
  attr?: Readonly<Record<string, DomScalar>>; style?: Readonly<Record<string, string | null>>; data?: Readonly<Record<string, DomScalar>>;
  value?: DomScalar; hidden?: boolean | 'until-found'; disabled?: boolean; checked?: boolean; open?: boolean;
  title?: string; type?: string; min?: string | number; max?: string | number; step?: string | number; readOnly?: boolean; multiple?: boolean;
}
export const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: DomScalar): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) Reflect.set(element, 'textContent', text);
  return element;
};
export const actionButton = (text: DomScalar, action: (event: MouseEvent) => unknown, className = ''): HTMLButtonElement => {
  const button = node('button', className, text);
  button.type = 'button'; button.onclick = action; return button;
};
// One of the page's own marks (an <svg> symbol of index.html), as markup.
export const icon = (id: string, className = ''): string => `<svg${className ? ` class="${className}"` : ''} aria-hidden="true"><use href="#${id}"/></svg>`;
const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHTML = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ENTITIES[c] ?? c);
// A disclosure marked `data-kept` opens as the player last left it, from one visit to the next: by its id.
const KEPT = 'impacto.open.';
const keptOpen = (id: string, fallback = false): boolean => {
  try { const kept = localStorage.getItem(KEPT + id); return kept === null ? fallback : kept === 'open'; } catch { return fallback; }
};
// Those of the page are opened so at once, and any of them, there now or made later, is kept as it is left.
export function keepDisclosures(): void {
  for (const details of document.querySelectorAll<HTMLDetailsElement>('details[data-kept]')) details.open = keptOpen(details.id, details.open);
  document.addEventListener('toggle', ({ target }) => {
    if (!target || !('matches' in target) || typeof target.matches !== 'function' || !target.matches('details[data-kept]')) return;
    if ('id' in target && typeof target.id === 'string' && 'open' in target) try { localStorage.setItem(KEPT + target.id, target.open ? 'open' : 'closed'); } catch {}
  }, true);
}

export class DomView {
  declare readonly elements: Map<string, HTMLElement | null>;
  constructor() { this.elements = new Map(); }
  get(selector: string): HTMLElement | null {
    if (!this.elements.has(selector)) this.elements.set(selector, document.querySelector<HTMLElement>(selector));
    return this.elements.get(selector) ?? null;
  }
  apply(bindings: Readonly<Record<string, BindingProperties>>): void {
    for (const [id, properties] of Object.entries(bindings)) this.set('#' + id, properties);
  }
  set(selector: string, properties: BindingProperties): void {
    const element = this.get(selector);
    if (!element) throw new Error('Controle ausente: ' + selector);
    const entries: [string, unknown][] = Object.entries(properties);
    for (const [key, value] of entries) {
      if (key === 'options' && properties.options) this.options(element, properties.options);
      else if (key === 'text') { if (element.textContent !== String(value)) Reflect.set(element, 'textContent', value); }
      else if (key === 'classes' && properties.classes) for (const [name, active] of Object.entries(properties.classes)) element.classList.toggle(name, Boolean(active));
      else if (key === 'attr' && properties.attr) for (const [name, entry] of Object.entries(properties.attr)) {
        if (element.getAttribute(name) !== String(entry)) element.setAttribute(name, String(entry));
      }
      else if (key === 'style' && properties.style) for (const [name, entry] of Object.entries(properties.style)) element.style.setProperty(name, entry);
      else if (key === 'data' && properties.data) for (const [name, entry] of Object.entries(properties.data)) {
        if (element.dataset[name] !== String(entry)) element.dataset[name] = String(entry);
      }
      else if (key !== 'value' || element !== document.activeElement || element.tagName === 'SELECT') {
        if (typeof value !== 'boolean' || Reflect.get(element, key) !== value) Reflect.set(element, key, value);
      }
    }
  }
  options(element: HTMLElement, entries: readonly OptionEntry[]): void {
    const key = JSON.stringify(entries), selected: unknown = Reflect.get(element, 'value');
    if (element.dataset.options === key) return;
    element.replaceChildren(...entries.map(([value, text, disabled = false]) => {
      const option = node('option', '', text); option.value = String(value); option.disabled = disabled; return option;
    }));
    // Replacing options makes a native select choose its first entry. Preserve
    // the visible choice when a polling catalog inserts/reorders other entries.
    if (entries.some(([value]) => String(value) === selected)) Reflect.set(element, 'value', selected);
    element.dataset.options = key;
  }
}
