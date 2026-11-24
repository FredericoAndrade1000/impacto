import { POST_FULL_MESSAGE, POST_LIMIT } from './territory.ts';
import { UNBASED } from './economy.ts';
import { translate } from './i18n.ts';
export interface InfrastructureFaction {
  readonly base?: object | null;
  readonly posts?: readonly { readonly takedown?: object | null }[];
  readonly works?: readonly { readonly post?: boolean | undefined }[];
}
export interface InfrastructureOffer { post: string; road: string }
export interface InfrastructureOptions { readonly post: () => unknown; readonly road: (kind: 'graded' | 'asphalt') => unknown; readonly toast: (text: string, error?: boolean) => void }
const required = <T>(value: T | null): T => { if (value === null) throw new Error('Missing infrastructure control'); return value; };
const message = (error: unknown): string => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);


// What the Infraestrutura page offers a faction on the shared field (`fieldPanel`): to raise a post (territory.ts) — but not
// with as many as it may have, standing or being put up; one being taken down is a post no longer —, and to ask for a road,
// of graded earth or of asphalt. Of each, why it
// may not be asked for now, in words, or nothing when it may; the field refuses by the same rules once asked, with what it
// knows (territory.ts, road-works.ts).
export function infrastructureOffer(faction: InfrastructureFaction | null | undefined): InfrastructureOffer {
  const unbased = !faction?.base ? UNBASED : '',
    posts = (faction?.posts ?? []).filter(post => !post.takedown).length + (faction?.works ?? []).filter(work => work.post).length;
  return { post: unbased || (posts >= POST_LIMIT ? translate(POST_FULL_MESSAGE) : ''), road: unbased };
}

const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
// The page itself (index.html `field-page-infra`): the button of a post and those of the roads, by the kind of road each asks
// for, each switched off with why beneath it while it may not be used. A button begins choosing the place on the field —
// `post()`, `road(kind)` (main.ts) —, which closes the page; what refuses it then is said.
export function initInfrastructureUX({ post, road, toast }: InfrastructureOptions) {
  const $ = (id: string): HTMLElement => required(document.getElementById(id)), raise = $('infra-post'), raiseHeld = $('infra-post-held'),
    roads = [...document.querySelectorAll<HTMLButtonElement>('#field-page-infra [data-road]')], roadHeld = $('infra-road-held');
  const start = (button: HTMLElement, begin: () => unknown) => () => {
    if (Reflect.get(button, 'disabled')) return;
    try { begin(); } catch (error) { toast(message(error), true); }
  };
  raise.onclick = start(raise, post);
  for (const button of roads) button.onclick = start(button, () => { const kind = button.dataset.road; if (kind === 'graded' || kind === 'asphalt') road(kind); });
  return {
    // Paints the page as `fieldPanel` told it (`infrastructure`): off the shared field, all of it waits for the field.
    render(offer: InfrastructureOffer | null | undefined): void {
      const told = offer ?? { post: 'Aguarde uma atualização do campo.', road: 'Aguarde uma atualização do campo.' };
      Reflect.set(raise, 'disabled', Boolean(told.post)); write(raiseHeld, told.post);
      for (const button of roads) button.disabled = Boolean(told.road);
      write(roadHeld, told.road);
    }
  };
}
