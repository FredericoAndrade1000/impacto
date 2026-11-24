import type { Editor } from './editor.ts';
import type { UiView } from './ui-model.ts';
import type { CanvasControlInput, CanvasRenderer } from './canvas-controls.ts';
import type { FieldScreen } from './field-screen.ts';
import type { WorkspaceChrome } from './workspace-chrome.ts';
interface KeyStroke { key:string; ctrlKey?:boolean; metaKey?:boolean; altKey?:boolean; target?:EventTarget|null }
interface KeyboardInput extends Pick<CanvasControlInput,'gesture'|'spacePan'> {
  keyFire:boolean; lookKeys:Set<string>;lookReleased:Set<string>;driveKeys:Set<string>;
}
interface PageKeyEffects {
  get(selector:string): Pick<HTMLElement,'hidden'>;
  all(selector:'dialog'): readonly Pick<HTMLDialogElement,'open'>[];
  cycleMeter():unknown;
  readonly testConsole?:{available:boolean;blocked:string}|null;
  readonly fieldScreen:Pick<FieldScreen,'task'|'close'|'openTask'>;
  readonly workspace:Pick<WorkspaceChrome,'onClose'>;
  readonly workshopUX?:{selectAll():unknown;remove():unknown}|null;
  placing():{cancel():unknown;submit():unknown}|null|undefined;
  toast(message:string,warning?:boolean):unknown;
  requestUI():unknown;framePublication():unknown;keepProject():boolean;
  redo():unknown;undo():unknown;duplicate():unknown;showHelp():unknown;fitCurrent(target:boolean):unknown;
  syncTrigger(options?:{queue?:boolean}):unknown;syncDrive():unknown;explainSilence():unknown;
  quicken():unknown;stopControls():unknown;clearGesture(revert:boolean):unknown;setTool(tool:UiView['buildTool']):unknown;
}
interface SettingsKeysOptions {view:Pick<UiView,'mode'>;get(selector:string):HTMLElement;settingsPanel(open:boolean):unknown;document?:Document}
interface PageKeysOptions {
  view:Pick<UiView,'mode'|'trial'|'buildTool'|'exterior'>;editor:Pick<Editor,'commit'|'selection'>;session?:unknown;
  renderer:Pick<CanvasRenderer,'modulePreview'>;input:KeyboardInput;effects:PageKeyEffects;document?:Document;
}
import { tr } from './i18n.ts';
import { categoryOf } from './workshop-context.ts';

// The keys of the workshop beside Esc and Delete, under the left hand as some building games have them: C cancels and
// X removes. They are the workshop's alone — on the field C takes a vehicle in hand and X stops its orders — and a key
// typed into a field, or pressed with Ctrl, Alt or Cmd, is not one of them.
const typing = (target: EventTarget | null | undefined): boolean => Boolean(target && 'matches' in target && typeof target.matches === 'function' && target.matches('input,select,textarea,[contenteditable=true]'));
const plain = (event: KeyStroke, key: string) => event.key.toLowerCase() === key && !event.ctrlKey && !event.metaKey && !event.altKey && !typing(event.target);
// Whether a key cancels what is under way: Esc anywhere, and C in the workshop (`workshop`).
export const cancels = (event: KeyStroke, workshop = true) => event.key === 'Escape' || workshop && plain(event, 'c');
// Whether a key removes the selection of the workshop: Delete, Backspace or X.
export const removes = (event: KeyStroke) => ['Delete', 'Backspace'].includes(event.key) || plain(event, 'x');
// The number keys of the parts to install, given their kinds in the order they are shown (the Arsenal's is 'weapon'):
// each category numbers its own parts from 1, so a key takes the part of that number in the category open.
export function partKeys(kinds: readonly string[]): number[] {
  const counted = new Map<string,number>();
  return kinds.map(kind => { const id = categoryOf(kind); counted.set(id, (counted.get(id) ?? 0) + 1); return counted.get(id)!; });
}

export function installSettingsKeys({ view, get: $, settingsPanel, document = globalThis.document }: SettingsKeysOptions) {
  // Escape puts the open settings away before anything else hears it (it would give the vehicle in hand back); in the
  // workshop, so does C.
  document.addEventListener('keydown', event => {
    if (!cancels(event, view.mode === 'edit') || $('#settings-panel').hidden || event.target && 'tagName' in event.target && event.target.tagName === 'SELECT') return;
    event.preventDefault(); event.stopPropagation(); settingsPanel(false); $('#settings-menu').focus();
  }, true);

}

export function installPageKeys({ view, editor, session, renderer, input, effects, document = globalThis.document }: PageKeysOptions) {
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    // The meter of the frames comes, tells its detail and goes wherever the keys are, over a dialog as over the field: the
    // browser keeps F3 for its search.
    if (event.key === 'F3') { event.preventDefault(); if (!event.repeat) effects.cycleMeter(); return; }
    if (effects.all('dialog').some(d => d.open)) return;
    if (event.key === 'F1' && effects.testConsole?.available) {
      event.preventDefault();
      if (!event.repeat) {
        if (effects.testConsole.blocked) effects.toast(effects.testConsole.blocked, true);
        else { effects.fieldScreen.task === 'test' ? effects.fieldScreen.close() : effects.fieldScreen.openTask('test'); effects.requestUI(); }
      }
      return;
    }
    // Placing a works or a road, Esc calls it off and Enter asks for it where it stands, as the buttons of its dock say.
    const target = event.target, over = (selector:string): boolean => Boolean(target && 'closest' in target && typeof target.closest === 'function' && target.closest(selector));
    const placed = effects.placing();
    if (placed) {
      const key = event.key.toLowerCase();
      if (key === 'escape') { event.preventDefault(); placed.cancel(); effects.requestUI(); }
      else if (key === 'enter' && !event.repeat && !over('button,summary,input,select,textarea')) { event.preventDefault(); placed.submit(); effects.requestUI(); }
      else if (key === 'home') { event.preventDefault(); effects.framePublication(); }
      else if (key.startsWith('arrow') && !over('button,input,select,textarea')) {
        event.preventDefault(); input.lookReleased.delete(key); input.lookKeys.add(key);
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (view.mode === 'edit' && !view.trial) { editor.commit(); if (effects.keepProject()) effects.toast(tr('Projeto salvo automaticamente na Garagem.')); } return; }
    // In the workshop C cancels as Esc does, and X removes as Delete does (workshop-keys.ts).
    const editing = view.mode === 'edit';
    if (!effects.get('.sidebar').hidden) {
      if (cancels(event, editing) && (!target || !('tagName' in target) || target.tagName !== 'SELECT')) { event.preventDefault(); effects.workspace.onClose?.(); }
      return;
    }
    if (over('#first-objectives') || typing(target)) return;
    if ([' ', 'Enter'].includes(event.key) && over('button,summary')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? effects.redo() : effects.undo(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); effects.redo(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'd') { event.preventDefault(); effects.duplicate(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'a' && view.mode === 'edit') { event.preventDefault(); effects.workshopUX?.selectAll(); return; }
    if (key === '?' || key === 'h') { effects.showHelp(); return; }
    // Home frames everything — a test with the ground under it, the board in the field the design alone —, and with Shift the target.
    if (key === 'home') { event.preventDefault(); effects.fitCurrent(event.shiftKey); return; }
    if (key === ' ' && view.mode === 'edit') { event.preventDefault(); input.spacePan = true; return; }
    // The design under a test of armour is struck, not fired from.
    if (key === 'f' && view.mode === 'test' && view.trial !== 'armour') { event.preventDefault(); if (!input.keyFire) { input.keyFire = true; effects.syncTrigger({ queue: true }); effects.explainSilence(); } return; }
    if (key.startsWith('arrow') && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); input.lookReleased.delete(key); input.lookKeys.add(key); return; }
    // The design under a test of armour is not driven. W takes a vehicle that flies up (ui-model.ts `driveIntent`).
    if (view.mode === 'test' && view.trial !== 'armour' && ['a', 'd', 's', 'w'].includes(key)) { event.preventDefault(); if (!input.driveKeys.has(key)) { input.driveKeys.add(key); effects.syncDrive(); } return; }
    // Cancelling lets go of what was being installed and of the selection; with neither, it opens nothing. It gives a
    // slowed test its pace back.
    if (cancels(event, editing)) { effects.quicken(); effects.stopControls(); effects.clearGesture(Boolean(input.gesture)); renderer.modulePreview = null; if (view.buildTool !== 'select') effects.setTool('select'); editor.selection = null; }
    if (!editing) return;
    if (key === 'v' || key === 'm') effects.setTool(key === 'v' ? 'select' : 'module');
    if (key === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) { view.exterior = !view.exterior; effects.requestUI(); }
    if (removes(event)) { event.preventDefault(); effects.workshopUX?.remove(); }
  });
  document.addEventListener('keyup', event => { const key = event.key.toLowerCase(); if (key === ' ') input.spacePan = false; if (key === 'f') { input.keyFire = false; effects.syncTrigger(); } if (input.lookKeys.has(key)) input.lookReleased.add(key); if (input.driveKeys.delete(key)) effects.syncDrive(); });

}
