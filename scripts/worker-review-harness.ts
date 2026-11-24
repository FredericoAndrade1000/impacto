import { parentPort } from 'node:worker_threads';

// Run the browser worker message protocol under Node for control-flow tests.
// The simulation and its scheduler are imported unchanged.
// In an actual browser worker self is the global scope, including WebCrypto.
// A narrow mock of self would hide crypto from Rapier's WASM random source.
const port = parentPort;
if (!port) throw new Error('Browser worker harness must run on a worker thread.');
Object.defineProperty(globalThis, 'self', {value: globalThis, configurable: true, enumerable: true, writable: true});
Object.defineProperty(globalThis, 'postMessage', {value: (packet: unknown, transfers?: readonly import('node:worker_threads').Transferable[]) => port.postMessage(packet, transfers), configurable: true, enumerable: true, writable: true});
await import('../src/simulation-worker.ts');
port.on('message', (data: unknown) => {
  const handler: unknown = Reflect.get(globalThis, 'onmessage');
  if (typeof handler !== 'function') throw new TypeError('Browser worker did not register its message handler.');
  Reflect.apply(handler, globalThis, [{data}]);
});
