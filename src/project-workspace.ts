import { tr } from './i18n.ts';
import { writeWorkingCopy, clearWorkingCopy } from './working-copy.ts';
import { workshopDraft } from './persistence.ts';
import type { AuthoredConstruction, CompiledConstruction } from './construction-contract.ts';
import type { Editor, EditorEvent } from './editor.ts';
import type { WorkingStore } from './working-copy.ts';

interface LibraryEntry { id: string; blueprint: unknown }
interface ProjectLibrary {
  has(id: string): boolean;
  update(id: string, source: AuthoredConstruction, options: { expected?: string | undefined }): LibraryEntry;
  create(source: AuthoredConstruction, options: { id: string }): LibraryEntry;
  activate(id: string): LibraryEntry;
}
interface ProjectWorkspaceOptions {
  library: ProjectLibrary;
  editor: Pick<Editor, 'projectId' | 'source' | 'revision' | 'commit' | 'replace' | 'change'>;
  projectVersions: Map<string, string>;
  workingStores: readonly (WorkingStore | null | undefined)[];
  toast(message: string, error?: boolean): void;
  opened(): void;
  document?: Pick<Document, 'activeElement'>;
  reportError?(error: unknown): void;
}
interface EditorViewOptions {
  editor: Pick<Editor, 'blueprint' | 'onchange'>;
  renderer: { blueprint: CompiledConstruction | null; ready: boolean; design(blueprint: CompiledConstruction): void };
  meter: { run(label: string, action: () => void): unknown };
  keepProject(): unknown;
  refreshUI(): void;
  queueMicrotask?: typeof globalThis.queueMicrotask;
}

// Saving, conflict baselines and recovery belong to the open project, together.
export function createProjectWorkspace({ library, editor, projectVersions, workingStores, toast, opened,
  document = globalThis.document, reportError = error => console.error(error) }: ProjectWorkspaceOptions) {
  // The garage is the saved project, not a separate version of the bench. If a write fails, keep an emergency copy in
  // whichever browser store accepts it; never hide the failure or discard the document/history.
  let workingError = '';
  function keepProject() {
    try {
      const saved = projectVersions.has(editor.projectId)
        ? library.update(editor.projectId, editor.source, { expected: projectVersions.get(editor.projectId) })
        : library.create(editor.source, { id: editor.projectId });
      projectVersions.set(editor.projectId, JSON.stringify(saved.blueprint));
      clearWorkingCopy(workingStores, { projectId: editor.projectId, blueprint: editor.source });
      workingError = ''; return true;
    }
    catch (error) {
      reportError(error);
      let recovered = false;
      try { writeWorkingCopy(workingStores, { projectId: editor.projectId, blueprint: editor.source }); recovered = true; } catch {}
      const reason = error instanceof Error && 'code' in error && error.code === 'PROJECT_CONFLICT' ? error.message + ' ' : '',
        message = reason + (recovered ? tr('A Garagem não guardou as últimas mudanças. Há uma cópia de recuperação neste navegador; exporte o projeto antes de sair.')
          : tr('O navegador não guardou as últimas mudanças: exporte o projeto antes de sair.'));
      if (message !== workingError) toast(message, true);
      workingError = message;
      return false;
    }
  }
  // Finish the useful edit already on the bench before any reload, including a focused number field.
  function keepBeforeReload() {
    const focused = document.activeElement;
    if (focused && 'blur' in focused && typeof focused.blur === 'function') focused.blur();
    const draft = structuredClone(editor.source);
    try { editor.commit(); return keepProject(); }
    catch (error) {
      try { writeWorkingCopy(workingStores, { projectId: editor.projectId, blueprint: draft }); } catch {}
      toast(tr('A atualização está pronta, mas este ajuste não foi salvo. Exporte o projeto antes de recarregar.'), true);
      return false;
    }
  }
  // Another project takes the place of the open one only after its confirmed edits are kept. A model, a file or a copy
  // from the field receives a new project identity; opening a garage entry keeps its identity.
  async function openProject(blueprint: unknown, id: string | null = null): Promise<boolean> {
    editor.commit();
    // The untouched initial model has no project yet; a full or unreadable garage must still let its existing projects open.
    if ((editor.revision || library.has(editor.projectId)) && !keepProject()) return false;
    const entry = id ? library.activate(id) : null;
    if (entry) projectVersions.set(entry.id, JSON.stringify(entry.blueprint));
    editor.replace(workshopDraft(entry ? entry.blueprint : blueprint), entry?.id ?? null);
    // A different document has no selected piece or unfinished placement. Hide
    // its old inspector now, before a caller frames the new project in the DOM.
    opened();
    return true;
  }
  function rename(id: string, name: string): void {
      if (id !== editor.projectId) {
        // Only this deliberate name edit advances the baseline; unseen changes to other fields still conflict on Undo.
        if (projectVersions.has(id)) {
          // These baselines are written above from the editor's canonical document, not imported text.
          const previous: object = JSON.parse(projectVersions.get(id)!);
          projectVersions.set(id, JSON.stringify({ ...previous, name }));
        }
        return;
      }
      if (name === editor.source.name) return;
      editor.commit(); editor.change(b => { b.name = name; });
    }

  return { keepProject, keepBeforeReload, openProject, rename, get workingError() { return workingError; } };
}

// Confirmed document changes save once. A pending preview never demotes a full
// update; a frame can draw its geometry while its property figures stay still.
export function createEditorView({ editor, renderer, meter, keepProject, refreshUI, queueMicrotask = globalThis.queueMicrotask }: EditorViewOptions) {
  let uiPending: boolean | 'preview' = false;
  function requestUI(event: Partial<EditorEvent> = {}): void {
    // A normal request promotes a pending preview; later previews never demote it.
    uiPending = event.kind === 'preview' ? uiPending || 'preview' : true;
    if (event.kind !== 'preview') queueMicrotask(flushUI);
  }
  function refreshDesign() {
    const b = editor.blueprint;
    if (renderer.blueprint !== b) renderer.design(b);
  }
  function flushUI(holdArt = false) {
    if (!uiPending) return;
    // A preview in an open editor transaction holds its figures; its current shape still draws.
    if (holdArt && uiPending === 'preview') {
      if (renderer.ready) refreshDesign();
      return;
    }
    uiPending = false;
    if (renderer.ready) meter.run('panels', refreshUI);
  }
  // Only confirmed edits are kept; previews can still be refused or cancelled.
  editor.onchange = event => {
    if (event.kind === 'document') keepProject();
    requestUI(event);
  };

  return { requestUI, refreshDesign, flushUI };
}
