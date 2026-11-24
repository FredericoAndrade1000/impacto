import { initNativeDynamics, nativeDynamicsRuntime } from '../../src/native-dynamics.ts';

await initNativeDynamics();
// Binary Photos belong to the Native server; the Wasm facade deliberately does not expose them.
export const nativePhotoOnly = { skip: nativeDynamicsRuntime === 'native' ? false : 'Binary Photos require the Native server host.' };
