import { Worker, parentPort } from 'node:worker_threads';
import { record, errorMessage } from './operational-input.ts';

export interface PoolProgress<Result = unknown> { completed: number; total: number; index: number; result: Result }
interface PendingBatch {
  tasks: readonly unknown[]; results: unknown[]; batch: number; next: number; done: number;
  resolve(results: unknown[]): void; reject(error: unknown): void;
  onProgress(progress: PoolProgress): void; cleanup(): void;
}

// Ordered episode scheduling. A batch configuration crosses each thread once,
// while only independent tasks cross per episode.
export class WorkerPool {
  declare serial: number;
  declare pending: PendingBatch | null;
  declare failure: Error | null;
  declare closed: boolean | undefined;
  declare disposing: Promise<PromiseSettledResult<number>[]> | undefined;
  declare workers: Worker[];
  constructor(url: URL | string, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Use entre 1 e 32 workers.');
    this.serial = 0; this.pending = null; this.failure = null;
    this.workers = Array.from({ length: count }, () => {
      const worker = new Worker(url, { execArgv: [] });
      worker.on('error', error => this.fail(error));
      worker.on('exit', code => { if (!this.closed) this.fail(new Error('Worker encerrou antes de concluir: ' + code)); });
      worker.on('message', message => this.receive(worker, message));
      return worker;
    });
  }
  fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(errorMessage(error));
    this.failure ||= failure;
    if (this.pending) this.finish(failure);
    void this.dispose();
  }
  collect(tasks: readonly unknown[], options: unknown,
    { onProgress = () => {}, signal }: { onProgress?: (progress: PoolProgress) => void; signal?: AbortSignal } = {}): Promise<unknown[]> {
    if (!Array.isArray(tasks) || tasks.length > 10000) return Promise.reject(new Error('Lista de episódios inválida.'));
    if (this.pending) return Promise.reject(new Error('O pool já está executando um lote.'));
    if (this.closed || this.failure) return Promise.reject(this.failure || new Error('Pool encerrado.'));
    if (signal?.aborted) return Promise.reject(new Error('Lote cancelado.'));
    if (!tasks.length) return Promise.resolve([]);
    return new Promise<unknown[]>((resolve, reject) => {
      const batch = ++this.serial, abort = () => this.fail(new Error('Lote cancelado.'));
      this.pending = { tasks, results: Array(tasks.length), batch, next: 0, done: 0, resolve, reject, onProgress,
        cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      for (const worker of this.workers) { worker.postMessage({ configure: batch, options }); this.dispatch(worker); }
    });
  }
  async collectDecoded<Result>(tasks: readonly unknown[], options: unknown, decode: (value: unknown) => Result,
    { onProgress, signal }: { onProgress?: (progress: PoolProgress<Result>) => void; signal?: AbortSignal } = {}): Promise<Result[]> {
    const results: Result[] = [];
    await this.collect(tasks, options, { ...(signal === undefined ? {} : { signal }), onProgress: progress => {
      const result = decode(progress.result); results[progress.index] = result;
      onProgress?.({ ...progress, result });
    } });
    return results;
  }
  dispatch(worker: Worker): void {
    const p = this.pending;
    if (p && p.next < p.tasks.length) { const index = p.next++; worker.postMessage({ batch: p.batch, index, task: p.tasks[index] }); }
  }
  receive(worker: Worker, message: unknown): void {
    const p = this.pending;
    if (!record(message)) { this.fail(new Error('Resposta de worker inválida.')); return; }
    if (!p || message.batch !== p.batch) return;
    if (message.error) { this.fail(new Error(String(message.error))); return; }
    const { index, result } = message;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= p.tasks.length || result === undefined || p.results[index] !== undefined) {
      this.fail(new Error('Resposta de worker inválida.')); return;
    }
    p.results[index] = result; p.done++;
    try { p.onProgress({ completed: p.done, total: p.tasks.length, index, result }); }
    catch (error) { this.fail(error); return; }
    if (p.done === p.tasks.length) this.finish(); else this.dispatch(worker);
  }
  finish(error?: Error): void {
    const p = this.pending; this.pending = null;
    if (!p) return;
    p.cleanup();
    if (error) p.reject(error); else p.resolve(p.results);
  }
  async dispose() {
    if (this.disposing) return this.disposing;
    this.closed = true;
    if (this.pending) this.finish(new Error('Pool encerrado.'));
    this.disposing = Promise.allSettled(this.workers.map(worker => worker.terminate()));
    await this.disposing;
  }
}

export function workerJobs(run: (task: unknown, options: unknown) => unknown | Promise<unknown>, invalid?: (error: unknown, task: unknown) => unknown): void {
  let options: unknown;
  const port = parentPort;
  port?.on('message', async (message: unknown) => {
    if (!record(message)) return;
    if (message.configure !== undefined) { options = message.options; return; }
    try { port.postMessage({ batch: message.batch, index: message.index, result: await run(message.task, message.options ?? options) }); }
    catch (error) { port.postMessage({ batch: message.batch, index: message.index,
      ...(invalid ? { result: invalid(error, message.task) } : { error: errorMessage(error) }) }); }
  });
}
