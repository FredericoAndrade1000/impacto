import { tr } from './i18n.ts';
// The window of the faction, over the field: three tabs — the faction itself, its trade and its diplomacy —, the one
// last looked at opened again. It is a modal dialog: Esc, its X or a press outside put it away, and the keys go back to
// the field. What waits for the player's answer on a tab and came since that tab was last open is news: counted on the
// tab and on the button that opens the window, and seen once its tab is open.
export const FACTION_TABS = Object.freeze(['faction', 'industry', 'trade', 'diplomacy'] as const);
export type FactionTab = typeof FACTION_TABS[number];
export type FactionNews = Partial<Readonly<Record<FactionTab, readonly string[]>>>;
const isTab = (value: unknown): value is FactionTab => typeof value === 'string' && FACTION_TABS.some(tab => tab === value);
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing faction control'); return value; };
const isDialog = (element: HTMLElement): element is HTMLDialogElement => 'showModal' in element && 'close' in element;
export interface FactionDialogOptions {
  readonly $?: (id: string) => HTMLElement | null; readonly back?: () => void; readonly opened?: () => void; readonly closed?: () => void;
}
const KEPT = 'impacto.faction-tab';
const keptTab = () => { try { const tab = localStorage.getItem(KEPT); return isTab(tab) ? tab : 'faction'; } catch { return 'faction'; } };
const keep = (tab: FactionTab): void => { try { localStorage.setItem(KEPT, tab); } catch {} };

// How much is new on each tab: of what waits there (`waiting`, keys by tab), what is not among the keys seen. A key seen
// that waits no more is forgotten, so what comes again is news again.
export function unseen(waiting: FactionNews, seen: Set<string>): Record<FactionTab, number> {
  const now = new Set(Object.values(waiting).flat());
  for (const key of seen) if (!now.has(key)) seen.delete(key);
  const counts: Record<FactionTab, number> = { faction: 0, industry: 0, trade: 0, diplomacy: 0 };
  for (const tab of FACTION_TABS) counts[tab] = (waiting[tab] ?? []).filter(key => !seen.has(key)).length;
  return counts;
}

const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
const attribute = (element: HTMLElement, name: string, value: string | boolean): void => { if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value)); };
const NEWS = Object.freeze({ faction: tr('Facção'), industry: tr('Melhorias'), trade: tr('Comércio'), diplomacy: tr('Diplomacia') });

export class FactionDialog {
  declare readonly dialog: HTMLDialogElement;
  declare readonly trigger: HTMLElement;
  declare readonly count: HTMLElement;
  declare readonly said: HTMLElement;
  declare readonly tabs: Map<FactionTab, HTMLElement>;
  declare readonly panels: Map<FactionTab, HTMLElement>;
  declare readonly news: Map<FactionTab, HTMLElement>;
  declare readonly seen: Set<string>;
  declare waiting: FactionNews;
  declare tab: FactionTab;
  declare saying: ReturnType<typeof setTimeout> | undefined;
  declare outside: boolean;
  declare readonly back: () => void;
  declare readonly opened: () => void;
  declare readonly closed: () => void;
  // `back` gives the keys back to the field; `opened` and `closed` are told when the window comes and goes.
  constructor({ $: lookup = id => document.getElementById(id), back = () => {}, opened = () => {}, closed = () => {} }: FactionDialogOptions) {
    const $ = (id: string): HTMLElement => required(lookup(id));
    const dialog = $('faction-dialog'); if (!isDialog(dialog)) throw new Error('Missing faction dialog');
    this.dialog = dialog; this.trigger = $('faction-open'); this.count = $('faction-open-count');
    this.tab = keptTab(); this.seen = new Set(); this.waiting = {}; this.saying = undefined; this.outside = false;
    this.tabs = new Map(FACTION_TABS.map(id => [id, $('faction-tab-' + id)]));
    this.panels = new Map(FACTION_TABS.map(id => [id, $('faction-panel-' + id)]));
    this.news = new Map(FACTION_TABS.map(id => [id, $('faction-news-' + id)]));
    this.said = $('faction-said');
    this.trigger.onclick = () => this.open();
    $('faction-dialog-close').onclick = () => this.close();
    for (const [id, tab] of this.tabs) tab.onclick = () => this.show(id);
    // Left and right go from tab to tab, as a row of tabs is gone through.
    $('faction-tabs').addEventListener('keydown', event => {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = required(FACTION_TABS[(FACTION_TABS.indexOf(this.tab) + step + FACTION_TABS.length) % FACTION_TABS.length]);
      this.show(next); required(this.tabs.get(next)).focus();
    });
    // A press outside the window puts it away: one that began and ended on the backdrop, not a drag out of a field.
    const beyond = (event: MouseEvent): boolean => {
      if (event.target !== this.dialog) return false;
      const box = this.dialog.getBoundingClientRect();
      return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    };
    this.dialog.addEventListener('pointerdown', event => { this.outside = beyond(event); });
    this.dialog.addEventListener('click', event => { if (this.outside && beyond(event)) this.close(); this.outside = false; });
    // Esc closes it here and now: the dialog's own close event waits for a frame, which a hidden page never draws.
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.back = back; this.opened = opened; this.closed = closed; this.show(this.tab);
  }
  get isOpen(): boolean { return Boolean(this.dialog.open); }
  open(tab: FactionTab = this.tab): void {
    if (!this.isOpen) { this.opened(); this.dialog.showModal(); attribute(this.trigger, 'aria-expanded', true); }
    this.show(tab, true);
  }
  close(): void {
    if (!this.isOpen) return;
    this.dialog.close(); clearTimeout(this.saying); this.said.hidden = true; attribute(this.trigger, 'aria-expanded', false);
    this.back(); this.closed();
  }
  // The tab on screen, kept for the next time the window opens; what is new on it is seen.
  show(tab: FactionTab, focus = false): void {
    if (!isTab(tab)) return;
    const changed = this.tab !== tab;
    this.tab = tab; keep(tab);
    for (const [id, button] of this.tabs) { attribute(button, 'aria-selected', id === tab); button.tabIndex = id === tab ? 0 : -1; }
    for (const [id, panel] of this.panels) panel.hidden = id !== tab;
    if (changed && this.isOpen) required(this.panels.get(tab)).scrollTop = 0;
    if (focus) required(this.tabs.get(tab)).focus?.({ preventScroll: true });
    this.tell(this.waiting);
  }
  // What waits for the player's answer, keys by tab: what came on the tab in sight is seen at once, and the rest is counted.
  tell(waiting: FactionNews): void {
    this.waiting = waiting;
    if (this.isOpen) for (const key of waiting[this.tab] ?? []) this.seen.add(key);
    const counts = unseen(waiting, this.seen), total = FACTION_TABS.reduce((sum, tab) => sum + counts[tab], 0);
    for (const [id, mark] of this.news) {
      write(mark, counts[id] ? String(counts[id]) : ''); mark.hidden = !counts[id];
      attribute(required(this.tabs.get(id)), 'aria-label', counts[id] ? `${NEWS[id]} · ${counts[id] === 1 ? '1 novidade' : counts[id] + ' novidades'}` : NEWS[id]);
    }
    write(this.count, total ? String(total) : ''); attribute(this.trigger, 'data-attention', total > 0);
    const label = total ? tr`Facção · ${total === 1 ? '1 novidade' : total + ' novidades'}` : tr('Facção');
    attribute(this.trigger, 'aria-label', label); attribute(this.trigger, 'title', label);
  }
  // A word on what was just done, at the foot of the window, where the player looks: the notices of the field are behind it.
  say(text: string, error = false): void {
    clearTimeout(this.saying);
    write(this.said, text); this.said.hidden = !text; attribute(this.said, 'data-error', Boolean(error));
    attribute(this.said, 'role', error ? 'alert' : 'status');
    if (text) this.saying = setTimeout(() => { this.said.hidden = true; }, Math.max(4000, text.length * 70));
  }
}
