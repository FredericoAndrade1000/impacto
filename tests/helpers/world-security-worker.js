import { parentPort } from 'node:worker_threads';

let received = 0;
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ type, peerId, data, address }) => {
  if (type !== 'command') return;
  received++;
  if (data.type === 'drive') return; // Simulate the worker being unable to drain these commands.
  const payload = data.type === 'hello' ? { type: 'welcome', address, playerId: data.name } : { type: 'reply', request: data.request, received };
  parentPort.postMessage({ type: 'handled', peerId });
  parentPort.postMessage({ type: 'direct', peerId, payload });
});
