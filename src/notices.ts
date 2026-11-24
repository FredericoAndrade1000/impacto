import { tr } from './i18n.ts';
import type { Camera } from './camera.ts';
import type { EncounterBands } from './encounter-bands.ts';
export interface NoticesOptions {
  get(selector: string): HTMLElement | null;
  renderer: { camera: Pick<Camera, 'cover'> };
  encounterBands?: Pick<EncounterBands, 'record'>;
  attempt?(action: () => unknown): unknown;
  showPlace?(place: number): unknown;
  document?: Pick<Document, 'hidden' | 'createElement'>;
  performance?: Pick<Performance, 'now'>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  height?: () => number;
}
interface ActiveToast { grave: boolean; duration: number; until: number; hide(): void }


// One visible notice owns its deadline, severity and destination together.
export function createNotices({ get, renderer, encounterBands, attempt, showPlace,
  document = globalThis.document, performance = globalThis.performance,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, height = () => innerHeight }: NoticesOptions) {
  let toastTimer: ReturnType<typeof globalThis.setTimeout> | null = null, toastActive: ActiveToast | null = null;
  const $ = (selector: string): HTMLElement => { const element = get(selector); if (!element) throw new Error('Controle ausente: ' + selector); return element; };
  const cancelTimer = (): void => { if (toastTimer !== null) clearTimeout(toastTimer); };
  // A notice stands a hand over what covers the foot of the field — the orders of what is picked, the place of a works or of
  // a road, the pedals, the pieces of the workshop (`camera.cover`), and the more orders open over them —, never on their
  // buttons. It is kept there at each frame it shows, as they change under it.
  function placeToast(): void {
    const element = $('#toast');
    if (element.hidden) return;
    const field = $('#viewport').getBoundingClientRect(), menu = $('#field-dock').querySelector<HTMLElement>('.field-more-actions[open] > .field-more-menu'),
      top = Math.min(field.bottom - renderer.camera.cover().bottom, menu?.offsetParent ? menu.getBoundingClientRect().top : Infinity),
      clear = `${Math.ceil(height() - top + 8)}px`;
    if (element.style.getPropertyValue('--toast-clear') !== clear) element.style.setProperty('--toast-clear', clear);
  }
  // A notice is short, and put away by a press. It stays for as long as it takes to read, and one that tells of a place of
  // the field (`place`) stays longer and is pressed to go and look at it.
  function toast(message: string, error = false, place: number | null = null, items: unknown = null): void {
    if (!encounterBands) throw new Error('Destinos de avisos ausentes.');
    encounterBands.record(items, performance.now() / 1000);
    const element = $('#toast'), now = performance.now();
    // Routine information does not take the place of an urgent notice still
    // being read: its text, destination and original deadline stay together.
    if (!error && toastActive?.grave && !element.hidden && now < toastActive.until) return;
    const go = place === null ? null : document.createElement('b'),
      duration = Math.max(go ? 6000 : error ? 4500 : 2600, Math.min(15000, message.length * 65)),
      active: ActiveToast = { grave: Boolean(error), duration, until: now + duration, hide: () => hide() },
      hide = (): void => {
        if (toastActive !== active) return;
        element.hidden = true; toastActive = null; cancelTimer(); toastTimer = null;
      };
    toastActive = active;
    cancelTimer(); element.textContent = message; element.hidden = false;
    if (go) { go.innerHTML = tr('Ver no campo') + ' <svg aria-hidden="true"><use href="#i-next"/></svg>'; element.append(' ', go); }
    element.classList.toggle('toast-place', Boolean(go)); element.onclick = place !== null ? () => { hide(); if (!attempt || !showPlace) throw new Error('Destino de aviso ausente.'); attempt(() => showPlace(place)); } : hide;
    element.setAttribute('role', error ? 'alert' : 'status'); active.hide = hide; timeToast();
  }
  // One notice stays in its slot while the page is away. Returning gives it a full reading interval,
  // with no queue of missed notices or sounds to replay. A newer grave notice can still take the slot.
  function timeToast(): void {
    cancelTimer(); toastTimer = null;
    const active = toastActive; if (!active) return;
    const until = active.until = document.hidden ? Infinity : performance.now() + active.duration;
    if (!document.hidden) toastTimer = setTimeout(() => {
      if (toastActive !== active || active.until !== until) return;
      if (document.hidden) timeToast(); else active.hide();
    }, active.duration);
  }

  return { toast, placeToast, timeToast };
}
