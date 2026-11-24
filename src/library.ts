import { makeId } from './blueprints.ts';
import { validateDraftBlueprint } from './persistence.ts';
import { fromVersion9 } from './project-v9.ts';
import { unmirrored } from './project-unmirror.ts';
import type { WorkingStore } from './working-copy.ts';

export type ProjectStorage = Pick<WorkingStore, 'getItem' | 'setItem'>;
// Originals remain opaque until the Native compiler admits the selected project.
export interface LibraryEntry { id: string; createdAt: string; updatedAt: string; blueprint: unknown }
export interface LibraryData { version: 4; activeId: string | null; entries: LibraryEntry[] }
export interface LibraryOptions { now?: () => string; id?: () => string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// The garage envelope retains originals; authored designs carry their own version.
export const LIBRARY_KEY = 'impacto.garagem.v4';
const MAX_ENTRIES = 100;
const empty = (): LibraryData => ({ version: 4, activeId: null, entries: [] });
function projectBlueprint(input: unknown) {
  if (record(input) && input.derived) throw new Error('Esse projeto não pode ser salvo na garagem: ele não é um projeto da Oficina.');
  return validateDraftBlueprint(input);
}
// Each project is read as it is kept, and checked by the core only when it is shown or opened: one the core refuses
// stays in the garage as it was, to say why it does not open and to be exported or recovered explicitly. One of the
// format 9 is read in the current one (project-v9.ts), and one turned about whole in the workshop of before the right way
// round (project-unmirror.ts); `converted` says so.
function decodeLibrary(text: string) {
  const input: unknown = JSON.parse(text);
  if (!record(input) || input.version !== 4 || !Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) throw new Error('A garagem guardada é de outro formato.');
  const ids = new Set<string>(), data = empty();
  let converted = false;
  for (const candidate of input.entries) {
    const entry: unknown = candidate;
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error('A garagem guardada está danificada.');
    ids.add(entry.id);
    const blueprint = unmirrored(fromVersion9(entry.blueprint)); converted ||= blueprint !== entry.blueprint;
    data.entries.push({ id: entry.id, createdAt: String(entry.createdAt || ''), updatedAt: String(entry.updatedAt || ''), blueprint });
  }
  if (typeof input.activeId === 'string' && data.entries.some(entry => entry.id === input.activeId)) data.activeId = input.activeId;
  return { data, converted };
}

// Every editor document already has a project identity. Saving writes that project, or creates it, with one
// atomic write for the projects and last-opened identity.
export class DesignLibrary {
  declare storage: ProjectStorage;
  declare now: () => string;
  declare id: () => string;
  declare data: LibraryData;
  declare error: unknown;
  declare lastText: string | null;
  constructor(storage: ProjectStorage, { now = () => new Date().toISOString(), id = () => makeId('design') }: LibraryOptions = {}) {
    this.storage = storage; this.now = now; this.id = id; this.data = empty(); this.error = null; this.lastText = null;
    const text = storage.getItem(LIBRARY_KEY);
    if (!text) return;
    this.lastText = text;
    let read;
    try { read = decodeLibrary(text); }
    catch { this.error = new Error('A garagem guardada não pôde ser lida. Os dados continuam no navegador; exporte o projeto aberto antes de recarregar.'); return; }
    this.data = read.data;
    // Projects of the old format are kept again in the current one. Where the browser does not take it now, the next
    // save writes them all.
    if (read.converted) try { this.write(read.data); } catch { /* kept at the next save */ }
  }
  get entries() { return structuredClone(this.data.entries); }
  get active() { return this.get(this.data.activeId); }
  get(id: string | null | undefined) { const entry = this.data.entries.find(entry => entry.id === id); return entry ? structuredClone(entry) : null; }
  has(id: string | null | undefined) { return this.data.entries.some(entry => entry.id === id); }
  sync() {
    const text = this.storage.getItem(LIBRARY_KEY);
    if (text === this.lastText) return;
    if (!text) { if (this.lastText) throw new Error('A garagem foi removida em outra aba. Exporte a construção atual antes de recarregar.'); return; }
    let next;
    try { next = decodeLibrary(text).data; }
    catch { throw new Error('A garagem foi alterada em outra aba e não pôde ser lida. Os projetos desta aba continuam como estavam.'); }
    this.data = next; this.lastText = text; this.error = null;
  }
  write(next: LibraryData) {
    if (this.error) throw this.error;
    if (this.storage.getItem(LIBRARY_KEY) !== this.lastText) throw new Error('A garagem mudou em outra aba. Abra a garagem e tente novamente.');
    const text = JSON.stringify(next); this.storage.setItem(LIBRARY_KEY, text);
    this.data = next; this.lastText = text;
  }
  create(blueprint: unknown, { id = this.id(), activate = true }: { id?: string; activate?: boolean } = {}) {
    this.sync();
    const valid = projectBlueprint(blueprint), next = structuredClone(this.data);
    if (typeof id !== 'string' || !id || next.entries.some(entry => entry.id === id)) throw new Error('Não foi possível criar o projeto. Tente de novo.');
    if (next.entries.length >= MAX_ENTRIES) throw new Error(`A garagem guarda até ${MAX_ENTRIES} construções. Exporte e remova algumas para abrir espaço.`);
    const stamp = this.now(), entry = { id, createdAt: stamp, updatedAt: stamp, blueprint: valid };
    next.entries.push(entry);
    if (activate) next.activeId = id;
    this.write(next); return structuredClone(entry);
  }
  update(id: string, blueprint: unknown, { activate = true, expected }: { activate?: boolean; expected?: string | undefined } = {}) {
    this.sync();
    const current = this.data.entries.find(entry => entry.id === id);
    if (expected !== undefined && (!current || JSON.stringify(current.blueprint) !== expected))
      throw Object.assign(new Error('Este projeto foi alterado ou removido em outra aba. A versão da Garagem foi preservada.'), { code: 'PROJECT_CONFLICT' });
    const valid = projectBlueprint(blueprint), next = structuredClone(this.data), entry = next.entries.find(entry => entry.id === id);
    if (!entry) throw new Error('Este projeto não está mais na garagem. Exporte a construção atual antes de recarregar.');
    entry.blueprint = valid; entry.updatedAt = this.now();
    if (activate) next.activeId = id;
    this.write(next); return structuredClone(entry);
  }
  activate(id: string) {
    this.sync();
    const entry = this.get(id); if (!entry) throw new Error('Construção indisponível.');
    if (this.data.activeId !== id) this.write({ ...structuredClone(this.data), activeId: id });
    return entry;
  }
  duplicate(id: string) {
    this.sync();
    const entry = this.get(id); if (!entry) throw new Error('Construção não encontrada.');
    if (!record(entry.blueprint) || typeof entry.blueprint.name !== 'string') throw new TypeError('entry.blueprint.name.slice is not a function');
    return this.create({ ...entry.blueprint, name: entry.blueprint.name.slice(0, 72) + ' · cópia' }, { activate: false });
  }
  rename(id: string, name: string) {
    this.sync();
    const entry = this.get(id); if (!entry) throw new Error('Construção não encontrada.');
    return this.update(id, { ...(record(entry.blueprint) ? entry.blueprint : {}), name }, { activate: false, expected: JSON.stringify(entry.blueprint) });
  }
  remove(id: string) {
    this.sync();
    const next = structuredClone(this.data), at = next.entries.findIndex(entry => entry.id === id);
    if (at < 0) throw new Error('Construção não encontrada.');
    next.entries.splice(at, 1);
    if (next.activeId === id) next.activeId = null;
    this.write(next);
  }
}
