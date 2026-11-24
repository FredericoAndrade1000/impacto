// What takes something away from the player is asked first, in the page. The answer is the button
// pressed, or Esc: the dialog's own close event waits for a frame, which a hidden page never draws.
export const confirm = (title: string, text: string, accept: string): Promise<boolean> => new Promise(resolve => {
  const $ = (id: string): HTMLElement => { const element = document.getElementById(id); if (!element) throw new Error('Controle ausente: ' + id); return element; }, dialog = $('confirm-dialog');
  if (!('showModal' in dialog) || typeof dialog.showModal !== 'function' || !('close' in dialog) || typeof dialog.close !== 'function') throw new Error('Diálogo ausente: confirm-dialog');
  const close = dialog.close.bind(dialog), show = dialog.showModal.bind(dialog);
  $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-accept').textContent = accept;
  const answer = (value: boolean): void => { dialog.onclick = dialog.oncancel = null; if ('open' in dialog && dialog.open) close(); resolve(value); };
  dialog.onclick = event => {
    const target = event.target, pressed: unknown = target && 'closest' in target && typeof target.closest === 'function' ? target.closest('button') : null;
    if (pressed && typeof pressed === 'object' && 'value' in pressed) answer(pressed.value === 'ok');
  };
  dialog.oncancel = () => answer(false);
  show();
});
