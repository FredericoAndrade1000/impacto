import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingReplies } from '../src/pending-replies.ts';

test('out-of-order worker replies settle their own request and ignore late duplicates', async () => {
  const replies = new PendingReplies(), first = replies.wait(1), second = replies.wait(2), failure = new Error('refused'),
    rejected = assert.rejects(second, error => error === failure);
  replies.settle(2, failure); replies.settle(1, null, { ready: true });
  assert.deepEqual(await first, { ready: true }); await rejected;
  replies.settle(1, new Error('late')); replies.settle(999, null, 'unknown');
});

test('a timeout uses its own message and a late reply cannot complete the expired request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const replies = new PendingReplies(), expired = assert.rejects(replies.wait(0, 45, 'boot timeout'), /boot timeout/);
  t.mock.timers.tick(45); await expired;
  replies.settle(0, null, 'late');
});

test('worker failure rejects every pending request and permits a fresh worker to respond', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const replies = new PendingReplies(), failure = new Error('worker stopped'),
    first = assert.rejects(replies.wait(1), error => error === failure), second = assert.rejects(replies.wait(2), error => error === failure);
  replies.rejectAll(failure); await Promise.all([first, second]);
  t.mock.timers.tick(12000);
  const restarted = replies.wait(3); replies.settle(3, null, 'restarted');
  assert.equal(await restarted, 'restarted');
});
