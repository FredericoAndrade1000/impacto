import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const lockName = '.dynamics-build.lock';

function hasCode(error: unknown, ...codes: readonly string[]): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && codes.includes(error.code);
}
function ownerAt(directory: string): { pid: number; file: string } | null | undefined {
  try {
    const files = readdirSync(directory), file = files[0];
    if (files.length !== 1 || !file || !/^owner-[a-f0-9-]{36}\.json$/.test(file)) return null;
    const owner: unknown = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    return owner && typeof owner === 'object' && 'pid' in owner && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0
      ? { pid: owner.pid, file } : null;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError || hasCode(error, 'ENOTDIR', 'EISDIR')) return null;
    throw error;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } // Signal zero only checks whether the process exists.
  catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    if (hasCode(error, 'EPERM')) return true;
    throw error;
  }
}

function removeOwner(directory: string, file: string, owned = false): void {
  try { unlinkSync(join(directory, file)); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; if (!owned) return; }
  try { rmdirSync(directory); }
  catch (error) {
    // Another contender may already have published its different, nonempty owner directory.
    if (!hasCode(error, 'ENOENT', 'ENOTEMPTY', 'EEXIST')) throw error;
  }
}

export async function withBuildLock<Result>(targetDirectory: string, task: () => Result,
  { pollMs = 100, log = console.log }: { pollMs?: number; log?: (message: string) => void } = {}): Promise<Awaited<Result>> {
  const target = resolve(targetDirectory), lock = join(target, lockName),
    file = `owner-${randomUUID()}.json`;
  mkdirSync(target, { recursive: true });
  let acquired = false, announced = false, unknown = 0;
  try {
    while (!acquired) {
      try {
        // mkdir never replaces an existing directory, including an unidentified empty lock.
        mkdirSync(lock);
        acquired = true;
        writeFileSync(join(lock, file), JSON.stringify({ pid: process.pid }) + '\n', { flag: 'wx' });
      }
      catch (error) {
        if (acquired) throw error;
        if (!hasCode(error, 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES')) throw error;
        const owner = ownerAt(lock);
        if (owner === undefined) {
          if (++unknown >= 3) throw error;
          await setTimeout(pollMs);
          continue;
        }
        // Allow a short recovery/publication transition, but never remove an unidentified lock.
        if (!owner) {
          if (++unknown >= 3) throw new Error(`Cannot identify the build lock owner at ${lock}. Check it manually before removing it.`);
        } else {
          unknown = 0;
          if (!alive(owner.pid)) { removeOwner(lock, owner.file); continue; }
          if (!announced) { log('Waiting for another dynamics build to finish...'); announced = true; }
        }
        await setTimeout(pollMs);
      }
    }
    return await task();
  } finally {
    if (acquired) removeOwner(lock, file, true);
  }
}
