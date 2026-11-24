import { tr, locale } from './i18n.ts';
import { CONSTRUCTION_TEMPLATES } from './construction-templates.ts';
import { createStructuredTemplate } from './structured-templates.ts';
import { constructionSVG } from './construction-preview.ts';
import { arsenalScale, weaponPreviewCanvas } from './weapon-paint.ts';
import { WEAPON_PRESETS, WEAPON_FAMILIES, AMMO, allowedAmmo, isWeaponPresetId, weaponOf } from './weapons.ts';
import { blueprintMass } from './mass-properties.ts';
import { constructionCost, weaponCost, ammunitionCost, formatCredits } from './construction-cost.ts';
import { DESIGN_VERSION, serializeBlueprint, validateDraftBlueprint, workshopDraft } from './persistence.ts';
import { projectRefusalMessage } from './project-refusal.ts';
import { designBill, billText, shortText } from './economy.ts';
import { number } from './format.ts';
import { ago } from './faction-ui.ts';
import { industryReasonFor } from './industry-ui.ts';
import { industrialAdmission } from './industry.ts';
import { compileDraft } from './structured-construction.ts';

import type { AuthoredConstruction } from './construction-contract.ts';
import type { DesignLibrary, LibraryEntry } from './library.ts';
import type { FactionView } from './field-contract.ts';
import type { SupplyBill } from './economy-contract.ts';
import type { WeaponFamilyId, WeaponId, WeaponPresetId } from './weapons.ts';
import type { LibraryAct, LibraryRequest, LibraryResultFor } from './field-protocol-contract.ts';

interface LibraryElements {
  '#garage': HTMLButtonElement; '#close-library': HTMLButtonElement; '#library-recover': HTMLButtonElement;
  '#library-dialog': HTMLDialogElement; '#library-search': HTMLInputElement; '#export': HTMLButtonElement;
  '#catalog-edit': HTMLButtonElement; '#catalog-test': HTMLButtonElement; '#close-arsenal': HTMLButtonElement;
  '#arsenal-dialog': HTMLDialogElement; '#arsenal-families': HTMLDivElement; '#library-grid': HTMLDivElement;
  '#library-summary': HTMLElement; '#arsenal-purpose': HTMLElement; '#arsenal-grid': HTMLDivElement;
}
const $ = <Key extends keyof LibraryElements>(selector: Key): LibraryElements[Key] => document.querySelector<LibraryElements[Key]>(selector)!;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const caughtMessage = (error: unknown): string | undefined => record(error) && typeof error.message === 'string' ? error.message : undefined;
type ShelfMetadata = FactionView['library'][number];
type ShelfModel = ShelfMetadata & { blueprint: unknown };
type WeaponAction = 'test' | 'install';
export interface LibraryCommand {
  <Act extends LibraryAct>(kind: 'library', data: Extract<LibraryRequest, { act: Act }>): Promise<LibraryResultFor<Act>>;
}
export interface ConstructionUIOptions {
  library: Pick<DesignLibrary, 'entries' | 'error' | 'sync' | 'has' | 'duplicate' | 'rename' | 'remove'>;
  stopControls(): unknown; onRecover(): unknown; getBlueprint(): AuthoredConstruction; getProjectId(): string | null;
  getPlayerId(): string | null | undefined; getTime(): number; getFaction?(): FactionView | null | undefined;
  onIndustry?(): unknown;
  getStock?(): SupplyBill | null | undefined; getTrialWeapon?(): WeaponId | 'custom' | null | undefined;
  onOpen(blueprint: unknown, id: string | null): unknown; onRename(id: string, name: string): unknown;
  onLibraryChange(): unknown; onRemove?(id: string): unknown; onInstall(id: WeaponPresetId): unknown;
  onTrialWeapon(id: WeaponPresetId): unknown; toast(text: string | undefined, problem?: boolean): unknown;
  confirm(title: string, text: string, action: string): boolean | Promise<boolean>; command: LibraryCommand;
}
import { node as el, actionButton as button } from './dom-view.ts';

export function constructionCardData(source: unknown) {
  if (!record(source) || source.version !== DESIGN_VERSION || source.derived) throw new Error(tr('A garagem não abre esse projeto: ele não é desta versão do jogo.'));
  const { construction, compiled: geometry } = compileDraft(source);
  return { svg: constructionSVG(geometry), massKg: blueprintMass(geometry), cost: constructionCost(geometry), bill: designBill(geometry), industry: industrialAdmission(construction, geometry) };
}
// What the card of a project of the garage shows (`data`), or why it does not open (`refusal`, in the words of a file
// that is refused): found once for each version of the project, by the check that opening it makes, whose one compile
// also draws, weighs and prices it. A garage of many projects is drawn again, or searched, without doing it again.
type CardData = ReturnType<typeof constructionCardData>;
type GarageCard = { data: CardData; refusal?: never } | { data?: never; refusal: string };
type CatalogEntry = { kind: 'template'; entry: typeof CONSTRUCTION_TEMPLATES[number] } | { kind: 'faction'; entry: ShelfModel } | { kind: 'saved'; entry: LibraryEntry };
type ListedEntry = CatalogEntry & { b: unknown; data: CardData | undefined; refusal: string | undefined; industry: string; short: string };
const CARDS = new Map<string, { text: string | undefined; card: GarageCard }>();
export function garageCard({ id, blueprint }: Pick<LibraryEntry, 'id' | 'blueprint'>): GarageCard {
  const text = JSON.stringify(blueprint), known = CARDS.get(id);
  if (known && known.text === text) return known.card;
  let card: GarageCard;
  try { card = { data: constructionCardData(workshopDraft(validateDraftBlueprint(blueprint))) }; }
  catch (error) {
    // What is not a refusal of the project is a slip of the code, for the console.
    if (!record(error) || typeof error.reason !== 'string' && !error.code) console.error(error);
    card = { refusal: projectRefusalMessage(error, blueprint) };
  }
  CARDS.set(id, { text, card });
  return card;
}
// A project the core refuses may have no name of its own.
const projectName = (project: unknown): string => record(project) && typeof project.name === 'string' && project.name.trim() ? project.name : tr('Sem nome');
// The library of the faction as the faction is told it: by its projects and when each was published, or nothing off the field.
const shelfKey = (faction: FactionView | null | undefined): string => faction ? JSON.stringify([faction.id, faction.library]) : '';
const garageKey = (faction: FactionView | null | undefined): string => JSON.stringify([shelfKey(faction), faction?.industry?.levels]);
// What the garage says of the library of the faction: how many projects it shows, and how many more it is waiting for.
const shelfSummary = (count: number, missing: number): string => !missing ? tr`${count} ${count === 1 ? tr('projeto') : tr('projetos')} da facção` :
  count ? tr`${count} de ${count + missing} projetos da facção · carregando o resto…` : tr('Carregando a biblioteca da facção…');

// The garage: the player's projects, kept in the browser (`library`), the ready models and, on the shared field, the library
// of the faction (`Da facção`): the projects its members published there, those the page does not have asked of the field
// when the faction is told the library changed, each opened as a copy. `getFaction` is the faction on the field, or
// nothing; `command` asks the field.
export class ConstructionUI {
  declare options: ConstructionUIOptions;
  declare tab: string | undefined; declare pendingAction: '' | WeaponAction; declare actionError: string | undefined;
  declare arsenalActions: [HTMLButtonElement, WeaponAction, WeaponPresetId][];
  declare kept: Map<string, { at: number; blueprint: unknown }>; declare asking: Map<string, number>; declare shelved: string; declare shown: string;
  declare family: string; declare familyTabs: [WeaponFamilyId, HTMLButtonElement][];
  constructor(options: ConstructionUIOptions) {
    this.options = options; this.tab = 'saved'; this.pendingAction = ''; this.actionError = ''; this.arsenalActions = [];
    // The projects of the library of the faction the page has, by name, each as it was published when it was fetched
    // (`kept`), and those asked of the field that have not come yet, each by when it was published (`asking`); the
    // library they were last asked for (`shelved`), and the library the garage last showed.
    this.kept = new Map(); this.asking = new Map(); this.shelved = ''; this.shown = '';
    $('#garage').onclick = () => this.openLibrary('saved');
    $('#close-library').onclick = () => $('#library-dialog').close();
    $('#library-recover').onclick = () => this.options.onRecover();
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-library-tab]')) b.onclick = () => { this.tab = b.dataset.libraryTab; this.refreshLibrary(); };
    $('#library-search').oninput = () => this.refreshLibrary();
    $('#export').onclick = () => this.exportProject(this.options.getBlueprint());
    $('#catalog-edit').onclick = $('#catalog-test').onclick = () => this.openArsenal();
    $('#close-arsenal').onclick = () => { if (!this.pendingAction) $('#arsenal-dialog').close(); };
    $('#arsenal-dialog').addEventListener('cancel', event => { if (this.pendingAction) event.preventDefault(); });
    // The arsenal shows one family at a time, a tab for each: the one last seen, or the one of the weapon replaced.
    this.family = WEAPON_FAMILIES[0]![0];
    this.familyTabs = WEAPON_FAMILIES.map(([id, name]) => {
      const tab = button(tr(name), () => this.showFamily(id)); tab.setAttribute('role', 'tab');
      tab.id = 'arsenal-family-' + id; tab.setAttribute('aria-controls', 'arsenal-grid');
      tab.addEventListener('keydown', event => {
        const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined, index = this.familyTabs.findIndex(([family]) => family === id),
          next = event.key === 'Home' ? 0 : event.key === 'End' ? this.familyTabs.length - 1 : step ? (index + step + this.familyTabs.length) % this.familyTabs.length : null;
        if (next === null) return;
        event.preventDefault(); event.stopPropagation();
        if (!this.pendingAction) this.showFamily(this.familyTabs[next]![0], { focus: true });
      });
      return [id, tab];
    });
    $('#arsenal-families').replaceChildren(...this.familyTabs.map(([, tab]) => tab));
    for (const d of [$('#library-dialog'), $('#arsenal-dialog')]) d.addEventListener('click', e => {
      if (e.target === d && !(d === $('#arsenal-dialog') && this.pendingAction)) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); }
    });
  }
  openLibrary(tab = 'saved') {
    this.options.stopControls(); this.tab = tab; $('#library-search').value = '';
    this.refreshLibrary(); $('#library-dialog').showModal();
  }
  async openDesign(blueprint: unknown, id: string | null = null) {
    try { if (await this.options.onOpen(blueprint, id) !== false) $('#library-dialog').close(); }
    catch (error) { this.options.toast(caughtMessage(error), true); }
  }
  // The library of the faction changed while the garage shows it, or the faction is another: shown again.
  watchShelf() { if ($('#library-dialog').open && garageKey(this.options.getFaction?.()) !== this.shown) this.refreshLibrary(); }
  // Of each library the faction is told of, the page asks the field only for the projects it does not have as published
  // then — new ones, and ones published again since — and has not asked for already, and forgets those the library no
  // longer has.
  shelf(faction: FactionView) {
    const key = shelfKey(faction);
    if (key === this.shelved) return;
    this.shelved = key;
    const listed = new Map(faction.library.map(({ id, at }) => [id, at]));
    for (const id of this.kept.keys()) if (!listed.has(id)) this.kept.delete(id);
    const ids = [...listed].filter(([id, at]) => this.kept.get(id)?.at !== at && this.asking.get(id) !== at).map(([id]) => id);
    if (!ids.length) return;
    for (const id of ids) this.asking.set(id, listed.get(id)!);
    const answered = () => { for (const id of ids) if (this.asking.get(id) === listed.get(id)) this.asking.delete(id); };
    this.options.command('library', { act: 'get', ids }).then(({ models }) => {
      answered();
      // What comes is kept while the library the faction is told of now has it.
      const now = new Set(this.options.getFaction?.()?.library.map(model => model.id));
      for (const model of models) if (now.has(model.id)) this.kept.set(model.id, { at: model.at, blueprint: model.blueprint });
      if ($('#library-dialog').open && this.tab === 'faction') this.refreshLibrary();
    }, (error: unknown) => { answered(); this.shelved = ''; this.options.toast(caughtMessage(error), true); });
  }
  // The projects of the library of the faction the garage shows: of those the faction is told of, the ones the page has as
  // published then, and how many it does not have yet.
  shelfView(faction: FactionView | null | undefined) {
    const models: ShelfModel[] = [];
    for (const metadata of faction?.library ?? []) {
      const model = this.kept.get(metadata.id);
      if (model?.at === metadata.at) models.push({ ...metadata, blueprint: model.blueprint });
    }
    return { models, missing: (faction?.library.length ?? 0) - models.length };
  }
  refreshLibrary() {
    try { this.options.library.sync(); } catch (error) { this.options.toast(caughtMessage(error), true); }
    const library = this.options.library, faction = this.options.getFaction?.();
    this.shown = garageKey(faction);
    // The tab of the faction is there only on the shared field.
    const shelfTab = document.querySelector<HTMLButtonElement>('[data-library-tab="faction"]')!;
    shelfTab.hidden = !faction;
    if (!faction && this.tab === 'faction') this.tab = 'saved';
    if (this.tab === 'faction') this.shelf(faction!);
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-library-tab]')) { const active = b.dataset.libraryTab === this.tab; b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); }
    const q = $('#library-search').value.trim().toLocaleLowerCase(locale());
    const grid = $('#library-grid'); grid.replaceChildren();
    const matches = (name: string, tags = '') => `${name} ${tags}`.toLocaleLowerCase(locale()).includes(q);
    const template = this.tab === 'templates', shelved = this.tab === 'faction', all = template || shelved ? null : library.entries,
      { models, missing } = this.shelfView(faction);
    const entries: CatalogEntry[] = template ? CONSTRUCTION_TEMPLATES.filter(t => matches(tr(t.name), t.tags) || matches(t.name, t.tags)).map(entry => ({ kind: 'template', entry })) :
      shelved ? models.filter(m => matches(m.name, m.by)).map(entry => ({ kind: 'faction', entry })) :
        all!.filter(e => matches(projectName(e.blueprint))).map(entry => ({ kind: 'saved', entry }));
    $('#library-summary').textContent = template ? tr`${entries.length} ${entries.length === 1 ? tr('modelo') : tr('modelos')}` :
      shelved ? shelfSummary(models.length, missing) :
      tr`${all!.length} ${all!.length === 1 ? tr('construção') : tr('construções')} na garagem`;
    // On the shared field a construction is paid from the stocks of the faction: a card says its bill in them and what
    // they are short of, and the models the faction can pay come before the others. Away from it a card says its price.
    const stock = this.options.getStock?.() ?? null, listed: ListedEntry[] = entries.map(item => {
      const b = item.kind === 'template' ? createStructuredTemplate(item.entry.id) : item.entry.blueprint,
        { data, refusal }: GarageCard = item.kind === 'template' ? { data: constructionCardData(b) } : garageCard(item.entry);
      return { ...item, b, data, refusal, industry: data ? industryReasonFor(data.industry, faction) : '', short: stock && data ? shortText(stock, data.bill) : '' };
    });
    // What the garage and the library of the faction no longer have is forgotten.
    for (const id of CARDS.keys()) if (!library.has(id) && !this.kept.has(id)) CARDS.delete(id);
    // Who removes a project of the library of the faction: whoever published it, its leader and its administrators.
    const role = faction?.members.find(m => m.id === this.options.getPlayerId())?.role, removes = (model: ShelfMetadata) => model.author === this.options.getPlayerId() || role !== 'member';
    const order = (a: ListedEntry, b: ListedEntry): number => a.kind === 'template' ? Number(Boolean(a.industry)) - Number(Boolean(b.industry)) || Number(Boolean(a.short)) - Number(Boolean(b.short)) :
      a.kind === 'faction' && b.kind === 'faction' ? b.entry.at - a.entry.at : a.kind === 'saved' && b.kind === 'saved' ? b.entry.updatedAt.localeCompare(a.entry.updatedAt) : 0;
    for (const { kind, entry, b, data, refusal, industry, short } of listed.sort(order)) {
      const card = el('article', 'design-card'), preview = el('div', 'design-preview');
      if (data) preview.innerHTML = data.svg;
      // A model says what it is in its tags, and more to whoever points at it.
      if (kind === 'template') { card.setAttribute('data-template', entry.id); card.title = entry.description; }
      const info = el('div', 'design-info'), heading = kind !== 'saved' || refusal ? el('h3', '', kind === 'template' ? tr(CONSTRUCTION_TEMPLATES.find(t => t.id === entry.id)!.name) : projectName(b)) : this.nameField(entry),
        open = !template && !shelved && entry.id === this.options.getProjectId();
      if (open) info.append(el('small', 'card-category', tr('EM EDIÇÃO')));
      if (refusal) {
        // A project the core refuses is shown faded, with why: it is exported to be put right by hand and imported again,
        // or removed. Its name is part of the project, and is not changed in a project the garage could not write.
        const why = el('p', 'design-refusal', refusal); why.title = refusal;
        card.setAttribute('data-refused', ''); info.append(el('small', 'card-category card-refused', tr('NÃO ABRE')), heading, why);
      } else {
        info.append(heading, el('p', '', `${number(data!.massKg / 1000)} t`));
        info.append(el('p', 'design-cost', stock ? billText(data!.bill) : formatCredits(data!.cost.total)));
        if (short) info.append(el('p', 'design-short', short));
        if (industry) { info.append(el('p', 'design-short', industry)); if (this.options.onIndustry) info.append(button(tr('Ver melhorias da base'), () => { $('#library-dialog').close(); this.options.onIndustry?.(); })); }
      }
      info.append(el('span', 'card-meta', kind === 'template' ? entry.tags : kind === 'faction' ? `${entry.by} · ${ago(entry.at, this.options.getTime())}` :
        tr`Atualizado em ${new Date(entry.updatedAt).toLocaleDateString(locale())}`));
      const actions = el('div', 'card-actions');
      if (kind === 'template') actions.append(button(tr('Construir'), () => this.openDesign(b), 'card-primary'));
      else if (kind === 'faction') {
        // A project of the faction opens as a copy, a project of the player's own from then on.
        if (!refusal) actions.append(button(tr('Abrir cópia'), () => this.openDesign(b), 'card-primary'));
        if (removes(entry)) actions.append(this.removeButton(tr('Remover da biblioteca da facção'), () => this.unshelve(entry)));
      } else {
        if (refusal) actions.append(button(tr('Exportar'), () => this.exportProject(b, JSON.stringify(b, null, 2))));
        else {
          actions.append(button(tr('Abrir'), () => this.openDesign(b, entry.id), 'card-primary'));
          actions.append(button(tr('Duplicar'), () => this.mutate(() => {
            const copy = library.duplicate(entry.id); this.openDesign(copy.blueprint, copy.id);
          })));
          if (faction) actions.append(button(tr('Publicar na facção'), () => this.publish(b)));
        }
        actions.append(this.removeButton(tr('Remover da garagem'), () => this.remove(entry)));
      }
      info.append(actions); card.append(preview, info); grid.append(card);
    }
    if (!entries.length && (!shelved || !missing)) {
      const empty = el('div', 'catalog-empty'); empty.append(el('h3', '', q ? tr('Nenhum resultado') : shelved ? tr('Nenhum projeto da facção') : tr('Garagem vazia')));
      if (!q && shelved) empty.append(el('p', '', tr('Publique um projeto seu com “Publicar na facção”, em Minhas construções.')));
      if (!q && this.tab === 'saved') empty.append(button(tr('Escolher um modelo'), () => { this.tab = 'templates'; this.refreshLibrary(); }, 'card-primary'));
      grid.append(empty);
    }
    if (library.error) Reflect.set($('#library-summary'), 'textContent', caughtMessage(library.error));
  }
  // The card and the open editor share a project name. A name left empty is not taken.
  nameField(entry: LibraryEntry) {
    const title = el('label', 'design-title'), field = el('input', 'design-name'), pen = el('i'), name = record(entry.blueprint) ? entry.blueprint.name : undefined;
    title.title = tr('Renomear'); field.maxLength = 80; Reflect.set(field, 'value', name); field.setAttribute('aria-label', tr('Nome da construção'));
    pen.innerHTML = '<svg aria-hidden="true"><use href="#i-edit"/></svg>'; title.append(field, pen);
    field.onkeydown = event => { if (event.key === 'Enter') field.blur(); else if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); Reflect.set(field, 'value', name); field.blur(); } };
    field.onchange = () => {
      const name = field.value.trim();
      if (!name || name === (record(entry.blueprint) ? entry.blueprint.name : undefined)) { Reflect.set(field, 'value', record(entry.blueprint) ? entry.blueprint.name : undefined); return; }
      this.mutate(() => {
        if (entry.id === this.options.getProjectId()) this.options.onRename(entry.id, name);
        else { this.options.library.rename(entry.id, name); this.options.onRename(entry.id, name); }
      });
    };
    return title;
  }
  // What takes a project out of where it is kept stands apart at the end of its card.
  removeButton(words: string, act: () => unknown) {
    const remove = button('', act, 'card-remove');
    remove.innerHTML = '<svg aria-hidden="true"><use href="#i-trash"/></svg>'; remove.title = words; remove.setAttribute('aria-label', words);
    return remove;
  }
  // A project of the garage goes to the library of the faction as the field would build it: one of a name the player
  // published before takes its place.
  async publish(blueprint: unknown) {
    try {
      const { model } = await this.options.command('library', { act: 'publish', blueprint: workshopDraft(blueprint) });
      this.options.toast(tr`“${model.name}” ${model.replaced ? tr('atualizado') : tr('publicado')} na biblioteca da facção.`);
    } catch (error) { this.options.toast(caughtMessage(error), true); }
  }
  // Removing from the library of the faction is for every member, and for good; copies opened stay in the workshop.
  async unshelve(model: ShelfMetadata) {
    if (!await this.options.confirm(tr`Remover “${model.name}” da biblioteca da facção?`, tr('Os membros deixam de vê-lo. As cópias já abertas continuam.'), tr('Remover'))) return;
    try { await this.options.command('library', { act: 'remove', id: model.id }); this.options.toast(tr('Projeto removido da biblioteca da facção.')); }
    catch (error) { this.options.toast(caughtMessage(error), true); this.shelved = ''; this.refreshLibrary(); }
  }
  mutate(action: () => unknown) { try { action(); this.refreshLibrary(); this.options.onLibraryChange(); } catch (error) { this.options.toast(caughtMessage(error), true); } }
  // A project is given as a file named after it: the open one as the core writes it (`text` left out), one the game no
  // longer opens as it is kept.
  exportProject(project: unknown, text: string | null = null) {
    try {
      const url = URL.createObjectURL(new Blob([text ?? serializeBlueprint(project)], { type: 'application/json' })), link = document.createElement('a'),
        name = record(project) && typeof project.name === 'string' ? project.name : '';
      link.href = url; link.download = (name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projeto-impacto') + '.json';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.options.toast(tr('Projeto exportado.'));
    } catch (error) { this.options.toast(caughtMessage(error), true); }
  }
  // Removing is for good. An open project is replaced only after its removal was persisted.
  async remove(entry: LibraryEntry) {
    const open = entry.id === this.options.getProjectId();
    if (!await this.options.confirm(tr`Remover “${projectName(entry.blueprint)}” da garagem?`, tr('Não dá para desfazer.') +
      (open ? tr(' A Oficina abre outro projeto.') : ''), tr('Remover'))) return;
    try {
      this.options.library.remove(entry.id);
      try { await this.options.onRemove?.(entry.id); }
      finally { this.refreshLibrary(); this.options.onLibraryChange(); }
    } catch (error) { this.options.toast(caughtMessage(error), true); }
  }
  openArsenal() {
    if (this.pendingAction) return;
    const dialog = $('#arsenal-dialog'), trial = this.options.getTrialWeapon?.(),
      asked = trial ? weaponOf(trial)?.family : dialog.dataset?.family;
    if (asked) this.family = asked;
    delete dialog.dataset.family;
    dialog.returnValue = ''; this.actionError = '';
    this.options.stopControls(); this.refreshArsenal(); dialog.showModal();
  }
  showFamily(id: string, { focus = false } = {}) {
    if (this.pendingAction) return;
    this.family = id; this.actionError = ''; this.refreshArsenal();
    if (focus) {
      const tab = this.familyTabs.find(([family]) => family === id)![1];
      tab.focus({ preventScroll: true }); tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }
  // In the workshop a weapon is installed; in the armour test, it only becomes the gun the design is struck with ('test').
  describeArsenal() {
    const context = $('#arsenal-dialog').dataset ?? {}, busy = Boolean(this.pendingAction), trial = this.options.getTrialWeapon?.(),
      install = context.swap ? tr('Trocar por esta') : context.mount ? tr('Instalar nesta chapa') : tr('Instalar');
    const purpose = $('#arsenal-purpose'), said = this.actionError || (this.pendingAction === 'test' ? tr('Trocando a arma do ensaio…') :
      this.pendingAction ? tr('Aplicando a arma ao projeto…') : '');
    purpose.setAttribute('role', this.actionError ? 'alert' : 'status'); purpose.textContent = said; purpose.hidden = !said;
    $('#close-arsenal').disabled = busy;
    for (const [, tab] of this.familyTabs) tab.disabled = busy;
    for (const [action, kind, id] of this.arsenalActions) {
      const current = trial ? kind === 'test' && trial === id : kind === 'install' && context.swap && context.currentPreset === id;
      action.hidden = Boolean(trial) !== (kind === 'test');
      action.textContent = kind === 'test' ? current ? tr('Em uso no ensaio') : tr('Usar no ensaio') : current ? tr('Já instalada') : install;
      action.disabled = busy || Boolean(current) || action.hidden;
    }
  }
  async chooseWeapon(id: WeaponPresetId, kind: WeaponAction) {
    if (this.pendingAction) return;
    const trial = this.options.getTrialWeapon?.();
    if (trial ? kind !== 'test' || trial === id : kind === 'test') { this.describeArsenal(); return; }
    this.pendingAction = kind; this.actionError = ''; this.describeArsenal();
    try {
      await this.options[kind === 'test' ? 'onTrialWeapon' : 'onInstall'](id);
      $('#arsenal-dialog').close(kind);
    } catch (error) { this.actionError = caughtMessage(error); this.options.toast(caughtMessage(error), true); }
    finally { this.pendingAction = ''; this.describeArsenal(); }
  }
  refreshArsenal() {
    const trial = this.options.getTrialWeapon?.();
    for (const [id, tab] of this.familyTabs) {
      const active = id === this.family; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    const grid = $('#arsenal-grid'); grid.replaceChildren();
    grid.setAttribute('role', 'tabpanel'); grid.setAttribute('aria-labelledby', 'arsenal-family-' + this.family); this.arsenalActions = [];
    const models = Object.keys(WEAPON_PRESETS).filter(isWeaponPresetId).map(id => [id, WEAPON_PRESETS[id]] satisfies [WeaponPresetId, typeof WEAPON_PRESETS[WeaponPresetId]])
      .filter(([, model]) => model.family === this.family).sort(([, a], [, b]) => a.caliberMm - b.caliberMm);
    // The guns of a tab are drawn at one scale, the longest across its whole picture, so their sizes compare at a glance.
    const { shares } = arsenalScale(models.map(([id]) => id));
    for (const [index, [id, model]] of models.entries()) {
      const card = el('article', 'weapon-card'), visual = el('div', 'weapon-card-visual'), picture = weaponPreviewCanvas(id, null, { width: 520 * shares[index]! });
      picture.style.width = `${(shares[index]! * 100).toFixed(2)}%`; visual.append(picture);
      const title = el('h3', '', tr(WEAPON_PRESETS[id].name)), spec = el('div', 'weapon-card-specs');
      // The calibre is in the name of the gun.
      spec.append(el('span', '', tr`${number(model.rate, 0)} tiros/min`), el('span', '', allowedAmmo(id).map(a => tr(AMMO[a].short)).join(' / ')));
      const actions = el('div', 'card-actions'), kind = trial ? 'test' : 'install', choice = button('', () => this.chooseWeapon(id, kind), 'card-primary');
      this.arsenalActions.push([choice, kind, id]); actions.append(choice);
      const price = el('p', 'weapon-price', formatCredits(weaponCost(id)));
      const rounds = allowedAmmo(id).map(ammo => ammunitionCost(id, ammo)), least = Math.min(...rounds), most = Math.max(...rounds);
      price.append(el('small', 'cost-note', tr`${least === most ? formatCredits(least, 2) : tr`${formatCredits(least, 2)} a ${formatCredits(most, 2)}`} / tiro`));
      const text = el('div', 'weapon-card-text'), foot = el('div', 'weapon-card-foot');
      card.setAttribute('data-preset', id);
      if (trial === id) { card.setAttribute('aria-current', 'true'); text.append(el('small', 'card-category', tr('Em uso no ensaio'))); }
      text.append(title, el('p', '', tr(WEAPON_PRESETS[id].label)), spec); foot.append(price, actions);
      card.append(visual, text, foot); grid.append(card);
    }
    this.describeArsenal();
  }
  
}
