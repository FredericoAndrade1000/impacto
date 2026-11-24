import * as bindings from './native/battle_dynamics.js';
import type { DynamicsHost } from './native-host-contract.ts';

export const wasmDynamicsUrl = new URL('./native/battle_dynamics_bg.wasm', import.meta.url);

// Browsers initialize from the URL; Node's Wasm host supplies the same file's bytes.
export async function loadDynamicsHost(source: unknown = wasmDynamicsUrl): Promise<DynamicsHost> {
  await bindings.default({ module_or_path: source });
  return { ...bindings, runtime: 'wasm' };
}
