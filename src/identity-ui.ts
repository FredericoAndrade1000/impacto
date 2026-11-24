import type { FlagChoice, CustomFlag, FlagField, FlagEmblem } from './flag.ts';
import type { FactionIdentity } from './faction-ui.ts';
export interface IdentityFaction extends FactionIdentity { readonly id: string; readonly flag: FlagChoice }
export interface IdentityOptions {
  readonly getFaction: () => IdentityFaction | null | undefined; readonly getName: () => string | null | undefined;
  readonly stopControls: () => void; readonly onRename: (name: string) => Promise<unknown>;
  readonly onSave: (data: { nation: string; flag: FlagChoice }, renamed: boolean) => Promise<unknown>;
}
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing identity control'); return value; };
const isHtml = (element: Element): element is HTMLElement => 'dataset' in element;
import { tr, locale } from './i18n.ts';
import { FLAG_COLOURS, FLAG_FIELDS, FLAG_EMBLEMS, NATION_NAME, COUNTRIES, HISTORIC, countryFlag, defaultFlag, flagMarkup } from './flag.ts';
import { factionName } from './faction-ui.ts';
import { node as el } from './dom-view.ts';
import { hex } from './format.ts';

function $(id: 'identity-dialog'): HTMLDialogElement;
function $(id: 'identity-player' | 'identity-name' | 'identity-search'): HTMLInputElement;
function $(id: string): HTMLElement;
function $(id: string): HTMLElement { return required(document.getElementById(id)); }
// What each of the three colours of a flag is for.
const COLOUR_ROLES = [tr('Fundo'), tr('Segunda cor'), tr('Terceira cor e emblema')];
// A name as a search reads it: without case or accents.
const plain = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const REGIONS = new Intl.DisplayNames([locale()], { type: 'region' });
// A flag of a country by its name: one of today by its name in the language of the page, one of another time with the
// years it was flown — and found by what else it is called too.
function country(code: string): { code: string; name: string; title: string; sought: string } {
  if (!Object.hasOwn(HISTORIC, code)) { const name = required(REGIONS.of(code.toUpperCase())); return { code, name, title: name, sought: plain(name) }; }
  const entry = required(Object.entries(HISTORIC).find(([id]) => id === code)?.[1]);
  const { name, years } = entry, also = 'also' in entry ? entry.also : '';
  return { code, name, title: `${name} (${years})`, sought: plain(`${name} ${also} ${years}`) };
}

// The flag and the name of the player's faction: shown on a button over the field, and chosen in the dialog it opens —
// the name written; the flag made, by its field, each of its three colours and its emblem, with every choice shown
// as the flag it would make, or taken from the countries of the world, of today or of another time, found by name.
// The dialog has the player's own name too, a line above, which goes to the field only when it was changed (`onRename`).
// Nothing is the faction's until it is saved, and what the field refuses is said in the dialog, which stays open.
export class IdentityUI {
  declare readonly options: IdentityOptions;
  declare made: CustomFlag | null;
  declare country: string | null;
  declare kind: 'made' | 'country' | 'historic';
  declare shown: string;
  declare suggested: string;
  constructor(options: IdentityOptions) {
    this.options = options; this.made = null; this.country = null; this.kind = 'made'; this.shown = ''; this.suggested = '';
    $('faction-identity').onclick = () => this.open();
    $('close-identity').onclick = $('identity-cancel').onclick = () => $('identity-dialog').close();
    $('identity-save').onclick = () => this.save();
    $('identity-name').maxLength = NATION_NAME.max;
    for (const written of [$('identity-player'), $('identity-name')]) {
      written.onkeydown = event => { if (event.key === 'Enter') this.save(); };
      written.oninput = () => this.refused('');
    }
    $('identity-made').onclick = () => { this.kind = 'made'; this.render(); };
    $('identity-country').onclick = () => { this.kind = 'country'; this.render(); };
    $('identity-historic').onclick = () => { this.kind = 'historic'; this.render(); };
    $('identity-search').oninput = () => this.find();
  }
  // The button, as the faction is now: its flag and its name.
  show(faction: IdentityFaction | null | undefined): void {
    if (!faction) return;
    const flag = JSON.stringify(faction.flag), name = factionName(faction), title = name + tr(' · mudar o nome e a bandeira');
    if (this.shown !== flag) { this.shown = flag; $('faction-flag').innerHTML = flagMarkup(faction.flag); }
    if ($('faction-name').textContent !== name) $('faction-name').textContent = name;
    if ($('faction-identity').title !== title) { $('faction-identity').title = title; $('faction-identity').setAttribute('aria-label', title); }
  }
  // The flag as the dialog has it: that of the country picked, or the one being made.
  get flag(): FlagChoice | null { return this.kind !== 'made' && this.country ? { country: this.country } : this.made; }
  open(): void {
    const faction = this.options.getFaction();
    if (!faction) return;
    this.options.stopControls();
    // A faction under a country's flag that turns to making one starts from the flag its place on the field gives it.
    this.country = faction.flag.country ?? null;
    this.kind = !this.country ? 'made' : Object.hasOwn(HISTORIC, this.country) ? 'historic' : 'country';
    this.made = 'country' in faction.flag && typeof faction.flag.country === 'string' ? defaultFlag(faction.id) : structuredClone(required('field' in faction.flag && faction.flag.field ? faction.flag : null));
    $('identity-player').value = this.options.getName() ?? '';
    $('identity-name').value = faction.nation ?? ''; $('identity-name').placeholder = factionName({ name: faction.name });
    $('identity-search').value = ''; this.suggested = '';
    this.refused(''); this.render(); $('identity-dialog').showModal();
  }
  // Why the field refused what was saved, said beside the buttons, where the dialog is scrolled to: the name may be far above.
  refused(why: string): void {
    $('identity-error').textContent = why; $('identity-error').hidden = !why;
    if (why) $('identity-error').scrollIntoView?.({ block: 'nearest' });
  }
  // A choice is a button that shows the flag as it would be with it.
  choice(change: Partial<Pick<CustomFlag, 'field' | 'emblem'>>, title: string, chosen: boolean): HTMLButtonElement {
    const button = el('button', 'identity-choice'); button.type = 'button'; button.title = title;
    button.setAttribute('aria-label', title); button.setAttribute('aria-pressed', String(chosen)); button.innerHTML = flagMarkup({ ...required(this.made), ...change });
    button.onclick = () => { Object.assign(required(this.made), change); this.render(); };
    return button;
  }
  // The countries of the tab, by name — those of today, or those of other times —: laid out when the tab is turned to,
  // and still sought as the search says. Their pictures are fetched as they come into view.
  countries(): void {
    const grid = $('identity-countries');
    if (grid.dataset.kind === this.kind) return;
    grid.dataset.kind = this.kind;
    const named = (this.kind === 'historic' ? Object.keys(HISTORIC) : COUNTRIES).map(country);
    grid.replaceChildren(...named.sort((a, b) => a.title.localeCompare(b.title, locale())).map(({ code, name, title, sought }) => {
      const button = el('button', 'identity-choice'), picture = el('img', 'banner country');
      button.type = 'button'; button.title = title; button.dataset.country = code; button.dataset.name = sought; button.setAttribute('aria-label', title);
      picture.loading = 'lazy'; picture.alt = ''; picture.src = countryFlag(code); button.append(picture);
      button.onclick = () => this.pick(code, name);
      return button;
    }));
    this.find();
  }
  // A country picked gives the nation its name too, while the name is nobody's choice yet and the country's fits.
  pick(code: string, name: string): void {
    const written = $('identity-name');
    if ((!written.value.trim() || written.value === this.suggested) && [...name].length <= NATION_NAME.max) written.value = this.suggested = name;
    this.country = code; this.refused(''); this.render();
  }
  find(): void {
    const sought = plain($('identity-search').value.trim());
    for (const button of $('identity-countries').children) if (isHtml(button)) button.hidden = !required(button.dataset.name).includes(sought);
  }
  render(): void {
    const made = required(this.made), atlas = this.kind !== 'made';
    $('identity-preview').innerHTML = flagMarkup(required(this.flag));
    for (const kind of ['made', 'country', 'historic']) $('identity-' + kind).setAttribute('aria-selected', String(this.kind === kind));
    $('identity-maker').hidden = atlas; $('identity-atlas').hidden = !atlas;
    if (atlas) {
      this.countries();
      for (const button of $('identity-countries').children) if (isHtml(button)) button.setAttribute('aria-pressed', String(button.dataset.country === this.country));
      $('identity-picked').textContent = this.country ? country(this.country).title : tr('Nenhuma bandeira escolhida');
      return;
    }
    $('identity-fields').replaceChildren(...Object.entries(FLAG_FIELDS).map(([id, name]) => this.choice({ field: required(Object.keys(FLAG_FIELDS).find((field): field is FlagField => field === id && Object.hasOwn(FLAG_FIELDS, field))) }, name, made.field === id)));
    $('identity-emblems').replaceChildren(...Object.entries(FLAG_EMBLEMS).map(([id, name]) => this.choice({ emblem: required(Object.keys(FLAG_EMBLEMS).find((emblem): emblem is FlagEmblem => emblem === id && Object.hasOwn(FLAG_EMBLEMS, emblem))) }, name, made.emblem === id)));
    $('identity-colours').replaceChildren(...COLOUR_ROLES.map((role, place) => {
      const row = el('div', 'identity-colour'), swatches = el('div', 'identity-swatches');
      swatches.setAttribute('role', 'group'); swatches.setAttribute('aria-label', role);
      swatches.append(...FLAG_COLOURS.map((colour, index) => {
        const swatch = el('button', 'identity-swatch'); swatch.type = 'button'; swatch.title = colour.name; swatch.style.background = hex(colour.value);
        swatch.setAttribute('aria-label', `${role}: ${colour.name}`); swatch.setAttribute('aria-pressed', String(made.colours[place] === index));
        swatch.onclick = () => { made.colours[place] = index; this.render(); };
        return swatch;
      }));
      row.append(el('span', 'identity-role', role), swatches);
      return row;
    }));
  }
  // The player's name first, when it was changed: a name the field refuses leaves the faction as it was.
  async save(): Promise<void> {
    try {
      const name = $('identity-player').value, renamed = name.trim() !== this.options.getName();
      if (renamed) await this.options.onRename(name);
      await this.options.onSave({ nation: $('identity-name').value, flag: required(this.flag) }, renamed);
      $('identity-dialog').close();
    } catch (error) { this.refused(error instanceof Error ? error.message : String(error)); }
  }
}
