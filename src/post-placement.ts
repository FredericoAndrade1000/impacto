import type { FieldView, FactionView } from './faction-ui.ts';
import type { Terrain } from './terrain.ts';
import type { AuthoredConstruction, CompiledConstruction } from './construction-contract.ts';
import type { StockId } from './economy-contract.ts';
import type { postQuote } from './faction-ui.ts';
export interface PostIntent { x: number; facing: -1 | 1 }
export interface PostPlacementRenderer { readonly state: FieldView | null; readonly ground: Terrain; previewPost(post: (PostIntent & { refused: boolean }) | null): void }
export interface PostPlacementOptions {
  readonly host: HTMLElement; readonly renderer: PostPlacementRenderer; readonly compile: (blueprint: AuthoredConstruction) => CompiledConstruction;
  readonly getQuote: () => ReturnType<typeof postQuote> | null; readonly onConfirm?: (intent: PostIntent) => unknown; readonly onCancel?: () => unknown;
}
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing post placement state'); return value; };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
import { tr } from './i18n.ts';
import { node, icon, actionButton } from './dom-view.ts';
import { STOCK_IDS, STOCKS, LOAD_REACH } from './economy.ts';
import { count, metres, way } from './format.ts';
import { siteRefusal } from './construction-site.ts';
import { POST_LIMIT, POST_NAME, POST_RADIUS, postRefusal, postSpan, territoryOf } from './territory.ts';
import { depositsNear, depositsOf } from './deposits.ts';
import { takenGround } from './publication-placement.ts';
import { constructionSpan } from './construction-placement.ts';
import { touching } from './touch.ts';

const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
// A button of the dock made as those of the vehicle's dock are (field-workspace.css): its mark, its words, if any, and the
// key that does the same, if one does.
const dockButton = (glyph: string, words: string, action: () => unknown, key = '') => {
  const button = actionButton('', action), mark = node('span', 'field-button-icon'), label = words ? node('span', 'field-button-label', words) : null;
  mark.dataset.icon = glyph; mark.innerHTML = icon(glyph); button.append(mark, ...label ? [label] : [], ...key ? [node('kbd', '', key)] : []);
  return { button, label };
};

// A post is raised at a place of the shared field the player chooses there (territory.ts), from the Infraestrutura page
// (infrastructure-ux.ts): the place it would be follows the pointer over the field (`point`) and stands where the player
// points — a click, a tap — (`setX`), drawn as a post not begun is (render.ts `previewPost`), and in another colour while
// the field would refuse it. What refuses it is said by the same rules the field keeps (server/field-construction.ts
// `postSite`), with what the faction knows: as many posts as it may have, the place out of its territory or in another's,
// on ground never seen, too steep, by a structure, a post or a works of its own, too near its base or another post, or by a
// vein; the field has the last word once the place is confirmed, and a builder in automatic goes there and puts it up with
// material brought from the base. The view of the field stays the player's to move meanwhile. Its dock is that of a works
// (publication-placement.ts): what is raised and what it costs (`getQuote`, faction-ui.ts `postQuote`), the metre either way
// and the turn beside it, the orders in a row, and a line of where it stands or of what refuses it.
export class PostPlacement {
  declare readonly renderer: PostPlacementRenderer;
  declare readonly compile: PostPlacementOptions['compile'];
  declare readonly getQuote: PostPlacementOptions['getQuote'];
  declare readonly onConfirm: PostPlacementOptions['onConfirm'];
  declare readonly onCancel: PostPlacementOptions['onCancel'];
  declare current: { facing: -1 | 1; x: number | null } | null;
  declare busy: boolean; declare rejection: string; declare refusal: string; declare pointed: number | null;
  declare readonly works: Map<string, { minX: number; maxX: number }>;
  declare readonly element: HTMLDivElement; declare readonly dock: HTMLElement; declare readonly mode: HTMLElement; declare readonly name: HTMLElement; declare readonly costs: HTMLElement;
  declare readonly chips: { id: StockId; chip: HTMLElement; figure: HTMLElement }[];
  declare readonly left: HTMLButtonElement; declare readonly right: HTMLButtonElement; declare readonly turnButton: HTMLButtonElement;
  declare readonly confirm: HTMLButtonElement; declare readonly confirmLabel: HTMLElement | null; declare readonly back: HTMLButtonElement; declare readonly status: HTMLElement;
  constructor({ host, renderer, compile, getQuote, onConfirm, onCancel }: PostPlacementOptions) {
    this.renderer = renderer; this.compile = compile; this.getQuote = getQuote; this.onConfirm = onConfirm; this.onCancel = onCancel;
    this.current = null; this.busy = false; this.rejection = ''; this.refusal = ''; this.pointed = null;
    // The stretch of each works of the faction, by its name: a works never changes its project nor its place.
    this.works = new Map();
    this.element = node('div', 'publication-placement post-placement'); this.element.hidden = true;
    this.dock = node('section', 'publication-dock'); this.dock.setAttribute('aria-label', tr('Escolher o local do posto'));
    this.mode = node('span', 'field-mode'); this.name = node('strong');
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
    for (const [button, words] of [[this.left, tr('Mover o posto 1 m à esquerda')], [this.right, tr('Mover o posto 1 m à direita')], [this.turnButton, tr('Virar o posto para o outro lado')]] satisfies [HTMLButtonElement, string][]) {
      button.setAttribute('aria-label', words); button.title = words;
    }
    const tools = node('div', 'field-dock-actions'); tools.append(this.left, this.right, this.turnButton);
    ({ button: this.confirm, label: this.confirmLabel } = dockButton('i-flag', tr('Erguer posto'), () => this.submit(), 'Enter'));
    this.confirm.id = 'post-confirm';
    this.back = dockButton('i-close', tr('Cancelar'), () => this.cancel(), 'Esc').button;
    this.back.id = 'post-cancel'; this.back.title = 'Cancelar · Esc';
    const orders = node('div', 'squad-orders'); orders.setAttribute('role', 'group'); orders.setAttribute('aria-label', tr('Posto'));
    orders.append(this.confirm, this.back);
    this.status = node('p', 'field-dock-status'); this.status.id = 'post-status'; this.status.setAttribute('role', 'status');
    this.dock.append(heading, tools, orders, this.status);
    this.element.append(this.dock); host.append(this.element);
  }

  get active() { return Boolean(this.current); }
  get chosen(): boolean { return finite(this.current?.x); }
  // The post asked of the field: where it is to stand and how it is to face.
  get intent(): PostIntent | null { const current = this.current; return current && finite(current.x) ? { x: current.x, facing: current.facing } : null; }
  get pending() { return this.busy; }
  set pending(value: boolean) { this.busy = Boolean(value); this.render(); }

  // `x` is where the post stands until the player points (the middle of the view the field opens on).
  begin({ facing = 1, x = null }: { facing?: number; x?: number | null } = {}): boolean {
    if (this.pending || this.active) return false;
    this.current = { facing: facing === -1 ? -1 : 1, x: null }; this.rejection = ''; this.pointed = finite(x) ? x : null;
    this.element.hidden = false; this.render(); return true;
  }

  render() {
    if (!this.active) return;
    const intent = required(this.current), state = this.renderer.state, shared = Boolean(state?.shared), faction = state?.faction,
      x = this.chosen ? required(intent.x) : this.pointed, placed = shared && finite(x), base = faction?.base;
    this.refusal = placed ? this.refuse(required(x)) : '';
    this.renderer.previewPost(placed ? { x: required(x), facing: intent.facing, refused: Boolean(this.refusal) } : null);
    const quote = this.getQuote();
    this.element.dataset.pointChosen = String(this.chosen); this.element.dataset.refused = String(Boolean(this.refusal));
    write(this.mode, tr('NOVO POSTO')); write(this.name, POST_NAME); this.name.title = POST_NAME;
    // What the stocks lack is marked, and refuses nothing: the material is taken to the works as it comes.
    for (const { id, chip, figure } of this.chips) {
      const cost = quote?.costs?.find(cost => cost.id === id), look = cost?.short ? 'cost-chip short' : 'cost-chip',
        title = cost?.short ? tr`${tr(STOCKS[id])}: faltam ${required(cost.missing)} no estoque` : cost?.title ?? tr(STOCKS[id]);
      chip.hidden = !cost; write(figure, cost?.text ?? '');
      if (chip.className !== look) chip.className = look;
      if (chip.title !== title) chip.title = title;
    }
    this.costs.hidden = this.chips.every(({ chip }) => chip.hidden);
    this.left.disabled = this.right.disabled = this.pending || !shared || !this.chosen;
    this.turnButton.disabled = this.pending || !shared;
    // One line: what refuses the place or the post, or where it stands from the base — before a place is chosen, how to
    // choose one — and how long it takes to put up.
    const problem = this.rejection || (!shared ? tr('Aguarde uma atualização do campo.') : this.refusal || quote?.refused || ''),
      where = !this.chosen ? tr`${touching() ? tr('Toque') : tr('Clique')} no chão para escolher o local` :
        finite(base?.x) ? tr`a ${metres(Math.abs(required(x) - required(base).x))} ${way(required(x), required(base).x)} da base` : '',
      line = problem || [where, finite(quote?.seconds) ? `montagem ${count(required(quote).seconds)} s` : ''].filter(Boolean).join(' · ');
    write(this.status, line); this.status.title = line; this.status.dataset.problem = String(Boolean(problem));
    this.confirm.disabled = this.pending || !shared || !this.chosen || Boolean(this.refusal) || Boolean(quote?.refused);
    write(required(this.confirmLabel), this.pending ? 'Aguardando o campo…' : tr('Erguer posto'));
    this.confirm.title = !this.chosen ? tr('Escolha primeiro o ponto no campo.') : problem || tr('Erguer posto · Enter');
    this.back.disabled = this.pending;
  }

  // Why a post may not stand at `x`, as the page can tell it, by the rules the field keeps (`postSite`): the posts of the
  // faction — standing, but one being taken down, and being put up — first, then the ground it would serve as a structure's
  // (construction-site.ts) within the territory of the faction and in no other it is told of, and then where a post may stand,
  // off the veins of the ground: every site holds one, and the page finds the sites as the field does (deposits.ts).
  refuse(x: number): string {
    const state = required(this.renderer.state), faction = state.faction, ground = this.renderer.ground,
      end = (value: number | undefined, side: number): number => finite(value) ? (side < 0 ? Math.ceil(value + 20) : Math.floor(value - 20)) : side * Infinity,
      base = faction?.base?.x ?? null, standing = (faction?.posts ?? []).filter(post => !post.takedown).map(post => post.x),
      posts = [...standing, ...(faction?.works ?? []).filter(work => 'post' in work && work.post).map(work => work.x)];
    if (posts.length >= POST_LIMIT) return postRefusal({ x, posts });
    return siteRefusal({ span: postSpan(x), limits: { minX: end(ground.minX, -1), maxX: end(ground.maxX, 1) },
      explored: faction?.explored ?? null, own: faction ? territoryOf(base, standing) : null,
      foreign: (faction?.territory ?? []).filter(held => held.kind !== 'own').map(held => held.spans), home: base,
      ground, taken: takenGround(state, faction, null, (work: FactionView['works'][number]) => this.span(work)) }) ||
      postRefusal({ x, base, posts, sites: depositsNear(depositsOf(ground), x, POST_RADIUS + LOAD_REACH) });
  }
  // The stretch a works of the faction takes up, kept by its name.
  span(work: FactionView['works'][number]): { minX: number; maxX: number } {
    if (!this.works.has(work.id)) this.works.set(work.id, 'post' in work && work.post ? postSpan(work.x) : constructionSpan(this.compile(required('blueprint' in work ? work.blueprint : null)), work));
    return required(this.works.get(work.id));
  }

  // Where the pointer is over the field, in metres along it: the post follows it until a place is chosen.
  point(worldX: number): boolean {
    if (!this.active || this.chosen || this.pending || !finite(worldX) || Math.abs(worldX - (this.pointed ?? Infinity)) < .1) return false;
    this.pointed = worldX; this.render(); return true;
  }
  // The place chosen, in real coordinates of the field, to the tenth of a metre.
  setX(worldX: number): boolean {
    if (!this.active || this.pending || !this.renderer.state?.shared || !finite(worldX)) return false;
    const x = Math.round(worldX * 10) / 10;
    if (x === required(this.current).x && this.chosen) return false;
    required(this.current).x = x; this.rejection = ''; this.render(); return true;
  }
  nudge(by: number): boolean { return this.chosen && this.setX(required(required(this.current).x) + by); }
  turn() {
    if (!this.active || this.pending) return false;
    required(this.current).facing = required(this.current).facing === 1 ? -1 : 1; this.rejection = ''; this.render(); return true;
  }
  // The place asked of the field, by the button or by Enter: once, until the field answers.
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
    this.finish(); this.onCancel?.();
    return true;
  }
  reject(reason: unknown): boolean {
    if (!this.active) return false;
    this.rejection = String((reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined) || reason || tr('O campo recusou o local.'));
    this.pending = false; return true;
  }
  finish() {
    this.renderer.previewPost(null);
    this.current = null; this.busy = false; this.rejection = this.refusal = ''; this.pointed = null;
    this.element.hidden = true; this.works.clear();
  }
}
