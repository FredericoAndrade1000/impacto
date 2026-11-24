export type NativeRuntime = 'native' | 'wasm';
// Host exports are foreign values until the consuming adapter checks its API.
export type DynamicsHost = Record<string, unknown> & { runtime: NativeRuntime };
