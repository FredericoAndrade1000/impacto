// The diaries of a field (field-host.ts) on disk, in a directory of their own beside where the field is kept: one
// file for each run of the field, from the field it began as to where it stopped, a line to each entry and the
// first line saying what it began from. A run writes its diary as it goes, and nothing it wrote is lost when it
// falls. A diary nobody writes to any more is of a run that stopped: it is deflated, and the oldest diaries make way
// for the newest when they take more than their room. Nothing in a diary names a seat by its token or a player by
// where they come from: the file can be handed to whoever looks into what happened.
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { threadId } from 'node:worker_threads';
import { createGunzip, createGzip } from 'node:zlib';
import { nativeDynamicsRuntime } from '../src/native-dynamics.ts';

const OPEN = '.ndjson', CLOSED = '.ndjson.gz', PART = '.part';
// What the diaries of a field take on disk at most, in bytes; and how long, in milliseconds, a diary nobody wrote to
// stands before it is taken for one of a run that stopped. A run writes to its diary at least once a second.
const BUDGET = 1024 ** 3, SETTLED = 120_000;

// The build of the core that runs the field. A field run again on another build — another source, another machine
// whose arithmetic rounds otherwise — need not go as it went.
export function coreBuild(): { runtime: 'native' | 'wasm'; platform: string; arch: string; build: string } {
  if (nativeDynamicsRuntime !== 'native' && nativeDynamicsRuntime !== 'wasm') throw new Error('O núcleo de física ainda não foi inicializado.');
  const native = nativeDynamicsRuntime === 'native',
    file = native ? new URL(`../native/artifacts/battle_dynamics-${process.platform}-${process.arch}.json`, import.meta.url) : new URL('../src/native/battle_dynamics_bg.wasm', import.meta.url),
    bytes = readFileSync(file);
  let build: string;
  if (native) {
    const metadata: unknown = JSON.parse(bytes.toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || !('binarySHA256' in metadata) || typeof metadata.binarySHA256 !== 'string')
      throw new Error('Identificação do núcleo nativo inválida. Recompile com npm run build:native.');
    build = metadata.binarySHA256;
  } else build = createHash('sha256').update(bytes).digest('hex');
  return { runtime: nativeDynamicsRuntime, platform: process.platform, arch: process.arch, build };
}

// A new diary in `dir`, which begins with `header`. What is written to it is on disk when `write` returns.
export function openDiary(dir: string, header: unknown): { file: string; write(text: string): void; close(): void } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${threadId}${OPEN}`),
    handle = openSync(file, 'wx', 0o600);
  writeSync(handle, JSON.stringify(header) + '\n');
  return { file, write(text: string) { writeSync(handle, text); }, close() { closeSync(handle); } };
}

// The diaries in `dir`, oldest first: each with its file, its size, when it was last written and whether it is still open.
function diaries(dir: string): { file: string; name: string; size: number; mtimeMs: number; open: boolean; part: boolean }[] {
  let names;
  try { names = readdirSync(dir); } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => name.endsWith(OPEN) || name.endsWith(CLOSED) || name.endsWith(PART)).sort().map(name => {
    const file = join(dir, name), { size, mtimeMs } = statSync(file);
    return { file, name, size, mtimeMs, open: name.endsWith(OPEN), part: name.endsWith(PART) };
  });
}

// Deflates the diaries of runs that stopped and makes room under `budget` bytes, the oldest diaries going first; a
// diary still open is never touched, nor the one of this run (`own`). A deflation cut short by a run that stopped
// meanwhile is done again from the start. A diary another run tidied away meanwhile is let be.
export async function tidyDiaries(dir: string,
  { own = null, budget = BUDGET, settled = SETTLED, now = Date.now() }: { own?: string | null; budget?: number; settled?: number; now?: number } = {}): Promise<void> {
  for (const diary of diaries(dir)) {
    if (diary.file === own || now - diary.mtimeMs < settled) continue;
    if (diary.part) { rmSync(diary.file, { force: true }); continue; }
    if (!diary.open) continue;
    const closed = diary.file.slice(0, -OPEN.length) + CLOSED;
    await pipeline(createReadStream(diary.file), createGzip(), createWriteStream(closed + PART, { mode: 0o600 }));
    renameSync(closed + PART, closed); rmSync(diary.file, { force: true });
  }
  const all = diaries(dir);
  let total = all.reduce((sum, diary) => sum + diary.size, 0);
  for (const diary of all) {
    if (total <= budget) break;
    if (diary.open || diary.part) continue;
    rmSync(diary.file, { force: true }); total -= diary.size;
  }
}

// The diary to read in `path`: the file itself, or the newest diary in a directory or in its `replays`.
export function findDiary(path: string): string {
  if (!statSync(path).isDirectory()) return path;
  for (const dir of [join(path, 'replays'), path]) {
    const found = diaries(dir).filter(diary => !diary.part);
    const latest = found.at(-1);
    if (latest) return latest.file;
  }
  throw new Error(`Nenhum diário de campo em ${path}.`);
}

// The lines of a diary, deflated or not, one by one.
export async function* diaryLines(file: string): AsyncGenerator<string, void, unknown> {
  const stream = createReadStream(file), lines = createInterface({ input: file.endsWith(CLOSED) ? stream.pipe(createGunzip()) : stream, crlfDelay: Infinity });
  try { for await (const line of lines) if (typeof line === 'string' && line) yield line; } finally { lines.close(); stream.destroy(); }
}
