import type { FieldPanelView } from './field-panel.ts';
import type { CargoKind } from './economy-contract.ts';
import type { Camera } from './camera.ts';
import type { Point } from './math.ts';
import type { NetworkClient } from './network-client.ts';
export type SiteKind = 'vein' | 'wreck' | 'work' | 'heap' | 'road' | 'post';
export interface SiteArea { left: number; right: number; top: number; bottom: number }
export interface FieldSiteMark { kind: SiteKind; id: string; x: number; area: SiteArea; button?: Point | null }
export interface FieldSiteChoice { kind: SiteKind; id: string }
interface SiteWork { text: string; title: string; icon: string; disabled: boolean }
interface SiteRow {
  id: string; name: string; x: number; lines: readonly string[]; details?: readonly string[]; share?: number | null;
  type?: string; material?: CargoKind; supplied?: boolean; takedown?: boolean;
  cancel?: { text: string; title: string; question: string };
  collect?: { ids: readonly string[]; name: string; label: string; title: string; icon: string } | null;
  salvage?: SiteWork | null;
}
export interface FieldSitesOptions {
  readonly view: HTMLElement; readonly canvas: HTMLCanvasElement; readonly camera: Pick<Camera, 'width' | 'height' | 'cover'>;
  readonly command: NetworkClient['command']; readonly toast: (text: string, error?: boolean) => void;
  readonly refresh: () => void; readonly picked: () => readonly string[]; readonly measure?: ((words: string) => number) | null;
  readonly confirm?: (question: string, details: string, action: string) => Promise<boolean>;
}
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing field site record'); return value; };
const isNode = (target: EventTarget | null): target is Node => target !== null && 'contains' in target && typeof target.contains === 'function';
const isHtml = (element: Element | undefined): element is HTMLElement => element !== undefined && 'dataset' in element;
import { tr } from './i18n.ts';
import { messageText } from './user-message.ts';
import { node, icon } from './dom-view.ts';
import { salvagedText, abandonedText, postText } from './faction-ui.ts';
import { touching, reach } from './touch.ts';
import { clamp } from './math.ts';
import { confirm as asking } from './confirm-dialog.ts';

// Pixels between a mark and what stands by it, and kept from the edges of the view.
const GAP = 6, EDGE = 8;
// A button over a mark: its height, taller under a finger, and what it adds to the width of its words — the mark of what
// it does, the room about them and its edge (field-sites.css). Its words are measured in its font.
const BUTTON = Object.freeze({ mouse: { height: 28, room: 42 }, touch: { height: 40, room: 50 } });
const FONT = '600 12.5px system-ui, sans-serif';
const overlaps = (a: SiteArea, b: SiteArea): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
// The mark at the head of the card of each kind of place but a vein, which is marked by its material.
const MARKS = Object.freeze({ wreck: 'i-wreck', work: 'i-build', heap: 'i-haul', road: 'i-road', post: 'i-flag' });
// What gives up a place of the faction from its card, as the field is asked it — of its row (`type`) —, and what is said of
// what came of it: a works or a road given up, and a post taken down, or kept while it is being taken down.
// The places of the field worth a word at their marks: the veins the faction knows of, the wrecks on the field, and the
// works, the heaps, the roads asked for and the posts of the faction. Over the mark of a vein or a wreck stands the button of what the vehicles picked can
// do there — collect at a vein, dismantle a wreck or take up the load of one dismantled —, and a press on a mark opens a
// small card of what there is there, by the mark, until a press anywhere else: that of a works or of a road with the button
// that gives it up, that of a post with the one that takes it down or keeps it. What each says and offers is what `fieldPanel`
// tells (`veins`, `wrecks`, `works`, `heaps`, `roads`, `posts`); where the
// marks stand on the screen this frame is told by whoever draws them (`place`). The buttons go in `host`, with the marks;
// the card in `view`, the view of the field, over its panels. `command` asks the field, `picked` are the vehicles chosen,
// `camera` the view (its size and what the panels cover of it), `canvas` the field, which the keyboard goes back to, and
// `confirm` asks the player before a works or a road is given up.
export class FieldSites {
  declare readonly host: HTMLElement; declare readonly canvas: HTMLCanvasElement; declare readonly camera: FieldSitesOptions['camera'];
  declare readonly command: NetworkClient['command']; declare readonly toast: FieldSitesOptions['toast']; declare readonly refresh: () => void;
  declare readonly picked: () => readonly string[]; declare measure: ((words: string) => number) | null; declare readonly confirm: NonNullable<FieldSitesOptions['confirm']>;
  declare rows: Record<SiteKind, Map<string, SiteRow>>;
  declare readonly buttons: Map<string, HTMLButtonElement>;
  declare marks: FieldSiteMark[];
  declare open: FieldSiteChoice | null;
  declare cardKey: string | null;
  declare cardSize: { width: number; height: number } | null;
  declare pending: boolean;
  declare readonly card: HTMLElement;
  constructor(host: HTMLElement, { view, canvas, camera, command, toast, refresh, picked, measure = null, confirm = asking }: FieldSitesOptions) {
    this.host = host; this.canvas = canvas; this.camera = camera; this.command = command; this.toast = toast; this.refresh = refresh; this.picked = picked; this.measure = measure; this.confirm = confirm;
    this.rows = { vein: new Map(), wreck: new Map(), work: new Map(), heap: new Map(), road: new Map(), post: new Map() }; this.buttons = new Map(); this.marks = [];
    this.open = null; this.cardKey = null; this.cardSize = null; this.pending = false;
    this.card = node('section', 'field-site-card'); this.card.hidden = true; this.card.setAttribute('role', 'note'); view.append(this.card);
    // A press anywhere but on the card, or on the mark it is of, puts the card away: the mark's own press toggles it.
    document.addEventListener('pointerdown', event => {
      if (!this.open || this.card.contains(isNode(event.target) ? event.target : null)) return;
      if (event.target === this.canvas) {
        const box = this.canvas.getBoundingClientRect(), site = this.at(event.clientX - box.left, event.clientY - box.top);
        if (site?.kind === this.open.kind && site.id === this.open.id) return;
      }
      this.close();
    }, true);
  }
  // What can be done at a place, as its button says it: nothing, where the vehicles picked can do nothing there, nor at a
  // works, a heap or a road, which the faction works on by itself.
  work(kind: SiteKind, id: string): SiteWork | null {
    const row = this.rows[kind].get(id);
    if (kind === 'vein') return row?.collect ? { text: row.collect.label, title: row.collect.title, icon: row.collect.icon, disabled: false } : null;
    if (kind !== 'wreck') return null;
    return row?.salvage ? { text: row.salvage.text, title: row.salvage.title, icon: row.salvage.icon,
      disabled: row.salvage.disabled } : null;
  }
  // How big the button over a place is, for the words of its mark to leave it room; nothing where it has none.
  size(kind: SiteKind, id: string): { width: number; height: number } | null {
    const work = this.work(kind, id);
    if (!work) return null;
    if (!this.measure) { const pen = required(document.createElement('canvas').getContext('2d')); pen.font = FONT; this.measure = words => pen.measureText(words).width; }
    const kept = BUTTON[touching() ? 'touch' : 'mouse'];
    return { width: Math.ceil(this.measure(work.text)) + kept.room, height: kept.height };
  }
  // The place whose mark is under a point of the view, the nearest across: a finger takes hold farther from it.
  at(sx: number, sy: number): FieldSiteChoice | null {
    const pad = reach(4);
    let best: (FieldSiteChoice & { far: number }) | null = null;
    for (const mark of this.marks) {
      const area = mark.area, far = Math.abs(sx - mark.x);
      if (sx < area.left - pad || sx > area.right + pad || sy < area.top - pad || sy > area.bottom + pad || best && best.far <= far) continue;
      best = { kind: mark.kind, id: mark.id, far };
    }
    return best && { kind: best.kind, id: best.id };
  }
  // The card of a place opens on a press of its mark, and a second press puts it away.
  toggle(site: FieldSiteChoice): boolean {
    if (this.open?.kind === site.kind && this.open.id === site.id) return this.close();
    this.open = { kind: site.kind, id: site.id }; this.cardKey = null; this.write(); this.lay(); return true;
  }
  close() {
    if (!this.open) return false;
    this.open = null; this.card.hidden = true; return true;
  }
  // What the panel tells of the places; a card of one no longer told of goes with it.
  render(p: Pick<FieldPanelView, 'veins' | 'wrecks' | 'works' | 'heaps' | 'roads' | 'posts'>): void {
    const rows = (list: readonly SiteRow[]): Map<string, SiteRow> => new Map(list.map(row => [row.id, row]));
    this.rows = { vein: rows(p.veins), wreck: rows(p.wrecks), work: rows(p.works), heap: rows(p.heaps), road: rows(p.roads), post: rows(p.posts ?? []) };
    if (this.open && !this.rows[this.open.kind].has(this.open.id)) this.close();
    else this.write();
  }
  // The card says the place's name under the mark of its material, of a wreck, of a works, of a heap or of a road, and then a
  // line each of what there is to know of it — of a vein, with a bar of what is left of it under the first, and of a works or a
  // road with a bar of how far it is made and the button that gives it up at the foot. Made again only when that changes.
  write() {
    const row = this.open && this.rows[this.open.kind].get(this.open.id);
    if (!row || !this.open) return;
    const key = JSON.stringify([this.open, row.name, row.lines, row.details, row.share, row.cancel]);
    if (key === this.cardKey) return;
    const expanded = this.cardKey && this.card.querySelector('details')?.open,
      focused = this.cardKey && this.card.querySelector('summary') === document.activeElement;
    this.cardKey = key; this.cardSize = null;
    const head = node('header'), mark = node('span', 'field-site-icon'), kind = this.open.kind, id = this.open.id;
    mark.innerHTML = kind === 'vein' ? icon(row.supplied ? 'i-haul' : 'r-' + row.material, 'stock-icon') : icon(MARKS[kind]);
    head.append(mark, node('strong', '', row.name));
    const lines: HTMLElement[] = row.lines.map(line => node('p', '', line));
    if (row.share != null) {
      const bar = node('i'); bar.style.setProperty('--fill', Math.round(row.share * 100) + '%'); lines.splice(1, 0, bar);
    }
    if (row.cancel) {
      const give = node('button', 'field-site-card-action', row.cancel.text); give.type = 'button'; give.title = row.cancel.title;
      give.onclick = () => this.abandon(kind, id); lines.push(give);
    }
    if (row.details?.length) {
      const details = node('details'); details.open = Boolean(expanded);
      details.append(node('summary', '', tr('Detalhes')), ...row.details.map(line => node('p', '', line)));
      details.ontoggle = () => { this.cardSize = null; this.lay(); }; lines.push(details);
    }
    this.card.replaceChildren(head, ...lines); this.card.dataset.kind = kind;
    if (focused) this.card.querySelector('summary')?.focus({ preventScroll: true });
    this.card.setAttribute('aria-label', (kind === 'vein' && row.type !== 'airdrop' ? 'Jazida: ' : '') + row.name);
  }
  // Where the marks stand this frame: of each place, the middle of its mark across (`x`), what of the view it takes
  // (`area`) and where the foot of its button goes (`button`), when its mark has room for one. The buttons go with the
  // marks. A vein's button has its room kept over its words (deposit-labels.ts); a wreck's stands over its label and rises
  // over any other mark, or button, it would cover.
  place(marks: readonly FieldSiteMark[]): void {
    const shown = new Set<string>(), taken: SiteArea[] = [], height = BUTTON[touching() ? 'touch' : 'mouse'].height;
    this.marks = marks.map(mark => {
      const work = mark.button && this.work(mark.kind, mark.id);
      if (!work) return mark;
      const half = required(this.size(mark.kind, mark.id)).width / 2, x = required(mark.button).x, others = marks.filter(other => other !== mark).map(other => other.area);
      let y = required(mark.button).y;
      for (let turn = 0, under = true; mark.kind === 'wreck' && under && turn <= marks.length + taken.length; turn++) {
        const box = { left: x - half, right: x + half, top: y - height, bottom: y }, below = [...others, ...taken].find(other => overlaps(box, other));
        under = Boolean(below); if (below) y = below.top - GAP;
      }
      taken.push({ left: x - half, right: x + half, top: y - height, bottom: y });
      this.button(mark, work, { x, y }, shown);
      return y === required(mark.button).y ? mark : { ...mark, button: { x, y } };
    });
    for (const [key, button] of this.buttons) if (!shown.has(key)) { button.remove(); this.buttons.delete(key); }
    this.lay();
  }
  // The button over a place, made the first time and then only told what changed.
  button(mark: FieldSiteMark, work: SiteWork, foot: Point, shown: Set<string>): void {
    const key = mark.kind + ':' + mark.id; shown.add(key);
    let button = this.buttons.get(key);
    if (!button) {
      button = node('button', 'field-site-action'); button.type = 'button'; button.dataset.kind = mark.kind; button.dataset.id = mark.id;
      button.append(node('span', 'field-button-icon'), node('span'));
      button.onclick = () => this.act(mark.kind, mark.id);
      this.host.append(button); this.buttons.set(key, button);
    }
    const [glyph, words] = button.children, name = required(this.rows[mark.kind].get(mark.id)).name, label = `${work.text}: ${name}`;
    if (!isHtml(glyph)) throw new Error('Missing site icon');
    if (glyph.dataset.icon !== work.icon) { glyph.dataset.icon = work.icon; glyph.innerHTML = icon(work.icon); }
    if (required(words).textContent !== work.text) required(words).textContent = work.text;
    if (button.title !== work.title) button.title = work.title;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.disabled !== work.disabled) button.disabled = work.disabled;
    const x = Math.round(foot.x) + 'px', y = Math.round(foot.y) + 'px';
    if (button.dataset.x !== x) { button.dataset.x = x; button.style.setProperty('--x', x); }
    if (button.dataset.y !== y) { button.dataset.y = y; button.style.setProperty('--y', y); }
  }
  // The card stands over its mark — over its button, when it has one — or under it, in what the panels leave of the view;
  // where that has no room for it, over the panels, as near the mark as the view lets it, until the next press. Off the
  // view with its mark, it waits for it.
  lay() {
    const mark = this.open && this.marks.find(mark => mark.kind === required(this.open).kind && mark.id === required(this.open).id);
    if (!mark) { if (!this.card.hidden) this.card.hidden = true; return; }
    if (this.card.hidden) this.card.hidden = false;
    if (!this.cardSize) this.cardSize = { width: this.card.offsetWidth, height: this.card.offsetHeight };
    const { width, height } = this.cardSize, cover = this.camera.cover(),
      left = cover.left + EDGE, right = this.camera.width - cover.right - EDGE, top = cover.top + EDGE, bottom = this.camera.height - cover.bottom - EDGE,
      raised = this.buttons.has(mark.kind + ':' + mark.id) ? required(mark.button).y - BUTTON[touching() ? 'touch' : 'mouse'].height : Infinity,
      over = Math.min(mark.area.top, raised) - GAP - height, under = Math.max(mark.area.bottom + GAP, top),
      x = clamp(mark.x - width / 2, left, Math.max(left, right - width)),
      y = over >= top ? over : under + height <= bottom ? under : over >= EDGE ? over :
        clamp(mark.area.bottom + GAP, EDGE, Math.max(EDGE, this.camera.height - EDGE - height)),
      at = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (this.card.dataset.at !== at) { this.card.dataset.at = at; this.card.style.transform = at; }
  }
  // The button of a place: the vehicles picked that work a vein are sent there, those that do not stay as they are; a wreck
  // is worked on by whoever of the player stands by it. What came of it is said.
  async act(kind: SiteKind, id: string): Promise<void> {
    const row = this.rows[kind].get(id);
    if (this.pending || !row) return;
    this.close(); this.canvas.focus({ preventScroll: true });
    this.pending = true;
    try {
      if (kind === 'vein') {
        const selected = this.picked(), ids = (row.collect?.ids || []).filter(id => selected.includes(id));
        if (!ids.length) { this.toast(tr('Selecione um veículo com equipamento compatível com esta jazida.')); return; }
        const told = await this.command('squad', { order: 'haul', ids, depositId: id });
        // Some aircraft may not take it for their fuel return (server/room.ts `give`): that is said instead, in the page's language.
        if (told?.refused) this.toast(messageText(told.refused), true);
        else this.toast(tr`${required(row.collect).name}: ordem iniciada` + (ids.length < selected.length ? ` · ${ids.length} de ${selected.length} selecionados.` : '.'));
      } else if (row.salvage && !row.salvage.disabled) this.toast(salvagedText(await this.command('salvage', { wreckId: id })));
    } catch (error) { this.toast(error instanceof Error ? error.message : String(error), true); }
    finally { this.pending = false; this.refresh(); }
  }
  // A works or a road is given up from its card once the player says so: what came of a works stays where it was, in a heap;
  // what was made of a road stays on the field. So is a post taken down, or kept as it was while it is being taken down.
  async abandon(kind: SiteKind, id: string): Promise<void> {
    if (kind !== 'work' && kind !== 'road' && kind !== 'post') return;
    const row = this.rows[kind].get(id);
    if (this.pending || !row?.cancel) return;
    this.close(); this.canvas.focus({ preventScroll: true });
    this.pending = true;
    try {
      if (await this.confirm(row.cancel.question, row.cancel.title, row.cancel.text)) {
        if (kind === 'work') this.toast(abandonedText(await this.command('cancel-work', { workId: id })));
        else if (kind === 'road') { await this.command('cancel-road', { roadId: id }); this.toast(tr('Estrada cancelada: o que já foi feito fica.')); }
        else this.toast(postText(await this.command(row.takedown ? 'keep-post' : 'remove-post', { postId: id })));
      }
    } catch (error) { this.toast(error instanceof Error ? error.message : String(error), true); }
    finally { this.pending = false; this.refresh(); }
  }
}
