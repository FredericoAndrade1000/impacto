export interface WorkingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface WorkingCopy { projectId: string; blueprint: unknown }

// An emergency copy when the garage cannot accept an autosave. Originals can be exported without replacing the garage.
export const WORKING_KEY = 'impacto.oficina.aberto';
// Only this writer's last successful text can be replaced or retired. A legacy record or another tab's write wins.
const written = new WeakMap<WorkingStore, string>();

// Kept in every store that takes it; with none that does, the reason is thrown.
export function writeWorkingCopy(stores: readonly (WorkingStore | null | undefined)[], { projectId, blueprint }: WorkingCopy): void {
  const text = JSON.stringify({ projectId, blueprint });
  let kept = false, failure: unknown = null;
  for (const store of stores) {
    if (!store) continue;
    try {
      const previous = store.getItem(WORKING_KEY);
      if (previous !== null && previous !== text && previous !== written.get(store))
        throw new Error('Há outro rascunho nesta origem. Baixe os originais pela Garagem e exporte a edição atual.');
      if (previous !== text) store.setItem(WORKING_KEY, text);
      written.set(store, text); kept = true;
    } catch (error) { failure ||= error; }
  }
  if (!kept) throw failure || new Error('Este navegador não deixa o jogo guardar dados.');
}

// Only a copy now present in the garage can be retired. Other drafts — even of the same project — stay recoverable.
export function clearWorkingCopy(stores: readonly (WorkingStore | null | undefined)[], { projectId, blueprint }: WorkingCopy): void {
  const kept = JSON.stringify(blueprint);
  for (const store of stores) {
    try {
      if (!store) continue;
      const text = store.getItem(WORKING_KEY);
      if (!text || text !== written.get(store)) continue;
      const copy: unknown = JSON.parse(text);
      if (copy && typeof copy === 'object' && 'projectId' in copy && copy.projectId === projectId &&
          JSON.stringify('blueprint' in copy ? copy.blueprint : undefined) === kept) {
        store.removeItem(WORKING_KEY); written.delete(store);
      }
    } catch { /* a failed cleanup leaves the emergency copy intact */ }
  }
}
