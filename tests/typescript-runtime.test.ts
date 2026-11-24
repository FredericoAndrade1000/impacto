import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DESIGN_VERSION } from '../src/design-contract.ts';

test('the test runner and worker load erasable TypeScript through native Node ESM', async () => {
  const worker = new Worker(new URL('./helpers/typed-worker.ts', import.meta.url));
  try {
    const exit = once(worker, 'exit'), [message] = await once(worker, 'message');
    assert.deepEqual(message, { designVersion: DESIGN_VERSION });
    assert.equal(await exit.then(([code]) => code), 0);
  } finally { await worker.terminate(); }
});
