import { tr } from '../src/i18n.ts';
import { userError } from '../src/user-message.ts';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DIARY } from './field-host.ts';
import { FIELD_SAVE } from './field-save.ts';
import { coreBuild } from './field-journal.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { REPLAY_VERSION } from '../src/replay-contract.ts';
import type { ReplayArchive, ReplayEntry, ReplayJob } from '../src/replay-contract.ts';
import { replayChunkFile } from './replay-recording.ts';
import { replaySeries } from './replay-series.ts';
import { buildStamp } from './build-stamp.ts';

const MAX_INPUT = 128 * 1024 * 1024, MAX_SECONDS = 900, MAX_JOB_INPUT = 1024 * 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
interface Diary { entry: ReplayEntry; file: string }
interface Source { entry: ReplayEntry; files: readonly Diary[] }
interface Frozen { entry: ReplayEntry; key: string; bytes: Buffer; compressed: boolean }
interface Prepared { directory: string; archive: ReplayArchive }

// Loopback tooling only. IDs resolve to the configured catalogue; neither the
// browser nor a job can ask the game server to change or save its live world.
export class ReplayViewer {
  readonly sources = new Map<string, Source>();
  private described = new Map<string, { size: number; mtime: number; entry: ReplayEntry }>();
  readonly ready = new Map<string, Prepared>();
  job: ReplayJob = { status: 'idle' };
  worker: Worker | null = null;
  private generation = 0;
  private task: Promise<void> | null = null;
  readonly fingerprint: string;
  readonly roots: readonly string[];
  readonly cache: string;
  readonly origin: string;
  constructor(roots: readonly string[], cache: string, origin: string) {
    this.roots = roots; this.cache = cache; this.origin = origin;
    this.fingerprint = hash(buildStamp(process.cwd()) + ['./replay-recording.ts', './replay-export-worker.ts', './replay-series.ts', '../src/replay-contract.ts']
      .map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\0') + REPLAY_VERSION);
    mkdirSync(cache, { recursive: true });
  }
  catalog(): ReplayEntry[] {
    this.sources.clear();
    const files = new Set<string>(), groups = new Map<string, Diary[]>();
    for (const root of this.roots) {
      try {
        if (!existsSync(root)) continue;
        if (statSync(root).isFile()) files.add(realpathSync(root));
        else {
          const directory = existsSync(join(root, 'replays')) ? join(root, 'replays') : root;
          // Complete recordings need the oldest chapters in this scan as well.
          for (const file of readdirSync(directory).filter(name => /\.ndjson(?:\.gz)?$/.test(name)).sort())
            if (statSync(join(directory, file)).isFile()) files.add(realpathSync(join(directory, file)));
        }
      } catch { /* The live journal may rotate while the directory is listed. */ }
    }
    for (const file of files) {
      try {
        const { size, mtimeMs } = statSync(file), previous = this.described.get(file),
          entry = previous?.size === size && previous.mtime === mtimeMs ? previous.entry : this.describe(file), diary = { entry, file };
        this.described.set(file, { size, mtime: mtimeMs, entry });
        if (entry.compatible && entry.end <= entry.start) continue;
        this.sources.set(entry.id, { entry, files: [diary] });
        if (entry.fieldId && entry.end > entry.start) {
          const group = groups.get(entry.fieldId) ?? []; group.push(diary); groups.set(entry.fieldId, group);
        }
      } catch { /* An incomplete header or a rotating file is not offered. */ }
    }
    for (const [fieldId, group] of groups) if (group.length > 1) {
      group.sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.file.localeCompare(b.file));
      const bad = group.find(diary => !diary.entry.compatible)?.entry, id = hash('complete:' + fieldId).slice(0, 20),
        folder = dirname(group[0]!.file), name = basename(basename(folder) === 'replays' ? dirname(folder) : folder),
        entry: ReplayEntry = { id, kind: 'complete', chapters: group.length, fieldId, name, at: group.at(-1)!.entry.at,
          start: 0, end: group.reduce((sum, diary) => sum + diary.entry.end - diary.entry.start, 0),
          compatible: !bad, reason: bad?.reason ?? null, bytes: group.reduce((sum, diary) => sum + diary.entry.bytes, 0) };
      this.sources.set(id, { entry, files: group });
    }
    for (const file of this.described.keys()) if (!files.has(file)) this.described.delete(file);
    return [...this.sources.values()].map(source => source.entry).sort((a, b) => Number(b.kind === 'complete') - Number(a.kind === 'complete') || b.at.localeCompare(a.at));
  }
  private input(file: string): Buffer {
    if (statSync(file).size > MAX_INPUT) throw userError('A gravação não cabe no limite de tamanho.');
    return readFileSync(file);
  }
  private describe(file: string, buffer = this.input(file)): ReplayEntry {
    const bytes = buffer.length;
    if (!bytes || bytes > MAX_INPUT) throw userError('A gravação não cabe no limite de tamanho.');
    const here = coreBuild(), raw = file.endsWith('.gz') ? gunzipSync(buffer, { maxOutputLength: MAX_INPUT }) : buffer,
      lines = raw.toString('utf8').split('\n'), header: unknown = JSON.parse(lines[0]!);
    if (!record(header) || !Number.isInteger(header.diary)) throw userError('Cabeçalho do diário inválido.');
    let last = typeof header.step === 'number' ? header.step : 0;
    for (let i = lines.length - 1; i > 0; i--) {
      try { const row: unknown = JSON.parse(lines[i]!); if (Array.isArray(row) && typeof row[0] === 'number') { last = row[0]; break; } } catch { /* An active file may end mid-line. */ }
    }
    const start = typeof header.step === 'number' ? header.step / 60 : 0, core = record(header.core) ? header.core : {},
      reason = header.diary !== DIARY || header.network !== NETWORK_VERSION || header.save !== FIELD_SAVE || header.contract !== CORE_CONTRACT ? 'version' :
        core.runtime !== here.runtime || core.build !== here.build || core.platform !== here.platform || core.arch !== here.arch ? 'core' :
        last / 60 - start > MAX_SECONDS ? 'long' : null;
    return { id: hash(file).slice(0, 20), kind: 'chapter', chapters: 1, name: basename(file), at: typeof header.at === 'string' ? header.at : '',
      fieldId: typeof header.fieldId === 'string' ? header.fieldId : '', start, end: last / 60, compatible: reason === null, reason, bytes };
  }
  private frozen(source: Diary): Frozen {
    const buffer = this.input(source.file), entry = this.describe(source.file, buffer), compressed = source.file.endsWith('.gz');
    if (!entry.compatible) throw userError('A gravação mudou; atualize a lista.');
    const bytes = !compressed && buffer.at(-1) !== 10 ? buffer.subarray(0, buffer.lastIndexOf(10) + 1) : buffer;
    return { entry, bytes, compressed, key: hash(Buffer.concat([Buffer.from(this.fingerprint), bytes])).slice(0, 24) };
  }
  private cached(key: string): ReplayArchive | null {
    const directory = join(this.cache, key), file = join(directory, 'manifest.json');
    if (!existsSync(file)) return null;
    const archive = JSON.parse(readFileSync(file, 'utf8')) as ReplayArchive;
    if (archive.version !== REPLAY_VERSION || archive.id !== key) throw userError('Gravação preparada inválida.');
    this.ready.set(key, { directory, archive });
    for (const chunk of archive.chunks) if (chunk.source && !this.ready.has(chunk.source.archiveId)) {
      if (!/^[a-f0-9]{24}$/.test(chunk.source.archiveId) || !this.cached(chunk.source.archiveId)) throw userError('Falta um capítulo da gravação.');
    }
    return archive;
  }
  async prepare(id: string): Promise<void> {
    const source = this.sources.get(id);
    if (!source?.entry.compatible) throw userError('Escolha uma gravação compatível da lista.');
    if (this.job.status === 'preparing') throw userError('Já existe um replay em preparação. Aguarde ou cancele.');
    if (source.entry.bytes > MAX_JOB_INPUT) throw userError('A preparação excede o limite de tamanho.');
    // Freeze all chapters before starting the first worker. The live field may
    // append or rotate originals throughout a complete job.
    const inputs = source.files.map(diary => this.frozen(diary)), complete = source.entry.kind === 'complete',
      key = complete ? hash(this.fingerprint + inputs.map(input => input.key).join(':')).slice(0, 24) : inputs[0]!.key,
      existing = this.cached(key);
    if (existing) { this.job = { status: 'ready', id, archive: existing }; return; }
    const generation = ++this.generation, end = inputs.reduce((sum, input) => sum + input.entry.end - input.entry.start, 0);
    this.job = { status: 'preparing', id, time: 0, end };
    this.task = this.prepareFrozen(inputs, key, complete, generation, id, source.entry.name).catch(error => {
      if (this.generation === generation) this.job = { status: 'error', id, error: error instanceof Error ? error.message : String(error) };
    });
  }
  private async prepareFrozen(inputs: readonly Frozen[], key: string, complete: boolean, generation: number, id: string, name: string): Promise<void> {
    const archives: ReplayArchive[] = []; let elapsed = 0;
    for (const input of inputs) {
      if (generation !== this.generation) return;
      const archive = this.cached(input.key) ?? await this.export(input, generation, time => {
        if (this.job.status === 'preparing' && generation === this.generation) this.job = { ...this.job, time: elapsed + time };
      });
      archives.push(archive); elapsed += input.entry.end - input.entry.start;
      if (archive.status !== 'verified') break;
    }
    if (generation !== this.generation) return;
    const archive = complete ? replaySeries(key, name, archives) : archives[0]!, directory = join(this.cache, key);
    if (complete) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'manifest.json'), JSON.stringify(archive)); }
    this.ready.set(key, { directory, archive }); this.job = { status: 'ready', id, archive };
  }
  private async export(input: Frozen, generation: number, progress: (time: number) => void): Promise<ReplayArchive> {
    const directory = join(this.cache, input.key), attempt = directory + '-' + Date.now(); mkdirSync(attempt);
    const file = join(attempt, input.compressed ? 'source.ndjson.gz' : 'source.ndjson'); writeFileSync(file, input.bytes, { flag: 'wx' });
    try {
      const archive = await new Promise<ReplayArchive>((done, fail) => {
        let result: ReplayArchive | null = null, error: unknown = null;
        const worker = this.worker = new Worker(new URL('./replay-export-worker.ts', import.meta.url), {
          workerData: { file, directory: attempt, id: input.key, name: input.entry.name, startStep: Math.round(input.entry.start * 60), until: Math.ceil((input.entry.start + MAX_SECONDS) * 60) },
          env: { ...process.env, IMPACTO_DYNAMICS_RUNTIME: 'native' },
        });
        worker.on('error', value => { error = value; });
        worker.on('message', (value: unknown) => {
          if (generation !== this.generation || !record(value)) return;
          if (value.type === 'progress' && typeof value.time === 'number') progress(value.time);
          else if (value.type === 'ready' && record(value.archive) && value.archive.version === REPLAY_VERSION) result = value.archive as unknown as ReplayArchive;
          else if (value.type === 'error') error = value.error;
        });
        worker.once('exit', code => {
          if (this.worker === worker) this.worker = null;
          if (code === 0 && result && generation === this.generation) done(result);
          else fail(error instanceof Error ? error : error ? new Error(String(error)) : userError('A preparação da gravação foi interrompida.'));
        });
      });
      renameSync(attempt, directory); this.ready.set(input.key, { directory, archive }); return archive;
    } finally {
      const target = resolve(attempt), child = relative(resolve(this.cache), target);
      if (/^[a-f0-9]{24}-\d+$/.test(child)) rmSync(target, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> {
    this.generation++; const worker = this.worker, task = this.task; this.worker = null; this.job = { status: 'idle' };
    await worker?.terminate(); await task; this.task = null;
  }
  async request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin), json = (value: unknown, code = 200) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value));
    };
    if (request.headers.origin && request.headers.origin !== this.origin) { json({ error: tr('Origem da solicitação recusada.') }, 403); return; }
    try {
      if (request.method === 'GET' && url.pathname === '/api/replay/catalog') { json(this.catalog()); return; }
      if (request.method === 'GET' && url.pathname === '/api/replay/status') { json(this.job); return; }
      if (request.method === 'POST' && url.pathname === '/api/replay/prepare') { await this.prepare(url.searchParams.get('id') ?? ''); json(this.job); return; }
      if (request.method === 'POST' && url.pathname === '/api/replay/cancel') { await this.close(); json(this.job); return; }
      const saved = url.pathname.match(/^\/api\/replay\/archive\/([a-f0-9]{24})$/);
      if (request.method === 'GET' && saved) {
        const archive = this.cached(saved[1]!); json(archive ?? { error: tr('Gravação preparada não encontrada.') }, archive ? 200 : 404); return;
      }
      const match = url.pathname.match(/^\/api\/replay\/chunk\/([a-f0-9]{24})\/(\d+)$/);
      if (request.method === 'GET' && match) {
        const prepared = this.ready.get(match[1]!), index = Number(match[2]), chunk = prepared?.archive.chunks.find(chunk => chunk.index === index),
          part = chunk?.source ? this.ready.get(chunk.source.archiveId) : prepared, partIndex = chunk?.source?.index ?? index;
        if (!part || !chunk || !Number.isSafeInteger(index) || !part.archive.chunks.some(chunk => chunk.index === partIndex)) { json({ error: tr('Trecho da gravação não encontrado.') }, 404); return; }
        const stream = createReadStream(join(part.directory, replayChunkFile(partIndex))); stream.on('error', () => response.destroy());
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }); stream.pipe(response); return;
      }
      json({ error: tr('Solicitação de replay desconhecida.') }, 404);
    } catch (error) { json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  }
}
