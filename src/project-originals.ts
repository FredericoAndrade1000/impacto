import { tr } from './i18n.ts';
import { node, actionButton } from './dom-view.ts';
import { serializeBlueprint, workshopDraft } from './persistence.ts';
import { WORKING_KEY } from './working-copy.ts';
import type { WorkingStore } from './working-copy.ts';

export interface ProjectOriginalRecord { storage: string; key: string; raw: string | null; error: unknown; label?: string }
export interface ProjectOriginalCapture { format: 'impacto-project-originals'; version: 1; capturedAt: string; records: ProjectOriginalRecord[] }
type OriginalStore = Pick<WorkingStore, 'getItem'> | null | undefined;
const messageOf = (error: unknown): unknown => error && typeof error === 'object' && 'message' in error ? error.message : undefined;

const GARAGE = 'impacto.garagem.v4', WORKING = WORKING_KEY, BENCH = 'impacto.oficina.bancada';

// Keep literal records before any editor or another tab can replace them. No project format is interpreted here.
export function captureProjectRecords({ local, session }: { local?: OriginalStore; session?: OriginalStore }): ProjectOriginalCapture {
  const records = ([[local, 'local', GARAGE], [local, 'local', WORKING], [session, 'session', WORKING],
    [local, 'local', BENCH], [session, 'session', BENCH]] satisfies [OriginalStore, string, string][]).map(([store, storage, key]): ProjectOriginalRecord => {
    try {
      return { storage, key, raw: store ? store.getItem(key) : null, error: store ? null : tr('Armazenamento indisponível.') };
    } catch (error) { return { storage, key, raw: null, error: messageOf(error) || String(error) }; }
  });
  return { format: 'impacto-project-originals', version: 1, capturedAt: new Date().toISOString(), records };
}

function origin(record: ProjectOriginalRecord): string {
  const place = record.storage === 'session' ? tr('desta aba') : tr('do navegador'),
    title = record.key === GARAGE ? `Garagem ${place}` : record.key === WORKING ? tr`Edição ${place}`
      : record.key === BENCH ? tr`Bancada antiga ${place}` : `${record.storage} · ${record.key}`;
  return record.label ? `${record.label} · ${title}` : title;
}

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), link = node('a');
  link.href = url; link.download = filename;
  try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}

// Only a current workshop edition becomes an importable project. Its record stays literal,
// including the identity used by its writer; normal import gives the project a new identity.
function editionProject(record: ProjectOriginalRecord): string | null {
  if (record.key !== WORKING || record.raw === null) return null;
  try { const parsed: unknown = JSON.parse(record.raw); return serializeBlueprint(workshopDraft(parsed && typeof parsed === 'object' && 'blueprint' in parsed ? parsed.blueprint : undefined)); }
  catch { return null; }
}

// Originals are exportable even when malformed or from an unsupported version. This dialog never writes storage.
export function openProjectOriginals(capture: ProjectOriginalCapture): HTMLDialogElement {
  const dialog = node('dialog', 'workshop-dialog'), header = node('div', 'dialog-header'),
    title = node('h2', '', tr('Originais deste navegador')), close = actionButton(tr('Fechar'), () => dialog.close(), 'quiet-button'),
    explanation = node('p', '', tr('Edições atuais podem ser baixadas como projeto para importar na Garagem e abrir uma cópia. Os registros originais permanecem intactos; projetos de outras versões não são convertidos.')),
    results = node('div', 'design-grid'), status = node('p', '', tr('Os originais não foram alterados.'));
  dialog.id = 'project-originals-dialog'; title.id = 'project-originals-title';
  dialog.setAttribute('aria-labelledby', title.id); status.setAttribute('role', 'status');
  header.append(title, close);
  const save = (text: string, filename: string): void => {
    try { download(text, filename); status.textContent = tr('Download solicitado. Guarde esse arquivo.'); }
    catch (error) { Reflect.set(status, 'textContent', messageOf(error)); }
  };
  const backup = actionButton(tr('Baixar todos os originais'), () => save(JSON.stringify(capture, null, 2), 'impacto-projetos-originais.json'));
  for (const [index, record] of capture.records.entries()) {
    if (record.raw === null && !record.error) continue;
    const row = node('article', 'design-card design-info');
    row.append(node('h3', '', origin(record)));
    if (record.error) row.append(node('p', '', String(record.error)));
    const project = editionProject(record);
    if (project !== null) row.append(actionButton(tr('Baixar projeto desta edição'), () => save(project, `impacto-projeto-recuperado-${index + 1}.json`)));
    if (record.raw !== null) row.append(actionButton(tr('Baixar este original'), () => save(record.raw!, `impacto-original-${index + 1}.json`), 'quiet-button'));
    results.append(row);
  }
  if (!results.children.length) status.textContent = tr('Não há registros guardados nestas origens.');
  dialog.append(header, explanation, backup, results, status);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal(); return dialog;
}
