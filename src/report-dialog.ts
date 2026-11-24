import { tr } from './i18n.ts';
export interface EntryVehicleReport { id: string; label: string; problems: readonly string[] }
export interface EntryReport { title: string; text: string; vehicles: readonly EntryVehicleReport[] }
// What the player has to read before going on is a dialog that stays until it is put away.
// Each vehicle has a button that takes the camera to it (`look`).
export function showReport({ title, text, vehicles }: EntryReport, look: (id: string) => void): void {
  const $ = (id: string): HTMLElement => { const element = document.getElementById(id); if (!element) throw new Error('Controle ausente: ' + id); return element; },
    dialog = $('report-dialog'), make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
      const element = document.createElement(tag); if (className) element.className = className; return element; };
  if (!('showModal' in dialog) || typeof dialog.showModal !== 'function' || !('close' in dialog) || typeof dialog.close !== 'function') throw new Error('Diálogo ausente: report-dialog');
  const closeDialog = dialog.close.bind(dialog), show = dialog.showModal.bind(dialog);
  const close = (): void => { dialog.onclick = null; if ('open' in dialog && dialog.open) closeDialog(); };
  $('report-title').textContent = title; $('report-text').textContent = text;
  $('report-list').replaceChildren(...vehicles.map(vehicle => {
    const row = make('li'), head = make('div', 'report-head'), name = make('b'), go = make('button', 'quiet-button'), problems = make('ul');
    name.textContent = vehicle.label;
    go.type = 'button'; go.innerHTML = '<svg aria-hidden="true"><use href="#i-next"/></svg>'; go.prepend(tr('Ver')); go.title = tr('Levar a câmera até ele');
    go.onclick = () => { close(); look(vehicle.id); };
    problems.append(...vehicle.problems.map(words => {
      const first = words[0]; if (first === undefined) throw new TypeError('Descrição vazia no relatório.');
      const item = make('li'); item.textContent = first.toUpperCase() + words.slice(1) + '.'; return item;
    }));
    head.append(name, go); row.append(head, problems);
    return row;
  }));
  // Put away by its button, by Esc (the dialog's own) or by a press outside it.
  dialog.onclick = event => {
    const target = event.target, pressed: unknown = target && 'closest' in target && typeof target.closest === 'function' ? target.closest('button[value=ok]') : null;
    if (target === dialog || pressed) close();
  };
  if (!('open' in dialog) || !dialog.open) show();
}
